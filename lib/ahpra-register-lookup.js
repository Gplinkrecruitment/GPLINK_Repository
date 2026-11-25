'use strict';

/**
 * Australian GP build, WP-29: looking one doctor up on Ahpra's PUBLIC register.
 *
 * In plain words. When an Australian GP finishes onboarding (or staff press
 * "Look up on the register"), the app can read that one doctor's public
 * "Registration Details" page, using the registration number the doctor gave,
 * so a person does not have to search for each doctor by hand. What it reads
 * is turned into plain facts (registration type, specialty, expiry, first
 * registration date, conditions, undertakings, reprimands, notations,
 * registration requirements, qualifications). The rule that decides what
 * those facts MEAN lives somewhere else (lib/au-work-sorting.js); this file
 * only fetches and reads.
 *
 * Which provider runs is one environment setting, AHPRA_LOOKUP_PROVIDER:
 *
 *   none          (the default everywhere) nothing is requested, nothing
 *                 changes. This is also the kill switch.
 *   fixture       for tests and the local test stack: a handful of made-up
 *                 registration numbers, answered from pages built in
 *                 lib/ahpra-register-fixtures.js. No network.
 *   ahpra_public  the real public register (www.ahpra.gov.au). One doctor at
 *                 a time, by their own number. Never bulk, never a list of
 *                 numbers, never republished.
 *
 * LIMITS, stated honestly:
 *   - It reads a public web page. Ahpra can change that page at any time; a
 *     page this file does not recognise is reported as `unrecognised_page`
 *     and changes nothing. It never guesses.
 *   - Ahpra has objected to bulk automated collection of the register and
 *     bars commercial reuse of register data. This is one lookup per
 *     onboarding doctor, with their own number, to check what they told us.
 *     The durable, contracted route is Ahpra's Practitioner Information
 *     Exchange (PIE): docs/au-gp/ahpra-register-lookup.md.
 *   - If the site ever answers with a challenge, a CAPTCHA, a login or a
 *     refusal, this file STOPS (`blocked`). It never tries to get around one.
 *
 * How the public search works (found 25 November 2026 with eight polite
 * requests, using only the example number the owner supplied):
 *   1. GET  /Registration/Registers-of-Practitioners.aspx   (sets cookies)
 *   2. POST /Registration/Registers-of-Practitioners        the search form,
 *      field `name-reg` = the number. The results page has
 *      id="SearchResultsPage" and one row per practitioner:
 *      <div class="search-results-table-row" data-practitioner-row-id="MED…">.
 *      No row for the number = not on the register.
 *   3. POST the same form again with `practitioner-row-id` = the number: the
 *      "Registration Details" page.
 * Ordinary form posts; no token, no CAPTCHA. (Posting step 3 for a number
 * that has no row answers with a redirect to an error page, which is why
 * step 2 is never skipped.)
 */

const fixtures = require('./ahpra-register-fixtures.js');

const PROVIDER = Object.freeze({ NONE: 'none', FIXTURE: 'fixture', AHPRA_PUBLIC: 'ahpra_public' });
const SOURCE_URL = 'https://www.ahpra.gov.au/Registration/Registers-of-Practitioners';
const START_URL = SOURCE_URL + '.aspx';
// A plain, honest client name. No business or personal detail is sent.
const USER_AGENT = 'Mozilla/5.0 (compatible; register-check/1.0)';

const TOTAL_TIMEOUT_MS = 8000;            // the whole lookup, all requests together
const MIN_GAP_BETWEEN_LOOKUPS_MS = 4000;  // global: at most about one lookup every few seconds
const CACHE_MS = 24 * 60 * 60 * 1000;     // the same number is not looked up twice in a day
const COOLDOWN_MS = CACHE_MS;
const MAX_CACHE = 500;

const NUMBER_RE = /^[A-Z]{3}\d{10}$/;

function providerName(env) {
  const e = env || process.env;
  const raw = String((e && e.AHPRA_LOOKUP_PROVIDER) || '').trim().toLowerCase();
  if (raw === PROVIDER.FIXTURE) return PROVIDER.FIXTURE;
  if (raw === PROVIDER.AHPRA_PUBLIC) return PROVIDER.AHPRA_PUBLIC;
  return PROVIDER.NONE;
}

function normaliseNumber(value) {
  return String(value == null ? '' : value).replace(/\s+/g, '').toUpperCase();
}

// ── reading the page ─────────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (whole, code) {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ' ';
    }
    const k = code.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : whole;
  });
}

/** HTML to plain text. <br> and list items become new lines; nothing else survives. */
function textOf(htmlPart) {
  let s = String(htmlPart == null ? '' : htmlPart);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  // The little "?" help links beside a field name, and the "Show less / Read
  // more" link inside a long condition, are page furniture, not content.
  s = s.replace(/<a\b[^>]*data-toggle="popover"[\s\S]*?<\/a>/gi, ' ');
  s = s.replace(/<a\b[^>]*class="[^"]*read-more-link[^"]*"[\s\S]*?<\/a>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(li|p|div|ul|h[1-6])>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
  return s.split('\n').map(function (line) { return line.replace(/[ \t ]+/g, ' ').trim(); })
    .filter(function (line, i, all) { return line !== '' || (i > 0 && all[i - 1] !== ''); })
    .join('\n').trim();
}
function oneLine(htmlPart) { return textOf(htmlPart).replace(/\s*\n\s*/g, ' ').trim(); }

/** dd/mm/yyyy (the register's format) -> yyyy-mm-dd, or null. Real dates only. */
function isoFromRegisterDate(text) {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(String(text == null ? '' : text));
  if (!m) return null;
  const d = Number(m[1]); const mo = Number(m[2]); const y = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

/** "None" (or blank) -> { present: false }; anything else -> { present: true, text }. */
function presence(text) {
  if (text == null) return null;
  const t = String(text).trim();
  if (t === '' ) return null;
  if (/^none\.?$/i.test(t)) return { present: false, text: null };
  return { present: true, text: t };
}

/** The inner HTML of the <div> that starts at `start`, nested divs counted. Null if it never closes. */
function balancedDiv(html, start) {
  const open = html.indexOf('>', start);
  if (open === -1) return null;
  const re = /<div\b|<\/div>/gi;
  re.lastIndex = open + 1;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].toLowerCase() === '</div>') { depth--; if (depth === 0) return html.slice(open + 1, m.index); }
    else depth++;
  }
  return null;
}

function splitSections(html) {
  const parts = String(html).split(/<div class="practitioner-detail-section">/i).slice(1);
  return parts.map(function (part) {
    const titleM = /<div class="section-title"[^>]*>([\s\S]*?)<\/div>/i.exec(part);
    const rows = part.split(/<div class="section-row[^"]*">/i).slice(1).map(function (row) {
      const t = /<div class="field-title">([\s\S]*?)<\/div>\s*<\/div>/i.exec(row) || /<div class="field-title">([\s\S]*?)<\/div>/i.exec(row);
      const at = row.search(/<div class="field-entry/i);
      // Exactly the entry's own <div>…</div> (nested divs counted), so nothing
      // that follows the row on the page is ever read as part of it.
      const entryHtml = at === -1 ? null : balancedDiv(row, at);
      return { title: t ? oneLine(t[1]) : '', entry: entryHtml == null ? null : textOf(entryHtml), entryHtml: entryHtml };
    });
    return { title: titleM ? oneLine(titleM[1]) : '', rows: rows };
  });
}

function rowValue(section, label) {
  if (!section) return undefined;
  const want = String(label).toLowerCase();
  for (let i = 0; i < section.rows.length; i++) {
    if (section.rows[i].title.toLowerCase() === want) return section.rows[i].entry;
  }
  return undefined;
}

const REGISTRATION_TYPE_BY_WORD = Object.freeze({
  general: 'general', specialist: 'specialist', provisional: 'provisional', limited: 'limited', 'non-practising': 'non_practising', 'non practising': 'non_practising'
});

/** "Title, Institution, Country, Year" -> its parts. Unknown parts are null. */
function parseQualification(line) {
  const raw = String(line || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const parts = raw.split(',').map(function (p) { return p.trim(); }).filter(Boolean);
  const out = { title: null, institution: null, country: null, year: null, raw: raw };
  if (parts.length && /^(19|20)\d{2}$/.test(parts[parts.length - 1])) out.year = Number(parts.pop());
  if (parts.length >= 3) {
    out.country = parts.pop();
    out.institution = parts.pop();
    out.title = parts.join(', ');
  } else if (parts.length === 2) {
    out.title = parts[0];
    out.institution = parts[1];
  } else if (parts.length === 1) {
    out.title = parts[0];
  }
  return out;
}

/** The "Registration Requirements" box: a sentence, then "Key: value" lines. */
function parseRequirements(text) {
  const raw = String(text || '').trim();
  const out = { supervisionRequired: null, supervisionLevel: null, pathway: null, position: null, employer: null, workplaces: null, commencement: null, raw: raw || null };
  if (!raw) return out;
  raw.split('\n').forEach(function (line) {
    const m = /^([A-Za-z][A-Za-z /()]{2,40}):\s*(.+)$/.exec(line.trim());
    if (!m) return;
    const key = m[1].trim().toLowerCase();
    const value = m[2].trim();
    if (key === 'position') out.position = value;
    else if (key === 'pathway') out.pathway = value;
    else if (key === 'employer') out.employer = value;
    else if (/^workplaces?\/locations?/.test(key)) out.workplaces = value;
    else if (key === 'level of supervision') out.supervisionLevel = value;
    else if (key === 'commencement') out.commencement = value;
  });
  out.supervisionRequired = /\bpractise with supervision\b|\bunder (the )?supervision\b|\bsupervised practice\b/i.test(raw) || !!out.supervisionLevel;
  return out;
}

/**
 * Read a "Registration Details" page. Pure.
 *
 * @param {string} html    the response body
 * @param {string} number  the registration number that was asked for
 * @returns {{ ok: true, facts: object } | { ok: false, reason: 'unrecognised_page'|'number_mismatch' }}
 *
 * Every field that cannot be read with confidence is null and named in
 * `facts.parseWarnings`. A page whose layout is not the one this was written
 * against is `unrecognised_page`: never a guess.
 */
function parseRegistrationDetailsHtml(html, number) {
  const body = String(html == null ? '' : html);
  const bad = { ok: false, reason: 'unrecognised_page' };
  if (body.indexOf('practitioner-detail-header') === -1 || !/<h1[^>]*>\s*Registration Details\s*<\/h1>/i.test(body)) return bad;
  const nameM = /<h2 class="practitioner-name">([\s\S]*?)<\/h2>/i.exec(body);
  const numM = /<span class="reg-number">([\s\S]*?)<\/span>/i.exec(body);
  const sections = splitSections(body);
  if (!nameM || !numM || !sections.length) return bad;
  const main = sections.filter(function (s) { return /^registration details$/i.test(s.title); })[0] || null;
  if (!main) return bad;

  const warnings = [];
  const warn = function (field) { if (warnings.indexOf(field) === -1) warnings.push(field); };
  const wanted = normaliseNumber(number);
  const shownHeader = normaliseNumber(oneLine(numM[1]).replace(/^no\.?\s*/i, ''));
  const shownRow = normaliseNumber(rowValue(main, 'Registration number'));
  if (!NUMBER_RE.test(shownHeader) || (shownRow && shownRow !== shownHeader)) return bad;
  if (wanted && shownHeader !== wanted) return { ok: false, reason: 'number_mismatch' };

  const name = oneLine(nameM[1]) || null;
  if (!name) warn('name');
  const profession = rowValue(main, 'Profession') || null;
  const status = rowValue(main, 'Registration status') || null;
  if (!status) warn('status');

  const firstRaw = rowValue(main, 'Date of first Registration in profession');
  const firstRegistrationDate = isoFromRegisterDate(firstRaw);
  if (!firstRegistrationDate) warn('firstRegistrationDate');

  const undertakings = presence(rowValue(main, 'Undertakings'));
  if (!undertakings) warn('undertakings');
  const reprimands = presence(rowValue(main, 'Reprimands'));
  if (!reprimands) warn('reprimands');
  const conditionsSummary = presence(rowValue(main, 'Conditions'));
  if (!conditionsSummary) warn('conditions');

  // One section per registration type ("Registration Type - Specialist").
  const registrations = sections.filter(function (s) { return /^registration type\s*-/i.test(s.title); }).map(function (s) {
    const word = s.title.replace(/^registration type\s*-\s*/i, '').trim();
    const cond = presence(rowValue(s, 'Conditions'));
    const endorse = presence(rowValue(s, 'Endorsements'));
    const notes = presence(rowValue(s, 'Notations'));
    const req = rowValue(s, 'Registration Requirements');
    return {
      typeWord: word,
      type: REGISTRATION_TYPE_BY_WORD[word.toLowerCase()] || null,
      specialty: rowValue(s, 'Specialty') || null,
      expiry: isoFromRegisterDate(rowValue(s, 'Registration Expiry Date')),
      conditions: cond, endorsements: endorse, notations: notes,
      requirementsText: req && !/^none\.?$/i.test(req.trim()) ? req : null
    };
  });
  if (!registrations.length) warn('registrationType');
  registrations.forEach(function (r) { if (!r.type) warn('registrationType'); });

  const types = registrations.map(function (r) { return r.type; }).filter(Boolean);
  let registrationType = null;
  if (types.indexOf('specialist') !== -1) registrationType = types.indexOf('general') !== -1 ? 'general_and_specialist' : 'specialist';
  else if (types.length) registrationType = types[0];
  const specialistRows = registrations.filter(function (r) { return r.type === 'specialist'; });
  const gpRow = specialistRows.filter(function (r) { return /\bgeneral practice\b/i.test(String(r.specialty || '')); })[0] || null;
  const specialty = specialistRows.length ? specialistRows.map(function (r) { return r.specialty; }).filter(Boolean).join('; ') || null : null;
  if (specialistRows.length && !specialty) warn('specialty');
  const specialistGp = registrations.length ? !!gpRow : null;

  // The expiry that matters is the GP specialist one when there is one;
  // otherwise the earliest shown (the careful reading).
  let expiry = gpRow ? gpRow.expiry : null;
  if (!gpRow) {
    const all = registrations.map(function (r) { return r.expiry; }).filter(Boolean).sort();
    expiry = all.length ? all[0] : null;
  }
  if (!expiry) warn('expiry');

  // Conditions: the summary line says whether there are any; the words are in
  // the registration-type sections.
  const conditionTexts = registrations.map(function (r) { return r.conditions && r.conditions.present ? r.conditions.text : null; }).filter(Boolean);
  let conditions = null;
  if (conditionsSummary) {
    if (conditionsSummary.present === false && !conditionTexts.length) conditions = { present: false, text: null };
    else {
      conditions = { present: true, text: conditionTexts.join('\n\n') || null };
      if (!conditions.text) warn('conditionsText');
    }
  } else if (conditionTexts.length) {
    conditions = { present: true, text: conditionTexts.join('\n\n') };
  }
  const merge = function (key) {
    const seen = registrations.map(function (r) { return r[key]; });
    if (!seen.length || seen.some(function (x) { return x == null; })) { warn(key); return null; }
    const texts = seen.filter(function (x) { return x.present; }).map(function (x) { return x.text; });
    return texts.length ? { present: true, text: texts.join('\n\n') } : { present: false, text: null };
  };
  const endorsements = merge('endorsements');
  const notations = merge('notations');

  const requirementsRaw = registrations.map(function (r) { return r.requirementsText; }).filter(Boolean).join('\n\n');
  const requirements = parseRequirements(requirementsRaw);
  const conditionWords = conditions && conditions.text ? conditions.text : '';
  if (requirements.supervisionRequired !== true) {
    requirements.supervisionRequired = /\bsupervised practice arrangement\b|\bunder the supervision of\b|\bpractise (only )?(with|under) supervision\b/i.test(conditionWords)
      ? true : (conditions && conditions.present === false && !requirementsRaw ? false : requirements.supervisionRequired);
  }
  requirements.approvedLocationsOnly = /\bmust not practise other than at (an? )?approved (practice )?location/i.test(conditionWords)
    || /\bonly practise at (an? )?(board[- ])?approved (practice )?location/i.test(conditionWords + '\n' + requirementsRaw);

  const personal = sections.filter(function (s) { return /^personal details$/i.test(s.title); })[0] || null;
  let qualifications = null;
  if (personal) {
    const qRow = personal.rows.filter(function (r) { return /^qualifications$/i.test(r.title); })[0] || null;
    if (qRow && qRow.entryHtml != null) {
      const items = [];
      const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let m;
      while ((m = re.exec(qRow.entryHtml))) { const q = parseQualification(oneLine(m[1])); if (q) items.push(q); }
      if (!items.length && qRow.entry) qRow.entry.split('\n').forEach(function (l) { const q = parseQualification(l); if (q) items.push(q); });
      qualifications = items;
    }
  }
  if (!qualifications) { warn('qualifications'); }

  const place = sections.filter(function (s) { return /^principal place of practice$/i.test(s.title); })[0] || null;
  const principalPlace = place ? {
    suburb: rowValue(place, 'Suburb') || null, state: rowValue(place, 'State') || null,
    postcode: rowValue(place, 'Postcode') || null, country: rowValue(place, 'Country') || null
  } : null;

  return {
    ok: true,
    facts: {
      found: true,
      number: shownHeader,
      name: name,
      profession: profession,
      status: status,
      registrationType: registrationType,
      registrationTypes: registrations.map(function (r) { return r.typeWord; }),
      specialty: specialty,
      specialistGp: specialistGp,
      expiry: expiry,
      firstRegistrationDate: firstRegistrationDate,
      conditions: conditions,
      undertakings: undertakings,
      reprimands: reprimands,
      endorsements: endorsements,
      notations: notations,
      requirements: requirements,
      qualifications: qualifications || [],
      principalPlace: principalPlace,
      parseWarnings: warnings,
      fetchedAt: null,
      source: null
    }
  };
}

/** Read a search-results page: is it one, and does it list this number? Pure. */
function parseSearchResultsHtml(html, number) {
  const body = String(html == null ? '' : html);
  if (body.indexOf('id="SearchResultsPage"') === -1) return { recognised: false, found: false };
  const wanted = normaliseNumber(number);
  const re = /data-practitioner-row-id="([^"]*)"/g;
  let m;
  let found = false;
  let rows = 0;
  while ((m = re.exec(body))) { rows++; if (normaliseNumber(m[1]) === wanted) found = true; }
  return { recognised: true, found: found, rows: rows };
}

/** A page that is a refusal or a challenge. We stop; we never work around one. */
function looksBlocked(status, body) {
  if (status === 401 || status === 403 || status === 429 || status === 503) return true;
  const b = String(body || '').slice(0, 20000);
  return /Request Rejected|support ID is|Just a moment\.\.\.|cf-chl-|challenge-platform|g-recaptcha|hcaptcha|captcha/i.test(b)
    && b.indexOf('id="mainform"') === -1;
}

// ── the real register ────────────────────────────────────────────────────────

function cookieHeaderFrom(jar) {
  return Object.keys(jar).map(function (k) { return k + '=' + jar[k]; }).join('; ');
}
function storeCookies(jar, response) {
  let list = [];
  try {
    if (response.headers && typeof response.headers.getSetCookie === 'function') list = response.headers.getSetCookie();
    else if (response.headers && typeof response.headers.get === 'function' && response.headers.get('set-cookie')) list = [response.headers.get('set-cookie')];
  } catch (e) { list = []; }
  list.forEach(function (line) {
    const first = String(line).split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  });
}
function formBody(number, rowId) {
  const fields = [
    ['health-profession', ''], ['state', ''], ['suburb', ''], ['postcode', ''],
    ['name-reg', number], ['name-reg-detail', ''], ['practitioner-row-id', rowId || ''],
    ['load-more-page-num', ''], ['health-profession-filters', ''], ['sex-filters', ''], ['language-filters', '']
  ];
  return fields.map(function (f) { return encodeURIComponent(f[0]) + '=' + encodeURIComponent(f[1]); }).join('&');
}

async function fetchPublicRegister(number, opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return { ok: false, reason: 'no_http_client' };
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, o.timeoutMs || TOTAL_TIMEOUT_MS);
  const jar = {};
  const call = async function (url, init) {
    const headers = Object.assign({ 'User-Agent': USER_AGENT, Accept: 'text/html' }, init && init.headers);
    const cookie = cookieHeaderFrom(jar);
    if (cookie) headers.Cookie = cookie;
    const res = await fetchImpl(url, Object.assign({}, init, { headers: headers, redirect: 'manual', signal: controller.signal }));
    storeCookies(jar, res);
    const text = res.status === 200 ? await res.text() : '';
    return { status: res.status, text: text };
  };
  try {
    const start = await call(START_URL, { method: 'GET' });
    if (looksBlocked(start.status, start.text)) return { ok: false, reason: 'blocked' };
    if (start.status !== 200 || start.text.indexOf('id="mainform"') === -1) return { ok: false, reason: 'unrecognised_page' };
    const post = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: SOURCE_URL } };
    const search = await call(SOURCE_URL, Object.assign({}, post, { body: formBody(number, '') }));
    if (looksBlocked(search.status, search.text)) return { ok: false, reason: 'blocked' };
    if (search.status !== 200) return { ok: false, reason: 'unrecognised_page' };
    const listed = parseSearchResultsHtml(search.text, number);
    if (!listed.recognised) return { ok: false, reason: 'unrecognised_page' };
    if (!listed.found) return { ok: true, found: false };
    const detail = await call(SOURCE_URL, Object.assign({}, post, { body: formBody(number, number) }));
    if (looksBlocked(detail.status, detail.text)) return { ok: false, reason: 'blocked' };
    if (detail.status !== 200) return { ok: false, reason: 'unrecognised_page' };
    const parsed = parseRegistrationDetailsHtml(detail.text, number);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    return { ok: true, found: true, facts: parsed.facts };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

// ── cache, cool-down, pacing (in this server process) ────────────────────────
const _cache = new Map();   // number -> { at, result }
let _lastLookupAt = 0;
function _resetForTests() { _cache.clear(); _lastLookupAt = 0; }

/**
 * Look one registration number up.
 *
 * @param {string} number  e.g. MED0001234567
 * @param {object} [opts]
 * @param {string} [opts.provider]     override the environment (tests)
 * @param {boolean} [opts.force]       staff pressed the button: skip the cache
 * @param {string} [opts.accountName]  fixture provider only: the name to print
 *        on a fixture page that says "the account's own name"
 * @param {function} [opts.fetchImpl]  tests: a stand-in for fetch
 * @param {number} [opts.now]
 * @returns {Promise<{
 *   ok: boolean,           the register answered and the answer was understood
 *   provider: string,
 *   found?: boolean,       ok only: the number is on the register
 *   facts?: object,        found only (see parseRegistrationDetailsHtml)
 *   reason?: string,       not ok: provider_off | invalid_number | rate_limited |
 *                          timeout | network_error | blocked | unrecognised_page |
 *                          number_mismatch | no_http_client
 *   cached?: boolean
 * }>}
 * Never throws. With provider `none` nothing is requested at all.
 */
async function lookupRegistration(number, opts) {
  const o = opts || {};
  const provider = o.provider ? providerName({ AHPRA_LOOKUP_PROVIDER: o.provider }) : providerName();
  if (provider === PROVIDER.NONE) return { ok: false, provider: PROVIDER.NONE, reason: 'provider_off' };
  const n = normaliseNumber(number);
  if (!NUMBER_RE.test(n)) return { ok: false, provider: provider, reason: 'invalid_number' };
  const now = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now();
  const stamp = function (result) {
    if (result.ok && result.found && result.facts) {
      result.facts.fetchedAt = new Date(now).toISOString();
      result.facts.source = provider;
    }
    return Object.assign({ provider: provider }, result);
  };
  try {
    if (provider === PROVIDER.FIXTURE) {
      const page = fixtures.fixturePageFor(n, { accountName: o.accountName });
      if (page.kind === 'unknown') return stamp({ ok: true, found: false });
      if (page.kind === 'failure') return stamp({ ok: false, reason: page.reason });
      if (page.kind === 'not_found') return stamp({ ok: true, found: false });
      const parsed = parseRegistrationDetailsHtml(page.html, n);
      return stamp(parsed.ok ? { ok: true, found: true, facts: parsed.facts } : { ok: false, reason: parsed.reason });
    }
    const key = provider + ':' + n;
    const hit = _cache.get(key);
    if (hit && !o.force && now - hit.at < CACHE_MS) return Object.assign({}, hit.result, { cached: true });
    if (now - _lastLookupAt < MIN_GAP_BETWEEN_LOOKUPS_MS) return { ok: false, provider: provider, reason: 'rate_limited' };
    _lastLookupAt = now;
    let result = await fetchPublicRegister(n, o);
    // One retry at most, and only for a plain network slip (never for a
    // refusal, a timeout or a page we did not recognise).
    if (!result.ok && result.reason === 'network_error') result = await fetchPublicRegister(n, o);
    const out = stamp(result);
    if (out.ok) {
      if (_cache.size >= MAX_CACHE) _cache.clear();
      _cache.set(key, { at: now, result: out });
    }
    return out;
  } catch (err) {
    return { ok: false, provider: provider, reason: 'network_error' };
  }
}

module.exports = {
  PROVIDER,
  SOURCE_URL,
  USER_AGENT,
  TOTAL_TIMEOUT_MS,
  MIN_GAP_BETWEEN_LOOKUPS_MS,
  COOLDOWN_MS,
  providerName,
  normaliseNumber,
  isoFromRegisterDate,
  parseQualification,
  parseRequirements,
  parseRegistrationDetailsHtml,
  parseSearchResultsHtml,
  looksBlocked,
  lookupRegistration,
  _resetForTests
};

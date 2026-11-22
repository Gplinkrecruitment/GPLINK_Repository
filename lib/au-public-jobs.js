'use strict';
/**
 * WP-22 (Australian GP build): the public job board and job page for a reader
 * whose audience is not known, and the role titles and figures a doctor on an
 * Australian pathway is shown.
 *
 * Pure: no I/O, no switch read. server.js calls it only with the switch on;
 * with it off nothing here runs and the public payloads are today's.
 *
 *   doctorFacingTitle(role)        "General Practice · Parramatta, NSW" for an
 *                                  internal title; an ordinary title is kept
 *   rewriteInternalTitles(text)    the same, for a string that may carry one
 *   hasFigure(text)                a dollar figure or a percentage
 *   stripFigures(text)             the text without the sentences that carry one
 *   neutralPublicJob(job, row)     the public payload for the neutral view
 *   publicFacts(row)               the role's plain facts, "not stated" honest
 *   applyPublicFilters(entries, params)   the WP-22 filters
 *   neutralMapPractice(job)        the map sidebar's copy of the same
 *   neutralJobMeta(job)            title + description for the job page head
 *   neutralJobPostingDescription(job)     the JobPosting description
 *   neutraliseDoctorRolePayload(payload)  titles and figures out of a role /
 *                                  application payload for an Australian doctor
 *
 * THE RULES (one place):
 *   - A role's internal title ("Non-DPA - Parramatta - Mixed Billing") is a
 *     staff label. A doctor is shown "General Practice · <suburb>, <state>".
 *   - Owner decision 9 forbids dollar figures and percentages in what an
 *     Australian doctor is told about a role. The neutral public view and an
 *     Australian doctor's view carry none: the billing MODEL stays.
 *   - A field nobody filled in is "not stated". It is never guessed, and
 *     "DPA not recorded" is never shown or filtered as "not a DPA".
 *   - Content written for a doctor moving country is not thrown away: it is
 *     returned separately (`movingToAustralia`) so the page can show it under
 *     a heading that says who it is for.
 */

const roleEligibility = require('./role-eligibility.js');
const auDoctorText = require('./au-doctor-text.js');

// ── titles ──────────────────────────────────────────────────────────────────

// "DPA - Terrigal - Mixed Billing", "Non-DPA – Parramatta – Bulk Billing".
const INTERNAL_TITLE = /^\s*(?:non[\s-]*)?dpa\s*[-–—]\s*([^–—-]+?)\s*(?:[-–—]\s*(.*))?$/i;
const INTERNAL_TITLE_INLINE = /\b(?:non[\s-]?)?dpa\s[-–—]\s([^–—\n-]+?)\s[-–—]\s(?:mixed|bulk|private)[\s-]?billing\b/gi;
const BASE_TITLE = 'General Practice';

const STATE_CODES = {
  'new south wales': 'NSW', victoria: 'VIC', queensland: 'QLD', 'western australia': 'WA',
  'south australia': 'SA', tasmania: 'TAS', 'australian capital territory': 'ACT', 'northern territory': 'NT'
};
function stateCode(value) {
  const t = String(value == null ? '' : value).trim();
  if (!t) return '';
  return STATE_CODES[t.toLowerCase()] || t.toUpperCase();
}

function isInternalRoleTitle(title) {
  return INTERNAL_TITLE.test(String(title == null ? '' : title));
}

/**
 * The title a doctor reads. `role` may be a career_roles row or a public job
 * (title, suburb, nearest_city, location_state / state).
 */
function doctorFacingTitle(role) {
  const r = role && typeof role === 'object' ? role : {};
  const title = String(r.title == null ? '' : r.title).trim();
  const match = title.match(INTERNAL_TITLE);
  // An ordinary, person-written title is kept (unless it carries a figure).
  if (title && !match && !hasFigure(title)) return title;
  const place = String(r.suburb || (match && match[1]) || r.nearest_city || r.nearestCity || '').trim();
  const st = stateCode(r.location_state || r.state);
  if (place) return BASE_TITLE + ' · ' + place + (st ? ', ' + st : '');
  return st ? BASE_TITLE + ' · ' + st : BASE_TITLE + ' role';
}

/** Any internal title inside a string (a notification, a card line). */
function rewriteInternalTitles(text) {
  const s = String(text == null ? '' : text);
  if (!s || !/dpa/i.test(s)) return s;
  const whole = s.match(INTERNAL_TITLE);
  if (whole) return BASE_TITLE + ' · ' + whole[1].trim();
  return s.replace(INTERNAL_TITLE_INLINE, function (m, place) { return BASE_TITLE + ' · ' + String(place).trim(); });
}

// ── figures ─────────────────────────────────────────────────────────────────

// A dollar figure or a percentage. "5 km" is not one ("k" followed by "m").
const FIGURE = /\$|%|\bper\s?cent\b|\bpercent(?:age)?s?\b|\b\d[\d,.]*\s?k\b|\b\d{2}\s?\/\s?\d{2}\s+(?:split|to\s+(?:the\s+)?(?:gp|doctor))\b/i;
function hasFigure(text) { return FIGURE.test(String(text == null ? '' : text)); }

/** The text without any sentence (or line, or bullet) that carries a figure. */
function stripFigures(text) {
  const s = String(text == null ? '' : text);
  if (!s || !hasFigure(s)) return s;
  const lines = s.split(/\r?\n/).map(function (line) {
    if (!hasFigure(line)) return line;
    // A full stop inside a number ("$2.5k", "70.5%") does not end a sentence.
    const parts = line.match(/(?:[^.!?;•·|]|\.(?=\d))+[.!?;•·|]*\s*/g) || [line];
    return parts.filter(function (p) { return !hasFigure(p); }).join('').replace(/\s+$/, '');
  });
  return lines.filter(function (line) { return line.trim() !== ''; }).join('\n').trim();
}

// ── facts ───────────────────────────────────────────────────────────────────

/**
 * What the public may be told about whether a role is in a Distribution
 * Priority Area. The legacy boolean stored "nobody said" as false, so a role
 * with no recorded status and dpa !== true is NOT STATED, never "no".
 * @returns {'yes'|'no'|'unknown'}
 */
function publicDpa(row) {
  const r = row && typeof row === 'object' ? row : {};
  const stored = String(r.dpa_status == null ? '' : r.dpa_status).trim().toLowerCase();
  if (stored === 'yes' || stored === 'no') return stored;
  if (stored === 'unknown') return 'unknown';
  return r.dpa === true ? 'yes' : 'unknown';
}

/** publicRoleFacts with the honest DPA answer. Nothing that identifies a practice. */
function publicFacts(row) {
  const facts = roleEligibility.publicRoleFacts(row);
  facts.dpa = publicDpa(row);
  return facts;
}

// ── the neutral public job ──────────────────────────────────────────────────

const clean = auDoctorText.isClean;

function cleanList(list) {
  return (Array.isArray(list) ? list : []).filter(function (x) { return typeof x === 'string' && x.trim(); });
}

/**
 * The public job for a reader of unknown audience (switch on).
 *
 * @param {object} job  mapCareerRoleRowToPublicJob(row): already masked
 * @param {object} row  the career_roles row (read only for the role fields)
 */
function neutralPublicJob(job, row) {
  const j = job && typeof job === 'object' ? job : {};
  const pt = j.packageTerms && typeof j.packageTerms === 'object' ? j.packageTerms : {};
  const perks = (Array.isArray(j.aiPerks) ? j.aiPerks : []).filter(function (p) { return p && p.label && p.value; });
  const highlights = cleanList(j.aiHighlights);

  // 1. What is only for a doctor moving country, kept for that column. Never
  //    a line with a figure.
  const moving = [];
  const pushMoving = function (line) {
    const t = String(line || '').trim();
    if (!t || hasFigure(t) || moving.indexOf(t) !== -1) return;
    moving.push(t);
  };
  if (j.visa === true || pt.visaSponsorship) pushMoving('Sponsorship is available for this role');
  highlights.forEach(function (h) { if (!clean(h)) pushMoving(h); });
  perks.forEach(function (p) {
    if (clean(p.label) && clean(p.value)) return;
    pushMoving(String(p.label) + ': ' + String(p.value));
  });

  // 2. The neutral copy: the shared scrub (the call an Australian doctor's
  //    in-app role goes through), then no figures.
  const neutralSource = {
    summary: j.summary || '',
    aiAbout: j.aiAbout || '',
    aiHighlights: highlights,
    // Entries the scrub would only relabel ("Relocation package") belong to
    // the other column, so they are taken out before it runs.
    aiPerks: perks.filter(function (p) { return clean(p.label) && clean(p.value); }),
    tags: cleanList(j.tags)
  };
  const scrubbed = auDoctorText.scrubRolePayload(neutralSource);
  const neutralPerks = (Array.isArray(scrubbed.aiPerks) ? scrubbed.aiPerks : [])
    .filter(function (p) { return p && p.label && p.value && !hasFigure(p.label) && !hasFigure(p.value) && !MONEY_LABEL.test(String(p.label)); });

  const out = Object.assign({}, j, {
    title: doctorFacingTitle({ title: j.title, suburb: j.suburb, nearest_city: j.nearest_city, location_state: j.location_state }),
    earnings_text: '',
    summary: stripFigures(scrubbed.summary),
    aiAbout: stripFigures(scrubbed.aiAbout),
    aiHighlights: cleanList(scrubbed.aiHighlights).filter(function (h) { return !hasFigure(h); }),
    aiPerks: neutralPerks,
    tags: cleanList(scrubbed.tags).filter(function (t) { return !hasFigure(t); }),
    // Only the two yes / no terms survive: every other package term is a figure.
    packageTerms: (pt.supervision || pt.visaSponsorship)
      ? { supervision: pt.supervision ? 'Available' : '', visaSponsorship: !!pt.visaSponsorship }
      : null,
    auFacts: publicFacts(row),
    movingToAustralia: { sponsorship: j.visa === true || !!pt.visaSponsorship, lines: moving.slice(0, 6) }
  });
  return out;
}

// A perk whose label is about money is a term the doctor hears from the
// practice, even when the value happens to carry no digit ("Negotiable").
const MONEY_LABEL = /\b(income|earnings?|salary|guarantee|bonus|billing split|percentage|remuneration|commission)\b/i;

/** The keys the neutral public job adds to the public allow-list. */
const NEUTRAL_PUBLIC_FIELDS = Object.freeze(['auFacts', 'movingToAustralia']);

// ── filters ─────────────────────────────────────────────────────────────────

const FILTER_PARAMS = Object.freeze(['vr', 'dpa', 'area', 'mmm', 'sessions']);
// Sessions a week: "part" = the role can be worked at 6 sessions or fewer;
// "full" = it offers 8 or more. Only roles that state their sessions match.
const PART_TIME_MAX_SESSIONS = 6;
const FULL_TIME_MIN_SESSIONS = 8;

function param(params, name) {
  const v = params && typeof params.get === 'function' ? params.get(name) : (params ? params[name] : '');
  return String(v == null ? '' : v).trim().toLowerCase();
}

/** The WP-22 filters a request carries, validated. Unknown values are dropped. */
function readPublicFilters(params) {
  const out = {};
  const vr = param(params, 'vr').replace(/-/g, '_');
  if (vr === 'vr' || vr === 'non_vr') out.vr = vr;
  const dpa = param(params, 'dpa');
  if (dpa === 'yes' || dpa === 'no' || dpa === 'unknown') out.dpa = dpa;
  const area = param(params, 'area');
  if (area === 'metro' || area === 'regional') out.area = area;
  const mmm = param(params, 'mmm').replace(/^mm+/, '');
  if (/^[1-7]$/.test(mmm)) out.mmm = Number(mmm);
  const sessions = param(params, 'sessions');
  if (sessions === 'part' || sessions === 'full') out.sessions = sessions;
  return out;
}

function hasPublicFilters(params) { return Object.keys(readPublicFilters(params)).length > 0; }

/**
 * One filter against one role's facts.
 * @returns {'match'|'no'|'unstated'}  unstated: the role does not say, so it
 *   is left out of a filtered list and counted, never guessed into it.
 */
function testFilter(name, value, facts) {
  const f = facts || {};
  if (name === 'vr') {
    if (value === 'non_vr') {
      if (!f.vrRequirementStated) return 'unstated';
      return f.vrRequirement === 'non_vr_accepted' ? 'match' : 'no';
    }
    // "VR roles": every role except one that says it is open to GPs without
    // VR. A role that states nothing is treated as VR required everywhere in
    // the product (owner decision 5), so it belongs here, and is labelled.
    return f.vrRequirement === 'non_vr_accepted' ? 'no' : 'match';
  }
  if (name === 'dpa') {
    if (value === 'unknown') return f.dpa === 'unknown' ? 'match' : 'no';
    if (f.dpa === 'unknown') return 'unstated';
    return f.dpa === value ? 'match' : 'no';
  }
  if (name === 'area') {
    if (!f.area) return 'unstated';
    return f.area === value ? 'match' : 'no';
  }
  if (name === 'mmm') {
    if (f.mmm == null) return 'unstated';
    return Number(f.mmm) === Number(value) ? 'match' : 'no';
  }
  if (name === 'sessions') {
    const lo = f.sessionsMin != null ? Number(f.sessionsMin) : (f.sessionsMax != null ? Number(f.sessionsMax) : null);
    const hi = f.sessionsMax != null ? Number(f.sessionsMax) : lo;
    if (lo == null || hi == null) return 'unstated';
    if (value === 'part') return lo <= PART_TIME_MAX_SESSIONS ? 'match' : 'no';
    return hi >= FULL_TIME_MIN_SESSIONS ? 'match' : 'no';
  }
  return 'match';
}

/**
 * @param {Array<{ facts: object }>} entries  anything carrying `facts`
 * @param {URLSearchParams|object} params
 * @returns {{ entries: Array, unstated: number, active: object }}
 *   unstated: roles left out ONLY because they do not state a filtered field.
 */
function applyPublicFilters(entries, params) {
  const active = readPublicFilters(params);
  const names = Object.keys(active);
  const list = Array.isArray(entries) ? entries : [];
  if (!names.length) return { entries: list, unstated: 0, active };
  const kept = [];
  let unstated = 0;
  list.forEach(function (entry) {
    const results = names.map(function (n) { return testFilter(n, active[n], entry && entry.facts); });
    if (results.every(function (r) { return r === 'match'; })) { kept.push(entry); return; }
    if (results.indexOf('no') === -1) unstated += 1;
  });
  return { entries: kept, unstated, active };
}

const BILLING_WORDS = { bulk: 'bulk billing', mixed: 'mixed billing', private: 'private billing' };
/** Extra words the keyword search matches with the switch on (the title no longer carries them). */
function factsSearchText(facts) {
  const f = facts || {};
  const words = [];
  if (BILLING_WORDS[f.billingModel]) words.push(BILLING_WORDS[f.billingModel]);
  if (f.dpa === 'yes') words.push('dpa distribution priority area');
  if (f.area === 'metro') words.push('metro metropolitan');
  if (f.area === 'regional') words.push('regional rural');
  if (f.mmm != null) words.push('mm' + f.mmm + ' mmm ' + f.mmm);
  if (f.vrRequirement === 'non_vr_accepted') words.push('non-vr non vr');
  else if (f.vrRequirementStated) words.push('vr');
  if (f.engagementType) words.push(f.engagementType);
  (Array.isArray(f.specialInterests) ? f.specialInterests : []).forEach(function (s) { words.push(String(s)); });
  return words.join(' ').toLowerCase();
}

// ── the map ─────────────────────────────────────────────────────────────────

/** The map sidebar's benefits for the neutral view: no figure, nothing for one audience only. */
function neutralMapBenefits(job) {
  const j = job || {};
  const out = [];
  (Array.isArray(j.aiPerks) ? j.aiPerks : []).forEach(function (p) {
    if (p && p.label && p.value) out.push({ label: String(p.label), value: String(p.value) });
  });
  const pt = j.packageTerms && typeof j.packageTerms === 'object' ? j.packageTerms : {};
  if (!out.length && pt.supervision) out.push({ label: 'Supervision', value: 'Available' });
  return out.slice(0, 4);
}

// ── the job page head ───────────────────────────────────────────────────────

const NEUTRAL_META_FALLBACK = 'View this GP role in Australia: location, billing model, registration requirement and sessions. GP Link introduces you to the practice in confidence, at no cost to you.';

function oneLine(text, max) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** { title, description } for the job page's head (switch on). `job` is the neutral public job. */
function neutralJobMeta(job) {
  const j = job || {};
  const title = String(j.title || BASE_TITLE + ' role') + ' | GP Link';
  const fromCopy = oneLine(stripFigures(auDoctorText.scrubText(j.aiAbout || j.summary || '')), 200);
  return { title, description: fromCopy || NEUTRAL_META_FALLBACK };
}

/** The JobPosting description (switch on). No premise about where the doctor is coming from. */
function neutralJobPostingDescription(job) {
  const j = job || {};
  const fromCopy = String(stripFigures(auDoctorText.scrubText(j.aiAbout || j.summary || '')) || '').trim();
  if (fromCopy) return fromCopy;
  return 'General practice opportunity in ' + String(j.location_label || 'Australia')
    + '. GP Link introduces GPs to Australian practices in confidence and supports them through interview, offer and contract, at no cost to the doctor.';
}

const NEUTRAL_HIRING_ORG_DESCRIPTION = 'GP recruitment: hiring on behalf of a confidential Australian general practice.';

// ── an Australian doctor's in-app payloads ──────────────────────────────────

// Keys never rewritten: ids, addresses, statuses, dates, and the masked
// headline Careers parses for the suburb (`practiceName` in a role payload is
// rewritten by the page, which shows "General Practice · <suburb>").
const SKIP_KEY = /(^id$|Id$|_id$|url$|Url$|href$|^src$|image|photo|logo|slug|token|^key$|email|phone|^status$|^rawStatus$|stage$|^type$|^code$|At$|_at$|date$|Date$|^practiceName$|^filterTokens$|^distanceKm$|^applicantBand$)/;
const TITLE_KEY = /^(title|roleTitle|roleType|jobTitle|role|roleName|headline)$/;
const MONEY_KEY = /^(earnings|earningNote|earnings_text|earningsText|salary|income|compensation|billingSplit|billing_split|incomeGuarantee|agreementBonus|percentage_split|incentives)$/;

function neutraliseNode(node, key, depth) {
  if (depth > 12 || node === null || node === undefined) return node;
  if (typeof node === 'string') {
    if (key && SKIP_KEY.test(key)) return node;
    if (/^(https?:|\/|data:|mailto:|tel:)/i.test(node)) return node;
    if (key && MONEY_KEY.test(key)) return '';
    // "Role type" sits beside a title that already names the place (Careers
    // does the same for a masked headline).
    if (key === 'roleType' && isInternalRoleTitle(node)) return 'General Practitioner';
    let s = node;
    if (key && TITLE_KEY.test(key) && isInternalRoleTitle(s)) s = rewriteInternalTitles(s);
    else if (/dpa/i.test(s)) s = rewriteInternalTitles(s);
    return hasFigure(s) ? stripFigures(s) : s;
  }
  if (Array.isArray(node)) {
    if (key && SKIP_KEY.test(key)) {
      // filterTokens: a list of short machine-ish chips. Only the one built
      // from the earnings figure goes.
      return node.filter(function (x) { return !(typeof x === 'string' && /^high earning$/i.test(x.trim())); });
    }
    const out = [];
    node.forEach(function (entry) {
      if (typeof entry === 'string') {
        if (hasFigure(entry)) { const kept = entry.length > 120 ? stripFigures(entry) : ''; if (kept) out.push(kept); return; }
        out.push(/dpa/i.test(entry) ? rewriteInternalTitles(entry) : entry);
        return;
      }
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        // A labelled row / tile: one that states a figure, or is about money, goes.
        const label = typeof entry.label === 'string' ? entry.label : (typeof entry.k === 'string' ? entry.k : '');
        const value = typeof entry.value === 'string' ? entry.value : (typeof entry.v === 'string' ? entry.v : '');
        if (label && (MONEY_LABEL.test(label) || hasFigure(label) || hasFigure(value))) return;
      }
      out.push(neutraliseNode(entry, '', depth + 1));
    });
    return out;
  }
  if (typeof node === 'object') {
    const out = {};
    Object.keys(node).forEach(function (k) { out[k] = neutraliseNode(node[k], k, depth + 1); });
    return out;
  }
  return node;
}

/**
 * A copy of a role / application / placement payload for a doctor on an
 * Australian pathway: internal role titles become the doctor-facing title and
 * no value carries a dollar figure or a percentage. Ids, addresses, statuses,
 * dates and the masked `practiceName` are left alone. Nothing is added.
 */
function neutraliseDoctorRolePayload(payload) {
  return neutraliseNode(payload, '', 0);
}

// The role LISTING inside an application (what the job board said about the
// role). Everything else on an application is the doctor's own dealings with
// the practice (an offer, a contract, a placement), where the practice's real
// terms belong, so figures there are left exactly as they are.
const LISTING_KEY = /^(role|roleClient|roleDetails|listing)$/;

function neutraliseApplicationNode(node, key, depth) {
  if (depth > 12 || node === null || node === undefined) return node;
  if (typeof node === 'string') {
    if (key === 'roleType' && isInternalRoleTitle(node)) return 'General Practitioner';
    if (key && TITLE_KEY.test(key) && isInternalRoleTitle(node)) return rewriteInternalTitles(node);
    return node;
  }
  if (Array.isArray(node)) return node.map(function (entry) { return neutraliseApplicationNode(entry, '', depth + 1); });
  if (typeof node === 'object') {
    const out = {};
    Object.keys(node).forEach(function (k) {
      const v = node[k];
      out[k] = (LISTING_KEY.test(k) && v && typeof v === 'object' && !Array.isArray(v))
        ? neutraliseNode(v, '', depth + 1)
        : neutraliseApplicationNode(v, k, depth + 1);
    });
    return out;
  }
  return node;
}

/**
 * The same for an application (or a list of them): internal role titles are
 * rewritten everywhere, and figures are removed only from the role listing
 * nested inside it.
 */
function neutraliseDoctorApplicationPayload(payload) {
  return neutraliseApplicationNode(payload, '', 0);
}

module.exports = {
  BASE_TITLE,
  isInternalRoleTitle,
  doctorFacingTitle,
  rewriteInternalTitles,
  FIGURE,
  hasFigure,
  stripFigures,
  publicDpa,
  publicFacts,
  neutralPublicJob,
  NEUTRAL_PUBLIC_FIELDS,
  FILTER_PARAMS,
  PART_TIME_MAX_SESSIONS,
  FULL_TIME_MIN_SESSIONS,
  readPublicFilters,
  hasPublicFilters,
  testFilter,
  applyPublicFilters,
  factsSearchText,
  neutralMapBenefits,
  NEUTRAL_META_FALLBACK,
  neutralJobMeta,
  neutralJobPostingDescription,
  NEUTRAL_HIRING_ORG_DESCRIPTION,
  neutraliseDoctorRolePayload,
  neutraliseDoctorApplicationPayload,
  stateCode
};

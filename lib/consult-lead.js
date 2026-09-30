// lib/consult-lead.js — pure decision logic for the Meta-ads GP consult funnel.
// No I/O beyond crypto randomness. Consumed by server.js (endpoints, FB webhook
// GP branch, consult-nudge cron). See docs/superpowers/specs/2026-07-14-meta-ads-gp-funnel-design.md.
'use strict';

const crypto = require('crypto');
const { LEGACY_NOT_BOOKED_WA_KINDS } = require('./consult-whatsapp.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Countries whose GPs we will book a call with.
// 'au' added 2026-08-15 (owner): an Australian-trained GP is already registrable here, so
// she does not need the expedited specialist pathway — but she is still someone we can
// place, and turning her away at the form was throwing away a placeable doctor. The
// pathway differs after the call; the call itself is offered to all four.
const SUPPORTED_CONSULT_COUNTRIES = ['uk', 'ie', 'nz', 'au'];

// Sequence A (not_booked) anchors at lead creation. Entries are
// { after: ms, email: bool, wa: <consult-whatsapp kind>, gapBefore?: ms } — each
// step names which channels it carries. The magic link goes out on qualification
// (see the FB webhook), so every step here is a follow-up, not the first contact.
//
// Owner rule 2026-09-30. The old 2h / 48h / day-5 chase read as a robot chasing
// people and was retired. In its place, three short notes in the owner's own
// voice, each ending in something a person can answer:
//   5 min   WhatsApp only — "I just saw your form", one question, booking link.
//           (No email: the magic-link email went out seconds earlier.)
//   1 hour  WhatsApp + email — "tell me the one thing you'd want answered".
//   24 h    WhatsApp + email — "last note from me", the door left open.
// The flow stops the moment the doctor books OR replies on WhatsApp (the
// DoubleTick webhook stamps stopped:'replied'), and if nothing has been booked
// 20 minutes after the 1-hour note the owner is paged with the lead's details
// so a human picks up — see consultOwnerAlertDecision below. Each WhatsApp step
// is its own approved template (lib/consult-whatsapp.js CONSULT_WA_TEMPLATES).
// The consult-nudge cron runs every 5 minutes so "5 minutes" means 5–10 minutes
// after the form, not some time within the hour.
// Sequence B (booked_no_signup) is the post-booking signup drip: 5 touches with
// per-step anchors. Step 0 goes right after booking. Every later step anchors
// on the call having HAPPENED — 'completed' = scheduled_calls.completed_at,
// written when Zoom reports the meeting ended — not on the slot time. Owner
// rule 2026-09-30: "they should get the create-account email instantly after
// the call ends, as long as they did attend". A no-show never completes (the
// no-show sweep wipes the booking instead), so a no-show never reads "great
// speaking with you"; an unknown completion DEFERS those steps, it never falls
// back to the slot or the booking time. The Zoom webhook delivers step 1 the
// moment the call ends; the 5-minute cron is the backstop. Entries are
// { anchor: 'booked'|'call'|'completed', after: ms, gapBefore?: ms }. See
// docs/superpowers/specs/2026-07-25-booker-signup-nudge-and-backfill-design.md.
const CONSULT_NUDGE_SCHEDULE_MS = {
  not_booked: [
    { after: 5 * MINUTE, email: false, wa: 'hello_5m' },
    { after: 1 * HOUR, email: true, wa: 'check_in_1h', gapBefore: 40 * MINUTE },
    { after: 24 * HOUR, email: true, wa: 'day_after_24h', gapBefore: 12 * HOUR },
  ],
  booked_no_signup: [
    { anchor: 'booked', after: 0 },                                   // touch 1 — right after booking
    { anchor: 'completed', after: 0 },                                // touch 2 — the moment an attended call ends
    { anchor: 'completed', after: 7 * DAY, gapBefore: 20 * HOUR },    // touch 3 — week 1
    { anchor: 'completed', after: 14 * DAY, gapBefore: 20 * HOUR },   // touch 4 — week 2
    { anchor: 'completed', after: 21 * DAY, gapBefore: 20 * HOUR },   // touch 5 — week 3 (final)
  ],
};

// Catch-up spacing. A not_booked lead whose sequence is being caught up on (a
// row repaired after a mis-stamped stop, a cron outage, a template that was
// pending approval for a day) has several steps overdue at once, and three
// WhatsApps in a row reads as spam. A step is never sent sooner than its own
// `gapBefore` after the previous step (the 1-hour note waits 40 minutes after
// the 5-minute one; the day-after note waits 12 hours), whatever the schedule
// says. A step without its own floor uses this default.
const CONSULT_NUDGE_MIN_GAP_MS = 40 * MINUTE;

// Owner paging (owner rule 2026-09-30). How long after the 1-hour note — or,
// if that note never went out, after the hour itself — an unbooked lead is
// escalated to a human…
const CONSULT_OWNER_ALERT_STEP = 1;
const CONSULT_OWNER_ALERT_AFTER_STEP_MS = 20 * MINUTE;
// …and how old a lead may be and still be escalated. Guards the rollout (the
// in-flight leads from the last two days are paged once; older ones are not)
// and keeps a lead repaired weeks later from paging the owner out of nowhere.
const CONSULT_OWNER_ALERT_WINDOW_MS = 48 * HOUR;

// ⚖️ A POSITIVELY-READ SERVED COUNTRY IS ENOUGH — owner-confirmed 2026-08-18.
// This used to demand `isGp === true`, which only ever came from the form's
// "are you a currently registered GP?" question. When that question was dropped
// (the live Meta form now disqualifies non-GPs at source, so it was asking twice),
// the ONLY surviving route to `qualified` was the +44 dialling-code rescue in
// buildConsultLeadRow — and plenty of UK-trained GPs hold an overseas number, so
// every one of them silently fell to country_unknown: no magic link, no nudges,
// a human chasing them by hand. Now an answer we positively READ that names a
// country we serve qualifies on its own.
//
// `countryRecognised` is what keeps this honest: it is true only when the answer
// parsed to a country we actually recognise, never when we merely failed to read
// it. So this widens who can qualify without weakening the rule in
// resolveFbLeadCountry that an unreadable answer is OUR failure, not their
// ineligibility. Callers that don't pass the flag (the website /start form, which
// validates isGp to a real boolean) behave exactly as before.
function screenConsultLead(input) {
  if (!input || input.isGp === false) return false;
  const country = String(input.country || '').toLowerCase();
  if (!SUPPORTED_CONSULT_COUNTRIES.includes(country)) return false;
  if (input.isGp === true) return true;
  return input.countryRecognised === true;
}

function generateConsultToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function parseGpFormIds(envValue) {
  return String(envValue || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseYesNo(raw) {
  // 🧨 Same Meta-slug trap that cost us Louise Beet on the country question, lying
  // in wait on the "are you a currently registered GP?" one. Meta delivers a
  // multiple-choice answer as a snake_cased slug, and `_` is a WORD character, so
  // `\b` never fires after "yes": parseYesNo('yes_i_am_currently_registered')
  // returned NULL. That is worse than it looks — isGp then isn't `true`, which
  // both fails screening AND disables the country_unknown safety net in
  // buildConsultLeadRow (it requires isGp === true), so a genuine GP is filed as a
  // confident, terminal screened_out. Normalise separators first, exactly as
  // parseCountryAnswer does.
  const v = String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!v) return null;
  if (/^y(es)?\b/.test(v) || v === 'true') return true;
  if (/^no?\b/.test(v) || v === 'false') return false;
  return null;
}

function parseCountryAnswer(raw) {
  // 🧨 Meta returns a multiple-choice ANSWER as a snake_cased slug, not the
  // display text the doctor tapped: a real lead on 2026-08-14 answered "United
  // Kingdom" and arrived as `united_kingdom`. Matching on 'united kingdom' with
  // a SPACE therefore missed it, she scored 'other', and a UK GP was shown "we
  // can't take this one on" — the exact turndown that names the UK as a country
  // we DO serve. Underscores also defeat the short-code tests, because `_` is a
  // word character to a regex, so `\buk\b` cannot match inside `uk_trained`.
  //
  // So flatten EVERY non-alphanumeric run to a single space before matching.
  // That covers snake_case, kebab-case, "UK/Ireland", punctuation and stray
  // double spaces in one step, and costs nothing when Meta does send prose.
  const v = String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!v) return 'other';
  if (v.includes('northern ireland')) return 'uk'; // before the 'ireland' check
  if (v.includes('united kingdom') || /\buk\b/.test(v) || /\bgb\b/.test(v) || v.includes('britain') || v.includes('british') || v.includes('england') || v.includes('scotland') || v.includes('wales')) return 'uk';
  if (v.includes('ireland') || /\bie\b/.test(v) || /\beire\b/.test(v)) return 'ie';
  // New Zealand BEFORE Australia: "Australia and New Zealand" is a real option wording,
  // and a doctor picking it is telling us NZ, which is the expedited pathway.
  if (v.includes('new zealand') || /\bnz\b/.test(v) || v.includes('aotearoa')) return 'nz';
  if (v.includes('australia') || /\bau\b/.test(v) || /\baus\b/.test(v)) return 'au';
  return 'other';
}

// Countries we RECOGNISE and do not serve. This list exists so that "they told us
// somewhere we don't work" can be told apart from "we could not read the answer" —
// see isRecognisedCountryAnswer. It does not need to be exhaustive; anything absent
// simply falls through to a human instead of a silent turndown, which is the safe
// direction. Includes the explicit opt-outs a multiple-choice form offers.
const RECOGNISED_UNSERVED_COUNTRY_HINTS = [
  // NB: 'australia' is deliberately NOT here — it is a SERVED country (see
  // SUPPORTED_CONSULT_COUNTRIES). Re-adding it would turn Australian GPs away again.
  'india', 'pakistan', 'bangladesh', 'sri lanka', 'nepal', 'south africa',
  'nigeria', 'ghana', 'kenya', 'zimbabwe', 'uganda', 'tanzania', 'zambia', 'sudan',
  'egypt', 'iraq', 'iran', 'syria', 'jordan', 'lebanon', 'saudi', 'emirates', 'qatar',
  'kuwait', 'oman', 'bahrain', 'yemen', 'afghanistan', 'united states', 'america', 'usa',
  'canada', 'mexico', 'brazil', 'argentina', 'china', 'japan', 'korea', 'philippines',
  'malaysia', 'singapore', 'indonesia', 'thailand', 'vietnam', 'myanmar', 'germany',
  'france', 'spain', 'portugal', 'italy', 'greece', 'poland', 'romania', 'bulgaria',
  'hungary', 'czech', 'slovakia', 'croatia', 'serbia', 'netherlands', 'belgium',
  'sweden', 'norway', 'denmark', 'finland', 'austria', 'switzerland', 'ukraine',
  'russia', 'turkey', 'israel', 'malta', 'cyprus'
];

// Explicit "none of your options" answers. Choosing one IS a statement, but these are
// matched EXACTLY (after separator flattening), never as substrings: "other" inside
// "another region" or "mother and baby unit" is not a doctor opting out, and treating
// it as one would manufacture the very false decline this file exists to prevent.
const COUNTRY_OPT_OUT_ANSWERS = [
  'other', 'none', 'none of the above', 'elsewhere', 'somewhere else', 'not listed',
  'other country', 'outside these', 'not applicable', 'n a'
];

/**
 * Did this answer POSITIVELY name a country (served or not), or did we simply fail
 * to understand it?
 *
 * 🧨 This distinction is the whole ballgame, and its absence is why a UK GP was
 * turned away twice in two weeks. Until now the code had exactly one bucket for
 * both meanings — parseCountryAnswer returns 'other' for "Australia" AND for
 * "united_kingdom" (a slug it could not read) AND for "Glasgow Royal Infirmary" —
 * and buildConsultLeadRow treated that single value as a decision to decline.
 *
 * A decline must require EVIDENCE. Absence of recognition is not evidence.
 */
function isRecognisedCountryAnswer(raw) {
  const v = String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!v) return false;
  if (parseCountryAnswer(v) !== 'other') return true; // a country we serve
  if (COUNTRY_OPT_OUT_ANSWERS.includes(v)) return true; // exact match only — see above
  return RECOGNISED_UNSERVED_COUNTRY_HINTS.some((c) => v.includes(c));
}

// Dialling codes for the countries we serve. Used ONLY as corroboration when the
// written answer is unreadable: both real Meta leads to date arrived with a +44
// number, so the phone is an independent second signal that costs nothing. It never
// overrides an answer we DID understand — it only stops us discarding a doctor whose
// wording we failed to parse.
const SERVED_DIAL_CODES = [
  { prefix: '+44', country: 'uk' },
  { prefix: '+353', country: 'ie' },
  { prefix: '+64', country: 'nz' },
  { prefix: '+61', country: 'au' }
];

function countryFromPhone(phone) {
  const p = String(phone == null ? '' : phone).replace(/[^\d+]/g, '');
  if (!p.startsWith('+')) return '';
  // Longest prefix first so +44 can never shadow a longer code added later.
  const match = SERVED_DIAL_CODES.slice()
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((d) => p.startsWith(d.prefix));
  return match ? match.country : '';
}

// Meta lead-gen field_data is [{ name, values: [...] }]. Custom questions get
// snake_cased keys; match by substring so form wording tweaks don't break us.
function _fbFieldMap(fieldData) {
  const map = {};
  (Array.isArray(fieldData) ? fieldData : []).forEach((f) => {
    if (!f || !f.name) return;
    const key = String(f.name).toLowerCase();
    // Keep EVERY value, not just values[0]. A checkbox question ("where have you
    // worked?") returns several, and taking only the first hid the rest from the
    // country scan and from the stored forensics alike. Joining is enough: every
    // consumer either substring-matches or shows the text to a human.
    const val = Array.isArray(f.values)
      ? f.values.map((x) => String(x == null ? '' : x).trim()).filter(Boolean).join(', ')
      : '';
    map[key] = val;
  });
  return map;
}

function _pickByKeySubstring(map, substrings) {
  for (const key of Object.keys(map)) {
    if (substrings.some((s) => key.includes(s))) return map[key];
  }
  return '';
}

// Key hints for "which country?" — a convenience, NOT the contract. See
// resolveFbLeadCountry.
// Eligibility is about where a doctor is REGISTERED (UK/Ireland/NZ specialist
// registration is what the expedited pathway recognises). The live Meta form, however,
// asks "_where_did_you_complete_your_gp_training?" — a different fact.
//
// 🧨 They are not interchangeable, and conflating them turns a truthful answer into a
// silent rejection: a GMC-registered UK GP who did her training in India answers "india"
// and, on the old logic, was declined outright. Whether she is eligible depends on her
// REGISTRATION, which that answer never mentioned. So the two kinds of question are kept
// apart: an answer to a registration question can decline a doctor, an answer to a
// training question can only ever promote one. See buildConsultLeadRow.
const REGISTRATION_QUESTION_KEY_HINTS = [
  'where_are_you_registered', 'registration_country', 'registered_in', 'country'
];
// ⚠️ Keep this to wordings a form REALLY uses. 'qualification' was added here
// speculatively and immediately broke tests/consult-lead.test.js, whose fixture key
// ('qualification_origin_5b2?') is deliberately chosen to match NO hint so that it
// exercises the answer-scan fallback — the very safety net added after the first lost
// lead. Widening the hints quietly disables that test's reason to exist. If a real form
// ever uses a new wording, add it WITH the real key from a stored row.
const TRAINING_QUESTION_KEY_HINTS = [
  'gp_training', 'training', 'where_did_you_complete', 'trained'
];
const COUNTRY_QUESTION_KEY_HINTS = REGISTRATION_QUESTION_KEY_HINTS.concat(TRAINING_QUESTION_KEY_HINTS);

// Meta's standard contact fields. Never scanned for a country: a surname like
// "Wales" or an "@nhs.uk" address is not a statement about where someone
// trained, and guessing from one would be worse than not guessing.
const _FB_CONTACT_KEY_HINTS = ['full_name', 'first_name', 'last_name', 'email', 'phone'];

function _isFbContactKey(key) {
  return _FB_CONTACT_KEY_HINTS.some((k) => key.includes(k));
}

/**
 * Reads the country from the ANSWERS, not from the question's field name.
 *
 * 🧨 Matching on the field key alone is what broke the funnel. Meta names a
 * custom question's field after whatever wording the advertiser typed, so any
 * re-word — or a form built by hand in Ads Manager rather than from our spec —
 * yields a key none of our hints match. `_pickByKeySubstring` then returns '',
 * `parseCountryAnswer('')` returns 'other', and a perfectly eligible doctor is
 * screened out in silence: no magic link, and `nextConsultNudge` skips a
 * screened_out lead forever, so nothing chases them either.
 *
 * That is exactly what happened to the FIRST REAL lead through the funnel
 * (2026-08-13): she answered "United Kingdom", we recorded country 'other', and
 * she was never contacted at all. It stayed invisible because every "qualified"
 * row before her was a simulator lead built with the key WE chose — the tests
 * proved our own assumption about Meta's naming, never Meta's actual naming.
 *
 * So: try the keyed lookup first (it is precise when it hits), and when it does
 * not yield a country we serve, read every non-contact answer and take the first
 * that names one. The two failure directions are not equal — a false positive
 * offers a call to someone we may not place, which the call itself screens out;
 * a false negative loses a real doctor and the ad spend that bought them,
 * silently. Prefer the recoverable error.
 *
 * Returns { country, raw, source } where source is 'question' (a country
 * question answered), 'answers' (recovered by scanning), or 'none' (the form
 * named no country anywhere — a human must look, see country_unknown).
 */
// Which fact did the question we matched actually ask about? 'registration' can justify
// a decline; 'training' can only promote. See REGISTRATION_QUESTION_KEY_HINTS.
function countryQuestionKind(map) {
  const fields = map && typeof map === 'object' ? map : {};
  for (const key of Object.keys(fields)) {
    if (REGISTRATION_QUESTION_KEY_HINTS.some((h) => key.includes(h))) return 'registration';
  }
  for (const key of Object.keys(fields)) {
    if (TRAINING_QUESTION_KEY_HINTS.some((h) => key.includes(h))) return 'training';
  }
  return 'none';
}

function resolveFbLeadCountry(map) {
  const fields = map && typeof map === 'object' ? map : {};
  const questionKind = countryQuestionKind(fields);
  const keyed = String(_pickByKeySubstring(fields, COUNTRY_QUESTION_KEY_HINTS) || '').trim();
  const keyedCountry = parseCountryAnswer(keyed);
  if (keyedCountry !== 'other') return { country: keyedCountry, raw: keyed, source: 'question', recognised: true, questionKind };

  for (const key of Object.keys(fields)) {
    if (_isFbContactKey(key)) continue;
    const val = String(fields[key] == null ? '' : fields[key]).trim();
    if (!val) continue;
    const parsed = parseCountryAnswer(val);
    if (parsed !== 'other') return { country: parsed, raw: val, source: 'answers', recognised: true, questionKind };
  }

  // Nothing anywhere named a country we serve. Two very different situations share
  // this branch, and they must NOT share an outcome:
  //   - they answered with somewhere we recognise and don't serve ("Australia",
  //     or the form's own "Other" option) — that is a real decision they made
  //   - they answered something we could not read (a slug, a hospital, a city, a
  //     language we don't match) — that is OUR failure, not their ineligibility
  // `recognised` carries that apart so buildConsultLeadRow can decline only the
  // first. See isRecognisedCountryAnswer.
  return {
    country: 'other',
    raw: keyed,
    source: keyed ? 'question' : 'none',
    recognised: isRecognisedCountryAnswer(keyed),
    questionKind
  };
}

function normalizeFacebookGpLead(body, allowedFormIds) {
  const allowed = Array.isArray(allowedFormIds) ? allowedFormIds : [];
  if (allowed.length === 0 || !body || typeof body !== 'object') return null;

  let formId = '';
  let adId = '';
  let leadId = '';
  let name = '';
  let email = '';
  let phone = '';
  let isGpRaw = '';
  let countryRaw = '';
  let countrySource = 'none';
  let country = 'other';
  let countryRecognised = false;
  let fieldNames = [];
  let question = '';

  const nativeValue = body.entry && body.entry[0] && body.entry[0].changes &&
    body.entry[0].changes[0] && body.entry[0].changes[0].value;

  if (nativeValue && typeof nativeValue === 'object' && nativeValue.field_data) {
    formId = String(nativeValue.form_id || '');
    adId = String(nativeValue.ad_id || '');
    leadId = String(nativeValue.leadgen_id || '');
    const map = _fbFieldMap(nativeValue.field_data);
    name = _pickByKeySubstring(map, ['full_name']) || '';
    email = map.email || _pickByKeySubstring(map, ['email']) || '';
    phone = _pickByKeySubstring(map, ['phone_number', 'phone']) || '';
    isGpRaw = _pickByKeySubstring(map, ['registered_gp', 'is_gp', 'are_you_a_gp']);
    // Read from the answers, never from the question's name alone —
    // resolveFbLeadCountry explains why that distinction cost us a real doctor.
    const resolvedCountry = resolveFbLeadCountry(map);
    countryRaw = resolvedCountry.raw;
    countrySource = resolvedCountry.source;
    country = resolvedCountry.country;
    countryRecognised = resolvedCountry.recognised === true;
    fieldNames = Object.keys(map);
    question = _pickByKeySubstring(map, ['question', 'anything']) || '';
  } else {
    // Flat relay shape (Zapier-style): fields at the top level.
    formId = String(body.form_id || '');
    adId = String(body.ad_id || '');
    leadId = String(body.lead_id != null ? body.lead_id : (body.id || ''));
    name = String(body.full_name || body.name || '');
    email = String(body.email || '');
    phone = String(body.phone || body.phone_number || '');
    isGpRaw = body.is_gp;
    // 🧨 This branch used to read ONLY body.country, so none of the hardening the
    // native branch got applied here: rename that one relay field and every lead in
    // the campaign silently becomes country 'other'. Run the same resolver over the
    // whole flat body so a country stated in any other field is still found.
    const flatMap = {};
    Object.keys(body || {}).forEach((k) => {
      const v = body[k];
      if (v == null || typeof v === 'object') return;
      flatMap[String(k).toLowerCase()] = String(v);
    });
    const flatResolved = resolveFbLeadCountry(flatMap);
    countryRaw = flatResolved.raw || String(body.country == null ? '' : body.country).trim();
    country = flatResolved.country;
    countrySource = flatResolved.source;
    countryRecognised = flatResolved.recognised === true;
    question = String(body.question || '');
  }

  if (!formId || !allowed.includes(formId)) return null;
  email = email.trim();
  if (!email) return null;
  if (!leadId) {
    leadId = 'sha1:' + crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex');
  }

  // Strip <, >, & from freeform fields — buildCareerEmailHtml switches to
  // raw-HTML mode the moment a body contains a tag, so an attacker-supplied
  // "<b>evil</b>" in name/question would otherwise bypass escaping in the
  // magic-link/nudge emails built from this lead.
  return {
    leadId,
    formId,
    adId,
    name: name.trim().replace(/[<>&]/g, '').slice(0, 200),
    email: email.slice(0, 200),
    phone: phone.trim().slice(0, 40),
    isGp: parseYesNo(isGpRaw),
    country,
    // What they actually typed/picked, and how we got to it. Both are stored on
    // the lead so a human reading the alert sees "United Kingdom", not a bare
    // 'other', and so the next parsing mystery is one query away instead of
    // unreadable (the GP branch keeps no raw payload).
    countryRaw: String(countryRaw || '').replace(/[<>&]/g, '').slice(0, 200),
    countrySource,
    // Did they NAME somewhere (served or not), or did we just fail to read them?
    // buildConsultLeadRow declines only on the former. See isRecognisedCountryAnswer.
    countryRecognised,
    fieldNames: fieldNames.slice(0, 40),
    question: question.trim().replace(/[<>&]/g, '').slice(0, 2000),
  };
}

// 🧨 2026-08-18: every one of the original three names the question the live form
// STOPPED asking. The new one-question form's only qualifying key is
// `_where_did_you_complete_your_gp_training?`, which matches none of them — so the
// guard below went blind to precisely the form it now exists to protect, and a
// doctor from an un-allow-listed form would have gone straight down the practice
// path again. The training hints are reused from resolveFbLeadCountry so the two
// lists cannot drift apart.
//
// `training` is deliberately broad. A practice enquiry that happens to mention it
// gets REFUSED and shouted about rather than silently processed — visible and
// recoverable, where the failure it replaces (a doctor filed as a clinic named
// after herself, and emailed a practice-intake link) is neither.
const _GP_SCREENING_KEY_HINTS = ['registered_gp', 'is_gp', 'are_you_a_gp']
  .concat(TRAINING_QUESTION_KEY_HINTS);
const _PRACTICE_KEY_HINTS = ['practice_name', 'company_name', 'gp_needed_by', 'dpa'];

/**
 * Does this Meta payload look like a DOCTOR answering our GP form?
 *
 * 🧨 A GP form whose id is missing from FB_GP_LEAD_FORM_IDS does not just fail
 * to become a consult lead — it falls through to the practice pipeline, whose
 * parser takes `practice_name` from `full_name` when no practice field exists.
 * The doctor is filed as a clinic named after herself AND emailed a
 * "complete your practice intake" link. The funnel looks healthy from the
 * outside: a row was created, an email went out, nothing errored.
 *
 * So before falling through, ask whether the answers look like a doctor's. If
 * they do, refuse the practice path and shout instead — the form id is a
 * one-line env fix, but only if somebody is told.
 */
function looksLikeGpLeadForm(fieldData) {
  const keys = (Array.isArray(fieldData) ? fieldData : [])
    .map((f) => (f && f.name ? String(f.name).toLowerCase() : ''))
    .filter(Boolean);
  if (!keys.length) return false;
  const hasGpScreening = keys.some((k) => _GP_SCREENING_KEY_HINTS.some((h) => k.includes(h)));
  // A real practice enquiry names a practice. If one does, believe it — a
  // clinic asking about GPs may well mention "GP" in its own questions.
  const hasPracticeField = keys.some((k) => _PRACTICE_KEY_HINTS.some((h) => k.includes(h)));
  return hasGpScreening && !hasPracticeField;
}

const _EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONSULT_COUNTRY_INPUTS = ['uk', 'ie', 'nz', 'au', 'other'];

function validateConsultLeadPayload(body) {
  const raw = body && typeof body === 'object' ? body : {};
  // Strip <, >, & — see the matching comment in normalizeFacebookGpLead for
  // why (raw-HTML mode in buildCareerEmailHtml would otherwise let a
  // "<b>evil</b>" name/question through unescaped into lead-facing emails).
  const name = String(raw.name || '').trim().replace(/[<>&]/g, '').slice(0, 200);
  if (!name) return { ok: false, error: 'name is required.' };
  const email = String(raw.email || '').trim().slice(0, 200);
  if (!email || !_EMAIL_RE.test(email)) return { ok: false, error: 'a valid email is required.' };
  const phone = String(raw.phone || '').trim().slice(0, 40);
  // 📞 Phone is REQUIRED for anyone booking a call (owner, 2026-08-19). A
  // consultant ringing a doctor beats waiting on email, and a real placed GP booked
  // with no number at all. The waitlist row is the ONE exception: "keep me posted
  // when you support my country" collects an email and nothing else, and must not 400.
  //
  // 🛑 A phone number NEVER decides eligibility. countryFromPhone only ever
  // RESCUES an answer we could not read — it cannot unqualify anyone — so a UK-trained
  // GP calling from a +61 or +91 number still qualifies on her answer. Pinned by tests.
  // Do not "tidy" this into a dialling-code eligibility check.
  if (raw.waitlist !== true && !phone) return { ok: false, error: 'phone is required.' };
  // isGp is OPTIONAL as of 2026-08-18. The /start form stopped asking "are you a
  // currently registered GP?" — it now asks only where they completed their GP
  // TRAINING, which is the fact that governs eligibility anyway. Absent means
  // "not asked", which is NOT the same as "no": it stays null so screenConsultLead
  // falls through to the country answer, and so nothing downstream can read a
  // question we never put to them as a denial. An explicit boolean is still
  // honoured — the turndown's "keep me posted" row posts isGp:false on purpose.
  if (raw.isGp != null && typeof raw.isGp !== 'boolean') {
    return { ok: false, error: 'isGp must be true or false.' };
  }
  const isGp = typeof raw.isGp === 'boolean' ? raw.isGp : null;
  const country = String(raw.country || '').trim().toLowerCase();
  if (!CONSULT_COUNTRY_INPUTS.includes(country)) {
    return { ok: false, error: 'country must be one of: uk, ie, nz, au, other.' };
  }
  const question = String(raw.question || '').trim().replace(/[<>&]/g, '').slice(0, 2000);
  return { ok: true, value: { name, email, phone, isGp, country, question } };
}

function _sentSet(nudges) {
  const sent = {};
  (Array.isArray(nudges) ? nudges : []).forEach((n) => {
    if (n && n.seq != null && n.step != null) sent[n.seq + ':' + n.step] = true;
  });
  return sent;
}

// When the most recent step of `seq` went out, or NaN when no step of that
// sequence carries a readable sent_at (older rows recorded steps without one).
function _lastSentMs(nudges, seq) {
  let last = NaN;
  (Array.isArray(nudges) ? nudges : []).forEach((n) => {
    if (!n || n.seq !== seq) return;
    const t = Date.parse(String(n.sent_at || ''));
    if (isFinite(t) && (!isFinite(last) || t > last)) last = t;
  });
  return last;
}

// The channels a not_booked step carries, for the cron. booked_no_signup steps
// are email-only and return { email: true, wa: null }.
function consultNudgeStepSpec(seq, step) {
  const schedule = CONSULT_NUDGE_SCHEDULE_MS[seq];
  const spec = schedule && schedule[step];
  if (!spec) return null;
  if (seq === 'not_booked') return { email: spec.email !== false, wa: spec.wa || null };
  return { email: true, wa: null };
}

function nextConsultNudge(input) {
  const consult = (input && input.consult) || {};
  if (consult.stopped || consult.unsubscribed || consult.screened_out) return null;
  const nowMs = Number(input && input.nowMs);
  const createdAtMs = Number(input && input.createdAtMs);
  if (!isFinite(nowMs) || !isFinite(createdAtMs)) return null;
  const sent = _sentSet(consult.nudges);
  const booked = !!consult.call_booked;
  const seq = booked ? 'booked_no_signup' : 'not_booked';
  // The unqualified gate applies to the not_booked funnel ONLY. A booked lead has
  // shown the strongest intent there is — they picked a call time — so they get the
  // signup drip regardless of screening (that's how direct/never-screened bookers
  // like a raw-Calendly booking are reached). screened_out (an explicit "not a GP")
  // still stops them above.
  if (!booked && consult.qualified === false) return null;

  const schedule = CONSULT_NUDGE_SCHEDULE_MS[seq];
  if (booked) {
    // Per-step anchors: 'booked' → when they booked; 'call' → the slot time
    // (scheduled_at via callAtMs); 'completed' → when the call actually ended
    // (scheduled_calls.completed_at via callCompletedMs, our attendance signal).
    // An unknown anchor DEFERS every step that needs it instead of falling
    // back to an earlier time: these steps say "great speaking with you" /
    // "your roadmap is built", and a booking-time fallback once fired them
    // BEFORE the call had happened (a direct Calendly booker who booked a slot
    // 3 days out was told the consultation was over ~20h after booking).
    // Deferring is the safe direction — the Zoom webhook stamps the completion
    // the moment the call ends and the cron recovers it from scheduled_calls,
    // so the only leads that stay deferred are those whose call never happened.
    const bookedAtMs = Date.parse(consult.call_booked_at || '') || createdAtMs;
    const callAtMs = Number(input && input.callAtMs);
    const callAtKnown = isFinite(callAtMs);
    const completedMs = Number(input && input.callCompletedMs);
    const completedKnown = isFinite(completedMs);
    const lastSentMs = _lastSentMs(consult.nudges, seq);
    for (let i = 0; i < schedule.length; i++) {
      if (sent[seq + ':' + i]) continue;
      const anchor = schedule[i].anchor;
      if (anchor === 'call' && !callAtKnown) return null;        // no slot time ⇒ nothing after it is due
      if (anchor === 'completed' && !completedKnown) return null; // call not (verifiably) happened ⇒ nothing "after your call" is due
      const anchorMs = anchor === 'call' ? callAtMs : anchor === 'completed' ? completedMs : bookedAtMs;
      if (nowMs - anchorMs < schedule[i].after) return null; // absolute due times ascend (completed ≥ booking) — first unsent not due ⇒ nothing due
      // Weekly touches never bunch up on a lead being caught up on (see the
      // not_booked floors above); the instant post-call touch has no floor.
      const floorMs = Number(schedule[i].gapBefore) > 0 ? Number(schedule[i].gapBefore) : 0;
      if (i > 0 && floorMs && isFinite(lastSentMs) && nowMs - lastSentMs < floorMs) return null;
      return { seq, step: i };
    }
    return null;
  }
  const anchorMs = createdAtMs;
  const lastSentMs = _lastSentMs(consult.nudges, seq);
  for (let i = 0; i < schedule.length; i++) {
    if (sent[seq + ':' + i]) continue;
    if (nowMs - anchorMs < schedule[i].after) return null; // ascending thresholds: first unsent not yet due -> nothing due
    // Catch-up spacing: a step that became due while an earlier one was still
    // going out waits for its floor (schedule gapBefore, else
    // CONSULT_NUDGE_MIN_GAP_MS). A step with no readable sent_at cannot be
    // spaced against, so it never blocks.
    const floorMs = Number(schedule[i].gapBefore) > 0 ? Number(schedule[i].gapBefore) : CONSULT_NUDGE_MIN_GAP_MS;
    if (i > 0 && isFinite(lastSentMs) && nowMs - lastSentMs < floorMs) return null;
    return { seq, step: i, email: schedule[i].email !== false, wa: schedule[i].wa || null };
  }
  return null;
}

// WhatsApp legs still owed on recorded not_booked steps: the step is on the
// record (its email went, or it was WhatsApp-only and came due) but the template
// send has neither succeeded (consult.wa[kind]) nor been ruled out
// (consult.wa_skipped[kind] — no phone, feature off, …). A template pending
// WhatsApp approval or a DoubleTick outage lands here; the cron retries the
// most recent one for CONSULT_WA_RETRY_WINDOW_MS after the step, then lets it go.
// Returned oldest-first, so the last element is the copy the doctor should get.
const CONSULT_WA_RETRY_WINDOW_MS = 3 * DAY;
function pendingConsultWaKinds(consult, nowMs) {
  const c = consult || {};
  if (c.call_booked || c.stopped || c.screened_out) return [];
  const wa = c.wa && typeof c.wa === 'object' ? c.wa : {};
  const skipped = c.wa_skipped && typeof c.wa_skipped === 'object' ? c.wa_skipped : {};
  const now = Number(nowMs);
  const out = [];
  (Array.isArray(c.nudges) ? c.nudges : []).forEach((n) => {
    if (!n || n.seq !== 'not_booked') return;
    const spec = CONSULT_NUDGE_SCHEDULE_MS.not_booked[n.step];
    if (!spec || !spec.wa) return;
    if (wa[spec.wa] || skipped[spec.wa]) return;
    // The retired chase already settled this step (sent or ruled out) before
    // the switch-over — the new copy is not owed on top of it.
    const legacy = LEGACY_NOT_BOOKED_WA_KINDS[n.step];
    if (legacy && (wa[legacy] || skipped[legacy])) return;
    const t = Date.parse(String(n.sent_at || ''));
    if (!isFinite(t) || !isFinite(now) || now - t > CONSULT_WA_RETRY_WINDOW_MS) return;
    if (out.indexOf(spec.wa) === -1) out.push(spec.wa);
  });
  return out;
}

// True once every step of the CURRENTLY APPLICABLE sequence has been sent —
// "currently applicable" because call_booked can flip a lead from not_booked
// to booked_no_signup mid-flight (nextConsultNudge does the same check), so a
// finished not_booked run does NOT count as exhausted once booked_no_signup
// becomes the active sequence. Consumed by the consult-nudge cron to write a
// terminal 'exhausted' stop instead of re-scanning (and, in Supabase mode,
// re-querying) a quiet lead forever.
function isConsultExhausted(consult) {
  const c = consult || {};
  const sent = _sentSet(c.nudges);
  const seq = c.call_booked ? 'booked_no_signup' : 'not_booked';
  const schedule = CONSULT_NUDGE_SCHEDULE_MS[seq];
  for (let i = 0; i < schedule.length; i++) {
    if (!sent[seq + ':' + i]) return false;
  }
  return true;
}

// Should the owner be paged about this lead right now? Pure; the cron supplies
// the row's times and consult state and gets back a skip (with a reason) or a
// send. Rules, from the owner (2026-09-30): "if a lead has not booked 20 minutes
// after the hourly WhatsApp, message me their name, answers and phone number".
//   - once per lead (consult.owner_alert is the marker, stamped by the sender);
//   - never for a booked lead, a lead the funnel did not admit, or a lead
//     stopped for any reason EXCEPT 'replied' — a doctor who wrote back is
//     precisely who the owner wants to pick up, so 'replied' still pages;
//   - anchored on when the 1-hour note actually went out (falls back to the
//     scheduled hour if that step never recorded), plus 20 minutes;
//   - only inside CONSULT_OWNER_ALERT_WINDOW_MS of the lead's creation.
function consultOwnerAlertDecision(input) {
  const consult = (input && input.consult) || {};
  const nowMs = Number(input && input.nowMs);
  const createdAtMs = Number(input && input.createdAtMs);
  if (!isFinite(nowMs) || !isFinite(createdAtMs)) return { action: 'skip', reason: 'bad_input' };
  if (consult.owner_alert) return { action: 'skip', reason: 'already_sent' };
  if (consult.call_booked) return { action: 'skip', reason: 'booked' };
  if (consult.screened_out || consult.qualified !== true) return { action: 'skip', reason: 'not_qualified' };
  if (consult.stopped && consult.stopped !== 'replied') return { action: 'skip', reason: 'stopped' };
  if (nowMs - createdAtMs > CONSULT_OWNER_ALERT_WINDOW_MS) return { action: 'skip', reason: 'too_old' };
  const stepEntry = (Array.isArray(consult.nudges) ? consult.nudges : [])
    .find((n) => n && n.seq === 'not_booked' && n.step === CONSULT_OWNER_ALERT_STEP);
  const stepSentMs = stepEntry ? Date.parse(String(stepEntry.sent_at || '')) : NaN;
  const anchorMs = isFinite(stepSentMs)
    ? stepSentMs
    : createdAtMs + CONSULT_NUDGE_SCHEDULE_MS.not_booked[CONSULT_OWNER_ALERT_STEP].after;
  if (nowMs - anchorMs < CONSULT_OWNER_ALERT_AFTER_STEP_MS) return { action: 'skip', reason: 'not_yet' };
  return { action: 'send', replied: consult.stopped === 'replied' };
}

// The lead's details for the owner's page, as four single-line strings (a
// WhatsApp template variable may not contain a line break, and the four
// together must stay well inside the template's length limit). Pure.
function consultOwnerAlertSummary(row, opts) {
  const r = row || {};
  const consult = (r.metadata && r.metadata.consult) || {};
  const nowMs = Number(opts && opts.nowMs) || Date.now();
  const oneLine = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const name = oneLine(r.name, 80) || 'Unknown name';
  const phone = oneLine(r.phone, 30) || 'no phone on the lead';
  const parts = [];
  const countryRaw = oneLine(consult.country_raw, 60);
  const country = countryRaw || (consult.country && consult.country !== 'other' ? String(consult.country).toUpperCase() : '');
  if (country) parts.push('Country: ' + country);
  if (consult.is_gp === true) parts.push('Registered GP: yes');
  else if (consult.is_gp === false) parts.push('Registered GP: no');
  const asked = oneLine(r.message || consult.call_question, 160);
  if (asked) parts.push('They asked: ' + asked);
  const email = oneLine(r.email, 80);
  if (email) parts.push('Email: ' + email);
  const answers = parts.join(' · ') || 'no answers recorded';
  const createdMs = Date.parse(String(r.created_at || ''));
  const ageMin = isFinite(createdMs) ? Math.max(0, Math.round((nowMs - createdMs) / MINUTE)) : NaN;
  const age = !isFinite(ageMin) ? 'a while'
    : ageMin >= 60 ? Math.floor(ageMin / 60) + 'h ' + (ageMin % 60) + 'm'
      : ageMin + 'm';
  const replied = consult.stopped === 'replied';
  const status = 'No booking ' + age + ' after the form'
    + (replied ? ', but they replied on WhatsApp — pick up the chat' : ', and no reply yet');
  return { name, phone, answers, status: status.slice(0, 200) };
}

// Plain-text bodies; buildCareerEmailHtml wraps them (it auto-formats
// paragraphs when the body has no HTML tags).
function consultNudgeCopy(seq, step, opts) {
  const displayName = (opts && opts.displayName) || 'there';
  const bookUrl = (opts && opts.bookUrl) || '';
  const signupUrl = (opts && opts.signupUrl) || '';
  if (seq === 'not_booked') {
    // Owner rule 2026-09-30: short, first person, one ask, never a "final
    // nudge". Step 0 is WhatsApp-only in the schedule; its email copy exists so
    // the step is complete if that ever changes.
    if (step === 0) {
      return {
        subject: 'Saw your form come through',
        title: 'Thanks for reaching out',
        body: 'Hi ' + displayName + ',\n\nKhaleed here from GP Link. I just saw your form come through - thank you.\n\nI help UK GPs work out whether a move to Australia is realistic for them, and I\'d rather have a proper chat than send you a brochure. If it\'s easier, pick a time that suits you below.\n\nOne quick question so I can point you the right way: are you thinking this year, or next?',
        ctaText: 'Pick a time',
        ctaUrl: bookUrl,
      };
    }
    if (step === 1) {
      return {
        subject: 'Quick one from me at GP Link',
        title: 'No pressure at all',
        body: 'Hi ' + displayName + ',\n\nKhaleed again. I know a form is easy to fill in on the way to something else, so no pressure at all.\n\nIf it helps, just reply with the one thing you\'d most want answered about moving to Australia - registration, the visa, money, timing, family - and I\'ll answer it myself.\n\nOr, if you\'d rather cover it all in one go, grab a time below. Thirty minutes, free, no obligation.',
        ctaText: 'Book a time',
        ctaUrl: bookUrl,
      };
    }
    return {
      subject: 'Last note from me',
      title: 'Whenever the time is right',
      body: 'Hi ' + displayName + ',\n\nLast note from me, I promise.\n\nIf Australia is a someday thing rather than a right-now thing, that\'s completely fine - I\'m happy to leave it here. If you do want to talk it through at some point, you can book straight in whenever suits you, and you\'re always welcome to just reply to this email.\n\nEither way, I hope the week is treating you kindly.\n\nKhaleed',
      ctaText: 'Book a time',
      ctaUrl: bookUrl,
    };
  }
  // booked_no_signup copy ("grab another time") needs the actual booking
  // link, not just the words — pass bookUrl through as the secondary CTA on
  // both steps of this sequence (buildCareerEmailHtml renders it as a
  // second, lower-emphasis button under the primary signup CTA).
  if (step === 0) {
    return {
      subject: 'Ready to get started with GP Link?',
      title: 'Your next step takes two minutes',
      body: 'Hi ' + displayName + ',\n\nThanks for booking a call with us. The next step is creating your free GP Link account - it takes about two minutes, and it\'s where your whole journey to practising in Australia gets tracked: registration, visa, placement, all of it.\n\nIf we missed each other on the call, no stress - you can grab another time using your booking link, or just reply to this email.',
      ctaText: 'Create my free account',
      ctaUrl: signupUrl,
      secondaryCtaText: 'Grab another call time',
      secondaryCtaUrl: bookUrl,
    };
  }
  return {
    subject: 'Your place in the GP Link app is still open',
    title: 'Whenever you\'re ready',
    body: 'Hi ' + displayName + ',\n\nJust one last note from us. Creating your free account is the step that makes things real - you\'ll see your personal pathway to practising in Australia, and our team starts working on your behalf.\n\nIf the timing isn\'t right, no problem at all - we\'ll leave you be. And if we missed each other on the call, you\'re always welcome to grab another time.',
    ctaText: 'Create my free account',
    ctaUrl: signupUrl,
    secondaryCtaText: 'Grab another call time',
    secondaryCtaUrl: bookUrl,
  };
}

function consultDisplayName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return 'there';
  const parts = trimmed.split(/\s+/);
  return 'Dr ' + parts[parts.length - 1];
}

module.exports = {
  SUPPORTED_CONSULT_COUNTRIES,
  CONSULT_NUDGE_SCHEDULE_MS,
  CONSULT_NUDGE_MIN_GAP_MS,
  CONSULT_WA_RETRY_WINDOW_MS,
  CONSULT_OWNER_ALERT_STEP,
  CONSULT_OWNER_ALERT_AFTER_STEP_MS,
  CONSULT_OWNER_ALERT_WINDOW_MS,
  consultOwnerAlertDecision,
  consultOwnerAlertSummary,
  consultNudgeStepSpec,
  pendingConsultWaKinds,
  screenConsultLead,
  generateConsultToken,
  parseGpFormIds,
  parseYesNo,
  parseCountryAnswer,
  isRecognisedCountryAnswer,
  countryQuestionKind,
  countryFromPhone,
  RECOGNISED_UNSERVED_COUNTRY_HINTS,
  resolveFbLeadCountry,
  looksLikeGpLeadForm,
  normalizeFacebookGpLead,
  validateConsultLeadPayload,
  nextConsultNudge,
  isConsultExhausted,
  consultNudgeCopy,
  consultDisplayName,
};

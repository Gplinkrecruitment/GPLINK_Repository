// lib/consult-lead.js — pure decision logic for the Meta-ads GP consult funnel.
// No I/O beyond crypto randomness. Consumed by server.js (endpoints, FB webhook
// GP branch, consult-nudge cron). See docs/superpowers/specs/2026-07-14-meta-ads-gp-funnel-design.md.
'use strict';

const crypto = require('crypto');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const SUPPORTED_CONSULT_COUNTRIES = ['uk', 'ie', 'nz'];

// Sequence A (not_booked) anchors at lead creation — a plain [ms, ms] array.
// Sequence B (booked_no_signup) is the post-booking signup drip: 5 touches with
// per-step anchors — step 0 right after booking, then the rest anchored on the
// CALL time (scheduled_at) so "after your call" copy never lands before the call.
// Entries are { anchor: 'booked'|'call', after: ms }. See
// docs/superpowers/specs/2026-07-25-booker-signup-nudge-and-backfill-design.md.
// The magic link goes out on qualification (see the FB webhook), so both of
// these touches are chases, not the first contact. 2h leaves room for someone
// who is still deciding; 48h is the final one and says so.
const CONSULT_NUDGE_SCHEDULE_MS = {
  not_booked: [2 * HOUR, 48 * HOUR],
  booked_no_signup: [
    { anchor: 'booked', after: 0 },          // touch 1 — right after booking
    { anchor: 'call', after: 20 * HOUR },    // touch 2 — day after the call
    { anchor: 'call', after: 7 * DAY },      // touch 3 — week 1
    { anchor: 'call', after: 14 * DAY },     // touch 4 — week 2
    { anchor: 'call', after: 21 * DAY },     // touch 5 — week 3 (final)
  ],
};

function screenConsultLead(input) {
  const isGp = !!(input && input.isGp === true);
  const country = String((input && input.country) || '').toLowerCase();
  return isGp && SUPPORTED_CONSULT_COUNTRIES.includes(country);
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
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!v) return null;
  if (/^y(es)?\b/.test(v) || v === 'true') return true;
  if (/^no?\b/.test(v) || v === 'false') return false;
  return null;
}

function parseCountryAnswer(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!v) return 'other';
  if (v.includes('northern ireland')) return 'uk'; // before the 'ireland' check
  if (v.includes('united kingdom') || /\buk\b/.test(v) || v.includes('britain') || v.includes('england') || v.includes('scotland') || v.includes('wales')) return 'uk';
  if (v.includes('ireland') || /\bie\b/.test(v)) return 'ie';
  if (v.includes('new zealand') || /\bnz\b/.test(v)) return 'nz';
  return 'other';
}

// Meta lead-gen field_data is [{ name, values: [...] }]. Custom questions get
// snake_cased keys; match by substring so form wording tweaks don't break us.
function _fbFieldMap(fieldData) {
  const map = {};
  (Array.isArray(fieldData) ? fieldData : []).forEach((f) => {
    if (!f || !f.name) return;
    const key = String(f.name).toLowerCase();
    const val = Array.isArray(f.values) ? String(f.values[0] == null ? '' : f.values[0]) : '';
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
const COUNTRY_QUESTION_KEY_HINTS = [
  'where_are_you_registered', 'registration_country', 'country',
  'gp_training', 'training', 'where_did_you_complete', 'trained'
];

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
function resolveFbLeadCountry(map) {
  const fields = map && typeof map === 'object' ? map : {};
  const keyed = String(_pickByKeySubstring(fields, COUNTRY_QUESTION_KEY_HINTS) || '').trim();
  const keyedCountry = parseCountryAnswer(keyed);
  if (keyedCountry !== 'other') return { country: keyedCountry, raw: keyed, source: 'question' };

  for (const key of Object.keys(fields)) {
    if (_isFbContactKey(key)) continue;
    const val = String(fields[key] == null ? '' : fields[key]).trim();
    if (!val) continue;
    const parsed = parseCountryAnswer(val);
    if (parsed !== 'other') return { country: parsed, raw: val, source: 'answers' };
  }

  // Nothing anywhere named a country. If they DID answer a country question we
  // keep their words (so the alert can show "India" rather than a bare 'other');
  // if we never even found the question, say so — that is our failure, not their
  // ineligibility, and the two must not look the same to whoever reads the alert.
  return { country: 'other', raw: keyed, source: keyed ? 'question' : 'none' };
}

function normalizeFacebookGpLead(body, allowedFormIds) {
  const allowed = Array.isArray(allowedFormIds) ? allowedFormIds : [];
  if (allowed.length === 0 || !body || typeof body !== 'object') return null;

  let formId = '';
  let leadId = '';
  let name = '';
  let email = '';
  let phone = '';
  let isGpRaw = '';
  let countryRaw = '';
  let countrySource = 'none';
  let country = 'other';
  let fieldNames = [];
  let question = '';

  const nativeValue = body.entry && body.entry[0] && body.entry[0].changes &&
    body.entry[0].changes[0] && body.entry[0].changes[0].value;

  if (nativeValue && typeof nativeValue === 'object' && nativeValue.field_data) {
    formId = String(nativeValue.form_id || '');
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
    fieldNames = Object.keys(map);
    question = _pickByKeySubstring(map, ['question', 'anything']) || '';
  } else {
    // Flat relay shape (Zapier-style): fields at the top level.
    formId = String(body.form_id || '');
    leadId = String(body.lead_id != null ? body.lead_id : (body.id || ''));
    name = String(body.full_name || body.name || '');
    email = String(body.email || '');
    phone = String(body.phone || body.phone_number || '');
    isGpRaw = body.is_gp;
    countryRaw = String(body.country == null ? '' : body.country).trim();
    country = parseCountryAnswer(countryRaw);
    countrySource = countryRaw ? 'question' : 'none';
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
    fieldNames: fieldNames.slice(0, 40),
    question: question.trim().replace(/[<>&]/g, '').slice(0, 2000),
  };
}

const _GP_SCREENING_KEY_HINTS = ['registered_gp', 'is_gp', 'are_you_a_gp'];
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
const CONSULT_COUNTRY_INPUTS = ['uk', 'ie', 'nz', 'other'];

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
  if (typeof raw.isGp !== 'boolean') return { ok: false, error: 'isGp must be true or false.' };
  const country = String(raw.country || '').trim().toLowerCase();
  if (!CONSULT_COUNTRY_INPUTS.includes(country)) {
    return { ok: false, error: 'country must be one of: uk, ie, nz, other.' };
  }
  const question = String(raw.question || '').trim().replace(/[<>&]/g, '').slice(0, 2000);
  return { ok: true, value: { name, email, phone, isGp: raw.isGp, country, question } };
}

function _sentSet(nudges) {
  const sent = {};
  (Array.isArray(nudges) ? nudges : []).forEach((n) => {
    if (n && n.seq != null && n.step != null) sent[n.seq + ':' + n.step] = true;
  });
  return sent;
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
    // Per-step anchors: 'booked' → when they booked; 'call' → the call time
    // (scheduled_at via callAtMs). An unknown call time DEFERS every
    // call-anchored step instead of falling back to the booking time: these
    // steps say "after your call" / "that's the conversation done", and the
    // booking-time fallback fired them BEFORE the call had happened (a direct
    // Calendly booker who books a slot 3 days out was told the consultation
    // was over ~20h after booking). Deferring is the safe direction — the
    // cron backfills call_at from scheduled_calls, so the only leads that
    // stay deferred are those with no live call to be "after".
    const bookedAtMs = Date.parse(consult.call_booked_at || '') || createdAtMs;
    const callAtMs = Number(input && input.callAtMs);
    const callAtKnown = isFinite(callAtMs);
    for (let i = 0; i < schedule.length; i++) {
      if (sent[seq + ':' + i]) continue;
      const callAnchored = schedule[i].anchor === 'call';
      if (callAnchored && !callAtKnown) return null; // no call time ⇒ nothing after it is due
      const anchorMs = callAnchored ? callAtMs : bookedAtMs;
      if (nowMs - anchorMs >= schedule[i].after) return { seq, step: i };
      return null; // absolute due times ascend (call ≥ booking) — first unsent not due ⇒ nothing due
    }
    return null;
  }
  const anchorMs = createdAtMs;
  for (let i = 0; i < schedule.length; i++) {
    if (sent[seq + ':' + i]) continue;
    if (nowMs - anchorMs >= schedule[i]) return { seq, step: i };
    return null; // ascending thresholds: first unsent not yet due -> nothing due
  }
  return null;
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

// Plain-text bodies; buildCareerEmailHtml wraps them (it auto-formats
// paragraphs when the body has no HTML tags).
function consultNudgeCopy(seq, step, opts) {
  const displayName = (opts && opts.displayName) || 'there';
  const bookUrl = (opts && opts.bookUrl) || '';
  const signupUrl = (opts && opts.signupUrl) || '';
  if (seq === 'not_booked') {
    if (step === 0) {
      return {
        subject: 'Still want that chat about working in Australia?',
        title: 'Your free call is waiting',
        body: 'Hi ' + displayName + ',\n\nYou started booking a free 30-minute call with GP Link but didn\'t pick a time. No pressure at all - the offer stands whenever suits you.\n\nWe\'ll answer your questions about registration, visas, timing and pay - honestly, and without any commitment.\n\nIf you\'ve already booked, you can ignore this email.',
        ctaText: 'Pick a time',
        ctaUrl: bookUrl,
      };
    }
    return {
      subject: 'Your questions about Australia, answered in 30 minutes',
      title: 'Shall we find you a time?',
      body: 'Hi ' + displayName + ',\n\nJust a final nudge - you asked about working as a GP in Australia and we\'d love to walk you through how it actually works: the registration steps, how long it takes, and what life and pay look like on the other side.\n\nOne 30-minute call, no obligation. If now isn\'t the right time, that\'s completely fine - we won\'t keep emailing.',
      ctaText: 'Book your free call',
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
  screenConsultLead,
  generateConsultToken,
  parseGpFormIds,
  parseYesNo,
  parseCountryAnswer,
  resolveFbLeadCountry,
  looksLikeGpLeadForm,
  normalizeFacebookGpLead,
  validateConsultLeadPayload,
  nextConsultNudge,
  isConsultExhausted,
  consultNudgeCopy,
  consultDisplayName,
};

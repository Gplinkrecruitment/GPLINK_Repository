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
// not_booked[0] is the MAGIC LINK, not a chase. The Facebook thank-you screen
// sends a qualified GP straight to the booking page, so the webhook no longer
// emails them on arrival — this touch is what reaches anyone who left without
// picking a time. 45 minutes (not 2 hours) because the hourly cron rounds it
// up anyway, and a link that lands while the visit is still fresh converts.
const CONSULT_NUDGE_SCHEDULE_MS = {
  not_booked: [45 * MINUTE, 48 * HOUR],
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
    // "Where did you complete your GP training?" is a better eligibility
    // question than "where are you registered?" — a doctor who trained in the
    // UK and is currently registered elsewhere still holds the qualification
    // that matters. Its snake_cased key shares no substring with the
    // registration wording, so both phrasings are matched here; a form that
    // switches from one to the other must not silently start screening
    // everyone out.
    countryRaw = _pickByKeySubstring(map, [
      'where_are_you_registered', 'registration_country', 'country',
      'gp_training', 'training', 'where_did_you_complete', 'trained'
    ]);
    question = _pickByKeySubstring(map, ['question', 'anything']) || '';
  } else {
    // Flat relay shape (Zapier-style): fields at the top level.
    formId = String(body.form_id || '');
    leadId = String(body.lead_id != null ? body.lead_id : (body.id || ''));
    name = String(body.full_name || body.name || '');
    email = String(body.email || '');
    phone = String(body.phone || body.phone_number || '');
    isGpRaw = body.is_gp;
    countryRaw = body.country;
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
    country: parseCountryAnswer(countryRaw),
    question: question.trim().replace(/[<>&]/g, '').slice(0, 2000),
  };
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
  normalizeFacebookGpLead,
  validateConsultLeadPayload,
  nextConsultNudge,
  isConsultExhausted,
  consultNudgeCopy,
  consultDisplayName,
};

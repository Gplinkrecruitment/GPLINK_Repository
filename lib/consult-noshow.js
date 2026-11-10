// lib/consult-noshow.js
//
// The rescue for a doctor who booked the free consultation and did not join.
//
// Until 2026-11-10 a missed consultation ended in silence for every funnel
// lead: the no-show sweep's re-invite reads email and phone from an APP
// ACCOUNT (user_profiles by scheduled_calls.user_id), and a lead has none; the
// lead still read call_booked, so Hazel never rang again; and call_attended
// false defers every "after your call" touch. Of 24 no-shows on file, 2 ever
// re-booked.
//
// Now a missed slot leaves ONE marker on the lead:
//
//   consult.no_show = {
//     call_at,      the slot that was missed (the key: a later missed booking
//                   has a different call_at and gets its own rescue)
//     detected_at,  when we concluded nobody joined
//     via,          'sweep' (detect-no-shows) | 'zoom_participants' (meeting
//                   ended, the participant list had no doctor)
//     ring,         'pending' → 'placed' (Hazel's one call; consumed on placement)
//     email_at, wa_at, ring_at, email_tries, wa_tries
//   }
//
// and three things follow from it, each once: an email, a WhatsApp, and one
// call from Hazel. Everything here is pure; server.js does the I/O.
//
// The marker is only ever ACTED on while it still describes the lead:
//   - the doctor has not turned up after all (call_attended === true cancels),
//   - they have not re-booked (consult.call_at moved to another slot cancels),
//   - they have not told us to stop.
// So no path that books, completes or stops a lead has to remember to clear it.
'use strict';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// Never backfill: only slots at or after this instant are rescued. Everything
// missed before the feature shipped stays exactly as it was.
// CONSULT_NOSHOW_RESCUE_SINCE (an ISO instant) moves the gate without a code
// change; the route tests use it, because their slots are "an hour ago".
const CONSULT_NOSHOW_RESCUE_SINCE_MS = (function () {
  const fromEnv = Date.parse(String((typeof process !== 'undefined' && process.env && process.env.CONSULT_NOSHOW_RESCUE_SINCE) || ''));
  return Number.isFinite(fromEnv) ? fromEnv : Date.parse('2026-11-11T00:00:00Z');
})();

// The messages wait an hour from the slot's START. A verdict can arrive
// minutes after the slot (the host opened the room, waited, closed it) while
// the doctor is still on their way in; an hour is past the end of a call that
// started late, so "sorry we missed each other" can never land mid-call.
const NOSHOW_MESSAGE_AFTER_MS = 60 * MIN;
// …and are not worth sending once the moment has gone (a cron outage, a lead
// we could not reach for a day and a half).
const NOSHOW_MESSAGE_EXPIRES_MS = 36 * HOUR;
// Hazel rings an hour after the messages could first go, so the link has had
// its chance before the phone does.
const NOSHOW_RING_AFTER_MS = 2 * HOUR;
// Three days covers a Friday-evening miss into Monday's calling hours.
const NOSHOW_RING_EXPIRES_MS = 72 * HOUR;
// A send that keeps failing (template still awaiting approval, a dead
// address) is not retried for ever.
const NOSHOW_EMAIL_MAX_TRIES = 3;
const NOSHOW_WA_MAX_TRIES = 6;

// These stops mean "leave me alone" and silence every part of the rescue.
// 'exhausted' and 'replied' describe the email chase, and 'signed_up' is an
// account: none of them is a reason to ignore a call the doctor booked.
const NOSHOW_STOP_REASONS = ['unsubscribed', 'do_not_call', 'not_interested'];

function parseMs(v) {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? t : NaN;
}

// The team's own test rows: hello+x@ and every other mygplink.com.au address,
// Meta's form tester, and the owner's test GP account.
function isTestLeadEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  return /@mygplink\.com\.au$/.test(e) || /@meta\.com$/.test(e) || /^khaleedmahmoud/.test(e) || /@example\.(com|org|net)$/.test(e);
}

function noShowMarker(consult) {
  const m = consult && consult.no_show;
  return (m && typeof m === 'object' && !Array.isArray(m) && m.call_at) ? m : null;
}

function sameSlot(a, b) {
  const x = parseMs(a), y = parseMs(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

// A fresh marker for a slot just judged missed, or null when there is nothing
// to record: no slot time, a slot from before the gate, or this slot already
// has its marker (the sweep and the participant check can both conclude it).
function newNoShowMarker(input) {
  const consult = (input && input.consult) || {};
  const callAtMs = parseMs(input && input.callAtIso);
  if (!Number.isFinite(callAtMs)) return null;
  if (callAtMs < CONSULT_NOSHOW_RESCUE_SINCE_MS) return null;
  const existing = noShowMarker(consult);
  if (existing && sameSlot(existing.call_at, input.callAtIso)) return null;
  const nowIso = String((input && input.nowIso) || new Date().toISOString());
  // A slot still in the future cannot have been missed (a meeting opened and
  // closed early). The caller looks again when the slot has passed.
  if (callAtMs > parseMs(nowIso)) return null;
  return {
    call_at: new Date(callAtMs).toISOString(),
    detected_at: nowIso,
    via: String((input && input.via) || 'sweep'),
    ring: 'pending'
  };
}

// Does the marker still describe this lead? See the header.
function noShowRescueActive(consult) {
  const c = consult || {};
  const m = noShowMarker(c);
  if (!m) return false;
  if (parseMs(m.call_at) < CONSULT_NOSHOW_RESCUE_SINCE_MS) return false;
  if (c.call_attended === true) return false;                       // they joined after all
  if (c.call_at && !sameSlot(c.call_at, m.call_at)) return false;   // re-booked: a new slot is on the lead
  return true;
}

// What the cron should send right now. { email, wa, reason }.
// `row` is the site_enquiries row; `hasPhone` lets the caller say a WhatsApp
// number exists (the lead's own, or the one Calendly collected).
function noShowRescueDecision(input) {
  const row = (input && input.row) || {};
  const consult = (row.metadata && row.metadata.consult) || {};
  const nowMs = Number(input && input.nowMs) || Date.now();
  const none = (reason) => ({ email: false, wa: false, reason });
  const m = noShowMarker(consult);
  if (!m) return none('no_marker');
  if (!noShowRescueActive(consult)) return none('inactive');
  if (consult.stopped && NOSHOW_STOP_REASONS.indexOf(consult.stopped) !== -1) return none('stopped_' + consult.stopped);
  if (isTestLeadEmail(row.email)) return none('test_lead');
  const callAtMs = parseMs(m.call_at);
  if (nowMs < callAtMs + NOSHOW_MESSAGE_AFTER_MS) return none('too_soon');
  if (nowMs > callAtMs + NOSHOW_MESSAGE_EXPIRES_MS) return none('expired');
  const email = !m.email_at && !!String(row.email || '').trim() && consult.email_bounced !== true
    && (Number(m.email_tries) || 0) < NOSHOW_EMAIL_MAX_TRIES;
  const hasPhone = input && Object.prototype.hasOwnProperty.call(input, 'hasPhone') ? !!input.hasPhone : !!String(row.phone || '').trim();
  const wa = !m.wa_at && hasPhone && (Number(m.wa_tries) || 0) < NOSHOW_WA_MAX_TRIES;
  return { email, wa, reason: (email || wa) ? 'due' : 'done' };
}

// Hazel's one call after a missed consultation.
//   { state: 'none' }                       nothing owed
//   { state: 'wait', dueAtMs, callAtIso }   owed, not yet
//   { state: 'due',  dueAtMs, callAtIso }   ring now (hours permitting)
// Consent, pause, phone and calling hours are leadCallDecision's business.
function missedCallRing(input) {
  const consult = (input && input.consult) || {};
  const nowMs = Number(input && input.nowMs) || Date.now();
  const m = noShowMarker(consult);
  if (!m || m.ring !== 'pending' || !noShowRescueActive(consult)) return { state: 'none' };
  const callAtMs = parseMs(m.call_at);
  const dueAtMs = callAtMs + NOSHOW_RING_AFTER_MS;
  if (nowMs > callAtMs + NOSHOW_RING_EXPIRES_MS) return { state: 'none' };
  return { state: nowMs < dueAtMs ? 'wait' : 'due', dueAtMs, callAtIso: m.call_at };
}

// The marker after Hazel's call was placed (or refused for a reason that is
// about the doctor's number). Consumed either way so it can never loop.
function consumeMissedCallRing(consult, nowIso) {
  const m = noShowMarker(consult);
  if (!m || m.ring !== 'pending') return consult;
  return Object.assign({}, consult, { no_show: Object.assign({}, m, { ring: 'placed', ring_at: String(nowIso || new Date().toISOString()) }) });
}

// "Saturday 14 November at 10:00 am" in a zone.
function slotInWords(iso, tz) {
  const ms = parseMs(iso);
  if (!Number.isFinite(ms)) return '';
  let parts;
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true
    });
    parts = {};
    fmt.formatToParts(new Date(ms)).forEach((p) => { parts[p.type] = p.value; });
  } catch (e) { return ''; }
  const period = String(parts.dayPeriod || '').toLowerCase().replace(/\./g, '').trim();
  return parts.weekday + ' ' + parts.day + ' ' + parts.month + ' at ' + parts.hour + ':' + parts.minute + (period ? ' ' + period : '');
}

// The FACT Hazel is given when she rings (or is rung by) a doctor who missed
// their consultation. Facts and the purpose of the call only: how she says it
// is hers (owner rule 2026-11-08, no scripted lines). '' when nothing applies,
// so the prompt variable is always a string.
function missedCallNote(input) {
  const consult = (input && input.consult) || {};
  const nowMs = Number(input && input.nowMs) || Date.now();
  const m = noShowMarker(consult);
  if (!m || !noShowRescueActive(consult)) return '';
  const callAtMs = parseMs(m.call_at);
  if (nowMs > callAtMs + NOSHOW_RING_EXPIRES_MS) return '';
  const when = slotInWords(m.call_at, input && input.tz);
  const who = String((input && input.directorName) || '').trim() || 'our director';
  return 'They had a consultation booked with ' + who + (when ? ' for ' + when + ' (their time)' : '')
    + ' and did not join it. This call is to find a new time that suits them. They already know what GP Link is.';
}

// The email. First person from the owner, like every other consult note.
function noShowEmailCopy(input) {
  const displayName = String((input && input.displayName) || '').trim() || 'there';
  const when = String((input && input.whenText) || '').trim();
  const body = 'Hi ' + displayName + ',\n\n'
    + 'I had our call in the diary' + (when ? ' for ' + when : '') + ' and it looks like we missed each other. '
    + 'No problem at all, I know how quickly a clinic day can change.\n\n'
    + 'If you would still like to talk through the move to Australia, you can pick a new time below. It takes about 20 seconds.\n\n'
    + 'Or just reply to this email with a time that suits you and I will make it work.\n\n'
    + 'Khaleed\nCEO, GP Link';
  return {
    subject: 'Sorry we missed each other',
    title: 'Shall we find another time?',
    body,
    ctaText: 'Pick a new time'
  };
}

module.exports = {
  CONSULT_NOSHOW_RESCUE_SINCE_MS,
  NOSHOW_MESSAGE_AFTER_MS,
  NOSHOW_MESSAGE_EXPIRES_MS,
  NOSHOW_RING_AFTER_MS,
  NOSHOW_RING_EXPIRES_MS,
  NOSHOW_EMAIL_MAX_TRIES,
  NOSHOW_WA_MAX_TRIES,
  NOSHOW_STOP_REASONS,
  isTestLeadEmail,
  noShowMarker,
  newNoShowMarker,
  noShowRescueActive,
  noShowRescueDecision,
  missedCallRing,
  consumeMissedCallRing,
  slotInWords,
  missedCallNote,
  noShowEmailCopy
};

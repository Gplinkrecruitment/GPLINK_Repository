// lib/consult-whatsapp.js — pure decision logic for the consult-funnel WhatsApp
// follow-ups (DoubleTick). No I/O. Consumed by server.js (Calendly webhook,
// consult-nudge cron). Four touches, one per lead per kind, all sent as
// APPROVED WhatsApp templates (a first message to someone who has never
// messaged us MUST be a template — see ensureRsoWelcomeSent in server.js):
//
//   call_booked           — booking confirmation, sent when the Calendly webhook
//                           stamps the lead's call (ensureLeadBookedCallAt).
//   not_booked            — "pick a time" nudge with the tokenised booking link,
//                           sent alongside the FIRST due not_booked email touch.
//   signed_up             — welcome, sent when the consult-nudge cron flips the
//                           lead to stopped:'signed_up' (account detected).
//   onboarding_incomplete — sent once when a signed-up lead still has not
//                           completed onboarding 24h+ after signup.
//   call_reminder         — day-before reminder carrying the JOIN LINK.
//   call_starting         — "starting now, tap to join" with the join link.
//
// Sent-markers for the first four live in site_enquiries.metadata.consult.wa[kind]
// so a send can never repeat; the marker is only stamped AFTER a successful send,
// so a template that is still pending WhatsApp approval fails soft and the touch
// stays eligible (mirrors the RSO-welcome sentinel rule).
//
// The two call reminders are the exception: they are per-BOOKING, not per-lead
// (a lead who reschedules must be reminded again about the new slot), so their
// markers live on the scheduled_calls row instead — notification_channels
// .consult_reminders — and consultCallReminderDecision below owns the timing.
// The booking confirmation deliberately carries NO link: Calendly only mints the
// Zoom URL as it writes the row, and a link sent days early gets lost in the
// chat scrollback. The reminders are what actually get someone into the call.
'use strict';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Template names must match the DoubleTick dashboard EXACTLY.
const CONSULT_WA_TEMPLATES = {
  call_booked: { templateName: 'gp_link_consult_call_booked', language: 'en' },
  not_booked: { templateName: 'gp_link_consult_book_nudge', language: 'en' },
  signed_up: { templateName: 'gp_link_consult_signup_welcome', language: 'en' },
  onboarding_incomplete: { templateName: 'gp_link_consult_onboarding_nudge', language: 'en' },
  call_reminder: { templateName: 'gp_link_consult_call_reminder', language: 'en' },
  call_starting: { templateName: 'gp_link_consult_call_starting', language: 'en' }
};

// The two reminder kinds, keyed by the window they belong to. Kept as a map so
// the cron never has to translate a window name into a template kind by hand.
const CONSULT_CALL_REMINDER_KIND = { h24: 'call_reminder', soon: 'call_starting' };

// "Starting now" fires inside this window. The call-reminders cron runs every 5
// minutes, so 15 gives three chances to catch it — one skipped cron run still
// lands the message before the call begins.
const CALL_REMINDER_SOON_MS = 15 * 60 * 1000;
// The day-before reminder opens 24h out.
const CALL_REMINDER_DAY_MS = DAY;
// …but never within this long of the booking itself. Without it a lead who books
// a slot 20 hours away would get the confirmation and the "coming up" reminder
// back to back, which reads as a glitch.
const CALL_REMINDER_MIN_AFTER_BOOKING_MS = 2 * HOUR;
// The same idea for the starting-now touch, tighter: booking 12 minutes before a
// call is legitimate and that person genuinely needs the link, so only suppress
// a reminder that would land on top of its own confirmation.
const CALL_STARTING_MIN_AFTER_BOOKING_MS = 5 * 60 * 1000;

// Wait this long after signup before judging onboarding incomplete…
const ONBOARDING_NUDGE_AFTER_MS = 24 * HOUR;
// …and never open the nudge window for a signup older than this. Guards the
// rollout: historical signed_up leads (some months old) must not get a
// WhatsApp out of nowhere the hour this ships.
const ONBOARDING_NUDGE_WINDOW_MS = 14 * DAY;

function consultWaFirstName(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  return first || 'there';
}

// "Monday 24 August, 2:00 pm (UK time)" — leads are UK doctors, so the slot is
// rendered in Europe/London regardless of server timezone.
function formatConsultCallTime(iso) {
  const t = new Date(iso || '');
  if (!iso || isNaN(t.getTime())) return '';
  try {
    const date = new Intl.DateTimeFormat('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London'
    }).format(t);
    const time = new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Europe/London'
    }).format(t).replace(/\s?(am|pm)/i, ' $1');
    return date + ', ' + time + ' (UK time)';
  } catch (_) {
    return '';
  }
}

// The same admission rule the consult-nudge email path uses: stopped and
// screened_out are terminal; the qualified gate applies to the PRE-booking
// funnel only (a booked lead earned follow-up by booking, however they
// arrived). `kind` matters because not_booked is the one pre-booking touch.
function consultWaEligible(kind, consult) {
  if (!consult || typeof consult !== 'object') return false;
  if (consult.screened_out) return false;
  if (consult.wa && consult.wa[kind]) return false; // already handled, forever
  if (kind === 'not_booked') {
    if (consult.stopped) return false;
    return consult.qualified === true && !consult.call_booked;
  }
  if (kind === 'call_booked') {
    // stopped does NOT veto a confirmation: 'signed_up' leads who then book a
    // call still deserve "your call is confirmed". Only an unsubscribe does.
    if (consult.stopped === 'unsubscribed') return false;
    return consult.call_booked === true || consult.qualified === true;
  }
  if (kind === 'signed_up' || kind === 'onboarding_incomplete') {
    if (consult.stopped === 'unsubscribed') return false;
    return true;
  }
  return false;
}

// Placeholder arrays are positional and must match the approved template's
// {{1}}, {{2}}… slots exactly. Every slot must be non-empty (WhatsApp rejects
// empty variables), hence the fallbacks.
function buildConsultWaMessage(kind, ctx) {
  const tpl = CONSULT_WA_TEMPLATES[kind];
  if (!tpl) return null;
  const first = consultWaFirstName(ctx && ctx.name);
  if (kind === 'call_booked') {
    const when = formatConsultCallTime(ctx && ctx.callAtIso) || 'your chosen time';
    return { templateName: tpl.templateName, language: tpl.language, placeholders: [first, when] };
  }
  if (kind === 'not_booked') {
    const url = String((ctx && ctx.bookUrl) || '').trim();
    if (!url) return null;
    return { templateName: tpl.templateName, language: tpl.language, placeholders: [first, url] };
  }
  // Both reminders exist to deliver the join link, so a missing link is not a
  // message worth sending — return null and let the caller leave the marker
  // unstamped so the next cron run tries again (Calendly can attach the Zoom
  // URL after the booking row is first written).
  if (kind === 'call_reminder') {
    const join = String((ctx && ctx.joinUrl) || '').trim();
    const when = formatConsultCallTime(ctx && ctx.callAtIso);
    if (!join || !when) return null;
    return { templateName: tpl.templateName, language: tpl.language, placeholders: [first, when, join] };
  }
  if (kind === 'call_starting') {
    const join = String((ctx && ctx.joinUrl) || '').trim();
    if (!join) return null;
    return { templateName: tpl.templateName, language: tpl.language, placeholders: [first, join] };
  }
  return { templateName: tpl.templateName, language: tpl.language, placeholders: [first] };
}

// Decide whether an upcoming booked consultation is due a WhatsApp reminder.
// Pure: the cron supplies the row's times and its stored markers, and gets back
// either a skip (with a reason, for the log) or the window to send.
//
// Markers are per-BOOKING and shaped { call_at, h24, soon }. `call_at` is what
// makes a reschedule work: when the row's scheduled_at no longer matches the
// time the markers were stamped for, they describe a slot that no longer exists
// and are dropped, so the new slot gets its own reminders.
function consultCallReminderDecision(input) {
  const scheduledAt = String((input && input.scheduledAt) || '');
  const startMs = Date.parse(scheduledAt);
  if (!isFinite(startMs)) return { action: 'skip', reason: 'no_call_time' };
  const nowMs = Number(input && input.nowMs) || Date.now();
  const untilMs = startMs - nowMs;
  // Never remind someone about a call that has already begun — detect-no-shows
  // owns everything from the start time onwards.
  if (untilMs <= 0) return { action: 'skip', reason: 'already_started' };
  if (untilMs > CALL_REMINDER_DAY_MS) return { action: 'skip', reason: 'too_far_out' };

  const stored = (input && input.markers && typeof input.markers === 'object' && !Array.isArray(input.markers))
    ? input.markers : {};
  // Compare the instants, not the strings: PostgREST hands back
  // "2026-08-24T13:00:00+00:00" where the webhook stamped "…Z".
  const markedFor = Date.parse(String(stored.call_at || ''));
  const markers = (isFinite(markedFor) && markedFor === startMs)
    ? Object.assign({}, stored, { call_at: scheduledAt })
    : { call_at: scheduledAt };

  const bookedMs = Date.parse(String((input && input.bookedAt) || ''));
  // An unreadable booked_at must not block the reminder — treat it as long ago.
  const sinceBookingMs = isFinite(bookedMs) ? (nowMs - bookedMs) : Infinity;

  if (untilMs <= CALL_REMINDER_SOON_MS) {
    if (markers.soon) return { action: 'skip', reason: 'already_sent' };
    if (sinceBookingMs < CALL_STARTING_MIN_AFTER_BOOKING_MS) return { action: 'skip', reason: 'just_booked' };
    return { action: 'send', window: 'soon', kind: CONSULT_CALL_REMINDER_KIND.soon, markers: markers };
  }
  if (markers.h24) return { action: 'skip', reason: 'already_sent' };
  if (sinceBookingMs < CALL_REMINDER_MIN_AFTER_BOOKING_MS) return { action: 'skip', reason: 'just_booked' };
  return { action: 'send', window: 'h24', kind: CONSULT_CALL_REMINDER_KIND.h24, markers: markers };
}

// Calendly's own booking form asks for a phone number and marks it REQUIRED
// (that is why consultRecognitionPayload prefills one), so EVERY booking carries
// a number even when our lead row does not — a direct booker never filled in our
// form, and our form's phone can be blank on older leads. The webhook joins all
// the answers into one notes blob, so recovering it means reading the answers.
//
// Deliberately strict: a free-text answer ("I have two children - 9 & 4") must
// never be mistaken for a phone number. A candidate has to be E.164-ish (a +
// prefix), a 10-digit national number, or an Australian 0-prefixed mobile —
// anything else is rejected rather than guessed at, because the cost of a wrong
// number is messaging a stranger.
const PHONE_CANDIDATE_RE = /\+?\d[\d\s().-]{6,}\d/g;

function normalizeExtractedPhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const plus = s.startsWith('+');
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) return '';
  if (plus) return '+' + digits;
  // No country code to lean on: only shapes normalizePhone can resolve safely.
  if (digits.length === 10 && digits.startsWith('0')) return digits; // AU 04… local
  if (digits.length >= 10 && !digits.startsWith('0')) return digits;
  return '';
}

function firstPhoneIn(text) {
  const matches = String(text || '').match(PHONE_CANDIDATE_RE) || [];
  for (const candidate of matches) {
    const ok = normalizeExtractedPhone(candidate);
    if (ok) return ok;
  }
  return '';
}

// qna = Calendly's questions_and_answers array; notesText = the already-joined
// blob we store on the booking row (so older bookings are recoverable too).
function extractConsultPhone(qna, notesText) {
  const rows = Array.isArray(qna) ? qna : [];
  // The answer to a question that is explicitly about a phone number wins —
  // it cannot be confused with a number that happens to sit in free text.
  for (const row of rows) {
    if (!/phone|mobile|whatsapp|cell|contact\s*(number|no)/i.test(String((row && row.question) || ''))) continue;
    const hit = firstPhoneIn(String((row && row.answer) || ''));
    if (hit) return hit;
  }
  for (const row of rows) {
    const hit = firstPhoneIn(String((row && row.answer) || ''));
    if (hit) return hit;
  }
  return firstPhoneIn(notesText);
}

// A reminder is a courtesy about a booking this person made themselves, so the
// nudge-funnel gates (qualified / screened_out / stopped) do NOT apply — only an
// explicit unsubscribe silences it. Leads booked straight off the public Calendly
// link have no consult metadata at all, and they are still owed their link.
function consultCallReminderAllowedForLead(consult) {
  if (!consult || typeof consult !== 'object') return true;
  return consult.stopped !== 'unsubscribed';
}

// Decide what to do with one signed-up lead in the cron's onboarding pass.
// Returns { action: 'skip' } (look again next hour),
//         { action: 'mark', value } (terminal — stamp the marker, never look again),
//      or { action: 'send' }.
function onboardingNudgeDecision(input) {
  const consult = (input && input.consult) || {};
  if (!consultWaEligible('onboarding_incomplete', consult)) return { action: 'skip' };
  if (consult.stopped !== 'signed_up') return { action: 'skip' };
  if (!input.userExists) return { action: 'mark', value: 'no_account' };
  if (input.onboardingComplete) return { action: 'mark', value: 'completed' };
  const signupAtMs = Number(input.signupAtMs);
  if (!isFinite(signupAtMs) || signupAtMs <= 0) return { action: 'mark', value: 'no_signup_time' };
  const nowMs = Number(input.nowMs) || Date.now();
  if (nowMs - signupAtMs > ONBOARDING_NUDGE_WINDOW_MS) return { action: 'mark', value: 'window_passed' };
  if (nowMs - signupAtMs < ONBOARDING_NUDGE_AFTER_MS) return { action: 'skip' };
  return { action: 'send' };
}

module.exports = {
  CONSULT_WA_TEMPLATES,
  CONSULT_CALL_REMINDER_KIND,
  ONBOARDING_NUDGE_AFTER_MS,
  ONBOARDING_NUDGE_WINDOW_MS,
  CALL_REMINDER_SOON_MS,
  CALL_REMINDER_DAY_MS,
  CALL_REMINDER_MIN_AFTER_BOOKING_MS,
  CALL_STARTING_MIN_AFTER_BOOKING_MS,
  consultWaFirstName,
  formatConsultCallTime,
  consultWaEligible,
  buildConsultWaMessage,
  onboardingNudgeDecision,
  consultCallReminderDecision,
  consultCallReminderAllowedForLead,
  extractConsultPhone
};

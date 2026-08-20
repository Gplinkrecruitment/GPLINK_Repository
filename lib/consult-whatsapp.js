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
//
// Sent-markers live in site_enquiries.metadata.consult.wa[kind] so a send can
// never repeat; the marker is only stamped AFTER a successful send, so a
// template that is still pending WhatsApp approval fails soft and the touch
// stays eligible (mirrors the RSO-welcome sentinel rule).
'use strict';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Template names must match the DoubleTick dashboard EXACTLY.
const CONSULT_WA_TEMPLATES = {
  call_booked: { templateName: 'gp_link_consult_call_booked', language: 'en' },
  not_booked: { templateName: 'gp_link_consult_book_nudge', language: 'en' },
  signed_up: { templateName: 'gp_link_consult_signup_welcome', language: 'en' },
  onboarding_incomplete: { templateName: 'gp_link_consult_onboarding_nudge', language: 'en' }
};

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
  return { templateName: tpl.templateName, language: tpl.language, placeholders: [first] };
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
  ONBOARDING_NUDGE_AFTER_MS,
  ONBOARDING_NUDGE_WINDOW_MS,
  consultWaFirstName,
  formatConsultCallTime,
  consultWaEligible,
  buildConsultWaMessage,
  onboardingNudgeDecision
};

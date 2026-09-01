// ── Drop-off re-engagement nudges (owner rules, 2026-09-01) ──
// Every drop-off point from signup to applying for a position has BOTH a
// WhatsApp template (approved in DoubleTick 2026-09-01) and an email, sent at
// most once per point per GP, forever — the ledger is the gp_nudge_log table.
//
// Channel map per point:
//   onboarding_start / onboarding_move / onboarding_identity
//     - email: the existing 7-touch onboarding drip (lib/onboarding-nudge.js)
//     - whatsapp: templates below, fired by /api/cron/onboarding-nudge's WA leg
//   career_start / career_cv / offer_signature
//     - email: builders below, fired by /api/cron/dropoff-nudge
//     - whatsapp: templates below, fired by the same cron
//
// Copy rules: plain words, no em dashes, Khaleed's voice (matches the approved
// WhatsApp template bodies).
'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

// How long after finishing onboarding before each careers nudge may fire.
const CAREER_START_AFTER_MS = 2 * DAY_MS;
const CAREER_CV_AFTER_MS = 7 * DAY_MS;
// WhatsApp for onboarding drop-offs waits at least this long (mirrors the
// consult funnel's 24h rule) so a doctor mid-signup is not pinged the same hour.
const ONBOARDING_WA_AFTER_MS = 1 * DAY_MS;

// Approved DoubleTick template names, one per drop-off point.
const WA_TEMPLATES = {
  onboarding_start: 'gp_link_resume_onboarding_start',
  onboarding_move: 'gp_link_resume_onboarding_move',
  onboarding_identity: 'gp_link_resume_onboarding_id',
  career_start: 'gp_link_start_practice_search',
  career_cv: 'gp_link_upload_cv_nudge',
  offer_signature: 'gp_link_offer_signature_nudge'
};

// Wizard slide index → drop-off point. Slides: 0 intro, 1 country of
// registration, 2 plan your move, 3 review, 4 confirm your identity.
function onboardingStepNudgeKey(step) {
  const n = Number(step) || 0;
  if (n >= 4) return 'onboarding_identity';
  if (n >= 2) return 'onboarding_move';
  return 'onboarding_start';
}

// Which post-onboarding nudge (if any) is due for this GP right now.
// input: { onboardingCompletedAtMs, hasApplication, hasCv, placed, nowMs,
//          sent: { career_start, career_cv } }  (sent = already nudged keys)
// Returns a nudge key or null. One key per call — career_cv only ever follows
// career_start on a later run, so a GP is never double-nudged in one sweep.
function postOnboardingNudgeDecision(input) {
  if (!input || !input.onboardingCompletedAtMs) return null;
  if (input.placed || input.hasApplication) return null;
  const sent = input.sent || {};
  const age = (input.nowMs || Date.now()) - input.onboardingCompletedAtMs;
  if (!sent.career_start && age >= CAREER_START_AFTER_MS) return 'career_start';
  if (!sent.career_cv && sent.career_start && !input.hasCv && age >= CAREER_CV_AFTER_MS) return 'career_cv';
  return null;
}

// Email builders for the careers-side nudges. Return shape matches
// buildCareerEmailHtml's inputs: { subject, title, body, ctaText, ctaUrl }.
// Body is plain text (the shell wraps it in its own paragraph).
function buildDropoffEmail(nudgeKey, opts) {
  const first = String((opts && opts.firstName) || '').trim() || 'there';
  const app = String((opts && opts.appBaseUrl) || 'https://app.mygplink.com.au').replace(/\/$/, '');
  if (nudgeKey === 'career_start') {
    return {
      subject: 'Your GP Link profile is ready. Time to find your practice',
      title: 'The exciting part starts now, Dr ' + first,
      body: 'Your GP Link profile is set up, so the exciting part can begin: finding your practice in Australia. '
        + 'Browse the positions we have open and tell us which ones interest you.\n\n'
        + 'Securing your position is the first step, and our team then walks you through the registration paperwork around it. '
        + 'If you would rather talk it through first, just reply to this email and we will set up a quick call.\n\n'
        + 'Khaleed, CEO of GP Link',
      ctaText: 'Browse open positions',
      ctaUrl: app + '/pages/career'
    };
  }
  if (nudgeKey === 'career_cv') {
    return {
      subject: 'One upload unlocks applying, Dr ' + first,
      title: 'Practices are ready to look at you',
      body: 'The only thing missing is your CV. Upload it and you can apply for any position straight away. '
        + 'It only needs to be your current CV, and our system checks it in seconds.\n\n'
        + 'Reply to this email if you would like a hand with it.\n\n'
        + 'Khaleed, CEO of GP Link',
      ctaText: 'Upload your CV',
      ctaUrl: app + '/pages/career'
    };
  }
  if (nudgeKey === 'offer_signature') {
    return {
      subject: 'Your position offer is waiting for your signature',
      title: 'Congratulations again, Dr ' + first,
      body: 'Your position offer is waiting for you. The last step is to review and sign your agreement, and it only takes a few minutes. '
        + 'Once it is signed your position is locked in and we begin your registration together.\n\n'
        + 'Any questions about the agreement? Reply to this email and I will answer them personally.\n\n'
        + 'Khaleed, CEO of GP Link',
      ctaText: 'Review and sign',
      ctaUrl: app + '/pages/career'
    };
  }
  return null;
}

module.exports = {
  DAY_MS,
  CAREER_START_AFTER_MS,
  CAREER_CV_AFTER_MS,
  ONBOARDING_WA_AFTER_MS,
  WA_TEMPLATES,
  onboardingStepNudgeKey,
  postOnboardingNudgeDecision,
  buildDropoffEmail
};

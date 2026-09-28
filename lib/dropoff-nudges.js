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
// The onboarding_* keys are the 2026-09-01 body-link templates; kept so the
// ledger (gp_nudge_log) history still names what was sent under them.
const WA_TEMPLATES = {
  onboarding_start: 'gp_link_resume_onboarding_start',
  onboarding_move: 'gp_link_resume_onboarding_move',
  onboarding_identity: 'gp_link_resume_onboarding_id',
  career_start: 'gp_link_start_practice_search',
  career_cv: 'gp_link_upload_cv_nudge',
  offer_signature: 'gp_link_offer_signature_nudge'
};

// Step-accurate onboarding templates (2026-09-29). One per wizard step the GP
// is stuck on, each with a "continue" URL button whose dynamic suffix is the
// slide index: https://app.mygplink.com.au/pages/onboarding.html?step={{1}}.
// The link survives sign-in (onboarding.js carries it through ?next=).
const ONBOARDING_STEP_WA_TEMPLATES = {
  onboarding_step_start: 'gp_link_onboarding_step_start',
  onboarding_step_move: 'gp_link_onboarding_step_move',
  onboarding_step_register: 'gp_link_onboarding_step_register',
  onboarding_step_id: 'gp_link_onboarding_step_id'
};

// Wizard slide index → drop-off point. Slide order since the 2026-08-24
// reorder (DOM order of .slide in pages/onboarding.html): 0 welcome,
// 1 plan your move, 2 country + register number (no certificates since
// 2026-08-31), 3 review, 4 confirm your identity.
function onboardingStepNudgeKey(step) {
  const n = Number(step) || 0;
  if (n >= 3) return 'onboarding_step_id';
  if (n === 2) return 'onboarding_step_register';
  if (n === 1) return 'onboarding_step_move';
  return 'onboarding_step_start';
}

// The slide a step nudge's link opens: the one the GP left off on, clamped
// to the wizard's 5 slides.
function onboardingStepForLink(step) {
  const n = Math.floor(Number(step) || 0);
  return Math.min(Math.max(n, 0), 4);
}

// Step-specific onboarding email. Same return shape as buildDropoffEmail.
// opts: { firstName, step, appBaseUrl }
function buildOnboardingStepEmail(nudgeKey, opts) {
  const first = String((opts && opts.firstName) || '').trim() || 'there';
  const app = String((opts && opts.appBaseUrl) || 'https://app.mygplink.com.au').replace(/\/$/, '');
  const ctaUrl = app + '/pages/onboarding.html?step=' + onboardingStepForLink(opts && opts.step);
  const sign = '\n\nKhaleed, CEO of GP Link';
  if (nudgeKey === 'onboarding_step_start') {
    return {
      subject: 'Your GP Link profile takes 3 minutes, Dr ' + first,
      title: 'Let\'s get your move started',
      body: 'Your GP Link account is ready, but your profile is still empty, so my team can\'t start looking for practices for you yet.\n\n'
        + 'It takes about 3 minutes. You tell us when you\'d like to arrive, which city appeals and who is coming with you, then add your GMC, IMC or MCNZ number and a photo ID. No certificates needed.\n\n'
        + 'If anything is holding you back, just reply to this email and I\'ll help you personally.' + sign,
      ctaText: 'Start my profile',
      ctaUrl: ctaUrl
    };
  }
  if (nudgeKey === 'onboarding_step_move') {
    return {
      subject: 'Where in Australia, Dr ' + first + '?',
      title: 'Plan your move in a minute',
      body: 'You stopped at planning your move: when you\'d like to arrive, which city appeals and who is coming with you.\n\n'
        + 'It takes about a minute, and it\'s how we shortlist practices that suit you and your family. After that it\'s just your GMC, IMC or MCNZ number and a photo ID.\n\n'
        + 'Any questions about working or living in Australia? Reply to this email and I\'ll answer them personally.' + sign,
      ctaText: 'Plan my move',
      ctaUrl: ctaUrl
    };
  }
  if (nudgeKey === 'onboarding_step_register') {
    return {
      subject: 'No certificates needed any more, Dr ' + first,
      title: 'Good news: no uploads needed',
      body: 'You no longer need to upload any certificates to finish your GP Link profile.\n\n'
        + 'Just pick the country you qualified in and enter your GMC, IMC or MCNZ number. We confirm you on the public register, so it takes about a minute. Your certificates only come later, when your Australian registration begins.\n\n'
        + 'If anything is unclear, reply to this email and my team will sort it out with you.' + sign,
      ctaText: 'Add my GMC number',
      ctaUrl: ctaUrl
    };
  }
  if (nudgeKey === 'onboarding_step_id') {
    return {
      subject: 'One step left, Dr ' + first,
      title: 'You\'re one step from finished',
      body: 'All that\'s left on your GP Link profile is a quick photo of your passport or driving licence. It takes under a minute.\n\n'
        + 'As soon as it\'s done you can start browsing GP positions across Australia, and my team can start putting you forward to practices.\n\n'
        + 'Any trouble with the upload? Reply to this email and I\'ll sort it out with you.' + sign,
      ctaText: 'Finish my profile',
      ctaUrl: ctaUrl
    };
  }
  return null;
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
  ONBOARDING_STEP_WA_TEMPLATES,
  onboardingStepNudgeKey,
  onboardingStepForLink,
  buildOnboardingStepEmail,
  postOnboardingNudgeDecision,
  buildDropoffEmail
};

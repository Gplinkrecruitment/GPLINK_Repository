import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  WA_TEMPLATES, ONBOARDING_STEP_WA_TEMPLATES, onboardingStepNudgeKey, onboardingStepForLink,
  buildOnboardingStepEmail, postOnboardingNudgeDecision,
  buildDropoffEmail, CAREER_START_AFTER_MS, CAREER_CV_AFTER_MS, DAY_MS
} from '../lib/dropoff-nudges.js';

// ── Drop-off re-engagement — every point has BOTH channels (owner, 2026-09-01) ──
// Simulates every drop-off state from signup to applying and asserts the right
// nudge fires (or none), that WhatsApp + email artifacts exist for each point,
// and that nobody can ever be double-messaged about the same point.

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('every drop-off point has a WhatsApp template and an email channel', () => {
  const POINTS = ['onboarding_start', 'onboarding_move', 'onboarding_identity', 'career_start', 'career_cv', 'offer_signature'];

  it('WhatsApp: all six approved template names are mapped', () => {
    for (const key of POINTS) {
      expect(WA_TEMPLATES[key], key).toMatch(/^gp_link_/);
    }
    expect(Object.keys(WA_TEMPLATES)).toHaveLength(6);
  });
  it('email: careers-side points have builders; onboarding points ride the existing 7-touch drip', () => {
    for (const key of ['career_start', 'career_cv', 'offer_signature']) {
      const mail = buildDropoffEmail(key, { firstName: 'Sarah' });
      expect(mail, key).toBeTruthy();
      expect(mail.subject.length, key).toBeGreaterThan(8);
      expect(mail.body, key).toContain('Khaleed');
      expect(mail.ctaUrl, key).toContain('/pages/career');
    }
    // Onboarding email coverage = lib/onboarding-nudge.js (7 scheduled touches).
    const drip = read('lib/onboarding-nudge.js');
    expect(drip).toContain('NUDGE_SCHEDULE_MS');
  });
  it('doctor-facing copy carries no em dashes (owner rule)', () => {
    for (const key of ['career_start', 'career_cv', 'offer_signature']) {
      const mail = buildDropoffEmail(key, { firstName: 'Sarah' });
      expect(mail.subject + mail.title + mail.body, key).not.toMatch(/—/);
    }
  });
});

describe('onboarding wizard slide → drop-off point', () => {
  // Slide order since the 2026-08-24 reorder: 0 welcome, 1 plan your move,
  // 2 country + register number, 3 review, 4 identity. The old mapping assumed
  // the pre-reorder order, so a GP stuck on "Plan your move" got the start copy
  // and one on the register-number step was told "a couple of questions to go".
  it('maps every slide to the step it actually shows', () => {
    expect(onboardingStepNudgeKey(0)).toBe('onboarding_step_start');
    expect(onboardingStepNudgeKey(1)).toBe('onboarding_step_move');
    expect(onboardingStepNudgeKey(2)).toBe('onboarding_step_register');
    expect(onboardingStepNudgeKey(3)).toBe('onboarding_step_id');
    expect(onboardingStepNudgeKey(4)).toBe('onboarding_step_id');
    expect(onboardingStepNudgeKey(undefined)).toBe('onboarding_step_start');
  });
  it('every step key has a button template and an email', () => {
    for (const key of ['onboarding_step_start', 'onboarding_step_move', 'onboarding_step_register', 'onboarding_step_id']) {
      expect(ONBOARDING_STEP_WA_TEMPLATES[key], key).toMatch(/^gp_link_onboarding_step_/);
      const mail = buildOnboardingStepEmail(key, { firstName: 'Sarah', step: 2, appBaseUrl: 'https://app.mygplink.com.au/' });
      expect(mail, key).toBeTruthy();
      expect(mail.subject, key).toContain('Sarah');
      expect(mail.body, key).toContain('Khaleed');
      expect(mail.ctaUrl, key).toBe('https://app.mygplink.com.au/pages/onboarding.html?step=2');
      expect(mail.subject + mail.title + mail.body + mail.ctaText, key).not.toMatch(/—/);
    }
    expect(buildOnboardingStepEmail('career_start', { firstName: 'Sarah' })).toBe(null);
  });
  it('the register step says no certificates are needed (they no longer are)', () => {
    const mail = buildOnboardingStepEmail('onboarding_step_register', { firstName: 'Sarah', step: 2 });
    expect(mail.body).toMatch(/no longer need to upload any certificates/);
    expect(mail.body).toMatch(/GMC, IMC or MCNZ/);
  });
  it('button link opens the slide the GP left off on, clamped to the wizard', () => {
    expect(onboardingStepForLink(4)).toBe(4);
    expect(onboardingStepForLink(2)).toBe(2);
    expect(onboardingStepForLink(undefined)).toBe(0);
    expect(onboardingStepForLink(-3)).toBe(0);
    expect(onboardingStepForLink(9)).toBe(4);
  });
});

describe('post-onboarding decision — simulated GP states', () => {
  const NOW = Date.parse('2026-09-01T12:00:00Z');
  const base = {
    onboardingCompletedAtMs: NOW - 3 * DAY_MS,
    hasApplication: false, hasCv: false, placed: false,
    nowMs: NOW, sent: {}
  };

  it('freshly onboarded (< 2 days): leave them alone', () => {
    expect(postOnboardingNudgeDecision({ ...base, onboardingCompletedAtMs: NOW - DAY_MS })).toBe(null);
  });
  it('onboarded 3 days, never looked at positions → career_start', () => {
    expect(postOnboardingNudgeDecision(base)).toBe('career_start');
  });
  it('career_start already sent, still no CV after a week → career_cv', () => {
    expect(postOnboardingNudgeDecision({
      ...base, onboardingCompletedAtMs: NOW - 8 * DAY_MS, sent: { career_start: true }
    })).toBe('career_cv');
  });
  it('career_cv never fires before career_start (one point per sweep, in order)', () => {
    expect(postOnboardingNudgeDecision({
      ...base, onboardingCompletedAtMs: NOW - 8 * DAY_MS
    })).toBe('career_start');
  });
  it('has a CV → no CV nudge', () => {
    expect(postOnboardingNudgeDecision({
      ...base, onboardingCompletedAtMs: NOW - 8 * DAY_MS, hasCv: true, sent: { career_start: true }
    })).toBe(null);
  });
  it('applied to a practice → never nudged (they are in the pipeline)', () => {
    expect(postOnboardingNudgeDecision({ ...base, hasApplication: true })).toBe(null);
  });
  it('placed → never nudged', () => {
    expect(postOnboardingNudgeDecision({ ...base, placed: true })).toBe(null);
  });
  it('both already sent → silence forever', () => {
    expect(postOnboardingNudgeDecision({
      ...base, onboardingCompletedAtMs: NOW - 30 * DAY_MS, sent: { career_start: true, career_cv: true }
    })).toBe(null);
  });
  it('thresholds are what the owner was told (2 days, then 7)', () => {
    expect(CAREER_START_AFTER_MS).toBe(2 * DAY_MS);
    expect(CAREER_CV_AFTER_MS).toBe(7 * DAY_MS);
  });
});

describe('server wiring (source pins)', () => {
  const serverJs = read('server.js');

  it('the dropoff-nudge cron exists, is scheduled hourly, and sends BOTH channels', () => {
    expect(serverJs).toContain("pathname === '/api/cron/dropoff-nudge'");
    expect(serverJs).toMatch(/'dropoff-nudge': \{ schedule: '40 \* \* \* \*'/);
    expect(read('vercel.json')).toContain('"/api/cron/dropoff-nudge"');
    const cron = serverJs.slice(serverJs.indexOf("pathname === '/api/cron/dropoff-nudge'"));
    const block = cron.slice(0, cron.indexOf('[DropoffNudge/Cron]'));
    expect(block).toContain('maybeSendDropoffEmail(');
    expect(block).toContain('maybeSendDropoffWa(');
    expect(block).toContain('isBypassLockEmail'); // test accounts never nudged
  });
  it('the onboarding email drip gained a once-per-point WhatsApp leg', () => {
    const cron = serverJs.slice(serverJs.indexOf("pathname === '/api/cron/onboarding-nudge'"));
    const block = cron.slice(0, cron.indexOf('[OnbNudge/Cron]'));
    expect(block).toContain('dropoffNudges.onboardingStepNudgeKey(');
    expect(block).toContain('maybeSendDropoffWa(');
    expect(block).toMatch(/onbWaSent < 15/);
  });
  it('the hourly WhatsApp leg sends the step template with a button that opens the step', () => {
    const cron = serverJs.slice(serverJs.indexOf("pathname === '/api/cron/onboarding-nudge'"));
    const block = cron.slice(0, cron.indexOf('[OnbNudge/Cron]'));
    expect(block).toContain('dropoffNudges.ONBOARDING_STEP_WA_TEMPLATES[onbWaKey]');
    expect(block).toContain('buttonParam: dropoffNudges.onboardingStepForLink(onbG.lastStep)');
    const wa = serverJs.slice(serverJs.indexOf('async function maybeSendDropoffWa'), serverJs.indexOf('async function maybeSendDropoffEmail'));
    expect(wa).toContain("waMsg.buttons = [{ type: 'URL', parameter: String(opts.buttonParam) }]");
  });
  it('the on-demand step follow-up is cron-authed, dry-run by default, and skips opt-outs + test accounts', () => {
    const route = serverJs.slice(serverJs.indexOf("pathname === '/api/cron/onboarding-step-followup'"));
    const block = route.slice(0, route.indexOf('onboarding-step-followup failed'));
    expect(block).toContain("'Bearer ' + osfSecret");
    expect(block).toContain('osfOwnSecret.length >= 32'); // never an empty or short secret
    expect(block).toContain("searchParams.get('send') === '1'");
    expect(block).toContain('if (osfSend) Object.assign(osfOut, await sendOnboardingStepFollowup(osfG))');
    expect(block).toContain("skipped = 'unsubscribed'");
    expect(block).toContain('isBypassLockEmail(osfG.email)');
    const em = serverJs.slice(serverJs.indexOf('async function maybeSendOnboardingStepEmail'), serverJs.indexOf('async function sendOnboardingStepFollowup'));
    expect(em).toContain("hasDropoffNudge(gp.userId, nudgeKey, 'email')");
    expect(em).toContain("allowsNonCriticalNotification(gp.email, 'emailNudges')");
    expect(em).toContain("'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'");
  });
  it('a consult lead is converted at signup AND login, not only when its next nudge falls due', () => {
    expect(serverJs.split('.then(() => markConsultLeadSignedUp(email))').length - 1).toBe(2);
    const fn = serverJs.slice(serverJs.indexOf('async function markConsultLeadSignedUp'), serverJs.indexOf('async function backfillPriorConsultationsForUser'));
    expect(fn).toContain('if (consult.stopped) return');
    expect(fn).toContain("stopped: 'signed_up'");
    expect(fn).toContain("maybeSendConsultWa(row, 'signed_up')");
  });
  it('the ledger makes double-sends impossible: every sender checks gp_nudge_log first', () => {
    const wa = serverJs.slice(serverJs.indexOf('async function maybeSendDropoffWa'), serverJs.indexOf('async function maybeSendDropoffEmail'));
    expect(wa).toContain("hasDropoffNudge(userId, nudgeKey, 'whatsapp')");
    const em = serverJs.slice(serverJs.indexOf('async function maybeSendDropoffEmail'), serverJs.indexOf('async function markConsultWaOnboardingResolved'));
    expect(em).toContain("hasDropoffNudge(userId, nudgeKey, 'email')");
    expect(em).toContain("category: 'marketing'"); // suppression + unsubscribe header
    expect(em).toContain("allowsNonCriticalNotification(email, 'emailNudges')");
  });
});

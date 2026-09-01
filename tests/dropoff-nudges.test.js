import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  WA_TEMPLATES, onboardingStepNudgeKey, postOnboardingNudgeDecision,
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
  it('maps every slide to the right point', () => {
    expect(onboardingStepNudgeKey(0)).toBe('onboarding_start');
    expect(onboardingStepNudgeKey(1)).toBe('onboarding_start');
    expect(onboardingStepNudgeKey(2)).toBe('onboarding_move');
    expect(onboardingStepNudgeKey(3)).toBe('onboarding_move');
    expect(onboardingStepNudgeKey(4)).toBe('onboarding_identity');
    expect(onboardingStepNudgeKey(undefined)).toBe('onboarding_start');
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
  it('the ledger makes double-sends impossible: every sender checks gp_nudge_log first', () => {
    const wa = serverJs.slice(serverJs.indexOf('async function maybeSendDropoffWa'), serverJs.indexOf('async function maybeSendDropoffEmail'));
    expect(wa).toContain("hasDropoffNudge(userId, nudgeKey, 'whatsapp')");
    const em = serverJs.slice(serverJs.indexOf('async function maybeSendDropoffEmail'), serverJs.indexOf('async function markConsultWaOnboardingResolved'));
    expect(em).toContain("hasDropoffNudge(userId, nudgeKey, 'email')");
    expect(em).toContain("category: 'marketing'"); // suppression + unsubscribe header
    expect(em).toContain("allowsNonCriticalNotification(email, 'emailNudges')");
  });
});

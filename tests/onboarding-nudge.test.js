import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { NUDGE_SCHEDULE_MS, nextDueStep, isExhausted, copyForStep, ONBOARDING_STEP_LABELS } = require('../lib/onboarding-nudge.js');

const H = 3600000, D = 24 * H;

describe('NUDGE_SCHEDULE_MS', () => {
  it('is 1h, 24h, 72h, 10d, 17d, 24d, 31d', () => {
    expect(NUDGE_SCHEDULE_MS).toEqual([H, 24 * H, 72 * H, 10 * D, 17 * D, 24 * D, 31 * D]);
  });
});

describe('nextDueStep', () => {
  it('nothing due before 1h', () => {
    expect(nextDueStep({ inactivityMs: H - 1, stepsSent: [] })).toBe(null);
  });
  it('step 0 due at exactly 1h', () => {
    expect(nextDueStep({ inactivityMs: H, stepsSent: [] })).toBe(0);
  });
  it('does not resend a sent step', () => {
    expect(nextDueStep({ inactivityMs: H + 1, stepsSent: [0] })).toBe(null);
  });
  it('returns the EARLIEST unsent due step (catch-up after downtime)', () => {
    expect(nextDueStep({ inactivityMs: 4 * D, stepsSent: [] })).toBe(0);
    expect(nextDueStep({ inactivityMs: 4 * D, stepsSent: [0, 1] })).toBe(2);
  });
  it('walks the weekly tail', () => {
    expect(nextDueStep({ inactivityMs: 10 * D, stepsSent: [0, 1, 2] })).toBe(3);
    expect(nextDueStep({ inactivityMs: 31 * D, stepsSent: [0, 1, 2, 3, 4, 5] })).toBe(6);
  });
  it('null when all sent', () => {
    expect(nextDueStep({ inactivityMs: 40 * D, stepsSent: [0, 1, 2, 3, 4, 5, 6] })).toBe(null);
  });
  it('tolerates junk input', () => {
    expect(nextDueStep({ inactivityMs: -5, stepsSent: null })).toBe(null);
    expect(nextDueStep({})).toBe(null);
  });
});

describe('isExhausted', () => {
  it('false mid-sequence', () => {
    expect(isExhausted({ inactivityMs: 5 * D, stepsSent: [0, 1, 2] })).toBe(false);
  });
  it('true once the final step is sent', () => {
    expect(isExhausted({ inactivityMs: 31 * D, stepsSent: [0, 1, 2, 3, 4, 5, 6] })).toBe(true);
  });
  it('true past 31d even if some steps were skipped, as long as nothing is still due', () => {
    // steps all sent OR nothing due -> exhausted when beyond the last threshold
    expect(isExhausted({ inactivityMs: 32 * D, stepsSent: [0, 1, 2, 3, 4, 5, 6] })).toBe(true);
    // something still due -> NOT exhausted (send it first)
    expect(isExhausted({ inactivityMs: 32 * D, stepsSent: [0, 1, 2, 3, 4, 5] })).toBe(false);
  });
});

describe('copyForStep', () => {
  it('every step has non-empty subject/title/body and greets by name', () => {
    for (let i = 0; i < 7; i++) {
      const c = copyForStep(i, { name: 'Helen', stepsLeft: 3 });
      expect(c.subject.length).toBeGreaterThan(5);
      expect(c.title.length).toBeGreaterThan(3);
      expect(c.body).toContain('Helen');
    }
  });
  it('mentions how many steps are left when provided', () => {
    expect(copyForStep(1, { name: 'Helen', stepsLeft: 2 }).body).toContain('2');
  });
  it('final email says the reminders will stop', () => {
    expect(copyForStep(6, { name: 'Helen', stepsLeft: 1 }).body.toLowerCase()).toContain('last');
  });
});

describe('ONBOARDING_STEP_LABELS', () => {
  it('has 5 labels matching the 5-step wizard', () => {
    expect(ONBOARDING_STEP_LABELS.length).toBe(5);
  });
});

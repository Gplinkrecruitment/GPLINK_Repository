import { describe, it, expect } from 'vitest';
import { computeIntent, INTENT_WEIGHTS, bandFor } from '../lib/ats-intent.js';

// Frozen clock for parity with the other ATS/CEO suites (intent itself is
// clock-free — callers pass pre-computed day deltas — so this is decorative
// but keeps the fixture style consistent).
const NOW = Date.UTC(2026, 5, 14, 12, 0, 0); // 2026-06-14T12:00:00Z

// A maximally-engaged candidate.
const HOT = {
  commsEngagementVal: 0.9,
  onboardingCompleted: true,
  onboardingFieldsFilled: 1,
  docs: { cv: true, coverLetter: true, idDoc: true, primaryDegree: true },
  regStageIndex: 5,
  regStageMax: 5,
  blockedDays: 0,
  callsCompleted: 9,
  callsMissed: 1,
  lastActiveDays: 1,
  bestAtsStage: 'interview'
};

// A dead-cold candidate: nothing done, no docs, no engagement.
const COLD = {
  commsEngagementVal: null,
  onboardingCompleted: false,
  onboardingFieldsFilled: 0,
  docs: { cv: false, coverLetter: false, idDoc: false, primaryDegree: false },
  regStageIndex: 0,
  regStageMax: 1,
  blockedDays: 0,
  callsCompleted: 0,
  callsMissed: 0,
  lastActiveDays: 999,
  bestAtsStage: null
};

const REG_LABEL = 'Registration progress';
const sig = (result, label) => result.signals.find((s) => s.label === label);

describe('computeIntent band classification', () => {
  it('a fully-engaged candidate is Hot with score >= 70', () => {
    const r = computeIntent(HOT);
    expect(r.band).toBe('Hot');
    expect(r.score).toBeGreaterThanOrEqual(70);
  });

  it('an empty candidate is Cold and never throws on null fields', () => {
    expect(() => computeIntent(COLD)).not.toThrow();
    const r = computeIntent(COLD);
    expect(r.band).toBe('Cold');
    expect(r.score).toBeLessThan(40);
    // null/undefined/garbage inputs must all be tolerated.
    expect(() => computeIntent(null)).not.toThrow();
    expect(() => computeIntent(undefined)).not.toThrow();
    expect(() => computeIntent({})).not.toThrow();
    expect(() => computeIntent({ docs: null, commsEngagementVal: undefined, bestAtsStage: 123 })).not.toThrow();
    expect(computeIntent({}).band).toBe('Cold');
  });
});

describe('computeIntent shape + signals', () => {
  it('returns the 7 signals in the exact label order with matching weights', () => {
    const r = computeIntent(HOT);
    expect(r.signals.map((s) => s.label)).toEqual([
      'Comms engagement & tone (AI)',
      'Onboarding completed',
      'Documents (CV, cover letter, ID, degree)',
      'Registration progress',
      'Call attendance',
      'Recent app activity',
      'Job pipeline engagement'
    ]);
    expect(r.signals.map((s) => s.w)).toEqual(INTENT_WEIGHTS);
    // every v is clamped to 0..1
    r.signals.forEach((s) => {
      expect(s.v).toBeGreaterThanOrEqual(0);
      expect(s.v).toBeLessThanOrEqual(1);
      expect(s.points).toBe(Math.round(s.w * s.v));
    });
  });

  it('is deterministic — same input yields a deeply-equal result', () => {
    expect(computeIntent(HOT)).toEqual(computeIntent(HOT));
    expect(computeIntent(COLD)).toEqual(computeIntent(COLD));
  });

  it('score equals the rounded sum of the signal points (within rounding)', () => {
    const r = computeIntent(HOT);
    const sumPoints = r.signals.reduce((acc, s) => acc + s.points, 0);
    // sum-of-rounded vs rounded-sum differ by at most ~0.5 per signal.
    expect(Math.abs(r.score - sumPoints)).toBeLessThanOrEqual(4);
  });
});

describe('blocked-days penalty', () => {
  it('blockedDays reduces the Registration progress signal value', () => {
    const base = { regStageIndex: 3, regStageMax: 5, blockedDays: 0 };
    const blocked = { regStageIndex: 3, regStageMax: 5, blockedDays: 30 };
    const unblockedReg = sig(computeIntent(base), REG_LABEL);
    const blockedReg = sig(computeIntent(blocked), REG_LABEL);
    expect(unblockedReg.v).toBeCloseTo(0.6, 10);
    expect(blockedReg.v).toBeLessThan(unblockedReg.v);
    // penalty caps at 0.4: 0.6 - 0.4 = 0.2
    expect(blockedReg.v).toBeCloseTo(0.2, 10);
    expect(blockedReg.v).toBeGreaterThanOrEqual(0); // never negative
  });
});

describe('bandFor thresholds', () => {
  it('classifies at the 70/40 boundaries', () => {
    expect(bandFor(70)).toBe('Hot');
    expect(bandFor(69)).toBe('Warm');
    expect(bandFor(40)).toBe('Warm');
    expect(bandFor(39)).toBe('Cold');
    expect(bandFor(0)).toBe('Cold');
    expect(bandFor(null)).toBe('Cold');
  });
});

describe('ats-intent API surface', () => {
  it('exports computeIntent, INTENT_WEIGHTS and bandFor', () => {
    expect(typeof computeIntent).toBe('function');
    expect(typeof bandFor).toBe('function');
    expect(Array.isArray(INTENT_WEIGHTS)).toBe(true);
    expect(INTENT_WEIGHTS.length).toBe(7);
  });
  it('INTENT_WEIGHTS sum to 100', () => {
    expect(INTENT_WEIGHTS.reduce((a, b) => a + b, 0)).toBe(100);
  });
  // touch NOW so the frozen-clock import is exercised like the sibling suites.
  it('frozen clock is the 2026-06-14 fixture instant', () => {
    expect(NOW).toBe(Date.UTC(2026, 5, 14, 12, 0, 0));
  });
});

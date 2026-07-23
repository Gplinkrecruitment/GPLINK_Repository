import { describe, it, expect } from 'vitest';
import { identityRetentionDue, SIX_MONTHS_MS, TWELVE_MONTHS_MS } from '../lib/identity-retention.js';

const DAY = 24 * 60 * 60 * 1000;

describe('identityRetentionDue (lib/identity-retention.js) — pure function, real unit tests', () => {
  it('is due at exactly 182 days (6 months) after placement, reason "placement"', () => {
    const nowMs = 1000 * DAY;
    const placedAtMs = nowMs - SIX_MONTHS_MS;
    expect(identityRetentionDue({ placedAtMs, lastActiveMs: nowMs, nowMs })).toEqual({ due: true, reason: 'placement' });
  });

  it('is NOT due before 182 days after placement', () => {
    const nowMs = 1000 * DAY;
    const placedAtMs = nowMs - (181 * DAY);
    expect(identityRetentionDue({ placedAtMs, lastActiveMs: nowMs, nowMs }).due).toBe(false);
  });

  it('is due at exactly 365 days (12 months) of inactivity, reason "inactivity"', () => {
    const nowMs = 1000 * DAY;
    const lastActiveMs = nowMs - TWELVE_MONTHS_MS;
    expect(identityRetentionDue({ placedAtMs: 0, lastActiveMs, nowMs })).toEqual({ due: true, reason: 'inactivity' });
  });

  it('is NOT due before 365 days of inactivity', () => {
    const nowMs = 1000 * DAY;
    const lastActiveMs = nowMs - (364 * DAY);
    expect(identityRetentionDue({ placedAtMs: 0, lastActiveMs, nowMs }).due).toBe(false);
  });

  it('is not due when neither the placement nor the inactivity threshold is met', () => {
    const nowMs = 1000 * DAY;
    expect(identityRetentionDue({ placedAtMs: nowMs - 100 * DAY, lastActiveMs: nowMs - 100 * DAY, nowMs }))
      .toEqual({ due: false, reason: null });
  });

  it('is not due when placedAtMs and lastActiveMs are both falsy (no placement, no activity signal)', () => {
    const nowMs = 1000 * DAY;
    expect(identityRetentionDue({ placedAtMs: 0, lastActiveMs: 0, nowMs })).toEqual({ due: false, reason: null });
  });

  it('placement takes precedence when both the placement and inactivity thresholds are met', () => {
    const nowMs = 1000 * DAY;
    const placedAtMs = nowMs - SIX_MONTHS_MS;
    const lastActiveMs = nowMs - TWELVE_MONTHS_MS;
    expect(identityRetentionDue({ placedAtMs, lastActiveMs, nowMs })).toEqual({ due: true, reason: 'placement' });
  });
});

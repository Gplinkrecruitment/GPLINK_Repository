// 2026-11-08: the owner's chase settings from the Ads hub (lib/automation-
// actions consultOverrides) move the three not_booked steps and the owner
// page; the constants stand for everything else, and for every other sequence.
import { createRequire } from 'module';
import { describe, expect, it, afterEach } from 'vitest';

const require = createRequire(import.meta.url);
const { CONSULT_NUDGE_SCHEDULE_MS, setConsultRuntime, nudgeSchedule, nextConsultNudge, consultOwnerAlertDecision } = require('../lib/consult-lead.js');

const MIN = 60 * 1000;
const H = 60 * MIN;
const t0 = Date.parse('2026-11-08T09:00:00Z');

afterEach(() => { setConsultRuntime({}); });

describe('owner chase settings from the Ads hub', () => {
  it('moves the step times and keeps the catch-up floor inside the new gaps', () => {
    setConsultRuntime({ step1Ms: 2 * MIN, step2Ms: 30 * MIN, step3Ms: 36 * H, ownerAlertAfterMs: 10 * MIN });
    const s = nudgeSchedule('not_booked');
    expect(s.map((x) => x.after)).toEqual([2 * MIN, 30 * MIN, 36 * H]);
    expect(s[1].gapBefore).toBe(28 * MIN);
    expect(s[2].gapBefore).toBe(12 * H);
    expect(s[0].wa).toBe('hello_5m');
    expect(nudgeSchedule('booked_no_signup')).toBe(CONSULT_NUDGE_SCHEDULE_MS.booked_no_signup);
    const base = { consult: { call_booked: false, qualified: true, nudges: [] }, createdAtMs: t0 };
    expect(nextConsultNudge({ ...base, nowMs: t0 + 1 * MIN })).toBe(null);
    expect(nextConsultNudge({ ...base, nowMs: t0 + 2 * MIN })).toEqual({ seq: 'not_booked', step: 0, email: false, wa: 'hello_5m' });
    const afterStep0 = { consult: { call_booked: false, qualified: true, nudges: [{ seq: 'not_booked', step: 0, sent_at: new Date(t0 + 2 * MIN).toISOString() }] }, createdAtMs: t0 };
    expect(nextConsultNudge({ ...afterStep0, nowMs: t0 + 29 * MIN })).toBe(null);
    expect(nextConsultNudge({ ...afterStep0, nowMs: t0 + 30 * MIN })).toEqual({ seq: 'not_booked', step: 1, email: true, wa: 'check_in_1h' });
  });

  it('pages the owner after the new delay, and resets cleanly to the constants', () => {
    setConsultRuntime({ step1Ms: 2 * MIN, step2Ms: 30 * MIN, step3Ms: 36 * H, ownerAlertAfterMs: 10 * MIN });
    const afterStep1 = { consult: { call_booked: false, qualified: true, nudges: [
      { seq: 'not_booked', step: 0, sent_at: new Date(t0 + 2 * MIN).toISOString() },
      { seq: 'not_booked', step: 1, sent_at: new Date(t0 + 30 * MIN).toISOString() }
    ] }, createdAtMs: t0 };
    expect(consultOwnerAlertDecision({ ...afterStep1, nowMs: t0 + 39 * MIN })).toEqual({ action: 'skip', reason: 'not_yet' });
    expect(consultOwnerAlertDecision({ ...afterStep1, nowMs: t0 + 40 * MIN })).toEqual({ action: 'send', replied: false });
    setConsultRuntime({});
    expect(nudgeSchedule('not_booked')).toBe(CONSULT_NUDGE_SCHEDULE_MS.not_booked);
    const base = { consult: { call_booked: false, qualified: true, nudges: [] }, createdAtMs: t0 };
    expect(nextConsultNudge({ ...base, nowMs: t0 + 4 * MIN })).toBe(null);
    expect(nextConsultNudge({ ...base, nowMs: t0 + 5 * MIN })).toEqual({ seq: 'not_booked', step: 0, email: false, wa: 'hello_5m' });
    expect(consultOwnerAlertDecision({ ...afterStep1, nowMs: t0 + 49 * MIN })).toEqual({ action: 'skip', reason: 'not_yet' });
    expect(consultOwnerAlertDecision({ ...afterStep1, nowMs: t0 + 50 * MIN })).toEqual({ action: 'send', replied: false });
  });
});

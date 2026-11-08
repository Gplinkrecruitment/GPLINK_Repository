// 2026-11-08: the owner's Ads-hub settings (lib/automation-actions) reach the
// dialler through setLeadCallRuntime: attempts, retry gap, first-call delay,
// calling hours, and a retry that waits for a different part of the day.
import { describe, it, expect, afterEach } from 'vitest';
import {
  parseLeadCallConfig, leadCallDecision, setLeadCallRuntime, leadCallWindows, dayPart, CALL_WINDOWS
} from '../lib/lead-calls.js';

// Tuesday 2026-10-27 11:00 UTC = 11:00 London (GMT).
const TUE_11_UTC = Date.parse('2026-10-27T11:00:00Z');

const CFG = parseLeadCallConfig({
  LEAD_CALLS_ENABLED: 'true',
  RETELL_API_KEY: 'key_test',
  RETELL_AGENT_ID: 'agent_1',
  RETELL_FROM_NUMBER_UK: '+442030000000',
  RETELL_FROM_NUMBER_AU: '+61280000000'
}, { ignoreRuntime: true });

function lead(over = {}) {
  const base = {
    id: 'lead-1', kind: 'gp', name: 'Dr Sarah Patel', email: 'sarah@nhs.net', phone: '+44 7700 900123', state: 'uk', status: 'new',
    created_at: new Date(TUE_11_UTC - 30 * 60000).toISOString(),
    metadata: { source: 'meta_lead_ad', consult: { qualified: true, is_gp: true, country: 'uk', call_booked: false } }
  };
  const r = Object.assign({}, base, over);
  if (over.consult) r.metadata = { source: 'meta_lead_ad', consult: Object.assign({}, base.metadata.consult, over.consult) };
  return r;
}

const custom = { weekday: [7 * 60 + 30, 20 * 60], saturday: [10 * 60, 18 * 60], sunday: [10 * 60, 18 * 60] };

afterEach(() => { setLeadCallRuntime({}); });

describe('owner settings from the Ads hub', () => {
  it('runtime overrides beat the environment for the levers they name, and ignoreRuntime reads the env alone', () => {
    setLeadCallRuntime({ maxAttempts: 3, retryAfterMs: 60 * 60000, minLeadAgeMs: 10 * 60000, callWindows: custom, varyRetryTime: true, textAfterMissedCall: true });
    const c = parseLeadCallConfig({ LEAD_CALLS_MAX_ATTEMPTS: '2', LEAD_CALLS_RETRY_AFTER_MIN: '180' });
    expect(c.maxAttempts).toBe(3);
    expect(c.retryAfterMs).toBe(3600000);
    expect(c.minLeadAgeMs).toBe(600000);
    expect(c.callWindows).toBe(custom);
    expect(c.varyRetryTime).toBe(true);
    expect(c.textAfterMissedCall).toBe(true);
    const env = parseLeadCallConfig({ LEAD_CALLS_MAX_ATTEMPTS: '2', LEAD_CALLS_RETRY_AFTER_MIN: '180' }, { ignoreRuntime: true });
    expect(env.maxAttempts).toBe(2);
    expect(env.retryAfterMs).toBe(180 * 60000);
    expect(env.callWindows).toBeNull();
    expect(env.varyRetryTime).toBe(false);
    setLeadCallRuntime({});
    expect(parseLeadCallConfig({}).callWindows).toBeNull();
    expect(parseLeadCallConfig({}).maxAttempts).toBe(2);
  });

  it('custom calling hours open the dialler at 07:45 London, which the default hours keep shut', () => {
    const at0745 = TUE_11_UTC - 3 * 3600000 - 15 * 60000;
    const row = lead({ created_at: new Date(at0745 - 30 * 60000).toISOString() });
    expect(leadCallDecision({ row, nowMs: at0745, cfg: CFG }).reason).toBe('outside_hours');
    const cfg = Object.assign({}, CFG, { callWindows: custom });
    expect(leadCallWindows({ row, nowMs: at0745, cfg })).toBe(custom);
    expect(leadCallWindows({ row, nowMs: at0745, cfg: CFG })).toBe(CALL_WINDOWS);
    expect(leadCallDecision({ row, nowMs: at0745, cfg }).action).toBe('call');
  });

  it('retry at a different time of day: a morning voicemail is not rung again that morning, but is in the afternoon', () => {
    const cfg = Object.assign({}, CFG, { varyRetryTime: true });
    const missed = (completedMs) => lead({ consult: {
      ai_call: { call_id: 'c1', attempt: 1, outcome: 'voicemail', status: 'ended', started_at: new Date(completedMs - 60000).toISOString(), completed_at: new Date(completedMs).toISOString() },
      ai_calls: [{ call_id: 'c1', attempt: 1, outcome: 'voicemail', started_at: new Date(completedMs - 60000).toISOString(), completed_at: new Date(completedMs).toISOString() }]
    } });
    // Missed at 07:00 London, now 11:00 London: four hours later (the three-hour gap has passed) but still the morning.
    const morning = missed(TUE_11_UTC - 4 * 3600000);
    expect(leadCallDecision({ row: morning, nowMs: TUE_11_UTC, cfg }).reason).toBe('same_time_of_day');
    expect(leadCallDecision({ row: morning, nowMs: TUE_11_UTC, cfg: CFG }).action).toBe('call');
    // Now 14:00 London: the afternoon, so the retry goes.
    expect(leadCallDecision({ row: morning, nowMs: TUE_11_UTC + 3 * 3600000, cfg }).action).toBe('call');
    expect(dayPart(TUE_11_UTC, 'Europe/London')).toBe('morning');
    expect(dayPart(TUE_11_UTC + 3 * 3600000, 'Europe/London')).toBe('afternoon');
    expect(dayPart(TUE_11_UTC + 7 * 3600000, 'Europe/London')).toBe('evening');
  });
});

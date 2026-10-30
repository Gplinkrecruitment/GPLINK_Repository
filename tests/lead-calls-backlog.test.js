// Backlog windows, imported Zoho leads and the one-call-at-a-time helper in
// lib/lead-calls.js, plus the nudge gate for imported leads in lib/consult-lead.js.
import { describe, it, expect } from 'vitest';
import { parseLeadCallConfig, leadCallDecision, leadCallPlan, isWithinCallWindow, BACKLOG_WINDOWS, CALL_WINDOWS, leadCallWindows, callInFlight, isAgeExemptSource, buildLeadCallVariables, setLeadCallRuntime } from '../lib/lead-calls.js';
import { nextConsultNudge } from '../lib/consult-lead.js';

const TZ = 'Europe/London';
const at = (iso) => Date.parse(iso);
const H = 3600000, D = 86400000;
// 2026-11-02 is a Monday, 2026-11-07 a Saturday; GMT is in force.
const MON_10 = at('2026-11-02T10:00:00Z');
const MON_18 = at('2026-11-02T18:00:00Z');
const cfg = parseLeadCallConfig({ RETELL_FROM_NUMBER_UK: '+442030000000', LEAD_CALLS_MAX_LEAD_AGE_DAYS: '120' });
function lead(over, consultOver) {
  return Object.assign({
    id: 'l1', kind: 'gp', name: 'Dr Amy Jones', email: 'amy@example.co.uk', phone: '+447700900123', state: 'uk', status: 'new',
    created_at: new Date(MON_10 - 1 * H).toISOString(),
    metadata: { source: 'meta_lead_ad', consult: Object.assign({ qualified: true, is_gp: null, country: 'uk', call_booked: false, nudges: [] }, consultOver || {}) }
  }, over || {});
}

describe('backlog windows', () => {
  it('are lunch and evening on weekdays, 10 to 6 at the weekend', () => {
    expect(isWithinCallWindow(at('2026-11-02T10:00:00Z'), TZ, BACKLOG_WINDOWS)).toBe(false);
    expect(isWithinCallWindow(at('2026-11-02T12:45:00Z'), TZ, BACKLOG_WINDOWS)).toBe(true);
    expect(isWithinCallWindow(at('2026-11-02T13:30:00Z'), TZ, BACKLOG_WINDOWS)).toBe(false);
    expect(isWithinCallWindow(at('2026-11-02T17:30:00Z'), TZ, BACKLOG_WINDOWS)).toBe(true);
    expect(isWithinCallWindow(at('2026-11-02T19:30:00Z'), TZ, BACKLOG_WINDOWS)).toBe(false);
    expect(isWithinCallWindow(at('2026-11-07T11:00:00Z'), TZ, BACKLOG_WINDOWS)).toBe(true);
    expect(isWithinCallWindow(at('2026-11-07T14:00:00Z'), TZ, BACKLOG_WINDOWS)).toBe(true);
    expect(isWithinCallWindow(at('2026-11-07T18:30:00Z'), TZ, BACKLOG_WINDOWS)).toBe(false);
    expect(isWithinCallWindow(at('2026-11-08T11:00:00Z'), TZ, BACKLOG_WINDOWS)).toBe(true);
    expect(isWithinCallWindow(at('2026-11-08T09:00:00Z'), TZ, BACKLOG_WINDOWS)).toBe(false);
    // The wide window is untouched for fresh leads.
    expect(isWithinCallWindow(at('2026-11-02T10:00:00Z'), TZ, CALL_WINDOWS)).toBe(true);
  });

  it('apply to leads older than a day; fresh leads and due call-backs keep the wide window', () => {
    const fresh = lead();
    const old = lead({ created_at: new Date(MON_10 - 3 * D).toISOString() });
    expect(leadCallWindows({ row: fresh, nowMs: MON_10, cfg })).toBe(CALL_WINDOWS);
    expect(leadCallWindows({ row: old, nowMs: MON_10, cfg })).toBe(BACKLOG_WINDOWS);
    expect(leadCallWindows({ row: old, nowMs: MON_10, cfg, due: true })).toBe(CALL_WINDOWS);
    expect(leadCallDecision({ row: fresh, nowMs: MON_10, cfg })).toMatchObject({ action: 'call', windows: 'fresh' });
    expect(leadCallDecision({ row: old, nowMs: MON_10, cfg })).toEqual({ action: 'skip', reason: 'outside_hours', windows: 'backlog' });
    expect(leadCallDecision({ row: old, nowMs: MON_18, cfg })).toMatchObject({ action: 'call', windows: 'backlog' });
    const cb = lead({ created_at: new Date(MON_10 - 3 * D).toISOString() }, { call_back_at: new Date(MON_10 - 60000).toISOString() });
    expect(leadCallDecision({ row: cb, nowMs: MON_10, cfg })).toMatchObject({ action: 'call', windows: 'fresh' });
    const off = parseLeadCallConfig({ RETELL_FROM_NUMBER_UK: '+442030000000', LEAD_CALLS_MAX_LEAD_AGE_DAYS: '120', LEAD_CALLS_BACKLOG_WINDOWS: 'false' });
    expect(leadCallDecision({ row: old, nowMs: MON_10, cfg: off })).toMatchObject({ action: 'call', windows: 'fresh' });
  });

  it('the Leads tab plan points at the next backlog window', () => {
    const old = lead({ created_at: new Date(MON_10 - 3 * D).toISOString() });
    const p = leadCallPlan({ row: old, nowMs: MON_10, cfg });
    expect(p.state).toBe('queued');
    expect(p.due_at).toBe('2026-11-02T12:30:00.000Z');
    expect(p.detail).toContain('past lead');
    const fresh = leadCallPlan({ row: lead(), nowMs: MON_10, cfg });
    expect(fresh.state).toBe('queued');
    expect(fresh.due_at).toBe(new Date(MON_10).toISOString());
  });
});

describe('imported Zoho leads', () => {
  const zohoOn = parseLeadCallConfig({ RETELL_FROM_NUMBER_UK: '+442030000000', LEAD_CALLS_MAX_LEAD_AGE_DAYS: '120', LEAD_CALLS_ZOHO_ENABLED: 'true' });
  it('are exempt from the age limit; everyone else is not', () => {
    const zoho = lead({ created_at: new Date(MON_18 - 200 * D).toISOString(), metadata: { source: 'zoho_import', consult: { qualified: true, is_gp: null, country: 'uk', call_booked: false, nudges: [] } } });
    const meta = lead({ created_at: new Date(MON_18 - 200 * D).toISOString() });
    expect(isAgeExemptSource(zoho)).toBe(true);
    expect(isAgeExemptSource(meta)).toBe(false);
    expect(leadCallDecision({ row: zoho, nowMs: MON_18, cfg: zohoOn })).toMatchObject({ action: 'call', windows: 'backlog' });
    expect(leadCallDecision({ row: meta, nowMs: MON_18, cfg: zohoOn })).toEqual({ action: 'skip', reason: 'too_old' });
  });

  it('wait for the owner\'s Start button; an owner call-back still rings', () => {
    const zoho = lead({ created_at: new Date(MON_18 - 200 * D).toISOString(), metadata: { source: 'zoho_import', consult: { qualified: true, is_gp: null, country: 'uk', call_booked: false, nudges: [] } } });
    expect(leadCallDecision({ row: zoho, nowMs: MON_18, cfg })).toEqual({ action: 'skip', reason: 'zoho_not_started' });
    const p = leadCallPlan({ row: zoho, nowMs: MON_18, cfg });
    expect(p.state).toBe('blocked');
    expect(p.label).toContain('start the Zoho calls');
    setLeadCallRuntime({ zohoCallsEnabled: true });
    try { expect(leadCallDecision({ row: zoho, nowMs: MON_18, cfg: parseLeadCallConfig({ RETELL_FROM_NUMBER_UK: '+442030000000' }) })).toMatchObject({ action: 'call' }); }
    finally { setLeadCallRuntime({}); }
    const cb = lead({ created_at: new Date(MON_18 - 200 * D).toISOString(), metadata: { source: 'zoho_import', consult: { qualified: true, is_gp: null, country: 'uk', call_booked: false, nudges: [], call_back_at: new Date(MON_18 - 60000).toISOString() } } });
    expect(leadCallDecision({ row: cb, nowMs: MON_18, cfg })).toMatchObject({ action: 'call' });
  });

  it('tell Hayley they registered a while back', () => {
    const zoho = lead({ created_at: '2026-07-05T00:00:00Z', metadata: { source: 'zoho_import', consult: { country: 'uk' } } });
    const v = buildLeadCallVariables({ row: zoho, nowMs: MON_18 });
    expect(v.enquiry_when).toBe('a while back');
    expect(v.enquiry_source).toBe('your earlier registration with GP Link');
    expect(buildLeadCallVariables({ row: lead(), nowMs: MON_10 }).enquiry_source).toBe('a Facebook ad');
  });

  it('get no pre-booking nudges, but a booked one still gets the sign-up drip', () => {
    const now = Date.now();
    const base = { qualified: true, is_gp: null, country: 'uk', call_booked: false, nudges: [] };
    expect(nextConsultNudge({ consult: base, nowMs: now, createdAtMs: now - 3 * D })).toBeTruthy();
    expect(nextConsultNudge({ consult: Object.assign({}, base, { nudges_disabled: 'not_booked' }), nowMs: now, createdAtMs: now - 3 * D })).toBe(null);
    expect(nextConsultNudge({ consult: Object.assign({}, base, { nudges_disabled: true }), nowMs: now, createdAtMs: now - 3 * D })).toBe(null);
    const plainBooked = nextConsultNudge({ consult: Object.assign({}, base, { call_booked: true, call_booked_at: new Date(now - 5 * D).toISOString() }), nowMs: now, createdAtMs: now - 10 * D, callAtMs: now - 4 * D, callCompletedMs: now - 4 * D });
    const importedBooked = nextConsultNudge({ consult: Object.assign({}, base, { nudges_disabled: 'not_booked', call_booked: true, call_booked_at: new Date(now - 5 * D).toISOString() }), nowMs: now, createdAtMs: now - 10 * D, callAtMs: now - 4 * D, callCompletedMs: now - 4 * D });
    expect(importedBooked).toEqual(plainBooked);
  });
});

describe('callInFlight', () => {
  it('is a registered or ongoing call younger than 15 minutes with no completion', () => {
    const now = Date.now();
    const mk = (ai) => lead({}, { ai_call: ai });
    expect(callInFlight(mk({ call_id: 'c', status: 'registered', started_at: new Date(now - 2 * 60000).toISOString() }), now)).toBe(true);
    expect(callInFlight(mk({ call_id: 'c', status: 'ongoing', started_at: new Date(now - 10 * 60000).toISOString() }), now)).toBe(true);
    expect(callInFlight(mk({ call_id: 'c', status: 'ended', started_at: new Date(now - 2 * 60000).toISOString(), completed_at: new Date(now - 60000).toISOString() }), now)).toBe(false);
    expect(callInFlight(mk({ call_id: 'c', status: 'registered', started_at: new Date(now - 20 * 60000).toISOString() }), now)).toBe(false);
    expect(callInFlight(lead(), now)).toBe(false);
  });
});

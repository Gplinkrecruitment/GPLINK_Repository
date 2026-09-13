// Pure-logic coverage for lib/meta-capi.js — the Meta Conversions API for CRM
// lead-stage feed. Same CJS interop as tests/consult-lead.test.js. The sender
// is exercised through an injected fetchImpl (the newer lib convention, see
// tests/ai-candidate-job-match.test.js): no network, no global fetch patching.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const capi = require('../lib/meta-capi.js');

const NOW = Date.parse('2026-09-14T00:00:00Z');
const DAY = 86400000;
// 16 digits and below 2^53, so JSON.parse in assertions keeps it exact.
const LEAD_ID = '1432788012009668';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function row(overrides = {}, consult = {}) {
  return Object.assign({
    id: 'row-1',
    created_at: new Date(NOW - 2 * DAY).toISOString(),
    kind: 'gp',
    status: 'new',
    email: 'Aisha@Example.co.uk',
    phone: '+44 7700 900123',
    metadata: {
      source: 'meta_lead_ad',
      fb_lead_id: LEAD_ID,
      consult: Object.assign({ qualified: true, is_gp: true, country: 'uk', call_booked: false, nudges: [] }, consult)
    }
  }, overrides);
}

function cfg(extra = {}) {
  return capi.metaCapiConfigFromEnv(Object.assign({
    META_CAPI_DATASET_ID: '31126391376976338',
    META_CAPI_ACCESS_TOKEN: 'tok-123',
    FB_GRAPH_VERSION: 'v26.0'
  }, extra));
}

// A fetch stand-in that records the call and answers like Meta.
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const out = handler ? handler(calls[calls.length - 1]) : null;
    const status = (out && out.status) || 200;
    const json = (out && out.json) || { events_received: calls[calls.length - 1].body.data.length, fbtrace_id: 'trace' };
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  return { impl, calls };
}

describe('metaCapiConfigFromEnv', () => {
  it('is null until both the dataset id and the token are set', () => {
    expect(capi.metaCapiConfigFromEnv({})).toBeNull();
    expect(capi.metaCapiConfigFromEnv({ META_CAPI_DATASET_ID: '123' })).toBeNull();
    expect(capi.metaCapiConfigFromEnv({ META_CAPI_ACCESS_TOKEN: 'x' })).toBeNull();
    expect(capi.metaCapiConfigFromEnv({ META_CAPI_DATASET_ID: 'not-a-number', META_CAPI_ACCESS_TOKEN: 'x' })).toBeNull();
  });

  it('fills defaults and trims what it is given', () => {
    const c = capi.metaCapiConfigFromEnv({ META_CAPI_DATASET_ID: ' 31126391376976338 ', META_CAPI_ACCESS_TOKEN: ' tok ' });
    expect(c).toEqual({
      datasetId: '31126391376976338',
      accessToken: 'tok',
      testEventCode: null,
      apiVersion: 'v26.0',
      graphBase: 'https://graph.facebook.com',
      leadEventSource: 'GP Link app'
    });
  });

  it('honours the overrides (graph url without trailing slash, version, test code, source name)', () => {
    const c = capi.metaCapiConfigFromEnv({
      META_CAPI_DATASET_ID: '1', META_CAPI_ACCESS_TOKEN: 't',
      META_CAPI_GRAPH_URL: 'http://127.0.0.1:9/', META_CAPI_API_VERSION: 'v27.0',
      META_CAPI_TEST_EVENT_CODE: 'TEST123', META_CAPI_LEAD_EVENT_SOURCE: 'My CRM'
    });
    expect(c.graphBase).toBe('http://127.0.0.1:9');
    expect(c.apiVersion).toBe('v27.0');
    expect(c.testEventCode).toBe('TEST123');
    expect(c.leadEventSource).toBe('My CRM');
  });
});

describe('isMetaLeadStageCandidate', () => {
  it('accepts a recent Meta lead with a real lead id', () => {
    expect(capi.isMetaLeadStageCandidate(row(), NOW)).toBe(true);
  });

  it('rejects website leads, practice rows, fixture ids and leads without funnel state', () => {
    expect(capi.isMetaLeadStageCandidate(row({ metadata: { source: 'site_start_form', fb_lead_id: LEAD_ID, consult: {} } }), NOW)).toBe(false);
    expect(capi.isMetaLeadStageCandidate(row({ kind: 'practice' }), NOW)).toBe(false);
    expect(capi.isMetaLeadStageCandidate(row({ metadata: { source: 'meta_lead_ad', fb_lead_id: 'L-1001', consult: {} } }), NOW)).toBe(false);
    expect(capi.isMetaLeadStageCandidate(row({ metadata: { source: 'meta_lead_ad', fb_lead_id: LEAD_ID } }), NOW)).toBe(false);
    expect(capi.isMetaLeadStageCandidate(null, NOW)).toBe(false);
  });

  it('leaves leads older than 35 days alone', () => {
    expect(capi.isMetaLeadStageCandidate(row({ created_at: new Date(NOW - 36 * DAY).toISOString() }), NOW)).toBe(false);
    expect(capi.isMetaLeadStageCandidate(row({ created_at: new Date(NOW - 34 * DAY).toISOString() }), NOW)).toBe(true);
    expect(capi.isMetaLeadStageCandidate(row({ created_at: 'garbage' }), NOW)).toBe(false);
  });
});

describe('deriveMetaLeadStages', () => {
  it('a stored but screened-out lead is only the raw lead stage', () => {
    const r = row({}, { qualified: false, screened_out: true });
    expect(capi.deriveMetaLeadStages(r, { now: NOW })).toEqual([{ stage: 'lead', at: r.created_at }]);
  });

  it('a qualified lead adds qualified_gp at intake time', () => {
    const r = row();
    expect(capi.deriveMetaLeadStages(r, { now: NOW }).map((s) => s.stage)).toEqual(['lead', 'qualified_gp']);
    expect(capi.deriveMetaLeadStages(r, { now: NOW })[1].at).toBe(r.created_at);
  });

  it('a re-screened lead dates qualified_gp to the re-screen, not intake', () => {
    const r = row({}, { rescreened_at: '2026-09-13T10:00:00.000Z' });
    expect(capi.deriveMetaLeadStages(r, { now: NOW })[1]).toEqual({ stage: 'qualified_gp', at: '2026-09-13T10:00:00.000Z' });
  });

  it('a booking adds call_booked at the booking time (either flag form)', () => {
    const at = '2026-09-13T09:00:00.000Z';
    expect(capi.deriveMetaLeadStages(row({}, { call_booked: true, call_booked_at: at }), { now: NOW }).pop()).toEqual({ stage: 'call_booked', at });
    expect(capi.deriveMetaLeadStages(row({}, { call_booked_at: at }), { now: NOW }).pop()).toEqual({ stage: 'call_booked', at });
    expect(capi.deriveMetaLeadStages(row({}, { call_booked: true }), { now: NOW }).pop()).toEqual({ stage: 'call_booked', at: new Date(NOW).toISOString() });
  });

  it('signed_up comes from the nudge stamp, the converted status, or the caller, dated to observation', () => {
    const nowIso = new Date(NOW).toISOString();
    expect(capi.deriveMetaLeadStages(row({}, { stopped: 'signed_up' }), { now: NOW }).pop()).toEqual({ stage: 'signed_up', at: nowIso });
    expect(capi.deriveMetaLeadStages(row({ status: 'converted' }), { now: NOW }).pop()).toEqual({ stage: 'signed_up', at: nowIso });
    expect(capi.deriveMetaLeadStages(row(), { now: NOW, signedUp: true }).pop()).toEqual({ stage: 'signed_up', at: nowIso });
    expect(capi.deriveMetaLeadStages(row({}, { stopped: 'exhausted' }), { now: NOW }).map((s) => s.stage)).toEqual(['lead', 'qualified_gp']);
  });
});

describe('pendingMetaLeadStages', () => {
  it('drops the stages already stamped as sent', () => {
    const r = row({}, { call_booked: true, call_booked_at: '2026-09-13T09:00:00.000Z', meta_capi: { sent: { lead: 'x', qualified_gp: 'x' } } });
    expect(capi.pendingMetaLeadStages(r, { now: NOW }).map((s) => s.stage)).toEqual(['call_booked']);
    expect(capi.sentMetaLeadStages(r)).toEqual({ lead: 'x', qualified_gp: 'x' });
    expect(capi.sentMetaLeadStages(row())).toEqual({});
  });
});

describe('identifier normalisation', () => {
  it('emails are lower-cased and trimmed; non-emails are dropped', () => {
    expect(capi.normalizeEmailForMeta(' Aisha@Example.co.uk ')).toBe('aisha@example.co.uk');
    expect(capi.normalizeEmailForMeta('not an email')).toBeNull();
    expect(capi.normalizeEmailForMeta('')).toBeNull();
  });

  it('phones become E.164 digits, using the screened country for national format', () => {
    expect(capi.normalizePhoneForMeta('+44 7700 900123')).toBe('447700900123');
    expect(capi.normalizePhoneForMeta('0044 7700 900123')).toBe('447700900123');
    expect(capi.normalizePhoneForMeta('07700 900123', 'uk')).toBe('447700900123');
    expect(capi.normalizePhoneForMeta('021 123 4567', 'nz')).toBe('64211234567');
    expect(capi.normalizePhoneForMeta('07700 900123', 'other')).toBeNull();
    expect(capi.normalizePhoneForMeta('07700 900123')).toBeNull();
    expect(capi.normalizePhoneForMeta('12345')).toBeNull();
    expect(capi.normalizePhoneForMeta('')).toBeNull();
  });
});

describe('buildMetaLeadStageEvents', () => {
  it('shapes each stage as a CRM event keyed by the lead id, with hashed email and phone alongside', () => {
    const r = row();
    const stages = capi.deriveMetaLeadStages(r, { now: NOW });
    const events = capi.buildMetaLeadStageEvents(r, stages, cfg(), { now: NOW });
    expect(events.map((e) => e.event_name)).toEqual(['lead', 'qualified_gp']);
    for (const e of events) {
      expect(e.action_source).toBe('system_generated');
      expect(e.custom_data).toEqual({ lead_event_source: 'GP Link app', event_source: 'crm' });
      expect(e.event_id).toBe(LEAD_ID + ':' + e.event_name);
      expect(e.user_data.lead_id).toBe(LEAD_ID);
      expect(e.user_data.em).toEqual([sha('aisha@example.co.uk')]);
      expect(e.user_data.ph).toEqual([sha('447700900123')]);
      expect(e.event_time).toBe(Math.floor(Date.parse(r.created_at) / 1000));
    }
  });

  it('omits an identifier it cannot normalise instead of hashing junk', () => {
    const r = row({ email: 'n/a', phone: '07700 900123' }, { country: 'other' });
    const [e] = capi.buildMetaLeadStageEvents(r, [{ stage: 'lead', at: r.created_at }], cfg(), { now: NOW });
    expect(e.user_data).toEqual({ lead_id: LEAD_ID });
  });

  it('clamps event_time into the window Meta accepts', () => {
    const c = cfg();
    const nowSec = Math.floor(NOW / 1000);
    const floorSec = Math.floor((NOW - capi.MAX_EVENT_AGE_MS) / 1000);
    // Older than the 6-day floor → floor (a backfilled lead from last month).
    const old = row({ created_at: new Date(NOW - 30 * DAY).toISOString() });
    expect(capi.buildMetaLeadStageEvents(old, [{ stage: 'lead', at: old.created_at }], c, { now: NOW })[0].event_time).toBe(floorSec);
    // In the future (clock skew) → now.
    expect(capi.buildMetaLeadStageEvents(row(), [{ stage: 'call_booked', at: new Date(NOW + DAY).toISOString() }], c, { now: NOW })[0].event_time).toBe(nowSec);
    // Before the lead itself → the lead's own time (Meta discards earlier stamps).
    const r = row();
    expect(capi.buildMetaLeadStageEvents(r, [{ stage: 'call_booked', at: new Date(NOW - 10 * DAY).toISOString() }], c, { now: NOW })[0].event_time)
      .toBe(Math.floor(Date.parse(r.created_at) / 1000));
    // Unparseable → now.
    expect(capi.buildMetaLeadStageEvents(r, [{ stage: 'signed_up', at: 'garbage' }], c, { now: NOW })[0].event_time).toBe(nowSec);
  });

  it('returns nothing for a row without a usable lead id', () => {
    expect(capi.buildMetaLeadStageEvents(row({ metadata: { source: 'meta_lead_ad', fb_lead_id: 'L-1', consult: {} } }), [{ stage: 'lead', at: 'x' }], cfg(), { now: NOW })).toEqual([]);
  });
});

describe('serializeMetaCapiBody', () => {
  it('writes lead_id as an integer literal (past 2^53, a JS number would be corrupted)', () => {
    const big = '12345678901234567';
    const r = row({ metadata: { source: 'meta_lead_ad', fb_lead_id: big, consult: { qualified: true } } });
    const events = capi.buildMetaLeadStageEvents(r, [{ stage: 'lead', at: r.created_at }], cfg(), { now: NOW });
    const body = capi.serializeMetaCapiBody(events, cfg());
    expect(body).toContain('"lead_id":' + big);
    expect(body).not.toContain('"lead_id":"');
    expect(body).toContain('"access_token":"tok-123"');
    expect(body).not.toContain('test_event_code');
  });

  it('carries the test event code only when configured', () => {
    const body = capi.serializeMetaCapiBody([], cfg({ META_CAPI_TEST_EVENT_CODE: 'TEST42' }));
    expect(JSON.parse(body)).toEqual({ data: [], access_token: 'tok-123', test_event_code: 'TEST42' });
  });
});

describe('sendMetaCapiEvents', () => {
  const events = () => capi.buildMetaLeadStageEvents(row(), capi.deriveMetaLeadStages(row(), { now: NOW }), cfg(), { now: NOW });

  it('POSTs to /{version}/{dataset}/events with the token in the body, not the URL', async () => {
    const f = fakeFetch();
    const r = await capi.sendMetaCapiEvents(events(), cfg(), { fetchImpl: f.impl });
    expect(r).toEqual({ ok: true, status: 200, eventsReceived: 2, fbtraceId: 'trace' });
    expect(f.calls.length).toBe(1);
    expect(f.calls[0].url).toBe('https://graph.facebook.com/v26.0/31126391376976338/events');
    expect(f.calls[0].init.method).toBe('POST');
    expect(f.calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(f.calls[0].body.access_token).toBe('tok-123');
    expect(f.calls[0].body.data.length).toBe(2);
  });

  it('surfaces Meta\'s error message on a rejected request', async () => {
    const f = fakeFetch(() => ({ status: 400, json: { error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 }, fbtrace_id: 'ft' } }));
    const r = await capi.sendMetaCapiEvents(events(), cfg(), { fetchImpl: f.impl });
    expect(r).toEqual({ ok: false, status: 400, error: 'Invalid parameter', eventsReceived: 0, fbtraceId: 'ft' });
  });

  it('treats a partial acknowledgement as a failure so nothing is stamped', async () => {
    const f = fakeFetch(() => ({ status: 200, json: { events_received: 1 } }));
    const r = await capi.sendMetaCapiEvents(events(), cfg(), { fetchImpl: f.impl });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('events_received 1 of 2');
  });

  it('never throws: a network failure becomes a result', async () => {
    const r = await capi.sendMetaCapiEvents(events(), cfg(), { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    expect(r).toEqual({ ok: false, error: 'ECONNRESET' });
  });

  it('is a no-op success for an empty batch and a failure when unconfigured', async () => {
    expect(await capi.sendMetaCapiEvents([], cfg(), { fetchImpl: async () => { throw new Error('must not be called'); } })).toEqual({ ok: true, status: 0, eventsReceived: 0 });
    expect(await capi.sendMetaCapiEvents(events(), null, {})).toEqual({ ok: false, error: 'not configured' });
  });
});

describe('markMetaLeadStagesSent', () => {
  it('stamps the stages and preserves everything else on metadata and consult', () => {
    const md = { source: 'meta_lead_ad', fb_lead_id: LEAD_ID, utm: { src: 'fb' }, consult: { token: 'TOK', qualified: true, nudges: [{ seq: 0 }], meta_capi: { sent: { lead: '2026-09-12T00:00:00.000Z' } } } };
    const out = capi.markMetaLeadStagesSent(md, [{ stage: 'call_booked', at: 'x' }], '2026-09-14T00:00:00.000Z');
    expect(out.consult.meta_capi).toEqual({ sent: { lead: '2026-09-12T00:00:00.000Z', call_booked: '2026-09-14T00:00:00.000Z' }, last_sent_at: '2026-09-14T00:00:00.000Z' });
    expect(out.consult.token).toBe('TOK');
    expect(out.consult.nudges).toEqual([{ seq: 0 }]);
    expect(out.utm).toEqual({ src: 'fb' });
    // The input is not mutated.
    expect(md.consult.meta_capi.sent).toEqual({ lead: '2026-09-12T00:00:00.000Z' });
  });
});

describe('syncMetaLeadStages', () => {
  it('sends the pending stages, stamps them through persist, and updates the row in memory', async () => {
    const f = fakeFetch();
    const r = row({}, { call_booked: true, call_booked_at: '2026-09-13T09:00:00.000Z', meta_capi: { sent: { lead: 'x', qualified_gp: 'x' } } });
    const persisted = [];
    const out = await capi.syncMetaLeadStages(r, { cfg: cfg(), now: NOW, fetchImpl: f.impl, persist: async (id, patch) => { persisted.push({ id, patch }); return true; } });
    expect(out).toEqual({ ok: true, sent: ['call_booked'], persisted: true, eventsReceived: 1 });
    expect(f.calls[0].body.data.map((e) => e.event_name)).toEqual(['call_booked']);
    expect(persisted.length).toBe(1);
    expect(persisted[0].id).toBe('row-1');
    expect(Object.keys(persisted[0].patch)).toEqual(['metadata']);
    expect(persisted[0].patch.metadata.consult.meta_capi.sent.call_booked).toBe(new Date(NOW).toISOString());
    expect(r.metadata.consult.meta_capi.sent.call_booked).toBe(new Date(NOW).toISOString());
    expect(r.metadata.consult.call_booked_at).toBe('2026-09-13T09:00:00.000Z');
  });

  it('adds signed_up when the caller says an account exists', async () => {
    const f = fakeFetch();
    const r = row({}, { meta_capi: { sent: { lead: 'x', qualified_gp: 'x' } } });
    const out = await capi.syncMetaLeadStages(r, { cfg: cfg(), now: NOW, signedUp: true, fetchImpl: f.impl, persist: async () => true });
    expect(out.sent).toEqual(['signed_up']);
  });

  it('does nothing when every stage is already sent', async () => {
    const f = fakeFetch();
    const r = row({}, { meta_capi: { sent: { lead: 'x', qualified_gp: 'x' } } });
    expect(await capi.syncMetaLeadStages(r, { cfg: cfg(), now: NOW, fetchImpl: f.impl, persist: async () => { throw new Error('no'); } })).toEqual({ ok: true, sent: [] });
    expect(f.calls.length).toBe(0);
  });

  it('does not stamp anything when Meta rejects the batch', async () => {
    const f = fakeFetch(() => ({ status: 400, json: { error: { message: 'Invalid OAuth access token' } } }));
    const r = row();
    let persistCalls = 0;
    const out = await capi.syncMetaLeadStages(r, { cfg: cfg(), now: NOW, fetchImpl: f.impl, persist: async () => { persistCalls++; return true; } });
    expect(out).toEqual({ ok: false, error: 'Invalid OAuth access token', status: 400, attempted: ['lead', 'qualified_gp'], sent: [] });
    expect(persistCalls).toBe(0);
    expect(r.metadata.consult.meta_capi).toBeUndefined();
  });

  it('reports a stamp that failed to persist (Meta already has the events)', async () => {
    const f = fakeFetch();
    const out = await capi.syncMetaLeadStages(row(), { cfg: cfg(), now: NOW, fetchImpl: f.impl, persist: async () => { throw new Error('db down'); } });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('stamp failed: db down');
    expect(out.sent).toEqual(['lead', 'qualified_gp']);
  });

  it('skips cleanly when unconfigured or when the row is not a recent Meta lead', async () => {
    expect(await capi.syncMetaLeadStages(row(), { cfg: null, now: NOW })).toEqual({ ok: false, skipped: 'not_configured', sent: [] });
    const web = row({ metadata: { source: 'site_start_form', consult: { qualified: true } } });
    expect(await capi.syncMetaLeadStages(web, { cfg: cfg(), now: NOW, fetchImpl: async () => { throw new Error('no'); } })).toEqual({ ok: true, skipped: 'not_eligible', sent: [] });
  });
});

// Endpoint coverage for GET /api/cron/meta-lead-stages and the FB-webhook hook
// that feeds Meta's Conversions API for CRM (lib/meta-capi.js). Boots the real
// server in LOCAL-JSON mode (same harness as tests/consult-nudge-cron.test.js)
// and points META_CAPI_GRAPH_URL at a local capture server standing in for
// graph.facebook.com, so the real webhook → sync → POST /{dataset}/events path
// is exercised over HTTP with no network and no global fetch patching.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-meta-lead-stages-${RUN_ID}.json`;
const DATASET = '31126391376976338';
const CRON = '/api/cron/meta-lead-stages';
const AUTH = { Authorization: 'Bearer test-cron-secret' };
const WH = '/api/webhooks/facebook-lead?secret=test-fb-secret';
const DAY = 86400000;
// 16 digits and below 2^53, so JSON.parse keeps it exact in assertions.
const LEAD_ID = '1432788012009668';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let server;
let addrPort;
let testUtils;
let graphServer;
let graphPort;
const graphCaptured = [];   // { url, method, body (parsed), raw }
let graphMode = 'ok';       // 'ok' | 'reject'

function request(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: addrPort,
      path,
      method,
      headers: Object.assign(
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
        headers || {}
      )
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* leave null */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.end(payload); else req.end();
  });
}
const get = (path, headers) => request('GET', path, null, headers);
const post = (path, body, headers) => request('POST', path, body, headers);

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}
function dbRow(id) {
  return (readDb().siteEnquiries || []).find((r) => r.id === id);
}

function startGraphCaptureServer() {
  return new Promise((resolve) => {
    graphServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw || 'null'); } catch { body = null; }
        graphCaptured.push({ url: req.url, method: req.method, body, raw });
        if (graphMode === 'reject') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 }, fbtrace_id: 'ft' }));
          return;
        }
        const n = body && Array.isArray(body.data) ? body.data.length : 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events_received: n, fbtrace_id: 'trace-' + n }));
      });
    });
    graphServer.listen(0, '127.0.0.1', () => { graphPort = graphServer.address().port; resolve(); });
  });
}

function lead(overrides = {}, consult = {}) {
  return Object.assign({
    id: 'lead-' + crypto.randomBytes(3).toString('hex'),
    created_at: new Date(Date.now() - 2 * DAY).toISOString(),
    kind: 'gp',
    name: 'Aisha Khan',
    email: 'aisha@example.co.uk',
    phone: '+447700900123',
    status: 'new',
    metadata: {
      source: 'meta_lead_ad',
      fb_lead_id: LEAD_ID,
      consult: Object.assign({ token: 'TOK1', qualified: true, is_gp: true, country: 'uk', call_booked: false, nudges: [] }, consult)
    }
  }, overrides);
}

// Same fixture shape as tests/fb-gp-lead-webhook.test.js, with a real-looking
// leadgen_id so the CAPI feed treats it as matchable.
function nativeFbBody(overrides = {}) {
  return {
    entry: [{
      changes: [{
        value: Object.assign({
          leadgen_id: LEAD_ID,
          form_id: 'F-77',
          ad_id: 'AD-501',
          field_data: [
            { name: 'full_name', values: ['Aisha Khan'] },
            { name: 'email', values: ['aisha@example.co.uk'] },
            { name: 'phone_number', values: ['+447700900123'] },
            { name: 'are_you_a_currently_registered_gp?', values: ['Yes'] },
            { name: 'where_are_you_registered?', values: ['United Kingdom'] },
            { name: 'whats_your_main_question?', values: ['Visa timing'] }
          ]
        }, overrides)
      }]
    }]
  };
}

beforeAll(async () => {
  await startGraphCaptureServer();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-meta-lead-stages-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  delete process.env.SITE_ENQUIRY_NOTIFY_EMAIL;
  delete process.env.RESEND_API_KEY;
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.FB_LEAD_WEBHOOK_SECRET = 'test-fb-secret';
  process.env.FB_GP_LEAD_FORM_IDS = 'F-77, F-88';
  process.env.META_CAPI_DATASET_ID = DATASET;
  process.env.META_CAPI_ACCESS_TOKEN = 'test-capi-token';
  process.env.META_CAPI_GRAPH_URL = 'http://127.0.0.1:' + graphPort;
  delete process.env.META_CAPI_TEST_EVENT_CODE;
  delete process.env.META_CAPI_API_VERSION;
  delete process.env.FB_GRAPH_VERSION;

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (graphServer) await new Promise((resolve) => graphServer.close(resolve));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

beforeEach(() => {
  testUtils.__resetSiteEnquiriesForTest();
  graphCaptured.length = 0;
  graphMode = 'ok';
});

describe('GET /api/cron/meta-lead-stages', () => {
  it('rejects a missing or wrong cron secret with 401 and sends nothing', async () => {
    testUtils.__seedSiteEnquiriesForTest([lead()]);
    expect((await get(CRON)).status).toBe(401);
    expect((await get(CRON, { Authorization: 'Bearer nope' })).status).toBe(401);
    expect(graphCaptured.length).toBe(0);
  });

  it('sends every stage a Meta lead has reached and stamps them on the row', async () => {
    const bookedAt = new Date(Date.now() - DAY).toISOString();
    testUtils.__seedSiteEnquiriesForTest([lead({ id: 'lead-booked' }, { call_booked: true, call_booked_at: bookedAt })]);

    const res = await get(CRON, AUTH);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, scanned: 1, sent: 3, failed: 0, skipped: 0, partial: false });

    expect(graphCaptured.length).toBe(1);
    const call = graphCaptured[0];
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/v26.0/' + DATASET + '/events');
    expect(call.body.access_token).toBe('test-capi-token');
    expect(call.body.test_event_code).toBeUndefined();
    expect(call.body.data.map((e) => e.event_name)).toEqual(['lead', 'qualified_gp', 'call_booked']);
    for (const e of call.body.data) {
      expect(e.action_source).toBe('system_generated');
      expect(e.custom_data).toEqual({ lead_event_source: 'GP Link app', event_source: 'crm' });
      expect(e.event_id).toBe(LEAD_ID + ':' + e.event_name);
      expect(e.user_data.lead_id).toBe(Number(LEAD_ID));
      expect(e.user_data.em).toEqual([sha('aisha@example.co.uk')]);
      expect(e.user_data.ph).toEqual([sha('447700900123')]);
    }
    // The lead id travels as an integer literal, never a string.
    expect(call.raw).toContain('"lead_id":' + LEAD_ID);
    expect(call.raw).not.toContain('"lead_id":"');
    expect(call.body.data[2].event_time).toBe(Math.floor(Date.parse(bookedAt) / 1000));

    const stamped = dbRow('lead-booked');
    expect(Object.keys(stamped.metadata.consult.meta_capi.sent).sort()).toEqual(['call_booked', 'lead', 'qualified_gp']);
    // Nothing else on the row was disturbed.
    expect(stamped.metadata.consult.token).toBe('TOK1');
    expect(stamped.metadata.consult.call_booked).toBe(true);
    expect(stamped.metadata.consult.call_booked_at).toBe(bookedAt);
    expect(stamped.metadata.fb_lead_id).toBe(LEAD_ID);
  });

  it('is idempotent: a second sweep sends nothing new', async () => {
    testUtils.__seedSiteEnquiriesForTest([lead({ id: 'lead-twice' })]);
    await get(CRON, AUTH);
    expect(graphCaptured.length).toBe(1);
    const res = await get(CRON, AUTH);
    expect(res.json).toMatchObject({ ok: true, scanned: 1, sent: 0, failed: 0 });
    expect(graphCaptured.length).toBe(1);
  });

  it('picks up a booking that happened after the first sweep', async () => {
    testUtils.__seedSiteEnquiriesForTest([lead({ id: 'lead-late-book' })]);
    await get(CRON, AUTH);
    graphCaptured.length = 0;
    // The Calendly webhook / the /start booked endpoint write these two fields.
    const bookedAt = new Date().toISOString();
    await testUtils.updateSiteEnquiryRow('lead-late-book', {
      metadata: Object.assign({}, dbRow('lead-late-book').metadata, {
        consult: Object.assign({}, dbRow('lead-late-book').metadata.consult, { call_booked: true, call_booked_at: bookedAt })
      })
    });
    const res = await get(CRON, AUTH);
    expect(res.json).toMatchObject({ ok: true, sent: 1 });
    expect(graphCaptured[0].body.data.map((e) => e.event_name)).toEqual(['call_booked']);
    expect(dbRow('lead-late-book').metadata.consult.meta_capi.sent.call_booked).toBeTruthy();
  });

  it('reports a signup once the lead has an account', async () => {
    testUtils.__seedSiteEnquiriesForTest([lead({ id: 'lead-signup', email: 'signup@example.co.uk' })]);
    await get(CRON, AUTH);
    graphCaptured.length = 0;
    testUtils.__seedUserForTest('signup@example.co.uk');
    const res = await get(CRON, AUTH);
    expect(res.json).toMatchObject({ ok: true, sent: 1 });
    expect(graphCaptured[0].body.data.map((e) => e.event_name)).toEqual(['signed_up']);
    expect(dbRow('lead-signup').metadata.consult.meta_capi.sent.signed_up).toBeTruthy();
    // And not again.
    graphCaptured.length = 0;
    expect((await get(CRON, AUTH)).json).toMatchObject({ sent: 0 });
    expect(graphCaptured.length).toBe(0);
  });

  it('leaves website leads, fixture lead ids and leads older than 35 days alone', async () => {
    testUtils.__seedSiteEnquiriesForTest([
      lead({ id: 'lead-web', metadata: { source: 'site_start_form', consult: { qualified: true, call_booked: true } } }),
      lead({ id: 'lead-fixture', metadata: { source: 'meta_lead_ad', fb_lead_id: 'L-1001', consult: { qualified: true } } }),
      lead({ id: 'lead-old', created_at: new Date(Date.now() - 40 * DAY).toISOString() }),
      lead({ id: 'lead-practice', kind: 'practice' })
    ]);
    const res = await get(CRON, AUTH);
    expect(res.json).toMatchObject({ ok: true, scanned: 0, sent: 0, failed: 0 });
    expect(graphCaptured.length).toBe(0);
    for (const id of ['lead-web', 'lead-fixture', 'lead-old']) {
      expect(dbRow(id).metadata.consult.meta_capi).toBeUndefined();
    }
  });

  it('does not stamp a stage Meta rejected, and retries it on the next sweep', async () => {
    testUtils.__seedSiteEnquiriesForTest([lead({ id: 'lead-retry' })]);
    graphMode = 'reject';
    const res = await get(CRON, AUTH);
    expect(res.json).toMatchObject({ ok: true, scanned: 1, sent: 0, failed: 1 });
    expect(dbRow('lead-retry').metadata.consult.meta_capi).toBeUndefined();

    graphMode = 'ok';
    graphCaptured.length = 0;
    const again = await get(CRON, AUTH);
    expect(again.json).toMatchObject({ ok: true, sent: 2, failed: 0 });
    expect(graphCaptured[0].body.data.map((e) => e.event_name)).toEqual(['lead', 'qualified_gp']);
    expect(Object.keys(dbRow('lead-retry').metadata.consult.meta_capi.sent).sort()).toEqual(['lead', 'qualified_gp']);
  });

  it('is a no-op that says so when META_CAPI_* is not configured', async () => {
    testUtils.__seedSiteEnquiriesForTest([lead()]);
    const saved = process.env.META_CAPI_ACCESS_TOKEN;
    delete process.env.META_CAPI_ACCESS_TOKEN;
    try {
      const res = await get(CRON, AUTH);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ ok: true, skipped: 'not_configured', scanned: 0, sent: 0 });
      expect(graphCaptured.length).toBe(0);
    } finally {
      process.env.META_CAPI_ACCESS_TOKEN = saved;
    }
  });
});

describe('POST /api/webhooks/facebook-lead → Meta Conversions API', () => {
  it('tells Meta about a new qualified lead the moment it is stored', async () => {
    const res = await post(WH, nativeFbBody());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, kind: 'gp_lead' });

    expect(graphCaptured.length).toBe(1);
    const call = graphCaptured[0];
    expect(call.url).toBe('/v26.0/' + DATASET + '/events');
    expect(call.body.data.map((e) => e.event_name)).toEqual(['lead', 'qualified_gp']);
    const ud = call.body.data[0].user_data;
    expect(ud.lead_id).toBe(Number(LEAD_ID));
    expect(ud.em).toEqual([sha('aisha@example.co.uk')]);
    expect(ud.ph).toEqual([sha('447700900123')]);

    const rows = readDb().siteEnquiries || [];
    expect(rows.length).toBe(1);
    expect(rows[0].metadata.fb_lead_id).toBe(LEAD_ID);
    expect(Object.keys(rows[0].metadata.consult.meta_capi.sent).sort()).toEqual(['lead', 'qualified_gp']);
    expect(rows[0].metadata.consult.qualified).toBe(true);
    expect(rows[0].metadata.consult.token).toBeTruthy();
  });

  it('sends only the raw lead stage for a lead that did not qualify', async () => {
    const body = nativeFbBody({
      field_data: [
        { name: 'full_name', values: ['Sam Jones'] },
        { name: 'email', values: ['sam@example.com'] },
        { name: 'phone_number', values: ['+15551234567'] },
        { name: 'are_you_a_currently_registered_gp?', values: ['No'] },
        { name: 'where_are_you_registered?', values: ['United Kingdom'] }
      ]
    });
    const res = await post(WH, body);
    expect(res.status).toBe(200);
    expect(graphCaptured.length).toBe(1);
    expect(graphCaptured[0].body.data.map((e) => e.event_name)).toEqual(['lead']);
    const row = (readDb().siteEnquiries || [])[0];
    expect(row.metadata.consult.qualified).toBe(false);
    expect(Object.keys(row.metadata.consult.meta_capi.sent)).toEqual(['lead']);
  });

  it('still stores the lead, and answers 200, when Meta rejects the event', async () => {
    graphMode = 'reject';
    const res = await post(WH, nativeFbBody());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, kind: 'gp_lead' });
    const row = (readDb().siteEnquiries || [])[0];
    expect(row).toBeTruthy();
    expect(row.metadata.consult.meta_capi).toBeUndefined();
    // The hourly sweep then picks it up.
    graphMode = 'ok';
    graphCaptured.length = 0;
    const sweep = await get(CRON, AUTH);
    expect(sweep.json).toMatchObject({ ok: true, sent: 2 });
    expect(Object.keys(dbRow(row.id).metadata.consult.meta_capi.sent).sort()).toEqual(['lead', 'qualified_gp']);
  });
});

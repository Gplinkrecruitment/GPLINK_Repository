import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// Coverage for Task 3 of the Meta-ads GP funnel: the GP-form branch inside
// handleFacebookLeadWebhook (POST /api/webhooks/facebook-lead). Allow-listed
// FB_GP_LEAD_FORM_IDS route to site_enquiries as consult leads (Task 1's
// consultLead.normalizeFacebookGpLead + Task 2's buildConsultLeadRow /
// insertSiteEnquiryRow) instead of the existing ATS practice pipeline. Any
// other form id falls through unchanged to practicePipeline.normalizeFacebookLeadPayload.
//
// Note on duplicate-delivery coverage: checkAndRecordWebhookEvent is
// Supabase-backed (see server.js ~1628) and calls supabaseDbRequest, which
// short-circuits to `{ ok: false, status: 503 }` whenever Supabase isn't
// configured (isSupabaseDbConfigured() false — this test boots with
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset, same as the other consult-lead
// test files). With `existing.ok` false and `inserted.ok` false/non-409,
// checkAndRecordWebhookEvent always returns false in this local-JSON test
// mode, i.e. the dedupe branch is unreachable here — so no duplicate-delivery
// test is included; that path can only be exercised against real Supabase.

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-fb-gp-lead-${RUN_ID}.json`;
let server;
let addrPort;
let testUtils;

function post(path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({
      host: '127.0.0.1',
      port: addrPort,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(extraHeaders || {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* leave null */ }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}

// Copied from tests/consult-lead.test.js — implementers may read tasks out of
// order, and the brief calls for copying the fixture rather than importing
// across test files.
function nativeFbBody(overrides = {}) {
  return {
    entry: [{
      changes: [{
        value: Object.assign({
          leadgen_id: 'L-1001',
          form_id: 'F-77',
          field_data: [
            { name: 'full_name', values: ['Aisha Khan'] },
            { name: 'email', values: ['aisha@example.co.uk'] },
            { name: 'phone_number', values: ['+447700900123'] },
            { name: 'are_you_a_currently_registered_gp?', values: ['Yes'] },
            { name: 'where_are_you_registered?', values: ['United Kingdom'] },
            { name: 'whats_your_main_question?', values: ['Visa timing'] },
          ],
        }, overrides),
      }],
    }],
  };
}

// Captures what would have been emailed, so the magic-link-on-qualification
// behaviour can be asserted rather than assumed. Same stub pattern as
// tests/consult-nudge-cron.test.js.
let resendServer;
let resendPort;
const resendCaptured = [];
function startResendCaptureServer() {
  return new Promise((resolve) => {
    resendServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try { resendCaptured.push(JSON.parse(body || 'null')); } catch { resendCaptured.push(null); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'stub' }));
      });
    });
    resendServer.listen(0, '127.0.0.1', () => { resendPort = resendServer.address().port; resolve(); });
  });
}

beforeAll(async () => {
  await startResendCaptureServer();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-fb-gp-lead-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  delete process.env.SITE_ENQUIRY_NOTIFY_EMAIL;
  process.env.FB_LEAD_WEBHOOK_SECRET = 'test-fb-secret';
  process.env.FB_GP_LEAD_FORM_IDS = 'F-77, F-88';
  // Must be set before importing server.js — the Resend client reads these at load.
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_API_URL = 'http://127.0.0.1:' + resendPort + '/emails';

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (resendServer) await new Promise((resolve) => resendServer.close(resolve));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

beforeEach(() => {
  testUtils.__resetSiteEnquiriesForTest();
});

const WH = '/api/webhooks/facebook-lead?secret=test-fb-secret';

describe('facebook-lead webhook — GP form branch', () => {
  it('routes an allow-listed GP form to site_enquiries (not practices)', async () => {
    const res = await post(WH, nativeFbBody());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, kind: 'gp_lead' });
    const db = readDb();
    expect((db.siteEnquiries || []).length).toBe(1);
    const row = db.siteEnquiries[0];
    expect(row.kind).toBe('gp');
    expect(row.metadata.source).toBe('meta_lead_ad');
    expect(row.metadata.fb_lead_id).toBe('L-1001');
    expect(row.metadata.consult.qualified).toBe(true);
    expect(typeof row.metadata.consult.token).toBe('string');
    expect((db.atsPractices || []).length).toBe(0);
  });

  it('screens out a non-GP answer but still stores the lead', async () => {
    const body = nativeFbBody();
    body.entry[0].changes[0].value.field_data = body.entry[0].changes[0].value.field_data
      .map((f) => f.name.includes('registered_gp') ? { ...f, values: ['No'] } : f);
    body.entry[0].changes[0].value.leadgen_id = 'L-1002';
    const res = await post(WH, body);
    expect(res.status).toBe(200);
    expect(res.json.kind).toBe('gp_lead');
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.qualified).toBe(false);
    expect(row.metadata.consult.screened_out).toBe(true);
  });

  it('a form NOT in the allow-list falls through to the practice path', async () => {
    const body = nativeFbBody();
    body.entry[0].changes[0].value.form_id = 'F-UNKNOWN';
    // practice normalizer requires practice_name or contact_email — email is present, so it creates a practice
    const res = await post(WH, body);
    expect(res.status).toBe(200);
    expect(res.json.kind).toBeUndefined();
    expect((readDb().siteEnquiries || []).length).toBe(0);
  });

  it('rejects a wrong secret with 401', async () => {
    const res = await post('/api/webhooks/facebook-lead?secret=wrong', nativeFbBody());
    expect(res.status).toBe(401);
  });
});

// Meta batches concurrent submissions into ONE delivery — its docs say multiple
// leads "appear as separate objects in the changes array". Both parsers read
// entry[0].changes[0], so every lead after the first used to vanish: no row, no
// email, no trace. Invisible at low volume, real money once ads are running.
describe('batched delivery (several leads in one webhook)', () => {
  const twoLeads = () => ({
    entry: [{
      id: '102030405060708',
      changes: [
        { field: 'leadgen', value: { form_id: 'F-77', leadgen_id: 'BATCH-A', field_data: [
          { name: 'full_name', values: ['Ada Batch'] },
          { name: 'email', values: ['ada@example.co.uk'] },
          { name: 'are_you_a_currently_registered_gp?', values: ['Yes'] },
          { name: '_where_did_you_complete_your_gp_training?', values: ['United Kingdom'] }
        ] } },
        { field: 'leadgen', value: { form_id: 'F-77', leadgen_id: 'BATCH-B', field_data: [
          { name: 'full_name', values: ['Bo Batch'] },
          { name: 'email', values: ['bo@example.ie'] },
          { name: 'are_you_a_currently_registered_gp?', values: ['Yes'] },
          { name: '_where_did_you_complete_your_gp_training?', values: ['Ireland'] }
        ] } }
      ]
    }]
  });

  it('stores EVERY lead in the batch, not just the first', async () => {
    const res = await post('/api/webhooks/facebook-lead?secret=test-fb-secret', twoLeads());
    expect(res.status).toBe(200);
    expect(res.json.batch).toBe(2);
    const rows = readDb().siteEnquiries;
    const ada = rows.find((r) => r.email === 'ada@example.co.uk');
    const bo = rows.find((r) => r.email === 'bo@example.ie');
    expect(ada).toBeTruthy();
    expect(bo).toBeTruthy();
    expect(ada.metadata.consult.country).toBe('uk');
    expect(bo.metadata.consult.country).toBe('ie');
    // each keeps its own Meta lead id, so the booking page can recognise both
    expect(ada.metadata.fb_lead_id).toBe('BATCH-A');
    expect(bo.metadata.fb_lead_id).toBe('BATCH-B');
  });

  it('a single lead still answers with the original, unbatched shape', async () => {
    const res = await post('/api/webhooks/facebook-lead?secret=test-fb-secret', nativeFbBody());
    expect(res.json.kind).toBe('gp_lead');
    expect(res.json.batch).toBeUndefined();
  });
});

// Meta gives us NO way to identify a GP who taps the instant form's thank-you
// button — there is no supported macro for that URL (verified against Meta's
// docs 2026-08-07; a {{lead_id}} placeholder is stored percent-encoded as
// literal text). So this email, sent the moment they qualify, is the only route
// from Facebook to a booked call that requires zero typing. It has been moved
// out of the webhook once already on a mistaken assumption; these pin it.
describe('magic link on qualification', () => {
  beforeEach(() => { resendCaptured.length = 0; });

  // The owner also gets a speed-to-lead alert, so match on recipient rather
  // than counting every send.
  const toLead = (addr) => resendCaptured.filter((e) => [].concat((e && e.to) || []).includes(addr));

  it('emails a qualified lead their booking link immediately', async () => {
    const res = await post('/api/webhooks/facebook-lead?secret=test-fb-secret', nativeFbBody());
    expect(res.json.kind).toBe('gp_lead');
    const sent = toLead('aisha@example.co.uk');
    expect(sent.length).toBe(1);
    expect(sent[0].subject).toMatch(/book your free GP Link call/i);
    // The link must carry the token, or it cannot recognise them on arrival.
    const row = readDb().siteEnquiries.find((r) => r.email === 'aisha@example.co.uk');
    expect(sent[0].html).toContain('/start?lead=' + encodeURIComponent(row.metadata.consult.token));
  });

  it('sends nothing to a screened-out lead', async () => {
    const body = nativeFbBody();
    body.entry[0].changes[0].value.field_data = [
      { name: 'full_name', values: ['Bruce Wayne'] },
      { name: 'email', values: ['bruce@example.com.au'] },
      { name: 'are_you_a_currently_registered_gp?', values: ['Yes'] },
      { name: '_where_did_you_complete_your_gp_training?', values: ['Australia'] },
    ];
    const res = await post('/api/webhooks/facebook-lead?secret=test-fb-secret', body);
    expect(res.json.kind).toBe('gp_lead');
    const row = readDb().siteEnquiries.find((r) => r.email === 'bruce@example.com.au');
    expect(row.metadata.consult.qualified).toBe(false);
    expect(toLead('bruce@example.com.au').length).toBe(0);
  });
});

// 🧨 A REAL Meta leadgen webhook carries only identifiers — leadgen_id,
// form_id, page_id, ad_id, created_time — never the answers. Those must be
// fetched from the Graph API with a Page token holding leads_retrieval. The
// field_data-bearing payloads above are the Zapier-relay shape; these cover
// what Meta itself actually posts.
describe('Graph API hydration (the shape Meta really sends)', () => {
  const realFbBody = () => ({
    entry: [{
      id: '102030405060708',
      time: 1786000000,
      changes: [{
        field: 'leadgen',
        value: {
          ad_id: '6001',
          form_id: 'F-77',
          leadgen_id: '1234567890123456',
          page_id: '102030405060708',
          created_time: 1786000000
        }
      }]
    }]
  });

  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; delete process.env.FB_PAGE_ACCESS_TOKEN; });

  it('fetches field_data for an id-only payload and stores the lead', async () => {
    process.env.FB_PAGE_ACCESS_TOKEN = 'page-token-xyz';
    let requested = null;
    globalThis.fetch = async (url, opts) => {
      // Only intercept Graph — the magic-link email also goes out over fetch.
      if (!String(url).includes('graph.facebook.com')) return realFetch(url, opts);
      requested = String(url);
      return {
        ok: true,
        json: async () => ({
          id: '1234567890123456',
          field_data: [
            { name: 'full_name', values: ['Sarah Whitfield'] },
            { name: 'email', values: ['sarah@nhs.example'] },
            { name: 'are_you_a_currently_registered_gp?', values: ['Yes'] },
            { name: 'where_did_you_complete_your_gp_training?', values: ['United Kingdom'] }
          ]
        })
      };
    };
    const res = await post('/api/webhooks/facebook-lead?secret=test-fb-secret', realFbBody());
    expect(res.status).toBe(200);
    expect(res.json.kind).toBe('gp_lead');
    // hit the Graph API for that exact lead, with the token
    expect(requested).toContain('/1234567890123456');
    expect(requested).toContain('field_data');
    expect(requested).toContain('page-token-xyz');
    const row = readDb().siteEnquiries.find((r) => r.email === 'sarah@nhs.example');
    expect(row.metadata.consult).toMatchObject({ qualified: true, is_gp: true, country: 'uk' });
  });

  it('does NOT call the Graph API when the answers are already inline', async () => {
    process.env.FB_PAGE_ACCESS_TOKEN = 'page-token-xyz';
    let called = false;
    globalThis.fetch = async (url, opts) => {
      if (!String(url).includes('graph.facebook.com')) return realFetch(url, opts);
      called = true;
      throw new Error('should not be called');
    };
    const res = await post('/api/webhooks/facebook-lead?secret=test-fb-secret', nativeFbBody());
    expect(res.status).toBe(200);
    expect(called).toBe(false);
  });

  it('survives a missing token without throwing (webhook still answers)', async () => {
    const res = await post('/api/webhooks/facebook-lead?secret=test-fb-secret', realFbBody());
    expect([200, 400]).toContain(res.status);
    expect(res.json).toBeTruthy();
  });

  it('survives a Graph API error without throwing', async () => {
    process.env.FB_PAGE_ACCESS_TOKEN = 'expired-token';
    globalThis.fetch = async (url, opts) => {
      if (!String(url).includes('graph.facebook.com')) return realFetch(url, opts);
      return {
        ok: false, status: 190,
        json: async () => ({ error: { type: 'OAuthException', message: 'Error validating access token' } })
      };
    };
    const res = await post('/api/webhooks/facebook-lead?secret=test-fb-secret', realFbBody());
    expect(res.json).toBeTruthy();
  });
});

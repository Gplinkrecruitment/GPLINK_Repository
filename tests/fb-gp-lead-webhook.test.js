import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
// configured (isSupabaseDbConfigured() false, this test boots with
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY unset, same as the other consult-lead
// test files). With `existing.ok` false and `inserted.ok` false/non-409,
// checkAndRecordWebhookEvent always returns false in this local-JSON test
// mode, i.e. the dedupe branch is unreachable here, so no duplicate-delivery
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

// Copied from tests/consult-lead.test.js, implementers may read tasks out of
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

beforeAll(async () => {
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

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

beforeEach(() => {
  testUtils.__resetSiteEnquiriesForTest();
});

const WH = '/api/webhooks/facebook-lead?secret=test-fb-secret';

describe('facebook-lead webhook, GP form branch', () => {
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
    // practice normalizer requires practice_name or contact_email, email is present, so it creates a practice
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

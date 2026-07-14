// Endpoint tests for GET /api/cron/consult-nudge (Task 4 of the Meta-ads GP
// funnel plan). Boots the real server in LOCAL-JSON mode (SUPABASE_URL='')
// against an empty temp DB file — same boot harness as
// tests/onboarding-nudge-cron.test.js and tests/consult-lead-endpoints.test.js.
// Exercises the cron over real HTTP, not by calling handlers directly.
//
// A local stub Resend server (same idiom as
// tests/practice-submission-email.test.js's startResendCaptureServer) is
// started BEFORE server.js is imported and wired via RESEND_API_URL, so the
// real send → sendConsultNudgeEmail → sendEmail path is actually exercised
// end to end instead of short-circuiting on "email not configured". This
// module-level const (server.js line ~279:
// `const RESEND_API_URL = process.env.RESEND_API_URL || '...'`) is read once
// at require time, so the env var must be set before `import('../server.js')`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-consult-nudge-${RUN_ID}.json`;
let server;
let addrPort;
let testUtils;
let resendServer;
let resendPort;
const resendCaptured = [];

const CRON = '/api/cron/consult-nudge';
const AUTH = { Authorization: 'Bearer test-cron-secret' };
const H = 3600 * 1000;

function get(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: addrPort,
      path,
      method: 'GET',
      headers: headers || {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* leave null */ }
        resolve({ status: res.statusCode, headers: res.headers, json, raw: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}

// dbState is loaded once at server module import and only ever mutated
// in-memory afterwards (see server.js's loadDbState/saveDbState) — a raw
// fs write to DB_FILE mid-test would never be picked up by the running
// process. __testUtils.__seedUserForTest mutates the live dbState.users
// map directly (mirrors the existing __seedSiteEnquiriesForTest pattern)
// so the cron's "has this lead already signed up?" local-mode check
// (dbState.users[email]) sees the account without a real signup flow.
function seedLocalUser(email) {
  testUtils.__seedUserForTest(email);
}

function seedLead(overrides = {}) {
  const created = overrides.created_at || new Date(Date.now() - 3 * H).toISOString();
  return Object.assign({
    id: 'lead-1', created_at: created, kind: 'gp', name: 'Aisha Khan',
    email: 'aisha@example.co.uk', status: 'new',
    metadata: { source: 'meta_lead_ad', consult: { token: 'TOK1', qualified: true, is_gp: true, country: 'uk', call_booked: false, nudges: [] } },
  }, overrides);
}

function startResendCaptureServer() {
  return new Promise((resolve) => {
    resendServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body || 'null'); } catch { parsed = null; }
        resendCaptured.push(parsed);
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
  process.env.AUTH_SECRET = 'test-consult-nudge-' + RUN_ID;
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  // Must be set before `import('../server.js')` below — see file-header note.
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

describe('GET /api/cron/consult-nudge', () => {
  it('401s without the secret', async () => {
    expect((await get(CRON)).status).toBe(401);
    expect((await get(CRON, { Authorization: 'Bearer wrong' })).status).toBe(401);
  });

  it('sends a due not-booked nudge, records it, and does not double-send on an immediate rerun', async () => {
    resendCaptured.length = 0;
    testUtils.__seedSiteEnquiriesForTest([seedLead()]);
    const res = await get(CRON, AUTH);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.scanned).toBe(1);
    expect(res.json.sent).toBe(1);
    // Stub Resend received exactly one send, addressed to this lead, carrying
    // an unsubscribe link.
    expect(resendCaptured.length).toBe(1);
    const sent = resendCaptured[0];
    expect(JSON.stringify(sent.to)).toContain('aisha@example.co.uk');
    expect(sent.html + sent.text).toContain('/api/unsubscribe?token=');
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.nudges).toEqual([
      { seq: 'not_booked', step: 0, sent_at: expect.any(String) }
    ]);

    // Immediately rerun the cron: step 0 is recorded and step 1 isn't due
    // until 48h, so nothing should send again yet.
    const res2 = await get(CRON, AUTH);
    expect(res2.json.sent).toBe(0);
    expect(resendCaptured.length).toBe(1);
    const row2 = readDb().siteEnquiries[0];
    expect(row2.metadata.consult.nudges.length).toBe(1);
  });

  it('skips screened-out, unqualified, and not-yet-due leads', async () => {
    resendCaptured.length = 0;
    testUtils.__seedSiteEnquiriesForTest([
      seedLead({ id: 'l1', metadata: { source: 'meta_lead_ad', consult: { qualified: false, screened_out: true, nudges: [] } } }),
      seedLead({ id: 'l2', created_at: new Date().toISOString() }), // 0 min old — not due
    ]);
    const res = await get(CRON, AUTH);
    expect(res.json.sent).toBe(0);
    expect(resendCaptured.length).toBe(0);
  });

  it('marks a signed-up lead converted, stops nudging, and never sends it an email', async () => {
    resendCaptured.length = 0;
    seedLocalUser('aisha@example.co.uk');
    testUtils.__seedSiteEnquiriesForTest([seedLead()]);
    const res = await get(CRON, AUTH);
    expect(res.json.stopped).toBe(1);
    const row = readDb().siteEnquiries[0];
    expect(row.status).toBe('converted');
    expect(row.metadata.consult.stopped).toBe('signed_up');
    expect(resendCaptured.length).toBe(0);
  });

  it('writes a terminal "exhausted" stop once both steps of the active sequence are sent, and never re-sends after', async () => {
    resendCaptured.length = 0;
    // Lead already has step 0 recorded 47h ago; step 1 (due at 48h from
    // creation) is due right now.
    testUtils.__seedSiteEnquiriesForTest([seedLead({
      id: 'l3', email: 'exhausted@example.co.uk', created_at: new Date(Date.now() - 49 * H).toISOString(),
      metadata: {
        source: 'meta_lead_ad',
        consult: {
          token: 'TOKX', qualified: true, is_gp: true, country: 'uk', call_booked: false,
          nudges: [{ seq: 'not_booked', step: 0, sent_at: new Date(Date.now() - 47 * H).toISOString() }],
        },
      },
    })]);
    const res = await get(CRON, AUTH);
    expect(res.json.sent).toBe(1);
    expect(resendCaptured.length).toBe(1);
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.nudges.length).toBe(2);
    expect(row.metadata.consult.stopped).toBeUndefined();

    // Nothing due next run (sequence fully sent) → terminal exhausted stop,
    // no further email, no further HTTP existence check needed.
    resendCaptured.length = 0;
    const res2 = await get(CRON, AUTH);
    expect(res2.json.sent).toBe(0);
    expect(res2.json.stopped).toBe(1);
    expect(resendCaptured.length).toBe(0);
    const row2 = readDb().siteEnquiries[0];
    expect(row2.metadata.consult.stopped).toBe('exhausted');

    // Once stopped, the lead is filtered out before nextConsultNudge even
    // runs — scanned but skipped, no more state churn.
    const res3 = await get(CRON, AUTH);
    expect(res3.json.sent).toBe(0);
    expect(res3.json.stopped).toBe(0);
    expect(res3.json.skipped).toBe(1);
  });

  it('a lead who signed up after the final nudge is stamped converted at exhaustion, not exhausted', async () => {
    resendCaptured.length = 0;
    // Fully-sent not_booked sequence + an account created after the last
    // email (its CTA is the signup link) — the exhaustion pass must notice
    // the signup and write converted/signed_up, never the terminal exhausted
    // stop, and must not email them.
    seedLocalUser('lastemail-signup@example.co.uk');
    testUtils.__seedSiteEnquiriesForTest([seedLead({
      id: 'l4', email: 'lastemail-signup@example.co.uk', created_at: new Date(Date.now() - 80 * H).toISOString(),
      metadata: {
        source: 'meta_lead_ad',
        consult: {
          token: 'TOKY', qualified: true, is_gp: true, country: 'uk', call_booked: false,
          nudges: [
            { seq: 'not_booked', step: 0, sent_at: new Date(Date.now() - 78 * H).toISOString() },
            { seq: 'not_booked', step: 1, sent_at: new Date(Date.now() - 30 * H).toISOString() },
          ],
        },
      },
    })]);
    const res = await get(CRON, AUTH);
    expect(res.json.stopped).toBe(1);
    expect(res.json.sent).toBe(0);
    expect(resendCaptured.length).toBe(0);
    const row = readDb().siteEnquiries[0];
    expect(row.status).toBe('converted');
    expect(row.metadata.consult.stopped).toBe('signed_up');
  });
});

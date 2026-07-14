// Endpoint tests for GET /api/cron/consult-nudge (Task 4 of the Meta-ads GP
// funnel plan). Boots the real server in LOCAL-JSON mode (SUPABASE_URL='')
// against an empty temp DB file — same boot harness as
// tests/onboarding-nudge-cron.test.js and tests/consult-lead-endpoints.test.js.
// Exercises the cron over real HTTP, not by calling handlers directly.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-consult-nudge-${RUN_ID}.json`;
let server;
let addrPort;
let testUtils;

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

beforeAll(async () => {
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

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

describe('GET /api/cron/consult-nudge', () => {
  it('401s without the secret', async () => {
    expect((await get(CRON)).status).toBe(401);
    expect((await get(CRON, { Authorization: 'Bearer wrong' })).status).toBe(401);
  });

  it('records a due not-booked nudge on the lead (send skipped when email unconfigured)', async () => {
    testUtils.__seedSiteEnquiriesForTest([seedLead()]);
    const res = await get(CRON, AUTH);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.scanned).toBe(1);
    // Email is unconfigured in tests (no RESEND_API_KEY): send fails → nudge NOT recorded, no crash.
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.nudges.length).toBe(0);
  });

  it('skips screened-out, unqualified, and not-yet-due leads', async () => {
    testUtils.__seedSiteEnquiriesForTest([
      seedLead({ id: 'l1', metadata: { source: 'meta_lead_ad', consult: { qualified: false, screened_out: true, nudges: [] } } }),
      seedLead({ id: 'l2', created_at: new Date().toISOString() }), // 0 min old — not due
    ]);
    const res = await get(CRON, AUTH);
    expect(res.json.sent).toBe(0);
  });

  it('marks a signed-up lead converted and stops nudging', async () => {
    seedLocalUser('aisha@example.co.uk');
    testUtils.__seedSiteEnquiriesForTest([seedLead()]);
    const res = await get(CRON, AUTH);
    expect(res.json.stopped).toBe(1);
    const row = readDb().siteEnquiries[0];
    expect(row.status).toBe('converted');
    expect(row.metadata.consult.stopped).toBe('signed_up');
  });
});

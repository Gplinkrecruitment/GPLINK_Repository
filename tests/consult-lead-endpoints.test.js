import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// Coverage for the Meta-ads GP consult funnel's public (no-session) endpoints:
//   POST /api/public/consult-lead        — site-form submission (screens + stores)
//   GET  /api/public/consult-lead?token= — lookup by token (used by post-call/nudge pages)
//   POST /api/public/consult-lead/match  — email match against a recent FB-webhook lead
//   POST /api/public/consult-lead/booked — flips call_booked once a call is scheduled
// and the GET /start route registration (page file itself lands in Task 5).
// Rows live in site_enquiries (Supabase) / dbState.siteEnquiries (local JSON-db
// fallback, exercised here since Supabase is left unconfigured in this test
// boot — same pattern as tests/site-enquiry.test.js).

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-consult-lead-${RUN_ID}.json`;
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

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: addrPort, path, method: 'GET' }, (res) => {
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

const goodLead = () => ({
  name: 'Aisha Khan', email: 'aisha@example.co.uk', phone: '+447700900123',
  isGp: true, country: 'uk', question: 'Visa timing?',
  utm: { utm_source: 'facebook', utm_campaign: 'video1' },
});

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-consult-lead-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  delete process.env.SITE_ENQUIRY_NOTIFY_EMAIL;

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
  testUtils.__resetSiteEnquiryRateLimitForTest();
  testUtils.__resetSiteEnquiriesForTest();
});

describe('POST /api/public/consult-lead', () => {
  it('stores a qualified lead and returns a token', async () => {
    const res = await post('/api/public/consult-lead', goodLead());
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.qualified).toBe(true);
    expect(typeof res.json.token).toBe('string');
    const row = readDb().siteEnquiries[0];
    expect(row.kind).toBe('gp');
    expect(row.state).toBe('uk');
    expect(row.message).toBe('Visa timing?');
    expect(row.metadata.source).toBe('site_start_form');
    expect(row.metadata.utm.utm_campaign).toBe('video1');
    expect(row.metadata.consult.token).toBe(res.json.token);
    expect(row.metadata.consult.qualified).toBe(true);
  });
  it('stores a screened-out lead with no token', async () => {
    const res = await post('/api/public/consult-lead', { ...goodLead(), country: 'other' });
    expect(res.json).toMatchObject({ ok: true, qualified: false });
    expect(res.json.token).toBeUndefined();
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.screened_out).toBe(true);
  });
  it('honeypot returns fake success and stores nothing', async () => {
    const res = await post('/api/public/consult-lead', { ...goodLead(), website: 'spam.com' });
    expect(res.json).toEqual({ ok: true, qualified: true });
    expect(readDb().siteEnquiries.length).toBe(0);
  });
  it('rejects invalid payloads with 400', async () => {
    expect((await post('/api/public/consult-lead', { ...goodLead(), email: 'bad' })).status).toBe(400);
    expect((await post('/api/public/consult-lead', { ...goodLead(), isGp: 'yes' })).status).toBe(400);
  });
});

describe('GET /api/public/consult-lead?token=', () => {
  it('returns displayName + email for a valid token; 404 otherwise', async () => {
    const created = await post('/api/public/consult-lead', goodLead());
    const hit = await get('/api/public/consult-lead?token=' + created.json.token);
    expect(hit.status).toBe(200);
    expect(hit.json).toMatchObject({ ok: true, displayName: 'Dr Khan', email: 'aisha@example.co.uk', qualified: true });
    expect((await get('/api/public/consult-lead?token=nope')).status).toBe(404);
  });
});

describe('POST /api/public/consult-lead/match', () => {
  it('finds a recent FB lead by email (case-insensitive) and returns its token', async () => {
    // Seed an FB-webhook-shaped row directly (source meta_lead_ad).
    testUtils.__seedSiteEnquiriesForTest([{
      id: 'e-1', created_at: new Date().toISOString(), kind: 'gp',
      name: 'Aisha Khan', email: 'aisha@example.co.uk', phone: '', status: 'new',
      metadata: { source: 'meta_lead_ad', consult: { token: 'TOK123', qualified: true, call_booked: false, nudges: [] } },
    }]);
    const res = await post('/api/public/consult-lead/match', { email: 'AISHA@example.co.uk' });
    expect(res.json).toMatchObject({ ok: true, found: true, displayName: 'Dr Khan', token: 'TOK123' });
  });
  it('does not match site-form leads, old leads, or unknown emails', async () => {
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    testUtils.__seedSiteEnquiriesForTest([
      { id: 'e-2', created_at: new Date().toISOString(), kind: 'gp', name: 'A', email: 'site@x.co', status: 'new', metadata: { source: 'site_start_form', consult: { token: 'T2', qualified: true, nudges: [] } } },
      { id: 'e-3', created_at: old, kind: 'gp', name: 'B', email: 'old@x.co', status: 'new', metadata: { source: 'meta_lead_ad', consult: { token: 'T3', qualified: true, nudges: [] } } },
    ]);
    expect((await post('/api/public/consult-lead/match', { email: 'site@x.co' })).json.found).toBe(false);
    expect((await post('/api/public/consult-lead/match', { email: 'old@x.co' })).json.found).toBe(false);
    expect((await post('/api/public/consult-lead/match', { email: 'none@x.co' })).json.found).toBe(false);
  });
});

describe('POST /api/public/consult-lead/booked', () => {
  it('flips call_booked and status to contacted', async () => {
    const created = await post('/api/public/consult-lead', goodLead());
    const res = await post('/api/public/consult-lead/booked', { token: created.json.token });
    expect(res.json.ok).toBe(true);
    const row = readDb().siteEnquiries[0];
    expect(row.status).toBe('contacted');
    expect(row.metadata.consult.call_booked).toBe(true);
    expect(typeof row.metadata.consult.call_booked_at).toBe('string');
  });
  it('404s on unknown token', async () => {
    expect((await post('/api/public/consult-lead/booked', { token: 'nope' })).status).toBe(404);
  });
  it('a late booking re-opens an exhausted lead (clears stopped:"exhausted")', async () => {
    const token = 'exhausted-' + crypto.randomBytes(16).toString('hex');
    testUtils.__seedSiteEnquiriesForTest([{
      id: 'e-exhausted', created_at: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString(), kind: 'gp',
      name: 'Late Booker', email: 'late@example.co.uk', phone: '', status: 'new',
      metadata: {
        source: 'site_start_form',
        consult: {
          token, qualified: true, call_booked: false, stopped: 'exhausted',
          nudges: [{ seq: 'not_booked', step: 0 }, { seq: 'not_booked', step: 1 }],
        },
      },
    }]);
    const res = await post('/api/public/consult-lead/booked', { token });
    expect(res.json.ok).toBe(true);
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.stopped).toBeUndefined();
    expect(row.metadata.consult.call_booked).toBe(true);
  });
});

describe('GET /start', () => {
  // un-skip in Task 5
  it.skip('serves the landing page shell', async () => {
    const res = await get('/start');
    expect(res.status).toBe(200); // page file lands in Task 5; a 404 here means route not registered
  });
});

// TDD tests for Task 13: admin Website tab backend.
//   GET  /api/admin/site-enquiries?status=       -> { ok:true, enquiries:[...] } newest-first
//   POST /api/admin/site-enquiries/update {id,status} -> { ok:true }
//
// Auth pattern mirrors tests/interview-endpoints.test.js: headless
// gp_admin_session cookie signed with AUTH_SECRET, admin host resolved via
// SUPER_ADMIN_ALLOWED_HOSTS (requireAdminSession is the exact same gate used
// by the neighbouring /api/admin/calls endpoints).
//
// Storage: Supabase is left unconfigured in this test boot (same convention
// as tests/site-enquiry.test.js), so these exercise the dbState.siteEnquiries
// local-JSON-db fallback path.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-site-admin-enq-${RUN_ID}.json`;
const SUPER_HOST = 'admin-enq-test.local';
let server, port, testUtils;

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}

function httpReq(method, p, { host, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* leave null */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const call = (method, p, body) => httpReq(method, p, { host: SUPER_HOST, cookie: superCookie(), body });
const callNoAuth = (method, p, body) => httpReq(method, p, { host: SUPER_HOST, body });
const readDb = () => { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; } };

function seedEnquiry(overrides) {
  return {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    kind: 'practice',
    name: 'Dr Jane Smith',
    email: 'jane.smith@example-practice.com.au',
    phone: '+61 400 123 456',
    practice_name: 'Riverside Medical Centre',
    state: 'QLD',
    message: 'We are looking for a full-time GP to join our practice.',
    status: 'new',
    metadata: { source: 'marketing-site', ip: null, user_agent: '' },
    ...overrides
  };
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'site-admin-enq-test-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

beforeEach(() => {
  testUtils.__resetSiteEnquiriesForTest();
});

describe('GET /api/admin/site-enquiries — auth', () => {
  it('401s with no admin session', async () => {
    const res = await callNoAuth('GET', '/api/admin/site-enquiries');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });
});

describe('POST /api/admin/site-enquiries/update — auth', () => {
  it('401s with no admin session', async () => {
    const res = await callNoAuth('POST', '/api/admin/site-enquiries/update', { id: 'whatever', status: 'contacted' });
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });
});

describe('GET /api/admin/site-enquiries — list (admin session)', () => {
  it('returns { ok:true, enquiries:[] } when empty', async () => {
    const res = await call('GET', '/api/admin/site-enquiries');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, enquiries: [] });
  });

  it('returns seeded enquiries newest-first', async () => {
    const older = seedEnquiry({ id: 'enq-older', created_at: '2026-06-01T00:00:00.000Z', email: 'older@example.com' });
    const newer = seedEnquiry({ id: 'enq-newer', created_at: '2026-06-15T00:00:00.000Z', email: 'newer@example.com' });
    testUtils.__seedSiteEnquiriesForTest([older, newer]);

    const res = await call('GET', '/api/admin/site-enquiries');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.enquiries.length).toBe(2);
    expect(res.body.enquiries[0].id).toBe('enq-newer');
    expect(res.body.enquiries[1].id).toBe('enq-older');
  });

  it('filters by status', async () => {
    const newRow = seedEnquiry({ id: 'enq-new', status: 'new', email: 'new@example.com' });
    const closedRow = seedEnquiry({ id: 'enq-closed', status: 'closed', email: 'closed@example.com' });
    testUtils.__seedSiteEnquiriesForTest([newRow, closedRow]);

    const res = await call('GET', '/api/admin/site-enquiries?status=closed');
    expect(res.status).toBe(200);
    expect(res.body.enquiries.length).toBe(1);
    expect(res.body.enquiries[0].id).toBe('enq-closed');
  });

  it('400s on an invalid status filter', async () => {
    const res = await call('GET', '/api/admin/site-enquiries?status=bogus');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

describe('POST /api/admin/site-enquiries/update — status workflow (admin session)', () => {
  it('updates status and the change is reflected on subsequent list', async () => {
    const row = seedEnquiry({ id: 'enq-update-me', status: 'new' });
    testUtils.__seedSiteEnquiriesForTest([row]);

    const updateRes = await call('POST', '/api/admin/site-enquiries/update', { id: 'enq-update-me', status: 'contacted' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body).toEqual({ ok: true });

    const db = readDb();
    expect(db.siteEnquiries.find((r) => r.id === 'enq-update-me').status).toBe('contacted');

    const listRes = await call('GET', '/api/admin/site-enquiries');
    expect(listRes.body.enquiries.find((r) => r.id === 'enq-update-me').status).toBe('contacted');
  });

  it('400s on an invalid status', async () => {
    const row = seedEnquiry({ id: 'enq-bad-status', status: 'new' });
    testUtils.__seedSiteEnquiriesForTest([row]);

    const res = await call('POST', '/api/admin/site-enquiries/update', { id: 'enq-bad-status', status: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);

    const db = readDb();
    expect(db.siteEnquiries.find((r) => r.id === 'enq-bad-status').status).toBe('new');
  });

  it('404s on an unknown id', async () => {
    const res = await call('POST', '/api/admin/site-enquiries/update', { id: 'no-such-id', status: 'contacted' });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});

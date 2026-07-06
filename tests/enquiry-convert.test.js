// Phase 6 E2: POST /api/admin/enquiry/convert — one-click website-enquiry →
// practice conversion (creates the practices row, sends the intake email via
// the same sendPracticeIntakeEmail path the FB-lead webhook uses, marks the
// enquiry converted). Idempotency + auth are the load-bearing contracts.
//
// Boots the real server in LOCAL-JSON mode; RESEND_API_KEY is set and the
// global fetch is stubbed so every Resend call is captured (pattern from
// tests/ats-submit-practice.test.js) — no network traffic ever leaves.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-enq-convert-${RUN_ID}.json`;
const SUPER_HOST = 'enq-convert-test.local';
let server, port, testUtils, realFetch;
const resendCalls = [];

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
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* leave null */ }
        resolve({ status: res.statusCode, body: parsed });
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
    message: 'We are looking for a full-time GP.',
    status: 'new',
    metadata: { source: 'marketing-site' },
    ...overrides
  };
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'enq-convert-test-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 're_test_' + RUN_ID;

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.resend.com/')) {
      let parsed = null;
      try { parsed = JSON.parse((opts && opts.body) || 'null'); } catch { /* keep null */ }
      resendCalls.push({ url: u, body: parsed });
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  globalThis.fetch = realFetch;
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

beforeEach(() => {
  testUtils.__resetSiteEnquiriesForTest();
  resendCalls.length = 0;
});

describe('auth + input validation', () => {
  it('401s with no admin session', async () => {
    const res = await callNoAuth('POST', '/api/admin/enquiry/convert', { enquiryId: 'whatever' });
    expect(res.status).toBe(401);
  });

  it('400s without an enquiryId', async () => {
    const res = await call('POST', '/api/admin/enquiry/convert', {});
    expect(res.status).toBe(400);
  });

  it('404s on an unknown enquiryId', async () => {
    const res = await call('POST', '/api/admin/enquiry/convert', { enquiryId: 'no-such-id' });
    expect(res.status).toBe(404);
  });
});

describe('conversion', () => {
  it('creates the practice, sends the intake email and marks the enquiry converted', async () => {
    const enq = seedEnquiry({ id: 'enq-convert-1' });
    testUtils.__seedSiteEnquiriesForTest([enq]);

    const res = await call('POST', '/api/admin/enquiry/convert', { enquiryId: 'enq-convert-1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.practice_id).toBeTruthy();
    expect(res.body.email_sent).toBe(true);

    // Practice row created from the enquiry's contact details.
    const db = readDb();
    const practices = (db.atsPractices || []).filter((p) => p.contact_email === enq.email);
    expect(practices.length).toBe(1);
    const practice = practices[0];
    expect(String(practice.id)).toBe(String(res.body.practice_id));
    expect(practice.name).toBe('Riverside Medical Centre');
    expect(practice.contact_name).toBe('Dr Jane Smith');
    expect(practice.contact_phone).toBe('+61 400 123 456');
    expect(practice.location_state).toBe('QLD');
    expect(practice.source).toBe('website_enquiry');
    expect(practice.stage).toBe('prospective');
    expect(practice.intake_token).toBeTruthy();
    expect(practice.metadata.site_enquiry_id).toBe('enq-convert-1');

    // Intake email captured: to the enquiry contact, carrying the token link.
    expect(resendCalls.length).toBe(1);
    const email = resendCalls[0].body;
    expect(email.to).toContain(enq.email);
    expect(String(email.html)).toContain('practice-intake?token=');

    // Enquiry marked converted + linked to the practice.
    const stored = (db.siteEnquiries || []).find((r) => r.id === 'enq-convert-1');
    expect(stored.status).toBe('converted');
    expect(String(stored.metadata.converted_practice_id)).toBe(String(res.body.practice_id));
    expect(stored.metadata.converted_at).toBeTruthy();
  });

  it('is idempotent — a second convert returns the existing practice, creates and sends nothing', async () => {
    testUtils.__seedSiteEnquiriesForTest([seedEnquiry({ id: 'enq-idem' })]);

    const first = await call('POST', '/api/admin/enquiry/convert', { enquiryId: 'enq-idem' });
    expect(first.body.ok).toBe(true);
    const practiceCountAfterFirst = (readDb().atsPractices || []).length;
    const emailsAfterFirst = resendCalls.length;

    const second = await call('POST', '/api/admin/enquiry/convert', { enquiryId: 'enq-idem' });
    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(true);
    expect(second.body.alreadyConverted).toBe(true);
    expect(String(second.body.practice_id)).toBe(String(first.body.practice_id));
    expect((readDb().atsPractices || []).length).toBe(practiceCountAfterFirst);
    expect(resendCalls.length).toBe(emailsAfterFirst);
  });

  it('falls back to "name\'s practice" when the enquiry has no practice_name', async () => {
    testUtils.__seedSiteEnquiriesForTest([seedEnquiry({ id: 'enq-noname', practice_name: '', email: 'gp2@example.com' })]);
    const res = await call('POST', '/api/admin/enquiry/convert', { enquiryId: 'enq-noname' });
    expect(res.body.ok).toBe(true);
    const practice = (readDb().atsPractices || []).find((p) => p.contact_email === 'gp2@example.com');
    expect(practice.name).toBe("Dr Jane Smith's practice");
  });

  it('400s when the enquiry has no contact email (nowhere to send the intake link)', async () => {
    testUtils.__seedSiteEnquiriesForTest([seedEnquiry({ id: 'enq-noemail', email: '' })]);
    const practicesBefore = (readDb().atsPractices || []).length; // practices persist across tests in this DB file
    const res = await call('POST', '/api/admin/enquiry/convert', { enquiryId: 'enq-noemail' });
    expect(res.status).toBe(400);
    expect((readDb().atsPractices || []).length).toBe(practicesBefore);
  });
});

describe('converted status surface', () => {
  it('the admin list endpoint accepts ?status=converted', async () => {
    testUtils.__seedSiteEnquiriesForTest([seedEnquiry({ id: 'enq-list' })]);
    await call('POST', '/api/admin/enquiry/convert', { enquiryId: 'enq-list' });

    const res = await call('GET', '/api/admin/site-enquiries?status=converted');
    expect(res.status).toBe(200);
    expect(res.body.enquiries.length).toBe(1);
    expect(res.body.enquiries[0].id).toBe('enq-list');
  });

  it('the manual status-update endpoint still rejects "converted" (convert is the only door)', async () => {
    testUtils.__seedSiteEnquiriesForTest([seedEnquiry({ id: 'enq-manual' })]);
    const res = await call('POST', '/api/admin/site-enquiries/update', { id: 'enq-manual', status: 'converted' });
    expect(res.status).toBe(400);
  });
});

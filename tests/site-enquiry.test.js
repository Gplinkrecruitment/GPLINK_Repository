import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// Coverage for the new public (no-session) lead-capture endpoint:
//   POST /api/public/enquiry — practice/GP/general enquiries from the
//   marketing site, stored in site_enquiries (Supabase) / dbState.siteEnquiries
//   (local JSON-db fallback, exercised here since Supabase is left
//   unconfigured in this test boot — same pattern as tests/site-public-apis.test.js).
//
// Validates: required fields (kind/name/email), kind enum, email format,
// message length cap, the `website` honeypot (200 ok, but stores nothing),
// and the in-memory per-client rate limit (max 5 stored submissions/hour),
// keyed the same way the production getClientIp() helper keys it: by the
// first X-Forwarded-For entry when present, else the raw socket address —
// so two different XFF values get independent budgets and the same XFF
// value shares one, matching how requests arrive behind Vercel's proxy.

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-site-enquiry-${RUN_ID}.json`;
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
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        raw: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}

function validPracticePayload(overrides) {
  return {
    kind: 'practice',
    name: 'Dr Jane Smith',
    email: 'jane.smith@example-practice.com.au',
    phone: '+61 400 123 456',
    practice_name: 'Riverside Medical Centre',
    state: 'QLD',
    message: 'We are looking for a full-time GP to join our practice.',
    ...overrides
  };
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-site-enquiry-' + RUN_ID;
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

describe('POST /api/public/enquiry — valid submissions', () => {
  it('stores a valid practice enquiry with status "new" and returns { ok: true }', async () => {
    const res = await post('/api/public/enquiry', validPracticePayload());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });

    const db = readDb();
    expect(db.siteEnquiries.length).toBe(1);
    const row = db.siteEnquiries[0];
    expect(row.status).toBe('new');
    expect(row.kind).toBe('practice');
    expect(row.name).toBe('Dr Jane Smith');
    expect(row.email).toBe('jane.smith@example-practice.com.au');
    expect(row.practice_name).toBe('Riverside Medical Centre');
    expect(row.state).toBe('QLD');
    expect(typeof row.id).toBe('string');
    expect(row.id.length).toBeGreaterThan(0);
    expect(typeof row.created_at).toBe('string');
    expect(row.metadata).toBeTruthy();
    expect(typeof row.metadata).toBe('object');
  });

  it('accepts kind "gp" and kind "general" with only name+email (no optional fields)', async () => {
    const gpRes = await post('/api/public/enquiry', { kind: 'gp', name: 'Dr Amit Rao', email: 'amit@example.com' });
    expect(gpRes.status).toBe(200);
    expect(gpRes.json.ok).toBe(true);

    const generalRes = await post('/api/public/enquiry', { kind: 'general', name: 'Someone', email: 'someone@example.com' });
    expect(generalRes.status).toBe(200);
    expect(generalRes.json.ok).toBe(true);

    const db = readDb();
    expect(db.siteEnquiries.length).toBe(2);
  });
});

describe('POST /api/public/enquiry — validation failures (400)', () => {
  it('400 when kind is missing', async () => {
    const res = await post('/api/public/enquiry', validPracticePayload({ kind: undefined }));
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
    expect(readDb().siteEnquiries.length).toBe(0);
  });

  it('400 when kind is outside the enum', async () => {
    const res = await post('/api/public/enquiry', validPracticePayload({ kind: 'spam' }));
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
    expect(readDb().siteEnquiries.length).toBe(0);
  });

  it('400 when name is missing', async () => {
    const res = await post('/api/public/enquiry', validPracticePayload({ name: '' }));
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
    expect(readDb().siteEnquiries.length).toBe(0);
  });

  it('400 when email is missing', async () => {
    const res = await post('/api/public/enquiry', validPracticePayload({ email: '' }));
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
    expect(readDb().siteEnquiries.length).toBe(0);
  });

  it('400 when email format is invalid', async () => {
    const res = await post('/api/public/enquiry', validPracticePayload({ email: 'not-an-email' }));
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
    expect(readDb().siteEnquiries.length).toBe(0);
  });

  it('400 when message exceeds 4000 characters', async () => {
    const res = await post('/api/public/enquiry', validPracticePayload({ message: 'a'.repeat(4001) }));
    expect(res.status).toBe(400);
    expect(res.json.ok).toBe(false);
    expect(readDb().siteEnquiries.length).toBe(0);
  });

  it('a message of exactly 4000 characters is accepted', async () => {
    const res = await post('/api/public/enquiry', validPracticePayload({ email: 'exact4000@example.com', message: 'a'.repeat(4000) }));
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });
});

describe('POST /api/public/enquiry — honeypot', () => {
  it('a filled "website" field returns { ok: true } but stores no row', async () => {
    const res = await post('/api/public/enquiry', validPracticePayload({ website: 'http://spam-bot.example' }));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(readDb().siteEnquiries.length).toBe(0);
  });

  it('an empty "website" field behaves like a normal submission (stores the row)', async () => {
    const res = await post('/api/public/enquiry', validPracticePayload({ website: '' }));
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(readDb().siteEnquiries.length).toBe(1);
  });
});

describe('POST /api/public/enquiry — rate limit (5/hour/client)', () => {
  it('allows 5 stored submissions from the same X-Forwarded-For value within the hour, then 429s the 6th', async () => {
    const xff = { 'x-forwarded-for': `203.0.113.10-${RUN_ID}` };
    for (let i = 0; i < 5; i++) {
      const res = await post('/api/public/enquiry', validPracticePayload({ email: `rate-${i}-${RUN_ID}@example.com` }), xff);
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
    }
    expect(readDb().siteEnquiries.length).toBe(5);

    const sixth = await post('/api/public/enquiry', validPracticePayload({ email: `rate-5-${RUN_ID}@example.com` }), xff);
    expect(sixth.status).toBe(429);
    expect(sixth.json.ok).toBe(false);
    // The 6th (rejected) request must not have been stored.
    expect(readDb().siteEnquiries.length).toBe(5);
  });

  it('an honeypot-triggered submission does not consume the rate-limit budget', async () => {
    const xff = { 'x-forwarded-for': `203.0.113.11-${RUN_ID}` };
    for (let i = 0; i < 5; i++) {
      const res = await post('/api/public/enquiry', validPracticePayload({ email: `budget-${i}-${RUN_ID}@example.com` }), xff);
      expect(res.status).toBe(200);
    }
    // Budget for this client is now exhausted for real submissions...
    const blocked = await post('/api/public/enquiry', validPracticePayload({ email: `blocked-${RUN_ID}@example.com` }), xff);
    expect(blocked.status).toBe(429);
    // ...but a honeypot hit still returns 200 (bots never learn they were blocked).
    const honeypot = await post('/api/public/enquiry', validPracticePayload({ email: `hp-${RUN_ID}@example.com`, website: 'spam' }), xff);
    expect(honeypot.status).toBe(200);
    expect(honeypot.json.ok).toBe(true);
  });

  it('two different X-Forwarded-For values get independent rate-limit budgets', async () => {
    const clientA = { 'x-forwarded-for': `198.51.100.20-${RUN_ID}` };
    const clientB = { 'x-forwarded-for': `198.51.100.21-${RUN_ID}` };

    // Exhaust client A's budget.
    for (let i = 0; i < 5; i++) {
      const res = await post('/api/public/enquiry', validPracticePayload({ email: `a-${i}-${RUN_ID}@example.com` }), clientA);
      expect(res.status).toBe(200);
    }
    const aSixth = await post('/api/public/enquiry', validPracticePayload({ email: `a-5-${RUN_ID}@example.com` }), clientA);
    expect(aSixth.status).toBe(429);

    // Client B has its own, untouched budget.
    const bFirst = await post('/api/public/enquiry', validPracticePayload({ email: `b-0-${RUN_ID}@example.com` }), clientB);
    expect(bFirst.status).toBe(200);
    expect(bFirst.json.ok).toBe(true);

    expect(readDb().siteEnquiries.length).toBe(6);
  });

  it('keys on the first entry of a multi-hop X-Forwarded-For header (matches getClientIp semantics)', async () => {
    // Same leading (client) IP, different proxy-appended hops — must share one budget.
    const hopA = { 'x-forwarded-for': `192.0.2.30-${RUN_ID}, 10.0.0.1` };
    const hopB = { 'x-forwarded-for': `192.0.2.30-${RUN_ID}, 10.0.0.2` };

    for (let i = 0; i < 5; i++) {
      const res = await post('/api/public/enquiry', validPracticePayload({ email: `hop-${i}-${RUN_ID}@example.com` }), hopA);
      expect(res.status).toBe(200);
    }
    // Different second hop, same first (client) IP -> shares the exhausted budget.
    const sixth = await post('/api/public/enquiry', validPracticePayload({ email: `hop-5-${RUN_ID}@example.com` }), hopB);
    expect(sixth.status).toBe(429);
  });
});

// Task 10: real employers page (pages/site-employers.html), served at
// GET /employers. Consumes the same GPSite.bindEnquiryForm() helper and
// POST /api/public/enquiry endpoint covered above, with data-kind="practice".
describe('GET /employers (Task 10 employers page)', () => {
  it('is 200 text/html with no session', async () => {
    const res = await get('/employers');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('contains the practice enquiry form wired for the shared helper', async () => {
    const res = await get('/employers');
    expect(res.raw).toContain('data-enquiry-form');
    expect(res.raw).toContain('data-kind="practice"');
    expect(res.raw).toContain('id="practiceEnquiry"');
  });

  it('has the website honeypot field', async () => {
    const res = await get('/employers');
    expect(res.raw).toMatch(/<input[^>]*name="website"[^>]*>/);
  });

  it('has no auth-guard.js, no app-shell chrome, and no dead href="#" links', async () => {
    const res = await get('/employers');
    expect(res.raw).not.toMatch(/auth-guard\.js/);
    expect(res.raw).not.toMatch(/app-shell/);
    expect(res.raw).not.toMatch(/nav-shell-bridge/);
    expect(res.raw).not.toMatch(/href="#"/);
  });

  it('links the shared site chrome css/js and has SEO head tags', async () => {
    const res = await get('/employers');
    expect(res.raw).toContain('/css/site.css?v=20260703');
    expect(res.raw).toContain('/js/site.js?v=20260703');
    expect(res.raw).toContain('<link rel="canonical" href="https://www.mygplink.com.au/employers">');
    expect(res.raw).toMatch(/<meta name="description" content="[^"]{50,200}">/);
  });

  it('marks Employers as the current nav item in both desktop and mobile navs', async () => {
    const res = await get('/employers');
    const matches = res.raw.match(/<a href="\/employers" aria-current="page">Employers<\/a>/g) || [];
    expect(matches.length).toBe(2);
  });
});

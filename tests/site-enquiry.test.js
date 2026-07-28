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

// Local Resend capture server (same pattern as tests/practice-decision.test.js)
// so the enquiry notification email can be asserted directly: RESEND_API_URL
// is read once at module import, so it must point here BEFORE server.js loads.
let resendServer;
let resendPort;
const resendCaptured = [];
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
        res.end(JSON.stringify({ id: 'email-' + resendCaptured.length }));
      });
    });
    resendServer.listen(0, '127.0.0.1', () => { resendPort = resendServer.address().port; resolve(); });
  });
}

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
  await startResendCaptureServer();

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
  process.env.RESEND_API_KEY = 'test-resend-key-' + RUN_ID;
  process.env.RESEND_API_URL = 'http://127.0.0.1:' + resendPort + '/emails';
  delete process.env.SITE_ENQUIRY_NOTIFY_EMAIL;

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
  testUtils.__resetSiteEnquiryRateLimitForTest();
  testUtils.__resetSiteEnquiriesForTest();
  resendCaptured.length = 0;
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

// Audit fix (practice journey, item 1): enquiries must always reach a human.
// With SITE_ENQUIRY_NOTIFY_EMAIL unset the notification used to be a NO-OP —
// the enquiry was stored but no dashboard lists practice-kind enquiries, so
// nobody ever saw it. The notification now falls back to the owner mailbox.
describe('POST /api/public/enquiry — notification fallback', () => {
  it('emails hello@mygplink.com.au when SITE_ENQUIRY_NOTIFY_EMAIL is unset', async () => {
    delete process.env.SITE_ENQUIRY_NOTIFY_EMAIL;
    const res = await post('/api/public/enquiry', validPracticePayload());
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);

    const notify = resendCaptured.find((e) => e && /enquiry/i.test(e.subject || ''));
    expect(notify).toBeTruthy();
    expect(notify.to).toContain('hello@mygplink.com.au');
    expect(notify.subject).toContain('practice');
    expect(notify.subject).toContain('Dr Jane Smith');
  });

  it('a configured SITE_ENQUIRY_NOTIFY_EMAIL still wins over the fallback', async () => {
    process.env.SITE_ENQUIRY_NOTIFY_EMAIL = 'custom-notify@example.com';
    try {
      const res = await post('/api/public/enquiry', validPracticePayload());
      expect(res.status).toBe(200);

      const notify = resendCaptured.find((e) => e && /enquiry/i.test(e.subject || ''));
      expect(notify).toBeTruthy();
      expect(notify.to).toContain('custom-notify@example.com');
      expect(notify.to).not.toContain('hello@mygplink.com.au');
    } finally {
      delete process.env.SITE_ENQUIRY_NOTIFY_EMAIL;
    }
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

// Real employers page (pages/site-employers.html), served at GET /employers.
// The one-shot enquiry form was replaced by the guided practice flow, which
// posts to /api/public/practice-lead and enters the SAME pipeline a Facebook
// lead does (prospect created + intake link emailed immediately).
describe('GET /employers (employers page)', () => {
  it('is 200 text/html with no session', async () => {
    const res = await get('/employers');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('serves the guided practice flow and its script', async () => {
    const res = await get('/employers');
    expect(res.raw).toContain('id="practiceFlow"');
    expect(res.raw).toContain('site-practice-lead.js');
    // All four steps present, including the confirmation screen.
    expect(res.raw).toContain('data-pf-step="1"');
    expect(res.raw).toContain('data-pf-step="4"');
  });

  it('collects the answers the intake form would otherwise ask twice', async () => {
    const res = await get('/employers');
    // Vocabulary must match lib/practice-pipeline.js exactly, or the values
    // are dropped before they ever reach a column.
    expect(res.raw).toContain('data-pf-choice="asap"');
    expect(res.raw).toContain('data-pf-choice="full_time"');
    expect(res.raw).toContain('name="practice_name"');
    expect(res.raw).toContain('name="contact_email"');
  });

  it('uses company_url as the honeypot, NOT website', async () => {
    // Regression guard. The old trap was name="website"; this form has a
    // REAL website input, so reusing that name would silently discard every
    // practice that fills its website in.
    const res = await get('/employers');
    expect(res.raw).toMatch(/<input class="hp-field"[^>]*name="company_url"/);
    // website still exists — as a genuine, visible, labelled field.
    expect(res.raw).toMatch(/<input type="url" name="website"/);
    expect(res.raw).not.toMatch(/<input class="hp-field"[^>]*name="website"/);
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
    expect(res.raw).toContain('/css/site.css?v=20260717a');
    expect(res.raw).toContain('/js/site.js?v=20260729b');
    expect(res.raw).toContain('<link rel="canonical" href="https://www.mygplink.com.au/employers">');
    expect(res.raw).toMatch(/<meta name="description" content="[^"]{50,200}">/);
  });

  it('marks Employers as the current nav item in both desktop and mobile navs', async () => {
    const res = await get('/employers');
    const matches = res.raw.match(/<a href="\/employers" aria-current="page">Employers<\/a>/g) || [];
    expect(matches.length).toBe(2);
  });
});

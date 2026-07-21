// Phase 6 E1 (audit B6), generic marketing unsubscribe + List-Unsubscribe:
//  1. HMAC token round-trips; tampered/forged tokens are rejected;
//  2. GET /api/unsubscribe is scanner-proof (confirm page, NO write);
//  3. POST writes email_suppression AND flips candidate_leads.unsubscribed
//     (case-insensitively), idempotently; one-click (token in query) works;
//  4. a marketing-category sendEmail auto-carries List-Unsubscribe (mailto +
//     /api/unsubscribe URL) + List-Unsubscribe-Post per recipient;
//  5. a transactional send carries NO unsubscribe headers;
//  6. a caller-provided List-Unsubscribe (the onboarding nudge) is preserved
//     exactly, never double-set;
//  7. after unsubscribing, further marketing mail to that address is skipped.
//
// Local-JSON mode; outbound Resend calls captured by wrapping global fetch
// (pattern from tests/email-suppression.test.js).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-mkt-unsub-${RUN_ID}.json`);
const SUPER_HOST = 'mkt-unsub-test.local';
let server, port, testUtils;

const LEAD_EMAIL = 'lead@gplink-test.local';
const resendCalls = [];

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function req(method, p, { cookie, body, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? Buffer.from(String(body), 'utf8') : null;
    const headers = { Host: SUPER_HOST };
    if (cookie) headers.Cookie = cookie;
    if (data) { headers['Content-Type'] = contentType || 'application/x-www-form-urlencoded'; headers['Content-Length'] = data.length; }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, raw, body: parsed });
      });
    });
    r.on('error', reject);
    r.end(data);
  });
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'mkt-unsub-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 'test-resend-key';

  // Lead stored with MIXED-case email, the unsubscribe flip must match
  // case-insensitively.
  fs.writeFileSync(DB_FILE, JSON.stringify({
    candidateLeads: [
      { id: 'lead1', name: 'Lead One', email: 'Lead@GPLink-Test.Local', phone: '', source: 'zoho_recruit', unsubscribed: false, created_at: '2026-07-01T00:00:00Z' }
    ]
  }));

  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, opts) => {
    const target = String(u && u.url ? u.url : u);
    if (target.startsWith('https://api.resend.com/')) {
      let parsed = null; try { parsed = JSON.parse((opts && opts.body) || 'null'); } catch {}
      resendCalls.push({ url: target, body: parsed });
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
    }
    return realFetch(u, opts);
  };

  const serverModule = await import('../server.js');
  testUtils = serverModule.__testUtils;
  server = serverModule.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('unsubscribe token', () => {
  it('round-trips: verify(make(email)) recovers the lowercased email', () => {
    const tok = testUtils.makeMarketingUnsubToken('Someone@Example.COM');
    expect(testUtils.verifyMarketingUnsubToken(tok)).toBe('someone@example.com');
  });

  it('rejects tampered payloads and garbage', () => {
    const tok = testUtils.makeMarketingUnsubToken('victim@example.com');
    const [payload, sig] = tok.split('.');
    const forged = b64url('attacker@example.com') + '.' + sig;
    expect(testUtils.verifyMarketingUnsubToken(forged)).toBe(null);
    expect(testUtils.verifyMarketingUnsubToken(payload + '.deadbeef')).toBe(null);
    expect(testUtils.verifyMarketingUnsubToken('')).toBe(null);
    expect(testUtils.verifyMarketingUnsubToken('not-a-token')).toBe(null);
  });

  it('buildMarketingUnsubUrl points at /api/unsubscribe with the token', () => {
    const url = testUtils.buildMarketingUnsubUrl(LEAD_EMAIL);
    expect(url).toMatch(/\/api\/unsubscribe\?token=/);
  });
});

describe('GET /api/unsubscribe (scanner-proof)', () => {
  it('renders a confirm page with a POST form and performs NO write', async () => {
    const tok = testUtils.makeMarketingUnsubToken(LEAD_EMAIL);
    const r = await req('GET', '/api/unsubscribe?token=' + encodeURIComponent(tok));
    expect(r.status).toBe(200);
    expect(r.raw).toContain('method="POST"');
    expect(r.raw).toContain('action="/api/unsubscribe"');
    // GET must not have suppressed anyone (SafeLinks-style prefetch safety).
    expect(await testUtils.isEmailSuppressed(LEAD_EMAIL)).toBe(false);
  });

  it('400s an invalid token without leaking anything', async () => {
    const r = await req('GET', '/api/unsubscribe?token=bogus');
    expect(r.status).toBe(400);
    expect(r.raw).toContain('no longer valid');
  });
});

describe('POST /api/unsubscribe', () => {
  it('writes email_suppression AND flips candidate_leads.unsubscribed (case-insensitive)', async () => {
    const tok = testUtils.makeMarketingUnsubToken(LEAD_EMAIL);
    // RFC-8058 one-click shape: token in the query string, empty body.
    const r = await req('POST', '/api/unsubscribe?token=' + encodeURIComponent(tok));
    expect(r.status).toBe(200);
    expect(r.raw).toMatch(/unsubscribed/i);
    expect(await testUtils.isEmailSuppressed(LEAD_EMAIL)).toBe(true);
    const leads = await req('GET', '/api/admin/leads?q=' + encodeURIComponent(LEAD_EMAIL.split('@')[0]), { cookie: superCookie() });
    const lead = leads.body.leads.find((l) => l.id === 'lead1');
    expect(lead.unsubscribed).toBe(true);
  });

  it('is idempotent (second POST also 200, still suppressed)', async () => {
    const tok = testUtils.makeMarketingUnsubToken(LEAD_EMAIL);
    const r = await req('POST', '/api/unsubscribe?token=' + encodeURIComponent(tok));
    expect(r.status).toBe(200);
    expect(await testUtils.isEmailSuppressed(LEAD_EMAIL)).toBe(true);
  });

  it('accepts the token via form body too (confirm-page submit)', async () => {
    const other = 'form-unsub@gplink-test.local';
    const tok = testUtils.makeMarketingUnsubToken(other);
    const r = await req('POST', '/api/unsubscribe', { body: 'token=' + encodeURIComponent(tok) });
    expect(r.status).toBe(200);
    expect(await testUtils.isEmailSuppressed(other)).toBe(true);
  });

  it('400s an invalid token and writes nothing', async () => {
    const r = await req('POST', '/api/unsubscribe?token=bogus');
    expect(r.status).toBe(400);
  });
});

describe('List-Unsubscribe headers on sendEmail', () => {
  it('marketing send auto-carries List-Unsubscribe (mailto + one-click URL) + List-Unsubscribe-Post', async () => {
    const before = resendCalls.length;
    const r = await testUtils.sendEmail({ to: 'fresh@gplink-test.local', subject: 'Campaign', html: '<p>hi</p>', category: 'marketing' });
    expect(r.ok).toBe(true);
    expect(resendCalls.length).toBe(before + 1);
    const headers = resendCalls[resendCalls.length - 1].body.headers;
    expect(headers['List-Unsubscribe']).toMatch(/^<mailto:[^>]+>, <http.*\/api\/unsubscribe\?token=.+>$/);
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // The embedded token must verify back to the recipient.
    const m = headers['List-Unsubscribe'].match(/token=([^>&]+)/);
    expect(testUtils.verifyMarketingUnsubToken(decodeURIComponent(m[1]))).toBe('fresh@gplink-test.local');
  });

  it('multi-recipient marketing send = one Resend call per recipient, each with its OWN token', async () => {
    const before = resendCalls.length;
    const r = await testUtils.sendEmail({ to: ['a@gplink-test.local', 'b@gplink-test.local'], subject: 'Campaign', html: 'x', category: 'marketing' });
    expect(r.ok).toBe(true);
    expect(resendCalls.length).toBe(before + 2);
    const [c1, c2] = resendCalls.slice(-2);
    expect(c1.body.to).toEqual(['a@gplink-test.local']);
    expect(c2.body.to).toEqual(['b@gplink-test.local']);
    const t1 = decodeURIComponent(c1.body.headers['List-Unsubscribe'].match(/token=([^>&]+)/)[1]);
    const t2 = decodeURIComponent(c2.body.headers['List-Unsubscribe'].match(/token=([^>&]+)/)[1]);
    expect(testUtils.verifyMarketingUnsubToken(t1)).toBe('a@gplink-test.local');
    expect(testUtils.verifyMarketingUnsubToken(t2)).toBe('b@gplink-test.local');
  });

  it('transactional send carries NO unsubscribe headers', async () => {
    const before = resendCalls.length;
    const r = await testUtils.sendEmail({ to: 'fresh@gplink-test.local', subject: 'OTP', html: 'code' });
    expect(r.ok).toBe(true);
    expect(resendCalls.length).toBe(before + 1);
    expect(resendCalls[resendCalls.length - 1].body.headers).toBeUndefined();
  });

  it('caller-provided List-Unsubscribe (nudge flow) is preserved untouched, never double-set', async () => {
    const nudgeHeaders = {
      'List-Unsubscribe': '<https://app.mygplink.com.au/api/onboarding-reminders/unsubscribe?u=u1&t=tok>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    };
    const before = resendCalls.length;
    const r = await testUtils.sendEmail({ to: 'nudge@gplink-test.local', subject: 'Nudge', html: 'x', category: 'marketing', headers: nudgeHeaders });
    expect(r.ok).toBe(true);
    expect(resendCalls.length).toBe(before + 1);
    const sent = resendCalls[resendCalls.length - 1].body.headers;
    expect(sent['List-Unsubscribe']).toBe(nudgeHeaders['List-Unsubscribe']);
    expect(sent['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // Exactly the caller's two headers, nothing auto-added on top.
    expect(Object.keys(sent).sort()).toEqual(['List-Unsubscribe', 'List-Unsubscribe-Post']);
  });

  it('after unsubscribing, marketing mail to that address is suppressed (C3 gate)', async () => {
    const before = resendCalls.length;
    const r = await testUtils.sendEmail({ to: LEAD_EMAIL, subject: 'Campaign', html: 'x', category: 'marketing' });
    expect(r.ok).toBe(false);
    expect(r.suppressed).toBe(true);
    expect(resendCalls.length).toBe(before);
  });
});

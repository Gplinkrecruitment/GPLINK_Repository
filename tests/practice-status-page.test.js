// Phase 6 D2 — the read-only practice status page + its email links.
//
// Boots the real server in LOCAL-JSON mode (SUPABASE_URL=''), same hermetic
// pattern as tests/practice-intake-endpoints.test.js. Verifies:
//   1. /pages/practice-status(.html) is served publicly (no session cookie)
//      while the auth gate is demonstrably active for protected pages,
//   2. the page carries the status/listings/empty-state/error markers and
//      calls /api/practice/status, and never says "RSO",
//   3. the signed-agreement confirmation email links the status page with
//      the practice's own intake token (Track your listing CTA).
// Outbound Resend sends are captured by wrapping global fetch (same as
// tests/ats-endpoints.test.js).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-practice-status-page-${RUN_ID}.json`);
const FB_SECRET = 'fb-secret-' + RUN_ID;
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let server, port;
const createdPdfPracticeIds = [];

const resendCalls = [];
let realFetch;

function req(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject); r.end(data);
  });
}
const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
function readDb() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'practice-status-page-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.FB_LEAD_WEBHOOK_SECRET = FB_SECRET;

  // Capture outbound Resend sends (the signed-agreement confirmation email).
  process.env.RESEND_API_KEY = 'test-resend-key';
  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.resend.com/')) {
      let parsed = null; try { parsed = JSON.parse((opts && opts.body) || 'null'); } catch {}
      resendCalls.push({ url: u, body: parsed });
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
    }
    return realFetch(url, opts);
  };

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(DB_FILE); } catch {}
  createdPdfPracticeIds.forEach((id) => {
    try { fs.unlinkSync(path.join(ROOT, 'data', 'practice-agreements', id + '.pdf')); } catch {}
  });
});

describe('practice status page is public', () => {
  it('serves /pages/practice-status with 200 and no session cookie', async () => {
    const r = await req('GET', '/pages/practice-status');
    expect(r.status).toBe(200);
    expect(r.raw).toContain('<title>Your Listing Status — GP Link</title>');
  });

  it('.html form canonical-redirects to the clean URL, keeping the token', async () => {
    const r = await req('GET', '/pages/practice-status.html?token=abc');
    expect(r.status).toBe(302);
    expect(String(r.headers.location || '')).toBe('/pages/practice-status?token=abc');
  });

  it('...while the auth gate is active for protected pages in this boot', async () => {
    const r = await req('GET', '/pages/account');
    expect(r.status).toBe(302);
    expect(String(r.headers.location || '')).toContain('/pages/signin');
  });
});

describe('practice status page content', () => {
  let html;
  beforeAll(async () => { html = (await req('GET', '/pages/practice-status')).raw; });

  it('renders from GET /api/practice/status with the URL token', () => {
    expect(html).toContain('/api/practice/status?token=');
  });

  it('has the listings section, status chip, and empty state', () => {
    expect(html).toContain('Your listings');
    expect(html).toContain("Your listing is being set up — we'll be in touch.");
    expect(html).toContain('Listing live');
    expect(html).toContain('Agreement signed');
    expect(html).toContain('Under review');
    expect(html).toContain('Pending approval');
    expect(html).toContain('submitted for your review');
    expect(html).toContain('Interview booked');
  });

  it('has the honest expired/invalid-token state', () => {
    expect(html).toContain('This link has expired or is invalid');
    expect(html).toContain('the latest link from your GP Link email');
  });

  it('has the friendly footer and never says RSO', () => {
    expect(html).toContain('Questions? Reply to your GP Link email or');
    expect(html).not.toMatch(/\bRSO\b/);
  });
});

describe('signed-agreement email links the status page', () => {
  it('confirmation email carries a Track your listing link with the intake token', async () => {
    // Create a prospective practice the way production does (FB webhook)...
    const email = `prac-status-${RUN_ID}@example.com`;
    const hook = await req('POST', '/api/webhooks/facebook-lead?secret=' + encodeURIComponent(FB_SECRET), {
      body: {
        lead_id: `lead-status-${RUN_ID}`,
        practice_name: 'Status Test Practice',
        contact_name: 'Dr Status Tester',
        contact_email: email
      }
    });
    expect(hook.status).toBe(200);
    const row = readDb().atsPractices.find((p) => p.contact_email === email);
    expect(row).toBeTruthy();
    const token = row.intake_token;
    expect(String(token).length).toBeGreaterThanOrEqual(16);
    if (hook && parse(hook.raw) && parse(hook.raw).practice_id) createdPdfPracticeIds.push(parse(hook.raw).practice_id);

    // ...complete the intake form, then sign the agreement.
    const intake = await req('POST', '/api/practice-intake', {
      body: {
        token,
        billing_style: 'mixed',
        dpa: 'yes',
        percentage_split: '70/30',
        suburb: 'Fitzroy',
        nearest_city: 'Melbourne',
        state: 'VIC',
        address: '1 Smith St, Fitzroy VIC 3065',
        urgency: 'asap',
        employment_type: 'either',
        gps_needed: '1'
      }
    });
    expect(intake.status).toBe(200);

    const before = resendCalls.length;
    const sign = await req('POST', '/api/practice-intake/sign', {
      body: { token, signature_data_url: TINY_PNG_DATA_URL, signed_name: 'Dr Status Tester', authorised: true }
    });
    expect(sign.status).toBe(200);

    const sends = resendCalls.slice(before);
    const confirmation = sends.find((c) => {
      const to = c.body && c.body.to;
      return (Array.isArray(to) ? to : [to]).some((t) => String(t || '').includes(email))
        && String(c.body.subject || '').includes('Your signed GP Link agreement');
    });
    expect(confirmation).toBeTruthy();
    const htmlBody = String(confirmation.body.html || '');
    expect(htmlBody).toContain('Track your listing');
    expect(htmlBody).toContain('/pages/practice-status?token=' + encodeURIComponent(token));
    expect(htmlBody).not.toMatch(/\bRSO\b/);
  });
});

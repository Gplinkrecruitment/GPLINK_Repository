import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';

// Verifies: on a NON-production Vercel deployment (VERCEL_ENV='preview'), the
// deployment's OWN Vercel host (VERCEL_URL / VERCEL_BRANCH_URL) is granted
// super_admin scope so the CEO page is viewable on the preview URL — while an
// arbitrary other host is still rejected, and the explicit SUPER_ADMIN_ALLOWED_HOSTS
// entry still works. (Production exclusion is covered by ceo-preview-host-prod.test.js.)

const RUN_ID = crypto.randomBytes(4).toString('hex');
const PREVIEW_URL_HOST = 'gplink-preview-' + RUN_ID + '.vercel.app';   // VERCEL_URL
const PREVIEW_BRANCH_HOST = 'gplink-branch-' + RUN_ID + '.vercel.app'; // VERCEL_BRANCH_URL
const EXPLICIT_SUPER_HOST = 'ceo-test.local';
let server;
let addrPort;

function getWithHost(path, { host, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const hdrs = {};
    if (host) hdrs.Host = host;
    if (cookie) hdrs.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port: addrPort, path, method: 'GET', headers: hdrs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || '', raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function base64UrlEncode(input) {
  return Buffer.from(String(input), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function superCookie() {
  const payload = base64UrlEncode(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return `gp_admin_session=${encodeURIComponent(payload + '.' + sig)}`;
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-secret-preview-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-ceo-preview-${RUN_ID}.json`;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = EXPLICIT_SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  // The key bit: a non-production Vercel deployment exposing its own host vars.
  process.env.VERCEL_ENV = 'preview';
  process.env.VERCEL_URL = PREVIEW_URL_HOST;
  process.env.VERCEL_BRANCH_URL = PREVIEW_BRANCH_HOST;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  const fs = await import('fs');
  try { fs.unlinkSync(`/tmp/gplink-ceo-preview-${RUN_ID}.json`); } catch {}
});

describe('CEO page on a preview deployment (VERCEL_ENV=preview)', () => {
  it('serves the CEO page on the deployment VERCEL_URL host with a super-admin session', async () => {
    const r = await getWithHost('/pages/ceo-dashboard', { host: PREVIEW_URL_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.raw).toMatch(/<!doctype/i);
  });

  it('serves the CEO page on the VERCEL_BRANCH_URL host with a super-admin session', async () => {
    const r = await getWithHost('/pages/ceo-dashboard', { host: PREVIEW_BRANCH_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.raw).toMatch(/<!doctype/i);
  });

  it('still works for the explicit SUPER_ADMIN_ALLOWED_HOSTS entry', async () => {
    const r = await getWithHost('/pages/ceo-dashboard', { host: EXPLICIT_SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.raw).toMatch(/<!doctype/i);
  });

  it('does NOT trust an arbitrary other host (only the deployment\'s own vercel hosts)', async () => {
    const r = await getWithHost('/pages/ceo-dashboard', { host: 'someone-elses-' + RUN_ID + '.vercel.app', cookie: superCookie() });
    expect(r.status).toBe(404);
    expect(r.raw).not.toMatch(/<!doctype/i);
  });
});

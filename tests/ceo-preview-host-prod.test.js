import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';

// SAFETY PROPERTY: in PRODUCTION (VERCEL_ENV='production'), the deployment's own
// Vercel host (VERCEL_URL) is NOT auto-trusted for super_admin scope — production
// still honours ONLY the explicit SUPER_ADMIN_ALLOWED_HOSTS. (NODE_ENV stays 'test'
// so the server boots without the prod Supabase-key requirement; the preview-host
// allowance is gated purely on VERCEL_ENV, so VERCEL_ENV='production' exercises the
// exclusion branch exactly.)

const RUN_ID = crypto.randomBytes(4).toString('hex');
const PROD_DEPLOY_HOST = 'gplink-prod-' + RUN_ID + '.vercel.app'; // VERCEL_URL in "production"
const EXPLICIT_SUPER_HOST = 'ceo-prod-' + RUN_ID + '.local';
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
  process.env.AUTH_SECRET = 'test-secret-prevprod-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-ceo-prevprod-${RUN_ID}.json`;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = EXPLICIT_SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.VERCEL_ENV = 'production'; // <-- production: VERCEL_URL must NOT be trusted
  process.env.VERCEL_URL = PROD_DEPLOY_HOST;
  process.env.VERCEL_BRANCH_URL = PROD_DEPLOY_HOST;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  const fs = await import('fs');
  try { fs.unlinkSync(`/tmp/gplink-ceo-prevprod-${RUN_ID}.json`); } catch {}
});

describe('CEO page in production (VERCEL_ENV=production) does NOT auto-trust the deployment host', () => {
  it('404s the CEO page on the production VERCEL_URL host even with a super-admin session', async () => {
    const r = await getWithHost('/pages/ceo-dashboard', { host: PROD_DEPLOY_HOST, cookie: superCookie() });
    expect(r.status).toBe(404);
    expect(r.raw).not.toMatch(/<!doctype/i);
  });

  it('still serves the CEO page on the explicit SUPER_ADMIN_ALLOWED_HOSTS entry in production', async () => {
    const r = await getWithHost('/pages/ceo-dashboard', { host: EXPLICIT_SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.raw).toMatch(/<!doctype/i);
  });
});

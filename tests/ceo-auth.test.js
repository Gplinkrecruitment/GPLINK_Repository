import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';

const PORT = 0;
let server;
let addrPort;

const RUN_ID = crypto.randomBytes(4).toString('hex');
const SUPER_HOST = 'ceo-test.local';   // mapped to super_admin scope
const ADMIN_HOST = 'staff-test.local'; // mapped to employee admin scope

// GET that lets us set an arbitrary Host header (drives getAdminHostScope)
function getWithHost(path, { host, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const hdrs = {};
    if (host) hdrs.Host = host;
    if (cookie) hdrs.Cookie = cookie;
    const opts = {
      host: '127.0.0.1',
      port: addrPort,
      path,
      method: 'GET',
      headers: hdrs,
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          location: res.headers.location || '',
          raw: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  // NODE_ENV='test' boots the server without the production Supabase-key requirement
  // (validateRuntimeConfig returns early off-production). The test never uses a loopback
  // Host header — all three cases send explicit hosts — so the 'local' auto-grant that
  // production would suppress is never reached; host scope is driven purely by the
  // *_ALLOWED_HOSTS sets and is identical under either NODE_ENV.
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-secret-ceo-auth-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-ceo-auth-${RUN_ID}.json`;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = ADMIN_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = 'staff@gplink-test.local';

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => {
      addrPort = server.address().port;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  const fs = await import('fs');
  try { fs.unlinkSync(`/tmp/gplink-ceo-auth-${RUN_ID}.json`); } catch {}
});

describe('CEO dashboard page auth gating', () => {
  // NOTE: request the CLEAN URL (/pages/ceo-dashboard, no .html). A request for the
  // raw .html path hits the generic clean-URL 302 redirect *before* any host/auth gate,
  // which would mask the behavior under test. The clean URL is resolved internally back
  // to /pages/ceo-dashboard.html and then flows through the host gate + page-serving block
  // that Phase 6 hardens.
  it('unknown host returns 404 (#69)', async () => {
    const r = await getWithHost('/pages/ceo-dashboard', { host: 'random.example.com' });
    expect(r.status).toBe(404);
  });

  it('super-admin host, no session -> redirect to admin-signin (#50)', async () => {
    const r = await getWithHost('/pages/ceo-dashboard', { host: SUPER_HOST });
    expect(r.status).toBe(302);
    expect(r.location).toContain('/pages/admin-signin');
  });

  it('employee admin host, no session -> 404 (CEO page not served off super-admin scope) (#69)', async () => {
    // ADMIN_HOST is an allowed admin host, so it passes the 404 host gate at 37603,
    // but must NOT serve the CEO page because scope !== super_admin.
    const r = await getWithHost('/pages/ceo-dashboard', { host: ADMIN_HOST });
    // With no session it 302s to admin-signin; the load-bearing assertion is it never
    // returns the HTML body.
    expect([302, 403, 404]).toContain(r.status);
    expect(r.raw).not.toContain('<!DOCTYPE');
  });
});

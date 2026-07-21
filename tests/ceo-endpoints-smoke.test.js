import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Runtime smoke test for the CEO Command Centre endpoints.
//
// Goal: prove the /api/ceo/* GET handlers do NOT throw / 500 and return the
// correct top-level JSON shape, catching arg-order / undefined-var wiring bugs
// (e.g. a handler referencing a function that was never defined). Data being
// empty in test mode is fine — we are exercising the handler logic, not the DB.
//
// Boot + super-admin session minting reuse the EXACT pattern from
// tests/ceo-auth.test.js (createServer + headless gp_admin_session cookie).
//
// KEY: unlike ceo-auth.test.js we point SUPABASE at an UNREACHABLE localhost
// port and supply a dummy service-role key. This makes isSupabaseDbConfigured()
// return true (so the handlers do NOT short-circuit to 503), while every
// supabaseDbRequest() fetch fails fast with connection-refused and is caught
// inside the helper (returns {ok:false,...}). The handlers then proceed with
// empty arrays and run their FULL aggregation logic. This is read-only and
// touches NO real Supabase / third-party service — the target host is a closed
// loopback port, so nothing leaves the machine.
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 0;
let server;
let addrPort;

const RUN_ID = crypto.randomBytes(4).toString('hex');
const SUPER_HOST = 'ceo-test.local'; // mapped to super_admin scope

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

function base64UrlEncode(input) {
  return Buffer.from(String(input), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function mintAdminCookie(email, adminRole) {
  const expiresAt = Date.now() + 60 * 60 * 1000; // 1h in the future
  const userProfile = { email, adminRole };
  const payload = base64UrlEncode(JSON.stringify({ userProfile, expiresAt }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  const token = `${payload}.${sig}`;
  return `gp_admin_session=${encodeURIComponent(token)}`;
}

function superCookie() {
  return mintAdminCookie('super@gplink-test.local', 'super_admin');
}

// Parse JSON body if possible; otherwise return the raw text so failing
// assertions surface the actual (e.g. "Internal Server Error") body.
function parseBody(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-secret-ceo-smoke-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  // Configure Supabase to an UNREACHABLE loopback port + dummy key so
  // isSupabaseDbConfigured() is true (no 503 short-circuit) but every fetch
  // fails fast and is swallowed by supabaseDbRequest's try/catch.
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-service-role-key-smoke';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = `/tmp/gplink-ceo-smoke-${RUN_ID}.json`;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';

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
  try { fs.unlinkSync(`/tmp/gplink-ceo-smoke-${RUN_ID}.json`); } catch {}
});

describe('CEO endpoints runtime smoke (no 500 / correct shape)', () => {
  it('GET /api/ceo/dashboard -> 200 with expected top-level keys', async () => {
    const cookie = superCookie();
    const r = await getWithHost('/api/ceo/dashboard', { host: SUPER_HOST, cookie });
    // Must not 500 / crash the handler.
    expect(r.status).not.toBe(500);
    expect(r.raw).not.toMatch(/Internal Server Error/i);
    // With a valid super-admin session on the super-admin host it should be 200.
    expect(r.status).toBe(200);
    const body = parseBody(r.raw);
    expect(body).toBeTypeOf('object');
    expect(body.ok).toBe(true);
    // Dashboard shape (single-source-of-truth aggregates). Note the workload key
    // is `va_workload`, not `rso`.
    for (const key of [
      'kpi', 'pipeline', 'blockers', 'task_health', 'va_workload',
      'placements', 'gp_activity', 'tickets', 'completions',
    ]) {
      expect(body, `dashboard missing key: ${key}`).toHaveProperty(key);
    }
  });

  it('GET /api/ceo/rsos -> 200 with rsos array', async () => {
    const cookie = superCookie();
    const r = await getWithHost('/api/ceo/rsos', { host: SUPER_HOST, cookie });
    expect(r.status).not.toBe(500);
    expect(r.raw).not.toMatch(/Internal Server Error/i);
    expect(r.status).toBe(200);
    const body = parseBody(r.raw);
    expect(body).toBeTypeOf('object');
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.rsos), 'rsos should be an array').toBe(true);
  });

  it('GET /api/ceo/drilldown/pipeline -> 200 with section/items', async () => {
    const cookie = superCookie();
    const r = await getWithHost('/api/ceo/drilldown/pipeline', { host: SUPER_HOST, cookie });
    expect(r.status).not.toBe(500);
    expect(r.raw).not.toMatch(/Internal Server Error/i);
    expect(r.status).toBe(200);
    const body = parseBody(r.raw);
    expect(body).toBeTypeOf('object');
    expect(body.ok).toBe(true);
    expect(body.section).toBe('pipeline');
    expect(Array.isArray(body.items), 'drilldown items should be an array').toBe(true);
  });

  it('GET /api/ceo/rso/__unassigned__/summary -> 200 with rso/gps/task_counts', async () => {
    // __unassigned__ always resolves in the handler (rsoMeta set directly), so
    // it never 404s on a missing roster row — the ideal always-resolvable id.
    const cookie = superCookie();
    const r = await getWithHost('/api/ceo/rso/__unassigned__/summary', { host: SUPER_HOST, cookie });
    expect(r.status).not.toBe(500);
    expect(r.raw).not.toMatch(/Internal Server Error/i);
    expect(r.status).toBe(200);
    const body = parseBody(r.raw);
    expect(body).toBeTypeOf('object');
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty('rso');
    expect(Array.isArray(body.gps), 'gps should be an array').toBe(true);
    expect(body).toHaveProperty('task_counts');
  });
});

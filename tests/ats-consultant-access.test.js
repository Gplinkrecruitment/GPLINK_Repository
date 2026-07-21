// Task A, consultant role + requireAtsSession.
//
// Boots the real server against the in-memory PostgREST emulator pattern from
// tests/ats-practice-link.test.js, extended with a tiny Supabase AUTH emulator
// (/auth/v1/token password grant + /auth/v1/recover) so the FULL admin login
// pipeline runs and role resolution (user_roles row → env → runtime_kv
// 'ats_consultants') is exercised end-to-end.
//
// Covers:
//  1. consultant session passes requireAtsSession (/api/ats/jobs) and the five
//     ATS-shared /api/ceo/* routes (candidates, pipeline-summary, meetings)
//  2. consultant is 403 on CEO-only routes (/api/ceo/dashboard, /api/ceo/rsos)
//     and on generic admin routes (POST /api/admin/rsos is requireAdminSession)
//  3. role 'admin' is 403 on /api/ats/jobs (both hosts: host mismatch on the
//     super host, requireAtsSession role gate on the employee host)
//  4. consultant is rejected on the employee admin host entirely
//  5. super_admin still passes everything it did before
//  6. login resolves 'consultant' from the runtime_kv list, the env list and a
//     user_roles DB row, and the minted session then passes /api/ats/jobs
//  7. password reset sends a recovery for consultant emails (env + kv) but not
//     for strangers
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ats-consultant-${RUN_ID}.json`);
let server, port;          // app under test
let sbServer, sbPort;      // Supabase (PostgREST + auth) emulator

const SUPER_HOST = 'ceo-ats.local';
const ADMIN_HOST = 'admin-ats.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const ADMIN_EMAIL = 'employee@gplink-test.local';
const ENV_CONSULTANT = 'consultant@gplink-test.local';
const KV_CONSULTANT = 'kvconsultant@gplink-test.local';
const DB_CONSULTANT = 'dbconsultant@gplink-test.local';
const STRANGER = 'stranger@gplink-test.local';
const PASSWORD = 'test-password-1';
const NOW = new Date().toISOString();

// Emails the auth emulator will accept for the password grant.
const AUTH_USERS = {
  [KV_CONSULTANT]: { id: 'u-kv-consultant' },
  [ENV_CONSULTANT]: { id: 'u-env-consultant' },
  [DB_CONSULTANT]: { id: 'u-db-consultant' },
  [STRANGER]: { id: 'u-stranger' }
};
// Emails /auth/v1/recover was called for (password-reset assertions).
const recoverCalls = [];

// ── In-memory PostgREST emulator ────────────────────────────────────────────
const db = {
  user_roles: [
    { user_id: 'u-db-consultant', role: 'consultant' }
  ],
  runtime_kv: [
    { key: 'ats_consultants', value: [KV_CONSULTANT], expires_at: null }
  ],
  user_profiles: [],
  registration_cases: [],
  gp_applications: [],
  practices: [
    { id: 'p1', name: 'Test Family Practice', source: 'internal_ats', is_active: true, created_at: NOW }
  ],
  career_roles: [
    { id: 'role-1', provider: 'internal_ats', provider_role_id: 'ats_r1', title: 'GP, Test', practice_name: 'Test Family Practice', practice_id: 'p1', is_active: true, job_status: 'open', updated_at: NOW }
  ]
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'];
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue; // unsupported → don't filter
    const val = raw.slice(dot + 1);
    filters.push({ col: key, op, val });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
    if (op === 'neq') return String(cell) !== val;
    if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    if (op === 'in') {
      return val.replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''))
        .includes(String(cell));
    }
    return true;
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); }
      catch { resolve(null); }
    });
  });
}

function startSupabaseEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      // ── Auth endpoints ──
      if (u.pathname === '/auth/v1/token' && req.method === 'POST') {
        const body = (await readBody(req)) || {};
        const email = String(body.email || '').toLowerCase();
        const known = AUTH_USERS[email];
        if (known && body.password === PASSWORD) {
          send(200, { access_token: 'tok-' + known.id, user: { id: known.id, email } });
        } else {
          send(400, { msg: 'Invalid login credentials' });
        }
        return;
      }
      if (u.pathname === '/auth/v1/recover' && req.method === 'POST') {
        const body = (await readBody(req)) || {};
        recoverCalls.push(String(body.email || '').toLowerCase());
        send(200, {});
        return;
      }
      if (u.pathname.startsWith('/auth/v1/')) { send(200, {}); return; }
      // ── PostgREST ──
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const table = decodeURIComponent(m[1]);
      const rows = tableOf(table);
      const matches = buildMatcher(u.searchParams);

      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out);
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const conflictCol = u.searchParams.get('on_conflict');
        const saved = incoming.map((r) => {
          if (conflictCol) {
            const existing = rows.find((row) => row && String(row[conflictCol]) === String(r[conflictCol]));
            if (existing) { Object.assign(existing, r); return existing; }
          }
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          rows.push(row);
          return row;
        });
        send(201, saved);
        return;
      }
      if (req.method === 'PATCH') {
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched);
        return;
      }
      if (req.method === 'DELETE') {
        const keep = rows.filter((row) => !matches(row));
        rows.length = 0;
        keep.forEach((row) => rows.push(row));
        send(200, []);
        return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

// ── Session cookie minting (pattern from tests/ats-endpoints.test.js) ──────
function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function adminCookieFor(email, adminRole) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
const superCookie = () => adminCookieFor(SUPER_EMAIL, 'super_admin');
const consultantCookie = () => adminCookieFor(ENV_CONSULTANT, 'consultant');
const employeeCookie = () => adminCookieFor(ADMIN_EMAIL, 'admin');

function httpReq(method, p, { cookie, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (host) headers.Host = host;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    r.on('error', reject); r.end(data);
  });
}

function extractAdminCookie(setCookieHeader) {
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : (setCookieHeader ? [setCookieHeader] : []);
  const hit = list.find((c) => c.startsWith('gp_admin_session='));
  return hit ? hit.split(';')[0] : '';
}

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ats-consultant-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.ZOHO_RECRUIT_REDIRECT_URI = '';
  process.env.OPENAI_API_KEY = '';
  process.env.RESEND_API_KEY = '';
  // Hosts: distinct super-admin and employee-admin scopes.
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = ADMIN_HOST;
  // Role allow-lists.
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  process.env.CONSULTANT_EMAILS = ENV_CONSULTANT;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('consultant passes the ATS surface (super-admin host)', () => {
  it('GET /api/ats/jobs → 200', async () => {
    const r = await httpReq('GET', '/api/ats/jobs', { host: SUPER_HOST, cookie: consultantCookie() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(Array.isArray(r.body.jobs)).toBe(true);
  });
  it('GET /api/ceo/candidates → 200', async () => {
    const r = await httpReq('GET', '/api/ceo/candidates', { host: SUPER_HOST, cookie: consultantCookie() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
  it('GET /api/ceo/pipeline-summary → 200', async () => {
    const r = await httpReq('GET', '/api/ceo/pipeline-summary', { host: SUPER_HOST, cookie: consultantCookie() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
  it('GET /api/ceo/meetings → 200', async () => {
    const r = await httpReq('GET', '/api/ceo/meetings', { host: SUPER_HOST, cookie: consultantCookie() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
  it('GET /api/admin/auth/session → authenticated with role consultant', async () => {
    const r = await httpReq('GET', '/api/admin/auth/session', { host: SUPER_HOST, cookie: consultantCookie() });
    expect(r.status).toBe(200);
    expect(r.body.authenticated).toBe(true);
    expect(r.body.profile.adminRole).toBe('consultant');
  });
});

describe('consultant is fenced OFF everything else', () => {
  it('GET /api/ceo/dashboard → 403 (CEO-only)', async () => {
    const r = await httpReq('GET', '/api/ceo/dashboard', { host: SUPER_HOST, cookie: consultantCookie() });
    expect(r.status).toBe(403);
  });
  it('GET /api/ceo/rsos → 403 (CEO-only)', async () => {
    const r = await httpReq('GET', '/api/ceo/rsos', { host: SUPER_HOST, cookie: consultantCookie() });
    expect(r.status).toBe(403);
  });
  it('POST /api/admin/rsos → 403 (generic admin route via requireAdminSession)', async () => {
    const r = await httpReq('POST', '/api/admin/rsos', { host: SUPER_HOST, cookie: consultantCookie(), body: { name: 'X', email: 'x@y.z' } });
    expect(r.status).toBe(403);
  });
  it('GET /api/admin/case list route → 403 (generic admin route)', async () => {
    const r = await httpReq('GET', '/api/admin/rsos', { host: SUPER_HOST, cookie: consultantCookie() });
    expect(r.status).toBe(403);
  });
  it('is rejected on the employee admin host (API 403)', async () => {
    const r = await httpReq('GET', '/api/ats/jobs', { host: ADMIN_HOST, cookie: consultantCookie() });
    expect(r.status).toBe(403);
    const s = await httpReq('GET', '/api/admin/auth/session', { host: ADMIN_HOST, cookie: consultantCookie() });
    expect(s.status).toBe(403);
  });
});

describe("role 'admin' cannot reach the ATS", () => {
  it('403 on /api/ats/jobs from the super-admin host (host mismatch)', async () => {
    const r = await httpReq('GET', '/api/ats/jobs', { host: SUPER_HOST, cookie: employeeCookie() });
    expect(r.status).toBe(403);
  });
  it('403 on /api/ats/jobs from the employee host (requireAtsSession role gate)', async () => {
    const r = await httpReq('GET', '/api/ats/jobs', { host: ADMIN_HOST, cookie: employeeCookie() });
    expect(r.status).toBe(403);
    expect(String(r.body && r.body.message || '')).toMatch(/ATS access/i);
  });
});

describe('super_admin is unaffected', () => {
  it('still passes /api/ats/jobs and the shared /api/ceo routes', async () => {
    for (const p of ['/api/ats/jobs', '/api/ceo/candidates', '/api/ceo/pipeline-summary', '/api/ceo/meetings']) {
      const r = await httpReq('GET', p, { host: SUPER_HOST, cookie: superCookie() });
      expect(r.status, `super_admin on ${p}`).toBe(200);
      expect(r.body.ok, `super_admin on ${p}`).toBe(true);
    }
  });
  it('still passes CEO-only routes (/api/ceo/dashboard)', async () => {
    const r = await httpReq('GET', '/api/ceo/dashboard', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
  it('still passes generic admin routes (POST /api/admin/rsos reaches validation, not 401/403/404)', async () => {
    const r = await httpReq('POST', '/api/admin/rsos', { host: SUPER_HOST, cookie: superCookie(), body: {} });
    expect([401, 403, 404]).not.toContain(r.status);
  });
});

describe('login role resolution (user_roles row → env → runtime_kv)', () => {
  it('runtime_kv consultant: login resolves consultant and the session passes the ATS', async () => {
    const login = await httpReq('POST', '/api/admin/auth/login', {
      host: SUPER_HOST,
      body: { email: KV_CONSULTANT, password: PASSWORD }
    });
    expect(login.status).toBe(200);
    expect(login.body.ok).toBe(true);
    expect(login.body.profile.adminRole).toBe('consultant');
    const cookie = extractAdminCookie(login.headers['set-cookie']);
    expect(cookie).toBeTruthy();
    const jobs = await httpReq('GET', '/api/ats/jobs', { host: SUPER_HOST, cookie });
    expect(jobs.status).toBe(200);
    expect(jobs.body.ok).toBe(true);
    const dash = await httpReq('GET', '/api/ceo/dashboard', { host: SUPER_HOST, cookie });
    expect(dash.status).toBe(403);
  });
  it('env consultant: login resolves consultant', async () => {
    const login = await httpReq('POST', '/api/admin/auth/login', {
      host: SUPER_HOST,
      body: { email: ENV_CONSULTANT, password: PASSWORD }
    });
    expect(login.status).toBe(200);
    expect(login.body.profile.adminRole).toBe('consultant');
  });
  it('user_roles DB row wins: login resolves consultant from the row', async () => {
    const login = await httpReq('POST', '/api/admin/auth/login', {
      host: SUPER_HOST,
      body: { email: DB_CONSULTANT, password: PASSWORD }
    });
    expect(login.status).toBe(200);
    expect(login.body.profile.adminRole).toBe('consultant');
  });
  it('stranger with valid credentials is refused the portal', async () => {
    const login = await httpReq('POST', '/api/admin/auth/login', {
      host: SUPER_HOST,
      body: { email: STRANGER, password: PASSWORD }
    });
    expect(login.status).toBe(403);
  });
  it('consultant login on the employee host is refused', async () => {
    const login = await httpReq('POST', '/api/admin/auth/login', {
      host: ADMIN_HOST,
      body: { email: ENV_CONSULTANT, password: PASSWORD }
    });
    expect(login.status).toBe(403);
  });
});

describe('admin password reset covers consultants', () => {
  it('sends a recovery for a runtime_kv consultant email', async () => {
    recoverCalls.length = 0;
    const r = await httpReq('POST', '/api/admin/auth/reset-password', {
      host: SUPER_HOST,
      body: { email: KV_CONSULTANT }
    });
    expect(r.status).toBe(200);
    expect(recoverCalls).toContain(KV_CONSULTANT);
  });
  it('sends a recovery for an env consultant email', async () => {
    recoverCalls.length = 0;
    const r = await httpReq('POST', '/api/admin/auth/reset-password', {
      host: SUPER_HOST,
      body: { email: ENV_CONSULTANT }
    });
    expect(r.status).toBe(200);
    expect(recoverCalls).toContain(ENV_CONSULTANT);
  });
  it('does NOT send a recovery for a stranger (still replies 200 to prevent enumeration)', async () => {
    recoverCalls.length = 0;
    const r = await httpReq('POST', '/api/admin/auth/reset-password', {
      host: SUPER_HOST,
      body: { email: STRANGER }
    });
    expect(r.status).toBe(200);
    expect(recoverCalls).toEqual([]);
  });
});

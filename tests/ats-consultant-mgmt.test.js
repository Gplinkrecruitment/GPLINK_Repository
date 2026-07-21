// Task E, consultant management endpoints + ATS-only dashboard experience.
//
// Reuses the Task A harness (tests/ats-consultant-access.test.js): real server
// booted against an in-memory PostgREST emulator + a tiny Supabase AUTH
// emulator, extended here with the admin endpoints the invite flow needs
// (POST /auth/v1/admin/users, POST /auth/v1/admin/generate_link) and a
// global-fetch interceptor for the Resend API so "invite email attempted" is
// observable without any network.
//
// Covers:
//  1. GET /api/ats/consultants (CEO only): env entries marked source 'env',
//     kv entries (legacy array shape) marked 'kv'
//  2. POST add: auth user created when absent, recovery link generated,
//     branded invite email attempted, kv persisted in the RICHER shape
//     { consultants: [{email,name,added_at,added_by}] }
//  3. isConsultantEmail still resolves the richer shape: the added consultant
//     can log in (role 'consultant') and passes /api/ats/jobs
//  4. duplicate add is idempotent (no second auth-user create, kv unchanged)
//  5. adding an email whose auth user already exists skips creation but still
//     invites
//  6. DELETE: kv consultant removed (login then refused), env-sourced → 400
//  7. non-CEO (consultant) cannot manage the team (403 on GET/POST/DELETE)
//  8. page serve: consultant GET /pages/ceo-dashboard.html → 200; role 'admin'
//     → 302 back to sign-in; wrong host → 404
//  9. 3(c) opened route /api/admin/career/application/submit-to-practice:
//     consultant passes auth (reaches validation), RSO admin keeps access on
//     the employee host, role 'admin' is still 403 on the super host
// 10. /api/ats/interview/request stamps assigned_rso_email with the ATS
//     session email (host_kind stays 'ceo')
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ats-mgmt-${RUN_ID}.json`);
let server, port;          // app under test
let sbServer, sbPort;      // Supabase (PostgREST + auth) emulator

const SUPER_HOST = 'ceo-ats.local';
const ADMIN_HOST = 'admin-ats.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const ADMIN_EMAIL = 'employee@gplink-test.local';
const ENV_CONSULTANT = 'envconsultant@gplink-test.local';
const KV_CONSULTANT = 'kvconsultant@gplink-test.local';       // seeded in the LEGACY array shape
const NEW_CONSULTANT = 'newconsultant@gplink-test.local';     // added via POST (no auth user yet)
const EXISTING_USER = 'existinguser@gplink-test.local';       // has an auth user already
const PASSWORD = 'test-password-1';
const NOW = new Date().toISOString();

// Emails the auth emulator accepts for the password grant (id per email).
// POST /auth/v1/admin/users adds to this map, so an invited consultant can
// then "log in" once we assign them a password below.
const AUTH_USERS = {
  [EXISTING_USER]: { id: 'u-existing' }
};
const createdAuthUsers = [];   // emails POSTed to /auth/v1/admin/users
const generatedLinks = [];     // {type, email} from /auth/v1/admin/generate_link
const recoverCalls = [];       // emails /auth/v1/recover was called for
const resendCalls = [];        // {to, subject} sent to the Resend API

// ── In-memory PostgREST emulator ────────────────────────────────────────────
const db = {
  user_roles: [],
  runtime_kv: [
    // Legacy Task A write shape (plain array), the reader must still accept it.
    { key: 'ats_consultants', value: [KV_CONSULTANT], expires_at: null }
  ],
  user_profiles: [],
  registration_cases: [],
  user_state: [],
  gp_applications: [
    { id: 'app-1', user_id: 'u-gp-1', career_role_id: 'role-1', practice_submission_status: 'pending_va_submission', created_at: NOW }
  ],
  scheduled_calls: [],
  practices: [
    { id: 'p1', name: 'Test Family Practice', source: 'internal_ats', is_active: true, contact_email: 'reception@practice-test.local', created_at: NOW }
  ],
  career_roles: [
    { id: 'role-1', provider: 'internal_ats', provider_role_id: 'ats_r1', title: 'GP, Test', practice_name: 'Test Family Practice', practice_id: 'p1', is_active: true, job_status: 'open', updated_at: NOW }
  ]
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }
const kvConsultantsRow = () => db.runtime_kv.find((r) => r.key === 'ats_consultants');

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
      if (u.pathname === '/auth/v1/admin/users' && req.method === 'POST') {
        const body = (await readBody(req)) || {};
        const email = String(body.email || '').toLowerCase();
        if (AUTH_USERS[email]) { send(422, { msg: 'A user with this email address has already been registered' }); return; }
        const id = 'u-created-' + email.split('@')[0];
        AUTH_USERS[email] = { id };
        createdAuthUsers.push(email);
        send(200, { id, email });
        return;
      }
      if (u.pathname === '/auth/v1/admin/generate_link' && req.method === 'POST') {
        const body = (await readBody(req)) || {};
        generatedLinks.push({ type: String(body.type || ''), email: String(body.email || '').toLowerCase() });
        send(200, { action_link: 'http://sb.local/verify?type=recovery&email=' + encodeURIComponent(body.email || '') });
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

// ── Resend interceptor (global fetch wrapper) ──────────────────────────────
let realFetch;
function installFetchInterceptor() {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const target = typeof input === 'string' ? input : String((input && input.url) || '');
    if (target.startsWith('https://api.resend.com/')) {
      let parsed = {};
      try { parsed = JSON.parse((init && init.body) || '{}'); } catch {}
      resendCalls.push({ to: parsed.to, subject: parsed.subject || '' });
      return new Response(JSON.stringify({ id: 'test-email-id' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };
}

beforeAll(async () => {
  await startSupabaseEmulator();
  installFetchInterceptor();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ats-mgmt-secret-' + RUN_ID;
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
  // Email IS configured so the branded invite send is attempted (and captured
  // by the fetch interceptor, never a real network call).
  process.env.RESEND_API_KEY = 'test-resend-key';
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
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('GET /api/ats/consultants (CEO only)', () => {
  it('lists env + kv consultants with sources', async () => {
    const r = await httpReq('GET', '/api/ats/consultants', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const byEmail = Object.fromEntries(r.body.consultants.map((c) => [c.email, c]));
    expect(byEmail[ENV_CONSULTANT]).toBeTruthy();
    expect(byEmail[ENV_CONSULTANT].source).toBe('env');
    // Legacy array kv shape still resolves.
    expect(byEmail[KV_CONSULTANT]).toBeTruthy();
    expect(byEmail[KV_CONSULTANT].source).toBe('kv');
  });

  it('403 for a consultant (cannot manage the team)', async () => {
    const r = await httpReq('GET', '/api/ats/consultants', { host: SUPER_HOST, cookie: consultantCookie() });
    expect(r.status).toBe(403);
  });

  it('401 without a session', async () => {
    const r = await httpReq('GET', '/api/ats/consultants', { host: SUPER_HOST });
    expect(r.status).toBe(401);
  });
});

describe('POST /api/ats/consultants, invite flow', () => {
  it('creates the auth user, generates a recovery link, attempts the invite email, persists the richer kv shape', async () => {
    const r = await httpReq('POST', '/api/ats/consultants', {
      host: SUPER_HOST, cookie: superCookie(),
      body: { name: 'New Consultant', email: NEW_CONSULTANT }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.consultant.email).toBe(NEW_CONSULTANT);
    expect(r.body.consultant.source).toBe('kv');
    expect(r.body.invite_sent).toBe(true);

    // Auth user was created (it did not exist).
    expect(createdAuthUsers).toContain(NEW_CONSULTANT);
    // Set-password link came from the recovery generate_link flow.
    expect(generatedLinks.some((l) => l.type === 'recovery' && l.email === NEW_CONSULTANT)).toBe(true);
    // Branded invite email was attempted via Resend.
    const invite = resendCalls.find((c) => (c.to || []).includes(NEW_CONSULTANT));
    expect(invite).toBeTruthy();
    expect(invite.subject).toMatch(/invited to the GP Link ATS/i);

    // kv now holds the STANDARDIZED richer shape and kept the legacy entry.
    const row = kvConsultantsRow();
    expect(Array.isArray(row.value.consultants)).toBe(true);
    const emails = row.value.consultants.map((c) => c.email);
    expect(emails).toContain(KV_CONSULTANT);
    expect(emails).toContain(NEW_CONSULTANT);
    const entry = row.value.consultants.find((c) => c.email === NEW_CONSULTANT);
    expect(entry.name).toBe('New Consultant');
    expect(entry.added_by).toBe(SUPER_EMAIL);
    expect(typeof entry.added_at).toBe('string');
  });

  it('isConsultantEmail resolves the richer shape: the invited consultant can log in and use the ATS', async () => {
    // Simulate the consultant completing the set-password link.
    AUTH_USERS[NEW_CONSULTANT] = AUTH_USERS[NEW_CONSULTANT] || { id: 'u-created-newconsultant' };
    const login = await httpReq('POST', '/api/admin/auth/login', {
      host: SUPER_HOST,
      body: { email: NEW_CONSULTANT, password: PASSWORD }
    });
    expect(login.status).toBe(200);
    expect(login.body.profile.adminRole).toBe('consultant');
    const cookie = extractAdminCookie(login.headers['set-cookie']);
    const jobs = await httpReq('GET', '/api/ats/jobs', { host: SUPER_HOST, cookie });
    expect(jobs.status).toBe(200);
    expect(jobs.body.ok).toBe(true);
  });

  it('duplicate add is idempotent (no second auth-user create, kv unchanged)', async () => {
    const before = kvConsultantsRow().value.consultants.length;
    const creates = createdAuthUsers.length;
    const r = await httpReq('POST', '/api/ats/consultants', {
      host: SUPER_HOST, cookie: superCookie(),
      body: { name: 'New Consultant', email: NEW_CONSULTANT }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.already).toBe(true);
    expect(kvConsultantsRow().value.consultants.length).toBe(before);
    expect(createdAuthUsers.length).toBe(creates);
  });

  it('existing auth user: skips creation but still invites', async () => {
    const creates = createdAuthUsers.length;
    const r = await httpReq('POST', '/api/ats/consultants', {
      host: SUPER_HOST, cookie: superCookie(),
      body: { name: 'Existing User', email: EXISTING_USER }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(createdAuthUsers.length).toBe(creates); // 422 already-registered tolerated
    expect(generatedLinks.some((l) => l.type === 'recovery' && l.email === EXISTING_USER)).toBe(true);
    expect(resendCalls.some((c) => (c.to || []).includes(EXISTING_USER))).toBe(true);
  });

  it('rejects an invalid email', async () => {
    const r = await httpReq('POST', '/api/ats/consultants', {
      host: SUPER_HOST, cookie: superCookie(), body: { name: 'X', email: 'not-an-email' }
    });
    expect(r.status).toBe(400);
  });

  it('rejects an email that already has admin access', async () => {
    const r = await httpReq('POST', '/api/ats/consultants', {
      host: SUPER_HOST, cookie: superCookie(), body: { name: 'Boss', email: SUPER_EMAIL }
    });
    expect(r.status).toBe(400);
  });

  it('403 for a consultant', async () => {
    const r = await httpReq('POST', '/api/ats/consultants', {
      host: SUPER_HOST, cookie: consultantCookie(), body: { name: 'X', email: 'x@y.z' }
    });
    expect(r.status).toBe(403);
  });
});

describe('DELETE /api/ats/consultants', () => {
  it('400 for an env-sourced consultant (explains the environment variable)', async () => {
    const r = await httpReq('DELETE', '/api/ats/consultants?email=' + encodeURIComponent(ENV_CONSULTANT), {
      host: SUPER_HOST, cookie: superCookie()
    });
    expect(r.status).toBe(400);
    expect(String(r.body.message || '')).toMatch(/CONSULTANT_EMAILS/);
    // Still listed (nothing was removed).
    const list = await httpReq('GET', '/api/ats/consultants', { host: SUPER_HOST, cookie: superCookie() });
    expect(list.body.consultants.some((c) => c.email === ENV_CONSULTANT)).toBe(true);
  });

  it('removes a kv consultant and their access is revoked immediately', async () => {
    const r = await httpReq('DELETE', '/api/ats/consultants?email=' + encodeURIComponent(KV_CONSULTANT), {
      host: SUPER_HOST, cookie: superCookie()
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.removed).toBe(true);
    const emails = kvConsultantsRow().value.consultants.map((c) => c.email);
    expect(emails).not.toContain(KV_CONSULTANT);
    // Login no longer resolves a portal role (cache was invalidated).
    AUTH_USERS[KV_CONSULTANT] = { id: 'u-kv-consultant' };
    const login = await httpReq('POST', '/api/admin/auth/login', {
      host: SUPER_HOST, body: { email: KV_CONSULTANT, password: PASSWORD }
    });
    expect(login.status).toBe(403);
  });

  it('403 for a consultant', async () => {
    const r = await httpReq('DELETE', '/api/ats/consultants?email=someone@x.y', {
      host: SUPER_HOST, cookie: consultantCookie()
    });
    expect(r.status).toBe(403);
  });
});

describe('page serve: /pages/ceo-dashboard', () => {
  // NOTE: /pages/*.html 302s to the clean URL first, so request the clean path.
  it('200 for a consultant on the super-admin host', async () => {
    const r = await httpReq('GET', '/pages/ceo-dashboard', { host: SUPER_HOST, cookie: consultantCookie() });
    expect(r.status).toBe(200);
    expect(r.raw).toMatch(/Command Centre/);
  });
  it('still 200 for super_admin', async () => {
    const r = await httpReq('GET', '/pages/ceo-dashboard', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
  });
  it("302 to sign-in for role 'admin' (not an ATS role)", async () => {
    const r = await httpReq('GET', '/pages/ceo-dashboard', { host: SUPER_HOST, cookie: employeeCookie() });
    expect(r.status).toBe(302);
    expect(String(r.headers.location || '')).toMatch(/admin-signin/);
  });
  it('404 on the employee host regardless of role', async () => {
    const r = await httpReq('GET', '/pages/ceo-dashboard', { host: ADMIN_HOST, cookie: consultantCookie() });
    expect(r.status).toBe(404);
  });
});

describe('3(c) opened route: submit-to-practice accepts admin roles AND consultants', () => {
  it('consultant passes the guard (reaches applicationId validation)', async () => {
    const r = await httpReq('POST', '/api/admin/career/application/submit-to-practice', {
      host: SUPER_HOST, cookie: consultantCookie(), body: {}
    });
    expect(r.status).toBe(400);
    expect(String(r.body.message || '')).toMatch(/applicationId/i);
  });
  it('RSO admin keeps access on the employee host (unchanged semantics)', async () => {
    const r = await httpReq('POST', '/api/admin/career/application/submit-to-practice', {
      host: ADMIN_HOST, cookie: employeeCookie(), body: {}
    });
    expect(r.status).toBe(400);
    expect(String(r.body.message || '')).toMatch(/applicationId/i);
  });
  it("role 'admin' is still 403 on the super-admin host (host↔role mismatch)", async () => {
    const r = await httpReq('POST', '/api/admin/career/application/submit-to-practice', {
      host: SUPER_HOST, cookie: employeeCookie(), body: {}
    });
    expect(r.status).toBe(403);
  });
  it('401 without a session', async () => {
    const r = await httpReq('POST', '/api/admin/career/application/submit-to-practice', {
      host: SUPER_HOST, body: {}
    });
    expect(r.status).toBe(401);
  });
});

describe('interview attribution', () => {
  it('POST /api/ats/interview/request stamps assigned_rso_email with the session email (host_kind stays ceo)', async () => {
    const r = await httpReq('POST', '/api/ats/interview/request', {
      host: SUPER_HOST, cookie: consultantCookie(), body: { application_id: 'app-1' }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const row = db.scheduled_calls.find((c) => String(c.id) === String(r.body.interview_id));
    expect(row).toBeTruthy();
    expect(row.assigned_rso_email).toBe(ENV_CONSULTANT);
    expect(row.host_kind).toBe('ceo');
    expect(row.meeting_kind).toBe('interview');
  });
});

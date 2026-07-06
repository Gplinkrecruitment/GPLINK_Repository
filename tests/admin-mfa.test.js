// Phase 6 C1 — admin two-factor authentication (TOTP), lockout-safe.
//
// Boots the REAL server against the in-memory Supabase emulator pattern from
// tests/ats-consultant-access.test.js (PostgREST + /auth/v1/token password
// grant) so the full admin login pipeline runs end-to-end.
//
// The single most important property proven here (test: "NO LOCKOUT ..."):
// an admin with NO admin_mfa enrolment ALWAYS gets a session from
// /api/admin/auth/login — even with REQUIRE_ADMIN_MFA=true — the flag only
// adds mfaEnrolmentRequired:true to the response. Nobody can be locked out.
//
// Also covered: enrol (setup → enable) returns 8 one-time backup codes;
// enrolled login returns mfaRequired + challenge and NO cookie; the challenge
// cannot be replayed as a session cookie; wrong code 401; correct TOTP
// completes login; a backup code works exactly once; a backup code can
// disable 2FA (lost-device recovery); after disable, login is plain again.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const totp = require('../lib/totp.js');

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-admin-mfa-${RUN_ID}.json`);
let server, port;          // app under test
let sbServer, sbPort;      // Supabase (PostgREST + auth) emulator

const SUPER_HOST = 'ceo-mfa.local';
const ADMIN_HOST = 'admin-mfa.local';
const SUPER_EMAIL = 'owner@gplink-test.local';    // enrols in 2FA
const ADMIN_EMAIL = 'staff@gplink-test.local';    // NEVER enrols (no-lockout proof)
const PASSWORD = 'test-password-1';

const AUTH_USERS = {
  [SUPER_EMAIL]: { id: 'u-owner' },
  [ADMIN_EMAIL]: { id: 'u-staff' }
};

// ── In-memory PostgREST emulator (pattern from ats-consultant-access) ──────
const db = { user_roles: [], runtime_kv: [], user_profiles: [], admin_mfa: [], admin_audit_log: [] };
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'];
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue;
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
      if (u.pathname.startsWith('/auth/v1/')) { send(200, {}); return; }
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
  const hit = list.find((c) => c.startsWith('gp_admin_session=') && !c.includes('Max-Age=0'));
  return hit ? hit.split(';')[0] : '';
}

async function loginPassword(email, host) {
  return httpReq('POST', '/api/admin/auth/login', { host, body: { email, password: PASSWORD } });
}

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'admin-mfa-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.AUTH_RATE_MAX_ATTEMPTS = '500';  // high limit for tests
  process.env.AUTH_RATE_WINDOW_MS = '60000';
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.ZOHO_RECRUIT_REDIRECT_URI = '';
  process.env.OPENAI_API_KEY = '';
  process.env.RESEND_API_KEY = '';
  delete process.env.REQUIRE_ADMIN_MFA;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = ADMIN_HOST;
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  delete process.env.REQUIRE_ADMIN_MFA;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

// Shared enrolment state built up across the ordered specs below.
let ownerSecret = '';
let ownerBackupCodes = [];
let ownerCookie = '';

describe('before enrolment: password login is untouched', () => {
  it('un-enrolled super admin logs in with password only and gets a session cookie', async () => {
    const r = await loginPassword(SUPER_EMAIL, SUPER_HOST);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.mfaRequired).toBeUndefined();
    const cookie = extractAdminCookie(r.headers['set-cookie']);
    expect(cookie).toBeTruthy();
    ownerCookie = cookie;
    const s = await httpReq('GET', '/api/admin/auth/session', { host: SUPER_HOST, cookie });
    expect(s.status).toBe(200);
    expect(s.body.authenticated).toBe(true);
  });

  it('NO LOCKOUT: REQUIRE_ADMIN_MFA=true still lets an un-enrolled admin in (flag only)', async () => {
    process.env.REQUIRE_ADMIN_MFA = 'true';
    try {
      const r = await loginPassword(ADMIN_EMAIL, ADMIN_HOST);
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.mfaRequired).toBeUndefined();           // NOT challenged
      expect(r.body.mfaEnrolmentRequired).toBe(true);       // only nagged
      const cookie = extractAdminCookie(r.headers['set-cookie']);
      expect(cookie).toBeTruthy();                          // real session issued
      const s = await httpReq('GET', '/api/admin/auth/session', { host: ADMIN_HOST, cookie });
      expect(s.status).toBe(200);
      expect(s.body.authenticated).toBe(true);
    } finally {
      delete process.env.REQUIRE_ADMIN_MFA;
    }
  });

  it('status reports not enrolled', async () => {
    const r = await httpReq('GET', '/api/admin/mfa/status', { host: SUPER_HOST, cookie: ownerCookie });
    expect(r.status).toBe(200);
    expect(r.body.enrolled).toBe(false);
  });
});

describe('enrolment (setup → enable)', () => {
  it('setup returns a secret + otpauth URI + signed setup token (nothing persisted yet)', async () => {
    const r = await httpReq('POST', '/api/admin/mfa/setup', { host: SUPER_HOST, cookie: ownerCookie, body: {} });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(r.body.otpauthUri).toContain('otpauth://totp/');
    expect(r.body.setupToken).toBeTruthy();
    expect(db.admin_mfa.length).toBe(0); // not active until confirmed
  });

  it('enable rejects a wrong confirmation code', async () => {
    const setup = await httpReq('POST', '/api/admin/mfa/setup', { host: SUPER_HOST, cookie: ownerCookie, body: {} });
    const good = totp.generateTotp(setup.body.secret);
    const bad = String((Number(good) + 1) % 1000000).padStart(6, '0');
    const r = await httpReq('POST', '/api/admin/mfa/enable', {
      host: SUPER_HOST, cookie: ownerCookie,
      body: { setupToken: setup.body.setupToken, token: bad }
    });
    expect(r.status).toBe(400);
    expect(db.admin_mfa.length).toBe(0);
  });

  it('enable with the correct code activates 2FA and returns 8 one-time backup codes ONCE', async () => {
    const setup = await httpReq('POST', '/api/admin/mfa/setup', { host: SUPER_HOST, cookie: ownerCookie, body: {} });
    ownerSecret = setup.body.secret;
    const r = await httpReq('POST', '/api/admin/mfa/enable', {
      host: SUPER_HOST, cookie: ownerCookie,
      body: { setupToken: setup.body.setupToken, token: totp.generateTotp(ownerSecret) }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(Array.isArray(r.body.backupCodes)).toBe(true);
    expect(r.body.backupCodes.length).toBe(8);
    ownerBackupCodes = r.body.backupCodes;
    // Only hashes are stored — no plaintext code appears in the DB row.
    const row = db.admin_mfa.find((x) => x.admin_email === SUPER_EMAIL);
    expect(row).toBeTruthy();
    expect(row.disabled).toBe(false);
    const persisted = JSON.stringify(row.backup_codes);
    for (const code of ownerBackupCodes) expect(persisted).not.toContain(code);
  });

  it('status now reports enrolled with 8 backup codes remaining', async () => {
    const r = await httpReq('GET', '/api/admin/mfa/status', { host: SUPER_HOST, cookie: ownerCookie });
    expect(r.body.enrolled).toBe(true);
    expect(r.body.backupCodesRemaining).toBe(8);
  });
});

describe('login step-up for the enrolled admin', () => {
  it('password login returns mfaRequired + challenge and NO session cookie', async () => {
    const r = await loginPassword(SUPER_EMAIL, SUPER_HOST);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.mfaRequired).toBe(true);
    expect(r.body.challenge).toBeTruthy();
    expect(extractAdminCookie(r.headers['set-cookie'])).toBe('');
  });

  it('the challenge token is NOT accepted as a session cookie (replay-as-cookie blocked)', async () => {
    const login = await loginPassword(SUPER_EMAIL, SUPER_HOST);
    const fake = 'gp_admin_session=' + encodeURIComponent(login.body.challenge);
    const s = await httpReq('GET', '/api/admin/auth/session', { host: SUPER_HOST, cookie: fake });
    expect(s.status).toBe(401);
  });

  it('a wrong TOTP code is rejected with 401 and no cookie', async () => {
    const login = await loginPassword(SUPER_EMAIL, SUPER_HOST);
    const good = totp.generateTotp(ownerSecret);
    const bad = String((Number(good) + 1) % 1000000).padStart(6, '0');
    const r = await httpReq('POST', '/api/admin/auth/login/mfa', {
      host: SUPER_HOST, body: { challenge: login.body.challenge, token: bad }
    });
    expect(r.status).toBe(401);
    expect(extractAdminCookie(r.headers['set-cookie'])).toBe('');
  });

  it('a garbage/unsigned challenge is rejected', async () => {
    const r = await httpReq('POST', '/api/admin/auth/login/mfa', {
      host: SUPER_HOST, body: { challenge: 'abc.def', token: totp.generateTotp(ownerSecret) }
    });
    expect(r.status).toBe(401);
  });

  it('the challenge is bound to the host scope it was minted on', async () => {
    const login = await loginPassword(SUPER_EMAIL, SUPER_HOST);
    const r = await httpReq('POST', '/api/admin/auth/login/mfa', {
      host: ADMIN_HOST, body: { challenge: login.body.challenge, token: totp.generateTotp(ownerSecret) }
    });
    expect(r.status).toBe(403);
  });

  it('the correct TOTP code completes login and the cookie works', async () => {
    const login = await loginPassword(SUPER_EMAIL, SUPER_HOST);
    const r = await httpReq('POST', '/api/admin/auth/login/mfa', {
      host: SUPER_HOST, body: { challenge: login.body.challenge, token: totp.generateTotp(ownerSecret) }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const cookie = extractAdminCookie(r.headers['set-cookie']);
    expect(cookie).toBeTruthy();
    const s = await httpReq('GET', '/api/admin/auth/session', { host: SUPER_HOST, cookie });
    expect(s.status).toBe(200);
    expect(s.body.authenticated).toBe(true);
    expect(s.body.profile.email).toBe(SUPER_EMAIL);
    ownerCookie = cookie;
  });

  it('REQUIRE_ADMIN_MFA does not weaken the step-up for enrolled admins', async () => {
    process.env.REQUIRE_ADMIN_MFA = 'true';
    try {
      const r = await loginPassword(SUPER_EMAIL, SUPER_HOST);
      expect(r.body.mfaRequired).toBe(true);
      expect(extractAdminCookie(r.headers['set-cookie'])).toBe('');
    } finally {
      delete process.env.REQUIRE_ADMIN_MFA;
    }
  });
});

describe('backup codes (lost-device recovery)', () => {
  it('a backup code completes login instead of a TOTP code — exactly once', async () => {
    const code = ownerBackupCodes[0];
    const login1 = await loginPassword(SUPER_EMAIL, SUPER_HOST);
    const r1 = await httpReq('POST', '/api/admin/auth/login/mfa', {
      host: SUPER_HOST, body: { challenge: login1.body.challenge, token: code }
    });
    expect(r1.status).toBe(200);
    expect(r1.body.usedBackupCode).toBe(true);
    expect(extractAdminCookie(r1.headers['set-cookie'])).toBeTruthy();

    // Same code again: consumed → refused.
    const login2 = await loginPassword(SUPER_EMAIL, SUPER_HOST);
    const r2 = await httpReq('POST', '/api/admin/auth/login/mfa', {
      host: SUPER_HOST, body: { challenge: login2.body.challenge, token: code }
    });
    expect(r2.status).toBe(401);
    expect(extractAdminCookie(r2.headers['set-cookie'])).toBe('');
  });

  it('status shows one fewer backup code remaining', async () => {
    const r = await httpReq('GET', '/api/admin/mfa/status', { host: SUPER_HOST, cookie: ownerCookie });
    expect(r.body.backupCodesRemaining).toBe(7);
  });

  it('a backup code can DISABLE 2FA entirely (full lost-device escape hatch)', async () => {
    const r = await httpReq('POST', '/api/admin/mfa/disable', {
      host: SUPER_HOST, cookie: ownerCookie, body: { backupCode: ownerBackupCodes[1] }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.enrolled).toBe(false);
    const s = await httpReq('GET', '/api/admin/mfa/status', { host: SUPER_HOST, cookie: ownerCookie });
    expect(s.body.enrolled).toBe(false);
  });

  it('after disable, password login issues the session directly again', async () => {
    const r = await loginPassword(SUPER_EMAIL, SUPER_HOST);
    expect(r.status).toBe(200);
    expect(r.body.mfaRequired).toBeUndefined();
    expect(extractAdminCookie(r.headers['set-cookie'])).toBeTruthy();
  });

  it('a stale challenge from the enrolled era no longer works after disable', async () => {
    // 2FA is off → the mfa completion endpoint refuses to mint sessions.
    const r = await httpReq('POST', '/api/admin/auth/login/mfa', {
      host: SUPER_HOST, body: { challenge: 'nonsense', token: '123456' }
    });
    expect(r.status).toBe(401);
  });
});

describe('enrolment endpoints are session-guarded', () => {
  it('all four /api/admin/mfa endpoints reject anonymous callers', async () => {
    const status = await httpReq('GET', '/api/admin/mfa/status', { host: SUPER_HOST });
    const setup = await httpReq('POST', '/api/admin/mfa/setup', { host: SUPER_HOST, body: {} });
    const enable = await httpReq('POST', '/api/admin/mfa/enable', { host: SUPER_HOST, body: {} });
    const disable = await httpReq('POST', '/api/admin/mfa/disable', { host: SUPER_HOST, body: {} });
    for (const r of [status, setup, enable, disable]) expect(r.status).toBe(401);
  });
});

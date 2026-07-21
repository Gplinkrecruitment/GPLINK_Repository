// Phase 6 C3 (audit M5) — per-ACCOUNT admin login lockout.
//
// Boots the REAL server against the in-memory Supabase emulator pattern from
// tests/admin-mfa.test.js (PostgREST + /auth/v1/token password grant) so the
// full admin login pipeline runs end-to-end.
//
// Proves:
//  1. N bad-password attempts lock the ACCOUNT — even when every attempt comes
//     from a DIFFERENT IP (per-IP rate limiting alone can't catch that).
//  2. While locked, even the CORRECT password is rejected with 429 BEFORE the
//     credential check (the auth emulator sees no token request).
//  3. The lock is time-based: rewinding the stored lockedUntil lets the admin
//     straight back in — no permanent lockout is possible.
//  4. A successful login clears the failure counter (the runtime_kv record is
//     deleted), so the next window starts fresh.
//  5. admin_account_locked is written to admin_audit_log at lock time.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-admin-lockout-${RUN_ID}.json`);
let server, port;          // app under test
let sbServer, sbPort;      // Supabase (PostgREST + auth) emulator

const SUPER_HOST = 'ceo-lockout.local';
const ADMIN_EMAIL = 'owner@gplink-lockout.local';
const PASSWORD = 'correct-password-1';
const MAX_FAILS = 3; // ADMIN_ACCOUNT_LOCK_MAX_FAILS below

// Counts password-grant attempts the auth emulator actually receives, so we
// can prove a locked account never reaches the credential check.
let tokenRequests = 0;

// ── In-memory PostgREST emulator (pattern from admin-mfa.test.js) ──────────
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
        tokenRequests++;
        const body = (await readBody(req)) || {};
        const email = String(body.email || '').toLowerCase();
        if (email === ADMIN_EMAIL && body.password === PASSWORD) {
          send(200, { access_token: 'tok-owner', user: { id: 'u-owner', email } });
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

function httpReq(method, p, { body, host, headers: extraHeaders } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { ...(extraHeaders || {}) };
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

let ipCounter = 0;
// Every call presents a FRESH client IP so nothing here can be per-IP limited.
function loginAttempt(password) {
  ipCounter++;
  return httpReq('POST', '/api/admin/auth/login', {
    host: SUPER_HOST,
    headers: { 'X-Forwarded-For': `203.0.113.${ipCounter}` },
    body: { email: ADMIN_EMAIL, password }
  });
}

function lockRecordRow() {
  return db.runtime_kv.find((r) => String(r.key || '').startsWith('admin_login_fails_')) || null;
}

function extractAdminCookie(setCookieHeader) {
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : (setCookieHeader ? [setCookieHeader] : []);
  const hit = list.find((c) => c.startsWith('gp_admin_session=') && !c.includes('Max-Age=0'));
  return hit ? hit.split(';')[0] : '';
}

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'admin-lockout-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.AUTH_RATE_MAX_ATTEMPTS = '500'; // per-IP limiter out of the way
  process.env.AUTH_RATE_WINDOW_MS = '60000';
  process.env.ADMIN_ACCOUNT_LOCK_MAX_FAILS = String(MAX_FAILS);
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.ZOHO_RECRUIT_REDIRECT_URI = '';
  process.env.OPENAI_API_KEY = '';
  process.env.RESEND_API_KEY = '';
  delete process.env.REQUIRE_ADMIN_MFA;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = 'admin-lockout.local';
  process.env.SUPER_ADMIN_EMAILS = ADMIN_EMAIL;
  process.env.ADMIN_EMAILS = '';

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('per-account admin login lockout', () => {
  it(`locks the account after ${MAX_FAILS} bad passwords across DIFFERENT IPs`, async () => {
    for (let i = 0; i < MAX_FAILS; i++) {
      const r = await loginAttempt('wrong-password-' + i);
      expect(r.status).toBe(401); // failures themselves are plain 401s
    }
    const rec = lockRecordRow();
    expect(rec).toBeTruthy();
    expect(Number(rec.value.lockedUntil)).toBeGreaterThan(Date.now());
    // Next attempt — yet another IP — is rejected 429 up front.
    const locked = await loginAttempt('wrong-password-x');
    expect(locked.status).toBe(429);
    expect(String(locked.body.message)).toMatch(/try again in \d+ minute/i);
  });

  it('writes admin_account_locked to the audit log at lock time', () => {
    const row = db.admin_audit_log.find((r) => r.action === 'admin_account_locked');
    expect(row).toBeTruthy();
    expect(row.actor_email).toBe(ADMIN_EMAIL);
    expect(row.success).toBe(false);
  });

  it('rejects even the CORRECT password while locked — before the credential check', async () => {
    const before = tokenRequests;
    const r = await loginAttempt(PASSWORD);
    expect(r.status).toBe(429);
    expect(tokenRequests).toBe(before); // auth emulator never consulted
  });

  it('auto-unlocks once lockedUntil passes (time-based, never permanent)', async () => {
    const rec = lockRecordRow();
    rec.value = { ...rec.value, lockedUntil: Date.now() - 1000 }; // simulate the window elapsing
    const r = await loginAttempt(PASSWORD);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(extractAdminCookie(r.headers['set-cookie'])).toBeTruthy();
  });

  it('successful login resets the failure counter', async () => {
    // clearAdminLoginFailures deleted the runtime_kv record on success…
    expect(lockRecordRow()).toBeNull();
    // …so a fresh window gets the full allowance again: MAX_FAILS-1 failures
    // do NOT lock, and the correct password still works.
    for (let i = 0; i < MAX_FAILS - 1; i++) {
      const r = await loginAttempt('wrong-again-' + i);
      expect(r.status).toBe(401);
    }
    const ok = await loginAttempt(PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
  });
});

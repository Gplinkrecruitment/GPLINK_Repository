// Phase 6 F4, per-user session epoch: the "sign out of all devices" kill-switch.
//
// Proves, against the REAL server with an in-memory PostgREST emulator, the
// two properties that matter most:
//   1. DEPLOY SAFETY / BACK-COMPAT: a token with NO epoch claim (every session
//      issued before this feature shipped) stays VALID while the user has no
//      stored epoch row (and while the stored epoch is 0), so deploying the
//      feature can never mass-log-out live users.
//   2. KILL-SWITCH: POST /api/account/sign-out-all bumps the stored epoch;
//      every old token (epoch 0) is rejected afterwards, while a freshly
//      issued session (embedding the new epoch) keeps working.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-session-epoch-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const GP = { userId: 'u-epoch-1', email: 'epoch-gp@gplink-test.local', password: 'Str0ng!Passw0rd#1' };

const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Ep', last_name: 'Och', registration_country: 'uk', account_status: 'active' }
  ],
  user_session_epoch: [],
  user_state: [],
  user_roles: [],
  notification_preferences: [],
  runtime_kv: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }
// Tables listed here 404 like a pre-migration PostgREST would.
const missingTables = new Set();

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'not'];
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue;
    filters.push({ col: key, op, val: raw.slice(dot + 1) });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
    if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
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
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      // GoTrue password login, enough for /api/auth/login to issue a session.
      if (u.pathname === '/auth/v1/token') {
        const body = await readBody(req);
        if (body && String(body.email || '').toLowerCase() === GP.email && body.password === GP.password) {
          send(200, { access_token: 'x', user: { id: GP.userId, email: GP.email, email_confirmed_at: '2026-01-01T00:00:00Z', last_sign_in_at: '2026-06-01T00:00:00Z' } });
        } else {
          send(400, { error_description: 'Invalid login credentials' });
        }
        return;
      }
      if (u.pathname.startsWith('/auth/v1/')) { send(200, {}); return; }
      if (u.pathname.startsWith('/storage/v1/')) { send(200, { Key: 'ok' }); return; }
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const tableName = decodeURIComponent(m[1]);
      if (missingTables.has(tableName)) { send(404, { message: `relation "public.${tableName}" does not exist` }); return; }
      const rows = tableOf(tableName);
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
        const conflict = (u.searchParams.get('on_conflict') || '').split(',').map((s) => s.trim()).filter(Boolean);
        const saved = incoming.map((r) => {
          if (conflict.length) {
            const existing = rows.find((row) => conflict.every((c) => String(row[c]) === String(r[c])));
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
      send(200, []);
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
// A token exactly like every PRE-F4 session cookie: { userProfile, expiresAt }
// only, no epoch claim at all.
function legacyCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
function epochCookie(email, supabaseUserId, epoch) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000, epoch }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
function decodeCookiePayload(setCookieHeader) {
  const raw = decodeURIComponent(String(setCookieHeader).split('gp_session=')[1].split(';')[0]);
  const payload = raw.slice(0, raw.lastIndexOf('.'));
  const pad = payload.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
}

function httpReq(method, p, { cookie, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...(headers || {}) };
    if (cookie) h.Cookie = cookie;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'session-epoch-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 'test-resend-key';

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
});

describe('session epoch kill-switch (Phase 6 F4)', () => {
  it('DEPLOY BACK-COMPAT: a token with no epoch claim is valid when the user has NO stored epoch row', async () => {
    expect(db.user_session_epoch.length).toBe(0); // nothing stored, the state every live user is in at deploy time
    const res = await httpReq('GET', '/api/account/notification-preferences', { cookie: legacyCookie(GP.email, GP.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('DEPLOY BACK-COMPAT: a token with no epoch claim is valid when the stored epoch is explicitly 0', async () => {
    db.user_session_epoch.push({ email: GP.email, epoch: 0, updated_at: new Date().toISOString() });
    const res = await httpReq('GET', '/api/account/notification-preferences', { cookie: legacyCookie(GP.email, GP.userId) });
    expect(res.status).toBe(200);
    db.user_session_epoch.length = 0; // reset for the revoke test below
  });

  it('sign-out-all bumps the epoch, kills every old token, and a fresh login works', async () => {
    const oldCookie = legacyCookie(GP.email, GP.userId);

    // Old token works before the revoke…
    const before = await httpReq('GET', '/api/account/notification-preferences', { cookie: oldCookie });
    expect(before.status).toBe(200);

    // …then the user signs out everywhere.
    const revoke = await httpReq('POST', '/api/account/sign-out-all', { cookie: oldCookie });
    expect(revoke.status).toBe(200);
    expect(revoke.body.ok).toBe(true);
    // Cookie cleared on this device too.
    expect(String(revoke.headers['set-cookie'] || '')).toContain('Max-Age=0');
    // Stored epoch is now 1.
    expect(db.user_session_epoch.length).toBe(1);
    expect(Number(db.user_session_epoch[0].epoch)).toBe(1);

    // The old (epoch-less = epoch 0) token is now rejected.
    const after = await httpReq('GET', '/api/account/notification-preferences', { cookie: oldCookie });
    expect(after.status).toBe(401);

    // A manually-crafted token carrying the NEW epoch is accepted (what a
    // fresh issue embeds).
    const fresh = await httpReq('GET', '/api/account/notification-preferences', { cookie: epochCookie(GP.email, GP.userId, 1) });
    expect(fresh.status).toBe(200);

    // And a REAL fresh login issues a cookie embedding epoch 1 that works.
    const login = await httpReq('POST', '/api/auth/login', { body: { email: GP.email, password: GP.password } });
    expect(login.status).toBe(200);
    const setCookie = [].concat(login.headers['set-cookie'] || []).find((c) => c.startsWith('gp_session='));
    expect(setCookie).toBeTruthy();
    const claims = decodeCookiePayload(setCookie);
    expect(claims.epoch).toBe(1);
    const freshCookie = 'gp_session=' + setCookie.split('gp_session=')[1].split(';')[0];
    const withFresh = await httpReq('GET', '/api/account/notification-preferences', { cookie: freshCookie });
    expect(withFresh.status).toBe(200);

    // The pre-revoke token stays dead.
    const stillDead = await httpReq('GET', '/api/account/notification-preferences', { cookie: oldCookie });
    expect(stillDead.status).toBe(401);
  });

  it('sign-out-all also revokes OAuth refresh tokens (kill-switch covers every credential)', async () => {
    // Mint a REAL refresh token via the password grant.
    const grant = await httpReq('POST', '/api/auth/oauth/token', { body: { grant_type: 'password', email: GP.email, password: GP.password } });
    expect(grant.status).toBe(200);
    const refreshToken = grant.body.refresh_token;
    expect(refreshToken).toBeTruthy();

    // Sign out everywhere (epoch is 1 after the kill-switch test above).
    const revoke = await httpReq('POST', '/api/account/sign-out-all', { cookie: epochCookie(GP.email, GP.userId, 1) });
    expect(revoke.status).toBe(200);
    expect(revoke.body.ok).toBe(true);

    // The refresh token must be dead too, otherwise this device could mint a
    // brand-new session (carrying the bumped epoch) and defeat the kill-switch.
    const replay = await httpReq('POST', '/api/auth/oauth/token', { body: { grant_type: 'refresh_token', refresh_token: refreshToken } });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('invalid_refresh_token');
  });

  it('a token issued BEFORE deploy stays valid even if the epoch table does not exist yet (fail-open)', async () => {
    // Simulate a pre-migration database: the table 404s like PostgREST would.
    missingTables.add('user_session_epoch');
    const otherEmail = 'epoch-other@gplink-test.local';
    const res = await httpReq('GET', '/api/account/notification-preferences', { cookie: legacyCookie(otherEmail, 'u-epoch-2') });
    expect(res.status).toBe(200);
    missingTables.delete('user_session_epoch');
  });

  it('sign-out-all is auth-gated', async () => {
    const res = await httpReq('POST', '/api/account/sign-out-all', {});
    expect(res.status).toBe(401);
  });
});

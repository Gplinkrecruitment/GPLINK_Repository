// Phase 6 F4, verified self-serve email change.
//
// Proves, against the REAL server with an in-memory PostgREST + GoTrue-admin
// emulator:
//   1. Request: validates, rejects an in-use address, sends the verification
//      link to the NEW address, and changes NOTHING yet.
//   2. Confirm with a valid token: updates the auth-system email FIRST, then
//      the app-side profile row, notifies the OLD address, and revokes every
//      session issued for the old email (epoch bump).
//   3. Invalid and expired tokens are rejected; nothing changes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-change-email-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const GP1 = { userId: 'u-ce-1', email: 'change-me@gplink-test.local' };
const GP2 = { userId: 'u-ce-2', email: 'taken@gplink-test.local' };
const NEW_EMAIL = 'my-new-address@gplink-test.local';

const db = {
  user_profiles: [
    { user_id: GP1.userId, email: GP1.email, first_name: 'Change', last_name: 'Me', registration_country: 'uk' },
    { user_id: GP2.userId, email: GP2.email, first_name: 'Already', last_name: 'Taken', registration_country: 'uk' }
  ],
  onboarding_reminders: [
    { id: 'r-ce-1', user_id: GP1.userId, email: GP1.email, steps_sent: [], unsubscribed: false, stopped: true }
  ],
  notification_preferences: [],
  user_session_epoch: [],
  user_state: [],
  runtime_kv: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

// GoTrue admin emulation: users by id + a log of every admin PUT.
const authUsers = {
  [GP1.userId]: { id: GP1.userId, email: GP1.email },
  [GP2.userId]: { id: GP2.userId, email: GP2.email }
};
const authAdminPuts = [];

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
      // GoTrue admin: user lookup by email + email update by id.
      const adminUserMatch = u.pathname.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/);
      if (adminUserMatch && req.method === 'PUT') {
        const id = decodeURIComponent(adminUserMatch[1]);
        const body = await readBody(req);
        authAdminPuts.push({ id, body });
        if (!authUsers[id]) { send(404, { msg: 'User not found' }); return; }
        if (body && body.email) authUsers[id].email = String(body.email).toLowerCase();
        send(200, authUsers[id]);
        return;
      }
      if (u.pathname === '/auth/v1/admin/users' && req.method === 'GET') {
        const emailFilter = String(u.searchParams.get('email') || '').toLowerCase();
        const users = Object.values(authUsers).filter((x) => !emailFilter || x.email === emailFilter);
        send(200, { users });
        return;
      }
      if (u.pathname.startsWith('/auth/v1/')) { send(200, {}); return; }
      if (u.pathname.startsWith('/storage/v1/')) { send(200, { Key: 'ok' }); return; }
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const rows = tableOf(decodeURIComponent(m[1]));
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
          const row = { id: crypto.randomUUID(), ...r };
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
function userCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
// Purpose token crafted exactly like the server does, for the expiry test.
function craftPurposeToken(purpose, data, expMs) {
  const payload = b64url(JSON.stringify({ purpose, data, exp: Date.now() + expMs }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return payload + '.' + sig;
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
// Every accepted Resend send: { to: [...], subject, html }
const resendSends = [];
const sendsTo = (email) => resendSends.filter((s) => s.to.some((t) => String(t).toLowerCase().includes(email)));

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'change-email-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.APP_BASE_URL = 'https://app.mygplink.com.au';

  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    if (u.startsWith('https://api.resend.com/emails')) {
      let parsed = null;
      try { parsed = JSON.parse((opts && opts.body) || 'null'); } catch {}
      if (parsed) resendSends.push({ to: [].concat(parsed.to || []), subject: parsed.subject || '', html: parsed.html || '' });
      return new Response(JSON.stringify({ id: crypto.randomUUID() }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
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

describe('verified email change (Phase 6 F4)', () => {
  it('is auth-gated and validates the new address', async () => {
    const anon = await httpReq('POST', '/api/account/change-email', { body: { newEmail: NEW_EMAIL } });
    expect(anon.status).toBe(401);

    const cookie = userCookie(GP1.email, GP1.userId);
    const invalid = await httpReq('POST', '/api/account/change-email', { cookie, body: { newEmail: 'not-an-email' } });
    expect(invalid.status).toBe(400);
    const same = await httpReq('POST', '/api/account/change-email', { cookie, body: { newEmail: GP1.email } });
    expect(same.status).toBe(400);
  });

  it('rejects an address already in use on another account', async () => {
    const cookie = userCookie(GP1.email, GP1.userId);
    const res = await httpReq('POST', '/api/account/change-email', { cookie, body: { newEmail: GP2.email } });
    expect(res.status).toBe(409);
    expect(sendsTo(GP2.email).length).toBe(0);
  });

  it('request → verify → confirm: full happy path with old-address notice and session revocation', async () => {
    const oldCookie = userCookie(GP1.email, GP1.userId);

    // 1) Request: verification goes to the NEW address; nothing changes yet.
    resendSends.length = 0;
    const request = await httpReq('POST', '/api/account/change-email', { cookie: oldCookie, body: { newEmail: NEW_EMAIL } });
    expect(request.status).toBe(200);
    const verifyMails = sendsTo(NEW_EMAIL);
    expect(verifyMails.length).toBe(1);
    expect(sendsTo(GP1.email).length).toBe(0); // no mail to the old inbox yet
    expect(db.user_profiles.find((p) => p.user_id === GP1.userId).email).toBe(GP1.email); // unchanged
    expect(authUsers[GP1.userId].email).toBe(GP1.email); // auth unchanged

    // Extract the signed token from the confirmation link.
    const tokenMatch = verifyMails[0].html.match(/token=([A-Za-z0-9%._-]+)/);
    expect(tokenMatch).toBeTruthy();
    const token = decodeURIComponent(tokenMatch[1]);

    // 2) GET confirm link → scanner-proof interstitial (no change on GET).
    const interstitial = await httpReq('GET', '/api/account/change-email/confirm?token=' + encodeURIComponent(token), {});
    expect(interstitial.status).toBe(200);
    expect(interstitial.raw).toContain('Confirm email change');
    expect(authUsers[GP1.userId].email).toBe(GP1.email); // STILL unchanged after the GET

    // 3) POST confirm → everything changes atomically-in-order.
    resendSends.length = 0;
    const confirm = await httpReq('POST', '/api/account/change-email/confirm', { body: { token } });
    expect(confirm.status).toBe(200);
    expect(confirm.body.ok).toBe(true);

    // Auth system updated FIRST (and confirmed).
    expect(authAdminPuts.length).toBeGreaterThanOrEqual(1);
    expect(authAdminPuts[authAdminPuts.length - 1].body.email).toBe(NEW_EMAIL);
    expect(authUsers[GP1.userId].email).toBe(NEW_EMAIL);
    // App-side rows updated.
    expect(db.user_profiles.find((p) => p.user_id === GP1.userId).email).toBe(NEW_EMAIL);
    expect(db.onboarding_reminders.find((r) => r.user_id === GP1.userId).email).toBe(NEW_EMAIL);
    // The OLD inbox got the security notice.
    const notices = sendsTo(GP1.email);
    expect(notices.length).toBe(1);
    expect(notices[0].subject.toLowerCase()).toContain('changed');
    // Every session for the old address is revoked (epoch bumped).
    const epochRow = db.user_session_epoch.find((r) => r.email === GP1.email);
    expect(epochRow).toBeTruthy();
    expect(Number(epochRow.epoch)).toBeGreaterThanOrEqual(1);
    const withOldCookie = await httpReq('GET', '/api/account/notification-preferences', { cookie: oldCookie });
    expect(withOldCookie.status).toBe(401);
  });

  it('rejects invalid and expired tokens without changing anything', async () => {
    const before = JSON.stringify(db.user_profiles);
    const invalid = await httpReq('POST', '/api/account/change-email/confirm', { body: { token: 'garbage.token' } });
    expect(invalid.status).toBe(410);

    const expired = craftPurposeToken('email_change', { userId: GP2.userId, oldEmail: GP2.email, newEmail: 'expired-target@gplink-test.local' }, -1000);
    const expiredRes = await httpReq('POST', '/api/account/change-email/confirm', { body: { token: expired } });
    expect(expiredRes.status).toBe(410);

    // A token minted for a DIFFERENT purpose is refused too.
    const wrongPurpose = craftPurposeToken('practice_action', { userId: GP2.userId, oldEmail: GP2.email, newEmail: 'x@y.local' }, 60000);
    const wrongRes = await httpReq('POST', '/api/account/change-email/confirm', { body: { token: wrongPurpose } });
    expect(wrongRes.status).toBe(410);

    expect(JSON.stringify(db.user_profiles)).toBe(before);
  });

  it('a used A→B token cannot be replayed once the email has moved on (single-use)', async () => {
    // After the happy path above, GP1's login email is NEW_EMAIL (B).
    // The owner now moves it on again: B → C.
    const EMAIL_C = 'moved-on-again@gplink-test.local';
    const tokenBC = craftPurposeToken('email_change', { userId: GP1.userId, oldEmail: NEW_EMAIL, newEmail: EMAIL_C }, 60000);
    const applied = await httpReq('POST', '/api/account/change-email/confirm', { body: { token: tokenBC } });
    expect(applied.status).toBe(200);
    expect(authUsers[GP1.userId].email).toBe(EMAIL_C);

    // Inbox B still holds the original (already-consumed) A→B link, well
    // within its 1h TTL. Replaying it must NOT drag the login email back to B:
    // the account's current email (C) no longer matches the token's oldEmail (A).
    const tokenAB = craftPurposeToken('email_change', { userId: GP1.userId, oldEmail: GP1.email, newEmail: NEW_EMAIL }, 60000);
    const replay = await httpReq('POST', '/api/account/change-email/confirm', { body: { token: tokenAB } });
    expect(replay.status).toBe(409);
    expect(replay.body.ok).toBe(false);
    expect(String(replay.body.message || '')).toContain('already changed');
    // Nothing changed anywhere.
    expect(authUsers[GP1.userId].email).toBe(EMAIL_C);
    expect(db.user_profiles.find((p) => p.user_id === GP1.userId).email).toBe(EMAIL_C);
  });

  it('refuses to confirm when the target address got taken in the meantime', async () => {
    // GP2 requests a change to an address…
    const target = 'race-target@gplink-test.local';
    const token = craftPurposeToken('email_change', { userId: GP2.userId, oldEmail: GP2.email, newEmail: target }, 60000);
    // …but someone registers it before they confirm.
    db.user_profiles.push({ user_id: 'u-ce-3', email: target, first_name: 'Race', last_name: 'Winner' });
    authUsers['u-ce-3'] = { id: 'u-ce-3', email: target };

    const res = await httpReq('POST', '/api/account/change-email/confirm', { body: { token } });
    expect(res.status).toBe(409);
    expect(authUsers[GP2.userId].email).toBe(GP2.email); // unchanged
    expect(db.user_profiles.find((p) => p.user_id === GP2.userId).email).toBe(GP2.email);
  });
});

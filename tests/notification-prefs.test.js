// Phase 6 F4 (audit G6), per-GP notification preferences.
//
// Proves, against the REAL server with an in-memory PostgREST emulator:
//   1. GET/POST /api/account/notification-preferences are auth-gated, default
//      to everything ON, and persist toggles per user.
//   2. The onboarding-nudge cron SKIPS a GP who opted out of email nudges
//      (silently, no error spam) while still nudging an opted-in GP.
//   3. CRITICAL: a TRANSACTIONAL email (password reset, security mail) is
//      NOT gated by preferences: it still sends to a fully opted-out GP.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-notif-prefs-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const OPTED_OUT = { userId: 'u-np-1', email: 'np-optout@gplink-test.local' };
const OPTED_IN = { userId: 'u-np-2', email: 'np-optin@gplink-test.local' };
const NOW = Date.now();
const iso = (offsetHours) => new Date(NOW + offsetHours * 3600000).toISOString();

const db = {
  user_profiles: [
    { user_id: OPTED_OUT.userId, email: OPTED_OUT.email, first_name: 'Out', last_name: 'GP', account_status: 'active', onboarding_completed_at: null, created_at: iso(-72), updated_at: iso(-72) },
    { user_id: OPTED_IN.userId, email: OPTED_IN.email, first_name: 'In', last_name: 'GP', account_status: 'active', onboarding_completed_at: null, created_at: iso(-72), updated_at: iso(-72) }
  ],
  // Reminder rows already anchored 2h ago with nothing sent → step 0 (the 1h
  // nudge) is due for BOTH GPs on the next cron pass.
  onboarding_reminders: [
    { id: 'r-np-1', user_id: OPTED_OUT.userId, email: OPTED_OUT.email, name: 'Out GP', anchor_at: iso(-2), last_step: 1, steps_sent: [], unsubscribed: false, stopped: false },
    { id: 'r-np-2', user_id: OPTED_IN.userId, email: OPTED_IN.email, name: 'In GP', anchor_at: iso(-2), last_step: 1, steps_sent: [], unsubscribed: false, stopped: false }
  ],
  user_state: [
    { user_id: OPTED_OUT.userId, state: { gp_onboarding: { currentStep: 1 } }, updated_at: iso(-3) },
    { user_id: OPTED_IN.userId, state: { gp_onboarding: { currentStep: 1 } }, updated_at: iso(-3) }
  ],
  notification_preferences: [],
  user_session_epoch: [],
  gp_applications: [],
  email_suppression: [],
  user_roles: [],
  runtime_kv: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

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
    if (op === 'in') {
      return val.replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''))
        .includes(String(cell));
    }
    if (op === 'ilike') {
      const pat = val.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/%/g, '.*');
      return new RegExp('^' + pat + '$', 'i').test(String(cell));
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
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      if (u.pathname === '/auth/v1/admin/generate_link') {
        send(200, { action_link: 'https://app.mygplink.com.au/pages/signin?reset=true&token=x' });
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
function userCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
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
// Every accepted Resend send: { to: [...], subject }
const resendSends = [];

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'notif-prefs-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.CRON_SECRET = 'test-cron-secret-' + RUN_ID;
  process.env.APP_BASE_URL = 'https://app.mygplink.com.au';

  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    if (u.startsWith('https://api.resend.com/emails')) {
      let parsed = null;
      try { parsed = JSON.parse((opts && opts.body) || 'null'); } catch {}
      if (parsed) resendSends.push({ to: [].concat(parsed.to || []), subject: parsed.subject || '' });
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

const sendsTo = (email) => resendSends.filter((s) => s.to.some((t) => String(t).toLowerCase().includes(email)));

describe('notification preferences (Phase 6 F4 / G6)', () => {
  it('GET is auth-gated and defaults to everything ON', async () => {
    const anon = await httpReq('GET', '/api/account/notification-preferences', {});
    expect(anon.status).toBe(401);

    const res = await httpReq('GET', '/api/account/notification-preferences', { cookie: userCookie(OPTED_IN.email, OPTED_IN.userId) });
    expect(res.status).toBe(200);
    expect(res.body.preferences).toEqual({ emailNudges: true, whatsapp: true, push: true });
  });

  it('POST persists toggles and GET reads them back', async () => {
    const anon = await httpReq('POST', '/api/account/notification-preferences', { body: { emailNudges: false } });
    expect(anon.status).toBe(401);

    const cookie = userCookie(OPTED_OUT.email, OPTED_OUT.userId);
    const post = await httpReq('POST', '/api/account/notification-preferences', {
      cookie, body: { emailNudges: false, whatsapp: false }
    });
    expect(post.status).toBe(200);
    expect(post.body.preferences).toEqual({ emailNudges: false, whatsapp: false, push: true });

    const get = await httpReq('GET', '/api/account/notification-preferences', { cookie });
    expect(get.body.preferences).toEqual({ emailNudges: false, whatsapp: false, push: true });

    // Row landed keyed by email with snake_case columns.
    const row = db.notification_preferences.find((r) => r.email === OPTED_OUT.email);
    expect(row).toBeTruthy();
    expect(row.email_nudges).toBe(false);
    expect(row.whatsapp).toBe(false);
    expect(row.push).toBe(true);

    // Garbage body rejected.
    const bad = await httpReq('POST', '/api/account/notification-preferences', { cookie, body: { nonsense: 1 } });
    expect(bad.status).toBe(400);
  });

  it('the onboarding-nudge cron skips the opted-out GP but nudges the opted-in GP', async () => {
    resendSends.length = 0;
    const cron = await httpReq('GET', '/api/cron/onboarding-nudge', {
      headers: { Authorization: 'Bearer ' + process.env.CRON_SECRET }
    });
    expect(cron.status).toBe(200);
    expect(cron.body.ok).toBe(true);

    // Opted-in GP got the nudge…
    expect(sendsTo(OPTED_IN.email).length).toBe(1);
    // …opted-out GP got NOTHING.
    expect(sendsTo(OPTED_OUT.email).length).toBe(0);
    expect(cron.body.sent).toBe(1);
    expect(cron.body.skipped).toBeGreaterThanOrEqual(1);

    // The opted-out GP's sequence did not advance (resumes if they opt back in).
    const row = db.onboarding_reminders.find((r) => r.user_id === OPTED_OUT.userId);
    expect((row.steps_sent || []).length).toBe(0);
  });

  it('TRANSACTIONAL mail is NOT gated: a fully opted-out GP still gets a password-reset email', async () => {
    // Belt and braces: opt out of every channel first.
    const cookie = userCookie(OPTED_OUT.email, OPTED_OUT.userId);
    await httpReq('POST', '/api/account/notification-preferences', {
      cookie, body: { emailNudges: false, whatsapp: false, push: false }
    });

    resendSends.length = 0;
    const reset = await httpReq('POST', '/api/auth/request-password-reset', { body: { email: OPTED_OUT.email } });
    expect(reset.status).toBe(200);
    // The security email went out regardless of preferences.
    const got = sendsTo(OPTED_OUT.email);
    expect(got.length).toBe(1);
    expect(got[0].subject.toLowerCase()).toContain('reset');
  });
});

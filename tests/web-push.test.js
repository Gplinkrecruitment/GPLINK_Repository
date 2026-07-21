// Phase 6 J1, standards-based Web Push (VAPID) via the service worker.
//
// Proves, against the REAL server with an in-memory PostgREST emulator:
//   1. GET /api/push/vapid-public-key returns the configured key (public),
//      and a clear "not configured" answer when VAPID env is unset.
//   2. POST /api/push/subscribe is auth-gated, validates the subscription,
//      stores it for the caller (own-data), and dedups by endpoint.
//   3. POST /api/push/unsubscribe removes the caller's subscription only.
//   4. sendPushNotification (mocked web-push transport, no network):
//      sends to stored subscriptions, deletes a subscription on 410,
//      skips when the GP's `push` preference is off, no-ops without crashing
//      when VAPID keys are unset, and never throws on transport failure.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-web-push-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;
let serverModule;
let vapidKeys;

const GP1 = { userId: 'u-push-a', email: 'push-one@gplink-test.local' };
const GP2 = { userId: 'u-push-b', email: 'push-two@gplink-test.local' };

const db = {
  user_profiles: [
    { user_id: GP1.userId, email: GP1.email, first_name: 'Pushina', last_name: 'One' },
    { user_id: GP2.userId, email: GP2.email, first_name: 'Other', last_name: 'Two' }
  ],
  push_subscriptions: [],
  notification_preferences: [],
  user_state: [],
  user_session_epoch: [],
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
      if (u.pathname.startsWith('/auth/v1/')) { send(200, {}); return; }
      if (u.pathname.startsWith('/storage/v1/')) { send(200, { Key: 'ok' }); return; }
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
          if (conflictCol && r[conflictCol] !== undefined) {
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
        const kept = rows.filter((row) => !matches(row));
        db[table] = kept;
        send(200, []);
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

function httpReq(method, p, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = {};
    if (cookie) h.Cookie = cookie;
    let payload = null;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function subscriptionBody(n) {
  return {
    endpoint: `https://push.example.test/send/${n}`,
    keys: { p256dh: 'p256dh-key-' + n, auth: 'auth-key-' + n }
  };
}

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  const webPushLib = (await import('web-push')).default;
  vapidKeys = webPushLib.generateVAPIDKeys();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'web-push-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.VAPID_PUBLIC_KEY = vapidKeys.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapidKeys.privateKey;
  process.env.VAPID_SUBJECT = 'mailto:hello@mygplink.com.au';

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  serverModule = await import('../server.js');
  server = serverModule.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
});

beforeEach(() => {
  db.push_subscriptions = [];
  db.notification_preferences = [];
  serverModule.__testUtils.__setWebPushSendForTests(null);
  process.env.VAPID_PUBLIC_KEY = vapidKeys.publicKey;
  process.env.VAPID_PRIVATE_KEY = vapidKeys.privateKey;
});

describe('GET /api/push/vapid-public-key', () => {
  it('returns the configured public key (no auth required)', async () => {
    const res = await httpReq('GET', '/api/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.publicKey).toBe(vapidKeys.publicKey);
  });

  it('answers a clear "not configured" when VAPID keys are unset', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    const res = await httpReq('GET', '/api/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.configured).toBe(false);
    expect(res.body.publicKey).toBeUndefined();
  });
});

describe('POST /api/push/subscribe', () => {
  it('is auth-gated', async () => {
    const res = await httpReq('POST', '/api/push/subscribe', { body: subscriptionBody(1) });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed subscription', async () => {
    const res = await httpReq('POST', '/api/push/subscribe', {
      cookie: userCookie(GP1.email, GP1.userId),
      body: { endpoint: 'not-a-url', keys: {} }
    });
    expect(res.status).toBe(400);
  });

  it('stores the subscription for the caller (own-data)', async () => {
    const res = await httpReq('POST', '/api/push/subscribe', {
      cookie: userCookie(GP1.email, GP1.userId),
      body: subscriptionBody(1)
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(db.push_subscriptions).toHaveLength(1);
    const row = db.push_subscriptions[0];
    expect(row.user_id).toBe(GP1.userId);
    expect(row.email).toBe(GP1.email);
    expect(row.endpoint).toBe('https://push.example.test/send/1');
    expect(row.p256dh).toBe('p256dh-key-1');
    expect(row.auth).toBe('auth-key-1');
  });

  it('dedups by endpoint (re-subscribing the same browser does not duplicate)', async () => {
    const cookie = userCookie(GP1.email, GP1.userId);
    await httpReq('POST', '/api/push/subscribe', { cookie, body: subscriptionBody(1) });
    await httpReq('POST', '/api/push/subscribe', { cookie, body: subscriptionBody(1) });
    expect(db.push_subscriptions).toHaveLength(1);
    expect(db.push_subscriptions[0].endpoint).toBe('https://push.example.test/send/1');
  });
});

describe('POST /api/push/unsubscribe', () => {
  it('is auth-gated', async () => {
    const res = await httpReq('POST', '/api/push/unsubscribe', { body: { endpoint: 'https://push.example.test/send/1' } });
    expect(res.status).toBe(401);
  });

  it('removes the caller\'s subscription, but never another user\'s', async () => {
    await httpReq('POST', '/api/push/subscribe', { cookie: userCookie(GP1.email, GP1.userId), body: subscriptionBody(1) });
    await httpReq('POST', '/api/push/subscribe', { cookie: userCookie(GP2.email, GP2.userId), body: subscriptionBody(2) });
    expect(db.push_subscriptions).toHaveLength(2);

    // GP2 cannot delete GP1's subscription.
    const cross = await httpReq('POST', '/api/push/unsubscribe', {
      cookie: userCookie(GP2.email, GP2.userId),
      body: { endpoint: 'https://push.example.test/send/1' }
    });
    expect(cross.status).toBe(200);
    expect(db.push_subscriptions).toHaveLength(2);

    // GP1 deletes their own.
    const own = await httpReq('POST', '/api/push/unsubscribe', {
      cookie: userCookie(GP1.email, GP1.userId),
      body: { endpoint: 'https://push.example.test/send/1' }
    });
    expect(own.status).toBe(200);
    expect(db.push_subscriptions).toHaveLength(1);
    expect(db.push_subscriptions[0].user_id).toBe(GP2.userId);
  });
});

describe('sendPushNotification (mocked web-push transport)', () => {
  function seedSubscription(user, n) {
    db.push_subscriptions.push({
      id: crypto.randomUUID(),
      user_id: user.userId,
      email: user.email,
      endpoint: `https://push.example.test/send/${n}`,
      p256dh: 'p256dh-key-' + n,
      auth: 'auth-key-' + n,
      created_at: new Date().toISOString()
    });
  }

  it('sends the payload to every stored subscription of the user', async () => {
    seedSubscription(GP1, 1);
    seedSubscription(GP1, 2);
    seedSubscription(GP2, 9); // must NOT receive GP1's notification

    const sent = [];
    serverModule.__testUtils.__setWebPushSendForTests(async (subscription, payload, options) => {
      sent.push({ subscription, payload: JSON.parse(payload), options });
      return { statusCode: 201 };
    });

    await serverModule.__testUtils.sendPushNotification(GP1.userId, {
      title: 'Interview Scheduled',
      body: 'Your interview is booked.',
      data: { type: 'career', url: '/pages/career.html#applications' }
    });

    expect(sent).toHaveLength(2);
    const endpoints = sent.map((s) => s.subscription.endpoint).sort();
    expect(endpoints).toEqual(['https://push.example.test/send/1', 'https://push.example.test/send/2']);
    expect(sent[0].payload.title).toBe('Interview Scheduled');
    expect(sent[0].payload.body).toBe('Your interview is booked.');
    expect(sent[0].payload.url).toBe('/pages/career.html#applications');
    expect(sent[0].subscription.keys.p256dh).toMatch(/^p256dh-key-/);
    expect(sent[0].options.vapidDetails.publicKey).toBe(vapidKeys.publicKey);
  });

  it('deletes the subscription when the push service answers 410 Gone', async () => {
    seedSubscription(GP1, 1);
    seedSubscription(GP1, 2);

    serverModule.__testUtils.__setWebPushSendForTests(async (subscription) => {
      if (subscription.endpoint.endsWith('/1')) {
        const err = new Error('Gone');
        err.statusCode = 410;
        throw err;
      }
      return { statusCode: 201 };
    });

    await serverModule.__testUtils.sendPushNotification(GP1.userId, { title: 'Hi', body: 'There' });

    expect(db.push_subscriptions).toHaveLength(1);
    expect(db.push_subscriptions[0].endpoint).toBe('https://push.example.test/send/2');
  });

  it('skips sending entirely when the GP turned the push preference off', async () => {
    seedSubscription(GP1, 1);
    db.notification_preferences.push({ email: GP1.email, email_nudges: true, whatsapp: true, push: false });

    const sent = [];
    serverModule.__testUtils.__setWebPushSendForTests(async (subscription, payload) => {
      sent.push(payload);
      return { statusCode: 201 };
    });

    await serverModule.__testUtils.sendPushNotification(GP1.userId, { title: 'Nope', body: 'Should not send' });
    expect(sent).toHaveLength(0);
    expect(db.push_subscriptions).toHaveLength(1); // untouched
  });

  it('is a silent no-op (no crash) when VAPID keys are unset', async () => {
    seedSubscription(GP1, 1);
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;

    const sent = [];
    serverModule.__testUtils.__setWebPushSendForTests(async (subscription, payload) => {
      sent.push(payload);
      return { statusCode: 201 };
    });

    await expect(
      serverModule.__testUtils.sendPushNotification(GP1.userId, { title: 'Hi', body: 'There' })
    ).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it('never throws when the transport fails outright (push must not break the trigger)', async () => {
    seedSubscription(GP1, 1);
    serverModule.__testUtils.__setWebPushSendForTests(async () => {
      throw new Error('network exploded');
    });

    await expect(
      serverModule.__testUtils.sendPushNotification(GP1.userId, { title: 'Hi', body: 'There' })
    ).resolves.toBeUndefined();
    expect(db.push_subscriptions).toHaveLength(1); // non-410 failures keep the subscription
  });
});

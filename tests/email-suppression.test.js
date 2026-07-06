// Phase 6 C3 (audit M2) — email suppression + Resend bounce/complaint webhook
// + send-failure visibility.
//
// Boots the real server against the in-memory PostgREST emulator; outbound
// Resend calls are captured by wrapping global fetch (pattern from
// tests/ats-offer-flow.test.js). sendEmail itself is exercised through
// module.exports.__testUtils so the suppression gate is tested exactly where
// production mail flows through.
//
// Proves:
//  1. marketing mail to a suppressed recipient is SKIPPED (no Resend call);
//  2. transactional mail (the default) to the same recipient still sends;
//  3. a Svix-signed hard-bounce webhook suppresses the recipient;
//  4. a soft (Transient) bounce does NOT suppress;
//  5. a wrong/missing signature (secret set) is rejected 401 and suppresses no one;
//  6. with no secret set the webhook still processes (warn-and-process, like Gmail);
//  7. a Resend API failure is recorded in client_errors (route 'email-send').
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-email-suppression-${RUN_ID}.json`);
let server, port;          // app under test
let sbServer, sbPort;      // Supabase (PostgREST) emulator
let testUtils;

const SUPPRESSED = 'bounced@gplink-test.local';
const WEBHOOK_SECRET = 'whsec_' + Buffer.from('resend-signing-key-' + RUN_ID).toString('base64');

const resendCalls = [];
let resendFailNext = false; // next Resend API call answers 500

// ── In-memory PostgREST emulator ────────────────────────────────────────────
const db = {
  email_suppression: [{ email: SUPPRESSED, reason: 'hard_bounce', source: 'seed', created_at: new Date().toISOString() }],
  client_errors: [],
  runtime_kv: []
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
    if (!FILTER_OPS.includes(op)) continue;
    const val = raw.slice(dot + 1);
    filters.push({ col: key, op, val });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
    if (op === 'neq') return String(cell) !== val;
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
        res.end(JSON.stringify(payload));
      };
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

// Raw-body POST so the bytes we sign are the bytes the server verifies.
function postRaw(p, rawBody, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(rawBody, 'utf8');
    const r = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers }
    }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject); r.end(data);
  });
}

// Svix signature exactly as Resend produces it.
function svixHeaders(rawBody, { id, secret, timestamp } = {}) {
  const msgId = id || 'msg_' + crypto.randomBytes(8).toString('hex');
  const ts = timestamp != null ? timestamp : Math.floor(Date.now() / 1000);
  const key = Buffer.from(String(secret || WEBHOOK_SECRET).replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${msgId}.${ts}.${rawBody}`).digest('base64');
  return { 'svix-id': msgId, 'svix-timestamp': String(ts), 'svix-signature': 'v1,' + sig };
}

function bounceEvent(to, bounceType) {
  return JSON.stringify({
    type: 'email.bounced',
    created_at: new Date().toISOString(),
    data: {
      email_id: 'em_' + crypto.randomBytes(4).toString('hex'),
      from: 'GP Link <notifications@mygplink.com.au>',
      to: [to],
      subject: 'Test',
      bounce: bounceType ? { type: bounceType, message: 'test bounce' } : undefined
    }
  });
}

const isSuppressedInDb = (email) => db.email_suppression.some((r) => String(r.email) === email);

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'email-suppression-secret-' + RUN_ID;
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
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.resend.com/')) {
      let parsed = null; try { parsed = JSON.parse((opts && opts.body) || 'null'); } catch {}
      resendCalls.push({ url: u, body: parsed });
      if (resendFailNext) {
        resendFailNext = false;
        return Promise.resolve(new Response(JSON.stringify({ message: 'boom' }), { status: 500 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
    }
    return realFetch(url, opts);
  };

  const serverModule = await import('../server.js');
  testUtils = serverModule.__testUtils;
  server = serverModule.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  delete process.env.RESEND_WEBHOOK_SECRET;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('suppression gate in sendEmail', () => {
  it('skips MARKETING mail to a suppressed recipient (no Resend call)', async () => {
    const before = resendCalls.length;
    const r = await testUtils.sendEmail({
      to: SUPPRESSED, subject: 'Nudge', html: '<p>hi</p>', category: 'marketing'
    });
    expect(r.ok).toBe(false);
    expect(r.suppressed).toBe(true);
    expect(resendCalls.length).toBe(before);
  });

  it('still sends TRANSACTIONAL mail (the default) to the same recipient', async () => {
    const before = resendCalls.length;
    const r = await testUtils.sendEmail({ to: SUPPRESSED, subject: 'OTP', html: '<p>code</p>' });
    expect(r.ok).toBe(true);
    expect(resendCalls.length).toBe(before + 1);
    expect(resendCalls[resendCalls.length - 1].body.to).toEqual([SUPPRESSED]);
  });

  it('sends marketing mail normally to a NON-suppressed recipient', async () => {
    const before = resendCalls.length;
    const r = await testUtils.sendEmail({
      to: 'fresh@gplink-test.local', subject: 'Nudge', html: '<p>hi</p>', category: 'marketing'
    });
    expect(r.ok).toBe(true);
    expect(resendCalls.length).toBe(before + 1);
  });
});

describe('POST /api/webhooks/resend', () => {
  it('suppresses the recipient on a signed HARD bounce', async () => {
    const target = 'hard-bounce@gplink-test.local';
    const raw = bounceEvent(target, 'Permanent');
    const r = await postRaw('/api/webhooks/resend', raw, svixHeaders(raw));
    expect(r.status).toBe(200);
    expect(r.body.suppressed).toBe(1);
    expect(isSuppressedInDb(target)).toBe(true);
    const row = db.email_suppression.find((x) => x.email === target);
    expect(row.reason).toBe('hard_bounce');
    expect(row.source).toBe('resend_webhook');
  });

  it('suppresses the recipient on a signed complaint', async () => {
    const target = 'complainer@gplink-test.local';
    const raw = JSON.stringify({ type: 'email.complained', data: { to: [target] } });
    const r = await postRaw('/api/webhooks/resend', raw, svixHeaders(raw));
    expect(r.status).toBe(200);
    expect(isSuppressedInDb(target)).toBe(true);
    expect(db.email_suppression.find((x) => x.email === target).reason).toBe('complaint');
  });

  it('does NOT suppress on a soft (Transient) bounce', async () => {
    const target = 'soft-bounce@gplink-test.local';
    const raw = bounceEvent(target, 'Transient');
    const r = await postRaw('/api/webhooks/resend', raw, svixHeaders(raw));
    expect(r.status).toBe(200);
    expect(r.body.suppressed).toBe(0);
    expect(isSuppressedInDb(target)).toBe(false);
  });

  it('rejects a WRONG signature with 401 (secret set) and suppresses no one', async () => {
    const target = 'forged@gplink-test.local';
    const raw = bounceEvent(target, 'Permanent');
    const forged = svixHeaders(raw, { secret: 'whsec_' + Buffer.from('some-other-key').toString('base64') });
    const r = await postRaw('/api/webhooks/resend', raw, forged);
    expect(r.status).toBe(401);
    expect(isSuppressedInDb(target)).toBe(false);
  });

  it('rejects a MISSING signature with 401 while the secret is set', async () => {
    const target = 'unsigned@gplink-test.local';
    const r = await postRaw('/api/webhooks/resend', bounceEvent(target, 'Permanent'));
    expect(r.status).toBe(401);
    expect(isSuppressedInDb(target)).toBe(false);
  });

  it('rejects a stale timestamp (replay window) with 401', async () => {
    const target = 'replay@gplink-test.local';
    const raw = bounceEvent(target, 'Permanent');
    const stale = svixHeaders(raw, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    const r = await postRaw('/api/webhooks/resend', raw, stale);
    expect(r.status).toBe(401);
    expect(isSuppressedInDb(target)).toBe(false);
  });

  it('warn-and-process when RESEND_WEBHOOK_SECRET is unset (works before owner config)', async () => {
    const target = 'open-mode@gplink-test.local';
    const prev = process.env.RESEND_WEBHOOK_SECRET;
    process.env.RESEND_WEBHOOK_SECRET = '';
    try {
      const r = await postRaw('/api/webhooks/resend', bounceEvent(target, 'Permanent'));
      expect(r.status).toBe(200);
      expect(isSuppressedInDb(target)).toBe(true);
    } finally {
      process.env.RESEND_WEBHOOK_SECRET = prev;
    }
  });
});

describe('send-failure visibility', () => {
  it('records a Resend API failure in client_errors (route email-send)', async () => {
    resendFailNext = true;
    const r = await testUtils.sendEmail({ to: 'victim@gplink-test.local', subject: 'Fails', html: 'x' });
    expect(r.ok).toBe(false);
    const row = db.client_errors.find((e) => String(e.page_url) === 'email-send');
    expect(row).toBeTruthy();
    expect(String(row.error_message)).toMatch(/Email send failed/);
    expect(row.source).toBe('server');
  });
});

// GET /api/gp/assistance-call — the CURRENT GP's MyIntealth/AMC/AHPRA Zoom
// assistance call (scheduled_calls, meeting_kind='consultation'). Powers the
// in-app "Confirm your Zoom call" page (pages/confirm-call.html).
//
// Reuses the in-memory PostgREST emulator harness from
// tests/gp-outstanding.test.js so the REAL server answers. Two GPs are
// seeded to prove there is no cross-user leak.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-assistance-call-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const GP = { userId: 'u-ac-1', email: 'ac-gp@gplink-test.local' };
const OTHER = { userId: 'u-ac-2', email: 'ac-other@gplink-test.local' };
const NOW = new Date().toISOString();

const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Helen', last_name: 'Doctor' },
    { user_id: OTHER.userId, email: OTHER.email, first_name: 'Other', last_name: 'Doctor' }
  ],
  scheduled_calls: [
    // GP's INVITED MyIntealth consultation call (the one to confirm).
    { id: 'sc-1', user_id: GP.userId, meeting_kind: 'consultation', stage: 'myintealth',
      status: 'invited', meeting_reason: 'to sort out your MyIntealth registration',
      calendly_booking_url: 'https://calendly.com/hello-mygplink/30min?utm_content=call_abc',
      scheduled_at: null, booked_at: null, timezone: null, duration_minutes: 30,
      zoom_join_url: null, assigned_rso_name: 'Priya (GP Link)', created_at: NOW },
    // GP's BOOKED AMC consultation call — older; only returned when ?stage=amc.
    { id: 'sc-2', user_id: GP.userId, meeting_kind: 'consultation', stage: 'amc',
      status: 'booked', meeting_reason: null,
      calendly_booking_url: 'https://calendly.com/x?utm_content=call_def',
      scheduled_at: NOW, booked_at: NOW, timezone: 'Australia/Sydney', duration_minutes: 30,
      zoom_join_url: 'https://zoom.us/j/999', assigned_rso_name: null, created_at: '2000-01-01T00:00:00.000Z' },
    // An INTERVIEW (not a consultation) — must never be returned here.
    { id: 'sc-int', user_id: GP.userId, meeting_kind: 'interview', stage: null,
      status: 'invited', created_at: NOW },
    // A CANCELLED consultation — must never be returned.
    { id: 'sc-cx', user_id: GP.userId, meeting_kind: 'consultation', stage: 'ahpra',
      status: 'cancelled', created_at: NOW },
    // OTHER GP's consultation — must never leak.
    { id: 'sc-other', user_id: OTHER.userId, meeting_kind: 'consultation', stage: 'myintealth',
      status: 'invited', created_at: NOW }
  ],
  user_state: [], runtime_kv: []
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
        const saved = incoming.map((r) => {
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
      send(405, { message: 'method not allowed' });
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

function httpReq(method, p, { cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject); r.end();
  });
}

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'assistance-call-test-secret-' + RUN_ID;
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
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('GET /api/gp/assistance-call', () => {
  it('is auth-gated', async () => {
    const r = await httpReq('GET', '/api/gp/assistance-call');
    expect([401, 403]).toContain(r.status);
  });

  it('returns the most recent non-cancelled consultation call by default', async () => {
    const r = await httpReq('GET', '/api/gp/assistance-call', { cookie: userCookie(GP.email, GP.userId) });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.call).toBeTruthy();
    expect(r.body.call.id).toBe('sc-1');                 // newest created_at
    expect(r.body.call.stage).toBe('myintealth');
    expect(r.body.call.stageLabel).toBe('MyIntealth');
    expect(r.body.call.status).toBe('invited');
    expect(r.body.call.meetingReason).toContain('MyIntealth registration');
    expect(r.body.call.calendlyBookingUrl).toContain('calendly.com');
    expect(r.body.call.zoomJoinUrl).toBe(null);
    expect(r.body.call.rsoName).toBe('Priya (GP Link)');
  });

  it('honours ?stage and returns booked details incl. zoom link', async () => {
    const r = await httpReq('GET', '/api/gp/assistance-call?stage=amc', { cookie: userCookie(GP.email, GP.userId) });
    expect(r.body.call.id).toBe('sc-2');
    expect(r.body.call.stageLabel).toBe('AMC');
    expect(r.body.call.status).toBe('booked');
    expect(r.body.call.zoomJoinUrl).toBe('https://zoom.us/j/999');
    expect(r.body.call.timezone).toBe('Australia/Sydney');
  });

  it('never returns interviews, cancelled calls, or another GP\'s call', async () => {
    const r = await httpReq('GET', '/api/gp/assistance-call?stage=ahpra', { cookie: userCookie(GP.email, GP.userId) });
    // ahpra consultation is cancelled -> no ahpra match -> falls back to newest non-cancelled (sc-1)
    expect(r.body.call.id).toBe('sc-1');

    const other = await httpReq('GET', '/api/gp/assistance-call', { cookie: userCookie(OTHER.email, OTHER.userId) });
    expect(other.body.call.id).toBe('sc-other');
  });

  it('returns call:null when the GP has no consultation call', async () => {
    const r = await httpReq('GET', '/api/gp/assistance-call', { cookie: userCookie('nobody@gplink-test.local', 'u-none') });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.call).toBe(null);
  });
});

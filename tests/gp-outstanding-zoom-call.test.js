// zoom_call outstanding-item override, a `registration_tasks` row with
// task_type='zoom_call' and status='waiting_on_gp' must surface in
// GET /api/gp/outstanding with a clearer title and a deep link to the new
// in-app confirm-call page, instead of the raw task title + stage page link.
//
// Harness copied verbatim from tests/gp-outstanding.test.js (lines 13–231);
// only the db fixture + describe block differ.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-outstanding-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const GP = { userId: 'u-zc-1', email: 'zc-gp@gplink-test.local' };
const NOW = new Date().toISOString();

const db = {
  user_profiles: [{ user_id: GP.userId, email: GP.email, first_name: 'Helen', last_name: 'Doctor', registration_country: 'uk' }],
  registration_cases: [{ id: 'case-zc-1', user_id: GP.userId, status: 'active' }],
  registration_tasks: [
    // Unbooked zoom_call handed to the GP, must surface with the NEW title + deep link.
    { id: 't-zoom', case_id: 'case-zc-1', task_type: 'zoom_call', status: 'waiting_on_gp',
      title: 'Zoom Assistance Call, MyIntealth', priority: 'normal', related_stage: 'myintealth', created_at: NOW, metadata: {} },
    // A booked zoom_call becomes status='waiting', must NOT surface as outstanding.
    { id: 't-zoom-booked', case_id: 'case-zc-1', task_type: 'zoom_call', status: 'waiting',
      title: 'Zoom Assistance Call, AMC', priority: 'normal', related_stage: 'amc', created_at: NOW, metadata: {} },
    // A non-zoom waiting task, keeps its stage-page deep link (unchanged behaviour).
    { id: 't-visa', case_id: 'case-zc-1', task_type: 'stage_task', status: 'waiting_on_gp',
      title: 'Confirm your visa appointment', priority: 'normal', related_stage: 'visa', created_at: NOW, metadata: {} }
  ],
  user_documents: [], user_nudges: [], user_state: [], runtime_kv: []
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
  process.env.AUTH_SECRET = 'outstanding-test-secret-' + RUN_ID;
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

describe('GET /api/gp/outstanding, zoom_call card', () => {
  it('rewrites the zoom_call task to the confirm-call page with a clearer title', async () => {
    const r = await httpReq('GET', '/api/gp/outstanding', { cookie: userCookie(GP.email, GP.userId) });
    expect(r.status).toBe(200);
    const zoom = r.body.items.find((i) => i.id === 'task-t-zoom');
    expect(zoom).toBeTruthy();
    expect(zoom.title).toBe('Confirm your Zoom call, MyIntealth');
    expect(zoom.deepLink).toBe('/pages/confirm-call.html?stage=myintealth');
    expect(zoom.stage).toBe('myintealth');
  });

  it('does not surface a booked zoom_call (status=waiting)', async () => {
    const r = await httpReq('GET', '/api/gp/outstanding', { cookie: userCookie(GP.email, GP.userId) });
    expect(r.body.items.map((i) => i.id)).not.toContain('task-t-zoom-booked');
  });

  it('leaves non-zoom waiting tasks pointing at their stage page', async () => {
    const r = await httpReq('GET', '/api/gp/outstanding', { cookie: userCookie(GP.email, GP.userId) });
    const visa = r.body.items.find((i) => i.id === 'task-t-visa');
    expect(visa.deepLink).toBe('/pages/visa.html');
    expect(visa.title).toBe('Confirm your visa appointment');
  });
});

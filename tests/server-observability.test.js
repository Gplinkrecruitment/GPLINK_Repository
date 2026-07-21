// Phase 6 C2 — observability (audit S2/S4).
//
// Boots the real server against the in-memory PostgREST emulator pattern from
// tests/ats-offer-flow.test.js and verifies:
//  1. recordServerError writes a source='server' client_errors row and DEDUPES
//     a repeat of the same signature (occurrence_count increments, one row).
//  2. A route that throws (bad %-escape in a path segment → URIError inside
//     the handler) returns a GENERIC 500 — no err.message / stack in the body —
//     AND records a server error row.
//  3. recordCronRun writes the runtime_kv 'cron_last_run_<name>' heartbeat key,
//     both directly and end-to-end via a real /api/cron/* invocation. An
//     unauthorized cron probe (401) must NOT refresh the heartbeat.
//  4. GET /api/admin/cron-health is auth-gated, covers every vercel.json cron,
//     returns overdue=true for a never-run cron and overdue=false (status ok /
//     error) for fresh heartbeats.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-observability-${RUN_ID}.json`);
const CRON_SECRET = 'observability-cron-secret-' + RUN_ID;
const SUPER_HOST = 'ceo-observability.local';
const SUPER_EMAIL = 'super@gplink-test.local';

let server, port;     // app under test
let sbServer, sbPort; // Supabase (PostgREST) emulator
let testUtils;        // server.js __testUtils

// ── In-memory PostgREST emulator ────────────────────────────────────────────
const db = {
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

// ── Session cookie minting (pattern from sibling test files) ────────────────
function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function adminCookieFor(email, adminRole) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
const superCookie = () => adminCookieFor(SUPER_EMAIL, 'super_admin');

function httpReq(method, p, { cookie, body, host, bearer } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (host) headers.Host = host;
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
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

const ceoGet = (p) => httpReq('GET', p, { host: SUPER_HOST, cookie: superCookie() });
const ceoPut = (p, body) => httpReq('PUT', p, { host: SUPER_HOST, cookie: superCookie(), body });

async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return fn();
    await new Promise((r) => setTimeout(r, 50));
  }
}

const serverErrorRows = () => db.client_errors.filter((r) => r.source === 'server');
const kvRow = (name) => db.runtime_kv.find((r) => r.key === 'cron_last_run_' + name);
const kvValue = (name) => {
  const row = kvRow(name);
  if (!row) return null;
  return typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
};

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'observability-secret-' + RUN_ID;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = 'admin-observability.local';
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = '';

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('recordServerError (S2)', () => {
  it('writes a source=server client_errors row and dedupes a repeat of the same signature', async () => {
    await testUtils.recordServerError(new Error('unit test boom'), { route: '/unit/test-route', method: 'GET' });
    let rows = db.client_errors.filter((r) => r.error_message === 'unit test boom');
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe('server');
    expect(rows[0].page_url).toBe('/unit/test-route');
    expect(rows[0].occurrence_count).toBe(1);
    expect(rows[0].error_hash).toBeTruthy();
    expect(rows[0].error_stack).toContain('unit test boom');

    // Same message + route → same signature → increment, no second row.
    await testUtils.recordServerError(new Error('unit test boom'), { route: '/unit/test-route', method: 'GET' });
    rows = db.client_errors.filter((r) => r.error_message === 'unit test boom');
    expect(rows.length).toBe(1);
    expect(rows[0].occurrence_count).toBe(2);
  });
});

describe('generic 500 on a throwing route (S2)', () => {
  // '%E0' is an invalid %-escape: decodeURIComponent inside the handler throws
  // URIError('URI malformed'), which propagates to the /api dispatcher catch.
  const BAD_PATH = '/api/ceo/technical/client-errors/%E0';

  it('returns a generic 500 body with no raw error message or stack, and records the error', async () => {
    const before = serverErrorRows().length;
    const r = await ceoPut(BAD_PATH, { status: 'resolved' });
    expect(r.status).toBe(500);
    expect(r.body).toBeTruthy();
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toBe('server_error');
    expect(r.body.message).toBe('Something went wrong. Our team has been notified.');
    // No leak: neither the URIError message nor any stack frame in the body.
    expect(r.raw).not.toMatch(/malformed/i);
    expect(r.raw).not.toMatch(/URIError/);
    expect(r.raw).not.toMatch(/at\s+\w+.*server\.js/);

    const rows = serverErrorRows();
    expect(rows.length).toBe(before + 1);
    const captured = rows.find((x) => x.error_message === 'URI malformed');
    expect(captured).toBeTruthy();
    expect(captured.page_url).toContain('/api/ceo/technical/client-errors/');
    expect(captured.error_stack).toContain('URIError');
  });

  it('dedupes a repeat of the same request error instead of flooding', async () => {
    const first = serverErrorRows().find((x) => x.error_message === 'URI malformed');
    const countBefore = first.occurrence_count;
    const r = await ceoPut(BAD_PATH, { status: 'resolved' });
    expect(r.status).toBe(500);
    const rows = serverErrorRows().filter((x) => x.error_message === 'URI malformed');
    expect(rows.length).toBe(1);
    expect(rows[0].occurrence_count).toBe(countBefore + 1);
  });

  it('surfaces server rows through the Technical tab endpoint with a source filter', async () => {
    const r = await ceoGet('/api/ceo/technical/client-errors?status=open&source=server');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(Array.isArray(r.body.errors)).toBe(true);
    expect(r.body.errors.some((e) => e.source === 'server' && e.error_message === 'URI malformed')).toBe(true);
    expect(r.body.summary.open_server).toBeGreaterThan(0);
  });
});

describe('cron heartbeat (S4)', () => {
  it('recordCronRun writes the runtime_kv cron_last_run_<name> key', async () => {
    await testUtils.recordCronRun('weekly-sweep', 'error', 'boom from unit test', 42);
    const v = kvValue('weekly-sweep');
    expect(v).toBeTruthy();
    expect(v.status).toBe('error');
    expect(v.detail).toBe('boom from unit test');
    expect(v.ms).toBe(42);
    expect(new Date(v.at).getTime()).toBeGreaterThan(Date.now() - 60000);
  });

  it('a real cron invocation records an ok heartbeat end-to-end', async () => {
    const r = await httpReq('GET', '/api/cron/detect-no-shows', { bearer: CRON_SECRET });
    expect(r.status).toBe(200);
    // The heartbeat write happens just after the response is sent — poll briefly.
    const v = await waitFor(() => kvValue('detect-no-shows'));
    expect(v).toBeTruthy();
    expect(v.status).toBe('ok');
    expect(v.detail).toBe('http 200');
    expect(v.ms).toBeGreaterThanOrEqual(0);
  });

  it('an unauthorized cron probe (401) does NOT touch the heartbeat', async () => {
    const r = await httpReq('GET', '/api/cron/purge-accounts', {});
    expect(r.status).toBe(401);
    await new Promise((res) => setTimeout(res, 150));
    expect(kvRow('purge-accounts')).toBeUndefined();
  });
});

describe('GET /api/admin/cron-health (S4)', () => {
  it('is auth-gated', async () => {
    const r = await httpReq('GET', '/api/admin/cron-health', { host: SUPER_HOST });
    expect([401, 403]).toContain(r.status);
  });

  it('covers every vercel.json cron and computes overdue correctly', async () => {
    const vercelConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const declared = (vercelConfig.crons || []).map((c) => c.path.replace('/api/cron/', '')).sort();

    const r = await ceoGet('/api/admin/cron-health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const byName = {};
    r.body.crons.forEach((c) => { byName[c.name] = c; });
    expect(Object.keys(byName).sort()).toEqual(declared);

    // Never run → overdue.
    expect(byName['weekly-backup'].last_run_at).toBe(null);
    expect(byName['weekly-backup'].overdue).toBe(true);

    // Fresh ok run (from the E2E cron test above) → not overdue, status ok.
    expect(byName['detect-no-shows'].overdue).toBe(false);
    expect(byName['detect-no-shows'].last_status).toBe('ok');
    expect(byName['detect-no-shows'].schedule).toBe('*/10 * * * *');

    // Fresh error run (recordCronRun unit test above) → not overdue, status error.
    expect(byName['weekly-sweep'].overdue).toBe(false);
    expect(byName['weekly-sweep'].last_status).toBe('error');
    expect(byName['weekly-sweep'].last_detail).toBe('boom from unit test');
  });
});

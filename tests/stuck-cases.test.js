// Phase 6 G1 (R1) — Stuck cases / SLA view for the RSO admin dashboard.
//
// Proves, against the REAL server with an in-memory PostgREST emulator:
//   1. GET /api/admin/stuck-cases is auth-gated, and returns active cases
//      bucketed by days-in-stage (0-7 / 8-14 / 15-30 / 30+) with the GP,
//      stage, assigned Registration Support Officer name and days stalled —
//      the same ceoMetrics.caseAgeMs aging the CEO drilldown uses (withdrawn
//      and >6-months-dead cases excluded).
//   2. GET /api/cron/sla-sweep is cron-secret-gated, runs the (previously
//      orphaned) runSlaCheck — creating sla_overdue tasks for silent cases —
//      records a bucketed snapshot in runtime_kv AND the cron heartbeat
//      (cron_last_run_sla-sweep) is written by the dispatcher.
//   3. vercel.json declares both new crons (schedule-map sync guard).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-stuck-cases-${RUN_ID}.json`);
const SUPER_HOST = 'stuck-cases-test.local';
const CRON_SECRET = 'stuck-cron-secret-' + RUN_ID;
let server, port;
let sbServer, sbPort;

const NOW = Date.now();
const iso = (offsetDays) => new Date(NOW + offsetDays * 86400000).toISOString();

const db = {
  user_profiles: [
    { user_id: 'u-fresh', email: 'fresh@gplink-test.local', first_name: 'Freya', last_name: 'Fresh' },
    { user_id: 'u-mid', email: 'mid@gplink-test.local', first_name: 'Mia', last_name: 'Middle' },
    { user_id: 'u-late', email: 'late@gplink-test.local', first_name: 'Lars', last_name: 'Late' },
    { user_id: 'u-old', email: 'old@gplink-test.local', first_name: 'Olga', last_name: 'Old' },
    { user_id: 'rso-1', email: 'rae@mygplink.com.au', first_name: 'Rae', last_name: 'Officer' }
  ],
  registration_cases: [
    // 3 days silent → bucket 0-7
    { id: 'c-fresh', user_id: 'u-fresh', stage: 'myintealth', substage: '', status: 'active', assigned_va: 'rso-1', created_at: iso(-30), updated_at: iso(-3), last_gp_activity_at: iso(-3) },
    // 10 days silent → bucket 8-14
    { id: 'c-mid', user_id: 'u-mid', stage: 'amc', substage: '', status: 'active', assigned_va: 'rso-1', created_at: iso(-40), updated_at: iso(-10), last_gp_activity_at: iso(-10) },
    // 20 days silent → bucket 15-30
    { id: 'c-late', user_id: 'u-late', stage: 'ahpra', substage: '', status: 'active', assigned_va: null, created_at: iso(-60), updated_at: iso(-20), last_gp_activity_at: iso(-20) },
    // 45 days silent → bucket 30+
    { id: 'c-old', user_id: 'u-old', stage: 'visa', substage: '', status: 'active', assigned_va: 'rso-1', created_at: iso(-90), updated_at: iso(-45), last_gp_activity_at: iso(-45) },
    // withdrawn → must be excluded entirely
    { id: 'c-gone', user_id: 'u-old', stage: 'amc', status: 'withdrawn', created_at: iso(-90), updated_at: iso(-10), last_gp_activity_at: iso(-10) },
    // >6 months dead → excluded by the shared active-case filter
    { id: 'c-dead', user_id: 'u-old', stage: 'amc', status: 'active', created_at: iso(-300), updated_at: iso(-250), last_gp_activity_at: iso(-250) }
  ],
  registration_tasks: [],
  task_timeline: [],
  runtime_kv: [],
  user_roles: [],
  // RSO roster so a regular-admin session email resolves to a roster user_id.
  // Rae (rso-1) owns c-fresh / c-mid / c-old; Bob (rso-2) owns nothing.
  rso_team: [
    { user_id: 'rso-1', name: 'Rae Officer', email: 'rae@mygplink.com.au', active: true, on_leave: false },
    { user_id: 'rso-2', name: 'Bob Other', email: 'bob@mygplink.com.au', active: true, on_leave: false }
  ]
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'not'];
function matchCond(row, col, op, val) {
  const cell = row ? row[col] : undefined;
  if (op === 'eq') return String(cell) === val;
  if (op === 'neq') return String(cell) !== val;
  if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
  if (op === 'not') return val === 'is.null' ? !(cell === null || cell === undefined) : true;
  if (op === 'gt') return cell != null && String(cell) > val;
  if (op === 'gte') return cell != null && String(cell) >= val;
  if (op === 'lt') return cell != null && String(cell) < val;
  if (op === 'lte') return cell != null && String(cell) <= val;
  if (op === 'in') {
    return val.replace(/^\(/, '').replace(/\)$/, '').split(',')
      .map((s) => s.trim().replace(/^"/, '').replace(/"$/, '')).includes(String(cell));
  }
  return true;
}
// Parse a single PostgREST condition "col.op.val" (e.g. "assigned_va.eq.rso-1").
function parseCond(str) {
  const d1 = str.indexOf('.');
  if (d1 < 0) return null;
  const rest = str.slice(d1 + 1);
  const d2 = rest.indexOf('.');
  if (d2 < 0) return null;
  return { col: str.slice(0, d1), op: rest.slice(0, d2), val: rest.slice(d2 + 1) };
}
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
  // PostgREST or=(condA,condB,...): the row matches if ANY sub-condition matches.
  // Needed by fetchAssignedCaseUserIds' or=(assigned_rso.eq.X,assigned_va.eq.X).
  const orRaw = searchParams.get('or');
  const orGroup = orRaw
    ? orRaw.replace(/^\(/, '').replace(/\)$/, '').split(',').map((s) => parseCond(s.trim())).filter(Boolean)
    : null;
  return (row) => {
    if (!filters.every(({ col, op, val }) => matchCond(row, col, op, val))) return false;
    if (orGroup && orGroup.length && !orGroup.some((c) => matchCond(row, c.col, c.op, c.val))) return false;
    return true;
  };
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
      if (u.pathname.startsWith('/storage/v1/')) { send(200, { Key: 'ok' }); return; }
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const table = decodeURIComponent(m[1]);
      const rows = tableOf(table);
      const matches = buildMatcher(u.searchParams);

      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const order = u.searchParams.get('order');
        if (order) {
          const [col, dir] = order.split('.');
          out = out.slice().sort((a, b) => {
            const av = String(a[col] == null ? '' : a[col]);
            const bv = String(b[col] == null ? '' : b[col]);
            return dir === 'desc' ? (av < bv ? 1 : av > bv ? -1 : 0) : (av < bv ? -1 : av > bv ? 1 : 0);
          });
        }
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
      if (req.method === 'DELETE') {
        db[table] = rows.filter((r) => !matches(r));
        send(200, []);
        return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function adminCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
// A regular (non-super) admin session — an RSO. On the loopback host this resolves
// to 'local' admin scope (non-production), so the role↔host check admits them.
function rsoCookie(email) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole: 'admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { cookie, bearer, host } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host || SUPER_HOST };
    if (cookie) headers.Cookie = cookie;
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'stuck-cases-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.CRON_SECRET = CRON_SECRET;

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

describe('GET /api/admin/stuck-cases', () => {
  it('is auth-gated', async () => {
    const r = await httpReq('GET', '/api/admin/stuck-cases');
    expect([401, 403]).toContain(r.status);
  });

  it('returns cases bucketed by days-in-stage with the assigned officer', async () => {
    const r = await httpReq('GET', '/api/admin/stuck-cases', { cookie: adminCookie() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const buckets = {};
    for (const b of r.body.buckets) buckets[b.key] = b;
    expect(Object.keys(buckets).sort()).toEqual(['b0_7', 'b15_30', 'b31_plus', 'b8_14']);

    const findIn = (key, caseId) => (buckets[key].items || []).find((i) => i.case_id === caseId);
    const fresh = findIn('b0_7', 'c-fresh');
    expect(fresh).toBeTruthy();
    expect(fresh.gp_name).toBe('Freya Fresh');
    expect(fresh.stage).toBe('myintealth');
    expect(fresh.assigned_rso).toBe('Rae Officer');
    expect(fresh.days_stalled).toBeGreaterThanOrEqual(2);
    expect(fresh.days_stalled).toBeLessThanOrEqual(4);

    expect(findIn('b8_14', 'c-mid')).toBeTruthy();
    const late = findIn('b15_30', 'c-late');
    expect(late).toBeTruthy();
    expect(late.assigned_rso).toBe('Unassigned');
    const old = findIn('b31_plus', 'c-old');
    expect(old).toBeTruthy();
    expect(old.days_stalled).toBeGreaterThanOrEqual(44);

    // counts match items and the buckets don't leak cases into wrong bands
    for (const b of r.body.buckets) expect(b.count).toBe(b.items.length);
  });

  it('excludes withdrawn and >6-months-dead cases (same filter as the CEO board)', async () => {
    const r = await httpReq('GET', '/api/admin/stuck-cases', { cookie: adminCookie() });
    const allIds = r.body.buckets.flatMap((b) => b.items.map((i) => i.case_id));
    expect(allIds).not.toContain('c-gone');
    expect(allIds).not.toContain('c-dead');
    expect(r.body.total).toBe(4);
  });
});

// RSO data-leak lockdown: a regular RSO only ever sees stuck cases for GPs assigned
// to them; a super-admin can preview any RSO's exact view via ?pov_rso=. Proven
// against the real endpoint + in-memory PostgREST (with or= support).
describe('GET /api/admin/stuck-cases — RSO scoping', () => {
  it('a regular RSO sees ONLY their assigned GPs (not unassigned, not another RSO\'s)', async () => {
    // Rae (rso-1) owns c-fresh / c-mid / c-old; c-late is unassigned (assigned_va null).
    const r = await httpReq('GET', '/api/admin/stuck-cases', { cookie: rsoCookie('rae@mygplink.com.au'), host: '127.0.0.1' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const allIds = r.body.buckets.flatMap((b) => b.items.map((i) => i.case_id)).sort();
    expect(allIds).toEqual(['c-fresh', 'c-mid', 'c-old']);
    expect(allIds).not.toContain('c-late'); // unassigned — not theirs
    expect(r.body.total).toBe(3);
    // count/total are recomputed post-filter, not the unscoped originals
    for (const b of r.body.buckets) expect(b.count).toBe(b.items.length);
  });

  it('a regular RSO with no assigned cases sees nothing (fail-closed)', async () => {
    const r = await httpReq('GET', '/api/admin/stuck-cases', { cookie: rsoCookie('bob@mygplink.com.au'), host: '127.0.0.1' });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(0);
    expect(r.body.buckets.every((b) => b.items.length === 0)).toBe(true);
  });

  it('super-admin "View RSO POV" (?pov_rso=) previews exactly that RSO\'s scope', async () => {
    const r = await httpReq('GET', '/api/admin/stuck-cases?pov_rso=rae%40mygplink.com.au', { cookie: adminCookie() });
    expect(r.status).toBe(200);
    const allIds = r.body.buckets.flatMap((b) => b.items.map((i) => i.case_id)).sort();
    expect(allIds).toEqual(['c-fresh', 'c-mid', 'c-old']); // same as Rae sees
    expect(r.body.total).toBe(3);
  });

  it('super-admin without pov_rso still sees everything (unscoped)', async () => {
    const r = await httpReq('GET', '/api/admin/stuck-cases', { cookie: adminCookie() });
    expect(r.body.total).toBe(4); // all active cases, unchanged
  });
});

describe('GET /api/cron/sla-sweep', () => {
  it('rejects without the cron secret', async () => {
    const r = await httpReq('GET', '/api/cron/sla-sweep');
    expect(r.status).toBe(401);
  });

  it('runs the SLA check, snapshots buckets, and records the heartbeat', async () => {
    const r = await httpReq('GET', '/api/cron/sla-sweep', { bearer: CRON_SECRET });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // runSlaCheck creates sla_overdue tasks for cases silent ≥5 days
    // (c-mid, c-late, c-old, c-dead qualify; c-fresh at 3 days does not).
    expect(r.body.created).toBeGreaterThanOrEqual(3);
    const slaTasks = db.registration_tasks.filter((t) => t.task_type === 'sla_overdue');
    expect(slaTasks.length).toBe(r.body.created);
    expect(slaTasks.map((t) => t.case_id)).not.toContain('c-fresh');

    // Bucketed snapshot for the admin tab
    const snap = db.runtime_kv.find((k) => k.key === 'sla_sweep_last_results');
    expect(snap).toBeTruthy();
    expect(snap.value.total).toBe(4);

    // Dispatcher heartbeat (recordCronRun via CRON_SCHEDULES map) — written
    // just AFTER the response is sent, so poll briefly.
    let hb = null;
    for (let i = 0; i < 20 && !hb; i++) {
      hb = db.runtime_kv.find((k) => k.key === 'cron_last_run_sla-sweep');
      if (!hb) await new Promise((r) => setTimeout(r, 50));
    }
    expect(hb).toBeTruthy();
    expect(hb.value.status).toBe('ok');
  });

  it('is idempotent — a second run creates no duplicate sla_overdue tasks', async () => {
    const before = db.registration_tasks.filter((t) => t.task_type === 'sla_overdue').length;
    const r = await httpReq('GET', '/api/cron/sla-sweep', { bearer: CRON_SECRET });
    expect(r.status).toBe(200);
    const after = db.registration_tasks.filter((t) => t.task_type === 'sla_overdue').length;
    expect(after).toBe(before);
  });

  it('admin stuck-cases response surfaces the last sweep snapshot', async () => {
    const r = await httpReq('GET', '/api/admin/stuck-cases', { cookie: adminCookie() });
    expect(r.status).toBe(200);
    expect(r.body.last_sweep).toBeTruthy();
    expect(r.body.last_sweep.total).toBe(4);
  });
});

describe('cron wiring', () => {
  it('vercel.json declares both new G1 crons', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const paths = (cfg.crons || []).map((c) => c.path);
    expect(paths).toContain('/api/cron/sla-sweep');
    expect(paths).toContain('/api/cron/chase-nonresponders');
  });
});

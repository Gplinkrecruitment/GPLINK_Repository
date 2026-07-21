// Phase 6 G2b, GP list filters + per-RSO caseload data.
//
// Proves, against the REAL server with an in-memory PostgREST emulator:
//   1. GET /api/admin/cases (the payload the admin GP list renders from) now
//      carries assigned_rso_name / assigned_rso_email / days_in_stage per case
//      (days aged with the same ceoMetrics.caseAgeMs as the CEO drilldown).
//   2. GET /api/admin/va/dashboard users now carry assigned_rso (name),
//      assigned_rso_email, country, stage and days_in_stage, and the payload
//      includes an rso_workload rollup computed by the SAME
//      ceoMetrics.computeRsoWorkload the CEO "RSO Workload" card uses,
//      fed the SAME ceoMetrics.filterActiveCases input, withdrawn and
//      >6-month-stale cases (and their tasks) are excluded, so the admin
//      caseload strip matches the CEO card exactly.
//   3. Both endpoints stay auth-gated.
//   4. Static: pages/admin.html renders the new stage/RSO/country/age filter
//      selects + "My caseload" chip and filteredCases() references the fields.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-gp-list-filters-${RUN_ID}.json`);
const SUPER_HOST = 'gp-list-filters-test.local';
let server, port;
let sbServer, sbPort;

const NOW = Date.now();
const iso = (offsetDays) => new Date(NOW + offsetDays * 86400000).toISOString();

const db = {
  user_profiles: [
    { user_id: 'u-assigned', email: 'assigned@gplink-test.local', first_name: 'Alice', last_name: 'Assigned' },
    { user_id: 'u-loose', email: 'loose@gplink-test.local', first_name: 'Lena', last_name: 'Loose' },
    { user_id: 'u-withdrawn', email: 'withdrawn@gplink-test.local', first_name: 'Wanda', last_name: 'Withdrawn' },
    { user_id: 'u-stale', email: 'stale@gplink-test.local', first_name: 'Stan', last_name: 'Stale' }
  ],
  user_state: [
    { user_id: 'u-assigned', state: { gp_selected_country: 'IE' } },
    { user_id: 'u-loose', state: { gp_selected_country: 'NZ' } },
    { user_id: 'u-withdrawn', state: { gp_selected_country: 'UK' } },
    { user_id: 'u-stale', state: { gp_selected_country: 'UK' } }
  ],
  rso_team: [
    { user_id: 'rso-1', name: 'Rae Officer', email: 'rae@mygplink.com.au', phone: '', active: true, on_leave: false, calendly_event_url: '' }
  ],
  registration_cases: [
    // assigned to rso-1, stalled ~20 days in amc
    { id: 'c-assigned', user_id: 'u-assigned', stage: 'amc', substage: '', status: 'active', assigned_rso: 'rso-1', assigned_va: 'rso-1', created_at: iso(-60), updated_at: iso(-20), last_gp_activity_at: iso(-20) },
    // unassigned, fresh ~2 days in ahpra
    { id: 'c-loose', user_id: 'u-loose', stage: 'ahpra', substage: '', status: 'active', assigned_rso: null, assigned_va: null, created_at: iso(-30), updated_at: iso(-2), last_gp_activity_at: iso(-2) },
    // ALSO assigned to rso-1 but withdrawn → must NOT count in rso_workload (filterActiveCases)
    { id: 'c-withdrawn', user_id: 'u-withdrawn', stage: 'amc', substage: '', status: 'withdrawn', assigned_rso: 'rso-1', assigned_va: 'rso-1', created_at: iso(-90), updated_at: iso(-3), last_gp_activity_at: iso(-3) },
    // ALSO assigned to rso-1 but >6 months stale (182d cut) → must NOT count in rso_workload
    { id: 'c-stale', user_id: 'u-stale', stage: 'ahpra', substage: '', status: 'active', assigned_rso: 'rso-1', assigned_va: 'rso-1', created_at: iso(-400), updated_at: iso(-200), last_gp_activity_at: iso(-200) }
  ],
  registration_tasks: [
    // open + overdue task on the assigned case → shows in rso-1's workload numbers
    { id: crypto.randomUUID(), case_id: 'c-assigned', status: 'open', priority: 'normal', due_date: iso(-1).slice(0, 10), title: 'Chase AMC docs', created_at: iso(-5) },
    // open + overdue task on the STALE case → excluded from rso-1's numbers along with its case
    { id: crypto.randomUUID(), case_id: 'c-stale', status: 'open', priority: 'normal', due_date: iso(-10).slice(0, 10), title: 'Chase stale case', created_at: iso(-190) }
  ],
  support_tickets: [],
  task_timeline: [],
  user_roles: []
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
function httpReq(method, p, { cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: SUPER_HOST };
    if (cookie) headers.Cookie = cookie;
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
  process.env.AUTH_SECRET = 'gp-list-filters-test-secret-' + RUN_ID;
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

describe('GET /api/admin/cases, GP list payload', () => {
  it('is auth-gated', async () => {
    const r = await httpReq('GET', '/api/admin/cases');
    expect([401, 403]).toContain(r.status);
  });

  it('carries assigned RSO name/email + days_in_stage per case', async () => {
    const r = await httpReq('GET', '/api/admin/cases', { cookie: adminCookie() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const assigned = r.body.cases.find((c) => c.id === 'c-assigned');
    expect(assigned).toBeTruthy();
    expect(assigned.stage).toBe('amc');
    expect(assigned.assigned_rso_id).toBe('rso-1');
    expect(assigned.assigned_rso_name).toBe('Rae Officer');
    expect(assigned.assigned_rso_email).toBe('rae@mygplink.com.au');
    expect(assigned.days_in_stage).toBeGreaterThanOrEqual(19);
    expect(assigned.days_in_stage).toBeLessThanOrEqual(21);

    const loose = r.body.cases.find((c) => c.id === 'c-loose');
    expect(loose).toBeTruthy();
    expect(loose.assigned_rso_id).toBeNull();
    expect(loose.assigned_rso_name).toBe('');
    expect(loose.assigned_rso_email).toBe('');
    expect(loose.days_in_stage).toBeGreaterThanOrEqual(1);
    expect(loose.days_in_stage).toBeLessThanOrEqual(3);
  });
});

describe('GET /api/admin/va/dashboard, users + rso_workload', () => {
  it('is auth-gated', async () => {
    const r = await httpReq('GET', '/api/admin/va/dashboard');
    expect([401, 403]).toContain(r.status);
  });

  it('users carry assigned_rso, country, stage and days_in_stage', async () => {
    const r = await httpReq('GET', '/api/admin/va/dashboard', { cookie: adminCookie() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const assigned = r.body.users.find((u) => u.case_id === 'c-assigned');
    expect(assigned).toBeTruthy();
    expect(assigned.stage).toBe('amc');
    expect(assigned.country).toBe('IE');
    expect(assigned.assigned_rso_id).toBe('rso-1');
    expect(assigned.assigned_rso).toBe('Rae Officer');
    expect(assigned.assigned_rso_email).toBe('rae@mygplink.com.au');
    expect(assigned.days_in_stage).toBeGreaterThanOrEqual(19);
    expect(assigned.days_in_stage).toBeLessThanOrEqual(21);

    const loose = r.body.users.find((u) => u.case_id === 'c-loose');
    expect(loose).toBeTruthy();
    expect(loose.country).toBe('NZ');
    expect(loose.assigned_rso).toBe('Unassigned');
    expect(loose.assigned_rso_email).toBe('');
  });

  it('includes the per-RSO caseload rollup (same lib rollup as the CEO card)', async () => {
    const r = await httpReq('GET', '/api/admin/va/dashboard', { cookie: adminCookie() });
    expect(Array.isArray(r.body.rso_workload)).toBe(true);

    const rae = r.body.rso_workload.find((w) => w.rso_id === 'rso-1');
    expect(rae).toBeTruthy();
    expect(rae.rso_name).toBe('Rae Officer');
    expect(rae.rso_email).toBe('rae@mygplink.com.au');
    expect(rae.case_count).toBe(1);
    expect(rae.open_tasks).toBe(1);
    expect(rae.overdue_tasks).toBe(1);

    const unassigned = r.body.rso_workload.find((w) => w.rso_id === '__unassigned__');
    expect(unassigned).toBeTruthy();
    expect(unassigned.case_count).toBe(1);
  });

  it('rso_workload excludes withdrawn + >6-month-stale cases (same filterActiveCases input as the CEO card)', async () => {
    const r = await httpReq('GET', '/api/admin/va/dashboard', { cookie: adminCookie() });
    expect(r.status).toBe(200);

    // rso-1 owns THREE cases in the raw table (c-assigned, c-withdrawn, c-stale)
    // but only c-assigned is active: withdrawn and >182-day-stale cases are
    // filtered out before computeRsoWorkload, exactly like the CEO card.
    const rae = r.body.rso_workload.find((w) => w.rso_id === 'rso-1');
    expect(rae).toBeTruthy();
    expect(rae.case_count).toBe(1);
    // The open+overdue task on the stale case is excluded along with its case.
    expect(rae.open_tasks).toBe(1);
    expect(rae.overdue_tasks).toBe(1);

    // Total caseload across the strip counts only the two active cases.
    const totalCases = r.body.rso_workload.reduce((sum, w) => sum + w.case_count, 0);
    expect(totalCases).toBe(2);
  });
});

describe('admin.html, GP-list filters removed (assigned-only)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'pages', 'admin.html'), 'utf8');

  it('renderFilters clears the filter bar and builds no filter controls', () => {
    const start = html.indexOf('function renderFilters(){');
    expect(start).toBeGreaterThan(-1);
    const body = html.slice(start, start + 700);
    // The bar is emptied, an admin only ever sees GPs assigned to them, so the
    // All / Needs-Action / On-Track / RSO / caseload / stage filters are gone.
    expect(body).toContain('filterBar');
    expect(body).toContain('innerHTML=""');
    expect(body).not.toContain('data-filter=');
    expect(body).not.toContain('renderCaseFilterSelects');
    expect(body).not.toContain('renderRsoCaseloadStrip');
  });

  it('the list still groups cases into Needs Action / On Track lanes', () => {
    // Lane grouping is not a filter control, it stays.
    expect(html).toContain('function caseNeedsAction');
  });
});

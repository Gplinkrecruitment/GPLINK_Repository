// Full-app user-POV audit 2026-07-20 — Tasks 5/6/7 endpoint coverage.
//
// Boots the REAL server against the in-memory PostgREST emulator pattern from
// tests/conversion-funnel.test.js (extended with select= projection + PATCH so
// column-selection bugs and write paths are actually exercised).
//
// Task 5 (F1): CEO Overview placement tiles must count ats_stage writes
//   ('offer'/'interview'/'hired') and scheduled_calls-booked interviews, and
//   each tile must equal its drilldown list (both read the same predicate).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ceo-atsparity-${RUN_ID}.json`);
const SUPER_HOST = 'ceo-atsparity.local';
let server, port, sbServer, sbPort;

const DAY = 86400000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

// ── Seed ────────────────────────────────────────────────────────────────────
// u1..u4 are active fresh GPs. Placement facts:
//   appOffer  — ats_stage 'offer', legacy status untouched  → Offers tile
//   appIv     — no interview status/stage, but a BOOKED scheduled_calls
//               interview row → Interviewing tile (union with scheduled_calls)
//   appHired  — ats_stage 'hired', legacy status untouched  → Secured tile
//   appLegacy — legacy status 'offer', no ats_stage         → Offers tile
const db = {
  registration_cases: [
    { id: 'c1', user_id: 'u1', stage: 'career', status: 'active', assigned_rso: null, assigned_va: null, last_gp_activity_at: ago(1), updated_at: ago(1), created_at: ago(30) },
    { id: 'c2', user_id: 'u2', stage: 'career', status: 'active', assigned_rso: null, assigned_va: null, last_gp_activity_at: ago(2), updated_at: ago(2), created_at: ago(30) },
    { id: 'c3', user_id: 'u3', stage: 'career', status: 'active', assigned_rso: null, assigned_va: null, last_gp_activity_at: ago(3), updated_at: ago(3), created_at: ago(30) },
    { id: 'c4', user_id: 'u4', stage: 'career', status: 'active', assigned_rso: null, assigned_va: null, last_gp_activity_at: ago(4), updated_at: ago(4), created_at: ago(30) }
  ],
  user_profiles: [
    { user_id: 'u1', email: 'one@test.local', first_name: 'One', last_name: 'GP', phone: '', account_status: 'active' },
    { user_id: 'u2', email: 'two@test.local', first_name: 'Two', last_name: 'GP', phone: '', account_status: 'active' },
    { user_id: 'u3', email: 'three@test.local', first_name: 'Three', last_name: 'GP', phone: '', account_status: 'active' },
    { user_id: 'u4', email: 'four@test.local', first_name: 'Four', last_name: 'GP', phone: '', account_status: 'active' }
  ],
  gp_applications: [
    { id: 'appOffer', user_id: 'u1', career_role_id: 'r1', status: 'applied', ats_stage: 'offer', applied_at: ago(2), updated_at: ago(1), created_at: ago(2) },
    { id: 'appIv', user_id: 'u2', career_role_id: 'r1', status: 'applied', ats_stage: null, applied_at: ago(3), updated_at: ago(1), created_at: ago(3) },
    { id: 'appHired', user_id: 'u3', career_role_id: 'r1', status: 'applied', ats_stage: 'hired', applied_at: ago(4), updated_at: ago(1), created_at: ago(4) },
    { id: 'appLegacy', user_id: 'u4', career_role_id: 'r1', status: 'offer', ats_stage: null, applied_at: ago(5), updated_at: ago(1), created_at: ago(5) }
  ],
  career_interviews: [],
  scheduled_calls: [
    { id: 'sc1', user_id: 'u2', application_id: 'appIv', meeting_kind: 'interview', status: 'booked', scheduled_at: ago(-2), zoom_join_url: '', created_at: ago(3), updated_at: ago(1) }
  ],
  career_roles: [
    { id: 'r1', title: 'GP Role', practice_name: 'Test Practice', location_label: 'Testville', is_active: true }
  ],
  registration_tasks: [],
  support_tickets: [],
  task_timeline: [],
  rso_team: []
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
    if (op === 'in') {
      return val.replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''))
        .includes(String(cell));
    }
    if (op === 'gte') return String(cell) >= val;
    if (op === 'lte') return String(cell) <= val;
    if (op === 'gt') return String(cell) > val;
    if (op === 'lt') return String(cell) < val;
    return true;
  });
}

// select= projection — REAL PostgREST only returns requested columns, and the
// F4 bug (created_at missing from a select) is only reproducible with this on.
function projectRow(row, selectParam) {
  const sel = String(selectParam || '').trim();
  if (!sel || sel === '*') return row;
  const cols = sel.split(',').map((s) => s.trim()).filter(Boolean);
  if (cols.includes('*')) return row;
  const out = {};
  for (const c of cols) { if (c && !c.includes('(')) out[c] = row ? row[c] : undefined; }
  return out;
}

function startSupabaseEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (u.pathname.startsWith('/auth/v1/')) { send(200, {}); return; }
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const rows = tableOf(decodeURIComponent(m[1]));
      const matcher = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        let out = rows.filter(matcher);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out.map((r) => projectRow(r, u.searchParams.get('select'))));
        return;
      }
      if (req.method === 'PATCH') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
          const matched = rows.filter(matcher);
          matched.forEach((r) => Object.assign(r, body));
          send(200, matched);
        });
        return;
      }
      if (req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
          const list = Array.isArray(body) ? body : [body];
          list.forEach((r) => { if (r && r.id === undefined) r.id = 'row-' + crypto.randomBytes(4).toString('hex'); rows.push(r); });
          send(201, list);
        });
        return;
      }
      send(200, []);
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function gpCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
function req(method, p, { host, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(Buffer.concat(c).toString('utf8')); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject); r.end(data);
  });
}
const ceoGet = (p) => req('GET', p, { host: SUPER_HOST, cookie: superCookie() });

beforeAll(async () => {
  await startSupabaseEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'atsparity-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = '';

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

// ── Task 5 (F1): placements tiles see ATS writes; tile == drilldown ─────────
describe('CEO Overview placement tiles count ats_stage + scheduled_calls (F1)', () => {
  it('dashboard tiles: offers=2 (ats offer + legacy), interviewing=1 (booked call), secured=1 (ats hired)', async () => {
    const r = await ceoGet('/api/ceo/dashboard');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.placements.offers_made).toBe(2);   // appOffer (ats_stage) + appLegacy (status)
    expect(r.body.placements.interviewing).toBe(1);  // appIv via scheduled_calls booked row
    expect(r.body.placements.secured).toBe(1);       // appHired via ats_stage
  });

  it('offers drilldown lists exactly the two tile-counted apps', async () => {
    const r = await ceoGet('/api/ceo/drilldown/placements?status=offers_made');
    expect(r.status).toBe(200);
    const ids = (r.body.items || []).map((i) => i.application_id).sort();
    expect(ids).toEqual(['appLegacy', 'appOffer']);
  });

  it('interviewing drilldown lists the scheduled_calls-booked app', async () => {
    const r = await ceoGet('/api/ceo/drilldown/placements?status=interviewing');
    expect(r.status).toBe(200);
    const ids = (r.body.items || []).map((i) => i.application_id);
    expect(ids).toEqual(['appIv']);
  });

  it('secured drilldown lists the ats_stage=hired app', async () => {
    const r = await ceoGet('/api/ceo/drilldown/placements?status=secured');
    expect(r.status).toBe(200);
    const ids = (r.body.items || []).map((i) => i.application_id);
    expect(ids).toEqual(['appHired']);
  });

  it('applied drilldown no longer contains the ATS-progressed apps', async () => {
    const r = await ceoGet('/api/ceo/drilldown/placements?status=applied');
    expect(r.status).toBe(200);
    const ids = (r.body.items || []).map((i) => i.application_id);
    expect(ids).not.toContain('appOffer');
    expect(ids).not.toContain('appIv');
    expect(ids).not.toContain('appHired');
  });

  it('ATS funnel strip itself is unchanged (still counts ats_stage rows as before)', async () => {
    const r = await ceoGet('/api/ceo/dashboard');
    expect(r.body.ats_funnel.offer).toBe(1);   // appOffer
    expect(r.body.ats_funnel.hired).toBe(1);   // appHired
    // appIv (null stage) + appLegacy (no ats_stage) count as the insert default
    expect(r.body.ats_funnel.applied).toBe(2);
  });
});

// ── Task 6 (F3/F4/F5/F10): consistency batch ────────────────────────────────
// Extra rows are seeded in THIS describe's beforeAll (the emulator reads the
// live `db` object) so the Task 5 assertions above ran on the original seed.
describe('CEO consistency batch (F3 withdrawn, F4 created_at, F5 staleness, F10 drilldown windows)', () => {
  beforeAll(() => {
    // F3: a WITHDRAWN case whose GP finished onboarding — must not appear in
    // candidates or pipeline-summary.
    db.registration_cases.push({ id: 'c-wd', user_id: 'u-wd', stage: 'career', status: 'withdrawn', assigned_rso: null, assigned_va: null, last_gp_activity_at: ago(1), updated_at: ago(1), created_at: ago(20) });
    db.user_profiles.push({ user_id: 'u-wd', email: 'withdrawn@test.local', first_name: 'With', last_name: 'Drawn', phone: '', account_status: 'active', onboarding_completed_at: ago(10) });
    // F4: a fresh application whose applied_at is NULL — only created_at says
    // it is fresh, so the candidates select must include created_at.
    db.registration_cases.push({ id: 'c-fresh', user_id: 'u-fresh', stage: 'career', status: 'active', assigned_rso: null, assigned_va: null, last_gp_activity_at: ago(1), updated_at: ago(1), created_at: ago(15) });
    db.user_profiles.push({ user_id: 'u-fresh', email: 'fresh@test.local', first_name: 'Fresh', last_name: 'Apply', phone: '', account_status: 'active', onboarding_completed_at: ago(10) });
    db.gp_applications.push({ id: 'appFresh', user_id: 'u-fresh', career_role_id: 'r1', status: 'applied', ats_stage: 'applied', applied_at: null, created_at: ago(1), updated_at: ago(1) });
    // F5: one RSO owning a fresh case AND a >6-month-stale case. Without
    // nowMs the staleness cut is NaN-disabled and both count.
    db.rso_team.push({ user_id: 'rso1', name: 'Test RSO', email: 'rso@test.local', phone: '', active: true, on_leave: false, calendly_event_url: '' });
    db.registration_cases.push({ id: 'c-rso-fresh', user_id: 'u-rso-fresh', stage: 'amc', status: 'active', assigned_rso: 'rso1', assigned_va: null, last_gp_activity_at: ago(2), updated_at: ago(2), created_at: ago(40) });
    db.registration_cases.push({ id: 'c-rso-stale', user_id: 'u-rso-stale', stage: 'amc', status: 'active', assigned_rso: 'rso1', assigned_va: null, last_gp_activity_at: ago(200), updated_at: ago(200), created_at: ago(300) });
    db.user_profiles.push({ user_id: 'u-rso-fresh', email: 'rsofresh@test.local', first_name: 'Rso', last_name: 'Fresh', phone: '', account_status: 'active' });
    db.user_profiles.push({ user_id: 'u-rso-stale', email: 'rsostale@test.local', first_name: 'Rso', last_name: 'Stale', phone: '', account_status: 'active' });
    // F10: the stale case's GP also has a secured app so the placed drilldown
    // at period=all must list them (the tile already counts them at 'all').
    db.gp_applications.push({ id: 'appStaleSecured', user_id: 'u-rso-stale', career_role_id: 'r1', status: 'placement_secured', applied_at: ago(200), created_at: ago(200), updated_at: ago(150) });
  });

  it('F3: /api/ceo/candidates excludes withdrawn cases', async () => {
    const r = await ceoGet('/api/ceo/candidates');
    expect(r.status).toBe(200);
    const users = (r.body.candidates || []).map((c) => c.user_id);
    expect(users).not.toContain('u-wd');
    expect(users).toContain('u-fresh'); // active case still listed
  });

  it('F3: /api/ceo/pipeline-summary excludes withdrawn cases from the total', async () => {
    const r = await ceoGet('/api/ceo/pipeline-summary');
    expect(r.status).toBe(200);
    // 7 non-withdrawn cases: c1..c4, c-fresh, c-rso-fresh, c-rso-stale (c-wd out)
    expect(r.body.total).toBe(7);
  });

  it('F4: fresh_applied surfaces an app whose freshness lives only in created_at', async () => {
    const r = await ceoGet('/api/ceo/candidates?fresh_applied=1');
    expect(r.status).toBe(200);
    const users = (r.body.candidates || []).map((c) => c.user_id);
    expect(users).toContain('u-fresh');
  });

  it('F5: /api/ceo/rsos applies the 6-month staleness cut (stale case not counted)', async () => {
    const r = await ceoGet('/api/ceo/rsos');
    expect(r.status).toBe(200);
    const row = (r.body.rsos || []).find((x) => x.rso_id === 'rso1');
    expect(row).toBeTruthy();
    expect(row.case_count).toBe(1); // c-rso-fresh only; c-rso-stale is >6mo stale
  });

  it('F5: /api/ceo/rso/:id/summary applies the same staleness cut', async () => {
    const r = await ceoGet('/api/ceo/rso/rso1/summary');
    expect(r.status).toBe(200);
    const ids = (r.body.gps || []).map((g) => g.case_id);
    expect(ids).toContain('c-rso-fresh');
    expect(ids).not.toContain('c-rso-stale');
    expect(r.body.task_counts.case_count).toBe(1);
  });

  it('F10: activity drilldown honors period=all (stale case listed, like the tile)', async () => {
    const all = await ceoGet('/api/ceo/drilldown/activity?bucket=cold&period=all');
    expect(all.status).toBe(200);
    expect((all.body.items || []).map((i) => i.case_id)).toContain('c-rso-stale');
    // default (current) period still applies the staleness cut
    const cur = await ceoGet('/api/ceo/drilldown/activity?bucket=cold');
    expect((cur.body.items || []).map((i) => i.case_id)).not.toContain('c-rso-stale');
  });

  it('F10: placed drilldown honors period=all (stale secured GP listed, like the tile)', async () => {
    const all = await ceoGet('/api/ceo/drilldown/placed?period=all');
    expect(all.status).toBe(200);
    expect((all.body.items || []).map((i) => i.user_id)).toContain('u-rso-stale');
    const cur = await ceoGet('/api/ceo/drilldown/placed');
    expect((cur.body.items || []).map((i) => i.user_id)).not.toContain('u-rso-stale');
  });
});

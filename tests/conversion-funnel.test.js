// Phase 6 H2 — cross-system conversion funnel + time-to-placement.
//
// 1. Unit tests of lib/ceo-metrics.js computeConversionFunnel /
//    computeTimeToPlacement: cross-system step counts, step-to-step
//    conversion %, period scoping, median/avg time-to-placement.
// 2. Endpoint tests of GET /api/ceo/conversion-funnel against the REAL server
//    with an in-memory PostgREST emulator (same harness as
//    tests/account-export.test.js): auth-gated, returns the seeded funnel.
// 3. Bounded: every Supabase fetch in the handler carries an explicit limit.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as M from '../lib/ceo-metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-convfunnel-${RUN_ID}.json`);
const SUPER_HOST = 'convfunnel-test.local';

// Anchor to the real clock: the endpoint tests hit the live server, which
// windows periods (7d/30d/90d) off Date.now(). A fixed anchor here becomes a
// time bomb — the "3d-old" seed aged past the 7d window once the calendar
// passed anchor+4d and the suite went red with no code change. Every seed and
// assertion below is relative to NOW, so a live anchor stays deterministic.
const NOW = Date.now();
const DAY = 86400000;
const ago = (days) => new Date(NOW - days * DAY).toISOString();

// ── Unit: computeConversionFunnel + computeTimeToPlacement ──────────────────

function funnelFixture() {
  return {
    enquiries: [
      { id: 'e1', kind: 'practice', created_at: ago(3) },
      { id: 'e2', kind: 'practice', created_at: ago(60) },
      { id: 'e3', kind: 'gp', created_at: ago(2) } // GP enquiry — NOT a practice lead
    ],
    practices: [
      // FB-lead practice: counts as a lead (FB leads never hit site_enquiries)
      { id: 'p1', source: 'facebook_lead', agreement_status: 'unsigned', created_at: ago(10) },
      // signed practice
      { id: 'p2', source: 'manual', agreement_status: 'signed', agreement_signed_at: ago(20), created_at: ago(30) }
    ],
    roles: [
      { id: 1, is_active: true, approval_status: 'approved', created_at: ago(15) },
      { id: 2, is_active: true, approval_status: 'approved', published_at: ago(9), created_at: ago(25) },
      { id: 3, is_active: true, approval_status: 'pending', created_at: ago(5) }, // not live
      { id: 4, is_active: false, approval_status: 'approved', created_at: ago(5) } // not live
    ],
    apps: [
      { id: 'a1', user_id: 'u1', status: 'applied', applied_at: ago(90), updated_at: ago(90) },
      { id: 'a2', user_id: 'u1', status: 'applied', applied_at: ago(45), updated_at: ago(45) }, // same GP → dedup
      { id: 'a3', user_id: 'u2', status: 'placement_secured', applied_at: ago(40), updated_at: ago(20) }
    ],
    interviews: [
      { id: 'iv1', status: 'scheduled', created_at: ago(30) },
      { id: 'iv2', status: 'cancelled', created_at: ago(29) } // excluded
    ],
    cases: [
      { id: 'c1', user_id: 'u1', created_at: ago(100) },
      { id: 'c2', user_id: 'u2', created_at: ago(50) },
      { id: 'c3', user_id: 'u3', created_at: ago(40) } // never placed
    ],
    placements: [
      { id: 'pl1', user_id: 'u1', status: 'active', placed_at: ago(40) }
    ],
    profiles: [
      { user_id: 'u1', onboarding_completed_at: ago(99) },
      { user_id: 'u2', onboarding_completed_at: ago(49) },
      { user_id: 'u3', onboarding_completed_at: null } // never finished onboarding
    ]
  };
}

const stepMap = (steps) => Object.fromEntries(steps.map((s) => [s.key, s]));

describe('computeConversionFunnel (lib)', () => {
  it('computes the cross-system practice-side steps for all-time', () => {
    const f = M.computeConversionFunnel(funnelFixture(), 'all', NOW);
    const p = stepMap(f.practice_funnel);
    expect(p.practice_leads.count).toBe(3);      // 2 practice enquiries + 1 FB-lead practice
    expect(p.practices_signed.count).toBe(1);
    expect(p.jobs_live.count).toBe(2);           // active + approved only
    expect(p.gp_applicants.count).toBe(2);       // u1 deduped
    expect(p.interviews.count).toBe(1);          // cancelled excluded
    expect(p.placements.count).toBe(2);          // u1 placements row + u2 secured app
  });

  it('computes step-to-step conversion % (null on first step and after a 0 step)', () => {
    const f = M.computeConversionFunnel(funnelFixture(), 'all', NOW);
    const steps = f.practice_funnel;
    expect(steps[0].conversion_pct).toBeNull();
    expect(steps[1].conversion_pct).toBe(33.3);  // 1/3 signed
    expect(steps[2].conversion_pct).toBe(200);   // 2 jobs from 1 practice — honest, can exceed 100
    // A zero previous step yields null (a % of nothing is meaningless)
    const empty = M.computeConversionFunnel({ apps: funnelFixture().apps }, 'all', NOW);
    const pe = empty.practice_funnel;
    expect(pe[0].count).toBe(0);
    expect(pe[1].conversion_pct).toBeNull();
  });

  it('computes the GP-side cohort funnel: signups → onboarded → placed', () => {
    const f = M.computeConversionFunnel(funnelFixture(), 'all', NOW);
    const g = stepMap(f.gp_funnel);
    expect(g.gp_signups.count).toBe(3);
    expect(g.onboarding_complete.count).toBe(2);   // u3 never finished
    expect(g.placement_secured.count).toBe(2);     // u1 + u2
    expect(stepMap(f.gp_funnel).onboarding_complete.conversion_pct).toBe(66.7);
  });

  it('scopes flow counts to the period (7d) while durations stay all-time', () => {
    const f = M.computeConversionFunnel(funnelFixture(), '7d', NOW);
    const p = stepMap(f.practice_funnel);
    expect(p.practice_leads.count).toBe(1);  // only e1 (3d ago); FB practice is 10d old
    expect(p.practices_signed.count).toBe(0);
    expect(p.gp_applicants.count).toBe(0);
    expect(p.placements.count).toBe(0);
    // time-to-placement is a duration metric — period-independent
    expect(f.time_to_placement.from_signup.sample_size).toBe(2);
  });
});

describe('computeTimeToPlacement (lib)', () => {
  it('computes median/avg days from signup and from application', () => {
    const { cases, apps, placements } = funnelFixture();
    const ttp = M.computeTimeToPlacement(cases, apps, placements);
    // u1: signup 100d ago, placed (placements row) 40d ago → 60d
    // u2: signup 50d ago, secured-app fallback updated 20d ago → 30d
    expect(ttp.from_signup.sample_size).toBe(2);
    expect(ttp.from_signup.median_days).toBe(45);
    expect(ttp.from_signup.avg_days).toBe(45);
    // u1: first applied 90d ago → 50d; u2: applied 40d ago → 20d
    expect(ttp.from_application.sample_size).toBe(2);
    expect(ttp.from_application.median_days).toBe(35);
    expect(ttp.from_application.avg_days).toBe(35);
  });

  it('prefers the placements row over the secured-app fallback and skips cancelled', () => {
    const ttp = M.computeTimeToPlacement(
      [{ id: 'c', user_id: 'u9', created_at: ago(30) }],
      [{ id: 'a', user_id: 'u9', status: 'placement_secured', applied_at: ago(25), updated_at: ago(1) }],
      [
        { id: 'pl-x', user_id: 'u9', status: 'cancelled', placed_at: ago(28) },
        { id: 'pl-y', user_id: 'u9', status: 'active', placed_at: ago(10) }
      ]
    );
    expect(ttp.from_signup.median_days).toBe(20); // 30d→10d via the ACTIVE placements row, not updated_at (1d)
  });

  it('returns null stats with no placed GPs', () => {
    const ttp = M.computeTimeToPlacement([{ id: 'c', user_id: 'u1', created_at: ago(5) }], [], []);
    expect(ttp.from_signup).toEqual({ median_days: null, avg_days: null, sample_size: 0 });
  });
});

// ── Endpoint: GET /api/ceo/conversion-funnel (real server + PostgREST emulator) ──

let server, port, sbServer, sbPort;

const db = {
  site_enquiries: [
    { id: 'e1', kind: 'practice', created_at: ago(3) },
    { id: 'e2', kind: 'gp', created_at: ago(2) }
  ],
  practices: [
    { id: 'p1', source: 'facebook_lead', agreement_status: 'unsigned', created_at: ago(10) },
    { id: 'p2', source: 'manual', agreement_status: 'signed', agreement_signed_at: ago(20), created_at: ago(30) }
  ],
  career_roles: [
    { id: 1, is_active: true, approval_status: 'approved', created_at: ago(15) },
    { id: 2, is_active: false, approval_status: 'approved', created_at: ago(15) }
  ],
  gp_applications: [
    { id: 'a1', user_id: 'u1', status: 'applied', applied_at: ago(90), updated_at: ago(90) },
    { id: 'a2', user_id: 'u2', status: 'placement_secured', applied_at: ago(40), updated_at: ago(20) }
  ],
  career_interviews: [
    { id: 'iv1', status: 'scheduled', created_at: ago(30) }
  ],
  registration_cases: [
    { id: 'c1', user_id: 'u1', created_at: ago(100) },
    { id: 'c2', user_id: 'u2', created_at: ago(50) }
  ],
  placements: [
    { id: 'pl1', user_id: 'u1', status: 'active', placed_at: ago(40) }
  ],
  user_profiles: [
    { user_id: 'u1', onboarding_completed_at: ago(99) },
    { user_id: 'u2', onboarding_completed_at: ago(49) }
  ]
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
    return true;
  });
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
      if (req.method === 'GET') {
        let out = rows.filter(buildMatcher(u.searchParams));
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out);
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
function req(method, p, { host, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        let body = null; try { body = JSON.parse(Buffer.concat(c).toString('utf8')); } catch {}
        resolve({ status: res.statusCode, body });
      });
    });
    r.on('error', reject); r.end();
  });
}

beforeAll(async () => {
  await startSupabaseEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'convfunnel-test-secret-' + RUN_ID;
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

describe('GET /api/ceo/conversion-funnel', () => {
  it('is auth-gated (no session)', async () => {
    const r = await req('GET', '/api/ceo/conversion-funnel', { host: SUPER_HOST });
    expect([401, 403, 302]).toContain(r.status);
  });

  it('returns the cross-system steps with counts + conversion % and time-to-placement', async () => {
    const r = await req('GET', '/api/ceo/conversion-funnel?period=all', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.period).toBe('all');

    const p = stepMap(r.body.practice_funnel);
    expect(p.practice_leads.count).toBe(2);     // 1 practice enquiry + 1 FB-lead practice
    expect(p.practices_signed.count).toBe(1);
    expect(p.jobs_live.count).toBe(1);          // is_active=eq.true fetch filter
    expect(p.gp_applicants.count).toBe(2);
    expect(p.interviews.count).toBe(1);
    expect(p.placements.count).toBe(2);         // u1 placements row + u2 secured app
    expect(p.practices_signed.conversion_pct).toBe(50);

    const g = stepMap(r.body.gp_funnel);
    expect(g.gp_signups.count).toBe(2);
    expect(g.onboarding_complete.count).toBe(2);
    expect(g.placement_secured.count).toBe(2);

    // Seeded: u1 signup 100d→placed 40d (60d); u2 signup 50d→secured 20d (30d)
    expect(r.body.time_to_placement.from_signup.sample_size).toBe(2);
    expect(r.body.time_to_placement.from_signup.median_days).toBe(45);
  });

  it('coerces an invalid period to all and honours a valid one', async () => {
    const bad = await req('GET', '/api/ceo/conversion-funnel?period=bogus', { host: SUPER_HOST, cookie: superCookie() });
    expect(bad.body.period).toBe('all');
    const sevenD = await req('GET', '/api/ceo/conversion-funnel?period=7d', { host: SUPER_HOST, cookie: superCookie() });
    expect(sevenD.body.period).toBe('7d');
    const p = stepMap(sevenD.body.practice_funnel);
    expect(p.practice_leads.count).toBe(1);   // only the 3d-old enquiry
    expect(p.placements.count).toBe(0);
  });

  it('every Supabase fetch in the handler is bounded (carries limit=)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const start = src.indexOf("pathname === '/api/ceo/conversion-funnel'");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("pathname === '/api/ceo/source-attribution'", start));
    const fetches = block.match(/supabaseDbRequest\([^)]+\)/g) || [];
    expect(fetches.length).toBeGreaterThanOrEqual(8);
    for (const f of fetches) expect(f, `unbounded fetch: ${f}`).toContain('limit=');
  });

  it('never reports revenue — counts and durations only (Xero owns money)', async () => {
    const r = await req('GET', '/api/ceo/conversion-funnel', { host: SUPER_HOST, cookie: superCookie() });
    const raw = JSON.stringify(r.body).toLowerCase();
    for (const word of ['revenue', 'income', '"aud"', 'invoice']) {
      expect(raw).not.toContain(word);
    }
  });
});

describe('CEO dashboard conversion-funnel card (static)', () => {
  let html;
  beforeAll(() => { html = fs.readFileSync(path.join(ROOT, 'pages', 'ceo-dashboard.html'), 'utf8'); });

  it('renders a Conversion Funnel card wired into the dashboard grid', () => {
    expect(html).toContain('function renderConversionFunnelSection');
    expect(html).toContain('renderConversionFunnelSection()');
    expect(html).toMatch(/sectionCard\('conversion'/);
    expect(html).toContain('loadConversionFunnel');
    expect(html).toContain('/api/ceo/conversion-funnel?period=');
  });

  it('shows time-to-placement and reuses the dashboard period control', () => {
    expect(html).toContain('time_to_placement');
    // The loader passes the SAME currentPeriod the top time-filter bar sets.
    expect(html).toMatch(/loadConversionFunnel[\s\S]{0,200}currentPeriod/);
  });

  it('funnel is hand-rolled HTML/SVG — no external chart libs', () => {
    const forbidden = ['chart.js', 'chartjs', 'highcharts', 'd3.min', 'plotly', 'echarts'];
    for (const lib of forbidden) expect(html.toLowerCase()).not.toContain(lib);
  });
});

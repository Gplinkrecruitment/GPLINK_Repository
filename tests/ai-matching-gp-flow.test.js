// Task 4 (AI Matching, 2026-07-06 plan) — GP-facing match surfaces:
// buildMatchEmailHtml/sendMatchEmail, GET /api/career/matches,
// POST /api/career/match/seen, POST /api/career/match/respond,
// POST /api/career/match/dismiss-filled, GET /api/career/interview-usage.
//
// Boots the real server against a tiny in-memory PostgREST emulator (pattern
// from tests/career-internal-apply.test.js), so the FULL Supabase-mode code
// paths run — including the RSO roster fallback (rso_team empty → RSO_TEAM
// seed) and the shared post-apply side-effect helpers. Resend calls are
// captured by wrapping global.fetch (pattern from tests/ats-endpoints.test.js).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Client wiring (source regex, no browser needed) ─────────────────────────
describe('AI Matching Task 4 — client wiring (source regex)', () => {
  const appShellHtml = fs.readFileSync(path.join(ROOT, 'pages/app-shell.html'), 'utf8');
  const careerHtml = fs.readFileSync(path.join(ROOT, 'pages/career.html'), 'utf8');
  const popupSrc = fs.readFileSync(path.join(ROOT, 'js/match-popup.js'), 'utf8');

  it('pages/app-shell.html loads match-popup.js AFTER app-shell.js, with a cache buster', () => {
    const shellIdx = appShellHtml.indexOf('/js/app-shell.js?v=');
    const popupMatch = appShellHtml.match(/<script src="\/js\/match-popup\.js\?v=20260729[a-z]" defer><\/script>/);
    expect(shellIdx).toBeGreaterThan(-1);
    expect(popupMatch).toBeTruthy();
    expect(appShellHtml.indexOf(popupMatch[0])).toBeGreaterThan(shellIdx);
  });

  it('js/match-popup.js fetches matches, marks seen, and posts respond/accept', () => {
    expect(popupSrc).toContain('/api/career/matches');
    expect(popupSrc).toContain('/api/career/match/seen');
    expect(popupSrc).toContain('/api/career/match/respond');
    expect(popupSrc).toMatch(/respond\(match\.applicationId,\s*"accept"\)/);
    // Never stacks a second popup.
    expect(popupSrc).toContain('document.getElementById("gpMatchPopup")');
    // Respects prefers-reduced-motion for the confetti loop.
    expect(popupSrc).toContain('prefers-reduced-motion');
  });

  it('pages/career.html has the pinned matches section + position-filled host', () => {
    expect(careerHtml).toContain('id="teamMatchesSection"');
    expect(careerHtml).toContain('id="positionFilledSection"');
    expect(careerHtml).toMatch(/renderTeamMatches\(\)/);
  });

  it('pages/career.html wires view/decline/dismiss + the confirm-sheet cap copy verbatim', () => {
    // The card CTA opens the practice page instead of accepting in place
    // (owner call 2026-07-28) — accepting is a one-way commitment and was
    // being tapped by accident from the list.
    expect(careerHtml).toContain('data-match-view');
    expect(careerHtml).toContain('View Matched Practice');
    expect(careerHtml).not.toContain('data-match-accept=');
    expect(careerHtml).toContain('data-match-decline');
    expect(careerHtml).toContain('data-filled-dismiss');
    expect(careerHtml).toContain("You can interview for up to 3 positions per month — so accept the roles you're genuinely serious about.");
    expect(careerHtml).toContain("Once they confirm their availability, you'll choose an interview time.");
  });

  it('pages/career.html handles the ?match= deep link via handleMatchDeepLink()', () => {
    expect(careerHtml).toContain('function handleMatchDeepLink()');
    expect(careerHtml).toContain('handleMatchDeepLink();');
  });
});

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ai-matching-gp-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;
const resendCalls = [];
let realFetch;

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ── Fixture users ────────────────────────────────────────────────────────────
const ACCEPT_GP = { userId: 'gp-accept-1', email: 'accept@gplink-test.local' };
const DECLINE_GP = { userId: 'gp-decline-1', email: 'decline@gplink-test.local' };
const EXPIRED_GP = { userId: 'gp-expired-1', email: 'expired@gplink-test.local' };
const SWEPT_GP = { userId: 'gp-swept-1', email: 'swept@gplink-test.local' };
const VIEW_GP = { userId: 'gp-view-1', email: 'view@gplink-test.local' };
const OTHER_GP = { userId: 'gp-other-1', email: 'other@gplink-test.local' };
const GATED_GP = { userId: 'gp-gated-1', email: 'gated@gplink-test.local' };
const SEEN_GP = { userId: 'gp-seen-1', email: 'seen@gplink-test.local' };
const FILLED_GP = { userId: 'gp-filled-1', email: 'filled@gplink-test.local' };
const IV_GP = { userId: 'gp-interview-1', email: 'interview@gplink-test.local' };
const DECLINE_FAIL_GP = { userId: 'gp-decline-fail-1', email: 'decline-fail@gplink-test.local' };
// ALERTS_GP deliberately has NO user_state row (see db.user_state below) —
// exercises the alerts upsert path for a brand-new user (2026-07-20 audit).
const ALERTS_GP = { userId: 'gp-alerts-1', email: 'alerts@gplink-test.local' };

const ALL_GPS = [ACCEPT_GP, DECLINE_GP, EXPIRED_GP, SWEPT_GP, VIEW_GP, OTHER_GP, GATED_GP, SEEN_GP, FILLED_GP, IV_GP, DECLINE_FAIL_GP];

// ── In-memory PostgREST emulator ────────────────────────────────────────────
const db = {
  user_profiles: ALL_GPS.concat([ALERTS_GP]).map((g, i) => ({
    user_id: g.userId, email: g.email, first_name: 'Test', last_name: `Doctor${i}`,
    registration_country: 'united kingdom'
  })),
  // NOTE: ALERTS_GP intentionally excluded — no user_state row exists for it.
  user_state: ALL_GPS.map((g) => ({
    user_id: g.userId,
    state: g.userId === GATED_GP.userId
      ? { gp_onboarding_complete: true, account_status: 'under_review' }
      : { gp_onboarding_complete: true },
    updated_at: iso(NOW)
  })),
  user_documents: [],
  user_roles: [],
  registration_cases: [],
  registration_tasks: [],
  task_timeline: [],
  ats_stage_events: [],
  rso_team: [],
  practices: [
    {
      id: 'prac-1', name: 'Coral Coast Family Practice',
      website: 'https://coralcoastfamilypractice.com.au',
      intro_video_url: 'https://videos.gplink-test.local/coral.mp4'
    },
    { id: 'prac-2', name: 'Riverbend Medical Centre', website: '', intro_video_url: '' }
  ],
  career_roles: [
    {
      id: 'job-1', provider: 'internal_ats', provider_role_id: 'ats_job1',
      title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      practice_id: 'prac-1', location_city: 'Bundaberg', location_state: 'QLD',
      dpa: true, header_image_url: 'https://images.gplink-test.local/bargara.jpg', suburb: 'Bargara',
      billing_model: 'Mixed billing', job_status: 'open', is_active: true
    },
    {
      id: 'job-2', provider: 'internal_ats', provider_role_id: 'ats_job2',
      title: 'General Practitioner — Bulk Billing', practice_name: 'Riverbend Medical Centre',
      practice_id: 'prac-2', location_city: 'Toowoomba', location_state: 'QLD',
      dpa: false, header_image_url: '', job_status: 'open', is_active: true
    }
  ],
  gp_applications: [
    // ACCEPT_GP: live match, 4 days left.
    {
      id: 'app-accept-1', user_id: ACCEPT_GP.userId, career_role_id: 'job-1',
      provider_role_id: 'ats_job1', ats_stage: 'shortlisted', origin: 'ai_matched',
      status: 'applied', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_score: 82, match_reasons: { reasons: ['Coastal Queensland — your preferred location', 'DPA approved supports your visa pathway'], _history: [] },
      matched_by: 'consultant@gplink-test.local', matched_at: iso(NOW - 86400000), match_expires_at: iso(NOW + 4 * 86400000),
      match_seen_at: null, match_outcome: null
    },
    // DECLINE_GP: live match.
    {
      id: 'app-decline-1', user_id: DECLINE_GP.userId, career_role_id: 'job-1',
      provider_role_id: 'ats_job1', ats_stage: 'shortlisted', origin: 'ai_matched',
      status: 'applied', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_score: 70, match_reasons: { reasons: ['Regional QLD supports your visa pathway'], _history: [] },
      matched_by: 'consultant@gplink-test.local', matched_at: iso(NOW - 86400000), match_expires_at: iso(NOW + 3 * 86400000),
      match_seen_at: null, match_outcome: null
    },
    // EXPIRED_GP: still 'shortlisted' but match_expires_at is in the past (cron hasn't swept it yet).
    {
      id: 'app-expired-1', user_id: EXPIRED_GP.userId, career_role_id: 'job-1',
      provider_role_id: 'ats_job1', ats_stage: 'shortlisted', origin: 'ai_matched',
      status: 'applied', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_score: 60, match_reasons: { reasons: ['Family friendly hours nearby'], _history: [] },
      matched_by: 'consultant@gplink-test.local', matched_at: iso(NOW - 6 * 86400000), match_expires_at: iso(NOW - 86400000),
      match_seen_at: iso(NOW - 2 * 86400000), match_outcome: null
    },
    // SWEPT_GP: already flipped to not_proceeding/expired by a (future) lifecycle cron.
    {
      id: 'app-swept-1', user_id: SWEPT_GP.userId, career_role_id: 'job-1',
      provider_role_id: 'ats_job1', ats_stage: 'not_proceeding', origin: 'ai_matched',
      status: 'applied', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_score: 55, match_reasons: { reasons: ['Coastal QLD fit'], _history: [{ outcome: 'expired', at: iso(NOW - 86400000) }] },
      matched_by: 'consultant@gplink-test.local', matched_at: iso(NOW - 10 * 86400000), match_expires_at: iso(NOW - 5 * 86400000),
      match_seen_at: iso(NOW - 6 * 86400000), match_outcome: 'expired'
    },
    // DECLINE_FAIL_GP: live match used ONLY by the decline-PATCH-failure test.
    {
      id: 'app-decline-fail-1', user_id: DECLINE_FAIL_GP.userId, career_role_id: 'job-1',
      provider_role_id: 'ats_job1', ats_stage: 'shortlisted', origin: 'ai_matched',
      status: 'applied', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_score: 68, match_reasons: { reasons: ['Coastal QLD fit'], _history: [] },
      matched_by: 'consultant@gplink-test.local', matched_at: iso(NOW - 86400000), match_expires_at: iso(NOW + 3 * 86400000),
      match_seen_at: null, match_outcome: null
    },
    // VIEW_GP: live match with full job/practice fields, for the matches-shape test.
    {
      id: 'app-view-1', user_id: VIEW_GP.userId, career_role_id: 'job-1',
      provider_role_id: 'ats_job1', ats_stage: 'shortlisted', origin: 'ai_matched',
      status: 'applied', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_score: 91, match_reasons: { reasons: ['Coastal Queensland — your preferred location', 'DPA approved', 'Family-friendly hours'], _history: [] },
      matched_by: 'consultant@gplink-test.local', matched_at: iso(NOW - 3600000), match_expires_at: iso(NOW + 5 * 86400000),
      match_seen_at: null, match_outcome: null
    },
    // OTHER_GP: a second live match — used to prove VIEW_GP never sees it.
    {
      id: 'app-other-1', user_id: OTHER_GP.userId, career_role_id: 'job-2',
      provider_role_id: 'ats_job2', ats_stage: 'shortlisted', origin: 'ai_matched',
      status: 'applied', job_title: 'General Practitioner — Bulk Billing', practice_name: 'Riverbend Medical Centre',
      match_score: 65, match_reasons: { reasons: ['Large family patient base'], _history: [] },
      matched_by: 'consultant@gplink-test.local', matched_at: iso(NOW - 3600000), match_expires_at: iso(NOW + 5 * 86400000),
      match_seen_at: null, match_outcome: null
    },
    // GATED_GP: live match, but the account is under_review — must never surface.
    {
      id: 'app-gated-1', user_id: GATED_GP.userId, career_role_id: 'job-1',
      provider_role_id: 'ats_job1', ats_stage: 'shortlisted', origin: 'ai_matched',
      status: 'applied', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_score: 88, match_reasons: { reasons: ['Coastal QLD fit'], _history: [] },
      matched_by: 'consultant@gplink-test.local', matched_at: iso(NOW - 3600000), match_expires_at: iso(NOW + 5 * 86400000),
      match_seen_at: null, match_outcome: null
    },
    // SEEN_GP: match_seen_at already null — used for the seen-set-once test.
    {
      id: 'app-seen-1', user_id: SEEN_GP.userId, career_role_id: 'job-1',
      provider_role_id: 'ats_job1', ats_stage: 'shortlisted', origin: 'ai_matched',
      status: 'applied', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_score: 77, match_reasons: { reasons: ['Coastal QLD fit'], _history: [] },
      matched_by: 'consultant@gplink-test.local', matched_at: iso(NOW - 3600000), match_expires_at: iso(NOW + 5 * 86400000),
      match_seen_at: null, match_outcome: null
    },
    // FILLED_GP: position_filled, with an un-dismissed redirect_alternatives payload.
    // revealed:true mirrors production ai_matched rows (the shortlist insert
    // sets it) — the position-filled card only names the real practice for
    // applications that passed the reveal gate (Task 3, 2026-07-20 audit).
    {
      id: 'app-filled-1', user_id: FILLED_GP.userId, career_role_id: 'job-2',
      provider_role_id: 'ats_job2', ats_stage: 'not_proceeding', origin: 'ai_matched', revealed: true,
      status: 'applied', job_title: 'General Practitioner — Bulk Billing', practice_name: 'Riverbend Medical Centre',
      match_score: 60, match_reasons: { reasons: ['Regional QLD fit'], _history: [] },
      matched_by: 'consultant@gplink-test.local', matched_at: iso(NOW - 8 * 86400000), match_expires_at: iso(NOW - 3 * 86400000),
      match_seen_at: iso(NOW - 7 * 86400000), match_outcome: 'position_filled',
      redirect_alternatives: { alternatives: [{ jobTitle: 'GP — Coastal Clinic', locationCity: 'Gladstone', locationState: 'QLD', tags: ['Same coastal region'] }] }
    }
  ]
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

// Tables whose next PATCHes should 500 — lets tests prove the server never
// reports success for a write the database rejected (2026-07-20 audit).
const patchFailTables = new Set();

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
  function coerce(cell, val) {
    if (typeof cell === 'string' && /^\d{4}-\d{2}-\d{2}/.test(cell) && /^\d{4}-\d{2}-\d{2}/.test(val)) {
      return [Date.parse(cell), Date.parse(val)];
    }
    const cellNum = Number(cell), valNum = Number(val);
    if (cell !== null && cell !== undefined && cell !== '' && !Number.isNaN(cellNum) && !Number.isNaN(valNum)) {
      return [cellNum, valNum];
    }
    return [String(cell), val];
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
    if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
      if (cell === null || cell === undefined) return false;
      const [a, b] = coerce(cell, val);
      if (op === 'gt') return a > b;
      if (op === 'gte') return a >= b;
      if (op === 'lt') return a < b;
      if (op === 'lte') return a <= b;
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
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
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
        const saved = incoming.map((r) => {
          const row = { id: r.id || crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          rows.push(row);
          return row;
        });
        send(201, saved);
        return;
      }
      if (req.method === 'PATCH') {
        if (patchFailTables.has(decodeURIComponent(m[1]))) {
          await readBody(req);
          send(500, { message: 'simulated PATCH failure' });
          return;
        }
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
function httpReq(method, p, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
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

let serverModule;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'ai-matching-gp-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.OPENAI_API_KEY = '';
  process.env.ADMIN_EMAILS = '';
  process.env.SUPER_ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 'test-resend-key';

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.resend.com/')) {
      let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
      resendCalls.push({ url: u, body: parsed });
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
    }
    return realFetch(url, opts);
  };

  serverModule = await import('../server.js');
  server = serverModule.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  globalThis.fetch = realFetch;
  try { fs.unlinkSync(DB_FILE); } catch {}
});

beforeEach(() => {
  resendCalls.length = 0;
});

// ── buildMatchEmailHtml / sendMatchEmail (unit-level, via __testUtils) ──────
describe('buildMatchEmailHtml', () => {
  const baseRow = {
    id: 'app-unit-1',
    match_reasons: { reasons: ['Coastal Queensland — your preferred location', 'A reason mentioning 70% billings split (stored verbatim)'] },
    match_expires_at: iso(NOW + 3 * 86400000)
  };
  const job = {
    title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
    location_city: 'Bundaberg', location_state: 'QLD', dpa: true,
    header_image_url: 'https://images.gplink-test.local/bargara.jpg', suburb: 'Bargara'
  };
  const practice = { name: 'Coral Coast Family Practice', website: 'https://coralcoastfamilypractice.com.au', intro_video_url: 'https://videos.gplink-test.local/coral.mp4' };

  it('contains the practice name, website, verbatim 98% line, and the reserve-until date', () => {
    const html = serverModule.__testUtils.buildMatchEmailHtml(baseRow, job, practice, { gpLastName: 'Okafor' });
    expect(html).toContain('Coral Coast Family Practice');
    expect(html).toContain('coralcoastfamilypractice.com.au');
    expect(html).toContain('98% of GPs we match are accepted by the practice.'.replace('98% ', ''));
    expect(html).toContain('of GPs we match are accepted by the practice.');
    expect(html).toContain('98%');
    expect(html).toContain('This match is reserved for you until');
    expect(html).toContain('Dr Okafor');
  });

  it('renders ONLY the stored reasons verbatim — never injects its own money/billing strings', () => {
    const html = serverModule.__testUtils.buildMatchEmailHtml(baseRow, job, practice, { gpLastName: 'Okafor' });
    // The stored reason (which happens to mention billings) renders verbatim —
    // that's the fixture's business, not the builder's.
    expect(html).toContain('A reason mentioning 70% billings split (stored verbatim)');
    // Outside of that ONE stored string, the builder itself must never author
    // its own money-shaped copy anywhere else in the document.
    const withoutStoredReason = html.replace('A reason mentioning 70% billings split (stored verbatim)', '');
    expect(withoutStoredReason).not.toMatch(/\d+%\s*billings?/i);
    expect(withoutStoredReason).not.toMatch(/\$\d/);
  });

  // The email offered no way into the in-app practice profile — only the
  // accept CTA and the practice's own external website. A doctor who wanted to
  // read the profile before answering had to go looking for it (owner report
  // 2026-07-27). The link carries ?match= so the page opens in match mode.
  it('links to the in-app practice profile for this opening', () => {
    const html = serverModule.__testUtils.buildMatchEmailHtml(
      baseRow,
      { ...job, provider: 'internal_ats', provider_role_id: '93104' },
      practice,
      { gpLastName: 'Okafor' }
    );
    expect(html).toContain('See full practice profile');
    // The destination is percent-encoded inside signin's ?next=, so decode
    // before asserting rather than matching the raw attribute.
    const href = (html.match(/<a href="([^"]+)"[^>]*>See full practice profile<\/a>/) || [])[1] || '';
    expect(href).toContain('/pages/signin?next=');
    const decoded = decodeURIComponent(href);
    expect(decoded).toContain('/pages/job?id=internal_ats:93104');
    expect(decoded).toContain('match=' + baseRow.id);
    // Still secondary to the accept CTA, which must remain.
    expect(html).toContain('Accept this match');
  });
  it('omits the profile link when the role has no public id to link to', () => {
    const html = serverModule.__testUtils.buildMatchEmailHtml(baseRow, { title: 'X Medical Centre' }, {}, {});
    expect(html).not.toContain('See full practice profile');
    expect(html).not.toContain('/pages/job?id=');
  });
  it('omits the photo strip, website link, and video block when absent', () => {
    const html = serverModule.__testUtils.buildMatchEmailHtml(baseRow, {}, {}, {});
    expect(html).not.toContain('<img');
    expect(html).not.toContain('🌐');
    expect(html).not.toContain('Meet ');
  });

  it('reminder variant: compressed body, amber urgency banner, no video/next-steps block', () => {
    const html = serverModule.__testUtils.buildMatchEmailHtml(baseRow, job, practice, { gpLastName: 'Okafor', reminder: true });
    expect(html).toContain('Less than 24 hours left');
    expect(html).not.toContain('What happens next');
    expect(html).not.toContain('Meet Coral Coast Family Practice');
    // Still renders the job card + reasons + 98% line even when compressed.
    expect(html).toContain('Coral Coast Family Practice');
    expect(html).toContain('of GPs we match are accepted by the practice.');
  });
});

// Corporate groups (ForHealth, GP West Group, …) post many openings under one
// practice_name, and the practices row behind practice_id is the CORPORATION —
// so the clinic the GP is actually matched to only exists after the legacy "||"
// separator in career_roles.title. Matching surfaces lead with that opening
// (owner call 2026-07-12 for the board, extended to the GP-facing email
// 2026-07-26). atsJobDisplayNames is the server twin of mbPracticeDisplay in
// js/ceo-ats-matching.js — keep the two in sync.
describe('atsJobDisplayNames — practice, never the corporation', () => {
  const names = (job, practice) => serverModule.__testUtils.atsJobDisplayNames(job, practice);

  // The dominant real shape: 40 of the 64 live career_roles rows look like
  // this — no separator at all, the clinic sitting alone in title, the
  // corporation in practice_name. Every ForHealth and Spectrum row is one of
  // these, and they are exactly the rows that rendered as a wall of identical
  // "ForHealth Group" headlines.
  it('uses a bare clinic title over a corporate practice_name (the common case)', () => {
    const n = names({ title: 'Young Street Medical & Dental Centre', practice_name: 'ForHealth Group' }, { name: 'ForHealth Group' });
    expect(n.practice).toBe('Young Street Medical & Dental Centre');
    expect(n.group).toBe('ForHealth Group');
  });
  it('does NOT mistake a bare role title for a clinic name', () => {
    // practice_name is the clinic here — the title carries no clinic at all.
    expect(names({ title: 'General Practitioner', practice_name: 'The Doctors Werribee' }, {}).practice).toBe('The Doctors Werribee');
    expect(names({ title: 'DPA - Erina (Central Coast) - Mixed Billing', practice_name: 'Erina Medical Centre' }, {}).practice).toBe('Erina Medical Centre');
  });
  // The separator appears in BOTH orders in live data, so position cannot
  // decide which half is the clinic — which half reads as a job title does.
  it('handles "clinic || role" as well as "role || clinic"', () => {
    const roleFirst = names({ title: 'General Practitioner || Carrara Family Practice', practice_name: 'Carrara Family Practice' }, {});
    expect(roleFirst.practice).toBe('Carrara Family Practice');
    expect(roleFirst.role).toBe('General Practitioner');

    const clinicFirst = names({ title: 'Thornton Medical Centre || General Practitioner', practice_name: 'Thornton Medical Centre' }, {});
    expect(clinicFirst.practice).toBe('Thornton Medical Centre');
    expect(clinicFirst.role).toBe('General Practitioner');
    // The regression this replaces: the old position-based split returned the
    // second half blindly, so a clinic-first title headlined as the job title.
    expect(clinicFirst.practice).not.toBe('General Practitioner');
  });
  it('leads with the opening name when the practice row is the corporation', () => {
    const n = names({ title: 'General Practitioner || Greenway Medical Centre', practice_name: 'ForHealth Group' }, { name: 'ForHealth Group' });
    expect(n.practice).toBe('Greenway Medical Centre');
    expect(n.role).toBe('General Practitioner');
    expect(n.group).toBe('ForHealth Group');
  });
  it('splits the role off so the raw "||" never reaches GP-facing copy', () => {
    expect(names({ title: 'GP — Mixed Billing || North Ipswich Family Practice' }, {}).role).toBe('GP — Mixed Billing');
    expect(names({ title: 'GP — Mixed Billing || North Ipswich Family Practice' }, {}).practice).toBe('North Ipswich Family Practice');
  });
  it('independent practices keep the stored practice_name casing and get no group', () => {
    const n = names({ title: 'General Practitioner || Bay Village Medical Centre', practice_name: 'Bay village medical centre' }, {});
    expect(n.practice).toBe('Bay village medical centre');
    expect(n.group).toBe('');
  });
  it('legacy titles without the separator behave exactly as before', () => {
    const n = names({ title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice' }, { name: 'Coral Coast Family Practice' });
    expect(n.practice).toBe('Coral Coast Family Practice');
    expect(n.role).toBe('General Practitioner — Mixed Billing');
    expect(n.group).toBe('');
  });
  // The masked position-filled card (ai-matching-redirect.test.js) blanks
  // practiceName behind the reveal gate but still ships jobTitle. An unsplit
  // corporate title names the clinic right there in the job title, so the
  // split is what keeps the gate honest for BOTH fields.
  it('keeps the clinic out of the role, so a masked card cannot leak it via jobTitle', () => {
    const n = names({ title: 'General Practitioner || Coral Coast Family Practice', practice_name: 'ForHealth Group' }, {});
    expect(n.role).toBe('General Practitioner');
    expect(n.role).not.toContain('Coral Coast Family Practice');
    expect(n.practice).toBe('Coral Coast Family Practice');
  });
  it('is null-safe and leaves the callers to apply their own fallbacks', () => {
    expect(names(null, null)).toEqual({ practice: '', role: '', group: '' });
    expect(names({}, {})).toEqual({ practice: '', role: '', group: '' });
    // A trailing separator with nothing after it is not an opening name.
    expect(names({ title: 'GP ||', practice_name: 'Corp' }, {}).practice).toBe('Corp');
  });
});

describe('match email — a corporate GP sees the clinic, not the corporation', () => {
  const corpRow = {
    id: 'app-corp-1',
    match_reasons: { reasons: ['Greenway is close to your preferred suburb'] },
    match_expires_at: iso(NOW + 3 * 86400000),
  };
  const corpJob = { title: 'General Practitioner || Greenway Medical Centre', practice_name: 'ForHealth Group', location_city: 'Canberra', location_state: 'ACT' };
  const corpPractice = { name: 'ForHealth Group' };

  it('names the clinic in the body and never leaks the "||" separator', () => {
    const html = serverModule.__testUtils.buildMatchEmailHtml(corpRow, corpJob, corpPractice, { gpLastName: 'Okafor' });
    expect(html).toContain('Greenway Medical Centre');
    expect(html).not.toContain('General Practitioner || Greenway Medical Centre');
    expect(html).toContain('General Practitioner');
  });
});

describe('sendMatchEmail', () => {
  it('sends the normal-variant subject with practice name + city/state', async () => {
    const row = tableOf('gp_applications').find((a) => a.id === 'app-view-1');
    const result = await serverModule.__testUtils.sendMatchEmail(row);
    expect(result.ok).toBe(true);
    expect(resendCalls.length).toBe(1);
    expect(resendCalls[0].body.subject).toBe("You've been personally matched, Coral Coast Family Practice, Bundaberg QLD");
    expect(resendCalls[0].body.html).toContain('Coral Coast Family Practice');
  });

  it('reminder variant carries the verbatim 24h subject naming the practice (Task 2, 2026-07-11 nudges plan)', async () => {
    const row = tableOf('gp_applications').find((a) => a.id === 'app-view-1');
    const result = await serverModule.__testUtils.sendMatchEmail(row, { reminder: true });
    expect(result.ok).toBe(true);
    expect(resendCalls.length).toBe(1);
    expect(resendCalls[0].body.subject).toBe('24 hours left, Coral Coast Family Practice is holding your spot');
  });
});

// ── GET /api/career/matches ──────────────────────────────────────────────────
describe('GET /api/career/matches', () => {
  it('returns the shape described in the brief for a live match', async () => {
    const res = await httpReq('GET', '/api/career/matches', { cookie: userCookie(VIEW_GP.email, VIEW_GP.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.locked).toBe(false);
    expect(Array.isArray(res.body.matches)).toBe(true);
    const m = res.body.matches.find((x) => x.applicationId === 'app-view-1');
    expect(m).toBeTruthy();
    expect(m.jobTitle).toBe('General Practitioner — Mixed Billing');
    expect(m.practiceName).toBe('Coral Coast Family Practice');
    expect(m.website).toBe('https://coralcoastfamilypractice.com.au');
    expect(m.introVideoUrl).toBe('https://videos.gplink-test.local/coral.mp4');
    expect(m.headerImageUrl).toBe('https://images.gplink-test.local/bargara.jpg');
    expect(m.locationCity).toBe('Bundaberg');
    expect(m.locationState).toBe('QLD');
    expect(m.dpa).toBe(true);
    expect(m.score).toBe(91);
    expect(Array.isArray(m.reasons)).toBe(true);
    expect(m.reasons.length).toBe(3);
    expect(m.seenAt).toBeNull();
    expect(typeof m.expiresAt).toBe('string');
  });

  it('only returns the requesting GP\'s own rows — never another GP\'s match', async () => {
    const res = await httpReq('GET', '/api/career/matches', { cookie: userCookie(VIEW_GP.email, VIEW_GP.userId) });
    expect(res.status).toBe(200);
    const ids = res.body.matches.map((m) => m.applicationId);
    expect(ids).toContain('app-view-1');
    expect(ids).not.toContain('app-other-1');

    const otherRes = await httpReq('GET', '/api/career/matches', { cookie: userCookie(OTHER_GP.email, OTHER_GP.userId) });
    const otherIds = otherRes.body.matches.map((m) => m.applicationId);
    expect(otherIds).toContain('app-other-1');
    expect(otherIds).not.toContain('app-view-1');
  });

  it('returns empty matches (never a popup/card trigger) for a gated (under_review) account', async () => {
    const res = await httpReq('GET', '/api/career/matches', { cookie: userCookie(GATED_GP.email, GATED_GP.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.matches).toEqual([]);
    expect(res.body.positionFilled).toEqual([]);
  });

  it('includes a position-filled entry with its alternatives, and excludes it once dismissed', async () => {
    const res = await httpReq('GET', '/api/career/matches', { cookie: userCookie(FILLED_GP.email, FILLED_GP.userId) });
    expect(res.status).toBe(200);
    const filled = res.body.positionFilled.find((f) => f.applicationId === 'app-filled-1');
    expect(filled).toBeTruthy();
    expect(filled.practiceName).toBe('Riverbend Medical Centre');
    expect(filled.alternatives.length).toBe(1);
    expect(filled.alternatives[0].jobTitle).toBe('GP — Coastal Clinic');

    const dismiss = await httpReq('POST', '/api/career/match/dismiss-filled', {
      cookie: userCookie(FILLED_GP.email, FILLED_GP.userId), body: { applicationId: 'app-filled-1' }
    });
    expect(dismiss.status).toBe(200);
    expect(dismiss.body.ok).toBe(true);

    const res2 = await httpReq('GET', '/api/career/matches', { cookie: userCookie(FILLED_GP.email, FILLED_GP.userId) });
    expect(res2.body.positionFilled.find((f) => f.applicationId === 'app-filled-1')).toBeUndefined();
  });

  it('401/redirects without a session', async () => {
    const res = await httpReq('GET', '/api/career/matches', {});
    expect([302, 401, 403]).toContain(res.status);
  });
});

// ── POST /api/career/match/seen ─────────────────────────────────────────────
describe('POST /api/career/match/seen', () => {
  it('sets match_seen_at, then leaves it unchanged on a second call (set-once)', async () => {
    const before = tableOf('gp_applications').find((a) => a.id === 'app-seen-1');
    expect(before.match_seen_at).toBeNull();

    const first = await httpReq('POST', '/api/career/match/seen', {
      cookie: userCookie(SEEN_GP.email, SEEN_GP.userId), body: { applicationId: 'app-seen-1' }
    });
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    const stampedAt = first.body.seenAt;
    expect(typeof stampedAt).toBe('string');
    expect(tableOf('gp_applications').find((a) => a.id === 'app-seen-1').match_seen_at).toBe(stampedAt);

    const second = await httpReq('POST', '/api/career/match/seen', {
      cookie: userCookie(SEEN_GP.email, SEEN_GP.userId), body: { applicationId: 'app-seen-1' }
    });
    expect(second.status).toBe(200);
    expect(second.body.seenAt).toBe(stampedAt);
  });

  it('404s for another GP\'s applicationId (ownership enforced)', async () => {
    const res = await httpReq('POST', '/api/career/match/seen', {
      cookie: userCookie(OTHER_GP.email, OTHER_GP.userId), body: { applicationId: 'app-accept-1' }
    });
    expect(res.status).toBe(404);
  });
});

// ── POST /api/career/match/respond ──────────────────────────────────────────
describe('POST /api/career/match/respond — accept', () => {
  it('accepts: ats_stage → applied, match_outcome → accepted, submission task created, ops email fired', async () => {
    const res = await httpReq('POST', '/api/career/match/respond', {
      cookie: userCookie(ACCEPT_GP.email, ACCEPT_GP.userId),
      body: { applicationId: 'app-accept-1', action: 'accept' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('accept');

    const row = tableOf('gp_applications').find((a) => a.id === 'app-accept-1');
    expect(row.ats_stage).toBe('applied');
    expect(row.match_outcome).toBe('accepted');

    // Shared post-apply side effect: the SAME "Submit <GP> to practice" VA
    // follow-up task apply's own flow creates, reusing the extracted helper.
    const task = tableOf('registration_tasks').find((t) => t.source_trigger === 'career_application' && t.description.includes('app-accept-1'));
    expect(task).toBeTruthy();
    expect(task.title).toMatch(/^Submit .* to practice$/);
    expect(row.submission_task_id).toBe(task.id);
    expect(row.practice_submission_status).toBe('pending_va_submission');

    // ats_stage_events audit row.
    const stageEvent = tableOf('ats_stage_events').find((e) => e.application_id === 'app-accept-1' && e.to_stage === 'applied');
    expect(stageEvent).toBeTruthy();
    expect(stageEvent.from_stage).toBe('shortlisted');

    // Ops emails: the standard A3 "applied" notice AND the match-specific one.
    const subjects = resendCalls.map((c) => c.body && c.body.subject);
    expect(subjects.some((s) => /^Match accepted: .* → General Practitioner — Mixed Billing$/.test(s))).toBe(true);
    expect(subjects.some((s) => / applied to .*, Coral Coast Family Practice$/.test(s))).toBe(true);
    // And the doctor's own confirmation. Accepting a match is NOT a cold
    // apply, so it must not say "Application Submitted" — it tells them
    // interview times are coming (owner request 2026-07-29).
    expect(subjects.some((s) => /^You're being fast-tracked.* — interview times coming$/.test(s))).toBe(true);
    expect(subjects).not.toContain('Application Submitted, GP Link');
    const gpEmail = resendCalls.find((c) => c.body && /interview times coming$/.test(c.body.subject || ''));
    expect(gpEmail.body.html).toContain('What happens next');
    expect(gpEmail.body.html).toContain('interview times to choose from');
    expect(gpEmail.body.html).not.toContain('not a commitment');
  });

  it('a second accept on the SAME (now applied) row 409s — no double-processing', async () => {
    const res = await httpReq('POST', '/api/career/match/respond', {
      cookie: userCookie(ACCEPT_GP.email, ACCEPT_GP.userId),
      body: { applicationId: 'app-accept-1', action: 'accept' }
    });
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
  });
});

describe('POST /api/career/match/respond — decline', () => {
  it('declines with a reason: not_proceeding + declined + decline_reason + ops email', async () => {
    const res = await httpReq('POST', '/api/career/match/respond', {
      cookie: userCookie(DECLINE_GP.email, DECLINE_GP.userId),
      body: { applicationId: 'app-decline-1', action: 'decline', reason: 'Too far from family in Sydney.' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('decline');

    const row = tableOf('gp_applications').find((a) => a.id === 'app-decline-1');
    expect(row.ats_stage).toBe('not_proceeding');
    expect(row.match_outcome).toBe('declined');
    expect(row.decline_reason).toBe('Too far from family in Sydney.');

    const subjects = resendCalls.map((c) => c.body && c.body.subject);
    expect(subjects.some((s) => s.startsWith('Match declined:'))).toBe(true);
    const declineEmail = resendCalls.find((c) => c.body.subject.startsWith('Match declined:'));
    expect(declineEmail.body.text).toContain('Too far from family in Sydney.');
  });

  // 2026-07-20 audit: the handler used to fire-and-forget the PATCH and answer
  // {ok:true} regardless — the GP saw "we've let your team know" while the row
  // stayed shortlisted. A failed write must surface as a non-OK response.
  it('returns 500 (not ok:true) when the decline PATCH fails, and the row stays shortlisted', async () => {
    patchFailTables.add('gp_applications');
    try {
      const res = await httpReq('POST', '/api/career/match/respond', {
        cookie: userCookie(DECLINE_FAIL_GP.email, DECLINE_FAIL_GP.userId),
        body: { applicationId: 'app-decline-fail-1', action: 'decline', reason: 'Testing failure path.' }
      });
      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);

      // Row untouched — the decline was never recorded.
      const row = tableOf('gp_applications').find((a) => a.id === 'app-decline-fail-1');
      expect(row.ats_stage).toBe('shortlisted');
      expect(row.match_outcome).toBeNull();

      // No "Match declined" ops email for a decline that never landed.
      const subjects = resendCalls.map((c) => c.body && c.body.subject);
      expect(subjects.some((s) => typeof s === 'string' && s.startsWith('Match declined:'))).toBe(false);
    } finally {
      patchFailTables.clear();
    }
  });
});

// ── POST/GET /api/career/alerts ─────────────────────────────────────────────
// 2026-07-20 audit: POST blind-PATCHed user_state — for a user with NO
// user_state row yet, the PATCH matched 0 rows, the server still said
// {ok:true}, and the GET read back enabled:false. Must upsert.
describe('POST + GET /api/career/alerts — first save for a user with no user_state row', () => {
  it('POST creates the row (upsert) and GET reads the preference back as enabled', async () => {
    const cookie = userCookie(ALERTS_GP.email, ALERTS_GP.userId);

    // Precondition: genuinely no user_state row for this user.
    expect(tableOf('user_state').some((r) => r.user_id === ALERTS_GP.userId)).toBe(false);

    const post = await httpReq('POST', '/api/career/alerts', {
      cookie, body: { enabled: true, filters: { location: 'QLD', billing: 'Mixed billing', tokens: ['coastal'] } }
    });
    expect(post.status).toBe(200);
    expect(post.body.ok).toBe(true);
    expect(post.body.alerts && post.body.alerts.enabled).toBe(true);

    // The write really landed as a row.
    const row = tableOf('user_state').find((r) => r.user_id === ALERTS_GP.userId);
    expect(row).toBeTruthy();
    expect(row.state && row.state.gp_career_alerts && row.state.gp_career_alerts.enabled).toBe(true);

    const get = await httpReq('GET', '/api/career/alerts', { cookie });
    expect(get.status).toBe(200);
    expect(get.body.ok).toBe(true);
    expect(get.body.alerts.enabled).toBe(true);
    expect(get.body.alerts.filters.location).toBe('QLD');
  });
});

describe('POST /api/career/match/respond — expired', () => {
  it('a still-shortlisted row past its window 410s with the graceful message + ops email', async () => {
    const res = await httpReq('POST', '/api/career/match/respond', {
      cookie: userCookie(EXPIRED_GP.email, EXPIRED_GP.userId),
      body: { applicationId: 'app-expired-1', action: 'accept' }
    });
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.expired).toBe(true);
    expect(res.body.message).toMatch(/expired.*may still be open.*told you're interested/i);

    // Row untouched — never silently accepted/declined.
    const row = tableOf('gp_applications').find((a) => a.id === 'app-expired-1');
    expect(row.ats_stage).toBe('shortlisted');
    expect(row.match_outcome).toBeNull();

    const opsEmail = resendCalls.find((c) => c.body && /^GP clicked expired match, still interested:/.test(c.body.subject));
    expect(opsEmail).toBeTruthy();
  });

  it('a row already swept to not_proceeding/expired by the (future) lifecycle cron also 410s', async () => {
    const res = await httpReq('POST', '/api/career/match/respond', {
      cookie: userCookie(SWEPT_GP.email, SWEPT_GP.userId),
      body: { applicationId: 'app-swept-1', action: 'decline' }
    });
    expect(res.status).toBe(410);
    expect(res.body.expired).toBe(true);
  });
});

describe('POST /api/career/match/respond — ownership + validation', () => {
  it('404s when the applicationId belongs to a different GP', async () => {
    const res = await httpReq('POST', '/api/career/match/respond', {
      cookie: userCookie(OTHER_GP.email, OTHER_GP.userId),
      body: { applicationId: 'app-view-1', action: 'accept' }
    });
    expect(res.status).toBe(404);
  });

  it('400s on a missing/invalid action', async () => {
    const res = await httpReq('POST', '/api/career/match/respond', {
      cookie: userCookie(VIEW_GP.email, VIEW_GP.userId),
      body: { applicationId: 'app-view-1', action: 'maybe' }
    });
    expect(res.status).toBe(400);
  });
});

// ── GET /api/career/interview-usage ─────────────────────────────────────────
describe('GET /api/career/interview-usage', () => {
  it('counts only scheduled/confirmed/completed interviews within the CURRENT UTC month (boundary-correct)', async () => {
    const now = new Date();
    const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lastDayThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 0));
    const firstDayNextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
    const lastDayPrevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 0, 0));

    tableOf('career_interviews').push(
      { id: 'iv-1', application_id: 'app-view-1', user_id: IV_GP.userId, status: 'scheduled', scheduled_at: thisMonthStart.toISOString() },
      { id: 'iv-2', application_id: 'app-view-1', user_id: IV_GP.userId, status: 'confirmed', scheduled_at: lastDayThisMonth.toISOString() },
      { id: 'iv-3', application_id: 'app-view-1', user_id: IV_GP.userId, status: 'completed', scheduled_at: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15)).toISOString() },
      // Out of window: last day of PREVIOUS month.
      { id: 'iv-4', application_id: 'app-view-1', user_id: IV_GP.userId, status: 'scheduled', scheduled_at: lastDayPrevMonth.toISOString() },
      // Out of window: first day of NEXT month (the exclusive upper bound).
      { id: 'iv-5', application_id: 'app-view-1', user_id: IV_GP.userId, status: 'scheduled', scheduled_at: firstDayNextMonth.toISOString() },
      // In-window date, but wrong status — must not count.
      { id: 'iv-6', application_id: 'app-view-1', user_id: IV_GP.userId, status: 'cancelled', scheduled_at: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 10)).toISOString() }
    );

    const res = await httpReq('GET', '/api/career/interview-usage', { cookie: userCookie(IV_GP.email, IV_GP.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.used).toBe(3);
    expect(res.body.limit).toBe(3);
    expect(new Date(res.body.resetsAt).toISOString()).toBe(firstDayNextMonth.toISOString());
  });

  it('returns 0 used for a GP with no interviews this month', async () => {
    const res = await httpReq('GET', '/api/career/interview-usage', { cookie: userCookie(SEEN_GP.email, SEEN_GP.userId) });
    expect(res.status).toBe(200);
    expect(res.body.used).toBe(0);
    expect(res.body.limit).toBe(3);
  });
});

// ── Review fixes (Task 4 follow-up) ─────────────────────────────────────────

// Extracts a top-level `function <name>(...) {...}` declaration from inline
// page source by brace counting, so the REAL client-side renderer can be
// executed (not just regex-inspected) in these tests.
function extractFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} braces never balanced`);
}

describe('review fix 1 — card URL scheme gate (career.html, executed for real)', () => {
  const careerHtml = fs.readFileSync(path.join(ROOT, 'pages/career.html'), 'utf8');
  // Build a sandbox with the page's real escapeHtml/formatMatchCountdown/
  // matchSafeUrl/buildMatchCardHtml and run the actual card renderer.
  const sandboxSrc = [
    extractFunctionSource(careerHtml, 'escapeHtml'),
    extractFunctionSource(careerHtml, 'matchSafeUrl'),
    extractFunctionSource(careerHtml, 'formatMatchCountdown'),
    extractFunctionSource(careerHtml, 'buildMatchCardHtml'),
    'return buildMatchCardHtml(matchInput);'
  ].join('\n');
  const renderCard = (matchInput) => new Function('matchInput', sandboxSrc)(matchInput);

  const baseMatch = {
    applicationId: 'app-x-1', jobTitle: 'GP — Mixed Billing', practiceName: 'Evil Test Practice',
    locationCity: 'Bundaberg', locationState: 'QLD', dpa: true,
    reasons: ['Coastal fit'], expiresAt: new Date(Date.now() + 3 * 86400000).toISOString(),
    website: '', introVideoUrl: '', headerImageUrl: ''
  };

  it('a javascript: practice website renders NO link at all', () => {
    const html = renderCard({ ...baseMatch, website: 'javascript:alert(document.cookie)' });
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('at-match-weblink');
  });

  it('a data: intro video renders NO video chip; javascript: photo renders NO img', () => {
    const html = renderCard({
      ...baseMatch,
      introVideoUrl: 'data:text/html,<script>alert(1)</script>',
      headerImageUrl: 'javascript:alert(1)'
    });
    expect(html).not.toContain('data:text/html');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('Meet the practice');
  });

  it('genuine https URLs still render (gate is scheme-only, not a blanket removal)', () => {
    const html = renderCard({
      ...baseMatch,
      website: 'https://evil-free.example.com.au',
      introVideoUrl: 'https://videos.example/intro.mp4',
      headerImageUrl: 'https://images.example/photo.jpg'
    });
    expect(html).toContain('href="https://evil-free.example.com.au"');
    expect(html).toContain('href="https://videos.example/intro.mp4"');
    expect(html).toContain('src="https://images.example/photo.jpg"');
  });
});

describe('review fix 2 — email builder escapes URL attribute breakouts', () => {
  const row = {
    id: 'app-esc-1',
    match_reasons: { reasons: ['Coastal fit'] },
    match_expires_at: iso(NOW + 3 * 86400000)
  };
  // Valid https scheme (passes _matchSafeUrl) but carrying a `"` breakout
  // attempt — must be neutralised by attribute-escaping, not passed raw.
  const breakout = 'https://practice.example/x"onmouseover="alert(1)';

  it('website href: the quote cannot break out of the attribute', () => {
    const html = serverModule.__testUtils.buildMatchEmailHtml(row, { title: 'GP' }, { name: 'P', website: breakout }, {});
    expect(html).not.toContain('x"onmouseover');
    expect(html).toContain('x&quot;onmouseover');
  });

  it('header image src + intro video href: same escaping', () => {
    const html = serverModule.__testUtils.buildMatchEmailHtml(
      row,
      { title: 'GP', header_image_url: breakout, suburb: 'Bargara' },
      { name: 'P', intro_video_url: breakout },
      {}
    );
    expect(html).not.toContain('x"onmouseover');
    // Both insertion points escaped (src= and href=).
    expect((html.match(/x&quot;onmouseover/g) || []).length).toBe(2);
  });
});

describe('review fix 3a — respond is account-gated like /matches', () => {
  it('an under_review account gets 403 account_gated and the row is untouched', async () => {
    const res = await httpReq('POST', '/api/career/match/respond', {
      cookie: userCookie(GATED_GP.email, GATED_GP.userId),
      body: { applicationId: 'app-gated-1', action: 'accept' }
    });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('account_gated');

    const row = tableOf('gp_applications').find((a) => a.id === 'app-gated-1');
    expect(row.ats_stage).toBe('shortlisted');
    expect(row.match_outcome).toBeNull();
    // And no ops/GP email fired.
    expect(resendCalls.length).toBe(0);
  });
});

describe('review fix 3b — deep link never posts an accept', () => {
  const careerHtml = fs.readFileSync(path.join(ROOT, 'pages/career.html'), 'utf8');

  it('handleMatchDeepLink contains NO respond call and uses the still-interested probe', () => {
    const fnSrc = extractFunctionSource(careerHtml, 'handleMatchDeepLink');
    expect(fnSrc).not.toContain('/api/career/match/respond');
    expect(fnSrc).not.toContain('accept');
    expect(fnSrc).toContain('/api/career/match/still-interested');
  });

  it('still-interested on an expired match → state expired + ops email, row untouched', async () => {
    const res = await httpReq('POST', '/api/career/match/still-interested', {
      cookie: userCookie(EXPIRED_GP.email, EXPIRED_GP.userId),
      body: { applicationId: 'app-expired-1' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.state).toBe('expired');

    const row = tableOf('gp_applications').find((a) => a.id === 'app-expired-1');
    expect(row.ats_stage).toBe('shortlisted'); // probe NEVER moves the row

    const opsEmail = resendCalls.find((c) => c.body && /^GP clicked expired match, still interested:/.test(c.body.subject));
    expect(opsEmail).toBeTruthy();
  });

  it('still-interested on a live match → state live, NO email', async () => {
    const res = await httpReq('POST', '/api/career/match/still-interested', {
      cookie: userCookie(VIEW_GP.email, VIEW_GP.userId),
      body: { applicationId: 'app-view-1' }
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('live');
    expect(resendCalls.length).toBe(0);
  });

  it('still-interested on a resolved (position_filled) row → state resolved, NO email', async () => {
    const res = await httpReq('POST', '/api/career/match/still-interested', {
      cookie: userCookie(FILLED_GP.email, FILLED_GP.userId),
      body: { applicationId: 'app-filled-1' }
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('resolved');
    expect(resendCalls.length).toBe(0);
  });

  it('still-interested is account-gated + owner-scoped too', async () => {
    const gated = await httpReq('POST', '/api/career/match/still-interested', {
      cookie: userCookie(GATED_GP.email, GATED_GP.userId),
      body: { applicationId: 'app-gated-1' }
    });
    expect(gated.status).toBe(403);
    expect(gated.body.error).toBe('account_gated');

    const wrongOwner = await httpReq('POST', '/api/career/match/still-interested', {
      cookie: userCookie(OTHER_GP.email, OTHER_GP.userId),
      body: { applicationId: 'app-view-1' }
    });
    expect(wrongOwner.status).toBe(404);
    expect(resendCalls.length).toBe(0);
  });
});

describe('review minor — popup reserve strip derives from expiresAt', () => {
  const popupSrc = fs.readFileSync(path.join(ROOT, 'js/match-popup.js'), 'utf8');
  it('computes days-left / until-date from match.expiresAt instead of a static 5-days string', () => {
    expect(popupSrc).toContain('match.expiresAt');
    expect(popupSrc).toContain('more days');
    expect(popupSrc).toMatch(/until/);
    // The static wording survives ONLY as the missing-expiry fallback.
    expect(popupSrc).toContain("reserveInnerHtml = 'for <span class=\"gpmp-cd-u\">5 days</span>'");
  });
});

// Added 2026-07-27. Every surface this app ships sits behind sign-in, so after
// a push there was no way — for a person or a session — to confirm from
// outside which commit production was actually running. `build` is a
// hand-typed string, stale since June, so it cannot answer that. Vercel
// injects VERCEL_GIT_COMMIT_SHA at build time; surfacing it on the existing
// public health endpoint makes "did my push go live?" a single request.
describe('GET /api/health — reports the deployed commit', () => {
  it('returns the build-time commit sha and branch alongside the existing fields', async () => {
    const prevSha = process.env.VERCEL_GIT_COMMIT_SHA;
    const prevRef = process.env.VERCEL_GIT_COMMIT_REF;
    process.env.VERCEL_GIT_COMMIT_SHA = 'abc123def4567890';
    process.env.VERCEL_GIT_COMMIT_REF = 'main';
    try {
      const r = await httpReq('GET', '/api/health');
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.commit).toBe('abc123def4567890');
      expect(r.body.branch).toBe('main');
      // Existing consumers must keep working.
      expect(r.body.status).toBe('healthy');
      expect(typeof r.body.serverTime).toBe('string');
    } finally {
      if (prevSha === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA; else process.env.VERCEL_GIT_COMMIT_SHA = prevSha;
      if (prevRef === undefined) delete process.env.VERCEL_GIT_COMMIT_REF; else process.env.VERCEL_GIT_COMMIT_REF = prevRef;
    }
  });

  it('degrades to "unknown" off-platform rather than throwing or omitting the field', async () => {
    const prevSha = process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    try {
      const r = await httpReq('GET', '/api/health');
      expect(r.status).toBe(200);
      expect(r.body.commit).toBe('unknown');
    } finally {
      if (prevSha !== undefined) process.env.VERCEL_GIT_COMMIT_SHA = prevSha;
    }
  });
});

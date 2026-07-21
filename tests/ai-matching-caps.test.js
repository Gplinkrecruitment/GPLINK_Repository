// Task 7 (AI Matching, 2026-07-06 plan), caps, velocity, self-apply-as-accept.
//
// Two halves, mirroring tests/ai-matching-redirect.test.js:
//  (A) Source-regex wiring checks, no server boot needed.
//  (B) Endpoint + helper behavior against a real Supabase-mode boot (in-
//      memory PostgREST emulator), plus real GP + ATS super_admin sessions.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Source wiring (no server boot needed) ───────────────────────────────────
describe('AI Matching Task 7, source wiring', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const jobHtml = fs.readFileSync(path.join(ROOT, 'pages/job.html'), 'utf8');
  const jobsSrc = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-jobs.js'), 'utf8');
  const candidatesSrc = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-candidates.js'), 'utf8');
  const dashboardHtml = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');
  const migrationSql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260707210000_ats_stage_event_reason.sql'), 'utf8');

  it('server.js declares the active-application cap helper + constant at true top-level and exports both', () => {
    expect(serverSrc).toMatch(/async function countActiveApplications\(userId\)/);
    expect(serverSrc).toContain("var ACTIVE_APPLICATION_STAGES = ['shortlisted', 'applied', 'submitted', 'reviewing', 'interview'];");
    expect(serverSrc).toContain('var ACTIVE_APPLICATION_CAP = 3;');
    expect(serverSrc).toContain('countActiveApplications,');
    expect(serverSrc).toContain('ACTIVE_APPLICATION_CAP,');
  });

  it('server.js declares the merged interview-count helper + cap constant and exports both', () => {
    expect(serverSrc).toMatch(/async function countMonthlyCareerInterviews\(userId, monthStart, monthEnd\)/);
    expect(serverSrc).toContain('var INTERVIEW_MONTHLY_CAP = 3;');
    expect(serverSrc).toContain("status=in.(scheduled,confirmed,completed)");
    expect(serverSrc).toContain("status=in.(booked,completed)");
    expect(serverSrc).toContain('countMonthlyCareerInterviews,');
    expect(serverSrc).toContain('currentInterviewMonthWindow,');
  });

  it('GET /api/career/interview-usage now uses the merged helper, not a career_interviews-only query', () => {
    const idx = serverSrc.indexOf("pathname === '/api/career/interview-usage'");
    const fnSrc = serverSrc.slice(idx, idx + 900);
    expect(fnSrc).toContain('countMonthlyCareerInterviews(iuUserId, iuWindow.start, iuWindow.end)');
    expect(fnSrc).not.toContain("'career_interviews',\n      'select=id&user_id=eq.");
  });

  it('both interview-book endpoints enforce the interview cap before booking', () => {
    const gpIdx = serverSrc.indexOf("pathname === '/api/career/interview/book'");
    const gpFnSrc = serverSrc.slice(gpIdx, gpIdx + 3400);
    expect(gpFnSrc).toContain("error: 'interview_cap'");
    expect(gpFnSrc).toContain('countMonthlyCareerInterviews(cbUserId');

    const atsIdx = serverSrc.indexOf("pathname === '/api/ats/interview/book'");
    const atsFnSrc = serverSrc.slice(atsIdx, atsIdx + 3600);
    expect(atsFnSrc).toContain("error: 'interview_cap'");
    expect(atsFnSrc).toContain('countMonthlyCareerInterviews(bkCtx.userId');
    expect(atsFnSrc).toMatch(/This GP has used all 3 interviews this month/);
  });

  it('js/ceo-ats-candidates.js toasts the human message before the raw error code', () => {
    const idx = candidatesSrc.indexOf('/api/ats/interview/book');
    const nearby = candidatesSrc.slice(idx, idx + 700);
    expect(nearby).toContain('(r.message || r.error)');
  });

  it('server.js declares the shared accept helper and both callers use it', () => {
    expect(serverSrc).toMatch(/async function acceptShortlistedMatchRow\(row, userId, actorEmail, profile\)/);
    expect(serverSrc).toContain('acceptShortlistedMatchRow,');
    // /api/career/match/respond's accept branch
    const respondIdx = serverSrc.indexOf("pathname === '/api/career/match/respond'");
    expect(serverSrc.indexOf('await acceptShortlistedMatchRow(mrRow, mrUserId, mrEmail, mrProfile)', respondIdx)).toBeGreaterThan(respondIdx);
    // /api/career/apply's self-apply-as-accept branch
    const applyIdx = serverSrc.indexOf("pathname === '/api/career/apply'");
    expect(serverSrc.indexOf('await acceptShortlistedMatchRow(existingAppRow, userId, email, profile)', applyIdx)).toBeGreaterThan(applyIdx);
  });

  it('POST /api/career/apply: the rate limiter is the FIRST gate (review fix), guarded only by the one-bounded-query match precheck', () => {
    const idx = serverSrc.indexOf("pathname === '/api/career/apply'");
    // Precheck: session-only userId (no DB), pure roleId parse, single
    // bounded gp_applications lookup on the UNIQUE(user_id, provider_role_id)
    // pair for a live shortlisted row, then the limiter, gated on it.
    const precheckIdx = serverSrc.indexOf('const preSessionUserId = getSessionSupabaseUserId(session);', idx);
    const precheckQueryIdx = serverSrc.indexOf('&ats_stage=eq.shortlisted&limit=1', idx);
    const rateIdx = serverSrc.indexOf('const rateLimitUserId = preSessionUserId || email;', idx);
    expect(precheckIdx).toBeGreaterThan(idx);
    expect(precheckQueryIdx).toBeGreaterThan(precheckIdx);
    expect(rateIdx).toBeGreaterThan(precheckQueryIdx);
    expect(serverSrc.slice(idx, rateIdx)).toContain('if (!applyIsMatchAccept) {');
    // The limiter runs BEFORE every other DB-hitting gate: onboarding state,
    // CV, and the role lookup all come after it.
    const onboardingIdx = serverSrc.indexOf('getSupabaseUserStateByEmail(email)', idx);
    const cvIdx = serverSrc.indexOf("getCareerProfileDocument(userId, 'career_cv')", idx);
    const roleIdx = serverSrc.indexOf('getCareerRoleRow(parsedRoleId.provider', idx);
    expect(rateIdx).toBeLessThan(onboardingIdx);
    expect(rateIdx).toBeLessThan(cvIdx);
    expect(rateIdx).toBeLessThan(roleIdx);
    // The self-apply-as-accept branch still precedes the active cap.
    const existingIdx = serverSrc.indexOf('const existingAppRow =', idx);
    const acceptIdx = serverSrc.indexOf("existingAppRow.ats_stage === 'shortlisted'", idx);
    const capIdx = serverSrc.indexOf('const activeApplicationCount = await countActiveApplications(userId);', idx);
    expect(acceptIdx).toBeGreaterThan(existingIdx);
    expect(acceptIdx).toBeLessThan(capIdx);
  });

  it('a still-shortlisted-but-expired match self-applied returns the same 410-equivalent expired hint as /match/respond', () => {
    const idx = serverSrc.indexOf("pathname === '/api/career/apply'");
    const fnSrc = serverSrc.slice(idx, idx + 9000);
    expect(fnSrc).toContain('matchIsExpired');
    expect(fnSrc).toMatch(/sendJson\(res, 410, \{\s*ok: false, expired: true,/);
  });

  it('velocity flag: threshold constant + count/flag helpers declared and exported', () => {
    expect(serverSrc).toContain('var APPLICATION_VELOCITY_THRESHOLD = 5;');
    expect(serverSrc).toMatch(/async function countApplicationsInLast24h\(userId\)/);
    expect(serverSrc).toMatch(/async function flagApplicationVelocity\(userId, count\)/);
    expect(serverSrc).toContain('state.application_velocity_flag = { count: count, at: new Date().toISOString() };');
    expect(serverSrc).toContain('countApplicationsInLast24h,');
    expect(serverSrc).toContain('flagApplicationVelocity,');
  });

  it('velocity check only runs on the new-self-apply path (not the accept branches)', () => {
    const idx = serverSrc.indexOf("pathname === '/api/career/apply'");
    const velocityIdx = serverSrc.indexOf('await countApplicationsInLast24h(userId)', idx);
    const acceptBranchEnd = serverSrc.indexOf('active-application cap', idx); // cap comment marks end of the accept branches
    expect(velocityIdx).toBeGreaterThan(acceptBranchEnd);
  });

  it('atsIntentInputFromFacts dampens recency credit for a fresh velocity flag, without touching computeIntent\'s tested signal shape', () => {
    const idx = serverSrc.indexOf('function atsIntentInputFromFacts(f)');
    const fnSrc = serverSrc.slice(idx, idx + 1400);
    expect(fnSrc).toContain('f.velocityFlagged');
    expect(fnSrc).toContain('Math.max(lastActiveDaysRaw, 15)');
  });

  it('atsCandidateListRow exposes the high_velocity chip data', () => {
    const idx = serverSrc.indexOf('function atsCandidateListRow(facts, intent)');
    const fnSrc = serverSrc.slice(idx, idx + 1000);
    expect(fnSrc).toContain('high_velocity: !!facts.velocityFlagged');
  });

  it('GET /api/ceo/candidates merges a LIVE user_state velocity read (not just the cached facts blob)', () => {
    const idx = serverSrc.indexOf("pathname === '/api/ceo/candidates' && req.method === 'GET'");
    // Window widened from 8000: the handler grew the gp_applications
    // failure-visibility block (the created_at 400 fix), pushing the velocity
    // merge past the old cut-off. Still scoped to this one handler.
    const fnSrc = serverSrc.slice(idx, idx + 10000);
    expect(fnSrc).toContain('application_velocity_flag');
    expect(fnSrc).toContain("supabaseDbRequest('user_state', 'select=user_id,state&user_id=in.(");
  });

  it('ats_stage_events gets a nullable reason column (migration), and atsRecordStageEvent stores it', () => {
    expect(migrationSql).toMatch(/ALTER TABLE ats_stage_events ADD COLUMN IF NOT EXISTS reason TEXT/);
    const idx = serverSrc.indexOf('async function atsRecordStageEvent(appId, fromStage, toStage, actor, reason)');
    expect(idx).toBeGreaterThan(-1);
    const fnSrc = serverSrc.slice(idx, idx + 400);
    expect(fnSrc).toContain('if (reason) ev.reason = String(reason).trim().slice(0, 200);');
  });

  it('PATCH /api/ats/application only accepts a WHITELISTED reason on a move INTO not_proceeding (review fix)', () => {
    expect(serverSrc).toContain("var ATS_WITHDRAW_REASON_VALUES = ['gp_withdrew', 'practice_passed', 'unresponsive', 'other'];");
    expect(serverSrc).toContain('ATS_WITHDRAW_REASON_VALUES,'); // exported for tests
    const idx = serverSrc.indexOf("pathname === '/api/ats/application' && req.method === 'PATCH'");
    const fnSrc = serverSrc.slice(idx, idx + 5400);
    expect(fnSrc).toContain("newStage === 'not_proceeding' && ATS_WITHDRAW_REASON_VALUES.indexOf(apReasonRaw) !== -1");
  });

  it('ATS book cap window comes from the REAL clock, never the bodyBK.now slot-math hook (review fix)', () => {
    const idx = serverSrc.indexOf("pathname === '/api/ats/interview/book'");
    const fnSrc = serverSrc.slice(idx, idx + 3200);
    expect(fnSrc).toContain('currentInterviewMonthWindow(new Date())');
    expect(fnSrc).not.toContain('currentInterviewMonthWindow(bkNow)');
    // The pre-existing slot-math determinism hook is untouched.
    expect(fnSrc).toContain('_bookInterviewSlot(bkRow, bkCtx, bkSlotStart, bkNow.getTime()');
  });

  it('js/ceo-ats-candidates.js: the per-application stage select gets the same withdraw-reason prompt (review fix)', () => {
    expect(candidatesSrc).toContain("{ value: 'gp_withdrew', label: 'GP withdrew after submission' }");
    expect(candidatesSrc).toMatch(/function stageNeedsWithdrawReason/);
    expect(candidatesSrc).toMatch(/function openWithdrawReasonPrompt/);
    // Select carries the FROM stage; the change handler gates on it, sends
    // the reason with the PATCH, and Cancel reverts the select (no PATCH).
    expect(candidatesSrc).toContain('data-stage-was="');
    expect(candidatesSrc).toContain("newStage === 'not_proceeding' && stageNeedsWithdrawReason(stageWas)");
    expect(candidatesSrc).toContain('if (reason) body.reason = reason;');
    expect(candidatesSrc).toContain('sel.value = stageWas;');
  });

  it('job.html has the deliberate-apply confirm sheet with the verbatim cap note + a meter line', () => {
    expect(jobHtml).toContain('id="applyConfirmOverlay"');
    expect(jobHtml).toContain("You can interview for up to 3 positions per month, so accept the roles you're genuinely serious about.");
    expect(jobHtml).toContain('id="applyConfirmMeter"');
    expect(jobHtml).toMatch(/data\.used \+ " of " \+ \(data\.limit \|\| 3\) \+ " interviews used"/);
  });

  it('job.html applyForRole opens the confirm sheet instead of POSTing directly', () => {
    const idx = jobHtml.indexOf('function applyForRole()');
    const fnSrc = jobHtml.slice(idx, idx + 900);
    expect(fnSrc).toContain('openApplyConfirm()');
    expect(fnSrc).not.toContain('fetch("/api/career/apply"');
  });

  it('job.html handles active_cap, expired, and matched:true copy', () => {
    expect(jobHtml).toContain('data.error === "active_cap"');
    expect(jobHtml).toContain('You have 3 active applications, focus on those first, or withdraw one.');
    expect(jobHtml).toContain('data && data.expired');
    expect(jobHtml).toContain('data.matched');
    expect(jobHtml).toContain("Matched! Your team has been notified you're moving forward.");
  });

  it('job.html bookOfferSlot handles interview_cap with a friendly blocked message + reset date', () => {
    const idx = jobHtml.indexOf('async function bookOfferSlot(slot)');
    const fnSrc = jobHtml.slice(idx, jobHtml.indexOf('\n  }\n', idx));
    expect(fnSrc).toContain('data.error === "interview_cap"');
    expect(fnSrc).toContain("You've used all 3 interviews this month");
  });

  it('js/ceo-ats-jobs.js has the withdraw-reason picker (incl. "GP withdrew after submission") wired into both stage-move sites', () => {
    expect(jobsSrc).toContain("{ value: 'gp_withdrew', label: 'GP withdrew after submission' }");
    expect(jobsSrc).toMatch(/function stageNeedsWithdrawReason/);
    expect(jobsSrc).toMatch(/function openWithdrawReasonPrompt/);
    // Wired into both stage-move sites: moveCard (drag) + onDrawerStageChange
    // (drawer select), the drawer's version guards `found` may be null first.
    const occurrences = jobsSrc.split("stageNeedsWithdrawReason(found.col.key)").length - 1;
    expect(occurrences).toBe(2);
    expect(jobsSrc).toMatch(/function moveCard\(id, stage\) \{[\s\S]*?stageNeedsWithdrawReason/);
    expect(jobsSrc).toMatch(/function onDrawerStageChange\(\) \{[\s\S]*?stageNeedsWithdrawReason/);
  });

  it('pages/ceo-dashboard.html loads the bumped cache busters for both touched ATS scripts', () => {
    expect(dashboardHtml).toMatch(/<script src="\/js\/ceo-ats-candidates\.js\?v=20260721[a-z]"><\/script>/);
    expect(dashboardHtml).toContain('<script src="/js/ceo-ats-jobs.js?v=20260718a"></script>');
    expect(dashboardHtml).not.toContain('ceo-ats-candidates.js?v=20260707f'); // pre-Task-7 pin superseded
    expect(dashboardHtml).not.toContain('ceo-ats-candidates.js?v=20260707g'); // pre-review-fix pin superseded
    expect(dashboardHtml).not.toContain('ceo-ats-jobs.js?v=20260707e'); // pre-Task-7 pin superseded
    expect(dashboardHtml).not.toContain('ceo-ats-jobs.js?v=20260711a'); // pre-review-screen pin superseded
  });
});

// ── Endpoint + helper behavior against a real Supabase-mode boot ───────────
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ai-matching-caps-${RUN_ID}.json`);
const SUPER_HOST = 'ats-test.local';
let server, port;
let sbServer, sbPort;
const resendCalls = [];
let realFetch;

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function userCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { host, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (host) headers.Host = host;
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

// ── In-memory PostgREST emulator (mirrors tests/ai-matching-redirect.test.js) ──
const db = {
  user_profiles: [],
  user_state: [],
  user_documents: [],
  registration_cases: [],
  ats_stage_events: [],
  career_roles: [],
  gp_applications: [],
  career_interviews: [],
  scheduled_calls: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

// Which tables the app READ (GET), in order, used to prove the rate limiter
// fires before any of the apply gates' DB reads. Tests truncate it
// (dbReadLog.length = 0) right before the request they want to inspect.
const dbReadLog = [];

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'];
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    let negate = false;
    let rest = raw;
    if (rest.startsWith('not.')) { negate = true; rest = rest.slice(4); }
    const dot = rest.indexOf('.');
    const op = dot > 0 ? rest.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue;
    const val = rest.slice(dot + 1);
    filters.push({ col: key, op, val, negate });
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
  return (row) => filters.every(({ col, op, val, negate }) => {
    const cell = row ? row[col] : undefined;
    let result;
    if (op === 'eq') result = String(cell) === val;
    else if (op === 'neq') result = String(cell) !== val;
    else if (op === 'is') result = val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    else if (op === 'in') {
      result = val.replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''))
        .includes(String(cell));
    } else if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
      if (cell === null || cell === undefined) { result = false; }
      else {
        const [a, b] = coerce(cell, val);
        if (op === 'gt') result = a > b;
        else if (op === 'gte') result = a >= b;
        else if (op === 'lt') result = a < b;
        else result = a <= b;
      }
    } else {
      result = true;
    }
    return negate ? !result : result;
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
        // Read log for the rate-limiter-is-first assertions: which tables
        // the app read, in order. Reset by tests before targeted requests.
        dbReadLog.push(decodeURIComponent(m[1]));
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
          const row = { id: r.id || crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          // Real Postgres defaults gp_applications.ats_stage to 'applied' (migration
          // 20260627100200) when an insert omits it, /api/career/apply's real
          // insert payload never sets it explicitly, so the emulator must mirror
          // that DEFAULT or the active-application-cap tests below would silently
          // under-count real self-applied rows (a fidelity gap, not a feature).
          if (m[1] === 'gp_applications' && !row.ats_stage) row.ats_stage = 'applied';
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

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'ai-matching-caps-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.CONSULTANT_EMAILS = '';
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.OPENAI_API_KEY = '';
  process.env.RESEND_API_KEY = 'test-resend-key';
  // Zoom/Google Calendar left UNCONFIGURED on purpose, createZoomInterviewMeeting
  // / gcalCreateEvent both gracefully fall back to a local fake id/join-url
  // without ever touching the network when unconfigured.

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const uStr = String(url && url.url ? url.url : url);
    if (uStr.startsWith('https://api.resend.com/')) {
      let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
      resendCalls.push({ url: uStr, body: parsed });
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
    }
    if (!/^https?:\/\/127\.0\.0\.1[:/]/.test(uStr)) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    return realFetch(url, opts);
  };

  const serverModule = await import('../server.js');
  server = serverModule.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  globalThis.fetch = realFetch;
  try { fs.unlinkSync(DB_FILE); } catch {}
});

// Seed a GP who passes every apply gate: onboarding complete, career_cv
// uploaded, Australia-trained (sidesteps the DPA gate entirely, matching the
// established pattern in tests/career-internal-apply.test.js).
function seedGp(userId, email) {
  const NOW = new Date().toISOString();
  db.user_profiles.push({ user_id: userId, email, first_name: 'Test', last_name: 'Doctor', registration_country: 'australia' });
  db.user_state.push({ user_id: userId, state: { gp_onboarding_complete: true }, updated_at: NOW });
  db.user_documents.push({ id: 'doc-cv-' + userId, user_id: userId, document_key: 'career_cv', status: 'uploaded', updated_at: NOW });
}
function seedRole(id, providerRoleId, extra) {
  db.career_roles.push(Object.assign({
    id, provider: 'internal_ats', provider_role_id: providerRoleId,
    title: 'General Practitioner, VR', practice_name: 'Test Practice ' + id,
    is_active: true, job_status: 'open', ats_created: true, updated_at: new Date().toISOString()
  }, extra || {}));
}

describe('Active-application cap (spec §9: 3 active at a time)', () => {
  it('blocks the 4th genuinely-new application once 3 are already active (409 active_cap)', async () => {
    const GP = { userId: 'u-cap-1', email: 'cap1@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    seedRole('role-cap-1', 'cap_1'); seedRole('role-cap-2', 'cap_2'); seedRole('role-cap-3', 'cap_3'); seedRole('role-cap-4', 'cap_4');

    // Three REAL applies via the endpoint, exercises the actual insert path
    // (not a pre-seeded fixture), so the cap counter sees exactly what
    // production would (including the emulator's ats_stage='applied' DEFAULT).
    for (const roleId of ['internal_ats:cap_1', 'internal_ats:cap_2', 'internal_ats:cap_3']) {
      const res = await httpReq('POST', '/api/career/apply', { cookie: userCookie(GP.email, GP.userId), body: { roleId } });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }
    expect(db.gp_applications.filter((a) => a.user_id === GP.userId).length).toBe(3);

    // A genuinely NEW 4th application (a fresh role, no prior match) is blocked.
    const blockedRes = await httpReq('POST', '/api/career/apply', { cookie: userCookie(GP.email, GP.userId), body: { roleId: 'internal_ats:cap_4' } });
    expect(blockedRes.status).toBe(409);
    expect(blockedRes.body.ok).toBe(false);
    expect(blockedRes.body.error).toBe('active_cap');
    expect(blockedRes.body.message).toMatch(/3 active applications/);
    // Nothing was inserted for the blocked attempt.
    expect(db.gp_applications.filter((a) => a.user_id === GP.userId && a.career_role_id === 'role-cap-4').length).toBe(0);
  });

  it('a live shortlisted match self-applies as accept even while the GP is already at 3 active applications', async () => {
    const GP = { userId: 'u-cap-2', email: 'cap2@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    seedRole('role-cap2-1', 'cap2_1'); seedRole('role-cap2-2', 'cap2_2'); seedRole('role-cap2-3', 'cap2_3'); seedRole('role-cap2-match', 'cap2_match');
    for (const roleId of ['internal_ats:cap2_1', 'internal_ats:cap2_2', 'internal_ats:cap2_3']) {
      const res = await httpReq('POST', '/api/career/apply', { cookie: userCookie(GP.email, GP.userId), body: { roleId } });
      expect(res.status).toBe(200);
    }
    // Now genuinely at 3 active, confirmed by the cap blocking a 4th new apply.
    seedRole('role-cap2-blocked', 'cap2_blocked');
    const preCheck = await httpReq('POST', '/api/career/apply', { cookie: userCookie(GP.email, GP.userId), body: { roleId: 'internal_ats:cap2_blocked' } });
    expect(preCheck.status).toBe(409);
    expect(preCheck.body.error).toBe('active_cap');

    // A live team match on a DIFFERENT role, must succeed regardless.
    db.gp_applications.push({
      id: 'app-cap2-match', user_id: GP.userId, career_role_id: 'role-cap2-match', provider_role_id: 'cap2_match',
      status: 'applied', ats_stage: 'shortlisted', origin: 'ai_matched', job_title: 'General Practitioner, VR',
      matched_at: new Date().toISOString(), match_expires_at: new Date(Date.now() + 5 * 86400000).toISOString()
    });
    const matchRes = await httpReq('POST', '/api/career/apply', { cookie: userCookie(GP.email, GP.userId), body: { roleId: 'internal_ats:cap2_match' } });
    expect(matchRes.status).toBe(200);
    expect(matchRes.body.ok).toBe(true);
    expect(matchRes.body.matched).toBe(true);
    const matchedRow = db.gp_applications.find((a) => a.id === 'app-cap2-match');
    expect(matchedRow.ats_stage).toBe('applied');
    expect(matchedRow.match_outcome).toBe('accepted');
    // No extra row was created for the accept, still exactly 4 rows total
    // (3 applied + the 1 pre-existing match row, now accepted in place).
    expect(db.gp_applications.filter((a) => a.user_id === GP.userId).length).toBe(4);
  });
});

describe('Self-apply-as-accept (spec §7)', () => {
  it('an existing live shortlisted row: no new row created, stage -> applied, matched:true, submission task + ops email fired', async () => {
    const GP = { userId: 'u-selfaccept-1', email: 'selfaccept1@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    seedRole('role-sa-1', 'sa_1');
    db.gp_applications.push({
      id: 'app-sa-1', user_id: GP.userId, career_role_id: 'role-sa-1', provider_role_id: 'sa_1',
      status: 'applied', ats_stage: 'shortlisted', origin: 'ai_matched', job_title: 'General Practitioner, VR',
      matched_at: new Date().toISOString(), match_expires_at: new Date(Date.now() + 5 * 86400000).toISOString()
    });

    const before = resendCalls.length;
    const res = await httpReq('POST', '/api/career/apply', { cookie: userCookie(GP.email, GP.userId), body: { roleId: 'internal_ats:sa_1' } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.matched).toBe(true);
    expect(res.body.application.ats_stage).toBe('applied');

    const rows = db.gp_applications.filter((a) => a.user_id === GP.userId);
    expect(rows.length).toBe(1); // no duplicate row
    expect(rows[0].ats_stage).toBe('applied');
    expect(rows[0].match_outcome).toBe('accepted');
    expect(rows[0].submission_task_id).toBeTruthy(); // shared submission-task side effect ran

    const matchAcceptedEmail = resendCalls.slice(before).find((c) => c.body && /Match accepted/i.test(c.body.subject || ''));
    expect(matchAcceptedEmail).toBeTruthy();
  });

  it('does NOT consume the main apply rate limiter (11 accepts succeed even though APPLY_RATE_MAX is 10)', async () => {
    const GP = { userId: 'u-selfaccept-rate-1', email: 'selfaccept-rate1@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    for (let i = 1; i <= 11; i++) {
      seedRole('role-sa-rate-' + i, 'sa_rate_' + i);
      db.gp_applications.push({
        id: 'app-sa-rate-' + i, user_id: GP.userId, career_role_id: 'role-sa-rate-' + i, provider_role_id: 'sa_rate_' + i,
        status: 'applied', ats_stage: 'shortlisted', origin: 'ai_matched', job_title: 'General Practitioner, VR',
        matched_at: new Date().toISOString(), match_expires_at: new Date(Date.now() + 5 * 86400000).toISOString()
      });
    }
    for (let i = 1; i <= 11; i++) {
      const res = await httpReq('POST', '/api/career/apply', { cookie: userCookie(GP.email, GP.userId), body: { roleId: 'internal_ats:sa_rate_' + i } });
      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(true);
    }
  });

  it('review fix: a burst of garbage applies hits 429 as a rate-limit (not role_not_found), with ONLY the bounded precheck read', async () => {
    const GP = { userId: 'u-burst-1', email: 'burst1@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    // 10 applies to NONEXISTENT roles, each passes the limiter (consuming a
    // slot) and then 404s at the role lookup, exactly like main.
    for (let i = 1; i <= 10; i++) {
      const res = await httpReq('POST', '/api/career/apply', { cookie: userCookie(GP.email, GP.userId), body: { roleId: 'internal_ats:garbage_' + i } });
      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/Role not found/i);
    }
    // Let any stray fire-and-forget reads from earlier tests settle, then
    // inspect exactly what the 11th (throttled) request reads.
    await new Promise((r) => setTimeout(r, 100));
    dbReadLog.length = 0;
    const throttled = await httpReq('POST', '/api/career/apply', { cookie: userCookie(GP.email, GP.userId), body: { roleId: 'internal_ats:garbage_11' } });
    expect(throttled.status).toBe(429);
    expect(throttled.body.message).toMatch(/Too many applications/i);
    // Zero unthrottled gate reads: the ONLY read is the single bounded
    // gp_applications precheck, never career_roles / user_state /
    // user_profiles / user_documents.
    expect(dbReadLog).toEqual(['gp_applications']);
  });

  it('a still-shortlisted-but-past-expiry row (cron has not swept it yet) returns the expired hint, not an accept', async () => {
    const GP = { userId: 'u-expired-1', email: 'expired1@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    seedRole('role-exp-1', 'exp_1');
    db.gp_applications.push({
      id: 'app-exp-1', user_id: GP.userId, career_role_id: 'role-exp-1', provider_role_id: 'exp_1',
      status: 'applied', ats_stage: 'shortlisted', origin: 'ai_matched', job_title: 'General Practitioner, VR',
      matched_at: new Date(Date.now() - 6 * 86400000).toISOString(),
      match_expires_at: new Date(Date.now() - 1 * 86400000).toISOString() // 1 day in the past
    });

    const before = resendCalls.length;
    const res = await httpReq('POST', '/api/career/apply', { cookie: userCookie(GP.email, GP.userId), body: { roleId: 'internal_ats:exp_1' } });
    expect(res.status).toBe(410);
    expect(res.body.ok).toBe(false);
    expect(res.body.expired).toBe(true);
    expect(res.body.message).toMatch(/expired/i);

    const row = db.gp_applications.find((a) => a.id === 'app-exp-1');
    expect(row.ats_stage).toBe('shortlisted'); // untouched, no accept happened
    expect(row.match_outcome == null).toBe(true);

    const stillInterestedEmail = resendCalls.slice(before).find((c) => c.body && /still interested/i.test(c.body.subject || ''));
    expect(stillInterestedEmail).toBeTruthy();
  });

  it('POST /api/career/match/respond accept still works via the extracted shared helper (regression)', async () => {
    const GP = { userId: 'u-respond-regress-1', email: 'respond-regress1@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    seedRole('role-rr-1', 'rr_1');
    db.gp_applications.push({
      id: 'app-rr-1', user_id: GP.userId, career_role_id: 'role-rr-1', provider_role_id: 'rr_1',
      status: 'applied', ats_stage: 'shortlisted', origin: 'ai_matched', job_title: 'General Practitioner, VR',
      matched_at: new Date().toISOString(), match_expires_at: new Date(Date.now() + 5 * 86400000).toISOString()
    });
    const res = await httpReq('POST', '/api/career/match/respond', {
      cookie: userCookie(GP.email, GP.userId), body: { applicationId: 'app-rr-1', action: 'accept' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.action).toBe('accept');
    const row = db.gp_applications.find((a) => a.id === 'app-rr-1');
    expect(row.ats_stage).toBe('applied');
    expect(row.match_outcome).toBe('accepted');
  });
});

describe('Interview cap (spec §9: 3/calendar month, merged count)', () => {
  it('GET /api/career/interview-usage counts the merged set (career_interviews + booked/completed scheduled_calls)', async () => {
    const GP = { userId: 'u-usage-1', email: 'usage1@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    const now = new Date();
    const midMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 12, 0, 0)).toISOString();
    db.career_interviews.push(
      { id: 'ci-usage-1', user_id: GP.userId, status: 'scheduled', scheduled_at: midMonth },
      { id: 'ci-usage-2', user_id: GP.userId, status: 'completed', scheduled_at: midMonth },
      { id: 'ci-usage-cancelled', user_id: GP.userId, status: 'cancelled', scheduled_at: midMonth } // must NOT count
    );
    db.scheduled_calls.push(
      { id: 'sc-usage-1', user_id: GP.userId, meeting_kind: 'interview', status: 'booked', scheduled_at: midMonth },
      { id: 'sc-usage-invited', user_id: GP.userId, meeting_kind: 'interview', status: 'invited', scheduled_at: midMonth } // no slot chosen, must NOT count
    );
    const res = await httpReq('GET', '/api/career/interview-usage', { cookie: userCookie(GP.email, GP.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.used).toBe(3); // 2 career_interviews + 1 booked scheduled_calls
    expect(res.body.limit).toBe(3);
    expect(res.body.resetsAt).toBeTruthy();
  });

  it('month-boundary math via the shared helper: last instant of the previous month excluded, first instant of next month excluded', async () => {
    const { countMonthlyCareerInterviews, currentInterviewMonthWindow } = (await import('../server.js')).__testUtils;
    const GP_USER = 'u-boundary-1';
    const window = currentInterviewMonthWindow(new Date());
    const justBefore = new Date(window.start.getTime() - 1000).toISOString(); // last second of prev month
    const atStart = window.start.toISOString(); // first instant of this month, included
    const justAfterEnd = window.end.toISOString(); // first instant of next month, excluded (lt, not lte)
    const lastInstantOfMonth = new Date(window.end.getTime() - 1000).toISOString(); // included
    db.career_interviews.push(
      { id: 'ci-b-before', user_id: GP_USER, status: 'scheduled', scheduled_at: justBefore },
      { id: 'ci-b-start', user_id: GP_USER, status: 'scheduled', scheduled_at: atStart },
      { id: 'ci-b-end', user_id: GP_USER, status: 'scheduled', scheduled_at: justAfterEnd },
      { id: 'ci-b-last', user_id: GP_USER, status: 'confirmed', scheduled_at: lastInstantOfMonth }
    );
    const count = await countMonthlyCareerInterviews(GP_USER, window.start, window.end);
    expect(count).toBe(2); // atStart + lastInstantOfMonth only
  });

  it('both interview-book endpoints 409 with error:interview_cap + resetsAt once the GP already has 3 this month', async () => {
    const GP = { userId: 'u-ivcap-1', email: 'ivcap1@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    const now = new Date();
    const midMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 10, 9, 0, 0)).toISOString();
    db.career_interviews.push(
      { id: 'ci-cap-1', user_id: GP.userId, status: 'scheduled', scheduled_at: midMonth },
      { id: 'ci-cap-2', user_id: GP.userId, status: 'confirmed', scheduled_at: midMonth },
      { id: 'ci-cap-3', user_id: GP.userId, status: 'completed', scheduled_at: midMonth }
    );

    // GP-side: needs a revealed application + a live (invited) interview row
    // so it reaches the cap check, not an earlier 404/403 guard.
    seedRole('role-ivcap-1', 'ivcap_1');
    db.gp_applications.push({
      id: 'app-ivcap-1', user_id: GP.userId, career_role_id: 'role-ivcap-1', provider_role_id: 'ivcap_1',
      status: 'applied', ats_stage: 'interview', revealed: true, job_title: 'General Practitioner, VR'
    });
    db.scheduled_calls.push({ id: 'sc-ivcap-gp', user_id: GP.userId, application_id: 'app-ivcap-1', meeting_kind: 'interview', status: 'invited' });
    const gpRes = await httpReq('POST', '/api/career/interview/book', {
      cookie: userCookie(GP.email, GP.userId),
      body: { applicationId: 'app-ivcap-1', slot_start_utc: new Date(Date.now() + 86400000).toISOString() }
    });
    expect(gpRes.status).toBe(409);
    expect(gpRes.body.ok).toBe(false);
    expect(gpRes.body.error).toBe('interview_cap');
    expect(gpRes.body.resetsAt).toBeTruthy();
    // The row must NOT have been booked.
    const gpScRow = db.scheduled_calls.find((r) => r.id === 'sc-ivcap-gp');
    expect(gpScRow.status).toBe('invited');

    // ATS-side: a second application for the same over-cap GP.
    seedRole('role-ivcap-2', 'ivcap_2');
    db.gp_applications.push({
      id: 'app-ivcap-2', user_id: GP.userId, career_role_id: 'role-ivcap-2', provider_role_id: 'ivcap_2',
      status: 'applied', ats_stage: 'interview', job_title: 'General Practitioner, VR'
    });
    db.scheduled_calls.push({ id: 'sc-ivcap-ats', user_id: GP.userId, application_id: 'app-ivcap-2', meeting_kind: 'interview', status: 'invited' });
    const atsRes = await httpReq('POST', '/api/ats/interview/book', {
      host: SUPER_HOST, cookie: superCookie(),
      body: { application_id: 'app-ivcap-2', slot_start_utc: new Date(Date.now() + 86400000).toISOString() }
    });
    expect(atsRes.status).toBe(409);
    expect(atsRes.body.ok).toBe(false);
    expect(atsRes.body.error).toBe('interview_cap');
    expect(atsRes.body.message).toMatch(/This GP has used all 3 interviews this month/);
    expect(atsRes.body.resetsAt).toBeTruthy();
    const atsScRow = db.scheduled_calls.find((r) => r.id === 'sc-ivcap-ats');
    expect(atsScRow.status).toBe('invited');
  });

  it("review fix: the ATS book cap ignores body.now, a spoofed next-month `now` can't dodge this month's cap", async () => {
    const GP = { userId: 'u-ivcap-spoof-1', email: 'ivcap-spoof1@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    const now = new Date();
    // 3 interviews in the CURRENT REAL month → the GP is at cap right now.
    const midMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 12, 9, 0, 0)).toISOString();
    db.career_interviews.push(
      { id: 'ci-spoof-1', user_id: GP.userId, status: 'scheduled', scheduled_at: midMonth },
      { id: 'ci-spoof-2', user_id: GP.userId, status: 'confirmed', scheduled_at: midMonth },
      { id: 'ci-spoof-3', user_id: GP.userId, status: 'completed', scheduled_at: midMonth }
    );
    seedRole('role-ivcap-spoof', 'ivcap_spoof');
    db.gp_applications.push({
      id: 'app-ivcap-spoof', user_id: GP.userId, career_role_id: 'role-ivcap-spoof', provider_role_id: 'ivcap_spoof',
      status: 'applied', ats_stage: 'interview', job_title: 'General Practitioner, VR'
    });
    db.scheduled_calls.push({ id: 'sc-ivcap-spoof', user_id: GP.userId, application_id: 'app-ivcap-spoof', meeting_kind: 'interview', status: 'invited' });
    // Spoof `now` into NEXT month, if the cap window (wrongly) followed
    // bodyBK.now, the count would be 0 and the request would sail past the
    // cap into the slot machinery instead of 409ing with interview_cap.
    const spoofedNow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 5, 9, 0, 0)).toISOString();
    const res = await httpReq('POST', '/api/ats/interview/book', {
      host: SUPER_HOST, cookie: superCookie(),
      body: { application_id: 'app-ivcap-spoof', slot_start_utc: new Date(Date.now() + 86400000).toISOString(), now: spoofedNow }
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('interview_cap');
    const scRow = db.scheduled_calls.find((r) => r.id === 'sc-ivcap-spoof');
    expect(scRow.status).toBe('invited'); // never booked
  });
});

describe('Velocity flag (spec §9: 5+ applies/24h)', () => {
  it('is NOT written at 4 applies in 24h, IS written at the 5th (count + at), and never on the accept path', async () => {
    const GP = { userId: 'u-velocity-1', email: 'velocity1@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    // 3 pre-existing NOT-active (not_proceeding) applications, seeded directly
    // (not via the endpoint) so they count towards the 24h velocity window
    // (which counts ALL applied_at rows, any stage) WITHOUT tripping the
    // separate active-application cap (3 active at a time), this test is
    // isolating the velocity signal, not the cap interaction.
    const recentIso = new Date().toISOString();
    for (let i = 1; i <= 3; i++) {
      seedRole('role-vel-old-' + i, 'vel_old_' + i);
      db.gp_applications.push({
        id: 'app-vel-old-' + i, user_id: GP.userId, career_role_id: 'role-vel-old-' + i, provider_role_id: 'vel_old_' + i,
        status: 'not_proceeding', ats_stage: 'not_proceeding', applied_at: recentIso
      });
    }
    seedRole('role-vel-4', 'vel_4');
    seedRole('role-vel-5', 'vel_5');

    // 4th applied_at-recent row overall (1st genuinely NEW/active one), still under 5.
    const fourthRes = await httpReq('POST', '/api/career/apply', { cookie: userCookie(GP.email, GP.userId), body: { roleId: 'internal_ats:vel_4' } });
    expect(fourthRes.status).toBe(200);
    let stateRow = db.user_state.find((s) => s.user_id === GP.userId);
    expect(stateRow.state.application_velocity_flag).toBeUndefined();

    // 5th applied_at-recent row overall, trips the flag.
    const fifthRes = await httpReq('POST', '/api/career/apply', { cookie: userCookie(GP.email, GP.userId), body: { roleId: 'internal_ats:vel_5' } });
    expect(fifthRes.status).toBe(200);
    stateRow = db.user_state.find((s) => s.user_id === GP.userId);
    expect(stateRow.state.application_velocity_flag).toBeTruthy();
    expect(stateRow.state.application_velocity_flag.count).toBe(5);
    expect(stateRow.state.application_velocity_flag.at).toBeTruthy();
  });

  it('surfaces as high_velocity + velocity_flag in GET /api/ceo/candidates, and clears once older than 7 days', async () => {
    const GP = { userId: 'u-velocity-chip-1', email: 'velocity-chip1@gplink-test.local' };
    seedGp(GP.userId, GP.email);
    seedRole('role-vc-1', 'vc_1');
    // A registration_cases row is what actually makes a GP appear in the
    // prod-mode /api/ceo/candidates list (it iterates cases, not applications).
    db.registration_cases.push({ id: 'case-vc-1', user_id: GP.userId, stage: 'career', status: 'active' });
    db.gp_applications.push({ id: 'app-vc-1', user_id: GP.userId, career_role_id: 'role-vc-1', provider_role_id: 'vc_1', status: 'applied', ats_stage: 'applied' });
    db.user_state.find((s) => s.user_id === GP.userId).state.application_velocity_flag = { count: 6, at: new Date().toISOString() };

    const res = await httpReq('GET', '/api/ceo/candidates', { host: SUPER_HOST, cookie: superCookie() });
    expect(res.status).toBe(200);
    const row = res.body.candidates.find((c) => c.user_id === GP.userId);
    expect(row).toBeTruthy();
    expect(row.high_velocity).toBe(true);
    expect(row.velocity_flag).toBeTruthy();
    expect(row.velocity_flag.count).toBe(6);

    // Now age the flag past the 7-day display window.
    db.user_state.find((s) => s.user_id === GP.userId).state.application_velocity_flag = { count: 6, at: new Date(Date.now() - 8 * 86400000).toISOString() };
    const staleRes = await httpReq('GET', '/api/ceo/candidates', { host: SUPER_HOST, cookie: superCookie() });
    const staleRow = staleRes.body.candidates.find((c) => c.user_id === GP.userId);
    expect(staleRow.high_velocity).toBe(false);
    expect(staleRow.velocity_flag).toBeNull();
  });

  it('atsIntentInputFromFacts dips the recency signal only when velocityFlagged is true', async () => {
    const { atsIntentInputFromFacts } = (await import('../server.js')).__testUtils;
    const flagged = atsIntentInputFromFacts({ lastActiveDays: 1, velocityFlagged: true });
    const unflagged = atsIntentInputFromFacts({ lastActiveDays: 1, velocityFlagged: false });
    expect(unflagged.lastActiveDays).toBe(1);
    expect(flagged.lastActiveDays).toBe(15); // floored, not a full new weighted signal
    // Never dips BELOW an already-worse (higher) lastActiveDays value.
    const alreadyStale = atsIntentInputFromFacts({ lastActiveDays: 40, velocityFlagged: true });
    expect(alreadyStale.lastActiveDays).toBe(40);
  });
});

describe('Withdraw-reason stage events (Task 8 strike-source data)', () => {
  it('stores the reason on the stage event when moving to not_proceeding from submitted+', async () => {
    seedRole('role-wd-1', 'wd_1');
    db.gp_applications.push({
      id: 'app-wd-1', user_id: 'u-wd-1', career_role_id: 'role-wd-1', provider_role_id: 'wd_1',
      status: 'submitted_to_practice', ats_stage: 'submitted', job_title: 'General Practitioner, VR'
    });
    const res = await httpReq('PATCH', '/api/ats/application?id=app-wd-1', {
      host: SUPER_HOST, cookie: superCookie(), body: { stage: 'not_proceeding', reason: 'gp_withdrew' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const event = db.ats_stage_events.find((e) => String(e.application_id) === 'app-wd-1' && e.to_stage === 'not_proceeding');
    expect(event).toBeTruthy();
    expect(event.reason).toBe('gp_withdrew');
  });

  it('ignores a reason sent on a move to any stage OTHER than not_proceeding', async () => {
    seedRole('role-wd-2', 'wd_2');
    db.gp_applications.push({
      id: 'app-wd-2', user_id: 'u-wd-2', career_role_id: 'role-wd-2', provider_role_id: 'wd_2',
      status: 'applied', ats_stage: 'applied', job_title: 'General Practitioner, VR'
    });
    const res = await httpReq('PATCH', '/api/ats/application?id=app-wd-2', {
      host: SUPER_HOST, cookie: superCookie(), body: { stage: 'interview', reason: 'gp_withdrew' }
    });
    expect(res.status).toBe(200);
    const event = db.ats_stage_events.find((e) => String(e.application_id) === 'app-wd-2' && e.to_stage === 'interview');
    expect(event).toBeTruthy();
    expect(event.reason == null).toBe(true);
  });

  it('review fix: a NON-whitelisted reason is silently dropped (stage move still succeeds, reason stored null)', async () => {
    seedRole('role-wd-3', 'wd_3');
    db.gp_applications.push({
      id: 'app-wd-3', user_id: 'u-wd-3', career_role_id: 'role-wd-3', provider_role_id: 'wd_3',
      status: 'submitted_to_practice', ats_stage: 'submitted', job_title: 'General Practitioner, VR'
    });
    // A free-text lookalike that would dilute Task 8's exact-match query.
    const res = await httpReq('PATCH', '/api/ats/application?id=app-wd-3', {
      host: SUPER_HOST, cookie: superCookie(), body: { stage: 'not_proceeding', reason: 'GP Withdrew (chatty free text)' }
    });
    expect(res.status).toBe(200); // never a 400, the move itself is fine
    expect(res.body.ok).toBe(true);
    const row = db.gp_applications.find((a) => a.id === 'app-wd-3');
    expect(row.ats_stage).toBe('not_proceeding');
    const event = db.ats_stage_events.find((e) => String(e.application_id) === 'app-wd-3' && e.to_stage === 'not_proceeding');
    expect(event).toBeTruthy();
    expect(event.reason == null).toBe(true);
  });

  it('review fix: every whitelisted reason value round-trips onto the event verbatim', async () => {
    const { ATS_WITHDRAW_REASON_VALUES } = (await import('../server.js')).__testUtils;
    expect(ATS_WITHDRAW_REASON_VALUES).toEqual(['gp_withdrew', 'practice_passed', 'unresponsive', 'other']);
    for (let i = 0; i < ATS_WITHDRAW_REASON_VALUES.length; i++) {
      const reason = ATS_WITHDRAW_REASON_VALUES[i];
      const appId = 'app-wd-wl-' + i;
      seedRole('role-wd-wl-' + i, 'wd_wl_' + i);
      db.gp_applications.push({
        id: appId, user_id: 'u-wd-wl-' + i, career_role_id: 'role-wd-wl-' + i, provider_role_id: 'wd_wl_' + i,
        status: 'submitted_to_practice', ats_stage: 'reviewing', job_title: 'General Practitioner, VR'
      });
      const res = await httpReq('PATCH', '/api/ats/application?id=' + appId, {
        host: SUPER_HOST, cookie: superCookie(), body: { stage: 'not_proceeding', reason }
      });
      expect(res.status).toBe(200);
      const event = db.ats_stage_events.find((e) => String(e.application_id) === appId && e.to_stage === 'not_proceeding');
      expect(event && event.reason).toBe(reason);
    }
  });
});

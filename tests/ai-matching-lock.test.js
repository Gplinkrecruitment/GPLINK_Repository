// Task 8 (AI Matching, 2026-07-06 plan) — 3-strike career lock: strikes,
// automatic lock, server enforcement, the lock page's data endpoints, and
// admin release/restore-intent.
//
// Boots the real server against a tiny in-memory PostgREST emulator (same
// pattern as tests/ai-matching-caps.test.js / tests/ai-matching-cron.test.js),
// so the FULL Supabase-mode code path runs for real.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Source wiring (no server boot needed) ───────────────────────────────────
describe('AI Matching Task 8 — source wiring', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const lockPageHtml = fs.readFileSync(path.join(ROOT, 'pages/career-paused.html'), 'utf8');
  const careerHtml = fs.readFileSync(path.join(ROOT, 'pages/career.html'), 'utf8');
  const jobHtml = fs.readFileSync(path.join(ROOT, 'pages/job.html'), 'utf8');
  const dashboardHtml = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');
  const candidatesSrc = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-candidates.js'), 'utf8');

  it('declares the core lock helpers and exports them for testing', () => {
    expect(serverSrc).toMatch(/function isCareerLocked\(careerLock\)/);
    expect(serverSrc).toMatch(/async function computeCareerStrikes\(userId, opts\)/);
    expect(serverSrc).toMatch(/async function evaluateCareerLocks\(deadlineTs, onlyUserId\)/);
    expect(serverSrc).toMatch(/function buildCareerLockAdminView\(careerLock\)/);
    expect(serverSrc).toContain('  isCareerLocked,');
    expect(serverSrc).toContain('  computeCareerStrikes,');
    expect(serverSrc).toContain('  evaluateCareerLocks,');
    expect(serverSrc).toContain('  buildCareerLockAdminView,');
  });

  it('423s the five locked-enforcement endpoints and never account_status', () => {
    expect(serverSrc).toMatch(/pathname === '\/api\/career\/roles'[\s\S]{0,900}isCareerLocked\(_gpRolesState\.career_lock\)/);
    expect(serverSrc).toMatch(/pathname === '\/api\/career\/apply'[\s\S]{0,3500}isCareerLocked\(userState\.career_lock\)/);
    expect(serverSrc).toMatch(/mrAction === 'accept' && isCareerLocked\(mrState\.career_lock\)/);
    expect(serverSrc).toMatch(/pathname === '\/api\/career\/match\/still-interested'[\s\S]{0,2000}isCareerLocked\(siState\.career_lock\)/);
    expect(serverSrc).toMatch(/pathname === '\/api\/career\/interview\/book'[\s\S]{0,900}isCareerLocked\(cbState\.career_lock\)/);
  });

  it('GET /api/career/matches returns the lock payload before the account-gate branch', () => {
    expect(serverSrc).toMatch(/isCareerLocked\(mmCareerLock\)[\s\S]{0,400}locked: true,\s*\n\s*strikes: mmCareerLock\.strikes/);
  });

  it('new lock endpoints exist: lock\\/answers, lock\\/booking-url, release, restore-intent', () => {
    expect(serverSrc).toContain("pathname === '/api/career/lock/answers'");
    expect(serverSrc).toContain("pathname === '/api/career/lock/booking-url'");
    expect(serverSrc).toContain("pathname === '/api/ats/career-lock/release'");
    expect(serverSrc).toContain("pathname === '/api/ats/career-lock/restore-intent'");
    expect(serverSrc).toMatch(/career-lock\/release[\s\S]{0,200}requireAtsSession/);
    expect(serverSrc).toMatch(/career-lock\/restore-intent[\s\S]{0,200}requireAtsSession/);
  });

  it('the interview-completion PATCH handler evaluates career locks for that GP', () => {
    expect(serverSrc).toMatch(/patch\.status === 'completed'\)[\s\S]{0,500}evaluateCareerLocks\(Date\.now\(\) \+ 15000, completedInterviewRow\.user_id\)/);
  });

  it('atsBuildGpMatchInputs reads the real career_lock via the shared isCareerLocked helper', () => {
    expect(serverSrc).toMatch(/var careerLocked = isCareerLocked\(careerLock\);/);
  });

  it('review fix: BOTH generic recompute paths store via the lock-preserving helper, and restore-intent clears intent_halved_at', () => {
    expect(serverSrc).toMatch(/async function atsStoreIntentPreservingCareerLock\(facts, intent\)/);
    // Nightly cron loop no longer calls atsStoreIntentForCase directly.
    const cronIdx = serverSrc.indexOf("pathname === '/api/cron/recompute-intent'");
    const cronSrc = serverSrc.slice(cronIdx, cronIdx + 2200);
    expect(cronSrc).toContain('atsStoreIntentPreservingCareerLock(cf, atsComputeIntent(cf))');
    expect(cronSrc).not.toContain('await atsStoreIntentForCase(cf.case_id');
    // Manual Recompute button path likewise, and it surfaces career_lock_halved.
    const riIdx = serverSrc.indexOf("pathname === '/api/ceo/candidate/recompute-intent'");
    const riSrc = serverSrc.slice(riIdx, riIdx + 2500);
    expect(riSrc).toContain('atsStoreIntentPreservingCareerLock(riFacts, riIntent)');
    expect(riSrc).toContain('career_lock_halved');
    // restore-intent stands the guard down (durable restore).
    const restoreIdx = serverSrc.indexOf("pathname === '/api/ats/career-lock/restore-intent'");
    const restoreSrc = serverSrc.slice(restoreIdx, restoreIdx + 3200);
    expect(restoreSrc).toContain('restoreLock.intent_halved_at = null');
    expect(restoreSrc).toContain('restoreLock.pre_lock_intent_score = null');
  });

  it('career-paused.html has the exact spec copy and no forbidden words', () => {
    expect(lockPageHtml).toContain("Let's talk before your next interview");
    expect(lockPageHtml).toContain('Book a call');
    expect(lockPageHtml).toContain('Applications stay paused until this conversation happens.');
    expect(lockPageHtml).toMatch(/auth-guard\.js\?v=/);
    expect(lockPageHtml).not.toMatch(/zoom/i);
    expect(lockPageHtml).not.toMatch(/\bceo\b/i);
  });

  it('career-paused.html boots off GET /api/career/matches and redirects non-locked GPs away', () => {
    expect(lockPageHtml).toContain('/api/career/matches');
    expect(lockPageHtml).toMatch(/data\.locked !== true[\s\S]{0,100}window\.location\.replace\("\/pages\/career"\)/);
    expect(lockPageHtml).toContain('/api/career/lock/answers');
    expect(lockPageHtml).toContain('/api/career/lock/booking-url');
  });

  it('career.html and job.html redirect to /pages/career-paused on locked:true', () => {
    expect(careerHtml).toMatch(/data\.locked === true\)[\s\S]{0,100}window\.location\.replace\("\/pages\/career-paused"\)/);
    expect(jobHtml).toMatch(/data\.locked === true\)[\s\S]{0,100}window\.location\.replace\("\/pages\/career-paused"\)/);
  });

  it('js/ceo-ats-candidates.js renders the Interviews & strikes card + release/restore-intent actions', () => {
    expect(candidatesSrc).toMatch(/function strikesCardInner\(c\)/);
    expect(candidatesSrc).toContain('CAREER LOCKED');
    expect(candidatesSrc).toContain('STRIKES ');
    expect(candidatesSrc).toContain('DID NOT PROCEED');
    expect(candidatesSrc).toContain('Not provided yet');
    expect(candidatesSrc).toContain('/api/ats/career-lock/release');
    expect(candidatesSrc).toContain('/api/ats/career-lock/restore-intent');
    expect(candidatesSrc).toContain('(−50% on lock)');
  });

  it('pages/ceo-dashboard.html carries the bumped cache buster for ceo-ats-candidates.js', () => {
    expect(dashboardHtml).toMatch(/<script src="\/js\/ceo-ats-candidates\.js\?v=20260721[a-z]"><\/script>/);
    expect(dashboardHtml).not.toContain('ceo-ats-candidates.js?v=20260707h'); // pre-Task-8 pin superseded
  });
});

// ── Endpoint + helper behavior against a real Supabase-mode boot ───────────
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ai-matching-lock-${RUN_ID}.json`);
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
function adminCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'admin@gplink-test.local', adminRole: 'admin' }, expiresAt: Date.now() + 3600000 }));
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

// ── In-memory PostgREST emulator (mirrors tests/ai-matching-caps.test.js) ──
const db = {
  user_profiles: [],
  user_state: [],
  user_documents: [],
  registration_cases: [],
  ats_stage_events: [],
  career_roles: [],
  gp_applications: [],
  career_interviews: [],
  scheduled_calls: [],
  rso_team: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

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
      const orderParam = u.searchParams.get('order') || '';

      if (req.method === 'GET') {
        let out = rows.filter(matches);
        if (orderParam.startsWith('ats_stage_updated_at')) {
          out = out.slice().sort((a, b) => new Date(b.ats_stage_updated_at || 0) - new Date(a.ats_stage_updated_at || 0));
        }
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

let testUtils;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'ai-matching-lock-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = 'admin@gplink-test.local';
  process.env.CONSULTANT_EMAILS = '';
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.OPENAI_API_KEY = '';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.CALENDLY_EVENT_URL = 'https://calendly.com/gplink-team/career-call';
  process.env.CRON_SECRET = 'lock-cron-secret-' + RUN_ID;

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
  testUtils = serverModule.__testUtils;
  server = serverModule.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  globalThis.fetch = realFetch;
  try { fs.unlinkSync(DB_FILE); } catch {}
});

let seq = 0;
function uid() { seq += 1; return 'u-lock-' + seq + '-' + RUN_ID; }

function seedGp(userId, email, extra) {
  const NOW = new Date().toISOString();
  db.user_profiles.push({ user_id: userId, email, first_name: 'Test', last_name: 'Doctor', registration_country: 'australia' });
  db.user_state.push({ user_id: userId, state: Object.assign({ gp_onboarding_complete: true }, extra || {}), updated_at: NOW });
  db.registration_cases.push({
    id: 'case-' + userId, user_id: userId, stage: 'ahpra', status: 'active',
    assigned_rso: null, assigned_va: null, intent_score: 55, intent_band: 'warm',
    ai_handover_summary: '', comms_engagement: null,
    blocker_status: false, blocker_set_at: null, last_gp_activity_at: NOW
  });
}

function seedRole(id, extra) {
  db.career_roles.push(Object.assign({
    id, provider: 'internal_ats', provider_role_id: id,
    title: 'General Practitioner — VR', practice_name: 'Test Practice ' + id,
    location_city: 'Bundaberg', location_state: 'QLD',
    is_active: true, job_status: 'open'
  }, extra || {}));
}

// A "strike-eligible" not_proceeding application with a completed interview.
function seedInterviewStrike(userId, roleId, whenIso) {
  seedRole(roleId);
  const appId = 'app-' + roleId;
  db.gp_applications.push({
    id: appId, user_id: userId, career_role_id: roleId,
    ats_stage: 'not_proceeding', match_outcome: 'declined',
    ats_stage_updated_at: whenIso, updated_at: whenIso
  });
  db.career_interviews.push({
    id: 'iv-' + roleId, application_id: appId, user_id: userId,
    status: 'completed', scheduled_at: whenIso, updated_at: whenIso
  });
  return appId;
}

// A late-withdrawal strike (no interview, just the withdraw event).
function seedWithdrawStrike(userId, roleId, whenIso) {
  seedRole(roleId);
  const appId = 'app-' + roleId;
  db.gp_applications.push({
    id: appId, user_id: userId, career_role_id: roleId,
    ats_stage: 'not_proceeding', ats_stage_updated_at: whenIso, updated_at: whenIso
  });
  db.ats_stage_events.push({
    id: 'ev-' + roleId, application_id: appId, from_stage: 'submitted', to_stage: 'not_proceeding',
    actor: userId, reason: 'gp_withdrew', created_at: whenIso
  });
  return appId;
}

// Review fix (FIX 1): a completed interview whose application ended
// not_proceeding because the PRACTICE filled the role with someone else
// (Task 6's redirect fan-out sets match_outcome='position_filled') — not a
// strike, even though the interview itself completed.
function seedInterviewPositionFilled(userId, roleId, whenIso) {
  seedRole(roleId);
  const appId = 'app-' + roleId;
  db.gp_applications.push({
    id: appId, user_id: userId, career_role_id: roleId,
    ats_stage: 'not_proceeding', match_outcome: 'position_filled',
    ats_stage_updated_at: whenIso, updated_at: whenIso
  });
  db.career_interviews.push({
    id: 'iv-' + roleId, application_id: appId, user_id: userId,
    status: 'completed', scheduled_at: whenIso, updated_at: whenIso
  });
  return appId;
}

// Review fix (FIX 1): a completed interview whose application ended
// not_proceeding with NO match_outcome at all, but staff recorded the
// PRACTICE's own decision via reason='practice_passed' on the stage event —
// not a strike.
function seedInterviewPracticePassed(userId, roleId, whenIso) {
  seedRole(roleId);
  const appId = 'app-' + roleId;
  db.gp_applications.push({
    id: appId, user_id: userId, career_role_id: roleId,
    ats_stage: 'not_proceeding', ats_stage_updated_at: whenIso, updated_at: whenIso
  });
  db.career_interviews.push({
    id: 'iv-' + roleId, application_id: appId, user_id: userId,
    status: 'completed', scheduled_at: whenIso, updated_at: whenIso
  });
  db.ats_stage_events.push({
    id: 'ev-' + roleId, application_id: appId, from_stage: 'interview', to_stage: 'not_proceeding',
    actor: 'staff@gplink-test.local', reason: 'practice_passed', created_at: whenIso
  });
  return appId;
}

// Review fix (FIX 1, fail-safe): a completed interview whose application
// ended not_proceeding with NEITHER a GP signal (match_outcome='declined' /
// reason='gp_withdrew') NOR an explicit practice signal (staff moved it with
// no reason at all) — must NOT count as a strike (a strike must be
// affirmatively GP-driven, never assumed by default).
function seedInterviewNoSignal(userId, roleId, whenIso) {
  seedRole(roleId);
  const appId = 'app-' + roleId;
  db.gp_applications.push({
    id: appId, user_id: userId, career_role_id: roleId,
    ats_stage: 'not_proceeding', ats_stage_updated_at: whenIso, updated_at: whenIso
  });
  db.career_interviews.push({
    id: 'iv-' + roleId, application_id: appId, user_id: userId,
    status: 'completed', scheduled_at: whenIso, updated_at: whenIso
  });
  return appId;
}

describe('computeCareerStrikes', () => {
  it('counts a completed interview whose application ended at not_proceeding', async () => {
    const GP = uid();
    seedGp(GP, GP + '@gplink-test.local');
    seedInterviewStrike(GP, 'role-strike-a', new Date(Date.now() - 5 * 86400000).toISOString());

    const strikes = await testUtils.computeCareerStrikes(GP);
    expect(strikes.length).toBe(1);
    expect(strikes[0].source).toBe('interview');
    expect(strikes[0].practiceName).toBe('Test Practice role-strike-a');
    expect(strikes[0].location).toBe('Bundaberg, QLD');
  });

  it('counts a gp_withdrew stage event with no interview at all', async () => {
    const GP = uid();
    seedGp(GP, GP + '@gplink-test.local');
    seedWithdrawStrike(GP, 'role-strike-b', new Date(Date.now() - 4 * 86400000).toISOString());

    const strikes = await testUtils.computeCareerStrikes(GP);
    expect(strikes.length).toBe(1);
    expect(strikes[0].source).toBe('late_withdrawal');
  });

  it('dedupes per application, preferring the interview source over a withdrawal event on the same row', async () => {
    const GP = uid();
    seedGp(GP, GP + '@gplink-test.local');
    const roleId = 'role-strike-c';
    const when = new Date(Date.now() - 3 * 86400000).toISOString();
    seedRole(roleId);
    const appId = 'app-' + roleId;
    // match_outcome:'declined' — BOTH signals are genuinely GP-driven and
    // valid here (review fix, FIX 1: an interview-source strike requires
    // match_outcome==='declined'), so this test proves true precedence
    // rather than accidentally falling back to the withdrawal source.
    db.gp_applications.push({ id: appId, user_id: GP, career_role_id: roleId, ats_stage: 'not_proceeding', match_outcome: 'declined', ats_stage_updated_at: when, updated_at: when });
    db.career_interviews.push({ id: 'iv-' + roleId, application_id: appId, user_id: GP, status: 'completed', scheduled_at: when, updated_at: when });
    db.ats_stage_events.push({ id: 'ev-' + roleId, application_id: appId, from_stage: 'submitted', to_stage: 'not_proceeding', actor: GP, reason: 'gp_withdrew', created_at: when });

    const strikes = await testUtils.computeCareerStrikes(GP);
    expect(strikes.length).toBe(1);
    expect(strikes[0].source).toBe('interview');
  });

  it('never counts an application that is not currently at not_proceeding', async () => {
    const GP = uid();
    seedGp(GP, GP + '@gplink-test.local');
    seedRole('role-strike-d');
    const appId = 'app-role-strike-d';
    db.gp_applications.push({ id: appId, user_id: GP, career_role_id: 'role-strike-d', ats_stage: 'applied', updated_at: new Date().toISOString() });
    db.career_interviews.push({ id: 'iv-role-strike-d', application_id: appId, user_id: GP, status: 'completed', scheduled_at: new Date().toISOString() });

    const strikes = await testUtils.computeCareerStrikes(GP);
    expect(strikes.length).toBe(0);
  });

  it('a fresh release starts a new cycle — only strikes AFTER the last released_at count', async () => {
    const GP = uid();
    const releasedAt = new Date(Date.now() - 10 * 86400000).toISOString();
    seedGp(GP, GP + '@gplink-test.local', {
      career_lock: { strikes: [], locked_at: new Date(Date.now() - 30 * 86400000).toISOString(), released_at: releasedAt, reasons: {}, answers_submitted_at: null, intent_halved_at: null }
    });
    // Old strike BEFORE the release — must be excluded from this cycle.
    seedInterviewStrike(GP, 'role-strike-old', new Date(Date.now() - 20 * 86400000).toISOString());
    // New strike AFTER the release — must be included.
    seedInterviewStrike(GP, 'role-strike-new', new Date(Date.now() - 1 * 86400000).toISOString());

    const strikes = await testUtils.computeCareerStrikes(GP);
    expect(strikes.length).toBe(1);
    expect(strikes[0].applicationId).toBe('app-role-strike-new');
  });

  // ── Review fix (FIX 1): practice-driven outcomes are never a strike ───────
  it('review fix: three completed interviews all ending position_filled → zero strikes', async () => {
    const GP = uid();
    seedGp(GP, GP + '@gplink-test.local');
    seedInterviewPositionFilled(GP, 'role-pf-a', new Date(Date.now() - 9 * 86400000).toISOString());
    seedInterviewPositionFilled(GP, 'role-pf-b', new Date(Date.now() - 6 * 86400000).toISOString());
    seedInterviewPositionFilled(GP, 'role-pf-c', new Date(Date.now() - 3 * 86400000).toISOString());

    const strikes = await testUtils.computeCareerStrikes(GP);
    expect(strikes.length).toBe(0);
  });

  it('review fix: a practice_passed stage-event reason on the move to not_proceeding is not a strike, even with a completed interview', async () => {
    const GP = uid();
    seedGp(GP, GP + '@gplink-test.local');
    seedInterviewPracticePassed(GP, 'role-pp-a', new Date(Date.now() - 5 * 86400000).toISOString());

    const strikes = await testUtils.computeCareerStrikes(GP);
    expect(strikes.length).toBe(0);
  });

  it('review fix (fail-safe): a reason-less not_proceeding after a completed interview is not a strike', async () => {
    const GP = uid();
    seedGp(GP, GP + '@gplink-test.local');
    seedInterviewNoSignal(GP, 'role-ns-a', new Date(Date.now() - 5 * 86400000).toISOString());

    const strikes = await testUtils.computeCareerStrikes(GP);
    expect(strikes.length).toBe(0);
  });

  it('review fix: mixed outcomes only count the GP-driven ones — 2 GP-declined + 1 position_filled = 2 strikes', async () => {
    const GP = uid();
    seedGp(GP, GP + '@gplink-test.local');
    seedInterviewStrike(GP, 'role-mix-a', new Date(Date.now() - 9 * 86400000).toISOString());
    seedInterviewStrike(GP, 'role-mix-b', new Date(Date.now() - 6 * 86400000).toISOString());
    seedInterviewPositionFilled(GP, 'role-mix-c', new Date(Date.now() - 3 * 86400000).toISOString());

    const strikes = await testUtils.computeCareerStrikes(GP);
    expect(strikes.length).toBe(2);
    expect(strikes.map((s) => s.applicationId).sort()).toEqual(['app-role-mix-a', 'app-role-mix-b']);
  });
});

describe('evaluateCareerLocks', () => {
  it('locks a GP with exactly 3 current-cycle strikes, halves intent once, stores pre_lock_intent_score, and emails ops once', async () => {
    const GP = uid();
    seedGp(GP, GP + '@gplink-test.local');
    seedInterviewStrike(GP, 'role-lock3-a', new Date(Date.now() - 9 * 86400000).toISOString());
    seedInterviewStrike(GP, 'role-lock3-b', new Date(Date.now() - 6 * 86400000).toISOString());
    seedInterviewStrike(GP, 'role-lock3-c', new Date(Date.now() - 3 * 86400000).toISOString());

    resendCalls.length = 0;
    await testUtils.evaluateCareerLocks(Date.now() + 20000, GP);

    const stateRow = db.user_state.find((s) => s.user_id === GP);
    const lock = stateRow.state.career_lock;
    expect(lock.locked_at).toBeTruthy();
    expect(lock.released_at).toBeFalsy();
    expect(lock.strikes.length).toBe(3);
    expect(lock.intent_halved_at).toBeTruthy();
    expect(typeof lock.pre_lock_intent_score).toBe('number');

    const caseRow = db.registration_cases.find((c) => c.user_id === GP);
    expect(caseRow.intent_score).toBe(Math.round(lock.pre_lock_intent_score * 0.5));

    const lockEmails = resendCalls.filter((c) => /Career lock triggered/.test((c.body && c.body.subject) || ''));
    expect(lockEmails.length).toBe(1);
  });

  it('is idempotent: running it again does not re-lock, re-halve, or re-email', async () => {
    const GP = uid();
    seedGp(GP, GP + '@gplink-test.local');
    seedInterviewStrike(GP, 'role-lock3idem-a', new Date(Date.now() - 9 * 86400000).toISOString());
    seedInterviewStrike(GP, 'role-lock3idem-b', new Date(Date.now() - 6 * 86400000).toISOString());
    seedInterviewStrike(GP, 'role-lock3idem-c', new Date(Date.now() - 3 * 86400000).toISOString());

    await testUtils.evaluateCareerLocks(Date.now() + 20000, GP);
    const firstLock = db.user_state.find((s) => s.user_id === GP).state.career_lock;
    const firstScore = db.registration_cases.find((c) => c.user_id === GP).intent_score;

    resendCalls.length = 0;
    await testUtils.evaluateCareerLocks(Date.now() + 20000, GP);
    const secondLock = db.user_state.find((s) => s.user_id === GP).state.career_lock;
    const secondScore = db.registration_cases.find((c) => c.user_id === GP).intent_score;

    expect(secondLock.locked_at).toBe(firstLock.locked_at);
    expect(secondLock.intent_halved_at).toBe(firstLock.intent_halved_at);
    expect(secondScore).toBe(firstScore); // NOT halved a second time
    expect(resendCalls.filter((c) => /Career lock triggered/.test((c.body && c.body.subject) || '')).length).toBe(0);
  });

  it('does not lock a GP with only 2 strikes', async () => {
    const GP = uid();
    seedGp(GP, GP + '@gplink-test.local');
    seedInterviewStrike(GP, 'role-lock2-a', new Date(Date.now() - 6 * 86400000).toISOString());
    seedInterviewStrike(GP, 'role-lock2-b', new Date(Date.now() - 3 * 86400000).toISOString());

    await testUtils.evaluateCareerLocks(Date.now() + 20000, GP);
    const stateRow = db.user_state.find((s) => s.user_id === GP);
    expect((stateRow.state.career_lock || {}).locked_at).toBeFalsy();
  });

  // ── Review fix (FIX 1): practice-driven strikes never trigger a lock ──────
  it('review fix: three practice-driven (position_filled) interviews never lock the GP', async () => {
    const GP = uid();
    seedGp(GP, GP + '@gplink-test.local');
    seedInterviewPositionFilled(GP, 'role-lockpf-a', new Date(Date.now() - 9 * 86400000).toISOString());
    seedInterviewPositionFilled(GP, 'role-lockpf-b', new Date(Date.now() - 6 * 86400000).toISOString());
    seedInterviewPositionFilled(GP, 'role-lockpf-c', new Date(Date.now() - 3 * 86400000).toISOString());

    await testUtils.evaluateCareerLocks(Date.now() + 20000, GP);
    const stateRow = db.user_state.find((s) => s.user_id === GP);
    expect((stateRow.state.career_lock || {}).locked_at).toBeFalsy();
  });

  it('review fix: 2 GP-declined + 1 position_filled = 2 real strikes, GP not locked', async () => {
    const GP = uid();
    seedGp(GP, GP + '@gplink-test.local');
    seedInterviewStrike(GP, 'role-lockmix-a', new Date(Date.now() - 9 * 86400000).toISOString());
    seedInterviewStrike(GP, 'role-lockmix-b', new Date(Date.now() - 6 * 86400000).toISOString());
    seedInterviewPositionFilled(GP, 'role-lockmix-c', new Date(Date.now() - 3 * 86400000).toISOString());

    await testUtils.evaluateCareerLocks(Date.now() + 20000, GP);
    const stateRow = db.user_state.find((s) => s.user_id === GP);
    expect((stateRow.state.career_lock || {}).locked_at).toBeFalsy();
  });
});

describe('Server enforcement — 423 {locked:true} while career-locked', () => {
  const GP = uid();
  const EMAIL = GP + '@gplink-test.local';

  beforeAll(() => {
    seedGp(GP, EMAIL, {
      career_lock: {
        strikes: [{ applicationId: 'app-x', practiceName: 'X Practice', location: 'Bundaberg, QLD', interviewedAt: new Date().toISOString(), source: 'interview' }],
        locked_at: new Date().toISOString(), released_at: null, reasons: {}, answers_submitted_at: null, intent_halved_at: null
      }
    });
    seedRole('role-locked-apply');
    // A live match this GP could otherwise decline.
    db.gp_applications.push({
      id: 'app-locked-match', user_id: GP, career_role_id: 'role-locked-apply',
      ats_stage: 'shortlisted', matched_at: new Date().toISOString(),
      match_expires_at: new Date(Date.now() + 4 * 86400000).toISOString(), job_title: 'GP role'
    });
  });

  it('GET /api/career/roles → 423', async () => {
    const r = await httpReq('GET', '/api/career/roles', { cookie: userCookie(EMAIL, GP) });
    expect(r.status).toBe(423);
    expect(r.body.locked).toBe(true);
  });

  it('POST /api/career/apply → 423', async () => {
    const r = await httpReq('POST', '/api/career/apply', { cookie: userCookie(EMAIL, GP), body: { roleId: 'internal_ats:role-locked-apply' } });
    expect(r.status).toBe(423);
    expect(r.body.locked).toBe(true);
  });

  it('POST /api/career/match/respond {action:accept} → 423', async () => {
    const r = await httpReq('POST', '/api/career/match/respond', { cookie: userCookie(EMAIL, GP), body: { applicationId: 'app-locked-match', action: 'accept' } });
    expect(r.status).toBe(423);
    expect(r.body.locked).toBe(true);
  });

  it('POST /api/career/match/still-interested → 423', async () => {
    const r = await httpReq('POST', '/api/career/match/still-interested', { cookie: userCookie(EMAIL, GP), body: { applicationId: 'app-locked-match' } });
    expect(r.status).toBe(423);
    expect(r.body.locked).toBe(true);
  });

  it('POST /api/career/interview/book → 423', async () => {
    const r = await httpReq('POST', '/api/career/interview/book', { cookie: userCookie(EMAIL, GP), body: { applicationId: 'app-locked-match', slot_start_utc: new Date().toISOString() } });
    expect(r.status).toBe(423);
    expect(r.body.locked).toBe(true);
  });

  it('decline is still allowed while locked (only accept is blocked)', async () => {
    const r = await httpReq('POST', '/api/career/match/respond', { cookie: userCookie(EMAIL, GP), body: { applicationId: 'app-locked-match', action: 'decline', reason: 'not for me' } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.action).toBe('decline');
    const row = db.gp_applications.find((a) => a.id === 'app-locked-match');
    expect(row.ats_stage).toBe('not_proceeding');
  });

  it('GET /api/career/matches returns the lock payload instead of matches', async () => {
    const r = await httpReq('GET', '/api/career/matches', { cookie: userCookie(EMAIL, GP) });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.locked).toBe(true);
    expect(r.body.matches).toEqual([]);
    expect(Array.isArray(r.body.strikes)).toBe(true);
    expect(r.body.strikes.length).toBe(1);
    expect(r.body.strikes[0].practiceName).toBe('X Practice');
    expect(r.body).toHaveProperty('reasons');
    expect(r.body).toHaveProperty('answersSubmittedAt');
  });
});

describe('POST /api/career/lock/answers', () => {
  const GP = uid();
  const EMAIL = GP + '@gplink-test.local';
  const STRIKE_IDS = ['app-ans-1', 'app-ans-2', 'app-ans-3'];

  beforeAll(() => {
    seedGp(GP, EMAIL, {
      career_lock: {
        strikes: STRIKE_IDS.map((id, i) => ({ applicationId: id, practiceName: 'Practice ' + i, location: 'QLD', interviewedAt: new Date().toISOString(), source: 'interview' })),
        locked_at: new Date().toISOString(), released_at: null, reasons: {}, answers_submitted_at: null, intent_halved_at: null
      }
    });
  });

  it('409s when the GP is not currently locked', async () => {
    const OTHER = uid();
    seedGp(OTHER, OTHER + '@gplink-test.local');
    const r = await httpReq('POST', '/api/career/lock/answers', { cookie: userCookie(OTHER + '@gplink-test.local', OTHER), body: { answers: { 'app-x': 'text' } } });
    expect(r.status).toBe(409);
  });

  it('ignores an answer for an applicationId that is not one of this lock\'s own strikes', async () => {
    const r = await httpReq('POST', '/api/career/lock/answers', { cookie: userCookie(EMAIL, GP), body: { answers: { 'not-a-real-strike': 'hello' } } });
    expect(r.status).toBe(200);
    expect(r.body.reasons['not-a-real-strike']).toBeUndefined();
  });

  it('merges partial answers, sets answers_submitted_at only once ALL three have text, and emails ops exactly once', async () => {
    resendCalls.length = 0;
    const r1 = await httpReq('POST', '/api/career/lock/answers', { cookie: userCookie(EMAIL, GP), body: { answers: { [STRIKE_IDS[0]]: 'The billing split was different.' } } });
    expect(r1.status).toBe(200);
    expect(r1.body.answersSubmittedAt).toBeFalsy();

    const r2 = await httpReq('POST', '/api/career/lock/answers', { cookie: userCookie(EMAIL, GP), body: { answers: { [STRIKE_IDS[1]]: 'Wrong location for my family.' } } });
    expect(r2.status).toBe(200);
    expect(r2.body.answersSubmittedAt).toBeFalsy();
    expect(resendCalls.length).toBe(0);

    const r3 = await httpReq('POST', '/api/career/lock/answers', { cookie: userCookie(EMAIL, GP), body: { answers: { [STRIKE_IDS[2]]: 'Hours did not work.' } } });
    expect(r3.status).toBe(200);
    expect(r3.body.answersSubmittedAt).toBeTruthy();
    expect(r3.body.reasons[STRIKE_IDS[0]]).toBe('The billing split was different.');

    const submittedEmails = resendCalls.filter((c) => /Career lock answers submitted/.test((c.body && c.body.subject) || ''));
    expect(submittedEmails.length).toBe(1);

    // A follow-up save after completion must NOT re-fire the "submitted" email.
    resendCalls.length = 0;
    await httpReq('POST', '/api/career/lock/answers', { cookie: userCookie(EMAIL, GP), body: { answers: { [STRIKE_IDS[2]]: 'Hours did not work — updated.' } } });
    expect(resendCalls.filter((c) => /Career lock answers submitted/.test((c.body && c.body.subject) || '')).length).toBe(0);
  });
});

describe('GET /api/career/lock/booking-url', () => {
  it('returns the same per-RSO Calendly booking link the rest of the app uses', async () => {
    const GP = uid();
    const EMAIL = GP + '@gplink-test.local';
    seedGp(GP, EMAIL);
    const r = await httpReq('GET', '/api/career/lock/booking-url', { cookie: userCookie(EMAIL, GP) });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.url).toContain('calendly.com/gplink-team/career-call');
    expect(r.body.url).toMatch(/utm_content=call_/);
  });
});

describe('POST /api/ats/career-lock/release + /api/ats/career-lock/restore-intent', () => {
  it('release requires an ATS session and only succeeds on a currently-locked GP', async () => {
    const GP = uid();
    seedGp(GP, GP + '@gplink-test.local');

    const noAuth = await httpReq('POST', '/api/ats/career-lock/release', { host: SUPER_HOST, body: { user_id: GP } });
    expect(noAuth.status).toBe(401);

    const notLocked = await httpReq('POST', '/api/ats/career-lock/release', { host: SUPER_HOST, cookie: superCookie(), body: { user_id: GP } });
    expect(notLocked.status).toBe(409);
  });

  it('releases a locked GP: released_at is set, and they are matchable + un-423d again', async () => {
    const GP = uid();
    const EMAIL = GP + '@gplink-test.local';
    seedGp(GP, EMAIL, {
      career_lock: {
        strikes: [{ applicationId: 'app-rel-1', practiceName: 'P', location: 'QLD', interviewedAt: new Date().toISOString(), source: 'interview' }],
        locked_at: new Date().toISOString(), released_at: null, reasons: {}, answers_submitted_at: null, intent_halved_at: null
      }
    });

    // Confirmed locked beforehand.
    const beforeMatches = await httpReq('GET', '/api/career/matches', { cookie: userCookie(EMAIL, GP) });
    expect(beforeMatches.body.locked).toBe(true);

    const releaseRes = await httpReq('POST', '/api/ats/career-lock/release', { host: SUPER_HOST, cookie: superCookie(), body: { user_id: GP } });
    expect(releaseRes.status).toBe(200);
    expect(releaseRes.body.ok).toBe(true);
    expect(releaseRes.body.released_at).toBeTruthy();

    const stateRow = db.user_state.find((s) => s.user_id === GP);
    expect(stateRow.state.career_lock.released_at).toBeTruthy();
    // Eligibility formula (isCareerLocked / atsBuildGpMatchInputs) now reads false.
    expect(testUtils.isCareerLocked(stateRow.state.career_lock)).toBe(false);

    const afterMatches = await httpReq('GET', '/api/career/matches', { cookie: userCookie(EMAIL, GP) });
    expect(afterMatches.body.locked).toBe(false);

    seedRole('role-post-release');
    const applyRes = await httpReq('POST', '/api/career/apply', { cookie: userCookie(EMAIL, GP), body: { roleId: 'internal_ats:role-post-release' } });
    expect(applyRes.status).not.toBe(423);
  });

  it('restore-intent recomputes fresh (not simply un-halving the stored figure) and requires ATS session', async () => {
    const GP = uid();
    const EMAIL = GP + '@gplink-test.local';
    seedGp(GP, EMAIL);
    // Simulate a post-halving state: the stored score is a small halved number
    // that would NOT arise from a fresh recompute of this GP's real signals.
    const caseRow = db.registration_cases.find((c) => c.user_id === GP);
    caseRow.intent_score = 5;
    caseRow.intent_band = 'cold';

    const noAuth = await httpReq('POST', '/api/ats/career-lock/restore-intent', { host: SUPER_HOST, body: { user_id: GP } });
    expect(noAuth.status).toBe(401);

    const r = await httpReq('POST', '/api/ats/career-lock/restore-intent', { host: SUPER_HOST, cookie: superCookie(), body: { user_id: GP } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.intent_score).toBe('number');

    const updatedCase = db.registration_cases.find((c) => c.user_id === GP);
    expect(updatedCase.intent_score).toBe(r.body.intent_score);
    expect(updatedCase.intent_score).not.toBe(5); // genuinely recomputed, not left at the halved figure
  });
});

describe('Interview-completion PATCH hook', () => {
  it('marking a career_interviews row completed evaluates the lock for that GP and locks them at their 3rd strike', async () => {
    const GP = uid();
    seedGp(GP, GP + '@gplink-test.local');
    // Two strikes already banked.
    seedInterviewStrike(GP, 'role-hook-a', new Date(Date.now() - 6 * 86400000).toISOString());
    seedInterviewStrike(GP, 'role-hook-b', new Date(Date.now() - 3 * 86400000).toISOString());
    // Third application already sitting at not_proceeding; its interview is
    // marked completed NOW via the real admin endpoint — this is the moment
    // the hook should fire.
    seedRole('role-hook-c');
    const appId = 'app-role-hook-c';
    // match_outcome:'declined' — review fix, FIX 1: an interview-source
    // strike now requires an affirmative GP signal (the GP declined after
    // interviewing), not merely a completed interview + not_proceeding.
    db.gp_applications.push({ id: appId, user_id: GP, career_role_id: 'role-hook-c', ats_stage: 'not_proceeding', match_outcome: 'declined', updated_at: new Date().toISOString() });
    const ivId = 'iv-role-hook-c';
    db.career_interviews.push({ id: ivId, application_id: appId, user_id: GP, status: 'scheduled', scheduled_at: new Date().toISOString() });

    const r = await httpReq('PATCH', '/api/admin/career/interview', { cookie: adminCookie(), body: { id: ivId, status: 'completed' } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const stateRow = db.user_state.find((s) => s.user_id === GP);
    expect(stateRow.state.career_lock.locked_at).toBeTruthy();
    expect(stateRow.state.career_lock.strikes.length).toBe(3);
  });
});

// ── Review fix: the generic recompute paths must not undo the halving ──────
describe('Recompute paths preserve the career-lock halving (review fix)', () => {
  // Bearer-auth cron request (same CRON_SECRET set in beforeAll before the
  // server import — httpReq has no headers slot, so this builds its own).
  function cronReq() {
    return new Promise((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port, path: '/api/cron/recompute-intent', method: 'POST', headers: { Authorization: 'Bearer ' + process.env.CRON_SECRET } },
        (res) => {
          const c = []; res.on('data', (x) => c.push(x));
          res.on('end', () => {
            let parsed = null; try { parsed = JSON.parse(Buffer.concat(c).toString('utf8')); } catch {}
            resolve({ status: res.statusCode, body: parsed });
          });
        }
      );
      r.on('error', reject); r.end();
    });
  }

  // Lock a GP via the real evaluate path and return their ids + lock blob.
  async function lockGp() {
    const GP = uid();
    const EMAIL = GP + '@gplink-test.local';
    seedGp(GP, EMAIL);
    seedInterviewStrike(GP, 'role-rc-' + GP + '-a', new Date(Date.now() - 9 * 86400000).toISOString());
    seedInterviewStrike(GP, 'role-rc-' + GP + '-b', new Date(Date.now() - 6 * 86400000).toISOString());
    seedInterviewStrike(GP, 'role-rc-' + GP + '-c', new Date(Date.now() - 3 * 86400000).toISOString());
    await testUtils.evaluateCareerLocks(Date.now() + 20000, GP);
    const lock = db.user_state.find((s) => s.user_id === GP).state.career_lock;
    expect(lock.locked_at).toBeTruthy();
    expect(lock.intent_halved_at).toBeTruthy();
    return { GP, EMAIL, lock };
  }

  it('nightly recompute cron keeps a locked GP halved (pre_lock stays the un-halved baseline) while an unlocked GP recomputes normally in the SAME run', async () => {
    const locked = await lockGp();
    const lockedCase = db.registration_cases.find((c) => c.user_id === locked.GP);
    const halvedBefore = lockedCase.intent_score;
    const preBaseline = locked.lock.pre_lock_intent_score;
    expect(halvedBefore).toBe(Math.round(preBaseline * 0.5));

    // Unlocked control GP with an identical facts profile: after the cron,
    // their stored score IS the un-halved recompute — which, with identical
    // facts, must equal the locked GP's pre_lock baseline exactly.
    const CONTROL = uid();
    seedGp(CONTROL, CONTROL + '@gplink-test.local');
    const controlCase = db.registration_cases.find((c) => c.user_id === CONTROL);
    controlCase.intent_score = 1; // stale figure the cron must overwrite
    controlCase.intent_band = 'cold';

    const r = await cronReq();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.processed).toBeGreaterThan(0);

    // Locked GP: STILL halved (the Critical bug was this restoring to full).
    const lockedAfter = db.registration_cases.find((c) => c.user_id === locked.GP);
    const controlAfter = db.registration_cases.find((c) => c.user_id === CONTROL);
    expect(controlAfter.intent_score).not.toBe(1); // control genuinely recomputed
    expect(controlAfter.intent_score).toBe(preBaseline); // identical facts -> the un-halved baseline
    expect(lockedAfter.intent_score).toBe(Math.round(controlAfter.intent_score * 0.5));

    // pre_lock_intent_score still represents the un-halved baseline.
    const lockAfter = db.user_state.find((s) => s.user_id === locked.GP).state.career_lock;
    expect(lockAfter.pre_lock_intent_score).toBe(controlAfter.intent_score);
    expect(lockAfter.intent_halved_at).toBeTruthy();
  });

  it('the manual Recompute endpoint preserves the halving on a locked GP and says so (career_lock_halved:true)', async () => {
    const locked = await lockGp();
    const preBaseline = locked.lock.pre_lock_intent_score;

    const r = await httpReq('POST', '/api/ceo/candidate/recompute-intent?case_id=' + encodeURIComponent('case-' + locked.GP), {
      host: SUPER_HOST, cookie: superCookie()
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.career_lock_halved).toBe(true);
    expect(r.body.intent_score).toBe(Math.round(preBaseline * 0.5));

    const caseAfter = db.registration_cases.find((c) => c.user_id === locked.GP);
    expect(caseAfter.intent_score).toBe(Math.round(preBaseline * 0.5));
  });

  it('the manual Recompute endpoint on an UNLOCKED GP reports career_lock_halved:false and stores the full score', async () => {
    const GP = uid();
    seedGp(GP, GP + '@gplink-test.local');
    const r = await httpReq('POST', '/api/ceo/candidate/recompute-intent?case_id=' + encodeURIComponent('case-' + GP), {
      host: SUPER_HOST, cookie: superCookie()
    });
    expect(r.status).toBe(200);
    expect(r.body.career_lock_halved).toBe(false);
    const caseAfter = db.registration_cases.find((c) => c.user_id === GP);
    expect(caseAfter.intent_score).toBe(r.body.intent_score);
  });

  it('after release + restore-intent, a subsequent nightly recompute behaves normally (no re-halving, no double effects)', async () => {
    const locked = await lockGp();

    const releaseRes = await httpReq('POST', '/api/ats/career-lock/release', { host: SUPER_HOST, cookie: superCookie(), body: { user_id: locked.GP } });
    expect(releaseRes.status).toBe(200);

    const restoreRes = await httpReq('POST', '/api/ats/career-lock/restore-intent', { host: SUPER_HOST, cookie: superCookie(), body: { user_id: locked.GP } });
    expect(restoreRes.status).toBe(200);
    const restoredScore = restoreRes.body.intent_score;

    // restore-intent stood the guard down: halving markers cleared.
    const lockAfterRestore = db.user_state.find((s) => s.user_id === locked.GP).state.career_lock;
    expect(lockAfterRestore.intent_halved_at).toBeFalsy();
    expect(lockAfterRestore.pre_lock_intent_score).toBeFalsy();

    const r = await cronReq();
    expect(r.status).toBe(200);

    // Nightly run left the restored (full) score intact — no re-halving.
    const caseAfter = db.registration_cases.find((c) => c.user_id === locked.GP);
    expect(caseAfter.intent_score).toBe(restoredScore);
    const lockAfterCron = db.user_state.find((s) => s.user_id === locked.GP).state.career_lock;
    expect(lockAfterCron.intent_halved_at).toBeFalsy();
    expect(lockAfterCron.pre_lock_intent_score).toBeFalsy();
  });
});

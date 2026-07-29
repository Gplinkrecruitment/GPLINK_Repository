// GP application withdrawal — the five defects fixed on 2026-07-21.
//
//  1. GET /api/ceo/candidates asked PostgREST for gp_applications.created_at,
//     which does not exist. The 400 was swallowed, byUser2 stayed empty, and
//     EVERY candidate fell through to pipeline_bucket 'unassociated' — so
//     every pipeline chip read "No candidates match your filters".
//  2. POST /api/career/application/withdraw passed the withdraw reason in the
//     ACTOR argument slot, so ats_stage_events.reason was never written.
//  3. The practice was never told, and could still approve a doctor who had
//     walked away (live practice_action_token + unguarded endpoints).
//  4. The CEO drawer payload carried no raw status / withdrawn_at.
//  5. Repeated withdrawals never dented the intent score.
//
// Boots the real server against an in-memory PostgREST emulator (same pattern
// as tests/ai-matching-lock.test.js) — with one deliberate addition: the
// emulator is SCHEMA-STRICT for gp_applications. A select naming a column the
// production table does not have answers HTTP 400 with PostgREST's own
// "column ... does not exist" body, exactly like production. That is what
// makes the defect-1 regression below real: against the pre-fix server the
// candidates query 400s here just as it did in production, byUser2 is empty,
// and the ats_bucket=interview filter returns nothing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Source + migration wiring (no server boot needed) ──────────────────────
describe('withdrawal — source & migration wiring', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  // Asserts the INVARIANT, not one exact select string: gp_applications has no
  // created_at column in production, so ANY select naming it makes PostgREST
  // 400 the whole query — which is how every candidate silently became
  // 'unassociated' and every pipeline chip went empty. Pinning the literal
  // string instead would break the moment someone legitimately adds a real
  // column to this select (match_outcome did exactly that).
  it('no gp_applications query anywhere asks for the non-existent created_at column', () => {
    const selects = [...serverSrc.matchAll(/supabaseDbRequest\(\s*'gp_applications'\s*,\s*'(select=[^']*)'/g)]
      .map((m) => m[1]);
    expect(selects.length).toBeGreaterThan(0);
    const offenders = selects.filter((s) => /\bcreated_at\b/.test(s.split('&')[0]));
    expect(offenders).toEqual([]);
  });

  it('the candidates applications query still selects the columns its buckets need', () => {
    // Scoped to the candidates handler and matched by the variable it assigns
    // (appsRes2), not by the first column — widening the select, as the
    // 2026-07-30 action strip did, must not fail a test that only cares about
    // which columns are PRESENT. Two other gp_applications bulk reads use
    // limit=5000, so shape alone is not specific enough.
    const m = serverSrc.match(/appsRes2 = await supabaseDbRequest\(\s*'gp_applications'\s*,\s*'(select=[^']*)'/);
    expect(m).toBeTruthy();
    const cols = m[1].replace('select=', '').split('&')[0].split(',');
    expect(cols).toContain('user_id');
    expect(cols).toContain('ats_stage');
    expect(cols).toContain('applied_at');
    expect(cols).not.toContain('created_at');
  });

  it('a failed applications fetch is logged AND surfaced, never swallowed', () => {
    expect(serverSrc).toContain('[ceo candidates] gp_applications fetch FAILED');
    expect(serverSrc).toContain('applications_unavailable: !!clAppsUnavailable');
  });

  it('the GP self-withdraw reason is its own value, NOT in the staff whitelist', async () => {
    const { ATS_WITHDRAW_REASON_VALUES, ATS_GP_SELF_WITHDRAW_REASON } = (await import('../server.js')).__testUtils;
    expect(ATS_GP_SELF_WITHDRAW_REASON).toBe('gp_self_withdrew');
    // Must NOT be selectable by staff, and must NOT be the value the 3-strike
    // career-lock query matches on.
    expect(ATS_WITHDRAW_REASON_VALUES).not.toContain('gp_self_withdrew');
    expect(ATS_GP_SELF_WITHDRAW_REASON).not.toBe('gp_withdrew');
    expect(serverSrc).toContain("reason=eq.gp_withdrew");
  });

  it('the withdrawal migration is additive and idempotent', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260721100000_gp_application_withdrawal.sql'), 'utf8');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ/);
    expect(sql).not.toMatch(/DROP\s/i);
    expect(sql).not.toMatch(/CHECK\s*\(/i);
  });
});

// ── Re-apply after withdrawal must be blocked (server 409 + popup) ─────────
// Owner rule: once a GP withdraws an application for a role, they can never
// re-apply to it. Task 1 hid withdrawn roles from the Roles/Saved tabs; this
// guards the server for any path that still reaches Apply (deep links,
// cached pages, or a stale AI-match banner) and gives the GP an explanation
// instead of a silent/generic failure.
describe('apply endpoint rejects previously-withdrawn applications', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  it('server.js carries the previously_withdrawn 409 guard', () => {
    expect(serverSrc).toMatch(/previously_withdrawn/);
    expect(serverSrc).toContain("You previously withdrew your application for this position, so it can't be applied for again. If this was a mistake, message your Registration Support Officer.");
  });

  it('the guard sits at the TOP of the existing-application branch, before the shortlisted self-apply-as-accept path', () => {
    const existingBranch = serverSrc.slice(serverSrc.indexOf('if (existingAppRow) {'), serverSrc.indexOf('if (existingAppRow) {') + 1200);
    const withdrawnGuardIdx = existingBranch.indexOf('previously_withdrawn');
    const shortlistedIdx = existingBranch.indexOf("ats_stage === 'shortlisted'");
    expect(withdrawnGuardIdx).toBeGreaterThan(-1);
    expect(shortlistedIdx).toBeGreaterThan(-1);
    expect(withdrawnGuardIdx).toBeLessThan(shortlistedIdx);
  });

  it('the match/respond accept path guards the same way before reactivating a shortlisted-but-withdrawn row', () => {
    const acceptCallIdx = serverSrc.indexOf('const mrAccept = await acceptShortlistedMatchRow(mrRow');
    expect(acceptCallIdx).toBeGreaterThan(-1);
    const before = serverSrc.slice(Math.max(0, acceptCallIdx - 900), acceptCallIdx);
    expect(before).toMatch(/previously_withdrawn/);
  });
});

describe('job page explains the block in a popup', () => {
  const jobSrc = fs.readFileSync(path.join(ROOT, 'pages', 'job.html'), 'utf8');

  it('job.html recognizes the previously_withdrawn code and has a modal to explain it', () => {
    expect(jobSrc).toMatch(/previously_withdrawn/);
    expect(jobSrc).toMatch(/showWithdrawnBlockModal/);
    expect(jobSrc).toMatch(/id="withdrawnBlockOverlay"/);
  });
});

// ── Client-side visibility: a withdrawn role must vanish from Roles/Saved ───
// Owner rule (2026-07-21): once a GP withdraws, the role is gone from the
// Roles and Saved tabs entirely — it lives ONLY in the Offers tab's
// applications list, already ribboned WITHDRAWN.
describe('withdrawn roles are hidden from Roles/Saved', () => {
  const src = fs.readFileSync(path.join(ROOT, 'pages', 'career.html'), 'utf8');
  it('isApplied ignores terminal applications', () => {
    expect(src).toMatch(/TERMINAL_APPLICATION_STATUS_KEYS\s*=\s*\[\s*"withdrawn"/);
    expect(src).toMatch(/function isActiveApplication\(/);
  });
  it('getFilteredRoles drops withdrawn roles', () => {
    expect(src).toMatch(/qualifying\s*=[\s\S]{0,200}?!isWithdrawnRole\(/);
    expect(src).toMatch(/\.filter\(\(role\) => !isWithdrawnRole\(role\.id\)\)/);
  });
});

// ── Live boot ──────────────────────────────────────────────────────────────
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-career-withdraw-${RUN_ID}.json`);
const SUPER_HOST = 'withdraw-test.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const HUB_EMAIL = 'hello@mygplink.com.au';

const GP = { userId: 'u-wd-gp', email: 'gp@withdraw-test.local' };
const GP2 = { userId: 'u-wd-gp2', email: 'gp2@withdraw-test.local' };
const NOW = new Date().toISOString();

let server, port, sbServer, sbPort, realFetch, testUtils;
const resendCalls = [];

// The REAL production gp_applications column set (base migration
// 20260315120000 plus every later ALTER that has been applied), so a select
// for anything else fails here exactly as it fails against Supabase.
const GP_APPLICATIONS_COLUMNS = new Set([
  'id', 'user_id', 'career_role_id', 'provider_role_id', 'zoho_candidate_id',
  'zoho_application_id', 'status', 'applied_at', 'updated_at',
  'practice_submission_status', 'zoho_submission_id', 'zoho_client_id',
  'zoho_contact_id', 'practice_contact_name', 'practice_contact_email',
  'submitted_to_practice_at', 'submitted_to_practice_by', 'submission_task_id',
  'ats_stage', 'ats_stage_updated_at', 'ats_notes', 'practice_id', 'revealed',
  'origin', 'practice_responded_at', 'practice_response_action',
  'practice_action_token', 'practice_decision', 'practice_decision_at',
  'practice_decision_reason', 'ai_recommendation', 'match_score',
  'match_reasons', 'matched_at', 'match_expires_at', 'match_seen_at',
  'match_outcome', 'withdrawn_at'
]);
// Returns the first unknown column in a select list, or '' when all are real.
function unknownGpApplicationsColumn(selectParam) {
  if (!selectParam) return '';
  const cols = String(selectParam).split(',').map((s) => s.trim()).filter(Boolean);
  for (const col of cols) {
    if (col === '*') continue;
    if (!GP_APPLICATIONS_COLUMNS.has(col)) return col;
  }
  return '';
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: SUPER_EMAIL, adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
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
const ceoGet = (p) => httpReq('GET', p, { host: SUPER_HOST, cookie: superCookie() });
const gpPost = (p, body) => httpReq('POST', p, { cookie: userCookie(GP.email, GP.userId), body });
const gp2Post = (p, body) => httpReq('POST', p, { cookie: userCookie(GP2.email, GP2.userId), body });

// ── In-memory PostgREST emulator (schema-strict for gp_applications) ───────
const db = {
  user_profiles: [], user_state: [], user_documents: [], registration_cases: [],
  ats_stage_events: [], career_roles: [], gp_applications: [], career_interviews: [],
  scheduled_calls: [], rso_team: [], practices: [], ats_offers: [], registration_tasks: []
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
    filters.push({ col: key, op, val: rest.slice(dot + 1), negate });
  }
  function coerce(cell, val) {
    if (typeof cell === 'string' && /^\d{4}-\d{2}-\d{2}/.test(cell) && /^\d{4}-\d{2}-\d{2}/.test(val)) {
      return [Date.parse(cell), Date.parse(val)];
    }
    const cellNum = Number(cell), valNum = Number(val);
    if (cell !== null && cell !== undefined && cell !== '' && !Number.isNaN(cellNum) && !Number.isNaN(valNum)) return [cellNum, valNum];
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
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, '')).includes(String(cell));
    } else if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
      if (cell === null || cell === undefined) { result = false; }
      else {
        const [a, b] = coerce(cell, val);
        result = op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
      }
    } else { result = true; }
    return negate ? !result : result;
  });
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { resolve(null); } });
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
      const table = decodeURIComponent(m[1]);
      const rows = tableOf(table);

      // Schema strictness: reproduce PostgREST's 400 for an unknown column.
      if (table === 'gp_applications') {
        const bad = unknownGpApplicationsColumn(u.searchParams.get('select'));
        if (bad) {
          send(400, { code: '42703', message: 'column gp_applications.' + bad + ' does not exist' });
          return;
        }
      }

      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out); return;
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
          if (table === 'gp_applications' && !row.ats_stage) row.ats_stage = 'applied';
          rows.push(row); return row;
        });
        send(201, saved); return;
      }
      if (req.method === 'PATCH') {
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched); return;
      }
      if (req.method === 'DELETE') {
        const keep = rows.filter((row) => !matches(row));
        rows.length = 0; keep.forEach((row) => rows.push(row));
        send(200, []); return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function seed() {
  db.user_profiles.push(
    { user_id: GP.userId, email: GP.email, first_name: 'Helen', last_name: 'Wazalski', registration_country: 'australia', onboarding_completed_at: NOW },
    { user_id: GP2.userId, email: GP2.email, first_name: 'Second', last_name: 'Doctor', registration_country: 'australia', onboarding_completed_at: NOW }
  );
  db.user_state.push(
    { user_id: GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW },
    { user_id: GP2.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }
  );
  db.registration_cases.push(
    { id: 'case-wd-1', user_id: GP.userId, status: 'active', stage: 'amc', assigned_rso: null, assigned_va: null, last_gp_activity_at: NOW, updated_at: NOW },
    { id: 'case-wd-2', user_id: GP2.userId, status: 'active', stage: 'amc', assigned_rso: null, assigned_va: null, last_gp_activity_at: NOW, updated_at: NOW }
  );
  db.career_roles.push({
    id: 'role-wd', provider: 'internal_ats', provider_role_id: 'ats_wd', title: 'General Practitioner — VR',
    practice_name: 'Erina Medical Centre', location_city: 'Erina', location_state: 'NSW',
    is_active: true, job_status: 'open', updated_at: NOW
  });

  // (A) Submitted to the practice, live approve/turn-down token — the exact
  //     production shape that let a practice approve a withdrawn doctor.
  db.gp_applications.push({
    id: 'app-submitted', user_id: GP.userId, career_role_id: 'role-wd', provider_role_id: 'ats_wd',
    status: 'review', ats_stage: 'interview', applied_at: NOW, updated_at: NOW,
    practice_submission_status: 'submitted_to_practice',
    practice_contact_name: 'Anna Manager', practice_contact_email: 'anna@erina-test.local',
    submitted_to_practice_at: NOW, practice_action_token: 'live-token-abcdefghijklmnop',
    revealed: true, withdrawn_at: null
  });
  // (B) Never left GP Link — the practice must NOT be emailed about this one.
  db.gp_applications.push({
    id: 'app-internal', user_id: GP.userId, career_role_id: 'role-wd', provider_role_id: 'ats_wd',
    status: 'applied', ats_stage: 'applied', applied_at: NOW, updated_at: NOW,
    practice_submission_status: 'pending_va_submission', practice_action_token: null, withdrawn_at: null
  });
  // (C) Kept at 'applied' so the GP's best pipeline stage is stable across the
  //     two withdrawals in the intent test (isolating the withdrawal penalty).
  db.gp_applications.push({
    id: 'app-keep', user_id: GP.userId, career_role_id: 'role-wd', provider_role_id: 'ats_wd',
    status: 'applied', ats_stage: 'applied', applied_at: NOW, updated_at: NOW,
    practice_submission_status: 'pending_va_submission', practice_action_token: null, withdrawn_at: null
  });
  // (D) A SECOND GP whose only application sits at 'interview'. Defect 1's
  //     regression turns on this row: bucket filtering must find them.
  db.gp_applications.push({
    id: 'app-gp2-interview', user_id: GP2.userId, career_role_id: 'role-wd', provider_role_id: 'ats_wd',
    status: 'review', ats_stage: 'interview', applied_at: NOW, updated_at: NOW,
    practice_submission_status: 'submitted_to_practice', practice_action_token: null, withdrawn_at: null
  });
}

beforeAll(async () => {
  await startSupabaseEmulator();
  seed();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'career-withdraw-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = '';
  process.env.CONSULTANT_EMAILS = '';
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.OPENAI_API_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.REGISTRATION_HUB_EMAIL = HUB_EMAIL;

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const uStr = String(url && url.url ? url.url : url);
    if (uStr.startsWith('https://api.resend.com/')) {
      let parsed = null; try { parsed = JSON.parse((opts && opts.body) || 'null'); } catch {}
      resendCalls.push({ url: uStr, body: parsed });
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
    }
    if (!/^https?:\/\/127\.0\.0\.1[:/]/.test(uStr)) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }
    return realFetch(url, opts);
  };

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

// ── DEFECT 1 ───────────────────────────────────────────────────────────────
describe('DEFECT 1 — /api/ceo/candidates pipeline buckets', () => {
  it('filtering by the interview bucket returns the GP whose application is at interview', async () => {
    // Pre-fix this FAILED: the select carried created_at, the schema-strict
    // emulator (like production) answered 400, byUser2 stayed empty, every
    // candidate became 'unassociated', and this filter returned nothing.
    const r = await ceoGet('/api/ceo/candidates?ats_bucket=interview');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const users = (r.body.candidates || []).map((c) => c.user_id);
    expect(users).toContain(GP2.userId);
    expect(r.body.applications_unavailable).toBe(false);
  });

  it('the unfiltered list assigns real buckets, not a wall of "unassociated"', async () => {
    const r = await ceoGet('/api/ceo/candidates');
    expect(r.status).toBe(200);
    const buckets = (r.body.candidates || []).map((c) => c.pipeline_bucket);
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.every((b) => b === 'unassociated')).toBe(false);
  });
});

// ── DEFECTS 2 + 3 + 4 ──────────────────────────────────────────────────────
describe('DEFECT 3 — a practice can still act on a withdrawn candidate', () => {
  it('the live approve link works BEFORE the doctor withdraws', async () => {
    const r = await httpReq('GET', '/api/practice/application/decision-context?token=live-token-abcdefghijklmnop');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.withdrawn).toBe(false);
  });
});

describe('DEFECT 2/3/4 — withdrawing a submitted application', () => {
  let emailsBefore = 0;

  it('records status, withdrawn_at, and NULLs the practice action token', async () => {
    emailsBefore = resendCalls.length;
    const r = await gpPost('/api/career/application/withdraw', { applicationId: 'app-submitted' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const row = db.gp_applications.find((a) => a.id === 'app-submitted');
    expect(row.status).toBe('withdrawn');
    expect(row.withdrawn_at).toBeTruthy();
    expect(Number.isFinite(Date.parse(row.withdrawn_at))).toBe(true);
    // The live approve/turn-down link in the practice's inbox is dead.
    expect(row.practice_action_token).toBe(null);
    expect(row.ats_stage).toBe('not_proceeding');
  });

  it('writes the reason in the REASON slot, under its own distinct value', async () => {
    const ev = db.ats_stage_events.find((e) => e.application_id === 'app-submitted' && e.to_stage === 'not_proceeding');
    expect(ev).toBeTruthy();
    expect(ev.reason).toBe('gp_self_withdrew');
    // Actor is the GP's own identity — audit, not a reason smuggled into the
    // wrong argument position (the original bug).
    expect(ev.actor).toBe(GP.email);
    expect(ev.actor).not.toBe('gp_withdrew');
  });

  it('emails the practice that no action is needed, and notifies ops', async () => {
    const sent = resendCalls.slice(emailsBefore).map((c) => c.body || {});
    const toPractice = sent.find((b) => [].concat(b.to || []).includes('anna@erina-test.local'));
    expect(toPractice).toBeTruthy();
    expect(String(toPractice.subject)).toContain('withdrawn');
    // The submission email already named the candidate in full, so naming
    // them here reveals nothing new.
    expect(String(toPractice.subject)).toContain('Helen Wazalski');
    expect(String(toPractice.html || '') + String(toPractice.text || '')).toContain('no action is needed');

    const toOps = sent.find((b) => [].concat(b.to || []).includes(HUB_EMAIL));
    expect(toOps).toBeTruthy();
    expect(String(toOps.subject)).toContain('withdrew');
  });

  it('the practice can no longer approve — clear message, no 500', async () => {
    // Defence in depth: the token was nulled, but a cached token must also be
    // refused on the STATUS, so the guard is exercised directly here.
    db.gp_applications.find((a) => a.id === 'app-submitted').practice_action_token = 'live-token-abcdefghijklmnop';

    const r = await httpReq('POST', '/api/practice/application/decision', {
      body: { token: 'live-token-abcdefghijklmnop', action: 'approve' }
    });
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('withdrawn');
    expect(r.body.message).toBe('This doctor has withdrawn their application for this role.');
    // Nothing was recorded.
    expect(db.gp_applications.find((a) => a.id === 'app-submitted').practice_decision).toBeFalsy();
  });

  it('the practice can no longer submit interview availability', async () => {
    const r = await httpReq('POST', '/api/practice/application/availability', {
      body: { token: 'live-token-abcdefghijklmnop', windows: [{ date: '2026-08-01', fromMin: 540, toMin: 660 }] }
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('withdrawn');
  });

  it('the decision-context read says plainly that the doctor withdrew', async () => {
    const r = await httpReq('GET', '/api/practice/application/decision-context?token=live-token-abcdefghijklmnop');
    expect(r.status).toBe(200);
    expect(r.body.withdrawn).toBe(true);
    expect(r.body.withdrawnMessage).toBe('This doctor has withdrawn their application for this role.');
    // Leave the row as production would: token cleared.
    db.gp_applications.find((a) => a.id === 'app-submitted').practice_action_token = null;
  });

  it('DEFECT 4 — the CEO drawer payload carries raw status + withdrawn_at', async () => {
    const r = await ceoGet('/api/ceo/candidate?case_id=case-wd-1');
    expect(r.status).toBe(200);
    const apps = (r.body.candidate && r.body.candidate.apps) || (r.body.apps) || [];
    const wd = apps.find((a) => a.id === 'app-submitted');
    expect(wd).toBeTruthy();
    expect(wd.status).toBe('withdrawn');
    expect(wd.withdrawn_at).toBeTruthy();
    const live = apps.find((a) => a.id === 'app-keep');
    expect(live.status).toBe('applied');
    expect(live.withdrawn_at).toBe(null);
  });
});

describe('DEFECT 3 — an application that never reached the practice', () => {
  it('withdrawing it emails nobody at a practice', async () => {
    const before = resendCalls.length;
    const r = await gpPost('/api/career/application/withdraw', { applicationId: 'app-internal' });
    expect(r.status).toBe(200);

    const sent = resendCalls.slice(before).map((c) => c.body || {});
    const recipients = sent.flatMap((b) => [].concat(b.to || []));
    expect(recipients).not.toContain('anna@erina-test.local');
    // Nor an ops "withdrew after submission" note — nothing was submitted.
    expect(sent.some((b) => String(b.subject || '').includes('withdrew after submission'))).toBe(false);
  });
});

// ── DEFECT 2 (product rule) ────────────────────────────────────────────────
describe('DEFECT 2 — a GP self-withdrawal must NOT cost them a career strike', () => {
  it('computeCareerStrikes ignores the two self-withdrawals just recorded', async () => {
    const strikes = await testUtils.computeCareerStrikes(GP.userId);
    const ids = strikes.map((s) => s.applicationId);
    expect(ids).not.toContain('app-submitted');
    expect(ids).not.toContain('app-internal');
  });

  it('but a STAFF-recorded gp_withdrew on the same shape DOES strike', async () => {
    // Proves the strike machinery is live in this fixture, so the clean result
    // above is the distinct reason value doing its job — not a dead query.
    db.ats_stage_events.push({
      id: 'ev-staff-1', application_id: 'app-submitted', from_stage: 'interview',
      to_stage: 'not_proceeding', actor: SUPER_EMAIL, reason: 'gp_withdrew',
      created_at: new Date().toISOString()
    });
    const strikes = await testUtils.computeCareerStrikes(GP.userId);
    expect(strikes.map((s) => s.applicationId)).toContain('app-submitted');
    db.ats_stage_events = db.ats_stage_events.filter((e) => e.id !== 'ev-staff-1');
  });
});

// ── DEFECT 5 ───────────────────────────────────────────────────────────────
describe('DEFECT 5 — intent score falls as a GP withdraws more roles', () => {
  it('atsIntentInputFromFacts passes withdrawnCount through to computeIntent', () => {
    const input = testUtils.atsIntentInputFromFacts({ withdrawnCount: 3, apps: [], calls: [] });
    expect(input.withdrawnCount).toBe(3);
    const missing = testUtils.atsIntentInputFromFacts({ apps: [], calls: [] });
    expect(missing.withdrawnCount).toBe(0);
  });

  it('a second withdrawal costs exactly 6 points more than the first', async () => {
    // GP2 starts with one application at 'interview' plus two spare 'applied'
    // rows, so the best pipeline stage is unchanged by these withdrawals and
    // the ONLY moving part is the withdrawal penalty (0 → 0 → 6).
    db.gp_applications.push(
      { id: 'app-gp2-a', user_id: GP2.userId, career_role_id: 'role-wd', provider_role_id: 'ats_wd', status: 'applied', ats_stage: 'applied', applied_at: NOW, updated_at: NOW, practice_submission_status: 'pending_va_submission', practice_action_token: null, withdrawn_at: null },
      { id: 'app-gp2-b', user_id: GP2.userId, career_role_id: 'role-wd', provider_role_id: 'ats_wd', status: 'applied', ats_stage: 'applied', applied_at: NOW, updated_at: NOW, practice_submission_status: 'pending_va_submission', practice_action_token: null, withdrawn_at: null }
    );

    const first = await gp2Post('/api/career/application/withdraw', { applicationId: 'app-gp2-a' });
    expect(first.status).toBe(200);
    const afterOne = db.registration_cases.find((c) => c.id === 'case-wd-2').intent_score;
    expect(Number.isFinite(afterOne)).toBe(true);

    const second = await gp2Post('/api/career/application/withdraw', { applicationId: 'app-gp2-b' });
    expect(second.status).toBe(200);
    const caseRow = db.registration_cases.find((c) => c.id === 'case-wd-2');
    const afterTwo = caseRow.intent_score;

    // First withdrawal is free; the second costs 6.
    expect(afterOne - afterTwo).toBe(6);
    expect(caseRow.intent_signals.facts.withdrawn_count).toBe(2);
    const penaltyRow = caseRow.intent_signals.breakdown.find((s) => s.penalty);
    expect(penaltyRow).toBeTruthy();
    expect(penaltyRow.points).toBe(-6);
  });
});

// ── Re-apply after withdrawal is blocked — live 409 ─────────────────────────
// Owner rule: once withdrawn, never again for that exact role. Task 1 hid
// withdrawn roles from the Roles/Saved tabs; this proves the SERVER also
// refuses, for any path that still reaches Apply (deep link, cached page, a
// stale AI-match email/banner).
describe('re-apply after withdrawal is blocked end-to-end', () => {
  const ROLE_PUBLIC_ID = 'internal_ats:ats_wd';
  const EXPECTED_MESSAGE = "You previously withdrew your application for this position, so it can't be applied for again. If this was a mistake, message your Registration Support Officer.";

  it('POST /api/career/apply 409s with the previously_withdrawn code + verbatim message', async () => {
    // Clear the gates that would otherwise answer first: a signed CV on file
    // and a DPA-qualifying role, so the existing-application branch is what
    // actually answers this request.
    db.user_documents.push({ id: 'doc-cv-gp', user_id: GP.userId, document_key: 'career_cv', status: 'approved', updated_at: NOW });
    db.career_roles.find((r) => r.id === 'role-wd').dpa = true;

    // app-submitted (GP.userId, role-wd) was withdrawn earlier in this file
    // (DEFECT 2/3/4 block) and is the FIRST gp_applications row for this
    // (user, role) pair in insertion order, so the server's limit=1
    // existing-application lookup lands on it.
    expect(db.gp_applications.find((a) => a.id === 'app-submitted').status).toBe('withdrawn');

    const r = await gpPost('/api/career/apply', { roleId: ROLE_PUBLIC_ID });
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('previously_withdrawn');
    expect(r.body.message).toBe(EXPECTED_MESSAGE);

    // Nothing was reactivated.
    expect(db.gp_applications.find((a) => a.id === 'app-submitted').status).toBe('withdrawn');
  });

  it('POST /api/career/match/respond (accept) refuses to reactivate a withdrawn row AI-matching reopened to shortlisted', async () => {
    // The one structural path that can hand acceptShortlistedMatchRow a
    // withdrawn row: staff re-matching (POST /api/ats/matching/create's
    // reopen branch) moves ats_stage back to 'shortlisted' WITHOUT touching
    // status, so a withdrawn row can look "live" again by ats_stage alone.
    // Simulated directly here rather than via the full admin endpoint — the
    // guard must key off status, not ats_stage, and this isolates exactly
    // that.
    const row = db.gp_applications.find((a) => a.id === 'app-submitted');
    row.ats_stage = 'shortlisted';
    row.match_expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const r = await gpPost('/api/career/match/respond', { applicationId: 'app-submitted', action: 'accept' });
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('previously_withdrawn');
    expect(r.body.message).toBe(EXPECTED_MESSAGE);

    // Still withdrawn — not silently flipped back to 'applied'.
    expect(db.gp_applications.find((a) => a.id === 'app-submitted').status).toBe('withdrawn');
  });
});

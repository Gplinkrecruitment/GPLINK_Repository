// Phase 5 Task 4 — ATS "Needs attention" visibility (GAPs A3 + A5).
//
// Boots the real server against the same in-memory PostgREST emulator pattern
// as tests/ats-offer-flow.test.js / tests/career-internal-apply.test.js so the
// full Supabase-mode code paths run. Outbound email (Resend) is captured by
// wrapping global fetch.
//
// Covers:
//  1. GET /api/ats/attention returns the correct three counts for seeded
//     fixtures (one fresh application, one declined-offer app still in the offer
//     stage, one interview awaiting practice availability). Consultant can read it.
//  2. POST /api/career/apply fires an ops email to hello@mygplink.com.au with a
//     ?case= deep link — and the apply STILL succeeds when the email transport
//     throws.
//  3. Static UI pins: attention-strip markers, declined pill/kanban markers, and
//     the ceo-dashboard.html cache-busters.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ats-attention-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const SUPER_HOST = 'ceo-attn.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const CONSULTANT_EMAIL = 'consultant@gplink-test.local';
const APPLY_GP = { userId: 'u-apply-gp', email: 'apply@gplink-test.local' };
const NOW = new Date().toISOString();

const resendCalls = [];
let throwOnResend = false;

// ── In-memory PostgREST emulator ────────────────────────────────────────────
const db = {
  user_profiles: [
    { user_id: APPLY_GP.userId, email: APPLY_GP.email, first_name: 'Ada', last_name: 'Applicant', registration_country: 'australia' }
  ],
  user_state: [
    { user_id: APPLY_GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }
  ],
  user_documents: [
    // Task 4: /api/career/apply's CV gate now requires the verified careers
    // CV (document_key 'career_cv'), not a registration-file document.
    { id: 'doc-cv-apply', user_id: APPLY_GP.userId, document_key: 'career_cv', status: 'uploaded' }
  ],
  registration_cases: [
    { id: 'case-apply', user_id: APPLY_GP.userId, status: 'active', assigned_rso: null, assigned_va: null }
  ],
  career_roles: [
    { id: 'role-apply', provider: 'internal_ats', provider_role_id: 'ats_apply1', title: 'DPA - Rosebud - Mixed billing', practice_name: 'Peninsula Family Practice', practice_id: 'p-apply', location_city: 'Rosebud', location_state: 'VIC', is_active: true, job_status: 'open', dpa: true, updated_at: NOW }
  ],
  practices: [
    { id: 'p-apply', name: 'Peninsula Family Practice', source: 'internal_ats', is_active: true, created_at: NOW }
  ],
  // Attention fixtures:
  //   app-fresh    → ats_stage 'applied' within 7d      (new_applications = 1)
  //   app-declined → ats_stage 'offer' + declined offer (declined_offers  = 1)
  gp_applications: [
    { id: 'app-fresh', user_id: 'u-fresh', career_role_id: 'role-apply', provider_role_id: 'ats_apply1', status: 'applied', ats_stage: 'applied', applied_at: NOW },
    { id: 'app-declined', user_id: 'u-declined', career_role_id: 'role-apply', provider_role_id: 'ats_apply1', status: 'offered', ats_stage: 'offer', applied_at: NOW }
  ],
  ats_offers: [
    { id: 'offer-declined', application_id: 'app-declined', user_id: 'u-declined', career_role_id: 'role-apply', status: 'declined', created_at: NOW, updated_at: NOW }
  ],
  // interview requested, practice hasn't replied → interviews_awaiting = 1
  scheduled_calls: [
    { id: 'iv-1', user_id: 'u-declined', meeting_kind: 'interview', status: 'invited', practice_availability_status: 'requested', application_id: 'app-declined', career_role_id: 'role-apply', correlation_token: 'tok-iv-1', created_at: NOW, updated_at: NOW }
  ],
  ats_stage_events: [],
  registration_tasks: [],
  case_events: [],
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

// ── Session cookie minting ──────────────────────────────────────────────────
function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function adminCookieFor(email, adminRole) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function userCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
const superCookie = () => adminCookieFor(SUPER_EMAIL, 'super_admin');
const consultantCookie = () => adminCookieFor(CONSULTANT_EMAIL, 'consultant');

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

const atsGet = (p, cookie) => httpReq('GET', p, { host: SUPER_HOST, cookie: cookie || superCookie() });
const gpPost = (p, body, who = APPLY_GP) => httpReq('POST', p, { cookie: userCookie(who.email, who.userId), body });

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ats-attn-secret-' + RUN_ID;
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.PRACTICE_REMINDER_SKIP_WEEKENDS = 'false'; // deterministic cron test regardless of the day it runs
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.OPENAI_API_KEY = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = 'admin-attn.local';
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.CONSULTANT_EMAILS = CONSULTANT_EMAIL;
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 'test-resend-key';

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.resend.com/')) {
      if (throwOnResend) return Promise.reject(new Error('simulated email transport failure'));
      let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
      resendCalls.push({ url: u, body: parsed });
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
    }
    if (u.startsWith('https://fcm.googleapis.com/')) {
      return Promise.resolve(new Response('{}', { status: 200 }));
    }
    return realFetch(url, opts);
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

describe('GET /api/ats/attention — counts', () => {
  it('returns the three seeded counts for the CEO', async () => {
    const r = await atsGet('/api/ats/attention');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.new_applications).toBe(1);      // app-fresh (applied, <7d)
    expect(r.body.declined_offers).toBe(1);       // app-declined (declined offer, still in offer lane)
    expect(r.body.interviews_awaiting).toBe(1);   // iv-1 (requested)
  });

  it('is readable by a consultant session', async () => {
    const r = await atsGet('/api/ats/attention', consultantCookie());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.new_applications).toBe(1);
    expect(r.body.declined_offers).toBe(1);
    expect(r.body.interviews_awaiting).toBe(1);
  });

  it('rejects an unauthenticated caller', async () => {
    const r = await httpReq('GET', '/api/ats/attention', { host: SUPER_HOST });
    expect([401, 403]).toContain(r.status);
  });
});

describe('POST /api/career/apply — ops signal (GAP A3)', () => {
  it('emails hello@ with a ?case= deep link when a GP applies', async () => {
    const before = resendCalls.length;
    const r = await gpPost('/api/career/apply', { roleId: 'internal_ats:ats_apply1' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // Give the fire-and-forget notification block a tick to run.
    await new Promise((res) => setTimeout(res, 60));

    const sends = resendCalls.slice(before);
    const ops = sends.find((c) => /applied to/i.test(String(c.body && c.body.subject)) &&
      JSON.stringify(c.body || {}).includes('hello@mygplink.com.au'));
    expect(ops).toBeTruthy();
    expect(String(ops.body.subject)).toContain('Ada Applicant');
    expect(String(ops.body.subject)).toContain('Peninsula Family Practice');
    const opsText = JSON.stringify(ops.body || {});
    expect(opsText).toContain('?case=');
    expect(opsText).toMatch(/Has CV: yes/);
  });

  it('still succeeds (200 + row saved) when the email transport throws', async () => {
    // A different GP so the duplicate-application guard doesn't 409.
    const GP2 = { userId: 'u-apply-gp2', email: 'apply2@gplink-test.local' };
    db.user_profiles.push({ user_id: GP2.userId, email: GP2.email, first_name: 'Ben', last_name: 'Second', registration_country: 'australia' });
    db.user_state.push({ user_id: GP2.userId, state: { gp_onboarding_complete: true }, updated_at: NOW });
    db.user_documents.push({ id: 'doc-cv-apply2', user_id: GP2.userId, document_key: 'career_cv', status: 'uploaded' });
    db.registration_cases.push({ id: 'case-apply2', user_id: GP2.userId, status: 'active' });

    throwOnResend = true;
    try {
      const r = await gpPost('/api/career/apply', { roleId: 'internal_ats:ats_apply1' }, GP2);
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      await new Promise((res) => setTimeout(res, 60));
      const saved = db.gp_applications.find((a) => a.user_id === GP2.userId && a.career_role_id === 'role-apply');
      expect(saved).toBeTruthy();
    } finally {
      throwOnResend = false;
    }
  });
});

// Regression: the "New applications" tile counts applications per-application,
// but clicking it used to filter the candidate list by the collapsed
// furthest-stage bucket. A GP who already advanced on ONE role (e.g. interview)
// was bucketed 'interview' and hidden when you filtered by 'applied' — even
// though a brand-new application to a DIFFERENT practice is what the tile
// counted. This is the exact "Helen Wazalski applied but I can't see her" bug.
describe('GET /api/ceo/candidates — New applications reconciliation (fresh_applied)', () => {
  const HELEN = { userId: 'u-helen-wazalski', email: 'helen.w@gplink-test.local' };
  const SEVEN_DAYS_AGO = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();

  beforeAll(() => {
    db.user_profiles.push({ user_id: HELEN.userId, email: HELEN.email, first_name: 'Helen', last_name: 'Wazalski', registration_country: 'australia', onboarding_completed_at: NOW });
    db.registration_cases.push({ id: 'case-helen', user_id: HELEN.userId, status: 'active' });
    db.gp_applications.push(
      // Advanced application on one role (applied a while ago, now at interview):
      { id: 'app-helen-iv', user_id: HELEN.userId, career_role_id: 'role-apply', provider_role_id: 'ats_apply1', status: 'interview', ats_stage: 'interview', applied_at: '2026-07-08T00:00:00.000Z' },
      // Brand-new application to a DIFFERENT practice (fresh, within 7 days):
      { id: 'app-helen-new', user_id: HELEN.userId, career_role_id: 'role-other', provider_role_id: 'ats_other1', status: 'applied', ats_stage: 'applied', applied_at: SEVEN_DAYS_AGO }
    );
  });

  it('buckets her by her FURTHEST stage (interview), and flags has_fresh_applied', async () => {
    const r = await atsGet('/api/ceo/candidates?ats_bucket=interview');
    expect(r.status).toBe(200);
    const helen = (r.body.candidates || []).find((c) => c.user_id === HELEN.userId);
    expect(helen).toBeTruthy();
    expect(helen.pipeline_bucket).toBe('interview');
    expect(helen.has_fresh_applied).toBe(true);
  });

  it('does NOT surface her under the furthest-stage "applied" bucket (this is why she was invisible)', async () => {
    const r = await atsGet('/api/ceo/candidates?ats_bucket=applied');
    const helen = (r.body.candidates || []).find((c) => c.user_id === HELEN.userId);
    expect(helen).toBeFalsy();
  });

  it('DOES surface her under fresh_applied=1 — matching the "New applications" tile', async () => {
    const r = await atsGet('/api/ceo/candidates?fresh_applied=1');
    expect(r.status).toBe(200);
    const helen = (r.body.candidates || []).find((c) => c.user_id === HELEN.userId);
    expect(helen).toBeTruthy();
    expect(helen.name).toContain('Helen');
  });

  it('the fresh_applied list matches the attention tile definition (both count her fresh apply)', async () => {
    const attn = await atsGet('/api/ats/attention');
    const fresh = await atsGet('/api/ceo/candidates?fresh_applied=1');
    // The tile counts >=1 new application, and the reconciled list surfaces the GP behind it.
    expect(attn.body.new_applications).toBeGreaterThanOrEqual(1);
    expect((fresh.body.candidates || []).some((c) => c.user_id === HELEN.userId)).toBe(true);
  });
});

// The "New applications" action queue: one row per fresh pending application,
// enriched with GP name + practice + submit eligibility, so the CEO can submit
// or withdraw without opening each candidate.
describe('GET /api/ats/new-applications — action queue', () => {
  const NADIA = { userId: 'u-nadia-newapp', email: 'nadia@gplink-test.local' };
  const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  beforeAll(() => {
    db.user_profiles.push({ user_id: NADIA.userId, email: NADIA.email, first_name: 'Nadia', last_name: 'Newapp', registration_country: 'australia', onboarding_completed_at: NOW });
    db.registration_cases.push({ id: 'case-nadia', user_id: NADIA.userId, status: 'active' });
    db.user_documents.push({ id: 'doc-cv-nadia', user_id: NADIA.userId, document_key: 'career_cv', status: 'uploaded' });
    db.career_roles.push({ id: 'role-nadia', provider: 'internal_ats', provider_role_id: 'ats_nadia1', title: 'GP - Mixed billing', practice_name: 'Coastline Medical', practice_id: 'p-nadia', location_city: 'Torquay', location_state: 'VIC', is_active: true, job_status: 'open', dpa: true, updated_at: NOW });
    db.gp_applications.push(
      // Fresh + pending → belongs in the queue, submit-eligible
      { id: 'app-nadia-fresh', user_id: NADIA.userId, career_role_id: 'role-nadia', provider_role_id: 'ats_nadia1', status: 'applied', ats_stage: 'applied', applied_at: NOW },
      // Older than 7 days → excluded
      { id: 'app-nadia-old', user_id: NADIA.userId, career_role_id: 'role-nadia', provider_role_id: 'ats_nadia1', status: 'applied', ats_stage: 'applied', applied_at: OLD },
      // Already submitted (stage past applied) → excluded
      { id: 'app-nadia-submitted', user_id: NADIA.userId, career_role_id: 'role-nadia', provider_role_id: 'ats_nadia1', status: 'review', ats_stage: 'submitted', applied_at: NOW, practice_submission_status: 'submitted_to_practice' }
    );
  });

  it('returns the fresh pending application enriched for the queue', async () => {
    const r = await atsGet('/api/ats/new-applications');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const row = (r.body.applications || []).find((a) => a.id === 'app-nadia-fresh');
    expect(row).toBeTruthy();
    expect(row.gp_name).toBe('Nadia Newapp');
    expect(row.practice_name).toBe('Coastline Medical');
    expect(row.role_title).toBe('GP - Mixed billing');
    expect(row.can_submit_to_practice).toBe(true);
    expect(row.has_cv).toBe(true);
    expect(row.case_id).toBe('case-nadia'); // row-click can open the candidate drawer
  });

  it('excludes applications older than 7 days and ones already submitted', async () => {
    const r = await atsGet('/api/ats/new-applications');
    const ids = (r.body.applications || []).map((a) => a.id);
    expect(ids).not.toContain('app-nadia-old');
    expect(ids).not.toContain('app-nadia-submitted');
  });

  it('its length reconciles with the attention tile count', async () => {
    const attn = await atsGet('/api/ats/attention');
    const queue = await atsGet('/api/ats/new-applications');
    expect((queue.body.applications || []).length).toBe(attn.body.new_applications);
  });

  it('is readable by a consultant session', async () => {
    const r = await atsGet('/api/ats/new-applications', consultantCookie());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('rejects an unauthenticated caller', async () => {
    const r = await httpReq('GET', '/api/ats/new-applications', { host: SUPER_HOST });
    expect([401, 403]).toContain(r.status);
  });
});

// "Waiting on practice" tracker + the practice-decision reminder engine.
describe('GET /api/ats/waiting-on-practice + reminders', () => {
  const WAIT = { userId: 'u-wait-gp', email: 'wait@gplink-test.local' };
  const EIGHT_DAYS_AGO = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  beforeAll(() => {
    db.user_profiles.push({ user_id: WAIT.userId, email: WAIT.email, first_name: 'Wendy', last_name: 'Waiting', registration_country: 'australia', onboarding_completed_at: NOW });
    db.registration_cases.push({ id: 'case-wait', user_id: WAIT.userId, status: 'active' });
    db.career_roles.push({ id: 'role-wait', provider: 'internal_ats', provider_role_id: 'ats_wait1', title: 'GP - Waiting', practice_name: 'Seaside Medical', practice_id: 'p-wait', location_city: 'Torquay', location_state: 'VIC', is_active: true, job_status: 'open', updated_at: NOW });
    db.gp_applications.push(
      // Awaiting, submitted 8 days ago, 2 reminders already sent → belongs in tracker, chase=true
      { id: 'app-wait-chase', user_id: WAIT.userId, career_role_id: 'role-wait', provider_role_id: 'ats_wait1', status: 'review', ats_stage: 'submitted', applied_at: EIGHT_DAYS_AGO, practice_submission_status: 'submitted_to_practice', submitted_to_practice_at: EIGHT_DAYS_AGO, practice_contact_email: 'contact@seaside.example', practice_action_token: 'wait-tok-1', practice_reminder_count: 2 },
      // Practice turned it down but the card wasn't tidied → shows as "declined"
      { id: 'app-wait-declined', user_id: WAIT.userId, career_role_id: 'role-wait', provider_role_id: 'ats_wait1', status: 'review', ats_stage: 'submitted', applied_at: NOW, practice_submission_status: 'submitted_to_practice', submitted_to_practice_at: NOW, practice_decision: 'turned_down', practice_decision_reason: 'not right now', practice_contact_email: 'contact@seaside.example', practice_action_token: 'wait-tok-2' },
      // Approved → advanced to interview → must NOT appear in the tracker
      { id: 'app-wait-approved', user_id: WAIT.userId, career_role_id: 'role-wait', provider_role_id: 'ats_wait1', status: 'interview', ats_stage: 'interview', applied_at: NOW, practice_submission_status: 'client_approved', practice_decision: 'approved', submitted_to_practice_at: NOW }
    );
  });

  it('lists awaiting + declined submissions, enriched, and flags the day-7 chase', async () => {
    const r = await atsGet('/api/ats/waiting-on-practice');
    expect(r.status).toBe(200);
    const rows = r.body.applications || [];
    const chase = rows.find((a) => a.id === 'app-wait-chase');
    expect(chase).toBeTruthy();
    expect(chase.gp_name).toBe('Wendy Waiting');
    expect(chase.practice_name).toBe('Seaside Medical');
    expect(chase.status).toBe('awaiting');
    expect(chase.days_waiting).toBeGreaterThanOrEqual(7);
    expect(chase.chase).toBe(true);
    expect(chase.reminder_count).toBe(2);
    expect(chase.case_id).toBe('case-wait');
    const declined = rows.find((a) => a.id === 'app-wait-declined');
    expect(declined).toBeTruthy();
    expect(declined.status).toBe('declined');
    expect(declined.decline_reason).toBe('not right now');
  });

  it('excludes an application the practice already approved (now at interview)', async () => {
    const r = await atsGet('/api/ats/waiting-on-practice');
    const ids = (r.body.applications || []).map((a) => a.id);
    expect(ids).not.toContain('app-wait-approved');
  });

  it('the attention tile counts waiting_on_practice + waiting_chase', async () => {
    const r = await atsGet('/api/ats/attention');
    expect(r.body.waiting_on_practice).toBeGreaterThanOrEqual(1);
    expect(r.body.waiting_chase).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/ats/application/remind-practice emails the practice and bumps the count', async () => {
    const before = resendCalls.length;
    const r = await httpReq('POST', '/api/ats/application/remind-practice', { host: SUPER_HOST, cookie: superCookie(), body: { applicationId: 'app-wait-chase' } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const sent = resendCalls.slice(before);
    const toPractice = sent.find((c) => JSON.stringify(c.body || {}).includes('contact@seaside.example'));
    expect(toPractice).toBeTruthy();
    expect(String(toPractice.body.subject)).toMatch(/reminder/i);
    // count bumped 2 → 3
    const row = db.gp_applications.find((a) => a.id === 'app-wait-chase');
    expect(row.practice_reminder_count).toBe(3);
    expect(row.last_practice_reminder_at).toBeTruthy();
  });

  it('refuses to remind once the practice has already responded (409)', async () => {
    const r = await httpReq('POST', '/api/ats/application/remind-practice', { host: SUPER_HOST, cookie: superCookie(), body: { applicationId: 'app-wait-declined' } });
    expect(r.status).toBe(409);
  });

  it('is readable by a consultant session', async () => {
    const r = await atsGet('/api/ats/waiting-on-practice', consultantCookie());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

describe('cron: practice-decision-reminders', () => {
  const THREE_DAYS_AGO = new Date(Date.now() - 3.5 * 24 * 60 * 60 * 1000).toISOString();
  beforeAll(() => {
    db.gp_applications.push({ id: 'app-cron-day3', user_id: 'u-wait-gp', career_role_id: 'role-wait', provider_role_id: 'ats_wait1', status: 'review', ats_stage: 'submitted', applied_at: THREE_DAYS_AGO, practice_submission_status: 'submitted_to_practice', submitted_to_practice_at: THREE_DAYS_AGO, practice_contact_email: 'contact3@seaside.example', practice_action_token: 'cron-tok-3', practice_reminder_count: 0 });
  });

  it('day-3 sends the first practice reminder; day-7 flags a chase + emails the owner', async () => {
    const before = resendCalls.length;
    const r = await httpReq('GET', '/api/cron/practice-decision-reminders', { host: SUPER_HOST, bearer: 'test-cron-secret' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const sent = resendCalls.slice(before);
    // day-3 app got its first auto-reminder, count 0 → 1
    const day3 = db.gp_applications.find((a) => a.id === 'app-cron-day3');
    expect(day3.practice_reminder_count).toBe(1);
    expect(sent.some((c) => JSON.stringify(c.body || {}).includes('contact3@seaside.example'))).toBe(true);
    // day-8 app (no more auto-reminders — count already 2+) gets the chase flag + owner email
    const chaseApp = db.gp_applications.find((a) => a.id === 'app-wait-chase');
    expect(chaseApp.practice_chase_flagged_at).toBeTruthy();
    expect(sent.some((c) => /chase needed/i.test(String(c.body && c.body.subject)))).toBe(true);
  });

  it('rejects an unauthenticated cron call', async () => {
    const r = await httpReq('GET', '/api/cron/practice-decision-reminders', { host: SUPER_HOST });
    expect(r.status).toBe(401);
  });
});

describe('static UI pins', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('candidates JS renders the attention strip + declined pill', () => {
    const js = read('js/ceo-ats-candidates.js');
    expect(js).toContain('ats-attention-strip');
    expect(js).toContain('/api/ats/attention');
    expect(js).toContain('data-attention=');
    expect(js).toContain('Needs attention');
    expect(js).toContain('Declined — action needed');
    expect(js).toContain('data-offer-declined');
  });

  it('candidates JS wires the New-applications tile to the fresh_applied filter', () => {
    const js = read('js/ceo-ats-candidates.js');
    expect(js).toContain('fresh_applied');
    expect(js).toContain('&fresh_applied=1');
    // The "New applications" (applied) tile must NOT reuse the furthest-stage bucket filter.
    expect(js).toContain("bucket === 'applied'");
    expect(js).toContain('Showing: <b>New applications</b>');
  });

  it('candidates JS renders the Waiting-on-practice tracker + wires Nudge/decline', () => {
    const js = read('js/ceo-ats-candidates.js');
    expect(js).toContain('/api/ats/waiting-on-practice');
    expect(js).toContain('function fetchAndRenderWaitingOnPractice');
    expect(js).toContain("data-attention=\"waiting\"");
    expect(js).toContain('Waiting on practice');
    expect(js).toContain('ats-wait-nudge');
    expect(js).toContain('/api/ats/application/remind-practice');
  });

  it('candidates JS renders the New-applications action queue with inline Submit/Withdraw', () => {
    const js = read('js/ceo-ats-candidates.js');
    expect(js).toContain('/api/ats/new-applications');
    expect(js).toContain('function fetchAndRenderNewApplications');
    expect(js).toContain('function renderList');            // dispatcher: queue vs candidate list
    expect(js).toContain('ats-newapp-submit');
    expect(js).toContain('ats-newapp-withdraw');
    // Inline actions reuse the existing endpoints, not a parallel copy.
    expect(js).toContain('/api/admin/career/application/submit-to-practice');
    expect(js).toContain('openWithdrawReasonPrompt');
  });

  it('jobs JS renders the kanban declined marker', () => {
    const js = read('js/ceo-ats-jobs.js');
    expect(js).toContain('ats-card-declined');
    expect(js).toContain("c.offer_status === 'declined'");
  });

  it('ceo-dashboard.html bumps the changed script cache-busters', () => {
    const html = read('pages/ceo-dashboard.html');
    expect(html).toContain('ceo-ats-candidates.js?v=20260731a');
    expect(html).toContain('ceo-ats-jobs.js?v=20260729a');
  });
});

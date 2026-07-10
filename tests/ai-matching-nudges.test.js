// Matching Board Task 1 (2026-07-11 spec, Part B) — nudge stamp columns.
//
// Source-wiring block only: confirms the migration file exists and declares
// both nudge timestamp columns. Extended below with endpoint/behavior
// coverage for Task 2 (24h copy upgrade + 2h final-call nudge).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

describe('Matching Board Task 1 — nudge stamp migration source wiring', () => {
  const migrationPath = path.join(ROOT, 'supabase/migrations/20260711220000_match_nudges.sql');

  it('migration file exists', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('adds both nudge stamp columns to gp_applications', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toContain('ALTER TABLE public.gp_applications');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS match_final_reminder_sent_at TIMESTAMPTZ');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS match_more_time_requested_at TIMESTAMPTZ');
  });

  it('reloads PostgREST schema cache after the DDL change', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
  });
});

// ============================================================================
// Task 2 (2026-07-11 nudges plan): 24h copy upgrade + 2h final-call nudge.
//
// Boots the real server against a tiny in-memory PostgREST emulator (same
// pattern as tests/ai-matching-cron.test.js), so the reminder AND final-call
// passes exercise the real sendMatchEmail/buildMatchEmailHtml, PLUS the
// admin-session cookie machinery from tests/ai-matching-pipeline.test.js (so
// the same boot also exercises PATCH /api/ats/application {match_extend}).
// ============================================================================
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ai-matching-nudges-${RUN_ID}.json`);
const SUPER_HOST = 'ats-nudges-test.local';
let server, port;
let sbServer, sbPort;
const resendCalls = [];
let realFetch;

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const REMIND24_GP = { userId: 'gp-remind24-1', email: 'remind24@gplink-test.local' };
const OUTSIDE30_GP = { userId: 'gp-outside30-1', email: 'outside30@gplink-test.local' };
const FINAL_GP = { userId: 'gp-final-1', email: 'final@gplink-test.local' };
const FINAL_ACCEPTED_GP = { userId: 'gp-final-accepted-1', email: 'final-accepted@gplink-test.local' };
const FINAL_ALREADY_GP = { userId: 'gp-final-already-1', email: 'final-already@gplink-test.local' };
const EXTEND_GP = { userId: 'gp-extend-1', email: 'extend@gplink-test.local' };

const ALL_GPS = [REMIND24_GP, OUTSIDE30_GP, FINAL_GP, FINAL_ACCEPTED_GP, FINAL_ALREADY_GP, EXTEND_GP];

// Fixed already-set stamp used by app-final-already-1 so the "must not be
// re-stamped" assertion can check it's byte-identical after the cron run.
const ALREADY_FINAL_STAMP = iso(NOW - 10 * 60000);

// ── Task 3 (2026-07-11 nudges plan) fixtures: POST /api/career/match/need-more-time.
// Separate GP-session (not admin-session) fixtures — kept out of ALL_GPS/the
// shared user_profiles map so each gets a distinctive display name for the
// verbatim ops-email subject assertion below.
const NEEDTIME_LIVE_GP = { userId: 'gp-needtime-live-1', email: 'needtime-live@gplink-test.local' };
const NEEDTIME_EXPIRED_GP = { userId: 'gp-needtime-expired-1', email: 'needtime-expired@gplink-test.local' };
const NEEDTIME_RESOLVED_GP = { userId: 'gp-needtime-resolved-1', email: 'needtime-resolved@gplink-test.local' };
const NEEDTIME_GATED_GP = { userId: 'gp-needtime-gated-1', email: 'needtime-gated@gplink-test.local' };
const NEEDTIME_OTHER_GP = { userId: 'gp-needtime-other-1', email: 'needtime-other@gplink-test.local' };

// ── In-memory PostgREST emulator (mirrors tests/ai-matching-cron.test.js) ───
const db = {
  user_profiles: ALL_GPS.map((g, i) => ({
    user_id: g.userId, email: g.email, first_name: 'Test', last_name: `Nudge${i}`,
    registration_country: 'united kingdom'
  })).concat([
    { user_id: NEEDTIME_LIVE_GP.userId, email: NEEDTIME_LIVE_GP.email, first_name: 'Amara', last_name: 'Chen', registration_country: 'united kingdom' },
    { user_id: NEEDTIME_EXPIRED_GP.userId, email: NEEDTIME_EXPIRED_GP.email, first_name: 'Priya', last_name: 'Nair', registration_country: 'united kingdom' },
    { user_id: NEEDTIME_RESOLVED_GP.userId, email: NEEDTIME_RESOLVED_GP.email, first_name: 'Owen', last_name: 'Baxter', registration_country: 'united kingdom' },
    { user_id: NEEDTIME_GATED_GP.userId, email: NEEDTIME_GATED_GP.email, first_name: 'Test', last_name: 'NeedtimeGated', registration_country: 'united kingdom' },
    { user_id: NEEDTIME_OTHER_GP.userId, email: NEEDTIME_OTHER_GP.email, first_name: 'Test', last_name: 'NeedtimeOther', registration_country: 'united kingdom' }
  ]),
  user_state: [
    { user_id: NEEDTIME_LIVE_GP.userId, state: { gp_onboarding_complete: true }, updated_at: iso(NOW) },
    { user_id: NEEDTIME_EXPIRED_GP.userId, state: { gp_onboarding_complete: true }, updated_at: iso(NOW) },
    { user_id: NEEDTIME_RESOLVED_GP.userId, state: { gp_onboarding_complete: true }, updated_at: iso(NOW) },
    { user_id: NEEDTIME_GATED_GP.userId, state: { gp_onboarding_complete: true, account_status: 'under_review' }, updated_at: iso(NOW) },
    { user_id: NEEDTIME_OTHER_GP.userId, state: { gp_onboarding_complete: true }, updated_at: iso(NOW) }
  ],
  registration_cases: [],
  rso_team: [],
  ats_stage_events: [],
  practices: [
    { id: 'prac-1', name: 'Coral Coast Family Practice', website: 'https://coralcoastfamilypractice.com.au', intro_video_url: '' }
  ],
  career_roles: [
    {
      id: 'job-1', title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      practice_id: 'prac-1', location_city: 'Bundaberg', location_state: 'QLD', dpa: true,
      billing_model: 'Mixed billing', job_status: 'open', is_active: true
    }
  ],
  gp_applications: [
    // 24h reminder pass should pick this one up: shortlisted + matched +
    // expires in 20h (inside the 24h window) + never reminded.
    {
      id: 'app-remind24-1', user_id: REMIND24_GP.userId, career_role_id: 'job-1',
      ats_stage: 'shortlisted', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_reasons: { reasons: ['Coastal Queensland fit'] },
      matched_at: iso(NOW - 2 * 86400000), match_expires_at: iso(NOW + 20 * 3600000),
      match_reminder_sent_at: null, match_final_reminder_sent_at: null, match_more_time_requested_at: null, match_outcome: null
    },
    // Outside BOTH the 24h and 2h windows (expires in 30h) — must never be
    // touched by either pass.
    {
      id: 'app-outside30-1', user_id: OUTSIDE30_GP.userId, career_role_id: 'job-1',
      ats_stage: 'shortlisted', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_reasons: { reasons: [] },
      matched_at: iso(NOW - 1 * 86400000), match_expires_at: iso(NOW + 30 * 3600000),
      match_reminder_sent_at: null, match_final_reminder_sent_at: null, match_more_time_requested_at: null, match_outcome: null
    },
    // 2h final-call pass should pick this one up: expires in 90 minutes,
    // already got its 24h reminder earlier (match_reminder_sent_at set),
    // never had a final call.
    {
      id: 'app-final-1', user_id: FINAL_GP.userId, career_role_id: 'job-1',
      ats_stage: 'shortlisted', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_reasons: { reasons: ['Coastal Queensland fit'] },
      matched_at: iso(NOW - 4 * 86400000), match_expires_at: iso(NOW + 90 * 60000),
      match_reminder_sent_at: iso(NOW - 3 * 3600000), match_final_reminder_sent_at: null, match_more_time_requested_at: null, match_outcome: null
    },
    // Same 2h window, but already accepted — match_outcome is no longer
    // null, so the final-call pass must skip it entirely.
    {
      id: 'app-final-accepted-1', user_id: FINAL_ACCEPTED_GP.userId, career_role_id: 'job-1',
      ats_stage: 'shortlisted', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_reasons: { reasons: [] },
      matched_at: iso(NOW - 4 * 86400000), match_expires_at: iso(NOW + 90 * 60000),
      match_reminder_sent_at: iso(NOW - 3 * 3600000), match_final_reminder_sent_at: null, match_more_time_requested_at: null, match_outcome: 'accepted'
    },
    // Same 2h window, but already final-called (idempotency fixture) — must
    // not be re-sent or re-stamped.
    {
      id: 'app-final-already-1', user_id: FINAL_ALREADY_GP.userId, career_role_id: 'job-1',
      ats_stage: 'shortlisted', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_reasons: { reasons: [] },
      matched_at: iso(NOW - 4 * 86400000), match_expires_at: iso(NOW + 90 * 60000),
      match_reminder_sent_at: iso(NOW - 3 * 3600000), match_final_reminder_sent_at: ALREADY_FINAL_STAMP, match_more_time_requested_at: null, match_outcome: null
    },
    // Extend fixture: a lifecycle-swept row (not_proceeding/expired, the
    // legit "click Extend" case) carrying all three nudge stamps, so the
    // match_extend PATCH test can prove all three are cleared.
    {
      id: 'app-extend-1', user_id: EXTEND_GP.userId, career_role_id: 'job-1',
      ats_stage: 'not_proceeding', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_reasons: { reasons: [] },
      matched_at: iso(NOW - 7 * 86400000), match_expires_at: iso(NOW - 2 * 86400000), match_outcome: 'expired',
      match_reminder_sent_at: iso(NOW - 3 * 86400000), match_final_reminder_sent_at: iso(NOW - 2 * 86400000), match_more_time_requested_at: iso(NOW - 2 * 86400000)
    },
    // Task 3 (2026-07-11 nudges plan): POST /api/career/match/need-more-time fixtures.
    // Live, unstamped — the "noted" + idempotent-"already" pair (same row, two calls).
    {
      id: 'app-needtime-live-1', user_id: NEEDTIME_LIVE_GP.userId, career_role_id: 'job-1',
      ats_stage: 'shortlisted', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_reasons: { reasons: [] },
      matched_at: iso(NOW - 3 * 86400000), match_expires_at: iso(NOW + 2 * 86400000),
      match_reminder_sent_at: null, match_final_reminder_sent_at: null, match_more_time_requested_at: null, match_outcome: null
    },
    // Still 'shortlisted' but match_expires_at is in the past — the lifecycle
    // cron hasn't swept it yet (mirrors app-expired-1 in ai-matching-gp-flow).
    // matched_at is deliberately null: the lifecycle cron's expiry-sweep
    // filter requires matched_at=not.is.null, and this fixture must NOT be
    // picked up by that cron pass (it belongs only to this describe block) —
    // need-more-time's own classification never reads matched_at anyway.
    {
      id: 'app-needtime-expired-1', user_id: NEEDTIME_EXPIRED_GP.userId, career_role_id: 'job-1',
      ats_stage: 'shortlisted', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_reasons: { reasons: [] },
      matched_at: null, match_expires_at: iso(NOW - 3600000),
      match_reminder_sent_at: null, match_final_reminder_sent_at: null, match_more_time_requested_at: null, match_outcome: null
    },
    // Already accepted — ats_stage moved off 'shortlisted', so the row reads
    // as resolved regardless of how much time is left on match_expires_at.
    {
      id: 'app-needtime-resolved-1', user_id: NEEDTIME_RESOLVED_GP.userId, career_role_id: 'job-1',
      ats_stage: 'applied', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_reasons: { reasons: [] },
      matched_at: iso(NOW - 3 * 86400000), match_expires_at: iso(NOW + 2 * 86400000),
      match_reminder_sent_at: null, match_final_reminder_sent_at: null, match_more_time_requested_at: null, match_outcome: 'accepted'
    },
    // Live, owned by NEEDTIME_GATED_GP whose account_status is under_review —
    // the account gate must block this before any row/email logic runs.
    {
      id: 'app-needtime-gated-1', user_id: NEEDTIME_GATED_GP.userId, career_role_id: 'job-1',
      ats_stage: 'shortlisted', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_reasons: { reasons: [] },
      matched_at: iso(NOW - 3 * 86400000), match_expires_at: iso(NOW + 2 * 86400000),
      match_reminder_sent_at: null, match_final_reminder_sent_at: null, match_more_time_requested_at: null, match_outcome: null
    }
  ]
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
        if (orderParam.startsWith('match_expires_at')) {
          out = out.slice().sort((a, b) => new Date(a.match_expires_at || 0) - new Date(b.match_expires_at || 0));
        }
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

function httpReq(method, p, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const finalHeaders = Object.assign({}, headers || {});
    if (data) { finalHeaders['Content-Type'] = 'application/json'; finalHeaders['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: finalHeaders }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject);
    r.end(data);
  });
}

// ── Admin session cookie (mirrors tests/ai-matching-pipeline.test.js) ───────
function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}

// ── GP session cookie (mirrors tests/ai-matching-gp-flow.test.js's userCookie) ──
function userCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}

const CRON_SECRET = 'match-lifecycle-cron-secret-' + RUN_ID;
const callCron = () => httpReq('GET', '/api/cron/match-lifecycle', { headers: { Authorization: 'Bearer ' + CRON_SECRET } });

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'ai-matching-nudges-secret-' + RUN_ID;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.OPENAI_API_KEY = '';
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';

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

describe('GET /api/cron/match-lifecycle — 24h copy upgrade + 2h final-call nudge (Task 2, 2026-07-11 nudges plan)', () => {
  it('single run: reminds the 24h row and final-calls the 2h row with the new verbatim copy, excluding accepted/already-called/out-of-window rows', async () => {
    const r = await callCron();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.reminded).toBe(1);
    expect(r.body.finalCalled).toBe(1);
    expect(r.body.expired).toBe(0);
    expect(r.body.timedOut).toBe(false);
    expect(Object.keys(r.body).sort()).toEqual(['errors', 'expired', 'finalCalled', 'ok', 'reminded', 'timedOut']);
    expect(Array.isArray(r.body.errors)).toBe(true);
    expect(r.body.errors.length).toBe(0);

    // ── 24h reminder pass: app-remind24-1 ──────────────────────────────────
    const reminderCall = resendCalls.find((c) => (c.body.to || []).includes(REMIND24_GP.email));
    expect(reminderCall).toBeTruthy();
    expect(reminderCall.body.subject).toBe('24 hours left — Coral Coast Family Practice is holding your spot');
    expect(reminderCall.body.html).toContain('Review &amp; accept my match');
    expect(reminderCall.body.html).toContain('Not the right fit? Tell us why');
    expect(reminderCall.body.html).toContain('98%');
    expect(reminderCall.body.html).toContain('of GPs we match are accepted by the practice.');

    const remindRow = db.gp_applications.find((a) => a.id === 'app-remind24-1');
    expect(remindRow.match_reminder_sent_at).toBeTruthy();

    // ── 2h final-call pass: app-final-1 ────────────────────────────────────
    const finalCall = resendCalls.find((c) => (c.body.to || []).includes(FINAL_GP.email));
    expect(finalCall).toBeTruthy();
    expect(finalCall.body.subject).toMatch(/^Final call — your match expires at \d{1,2}:\d{2} (am|pm) (today|tomorrow)$/);
    expect(finalCall.body.html).toContain('Accept before it expires');
    // Assert on a distinctive substring rather than the exact HTML-escaping
    // of the apostrophe in "I'm interested — I need more time" (the builder
    // may render it as &#39; or a raw apostrophe — either is correct).
    expect(finalCall.body.html).toContain('need more time');
    expect(finalCall.body.html).toContain('needtime%3D1');
    expect(finalCall.body.html).toContain('98%');
    expect(finalCall.body.html).toContain('of GPs we match are accepted by the practice.');

    const finalRow = db.gp_applications.find((a) => a.id === 'app-final-1');
    expect(finalRow.match_final_reminder_sent_at).toBeTruthy();

    // ── Excluded rows ───────────────────────────────────────────────────────
    expect(resendCalls.some((c) => (c.body.to || []).includes(FINAL_ACCEPTED_GP.email))).toBe(false);
    expect(resendCalls.some((c) => (c.body.to || []).includes(FINAL_ALREADY_GP.email))).toBe(false);
    expect(resendCalls.some((c) => (c.body.to || []).includes(OUTSIDE30_GP.email))).toBe(false);

    const acceptedRow = db.gp_applications.find((a) => a.id === 'app-final-accepted-1');
    expect(acceptedRow.match_final_reminder_sent_at).toBeFalsy();

    const alreadyRow = db.gp_applications.find((a) => a.id === 'app-final-already-1');
    expect(alreadyRow.match_final_reminder_sent_at).toBe(ALREADY_FINAL_STAMP);

    const outsideRow = db.gp_applications.find((a) => a.id === 'app-outside30-1');
    expect(outsideRow.match_reminder_sent_at).toBeFalsy();
    expect(outsideRow.match_final_reminder_sent_at).toBeFalsy();

    // Exactly two emails this run (the reminder + the final call) — no
    // summary ops email (nothing expired yet), nothing else.
    expect(resendCalls.length).toBe(2);
  });

  it('is idempotent on a second run: neither the reminded nor the final-called row is re-sent', async () => {
    resendCalls.length = 0;
    const r = await callCron();
    expect(r.status).toBe(200);
    expect(r.body.reminded).toBe(0);
    expect(r.body.finalCalled).toBe(0);
    expect(resendCalls.length).toBe(0);
  });
});

describe('PATCH /api/ats/application {match_extend:true} — clears all three nudge stamps (Task 2, 2026-07-11 nudges plan)', () => {
  it('resets match_reminder_sent_at, match_final_reminder_sent_at, and match_more_time_requested_at to null', async () => {
    const before = db.gp_applications.find((a) => a.id === 'app-extend-1');
    expect(before.match_reminder_sent_at).toBeTruthy();
    expect(before.match_final_reminder_sent_at).toBeTruthy();
    expect(before.match_more_time_requested_at).toBeTruthy();

    const r = await httpReq('PATCH', '/api/ats/application?id=app-extend-1', {
      headers: { Host: SUPER_HOST, Cookie: superCookie() },
      body: { match_extend: true }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.application.ats_stage).toBe('shortlisted');

    const after = db.gp_applications.find((a) => a.id === 'app-extend-1');
    expect(after.match_reminder_sent_at).toBe(null);
    expect(after.match_final_reminder_sent_at).toBe(null);
    expect(after.match_more_time_requested_at).toBe(null);
    expect(after.ats_stage).toBe('shortlisted');
    expect(after.match_outcome).toBe(null);
  });
});

// ============================================================================
// Task 3 (2026-07-11 nudges plan): POST /api/career/match/need-more-time — the
// 2h final-call email's secondary CTA (`&needtime=1` deep link, Task 2).
// Clones the still-interested/respond session-ownership-row-loading-expiry
// pattern (tests/ai-matching-gp-flow.test.js), but as a GP-session (not
// admin-session) endpoint, so it uses the userCookie() helper above.
// ============================================================================
describe('POST /api/career/match/need-more-time (Task 3, 2026-07-11 nudges plan)', () => {
  it('live + unstamped: notes the request, stamps the column, and sends exactly one verbatim ops email; a second call is idempotent', async () => {
    resendCalls.length = 0;
    const expectedSubject = 'GP asked for more time — Amara Chen × Coral Coast Family Practice';

    const before = db.gp_applications.find((a) => a.id === 'app-needtime-live-1');
    expect(before.match_more_time_requested_at).toBeNull();

    const first = await httpReq('POST', '/api/career/match/need-more-time', {
      headers: { Cookie: userCookie(NEEDTIME_LIVE_GP.email, NEEDTIME_LIVE_GP.userId) },
      body: { applicationId: 'app-needtime-live-1' }
    });
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.state).toBe('noted');

    const after = db.gp_applications.find((a) => a.id === 'app-needtime-live-1');
    expect(after.match_more_time_requested_at).toBeTruthy();

    const opsEmails = resendCalls.filter((c) => c.body && c.body.subject === expectedSubject);
    expect(opsEmails.length).toBe(1);
    expect(opsEmails[0].body.to).toEqual(['hello@mygplink.com.au']);
    expect(opsEmails[0].body.text).toContain('Extend 5 days');

    // Second call on the now-stamped row: 'already', no new email.
    const second = await httpReq('POST', '/api/career/match/need-more-time', {
      headers: { Cookie: userCookie(NEEDTIME_LIVE_GP.email, NEEDTIME_LIVE_GP.userId) },
      body: { applicationId: 'app-needtime-live-1' }
    });
    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(true);
    expect(second.body.state).toBe('already');
    // Stamp is unchanged (still the same value the first call wrote).
    expect(db.gp_applications.find((a) => a.id === 'app-needtime-live-1').match_more_time_requested_at).toBe(after.match_more_time_requested_at);
    expect(resendCalls.filter((c) => c.body && c.body.subject === expectedSubject).length).toBe(1);
  });

  it('expired (unswept) row: state expired, no stamp, no email', async () => {
    resendCalls.length = 0;
    const res = await httpReq('POST', '/api/career/match/need-more-time', {
      headers: { Cookie: userCookie(NEEDTIME_EXPIRED_GP.email, NEEDTIME_EXPIRED_GP.userId) },
      body: { applicationId: 'app-needtime-expired-1' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.state).toBe('expired');
    expect(db.gp_applications.find((a) => a.id === 'app-needtime-expired-1').match_more_time_requested_at).toBeNull();
    expect(resendCalls.length).toBe(0);
  });

  it('resolved (already accepted) row: state resolved, no stamp, no email', async () => {
    resendCalls.length = 0;
    const res = await httpReq('POST', '/api/career/match/need-more-time', {
      headers: { Cookie: userCookie(NEEDTIME_RESOLVED_GP.email, NEEDTIME_RESOLVED_GP.userId) },
      body: { applicationId: 'app-needtime-resolved-1' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.state).toBe('resolved');
    expect(db.gp_applications.find((a) => a.id === 'app-needtime-resolved-1').match_more_time_requested_at).toBeNull();
    expect(resendCalls.length).toBe(0);
  });

  it('is account-gated + owner-scoped: gated account -> 403, wrong-owner applicationId -> 404', async () => {
    resendCalls.length = 0;
    const gated = await httpReq('POST', '/api/career/match/need-more-time', {
      headers: { Cookie: userCookie(NEEDTIME_GATED_GP.email, NEEDTIME_GATED_GP.userId) },
      body: { applicationId: 'app-needtime-gated-1' }
    });
    expect(gated.status).toBe(403);
    expect(gated.body.error).toBe('account_gated');

    const wrongOwner = await httpReq('POST', '/api/career/match/need-more-time', {
      headers: { Cookie: userCookie(NEEDTIME_OTHER_GP.email, NEEDTIME_OTHER_GP.userId) },
      body: { applicationId: 'app-needtime-live-1' }
    });
    expect(wrongOwner.status).toBe(404);
    expect(resendCalls.length).toBe(0);
  });
});

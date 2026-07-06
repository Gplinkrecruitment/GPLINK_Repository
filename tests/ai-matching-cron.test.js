// Task 5 (AI Matching, 2026-07-06 plan) — GET /api/cron/match-lifecycle.
//
// Boots the real server against a tiny in-memory PostgREST emulator (same
// pattern as tests/ai-matching-gp-flow.test.js / tests/career-internal-apply
// .test.js), so the FULL Supabase-mode code path runs for real: the reminder
// pass calls the actual sendMatchEmail (Task 4), the expiry pass writes a
// real ats_stage_events row, and the summary ops email is a real sendEmail
// call captured via a mocked Resend fetch.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Source wiring (no server boot needed) ───────────────────────────────────
describe('AI Matching Task 5 — source wiring', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const vercelJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

  it('registers GET /api/cron/match-lifecycle with the CRON_SECRET bearer pattern', () => {
    expect(serverSrc).toMatch(/pathname === '\/api\/cron\/match-lifecycle'/);
    expect(serverSrc).toContain("if (!isValidCronSecret(getBearerToken(req))) { sendJson(res, 401, { error: 'Unauthorized' }); return; }");
  });

  it('guards the Task 8 lock seam behind a typeof check (never throws before Task 8 exists)', () => {
    expect(serverSrc).toContain("typeof evaluateCareerLocks === 'function'");
    expect(serverSrc).toMatch(/evaluateCareerLocks\(mlHandlerStart \+ ML_CRON_TIME_BUDGET_MS\)/);
  });

  it('vercel.json has the hourly match-lifecycle cron entry in the standard format', () => {
    const entry = vercelJson.crons.find((c) => c.path === '/api/cron/match-lifecycle');
    expect(entry).toBeTruthy();
    expect(entry.schedule).toBe('0 * * * *');
  });
});

// ── Endpoint behavior against a real Supabase-mode boot ─────────────────────
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ai-matching-cron-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;
const resendCalls = [];
let realFetch;

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const REMIND_GP = { userId: 'gp-remind-1', email: 'remind@gplink-test.local' };
const REMIND_OUTSIDE_GP = { userId: 'gp-remind-outside-1', email: 'remind-outside@gplink-test.local' };
const REMIND_FAIL_GP = { userId: 'gp-remind-fail-1', email: 'remind-fail@gplink-test.local' };
const NOMATCH_GP = { userId: 'gp-nomatch-1', email: 'nomatch@gplink-test.local' };
const EXPIRE_GP_A = { userId: 'gp-expire-a', email: 'expire-a@gplink-test.local' };
const EXPIRE_GP_B = { userId: 'gp-expire-b', email: 'expire-b@gplink-test.local' };

const ALL_GPS = [REMIND_GP, REMIND_OUTSIDE_GP, REMIND_FAIL_GP, NOMATCH_GP, EXPIRE_GP_A, EXPIRE_GP_B];

// ── In-memory PostgREST emulator (mirrors tests/ai-matching-gp-flow.test.js) ─
const db = {
  user_profiles: ALL_GPS.map((g, i) => ({
    user_id: g.userId, email: g.email, first_name: 'Test', last_name: `Doctor${i}`,
    registration_country: 'united kingdom'
  })),
  user_state: [],
  registration_cases: [],
  rso_team: [],
  ats_stage_events: [],
  practices: [
    { id: 'prac-1', name: 'Coral Coast Family Practice', website: 'https://coralcoastfamilypractice.com.au', intro_video_url: '' },
    { id: 'prac-2', name: 'Riverbend Medical Centre', website: '', intro_video_url: '' }
  ],
  career_roles: [
    {
      id: 'job-1', title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      practice_id: 'prac-1', location_city: 'Bundaberg', location_state: 'QLD', dpa: true,
      billing_model: 'Mixed billing', job_status: 'open', is_active: true
    },
    {
      id: 'job-2', title: 'General Practitioner — Bulk Billing', practice_name: 'Riverbend Medical Centre',
      practice_id: 'prac-2', location_city: 'Toowoomba', location_state: 'QLD', dpa: false,
      job_status: 'open', is_active: true
    }
    // Deliberately NO 'job-missing' row — used by REMIND_FAIL_GP's application
    // to force sendMatchEmail's real job_not_found failure branch.
  ],
  gp_applications: [
    // Reminder pass should pick this one up: shortlisted + matched + expires
    // in 12h (inside the 24h window) + never reminded.
    {
      id: 'app-remind-1', user_id: REMIND_GP.userId, career_role_id: 'job-1',
      ats_stage: 'shortlisted', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_reasons: { reasons: ['Coastal Queensland fit'] },
      matched_at: iso(NOW - 4 * 86400000), match_expires_at: iso(NOW + 12 * 3600000), match_reminder_sent_at: null
    },
    // Outside the 24h window (expires in 48h) — must NEVER be reminded.
    {
      id: 'app-remind-outside-1', user_id: REMIND_OUTSIDE_GP.userId, career_role_id: 'job-1',
      ats_stage: 'shortlisted', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_reasons: { reasons: ['Coastal Queensland fit'] },
      matched_at: iso(NOW - 1 * 86400000), match_expires_at: iso(NOW + 48 * 3600000), match_reminder_sent_at: null
    },
    // Inside the reminder window, but its job row doesn't exist — real
    // sendMatchEmail failure path (job_not_found), used for the per-row
    // isolation test: this row must NOT stop app-remind-1 above from sending.
    {
      id: 'app-remind-fail-1', user_id: REMIND_FAIL_GP.userId, career_role_id: 'job-missing',
      ats_stage: 'shortlisted', job_title: 'Ghost role', practice_name: 'Ghost practice',
      match_reasons: { reasons: ['n/a'] },
      matched_at: iso(NOW - 2 * 86400000), match_expires_at: iso(NOW + 6 * 3600000), match_reminder_sent_at: null
    },
    // matched_at is null — was never actually a real match (defensive fixture,
    // e.g. a row shape that shouldn't exist) — must be untouched by BOTH
    // passes even though its expiry is already in the past.
    {
      id: 'app-nomatch-1', user_id: NOMATCH_GP.userId, career_role_id: 'job-1',
      ats_stage: 'shortlisted', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_reasons: { reasons: [] },
      matched_at: null, match_expires_at: iso(NOW - 1 * 86400000), match_reminder_sent_at: null
    }
    // app-expire-a / app-expire-b are pushed in later (phase 3 below) so the
    // "no summary email when nothing has expired yet" assertion has a clean
    // window to check against.
  ]
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

// Test hook: any PATCH whose matched rows include one of these ids fails with
// a 500 and leaves the row unmodified — used to prove that a successful
// reminder send whose match_reminder_sent_at stamp write fails is reported in
// errors[] (stamp_failed), NOT counted as reminded. supabaseDbRequest never
// throws (it resolves {ok:false}), so this is the only way that branch can
// actually be exercised.
const failPatchIds = new Set();

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'];
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    // PostgREST lets any operator be negated with a leading "not." modifier
    // (e.g. matched_at=not.is.null) — Task 5's cron uses exactly this to
    // select "actually matched" rows, so the emulator must honor it too.
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
      // Task 5's queries sort by match_expires_at asc — the real PostgREST
      // 'order' param isn't otherwise interpreted by this emulator, but
      // sorting deterministically here matches the production ordering
      // closely enough for assertions that don't depend on order anyway.
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
        if (matched.some((row) => failPatchIds.has(String(row.id)))) {
          send(500, { message: 'forced PATCH failure (test hook)' });
          return;
        }
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched);
        return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function httpReq(method, p, { headers } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: headers || {} }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject); r.end();
  });
}

const CRON_SECRET = 'match-lifecycle-cron-secret-' + RUN_ID;
const callCron = () => httpReq('GET', '/api/cron/match-lifecycle', { headers: { Authorization: 'Bearer ' + CRON_SECRET } });

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'ai-matching-cron-secret-' + RUN_ID;
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

describe('GET /api/cron/match-lifecycle — auth', () => {
  it('401s without the bearer secret', async () => {
    const r = await httpReq('GET', '/api/cron/match-lifecycle');
    expect(r.status).toBe(401);
  });

  it('401s with the wrong bearer secret', async () => {
    const r = await httpReq('GET', '/api/cron/match-lifecycle', { headers: { Authorization: 'Bearer wrong-secret' } });
    expect(r.status).toBe(401);
  });
});

describe('GET /api/cron/match-lifecycle — reminder pass + isolation + idempotency (phase 1+2, no expiries yet)', () => {
  it('reminds only the row inside the 24h window, isolates the failing row, leaves matched_at-null/outside-window rows untouched, and sends no summary email', async () => {
    const r = await callCron();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.reminded).toBe(1);
    expect(r.body.expired).toBe(0);
    expect(r.body.timedOut).toBe(false);

    // The one genuinely-failing row (missing job) is reported as an error,
    // not silently dropped, AND did not stop app-remind-1 from being
    // processed in the same batch.
    expect(r.body.errors.some((e) => e.id === 'app-remind-fail-1' && e.stage === 'reminder')).toBe(true);

    const remindRow = db.gp_applications.find((a) => a.id === 'app-remind-1');
    expect(remindRow.match_reminder_sent_at).toBeTruthy();

    const outsideRow = db.gp_applications.find((a) => a.id === 'app-remind-outside-1');
    expect(outsideRow.match_reminder_sent_at).toBeFalsy();

    const failRow = db.gp_applications.find((a) => a.id === 'app-remind-fail-1');
    expect(failRow.match_reminder_sent_at).toBeFalsy();

    const noMatchRow = db.gp_applications.find((a) => a.id === 'app-nomatch-1');
    expect(noMatchRow.ats_stage).toBe('shortlisted');
    expect(noMatchRow.match_reminder_sent_at).toBeFalsy();

    // Exactly one email went out this run (the reminder) — no summary
    // ops email, because nothing has expired yet.
    expect(resendCalls.length).toBe(1);
    const reminderEmail = resendCalls[0].body;
    expect(reminderEmail.subject).toContain('⏳ 24 hours left');
    expect(reminderEmail.subject).toContain('Bundaberg');
    expect(reminderEmail.to).toEqual([REMIND_GP.email]);
  });

  it('is idempotent on a second run: the already-reminded row is not re-sent', async () => {
    resendCalls.length = 0;
    const r = await callCron();
    expect(r.status).toBe(200);
    expect(r.body.reminded).toBe(0);
    expect(r.body.expired).toBe(0);
    // The failing row is still (harmlessly) retried every run since it was
    // never successfully stamped — that's expected/acceptable, but it must
    // not count as a false "reminded".
    expect(resendCalls.length).toBe(0);
  });
});

describe('GET /api/cron/match-lifecycle — expiry pass (phase 3)', () => {
  it('transitions expired shortlisted rows to not_proceeding/expired, records a stage event, and fires exactly one summary ops email listing both GPs', async () => {
    resendCalls.length = 0;
    db.gp_applications.push(
      {
        id: 'app-expire-a', user_id: EXPIRE_GP_A.userId, career_role_id: 'job-1',
        ats_stage: 'shortlisted', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
        match_reasons: { reasons: [] },
        matched_at: iso(NOW - 8 * 86400000), match_expires_at: iso(NOW - 3 * 86400000), match_reminder_sent_at: iso(NOW - 1 * 86400000)
      },
      {
        id: 'app-expire-b', user_id: EXPIRE_GP_B.userId, career_role_id: 'job-2',
        ats_stage: 'shortlisted', job_title: 'General Practitioner — Bulk Billing', practice_name: 'Riverbend Medical Centre',
        match_reasons: { reasons: [] },
        matched_at: iso(NOW - 9 * 86400000), match_expires_at: iso(NOW - 2 * 86400000), match_reminder_sent_at: iso(NOW - 1 * 86400000)
      }
    );

    const r = await callCron();
    expect(r.status).toBe(200);
    expect(r.body.expired).toBe(2);

    const rowA = db.gp_applications.find((a) => a.id === 'app-expire-a');
    const rowB = db.gp_applications.find((a) => a.id === 'app-expire-b');
    expect(rowA.ats_stage).toBe('not_proceeding');
    expect(rowA.match_outcome).toBe('expired');
    expect(rowB.ats_stage).toBe('not_proceeding');
    expect(rowB.match_outcome).toBe('expired');

    const events = db.ats_stage_events.filter((e) => e.application_id === 'app-expire-a' || e.application_id === 'app-expire-b');
    expect(events.length).toBe(2);
    events.forEach((e) => {
      expect(e.from_stage).toBe('shortlisted');
      expect(e.to_stage).toBe('not_proceeding');
      expect(e.actor).toBe('system');
    });

    // Exactly ONE summary email this run, naming both GPs and both job titles.
    const summaryEmails = resendCalls.filter((c) => /expired/i.test(c.body && c.body.subject || ''));
    expect(summaryEmails.length).toBe(1);
    const summary = summaryEmails[0].body;
    expect(summary.to).toEqual(['hello@mygplink.com.au']);
    expect(summary.text).toContain('Test Doctor4'); // EXPIRE_GP_A profile (index 4 in ALL_GPS)
    expect(summary.text).toContain('Test Doctor5'); // EXPIRE_GP_B profile (index 5)
    expect(summary.text).toContain('General Practitioner — Mixed Billing');
    expect(summary.text).toContain('General Practitioner — Bulk Billing');
  });

  it('is idempotent: rerunning after the sweep does not re-expire or re-email the same rows', async () => {
    resendCalls.length = 0;
    const r = await callCron();
    expect(r.status).toBe(200);
    expect(r.body.expired).toBe(0);
    const summaryEmails = resendCalls.filter((c) => /expired/i.test(c.body && c.body.subject || ''));
    expect(summaryEmails.length).toBe(0);
  });
});

// ── Reviewer follow-ups (phase 4) ────────────────────────────────────────────
// Fixture rows here are pushed inside each test (not at boot) so the earlier
// phases' exact reminded/expired/email counts stay untouched.
describe('GET /api/cron/match-lifecycle — reviewer follow-ups (phase 4)', () => {
  it('a matched, never-reminded row already PAST expiry gets NO reminder — the expiry pass sweeps it instead', async () => {
    resendCalls.length = 0;
    db.user_profiles.push({
      user_id: 'gp-past-1', email: 'past@gplink-test.local',
      first_name: 'Test', last_name: 'DoctorPast', registration_country: 'united kingdom'
    });
    db.gp_applications.push({
      id: 'app-past-1', user_id: 'gp-past-1', career_role_id: 'job-1',
      ats_stage: 'shortlisted', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_reasons: { reasons: [] },
      // Expired 1h ago, reminder never sent (e.g. the cron was down for the
      // final day). The gte-now bound must exclude it from the reminder pass
      // — a "24 hours left" email about an already-dead match would be a lie
      // — and the expiry pass must sweep it in the same run.
      matched_at: iso(Date.now() - 6 * 86400000), match_expires_at: iso(Date.now() - 3600000), match_reminder_sent_at: null
    });

    const r = await callCron();
    expect(r.status).toBe(200);
    expect(r.body.reminded).toBe(0);
    expect(r.body.expired).toBe(1);

    const row = db.gp_applications.find((a) => a.id === 'app-past-1');
    expect(row.match_reminder_sent_at).toBeFalsy();
    expect(row.ats_stage).toBe('not_proceeding');
    expect(row.match_outcome).toBe('expired');

    // No reminder email reached the GP; the only email is the 1-GP summary.
    expect(resendCalls.filter((c) => (c.body.to || []).includes('past@gplink-test.local')).length).toBe(0);
    const summaries = resendCalls.filter((c) => /expired/i.test((c.body && c.body.subject) || ''));
    expect(summaries.length).toBe(1);
    expect(summaries[0].body.text).toContain('Test DoctorPast');
  });

  it('a row expiring right at the 24h boundary is included in the reminder pass', async () => {
    resendCalls.length = 0;
    // The cron computes ITS OWN now a few ms after this row is written, so an
    // expiry stamped test-time+24h lands just inside the lte upper bound —
    // the closest a wall-clock HTTP test can get to the exact edge. It proves
    // the boundary is included (and would catch the window shrinking, e.g. a
    // future refactor to a 23h lookahead or a strict lt with margin).
    const reqNow = Date.now();
    db.user_profiles.push({
      user_id: 'gp-boundary-1', email: 'boundary@gplink-test.local',
      first_name: 'Test', last_name: 'DoctorBoundary', registration_country: 'united kingdom'
    });
    db.gp_applications.push({
      id: 'app-boundary-1', user_id: 'gp-boundary-1', career_role_id: 'job-1',
      ats_stage: 'shortlisted', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_reasons: { reasons: ['Coastal Queensland fit'] },
      matched_at: iso(reqNow - 4 * 86400000), match_expires_at: iso(reqNow + 24 * 3600000), match_reminder_sent_at: null
    });

    const r = await callCron();
    expect(r.status).toBe(200);
    expect(r.body.reminded).toBe(1);
    expect(r.body.expired).toBe(0);

    const row = db.gp_applications.find((a) => a.id === 'app-boundary-1');
    expect(row.match_reminder_sent_at).toBeTruthy();
    expect(resendCalls.some((c) => (c.body.to || []).includes('boundary@gplink-test.local'))).toBe(true);
  });

  it('a successful send whose stamp PATCH fails is NOT counted as reminded and lands in errors[] as stamp_failed', async () => {
    resendCalls.length = 0;
    db.user_profiles.push({
      user_id: 'gp-stampfail-1', email: 'stampfail@gplink-test.local',
      first_name: 'Test', last_name: 'DoctorStampfail', registration_country: 'united kingdom'
    });
    db.gp_applications.push({
      id: 'app-stampfail-1', user_id: 'gp-stampfail-1', career_role_id: 'job-1',
      ats_stage: 'shortlisted', job_title: 'General Practitioner — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_reasons: { reasons: ['Coastal Queensland fit'] },
      matched_at: iso(Date.now() - 86400000), match_expires_at: iso(Date.now() + 6 * 3600000), match_reminder_sent_at: null
    });
    failPatchIds.add('app-stampfail-1');
    try {
      const r = await callCron();
      expect(r.status).toBe(200);
      expect(r.body.reminded).toBe(0);
      expect(r.body.errors.some((e) => e.id === 'app-stampfail-1' && e.stage === 'reminder' && e.error === 'stamp_failed')).toBe(true);

      // The email itself DID go out — the failure is the stamp write, not
      // the send. The honest outcome is a visible error (and a re-send next
      // hour), never a clean "reminded" count over an unstamped row.
      expect(resendCalls.some((c) => (c.body.to || []).includes('stampfail@gplink-test.local'))).toBe(true);
      const row = db.gp_applications.find((a) => a.id === 'app-stampfail-1');
      expect(row.match_reminder_sent_at).toBeFalsy();
    } finally {
      failPatchIds.delete('app-stampfail-1');
    }
  });

  it('self-heals: once the stamp write succeeds again, the next run re-sends and stamps the same row', async () => {
    resendCalls.length = 0;
    const r = await callCron();
    expect(r.status).toBe(200);
    expect(r.body.reminded).toBe(1);

    const row = db.gp_applications.find((a) => a.id === 'app-stampfail-1');
    expect(row.match_reminder_sent_at).toBeTruthy();
    expect(resendCalls.some((c) => (c.body.to || []).includes('stampfail@gplink-test.local'))).toBe(true);
  });
});

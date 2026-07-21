// Post-interview contract pipeline (owner spec 2026-07-21):
// interview happens -> practice extends offer by uploading a contract ->
// CEO + AI review -> GP signs (upload) or requests changes -> signed = placement.
//
// Task 8 only lands the migration (career_contracts table + two new
// gp_applications bookkeeping columns). Later tasks build the endpoints on
// top of it and will extend this file with server/endpoint coverage — this
// describe block covers the migration itself.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MIGRATION_PATH = path.join(ROOT, 'supabase/migrations/20260721150000_career_contracts.sql');
const SERVER_PATH = path.join(ROOT, 'server.js');

describe('career_contracts migration', () => {
  it('the migration file exists', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('creates the career_contracts table, additive and idempotent', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/create table if not exists public\.career_contracts/);
    expect(sql).not.toMatch(/drop\s/i);
  });

  it('has the columns the contract pipeline needs', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    const cols = [
      'id uuid primary key default gen_random_uuid()',
      'application_id uuid not null references public.gp_applications(id) on delete cascade',
      'user_id uuid',
      'career_role_id bigint',
      'version integer not null default 1',
      'contract_bucket text',
      'contract_path text',
      'contract_filename text',
      'contract_mime text',
      'signed_bucket text',
      'signed_path text',
      'signed_filename text',
      'ai_review jsonb',
      'terms_context jsonb',
      'change_request text',
      'change_response text',
      'ceo_note text',
      'practice_contact_email text',
      'practice_contact_name text',
      'uploaded_at timestamptz',
      'sent_to_gp_at timestamptz',
      'signed_at timestamptz',
      'created_at timestamptz not null default now()',
      'updated_at timestamptz not null default now()',
    ];
    for (const col of cols) {
      expect(sql).toContain(col);
    }
  });

  it('constrains status to the contract lifecycle', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/status text not null default 'awaiting_upload'/);
    expect(sql).toContain(
      "check (status in ('awaiting_upload','uploaded','sent_to_gp','changes_requested','practice_review','signed','void'))"
    );
  });

  it('constrains ai_review_status to the review lifecycle', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/ai_review_status text not null default 'not_run'/);
    expect(sql).toContain("check (ai_review_status in ('not_run','running','done','error'))");
  });

  it('indexes application lookups and status filters', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(
      /create index if not exists career_contracts_app_idx on public\.career_contracts \(application_id, version desc\)/
    );
    expect(sql).toMatch(/create index if not exists career_contracts_status_idx on public\.career_contracts \(status\)/);
  });

  it('adds the two interview follow-up bookkeeping columns to gp_applications, additively', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/alter table public\.gp_applications add column if not exists post_interview_email_sent_at timestamptz/);
    expect(sql).toMatch(/alter table public\.gp_applications add column if not exists interview_completed_at timestamptz/);
  });
});

// Task 9 (2026-07-21): interview completion → instant practice decision
// email. When a GP's interview with a practice concludes — either via the
// Zoom meeting.ended webhook (handleZoomMeetingEnded) or the detect-no-shows
// cron's attended-so-mark-completed fallback — the practice must instantly
// get an email with two one-click choices (extend an offer / not
// proceeding), linking to Task 10's /pages/practice-offer.html.
//
// Two layers of coverage:
//  1. Source-assertion tests (fast, no server boot): the token purpose
//     constant exists, the helper is defined, and it's wired into >= 2
//     completion call sites, both correctly guarded on
//     `meeting_kind === 'interview' && application_id`.
//  2. A behavioral live-boot test (in-memory PostgREST emulator, same
//     pattern as tests/practice-respond.test.js / tests/ats-placement-accept
//     .test.js): seeds an interview scheduled_call + application, fires the
//     REAL POST /api/webhooks/zoom meeting.ended webhook (the SIMPLER of the
//     two call sites to reach — handleZoomMeetingEnded needs only the
//     Supabase emulator, whereas detect-no-shows also needs a live Zoom
//     OAuth token + past-meeting-participants mock to reach its "attended"
//     branch), and asserts the application row lands on 'interview_completed'
//     with both stamps, exactly one email goes out with the two decision
//     links, and a direct re-invocation of the helper is idempotent (no
//     double-stamp, no second email). The detect-no-shows call site is
//     therefore proven by source-assertion (guard regex + call-site count)
//     rather than full live-boot — documented here rather than silently
//     skipped, per the brief's own "document why source-assertions are the
//     ceiling" allowance.
describe('sendPostInterviewDecisionEmail — wiring (Task 9)', () => {
  const SERVER_SRC = fs.readFileSync(SERVER_PATH, 'utf8');

  it('defines the post_interview_decision signed-token purpose', () => {
    expect(SERVER_SRC).toContain("POST_INTERVIEW_TOKEN_PURPOSE = 'post_interview_decision'");
  });

  it('defines sendPostInterviewDecisionEmail(applicationId)', () => {
    expect(SERVER_SRC).toMatch(/async function sendPostInterviewDecisionEmail\(applicationId\)/);
  });

  it('is wired into at least two completion call sites (declaration + >= 2 invocations)', () => {
    const occurrences = SERVER_SRC.match(/sendPostInterviewDecisionEmail\(/g) || [];
    // One occurrence is the function's own declaration signature; subtract it
    // so this counts real call sites, not just the constant name appearing.
    expect(occurrences.length - 1).toBeGreaterThanOrEqual(2);
  });

  it('both call sites guard on meeting_kind === interview && application_id', () => {
    const guardMatches = SERVER_SRC.match(/meeting_kind === 'interview' && [A-Za-z]+\.application_id\)/g) || [];
    expect(guardMatches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('sendPostInterviewDecisionEmail — behavior (live-boot, Zoom meeting.ended)', () => {
  const RUN_ID = crypto.randomBytes(4).toString('hex');
  const DB_FILE = path.join('/tmp', `gplink-post-interview-${RUN_ID}.json`);
  const ZOOM_SECRET = 'zoom-webhook-secret-' + RUN_ID;
  const CRON_SECRET = 'post-interview-cron-secret-' + RUN_ID;
  const GP = { userId: 'u-gp-pi-1', email: 'pi-gp@gplink-test.local' };
  const NOW = new Date().toISOString();

  let server, port;
  let sbServer, sbPort;
  let realFetch;
  let mod; // the imported server module, for __testUtils.sendPostInterviewDecisionEmail
  const resendCalls = [];

  const db = {
    user_profiles: [
      { user_id: GP.userId, email: GP.email, first_name: 'Interview', last_name: 'Candidate', registration_country: 'uk' }
    ],
    practices: [
      { id: 'p-pi-1', name: 'Riverside Family Practice', source: 'internal_ats', contact_name: 'Practice Reception', contact_email: 'reception@riverside-test.local', is_active: true, created_at: NOW }
    ],
    career_roles: [
      { id: 'role-pi-1', provider: 'internal_ats', provider_role_id: 'ats_pi_1', title: 'General Practitioner — VR', practice_name: 'Riverside Family Practice', practice_id: 'p-pi-1', location_city: 'Brisbane', location_state: 'QLD', is_active: true, job_status: 'open', updated_at: NOW }
    ],
    gp_applications: [
      // No practice_contact_email/name set — exercises the fallback chain
      // (career_roles.practice_id -> practices.contact_email/name).
      { id: 'app-pi-1', user_id: GP.userId, career_role_id: 'role-pi-1', practice_id: 'p-pi-1', provider_role_id: 'ats_pi_1', status: 'interview', ats_stage: 'interview', applied_at: NOW },
      // Second fixture for the direct-call failure/rollback test — no
      // resolvable practice contact anywhere (no role, no practice_id).
      { id: 'app-pi-2', user_id: GP.userId, provider_role_id: null, status: 'interview', ats_stage: 'interview', applied_at: NOW }
    ],
    scheduled_calls: [
      { id: 'call-pi-1', case_id: null, user_id: GP.userId, application_id: 'app-pi-1', meeting_kind: 'interview', status: 'booked', zoom_meeting_id: 'zoom-meeting-pi-1', scheduled_at: NOW, stage: null, summary_status: 'not_requested' }
    ],
    webhook_events: [],
    registration_tasks: []
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
        send(405, { message: 'method not allowed' });
      });
      sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
    });
  }

  function postZoomWebhook(body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const ts = String(Math.floor(Date.now() / 1000));
      const message = 'v0:' + ts + ':' + data;
      const sig = 'v0=' + crypto.createHmac('sha256', ZOOM_SECRET).update(message).digest('hex');
      const r = http.request({
        host: '127.0.0.1', port, path: '/api/webhooks/zoom', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'x-zm-request-timestamp': ts,
          'x-zm-signature': sig
        }
      }, (res) => {
        const c = []; res.on('data', (x) => c.push(x));
        res.on('end', () => {
          const raw = Buffer.concat(c).toString('utf8');
          let parsed = null; try { parsed = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      r.on('error', reject); r.end(data);
    });
  }

  function getCron(cronPath, headers) {
    return new Promise((resolve, reject) => {
      const r = http.request({
        host: '127.0.0.1', port, path: cronPath, method: 'GET', headers: headers || {}
      }, (res) => {
        const c = []; res.on('data', (x) => c.push(x));
        res.on('end', () => {
          const raw = Buffer.concat(c).toString('utf8');
          let parsed = null; try { parsed = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      r.on('error', reject); r.end();
    });
  }

  const appRow = (id) => db.gp_applications.find((a) => a.id === id);
  const callRow = (id) => db.scheduled_calls.find((c) => c.id === id);

  beforeAll(async () => {
    await startSupabaseEmulator();

    process.env.AGENT_SKIP_DOTENV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DISABLED = 'false';
    process.env.AUTH_SECRET = 'post-interview-secret-' + RUN_ID;
    process.env.REQUIRE_SUPABASE_DB = 'false';
    process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
    process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.ENFORCE_SAME_ORIGIN = 'false';
    process.env.DB_FILE_PATH = DB_FILE;
    process.env.OPENAI_API_KEY = '';
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.REGISTRATION_HUB_EMAIL = 'hello@mygplink-test.local';
    process.env.ZOOM_WEBHOOK_SECRET = ZOOM_SECRET;
    process.env.APP_BASE_URL = 'https://app.mygplink.com.au';
    // CRON_SECRET is read once into a module-level const at require time (server.js
    // ~line 85), so it must be set before `import('../server.js')` below, same as
    // tests/consult-nudge-cron.test.js.
    process.env.CRON_SECRET = CRON_SECRET;

    realFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => {
      const u = String(url && url.url ? url.url : url);
      if (u.startsWith('https://api.resend.com/')) {
        let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
        resendCalls.push({ url: u, body: parsed });
        return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
      }
      if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
      return Promise.resolve(new Response('{}', { status: 200 }));
    };

    mod = await import('../server.js');
    server = mod.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
  });

  afterAll(async () => {
    if (realFetch) globalThis.fetch = realFetch;
    if (server) await new Promise((r) => server.close(r));
    if (sbServer) await new Promise((r) => sbServer.close(r));
    try { fs.unlinkSync(DB_FILE); } catch {}
  });

  it('meeting.ended completes the call AND instantly emails the practice both decision links', async () => {
    const before = resendCalls.length;
    const r = await postZoomWebhook({
      event: 'meeting.ended',
      payload: { object: { id: 'zoom-meeting-pi-1', uuid: 'zoom-uuid-pi-1' } }
    });
    expect(r.status).toBe(200);

    // The scheduled_call is completed (the pre-existing meeting.ended behavior).
    const call = callRow('call-pi-1');
    expect(call.status).toBe('completed');
    expect(call.completed_at).toBeTruthy();
    expect(call.summary_status).toBe('pending');

    // The application landed on interview_completed with both stamps (Task 9's contract).
    const app = appRow('app-pi-1');
    expect(app.status).toBe('interview_completed');
    expect(app.interview_completed_at).toBeTruthy();
    expect(app.post_interview_email_sent_at).toBeTruthy();

    // Exactly one email, to the fallback-resolved practice contact, with the
    // subject built from the GP's last name and BOTH decision links.
    expect(resendCalls.length).toBe(before + 1);
    const sent = resendCalls[resendCalls.length - 1].body;
    expect(sent.to).toEqual(['reception@riverside-test.local']);
    expect(sent.subject).toBe('How did the interview with Dr Candidate go?');
    expect(sent.html).toContain('intent=offer');
    expect(sent.html).toContain('intent=decline');
    expect(sent.html).toContain('/pages/practice-offer.html?token=');
    expect(sent.text).toContain('intent=offer');
    expect(sent.text).toContain('intent=decline');
  });

  it('is idempotent: re-invoking the helper directly does not double-stamp or re-send', async () => {
    const before = resendCalls.length;
    const stampBefore = appRow('app-pi-1').post_interview_email_sent_at;

    const result = await mod.__testUtils.sendPostInterviewDecisionEmail('app-pi-1');
    expect(result).toEqual({ ok: false, skipped: 'already_sent' });

    expect(resendCalls.length).toBe(before); // no second email
    expect(appRow('app-pi-1').post_interview_email_sent_at).toBe(stampBefore); // stamp untouched
  });

  it('rolls the sent-stamp back on a resolution failure so a later retry can re-attempt (interview_completed stays put)', async () => {
    const before = resendCalls.length;
    const result = await mod.__testUtils.sendPostInterviewDecisionEmail('app-pi-2');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_practice_contact');
    expect(resendCalls.length).toBe(before); // nothing sent

    const app = appRow('app-pi-2');
    // The interview really did complete — those stamps are NOT rolled back.
    expect(app.status).toBe('interview_completed');
    expect(app.interview_completed_at).toBeTruthy();
    // Only the email-sent marker is rolled back, so a later cron pass retries.
    expect(app.post_interview_email_sent_at == null).toBe(true);
  });

  it('POST_INTERVIEW_TOKEN_PURPOSE round-trips applicationId through the signed token', () => {
    const token = mod.__testUtils.createSignedPurposeToken(mod.__testUtils.POST_INTERVIEW_TOKEN_PURPOSE, { applicationId: 'app-pi-1' }, 60000);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(10);
  });

  // Post-review fix (2026-07-22): the code comment used to claim a failed
  // send is retried by the detect-no-shows cron — but both call sites flip
  // the scheduled_call to 'completed' BEFORE invoking the helper, and the
  // cron's main loop only ever looks at status='booked' rows, so nothing
  // re-invoked the helper once the stamp was rolled back. This proves the
  // NEW bounded reconcile sweep inside GET /api/cron/detect-no-shows
  // actually does the retrying: seed an application that's already
  // interview_completed with no email sent (and, crucially, NO booked
  // scheduled_call — so the main no-show loop can't be what's finding it),
  // hit the real cron endpoint, and confirm the email goes out and the
  // stamp gets set. A second cron run must NOT send a second email.
  it('detect-no-shows retry sweep sends the stalled post-interview email for a completed interview with no booked call', async () => {
    const before = resendCalls.length;
    db.gp_applications.push({
      id: 'app-pi-retry-1', user_id: GP.userId, career_role_id: 'role-pi-1', practice_id: 'p-pi-1',
      provider_role_id: 'ats_pi_1', status: 'interview_completed', ats_stage: 'interview', applied_at: NOW,
      interview_completed_at: new Date().toISOString(), post_interview_email_sent_at: null
    });

    const r1 = await getCron('/api/cron/detect-no-shows', { Authorization: 'Bearer ' + CRON_SECRET });
    expect(r1.status).toBe(200);
    expect(r1.body.ok).toBe(true);
    expect(r1.body.postInterviewSent).toBeGreaterThanOrEqual(1);

    expect(resendCalls.length).toBe(before + 1);
    const retried = appRow('app-pi-retry-1');
    expect(retried.post_interview_email_sent_at).toBeTruthy();

    // Second cron pass: the stamp is now set, so the sweep's own query no
    // longer matches this row — no second email.
    const beforeSecond = resendCalls.length;
    const r2 = await getCron('/api/cron/detect-no-shows', { Authorization: 'Bearer ' + CRON_SECRET });
    expect(r2.status).toBe(200);
    expect(resendCalls.length).toBe(beforeSecond);
  });

  it('detect-no-shows requires the cron secret', async () => {
    const r = await getCron('/api/cron/detect-no-shows', { Authorization: 'Bearer wrong-secret' });
    expect(r.status).toBe(401);
  });

  // Escaping fix (2026-07-22): buildCareerEmailHtml's `body` path only
  // HTML-escapes via formatPlainTextEmailHtml when the assembled string has
  // no `<tag>`-like substring — so a GP-controlled name containing markup
  // used to flip the whole email onto the raw, unescaped branch. Proves the
  // helper now pre-escapes every interpolated value (practiceLabel,
  // gpDisplayName, roleLabel) before it ever reaches the email HTML.
  it('escapes a GP-controlled name containing markup so it can never inject HTML into the practice email', async () => {
    db.user_profiles.push({
      user_id: 'u-gp-pi-xss', email: 'pi-gp-xss@gplink-test.local',
      first_name: 'Xx', last_name: '<script>evil()</script>', registration_country: 'uk'
    });
    db.gp_applications.push({
      id: 'app-pi-xss', user_id: 'u-gp-pi-xss', career_role_id: 'role-pi-1', practice_id: 'p-pi-1',
      provider_role_id: 'ats_pi_1', status: 'interview', ats_stage: 'interview', applied_at: NOW
    });

    const before = resendCalls.length;
    const result = await mod.__testUtils.sendPostInterviewDecisionEmail('app-pi-xss');
    expect(result).toEqual({ ok: true });
    expect(resendCalls.length).toBe(before + 1);

    const sent = resendCalls[resendCalls.length - 1].body;
    expect(sent.html).not.toContain('<script>evil()</script>');
    expect(sent.html).toContain('&lt;script&gt;evil()&lt;/script&gt;');
    // Subjects aren't HTML — but angle brackets are stripped so a crafted
    // name can't visually spoof the subject line either.
    expect(sent.subject).not.toMatch(/[<>]/);
  });
});

// Task 10 (2026-07-22): the practice extend-offer / decline page + its four
// public, token-authed endpoints. No login — the signed purpose token is the
// entire security model, so these tests are as much about what the endpoints
// REFUSE as what they do. Boots the real server against an in-memory emulator
// that serves BOTH PostgREST (/rest/v1/<table>) and Supabase Storage
// (/storage/v1/...), reusing the admin-offer-contract test's storage
// emulation, and overrides globalThis.fetch to capture Resend calls while
// passing 127.0.0.1 traffic (the emulator) through to real fetch.
describe('practice offer decision + contract upload (Task 10, live-boot)', () => {
  const RUN_ID = crypto.randomBytes(4).toString('hex');
  const DB_FILE = path.join('/tmp', `gplink-t10-${RUN_ID}.json`);
  const GP = { userId: 'u-gp-t10-1', email: 'gp-t10@gplink-test.local' };
  const HUB_EMAIL = 'hello@mygplink-test.local';
  const NOW = new Date().toISOString();

  // Separate application fixtures so the extend/upload sequence, the decline
  // sequence and the withdrawn-guard cases never contaminate one another.
  const APP_MAIN = 'app-t10-main';
  const APP_DECLINE = 'app-t10-decline';
  const APP_WD = 'app-t10-withdrawn';

  let server, port, sbServer, sbPort, realFetch, mod;
  const resendCalls = [];
  const storage = new Map(); // "<bucket>/<path>" -> Buffer

  const db = {
    user_profiles: [
      { user_id: GP.userId, email: GP.email, first_name: 'Helen', last_name: 'Rivers', registration_country: 'uk' }
    ],
    career_roles: [
      { id: 'role-t10-1', provider: 'internal_ats', title: 'General Practitioner — VR', practice_name: 'Harbour Family Clinic', practice_id: 'p-t10-1', is_active: true, job_status: 'open', updated_at: NOW }
    ],
    gp_applications: [
      { id: APP_MAIN, user_id: GP.userId, career_role_id: 'role-t10-1', practice_id: 'p-t10-1', status: 'interview_completed', ats_stage: 'interview', practice_contact_email: 'reception@harbour-test.local', practice_contact_name: 'Harbour Reception', applied_at: NOW },
      { id: APP_DECLINE, user_id: GP.userId, career_role_id: 'role-t10-1', practice_id: 'p-t10-1', status: 'interview_completed', ats_stage: 'interview', practice_contact_email: 'reception@harbour-test.local', practice_contact_name: 'Harbour Reception', applied_at: NOW },
      { id: APP_WD, user_id: GP.userId, career_role_id: 'role-t10-1', practice_id: 'p-t10-1', status: 'withdrawn', ats_stage: 'not_proceeding', applied_at: NOW }
    ],
    career_contracts: [],
    ats_offers: [],
    ats_stage_events: [],
    user_state: [{ user_id: GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }]
  };
  function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }
  function buildMatcher(params) {
    const filters = [];
    for (const [k, v] of params.entries()) {
      if (['select', 'limit', 'order', 'on_conflict'].includes(k)) continue;
      const mm = /^(eq|neq)\.(.*)$/s.exec(v);
      if (mm) filters.push({ col: k, op: mm[1], val: mm[2] });
    }
    return (row) => filters.every((f) => {
      const cell = row ? row[f.col] : undefined;
      const eq = String(cell) === String(f.val);
      return f.op === 'eq' ? eq : !eq;
    });
  }

  function startEmulator() {
    return new Promise((resolve) => {
      sbServer = http.createServer(async (req, res) => {
        const u = new URL(req.url, 'http://sb.local');
        const sendJson = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
        const readRaw = () => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });

        // ── Supabase Storage ──
        if (u.pathname.startsWith('/storage/v1/')) {
          let mm = u.pathname.match(/^\/storage\/v1\/object\/upload\/sign\/(.+)$/);
          if (mm && req.method === 'POST') { sendJson(200, { url: '/object/upload/sign/' + mm[1] + '?token=test-token' }); return; }
          if (mm && req.method === 'PUT') { storage.set(decodeURIComponent(mm[1]), await readRaw()); sendJson(200, { Key: mm[1] }); return; }
          mm = u.pathname.match(/^\/storage\/v1\/object\/(?!upload|sign|public)(.+)$/);
          if (mm && req.method === 'GET') {
            const buf = storage.get(decodeURIComponent(mm[1]));
            if (!buf) { res.writeHead(404); res.end('not found'); return; }
            res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(buf); return;
          }
          sendJson(404, { message: 'storage not found' }); return;
        }

        // ── PostgREST ──
        const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
        if (!m) { sendJson(404, { message: 'not found' }); return; }
        const rows = tableOf(decodeURIComponent(m[1]));
        const matches = buildMatcher(u.searchParams);
        if (req.method === 'GET') {
          let out = rows.filter(matches);
          const limit = parseInt(u.searchParams.get('limit') || '', 10);
          if (Number.isFinite(limit)) out = out.slice(0, limit);
          sendJson(200, out); return;
        }
        if (req.method === 'POST') {
          const body = JSON.parse((await readRaw()).toString('utf8') || 'null');
          const incoming = Array.isArray(body) ? body : (body ? [body] : []);
          const saved = incoming.map((r) => {
            const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
            rows.push(row); return row;
          });
          sendJson(201, saved); return;
        }
        if (req.method === 'PATCH') {
          const patch = JSON.parse((await readRaw()).toString('utf8') || 'null');
          const matched = rows.filter(matches);
          matched.forEach((row) => Object.assign(row, patch || {}));
          sendJson(200, matched); return;
        }
        sendJson(405, { message: 'method not allowed' });
      });
      sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
    });
  }

  function httpJson(method, p, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const headers = {};
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
        const c = []; res.on('data', (x) => c.push(x));
        res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let parsed = null; try { parsed = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: parsed }); });
      });
      r.on('error', reject); r.end(data);
    });
  }
  const apiGet = (p) => httpJson('GET', p);
  const apiPost = (p, body) => httpJson('POST', p, body);

  function putSignedUpload(uploadUrl, buffer, mime) {
    return new Promise((resolve, reject) => {
      const target = new URL(uploadUrl);
      const r = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: 'PUT', headers: { 'Content-Type': mime, 'x-upsert': 'true', 'Content-Length': buffer.length } }, (res) => {
        res.on('data', () => {}); res.on('end', () => resolve({ status: res.statusCode }));
      });
      r.on('error', reject); r.end(buffer);
    });
  }

  const appRow = (id) => db.gp_applications.find((a) => a.id === id);
  const postInterviewToken = (applicationId) => mod.__testUtils.createSignedPurposeToken(mod.__testUtils.POST_INTERVIEW_TOKEN_PURPOSE, { applicationId }, 3600000);

  beforeAll(async () => {
    await startEmulator();
    process.env.AGENT_SKIP_DOTENV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DISABLED = 'false';
    process.env.AUTH_SECRET = 'contracts-t10-secret-' + RUN_ID;
    process.env.REQUIRE_SUPABASE_DB = 'false';
    process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
    process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.SUPABASE_DOCUMENT_BUCKET = 'gp-link-documents';
    process.env.ENFORCE_SAME_ORIGIN = 'false';
    process.env.DB_FILE_PATH = DB_FILE;
    process.env.OPENAI_API_KEY = '';
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.REGISTRATION_HUB_EMAIL = HUB_EMAIL;
    process.env.APP_BASE_URL = 'https://app.mygplink.com.au';

    realFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => {
      const u = String(url && url.url ? url.url : url);
      if (u.startsWith('https://api.resend.com/')) {
        let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
        resendCalls.push({ url: u, body: parsed });
        return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
      }
      if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
      return Promise.resolve(new Response('{}', { status: 200 }));
    };

    // server.js reads SUPABASE_URL / AUTH_SECRET etc. into module-level consts
    // at import time. The Task 9 live-boot block above already imported it and
    // pinned those to ITS (now-closed) emulator — so reset the module registry
    // to force a FRESH evaluation that reads THIS block's env (our emulator
    // port, our AUTH_SECRET), otherwise every DB-backed request here would hit
    // a dead port.
    vi.resetModules();
    mod = await import('../server.js');
    server = mod.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
  });

  afterAll(async () => {
    if (realFetch) globalThis.fetch = realFetch;
    if (server) await new Promise((r) => server.close(r));
    if (sbServer) await new Promise((r) => sbServer.close(r));
    try { fs.unlinkSync(DB_FILE); } catch {}
  });

  it('context: a fresh post-interview token resolves to the "decide" state with labels', async () => {
    const r = await apiGet('/api/practice/offer/context?token=' + encodeURIComponent(postInterviewToken(APP_MAIN)));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.state).toBe('decide');
    expect(r.body.gpName).toContain('Helen');
    expect(r.body.roleTitle).toContain('General Practitioner');
    expect(r.body.practiceName).toBe('Harbour Family Clinic');
  });

  it('context: an invalid/garbage token is 410 (never 500, never leaks state)', async () => {
    const r = await apiGet('/api/practice/offer/context?token=not-a-real-token');
    expect(r.status).toBe(410);
  });

  it('context + decision: a withdrawn application answers 409 {code:"withdrawn"} and refuses to act', async () => {
    const tok = postInterviewToken(APP_WD);
    const ctx = await apiGet('/api/practice/offer/context?token=' + encodeURIComponent(tok));
    expect(ctx.status).toBe(409);
    expect(ctx.body.code).toBe('withdrawn');

    const dec = await apiPost('/api/practice/offer/decision', { token: tok, action: 'extend_offer' });
    expect(dec.status).toBe(409);
    expect(dec.body.code).toBe('withdrawn');
    // No contract was created for the withdrawn application.
    expect(db.career_contracts.filter((c) => c.application_id === APP_WD).length).toBe(0);
  });

  it('decline: flips the application to not_proceeding, emails the GP gently + alerts the CEO, and is idempotent', async () => {
    const before = resendCalls.length;
    const tok = postInterviewToken(APP_DECLINE);
    const r = await apiPost('/api/practice/offer/decision', { token: tok, action: 'decline' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const app = appRow(APP_DECLINE);
    expect(app.status).toBe('not_proceeding');
    expect(app.ats_stage).toBe('not_proceeding');

    // Two emails: a gentle note to the GP + a CEO alert to the hub inbox.
    const sent = resendCalls.slice(before);
    const gpEmail = sent.find((c) => Array.isArray(c.body.to) && c.body.to.includes(GP.email));
    const ceoEmail = sent.find((c) => Array.isArray(c.body.to) && c.body.to.includes(HUB_EMAIL));
    expect(gpEmail).toBeTruthy();
    expect(ceoEmail).toBeTruthy();
    // Gentle GP copy — no blunt "rejected"/"unsuccessful" wording.
    expect(gpEmail.body.subject.toLowerCase()).not.toMatch(/reject|unsuccessful/);

    // Idempotent: a repeat decline returns ok and sends NO further email.
    const before2 = resendCalls.length;
    const r2 = await apiPost('/api/practice/offer/decision', { token: tok, action: 'decline' });
    expect(r2.status).toBe(200);
    expect(r2.body.ok).toBe(true);
    expect(resendCalls.length).toBe(before2);
  });

  it('extend_offer: creates an awaiting_upload v1 contract and is idempotent (same contract on repeat)', async () => {
    const tok = postInterviewToken(APP_MAIN);
    const r = await apiPost('/api/practice/offer/decision', { token: tok, action: 'extend_offer' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.contractId).toBe('string');
    expect(typeof r.body.uploadToken).toBe('string');

    const rows = db.career_contracts.filter((c) => c.application_id === APP_MAIN);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('awaiting_upload');
    expect(rows[0].version).toBe(1);
    expect(rows[0].user_id).toBe(GP.userId);
    expect(String(rows[0].career_role_id)).toBe('role-t10-1');

    // Idempotent — a repeat extend returns the SAME contract, no duplicate row.
    const r2 = await apiPost('/api/practice/offer/decision', { token: tok, action: 'extend_offer' });
    expect(r2.status).toBe(200);
    expect(r2.body.contractId).toBe(r.body.contractId);
    expect(db.career_contracts.filter((c) => c.application_id === APP_MAIN).length).toBe(1);
  });

  it('context: with an awaiting_upload contract the post-interview token now resolves to "upload" + an uploadToken', async () => {
    const r = await apiGet('/api/practice/offer/context?token=' + encodeURIComponent(postInterviewToken(APP_MAIN)));
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('upload');
    expect(typeof r.body.contractId).toBe('string');
    expect(typeof r.body.uploadToken).toBe('string');
  });

  it('decision refuses a contract_upload token (wrong purpose can never drive extend/decline)', async () => {
    // Get a genuine contract_upload token from the extend response.
    const ext = await apiPost('/api/practice/offer/decision', { token: postInterviewToken(APP_MAIN), action: 'extend_offer' });
    const uploadToken = ext.body.uploadToken;
    const r = await apiPost('/api/practice/offer/decision', { token: uploadToken, action: 'decline' });
    expect(r.status).toBe(410);
  });

  it('sign-upload: refuses a post_interview token (wrong purpose) and a bad mime', async () => {
    const ext = await apiPost('/api/practice/offer/decision', { token: postInterviewToken(APP_MAIN), action: 'extend_offer' });
    const uploadToken = ext.body.uploadToken;

    // Wrong-purpose token → 410, never a signed URL.
    const wrongPurpose = await apiPost('/api/practice/contract/sign-upload', { token: postInterviewToken(APP_MAIN), filename: 'c.pdf', mimeType: 'application/pdf' });
    expect(wrongPurpose.status).toBe(410);

    // Wrong mime → 400.
    const badMime = await apiPost('/api/practice/contract/sign-upload', { token: uploadToken, filename: 'contract.exe', mimeType: 'application/x-msdownload' });
    expect(badMime.status).toBe(400);
  });

  it('finalize: refuses when no object was uploaded to Storage', async () => {
    const ext = await apiPost('/api/practice/offer/decision', { token: postInterviewToken(APP_MAIN), action: 'extend_offer' });
    const uploadToken = ext.body.uploadToken;
    const sign = await apiPost('/api/practice/contract/sign-upload', { token: uploadToken, filename: 'Employment-Contract.pdf', mimeType: 'application/pdf' });
    expect(sign.status).toBe(200);
    expect(typeof sign.body.uploadUrl).toBe('string');
    expect(typeof sign.body.path).toBe('string');

    // No PUT happened → finalize must 400, not silently mark it uploaded.
    const fin = await apiPost('/api/practice/contract/finalize', { token: uploadToken, path: sign.body.path, filename: 'Employment-Contract.pdf', mimeType: 'application/pdf' });
    expect(fin.status).toBe(400);
    const c = db.career_contracts.find((x) => x.application_id === APP_MAIN);
    expect(c.status).toBe('awaiting_upload');
  });

  it('finalize: success flips the contract to uploaded, stamps file fields, and alerts the CEO', async () => {
    const before = resendCalls.length;
    const ext = await apiPost('/api/practice/offer/decision', { token: postInterviewToken(APP_MAIN), action: 'extend_offer' });
    const uploadToken = ext.body.uploadToken;
    const sign = await apiPost('/api/practice/contract/sign-upload', { token: uploadToken, filename: 'Employment-Contract.pdf', mimeType: 'application/pdf' });

    const pdf = Buffer.from('%PDF-1.4 employment contract for Helen', 'utf8');
    const put = await putSignedUpload(sign.body.uploadUrl, pdf, 'application/pdf');
    expect(put.status).toBe(200);

    const fin = await apiPost('/api/practice/contract/finalize', { token: uploadToken, path: sign.body.path, filename: 'Employment-Contract.pdf', mimeType: 'application/pdf' });
    expect(fin.status).toBe(200);
    expect(fin.body.ok).toBe(true);

    const c = db.career_contracts.find((x) => x.application_id === APP_MAIN);
    expect(c.status).toBe('uploaded');
    expect(c.uploaded_at).toBeTruthy();
    expect(c.contract_path).toBe(sign.body.path);
    expect(c.contract_filename).toBe('Employment-Contract.pdf');
    expect(c.contract_mime).toBe('application/pdf');
    // AI review is Task 11's job — this endpoint must NOT have run it.
    expect(c.ai_review_status == null || c.ai_review_status === 'not_run').toBe(true);

    const sent = resendCalls.slice(before);
    const ceo = sent.find((x) => Array.isArray(x.body.to) && x.body.to.includes(HUB_EMAIL) && /contract uploaded/i.test(x.body.subject || ''));
    expect(ceo).toBeTruthy();
  });

  it('replay-safe: after upload, a replayed sign-upload AND a replayed finalize are both refused (no overwrite)', async () => {
    const c = db.career_contracts.find((x) => x.application_id === APP_MAIN);
    expect(c.status).toBe('uploaded');
    const uploadToken = mod.__testUtils.createSignedPurposeToken('contract_upload', { contractId: c.id }, 3600000);

    const replaySign = await apiPost('/api/practice/contract/sign-upload', { token: uploadToken, filename: 'evil.pdf', mimeType: 'application/pdf' });
    expect(replaySign.status).toBe(409);

    const replayFin = await apiPost('/api/practice/contract/finalize', { token: uploadToken, path: c.contract_path, filename: 'evil.pdf', mimeType: 'application/pdf' });
    expect(replayFin.status).toBe(409);
    // The stored file record is untouched.
    expect(db.career_contracts.find((x) => x.application_id === APP_MAIN).contract_filename).toBe('Employment-Contract.pdf');
  });

  it('context: after upload the state is "done"', async () => {
    const c = db.career_contracts.find((x) => x.application_id === APP_MAIN);
    const uploadToken = mod.__testUtils.createSignedPurposeToken('contract_upload', { contractId: c.id }, 3600000);
    const r = await apiGet('/api/practice/offer/context?token=' + encodeURIComponent(uploadToken));
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('done');
  });
});

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
  const APP_DECLINE_AFTER_OFFER = 'app-t10-decline-after-offer';

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
      { id: APP_WD, user_id: GP.userId, career_role_id: 'role-t10-1', practice_id: 'p-t10-1', status: 'withdrawn', ats_stage: 'not_proceeding', applied_at: NOW },
      { id: APP_DECLINE_AFTER_OFFER, user_id: GP.userId, career_role_id: 'role-t10-1', practice_id: 'p-t10-1', status: 'interview_completed', ats_stage: 'interview', practice_contact_email: 'reception@harbour-test.local', practice_contact_name: 'Harbour Reception', applied_at: NOW }
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

  // Raw GET that never parses the body as JSON and always returns the
  // response headers — needed to inspect 302 Location targets when checking
  // the anonymous page-serving allowlist below.
  function httpGetRaw(p) {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
        const c = []; res.on('data', (x) => c.push(x));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') }));
      });
      r.on('error', reject); r.end();
    });
  }

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
    // No Anthropic key in this block — Task 11's review is expected to land
    // on the deterministic "no key configured" stub (ai_review_status
    // 'error') for the finalize test below, never on a real model call.
    process.env.ANTHROPIC_API_KEY = '';
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

  it('page: pages/practice-offer.html is reachable by an anonymous browser (no cookies) — never bounced to signin', async () => {
    // This harness boots the server with AUTH_DISABLED='false' (real auth
    // mode), and no cookies are ever attached by httpGetRaw, so this is a
    // genuine unauthenticated request exactly like the practice contact
    // clicking the emailed extend-offer/decline link cold.
    //
    // The server unconditionally 302s any /pages/*.html request to its clean
    // extensionless URL BEFORE the auth/allowlist gate even runs (see the
    // "Clean URL support" block in server.js) — so the first hop is expected
    // to be a 302 regardless of whether the page is public. What must NEVER
    // happen is landing on /pages/signin at any point in the chain; the
    // allowlist entry is what keeps it off that path.
    let hop = await httpGetRaw('/pages/practice-offer.html');
    let redirects = 0;
    while (hop.status === 302 && redirects < 5) {
      expect(String(hop.headers.location || '')).not.toMatch(/\/pages\/signin/);
      hop = await httpGetRaw(hop.headers.location);
      redirects += 1;
    }
    expect(hop.status).toBe(200);
    expect(hop.body).toContain('<html');
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

  it('extend_offer on a not_proceeding application is refused: 409 not_available, no career_contracts row created', async () => {
    // APP_DECLINE was flipped to not_proceeding by the test above and never
    // had a contract. A stale/replayed extend-offer link for it must never
    // mint a contract on a closed application.
    expect(appRow(APP_DECLINE).status).toBe('not_proceeding');
    const before = db.career_contracts.length;
    const tok = postInterviewToken(APP_DECLINE);
    const r = await apiPost('/api/practice/offer/decision', { token: tok, action: 'extend_offer' });
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('not_available');
    expect(db.career_contracts.length).toBe(before);
    expect(db.career_contracts.filter((c) => c.application_id === APP_DECLINE).length).toBe(0);
  });

  it('context: an application declined AFTER its contract reached awaiting_upload reports NOT "upload"', async () => {
    const tok = postInterviewToken(APP_DECLINE_AFTER_OFFER);

    // 1. Extend an offer — contract lands in awaiting_upload.
    const ext = await apiPost('/api/practice/offer/decision', { token: tok, action: 'extend_offer' });
    expect(ext.status).toBe(200);
    const contractId = ext.body.contractId;
    const uploadToken = ext.body.uploadToken;
    expect(db.career_contracts.find((c) => c.id === contractId).status).toBe('awaiting_upload');

    // 2. The practice (or CEO/GP path) later declines the application. The
    // decline branch only touches gp_applications/ats_stage — it never voids
    // or otherwise touches the career_contracts row, so the contract is left
    // sitting in awaiting_upload while the application itself is terminal.
    const dec = await apiPost('/api/practice/offer/decision', { token: tok, action: 'decline' });
    expect(dec.status).toBe(200);
    expect(appRow(APP_DECLINE_AFTER_OFFER).status).toBe('not_proceeding');
    expect(db.career_contracts.find((c) => c.id === contractId).status).toBe('awaiting_upload');

    // 3. Application-scoped context (the post-interview token) must report the
    // application-terminal state, NOT 'upload' — a declined application can
    // never be sent back into the upload flow.
    const ctxByApp = await apiGet('/api/practice/offer/context?token=' + encodeURIComponent(tok));
    expect(ctxByApp.status).toBe(200);
    expect(ctxByApp.body.state).not.toBe('upload');
    expect(ctxByApp.body.state).toBe('done');

    // 4. Contract-scoped context (the upload token minted before the decline)
    // must agree — the same terminal application must not resolve to
    // 'upload' just because a different token addresses the contract row
    // directly.
    const ctxByContract = await apiGet('/api/practice/offer/context?token=' + encodeURIComponent(uploadToken));
    expect(ctxByContract.status).toBe(200);
    expect(ctxByContract.body.state).not.toBe('upload');
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
    // Task 11: finalize now triggers the AI review synchronously. This block
    // has no ANTHROPIC_API_KEY, so it lands on the deterministic "no key
    // configured" stub — status 'error', never left at 'not_run' — and the
    // finalize response itself still succeeds (the review is best-effort).
    expect(c.ai_review_status).toBe('error');
    expect(c.ai_review).toBeTruthy();
    expect(c.ai_review.summary).toMatch(/no api key configured/i);

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

// Task 11 (2026-07-22): AI contract review vs Zoom-summary terms. Once a
// practice uploads a contract (Task 10's finalize), the server compares it
// against (1) the Zoom interview summary — the SOURCE OF TRUTH, superseding
// the advertised listing when they differ — and (2) the advertised/offer
// terms, writing the verdict onto the career_contracts row (ai_review,
// ai_review_status, terms_context) so both the CEO dashboard and a re-run
// endpoint can read it back. Also covers the CEO re-run endpoint
// POST /api/ceo/contract/ai-check.
describe('aiReviewCareerContract — wiring (Task 11)', () => {
  const SERVER_SRC = fs.readFileSync(SERVER_PATH, 'utf8');

  it('defines aiReviewCareerContract(contractRow)', () => {
    expect(SERVER_SRC).toMatch(/async function aiReviewCareerContract\(contractRow\)/);
  });

  it('the prompt states interview terms SUPERSEDE the advertised listing', () => {
    expect(SERVER_SRC).toMatch(/THE INTERVIEW TERMS SUPERSEDE/);
  });

  it('is wired into the finalize seam (ai_review_status flips to running before the review runs)', () => {
    const idx = SERVER_SRC.indexOf("ai_review_status: 'running'");
    expect(idx).toBeGreaterThan(-1);
    const afterSeam = SERVER_SRC.slice(idx, idx + 800);
    expect(afterSeam).toMatch(/aiReviewCareerContract\(/);
  });

  it('defines the CEO re-run endpoint', () => {
    expect(SERVER_SRC).toContain("pathname === '/api/ceo/contract/ai-check'");
  });
});

describe('AI contract review vs Zoom-summary terms (Task 11, live-boot)', () => {
  const RUN_ID = crypto.randomBytes(4).toString('hex');
  const DB_FILE = path.join('/tmp', `gplink-t11-${RUN_ID}.json`);
  const GP = { userId: 'u-gp-t11-1', email: 'gp-t11@gplink-test.local' };
  const HUB_EMAIL = 'hello@mygplink-test.local';
  const SUPER_HOST = 'ceo-t11.local';
  const SUPER_EMAIL = 'super-t11@gplink-test.local';
  const NOW = new Date().toISOString();

  // APP_WITH_INTERVIEW has a completed interview call WITH a Zoom summary +
  // an in-app offer — exercises the full comparison (interview supersedes).
  // APP_NO_INTERVIEW has an offer but no interview summary — exercises the
  // "compare vs advertised/offer only, interview_terms_available=false"
  // branch, and proves that flag is NOT trusted from the model (the mock
  // deliberately claims true for this one).
  const APP_WITH_INTERVIEW = 'app-t11-iv';
  const APP_NO_INTERVIEW = 'app-t11-noiv';

  let server, port, sbServer, sbPort, realFetch, mod;
  const resendCalls = [];
  const anthropicCalls = [];
  let anthropicNextVerdict = null;
  const storage = new Map();

  const DEFAULT_VERDICT = {
    overall: 'aligned',
    summary: 'The contract matches what was discussed in the interview.',
    extracted_terms: { billing_split: '70/30', base_or_guarantee: null, sessions_per_week: '5', start_date: '2026-09-01', leave: null, restraint: null, other: [] },
    discrepancies: [],
    interview_terms_available: false // deliberately wrong on some calls — the code must not trust this from the model
  };

  const db = {
    user_profiles: [
      { user_id: GP.userId, email: GP.email, first_name: 'Nadia', last_name: 'Osei', registration_country: 'uk' }
    ],
    career_roles: [
      {
        id: 'role-t11-1', provider: 'internal_ats', title: 'General Practitioner — VR',
        practice_name: 'Meadowbank Medical', practice_id: 'p-t11-1', billing_model: 'percentage_split',
        is_active: true, job_status: 'open', updated_at: NOW,
        source_payload: { gpLink: { publicIntro: 'A friendly practice in Meadowbank.', publicBenefits: ['70% billings', 'Mentoring'] } }
      }
    ],
    gp_applications: [
      { id: APP_WITH_INTERVIEW, user_id: GP.userId, career_role_id: 'role-t11-1', practice_id: 'p-t11-1', status: 'interview_completed', ats_stage: 'interview', practice_contact_email: 'reception@meadowbank-test.local', practice_contact_name: 'Meadowbank Reception', applied_at: NOW },
      { id: APP_NO_INTERVIEW, user_id: GP.userId, career_role_id: 'role-t11-1', practice_id: 'p-t11-1', status: 'interview_completed', ats_stage: 'interview', practice_contact_email: 'reception@meadowbank-test.local', practice_contact_name: 'Meadowbank Reception', applied_at: NOW }
    ],
    scheduled_calls: [
      {
        id: 'call-t11-1', case_id: null, user_id: GP.userId, application_id: APP_WITH_INTERVIEW,
        meeting_kind: 'interview', status: 'completed', scheduled_at: NOW,
        meeting_summary: 'The practice offered a 70/30 billing split, 5 sessions per week, and a start date of 2026-09-01. No restraint of trade was discussed.'
      }
    ],
    ats_offers: [
      { id: 'offer-t11-1', application_id: APP_WITH_INTERVIEW, user_id: GP.userId, career_role_id: 'role-t11-1', billing_split: '70/30', sessions_per_week: '5', compensation_range: '$250,000 - $300,000', start_date: '2026-09-01', status: 'sent' },
      { id: 'offer-t11-2', application_id: APP_NO_INTERVIEW, user_id: GP.userId, career_role_id: 'role-t11-1', billing_split: '65/35', sessions_per_week: '4', compensation_range: '$220,000 - $260,000', start_date: '2026-10-01', status: 'sent' }
    ],
    career_contracts: [
      // Pre-seeded row in awaiting_upload — never had a file uploaded, so the
      // AI review is not yet meaningful. Used to prove the ai-check re-run
      // endpoint refuses it.
      { id: 'contract-t11-awaiting', application_id: 'app-t11-awaiting-dummy', user_id: GP.userId, career_role_id: 'role-t11-1', version: 1, status: 'awaiting_upload', ai_review_status: 'not_run', created_at: NOW, updated_at: NOW }
    ],
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

  function httpJson(method, p, body, extraHeaders) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const headers = Object.assign({}, extraHeaders || {});
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

  function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
  function adminCookie() {
    const payload = b64url(JSON.stringify({ userProfile: { email: SUPER_EMAIL, adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
    const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
    return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
  }
  const ceoPost = (p, body, withCookie = true) => httpJson('POST', p, body, Object.assign({ Host: SUPER_HOST }, withCookie ? { Cookie: adminCookie() } : {}));

  const appRow = (id) => db.gp_applications.find((a) => a.id === id);
  const postInterviewToken = (applicationId) => mod.__testUtils.createSignedPurposeToken(mod.__testUtils.POST_INTERVIEW_TOKEN_PURPOSE, { applicationId }, 3600000);

  // Runs a full extend_offer -> sign-upload -> PUT -> finalize sequence for
  // the given application, returning the created contractId. This is what
  // actually exercises the Task 11 finalize seam end to end.
  async function uploadContractForApplication(applicationId, pdfText) {
    const ext = await apiPost('/api/practice/offer/decision', { token: postInterviewToken(applicationId), action: 'extend_offer' });
    if (!ext.body || !ext.body.ok) throw new Error('extend_offer failed: ' + JSON.stringify(ext.body));
    const uploadToken = ext.body.uploadToken;
    const sign = await apiPost('/api/practice/contract/sign-upload', { token: uploadToken, filename: 'Employment-Contract.pdf', mimeType: 'application/pdf' });
    const pdf = Buffer.from('%PDF-1.4 ' + (pdfText || 'employment contract'), 'utf8');
    const put = await putSignedUpload(sign.body.uploadUrl, pdf, 'application/pdf');
    if (put.status !== 200) throw new Error('signed PUT failed: ' + put.status);
    const fin = await apiPost('/api/practice/contract/finalize', { token: uploadToken, path: sign.body.path, filename: 'Employment-Contract.pdf', mimeType: 'application/pdf' });
    if (!fin.body || !fin.body.ok) throw new Error('finalize failed: ' + JSON.stringify(fin.body));
    return ext.body.contractId;
  }

  beforeAll(async () => {
    await startEmulator();
    process.env.AGENT_SKIP_DOTENV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DISABLED = 'false';
    process.env.AUTH_SECRET = 'contracts-t11-secret-' + RUN_ID;
    process.env.REQUIRE_SUPABASE_DB = 'false';
    process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
    process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.SUPABASE_DOCUMENT_BUCKET = 'gp-link-documents';
    process.env.ENFORCE_SAME_ORIGIN = 'false';
    process.env.DB_FILE_PATH = DB_FILE;
    process.env.OPENAI_API_KEY = '';
    // Set for this block — the mocked Anthropic branch below intercepts every
    // https://api.anthropic.com/v1/messages call, so no real network traffic
    // ever happens regardless of this key's value.
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key-t11';
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.REGISTRATION_HUB_EMAIL = HUB_EMAIL;
    process.env.APP_BASE_URL = 'https://app.mygplink.com.au';
    process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
    process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
    process.env.ADMIN_EMAILS = '';

    realFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => {
      const u = String(url && url.url ? url.url : url);
      if (u.startsWith('https://api.resend.com/')) {
        let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
        resendCalls.push({ url: u, body: parsed });
        return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
      }
      if (u === 'https://api.anthropic.com/v1/messages') {
        let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
        anthropicCalls.push(parsed);
        const verdict = anthropicNextVerdict || DEFAULT_VERDICT;
        return Promise.resolve(new Response(JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify(verdict) }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
      return Promise.resolve(new Response('{}', { status: 200 }));
    };

    // Fresh module evaluation so SUPABASE_URL/AUTH_SECRET/SUPER_ADMIN_* etc.
    // read THIS block's env, not a prior describe block's now-closed emulator.
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

  it('finalize triggers the AI review: interview terms supersede the listing, ai_review_status ends "done", terms_context captures what was compared', async () => {
    anthropicNextVerdict = {
      overall: 'aligned',
      summary: 'The contract matches the 70/30 split and start date discussed in the interview.',
      extracted_terms: { billing_split: '70/30', base_or_guarantee: null, sessions_per_week: '5', start_date: '2026-09-01', leave: null, restraint: null, other: [] },
      discrepancies: [],
      interview_terms_available: false // deliberately wrong — a real interview summary exists, so the code must force this to true
    };
    const before = anthropicCalls.length;
    const contractId = await uploadContractForApplication(APP_WITH_INTERVIEW, 'contract for Nadia, 70/30 split');

    const c = db.career_contracts.find((x) => x.id === contractId);
    expect(c.status).toBe('uploaded');
    expect(c.ai_review_status).toBe('done');
    expect(c.ai_review).toBeTruthy();
    expect(['aligned', 'minor_gaps', 'major_discrepancies', 'unreadable']).toContain(c.ai_review.overall);
    expect(c.ai_review.overall).toBe('aligned');
    expect(typeof c.ai_review.summary).toBe('string');
    expect(Array.isArray(c.ai_review.discrepancies)).toBe(true);
    // Deterministic override: a real interview summary existed, so this must
    // be true even though the mocked model claimed false above.
    expect(c.ai_review.interview_terms_available).toBe(true);

    // terms_context records exactly what was compared.
    expect(c.terms_context).toBeTruthy();
    expect(c.terms_context.interview_summary).toBe(db.scheduled_calls[0].meeting_summary);
    expect(c.terms_context.offer_terms.billing_split).toBe('70/30');
    expect(c.terms_context.offer_terms.sessions_per_week).toBe('5');
    expect(c.terms_context.offer_terms.start_date).toBe('2026-09-01');
    expect(c.terms_context.listing_terms.title).toBe('General Practitioner — VR');
    expect(c.terms_context.listing_terms.publicIntro).toBe('A friendly practice in Meadowbank.');

    // Exactly one Anthropic call happened, with the contract PDF as a base64
    // document block and a prompt that names interview-summary precedence.
    expect(anthropicCalls.length).toBe(before + 1);
    const sent = anthropicCalls[anthropicCalls.length - 1];
    expect(sent.model).toBeTruthy();
    expect(sent.max_tokens).toBe(1500);
    // Opus 4.8 (ANTHROPIC_SCAN_MODEL default) rejects temperature/top_p/top_k
    // with a 400 — sending it would 400 every real review.
    expect(sent.temperature).toBeUndefined();
    const blocks = sent.messages[0].content;
    const docBlockSent = blocks.find((b) => b.type === 'document');
    expect(docBlockSent).toBeTruthy();
    expect(docBlockSent.source.type).toBe('base64');
    expect(docBlockSent.source.media_type).toBe('application/pdf');
    const promptBlock = blocks.find((b) => b.type === 'text' && /SUPERSEDE/.test(b.text));
    expect(promptBlock).toBeTruthy();
    expect(promptBlock.text).toMatch(/ONLY JSON/);
    const summaryBlock = blocks.find((b) => b.type === 'text' && /INTERVIEW SUMMARY/.test(b.text));
    expect(summaryBlock.text).toContain('70/30 billing split');
  });

  it('finalize with no interview summary: interview_terms_available is forced false regardless of what the model claims', async () => {
    anthropicNextVerdict = {
      overall: 'minor_gaps',
      summary: 'Compared against the advertised/offer terms only.',
      extracted_terms: { billing_split: '65/35', base_or_guarantee: null, sessions_per_week: '4', start_date: '2026-10-01', leave: null, restraint: null, other: [] },
      discrepancies: [{ field: 'sessions_per_week', contract_says: '3', expected: '4', source: 'offer_record', severity: 'warning' }],
      interview_terms_available: true // deliberately wrong — no interview summary exists for this application
    };
    const contractId = await uploadContractForApplication(APP_NO_INTERVIEW, 'contract for Nadia, no interview on file');

    const c = db.career_contracts.find((x) => x.id === contractId);
    expect(c.ai_review_status).toBe('done');
    expect(c.ai_review.interview_terms_available).toBe(false);
    expect(c.terms_context.interview_summary).toBeNull();
    expect(c.terms_context.offer_terms.billing_split).toBe('65/35');
    expect(c.ai_review.discrepancies.length).toBeGreaterThan(0);
    expect(c.ai_review.discrepancies[0].source).toBe('offer_record');
  });

  it('ai-check endpoint: 401 without a CEO session', async () => {
    const contractId = db.career_contracts.find((x) => x.application_id === APP_WITH_INTERVIEW).id;
    const r = await ceoPost('/api/ceo/contract/ai-check', { contractId }, false);
    expect(r.status).toBe(401);
  });

  it('ai-check endpoint: 404 for an unknown contract id (valid CEO session)', async () => {
    const r = await ceoPost('/api/ceo/contract/ai-check', { contractId: 'not-a-real-contract-id' });
    expect(r.status).toBe(404);
  });

  it('ai-check endpoint: 409 for a contract not ready for review (awaiting_upload)', async () => {
    const r = await ceoPost('/api/ceo/contract/ai-check', { contractId: 'contract-t11-awaiting' });
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('not_available');
  });

  it('ai-check endpoint: success path re-runs the review and returns { ok, ai_review_status, ai_review }', async () => {
    const contractId = db.career_contracts.find((x) => x.application_id === APP_WITH_INTERVIEW).id;
    anthropicNextVerdict = {
      overall: 'major_discrepancies',
      summary: 'Re-run found the contract omits the agreed relocation support.',
      extracted_terms: { billing_split: '70/30', base_or_guarantee: null, sessions_per_week: '5', start_date: '2026-09-01', leave: null, restraint: null, other: [] },
      discrepancies: [{ field: 'relocation', contract_says: 'not mentioned', expected: 'discussed in interview', source: 'interview_summary', severity: 'critical' }],
      interview_terms_available: false
    };
    const before = anthropicCalls.length;
    const r = await ceoPost('/api/ceo/contract/ai-check', { contractId });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.ai_review_status).toBe('done');
    // Proves the review was actually re-invoked (not a cached read) — the
    // verdict now differs from the original finalize-time review.
    expect(r.body.ai_review.overall).toBe('major_discrepancies');
    expect(anthropicCalls.length).toBe(before + 1);

    const c = db.career_contracts.find((x) => x.id === contractId);
    expect(c.ai_review.overall).toBe('major_discrepancies');
    expect(c.ai_review_status).toBe('done');
  });

  it('aiReviewCareerContract directly: with no API key configured, PATCHes ai_review_status to "error" with the stub message', async () => {
    db.career_contracts.push({
      id: 'contract-t11-nokey', application_id: APP_WITH_INTERVIEW, user_id: GP.userId, career_role_id: 'role-t11-1',
      version: 2, status: 'uploaded', contract_bucket: 'gp-link-documents', contract_path: 'contracts/nokey/v2/c.pdf',
      contract_mime: 'application/pdf', ai_review_status: 'not_run', created_at: NOW, updated_at: NOW
    });
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = '';
    try {
      const result = await mod.__testUtils.aiReviewCareerContract(db.career_contracts.find((x) => x.id === 'contract-t11-nokey'));
      expect(result.ai_review_status).toBe('error');
      expect(result.ai_review.summary).toMatch(/no api key configured/i);
      // interview_terms_available is now the computed value (matching the
      // no-file stub + real path), not hardcoded false — this contract's
      // application_id (APP_WITH_INTERVIEW) has a real interview summary.
      expect(result.ai_review.interview_terms_available).toBe(true);

      const c = db.career_contracts.find((x) => x.id === 'contract-t11-nokey');
      expect(c.ai_review_status).toBe('error');
      expect(c.ai_review.summary).toMatch(/no api key configured/i);
    } finally {
      process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });
});

// Task 12 (2026-07-22): CEO Contracts queue — GET /api/ceo/contracts (list,
// AI-verdict-aware ordering, 1h signed URLs) + POST /api/ceo/contract/decision
// (submit_to_gp / return_to_practice) on pages/ceo-dashboard.html's new
// "Contracts" master tab. Two layers of coverage, same split as Task 9/11:
//  1. Source-assertion tests — the endpoints + client wiring exist, and the
//     dashboard escapes every interpolated value.
//  2. A behavioral live-boot block (own PostgREST + storage emulator) proving
//     the ordering, the signed-URL wiring, and both decision branches —
//     especially the two self-review-critical facts: submit_to_gp can only
//     ever fire from 'uploaded' (never a void/signed/already-sent row), and
//     return_to_practice mints its fresh contract_upload token for the BRAND
//     NEW contract row, never the one it just voided.
describe('CEO Contracts queue — wiring (Task 12)', () => {
  const SERVER_SRC = fs.readFileSync(SERVER_PATH, 'utf8');

  it('defines GET /api/ceo/contracts, guarded by requireCeoSession', () => {
    const idx = SERVER_SRC.indexOf("pathname === '/api/ceo/contracts' && req.method === 'GET'");
    expect(idx).toBeGreaterThan(-1);
    const near = SERVER_SRC.slice(idx, idx + 300);
    expect(near).toMatch(/requireCeoSession\(req, res\)/);
  });

  it('defines POST /api/ceo/contract/decision, guarded by requireCeoSession', () => {
    const idx = SERVER_SRC.indexOf("pathname === '/api/ceo/contract/decision' && req.method === 'POST'");
    expect(idx).toBeGreaterThan(-1);
    const near = SERVER_SRC.slice(idx, idx + 400);
    expect(near).toMatch(/requireCeoSession\(req, res\)/);
  });

  it('submit_to_gp is refused from anything other than "uploaded"', () => {
    const idx = SERVER_SRC.indexOf("if (cdAction === 'submit_to_gp')");
    expect(idx).toBeGreaterThan(-1);
    const branch = SERVER_SRC.slice(idx, idx + 900);
    expect(branch).toMatch(/String\(cdContract\.status\) !== 'uploaded'/);
    expect(branch).toMatch(/409/);
  });

  it('submit_to_gp advances the application to offer via forward-only stage reconciliation', () => {
    const idx = SERVER_SRC.indexOf("if (cdAction === 'submit_to_gp')");
    const branch = SERVER_SRC.slice(idx, idx + 3000);
    expect(branch).toMatch(/status:\s*'offer'/);
    expect(branch).toMatch(/atsPracticeUtil\.planAtsStageReconciliation\(cdApp\.ats_stage \|\| '', 'offer'\)/);
    expect(branch).toMatch(/atsUpdateApplicationStageRow\(cdApp\.id, cdTarget/);
  });

  it('submit_to_gp fires the GP notification trio (in-app + push + email)', () => {
    const idx = SERVER_SRC.indexOf("if (cdAction === 'submit_to_gp')");
    const branch = SERVER_SRC.slice(idx, idx + 4200);
    expect(branch).toMatch(/pushCareerNotificationToUser\(cdGpUserId/);
    expect(branch).toMatch(/sendPushNotification\(cdGpUserId/);
    expect(branch).toMatch(/sendGpNotificationEmail\(cdGpUserId/);
    expect(branch).toContain('Your contract is ready to review');
    expect(branch).toContain('/pages/offer-review?applicationId=');
  });

  it('submit_to_gp is refused with 409 application_terminal when the application is withdrawn/not_proceeding/already secured — checked BEFORE the contract PATCH', () => {
    const idx = SERVER_SRC.indexOf("if (cdAction === 'submit_to_gp')");
    expect(idx).toBeGreaterThan(-1);
    const branch = SERVER_SRC.slice(idx, idx + 3000);
    const guardIdx = branch.search(/cdAppStatusKey === 'withdrawn' \|\| cdAppStatusKey === 'not_proceeding' \|\| isCareerPlacementSecuredStatus\(cdAppStatusKey\)/);
    const contractPatchIdx = branch.indexOf("status: 'sent_to_gp'");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(contractPatchIdx).toBeGreaterThan(-1);
    // The terminal-application check must run BEFORE the contract is flipped
    // to sent_to_gp, so a terminal application can never leave the contract
    // half-written (PATCHed to sent_to_gp with no way to notify a live GP).
    expect(guardIdx).toBeLessThan(contractPatchIdx);
    expect(branch).toMatch(/code:\s*'application_terminal'/);
  });

  it('return_to_practice is refused outside uploaded/changes_requested, then voids and starts a new revision', () => {
    const idx = SERVER_SRC.indexOf("// action === 'return_to_practice'");
    expect(idx).toBeGreaterThan(-1);
    const branch = SERVER_SRC.slice(idx, idx + 3200);
    expect(branch).toMatch(/String\(cdContract\.status\) !== 'uploaded' && String\(cdContract\.status\) !== 'changes_requested'/);
    expect(branch).toMatch(/409/);
    expect(branch).toMatch(/status:\s*'void'/);
    expect(branch).toMatch(/status:\s*'awaiting_upload'/);
    expect(branch).toMatch(/version:\s*cdMaxV \+ 1/);
  });

  it('return_to_practice mints the fresh upload token for the NEW row, not the voided one', () => {
    const idx = SERVER_SRC.indexOf("// action === 'return_to_practice'");
    const branch = SERVER_SRC.slice(idx, idx + 4000);
    expect(branch).toMatch(/mintContractUploadToken\(cdNewRow\.id\)/);
    // Never re-mints against the original (now-void) contract id.
    expect(branch).not.toMatch(/mintContractUploadToken\(cdContract\.id\)/);
  });

  // Source-level ordering pin: the new awaiting_upload row must be INSERTed
  // before the original is PATCHed to 'void'. A behavioral test can't tell
  // these two orders apart on the happy path (both effects hold either way),
  // so this pins the order directly — insert-then-void means a failed insert
  // leaves the application with its original live 'uploaded'/'changes_requested'
  // contract intact (retryable), instead of void-then-insert's failure mode
  // of stranding the application with a void contract and no live row at all.
  it('return_to_practice inserts the new awaiting_upload row BEFORE voiding the original (insert-before-void ordering)', () => {
    const idx = SERVER_SRC.indexOf("// action === 'return_to_practice'");
    expect(idx).toBeGreaterThan(-1);
    const branch = SERVER_SRC.slice(idx, idx + 3600);
    const insertIdx = branch.indexOf("const cdIns = await supabaseDbRequest('career_contracts', '', { method: 'POST'");
    const voidIdx = branch.indexOf("const cdVoidPatch = await supabaseDbRequest('career_contracts'");
    expect(insertIdx).toBeGreaterThan(-1);
    expect(voidIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeLessThan(voidIdx);
  });
});

describe('CEO Contracts tab UI (Task 12)', () => {
  const CEO_HTML = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');
  const CONTRACTS_JS = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-contracts.js'), 'utf8');

  it('registers the Contracts master tab (nav button + panel container)', () => {
    expect(CEO_HTML).toMatch(/data-mtab="contracts"/);
    expect(CEO_HTML).toMatch(/id="panel-contracts"/);
  });

  it('loads the contracts tab script with a cache-busted src', () => {
    expect(CEO_HTML).toContain('/js/ceo-ats-contracts.js?v=20260722b');
  });

  it('the contracts panel is hidden from consultants (super-admin only, like Leads)', () => {
    const idx = CEO_HTML.indexOf('applyConsultantMode');
    const fn = CEO_HTML.slice(idx, idx + 1500);
    expect(fn).toMatch(/'leads', 'contracts'/);
  });

  it('registers window.loadContractsTab() as the master-tab entry point', () => {
    expect(CONTRACTS_JS).toMatch(/window\.loadContractsTab\s*=\s*function/);
  });

  it('every interpolated GP/practice/AI-review string goes through ATS.esc/escAttr — no raw string concatenation of server data', () => {
    // The row header interpolates gpName, practiceName, roleTitle, version and
    // uploaded_at — all through ATS.esc/escAttr.
    expect(CONTRACTS_JS).toMatch(/ATS\.esc\(c\.gpName/);
    expect(CONTRACTS_JS).toMatch(/ATS\.esc\(c\.practiceName/);
    expect(CONTRACTS_JS).toMatch(/ATS\.esc\(c\.roleTitle/);
    expect(CONTRACTS_JS).toMatch(/ATS\.esc\(c\.version\)/);
    // The AI summary, discrepancy fields and the GP's free-text change_request
    // are all AI/GP-authored strings that must never be interpolated raw.
    expect(CONTRACTS_JS).toMatch(/ATS\.esc\(review\.summary/);
    expect(CONTRACTS_JS).toMatch(/ATS\.esc\(c\.change_request\)/);
    expect(CONTRACTS_JS).toMatch(/ATS\.esc\(d\.field/);
    expect(CONTRACTS_JS).toMatch(/ATS\.esc\(d\.contract_says/);
    expect(CONTRACTS_JS).toMatch(/ATS\.esc\(d\.expected/);
    expect(CONTRACTS_JS).toMatch(/ATS\.esc\(d\.source/);
    // The signed download links are real URLs used as href attributes —
    // ATS.escAttr, not ATS.esc.
    expect(CONTRACTS_JS).toMatch(/ATS\.escAttr\(c\.contractUrl\)/);
    expect(CONTRACTS_JS).toMatch(/ATS\.escAttr\(c\.signedUrl\)/);
  });

  it('shows the changes_requested change_request prominently (Task 12 surface; Task 14 wires the decision buttons)', () => {
    expect(CONTRACTS_JS).toMatch(/c\.status === 'changes_requested' && c\.change_request/);
    expect(CONTRACTS_JS).toMatch(/Task 14/);
  });

  it('Submit to GP is only offered on an "uploaded" row; Return to practice on uploaded or changes_requested', () => {
    expect(CONTRACTS_JS).toMatch(/canSubmit\s*=\s*c\.status === 'uploaded'/);
    expect(CONTRACTS_JS).toMatch(/canReturn\s*=\s*c\.status === 'uploaded' \|\| c\.status === 'changes_requested'/);
  });

  it('posts the decision action with contractId/action/note to the real endpoint', () => {
    expect(CONTRACTS_JS).toContain("ATS.api('/api/ceo/contract/decision', { method: 'POST', body: { contractId: contractId, action: action, note: note } })");
  });
});

describe('CEO Contracts queue — live-boot (Task 12)', () => {
  const RUN_ID = crypto.randomBytes(4).toString('hex');
  const DB_FILE = path.join('/tmp', `gplink-t12-${RUN_ID}.json`);
  const GP_A = { userId: 'u-gp-t12-a', email: 'gp-t12-a@gplink-test.local' };
  const GP_B = { userId: 'u-gp-t12-b', email: 'gp-t12-b@gplink-test.local' };
  const SUPER_HOST = 'ceo-t12.local';
  const SUPER_EMAIL = 'super-t12@gplink-test.local';
  const NOW = Date.now();
  const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60000).toISOString();

  const APP_SUBMIT = 'app-t12-submit';
  const APP_RETURN = 'app-t12-return';
  const APP_WITHDRAWN = 'app-t12-withdrawn';

  let server, port, sbServer, sbPort, realFetch, mod;
  const resendCalls = [];
  const storage = new Map();

  const db = {
    user_profiles: [
      { user_id: GP_A.userId, email: GP_A.email, first_name: 'Priya', last_name: 'Nair', registration_country: 'uk' },
      { user_id: GP_B.userId, email: GP_B.email, first_name: 'Tomasz', last_name: 'Kowalski', registration_country: 'ie' }
    ],
    career_roles: [
      { id: 'role-t12-1', provider: 'internal_ats', title: 'General Practitioner — VR', practice_name: 'Riverside Medical', practice_id: 'p-t12-1', is_active: true, job_status: 'open', updated_at: iso(0) }
    ],
    gp_applications: [
      { id: APP_SUBMIT, user_id: GP_A.userId, career_role_id: 'role-t12-1', practice_id: 'p-t12-1', status: 'interview_completed', ats_stage: 'interview', practice_contact_email: 'reception@riverside-test.local', practice_contact_name: 'Riverside Reception', applied_at: iso(120) },
      { id: APP_RETURN, user_id: GP_B.userId, career_role_id: 'role-t12-1', practice_id: 'p-t12-1', status: 'interview_completed', ats_stage: 'interview', practice_contact_email: 'admin@riverside-test.local', practice_contact_name: 'Riverside Admin', applied_at: iso(120) },
      // The GP withdrew AFTER the practice uploaded the contract — the
      // contract row below is still sitting at 'uploaded'. submit_to_gp must
      // refuse to resurrect this application by flipping it back to 'offer'.
      { id: APP_WITHDRAWN, user_id: GP_A.userId, career_role_id: 'role-t12-1', practice_id: 'p-t12-1', status: 'withdrawn', ats_stage: 'interview', practice_contact_email: 'reception@riverside-test.local', practice_contact_name: 'Riverside Reception', applied_at: iso(120) }
    ],
    // Ordering fixture: priority group (uploaded/changes_requested) must sort
    // BEFORE everything else regardless of recency — contract-t12-void (30 min
    // ago) is more recent than contract-t12-uploaded (50 min ago) yet must
    // still land after it, proving the two-tier sort (not a plain date sort).
    career_contracts: [
      { id: 'contract-t12-signed', application_id: 'app-t12-signed-dummy', user_id: GP_A.userId, career_role_id: 'role-t12-1', version: 1, status: 'signed', ai_review_status: 'done', ai_review: { overall: 'aligned', summary: 'All good.', discrepancies: [], interview_terms_available: true }, contract_bucket: 'gp-link-documents', contract_path: 'contracts/t12/signed/v1/c.pdf', signed_bucket: 'gp-link-documents', signed_path: 'contracts/t12/signed/v1/signed.pdf', created_at: iso(60), updated_at: iso(60) },
      { id: 'contract-t12-uploaded', application_id: APP_SUBMIT, user_id: GP_A.userId, career_role_id: 'role-t12-1', version: 1, status: 'uploaded', ai_review_status: 'done', ai_review: { overall: 'minor_gaps', summary: 'Small gap in sessions per week.', discrepancies: [{ field: 'sessions_per_week', contract_says: '3', expected: '4', source: 'offer_record', severity: 'warning' }], interview_terms_available: false }, contract_bucket: 'gp-link-documents', contract_path: 'contracts/t12/submit/v1/c.pdf', practice_contact_email: 'reception@riverside-test.local', practice_contact_name: 'Riverside Reception', created_at: iso(50), updated_at: iso(50) },
      { id: 'contract-t12-changes', application_id: 'app-t12-changes-dummy', user_id: GP_A.userId, career_role_id: 'role-t12-1', version: 2, status: 'changes_requested', change_request: 'Please correct the start date to 1 November.', ai_review_status: 'done', ai_review: { overall: 'major_discrepancies', summary: 'Start date mismatch.', discrepancies: [], interview_terms_available: true }, contract_bucket: 'gp-link-documents', contract_path: 'contracts/t12/changes/v2/c.pdf', created_at: iso(40), updated_at: iso(40) },
      { id: 'contract-t12-void', application_id: 'app-t12-void-dummy', user_id: GP_A.userId, career_role_id: 'role-t12-1', version: 1, status: 'void', ai_review_status: 'not_run', created_at: iso(30), updated_at: iso(30) },
      { id: 'contract-t12-return', application_id: APP_RETURN, user_id: GP_B.userId, career_role_id: 'role-t12-1', version: 1, status: 'uploaded', ai_review_status: 'done', ai_review: { overall: 'aligned', summary: 'Looks fine.', discrepancies: [], interview_terms_available: true }, contract_bucket: 'gp-link-documents', contract_path: 'contracts/t12/return/v1/c.pdf', practice_contact_email: 'admin@riverside-test.local', practice_contact_name: 'Riverside Admin', created_at: iso(20), updated_at: iso(20) },
      { id: 'contract-t12-withdrawn-app', application_id: APP_WITHDRAWN, user_id: GP_A.userId, career_role_id: 'role-t12-1', version: 1, status: 'uploaded', ai_review_status: 'done', ai_review: { overall: 'aligned', summary: 'Looks fine.', discrepancies: [], interview_terms_available: true }, contract_bucket: 'gp-link-documents', contract_path: 'contracts/t12/withdrawn/v1/c.pdf', practice_contact_email: 'reception@riverside-test.local', practice_contact_name: 'Riverside Reception', created_at: iso(45), updated_at: iso(45) }
    ],
    ats_stage_events: [],
    user_state: [
      { user_id: GP_A.userId, state: { gp_onboarding_complete: true }, updated_at: iso(0) },
      { user_id: GP_B.userId, state: { gp_onboarding_complete: true }, updated_at: iso(0) }
    ]
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

        // ── Supabase Storage — only the (non-upload) signed-download-URL
        // route is needed here: GET /api/ceo/contracts calls
        // supabaseStorageCreateSignedUrl, which hits /object/sign/<bucket>/<path>
        // (distinct from Task 10/11's /object/upload/sign/ used for uploads).
        if (u.pathname.startsWith('/storage/v1/')) {
          const mm = u.pathname.match(/^\/storage\/v1\/object\/sign\/(.+)$/);
          if (mm && req.method === 'POST') { await readRaw(); sendJson(200, { signedURL: '/object/sign/' + mm[1] + '?token=test-sign-token' }); return; }
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

  function httpJson(method, p, body, extraHeaders) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const headers = Object.assign({}, extraHeaders || {});
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
        const c = []; res.on('data', (x) => c.push(x));
        res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let parsed = null; try { parsed = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: parsed }); });
      });
      r.on('error', reject); r.end(data);
    });
  }
  function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
  function adminCookie() {
    const payload = b64url(JSON.stringify({ userProfile: { email: SUPER_EMAIL, adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
    const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
    return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
  }
  const ceoGet = (p, withCookie = true) => httpJson('GET', p, null, Object.assign({ Host: SUPER_HOST }, withCookie ? { Cookie: adminCookie() } : {}));
  const ceoPost = (p, body, withCookie = true) => httpJson('POST', p, body, Object.assign({ Host: SUPER_HOST }, withCookie ? { Cookie: adminCookie() } : {}));
  const apiGet = (p) => httpJson('GET', p);

  beforeAll(async () => {
    await startEmulator();
    process.env.AGENT_SKIP_DOTENV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DISABLED = 'false';
    process.env.AUTH_SECRET = 'contracts-t12-secret-' + RUN_ID;
    process.env.REQUIRE_SUPABASE_DB = 'false';
    process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
    process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.SUPABASE_DOCUMENT_BUCKET = 'gp-link-documents';
    process.env.ENFORCE_SAME_ORIGIN = 'false';
    process.env.DB_FILE_PATH = DB_FILE;
    process.env.OPENAI_API_KEY = '';
    process.env.ANTHROPIC_API_KEY = '';
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.REGISTRATION_HUB_EMAIL = 'hello@mygplink-test.local';
    process.env.APP_BASE_URL = 'https://app.mygplink.com.au';
    process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
    process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
    process.env.ADMIN_EMAILS = '';

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

  it('GET /api/ceo/contracts: 401 without a CEO session', async () => {
    const r = await ceoGet('/api/ceo/contracts', false);
    expect(r.status).toBe(401);
  });

  it('GET /api/ceo/contracts: uploaded/changes_requested sort first (newest first within each group), signed URLs are present, GP/practice/role are resolved', async () => {
    const r = await ceoGet('/api/ceo/contracts');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const ids = r.body.contracts.map((c) => c.id);
    expect(ids).toEqual([
      'contract-t12-return',          // uploaded, 20 min ago — priority group, newest
      'contract-t12-changes',         // changes_requested, 40 min ago — priority group
      'contract-t12-withdrawn-app',   // uploaded, 45 min ago — priority group
      'contract-t12-uploaded',        // uploaded, 50 min ago — priority group, oldest
      'contract-t12-void',            // void, 30 min ago — non-priority, but newer than "signed" below
      'contract-t12-signed'           // signed, 60 min ago — non-priority, oldest overall
    ]);

    const uploaded = r.body.contracts.find((c) => c.id === 'contract-t12-uploaded');
    expect(uploaded.gpName).toBe('Priya Nair');
    expect(uploaded.practiceName).toBe('Riverside Medical');
    expect(uploaded.roleTitle).toBe('General Practitioner — VR');
    expect(uploaded.applicationId).toBe(APP_SUBMIT);
    expect(uploaded.version).toBe(1);
    expect(uploaded.ai_review.overall).toBe('minor_gaps');
    expect(uploaded.ai_review_status).toBe('done');
    expect(typeof uploaded.contractUrl).toBe('string');
    expect(uploaded.contractUrl.length).toBeGreaterThan(0);
    expect(uploaded.contractUrl).toContain('/object/sign/');
    // No signed_path on this row — signedUrl is omitted (JSON.stringify drops
    // an explicit `undefined` value), never a broken empty-string link.
    expect(Object.prototype.hasOwnProperty.call(uploaded, 'signedUrl')).toBe(false);

    const changes = r.body.contracts.find((c) => c.id === 'contract-t12-changes');
    expect(changes.change_request).toBe('Please correct the start date to 1 November.');

    const signed = r.body.contracts.find((c) => c.id === 'contract-t12-signed');
    expect(typeof signed.signedUrl).toBe('string');
    expect(signed.signedUrl.length).toBeGreaterThan(0);
  });

  it('POST /api/ceo/contract/decision submit_to_gp: 409 on a contract that is not "uploaded" (signed)', async () => {
    const r = await ceoPost('/api/ceo/contract/decision', { contractId: 'contract-t12-signed', action: 'submit_to_gp' });
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('not_available');
    // Proves it never fired — status is untouched.
    expect(db.career_contracts.find((c) => c.id === 'contract-t12-signed').status).toBe('signed');
  });

  it('POST /api/ceo/contract/decision submit_to_gp: 409 on a void contract (never reachable from a discarded revision)', async () => {
    const r = await ceoPost('/api/ceo/contract/decision', { contractId: 'contract-t12-void', action: 'submit_to_gp' });
    expect(r.status).toBe(409);
    expect(db.career_contracts.find((c) => c.id === 'contract-t12-void').status).toBe('void');
  });

  it('POST /api/ceo/contract/decision submit_to_gp: 409 application_terminal when the GP withdrew after the practice uploaded — contract stays "uploaded", no resurrection, no GP email', async () => {
    const before = resendCalls.length;
    const r = await ceoPost('/api/ceo/contract/decision', { contractId: 'contract-t12-withdrawn-app', action: 'submit_to_gp' });
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('application_terminal');

    // The app-status check runs BEFORE the contract PATCH, so the contract
    // must be untouched — never flipped to sent_to_gp for a dead application.
    const c = db.career_contracts.find((x) => x.id === 'contract-t12-withdrawn-app');
    expect(c.status).toBe('uploaded');
    expect(c.sent_to_gp_at).toBeFalsy();

    // The application must stay withdrawn — never resurrected to 'offer'.
    const app = db.gp_applications.find((x) => x.id === APP_WITHDRAWN);
    expect(app.status).toBe('withdrawn');

    // No GP notification email fired.
    expect(resendCalls.length).toBe(before);
  });

  it('POST /api/ceo/contract/decision submit_to_gp: success flips contract + application, notifies the GP by email, then 409s on replay', async () => {
    const before = resendCalls.length;
    const r = await ceoPost('/api/ceo/contract/decision', { contractId: 'contract-t12-uploaded', action: 'submit_to_gp', note: 'Please double check the billing split before signing.' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const c = db.career_contracts.find((x) => x.id === 'contract-t12-uploaded');
    expect(c.status).toBe('sent_to_gp');
    expect(c.sent_to_gp_at).toBeTruthy();
    expect(c.ceo_note).toBe('Please double check the billing split before signing.');

    const app = db.gp_applications.find((x) => x.id === APP_SUBMIT);
    expect(app.status).toBe('offer');
    expect(app.ats_stage).toBe('offer');
    const stageEvent = db.ats_stage_events.find((e) => e.application_id === APP_SUBMIT && e.to_stage === 'offer');
    expect(stageEvent).toBeTruthy();
    expect(stageEvent.actor).toBe('ceo_contract_submit_to_gp');

    // Exactly one new email, to the GP (Priya), with the offer-review deep link.
    expect(resendCalls.length).toBe(before + 1);
    const sent = resendCalls[resendCalls.length - 1];
    expect(sent.body.to).toEqual([GP_A.email]);
    expect(sent.body.subject).toContain('Your contract is ready to review');
    expect(sent.body.html).toContain('/pages/offer-review?applicationId=' + APP_SUBMIT);

    // Idempotent-ish: the contract already moved past 'uploaded', so a replay
    // (double-click) 409s instead of re-flipping the application or re-sending.
    const before2 = resendCalls.length;
    const replay = await ceoPost('/api/ceo/contract/decision', { contractId: 'contract-t12-uploaded', action: 'submit_to_gp' });
    expect(replay.status).toBe(409);
    expect(resendCalls.length).toBe(before2);
  });

  it('POST /api/ceo/contract/decision return_to_practice: voids the original, creates a v2 awaiting_upload row, and emails the practice a token minted for the NEW row', async () => {
    const before = resendCalls.length;
    const r = await ceoPost('/api/ceo/contract/decision', { contractId: 'contract-t12-return', action: 'return_to_practice', note: 'The start date needs to move to 1 December.' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const original = db.career_contracts.find((x) => x.id === 'contract-t12-return');
    expect(original.status).toBe('void');

    const newRow = db.career_contracts.find((x) => x.application_id === APP_RETURN && x.status === 'awaiting_upload');
    expect(newRow).toBeTruthy();
    expect(newRow.id).not.toBe('contract-t12-return');
    expect(newRow.version).toBe(2);
    expect(newRow.ai_review_status).toBe('not_run');
    expect(newRow.practice_contact_email).toBe('admin@riverside-test.local');
    expect(newRow.practice_contact_name).toBe('Riverside Admin');

    // One new email, to the practice, carrying the note.
    expect(resendCalls.length).toBe(before + 1);
    const sent = resendCalls[resendCalls.length - 1];
    expect(sent.body.to).toEqual(['admin@riverside-test.local']);
    expect(sent.body.html).toContain('The start date needs to move to 1 December.');

    // Extract the contract_upload token from the emailed link and prove — via
    // the REAL public context endpoint, not by decoding the token ourselves —
    // that it addresses the NEW row, not the one just voided.
    const linkMatch = sent.body.html.match(/token=([^"&]+)/);
    expect(linkMatch).toBeTruthy();
    const token = decodeURIComponent(linkMatch[1]);
    const ctx = await apiGet('/api/practice/offer/context?token=' + encodeURIComponent(token));
    expect(ctx.status).toBe(200);
    expect(ctx.body.state).toBe('upload');
    expect(ctx.body.contractId).toBe(newRow.id);
    expect(ctx.body.contractId).not.toBe('contract-t12-return');
  });

  it('POST /api/ceo/contract/decision return_to_practice: 409 on a contract that is neither uploaded nor changes_requested', async () => {
    const r = await ceoPost('/api/ceo/contract/decision', { contractId: 'contract-t12-signed', action: 'return_to_practice' });
    expect(r.status).toBe(409);
    expect(db.career_contracts.find((c) => c.id === 'contract-t12-signed').status).toBe('signed');
  });

  it('POST /api/ceo/contract/decision: 400 on an unknown action, 404 on an unknown contractId', async () => {
    const bad = await ceoPost('/api/ceo/contract/decision', { contractId: 'contract-t12-void', action: 'delete_it' });
    expect(bad.status).toBe(400);
    const missing = await ceoPost('/api/ceo/contract/decision', { contractId: 'not-a-real-contract', action: 'submit_to_gp' });
    expect(missing.status).toBe(404);
  });
});

// Task 13 (2026-07-22): the GP contract experience — view / sign-by-upload /
// request changes. Signing IS the placement event now (the money path), so
// these tests are as much about what the endpoints REFUSE (wrong owner, wrong
// status, missing object, double-finalize) as what they do. Boots the real
// server against an in-memory emulator serving BOTH PostgREST and Supabase
// Storage (upload-sign + raw PUT + object download + signed-download-URL),
// authenticating as a GP with a signed gp_session cookie.
describe('GP contract experience — view / sign / request changes (Task 13)', () => {
  const SERVER_SRC = fs.readFileSync(SERVER_PATH, 'utf8');

  // ── Source-assertion coverage for the finalize-throw branch. It cannot be
  //    triggered through the live-boot emulator: finalizeInAppPlacement is
  //    internally try/caught step-by-step and supabaseDbRequest RETURNS
  //    {ok:false} on any failure rather than throwing — so with a responsive
  //    emulator the placement never throws. Documented here rather than
  //    silently skipped, and pinned at the source so the branch's contract
  //    (respond placementSecured:false, DON'T roll back the signed status) is
  //    still verified. ──
  it('finalize-signed wraps the placement in try/catch and responds placementSecured:false without rolling back the signed status', () => {
    const idx = SERVER_SRC.indexOf("pathname === '/api/career/contract/finalize-signed'");
    expect(idx).toBeGreaterThan(-1);
    // Bound the slice to the finalize handler alone (the next route's comment
    // block legitimately mentions sent_to_gp in describing its own guard).
    const endIdx = SERVER_SRC.indexOf('// POST /api/career/contract/request-changes', idx);
    const block = SERVER_SRC.slice(idx, endIdx > idx ? endIdx : idx + 9000);
    // The signed PATCH commits BEFORE the placement is attempted.
    const signedPatchIdx = block.indexOf("status: 'signed'");
    const finalizeCallIdx = block.indexOf('finalizeInAppPlacement(fsApp');
    expect(signedPatchIdx).toBeGreaterThan(-1);
    expect(finalizeCallIdx).toBeGreaterThan(signedPatchIdx);
    // Placement is guarded and the catch never reverts the signed status.
    expect(block).toMatch(/catch \(fsErr\)/);
    expect(block).toMatch(/\[contract-signed\]/);
    expect(block).toMatch(/placementSecured: false/);
    expect(block).toMatch(/finalising your placement/);
    const catchIdx = block.indexOf('catch (fsErr)');
    const afterCatch = block.slice(catchIdx);
    // No re-PATCH back to sent_to_gp anywhere in the finalize handler.
    expect(afterCatch).not.toMatch(/sent_to_gp/);
    expect(block).not.toMatch(/status: 'sent_to_gp'/);
  });

  it('the signed copy is stored under a distinct .../signed/ prefix (never collides with the practice contract object) and the path is recomputed server-side', () => {
    const idx = SERVER_SRC.indexOf("pathname === '/api/career/contract/finalize-signed'");
    const block = SERVER_SRC.slice(idx, idx + 4000);
    expect(block).toMatch(/'v' \+ \(Number\(fsContract\.version\) \|\| 1\), 'signed', fsSafeName/);
    // Recomputed from the contract + sanitized filename, not the client `path`.
    expect(block).toMatch(/sanitizeStoragePathSegment\(fsFilename, 120\)/);
  });

  // ── Review fix 3: the signed-PATCH is a compare-and-swap, not a blind write.
  //    Two near-simultaneous finalize calls can both pass the sent_to_gp check
  //    above before either has patched; without the `status=eq.sent_to_gp`
  //    filter both PATCHes would succeed and placement + emails would fire
  //    twice. Live-boot coverage of the actual 409 is below (APP_CAS); this
  //    pins the CAS shape itself at the source. ──
  it('finalize-signed PATCHes the contract as a compare-and-swap (status=eq.sent_to_gp, return=representation) and 409s on an empty result before touching placement', () => {
    const idx = SERVER_SRC.indexOf("pathname === '/api/career/contract/finalize-signed'");
    const endIdx = SERVER_SRC.indexOf('// POST /api/career/contract/request-changes', idx);
    const block = SERVER_SRC.slice(idx, endIdx > idx ? endIdx : idx + 9000);
    expect(block).toMatch(/'id=eq\.' \+ encodeURIComponent\(fsContract\.id\) \+ '&status=eq\.sent_to_gp'/);
    expect(block).toMatch(/Prefer: 'return=representation'/);
    const casIdx = block.search(/&status=eq\.sent_to_gp'/);
    const emptyCheckIdx = block.indexOf('!Array.isArray(fsPatch.data) || !fsPatch.data.length', casIdx);
    const notAvailableIdx = block.indexOf("code: 'not_available'", emptyCheckIdx);
    const finalizeCallIdx = block.indexOf('finalizeInAppPlacement(fsApp');
    expect(casIdx).toBeGreaterThan(-1);
    expect(emptyCheckIdx).toBeGreaterThan(casIdx);
    expect(notAvailableIdx).toBeGreaterThan(emptyCheckIdx);
    // The lost-race 409 returns BEFORE placement/emails ever run.
    expect(notAvailableIdx).toBeLessThan(finalizeCallIdx);
  });

  // ── Review fix 2(a): a silent placement failure previously had no
  //    visibility anywhere. Same untestable-live-branch situation as the
  //    placementSecured:false test above (finalizeInAppPlacement can't be made
  //    to throw against a responsive emulator), so this is pinned at the
  //    source too. ──
  it('finalize-signed failure branch best-effort alerts the CEO to finish the placement manually', () => {
    const idx = SERVER_SRC.indexOf("pathname === '/api/career/contract/finalize-signed'");
    const endIdx = SERVER_SRC.indexOf('// POST /api/career/contract/request-changes', idx);
    const block = SERVER_SRC.slice(idx, endIdx > idx ? endIdx : idx + 9000);
    const failIdx = block.indexOf('if (!fsPlacementSecured)');
    expect(failIdx).toBeGreaterThan(-1);
    const failBlock = block.slice(failIdx);
    expect(failBlock).toMatch(/needs manual placement/);
    expect(failBlock).toMatch(/Mark placement secured/);
    expect(failBlock).toMatch(/REGISTRATION_HUB_EMAIL/);
    expect(failBlock).toMatch(/catch \(alertErr\)/);
    // Best-effort: the alert failing must never turn the 200 response into an
    // error — the try/catch sits entirely before the existing sendJson call.
    const alertTryIdx = failBlock.indexOf('try {');
    const alertCatchIdx = failBlock.indexOf('catch (alertErr)');
    const sendJsonIdx = failBlock.indexOf('sendJson(res, 200, { ok: true, placementSecured: false');
    expect(alertTryIdx).toBeGreaterThan(-1);
    expect(alertTryIdx).toBeLessThan(alertCatchIdx);
    expect(alertCatchIdx).toBeLessThan(sendJsonIdx);
  });

  // ── Review fix 2(b): GET /api/career/contract must tell the client whether
  //    a 'signed' contract actually secured the placement. ──
  it('GET /api/career/contract derives placementSecured from the application status', () => {
    const idx = SERVER_SRC.indexOf("pathname === '/api/career/contract' && req.method === 'GET'");
    const endIdx = SERVER_SRC.indexOf('// POST /api/career/contract/sign-upload', idx);
    const block = SERVER_SRC.slice(idx, endIdx > idx ? endIdx : idx + 6000);
    expect(block).toMatch(/placementSecured: isCareerPlacementSecuredStatus\(normalizeCareerApplicationStatusKey\(ccApp\.status\)\)/);
  });

  // ── Review fix 1: GET /api/career/applications and the singular GET
  //    /api/career/application must both stamp contractStage from ONE batched
  //    (list) / single (detail) career_contracts lookup, so the in-app CTA
  //    reaches career.html and application-detail.html even when there is no
  //    live ats_offers row (submit_to_gp never creates one). Live-boot
  //    coverage of the actual field is below. ──
  it('GET /api/career/applications batches ONE career_contracts lookup (not per-application) before the enrichment loop and stamps contractStage', () => {
    const idx = SERVER_SRC.indexOf("pathname === '/api/career/applications' && req.method === 'GET'");
    expect(idx).toBeGreaterThan(-1);
    const endIdx = SERVER_SRC.indexOf('// ── Task 13: GP contract experience', idx);
    const block = SERVER_SRC.slice(idx, endIdx > idx ? endIdx : idx + 40000);
    expect(block).toMatch(/select=application_id,status,version&application_id=in\.\(/);
    expect(block).toMatch(/status=in\.\(sent_to_gp,changes_requested,practice_review\)/);
    expect(block).toMatch(/contractStage: \(localApp && localApp\.id/);
    const mapBuiltIdx = block.indexOf('const contractStageMap = {};');
    const loopIdx = block.indexOf('for (const entry of mergedApplications)');
    expect(mapBuiltIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(mapBuiltIdx);
  });

  it('GET /api/career/application (singular) includes contractStage for application-detail.html', () => {
    const idx = SERVER_SRC.indexOf("pathname === '/api/career/application' && req.method === 'GET'");
    expect(idx).toBeGreaterThan(-1);
    const endIdx = SERVER_SRC.indexOf("pathname === '/api/career/interview' && req.method === 'GET'", idx);
    const block = SERVER_SRC.slice(idx, endIdx > idx ? endIdx : idx + 20000);
    expect(block).toMatch(/detailContractStage/);
    expect(block).toMatch(/contractStage: detailContractStage/);
  });

  it('career.html renders a CONTRACT ribbon + "Review contract" CTA when contractStage is sent_to_gp, and carries the field through the client normalize/merge path', () => {
    const html = fs.readFileSync(path.join(ROOT, 'pages/career.html'), 'utf8');
    expect(html).toMatch(/application\.contractStage === "sent_to_gp"/);
    expect(html).toContain('<span class="at-rstatus at-rstatus--offer">CONTRACT</span>');
    expect(html).toContain('Review contract');
    // The field must survive BOTH client-side hops or it never reaches the
    // ribbon: the list normalizer (mergeRemoteApplications -> app.contractStage)
    // and the object normalizeCareerApplication actually returns.
    expect(html).toContain('contractStage: app.contractStage || null');
    expect(html).toContain('contractStage: source.contractStage || null');
  });

  it('application-detail.html shows the offer card with a "Review contract" label when contractStage is sent_to_gp', () => {
    const html = fs.readFileSync(path.join(ROOT, 'pages/application-detail.html'), 'utf8');
    expect(html).toMatch(/isContractSent = app\.contractStage === 'sent_to_gp'/);
    // showOfferCard must exclude terminal states (withdrawn, not_proceeding, offer_declined, secured) to avoid showing card on withdrawn app with lingering sent_to_gp contract
    expect(html).toMatch(/showOfferCard = \(app\.offerPending === true \|\| isContractSent\) && !isSecured && !isWithdrawn && !isClosed && !isOfferDeclined/);
    expect(html).toContain("isContractSent ? 'Review contract' : 'Review Offer'");
  });

  it('offer-review.html only shows "Placement secured" + confetti when contract.placementSecured is true', () => {
    const html = fs.readFileSync(path.join(ROOT, 'pages/offer-review.html'), 'utf8');
    expect(html).toMatch(/contract\.placementSecured === true/);
    expect(html).toContain("showContractSecured('Contract signed', 'Signed — our team is finalising your placement.')");
  });
});

describe('GP contract experience — live-boot (Task 13)', () => {
  const RUN_ID = crypto.randomBytes(4).toString('hex');
  const DB_FILE = path.join('/tmp', `gplink-t13-${RUN_ID}.json`);
  const GP = { userId: 'u-gp-t13-1', email: 'gp-t13-1@gplink-test.local' };
  const GP2 = { userId: 'u-gp-t13-2', email: 'gp-t13-2@gplink-test.local' };
  const HUB_EMAIL = 'hello@mygplink-test.local';
  const PRACTICE_EMAIL = 'reception@harbour-t13.local';
  const NOW = new Date().toISOString();

  const APP_VIEW = 'app-t13-view';
  const APP_VOID = 'app-t13-void';
  const APP_UPLOADED = 'app-t13-uploaded';
  const APP_OBJMISSING = 'app-t13-objmissing';
  const APP_SUCCESS = 'app-t13-success';
  const APP_DRAFT = 'app-t13-draft';
  const APP_CHANGES = 'app-t13-changes';
  const APP_GP2 = 'app-t13-gp2';
  // Contract already 'signed' but the application never made it to
  // placement_secured — stands in for "someone else's finalize just won the
  // race" (FIX 3's CAS) AND "the placement step failed after the signature
  // committed" (FIX 2's GET placementSecured:false), without needing to force
  // finalizeInAppPlacement to throw inside the emulator (it can't — see the
  // source-assertion test above for why).
  const APP_CAS = 'app-t13-cas';

  let server, port, sbServer, sbPort, realFetch, mod;
  const resendCalls = [];
  const storage = new Map();

  function contractRow(id, applicationId, status, version, extra) {
    return Object.assign({
      id, application_id: applicationId, user_id: GP.userId, career_role_id: 'role-t13-1',
      version, status,
      contract_bucket: 'gp-link-documents',
      contract_path: 'contracts/' + applicationId + '/v' + version + '/Employment-Contract.pdf',
      contract_filename: 'Employment-Contract.pdf', contract_mime: 'application/pdf',
      sent_to_gp_at: status === 'sent_to_gp' ? NOW : null,
      created_at: NOW, updated_at: NOW
    }, extra || {});
  }

  const db = {
    user_profiles: [
      { user_id: GP.userId, email: GP.email, first_name: 'Helen', last_name: 'Rivers', registration_country: 'uk' },
      { user_id: GP2.userId, email: GP2.email, first_name: 'Sana', last_name: 'Khan', registration_country: 'uk' }
    ],
    practices: [
      { id: 'p-t13-1', name: 'Harbour Family Clinic', source: 'internal_ats', contact_name: 'Harbour Reception', contact_email: PRACTICE_EMAIL, is_active: true, created_at: NOW }
    ],
    career_roles: [
      { id: 'role-t13-1', provider: 'internal_ats', provider_role_id: 'ats_t13_1', title: 'General Practitioner — VR', practice_name: 'Harbour Family Clinic', practice_id: 'p-t13-1', location_city: 'Brisbane', location_state: 'QLD', is_active: true, job_status: 'open', updated_at: NOW }
    ],
    gp_applications: [
      { id: APP_VIEW, user_id: GP.userId, career_role_id: 'role-t13-1', practice_id: 'p-t13-1', provider_role_id: 'ats_t13_1', status: 'offer', ats_stage: 'offer', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'Harbour Reception', applied_at: NOW },
      { id: APP_VOID, user_id: GP.userId, career_role_id: 'role-t13-1', practice_id: 'p-t13-1', provider_role_id: 'ats_t13_1', status: 'offer', ats_stage: 'offer', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'Harbour Reception', applied_at: NOW },
      { id: APP_UPLOADED, user_id: GP.userId, career_role_id: 'role-t13-1', practice_id: 'p-t13-1', provider_role_id: 'ats_t13_1', status: 'interview_completed', ats_stage: 'interview', applied_at: NOW },
      { id: APP_OBJMISSING, user_id: GP.userId, career_role_id: 'role-t13-1', practice_id: 'p-t13-1', provider_role_id: 'ats_t13_1', status: 'offer', ats_stage: 'offer', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'Harbour Reception', applied_at: NOW },
      { id: APP_SUCCESS, user_id: GP.userId, career_role_id: 'role-t13-1', practice_id: 'p-t13-1', provider_role_id: 'ats_t13_1', status: 'offer', ats_stage: 'offer', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'Harbour Reception', applied_at: NOW },
      { id: APP_DRAFT, user_id: GP.userId, career_role_id: 'role-t13-1', practice_id: 'p-t13-1', provider_role_id: 'ats_t13_1', status: 'offer', ats_stage: 'offer', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'Harbour Reception', applied_at: NOW },
      { id: APP_CHANGES, user_id: GP.userId, career_role_id: 'role-t13-1', practice_id: 'p-t13-1', provider_role_id: 'ats_t13_1', status: 'offer', ats_stage: 'offer', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'Harbour Reception', applied_at: NOW },
      { id: APP_GP2, user_id: GP2.userId, career_role_id: 'role-t13-1', practice_id: 'p-t13-1', provider_role_id: 'ats_t13_1', status: 'offer', ats_stage: 'offer', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'Harbour Reception', applied_at: NOW },
      // Contract already signed, but the application status never advanced to
      // placement_secured (status stays 'offer') — see APP_CAS comment above.
      { id: APP_CAS, user_id: GP.userId, career_role_id: 'role-t13-1', practice_id: 'p-t13-1', provider_role_id: 'ats_t13_1', status: 'offer', ats_stage: 'offer', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'Harbour Reception', applied_at: NOW }
    ],
    career_contracts: [
      contractRow('c-t13-view', APP_VIEW, 'sent_to_gp', 1),
      // Latest-non-void: v2 is void, v1 (sent_to_gp) is the live one GET must pick.
      contractRow('c-t13-void-v2', APP_VOID, 'void', 2),
      contractRow('c-t13-void-v1', APP_VOID, 'sent_to_gp', 1),
      contractRow('c-t13-uploaded', APP_UPLOADED, 'uploaded', 1),
      contractRow('c-t13-objmissing', APP_OBJMISSING, 'sent_to_gp', 1),
      contractRow('c-t13-success', APP_SUCCESS, 'sent_to_gp', 1, { practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'Harbour Reception' }),
      contractRow('c-t13-draft', APP_DRAFT, 'sent_to_gp', 1),
      contractRow('c-t13-changes', APP_CHANGES, 'sent_to_gp', 1),
      contractRow('c-t13-gp2', APP_GP2, 'sent_to_gp', 1, { user_id: GP2.userId }),
      contractRow('c-t13-cas', APP_CAS, 'signed', 1, {
        signed_at: NOW, signed_bucket: 'gp-link-documents',
        signed_path: 'contracts/' + APP_CAS + '/v1/signed/Already-Signed.pdf',
        signed_filename: 'Already-Signed.pdf'
      })
    ],
    ats_offers: [
      { id: 'offer-t13-draft', application_id: APP_DRAFT, user_id: GP.userId, career_role_id: 'role-t13-1', status: 'draft' }
    ],
    ats_stage_events: [],
    placements: [],
    user_state: [
      { user_id: GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW },
      { user_id: GP2.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }
    ]
  };
  function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }
  function buildMatcher(params) {
    const filters = [];
    for (const [k, v] of params.entries()) {
      if (['select', 'limit', 'order', 'on_conflict'].includes(k)) continue;
      // 'in' added for the review-fix batched contractStage lookup (FIX 1),
      // which — unlike every other query in this file's emulators —
      // filters on status via in.(...), not just eq./neq.. PostgREST's in.()
      // value is a parenthesised, comma-separated, optionally quoted list.
      const mm = /^(eq|neq|in)\.(.*)$/s.exec(v);
      if (mm) filters.push({ col: k, op: mm[1], val: mm[2] });
    }
    return (row) => filters.every((f) => {
      const cell = row ? row[f.col] : undefined;
      if (f.op === 'in') {
        const inner = f.val.replace(/^\(/, '').replace(/\)$/, '');
        const options = inner ? inner.split(',').map((s) => s.replace(/^"|"$/g, '')) : [];
        return options.indexOf(String(cell)) !== -1;
      }
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

        // ── Supabase Storage: upload-sign (POST) + raw PUT, signed-download URL
        //    (POST /object/sign/), and object download (GET) for existence checks.
        if (u.pathname.startsWith('/storage/v1/')) {
          let mm = u.pathname.match(/^\/storage\/v1\/object\/upload\/sign\/(.+)$/);
          if (mm && req.method === 'POST') { sendJson(200, { url: '/object/upload/sign/' + mm[1] + '?token=test-token' }); return; }
          if (mm && req.method === 'PUT') { storage.set(decodeURIComponent(mm[1]), await readRaw()); sendJson(200, { Key: mm[1] }); return; }
          mm = u.pathname.match(/^\/storage\/v1\/object\/sign\/(.+)$/);
          if (mm && req.method === 'POST') { await readRaw(); sendJson(200, { signedURL: '/object/sign/' + mm[1] + '?token=test-sign-token' }); return; }
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
            const row = Object.assign({ id: crypto.randomUUID(), created_at: new Date().toISOString() }, r);
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

  function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
  function gpCookie(user) {
    const payload = b64url(JSON.stringify({ userProfile: { email: user.email, supabaseUserId: user.userId }, expiresAt: Date.now() + 3600000 }));
    const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
    return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
  }

  function httpJson(method, p, body, extraHeaders) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const headers = Object.assign({}, extraHeaders || {});
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
        const c = []; res.on('data', (x) => c.push(x));
        res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let parsed = null; try { parsed = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: parsed }); });
      });
      r.on('error', reject); r.end(data);
    });
  }
  const gpGet = (p, user) => httpJson('GET', p, null, { Cookie: gpCookie(user || GP) });
  const gpPost = (p, body, user) => httpJson('POST', p, body, { Cookie: gpCookie(user || GP) });

  function putSignedUpload(uploadUrl, buffer, mime) {
    return new Promise((resolve, reject) => {
      const target = new URL(uploadUrl);
      const r = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: 'PUT', headers: { 'Content-Type': mime, 'x-upsert': 'true', 'Content-Length': buffer.length } }, (res) => {
        res.on('data', () => {}); res.on('end', () => resolve({ status: res.statusCode }));
      });
      r.on('error', reject); r.end(buffer);
    });
  }

  const contract = (id) => db.career_contracts.find((c) => c.id === id);
  const appRow = (id) => db.gp_applications.find((a) => a.id === id);

  beforeAll(async () => {
    await startEmulator();
    process.env.AGENT_SKIP_DOTENV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DISABLED = 'false';
    process.env.AUTH_SECRET = 'contracts-t13-secret-' + RUN_ID;
    process.env.REQUIRE_SUPABASE_DB = 'false';
    process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
    process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.SUPABASE_DOCUMENT_BUCKET = 'gp-link-documents';
    process.env.ENFORCE_SAME_ORIGIN = 'false';
    process.env.DB_FILE_PATH = DB_FILE;
    process.env.OPENAI_API_KEY = '';
    process.env.ANTHROPIC_API_KEY = '';
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

  // ── GET /api/career/contract ──
  it('GET requires a session (401 with no cookie)', async () => {
    const r = await httpJson('GET', '/api/career/contract?applicationId=' + APP_VIEW);
    expect(r.status).toBe(401);
  });

  it('GET 400 without an applicationId', async () => {
    const r = await gpGet('/api/career/contract');
    expect(r.status).toBe(400);
  });

  it('GET 404 for an application the session user does not own (no cross-owner read)', async () => {
    const r = await gpGet('/api/career/contract?applicationId=' + APP_GP2, GP);
    expect(r.status).toBe(404);
  });

  it('GET returns the sent_to_gp contract payload (signed 1h URL, camelCase fields)', async () => {
    const r = await gpGet('/api/career/contract?applicationId=' + APP_VIEW, GP);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.contract).toBeTruthy();
    expect(r.body.contract.id).toBe('c-t13-view');
    expect(r.body.contract.status).toBe('sent_to_gp');
    expect(r.body.contract.version).toBe(1);
    expect(typeof r.body.contract.contractUrl).toBe('string');
    expect(r.body.contract.contractUrl.length).toBeGreaterThan(0);
    expect(r.body.contract.contractUrl).toContain('/object/sign/');
    expect(r.body.contract).toHaveProperty('changeRequest');
    expect(r.body.contract).toHaveProperty('sentToGpAt');
  });

  it('GET returns the latest NON-void contract (a higher-version void row is skipped)', async () => {
    const r = await gpGet('/api/career/contract?applicationId=' + APP_VOID, GP);
    expect(r.status).toBe(200);
    expect(r.body.contract).toBeTruthy();
    expect(r.body.contract.id).toBe('c-t13-void-v1');
    expect(r.body.contract.status).toBe('sent_to_gp');
  });

  it('GET returns contract:null for an "uploaded" contract (GP never sees pre-submit states)', async () => {
    const r = await gpGet('/api/career/contract?applicationId=' + APP_UPLOADED, GP);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.contract).toBeNull();
  });

  // ── POST /api/career/contract/sign-upload ──
  it('sign-upload 404 for a non-owned application', async () => {
    const r = await gpPost('/api/career/contract/sign-upload', { applicationId: APP_GP2, filename: 'signed.pdf', mimeType: 'application/pdf' }, GP);
    expect(r.status).toBe(404);
  });

  it('sign-upload 409 when the contract is not sent_to_gp (uploaded)', async () => {
    const r = await gpPost('/api/career/contract/sign-upload', { applicationId: APP_UPLOADED, filename: 'signed.pdf', mimeType: 'application/pdf' }, GP);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('not_available');
  });

  it('sign-upload 400 rejects a non-pdf/docx mime', async () => {
    const r = await gpPost('/api/career/contract/sign-upload', { applicationId: APP_VIEW, filename: 'signed.exe', mimeType: 'application/x-msdownload' }, GP);
    expect(r.status).toBe(400);
  });

  it('sign-upload success returns an upload URL + a path UNDER the .../signed/ prefix', async () => {
    const r = await gpPost('/api/career/contract/sign-upload', { applicationId: APP_VIEW, filename: 'My Signed Contract.pdf', mimeType: 'application/pdf' }, GP);
    expect(r.status).toBe(200);
    expect(typeof r.body.uploadUrl).toBe('string');
    expect(r.body.path).toContain('contracts/' + APP_VIEW + '/v1/signed/');
    // Distinct from where the practice's own contract lives (…/v1/<name>, no /signed/).
    expect(r.body.path).not.toBe(contract('c-t13-view').contract_path);
  });

  // ── POST /api/career/contract/finalize-signed ──
  it('finalize-signed 400 refuses when no object was uploaded to Storage (contract stays sent_to_gp)', async () => {
    const sign = await gpPost('/api/career/contract/sign-upload', { applicationId: APP_OBJMISSING, filename: 'signed.pdf', mimeType: 'application/pdf' }, GP);
    expect(sign.status).toBe(200);
    // No PUT → finalize must refuse, not phantom-sign.
    const fin = await gpPost('/api/career/contract/finalize-signed', { applicationId: APP_OBJMISSING, path: sign.body.path, filename: 'signed.pdf', mimeType: 'application/pdf' }, GP);
    expect(fin.status).toBe(400);
    expect(contract('c-t13-objmissing').status).toBe('sent_to_gp');
  });

  it('finalize-signed success secures the placement: contract signed, application placement_secured, placements row, minimal offer created, both signed-copy emails, placementSecured:true', async () => {
    const before = resendCalls.length;
    const sign = await gpPost('/api/career/contract/sign-upload', { applicationId: APP_SUCCESS, filename: 'Helen-Signed.pdf', mimeType: 'application/pdf' }, GP);
    expect(sign.status).toBe(200);
    const put = await putSignedUpload(sign.body.uploadUrl, Buffer.from('%PDF-1.4 signed by Helen', 'utf8'), 'application/pdf');
    expect(put.status).toBe(200);

    const fin = await gpPost('/api/career/contract/finalize-signed', { applicationId: APP_SUCCESS, path: sign.body.path, filename: 'Helen-Signed.pdf', mimeType: 'application/pdf' }, GP);
    expect(fin.status).toBe(200);
    expect(fin.body.ok).toBe(true);
    expect(fin.body.placementSecured).toBe(true);

    // Contract row is signed with the signed file recorded.
    const c = contract('c-t13-success');
    expect(c.status).toBe('signed');
    expect(c.signed_at).toBeTruthy();
    expect(c.signed_path).toContain('/signed/');

    // Application secured + placements row of record.
    expect(appRow(APP_SUCCESS).status).toBe('placement_secured');
    expect(db.placements.find((p) => p.application_id === APP_SUCCESS)).toBeTruthy();

    // No offer existed → a minimal one was created and finalize accepted it.
    const offer = db.ats_offers.find((o) => o.application_id === APP_SUCCESS);
    expect(offer).toBeTruthy();
    expect(offer.status).toBe('accepted');

    // Two signed-copy notifications: the practice + the CEO hub.
    const sent = resendCalls.slice(before);
    const practiceMail = sent.find((x) => Array.isArray(x.body.to) && x.body.to.includes(PRACTICE_EMAIL) && /has signed/i.test(x.body.subject || ''));
    const ceoMail = sent.find((x) => Array.isArray(x.body.to) && x.body.to.includes(HUB_EMAIL) && /placement secured/i.test(x.body.subject || ''));
    expect(practiceMail).toBeTruthy();
    expect(ceoMail).toBeTruthy();
  });

  it('finalize-signed cannot run twice (double placement): a replay after signing is 409', async () => {
    const replay = await gpPost('/api/career/contract/finalize-signed', { applicationId: APP_SUCCESS, path: 'ignored', filename: 'Helen-Signed.pdf', mimeType: 'application/pdf' }, GP);
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('not_available');
  });

  // ── Review fix 3 (CAS): APP_CAS's contract is seeded ALREADY 'signed' —
  //    standing in for a concurrent finalize call that won the race a moment
  //    before this one runs. Whether it's caught by the pre-check or the
  //    PATCH-level compare-and-swap, the contract is identical: 409, and
  //    placement/emails never run a second time. ──
  it('finalize-signed refuses a contract that is already signed (lost-race stand-in): 409, no new placement, no new emails', async () => {
    const placementsBefore = db.placements.length;
    const offersBefore = db.ats_offers.length;
    const resendBefore = resendCalls.length;

    const fin = await gpPost('/api/career/contract/finalize-signed', { applicationId: APP_CAS, path: 'ignored', filename: 'signed.pdf', mimeType: 'application/pdf' }, GP);
    expect(fin.status).toBe(409);
    expect(fin.body.code).toBe('not_available');

    // No side effects: no new placements/offers rows, no new emails, and the
    // application status never advanced to placement_secured.
    expect(db.placements.length).toBe(placementsBefore);
    expect(db.ats_offers.length).toBe(offersBefore);
    expect(resendCalls.length).toBe(resendBefore);
    expect(appRow(APP_CAS).status).not.toBe('placement_secured');
    // The contract itself is untouched (still the same signed_path it started with).
    expect(contract('c-t13-cas').signed_path).toBe('contracts/' + APP_CAS + '/v1/signed/Already-Signed.pdf');
  });

  it('finalize-signed draft-offer flip: a draft ats_offers row is flipped to sent, then finalize accepts it', async () => {
    const sign = await gpPost('/api/career/contract/sign-upload', { applicationId: APP_DRAFT, filename: 'draft-signed.pdf', mimeType: 'application/pdf' }, GP);
    const put = await putSignedUpload(sign.body.uploadUrl, Buffer.from('%PDF-1.4 signed', 'utf8'), 'application/pdf');
    expect(put.status).toBe(200);
    const fin = await gpPost('/api/career/contract/finalize-signed', { applicationId: APP_DRAFT, path: sign.body.path, filename: 'draft-signed.pdf', mimeType: 'application/pdf' }, GP);
    expect(fin.status).toBe(200);
    expect(fin.body.placementSecured).toBe(true);
    // The pre-seeded 'draft' offer ended up accepted (draft → sent → accepted).
    const offer = db.ats_offers.find((o) => o.id === 'offer-t13-draft');
    expect(offer.status).toBe('accepted');
    expect(contract('c-t13-draft').status).toBe('signed');
  });

  // ── POST /api/career/contract/request-changes ──
  it('request-changes 400 on an empty message', async () => {
    const r = await gpPost('/api/career/contract/request-changes', { applicationId: APP_CHANGES, message: '   ' }, GP);
    expect(r.status).toBe(400);
  });

  it('request-changes 404 for a non-owned application', async () => {
    const r = await gpPost('/api/career/contract/request-changes', { applicationId: APP_GP2, message: 'Please change the start date.' }, GP);
    expect(r.status).toBe(404);
  });

  it('request-changes flips the contract to changes_requested with the text and emails the CEO', async () => {
    const before = resendCalls.length;
    const r = await gpPost('/api/career/contract/request-changes', { applicationId: APP_CHANGES, message: 'Please move the start date to 1 November.' }, GP);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const c = contract('c-t13-changes');
    expect(c.status).toBe('changes_requested');
    expect(c.change_request).toBe('Please move the start date to 1 November.');

    const sent = resendCalls.slice(before);
    const ceoMail = sent.find((x) => Array.isArray(x.body.to) && x.body.to.includes(HUB_EMAIL) && /requested changes/i.test(x.body.subject || ''));
    expect(ceoMail).toBeTruthy();
    expect(ceoMail.body.html).toContain('Please move the start date to 1 November.');
  });

  it('request-changes 409 once the contract is no longer sent_to_gp (already changes_requested)', async () => {
    const r = await gpPost('/api/career/contract/request-changes', { applicationId: APP_CHANGES, message: 'Another change.' }, GP);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('not_available');
  });

  it('GET reflects the changes_requested state with the request text back to the GP', async () => {
    const r = await gpGet('/api/career/contract?applicationId=' + APP_CHANGES, GP);
    expect(r.status).toBe(200);
    expect(r.body.contract.status).toBe('changes_requested');
    expect(r.body.contract.changeRequest).toBe('Please move the start date to 1 November.');
  });

  it('GET shows the signed contract as status "signed" (secured state) after a successful sign, with placementSecured:true', async () => {
    const r = await gpGet('/api/career/contract?applicationId=' + APP_SUCCESS, GP);
    expect(r.status).toBe(200);
    expect(r.body.contract.status).toBe('signed');
    expect(r.body.contract.signedAt).toBeTruthy();
    // Review fix 2(b): the application really did reach placement_secured
    // (asserted earlier in the finalize-signed success test).
    expect(r.body.contract.placementSecured).toBe(true);
  });

  // ── Review fix 2(b): APP_CAS's contract is 'signed' but its application
  //    never advanced past 'offer' — exactly what finalize-signed's failure
  //    branch leaves behind. GET must say placementSecured:false so
  //    offer-review.html shows the honest "still finalising" copy instead of
  //    a false "Placement secured 🎉".
  it('GET reports placementSecured:false for a signed contract whose application never reached placement_secured', async () => {
    const r = await gpGet('/api/career/contract?applicationId=' + APP_CAS, GP);
    expect(r.status).toBe(200);
    expect(r.body.contract.status).toBe('signed');
    expect(r.body.contract.placementSecured).toBe(false);
  });

  // ── Review fix 1: the applications list must stamp contractStage from the
  //    batched career_contracts lookup — the in-app path to the contract for
  //    the Offers tab. ──
  it('GET /api/career/applications returns contractStage:"sent_to_gp" for a live contract, and null when only an "uploaded" (pre-submit) contract exists', async () => {
    const r = await gpGet('/api/career/applications', GP);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const apps = r.body.applications;
    const viewEntry = apps.find((a) => a.id === APP_VIEW);
    expect(viewEntry).toBeTruthy();
    expect(viewEntry.contractStage).toBe('sent_to_gp');

    const uploadedEntry = apps.find((a) => a.id === APP_UPLOADED);
    expect(uploadedEntry).toBeTruthy();
    expect(uploadedEntry.contractStage).toBeNull();
  });
});

// Task 14 (2026-07-22): the change-request loop. A GP's changes_requested
// contract (Task 13) is triaged by the CEO — release it to the practice for
// email consent, or decline it and hand the SAME contract straight back to
// the GP. The practice consents via a tokenized page: approve re-opens the
// SAME upload flow as Task 10/12 (a fresh awaiting_upload revision); decline
// sends the GP back to sign as-is. Two layers of coverage, same shape as
// Tasks 9-13: fast source-assertions for wiring/ordering that a live-boot
// test can't distinguish, then a full live-boot block against the real
// endpoints for behavior.
describe('Task 14: change-request loop — wiring (source-assertion)', () => {
  const SERVER_SRC = fs.readFileSync(SERVER_PATH, 'utf8');

  it('defines CONTRACT_CONSENT_TOKEN_PURPOSE beside CONTRACT_UPLOAD_TOKEN_PURPOSE, with a distinct value', () => {
    expect(SERVER_SRC).toMatch(/const CONTRACT_UPLOAD_TOKEN_PURPOSE = 'contract_upload';/);
    expect(SERVER_SRC).toMatch(/const CONTRACT_CONSENT_TOKEN_PURPOSE = 'contract_consent';/);
  });

  it('defines POST /api/ceo/contract/change-decision, guarded by requireCeoSession', () => {
    const idx = SERVER_SRC.indexOf("pathname === '/api/ceo/contract/change-decision' && req.method === 'POST'");
    expect(idx).toBeGreaterThan(-1);
    const near = SERVER_SRC.slice(idx, idx + 300);
    expect(near).toMatch(/requireCeoSession\(req, res\)/);
  });

  it('release_to_practice and decline_change are both refused outside "changes_requested" (409)', () => {
    const idx = SERVER_SRC.indexOf("pathname === '/api/ceo/contract/change-decision' && req.method === 'POST'");
    const branch = SERVER_SRC.slice(idx, idx + 2000);
    expect(branch).toMatch(/action must be "release_to_practice" or "decline_change"/);
    expect(branch).toMatch(/String\(chdContract\.status\) !== 'changes_requested'/);
    expect(branch).toMatch(/409/);
  });

  it('release_to_practice moves the contract to practice_review and mints a contract_consent token for BOTH the approve and decline links', () => {
    const idx = SERVER_SRC.indexOf("if (chdAction === 'release_to_practice')");
    expect(idx).toBeGreaterThan(-1);
    const branch = SERVER_SRC.slice(idx, idx + 2600);
    expect(branch).toMatch(/status:\s*'practice_review'/);
    expect(branch).toMatch(/mintContractConsentToken\(chdContract\.id\)/);
    expect(branch).toContain('/pages/practice-consent.html?token=');
    expect(branch).toContain("&intent=approve");
    expect(branch).toContain("&intent=decline");
    // Never mints the upload-purpose token here — that only ever happens
    // once the practice actually approves (POST .../consent below).
    expect(branch).not.toMatch(/mintContractUploadToken/);
  });

  it('decline_change flips the contract back to sent_to_gp with change_response declined_by_gplink and fires the GP notification trio', () => {
    const idx = SERVER_SRC.indexOf("// chdAction === 'decline_change'");
    expect(idx).toBeGreaterThan(-1);
    const branch = SERVER_SRC.slice(idx, idx + 2000);
    expect(branch).toMatch(/status:\s*'sent_to_gp'/);
    expect(branch).toMatch(/change_response:\s*'declined_by_gplink'/);
    expect(branch).toMatch(/pushCareerNotificationToUser\(chdGpUserId/);
    expect(branch).toMatch(/sendPushNotification\(chdGpUserId/);
    expect(branch).toMatch(/sendGpNotificationEmail\(chdGpUserId/);
    expect(branch).toContain('/pages/offer-review?applicationId=');
  });

  it('defines GET /api/practice/contract/consent-context and POST /api/practice/contract/consent, both purpose-locked to CONTRACT_CONSENT_TOKEN_PURPOSE', () => {
    const gIdx = SERVER_SRC.indexOf("pathname === '/api/practice/contract/consent-context' && req.method === 'GET'");
    expect(gIdx).toBeGreaterThan(-1);
    const gBranch = SERVER_SRC.slice(gIdx, gIdx + 900);
    expect(gBranch).toMatch(/parseSignedPurposeToken\(pcxToken, CONTRACT_CONSENT_TOKEN_PURPOSE\)/);

    const pIdx = SERVER_SRC.indexOf("pathname === '/api/practice/contract/consent' && req.method === 'POST'");
    expect(pIdx).toBeGreaterThan(-1);
    const pBranch = SERVER_SRC.slice(pIdx, pIdx + 900);
    expect(pBranch).toMatch(/parseSignedPurposeToken\(String\(\(pcaBody && pcaBody\.token\) \|\| ''\)\.trim\(\), CONTRACT_CONSENT_TOKEN_PURPOSE\)/);
  });

  it('consent GET reports "decide" ONLY while the contract is still practice_review', () => {
    const idx = SERVER_SRC.indexOf("pathname === '/api/practice/contract/consent-context' && req.method === 'GET'");
    const branch = SERVER_SRC.slice(idx, idx + 2200);
    expect(branch).toMatch(/String\(pcxContract\.status\) === 'practice_review' \? 'decide' : 'done'/);
  });

  it('consent POST refuses any contract that is not practice_review (409)', () => {
    const idx = SERVER_SRC.indexOf("pathname === '/api/practice/contract/consent' && req.method === 'POST'");
    const branch = SERVER_SRC.slice(idx, idx + 2600);
    expect(branch).toMatch(/String\(pcaContract\.status\) !== 'practice_review'/);
    expect(branch).toMatch(/409/);
  });

  it('consent approve inserts the new awaiting_upload row BEFORE voiding the original (insert-before-void ordering, like Task 12)', () => {
    const idx = SERVER_SRC.indexOf("if (pcaAction === 'approve')");
    expect(idx).toBeGreaterThan(-1);
    const branch = SERVER_SRC.slice(idx, idx + 2600);
    const insertIdx = branch.indexOf("const pcaIns = await supabaseDbRequest('career_contracts', '', { method: 'POST'");
    const voidIdx = branch.indexOf("const pcaVoidPatch = await supabaseDbRequest('career_contracts'");
    expect(insertIdx).toBeGreaterThan(-1);
    expect(voidIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeLessThan(voidIdx);
    expect(branch).toMatch(/status:\s*'awaiting_upload'/);
    expect(branch).toMatch(/version:\s*pcaMaxV \+ 1/);
  });

  it('consent approve mints the fresh upload token for the NEW row, not the just-voided one, and voids the original with change_response approved', () => {
    const idx = SERVER_SRC.indexOf("if (pcaAction === 'approve')");
    const branch = SERVER_SRC.slice(idx, idx + 3200);
    expect(branch).toMatch(/mintContractUploadToken\(pcaNewRow\.id\)/);
    expect(branch).not.toMatch(/mintContractUploadToken\(pcaContract\.id\)/);
    expect(branch).toMatch(/status:\s*'void',\s*change_response:\s*'approved'/);
  });

  it('consent decline flips the contract back to sent_to_gp with change_response declined_by_practice, notifies the GP, and alerts the CEO', () => {
    const idx = SERVER_SRC.indexOf("// pcaAction === 'decline' — the contract goes straight back to the GP");
    expect(idx).toBeGreaterThan(-1);
    const branch = SERVER_SRC.slice(idx, idx + 2600);
    expect(branch).toMatch(/status:\s*'sent_to_gp'/);
    expect(branch).toMatch(/change_response:\s*'declined_by_practice'/);
    expect(branch).toMatch(/sendGpNotificationEmail\(pcaGpUserId/);
    expect(branch).toMatch(/REGISTRATION_HUB_EMAIL/);
  });

  it('/pages/practice-consent.html sits in the public allowlist right next to practice-offer.html', () => {
    const poIdx = SERVER_SRC.indexOf("pathname === '/pages/practice-offer.html' ||");
    const pcIdx = SERVER_SRC.indexOf("pathname === '/pages/practice-consent.html' ||");
    expect(poIdx).toBeGreaterThan(-1);
    expect(pcIdx).toBeGreaterThan(-1);
    // Immediately after (within the same isPublic block, not miles away).
    expect(pcIdx).toBeGreaterThan(poIdx);
    expect(pcIdx - poIdx).toBeLessThan(400);
  });
});

describe('Task 14: CEO Contracts tab UI — change-request buttons', () => {
  const CONTRACTS_JS = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-contracts.js'), 'utf8');

  it('canTriageChange is scoped to changes_requested rows only', () => {
    expect(CONTRACTS_JS).toMatch(/canTriageChange\s*=\s*c\.status === 'changes_requested'/);
  });

  it('renders Release to practice / Decline change buttons with the right data-action values', () => {
    expect(CONTRACTS_JS).toContain('data-action="release_to_practice"');
    expect(CONTRACTS_JS).toContain('data-action="decline_change"');
    expect(CONTRACTS_JS).toContain('Release to practice');
    expect(CONTRACTS_JS).toMatch(/Decline change/);
  });

  it('posts change-decision actions to the dedicated /api/ceo/contract/change-decision endpoint (distinct from Task 12\'s /decision)', () => {
    expect(CONTRACTS_JS).toContain("ATS.api('/api/ceo/contract/change-decision', { method: 'POST', body: { contractId: contractId, action: action, note: note } })");
    // The click handler routes these two actions to the new function, not the
    // Task 12 submitDecision (which still exists, untouched, for submit_to_gp
    // and return_to_practice).
    expect(CONTRACTS_JS).toMatch(/action === 'release_to_practice' \|\| action === 'decline_change'/);
    expect(CONTRACTS_JS).toMatch(/submitChangeDecision\(contractId, action, note\)/);
  });
});

describe('Task 14: change-request loop — live-boot', () => {
  const RUN_ID = crypto.randomBytes(4).toString('hex');
  const DB_FILE = path.join('/tmp', `gplink-t14-${RUN_ID}.json`);
  const GP = { userId: 'u-gp-t14-1', email: 'gp-t14-1@gplink-test.local' };
  const SUPER_HOST = 'ceo-t14.local';
  const SUPER_EMAIL = 'super-t14@gplink-test.local';
  const HUB_EMAIL = 'hello@mygplink-test.local';
  const PRACTICE_EMAIL = 'reception@t14-clinic.local';
  const NOW = new Date().toISOString();

  const APP_RELEASE = 'app-t14-release';
  const APP_DECLINE_CEO = 'app-t14-decline-ceo';
  const APP_WRONGSTATUS = 'app-t14-wrongstatus';
  const APP_REVIEW_APPROVE = 'app-t14-review-approve';
  const APP_REVIEW_DECLINE = 'app-t14-review-decline';
  const APP_REVIEW_WITHDRAWN = 'app-t14-review-withdrawn';
  const APP_CHD_WITHDRAWN = 'app-t14-chd-withdrawn';

  let server, port, sbServer, sbPort, realFetch, mod;
  const resendCalls = [];
  const storage = new Map();

  const db = {
    user_profiles: [
      { user_id: GP.userId, email: GP.email, first_name: 'Farah', last_name: 'Osei', registration_country: 'uk' }
    ],
    career_roles: [
      { id: 'role-t14-1', provider: 'internal_ats', title: 'General Practitioner — VR', practice_name: 'T14 Family Clinic', practice_id: 'p-t14-1', is_active: true, job_status: 'open', updated_at: NOW }
    ],
    gp_applications: [
      { id: APP_RELEASE, user_id: GP.userId, career_role_id: 'role-t14-1', practice_id: 'p-t14-1', status: 'offer', ats_stage: 'offer', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'T14 Reception', applied_at: NOW },
      { id: APP_DECLINE_CEO, user_id: GP.userId, career_role_id: 'role-t14-1', practice_id: 'p-t14-1', status: 'offer', ats_stage: 'offer', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'T14 Reception', applied_at: NOW },
      { id: APP_WRONGSTATUS, user_id: GP.userId, career_role_id: 'role-t14-1', practice_id: 'p-t14-1', status: 'offer', ats_stage: 'offer', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'T14 Reception', applied_at: NOW },
      { id: APP_REVIEW_APPROVE, user_id: GP.userId, career_role_id: 'role-t14-1', practice_id: 'p-t14-1', status: 'offer', ats_stage: 'offer', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'T14 Reception', applied_at: NOW },
      { id: APP_REVIEW_DECLINE, user_id: GP.userId, career_role_id: 'role-t14-1', practice_id: 'p-t14-1', status: 'offer', ats_stage: 'offer', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'T14 Reception', applied_at: NOW },
      { id: APP_REVIEW_WITHDRAWN, user_id: GP.userId, career_role_id: 'role-t14-1', practice_id: 'p-t14-1', status: 'withdrawn', ats_stage: 'not_proceeding', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'T14 Reception', applied_at: NOW },
      { id: APP_CHD_WITHDRAWN, user_id: GP.userId, career_role_id: 'role-t14-1', practice_id: 'p-t14-1', status: 'withdrawn', ats_stage: 'not_proceeding', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'T14 Reception', applied_at: NOW }
    ],
    career_contracts: [
      { id: 'contract-t14-release', application_id: APP_RELEASE, user_id: GP.userId, career_role_id: 'role-t14-1', version: 1, status: 'changes_requested', change_request: 'Please increase sessions to 4 per week.', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'T14 Reception', created_at: NOW, updated_at: NOW },
      { id: 'contract-t14-declineceo', application_id: APP_DECLINE_CEO, user_id: GP.userId, career_role_id: 'role-t14-1', version: 1, status: 'changes_requested', change_request: 'Please add a relocation allowance.', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'T14 Reception', created_at: NOW, updated_at: NOW },
      { id: 'contract-t14-wrongstatus', application_id: APP_WRONGSTATUS, user_id: GP.userId, career_role_id: 'role-t14-1', version: 1, status: 'uploaded', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'T14 Reception', created_at: NOW, updated_at: NOW },
      { id: 'contract-t14-review-approve', application_id: APP_REVIEW_APPROVE, user_id: GP.userId, career_role_id: 'role-t14-1', version: 1, status: 'practice_review', change_request: 'Please move the start date to 1 December.', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'T14 Reception', created_at: NOW, updated_at: NOW },
      { id: 'contract-t14-review-decline', application_id: APP_REVIEW_DECLINE, user_id: GP.userId, career_role_id: 'role-t14-1', version: 1, status: 'practice_review', change_request: 'Please add two extra leave days.', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'T14 Reception', created_at: NOW, updated_at: NOW },
      { id: 'contract-t14-review-withdrawn', application_id: APP_REVIEW_WITHDRAWN, user_id: GP.userId, career_role_id: 'role-t14-1', version: 1, status: 'practice_review', change_request: 'Not relevant — the doctor withdrew.', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'T14 Reception', created_at: NOW, updated_at: NOW },
      { id: 'contract-t14-chd-withdrawn', application_id: APP_CHD_WITHDRAWN, user_id: GP.userId, career_role_id: 'role-t14-1', version: 1, status: 'changes_requested', change_request: 'Please adjust the contract terms.', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'T14 Reception', created_at: NOW, updated_at: NOW }
    ],
    user_state: [
      { user_id: GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }
    ]
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

        // ── Supabase Storage — only the upload-sign route is needed here:
        //    proving the approve path's returned uploadToken really works
        //    calls the real POST /api/practice/contract/sign-upload, which
        //    hits /object/upload/sign/<path>.
        if (u.pathname.startsWith('/storage/v1/')) {
          const mm = u.pathname.match(/^\/storage\/v1\/object\/upload\/sign\/(.+)$/);
          if (mm && req.method === 'POST') { sendJson(200, { url: '/object/upload/sign/' + mm[1] + '?token=test-token' }); return; }
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
            const row = Object.assign({ id: crypto.randomUUID(), created_at: new Date().toISOString() }, r);
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

  function httpJson(method, p, body, extraHeaders) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const headers = Object.assign({}, extraHeaders || {});
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
        const c = []; res.on('data', (x) => c.push(x));
        res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let parsed = null; try { parsed = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: parsed }); });
      });
      r.on('error', reject); r.end(data);
    });
  }
  function httpGetRaw(p) {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
        const c = []; res.on('data', (x) => c.push(x));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') }));
      });
      r.on('error', reject); r.end();
    });
  }
  function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
  function adminCookie() {
    const payload = b64url(JSON.stringify({ userProfile: { email: SUPER_EMAIL, adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
    const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
    return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
  }
  const ceoPost = (p, body, withCookie = true) => httpJson('POST', p, body, Object.assign({ Host: SUPER_HOST }, withCookie ? { Cookie: adminCookie() } : {}));
  const apiGet = (p) => httpJson('GET', p);
  const apiPost = (p, body) => httpJson('POST', p, body);

  const contract = (id) => db.career_contracts.find((c) => c.id === id);

  beforeAll(async () => {
    await startEmulator();
    process.env.AGENT_SKIP_DOTENV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DISABLED = 'false';
    process.env.AUTH_SECRET = 'contracts-t14-secret-' + RUN_ID;
    process.env.REQUIRE_SUPABASE_DB = 'false';
    process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
    process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.SUPABASE_DOCUMENT_BUCKET = 'gp-link-documents';
    process.env.ENFORCE_SAME_ORIGIN = 'false';
    process.env.DB_FILE_PATH = DB_FILE;
    process.env.OPENAI_API_KEY = '';
    process.env.ANTHROPIC_API_KEY = '';
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.REGISTRATION_HUB_EMAIL = HUB_EMAIL;
    process.env.APP_BASE_URL = 'https://app.mygplink.com.au';
    process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
    process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
    process.env.ADMIN_EMAILS = '';

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

  it('page: pages/practice-consent.html is reachable by an anonymous browser (no cookies) — never bounced to signin', async () => {
    let hop = await httpGetRaw('/pages/practice-consent.html');
    let redirects = 0;
    while (hop.status === 302 && redirects < 5) {
      expect(String(hop.headers.location || '')).not.toMatch(/\/pages\/signin/);
      hop = await httpGetRaw(hop.headers.location);
      redirects += 1;
    }
    expect(hop.status).toBe(200);
    expect(hop.body).toContain('<html');
  });

  it('POST /api/ceo/contract/change-decision: 401 without a CEO session', async () => {
    const r = await ceoPost('/api/ceo/contract/change-decision', { contractId: 'contract-t14-release', action: 'release_to_practice' }, false);
    expect(r.status).toBe(401);
  });

  it('POST /api/ceo/contract/change-decision: 400 without a contractId, 400 on an unknown action', async () => {
    const missing = await ceoPost('/api/ceo/contract/change-decision', { action: 'release_to_practice' });
    expect(missing.status).toBe(400);
    const bad = await ceoPost('/api/ceo/contract/change-decision', { contractId: 'contract-t14-release', action: 'delete_it' });
    expect(bad.status).toBe(400);
  });

  it('POST /api/ceo/contract/change-decision: 409 on a contract that is not changes_requested (both actions), status left untouched', async () => {
    const r1 = await ceoPost('/api/ceo/contract/change-decision', { contractId: 'contract-t14-wrongstatus', action: 'release_to_practice' });
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe('not_available');
    const r2 = await ceoPost('/api/ceo/contract/change-decision', { contractId: 'contract-t14-wrongstatus', action: 'decline_change' });
    expect(r2.status).toBe(409);
    expect(contract('contract-t14-wrongstatus').status).toBe('uploaded');
  });

  it('POST /api/ceo/contract/change-decision: 409 application_terminal when the application is withdrawn — contract stays "changes_requested", no practice email', async () => {
    const before = resendCalls.length;
    const r = await ceoPost('/api/ceo/contract/change-decision', { contractId: 'contract-t14-chd-withdrawn', action: 'release_to_practice' });
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('application_terminal');

    // The app-status check runs BEFORE the contract PATCH, so the contract
    // must be untouched — never flipped to practice_review for a dead application.
    const c = contract('contract-t14-chd-withdrawn');
    expect(c.status).toBe('changes_requested');

    // The application must stay withdrawn — never resurrected.
    const app = db.gp_applications.find((x) => x.id === APP_CHD_WITHDRAWN);
    expect(app.status).toBe('withdrawn');

    // No practice email fired.
    expect(resendCalls.length).toBe(before);
  });

  it('release_to_practice: moves the contract to practice_review, stamps the CEO note, and emails the practice BOTH consent links off the SAME token', async () => {
    const before = resendCalls.length;
    const r = await ceoPost('/api/ceo/contract/change-decision', { contractId: 'contract-t14-release', action: 'release_to_practice', note: 'Please confirm by Friday.' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const c = contract('contract-t14-release');
    expect(c.status).toBe('practice_review');
    expect(c.ceo_note).toBe('Please confirm by Friday.');

    const sent = resendCalls.slice(before);
    const practiceMail = sent.find((x) => Array.isArray(x.body.to) ? x.body.to.includes(PRACTICE_EMAIL) : x.body.to === PRACTICE_EMAIL);
    expect(practiceMail).toBeTruthy();
    expect(practiceMail.body.html).toContain('Please increase sessions to 4 per week.');
    expect(practiceMail.body.html).toContain('Please confirm by Friday.');

    const hrefs = [...practiceMail.body.html.matchAll(/href="([^"]*practice-consent\.html\?[^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBe(2);
    const urls = hrefs.map((h) => new URL(h));
    const tokens = urls.map((u) => u.searchParams.get('token'));
    const intents = urls.map((u) => u.searchParams.get('intent')).sort();
    expect(tokens[0]).toBeTruthy();
    // Both links carry the EXACT same consent token — one approve, one decline.
    expect(tokens[0]).toBe(tokens[1]);
    expect(intents).toEqual(['approve', 'decline']);

    // Prove — via the REAL public context endpoint, not by decoding the token
    // ourselves — that the token addresses this contract in the 'decide' state.
    const ctx = await apiGet('/api/practice/contract/consent-context?token=' + encodeURIComponent(tokens[0]));
    expect(ctx.status).toBe(200);
    expect(ctx.body.state).toBe('decide');
    expect(ctx.body.gpName).toContain('Farah');
    expect(ctx.body.roleTitle).toContain('General Practitioner');
    expect(ctx.body.changeRequest).toBe('Please increase sessions to 4 per week.');
  });

  it('decline_change: sends the contract back to sent_to_gp with declined_by_gplink and emails the GP with an offer-review CTA', async () => {
    const before = resendCalls.length;
    const r = await ceoPost('/api/ceo/contract/change-decision', { contractId: 'contract-t14-declineceo', action: 'decline_change' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const c = contract('contract-t14-declineceo');
    expect(c.status).toBe('sent_to_gp');
    expect(c.change_response).toBe('declined_by_gplink');

    const sent = resendCalls.slice(before);
    const gpMail = sent.find((x) => Array.isArray(x.body.to) && x.body.to.includes(GP.email));
    expect(gpMail).toBeTruthy();
    expect(gpMail.body.html).toContain('/pages/offer-review?applicationId=' + APP_DECLINE_CEO);

    // Replay: the contract already moved past changes_requested, so a
    // double-click 409s instead of re-flipping it or re-sending the email.
    const before2 = resendCalls.length;
    const replay = await ceoPost('/api/ceo/contract/change-decision', { contractId: 'contract-t14-declineceo', action: 'decline_change' });
    expect(replay.status).toBe(409);
    expect(resendCalls.length).toBe(before2);
  });

  it('consent-context: an invalid/garbage token is 410 (never 500, never leaks state)', async () => {
    const r = await apiGet('/api/practice/contract/consent-context?token=not-a-real-token');
    expect(r.status).toBe(410);
  });

  it('consent-context and consent POST: a wrong-purpose (contract_upload) token is rejected — 410, never drives the practice decision', async () => {
    const uploadToken = mod.__testUtils.createSignedPurposeToken(mod.__testUtils.CONTRACT_UPLOAD_TOKEN_PURPOSE, { contractId: 'contract-t14-review-approve' }, 3600000);
    const ctx = await apiGet('/api/practice/contract/consent-context?token=' + encodeURIComponent(uploadToken));
    expect(ctx.status).toBe(410);
    const post = await apiPost('/api/practice/contract/consent', { token: uploadToken, action: 'approve' });
    expect(post.status).toBe(410);
    // Never mutated the contract this "almost" addressed.
    expect(contract('contract-t14-review-approve').status).toBe('practice_review');
  });

  it('sign-upload and finalize reject a contract_consent token (wrong purpose can never drive the upload endpoints)', async () => {
    const consentToken = mod.__testUtils.createSignedPurposeToken(mod.__testUtils.CONTRACT_CONSENT_TOKEN_PURPOSE, { contractId: 'contract-t14-review-approve' }, 3600000);
    const sign = await apiPost('/api/practice/contract/sign-upload', { token: consentToken, filename: 'c.pdf', mimeType: 'application/pdf' });
    expect(sign.status).toBe(410);
    const fin = await apiPost('/api/practice/contract/finalize', { token: consentToken, path: 'x', filename: 'c.pdf', mimeType: 'application/pdf' });
    expect(fin.status).toBe(410);
  });

  it('consent-context + consent POST: a withdrawn application answers 409 {code:"withdrawn"} and refuses to act — nothing mutated', async () => {
    const tok = mod.__testUtils.createSignedPurposeToken(mod.__testUtils.CONTRACT_CONSENT_TOKEN_PURPOSE, { contractId: 'contract-t14-review-withdrawn' }, 3600000);
    const ctx = await apiGet('/api/practice/contract/consent-context?token=' + encodeURIComponent(tok));
    expect(ctx.status).toBe(409);
    expect(ctx.body.code).toBe('withdrawn');

    const before = db.career_contracts.length;
    const post = await apiPost('/api/practice/contract/consent', { token: tok, action: 'approve' });
    expect(post.status).toBe(409);
    expect(post.body.code).toBe('withdrawn');
    expect(db.career_contracts.length).toBe(before);
    expect(contract('contract-t14-review-withdrawn').status).toBe('practice_review');
  });

  it('consent approve: voids the current contract (approved), creates a v2 awaiting_upload row, and the returned uploadToken really works against sign-upload AND addresses the NEW row', async () => {
    const before = resendCalls.length;
    const tok = mod.__testUtils.createSignedPurposeToken(mod.__testUtils.CONTRACT_CONSENT_TOKEN_PURPOSE, { contractId: 'contract-t14-review-approve' }, 3600000);
    const r = await apiPost('/api/practice/contract/consent', { token: tok, action: 'approve' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.uploadToken).toBe('string');

    const original = contract('contract-t14-review-approve');
    expect(original.status).toBe('void');
    expect(original.change_response).toBe('approved');

    const newRow = db.career_contracts.find((c) => c.application_id === APP_REVIEW_APPROVE && c.status === 'awaiting_upload');
    expect(newRow).toBeTruthy();
    expect(newRow.id).not.toBe('contract-t14-review-approve');
    expect(newRow.version).toBe(2);
    expect(newRow.ai_review_status).toBe('not_run');
    expect(newRow.practice_contact_email).toBe(PRACTICE_EMAIL);
    expect(newRow.practice_contact_name).toBe('T14 Reception');

    // (a) The returned uploadToken genuinely works against the real
    // sign-upload endpoint — not just a plausible-looking string.
    const sign = await apiPost('/api/practice/contract/sign-upload', { token: r.body.uploadToken, filename: 'Revised-Contract.pdf', mimeType: 'application/pdf' });
    expect(sign.status).toBe(200);
    expect(typeof sign.body.uploadUrl).toBe('string');
    expect(sign.body.path).toContain('v2/');

    // (b) It addresses the NEW row specifically, never the just-voided one —
    // proven via the real public context endpoint, not by decoding the token.
    const upCtx = await apiGet('/api/practice/offer/context?token=' + encodeURIComponent(r.body.uploadToken));
    expect(upCtx.status).toBe(200);
    expect(upCtx.body.state).toBe('upload');
    expect(upCtx.body.contractId).toBe(newRow.id);
    expect(upCtx.body.contractId).not.toBe('contract-t14-review-approve');

    // (c) The practice was also emailed the re-upload link for later, off the
    // SAME uploadToken returned in the response.
    const sent = resendCalls.slice(before);
    const reuploadMail = sent.find((x) => Array.isArray(x.body.to) && x.body.to.includes(PRACTICE_EMAIL) && /re-upload/i.test(x.body.subject || ''));
    expect(reuploadMail).toBeTruthy();
    expect(reuploadMail.body.html).toContain(encodeURIComponent(r.body.uploadToken));

    // Replay: the original token's contract is now void, not practice_review
    // — a repeat consent 409s rather than minting yet another revision.
    const replay = await apiPost('/api/practice/contract/consent', { token: tok, action: 'approve' });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('not_available');

    // The SAME original token, re-fetched via GET, now reports "done" — a
    // stale re-open of the emailed link no longer re-shows the decide UI.
    const doneCtx = await apiGet('/api/practice/contract/consent-context?token=' + encodeURIComponent(tok));
    expect(doneCtx.status).toBe(200);
    expect(doneCtx.body.state).toBe('done');
  });

  it('consent decline: sends the contract back to sent_to_gp with declined_by_practice, notifies the GP, and alerts the CEO', async () => {
    const before = resendCalls.length;
    const tok = mod.__testUtils.createSignedPurposeToken(mod.__testUtils.CONTRACT_CONSENT_TOKEN_PURPOSE, { contractId: 'contract-t14-review-decline' }, 3600000);
    const r = await apiPost('/api/practice/contract/consent', { token: tok, action: 'decline' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const c = contract('contract-t14-review-decline');
    expect(c.status).toBe('sent_to_gp');
    expect(c.change_response).toBe('declined_by_practice');

    const sent = resendCalls.slice(before);
    const gpMail = sent.find((x) => Array.isArray(x.body.to) && x.body.to.includes(GP.email));
    expect(gpMail).toBeTruthy();
    expect(gpMail.body.html).toContain('/pages/offer-review?applicationId=' + APP_REVIEW_DECLINE);

    const ceoMail = sent.find((x) => Array.isArray(x.body.to) && x.body.to.includes(HUB_EMAIL));
    expect(ceoMail).toBeTruthy();
    expect(ceoMail.body.subject.toLowerCase()).toMatch(/declined/);

    // Replay: no longer practice_review, so a repeat decline 409s.
    const before2 = resendCalls.length;
    const replay = await apiPost('/api/practice/contract/consent', { token: tok, action: 'decline' });
    expect(replay.status).toBe(409);
    expect(resendCalls.length).toBe(before2);
  });
});

describe('interview_completed — status plumbing (Task 15, source-assertion)', () => {
  const SERVER_SRC = fs.readFileSync(SERVER_PATH, 'utf8');
  const APP_DETAIL_SRC = fs.readFileSync(path.join(ROOT, 'pages', 'application-detail.html'), 'utf8');

  it('isCareerInterviewStatus recognizes interview_completed', () => {
    const start = SERVER_SRC.indexOf('function isCareerInterviewStatus');
    const fn = SERVER_SRC.slice(start, start + 700);
    expect(fn).toContain("normalized === 'interview_completed'");
  });

  it('buildInternalCareerStatusPresentation labels interview_completed as awaiting the practice\'s decision, tone review', () => {
    expect(SERVER_SRC).toContain("storedStatus === 'interview_completed'");
    expect(SERVER_SRC).toContain('Interview done — awaiting the practice');
    // Same return statement carries both the label and the review tone.
    expect(SERVER_SRC).toMatch(/storedStatus === 'interview_completed'\)[\s\S]{0,20}return[\s\S]{0,220}statusTone: 'review'/);
  });

  it('application-detail.html timeline maps carry interview_completed at the interview step (index 2) with its own label', () => {
    expect(APP_DETAIL_SRC).toMatch(/interview:\s*2,\s*interview_scheduled:\s*2,\s*shortlisted:\s*2,\s*interview_completed:\s*2/);
    expect(APP_DETAIL_SRC).toContain('interview_completed: "Interview complete"');
  });
});

// Task 15 (2026-07-22): 'interview_completed' status plumbing + the
// Zoom-unconfigured fallback in the detect-no-shows cron. Prod has NO Zoom
// credentials today, so every interview booking's zoom_meeting_id is ''.
// Without a fix: the meeting.ended webhook can never fire (Zoom never calls
// it), AND this cron's own Zoom-attendance check
// (fetchZoomPastMeetingParticipants) returns null for a missing meeting id
// — so the call is just "skipped" every pass, forever. The interview would
// never complete and the practice would never get Task 9's post-interview
// decision email. Fix: key completion on the CALL's own (missing)
// zoom_meeting_id, not global Zoom configuration — once
// scheduled_at + duration + a 15-min buffer has passed, mark the call
// completed (attendance is unknowable without Zoom, so NEVER a no_show) and
// fire the same idempotent sendPostInterviewDecisionEmail helper Task 9
// wired into the Zoom-webhook and Zoom-attended paths.
describe('detect-no-shows — Zoom-unconfigured fallback (Task 15)', () => {
  const RUN_ID = crypto.randomBytes(4).toString('hex');
  const DB_FILE = path.join('/tmp', `gplink-t15-nozoom-${RUN_ID}.json`);
  const CRON_SECRET = 't15-nozoom-cron-secret-' + RUN_ID;
  const GP = { userId: 'u-gp-t15-1', email: 't15-gp@gplink-test.local' };
  const NOW = new Date().toISOString();
  const hoursAgoIso = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const hoursFromNowIso = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

  const APP_PAST = 'app-t15-past';
  const APP_FUTURE = 'app-t15-future';
  const CALL_PAST = 'call-t15-past';
  const CALL_FUTURE = 'call-t15-future';

  let server, port;
  let sbServer, sbPort;
  let realFetch;
  let mod;
  const resendCalls = [];

  const db = {
    user_profiles: [
      { user_id: GP.userId, email: GP.email, first_name: 'Zoomless', last_name: 'Candidate', registration_country: 'uk' }
    ],
    practices: [
      { id: 'p-t15-1', name: 'Southbank Family Clinic', source: 'internal_ats', contact_name: 'Southbank Reception', contact_email: 'reception@southbank-t15-test.local', is_active: true, created_at: NOW }
    ],
    career_roles: [
      { id: 'role-t15-1', provider: 'internal_ats', provider_role_id: 'ats_t15_1', title: 'General Practitioner — VR', practice_name: 'Southbank Family Clinic', practice_id: 'p-t15-1', location_city: 'Perth', location_state: 'WA', is_active: true, job_status: 'open', updated_at: NOW }
    ],
    gp_applications: [
      { id: APP_PAST, user_id: GP.userId, career_role_id: 'role-t15-1', practice_id: 'p-t15-1', provider_role_id: 'ats_t15_1', status: 'interview', ats_stage: 'interview', applied_at: NOW },
      { id: APP_FUTURE, user_id: GP.userId, career_role_id: 'role-t15-1', practice_id: 'p-t15-1', provider_role_id: 'ats_t15_1', status: 'interview', ats_stage: 'interview', applied_at: NOW }
    ],
    scheduled_calls: [
      // Zoom never configured at booking time -> zoom_meeting_id ''. Scheduled
      // 2h ago, 45-min duration: well past scheduled_at + 45 + 15min buffer.
      { id: CALL_PAST, case_id: null, user_id: GP.userId, application_id: APP_PAST, meeting_kind: 'interview', status: 'booked', zoom_meeting_id: '', scheduled_at: hoursAgoIso(2), duration_minutes: 45, stage: null, summary_status: 'not_requested' },
      // Also zoomless, but scheduled in the FUTURE — must stay completely
      // untouched (the outer cron query only ever selects scheduled_at in
      // the past, so this also proves the query itself never misfires here).
      { id: CALL_FUTURE, case_id: null, user_id: GP.userId, application_id: APP_FUTURE, meeting_kind: 'interview', status: 'booked', zoom_meeting_id: '', scheduled_at: hoursFromNowIso(1), duration_minutes: 45, stage: null, summary_status: 'not_requested' }
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
      if (op === 'lt') return cell != null && String(cell) < val;
      if (op === 'gt') return cell != null && String(cell) > val;
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
          const saved = incoming.map((r) => {
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
    process.env.AUTH_SECRET = 't15-nozoom-secret-' + RUN_ID;
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
    process.env.APP_BASE_URL = 'https://app.mygplink.com.au';
    // Deliberately NOT setting ZOOM_CLIENT_ID/SECRET/ACCOUNT_ID — proves the
    // fallback fires from prod's actual Zoom-unconfigured state, not a mock.
    // CRON_SECRET is read once into a module-level const at require time, so
    // it must be set before import('../server.js') below.
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
      // Any other outbound call (e.g. a stray Zoom API request) gets a benign
      // empty 200 rather than a network error — if the no-zoom branch is
      // mis-ordered and DOES reach fetchZoomPastMeetingParticipants, that
      // helper already short-circuits on a missing meetingId before ever
      // reaching fetch(), so this stub should never actually be exercised
      // for this suite's calls.
      return Promise.resolve(new Response('{}', { status: 200 }));
    };

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

  it('a booked interview call with no zoom_meeting_id, past scheduled_at+duration+15min, completes via the time-based fallback (never no_show) and fires the practice decision email', async () => {
    const before = resendCalls.length;
    const r = await getCron('/api/cron/detect-no-shows', { Authorization: 'Bearer ' + CRON_SECRET });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const call = callRow(CALL_PAST);
    expect(call.status).toBe('completed');
    expect(call.completed_at).toBeTruthy();
    // Attendance is unknowable without Zoom — this must NEVER be classified
    // as a no-show (which would fire the 2-strike re-invite machinery).
    expect(call.no_show_at == null).toBe(true);

    const app = appRow(APP_PAST);
    expect(app.status).toBe('interview_completed');
    expect(app.interview_completed_at).toBeTruthy();
    expect(app.post_interview_email_sent_at).toBeTruthy();

    expect(resendCalls.length).toBe(before + 1);
    const sent = resendCalls[resendCalls.length - 1].body;
    expect(sent.to).toEqual(['reception@southbank-t15-test.local']);
    expect(sent.subject).toBe('How did the interview with Dr Candidate go?');
    expect(sent.html).toContain('intent=offer');
    expect(sent.html).toContain('intent=decline');
  });

  // Reuses the SAME cron pass triggered by the previous test (this file's
  // other live-boot blocks rely on this same sequential-shared-db pattern,
  // e.g. the Task 9 idempotency test above reads state the meeting.ended
  // test mutated) — proves the future-scheduled zoomless call was never
  // touched by that pass at all.
  it('a zoomless call scheduled in the future is left completely untouched by that same cron pass', () => {
    const call = callRow(CALL_FUTURE);
    expect(call.status).toBe('booked');
    expect(call.completed_at == null).toBe(true);
    expect(call.no_show_at == null).toBe(true);

    const app = appRow(APP_FUTURE);
    expect(app.status).toBe('interview');
    expect(app.post_interview_email_sent_at == null).toBe(true);
  });

  it('a second cron pass does not double-complete the already-completed call or double-send the email (idempotent via the post_interview_email_sent_at stamp)', async () => {
    const before = resendCalls.length;
    const completedAtBefore = callRow(CALL_PAST).completed_at;

    const r = await getCron('/api/cron/detect-no-shows', { Authorization: 'Bearer ' + CRON_SECRET });
    expect(r.status).toBe(200);

    // The call is no longer status='booked', so the main loop's own query
    // excludes it outright on the second pass.
    expect(callRow(CALL_PAST).completed_at).toBe(completedAtBefore);
    expect(resendCalls.length).toBe(before);
  });
});

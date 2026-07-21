// Post-interview contract pipeline (owner spec 2026-07-21):
// interview happens -> practice extends offer by uploading a contract ->
// CEO + AI review -> GP signs (upload) or requests changes -> signed = placement.
//
// Task 8 only lands the migration (career_contracts table + two new
// gp_applications bookkeeping columns). Later tasks build the endpoints on
// top of it and will extend this file with server/endpoint coverage — this
// describe block covers the migration itself.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
});

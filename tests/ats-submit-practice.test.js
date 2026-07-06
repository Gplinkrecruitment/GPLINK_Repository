// Task D — Zoho-free submit-to-practice + pipeline ops parity.
//
// Boots the real server against the in-memory PostgREST emulator pattern from
// tests/ats-offer-flow.test.js. Outbound email (Resend), push (FCM) and Zoho
// token calls are captured by wrapping global fetch; a tiny /storage/v1
// handler in the emulator serves the seeded CV file so the real
// supabaseStorageDownloadObject path is exercised.
//
// Covers:
//  1. Affordance flags: GET /api/admin/career/applications marks internal apps
//     (no Zoho ids) submittable; GET /api/ceo/candidate exposes
//     practice_submission_status on each application (drawer affordance).
//  2. In-app submit (no Zoho): exactly ONE practice email to the practices-table
//     contact, subject carries the GP name, CV attached (base64 asserted);
//     gp_applications parity patch (submitted_to_practice + at/by + contact),
//     ats_stage → 'submitted' (actor 'submitted_to_practice'), VA task
//     completed, case event logged, GP push sent; re-submit → 409.
//  3. Graceful no-CV path: email still sent, no attachment, "CV shortly" line.
//  4. 422 no_practice_contact when no contact email is resolvable anywhere.
//  5. Zoho branch preserved: app WITH zoho ids + a connection row routes to the
//     Zoho branch (token endpoint hit) and keeps the historical 503 when the
//     connection can't refresh — the in-app email branch does NOT fire.
//  6. Kanban PATCH not_proceeding: sets client_rejected ONLY when the card was
//     previously submitted_to_practice; any other prior status is untouched.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ats-submit-${RUN_ID}.json`);
let server, port;          // app under test
let sbServer, sbPort;      // Supabase (PostgREST + storage) emulator

const SUPER_HOST = 'ceo-submit.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const GP = { userId: 'u-gp-1', email: 'gp@gplink-test.local' };       // has a CV
const GP2 = { userId: 'u-gp-2', email: 'other@gplink-test.local' };  // no CV
const GP3 = { userId: 'u-gp-3', email: 'third@gplink-test.local' };  // no practice contact anywhere
const NOW = new Date().toISOString();

const CV_PDF = Buffer.from('%PDF-1.4 test signed cv');
const CV_STORAGE_PATH = 'user-docs/u-gp-1/cv.pdf';

// Captured outbound calls.
const resendCalls = [];
const fcmCalls = [];
const zohoTokenCalls = [];

// When true the emulator answers every integration_connections read with a
// PostgREST 500 — the transient-DB-blip case the branch decision must treat
// as "can't confirm" (503), NEVER as "Zoho disconnected" (F5).
let simulateConnReadFailure = false;

// ── In-memory PostgREST emulator ────────────────────────────────────────────
const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Test', last_name: 'Doctor', registration_country: 'uk' },
    { user_id: GP2.userId, email: GP2.email, first_name: 'Other', last_name: 'Doctor', registration_country: 'ie' },
    { user_id: GP3.userId, email: GP3.email, first_name: 'Third', last_name: 'Doctor', registration_country: 'nz' }
  ],
  user_state: [
    { user_id: GP.userId, state: { gp_onboarding_complete: true, gp_push_tokens: [{ token: 'push-tok-1' }] }, updated_at: NOW },
    { user_id: GP2.userId, state: { gp_onboarding_complete: true }, updated_at: NOW },
    { user_id: GP3.userId, state: {}, updated_at: NOW }
  ],
  registration_cases: [
    // case-1 carries a cached AI handover summary (D1a): the intro email must
    // include ONLY overview + key_history — never the internal concerns or
    // action_items.
    {
      id: 'case-1', user_id: GP.userId, status: 'active', stage: 'career', assigned_rso: null, assigned_va: null,
      ai_handover_summary: {
        overview: 'Experienced UK-trained GP with a strong chronic-disease focus.',
        key_history: 'Ten years in NHS general practice across Leeds.',
        concerns: ['INTERNAL-ONLY: visa timeline is tight'],
        action_items: ['INTERNAL-ONLY: chase the police check'],
        generated_at: NOW
      }
    },
    { id: 'case-2', user_id: GP2.userId, status: 'active', stage: 'career', assigned_rso: null, assigned_va: null },
    { id: 'case-3', user_id: GP3.userId, status: 'active', stage: 'career', assigned_rso: null, assigned_va: null }
  ],
  registration_tasks: [
    { id: 'task-1', case_id: 'case-1', status: 'open', task_type: 'practice_pack_child', title: 'Submit candidate to practice' }
  ],
  task_timeline: [],
  rso_team: [],
  practices: [
    { id: 'p1', name: 'Greenslopes Family Medical', source: 'internal_ats', contact_name: 'Anna Manager', contact_email: 'anna@greenslopes-test.local', is_active: true, created_at: NOW },
    { id: 'p2', name: 'Riverside Medical', source: 'internal_ats', contact_name: '', contact_email: '', is_active: true, created_at: NOW }
  ],
  career_roles: [
    { id: 'role-1', provider: 'internal_ats', provider_role_id: 'ats_r1', title: 'General Practitioner — VR', practice_name: 'Greenslopes Family Medical', practice_id: 'p1', location_city: 'Brisbane', location_state: 'QLD', is_active: true, job_status: 'open', updated_at: NOW },
    { id: 'role-2', provider: 'internal_ats', provider_role_id: 'ats_r2', title: 'GP — After Hours', practice_name: 'Riverside Medical', practice_id: 'p2', location_city: 'Cairns', location_state: 'QLD', is_active: true, job_status: 'open', updated_at: NOW }
  ],
  gp_applications: [
    // Internal app, GP with CV + linked VA task → happy path.
    { id: 'app-1', user_id: GP.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'applied', submission_task_id: 'task-1', applied_at: NOW },
    // Internal app, GP without CV → graceful no-attachment path.
    { id: 'app-2', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'applied', applied_at: NOW },
    // Zoho-managed app (ids present) → Zoho branch when a connection exists.
    { id: 'app-3', user_id: GP.userId, career_role_id: 'role-1', provider_role_id: 'z-job-1', zoho_application_id: 'z-app-1', zoho_candidate_id: 'z-cand-1', status: 'applied', ats_stage: 'applied', applied_at: NOW },
    // Internal app on a practice with NO contact email anywhere → 422.
    { id: 'app-4', user_id: GP3.userId, career_role_id: 'role-2', provider_role_id: 'ats_r2', status: 'applied', ats_stage: 'applied', applied_at: NOW },
    // Kanban mapping: previously submitted → not_proceeding flips to client_rejected.
    { id: 'app-5', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'review', ats_stage: 'submitted', practice_submission_status: 'submitted_to_practice', applied_at: NOW },
    // Kanban control: NOT previously submitted → not_proceeding must not touch it.
    { id: 'app-6', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'reviewing', practice_submission_status: 'pending_va_submission', applied_at: NOW },
    // Zoho-managed app for the connection-read-failure case (F5).
    { id: 'app-7', user_id: GP.userId, career_role_id: 'role-1', provider_role_id: 'z-job-2', zoho_application_id: 'z-app-2', zoho_candidate_id: 'z-cand-2', status: 'applied', ats_stage: 'applied', applied_at: NOW }
  ],
  ats_stage_events: [],
  user_documents: [
    // Task 6 (2026-07-06 plan): the legacy cv_signed_dated fallback now
    // requires status='uploaded' — this is the bug fix (a rejected doc filed
    // under this key could otherwise still be the most-recently-updated row
    // and get emailed out as the candidate's "CV"). This GP has no career_cv
    // row, so this uploaded legacy doc is what the fallback picks up.
    { id: 'doc-cv-1', user_id: GP.userId, document_key: 'cv_signed_dated', country_code: 'AU', file_name: 'Dr-Test-CV.pdf', mime_type: 'application/pdf', storage_path: CV_STORAGE_PATH, status: 'uploaded', updated_at: NOW }
  ],
  integration_connections: [],
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
    if (!FILTER_OPS.includes(op)) continue; // unsupported → don't filter
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
      // Storage: serve the seeded CV so supabaseStorageDownloadObject works.
      if (u.pathname.startsWith('/storage/v1/object/')) {
        const decodedPath = decodeURIComponent(u.pathname);
        if (req.method === 'GET' && decodedPath.includes(CV_STORAGE_PATH)) {
          res.writeHead(200, { 'Content-Type': 'application/pdf' });
          res.end(CV_PDF);
          return;
        }
        send(404, { message: 'object not found' });
        return;
      }
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const table = decodeURIComponent(m[1]);
      if (table === 'integration_connections' && simulateConnReadFailure) {
        send(500, { message: 'internal server error (simulated PostgREST blip)' });
        return;
      }
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

// ── Session cookie minting (patterns from the sibling test files) ───────────
function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function adminCookieFor(email, adminRole) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
const superCookie = () => adminCookieFor(SUPER_EMAIL, 'super_admin');

function httpReq(method, p, { cookie, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (host) headers.Host = host;
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

const adminPost = (p, body) => httpReq('POST', p, { host: SUPER_HOST, cookie: superCookie(), body });
const adminGet = (p) => httpReq('GET', p, { host: SUPER_HOST, cookie: superCookie() });
const adminPatch = (p, body) => httpReq('PATCH', p, { host: SUPER_HOST, cookie: superCookie(), body });
const submitApp = (applicationId) => adminPost('/api/admin/career/application/submit-to-practice', { applicationId });

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ats-submit-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  // Zoho env IS configured (unlike most tests) so the branch decision can see a
  // "connection exists" state when a row is seeded into integration_connections.
  // While that table is empty, apps still route to the in-app branch.
  process.env.ZOHO_RECRUIT_CLIENT_ID = 'test-zoho-client';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = 'test-zoho-secret';
  process.env.ZOHO_RECRUIT_REDIRECT_URI = 'https://app.test.local/api/zoho/callback';
  process.env.OPENAI_API_KEY = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = 'admin-submit.local';
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = '';
  // Real email + push config so the notification legs actually run — the
  // wrapped fetch below captures them instead of hitting the network.
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.FCM_SERVER_KEY = 'test-fcm-key';

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.resend.com/')) {
      let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
      resendCalls.push({ url: u, body: parsed });
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
    }
    if (u.startsWith('https://fcm.googleapis.com/')) {
      let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
      fcmCalls.push({ url: u, body: parsed });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }
    if (u.startsWith('https://accounts.zoho.com/')) {
      zohoTokenCalls.push(u);
      // Connection exists but can't refresh → the Zoho branch must keep its 503.
      return Promise.resolve(new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400 }));
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

describe('affordance flags (admin panel + CEO drawer payloads)', () => {
  it('marks an internal app (no Zoho ids) as submittable in the admin list', async () => {
    const r = await adminGet('/api/admin/career/applications');
    expect(r.status).toBe(200);
    const app1 = r.body.applications.find((a) => a.id === 'app-1');
    expect(app1).toBeTruthy();
    expect(app1.can_submit_to_practice).toBe(true);
    expect(app1.submit_disabled_reason).toBe('');
    // The Zoho-managed pending app is submittable too (Zoho branch handles it).
    const app3 = r.body.applications.find((a) => a.id === 'app-3');
    expect(app3.can_submit_to_practice).toBe(true);
    // Already-submitted card is not.
    const app5 = r.body.applications.find((a) => a.id === 'app-5');
    expect(app5.can_submit_to_practice).toBe(false);
  });

  it('internal apps carry the presented status_label/status_key (kanban truth, F6); Zoho rows stay raw', async () => {
    const r = await adminGet('/api/admin/career/applications');
    expect(r.status).toBe(200);
    // Internal app in the 'applied' lane → the presentation, not the raw status.
    const app1 = r.body.applications.find((a) => a.id === 'app-1');
    expect(app1.status_key).toBe('applied');
    expect(app1.status_label).toBe('Application submitted');
    // Internal app already sent to the practice (ats_stage 'submitted').
    const app5 = r.body.applications.find((a) => a.id === 'app-5');
    expect(app5.status_key).toBe('submitted');
    expect(app5.status_label).toBe('Sent to the practice');
    // Zoho-managed rows are untouched: no presented fields at all.
    const app3 = r.body.applications.find((a) => a.id === 'app-3');
    expect(app3.status_label).toBeUndefined();
    expect(app3.status_key).toBeUndefined();
  });

  it('exposes practice_submission_status on the CEO candidate drawer apps', async () => {
    const r = await adminGet('/api/ceo/candidate?case_id=case-1');
    expect(r.status).toBe(200);
    const apps = r.body.candidate.apps || [];
    const app1 = apps.find((a) => String(a.id) === 'app-1');
    expect(app1).toBeTruthy();
    expect(app1.practice_submission_status).toBe('pending_va_submission');
  });
});

describe('POST submit-to-practice — in-app branch (no Zoho)', () => {
  it('emails the practice once (CV attached) and mirrors every Zoho-branch side effect', async () => {
    const beforeEmails = resendCalls.length;
    const beforeFcm = fcmCalls.length;

    const r = await submitApp('app-1');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.submission_mode).toBe('in_app_email');

    // Exactly ONE outbound email — the practice introduction.
    const sends = resendCalls.slice(beforeEmails);
    expect(sends.length).toBe(1);
    const email = sends[0].body;
    expect(email.to).toContain('anna@greenslopes-test.local');
    expect(String(email.subject)).toContain('Test Doctor');
    expect(String(email.subject)).toContain('General Practitioner — VR');
    expect(String(email.from)).toContain('GP Link');
    expect(String(email.html)).toContain('Test Doctor');
    expect(String(email.html)).toContain('United Kingdom'); // registration country fact
    // CV attachment: real bytes fetched from storage, base64 in the payload.
    expect(Array.isArray(email.attachments)).toBe(true);
    expect(email.attachments.length).toBe(1);
    expect(email.attachments[0].filename).toBe('Dr-Test-CV.pdf');
    expect(email.attachments[0].content).toBe(CV_PDF.toString('base64'));
    expect(email.attachments[0].content_type).toBe('application/pdf');
    expect(String(email.html)).not.toContain('CV shortly');

    // Task 6 (2026-07-06 plan) replaced the old D1a "Candidate overview" /
    // "Key history" section (sourced from the cached ai_handover_summary)
    // with the new profile-driven intro + AI recommendation + approve/
    // turn-down buttons — see docs/mockups/career-cv-gate-practice-email.html
    // Section 2, which has no such section. The seeded ai_handover_summary on
    // case-1 (including its INTERNAL-ONLY concerns/action_items) is simply
    // never read by this endpoint any more, so it can never leak either.
    expect(String(email.html)).not.toContain('Candidate overview');
    expect(String(email.html)).not.toContain('INTERNAL-ONLY');
    expect(String(email.text)).not.toContain('INTERNAL-ONLY');
    // New copy in its place: profile-driven intro sentence, AI recommendation
    // (test-suite has no ANTHROPIC_API_KEY, so it's simply omitted), and the
    // one-click decision buttons/token.
    expect(String(email.html)).toContain('Expedited Specialist Pathway');
    expect(String(email.html)).toContain('/pages/practice-decision.html?token=');
    expect(String(email.html)).toContain('action=approve');
    expect(String(email.html)).toContain('action=turn_down');
    expect(String(email.html)).not.toContain('Why we recommend'); // no ANTHROPIC_API_KEY in this suite

    // D1b: the three one-click response links (signed practice-action tokens)
    // are in BOTH bodies, and the reply-by-email fallback line stays.
    for (const bodyPart of [String(email.html), String(email.text)]) {
      expect(bodyPart).toContain('/api/practice/respond?token=');
      expect(bodyPart).toContain('Accept this candidate');
      expect(bodyPart).toContain('Request an interview');
      expect(bodyPart).toContain('Not the right fit');
      expect(bodyPart).toContain('just reply to this email');
    }
    expect((String(email.html).match(/\/api\/practice\/respond\?token=/g) || []).length).toBe(3);

    // gp_applications parity patch.
    const app = db.gp_applications.find((a) => a.id === 'app-1');
    expect(app.practice_submission_status).toBe('submitted_to_practice');
    expect(app.practice_contact_email).toBe('anna@greenslopes-test.local');
    expect(app.practice_contact_name).toBe('Anna Manager');
    expect(app.submitted_to_practice_by).toBe(SUPER_EMAIL);
    expect(app.submitted_to_practice_at).toBeTruthy();
    expect(app.status).toBe('review');

    // Kanban advanced to 'submitted' with the dedicated actor (audit row).
    expect(app.ats_stage).toBe('submitted');
    const ev = db.ats_stage_events.find((e) => e.application_id === 'app-1' && e.to_stage === 'submitted');
    expect(ev).toBeTruthy();
    expect(ev.actor).toBe('submitted_to_practice');

    // Linked VA task completed + case event logged.
    const task = db.registration_tasks.find((t) => t.id === 'task-1');
    expect(task.status).toBe('completed');
    const event = db.task_timeline.find((e) => e.case_id === 'case-1' && e.title === 'Candidate submitted to practice');
    expect(event).toBeTruthy();
    expect(String(event.detail)).toContain('Anna Manager');

    // GP push notification (same copy as the Zoho branch). The push is
    // fire-and-forget in the route, so poll briefly for it to land.
    const deadline = Date.now() + 3000;
    while (fcmCalls.length <= beforeFcm && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 50));
    }
    const pushes = fcmCalls.slice(beforeFcm);
    expect(pushes.length).toBeGreaterThan(0);
    const push = pushes[pushes.length - 1];
    expect(push.body.to).toBe('push-tok-1');
    expect(JSON.stringify(push.body)).toContain('Profile Submitted to Practice');
  });

  it('a second submit is refused (no longer pending)', async () => {
    const before = resendCalls.length;
    const r = await submitApp('app-1');
    expect(r.status).toBe(409);
    expect(resendCalls.length).toBe(before);
  });

  it('flips the admin-panel flag off after submitting', async () => {
    const r = await adminGet('/api/admin/career/applications');
    const app1 = r.body.applications.find((a) => a.id === 'app-1');
    expect(app1.can_submit_to_practice).toBe(false);
    expect(app1.practice_submission_status).toBe('submitted_to_practice');
    // The presented status follows the kanban (F6): submitted lane now.
    expect(app1.status_label).toBe('Sent to the practice');
  });

  it('sends WITHOUT an attachment (and says the CV follows) when no CV row exists', async () => {
    const before = resendCalls.length;
    const r = await submitApp('app-2');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const sends = resendCalls.slice(before);
    expect(sends.length).toBe(1);
    const email = sends[0].body;
    expect(email.to).toContain('anna@greenslopes-test.local');
    expect(String(email.subject)).toContain('Other Doctor');
    expect(email.attachments).toBeUndefined();
    expect(String(email.html)).toContain('CV shortly');
    // GP2's case has NO cached AI summary → the overview section is simply
    // absent (graceful skip, D1a).
    expect(String(email.html)).not.toContain('Candidate overview');

    const app = db.gp_applications.find((a) => a.id === 'app-2');
    expect(app.practice_submission_status).toBe('submitted_to_practice');
    expect(app.ats_stage).toBe('submitted');
  });

  it('422s with no_practice_contact when no contact email is resolvable', async () => {
    const before = resendCalls.length;
    const r = await submitApp('app-4');
    expect(r.status).toBe(422);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('no_practice_contact');
    expect(r.body.message).toContain('Practices tab');
    expect(resendCalls.length).toBe(before); // nothing sent

    const app = db.gp_applications.find((a) => a.id === 'app-4');
    expect(app.practice_submission_status).toBeUndefined(); // untouched
    expect(app.ats_stage).toBe('applied');
  });
});

// Zoho Recruit is decommissioned — the old Zoho submit branch (and its
// connection-read 503 guard, F5) is gone. Every application, including legacy
// ones that still carry zoho ids, now takes the in-app email branch.
describe('legacy Zoho-id applications now submit in-app (post-decommission)', () => {
  it('an app WITH zoho ids takes the in-app email branch even if a legacy connection row exists', async () => {
    db.integration_connections.push({
      id: 'conn-1', provider: 'zoho_recruit', status: 'connected',
      refresh_token: 'rt-test-1', accounts_server: 'https://accounts.zoho.com',
      api_domain: 'https://www.zohoapis.com', scopes: [], metadata: {}, updated_at: NOW
    });
    const before = resendCalls.length;
    try {
      const r = await submitApp('app-3');
      expect(r.status).toBe(200);
      expect(r.body.submission_mode).toBe('in_app_email');
      expect(resendCalls.length - before).toBe(1);
      const app = db.gp_applications.find((a) => a.id === 'app-3');
      expect(app.practice_submission_status).toBe('submitted_to_practice');
    } finally {
      db.integration_connections.length = 0;
    }
  });

  it('an app WITH zoho ids and no connection row also submits in-app', async () => {
    const before = resendCalls.length;
    const r = await submitApp('app-7');
    expect(r.status).toBe(200);
    expect(r.body.submission_mode).toBe('in_app_email');
    expect(resendCalls.length - before).toBe(1);
    const app = db.gp_applications.find((a) => a.id === 'app-7');
    expect(app.practice_submission_status).toBe('submitted_to_practice');
  });
});

describe('kanban not_proceeding → conservative client_rejected mapping', () => {
  it("sets client_rejected when the card was previously submitted_to_practice", async () => {
    const r = await adminPatch('/api/ats/application?id=app-5', { stage: 'not_proceeding' });
    expect(r.status).toBe(200);
    const app = db.gp_applications.find((a) => a.id === 'app-5');
    expect(app.ats_stage).toBe('not_proceeding');
    expect(app.practice_submission_status).toBe('client_rejected');
  });

  it('leaves practice_submission_status alone when the card was NOT submitted', async () => {
    const r = await adminPatch('/api/ats/application?id=app-6', { stage: 'not_proceeding' });
    expect(r.status).toBe(200);
    const app = db.gp_applications.find((a) => a.id === 'app-6');
    expect(app.ats_stage).toBe('not_proceeding');
    expect(app.practice_submission_status).toBe('pending_va_submission'); // untouched
  });
});

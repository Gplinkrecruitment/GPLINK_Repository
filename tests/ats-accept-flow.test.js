// Task 12 — practice-accept trigger: reveal identity + record offer + confetti
// congrats + "Secure My Interview" email.
//
// Boots the real server against the same in-memory PostgREST emulator pattern
// as tests/ats-offer-flow.test.js. Outbound email (Resend) and Web Push (J1) are
// captured by wrapping global fetch.
//
// Covers:
//  1. POST /api/ats/application/accept → gp_applications.revealed=true +
//     practice_submission_status='client_approved', an ats_offers row (status
//     'sent', billing_split from the role's intake), stage → 'offer' (actor
//     'practice_accept'). Owner (2026-07-23): the congratulations-and-book email
//     no longer fires here — it is DEFERRED until the practice's interview times
//     exist (maybeSendInterviewBookingInvite), so the GP can book from it.
//  2. Idempotent second call → {ok:true, already:true}, no duplicate email.
//  3. 404 for an unknown application id.
//  4. Admin apply (POST /api/ats/application) now writes origin:'admin_applied'
//     + revealed:true and creates its own offer record; the congrats email is
//     likewise DEFERRED until interview times exist.
//  5. GET /api/career/my-offer for the accepted application returns
//     revealed:true + interviewBookable:true + the real practice name; an
//     application that hasn't been accepted stays masked.
//  6. Once a scheduled_calls row is booked for the application, my-offer
//     flips interviewBookable to false and returns bookedInterview.
//  7. Hardening (review round): accept never regresses a 'hired' stage
//     (forward-only planAtsStageReconciliation); an accepted/declined offer
//     is never stomped back to 'sent'; practice_submission_status=
//     'client_approved' + an offer row also counts as already-processed.
//  8. Degraded env (gp_applications.revealed column missing — simulated by
//     the emulator; runs LAST because the missing-column determination is
//     cached process-wide): accept → 503 pipeline_migration_required with NO
//     offer/email side effects; admin apply still creates the application
//     but skips the offer + congrats email and reports degraded:true.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ats-accept-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const SUPER_HOST = 'ceo-accept.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const GP = { userId: 'u-acc-gp-1', email: 'gp-accept@gplink-test.local' };
const GP2 = { userId: 'u-acc-gp-2', email: 'other-accept@gplink-test.local' };
const GP3 = { userId: 'u-acc-gp-3', email: 'admin-placed@gplink-test.local' };
const GP4 = { userId: 'u-acc-gp-4', email: 'degraded-placed@gplink-test.local' };
// Owner 2026-10-27: accept WITH the agreed interview time — booked on the spot,
// no availability request to the practice.
const GP5 = { userId: 'u-acc-gp-5', email: 'manual-interview@gplink-test.local' };
// Owner 2026-10-27 (same evening): a double-posted accept booked twice and the
// doctor got every confirmation twice — two concurrent accepts must yield ONE
// booking and ONE set of messages.
const GP6 = { userId: 'u-acc-gp-6', email: 'race-interview@gplink-test.local' };
const RSO_ID = 'rso-accept-1';
const NOW = new Date().toISOString();

// When true the emulator rejects any gp_applications write that carries the
// `revealed` column with the Postgres undefined-column error — the
// pre-migration-20260705100000 schema.
let simulateRevealedMissing = false;

const resendCalls = [];
const fcmCalls = [];

const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Accepted', last_name: 'Doctor', registration_country: 'uk' },
    { user_id: GP2.userId, email: GP2.email, first_name: 'Other', last_name: 'Doctor', registration_country: 'ie' },
    { user_id: GP3.userId, email: GP3.email, first_name: 'Placed', last_name: 'Doctor', registration_country: 'nz' },
    { user_id: GP4.userId, email: GP4.email, first_name: 'Degraded', last_name: 'Doctor', registration_country: 'uk' },
    { user_id: GP5.userId, email: GP5.email, first_name: 'Manual', last_name: 'Doctor', registration_country: 'uk' },
    { user_id: GP6.userId, email: GP6.email, first_name: 'Race', last_name: 'Doctor', registration_country: 'uk' }
  ],
  user_state: [
    { user_id: GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW },
    { user_id: GP2.userId, state: { gp_onboarding_complete: true }, updated_at: NOW },
    { user_id: GP3.userId, state: { gp_onboarding_complete: true }, updated_at: NOW },
    { user_id: GP4.userId, state: { gp_onboarding_complete: true }, updated_at: NOW },
    { user_id: GP5.userId, state: { gp_onboarding_complete: true }, updated_at: NOW },
    { user_id: GP6.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }
  ],
  push_subscriptions: [
    { id: 'ps-acc-1', user_id: GP.userId, email: GP.email, endpoint: 'https://push.example.test/acc-1', p256dh: 'p256dh-acc-1', auth: 'auth-acc-1', created_at: NOW },
    { id: 'ps-acc-3', user_id: GP3.userId, email: GP3.email, endpoint: 'https://push.example.test/acc-3', p256dh: 'p256dh-acc-3', auth: 'auth-acc-3', created_at: NOW }
  ],
  notification_preferences: [],
  registration_cases: [
    { id: 'case-acc-1', user_id: GP.userId, status: 'active', assigned_rso: RSO_ID, assigned_va: null },
    { id: 'case-acc-2', user_id: GP2.userId, status: 'active', assigned_rso: null, assigned_va: null },
    { id: 'case-acc-3', user_id: GP3.userId, status: 'active', assigned_rso: RSO_ID, assigned_va: null },
    { id: 'case-acc-5', user_id: GP5.userId, status: 'active', assigned_rso: RSO_ID, assigned_va: null },
    { id: 'case-acc-6', user_id: GP6.userId, status: 'active', assigned_rso: RSO_ID, assigned_va: null }
  ],
  rso_team: [
    { user_id: RSO_ID, name: 'Priya Test', email: 'priya@gplink-test.local', phone: '', active: true, calendly_event_url: '' }
  ],
  practices: [
    { id: 'p1', name: 'Greenslopes Family Medical', source: 'internal_ats', contact_name: 'Anna Manager', contact_email: 'anna@greenslopes-test.local', is_active: true, created_at: NOW }
  ],
  career_roles: [
    {
      id: 'role-1', provider: 'internal_ats', provider_role_id: 'ats_r1', title: 'General Practitioner — VR',
      practice_name: 'Greenslopes Family Medical', practice_id: 'p1', location_city: 'Brisbane', location_state: 'QLD',
      is_active: true, job_status: 'open', updated_at: NOW,
      source_payload: { intake: { percentage_split: '65 / 35' } }
    }
  ],
  gp_applications: [
    { id: 'app-acc-1', user_id: GP.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'reviewing', applied_at: NOW, revealed: false, practice_submission_status: 'submitted_to_practice' },
    { id: 'app-acc-2', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'reviewing', applied_at: NOW, revealed: false, practice_submission_status: 'pending_va_submission' },
    // Owner 2026-10-27: accept + agreed interview time in one go.
    { id: 'app-acc-manual', user_id: GP5.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'reviewing', applied_at: NOW, revealed: false, practice_submission_status: 'submitted_to_practice' },
    // …and the same with the operator's own zone sent alongside (interview_tz).
    { id: 'app-acc-manual-tz', user_id: GP5.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'reviewing', applied_at: NOW, revealed: false, practice_submission_status: 'submitted_to_practice' },
    // Two accepts for THIS one fire at the same instant.
    { id: 'app-acc-race', user_id: GP6.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'reviewing', applied_at: NOW, revealed: false, practice_submission_status: 'submitted_to_practice' },
    // Hardening fixtures (review round):
    { id: 'app-acc-hired', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'ats_rh', status: 'placement_secured', ats_stage: 'hired', applied_at: NOW, revealed: false, practice_submission_status: 'submitted_to_practice' },
    { id: 'app-acc-stomp', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'ats_rs', status: 'offered', ats_stage: 'offer', applied_at: NOW, revealed: false, practice_submission_status: 'submitted_to_practice' },
    { id: 'app-acc-pss', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'ats_rp', status: 'applied', ats_stage: 'reviewing', applied_at: NOW, revealed: false, practice_submission_status: 'client_approved' },
    { id: 'app-acc-degraded', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'ats_rd', status: 'applied', ats_stage: 'reviewing', applied_at: NOW, revealed: false, practice_submission_status: 'submitted_to_practice' }
  ],
  ats_offers: [
    // The doctor already ACCEPTED this offer — a practice-accept click must never stomp it.
    { id: 'off-stomp-1', application_id: 'app-acc-stomp', user_id: GP2.userId, career_role_id: 'role-1', job_title: 'General Practitioner — VR', practice_name: 'Greenslopes Family Medical', status: 'accepted', sent_by: SUPER_EMAIL, sent_at: NOW, notes: 'Manual offer', created_at: NOW },
    // Pre-migration proxy: practice_submission_status='client_approved' + an offer row = already processed.
    { id: 'off-pss-1', application_id: 'app-acc-pss', user_id: GP2.userId, career_role_id: 'role-1', job_title: 'General Practitioner — VR', practice_name: 'Greenslopes Family Medical', status: 'sent', sent_by: SUPER_EMAIL, sent_at: NOW, notes: 'Prior accept (pre-migration)', created_at: NOW }
  ],
  ats_stage_events: [],
  user_documents: [],
  integration_connections: [],
  scheduled_calls: [],
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
    if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
      if (cell === null || cell === undefined) return false;
      const a = String(cell), b = String(val);
      const numeric = a !== '' && b !== '' && Number.isFinite(Number(a)) && Number.isFinite(Number(b));
      const cmp = numeric ? Number(a) - Number(b) : (a < b ? -1 : (a > b ? 1 : 0));
      return op === 'gt' ? cmp > 0 : op === 'gte' ? cmp >= 0 : op === 'lt' ? cmp < 0 : cmp <= 0;
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

      // Pre-migration-20260705100000 simulation: any gp_applications write
      // that carries the `revealed` column is rejected exactly like Postgres
      // rejects an undefined column through PostgREST.
      if (simulateRevealedMissing && table === 'gp_applications' && (req.method === 'PATCH' || req.method === 'POST')) {
        const wBody = await readBody(req);
        const wRows = Array.isArray(wBody) ? wBody : (wBody ? [wBody] : []);
        if (wRows.some((r) => r && Object.prototype.hasOwnProperty.call(r, 'revealed'))) {
          send(400, { code: '42703', message: 'column "revealed" of relation "gp_applications" does not exist', details: null, hint: null });
          return;
        }
        // Body already consumed — finish the write inline with the parsed rows.
        if (req.method === 'POST') {
          const conflictCol = u.searchParams.get('on_conflict');
          const saved = wRows.map((r) => {
            if (conflictCol) {
              const existing = rows.find((row) => row && String(row[conflictCol]) === String(r[conflictCol]));
              if (existing) { Object.assign(existing, r); return existing; }
            }
            const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
            rows.push(row);
            return row;
          });
          send(201, saved);
        } else {
          const matched = rows.filter(matches);
          matched.forEach((row) => Object.assign(row, wBody || {}));
          send(200, matched);
        }
        return;
      }

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

const atsPost = (p, body) => httpReq('POST', p, { host: SUPER_HOST, cookie: superCookie(), body });
// Ops-key call (x-gp-ops-key = the service-role key), the way a script hits
// the /api/admin/ops/* routes in production.
function opsPost(p, body, key) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Host: SUPER_HOST };
    if (key) headers['x-gp-ops-key'] = key;
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { let parsed = null; try { parsed = JSON.parse(Buffer.concat(c).toString('utf8')); } catch {} resolve({ status: res.statusCode, body: parsed }); });
    });
    r.on('error', reject); r.end(data);
  });
}
const gpGet = (p, who = GP) => httpReq('GET', p, { cookie: userCookie(who.email, who.userId) });

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ats-accept-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.ZOHO_RECRUIT_REDIRECT_URI = '';
  process.env.OPENAI_API_KEY = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = 'admin-accept.local';
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.VAPID_PUBLIC_KEY = 'test-vapid-public-key';
  process.env.VAPID_PRIVATE_KEY = 'test-vapid-private-key';
  process.env.VAPID_SUBJECT = 'mailto:hello@mygplink.com.au';

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
  serverModule.__testUtils.__setWebPushSendForTests(async (subscription, payload) => {
    let parsed = null; try { parsed = JSON.parse(payload); } catch {}
    fcmCalls.push({ endpoint: subscription.endpoint, body: parsed });
    return { statusCode: 201 };
  });
  const { createServer } = serverModule;
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('POST /api/ats/application/accept', () => {
  it('404s an unknown application', async () => {
    const r = await atsPost('/api/ats/application/accept?id=nope-1');
    expect(r.status).toBe(404);
  });

  it('reveals identity, records the offer, advances the stage — and DEFERS the congrats email until interview times exist', async () => {
    // Owner (2026-07-23): the congratulations-and-book email must fire ONLY once
    // the practice's interview availability exists (so the GP can book straight
    // from it). A staff accept records the acceptance (reveal + offer + stage)
    // but no times yet, so maybeSendInterviewBookingInvite correctly skips — no
    // email, no push. The email lands later, from the availability moment.
    const before = resendCalls.length;
    const fcmBefore = fcmCalls.length;
    const r = await atsPost('/api/ats/application/accept?id=app-acc-1');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.already).toBeFalsy();

    const app = db.gp_applications.find((a) => a.id === 'app-acc-1');
    expect(app.revealed).toBe(true);
    expect(app.practice_submission_status).toBe('client_approved');

    const offer = db.ats_offers.find((o) => o.application_id === 'app-acc-1');
    expect(offer).toBeTruthy();
    expect(offer.status).toBe('sent');
    expect(offer.billing_split).toBe('65 / 35');
    expect(offer.practice_name).toBe('Greenslopes Family Medical');
    expect(offer.notes).toBe('Practice accepted — interview invitation');
    expect(offer.user_id).toBe(GP.userId);

    // Owner call 2026-07-28: the practice accepting means "we want to
    // interview this doctor" — the record above IS the interview invitation
    // (note its own notes field: "Practice accepted — interview invitation")
    // and the very next step waits on the practice's interview times. 'offer'
    // is now reserved for a real job offer, set when the contract goes out.
    // This also brings the staff route into line with the practice's own
    // decision endpoint, which already targeted 'interview'.
    expect(app.ats_stage).toBe('interview');
    const ev = db.ats_stage_events.find((e) => e.application_id === 'app-acc-1' && e.actor === 'practice_accept');
    expect(ev).toBeTruthy();
    expect(ev.to_stage).toBe('interview');

    // No congrats email or push at accept time — it waits for the times.
    const sends = resendCalls.slice(before);
    expect(sends.length).toBe(0);
    expect(fcmCalls.length).toBe(fcmBefore);
  });

  it('is idempotent on a second call (already revealed + offer on file)', async () => {
    const before = resendCalls.length;
    const beforeOffers = db.ats_offers.length;
    const r = await atsPost('/api/ats/application/accept?id=app-acc-1');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.already).toBe(true);
    expect(db.ats_offers.length).toBe(beforeOffers);
    expect(resendCalls.length).toBe(before);
  });
});

describe('GET /api/career/my-offer — reveal + interviewBookable', () => {
  it('reveals the real practice name and marks the interview bookable once accepted', async () => {
    const r = await gpGet('/api/career/my-offer?applicationId=app-acc-1');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.revealed).toBe(true);
    expect(r.body.practiceName).toBe('Greenslopes Family Medical');
    expect(r.body.interviewBookable).toBe(true);
    expect(r.body.bookedInterview).toBe(null);
  });

  it('stays masked for an application the practice has not accepted', async () => {
    const r = await gpGet('/api/career/my-offer?applicationId=app-acc-2', GP2);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // No offer exists yet for app-acc-2, so my-offer reports offer:null.
    expect(r.body.offer).toBe(null);
  });

  it('flips interviewBookable to false and returns bookedInterview once a slot is booked', async () => {
    db.scheduled_calls.push({
      id: 'call-acc-1', application_id: 'app-acc-1', meeting_kind: 'interview', status: 'booked',
      scheduled_at: '2026-08-01T04:00:00.000Z', zoom_join_url: 'https://zoom.us/j/acc-test-1', created_at: NOW
    });
    const r = await gpGet('/api/career/my-offer?applicationId=app-acc-1');
    expect(r.status).toBe(200);
    expect(r.body.interviewBookable).toBe(false);
    expect(r.body.bookedInterview).toEqual({ scheduled_at: '2026-08-01T04:00:00.000Z', zoom_join_url: 'https://zoom.us/j/acc-test-1' });
  });
});

describe('Admin apply (POST /api/ats/application) auto-reveals + records offer (congrats deferred to times)', () => {
  it('creates the application with origin admin_applied + revealed:true, records an offer, and DEFERS the congrats email until interview times exist', async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/application', { user_id: GP3.userId, career_role_id: 'role-1' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.already).toBe(false);
    const appId = r.body.application.id;

    const app = db.gp_applications.find((a) => a.id === appId);
    expect(app).toBeTruthy();
    expect(app.origin).toBe('admin_applied');
    expect(app.revealed).toBe(true);

    const offer = db.ats_offers.find((o) => o.application_id === String(appId));
    expect(offer).toBeTruthy();
    expect(offer.status).toBe('sent');
    expect(offer.notes).toBe('Admin placed this GP with the practice');
    expect(offer.user_id).toBe(GP3.userId);

    // Owner (2026-07-23): no congrats email at admin-apply time — the practice's
    // interview availability doesn't exist yet, so the booking invite is deferred.
    const sends = resendCalls.slice(before);
    expect(sends.length).toBe(0);

    // The GP still sees the revealed, interview-bookable offer straight away.
    const my = await gpGet('/api/career/my-offer?applicationId=' + appId, GP3);
    expect(my.body.revealed).toBe(true);
    expect(my.body.interviewBookable).toBe(true);
    expect(my.body.practiceName).toBe('Greenslopes Family Medical');
  });
});

// Owner 2026-10-27: "I should be able to approve manually and have the option
// to also enter the interview date, which then bypasses the email sent asking
// for interview availabilities." The accept takes an optional wall-clock time
// (interview_local, the datetime-local shape) plus the zone it was typed in
// (interview_tz — the operator's CURRENT browser zone: "always local time for
// me, dynamic, as I travel a lot") and books the interview on the spot — no
// "Interview availability — Dr …" request to the practice, no "your times are
// ready" invite to the doctor; both get the booking confirmation instead.
// Without interview_tz (API callers) the practice's zone applies: role-1 sits
// in Brisbane (QLD, no DST), so 10:00 practice-local is 00:00Z on the same
// date. With interview_tz Asia/Tokyo (UTC+9, no DST) 10:00 is 01:00Z.
describe('accept WITH the agreed interview time — books it, skips the availability request', () => {
  const inTenDays = new Date(Date.now() + 10 * 86400000);
  const ymd = inTenDays.toISOString().slice(0, 10);
  const interviewLocal = ymd + 'T10:00';
  const expectedUtc = ymd + 'T00:00:00.000Z';
  const expectedTokyoUtc = ymd + 'T01:00:00.000Z';
  const manualApp = () => db.gp_applications.find((a) => a.id === 'app-acc-manual');
  const manualCalls = () => db.scheduled_calls.filter((s) => s.application_id === 'app-acc-manual' && s.meeting_kind === 'interview');
  const tzApp = () => db.gp_applications.find((a) => a.id === 'app-acc-manual-tz');
  const tzCalls = () => db.scheduled_calls.filter((s) => s.application_id === 'app-acc-manual-tz' && s.meeting_kind === 'interview');

  it('refuses a sent-but-unreadable interview_tz with 400 and writes nothing — never re-anchors onto the wrong hour', async () => {
    const r = await atsPost('/api/ats/application/accept?id=app-acc-manual-tz', { interview_local: interviewLocal, interview_tz: 'Mars/OlympusMons' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_interview_time');
    expect(String(r.body.message)).toContain('timezone');
    expect(tzApp().revealed).toBe(false);
    expect(tzCalls().length).toBe(0);
  });

  it("books at the OPERATOR's local time when interview_tz is sent (10:00 Tokyo = 01:00Z), labels in that zone", async () => {
    const r = await atsPost('/api/ats/application/accept?id=app-acc-manual-tz', { interview_local: interviewLocal, interview_tz: 'Asia/Tokyo' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.interview.ok).toBe(true);
    expect(r.body.interview.scheduled_at).toBe(expectedTokyoUtc);
    // The toast reads back what was typed, in the typist's zone …
    expect(String(r.body.interview.when_label)).toContain('10:00');
    expect(String(r.body.interview.when_label)).toMatch(/GMT\+9|JST/);
    // … and the practice's clock is given too (Brisbane is UTC+10 → 11:00).
    expect(String(r.body.interview.practice_when_label)).toContain('11:00');
    expect(tzApp().revealed).toBe(true);
    expect(tzCalls().length).toBe(1);
    expect(tzCalls()[0].status).toBe('booked');
    expect(tzCalls()[0].scheduled_at).toBe(expectedTokyoUtc);
  });

  it('refuses an unreadable time with 400 and writes nothing', async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/application/accept?id=app-acc-manual', { interview_local: 'next tuesday 10am' });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toBe('invalid_interview_time');
    expect(manualApp().revealed).toBe(false);
    expect(manualApp().practice_submission_status).toBe('submitted_to_practice');
    expect(db.ats_offers.some((o) => o.application_id === 'app-acc-manual')).toBe(false);
    expect(manualCalls().length).toBe(0);
    expect(resendCalls.length).toBe(before);
  });

  it('refuses a time in the past with 400 and writes nothing', async () => {
    const r = await atsPost('/api/ats/application/accept?id=app-acc-manual', { interview_local: '2020-01-06T10:00' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_interview_time');
    expect(manualApp().revealed).toBe(false);
    expect(manualCalls().length).toBe(0);
  });

  it('records the acceptance AND books the interview (no interview_tz → practice-local fallback) — confirmations out, no availability request', async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/application/accept?id=app-acc-manual', { interview_local: interviewLocal });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.already).toBe(false);
    expect(r.body.interview).toBeTruthy();
    expect(r.body.interview.ok).toBe(true);
    expect(r.body.interview.already).toBe(false);
    expect(r.body.interview.scheduled_at).toBe(expectedUtc);
    expect(String(r.body.interview.when_label)).toContain('10:00');

    // The acceptance itself — exactly what the classic click records.
    const app = manualApp();
    expect(app.revealed).toBe(true);
    expect(app.practice_submission_status).toBe('client_approved');
    expect(app.ats_stage).toBe('interview');
    expect(db.ats_stage_events.some((e) => e.application_id === 'app-acc-manual' && e.actor === 'practice_accept' && e.to_stage === 'interview')).toBe(true);
    // Booking IS acceptance (owner rule 2026-07-23): the invitation offer flips
    // to accepted and the application reads interview_scheduled — the doctor
    // is never asked to pick a time.
    expect(app.status).toBe('interview_scheduled');
    const offer = db.ats_offers.find((o) => o.application_id === 'app-acc-manual');
    expect(offer).toBeTruthy();
    expect(offer.status).toBe('accepted');
    expect(app.booking_invite_sent_at).toBeFalsy();

    // The interview row: created by the accept itself, booked at the typed time.
    const calls = manualCalls();
    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call.status).toBe('booked');
    expect(call.scheduled_at).toBe(expectedUtc);
    expect(call.created_by).toBe('practice_accept');
    expect(call.host_kind).toBe('ceo');
    expect(call.correlation_token).toBeTruthy();
    expect(call.user_id).toBe(GP5.userId);

    // Emails: the booking confirmations to the doctor and the practice — and
    // NOT the "Interview availability — Dr …" request to the practice.
    const sends = resendCalls.slice(before).map((c) => c.body || {});
    const subjects = sends.map((b) => String(b.subject || ''));
    expect(subjects.some((s) => /^Interview availability/.test(s))).toBe(false);
    const gpMail = sends.find((b) => String(b.subject || '').startsWith('Your interview is confirmed'));
    expect(gpMail).toBeTruthy();
    expect([].concat(gpMail.to)).toContain(GP5.email);
    const practiceMail = sends.find((b) => String(b.subject || '').startsWith('Interview confirmed, '));
    expect(practiceMail).toBeTruthy();
    expect([].concat(practiceMail.to)).toContain('anna@greenslopes-test.local');
  });

  it('a second accept with a time is idempotent — the existing booking comes back, nothing is rewritten or re-sent', async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/application/accept?id=app-acc-manual', { interview_local: ymd + 'T15:00' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.already).toBe(true);
    expect(r.body.interview.ok).toBe(true);
    expect(r.body.interview.already).toBe(true);
    expect(r.body.interview.scheduled_at).toBe(expectedUtc); // the ORIGINAL time, not 15:00
    expect(manualCalls().length).toBe(1);
    expect(manualCalls()[0].scheduled_at).toBe(expectedUtc);
    expect(resendCalls.length).toBe(before);
  });

  it('the classic accept (no body) is untouched — no interview row, no booking', async () => {
    // app-acc-1 was accepted earlier in this file without a time.
    expect(db.scheduled_calls.filter((s) => s.application_id === 'app-acc-1' && s.created_by === 'practice_accept').length).toBe(0);
  });

  it("both CEO drawers offer the optional time in the operator's CURRENT device zone and post interview_local + interview_tz", () => {
    const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
    const cand = read('js/ceo-ats-candidates.js');
    expect(cand).toContain('function openAcceptForm');
    expect(cand).toContain('class="ats-accept-when"');
    expect(cand).toContain('type="datetime-local"');
    // The zone is read from the browser at render time (never a stored
    // setting) — the owner travels, so the form must follow the laptop.
    expect(cand).toContain('Intl.DateTimeFormat().resolvedOptions().timeZone');
    expect(cand).toMatch(/function openAcceptForm[\s\S]{0,1200}your local time/);
    expect(cand).toMatch(/function acceptApplication\(appId, c\)[\s\S]{0,2500}interview_local: interviewLocal, interview_tz: tz\.name/);
    expect(cand).not.toMatch(/localStorage[\s\S]{0,80}(tz|timezone)/i);
    expect(cand).toContain("closest('.ats-accept-confirm')");
    expect(cand).toContain("closest('.ats-accept-cancel')");
    const jobs = read('js/ceo-ats-jobs.js');
    expect(jobs).toContain('id="atsJobAcceptWhen"');
    expect(jobs).toContain('Intl.DateTimeFormat().resolvedOptions().timeZone');
    expect(jobs).toMatch(/function onAcceptApplication\(\)[\s\S]{0,2500}interview_local: interviewLocal, interview_tz: tz\.name/);
    // Both scripts changed → both cache keys bumped (and the CSS key may never
    // fall behind the candidates key — see tests/ats-endpoints.test.js).
    const html = read('pages/ceo-dashboard.html');
    expect(html).toContain('/js/ceo-ats-candidates.js?v=20261029a');
    expect(html).toContain('/js/ceo-ats-jobs.js?v=20261029a');
    expect(html).toContain('/css/ceo-ats.css?v=20261029a');
  });
});

// Owner 2026-10-27, same evening: "why was she sent the doubletick message
// twice at the same time?" Production showed ONE interview row but TWO full
// accept-and-book runs 0.8 s apart (two 'practice_accept' stage events, two
// booking stage events 6 ms apart): the candidate drawer re-renders into the
// same panel element and used to ADD another delegated click listener on every
// render, so one click ran N handlers → N confirm dialogs → N POSTs. Both
// requests passed the already-booked check before either had saved, so both
// created a Zoom meeting and both sent every confirmation. Two fixes, both
// pinned here: the drawer replaces its listener instead of stacking, and the
// booking write is conditional (status=neq.booked) so only ONE concurrent
// request can win — the loser cleans up its Zoom/GCal and sends nothing.
describe('two accepts for the same interview at the same instant book ONCE and message ONCE', () => {
  const ymd = new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10);
  const raceApp = () => db.gp_applications.find((a) => a.id === 'app-acc-race');
  const raceCalls = () => db.scheduled_calls.filter((s) => s.application_id === 'app-acc-race' && s.meeting_kind === 'interview' && s.status !== 'cancelled');

  it('exactly one booked row, exactly one set of confirmations, the loser reports already:true', async () => {
    const before = resendCalls.length;
    const body = { interview_local: ymd + 'T09:30', interview_tz: 'Asia/Tokyo' };
    const [r1, r2] = await Promise.all([
      atsPost('/api/ats/application/accept?id=app-acc-race', body),
      atsPost('/api/ats/application/accept?id=app-acc-race', body)
    ]);
    for (const r of [r1, r2]) {
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.interview).toBeTruthy();
      expect(r.body.interview.ok).toBe(true);
      expect(r.body.interview.scheduled_at).toBe(ymd + 'T00:30:00.000Z');
    }
    // One of the two actually booked; the other was told it was already done.
    const fresh = [r1, r2].filter((r) => r.body.interview.already === false);
    const dup = [r1, r2].filter((r) => r.body.interview.already === true);
    expect(fresh.length).toBe(1);
    expect(dup.length).toBe(1);

    // ONE interview row for the application, booked at the typed time — the
    // duplicate row (if both inserted) was converged away.
    const rows = raceCalls();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('booked');
    expect(rows[0].scheduled_at).toBe(ymd + 'T00:30:00.000Z');
    expect(raceApp().revealed).toBe(true);
    expect(raceApp().status).toBe('interview_scheduled');

    // ONE confirmation to the doctor and ONE to the practice — not two.
    const sends = resendCalls.slice(before).map((c) => c.body || {});
    const gpConfirms = sends.filter((b) => String(b.subject || '').startsWith('Your interview is confirmed') && [].concat(b.to).includes(GP6.email));
    expect(gpConfirms.length).toBe(1);
    const practiceConfirms = sends.filter((b) => String(b.subject || '') === 'Interview confirmed, Race Doctor');
    expect(practiceConfirms.length).toBe(1);
  });

  it('the drawer replaces its delegated listeners instead of stacking one per render', () => {
    const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
    const cand = read('js/ceo-ats-candidates.js');
    expect(cand).toContain("if (host.__atsDetailClick) host.removeEventListener('click', host.__atsDetailClick);");
    expect(cand).toContain("host.addEventListener('click', host.__atsDetailClick = function (e) {");
    expect(cand).toContain("if (host.__atsDetailChange) host.removeEventListener('change', host.__atsDetailChange);");
    expect(cand).toContain("host.addEventListener('change', host.__atsDetailChange = function (e) {");
    // No other bare delegated listener on the panel is added per render.
    expect(cand.match(/host\.addEventListener\('(click|change)', function/g)).toBeNull();
    const html = read('pages/ceo-dashboard.html');
    expect(html).toContain('/js/ceo-ats-candidates.js?v=20261029a');
    expect(html).toContain('/css/ceo-ats.css?v=20261029a');
  });

  it('the booking write is conditional and every booking caller handles the loser', () => {
    const srv = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    expect(srv).toContain("'id=eq.' + encodeURIComponent(meetingRow.id) + '&status=neq.booked'");
    expect(srv).toMatch(/&status=neq\.booked', \{\s*method: 'PATCH', headers: \{ Prefer: 'return=representation' \}/);
    expect(srv).toContain("throw _interviewAlreadyBookedError(meetingRow.id);");
    expect(srv).toContain("if (bookErr && bookErr.code === 'already_booked') {");
    // The three callers: staff accept-with-time, staff slot book, GP self-book.
    expect(srv).toContain("if (booked && booked.error === 'already_booked') {");
    expect(srv).toContain("if (bkBooked.error === 'already_booked') {");
    expect(srv).toContain("if (cbBooked.error === 'already_booked') {");
    // And the interview-row creator converges a racing duplicate insert.
    expect(srv).toContain('return await _dedupeInterviewRowForApplication(appId, saved);');
  });

  it('the congratulations stamp, the re-send claim and both accept buttons are one-shot too', () => {
    const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
    const srv = read('server.js');
    // maybeSendInterviewBookingInvite: the one-shot stamp is a conditional write.
    expect(srv).toContain("'id=eq.' + encodeURIComponent(id) + '&booking_invite_sent_at=is.null'");
    expect(srv).toContain("if (stamped === 'already_sent') return { ok: false, skipped: 'already_sent' };");
    // resend-interview-confirmation: claim the cooldown slot BEFORE sending, never on a dry run.
    expect(srv).toContain("base + '&invite_sent_at=is.null'");
    expect(srv).toContain("base + '&invite_sent_at=lt.' + encodeURIComponent(cutoffIso)");
    expect(srv).toContain("if (rlClaim.status === 'recently_resent') {");
    expect(srv).toMatch(/if \(!rlDryRun\) \{\s*rlClaim = await claimInterviewResendSlot\(rlRow, rlForce\);/);
    // Both CEO drawers disable their accept button for the whole round trip.
    const jobs = read('js/ceo-ats-jobs.js');
    expect(jobs).toContain('if (acceptBtn && acceptBtn.disabled) return;');
    expect(jobs).toContain("acceptBtn.disabled = true; acceptBtn.textContent = interviewLocal ? 'Booking…' : 'Recording…';");
    const cand = read('js/ceo-ats-candidates.js');
    expect(cand).toContain("if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = interviewLocal ? 'Booking…' : 'Recording…'; }");
    expect(read('pages/ceo-dashboard.html')).toContain('/js/ceo-ats-jobs.js?v=20261029a');
  });
});

// Owner 2026-10-27, after the double booking: "send a new notification through
// all the channels saying to ignore the previous email and use the link in
// this one". POST /api/admin/ops/resend-interview-confirmation re-sends the
// booking confirmation with the link STORED on the interview row (never a
// fresh Zoom meeting), to the doctor and the practice, with an updated
// calendar invite (same UID, SEQUENCE 1) that replaces the earlier event's
// link. Ops-key or admin-session gated; dry_run echoes the plan and sends
// nothing. app-acc-manual was booked earlier in this file.
describe('ops: re-send the interview link (POST /api/admin/ops/resend-interview-confirmation)', () => {
  const OPS_KEY = 'test-service-role-key';
  const LINK = 'https://us06web.zoom.us/j/88443739580?pwd=test';
  const bookedRow = () => db.scheduled_calls.find((s) => s.application_id === 'app-acc-manual' && s.meeting_kind === 'interview' && s.status === 'booked');

  it('refuses without the ops key or an admin session', async () => {
    const r = await opsPost('/api/admin/ops/resend-interview-confirmation', { application_id: 'app-acc-manual' }, '');
    expect([401, 403]).toContain(r.status);
  });

  it('409s an application with no booked interview, 404s an unknown one', async () => {
    const r1 = await opsPost('/api/admin/ops/resend-interview-confirmation', { application_id: 'app-acc-2', dry_run: true }, OPS_KEY);
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe('not_booked');
    const r2 = await opsPost('/api/admin/ops/resend-interview-confirmation', { application_id: 'nope-9', dry_run: true }, OPS_KEY);
    expect(r2.status).toBe(404);
  });

  it('dry_run echoes the stored link, both times and both recipients — and sends nothing', async () => {
    const row = bookedRow();
    expect(row).toBeTruthy();
    row.zoom_join_url = LINK; row.zoom_meeting_id = '88443739580';
    const before = resendCalls.length;
    const r = await opsPost('/api/admin/ops/resend-interview-confirmation', { application_id: 'app-acc-manual', dry_run: true }, OPS_KEY);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.dry_run).toBe(true);
    expect(r.body.link).toBe(LINK);
    expect(r.body.meeting_id).toBe('884 4373 9580');
    expect(r.body.scheduled_at).toBe(row.scheduled_at);
    expect(String(r.body.gp_when)).toMatch(/GMT|BST/);       // 00:00Z shown in the GP's zone (London)
    expect(String(r.body.practice_when)).toContain('10:00'); // Brisbane: 00:00Z = 10:00 am
    expect(r.body.recipients.gp.email).toMatch(/^m\*\*\*@/);
    expect(r.body.recipients.practice.email).toMatch(/^a\*\*\*@/);
    expect(resendCalls.length).toBe(before);
    expect(bookedRow().status).toBe('booked');
  });

  it('for real: one corrective email to the doctor and one to the practice, both carrying the stored link and an updated (SEQUENCE:1) invite; the row is untouched', async () => {
    const before = resendCalls.length;
    const rowBefore = JSON.stringify(bookedRow());
    const r = await opsPost('/api/admin/ops/resend-interview-confirmation', { application_id: 'app-acc-manual' }, OPS_KEY);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.dry_run).toBe(false);
    expect(r.body.sent.gp.email).toBe(true);
    expect(r.body.sent.practice.email).toBe(true);
    // No phone on the fixture (and no DoubleTick key in tests) → WhatsApp
    // reports why it was skipped, and never throws.
    expect(['no_phone', 'not_configured']).toContain(r.body.sent.gp.whatsapp.skipped);

    const sends = resendCalls.slice(before).map((c) => c.body || {});
    expect(sends.length).toBe(2);
    const gpMail = sends.find((b) => [].concat(b.to).includes(GP5.email));
    const prMail = sends.find((b) => [].concat(b.to).includes('anna@greenslopes-test.local'));
    expect(gpMail).toBeTruthy();
    expect(prMail).toBeTruthy();
    expect(gpMail.subject).toBe('Your interview link — please use this one');
    expect(prMail.subject).toBe('Interview link for Manual Doctor — please use this one');
    for (const m of [gpMail, prMail]) {
      expect(String(m.html)).toContain(LINK);
      expect(String(m.html)).toMatch(/(ignore|disregard) the earlier emails/);
      expect(String(m.html)).toContain('884 4373 9580');
      expect(String(m.html)).not.toContain('zoom.local');
      expect(Array.isArray(m.attachments) && m.attachments.length).toBe(1);
      const ics = Buffer.from(m.attachments[0].content, 'base64').toString('utf8');
      expect(ics).toContain('SEQUENCE:1');
      expect(ics).toContain('UID:gplink-interview-' + bookedRow().id + '@mygplink.com.au');
      expect(ics).toContain('METHOD:REQUEST');
    }
    expect(String(gpMail.html)).toContain('One link for your interview, Manual');
    expect(String(prMail.html)).toContain('disregard the earlier emails');
    // The booking itself is unchanged — the row only gained the cooldown
    // stamp (invite_sent_at / resend_count), which is what refuses a second
    // re-send inside the window below.
    const strip = (row) => { const c = Object.assign({}, row); delete c.invite_sent_at; delete c.resend_count; delete c.updated_at; return c; };
    expect(JSON.stringify(strip(bookedRow()))).toBe(JSON.stringify(strip(JSON.parse(rowBefore))));
    expect(typeof bookedRow().invite_sent_at).toBe('string');
    expect(bookedRow().resend_count).toBe(1);
    expect(r.body.resend_count).toBe(1);
  });

  // 2026-10-27 family: a double-click, a double-posted form or a retried
  // script must never deliver the corrective message twice. The claim is a
  // conditional write on the row, so it holds across concurrent requests.
  it('a second re-send inside the cooldown is refused (409 recently_resent) and sends nothing', async () => {
    const before = resendCalls.length;
    const r = await opsPost('/api/admin/ops/resend-interview-confirmation', { application_id: 'app-acc-manual' }, OPS_KEY);
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('recently_resent');
    expect(r.body.retry_after_seconds).toBeGreaterThan(0);
    expect(String(r.body.message)).toContain('nothing was sent');
    expect(String(r.body.message)).toContain('force:true');
    expect(resendCalls.length).toBe(before);
    expect(bookedRow().resend_count).toBe(1);
  });

  it('dry_run inside the cooldown still echoes the plan and never claims the slot', async () => {
    const before = resendCalls.length;
    const r = await opsPost('/api/admin/ops/resend-interview-confirmation', { application_id: 'app-acc-manual', dry_run: true }, OPS_KEY);
    expect(r.status).toBe(200);
    expect(r.body.dry_run).toBe(true);
    expect(r.body.link).toBe(LINK);
    expect(resendCalls.length).toBe(before);
    expect(bookedRow().resend_count).toBe(1);
  });

  it('force:true sends again inside the cooldown and re-stamps the row', async () => {
    const before = resendCalls.length;
    const r = await opsPost('/api/admin/ops/resend-interview-confirmation', { application_id: 'app-acc-manual', force: true }, OPS_KEY);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.resend_count).toBe(2);
    expect(resendCalls.length - before).toBe(2);
    expect(bookedRow().resend_count).toBe(2);
  });

  it('once the cooldown has passed a plain re-send is allowed again', async () => {
    bookedRow().invite_sent_at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const before = resendCalls.length;
    const r = await opsPost('/api/admin/ops/resend-interview-confirmation', { application_id: 'app-acc-manual' }, OPS_KEY);
    expect(r.status).toBe(200);
    expect(r.body.resend_count).toBe(3);
    expect(resendCalls.length - before).toBe(2);
    expect(Date.now() - Date.parse(bookedRow().invite_sent_at)).toBeLessThan(60 * 1000);
  });

  it('two re-sends fired together deliver ONE set of messages — the loser gets 409', async () => {
    bookedRow().invite_sent_at = null;
    const before = resendCalls.length;
    const [a, b] = await Promise.all([
      opsPost('/api/admin/ops/resend-interview-confirmation', { application_id: 'app-acc-manual' }, OPS_KEY),
      opsPost('/api/admin/ops/resend-interview-confirmation', { application_id: 'app-acc-manual' }, OPS_KEY)
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.code).toBe('recently_resent');
    // One corrective email to the doctor and one to the practice — not four.
    expect(resendCalls.length - before).toBe(2);
    expect(bookedRow().resend_count).toBe(4);
  });
});

describe('accept hardening (review round)', () => {
  it('never regresses a hired application back to the offer lane', async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/application/accept?id=app-acc-hired');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const app = db.gp_applications.find((a) => a.id === 'app-acc-hired');
    expect(app.ats_stage).toBe('hired'); // terminal lane never moves
    expect(app.revealed).toBe(true);      // the reveal itself still lands
    // No practice_accept stage event was written (no stage change happened).
    expect(db.ats_stage_events.some((e) => e.application_id === 'app-acc-hired' && e.actor === 'practice_accept')).toBe(false);
    // The offer record still lands (reveal itself succeeds) …
    expect(db.ats_offers.some((o) => o.application_id === 'app-acc-hired' && o.status === 'sent')).toBe(true);
    // … but no congrats email fires: this app is terminal (placement_secured)
    // AND has no interview times, so the booking invite correctly skips.
    expect(resendCalls.length - before).toBe(0);
  });

  it('never stomps an offer the doctor already accepted', async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/application/accept?id=app-acc-stomp');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.already).toBe(true);

    const offer = db.ats_offers.find((o) => o.application_id === 'app-acc-stomp');
    expect(offer.status).toBe('accepted');       // untouched
    expect(offer.notes).toBe('Manual offer');    // untouched
    const app = db.gp_applications.find((a) => a.id === 'app-acc-stomp');
    expect(app.revealed).toBe(false);            // no writes at all
    expect(resendCalls.length).toBe(before);     // no email
  });

  it("treats practice_submission_status='client_approved' + an offer row as already processed (pre-migration proxy)", async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/application/accept?id=app-acc-pss');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.already).toBe(true);

    const offer = db.ats_offers.find((o) => o.application_id === 'app-acc-pss');
    expect(offer.notes).toBe('Prior accept (pre-migration)'); // untouched
    expect(resendCalls.length).toBe(before);                  // no email
    expect(db.ats_stage_events.some((e) => e.application_id === 'app-acc-pss' && e.actor === 'practice_accept')).toBe(false);
  });
});

// LAST on purpose: once the server observes the missing `revealed` column it
// caches the determination (module flag) for the rest of the process.
describe('degraded env — gp_applications.revealed column missing (migration 20260705100000 not applied)', () => {
  it('accept fails loud with 503 pipeline_migration_required and NO side effects', async () => {
    simulateRevealedMissing = true;
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/application/accept?id=app-acc-degraded');
    expect(r.status).toBe(503);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toBe('pipeline_migration_required');

    const app = db.gp_applications.find((a) => a.id === 'app-acc-degraded');
    expect(app.revealed).toBe(false);
    expect(app.practice_submission_status).toBe('submitted_to_practice'); // no partial write
    expect(db.ats_offers.some((o) => o.application_id === 'app-acc-degraded')).toBe(false); // no offer
    expect(db.ats_stage_events.some((e) => e.application_id === 'app-acc-degraded' && e.actor === 'practice_accept')).toBe(false);
    expect(resendCalls.length).toBe(before); // no congrats email
  });

  it('a second accept 503s immediately off the cached determination', async () => {
    const r = await atsPost('/api/ats/application/accept?id=app-acc-degraded');
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('pipeline_migration_required');
  });

  it('admin apply still creates the application but skips the offer + congrats email (degraded:true)', async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/application', { user_id: GP4.userId, career_role_id: 'role-1' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.already).toBe(false);
    expect(r.body.degraded).toBe(true);
    const appId = r.body.application.id;

    const app = db.gp_applications.find((a) => a.id === appId);
    expect(app).toBeTruthy();                    // application still created
    expect(app.revealed).toBeUndefined();        // column dropped from the insert
    expect(db.ats_offers.some((o) => o.application_id === String(appId))).toBe(false); // no offer
    expect(resendCalls.length).toBe(before);     // no congrats email
  });
});

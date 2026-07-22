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
    { user_id: GP4.userId, email: GP4.email, first_name: 'Degraded', last_name: 'Doctor', registration_country: 'uk' }
  ],
  user_state: [
    { user_id: GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW },
    { user_id: GP2.userId, state: { gp_onboarding_complete: true }, updated_at: NOW },
    { user_id: GP3.userId, state: { gp_onboarding_complete: true }, updated_at: NOW },
    { user_id: GP4.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }
  ],
  push_subscriptions: [
    { id: 'ps-acc-1', user_id: GP.userId, email: GP.email, endpoint: 'https://push.example.test/acc-1', p256dh: 'p256dh-acc-1', auth: 'auth-acc-1', created_at: NOW },
    { id: 'ps-acc-3', user_id: GP3.userId, email: GP3.email, endpoint: 'https://push.example.test/acc-3', p256dh: 'p256dh-acc-3', auth: 'auth-acc-3', created_at: NOW }
  ],
  notification_preferences: [],
  registration_cases: [
    { id: 'case-acc-1', user_id: GP.userId, status: 'active', assigned_rso: RSO_ID, assigned_va: null },
    { id: 'case-acc-2', user_id: GP2.userId, status: 'active', assigned_rso: null, assigned_va: null },
    { id: 'case-acc-3', user_id: GP3.userId, status: 'active', assigned_rso: RSO_ID, assigned_va: null }
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

    expect(app.ats_stage).toBe('offer');
    const ev = db.ats_stage_events.find((e) => e.application_id === 'app-acc-1' && e.actor === 'practice_accept');
    expect(ev).toBeTruthy();
    expect(ev.to_stage).toBe('offer');

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

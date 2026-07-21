// Task B, in-app offer flow (send → doctor sees the real offer).
//
// Boots the real server against the in-memory PostgREST emulator pattern from
// tests/ats-consultant-access.test.js / tests/career-internal-apply.test.js.
// Outbound email (Resend) is captured by wrapping global fetch; Web Push (J1)
// sends are captured via the __setWebPushSendForTests hook, so the "exactly
// ONE GP email per send" invariant is asserted for real.
//
// Covers:
//  1. POST /api/ats/offer → offer persisted (ats_offers table), stage → 'offer'
//     (actor 'offer_sent' audit row), exactly ONE GP email deep-linking to
//     /pages/offer-review?applicationId=… + a push, and GET /api/ats/offer.
//  2. GP GET /api/career/my-offer returns their own offer with practice/role/
//     officer context; 401 unauthenticated; 404 for someone else's application;
//     offer:null when no offer exists.
//  3. PATCH withdraw → status 'withdrawn', stage back to 'reviewing', NO new
//     GP email, and my-offer stops showing the offer.
//  4. Contract data-URL delivery → user_documents offer_contract row written,
//     with the per-document delivery email suppressed (still one email/send).
//  5. runtime_kv fallback: with the ats_offers table missing (PGRST205), the
//     offer persists via `ats_offer:{id}` + `ats_offers_index` keys and both
//     the ATS GET and the GP my-offer keep working. Runs LAST, the store
//     caches the missing-table determination for the process lifetime.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ats-offer-${RUN_ID}.json`);
let server, port;          // app under test
let sbServer, sbPort;      // Supabase (PostgREST) emulator

const SUPER_HOST = 'ceo-offer.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const GP = { userId: 'u-gp-1', email: 'gp@gplink-test.local' };
const GP2 = { userId: 'u-gp-2', email: 'other@gplink-test.local' };
const RSO_ID = 'rso-hazel-1';
const NOW = new Date().toISOString();

// When true the emulator answers every /rest/v1/ats_offers request with the
// PostgREST "table not in schema cache" error, the un-applied-migration case.
let simulateMissingAtsOffers = false;

// Captured outbound calls. Push sends land in fcmCalls via the web-push test
// hook (J1 replaced the legacy FCM fetch path with VAPID Web Push).
const resendCalls = [];
const fcmCalls = [];

// ── In-memory PostgREST emulator ────────────────────────────────────────────
const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Test', last_name: 'Doctor', registration_country: 'uk' },
    { user_id: GP2.userId, email: GP2.email, first_name: 'Other', last_name: 'Doctor', registration_country: 'ie' }
  ],
  user_state: [
    { user_id: GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW },
    { user_id: GP2.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }
  ],
  push_subscriptions: [
    { id: 'ps-1', user_id: GP.userId, email: GP.email, endpoint: 'https://push.example.test/gp-1', p256dh: 'p256dh-gp-1', auth: 'auth-gp-1', created_at: NOW }
  ],
  notification_preferences: [],
  registration_cases: [
    { id: 'case-1', user_id: GP.userId, status: 'active', assigned_rso: RSO_ID, assigned_va: null },
    { id: 'case-2', user_id: GP2.userId, status: 'active', assigned_rso: null, assigned_va: null }
  ],
  rso_team: [
    { user_id: RSO_ID, name: 'Hazel Test', email: 'hazel@gplink-test.local', phone: '', active: true, calendly_event_url: '' }
  ],
  practices: [
    { id: 'p1', name: 'Greenslopes Family Medical', source: 'internal_ats', contact_name: 'Anna Manager', contact_email: 'anna@greenslopes-test.local', is_active: true, created_at: NOW }
  ],
  career_roles: [
    { id: 'role-1', provider: 'internal_ats', provider_role_id: 'ats_r1', title: 'General Practitioner, VR', practice_name: 'Greenslopes Family Medical', practice_id: 'p1', location_city: 'Brisbane', location_state: 'QLD', is_active: true, job_status: 'open', updated_at: NOW }
  ],
  gp_applications: [
    { id: 'app-1', user_id: GP.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'reviewing', applied_at: NOW },
    { id: 'app-2', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'reviewing', applied_at: NOW },
    { id: 'app-3', user_id: GP.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'interview', applied_at: NOW },
    // Kanban drag target (F1: a bare move into the Offer lane must be silent).
    { id: 'app-drag-1', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'reviewing', applied_at: NOW },
    // Zoho-managed app (F4: in-app offers blocked while a connection exists).
    { id: 'app-z1', user_id: GP.userId, career_role_id: 'role-1', provider_role_id: 'z-job-1', zoho_application_id: 'z-app-1', zoho_candidate_id: 'z-cand-1', status: 'offered', ats_stage: 'interview', applied_at: NOW }
  ],
  ats_offers: [],
  ats_stage_events: [],
  user_documents: [],
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
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const table = decodeURIComponent(m[1]);
      if (table === 'ats_offers' && simulateMissingAtsOffers) {
        send(404, { code: 'PGRST205', message: "Could not find the table 'public.ats_offers' in the schema cache", details: null, hint: null });
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
const atsGet = (p) => httpReq('GET', p, { host: SUPER_HOST, cookie: superCookie() });
const atsPatch = (p, body) => httpReq('PATCH', p, { host: SUPER_HOST, cookie: superCookie(), body });
const gpGet = (p, who = GP) => httpReq('GET', p, { cookie: userCookie(who.email, who.userId) });

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ats-offer-secret-' + RUN_ID;
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
  process.env.ADMIN_ALLOWED_HOSTS = 'admin-offer.local';
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = '';
  // Real email + push config so the notification legs actually run, the
  // wrapped fetch + web-push test hook below capture them instead of
  // hitting the network.
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

describe('POST /api/ats/offer, send (table mode)', () => {
  it('persists the offer, advances the stage and notifies the GP exactly once', async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/offer', {
      application_id: 'app-1',
      billing_split: '70 / 30',
      sessions_per_week: '8',
      compensation_range: '$350k+ estimated',
      start_date: '2026-08-03',
      notes: 'Includes 4 weeks leave and relocation help.'
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.offer.status).toBe('sent');
    expect(r.body.offer.sent_by).toBe(SUPER_EMAIL);

    // Row persisted in the ats_offers table.
    const saved = db.ats_offers.find((o) => o.application_id === 'app-1');
    expect(saved).toBeTruthy();
    expect(saved.billing_split).toBe('70 / 30');
    expect(saved.job_title).toBe('General Practitioner, VR');
    expect(saved.practice_name).toBe('Greenslopes Family Medical');
    expect(saved.user_id).toBe(GP.userId);

    // Kanban advanced with the dedicated actor (audit row).
    const app = db.gp_applications.find((a) => a.id === 'app-1');
    expect(app.ats_stage).toBe('offer');
    const ev = db.ats_stage_events.find((e) => e.application_id === 'app-1' && e.to_stage === 'offer');
    expect(ev).toBeTruthy();
    expect(ev.actor).toBe('offer_sent');

    // Exactly ONE GP email, the dedicated offer email, deep-linked to the
    // offer page (the generic Task-5 stage email must NOT also fire).
    const sends = resendCalls.slice(before);
    expect(sends.length).toBe(1);
    expect(sends[0].body.to).toContain(GP.email);
    expect(String(sends[0].body.subject)).toMatch(/offer/i);
    expect(String(sends[0].body.html)).toContain('/pages/offer-review?applicationId=app-1');

    // Push notification attempted for the GP's Web Push subscription.
    expect(fcmCalls.length).toBeGreaterThan(0);
    expect(fcmCalls[fcmCalls.length - 1].endpoint).toBe('https://push.example.test/gp-1');
  });

  it('GET /api/ats/offer returns the offer for the ATS UI', async () => {
    const r = await atsGet('/api/ats/offer?application_id=app-1');
    expect(r.status).toBe(200);
    expect(r.body.offer.status).toBe('sent');
    expect(r.body.offer.compensation_range).toBe('$350k+ estimated');
  });

  it('is closed to unauthenticated callers', async () => {
    const r = await httpReq('GET', '/api/ats/offer?application_id=app-1', { host: SUPER_HOST });
    expect(r.status).toBe(401);
  });

  it('404s an unknown application', async () => {
    const r = await atsPost('/api/ats/offer', { application_id: 'nope-1', billing_split: '60 / 40' });
    expect(r.status).toBe(404);
  });
});

describe('PATCH /api/ats/application, dragging into the Offer lane is silent (F1)', () => {
  it('moves the card but sends NO GP email/push, only POST /api/ats/offer announces an offer', async () => {
    const beforeEmails = resendCalls.length;
    const beforeFcm = fcmCalls.length;
    const r = await atsPatch('/api/ats/application?id=app-drag-1', { stage: 'offer' });
    expect(r.status).toBe(200);
    expect(r.body.application.ats_stage).toBe('offer');
    // The stage move + audit row land; the premature "You have an offer!"
    // notification must not (no offer record exists yet, and the real send
    // would email AGAIN → duplicate).
    const ev = db.ats_stage_events.find((e) => e.application_id === 'app-drag-1' && e.to_stage === 'offer');
    expect(ev).toBeTruthy();
    await new Promise((res) => setTimeout(res, 250));
    expect(resendCalls.length).toBe(beforeEmails);
    expect(fcmCalls.length).toBe(beforeFcm);
  });
});

describe('POST /api/ats/offer, legacy Zoho-imported applications (post-decommission)', () => {
  // Zoho Recruit is decommissioned, the old "block offers while a Zoho
  // connection exists" guard (F4) is gone. Legacy Zoho-imported apps now always
  // take in-app offers.
  it('a legacy Zoho app may receive an in-app offer', async () => {
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/offer', { application_id: 'app-z1', billing_split: '70 / 30', sessions_per_week: '7' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.offer.status).toBe('sent');
    expect(db.ats_offers.find((o) => o.application_id === 'app-z1')).toBeTruthy();
    // Still exactly ONE GP email, the dedicated offer email.
    expect(resendCalls.length - before).toBe(1);
    expect(String(resendCalls[resendCalls.length - 1].body.html)).toContain('/pages/offer-review?applicationId=app-z1');
  });
});

describe('GET /api/career/my-offer, the doctor sees the real offer', () => {
  // Task 10 (identity masking): a 'sent'-but-not-yet-accepted offer with no
  // origin='admin_applied'/revealed=true on the application must NOT reveal
  // the real practice name/contact, canRevealPracticeIdentity only opens up
  // once the offer is accepted (or an explicit reveal is set). See
  // tests/practice-pipeline.test.js for the underlying rule's unit coverage.
  it('masks the practice name/contact while the offer is only sent (not yet accepted)', async () => {
    const r = await gpGet('/api/career/my-offer?applicationId=app-1');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.offer.billing_split).toBe('70 / 30');
    expect(r.body.offer.sessions_per_week).toBe('8');
    expect(r.body.offer.compensation_range).toBe('$350k+ estimated');
    expect(r.body.offer.start_date).toBe('2026-08-03');
    expect(r.body.offer.notes).toBe('Includes 4 weeks leave and relocation help.');
    expect(r.body.offer.status).toBe('sent');
    expect(r.body.offer.sent_at).toBeTruthy();
    expect(r.body.revealed).toBe(false);
    expect(r.body.practiceName).toBe('Confidential practice');
    expect(r.body.roleTitle).toBe('General Practitioner, VR');
    expect(r.body.location).toBe('Brisbane, QLD');
    expect(r.body.practiceContact).toEqual({ name: 'The practice team', role: 'Medical centre contact' });
    expect(r.body.contractAvailable).toBe(false);
    expect(r.body.guidanceOfficer).toBe('Hazel Test');
    // The real practice name never appears anywhere in the response while unrevealed.
    expect(r.raw).not.toContain('Greenslopes Family Medical');
    expect(r.raw).not.toContain('Anna Manager');
    // The consultant's identity is never exposed to the GP.
    expect(r.body.offer.sent_by).toBeUndefined();
    expect(r.raw).not.toContain(SUPER_EMAIL);
  });

  it('401s without a session', async () => {
    const r = await httpReq('GET', '/api/career/my-offer?applicationId=app-1', {});
    expect(r.status).toBe(401);
  });

  it("404s someone else's application (no existence leak)", async () => {
    const r = await gpGet('/api/career/my-offer?applicationId=app-1', GP2);
    expect(r.status).toBe(404);
  });

  it('answers offer:null when the own application has no offer', async () => {
    const r = await gpGet('/api/career/my-offer?applicationId=app-2', GP2);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.offer).toBe(null);
  });
});

describe('PATCH /api/ats/offer, quiet withdraw', () => {
  it('withdraws the offer, moves the stage back to reviewing, sends NO GP email', async () => {
    const before = resendCalls.length;
    const r = await atsPatch('/api/ats/offer', { application_id: 'app-1', action: 'withdraw' });
    expect(r.status).toBe(200);
    expect(r.body.offer.status).toBe('withdrawn');

    const app = db.gp_applications.find((a) => a.id === 'app-1');
    expect(app.ats_stage).toBe('reviewing');
    const ev = db.ats_stage_events.find((e) => e.application_id === 'app-1' && e.actor === 'offer_withdrawn');
    expect(ev).toBeTruthy();
    expect(ev.to_stage).toBe('reviewing');

    expect(resendCalls.length).toBe(before); // consultant retracts quietly
  });

  it('a withdrawn offer is no longer reviewable by the GP', async () => {
    const r = await gpGet('/api/career/my-offer?applicationId=app-1');
    expect(r.status).toBe(200);
    expect(r.body.offer).toBe(null);
  });

  it('400s an unsupported action and 404s a missing offer', async () => {
    const bad = await atsPatch('/api/ats/offer', { application_id: 'app-1', action: 'explode' });
    expect(bad.status).toBe(400);
    const none = await atsPatch('/api/ats/offer', { application_id: 'app-2', action: 'withdraw' });
    expect(none.status).toBe(404);
  });
});

describe('contract data-URL delivery', () => {
  it('re-send with a contract delivers a user_documents offer_contract row and STILL sends one email', async () => {
    const before = resendCalls.length;
    const pdfBytes = Buffer.from('%PDF-1.4 test contract');
    const r = await atsPost('/api/ats/offer', {
      application_id: 'app-1',
      billing_split: '72 / 28',
      sessions_per_week: '9',
      compensation_range: '$360k+ estimated',
      start_date: '2026-09-01',
      notes: 'Updated terms.',
      contract_data_url: 'data:application/pdf;base64,' + pdfBytes.toString('base64'),
      contract_file_name: 'Offer-Contract.pdf'
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.contract_delivered).toBe(true);
    expect(r.body.offer.contract_document_key).toBe('offer_contract');

    // The contract landed in the GP's documents (approved, per-document email suppressed).
    const doc = db.user_documents.find((d) => d.user_id === GP.userId && d.document_key === 'offer_contract');
    expect(doc).toBeTruthy();
    expect(doc.status).toBe('approved');
    expect(doc.file_name).toBe('Offer-Contract.pdf');

    // Exactly ONE new email, the offer email; the doc-delivery email did not fire.
    expect(resendCalls.length - before).toBe(1);
    expect(String(resendCalls[resendCalls.length - 1].body.html)).toContain('/pages/offer-review?applicationId=app-1');

    // The GP now sees the updated offer with the contract available.
    const my = await gpGet('/api/career/my-offer?applicationId=app-1');
    expect(my.body.offer.billing_split).toBe('72 / 28');
    expect(my.body.contractAvailable).toBe(true);
  });

  it('rejects an unreadable contract payload', async () => {
    const r = await atsPost('/api/ats/offer', { application_id: 'app-1', contract_data_url: 'not-a-data-url' });
    expect(r.status).toBe(400);
  });
});

// LAST on purpose: once the store observes the missing table it caches the
// determination for the rest of the process and answers from runtime_kv.
describe('runtime_kv fallback (ats_offers table not applied)', () => {
  it('still persists + serves offers via ats_offer:{id} and ats_offers_index', async () => {
    simulateMissingAtsOffers = true;
    const before = resendCalls.length;
    const r = await atsPost('/api/ats/offer', {
      application_id: 'app-3',
      billing_split: '65 / 35',
      sessions_per_week: '6',
      compensation_range: '$300k+ estimated',
      start_date: '2026-10-01',
      notes: ''
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.offer.status).toBe('sent');

    // No table row, the record lives in runtime_kv (+ index for listings).
    expect(db.ats_offers.find((o) => o.application_id === 'app-3')).toBeUndefined();
    const kvOffer = db.runtime_kv.find((k) => k.key === 'ats_offer:app-3');
    expect(kvOffer).toBeTruthy();
    expect(kvOffer.value.application_id).toBe('app-3');
    expect(kvOffer.value.billing_split).toBe('65 / 35');
    const kvIndex = db.runtime_kv.find((k) => k.key === 'ats_offers_index');
    expect(kvIndex).toBeTruthy();
    expect(kvIndex.value.ids).toContain('app-3');

    // Stage move + single email still work exactly as in table mode.
    expect(db.gp_applications.find((a) => a.id === 'app-3').ats_stage).toBe('offer');
    expect(resendCalls.length - before).toBe(1);

    // ATS GET reads it back from kv.
    const g = await atsGet('/api/ats/offer?application_id=app-3');
    expect(g.status).toBe(200);
    expect(g.body.offer.billing_split).toBe('65 / 35');

    // …and the doctor's my-offer works end-to-end off the kv record. Still
    // masked (Task 10), a 'sent' offer with no accept/reveal yet.
    const my = await gpGet('/api/career/my-offer?applicationId=app-3');
    expect(my.status).toBe(200);
    expect(my.body.offer.billing_split).toBe('65 / 35');
    expect(my.body.revealed).toBe(false);
    expect(my.body.practiceName).toBe('Confidential practice');
    expect(my.body.guidanceOfficer).toBe('Hazel Test');
  });

  it('withdraw also works through the kv record', async () => {
    const r = await atsPatch('/api/ats/offer', { application_id: 'app-3', action: 'withdraw' });
    expect(r.status).toBe(200);
    expect(r.body.offer.status).toBe('withdrawn');
    const kvOffer = db.runtime_kv.find((k) => k.key === 'ats_offer:app-3');
    expect(kvOffer.value.status).toBe('withdrawn');
    expect(db.gp_applications.find((a) => a.id === 'app-3').ats_stage).toBe('reviewing');
  });
});

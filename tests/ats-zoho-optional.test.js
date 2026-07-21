// Task F, Zoho-optional hardening: the GP-facing journey is fully coherent
// with Zoho Recruit CONFIGURED but DISCONNECTED (env keys present, no
// integration_connections row, exactly the owner's post-disconnect state).
//
// Boots the real server against the in-memory PostgREST (+ tiny storage)
// emulator pattern from tests/ats-offer-flow.test.js.
//
// Covers:
//  1. GET /api/career/applications, INTERNAL apps carry a friendly
//     statusLabel derived from ats_stage + offer state (applied → "Application
//     submitted", submitted → "Sent to the practice", reviewing → "The
//     practice is reviewing your profile", interview → "Interview stage",
//     offer+sent → "Offer waiting for you 🎉" with offerPending, offer lane
//     without a live offer → quiet copy, not_proceeding → "Not proceeding this
//     time"). Zoho apps keep their raw status and get NO statusLabel.
//  2. GET /api/career/application, same presentation on the detail payload,
//     plus lookup by the ROLE public id ('internal_ats:…').
//  3. POST /api/career/application/withdraw, status → withdrawn AND the
//     kanban card moves to 'not_proceeding' with audit reason 'gp_self_withdrew'.
//  4. POST /api/career/upload-cv, the Zoho mirror is best-effort: with Zoho
//     configured-but-disconnected the CV still saves, answers 200 ok:true and
//     reports zohoSync.ok:false (previously a 502 that blocked Upload & Apply).
//  5. GET /api/ceo/candidate, drawer apps carry source 'in_app' | 'zoho'
//     (the drawer's source chip).
//  6. /api/ats/jobs POST + /api/ats/job PATCH accept `summary` ("About the
//     role") and it surfaces on the doctor-facing role payload.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ats-zoho-opt-${RUN_ID}.json`);
let server, port;          // app under test
let sbServer, sbPort;      // Supabase (PostgREST + storage) emulator

const SUPER_HOST = 'ceo-zoho-opt.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const GP = { userId: 'u-gp-1', email: 'gp@gplink-test.local' };
const NOW = new Date().toISOString();

// ── In-memory PostgREST emulator ────────────────────────────────────────────
const db = {
  user_profiles: [
    // Task 11's server-side DPA gate blurs non-DPA roles for a GP whose
    // registration country isn't Australia (these fixture roles never set
    // `dpa`, which defaults false), this GP is marked Australia-trained via
    // registration_country since this file tests ATS/Zoho mechanics
    // unrelated to the DPA gate.
    { user_id: GP.userId, email: GP.email, first_name: 'Test', last_name: 'Doctor', registration_country: 'australia' }
  ],
  user_state: [
    { user_id: GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }
  ],
  registration_cases: [
    { id: 'case-1', user_id: GP.userId, status: 'active', stage: 'myintealth', assigned_rso: null, assigned_va: null }
  ],
  practices: [
    { id: 'p1', name: 'Greenslopes Family Medical', source: 'internal_ats', contact_name: 'Anna Manager', contact_email: 'anna@greenslopes-test.local', is_active: true, created_at: NOW }
  ],
  career_roles: [
    { id: 'role-int', provider: 'internal_ats', provider_role_id: 'ats_r1', title: 'General Practitioner, VR', practice_name: 'Greenslopes Family Medical', practice_id: 'p1', location_city: 'Brisbane', location_state: 'QLD', is_active: true, job_status: 'open', updated_at: NOW },
    { id: 'role-zoho', provider: 'zoho_recruit', provider_role_id: 'z_9', title: 'GP, Coastal Clinic', practice_name: 'Coastal Clinic', location_city: 'Cairns', location_state: 'QLD', is_active: true, updated_at: NOW }
  ],
  // One GP, one internal app per pipeline lane + one Zoho-managed app whose
  // connection is dead (env configured, no integration_connections row).
  gp_applications: [
    { id: 'app-applied', user_id: GP.userId, career_role_id: 'role-int', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'applied', applied_at: NOW },
    { id: 'app-submitted', user_id: GP.userId, career_role_id: 'role-int', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'submitted', practice_submission_status: 'submitted_to_practice', applied_at: NOW },
    { id: 'app-reviewing', user_id: GP.userId, career_role_id: 'role-int', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'reviewing', applied_at: NOW },
    { id: 'app-interview', user_id: GP.userId, career_role_id: 'role-int', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'interview', applied_at: NOW },
    { id: 'app-offer', user_id: GP.userId, career_role_id: 'role-int', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'offer', applied_at: NOW },
    { id: 'app-offer-quiet', user_id: GP.userId, career_role_id: 'role-int', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'offer', applied_at: NOW },
    { id: 'app-np', user_id: GP.userId, career_role_id: 'role-int', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'not_proceeding', applied_at: NOW },
    { id: 'app-zoho', user_id: GP.userId, career_role_id: 'role-zoho', provider_role_id: 'z_9', zoho_application_id: 'z-app-1', status: 'submitted', ats_stage: 'submitted', applied_at: NOW },
    // Zoho-managed apps in an OFFERED status (F7): the offer normally lives in
    // Zoho (no in-app record) → consultant copy + NO offer-review CTA; only a
    // live in-app offer (legacy app offered post-disconnect) flips offerPending.
    { id: 'app-zoho-offer', user_id: GP.userId, career_role_id: 'role-zoho', provider_role_id: 'z_9', zoho_application_id: 'z-app-offer', status: 'offered', ats_stage: 'offer', applied_at: NOW },
    { id: 'app-zoho-offer-live', user_id: GP.userId, career_role_id: 'role-zoho', provider_role_id: 'z_9', zoho_application_id: 'z-app-offer-live', status: 'offered', ats_stage: 'offer', applied_at: NOW }
  ],
  ats_offers: [
    { id: 'off-1', application_id: 'app-offer', user_id: GP.userId, career_role_id: 'role-int', practice_id: 'p1', job_title: 'General Practitioner, VR', practice_name: 'Greenslopes Family Medical', billing_split: '70 / 30', sessions_per_week: '8', compensation_range: '$350k+', start_date: '2026-08-03', status: 'sent', sent_by: SUPER_EMAIL, sent_at: NOW, created_at: NOW },
    { id: 'off-2', application_id: 'app-zoho-offer-live', user_id: GP.userId, career_role_id: 'role-zoho', practice_id: null, job_title: 'GP, Coastal Clinic', practice_name: 'Coastal Clinic', billing_split: '68 / 32', sessions_per_week: '7', compensation_range: '$320k+', start_date: '2026-09-01', status: 'sent', sent_by: SUPER_EMAIL, sent_at: NOW, created_at: NOW }
  ],
  ats_stage_events: [],
  user_documents: [],
  registration_tasks: [],
  scheduled_calls: [],
  career_interviews: [],
  integration_connections: [], // Zoho DISCONNECTED (no row) while env is configured
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
  const orRaw = searchParams.get('or');
  let orFilters = null;
  if (orRaw) {
    orFilters = orRaw.replace(/^\(/, '').replace(/\)$/, '').split(',').map((clause) => {
      const parts = clause.split('.');
      return { col: parts[0], op: parts[1], val: parts.slice(2).join('.') };
    }).filter((f) => f.col && FILTER_OPS.includes(f.op));
  }
  const evalOne = (row, { col, op, val }) => {
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
  };
  return (row) => filters.every((f) => evalOne(row, f))
    && (!orFilters || orFilters.some((f) => evalOne(row, f)));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      try { resolve(JSON.parse(raw.toString('utf8') || 'null')); }
      catch { resolve(raw); }
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
      // Tiny storage stub (CV upload writes + background pipeline reads).
      if (u.pathname.startsWith('/storage/v1/object/sign/')) {
        send(200, { signedURL: u.pathname.replace('/storage/v1', '') + '?token=test-token' });
        return;
      }
      if (u.pathname.startsWith('/storage/v1/object/')) {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/pdf' });
          res.end(Buffer.from('%PDF-1.4 stored test file'));
          return;
        }
        await readBody(req);
        send(200, { Key: u.pathname.replace('/storage/v1/object/', '') });
        return;
      }
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
            const cols = conflictCol.split(',');
            const existing = rows.find((row) => row && cols.every((c) => String(row[c]) === String(r[c])));
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

const gpGet = (p) => httpReq('GET', p, { cookie: userCookie(GP.email, GP.userId) });
const gpPost = (p, body) => httpReq('POST', p, { cookie: userCookie(GP.email, GP.userId), body });
const atsGet = (p) => httpReq('GET', p, { host: SUPER_HOST, cookie: superCookie() });
const atsPost = (p, body) => httpReq('POST', p, { host: SUPER_HOST, cookie: superCookie(), body });
const atsPatch = (p, body) => httpReq('PATCH', p, { host: SUPER_HOST, cookie: superCookie(), body });

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ats-zoho-opt-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  // THE POINT of this file: Zoho env keys ARE present (configured) but there
  // is NO integration_connections row, the exact state after the owner hits
  // "Disconnect" on the Integrations card. Nothing may 500 or hang.
  process.env.ZOHO_RECRUIT_CLIENT_ID = 'test-zoho-client';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = 'test-zoho-secret';
  process.env.ZOHO_RECRUIT_REDIRECT_URI = 'https://app.gplink-test.local/api/integrations/zoho-recruit/callback';
  process.env.OPENAI_API_KEY = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.RESEND_API_KEY = '';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = 'admin-zoho-opt.local';
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = '';

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

// ── 1. Applications list, internal statusLabels through the lifecycle ─────
describe('GET /api/career/applications, internal apps with Zoho disconnected', () => {
  let entries;
  it('answers 200 with every application (no 500/hang on the dead connection)', async () => {
    const r = await gpGet('/api/career/applications');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    entries = {};
    r.body.applications.forEach((a) => { entries[a.id] = a; });
    expect(Object.keys(entries).length).toBe(db.gp_applications.length);
  });

  it('derives friendly labels from ats_stage for every internal lane', () => {
    expect(entries['app-applied'].status).toBe('applied');
    expect(entries['app-applied'].statusLabel).toBe('Application submitted');
    expect(entries['app-applied'].offerPending).toBe(false);

    expect(entries['app-submitted'].status).toBe('submitted');
    expect(entries['app-submitted'].statusLabel).toBe('Sent to the practice');

    expect(entries['app-reviewing'].status).toBe('reviewing');
    expect(entries['app-reviewing'].statusLabel).toBe('The practice is reviewing your profile');

    expect(entries['app-interview'].status).toBe('interview');
    expect(entries['app-interview'].statusLabel).toBe('Interview stage');

    expect(entries['app-np'].status).toBe('not_proceeding');
    expect(entries['app-np'].statusLabel).toBe('Not proceeding this time');
  });

  it('flags a waiting offer (sent) and stays quiet in the offer lane without one', () => {
    expect(entries['app-offer'].status).toBe('offer');
    expect(entries['app-offer'].statusLabel).toBe('Offer waiting for you 🎉');
    expect(entries['app-offer'].offerPending).toBe(true);

    expect(entries['app-offer-quiet'].statusLabel).toBe('The practice is preparing an offer');
    expect(entries['app-offer-quiet'].offerPending).toBe(false);
  });

  it("keeps Zoho apps' labels unchanged (stored status, NO statusLabel) when the connection is dead", () => {
    expect(entries['app-zoho'].status).toBe('submitted');
    expect(entries['app-zoho'].statusLabel).toBeUndefined();
    expect(entries['app-zoho'].statusTone).toBeUndefined();
    expect(entries['app-zoho'].offerPending).toBe(false);
  });

  it('a Zoho-OFFERED app without an in-app offer gets consultant copy and NO offer CTA (F7)', () => {
    expect(entries['app-zoho-offer'].status).toBe('offered');
    expect(entries['app-zoho-offer'].offerPending).toBe(false); // offer-review would be empty
    expect(entries['app-zoho-offer'].statusLabel).toBe('Offer stage, your consultant will be in touch with the details');
    expect(entries['app-zoho-offer'].statusTone).toBe('offer');
  });

  it('offerPending is true ONLY when a live in-app offer exists (legacy Zoho app after disconnect)', () => {
    expect(entries['app-zoho-offer-live'].offerPending).toBe(true);
    // No override label: the standard "Offer Pending" pill + Review Offer CTA apply.
    expect(entries['app-zoho-offer-live'].statusLabel).toBeUndefined();
  });
});

// ── 2. Application detail, same presentation + role-public-id lookup ──────
describe('GET /api/career/application, internal detail payload', () => {
  it('returns the presentation fields for an internal app', async () => {
    const r = await gpGet('/api/career/application?id=app-offer');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const app = r.body.application;
    expect(app.status).toBe('offer');
    expect(app.statusLabel).toBe('Offer waiting for you 🎉');
    expect(app.offerPending).toBe(true);
    expect(app.role.roleType).toBe('General Practitioner, VR');
  });

  it("resolves the ROLE public id ('internal_ats:ats_r1') to one of the GP's apps", async () => {
    const r = await gpGet('/api/career/application?id=' + encodeURIComponent('internal_ats:ats_r1'));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.application.statusLabel).toBeTruthy();
  });

  it('a Zoho app answers without a statusLabel and without 500ing', async () => {
    const r = await gpGet('/api/career/application?id=app-zoho');
    expect(r.status).toBe(200);
    expect(r.body.application.status).toBe('submitted');
    expect(r.body.application.statusLabel).toBeUndefined();
  });

  it('the detail payload applies the same Zoho-offered rule (F7)', async () => {
    const quiet = await gpGet('/api/career/application?id=app-zoho-offer');
    expect(quiet.status).toBe(200);
    expect(quiet.body.application.offerPending).toBe(false);
    expect(quiet.body.application.statusLabel).toBe('Offer stage, your consultant will be in touch with the details');

    const live = await gpGet('/api/career/application?id=app-zoho-offer-live');
    expect(live.status).toBe(200);
    expect(live.body.application.offerPending).toBe(true);
    expect(live.body.application.statusLabel).toBeUndefined();
  });
});

// ── 3. Withdraw, kanban reflects reality ───────────────────────────────────
describe('POST /api/career/application/withdraw, internal app', () => {
  it('sets status withdrawn AND moves the kanban card to not_proceeding (reason gp_self_withdrew)', async () => {
    const r = await gpPost('/api/career/application/withdraw', { applicationId: 'app-interview' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const row = db.gp_applications.find((a) => a.id === 'app-interview');
    expect(row.status).toBe('withdrawn');
    expect(row.ats_stage).toBe('not_proceeding');
    // The old call passed 'gp_withdrew' as the 4th argument of
    // atsUpdateApplicationStageRow(appId, stage, notes, actor, reason), so it
    // landed in ACTOR and the reason stayed null, invisible to every
    // reason-based query. Actor is now the GP's own email, and the reason sits
    // in the 5th slot under its own value (never 'gp_withdrew', which is the
    // staff-recorded value the 3-strike career lock counts).
    const ev = db.ats_stage_events.find((e) => e.application_id === 'app-interview' && e.reason === 'gp_self_withdrew');
    expect(ev).toBeTruthy();
    expect(ev.actor).toBe('gp@gplink-test.local');
    expect(ev.from_stage).toBe('interview');
    expect(ev.to_stage).toBe('not_proceeding');
  });

  it('the list then shows "Application withdrawn" for it', async () => {
    const r = await gpGet('/api/career/applications');
    const entry = r.body.applications.find((a) => a.id === 'app-interview');
    expect(entry.status).toBe('withdrawn');
    expect(entry.statusLabel).toBe('Application withdrawn');
  });

  it('a terminal card is not re-audited on a repeat withdraw', async () => {
    const before = db.ats_stage_events.filter((e) => e.application_id === 'app-interview').length;
    const r = await gpPost('/api/career/application/withdraw', { applicationId: 'app-interview' });
    expect(r.status).toBe(200);
    expect(db.ats_stage_events.filter((e) => e.application_id === 'app-interview').length).toBe(before);
  });
});

// ── 4. upload-cv, the Zoho mirror never blocks the doctor ─────────────────
describe('POST /api/career/upload-cv, Zoho configured but disconnected', () => {
  it('saves the CV, answers 200 ok:true and reports the skipped Zoho mirror', async () => {
    const pdf = Buffer.from('%PDF-1.4 test cv document for upload');
    const r = await gpPost('/api/career/upload-cv', {
      fileName: 'Dr-Test-Doctor-CV.pdf',
      mimeType: 'application/pdf',
      fileSize: pdf.length,
      fileDataUrl: 'data:application/pdf;base64,' + pdf.toString('base64')
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.document).toBeTruthy();
    expect(r.body.zohoSync.ok).toBe(false);

    const doc = db.user_documents.find((d) => d.user_id === GP.userId && d.document_key === 'cv_signed_dated');
    expect(doc).toBeTruthy();
    expect(doc.file_name).toBe('Dr-Test-Doctor-CV.pdf');
  });
});

// ── 5. Candidate drawer, source chip data ──────────────────────────────────
describe('GET /api/ceo/candidate, apps carry their source', () => {
  it("marks in-app applications 'in_app' and Zoho-managed ones 'zoho'", async () => {
    const r = await atsGet('/api/ceo/candidate?case_id=case-1');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const apps = {};
    r.body.candidate.apps.forEach((a) => { apps[a.id] = a; });
    expect(apps['app-applied'].source).toBe('in_app');
    expect(apps['app-offer'].source).toBe('in_app');
    expect(apps['app-zoho'].source).toBe('zoho');
  });
});

// ── 6. Job summary ("About the role") end to end ────────────────────────────
describe('ATS job summary field', () => {
  let jobId;
  it('POST /api/ats/jobs stores the summary', async () => {
    const r = await atsPost('/api/ats/jobs', {
      title: 'GP, Suburban Clinic',
      practice_id: '',
      practice_name: 'Suburban Clinic',
      city: 'Ipswich', state: 'QLD', type: 'Full time', billing: 'Mixed billing',
      summary: 'A friendly six-doctor practice with full nursing support.'
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.job.summary).toBe('A friendly six-doctor practice with full nursing support.');
    jobId = r.body.job.id;
  });

  it('PATCH /api/ats/job updates it and the doctor-facing role shows it', async () => {
    const p = await atsPatch('/api/ats/job?id=' + encodeURIComponent(jobId), { summary: 'Updated: relaxed, well-run clinic near the river.' });
    expect(p.status).toBe(200);
    expect(p.body.job.summary).toBe('Updated: relaxed, well-run clinic near the river.');

    const roles = await gpGet('/api/career/roles');
    expect(roles.status).toBe(200);
    const role = (roles.body.roles || []).find((x) => x.summary === 'Updated: relaxed, well-run clinic near the river.');
    expect(role).toBeTruthy();
  });
});

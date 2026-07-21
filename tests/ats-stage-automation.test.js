// Task 5, pipeline automation: Zoho↔ats_stage reconciliation, GP milestone
// notifications, and offer-accept → hired.
//
// Boots the real server against the in-memory PostgREST emulator (pattern from
// tests/career-internal-apply.test.js) so the FULL Supabase-mode paths run:
// atsUpdateApplicationStageRow (prev-read + PATCH + ats_stage_events audit),
// the reconciliation seam used by syncZohoRecruitApplicationStatuses, the
// PATCH /api/ats/application notifier hook, and POST /api/career/offer/accept.
// Email + FCM are UNCONFIGURED, so the observable notification surface is the
// in-app gp_link_updates list in user_state (pushCareerNotificationToUser).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as atsLib from '../lib/ats-practices.js';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ats-stage-${RUN_ID}.json`);
const SUPER_HOST = 'ats-stage-test.local';
let server, port;          // app under test
let sbServer, sbPort;      // Supabase (PostgREST) emulator
let testUtils;             // server.js __testUtils (reconcile seam)
let realFetch;             // original fetch (wrapped for the fake Zoho API)

const GP1 = { userId: 'u-gp-1', email: 'gp1@gplink-test.local' };
const GP2 = { userId: 'u-gp-2', email: 'gp2@gplink-test.local' };
const GP3 = { userId: 'u-gp-3', email: 'gp3@gplink-test.local' }; // no applications
const NOW = new Date().toISOString();

// ── In-memory PostgREST emulator ────────────────────────────────────────────
const db = {
  user_profiles: [
    { user_id: GP1.userId, email: GP1.email, first_name: 'Test', last_name: 'Doctor' },
    { user_id: GP2.userId, email: GP2.email, first_name: 'Second', last_name: 'Doctor' },
    { user_id: GP3.userId, email: GP3.email, first_name: 'Third', last_name: 'Doctor' }
  ],
  user_state: [
    { user_id: GP1.userId, state: {}, updated_at: NOW },
    { user_id: GP2.userId, state: {}, updated_at: NOW },
    { user_id: GP3.userId, state: {}, updated_at: NOW }
  ],
  career_roles: [
    { id: 'role-1', provider: 'internal_ats', provider_role_id: 'ats_r1', title: 'General Practitioner, VR', practice_name: 'Greenslopes Family Medical', is_active: true, job_status: 'open', updated_at: NOW }
  ],
  gp_applications: [
    // Reconciliation targets.
    { id: 'app-sync-1', user_id: GP1.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'submitted_to_practice', practice_submission_status: 'submitted_to_practice', ats_stage: 'submitted', applied_at: NOW, updated_at: NOW },
    { id: 'app-manual-1', user_id: GP1.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1b', status: 'applied', practice_submission_status: null, ats_stage: 'offer', applied_at: NOW, updated_at: NOW },
    { id: 'app-rej-1', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1c', status: 'applied', practice_submission_status: 'client_reviewed', ats_stage: 'reviewing', applied_at: NOW, updated_at: NOW },
    { id: 'app-hired-1', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1d', status: 'hired', practice_submission_status: null, ats_stage: 'hired', applied_at: NOW, updated_at: NOW },
    // PATCH /api/ats/application target.
    { id: 'app-patch-1', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1e', status: 'applied', practice_submission_status: null, ats_stage: 'applied', applied_at: NOW, updated_at: NOW },
    // Board-only card without a real user (must never notify / crash).
    { id: 'app-nouser-1', user_id: null, career_role_id: 'role-1', provider_role_id: 'ats_r1f', status: 'applied', practice_submission_status: null, ats_stage: 'applied', applied_at: NOW, updated_at: NOW },
    // Offer-accept target.
    { id: 'app-offer-1', user_id: GP1.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1g', status: 'offered', practice_submission_status: 'client_approved', ats_stage: 'offer', applied_at: NOW, updated_at: NOW },
    // Zoho-lane offer reconciliation target (F7 notifier copy).
    { id: 'app-zoffer-1', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1h', status: 'applied', practice_submission_status: null, ats_stage: 'reviewing', applied_at: NOW, updated_at: NOW },
    // syncZohoRecruitApplicationStatuses targets (F4 never-downgrade guard):
    // one normal forward sync + one locally-SECURED app Zoho still shows pre-offer.
    { id: 'app-zsync-ok', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'z-job-ok', zoho_application_id: 'z-sync-ok', status: 'submitted_to_practice', practice_submission_status: 'submitted_to_practice', ats_stage: 'submitted', applied_at: NOW, updated_at: NOW },
    { id: 'app-zsync-sec', user_id: GP2.userId, career_role_id: 'role-1', provider_role_id: 'z-job-sec', zoho_application_id: 'z-sync-sec', status: 'placement_secured', practice_submission_status: null, ats_stage: 'hired', applied_at: NOW, updated_at: NOW }
  ],
  ats_stage_events: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

// Live Zoho application records served by the wrapped fetch below (keyed by
// zoho_application_id). The locally secured app deliberately maps to a live
// status that is NOT placement-secured, the exact downgrade scenario the
// sync guard must skip.
const ZOHO_API_BASE = 'https://zoho-sync.gplink-test.local';
const zohoLiveRecords = {
  'z-sync-ok': { id: 'z-sync-ok', Application_Status: 'Interview Scheduled' },
  'z-sync-sec': { id: 'z-sync-sec', Application_Status: 'In Review' }
};

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
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (!m) { send(404, { message: 'not found' }); return; }
      const rows = tableOf(decodeURIComponent(m[1]));
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

// ── Session + request helpers ────────────────────────────────────────────────
function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function gpCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { host, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
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

// The notifier is fire-and-forget from endpoints/reconcile, poll briefly.
async function waitFor(fn, { tries = 40, ms = 25 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, ms));
  }
  return fn();
}
function updatesFor(userId) {
  const row = db.user_state.find((r) => r.user_id === userId);
  const state = row && typeof row.state === 'object' && row.state ? row.state : {};
  return Array.isArray(state.gp_link_updates) ? state.gp_link_updates : [];
}
function eventsFor(appId) {
  return db.ats_stage_events.filter((e) => String(e.application_id) === String(appId));
}
function appRow(appId) {
  return db.gp_applications.find((a) => String(a.id) === String(appId));
}

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'ats-stage-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  // Keep every external notification leg unconfigured: no FCM, no email.
  process.env.FCM_SERVER_KEY = '';
  process.env.OPENAI_API_KEY = '';
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';

  // Serve the fake Zoho Recruit API (Applications/{id}) for the
  // syncZohoRecruitApplicationStatuses tests; everything else passes through
  // to the real fetch (the PostgREST emulator).
  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith(ZOHO_API_BASE)) {
      const m = u.match(/\/recruit\/v2\/[Aa]pplications\/([^/?]+)/);
      const rec = m ? zohoLiveRecords[decodeURIComponent(m[1])] : null;
      return Promise.resolve(new Response(
        JSON.stringify({ data: rec ? [rec] : [] }),
        { status: rec ? 200 : 404, headers: { 'Content-Type': 'application/json' } }
      ));
    }
    return realFetch(url, opts);
  };

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

// ── Pure forward-only rule (lib/ats-practices.js) ───────────────────────────
describe('planAtsStageReconciliation (forward-only rule)', () => {
  it('advances when the derived stage is strictly ahead', () => {
    expect(atsLib.planAtsStageReconciliation('applied', 'interview')).toBe('interview');
    expect(atsLib.planAtsStageReconciliation('submitted', 'offer')).toBe('offer');
    expect(atsLib.planAtsStageReconciliation('', 'applied')).toBe('applied'); // legacy empty stage adopts derived
  });
  it('is a no-op when equal and never moves backwards', () => {
    expect(atsLib.planAtsStageReconciliation('interview', 'interview')).toBe(null);
    expect(atsLib.planAtsStageReconciliation('offer', 'interview')).toBe(null); // manual advance preserved
    expect(atsLib.planAtsStageReconciliation('hired', 'offer')).toBe(null);
  });
  it('handles not_proceeding as terminal (both directions)', () => {
    expect(atsLib.planAtsStageReconciliation('reviewing', 'not_proceeding')).toBe('not_proceeding');
    expect(atsLib.planAtsStageReconciliation('hired', 'not_proceeding')).toBe(null); // hired is terminal
    expect(atsLib.planAtsStageReconciliation('not_proceeding', 'hired')).toBe(null); // rejected lane never auto-revived
    expect(atsLib.planAtsStageReconciliation('not_proceeding', 'not_proceeding')).toBe(null);
  });
});

// ── Zoho sync reconciliation seam ────────────────────────────────────────────
describe('reconcileAtsStageAfterStatusSync (the per-row step syncZohoRecruitApplicationStatuses runs)', () => {
  it('advances ats_stage, writes the audit event once, and notifies the GP', async () => {
    const before = updatesFor(GP1.userId).length;
    const result = await testUtils.reconcileAtsStageAfterStatusSync({ ...appRow('app-sync-1') }, 'interview_scheduled', 'zoho_sync');
    expect(result).toBe('interview');
    expect(appRow('app-sync-1').ats_stage).toBe('interview');

    const evs = eventsFor('app-sync-1');
    expect(evs.length).toBe(1); // helper records it; reconcile must NOT double-write
    expect(evs[0].from_stage).toBe('submitted');
    expect(evs[0].to_stage).toBe('interview');
    expect(evs[0].actor).toBe('zoho_sync');

    await waitFor(() => updatesFor(GP1.userId).length > before);
    const entry = updatesFor(GP1.userId)[0];
    expect(entry.title).toMatch(/interview/i);
    expect(entry.body).toContain('General Practitioner, VR');
    expect(entry.body).toContain('Greenslopes Family Medical');
  });

  it('re-running the sync on the same row is a no-op (no event, no second notification)', async () => {
    const notifCount = updatesFor(GP1.userId).length;
    const result = await testUtils.reconcileAtsStageAfterStatusSync({ ...appRow('app-sync-1') }, 'interview_scheduled', 'zoho_sync');
    expect(result).toBe(null);
    expect(eventsFor('app-sync-1').length).toBe(1);
    await new Promise((r) => setTimeout(r, 150));
    expect(updatesFor(GP1.userId).length).toBe(notifCount);
  });

  it('never regresses a manually advanced stage', async () => {
    const result = await testUtils.reconcileAtsStageAfterStatusSync({ ...appRow('app-manual-1') }, 'interview_scheduled', 'zoho_sync');
    expect(result).toBe(null);
    expect(appRow('app-manual-1').ats_stage).toBe('offer');
    expect(eventsFor('app-manual-1').length).toBe(0);
  });

  it('moves to not_proceeding on a rejected Zoho status, with kind copy', async () => {
    const before = updatesFor(GP2.userId).length;
    const result = await testUtils.reconcileAtsStageAfterStatusSync({ ...appRow('app-rej-1') }, 'rejected', 'zoho_sync');
    expect(result).toBe('not_proceeding');
    expect(appRow('app-rej-1').ats_stage).toBe('not_proceeding');
    expect(eventsFor('app-rej-1').length).toBe(1);
    expect(eventsFor('app-rej-1')[0].to_stage).toBe('not_proceeding');

    await waitFor(() => updatesFor(GP2.userId).length > before);
    const entry = updatesFor(GP2.userId)[0];
    expect(entry.body).toContain("didn't work out");
    expect(entry.body).toContain('looking at other options');
  });

  it('a hired application never drops to not_proceeding', async () => {
    const result = await testUtils.reconcileAtsStageAfterStatusSync({ ...appRow('app-hired-1') }, 'rejected', 'zoho_sync');
    expect(result).toBe(null);
    expect(appRow('app-hired-1').ats_stage).toBe('hired');
    expect(eventsFor('app-hired-1').length).toBe(0);
  });

  it("a Zoho-lane offer notifies with page-agnostic, consultant-led copy (no in-app offer exists to review)", async () => {
    const before = updatesFor(GP2.userId).length;
    const result = await testUtils.reconcileAtsStageAfterStatusSync({ ...appRow('app-zoffer-1') }, 'offered', 'zoho_sync');
    expect(result).toBe('offer');
    expect(appRow('app-zoffer-1').ats_stage).toBe('offer');

    await waitFor(() => updatesFor(GP2.userId).length > before);
    const entry = updatesFor(GP2.userId)[0];
    expect(entry.title).toMatch(/offer/i);
    // The copy must NOT send the doctor hunting for an offer page that has
    // nothing to show (offer-review only renders in-app offers).
    expect(entry.body).toContain('Your consultant will walk you through the details');
    expect(entry.body).not.toContain('Open the app');
  });
});

// Zoho Recruit decommissioned, the syncZohoRecruitApplicationStatuses
// downgrade-guard tests were removed with the function. reconcileAtsStageAfterStatusSync
// (the per-row step it used) is still covered above.

// ── Manual kanban moves (PATCH /api/ats/application) ────────────────────────
describe('PATCH /api/ats/application notifier', () => {
  it('does NOT notify for non-milestone stages', async () => {
    const before = updatesFor(GP2.userId).length;
    const r = await httpReq('PATCH', '/api/ats/application?id=app-patch-1', { host: SUPER_HOST, cookie: superCookie(), body: { stage: 'submitted' } });
    expect(r.status).toBe(200);
    expect(appRow('app-patch-1').ats_stage).toBe('submitted');
    await new Promise((res) => setTimeout(res, 150));
    expect(updatesFor(GP2.userId).length).toBe(before);
  });

  it('notifies the GP when the card moves to a milestone stage', async () => {
    const before = updatesFor(GP2.userId).length;
    const r = await httpReq('PATCH', '/api/ats/application?id=app-patch-1', { host: SUPER_HOST, cookie: superCookie(), body: { stage: 'interview' } });
    expect(r.status).toBe(200);
    expect(r.body.application.ats_stage).toBe('interview');

    await waitFor(() => updatesFor(GP2.userId).length > before);
    const entry = updatesFor(GP2.userId)[0];
    expect(entry.title).toMatch(/interview/i);
    // Audit row carries the acting CEO.
    const ev = eventsFor('app-patch-1').find((e) => e.to_stage === 'interview');
    expect(ev).toBeTruthy();
    expect(ev.actor).toBe('super@gplink-test.local');
  });

  it('repeating the same move does not notify again (only fires on a real change)', async () => {
    const count = updatesFor(GP2.userId).length;
    const r = await httpReq('PATCH', '/api/ats/application?id=app-patch-1', { host: SUPER_HOST, cookie: superCookie(), body: { stage: 'interview' } });
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 150));
    expect(updatesFor(GP2.userId).length).toBe(count);
  });

  it('dragging a card into the Offer lane is SILENT for the GP (no offer exists yet, F1)', async () => {
    const before = updatesFor(GP2.userId).length;
    const r = await httpReq('PATCH', '/api/ats/application?id=app-patch-1', { host: SUPER_HOST, cookie: superCookie(), body: { stage: 'offer' } });
    expect(r.status).toBe(200);
    expect(r.body.application.ats_stage).toBe('offer');
    // The move itself still lands (stage + audit row), only the premature
    // "You have an offer!" notification is suppressed: the dedicated email
    // from POST /api/ats/offer is the doctor-facing signal for a real offer.
    const ev = eventsFor('app-patch-1').find((e) => e.to_stage === 'offer');
    expect(ev).toBeTruthy();
    await new Promise((res) => setTimeout(res, 150));
    expect(updatesFor(GP2.userId).length).toBe(before);
  });

  it('a card without a real user moves quietly (no crash, no notification)', async () => {
    const gp1 = updatesFor(GP1.userId).length;
    const gp2 = updatesFor(GP2.userId).length;
    const r = await httpReq('PATCH', '/api/ats/application?id=app-nouser-1', { host: SUPER_HOST, cookie: superCookie(), body: { stage: 'hired' } });
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 150));
    expect(updatesFor(GP1.userId).length).toBe(gp1);
    expect(updatesFor(GP2.userId).length).toBe(gp2);
  });
});

// ── Offer acceptance (POST /api/career/offer/accept) ────────────────────────
describe('POST /api/career/offer/accept', () => {
  it('advances the offer-stage application to hired with actor gp_accept_offer (no self-notification)', async () => {
    const before = updatesFor(GP1.userId).length;
    const r = await httpReq('POST', '/api/career/offer/accept', {
      cookie: gpCookie(GP1.email, GP1.userId),
      body: { applicationId: 'app-offer-1' }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.advanced).toBe(true);
    expect(r.body.ats_stage).toBe('hired');
    expect(appRow('app-offer-1').ats_stage).toBe('hired');

    const evs = eventsFor('app-offer-1');
    expect(evs.length).toBe(1);
    expect(evs[0].from_stage).toBe('offer');
    expect(evs[0].to_stage).toBe('hired');
    expect(evs[0].actor).toBe('gp_accept_offer');

    // Deliberate decision: the page shows its own confirmation, so accepting
    // must NOT also email/ping the GP about their own click.
    await new Promise((res) => setTimeout(res, 150));
    expect(updatesFor(GP1.userId).length).toBe(before);
  });

  it('accepting again is a quiet no-op (hired is terminal-forward)', async () => {
    const r = await httpReq('POST', '/api/career/offer/accept', {
      cookie: gpCookie(GP1.email, GP1.userId),
      body: { applicationId: 'app-offer-1' }
    });
    expect(r.status).toBe(200);
    expect(r.body.advanced).toBe(false);
    expect(r.body.ats_stage).toBe('hired');
    expect(eventsFor('app-offer-1').length).toBe(1); // still exactly one audit row
  });

  it('finds the offer-lane application when no applicationId is supplied', async () => {
    // app-manual-1 is GP1's remaining 'offer'-stage application.
    const r = await httpReq('POST', '/api/career/offer/accept', { cookie: gpCookie(GP1.email, GP1.userId), body: {} });
    expect(r.status).toBe(200);
    expect(r.body.applicationId).toBe('app-manual-1');
    expect(appRow('app-manual-1').ats_stage).toBe('hired');
  });

  it('404s when the GP has no offer-stage application', async () => {
    const r = await httpReq('POST', '/api/career/offer/accept', { cookie: gpCookie(GP3.email, GP3.userId), body: {} });
    expect(r.status).toBe(404);
    expect(r.body.ok).toBe(false);
  });

  it('requires a session', async () => {
    const r = await httpReq('POST', '/api/career/offer/accept', { body: {} });
    expect([301, 302, 401, 403]).toContain(r.status);
  });
});

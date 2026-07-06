// Phase 5 Task 5 — ATS document access (A6/A7b), manual placement + list (A8),
// stale-vocab pruning (A10) and the folded empty-parse ingest fix.
//
// Boots the real server against the in-memory PostgREST + storage emulator
// pattern from tests/ats-placement-accept.test.js. Outbound email (Resend) and
// push (FCM) are captured by wrapping global fetch; every other external host is
// stubbed empty so the placement finalization runs offline-deterministic.
//
// Covers:
//  A6   GET /api/ats/candidate-cv → signed URL for the CV, 404 when none, never
//       serves an ID document, consultant allowed.
//  A7b  GET /api/ats/offer-contract → signed URL when a contract is stored, 404
//       otherwise; the candidate payload exposes offer.has_contract.
//  A8a  POST /api/ats/placement → placement_secured + placements row + exactly
//       one GP email, 409 on already-secured, consultant allowed.
//  A8b  GET /api/ats/placements lists the seeded placement; mode:'update'
//       commencement-date edit round-trips.
//  T3   ingest-reply with an unparseable email keeps status 'requested'.
//  UI   static pins for the client affordances + cache-busters.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ats-docs-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const SUPER_HOST = 'ceo-docs.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const CONSULTANT_EMAIL = 'consultant@gplink-test.local';
const GP = { userId: 'u-gp-1', email: 'gp@gplink-test.local' };      // has a CV + interview row
const GP2 = { userId: 'u-gp-2', email: 'two@gplink-test.local' };    // ID doc only, NO CV
const GP3 = { userId: 'u-gp-3', email: 'three@gplink-test.local' };  // manual placement (super)
const GP4 = { userId: 'u-gp-4', email: 'four@gplink-test.local' };   // offer with a stored contract
const GP5 = { userId: 'u-gp-5', email: 'five@gplink-test.local' };   // manual placement (consultant)
const NOW = new Date().toISOString();

const resendCalls = [];
const fcmCalls = [];

const progressState = { gp_onboarding_complete: true, gp_epic_progress: { completed: {} }, gp_amc_progress: { completed: {} }, gp_ahpra_progress: {}, gp_documents_prep: {} };

const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Jane', last_name: 'Doctor', registration_country: 'uk' },
    { user_id: GP2.userId, email: GP2.email, first_name: 'Two', last_name: 'Doctor', registration_country: 'ie' },
    { user_id: GP3.userId, email: GP3.email, first_name: 'Three', last_name: 'Doctor', registration_country: 'uk' },
    { user_id: GP4.userId, email: GP4.email, first_name: 'Four', last_name: 'Doctor', registration_country: 'uk' },
    { user_id: GP5.userId, email: GP5.email, first_name: 'Five', last_name: 'Doctor', registration_country: 'uk' }
  ],
  user_state: [
    { user_id: GP.userId, state: Object.assign({ gp_push_tokens: [{ token: 't1' }] }, progressState), updated_at: NOW },
    { user_id: GP2.userId, state: Object.assign({}, progressState), updated_at: NOW },
    { user_id: GP3.userId, state: Object.assign({}, progressState), updated_at: NOW },
    { user_id: GP4.userId, state: Object.assign({}, progressState), updated_at: NOW },
    { user_id: GP5.userId, state: Object.assign({}, progressState), updated_at: NOW }
  ],
  registration_cases: [
    { id: 'case-1', user_id: GP.userId, status: 'active', stage: 'career', assigned_rso: null, assigned_va: null },
    { id: 'case-2', user_id: GP2.userId, status: 'active', stage: 'career', assigned_rso: null, assigned_va: null },
    { id: 'case-3', user_id: GP3.userId, status: 'active', stage: 'career', assigned_rso: null, assigned_va: null },
    { id: 'case-4', user_id: GP4.userId, status: 'active', stage: 'career', assigned_rso: null, assigned_va: null },
    { id: 'case-5', user_id: GP5.userId, status: 'active', stage: 'career', assigned_rso: null, assigned_va: null }
  ],
  rso_team: [],
  user_roles: [],
  practices: [
    { id: 'p1', name: 'Greenslopes Family Medical', source: 'internal_ats', contact_name: 'Anna Manager', contact_email: 'anna@greenslopes-test.local', is_active: true, created_at: NOW }
  ],
  career_roles: [
    { id: 'role-1', provider: 'internal_ats', provider_role_id: 'ats_r1', title: 'General Practitioner — VR', practice_name: 'Greenslopes Family Medical', practice_id: 'p1', location_city: 'Brisbane', location_state: 'QLD', billing_model: 'Mixed Billing', is_active: true, job_status: 'open', ats_created: true, updated_at: NOW }
  ],
  gp_applications: [
    { id: 'app-int', user_id: GP.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'interview', applied_at: NOW },
    { id: 'app-oc', user_id: GP4.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'offer', applied_at: NOW },
    { id: 'app-mp', user_id: GP3.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'offer', applied_at: NOW },
    { id: 'app-mp2', user_id: GP5.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'offer', applied_at: NOW }
  ],
  user_documents: [
    { id: 'doc-cv', user_id: GP.userId, document_key: 'cv_signed_dated', country_code: 'uk', status: 'uploaded', file_name: 'Jane-CV.pdf', storage_bucket: 'documents', storage_path: 'users/u-gp-1/career-documents/cv/current', file_url: 'users/u-gp-1/career-documents/cv/current' },
    // GP2 has ONLY an identity document — the CV endpoint must never serve it.
    { id: 'doc-id', user_id: GP2.userId, document_key: 'identity_document', country_code: 'ie', status: 'uploaded', file_name: 'passport.pdf', storage_bucket: 'documents', storage_path: 'users/u-gp-2/id/current', file_url: 'users/u-gp-2/id/current' },
    // GP4's offer contract, delivered with a storage path.
    { id: 'doc-oc', user_id: GP4.userId, document_key: 'offer_contract', country_code: 'uk', status: 'approved', file_name: 'Offer-Contract.pdf', storage_bucket: 'documents', storage_path: 'users/u-gp-4/offer-documents/offer_contract/current', file_url: 'users/u-gp-4/offer-documents/offer_contract/current' }
  ],
  ats_offers: [
    { id: 'offer-oc', application_id: 'app-oc', user_id: GP4.userId, career_role_id: 'role-1', practice_id: 'p1', job_title: 'General Practitioner — VR', practice_name: 'Greenslopes Family Medical', billing_split: '70 / 30', sessions_per_week: '8', compensation_range: '$350k+ estimated', start_date: '2026-10-01', contract_document_key: 'offer_contract', status: 'sent', sent_by: SUPER_EMAIL, sent_at: NOW, created_at: NOW },
    { id: 'offer-mp', application_id: 'app-mp', user_id: GP3.userId, career_role_id: 'role-1', practice_id: 'p1', job_title: 'General Practitioner — VR', practice_name: 'Greenslopes Family Medical', billing_split: '65 / 35', sessions_per_week: '6', compensation_range: '$300k+ estimated', start_date: '2026-09-01', status: 'sent', sent_by: SUPER_EMAIL, sent_at: NOW, created_at: NOW },
    { id: 'offer-mp2', application_id: 'app-mp2', user_id: GP5.userId, career_role_id: 'role-1', practice_id: 'p1', job_title: 'General Practitioner — VR', practice_name: 'Greenslopes Family Medical', billing_split: '60 / 40', sessions_per_week: '5', compensation_range: '$280k+ estimated', start_date: '2026-11-01', status: 'sent', sent_by: SUPER_EMAIL, sent_at: NOW, created_at: NOW }
  ],
  scheduled_calls: [
    { id: 'int-1', application_id: 'app-int', user_id: GP.userId, case_id: 'case-1', meeting_kind: 'interview', status: 'pending', practice_availability_status: 'requested', practice_availability_windows: [], created_at: NOW }
  ],
  ats_stage_events: [],
  registration_tasks: [],
  task_timeline: [],
  placements: [],
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
      // Storage stub: uploads succeed, signing echoes the path back.
      if (u.pathname.startsWith('/storage/v1/object/sign/')) {
        send(200, { signedURL: u.pathname.replace('/storage/v1', '') + '?token=test-token' });
        return;
      }
      if (u.pathname.startsWith('/storage/v1/object/')) {
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
            const cols = String(conflictCol).split(',');
            const existing = rows.find((row) => row && cols.every((cc) => String(row[cc]) === String(r[cc])));
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
const superCookie = () => adminCookieFor(SUPER_EMAIL, 'super_admin');
const consultantCookie = () => adminCookieFor(CONSULTANT_EMAIL, 'consultant');

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
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    r.on('error', reject); r.end(data);
  });
}
const atsGet = (p, cookie) => httpReq('GET', p, { host: SUPER_HOST, cookie: cookie || superCookie() });
const atsPost = (p, body, cookie) => httpReq('POST', p, { host: SUPER_HOST, cookie: cookie || superCookie(), body });

const gpEmailsMatching = (needle) => resendCalls.filter((c) => {
  const to = c.body && c.body.to;
  return (Array.isArray(to) ? to : [to]).some((t) => String(t || '').includes(needle));
});

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ats-docs-secret-' + RUN_ID;
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
  process.env.ANTHROPIC_API_KEY = ''; // force the deterministic fallback parser
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = 'admin-docs.local';
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.CONSULTANT_EMAILS = CONSULTANT_EMAIL;
  process.env.ADMIN_EMAILS = '';
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
    // Anthropic: the availability parser calls this only when ANTHROPIC_API_KEY
    // is set (the T3 test flips it on) — return an empty windows array so the
    // "unparseable reply" path is exercised deterministically.
    if (u.startsWith('https://api.anthropic.com/')) {
      return Promise.resolve(new Response(JSON.stringify({ content: [{ text: '[]' }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }));
    }
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    return Promise.resolve(new Response('{}', { status: 200 }));
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

// ── A6: CV access ────────────────────────────────────────────────────────────
describe('A6 — consultant CV access', () => {
  it('returns a signed URL for the CV (by user_id)', async () => {
    const r = await atsGet('/api/ats/candidate-cv?user_id=' + GP.userId);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(String(r.body.url)).toContain('/storage/v1/object/sign/');
    expect(r.body.file_name).toBe('Jane-CV.pdf');
  });

  it('resolves the GP via case_id too', async () => {
    const r = await atsGet('/api/ats/candidate-cv?case_id=case-1');
    expect(r.status).toBe(200);
    expect(String(r.body.url)).toContain('/storage/v1/object/sign/');
  });

  it('404s when the doctor has no CV on file', async () => {
    // GP2 has only an ID document — it must NOT be served here.
    const r = await atsGet('/api/ats/candidate-cv?user_id=' + GP2.userId);
    expect(r.status).toBe(404);
    expect(r.body.ok).toBe(false);
  });

  it('a consultant (not just the CEO) can open the CV', async () => {
    const r = await atsGet('/api/ats/candidate-cv?user_id=' + GP.userId, consultantCookie());
    expect(r.status).toBe(200);
    expect(String(r.body.url)).toContain('object/sign');
  });

  it('is fenced off without an ATS session', async () => {
    const r = await httpReq('GET', '/api/ats/candidate-cv?user_id=' + GP.userId, { host: SUPER_HOST });
    expect(r.status).toBe(401);
  });
});

// ── A7b: offer contract ──────────────────────────────────────────────────────
describe('A7b — offer contract retrieval', () => {
  it('returns a signed URL when a contract is stored on the offer', async () => {
    const r = await atsGet('/api/ats/offer-contract?application_id=app-oc');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(String(r.body.url)).toContain('/storage/v1/object/sign/');
    expect(String(r.body.url)).toContain('offer_contract');
  });

  it('404s when the offer has no stored contract', async () => {
    const r = await atsGet('/api/ats/offer-contract?application_id=app-mp');
    expect(r.status).toBe(404);
  });

  it('the candidate payload flags offer.has_contract for the drawer link', async () => {
    const r = await atsGet('/api/ceo/candidate?user_id=' + GP4.userId);
    expect(r.status).toBe(200);
    const app = r.body.candidate.apps.find((a) => String(a.id) === 'app-oc');
    expect(app).toBeTruthy();
    expect(app.offer.has_contract).toBe(true);
    // A sibling app WITHOUT a contract does not flag one.
    const r3 = await atsGet('/api/ceo/candidate?user_id=' + GP3.userId);
    const app3 = r3.body.candidate.apps.find((a) => String(a.id) === 'app-mp');
    expect(app3.offer.has_contract).toBe(false);
  });
});

// ── A8a: manual placement ────────────────────────────────────────────────────
describe('A8a — manual "Mark placement secured"', () => {
  it('finalises the placement like a GP self-accept + emails the GP exactly once', async () => {
    const gpBefore = gpEmailsMatching(GP3.email).length;
    const r = await atsPost('/api/ats/placement', { applicationId: 'app-mp' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.placement_secured).toBe(true);
    expect(r.body.ats_stage).toBe('hired');

    const offer = db.ats_offers.find((o) => o.application_id === 'app-mp');
    expect(offer.status).toBe('accepted');
    const app = db.gp_applications.find((a) => a.id === 'app-mp');
    expect(app.status).toBe('placement_secured');
    expect(app.ats_stage).toBe('hired');

    // Placement-of-record row.
    const placementRow = db.placements.find((p) => p.application_id === 'app-mp');
    expect(placementRow).toBeTruthy();
    expect(placementRow.status).toBe('active');

    // gp_career_state written.
    const state = db.user_state.find((s) => s.user_id === GP3.userId).state;
    expect(state.gp_career_state.career_secured).toBe(true);

    // Exactly one "placement is secured" email to the GP.
    const congrats = gpEmailsMatching(GP3.email).slice(gpBefore).filter((c) => /placement is secured/i.test(String(c.body && c.body.subject || '')));
    expect(congrats.length).toBe(1);
  });

  it('a repeat mark is a 409 already-secured (no double placement)', async () => {
    const rowsBefore = db.placements.filter((p) => p.application_id === 'app-mp').length;
    const r = await atsPost('/api/ats/placement', { applicationId: 'app-mp' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('already_secured');
    expect(db.placements.filter((p) => p.application_id === 'app-mp').length).toBe(rowsBefore);
  });

  it('409s when there is no offer on the table', async () => {
    const r = await atsPost('/api/ats/placement', { applicationId: 'app-int' });
    expect(r.status).toBe(409);
  });

  it('a consultant can record a placement too', async () => {
    const r = await atsPost('/api/ats/placement', { applicationId: 'app-mp2' }, consultantCookie());
    expect(r.status).toBe(200);
    expect(r.body.placement_secured).toBe(true);
    expect(db.gp_applications.find((a) => a.id === 'app-mp2').status).toBe('placement_secured');
  });
});

// ── A8b: placements list + commencement edit ─────────────────────────────────
describe('A8b — placements list + commencement edit', () => {
  it('lists the seeded placements newest-first', async () => {
    const r = await atsGet('/api/ats/placements?limit=50');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const mp = r.body.placements.find((p) => p.application_id === 'app-mp');
    expect(mp).toBeTruthy();
    expect(mp.gp_name).toBe('Three Doctor');
    expect(mp.practice_name).toBe('Greenslopes Family Medical');
    expect(mp.job_title).toBe('General Practitioner — VR');
    expect(mp.secured_at).toBeTruthy();
  });

  it('a commencement-date update round-trips', async () => {
    const upd = await atsPost('/api/ats/placement', { applicationId: 'app-mp', mode: 'update', commencementDate: '2026-12-01' });
    expect(upd.status).toBe(200);
    expect(upd.body.ok).toBe(true);
    const r = await atsGet('/api/ats/placements?limit=50');
    const mp = r.body.placements.find((p) => p.application_id === 'app-mp');
    expect(String(mp.commencement_date).slice(0, 10)).toBe('2026-12-01');
  });

  it('update 404s when there is no placement for the application', async () => {
    const r = await atsPost('/api/ats/placement', { applicationId: 'app-oc', mode: 'update', commencementDate: '2026-12-02' });
    expect(r.status).toBe(404);
  });
});

// ── T3: empty-parse ingest keeps 'requested' ─────────────────────────────────
describe('T3 — unparseable practice reply keeps status requested', () => {
  it('does not flip to received when zero windows are parsed', async () => {
    // The deterministic fallback parser always yields windows; the empty case
    // only arises from the AI parser returning []. Drive that here (the stubbed
    // Anthropic response returns []), scoped to this test.
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    try {
      const r = await atsPost('/api/ats/interview/ingest-reply', { application_id: 'app-int', reply_text: 'Thanks for reaching out, we will be in touch shortly.' });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.status).toBe('requested');
      expect(r.body.windows_count).toBe(0);
      const row = db.scheduled_calls.find((c) => c.id === 'int-1');
      expect(row.practice_availability_status).toBe('requested');
    } finally {
      process.env.ANTHROPIC_API_KEY = '';
    }
  });
});

// ── UI: static affordance + cache-buster pins ────────────────────────────────
describe('UI static pins', () => {
  const candJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'ceo-ats-candidates.js'), 'utf8');
  const dashHtml = fs.readFileSync(path.join(__dirname, '..', 'pages', 'ceo-dashboard.html'), 'utf8');

  it('candidates JS wires View CV, View contract and Mark placement secured', () => {
    expect(candJs).toContain('View CV');
    expect(candJs).toContain('ats-cv-view');
    expect(candJs).toContain('View contract');
    expect(candJs).toContain('ats-offer-contract');
    expect(candJs).toContain('Mark placement secured');
    expect(candJs).toContain('ats-mark-placement');
  });

  it('A10: relabels the legacy id + source chip (no bare "Zoho")', () => {
    expect(candJs).toContain('Legacy candidate ID');
    expect(candJs).toContain("'Imported' : 'In-app'");
    expect(candJs).not.toContain('Zoho candidate ID');
  });

  it('use-standard-times is offered in the empty-slots state', () => {
    const idx = candJs.indexOf('No mutually available times');
    expect(idx).toBeGreaterThan(-1);
    const after = candJs.slice(idx, idx + 800);
    expect(after).toContain('ats-int-use-default');
    expect(after).toContain('Use standard times');
  });

  it('the CEO dashboard renders a placements list + loader', () => {
    expect(dashHtml).toContain('placementsListBody');
    expect(dashHtml).toContain('Recent placements');
    expect(dashHtml).toContain('loadPlacementsList');
  });

  it('cache-buster on the candidates script is bumped', () => {
    expect(dashHtml).toContain('ceo-ats-candidates.js?v=20260707g');
  });
});

// Phase 6 C3 (audit S2), audit-log breadth on sensitive ATS/admin actions.
//
// Boots the real server against the in-memory PostgREST emulator (pattern from
// tests/ats-offer-flow.test.js, plus a /storage/v1 sign endpoint) and asserts
// that each sensitive action writes an admin_audit_log row with the right
// action + actor + target:
//   ats_offer_sent, ats_offer_withdrawn, ats_cv_viewed, ats_consultant_added,
//   ats_consultant_removed, ats_stage_changed, ats_placement_recorded,
//   admin_account_status_changed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-audit-breadth-${RUN_ID}.json`);
let server, port;          // app under test
let sbServer, sbPort;      // Supabase (PostgREST + storage) emulator

const SUPER_HOST = 'ceo-audit.local';
const SUPER_EMAIL = 'super@gplink-audit.local';
const GP = { userId: 'u-gp-1', email: 'gp@gplink-audit.local' };
const NOW = new Date().toISOString();

// ── In-memory PostgREST emulator ────────────────────────────────────────────
const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Test', last_name: 'Doctor', registration_country: 'uk' }
  ],
  user_state: [
    { user_id: GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }
  ],
  registration_cases: [
    { id: 'case-1', user_id: GP.userId, status: 'active', assigned_rso: null, assigned_va: null }
  ],
  practices: [
    { id: 'p1', name: 'Greenslopes Family Medical', source: 'internal_ats', contact_name: 'Anna', contact_email: 'anna@greenslopes-test.local', is_active: true, created_at: NOW }
  ],
  career_roles: [
    { id: 'role-1', provider: 'internal_ats', provider_role_id: 'ats_r1', title: 'General Practitioner, VR', practice_name: 'Greenslopes Family Medical', practice_id: 'p1', location_city: 'Brisbane', location_state: 'QLD', is_active: true, job_status: 'open', updated_at: NOW }
  ],
  gp_applications: [
    { id: 'app-1', user_id: GP.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'reviewing', applied_at: NOW },
    { id: 'app-2', user_id: GP.userId, career_role_id: 'role-1', provider_role_id: 'ats_r1', status: 'applied', ats_stage: 'applied', applied_at: NOW }
  ],
  user_documents: [
    { id: 'doc-cv-1', user_id: GP.userId, document_key: 'cv_signed_dated', file_name: 'Doctor-CV.pdf', file_url: '', storage_path: 'users/u-gp-1/cv/current', storage_bucket: 'documents', updated_at: NOW }
  ],
  ats_offers: [],
  ats_stage_events: [],
  placements: [],
  runtime_kv: [],
  admin_audit_log: []
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
      // Storage sign endpoint (candidate-cv / offer-contract signed URLs).
      if (u.pathname.startsWith('/storage/v1/object/sign/') && req.method === 'POST') {
        send(200, { signedURL: '/object/sign/test-signed-path?token=t-' + crypto.randomBytes(4).toString('hex') });
        return;
      }
      // Auth admin endpoints (consultant add creates the Supabase Auth user).
      if (u.pathname.startsWith('/auth/v1/')) { send(200, {}); return; }
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

const atsPost = (p, body) => httpReq('POST', p, { host: SUPER_HOST, cookie: superCookie(), body });
const atsGet = (p) => httpReq('GET', p, { host: SUPER_HOST, cookie: superCookie() });
const atsPatch = (p, body) => httpReq('PATCH', p, { host: SUPER_HOST, cookie: superCookie(), body });
const atsDelete = (p) => httpReq('DELETE', p, { host: SUPER_HOST, cookie: superCookie() });

const auditRows = (action) => db.admin_audit_log.filter((r) => r.action === action);

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'audit-breadth-secret-' + RUN_ID;
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
  process.env.RESEND_API_KEY = '';   // no outbound mail in this suite
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = 'admin-audit.local';
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = '';
  process.env.CONSULTANT_EMAILS = '';

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('audit breadth, sensitive actions write admin_audit_log rows', () => {
  it('offer send → ats_offer_sent with actor + application target', async () => {
    const r = await atsPost('/api/ats/offer', { application_id: 'app-1', billing_split: '70%' });
    expect(r.status).toBe(200);
    const rows = auditRows('ats_offer_sent');
    expect(rows.length).toBe(1);
    expect(rows[0].actor_email).toBe(SUPER_EMAIL);
    expect(rows[0].actor_role).toBe('super_admin');
    expect(rows[0].target_type).toBe('application');
    expect(rows[0].target_id).toBe('app-1');
    expect(rows[0].detail.practice_name).toBe('Greenslopes Family Medical');
    expect(rows[0].success).toBe(true);
  });

  it('offer withdraw → ats_offer_withdrawn', async () => {
    const r = await atsPatch('/api/ats/offer', { application_id: 'app-1', action: 'withdraw' });
    expect(r.status).toBe(200);
    const rows = auditRows('ats_offer_withdrawn');
    expect(rows.length).toBe(1);
    expect(rows[0].target_id).toBe('app-1');
    expect(rows[0].actor_email).toBe(SUPER_EMAIL);
  });

  it('CV view → ats_cv_viewed with the doctor as target (no doc contents)', async () => {
    const r = await atsGet('/api/ats/candidate-cv?user_id=' + GP.userId);
    expect(r.status).toBe(200);
    expect(r.body.url).toBeTruthy();
    const rows = auditRows('ats_cv_viewed');
    expect(rows.length).toBe(1);
    expect(rows[0].target_type).toBe('gp');
    expect(rows[0].target_id).toBe(GP.userId);
    expect(rows[0].actor_email).toBe(SUPER_EMAIL);
    // identifiers only, never the signed URL or file contents
    expect(JSON.stringify(rows[0].detail)).not.toMatch(/token|signed/i);
  });

  it('consultant grant → ats_consultant_added; revoke → ats_consultant_removed', async () => {
    const email = 'new-consultant@gplink-audit.local';
    const add = await atsPost('/api/ats/consultants', { email, name: 'New Consultant' });
    expect(add.status).toBe(200);
    const added = auditRows('ats_consultant_added');
    expect(added.length).toBe(1);
    expect(added[0].target_type).toBe('consultant');
    expect(added[0].target_id).toBe(email);

    const del = await atsDelete('/api/ats/consultants?email=' + encodeURIComponent(email));
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(true);
    const removed = auditRows('ats_consultant_removed');
    expect(removed.length).toBe(1);
    expect(removed[0].target_id).toBe(email);
  });

  it('kanban stage change → ats_stage_changed with from→to detail', async () => {
    const r = await atsPatch('/api/ats/application?id=app-2', { stage: 'interview' });
    expect(r.status).toBe(200);
    const rows = auditRows('ats_stage_changed');
    expect(rows.length).toBe(1);
    expect(rows[0].target_id).toBe('app-2');
    expect(rows[0].detail).toEqual({ from: 'applied', to: 'interview' });
  });

  it('no-op stage PATCH (same stage) writes NO ats_stage_changed row', async () => {
    const before = auditRows('ats_stage_changed').length;
    const r = await atsPatch('/api/ats/application?id=app-2', { stage: 'interview' });
    expect(r.status).toBe(200);
    expect(auditRows('ats_stage_changed').length).toBe(before);
  });

  it('manual placement → ats_placement_recorded', async () => {
    // app-1 already has an offer from the first spec (status was withdrawn),
    // re-send so the placement gate (offer sent/accepted) passes.
    await atsPost('/api/ats/offer', { application_id: 'app-1' });
    const r = await atsPost('/api/ats/placement', { applicationId: 'app-1', commencementDate: '2026-09-01' });
    expect(r.status).toBe(200);
    const rows = auditRows('ats_placement_recorded');
    expect(rows.length).toBe(1);
    expect(rows[0].target_id).toBe('app-1');
    expect(rows[0].detail.commencement_date).toBe('2026-09-01');
  });

  it('admin account-status change → admin_account_status_changed', async () => {
    const r = await atsPost('/api/account/set-status', { email: GP.email, status: 'active' });
    expect(r.status).toBe(200);
    const rows = auditRows('admin_account_status_changed');
    expect(rows.length).toBe(1);
    expect(rows[0].target_type).toBe('gp');
    expect(rows[0].target_id).toBe(GP.email);
    expect(rows[0].detail).toEqual({ status: 'active' });
    expect(rows[0].actor_email).toBe(SUPER_EMAIL);
  });
});

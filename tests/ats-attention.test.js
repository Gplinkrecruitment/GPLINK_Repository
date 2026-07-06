// Phase 5 Task 4 — ATS "Needs attention" visibility (GAPs A3 + A5).
//
// Boots the real server against the same in-memory PostgREST emulator pattern
// as tests/ats-offer-flow.test.js / tests/career-internal-apply.test.js so the
// full Supabase-mode code paths run. Outbound email (Resend) is captured by
// wrapping global fetch.
//
// Covers:
//  1. GET /api/ats/attention returns the correct three counts for seeded
//     fixtures (one fresh application, one declined-offer app still in the offer
//     stage, one interview awaiting practice availability). Consultant can read it.
//  2. POST /api/career/apply fires an ops email to hello@mygplink.com.au with a
//     ?case= deep link — and the apply STILL succeeds when the email transport
//     throws.
//  3. Static UI pins: attention-strip markers, declined pill/kanban markers, and
//     the ceo-dashboard.html cache-busters.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ats-attention-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const SUPER_HOST = 'ceo-attn.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const CONSULTANT_EMAIL = 'consultant@gplink-test.local';
const APPLY_GP = { userId: 'u-apply-gp', email: 'apply@gplink-test.local' };
const NOW = new Date().toISOString();

const resendCalls = [];
let throwOnResend = false;

// ── In-memory PostgREST emulator ────────────────────────────────────────────
const db = {
  user_profiles: [
    { user_id: APPLY_GP.userId, email: APPLY_GP.email, first_name: 'Ada', last_name: 'Applicant', registration_country: 'australia' }
  ],
  user_state: [
    { user_id: APPLY_GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }
  ],
  user_documents: [
    // Task 4: /api/career/apply's CV gate now requires the verified careers
    // CV (document_key 'career_cv'), not a registration-file document.
    { id: 'doc-cv-apply', user_id: APPLY_GP.userId, document_key: 'career_cv', status: 'uploaded' }
  ],
  registration_cases: [
    { id: 'case-apply', user_id: APPLY_GP.userId, status: 'active', assigned_rso: null, assigned_va: null }
  ],
  career_roles: [
    { id: 'role-apply', provider: 'internal_ats', provider_role_id: 'ats_apply1', title: 'DPA - Rosebud - Mixed billing', practice_name: 'Peninsula Family Practice', practice_id: 'p-apply', location_city: 'Rosebud', location_state: 'VIC', is_active: true, job_status: 'open', dpa: true, updated_at: NOW }
  ],
  practices: [
    { id: 'p-apply', name: 'Peninsula Family Practice', source: 'internal_ats', is_active: true, created_at: NOW }
  ],
  // Attention fixtures:
  //   app-fresh    → ats_stage 'applied' within 7d      (new_applications = 1)
  //   app-declined → ats_stage 'offer' + declined offer (declined_offers  = 1)
  gp_applications: [
    { id: 'app-fresh', user_id: 'u-fresh', career_role_id: 'role-apply', provider_role_id: 'ats_apply1', status: 'applied', ats_stage: 'applied', applied_at: NOW },
    { id: 'app-declined', user_id: 'u-declined', career_role_id: 'role-apply', provider_role_id: 'ats_apply1', status: 'offered', ats_stage: 'offer', applied_at: NOW }
  ],
  ats_offers: [
    { id: 'offer-declined', application_id: 'app-declined', user_id: 'u-declined', career_role_id: 'role-apply', status: 'declined', created_at: NOW, updated_at: NOW }
  ],
  // interview requested, practice hasn't replied → interviews_awaiting = 1
  scheduled_calls: [
    { id: 'iv-1', user_id: 'u-declined', meeting_kind: 'interview', status: 'invited', practice_availability_status: 'requested', application_id: 'app-declined', career_role_id: 'role-apply', correlation_token: 'tok-iv-1', created_at: NOW, updated_at: NOW }
  ],
  ats_stage_events: [],
  registration_tasks: [],
  case_events: [],
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

// ── Session cookie minting ──────────────────────────────────────────────────
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
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject); r.end(data);
  });
}

const atsGet = (p, cookie) => httpReq('GET', p, { host: SUPER_HOST, cookie: cookie || superCookie() });
const gpPost = (p, body, who = APPLY_GP) => httpReq('POST', p, { cookie: userCookie(who.email, who.userId), body });

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ats-attn-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.OPENAI_API_KEY = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = 'admin-attn.local';
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.CONSULTANT_EMAILS = CONSULTANT_EMAIL;
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 'test-resend-key';

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.resend.com/')) {
      if (throwOnResend) return Promise.reject(new Error('simulated email transport failure'));
      let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
      resendCalls.push({ url: u, body: parsed });
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
    }
    if (u.startsWith('https://fcm.googleapis.com/')) {
      return Promise.resolve(new Response('{}', { status: 200 }));
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

describe('GET /api/ats/attention — counts', () => {
  it('returns the three seeded counts for the CEO', async () => {
    const r = await atsGet('/api/ats/attention');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.new_applications).toBe(1);      // app-fresh (applied, <7d)
    expect(r.body.declined_offers).toBe(1);       // app-declined (declined offer, still in offer lane)
    expect(r.body.interviews_awaiting).toBe(1);   // iv-1 (requested)
  });

  it('is readable by a consultant session', async () => {
    const r = await atsGet('/api/ats/attention', consultantCookie());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.new_applications).toBe(1);
    expect(r.body.declined_offers).toBe(1);
    expect(r.body.interviews_awaiting).toBe(1);
  });

  it('rejects an unauthenticated caller', async () => {
    const r = await httpReq('GET', '/api/ats/attention', { host: SUPER_HOST });
    expect([401, 403]).toContain(r.status);
  });
});

describe('POST /api/career/apply — ops signal (GAP A3)', () => {
  it('emails hello@ with a ?case= deep link when a GP applies', async () => {
    const before = resendCalls.length;
    const r = await gpPost('/api/career/apply', { roleId: 'internal_ats:ats_apply1' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // Give the fire-and-forget notification block a tick to run.
    await new Promise((res) => setTimeout(res, 60));

    const sends = resendCalls.slice(before);
    const ops = sends.find((c) => /applied to/i.test(String(c.body && c.body.subject)) &&
      JSON.stringify(c.body || {}).includes('hello@mygplink.com.au'));
    expect(ops).toBeTruthy();
    expect(String(ops.body.subject)).toContain('Ada Applicant');
    expect(String(ops.body.subject)).toContain('Peninsula Family Practice');
    const opsText = JSON.stringify(ops.body || {});
    expect(opsText).toContain('?case=');
    expect(opsText).toMatch(/Has CV: yes/);
  });

  it('still succeeds (200 + row saved) when the email transport throws', async () => {
    // A different GP so the duplicate-application guard doesn't 409.
    const GP2 = { userId: 'u-apply-gp2', email: 'apply2@gplink-test.local' };
    db.user_profiles.push({ user_id: GP2.userId, email: GP2.email, first_name: 'Ben', last_name: 'Second', registration_country: 'australia' });
    db.user_state.push({ user_id: GP2.userId, state: { gp_onboarding_complete: true }, updated_at: NOW });
    db.user_documents.push({ id: 'doc-cv-apply2', user_id: GP2.userId, document_key: 'career_cv', status: 'uploaded' });
    db.registration_cases.push({ id: 'case-apply2', user_id: GP2.userId, status: 'active' });

    throwOnResend = true;
    try {
      const r = await gpPost('/api/career/apply', { roleId: 'internal_ats:ats_apply1' }, GP2);
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      await new Promise((res) => setTimeout(res, 60));
      const saved = db.gp_applications.find((a) => a.user_id === GP2.userId && a.career_role_id === 'role-apply');
      expect(saved).toBeTruthy();
    } finally {
      throwOnResend = false;
    }
  });
});

describe('static UI pins', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('candidates JS renders the attention strip + declined pill', () => {
    const js = read('js/ceo-ats-candidates.js');
    expect(js).toContain('ats-attention-strip');
    expect(js).toContain('/api/ats/attention');
    expect(js).toContain('data-attention=');
    expect(js).toContain('Needs attention');
    expect(js).toContain('Declined — action needed');
    expect(js).toContain('data-offer-declined');
  });

  it('jobs JS renders the kanban declined marker', () => {
    const js = read('js/ceo-ats-jobs.js');
    expect(js).toContain('ats-card-declined');
    expect(js).toContain("c.offer_status === 'declined'");
  });

  it('ceo-dashboard.html bumps the changed script cache-busters to 20260707b', () => {
    const html = read('pages/ceo-dashboard.html');
    expect(html).toContain('ceo-ats-candidates.js?v=20260707d');
    expect(html).toContain('ceo-ats-jobs.js?v=20260707b');
  });
});

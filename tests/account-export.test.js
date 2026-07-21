// Phase 6 F4 (GDPR) — GET /api/account/export "Download my data".
//
// Proves, against the REAL server with an in-memory PostgREST emulator:
//   1. Auth-gated (401 anonymous).
//   2. Own-data ONLY: with two seeded GPs, GP1's export contains GP1's
//      profile/documents/applications and NOT ONE BYTE of GP2's.
//   3. Download semantics: Content-Disposition attachment + JSON body.
//   4. Metadata only: no file bytes / storage URLs in the export.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-account-export-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const GP1 = { userId: 'u-exp-a', email: 'export-one@gplink-test.local' };
const GP2 = { userId: 'u-exp-b', email: 'export-two@gplink-test.local' };

const db = {
  user_profiles: [
    { user_id: GP1.userId, email: GP1.email, first_name: 'Exportina', last_name: 'One', registration_country: 'uk', phone: '+44 111' },
    { user_id: GP2.userId, email: GP2.email, first_name: 'Other', last_name: 'Two', registration_country: 'nz', phone: '+64 222' }
  ],
  user_documents: [
    { id: 'doc-gp1', user_id: GP1.userId, document_key: 'medical_degree', country_code: 'uk', status: 'approved', file_name: 'gp1-degree.pdf', file_url: 'users/u-exp-a/secret-path.pdf', created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-02T00:00:00Z' },
    { id: 'doc-gp2', user_id: GP2.userId, document_key: 'medical_degree', country_code: 'nz', status: 'approved', file_name: 'gp2-otherdoc.pdf', file_url: 'users/u-exp-b/other.pdf', created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-02T00:00:00Z' }
  ],
  registration_cases: [
    { id: 'case-gp1', user_id: GP1.userId, stage: 'ahpra', substage: 's80', status: 'active', created_at: '2026-05-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z' },
    { id: 'case-gp2', user_id: GP2.userId, stage: 'amc', substage: null, status: 'active', created_at: '2026-05-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z' }
  ],
  registration_tasks: [
    { id: 't-gp1', case_id: 'case-gp1', title: 'GP1 AHPRA form', task_type: 'todo', status: 'open', created_at: '2026-06-01T00:00:00Z' },
    { id: 't-gp2', case_id: 'case-gp2', title: 'GP2 AMC step', task_type: 'todo', status: 'open', created_at: '2026-06-01T00:00:00Z' }
  ],
  gp_applications: [
    { id: 'app-gp1', user_id: GP1.userId, job_title: 'GP — Sunshine Coast', practice_name: 'DPA Practice One', status: 'applied', ats_stage: 'screening', created_at: '2026-06-10T00:00:00Z' },
    { id: 'app-gp2', user_id: GP2.userId, job_title: 'GP — Hobart', practice_name: 'DPA Practice Two', status: 'applied', ats_stage: 'screening', created_at: '2026-06-10T00:00:00Z' }
  ],
  career_interviews: [],
  user_nudges: [
    { id: 'n-gp1', user_id: GP1.userId, stage: 'ahpra', title: 'GP1 nudge', message: 'Please finish your form', status: 'pending', created_at: '2026-06-11T00:00:00Z' },
    { id: 'n-gp2', user_id: GP2.userId, stage: 'amc', title: 'GP2 nudge', message: 'Other user message', status: 'pending', created_at: '2026-06-11T00:00:00Z' }
  ],
  user_state: [
    { user_id: GP1.userId, state: { gp_onboarding_complete: true }, updated_at: '2026-06-12T00:00:00Z' },
    { user_id: GP2.userId, state: { gp_onboarding_complete: false }, updated_at: '2026-06-12T00:00:00Z' }
  ],
  notification_preferences: [],
  user_session_epoch: [],
  runtime_kv: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'not'];
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue;
    filters.push({ col: key, op, val: raw.slice(dot + 1) });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
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
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      if (u.pathname.startsWith('/auth/v1/')) { send(200, {}); return; }
      if (u.pathname.startsWith('/storage/v1/')) { send(200, { Key: 'ok' }); return; }
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
        const saved = incoming.map((r) => { const row = { id: crypto.randomUUID(), ...r }; rows.push(row); return row; });
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
      send(200, []);
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function userCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}

function httpReq(method, p, { cookie } = {}) {
  return new Promise((resolve, reject) => {
    const h = {};
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'account-export-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 'test-resend-key';

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
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
});

describe('GET /api/account/export (Phase 6 F4, GDPR)', () => {
  it('is auth-gated', async () => {
    const res = await httpReq('GET', '/api/account/export', {});
    expect(res.status).toBe(401);
  });

  it('returns the caller\'s own data with download headers — and nothing from other users', async () => {
    const res = await httpReq('GET', '/api/account/export', { cookie: userCookie(GP1.email, GP1.userId) });
    expect(res.status).toBe(200);

    // Download semantics.
    expect(String(res.headers['content-disposition'] || '')).toMatch(/attachment; filename="gp-link-data-export-.*\.json"/);
    expect(String(res.headers['content-type'] || '')).toContain('application/json');

    // Own data present.
    expect(res.body.account.email).toBe(GP1.email);
    expect(res.body.profile.firstName).toBe('Exportina');
    expect(res.body.documents.some((d) => d.file_name === 'gp1-degree.pdf')).toBe(true);
    expect(res.body.registration.case.stage).toBe('ahpra');
    expect(res.body.registration.tasks.some((t) => t.title === 'GP1 AHPRA form')).toBe(true);
    expect(res.body.applications.some((a) => a.job_title === 'GP — Sunshine Coast')).toBe(true);
    expect(res.body.nudges.some((n) => n.title === 'GP1 nudge')).toBe(true);
    expect(res.body.notificationPreferences).toEqual({ emailNudges: true, whatsapp: true, push: true });

    // NOT ONE BYTE of GP2 anywhere in the raw payload.
    expect(res.raw).not.toContain(GP2.email);
    expect(res.raw).not.toContain('gp2-otherdoc.pdf');
    expect(res.raw).not.toContain('GP2 AMC step');
    expect(res.raw).not.toContain('GP — Hobart');
    expect(res.raw).not.toContain('Other user message');

    // Metadata only — no storage paths / file bytes.
    expect(res.raw).not.toContain('secret-path.pdf');
    expect(res.raw).not.toContain('file_url');
  });

  it('the second GP gets their own export (symmetry check)', async () => {
    const res = await httpReq('GET', '/api/account/export', { cookie: userCookie(GP2.email, GP2.userId) });
    expect(res.status).toBe(200);
    expect(res.body.profile.firstName).toBe('Other');
    expect(res.body.documents.some((d) => d.file_name === 'gp2-otherdoc.pdf')).toBe(true);
    expect(res.raw).not.toContain(GP1.email);
    expect(res.raw).not.toContain('gp1-degree.pdf');
  });
});

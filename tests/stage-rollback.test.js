// Phase 6 G2b — targeted stage rollback (re-open one stage, NOT reset-gp).
//
// Proves, against the REAL server with an in-memory PostgREST emulator:
//   1. POST /api/admin/registration-return-overrides re-opens a specific stage
//      by writing gp_registration_return_overrides into user_state — WITHOUT
//      touching any other state key (non-destructive, unlike admin_reset_gp).
//   2. The action is audit-logged (admin_audit_log: admin_stage_rollback with
//      actor, target GP email and the steps map).
//   3. Auth-gated; unknown GP → 404.
//   4. Static: pages/admin.html ships the "Re-open a stage" control wired to
//      the overrides endpoint (with a confirm step), and the control does not
//      call the destructive reset-gp path.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-stage-rollback-${RUN_ID}.json`);
const SUPER_HOST = 'stage-rollback-test.local';
let server, port;
let sbServer, sbPort;

const GP_EMAIL = 'rollback-gp@gplink-test.local';

const db = {
  user_profiles: [
    { user_id: 'u-roll', email: GP_EMAIL, first_name: 'Rolly', last_name: 'Back' }
  ],
  user_state: [
    {
      user_id: 'u-roll',
      state: {
        gp_epic_progress: '{"stage":"verification_issued","completed":{"create_account":true}}',
        gp_amc_progress: '{"stage":"qualifications_verified"}',
        gp_selected_country: 'GB',
        gp_registration_return_overrides: '{"placement":true,"myintealth":true,"amc":true,"career":true,"ahpra":true,"visa":false,"pbs":false,"commencement":false}'
      },
      updated_at: new Date().toISOString()
    }
  ],
  admin_audit_log: []
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
    if (op === 'neq') return String(cell) !== val;
    if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    if (op === 'in') {
      return val.replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, '')).includes(String(cell));
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
        const conflict = (u.searchParams.get('on_conflict') || '').split(',').map((s) => s.trim()).filter(Boolean);
        const saved = incoming.map((r) => {
          if (conflict.length) {
            const existing = rows.find((row) => conflict.every((c) => String(row[c]) === String(r[c])));
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
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function adminCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const headers = { Host: SUPER_HOST };
    if (cookie) headers.Cookie = cookie;
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'stage-rollback-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
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
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('POST /api/admin/registration-return-overrides — targeted stage rollback', () => {
  // The map the admin UI sends to re-open "amc" for a GP currently in ahpra:
  // natural progression up to the current stage stays open, target forced open.
  const ROLLBACK_STEPS = { placement: true, myintealth: true, amc: true, career: true, ahpra: true, visa: false, pbs: false, commencement: false };

  it('is auth-gated', async () => {
    const r = await httpReq('POST', '/api/admin/registration-return-overrides', { body: { email: GP_EMAIL, steps: ROLLBACK_STEPS } });
    expect([401, 403]).toContain(r.status);
  });

  it('404s for an unknown GP', async () => {
    const r = await httpReq('POST', '/api/admin/registration-return-overrides', { cookie: adminCookie(), body: { email: 'nobody@gplink-test.local', steps: ROLLBACK_STEPS } });
    expect(r.status).toBe(404);
  });

  it('re-opens the chosen stage without wiping any other state (non-destructive)', async () => {
    const r = await httpReq('POST', '/api/admin/registration-return-overrides', {
      cookie: adminCookie(),
      body: { email: GP_EMAIL, steps: ROLLBACK_STEPS }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.email).toBe(GP_EMAIL);
    expect(r.body.steps).toEqual(ROLLBACK_STEPS);

    const row = db.user_state.find((s) => s.user_id === 'u-roll');
    expect(row).toBeTruthy();
    expect(JSON.parse(row.state.gp_registration_return_overrides)).toEqual(ROLLBACK_STEPS);
    // NOT the destructive reset: stage progress + other state keys are untouched
    expect(row.state.gp_epic_progress).toBe('{"stage":"verification_issued","completed":{"create_account":true}}');
    expect(row.state.gp_amc_progress).toBe('{"stage":"qualifications_verified"}');
    expect(row.state.gp_selected_country).toBe('GB');
  });

  it('audit-logs the rollback (admin_stage_rollback)', async () => {
    const entries = db.admin_audit_log.filter((e) => e.action === 'admin_stage_rollback');
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const e = entries[entries.length - 1];
    expect(e.actor_email).toBe('super@gplink-test.local');
    expect(e.target_type).toBe('gp');
    expect(e.target_id).toBe(GP_EMAIL);
    expect(e.detail && e.detail.steps).toEqual(ROLLBACK_STEPS);
    expect(e.success).toBe(true);
  });
});

describe('admin.html — stage rollback control (static)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'pages', 'admin.html'), 'utf8');

  it('ships the Re-open stage control wired to the overrides endpoint with a confirm step', () => {
    expect(html).toContain('data-rollback-stage');
    expect(html).toContain('rollbackStageSel_');
    const fnStart = html.indexOf('async function rollbackStage');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = html.slice(fnStart, fnStart + 2200);
    expect(fnBody).toContain('/api/admin/registration-return-overrides');
    expect(fnBody).toContain('confirm(');
    // Must NOT go anywhere near the destructive full reset
    expect(fnBody).not.toContain('reset-gp');
  });

  it('uses the server stage-gate order, not the UI display order', () => {
    expect(html).toContain('ROLLBACK_STAGE_ORDER=["placement","myintealth","amc","career","ahpra","visa","pbs","commencement"]');
  });
});

// Task 6 — first-class practice link on gp_applications + CEO live hiring funnel.
//
// Boots the real server against the same in-memory PostgREST emulator pattern as
// tests/career-internal-apply.test.js, so the FULL Supabase-mode /api/career/apply
// pipeline runs (gates → guards → practice resolution → insert → VA task), plus
// the CEO /api/ceo/pipeline-summary endpoint with a minted super-admin session.
//
// Covers:
//  1. apply writes practice_id when career_roles.practice_id is set
//  2. apply creates + links a practices row (source 'backfill') by practice_name
//  3. closed internal job apply → 409 job_closed (before any insert)
//  4. /api/ceo/pipeline-summary returns live ats stage counts
//  5. missing practice_id column → retry without it, apply still succeeds
//     (this MUST run last in the file: the server caches the "column missing"
//      determination in a module-level var for the life of the process)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ats-practice-link-${RUN_ID}.json`);
let server, port;          // app under test
let sbServer, sbPort;      // Supabase (PostgREST) emulator

const GP1 = { userId: 'u-gp-1', email: 'gp1@gplink-test.local' };
const GP2 = { userId: 'u-gp-2', email: 'gp2@gplink-test.local' };
const SUPER_HOST = 'ceo-test.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const NOW = new Date().toISOString();

// When true, the emulator rejects gp_applications inserts that carry a
// practice_id, exactly like PostgREST does before the migration is applied.
let rejectPracticeIdInsert = false;

// ── In-memory PostgREST emulator ────────────────────────────────────────────
const db = {
  user_profiles: [
    // Task 11's server-side DPA gate blocks a non-Australia-trained GP from a
    // non-DPA role (these fixture roles don't set `dpa`, so it defaults false
    // per the career_roles schema) — mark both Australia-trained here since
    // this file tests practice-link/CEO-funnel mechanics, not the DPA gate.
    { user_id: GP1.userId, email: GP1.email, first_name: 'Test', last_name: 'DoctorOne', zoho_candidate_id: null, australia_trained: true },
    { user_id: GP2.userId, email: GP2.email, first_name: 'Test', last_name: 'DoctorTwo', zoho_candidate_id: null, australia_trained: true }
  ],
  user_state: [
    { user_id: GP1.userId, state: { gp_onboarding_complete: true }, updated_at: NOW },
    { user_id: GP2.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }
  ],
  user_documents: [
    { id: 'doc-cv-1', user_id: GP1.userId, document_key: 'cv_signed_dated', status: 'uploaded' },
    { id: 'doc-cv-2', user_id: GP2.userId, document_key: 'cv_signed_dated', status: 'uploaded' }
  ],
  user_roles: [],
  practices: [
    { id: 'prac-existing', name: 'Linked Practice', source: 'internal_ats', is_active: true, created_at: NOW }
  ],
  career_roles: [
    // CEO-created ATS job that ALREADY carries a real practices-table link.
    { id: 'role-linked', provider: 'internal_ats', provider_role_id: 'ats_linked', title: 'GP — Linked', practice_name: 'Linked Practice', practice_id: 'prac-existing', is_active: true, job_status: 'open', updated_at: NOW },
    // Manual role whose practice only exists as denormalised text → row must be created.
    { id: 'role-named', provider: 'manual', provider_role_id: 'man_named', title: 'GP — Named', practice_name: 'Sunrise Family Practice', is_active: true, job_status: null, updated_at: NOW },
    // CEO-filled job — apply must be rejected with job_closed.
    { id: 'role-filled', provider: 'internal_ats', provider_role_id: 'ats_filled', title: 'GP — Filled', practice_name: 'Filled Practice', is_active: true, job_status: 'filled', updated_at: NOW },
    // Open job used by the missing-column test (runs last).
    { id: 'role-colmiss', provider: 'internal_ats', provider_role_id: 'ats_colmiss', title: 'GP — Colmiss', practice_name: 'Colmiss Practice', is_active: true, job_status: 'open', updated_at: NOW }
  ],
  gp_applications: [
    // Pre-existing rows so the funnel has stages beyond 'applied'.
    { id: 'app-hired-1', user_id: 'u-other-1', career_role_id: 'role-x', status: 'hired', ats_stage: 'hired', applied_at: NOW },
    { id: 'app-int-1', user_id: 'u-other-2', career_role_id: 'role-y', status: 'interview', ats_stage: 'interview', applied_at: NOW },
    // Unknown stage value → must be counted as 'applied' (the insert default).
    { id: 'app-odd-1', user_id: 'u-other-3', career_role_id: 'role-z', status: 'applied', ats_stage: 'something_odd', applied_at: NOW }
  ]
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
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
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
        // Simulate PostgREST before migration 20260702090000 is applied.
        if (table === 'gp_applications' && rejectPracticeIdInsert &&
            incoming.some((r) => r && Object.prototype.hasOwnProperty.call(r, 'practice_id'))) {
          send(400, {
            code: 'PGRST204',
            message: "Could not find the 'practice_id' column of 'gp_applications' in the schema cache",
            details: null,
            hint: null
          });
          return;
        }
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

// ── App boot + session helpers (pattern from career-internal-apply.test.js) ─
function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function userCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
// Super-admin (CEO) session cookie, minted like tests/ceo-endpoints-smoke.test.js.
function ceoCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: SUPER_EMAIL, adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
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

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ats-practice-link-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  // Zoho stays UNCONFIGURED — isZohoRecruitConfigured() must be false.
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.ZOHO_RECRUIT_REDIRECT_URI = '';
  process.env.OPENAI_API_KEY = '';
  process.env.ADMIN_EMAILS = '';
  // CEO endpoint access: super-admin host scope + email allow-list.
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('practice link on apply (career_roles.practice_id set)', () => {
  it('writes the existing practice_id onto the gp_applications row', async () => {
    const res = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(GP1.email, GP1.userId),
      body: { roleId: 'internal_ats:ats_linked' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.application.practice_id).toBe('prac-existing');

    const saved = db.gp_applications.find((a) => a.user_id === GP1.userId && a.career_role_id === 'role-linked');
    expect(saved).toBeTruthy();
    expect(saved.practice_id).toBe('prac-existing');
    // No duplicate practices row was created for the already-linked practice.
    expect(db.practices.filter((p) => String(p.name).toLowerCase() === 'linked practice').length).toBe(1);
  });
});

describe('practice link on apply (name-only role → create + link)', () => {
  it('creates a practices row (source backfill) and links the application to it', async () => {
    const before = db.practices.length;
    const res = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(GP1.email, GP1.userId),
      body: { roleId: 'manual:man_named' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const prac = db.practices.find((p) => String(p.name).toLowerCase() === 'sunrise family practice');
    expect(prac).toBeTruthy();
    expect(prac.source).toBe('backfill');
    expect(db.practices.length).toBe(before + 1);

    const saved = db.gp_applications.find((a) => a.user_id === GP1.userId && a.career_role_id === 'role-named');
    expect(saved).toBeTruthy();
    expect(saved.practice_id).toBe(prac.id);
  });

  it('reuses the created practice on a second apply for the same practice name', async () => {
    const before = db.practices.length;
    const res = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(GP2.email, GP2.userId),
      body: { roleId: 'manual:man_named' }
    });
    expect(res.status).toBe(200);
    expect(db.practices.length).toBe(before); // no duplicate row
    const prac = db.practices.find((p) => String(p.name).toLowerCase() === 'sunrise family practice');
    const saved = db.gp_applications.find((a) => a.user_id === GP2.userId && a.career_role_id === 'role-named');
    expect(saved.practice_id).toBe(prac.id);
  });
});

describe('closed internal job guard', () => {
  it('rejects an apply to a filled internal_ats job with 409 job_closed before inserting', async () => {
    const before = db.gp_applications.length;
    const res = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(GP2.email, GP2.userId),
      body: { roleId: 'internal_ats:ats_filled' }
    });
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('job_closed');
    expect(res.body.message).toMatch(/no longer open/i);
    expect(db.gp_applications.length).toBe(before); // nothing inserted
  });
});

describe('GET /api/ceo/pipeline-summary — live hiring funnel counts', () => {
  it('returns ats counts grouped by ats_stage (default applied)', async () => {
    const res = await httpReq('GET', '/api/ceo/pipeline-summary', { cookie: ceoCookie(), host: SUPER_HOST });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ats).toBeTruthy();

    // Expected counts derived from the emulator table at this point in the run.
    const known = ['applied', 'submitted', 'reviewing', 'interview', 'offer', 'hired', 'not_proceeding'];
    const expected = { applied: 0, submitted: 0, reviewing: 0, interview: 0, offer: 0, hired: 0, not_proceeding: 0 };
    db.gp_applications.forEach((a) => {
      let k = String(a.ats_stage || '').trim().toLowerCase();
      if (!known.includes(k)) k = 'applied'; // empty/unknown → insert default
      expected[k] += 1;
    });
    expect(res.body.ats).toEqual(expected);
    // The seeded stages are definitely represented.
    expect(res.body.ats.hired).toBeGreaterThanOrEqual(1);
    expect(res.body.ats.interview).toBeGreaterThanOrEqual(1);
    // The applies above (no ats_stage) + the odd-stage row all land in 'applied'.
    expect(res.body.ats.applied).toBeGreaterThanOrEqual(4);
  });

  it('rejects non-CEO sessions', async () => {
    const res = await httpReq('GET', '/api/ceo/pipeline-summary', { cookie: userCookie(GP1.email, GP1.userId), host: SUPER_HOST });
    expect(res.status).not.toBe(200);
  });
});

// MUST stay the LAST describe block: it flips the server's module-level
// "practice_id column missing" cache, which persists for the process.
describe('missing practice_id column tolerance', () => {
  it('retries the insert without practice_id and the apply still succeeds', async () => {
    rejectPracticeIdInsert = true;
    const res = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(GP2.email, GP2.userId),
      body: { roleId: 'internal_ats:ats_colmiss' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const saved = db.gp_applications.find((a) => a.user_id === GP2.userId && a.career_role_id === 'role-colmiss');
    expect(saved).toBeTruthy();
    expect(saved.status).toBe('applied');
    // The retry stripped the unknown column.
    expect(Object.prototype.hasOwnProperty.call(saved, 'practice_id')).toBe(false);
    // The practice row itself was still ensured (resolution is independent of the column).
    expect(db.practices.find((p) => String(p.name).toLowerCase() === 'colmiss practice')).toBeTruthy();
  });

  it('caches the determination: the next apply inserts WITHOUT practice_id on the first try', async () => {
    // Emulator would reject any practice_id insert — a cached server never sends it.
    const res = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(GP1.email, GP1.userId),
      body: { roleId: 'internal_ats:ats_colmiss' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const saved = db.gp_applications.find((a) => a.user_id === GP1.userId && a.career_role_id === 'role-colmiss');
    expect(saved).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(saved, 'practice_id')).toBe(false);
  });
});

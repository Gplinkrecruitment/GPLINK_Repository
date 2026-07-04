// Task 4 — internal ATS jobs visible + applyable by GPs; already-placed guard.
//
// Boots the real server against a tiny in-memory PostgREST emulator (SUPABASE_URL
// points at a local http server), so the FULL Supabase-mode code paths run:
// /api/career/roles DB fallback, /api/career/role, and the whole /api/career/apply
// pipeline (gates → guard → insert → VA follow-up task). Zoho Recruit is left
// UNCONFIGURED (no client id/secret), exactly like production before connect —
// isZohoRecruitConfigured() is false, so any attempted Zoho call would be a
// behavior change these tests would catch via missing rows / thrown errors.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-career-internal-${RUN_ID}.json`);
let server, port;          // app under test
let sbServer, sbPort;      // Supabase (PostgREST) emulator
const nonRestRequests = [];

const GP = { userId: 'u-gp-1', email: 'gp@gplink-test.local' };
const PLACED = { userId: 'u-placed-1', email: 'placed@gplink-test.local' };
const NOW = new Date().toISOString();

// ── In-memory PostgREST emulator ────────────────────────────────────────────
const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Test', last_name: 'Doctor', zoho_candidate_id: null },
    { user_id: PLACED.userId, email: PLACED.email, first_name: 'Placed', last_name: 'Doctor', zoho_candidate_id: null }
  ],
  user_state: [
    { user_id: GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW },
    { user_id: PLACED.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }
  ],
  user_documents: [
    { id: 'doc-cv-gp', user_id: GP.userId, document_key: 'cv_signed_dated', status: 'uploaded' },
    { id: 'doc-cv-placed', user_id: PLACED.userId, document_key: 'cv_signed_dated', status: 'uploaded' }
  ],
  user_roles: [],
  career_roles: [
    // CEO-created in-app ATS job, OPEN → must be GP-visible + applyable.
    // (No location fields on purpose: the /api/career/role detail endpoint
    // only tries hero-image lookups when a location exists.)
    { id: 'role-int-open', provider: 'internal_ats', provider_role_id: 'ats_open1', title: 'General Practitioner — VR', practice_name: 'Greenslopes Family Medical', is_active: true, job_status: 'open', ats_created: true, updated_at: NOW },
    // CEO-created job that was CLOSED (is_active stays true — only job_status flips).
    { id: 'role-int-closed', provider: 'internal_ats', provider_role_id: 'ats_closed1', title: 'GP — Filled role', practice_name: 'Filled Practice', is_active: true, job_status: 'closed', ats_created: true, updated_at: NOW },
    // Admin-entered manual role (job_status null) — behavior must stay identical.
    { id: 'role-manual', provider: 'manual', provider_role_id: 'man_1', title: 'GP — Manual role', practice_name: 'Manual Practice', is_active: true, job_status: null, updated_at: NOW },
    // Stored Zoho role for the unchanged Zoho-path apply test.
    { id: 'role-zoho', provider: 'zoho_recruit', provider_role_id: 'z_123', title: 'GP — Zoho role', practice_name: 'Zoho Practice', is_active: true, updated_at: NOW }
  ],
  gp_applications: [
    // The placed GP's secured placement (what the guard must find).
    { id: 'app-placed-1', user_id: PLACED.userId, career_role_id: 'role-manual', provider_role_id: 'man_1', status: 'hired', applied_at: NOW }
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
      if (!m) { nonRestRequests.push(req.method + ' ' + u.pathname); send(404, { message: 'not found' }); return; }
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

// ── App boot + session helpers (pattern from career-my-interviews.test.js) ──
function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function userCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
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

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'career-internal-secret-' + RUN_ID;
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
  process.env.SUPER_ADMIN_EMAILS = '';

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('GP visibility of internal ATS roles (/api/career/roles + /api/career/role)', () => {
  it('lists an OPEN internal_ats role alongside manual roles, hides CLOSED ones', async () => {
    const res = await httpReq('GET', '/api/career/roles', { cookie: userCookie(GP.email, GP.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const ids = res.body.roles.map((r) => r.id);
    expect(ids).toContain('internal_ats:ats_open1');
    expect(ids).not.toContain('internal_ats:ats_closed1');
    // Manual roles keep working exactly as before (job_status null must NOT drop them).
    expect(ids).toContain('manual:man_1');
  });

  it('serves the job-detail payload for an internal role (pages/job.html loads /api/career/role?id=…)', async () => {
    const res = await httpReq('GET', '/api/career/role?id=' + encodeURIComponent('internal_ats:ats_open1'), { cookie: userCookie(GP.email, GP.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.role.id).toBe('internal_ats:ats_open1');
    expect(res.body.role.roleType).toBe('General Practitioner — VR');
    expect(Array.isArray(res.body.role.detailCards)).toBe(true);
  });
});

describe('POST /api/career/apply — internal_ats path (no Zoho side effects)', () => {
  it('creates the gp_applications row + VA follow-up task with Zoho unconfigured', async () => {
    const res = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(GP.email, GP.userId),
      body: { roleId: 'internal_ats:ats_open1' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const app = res.body.application;
    expect(app.status).toBe('applied');
    expect(app.career_role_id).toBe('role-int-open');
    expect(app.provider_role_id).toBe('ats_open1');
    // No Zoho artifacts on the internal path.
    expect(app.zoho_application_id || null).toBe(null);
    expect(app.zoho_candidate_id || null).toBe(null);

    // Row persisted.
    const saved = db.gp_applications.find((a) => a.user_id === GP.userId && a.career_role_id === 'role-int-open');
    expect(saved).toBeTruthy();
    expect(saved.status).toBe('applied');

    // VA follow-up task created and linked, exactly like the Zoho path.
    const task = tableOf('registration_tasks').find((t) => t.source_trigger === 'career_application');
    expect(task).toBeTruthy();
    expect(task.title).toMatch(/^Submit .* to practice$/);
    expect(task.related_stage).toBe('career');
    expect(saved.submission_task_id).toBe(task.id);
    expect(saved.practice_submission_status).toBe('pending_va_submission');

    // No Zoho candidate was ever provisioned for the GP.
    const profile = db.user_profiles.find((p) => p.user_id === GP.userId);
    expect(profile.zoho_candidate_id || null).toBe(null);
    // The app only ever talked PostgREST to the emulator (no stray auth/storage calls).
    expect(nonRestRequests).toEqual([]);
  });

  it('still 409s a duplicate application to the same internal role (not already_placed)', async () => {
    const res = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(GP.email, GP.userId),
      body: { roleId: 'internal_ats:ats_open1' }
    });
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBeUndefined();
    expect(res.body.message).toMatch(/already applied/i);
  });

  it('GET /api/career/applications returns the internal application with its LOCAL status', async () => {
    const res = await httpReq('GET', '/api/career/applications', { cookie: userCookie(GP.email, GP.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const entry = res.body.applications.find((a) => a.role && a.role.id === 'internal_ats:ats_open1');
    expect(entry).toBeTruthy();
    expect(entry.status).toBe('applied'); // no Zoho status to merge → local fallback
    expect(entry.role.roleType).toBe('General Practitioner — VR');
  });
});

describe('POST /api/career/apply — already-placed guard', () => {
  it('rejects a GP with a secured placement with 409 already_placed', async () => {
    const res = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(PLACED.email, PLACED.userId),
      body: { roleId: 'internal_ats:ats_open1' }
    });
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('already_placed');
    expect(res.body.message).toMatch(/secured placement/i);
    // Nothing inserted for the placed GP.
    expect(db.gp_applications.filter((a) => a.user_id === PLACED.userId).length).toBe(1);
  });
});

describe('POST /api/career/apply — Zoho path unchanged', () => {
  it('an unplaced GP can still apply to a zoho_recruit role (no regression)', async () => {
    const res = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(GP.email, GP.userId),
      body: { roleId: 'zoho_recruit:z_123' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.application.provider_role_id).toBe('z_123');
    expect(res.body.application.status).toBe('applied');
    const saved = db.gp_applications.find((a) => a.user_id === GP.userId && a.career_role_id === 'role-zoho');
    expect(saved).toBeTruthy();
  });
});

// Task 10 follow-up — identity masking in the applications feed. The GP now
// has two live applications (role-int-open 'Greenslopes Family Medical' and
// role-zoho 'Zoho Practice'); neither has passed the reveal rule yet, so the
// real practice names must not appear ANYWHERE in the response. Seeding an
// ACCEPTED offer for the internal application must then reveal that entry
// (and only that entry).
describe('GET /api/career/applications — identity reveal gate', () => {
  it("a non-revealed application's entry never carries the real practice name anywhere in the response", async () => {
    const res = await httpReq('GET', '/api/career/applications', { cookie: userCookie(GP.email, GP.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const entry = res.body.applications.find((a) => a.role && a.role.id === 'internal_ats:ats_open1');
    expect(entry).toBeTruthy();
    // Masked value (no masked_title on this role → the serializer's generic
    // masked fallback, e.g. 'Australian GP practice' / 'Confidential GP
    // practice') — the exact copy doesn't matter, the real name must be gone.
    expect(entry.role.practiceName).toBeTruthy();
    expect(entry.role.practiceName).not.toContain('Greenslopes');
    expect(entry.role.revealed).toBeUndefined();
    expect(res.raw).not.toContain('Greenslopes Family Medical');
    expect(res.raw).not.toContain('Zoho Practice');
  });

  it('an accepted-offer application DOES reveal the real practice name — and only that one', async () => {
    const app = db.gp_applications.find((a) => a.user_id === GP.userId && a.career_role_id === 'role-int-open');
    expect(app).toBeTruthy();
    tableOf('ats_offers').push({
      id: 'offer-reveal-1', application_id: String(app.id), status: 'accepted',
      sent_at: NOW, created_at: NOW, updated_at: NOW
    });

    const res = await httpReq('GET', '/api/career/applications', { cookie: userCookie(GP.email, GP.userId) });
    expect(res.status).toBe(200);
    const revealedEntry = res.body.applications.find((a) => a.role && a.role.id === 'internal_ats:ats_open1');
    expect(revealedEntry).toBeTruthy();
    expect(revealedEntry.role.practiceName).toBe('Greenslopes Family Medical');
    expect(revealedEntry.role.revealed).toBe(true);

    // The GP's OTHER application (no offer) stays masked in the same response.
    const maskedEntry = res.body.applications.find((a) => a.role && a.role.id === 'zoho_recruit:z_123');
    expect(maskedEntry).toBeTruthy();
    expect(maskedEntry.role.practiceName).not.toBe('Zoho Practice');
    expect(res.raw).not.toContain('Zoho Practice');
  });
});

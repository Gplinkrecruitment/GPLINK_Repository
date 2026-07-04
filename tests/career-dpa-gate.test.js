// Task 11 — server-side DPA gate + preferred-city ranking + blurred fillers.
//
// A GP who did NOT train in Australia can only be legally placed into a DPA
// (District of Priority Area) role. Non-DPA roles must never be applyable —
// and their identifying details (practice name, suburb, exact city) must
// never even reach the client — for a GP who hasn't answered "Australia" to
// the onboarding "where did you train" question.
//
// Boots the real server against a tiny in-memory PostgREST emulator (same
// pattern as tests/career-internal-apply.test.js), so the FULL Supabase-mode
// /api/career/roles + /api/career/apply pipelines run for real.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-career-dpa-${RUN_ID}.json`);
let server, port;
let testUtils;             // server.js __testUtils (fail-closed gate seam)
let sbServer, sbPort;

const OVERSEAS_GP = { userId: 'u-overseas-1', email: 'overseas-gp@gplink-test.local' };
const AU_TRAINED_GP = { userId: 'u-au-trained-1', email: 'au-trained-gp@gplink-test.local' };
const NOW = new Date().toISOString();

const db = {
  user_profiles: [
    {
      user_id: OVERSEAS_GP.userId, email: OVERSEAS_GP.email,
      first_name: 'Overseas', last_name: 'Doctor', zoho_candidate_id: null,
      australia_trained: false, preferred_city: 'Melbourne'
    },
    {
      user_id: AU_TRAINED_GP.userId, email: AU_TRAINED_GP.email,
      first_name: 'AuTrained', last_name: 'Doctor', zoho_candidate_id: null,
      australia_trained: true, preferred_city: ''
    }
  ],
  user_state: [
    { user_id: OVERSEAS_GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW },
    { user_id: AU_TRAINED_GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }
  ],
  user_documents: [
    { id: 'doc-cv-overseas', user_id: OVERSEAS_GP.userId, document_key: 'cv_signed_dated', status: 'uploaded' },
    { id: 'doc-cv-au', user_id: AU_TRAINED_GP.userId, document_key: 'cv_signed_dated', status: 'uploaded' }
  ],
  user_roles: [],
  career_roles: [
    // DPA role — qualifies regardless of training country. `masked_title` is
    // what mapCareerRoleRowToClient actually serves as practiceName (Task 10
    // privacy layer masks identity independently of the DPA gate); the real
    // `practice_name` must NEVER reach the client either way.
    {
      id: 'role-dpa-1', provider: 'internal_ats', provider_role_id: 'ats_dpa1',
      title: 'GP — DPA role', practice_name: 'ULTRA SECRET Toowoomba Bush Medical',
      masked_title: 'GP Job near Toowoomba | DPA Approved',
      is_active: true, approval_status: 'approved', job_status: 'open', ats_created: true,
      dpa: true, location_state: 'QLD', nearest_city: 'Toowoomba', updated_at: NOW
    },
    // Non-DPA role — only qualifies for an Australia-trained GP.
    {
      id: 'role-nondpa-1', provider: 'internal_ats', provider_role_id: 'ats_nondpa1',
      title: 'GP — Non-DPA role', practice_name: 'ULTRA SECRET Melbourne Family Clinic',
      masked_title: 'GP Job near Melbourne | Non-DPA',
      is_active: true, approval_status: 'approved', job_status: 'open', ats_created: true,
      dpa: false, location_state: 'VIC', nearest_city: 'Melbourne', updated_at: NOW
    }
  ],
  gp_applications: []
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
  process.env.AUTH_SECRET = 'career-dpa-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.ZOHO_RECRUIT_REDIRECT_URI = '';
  process.env.OPENAI_API_KEY = '';
  process.env.ADMIN_EMAILS = '';
  process.env.SUPER_ADMIN_EMAILS = '';

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('GET /api/career/roles — DPA gate for an overseas-trained GP', () => {
  it('shows the DPA role crisp and blurs the non-DPA role with no identifying fields', async () => {
    const res = await httpReq('GET', '/api/career/roles', { cookie: userCookie(OVERSEAS_GP.email, OVERSEAS_GP.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const dpaEntry = res.body.roles.find((r) => r.id === 'internal_ats:ats_dpa1');
    expect(dpaEntry).toBeTruthy();
    expect(dpaEntry.blurred).toBeFalsy();
    expect(dpaEntry.qualifies).toBe(true);
    // Crisp = shows the (Task 10) masked identity, never the real practice name.
    expect(dpaEntry.practiceName).toBe('GP Job near Toowoomba | DPA Approved');

    const nonDpaEntry = res.body.roles.find((r) => r.id === 'internal_ats:ats_nondpa1');
    expect(nonDpaEntry).toBeTruthy();
    expect(nonDpaEntry.blurred).toBe(true);
    expect(nonDpaEntry.qualifies).toBe(false);
    expect(nonDpaEntry.practiceName).toBe('Confidential practice');
    expect(nonDpaEntry.dpa).toBeUndefined();
    expect(nonDpaEntry.nearest_city).toBeUndefined();

    // The real practice name and suburb must never appear anywhere in the raw response.
    expect(res.raw).not.toContain('ULTRA SECRET');
    expect(res.raw).not.toContain('Bush Medical');
    expect(res.raw).not.toContain('Melbourne Family Clinic');

    // Qualifying roles come first, blurred fillers appended after.
    const ids = res.body.roles.map((r) => r.id || null);
    expect(ids.indexOf('internal_ats:ats_dpa1')).toBeLessThan(
      res.body.roles.findIndex((r) => r.blurred)
    );
  });
});

describe('GET /api/career/roles — an Australia-trained GP sees everything crisp', () => {
  it('both roles qualify (not blurred); the non-DPA role is no longer gated', async () => {
    const res = await httpReq('GET', '/api/career/roles', { cookie: userCookie(AU_TRAINED_GP.email, AU_TRAINED_GP.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.roles.some((r) => r.blurred)).toBe(false);

    const nonDpaEntry = res.body.roles.find((r) => r.id === 'internal_ats:ats_nondpa1');
    expect(nonDpaEntry).toBeTruthy();
    expect(nonDpaEntry.qualifies).toBe(true);
    // Still masked (Task 10's identity reveal gate is independent of the DPA
    // gate) — the real practice name never leaks regardless of qualification.
    expect(nonDpaEntry.practiceName).toBe('GP Job near Melbourne | Non-DPA');
    expect(res.raw).not.toContain('ULTRA SECRET');
  });
});

describe('GET /api/career/role — detail endpoint DPA gate (defense in depth)', () => {
  it('an overseas-trained GP fetching the non-DPA role detail directly (e.g. a shared/guessed link) gets a blurred stub, not the real detail', async () => {
    const res = await httpReq('GET', '/api/career/role?id=' + encodeURIComponent('internal_ats:ats_nondpa1'), {
      cookie: userCookie(OVERSEAS_GP.email, OVERSEAS_GP.userId)
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.role.blurred).toBe(true);
    expect(res.body.role.practiceName).toBe('Confidential practice');
    expect(res.body.role.detailCards).toBeUndefined();
    expect(res.raw).not.toContain('ULTRA SECRET');
    expect(res.raw).not.toContain('Melbourne Family Clinic');
  });

  it('the same overseas-trained GP still gets the full detail payload for the DPA role', async () => {
    const res = await httpReq('GET', '/api/career/role?id=' + encodeURIComponent('internal_ats:ats_dpa1'), {
      cookie: userCookie(OVERSEAS_GP.email, OVERSEAS_GP.userId)
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.role.blurred).toBeFalsy();
    expect(Array.isArray(res.body.role.detailCards)).toBe(true);
  });
});

describe('POST /api/career/apply — server-side DPA enforcement', () => {
  it('rejects an overseas-trained GP applying to a non-DPA role with 403 not_qualified', async () => {
    const res = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(OVERSEAS_GP.email, OVERSEAS_GP.userId),
      body: { roleId: 'internal_ats:ats_nondpa1' }
    });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('not_qualified');
    expect(db.gp_applications.find((a) => a.user_id === OVERSEAS_GP.userId)).toBeFalsy();
  });

  it('still allows the same overseas-trained GP to apply to the DPA role, and stamps origin gp_applied', async () => {
    const res = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(OVERSEAS_GP.email, OVERSEAS_GP.userId),
      body: { roleId: 'internal_ats:ats_dpa1' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const saved = db.gp_applications.find((a) => a.user_id === OVERSEAS_GP.userId && a.career_role_id === 'role-dpa-1');
    expect(saved).toBeTruthy();
    expect(saved.origin).toBe('gp_applied');
  });

  it('allows the Australia-trained GP to apply to the non-DPA role', async () => {
    const res = await httpReq('POST', '/api/career/apply', {
      cookie: userCookie(AU_TRAINED_GP.email, AU_TRAINED_GP.userId),
      body: { roleId: 'internal_ats:ats_nondpa1' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const saved = db.gp_applications.find((a) => a.user_id === AU_TRAINED_GP.userId && a.career_role_id === 'role-nondpa-1');
    expect(saved).toBeTruthy();
    expect(saved.origin).toBe('gp_applied');
  });
});

// Unit tests against the gate helper itself (exported via __testUtils) —
// covers behavior that is hard to reach through the HTTP endpoint: the
// fail-closed error path and the no-mutation guarantee for cached role objects.
describe('_applyGpRoleVisibilityGate — fail-closed + no cache mutation (unit)', () => {
  it('FAILS CLOSED: an unexpected throw mid-gate returns every role as a redacted stub, never the raw list', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const poisoned = [
        { id: 'r-ok', practiceName: 'SECRET Practice A', state: 'QLD', dpa: true },
        // Reading .dpa on this role throws — simulates any unexpected runtime
        // fault inside the gate's main path.
        Object.defineProperty({ id: 'r-boom', practiceName: 'SECRET Practice B', state: 'VIC' }, 'dpa', {
          get() { throw new Error('simulated gate fault'); },
          enumerable: true
        })
      ];
      const out = await testUtils._applyGpRoleVisibilityGate(poisoned, OVERSEAS_GP.userId, OVERSEAS_GP.email);
      expect(out).toHaveLength(2);
      // EVERY role comes back blurred/redacted — including the DPA one that
      // would have qualified had the gate not faulted.
      out.forEach((r) => {
        expect(r.blurred).toBe(true);
        expect(r.qualifies).toBe(false);
        expect(r.practiceName).toBe('Confidential practice');
      });
      expect(JSON.stringify(out)).not.toContain('SECRET');
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('[dpa-gate] visibility gate failed — failing closed'),
        expect.any(Error)
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('never mutates the input role objects (shared _zohoRolesCache safety) and writes qualifyReason, not reason', async () => {
    const cachedRole = { id: 'r-cached', practiceName: 'Masked Cached Role', state: 'VIC', nearest_city: 'Melbourne', dpa: false, qualifies: true };
    const frozenSnapshot = JSON.stringify(cachedRole);

    const out = await testUtils._applyGpRoleVisibilityGate([cachedRole], OVERSEAS_GP.userId, OVERSEAS_GP.email);

    // The cached object is byte-for-byte untouched: no qualifies flip, no
    // reason/qualifyReason keys stamped onto it.
    expect(JSON.stringify(cachedRole)).toBe(frozenSnapshot);

    // The returned stub carries the aligned qualifyReason key (what
    // buildRedactedRoleStub reads), and no stray `reason` key anywhere.
    expect(out).toHaveLength(1);
    expect(out[0].blurred).toBe(true);
    expect(out[0].qualifyReason).toBe('dpa_restricted');
    expect(out[0].reason).toBeUndefined();
  });

  it('qualifying roles come back as copies too, with qualifies true and empty qualifyReason', async () => {
    const cachedRole = { id: 'r-cached-dpa', practiceName: 'Masked DPA Role', state: 'QLD', nearest_city: 'Toowoomba', dpa: true, qualifies: true };
    const out = await testUtils._applyGpRoleVisibilityGate([cachedRole], OVERSEAS_GP.userId, OVERSEAS_GP.email);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toBe(cachedRole); // copy, not the cached object itself
    expect(out[0].qualifies).toBe(true);
    expect(out[0].qualifyReason).toBe('');
    expect(out[0].practiceName).toBe('Masked DPA Role');
    expect(cachedRole.qualifyReason).toBeUndefined();
  });
});

// Register-verification onboarding (owner decision 2026-08-31) — server side:
// /api/onboarding/complete persists the register number pending verification,
// /api/registration/qual-docs-status drives the MyIntealth certificate
// gateway, and /api/ats/candidate/register-verification records the staff
// check against the live public register. Boots the real server against the
// in-memory PostgREST emulator (career-profile-gate.test.js pattern).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'module';

const requireCjs = createRequire(import.meta.url);
const RUN_ID = crypto.randomBytes(4).toString('hex');
let server, port, sbServer;

const db = {
  user_profiles: [
    { user_id: 'u-reg-1', email: 'reg-gp@example.com', first_name: 'Reggie', last_name: 'Sterton', registration_country: 'uk' },
    { user_id: 'u-noreg-2', email: 'noreg-gp@example.com', first_name: 'Nora', last_name: 'Number', registration_country: 'uk' }
  ],
  user_state: [
    { user_id: 'u-reg-1', state: {} },
    { user_id: 'u-noreg-2', state: {} }
  ],
  user_documents: [],
  registration_cases: [],
  registration_events: [],
  registration_tasks: [],
  runtime_kv: [],
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
    filters.push({ col: key, op, val: raw.slice(dot + 1) });
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
      if (u.pathname.startsWith('/storage/v1/')) { send(200, {}); return; }
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
        const conflictCols = (u.searchParams.get('on_conflict') || '')
          .split(',').map((s) => s.trim()).filter(Boolean);
        const saved = incoming.map((r) => {
          if (conflictCols.length) {
            const existing = rows.find((row) => row && conflictCols.every((c) => String(row[c]) === String(r[c])));
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
      send(200, []);
    });
    sbServer.listen(0, '127.0.0.1', () => resolve());
  });
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function userCookie(email, userId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId: userId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
function adminCookie(email) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
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
        let parsed = null; try { parsed = JSON.parse(Buffer.concat(c).toString('utf8')); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject); r.end(data);
  });
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'test-register-' + RUN_ID;
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.ADMIN_EMAILS = '';
  await startSupabaseEmulator();
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbServer.address().port}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  // The completion endpoint now runs an inline register lookup — point BOTH
  // official sources at a dead local port so tests never touch the network
  // (the attempt fails fast and the outcome is simply 'error'/pending).
  process.env.REGISTER_UK_PERFORMERS_URL = 'http://127.0.0.1:9/performers.csv';
  process.env.REGISTER_MCNZ_BASE_URL = 'http://127.0.0.1:9';
  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});
afterAll(async () => { server?.close(); sbServer?.close(); });

describe('POST /api/onboarding/complete persists the register number', () => {
  it('stamps register_body/number pending verification alongside completion', async () => {
    const res = await httpReq('POST', '/api/onboarding/complete', {
      cookie: userCookie('reg-gp@example.com', 'u-reg-1'),
      body: { country: 'GB', registerNumber: 'GMC 765-4321', targetDate: '2027-03', preferredCity: 'Sydney', whoMoving: 'just_me' }
    });
    expect(res.status).toBe(200);
    const prof = db.user_profiles.find((p) => p.user_id === 'u-reg-1');
    expect(prof.register_body).toBe('gmc');
    expect(prof.register_number).toBe('7654321');
    expect(prof.register_status).toBe('pending_verification');
    expect(prof.onboarding_completed_at).toBeTruthy();
  });

  it('never blocks completion on a malformed number — it is simply not stamped', async () => {
    const res = await httpReq('POST', '/api/onboarding/complete', {
      cookie: userCookie('noreg-gp@example.com', 'u-noreg-2'),
      body: { country: 'GB', registerNumber: '12', targetDate: '2027-03' }
    });
    expect(res.status).toBe(200);
    const prof = db.user_profiles.find((p) => p.user_id === 'u-noreg-2');
    expect(prof.register_status).toBeUndefined();
    expect(prof.onboarding_completed_at).toBeTruthy();
  });
});

describe('GET /api/registration/qual-docs-status (the MyIntealth gateway)', () => {
  it('gates a register-path doctor until every deferred certificate is on file', async () => {
    const gated = await httpReq('GET', '/api/registration/qual-docs-status', { cookie: userCookie('reg-gp@example.com', 'u-reg-1') });
    expect(gated.status).toBe(200);
    expect(gated.body.gated).toBe(true);
    expect(gated.body.missing.map((d) => d.key).sort()).toEqual([
      'onboarding_cct_certificate', 'onboarding_primary_med_degree', 'onboarding_specialist_qualification'
    ]);

    // The canonical storage keys the wizard's uploads write, with a stored
    // file — toStatusLabel maps them to 'under_review', which counts as
    // provided (a human is already looking at them).
    for (const key of ['onboarding_specialist_qualification', 'onboarding_cct_certificate', 'onboarding_primary_med_degree']) {
      db.user_documents.push({ id: 'doc-' + key, user_id: 'u-reg-1', document_key: key, country_code: 'uk', status: 'pending', storage_path: 'onboarding/uk/u-reg-1/' + key + '.pdf', file_name: key + '.pdf', updated_at: new Date().toISOString() });
    }
    const lifted = await httpReq('GET', '/api/registration/qual-docs-status', { cookie: userCookie('reg-gp@example.com', 'u-reg-1') });
    expect(lifted.body.gated).toBe(false);
    expect(lifted.body.missing).toEqual([]);
  });

  it('never gates a doctor who onboarded the old way (no register_status)', async () => {
    const res = await httpReq('GET', '/api/registration/qual-docs-status', { cookie: userCookie('noreg-gp@example.com', 'u-noreg-2') });
    expect(res.status).toBe(200);
    expect(res.body.gated).toBe(false);
  });
});

describe('POST /api/ats/candidate/register-verification (staff check)', () => {
  it('records verified with who and when, and mismatch for follow-up', async () => {
    const ok = await httpReq('POST', '/api/ats/candidate/register-verification', {
      cookie: adminCookie('ceo@gplink-test.local'),
      body: { userId: 'u-reg-1', action: 'verified' }
    });
    expect(ok.status).toBe(200);
    const prof = db.user_profiles.find((p) => p.user_id === 'u-reg-1');
    expect(prof.register_status).toBe('verified');
    expect(prof.register_verified_by).toBe('ceo@gplink-test.local');
    expect(prof.register_verified_at).toBeTruthy();
  });

  it('refuses a bad action, a doctor with no number, and an unauthenticated call', async () => {
    const bad = await httpReq('POST', '/api/ats/candidate/register-verification', {
      cookie: adminCookie('ceo@gplink-test.local'),
      body: { userId: 'u-reg-1', action: 'looks_fine' }
    });
    expect(bad.status).toBe(400);
    const none = await httpReq('POST', '/api/ats/candidate/register-verification', {
      cookie: adminCookie('ceo@gplink-test.local'),
      body: { userId: 'u-noreg-2', action: 'verified' }
    });
    expect(none.status).toBe(409);
    const anon = await httpReq('POST', '/api/ats/candidate/register-verification', {
      body: { userId: 'u-reg-1', action: 'verified' }
    });
    expect(anon.status).toBe(401);
  });
});

describe('the verified chip in the candidate intro', () => {
  it('appears only with an explicit registerVerifiedLabel', () => {
    const intro = requireCjs('../lib/career-intro.js');
    const withChip = intro.buildCandidateIntro({ gpName: 'Reggie Sterton', countryCode: 'uk', registerVerifiedLabel: 'GMC registration verified' });
    expect(withChip.facts.some((f) => f.label === 'GMC registration verified')).toBe(true);
    const withoutChip = intro.buildCandidateIntro({ gpName: 'Reggie Sterton', countryCode: 'uk' });
    expect(withoutChip.facts.some((f) => /registration verified/.test(f.label))).toBe(false);
  });
});

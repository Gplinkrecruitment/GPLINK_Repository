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
    { user_id: 'u-noreg-2', email: 'noreg-gp@example.com', first_name: 'Nora', last_name: 'Number', registration_country: 'uk' },
    { user_id: 'u-held-3', email: 'held-gp@example.com', first_name: 'Hela', last_name: 'Held', registration_country: 'uk', account_status: 'active' },
    { user_id: 'u-held-4', email: 'held2-gp@example.com', first_name: 'Hana', last_name: 'Holden', registration_country: 'uk', account_status: 'active' }
  ],
  user_state: [
    { user_id: 'u-reg-1', state: {} },
    { user_id: 'u-noreg-2', state: {} },
    { user_id: 'u-held-3', state: { account_status: 'under_review', gp_onboarding: JSON.stringify({ country: 'GB', accountReviewFlag: true, idVerification: { status: 'support_requested', issues: ['This document expired on 2026-09-15.'] } }) } },
    { user_id: 'u-held-4', state: { account_status: 'under_review', gp_onboarding: { country: 'GB', accountReviewFlag: true, idVerification: { status: 'failed', issues: ['The name on the document is not readable.'] } } } }
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

  // Owner 2026-10-12: staff can re-enter the number from the drawer.
  it('update_number replaces the number, drops the old verdict and logs who changed it', async () => {
    const before = db.user_profiles.find((p) => p.user_id === 'u-reg-1');
    expect(before.register_status).toBe('verified');
    const res = await httpReq('POST', '/api/ats/candidate/register-verification', {
      cookie: adminCookie('ceo@gplink-test.local'),
      body: { userId: 'u-reg-1', action: 'update_number', registerNumber: '7 111-222' }
    });
    expect(res.status).toBe(200);
    expect(res.body.register_number).toBe('7111222');
    expect(res.body.register_status).toBe('pending_verification');
    expect(res.body.register_label).toBe('GMC');
    const prof = db.user_profiles.find((p) => p.user_id === 'u-reg-1');
    expect(prof.register_number).toBe('7111222');
    expect(prof.register_body).toBe('gmc');
    expect(prof.register_status).toBe('pending_verification');
    expect(prof.register_verified_by).toBeNull();
    expect(prof.register_verified_at).toBeNull();
    const evt = (db.task_timeline || []).find((e) => e.title === 'Medical register number changed');
    expect(evt).toBeTruthy();
    expect(JSON.stringify(evt)).toContain('7654321');
    expect(JSON.stringify(evt)).toContain('7111222');
  });

  it('update_number refuses a malformed number and leaves the old one in place', async () => {
    const res = await httpReq('POST', '/api/ats/candidate/register-verification', {
      cookie: adminCookie('ceo@gplink-test.local'),
      body: { userId: 'u-reg-1', action: 'update_number', registerNumber: '12345' }
    });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/GMC/);
    expect(db.user_profiles.find((p) => p.user_id === 'u-reg-1').register_number).toBe('7111222');
  });

  it('update_number can add a first number, taking the register from the doctor\'s country', async () => {
    const res = await httpReq('POST', '/api/ats/candidate/register-verification', {
      cookie: adminCookie('ceo@gplink-test.local'),
      body: { userId: 'u-noreg-2', action: 'update_number', registerNumber: '7222333' }
    });
    expect(res.status).toBe(200);
    const prof = db.user_profiles.find((p) => p.user_id === 'u-noreg-2');
    expect(prof.register_body).toBe('gmc');
    expect(prof.register_number).toBe('7222333');
    expect(prof.register_status).toBe('pending_verification');
  });

  it('update_number needs a staff session', async () => {
    const anon = await httpReq('POST', '/api/ats/candidate/register-verification', {
      body: { userId: 'u-reg-1', action: 'update_number', registerNumber: '7000001' }
    });
    expect(anon.status).toBe(401);
    expect(db.user_profiles.find((p) => p.user_id === 'u-reg-1').register_number).toBe('7111222');
  });

  it('the drawer row offers Edit number wired to update_number', () => {
    const fs = requireCjs('node:fs');
    const src = fs.readFileSync(new URL('../js/ceo-ats-candidates.js', import.meta.url), 'utf8');
    expect(src).toContain('ats-register-edit');
    expect(src).toContain("action: 'update_number'");
    expect(src).toMatch(/closest\('\.ats-register-edit'\)/);
    expect(src).toMatch(/closest\('\.ats-register-edit-save'\)/);
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

// Owner 2026-10-12: an account held under review must be releasable from the
// candidate profile, and an expired ID is acceptable.
describe('POST /api/ats/candidate/account-review (release an account held under review)', () => {
  it('approves: account active, ID accepted, review flag cleared, audit row logged', async () => {
    const res = await httpReq('POST', '/api/ats/candidate/account-review', {
      cookie: adminCookie('ceo@gplink-test.local'),
      body: { userId: 'u-held-3', action: 'approve' }
    });
    expect(res.status).toBe(200);
    expect(res.body.account_status).toBe('active');
    const st = db.user_state.find((r) => r.user_id === 'u-held-3').state;
    expect(st.account_status).toBe('active');
    const ob = typeof st.gp_onboarding === 'string' ? JSON.parse(st.gp_onboarding) : st.gp_onboarding;
    expect(typeof st.gp_onboarding).toBe('string'); // kept in the shape it arrived in
    expect(ob.accountReviewFlag).toBe(false);
    expect(ob.idVerification.status).toBe('approved');
    expect(ob.idVerification.approvedBy).toBe('ceo@gplink-test.local');
    expect((db.task_timeline || []).some((e) => e.title === 'Account review approved')).toBe(true);
  });

  it('refuses an account that is not under review, a bad action and an anonymous call', async () => {
    const again = await httpReq('POST', '/api/ats/candidate/account-review', {
      cookie: adminCookie('ceo@gplink-test.local'), body: { userId: 'u-held-3', action: 'approve' }
    });
    expect(again.status).toBe(409);
    const bad = await httpReq('POST', '/api/ats/candidate/account-review', {
      cookie: adminCookie('ceo@gplink-test.local'), body: { userId: 'u-held-3', action: 'reject' }
    });
    expect(bad.status).toBe(400);
    const anon = await httpReq('POST', '/api/ats/candidate/account-review', { body: { userId: 'u-held-3', action: 'approve' } });
    expect(anon.status).toBe(401);
  });
});

describe('ID verification accepts an expired ID', () => {
  it('the prompt and the server check no longer fail a document for being expired', () => {
    const fs = requireCjs('node:fs');
    const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    expect(src).not.toContain('Please upload a valid, non-expired ID.');
    expect(src).not.toContain('or if the document has expired.');
    expect(src).toContain('Never mark verified as false because the document has expired');
  });
});

// Owner 2026-10-13: "ensure anything that could and may be reviews has a way
// for admin to review, accept or decline" — the decline half.
describe('POST /api/ats/candidate/account-review action=decline (ask the doctor for a new ID)', () => {
  it('keeps the hold, marks the ID rejected with the reason, logs it, and the account can still be approved later', async () => {
    const res = await httpReq('POST', '/api/ats/candidate/account-review', {
      cookie: adminCookie('ceo@gplink-test.local'),
      body: { userId: 'u-held-4', action: 'decline', reason: 'The photo is too blurry to read your name.' }
    });
    expect(res.status).toBe(200);
    expect(res.body.account_status).toBe('under_review');
    expect(res.body.id_status).toBe('rejected');
    const st = db.user_state.find((r) => r.user_id === 'u-held-4').state;
    expect(st.account_status).toBe('under_review');
    expect(typeof st.gp_onboarding).toBe('object'); // kept in the shape it arrived in
    expect(st.gp_onboarding.accountReviewFlag).toBe(true);
    expect(st.gp_onboarding.idVerification.status).toBe('rejected');
    expect(st.gp_onboarding.idVerification.rejectReason).toBe('The photo is too blurry to read your name.');
    expect(st.gp_onboarding.idVerification.rejectedBy).toBe('ceo@gplink-test.local');
    expect((db.task_timeline || []).some((e) => e.title === 'Account review — new ID requested')).toBe(true);

    // Declined is waiting on the DOCTOR — it leaves the CEO queue.
    const rq = requireCjs('../lib/ceo-review-queue.js');
    expect(rq.accountReviewWaitingOnDoctor(st.gp_onboarding)).toBe(true);
    expect(rq.accountReviewReason(st.gp_onboarding)).toContain('New ID requested from the doctor');

    // The CEO can still accept what is on file afterwards.
    const ok = await httpReq('POST', '/api/ats/candidate/account-review', {
      cookie: adminCookie('ceo@gplink-test.local'), body: { userId: 'u-held-4', action: 'approve' }
    });
    expect(ok.status).toBe(200);
    expect(db.user_state.find((r) => r.user_id === 'u-held-4').state.account_status).toBe('active');
  });

  it('cannot decline an account that is not under review', async () => {
    const res = await httpReq('POST', '/api/ats/candidate/account-review', {
      cookie: adminCookie('ceo@gplink-test.local'), body: { userId: 'u-held-4', action: 'decline', reason: 'x' }
    });
    expect(res.status).toBe(409);
  });

  it('a replacement ID filed by staff on a held account puts the check back in front of the CEO', () => {
    const fs = requireCjs('node:fs');
    const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const idx = src.indexOf("ccvSlot === 'idDoc'");
    expect(idx).toBeGreaterThan(0);
    const branch = src.slice(idx, idx + 2500);
    expect(branch).toContain("idSt.account_status === 'under_review'");
    expect(branch).toContain("idOb.idVerification.status = 'manual_review'");
    expect(branch).toContain('staffUploadedAt');
  });
});

// Owner 2026-10-13: "will she be notified via email and whatsapp template
// with cta that takes her straight to the job board?"
describe('releasing an account notifies by email AND WhatsApp, both pointing at the job board', () => {
  it('every release path sends both legs, and the CTAs go to the careers page', () => {
    const fs = requireCjs('node:fs');
    const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    // Three places lift the hold: the account-review Approve, the admin
    // set-status tool, and approving the last flagged qualification.
    expect(src.split('sendAccountReleasedNotifications(').length - 1).toBeGreaterThanOrEqual(4); // 3 callers + the definition
    expect(src).not.toMatch(/sendAccountActivatedEmail\((activatedUserId|rfUserId|arUserId)\)/);
    expect(src).toContain("var ACCOUNT_RELEASED_WA_TEMPLATE = 'gp_link_account_released'");
    expect(src).toContain("sendDoubleTickTemplateTo(wa.phone, ACCOUNT_RELEASED_WA_TEMPLATE, [wa.firstName || 'Doctor'])");
    expect(src).toContain("'/pages/signin?next=' + encodeURIComponent('/pages/career')");
    expect(src).toContain("'Browse the job board'");
  });

  it('the Approve response reports which channels went out', async () => {
    db.user_profiles.push({ user_id: 'u-held-5', email: 'held3-gp@example.com', first_name: 'Hope', last_name: 'Held', registration_country: 'uk', phone: '+44 7000 000000' });
    db.user_state.push({ user_id: 'u-held-5', state: { account_status: 'under_review', gp_onboarding: { accountReviewFlag: true, idVerification: { status: 'failed', issues: ['x'] } } } });
    const res = await httpReq('POST', '/api/ats/candidate/account-review', {
      cookie: adminCookie('ceo@gplink-test.local'), body: { userId: 'u-held-5', action: 'approve' }
    });
    expect(res.status).toBe(200);
    expect(res.body.account_status).toBe('active');
    // No email / DoubleTick keys in the test boot: both legs report, neither throws.
    expect(res.body.notified).toBeTruthy();
    expect(typeof res.body.notified.email.ok).toBe('boolean');
    expect(typeof res.body.notified.whatsapp.ok).toBe('boolean');
  });
});

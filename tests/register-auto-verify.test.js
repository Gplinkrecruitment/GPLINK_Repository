// Automated register verification (owner request 2026-09-01): the pure
// verdict logic in lib/register-lookup.js, plus the cron sweep and the ATS
// "auto" action wired through server.js with BOTH official sources stubbed
// (env REGISTER_UK_PERFORMERS_URL / REGISTER_MCNZ_BASE_URL point at local
// servers serving REAL captured fixtures — CSV rows from the 2026-09-01
// Performers List download, card markup from a live MCNZ search).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'module';

const requireCjs = createRequire(import.meta.url);
const lookup = requireCjs('../lib/register-lookup.js');
const RUN_ID = crypto.randomBytes(4).toString('hex');

// ── real fixture data ───────────────────────────────────────────────────────
const CSV_HEADER = '"Alignment","Performer Role","ForeName(s)","Surname","Professional Registration Number","Date of Registration","Status","Date first on Performers list(this is the earliest date of inclusion held)","Date in GP Register","NHSE Regional Team","Currently in Probationary Period"';
const ROW_GP = '"Medical","GP Performer","Zubair Mushtaq","-"," 7708579","30 April 2020","Included","23 December 2025","28 May 2026","NORTH WEST COMMISSIONING REGION","No"';
const ROW_REGISTRAR = '"Medical","GP Registrar","Ayesha","Aamir"," 7533234","","Included","","","EAST OF ENGLAND COMMISSIONING REGION","No"';
const ROW_DENTAL = '"Dental","Dental Performer","Azeema Shamoo","-"," 326371","28 May 2025","Included","13 August 2025","","MIDLANDS COMMISSIONING REGION","Yes"';
const PERFORMERS_CSV = [CSV_HEADER, ROW_GP, ROW_REGISTRAR, ROW_DENTAL].join('\r\n') + '\r\n';

function mcnzCard(name, fka, speciality, status, slug) {
  return '<li class="b-search-register-tile"><div class="b-search-register-tile__wrapper">'
    + '<div class="b-search-register-tile__details"><h3 class="b-search-register-tile__title">'
    + '<a href="/registration/register-of-doctors/doctor/' + slug + '/" class="b-search-register-tile__title-link"> <mark>' + name.split(',')[0] + '</mark>,' + name.split(',').slice(1).join(',') + ' </a></h3>'
    + (fka ? '<div class="b-search-register-tile__title-link-fka"> previously <strong> ' + fka + ' </strong></div>' : '')
    + '</div><div class="b-doctor-detail__content"><ul class="b-doctor-detail__list">'
    + '<li class="b-doctor-detail__list-item b-doctor-detail__content-location"><svg class="h-icon"><use xlink:href="#location"></use></svg> Auckland </li>'
    + '<li class="b-doctor-detail__list-item b-doctor-detail__content-speciality"><svg class="h-icon"><use xlink:href="#hospital"></use></svg> ' + speciality + ' </li>'
    + '<li class="b-doctor-detail__list-item b-doctor-detail__content-status"><svg class="h-icon"><use xlink:href="#practising"></use></svg> ' + status + ' </li>'
    + '</ul></div></div></li>';
}

// ── pure verdict logic ──────────────────────────────────────────────────────
describe('lib/register-lookup — Performers List verdicts', () => {
  const rowsFor = (n) => [ROW_GP, ROW_REGISTRAR, ROW_DENTAL].map(lookup.parsePerformersRow).filter((r) => r.number === n);

  it('verifies an Included GP Performer whose name matches (name held in ForeName(s))', () => {
    const v = lookup.performersVerdict(rowsFor('7708579'), { number: '7708579', firstName: 'Zubair', lastName: 'Mushtaq' });
    expect(v.outcome).toBe('verified');
    expect(v.matchedName).toBe('Zubair Mushtaq');
    expect(v.evidence).toContain('GP Performer');
    expect(v.evidence).toContain('GP Register since 28 May 2026');
  });

  it('leaves a GP REGISTRAR (trainee) pending with a plain-words reason', () => {
    const v = lookup.performersVerdict(rowsFor('7533234'), { number: '7533234', firstName: 'Ayesha', lastName: 'Aamir' });
    expect(v.outcome).toBe('pending');
    expect(v.evidence).toContain('REGISTRAR');
  });

  it('leaves a wrong-name match and a not-found number pending — never a mismatch', () => {
    const wrongName = lookup.performersVerdict(rowsFor('7708579'), { number: '7708579', firstName: 'Deepika', lastName: 'Ganesh' });
    expect(wrongName.outcome).toBe('pending');
    expect(wrongName.evidence).toContain('different name');
    const notFound = lookup.performersVerdict([], { number: '9999999', firstName: 'Ann', lastName: 'Absent' });
    expect(notFound.outcome).toBe('pending');
    expect(notFound.evidence).toContain('Scotland');
  });

  it('never verifies off a Dental row (GDC numbers share the file)', () => {
    const v = lookup.performersVerdict(rowsFor('326371'), { number: '326371', firstName: 'Azeema', lastName: 'Shamoo' });
    expect(v.outcome).toBe('pending');
  });
});

describe('lib/register-lookup — MCNZ verdicts', () => {
  const html = '<ul>'
    + mcnzCard('Ganesh, Deepika', 'Iyer, Deepika', 'General Practice', 'Practising (certificate expires 31 May 2027)', 'ganesh-deepika')
    + mcnzCard('Smith, Andrew Duncan', '', 'Diagnostic &amp; Interventional Radiology', 'Practising (certificate expires 30 November 2026)', 'smith-andrew-duncan')
    + '</ul>';

  it('parses server-rendered result cards including former names', () => {
    const cards = lookup.parseMcnzCards(html);
    expect(cards.length).toBe(2);
    expect(cards[0].name).toContain('Ganesh, Deepika');
    expect(cards[0].formerName).toContain('Iyer');
    expect(cards[0].speciality).toBe('General Practice');
    expect(cards[0].status).toContain('Practising');
  });

  it('verifies exactly one practising General Practice match', () => {
    const v = lookup.mcnzVerdict(lookup.parseMcnzCards(html), { firstName: 'Deepika', lastName: 'Ganesh' });
    expect(v.outcome).toBe('verified');
    expect(v.evidence).toContain('General Practice');
  });

  it('stays pending for a non-GP scope and for no match', () => {
    const radiologist = lookup.mcnzVerdict(lookup.parseMcnzCards(html), { firstName: 'Andrew', lastName: 'Smith' });
    expect(radiologist.outcome).toBe('pending');
    const nobody = lookup.mcnzVerdict(lookup.parseMcnzCards(html), { firstName: 'Nell', lastName: 'Nowhere' });
    expect(nobody.outcome).toBe('pending');
  });
});

// ── server wiring: cron sweep + ATS auto action ─────────────────────────────
let server, port, sbServer, ukServer, nzServer;

const db = {
  user_profiles: [
    { user_id: 'u-auto-uk', email: 'auto-uk@example.com', first_name: 'Zubair', last_name: 'Mushtaq', register_body: 'gmc', register_number: '7708579', register_status: 'pending_verification', updated_at: '2026-09-01T00:00:00Z' },
    { user_id: 'u-auto-nz', email: 'auto-nz@example.com', first_name: 'Deepika', last_name: 'Ganesh', register_body: 'mcnz', register_number: '54321', register_status: 'pending_verification', updated_at: '2026-09-01T00:00:00Z' },
    { user_id: 'u-auto-miss', email: 'auto-miss@example.com', first_name: 'Nina', last_name: 'Notfound', register_body: 'gmc', register_number: '9999999', register_status: 'pending_verification', updated_at: '2026-09-01T00:00:00Z' },
    // Wizard-flow doctor: no register fields yet — the precheck endpoint
    // stamps AND verifies them mid-onboarding (instant verification).
    { user_id: 'u-wiz-uk', email: 'wiz-uk@example.com', first_name: 'Zubair', last_name: 'Mushtaq', updated_at: '2026-09-01T00:00:00Z' }
  ],
  user_state: [{ user_id: 'u-wiz-uk', state: {} }], registration_cases: [], registration_events: [], user_documents: []
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
    if (op === 'in') return val.replace(/^\(/, '').replace(/\)$/, '').split(',').map((s) => s.trim().replace(/^"/, '').replace(/"$/, '')).includes(String(cell));
    return true;
  });
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { resolve(null); } });
  });
}
function startSupabaseEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const rows = tableOf(decodeURIComponent(m[1]));
      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out); return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const conflictCols = (u.searchParams.get('on_conflict') || '').split(',').map((s) => s.trim()).filter(Boolean);
        const saved = incoming.map((r) => {
          if (conflictCols.length) {
            const existing = rows.find((row) => row && conflictCols.every((c) => String(row[c]) === String(r[c])));
            if (existing) { Object.assign(existing, r); return existing; }
          }
          const row = { id: crypto.randomUUID(), ...r };
          rows.push(row);
          return row;
        });
        send(201, saved); return;
      }
      if (req.method === 'DELETE') {
        const keep = rows.filter((row) => !matches(row));
        rows.length = 0;
        keep.forEach((row) => rows.push(row));
        send(200, []); return;
      }
      if (req.method === 'PATCH') {
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched); return;
      }
      send(200, []);
    });
    sbServer.listen(0, '127.0.0.1', resolve);
  });
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function adminCookie(email) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function userCookie(email, userId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId: userId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { cookie, body, bearer } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { let parsed = null; try { parsed = JSON.parse(Buffer.concat(c).toString('utf8')); } catch {} resolve({ status: res.statusCode, body: parsed }); });
    });
    r.on('error', reject); r.end(data);
  });
}

let ukHits = 0;
beforeAll(async () => {
  ukServer = http.createServer((req, res) => {
    ukHits++;
    res.writeHead(200, { 'Content-Type': 'text/csv' });
    res.end(PERFORMERS_CSV);
  });
  await new Promise((r) => ukServer.listen(0, '127.0.0.1', r));
  nzServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://nz.local');
    const kw = (u.searchParams.get('keyword') || '').toLowerCase();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(kw.includes('ganesh')
      ? '<ul>' + mcnzCard('Ganesh, Deepika', '', 'General Practice', 'Practising (certificate expires 31 May 2027)', 'ganesh-deepika') + '</ul>'
      : '<ul></ul>');
  });
  await new Promise((r) => nzServer.listen(0, '127.0.0.1', r));

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'test-autoverify-' + RUN_ID;
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.ADMIN_EMAILS = '';
  await startSupabaseEmulator();
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbServer.address().port}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.REGISTER_UK_PERFORMERS_URL = `http://127.0.0.1:${ukServer.address().port}/performers.csv`;
  process.env.REGISTER_MCNZ_BASE_URL = `http://127.0.0.1:${nzServer.address().port}`;
  // The stub CSV holds 2 medical rows — drop the truncated-file floor.
  process.env.PERFORMERS_MIRROR_MIN_ROWS = '1';
  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});
afterAll(async () => { server?.close(); sbServer?.close(); ukServer?.close(); nzServer?.close(); });

describe('GET /api/cron/register-auto-verify', () => {
  it('rejects a missing cron secret', async () => {
    const res = await httpReq('GET', '/api/cron/register-auto-verify');
    expect(res.status).toBe(401);
  });

  it('verifies the UK doctor via the performers list and the NZ doctor via MCNZ; the unknown number stays pending', async () => {
    const res = await httpReq('GET', '/api/cron/register-auto-verify', { bearer: 'test-cron-secret' });
    expect(res.status).toBe(200);
    expect(res.body.attempted).toBe(3);
    expect(res.body.verified).toBe(2);

    const uk = db.user_profiles.find((p) => p.user_id === 'u-auto-uk');
    expect(uk.register_status).toBe('verified');
    expect(uk.register_verified_by).toBe('system:nhs-performers-list');
    expect(uk.register_name).toBe('Zubair Mushtaq');
    expect(uk.register_auto_checked_at).toBeTruthy();

    const nz = db.user_profiles.find((p) => p.user_id === 'u-auto-nz');
    expect(nz.register_status).toBe('verified');
    expect(nz.register_verified_by).toBe('system:mcnz-register');

    const miss = db.user_profiles.find((p) => p.user_id === 'u-auto-miss');
    expect(miss.register_status).toBe('pending_verification');
    expect(miss.register_auto_checked_at).toBeTruthy();
  });

  it('does not re-attempt a doctor checked within the last 7 days', async () => {
    const res = await httpReq('GET', '/api/cron/register-auto-verify', { bearer: 'test-cron-secret' });
    expect(res.status).toBe(200);
    expect(res.body.attempted).toBe(0);
  });
});

describe('the daily NHS mirror (owner 2026-09-01: keep the list, replace it daily)', () => {
  it('the on-demand sync fills the mirror table with Medical rows only and stamps the meta', async () => {
    const res = await httpReq('POST', '/api/ats/register-mirror/sync', { cookie: adminCookie('ceo@gplink-test.local') });
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(2); // the GP Performer + the GP Registrar; the Dental row is filtered
    const mirror = tableOf('nhs_performers_mirror');
    expect(mirror.length).toBe(2);
    expect(mirror.every((r) => r.alignment === 'Medical')).toBe(true);
    const meta = tableOf('runtime_kv').find((r) => r.key === 'nhs_performers_mirror');
    expect(meta && meta.value.rows).toBe(2);
  });

  it('a fresh mirror answers checks WITHOUT touching the NHS download', async () => {
    // Re-open a doctor for checking against the now-fresh mirror.
    const prof = db.user_profiles.find((p) => p.user_id === 'u-auto-uk');
    Object.assign(prof, { register_status: 'pending_verification', register_verified_at: null, register_verified_by: null, register_auto_checked_at: null });
    const before = ukHits;
    const res = await httpReq('POST', '/api/ats/candidate/register-verification', {
      cookie: adminCookie('ceo@gplink-test.local'),
      body: { userId: 'u-auto-uk', action: 'auto' }
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('verified');
    expect(prof.register_verified_by).toBe('system:nhs-performers-list');
    expect(ukHits).toBe(before); // mirror served it — zero NHS downloads
  });

  it('a STALE mirror falls back to the live NHS download', async () => {
    const meta = tableOf('runtime_kv').find((r) => r.key === 'nhs_performers_mirror');
    meta.value = { ...meta.value, synced_at: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString() };
    const prof = db.user_profiles.find((p) => p.user_id === 'u-auto-uk');
    Object.assign(prof, { register_status: 'pending_verification', register_verified_at: null, register_verified_by: null, register_auto_checked_at: null });
    const before = ukHits;
    const res = await httpReq('POST', '/api/ats/candidate/register-verification', {
      cookie: adminCookie('ceo@gplink-test.local'),
      body: { userId: 'u-auto-uk', action: 'auto' }
    });
    expect(res.body.outcome).toBe('verified');
    expect(ukHits).toBe(before + 1); // live download used
    // Restore a fresh meta for any later tests.
    meta.value = { ...meta.value, synced_at: new Date().toISOString() };
  });

  it('the sync cron route requires the cron secret', async () => {
    const res = await httpReq('GET', '/api/cron/performers-mirror-sync');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/onboarding/register-precheck (instant verification mid-wizard)', () => {
  it('stamps the number and verifies it in one call while the doctor does the ID step', async () => {
    const res = await httpReq('POST', '/api/onboarding/register-precheck', {
      cookie: userCookie('wiz-uk@example.com', 'u-wiz-uk'),
      body: { country: 'GB', registerNumber: 'GMC 770 8579' }
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('verified');
    const prof = db.user_profiles.find((p) => p.user_id === 'u-wiz-uk');
    expect(prof.register_number).toBe('7708579');
    expect(prof.register_status).toBe('verified');
    expect(prof.register_verified_by).toBe('system:nhs-performers-list');
  });

  it('completion reports the already-verified outcome instantly and NEVER downgrades it', async () => {
    const res = await httpReq('POST', '/api/onboarding/complete', {
      cookie: userCookie('wiz-uk@example.com', 'u-wiz-uk'),
      body: { country: 'GB', registerNumber: '7708579', targetDate: '2027-03' }
    });
    expect(res.status).toBe(200);
    expect(res.body.registerVerification).toBe('verified');
    // Regression (2026-09-01 localhost timing test): completion used to
    // re-stamp pending over the precheck's verified and re-run the whole
    // ~40s scan. Same number + settled status must stay untouched.
    const prof = db.user_profiles.find((p) => p.user_id === 'u-wiz-uk');
    expect(prof.register_status).toBe('verified');
    expect(prof.register_verified_by).toBe('system:nhs-performers-list');
  });

  it('a CHANGED number at completion goes back to pending for a fresh check', async () => {
    const prof = db.user_profiles.find((p) => p.user_id === 'u-wiz-uk');
    const res = await httpReq('POST', '/api/onboarding/complete', {
      cookie: userCookie('wiz-uk@example.com', 'u-wiz-uk'),
      body: { country: 'GB', registerNumber: '9999999' }
    });
    expect(res.status).toBe(200);
    expect(prof.register_number).toBe('9999999');
    expect(['pending_verification']).toContain(prof.register_status);
    // Put the fixture back for any later assertions.
    Object.assign(prof, { register_number: '7708579', register_status: 'verified', register_verified_by: 'system:nhs-performers-list' });
  });

  it('refuses a malformed number with a plain-words message and never touches the profile', async () => {
    const before = JSON.stringify(db.user_profiles.find((p) => p.user_id === 'u-wiz-uk'));
    const res = await httpReq('POST', '/api/onboarding/register-precheck', {
      cookie: userCookie('wiz-uk@example.com', 'u-wiz-uk'),
      body: { country: 'GB', registerNumber: '12' }
    });
    expect(res.status).toBe(422);
    expect(res.body.message).toContain('GMC');
    expect(JSON.stringify(db.user_profiles.find((p) => p.user_id === 'u-wiz-uk'))).toBe(before);
  });

  it('requires a signed-in doctor', async () => {
    const res = await httpReq('POST', '/api/onboarding/register-precheck', { body: { country: 'GB', registerNumber: '7708579' } });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/ats/candidate/register-verification action=auto', () => {
  it('runs the check on demand and reports the evidence for an inconclusive doctor', async () => {
    const res = await httpReq('POST', '/api/ats/candidate/register-verification', {
      cookie: adminCookie('ceo@gplink-test.local'),
      body: { userId: 'u-auto-miss', action: 'auto' }
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('pending');
    expect(res.body.evidence).toContain('not on the NHS England performers list');
  });

  it('reports skipped for an already-verified doctor', async () => {
    const res = await httpReq('POST', '/api/ats/candidate/register-verification', {
      cookie: adminCookie('ceo@gplink-test.local'),
      body: { userId: 'u-auto-uk', action: 'auto' }
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('skipped');
  });
});

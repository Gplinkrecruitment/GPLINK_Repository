// Task 6 (AI Matching, 2026-07-06 plan) — hired/closed job "redirect"
// fan-out: redirectOthersForJob(jobId, hiredAppId), buildRedirectEmailHtml,
// sendRedirectEmail, plus the two HTTP triggers (PATCH /api/ats/application
// stage:'hired', PATCH /api/ats/job job_status filled/closed) and the ATS
// confirm-dialog wiring in js/ceo-ats-jobs.js.
//
// Two halves, mirroring tests/ai-matching-cron.test.js:
//  (A) Source-regex wiring checks — no server boot needed.
//  (B) Endpoint + fan-out behavior against a real Supabase-mode boot (in-
//      memory PostgREST emulator, Resend calls captured via a mocked
//      fetch), plus a real super_admin ATS session for the two HTTP
//      triggers (cookie-signing pattern from tests/ai-matching-pipeline
//      .test.js).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Source wiring (no server boot needed) ───────────────────────────────────
describe('AI Matching Task 6 — source wiring', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const jobsSrc = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-jobs.js'), 'utf8');
  const dashboardHtml = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');

  it('server.js declares redirectOthersForJob at true top-level and exports it for tests', () => {
    expect(serverSrc).toMatch(/async function redirectOthersForJob\(jobId, hiredAppId\)/);
    expect(serverSrc).toContain('redirectOthersForJob,');
    expect(serverSrc).toContain('buildRedirectEmailHtml,');
    expect(serverSrc).toContain('sendRedirectEmail,');
  });

  it('redirectOthersForJob selects exactly the five live stages (never offer/hired/not_proceeding)', () => {
    const idx = serverSrc.indexOf('async function redirectOthersForJob');
    const fnSrc = serverSrc.slice(idx, idx + 4000);
    expect(fnSrc).toContain("var roLiveStages = ['shortlisted', 'applied', 'submitted', 'reviewing', 'interview'];");
  });

  it('the GP-facing alternative tags builder never touches earnings_text/billing_model', () => {
    const idx = serverSrc.indexOf('function buildRedirectAlternativeTags');
    const fnSrc = serverSrc.slice(idx, idx + 900);
    expect(fnSrc).not.toMatch(/earnings_text|billing_model/);
    expect(fnSrc).toContain("'DPA approved'");
    expect(fnSrc).toContain("'Visa pathway aligned'");
    expect(fnSrc).toContain("'Family friendly'");
  });

  it('the internal ranking function is clearly marked internal-only and separate from the rendered tags', () => {
    expect(serverSrc).toContain('_redirectRankAlternatives');
    expect(serverSrc).toContain('INTERNAL-ONLY ranking');
  });

  it('buildRedirectEmailHtml never renders a 98% stat or urgency/countdown box', () => {
    const idx = serverSrc.indexOf('function buildRedirectEmailHtml');
    const fnSrc = serverSrc.slice(idx, serverSrc.indexOf('\n}\n', idx));
    expect(fnSrc).not.toContain('98%');
    expect(fnSrc).not.toMatch(/reserved for you until/i);
    expect(fnSrc).not.toMatch(/hours left|hour left/i);
  });

  it('PATCH /api/ats/application fans out on a REAL move into hired, gated by redirect_others:true', () => {
    const idx = serverSrc.indexOf("pathname === '/api/ats/application' && req.method === 'PATCH'");
    const idxTrigger = serverSrc.indexOf('redirectOthersForJob(updatedAP.career_role_id, apId)', idx);
    expect(idx).toBeGreaterThan(-1);
    expect(idxTrigger).toBeGreaterThan(idx);
    const guardSrc = serverSrc.slice(idx, idxTrigger);
    expect(guardSrc).toContain("newStage === 'hired' && upAP.prevStage !== 'hired' && bodyAP.redirect_others === true");
  });

  it("PATCH /api/ats/job fans out on a REAL flip to filled/closed, gated by redirect_others:true", () => {
    const idx = serverSrc.indexOf("pathname === '/api/ats/job' && req.method === 'PATCH'");
    const idxTrigger = serverSrc.indexOf('redirectOthersForJob(jpId, null)', idx);
    expect(idx).toBeGreaterThan(-1);
    expect(idxTrigger).toBeGreaterThan(idx);
    const guardSrc = serverSrc.slice(idx, idxTrigger);
    expect(guardSrc).toContain("(patchJ.job_status === 'filled' || patchJ.job_status === 'closed')");
    expect(guardSrc).toContain('jobRowJP.job_status !== patchJ.job_status');
    expect(guardSrc).toContain('bodyJP.redirect_others === true');
  });

  it('js/ceo-ats-jobs.js has the exact confirm-dialog copy, live-stage list, and cache buster', () => {
    expect(jobsSrc).toContain("n + ' other GPs are still active on this job — send them the redirect email?'");
    expect(jobsSrc).toContain("var REDIRECT_LIVE_STAGES = ['shortlisted', 'applied', 'submitted', 'reviewing', 'interview'];");
    expect(jobsSrc).toMatch(/function confirmRedirectOthers/);
    // Wired into all three PATCH sites the brief names (drag, drawer select, job settings save).
    expect(jobsSrc).toMatch(/confirmRedirectOthers\(id\)/);
    expect(jobsSrc).toMatch(/confirmRedirectOthers\(drawerCardId\)/);
    expect(jobsSrc).toMatch(/confirmRedirectOthers\(\)/);
  });

  it('pages/ceo-dashboard.html loads the bumped ceo-ats-jobs.js cache buster', () => {
    expect(dashboardHtml).toMatch(/<script src="\/js\/ceo-ats-jobs\.js\?v=20260707[a-z]"><\/script>/);
  });
});

// ── Endpoint + fan-out behavior against a real Supabase-mode boot ───────────
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ai-matching-redirect-${RUN_ID}.json`);
const SUPER_HOST = 'ats-test.local';
let server, port;
let sbServer, sbPort;
const resendCalls = [];
let realFetch;

const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.now();

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { host, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (host) headers.Host = host;
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

// ── In-memory PostgREST emulator (mirrors tests/ai-matching-cron.test.js) ───
const db = {
  user_profiles: [],
  user_state: [],
  registration_cases: [],
  rso_team: [],
  ats_stage_events: [],
  practices: [],
  career_roles: [],
  gp_applications: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

// Any PATCH whose matched rows include one of these ids fails with a 500 and
// leaves the row unmodified — used for the per-row failure-isolation test.
const failPatchIds = new Set();

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'];
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    let negate = false;
    let rest = raw;
    if (rest.startsWith('not.')) { negate = true; rest = rest.slice(4); }
    const dot = rest.indexOf('.');
    const op = dot > 0 ? rest.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue;
    const val = rest.slice(dot + 1);
    filters.push({ col: key, op, val, negate });
  }
  function coerce(cell, val) {
    if (typeof cell === 'string' && /^\d{4}-\d{2}-\d{2}/.test(cell) && /^\d{4}-\d{2}-\d{2}/.test(val)) {
      return [Date.parse(cell), Date.parse(val)];
    }
    const cellNum = Number(cell), valNum = Number(val);
    if (cell !== null && cell !== undefined && cell !== '' && !Number.isNaN(cellNum) && !Number.isNaN(valNum)) {
      return [cellNum, valNum];
    }
    return [String(cell), val];
  }
  return (row) => filters.every(({ col, op, val, negate }) => {
    const cell = row ? row[col] : undefined;
    let result;
    if (op === 'eq') result = String(cell) === val;
    else if (op === 'neq') result = String(cell) !== val;
    else if (op === 'is') result = val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    else if (op === 'in') {
      result = val.replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''))
        .includes(String(cell));
    } else if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
      if (cell === null || cell === undefined) { result = false; }
      else {
        const [a, b] = coerce(cell, val);
        if (op === 'gt') result = a > b;
        else if (op === 'gte') result = a >= b;
        else if (op === 'lt') result = a < b;
        else result = a <= b;
      }
    } else {
      result = true;
    }
    return negate ? !result : result;
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
        const saved = incoming.map((r) => {
          const row = { id: r.id || crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          rows.push(row);
          return row;
        });
        send(201, saved);
        return;
      }
      if (req.method === 'PATCH') {
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        if (matched.some((row) => failPatchIds.has(String(row.id)))) {
          send(500, { message: 'forced PATCH failure (test hook)' });
          return;
        }
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched);
        return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

// ── Fixture reset ────────────────────────────────────────────────────────────
// career_roles is queried GLOBALLY by the fan-out ("open+active roles" — the
// production query has no per-job scoping), so leaving every phase's fixtures
// permanently in the shared in-memory table would let one phase's "filled"
// job or alternative pool leak into another phase's ranking/cap assertions.
// Each test below calls resetDb() and pushes ONLY the rows it needs,
// mirroring how tests/ai-matching-cron.test.js pushes later-phase fixtures
// inside individual it() blocks rather than at module scope.
function resetDb() {
  db.user_profiles.length = 0;
  db.user_state.length = 0;
  db.registration_cases.length = 0;
  db.rso_team.length = 0;
  db.ats_stage_events.length = 0;
  db.practices.length = 0;
  db.career_roles.length = 0;
  db.gp_applications.length = 0;
}

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'ai-matching-redirect-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.CONSULTANT_EMAILS = '';
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.OPENAI_API_KEY = '';
  process.env.RESEND_API_KEY = 'test-resend-key';

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.resend.com/')) {
      let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
      resendCalls.push({ url: u, body: parsed });
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
    }
    return realFetch(url, opts);
  };

  const serverModule = await import('../server.js');
  server = serverModule.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  globalThis.fetch = realFetch;
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('redirectOthersForJob — candidate-set selection + skip rules (phase 1)', () => {
  it('redirects exactly the five live-stage rows, excludes the hired row, and skips the already-not_proceeding row untouched', async () => {
    resetDb();
    // job-fill-1 has one row in EVERY relevant stage (the five live ones,
    // plus 'offer', 'hired' and an already-'not_proceeding' row), and exactly
    // one open+active alternative role so every redirected GP gets 1
    // alternative (keeps this phase's assertions about the STAGE mechanics,
    // not the ranking — that's phase 2).
    db.practices.push({ id: 'prac-fill-1', name: 'Coral Coast Family Practice', website: '', intro_video_url: '' });
    db.career_roles.push({
      id: 'job-fill-1', provider: 'internal_ats', title: 'General Practitioner', masked_title: 'DPA - Bundaberg - Mixed Billing',
      practice_name: 'Coral Coast Family Practice', practice_id: 'prac-fill-1',
      location_city: 'Bundaberg', location_state: 'QLD', billing_model: 'Mixed billing', earnings_text: '70% billings',
      job_status: 'open', is_active: true
    });
    db.career_roles.push({
      id: 'job-alt-1', provider: 'internal_ats', title: 'General Practitioner', masked_title: 'DPA - Hervey Bay - Mixed Billing',
      practice_name: 'Bayside Family Medical', practice_id: null,
      location_city: 'Hervey Bay', location_state: 'QLD', billing_model: 'Mixed billing', earnings_text: '70% billings',
      dpa: true, visa_pathway_aligned: false, family_friendly: true, regional: true, metro: false, practice_type: 'Independent',
      job_status: 'open', is_active: true
    });
    const PHASE1_GPS = ['gp-hired-1', 'gp-short-1', 'gp-applied-1', 'gp-submitted-1', 'gp-reviewing-1', 'gp-interview-1', 'gp-offer-1', 'gp-notproceeding-1'];
    PHASE1_GPS.forEach((uid, i) => {
      db.user_profiles.push({ user_id: uid, email: uid + '@gplink-test.local', first_name: 'Test', last_name: 'Doctor' + i, registration_country: 'united kingdom' });
    });
    db.gp_applications.push(
      { id: 'app-hired-1', user_id: 'gp-hired-1', career_role_id: 'job-fill-1', ats_stage: 'hired', matched_at: null },
      { id: 'app-short-1', user_id: 'gp-short-1', career_role_id: 'job-fill-1', ats_stage: 'shortlisted', matched_at: null },
      { id: 'app-applied-1', user_id: 'gp-applied-1', career_role_id: 'job-fill-1', ats_stage: 'applied', matched_at: null },
      { id: 'app-submitted-1', user_id: 'gp-submitted-1', career_role_id: 'job-fill-1', ats_stage: 'submitted', matched_at: null },
      { id: 'app-reviewing-1', user_id: 'gp-reviewing-1', career_role_id: 'job-fill-1', ats_stage: 'reviewing', matched_at: null },
      { id: 'app-interview-1', user_id: 'gp-interview-1', career_role_id: 'job-fill-1', ats_stage: 'interview', matched_at: null },
      { id: 'app-offer-1', user_id: 'gp-offer-1', career_role_id: 'job-fill-1', ats_stage: 'offer', matched_at: null },
      { id: 'app-notproceeding-1', user_id: 'gp-notproceeding-1', career_role_id: 'job-fill-1', ats_stage: 'not_proceeding', match_outcome: 'declined', matched_at: null }
    );

    const serverModule = await import('../server.js');
    const { redirectOthersForJob } = serverModule.__testUtils;

    resendCalls.length = 0;
    const result = await redirectOthersForJob('job-fill-1', 'app-hired-1');
    expect(result.redirected).toBe(5);
    expect(result.errors).toEqual([]);

    ['app-short-1', 'app-applied-1', 'app-submitted-1', 'app-reviewing-1', 'app-interview-1'].forEach((id) => {
      const row = db.gp_applications.find((a) => a.id === id);
      expect(row.ats_stage).toBe('not_proceeding');
      expect(row.match_outcome).toBe('position_filled');
      expect(row.redirect_alternatives).toBeTruthy();
      expect(row.redirect_alternatives.alternatives.length).toBe(1);
      expect(row.redirect_alternatives._dismissed).toBe(false);
    });

    // Hired row untouched (excluded by hiredAppId).
    const hiredRow = db.gp_applications.find((a) => a.id === 'app-hired-1');
    expect(hiredRow.ats_stage).toBe('hired');
    expect(hiredRow.match_outcome).toBeUndefined();

    // 'offer' is NOT one of the five live stages — untouched.
    const offerRow = db.gp_applications.find((a) => a.id === 'app-offer-1');
    expect(offerRow.ats_stage).toBe('offer');
    expect(offerRow.redirect_alternatives).toBeUndefined();

    // Already-not_proceeding row: skipped entirely — no re-write, no email.
    const skippedRow = db.gp_applications.find((a) => a.id === 'app-notproceeding-1');
    expect(skippedRow.match_outcome).toBe('declined'); // unchanged, not overwritten to position_filled
    expect(skippedRow.redirect_alternatives).toBeUndefined();
    expect(resendCalls.some((c) => (c.body.to || []).includes('gp-notproceeding-1@gplink-test.local'))).toBe(false);
    expect(resendCalls.some((c) => (c.body.to || []).includes('gp-offer-1@gplink-test.local'))).toBe(false);
    expect(resendCalls.some((c) => (c.body.to || []).includes('gp-hired-1@gplink-test.local'))).toBe(false);

    // A stage event was recorded for each of the five, from their real prior stage.
    const events = db.ats_stage_events.filter((e) =>
      ['app-short-1', 'app-applied-1', 'app-submitted-1', 'app-reviewing-1', 'app-interview-1'].includes(e.application_id));
    expect(events.length).toBe(5);
    events.forEach((e) => { expect(e.to_stage).toBe('not_proceeding'); expect(e.actor).toBe('system'); });
    const shortEvent = events.find((e) => e.application_id === 'app-short-1');
    expect(shortEvent.from_stage).toBe('shortlisted');

    // Exactly 5 redirect emails sent, one per redirected GP.
    expect(resendCalls.length).toBe(5);
    resendCalls.forEach((c) => {
      expect(c.body.subject).toContain('An update on Coral Coast Family Practice');
      expect(c.body.subject).toContain("and the door we've already opened"); // 1 alternative -> singular
      expect(c.body.html).toContain('This changes nothing about how the practices see you.');
      expect(c.body.html).toContain('Position filled');
      expect(c.body.html).not.toContain('98%');
      expect(c.body.html).not.toMatch(/reserved for you until|hours left/i);
    });
  });
});

describe('redirectOthersForJob — alternatives ranking + exclusion + cap + masked identity (phase 2)', () => {
  it('ranks same-state-first then internal billing/earnings similarity, excludes the GP\'s own live role, and caps at 3', async () => {
    resetDb();
    db.practices.push({ id: 'prac-fill-2', name: 'Coral Coast Family Practice', website: '', intro_video_url: '' });
    db.career_roles.push({
      id: 'job-fill-2', provider: 'internal_ats', title: 'General Practitioner', masked_title: 'DPA - Bundaberg - Mixed Billing',
      practice_name: 'Coral Coast Family Practice', practice_id: 'prac-fill-2',
      location_city: 'Bundaberg', location_state: 'QLD', billing_model: 'Mixed billing', earnings_text: '70% billings',
      job_status: 'open', is_active: true
    });
    // A: best rank (same state, same billing, same earnings) — masked identity.
    db.career_roles.push({
      id: 'role-alt-A', provider: 'internal_ats', title: 'General Practitioner', masked_title: 'DPA - Alt A - Mixed Billing',
      practice_name: 'Real Practice A Pty Ltd', practice_id: null,
      location_city: 'Hervey Bay', location_state: 'QLD', billing_model: 'Mixed billing', earnings_text: '70% billings',
      dpa: true, visa_pathway_aligned: true, family_friendly: false, regional: true, metro: false, practice_type: 'Corporate',
      job_status: 'open', is_active: true
    });
    // B: same state, different billing/earnings — mid rank.
    db.career_roles.push({
      id: 'role-alt-B', provider: 'internal_ats', title: 'General Practitioner', masked_title: 'Non-DPA - Alt B - Bulk Billing',
      practice_name: 'Real Practice B', practice_id: null,
      location_city: 'Gympie', location_state: 'QLD', billing_model: 'Bulk billing', earnings_text: '65% billings',
      dpa: false, visa_pathway_aligned: false, family_friendly: true, regional: false, metro: true, practice_type: 'Independent',
      job_status: 'open', is_active: true
    });
    // EXCLUDE: would rank BEST (identical to original) but the GP already has
    // a live application here — must never appear in their alternatives.
    db.career_roles.push({
      id: 'role-alt-exclude', provider: 'internal_ats', title: 'General Practitioner', masked_title: 'DPA - Excluded - Mixed Billing',
      practice_name: 'Real Practice Excluded', practice_id: null,
      location_city: 'Maryborough', location_state: 'QLD', billing_model: 'Mixed billing', earnings_text: '70% billings',
      dpa: true, job_status: 'open', is_active: true
    });
    // C: different state — lower rank than A/B, still beats D.
    db.career_roles.push({
      id: 'role-alt-C', provider: 'internal_ats', title: 'General Practitioner', masked_title: 'Non-DPA - Alt C - Mixed Billing',
      practice_name: 'Real Practice C', practice_id: null,
      location_city: 'Newcastle', location_state: 'NSW', billing_model: 'Mixed billing', earnings_text: '70% billings',
      metro: true, job_status: 'open', is_active: true
    });
    // D: different state AND different billing/earnings — worst rank, dropped
    // by the "up to 3" cap.
    db.career_roles.push({
      id: 'role-alt-D', provider: 'internal_ats', title: 'General Practitioner', masked_title: 'Non-DPA - Alt D - Bulk Billing',
      practice_name: 'Real Practice D', practice_id: null,
      location_city: 'Geelong', location_state: 'VIC', billing_model: 'Bulk billing', earnings_text: '55% billings',
      job_status: 'open', is_active: true
    });
    db.user_profiles.push({ user_id: 'gp-rank-1', email: 'gp-rank-1@gplink-test.local', first_name: 'Rank', last_name: 'Doctor', registration_country: 'ireland' });
    db.gp_applications.push(
      { id: 'app-rank-1', user_id: 'gp-rank-1', career_role_id: 'job-fill-2', ats_stage: 'shortlisted', matched_at: null },
      { id: 'app-rank-1-other', user_id: 'gp-rank-1', career_role_id: 'role-alt-exclude', ats_stage: 'applied', matched_at: null }
    );

    const serverModule = await import('../server.js');
    const { redirectOthersForJob } = serverModule.__testUtils;

    resendCalls.length = 0;
    const result = await redirectOthersForJob('job-fill-2', null);
    expect(result.redirected).toBe(1);

    const row = db.gp_applications.find((a) => a.id === 'app-rank-1');
    const alts = row.redirect_alternatives.alternatives;
    expect(alts.length).toBe(3); // capped — role-alt-D dropped
    expect(alts.map((a) => a.roleId)).toEqual(['role-alt-A', 'role-alt-B', 'role-alt-C']);
    // The GP's own live application (role-alt-exclude) never appears, even
    // though it would otherwise rank BEST (identical state/billing/earnings).
    expect(alts.some((a) => a.roleId === 'role-alt-exclude')).toBe(false);

    // Masked identity: the alternative's practiceName is the masked label,
    // NEVER the real practice_name.
    const altA = alts.find((a) => a.roleId === 'role-alt-A');
    expect(altA.practiceName).toBe('DPA - Alt A - Mixed Billing');
    expect(altA.practiceName).not.toContain('Real Practice A');
    expect(altA.title).toBe('General Practitioner'); // title and practiceName are distinct fields
    expect(altA.tags).toEqual(['DPA approved', 'Visa pathway aligned', 'Regional QLD', 'Corporate']);

    // No income/billing/percentage/money strings in the rendered tags or
    // title (brief: "tags contain no money strings"). NOTE: practiceName is
    // deliberately EXCLUDED from this check — it reuses the app-wide
    // masked_title convention (practicePipeline.buildMaskedTitle), which
    // legitimately embeds the job's billing STYLE label ("Mixed Billing") as
    // part of its masked location string everywhere in the app (this is a
    // billing ARRANGEMENT descriptor, not a percentage/dollar figure — the
    // constraint targets billing %, not the word "billing" itself).
    const moneyPattern = /%|\$|billing|income/i;
    alts.forEach((a) => {
      expect(moneyPattern.test(a.title)).toBe(false);
      expect(moneyPattern.test((a.tags || []).join(' '))).toBe(false);
    });

    // Email carries all 3 alt cards + the plural "doors" subject.
    const email = resendCalls.find((c) => (c.body.to || []).includes('gp-rank-1@gplink-test.local'));
    expect(email).toBeTruthy();
    expect(email.body.subject).toBe("An update on Coral Coast Family Practice — and 3 doors we've already opened");
    expect(email.body.html).toContain('DPA - Alt A - Mixed Billing');
    expect(email.body.html).toContain('DPA approved');
    expect(email.body.html).not.toContain('Real Practice A');
    expect(email.body.html).toContain('View this role');
    expect(email.body.html).toContain('See all roles picked for you');
  });
});

describe('redirectOthersForJob — zero-alternatives fallback (phase 3)', () => {
  it('falls back to the personal-reply line, no cards, no shiny "see all" button, and a plain subject', async () => {
    resetDb();
    // gp-zero-1 already has a LIVE application on every open+active alt role
    // in this test's pool, so full exclusion forces the fallback branch.
    db.practices.push({ id: 'prac-fill-3', name: 'Riverbend Medical Centre', website: '', intro_video_url: '' });
    db.career_roles.push({
      id: 'job-fill-3', provider: 'internal_ats', title: 'General Practitioner', masked_title: 'Non-DPA - Toowoomba - Bulk Billing',
      practice_name: 'Riverbend Medical Centre', practice_id: 'prac-fill-3',
      location_city: 'Toowoomba', location_state: 'QLD', billing_model: 'Bulk billing', earnings_text: '65% billings',
      job_status: 'open', is_active: true
    });
    db.career_roles.push({
      id: 'job-zero-alt-1', provider: 'internal_ats', title: 'General Practitioner', masked_title: 'DPA - ZeroAlt - Mixed Billing',
      practice_name: 'ZeroAlt Medical', practice_id: null,
      location_city: 'Hervey Bay', location_state: 'QLD', billing_model: 'Mixed billing', earnings_text: '70% billings',
      job_status: 'open', is_active: true
    });
    db.user_profiles.push({ user_id: 'gp-zero-1', email: 'gp-zero-1@gplink-test.local', first_name: 'Zero', last_name: 'Doctor', registration_country: 'new zealand' });
    db.gp_applications.push(
      { id: 'app-zero-1', user_id: 'gp-zero-1', career_role_id: 'job-fill-3', ats_stage: 'shortlisted', matched_at: null },
      { id: 'app-zero-block-0', user_id: 'gp-zero-1', career_role_id: 'job-zero-alt-1', ats_stage: 'applied', matched_at: null }
    );

    const serverModule = await import('../server.js');
    const { redirectOthersForJob } = serverModule.__testUtils;

    resendCalls.length = 0;
    const result = await redirectOthersForJob('job-fill-3', null);
    expect(result.redirected).toBe(1);

    const row = db.gp_applications.find((a) => a.id === 'app-zero-1');
    expect(row.redirect_alternatives.alternatives).toEqual([]);

    const email = resendCalls.find((c) => (c.body.to || []).includes('gp-zero-1@gplink-test.local'));
    expect(email).toBeTruthy();
    expect(email.body.subject).toBe('An update on Riverbend Medical Centre — Toowoomba');
    expect(email.body.subject).not.toMatch(/door/i);
    expect(email.body.html).toContain('Reply to this email and Hazel will match you personally.');
    expect(email.body.html).not.toContain('✦ Already matched for you');
    expect(email.body.html).not.toContain('View this role');
    expect(email.body.html).not.toContain('See all roles picked for you');
    expect(email.body.html).not.toContain('98%');
  });
});

describe('redirectOthersForJob — per-row failure isolation (phase 4)', () => {
  it('one failing PATCH does not stop the other rows in the same batch, and reports the failure', async () => {
    resetDb();
    db.practices.push({ id: 'prac-fail-1', name: 'Sunnyvale Clinic', website: '', intro_video_url: '' });
    db.career_roles.push({
      id: 'job-fail-1', provider: 'internal_ats', title: 'General Practitioner', masked_title: 'Non-DPA - Sunnyvale - Mixed Billing',
      practice_name: 'Sunnyvale Clinic', practice_id: 'prac-fail-1',
      location_city: 'Cairns', location_state: 'QLD', billing_model: 'Mixed billing', earnings_text: '68% billings',
      job_status: 'open', is_active: true
    });
    ['gp-fail-ok-1', 'gp-fail-bad-1', 'gp-fail-ok-2'].forEach((uid) => {
      db.user_profiles.push({ user_id: uid, email: uid + '@gplink-test.local', first_name: 'Fail', last_name: 'Doctor', registration_country: 'united kingdom' });
    });
    db.gp_applications.push(
      { id: 'app-fail-ok-1', user_id: 'gp-fail-ok-1', career_role_id: 'job-fail-1', ats_stage: 'shortlisted', matched_at: null },
      { id: 'app-fail-bad-1', user_id: 'gp-fail-bad-1', career_role_id: 'job-fail-1', ats_stage: 'applied', matched_at: null },
      { id: 'app-fail-ok-2', user_id: 'gp-fail-ok-2', career_role_id: 'job-fail-1', ats_stage: 'interview', matched_at: null }
    );

    resendCalls.length = 0;
    failPatchIds.add('app-fail-bad-1');
    try {
      const serverModule = await import('../server.js');
      const { redirectOthersForJob } = serverModule.__testUtils;
      const result = await redirectOthersForJob('job-fail-1', null);

      expect(result.redirected).toBe(2);
      expect(result.errors.some((e) => e.id === 'app-fail-bad-1')).toBe(true);

      const okRow1 = db.gp_applications.find((a) => a.id === 'app-fail-ok-1');
      const okRow2 = db.gp_applications.find((a) => a.id === 'app-fail-ok-2');
      expect(okRow1.ats_stage).toBe('not_proceeding');
      expect(okRow2.ats_stage).toBe('not_proceeding');

      // The failing row is completely untouched — no stage change, no event, no email.
      const badRow = db.gp_applications.find((a) => a.id === 'app-fail-bad-1');
      expect(badRow.ats_stage).toBe('applied');
      expect(badRow.redirect_alternatives).toBeUndefined();
      expect(db.ats_stage_events.some((e) => e.application_id === 'app-fail-bad-1')).toBe(false);
      expect(resendCalls.some((c) => (c.body.to || []).includes('gp-fail-bad-1@gplink-test.local'))).toBe(false);

      // The two healthy rows DID get emailed.
      expect(resendCalls.some((c) => (c.body.to || []).includes('gp-fail-ok-1@gplink-test.local'))).toBe(true);
      expect(resendCalls.some((c) => (c.body.to || []).includes('gp-fail-ok-2@gplink-test.local'))).toBe(true);
    } finally {
      failPatchIds.delete('app-fail-bad-1');
    }
  });
});

describe('HTTP wiring — PATCH /api/ats/application hired path (phase 5)', () => {
  it('with redirect_others:true, hires the winner and redirects the others, returning {redirected:N}', async () => {
    resetDb();
    db.practices.push({ id: 'prac-hire-http-1', name: 'Northshore Medical', website: '', intro_video_url: '' });
    db.career_roles.push({
      id: 'job-hire-http-1', provider: 'internal_ats', title: 'General Practitioner', masked_title: 'DPA - Northshore - Mixed Billing',
      practice_name: 'Northshore Medical', practice_id: 'prac-hire-http-1',
      location_city: 'Rockhampton', location_state: 'QLD', billing_model: 'Mixed billing', earnings_text: '70% billings',
      job_status: 'open', is_active: true
    });
    ['gp-hire-winner-1', 'gp-hire-other-1', 'gp-hire-other-2'].forEach((uid) => {
      db.user_profiles.push({ user_id: uid, email: uid + '@gplink-test.local', first_name: 'Hire', last_name: 'Doctor', registration_country: 'ireland' });
    });
    db.gp_applications.push(
      { id: 'app-hire-winner-1', user_id: 'gp-hire-winner-1', career_role_id: 'job-hire-http-1', ats_stage: 'applied', matched_at: null },
      { id: 'app-hire-other-1', user_id: 'gp-hire-other-1', career_role_id: 'job-hire-http-1', ats_stage: 'shortlisted', matched_at: null },
      { id: 'app-hire-other-2', user_id: 'gp-hire-other-2', career_role_id: 'job-hire-http-1', ats_stage: 'interview', matched_at: null }
    );

    resendCalls.length = 0;
    const r = await httpReq('PATCH', '/api/ats/application?id=app-hire-winner-1', {
      host: SUPER_HOST, cookie: superCookie(), body: { stage: 'hired', redirect_others: true }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.application.ats_stage).toBe('hired');
    expect(r.body.redirected).toBe(2);

    const other1 = db.gp_applications.find((a) => a.id === 'app-hire-other-1');
    const other2 = db.gp_applications.find((a) => a.id === 'app-hire-other-2');
    expect(other1.ats_stage).toBe('not_proceeding');
    expect(other1.match_outcome).toBe('position_filled');
    expect(other2.ats_stage).toBe('not_proceeding');
    expect(other2.match_outcome).toBe('position_filled');

    // The winner's own row was never touched by the fan-out itself.
    const winner = db.gp_applications.find((a) => a.id === 'app-hire-winner-1');
    expect(winner.match_outcome).not.toBe('position_filled');

    // Targeted (not blanket) email assertions — the winner ALSO gets an
    // unrelated fire-and-forget "Congratulations" notification from the
    // existing stage-change notifier, which races independently of the
    // (awaited) redirect fan-out, so only the redirected GPs' mail is
    // asserted here.
    expect(resendCalls.some((c) => (c.body.to || []).includes('gp-hire-other-1@gplink-test.local'))).toBe(true);
    expect(resendCalls.some((c) => (c.body.to || []).includes('gp-hire-other-2@gplink-test.local'))).toBe(true);
  });

  it('without redirect_others, hiring proceeds but nothing is redirected (flag honored)', async () => {
    resetDb();
    db.career_roles.push({
      id: 'job-hire-http-2', provider: 'internal_ats', title: 'General Practitioner', masked_title: 'DPA - Flagoff - Mixed Billing',
      practice_name: 'Flagoff Medical', practice_id: null,
      location_city: 'Mackay', location_state: 'QLD', billing_model: 'Mixed billing', earnings_text: '70% billings',
      job_status: 'open', is_active: true
    });
    ['gp-hire-flagoff-winner-1', 'gp-hire-flagoff-other-1'].forEach((uid) => {
      db.user_profiles.push({ user_id: uid, email: uid + '@gplink-test.local', first_name: 'FlagOff', last_name: 'Doctor', registration_country: 'ireland' });
    });
    db.gp_applications.push(
      { id: 'app-hire-flagoff-winner-1', user_id: 'gp-hire-flagoff-winner-1', career_role_id: 'job-hire-http-2', ats_stage: 'applied', matched_at: null },
      { id: 'app-hire-flagoff-other-1', user_id: 'gp-hire-flagoff-other-1', career_role_id: 'job-hire-http-2', ats_stage: 'shortlisted', matched_at: null }
    );

    const r = await httpReq('PATCH', '/api/ats/application?id=app-hire-flagoff-winner-1', {
      host: SUPER_HOST, cookie: superCookie(), body: { stage: 'hired' }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.application.ats_stage).toBe('hired');
    expect(r.body.redirected).toBeUndefined();

    const other = db.gp_applications.find((a) => a.id === 'app-hire-flagoff-other-1');
    expect(other.ats_stage).toBe('shortlisted'); // untouched — no fan-out ran
    expect(other.match_outcome).toBeFalsy();
  });
});

describe('HTTP wiring — PATCH /api/ats/job close path (phase 6)', () => {
  it('with redirect_others:true, closing the job redirects every live applicant', async () => {
    resetDb();
    db.career_roles.push({
      id: 'job-close-1', provider: 'internal_ats', title: 'General Practitioner', masked_title: 'DPA - Close - Mixed Billing',
      practice_name: 'Close Medical', practice_id: null,
      location_city: 'Bundaberg', location_state: 'QLD', billing_model: 'Mixed billing', earnings_text: '70% billings',
      job_status: 'open', is_active: true
    });
    ['gp-close-1', 'gp-close-2'].forEach((uid) => {
      db.user_profiles.push({ user_id: uid, email: uid + '@gplink-test.local', first_name: 'Close', last_name: 'Doctor', registration_country: 'ireland' });
    });
    db.gp_applications.push(
      { id: 'app-close-1', user_id: 'gp-close-1', career_role_id: 'job-close-1', ats_stage: 'applied', matched_at: null },
      { id: 'app-close-2', user_id: 'gp-close-2', career_role_id: 'job-close-1', ats_stage: 'interview', matched_at: null }
    );

    resendCalls.length = 0;
    const r = await httpReq('PATCH', '/api/ats/job?id=job-close-1', {
      host: SUPER_HOST, cookie: superCookie(), body: { job_status: 'closed', redirect_others: true }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.redirected).toBe(2);

    const c1 = db.gp_applications.find((a) => a.id === 'app-close-1');
    const c2 = db.gp_applications.find((a) => a.id === 'app-close-2');
    expect(c1.ats_stage).toBe('not_proceeding');
    expect(c1.match_outcome).toBe('position_filled');
    expect(c2.ats_stage).toBe('not_proceeding');
    expect(c2.match_outcome).toBe('position_filled');
    expect(resendCalls.some((c) => (c.body.to || []).includes('gp-close-1@gplink-test.local'))).toBe(true);
    expect(resendCalls.some((c) => (c.body.to || []).includes('gp-close-2@gplink-test.local'))).toBe(true);
  });

  it('without redirect_others, closing the job leaves applicants untouched (flag honored)', async () => {
    resetDb();
    db.career_roles.push({
      id: 'job-close-2', provider: 'internal_ats', title: 'General Practitioner', masked_title: 'DPA - CloseOff - Mixed Billing',
      practice_name: 'CloseOff Medical', practice_id: null,
      location_city: 'Bundaberg', location_state: 'QLD', billing_model: 'Mixed billing', earnings_text: '70% billings',
      job_status: 'open', is_active: true
    });
    db.user_profiles.push({ user_id: 'gp-closeoff-1', email: 'gp-closeoff-1@gplink-test.local', first_name: 'CloseOff', last_name: 'Doctor', registration_country: 'ireland' });
    db.gp_applications.push({ id: 'app-closeoff-1', user_id: 'gp-closeoff-1', career_role_id: 'job-close-2', ats_stage: 'applied', matched_at: null });

    const r = await httpReq('PATCH', '/api/ats/job?id=job-close-2', {
      host: SUPER_HOST, cookie: superCookie(), body: { job_status: 'filled' }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.redirected).toBeUndefined();

    const row = db.gp_applications.find((a) => a.id === 'app-closeoff-1');
    expect(row.ats_stage).toBe('applied'); // untouched
    expect(row.match_outcome).toBeFalsy();
  });

  it('401s the HTTP triggers without an ATS session (no fan-out possible without auth)', async () => {
    const r = await httpReq('PATCH', '/api/ats/job?id=job-close-1', { body: { job_status: 'closed', redirect_others: true } });
    expect(r.status).toBe(401);
  });
});

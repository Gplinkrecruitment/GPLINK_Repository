// Task 7 (AI Matching, 2026-07-11 matching-board plan) — job.html for a
// matched GP: the shortlist REOPEN branch now sets revealed:true (fresh
// inserts already did), /api/career/role now returns `website` when
// revealed and a `match` block for a live/non-expired/owned shortlisted
// row, and job.html's client renders the verbatim blue banner + "Why this
// matches you" ticks + a relabelled sticky Accept bar when the url's
// ?match= param names that exact live match.
//
// Two halves:
//  (A) Source-regex wiring checks — no server boot needed.
//  (B) Endpoint behavior against a real Supabase-mode boot (in-memory
//      PostgREST emulator, pattern from tests/career-internal-apply.test.js
//      / tests/ai-candidate-job-match.test.js), a real ATS super_admin
//      session for the reopen call, and GP sessions for /api/career/role.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Source wiring (no server boot needed) ───────────────────────────────────
describe('AI Matching Task 7 — source wiring', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const jobHtml = fs.readFileSync(path.join(ROOT, 'pages/job.html'), 'utf8');

  it('the shortlist REOPEN branch (msPatch) sets revealed:true, same as the fresh-insert branch', () => {
    const idxShortlist = serverSrc.indexOf("pathname === '/api/ats/matching/shortlist'");
    expect(idxShortlist).toBeGreaterThan(-1);
    const idxPatch = serverSrc.indexOf('var msPatch = {', idxShortlist);
    expect(idxPatch).toBeGreaterThan(idxShortlist);
    const idxPatchEnd = serverSrc.indexOf('};', idxPatch);
    const patchSrc = serverSrc.slice(idxPatch, idxPatchEnd);
    expect(patchSrc).toContain('revealed: true');
    // The fresh-insert branch (further down in the same handler) already had it.
    const idxInsert = serverSrc.indexOf('origin: \'ai_matched\', revealed: true', idxPatchEnd);
    expect(idxInsert).toBeGreaterThan(idxPatchEnd);
  });

  it('/api/career/role attaches website + match ONLY inside the revealed branch', () => {
    const idxRole = serverSrc.indexOf("pathname === '/api/career/role'");
    expect(idxRole).toBeGreaterThan(-1);
    const idxRevealed = serverSrc.indexOf('if (revealed) {', idxRole);
    expect(idxRevealed).toBeGreaterThan(idxRole);
    const idxRevealedEnd = serverSrc.indexOf('\n    }\n', idxRevealed);
    const revealedSrc = serverSrc.slice(idxRevealed, idxRevealedEnd);
    expect(revealedSrc).toContain('roleClientPayload.website = revealedWebsite');
    expect(revealedSrc).toContain('getLiveShortlistedMatchForRole(roleDetailUserId, finalRoleRow.id)');
    expect(revealedSrc).toContain('roleClientPayload.match = {');
    expect(revealedSrc).toContain('applicationId: matchRow.id');
    expect(revealedSrc).toContain('expiresAt: matchRow.match_expires_at || null');
    expect(revealedSrc).toContain('score: (matchRow.match_score != null ? matchRow.match_score : null)');
  });

  it('the website source mirrors Task 6: practices.website falling back to the role own website', () => {
    const idx = serverSrc.indexOf('const revealedWebsite = ');
    expect(idx).toBeGreaterThan(-1);
    const src = serverSrc.slice(idx, idx + 250);
    expect(src).toContain('practiceRow && practiceRow.website');
    expect(src).toContain('resolveCareerRoleWebsiteUrl(finalRoleRow)');
  });

  // The role-level fallback moved into resolveCareerRoleWebsiteUrl so the match
  // card and the placement payload resolve a clinic website the same way. The
  // original guarantee still has to hold inside that helper: a curated
  // gpLink.websiteUrl wins, and the raw job-ad payload remains the last resort.
  it('resolveCareerRoleWebsiteUrl prefers gpLink.websiteUrl then falls back to extractCareerWebsiteUrl(source_payload)', () => {
    const idx = serverSrc.indexOf('function resolveCareerRoleWebsiteUrl(');
    expect(idx).toBeGreaterThan(-1);
    const fnSrc = serverSrc.slice(idx, idx + 500);
    expect(fnSrc).toContain('getCareerRoleGpLinkMeta(row)');
    expect(fnSrc).toContain('meta.websiteUrl');
    expect(fnSrc).toContain('extractCareerWebsiteUrl(getCareerRoleRawPayload(row))');
  });

  it('getLiveShortlistedMatchForRole requires shortlisted + matched_at + NOT expired', () => {
    const idx = serverSrc.indexOf('async function getLiveShortlistedMatchForRole');
    expect(idx).toBeGreaterThan(-1);
    const fnSrc = serverSrc.slice(idx, idx + 1400);
    expect(fnSrc).toContain("application.ats_stage !== 'shortlisted' || !application.matched_at");
    expect(fnSrc).toContain('application.match_expires_at && new Date(application.match_expires_at).getTime() <= Date.now()');
  });

  it('job.html has the verbatim job-page banner + "Why this matches you" ticks, gated by getActiveMatch', () => {
    expect(jobHtml).toContain("Your team matched you here for a reason — this page normally hides the practice name, but your match unlocks the full picture.");
    expect(jobHtml).toContain('function buildMatchBannerHtml(role)');
    expect(jobHtml).toContain('function buildMatchWhyHtml(role)');
    expect(jobHtml).toContain('Why this matches you');
    expect(jobHtml).toContain('function getActiveMatch(role)');
    // Banner/ticks both gate on the SAME getActiveMatch() check.
    const idxBanner = jobHtml.indexOf('function buildMatchBannerHtml(role) {');
    expect(jobHtml.slice(idxBanner, idxBanner + 200)).toContain('getActiveMatch(role)');
    const idxWhy = jobHtml.indexOf('function buildMatchWhyHtml(role) {');
    expect(jobHtml.slice(idxWhy, idxWhy + 200)).toContain('getActiveMatch(role)');
  });

  // Was: "requires ... the url ?match= param to match it". Dropped 2026-07-27.
  // A live match belongs to the ROW, not to how the doctor arrived. Requiring
  // the deep-link param meant anyone reaching the page another way (the
  // email's new practice-profile link, a saved role, search) saw no match UI —
  // and because the practice-side shortlist creates a gp_applications row,
  // isApplied() was true and the page claimed "Application received /
  // ✓ Submitted" for something they had never applied to and still owed an
  // answer on. GET /api/career/role only attaches role.match for a live,
  // shortlisted, non-expired match owned by this user, so the row is the gate.
  it('getActiveMatch requires role.match and a non-expired countdown — NOT the url ?match= param', () => {
    const idx = jobHtml.indexOf('function getActiveMatch(role) {');
    expect(idx).toBeGreaterThan(-1);
    const fnSrc = jobHtml.slice(idx, idx + 500);
    expect(fnSrc).toContain('match.applicationId');
    expect(fnSrc).toContain('formatMatchCountdown(match.expiresAt).expired');
    expect(fnSrc).not.toContain('getMatchIdFromUrl()');
    expect(fnSrc).not.toContain('urlMatchId');
  });

  it('a pending match outranks the applied state — no "Application received", no "✓ Submitted"', () => {
    // The banner slot and the sticky-bar state both defer to getActiveMatch,
    // so a shortlisted-but-unanswered row can never render as submitted.
    expect(jobHtml).toContain('isApplied(role.id) && !getActiveMatch(role) ? buildReceivedHtml() : ""');
    expect(jobHtml).toContain('applyState = (isApplied(role.id) && !getActiveMatch(role)) ? "applied" : "idle"');
  });

  it('a live match offers decline next to accept, via match/respond', () => {
    expect(jobHtml).toContain('id="matchDeclineBtn"');
    expect(jobHtml).toContain('Not the right fit — decline');
    const idx = jobHtml.indexOf('async function declineActiveMatch() {');
    expect(idx).toBeGreaterThan(-1);
    const fnSrc = jobHtml.slice(idx, idx + 1400);
    expect(fnSrc).toContain('/api/career/match/respond');
    expect(fnSrc).toContain('action: "decline"');
    // Only shown while the match is still answerable.
    expect(jobHtml).toContain('matchDeclineBtnEl.hidden = !(activeMatch && applyState === "idle")');
  });

  it('previously_withdrawn is terminal, so a declined match cannot repaint as submitted', () => {
    const idx = jobHtml.indexOf('const TERMINAL_APPLY_STATES =');
    const line = jobHtml.slice(idx, idx + 200);
    expect(line).toContain('previously_withdrawn');
  });

  it('job.html sticky bar relabels to "Accept this match" with the verbatim countdown sub-line, without a new accept call', () => {
    expect(jobHtml).toContain('Accept this match<small>');
    expect(jobHtml).toContain('" — your spot is reserved until then</small>"');
    // submitApply() still only ever POSTs /api/career/apply — no separate
    // match/respond call was introduced for the matched-job-page path.
    const idxSubmit = jobHtml.indexOf('async function submitApply()');
    const fnSrc = jobHtml.slice(idxSubmit, idxSubmit + 1200);
    expect(fnSrc).toContain('fetch("/api/career/apply"');
    expect(fnSrc).not.toContain('/api/career/match/respond');
  });

  it('the deliberate-apply confirm sheet mentions accepting the match when a live match is active', () => {
    const idx = jobHtml.indexOf('function openApplyConfirm() {');
    const fnSrc = jobHtml.slice(idx, idx + 900);
    expect(fnSrc).toContain('"Accept this match?"');
    expect(fnSrc).toMatch(/accept/i);
    expect(fnSrc).toContain('activeMatch ? "Accept" : "Apply"');
  });

  it('job.html renders the revealed website link (http(s)-only) and an output=embed map', () => {
    expect(jobHtml).toContain('at-dweb');
    expect(jobHtml).toContain('🌐 \' + escapeHtml(websiteLabel) + \' ↗');
    expect(jobHtml).toContain('matchSafeUrl(role.website)');
    expect(jobHtml).toContain('&output=embed');
  });
});

// ── Endpoint behavior against a real Supabase-mode boot ─────────────────────
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-matching-job-unmask-${RUN_ID}.json`);
const SUPER_HOST = 'ats-test.local';
const SUPER_EMAIL = 'super@gplink-test.local';
let server, port;
let sbServer, sbPort;

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ── In-memory PostgREST emulator (pattern from tests/career-internal-apply.test.js) ──
const db = {
  user_profiles: [],
  user_state: [],
  user_documents: [],
  registration_cases: [],
  practices: [],
  career_roles: [],
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
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: SUPER_EMAIL, adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function userCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
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
const atsPost = (p, body) => httpReq('POST', p, { host: SUPER_HOST, cookie: superCookie(), body });

// ── Fixtures ──────────────────────────────────────────────────────────────
const PRACTICE_A = { id: 'practice-a', name: 'Coral Coast Family Practice', website: 'https://coralcoastfp.com.au' };
const ROLE_A = {
  id: 'role-a', provider: 'internal_ats', provider_role_id: 'ats_role_a',
  title: 'VR General Practitioner — Full time', practice_id: PRACTICE_A.id, practice_name: PRACTICE_A.name,
  dpa: true, is_active: true, job_status: 'open', ats_created: true, updated_at: iso(NOW)
};
// No practice_id at all — website must fall back to extractCareerWebsiteUrl
// reading the role's own source_payload (Task 6's pattern for /matches).
const ROLE_B = {
  id: 'role-b', provider: 'internal_ats', provider_role_id: 'ats_role_b',
  title: 'GP — Fallback-website role', practice_id: null, practice_name: 'Fallback Practice',
  dpa: true, is_active: true, job_status: 'open', ats_created: true, updated_at: iso(NOW),
  source_payload: { Practice_Website: 'fallbacksite.com.au' }
};

const REOPEN_GP = { userId: 'gp-reopen-1', email: 'reopen@gplink-test.local' };
const MATCHED_GP = { userId: 'gp-matched-1', email: 'matched@gplink-test.local' };
const OTHER_GP = { userId: 'gp-other-1', email: 'other@gplink-test.local' };
const REVEALED_NO_MATCH_GP = { userId: 'gp-revealed-1', email: 'revealed@gplink-test.local' };
const EXPIRED_MATCH_GP = { userId: 'gp-expired-1', email: 'expired@gplink-test.local' };
const FALLBACK_GP = { userId: 'gp-fallback-1', email: 'fallback@gplink-test.local' };

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'matching-job-unmask-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = '';
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.OPENAI_API_KEY = ''; // keep ensureCareerRoleWebsiteBilling/AiProfile no-ops
  process.env.RESEND_API_KEY = ''; // sendMatchEmail no-ops, no network call

  db.practices.push(PRACTICE_A);
  db.career_roles.push(ROLE_A, ROLE_B);

  // REOPEN_GP: real candidate-pool fixtures so the shortlist endpoint's
  // server-side eligibility re-check passes (checkMatchEligibility).
  db.user_profiles.push({ user_id: REOPEN_GP.userId, email: REOPEN_GP.email, first_name: 'Reopen', last_name: 'Doctor', registration_country: 'uk' });
  db.user_state.push({ user_id: REOPEN_GP.userId, state: { gp_onboarding_complete: true, account_status: 'active' } });
  db.user_documents.push({ id: 'doc-reopen', user_id: REOPEN_GP.userId, document_key: 'cv_signed_dated', status: 'uploaded' });
  // A TERMINAL prior row on role-a — the reopen case (the bug this task fixes).
  db.gp_applications.push({
    id: 'app-reopen-1', user_id: REOPEN_GP.userId, career_role_id: ROLE_A.id,
    ats_stage: 'not_proceeding', origin: 'ai_matched', revealed: false,
    match_outcome: 'declined', decline_reason: 'Too far from family',
    match_reasons: { reasons: ['old reason'], _history: [] }
  });

  // MATCHED_GP: a live shortlisted match seeded directly (isolates the
  // /api/career/role read from the shortlist-endpoint write path above).
  db.gp_applications.push({
    id: 'app-matched-1', user_id: MATCHED_GP.userId, career_role_id: ROLE_A.id,
    ats_stage: 'shortlisted', origin: 'ai_matched', revealed: true,
    matched_at: iso(NOW), match_expires_at: iso(NOW + 5 * 24 * 60 * 60 * 1000),
    match_score: 91,
    match_reasons: { reasons: ['Coastal Queensland — your top preferred region', 'Family-medicine caseload matches your experience'], _history: [] }
  });

  // REVEALED_NO_MATCH_GP: revealed via admin_applied origin, but no live
  // match — must show the real practice/website but never a match block.
  db.gp_applications.push({
    id: 'app-revealed-1', user_id: REVEALED_NO_MATCH_GP.userId, career_role_id: ROLE_A.id,
    ats_stage: 'applied', origin: 'admin_applied'
  });

  // EXPIRED_MATCH_GP: still ats_stage 'shortlisted' + revealed:true (cron
  // hasn't swept it yet), but match_expires_at already elapsed — the `match`
  // block must NOT appear (identity stays revealed either way).
  db.gp_applications.push({
    id: 'app-expired-1', user_id: EXPIRED_MATCH_GP.userId, career_role_id: ROLE_A.id,
    ats_stage: 'shortlisted', origin: 'ai_matched', revealed: true,
    matched_at: iso(NOW - 6 * 24 * 60 * 60 * 1000), match_expires_at: iso(NOW - 60 * 60 * 1000),
    match_score: 70, match_reasons: { reasons: ['Regional experience'], _history: [] }
  });

  // FALLBACK_GP: revealed on role-b (no practice_id) — proves the website
  // fallback to extractCareerWebsiteUrl(source_payload).
  db.gp_applications.push({
    id: 'app-fallback-1', user_id: FALLBACK_GP.userId, career_role_id: ROLE_B.id,
    ats_stage: 'applied', origin: 'admin_applied'
  });

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('POST /api/ats/matching/shortlist — reopen sets revealed:true', () => {
  it('reopens the terminal row AND flips revealed to true (asserted directly on the emulator row)', async () => {
    const before = db.gp_applications.find((a) => a.id === 'app-reopen-1');
    expect(before.revealed).toBe(false); // sanity: the bug's starting state

    const r = await atsPost('/api/ats/matching/shortlist', { items: [{ user_id: REOPEN_GP.userId, career_role_id: ROLE_A.id }] });
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([{ user_id: REOPEN_GP.userId, career_role_id: ROLE_A.id, ok: true, reopened: true }]);

    const row = db.gp_applications.find((a) => a.id === 'app-reopen-1');
    expect(row.ats_stage).toBe('shortlisted');
    expect(row.revealed).toBe(true); // the fix — the whole point of this test
    expect(row.match_outcome).toBeNull();
  });

  it('the just-reopened row now shows up as a live match on /api/career/role for that GP', async () => {
    const res = await httpReq('GET', '/api/career/role?id=' + encodeURIComponent('internal_ats:ats_role_a'), { cookie: userCookie(REOPEN_GP.email, REOPEN_GP.userId) });
    expect(res.status).toBe(200);
    expect(res.body.role.revealed).toBe(true);
    expect(res.body.role.realPracticeName).toBe(PRACTICE_A.name);
    expect(res.body.role.match).toBeTruthy();
    expect(res.body.role.match.applicationId).toBe('app-reopen-1');
    expect(Array.isArray(res.body.role.match.reasons)).toBe(true);
  });
});

describe('GET /api/career/role — website + match for a matched GP', () => {
  it('returns realPracticeName, website (from practices.website), and the match block', async () => {
    const res = await httpReq('GET', '/api/career/role?id=' + encodeURIComponent('internal_ats:ats_role_a'), { cookie: userCookie(MATCHED_GP.email, MATCHED_GP.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const role = res.body.role;
    expect(role.revealed).toBe(true);
    expect(role.realPracticeName).toBe('Coral Coast Family Practice');
    expect(role.website).toBe('https://coralcoastfp.com.au');
    expect(role.match).toEqual({
      applicationId: 'app-matched-1',
      expiresAt: db.gp_applications.find((a) => a.id === 'app-matched-1').match_expires_at,
      reasons: ['Coastal Queensland — your top preferred region', 'Family-medicine caseload matches your experience'],
      score: 91
    });
  });

  it('REGRESSION: a non-matched GP gets no website, no match, and the masked title unchanged', async () => {
    const res = await httpReq('GET', '/api/career/role?id=' + encodeURIComponent('internal_ats:ats_role_a'), { cookie: userCookie(OTHER_GP.email, OTHER_GP.userId) });
    expect(res.status).toBe(200);
    const role = res.body.role;
    expect(role.revealed).toBeUndefined();
    expect(role.website).toBeUndefined();
    expect(role.match).toBeUndefined();
    // Masked title unchanged — never the real practice name.
    expect(role.practiceName).toBeTruthy();
    expect(role.practiceName).not.toBe('Coral Coast Family Practice');
    expect(res.raw).not.toContain('Coral Coast Family Practice');
    expect(res.raw).not.toContain('coralcoastfp.com.au');
  });

  it('a revealed application with NO live match shows the practice but never a match block', async () => {
    const res = await httpReq('GET', '/api/career/role?id=' + encodeURIComponent('internal_ats:ats_role_a'), { cookie: userCookie(REVEALED_NO_MATCH_GP.email, REVEALED_NO_MATCH_GP.userId) });
    expect(res.status).toBe(200);
    const role = res.body.role;
    expect(role.revealed).toBe(true);
    expect(role.realPracticeName).toBe('Coral Coast Family Practice');
    expect(role.match).toBeUndefined();
  });

  it('an EXPIRED (unswept) match stays revealed but drops the match block', async () => {
    const res = await httpReq('GET', '/api/career/role?id=' + encodeURIComponent('internal_ats:ats_role_a'), { cookie: userCookie(EXPIRED_MATCH_GP.email, EXPIRED_MATCH_GP.userId) });
    expect(res.status).toBe(200);
    const role = res.body.role;
    expect(role.revealed).toBe(true); // identity reveal is one-way, never re-masked
    expect(role.match).toBeUndefined(); // but the live-match block must not survive expiry
  });

  it('website falls back to extractCareerWebsiteUrl(source_payload) when there is no practice_id', async () => {
    const res = await httpReq('GET', '/api/career/role?id=' + encodeURIComponent('internal_ats:ats_role_b'), { cookie: userCookie(FALLBACK_GP.email, FALLBACK_GP.userId) });
    expect(res.status).toBe(200);
    const role = res.body.role;
    expect(role.revealed).toBe(true);
    // extractCareerWebsiteUrl -> sanitizeHttpUrl round-trips through
    // `new URL(...).toString()`, which normalizes a bare-domain root path
    // to a trailing slash — same as every other extractCareerWebsiteUrl call
    // site in this file, not something Task 7 needs to special-case.
    expect(role.website).toBe('https://fallbacksite.com.au/');
  });
});

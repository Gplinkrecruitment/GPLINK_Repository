// Task 6 (2026-07-11 matching-board plan): career.html match card gains —
// GET /api/career/matches returns a new `mapQuery` field per live match
// (spec Part C §1), and the card gains a website button, a map preview +
// "Open in Maps" link, a "See the full job opening" row, a sticky accept
// bar, `?needtime=1` handling, and client-side 24h/2h nudge alerts.
//
// Server-side coverage boots the real server against a tiny in-memory
// PostgREST emulator (pattern from tests/ai-matching-gp-flow.test.js), so the
// FULL Supabase-mode /api/career/matches code path runs. Client-side coverage
// is file-content assertions (pattern from tests/apply-sheet-mobile-fit.test.js)
// plus real execution of the page's own pure-logic functions via `new
// Function` sandboxing (pattern from ai-matching-gp-flow.test.js's "review
// fix 1" — extractFunctionSource by brace counting, no browser needed).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Extracts a top-level `function <name>(...) {...}` declaration from
// inline page source by brace counting, so the REAL client-side function can
// be executed (not just regex-inspected) in these tests. ──────────────────
function extractFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} braces never balanced`);
}

// ============================================================================
// Client-side: file-content assertions + real execution (no server needed)
// ============================================================================

describe('career.html — file-content checks for Task 6 (design R6) additions', () => {
  const careerHtml = fs.readFileSync(path.join(ROOT, 'pages/career.html'), 'utf8');

  it('match card: website button, map embed + overlay link, see-job row', () => {
    expect(careerHtml).toContain('🌐 Visit website');
    expect(careerHtml).toContain('Open in Maps ↗');
    expect(careerHtml).toContain('maps.google.com/maps?q=');
    expect(careerHtml).toContain('output=embed');
    expect(careerHtml).toContain('See the full job opening');
    expect(careerHtml).toContain('job.html?id=');
    expect(careerHtml).toContain('&match=');
  });

  it('sticky accept bar: host element + verbatim sub-line + shell-clearance CSS', () => {
    expect(careerHtml).toContain('id="matchStickyBar"');
    expect(careerHtml).toContain('function renderMatchStickyBar()');
    expect(careerHtml).toContain('data-match-sticky-accept');
    expect(careerHtml).toContain('— your spot is reserved until then');
    const barCss = careerHtml.slice(careerHtml.indexOf('.at-match-stickybar {'), careerHtml.indexOf('.at-match-stickybar-sub'));
    expect(barCss).toMatch(/max\(\s*env\(safe-area-inset-bottom[^)]*\)\s*,\s*var\(--gp-shell-bottom-clearance[^)]*\)\s*\)/);
  });

  it('needtime: handleMatchDeepLink posts need-more-time and shows the verbatim toast', () => {
    const fnSrc = extractFunctionSource(careerHtml, 'handleMatchDeepLink');
    expect(fnSrc).toContain('needtime');
    expect(fnSrc).toContain('/api/career/match/need-more-time');
    expect(fnSrc).toContain("We've let the team know you need more time. They may extend your window — watch your alerts. Accepting now still works.");
    expect(fnSrc).toContain('"noted"');
    expect(fnSrc).toContain('"already"');
    // Still never posts an accept from the deep link (pre-existing review
    // fix 3b guarantee from tests/ai-matching-gp-flow.test.js — re-asserted
    // here since this function was touched).
    expect(fnSrc).not.toContain('/api/career/match/respond');
  });

  it('client nudge alerts: deduped per application+threshold in localStorage', () => {
    expect(careerHtml).toContain('match-nudge-24h-');
    expect(careerHtml).toContain('match-nudge-2h-');
    expect(careerHtml).toContain('function checkMatchNudgeAlerts');
    expect(careerHtml).toContain('function pushMatchNudgeAlert');
  });
});

describe('buildMatchCardHtml — website/map/see-job additions (career.html, executed for real)', () => {
  const careerHtml = fs.readFileSync(path.join(ROOT, 'pages/career.html'), 'utf8');
  const sandboxSrc = [
    extractFunctionSource(careerHtml, 'escapeHtml'),
    extractFunctionSource(careerHtml, 'matchSafeUrl'),
    extractFunctionSource(careerHtml, 'formatMatchCountdown'),
    extractFunctionSource(careerHtml, 'buildMatchCardHtml'),
    'return buildMatchCardHtml(matchInput);'
  ].join('\n');
  const renderCard = (matchInput) => new Function('matchInput', sandboxSrc)(matchInput);

  const baseMatch = {
    applicationId: 'app-map-1', roleId: 'role-99', jobTitle: 'GP — Mixed Billing', practiceName: 'Coral Coast Family Practice',
    locationCity: 'Bundaberg', locationState: 'QLD', dpa: true,
    reasons: ['Coastal fit'], expiresAt: new Date(Date.now() + 3 * 86400000).toISOString(),
    website: 'https://coralcoastfp.com.au', introVideoUrl: '', headerImageUrl: '',
    mapQuery: 'Coral Coast Family Practice, Bundaberg, QLD'
  };

  it('renders the website button, the map embed + overlay link, and the see-job row (roleId + applicationId)', () => {
    const html = renderCard(baseMatch);
    expect(html).toContain('🌐 Visit website');
    expect(html).toContain('href="https://coralcoastfp.com.au"');
    // & is HTML-attribute-escaped to &amp; by escapeHtml — correct HTML, not a bug.
    expect(html).toContain('src="https://maps.google.com/maps?q=Coral%20Coast%20Family%20Practice%2C%20Bundaberg%2C%20QLD&amp;output=embed"');
    expect(html).toContain('Open in Maps ↗');
    expect(html).toContain('href="https://www.google.com/maps?q=Coral%20Coast%20Family%20Practice%2C%20Bundaberg%2C%20QLD"');
    expect(html).toContain('See the full job opening');
    expect(html).toContain('href="/pages/job.html?id=role-99&amp;match=app-map-1"');
  });

  it('omits the website button and map block when absent, but still renders the see-job row', () => {
    const html = renderCard({ ...baseMatch, website: '', mapQuery: '' });
    expect(html).not.toContain('at-match-qbtn');
    expect(html).not.toContain('at-match-map"');
    expect(html).toContain('See the full job opening');
  });

  it('a mapQuery carrying an attribute-breakout attempt cannot escape the iframe/link attributes', () => {
    const html = renderCard({ ...baseMatch, mapQuery: 'Foo" onmouseover="alert(1)' });
    expect(html).not.toContain('" onmouseover="alert(1)');
    expect(html).not.toContain('onmouseover=');
  });

  it('a javascript: website still renders NO link (pre-existing scheme gate, re-asserted since the card gained a second website link)', () => {
    const html = renderCard({ ...baseMatch, website: 'javascript:alert(document.cookie)' });
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('at-match-qbtn');
  });
});

describe('sticky-bar live-match helpers — isMatchLive/getLiveMatches/pickStickyMatch (career.html, executed for real)', () => {
  const careerHtml = fs.readFileSync(path.join(ROOT, 'pages/career.html'), 'utf8');
  const sandboxSrc = [
    extractFunctionSource(careerHtml, 'formatMatchCountdown'),
    extractFunctionSource(careerHtml, 'isMatchLive'),
    extractFunctionSource(careerHtml, 'getLiveMatches'),
    extractFunctionSource(careerHtml, 'pickStickyMatch'),
    'return { getLiveMatches, pickStickyMatch, isMatchLive };'
  ].join('\n');
  const makeHelpers = (teamMatchesState) => new Function('teamMatchesState', sandboxSrc)(teamMatchesState);

  const liveSoon = { applicationId: 'app-a', expiresAt: new Date(Date.now() + 3 * 3600000).toISOString() };
  const liveLater = { applicationId: 'app-b', expiresAt: new Date(Date.now() + 5 * 86400000).toISOString() };
  const expired = { applicationId: 'app-c', expiresAt: new Date(Date.now() - 3600000).toISOString() };

  it('getLiveMatches excludes expired matches', () => {
    const helpers = makeHelpers({ matches: [liveSoon, expired, liveLater] });
    expect(helpers.getLiveMatches().map((m) => m.applicationId)).toEqual(['app-a', 'app-b']);
  });

  it('pickStickyMatch prefers the ?match= deep-linked id when it is live', () => {
    global.window = { location: { href: 'https://app.example/career?match=app-b' } };
    const helpers = makeHelpers({ matches: [liveSoon, liveLater] });
    expect(helpers.pickStickyMatch(helpers.getLiveMatches()).applicationId).toBe('app-b');
  });

  it('pickStickyMatch falls back to the first (newest) live match when there is no deep link', () => {
    global.window = { location: { href: 'https://app.example/career' } };
    const helpers = makeHelpers({ matches: [liveSoon, liveLater] });
    expect(helpers.pickStickyMatch(helpers.getLiveMatches()).applicationId).toBe('app-a');
  });

  it('pickStickyMatch ignores a deep link to an expired match, falling back to the newest live match', () => {
    global.window = { location: { href: 'https://app.example/career?match=app-c' } };
    const helpers = makeHelpers({ matches: [liveSoon, expired] });
    expect(helpers.pickStickyMatch(helpers.getLiveMatches()).applicationId).toBe('app-a');
  });

  it('pickStickyMatch returns null when there are no live matches', () => {
    global.window = { location: { href: 'https://app.example/career' } };
    const helpers = makeHelpers({ matches: [expired] });
    expect(helpers.pickStickyMatch(helpers.getLiveMatches())).toBeNull();
  });
});

describe('client nudge alerts — checkMatchNudgeAlerts/pushMatchNudgeAlert (career.html, executed for real)', () => {
  const careerHtml = fs.readFileSync(path.join(ROOT, 'pages/career.html'), 'utf8');
  const sandboxSrc = [
    extractFunctionSource(careerHtml, 'pushMatchNudgeAlert'),
    extractFunctionSource(careerHtml, 'checkMatchNudgeAlerts'),
    'return checkMatchNudgeAlerts;'
  ].join('\n');
  const makeRunCheck = () => new Function(sandboxSrc)();

  function makeLocalStorage() {
    const store = {};
    return {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    };
  }

  it('a match <2h left fires BOTH thresholds once each, using the exact dedupe key format, then dedupes on a repeat call', () => {
    const pushed = [];
    global.window = { saveGpLinkUpdates: (items) => pushed.push(items[0]), getGpLinkUpdates: () => [] };
    global.localStorage = makeLocalStorage();
    const runCheck = makeRunCheck();
    const soonMatch = { applicationId: 'app-nudge-1', practiceName: 'Test Practice', expiresAt: new Date(Date.now() + 1.5 * 3600000).toISOString() };

    runCheck([soonMatch]);
    expect(pushed.length).toBe(2);
    expect(global.localStorage.getItem('match-nudge-24h-app-nudge-1')).toBe('1');
    expect(global.localStorage.getItem('match-nudge-2h-app-nudge-1')).toBe('1');

    runCheck([soonMatch]); // repeat — fully deduped
    expect(pushed.length).toBe(2);
  });

  it('a match with 10 hours left fires ONLY the 24h threshold', () => {
    const pushed = [];
    global.window = { saveGpLinkUpdates: (items) => pushed.push(items[0]), getGpLinkUpdates: () => [] };
    global.localStorage = makeLocalStorage();
    const runCheck = makeRunCheck();
    const tenHoursMatch = { applicationId: 'app-nudge-2', practiceName: 'Test Practice', expiresAt: new Date(Date.now() + 10 * 3600000).toISOString() };

    runCheck([tenHoursMatch]);
    expect(pushed.length).toBe(1);
    expect(global.localStorage.getItem('match-nudge-24h-app-nudge-2')).toBe('1');
    expect(global.localStorage.getItem('match-nudge-2h-app-nudge-2')).toBeNull();
  });

  it('a match with 5 days left fires no alert at all', () => {
    const pushed = [];
    global.window = { saveGpLinkUpdates: (items) => pushed.push(items[0]), getGpLinkUpdates: () => [] };
    global.localStorage = makeLocalStorage();
    const runCheck = makeRunCheck();
    const farMatch = { applicationId: 'app-nudge-3', practiceName: 'Test Practice', expiresAt: new Date(Date.now() + 5 * 86400000).toISOString() };

    runCheck([farMatch]);
    expect(pushed.length).toBe(0);
  });
});

// ============================================================================
// Server-side: GET /api/career/matches returns mapQuery for live matches
// ============================================================================

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-matching-card-enrichment-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;
let realFetch;

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const GP_ADDR = { userId: 'gp-addr-1', email: 'addr@gplink-test.local' };
const GP_NOADDR = { userId: 'gp-noaddr-1', email: 'noaddr@gplink-test.local' };
const GP_INTAKE = { userId: 'gp-intake-1', email: 'intake@gplink-test.local' };
const ALL_GPS = [GP_ADDR, GP_NOADDR, GP_INTAKE];

const db = {
  user_profiles: ALL_GPS.map((g, i) => ({
    user_id: g.userId, email: g.email, first_name: 'Test', last_name: `Doctor${i}`,
    registration_country: 'united kingdom'
  })),
  user_state: ALL_GPS.map((g) => ({
    user_id: g.userId, state: { gp_onboarding_complete: true }, updated_at: iso(NOW)
  })),
  practices: [
    // Real street address on file — mapQuery must use it (matching
    // /api/career/role's revealedMapQuery [address, suburb, state] shape).
    { id: 'prac-addr', name: 'Coral Coast Family Practice', address: 'Shop 4, 12 Bay Tce', website: '', intro_video_url: '' },
    // No address anywhere — mapQuery must fall back to practice name.
    { id: 'prac-noaddr', name: 'Riverbend Medical Centre', address: '', website: '', intro_video_url: '' },
    // Legacy intake-only address (metadata.intake.address, no top-level column).
    { id: 'prac-intake', name: 'Ocean View Clinic', metadata: { intake: { address: '5 Ocean Dr' } }, website: '', intro_video_url: '' }
  ],
  career_roles: [
    {
      id: 'job-addr', provider: 'internal_ats', provider_role_id: 'ats_job_addr',
      title: 'GP — Mixed Billing', practice_name: 'Coral Coast Family Practice', practice_id: 'prac-addr',
      location_city: 'Bundaberg', location_state: 'QLD', suburb: 'Bargara', dpa: true,
      header_image_url: '', job_status: 'open', is_active: true
    },
    {
      id: 'job-noaddr', provider: 'internal_ats', provider_role_id: 'ats_job_noaddr',
      title: 'GP — Bulk Billing', practice_name: 'Riverbend Medical Centre', practice_id: 'prac-noaddr',
      location_city: 'Toowoomba', location_state: 'QLD', suburb: '', dpa: false,
      header_image_url: '', job_status: 'open', is_active: true
    },
    {
      id: 'job-intake', provider: 'internal_ats', provider_role_id: 'ats_job_intake',
      title: 'GP — Chronic Disease', practice_name: 'Ocean View Clinic', practice_id: 'prac-intake',
      location_city: 'Hervey Bay', location_state: 'QLD', suburb: 'Urangan', dpa: true,
      header_image_url: '', job_status: 'open', is_active: true
    }
  ],
  gp_applications: [
    {
      id: 'app-addr-1', user_id: GP_ADDR.userId, career_role_id: 'job-addr',
      provider_role_id: 'ats_job_addr', ats_stage: 'shortlisted', origin: 'ai_matched',
      status: 'applied', job_title: 'GP — Mixed Billing', practice_name: 'Coral Coast Family Practice',
      match_score: 80, match_reasons: { reasons: ['Coastal fit'], _history: [] },
      matched_by: 'consultant@gplink-test.local', matched_at: iso(NOW - 3600000), match_expires_at: iso(NOW + 4 * 86400000),
      match_seen_at: null, match_outcome: null
    },
    {
      id: 'app-noaddr-1', user_id: GP_NOADDR.userId, career_role_id: 'job-noaddr',
      provider_role_id: 'ats_job_noaddr', ats_stage: 'shortlisted', origin: 'ai_matched',
      status: 'applied', job_title: 'GP — Bulk Billing', practice_name: 'Riverbend Medical Centre',
      match_score: 65, match_reasons: { reasons: ['Regional fit'], _history: [] },
      matched_by: 'consultant@gplink-test.local', matched_at: iso(NOW - 3600000), match_expires_at: iso(NOW + 4 * 86400000),
      match_seen_at: null, match_outcome: null
    },
    {
      id: 'app-intake-1', user_id: GP_INTAKE.userId, career_role_id: 'job-intake',
      provider_role_id: 'ats_job_intake', ats_stage: 'shortlisted', origin: 'ai_matched',
      status: 'applied', job_title: 'GP — Chronic Disease', practice_name: 'Ocean View Clinic',
      match_score: 70, match_reasons: { reasons: ['Chronic disease caseload fit'], _history: [] },
      matched_by: 'consultant@gplink-test.local', matched_at: iso(NOW - 3600000), match_expires_at: iso(NOW + 4 * 86400000),
      match_seen_at: null, match_outcome: null
    }
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
  process.env.AUTH_SECRET = 'matching-card-enrichment-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.OPENAI_API_KEY = '';
  process.env.ADMIN_EMAILS = '';
  process.env.SUPER_ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 'test-resend-key';

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.resend.com/')) {
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-stub' }), { status: 200 }));
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

describe('GET /api/career/matches — mapQuery (Task 6)', () => {
  it('uses the real street address (+ suburb/state) when one is on file', async () => {
    const res = await httpReq('GET', '/api/career/matches', { cookie: userCookie(GP_ADDR.email, GP_ADDR.userId) });
    expect(res.status).toBe(200);
    const m = res.body.matches.find((x) => x.applicationId === 'app-addr-1');
    expect(m).toBeTruthy();
    expect(m.mapQuery).toBe('Shop 4, 12 Bay Tce, Bargara, QLD');
  });

  it('falls back to the practice name + city/state when no address is on file', async () => {
    const res = await httpReq('GET', '/api/career/matches', { cookie: userCookie(GP_NOADDR.email, GP_NOADDR.userId) });
    expect(res.status).toBe(200);
    const m = res.body.matches.find((x) => x.applicationId === 'app-noaddr-1');
    expect(m).toBeTruthy();
    expect(m.mapQuery).toBe('Riverbend Medical Centre, Toowoomba, QLD');
  });

  it('resolves a legacy intake-only address (metadata.intake.address, no top-level address column)', async () => {
    const res = await httpReq('GET', '/api/career/matches', { cookie: userCookie(GP_INTAKE.email, GP_INTAKE.userId) });
    expect(res.status).toBe(200);
    const m = res.body.matches.find((x) => x.applicationId === 'app-intake-1');
    expect(m).toBeTruthy();
    expect(m.mapQuery).toBe('5 Ocean Dr, Urangan, QLD');
  });
});

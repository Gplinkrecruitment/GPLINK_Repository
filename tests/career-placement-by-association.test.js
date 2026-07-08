// Placement-by-association (owner request 2026-07-08).
//
// A GP whose registration case has been explicitly tied to a practice
// (admin-curated registration_cases.practice_name) is PLACED, even when no
// ATS-secured gp_applications row exists yet. /api/career/applications must
// surface a PROVISIONAL secured placement built from the case so the career
// page ("My Practice") shows their practice instead of the job-browse / CV-gate
// flow. GPs with no practice on their case are unaffected (still job-seeking).
//
// Reuses the in-memory PostgREST emulator pattern from gp-outstanding.test.js so
// the REAL server answers.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-placement-assoc-${RUN_ID}.json`);
let server, port, sbServer, sbPort;

// GP placed-by-association: practice on the case, no secured application.
const ASSOC = { userId: 'u-assoc-1', email: 'assoc-gp@gplink-test.local' };
// Control GP: no practice on the case → still job-seeking.
const BROWSE = { userId: 'u-browse-1', email: 'browse-gp@gplink-test.local' };
const NOW = new Date().toISOString();

const db = {
  user_profiles: [
    { user_id: ASSOC.userId, email: ASSOC.email, first_name: 'Assoc', last_name: 'Doctor', registration_country: 'uk' },
    { user_id: BROWSE.userId, email: BROWSE.email, first_name: 'Browse', last_name: 'Doctor', registration_country: 'uk' }
  ],
  registration_cases: [
    // Admin has tied this GP to a concrete practice → placed.
    { id: 'case-assoc', user_id: ASSOC.userId, status: 'active', stage: 'myintealth',
      practice_name: 'SOP Medical Centre', practice_contact: 'sop-contact@practice.test', created_at: NOW },
    // No practice on this GP's case → job-seeking.
    { id: 'case-browse', user_id: BROWSE.userId, status: 'active', stage: 'career',
      practice_name: '', practice_contact: '', created_at: NOW }
  ],
  gp_applications: [],
  user_state: [],
  runtime_kv: []
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
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, '')).includes(String(cell));
    }
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
        const saved = incoming.map((r) => { const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r }; rows.push(row); return row; });
        send(201, saved); return;
      }
      if (req.method === 'PATCH') {
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched); return;
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
function httpReq(method, p, { cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let parsed = null; try { parsed = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers }); });
    });
    r.on('error', reject); r.end();
  });
}

let realFetch;
beforeAll(async () => {
  await startSupabaseEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'placement-assoc-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
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

describe('GET /api/career/applications — placement by association', () => {
  it('surfaces a provisional secured placement for a GP tied to a practice on their case', async () => {
    const res = await httpReq('GET', '/api/career/applications', { cookie: userCookie(ASSOC.email, ASSOC.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const placed = res.body.applications.find((a) => a.placement && a.placement.provisional === true);
    expect(placed).toBeTruthy();
    // The client treats this as a secured placement (locks to the practice view).
    expect(placed.role.practiceName).toBe('SOP Medical Centre');
    expect(placed.placement.practiceName).toBe('SOP Medical Centre');
    // Status must be one the client maps to isPlacementSecured.
    expect(['secured', 'placement_secured', 'placed', 'hired']).toContain(String(placed.status));
    // The real practice name is exposed (revealed) so the view isn't masked.
    expect(placed.role.revealed).toBe(true);
  });

  it('does NOT inject a placement for a GP with no practice on their case', async () => {
    const res = await httpReq('GET', '/api/career/applications', { cookie: userCookie(BROWSE.email, BROWSE.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const anyProvisional = res.body.applications.some((a) => a.placement && a.placement.provisional === true);
    expect(anyProvisional).toBe(false);
  });

  it('never lets one account read another account\'s cached applications in the same browser', async () => {
    // This response carries per-user placement data. If it is browser-cacheable
    // (private, max-age / stale-while-revalidate) it MUST also Vary: Cookie — otherwise
    // the browser's URL-keyed HTTP cache serves account A's response to account B's
    // identical request in the SAME browser (shared/clinic computer, or two logins in
    // one browser). That was the 2026-07-09 "Smith Miller tab shows Helen's career page"
    // mix-up. Safe outcomes: cacheable + Vary:Cookie, OR not cacheable (no-store).
    const res = await httpReq('GET', '/api/career/applications', { cookie: userCookie(ASSOC.email, ASSOC.userId) });
    expect(res.status).toBe(200);
    const cacheControl = String(res.headers['cache-control'] || '').toLowerCase();
    const vary = String(res.headers['vary'] || '').toLowerCase();
    const isBrowserCacheable = /(?:^|[ ,])(?:max-age|s-maxage|stale-while-revalidate)/.test(cacheControl)
      && !/no-store/.test(cacheControl);
    if (isBrowserCacheable) {
      expect(vary).toContain('cookie');
    } else {
      expect(cacheControl).toContain('no-store');
    }
  });
});

describe('pages/career.html — provisional placement rendering hooks', () => {
  const careerHtml = fs.readFileSync(path.join(ROOT, 'pages', 'career.html'), 'utf8');

  it('renders a real-but-provisional placement honestly (no demo fallback)', () => {
    // A provisional flag on the placement payload gates the honest render path.
    expect(careerHtml).toContain('provisional');
    // The page marks the provisional state so CSS can hide demo-data sections.
    expect(careerHtml).toContain('data-career-placement-provisional');
    // An honest "details being finalised" note element exists.
    expect(careerHtml).toContain('securedProvisionalNote');
  });

  it('hides the upcoming-interview card and clears the CV-gate scroll lock on the placement view', () => {
    const render = careerHtml.slice(careerHtml.indexOf('function renderSecuredPlacement'));
    const body = render.slice(0, render.indexOf('function setView'));
    // Placed GPs never see an "upcoming interview" card.
    expect(body).toMatch(/securedInterviewCardEl\.hidden\s*=\s*true/);
    // The CV-gate scroll lock (.career-gate-open → overflow:hidden) is released so
    // the placement page always scrolls, even if the gate opened during a race.
    expect(body).toContain('closeCareerGateModal()');
    // loadSecuredInterview must NOT be invoked from the placement render anymore.
    expect(body).not.toMatch(/^\s*loadSecuredInterview\(\);/m);
  });

  it('makes the interview card [hidden] attribute actually hide it (display:flex would override it)', () => {
    // Without this rule .placement-interview-card{display:flex} beats the UA
    // [hidden]{display:none}, so hidden=true is ignored and an EMPTY card shows.
    expect(careerHtml).toMatch(/\.placement-interview-card\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });
});

describe('pages/career.html — placement scroll freeze + boot flash fixes (owner request 2026-07-08)', () => {
  const careerHtml = fs.readFileSync(path.join(ROOT, 'pages', 'career.html'), 'utf8');

  it('does NOT make the secured body its own momentum-scroll container (jams iOS iframe scroll)', () => {
    const start = careerHtml.indexOf('body.career-mode-secured {');
    const block = careerHtml.slice(start, start + 900);
    // The legacy `-webkit-overflow-scrolling: touch` declaration must be gone — it
    // is the only scrolling page-body in the app that ever had it, and on iOS in an
    // iframe it freezes touch scrolling.
    expect(block).not.toMatch(/-webkit-overflow-scrolling\s*:/);
  });

  it('does NOT trap the wheel on the tall secured page (no overscroll-contain / dead scroll container)', () => {
    // On the tall hired ("My Practice") page the real vertical overflow lives on
    // <html>, and <body> is exactly content-height. Setting overflow-x turned <body>
    // into a scroll container with NO scroll range, and overscroll-behavior-y: contain
    // then blocked the wheel from chaining up to <html> — the page moved a few px then
    // rubber-banded back to the top (owner report 2026-07-09). Neither may return.
    // Strip CSS comments first (they mention these props by name), THEN scope to just
    // this rule's body — otherwise a `}` inside a comment truncates the slice.
    const noComments = careerHtml.replace(/\/\*[\s\S]*?\*\//g, '');
    const start = noComments.indexOf('body.career-mode-secured {');
    const block = noComments.slice(start, noComments.indexOf('}', start));
    expect(block).not.toMatch(/overscroll-behavior-y\s*:\s*contain/);
    expect(block).not.toMatch(/^\s*overflow-x\s*:/m);
  });

  it('has no temporary on-screen scroll diagnostic scaffolding left in the page', () => {
    // The 2026-07-08 debugging session added an on-screen readout + auto-POST probe to
    // find the cause. Once fixed it must be fully removed so it never posts to
    // /api/errors/report or shows the box to users.
    for (const token of ['careerScrollDiag', 'reportSecuredScrollDiag', 'watchScroll', 'SCROLL-DIAG', 'SCROLL-TEST']) {
      expect(careerHtml).not.toContain(token);
    }
  });

  it('restores natural scroll instead of forcing overflow-y:auto on BOTH <html> and <body>', () => {
    const render = careerHtml.slice(careerHtml.indexOf('function renderSecuredPlacement'));
    const body = render.slice(0, render.indexOf('function setView'));
    // The prior "safeguard" set overflowY="auto" on both the root and body, nesting
    // two scroll containers and freezing iOS scroll. It must no longer do that.
    expect(body).not.toMatch(/documentElement\.style\.overflowY\s*=\s*["']auto["']/);
    expect(body).not.toMatch(/document\.body\.style\.overflowY\s*=\s*["']auto["']/);
    // It calls the self-healing helper instead.
    expect(body).toContain('ensureSecuredScrollable()');
  });

  it('defines a self-healing scroll helper (clears the gate lock, resets overflow, nudges reflow)', () => {
    const fn = careerHtml.slice(careerHtml.indexOf('function ensureSecuredScrollable'));
    const body = fn.slice(0, fn.indexOf('function renderSecuredPlacement'));
    expect(body).toContain('classList.remove("career-gate-open")');
    // resets overflowY to '' (natural scroll), never forces 'auto'
    expect(body).toMatch(/style\.overflowY\s*=\s*["']["']/);
    expect(body).toContain('offsetHeight'); // reflow nudge re-arms iOS scrolling
  });

  it('boot-gates the first paint so the wrong (browse) view never flashes', () => {
    // Head marks the page "booting" when the correct view is not yet known.
    expect(careerHtml).toContain('setAttribute("data-career-booting", "1")');
    // A neutral spinner overlay + CSS that hides the panels while booting.
    expect(careerHtml).toContain('id="careerBootOverlay"');
    expect(careerHtml).toContain('career-boot-spinner');
    expect(careerHtml).toMatch(/html\[data-career-booting\]\s+\.view-panel/);
    // init reveals the correct view exactly once, with a failsafe.
    expect(careerHtml).toContain('function clearCareerBoot');
    expect(careerHtml).toContain('removeAttribute("data-career-booting")');
    expect(careerHtml).toMatch(/clearCareerBoot\._failsafe\s*=\s*window\.setTimeout\(clearCareerBoot/);
  });

  it('re-asserts scroll on pageshow / orientationchange for the secured view', () => {
    expect(careerHtml).toMatch(/addEventListener\("pageshow"[\s\S]{0,140}ensureSecuredScrollable/);
    expect(careerHtml).toMatch(/addEventListener\("orientationchange"[\s\S]{0,140}ensureSecuredScrollable/);
  });
});

describe('GET /api/career/profile/status — placement by association', () => {
  it('does NOT require the CV gate for a GP tied to a practice on their case', async () => {
    const res = await httpReq('GET', '/api/career/profile/status', { cookie: userCookie(ASSOC.email, ASSOC.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.gateRequired).toBe(false);
    expect(res.body.placed).toBe(true);
  });

  it('still requires the CV gate for a GP with no practice and no CV', async () => {
    const res = await httpReq('GET', '/api/career/profile/status', { cookie: userCookie(BROWSE.email, BROWSE.userId) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.gateRequired).toBe(true);
    expect(res.body.placed).toBe(false);
  });
});

describe('pages/interview-prep.html — fabricated prep content removed (owner request 2026-07-08)', () => {
  const prepHtml = fs.readFileSync(path.join(ROOT, 'pages', 'interview-prep.html'), 'utf8');

  it('no longer ships the hardcoded placeholder briefing', () => {
    expect(prepHtml).not.toContain('Khaleed Ibanez');
    expect(prepHtml).not.toContain('Rachel Thompson');
    expect(prepHtml).not.toContain('How to Succeed in This Interview');
    expect(prepHtml).not.toContain('What This Practice Is Looking For');
    expect(prepHtml).not.toContain('What You Should Emphasise');
    expect(prepHtml).not.toContain('Mistakes to Avoid');
    expect(prepHtml).not.toContain('Questions to Ask');
  });

  it('keeps the genuinely-true elements (practice, Zoom link, notes)', () => {
    expect(prepHtml).toContain('id="heroPracticeName"');
    expect(prepHtml).toContain('id="joinZoomTile"');
    expect(prepHtml).toContain('id="personalNotes"');
  });
});

// Phase 6 H2 — GP source attribution ("How did you hear about us?").
//
// Proves, against the REAL server with an in-memory PostgREST emulator:
//   1. POST /api/onboarding/complete persists lead_source (+ detail) to the
//      GP's user_profiles row — whitelisted values only.
//   2. SKIPPING the question does NOT block onboarding (200, no lead_source
//      written) and the wizard's validateStep never checks it (static).
//   3. GET /api/ceo/source-attribution returns the breakdown incl. 'unknown',
//      is auth-gated, and is bounded.
//   4. The onboarding wizard changes are additive: optional select present,
//      no "RSO" wording in GP-facing onboarding copy.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as M from '../lib/ceo-metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-srcattr-${RUN_ID}.json`);
const SUPER_HOST = 'srcattr-test.local';

const NOW = Date.now();
const DAY = 86400000;
const ago = (days) => new Date(NOW - days * DAY).toISOString();

let server, port, sbServer, sbPort;

// GPs answering at onboarding (writes go through the real endpoint):
const GP_REF = { userId: 'u-src-ref', email: 'src-referral@gplink-test.local' };
const GP_SKIP = { userId: 'u-src-skip', email: 'src-skip@gplink-test.local' };
const GP_EVIL = { userId: 'u-src-evil', email: 'src-evil@gplink-test.local' };

const db = {
  user_profiles: [
    { user_id: GP_REF.userId, email: GP_REF.email, first_name: 'Ref', last_name: 'Erral' },
    { user_id: GP_SKIP.userId, email: GP_SKIP.email, first_name: 'Skip', last_name: 'Per' },
    { user_id: GP_EVIL.userId, email: GP_EVIL.email, first_name: 'Ev', last_name: 'Il' },
    // Pre-seeded answers for the breakdown endpoint:
    { user_id: 'u-g1', email: 'g1@t.local', lead_source: 'google' },
    { user_id: 'u-g2', email: 'g2@t.local', lead_source: 'google' },
    { user_id: 'u-fb', email: 'fb@t.local', lead_source: 'facebook_instagram', lead_source_detail: 'saw the reel' },
    { user_id: 'u-none', email: 'none@t.local' }, // signed up, never answered → unknown
    // Answered at onboarding but has NO registration case yet — must still count.
    { user_id: 'u-caseless', email: 'caseless@t.local', lead_source: 'medical_college_event', onboarding_completed_at: ago(2) }
  ],
  registration_cases: [
    { id: 'rc-g1', user_id: 'u-g1', created_at: ago(3) },
    { id: 'rc-g2', user_id: 'u-g2', created_at: ago(40) },
    { id: 'rc-fb', user_id: 'u-fb', created_at: ago(4) },
    { id: 'rc-none', user_id: 'u-none', created_at: ago(5) }
  ],
  user_state: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'not'];
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
      if (u.pathname.startsWith('/auth/v1/')) { send(200, {}); return; }
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
        const saved = incoming.map((r) => { const row = { id: crypto.randomUUID(), ...r }; rows.push(row); return row; });
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
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function sign(payload) { return crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex'); }
function gpCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  return 'gp_session=' + encodeURIComponent(payload + '.' + sign(payload));
}
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sign(payload));
}
function req(method, p, { host, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (host) headers.Host = host;
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
const profileOf = (userId) => db.user_profiles.find((p) => p.user_id === userId);

beforeAll(async () => {
  await startSupabaseEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'srcattr-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = '';

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('onboarding persists lead_source', () => {
  it('writes lead_source + detail to the GP profile on complete', async () => {
    const r = await req('POST', '/api/onboarding/complete', {
      cookie: gpCookie(GP_REF.email, GP_REF.userId),
      body: {
        country: 'UK', targetDate: '2027-06-01', preferredCity: 'Brisbane', whoMoving: 'just_me',
        leadSource: 'colleague_referral', leadSourceDetail: 'Dr A. Mate at the Leeds practice'
      }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const prof = profileOf(GP_REF.userId);
    expect(prof.lead_source).toBe('colleague_referral');
    expect(prof.lead_source_detail).toBe('Dr A. Mate at the Leeds practice');
  });

  it('skipping the question does not block onboarding and writes nothing', async () => {
    const r = await req('POST', '/api/onboarding/complete', {
      cookie: gpCookie(GP_SKIP.email, GP_SKIP.userId),
      body: { country: 'NZ', targetDate: '2027-06-01', preferredCity: 'Perth', whoMoving: 'me_partner' }
      // no leadSource at all — the question is OPTIONAL
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const prof = profileOf(GP_SKIP.userId);
    expect(prof.lead_source).toBeUndefined();
    expect(prof.lead_source_detail).toBeUndefined();
  });

  it('rejects non-whitelisted lead_source values (nothing persisted)', async () => {
    const r = await req('POST', '/api/onboarding/complete', {
      cookie: gpCookie(GP_EVIL.email, GP_EVIL.userId),
      body: { country: 'IE', targetDate: '2027-06-01', preferredCity: 'Sydney', whoMoving: 'just_me', leadSource: 'DROP TABLE;--', leadSourceDetail: 'x' }
    });
    expect(r.status).toBe(200); // still never blocks onboarding
    const prof = profileOf(GP_EVIL.userId);
    expect(prof.lead_source).toBeUndefined();
    expect(prof.lead_source_detail).toBeUndefined();
  });
});

describe('GET /api/ceo/source-attribution', () => {
  it('is auth-gated (no session)', async () => {
    const r = await req('GET', '/api/ceo/source-attribution', { host: SUPER_HOST });
    expect([401, 403, 302]).toContain(r.status);
  });

  it('returns the breakdown incl. unknown, with counts + %', async () => {
    const r = await req('GET', '/api/ceo/source-attribution?period=all', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const byKey = Object.fromEntries(r.body.sources.map((s) => [s.key, s]));
    // Population: 4 case-anchored GPs (u-g1,u-g2,u-fb,u-none) + 2 caseless GPs
    // who answered (u-caseless seeded + GP_REF via the onboarding test above).
    expect(r.body.total).toBe(6);
    expect(byKey.google.count).toBe(2);
    expect(byKey.google.pct).toBe(33.3);
    expect(byKey.facebook_instagram.count).toBe(1);
    expect(byKey.medical_college_event.count).toBe(1); // caseless GP still counted
    expect(byKey.colleague_referral.count).toBe(1);    // GP_REF's live answer flows through
    expect(byKey.unknown.count).toBe(1);               // u-none skipped the question
    expect(byKey.unknown.pct).toBe(16.7);
    // Free-text detail surfaces for follow-up
    expect(r.body.details.some((d) => d.detail === 'saw the reel')).toBe(true);
  });

  it('scopes to the period (7d)', async () => {
    const r = await req('GET', '/api/ceo/source-attribution?period=7d', { host: SUPER_HOST, cookie: superCookie() });
    const byKey = Object.fromEntries(r.body.sources.map((s) => [s.key, s]));
    // u-g2's case is 40d old → out; u-caseless (2d) + GP_REF (just now) → in.
    expect(r.body.total).toBe(5);
    expect(byKey.google.count).toBe(1);
    expect(byKey.unknown.count).toBe(1);
  });

  it('every Supabase fetch in the handler is bounded (carries limit=)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const start = src.indexOf("pathname === '/api/ceo/source-attribution'");
    expect(start).toBeGreaterThan(-1);
    // End of the handler = the next route check, whichever form comes first.
    const nextEq = src.indexOf('pathname ===', start + 10);
    const nextMatch = src.indexOf('pathname.match(', start + 10);
    const end = Math.min(...[nextEq, nextMatch].filter((i) => i > -1));
    const block = src.slice(start, end);
    const fetches = block.match(/supabaseDbRequest\([^)]+\)/g) || [];
    expect(fetches.length).toBeGreaterThanOrEqual(2);
    for (const f of fetches) expect(f, `unbounded fetch: ${f}`).toContain('limit=');
  });
});

describe('sanitizeLeadSource (lib)', () => {
  it('accepts exactly the wizard option keys and nothing else', () => {
    for (const s of M.LEAD_SOURCES) expect(M.sanitizeLeadSource(s.key)).toBe(s.key);
    expect(M.sanitizeLeadSource(' Google ')).toBe('google'); // trims + lowercases
    for (const bad of ['', null, undefined, 'zoho', 'DROP TABLE;--', 42, {}]) {
      expect(M.sanitizeLeadSource(bad)).toBe('');
    }
  });
});

describe('onboarding wizard changes (static)', () => {
  let pageHtml, wizardJs, dashHtml;
  beforeAll(() => {
    pageHtml = fs.readFileSync(path.join(ROOT, 'pages', 'onboarding.html'), 'utf8');
    wizardJs = fs.readFileSync(path.join(ROOT, 'js', 'onboarding.js'), 'utf8');
    dashHtml = fs.readFileSync(path.join(ROOT, 'pages', 'ceo-dashboard.html'), 'utf8');
  });

  it('the optional question exists with the whitelisted option values', () => {
    expect(pageHtml).toContain('id="leadSource"');
    expect(pageHtml).toContain('id="leadSourceDetail"');
    expect(pageHtml.toLowerCase()).toContain('how did you hear about us');
    expect(pageHtml).toContain('(optional)');
    for (const s of M.LEAD_SOURCES) {
      expect(pageHtml, `option value ${s.key}`).toContain(`value="${s.key}"`);
    }
  });

  it('validateStep never gates on the question — skipping cannot block progression', () => {
    const start = wizardJs.indexOf('function validateStep');
    expect(start).toBeGreaterThan(-1);
    const end = wizardJs.indexOf('function isSkippable', start);
    const validateBlock = wizardJs.slice(start, end);
    expect(validateBlock).not.toContain('leadSource');
  });

  it('no "RSO" wording in GP-facing onboarding copy', () => {
    expect(pageHtml).not.toMatch(/\bRSO\b/);
  });

  it('the wizard state carries leadSource + detail and the cache buster was bumped', () => {
    expect(wizardJs).toContain('leadSource: ""');
    expect(wizardJs).toContain('leadSourceDetail: ""');
    expect(wizardJs).toContain('state.leadSource = leadSourceEl.value');
    expect(pageHtml).toMatch(/onboarding\.js\?v=202607(0[7-9]|[12][0-9])[a-z]/);
  });

  it('the CEO dashboard has the "How GPs Found Us" card wired in', () => {
    expect(dashHtml).toContain('function renderSourcesSection');
    expect(dashHtml).toContain('renderSourcesSection()');
    expect(dashHtml).toContain('/api/ceo/source-attribution?period=');
    expect(dashHtml).toContain('How GPs Found Us');
  });
});

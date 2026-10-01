// Owner 2026-10-01: "i was never made aware i had to review her GMC number. I
// should always get a popup when something needs reviewing with a CTA that
// takes me to the action as well as it being visible on her profile and tab
// as an exclamation mark icon."
//
// Dr Shakeema Salmi's GMC number sat in register_status=pending_verification
// for five days (auto-check could not confirm it) because a pending register
// check was only visible as a chip INSIDE her profile.
//
//  Unit     lib/ceo-review-queue.js — eligibility (2h grace / auto-checked),
//           archived + test accounts excluded, mismatch, doc counts per case,
//           stable keys, newest-first sort, NO name-change items.
//  API      GET /api/ceo/review-queue against an in-memory PostgREST emulator
//           (CEO only), and /api/ceo/candidates rows carry the SAME flags.
//  Client   js/ceo-review-queue.js executed against DOM stubs: popup opens on
//           load, never over another modal, re-shows only for NEW items, the
//           tab "!" carries the total, "Review now" deep-links with &focus=.
//  Wiring   applyHash focus parsing, profile banner + register "!", list chip,
//           refreshDashboard defers to the queue, cache busters bumped.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const require = createRequire(import.meta.url);
const rq = require('../lib/ceo-review-queue.js');

const NOW_MS = Date.parse('2026-10-01T12:00:00.000Z');
const H = 60 * 60 * 1000;
const iso = (msAgo) => new Date(NOW_MS - msAgo).toISOString();

// ── Unit: the pure builder ───────────────────────────────────────────────────
describe('lib/ceo-review-queue buildReviewQueue', () => {
  const shakeema = {
    user_id: 'u-shakeema', email: 'shakeema@example.com', first_name: 'Shakeema', last_name: 'Salmi',
    register_body: 'gmc', register_number: '7603182', register_status: 'pending_verification',
    register_auto_checked_at: iso(5 * 24 * H), account_status: 'active', archived_at: null,
    created_at: iso(6 * 24 * H), updated_at: iso(5 * 24 * H)
  };

  it('a pending number the auto-check already tried is a "GMC number needs checking" item', () => {
    const out = rq.buildReviewQueue({ profiles: [shakeema], cases: [{ id: 'case-s', user_id: 'u-shakeema', status: 'active' }], nowMs: NOW_MS });
    expect(out.items).toHaveLength(1);
    const it = out.items[0];
    expect(it.kind).toBe('register_pending');
    expect(it.key).toBe('register:u-shakeema:pending_verification');
    expect(it.focus).toBe('register');
    expect(it.case_id).toBe('case-s');
    expect(it.user_id).toBe('u-shakeema');
    expect(it.gp_name).toBe('Dr Shakeema Salmi');
    expect(it.title).toBe('GMC number needs checking');
    expect(it.detail).toContain('GMC 7603182');
    expect(it.detail).toContain('couldn’t confirm');
    expect(out.counts).toMatchObject({ total: 1, register: 1, register_pending: 1, docs: 0 });
  });

  it('2h grace: an unchecked pending number is held back for 2h, then surfaces', () => {
    const fresh = { ...shakeema, user_id: 'u-fresh', register_auto_checked_at: null, updated_at: iso(30 * 60 * 1000) };
    const stale = { ...shakeema, user_id: 'u-stale', register_auto_checked_at: null, updated_at: iso(3 * H) };
    const out = rq.buildReviewQueue({ profiles: [fresh, stale], nowMs: NOW_MS });
    expect(out.items.map((i) => i.user_id)).toEqual(['u-stale']);
    expect(out.items[0].detail).toContain('hasn’t been able to run');
    expect(rq.registerPendingNeedsReview(fresh, NOW_MS)).toBe(false);
    expect(rq.registerPendingNeedsReview(stale, NOW_MS)).toBe(true);
    // Exactly at the boundary counts as due.
    expect(rq.registerPendingNeedsReview({ ...fresh, updated_at: iso(2 * H) }, NOW_MS)).toBe(true);
    // No register number = nothing to check.
    expect(rq.registerPendingNeedsReview({ ...stale, register_number: '' }, NOW_MS)).toBe(false);
  });

  it('archived accounts (status or archived_at) never appear', () => {
    const a1 = { ...shakeema, user_id: 'u-a1', account_status: 'archived' };
    const a2 = { ...shakeema, user_id: 'u-a2', archived_at: iso(H) };
    const out = rq.buildReviewQueue({
      profiles: [a1, a2],
      docTasks: [{ id: 't1', case_id: 'case-a1', created_at: iso(H) }],
      cases: [{ id: 'case-a1', user_id: 'u-a1', status: 'active' }],
      nowMs: NOW_MS
    });
    expect(out.items).toEqual([]);
    expect(out.counts.total).toBe(0);
  });

  it("the owner's khaleedmahmoud* test logins (and staff inboxes) never appear", () => {
    expect(rq.isTestAccountEmail('khaleedmahmoud1211@gmail.com')).toBe(true);
    expect(rq.isTestAccountEmail('KhaleedMahmoudCrypto1211@gmail.com')).toBe(true);
    expect(rq.isTestAccountEmail('khaleedmahmoudcoinspot1211@gmail.com')).toBe(true);
    expect(rq.isTestAccountEmail('hello@mygplink.com.au')).toBe(true);
    expect(rq.isTestAccountEmail('asha@example.com')).toBe(false);
    expect(rq.isTestAccountEmail('')).toBe(false);
    const khaleed = { ...shakeema, user_id: 'u-k', email: 'khaleedmahmoudcrypto1211@gmail.com', first_name: 'Khaleed', last_name: 'Crypto' };
    const asha = { ...shakeema, user_id: 'u-asha', email: 'asha@example.com', first_name: 'Asha Padmaja', last_name: 'Rajendran', register_number: '7669339' };
    const out = rq.buildReviewQueue({
      profiles: [khaleed, asha],
      docTasks: [{ id: 'tk', case_id: 'case-k', created_at: iso(H) }],
      cases: [{ id: 'case-k', user_id: 'u-k', status: 'active' }],
      nowMs: NOW_MS
    });
    expect(out.items.map((i) => i.key)).toEqual(['register:u-asha:pending_verification']);
  });

  it('mismatch is its own "follow up" item; verified / unset statuses are not items', () => {
    const mm = { ...shakeema, user_id: 'u-mm', register_status: 'mismatch', register_verified_at: iso(2 * H) };
    const ok = { ...shakeema, user_id: 'u-ok', register_status: 'verified' };
    const none = { ...shakeema, user_id: 'u-none', register_status: null };
    const out = rq.buildReviewQueue({ profiles: [mm, ok, none], nowMs: NOW_MS });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ kind: 'register_mismatch', key: 'register:u-mm:mismatch', focus: 'register', title: 'Register mismatch — follow up' });
    expect(out.counts).toMatchObject({ total: 1, register: 1, register_mismatch: 1, register_pending: 0 });
  });

  it('name changes are NOT review items (the flag is permanent and never resolves)', () => {
    const nc = { ...shakeema, user_id: 'u-nc', register_status: 'verified', name_change_detected: true, name_change_note: 'Document name: X' };
    const out = rq.buildReviewQueue({ profiles: [nc], nowMs: NOW_MS });
    expect(out.items).toEqual([]);
    expect(out.counts).not.toHaveProperty('name_change');
  });

  it('documents: one item per case with the count; withdrawn cases skipped; names resolved via the case', () => {
    const hatice = { user_id: 'u-hatice', email: 'hatice@example.com', first_name: 'Hatice', last_name: 'Akkas' };
    const out = rq.buildReviewQueue({
      profiles: [hatice],
      cases: [{ id: 'case-h', user_id: 'u-hatice', status: 'active' }, { id: 'case-w', user_id: 'u-w', status: 'withdrawn' }],
      docTasks: [
        { id: 't1', case_id: 'case-h', created_at: iso(10 * 24 * H) },
        { id: 't2', case_id: 'case-h', created_at: iso(9 * 24 * H) },
        { id: 't3', case_id: 'case-h', created_at: iso(9 * 24 * H) },
        { id: 't4', case_id: 'case-h', created_at: iso(8 * 24 * H) },
        { id: 't5', case_id: 'case-w', created_at: iso(H) },
        { id: 't6', case_id: null, created_at: iso(H) }
      ],
      nowMs: NOW_MS
    });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ kind: 'docs', key: 'docs:case-h', case_id: 'case-h', user_id: 'u-hatice', count: 4, focus: 'docs', gp_name: 'Dr Hatice Akkas', title: '4 documents to review' });
    // "since" = waiting since the OLDEST open task.
    expect(out.items[0].since).toBe(iso(10 * 24 * H));
    expect(out.counts).toMatchObject({ total: 1, docs: 1, documents: 4 });
  });

  it('keys are stable across builds; seen_token changes when a new document lands', () => {
    const input = () => ({
      profiles: [shakeema],
      docTasks: [{ id: 't1', case_id: 'case-h', created_at: iso(3 * H) }],
      cases: [{ id: 'case-h', user_id: 'u-h', status: 'active' }],
      nowMs: NOW_MS
    });
    const a = rq.buildReviewQueue(input());
    const b = rq.buildReviewQueue(input());
    expect(a.items.map((i) => i.key)).toEqual(b.items.map((i) => i.key));
    expect(a.items.map((i) => i.seen_token)).toEqual(b.items.map((i) => i.seen_token));
    const more = input();
    more.docTasks.push({ id: 't2', case_id: 'case-h', created_at: iso(H) });
    const c = rq.buildReviewQueue(more);
    const docA = a.items.find((i) => i.kind === 'docs');
    const docC = c.items.find((i) => i.kind === 'docs');
    expect(docC.key).toBe(docA.key);
    expect(docC.seen_token).not.toBe(docA.seen_token);
  });

  it('sorts newest first by since; never throws on empty input', () => {
    const older = { ...shakeema, user_id: 'u-old', register_auto_checked_at: iso(9 * 24 * H), updated_at: iso(9 * 24 * H) };
    const newer = { ...shakeema, user_id: 'u-new', register_auto_checked_at: iso(3 * H), updated_at: iso(3 * H) };
    const out = rq.buildReviewQueue({
      profiles: [older, newer],
      docTasks: [{ id: 't', case_id: 'case-d', created_at: iso(24 * H) }],
      cases: [{ id: 'case-d', user_id: 'u-d', status: 'active' }],
      nowMs: NOW_MS
    });
    expect(out.items.map((i) => i.user_id)).toEqual(['u-new', 'u-d', 'u-old']);
    expect(rq.buildReviewQueue({}).items).toEqual([]);
    expect(rq.buildReviewQueue().counts.total).toBe(0);
  });

  it('flagsByUser derives the candidate-row chips from the same items', () => {
    const mm = { ...shakeema, user_id: 'u-mm', register_status: 'mismatch' };
    const out = rq.buildReviewQueue({ profiles: [shakeema, mm], nowMs: NOW_MS });
    const flags = rq.flagsByUser(out.items);
    expect(flags['u-shakeema']).toEqual({ register: 'pending_verification', register_label: 'GMC' });
    expect(flags['u-mm']).toEqual({ register: 'mismatch', register_label: 'GMC' });
  });
});

// ── API: real server against an in-memory PostgREST emulator ────────────────
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join(os.tmpdir(), `gplink-ceo-review-queue-${RUN_ID}.json`);
const SUPER_HOST = 'ceo-reviewq.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const CONSULTANT_EMAIL = 'consultant@gplink-test.local';
let server, port, sbServer, sbPort, realFetch;
const NOW = new Date().toISOString();
const DAYS_AGO = (d) => new Date(Date.now() - d * 24 * H).toISOString();

const db = {
  user_profiles: [
    { user_id: 'u-asha', email: 'asha@gplink-test.local', first_name: 'Asha Padmaja', last_name: 'Rajendran', registration_country: 'uk', onboarding_completed_at: NOW, register_body: 'gmc', register_number: '7669339', register_status: 'pending_verification', register_auto_checked_at: DAYS_AGO(1), register_verified_at: null, account_status: 'active', archived_at: null, created_at: DAYS_AGO(3), updated_at: DAYS_AGO(1) },
    { user_id: 'u-khaleed', email: 'khaleedmahmoudcrypto1211@gmail.com', first_name: 'Khaleed', last_name: 'Crypto', registration_country: 'uk', onboarding_completed_at: NOW, register_body: 'gmc', register_number: '1234567', register_status: 'pending_verification', register_auto_checked_at: DAYS_AGO(1), account_status: 'active', archived_at: null, created_at: DAYS_AGO(3), updated_at: DAYS_AGO(1) },
    { user_id: 'u-hatice', email: 'hatice@gplink-test.local', first_name: 'Hatice', last_name: 'Akkas', registration_country: 'uk', onboarding_completed_at: NOW, register_status: 'verified', account_status: 'active', archived_at: null, created_at: DAYS_AGO(40), updated_at: DAYS_AGO(5) },
    { user_id: 'u-sana', email: 'sana@gplink-test.local', first_name: 'Sana', last_name: 'Ahsan', registration_country: 'uk', onboarding_completed_at: NOW, register_status: 'verified', name_change_detected: true, name_change_note: 'Document name: Sana A', account_status: 'active', archived_at: null, created_at: DAYS_AGO(90), updated_at: DAYS_AGO(60) },
    { user_id: 'u-arch', email: 'arch@gplink-test.local', first_name: 'Old', last_name: 'Account', registration_country: 'uk', register_body: 'gmc', register_number: '7000000', register_status: 'mismatch', account_status: 'archived', archived_at: DAYS_AGO(2), created_at: DAYS_AGO(30), updated_at: DAYS_AGO(2) }
  ],
  user_state: [],
  registration_cases: [
    { id: 'case-asha', user_id: 'u-asha', status: 'active', stage: 'myintealth', created_at: NOW, updated_at: NOW },
    { id: 'case-khaleed', user_id: 'u-khaleed', status: 'active', stage: 'myintealth', created_at: NOW, updated_at: NOW },
    { id: 'case-hatice', user_id: 'u-hatice', status: 'active', stage: 'ahpra', created_at: NOW, updated_at: NOW },
    { id: 'case-sana', user_id: 'u-sana', status: 'active', stage: 'complete', created_at: NOW, updated_at: NOW },
    { id: 'case-arch', user_id: 'u-arch', status: 'active', stage: 'myintealth', created_at: NOW, updated_at: NOW }
  ],
  registration_tasks: [
    { id: 'th1', case_id: 'case-hatice', task_type: 'doc_review', status: 'open', title: 'Review uploaded CV', created_at: DAYS_AGO(20) },
    { id: 'th2', case_id: 'case-hatice', task_type: 'doc_review', status: 'in_progress', title: 'Review uploaded CCT', created_at: DAYS_AGO(19) },
    { id: 'th3', case_id: 'case-hatice', task_type: 'doc_review', status: 'waiting', title: 'Review uploaded PMD', created_at: DAYS_AGO(19) },
    { id: 'th4', case_id: 'case-hatice', task_type: 'flagged_doc', status: 'open', title: 'Review flagged degree', created_at: DAYS_AGO(18) },
    { id: 'th5', case_id: 'case-hatice', task_type: 'doc_review', status: 'completed', title: 'done', created_at: DAYS_AGO(30) },
    { id: 'tk1', case_id: 'case-khaleed', task_type: 'doc_review', status: 'open', title: 'test', created_at: DAYS_AGO(1) }
  ],
  rso_team: [], user_roles: [], practices: [], career_roles: [], gp_applications: [], user_documents: [],
  ats_offers: [], scheduled_calls: [], ats_stage_events: [], task_timeline: [], placements: [], runtime_kv: []
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
// Columns user_profiles really has (subset relevant here) — selecting any
// other column 400s the WHOLE query in prod, so the emulator does too.
const PROFILE_COLUMNS = new Set(['user_id', 'email', 'first_name', 'last_name', 'registration_country', 'onboarding_completed_at', 'register_body', 'register_number', 'register_status', 'register_auto_checked_at', 'register_verified_at', 'name_change_detected', 'name_change_note', 'account_status', 'archived_at', 'created_at', 'updated_at']);
const profileSelects = [];
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
      const table = decodeURIComponent(m[1]);
      const rows = tableOf(table);
      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        if (table === 'user_profiles' && u.searchParams.get('select')) {
          const cols = u.searchParams.get('select').split(',');
          profileSelects.push(cols);
          const bad = cols.filter((c) => c !== '*' && !PROFILE_COLUMNS.has(c));
          if (bad.length) { send(400, { message: 'column user_profiles.' + bad[0] + ' does not exist' }); return; }
        }
        let out = rows.filter(matches).slice().reverse();
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
      if (req.method === 'PATCH') { const patch = await readBody(req); const matched = rows.filter(matches); matched.forEach((row) => Object.assign(row, patch || {})); send(200, matched); return; }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}
function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function adminCookieFor(email, adminRole) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpGet(p, cookie) {
  return new Promise((resolve, reject) => {
    const headers = { Host: SUPER_HOST };
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let body = null; try { body = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body, headers: res.headers }); });
    });
    r.on('error', reject); r.end();
  });
}

describe('GET /api/ceo/review-queue (real server, emulated PostgREST)', () => {
  beforeAll(async () => {
    await startSupabaseEmulator();
    process.env.AGENT_SKIP_DOTENV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DISABLED = 'false';
    process.env.AUTH_SECRET = 'ceo-review-queue-secret-' + RUN_ID;
    process.env.REQUIRE_SUPABASE_DB = 'false';
    process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
    process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.ENFORCE_SAME_ORIGIN = 'false';
    process.env.DB_FILE_PATH = DB_FILE;
    process.env.OPENAI_API_KEY = '';
    process.env.ANTHROPIC_API_KEY = '';
    process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
    process.env.ADMIN_ALLOWED_HOSTS = 'admin-reviewq.local';
    process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
    process.env.CONSULTANT_EMAILS = CONSULTANT_EMAIL;
    process.env.ADMIN_EMAILS = '';
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

  it('returns Asha (GMC check) + Hatice (4 documents) — not the test account, archived account or name changes', async () => {
    const r = await httpGet('/api/ceo/review-queue', adminCookieFor(SUPER_EMAIL, 'super_admin'));
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.body.ok).toBe(true);
    expect(r.body.degraded).toBe(false);
    expect(typeof r.body.generated_at).toBe('string');
    const keys = r.body.items.map((i) => i.key).sort();
    expect(keys).toEqual(['docs:case-hatice', 'register:u-asha:pending_verification']);
    const asha = r.body.items.find((i) => i.user_id === 'u-asha');
    expect(asha).toMatchObject({ kind: 'register_pending', case_id: 'case-asha', focus: 'register', gp_name: 'Dr Asha Padmaja Rajendran', title: 'GMC number needs checking' });
    expect(asha.detail).toContain('GMC 7669339');
    const hatice = r.body.items.find((i) => i.kind === 'docs');
    expect(hatice).toMatchObject({ case_id: 'case-hatice', user_id: 'u-hatice', count: 4, gp_name: 'Dr Hatice Akkas', focus: 'docs' });
    expect(r.body.counts).toMatchObject({ total: 2, register: 1, docs: 1, documents: 4 });
    // Asha was checked 1 day ago, Hatice has waited 20 days → Asha first.
    expect(r.body.items[0].user_id).toBe('u-asha');
    // Only real columns were ever selected from user_profiles.
    profileSelects.forEach((cols) => cols.forEach((c) => expect(PROFILE_COLUMNS.has(c) || c === '*').toBe(true)));
  });

  it('is CEO-only: consultants and anonymous callers are refused', async () => {
    const c = await httpGet('/api/ceo/review-queue', adminCookieFor(CONSULTANT_EMAIL, 'consultant'));
    expect(c.status).toBeGreaterThanOrEqual(401);
    expect(c.body && c.body.items).toBeUndefined();
    const a = await httpGet('/api/ceo/review-queue');
    expect(a.status).toBeGreaterThanOrEqual(401);
  });

  it('/api/ceo/candidates rows carry the SAME register flag the popup uses', async () => {
    const r = await httpGet('/api/ceo/candidates', adminCookieFor(SUPER_EMAIL, 'super_admin'));
    expect(r.status).toBe(200);
    const byUser = {};
    (r.body.candidates || []).forEach((c) => { byUser[c.user_id] = c; });
    expect(byUser['u-asha'].review_register).toBe('pending_verification');
    expect(byUser['u-asha'].review_register_label).toBe('GMC');
    expect(byUser['u-hatice'].review_register).toBe('');
    expect(byUser['u-hatice'].doc_reviews_pending).toBe(4);
    expect(byUser['u-sana'].review_register).toBe('');
    expect(byUser['u-sana']).not.toHaveProperty('review_name_change');
  });
});

// ── Client: js/ceo-review-queue.js against DOM stubs ────────────────────────
function makeEl(id) {
  const attrs = {};
  const classes = new Set();
  const el = {
    id, children: [], textContent: '', title: '', _html: '', _buttons: { later: null, now: [] },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    removeAttribute: (k) => { delete attrs[k]; },
    hasAttribute: (k) => k in attrs,
    querySelector(sel) {
      if (sel === '[data-review-queue-modal]') return this._html.indexOf('data-review-queue-modal') !== -1 ? {} : null;
      if (sel === '.rq-later') return this._buttons.later;
      return null;
    },
    querySelectorAll(sel) { return sel === '.rq-review-now' ? this._buttons.now : []; }
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) {
      el._html = String(v);
      const mkBtn = (attrsInit) => {
        const handlers = [];
        const b = { attrs: attrsInit, addEventListener: (t, fn) => handlers.push(fn), getAttribute: (k) => attrsInit[k] };
        b.click = () => handlers.forEach((fn) => fn({ currentTarget: b }));
        return b;
      };
      el._buttons.later = el._html.indexOf('rq-later') !== -1 ? mkBtn({}) : null;
      el._buttons.now = [];
      const re = /data-rq-index="(\d+)"/g; let m;
      while ((m = re.exec(el._html))) el._buttons.now.push(mkBtn({ 'data-rq-index': m[1] }));
    }
  });
  return el;
}
function loadClient({ role = 'super_admin', payloads = [] } = {}) {
  const els = {
    modalOverlay: makeEl('modalOverlay'),
    modalBox: makeEl('modalBox'),
    masterDocReviewAlert: makeEl('masterDocReviewAlert'),
    atsOverlayRoot: makeEl('atsOverlayRoot')
  };
  const store = {};
  let fetchCount = 0;
  const events = [];
  const win = {
    __gpAdminRole: role,
    location: { hash: '' },
    sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    openModal(html) { els.modalBox.innerHTML = html; els.modalOverlay.classList.add('open'); },
    closeModal() { els.modalOverlay.classList.remove('open'); els.modalBox.innerHTML = ''; },
    dispatchEvent: (ev) => events.push(ev),
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    fetch: (url) => {
      fetchCount++;
      const p = payloads.length > 1 ? payloads.shift() : payloads[0];
      return Promise.resolve({ json: () => Promise.resolve(p) });
    }
  };
  const sandbox = {
    window: win, document: { getElementById: (id) => els[id] || null },
    location: win.location, sessionStorage: win.sessionStorage, fetch: win.fetch,
    CustomEvent: win.CustomEvent, setTimeout: () => 0, setInterval: () => 0, clearInterval: () => {},
    Date, JSON, Math, Number, String, Array, Object, Promise, isFinite, encodeURIComponent, console
  };
  win.window = win;
  vm.createContext(sandbox);
  vm.runInContext(read('js/ceo-review-queue.js'), sandbox, { filename: 'ceo-review-queue.js' });
  return { win, els, store, events, fetches: () => fetchCount };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const ITEM_A = { key: 'register:u-a:pending_verification', kind: 'register_pending', user_id: 'u-a', case_id: 'case-a', gp_name: 'Dr A', title: 'GMC number needs checking', detail: 'Dr A · GMC 7603182', since: new Date(Date.now() - 5 * 24 * H).toISOString(), focus: 'register', register_label: 'GMC', seen_token: 'register:u-a:pending_verification@x' };
const ITEM_D = { key: 'docs:case-d', kind: 'docs', user_id: 'u-d', case_id: 'case-d', gp_name: 'Dr D', title: '2 documents to review', detail: 'Dr D', since: new Date(Date.now() - H).toISOString(), focus: 'docs', count: 2, seen_token: 'docs:case-d@2' };
const payload = (items) => ({ ok: true, items, counts: { total: items.length }, generated_at: new Date().toISOString() });

describe('js/ceo-review-queue.js (popup + tab "!")', () => {
  it('boots for the CEO: tab "!" carries the total + summary, popup opens with a Review now per item', async () => {
    const c = loadClient({ payloads: [payload([ITEM_A, ITEM_D])] });
    await flush(); await flush();
    expect(c.fetches()).toBe(1);
    expect(c.els.masterDocReviewAlert.getAttribute('data-count')).toBe('2');
    expect(c.els.masterDocReviewAlert.textContent).toBe('!');
    expect(c.els.masterDocReviewAlert.title).toBe('2 need your review: 1 GMC check, 2 document reviews');
    expect(c.els.modalOverlay.classList.contains('open')).toBe(true);
    expect(c.els.modalBox.innerHTML).toContain('Needs your review (2)');
    expect(c.els.modalBox.innerHTML).toContain('Remind me later');
    expect(c.els.modalBox._buttons.now).toHaveLength(2);
    expect(c.win.CeoReviewQueue.ownsTabDot()).toBe(true);
    expect(c.events.some((e) => e.type === 'gp:review-queue')).toBe(true);
    expect(c.win.CeoReviewQueue.itemsFor('u-a', '')).toHaveLength(1);
    expect(c.win.CeoReviewQueue.itemsFor('', 'case-d')).toHaveLength(1);
  });

  it('"Review now" closes the popup and deep-links to #candidate=<case>&focus=<section>', async () => {
    const c = loadClient({ payloads: [payload([ITEM_A, ITEM_D])] });
    await flush(); await flush();
    c.els.modalBox._buttons.now[0].click();
    expect(c.els.modalOverlay.classList.contains('open')).toBe(false);
    expect(c.win.location.hash).toBe('candidate=case-a&focus=register');
  });

  it('after "Remind me later" it stays closed for the same items, and re-opens for a NEW one', async () => {
    // fetch #1 (boot) and #2 return A; fetch #3 adds D.
    const c = loadClient({ payloads: [payload([ITEM_A]), payload([ITEM_A]), payload([ITEM_D, ITEM_A])] });
    await flush(); await flush();
    expect(c.els.modalOverlay.classList.contains('open')).toBe(true);
    c.els.modalBox._buttons.later.click();
    expect(c.els.modalOverlay.classList.contains('open')).toBe(false);
    await c.win.CeoReviewQueue.refresh();
    expect(c.fetches()).toBe(2);
    expect(c.els.modalOverlay.classList.contains('open')).toBe(false);
    await c.win.CeoReviewQueue.refresh();
    expect(c.fetches()).toBe(3);
    expect(c.els.modalOverlay.classList.contains('open')).toBe(true);
    expect(c.els.modalBox.innerHTML).toContain('Needs your review (2)');
    // seen tokens persisted in sessionStorage
    expect(JSON.parse(c.store.gp_ceo_review_seen_v1)).toEqual(expect.arrayContaining([ITEM_A.seen_token, ITEM_D.seen_token]));
  });

  it('never opens over another open modal (deferred), and does nothing for consultants', async () => {
    const c = loadClient({ payloads: [payload([ITEM_A])] });
    // Another dashboard modal is already open before the queue lands.
    c.els.modalOverlay.classList.add('open');
    c.els.modalBox.innerHTML = '<div class="modal-title">Respond to Escalation</div>';
    await flush(); await flush();
    expect(c.els.modalBox.innerHTML).toContain('Respond to Escalation');
    expect(c.els.modalBox.innerHTML).not.toContain('Needs your review');
    // ...but the tab "!" still updates.
    expect(c.els.masterDocReviewAlert.getAttribute('data-count')).toBe('1');

    const k = loadClient({ role: 'consultant', payloads: [payload([ITEM_A])] });
    await flush(); await flush();
    expect(k.fetches()).toBe(0);
    expect(k.els.masterDocReviewAlert.getAttribute('data-count')).toBe(null);
    expect(k.els.modalOverlay.classList.contains('open')).toBe(false);
  });

  it('an empty queue clears the tab "!" and opens nothing', async () => {
    const c = loadClient({ payloads: [payload([])] });
    await flush(); await flush();
    expect(c.els.masterDocReviewAlert.getAttribute('data-count')).toBe(null);
    expect(c.els.modalOverlay.classList.contains('open')).toBe(false);
  });
});

// ── Wiring (static) ──────────────────────────────────────────────────────────
describe('review queue wiring', () => {
  const dash = read('pages/ceo-dashboard.html');
  const shared = read('js/ceo-ats-shared.js');
  const cands = read('js/ceo-ats-candidates.js');
  const server = read('server.js');

  it('the dashboard loads the queue script (cache-busted) and bumps every changed file', () => {
    expect(dash).toContain('<script src="/js/ceo-review-queue.js?v=20261001a"></script>');
    expect(dash).toContain('/js/ceo-ats-shared.js?v=20261001a');
    expect(dash).toContain('/js/ceo-ats-candidates.js?v=20261001a');
    expect(dash).toContain('/css/ceo-ats.css?v=20261001a');
    expect(dash).not.toContain('/js/ceo-ats-shared.js?v=20260816b');
    expect(dash).not.toContain('/js/ceo-ats-candidates.js?v=20260914c');
    expect(dash).not.toContain('/css/ceo-ats.css?v=20260914c');
  });

  it('refreshDashboard refreshes the queue and no longer overwrites its tab "!" with the doc-only count', () => {
    const fn = dash.slice(dash.indexOf('function refreshDashboard()'), dash.indexOf('function refreshTrends()'));
    expect(fn).toContain('window.CeoReviewQueue.refresh()');
    expect(fn).toContain('ownsTabDot');
    expect(fn).toMatch(/if \(drDot && !drQueueOwns\)/);
  });

  it('the queue is fetched fresh (never via SWR) from the CEO-only endpoint', () => {
    const js = read('js/ceo-review-queue.js');
    expect(js).toContain("fetch('/api/ceo/review-queue'");
    expect(js).toContain("cache: 'no-store'");
    expect(js).not.toMatch(/swr\(/i);
    const route = server.slice(server.indexOf("pathname === '/api/ceo/review-queue'"));
    expect(route.slice(0, 300)).toContain('requireCeoSession(req, res)');
  });

  it('applyHash parses #candidate=<id>&focus=<x> and passes {focus} to atsOpenCandidate', () => {
    const sandbox = { window: {}, document: { readyState: 'loading', addEventListener: () => {} }, location: { hash: '' }, console };
    sandbox.window.ATS = undefined;
    vm.createContext(sandbox);
    vm.runInContext(shared, sandbox, { filename: 'ceo-ats-shared.js' });
    const parse = sandbox.window.ATS.parseCandidateHash;
    expect(parse('candidate=case-1&focus=register')).toEqual({ id: 'case-1', focus: 'register' });
    expect(parse('candidate=case-1')).toEqual({ id: 'case-1', focus: '' });
    expect(parse('candidate=case-1&focus=<script>')).toEqual({ id: 'case-1', focus: '' });
    expect(typeof sandbox.window.ATS.applyHash).toBe('function');
    expect(shared).toContain("drill('candidates', 'atsOpenCandidate', ch.id, ch.focus ? { focus: ch.focus } : null)");
  });

  it('the profile shows a "Needs your review" banner, a red "!" on a pending/mismatched register row, and focuses the section', () => {
    expect(cands).toContain('window.atsOpenCandidate = function (caseId, opts)');
    expect(cands).toContain('id="ats-review-banner-slot"');
    expect(cands).toContain('Needs your review');
    expect(cands).toContain("REVIEW_FOCUS_TARGETS = { register: '#ats-register-row', docs: '#ats-cand-doc-reviews' }");
    expect(cands).toContain("el.classList.add('ats-focus-pulse')");
    expect(cands).toContain("window.addEventListener('gp:review-queue'");
    expect(cands).toMatch(/needsReview = status === 'pending_verification' \|\| status === 'mismatch'/);
    expect(cands).toContain('ats-alert-dot ats-register-alert');
    // register actions + doc review completion refresh the queue
    expect(cands).toContain('if (res && res.ok) refreshReviewQueue();');
    // a document decision calls refreshDashboard(), which refreshes the queue
    const submit = dash.slice(dash.indexOf('function submitCeoReviewDoc('));
    expect(submit.slice(0, 6000)).toContain('refreshDashboard();');
    expect(read('css/ceo-ats.css')).toContain('.ats-focus-pulse');
  });

  it('the candidate row renders "! GMC check" / "! Register mismatch" chips from review_register', () => {
    const start = cands.indexOf('function reviewRowChip(c)');
    const body = cands.slice(start, cands.indexOf('\n  }\n', start) + 4);
    const reviewRowChip = new Function('ATS', body + '\nreturn reviewRowChip;')({ esc: (s) => String(s) });
    expect(reviewRowChip({ review_register: 'pending_verification', review_register_label: 'GMC' })).toContain('! GMC check');
    expect(reviewRowChip({ review_register: 'mismatch' })).toContain('! Register mismatch');
    expect(reviewRowChip({ review_register: '' })).toBe('');
    expect(cands).toContain('reviewRowChip(c) +');
  });
});

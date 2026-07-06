// Phase 6 G4 — unified GP task inbox ("Your outstanding actions").
//
// GET /api/gp/outstanding aggregates everything genuinely waiting on THIS GP:
//   1. AHPRA more-info / s80 items owned by the GP  -> /pages/ahpra.html?task=<id>
//   2. rejected documents needing re-upload         -> /pages/my-documents.html?reupload=<key>
//   3. other registration_tasks waiting on the GP   -> stage page
//   4. actionable (stage-linked) nudges             -> stage page
//
// Reuses the in-memory PostgREST emulator harness from
// tests/gp-flow-server-gaps.test.js so the REAL server answers. Two GPs are
// seeded to prove there is no cross-user leak. Also pins the index.html panel
// markers (hidden-by-default section + loader script).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-outstanding-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const GP = { userId: 'u-out-1', email: 'out-gp@gplink-test.local' };
const OTHER = { userId: 'u-out-2', email: 'other-gp@gplink-test.local' };
const NOW = new Date().toISOString();

const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Olive', last_name: 'Doctor', registration_country: 'uk' },
    { user_id: OTHER.userId, email: OTHER.email, first_name: 'Other', last_name: 'Doctor', registration_country: 'ie' }
  ],
  registration_cases: [
    { id: 'case-out-1', user_id: GP.userId, status: 'active' },
    { id: 'case-out-2', user_id: OTHER.userId, status: 'active' }
  ],
  registration_tasks: [
    // 1. Live s80 GP upload item — must surface with the ?task= deep link.
    {
      id: 't-ahpra-1', case_id: 'case-out-1', task_type: 'ahpra_action_item', status: 'waiting_on_gp',
      title: 'Upload your English language test results', priority: 'high', created_at: NOW,
      metadata: { s80: true, owner: 'gp', review_status: 'active', mode: 'upload' }
    },
    // Approved upload — nothing left for the GP, must NOT surface.
    {
      id: 't-ahpra-approved', case_id: 'case-out-1', task_type: 'ahpra_action_item', status: 'waiting_on_gp',
      title: 'Certificate of good standing', priority: 'high', created_at: NOW,
      metadata: { s80: true, owner: 'gp', review_status: 'active', mode: 'upload', upload: { status: 'approved' } }
    },
    // The OTHER GP's s80 item — must never leak into GP 1's inbox.
    {
      id: 't-ahpra-other', case_id: 'case-out-2', task_type: 'ahpra_action_item', status: 'waiting_on_gp',
      title: 'Upload your identity document', priority: 'high', created_at: NOW,
      metadata: { s80: true, owner: 'gp', review_status: 'active', mode: 'upload' }
    },
    // A non-AHPRA task explicitly waiting on the GP — stage deep link.
    {
      id: 't-wait-visa', case_id: 'case-out-1', task_type: 'stage_task', status: 'waiting_on_gp',
      title: 'Confirm your visa appointment', priority: 'normal', related_stage: 'visa', created_at: NOW, metadata: {}
    },
    // Open admin-side task (not waiting on the GP) — must NOT surface.
    {
      id: 't-admin-open', case_id: 'case-out-1', task_type: 'flagged_doc', status: 'open',
      title: 'Review flagged qualification', priority: 'high', created_at: NOW, metadata: {}
    }
  ],
  user_documents: [
    { user_id: GP.userId, document_key: 'mrcgp_certified', status: 'rejected', rejection_reason: 'The scan is blurry', file_name: 'mrcgp.pdf', updated_at: NOW },
    { user_id: GP.userId, document_key: 'cv_signed_dated', status: 'approved', file_name: 'cv.pdf', updated_at: NOW },
    { user_id: OTHER.userId, document_key: 'micgp_certified', status: 'rejected', rejection_reason: 'Wrong document', file_name: 'micgp.pdf', updated_at: NOW }
  ],
  user_nudges: [
    { id: 'n-out-1', user_id: GP.userId, stage: 'amc', title: 'Please finish your AMC portfolio', message: 'Your AMC portfolio is nearly there — two fields left.', status: 'active', created_at: NOW },
    { id: 'n-out-dismissed', user_id: GP.userId, stage: 'ahpra', title: 'Old nudge', message: 'Done already', status: 'dismissed', created_at: NOW },
    { id: 'n-out-info', user_id: GP.userId, stage: '', title: 'Welcome!', message: 'Pure info, no stage — not an action.', status: 'active', created_at: NOW }
  ],
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
    if (op === 'ilike') {
      const pat = val.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/%/g, '.*');
      return new RegExp('^' + pat + '$', 'i').test(String(cell));
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
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const table = decodeURIComponent(m[1]);
      const rows = tableOf(table);
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
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
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
  process.env.AUTH_SECRET = 'outstanding-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
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

describe('GET /api/gp/outstanding', () => {
  it('is auth-gated', async () => {
    const r = await httpReq('GET', '/api/gp/outstanding');
    expect([401, 403]).toContain(r.status);
  });

  it('aggregates the AHPRA s80 item, the rejected document, the waiting task and the actionable nudge — with deep links', async () => {
    const r = await httpReq('GET', '/api/gp/outstanding', { cookie: userCookie(GP.email, GP.userId) });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const items = r.body.items;
    expect(Array.isArray(items)).toBe(true);

    const ahpra = items.find((i) => i.id === 'ahpra-t-ahpra-1');
    expect(ahpra).toBeTruthy();
    expect(ahpra.kind).toBe('ahpra_more_info');
    expect(ahpra.stage).toBe('ahpra');
    expect(ahpra.deepLink).toBe('/pages/ahpra.html?task=t-ahpra-1');
    expect(ahpra.priority).toBe('high');
    expect(ahpra.title).toContain('English language test');

    const doc = items.find((i) => i.id === 'doc-mrcgp_certified');
    expect(doc).toBeTruthy();
    expect(doc.kind).toBe('document_reupload');
    expect(doc.deepLink).toBe('/pages/my-documents.html?reupload=mrcgp_certified');
    expect(doc.title).toContain('MRCGP certificate');
    expect(doc.description).toContain('blurry');
    expect(doc.priority).toBe('high');

    const waiting = items.find((i) => i.id === 'task-t-wait-visa');
    expect(waiting).toBeTruthy();
    expect(waiting.kind).toBe('registration_task');
    expect(waiting.deepLink).toBe('/pages/visa.html');
    expect(waiting.title).toContain('visa appointment');

    const nudge = items.find((i) => i.id === 'nudge-n-out-1');
    expect(nudge).toBeTruthy();
    expect(nudge.kind).toBe('nudge');
    expect(nudge.deepLink).toBe('/pages/amc.html');
    expect(nudge.description).toContain('AMC portfolio');

    // High-priority items sort first.
    expect(items[0].priority).toBe('high');
  });

  it('excludes resolved/non-actionable rows: approved s80 upload, approved doc, admin-owned open task, dismissed + stage-less nudges', async () => {
    const r = await httpReq('GET', '/api/gp/outstanding', { cookie: userCookie(GP.email, GP.userId) });
    const ids = r.body.items.map((i) => i.id);
    expect(ids).not.toContain('ahpra-t-ahpra-approved');
    expect(ids).not.toContain('doc-cv_signed_dated');
    expect(ids).not.toContain('task-t-admin-open');
    expect(ids).not.toContain('nudge-n-out-dismissed');
    expect(ids).not.toContain('nudge-n-out-info');
  });

  it('never leaks another GP\'s items (both directions)', async () => {
    const r1 = await httpReq('GET', '/api/gp/outstanding', { cookie: userCookie(GP.email, GP.userId) });
    const ids1 = r1.body.items.map((i) => i.id);
    expect(ids1).not.toContain('ahpra-t-ahpra-other');
    expect(ids1).not.toContain('doc-micgp_certified');

    const r2 = await httpReq('GET', '/api/gp/outstanding', { cookie: userCookie(OTHER.email, OTHER.userId) });
    expect(r2.status).toBe(200);
    const ids2 = r2.body.items.map((i) => i.id);
    expect(ids2).toContain('ahpra-t-ahpra-other');
    expect(ids2).toContain('doc-micgp_certified');
    expect(ids2).not.toContain('ahpra-t-ahpra-1');
    expect(ids2).not.toContain('doc-mrcgp_certified');
    expect(ids2).not.toContain('task-t-wait-visa');
    expect(ids2).not.toContain('nudge-n-out-1');
  });
});

describe('index.html outstanding-actions panel markers', () => {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'pages', 'index.html'), 'utf8');

  it('carries the panel, hidden by default, above the journey', () => {
    expect(indexHtml).toContain('Your outstanding actions');
    expect(indexHtml).toMatch(/id="outstandingActions"[^>]*hidden|hidden[^>]*id="outstandingActions"|id="outstandingActions" hidden/);
    expect(indexHtml).toContain('id="outstandingList"');
    // Panel section appears BEFORE "The Journey" section head.
    expect(indexHtml.indexOf('id="outstandingActions"')).toBeLessThan(indexHtml.indexOf('>The Journey<'));
    expect(indexHtml).toContain('/api/gp/outstanding');
  });

  it('never says bare "RSO"', () => {
    expect(/\bRSO\b/.test(indexHtml)).toBe(false);
  });
});

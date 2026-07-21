// Phase 6 F3, document expiry tracking + renewal nudges (G5).
//
// Proves, against the REAL server with an in-memory PostgREST emulator:
//   1. POST /api/prepared-documents/expiry is auth-gated, validates the date,
//      only touches the CALLER's own document row, and resets the nudge window.
//   2. The weekly-sweep cron nudges a doc expiring within the 30-day window
//      exactly ONCE (expiry_nudged_at dedup) and leaves out-of-window /
//      already-nudged docs alone. The nudge lands as a user_nudges row (the
//      outstanding-actions panel) AND a gp_link_updates bell alert with a
//      re-upload deep link.
//   3. PUT /api/prepared-documents persists an explicit expiresAt and the GET
//      response carries expires_at back to the card.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-doc-expiry-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const GP = { userId: 'u-exp-1', email: 'expiry-gp@gplink-test.local' };
const OTHER = { userId: 'u-exp-2', email: 'expiry-other@gplink-test.local' };
const NOW = Date.now();
const iso = (offsetDays) => new Date(NOW + offsetDays * 86400000).toISOString();

const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Ex', last_name: 'Piry', registration_country: 'uk' },
    { user_id: OTHER.userId, email: OTHER.email, first_name: 'Ot', last_name: 'Her', registration_country: 'uk' }
  ],
  user_documents: [
    // Expires in 10 days, never nudged -> the sweep must nudge exactly this one.
    { id: 'd-exp-soon', user_id: GP.userId, document_key: 'criminal_history', country_code: 'uk', status: 'approved', file_name: 'ichc.pdf', file_url: 'users/u-exp-1/x', expires_at: iso(10), expiry_nudged_at: null, updated_at: iso(-1) },
    // Expires in 90 days -> outside the 30-day window, must NOT be nudged.
    { id: 'd-exp-far', user_id: GP.userId, document_key: 'certificate_good_standing', country_code: 'uk', status: 'approved', file_name: 'cogs.pdf', file_url: 'users/u-exp-1/y', expires_at: iso(90), expiry_nudged_at: null, updated_at: iso(-1) },
    // In-window but ALREADY nudged -> dedup must skip it.
    { id: 'd-exp-nudged', user_id: OTHER.userId, document_key: 'criminal_history_check', country_code: 'uk', status: 'approved', file_name: 'pc.pdf', file_url: 'users/u-exp-2/z', expires_at: iso(5), expiry_nudged_at: iso(-2), updated_at: iso(-1) }
  ],
  registration_cases: [],
  registration_tasks: [],
  user_nudges: [],
  user_state: [],
  user_roles: [],
  user_doc_scan_failures: [],
  runtime_kv: []
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
    const val = raw.slice(dot + 1);
    filters.push({ col: key, op, val });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
    if (op === 'neq') return String(cell) !== val;
    if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    if (op === 'not') return val === 'is.null' ? !(cell === null || cell === undefined) : true;
    if (op === 'gt') return cell != null && String(cell) > val;
    if (op === 'gte') return cell != null && String(cell) >= val;
    if (op === 'lt') return cell != null && String(cell) < val;
    if (op === 'lte') return cell != null && String(cell) <= val;
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
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      // Storage: accept any object upload/download so document saves succeed.
      if (u.pathname.startsWith('/storage/v1/')) { send(200, { Key: 'ok' }); return; }
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
        const conflict = (u.searchParams.get('on_conflict') || '').split(',').map((s) => s.trim()).filter(Boolean);
        const saved = incoming.map((r) => {
          if (conflict.length) {
            const existing = rows.find((row) => conflict.every((c) => String(row[c]) === String(r[c])));
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
      if (req.method === 'DELETE') {
        const keep = rows.filter((r) => !matches(r));
        db[table] = keep;
        send(200, []);
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

function httpReq(method, p, { cookie, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...(headers || {}) };
    if (cookie) h.Cookie = cookie;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'doc-expiry-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.CRON_SECRET = 'test-cron-secret-' + RUN_ID;

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

describe('POST /api/prepared-documents/expiry', () => {
  it('is auth-gated', async () => {
    const r = await httpReq('POST', '/api/prepared-documents/expiry', { body: { country: 'uk', key: 'criminal_history', expiresAt: '2027-01-01' } });
    expect([401, 403]).toContain(r.status);
  });

  it('rejects an invalid date', async () => {
    const r = await httpReq('POST', '/api/prepared-documents/expiry', {
      cookie: userCookie(GP.email, GP.userId),
      body: { country: 'uk', key: 'criminal_history', expiresAt: 'not-a-date' }
    });
    expect(r.status).toBe(400);
  });

  it('404s when the GP has no such document (ownership scoping)', async () => {
    // OTHER owns d-exp-nudged (criminal_history_check); GP does not have that key.
    const r = await httpReq('POST', '/api/prepared-documents/expiry', {
      cookie: userCookie(GP.email, GP.userId),
      body: { country: 'uk', key: 'criminal_history_check', expiresAt: '2027-01-01' }
    });
    expect(r.status).toBe(404);
    // OTHER's row untouched.
    const otherRow = db.user_documents.find((d) => d.id === 'd-exp-nudged');
    expect(otherRow.expires_at).toBe(iso(5));
  });

  it('sets expires_at on the GP\'s own doc and resets the nudge window', async () => {
    const r = await httpReq('POST', '/api/prepared-documents/expiry', {
      cookie: userCookie(GP.email, GP.userId),
      body: { country: 'uk', key: 'certificate_good_standing', expiresAt: '2027-03-15' }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.expiresAt).toContain('2027-03-15');
    const row = db.user_documents.find((d) => d.id === 'd-exp-far');
    expect(String(row.expires_at)).toContain('2027-03-15');
    expect(row.expiry_nudged_at).toBe(null);
  });
});

describe('weekly-sweep expiry renewal nudges', () => {
  it('rejects a bad cron secret', async () => {
    const r = await httpReq('GET', '/api/cron/weekly-sweep', { headers: { Authorization: 'Bearer wrong' } });
    expect(r.status).toBe(401);
  });

  it('nudges only the doc expiring within 30 days that has not been nudged', async () => {
    const r = await httpReq('GET', '/api/cron/weekly-sweep', { headers: { Authorization: 'Bearer ' + process.env.CRON_SECRET } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // d-exp-soon only: d-exp-far is now 2027 (out of window), d-exp-nudged already flagged.
    expect(r.body.expiryNudged).toBe(1);

    // Dedup flag written.
    const soon = db.user_documents.find((d) => d.id === 'd-exp-soon');
    expect(soon.expiry_nudged_at).toBeTruthy();

    // Outstanding-actions nudge row (stage documents).
    const nudge = db.user_nudges.find((n) => n.user_id === GP.userId && n.stage === 'documents');
    expect(nudge).toBeTruthy();
    expect(nudge.title.toLowerCase()).toContain('expires soon');
    expect(nudge.message.toLowerCase()).toContain('criminal history');

    // Bell alert with a re-upload deep link.
    const st = db.user_state.find((s) => s.user_id === GP.userId);
    expect(st).toBeTruthy();
    const alert = (st.state.gp_link_updates || [])[0];
    expect(alert).toBeTruthy();
    expect(alert.type).toBe('action');
    expect(alert.target).toBe('/pages/my-documents.html?reupload=criminal_history');

    // Untouched: already-nudged and out-of-window rows.
    expect(db.user_nudges.filter((n) => n.user_id === OTHER.userId).length).toBe(0);
  });

  it('does not nudge the same doc twice (once per window)', async () => {
    const before = db.user_nudges.length;
    const r = await httpReq('GET', '/api/cron/weekly-sweep', { headers: { Authorization: 'Bearer ' + process.env.CRON_SECRET } });
    expect(r.status).toBe(200);
    expect(r.body.expiryNudged).toBe(0);
    expect(db.user_nudges.length).toBe(before);
  });
});

describe('expiry capture on upload + read-back', () => {
  const PDF_DATA_URL = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n').toString('base64');

  it('PUT /api/prepared-documents persists an explicit expiresAt and GET returns it (with scanFailures map present)', async () => {
    const put = await httpReq('PUT', '/api/prepared-documents', {
      cookie: userCookie(GP.email, GP.userId),
      body: {
        country: 'uk', key: 'mrcgp_certified',
        fileName: 'mrcgp.pdf', mimeType: 'application/pdf', fileSize: 64,
        fileDataUrl: PDF_DATA_URL,
        expiresAt: '2027-06-30'
      }
    });
    expect(put.status).toBe(200);
    expect(put.body.ok).toBe(true);

    const row = db.user_documents.find((d) => d.user_id === GP.userId && d.document_key === 'mrcgp_certified');
    expect(row).toBeTruthy();
    expect(String(row.expires_at)).toContain('2027-06-30');
    expect(row.expiry_nudged_at).toBe(null);

    const get = await httpReq('GET', '/api/prepared-documents?country=uk', { cookie: userCookie(GP.email, GP.userId) });
    expect(get.status).toBe(200);
    expect(get.body.docs.mrcgp_certified).toBeTruthy();
    expect(String(get.body.docs.mrcgp_certified.expires_at)).toContain('2027-06-30');
    // F3 scan-failure map rides along (empty here).
    expect(get.body.scanFailures).toBeTypeOf('object');
  });
});

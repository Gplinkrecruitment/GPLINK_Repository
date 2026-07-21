// Admin offer/contract DIRECT-to-Storage upload (owner report 2026-07-09:
// "Upload failed" on the Prepared-by-GP-Link Offer/contract card for a large
// scanned PDF, and the GP's "Download Your Contract" never worked).
//
// Boots the real server against an in-memory emulator that handles BOTH
// PostgREST (/rest/v1/<table>) AND Supabase Storage (/storage/v1/...), so the
// two new endpoints are exercised for real:
//   POST /api/admin/offer-contract/sign-upload  → signed upload URL
//   (browser PUTs the raw file to Storage, no base64, no 4.5MB body limit)
//   POST /api/admin/offer-contract/finalize     → user_documents offer_contract
//     row with a storage reference (so the GP download resolves), the admin
//     practice_doc_ops card marked completed, and the GP's cached placement
//     payload invalidated so the download button appears immediately.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-offer-contract-${RUN_ID}.json`);
let server, port, sbServer, sbPort;

const SUPER_HOST = 'ceo-oc.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const GP = { userId: 'u-gp-oc-1', email: 'gp-oc@gplink-test.local' };
const CASE_ID = 'case-oc-1';
const ZOHO_APP_ID = '11734000009999001';
const NOW = new Date().toISOString();

const db = {
  user_profiles: [{ user_id: GP.userId, email: GP.email, first_name: 'Sana', last_name: 'Test', registration_country: 'uk' }],
  user_state: [{ user_id: GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }],
  registration_cases: [{ id: CASE_ID, user_id: GP.userId, status: 'active', google_drive_folder_id: null }],
  gp_applications: [{ id: 'app-oc-1', user_id: GP.userId, zoho_application_id: ZOHO_APP_ID, status: 'hired' }],
  user_documents: [],
  practice_doc_ops: [],
  runtime_kv: [{ key: 'placement_payload:' + ZOHO_APP_ID, value: { practiceName: 'Stale', contractUrl: '' }, expires_at: null }]
};
// In-memory Storage: objectKey ("<bucket>/<path>") -> Buffer
const storage = new Map();

function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }
function buildMatcher(params) {
  const filters = [];
  for (const [k, v] of params.entries()) {
    if (['select', 'limit', 'order', 'on_conflict'].includes(k)) continue;
    const mm = /^(eq|neq)\.(.*)$/s.exec(v);
    if (mm) filters.push({ col: k, op: mm[1], val: mm[2] });
  }
  return (row) => filters.every((f) => {
    const cell = row ? row[f.col] : undefined;
    const eq = String(cell) === String(f.val);
    return f.op === 'eq' ? eq : !eq;
  });
}

function startEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const sendJson = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      const readBody = () => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });

      // ── Supabase Storage ──
      if (u.pathname.startsWith('/storage/v1/')) {
        // create signed upload URL
        let mm = u.pathname.match(/^\/storage\/v1\/object\/upload\/sign\/(.+)$/);
        if (mm && req.method === 'POST') { sendJson(200, { url: '/object/upload/sign/' + mm[1] + '?token=test-token' }); return; }
        // PUT bytes via signed upload URL
        if (mm && req.method === 'PUT') { storage.set(decodeURIComponent(mm[1]), await readBody()); sendJson(200, { Key: mm[1] }); return; }
        // GET raw object (server-side download)
        mm = u.pathname.match(/^\/storage\/v1\/object\/(?!upload|sign|public)(.+)$/);
        if (mm && req.method === 'GET') {
          const buf = storage.get(decodeURIComponent(mm[1]));
          if (!buf) { res.writeHead(404); res.end('not found'); return; }
          res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(buf); return;
        }
        // DELETE object
        mm = u.pathname.match(/^\/storage\/v1\/object\/(.+)$/);
        if (mm && req.method === 'DELETE') { storage.delete(decodeURIComponent(mm[1])); sendJson(200, {}); return; }
        // create signed download URL
        mm = u.pathname.match(/^\/storage\/v1\/object\/sign\/(.+)$/);
        if (mm && req.method === 'POST') { sendJson(200, { signedURL: '/object/sign/' + mm[1] + '?token=dl' }); return; }
        sendJson(404, { message: 'storage not found' }); return;
      }

      // ── PostgREST ──
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { sendJson(404, { message: 'not found' }); return; }
      const rows = tableOf(decodeURIComponent(m[1]));
      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        sendJson(200, out); return;
      }
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody()).toString('utf8') || 'null');
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const conflictCol = u.searchParams.get('on_conflict');
        const saved = incoming.map((r) => {
          if (conflictCol) {
            const cols = conflictCol.split(',');
            const existing = rows.find((row) => row && cols.every((c) => String(row[c]) === String(r[c])));
            if (existing) { Object.assign(existing, r); return existing; }
          }
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          rows.push(row); return row;
        });
        sendJson(201, saved); return;
      }
      if (req.method === 'PATCH') {
        const patch = JSON.parse((await readBody()).toString('utf8') || 'null');
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        sendJson(200, matched); return;
      }
      if (req.method === 'DELETE') {
        const keep = rows.filter((row) => !matches(row));
        rows.length = 0; keep.forEach((row) => rows.push(row));
        sendJson(200, []); return;
      }
      sendJson(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function adminCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: SUPER_EMAIL, adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { cookie, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (host) headers.Host = host;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let parsed = null; try { parsed = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: parsed, raw }); });
    });
    r.on('error', reject); r.end(data);
  });
}
const adminPost = (p, body) => httpReq('POST', p, { host: SUPER_HOST, cookie: adminCookie(), body });

// Direct PUT to the (emulated) signed upload URL, exactly as the browser would.
function putSignedUpload(uploadUrl, buffer, mime) {
  return new Promise((resolve, reject) => {
    const target = new URL(uploadUrl);
    const r = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: 'PUT', headers: { 'Content-Type': mime, 'x-upsert': 'true', 'Content-Length': buffer.length } }, (res) => {
      res.on('data', () => {}); res.on('end', () => resolve({ status: res.statusCode }));
    });
    r.on('error', reject); r.end(buffer);
  });
}

beforeAll(async () => {
  await startEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'offer-contract-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = '';
  const serverModule = await import('../server.js');
  const { createServer } = serverModule;
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
});

describe('admin offer/contract direct-to-Storage upload', () => {
  it('signs, uploads to Storage, finalizes into a downloadable offer_contract doc, and invalidates the placement cache', async () => {
    // 1. sign-upload
    const sign = await adminPost('/api/admin/offer-contract/sign-upload', { case_id: CASE_ID, document_key: 'offer_contract', file_name: 'Contract.pdf', mime_type: 'application/pdf' });
    expect(sign.status).toBe(200);
    expect(sign.body.ok).toBe(true);
    expect(typeof sign.body.uploadUrl).toBe('string');
    expect(sign.body.storagePath).toBe('users/' + GP.userId + '/offer-documents/offer_contract/current');

    // 2. browser PUTs the raw bytes straight to Storage (no base64, no size limit)
    const pdf = Buffer.from('%PDF-1.4 fake contract bytes for Sana', 'utf8');
    const put = await putSignedUpload(sign.body.uploadUrl, pdf, 'application/pdf');
    expect(put.status).toBe(200);
    // Storage keys by "<bucket>/<path>", the object landed at the signed path.
    expect([...storage.keys()].some((k) => k.endsWith(sign.body.storagePath))).toBe(true);

    // 3. finalize
    const fin = await adminPost('/api/admin/offer-contract/finalize', { case_id: CASE_ID, file_name: 'Contract.pdf', mime_type: 'application/pdf', file_size: pdf.length });
    expect(fin.status).toBe(200);
    expect(fin.body.ok).toBe(true);

    // 4a. user_documents offer_contract row exists with a resolvable storage reference
    const doc = db.user_documents.find((d) => d.user_id === GP.userId && d.document_key === 'offer_contract');
    expect(doc).toBeTruthy();
    expect(doc.storage_path).toBe('users/' + GP.userId + '/offer-documents/offer_contract/current');
    expect(doc.file_url).toBe(doc.storage_path);
    expect(['approved', 'uploaded', 'received']).toContain(doc.status);

    // 4b. admin Prepared-by-GP-Link card marked completed
    const ops = db.practice_doc_ops.find((o) => o.case_id === CASE_ID && o.document_key === 'offer_contract');
    expect(ops).toBeTruthy();
    expect(ops.ops_status).toBe('completed');

    // 4c. the GP's stale cached placement payload was invalidated
    expect(db.runtime_kv.find((k) => k.key === 'placement_payload:' + ZOHO_APP_ID)).toBeUndefined();
  });

  it('rejects finalize when no file was uploaded to Storage', async () => {
    storage.clear();
    const fin = await adminPost('/api/admin/offer-contract/finalize', { case_id: CASE_ID, file_name: 'Contract.pdf' });
    expect(fin.status).toBe(400);
    expect(fin.body.ok).toBe(false);
  });

  it('requires an admin session', async () => {
    const r = await httpReq('POST', '/api/admin/offer-contract/sign-upload', { host: SUPER_HOST, body: { case_id: CASE_ID } });
    expect([401, 403]).toContain(r.status);
  });
});

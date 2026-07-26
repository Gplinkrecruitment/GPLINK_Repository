// Admin upload into the "Prepared by Candidate" placeholders (owner request
// 2026-07-27: staff receive the doctor's certificates by email/WhatsApp and
// need to file them without asking the doctor to re-upload).
//
// Boots the real server against an in-memory emulator handling BOTH PostgREST
// and Supabase Storage, so both endpoints are exercised end to end:
//   POST /api/admin/candidate-doc/sign-upload → signed upload URL
//   (browser PUTs the raw file — scans are routinely multi-MB, which a JSON
//   body can't carry)
//   POST /api/admin/candidate-doc/finalize    → the user_documents row the
//   admin card, the GP's My Documents list and the AHPRA pack all read.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-candidate-doc-${RUN_ID}.json`);
let server, port, sbServer, sbPort;

const SUPER_HOST = 'ceo-cd.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const GP = { userId: 'u-gp-cd-1', email: 'gp-cd@gplink-test.local' };
const CASE_ID = 'case-cd-1';
const NOW = new Date().toISOString();
const DOC_KEY = 'primary_medical_degree';
const STORAGE_PATH = 'users/' + GP.userId + '/prepared-documents/uk/' + DOC_KEY + '/current';

const db = {
  // registration_country is stored DOUBLE-STRINGIFIED here on purpose — that is
  // the shape prod actually holds, and it must still resolve to 'uk'.
  user_profiles: [{ user_id: GP.userId, email: GP.email, first_name: 'Mercy', last_name: 'Test', registration_country: '"United Kingdom"' }],
  user_state: [{ user_id: GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }],
  registration_cases: [{ id: CASE_ID, user_id: GP.userId, status: 'active', google_drive_folder_id: null }],
  user_documents: [],
  task_timeline: []
};
const storage = new Map();

function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

// Postgres rejects a non-uuid value in a uuid column with 22P02 and the WHOLE
// write fails. An untyped emulator happily stores anything, which once hid a
// real production break: the admin's EMAIL was written into
// user_documents.reviewed_by (a uuid column), so every upload would have 502'd
// while the tests stayed green. Mirror the type check for the columns that
// production code writes dynamically.
// Kept deliberately narrow — fixture ids like 'u-gp-cd-1' are not uuids and
// are fine; this guards the values the SERVER chooses, not the test's.
const UUID_COLUMNS = { user_documents: ['reviewed_by'] };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidColumnViolation(table, obj) {
  for (const col of (UUID_COLUMNS[table] || [])) {
    const v = obj ? obj[col] : undefined;
    if (v === undefined || v === null) continue;
    if (!UUID_RE.test(String(v))) {
      return { code: '22P02', details: null, hint: null, message: `invalid input syntax for type uuid: "${v}"` };
    }
  }
  return null;
}
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

      if (u.pathname.startsWith('/storage/v1/')) {
        let mm = u.pathname.match(/^\/storage\/v1\/object\/upload\/sign\/(.+)$/);
        if (mm && req.method === 'POST') { sendJson(200, { url: '/object/upload/sign/' + mm[1] + '?token=test-token' }); return; }
        if (mm && req.method === 'PUT') { storage.set(decodeURIComponent(mm[1]), await readBody()); sendJson(200, { Key: mm[1] }); return; }
        mm = u.pathname.match(/^\/storage\/v1\/object\/(?!upload|sign|public)(.+)$/);
        if (mm && req.method === 'GET') {
          const buf = storage.get(decodeURIComponent(mm[1]));
          if (!buf) { res.writeHead(404); res.end('not found'); return; }
          res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(buf); return;
        }
        mm = u.pathname.match(/^\/storage\/v1\/object\/(.+)$/);
        if (mm && req.method === 'DELETE') { storage.delete(decodeURIComponent(mm[1])); sendJson(200, {}); return; }
        mm = u.pathname.match(/^\/storage\/v1\/object\/sign\/(.+)$/);
        if (mm && req.method === 'POST') { sendJson(200, { signedURL: '/object/sign/' + mm[1] + '?token=dl' }); return; }
        sendJson(404, { message: 'storage not found' }); return;
      }

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
        const tableName = decodeURIComponent(m[1]);
        for (const r of incoming) {
          const bad = uuidColumnViolation(tableName, r);
          if (bad) { sendJson(400, bad); return; }
        }
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
        const patchBad = uuidColumnViolation(decodeURIComponent(m[1]), patch);
        if (patchBad) { sendJson(400, patchBad); return; }
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

function putSignedUpload(uploadUrl, buffer, mime) {
  return new Promise((resolve, reject) => {
    const target = new URL(uploadUrl);
    const r = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: 'PUT', headers: { 'Content-Type': mime, 'x-upsert': 'true', 'Content-Length': buffer.length } }, (res) => {
      res.on('data', () => {}); res.on('end', () => resolve({ status: res.statusCode }));
    });
    r.on('error', reject); r.end(buffer);
  });
}

// sign → PUT → finalize, the way the admin page drives it.
async function uploadCandidateDoc(docKey, fileName, buffer, mime = 'application/pdf') {
  const sign = await adminPost('/api/admin/candidate-doc/sign-upload', { case_id: CASE_ID, document_key: docKey });
  if (sign.status !== 200 || !sign.body || !sign.body.ok) return { sign, put: null, fin: null };
  const put = await putSignedUpload(sign.body.uploadUrl, buffer, mime);
  const fin = await adminPost('/api/admin/candidate-doc/finalize', { case_id: CASE_ID, document_key: docKey, file_name: fileName, mime_type: mime, file_size: buffer.length });
  return { sign, put, fin };
}

const PDF = (tail) => Buffer.from('%PDF-1.4 ' + tail, 'utf8');

beforeAll(async () => {
  await startEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'candidate-doc-secret-' + RUN_ID;
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

describe('admin upload into Prepared by Candidate placeholders', () => {
  it('signs, uploads to Storage, and finalizes into a candidate document row', async () => {
    const { sign, put, fin } = await uploadCandidateDoc(DOC_KEY, 'Degree.pdf', PDF('degree scan'));
    expect(sign.status).toBe(200);
    // The country comes from a double-stringified "United Kingdom" — it must
    // still normalize to 'uk', or the row lands where the card never looks.
    expect(sign.body.country).toBe('uk');
    expect(sign.body.storagePath).toBe(STORAGE_PATH);
    expect(put.status).toBe(200);
    expect(fin.status).toBe(200);
    expect(fin.body.ok).toBe(true);

    const doc = db.user_documents.find((d) => d.user_id === GP.userId && d.document_key === DOC_KEY);
    expect(doc).toBeTruthy();
    // country_code MUST be the lowercase normalized form: a mixed-case value
    // splits one document into two rows the UI reads separately.
    expect(doc.country_code).toBe('uk');
    expect(doc.file_url).toBe(STORAGE_PATH);
    expect(doc.file_name).toBe('Degree.pdf');
    // Auto-approved: staff filing the document IS the review step, so it must
    // NOT sit in a pending state nothing else will ever clear.
    expect(doc.status).toBe('approved');
    expect(doc.reviewed_at).toBeTruthy();
    // Attribution goes in review_notes, NOT reviewed_by: that column is a uuid,
    // so writing an admin email there 22P02s and fails the entire upload.
    expect(doc.reviewed_by == null).toBe(true);
    expect(String(doc.review_notes || '')).toContain(SUPER_EMAIL);
  });

  it('replaces a REJECTED document and flips it clean to approved', async () => {
    const doc = db.user_documents.find((d) => d.user_id === GP.userId && d.document_key === DOC_KEY);
    Object.assign(doc, { status: 'rejected', rejection_reason: 'Not certified', flag_reason: 'name_mismatch' });

    const { fin } = await uploadCandidateDoc(DOC_KEY, 'Degree-v2.pdf', PDF('recertified degree scan'));
    expect(fin.status).toBe(200);

    // Same row upserted (not duplicated) — one slot, one document.
    const rows = db.user_documents.filter((d) => d.user_id === GP.userId && d.document_key === DOC_KEY);
    expect(rows.length).toBe(1);
    expect(rows[0].file_name).toBe('Degree-v2.pdf');
    expect(rows[0].status).toBe('approved');
    // A new file must not inherit the old file's rejection — neither the
    // reason nor the flag_reason, which overrides the badge in the admin UI.
    expect(rows[0].rejection_reason).toBe('');
    expect(rows[0].flag_reason).toBeNull();
  });

  it('does NOT raise a doc_review task — staff filing the document is the review', async () => {
    const before = tableOf('registration_tasks').length;
    await uploadCandidateDoc('cv_signed_dated', 'CV.pdf', PDF('signed cv'));
    expect(tableOf('registration_tasks').length).toBe(before);
  });

  it('rejects document keys that are not candidate-prepared slots', async () => {
    for (const badKey of ['offer_contract', 'sppa_00', 'certificate_good_standing', 'not_a_key']) {
      const r = await adminPost('/api/admin/candidate-doc/sign-upload', { case_id: CASE_ID, document_key: badKey });
      expect(r.status).toBe(400);
      const f = await adminPost('/api/admin/candidate-doc/finalize', { case_id: CASE_ID, document_key: badKey, file_name: 'x.pdf' });
      expect(f.status).toBe(400);
    }
  });

  it('rejects a file whose bytes are not a real document, and bins them from Storage', async () => {
    const sign = await adminPost('/api/admin/candidate-doc/sign-upload', { case_id: CASE_ID, document_key: 'mrcgp_certified' });
    expect(sign.status).toBe(200);
    // Declared as a PDF but the bytes are not — the magic-byte check must catch it.
    await putSignedUpload(sign.body.uploadUrl, Buffer.from('<html>not a pdf</html>', 'utf8'), 'application/pdf');
    const fin = await adminPost('/api/admin/candidate-doc/finalize', { case_id: CASE_ID, document_key: 'mrcgp_certified', file_name: 'fake.pdf', mime_type: 'application/pdf' });
    expect(fin.status).toBe(400);
    expect(fin.body.ok).toBe(false);
    // No row, and the rejected bytes must not linger at the slot's path.
    expect(db.user_documents.find((d) => d.document_key === 'mrcgp_certified')).toBeUndefined();
    expect([...storage.keys()].some((k) => k.endsWith('/mrcgp_certified/current'))).toBe(false);
  });

  it('rejects finalize when nothing was uploaded to Storage', async () => {
    storage.clear();
    const fin = await adminPost('/api/admin/candidate-doc/finalize', { case_id: CASE_ID, document_key: 'cct_certified', file_name: 'CCT.pdf' });
    expect(fin.status).toBe(502);
    expect(fin.body.ok).toBe(false);
  });

  it('404s an unknown case instead of writing a stray document', async () => {
    const r = await adminPost('/api/admin/candidate-doc/sign-upload', { case_id: 'case-does-not-exist', document_key: DOC_KEY });
    expect(r.status).toBe(404);
  });

  // Proves the safety net above is armed. Without it the emulator accepted an
  // email in the uuid column `reviewed_by`, the suite stayed green, and the
  // upload 502'd in production against real Postgres.
  it('emulator rejects a non-uuid in a uuid column, exactly as Postgres does', async () => {
    const res = await fetch(`http://127.0.0.1:${sbPort}/rest/v1/user_documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ user_id: GP.userId, document_key: 'cv_signed_dated', reviewed_by: 'admin@example.com' }])
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('22P02');
  });

  it('requires an admin session', async () => {
    for (const p of ['/api/admin/candidate-doc/sign-upload', '/api/admin/candidate-doc/finalize']) {
      const r = await httpReq('POST', p, { host: SUPER_HOST, body: { case_id: CASE_ID, document_key: DOC_KEY, file_name: 'x.pdf' } });
      expect([401, 403]).toContain(r.status);
    }
  });
});

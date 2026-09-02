// Three independent bugs found while completing Dr Sana Ahsan's SPPA-00 (2026-08-31).
// All three were invisible from the admin side — the grid showed everything present
// and "COMPLETED" throughout — so each gets a guard here.
//
// 1. A delivered document handed the doctor the WRONG FILE. deliverToMyDocuments
//    uploads to Drive but never wrote google_drive_file_id back to the user_documents
//    row, and /api/gplink-docs-status resolved its link as
//    drive id -> file_url -> hardcoded '/documents/section_g.pdf'. So a delivered
//    SPPA-00 opened Section G. (Dr Smith Miller's June delivery was in this state too.)
//
// 2. The AI completeness gate reported a document that IS on file as missing.
//    _siblingHasDoc looked only in task_documents; the direct-to-Storage uploaders
//    write user_documents + Storage and never create a task_documents row, so Sana's
//    offer/contract read as absent and blocked a legitimate submit. Same root cause
//    already fixed in loadPracticeDocBuffer, never applied here.
//
// 3. "Upload Return" could not accept a real scan. The PDF travelled as base64 in the
//    JSON body and Vercel rejects bodies over ~4.5MB with a 413 before the function
//    runs — Sana's 3.8MB scan is 5.1MB encoded. The fix mirrors offer-contract:
//    sign -> browser PUTs straight to Storage -> store by path.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-sppa-delivery-${RUN_ID}.json`);
const BUCKET = 'gp-link-documents';
let server, port, sbServer, sbPort;

const GP = { userId: 'u-gp-delivery-1', email: 'sana.delivery@gplink-test.local' };
const CASE_ID = 'case-delivery-1';
const TASK = { supervisor_cv: 't-del-sv', offer_contract: 't-del-oc', sppa_00: 't-del-00' };
// The shape the offer-contract uploader really writes (copied from Sana's live row).
const OC_STORAGE_PATH = 'users/' + GP.userId + '/offer-documents/offer_contract/current';

const PDF = (tail) => Buffer.from('%PDF-1.4 ' + tail, 'utf8');
const dataUrl = (buf) => 'data:application/pdf;base64,' + buf.toString('base64');

let db;
const storage = new Map();

function freshDb() {
  return {
    user_profiles: [{ user_id: GP.userId, email: GP.email, first_name: 'Sana', last_name: 'Test' }],
    registration_cases: [{ id: CASE_ID, user_id: GP.userId, status: 'active', google_drive_folder_id: null }],
    registration_tasks: [
      { id: TASK.supervisor_cv, case_id: CASE_ID, task_type: 'practice_pack_child', related_document_key: 'supervisor_cv', status: 'completed' },
      { id: TASK.offer_contract, case_id: CASE_ID, task_type: 'practice_pack_child', related_document_key: 'offer_contract', status: 'completed' },
      {
        id: TASK.sppa_00, case_id: CASE_ID, task_type: 'practice_pack_child', related_document_key: 'sppa_00',
        status: 'in_progress',
        metadata: { sppa_state: 'practice_returned', practice_returned_at: new Date().toISOString() }
      }
    ],
    // Supervisor CV lives in task_documents; the completed SPPA-00 is attached too.
    task_documents: [
      { id: 'td-sv', task_id: TASK.supervisor_cv, case_id: CASE_ID, filename: 'Supervisor CV.pdf', mime_type: 'application/pdf', is_current: true, category: 'primary', attachment_url: dataUrl(PDF('supervisor cv')) },
      { id: 'td-00', task_id: TASK.sppa_00, case_id: CASE_ID, filename: 'SPPA-00 (Completed).pdf', mime_type: 'application/pdf', is_current: true, category: 'primary', attachment_url: dataUrl(PDF('the completed sppa')) }
    ],
    // Offer/contract lives ONLY in user_documents + Storage — no task_documents row.
    user_documents: [
      { id: 'ud-oc', user_id: GP.userId, document_key: 'offer_contract', country_code: 'uk', status: 'approved', file_name: 'Contract.pdf', mime_type: 'application/pdf', storage_path: OC_STORAGE_PATH, file_url: OC_STORAGE_PATH, google_drive_file_id: 'drive-oc' }
    ],
    practice_doc_ops: [{ case_id: CASE_ID, document_key: 'sppa_00', ops_status: 'under_review' }],
    task_timeline: [],
    user_state: [{ user_id: GP.userId, state: {} }]
  };
}

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

      // Signed upload URL mint: POST /storage/v1/object/upload/sign/<bucket>/<path>
      const signM = u.pathname.match(/^\/storage\/v1\/object\/upload\/sign\/(.+)$/);
      if (signM && req.method === 'POST') {
        sendJson(200, { url: '/object/upload/sign/' + signM[1] + '?token=tok-' + RUN_ID });
        return;
      }
      // The browser's PUT to that signed URL.
      const putM = u.pathname.match(/^\/storage\/v1\/object\/upload\/sign\/(.+)$/);
      if (putM && req.method === 'PUT') {
        const key = decodeURIComponent(putM[1]).split('/').map(decodeURIComponent).join('/');
        storage.set(key, await readBody());
        sendJson(200, { Key: key });
        return;
      }
      // Raw object upload: POST /storage/v1/object/<bucket>/<path>. deliverToMyDocuments
      // now puts the bytes in Storage BEFORE writing the user_documents row — Drive used
      // to be their only home, and because uploadToGoogleDrive throws, a Drive failure
      // left an 'approved' row pointing at nothing (bug 1 below, and the reason Section G
      // was never delivered at all). Without this branch the double 404s that upload and
      // the delivery correctly reports storing nothing.
      const om = u.pathname.match(/^\/storage\/v1\/object\/(.+)$/);
      if (om && req.method === 'POST') {
        const key = decodeURIComponent(om[1]).split('/').map(decodeURIComponent).join('/');
        storage.set(key, await readBody());
        sendJson(200, { Key: key });
        return;
      }
      // Storage reads: GET /storage/v1/object/<bucket>/<path>
      const sm = u.pathname.match(/^\/storage\/v1\/object\/(.+)$/);
      if (sm && req.method === 'GET') {
        const key = decodeURIComponent(sm[1]).split('/').map(decodeURIComponent).join('/');
        const buf = storage.get(key);
        if (!buf) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(buf); return;
      }
      if (u.pathname.startsWith('/storage/v1/')) { sendJson(404, { message: 'storage not found' }); return; }

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
        const saved = incoming.map((r) => { const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r }; rows.push(row); return row; });
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

function base64UrlEncode(input) {
  return Buffer.from(String(input), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function mintCookie(name, userProfile) {
  const payload = base64UrlEncode(JSON.stringify({ userProfile, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return `${name}=${encodeURIComponent(payload + '.' + sig)}`;
}
const adminCookie = () => mintCookie('gp_admin_session', { email: 'admin@gplink-test.local', adminRole: 'admin' });
const gpCookie = () => mintCookie('gp_session', { email: GP.email, supabaseUserId: GP.userId });

function request(method, p, { cookie, body, raw, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : (body !== undefined ? Buffer.from(JSON.stringify(body)) : null);
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (payload) { headers['Content-Type'] = contentType || 'application/json'; headers['Content-Length'] = payload.length; }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const text = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// PUT straight at the emulator, standing in for the browser's upload.
function putToSignedUrl(url, buf) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PUT',
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': buf.length, 'x-upsert': 'true' }
    }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    r.on('error', reject); r.write(buf); r.end();
  });
}

const sppaTask = () => db.registration_tasks.find((t) => t.id === TASK.sppa_00);
const sppaUserDoc = () => db.user_documents.find((d) => d.user_id === GP.userId && d.document_key === 'sppa_00');

beforeAll(async () => {
  db = freshDb();
  storage.set(BUCKET + '/' + OC_STORAGE_PATH, PDF('the signed offer contract'));
  await startEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'sppa-delivery-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.SUPABASE_DOCUMENT_BUCKET = BUCKET;
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  // No ANTHROPIC_API_KEY: checkSppaCompleteness returns a soft { _error: 'no_api_key' }
  // verdict, and the stored result still carries the document inventory — which is
  // exactly the part bug 2 is about.
  delete process.env.ANTHROPIC_API_KEY;
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
});

describe('bug 2 — the completeness inventory must find a document filed only in Storage', () => {
  it('starts from a case whose offer/contract has no task_documents row', () => {
    // Guards the premise: if a fixture change adds one, this stops covering the fallback.
    expect(db.task_documents.filter((d) => d.task_id === TASK.offer_contract).length).toBe(0);
    expect(db.user_documents.find((d) => d.document_key === 'offer_contract').storage_path).toBe(OC_STORAGE_PATH);
  });

  it('reports offer_contract present after running the check via sppa-submit', async () => {
    const res = await request('POST', `/api/admin/va/task/${TASK.sppa_00}/sppa-submit`, {
      cookie: adminCookie(), body: {}
    });
    expect(res.status).toBe(200);
    const inv = sppaTask().metadata.completeness_check.inventory;
    // Before the fix this was false — the contract was on file the whole time.
    expect(inv.offer_contract).toBe(true);
    expect(inv.supervisor_cv).toBe(true);
  });
});

describe('bug 1 — a delivered document must never resolve to someone else’s file', () => {
  it('delivered the SPPA-00 to the GP’s documents', () => {
    const row = sppaUserDoc();
    expect(row).toBeTruthy();
    expect(row.status).toBe('approved');
  });

  it('does NOT hand the doctor Section G when the SPPA-00 row has no pointer', async () => {
    // Drive is disabled in this run, so the row carries no google_drive_file_id —
    // precisely the live shape that served '/documents/section_g.pdf' for sppa_00.
    const row = sppaUserDoc();
    expect(row.google_drive_file_id || '').toBe('');
    const res = await request('GET', '/api/gplink-docs-status', { cookie: gpCookie() });
    expect(res.status).toBe(200);
    const entry = res.body.docs.sppa_00;
    expect(entry.url).not.toBe('/documents/section_g.pdf');
    expect(entry.url).toBe('');
    expect(entry.ready).toBe(false);
  });

  it('serves the real Drive file once the row carries the id', async () => {
    sppaUserDoc().google_drive_file_id = 'drive-sppa-xyz';
    const res = await request('GET', '/api/gplink-docs-status', { cookie: gpCookie() });
    const entry = res.body.docs.sppa_00;
    expect(entry.ready).toBe(true);
    expect(entry.url).toBe('https://drive.google.com/file/d/drive-sppa-xyz/view');
  });

  it('still gives section_g its own static copy (no regression)', async () => {
    db.user_documents.push({
      id: 'ud-sg', user_id: GP.userId, document_key: 'section_g', country_code: 'uk',
      status: 'approved', file_name: 'Section G.pdf', google_drive_file_id: '', file_url: ''
    });
    const res = await request('GET', '/api/gplink-docs-status', { cookie: gpCookie() });
    const entry = res.body.docs.section_g;
    expect(entry.ready).toBe(true);
    expect(entry.url).toBe('/documents/section_g.pdf');
  });
});

describe('bug 3 — a returned SPPA-00 uploads straight to Storage, not through the JSON body', () => {
  let signed;

  it('mints a signed upload URL scoped to the case', async () => {
    const res = await request('POST', `/api/admin/va/task/${TASK.sppa_00}/sppa-sign-upload`, { cookie: adminCookie() });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.uploadUrl).toContain('/storage/v1/object/upload/sign/');
    expect(res.body.storagePath).toMatch(new RegExp('^cases/' + CASE_ID + '/sppa-returns/'));
    signed = res.body;
  });

  it('stores a return that never travelled through the request body', async () => {
    const scan = PDF('a 3.8MB phone scan stands here');
    const put = await putToSignedUrl(signed.uploadUrl, scan);
    expect(put.status).toBe(200);

    const res = await request('POST', `/api/admin/va/task/${TASK.sppa_00}/sppa-store-returned`, {
      cookie: adminCookie(),
      body: { from: 'practice', storage_path: signed.storagePath, file_name: 'SPPA-00 (Completed).pdf' }
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.state).toBe('practice_returned');

    const current = db.task_documents.filter((d) => d.task_id === TASK.sppa_00 && d.is_current);
    expect(current.length).toBe(1);
    expect(current[0].filename).toBe('SPPA-00 (Completed).pdf');
    expect(current[0].uploaded_by).toBe('admin_manual_practice_return');
    // The bytes the browser PUT to Storage are what got recorded.
    expect(current[0].attachment_url).toBe(dataUrl(scan));
  });

  it('refuses a storage_path it did not mint', async () => {
    const res = await request('POST', `/api/admin/va/task/${TASK.sppa_00}/sppa-store-returned`, {
      cookie: adminCookie(),
      body: { from: 'practice', storage_path: 'users/' + GP.userId + '/offer-documents/offer_contract/current' }
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid storage_path');
  });

  it('still requires one of the two sources', async () => {
    const res = await request('POST', `/api/admin/va/task/${TASK.sppa_00}/sppa-store-returned`, {
      cookie: adminCookie(), body: { from: 'practice' }
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('file_data_url or storage_path required');
  });
});

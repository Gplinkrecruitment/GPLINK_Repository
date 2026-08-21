// A practice document filed BY HAND must finish the task, exactly like one the
// practice emailed back.
//
// The bug this pins (found on Dr Sana Ahsan, 2026-08-21): staff were sent the
// Supervisor CV and Position Description directly, uploaded both through
// POST /api/admin/practice-doc/upload, and the documents landed — task_documents
// rows written, files in Drive, practice_doc_ops flipped to 'completed'. But the
// endpoint never touched registration_tasks.status, so both tasks sat at
// 'escalated' with a due date three weeks past: the cards stayed on the GP
// profile showing "overdue", kept rendering their "request document from
// practice" email composer, the doctor never saw the files in My Documents, and
// the SPPA-00 conflict scan — which requires supervisor_cv + offer_contract to be
// COMPLETED with documents — never ran, so SPPA-00 stayed deferred forever.
//
// Nothing else would ever close these tasks: the completion path they were
// waiting on (/api/admin/task/submit-drive) only appears once the PRACTICE
// replies by email, which by definition never happens when staff were sent the
// document directly.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-practice-doc-complete-${RUN_ID}.json`);
let server, port, sbServer, sbPort;

const SUPER_HOST = 'ceo-pdc.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const GP = { userId: 'u-gp-pdc-1', email: 'gp-pdc@gplink-test.local' };
const CASE_ID = 'case-pdc-1';
const NOW = new Date().toISOString();
const PAST_DUE = '2026-08-05';

const TASK = {
  supervisor_cv: 't-sv-cv',
  position_description: 't-pos-desc',
  offer_contract: 't-offer',
  sppa_00: 't-sppa'
};

let db;
function freshDb() {
  return {
    user_profiles: [{ user_id: GP.userId, email: GP.email, first_name: 'Sana', last_name: 'Test', registration_country: 'United Kingdom' }],
    user_state: [{ user_id: GP.userId, state: {}, updated_at: NOW }],
    registration_cases: [{ id: CASE_ID, user_id: GP.userId, status: 'active', google_drive_folder_id: null }],
    // Both document tasks are exactly where Sana's were: escalated and overdue,
    // with the request email already sent to the practice.
    registration_tasks: [
      { id: TASK.supervisor_cv, case_id: CASE_ID, task_type: 'practice_pack_child', related_document_key: 'supervisor_cv', title: 'Supervisor CV', status: 'escalated', due_date: PAST_DUE, completed_at: null, completed_by: null },
      { id: TASK.position_description, case_id: CASE_ID, task_type: 'practice_pack_child', related_document_key: 'position_description', title: 'Position Description', status: 'escalated', due_date: PAST_DUE, completed_at: null, completed_by: null },
      // Left OPEN on purpose: it is the second SPPA-00 prerequisite, so the
      // conflict scan must bail out rather than reach for an AI call in a test.
      { id: TASK.offer_contract, case_id: CASE_ID, task_type: 'practice_pack_child', related_document_key: 'offer_contract', title: 'Offer / Contract', status: 'open', due_date: PAST_DUE },
      { id: TASK.sppa_00, case_id: CASE_ID, task_type: 'practice_pack_child', related_document_key: 'sppa_00', title: 'SPPA-00', status: 'deferred', due_date: PAST_DUE }
    ],
    practice_doc_ops: [
      { case_id: CASE_ID, document_key: 'supervisor_cv', ops_status: 'requested' },
      { case_id: CASE_ID, document_key: 'position_description', ops_status: 'requested' },
      { case_id: CASE_ID, document_key: 'offer_contract', ops_status: 'requested' },
      { case_id: CASE_ID, document_key: 'sppa_00', ops_status: 'not_requested' },
      { case_id: CASE_ID, document_key: 'section_g', ops_status: 'not_requested' }
    ],
    task_documents: [],
    task_timeline: [],
    user_documents: []
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
        const saved = incoming.map((r) => {
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

const dataUrl = (text) => 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 ' + text, 'utf8').toString('base64');

const uploadPracticeDoc = (documentKey, fileName, text) =>
  adminPost('/api/admin/practice-doc/upload', { case_id: CASE_ID, document_key: documentKey, file_data: dataUrl(text), file_name: fileName });

const taskById = (id) => db.registration_tasks.find((t) => t.id === id);
const opsFor = (key) => db.practice_doc_ops.find((o) => o.case_id === CASE_ID && o.document_key === key);

beforeAll(async () => {
  db = freshDb();
  await startEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'practice-doc-complete-secret-' + RUN_ID;
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
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
});

describe('practice document filed by hand completes its task', () => {
  it('closes the Supervisor CV task instead of leaving it escalated', async () => {
    const res = await uploadPracticeDoc('supervisor_cv', 'Supervisor CV.pdf', 'supervisor cv');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // THE regression. Without this the card never leaves the GP profile: the ops
    // chip said "completed" while the task itself was still escalated and overdue.
    const task = taskById(TASK.supervisor_cv);
    expect(task.status).toBe('completed');
    expect(task.completed_at).toBeTruthy();
    expect(task.completed_by).toBe(SUPER_EMAIL);

    // The document is attached to the task as the current version.
    const docs = db.task_documents.filter((d) => d.task_id === TASK.supervisor_cv);
    expect(docs.length).toBe(1);
    expect(docs[0].is_current).toBe(true);
    expect(docs[0].filename).toBe('Supervisor CV.pdf');

    // And the ops chip still flips, as it always did.
    expect(opsFor('supervisor_cv').ops_status).toBe('completed');
  });

  it('gives the document to the doctor, not just to the ops grid', async () => {
    // submit-drive has always written these; the manual path did not, so the
    // file was invisible in My Documents and absent from the AHPRA pack.
    const ud = db.user_documents.find((d) => d.user_id === GP.userId && d.document_key === 'supervisor_cv');
    expect(ud).toBeTruthy();
    expect(ud.status).toBe('approved');
    expect(ud.file_name).toBe('Supervisor CV.pdf');
    expect(ud.reviewed_at).toBeTruthy();
  });

  it('records the completion on the case timeline', async () => {
    const events = db.task_timeline.filter((e) => e.case_id === CASE_ID && e.task_id === TASK.supervisor_cv);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.event_type === 'completed')).toBe(true);
  });

  it('closes the Position Description task the same way', async () => {
    const res = await uploadPracticeDoc('position_description', 'Position Description.pdf', 'position description');
    expect(res.status).toBe(200);

    const task = taskById(TASK.position_description);
    expect(task.status).toBe('completed');
    expect(task.completed_at).toBeTruthy();
    expect(opsFor('position_description').ops_status).toBe('completed');
  });

  it('leaves SPPA-00 to its own state machine — holding the file is only step one', async () => {
    // SPPA-00 goes ready_to_send → sent_to_candidate → gp_returned →
    // sent_to_practice → practice_returned → completed. Auto-completing the task
    // the moment a file is filed would skip the entire flow.
    const res = await uploadPracticeDoc('sppa_00', 'SPPA-00.pdf', 'sppa form');
    expect(res.status).toBe(200);

    expect(taskById(TASK.sppa_00).status).toBe('deferred');
    expect(taskById(TASK.sppa_00).completed_at == null).toBe(true);
    // The document is still recorded against the case.
    expect(opsFor('sppa_00').ops_status).toBe('completed');
  });
});

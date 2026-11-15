// An SPPA-00 that staff uploaded is THE form. The system must never swap a blank
// template in over it, and a form the practice has already completed must not be
// sent to the practice a second time.
//
// The bug this pins (Dr Hatice Akkas, 2026-11-15). Her practice completed and signed
// the SPPA-00 before she had seen it, and staff uploaded that copy to her SPPA-00
// slot. Twenty minutes later the supervisor CV was filed, which triggered the AI
// conflict scan, and the scan did what it always did: built a fresh form from the
// blank template and stored it as the task's current document, WITHOUT stepping the
// uploaded one down. The task now had two "current" documents; the dashboard lists
// documents newest first and the send button attached the first one. She was emailed
// a blank form and asked only to sign it. She refused: "I do not want to sign an
// empty supervised practice plan agreement."
//
// Three things are guarded here, replaying that exact order of events:
//   1. the scan keeps an uploaded form instead of generating a template beside it;
//   2. nothing else regenerates over it (Q7 override) and every send path attaches it;
//   3. when the uploaded form already has the practice's sections, the doctor's signed
//      return is the FINISHED form and goes straight to final review, while an
//      uploaded form the practice has not touched keeps the normal two-step route.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { amendSppaFields, readSppaPracticeStatus } = require('../lib/sppa-pdf-fill.js');

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-sppa-uploaded-${RUN_ID}.json`);
const CRON_SECRET = 'sppa-uploaded-cron-' + RUN_ID;
const BUCKET = 'gp-link-documents';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let server, port, sbServer, sbPort;

// Case A: the practice completed the form first (Hatice). Case B: staff uploaded a
// form the practice has NOT filled in. Case C: nobody uploaded anything.
const A = { userId: 'u-up-a', caseId: 'case-up-a', sv: 't-up-a-sv', oc: 't-up-a-oc', sppa: 't-up-a-00' };
const B = { userId: 'u-up-b', caseId: 'case-up-b', sv: 't-up-b-sv', oc: 't-up-b-oc', sppa: 't-up-b-00' };
const C = { userId: 'u-up-c', caseId: 'case-up-c', sv: 't-up-c-sv', oc: 't-up-c-oc', sppa: 't-up-c-00' };

const PDF = (tail) => Buffer.from('%PDF-1.4 ' + tail, 'utf8');
const dataUrl = (buf) => 'data:application/pdf;base64,' + buf.toString('base64');
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'documents', 'sppa-00-template.pdf'));
let PRACTICE_FILLED; // the template with the supervisor's details typed in

let db;

function pack(x, sppaStatus, sppaMeta) {
  return [
    { id: x.sv, case_id: x.caseId, task_type: 'practice_pack_child', related_document_key: 'supervisor_cv', status: 'completed' },
    { id: x.oc, case_id: x.caseId, task_type: 'practice_pack_child', related_document_key: 'offer_contract', status: 'completed' },
    { id: x.sppa, case_id: x.caseId, task_type: 'practice_pack_child', related_document_key: 'sppa_00', status: sppaStatus, metadata: sppaMeta }
  ];
}
function prereqDocs(x) {
  return [
    { id: 'td-sv-' + x.caseId, task_id: x.sv, case_id: x.caseId, filename: 'Supervisor CV.pdf', mime_type: 'application/pdf', is_current: true, category: 'primary', attachment_url: dataUrl(PDF('supervisor cv')) },
    { id: 'td-oc-' + x.caseId, task_id: x.oc, case_id: x.caseId, filename: 'Contract.pdf', mime_type: 'application/pdf', is_current: true, category: 'primary', attachment_url: dataUrl(PDF('contract')) }
  ];
}

function freshDb() {
  return {
    user_profiles: [A, B, C].map((x, i) => ({ user_id: x.userId, email: 'doc' + i + '@gplink-test.local', first_name: 'Doc', last_name: 'Test' + i })),
    registration_cases: [A, B, C].map((x) => ({ id: x.caseId, user_id: x.userId, status: 'active', google_drive_folder_id: null })),
    registration_tasks: [].concat(
      pack(A, 'deferred', null),
      // B is already past the scan, waiting to be sent: the upload arrives AFTER the template.
      pack(B, 'in_progress', { sppa_state: 'ready_to_send', conflict_scan_completed: true, is_conflict: false, confidence: 'high' }),
      pack(C, 'deferred', null)
    ),
    task_documents: [].concat(prereqDocs(A), prereqDocs(B), prereqDocs(C), [
      // A: the practice-completed form staff uploaded BEFORE the scan ran.
      { id: 'td-a-upload', task_id: A.sppa, case_id: A.caseId, filename: 'Ahpra---Form---SPPA-00-GEN (3).pdf', mime_type: 'application/pdf', is_current: true, category: 'primary', uploaded_by: 'admin_upload', created_at: '2026-11-09T13:24:53.000Z', attachment_url: dataUrl(PRACTICE_FILLED) },
      // B: the system's own template, generated by an earlier scan.
      { id: 'td-b-system', task_id: B.sppa, case_id: B.caseId, filename: 'SPPA-00.pdf', mime_type: 'application/pdf', is_current: true, category: 'primary', uploaded_by: 'system_conflict_scan', created_at: '2026-11-09T13:44:29.000Z', attachment_url: dataUrl(TEMPLATE) }
    ]),
    user_documents: [],
    practice_doc_ops: [A, B, C].map((x) => ({ case_id: x.caseId, document_key: 'sppa_00', ops_status: 'not_requested' })),
    task_timeline: [],
    user_state: []
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
      if (u.pathname.startsWith('/storage/v1/')) { sendJson(404, { message: 'storage not found' }); return; }
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { sendJson(404, { message: 'not found' }); return; }
      const rows = tableOf(decodeURIComponent(m[1]));
      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        let out = rows.filter(matches);
        // Honour created_at ordering: "newest first" is the very thing that picked the wrong form.
        const order = u.searchParams.get('order') || '';
        if (/created_at\.desc/.test(order)) out = out.slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        sendJson(200, out); return;
      }
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody()).toString('utf8') || 'null');
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const saved = incoming.map((r) => { const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), category: 'primary', ...r }; rows.push(row); return row; });
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
  return Buffer.from(String(input), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function adminCookie() {
  const payload = base64UrlEncode(JSON.stringify({ userProfile: { email: 'admin@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { Cookie: adminCookie() };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let parsed = null; try { parsed = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: parsed, raw }); });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const task = (id) => db.registration_tasks.find((t) => t.id === id);
const currentForms = (taskId) => db.task_documents.filter((d) => d.task_id === taskId && d.is_current && d.category !== 'alt_supervisor_cv');

beforeAll(async () => {
  const filled = await amendSppaFields(TEMPLATE, [
    { name: 'Family name-q2', value: 'Mahmoud' },
    { name: 'First given name-q2', value: 'Tarig' },
    { name: 'q2_Registration number', value: 'MED0001687100' },
    { name: 'Name of primary supervisor', value: 'Tarig Mahmoud' }
  ]);
  expect(filled.amended).toBe(4);
  PRACTICE_FILLED = filled.buffer;
  db = freshDb();
  await startEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'sppa-uploaded-secret-' + RUN_ID;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.SUPABASE_DOCUMENT_BUCKET = BUCKET;
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  // No ANTHROPIC_API_KEY on purpose: the AI steps return soft errors, so the
  // orchestration runs to completion without a network call.
  delete process.env.ANTHROPIC_API_KEY;
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
});

describe('reading whether an SPPA-00 already carries the practice\'s answers', () => {
  it('a blank template is readable and NOT practice-filled', async () => {
    const s = await readSppaPracticeStatus(TEMPLATE);
    expect(s.readable).toBe(true);
    expect(s.practice_filled).toBe(false);
  });
  it('a form with the supervisor\'s details is practice-filled', async () => {
    const s = await readSppaPracticeStatus(PRACTICE_FILLED);
    expect(s.readable).toBe(true);
    expect(s.practice_filled).toBe(true);
    expect(s.supervisor_name).toBe('Tarig Mahmoud');
  });
  it('a file with no form fields (a scan) is reported unreadable, never as blank', async () => {
    const s = await readSppaPracticeStatus(PDF('a scanned page'));
    expect(s.readable).toBe(false);
  });
});

describe('the conflict scan keeps a form staff already uploaded', () => {
  it('starts with the uploaded, practice-completed form as the only form on the task', () => {
    expect(currentForms(A.sppa).map((d) => d.id)).toEqual(['td-a-upload']);
    expect(task(A.sppa).status).toBe('deferred');
  });

  it('runs the scan', async () => {
    const res = await request('GET', '/api/cron/sppa-backfill-scan?secret=' + encodeURIComponent(CRON_SECRET));
    expect(res.status).toBe(200);
    expect(res.body.results.find((r) => r.case_id === A.caseId).action).toBe('scanned');
    expect(res.body.results.find((r) => r.case_id === C.caseId).action).toBe('scanned');
  });

  it('leaves the uploaded form as the ONE current form — no blank template beside it', () => {
    const cur = currentForms(A.sppa);
    expect(cur.length).toBe(1);
    expect(cur[0].id).toBe('td-a-upload');
    expect(db.task_documents.some((d) => d.task_id === A.sppa && d.uploaded_by === 'system_conflict_scan')).toBe(false);
  });

  it('unlocks the task and records that the practice has already done its part', () => {
    const m = task(A.sppa).metadata;
    expect(task(A.sppa).status).toBe('in_progress');
    expect(m.sppa_state).toBe('ready_to_send');
    expect(m.conflict_scan_completed).toBe(true);
    expect(m.uploaded_form.doc_id).toBe('td-a-upload');
    expect(m.practice_prefilled).toBe(true);
  });

  it('still generates the template when nobody uploaded a form (control)', () => {
    const cur = currentForms(C.sppa);
    expect(cur.length).toBe(1);
    expect(cur[0].uploaded_by).toBe('system_conflict_scan');
    expect(task(C.sppa).metadata.uploaded_form).toBeUndefined();
    expect(task(C.sppa).metadata.practice_prefilled).toBeUndefined();
  });

  it('Override Q7 changes our record but does not rebuild a template over the upload', async () => {
    const res = await request('POST', '/api/admin/va/task/' + A.sppa + '/sppa-override-q7', { is_conflict: true });
    expect(res.status).toBe(200);
    expect(res.body.form_kept).toBe(true);
    expect(task(A.sppa).metadata.is_conflict).toBe(true);
    expect(currentForms(A.sppa).map((d) => d.id)).toEqual(['td-a-upload']);
  });
});

describe('the doctor\'s signed return of a practice-completed form is the finished form', () => {
  it('goes straight to final review instead of waiting to be sent to the practice', async () => {
    task(A.sppa).metadata.sppa_state = 'sent_to_candidate';
    const res = await request('POST', '/api/admin/va/task/' + A.sppa + '/sppa-store-returned',
      { from: 'candidate', file_data_url: dataUrl(PRACTICE_FILLED), file_name: 'SPPA-00 signed.pdf' });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('practice_returned');
    const m = task(A.sppa).metadata;
    expect(m.sppa_state).toBe('practice_returned');
    expect(m.completed_by_gp_return).toBe(true);
    expect(m.gp_returned_at).toBeTruthy();
  });

  it('the signed copy is now the one current form', () => {
    const cur = currentForms(A.sppa);
    expect(cur.length).toBe(1);
    expect(cur[0].filename).toBe('SPPA-00 signed.pdf');
    expect(cur[0].uploaded_by).toBe('admin_manual_candidate_return');
  });

  it('the timeline says who returned it', () => {
    const titles = db.task_timeline.filter((e) => e.task_id === A.sppa).map((e) => e.title);
    expect(titles.some((t) => /Doctor returned the signed SPPA-00/.test(t))).toBe(true);
    expect(titles.some((t) => t === 'Practice returned completed SPPA-00')).toBe(false);
  });
});

describe('uploading a form AFTER the scan makes it the form that is sent', () => {
  it('the upload replaces the system template and is flagged on the task', async () => {
    const res = await request('POST', '/api/admin/practice-doc/upload',
      { case_id: B.caseId, document_key: 'sppa_00', file_name: 'SPPA-00 new AHPRA version.pdf', file_data: dataUrl(TEMPLATE) });
    expect(res.status).toBe(200);
    const cur = currentForms(B.sppa);
    expect(cur.length).toBe(1);
    expect(cur[0].uploaded_by).toBe('admin_upload');
    const m = task(B.sppa).metadata;
    expect(m.uploaded_form.doc_id).toBe(cur[0].id);
    // The practice has not filled this one in, so the normal route still applies.
    expect(m.practice_prefilled).toBe(false);
    expect(m.sppa_state).toBe('ready_to_send');
  });

  it('a form the practice has NOT completed still goes to the practice after the doctor', async () => {
    task(B.sppa).metadata.sppa_state = 'sent_to_candidate';
    const res = await request('POST', '/api/admin/va/task/' + B.sppa + '/sppa-store-returned',
      { from: 'candidate', file_data_url: dataUrl(TEMPLATE), file_name: 'SPPA-00 from doctor.pdf' });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('gp_returned');
    expect(task(B.sppa).metadata.completed_by_gp_return).toBeUndefined();
  });
});

describe('every send path attaches the form the RSO was shown', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const adminSrc = fs.readFileSync(path.join(ROOT, 'pages', 'admin.html'), 'utf8');

  it('the server send no longer takes "the first current document"', () => {
    const start = serverSrc.indexOf("pathname.endsWith('/sppa-send-to-candidate')");
    const handler = serverSrc.slice(start, start + 6000);
    expect(handler).toContain('_sppaCurrentFormDoc(taskId, taskMeta)');
    expect(handler).not.toMatch(/is_current=eq\.true&limit=1/);
  });

  it('the dashboard composer names the document and the send button sends that one', () => {
    expect(adminSrc).toContain('function sppaFormDoc()');
    expect(adminSrc).toContain('Attaching: <b>');
    expect(adminSrc).toContain("sendEmailBtn.getAttribute('data-ops-attach-doc')");
    expect(adminSrc).toContain("gpSendEmailBtn.getAttribute('data-ops-attach-doc')");
  });

  it('all three ways a doctor return arrives route a practice-completed form to final review', () => {
    // inline Gmail pickup, thread recovery, manual Upload Return
    expect(serverSrc.match(/gpFinal: true/g).length).toBe(2);
    expect(serverSrc).toContain("var gpReturnIsFinal = returnedFrom === 'candidate' && _sppaGpReturnIsFinal(taskMeta);");
  });

  it('new doctor-facing wording carries no em dash', () => {
    const start = adminSrc.indexOf('if (meta.practice_prefilled) {\n        h += \'<div class="ops-email-field">');
    expect(start).toBeGreaterThan(-1);
    const block = adminSrc.slice(start, adminSrc.indexOf('} else {', start));
    expect(block).not.toMatch(/\\u2014|—/);
  });
});

describe('the hello@ archive copy is made once per email, not once per sweep', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  it('checks the processed table by a column that exists before copying again', () => {
    expect(serverSrc).toContain("'select=gmail_message_id&gmail_message_id=eq.' + encodeURIComponent(currentMsgId) + '&limit=1'");
    expect(serverSrc).toContain('emailAddress !== MASTER_ARCHIVE_EMAIL && !_alreadyArchived');
  });
});

// The SPPA-00 conflict scan must read the offer/contract from wherever it
// actually is — not only from task_documents.
//
// The bug this pins (found on Dr Sana Ahsan, 2026-08-21): her offer/contract was
// filed through the direct-to-Storage uploader (/api/admin/offer-contract/finalize),
// which records the file in user_documents + Supabase Storage and never creates a
// task_documents row. The scan looked ONLY in task_documents, found nothing, logged
// "Missing document attachments for conflict scan" to a console nobody reads, and
// returned — so the deferred SPPA-00 task never unlocked, no matter how many times
// the documents were re-uploaded. Every admin surface showed the contract present
// and "COMPLETED" the entire time, which is exactly why it went undiagnosed.
//
// Both prerequisite tasks below are 'completed', as the real case was. The only
// difference between them is WHERE the file lives, and that must not matter.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-sppa-fallback-${RUN_ID}.json`);
const CRON_SECRET = 'sppa-fallback-cron-' + RUN_ID;
const BUCKET = 'gp-link-documents';
let server, port, sbServer, sbPort;

const GP = { userId: 'u-gp-sppa-1' };
const CASE_ID = 'case-sppa-1';
const TASK = { supervisor_cv: 't-sppa-sv', offer_contract: 't-sppa-oc', sppa_00: 't-sppa-00' };
// The shape the offer-contract uploader really writes (see Sana's live row).
const OC_STORAGE_PATH = 'users/' + GP.userId + '/offer-documents/offer_contract/current';

const PDF = (tail) => Buffer.from('%PDF-1.4 ' + tail, 'utf8');
const dataUrl = (buf) => 'data:application/pdf;base64,' + buf.toString('base64');

let db;
const storage = new Map();

function freshDb() {
  return {
    user_profiles: [{ user_id: GP.userId, first_name: 'Sana', last_name: 'Test' }],
    registration_cases: [{ id: CASE_ID, user_id: GP.userId, status: 'active', google_drive_folder_id: null }],
    registration_tasks: [
      { id: TASK.supervisor_cv, case_id: CASE_ID, task_type: 'practice_pack_child', related_document_key: 'supervisor_cv', status: 'completed' },
      { id: TASK.offer_contract, case_id: CASE_ID, task_type: 'practice_pack_child', related_document_key: 'offer_contract', status: 'completed' },
      { id: TASK.sppa_00, case_id: CASE_ID, task_type: 'practice_pack_child', related_document_key: 'sppa_00', status: 'deferred', metadata: null }
    ],
    // Supervisor CV lives in task_documents (the practice emailed it back).
    task_documents: [
      { id: 'td-sv', task_id: TASK.supervisor_cv, case_id: CASE_ID, filename: 'Supervisor CV.pdf', mime_type: 'application/pdf', is_current: true, attachment_url: dataUrl(PDF('supervisor cv')) }
    ],
    // Offer/contract lives ONLY in user_documents + Storage. No task_documents row
    // exists for it — this is the exact gap that stranded the flow.
    user_documents: [
      { id: 'ud-oc', user_id: GP.userId, document_key: 'offer_contract', country_code: 'uk', status: 'approved', file_name: 'Contract.pdf', mime_type: 'application/pdf', storage_path: OC_STORAGE_PATH, file_url: OC_STORAGE_PATH }
    ],
    practice_doc_ops: [{ case_id: CASE_ID, document_key: 'sppa_00', ops_status: 'not_requested' }],
    task_timeline: []
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

function httpGet(p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let parsed = null; try { parsed = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: parsed, raw }); });
    });
    r.on('error', reject); r.end();
  });
}

const sppaTask = () => db.registration_tasks.find((t) => t.id === TASK.sppa_00);

beforeAll(async () => {
  db = freshDb();
  storage.set(BUCKET + '/' + OC_STORAGE_PATH, PDF('the signed offer contract'));
  await startEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'sppa-fallback-secret-' + RUN_ID;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.SUPABASE_DOCUMENT_BUCKET = BUCKET;
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  // No ANTHROPIC_API_KEY on purpose: scanForConflict returns a soft
  // { _error: 'no_api_key' } result rather than throwing, so the orchestrator
  // still runs to completion and we can assert it got PAST document gathering.
  delete process.env.ANTHROPIC_API_KEY;
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
});

describe('SPPA-00 conflict scan reads the contract from Storage when task_documents has none', () => {
  it('starts from a case that has no task_documents row for the offer/contract', () => {
    // Guards the premise — if a fixture change ever adds one, this test would
    // silently stop covering the fallback it exists to protect.
    expect(db.task_documents.filter((d) => d.task_id === TASK.offer_contract).length).toBe(0);
    expect(sppaTask().status).toBe('deferred');
  });

  it('unlocks the deferred SPPA-00 task via the backfill cron', async () => {
    const res = await httpGet('/api/cron/sppa-backfill-scan?secret=' + encodeURIComponent(CRON_SECRET));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // The endpoint re-reads each task and reports the REAL outcome.
    expect(res.body.results.find((r) => r.case_id === CASE_ID).action).toBe('scanned');

    const t = sppaTask();
    expect(t.status).toBe('in_progress');
    expect(t.metadata.conflict_scan_completed).toBe(true);
    expect(t.metadata.sppa_state).toBe('ready_to_send');
  });

  it('attaches the Q7-filled SPPA-00 PDF to the task', () => {
    const filled = db.task_documents.find((d) => d.task_id === TASK.sppa_00 && d.is_current);
    expect(filled).toBeTruthy();
    expect(filled.filename).toBe('SPPA-00.pdf');
    expect(filled.uploaded_by).toBe('system_conflict_scan');
    expect(String(filled.attachment_url).startsWith('data:application/pdf;base64,')).toBe(true);
  });

  it('moves the SPPA-00 ops chip to under_review', () => {
    const ops = db.practice_doc_ops.find((o) => o.case_id === CASE_ID && o.document_key === 'sppa_00');
    expect(ops.ops_status).toBe('under_review');
  });

  it('is idempotent — a second cron pass does not rescan', async () => {
    const before = db.task_documents.filter((d) => d.task_id === TASK.sppa_00).length;
    const res = await httpGet('/api/cron/sppa-backfill-scan?secret=' + encodeURIComponent(CRON_SECRET));
    expect(res.body.results.find((r) => r.case_id === CASE_ID).action).toBe('skip_already_scanned');
    expect(db.task_documents.filter((d) => d.task_id === TASK.sppa_00).length).toBe(before);
  });
});

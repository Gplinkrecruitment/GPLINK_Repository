// Owner report 2026-09-02: "why is section g not automatically being uploaded for our
// gps including for example dr sana and mercy".
//
// Measured against PROD before the fix: the success marker
// ("Section G auto-delivered to MyDocuments and Google Drive") had ZERO rows in the whole
// database, and 0 of the 2 cases that have ever had a section_g task held an actual file.
//   - Dr Sana Ahsan   — user_documents row `status:'approved'`, file_name 'Section G.pdf',
//                       but file_url '', storage_path null, file_size 0, drive id ''.
//                       Task completed, ops completed. The RSO pack therefore rendered
//                       Section G as COMPLETED next to a bare "+ Upload" with no
//                       thumbnail, size or date.
//   - Dr Mercy Obanimoh — no user_documents row at all; task still `deferred`.
//
// Three defects, all covered here:
//  1. deliverToMyDocuments wrote the 'approved' row BEFORE it had the bytes, and its only
//     home for them was Google Drive. uploadToGoogleDrive THROWS and had no try/catch, so
//     any Drive failure escaped the function having already written an approved row that
//     pointed at nothing — and emailed the doctor about it.
//  2. The caller completed the task and set practice_doc_ops 'completed' whether or not a
//     file had landed, so a failed delivery still read as done.
//  3. Delivery fired from exactly ONE event (the career-secured flip, once per case) with
//     no cron behind it — the practice-pack Gmail backstop explicitly excludes section_g —
//     so a miss in that window was permanent.
//
// These run the real repair path end to end through the hourly cron, with Google Drive
// DELIBERATELY UNCONFIGURED: before the fix that guaranteed nothing was ever delivered;
// now Supabase Storage carries it on its own.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-section-g-${RUN_ID}.json`);
const BUCKET = 'gp-link-documents';
const CRON_SECRET = 'section-g-cron-' + RUN_ID;

let server, port, sbServer, sbPort;
let db;
const storage = new Map();
// Any storage path containing this user id is rejected by the emulator, standing in for
// a storage outage. Used to prove a failed delivery marks nothing complete.
const STORAGE_FAILS_FOR = 'u-storagefail';

const CASES = {
  sana:    { caseId: 'case-sana',    userId: 'u-sana' },
  mercy:   { caseId: 'case-mercy',   userId: 'u-mercy' },
  healthy: { caseId: 'case-healthy', userId: 'u-healthy' },
  broken:  { caseId: 'case-broken',  userId: STORAGE_FAILS_FOR }
};
const HEALTHY_PATH = 'users/u-healthy/gplink-delivered/section_g/current';

function freshDb() {
  return {
    user_profiles: Object.values(CASES).map((c) => ({ user_id: c.userId, first_name: 'GP', last_name: c.caseId })),
    registration_cases: Object.values(CASES).map((c) => ({
      id: c.caseId, user_id: c.userId, status: 'active', google_drive_folder_id: null
    })),
    registration_tasks: [
      { id: 't-sana', case_id: CASES.sana.caseId, task_type: 'practice_pack_child', related_document_key: 'section_g', status: 'deferred' },
      { id: 't-mercy', case_id: CASES.mercy.caseId, task_type: 'practice_pack_child', related_document_key: 'section_g', status: 'deferred' },
      { id: 't-healthy', case_id: CASES.healthy.caseId, task_type: 'practice_pack_child', related_document_key: 'section_g', status: 'completed' },
      { id: 't-broken', case_id: CASES.broken.caseId, task_type: 'practice_pack_child', related_document_key: 'section_g', status: 'deferred' }
    ],
    user_documents: [
      // Sana's exact live shape: approved, named, and pointing at nothing.
      {
        id: 'ud-sana', user_id: CASES.sana.userId, document_key: 'section_g', country_code: 'uk',
        status: 'approved', file_name: 'Section G.pdf', file_url: '', storage_path: null,
        file_size: 0, mime_type: '', google_drive_file_id: ''
      },
      // Already delivered properly — must be left untouched.
      {
        id: 'ud-healthy', user_id: CASES.healthy.userId, document_key: 'section_g', country_code: 'uk',
        status: 'approved', file_name: 'Section G.pdf', file_url: HEALTHY_PATH, storage_path: HEALTHY_PATH,
        file_size: 4242, mime_type: 'application/pdf', google_drive_file_id: ''
      }
      // Mercy: no row at all, on purpose.
    ],
    practice_doc_ops: [
      { case_id: CASES.sana.caseId, document_key: 'section_g', ops_status: 'completed' },
      { case_id: CASES.mercy.caseId, document_key: 'section_g', ops_status: 'not_requested' },
      { case_id: CASES.healthy.caseId, document_key: 'section_g', ops_status: 'completed' },
      { case_id: CASES.broken.caseId, document_key: 'section_g', ops_status: 'not_requested' }
    ],
    task_timeline: [],
    user_state: Object.values(CASES).map((c) => ({ user_id: c.userId, state: {} }))
  };
}

function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

function buildMatcher(params) {
  const filters = [];
  for (const [k, v] of params.entries()) {
    if (['select', 'limit', 'order', 'on_conflict'].includes(k)) continue;
    const mm = /^(eq|neq)\.(.*)$/s.exec(v);
    if (mm) { filters.push({ col: k, op: mm[1], val: mm[2] }); continue; }
    const inm = /^in\.\((.*)\)$/s.exec(v);
    if (inm) filters.push({ col: k, op: 'in', val: inm[1].split(',').map((x) => x.trim().replace(/^"|"$/g, '')) });
  }
  return (row) => filters.every((f) => {
    const cell = row ? row[f.col] : undefined;
    if (f.op === 'in') return f.val.includes(String(cell));
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

      // Raw object upload — the path deliverToMyDocuments now uses.
      const up = u.pathname.match(/^\/storage\/v1\/object\/(.+)$/);
      if (up && req.method === 'POST') {
        const key = decodeURIComponent(up[1]).split('/').map(decodeURIComponent).join('/');
        if (key.includes(STORAGE_FAILS_FOR)) { sendJson(500, { message: 'simulated storage outage' }); return; }
        storage.set(key, await readBody());
        sendJson(200, { Key: key });
        return;
      }
      if (up && req.method === 'GET') {
        const key = decodeURIComponent(up[1]).split('/').map(decodeURIComponent).join('/');
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
      sendJson(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function runCron() {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path: '/api/cron/reconcile-doc-tasks', method: 'GET',
      headers: { Authorization: 'Bearer ' + CRON_SECRET }
    }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const text = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: text });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

const docFor = (userId) => db.user_documents.find((d) => d.user_id === userId && d.document_key === 'section_g');
const taskById = (id) => db.registration_tasks.find((t) => t.id === id);
const opsFor = (caseId) => db.practice_doc_ops.find((o) => o.case_id === caseId && o.document_key === 'section_g');
// _logCaseEvent puts the marker in `title` with event_type 'system' — the same shape
// _hasCaseSystemEvent queries for.
const markerRows = (caseId) => db.task_timeline.filter((e) =>
  e.case_id === caseId && e.event_type === 'system' &&
  e.title === 'Section G auto-delivered to MyDocuments and Google Drive');

beforeAll(async () => {
  db = freshDb();
  storage.set(BUCKET + '/' + HEALTHY_PATH, Buffer.from('%PDF-1.4 already delivered', 'utf8'));
  await startEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'section-g-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.SUPABASE_DOCUMENT_BUCKET = BUCKET;
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.CRON_SECRET = CRON_SECRET;
  // Google Drive deliberately OFF. Before the fix this alone guaranteed that nothing
  // was ever delivered, because Drive was the only home for the bytes.
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = '';
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = '';
  delete process.env.ANTHROPIC_API_KEY;
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
});

describe('Section G — the hourly sweep repairs undelivered cases', () => {
  it('starts from the two real-world broken shapes', () => {
    // Guards the premise. If a fixture edit fills these in, the repair is no longer covered.
    expect(docFor(CASES.sana.userId).storage_path).toBeNull();
    expect(docFor(CASES.sana.userId).google_drive_file_id).toBe('');
    expect(docFor(CASES.mercy.userId)).toBeUndefined();
    expect(markerRows(CASES.sana.caseId).length).toBe(0);
  });

  it('the cron reports what it repaired', async () => {
    const res = await runCron();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // sana + mercy repaired; healthy skipped; broken storage counted as failed.
    expect(res.body.sectionG.repaired).toBe(2);
    expect(res.body.sectionG.failed).toBe(1);
  });

  it('fills in the approved-but-empty row (Sana) with real bytes', () => {
    const d = docFor(CASES.sana.userId);
    expect(d.storage_path).toBe('users/u-sana/gplink-delivered/section_g/current');
    expect(d.file_url).toBe(d.storage_path);
    expect(d.storage_bucket).toBe(BUCKET);
    expect(d.mime_type).toBe('application/pdf');
    expect(d.file_size).toBeGreaterThan(0);
    expect(d.status).toBe('approved');
    // And the bytes are genuinely in the bucket, not just referenced.
    expect(storage.get(BUCKET + '/' + d.storage_path).length).toBe(d.file_size);
  });

  it('creates the missing row entirely (Mercy) and completes her task', () => {
    const d = docFor(CASES.mercy.userId);
    expect(d).toBeTruthy();
    expect(d.status).toBe('approved');
    expect(d.file_name).toBe('Section G.pdf');
    expect(d.storage_path).toBe('users/u-mercy/gplink-delivered/section_g/current');
    expect(d.file_size).toBeGreaterThan(0);
    expect(taskById('t-mercy').status).toBe('completed');
    expect(opsFor(CASES.mercy.caseId).ops_status).toBe('completed');
  });

  it('writes the delivered marker exactly once per repaired case', () => {
    expect(markerRows(CASES.sana.caseId).length).toBe(1);
    expect(markerRows(CASES.mercy.caseId).length).toBe(1);
  });

  it('marks the GP-facing "ready" chip so My Documents shows it', () => {
    const st = db.user_state.find((s) => s.user_id === CASES.mercy.userId);
    const prepared = JSON.parse(st.state.gp_prepared_docs);
    expect(prepared.docs.section_g.ready).toBe(true);
    expect(prepared.docs.section_g.fileName).toBe('Section G.pdf');
  });

  // The whole point of the fix: Drive is off in this run, and delivery still succeeded.
  it('delivers with Google Drive unconfigured — Storage alone is enough', () => {
    expect(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL).toBe('');
    expect(docFor(CASES.mercy.userId).google_drive_file_id).toBeUndefined();
    expect(docFor(CASES.mercy.userId).file_size).toBeGreaterThan(0);
  });

  it('leaves an already-delivered case completely alone', () => {
    const d = docFor(CASES.healthy.userId);
    expect(d.id).toBe('ud-healthy');
    expect(d.file_size).toBe(4242);
    expect(d.storage_path).toBe(HEALTHY_PATH);
    expect(markerRows(CASES.healthy.caseId).length).toBe(0);
    // and only one row for that key — no duplicate delivery
    expect(db.user_documents.filter((x) => x.user_id === CASES.healthy.userId && x.document_key === 'section_g').length).toBe(1);
  });

  // Regression guard for the original defect.
  it('marks NOTHING complete when the bytes could not be stored', () => {
    expect(docFor(STORAGE_FAILS_FOR)).toBeUndefined();      // no approved-but-empty row
    expect(taskById('t-broken').status).toBe('deferred');   // task stays open
    expect(opsFor(CASES.broken.caseId).ops_status).toBe('not_requested');
    expect(markerRows(CASES.broken.caseId).length).toBe(0); // retryable next hour
  });

  it('is idempotent — a second run repairs nothing and duplicates nothing', async () => {
    const before = db.user_documents.length;
    const res = await runCron();
    expect(res.status).toBe(200);
    expect(res.body.sectionG.repaired).toBe(0);
    expect(db.user_documents.length).toBe(before);
    expect(markerRows(CASES.sana.caseId).length).toBe(1);
  });
});

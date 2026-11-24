// GET /api/practice-documents/download — the doctor's copy of a GP LINK-prepared
// practice document (SPPA-00, Section G, position description, offer/contract,
// supervisor CV, alternate supervisor CVs).
//
// Reported 24 Nov 2026 (Dr Hatice Akkas): on the AHPRA page "some of these files cannot
// be downloaded, and the others are corrupted". The page handed out raw Google Drive
// "/view" links: the ZIP builder cannot fetch() Drive's viewer page, and two of her files
// had never been shared, so Drive asked for a Google sign-in. Her certified copies are
// JPEG photos and the ZIP named every entry ".pdf". Covers the endpoint against the real
// server + an in-memory Supabase + a fake Drive client, and the page wiring.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-practice-dl-${RUN_ID}.json`);
let server, port, sbServer, sbPort, utils;

const GP = { userId: 'u-pd-gp-1', email: 'hatice@gplink-test.local' };
const GP2 = { userId: 'u-pd-gp-2', email: 'other@gplink-test.local' };
const PDF = Buffer.from('%PDF-1.4 position description', 'utf8');
const CV_PDF = Buffer.from('%PDF-1.4 supervisor cv', 'utf8');

let db;
function freshDb() {
  return {
    user_profiles: [
      { user_id: GP.userId, email: GP.email, first_name: 'Hatice' },
      { user_id: GP2.userId, email: GP2.email, first_name: 'Other' }
    ],
    user_documents: [
      // In our own storage (signed-URL redirect).
      { id: 'd1', user_id: GP.userId, country_code: 'uk', document_key: 'sppa_00', file_name: 'SPPA-00 Completed.pdf', mime_type: 'application/pdf', storage_path: 'users/u-pd-gp-1/gplink-delivered/sppa_00/current', google_drive_file_id: 'driveSppa000000' },
      // Drive only (the unshared file staff filed by hand).
      { id: 'd2', user_id: GP.userId, country_code: 'uk', document_key: 'position_description', file_name: '', mime_type: '', storage_path: null, google_drive_file_id: 'drivePosDesc0000' }
    ],
    user_state: [
      // supervisor_cv has no user_documents row — only the Drive link in state.
      { user_id: GP.userId, state: { gp_prepared_docs: JSON.stringify({ docs: { supervisor_cv: { url: 'https://drive.google.com/file/d/driveSupCv00000/view', fileName: 'Supervisor CV.pdf', ready: true } } }) } },
      { user_id: GP2.userId, state: {} }
    ]
  };
}
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

function buildMatcher(params) {
  const filters = [];
  for (const [k, v] of params.entries()) {
    if (['select', 'limit', 'order', 'on_conflict', 'offset'].includes(k)) continue;
    const mm = /^(eq|neq|in|is)\.(.*)$/s.exec(v);
    if (mm) filters.push({ col: k, op: mm[1], val: mm[2] });
  }
  return (row) => filters.every((f) => {
    const cell = row ? row[f.col] : undefined;
    if (f.op === 'eq') return String(cell) === String(f.val);
    if (f.op === 'neq') return String(cell) !== String(f.val);
    if (f.op === 'is') return f.val === 'null' ? (cell === null || cell === undefined) : String(cell) === f.val;
    if (f.op === 'in') return f.val.replace(/^\(/, '').replace(/\)$/, '').split(',').includes(String(cell));
    return true;
  });
}

function startEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      const chunks = []; req.on('data', (x) => chunks.push(x)); await new Promise((r) => req.on('end', r));
      if (u.pathname.startsWith('/storage/v1/object/sign/')) { send(200, { signedURL: '/object/sign/' + u.pathname.split('/').slice(5).join('/') + '?token=t' }); return; }
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const rows = tableOf(decodeURIComponent(m[1]));
      if (req.method === 'GET') {
        let out = rows.filter(buildMatcher(u.searchParams));
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out); return;
      }
      send(200, []);
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

const driveCalls = [];
const DRIVE_FILES = {
  drivePosDesc0000: { meta: { id: 'drivePosDesc0000', name: 'Position Description.pdf', mimeType: 'application/pdf' }, bytes: PDF },
  driveSupCv00000: { meta: { id: 'driveSupCv00000', name: 'Supervisor CV.pdf', mimeType: 'application/pdf' }, bytes: CV_PDF }
};
const fakeDrive = {
  files: {
    get: async (params) => {
      driveCalls.push(params);
      const f = DRIVE_FILES[params.fileId];
      if (!f) { const e = new Error('File not found'); e.code = 404; throw e; }
      if (params.alt === 'media') return { data: f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.length) };
      return { data: f.meta };
    },
    export: async () => { throw new Error('not used'); }
  }
};

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function userCookie(who) {
  const payload = b64url(JSON.stringify({ userProfile: { email: who.email, supabaseUserId: who.userId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
function get(p, who) {
  return new Promise((resolve, reject) => {
    const headers = { Host: 'app.local' };
    if (who) headers.Cookie = userCookie(who);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(c) }));
    });
    r.on('error', reject); r.end();
  });
}
const DL = '/api/practice-documents/download?key=';

beforeAll(async () => {
  db = freshDb();
  await startEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'practice-dl-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.RESEND_API_KEY = '';
  process.env.DOUBLETICK_API_KEY = '';
  const mod = await import('../server.js');
  utils = mod.__testUtils || mod.default?.__testUtils;
  utils.setGoogleDriveClientForTests(fakeDrive);
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (utils) utils.setGoogleDriveClientForTests(null);
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch (e) {}
});

describe('GET /api/practice-documents/download', () => {
  it('needs a signed-in doctor', async () => {
    const r = await get(DL + 'sppa_00', null);
    expect(r.status).toBe(401);
  });

  it('refuses anything that is not a practice document key', async () => {
    for (const k of ['mrcgp_certified', 'identity', '../etc', 'alt_supervisor_cv_x']) {
      const r = await get(DL + encodeURIComponent(k), GP);
      expect(r.status).toBe(400);
    }
  });

  it('redirects to a signed URL when we hold our own storage copy (no Drive call)', async () => {
    driveCalls.length = 0;
    const r = await get(DL + 'sppa_00', GP);
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain('/object/sign/');
    expect(r.headers.location).toContain('sppa_00');
    expect(driveCalls).toEqual([]);
  });

  it('streams a Drive-only file through the service account (works even when the file is unshared)', async () => {
    const r = await get(DL + 'position_description', GP);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toBe('attachment; filename="Position Description.pdf"');
    expect(r.buf.equals(PDF)).toBe(true);
  });

  it('falls back to the Drive link saved in the doctor\'s own state', async () => {
    const r = await get(DL + 'supervisor_cv', GP);
    expect(r.status).toBe(200);
    expect(r.buf.equals(CV_PDF)).toBe(true);
  });

  it('only ever serves the signed-in doctor\'s own files', async () => {
    driveCalls.length = 0;
    for (const k of ['sppa_00', 'position_description', 'supervisor_cv']) {
      const r = await get(DL + k, GP2);
      expect(r.status).toBe(404);
    }
    expect(driveCalls).toEqual([]);
  });

  it('404s a document that has not been prepared yet', async () => {
    const r = await get(DL + 'section_g', GP);
    expect(r.status).toBe(404);
  });
});

describe('page wiring', () => {
  const ahpra = fs.readFileSync(path.join(ROOT, 'pages/ahpra.html'), 'utf8');
  const myDocs = fs.readFileSync(path.join(ROOT, 'pages/my-documents.html'), 'utf8');

  it('the AHPRA download pack uses the endpoint, never the stored Drive link', () => {
    expect(ahpra).toContain('"/api/practice-documents/download?key=" + encodeURIComponent(key)');
    expect((ahpra.match(/practiceDocDownloadUrl\(/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(ahpra).not.toMatch(/downloadUrl: typeof item\.url === "string" \? item\.url/);
  });

  it('ZIP entries are named by the real file type, not always .pdf', () => {
    expect(ahpra).toMatch(/inferFileName\(row, i, contentType\)/);
    expect(ahpra).toMatch(/response\.headers\.get\("content-type"\)/);
  });

  it('My Documents practice-pack buttons use the endpoint', () => {
    expect(myDocs).toContain('/api/practice-documents/download?key=\' + encodeURIComponent(doc.key)');
    expect(myDocs).toContain('/api/practice-documents/download?key=\' + encodeURIComponent(cv.key)');
  });
});

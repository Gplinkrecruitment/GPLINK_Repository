// Staff open documents INSIDE the dashboard, never on drive.google.com.
//
// The bug this pins (Hazel, 2026-11-19). On an SPPA-00 card in the RSO dashboard, "View"
// was a new-tab link to https://drive.google.com/file/d/<id>/view. Google answers that
// page for whichever Google account the browser is signed in to; hers was a personal
// Gmail the file had never been shared with, so she got Google's "You need access" page
// on every document that had a Drive copy.
//
// Guarded here:
//   1. the server serves a task document's bytes to a signed-in member of staff — the
//      stored copy first, since the Drive copy is replaced in place and is not "this
//      version" for an older card;
//   2. it still refuses a doctor who is not theirs, and anyone not signed in;
//   3. a Drive file is only served when it sits under a doctor's case folder, and the
//      identity document stays CEO/ATS-only;
//   4. the dashboard page no longer links to, or embeds, Google Drive for viewing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const adminDocFile = require('../lib/admin-doc-file.js');

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-doc-view-${RUN_ID}.json`);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let server, port, sbServer, sbPort;

const HAZEL = { email: 'hazel@gplink-test.local', user_id: 'rso-hazel' };
const OTHER = { email: 'other@gplink-test.local', user_id: 'rso-other' };
const PDF_V1 = Buffer.from('%PDF-1.4 version one, the previous version', 'utf8');
const PDF_V2 = Buffer.from('%PDF-1.4 version two ?>~ bytes that need url-safe base64 \xff\xfe\xfb', 'latin1');
const dataUrl = (buf) => 'data:application/pdf;base64,' + buf.toString('base64');
const urlSafeDataUrl = (buf) => 'data:application/pdf;base64,' + buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const db = {
  rso_team: [
    { email: HAZEL.email, user_id: HAZEL.user_id, name: 'Hazel', active: true },
    { email: OTHER.email, user_id: OTHER.user_id, name: 'Other', active: true }
  ],
  registration_cases: [
    { id: 'case-hers', user_id: 'u-hers', assigned_rso: HAZEL.user_id, google_drive_folder_id: 'folderHers0001' },
    { id: 'case-theirs', user_id: 'u-theirs', assigned_rso: OTHER.user_id, google_drive_folder_id: 'folderTheirs01' }
  ],
  registration_tasks: [
    { id: 't-hers', case_id: 'case-hers', task_type: 'practice_pack_child', related_document_key: 'sppa_00', status: 'in_progress' },
    { id: 't-theirs', case_id: 'case-theirs', task_type: 'practice_pack_child', related_document_key: 'sppa_00', status: 'in_progress' }
  ],
  task_documents: [
    // The shape that sent Hazel to Google: a stored copy AND a Drive link on the same row.
    { id: 'td-prev', task_id: 't-hers', case_id: 'case-hers', filename: 'SPPA-00.pdf', mime_type: 'application/pdf', is_current: false,
      attachment_url: dataUrl(PDF_V1), google_drive_file_id: 'driveFileSppa0001', google_drive_url: 'https://drive.google.com/file/d/driveFileSppa0001/view' },
    { id: 'td-current', task_id: 't-hers', case_id: 'case-hers', filename: 'SPPA-00 "Supervised" Practice Plan.pdf', mime_type: 'application/pdf', is_current: true,
      attachment_url: urlSafeDataUrl(PDF_V2), google_drive_file_id: 'driveFileSppa0001', google_drive_url: 'https://drive.google.com/file/d/driveFileSppa0001/view' },
    { id: 'td-theirs', task_id: 't-theirs', case_id: 'case-theirs', filename: 'SPPA-00.pdf', mime_type: 'application/pdf', is_current: true, attachment_url: dataUrl(PDF_V1) },
    { id: 'td-html', task_id: 't-hers', case_id: 'case-hers', filename: 'note.html', mime_type: 'text/html', is_current: true,
      attachment_url: 'data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64') },
    { id: 'td-nothing', task_id: 't-hers', case_id: 'case-hers', filename: 'gone.pdf', mime_type: 'application/pdf', is_current: true, attachment_url: null }
  ]
};

function buildMatcher(params) {
  const filters = [];
  for (const [k, v] of params.entries()) {
    if (['select', 'limit', 'order', 'on_conflict'].includes(k)) continue;
    const mm = /^(eq|neq)\.(.*)$/s.exec(v);
    if (mm) filters.push({ col: k, op: mm[1], val: mm[2] });
  }
  return (row) => filters.every((f) => {
    const eq = String(row ? row[f.col] : undefined) === String(f.val);
    return f.op === 'eq' ? eq : !eq;
  });
}
function startEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const sendJson = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m || req.method !== 'GET') { sendJson(404, { message: 'not found' }); return; }
      let out = (db[decodeURIComponent(m[1])] || []).filter(buildMatcher(u.searchParams));
      const limit = parseInt(u.searchParams.get('limit') || '', 10);
      if (Number.isFinite(limit)) out = out.slice(0, limit);
      sendJson(200, out);
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function cookieFor(email, adminRole) {
  const payload = Buffer.from(JSON.stringify({ userProfile: { email, adminRole }, expiresAt: Date.now() + 3600000 }), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function get(p, cookie) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { const buf = Buffer.concat(c); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch {} resolve({ status: res.statusCode, headers: res.headers, buf, json }); });
    });
    r.on('error', reject);
    r.end();
  });
}

beforeAll(async () => {
  await startEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'doc-view-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  delete process.env.ANTHROPIC_API_KEY;
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
});

describe('GET /api/admin/task-document/file', () => {
  it('gives the RSO the stored file for her own doctor, with no Google involved', async () => {
    const r = await get('/api/admin/task-document/file?id=td-prev', cookieFor(HAZEL.email, 'admin'));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toMatch(/^inline;/);
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.buf.equals(PDF_V1)).toBe(true);
  });

  it('serves THIS version, not whatever the shared Drive file now holds', async () => {
    // Both rows point at the same Drive file; each must return its own stored bytes.
    const cur = await get('/api/admin/task-document/file?id=td-current', cookieFor(HAZEL.email, 'admin'));
    expect(cur.status).toBe(200);
    // …and a URL-safe base64 attachment is decoded whole, not truncated.
    expect(cur.buf.equals(PDF_V2)).toBe(true);
    // A quote in the filename cannot break out of the header.
    expect(cur.headers['content-disposition']).toBe('inline; filename="SPPA-00 Supervised Practice Plan.pdf"');
  });

  it('refuses a doctor assigned to someone else', async () => {
    const r = await get('/api/admin/task-document/file?id=td-theirs', cookieFor(HAZEL.email, 'admin'));
    expect(r.status).toBe(403);
    expect(r.buf.includes(PDF_V1)).toBe(false);
  });

  it('lets a super admin open any doctor\'s document', async () => {
    const r = await get('/api/admin/task-document/file?id=td-theirs', cookieFor('ceo@gplink-test.local', 'super_admin'));
    expect(r.status).toBe(200);
    expect(r.buf.equals(PDF_V1)).toBe(true);
  });

  it('refuses anyone who is not signed in', async () => {
    const r = await get('/api/admin/task-document/file?id=td-prev', null);
    expect([401, 403]).toContain(r.status);
    expect(r.buf.includes(PDF_V1)).toBe(false);
  });

  it('never serves stored HTML as a page on the dashboard origin', async () => {
    const r = await get('/api/admin/task-document/file?id=td-html', cookieFor(HAZEL.email, 'admin'));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('says so plainly when nothing is stored, and for an unknown id', async () => {
    const none = await get('/api/admin/task-document/file?id=td-nothing', cookieFor(HAZEL.email, 'admin'));
    expect(none.status).toBe(404);
    expect(none.json.message).toMatch(/No file is stored/);
    const unknown = await get('/api/admin/task-document/file?id=nope', cookieFor(HAZEL.email, 'admin'));
    expect(unknown.status).toBe(404);
    const missing = await get('/api/admin/task-document/file', cookieFor(HAZEL.email, 'admin'));
    expect(missing.status).toBe(400);
  });
});

describe('GET /api/admin/drive/file', () => {
  it('needs a sign-in and a real file reference', async () => {
    const anon = await get('/api/admin/drive/file?file_id=driveFileSppa0001', null);
    expect([401, 403]).toContain(anon.status);
    const bad = await get('/api/admin/drive/file?file_id=../../etc', cookieFor(HAZEL.email, 'admin'));
    expect(bad.status).toBe(400);
  });
});

// A stand-in for the Drive API: a tree of files and folders.
function fakeDrive(nodes) {
  const calls = { media: [], exported: [] };
  return {
    calls,
    files: {
      get: async (params) => {
        const n = nodes[params.fileId];
        if (!n) throw new Error('File not found: ' + params.fileId);
        if (params.alt === 'media') { calls.media.push(params.fileId); return { data: n.bytes }; }
        return { data: { id: params.fileId, name: n.name, mimeType: n.mimeType, parents: n.parents || [] } };
      },
      export: async (params) => { calls.exported.push(params.fileId); return { data: Buffer.from('%PDF exported') }; }
    }
  };
}
const FOLDER = adminDocFile.FOLDER_MIME;
const TREE = {
  root: { name: 'GP Link', mimeType: FOLDER, parents: [] },
  folderHers0001: { name: 'Dr Hatice Test', mimeType: FOLDER, parents: ['root'] },
  subSppa: { name: 'SPPA-00', mimeType: FOLDER, parents: ['folderHers0001'] },
  subId: { name: 'ID', mimeType: FOLDER, parents: ['folderHers0001'] },
  fileTop: { name: 'Contract.pdf', mimeType: 'application/pdf', parents: ['folderHers0001'], bytes: Buffer.from('%PDF top') },
  fileSppa: { name: 'SPPA-00 (Completed).pdf', mimeType: 'application/pdf', parents: ['subSppa'], bytes: Buffer.from('%PDF sppa') },
  filePassport: { name: 'passport.jpg', mimeType: 'image/jpeg', parents: ['subId'], bytes: Buffer.from('jpg') },
  fileIdNamed: { name: 'ID — passport.jpg', mimeType: 'image/jpeg', parents: ['folderHers0001'], bytes: Buffer.from('jpg') },
  fileElsewhere: { name: 'Payroll.xlsx', mimeType: 'application/vnd.ms-excel', parents: ['root'], bytes: Buffer.from('x') },
  gdoc: { name: 'Notes', mimeType: 'application/vnd.google-apps.document', parents: ['folderHers0001'] }
};
const findCase = async (ids) => (ids.includes('folderHers0001') ? { id: 'case-hers', assigned_rso: HAZEL.user_id } : null);

describe('which doctor a Drive file belongs to', () => {
  it('finds the case for a file sitting directly in the case folder', async () => {
    const tree = { ...TREE, fileTopLong001: TREE.fileTop };
    const top = await adminDocFile.resolveDriveFileOwner(fakeDrive(tree), 'fileTopLong001', findCase);
    expect(top.ok).toBe(true);
    expect(top.caseRow.id).toBe('case-hers');
    expect(top.meta.name).toBe('Contract.pdf');
  });

  it('walks up through the subfolder to the case folder', async () => {
    const tree = { ...TREE, fileSppaLong01: TREE.fileSppa };
    const sub = await adminDocFile.resolveDriveFileOwner(fakeDrive(tree), 'fileSppaLong01', findCase);
    expect(sub.ok).toBe(true);
    expect(sub.caseRow.id).toBe('case-hers');
    expect(sub.folderNames).toContain('SPPA-00');
  });

  it('refuses a file that is not under any doctor, however valid its id', async () => {
    const tree = { ...TREE, fileElsewhere1: TREE.fileElsewhere };
    const r = await adminDocFile.resolveDriveFileOwner(fakeDrive(tree), 'fileElsewhere1', findCase);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
  });

  it('refuses a folder, an unknown file and a malformed id', async () => {
    expect((await adminDocFile.resolveDriveFileOwner(fakeDrive(TREE), 'folderHers0001', findCase)).status).toBe(400);
    expect((await adminDocFile.resolveDriveFileOwner(fakeDrive(TREE), 'doesNotExist01', findCase)).status).toBe(404);
    expect((await adminDocFile.resolveDriveFileOwner(fakeDrive(TREE), "x' or '1'='1", findCase)).status).toBe(400);
    expect((await adminDocFile.resolveDriveFileOwner(null, 'fileTopLong001', findCase)).status).toBe(503);
  });

  it('marks the identity document by name and by its ID subfolder', async () => {
    const tree = { ...TREE, filePassport01: TREE.filePassport, fileIdNamed001: TREE.fileIdNamed, fileSppaLong01: TREE.fileSppa };
    const inFolder = await adminDocFile.resolveDriveFileOwner(fakeDrive(tree), 'filePassport01', findCase);
    expect(adminDocFile.isIdentityDriveFile(inFolder.meta, inFolder.folderNames, 'ID')).toBe(true);
    const byName = await adminDocFile.resolveDriveFileOwner(fakeDrive(tree), 'fileIdNamed001', findCase);
    expect(adminDocFile.isIdentityDriveFile(byName.meta, byName.folderNames, 'ID')).toBe(true);
    const ordinary = await adminDocFile.resolveDriveFileOwner(fakeDrive(tree), 'fileSppaLong01', findCase);
    expect(adminDocFile.isIdentityDriveFile(ordinary.meta, ordinary.folderNames, 'ID')).toBe(false);
  });

  it('downloads a real file as itself and exports a Google Doc as PDF', async () => {
    const drive = fakeDrive(TREE);
    const pdf = await adminDocFile.downloadDriveFile(drive, { id: 'fileTop', name: 'Contract.pdf', mimeType: 'application/pdf' });
    expect(pdf.buffer.toString()).toBe('%PDF top');
    expect(pdf.mimeType).toBe('application/pdf');
    const doc = await adminDocFile.downloadDriveFile(drive, { id: 'gdoc', name: 'Notes', mimeType: 'application/vnd.google-apps.document' });
    expect(doc.mimeType).toBe('application/pdf');
    expect(doc.filename).toBe('Notes.pdf');
    expect(drive.calls.exported).toEqual(['gdoc']);
  });
});

describe('small helpers', () => {
  it('reads the file id out of a Drive link, and nothing out of a folder or foreign link', () => {
    expect(adminDocFile.driveFileIdFromUrl('https://drive.google.com/file/d/1xgIJ88aReoJp0DybD1XgDpCeLchwHWuh/view')).toBe('1xgIJ88aReoJp0DybD1XgDpCeLchwHWuh');
    expect(adminDocFile.driveFileIdFromUrl('https://drive.google.com/open?id=1xgIJ88aReoJp0DybD1Xg')).toBe('1xgIJ88aReoJp0DybD1Xg');
    expect(adminDocFile.driveFileIdFromUrl('https://docs.google.com/document/d/1xgIJ88aReoJp0DybD1Xg/edit')).toBe('1xgIJ88aReoJp0DybD1Xg');
    expect(adminDocFile.driveFileIdFromUrl('https://drive.google.com/drive/folders/1xgIJ88aReoJp0DybD1Xg')).toBe('');
    expect(adminDocFile.driveFileIdFromUrl('https://evil.example/file/d/1xgIJ88aReoJp0DybD1Xg/view')).toBe('');
    expect(adminDocFile.driveFileIdFromUrl('data:application/pdf;base64,AAAA')).toBe('');
    expect(adminDocFile.driveFileIdFromUrl('')).toBe('');
  });

  it('only serves viewable types as themselves', () => {
    expect(adminDocFile.safeServedMime('application/pdf')).toBe('application/pdf');
    expect(adminDocFile.safeServedMime('image/jpeg; charset=binary')).toBe('image/jpeg');
    expect(adminDocFile.safeServedMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(adminDocFile.safeServedMime('text/html')).toBe('application/octet-stream');
    expect(adminDocFile.safeServedMime('image/svg+xml')).toBe('application/octet-stream');
  });

  it('does not treat a plain link or an empty value as stored bytes', () => {
    expect(adminDocFile.decodeDataUrl('https://drive.google.com/file/d/abc/view')).toBe(null);
    expect(adminDocFile.decodeDataUrl(null)).toBe(null);
    expect(adminDocFile.decodeDataUrl('data:application/pdf;base64,')).toBe(null);
  });
});

describe('the RSO dashboard page', () => {
  const page = fs.readFileSync(path.join(ROOT, 'pages', 'admin.html'), 'utf8');

  it('never builds a Google Drive preview frame', () => {
    expect(page).not.toMatch(/drive\.google\.com\/file\/d\/["']\s*\+[^;]*\+\s*["']\/preview/);
    expect(page).not.toMatch(/replace\(\s*['"]\/view['"]\s*,\s*['"]\/preview['"]\s*\)/);
  });

  it('opens a task document card in the dashboard, preferring the stored copy', () => {
    const start = page.indexOf('function opsRenderDocs(');
    const fn = page.slice(start, page.indexOf('\n  }\n', start));
    expect(fn).toContain('d.attachment_url||d.google_drive_url');
    expect(fn).not.toContain('d.google_drive_url||d.attachment_url');
    // A Drive link becomes a button handled in-page, not an <a target="_blank">.
    expect(fn).toMatch(/isDriveUrl\(previewUrl\)\)\)\{\s*h\+='<button data-preview-doc=/);
  });

  it('routes a stored Drive link through the server instead of embedding it', () => {
    const start = page.indexOf('function openDocPreviewModal(');
    const fn = page.slice(start, start + 1200);
    expect(fn).toContain('taskDocFileUrl(docId)');
    expect(fn).toContain('driveFileUrl(_dFid)');
    expect(page).toContain("'/api/admin/task-document/file?id='");
    expect(page).toContain("'/api/admin/drive/file?file_id='");
  });

  it('opens Drive-folder cards through the server too', () => {
    const start = page.indexOf('const dpc=e.target.closest("[data-drive-preview]")');
    const block = page.slice(start, start + 900);
    expect(block).toContain('openDocInApp(driveFileUrl(fileId)');
    expect(block).not.toContain('<iframe');
  });
});

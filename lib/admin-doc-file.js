// Serving a document to staff from INSIDE the dashboard.
//
// Why this exists (Hazel, 2026-11-19). The RSO dashboard's "View" links pointed at
// https://drive.google.com/file/d/<id>/view. Google decides who may open that page from
// whichever Google account the browser happens to be signed in to — nothing to do with
// the dashboard login — and the files are owned by the app's service account and shared
// only with named @mygplink.com.au addresses. An RSO whose browser was signed in to a
// personal Gmail got Google's "You need access" page instead of the document.
//
// The dashboard already knows who the member of staff is and which doctors they may see.
// So the server fetches the bytes itself (it holds the Drive credentials) and streams
// them to the dashboard, which shows them in its own viewer. No Google sign-in is
// involved, so there is no Google gate to meet.
//
// Everything here is pure or takes the Drive client as an argument, so it can be tested
// without Google.

'use strict';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';
// How far up the folder tree to look for the doctor's case folder. Files live in the
// case folder or one per-document subfolder below it; the extra levels are slack.
const MAX_PARENT_DEPTH = 5;

// The Drive file id inside a Drive link, or '' when the string is not a Drive file link.
// A folder link (/drive/folders/…) deliberately yields '' — a folder is not a document.
function driveFileIdFromUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  let host = '';
  let parsed = null;
  try { parsed = new URL(s); host = parsed.hostname; } catch (e) { return ''; }
  if (!(host === 'drive.google.com' || host === 'docs.google.com')) return '';
  const m = parsed.pathname.match(/\/(?:file|document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  if (/^\/(open|uc)$/.test(parsed.pathname)) {
    const id = parsed.searchParams.get('id') || '';
    return /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : '';
  }
  return '';
}

function isDriveFileId(id) {
  return /^[A-Za-z0-9_-]{10,200}$/.test(String(id || ''));
}

// data: URL → bytes. Stored attachments are sometimes URL-safe base64 ('-' and '_');
// decoding that as standard base64 silently returns a short, corrupt file, so translate
// first. Returns null for anything that is not a base64 data URL.
function decodeDataUrl(dataUrl) {
  const raw = String(dataUrl || '');
  if (raw.slice(0, 5) !== 'data:') return null;
  const comma = raw.indexOf(',');
  if (comma < 0) return null;
  const head = raw.slice(5, comma);
  if (!/;base64$/i.test(head)) return null;
  const mimeType = head.replace(/;base64$/i, '').split(';')[0].trim() || 'application/octet-stream';
  let b64 = raw.slice(comma + 1).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  let buffer;
  try { buffer = Buffer.from(b64, 'base64'); } catch (e) { return null; }
  if (!buffer.length) return null;
  return { buffer, mimeType };
}

// A filename that is safe inside a quoted Content-Disposition value.
function safeInlineFilename(name, fallback) {
  const cleaned = String(name || '').replace(/[\r\n"\\]/g, '').replace(/[^\x20-\x7E]/g, '_').trim();
  return (cleaned || fallback || 'document').slice(0, 180);
}

// Only these types are handed to the browser as themselves. Anything else (notably
// text/html or SVG, which would run as a page on the dashboard's own origin) is sent as
// a plain download type instead.
const INLINE_SAFE = /^(application\/pdf|image\/(png|jpe?g|gif|webp|heic|heif|bmp|tiff)|text\/plain|text\/csv|application\/(msword|rtf|zip|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.[a-z.]+))$/i;
function safeServedMime(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  return INLINE_SAFE.test(m) ? m : 'application/octet-stream';
}

// The onboarding identity document is CEO/ATS-only and must never reach an RSO. On Drive
// it is recognisable two ways: its name starts "ID — ", and it sits in the "ID" subfolder.
function isIdentityDriveFile(meta, parentFolderNames, idFolderName) {
  if (/^ID\s[—–-]\s/.test(String((meta && meta.name) || ''))) return true;
  const want = String(idFolderName || 'ID').trim().toLowerCase();
  return (parentFolderNames || []).some((n) => String(n || '').trim().toLowerCase() === want);
}

// Which doctor does this Drive file belong to?
// Walks up from the file through its parent folders until one of them is a case folder
// (registration_cases.google_drive_folder_id). `findCaseByFolderIds(ids)` returns the
// matching case row or null. A file that is not under any case folder belongs to nobody
// the dashboard knows about, and is refused — the service account can read more of Drive
// than any one member of staff should, so "the id is valid" is never enough.
//
// Resolves { ok:true, meta, caseRow, folderNames } or { ok:false, status, message }.
async function resolveDriveFileOwner(drive, fileId, findCaseByFolderIds) {
  if (!drive) return { ok: false, status: 503, message: 'Document storage is not available right now.' };
  if (!isDriveFileId(fileId)) return { ok: false, status: 400, message: 'That is not a valid file reference.' };
  let meta;
  try {
    const r = await drive.files.get({ fileId, fields: 'id,name,mimeType,size,parents,trashed', supportsAllDrives: true });
    meta = r && r.data;
  } catch (e) {
    return { ok: false, status: 404, message: 'That file could not be found in document storage.' };
  }
  if (!meta || !meta.id) return { ok: false, status: 404, message: 'That file could not be found in document storage.' };
  if (meta.mimeType === FOLDER_MIME) return { ok: false, status: 400, message: 'That is a folder, not a document.' };

  const folderNames = [];
  let parents = Array.isArray(meta.parents) ? meta.parents.slice() : [];
  for (let depth = 0; depth < MAX_PARENT_DEPTH && parents.length; depth++) {
    const caseRow = await findCaseByFolderIds(parents);
    if (caseRow) return { ok: true, meta, caseRow, folderNames };
    const next = [];
    for (const pid of parents) {
      try {
        const pr = await drive.files.get({ fileId: pid, fields: 'id,name,parents', supportsAllDrives: true });
        if (pr && pr.data) {
          folderNames.push(pr.data.name || '');
          (pr.data.parents || []).forEach((x) => next.push(x));
        }
      } catch (e) { /* a parent we cannot read is simply not a route to a case */ }
    }
    parents = next;
  }
  return { ok: false, status: 404, message: 'That file is not filed under a doctor.' };
}

// The file's bytes. Google-native files (Docs, Sheets, Slides) have no bytes of their
// own, so they are exported as PDF, which the viewer can show.
async function downloadDriveFile(drive, meta) {
  const mime = String((meta && meta.mimeType) || '');
  if (mime.indexOf(GOOGLE_NATIVE_PREFIX) === 0) {
    const ex = await drive.files.export({ fileId: meta.id, mimeType: 'application/pdf' }, { responseType: 'arraybuffer' });
    return { buffer: Buffer.from(ex.data), mimeType: 'application/pdf', filename: (meta.name || 'document') + '.pdf' };
  }
  const r = await drive.files.get({ fileId: meta.id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(r.data), mimeType: mime || 'application/octet-stream', filename: meta.name || 'document' };
}

module.exports = {
  FOLDER_MIME,
  driveFileIdFromUrl,
  isDriveFileId,
  decodeDataUrl,
  safeInlineFilename,
  safeServedMime,
  isIdentityDriveFile,
  resolveDriveFileOwner,
  downloadDriveFile
};

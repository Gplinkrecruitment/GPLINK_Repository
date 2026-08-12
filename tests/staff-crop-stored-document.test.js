/*
 * Cropping a document that is ALREADY on file, from the staff review modal.
 *
 * Driven against the REAL server, because this endpoint OVERWRITES a doctor's
 * stored document: getting the storage path wrong would silently write the crop
 * to the wrong object (or nowhere), and every reader afterwards — the reviewer's
 * preview, the AI scan, the pack that goes to AHPRA — reads that object.
 *
 * What is proven here:
 *   1. the crop lands on the SAME storage object the preview reads from;
 *   2. the original is kept, once, alongside it;
 *   3. the cached AI verdict is dropped (it judged the old picture) and the rest
 *      of the task's metadata survives;
 *   4. the document's review status/name/file name are untouched;
 *   5. the bytes are proven to be the image type they claim, and a PDF is refused;
 *   6. it is closed to anyone without an admin session.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-staff-crop-${RUN_ID}.json`);
let server, port, sbServer, sbPort;

const GP = { userId: 'u-crop-1', email: 'crop-gp@gplink-test.local' };
const SUPER_EMAIL = 'super-crop@gplink-test.local';
const NOW = new Date().toISOString();
const DOC_PATH = 'users/u-crop-1/onboarding/uk/onboarding_cct_certificate';

// Real 1x1 images, so the magic-byte checks on both sides are real checks.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNCwsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDs0NDT/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmgA/9k=';
const CROPPED_JPEG_DATA_URL = 'data:image/jpeg;base64,' + JPEG_B64;

const db = {
  user_profiles: [{ user_id: GP.userId, email: GP.email, first_name: 'Ada', last_name: 'Crop', registration_country: 'uk' }],
  registration_cases: [{ id: 'case-crop-1', user_id: GP.userId, status: 'active', stage: 'onboarding' }],
  registration_tasks: [
    {
      id: 't-crop-stored', case_id: 'case-crop-1', task_type: 'flagged_doc', status: 'open',
      related_stage: 'onboarding', related_document_key: 'cct_certificate',
      title: 'Review flagged qualification: CCT Certificate', created_at: NOW,
      // A cached verdict on the UNCROPPED picture, plus something else that must survive.
      metadata: { ai_scan: { scan: { documentType: 'CCT' }, scanned_at: NOW }, keep_me: 'yes' }
    },
    {
      id: 't-crop-attach', case_id: 'case-crop-1', task_type: 'flagged_doc', status: 'open',
      related_document_key: 'other_doc', title: 'Review flagged document', created_at: NOW,
      attachment_url: 'data:image/png;base64,' + PNG_B64, attachment_filename: 'onthetask.png'
    }
  ],
  user_documents: [{
    id: 'd-crop-cct', user_id: GP.userId, document_key: 'cct_certificate',
    country_code: 'uk', status: 'under_review', file_name: 'cct.jpg', mime_type: 'image/png',
    file_size: 11, storage_path: DOC_PATH, updated_at: NOW, google_drive_file_id: ''
  }],
  user_roles: [], task_timeline: [], case_events: [], task_messages: [], runtime_kv: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

const storageCalls = []; // every storage request the server makes

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'not'];
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue;
    filters.push({ col: key, op, val: raw.slice(dot + 1) });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
    if (op === 'neq') return String(cell) !== val;
    if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    if (op === 'not') return val === 'is.null' ? !(cell === null || cell === undefined) : true;
    return true;
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function startSupabaseEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (u.pathname.startsWith('/storage/v1/')) {
        const objectPath = decodeURIComponent(u.pathname.replace(/^\/storage\/v1\/object\//, ''));
        const raw = await readBody(req);
        storageCalls.push({ method: req.method, objectPath: objectPath, bytes: raw.length, contentType: req.headers['content-type'] || '' });
        if (req.method === 'GET') {
          // The document as it stands today — a PNG, so the backup copy is real bytes.
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(Buffer.from(PNG_B64, 'base64'));
          return;
        }
        send(200, { Key: 'ok' });
        return;
      }

      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const table = decodeURIComponent(m[1]);
      const rows = tableOf(table);
      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out);
        return;
      }
      const bodyRaw = await readBody(req);
      let body = null;
      try { body = JSON.parse(bodyRaw.toString('utf8') || 'null'); } catch { body = null; }
      if (req.method === 'POST') {
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const conflict = (u.searchParams.get('on_conflict') || '').split(',').map((s) => s.trim()).filter(Boolean);
        const saved = incoming.map((r) => {
          if (conflict.length) {
            const existing = rows.find((row) => conflict.every((c) => String(row[c]) === String(r[c])));
            if (existing) { Object.assign(existing, r); return existing; }
          }
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          rows.push(row);
          return row;
        });
        send(201, saved);
        return;
      }
      if (req.method === 'PATCH') {
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, body || {}));
        send(200, matched);
        return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function mkAdminCookie(email, adminRole) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}

function postJson(p, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(c).toString('utf8')); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'staff-crop-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = '';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

const adminCookie = () => mkAdminCookie(SUPER_EMAIL, 'super_admin');

describe('POST /api/admin/va/task/crop-document', () => {
  it('writes the crop to the SAME object the reviewer previews, and keeps the original', async () => {
    storageCalls.length = 0;
    const r = await postJson('/api/admin/va/task/crop-document',
      { task_id: 't-crop-stored', fileDataUrl: CROPPED_JPEG_DATA_URL }, adminCookie());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const uploads = storageCalls.filter((c) => c.method === 'POST');
    const toRealPath = uploads.filter((c) => c.objectPath.endsWith(DOC_PATH));
    const backups = uploads.filter((c) => /\.precrop-\d{14}$/.test(c.objectPath));
    // The document itself was replaced...
    expect(toRealPath).toHaveLength(1);
    expect(toRealPath[0].contentType).toBe('image/jpeg');
    // ...and the original was kept beside it, exactly once.
    expect(backups).toHaveLength(1);
    expect(backups[0].objectPath).toContain(DOC_PATH + '.precrop-');
    // The backup was written BEFORE the overwrite — order matters if either fails.
    expect(uploads.indexOf(backups[0])).toBeLessThan(uploads.indexOf(toRealPath[0]));
  });

  it('records what is now stored without touching the review decision', async () => {
    const row = db.user_documents.find((d) => d.id === 'd-crop-cct');
    expect(row.mime_type).toBe('image/jpeg');
    expect(row.file_size).toBeGreaterThan(0);
    // Untouched: cropping changes the picture, not the decision.
    expect(row.status).toBe('under_review');
    expect(row.file_name).toBe('cct.jpg');
    expect(row.document_key).toBe('cct_certificate');
  });

  it('drops the AI verdict that judged the old picture, keeping the rest of the metadata', async () => {
    const task = db.registration_tasks.find((t) => t.id === 't-crop-stored');
    expect(task.metadata.ai_scan).toBeUndefined();
    expect(task.metadata.keep_me).toBe('yes'); // merged, not blown away
    expect(task.status).toBe('open');
  });

  it('handles a document stored on the task itself', async () => {
    const r = await postJson('/api/admin/va/task/crop-document',
      { task_id: 't-crop-attach', fileDataUrl: CROPPED_JPEG_DATA_URL }, adminCookie());
    expect(r.status).toBe(200);
    const task = db.registration_tasks.find((t) => t.id === 't-crop-attach');
    expect(task.attachment_url).toBe(CROPPED_JPEG_DATA_URL);
    expect(task.attachment_filename).toBe('onthetask.png'); // the name is left alone
  });

  it('refuses a PDF — a crop is only ever an image', async () => {
    const r = await postJson('/api/admin/va/task/crop-document',
      { task_id: 't-crop-stored', fileDataUrl: 'data:application/pdf;base64,JVBERi0xLjQK' }, adminCookie());
    expect(r.status).toBe(422);
  });

  it('refuses bytes that lie about being a JPEG', async () => {
    const r = await postJson('/api/admin/va/task/crop-document',
      { task_id: 't-crop-stored', fileDataUrl: 'data:image/jpeg;base64,' + PNG_B64 }, adminCookie());
    expect(r.status).toBe(422);
  });

  it('refuses an empty or unreadable payload', async () => {
    const r = await postJson('/api/admin/va/task/crop-document',
      { task_id: 't-crop-stored', fileDataUrl: 'not-a-data-url' }, adminCookie());
    expect(r.status).toBe(400);
  });

  it('is closed without an admin session', async () => {
    const r = await postJson('/api/admin/va/task/crop-document',
      { task_id: 't-crop-stored', fileDataUrl: CROPPED_JPEG_DATA_URL }, null);
    expect([401, 403]).toContain(r.status);
  });

  it('does not write anything for a task that does not exist', async () => {
    storageCalls.length = 0;
    const r = await postJson('/api/admin/va/task/crop-document',
      { task_id: 'no-such-task', fileDataUrl: CROPPED_JPEG_DATA_URL }, adminCookie());
    expect([403, 404]).toContain(r.status);
    expect(storageCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

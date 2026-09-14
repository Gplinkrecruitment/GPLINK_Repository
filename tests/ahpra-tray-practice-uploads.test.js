// AHPRA review tray: "Practice uploads" routing, the Who/How change that used to lose the
// "What the GP will see" preview, and the practice request/reply flow — end to end against the
// real server with an in-memory Supabase (REST + a storage stub).
//
// Background (Dr Mercy Obanimoh, 2026-09-14): the tray's Who/How dropdowns saved a
// metadata_merge computed from the SIBLING dropdown on screen, then ran a full loadAll() that
// first re-painted the OLD data. A change made in that window stored owner=team + mode=upload —
// a pair the renderer treats as "team", so the GP preview vanished and never came back even
// after the RSO put the item back. There was also no way to route an item to the practice
// (an updated supervisor CV can only come from the practice), and the officer's letter asked
// for the same resubmitted CV twice (gaps + English-language evidence) as two separate tasks.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ahpra-tray-${RUN_ID}.json`);
let server, port, sbServer, sbPort;

const SUPER_HOST = 'ceo-tray.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const GP = { userId: 'u-gp-tray-1', email: 'gp-tray@gplink-test.local' };
const CASE_ID = 'case-tray-1';
const NOW = new Date().toISOString();
const BUNDLE = 's80_msg_tray_1';

const T = { cv: 't-cv', sup: 't-sup-cv', cogs: 't-cogs', released: 't-released-gp' };

function s80Meta(extra) {
  return Object.assign({
    s80: true, bundle_id: BUNDLE, reference: '14805868', review_status: 'pending_review', released_at: null,
    detail: 'officer words', team_instructions: 'team words', sub_items: [], institution: '', how_to_steps: [],
    officer: { name: 'Paige Hooper', email: 'Paige.Hooper@ahpra.gov.au' }, thread_subject: 'Notice', original_email: { subject: 'Notice', sender: 'Paige.Hooper@ahpra.gov.au', body: 'x' }
  }, extra);
}

let db;
function freshDb() {
  return {
    user_profiles: [{ user_id: GP.userId, email: GP.email, first_name: 'Mercy', last_name: 'Test', registration_country: 'United Kingdom' }],
    user_state: [{ user_id: GP.userId, state: {}, updated_at: NOW }],
    registration_cases: [{ id: CASE_ID, user_id: GP.userId, status: 'active', stage: 'ahpra', practice_contact_name: 'Jane Manager', practice_contact_email: 'pm@practice-test.local', google_drive_folder_id: null }],
    registration_tasks: [
      // Exactly Mercy's broken row: the AI said gp/upload, the stale save left team/upload.
      { id: T.cv, case_id: CASE_ID, task_type: 'ahpra_action_item', title: 'Resubmission of CV with gaps explained', status: 'waiting', ahpra_deadline: '2026-09-29',
        metadata: s80Meta({ owner: 'team', mode: 'upload', ai_owner: 'gp', ai_mode: 'upload', kind: '', gp_instructions: 'Please update and resubmit your CV so it includes your full practice history.' }) },
      { id: T.sup, case_id: CASE_ID, task_type: 'ahpra_action_item', title: 'Supervisor CV clarification/resubmission (Dr Ranatunga)', status: 'waiting', ahpra_deadline: '2026-09-29',
        metadata: s80Meta({ owner: 'team', mode: 'team', ai_owner: 'team', ai_mode: 'team', kind: 'supervised_practice_plan', gp_instructions: 'AHPRA has a query about your supervisor CV.' }) },
      { id: T.cogs, case_id: CASE_ID, task_type: 'ahpra_action_item', title: 'Certificate of Good Standing from GMC', status: 'waiting', ahpra_deadline: '2026-09-29',
        metadata: s80Meta({ owner: 'gp', mode: 'request_institution', ai_owner: 'gp', ai_mode: 'request_institution', kind: 'good_standing', institution: 'GMC', gp_instructions: 'Ask the GMC to send it directly to AHPRA.' }) },
      // Already released: routing must be refused.
      { id: T.released, case_id: CASE_ID, task_type: 'ahpra_action_item', title: 'Reference letter', status: 'waiting_on_gp', ahpra_deadline: '2026-09-29',
        metadata: s80Meta({ owner: 'gp', mode: 'upload', ai_owner: 'gp', ai_mode: 'upload', review_status: 'active', released_at: NOW, bundle_id: 's80_other', gp_instructions: 'Upload it.' }) }
    ],
    task_messages: [],
    task_documents: [],
    task_timeline: [],
    gp_applications: [],
    practice_detected_contacts: [],
    storage_objects: []
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
      // Storage stub: accept any object upload, remember the key.
      if (u.pathname.startsWith('/storage/v1/object/')) {
        await readBody();
        tableOf('storage_objects').push({ key: u.pathname.replace('/storage/v1/object/', ''), method: req.method });
        sendJson(200, { Key: u.pathname }); return;
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
const adminGet = (p) => httpReq('GET', p, { host: SUPER_HOST, cookie: adminCookie() });
const taskById = (id) => db.registration_tasks.find((t) => t.id === id);
const route = (task_id, body) => adminPost('/api/admin/ahpra/item/route', Object.assign({ task_id }, body));
const pdfDataUrl = (text) => 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 ' + text, 'utf8').toString('base64');

let testUtils;
beforeAll(async () => {
  db = freshDb();
  await startEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ahpra-tray-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = '';
  const mod = await import('../server.js');
  testUtils = mod.__testUtils || mod.default?.__testUtils;
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
});

describe('tray Who/How change (POST /api/admin/ahpra/item/route)', () => {
  it('heals Mercy\'s inconsistent team/upload row on the first touch and brings the GP preview text back', async () => {
    const res = await route(T.cv, { mode: 'upload' });
    expect(res.status).toBe(200);
    expect(res.body.owner).toBe('gp');
    expect(res.body.mode).toBe('upload');
    const m = taskById(T.cv).metadata;
    expect(m.owner).toBe('gp');
    expect(m.mode).toBe('upload');
    // The AI-written instruction was never lost — the preview renders from it.
    expect(m.gp_instructions).toContain('resubmit your CV');
    expect(res.body.task.metadata.gp_instructions).toContain('resubmit your CV');
  });

  it('Who → Team handles pairs with mode team; back to GP restores the AI\'s original mode, not a guess', async () => {
    let res = await route(T.cv, { owner: 'team' });
    expect(res.body.owner).toBe('team');
    expect(res.body.mode).toBe('team');
    // The GP copy is kept while the item is team-owned, so nothing is lost on the way back.
    expect(taskById(T.cv).metadata.gp_instructions).toContain('resubmit your CV');
    res = await route(T.cv, { owner: 'gp' });
    expect(res.body.owner).toBe('gp');
    expect(res.body.mode).toBe('upload');   // ai_mode, not the old handler's request_institution
    expect(taskById(T.cv).metadata.gp_instructions).toContain('resubmit your CV');
    expect(taskById(T.cv).description).toMatch(/^\[GP · upload\]/);
  });

  it('How → Practice uploads pairs with owner practice and synthesises the practice-facing note', async () => {
    const res = await route(T.sup, { mode: 'practice_upload' });
    expect(res.status).toBe(200);
    expect(res.body.owner).toBe('practice');
    expect(res.body.mode).toBe('practice_upload');
    const m = taskById(T.sup).metadata;
    expect(m.practice_instructions).toContain('Supervisor CV clarification');
    expect(m.practice_instructions).not.toMatch(/—/);
    expect(taskById(T.sup).description).toMatch(/^\[Practice · practice uploads\]/);
  });

  it('reset:true puts an item back to what the AI marked it as', async () => {
    const res = await route(T.sup, { reset: true });
    expect(res.body.owner).toBe('team');
    expect(res.body.mode).toBe('team');
    // Route it to the practice again for the release + request tests below.
    await route(T.sup, { owner: 'practice' });
    expect(taskById(T.sup).metadata.mode).toBe('practice_upload');
  });

  it('synthesises a GP instruction when an item that never had one is routed to the doctor', async () => {
    taskById(T.cogs).metadata.gp_instructions = '';
    const res = await route(T.cogs, { mode: 'upload' });
    expect(res.status).toBe(200);
    expect(taskById(T.cogs).metadata.gp_instructions.toLowerCase()).toContain('upload');
    await route(T.cogs, { mode: 'request_institution' });
    expect(taskById(T.cogs).metadata.owner).toBe('gp');
  });

  it('refuses to re-route an item that has already been released', async () => {
    const res = await route(T.released, { owner: 'team' });
    expect(res.status).toBe(409);
    expect(taskById(T.released).metadata.owner).toBe('gp');
  });

  it('rejects an unknown item and a missing task_id', async () => {
    expect((await route('nope', { owner: 'team' })).status).toBe(404);
    expect((await adminPost('/api/admin/ahpra/item/route', { owner: 'team' })).status).toBe(400);
  });
});

describe('release with a practice item', () => {
  it('activates the practice item as the team\'s ball (open) and reports it separately', async () => {
    const res = await adminPost('/api/admin/ahpra/release', { bundle_id: BUNDLE, case_id: CASE_ID });
    expect(res.status).toBe(200);
    expect(res.body.released_practice).toBe(1);
    expect(res.body.released_gp).toBe(2);
    const sup = taskById(T.sup);
    expect(sup.status).toBe('open');
    expect(sup.metadata.review_status).toBe('active');
    expect(taskById(T.cv).status).toBe('waiting_on_gp');
  });
});

describe('practice request email', () => {
  it('drafts the request to the practice contact on file (template when no AI key), with no em dashes', async () => {
    const res = await adminGet('/api/admin/ahpra/item/practice-request-draft?task_id=' + T.sup);
    expect(res.status).toBe(200);
    expect(res.body.to).toBe('pm@practice-test.local');
    expect(res.body.subject).toContain('Supervisor CV clarification');
    expect(res.body.subject).toContain('Dr Mercy Test');
    expect(res.body.bodyHtml).toContain('Hi Jane Manager');
    expect(res.body.bodyHtml).toContain('reply to this email with the document attached');
    expect(res.body.bodyHtml).not.toMatch(/—/);
    expect(res.body.ai_drafted).toBe(false);
    expect(res.body.already_sent).toBe(false);
  });

  it('refuses a draft for a non-practice item', async () => {
    const res = await adminGet('/api/admin/ahpra/item/practice-request-draft?task_id=' + T.cv);
    expect(res.status).toBe(400);
  });

  it('send: validates fields, blocks an internal note, and refuses before release', async () => {
    let res = await adminPost('/api/admin/ahpra/item/practice-request', { task_id: T.sup, to: 'pm@practice-test.local', subject: 'x' });
    expect(res.status).toBe(400);
    res = await adminPost('/api/admin/ahpra/item/practice-request', { task_id: T.sup, to: 'not-an-email', subject: 'x', bodyHtml: 'Hi' });
    expect(res.status).toBe(400);
    res = await adminPost('/api/admin/ahpra/item/practice-request', { task_id: T.sup, to: 'pm@practice-test.local', subject: 'x', bodyHtml: 'Hi [RSO: chase them again Friday] thanks' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('internal_note_in_body');
    // An un-released practice item cannot be emailed yet.
    db.registration_tasks.push({ id: 't-unreleased-pr', case_id: CASE_ID, task_type: 'ahpra_action_item', title: 'Position description', status: 'waiting', metadata: s80Meta({ owner: 'practice', mode: 'practice_upload', bundle_id: 's80_b2' }) });
    res = await adminPost('/api/admin/ahpra/item/practice-request', { task_id: 't-unreleased-pr', to: 'pm@practice-test.local', subject: 'x', bodyHtml: 'Hi there' });
    expect(res.status).toBe(409);
    // With no Gmail configured in tests the real send cannot succeed; it must fail loudly, not
    // mark the item as requested.
    res = await adminPost('/api/admin/ahpra/item/practice-request', { task_id: T.sup, to: 'pm@practice-test.local', subject: 'x', bodyHtml: 'Hi there' });
    expect(res.status).toBe(502);
    expect(taskById(T.sup).status).toBe('open');
    expect(taskById(T.sup).metadata.practice_request).toBeUndefined();
  });
});

describe('practice document arrives', () => {
  it('a reply attachment filed on the task becomes the item\'s reviewable upload (AI-check slot filled, status waiting)', async () => {
    // Simulate what the inbound email match does: the practice's reply attachments land in
    // task_documents. The inbound path only flags the FIRST attachment current — here a logo
    // image — so the picker must look at every attachment of the newest reply, and prefer the PDF.
    const earlier = new Date(Date.now() - 60000).toISOString();
    db.task_documents.push({ id: 'doc-old-0', task_id: T.sup, case_id: CASE_ID, message_id: 'msg-old', filename: 'old-thread.pdf', mime_type: 'application/pdf', is_current: false, uploaded_by: 'gp_email', attachment_url: pdfDataUrl('older'), created_at: earlier });
    db.task_documents.push({ id: 'doc-reply-0', task_id: T.sup, case_id: CASE_ID, message_id: 'msg-reply', filename: 'logo.png', mime_type: 'image/png', is_current: true, uploaded_by: 'email_response', attachment_url: 'data:image/png;base64,' + Buffer.from('\x89PNG\r\n\x1a\nxx').toString('base64'), created_at: NOW });
    db.task_documents.push({ id: 'doc-reply-1', task_id: T.sup, case_id: CASE_ID, message_id: 'msg-reply', filename: 'Ranatunga CV updated.pdf', mime_type: 'application/pdf', is_current: false, uploaded_by: 'email_response', attachment_url: pdfDataUrl('updated supervisor cv'), created_at: NOW });
    const promoted = await testUtils._autoFilePracticeReplyForS80(T.sup);
    expect(promoted).toBe(true);
    const sup = taskById(T.sup);
    expect(sup.status).toBe('waiting');
    expect(sup.metadata.upload.status).toBe('under_review');
    expect(sup.metadata.upload.file_name).toBe('Ranatunga CV updated.pdf');
    expect(sup.metadata.upload.uploaded_by).toBe('practice_reply');
    expect(sup.metadata.upload.source_document_id).toBe('doc-reply-1');
    expect(sup.metadata.upload.other_attachments).toEqual(['logo.png']);
    expect(sup.metadata.upload.ai_check.verdict).toBe('unchecked'); // fail-open with no AI key
    expect(db.storage_objects.length).toBe(1);
    expect(db.storage_objects[0].key).toContain('ahpra_s80_' + T.sup);
    // Re-running on the same reply does nothing (no loop on a thread re-scan).
    expect(await testUtils._autoFilePracticeReplyForS80(T.sup)).toBe(false);
  });

  it('reject sends a practice item back to the team (open), never to the GP, and a re-request supersedes the file', async () => {
    let res = await adminPost('/api/admin/ahpra/item/review', { task_id: T.sup, decision: 'reject', reason: 'Dates still missing' });
    expect(res.status).toBe(200);
    const sup = taskById(T.sup);
    expect(sup.status).toBe('open');
    expect(sup.metadata.upload.status).toBe('rejected');
    expect(sup.metadata.upload.reject_reason).toBe('Dates still missing');
  });

  it('staff can file the document by hand (base64) or pick a reply attachment by id', async () => {
    let res = await adminPost('/api/admin/ahpra/item/practice-file', { task_id: T.sup, fileName: 'Ranatunga CV v2.pdf', mimeType: 'application/pdf', fileDataUrl: pdfDataUrl('v2') });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('under_review');
    let sup = taskById(T.sup);
    expect(sup.metadata.upload.uploaded_by).toBe('admin_upload');
    expect(sup.metadata.upload.file_name).toBe('Ranatunga CV v2.pdf');
    expect(sup.status).toBe('waiting');
    // Approve completes it exactly like a GP upload.
    res = await adminPost('/api/admin/ahpra/item/review', { task_id: T.sup, decision: 'approve' });
    expect(res.status).toBe(200);
    sup = taskById(T.sup);
    expect(sup.status).toBe('completed');
    expect(sup.metadata.upload.status).toBe('approved');
    // A completed item accepts no more files.
    res = await adminPost('/api/admin/ahpra/item/practice-file', { task_id: T.sup, document_id: 'doc-reply-1' });
    expect(res.status).toBe(409);
    // A GP item refuses the practice path.
    res = await adminPost('/api/admin/ahpra/item/practice-file', { task_id: T.cv, document_id: 'doc-reply-1' });
    expect(res.status).toBe(400);
  });
});

describe('the practice emails the document instead of replying on our thread', () => {
  const DETECT_ID = 't-pu-detect';
  const pdfBuf = (text) => Buffer.from('%PDF-1.4 ' + text, 'utf8');
  function email(sender, files, msgId) {
    return {
      emailMeta: { sender, to: 'registration@mygplink.com.au', subject: 'Updated CV as requested', bodyText: 'Please find attached.', threadId: 'thread-fresh-' + msgId, hasAttachments: files.length > 0,
        attachments: files.map((f, i) => ({ index: i, filename: f.name, mimeType: f.mime, attachmentId: 'att-' + i, size: f.buf.length })) },
      currentMsgId: msgId, emailAddress: 'registration@mygplink.com.au', gmail: null, knownCase: null, senderRole: null,
      downloadAttachment: async (att) => files[att.index].buf
    };
  }
  beforeAll(() => {
    // A released practice item whose request email went to the practice manager.
    db.registration_tasks.push({ id: DETECT_ID, case_id: CASE_ID, task_type: 'ahpra_action_item', title: 'Supervisor CV clarification/resubmission (Dr Ranatunga)', status: 'waiting_on_practice', ahpra_deadline: '2026-09-29',
      metadata: s80Meta({ owner: 'practice', mode: 'practice_upload', review_status: 'active', released_at: NOW, bundle_id: 's80_b3', kind: 'practice_document',
        practice_instructions: 'Please send an updated CV for Dr Ranatunga.', practice_request: { sent_at: NOW, to: 'pm@practice-test.local', cc: '', subject: 'x', by: SUPER_EMAIL, gmail_thread_id: 'thread-our-request', send_count: 1 } }) });
  });

  it('ignores an AHPRA officer email and a stranger, and never touches the item', async () => {
    let r = await testUtils._detectPracticeUploadFromEmail(email('Paige.Hooper@ahpra.gov.au', [{ name: 'Ranatunga CV.pdf', mime: 'application/pdf', buf: pdfBuf('x') }], 'msg-officer'));
    expect(r.matched).toBe(false);
    r = await testUtils._detectPracticeUploadFromEmail(email('someone@random-stranger.example', [{ name: 'Ranatunga CV.pdf', mime: 'application/pdf', buf: pdfBuf('x') }], 'msg-stranger'));
    expect(r.matched).toBe(false);
    expect(taskById(DETECT_ID).status).toBe('waiting_on_practice');
    expect(taskById(DETECT_ID).metadata.upload).toBeUndefined();
    expect(db.task_documents.filter((d) => d.task_id === DETECT_ID).length).toBe(0);
  });

  it('files a fresh email from the address we wrote to, on a NEW thread, picking the file named after the supervisor', async () => {
    const files = [
      { name: 'practice-logo.png', mime: 'image/png', buf: Buffer.from('\x89PNG\r\n\x1a\nxx') },
      { name: 'Dr Ranatunga CV Sept 2026.pdf', mime: 'application/pdf', buf: pdfBuf('updated cv') }
    ];
    const r = await testUtils._detectPracticeUploadFromEmail(email('Practice Manager <PM@practice-test.local>', files, 'msg-fresh-1'));
    expect(r.matched).toBe(true);
    expect(r.taskId).toBe(DETECT_ID);
    expect(r.reason).toBe('filename');   // no AI key in tests, so the name decides
    expect(r.trust).toBe('requested');
    const t = taskById(DETECT_ID);
    expect(t.status).toBe('waiting');
    expect(t.metadata.upload.status).toBe('under_review');
    expect(t.metadata.upload.file_name).toBe('Dr Ranatunga CV Sept 2026.pdf');
    expect(t.metadata.upload.uploaded_by).toBe('practice_email');
    expect(t.metadata.upload.sender_verified).toBe(true);
    expect(t.metadata.upload.detected_from.sender).toBe('pm@practice-test.local');
    expect(t.metadata.upload.detected_from.gmail_thread_id).toBe('thread-fresh-msg-fresh-1');
    expect(t.metadata.upload.other_attachments).toEqual(['practice-logo.png']);
    // The email and both attachments are on the item's record; the CV is the promoted one.
    const msgs = db.task_messages.filter((m) => m.task_id === DETECT_ID && m.direction === 'inbound');
    expect(msgs.length).toBe(1);
    expect(msgs[0].gmail_message_id).toBe('msg-fresh-1');
    const docs = db.task_documents.filter((d) => d.task_id === DETECT_ID);
    expect(docs.map((d) => d.filename).sort()).toEqual(['Dr Ranatunga CV Sept 2026.pdf', 'practice-logo.png']);
    expect(docs.every((d) => d.is_current === true)).toBe(true);
    expect(t.metadata.upload.source_document_id).toBe(docs.find((d) => /CV/.test(d.filename)).id);
    expect(db.processed_gmail_messages.find((p) => p.gmail_message_id === 'msg-fresh-1').result).toBe('ahpra_practice_upload_matched');
    // The same email again is not filed twice; an item under review is not touched again.
    const again = await testUtils._detectPracticeUploadFromEmail(email('pm@practice-test.local', files, 'msg-fresh-1'));
    expect(again.matched).toBe(false);
    expect(db.task_messages.filter((m) => m.task_id === DETECT_ID).length).toBe(1);
  });

  it('a case the inbound pipeline already resolved is scanned case-scoped, and the practice contact on file counts as known', async () => {
    db.registration_tasks.push({ id: 't-pu-detect-2', case_id: CASE_ID, task_type: 'ahpra_action_item', title: 'Position description for the proposed role', status: 'open', ahpra_deadline: '2026-09-29',
      metadata: s80Meta({ owner: 'practice', mode: 'practice_upload', review_status: 'active', released_at: NOW, bundle_id: 's80_b4', kind: 'practice_document', practice_instructions: 'Please send the position description.' }) });
    const ctx = email('pm@practice-test.local', [{ name: 'PD.pdf', mime: 'application/pdf', buf: pdfBuf('position description') }], 'msg-fresh-2');
    ctx.knownCase = { id: CASE_ID, user_id: GP.userId }; ctx.senderRole = 'practice';
    const r = await testUtils._detectPracticeUploadFromEmail(ctx);
    expect(r.matched).toBe(true);
    expect(r.reason).toBe('single_candidate');   // one open item, one file, from the practice contact
    expect(r.trust).toBe('contact');
    expect(taskById('t-pu-detect-2').metadata.upload.file_name).toBe('PD.pdf');
  });
});

describe('admin page tray markup', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'pages', 'admin.html'), 'utf8');
  it('offers Practice in both dropdowns and saves through the route endpoint, not a DOM-derived metadata_merge', () => {
    expect(html).toContain("practice:'Practice does it'");
    expect(html).toContain("practice_upload:'Practice uploads'");
    expect(html).toContain('/api/admin/ahpra/item/route');
    expect(html).toContain('data-s80-reset=');
    expect(html).toContain('What the practice will be asked');
    expect(html).toContain('data-s80-practice-draft=');
    expect(html).toContain('/api/admin/ahpra/item/practice-request-draft');
    expect(html).toContain('/api/admin/ahpra/item/practice-file');
    // The old handler: metadata_merge:{owner/mode} built from the sibling <select>.
    expect(html).not.toMatch(/data-s80-mode="'\+sid\+'"'\)\; if\(me&&me\.value==='team'\)merge\.mode/);
  });
});

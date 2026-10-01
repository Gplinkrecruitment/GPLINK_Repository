// Why this file exists (2026-10-02, Dr Mercy Obanimoh): AHPRA's officer asked for a statement on
// the supervisor's hours. Dr Ranatunga answered by typing the statement INTO a reply addressed to
// the officer, with us copied — no attachment. Two things went wrong:
//   1. the card for the "Supervisor availability statement" item kept saying "waiting on the
//      practice" because every inbound filing path only ever looked at attachments, so the RSO
//      emailed the practice again the next day; and
//   2. the officer had written that ask as a reply ON our own conflict-letter thread, so her email
//      carried OUR subject ("RE: Conflict-of-interest confirmation for Dr …"); the conflict-letter
//      gate read that subject as the officer's words and raised a THIRD conflict-of-interest task
//      ("AHPRA has asked again") whose "already confirmed on" date came from a letter that had been
//      marked sent-in-error.
// These tests pin the gate, the body-statement filing, the "prior confirmation" choice, the
// one-email-one-treatment dedupe, and the dashboard rendering.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import cl from '../lib/ahpra-conflict-letter.js';
import s80 from '../lib/ahpra-s80.js';

const src = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(process.cwd(), 'pages', 'admin.html'), 'utf8');

// The officer's real 30 Sep 2026 email (abridged), sent as a reply on our conflict-letter thread.
const OFFICER_REPLY = {
  subject: 'RE: Conflict-of-interest confirmation for Dr Mercy Obanimoh, please email AHPRA',
  rfc822References: '<CAHYvBf8@mail.gmail.com> <A0755CE2@yahoo.com>',
  bodyText: 'Dear Dr Ranatunga,\n\nIt is noted on your CV that you are currently also employed as a medical student supervisor and OSCE examiner with the University of Notre Dame. Because of this, the Board will want to clarify how often you will be available at The Doctors Werribee to provide Indirect 2 level supervision to Dr Obanimoh.\n\nTherefore, could you please confirm if you are full-time or part-time at The Doctors Werribee?\n\nKind regards,\nPaige Hooper\n\nFrom: Chamira Ranatunga <chamiraranatunga@yahoo.com>\nSent: Wednesday, 30 September 2026 6:04 AM\nSubject: Re: Conflict-of-interest confirmation for Dr Mercy Obanimoh, please email AHPRA\n\nHi Hazel, I have already submitted a reply for this earlier. I have also cc’d Page at AHPRA.'
};
const OFFICER_REPLY_TRIAGE = {
  category: 'information_request',
  response_type: 'request_from_practice',
  summary: 'AHPRA is asking the supervisor Dr Ranatunga to confirm whether he is full-time or part-time at The Doctors Werribee, his working hours there, and how he will provide Indirect Level 2 supervision when he is not at the practice.'
};

describe('isConflictFollowupEmail — a reply inherits OUR subject, so the subject only counts on a fresh email', () => {
  it('does NOT route the officer\'s 30 Sep hours question just because it was a reply on the conflict-letter thread', () => {
    expect(cl.isConflictFollowupEmail(OFFICER_REPLY_TRIAGE, OFFICER_REPLY)).toBe(false);
  });
  it('still refuses when the only reply signal is the "RE:" prefix (no References header)', () => {
    expect(cl.isConflictFollowupEmail(OFFICER_REPLY_TRIAGE, { subject: OFFICER_REPLY.subject, bodyText: OFFICER_REPLY.bodyText })).toBe(false);
  });
  it('refuses our own letter subject even without a reply prefix', () => {
    expect(cl.isConflictFollowupEmail(OFFICER_REPLY_TRIAGE, { subject: 'Conflict-of-interest confirmation for Dr Mercy Obanimoh, please email AHPRA', bodyText: 'Please confirm his hours.' })).toBe(false);
    expect(cl.isConflictFollowupEmail(OFFICER_REPLY_TRIAGE, { subject: 'Conflict-of-interest follow-up for Dr Mercy Obanimoh, AHPRA has asked again', bodyText: 'Please confirm his hours.' })).toBe(false);
  });
  it('a FRESH officer email whose subject names the conflict of interest still routes', () => {
    expect(cl.isConflictFollowupEmail(OFFICER_REPLY_TRIAGE, { subject: 'Conflict of interest management — Dr Obanimoh', bodyText: 'We need the practice to confirm how it is managed.' })).toBe(true);
  });
  it('the AI summary decides regardless of subject', () => {
    const t = Object.assign({}, OFFICER_REPLY_TRIAGE, { summary: 'The officer wants a fuller conflict of interest management statement from the practice.' });
    expect(cl.isConflictFollowupEmail(t, OFFICER_REPLY)).toBe(true);
  });
  it('for category conflict_followup, quoted history does not count as the officer\'s words', () => {
    const t = Object.assign({}, OFFICER_REPLY_TRIAGE, { category: 'conflict_followup' });
    // Our own letter is quoted under the officer's text and mentions the conflict; the officer's own words do not.
    const quoted = { subject: 'RE: s80 notice', bodyText: 'Please confirm his hours and days at the practice.\n\nOn 29 Sep 2026, Hazel, GP Link wrote:\n> AHPRA requires a short statement from the practice confirming how this potential conflict of interest will be managed.' };
    expect(cl.isConflictFollowupEmail(t, quoted)).toBe(false);
    const own = { subject: 'RE: s80 notice', bodyText: 'The conflict-of-interest statement provided does not say how supervision is kept independent.\n\nOn 29 Sep 2026, Hazel wrote:\n> hours' };
    expect(cl.isConflictFollowupEmail(t, own)).toBe(true);
  });
  it('helpers: reply prefixes and our own subjects', () => {
    expect(cl.isReplySubject('RE: RE: anything')).toBe(true);
    expect(cl.isReplySubject('Fwd: anything')).toBe(true);
    expect(cl.isReplySubject('Notice to provide further information')).toBe(false);
    expect(cl.isOwnConflictLetterSubject('Re: Conflict-of-interest confirmation for Dr X, please email AHPRA')).toBe(true);
    expect(cl.isOwnConflictLetterSubject('Conflict of interest policy')).toBe(false);
    expect(cl.stripQuotedReply('mine\n\nFrom: Someone <a@b.c>\nSent: x\n\ntheirs')).toBe('mine');
    expect(cl.stripQuotedReply('mine\n> theirs')).toBe('mine');
  });
});

describe('decideEmailStatementFiling', () => {
  it('files when the AI read the text as answering the ask', () => {
    expect(s80.decideEmailStatementFiling({ textLength: 400, verdict: 'match', officerCopied: false })).toBe('file');
    expect(s80.decideEmailStatementFiling({ textLength: 400, verdict: 'match', officerCopied: true })).toBe('file');
  });
  it('files without an AI verdict only when the practice sent it to the officer directly', () => {
    expect(s80.decideEmailStatementFiling({ textLength: 400, verdict: 'unchecked', officerCopied: true })).toBe('file');
    expect(s80.decideEmailStatementFiling({ textLength: 400, verdict: 'unchecked', officerCopied: false })).toBe('note');
  });
  it('keeps a doubtful reply on the card as a note, officer copied or not', () => {
    expect(s80.decideEmailStatementFiling({ textLength: 400, verdict: 'possible_issue', officerCopied: true })).toBe('note');
    expect(s80.decideEmailStatementFiling({ textLength: 400, verdict: 'unclear', officerCopied: false })).toBe('note');
  });
  it('skips a few words', () => {
    expect(s80.decideEmailStatementFiling({ text: 'Thanks, will do.', verdict: 'match', officerCopied: true })).toBe('skip');
    expect(s80.decideEmailStatementFiling({ textLength: 0 })).toBe('skip');
  });
});

describe('buildOfficerReplyDraft — a body statement goes in the email, nothing is attached', () => {
  it('quotes the statement with who sent it and when', () => {
    const d = s80.buildOfficerReplyDraft({ gpName: 'Mercy Obanimoh', itemTitle: 'Supervisor availability statement (Dr Ranatunga)', reference: '14805868', officerName: 'Paige Hooper', statementText: 'I am at The Doctors Werribee full time.', statementFrom: 'chamiraranatunga@yahoo.com', statementDate: '1 October 2026' });
    expect(d.body).toContain('please find below the Supervisor availability statement (Dr Ranatunga), as provided by chamiraranatunga@yahoo.com by email on 1 October 2026:');
    expect(d.body).toContain('\n\nI am at The Doctors Werribee full time.\n');
    expect(d.body).not.toContain('please find attached');
  });
  it('without a statement the attached-file wording is unchanged', () => {
    const d = s80.buildOfficerReplyDraft({ gpName: 'Mercy Obanimoh', itemTitle: 'CV', reference: '1', officerName: 'Paige Hooper' });
    expect(d.body).toContain('please find attached the CV.');
    expect(d.body).not.toContain('please find below');
  });
});

describe('server.js wiring', () => {
  it('the early thread path reads the body when nothing usable was attached, after the attachment promoter', () => {
    expect(src).toMatch(/_earlyBodyOnly = !\(await _autoFilePracticeReplyForS80\(earlyTask\.id\)\);/);
    expect(src).toMatch(/if \(_earlyBodyOnly && earlyTask\.task_type === 'ahpra_action_item' && !isAhpraSender\(emailMeta\.sender\)\) \{\s*\n\s*await _fileEmailStatementForS80\(earlyTask\.id, \{ emailMeta: emailMeta, currentMsgId: currentMsgId, messageRowId:/);
  });
  it('the advisory AI check accepts plain text (the email body)', () => {
    expect(src).toMatch(/else if \(mt === 'text\/plain' \|\| mt\.indexOf\('text\/plain;'\) === 0\) \{/);
    expect(src).toContain('a statement typed into the body of an email from the practice, no file attached');
  });
  it('the filing helper never files from the officer or ourselves, never over a live upload, never the doctor\'s own words as the statement', () => {
    const start = src.indexOf('async function _fileEmailStatementForS80(');
    expect(start).toBeGreaterThan(0);
    const fn = src.slice(start, start + 9000);
    expect(fn).toContain("if (!senderBare || isAhpraSender(emailMeta.sender) || isOurOwnAddress(senderBare)) return { filed: false, reason: 'sender' };");
    expect(fn).toContain("if (meta.upload && meta.upload.status && meta.upload.status !== 'rejected' && meta.upload.status !== 'superseded') return { filed: false, reason: 'has_upload' };");
    expect(fn).toContain("if (decision === 'file' && !ctx.force && ctx.senderRole === 'candidate') decision = 'note';");
    expect(fn).toContain("kind: 'email_statement',");
    expect(fn).toContain("runUploadCheck(Buffer.from(text, 'utf8'), 'text/plain',");
    expect(fn).toContain("{ method: 'PATCH', body: { status: 'waiting', metadata: meta, updated_at: nowIso } }");
  });
  it('the conflict-letter helper ignores sent-in-error / cancelled letters and cites the FIRST confirmation', () => {
    expect(src).toContain("existingRows = existingRows.filter(function (t) { return t.status !== 'cancelled' && _parseClMeta(t.metadata).sent_in_error !== true; });");
    expect(src).toContain('var priorConfirmed = confirmedRows.length ? confirmedRows[confirmedRows.length - 1] : null;');
    expect(src).toContain("'&task_type=eq.ahpra_conflict_letter&order=created_at.desc&limit=10'");
  });
  it('one officer email gets one treatment: a copy already filed on an AHPRA task of the case raises nothing', () => {
    expect(src).toMatch(/if \(caseId && emailMeta\.rfc822MessageId\) \{/);
    expect(src).toContain("'&direction=eq.inbound&rfc822_message_id=eq.' + encodeURIComponent(emailMeta.rfc822MessageId) + '&limit=5'");
    expect(src).toContain('&task_type=in.(ahpra_action_item,ahpra_conflict_letter,ahpra_correspondence)&limit=5');
    expect(src).toContain('(another mailbox\\\'s copy) — not raising a second task');
  });
  it('the officer-reply flow sends a body statement without an attachment and the file endpoint shows the text', () => {
    expect(src).toContain("var orIsStatement = !!(orUp && orUp.kind === 'email_statement' && orUp.statement_text);");
    expect(src).toContain('attachments: orIsStatement ? undefined : [{ filename: orUp.file_name');
    expect(src).toMatch(/if \(!drStatement && process\.env\.ANTHROPIC_API_KEY && await checkAnthropicBudget\(\)\) \{/);
    expect(src).toContain("file_name: drStatement ? '' : ((drMeta.upload && drMeta.upload.file_name) || ''), statement: !!drStatement");
    expect(src).toContain("if (up && up.kind === 'email_statement' && up.statement_text) {");
    expect(src).toContain("pathname === '/api/admin/ahpra/item/practice-statement' && req.method === 'POST'");
  });
});

describe('admin page', () => {
  it('shows the statement text on the review card, labels the link "View statement", and explains the no-attachment send', () => {
    expect(admin).toContain("var upStmt=isPr&&up.kind==='email_statement';");
    expect(admin).toContain('The statement is in the email itself, no file attached');
    expect(admin).toContain("(upStmt?'View statement':'View file')");
    expect(admin).toContain("df.reason==='email_body'?' · typed into the email, read by the AI check'");
    expect(admin).toContain('The practice’s statement is written into the email body (nothing to attach)');
  });
  it('a reply the AI did not read as the statement is shown on the waiting card with a one-click override', () => {
    expect(admin).toContain('but the AI did not read it as the requested statement');
    expect(admin).toContain('data-s80-practice-usestatement=');
    expect(admin).toContain("fetch('/api/admin/ahpra/item/practice-statement'");
  });
});

// ── End to end against the real server with an in-memory Supabase ──────────────────────────────
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ahpra-stmt-${RUN_ID}.json`);
let server, port, sbServer, sbPort, testUtils;
const SUPER_HOST = 'ceo-stmt.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const GP = { userId: 'u-gp-stmt-1', email: 'gp-stmt@gplink-test.local' };
const CASE_ID = 'case-stmt-1';
const ITEM = 't-stmt-item';
const OFFICER = 'Paige.Hooper@ahpra.gov.au';
const NOW = new Date().toISOString();
let db;

function itemMeta(extra) {
  return Object.assign({
    s80: true, bundle_id: 's80_stmt', reference: '14805868', review_status: 'active', released_at: NOW,
    owner: 'practice', mode: 'practice_upload', kind: 'practice_document', direct_to_officer: true,
    detail: 'AHPRA asks for a statement from Dr Ranatunga clarifying if he is full-time at The Doctors Werribee, and if not, his hours and how he provides Indirect level 2 supervision.',
    practice_instructions: 'Please send a short statement from Dr Ranatunga on his hours.', sub_items: [{ label: 'Full-time?', done: false }],
    officer: { name: 'Paige Hooper', email: OFFICER }, thread_subject: 'Notice', original_email: { subject: 'Notice', sender: OFFICER, body: 'x' }
  }, extra);
}
function freshDb() {
  return {
    user_profiles: [{ user_id: GP.userId, email: GP.email, first_name: 'Mercy', last_name: 'Test', registration_country: 'United Kingdom' }],
    user_state: [{ user_id: GP.userId, state: {}, updated_at: NOW }],
    registration_cases: [{ id: CASE_ID, user_id: GP.userId, status: 'active', stage: 'ahpra', practice_contact_name: 'Dr Chamira Ranatunga', practice_contact_email: 'chamiraranatunga@yahoo.com', google_drive_folder_id: null }],
    registration_tasks: [
      { id: ITEM, case_id: CASE_ID, task_type: 'ahpra_action_item', title: 'Supervisor availability statement (Dr Ranatunga)', status: 'open', ahpra_deadline: '2026-10-13', metadata: itemMeta({}) }
    ],
    task_messages: [], task_documents: [], task_timeline: [], gp_applications: [], practice_detected_contacts: [], storage_objects: []
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
  return (row) => filters.every((f) => { const eq = String(row ? row[f.col] : undefined) === String(f.val); return f.op === 'eq' ? eq : !eq; });
}
function startEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const sendJson = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      const readBody = () => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });
      if (u.pathname.startsWith('/storage/v1/object/')) { await readBody(); tableOf('storage_objects').push({ key: u.pathname }); sendJson(200, { Key: u.pathname }); return; }
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { sendJson(404, { message: 'not found' }); return; }
      const rows = tableOf(decodeURIComponent(m[1]));
      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') { let out = rows.filter(matches); const limit = parseInt(u.searchParams.get('limit') || '', 10); if (Number.isFinite(limit)) out = out.slice(0, limit); sendJson(200, out); return; }
      if (req.method === 'POST') { const body = JSON.parse((await readBody()).toString('utf8') || 'null'); const incoming = Array.isArray(body) ? body : (body ? [body] : []); const saved = incoming.map((r) => { const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r }; rows.push(row); return row; }); sendJson(201, saved); return; }
      if (req.method === 'PATCH') { const patch = JSON.parse((await readBody()).toString('utf8') || 'null'); const matched = rows.filter(matches); matched.forEach((row) => Object.assign(row, patch || {})); sendJson(200, matched); return; }
      if (req.method === 'DELETE') { const keep = rows.filter((row) => !matches(row)); rows.length = 0; keep.forEach((row) => rows.push(row)); sendJson(200, []); return; }
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
      res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let parsed = null; try { parsed = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers }); });
    });
    r.on('error', reject); r.end(data);
  });
}
const adminPost = (p, body) => httpReq('POST', p, { host: SUPER_HOST, cookie: adminCookie(), body });
const adminGet = (p) => httpReq('GET', p, { host: SUPER_HOST, cookie: adminCookie() });
const taskById = (id) => db.registration_tasks.find((t) => t.id === id);

// Dr Ranatunga's real 30 Sep reply (abridged): typed statement, To the officer + us, CC the RSO.
const STATEMENT_EMAIL = {
  sender: 'chamiraranatunga@yahoo.com',
  to: '"registration@mygplink.com.au" <registration@mygplink.com.au>, Paige Hooper <paige.hooper@ahpra.gov.au>',
  cc: '"hazel@mygplink.com.au" <hazel@mygplink.com.au>',
  subject: 'Re: Conflict-of-interest confirmation for Dr Mercy Obanimoh, please email AHPRA',
  date: '2026-09-30T23:44:27.000Z',
  bodyText: ' Hi Paige,\nThank you for your request of this. I am a Medical Student Supervisor on site at The Doctors Werribee, where 3rd Year Medical Students come and observe my consultations. The rotations are now completed for 2026.\nAdditionally the OSCE examinations are held on 2 days per year. This is generally not going to affect my supervision of Dr. Obanimoh.\nAdditionally I currently consult 4 days a week at the Doctors Werribee.\nThank you\nChamira\n    On Thursday 1 October 2026 at 09:17:23 am AEST, Paige Hooper <paige.hooper@ahpra.gov.au> wrote:  \n \nDear Dr Ranatunga,\nIt is noted on your CV that you are currently also employed as a medical student supervisor.'
};

beforeAll(async () => {
  db = freshDb();
  await startEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ahpra-stmt-secret-' + RUN_ID;
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

describe('the practice types the statement into an email to the officer, CC us', () => {
  it('files the body as the item\'s reviewable statement, marks it already with AHPRA, and the file endpoint shows the text', async () => {
    db.task_messages.push({ id: 'msg-stmt-1', task_id: ITEM, case_id: CASE_ID, direction: 'inbound', sender: STATEMENT_EMAIL.sender, recipient: STATEMENT_EMAIL.to, cc: STATEMENT_EMAIL.cc, subject: STATEMENT_EMAIL.subject, body_text: STATEMENT_EMAIL.bodyText, gmail_message_id: 'g-stmt-1', created_at: NOW });
    const r = await testUtils._fileEmailStatementForS80(ITEM, { emailMeta: STATEMENT_EMAIL, currentMsgId: 'g-stmt-1', messageRowId: 'msg-stmt-1', senderRole: 'practice' });
    expect(r.filed).toBe('file');          // no AI key in tests → 'unchecked' + officer copied ⇒ file
    expect(r.officerCopied).toBe(true);
    const t = taskById(ITEM);
    expect(t.status).toBe('waiting');
    const up = t.metadata.upload;
    expect(up.kind).toBe('email_statement');
    expect(up.status).toBe('under_review');
    expect(up.uploaded_by).toBe('practice_email_body');
    expect(up.delivered_to_officer).toBe(true);
    expect(up.delivered_to_officer_email).toBe(OFFICER);
    expect(up.sender_verified).toBe(true);
    expect(up.source_message_id).toBe('msg-stmt-1');
    expect(up.received_at).toBe('2026-09-30T23:44:27.000Z');
    // Only what he wrote this time — the officer's quoted email is not part of the statement.
    expect(up.statement_text).toContain('I currently consult 4 days a week at the Doctors Werribee.');
    expect(up.statement_text).not.toContain('It is noted on your CV');
    expect(up.ai_check.verdict).toBe('unchecked');
    expect(db.storage_objects.length).toBe(0);  // nothing to store: there is no file
    expect(db.task_timeline.some((e) => e.task_id === ITEM && /Practice emailed the statement straight to the officer and copied us/.test(e.title))).toBe(true);
    // The team can read it from the card's link.
    const page = await adminGet('/api/admin/ahpra/item/file?task_id=' + ITEM);
    expect(page.status).toBe(200);
    expect(String(page.headers['content-type'])).toContain('text/html');
    expect(page.raw).toContain('I currently consult 4 days a week at the Doctors Werribee.');
    expect(page.raw).toContain('sent to Paige.Hooper@ahpra.gov.au with us copied');
    // A second pass over the same reply does not file over the one under review.
    const again = await testUtils._fileEmailStatementForS80(ITEM, { emailMeta: STATEMENT_EMAIL, currentMsgId: 'g-stmt-1', messageRowId: 'msg-stmt-1', senderRole: 'practice' });
    expect(again.filed).toBe(false);
    expect(again.reason).toBe('has_upload');
  });

  it('the officer-reply draft puts the statement in the body with nothing to attach, and the send endpoint accepts the no-file item', async () => {
    const draft = await adminGet('/api/admin/ahpra/item/officer-reply-draft?task_id=' + ITEM);
    expect(draft.status).toBe(200);
    expect(draft.body.statement).toBe(true);
    expect(draft.body.file_name).toBe('');
    expect(draft.body.bodyHtml).toContain('please find below the Supervisor availability statement (Dr Ranatunga), as provided by chamiraranatunga@yahoo.com by email on 1 October 2026:');
    expect(draft.body.bodyHtml).toContain('I currently consult 4 days a week at the Doctors Werribee.');
    // No Gmail in tests: the send must fail loud at the send step (502), not at "no uploaded file" (400).
    const send = await adminPost('/api/admin/ahpra/item/officer-reply', { task_id: ITEM, to: OFFICER, subject: 'Re: x', bodyHtml: draft.body.bodyHtml });
    expect(send.status).toBe(502);
    expect(taskById(ITEM).status).toBe('waiting');
  });

  it('"Accept (already with AHPRA)" completes the item without any send', async () => {
    const res = await adminPost('/api/admin/ahpra/item/review', { task_id: ITEM, decision: 'approve' });
    expect(res.status).toBe(200);
    expect(taskById(ITEM).status).toBe('completed');
    expect(taskById(ITEM).metadata.upload.status).toBe('approved');
  });
});

describe('a reply to us alone, without the statement', () => {
  const ITEM2 = 't-stmt-item-2';
  it('is kept on the card as a note (no AI verdict, officer not copied), and the RSO can still use it with one click', async () => {
    db.registration_tasks.push({ id: ITEM2, case_id: CASE_ID, task_type: 'ahpra_action_item', title: 'Supervisor availability statement (Dr Ranatunga)', status: 'waiting_on_practice', ahpra_deadline: '2026-10-13',
      metadata: itemMeta({ practice_request: { to: 'chamiraranatunga@yahoo.com', sent_at: NOW, send_count: 1 } }) });
    const email = { sender: 'Chamira Ranatunga <chamiraranatunga@yahoo.com>', to: 'registration@mygplink.com.au', cc: '', subject: 'Re: Supervisor availability statement (Dr Ranatunga) needed', date: NOW,
      bodyText: 'Hazel I have explained this directly to Paige today. I am at the doctors Werribee full time. There is no changes in working there\n\nThanks\n\nOn 1 Oct 2026, at 5:56 pm, Hazel, GP Link <registration@mygplink.com.au> wrote:\n\nDear Dr Ranatunga,' };
    db.task_messages.push({ id: 'msg-stmt-2', task_id: ITEM2, case_id: CASE_ID, direction: 'inbound', sender: email.sender, recipient: email.to, cc: email.cc, subject: email.subject, body_text: email.bodyText, gmail_message_id: 'g-stmt-2', created_at: NOW });
    const r = await testUtils._fileEmailStatementForS80(ITEM2, { emailMeta: email, currentMsgId: 'g-stmt-2', messageRowId: 'msg-stmt-2', senderRole: 'practice' });
    expect(r.filed).toBe('note');
    const t = taskById(ITEM2);
    expect(t.metadata.upload).toBeUndefined();
    expect(t.metadata.practice_reply.excerpt).toContain('I am at the doctors Werribee full time.');
    expect(t.metadata.practice_reply.excerpt).not.toContain('Dear Dr Ranatunga');
    expect(t.metadata.practice_reply.officer_copied).toBe(false);
    expect(t.metadata.practice_reply.message_id).toBe('msg-stmt-2');
    // One click: use that email as the statement.
    const bad = await adminPost('/api/admin/ahpra/item/practice-statement', { task_id: ITEM2, message_id: 'msg-stmt-1' });
    expect(bad.status).toBe(404);   // a reply on another item is refused
    const ok = await adminPost('/api/admin/ahpra/item/practice-statement', { task_id: ITEM2, message_id: 'msg-stmt-2' });
    expect(ok.status).toBe(200);
    expect(ok.body.officer_copied).toBe(false);
    const t2 = taskById(ITEM2);
    expect(t2.status).toBe('waiting');
    expect(t2.metadata.practice_reply).toBeUndefined();
    expect(t2.metadata.upload.kind).toBe('email_statement');
    expect(t2.metadata.upload.uploaded_by).toBe('admin_statement');
    expect(t2.metadata.upload.filed_by).toBe(SUPER_EMAIL);
    expect(t2.metadata.upload.delivered_to_officer).toBeUndefined();
    expect(t2.metadata.upload.statement_text).toBe('Hazel I have explained this directly to Paige today. I am at the doctors Werribee full time. There is no changes in working there\n\nThanks');
  });

  it('never files the doctor\'s own words as the practice\'s statement, and ignores the officer and a few-word reply', async () => {
    const ITEM3 = 't-stmt-item-3';
    db.registration_tasks.push({ id: ITEM3, case_id: CASE_ID, task_type: 'ahpra_action_item', title: 'Supervisor availability statement (Dr Ranatunga)', status: 'open', ahpra_deadline: '2026-10-13', metadata: itemMeta({}) });
    const gpEmail = { sender: GP.email, to: 'registration@mygplink.com.au, paige.hooper@ahpra.gov.au', cc: '', subject: 'Re: AHPRA', date: NOW, bodyText: 'Hi, my supervisor Dr Ranatunga is full time at The Doctors Werribee and will supervise me every day I am there.' };
    const r1 = await testUtils._fileEmailStatementForS80(ITEM3, { emailMeta: gpEmail, currentMsgId: 'g-3a', messageRowId: null, senderRole: 'candidate' });
    expect(r1.filed).toBe('note');   // shown on the card, never filed as the practice's statement
    expect(taskById(ITEM3).metadata.upload).toBeUndefined();
    expect(taskById(ITEM3).metadata.practice_reply.excerpt).toContain('my supervisor Dr Ranatunga is full time');
    const r2 = await testUtils._fileEmailStatementForS80(ITEM3, { emailMeta: { sender: OFFICER, to: 'registration@mygplink.com.au', subject: 'RE: x', bodyText: 'Please provide the statement by 13 October 2026, thank you.' }, currentMsgId: 'g-3b' });
    expect(r2.filed).toBe(false);
    expect(r2.reason).toBe('sender');
    const r3 = await testUtils._fileEmailStatementForS80(ITEM3, { emailMeta: { sender: 'chamiraranatunga@yahoo.com', to: 'registration@mygplink.com.au, paige.hooper@ahpra.gov.au', subject: 'Re: x', bodyText: 'Will do, thanks.' }, currentMsgId: 'g-3c', senderRole: 'practice' });
    expect(r3.filed).toBe(false);
    expect(r3.reason).toBe('too_short');
    expect(taskById(ITEM3).metadata.upload).toBeUndefined();
    // Neither the officer's email nor the few-word reply touched the note left by the doctor's email.
    expect(taskById(ITEM3).metadata.practice_reply.gmail_message_id).toBe('g-3a');
  });
});

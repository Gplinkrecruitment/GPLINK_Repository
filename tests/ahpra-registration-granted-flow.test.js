// AHPRA registration granted → visa stage, end to end against the real server and an
// in-memory Supabase (REST + storage stub). Owner spec 2026-11-05.
//
// Covers:
//  1. preFilterEmail keeps an AHPRA officer email with PDF/DOCX attachments on the triage track.
//  2. processAhpraGrantEmail (fake Gmail client): downloads the letters, reads the registration
//     (regex fallback: no model key here), records it on the case, files the two letters into
//     My Documents with notifyGp:false, closes the AHPRA tasks, moves the GP to visa with the
//     same user_state overrides the staff control writes, opens the Subclass 482 visa case with
//     the practice as sponsor, creates the dependants + passport requests, raises the verify /
//     migration_agent / visa_stage cards with their drafts, the conditions tracker, and the
//     timeline event.
//  3. Idempotent: the same message (or a second mailbox's copy carrying the same number) is a no-op.
//  4. Manual path (POST /api/admin/ahpra/registration-granted) for a doctor moving alone.
//  5. The send endpoints fail soft / guard, and the reprocess endpoint's auth + validation.
//  6. GET /api/visa/status carries registration + stage_context + labelled requests;
//     POST /api/visa/documents fulfils a request row by documentId (and names the dependant);
//     POST /api/visa/dependants returns the passport request it created.
//  7. applyVerifiedStageToGp clears the override when asked.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-reg-granted-${RUN_ID}.json`);
let server, port, sbServer, sbPort, utils;

const SUPER_HOST = 'ceo-reg.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const RSO_ID = 'rso-reg-1';
const GP = { userId: 'u-reg-gp-1', email: 'mercy@gplink-test.local', caseId: 'case-reg-1' };
const GP2 = { userId: 'u-reg-gp-2', email: 'solo@gplink-test.local', caseId: 'case-reg-2' };
const NOW = new Date().toISOString();
const MSG_ID = 'gmail-msg-final-notice-1';

let db;
function freshDb() {
  return {
    user_profiles: [
      { user_id: GP.userId, email: GP.email, first_name: 'Mercy', last_name: 'Obanimoh', phone: '+61400000001', who_moving: 'me_partner_children', children_count: '2', registration_country: 'United Kingdom' },
      { user_id: GP2.userId, email: GP2.email, first_name: 'Sam', last_name: 'Solo', phone: '', who_moving: 'just_me', children_count: '', registration_country: 'Ireland' }
    ],
    user_state: [
      { user_id: GP.userId, state: { gp_onboarding_complete: true, gp_ahpra_progress: JSON.stringify({ completed: { account_establishment: true }, stage: 'upload_qualifications' }) }, updated_at: NOW },
      { user_id: GP2.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }
    ],
    registration_cases: [
      { id: GP.caseId, user_id: GP.userId, status: 'active', stage: 'ahpra', substage: 'waiting_verification', assigned_va: RSO_ID, assigned_rso: RSO_ID,
        practice_name: 'The Doctors Werribee', practice_contact: 'pm@werribee-test.local', practice_contact_email: 'pm@werribee-test.local', practice_contact_name: 'Naomi Milne',
        ahpra_officer_email: 'jane.officer@ahpra.gov.au', ahpra_application_number: null, metadata: {} },
      { id: GP2.caseId, user_id: GP2.userId, status: 'active', stage: 'ahpra', assigned_va: RSO_ID, assigned_rso: RSO_ID, practice_name: '', practice_contact: '', metadata: {} }
    ],
    rso_team: [{ user_id: RSO_ID, name: 'Priya Test', email: 'priya@gplink-test.local', phone: '', active: true, calendly_event_url: '' }],
    ats_offers: [
      { id: 'off-reg-1', application_id: 'app-reg-1', user_id: GP.userId, practice_name: 'The Doctors Werribee', compensation_note: 'Practice covers visa and relocation costs for the primary applicant', start_date: '2027-01-25', status: 'accepted', created_at: NOW }
    ],
    registration_tasks: [
      { id: 't-ahpra-card', case_id: GP.caseId, task_type: 'ahpra_correspondence', title: 'AHPRA application update', status: 'open', related_stage: 'ahpra', metadata: {} },
      { id: 't-ahpra-item', case_id: GP.caseId, task_type: 'ahpra_action_item', title: 'Certified CV', status: 'waiting_on_gp', related_stage: 'ahpra', metadata: {} },
      { id: 't-ahpra-done', case_id: GP.caseId, task_type: 'ahpra_action_item', title: 'Old item', status: 'completed', related_stage: 'ahpra', metadata: {} },
      { id: 't-other', case_id: GP.caseId, task_type: 'followup', title: 'Chase indemnity quote', status: 'open', related_stage: 'commencement', metadata: {} },
      { id: 't-other-case', case_id: GP2.caseId, task_type: 'ahpra_correspondence', title: 'Other GP card', status: 'open', related_stage: 'ahpra', metadata: {} }
    ],
    task_timeline: [], task_messages: [], user_documents: [], visa_applications: [], visa_dependants: [], visa_documents: [],
    visa_timeline_events: [], visa_updates: [], processed_gmail_messages: [], gp_applications: [], placements: [], practices: [], career_roles: [],
    practice_detected_contacts: [], storage_objects: [], email_suppressions: [], runtime_kv: []
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
    if (f.op === 'in') return f.val.replace(/^\(/, '').replace(/\)$/, '').split(',').map((s) => s.trim().replace(/^"/, '').replace(/"$/, '')).includes(String(cell));
    return true;
  });
}

function startEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      const readBody = () => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });
      if (u.pathname.startsWith('/storage/v1/object/sign/')) { await readBody(); send(200, { signedURL: '/object/sign/x?token=t' }); return; }
      if (u.pathname.startsWith('/storage/v1/object/')) {
        const body = await readBody();
        tableOf('storage_objects').push({ key: u.pathname.replace('/storage/v1/object/', ''), method: req.method, bytes: body.length });
        send(200, { Key: u.pathname }); return;
      }
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const rows = tableOf(decodeURIComponent(m[1]));
      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out); return;
      }
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody()).toString('utf8') || 'null');
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const conflictCol = u.searchParams.get('on_conflict');
        const saved = incoming.map((r) => {
          if (conflictCol) {
            const existing = rows.find((row) => row && String(row[conflictCol]) === String(r[conflictCol]));
            if (existing) { Object.assign(existing, r); return existing; }
          }
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          rows.push(row); return row;
        });
        send(201, saved); return;
      }
      if (req.method === 'PATCH') {
        const patch = JSON.parse((await readBody()).toString('utf8') || 'null');
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched); return;
      }
      if (req.method === 'DELETE') {
        const keep = rows.filter((row) => !matches(row)); rows.length = 0; keep.forEach((row) => rows.push(row)); send(200, []); return;
      }
      send(405, { message: 'method not allowed' });
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
function userCookie(who) {
  const payload = b64url(JSON.stringify({ userProfile: { email: who.email, supabaseUserId: who.userId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { cookie, body, host, headers: extra } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = Object.assign({}, extra || {});
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
const adminPost = (p, body, headers) => httpReq('POST', p, { host: SUPER_HOST, cookie: adminCookie(), body, headers });
const gpGet = (p, who) => httpReq('GET', p, { cookie: userCookie(who), host: 'app.local' });
const gpPost = (p, body, who) => httpReq('POST', p, { cookie: userCookie(who), host: 'app.local', body });
const taskById = (id) => db.registration_tasks.find((t) => t.id === id);
const caseById = (id) => db.registration_cases.find((c) => c.id === id);

// The officer's email as extractEmailMeta would return it, with Gmail attachment ids.
const FINAL_NOTICE_PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n', 'utf8');
const SCHEDULE_DOCX = Buffer.from('PK\u0003\u0004 schedule of conditions', 'utf8');
const FACT_SHEET_PDF = Buffer.from('%PDF-1.4 appeals fact sheet', 'utf8');
const EMAIL_META = {
  messageId: MSG_ID, threadId: 'thread-final-1',
  sender: 'jane.officer@ahpra.gov.au', senderName: 'Jane Officer',
  subject: 'Ahpra – Final Notice of Registration – APP-1234567890',
  to: 'Mercy Obanimoh <' + GP.email + '>', cc: 'hazel@mygplink.com.au', date: 'Thu, 5 Nov 2026 09:00:00 +1100',
  bodyText: [
    'Dear Dr Obanimoh,',
    'Please find the attached final notice of registration with conditions and the schedule of conditions.',
    'Your registration is made effective from 2 November 2026 and will remain current until 30 September 2027.',
    'Your registration number is MED0004091669.',
    'Position: General Practitioner Employer: The Doctors Werribee, Werribee VIC Level of supervision: Indirect 2 Primary Supervisor: Dr Chamira Ranatunga Commencement: 25 January 2027',
    'The Board has set a review period of 6 months.'
  ].join('\n\n'),
  bodyHtml: null, rfc822MessageId: '<final-notice-1@ahpra.gov.au>', rfc822References: '', inReplyTo: '', headers: {},
  attachments: [
    { index: 0, filename: 'Final notice - Specialist registration with conditions - ESP - Obanimoh, Mercy - APP-1234567890.PDF', mimeType: 'application/pdf', attachmentId: 'att-notice', size: FINAL_NOTICE_PDF.length },
    { index: 1, filename: 'Schedule of conditions - Mercy Obanimoh - APP-1234567890.DOCX', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', attachmentId: 'att-schedule', size: SCHEDULE_DOCX.length },
    { index: 2, filename: 'Appeals fact sheet.pdf', mimeType: 'application/pdf', attachmentId: 'att-fact', size: FACT_SHEET_PDF.length }
  ],
  hasAttachments: true
};
const ATTACHMENT_BYTES = { 'att-notice': FINAL_NOTICE_PDF, 'att-schedule': SCHEDULE_DOCX, 'att-fact': FACT_SHEET_PDF };
const downloaded = [];
const fakeGmail = {
  users: { messages: { attachments: { get: async ({ userId, messageId, id }) => {
    downloaded.push({ userId, messageId, id });
    return { data: { data: ATTACHMENT_BYTES[id].toString('base64url'), size: ATTACHMENT_BYTES[id].length } };
  } } } }
};

beforeAll(async () => {
  db = freshDb();
  await startEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'reg-granted-secret-' + RUN_ID;
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
  process.env.CRON_SECRET = 'cron-secret-' + RUN_ID;
  process.env.APP_BASE_URL = 'https://app.mygplink.com.au';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = '';
  const mod = await import('../server.js');
  utils = mod.__testUtils || mod.default?.__testUtils;
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
});

describe('preFilterEmail: AHPRA officer mail always takes the triage track', () => {
  it('keeps the Final Notice (PDF + DOCX attached) on triage; other mail with documents still goes to attachments', () => {
    expect(utils.preFilterEmail(EMAIL_META)).toEqual({ pass: true, reason: null, track: 'triage' });
    expect(utils.preFilterEmail({ sender: 'pm@practice.example', subject: 'CV', headers: {}, attachments: [{ filename: 'cv.pdf' }] }).track).toBe('attachments');
    expect(utils.preFilterEmail({ sender: 'pm@practice.example', subject: 'Hi', headers: {}, attachments: [] }).track).toBe('triage');
  });
});

describe('processAhpraGrantEmail → handleAhpraRegistrationGranted (email path)', () => {
  let summary;
  beforeAll(async () => {
    summary = await utils.processAhpraGrantEmail({ gpCase: { id: GP.caseId, user_id: GP.userId }, emailMeta: EMAIL_META, gmailMessageId: MSG_ID, mailbox: 'hazel@mygplink.com.au', gmail: fakeGmail, actor: 'ahpra_email_pipeline' });
  });

  it('runs clean, downloads the letters from the mailbox being scanned and reads the registration (regex fallback without a model key)', () => {
    expect(summary.errors).toEqual([]);
    expect(summary.ok).toBe(true);
    expect(summary.already).toBe(false);
    expect(downloaded.map((d) => d.id).sort()).toEqual(['att-fact', 'att-notice', 'att-schedule']);
    expect(downloaded.every((d) => d.userId === 'hazel@mygplink.com.au' && d.messageId === MSG_ID)).toBe(true);
    expect(summary.parse_source).toBe('regex');
    expect(summary.parsed_number).toBe('MED0004091669');
  });

  it('records the registration on the case and marks it verified at the visa stage', () => {
    const c = caseById(GP.caseId);
    expect(c.ahpra_registration_number).toBe('MED0004091669');
    expect(c.ahpra_registration_effective_date).toBe('2026-11-02');
    expect(c.ahpra_registration_expiry_date).toBe('2027-09-30');
    expect(c.ahpra_registration_has_conditions).toBe(true);
    expect(c.ahpra_registration_granted_at).toBeTruthy();
    expect(c.ahpra_registration_source_gmail_message_id).toBe(MSG_ID);
    expect(c.ahpra_registration_conditions.supervised_practice).toMatchObject({ supervisor: 'Dr Chamira Ranatunga', level: 'Indirect 2', commencement_date: '2027-01-25', employer: 'The Doctors Werribee' });
    expect(c.ahpra_registration_conditions.review_period_months).toBe(6);
    expect(c.ahpra_application_number).toBe('APP-1234567890');
    expect(c.gp_verified_stage).toBe('visa');
    expect(c.sponsor_name).toBe('The Doctors Werribee');
    expect(c.sponsor_contact).toBe('pm@werribee-test.local');
    expect(c.ahpra_registration_conditions.source_rfc822_message_id).toBe('<final-notice-1@ahpra.gov.au>');
    expect(c.metadata).toEqual({});
  });

  it('files the final notice and the schedule of conditions into My Documents (not the fact sheet), with no "document delivered" email', () => {
    const stored = summary.filed.filter((f) => f.stored);
    expect(stored.map((f) => f.document_key).sort()).toEqual(['ahpra_conditions_schedule', 'ahpra_registration_notice']);
    expect(summary.filed.find((f) => /fact sheet/i.test(f.filename))).toBeUndefined();
    const docs = db.user_documents.filter((d) => d.user_id === GP.userId);
    expect(docs.map((d) => d.document_key).sort()).toEqual(['ahpra_conditions_schedule', 'ahpra_registration_notice']);
    expect(docs.every((d) => d.status === 'approved' && d.storage_path && d.file_url === d.storage_path)).toBe(true);
    expect(db.storage_objects.filter((o) => /gplink-delivered\/ahpra_/.test(o.key))).toHaveLength(2);
    expect(summary.attachments.find((a) => /fact sheet/i.test(a.filename)).document_key).toBeNull();
  });

  it('closes every open AHPRA task on the case (and nothing else)', () => {
    expect(summary.closed.sort()).toEqual(['t-ahpra-card', 't-ahpra-item']);
    expect(taskById('t-ahpra-card').status).toBe('completed');
    expect(taskById('t-ahpra-item').status).toBe('completed');
    expect(taskById('t-ahpra-item').completed_by).toBe('system');
    expect(taskById('t-other').status).toBe('open');
    expect(taskById('t-other-case').status).toBe('open');
    const notes = db.task_timeline.filter((e) => e.title === 'Closed: AHPRA registration granted');
    expect(notes.map((n) => n.task_id).sort()).toEqual(['t-ahpra-card', 't-ahpra-item']);
  });

  it('moves the GP to visa the way the staff "verified stage" control does (user_state overrides + case stage + event)', () => {
    expect(summary.stage).toBe('visa');
    const c = caseById(GP.caseId);
    expect(c.stage).toBe('visa');
    expect(c.substage).toBeNull();
    const st = db.user_state.find((s) => s.user_id === GP.userId).state;
    expect(st.gp_admin_stage_override).toBe(JSON.stringify('visa'));
    expect(st.gp_stage_override_at).toBeTruthy();
    const overrides = JSON.parse(st.gp_registration_return_overrides);
    expect(overrides).toMatchObject({ placement: true, myintealth: true, amc: true, career: true, ahpra: true, visa: true, pbs: false, commencement: false });
    expect(JSON.parse(st.gp_ahpra_progress).completed.verification_issued).toBe(true);
    expect(JSON.parse(st.gp_epic_progress).stage).toBe('verification_issued');
    expect(JSON.parse(st.gp_amc_progress).stage).toBe('qualifications_verified');
    expect(st.gp_link_updates[0].title).toBe('Registration Updated');
    const ev = db.task_timeline.find((e) => e.case_id === GP.caseId && e.event_type === 'stage_change');
    expect(ev.title).toBe('Stage set to visa (AHPRA registration granted)');
    expect(ev.metadata).toEqual({ from_stage: 'ahpra', to_stage: 'visa' });
  });

  it('opens the Subclass 482 visa case with the practice as sponsor, links it to the case and logs a GP-visible event', () => {
    const apps = db.visa_applications.filter((a) => a.user_id === GP.userId);
    expect(apps).toHaveLength(1);
    const app = apps[0];
    expect(summary.visaCaseId).toBe(app.id);
    expect(app).toMatchObject({
      visa_subclass: '482', visa_type: 'Subclass 482 (employer sponsored)', stage: 'nomination',
      sponsor_name: 'The Doctors Werribee', sponsor_contact: 'pm@werribee-test.local', responsible_party: 'practice',
      current_action_title: 'Practice engaging a migration agent',
      current_action_description: 'We have asked The Doctors Werribee to confirm which migration agent will handle the nomination and visa.',
      current_action_owner: 'The Doctors Werribee', estimated_timeline: 'Agent engaged, then nomination and lodgement'
    });
    expect(app.status_message).toBe('Now that your AHPRA registration is through, The Doctors Werribee is engaging a registered migration agent to sponsor your Subclass 482 visa. The agent prepares the nomination with the practice and lodges the visa. You do not need to lodge anything yourself. The practice covers the visa costs for you as the primary applicant, as set out in your offer.');
    expect(caseById(GP.caseId).visa_case_id).toBe(app.id);
    const ev = db.visa_timeline_events.find((e) => e.visa_case_id === app.id);
    expect(ev).toMatchObject({ event_title: 'AHPRA registration granted, visa case opened', visible_to_gp: true });
    expect(ev.event_description).toContain('MED0004091669');
  });

  it('creates the dependants from who_moving/children_count and one passport request per person', () => {
    const app = db.visa_applications[0];
    const deps = db.visa_dependants.filter((d) => d.visa_case_id === app.id);
    expect(deps.map((d) => [d.relationship, d.full_name, d.visa_status])).toEqual([
      ['spouse', 'Partner (name to be confirmed)', 'included'], ['child', 'Child 1', 'included'], ['child', 'Child 2', 'included']
    ]);
    expect(summary.dependants).toBe(3);
    const reqs = db.visa_documents.filter((d) => d.visa_application_id === app.id);
    expect(reqs.map((r) => r.label)).toEqual(['Your passport', "Partner's passport", 'Child 1 passport', 'Child 2 passport']);
    expect(reqs[0].dependant_id).toBeNull();
    expect(reqs[1].dependant_id).toBe(deps[0].id);
    expect(reqs[3].dependant_id).toBe(deps[2].id);
    expect(reqs.every((r) => r.document_type === 'passport' && r.status === 'missing' && r.file_path === '' && r.verified === false && r.requested_by === 'system' && r.requested_at && /passport photo page/.test(r.request_note))).toBe(true);
    expect(summary.passportRequests).toBe(4);
  });

  it('raises the verify card for the RSO with the register link and checklist', () => {
    const t = db.registration_tasks.find((x) => x.case_id === GP.caseId && x.task_type === 'verify');
    expect(t).toBeTruthy();
    expect(t.title).toBe('AHPRA registration granted — confirm details (MED0004091669)');
    expect(t).toMatchObject({ priority: 'high', status: 'open', related_stage: 'visa', assignee: RSO_ID, source_gmail_message_id: MSG_ID });
    expect(t.metadata).toMatchObject({ registration_granted: true, registration_number: 'MED0004091669', source: 'email', source_gmail_message_id: MSG_ID });
    expect(t.description).toContain('https://www.ahpra.gov.au/Registration/Registers-of-Practitioners.aspx');
    expect(t.description).toContain('Reply to the AHPRA officer to acknowledge receipt');
    expect(t.description).toContain('registration-milestone invoice');
    expect(t.description).toContain('Effective from: 2 November 2026');
    const due = (Date.parse(t.due_date) - Date.now()) / 86400000;
    expect(due).toBeGreaterThan(0.5); expect(due).toBeLessThan(2.5);
  });

  it('raises the migration_agent card carrying the practice email draft (no dashes, right recipient, visa costs line)', () => {
    const t = db.registration_tasks.find((x) => x.case_id === GP.caseId && x.task_type === 'migration_agent');
    expect(t.title).toBe("Email The Doctors Werribee: congratulate on Dr Obanimoh's registration and ask them to engage a migration agent");
    expect(t).toMatchObject({ priority: 'high', status: 'open', related_stage: 'visa', assignee: RSO_ID });
    const d = t.metadata.outbound_email;
    expect(d.to).toBe('pm@werribee-test.local');
    expect(d.subject).toBe('Dr Mercy Obanimoh AHPRA registration approved, next step is the visa');
    expect(d.bodyText.startsWith('Hi Naomi,')).toBe(true);
    expect(d.bodyText).toContain('under Dr Chamira Ranatunga, with commencement planned for 25 January 2027');
    expect(d.bodyText).toContain('covers the visa costs for Dr Obanimoh');
    expect(d.bodyText).toContain('Priya Test\nGP Link');
    expect(d.bodyText).not.toMatch(/[-‐-―]/);
    expect(d.bodyHtml).not.toMatch(/[-‐-―]/);
    expect(t.metadata.practice_covers_visa_costs).toBe(true);
  });

  it('raises the visa_stage card carrying the GP email + WhatsApp request', () => {
    const t = db.registration_tasks.find((x) => x.case_id === GP.caseId && x.task_type === 'visa_stage');
    expect(t.title).toBe('Request passports from Dr Obanimoh and family (email + WhatsApp)');
    expect(t).toMatchObject({ priority: 'high', status: 'open', related_stage: 'visa', assignee: RSO_ID });
    const g = t.metadata.gp_request;
    expect(g.email).toMatchObject({ subject: 'Congratulations Dr Obanimoh, your AHPRA registration is approved', title: 'Congratulations, {{name}}!', ctaText: 'Open your visa page', ctaUrl: 'https://app.mygplink.com.au/pages/visa' });
    expect(g.email.body).toContain('MED0004091669');
    expect(g.email.body).toContain('• Child 2 passport');
    expect(g.whatsapp).toEqual({ templateName: 'gp_link_visa_passports', placeholders: ['Mercy', 'https://app.mygplink.com.au/pages/visa'] });
    expect(g.people).toEqual(['Your passport', "Partner's passport", 'Child 1 passport', 'Child 2 passport']);
    const due = (Date.parse(t.due_date) - Date.now()) / 86400000;
    expect(due).toBeGreaterThan(0); expect(due).toBeLessThan(1.5);
  });

  it('creates the conditions tracker (9 follow-ups, waiting except the Compliance letter watch)', () => {
    const tracker = db.registration_tasks.filter((x) => x.case_id === GP.caseId && x.metadata && x.metadata.conditions_tracker);
    expect(tracker).toHaveLength(9);
    expect(tracker.every((x) => x.task_type === 'followup' && x.related_stage === 'commencement' && x.assignee === RSO_ID && x.priority === 'normal')).toBe(true);
    const byTitle = Object.fromEntries(tracker.map((x) => [x.title, x]));
    expect(byTitle['GP to acknowledge AHPRA conditions to the Compliance Team']).toMatchObject({ status: 'waiting', due_date: '2026-12-02' });
    expect(byTitle['Watch for the AHPRA Compliance Team letter and file it']).toMatchObject({ status: 'open', due_date: '2026-11-16' });
    expect(byTitle['3-month supervision report']).toMatchObject({ status: 'waiting', due_date: '2027-04-25' });
    expect(byTitle['Multi-source feedback (CFEP) within 5 months'].due_date).toBe('2027-06-25');
    expect(byTitle['Final 6-month supervision report'].due_date).toBe('2027-07-25');
    expect(byTitle['AHPRA registration renewal before expiry'].due_date).toBe('2027-08-31');
    expect(summary.tasks.filter((t) => !t.existing)).toHaveLength(12);
  });

  it('writes the case timeline event', () => {
    const ev = db.task_timeline.find((e) => e.case_id === GP.caseId && e.event_type === 'system' && /^AHPRA registration granted/.test(e.title));
    expect(ev.title).toBe('AHPRA registration granted — MED0004091669, effective 2 November 2026, current to 30 September 2027');
    expect(ev.actor).toBe('ahpra_email_pipeline');
    expect(ev.metadata.visa_case_id).toBe(db.visa_applications[0].id);
  });

  it('is idempotent: the same message, or another mailbox\'s copy with the same number, changes nothing', async () => {
    const before = JSON.stringify([db.registration_tasks.length, db.visa_applications.length, db.visa_documents.length, db.visa_dependants.length, db.user_documents.length, db.task_timeline.length]);
    const again = await utils.processAhpraGrantEmail({ gpCase: { id: GP.caseId, user_id: GP.userId }, emailMeta: EMAIL_META, gmailMessageId: MSG_ID, mailbox: 'hazel@mygplink.com.au', gmail: fakeGmail });
    expect(again.ok).toBe(true); expect(again.already).toBe(true);
    const copy = await utils.processAhpraGrantEmail({ gpCase: { id: GP.caseId, user_id: GP.userId }, emailMeta: Object.assign({}, EMAIL_META, { messageId: 'other-mailbox-copy', rfc822MessageId: '<something-else>' }), gmailMessageId: 'other-mailbox-copy', mailbox: 'registration@mygplink.com.au', gmail: fakeGmail });
    expect(copy.already).toBe(true);
    const direct = await utils.handleAhpraRegistrationGranted({ caseId: GP.caseId, userId: GP.userId, source: { type: 'email', gmailMessageId: MSG_ID }, registration: { registration_number: 'MED0004091669' } });
    expect(direct.already).toBe(true);
    expect(JSON.stringify([db.registration_tasks.length, db.visa_applications.length, db.visa_documents.length, db.visa_dependants.length, db.user_documents.length, db.task_timeline.length])).toBe(before);
  });

  it('repair: re-creates a missing card without re-recording the grant or moving the stage again', async () => {
    const stageEventsBefore = db.task_timeline.filter((e) => e.case_id === GP.caseId && e.event_type === 'stage_change').length;
    const headlineBefore = db.task_timeline.filter((e) => e.case_id === GP.caseId && /AHPRA registration granted — MED/.test(e.title || '')).length;
    const recordedAt = db.registration_cases.find((c) => c.id === GP.caseId).ahpra_registration_granted_at;
    db.registration_tasks = db.registration_tasks.filter((t) => !(t.case_id === GP.caseId && t.task_type === 'visa_stage'));
    const out = await utils.processAhpraGrantEmail({ gpCase: { id: GP.caseId, user_id: GP.userId }, emailMeta: EMAIL_META, gmailMessageId: MSG_ID, mailbox: 'hazel@mygplink.com.au', gmail: fakeGmail, repair: true });
    expect(out.ok).toBe(true);
    expect(out.already).toBe(true);
    expect(out.repair).toBe(true);
    expect(db.registration_tasks.filter((t) => t.case_id === GP.caseId && t.task_type === 'visa_stage').length).toBe(1);
    expect(db.registration_tasks.filter((t) => t.case_id === GP.caseId && t.task_type === 'migration_agent').length).toBe(1);
    expect(db.registration_cases.find((c) => c.id === GP.caseId).ahpra_registration_granted_at).toBe(recordedAt);
    expect(db.task_timeline.filter((e) => e.case_id === GP.caseId && e.event_type === 'stage_change').length).toBe(stageEventsBefore);
    expect(db.task_timeline.filter((e) => e.case_id === GP.caseId && /AHPRA registration granted — MED/.test(e.title || '')).length).toBe(headlineBefore);
    expect(db.visa_applications.filter((v) => v.user_id === GP.userId).length).toBe(1);
  });
});

describe('manual path: POST /api/admin/ahpra/registration-granted', () => {
  it('rejects a malformed registration number and an unknown GP', async () => {
    let r = await adminPost('/api/admin/ahpra/registration-granted', { caseId: GP2.caseId, registrationNumber: 'MED123' });
    expect(r.status).toBe(400);
    r = await adminPost('/api/admin/ahpra/registration-granted', { gpEmail: 'nobody@gplink-test.local', registrationNumber: 'MED0000000002' });
    expect(r.status).toBe(404);
  });
  it('records a hand-entered grant for a doctor moving alone, with the optional letter filed, and no visa-costs line without an offer', async () => {
    const r = await adminPost('/api/admin/ahpra/registration-granted', {
      gpEmail: GP2.email, registrationNumber: 'med 0000000002', registrationType: 'Specialist registration',
      effectiveDate: '2026-11-03', expiryDate: '2027-09-30', hasConditions: true, conditionsSummary: 'Supervised practice.',
      commencementDate: '2027-03-01', supervisor: 'Dr Sup', supervisionLevel: 'Indirect 1',
      fileDataUrl: 'data:application/pdf;base64,' + FINAL_NOTICE_PDF.toString('base64'), fileName: 'Final notice.pdf', mimeType: 'application/pdf'
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.errors).toEqual([]);
    expect(r.body.caseId).toBe(GP2.caseId);
    const c = caseById(GP2.caseId);
    expect(c.ahpra_registration_number).toBe('MED0000000002');
    expect(c.ahpra_registration_source_gmail_message_id).toBeNull();
    expect(c.stage).toBe('visa');
    expect(db.user_documents.find((d) => d.user_id === GP2.userId && d.document_key === 'ahpra_registration_notice')).toBeTruthy();
    const app = db.visa_applications.find((a) => a.user_id === GP2.userId);
    expect(app.status_message).not.toMatch(/visa costs/);
    expect(app.sponsor_name).toBeNull();
    expect(db.visa_dependants.filter((d) => d.visa_case_id === app.id)).toHaveLength(0);
    expect(db.visa_documents.filter((d) => d.visa_application_id === app.id).map((d) => d.label)).toEqual(['Your passport']);
    expect(taskById('t-other-case').status).toBe('completed');
    const verify = db.registration_tasks.find((t) => t.case_id === GP2.caseId && t.task_type === 'verify');
    expect(verify.metadata.source).toBe('manual');
    expect(verify.source_gmail_message_id).toBeNull();
    const ev = db.task_timeline.find((e) => e.case_id === GP2.caseId && e.event_type === 'system' && /^AHPRA registration granted/.test(e.title));
    expect(ev.actor).toBe(SUPER_EMAIL);
  });
  it('a second manual post is a no-op (already recorded)', async () => {
    const n = db.registration_tasks.length;
    const r = await adminPost('/api/admin/ahpra/registration-granted', { caseId: GP2.caseId, registrationNumber: 'MED0000000002' });
    expect(r.status).toBe(200);
    expect(r.body.already).toBe(true);
    expect(db.registration_tasks.length).toBe(n);
  });
});

describe('send endpoints (guarded, fail-soft) and reprocess auth', () => {
  it('send-practice-email: needs a draft-carrying task, refuses an internal note, and reports a failed send honestly', async () => {
    const verify = db.registration_tasks.find((t) => t.case_id === GP.caseId && t.task_type === 'verify');
    const agent = db.registration_tasks.find((t) => t.case_id === GP.caseId && t.task_type === 'migration_agent');
    let r = await adminPost('/api/admin/registration-granted/send-practice-email', { task_id: verify.id });
    expect(r.status).toBe(400);
    r = await adminPost('/api/admin/registration-granted/send-practice-email', { task_id: 'nope' });
    expect(r.status).toBe(404);
    r = await adminPost('/api/admin/registration-granted/send-practice-email', { task_id: agent.id, bodyHtml: '<p>Hi Naomi</p><p>[RSO: check the cc field]</p>' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('internal_note_in_body');
    r = await adminPost('/api/admin/registration-granted/send-practice-email', { task_id: agent.id, to: 'not-an-email' });
    expect(r.status).toBe(400);
    // Gmail is not configured in this harness: the send fails and the task stays open, unsent.
    r = await adminPost('/api/admin/registration-granted/send-practice-email', { task_id: agent.id });
    expect(r.status).toBe(502);
    expect(r.body.ok).toBe(false);
    expect(taskById(agent.id).status).toBe('open');
    expect(taskById(agent.id).metadata.outbound_email.sent_at).toBeUndefined();
  });
  it('send-gp-request: with neither email nor WhatsApp configured it answers 502 and records both reasons without moving the task', async () => {
    const t = db.registration_tasks.find((x) => x.case_id === GP.caseId && x.task_type === 'visa_stage');
    let r = await adminPost('/api/admin/registration-granted/send-gp-request', { task_id: 'nope' });
    expect(r.status).toBe(404);
    r = await adminPost('/api/admin/registration-granted/send-gp-request', { task_id: t.id });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, email: { ok: false }, whatsapp: { ok: false, error: 'no_api_key' } });
    expect(taskById(t.id).status).toBe('open');
    expect(taskById(t.id).metadata.gp_request.whatsapp.error).toBe('no_api_key');
    expect(taskById(t.id).metadata.gp_request.email_sent_at).toBeNull();
  });
  it('reprocess-message: wrong cron secret and no session → 401; admin session → validation; Gmail unavailable → 503', async () => {
    let r = await httpReq('POST', '/api/admin/ahpra/reprocess-message', { host: SUPER_HOST, body: { mailbox: 'hazel@mygplink.com.au', gmailMessageId: MSG_ID }, headers: { Authorization: 'Bearer wrong' } });
    expect(r.status).toBe(401);
    r = await adminPost('/api/admin/ahpra/reprocess-message', { mailbox: 'hazel@mygplink.com.au' });
    expect(r.status).toBe(400);
    r = await httpReq('POST', '/api/admin/ahpra/reprocess-message', { host: SUPER_HOST, body: { mailbox: 'hazel@mygplink.com.au', gmailMessageId: MSG_ID }, headers: { Authorization: 'Bearer ' + process.env.CRON_SECRET } });
    expect(r.status).toBe(503);
    expect(r.body.message).toMatch(/Gmail is not available/);
  });
  it('resolveAhpraCaseForEmail matches on the To: address, then the application number, then the officer email', async () => {
    expect((await utils.resolveAhpraCaseForEmail(EMAIL_META))).toMatchObject({ method: 'recipient_email', gpCase: { id: GP.caseId } });
    expect((await utils.resolveAhpraCaseForEmail({ sender: 'jane.officer@ahpra.gov.au', to: 'hazel@mygplink.com.au', cc: '', subject: 'Ahpra - APP-1234567890', bodyText: '' }))).toMatchObject({ method: 'application_number', gpCase: { id: GP.caseId } });
    expect((await utils.resolveAhpraCaseForEmail({ sender: 'Jane Officer <jane.officer@ahpra.gov.au>', to: 'hazel@mygplink.com.au', cc: '', subject: 'Ahpra', bodyText: '' }))).toMatchObject({ method: 'officer_email', gpCase: { id: GP.caseId } });
    expect((await utils.resolveAhpraCaseForEmail({ sender: 'x@ahpra.gov.au', to: 'hazel@mygplink.com.au', subject: 'Ahpra', bodyText: '' })).gpCase).toBeNull();
  });
});

describe('GP visa endpoints', () => {
  it('GET /api/visa/status carries the registration, the stage context and the labelled passport requests', async () => {
    const r = await gpGet('/api/visa/status', GP);
    expect(r.status).toBe(200);
    expect(r.body.application.stage).toBe('nomination');
    expect(r.body.application).not.toHaveProperty('sponsor_contact');
    expect(r.body.registration).toEqual({
      number: 'MED0004091669', type: null, effective_date: '2026-11-02', expiry_date: '2027-09-30',
      granted_at: caseById(GP.caseId).ahpra_registration_granted_at, has_conditions: true,
      conditions: { summary: expect.any(String), items: [], review_period_months: 6, supervised_practice: expect.objectContaining({ supervisor: 'Dr Chamira Ranatunga' }), appeal_deadline_days: null }
    });
    expect(r.body.stage_context).toEqual({
      case_stage: 'visa', practice_name: 'The Doctors Werribee', planned_start: '2027-01-25', who_moving: 'me_partner_children', children_count: '2',
      rso_first_name: 'Priya', rso_whatsapp: expect.stringMatching(/^\+?\d+$/), migration_agent: null, sponsor_name: 'The Doctors Werribee'
    });
    expect(r.body.documents).toHaveLength(4);
    const partner = r.body.documents.find((d) => d.label === "Partner's passport");
    expect(partner).toMatchObject({ document_type: 'passport', status: 'missing', dependant_id: expect.any(String), requested_at: expect.any(String) });
    expect(partner.request_note).toMatch(/passport photo page/);
    expect(partner).not.toHaveProperty('file_path');
    expect(partner).not.toHaveProperty('requested_by');
    expect(r.body.dependants).toHaveLength(3);
  });
  it('GET /api/visa/status for a GP with no grant yet keeps registration null', async () => {
    db.user_profiles.push({ user_id: 'u-reg-gp-3', email: 'three@gplink-test.local', first_name: 'T', last_name: 'Three' });
    db.registration_cases.push({ id: 'case-reg-3', user_id: 'u-reg-gp-3', status: 'active', stage: 'amc', assigned_va: RSO_ID, metadata: {} });
    const r = await gpGet('/api/visa/status', { userId: 'u-reg-gp-3', email: 'three@gplink-test.local' });
    expect(r.status).toBe(200);
    expect(r.body.application).toBeNull();
    expect(r.body.registration).toBeNull();
    expect(r.body.stage_context.case_stage).toBe('amc');
  });
  it('POST /api/visa/documents with documentId fulfils the request row in place and names the dependant', async () => {
    const app = db.visa_applications.find((a) => a.user_id === GP.userId);
    const partnerReq = db.visa_documents.find((d) => d.visa_application_id === app.id && d.label === "Partner's passport");
    const r = await gpPost('/api/visa/documents', { visaApplicationId: app.id, documentId: partnerReq.id, fileDataUrl: 'data:application/pdf;base64,' + FINAL_NOTICE_PDF.toString('base64'), fileName: 'partner-passport.pdf', mimeType: 'application/pdf', dependant: { fullName: 'Alex Obanimoh', dateOfBirth: '1990-05-06' } }, GP);
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect(r.body.document.id).toBe(partnerReq.id);
    expect(partnerReq.status).toBe('uploaded');
    expect(partnerReq.original_file_name).toBe('partner-passport.pdf');
    expect(partnerReq.file_path).toMatch(/visa-documents\/.*passport-.*\/current$/);
    expect(partnerReq.uploaded_by_user_id).toBe(GP.userId);
    const dep = db.visa_dependants.find((d) => d.id === partnerReq.dependant_id);
    expect(dep.full_name).toBe('Alex Obanimoh');
    expect(dep.date_of_birth).toBe('1990-05-06');
    expect(db.visa_documents.filter((d) => d.visa_application_id === app.id)).toHaveLength(4); // no new row
    expect(db.visa_timeline_events.find((e) => e.event_title === "Partner's passport uploaded")).toBeTruthy();
  });
  it('POST /api/visa/documents refuses a documentId that is not on the doctor\'s own case and still inserts without one', async () => {
    const app = db.visa_applications.find((a) => a.user_id === GP.userId);
    const otherApp = db.visa_applications.find((a) => a.user_id === GP2.userId);
    const otherReq = db.visa_documents.find((d) => d.visa_application_id === otherApp.id);
    let r = await gpPost('/api/visa/documents', { visaApplicationId: app.id, documentId: otherReq.id, fileDataUrl: 'data:application/pdf;base64,' + FINAL_NOTICE_PDF.toString('base64'), fileName: 'x.pdf', mimeType: 'application/pdf' }, GP);
    expect(r.status).toBe(404);
    expect(otherReq.status).toBe('missing');
    r = await gpPost('/api/visa/documents', { visaApplicationId: app.id, documentType: 'police_check', fileDataUrl: 'data:application/pdf;base64,' + FINAL_NOTICE_PDF.toString('base64'), fileName: 'pc.pdf', mimeType: 'application/pdf' }, GP);
    expect(r.status).toBe(201);
    expect(db.visa_documents.filter((d) => d.visa_application_id === app.id)).toHaveLength(5);
  });
  it('POST /api/visa/dependants also creates and returns that person\'s passport request', async () => {
    const app = db.visa_applications.find((a) => a.user_id === GP.userId);
    const r = await gpPost('/api/visa/dependants', { caseId: app.id, fullName: 'Baby Obanimoh', relationship: 'child', dateOfBirth: '2026-01-01' }, GP);
    expect(r.status).toBe(201);
    expect(r.body.dependant.full_name).toBe('Baby Obanimoh');
    expect(r.body.passportRequest).toMatchObject({ document_type: 'passport', status: 'missing', label: "Baby Obanimoh's passport", dependant_id: r.body.dependant.id });
    expect(r.body.passportRequest).not.toHaveProperty('file_path');
    expect(db.visa_documents.find((d) => d.id === r.body.passportRequest.id).requested_by).toBe('system');
  });
});

describe('applyVerifiedStageToGp', () => {
  it('clears the override when given an empty stage and refuses an unknown stage', async () => {
    const cleared = await utils.applyVerifiedStageToGp(GP.caseId, GP.userId, '', 'tester');
    expect(cleared).toMatchObject({ ok: true, cleared: true });
    const st = db.user_state.find((s) => s.user_id === GP.userId).state;
    expect(st.gp_admin_stage_override).toBeUndefined();
    expect(st.gp_stage_override_at).toBeUndefined();
    expect((await utils.applyVerifiedStageToGp(GP.caseId, GP.userId, 'bogus', 'tester')).ok).toBe(false);
  });
  it('sets an earlier stage and maps career onto the amc case stage', async () => {
    const r = await utils.applyVerifiedStageToGp(GP.caseId, GP.userId, 'career', 'tester', { fromStage: 'visa' });
    expect(r).toMatchObject({ ok: true, caseStage: 'amc' });
    expect(caseById(GP.caseId).stage).toBe('amc');
    const st = db.user_state.find((s) => s.user_id === GP.userId).state;
    expect(JSON.parse(st.gp_registration_return_overrides)).toMatchObject({ career: true, ahpra: false });
    expect(JSON.parse(st.gp_ahpra_progress).completed).toEqual({});
    const ev = db.task_timeline.filter((e) => e.case_id === GP.caseId && e.event_type === 'stage_change').pop();
    expect(ev.title).toBe('Stage set to amc by VA verified stage');
    expect(ev.actor).toBe('tester');
  });
});

describe('after the first send: live passport status + reminder; the practice reply on the migration-agent card (owner 2026-11-08)', () => {
  it('gp-request-status says which passports are in and which are missing, and carries the reminder draft', async () => {
    const t = db.registration_tasks.find((x) => x.case_id === GP.caseId && x.task_type === 'visa_stage');
    let r = await httpReq('GET', '/api/admin/registration-granted/gp-request-status?task_id=nope', { host: SUPER_HOST, cookie: adminCookie() });
    expect(r.status).toBe(404);
    r = await httpReq('GET', '/api/admin/registration-granted/gp-request-status?task_id=' + t.id, { host: SUPER_HOST, cookie: adminCookie() });
    expect(r.status).toBe(200);
    // The GP visa tests above fulfilled the partner's passport request and added a fifth person (Baby Obanimoh).
    expect(r.body.received).toEqual(["Partner's passport"]);
    expect(r.body.outstanding).toEqual(['Your passport', 'Child 1 passport', 'Child 2 passport', "Baby Obanimoh's passport"]);
    expect(r.body.all_received).toBe(false);
    expect(r.body.people.map((p) => p.status)).toEqual(['missing', 'uploaded', 'missing', 'missing', 'missing']);
    expect(r.body.reminder_count).toBe(0);
    const rem = r.body.reminder;
    expect(rem.email.subject).toBe('A quick reminder about the passports for your visa, Dr Obanimoh');
    expect(rem.email.body).toContain("Thank you, we have your partner's passport already.");
    expect(rem.email.body).toContain("• Your passport\n• Child 1 passport\n• Child 2 passport\n• Baby Obanimoh's passport");
    expect(rem.email.body).not.toContain("• Partner's passport");
    expect(rem.email.body).toContain('The Doctors Werribee is engaging a migration agent');
    expect(rem.email.body).toContain('your start date of 25 January 2027 depends on it');
    expect(rem.email.body).toContain('Warm regards,\nPriya\nGP Link');
    expect(rem.email.body).not.toContain('AHPRA has approved');
    expect(rem.email.body).not.toMatch(/[-‐-―]/);
    expect(rem.whatsapp).toEqual({ templateName: 'gp_link_visa_passports_reminder', placeholders: ['Mercy', "your passport, your 2 children's passports and Baby Obanimoh's passport", 'https://app.mygplink.com.au/pages/visa'] });
  });

  it('send-gp-request kind:reminder refuses before the first request, sends afterwards (both legs unconfigured here → 502, nothing recorded), and refuses once every passport is in', async () => {
    const t = db.registration_tasks.find((x) => x.case_id === GP.caseId && x.task_type === 'visa_stage');
    let r = await adminPost('/api/admin/registration-granted/send-gp-request', { task_id: t.id, kind: 'reminder' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('not_requested_yet');
    t.metadata.gp_request.email_sent_at = NOW;
    r = await adminPost('/api/admin/registration-granted/send-gp-request', { task_id: t.id, kind: 'reminder' });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, kind: 'reminder', outstanding: ['Your passport', 'Child 1 passport', 'Child 2 passport', "Baby Obanimoh's passport"], email: { ok: false }, whatsapp: { ok: false, error: 'no_api_key' } });
    expect(taskById(t.id).metadata.gp_request.reminders).toBeUndefined();
    const app = db.visa_applications.find((a) => a.user_id === GP.userId);
    db.visa_documents.filter((d) => d.visa_application_id === app.id && d.document_type === 'passport').forEach((d) => { d.status = 'uploaded'; d.file_path = 'p'; });
    r = await adminPost('/api/admin/registration-granted/send-gp-request', { task_id: t.id, kind: 'reminder' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('nothing_outstanding');
    const st = await httpReq('GET', '/api/admin/registration-granted/gp-request-status?task_id=' + t.id, { host: SUPER_HOST, cookie: adminCookie() });
    expect(st.body.all_received).toBe(true);
    expect(st.body.outstanding).toEqual([]);
  });

  it('a practice reply on the migration-agent card is read and answered with a follow-up to the person they copied in, never the original draft', async () => {
    const agent = db.registration_tasks.find((x) => x.case_id === GP.caseId && x.task_type === 'migration_agent');
    // Gmail is not configured here, so stand in for the send: the congratulations email went out and the practice replied, copying the agent in.
    agent.status = 'waiting_on_practice';
    agent.metadata.outbound_email = Object.assign({}, agent.metadata.outbound_email, { sent_at: NOW, by: SUPER_EMAIL, gmail_thread_id: 'thr-agent-1', rfc822_message_id: '<req-1@mygplink.com.au>' });
    const later = new Date(Date.now() + 5000).toISOString();
    db.task_messages.push({ id: 'tm-agent-out', task_id: agent.id, case_id: GP.caseId, direction: 'outbound', channel: 'email', sender: 'registration@mygplink.com.au', recipient: 'pm@werribee-test.local', subject: agent.metadata.outbound_email.subject, body_text: agent.metadata.outbound_email.bodyText, gmail_thread_id: 'thr-agent-1', rfc822_message_id: '<req-1@mygplink.com.au>', created_at: NOW });
    db.task_messages.push({ id: 'tm-agent-in', task_id: agent.id, case_id: GP.caseId, direction: 'inbound', channel: 'email', sender: 'pm@werribee-test.local', recipient: 'registration@mygplink.com.au', cc: 'Surekha Kalpage <agent@migration-test.local>', subject: 'Re: ' + agent.metadata.outbound_email.subject, body_text: 'Hi Surekha,\n\nWill you be able to do the below for this doctor?\n\nThanks\nNaomi\n\n> On 6 Nov 2026 Hazel wrote:\n> Wonderful news. AHPRA has approved', gmail_thread_id: 'thr-agent-1', rfc822_message_id: '<reply-1@practice.test>', created_at: later });
    // The draft endpoint routes a migration_agent task to its own reader (no model key here → deterministic read of the CC line).
    let r = await adminPost('/api/admin/practice-reply/draft', { taskId: agent.id });
    expect(r.status).toBe(200);
    const pr = r.body.practice_reply;
    expect(pr).toMatchObject({ kind: 'migration_agent', outcome: 'delegated', draft_status: 'ready', reply_to: 'agent@migration-test.local', cc: ['pm@werribee-test.local'], agent_name: 'Surekha Kalpage', agent_email: 'agent@migration-test.local', agent_confidence: 'likely', source: 'fallback' });
    expect(pr.answered_at).toBeNull();
    expect(pr.suggested_reply.startsWith('Hi Surekha,')).toBe(true);
    expect(pr.suggested_reply).toContain('Naomi has copied you in');
    expect(pr.suggested_reply).toContain('Subclass 482 nomination for The Doctors Werribee and lodging Dr Obanimoh');
    expect(pr.suggested_reply).toContain('Warm regards,\nPriya Test\nGP Link');
    expect(pr.suggested_reply).not.toContain('Wonderful news');
    expect(pr.suggested_reply).not.toMatch(/[-‐-―]/);
    expect(pr.rso_notes).toContain('registered migration agent');
    const stored = taskById(agent.id);
    expect(stored.status).toBe('open');
    expect(stored.metadata.practice_reply.suggested_reply).toBe(pr.suggested_reply);
    // The congratulations draft is untouched.
    expect(stored.metadata.outbound_email.subject).toBe('Dr Mercy Obanimoh AHPRA registration approved, next step is the visa');
    expect(stored.metadata.outbound_email.bodyText.startsWith('Hi Naomi,')).toBe(true);
    expect(db.task_timeline.find((e) => e.task_id === agent.id && e.title === 'Practice replied about the migration agent — follow-up drafted')).toBeTruthy();
    // The cron secret may re-draft (maintenance), keeping the arrival time of the same message; a wrong secret is refused.
    const firstReceived = stored.metadata.practice_reply.received_at;
    r = await httpReq('POST', '/api/admin/practice-reply/draft', { host: SUPER_HOST, body: { taskId: agent.id }, headers: { Authorization: 'Bearer ' + process.env.CRON_SECRET } });
    expect(r.status).toBe(200);
    expect(taskById(agent.id).metadata.practice_reply.received_at).toBe(firstReceived);
    r = await httpReq('POST', '/api/admin/practice-reply/draft', { host: SUPER_HOST, body: { taskId: agent.id }, headers: { Authorization: 'Bearer wrong' } });
    expect(r.status).toBe(401);
    // Sending the follow-up threads onto their reply; Gmail is not configured here so it fails honestly and nothing is marked answered.
    r = await adminPost('/api/admin/registration-granted/send-practice-email', { task_id: agent.id, followup: true, to: pr.reply_to, cc: pr.cc.join(', '), subject: pr.suggested_subject, bodyHtml: '<p>' + pr.suggested_reply.replace(/\n/g, '<br>') + '</p>' });
    expect(r.status).toBe(502);
    expect(taskById(agent.id).metadata.practice_reply.answered_at).toBeNull();
    expect(taskById(agent.id).metadata.followups).toBeUndefined();
  });
});

describe('once the follow-up has gone (owner 2026-11-08, second screenshot): the card nudges whoever we last wrote to', () => {
  it('the nudge draft chases the person the follow-up went to, copying the original contact, and a nudge send is a follow-up of kind nudge', async () => {
    const agent = db.registration_tasks.find((x) => x.case_id === GP.caseId && x.task_type === 'migration_agent');
    // Stand in for the follow-up Gmail would have sent (not configured here): to the agent, cc the contact.
    const fuSubject = 'Re: Dr Mercy Obanimoh Subclass 482 nomination and visa, migration agent';
    const fuAt = new Date(Date.now() + 10000).toISOString();
    agent.status = 'waiting_on_practice';
    agent.metadata.followups = [{ kind: 'followup', sent_at: fuAt, by: SUPER_EMAIL, to: 'agent@migration-test.local', cc: 'pm@werribee-test.local', subject: fuSubject }];
    agent.metadata.practice_reply = Object.assign({}, agent.metadata.practice_reply, { answered_at: fuAt, draft_status: 'sent', sent_to: 'agent@migration-test.local' });
    db.task_messages.push({ id: 'tm-agent-fu', task_id: agent.id, case_id: GP.caseId, direction: 'outbound', channel: 'email', sender: 'registration@mygplink.com.au', recipient: 'agent@migration-test.local', cc: 'pm@werribee-test.local', subject: fuSubject, body_text: 'Hi Surekha,\n\nNaomi has copied you in on the next step for Dr Mercy Obanimoh...', created_at: fuAt });
    const r = await adminPost('/api/admin/practice-nudge/draft', { taskId: agent.id });
    expect(r.status).toBe(200);
    const n = r.body.nudge;
    expect(n).toMatchObject({ source: 'fallback', to: 'agent@migration-test.local', cc: ['pm@werribee-test.local'], suggested_subject: fuSubject, rso_notes: '' });
    expect(n.suggested_reply.startsWith("Hi Surekha,\n\nJust checking in on my note below about Dr Mercy Obanimoh's Subclass 482 nomination and visa for The Doctors Werribee.")).toBe(true);
    expect(n.suggested_reply).toContain('Could you let us know whether you will be handling it, and what you need from us and from the practice to get started?');
    expect(n.suggested_reply).toContain('before Dr Obanimoh starts on 25 January 2027');
    expect(n.suggested_reply).toContain('Warm regards,\nPriya Test\nGP Link');
    expect(n.suggested_reply).not.toContain('Wonderful news');
    expect(n.suggested_reply).not.toMatch(/[-‐-―]/);
    // Sending it is a follow-up of kind 'nudge'; Gmail is not configured here, so it fails honestly and records nothing.
    const s = await adminPost('/api/admin/registration-granted/send-practice-email', { task_id: agent.id, nudge: true, to: n.to, cc: n.cc.join(', '), subject: n.suggested_subject, bodyHtml: '<p>' + n.suggested_reply.replace(/\n/g, '<br>') + '</p>' });
    expect(s.status).toBe(502);
    expect(taskById(agent.id).metadata.followups).toHaveLength(1);
    // The practice-pack nudge drafter is untouched for its own tasks (title-based fallback).
    const pack = db.registration_tasks.find((x) => x.case_id === GP.caseId && x.task_type === 'ahpra_action_item');
    const p = await adminPost('/api/admin/practice-nudge/draft', { taskId: pack.id });
    expect(p.status).toBe(200);
    expect(p.body.nudge.suggested_subject).toContain('Follow-up: ');
  });
});

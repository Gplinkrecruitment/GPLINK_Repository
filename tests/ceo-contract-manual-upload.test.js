// CEO files a contract the practice EMAILED (owner request 2026-09-14).
//
// PKG Medical Centre extended an offer by emailing the contract to GP Link
// instead of using the extend-offer upload link, so the application sat at
// "Offer accepted" with no career_contracts row — no AI review, nothing on the
// Contracts tab, no way to send it to the doctor to sign. The CEO can now file
// that contract from the candidate's profile:
//   POST /api/ceo/contract/sign-upload  { applicationId, filename, mimeType }
//     → opens (or reuses) an awaiting_upload revision + signed Storage URL
//   browser PUTs the raw file to Storage (no base64, no Vercel body cap)
//   POST /api/ceo/contract/finalize     { contractId, filename, mimeType }
//     → verifies the object, records 'uploaded', runs the SAME AI review
// From there the row is a normal Contracts-tab row (Submit to GP → sign).
//
// Live-boot against the in-memory PostgREST + Storage emulator the other
// contract tests use (tests/career-contracts-flow.test.js Task 10/12 blocks),
// with a CEO admin cookie. No Anthropic key → the review lands on the
// deterministic "no key configured" stub (ai_review_status 'error').
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

describe('CEO files a contract the practice emailed (manual upload → same pipeline)', () => {
  const RUN_ID = crypto.randomBytes(4).toString('hex');
  const DB_FILE = path.join('/tmp', `gplink-ceo-mc-${RUN_ID}.json`);
  const SUPER_HOST = 'ceo-mc.local';
  const SUPER_EMAIL = 'super-mc@gplink-test.local';
  const HUB_EMAIL = 'hello@mygplink-test.local';
  const NOW = new Date().toISOString();

  const GP = { userId: 'u-gp-mc-1', email: 'gp-mc@gplink-test.local' };
  const CASE_ID = 'case-mc-1';
  const ROLE_ID = 'role-mc-1';
  const APP_MAIN = 'app-mc-main';               // the PKG case: no contract row at all
  const APP_REUSE = 'app-mc-reuse';             // practice was emailed the link, never used it
  const APP_BUSY = 'app-mc-busy';               // v1 already uploaded, awaiting CEO review
  const APP_PR = 'app-mc-practice-review';      // v2 with the practice for a doctor's change
  const APP_WD = 'app-mc-withdrawn';
  const APP_HIRED = 'app-mc-hired';
  const APP_NOFILE = 'app-mc-nofile';           // finalize without ever PUTting a file
  const APP_TWO = 'app-mc-two-docs';            // practice sent a letter of offer AND a contract
  const APP_TWO_NOFILE = 'app-mc-two-docs-nofile'; // …but the letter was never PUT

  let server, port, sbServer, sbPort, realFetch, mod;
  const resendCalls = [];
  const storage = new Map(); // "<bucket>/<path>" -> Buffer

  const appRow = (id, extra) => Object.assign({
    id, user_id: GP.userId, career_role_id: ROLE_ID, practice_id: 'p-mc-1',
    status: 'interview', ats_stage: 'offer',
    practice_contact_email: 'manager@pkg-test.local', practice_contact_name: 'PKG Practice Manager',
    applied_at: NOW, updated_at: NOW
  }, extra || {});

  const db = {
    user_profiles: [{ user_id: GP.userId, email: GP.email, first_name: 'Rahul', last_name: 'Testerson', registration_country: 'gb' }],
    user_state: [{ user_id: GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }],
    registration_cases: [{ id: CASE_ID, user_id: GP.userId, status: 'active', gp_name: 'Rahul Testerson', gp_email: GP.email, created_at: NOW, updated_at: NOW }],
    career_roles: [{ id: ROLE_ID, provider: 'internal_ats', title: 'General Practitioner', practice_name: 'PKG Medical Centre', practice_id: 'p-mc-1', is_active: true, job_status: 'open', updated_at: NOW }],
    gp_applications: [
      appRow(APP_MAIN),
      appRow(APP_REUSE),
      appRow(APP_BUSY),
      appRow(APP_PR, { status: 'offer' }),
      appRow(APP_WD, { status: 'withdrawn', ats_stage: 'not_proceeding' }),
      appRow(APP_HIRED, { status: 'placement_secured', ats_stage: 'hired' }),
      appRow(APP_NOFILE),
      appRow(APP_TWO),
      appRow(APP_TWO_NOFILE)
    ],
    career_contracts: [
      { id: 'contract-mc-reuse-v1', application_id: APP_REUSE, user_id: GP.userId, career_role_id: ROLE_ID, version: 1, status: 'awaiting_upload', ai_review_status: 'not_run', practice_contact_email: 'manager@pkg-test.local', practice_contact_name: 'PKG Practice Manager', created_at: NOW, updated_at: NOW },
      { id: 'contract-mc-busy-v1', application_id: APP_BUSY, user_id: GP.userId, career_role_id: ROLE_ID, version: 1, status: 'uploaded', ai_review_status: 'done', ai_review: { overall: 'aligned', summary: 'Fine.', discrepancies: [], interview_terms_available: false }, contract_bucket: 'gp-link-documents', contract_path: 'contracts/' + APP_BUSY + '/v1/c.pdf', contract_filename: 'c.pdf', contract_mime: 'application/pdf', uploaded_at: NOW, created_at: NOW, updated_at: NOW },
      { id: 'contract-mc-pr-v1', application_id: APP_PR, user_id: GP.userId, career_role_id: ROLE_ID, version: 1, status: 'void', ai_review_status: 'done', created_at: NOW, updated_at: NOW },
      { id: 'contract-mc-pr-v2', application_id: APP_PR, user_id: GP.userId, career_role_id: ROLE_ID, version: 2, status: 'practice_review', change_request: 'Please correct the start date.', ai_review_status: 'done', ai_review: { overall: 'minor_gaps', summary: 'Start date.', discrepancies: [], interview_terms_available: false }, contract_bucket: 'gp-link-documents', contract_path: 'contracts/' + APP_PR + '/v2/c.pdf', practice_contact_email: 'owner@pkg-test.local', practice_contact_name: 'PKG Owner', created_at: NOW, updated_at: NOW }
    ],
    ats_offers: [],
    ats_stage_events: [],
    scheduled_calls: [],
    user_documents: []
  };
  function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }
  // eq / neq / in.(…) — `in` matters here because the candidate drawer batches
  // its career_contracts lookup with application_id=in.(…).
  function buildMatcher(params) {
    const filters = [];
    for (const [k, v] of params.entries()) {
      if (['select', 'limit', 'order', 'on_conflict'].includes(k)) continue;
      let mm = /^(eq|neq)\.(.*)$/s.exec(v);
      if (mm) { filters.push({ col: k, op: mm[1], val: mm[2] }); continue; }
      mm = /^in\.\((.*)\)$/s.exec(v);
      if (mm) filters.push({ col: k, op: 'in', vals: mm[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')) });
    }
    return (row) => filters.every((f) => {
      const cell = row ? row[f.col] : undefined;
      if (f.op === 'in') return f.vals.includes(String(cell));
      const eq = String(cell) === String(f.val);
      return f.op === 'eq' ? eq : !eq;
    });
  }

  function startEmulator() {
    return new Promise((resolve) => {
      sbServer = http.createServer(async (req, res) => {
        const u = new URL(req.url, 'http://sb.local');
        const sendJson = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
        const readRaw = () => new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });

        // ── Supabase Storage ──
        if (u.pathname.startsWith('/storage/v1/')) {
          let mm = u.pathname.match(/^\/storage\/v1\/object\/upload\/sign\/(.+)$/);
          if (mm && req.method === 'POST') { await readRaw(); sendJson(200, { url: '/object/upload/sign/' + mm[1] + '?token=test-token' }); return; }
          if (mm && req.method === 'PUT') { storage.set(decodeURIComponent(mm[1]), await readRaw()); sendJson(200, { Key: mm[1] }); return; }
          mm = u.pathname.match(/^\/storage\/v1\/object\/sign\/(.+)$/);
          if (mm && req.method === 'POST') { await readRaw(); sendJson(200, { signedURL: '/object/sign/' + mm[1] + '?token=dl' }); return; }
          mm = u.pathname.match(/^\/storage\/v1\/object\/(?!upload|sign|public)(.+)$/);
          if (mm && req.method === 'GET') {
            const buf = storage.get(decodeURIComponent(mm[1]));
            if (!buf) { res.writeHead(404); res.end('not found'); return; }
            res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(buf); return;
          }
          sendJson(404, { message: 'storage not found' }); return;
        }

        // ── PostgREST ──
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
          const body = JSON.parse((await readRaw()).toString('utf8') || 'null');
          const incoming = Array.isArray(body) ? body : (body ? [body] : []);
          const saved = incoming.map((r) => {
            const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
            rows.push(row); return row;
          });
          sendJson(201, saved); return;
        }
        if (req.method === 'PATCH') {
          const patch = JSON.parse((await readRaw()).toString('utf8') || 'null');
          const matched = rows.filter(matches);
          matched.forEach((row) => Object.assign(row, patch || {}));
          sendJson(200, matched); return;
        }
        sendJson(405, { message: 'method not allowed' });
      });
      sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
    });
  }

  function httpJson(method, p, body, extraHeaders) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const headers = Object.assign({}, extraHeaders || {});
      if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
        const c = []; res.on('data', (x) => c.push(x));
        res.on('end', () => { const raw = Buffer.concat(c).toString('utf8'); let parsed = null; try { parsed = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, body: parsed }); });
      });
      r.on('error', reject); r.end(data);
    });
  }
  function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
  function adminCookie() {
    const payload = b64url(JSON.stringify({ userProfile: { email: SUPER_EMAIL, adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
    const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
    return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
  }
  const ceoGet = (p, withCookie = true) => httpJson('GET', p, null, Object.assign({ Host: SUPER_HOST }, withCookie ? { Cookie: adminCookie() } : {}));
  const ceoPost = (p, body, withCookie = true) => httpJson('POST', p, body, Object.assign({ Host: SUPER_HOST }, withCookie ? { Cookie: adminCookie() } : {}));

  // Direct PUT to the (emulated) signed upload URL, exactly as the browser would.
  function putSignedUpload(uploadUrl, buffer, mime) {
    return new Promise((resolve, reject) => {
      const target = new URL(uploadUrl);
      const r = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: 'PUT', headers: { 'Content-Type': mime, 'x-upsert': 'true', 'Content-Length': buffer.length } }, (res) => {
        res.on('data', () => {}); res.on('end', () => resolve({ status: res.statusCode }));
      });
      r.on('error', reject); r.end(buffer);
    });
  }

  const contractsFor = (appId) => db.career_contracts.filter((c) => c.application_id === appId);
  const application = (id) => db.gp_applications.find((a) => a.id === id);
  const PDF = Buffer.from('%PDF-1.4 PKG Medical Centre — offer of employment (test bytes)', 'utf8');
  const PDF_MIME = 'application/pdf';

  beforeAll(async () => {
    await startEmulator();
    process.env.AGENT_SKIP_DOTENV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DISABLED = 'false';
    process.env.AUTH_SECRET = 'ceo-mc-secret-' + RUN_ID;
    process.env.REQUIRE_SUPABASE_DB = 'false';
    process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
    process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.SUPABASE_DOCUMENT_BUCKET = 'gp-link-documents';
    process.env.ENFORCE_SAME_ORIGIN = 'false';
    process.env.DB_FILE_PATH = DB_FILE;
    process.env.OPENAI_API_KEY = '';
    process.env.ANTHROPIC_API_KEY = '';
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.REGISTRATION_HUB_EMAIL = HUB_EMAIL;
    process.env.APP_BASE_URL = 'https://app.mygplink.com.au';
    process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
    process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
    process.env.ADMIN_EMAILS = '';

    realFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => {
      const u = String(url && url.url ? url.url : url);
      if (u.startsWith('https://api.resend.com/')) {
        let parsed = null; try { parsed = JSON.parse((opts && opts.body) || 'null'); } catch {}
        resendCalls.push({ url: u, body: parsed });
        return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
      }
      if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
      return Promise.resolve(new Response('{}', { status: 200 }));
    };

    vi.resetModules();
    mod = await import('../server.js');
    server = mod.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (sbServer) await new Promise((r) => sbServer.close(r));
    if (realFetch) globalThis.fetch = realFetch;
    try { fs.unlinkSync(DB_FILE); } catch {}
  });

  it('is CEO-only: no session is refused on both endpoints', async () => {
    const sign = await ceoPost('/api/ceo/contract/sign-upload', { applicationId: APP_MAIN, filename: 'c.pdf', mimeType: PDF_MIME }, false);
    expect([401, 403, 404]).toContain(sign.status);
    const fin = await ceoPost('/api/ceo/contract/finalize', { contractId: 'contract-mc-reuse-v1', filename: 'c.pdf', mimeType: PDF_MIME }, false);
    expect([401, 403, 404]).toContain(fin.status);
    expect(contractsFor(APP_MAIN)).toHaveLength(0);
  });

  it('validates the request: a non-PDF/DOCX file is 400, an unknown application is 404', async () => {
    const badMime = await ceoPost('/api/ceo/contract/sign-upload', { applicationId: APP_MAIN, filename: 'contract.exe', mimeType: 'application/x-msdownload' });
    expect(badMime.status).toBe(400);
    expect(badMime.body.message).toMatch(/PDF or Word/);
    const missing = await ceoPost('/api/ceo/contract/sign-upload', { applicationId: 'app-does-not-exist', filename: 'c.pdf', mimeType: PDF_MIME });
    expect(missing.status).toBe(404);
    expect(contractsFor(APP_MAIN)).toHaveLength(0);
  });

  it('refuses a terminal application: withdrawn and secured both 409 without opening a row', async () => {
    const wd = await ceoPost('/api/ceo/contract/sign-upload', { applicationId: APP_WD, filename: 'c.pdf', mimeType: PDF_MIME });
    expect(wd.status).toBe(409);
    expect(wd.body.code).toBe('withdrawn');
    const hired = await ceoPost('/api/ceo/contract/sign-upload', { applicationId: APP_HIRED, filename: 'c.pdf', mimeType: PDF_MIME });
    expect(hired.status).toBe(409);
    expect(hired.body.code).toBe('not_available');
    expect(contractsFor(APP_WD)).toHaveLength(0);
    expect(contractsFor(APP_HIRED)).toHaveLength(0);
  });

  it('the PKG case: opens v1, stores the file, records it as uploaded and runs the AI review — and emails nobody', async () => {
    const before = resendCalls.length;
    const sign = await ceoPost('/api/ceo/contract/sign-upload', { applicationId: APP_MAIN, filename: 'PKG-Offer-Contract.pdf', mimeType: PDF_MIME });
    expect(sign.status).toBe(200);
    expect(sign.body.ok).toBe(true);
    expect(sign.body.version).toBe(1);
    expect(sign.body.path).toBe('contracts/' + APP_MAIN + '/v1/PKG-Offer-Contract.pdf');
    expect(typeof sign.body.uploadUrl).toBe('string');

    // The revision is opened exactly as the practice's extend-offer would have.
    const opened = contractsFor(APP_MAIN);
    expect(opened).toHaveLength(1);
    expect(opened[0].id).toBe(sign.body.contractId);
    expect(opened[0].status).toBe('awaiting_upload');
    expect(opened[0].user_id).toBe(GP.userId);
    expect(opened[0].career_role_id).toBe(ROLE_ID);
    expect(opened[0].practice_contact_email).toBe('manager@pkg-test.local');

    // Browser PUTs the raw bytes straight to Storage.
    const put = await putSignedUpload(sign.body.uploadUrl, PDF, PDF_MIME);
    expect(put.status).toBe(200);
    expect(storage.has('gp-link-documents/' + sign.body.path)).toBe(true);

    const fin = await ceoPost('/api/ceo/contract/finalize', { contractId: sign.body.contractId, filename: 'PKG-Offer-Contract.pdf', mimeType: PDF_MIME });
    expect(fin.status).toBe(200);
    expect(fin.body.ok).toBe(true);
    expect(fin.body.status).toBe('uploaded');
    // No Anthropic key in this test → the deterministic stub, reported honestly.
    expect(fin.body.ai_review_status).toBe('error');
    expect(fin.body.ai_review && fin.body.ai_review.overall).toBe('unreadable');

    const row = contractsFor(APP_MAIN)[0];
    expect(row.status).toBe('uploaded');
    expect(row.contract_bucket).toBe('gp-link-documents');
    expect(row.contract_path).toBe(sign.body.path);
    expect(row.contract_filename).toBe('PKG-Offer-Contract.pdf');
    expect(row.contract_mime).toBe(PDF_MIME);
    expect(row.uploaded_at).toBeTruthy();
    expect(row.ai_review_status).toBe('error');
    expect(row.terms_context).toBeTruthy();

    // Filing the contract changes NOTHING on the application yet — only the
    // CEO's "Submit to GP" on the Contracts tab moves it to 'offer'.
    expect(application(APP_MAIN).status).toBe('interview');
    expect(application(APP_MAIN).ats_stage).toBe('offer');
    // The practice finalize emails the hub "a practice uploaded a contract";
    // when the CEO is the uploader that email would be noise.
    expect(resendCalls.length).toBe(before);
  });

  it('the filed contract sits on the Contracts queue and on the candidate drawer like any practice upload', async () => {
    const list = await ceoGet('/api/ceo/contracts');
    expect(list.status).toBe(200);
    const mine = (list.body.contracts || []).find((c) => c.applicationId === APP_MAIN);
    expect(mine).toBeTruthy();
    expect(mine.status).toBe('uploaded');
    expect(mine.version).toBe(1);
    expect(mine.gpName).toBe('Rahul Testerson');
    expect(mine.practiceName).toBe('PKG Medical Centre');
    expect(mine.contractUrl).toMatch(/PKG-Offer-Contract\.pdf/);
    expect(list.body.needsReview).toBeGreaterThanOrEqual(1);

    const cand = await ceoGet('/api/ceo/candidate?case_id=' + encodeURIComponent(CASE_ID));
    expect(cand.status).toBe(200);
    const apps = cand.body.candidate.apps || [];
    const main = apps.find((a) => String(a.id) === APP_MAIN);
    expect(main).toBeTruthy();
    expect(main.contract).toEqual(expect.objectContaining({ status: 'uploaded', version: 1, ai_review_status: 'error', verdict: 'unreadable' }));
    // Nothing filed yet → null, which is what makes the drawer show "Upload contract".
    const nofile = apps.find((a) => String(a.id) === APP_NOFILE);
    expect(nofile.contract).toBeNull();
    // A never-used practice link is reported as awaiting_upload so the drawer
    // can say so AND still offer the upload.
    const reuse = apps.find((a) => String(a.id) === APP_REUSE);
    expect(reuse.contract).toEqual(expect.objectContaining({ status: 'awaiting_upload', version: 1 }));
    // The void v1 must never win over the live v2.
    const pr = apps.find((a) => String(a.id) === APP_PR);
    expect(pr.contract).toEqual(expect.objectContaining({ status: 'practice_review', version: 2, verdict: 'minor_gaps' }));
  });

  it('replays are refused: a second sign-upload is 409 contract_exists, a second finalize is 409 already_uploaded', async () => {
    const row = contractsFor(APP_MAIN)[0];
    const again = await ceoPost('/api/ceo/contract/sign-upload', { applicationId: APP_MAIN, filename: 'evil.pdf', mimeType: PDF_MIME });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('contract_exists');
    expect(again.body.status).toBe('uploaded');
    expect(again.body.message).toMatch(/Contracts tab/);
    expect(contractsFor(APP_MAIN)).toHaveLength(1);

    const fin = await ceoPost('/api/ceo/contract/finalize', { contractId: row.id, filename: 'evil.pdf', mimeType: PDF_MIME });
    expect(fin.status).toBe(409);
    expect(fin.body.code).toBe('already_uploaded');
    expect(row.contract_filename).toBe('PKG-Offer-Contract.pdf');
  });

  it('reuses an awaiting_upload revision the practice never used instead of opening v2', async () => {
    const sign = await ceoPost('/api/ceo/contract/sign-upload', { applicationId: APP_REUSE, filename: 'Emailed-Contract.pdf', mimeType: PDF_MIME });
    expect(sign.status).toBe(200);
    expect(sign.body.contractId).toBe('contract-mc-reuse-v1');
    expect(sign.body.version).toBe(1);
    expect(sign.body.path).toBe('contracts/' + APP_REUSE + '/v1/Emailed-Contract.pdf');
    expect(contractsFor(APP_REUSE)).toHaveLength(1);

    await putSignedUpload(sign.body.uploadUrl, PDF, PDF_MIME);
    const fin = await ceoPost('/api/ceo/contract/finalize', { contractId: sign.body.contractId, filename: 'Emailed-Contract.pdf', mimeType: PDF_MIME });
    expect(fin.status).toBe(200);
    expect(contractsFor(APP_REUSE)[0].status).toBe('uploaded');
  });

  it('refuses while a contract is already awaiting review, pointing at the Contracts tab', async () => {
    const sign = await ceoPost('/api/ceo/contract/sign-upload', { applicationId: APP_BUSY, filename: 'c.pdf', mimeType: PDF_MIME });
    expect(sign.status).toBe(409);
    expect(sign.body.code).toBe('contract_exists');
    expect(sign.body.contractId).toBe('contract-mc-busy-v1');
    expect(sign.body.message).toMatch(/already waiting for your review/);
    expect(contractsFor(APP_BUSY)).toHaveLength(1);
  });

  it('over a with-practice row: opens v+1 and voids the old one exactly as the consent approve does', async () => {
    const sign = await ceoPost('/api/ceo/contract/sign-upload', { applicationId: APP_PR, filename: 'Revised.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    expect(sign.status).toBe(200);
    expect(sign.body.version).toBe(3);
    expect(sign.body.path).toBe('contracts/' + APP_PR + '/v3/Revised.docx');
    const rows = contractsFor(APP_PR);
    expect(rows).toHaveLength(3);
    const v2 = rows.find((c) => c.id === 'contract-mc-pr-v2');
    expect(v2.status).toBe('void');
    expect(v2.change_response).toBe('approved');
    const v3 = rows.find((c) => c.id === sign.body.contractId);
    expect(v3.status).toBe('awaiting_upload');
    // The practice contact carries across from the superseded revision.
    expect(v3.practice_contact_email).toBe('owner@pkg-test.local');
  });

  it('finalize without a stored file is 400 and the row stays awaiting_upload', async () => {
    const sign = await ceoPost('/api/ceo/contract/sign-upload', { applicationId: APP_NOFILE, filename: 'Never-Uploaded.pdf', mimeType: PDF_MIME });
    expect(sign.status).toBe(200);
    const fin = await ceoPost('/api/ceo/contract/finalize', { contractId: sign.body.contractId, filename: 'Never-Uploaded.pdf', mimeType: PDF_MIME });
    expect(fin.status).toBe(400);
    expect(fin.body.message).toMatch(/could not find the uploaded file/i);
    expect(contractsFor(APP_NOFILE)[0].status).toBe('awaiting_upload');
  });

  // Owner request 2026-09-14: some practices send a LETTER OF OFFER with the
  // contract and the doctor must sign both. The drawer files the contract
  // first, then the letter against the same application; finalize records the
  // pair on the ONE revision. A practice that sends only the contract is the
  // path every test above already covers — nothing about it changes.
  describe('letter of offer alongside the contract', () => {
    const LETTER = Buffer.from('%PDF-1.4 PKG Medical Centre — letter of offer (test bytes)', 'utf8');
    let twoRow;

    it('the letter sign-upload reuses the row the contract call opened and lands under /offer-letter/', async () => {
      const signC = await ceoPost('/api/ceo/contract/sign-upload', { applicationId: APP_TWO, filename: 'PKG-Contract.pdf', mimeType: PDF_MIME });
      expect(signC.status).toBe(200);
      expect(signC.body.document).toBe('contract');
      expect(signC.body.path).toBe('contracts/' + APP_TWO + '/v1/PKG-Contract.pdf');
      expect((await putSignedUpload(signC.body.uploadUrl, PDF, PDF_MIME)).status).toBe(200);

      const signL = await ceoPost('/api/ceo/contract/sign-upload', { applicationId: APP_TWO, filename: 'PKG-Letter-of-Offer.pdf', mimeType: PDF_MIME, document: 'offer_letter' });
      expect(signL.status).toBe(200);
      expect(signL.body.contractId).toBe(signC.body.contractId);
      expect(signL.body.version).toBe(1);
      expect(signL.body.document).toBe('offer_letter');
      expect(signL.body.path).toBe('contracts/' + APP_TWO + '/v1/offer-letter/PKG-Letter-of-Offer.pdf');
      expect(contractsFor(APP_TWO)).toHaveLength(1);
      expect((await putSignedUpload(signL.body.uploadUrl, LETTER, PDF_MIME)).status).toBe(200);
      expect(storage.has('gp-link-documents/' + signL.body.path)).toBe(true);
      twoRow = contractsFor(APP_TWO)[0];
      expect(twoRow.status).toBe('awaiting_upload');
    });

    it('finalize with offerLetter records both file sets on the one row and the review knows a letter is attached', async () => {
      const before = resendCalls.length;
      const fin = await ceoPost('/api/ceo/contract/finalize', { contractId: twoRow.id, filename: 'PKG-Contract.pdf', mimeType: PDF_MIME, offerLetter: { filename: 'PKG-Letter-of-Offer.pdf', mimeType: PDF_MIME } });
      expect(fin.status).toBe(200);
      expect(fin.body.ok).toBe(true);
      expect(fin.body.status).toBe('uploaded');
      expect(fin.body.hasOfferLetter).toBe(true);
      // No Anthropic key → the deterministic stub, which still says a letter was there.
      expect(fin.body.ai_review_status).toBe('error');
      expect(fin.body.ai_review.has_offer_letter).toBe(true);

      const row = contractsFor(APP_TWO)[0];
      expect(row.status).toBe('uploaded');
      expect(row.contract_bucket).toBe('gp-link-documents');
      expect(row.contract_path).toBe('contracts/' + APP_TWO + '/v1/PKG-Contract.pdf');
      expect(row.contract_filename).toBe('PKG-Contract.pdf');
      expect(row.contract_mime).toBe(PDF_MIME);
      expect(row.offer_letter_bucket).toBe('gp-link-documents');
      expect(row.offer_letter_path).toBe('contracts/' + APP_TWO + '/v1/offer-letter/PKG-Letter-of-Offer.pdf');
      expect(row.offer_letter_filename).toBe('PKG-Letter-of-Offer.pdf');
      expect(row.offer_letter_mime).toBe(PDF_MIME);
      expect(row.ai_review.has_offer_letter).toBe(true);
      // Same as the single-document finalize: the CEO is the uploader, no hub email.
      expect(resendCalls.length).toBe(before);
      // A single-document row's review says so too.
      expect(contractsFor(APP_MAIN)[0].ai_review.has_offer_letter).toBe(false);
    });

    it('the Contracts queue row carries the letter and lists both documents, letter first, both unsigned; the drawer sees the flags', async () => {
      const list = await ceoGet('/api/ceo/contracts');
      expect(list.status).toBe(200);
      const mine = (list.body.contracts || []).find((c) => c.applicationId === APP_TWO);
      expect(mine).toBeTruthy();
      expect(mine.contractUrl).toMatch(/PKG-Contract\.pdf/);
      expect(mine.offerLetterUrl).toMatch(/PKG-Letter-of-Offer\.pdf/);
      expect(mine.offerLetterFilename).toBe('PKG-Letter-of-Offer.pdf');
      expect(mine.offerLetterMime).toBe(PDF_MIME);
      expect(mine.offerLetterSignedUrl).toBeUndefined();
      expect(mine.contractSignedAt).toBeNull();
      expect(mine.offerLetterSignedAt).toBeNull();
      expect(mine.documents).toEqual([
        { key: 'offer_letter', label: 'Letter of offer', signed: false },
        { key: 'contract', label: 'Employment contract', signed: false }
      ]);
      // A row without a letter is untouched: no letter URL, one document.
      const single = (list.body.contracts || []).find((c) => c.applicationId === APP_MAIN);
      expect(single.offerLetterUrl).toBe('');
      expect(single.offerLetterFilename).toBe('');
      expect(single.documents).toEqual([{ key: 'contract', label: 'Employment contract', signed: false }]);

      const cand = await ceoGet('/api/ceo/candidate?case_id=' + encodeURIComponent(CASE_ID));
      const two = (cand.body.candidate.apps || []).find((a) => String(a.id) === APP_TWO);
      expect(two.contract).toEqual(expect.objectContaining({ status: 'uploaded', has_offer_letter: true, contract_signed: false, offer_letter_signed: false }));
      const main = (cand.body.candidate.apps || []).find((a) => String(a.id) === APP_MAIN);
      expect(main.contract).toEqual(expect.objectContaining({ has_offer_letter: false }));
    });

    it('preview?document=offer_letter serves the letter as a PDF url; the default (and a row without a letter) behave as before', async () => {
      const letter = await ceoGet('/api/ceo/contract/preview?contractId=' + encodeURIComponent(twoRow.id) + '&document=offer_letter');
      expect(letter.status).toBe(200);
      expect(letter.body.kind).toBe('pdf');
      expect(letter.body.document).toBe('offer_letter');
      expect(letter.body.url).toMatch(/offer-letter\/PKG-Letter-of-Offer\.pdf/);
      expect(letter.body.filename).toBe('PKG-Letter-of-Offer.pdf');
      // The hyphenated alias is accepted on the way in, the underscore form always comes back.
      const alias = await ceoGet('/api/ceo/contract/preview?contractId=' + encodeURIComponent(twoRow.id) + '&document=offer-letter');
      expect(alias.body.document).toBe('offer_letter');
      expect(alias.body.url).toBe(letter.body.url);
      const dflt = await ceoGet('/api/ceo/contract/preview?contractId=' + encodeURIComponent(twoRow.id));
      expect(dflt.body.kind).toBe('pdf');
      expect(dflt.body.document).toBe('contract');
      expect(dflt.body.url).toMatch(/PKG-Contract\.pdf/);
      expect(dflt.body.url).not.toMatch(/offer-letter/);
      const none = await ceoGet('/api/ceo/contract/preview?contractId=' + encodeURIComponent(contractsFor(APP_MAIN)[0].id) + '&document=offer_letter');
      expect(none.status).toBe(200);
      expect(none.body.kind).toBe('none');
      expect(none.body.message).toMatch(/letter of offer/i);
    });

    it('finalize with a letter that was never uploaded (or the wrong kind of file) is 400 naming the letter, and nothing is recorded', async () => {
      const signC = await ceoPost('/api/ceo/contract/sign-upload', { applicationId: APP_TWO_NOFILE, filename: 'C.pdf', mimeType: PDF_MIME });
      expect(signC.status).toBe(200);
      expect((await putSignedUpload(signC.body.uploadUrl, PDF, PDF_MIME)).status).toBe(200);
      const signL = await ceoPost('/api/ceo/contract/sign-upload', { applicationId: APP_TWO_NOFILE, filename: 'L.pdf', mimeType: PDF_MIME, document: 'offer_letter' });
      expect(signL.body.contractId).toBe(signC.body.contractId);
      // …but the letter is never PUT.
      const fin = await ceoPost('/api/ceo/contract/finalize', { contractId: signC.body.contractId, filename: 'C.pdf', mimeType: PDF_MIME, offerLetter: { filename: 'L.pdf', mimeType: PDF_MIME } });
      expect(fin.status).toBe(400);
      expect(fin.body.message).toMatch(/letter of offer/i);
      const badMime = await ceoPost('/api/ceo/contract/finalize', { contractId: signC.body.contractId, filename: 'C.pdf', mimeType: PDF_MIME, offerLetter: { filename: 'L.exe', mimeType: 'application/x-msdownload' } });
      expect(badMime.status).toBe(400);
      expect(badMime.body.message).toMatch(/letter of offer/i);

      const row = contractsFor(APP_TWO_NOFILE)[0];
      expect(row.status).toBe('awaiting_upload');
      expect(row.contract_path).toBeUndefined();
      expect(row.offer_letter_path).toBeUndefined();
      expect(row.uploaded_at).toBeUndefined();
    });
  });
});

describe('CEO manual contract upload — dashboard wiring (source assertions)', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const candidatesJs = read('js/ceo-ats-candidates.js');
  const contractsJs = read('js/ceo-ats-contracts.js');
  const dash = read('pages/ceo-dashboard.html');
  const srv = read('server.js');

  it('the candidate drawer offers "Upload contract" and drives the same sign → PUT → finalize sequence', () => {
    expect(candidatesJs).toContain('class="ats-btn ats-btn-ghost ats-btn-sm ats-contract-upload"');
    expect(candidatesJs).toContain("ATS.api('/api/ceo/contract/sign-upload'");
    expect(candidatesJs).toContain("ATS.api('/api/ceo/contract/finalize'");
    expect(candidatesJs).toMatch(/method: 'PUT', credentials: 'omit', headers: \{ 'Content-Type': mime, 'x-upsert': 'true' \}/);
    // Only PDF / DOCX, decided by extension first (Finder reports '' for .docx).
    expect(candidatesJs).toContain("if (/\\.docx$/.test(name)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';");
    // Consultants never see it — the endpoints are CEO-only.
    expect(candidatesJs).toMatch(/function canFileContract\(a\) \{\s*if \(ATS\.isConsultant && ATS\.isConsultant\(\)\) return false;/);
  });

  it('a live contract shows its state with a jump to the Contracts tab, and the alert refreshes after filing', () => {
    expect(candidatesJs).toContain('class="ats-btn ats-btn-ghost ats-btn-sm ats-contract-open"');
    expect(candidatesJs).toContain('Review in Contracts');
    expect(candidatesJs).toContain('#masterTabs .ats-master-tab[data-mtab="contracts"]');
    expect(candidatesJs).toContain('if (ATS.refreshContractsAlert) ATS.refreshContractsAlert();');
    // The offer cell is now offer state + contract line, from one builder.
    expect(candidatesJs).toContain('return offerStateHtml(a) + contractLineHtml(a);');
    // Both new buttons are handled by the drawer's delegated click listener.
    expect(candidatesJs).toContain("e.target.closest('.ats-contract-upload')");
    expect(candidatesJs).toContain("e.target.closest('.ats-contract-open')");
  });

  it('the Contracts tab copy no longer claims every contract came from a practice', () => {
    expect(contractsJs).toContain('or filed by you from a candidate');
  });

  it('bumps the candidates, contracts and CSS cache-busters (CSS must be ≥ the candidates JS)', () => {
    expect(dash).toContain('/js/ceo-ats-candidates.js?v=20260914b');
    expect(dash).toContain('/js/ceo-ats-contracts.js?v=20260914b');
    expect(dash).toContain('/css/ceo-ats.css?v=20260914b');
    expect(dash).not.toContain('/js/ceo-ats-candidates.js?v=20260910a');
    expect(dash).not.toContain('/js/ceo-ats-contracts.js?v=20260805d');
  });

  it('the candidate payload carries the live contract summary next to the offer', () => {
    expect(srv).toContain('contract: atsContractCardState(appContractMap[String(a.id)] || null)');
    expect(srv).toMatch(/function atsContractCardState\(contractRow\)/);
    // Local/dev parity so the drawer never reads undefined.
    expect(srv).toMatch(/offer: atsOfferCardState\(offerRow\),[\s\S]{0,300}contract: null,/);
  });
});

// The doctor signs TWO documents (owner request 2026-09-14).
//
// Some practices send a letter of offer alongside the employment contract and
// both have to be signed before the placement is secured; others send the
// contract alone. Both documents ride on the ONE career_contracts revision
// (offer_letter_* columns), the doctor signs them one at a time, and only the
// last signature secures the placement and sends the signed-copy emails.
//
// Live-boot against the in-memory PostgREST + Storage emulator, modelled on
// the Task 13 GP block in tests/career-contracts-flow.test.js. Seeds one
// sent_to_gp row WITH both documents and one with the contract alone — the
// second is the regression guard: a single-document row must sign exactly as
// it did before the letter existed.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MIGRATION_PATH = path.join(ROOT, 'supabase/migrations/20260914120000_career_contracts_offer_letter.sql');

describe('career_contracts letter-of-offer migration', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');

  it('exists, is additive and idempotent, and says why', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
    expect(sql).not.toMatch(/drop\s/i);
    expect(sql).toMatch(/letter of offer/i);
    expect(sql).toMatch(/2026-09-14/);
  });

  it('adds the letter file slots, the letter signed slots and the per-document signed stamps, schema-qualified', () => {
    const cols = [
      'offer_letter_bucket text',
      'offer_letter_path text',
      'offer_letter_filename text',
      'offer_letter_mime text',
      'offer_letter_signed_bucket text',
      'offer_letter_signed_path text',
      'offer_letter_signed_filename text',
      'offer_letter_signed_at timestamptz',
      'contract_signed_at timestamptz'
    ];
    for (const col of cols) {
      expect(sql).toContain('alter table public.career_contracts add column if not exists ' + col + ';');
    }
    // Nothing else is touched — no other table, no not-null, no default.
    expect(sql.match(/alter table/gi)).toHaveLength(cols.length);
    expect(sql).not.toMatch(/not null/i);
  });
});

describe('two-document helpers + wiring (source assertions)', () => {
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  it('the candidate drawer select carries the per-document signed paths and the card state exposes them', () => {
    expect(srv).toContain('uploaded_at,sent_to_gp_at,signed_at,offer_letter_path,signed_path,offer_letter_signed_path&application_id=in.(');
    const card = srv.slice(srv.indexOf('function atsContractCardState(contractRow)'), srv.indexOf('function atsLocalCandidateFacts('));
    expect(card).toContain('has_offer_letter: !!contractRow.offer_letter_path');
    expect(card).toContain('contract_signed: !!contractRow.signed_path');
    expect(card).toContain('offer_letter_signed: !!contractRow.offer_letter_signed_path');
  });

  it('sign-inapp executes the chosen document and files the letter under its own signed name', () => {
    const fn = srv.slice(srv.indexOf("if (pathname === '/api/career/contract/sign-inapp'"), srv.indexOf("if (pathname === '/api/career/contract/finalize-signed'"));
    expect(fn).toContain('const siDocument = careerContractDocumentKey(siBody && siBody.document);');
    expect(fn).toContain("agreementTitle: siDocument === 'offer_letter' ? 'Letter of offer' : (siDoc.filename || 'Employment agreement')");
    expect(fn).toContain("const siFilename = siDocument === 'offer_letter' ? 'signed-offer-letter.pdf' : 'signed-agreement.pdf';");
    expect(fn).toContain("careerContractSignedStoragePath(siContract, siFilename, 'offer_letter')");
    // The contract's own signed path is untouched — the inline shape the flow test pins.
    expect(fn).toContain("'signed', siFilename");
    expect(fn).toContain("code: 'already_signed'");
  });

  it('the contract-ready notification tells the doctor about both documents only when there is a letter (plain text, shared by card/push/email)', () => {
    const fn = srv.slice(srv.indexOf('async function notifyGpContractReady('), srv.indexOf('async function sendMatchAcceptedWhatsAppToGp('));
    expect(fn).toContain('review your letter of offer and employment agreement and sign them');
    expect(fn).toContain('review your employment agreement and sign');
    expect(fn).toContain('careerContractHasOfferLetter(contract)');
  });

  it('the AI review names the document each quote came from and asks for both documents to be compared', () => {
    const start = srv.indexOf('async function aiReviewCareerContract(');
    const fn = srv.slice(start, srv.indexOf('\n}\n', srv.indexOf('await persist(reviewResult, status, termsContext);', start)) + 3);
    expect(fn).toContain('Two documents may be attached: a LETTER OF OFFER and the EMPLOYMENT CONTRACT.');
    expect(fn).toContain('"document": "contract" | "offer_letter"');
    expect(fn).toContain('"source": "interview" | "offer" | "listing" | "offer_letter"');
    expect(fn).toContain('var letterBlocks = hasOfferLetter ? await readOfferLetterBlocksForReview(contract) : [];');
    expect(fn).toContain('document: careerContractDocumentKey(d.document)');
    expect(fn).toContain('has_offer_letter: hasOfferLetter');
    // The letter goes in FIRST, and an unreadable letter is a text block, not a failed review.
    const helper = srv.slice(srv.indexOf('async function readOfferLetterBlocksForReview('), srv.indexOf('\n}\n', srv.indexOf('async function readOfferLetterBlocksForReview(')) + 3);
    expect(helper).toContain("'LETTER OF OFFER (uploaded by the practice, attached as a PDF):'");
    expect(helper).toContain('this document could not be read');
    expect(fn).toContain('var contentBlocks = letterBlocks');
  });

  it('the AI review helper is exported for the review, and the review function stays within the flow test\'s pinned window', () => {
    const start = srv.indexOf('async function aiReviewCareerContract');
    // tests/career-contracts-flow.test.js slices 14000 chars from the function
    // start and expects the truncation + text-block guards inside it.
    expect(srv.indexOf("stop_reason === 'max_tokens'", start) - start).toBeLessThan(14000);
    expect(srv.indexOf("b.type === 'text'", start) - start).toBeLessThan(14000);
  });
});

describe('GP signs the letter of offer and the contract — live-boot', () => {
  const RUN_ID = crypto.randomBytes(4).toString('hex');
  const DB_FILE = path.join('/tmp', `gplink-2doc-${RUN_ID}.json`);
  const GP = { userId: 'u-gp-2doc-1', email: 'gp-2doc-1@gplink-test.local' };
  const HUB_EMAIL = 'hello@mygplink-test.local';
  const PRACTICE_EMAIL = 'reception@harbour-2doc.local';
  const NOW = new Date().toISOString();
  const BUCKET = 'gp-link-documents';

  const APP_TWO = 'app-2doc-both';     // letter of offer + contract, both to sign
  const APP_ONE = 'app-2doc-contract'; // contract only — the pre-letter world
  // A previous finalize recorded the LAST signed copy and died before the
  // status flip (network blip, Vercel kill): every copy is on the row but it
  // is still sent_to_gp. A second call must finish the job, not 409.
  const APP_RESUME_TWO = 'app-2doc-resume-both';
  const APP_RESUME_ONE = 'app-2doc-resume-contract';

  let server, port, sbServer, sbPort, realFetch, mod;
  const resendCalls = [];
  const storage = new Map();

  function app(id) {
    return { id, user_id: GP.userId, career_role_id: 'role-2doc-1', practice_id: 'p-2doc-1', provider_role_id: 'ats_2doc_1', status: 'offer', ats_stage: 'offer', practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'Harbour Reception', applied_at: NOW };
  }
  function contractRow(id, applicationId, extra) {
    return Object.assign({
      id, application_id: applicationId, user_id: GP.userId, career_role_id: 'role-2doc-1',
      version: 1, status: 'sent_to_gp',
      contract_bucket: BUCKET,
      contract_path: 'contracts/' + applicationId + '/v1/Employment-Contract.pdf',
      contract_filename: 'Employment-Contract.pdf', contract_mime: 'application/pdf',
      practice_contact_email: PRACTICE_EMAIL, practice_contact_name: 'Harbour Reception',
      ai_review_status: 'done', sent_to_gp_at: NOW, created_at: NOW, updated_at: NOW
    }, extra || {});
  }

  const db = {
    user_profiles: [{ user_id: GP.userId, email: GP.email, first_name: 'Helen', last_name: 'Rivers', registration_country: 'uk' }],
    practices: [{ id: 'p-2doc-1', name: 'Harbour Family Clinic', source: 'internal_ats', contact_name: 'Harbour Reception', contact_email: PRACTICE_EMAIL, is_active: true, created_at: NOW }],
    career_roles: [{ id: 'role-2doc-1', provider: 'internal_ats', provider_role_id: 'ats_2doc_1', title: 'General Practitioner — VR', practice_name: 'Harbour Family Clinic', practice_id: 'p-2doc-1', location_city: 'Brisbane', location_state: 'QLD', is_active: true, job_status: 'open', updated_at: NOW }],
    gp_applications: [app(APP_TWO), app(APP_ONE), app(APP_RESUME_TWO), app(APP_RESUME_ONE)],
    career_contracts: [
      contractRow('c-2doc-both', APP_TWO, {
        offer_letter_bucket: BUCKET,
        offer_letter_path: 'contracts/' + APP_TWO + '/v1/offer-letter/Letter-of-Offer.pdf',
        offer_letter_filename: 'Letter-of-Offer.pdf',
        offer_letter_mime: 'application/pdf'
      }),
      contractRow('c-2doc-contract', APP_ONE),
      // Both copies recorded, status never flipped (the previous call died).
      contractRow('c-2doc-resume-both', APP_RESUME_TWO, {
        offer_letter_bucket: BUCKET,
        offer_letter_path: 'contracts/' + APP_RESUME_TWO + '/v1/offer-letter/Letter-of-Offer.pdf',
        offer_letter_filename: 'Letter-of-Offer.pdf',
        offer_letter_mime: 'application/pdf',
        offer_letter_signed_bucket: BUCKET,
        offer_letter_signed_path: 'contracts/' + APP_RESUME_TWO + '/v1/signed/offer-letter/signed-offer-letter.pdf',
        offer_letter_signed_filename: 'signed-offer-letter.pdf',
        offer_letter_signed_at: NOW,
        signed_bucket: BUCKET,
        signed_path: 'contracts/' + APP_RESUME_TWO + '/v1/signed/signed-agreement.pdf',
        signed_filename: 'signed-agreement.pdf',
        contract_signed_at: NOW
      }),
      // The single-document shape of the same accident.
      contractRow('c-2doc-resume-contract', APP_RESUME_ONE, {
        signed_bucket: BUCKET,
        signed_path: 'contracts/' + APP_RESUME_ONE + '/v1/signed/signed-agreement.pdf',
        signed_filename: 'signed-agreement.pdf',
        contract_signed_at: NOW
      })
    ],
    ats_offers: [],
    ats_stage_events: [],
    placements: [],
    user_state: [{ user_id: GP.userId, state: { gp_onboarding_complete: true }, updated_at: NOW }]
  };
  // The practice's originals are in Storage, as they would be after finalize.
  storage.set(BUCKET + '/contracts/' + APP_TWO + '/v1/Employment-Contract.pdf', Buffer.from('%PDF-1.4 contract (both)', 'utf8'));
  storage.set(BUCKET + '/contracts/' + APP_TWO + '/v1/offer-letter/Letter-of-Offer.pdf', Buffer.from('%PDF-1.4 letter of offer', 'utf8'));
  storage.set(BUCKET + '/contracts/' + APP_ONE + '/v1/Employment-Contract.pdf', Buffer.from('%PDF-1.4 contract (only)', 'utf8'));

  function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }
  function buildMatcher(params) {
    const filters = [];
    for (const [k, v] of params.entries()) {
      if (['select', 'limit', 'order', 'on_conflict'].includes(k)) continue;
      const mm = /^(eq|neq|in)\.(.*)$/s.exec(v);
      if (mm) filters.push({ col: k, op: mm[1], val: mm[2] });
    }
    return (row) => filters.every((f) => {
      const cell = row ? row[f.col] : undefined;
      if (f.op === 'in') {
        const inner = f.val.replace(/^\(/, '').replace(/\)$/, '');
        const options = inner ? inner.split(',').map((s) => s.replace(/^"|"$/g, '')) : [];
        return options.indexOf(String(cell)) !== -1;
      }
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

        if (u.pathname.startsWith('/storage/v1/')) {
          let mm = u.pathname.match(/^\/storage\/v1\/object\/upload\/sign\/(.+)$/);
          if (mm && req.method === 'POST') { await readRaw(); sendJson(200, { url: '/object/upload/sign/' + mm[1] + '?token=test-token' }); return; }
          if (mm && req.method === 'PUT') { storage.set(decodeURIComponent(mm[1]), await readRaw()); sendJson(200, { Key: mm[1] }); return; }
          mm = u.pathname.match(/^\/storage\/v1\/object\/sign\/(.+)$/);
          if (mm && req.method === 'POST') { await readRaw(); sendJson(200, { signedURL: '/object/sign/' + mm[1] + '?token=test-sign-token' }); return; }
          mm = u.pathname.match(/^\/storage\/v1\/object\/(?!upload|sign|public)(.+)$/);
          if (mm && req.method === 'GET') {
            const buf = storage.get(decodeURIComponent(mm[1]));
            if (!buf) { res.writeHead(404); res.end('not found'); return; }
            res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(buf); return;
          }
          sendJson(404, { message: 'storage not found' }); return;
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
          const body = JSON.parse((await readRaw()).toString('utf8') || 'null');
          const incoming = Array.isArray(body) ? body : (body ? [body] : []);
          const saved = incoming.map((r) => {
            const row = Object.assign({ id: crypto.randomUUID(), created_at: new Date().toISOString() }, r);
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

  function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
  function gpCookie(user) {
    const payload = b64url(JSON.stringify({ userProfile: { email: user.email, supabaseUserId: user.userId }, expiresAt: Date.now() + 3600000 }));
    const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
    return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
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
  const gpGet = (p) => httpJson('GET', p, null, { Cookie: gpCookie(GP) });
  const gpPost = (p, body) => httpJson('POST', p, body, { Cookie: gpCookie(GP) });
  function putSignedUpload(uploadUrl, buffer, mime) {
    return new Promise((resolve, reject) => {
      const target = new URL(uploadUrl);
      const r = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: 'PUT', headers: { 'Content-Type': mime, 'x-upsert': 'true', 'Content-Length': buffer.length } }, (res) => {
        res.on('data', () => {}); res.on('end', () => resolve({ status: res.statusCode }));
      });
      r.on('error', reject); r.end(buffer);
    });
  }
  const contract = (id) => db.career_contracts.find((c) => c.id === id);
  const appRow = (id) => db.gp_applications.find((a) => a.id === id);
  const PDF_MIME = 'application/pdf';

  beforeAll(async () => {
    await startEmulator();
    process.env.AGENT_SKIP_DOTENV = 'true';
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DISABLED = 'false';
    process.env.AUTH_SECRET = 'contracts-2doc-secret-' + RUN_ID;
    process.env.REQUIRE_SUPABASE_DB = 'false';
    process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
    process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.SUPABASE_DOCUMENT_BUCKET = BUCKET;
    process.env.ENFORCE_SAME_ORIGIN = 'false';
    process.env.DB_FILE_PATH = DB_FILE;
    process.env.OPENAI_API_KEY = '';
    process.env.ANTHROPIC_API_KEY = '';
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.REGISTRATION_HUB_EMAIL = HUB_EMAIL;
    process.env.APP_BASE_URL = 'https://app.mygplink.com.au';

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
    if (realFetch) globalThis.fetch = realFetch;
    if (server) await new Promise((r) => server.close(r));
    if (sbServer) await new Promise((r) => sbServer.close(r));
    try { fs.unlinkSync(DB_FILE); } catch {}
  });

  it('the exported helpers agree on paths and order, and keep the contract paths byte-identical', () => {
    const H = mod.__testUtils;
    const row = { application_id: 'app-x', version: 2 };
    expect(H.careerContractDocumentKey(undefined)).toBe('contract');
    expect(H.careerContractDocumentKey('offer-letter')).toBe('offer_letter');
    expect(H.careerContractDocumentKey('letter')).toBe('offer_letter');
    expect(H.careerContractDocumentKey('OFFER_LETTER')).toBe('offer_letter');
    expect(H.careerContractDocumentKey('anything-else')).toBe('contract');
    expect(H.careerContractStoragePath(row, 'c.pdf')).toBe('contracts/app-x/v2/c.pdf');
    expect(H.careerContractStoragePath(row, 'c.pdf', 'contract')).toBe('contracts/app-x/v2/c.pdf');
    expect(H.careerContractStoragePath(row, 'l.pdf', 'offer_letter')).toBe('contracts/app-x/v2/offer-letter/l.pdf');
    expect(H.careerContractSignedStoragePath(row, 's.pdf')).toBe('contracts/app-x/v2/signed/s.pdf');
    expect(H.careerContractSignedStoragePath(row, 's.pdf', 'offer_letter')).toBe('contracts/app-x/v2/signed/offer-letter/s.pdf');
    // Letter first when present; the contract alone otherwise.
    expect(H.careerContractDocuments({ contract_path: 'a', offer_letter_path: 'b' }).map((d) => d.key)).toEqual(['offer_letter', 'contract']);
    expect(H.careerContractDocuments({ contract_path: 'a' }).map((d) => d.key)).toEqual(['contract']);
    expect(H.careerContractAllSigned({ contract_path: 'a', signed_path: 's' })).toBe(true);
    expect(H.careerContractAllSigned({ contract_path: 'a', offer_letter_path: 'b', signed_path: 's' })).toBe(false);
    expect(H.careerContractAllSigned({ contract_path: 'a', offer_letter_path: 'b', signed_path: 's', offer_letter_signed_path: 't' })).toBe(true);
  });

  // (a)
  it('GET reports the letter of offer, lists the documents letter-first, and nothing is signed yet', async () => {
    const r = await gpGet('/api/career/contract?applicationId=' + APP_TWO);
    expect(r.status).toBe(200);
    const c = r.body.contract;
    expect(c.status).toBe('sent_to_gp');
    expect(c.hasOfferLetter).toBe(true);
    expect(c.allSigned).toBe(false);
    expect(c.contractSigned).toBe(false);
    expect(c.offerLetterSigned).toBe(false);
    expect(c.offerLetterFilename).toBe('Letter-of-Offer.pdf');
    expect(c.offerLetterUrl).toContain('/object/sign/');
    expect(c.offerLetterUrl).toMatch(/Letter-of-Offer\.pdf/);
    expect(c.contractUrl).toMatch(/Employment-Contract\.pdf/);
    expect(c.documents.map((d) => d.key)).toEqual(['offer_letter', 'contract']);
    expect(c.documents[0]).toEqual(expect.objectContaining({ label: 'Letter of offer', signed: false, signedAt: null }));
    expect(c.documents[0].url).toMatch(/offer-letter\/Letter-of-Offer\.pdf/);
    expect(c.documents[1]).toEqual(expect.objectContaining({ label: 'Employment contract', signed: false, signedAt: null }));
    expect(c.documents[1].url).toMatch(/Employment-Contract\.pdf/);

    // The contract-only row is the pre-letter payload plus the honest flags.
    const one = await gpGet('/api/career/contract?applicationId=' + APP_ONE);
    expect(one.body.contract.hasOfferLetter).toBe(false);
    expect(one.body.contract.offerLetterUrl).toBe('');
    expect(one.body.contract.allSigned).toBe(false);
    expect(one.body.contract.documents.map((d) => d.key)).toEqual(['contract']);
  });

  it('preview serves whichever document is asked for', async () => {
    const letter = await gpGet('/api/career/contract/preview?applicationId=' + APP_TWO + '&document=offer_letter');
    expect(letter.status).toBe(200);
    expect(letter.body.kind).toBe('pdf');
    expect(letter.body.document).toBe('offer_letter');
    expect(letter.body.filename).toBe('Letter-of-Offer.pdf');
    expect(letter.body.url).toMatch(/offer-letter\/Letter-of-Offer\.pdf/);
    const dflt = await gpGet('/api/career/contract/preview?applicationId=' + APP_TWO);
    expect(dflt.body.document).toBe('contract');
    expect(dflt.body.filename).toBe('Employment-Contract.pdf');
    const none = await gpGet('/api/career/contract/preview?applicationId=' + APP_ONE + '&document=offer_letter');
    expect(none.status).toBe(200);
    expect(none.body.kind).toBe('none');
  });

  // (b)
  it('signing the letter of offer first: recorded on the row, nothing secured, nobody emailed, the contract still to go', async () => {
    const before = resendCalls.length;
    const sign = await gpPost('/api/career/contract/sign-upload', { applicationId: APP_TWO, filename: 'Signed-Letter.pdf', mimeType: PDF_MIME, document: 'offer_letter' });
    expect(sign.status).toBe(200);
    expect(sign.body.document).toBe('offer_letter');
    expect(sign.body.path).toBe('contracts/' + APP_TWO + '/v1/signed/offer-letter/Signed-Letter.pdf');
    const put = await putSignedUpload(sign.body.uploadUrl, Buffer.from('%PDF-1.4 signed letter', 'utf8'), PDF_MIME);
    expect(put.status).toBe(200);

    const fin = await gpPost('/api/career/contract/finalize-signed', { applicationId: APP_TWO, filename: 'Signed-Letter.pdf', mimeType: PDF_MIME, document: 'offer_letter' });
    expect(fin.status).toBe(200);
    expect(fin.body).toEqual(expect.objectContaining({ ok: true, allSigned: false, placementSecured: false, document: 'offer_letter', signedDocuments: ['offer_letter'], remaining: ['contract'] }));
    expect(fin.body.message).toBe('Letter of offer signed — now sign your employment contract.');

    const c = contract('c-2doc-both');
    expect(c.status).toBe('sent_to_gp');
    expect(c.offer_letter_signed_bucket).toBe(BUCKET);
    expect(c.offer_letter_signed_path).toBe('contracts/' + APP_TWO + '/v1/signed/offer-letter/Signed-Letter.pdf');
    expect(c.offer_letter_signed_filename).toBe('Signed-Letter.pdf');
    expect(c.offer_letter_signed_at).toBeTruthy();
    expect(c.signed_path).toBeUndefined();
    expect(c.signed_at).toBeUndefined();
    expect(c.contract_signed_at).toBeUndefined();
    // No placement, no emails — the contract has not been signed yet.
    expect(appRow(APP_TWO).status).toBe('offer');
    expect(db.placements.find((p) => p.application_id === APP_TWO)).toBeUndefined();
    expect(resendCalls.length).toBe(before);

    // GET now shows the letter ticked (its URL is the SIGNED copy) and the contract still open.
    const r = await gpGet('/api/career/contract?applicationId=' + APP_TWO);
    expect(r.body.contract.status).toBe('sent_to_gp');
    expect(r.body.contract.offerLetterSigned).toBe(true);
    expect(r.body.contract.contractSigned).toBe(false);
    expect(r.body.contract.allSigned).toBe(false);
    expect(r.body.contract.offerLetterUrl).toMatch(/signed\/offer-letter\/Signed-Letter\.pdf/);
    expect(r.body.contract.documents[0]).toEqual(expect.objectContaining({ key: 'offer_letter', signed: true }));
    expect(r.body.contract.documents[0].signedAt).toBeTruthy();
    expect(r.body.contract.documents[0].url).toMatch(/signed\/offer-letter\/Signed-Letter\.pdf/);
    expect(r.body.contract.documents[1]).toEqual(expect.objectContaining({ key: 'contract', signed: false }));
  });

  // (c)
  it('a second signature on the letter is refused: 409 already_signed from finalize-signed and sign-upload alike', async () => {
    const before = resendCalls.length;
    const fin = await gpPost('/api/career/contract/finalize-signed', { applicationId: APP_TWO, filename: 'Signed-Letter.pdf', mimeType: PDF_MIME, document: 'offer_letter' });
    expect(fin.status).toBe(409);
    expect(fin.body.code).toBe('already_signed');
    expect(fin.body.document).toBe('offer_letter');
    const sign = await gpPost('/api/career/contract/sign-upload', { applicationId: APP_TWO, filename: 'Again.pdf', mimeType: PDF_MIME, document: 'letter' });
    expect(sign.status).toBe(409);
    expect(sign.body.code).toBe('already_signed');
    expect(contract('c-2doc-both').offer_letter_signed_path).toBe('contracts/' + APP_TWO + '/v1/signed/offer-letter/Signed-Letter.pdf');
    expect(contract('c-2doc-both').status).toBe('sent_to_gp');
    expect(resendCalls.length).toBe(before);
    // Asking to sign a letter on a row that has none is a plain not_available.
    const noLetter = await gpPost('/api/career/contract/finalize-signed', { applicationId: APP_ONE, filename: 'x.pdf', mimeType: PDF_MIME, document: 'offer_letter' });
    expect(noLetter.status).toBe(409);
    expect(noLetter.body.code).toBe('not_available');
  });

  // (d)
  it('signing the contract last secures the placement, stamps both signed_at fields, and the emails mention the letter with its own link', async () => {
    const before = resendCalls.length;
    const sign = await gpPost('/api/career/contract/sign-upload', { applicationId: APP_TWO, filename: 'Signed-Contract.pdf', mimeType: PDF_MIME });
    expect(sign.status).toBe(200);
    expect(sign.body.document).toBe('contract');
    // The contract's signed path is exactly where it has always been — no /offer-letter/.
    expect(sign.body.path).toBe('contracts/' + APP_TWO + '/v1/signed/Signed-Contract.pdf');
    const put = await putSignedUpload(sign.body.uploadUrl, Buffer.from('%PDF-1.4 signed contract', 'utf8'), PDF_MIME);
    expect(put.status).toBe(200);

    const fin = await gpPost('/api/career/contract/finalize-signed', { applicationId: APP_TWO, filename: 'Signed-Contract.pdf', mimeType: PDF_MIME });
    expect(fin.status).toBe(200);
    expect(fin.body).toEqual({ ok: true, allSigned: true, placementSecured: true });

    const c = contract('c-2doc-both');
    expect(c.status).toBe('signed');
    expect(c.signed_path).toBe('contracts/' + APP_TWO + '/v1/signed/Signed-Contract.pdf');
    expect(c.signed_filename).toBe('Signed-Contract.pdf');
    expect(c.contract_signed_at).toBeTruthy();
    expect(c.signed_at).toBeTruthy();
    expect(c.offer_letter_signed_path).toBe('contracts/' + APP_TWO + '/v1/signed/offer-letter/Signed-Letter.pdf');

    // Secured — the same facts the Task 13 test checks.
    expect(appRow(APP_TWO).status).toBe('placement_secured');
    expect(db.placements.find((p) => p.application_id === APP_TWO)).toBeTruthy();
    const offer = db.ats_offers.find((o) => o.application_id === APP_TWO);
    expect(offer && offer.status).toBe('accepted');

    const sent = resendCalls.slice(before);
    const practiceMail = sent.find((x) => Array.isArray(x.body.to) && x.body.to.includes(PRACTICE_EMAIL) && /has signed/i.test(x.body.subject || ''));
    const ceoMail = sent.find((x) => Array.isArray(x.body.to) && x.body.to.includes(HUB_EMAIL) && /placement secured/i.test(x.body.subject || ''));
    expect(practiceMail).toBeTruthy();
    expect(ceoMail).toBeTruthy();
    for (const mail of [practiceMail, ceoMail]) {
      expect(mail.body.html).toMatch(/letter of offer and the employment contract|letter of offer and employment contract/);
      // The CTA is the signed CONTRACT (never the letter, even though the
      // letter was signed in an earlier call), and the letter has its own link.
      expect(mail.body.html).toContain('Download the signed contract');
      expect(mail.body.html).toMatch(/signed\/Signed-Contract\.pdf/);
      expect(mail.body.html).toContain('Download the signed letter of offer');
      expect(mail.body.html).toMatch(/signed\/offer-letter\/Signed-Letter\.pdf/);
    }
    expect(practiceMail.body.subject).toMatch(/letter of offer/i);

    const r = await gpGet('/api/career/contract?applicationId=' + APP_TWO);
    expect(r.body.contract.status).toBe('signed');
    expect(r.body.contract.allSigned).toBe(true);
    expect(r.body.contract.contractSigned).toBe(true);
    expect(r.body.contract.offerLetterSigned).toBe(true);
    expect(r.body.contract.placementSecured).toBe(true);
    expect(r.body.contract.documents.every((d) => d.signed)).toBe(true);
    // A replay is refused the moment the application is secured.
    const replay = await gpPost('/api/career/contract/finalize-signed', { applicationId: APP_TWO, filename: 'Signed-Contract.pdf', mimeType: PDF_MIME });
    expect(replay.status).toBe(409);
  });

  // (e) regression
  it('a contract-only row signs exactly as before: one call, no document, all signed, placement secured, emails without any letter', async () => {
    const before = resendCalls.length;
    const sign = await gpPost('/api/career/contract/sign-upload', { applicationId: APP_ONE, filename: 'Helen-Signed.pdf', mimeType: PDF_MIME });
    expect(sign.status).toBe(200);
    expect(sign.body.path).toBe('contracts/' + APP_ONE + '/v1/signed/Helen-Signed.pdf');
    await putSignedUpload(sign.body.uploadUrl, Buffer.from('%PDF-1.4 signed by Helen', 'utf8'), PDF_MIME);

    const fin = await gpPost('/api/career/contract/finalize-signed', { applicationId: APP_ONE, path: sign.body.path, filename: 'Helen-Signed.pdf', mimeType: PDF_MIME });
    expect(fin.status).toBe(200);
    expect(fin.body.ok).toBe(true);
    expect(fin.body.placementSecured).toBe(true);
    expect(fin.body.allSigned).toBe(true);

    const c = contract('c-2doc-contract');
    expect(c.status).toBe('signed');
    expect(c.signed_at).toBeTruthy();
    expect(c.contract_signed_at).toBeTruthy();
    expect(c.signed_path).toBe('contracts/' + APP_ONE + '/v1/signed/Helen-Signed.pdf');
    expect(c.offer_letter_signed_path).toBeUndefined();
    expect(appRow(APP_ONE).status).toBe('placement_secured');
    expect(db.placements.find((p) => p.application_id === APP_ONE)).toBeTruthy();

    const sent = resendCalls.slice(before);
    const practiceMail = sent.find((x) => Array.isArray(x.body.to) && x.body.to.includes(PRACTICE_EMAIL) && /has signed/i.test(x.body.subject || ''));
    const ceoMail = sent.find((x) => Array.isArray(x.body.to) && x.body.to.includes(HUB_EMAIL) && /placement secured/i.test(x.body.subject || ''));
    expect(practiceMail).toBeTruthy();
    expect(ceoMail).toBeTruthy();
    expect(practiceMail.body.subject).toBe('Dr Rivers has signed the employment contract');
    for (const mail of [practiceMail, ceoMail]) {
      expect(mail.body.html).not.toMatch(/letter of offer/i);
      expect(mail.body.html).toContain('Download the signed contract');
      expect(mail.body.html).toMatch(/signed\/Helen-Signed\.pdf/);
    }

    const r = await gpGet('/api/career/contract?applicationId=' + APP_ONE);
    expect(r.body.contract.status).toBe('signed');
    expect(r.body.contract.allSigned).toBe(true);
    expect(r.body.contract.hasOfferLetter).toBe(false);
    expect(r.body.contract.documents).toHaveLength(1);
    expect(r.body.contract.documents[0]).toEqual(expect.objectContaining({ key: 'contract', signed: true }));
  });

  // Resume after a died call: every copy is recorded but status never flipped.
  it('two documents, both copies recorded, still sent_to_gp: finalize-signed for either document finishes the job instead of 409ing', async () => {
    const before = resendCalls.length;
    // Sanity: nothing about this row says "signed" yet.
    expect(contract('c-2doc-resume-both').status).toBe('sent_to_gp');
    expect(appRow(APP_RESUME_TWO).status).toBe('offer');

    const fin = await gpPost('/api/career/contract/finalize-signed', { applicationId: APP_RESUME_TWO, filename: 'signed-offer-letter.pdf', mimeType: PDF_MIME, document: 'offer_letter' });
    expect(fin.status).toBe(200);
    expect(fin.body).toEqual({ ok: true, allSigned: true, placementSecured: true });

    const c = contract('c-2doc-resume-both');
    expect(c.status).toBe('signed');
    expect(c.signed_at).toBeTruthy();
    // The recorded copies are untouched — resume never re-writes a document.
    expect(c.signed_path).toBe('contracts/' + APP_RESUME_TWO + '/v1/signed/signed-agreement.pdf');
    expect(c.offer_letter_signed_path).toBe('contracts/' + APP_RESUME_TWO + '/v1/signed/offer-letter/signed-offer-letter.pdf');
    expect(c.contract_signed_at).toBe(NOW);
    expect(c.offer_letter_signed_at).toBe(NOW);
    expect(appRow(APP_RESUME_TWO).status).toBe('placement_secured');
    expect(db.placements.find((p) => p.application_id === APP_RESUME_TWO)).toBeTruthy();

    // Exactly one set of signed-copy emails (practice + CEO), both with the
    // letter link. The placement itself also congratulates the doctor, so the
    // count is of the "has signed" pair, not of every Resend call.
    const sent = resendCalls.slice(before).filter((x) => /has signed/i.test((x.body && x.body.subject) || ''));
    expect(sent).toHaveLength(2);
    expect(sent.find((x) => x.body.to.includes(PRACTICE_EMAIL))).toBeTruthy();
    expect(sent.find((x) => x.body.to.includes(HUB_EMAIL))).toBeTruthy();
    for (const mail of sent) {
      expect(mail.body.html).toMatch(/signed\/signed-agreement\.pdf/);
      expect(mail.body.html).toMatch(/signed\/offer-letter\/signed-offer-letter\.pdf/);
    }
    // And a replay is refused as always once the application is secured.
    const replay = await gpPost('/api/career/contract/finalize-signed', { applicationId: APP_RESUME_TWO, filename: 'signed-agreement.pdf', mimeType: PDF_MIME });
    expect(replay.status).toBe(409);
    expect(resendCalls.slice(before).filter((x) => /has signed/i.test((x.body && x.body.subject) || ''))).toHaveLength(2);
  });

  it('single document, copy recorded, still sent_to_gp: finalize-signed finishes the job', async () => {
    const before = resendCalls.length;
    const fin = await gpPost('/api/career/contract/finalize-signed', { applicationId: APP_RESUME_ONE, filename: 'signed-agreement.pdf', mimeType: PDF_MIME });
    expect(fin.status).toBe(200);
    expect(fin.body).toEqual({ ok: true, allSigned: true, placementSecured: true });
    const c = contract('c-2doc-resume-contract');
    expect(c.status).toBe('signed');
    expect(c.signed_at).toBeTruthy();
    expect(c.signed_path).toBe('contracts/' + APP_RESUME_ONE + '/v1/signed/signed-agreement.pdf');
    expect(appRow(APP_RESUME_ONE).status).toBe('placement_secured');
    expect(db.placements.find((p) => p.application_id === APP_RESUME_ONE)).toBeTruthy();
    expect(resendCalls.slice(before).filter((x) => /has signed/i.test((x.body && x.body.subject) || ''))).toHaveLength(2);
  });

  it('but a document that is already signed while OTHERS remain is still 409 already_signed', () => {
    // Pinned by the live cases above (letter signed twice on APP_TWO → 409);
    // the resume path only opens when careerContractAllSigned is true.
    const fn = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const start = fn.indexOf("if (pathname === '/api/career/contract/finalize-signed'");
    const body = fn.slice(start, start + 6000);
    expect(body).toContain('const fsResume = !!fsDoc.signed && careerContractAllSigned(fsContract);');
    expect(body).toContain('if (fsDoc.signed && !fsResume) {');
  });
});

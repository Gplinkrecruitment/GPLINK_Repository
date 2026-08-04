// Task 3 — careers profile gate: GET status, POST CV (AI-checked genuine-CV
// gate before storage), POST cover letter (no AI scan). Boots the real server
// against a tiny in-memory PostgREST emulator (same pattern as
// tests/career-dpa-gate.test.js) plus a second emulator standing in for the
// Anthropic Messages API.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';

const RUN_ID = crypto.randomBytes(4).toString('hex');
let server, baseUrl, port, sbServer, aiServer, aiMode = 'genuine_cv';
const db = {
  user_profiles: [{ user_id: 'u-gate-1', email: 'gate-gp@example.com', first_name: 'Gate', last_name: 'Tester', registration_country: 'uk' }],
  user_state: [{ user_id: 'u-gate-1', state: { gp_onboarding_complete: true } }],
  user_documents: [],
  runtime_kv: [],
  gp_applications: [],
  // Seeded internal-ATS role for the apply-gate tests below — mirrors the
  // role fixture in tests/career-internal-apply.test.js. dpa:true so a
  // uk-registered (non-Australia-trained) test GP still clears the
  // server-side DPA qualification gate inside /api/career/apply and the
  // CV gate is the only thing under test.
  career_roles: [
    { id: 'role-gate-cv', provider: 'internal_ats', provider_role_id: 'gate_cv_role', title: 'GP — Gate CV Test Role', practice_name: 'Gate Test Practice', is_active: true, job_status: 'open', dpa: true, updated_at: '2026-01-01T00:00:00Z' }
  ],
  scheduled_calls: [], ats_offers: []
};
const SEEDED_ROLE_ID = 'internal_ats:gate_cv_role';
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

// Copied (verbatim, plus a multi-column on_conflict fix — see note below) from
// tests/career-dpa-gate.test.js's startSupabaseEmulator/buildMatcher.
const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'];
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue;
    const val = raw.slice(dot + 1);
    filters.push({ col: key, op, val });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
    if (op === 'neq') return String(cell) !== val;
    if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    if (op === 'in') {
      return val.replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''))
        .includes(String(cell));
    }
    return true;
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); }
      catch { resolve(null); }
    });
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
      // supabaseStorageUploadObject POSTs here — accept anything.
      if (u.pathname.startsWith('/storage/v1/')) { send(200, {}); return; }

      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const rows = tableOf(decodeURIComponent(m[1]));
      const matches = buildMatcher(u.searchParams);

      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out);
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        // NOTE: the reference emulator (career-dpa-gate.test.js) reads
        // on_conflict as a single literal key, so a multi-column conflict
        // target like "user_id,document_key,country_code" never matches any
        // real row and silently clobbers whichever row happens to be first
        // in the table. saveCareerProfileDocument uses exactly that 3-column
        // on_conflict, so this copy splits it and matches on every column —
        // otherwise "store a cover letter" would silently overwrite the CV
        // row saved by the previous test instead of inserting a new row.
        const conflictCols = (u.searchParams.get('on_conflict') || '')
          .split(',').map((s) => s.trim()).filter(Boolean);
        const saved = incoming.map((r) => {
          if (conflictCols.length) {
            const existing = rows.find((row) => row && conflictCols.every((c) => String(row[c]) === String(r[c])));
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
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched);
        return;
      }
      if (req.method === 'DELETE') {
        const keep = rows.filter((row) => !matches(row));
        rows.length = 0;
        keep.forEach((row) => rows.push(row));
        send(200, []);
        return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => resolve());
  });
}

function startAnthropicEmulator() {
  aiServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (aiMode === 'ai_down') {
        // Simulates an AI outage / malformed response: verifyCareerCvWithAI's
        // resp.json() throws, caught -> { ok:false, reason:'ai_error' }.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('not valid json');
        return;
      }
      const genuine = aiMode === 'genuine_cv' || aiMode === 'wrong_name';
      // nameFound drives the identity guard. 'genuine_cv' reads the account
      // holder's own name; 'wrong_name' reads a DIFFERENT doctor's, which is
      // the wrong-attachment case the guard exists to stop.
      const nameFound = aiMode === 'wrong_name' ? 'Sana Ahsan'
        : (aiMode === 'genuine_cv' ? 'Gate Tester' : null);
      const payload = {
        content: [{ type: 'text', text: JSON.stringify({ isCv: genuine, nameFound: nameFound, reason: genuine ? 'Curriculum vitae with work history' : 'This appears to be an employment contract, not a CV' }) }],
        usage: { input_tokens: 100, output_tokens: 20 }
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve));
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function userCookie(email, userId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId: userId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { cookie, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject); r.end(data);
  });
}

const PDF_B64 = Buffer.from('%PDF-1.4 fake cv for tests').toString('base64');
const ATS_HOST = 'ats-cv-test.local';
function adminCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'ceo@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'test-secret-' + RUN_ID;
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = ATS_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'ceo@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  // start emulators first, then point env at them BEFORE importing server.js
  await startSupabaseEmulator();
  await startAnthropicEmulator();
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbServer.address().port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  process.env.ANTHROPIC_MESSAGES_URL = `http://127.0.0.1:${aiServer.address().port}/v1/messages`;
  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; baseUrl = `http://127.0.0.1:${port}`; r(); }));
});
afterAll(async () => { server?.close(); sbServer?.close(); aiServer?.close(); });

describe('career profile gate', () => {
  const cookie = () => userCookie('gate-gp@example.com', 'u-gate-1');

  it('status starts empty', async () => {
    const res = await httpReq('GET', '/api/career/profile/status', { cookie: cookie() });
    expect(res.status).toBe(200);
    expect(res.body.cv).toBeNull();
    expect(res.body.coverLetter).toBeNull();
    expect(res.body.scanRemaining).toBeGreaterThan(0);
    // Non-placed, no career_cv yet: the gate must open.
    expect(res.body.gateRequired).toBe(true);
    expect(res.body.placed).toBe(false);
  });

  it('rejects an unsupported .doc CV WITHOUT spending a daily scan attempt', async () => {
    // A legacy Word .doc can never pass the AI CV check, so letting it consume
    // a scan would burn one of the GP's limited daily attempts (and could lock
    // them out of the non-dismissible apply gate for 24h). Isolated user so the
    // scan-budget accounting of the other tests is untouched.
    db.user_profiles.push({ user_id: 'u-doc-reject', email: 'doc-reject@example.com', registration_country: 'uk' });
    const c = userCookie('doc-reject@example.com', 'u-doc-reject');
    const before = await httpReq('GET', '/api/career/profile/status', { cookie: c });
    const remainingBefore = before.body.scanRemaining;
    expect(remainingBefore).toBeGreaterThan(0);
    const res = await httpReq('POST', '/api/career/profile/cv', { cookie: c, body: { fileName: 'legacy.doc', fileBase64: PDF_B64, mimeType: 'application/msword', fileSize: 1000 } });
    expect(res.status).toBe(422);
    expect(res.body.verified).toBe(false);
    expect(res.body.reason).toMatch(/save your CV as a PDF or Word/i);
    // No scan attempt was consumed — the rejection happens before the spend.
    const after = await httpReq('GET', '/api/career/profile/status', { cookie: c });
    expect(after.body.scanRemaining).toBe(remainingBefore);
    // Nothing was stored either.
    expect(db.user_documents.filter((d) => d.user_id === 'u-doc-reject')).toHaveLength(0);
  });

  it('a GP with a secured placement and no career_cv gets gateRequired:false (server truth beats a stale client cache)', async () => {
    db.user_profiles.push({ user_id: 'u-gate-placed', email: 'gate-placed@example.com', registration_country: 'uk' });
    db.user_state.push({ user_id: 'u-gate-placed', state: { gp_onboarding_complete: true } });
    db.gp_applications.push({ id: 'app-placed-1', user_id: 'u-gate-placed', status: 'placed' });
    const res = await httpReq('GET', '/api/career/profile/status', { cookie: userCookie('gate-placed@example.com', 'u-gate-placed') });
    expect(res.status).toBe(200);
    expect(res.body.cv).toBeNull();
    expect(res.body.gateRequired).toBe(false);
    expect(res.body.placed).toBe(true);
  });

  it('rejects a non-CV upload and stores nothing', async () => {
    aiMode = 'not_cv';
    const res = await httpReq('POST', '/api/career/profile/cv', { cookie: cookie(), body: { fileName: 'contract.pdf', fileBase64: PDF_B64, mimeType: 'application/pdf', fileSize: 1000 } });
    expect(res.status).toBe(422);
    expect(res.body.verified).toBe(false);
    expect(res.body.reason).toMatch(/contract/i);
    expect(db.user_documents.filter((d) => d.document_key === 'career_cv')).toHaveLength(0);
  });

  it('accepts a genuine CV, stores it, status reflects it', async () => {
    aiMode = 'genuine_cv';
    const res = await httpReq('POST', '/api/career/profile/cv', { cookie: cookie(), body: { fileName: 'Smith-Miller-CV.pdf', fileBase64: PDF_B64, mimeType: 'application/pdf', fileSize: 1000 } });
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    const rows = db.user_documents.filter((d) => d.document_key === 'career_cv' && d.status === 'uploaded');
    expect(rows).toHaveLength(1);
    const st = await httpReq('GET', '/api/career/profile/status', { cookie: cookie() });
    expect(st.body.cv.fileName).toBe('Smith-Miller-CV.pdf');
  });

  it('stores a cover letter without AI scan', async () => {
    const res = await httpReq('POST', '/api/career/profile/cover-letter', { cookie: cookie(), body: { fileName: 'CL.pdf', fileBase64: PDF_B64, mimeType: 'application/pdf', fileSize: 500 } });
    expect(res.status).toBe(200);
    expect(db.user_documents.filter((d) => d.document_key === 'career_cover_letter')).toHaveLength(1);
    // The earlier CV row must still be intact — this is exactly what the
    // multi-column on_conflict fix above protects against.
    expect(db.user_documents.filter((d) => d.document_key === 'career_cv')).toHaveLength(1);
  });

  it('accepts the upload unscanned when the AI check is unavailable (never blocks a GP on our outage)', async () => {
    aiMode = 'ai_down';
    const res = await httpReq('POST', '/api/career/profile/cv', { cookie: cookie(), body: { fileName: 'Fallback-Accepted-CV.pdf', fileBase64: PDF_B64, mimeType: 'application/pdf', fileSize: 1000 } });
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    // Upsert replaces the earlier genuine-CV row rather than adding a second one.
    const rows = db.user_documents.filter((d) => d.document_key === 'career_cv' && d.status === 'uploaded');
    expect(rows).toHaveLength(1);
    const st = await httpReq('GET', '/api/career/profile/status', { cookie: cookie() });
    expect(st.body.cv.fileName).toBe('Fallback-Accepted-CV.pdf');
  });

  it('rate limits scans after the daily cap', async () => {
    aiMode = 'not_cv';
    let last;
    for (let i = 0; i < 10; i++) {
      last = await httpReq('POST', '/api/career/profile/cv', { cookie: cookie(), body: { fileName: 'x.pdf', fileBase64: PDF_B64, mimeType: 'application/pdf', fileSize: 100 } });
      if (last.status === 429) break;
    }
    expect(last.status).toBe(429);
  });

  it('rejects oversized uploads', async () => {
    const res = await httpReq('POST', '/api/career/profile/cv', { cookie: cookie(), body: { fileName: 'big.pdf', fileBase64: PDF_B64, mimeType: 'application/pdf', fileSize: 5 * 1024 * 1024 } });
    expect(res.status).toBe(413);
  });

  it('rejects uploads with small fileSize but large decoded buffer', async () => {
    // Create a base64 string that decodes to > 3 MB
    const largeBuffer = Buffer.alloc(3 * 1024 * 1024 + 100, 65);
    const largeBase64 = largeBuffer.toString('base64');
    const res = await httpReq('POST', '/api/career/profile/cv', { cookie: cookie(), body: { fileName: 'fake.pdf', fileBase64: largeBase64, mimeType: 'application/pdf', fileSize: 100 } });
    expect(res.status).toBe(413);
  });

  it('requires auth', async () => {
    const res = await httpReq('GET', '/api/career/profile/status', {});
    expect([401, 403]).toContain(res.status);
  });
});

describe('apply gate requires career_cv', () => {
  it('403 requiresCv when GP has legacy cv_signed_dated but no career_cv', async () => {
    db.user_documents.push({ id: 'doc-legacy', user_id: 'u-gate-2', document_key: 'cv_signed_dated', status: 'uploaded', country_code: 'uk', file_name: 'old.pdf', updated_at: '2026-01-01T00:00:00Z' });
    db.user_profiles.push({ user_id: 'u-gate-2', email: 'gate2@example.com', registration_country: 'uk' });
    db.user_state.push({ user_id: 'u-gate-2', state: { gp_onboarding_complete: true } });
    const res = await httpReq('POST', '/api/career/apply', { cookie: userCookie('gate2@example.com', 'u-gate-2'), body: { roleId: SEEDED_ROLE_ID } });
    expect(res.status).toBe(403);
    expect(res.body.requiresCv).toBe(true);
  });
  it('apply succeeds once career_cv is uploaded', async () => {
    aiMode = 'genuine_cv';
    await httpReq('POST', '/api/career/profile/cv', { cookie: userCookie('gate2@example.com', 'u-gate-2'), body: { fileName: 'cv.pdf', fileBase64: PDF_B64, mimeType: 'application/pdf', fileSize: 900 } });
    const res = await httpReq('POST', '/api/career/apply', { cookie: userCookie('gate2@example.com', 'u-gate-2'), body: { roleId: SEEDED_ROLE_ID } });
    expect(res.status).toBe(200);
  });
});

describe('career_cv approved status is not excluded from the gate', () => {
  it('a GP whose career_cv was reviewed and approved (status=approved, not uploaded) still has cv non-null and gateRequired:false', async () => {
    // Review/delivery flows PATCH user_documents.status to 'approved' after
    // the CV was uploaded. getCareerProfileDocument must not exclude it —
    // only rejected/superseded rows should be filtered out.
    db.user_profiles.push({ user_id: 'u-gate-approved', email: 'gate-approved@example.com', registration_country: 'uk' });
    db.user_state.push({ user_id: 'u-gate-approved', state: { gp_onboarding_complete: true } });
    db.user_documents.push({ id: 'doc-approved-cv', user_id: 'u-gate-approved', document_key: 'career_cv', status: 'approved', country_code: 'uk', file_name: 'Approved-CV.pdf', updated_at: '2026-01-01T00:00:00Z' });
    const res = await httpReq('GET', '/api/career/profile/status', { cookie: userCookie('gate-approved@example.com', 'u-gate-approved') });
    expect(res.status).toBe(200);
    expect(res.body.cv).not.toBeNull();
    expect(res.body.cv.fileName).toBe('Approved-CV.pdf');
    expect(res.body.gateRequired).toBe(false);
  });
});

// Owner request 2026-08-05: "i sometimes get sent CVs via email so let me
// upload them directly onto their profile from the ceo dashboard which then
// unlocks the career page since their cv has been uploaded".
//
// The point of these tests is the CONSEQUENCE, not just the write: a CV filed
// by staff must satisfy the same career-page gate the doctor's own upload
// satisfies. It does so by construction (identical document_key via
// saveCareerProfileDocument), and the gate assertion below is what pins that.
describe('staff-filed careers CV (POST /api/ats/candidate/career-cv)', () => {
  const ats = (body) => httpReq('POST', '/api/ats/candidate/career-cv', { cookie: adminCookie(), host: ATS_HOST, body });

  beforeAll(() => {
    db.user_profiles.push(
      { user_id: 'u-staff-cv', email: 'staff-cv@example.com', first_name: 'Gate', last_name: 'Tester', registration_country: 'uk' },
      { user_id: 'u-staff-cv2', email: 'staff-cv2@example.com', first_name: 'Gate', last_name: 'Tester', registration_country: 'uk' }
    );
    db.user_state.push(
      { user_id: 'u-staff-cv', state: { gp_onboarding_complete: true } },
      { user_id: 'u-staff-cv2', state: { gp_onboarding_complete: true } }
    );
  });

  it('stores the CV as career_cv and UNLOCKS the career page for that doctor', async () => {
    aiMode = 'genuine_cv';
    // Before: the doctor is gated.
    const before = await httpReq('GET', '/api/career/profile/status', { cookie: userCookie('staff-cv@example.com', 'u-staff-cv') });
    expect(before.body.cv).toBeNull();
    expect(before.body.gateRequired).toBe(true);

    const res = await ats({ user_id: 'u-staff-cv', fileName: 'emailed-cv.pdf', mimeType: 'application/pdf', fileSize: 1000, fileBase64: PDF_B64 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // It is the SAME document key the doctor's own upload writes — that is
    // what makes every downstream gate work without a special case.
    const row = db.user_documents.find((d) => d.user_id === 'u-staff-cv' && d.document_key === 'career_cv');
    expect(row).toBeTruthy();
    expect(row.file_name).toBe('emailed-cv.pdf');
    // Staff filing it IS the review, so it lands approved rather than parked
    // in a pending state nothing would ever clear.
    expect(row.status).toBe('approved');

    // After: the gate is satisfied. THE point of the feature.
    const after = await httpReq('GET', '/api/career/profile/status', { cookie: userCookie('staff-cv@example.com', 'u-staff-cv') });
    expect(after.body.cv).not.toBeNull();
    expect(after.body.gateRequired).toBe(false);
  });

  it('refuses a CV in someone else\'s name and stores NOTHING', async () => {
    // The wrong-attachment case. A CV filed under the wrong doctor becomes a
    // PII breach the moment it is emailed to a practice as them — which is
    // exactly what happened once with Sana Ahsan's CV under another account.
    aiMode = 'wrong_name';
    const res = await ats({ user_id: 'u-staff-cv2', fileName: 'someone-else.pdf', mimeType: 'application/pdf', fileSize: 1000, fileBase64: PDF_B64 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('identity_mismatch');
    // The message names BOTH names so the mistake is obvious.
    expect(res.body.message).toMatch(/Sana Ahsan/);
    expect(res.body.message).toMatch(/Gate Tester/);
    expect(db.user_documents.filter((d) => d.user_id === 'u-staff-cv2' && d.document_key === 'career_cv')).toHaveLength(0);
    aiMode = 'genuine_cv';
  });

  it('refuses a document that is not a CV', async () => {
    aiMode = 'not_cv';
    const res = await ats({ user_id: 'u-staff-cv2', fileName: 'contract.pdf', mimeType: 'application/pdf', fileSize: 1000, fileBase64: PDF_B64 });
    expect(res.status).toBe(422);
    expect(db.user_documents.filter((d) => d.user_id === 'u-staff-cv2' && d.document_key === 'career_cv')).toHaveLength(0);
    aiMode = 'genuine_cv';
  });

  it('still files the CV when the AI check is unavailable (our outage must not block staff)', async () => {
    aiMode = 'ai_down';
    const res = await ats({ user_id: 'u-staff-cv2', fileName: 'unscanned.pdf', mimeType: 'application/pdf', fileSize: 1000, fileBase64: PDF_B64 });
    expect(res.status).toBe(200);
    expect(db.user_documents.filter((d) => d.user_id === 'u-staff-cv2' && d.document_key === 'career_cv')).toHaveLength(1);
    aiMode = 'genuine_cv';
  });

  it('rejects an unsupported file type and an oversized file', async () => {
    const bad = await ats({ user_id: 'u-staff-cv', fileName: 'legacy.doc', mimeType: 'application/msword', fileSize: 1000, fileBase64: PDF_B64 });
    expect(bad.status).toBe(422);
    // Size is checked on the DECODED bytes, not the browser's claim.
    const big = Buffer.alloc(3 * 1024 * 1024 + 10, 0x41).toString('base64');
    const large = await ats({ user_id: 'u-staff-cv', fileName: 'huge.pdf', mimeType: 'application/pdf', fileSize: 10, fileBase64: big });
    expect(large.status).toBe(413);
  });

  it('needs a case_id or user_id, and an ATS session', async () => {
    const noTarget = await ats({ fileName: 'cv.pdf', mimeType: 'application/pdf', fileSize: 10, fileBase64: PDF_B64 });
    expect(noTarget.status).toBe(400);
    const anon = await httpReq('POST', '/api/ats/candidate/career-cv', { host: ATS_HOST, body: { user_id: 'u-staff-cv', fileName: 'cv.pdf', mimeType: 'application/pdf', fileSize: 10, fileBase64: PDF_B64 } });
    expect([302, 401, 403, 404]).toContain(anon.status);
  });
});

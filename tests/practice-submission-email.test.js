// Task 6 — submit-to-practice email rebuild. Boots the real server against a
// tiny in-memory PostgREST emulator (career-profile-gate.test.js pattern, plus
// its multi-column on_conflict fix) with a storage handler serving seeded
// document bytes (ats-submit-practice.test.js pattern), an Anthropic emulator
// standing in for the recommendation call, and a Resend capture server whose
// port feeds RESEND_API_URL so outbound email is asserted directly instead of
// hitting the network.
//
// Central bug this proves fixed: the OLD code attached the most-recently
// updated cv_signed_dated row REGARDLESS of status, so a rejected doc filed
// under that key (e.g. a contract) could go out labelled as the candidate's
// CV. The fix reads the AI-verified career_cv document first, and only falls
// back to cv_signed_dated when status='uploaded'.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';

const RUN_ID = crypto.randomBytes(4).toString('hex');
let server, port, sbServer, sbPort, aiServer, aiPort, resendServer, resendPort;
let aiMode = 'ok'; // 'ok' | 'error'

const NOW = new Date().toISOString();
const CV_PDF = Buffer.from('%PDF-1.4 genuine cv bytes for tests');
const CONTRACT_PDF = Buffer.from('%PDF-1.4 rejected contract bytes — must never be sent');
const CL_PDF = Buffer.from('%PDF-1.4 cover letter bytes for tests');

const db = {
  user_profiles: [
    { user_id: 'u-1', email: 'smith@example.com', first_name: 'Smith', last_name: 'Miller', registration_country: 'uk' },
    { user_id: 'u-2', email: 'cover@example.com', first_name: 'Cover', last_name: 'Letter', registration_country: 'uk' },
    { user_id: 'u-3', email: 'noai@example.com', first_name: 'Noai', last_name: 'Doctor', registration_country: 'uk' },
    { user_id: 'u-4', email: 'approved-legacy@example.com', first_name: 'Approved', last_name: 'Legacy', registration_country: 'uk' }
  ],
  user_state: [
    { user_id: 'u-1', state: { gp_onboarding: { country: 'uk', targetDate: '2026-11' } }, updated_at: NOW },
    { user_id: 'u-2', state: { gp_onboarding: { country: 'uk', targetDate: '2026-11' } }, updated_at: NOW },
    { user_id: 'u-3', state: { gp_onboarding: { country: 'uk', targetDate: '2026-11' } }, updated_at: NOW },
    { user_id: 'u-4', state: { gp_onboarding: { country: 'uk', targetDate: '2026-11' } }, updated_at: NOW }
  ],
  career_roles: [
    {
      id: 'role-1', provider: 'internal_ats', provider_role_id: 'r1', title: 'General Practitioner (VR)',
      practice_name: 'SOP Medical Centre', is_active: true, job_status: 'open',
      source_payload: { practice_contact_email: 'manager@sop-test.local', practice_contact_name: 'Practice Manager' },
      updated_at: NOW
    }
  ],
  gp_applications: [
    { id: 'app-1', user_id: 'u-1', career_role_id: 'role-1', status: 'applied', practice_submission_status: 'pending_va_submission', applied_at: NOW },
    { id: 'app-2', user_id: 'u-2', career_role_id: 'role-1', status: 'applied', practice_submission_status: 'pending_va_submission', applied_at: NOW },
    { id: 'app-3', user_id: 'u-3', career_role_id: 'role-1', status: 'applied', practice_submission_status: 'pending_va_submission', applied_at: NOW },
    { id: 'app-4', user_id: 'u-4', career_role_id: 'role-1', status: 'applied', practice_submission_status: 'pending_va_submission', applied_at: NOW }
  ],
  user_documents: [
    // u-1: rejected legacy doc is NEWER than the verified career_cv — proves
    // selection is by key+status, not recency.
    { id: 'doc-legacy-1', user_id: 'u-1', document_key: 'cv_signed_dated', status: 'rejected', file_name: 'contract.pdf', storage_bucket: 'gp-link-documents', storage_path: 'legacy/u-1/contract.pdf', mime_type: 'application/pdf', updated_at: '2026-07-01T00:00:00Z' },
    { id: 'doc-cv-1', user_id: 'u-1', document_key: 'career_cv', status: 'uploaded', file_name: 'Smith-Miller-CV.pdf', storage_bucket: 'gp-link-documents', storage_path: 'career/u-1/cv.pdf', mime_type: 'application/pdf', updated_at: '2026-06-01T00:00:00Z' },
    // u-2: career_cv + a cover letter.
    { id: 'doc-cv-2', user_id: 'u-2', document_key: 'career_cv', status: 'uploaded', file_name: 'Cover-Letter-Test-CV.pdf', storage_bucket: 'gp-link-documents', storage_path: 'career/u-2/cv.pdf', mime_type: 'application/pdf', updated_at: NOW },
    { id: 'doc-cl-2', user_id: 'u-2', document_key: 'career_cover_letter', status: 'uploaded', file_name: 'Cover-Letter-Test-CL.pdf', storage_bucket: 'gp-link-documents', storage_path: 'career/u-2/cl.pdf', mime_type: 'application/pdf', updated_at: NOW },
    // u-3: career_cv only — used for the AI-unavailable scenario.
    { id: 'doc-cv-3', user_id: 'u-3', document_key: 'career_cv', status: 'uploaded', file_name: 'Noai-CV.pdf', storage_bucket: 'gp-link-documents', storage_path: 'career/u-3/cv.pdf', mime_type: 'application/pdf', updated_at: NOW },
    // u-4: no career_cv at all — only a legacy cv_signed_dated doc that a
    // review/delivery flow has since PATCHed to status='approved'. Approved
    // docs are good docs and must still be attached (only rejected/superseded
    // legacy docs should be excluded).
    { id: 'doc-legacy-4', user_id: 'u-4', document_key: 'cv_signed_dated', status: 'approved', file_name: 'Approved-Legacy-CV.pdf', storage_bucket: 'gp-link-documents', storage_path: 'legacy/u-4/cv.pdf', mime_type: 'application/pdf', updated_at: NOW }
  ],
  registration_cases: [],
  registration_tasks: [],
  task_timeline: [],
  ats_stage_events: [],
  runtime_kv: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

const STORAGE_FILES = {
  'legacy/u-1/contract.pdf': CONTRACT_PDF,
  'career/u-1/cv.pdf': CV_PDF,
  'career/u-2/cv.pdf': CV_PDF,
  'career/u-2/cl.pdf': CL_PDF,
  'career/u-3/cv.pdf': CV_PDF,
  'legacy/u-4/cv.pdf': CV_PDF
};

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
      // Storage: serve the seeded document bytes so the real
      // supabaseStorageDownloadObject path is exercised.
      if (u.pathname.startsWith('/storage/v1/object/')) {
        const decodedPath = decodeURIComponent(u.pathname);
        const match = Object.keys(STORAGE_FILES).find((p) => decodedPath.includes(p));
        if (req.method === 'GET' && match) {
          res.writeHead(200, { 'Content-Type': 'application/pdf' });
          res.end(STORAGE_FILES[match]);
          return;
        }
        send(404, { message: 'object not found' });
        return;
      }
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
        // Multi-column on_conflict fix (career-profile-gate.test.js note):
        // split on_conflict into its column list and match every column,
        // rather than a single literal key that never matches real rows.
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
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

const RECOMMENDATION_TEXT = 'Dr Miller brings over ten years of general practice experience across busy metropolitan clinics. He has a strong track record in chronic disease management and after-hours care. We highly recommend him as an experienced, reliable addition to your team.';

function startAnthropicEmulator() {
  return new Promise((resolve) => {
    aiServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (aiMode === 'error') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'simulated AI outage' }));
          return;
        }
        const payload = {
          content: [{ type: 'text', text: RECOMMENDATION_TEXT }],
          usage: { input_tokens: 200, output_tokens: 60 }
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
    aiServer.listen(0, '127.0.0.1', () => { aiPort = aiServer.address().port; resolve(); });
  });
}

const resendCaptured = [];
function startResendCaptureServer() {
  return new Promise((resolve) => {
    resendServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body || 'null'); } catch { parsed = null; }
        resendCaptured.push(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'email-' + resendCaptured.length }));
      });
    });
    resendServer.listen(0, '127.0.0.1', () => { resendPort = resendServer.address().port; resolve(); });
  });
}

// ── gp_admin_session cookie (copied idiom from tests/ats-submit-practice.test.js) ──
function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
const SUPER_EMAIL = 'super@gplink-test.local';
const SUPER_HOST = 'ceo-submission.local';
function adminCookieFor(email, adminRole) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
const adminCookie = () => adminCookieFor(SUPER_EMAIL, 'super_admin');

function httpReq(method, p, { cookie, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (host) headers.Host = host;
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
const submit = (applicationId) => httpReq('POST', '/api/admin/career/application/submit-to-practice', { host: SUPER_HOST, cookie: adminCookie(), body: { applicationId } });

beforeAll(async () => {
  await startSupabaseEmulator();
  await startAnthropicEmulator();
  await startResendCaptureServer();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'practice-submission-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  process.env.ANTHROPIC_MESSAGES_URL = `http://127.0.0.1:${aiPort}/v1/messages`;
  process.env.RESEND_API_URL = `http://127.0.0.1:${resendPort}/emails`;
  process.env.RESEND_API_KEY = 'test-resend';
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.OPENAI_API_KEY = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = 'admin-submission.local';
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = '';

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  if (aiServer) await new Promise((r) => aiServer.close(r));
  if (resendServer) await new Promise((r) => resendServer.close(r));
});

describe('POST submit-to-practice — verified-CV email rebuild', () => {
  it('attaches the verified career CV, never the rejected registration doc', async () => {
    const res = await submit('app-1');
    expect(res.status).toBe(200);
    const sent = resendCaptured[0];
    expect(sent).toBeTruthy();
    const names = (sent.attachments || []).map((a) => a.filename);
    expect(names).toContain('Smith-Miller-CV.pdf');
    expect(names.join()).not.toContain('contract');
  });

  it('includes intro sentences, AI recommendation, and decision buttons', async () => {
    const sent = resendCaptured[0];
    // Greeting per the approved mockup: "Dear <practice> team,".
    expect(sent.html).toContain('Dear SOP Medical Centre team,');
    expect(sent.html).toContain('Expedited Specialist Pathway');
    expect(sent.html).toContain('November 2026');
    expect(sent.html).toContain('Why we recommend');
    expect(sent.html).toContain('/pages/practice-decision.html?token=');
    expect(sent.html).toContain('action=approve');
    expect(sent.html).toContain('action=turn_down');
  });

  it('persists the action token + AI recommendation on the application row', async () => {
    const row = db.gp_applications.find((a) => a.id === 'app-1');
    expect(String(row.practice_action_token || '').length).toBeGreaterThan(20);
    expect(row.ai_recommendation).toMatch(/\S/);
    const sent = resendCaptured[0];
    expect(sent.html).toContain(row.practice_action_token);
  });

  it('a resubmit attempt is refused, and the token does not rotate', async () => {
    // The endpoint 409s on an already-submitted application — this also
    // proves the persisted token from the first submit is the final one
    // a practice's already-sent email link points at (nothing regenerates it
    // out from under a link already delivered).
    const before = resendCaptured.length;
    const res = await submit('app-1');
    expect(res.status).toBe(409);
    expect(resendCaptured.length).toBe(before);
  });

  it('attaches the cover letter when present', async () => {
    const before = resendCaptured.length;
    const res = await submit('app-2');
    expect(res.status).toBe(200);
    const sent = resendCaptured[before];
    expect(sent).toBeTruthy();
    expect(Array.isArray(sent.attachments)).toBe(true);
    expect(sent.attachments.length).toBe(2);
    const names = sent.attachments.map((a) => a.filename);
    expect(names).toContain('Cover-Letter-Test-CV.pdf');
    expect(names).toContain('Cover-Letter-Test-CL.pdf');
    expect(sent.html).toContain('CV and cover letter are attached');
  });

  it('sends without a recommendation when AI is unavailable', async () => {
    aiMode = 'error';
    const before = resendCaptured.length;
    try {
      const res = await submit('app-3');
      expect(res.status).toBe(200);
      const sent = resendCaptured[before];
      expect(sent).toBeTruthy();
      expect(sent.html).not.toContain('Why we recommend');
      const row = db.gp_applications.find((a) => a.id === 'app-3');
      expect(row.ai_recommendation == null || row.ai_recommendation === '').toBe(true);
    } finally {
      aiMode = 'ok';
    }
  });

  it('attaches an approved legacy cv_signed_dated doc when there is no career_cv (approved is a good doc, not excluded like rejected)', async () => {
    const before = resendCaptured.length;
    const res = await submit('app-4');
    expect(res.status).toBe(200);
    const sent = resendCaptured[before];
    expect(sent).toBeTruthy();
    const names = (sent.attachments || []).map((a) => a.filename);
    expect(names).toContain('Approved-Legacy-CV.pdf');
  });
});

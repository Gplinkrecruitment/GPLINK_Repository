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
  gp_applications: [], career_roles: [], scheduled_calls: [], ats_offers: []
};
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
      const genuine = aiMode === 'genuine_cv';
      const payload = {
        content: [{ type: 'text', text: JSON.stringify({ isCv: genuine, reason: genuine ? 'Curriculum vitae with work history' : 'This appears to be an employment contract, not a CV' }) }],
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
function httpReq(method, p, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
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

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'test-secret-' + RUN_ID;
  process.env.ENFORCE_SAME_ORIGIN = 'false';
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

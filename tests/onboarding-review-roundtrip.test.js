// Onboarding-origin flagged-doc review round-trip.
//
// Proves, against the REAL server:
//   1. Approving/rejecting a flagged onboarding qualification (task
//      related_stage 'onboarding') mirrors the decision onto the
//      onboarding_* -keyed user_documents row — not just the canonical-key
//      row — because the onboarding wizard reads its documents back via
//      GET /api/onboarding-documents, which only sees onboarding_* rows.
//   2. The reject bell alert (and email CTA) deep-links back into the
//      onboarding wizard (?reupload=<key> on onboarding.html), not
//      my-documents.html.
//   3. A non-onboarding rejection (regression) still deep-links to
//      my-documents.html as before.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ob-review-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const GP = { userId: 'u-ob-1', email: 'ob-gp@gplink-test.local' };
const SUPER_EMAIL = 'super-ob@gplink-test.local';
const NOW = new Date().toISOString();

const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Mercy', last_name: 'Test', registration_country: 'uk' }
  ],
  registration_cases: [
    { id: 'case-ob-1', user_id: GP.userId, status: 'active', stage: 'onboarding' }
  ],
  registration_tasks: [
    {
      id: 't-ob-flag-1', case_id: 'case-ob-1', task_type: 'flagged_doc', status: 'open',
      related_stage: 'onboarding', related_document_key: 'specialist_qualification',
      title: 'Review flagged qualification: MRCGP Certificate', created_at: NOW
    },
    {
      id: 't-ob-flag-2', case_id: 'case-ob-1', task_type: 'flagged_doc', status: 'open',
      related_stage: 'onboarding', related_document_key: 'primary_medical_degree',
      title: 'Review flagged qualification: Primary Medical Degree', created_at: NOW
    },
    {
      id: 't-ahpra-flag-1', case_id: 'case-ob-1', task_type: 'flagged_doc', status: 'open',
      related_stage: 'ahpra', related_document_key: 'cscst_certified',
      title: 'Review flagged qualification: CSCST Certificate', created_at: NOW
    }
  ],
  user_documents: [
    {
      id: 'd-ob-spec', user_id: GP.userId, document_key: 'onboarding_specialist_qualification',
      country_code: 'uk', status: 'under_review', file_name: 'mrcgp.jpg',
      file_url: 'users/u-ob-1/onboarding/uk/onboarding_specialist_qualification', updated_at: NOW
    },
    {
      id: 'd-ob-degree', user_id: GP.userId, document_key: 'onboarding_primary_med_degree',
      country_code: 'uk', status: 'under_review', file_name: 'degree.jpg',
      file_url: 'users/u-ob-1/onboarding/uk/onboarding_primary_med_degree', updated_at: NOW
    }
  ],
  user_state: [
    { user_id: GP.userId, state: { gp_onboarding: { country: 'GB', currentStep: 1, qualDocs: {} } } }
  ],
  user_roles: [],
  task_timeline: [],
  case_events: [],
  task_messages: [],
  runtime_kv: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'not'];
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
    if (op === 'not') return val === 'is.null' ? !(cell === null || cell === undefined) : true;
    if (op === 'gt') return cell != null && String(cell) > val;
    if (op === 'gte') return cell != null && String(cell) >= val;
    if (op === 'lt') return cell != null && String(cell) < val;
    if (op === 'lte') return cell != null && String(cell) <= val;
    if (op === 'in') {
      return val.replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''))
        .includes(String(cell));
    }
    if (op === 'ilike') {
      const pat = val.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/%/g, '.*');
      return new RegExp('^' + pat + '$', 'i').test(String(cell));
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
      if (u.pathname.startsWith('/storage/v1/')) { send(200, { Key: 'ok' }); return; }
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
      if (req.method === 'POST') {
        const body = await readBody(req);
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
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched);
        return;
      }
      if (req.method === 'DELETE') {
        db[table] = rows.filter((r) => !matches(r));
        send(200, []);
        return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function mkUserCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
function mkAdminCookie(email, adminRole) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}

function httpReq(method, p, { cookie, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = { ...(headers || {}) };
    if (cookie) h.Cookie = cookie;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function postJson(p, body, cookie) { return httpReq('POST', p, { cookie, body }); }
function getJson(p, cookie) { return httpReq('GET', p, { cookie }); }
function putJson(p, body, cookie) { return httpReq('PUT', p, { cookie, body }); }

// Real 1x1 PNG (passes lib/file-sanitise.js validateFileUpload magic-byte checks).
const ONE_PX_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

let realFetch;
const resendCalls = [];

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ob-review-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  process.env.CRON_SECRET = 'test-cron-secret-' + RUN_ID;

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    if (u.includes('api.resend.com')) {
      let parsed = null;
      try { parsed = JSON.parse((opts && opts.body) || 'null'); } catch {}
      resendCalls.push(parsed);
      return Promise.resolve(new Response('{"id":"email-test"}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
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
const gpCookie = () => mkUserCookie(GP.email, GP.userId);

describe('onboarding-origin flagged-doc review mirrors + deep-links', () => {
  it('reject on an onboarding-origin task mirrors rejected+reason onto the onboarding_* row', async () => {
    const r = await postJson('/api/admin/va/task/review-flagged-doc',
      { task_id: 't-ob-flag-1', decision: 'reject', note: 'Blurry scan — please re-upload.' }, adminCookie());
    expect(r.status).toBe(200);
    const obRow = db.user_documents.find((d) => d.document_key === 'onboarding_specialist_qualification');
    expect(obRow.status).toBe('rejected');
    expect(obRow.rejection_reason).toBe('Blurry scan — please re-upload.');
  });

  it('the reject bell/notification target deep-links into onboarding, not my-documents', () => {
    // pushDocumentNotificationToUser persists into user_state.state.gp_link_updates.
    const st = db.user_state.find((s) => s.user_id === GP.userId);
    expect(st).toBeTruthy();
    const alert = (st.state.gp_link_updates || []).find((a) => a.target === '/pages/onboarding.html?reupload=specialist_qualification');
    expect(alert).toBeTruthy();
    expect(alert.target).not.toBe('/pages/my-documents.html?reupload=specialist_qualification');
  });

  it('GET /api/onboarding-documents (as the GP) round-trips the rejection to the wizard', async () => {
    const r = await getJson('/api/onboarding-documents?country=uk', gpCookie());
    expect(r.status).toBe(200);
    expect(r.body.docs.onboarding_specialist_qualification.status).toBe('rejected');
    expect(r.body.docs.onboarding_specialist_qualification.rejection_reason).toBe('Blurry scan — please re-upload.');
  });

  it('approve on an onboarding-origin task mirrors approved onto the onboarding_* row', async () => {
    const r = await postJson('/api/admin/va/task/review-flagged-doc',
      { task_id: 't-ob-flag-2', decision: 'approve' }, adminCookie());
    expect(r.status).toBe(200);
    const obDegreeRow = db.user_documents.find((d) => d.document_key === 'onboarding_primary_med_degree');
    expect(obDegreeRow.status).toBe('approved');
    expect(obDegreeRow.rejection_reason).toBe('');
  });

  it('a NON-onboarding rejection still deep-links to my-documents (regression)', async () => {
    const r = await postJson('/api/admin/va/task/review-flagged-doc',
      { task_id: 't-ahpra-flag-1', decision: 'reject', note: 'Needs a certified copy.' }, adminCookie());
    expect(r.status).toBe(200);
    const st = db.user_state.find((s) => s.user_id === GP.userId);
    const alert = (st.state.gp_link_updates || []).find((a) => a.target === '/pages/my-documents.html?reupload=cscst_certified');
    expect(alert).toBeTruthy();
    const onboardingLeak = (st.state.gp_link_updates || []).find((a) => a.target === '/pages/onboarding.html?reupload=cscst_certified');
    expect(onboardingLeak).toBeFalsy();
  });

  it('an AHPRA-stage rejection sharing a canonical document_key must NOT mirror onto the onboarding row (critical)', async () => {
    // Seed: the onboarding wizard's primary-degree row is already approved
    // (this mirrors real life after the earlier onboarding review passed).
    const obDegreeRow = db.user_documents.find((d) => d.document_key === 'onboarding_primary_med_degree');
    obDegreeRow.status = 'approved';
    obDegreeRow.rejection_reason = '';

    // Seed an OPEN AHPRA-stage certified-copy review task that happens to
    // share the same canonical related_document_key as the onboarding
    // qualification upload (primary_medical_degree).
    db.registration_tasks.push({
      id: 't-ahpra-flag-2', case_id: 'case-ob-1', task_type: 'doc_review', status: 'open',
      related_stage: 'ahpra', related_document_key: 'primary_medical_degree',
      title: 'Review certified copy: Primary Medical Degree', created_at: NOW
    });

    const r = await postJson('/api/admin/va/task/review-flagged-doc',
      { task_id: 't-ahpra-flag-2', decision: 'reject', note: 'Certified copy illegible.' }, adminCookie());
    expect(r.status).toBe(200);

    // The onboarding wizard's row must be untouched by an AHPRA-stage
    // decision — the mirror is gated to onboarding-origin tasks only.
    expect(obDegreeRow.status).toBe('approved');
    expect(obDegreeRow.rejection_reason).toBe('');

    // The canonical (AHPRA-facing) row IS rejected as normal.
    const canonRow = db.user_documents.find((d) => d.document_key === 'primary_medical_degree');
    expect(canonRow).toBeTruthy();
    expect(canonRow.status).toBe('rejected');
    expect(canonRow.rejection_reason).toBe('Certified copy illegible.');
  });

  it('re-uploading a rejected onboarding doc synchronously creates a fresh RSO review task', async () => {
    const r = await putJson('/api/onboarding-documents', {
      country: 'GB', key: 'onboarding_specialist_qualification',
      fileName: 'mrcgp-fixed.png', mimeType: 'image/png', fileSize: 0, fileDataUrl: ONE_PX_PNG
    }, gpCookie());
    expect(r.status).toBe(200);
    const open = db.registration_tasks.filter(t =>
      t.case_id === 'case-ob-1' &&
      (t.task_type === 'doc_review' || t.task_type === 'flagged_doc') &&
      t.related_document_key === 'specialist_qualification' &&
      ['open', 'in_progress', 'waiting'].includes(t.status));
    expect(open.length).toBeGreaterThan(0);
    expect(open[0].related_stage).toBe('onboarding');
    const row = db.user_documents.find(d => d.document_key === 'onboarding_specialist_qualification');
    expect(row.status).not.toBe('rejected');
  });
});

describe('ops resend-doc-rejection-email', () => {
  // The test server (see beforeAll above) is booted with
  // SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key' — that's the value
  // the endpoint compares x-gp-ops-key against.
  const SERVICE_KEY = 'test-service-role-key';
  const OPS_PATH = '/api/admin/ops/resend-doc-rejection-email';

  it('rejects a call with no valid ops key and no admin session (not 200)', async () => {
    const r = await httpReq('POST', OPS_PATH, {
      body: { user_id: GP.userId, document_key: 'specialist_qualification' },
      headers: { 'x-gp-ops-key': 'wrong-key' }
    });
    expect(r.status).not.toBe(200);
  });

  it('404s when the given user/document_key has no rejected row', async () => {
    const r = await httpReq('POST', OPS_PATH, {
      body: { user_id: GP.userId, document_key: 'no_such_document_key' },
      headers: { 'x-gp-ops-key': SERVICE_KEY }
    });
    expect(r.status).toBe(404);
  });

  it('re-sends the rejection email for a rejected onboarding qualification with the corrected deep link', async () => {
    // Deterministic re-seed: earlier tests in this file re-upload this row
    // (clearing 'rejected'), so force it back to a known rejected state here
    // rather than depending on state left over by prior tests.
    const obRow = db.user_documents.find((d) => d.document_key === 'onboarding_specialist_qualification');
    obRow.status = 'rejected';
    obRow.rejection_reason = 'Blurry scan — please re-upload.';

    const resendCallsBefore = resendCalls.length;
    const r = await httpReq('POST', OPS_PATH, {
      body: { user_id: GP.userId, document_key: 'specialist_qualification' },
      headers: { 'x-gp-ops-key': SERVICE_KEY }
    });

    expect(r.body.target).toBe('/pages/onboarding.html?reupload=specialist_qualification');
    expect(r.body.onboarding).toBe(true);
    // NOTE on this assertion (deviation from the original spec): the task spec
    // assumed RESEND_API_KEY is unset in this test file, expecting a 502 with
    // result.error === 'Email not configured'. In fact this file's beforeAll
    // (line ~236) sets process.env.RESEND_API_KEY = 'test-resend-key' and
    // stubs global fetch to intercept api.resend.com calls with a 200 —
    // exactly the same mocked path the FIRST describe block's reject/approve
    // tests already exercise (see their "[sendEmail] Resend accepted" log
    // lines). So sendEmail() here genuinely succeeds against the emulator,
    // and the honest, non-fabricated outcome is 200/ok:true — verified below
    // by asserting the mocked Resend call was actually made with the right
    // recipient, rather than asserting a failure mode that doesn't occur in
    // this harness.
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.result).toEqual({ ok: true });
    expect(resendCalls.length).toBe(resendCallsBefore + 1);
    const sent = resendCalls[resendCalls.length - 1];
    expect(sent.to).toEqual([GP.email]);
    expect(sent.subject).toContain('re-upload');
  });
});

describe('onboarding wizard client wiring (source-level)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'onboarding.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'onboarding.html'), 'utf8');
  it('reads the wizard blob and doc statuses back from the server', () => {
    expect(src).toContain('gp_onboarding');
    expect(src).toMatch(/fetch\("\/api\/onboarding-documents\?country="/);
    expect(src).toContain('applyServerDocStatuses');
  });
  it('renders the three RSO statuses', () => {
    expect(src).toContain('"approved"');
    expect(src).toContain('"rejected"');
    expect(src).toContain('"under_review"');
    expect(src).toContain('rejectionReason');
  });
  it('a genuine ?reset=1 is not silently undone by the cross-device restore', () => {
    expect(src).toContain('stateWasReset');
  });
  it('handles the ?reupload deep link for canonical keys', () => {
    expect(src).toContain('resolveReuploadParamKey');
    expect(src).toContain('specialist_qualification');
  });
  it('preserves the destination through the signin bounce', () => {
    expect(src).toMatch(/\/pages\/signin"?\s*\+\s*\(/);
    expect(src).toContain('encodeURIComponent(dest)');
  });
  it('cache buster bumped', () => {
    expect(html).toMatch(/onboarding\.js\?v=20260719a/);
  });
  it('rejected docs do not count as complete', () => {
    const fn = src.slice(src.indexOf('function allDocsComplete'), src.indexOf('}', src.indexOf('function allDocsComplete')) + 1);
    expect(fn).toContain('approved');
    expect(fn).not.toContain('"rejected"');
  });
});

describe('my-documents legacy onboarding reupload redirect (source-level)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'my-documents.html'), 'utf8');
  it('forwards onboarding qualification keys to the onboarding wizard', () => {
    expect(html).toContain('LEGACY_ONBOARDING_REUPLOAD');
    expect(html).toContain('/pages/onboarding?reupload=');
    expect(html).toContain('onboarding_specialist_qualification');
  });
  it('does not forward primary_medical_degree (real card on this page)', () => {
    const block = html.slice(html.indexOf('LEGACY_ONBOARDING_REUPLOAD'), html.indexOf('LEGACY_ONBOARDING_REUPLOAD') + 600);
    expect(block).not.toMatch(/^\s*primary_medical_degree\s*:/m);
  });
});

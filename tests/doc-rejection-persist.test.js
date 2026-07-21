// Phase 6 F3, persistent AI-rejection reason + server-authoritative 3-fail
// escalation + rejection alerts.
//
// Proves, against the REAL server (Anthropic mocked to always fail the scan):
//   1. Each failed AI certification scan increments a SERVER-side counter in
//      user_doc_scan_failures (not localStorage) and persists the last failure
//      reason, retrievable via GET /api/prepared-documents (scanFailures map).
//   2. The 3rd failure escalates FROM THE SERVER: the scanned file is saved as
//      under_review, a Registration Support Officer doc_review task is created,
//      and the response says manualReview:true.
//   3. A successful upload resets the failure streak.
//   4. An admin rejection pushes a user-facing bell alert with the
//      ?reupload=<key> deep link (not just the passive outstanding list).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-doc-reject-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const GP = { userId: 'u-rej-1', email: 'reject-gp@gplink-test.local' };
// NZ GP: profile carries a loose-cased country; scans that omit `country` must
// escalate under 'nz', never the hardcoded 'uk' fallback.
const NZGP = { userId: 'u-rej-nz', email: 'reject-nz@gplink-test.local' };
// IE GP: NO registration_country on the profile, country only resolvable via
// user_state.gp_selected_country (second link of the profile-country chain).
const IEGP = { userId: 'u-rej-ie2', email: 'reject-ie2@gplink-test.local' };
const SUPER_EMAIL = 'super@gplink-test.local';
const NOW = new Date().toISOString();

const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Re', last_name: 'Ject', registration_country: 'ie' },
    { user_id: NZGP.userId, email: NZGP.email, first_name: 'Kiwi', last_name: 'Doc', registration_country: 'New Zealand' },
    { user_id: IEGP.userId, email: IEGP.email, first_name: 'Ir', last_name: 'Ish' }
  ],
  registration_cases: [
    { id: 'case-rej-1', user_id: GP.userId, status: 'active', stage: 'ahpra' }
  ],
  registration_tasks: [
    // Existing doc_review task for the admin-reject test.
    { id: 't-docrev-1', case_id: 'case-rej-1', task_type: 'doc_review', status: 'open', related_document_key: 'cscst_certified', title: 'Review CSCST certificate', created_at: NOW }
  ],
  user_documents: [
    // The doc the admin will reject.
    { id: 'd-rej-1', user_id: GP.userId, document_key: 'cscst_certified', country_code: 'ie', status: 'under_review', file_name: 'cscst.pdf', file_url: 'users/u-rej-1/cscst', updated_at: NOW },
    // Expires in 5 days, never nudged -> the weekly sweep must email a renewal
    // reminder even though GP.email is on the suppression list (transactional).
    { id: 'd-rej-exp', user_id: GP.userId, document_key: 'certificate_good_standing', country_code: 'ie', status: 'approved', file_name: 'cogs.pdf', file_url: 'users/u-rej-1/cogs', expires_at: new Date(Date.now() + 5 * 86400000).toISOString(), expiry_nudged_at: null, updated_at: NOW }
  ],
  // GP.email unsubscribed from marketing mail, registration-critical
  // transactional sends must ignore this list.
  email_suppression: [
    { email: GP.email, reason: 'unsubscribe', source: 'test', created_at: NOW }
  ],
  user_doc_scan_failures: [],
  user_nudges: [],
  user_state: [
    // IE GP's country lives ONLY here (profile has no registration_country).
    { user_id: IEGP.userId, state: { gp_selected_country: 'Ireland' } }
  ],
  user_roles: [],
  task_timeline: [],
  case_events: [],
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
function userCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}
function adminCookie(email, adminRole) {
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

let realFetch;
// Every Resend /emails payload the server tries to send (parsed JSON bodies).
const resendCalls = [];

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'doc-reject-test-secret-' + RUN_ID;
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
    if (u.includes('api.anthropic.com')) {
      // Always-failing certification verdict.
      const verdict = {
        certified: false,
        statementPresent: false,
        signaturePresent: false,
        certifierName: null,
        certifierOccupation: null,
        certifierDate: null,
        contactPresent: false,
        stampPresent: false,
        issues: ['No certification statement was found on the copy.']
      };
      return Promise.resolve(new Response(JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify(verdict) }],
        usage: { input_tokens: 10, output_tokens: 10 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
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

const PDF_RAW_B64 = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n').toString('base64');

function scanOnce() {
  return httpReq('POST', '/api/ai/verify-certification', {
    cookie: userCookie(GP.email, GP.userId),
    body: {
      imageBase64: PDF_RAW_B64,
      mimeType: 'application/pdf',
      documentType: 'MICGP Certificate',
      docKey: 'micgp_certified',
      country: 'ie',
      fileName: 'micgp.pdf'
    }
  });
}

describe('server-authoritative scan-failure counting', () => {
  it('is auth-gated', async () => {
    const r = await httpReq('POST', '/api/ai/verify-certification', { body: { imageBase64: PDF_RAW_B64 } });
    expect([401, 403]).toContain(r.status);
  });

  it('failure #1 increments the SERVER counter and persists the reason', async () => {
    const r = await scanOnce();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.verification.certified).toBe(false);
    expect(r.body.scanFailCount).toBe(1);
    expect(r.body.manualReview).toBeFalsy();

    const row = db.user_doc_scan_failures.find((f) => f.user_id === GP.userId && f.document_key === 'micgp_certified');
    expect(row).toBeTruthy();
    expect(row.fail_count).toBe(1);
    expect(row.last_reason).toContain('certification statement');
    expect(row.country_code).toBe('ie');
  });

  it('failure #2 keeps counting (no localStorage involved)', async () => {
    const r = await scanOnce();
    expect(r.body.scanFailCount).toBe(2);
    const row = db.user_doc_scan_failures.find((f) => f.document_key === 'micgp_certified');
    expect(row.fail_count).toBe(2);
  });

  it('failure #3 escalates FROM THE SERVER: file saved under_review + doc_review task + manualReview response', async () => {
    const r = await scanOnce();
    expect(r.body.scanFailCount).toBe(3);
    expect(r.body.manualReview).toBe(true);
    expect(r.body.document).toBeTruthy();

    // The scanned file was persisted server-side and parked for a human.
    const doc = db.user_documents.find((d) => d.user_id === GP.userId && d.document_key === 'micgp_certified');
    expect(doc).toBeTruthy();
    expect(doc.status).toBe('under_review');

    // Registration Support Officer review task exists for the GP's case.
    const task = db.registration_tasks.find((t) => t.case_id === 'case-rej-1' && t.task_type === 'doc_review' && String(t.related_document_key || '').includes('micgp'));
    expect(task).toBeTruthy();

    // Escalated exactly once for this streak.
    const row = db.user_doc_scan_failures.find((f) => f.document_key === 'micgp_certified');
    expect(row.escalated_at).toBeTruthy();

    // The GP got an in-app alert about the manual review.
    const st = db.user_state.find((s) => s.user_id === GP.userId);
    expect(st).toBeTruthy();
    const reviewAlert = (st.state.gp_link_updates || []).find((a) => /under review/i.test(a.title));
    expect(reviewAlert).toBeTruthy();
  });

  it('GET /api/prepared-documents returns the persisted failure reason for the card', async () => {
    const r = await httpReq('GET', '/api/prepared-documents?country=ie', { cookie: userCookie(GP.email, GP.userId) });
    expect(r.status).toBe(200);
    const sf = r.body.scanFailures && r.body.scanFailures.micgp_certified;
    expect(sf).toBeTruthy();
    expect(sf.failCount).toBe(3);
    expect(sf.reason).toContain('certification statement');
    expect(sf.threshold).toBe(3);
  });

  it('a successful upload resets the failure streak', async () => {
    const put = await httpReq('PUT', '/api/prepared-documents', {
      cookie: userCookie(GP.email, GP.userId),
      body: {
        country: 'ie', key: 'micgp_certified',
        fileName: 'micgp-fixed.pdf', mimeType: 'application/pdf', fileSize: 64,
        fileDataUrl: 'data:application/pdf;base64,' + PDF_RAW_B64
      }
    });
    expect(put.status).toBe(200);
    const row = db.user_doc_scan_failures.find((f) => f.document_key === 'micgp_certified');
    expect(row.fail_count).toBe(0);
    expect(row.last_reason).toBe('');
    expect(row.escalated_at).toBe(null);
  });
});

describe('rejection produces a user-facing alert with a re-upload deep link', () => {
  it('admin doc-review reject: doc rejected + bell alert deep-links to ?reupload=<key>', async () => {
    const r = await httpReq('POST', '/api/admin/va/doc-review/reject', {
      cookie: adminCookie(SUPER_EMAIL, 'super_admin'),
      body: { task_id: 't-docrev-1', reason: 'The copy is too blurry to read.' }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const doc = db.user_documents.find((d) => d.id === 'd-rej-1');
    expect(doc.status).toBe('rejected');
    expect(doc.rejection_reason).toContain('blurry');

    const st = db.user_state.find((s) => s.user_id === GP.userId);
    expect(st).toBeTruthy();
    const alert = (st.state.gp_link_updates || []).find((a) => a.target === '/pages/my-documents.html?reupload=cscst_certified');
    expect(alert).toBeTruthy();
    expect(alert.type).toBe('action');
    expect(alert.detail).toContain('blurry');
  });
});

// F3 fix: when the scan call omits `country`, escalation must file the
// under-review doc under the GP's OWN profile country, never the hardcoded
// 'uk' fallback, which would split an IE/NZ GP's document rows across two
// country buckets.
describe('escalation country falls back to the GP\'s profile country, not "uk"', () => {
  function scanWithoutCountry(user) {
    return httpReq('POST', '/api/ai/verify-certification', {
      cookie: userCookie(user.email, user.userId),
      body: {
        imageBase64: PDF_RAW_B64,
        mimeType: 'application/pdf',
        documentType: 'Police check',
        docKey: 'criminal_history',
        fileName: 'police-check.pdf'
        // NO country field, the escalation must resolve it from the profile.
      }
    });
  }

  it('NZ GP (profile registration_country "New Zealand"): 3rd no-country failure files under nz', async () => {
    let r;
    for (let i = 0; i < 3; i++) r = await scanWithoutCountry(NZGP);
    expect(r.status).toBe(200);
    expect(r.body.scanFailCount).toBe(3);
    expect(r.body.manualReview).toBe(true);

    const doc = db.user_documents.find((d) => d.user_id === NZGP.userId && d.document_key === 'criminal_history');
    expect(doc).toBeTruthy();
    expect(doc.country_code).toBe('nz');
    expect(doc.status).toBe('under_review');
    // Nothing mis-filed under the old hardcoded fallback.
    expect(db.user_documents.some((d) => d.user_id === NZGP.userId && d.country_code === 'uk')).toBe(false);
  });

  it('IE GP whose country lives only in user_state.gp_selected_country files under ie', async () => {
    let r;
    for (let i = 0; i < 3; i++) r = await scanWithoutCountry(IEGP);
    expect(r.body.manualReview).toBe(true);

    const doc = db.user_documents.find((d) => d.user_id === IEGP.userId && d.document_key === 'criminal_history');
    expect(doc).toBeTruthy();
    expect(doc.country_code).toBe('ie');
    expect(doc.status).toBe('under_review');
    expect(db.user_documents.some((d) => d.user_id === IEGP.userId && d.country_code === 'uk')).toBe(false);
  });
});

// F3 fix: the document-expiry renewal reminder is registration-critical, so it
// is TRANSACTIONAL, it must reach the GP even when their address sits on the
// email_suppression list (marketing unsubscribe/bounce).
describe('document-expiry renewal email is transactional (never suppressed)', () => {
  it('a GP on the suppression list still receives the expiry reminder email', async () => {
    // Fixture sanity: GP.email IS suppressed.
    expect(db.email_suppression.some((s) => s.email === GP.email)).toBe(true);

    resendCalls.length = 0;
    const r = await httpReq('GET', '/api/cron/weekly-sweep', {
      headers: { Authorization: 'Bearer ' + process.env.CRON_SECRET }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    // Only d-rej-exp (expires in 5 days, never nudged) is in the 30-day window;
    // the escalation-saved police checks default to a 12-month validity.
    expect(r.body.expiryNudged).toBe(1);

    // The renewal email went out to the SUPPRESSED address anyway.
    const mail = resendCalls.find((c) => c && Array.isArray(c.to) && c.to.includes(GP.email));
    expect(mail).toBeTruthy();
    expect(String(mail.subject).toLowerCase()).toContain('expires soon');
  });
});

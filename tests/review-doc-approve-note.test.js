/**
 * "Note to GP" on a flagged-document review.
 *
 * The reviewer's note box used to open PRE-FILLED with the internal flag reason —
 *
 *   "AI flagged this document for manual review. Reason: The name on this document
 *    looks like a previous name. … ; Names on your specialist qualification and
 *    medical degree do not match each other."
 *
 * — text written for us, not for the doctor. Two bad outcomes followed, both seen on
 * Dr Ibrahim Fashola's file:
 *
 *   • APPROVE appended it to the verified email as "Note from our team:", so a doctor
 *     whose certificate had just been ACCEPTED was told a machine had flagged it and
 *     that his names did not match — with nothing to do about it.
 *   • REJECT emailed that same admin-facing string as the entire body, telling the
 *     doctor what a scanner concluded rather than what they must do next.
 *
 * Now: approve carries no note anywhere (email, stored rejection_reason, timeline,
 * task_messages), and the box starts empty so whatever is sent is written to the
 * doctor — either the AI-built GP-ready message (greeting, finding, what to do) or
 * the reviewer's own words, which reject requires.
 *
 * Driven against the REAL server with a Supabase emulator and Resend intercepted, so
 * the assertions are about the email that would actually be sent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { urlHasHost } from './url-match.helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-review-note-${RUN_ID}.json`);
let server, port, sbServer, sbPort, realFetch;

const GP = { userId: 'u-note-1', email: 'note-gp@gplink-test.local' };
const SUPER_EMAIL = 'super-note@gplink-test.local';
const NOW = new Date().toISOString();

/* The real string off Fashola's task — what the box used to hand the reviewer. */
const ADMIN_REASON =
  'AI flagged this document for manual review. Reason: The name on this document looks ' +
  'like a previous name.; Names on your specialist qualification and medical degree do not match each other.';

const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Ademola', last_name: 'Fashola', registration_country: 'uk' }
  ],
  registration_cases: [{ id: 'case-note-1', user_id: GP.userId, status: 'active', stage: 'onboarding' }],
  registration_tasks: [
    {
      id: 't-note-approve', case_id: 'case-note-1', task_type: 'flagged_doc', status: 'open',
      related_stage: 'onboarding', related_document_key: 'primary_medical_degree',
      title: 'Review flagged qualification: Primary Medical Degree',
      description: ADMIN_REASON, created_at: NOW, metadata: {}
    },
    {
      id: 't-note-reject', case_id: 'case-note-1', task_type: 'flagged_doc', status: 'open',
      related_stage: 'onboarding', related_document_key: 'cct_certificate',
      title: 'Review flagged qualification: CCT Certificate',
      description: ADMIN_REASON, created_at: NOW, metadata: {}
    }
  ],
  user_documents: [
    {
      id: 'd-note-degree', user_id: GP.userId, document_key: 'onboarding_primary_med_degree',
      country_code: 'uk', status: 'under_review', file_name: 'degree.jpg',
      file_url: 'users/u-note-1/onboarding/uk/onboarding_primary_med_degree', updated_at: NOW
    },
    {
      id: 'd-note-cct', user_id: GP.userId, document_key: 'onboarding_cct_certificate',
      country_code: 'uk', status: 'under_review', file_name: 'cct.jpg',
      file_url: 'users/u-note-1/onboarding/uk/onboarding_cct_certificate', updated_at: NOW
    }
  ],
  user_state: [{ user_id: GP.userId, state: { account_status: 'under_review' } }],
  user_roles: [], task_timeline: [], case_events: [], task_messages: [], runtime_kv: []
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
    filters.push({ col: key, op, val: raw.slice(dot + 1) });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
    if (op === 'neq') return String(cell) !== val;
    if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    if (op === 'not') return val === 'is.null' ? !(cell === null || cell === undefined) : true;
    if (op === 'in') {
      return val.replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, '')).includes(String(cell));
    }
    return true;
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { resolve(null); }
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
      const rows = tableOf(decodeURIComponent(m[1]));
      const matches = buildMatcher(u.searchParams);

      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out); return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const conflict = (u.searchParams.get('on_conflict') || '').split(',').map((s) => s.trim()).filter(Boolean);
        send(201, incoming.map((r) => {
          if (conflict.length) {
            const existing = rows.find((row) => conflict.every((c) => String(row[c]) === String(r[c])));
            if (existing) { Object.assign(existing, r); return existing; }
          }
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          rows.push(row);
          return row;
        }));
        return;
      }
      if (req.method === 'PATCH') {
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched); return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function b64url(s) {
  return Buffer.from(String(s), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function mkAdminCookie(email, adminRole) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}

function httpReq(method, p, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = {};
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

const resendCalls = [];
const REVIEW_PATH = '/api/admin/va/task/review-flagged-doc';

beforeAll(async () => {
  await startSupabaseEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'review-note-secret-' + RUN_ID;
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
    if (urlHasHost(u, 'api.resend.com')) {
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

describe('approving a flagged document sends the GP no note', () => {
  let approveEmail;

  it('accepts the approval even though a note was submitted with it', async () => {
    const before = resendCalls.length;
    // Worst case, and the real one: the reviewer never cleared the box, so the
    // internal flag reason rides along with the approval.
    const r = await httpReq('POST', REVIEW_PATH, {
      cookie: adminCookie(),
      body: { task_id: 't-note-approve', decision: 'approve', note: ADMIN_REASON }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(resendCalls.length).toBeGreaterThan(before);
    approveEmail = resendCalls[resendCalls.length - 1];
  });

  it('emails a clean "verified" message with no note appended', () => {
    const wire = JSON.stringify(approveEmail);
    expect(wire).not.toContain('Note from our team');
    expect(wire).not.toContain('AI flagged this document');
    expect(wire).not.toContain('do not match each other');
    expect(wire).not.toContain('previous name');
    // …and still says the useful part.
    expect(wire).toContain('verified');
  });

  it('stores no rejection_reason on the approved document', () => {
    const row = db.user_documents.find((d) => d.document_key === 'primary_medical_degree')
      || db.user_documents.find((d) => d.document_key === 'onboarding_primary_med_degree');
    expect(row).toBeTruthy();
    expect(row.status).toBe('approved');
    expect(row.rejection_reason || '').toBe('');
  });

  it('records the approval without the note in task_messages and the timeline', () => {
    const msg = db.task_messages.find((m) => m.task_id === 't-note-approve');
    expect(msg).toBeTruthy();
    expect(msg.body_text).toBe('Approved.');
    expect(msg.body_text).not.toContain('AI flagged');
    const events = JSON.stringify(db.case_events.filter((e) => e.task_id === 't-note-approve'));
    expect(events).not.toContain('AI flagged this document');
  });
});

describe('rejecting still emails the reviewer\'s message verbatim', () => {
  it('sends exactly what was typed, so a GP-written message reaches the doctor', async () => {
    const gpMessage = [
      'Hi Dr Fashola,', '',
      'Thank you for uploading your CCT certificate. The photo cuts off the bottom edge, so we cannot read the issue date.', '',
      'Please re-upload a photo showing the whole certificate, including the date and the GMC stamp.'
    ].join('\n');
    const before = resendCalls.length;
    const r = await httpReq('POST', REVIEW_PATH, {
      cookie: adminCookie(),
      body: { task_id: 't-note-reject', decision: 'reject', note: gpMessage }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(resendCalls.length).toBeGreaterThan(before);
    const wire = JSON.stringify(resendCalls[resendCalls.length - 1]);
    expect(wire).toContain('Please re-upload a photo showing the whole certificate');
    expect(wire).toContain('re-upload');
  });

  it('still refuses a rejection with no message at all', async () => {
    const r = await httpReq('POST', REVIEW_PATH, {
      cookie: adminCookie(),
      body: { task_id: 't-note-reject', decision: 'reject', note: '   ' }
    });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/reason is required/i);
  });
});

describe('the note box is never pre-filled with the internal flag reason', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'pages', 'admin.html'), 'utf8');
  const ceo = fs.readFileSync(path.join(__dirname, '..', 'pages', 'ceo-dashboard.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  it('admin.html opens the box empty rather than seeding it with the task reason', () => {
    expect(admin).toMatch(/var _prefillNote='';/);
    expect(admin).not.toMatch(/_prefillNote=_reasonIsTechnical\?'':_reviewReasonText/);
  });

  it('ceo-dashboard.html renders an empty textarea, not the reason', () => {
    expect(ceo).not.toMatch(/id="ceoReviewDocNote"[^>]*>'\s*\+\s*esc\(ceoReason\)/);
    expect(ceo).toMatch(/_ceoReviewSuggested = '';/);
  });

  it('neither console transmits a note when approving', () => {
    expect(admin).toContain("note:decision==='approve'?'':note");
    expect(ceo).toContain("note: decision === 'approve' ? '' : note");
  });

  it('the server drops the note on approve regardless of what any client sends', () => {
    expect(server).toMatch(/const rfNote = rfDecision === 'approve' \? '' : rfNoteRaw;/);
    // The verified email must not carry a conditional note append any more. Matched on the
    // concatenation itself, not the bare phrase — the comment above rfNote quotes it on
    // purpose to explain what was removed.
    expect(server).not.toMatch(/rfNote \? '\\n\\nNote from our team/);
  });
});

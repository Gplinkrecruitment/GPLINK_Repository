// Owner report 2026-09-04: the Candidates list flagged Dr Hatice Akkas with
// "Docs · 4 to review", but opening her profile showed nowhere to review them.
// The chip counts open doc_review / flagged_doc registration_tasks; the profile
// API never returned those rows, so the page had nothing to render.
//
// Boots the real server against the in-memory PostgREST emulator pattern from
// tests/ats-docs-placement.test.js and checks:
//  API    GET /api/ceo/candidate carries doc_reviews — the SAME open rows the
//         list chip counts (completed / other-type / other-case rows excluded),
//         oldest first, labelled, with the review reason; consultants included;
//         and the list's doc_reviews_pending agrees with the profile.
//  UI     the candidate profile renders a "Documents to review" card with one
//         Review button per task (the real render function is EXECUTED, not
//         grepped), read-only for consultants, absent when nothing is pending.
//  Modal  ceoReviewFlaggedDoc accepts the task + onDone the profile hands in,
//         and the decision path calls it + refreshes the dashboard counts.
//  Pins   the candidates script is cache-busted so the deployed page loads it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join(os.tmpdir(), `gplink-cand-doc-reviews-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const SUPER_HOST = 'ceo-docreview.local';
const SUPER_EMAIL = 'super@gplink-test.local';
const CONSULTANT_EMAIL = 'consultant@gplink-test.local';
const GP = { userId: 'u-gp-hatice', email: 'hatice@gplink-test.local' };
const GP2 = { userId: 'u-gp-other', email: 'other@gplink-test.local' };
const NOW = new Date().toISOString();

const progressState = { gp_onboarding_complete: true, gp_epic_progress: { completed: {} }, gp_amc_progress: { completed: {} }, gp_ahpra_progress: {}, gp_documents_prep: {} };

// Mirrors the real shape of Dr Akkas's tasks (checked in prod 2026-09-04):
// doc_review rows under the AHPRA stage carrying the AI note in
// ai_match_reasoning, plus one older flagged_doc from onboarding whose reason
// lives in description.
const CV_REASON = 'This appears to be CV / curriculum vitae, not CV (Signed and dated). It is missing the required declaration statement.';
const FLAG_REASON = 'AI flagged this document for manual review. Reason: the name on the degree does not match the account name.';
const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Hatice', last_name: 'Akkas', registration_country: 'uk' },
    { user_id: GP2.userId, email: GP2.email, first_name: 'Other', last_name: 'Doctor', registration_country: 'uk' }
  ],
  user_state: [
    { user_id: GP.userId, state: Object.assign({}, progressState), updated_at: NOW },
    { user_id: GP2.userId, state: Object.assign({}, progressState), updated_at: NOW }
  ],
  registration_cases: [
    { id: 'case-hatice', user_id: GP.userId, status: 'active', stage: 'ahpra', assigned_rso: null, assigned_va: null, created_at: NOW, updated_at: NOW },
    { id: 'case-other', user_id: GP2.userId, status: 'active', stage: 'myintealth', assigned_rso: null, assigned_va: null, created_at: NOW, updated_at: NOW }
  ],
  registration_tasks: [
    // ── counted: open doc_review / flagged_doc on HER case ──
    { id: 't-flag', case_id: 'case-hatice', task_type: 'flagged_doc', status: 'open', title: 'Review flagged Primary Medical Degree for Dr Hatice Akkas', related_document_key: 'primary_medical_degree', related_stage: 'onboarding', priority: 'high', description: FLAG_REASON, ai_match_reasoning: null, created_at: '2026-08-22T12:49:26.000Z' },
    { id: 't-cv', case_id: 'case-hatice', task_type: 'doc_review', status: 'open', title: 'Review uploaded CV (Signed and dated) for Dr Hatice Akkas', related_document_key: 'cv_signed_dated', related_stage: 'ahpra', priority: 'normal', description: null, ai_match_reasoning: CV_REASON, created_at: '2026-09-02T15:48:15.000Z' },
    { id: 't-cct', case_id: 'case-hatice', task_type: 'doc_review', status: 'in_progress', title: 'Review uploaded Certificate of Completion of Training for Dr Hatice Akkas', related_document_key: 'cct_certified', related_stage: 'ahpra', priority: 'normal', description: null, ai_match_reasoning: 'No certification statement is present.', created_at: '2026-09-03T04:45:33.000Z' },
    { id: 't-pmd', case_id: 'case-hatice', task_type: 'doc_review', status: 'waiting', title: 'Review uploaded Primary Medical Degree for Dr Hatice Akkas', related_document_key: 'primary_medical_degree', related_stage: 'ahpra', priority: 'normal', description: null, ai_match_reasoning: 'This appears to be the original diploma, not a certified copy.', created_at: '2026-09-03T04:48:47.000Z' },
    { id: 't-mrcgp', case_id: 'case-hatice', task_type: 'doc_review', status: 'open', title: 'Review uploaded MRCGP Certificate for Dr Hatice Akkas', related_document_key: 'mrcgp_certified', related_stage: 'ahpra', priority: 'normal', description: null, ai_match_reasoning: 'Part of the document is outside this photo.', created_at: '2026-09-03T04:49:18.000Z' },
    // ── NOT counted ──
    { id: 't-done', case_id: 'case-hatice', task_type: 'doc_review', status: 'completed', title: 'Review uploaded Specialist Qualification for Dr Hatice Akkas', related_document_key: 'specialist_qualification', related_stage: 'onboarding', priority: 'normal', created_at: '2026-08-22T12:47:52.000Z' },
    { id: 't-email', case_id: 'case-hatice', task_type: 'email_practice', status: 'open', title: 'Email the practice', related_document_key: null, related_stage: 'ahpra', priority: 'normal', created_at: '2026-09-01T00:00:00.000Z' },
    { id: 't-other', case_id: 'case-other', task_type: 'flagged_doc', status: 'open', title: 'Review flagged degree for Dr Other Doctor', related_document_key: 'primary_medical_degree', related_stage: 'onboarding', priority: 'normal', description: 'other case', created_at: '2026-09-01T00:00:00.000Z' }
  ],
  rso_team: [], user_roles: [], practices: [], career_roles: [], gp_applications: [], user_documents: [],
  ats_offers: [], scheduled_calls: [], ats_stage_events: [], task_timeline: [], placements: [], runtime_kv: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'];
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
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { resolve(null); } });
  });
}
function startSupabaseEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (u.pathname.startsWith('/storage/v1/object/sign/')) { send(200, { signedURL: u.pathname.replace('/storage/v1', '') + '?token=test-token' }); return; }
      if (u.pathname.startsWith('/storage/v1/object/')) { await readBody(req); send(200, { Key: u.pathname.replace('/storage/v1/object/', '') }); return; }
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const rows = tableOf(decodeURIComponent(m[1]));
      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        // Deliberately ignores order= (like a chunked read) — the server must sort.
        let out = rows.filter(matches).slice().reverse();
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out); return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const saved = incoming.map((r) => { const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r }; rows.push(row); return row; });
        send(201, saved); return;
      }
      if (req.method === 'PATCH') { const patch = await readBody(req); const matched = rows.filter(matches); matched.forEach((row) => Object.assign(row, patch || {})); send(200, matched); return; }
      if (req.method === 'DELETE') { const keep = rows.filter((row) => !matches(row)); rows.length = 0; keep.forEach((row) => rows.push(row)); send(200, []); return; }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function adminCookieFor(email, adminRole) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
const superCookie = () => adminCookieFor(SUPER_EMAIL, 'super_admin');
const consultantCookie = () => adminCookieFor(CONSULTANT_EMAIL, 'consultant');
function httpReq(method, p, { cookie, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
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
const atsGet = (p, cookie) => httpReq('GET', p, { host: SUPER_HOST, cookie: cookie || superCookie() });

let realFetch;
beforeAll(async () => {
  await startSupabaseEmulator();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'cand-doc-reviews-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.ZOHO_RECRUIT_REDIRECT_URI = '';
  process.env.OPENAI_API_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.ADMIN_ALLOWED_HOSTS = 'admin-docreview.local';
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
  process.env.CONSULTANT_EMAILS = CONSULTANT_EMAIL;
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.FCM_SERVER_KEY = 'test-fcm-key';

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
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

// ── API ──────────────────────────────────────────────────────────────────────
describe('GET /api/ceo/candidate — doc_reviews', () => {
  it('returns the open doc_review / flagged_doc tasks for the case, oldest first, labelled', async () => {
    const r = await atsGet('/api/ceo/candidate?case_id=case-hatice');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const list = r.body.candidate.doc_reviews;
    expect(Array.isArray(list)).toBe(true);
    // 5 pending: 1 flagged_doc + 4 doc_review (open / in_progress / waiting).
    // The completed one, the email task and the OTHER doctor's flag are out.
    expect(list.map((t) => t.id)).toEqual(['t-flag', 't-cv', 't-cct', 't-pmd', 't-mrcgp']);
    expect(r.body.candidate.doc_reviews_pending).toBe(5);

    const cv = list.find((t) => t.id === 't-cv');
    expect(cv.task_type).toBe('doc_review');
    expect(cv.related_document_key).toBe('cv_signed_dated');
    expect(cv.stage_label).toBe('AHPRA');
    expect(cv.reason).toBe(CV_REASON);           // doc_review → ai_match_reasoning
    expect(cv.ai_match_reasoning).toBe(CV_REASON); // raw fields kept for the modal
    expect(cv.title).toContain('CV (Signed and dated)');

    const flag = list.find((t) => t.id === 't-flag');
    expect(flag.task_type).toBe('flagged_doc');
    expect(flag.reason).toBe(FLAG_REASON);        // flagged_doc → description
    expect(flag.document_label).toBe('Primary Medical Degree');
    expect(flag.stage_label).toBe('Onboarding');
    expect(flag.priority).toBe('high');

    const mrcgp = list.find((t) => t.id === 't-mrcgp');
    expect(mrcgp.document_label).toBe('MRCGP Certificate');
    const cct = list.find((t) => t.id === 't-cct');
    expect(cct.document_label).toBe('Certificate of Completion of Training');
  });

  it('is an empty list (not missing) for a doctor with nothing pending — the card must not render', async () => {
    const r = await atsGet('/api/ceo/candidate?case_id=case-other');
    expect(r.status).toBe(200);
    // case-other DOES have an open flagged_doc → 1; prove scoping both ways.
    expect(r.body.candidate.doc_reviews.map((t) => t.id)).toEqual(['t-other']);
    expect(r.body.candidate.doc_reviews_pending).toBe(1);
  });

  it('consultants (ATS session) get the same list', async () => {
    const r = await atsGet('/api/ceo/candidate?case_id=case-hatice', consultantCookie());
    expect(r.status).toBe(200);
    expect(r.body.candidate.doc_reviews.length).toBe(5);
  });

  it('the candidates-list chip and the profile count the SAME rows', async () => {
    const r = await atsGet('/api/ceo/candidates');
    expect(r.status).toBe(200);
    const row = (r.body.candidates || []).find((c) => c.case_id === 'case-hatice');
    expect(row, 'Hatice should be on the candidates list').toBeTruthy();
    expect(row.doc_reviews_pending).toBe(5);
    const other = (r.body.candidates || []).find((c) => c.case_id === 'case-other');
    expect(other && other.doc_reviews_pending).toBe(1);
  });

  it('server: the list count and the profile fetch share ONE filter string', () => {
    const src = read('server.js');
    expect(src).toContain("var ATS_DOC_REVIEW_OPEN_FILTER = 'task_type=in.(doc_review,flagged_doc)&status=in.(open,in_progress,waiting)';");
    expect(src).toMatch(/'select=case_id&' \+ ATS_DOC_REVIEW_OPEN_FILTER \+ '&limit=2000'/);
    expect(src).toMatch(/'&case_id=eq\.' \+ encodeURIComponent\(caseId\) \+ '&' \+ ATS_DOC_REVIEW_OPEN_FILTER/);
    expect(src).toContain('doc_reviews: docReviews, doc_reviews_pending: docReviews.length,');
  });
});

// ── UI: execute the real card renderer ───────────────────────────────────────
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing function ' + name);
  const open = src.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
function loadCard(role) {
  const src = read('js/ceo-ats-candidates.js');
  const labels = (src.match(/var DOC_REVIEW_STAGE_LABELS = \{[^}]*\};/) || [])[0];
  if (!labels) throw new Error('missing DOC_REVIEW_STAGE_LABELS');
  const body = [labels, extractFn(src, 'docReviewLabel'), extractFn(src, 'docReviewWhen'), extractFn(src, 'docReviewsCardHtml'), extractFn(src, 'docReviewsCardInner')].join('\n')
    + '\nreturn { docReviewsCardHtml: docReviewsCardHtml, docReviewLabel: docReviewLabel };';
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const ATS = { esc, escAttr: esc, isConsultant: () => role === 'consultant' };
  return new Function('ATS', body)(ATS);
}
const count = (html, needle) => html.split(needle).length - 1;

describe('candidate profile — "Documents to review" card', () => {
  const candidate = {
    case_id: 'case-hatice',
    doc_reviews: [
      { id: 't-flag', task_type: 'flagged_doc', title: 'Review flagged Primary Medical Degree for Dr Hatice Akkas', document_label: 'Primary Medical Degree', related_stage: 'onboarding', stage_label: 'Onboarding', reason: FLAG_REASON, created_at: '2026-08-22T12:49:26.000Z' },
      { id: 't-cv', task_type: 'doc_review', title: 'Review uploaded CV (Signed and dated) for Dr Hatice Akkas', document_label: '', related_stage: 'ahpra', stage_label: 'AHPRA', reason: CV_REASON, created_at: '2026-09-02T15:48:15.000Z' },
      { id: 't-cct', task_type: 'doc_review', title: 'Review uploaded Certificate of Completion of Training for Dr Hatice Akkas', document_label: 'Certificate of Completion of Training', related_stage: 'ahpra', stage_label: 'AHPRA', reason: 'No certification statement is present.', created_at: '2026-09-03T04:45:33.000Z' },
      { id: 't-mrcgp', task_type: 'doc_review', title: 'Review uploaded MRCGP Certificate for Dr <b>X</b>', document_label: 'MRCGP <script>alert(1)</script>', related_stage: 'ahpra', stage_label: 'AHPRA', reason: 'Part of the document is outside this photo.', created_at: '2026-09-03T04:49:18.000Z' }
    ]
  };

  it('renders one row + one Review button per pending task for the owner', () => {
    const html = loadCard('super_admin').docReviewsCardHtml(candidate);
    expect(html).toContain('id="ats-cand-doc-reviews"');
    expect(html).toContain('Documents to review');
    expect(html).toContain('<span class="ats-pill red" style="margin-left:6px">4</span>');
    expect(count(html, 'class="ats-btn ats-btn-primary ats-btn-sm ats-doc-review"')).toBe(4);
    ['t-flag', 't-cv', 't-cct', 't-mrcgp'].forEach((id) => {
      expect(html).toContain('class="ats-btn ats-btn-primary ats-btn-sm ats-doc-review" data-task-id="' + id + '"');
    });
    // Labels: served label wins; a missing label falls back to the task title's document.
    expect(html).toContain('Primary Medical Degree');
    expect(html).toContain('CV (Signed and dated)');
    expect(html).toContain('Certificate of Completion of Training');
    // Stage pills + the reason the AI gave, so the reviewer knows what to look for.
    expect(html).toContain('<span class="ats-pill muted">AHPRA</span>');
    expect(html).toContain('<span class="ats-pill muted">Onboarding</span>');
    expect(html).toContain('missing the required declaration statement');
    expect(html).toContain('Received ');
  });

  it('escapes task text (titles and labels come from the AI / uploads)', () => {
    const html = loadCard('super_admin').docReviewsCardHtml(candidate);
    expect(html).not.toContain('<script>');
    expect(html).toContain('MRCGP &lt;script&gt;');
  });

  it('consultants see the list but no decision button', () => {
    const html = loadCard('consultant').docReviewsCardHtml(candidate);
    expect(count(html, 'ats-doc-review-line')).toBe(4);
    expect(html).not.toContain('ats-doc-review"');
    expect(count(html, 'Admin review')).toBe(4);
  });

  it('renders NOTHING when there is nothing to review (no empty card)', () => {
    const card = loadCard('super_admin');
    expect(card.docReviewsCardHtml({ case_id: 'x', doc_reviews: [] })).toBe('');
    expect(card.docReviewsCardHtml({ case_id: 'x' })).toBe('');
    expect(card.docReviewsCardHtml({ case_id: 'x', doc_reviews: null })).toBe('');
  });

  it('is wired: card sits above "Documents on file", Review opens the dashboard modal with the task + a reload', () => {
    const js = read('js/ceo-ats-candidates.js');
    expect(js).toMatch(/docReviewsCardHtml\(c\) \+\n\s*'<div class="ats-card" style="margin-bottom:16px">' \+ docsCardInner\(c\) \+ '<\/div>' \+/);
    expect(js).toContain("var reviewBtn = e.target.closest('.ats-doc-review');");
    expect(js).toContain("if (reviewBtn) { openDocReview(reviewBtn.getAttribute('data-task-id'), c); return; }");
    expect(js).toContain('window.ceoReviewFlaggedDoc(taskId, {');
    expect(js).toContain('onDone: function () { if (c && c.case_id) window.atsOpenCandidate(c.case_id); }');
    // Graceful when the modal is not on the page (script loaded elsewhere).
    expect(js).toContain("if (typeof window.ceoReviewFlaggedDoc !== 'function')");
  });
});

// ── Modal + pins ─────────────────────────────────────────────────────────────
describe('ceo-dashboard.html — review modal accepts a profile caller', () => {
  const html = read('pages/ceo-dashboard.html');
  it('ceoReviewFlaggedDoc takes { task, onDone } and prefers the handed-in task over gpDetailCache', () => {
    expect(html).toContain('function ceoReviewFlaggedDoc(taskId, opts) {');
    expect(html).toContain("_ceoReviewOpts = (opts && typeof opts === 'object') ? opts : null;");
    expect(html).toContain('var t = (_ceoReviewOpts && _ceoReviewOpts.task) || findCeoTask(taskId) || {};');
  });
  it('a decision refreshes the dashboard counts and calls onDone exactly once', () => {
    const start = html.indexOf('function submitCeoReviewDoc(');
    const fn = html.slice(start, html.indexOf('// Formatting-toolbar clicks', start));
    expect(fn).toContain("var reviewDone = _ceoReviewOpts && typeof _ceoReviewOpts.onDone === 'function' ? _ceoReviewOpts.onDone : null;");
    expect(fn).toContain('_ceoReviewOpts = null;');
    expect(fn).toContain('refreshDashboard();');
    expect(fn).toContain('if (reviewDone) { try { reviewDone(); }');
    // Still refreshes the Registration-tab GP file for that caller.
    expect(fn).toContain('refreshGpDetailTasks();');
  });
  it('the candidates script is cache-busted so the deployed page loads the new card', () => {
    expect(html).toContain('/js/ceo-ats-candidates.js?v=20260904a');
    expect(html).not.toContain('/js/ceo-ats-candidates.js?v=20260902a');
  });
});

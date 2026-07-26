// AI Matching — Task 3: Matching tab UI + kanban states.
// Two halves:
//  (A) Source-regex wiring checks — the Matching master tab is registered
//      (button/panel/MASTER_PANELS/script tag) and js/ceo-ats-matching.js
//      exposes window.loadMatchingTab. No DOM/browser needed for these.
//  (B) Server endpoint tests, booted in LOCAL-JSON mode exactly like
//      tests/ats-endpoints.test.js: the /api/ats/job/pipeline payload must
//      carry the match_* fields onto each Shortlist-column card, and the
//      PATCH /api/ats/application {match_extend:true} action must reset the
//      match window + stage (and reject rows that were never matched).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

describe('AI Matching Task 3 — client wiring (source regex)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');
  const sharedSrc = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-shared.js'), 'utf8');
  const matchingSrc = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-matching.js'), 'utf8');
  const jobsSrc = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-jobs.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  it('ceo-dashboard.html has the Matching tab button', () => {
    expect(html).toMatch(/<button class="ats-master-tab" data-mtab="matching">/);
  });

  it('ceo-dashboard.html has the Matching panel div', () => {
    expect(html).toMatch(/<div class="master-panel ats-scope" id="panel-matching" style="display:none"><\/div>/);
  });

  it('ceo-dashboard.html loads ceo-ats-matching.js with the current cache buster', () => {
    // Bumped by the Task 5 (2026-07-11) matching-board rewrite — see
    // tests/matching-board-ui.test.js for the full board-rewrite coverage.
    expect(html).toMatch(/<script src="\/js\/ceo-ats-matching\.js\?v=20260727a"><\/script>/);
  });

  it("js/ceo-ats-shared.js MASTER_PANELS includes 'matching'", () => {
    const line = sharedSrc.split('\n').find((l) => l.includes('var MASTER_PANELS ='));
    expect(line).toBeTruthy();
    expect(line).toMatch(/'matching'/);
  });

  it('js/ceo-ats-matching.js exposes window.loadMatchingTab', () => {
    expect(matchingSrc).toMatch(/window\.loadMatchingTab\s*=\s*loadMatchingTab;/);
  });

  it('js/ceo-ats-matching.js posts to the shortlist endpoint behind a confirm() gate', () => {
    // Task 5 (2026-07-11) rewrote the whole tab into the funnel board — the
    // exact confirm-copy template from the original Task 3 picker no longer
    // exists verbatim (see tests/matching-board-ui.test.js's wiring-pins
    // describe block for the current copy), but the safety gate itself —
    // never shortlisting without an explicit confirm() — must survive.
    expect(matchingSrc).toContain('/api/ats/matching/shortlist');
    expect(matchingSrc).toMatch(/window\.confirm\(\s*'Send the match email and in-app notification/);
  });

  it('js/ceo-ats-jobs.js renders a Shortlist-card status line reading the match_* fields', () => {
    expect(jobsSrc).toMatch(/function matchStatusHtml/);
    expect(jobsSrc).toContain("c.match_outcome === 'expired'");
    expect(jobsSrc).toContain('c.match_seen_at');
    expect(jobsSrc).toContain('c.match_expires_at');
    expect(jobsSrc).toContain('data-ats-extend');
  });

  it('server.js /api/ats/application PATCH handles match_extend before the normal stage validator', () => {
    const idx = serverSrc.indexOf("pathname === '/api/ats/application' && req.method === 'PATCH'");
    const idxExtend = serverSrc.indexOf('bodyAP.match_extend === true');
    const idxValidStages = serverSrc.indexOf('var validStages = atsPracticeUtil.ATS_STAGES.concat', idx);
    expect(idx).toBeGreaterThan(-1);
    expect(idxExtend).toBeGreaterThan(idx);
    expect(idxExtend).toBeLessThan(idxValidStages);
  });
});

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ai-matching-pipeline-${RUN_ID}.json`);
const SUPER_HOST = 'ats-test.local';
let server, port;

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function req(method, p, { host, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject); r.end(data);
  });
}
const parse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

// Seeded application ids used across the pipeline + extend tests below.
const MATCHED_ACTIVE_ID = 'ms-active';   // shortlisted, matched, still within its 5-day window
const MATCHED_EXPIRED_ID = 'ms-expired'; // shortlisted, matched, window already elapsed + outcome:'expired'
const MATCHED_SWEPT_ID = 'ms-swept';     // not_proceeding + outcome:'expired' (lifecycle-swept) — the legit reopen case
const MATCHED_HIRED_ID = 'ms-hired';     // matched but already progressed to hired — extend must be rejected
const MATCHED_INTERVIEW_ID = 'ms-interview'; // matched but already progressed to interview — extend must be rejected

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'ai-matching-pipeline-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-ats-dev.js')], { env: { ...process.env, DB_FILE_PATH: DB_FILE } });

  // Inject two Shortlist-column applications on job j1 carrying Task 2's
  // match_* fields — the seed script itself has no AI-matched rows.
  const seeded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  seeded.atsApplications = seeded.atsApplications || [];
  const nowIso = new Date().toISOString();
  seeded.atsApplications.push(
    {
      id: MATCHED_ACTIVE_ID, name: 'Dr Active Match', country: 'Ireland', career_role_id: 'j1',
      ats_stage: 'shortlisted', email: 'active-match@example.com', ats_notes: '',
      matched_by: 'admin@gplink-test.local', matched_at: nowIso,
      match_expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      match_seen_at: null, match_outcome: null, match_score: 55,
      match_reasons: { reasons: ['Good regional fit', 'Family-friendly practice'], _history: [] }
    },
    {
      id: MATCHED_EXPIRED_ID, name: 'Dr Expired Match', country: 'United Kingdom', career_role_id: 'j1',
      ats_stage: 'shortlisted', email: 'expired-match@example.com', ats_notes: '',
      matched_by: 'admin@gplink-test.local', matched_at: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
      match_expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      match_seen_at: nowIso, match_outcome: 'expired', match_score: 72,
      match_reasons: { reasons: ['Strong AHPRA alignment'], _history: [{ outcome: 'declined', decline_reason: null, at: nowIso }] }
    },
    // Review-fix fixtures for the extend stage gate:
    {
      id: MATCHED_SWEPT_ID, name: 'Dr Swept Match', country: 'Ireland', career_role_id: 'j1',
      ats_stage: 'not_proceeding', email: 'swept-match@example.com', ats_notes: '',
      matched_by: 'admin@gplink-test.local', matched_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      match_expires_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      match_seen_at: null, match_outcome: 'expired', match_score: 61,
      match_reasons: { reasons: ['Regional experience'], _history: [] }
    },
    {
      id: MATCHED_HIRED_ID, name: 'Dr Hired Match', country: 'United Kingdom', career_role_id: 'j1',
      ats_stage: 'hired', email: 'hired-match@example.com', ats_notes: '',
      matched_by: 'admin@gplink-test.local', matched_at: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
      match_expires_at: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
      match_seen_at: nowIso, match_outcome: 'accepted', match_score: 88,
      match_reasons: { reasons: ['Great fit'], _history: [] }
    },
    {
      id: MATCHED_INTERVIEW_ID, name: 'Dr Interview Match', country: 'New Zealand', career_role_id: 'j1',
      ats_stage: 'interview', email: 'interview-match@example.com', ats_notes: '',
      matched_by: 'admin@gplink-test.local', matched_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      match_expires_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      match_seen_at: nowIso, match_outcome: 'accepted', match_score: 79,
      match_reasons: { reasons: ['Visa pathway aligned'], _history: [] }
    }
  );
  fs.writeFileSync(DB_FILE, JSON.stringify(seeded, null, 2));

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('GET /api/ats/job/pipeline — match_* fields on Shortlist cards', () => {
  it('surfaces matched_at, match_expires_at, match_seen_at, match_outcome, match_score and the plain reasons array', async () => {
    const r = await req('GET', '/api/ats/job/pipeline?id=j1', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    const shortlistCol = b.columns.find((c) => c.key === 'shortlisted');
    expect(shortlistCol).toBeTruthy();

    const active = shortlistCol.cards.find((c) => c.id === MATCHED_ACTIVE_ID);
    expect(active).toBeTruthy();
    expect(typeof active.matched_at).toBe('string');
    expect(typeof active.match_expires_at).toBe('string');
    expect(active.match_seen_at).toBe(null);
    expect(active.match_outcome).toBe(null);
    expect(active.match_score).toBe(55);
    // Contract note from Task 2: match_reasons is stored as {reasons, _history} —
    // the card must surface the plain array, never the wrapper object.
    expect(active.match_reasons).toEqual(['Good regional fit', 'Family-friendly practice']);

    const expired = shortlistCol.cards.find((c) => c.id === MATCHED_EXPIRED_ID);
    expect(expired).toBeTruthy();
    expect(expired.match_outcome).toBe('expired');
    expect(typeof expired.match_seen_at).toBe('string');
    expect(expired.match_reasons).toEqual(['Strong AHPRA alignment']);
  });

  it('a plain (non-matched) application card carries null match_* fields, not undefined/omitted', async () => {
    const r = await req('GET', '/api/ats/job/pipeline?id=j1', { host: SUPER_HOST, cookie: superCookie() });
    const b = parse(r.raw);
    const applied = b.columns.find((c) => c.key === 'applied');
    const c1 = applied.cards.find((c) => c.id === 'c1');
    expect(c1).toBeTruthy();
    expect(c1.matched_at).toBe(null);
    expect(c1.match_expires_at).toBe(null);
    expect(c1.match_outcome).toBe(null);
    expect(c1.match_reasons).toEqual([]);
  });
});

describe('PATCH /api/ats/application {match_extend:true}', () => {
  it('resets an expired match: clears outcome, pushes expiry 5 days out, stage back to shortlisted', async () => {
    const before = Date.now();
    const r = await req('PATCH', '/api/ats/application?id=' + MATCHED_EXPIRED_ID, { host: SUPER_HOST, cookie: superCookie(), body: { match_extend: true } });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.application.ats_stage).toBe('shortlisted');
    expect(b.application.match_outcome).toBe(null);
    const expiresAt = new Date(b.application.match_expires_at).getTime();
    // ~5 days from now, generous bounds for test-run jitter.
    expect(expiresAt).toBeGreaterThan(before + 4.9 * 24 * 60 * 60 * 1000);
    expect(expiresAt).toBeLessThan(before + 5.1 * 24 * 60 * 60 * 1000);

    // Persisted, not just in the response — a fresh pipeline fetch agrees.
    const after = await req('GET', '/api/ats/job/pipeline?id=j1', { host: SUPER_HOST, cookie: superCookie() });
    const col = parse(after.raw).columns.find((c) => c.key === 'shortlisted');
    const card = col.cards.find((c) => c.id === MATCHED_EXPIRED_ID);
    expect(card.match_outcome).toBe(null);
  });

  it('rejects match_extend on an application that was never matched (no matched_at)', async () => {
    const r = await req('PATCH', '/api/ats/application?id=c1', { host: SUPER_HOST, cookie: superCookie(), body: { match_extend: true } });
    expect(r.status).toBe(400);
    const b = parse(r.raw);
    expect(b.ok).toBe(false);
  });

  it('allows extend on a lifecycle-swept row (not_proceeding + outcome expired) and moves it back to shortlisted', async () => {
    const r = await req('PATCH', '/api/ats/application?id=' + MATCHED_SWEPT_ID, { host: SUPER_HOST, cookie: superCookie(), body: { match_extend: true } });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.application.ats_stage).toBe('shortlisted');
    expect(b.application.match_outcome).toBe(null);

    // Persisted: the card is now in the Shortlist column, not not_proceeding.
    const after = await req('GET', '/api/ats/job/pipeline?id=j1', { host: SUPER_HOST, cookie: superCookie() });
    const cols = parse(after.raw).columns;
    expect(cols.find((c) => c.key === 'shortlisted').cards.some((c) => c.id === MATCHED_SWEPT_ID)).toBe(true);
    expect(cols.find((c) => c.key === 'not_proceeding').cards.some((c) => c.id === MATCHED_SWEPT_ID)).toBe(false);
  });

  it('rejects extend on a matched row that already progressed to hired (fail-closed stage gate)', async () => {
    const r = await req('PATCH', '/api/ats/application?id=' + MATCHED_HIRED_ID, { host: SUPER_HOST, cookie: superCookie(), body: { match_extend: true } });
    expect(r.status).toBe(400);
    const b = parse(r.raw);
    expect(b.ok).toBe(false);
    expect(b.error).toBe('invalid_stage_for_extend');

    // The row is untouched — still hired, outcome intact.
    const after = await req('GET', '/api/ats/job/pipeline?id=j1', { host: SUPER_HOST, cookie: superCookie() });
    const hired = parse(after.raw).columns.find((c) => c.key === 'hired').cards.find((c) => c.id === MATCHED_HIRED_ID);
    expect(hired).toBeTruthy();
    expect(hired.match_outcome).toBe('accepted');
  });

  it('rejects extend on a matched row that already progressed to interview', async () => {
    const r = await req('PATCH', '/api/ats/application?id=' + MATCHED_INTERVIEW_ID, { host: SUPER_HOST, cookie: superCookie(), body: { match_extend: true } });
    expect(r.status).toBe(400);
    const b = parse(r.raw);
    expect(b.ok).toBe(false);
    expect(b.error).toBe('invalid_stage_for_extend');
  });

  it('404s match_extend on an unknown application id', async () => {
    const r = await req('PATCH', '/api/ats/application?id=does-not-exist', { host: SUPER_HOST, cookie: superCookie(), body: { match_extend: true } });
    expect(r.status).toBe(404);
  });

  it('blocks match_extend without a session', async () => {
    const r = await req('PATCH', '/api/ats/application?id=' + MATCHED_ACTIVE_ID, { host: SUPER_HOST, body: { match_extend: true } });
    expect([401, 403, 302]).toContain(r.status);
  });
});

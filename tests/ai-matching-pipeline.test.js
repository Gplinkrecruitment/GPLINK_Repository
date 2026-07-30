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

// A match is not an application until the doctor says so. `status` defaults to
// 'applied' in the schema, so a shortlist row that never set it claimed the
// doctor had applied before they had even seen the match — the internal board
// reads ats_stage and was correct, while every GP-facing screen reads status
// and said "Application submitted / under review" (owner report 2026-07-27).
describe('a shortlisted match does not claim to be an application', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  it('the shortlist insert sets status explicitly, not by schema default', () => {
    const idx = serverSrc.indexOf("ats_stage: 'shortlisted', origin: 'ai_matched'");
    expect(idx).toBeGreaterThan(-1);
    // status is set on the same row literal, immediately above the stage.
    expect(serverSrc.slice(idx - 700, idx)).toContain("status: 'shortlisted'");
  });

  it('accepting the match is what moves status to applied', () => {
    const idx = serverSrc.indexOf("var patch = { status: 'applied', ats_stage: 'applied', match_outcome: 'accepted'");
    expect(idx).toBeGreaterThan(-1);
  });

  it('the two halves stay paired — a shortlist status with no accept-side move would strand the row', () => {
    const shortlisted = (serverSrc.match(/status: 'shortlisted'/g) || []).length;
    const acceptMove = serverSrc.indexOf("status: 'applied', ats_stage: 'applied'");
    expect(shortlisted).toBeGreaterThan(0);
    expect(acceptMove).toBeGreaterThan(-1);
  });
});

// A match reveals the practice immediately (the shortlist row is written
// revealed:true) — the doctor is told who it is so they can decide. The
// careers page used to copy the PUBLIC roles list's masked headline over that
// real name while still showing "IDENTITY UNLOCKED" beside it.
describe('careers page keeps a revealed practice name', () => {
  const careerHtml = fs.readFileSync(path.join(ROOT, 'pages/career.html'), 'utf8');

  it('does not overwrite a revealed application name with the masked roles-list one', () => {
    expect(careerHtml).toContain('const keepRevealedName = job.revealed === true && job.practiceName');
    expect(careerHtml).toContain('practiceName: keepRevealedName ? job.practiceName : liveRole.practiceName');
    // The unconditional clobber must be gone.
    expect(careerHtml).not.toContain('{ ...job, practiceName: liveRole.practiceName, location: liveRole.location }');
  });

  it('still takes location from the live role, which is not identity-bearing', () => {
    expect(careerHtml).toContain('location: liveRole.location');
  });
});

// The practice accepting means "we want to interview this doctor" — the record
// it creates IS the interview invitation, and the flow immediately waits on the
// practice's interview times. 'offer' is reserved for a real job offer, set
// when the contract goes out (owner call 2026-07-28).
describe('practice acceptance lands on Interview, not Offer', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  it('the staff-side accept targets interview', () => {
    const idx = serverSrc.indexOf("if (pathname === '/api/ats/application/accept'");
    expect(idx).toBeGreaterThan(-1);
    const handler = serverSrc.slice(idx, idx + 4000);
    expect(handler).toContain("planAtsStageReconciliation((acCtx.app && acCtx.app.ats_stage) || '', 'interview')");
    expect(handler).not.toContain("planAtsStageReconciliation((acCtx.app && acCtx.app.ats_stage) || '', 'offer')");
  });

  it('agrees with the practice\'s own decision endpoint, which already targeted interview', () => {
    const idx = serverSrc.indexOf("if (pathname === '/api/practice/application/decision'");
    const handler = serverSrc.slice(idx, idx + 12000);
    expect(handler).toContain("planAtsStageReconciliation(appRow.ats_stage || '', 'interview')");
  });

  it('a real contract offer still moves to offer', () => {
    // /api/ceo/contract/decision sends the actual contract — that IS an offer.
    expect(serverSrc).toContain("planAtsStageReconciliation(cdApp.ats_stage || '', 'offer')");
  });
});

// A practice turning a doctor down used to be silent: no email, no stage move,
// and their other openings stayed on the doctor's careers page as if nothing
// had happened. Owner call 2026-07-28.
describe('practice turn-down closes out and clears the practice away', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const turnDown = serverSrc.slice(serverSrc.indexOf("// action === 'turn_down'."), serverSrc.indexOf("sendJson(res, 200, { ok: true, decision: 'turned_down' });"));

  it('closes the application so the candidate falls back to Unassociated or their next live one', () => {
    expect(turnDown).toContain("status: 'not_proceeding'");
    expect(turnDown).toContain('atsPracticeUtil.ATS_REJECT_STAGE');
    expect(turnDown).toContain("'practice_turn_down'");
  });

  it('tells the doctor, without naming a reason or saying "rejected"', () => {
    expect(turnDown).toContain('gone with another candidate');
    expect(turnDown).toContain('sendGpNotificationEmail');
    expect(turnDown).toContain('pushCareerNotificationToUser');
    // Assert on the doctor-facing copy itself, not the surrounding comments.
    const bodyStart = turnDown.indexOf('const tdBody');
    const tdBody = turnDown.slice(bodyStart, turnDown.indexOf(';', bodyStart));
    expect(tdBody).not.toContain('rejected');
    expect(tdBody).not.toContain('unsuccessful');
    // The practice's stated reason goes to the team only, never to the doctor.
    expect(tdBody).not.toContain('reason');
  });

  it('hides that practice\'s roles from the doctor\'s careers page', () => {
    expect(serverSrc).toContain('async function _rolesHiddenByPracticeTurnDown(userId)');
    expect(serverSrc).toContain('practice_decision=eq.turned_down');
    // Applied inside the visibility gate, before the DPA blur — a hidden role
    // must not come back as a stub that still reveals the role exists.
    const gate = serverSrc.slice(serverSrc.indexOf('async function _applyGpRoleVisibilityGate'), serverSrc.indexOf('async function _applyGpRoleVisibilityGate') + 1600);
    expect(gate).toContain('_rolesHiddenByPracticeTurnDown(userId)');
    expect(gate.indexOf('_rolesHiddenByPracticeTurnDown')).toBeLessThan(gate.indexOf('buildRedactedRoleStub'));
  });

  it('fails OPEN if the lookup breaks — a blank careers page would be worse', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function _rolesHiddenByPracticeTurnDown'), serverSrc.indexOf('async function _applyGpRoleVisibilityGate'));
    expect(fn).toContain('return new Set()');
    expect(fn).toContain('catch');
  });
});

// Pass A of practice-decision-reminders only watches ats_stage in
// (submitted, reviewing), so it stopped the moment a candidate reached
// interview. A practice that interviewed someone and went quiet was chased by
// nobody, while the doctor sat on "awaiting the practice's decision" — the
// worst place in the funnel to be forgotten (owner call 2026-07-28).
describe('post-interview silence gets chased', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const cron = serverSrc.slice(
    serverSrc.indexOf("if (req.method === 'GET' && pathname === '/api/cron/practice-decision-reminders')"),
    serverSrc.indexOf("if (req.method === 'GET' && pathname === '/api/cron/chase-nonresponders')")
  );

  it('selects the post-interview waiting state, which decisions move rows off', () => {
    expect(cron).toContain("'select=*&status=eq.interview_completed&limit=500'");
  });

  it('re-sends the SAME decision email rather than inventing a second one', () => {
    expect(cron).toContain('sendPostInterviewDecisionEmail(piApp.id)');
  });

  it('mirrors pass A: day 3, day 5, escalate at 7, and skips weekends', () => {
    expect(cron).toContain('piDays >= 3');
    expect(cron).toContain('piDays >= 5');
    expect(cron).toContain('piDays >= 7');
    expect(cron).toContain('if (pdWeekend) continue;');
  });

  it('a stale pre-interview flag cannot suppress the post-interview escalation', () => {
    // Compared against the interview, not a bare null check — the same row may
    // already carry a flag from the submission round.
    expect(cron).toContain('piFlagMs < piDoneMs');
    expect(cron).toContain('piLastMs < piDoneMs');
  });

  it('shares pass A\'s send cap so one run cannot flood', () => {
    expect(cron).toContain('pdSent < pdCap');
  });
});

// Fixing the stored status was necessary but not sufficient: the server
// re-derived a presentation status on the way out, and with no 'shortlisted'
// branch the row fell through to the 'applied' default — which is literally
// where "Application submitted" and the Applied→Under Review→… timeline came
// from on the doctor's screen (owner report 2026-07-28).
describe('a pending match presents as matched, not applied', () => {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const careerHtml = fs.readFileSync(path.join(ROOT, 'pages/career.html'), 'utf8');
  const detailHtml = fs.readFileSync(path.join(ROOT, 'pages/application-detail.html'), 'utf8');
  const mapper = serverSrc.slice(
    serverSrc.indexOf('function buildInternalCareerStatusPresentation'),
    serverSrc.indexOf("return { status: 'applied', statusLabel: 'Application received")
  );

  it('the presentation mapper answers "matched" before falling through to applied', () => {
    expect(mapper).toContain("stage === 'shortlisted' && !row.match_outcome");
    expect(mapper).toContain("status: 'matched'");
    expect(mapper).toContain('accept or decline');
  });

  it('an ANSWERED match no longer counts as pending', () => {
    // match_outcome is what closes it — accepted rows move to ats_stage
    // 'applied' anyway, but a declined/expired row must not resurface here.
    expect(mapper).toContain('!row.match_outcome');
  });

  it('the careers card leads with MATCHED and its own copy', () => {
    // The pending-match branch is checked FIRST in the shared state map, because
    // every other branch describes something that has already happened to an
    // application and none of it is true for an unanswered match.
    const stateMap = careerHtml.slice(
      careerHtml.indexOf('function careerApplicationState(application) {'),
      careerHtml.indexOf('function careerMineStatusLabel')
    );
    expect(stateMap).toContain('if (key === "matched")');
    expect(stateMap).toContain('ribbon: "MATCHED TO YOU"');
    expect(stateMap.indexOf('if (key === "matched")')).toBeLessThan(stateMap.indexOf('if (key === "submitted")'));
    expect(careerHtml).toContain('Open it to accept or decline before it expires');
  });

  it('tapping a pending match opens the practice page, not the application tracker', () => {
    expect(careerHtml).toContain('String(app.status || "").trim().toLowerCase() === "matched"');
    expect(careerHtml).toContain('"/pages/job?id=" + encodeURIComponent(roleId) + "&match=" + encodeURIComponent(appId)');
  });

  it('the tracker bounces a pending match before drawing a false timeline', () => {
    const idx = detailHtml.indexOf('function renderApplication(app) {');
    const head = detailHtml.slice(idx, idx + 1400);
    expect(head).toContain('=== "matched"');
    // Redirect must come BEFORE the content is unhidden, or the wrong timeline
    // flashes up first.
    expect(head.indexOf('=== "matched"')).toBeLessThan(head.indexOf('appContent").hidden = false'));
  });
});

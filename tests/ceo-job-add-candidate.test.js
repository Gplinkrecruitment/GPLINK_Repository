// CEO Jobs board — "＋ Add candidate", the doctor search, and the invitation
// that a manual shortlist must send.
//
// Owner 2026-08-05, first ask: "i should be able to add a GP candidate (also
// insert search feature to search for gp to add)". Second, after using it:
// "i manually shortlisted dr deepika to this practice why was not congratulatory
// email and in app notification pathway initiated? fix".
//
// So the load-bearing property is the opposite of what it first was: a manual
// shortlist IS a real shortlist and must run the SAME doctor-facing pathway the
// Matching board runs — match stamps, practice revealed, email + in-app + push.
// The one thing it must never become is POST /api/ats/application, which means
// "placed with the practice" and records an offer.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : '/tmp', `gplink-addcand-${RUN_ID}.json`);
const SUPER_HOST = 'addcand-test.local';

const JOBS_JS = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-jobs.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'css/ceo-ats.css'), 'utf8');
const CEO_HTML = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let server, port, testUtils;

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
const readDb = () => { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; } };
const rowFor = (uid) => readDb().atsApplications.find((a) => a.user_id === uid);

// job.dpa:true keeps DPA out of the picture, so each candidate's own state is
// the only thing deciding whether they can be invited.
const SEED = {
  atsPractices: [
    { id: 'pr-1', name: 'Riverlink Medical & Dental Centre', location_city: 'North Ipswich', location_state: 'QLD', stage: 'active' }
  ],
  atsJobs: [
    { id: 'job-1', provider: 'internal_ats', provider_role_id: 'ats_job1', title: 'GP — Riverlink', practice_id: 'pr-1', practice_name: 'Riverlink Medical & Dental Centre', suburb: 'North Ipswich', location_city: 'North Ipswich', location_state: 'QLD', dpa: true, is_active: true, job_status: 'open', approval_status: 'approved', ats_created: true }
  ],
  // A card that already exists at Shortlist with NO match stamps — exactly the
  // state Dr Deepika's real card was left in by the first version of this
  // feature, which added silently. Pressing Add/Notify must rescue it.
  atsApplications: [
    { id: 'app-legacy', user_id: 'gp-mercy', career_role_id: 'job-1', provider_role_id: 'ats_job1', ats_stage: 'shortlisted', status: 'shortlisted', origin: 'admin_applied', job_title: 'GP — Riverlink', practice_name: 'Riverlink Medical & Dental Centre' }
  ],
  atsCandidates: [
    { user_id: 'gp-aisha', case_id: 'case-1', name: 'Dr Aisha Khan', email: 'aisha@example.com', country: 'uk', status: 'active', account_status: 'active', onboarding_completed: true, docs: { cv: true }, apps: [] },
    // Dr Deepika: onboarded and active but NO CV on file — the real 2026-08-05
    // case. She must land on the board and must NOT be emailed.
    { user_id: 'gp-deepika', case_id: 'case-2', name: 'Dr Deepika Ganesh', email: 'deepika@example.com', country: 'za', status: 'active', account_status: 'active', onboarding_completed: true, docs: { cv: false }, apps: [] },
    { user_id: 'gp-mercy', case_id: 'case-3', name: 'Dr Mercy Obanimoh', email: 'mercy@example.com', country: 'uk', status: 'active', account_status: 'active', onboarding_completed: true, docs: { cv: true }, apps: [] }
  ]
};

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'addcand-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  fs.writeFileSync(DB_FILE, JSON.stringify(SEED, null, 2));

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

const add = (body) => req('POST', '/api/ats/job/candidate', { host: SUPER_HOST, cookie: superCookie(), body });

describe('POST /api/ats/job/candidate — the invitation', () => {
  it('is staff-only', async () => {
    const r = await req('POST', '/api/ats/job/candidate', { host: SUPER_HOST, body: { user_id: 'gp-aisha', career_role_id: 'job-1' } });
    expect(r.status).toBe(401);
    // Nothing written — still just the pre-seeded legacy card.
    expect(readDb().atsApplications.length).toBe(SEED.atsApplications.length);
  });

  it('shortlists an eligible doctor AND tells them', async () => {
    const r = await add({ user_id: 'gp-aisha', career_role_id: 'job-1', stage: 'shortlisted' });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.already).toBe(false);
    expect(b.notified).toBe(true);

    const row = rowFor('gp-aisha');
    expect(row.ats_stage).toBe('shortlisted');
    // `status` defaults to 'applied' in the schema and every GP-facing screen
    // reads it — leaving it would claim they applied for something unseen.
    expect(row.status).toBe('shortlisted');
    expect(row.origin).toBe('admin_applied');
  });

  it('writes the stamps the doctor-facing surfaces actually read', async () => {
    const row = rowFor('gp-aisha');
    // getPendingMatchForRole requires matched_at, and the match-lifecycle cron
    // selects matched_at=not.is.null — without this stamp the doctor sees no
    // match card and no reminder can ever fire. THIS was the reported bug.
    expect(row.matched_at).toBeTruthy();
    expect(row.match_expires_at).toBeTruthy();
    // A match they cannot identify is useless, so the practice is revealed.
    expect(row.revealed).toBe(true);
    // Held for the same window the Matching board uses.
    const days = (Date.parse(row.match_expires_at) - Date.parse(row.matched_at)) / 86400000;
    expect(Math.round(days)).toBe(testUtils.SHORTLIST_MATCH_WINDOW_DAYS);
    // Still an invitation, NOT a placement — no offer was recorded.
    expect((readDb().atsOffers || []).length).toBe(0);
  });

  it('adds a blocked doctor to the board but does NOT invite them, and says why', async () => {
    // Dr Deepika has no CV. Announcing reveals the practice and starts a clock,
    // so the same fail-closed gate the Matching board uses applies here.
    const r = await add({ user_id: 'gp-deepika', career_role_id: 'job-1' });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.notified).toBe(false);
    expect(b.blocks).toContain('no_cv');

    const row = rowFor('gp-deepika');
    expect(row.ats_stage).toBe('shortlisted');   // the card exists…
    expect(row.matched_at == null).toBe(true);   // …but nothing was sent
    expect(row.revealed).not.toBe(true);
  });

  it('rescues a card that already exists but was never told', async () => {
    // The door for every card the first, silent version of this feature
    // created — Dr Deepika's included. Pressing Add/Notify on someone already
    // sitting at Shortlist with no match stamps sends the invitation against
    // that SAME card rather than doing nothing.
    expect(rowFor('gp-mercy').matched_at == null).toBe(true); // starts un-told

    const r = await add({ user_id: 'gp-mercy', career_role_id: 'job-1' });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.already).toBe(true);
    expect(b.notified).toBe(true);

    const row = rowFor('gp-mercy');
    expect(row.matched_at).toBeTruthy();
    expect(row.revealed).toBe(true);
    // Still exactly one card — the rescue patches, never duplicates.
    expect(readDb().atsApplications.filter((a) => a.user_id === 'gp-mercy').length).toBe(1);
  });

  it('offers the rescue only while the doctor is eligible', async () => {
    // Dr Deepika is on the board un-told, but still has no CV — the response
    // must say it CAN be notified once fixed, and why it cannot be yet.
    const r = await add({ user_id: 'gp-deepika', career_role_id: 'job-1' });
    const b = parse(r.raw);
    expect(b.already).toBe(true);
    expect(b.notified).toBe(false);
    expect(b.can_notify).toBe(true);
    expect(b.blocks).toContain('no_cv');
    expect(rowFor('gp-deepika').matched_at == null).toBe(true);
  });

  it('does not re-invite someone who was already invited', async () => {
    const before = rowFor('gp-aisha').matched_at;
    const r = await add({ user_id: 'gp-aisha', career_role_id: 'job-1' });
    expect(parse(r.raw).already).toBe(true);
    expect(parse(r.raw).can_notify).toBe(false);
    expect(rowFor('gp-aisha').matched_at).toBe(before); // clock not restarted
  });

  it('refuses stages that carry side effects of their own', async () => {
    for (const stage of ['offer', 'hired', 'submitted', 'interview', 'reviewing']) {
      const r = await add({ user_id: 'gp-new', career_role_id: 'job-1', stage });
      expect(r.status).toBe(400);
      expect(parse(r.raw).message).toMatch(/Shortlist or Applied/);
    }
  });

  it('validates its inputs', async () => {
    expect((await add({ career_role_id: 'job-1' })).status).toBe(400);
    expect((await add({ user_id: 'gp-x' })).status).toBe(400);
    expect((await add({ user_id: 'gp-x', career_role_id: 'no-such-job' })).status).toBe(404);
  });

  it('shows up on the job board it was added to', async () => {
    const r = await req('GET', '/api/ats/job/pipeline?id=job-1', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const shortlist = (parse(r.raw).columns || []).find((c) => c.key === 'shortlisted');
    expect(shortlist.cards.map((c) => c.user_id).sort()).toEqual(['gp-aisha', 'gp-deepika', 'gp-mercy']);
    // The card carries matched_at, which is how the modal knows whether to
    // show "Invited" or offer "Notify".
    const byUser = {};
    shortlist.cards.forEach((c) => { byUser[c.user_id] = c; });
    expect(!!byUser['gp-aisha'].matched_at).toBe(true);
    expect(!!byUser['gp-mercy'].matched_at).toBe(true);
    expect(!!byUser['gp-deepika'].matched_at).toBe(false); // blocked, so untold
  });
});

describe('one announcement, both doors', () => {
  it('the Matching board and the manual add call the SAME announcer', () => {
    // The reported bug was exactly this drift: only the Matching board knew to
    // tell the doctor. Neither path may call sendMatchEmail on its own again.
    expect(SERVER_SRC).toContain('async function announceShortlistToGp');
    const shortlistCalls = SERVER_SRC.match(/announceShortlistToGp\(/g) || [];
    expect(shortlistCalls.length).toBeGreaterThanOrEqual(4); // definition + 3 call sites
    expect(SERVER_SRC).not.toContain("if (typeof sendMatchEmail === 'function') { await sendMatchEmail(");
  });

  it('the announcement is email AND in-app AND push', () => {
    const fn = SERVER_SRC.slice(
      SERVER_SRC.indexOf('async function announceShortlistToGp'),
      SERVER_SRC.indexOf('async function atsMarkApplicationShortlisted')
    );
    expect(fn).toContain('sendMatchEmail');
    expect(fn).toContain('pushCareerNotificationToUser');
    expect(fn).toContain('sendPushNotification');
  });

  it('never stamps matched_at without announcing', () => {
    // Setting the stamp starts the expiry clock; doing that silently would run
    // a doctor out of time on an invitation they were never sent.
    const marker = SERVER_SRC.indexOf('async function atsMarkApplicationShortlisted');
    const warning = SERVER_SRC.indexOf('set it without calling announceShortlistToGp');
    expect(marker).toBeGreaterThan(-1);
    // The warning lives in the doc comment immediately ABOVE the declaration.
    expect(warning).toBeGreaterThan(-1);
    expect(warning).toBeLessThan(marker);
  });

  it('still is not the placement endpoint', () => {
    const quiet = SERVER_SRC.slice(
      SERVER_SRC.indexOf("pathname === '/api/ats/job/candidate'"),
      SERVER_SRC.indexOf("pathname === '/api/ats/application' && req.method === 'POST'")
    );
    expect(quiet.length).toBeGreaterThan(200);
    expect(quiet).not.toContain('saveAtsOffer');
    expect(quiet).not.toContain('maybeSendInterviewBookingInvite');
  });
});

describe('GP search (client)', () => {
  it('the board offers an Add candidate button', () => {
    expect(JOBS_JS).toContain('id="atsAddCandBtn"');
    expect(JOBS_JS).toContain('＋ Add candidate');
    expect(JOBS_JS).toContain("on('atsAddCandBtn', 'click', openAddCandidateModal)");
  });

  it('searches every doctor by name or email, debounced', () => {
    expect(JOBS_JS).toContain('id="atsAddCandSearch"');
    expect(JOBS_JS).toContain("'/api/ceo/candidates'");
    expect(JOBS_JS).toContain('addCandSearchTimer');
    expect(JOBS_JS).toContain('if (q !== addCandQuery) return;');
  });

  it('says up front that the doctor gets invited', () => {
    expect(JOBS_JS).toMatch(/invites them/);
    expect(JOBS_JS).not.toMatch(/Nothing is sent to them/);
  });

  it('distinguishes invited, on-board-but-not-told, and not-added', () => {
    expect(JOBS_JS).toContain('>Invited<');
    expect(JOBS_JS).toContain('>Notify<');
    expect(JOBS_JS).toContain('notified: !!c.matched_at');
  });

  it('explains a failed invitation in plain words instead of going quiet', () => {
    expect(JOBS_JS).toContain('ADD_CAND_BLOCK_COPY');
    expect(JOBS_JS).toContain('no CV on file');
    expect(JOBS_JS).toContain('atsAddCandWarn');
    expect(JOBS_JS).toContain('On the board, but not invited.');
  });

  it('ships the modal styles', () => {
    const used = (JOBS_JS.match(/class="(ats-addcand[\w-]*)"/g) || []).map((m) => m.replace(/class="|"/g, ''));
    expect(used.length).toBeGreaterThan(2);
    used.forEach((cls) => expect(CSS).toContain('.' + cls));
    expect(CSS).toContain('.ats-addcand-warn');
  });

  it('bumps the assets it changed', () => {
    expect(CEO_HTML).toContain('/js/ceo-ats-jobs.js?v=20260805c');
    expect(CEO_HTML).not.toContain('/js/ceo-ats-jobs.js?v=20260805b');
    expect(CEO_HTML).toContain('/css/ceo-ats.css?v=20260829a');
    expect(CEO_HTML).not.toContain('/css/ceo-ats.css?v=20260805g');
  });
});

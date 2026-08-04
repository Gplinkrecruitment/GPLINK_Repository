// CEO Jobs board — "＋ Add candidate", with a search to find the doctor.
//
// Owner 2026-08-05: "i should be able to add a GP candidate (also insert
// search feature to search for gp to add)". The board had no way to put a
// doctor into a pipeline at all.
//
// The load-bearing property under test is that this is the QUIET path. It
// creates the board card and NOTHING else: no offer record, no practice
// reveal, no email. POST /api/ats/application (the drawer's "practice
// accepted" action) is the loud one, and the two must not converge.
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
const readDb = () => { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; } };

const SEED = {
  atsPractices: [
    { id: 'pr-1', name: 'Riverlink Medical & Dental Centre', location_city: 'North Ipswich', location_state: 'QLD', stage: 'active' }
  ],
  atsJobs: [
    { id: 'job-1', provider: 'internal_ats', provider_role_id: 'ats_job1', title: 'GP — Riverlink', practice_id: 'pr-1', practice_name: 'Riverlink Medical & Dental Centre', suburb: 'North Ipswich', location_city: 'North Ipswich', location_state: 'QLD', is_active: true, job_status: 'open', approval_status: 'approved', ats_created: true }
  ],
  atsApplications: [],
  atsCandidates: [
    { user_id: 'gp-aisha', case_id: 'case-1', name: 'Dr Aisha Khan', email: 'aisha@example.com', country: 'uk', stage: 'ahpra', status: 'active', apps: [] },
    { user_id: 'gp-tom', case_id: 'case-2', name: 'Dr Tom Reilly', email: 'tom@example.com', country: 'ie', stage: 'visa', status: 'active', apps: [] }
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
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

const add = (body) => req('POST', '/api/ats/job/candidate', { host: SUPER_HOST, cookie: superCookie(), body });

describe('POST /api/ats/job/candidate', () => {
  it('is staff-only', async () => {
    const r = await req('POST', '/api/ats/job/candidate', { host: SUPER_HOST, body: { user_id: 'gp-aisha', career_role_id: 'job-1' } });
    expect(r.status).toBe(401);
    expect(readDb().atsApplications.length).toBe(0); // nothing written
  });

  it('puts the doctor on the board at Shortlist', async () => {
    const r = await add({ user_id: 'gp-aisha', career_role_id: 'job-1', stage: 'shortlisted' });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.already).toBe(false);
    expect(b.application.ats_stage).toBe('shortlisted');

    const row = readDb().atsApplications.find((a) => a.user_id === 'gp-aisha');
    expect(row.career_role_id).toBe('job-1');
    expect(row.ats_stage).toBe('shortlisted');
    // `status` defaults to 'applied' in the schema and every GP-facing screen
    // reads it — leaving it would tell the doctor they applied for something
    // they have never seen.
    expect(row.status).toBe('shortlisted');
    expect(row.origin).toBe('admin_applied');
  });

  it('reaches nobody: no match metadata, no offer, no reveal', async () => {
    const row = readDb().atsApplications.find((a) => a.user_id === 'gp-aisha');
    // getPendingMatchForRole returns null without matched_at, so the doctor
    // never sees a match card; the match-lifecycle cron selects
    // matched_at=not.is.null, so no reminder or expiry email can fire.
    expect(row.matched_at == null).toBe(true);
    expect(row.match_expires_at == null).toBe(true);
    // Nobody has placed this doctor, so the practice stays masked.
    expect(row.revealed).not.toBe(true);
    // And no offer was recorded — that belongs to POST /api/ats/application.
    expect((readDb().atsOffers || []).length).toBe(0);
  });

  it('is idempotent — adding the same doctor twice does not duplicate the card', async () => {
    const r = await add({ user_id: 'gp-aisha', career_role_id: 'job-1' });
    expect(r.status).toBe(200);
    expect(parse(r.raw).already).toBe(true);
    expect(readDb().atsApplications.filter((a) => a.user_id === 'gp-aisha').length).toBe(1);
  });

  it('defaults to Shortlist when no stage is given', async () => {
    const r = await add({ user_id: 'gp-tom', career_role_id: 'job-1' });
    expect(r.status).toBe(200);
    expect(readDb().atsApplications.find((a) => a.user_id === 'gp-tom').ats_stage).toBe('shortlisted');
  });

  it('refuses stages that carry side effects of their own', async () => {
    // Offers, practice emails and interview invites belong to their own
    // endpoints — reaching those stages by "adding a candidate" would skip
    // every one of them.
    for (const stage of ['offer', 'hired', 'submitted', 'interview', 'reviewing']) {
      const r = await add({ user_id: 'gp-tom', career_role_id: 'job-1', stage });
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
    const cols = parse(r.raw).columns || [];
    const shortlist = cols.find((c) => c.key === 'shortlisted');
    expect(shortlist.cards.map((c) => c.user_id).sort()).toEqual(['gp-aisha', 'gp-tom']);
  });
});

describe('the quiet path stays quiet', () => {
  it('does not record an offer or send anything, unlike POST /api/ats/application', () => {
    const quiet = SERVER_SRC.slice(
      SERVER_SRC.indexOf("pathname === '/api/ats/job/candidate'"),
      SERVER_SRC.indexOf("pathname === '/api/ats/application' && req.method === 'POST'")
    );
    expect(quiet.length).toBeGreaterThan(200);
    expect(quiet).not.toContain('saveAtsOffer');
    expect(quiet).not.toContain('maybeSendInterviewBookingInvite');
    expect(quiet).not.toContain('sendMatchEmail');
    expect(quiet).not.toContain('revealed: true');
    // The one thing it DOES record beyond the row.
    expect(quiet).toContain('atsRecordStageEvent');
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
    // A stale response must never overwrite a newer keystroke's results.
    expect(JOBS_JS).toContain('if (q !== addCandQuery) return;');
  });

  it('posts to the quiet endpoint at Shortlist', () => {
    expect(JOBS_JS).toContain("A.api('/api/ats/job/candidate'");
    expect(JOBS_JS).toContain("stage: 'shortlisted'");
    expect(JOBS_JS).toContain('atsOpenJobBoard(currentBoardJobId)'); // repaint after adding
  });

  it('marks doctors already on the board instead of hiding them', () => {
    // Hiding them makes a searched-for name look like "not found".
    expect(JOBS_JS).toContain('function boardUserIds');
    expect(JOBS_JS).toContain('On this board');
    expect(JOBS_JS).toContain('is-on-board');
  });

  it('tells the consultant nothing is sent to the doctor', () => {
    expect(JOBS_JS).toMatch(/Nothing is sent to them/);
  });

  it('ships the modal styles', () => {
    ['ats-addcand-note', 'ats-addcand-results', 'ats-addcand-row', 'ats-addcand-name', 'ats-addcand-sub']
      .forEach((cls) => expect(CSS).toContain('.' + cls));
    // Every class the markup uses must actually exist in the stylesheet.
    const used = (JOBS_JS.match(/class="(ats-addcand[\w-]*)"/g) || []).map((m) => m.replace(/class="|"/g, ''));
    expect(used.length).toBeGreaterThan(2);
    used.forEach((cls) => expect(CSS).toContain('.' + cls));
  });

  it('bumps the assets it changed', () => {
    expect(CEO_HTML).toContain('/js/ceo-ats-jobs.js?v=20260805b');
    expect(CEO_HTML).not.toContain('/js/ceo-ats-jobs.js?v=20260805a');
    expect(CEO_HTML).toContain('/css/ceo-ats.css?v=20260805g');
    expect(CEO_HTML).not.toContain('/css/ceo-ats.css?v=20260805f');
  });
});

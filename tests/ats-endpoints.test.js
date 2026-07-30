// Endpoint tests for the in-app ATS (/api/ats/* and /api/ceo/candidate*).
// Boots the real server in LOCAL-JSON mode (SUPABASE_URL='') against the dev
// seed, so reads return seeded data and writes persist to the temp DB file.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ats-${RUN_ID}.json`);
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

// Outbound Resend sends captured by wrapping global fetch (D1a: the job
// approval now emails the practice a "your job is live" notice).
const resendCalls = [];
let realFetch;

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'ats-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  // Seed the local-JSON DB before the server loads it.
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-ats-dev.js')], { env: { ...process.env, DB_FILE_PATH: DB_FILE } });
  // Task 9 (practice-client pipeline): inject two pending-approval jobs (the
  // shape createPendingJobFromIntake writes — is_active:false until approved)
  // plus one job that already carries an https header image, so the approval
  // gate + reuse_url validation can be exercised hermetically.
  const seeded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  seeded.atsJobs = seeded.atsJobs || [];
  seeded.atsJobs.push(
    { id: 'jp1', provider: 'internal_ats', title: 'GP — Rangeville', masked_title: 'GP | Suburb of Toowoomba | Mixed billing', practice_name: 'Pipeline Practice One', practice_id: 'p1', location_city: 'Toowoomba', location_state: 'QLD', suburb: 'Rangeville', is_active: false, job_status: 'open', approval_status: 'pending', ats_created: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: 'jp2', provider: 'internal_ats', title: 'GP — Newtown', masked_title: 'GP | Suburb of Toowoomba | Private billing', practice_name: 'Pipeline Practice Two', practice_id: 'p2', location_city: 'Toowoomba', location_state: 'QLD', suburb: 'Newtown', is_active: false, job_status: 'open', approval_status: 'pending', ats_created: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: 'jh1', provider: 'internal_ats', title: 'GP — Kearneys Spring', masked_title: '', practice_name: 'Pipeline Practice Three', location_city: 'Toowoomba', location_state: 'QLD', suburb: 'Kearneys Spring', is_active: true, job_status: 'open', approval_status: 'approved', header_image_url: 'https://cdn.gplink-test.local/suburbs/kearneys-spring/1.png', ats_created: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  );
  // Owner request 2026-07-30: withdrawing an application from the CEO
  // dashboard must tell the doctor. Seeded here (a real user_id is what makes
  // notifyGpOfAtsStageChange fire — board-only cards without one are skipped).
  seeded.atsApplications = seeded.atsApplications || [];
  seeded.atsApplications.push({
    id: 'app-withdraw-1', user_id: 'gp-withdraw-1', case_id: 'case-withdraw-1',
    career_role_id: 'jh1', provider_role_id: 'ats_jh1', job_title: 'GP — Kearneys Spring',
    practice_name: 'Pipeline Practice Three', ats_stage: 'applied', status: 'applied',
    practice_submission_status: 'pending_va_submission',
    applied_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  seeded.userProfiles = seeded.userProfiles || [];
  seeded.userProfiles.push({ user_id: 'gp-withdraw-1', email: 'withdraw-gp@gplink-test.local', first_name: 'Withdrawn', last_name: 'Doctor' });
  fs.writeFileSync(DB_FILE, JSON.stringify(seeded, null, 2));

  process.env.RESEND_API_KEY = 'test-resend-key';
  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.resend.com/')) {
      let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
      resendCalls.push({ url: u, body: parsed });
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
    }
    return realFetch(url, opts);
  };

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('ATS jobs', () => {
  it('lists seeded jobs', async () => {
    const r = await req('GET', '/api/ats/jobs', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.jobs.length).toBe(8); // 5 seeded + 3 pipeline-approval rows injected in beforeAll (pending jobs are merged into the list for admins)
    const j1 = b.jobs.find((j) => j.id === 'j1');
    expect(j1.practice_name).toBe('Greenslopes Family Medical');
    expect(j1.active_count).toBeGreaterThan(0);
  });
  it('surfaces pending-approval jobs at the TOP so a signed practice is not buried', async () => {
    // A freshly-signed practice's job lands as approval_status:'pending'. If it
    // sorts below every open job, the CEO cannot find the one job that needs
    // action — exactly the bug reported for Erina Medical Centre.
    const r = await req('GET', '/api/ats/jobs', { host: SUPER_HOST, cookie: superCookie() });
    const b = parse(r.raw);
    const pendingIds = b.jobs.filter((j) => j.approval_status === 'pending').map((j) => j.id);
    expect(pendingIds).toContain('jp1');
    expect(pendingIds).toContain('jp2');
    // Every pending job appears before every non-pending job.
    const firstNonPending = b.jobs.findIndex((j) => j.approval_status !== 'pending');
    const lastPending = b.jobs.map((j) => j.approval_status).lastIndexOf('pending');
    expect(lastPending).toBeLessThan(firstNonPending);
    expect(b.pending_count).toBe(pendingIds.length);
  });
  it('rejects an unknown host', async () => {
    const r = await req('GET', '/api/ats/jobs', { host: 'evil.example.com', cookie: superCookie() });
    expect([302, 401, 403, 404]).toContain(r.status);
  });
  it('creates a native job', async () => {
    const r = await req('POST', '/api/ats/jobs', { host: SUPER_HOST, cookie: superCookie(), body: { title: 'GP — Test Role', practice_id: 'p1', city: 'Cairns', state: 'QLD', type: 'Locum', billing: 'Mixed billing' } });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.job.title).toBe('GP — Test Role');
    expect(b.job.practice_name).toBe('Greenslopes Family Medical');
  });
});

describe('ATS pipeline', () => {
  it('returns columns for a job', async () => {
    const r = await req('GET', '/api/ats/job/pipeline?id=j1', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.columns.length).toBe(8); // 7 stages (incl. shortlisted) + not_proceeding
    const applied = b.columns.find((c) => c.key === 'applied');
    expect(applied.cards.some((c) => c.name === 'Dr Aisha Khan')).toBe(true);
  });
  it('moves an application stage and persists', async () => {
    const r = await req('PATCH', '/api/ats/application?id=c1', { host: SUPER_HOST, cookie: superCookie(), body: { stage: 'submitted' } });
    expect(r.status).toBe(200);
    expect(parse(r.raw).application.ats_stage).toBe('submitted');
    const after = await req('GET', '/api/ats/job/pipeline?id=j1', { host: SUPER_HOST, cookie: superCookie() });
    const cols = parse(after.raw).columns;
    const submitted = cols.find((c) => c.key === 'submitted');
    expect(submitted.cards.some((c) => c.id === 'c1')).toBe(true);
  });
  it('rejects an invalid stage', async () => {
    const r = await req('PATCH', '/api/ats/application?id=c2', { host: SUPER_HOST, cookie: superCookie(), body: { stage: 'banana' } });
    expect(r.status).toBe(400);
  });
});

describe('ATS practices', () => {
  it('lists seeded practices with counts', async () => {
    const r = await req('GET', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie() });
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.practices.length).toBeGreaterThanOrEqual(5);
    const g = b.practices.find((p) => p.id === 'p1');
    expect(g.job_count).toBeGreaterThanOrEqual(1);
  });
  it('opening a practice shows all its jobs + candidates', async () => {
    const list = await req('GET', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie() });
    const greenslopes = parse(list.raw).practices.find((p) => p.name === 'Greenslopes Family Medical');
    expect(greenslopes.job_count).toBeGreaterThanOrEqual(1);
    const r = await req('GET', '/api/ats/practice?id=' + encodeURIComponent(greenslopes.id), { host: SUPER_HOST, cookie: superCookie() });
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.jobs.some((j) => j.title === 'General Practitioner — VR')).toBe(true);
    expect(b.candidates.length).toBeGreaterThanOrEqual(1);
  });
  it('derives a practice from job data even with no practices-table row', async () => {
    // a name-based id (practice that only exists as a name on a job) still resolves
    const id = 'name:' + encodeURIComponent('Greenslopes Family Medical');
    const r = await req('GET', '/api/ats/practice?id=' + encodeURIComponent(id), { host: SUPER_HOST, cookie: superCookie() });
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.jobs.length).toBeGreaterThanOrEqual(1);
  });
  it('creates and edits a practice', async () => {
    const c = await req('POST', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie(), body: { name: 'Test Clinic ' + RUN_ID, city: 'Darwin', state: 'NT' } });
    const created = parse(c.raw).practice;
    expect(created.name).toContain('Test Clinic');
    const e = await req('PATCH', '/api/ats/practice?id=' + created.id, { host: SUPER_HOST, cookie: superCookie(), body: { phone: '08 1111 2222' } });
    expect(parse(e.raw).practice.contact_phone).toBe('08 1111 2222');
  });
  it('a manually created practice defaults to stage prospective', async () => {
    // Regression: POST /api/ats/practices stored no stage at all, and the list
    // API normalizes a missing stage to 'active' — so an unsigned, never-
    // intaked practice rendered as an active "Mainstream Practice" client.
    const name = 'Fresh Prospect Clinic ' + RUN_ID;
    const c = await req('POST', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie(), body: { name, city: 'Cairns', state: 'QLD' } });
    expect(parse(c.raw).practice.stage).toBe('prospective');
    const list = parse((await req('GET', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie() })).raw).practices;
    expect(list.find((p) => p.name === name).stage).toBe('prospective');
  });
  it('an explicit valid stage on create is honored; an invalid one is rejected', async () => {
    const name = 'Already Active Clinic ' + RUN_ID;
    const c = await req('POST', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie(), body: { name, city: 'Mackay', state: 'QLD', stage: 'active' } });
    expect(parse(c.raw).practice.stage).toBe('active');
    const list = parse((await req('GET', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie() })).raw).practices;
    expect(list.find((p) => p.name === name).stage).toBe('active');
    const bad = await req('POST', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie(), body: { name: 'Bad Stage Clinic ' + RUN_ID, stage: 'banana' } });
    expect(bad.status).toBe(400);
  });
  it('renaming a practice carries its jobs with it — no orphaned old-name card', async () => {
    // Regression: the directory groups jobs by practice_name. Renaming the row
    // used to leave the jobs grouped under the OLD name as a duplicate card,
    // while the renamed row showed zero jobs (agreement/contract detached).
    const oldName = 'Rename Cascade ' + RUN_ID;
    const newName = 'Renamed Cascade ' + RUN_ID;
    const c = await req('POST', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie(), body: { name: oldName, city: 'Perth', state: 'WA' } });
    const created = parse(c.raw).practice;
    const j = await req('POST', '/api/ats/jobs', { host: SUPER_HOST, cookie: superCookie(), body: { title: 'GP — Rename Test ' + RUN_ID, practice_id: created.id, city: 'Perth', state: 'WA', type: 'Locum', billing: 'Mixed billing' } });
    expect(parse(j.raw).job.practice_name).toBe(oldName);

    // Before rename: one card under the old name with the job.
    let list = parse((await req('GET', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie() })).raw).practices;
    expect(list.find((p) => p.name === oldName).job_count).toBeGreaterThanOrEqual(1);

    // Rename it.
    const e = await req('PATCH', '/api/ats/practice?id=' + created.id, { host: SUPER_HOST, cookie: superCookie(), body: { name: newName } });
    expect(parse(e.raw).practice.name).toBe(newName);

    // After rename: the job moved to the new-name card, and the old name is gone.
    list = parse((await req('GET', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie() })).raw).practices;
    const renamed = list.find((p) => p.name === newName);
    expect(renamed).toBeTruthy();
    expect(renamed.job_count).toBeGreaterThanOrEqual(1);
    expect(list.find((p) => p.name === oldName)).toBeFalsy();
  });
});

describe('Candidates + intent', () => {
  it('lists candidates sorted by intent desc with real scores', async () => {
    const r = await req('GET', '/api/ceo/candidates', { host: SUPER_HOST, cookie: superCookie() });
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.candidates.length).toBe(13);
    // sorted desc
    for (let i = 1; i < b.candidates.length; i++) {
      expect(b.candidates[i - 1].intent_score).toBeGreaterThanOrEqual(b.candidates[i].intent_score);
    }
    // Yuki (g1) is the star candidate → Hot
    const g1 = b.candidates.find((c) => c.case_id === 'g1');
    expect(g1.intent_band).toBe('hot');
    expect(g1.intent_score).toBeGreaterThanOrEqual(70);
  });
  it('filters by intent band', async () => {
    const r = await req('GET', '/api/ceo/candidates?band=cold', { host: SUPER_HOST, cookie: superCookie() });
    const b = parse(r.raw);
    expect(b.candidates.every((c) => c.intent_band === 'cold')).toBe(true);
  });
  it('returns a full candidate profile with intent breakdown + rail', async () => {
    const r = await req('GET', '/api/ceo/candidate?case_id=g13', { host: SUPER_HOST, cookie: superCookie() });
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.candidate.name).toBe('Dr Sana Mehta');
    expect(b.candidate.intent.signals.length).toBe(7);
    expect(b.candidate.blocked).toBe(true); // 14 days blocked at AHPRA
    expect(Array.isArray(b.candidate.rail)).toBe(true);
    expect(b.candidate.apps.length).toBeGreaterThanOrEqual(0);
  });
  it('recompute-intent returns a score', async () => {
    const r = await req('POST', '/api/ceo/candidate/recompute-intent?case_id=g1', { host: SUPER_HOST, cookie: superCookie() });
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(typeof b.intent_score).toBe('number');
  });
});

describe('pipeline summary + movement', () => {
  // No 'not_proceeding' bucket: a GP with only terminal applications reads as
  // 'unassociated' instead (see lib/ats-practices.js bucketForApps).
  const BUCKET_ORDER = ['unassociated', 'shortlisted', 'applied', 'submitted', 'reviewing', 'interview', 'offer', 'hired'];
  const getSummary = async () => parse((await req('GET', '/api/ceo/pipeline-summary', { host: SUPER_HOST, cookie: superCookie() })).raw);
  const getBucket = async (key) => parse((await req('GET', '/api/ceo/candidates?ats_bucket=' + key, { host: SUPER_HOST, cookie: superCookie() })).raw);

  it('partitions the candidate universe into 8 ordered buckets that sum to total', async () => {
    const r = await req('GET', '/api/ceo/pipeline-summary', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.buckets.length).toBe(8);
    expect(b.buckets.map((x) => x.key)).toEqual(BUCKET_ORDER);
    expect(typeof b.total).toBe('number');
    // Key invariant: the buckets partition the candidate universe.
    expect(b.buckets.reduce((s, x) => s + x.count, 0)).toBe(b.total);
    expect(b.total).toBe(13);
  });

  it('candidates?ats_bucket=unassociated matches the summary and tags every row', async () => {
    const sum = await getSummary();
    const unCount = sum.buckets.find((x) => x.key === 'unassociated').count;
    const b = await getBucket('unassociated');
    expect(b.ok).toBe(true);
    expect(b.candidates.every((c) => c.pipeline_bucket === 'unassociated')).toBe(true);
    expect(b.candidates.length).toBe(unCount);
  });

  it('adds an unassociated candidate to a job, moving them out of unassociated (idempotently)', async () => {
    // Pick a candidate that is unassociated right now (read live state, do not hardcode).
    const before = await getBucket('unassociated');
    expect(before.candidates.length).toBeGreaterThan(0);
    const userId = before.candidates[0].user_id;
    const totalBefore = (await getSummary()).total;

    const post = await req('POST', '/api/ats/application', { host: SUPER_HOST, cookie: superCookie(), body: { user_id: userId, career_role_id: 'j1' } });
    expect(post.status).toBe(200);
    const pb = parse(post.raw);
    expect(pb.ok).toBe(true);
    expect(pb.already).toBe(false);
    expect(pb.application.ats_stage).toBe('applied');
    expect(String(pb.application.user_id)).toBe(String(userId));
    expect(typeof pb.job_title).toBe('string');
    expect(pb.job_title.length).toBeGreaterThan(0);

    // The candidate is no longer unassociated, and the universe total is unchanged.
    const after = await getBucket('unassociated');
    expect(after.candidates.some((c) => String(c.user_id) === String(userId))).toBe(false);
    const summaryAfter = await getSummary();
    expect(summaryAfter.total).toBe(totalBefore);
    expect(summaryAfter.buckets.reduce((s, x) => s + x.count, 0)).toBe(summaryAfter.total);

    // Idempotent: re-POSTing the same (job, user) pairing returns already:true.
    const again = await req('POST', '/api/ats/application', { host: SUPER_HOST, cookie: superCookie(), body: { user_id: userId, career_role_id: 'j1' } });
    expect(again.status).toBe(200);
    expect(parse(again.raw).already).toBe(true);
  });

  it('blocks pipeline-summary without a session', async () => {
    const r = await req('GET', '/api/ceo/pipeline-summary', { host: SUPER_HOST });
    expect([401, 403, 302]).toContain(r.status);
    expect(r.status).not.toBe(200);
  });
});

describe('Job approval — mandatory suburb header photo (Task 9)', () => {
  const ONE_PX_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const SVG_DATA_URL = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  const EXISTING_HTTPS = 'https://cdn.gplink-test.local/suburbs/kearneys-spring/1.png'; // jh1's header, injected in beforeAll

  it('pending jobs surface in /api/ats/jobs with approval_status pending', async () => {
    const r = await req('GET', '/api/ats/jobs', { host: SUPER_HOST, cookie: superCookie() });
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    const jp1 = b.jobs.find((j) => j.id === 'jp1');
    expect(jp1).toBeTruthy();
    expect(jp1.approval_status).toBe('pending');
    expect(jp1.header_image_url).toBe('');
    expect(jp1.suburb).toBe('Rangeville');
    expect(b.jobs.find((j) => j.id === 'jp2').approval_status).toBe('pending');
  });

  it('approve without a header photo → 400 with the exact gate message', async () => {
    const r = await req('POST', '/api/ats/job/approve?id=jp1', { host: SUPER_HOST, cookie: superCookie(), body: { action: 'approve' } });
    expect(r.status).toBe(400);
    const b = parse(r.raw);
    expect(b.ok).toBe(false);
    expect(b.message).toBe('Upload a suburb header photo before approving');
  });

  it('rejects a non-image upload (svg data URL) on the upload path', async () => {
    const r = await req('POST', '/api/ats/job/header-image?id=jp1', { host: SUPER_HOST, cookie: superCookie(), body: { file_data: SVG_DATA_URL, file_name: 'sneaky.svg' } });
    expect(r.status).toBe(400);
    expect(parse(r.raw).ok).toBe(false);
  });

  it('uploads a PNG header image, then approve → approved + is_active + published_at', async () => {
    const up = await req('POST', '/api/ats/job/header-image?id=jp1', { host: SUPER_HOST, cookie: superCookie(), body: { file_data: ONE_PX_PNG, file_name: 'suburb.png' } });
    expect(up.status).toBe(200);
    const ub = parse(up.raw);
    expect(ub.ok).toBe(true);
    expect(ub.url).toBe(ONE_PX_PNG); // local mode stores the data URL itself

    const beforeEmails = resendCalls.length;
    const ap = await req('POST', '/api/ats/job/approve?id=jp1', { host: SUPER_HOST, cookie: superCookie(), body: { action: 'approve' } });
    expect(ap.status).toBe(200);
    const ab = parse(ap.raw);
    expect(ab.ok).toBe(true);
    expect(ab.job.approval_status).toBe('approved');

    const raw = parse((await req('GET', '/api/ats/job?id=jp1', { host: SUPER_HOST, cookie: superCookie() })).raw).raw;
    expect(raw.is_active).toBe(true);
    expect(raw.approval_status).toBe('approved');
    expect(typeof raw.published_at).toBe('string');
    expect(raw.published_at.length).toBeGreaterThan(0);

    // D1a: approval emails the practice contact a "your job is live" notice
    // (jp1 → practice p1 → admin@greenslopesfm.com.au in the dev seed).
    const sends = resendCalls.slice(beforeEmails);
    const liveMail = sends.find((c) => {
      const to = c.body && c.body.to;
      return (Array.isArray(to) ? to : [to]).some((t) => String(t || '').includes('admin@greenslopesfm.com.au'));
    });
    expect(liveMail).toBeTruthy();
    expect(String(liveMail.body.subject)).toContain('Your job is live');
    expect(String(liveMail.body.subject)).toContain('GP — Rangeville');
    expect(String(liveMail.body.html)).toContain('now live to eligible doctors');
    expect(String(liveMail.body.html)).toContain('What happens next');
    // D2: the job-live email links the bookmarkable practice status page,
    // authed by the practice's intake token (generated + persisted on the
    // fly here — the dev-seeded p1 row has no token of its own).
    expect(String(liveMail.body.html)).toContain('Track your listing');
    expect(String(liveMail.body.html)).toContain('/pages/practice-status?token=');
    expect(String(liveMail.body.text)).toContain('/pages/practice-status?token=');
    const p1Row = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).atsPractices.find((p) => p.id === 'p1');
    const p1Token = p1Row && (p1Row.intake_token || (p1Row.metadata && p1Row.metadata.intake_token));
    expect(String(p1Token || '').length).toBeGreaterThanOrEqual(16);
    expect(String(liveMail.body.html)).toContain('/pages/practice-status?token=' + encodeURIComponent(p1Token));
  });

  it('approve on a non-pending job → 409', async () => {
    const r = await req('POST', '/api/ats/job/approve?id=jp1', { host: SUPER_HOST, cookie: superCookie(), body: { action: 'approve' } });
    expect(r.status).toBe(409);
    expect(parse(r.raw).ok).toBe(false);
  });

  it('suburb-images lists existing header images, deduped, with suburb labels', async () => {
    const r = await req('GET', '/api/ats/suburb-images', { host: SUPER_HOST, cookie: superCookie() });
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    const urls = b.images.map((im) => im.url);
    expect(urls).toContain(EXISTING_HTTPS);
    expect(urls).toContain(ONE_PX_PNG); // jp1's fresh upload
    expect(new Set(urls).size).toBe(urls.length); // unique by url
    expect(b.images.find((im) => im.url === EXISTING_HTTPS).suburb).toBe('Kearneys Spring');
  });

  it('reuse_url rejects an svg data URL (not on the image mime whitelist)', async () => {
    const r = await req('POST', '/api/ats/job/header-image?id=jp2', { host: SUPER_HOST, cookie: superCookie(), body: { reuse_url: SVG_DATA_URL } });
    expect(r.status).toBe(400);
    expect(parse(r.raw).ok).toBe(false);
  });

  it('reuse_url rejects an arbitrary https URL that is no job\'s header image', async () => {
    const r = await req('POST', '/api/ats/job/header-image?id=jp2', { host: SUPER_HOST, cookie: superCookie(), body: { reuse_url: 'https://evil.example.com/not-ours.png' } });
    expect(r.status).toBe(400);
    const b = parse(r.raw);
    expect(b.ok).toBe(false);
    expect(b.message).toBe('reuse_url must be an existing header image');
  });

  it('reuse_url accepts an https URL that IS an existing header image', async () => {
    const r = await req('POST', '/api/ats/job/header-image?id=jp2', { host: SUPER_HOST, cookie: superCookie(), body: { reuse_url: EXISTING_HTTPS } });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.url).toBe(EXISTING_HTTPS);
  });

  it('reject → approval_status rejected + is_active false (and NO practice email)', async () => {
    const beforeEmails = resendCalls.length;
    const r = await req('POST', '/api/ats/job/approve?id=jp2', { host: SUPER_HOST, cookie: superCookie(), body: { action: 'reject' } });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.job.approval_status).toBe('rejected');
    const raw = parse((await req('GET', '/api/ats/job?id=jp2', { host: SUPER_HOST, cookie: superCookie() })).raw).raw;
    expect(raw.is_active).toBe(false);
    expect(raw.approval_status).toBe('rejected');
    // D1a: the "job is live" email is approve-only — a rejection sends nothing.
    expect(resendCalls.length).toBe(beforeEmails);
  });

  it('blocks the approval endpoints without a session', async () => {
    const r = await req('POST', '/api/ats/job/approve?id=jp1', { host: SUPER_HOST, body: { action: 'approve' } });
    expect([401, 403, 302]).toContain(r.status);
    const r2 = await req('POST', '/api/ats/job/header-image?id=jp1', { host: SUPER_HOST, body: { file_data: ONE_PX_PNG } });
    expect([401, 403, 302]).toContain(r2.status);
  });
});

describe('Auth', () => {
  it('blocks without a session', async () => {
    const r = await req('GET', '/api/ats/jobs', { host: SUPER_HOST });
    expect([401, 403, 302]).toContain(r.status);
  });
});

// Owner request 2026-07-30: "ensure if withdraw is clicked by admin it sends
// the rejection flow and email to the candidate". Withdraw (the queue button
// and the in-application one added the same day) is a PATCH to
// not_proceeding, which must reach notifyGpOfAtsStageChange — in-app update,
// push AND a gently worded email.
//
// HONEST LIMIT, do not "fix" by loosening: every doctor-notification channel
// (getGpEmailContext, pushCareerNotificationToUser) early-returns unless
// Supabase is configured, and this suite runs in LOCAL-JSON mode. So the
// delivery itself CANNOT be observed here — asserting on resendCalls would
// only ever prove the harness, not the product. What is verified here is the
// half that local mode owns (the stage move + the recorded reason), plus the
// wiring that carries it into the notifier. The notifier's own copy and
// delivery are covered in tests/ats-stage-automation.test.js.
describe('Withdrawing an application closes it and hands off to the GP notifier', () => {
  it('PATCH stage=not_proceeding moves the stage and records the withdraw reason', async () => {
    const r = await req('PATCH', '/api/ats/application?id=app-withdraw-1', {
      host: SUPER_HOST, cookie: superCookie(), body: { stage: 'not_proceeding', reason: 'gp_withdrew' }
    });
    expect(r.status).toBe(200);
    expect(parse(r.raw).ok).toBe(true);

    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const row = (db.atsApplications || []).find((a) => a.id === 'app-withdraw-1');
    expect(row.ats_stage).toBe('not_proceeding');

    const ev = (db.atsStageAudit || []).filter((e) => e.application_id === 'app-withdraw-1').pop();
    expect(ev).toBeTruthy();
    expect(ev.to_stage).toBe('not_proceeding');
    expect(ev.reason).toBe('gp_withdrew');
  });

  it('the PATCH handler still hands a not_proceeding move to the GP notifier', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    // not_proceeding must stay a notifying stage...
    expect(src).toMatch(/ATS_GP_NOTIFY_STAGES\s*=\s*\[[^\]]*'not_proceeding'/);
    // ...and the kanban/withdraw PATCH must keep calling the notifier. The
    // 'offer' exclusion is deliberate (a bare drag must not promise an offer);
    // nothing else may be added to it without breaking withdraw notifications.
    expect(src).toContain("if (updatedAP && newStage && newStage !== 'offer' && upAP.prevStage !== newStage) {");
    expect(src).toContain('notifyGpOfAtsStageChange(updatedAP, upAP.prevStage, newStage)');
  });

  it('the CEO dashboard offers Withdraw inside the application, not just in the queue', () => {
    const js = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-candidates.js'), 'utf8');
    // Owner request 2026-07-30 (third pass): the actions live on an always-
    // visible strip in the card — on the application card AND the list row.
    expect(js).toContain('function appActionStripHtml');
    expect(js).toContain('ats-strip-withdraw');
    expect(js).toContain('function withdrawFromDrawer');
    // Same endpoint + same reason vocabulary as the queue button, so both
    // routes write the same stage event and the same strike data.
    expect(js).toMatch(/withdrawFromDrawer[\s\S]{0,600}openWithdrawReasonPrompt/);
    expect(js).toMatch(/withdrawFromDrawer[\s\S]{0,900}stage: 'not_proceeding'/);
  });
});

// Owner report 2026-07-30: the ops "new application" email linked to
// app.mygplink.com.au/pages/ceo-dashboard, which 404s — the dashboard is
// served ONLY on the super-admin host scope. Every deep link into it must be
// built from that host, never from APP_BASE_URL (the doctor-facing origin).
describe('Ops deep links point at the CEO dashboard host, not the doctor app', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  it('no ceo-dashboard link is built from APP_BASE_URL', () => {
    expect(src).not.toContain("APP_BASE_URL + '/pages/ceo-dashboard");
  });

  it('the super-admin base URL comes from SUPER_ADMIN_ALLOWED_HOSTS', () => {
    expect(src).toContain('function getSuperAdminBaseUrl()');
    expect(src).toMatch(/getSuperAdminBaseUrl[\s\S]{0,400}SUPER_ADMIN_ALLOWED_HOSTS/);
  });

  it('the applied/accepted ops email names the next action and carries a CTA', () => {
    expect(src).toContain("accepted the match — submit to ");
    expect(src).toContain('Open candidate & submit to practice');
    // buildCeoCandidateUrl is what makes the CTA land on the right candidate.
    expect(src).toContain('function buildCeoCandidateUrl(caseId)');
  });
});

// The per-application action strip (owner request 2026-07-30, "option D",
// reconfirmed 2026-07-31 over a second attempt to make it a dropdown).
// Every action is visible in the card, not behind a 3-dot — a full-width
// tinted band across the bottom of the candidate card.
//
// The 2026-07-31 correction: the band was rendering for every application in
// live_apps, so hired doctors carried a full action bar with nothing left to
// action. The band exists to SUBMIT a doctor to the practice, so on the list
// it now appears only while that is still pending.
describe('The per-application action strip', () => {
  const js = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-candidates.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'css/ceo-ats.css'), 'utf8');
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  it('has no dropdown left — every action is on the card', () => {
    expect(js).not.toContain('ats-menu-pop');
    expect(js).not.toContain('openActionMenu');
    expect(js).not.toContain('ats-row-menu');
    expect(css).not.toContain('.ats-menu-pop');
  });

  it('renders the strip on the list and in the drawer, from one builder', () => {
    expect(js).toContain('function appActionStripHtml');
    // list card
    expect(js).toMatch(/c\.live_apps \|\| \[\]\)\.filter\(isSubmitEligible\)\.map\(appActionStripHtml\)/);
    // drawer application card — same builder, so they cannot drift
    expect(js).toMatch(/markPlacementLineHtml\(a\) \+\s*\n\s*appActionStripHtml\(a\)/);
  });

  // THE 2026-07-31 fix. A list card carries a band only while the doctor is
  // still waiting to go out to the practice; submit them and it disappears.
  it('puts the list strip ONLY on applications still waiting to be submitted', () => {
    expect(js).toContain('function isSubmitEligible');
    const fn = js.slice(js.indexOf('function isSubmitEligible'), js.indexOf('var STRIP_STAGE_TONE'));
    expect(fn).toContain('isWithdrawn(a)');
    expect(fn).toContain('SUBMISSION_STATUS_LABELS[a.practice_submission_status');
    expect(fn).toContain('SUBMIT_ELIGIBLE_STAGES.indexOf(a.ats_stage)');
    // The eligible lanes are deliberate — a doctor at interview has already
    // been through the practice, so there is nothing left to submit. 'hired'
    // is absent, which is what keeps a hired doctor's card clean.
    expect(js).toContain("var SUBMIT_ELIGIBLE_STAGES = ['applied', 'submitted', 'reviewing'];");
    // the builder reuses the same predicate, so the button and the band that
    // carries it can never disagree about eligibility
    expect(js).toContain('var submitEligible = isSubmitEligible(a);');
  });

  // The list card and the Jobs-tab kanban drag card share the class name
  // `.ats-cand-card`. An unscoped rule for one silently restyles the other,
  // and the kanban rule brings padding + a margin that stop the band reaching
  // the card's edges.
  it('scopes the card styling to the list so the kanban card is untouched', () => {
    expect(css).toContain('.ats-cand-table .ats-cand-card');
    expect(css).not.toMatch(/\n\.ats-cand-card \{[^}]*overflow:hidden/);
    const scoped = css.slice(css.indexOf('.ats-cand-table .ats-cand-card {'));
    expect(scoped).toMatch(/padding:0; margin-bottom:0/);
  });

  it('names the application it acts on, so Withdraw is never a guess', () => {
    const fn = js.slice(js.indexOf('function appActionStripHtml'), js.indexOf('function submitPracticeLineHtml'));
    expect(fn).toContain('a.job_title');
    expect(fn).toContain('a.practice_name');
    expect(fn).toContain('cr-strip-job');
  });

  it('sends "Practice listing" to the job on THIS dashboard and "Job board" to the public site', () => {
    // Owner call 2026-07-30 — these read backwards until you know the intent,
    // so they are pinned here deliberately. Do not "correct" them.
    const h = js.slice(js.indexOf('function handleStripClick'), js.indexOf('var STRIP_STAGE_TONE'));
    expect(h).toMatch(/ats-strip-joblisting[\s\S]{0,320}atsOpenJobBoard\(jobId\)/);
    expect(h).toMatch(/ats-strip-public[\s\S]{0,200}window\.open\(url/);
    // the public URL is built server-side, never guessed in the browser
    expect(srv).toContain('public_url: jobId ? buildPublicJobUrl({ id: jobId })');
  });

  it('the candidates list carries the applications the strip needs', () => {
    expect(srv).toContain('function atsCandidateLiveApps');
    expect(srv).toContain('live_apps: atsCandidateLiveApps(facts.apps)');
    // Prod resolves job titles with ONE bulk read for the page, never per row.
    expect(srv).toMatch(/liveRoleList\.length[\s\S]{0,300}career_roles/);
    expect(srv).toContain('r.live_apps = atsCandidateLiveApps(byUser2[r.user_id], liveRoleMap);');
  });

  it('drops terminal applications and caps how many strips a card can grow', () => {
    const fn = srv.slice(srv.indexOf('function atsCandidateLiveApps'), srv.indexOf('function buildCareerLockAdminView'));
    expect(fn).toContain("=== 'withdrawn'");
    expect(fn).toContain("a.ats_stage !== 'not_proceeding'");
    expect(fn).toContain('.slice(0, 3)');
  });

  it('keeps Withdraw visually last and flagged', () => {
    const fn = js.slice(js.indexOf('function appActionStripHtml'), js.indexOf('function submitPracticeLineHtml'));
    expect(fn).toContain('ats-danger-ghost');
    expect(fn.indexOf('ats-strip-public')).toBeLessThan(fn.indexOf('ats-strip-withdraw'));
    expect(css).toContain('.ats-danger-ghost');
  });

  // The regression that made this band look broken on the owner's screen: the
  // stylesheet gained the .cr-strip rules but the page still asked for the OLD
  // cache key, and sw.js treats a versioned .css as immutable — so browsers
  // painted the previous day's CSS over the new markup (no band, no gap, the
  // job title running into "Not scored"). Bumping only the JS key is the trap;
  // the existing pins assert the CURRENT value, so they cannot catch it.
  it('never lets the CSS cache key fall behind the JS one', () => {
    const html = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');
    const cssV = html.match(/ceo-ats\.css\?v=(\d{8})/);
    const jsV = html.match(/ceo-ats-candidates\.js\?v=(\d{8})/);
    expect(cssV).toBeTruthy();
    expect(jsV).toBeTruthy();
    expect(Number(cssV[1])).toBeGreaterThanOrEqual(Number(jsV[1]));
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME test for the whole delete → restore → purge lifecycle. The server is
// booted and driven over HTTP against a local JSON database, and the rows are
// read back off disk after every step. Source pins live in
// tests/practice-delete.test.js; this file proves the thing actually works.
//
// Boot + super-admin cookie minting follow tests/ceo-endpoints-smoke.test.js,
// with SUPABASE_URL left EMPTY so isSupabaseDbConfigured() is false and every
// read/write goes to the JSON db seeded below. Nothing leaves the machine, and
// email is deliberately unconfigured so the farewell send fails — which is
// itself an assertion (a dead mailer must never fail the delete).
//
// KNOWN local-mode divergence (pre-existing): atsListJobRows()'s Supabase
// branch filters is_active=true, the local-JSON branch does not. So the
// "practice disappeared" assertions here lean on the practices row being
// archived (which IS mode-independent) rather than on job filtering.
// ─────────────────────────────────────────────────────────────────────────────

const RUN_ID = crypto.randomBytes(4).toString('hex');
const SUPER_HOST = 'ceo-test.local';
const DB_PATH = `/tmp/gplink-practice-delete-${RUN_ID}.json`;
const CRON_SECRET = 'test-cron-secret-' + RUN_ID;

let server;
let addrPort;

const PRACTICE_ID = 'prac_erina_' + RUN_ID;
const JOB_LIVE_ID = 'job_live_' + RUN_ID;
const JOB_PENDING_ID = 'job_pending_' + RUN_ID;
const APP_ID = 'app_' + RUN_ID;
const PRACTICE_NAME = 'Erina Medical Centre ' + RUN_ID;

function request(method, path, { cookie, body, auth } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { Host: SUPER_HOST };
    if (cookie) headers.Cookie = cookie;
    if (auth) headers.Authorization = 'Bearer ' + auth;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = http.request({ host: '127.0.0.1', port: addrPort, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* leave null so failures show the raw body */ }
        resolve({ status: res.statusCode, raw, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function base64UrlEncode(input) {
  return Buffer.from(String(input), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function superCookie() {
  const payload = base64UrlEncode(JSON.stringify({
    userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' },
    expiresAt: Date.now() + 60 * 60 * 1000
  }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return `gp_admin_session=${encodeURIComponent(`${payload}.${sig}`)}`;
}

function readDb() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function practiceRow() {
  return readDb().atsPractices.find((p) => p.id === PRACTICE_ID);
}
function jobRow(id) {
  return readDb().atsJobs.find((j) => j.id === id);
}

function seed() {
  fs.writeFileSync(DB_PATH, JSON.stringify({
    atsPractices: [{
      id: PRACTICE_ID,
      name: PRACTICE_NAME,
      location_city: 'Central Coast', location_state: 'NSW',
      contact_name: 'Khaleed Mahmoud Ibanez',
      contact_email: 'practice-delete-test@example.invalid',
      secondary_contacts: [{ name: 'Reception', email: 'reception-delete-test@example.invalid' }],
      // Intake state that already lives in metadata — the archive MUST merge
      // into this, not overwrite it.
      metadata: { intake_token: 'tok_' + RUN_ID, intake: { address: '1 Test St' } },
      stage: 'active', org_type: 'practice', is_active: true
    }],
    atsJobs: [
      {
        id: JOB_LIVE_ID, practice_name: PRACTICE_NAME, practice_id: PRACTICE_ID,
        title: 'DPA - Erina (Central Coast) - Mixed Billing',
        location_city: 'Central Coast', location_state: 'NSW',
        is_active: true, job_status: 'open', approval_status: 'approved'
      },
      {
        id: JOB_PENDING_ID, practice_name: PRACTICE_NAME, practice_id: PRACTICE_ID,
        title: 'Second opening awaiting approval',
        location_city: 'Central Coast', location_state: 'NSW',
        is_active: false, job_status: 'open', approval_status: 'pending'
      }
    ],
    atsApplications: [{
      id: APP_ID, user_id: 'user_' + RUN_ID,
      career_role_id: JOB_LIVE_ID, practice_id: PRACTICE_ID,
      ats_stage: 'hired', status: 'hired'
    }]
  }, null, 2));
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-secret-practice-delete-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_PATH;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.CRON_SECRET = CRON_SECRET;
  delete process.env.PRACTICE_PURGE_DISABLED;
  delete process.env.RESEND_API_KEY;

  seed();

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); });
  });
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  try { fs.unlinkSync(DB_PATH); } catch { /* already gone */ }
});

describe('practice delete → restore → purge (runtime)', () => {
  it('requires a signed-in CEO', async () => {
    const r = await request('POST', '/api/ats/practice/delete', {
      body: { id: PRACTICE_ID, confirm_name: PRACTICE_NAME }
    });
    expect(r.status).toBe(401);
    expect(practiceRow()).toBeTruthy();
  });

  it('preview reports the real impact and the restore window', async () => {
    const r = await request('GET', `/api/ats/practice/delete-preview?id=${encodeURIComponent(PRACTICE_ID)}`, { cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.body.impact.job_count).toBe(2);
    expect(r.body.impact.public_job_count).toBe(1);
    expect(r.body.impact.placed_application_count).toBe(1);
    expect(r.body.retention.months).toBe(12);
    expect(new Date(r.body.retention.purge_after).getTime()).toBeGreaterThan(Date.now());
    expect(r.body.email.subject).toContain('Thank you from GP Link');
    expect(r.body.email.cc).toEqual(['reception-delete-test@example.invalid']);
    // Still a preview.
    expect(practiceRow().metadata.deleted).toBeUndefined();
  });

  it('refuses — and changes nothing — when the typed name does not match', async () => {
    const r = await request('POST', '/api/ats/practice/delete', {
      cookie: superCookie(), body: { id: PRACTICE_ID, confirm_name: 'Erina Medical' }
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('confirm_name_mismatch');
    expect(practiceRow().metadata.deleted).toBeUndefined();
    expect(jobRow(JOB_LIVE_ID).is_active).toBe(true);
  });

  it('deletes: archives the practice and closes its jobs, keeping the doctor intact', async () => {
    const r = await request('POST', '/api/ats/practice/delete', {
      cookie: superCookie(),
      body: { id: PRACTICE_ID, confirm_name: '  ERINA medical Centre ' + RUN_ID + '  ', send_email: true }
    });
    expect(r.status).toBe(200);
    expect(r.body.deleted.jobs_retired).toBe(2);
    expect(r.body.deleted.retention_months).toBe(12);

    const p = practiceRow();
    // The row SURVIVES — this is an archive, not a destruction.
    expect(p).toBeTruthy();
    expect(p.metadata.deleted).toBeTruthy();
    expect(p.metadata.deleted.restore.jobs).toHaveLength(2);
    expect(p.stage).toBe('archived');
    // …and the pre-existing metadata is still there (merge, not overwrite).
    expect(p.metadata.intake_token).toBe('tok_' + RUN_ID);
    expect(p.metadata.intake.address).toBe('1 Test St');

    // Both jobs closed — off the public board, out of the pending queue.
    expect(jobRow(JOB_LIVE_ID).is_active).toBe(false);
    expect(jobRow(JOB_LIVE_ID).job_status).toBe('closed');
    expect(jobRow(JOB_PENDING_ID).approval_status).toBe('rejected');
    // Both job rows still EXIST — they are only destroyed at purge time.
    expect(jobRow(JOB_LIVE_ID)).toBeTruthy();
    expect(jobRow(JOB_PENDING_ID)).toBeTruthy();

    // The placed doctor is untouched, still linked.
    const app = readDb().atsApplications.find((a) => a.id === APP_ID);
    expect(app.practice_id).toBe(PRACTICE_ID);
    expect(app.ats_stage).toBe('hired');

    // A dead mailer reports itself and does not fail the delete.
    expect(r.body.email.requested).toBe(true);
    expect(r.body.email.sent).toBe(false);
  });

  it('the archived practice is gone from the directory and its detail page', async () => {
    const list = await request('GET', '/api/ats/practices', { cookie: superCookie() });
    expect(list.status).toBe(200);
    expect(list.body.practices.some((p) => p.id === PRACTICE_ID)).toBe(false);
    expect(list.body.practices.some((p) => p.name === PRACTICE_NAME)).toBe(false);

    const detail = await request('GET', `/api/ats/practice?id=${encodeURIComponent(PRACTICE_ID)}`, { cookie: superCookie() });
    expect(detail.status).toBe(404);
  });

  it('but it IS in the deleted list, with a countdown', async () => {
    const r = await request('GET', '/api/ats/practices/deleted', { cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.body.retention_months).toBe(12);
    const row = r.body.practices.find((p) => p.id === PRACTICE_ID);
    expect(row).toBeTruthy();
    expect(row.job_count).toBe(2);
    expect(row.purge_due).toBe(false);
    // ~365 days, allowing for leap years and the clock ticking mid-test.
    expect(row.days_left).toBeGreaterThan(360);
    expect(row.days_left).toBeLessThanOrEqual(366);
  });

  it('the purge cron leaves it alone while the 12 months are still running', async () => {
    const r = await request('GET', '/api/cron/purge-practices', { auth: CRON_SECRET });
    expect(r.status).toBe(200);
    expect(r.body.due).toBe(0);
    expect(r.body.purged).toBe(0);
    expect(practiceRow()).toBeTruthy();
    expect(jobRow(JOB_LIVE_ID)).toBeTruthy();
  });

  it('restores the practice AND its job openings, exactly as they were', async () => {
    const r = await request('POST', '/api/ats/practice/restore', {
      cookie: superCookie(), body: { id: PRACTICE_ID }
    });
    expect(r.status).toBe(200);
    expect(r.body.restored.jobs_restored).toBe(2);
    expect(r.body.restored.stage).toBe('active');

    const p = practiceRow();
    expect(p.metadata.deleted).toBeUndefined();
    expect(p.stage).toBe('active');
    expect(p.is_active).toBe(true);
    // Untouched metadata survived the whole round trip.
    expect(p.metadata.intake_token).toBe('tok_' + RUN_ID);

    // Each job is back in the state it was in BEFORE the delete — including the
    // one that was already inactive/pending, which must NOT be promoted.
    const live = jobRow(JOB_LIVE_ID);
    expect(live.is_active).toBe(true);
    expect(live.job_status).toBe('open');
    expect(live.approval_status).toBe('approved');
    const pending = jobRow(JOB_PENDING_ID);
    expect(pending.is_active).toBe(false);
    expect(pending.job_status).toBe('open');
    expect(pending.approval_status).toBe('pending');
  });

  it('is back in the directory after the restore', async () => {
    const list = await request('GET', '/api/ats/practices', { cookie: superCookie() });
    expect(list.body.practices.some((p) => p.id === PRACTICE_ID)).toBe(true);
    const deleted = await request('GET', '/api/ats/practices/deleted', { cookie: superCookie() });
    expect(deleted.body.practices).toHaveLength(0);
  });

  it('refuses to restore something that is not deleted', async () => {
    const r = await request('POST', '/api/ats/practice/restore', {
      cookie: superCookie(), body: { id: PRACTICE_ID }
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('not_deleted');
  });

  it('purges for real once the window has expired — practice AND jobs gone', async () => {
    // Time-travel a year by shrinking the retention window to zero for this one
    // delete (PRACTICE_DELETE_RETENTION_MONTHS is read per request), so the
    // archive is immediately past its purge date. The server runs in THIS
    // process, so setting the env var here really does reach it.
    process.env.PRACTICE_DELETE_RETENTION_MONTHS = '0';
    await request('POST', '/api/ats/practice/delete', {
      cookie: superCookie(), body: { id: PRACTICE_ID, confirm_name: PRACTICE_NAME, send_email: false }
    });

    const listed = await request('GET', '/api/ats/practices/deleted', { cookie: superCookie() });
    expect(listed.status).toBe(200);
    expect(listed.body.practices.find((x) => x.id === PRACTICE_ID).purge_due).toBe(true);

    const r = await request('GET', '/api/cron/purge-practices', { auth: CRON_SECRET });
    delete process.env.PRACTICE_DELETE_RETENTION_MONTHS;
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(false);
    expect(r.body.due).toBe(1);
    expect(r.body.purged).toBe(1);
    expect(r.body.jobs_deleted).toBe(2);
    expect(r.body.applications_unlinked).toBe(1);

    const after = readDb();
    // Everything really is gone now.
    expect(after.atsPractices.find((x) => x.id === PRACTICE_ID)).toBeUndefined();
    expect(after.atsJobs.find((j) => j.id === JOB_LIVE_ID)).toBeUndefined();
    expect(after.atsJobs.find((j) => j.id === JOB_PENDING_ID)).toBeUndefined();
    // …except the doctor, who is unlinked but very much still on file with
    // their placement history intact.
    const app = after.atsApplications.find((a) => a.id === APP_ID);
    expect(app).toBeTruthy();
    expect(app.practice_id).toBeNull();
    expect(app.ats_stage).toBe('hired');
  });

  it('the purge cron is cron-secret gated', async () => {
    const r = await request('GET', '/api/cron/purge-practices', { auth: 'wrong-secret' });
    expect(r.status).toBe(401);
  });
});

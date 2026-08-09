import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME test for the practice delete flow — the handler is actually booted
// and called over HTTP, against the local JSON database, and the rows are read
// back off disk afterwards. Source pins live in tests/practice-delete.test.js;
// this file proves the thing works.
//
// Boot + super-admin cookie minting follow tests/ceo-endpoints-smoke.test.js,
// with one deliberate difference: SUPABASE_URL is left EMPTY so
// isSupabaseDbConfigured() is false and every read/write goes to the local
// JSON db we seed below. Nothing leaves the machine, and email is deliberately
// left unconfigured so the farewell send fails — which is itself the point of
// one of the assertions (a dead mailer must never fail the deletion).
//
// KNOWN local-mode divergence (pre-existing, not introduced here):
// atsListJobRows()'s Supabase branch filters is_active=true, but its local-JSON
// branch returns every job. So in prod a retired job disappears from the
// practices directory, while in local mode it does not. This test therefore
// asserts the DB state the endpoint writes (which is identical in both modes),
// not the directory listing.
// ─────────────────────────────────────────────────────────────────────────────

const RUN_ID = crypto.randomBytes(4).toString('hex');
const SUPER_HOST = 'ceo-test.local';
const DB_PATH = `/tmp/gplink-practice-delete-${RUN_ID}.json`;

let server;
let addrPort;

const PRACTICE_ID = 'prac_erina_' + RUN_ID;
const JOB_LIVE_ID = 'job_live_' + RUN_ID;
const JOB_PENDING_ID = 'job_pending_' + RUN_ID;
const APP_ID = 'app_' + RUN_ID;
const PRACTICE_NAME = 'Erina Medical Centre ' + RUN_ID;

function request(method, path, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { Host: SUPER_HOST };
    if (cookie) headers.Cookie = cookie;
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

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-secret-practice-delete-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  // Empty -> isSupabaseDbConfigured() false -> the local JSON db below is used.
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_PATH;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  // Deliberately NOT configuring Resend — the farewell send must fail softly.
  delete process.env.RESEND_API_KEY;

  fs.writeFileSync(DB_PATH, JSON.stringify({
    atsPractices: [{
      id: PRACTICE_ID,
      name: PRACTICE_NAME,
      location_city: 'Central Coast', location_state: 'NSW',
      contact_name: 'Khaleed Mahmoud Ibanez',
      contact_email: 'practice-delete-test@example.invalid',
      secondary_contacts: [{ name: 'Reception', email: 'reception-delete-test@example.invalid' }],
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

describe('practice delete — runtime', () => {
  it('requires a signed-in CEO', async () => {
    const r = await request('POST', '/api/ats/practice/delete', {
      body: { id: PRACTICE_ID, confirm_name: PRACTICE_NAME }
    });
    expect(r.status).toBe(401);
    // And nothing was touched.
    expect(readDb().atsPractices).toHaveLength(1);
  });

  it('preview reports the real impact before anything is deleted', async () => {
    const r = await request('GET', `/api/ats/practice/delete-preview?id=${encodeURIComponent(PRACTICE_ID)}`, { cookie: superCookie() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.practice.name).toBe(PRACTICE_NAME);
    // Both jobs count; only the approved+active one is publicly visible.
    expect(r.body.impact.job_count).toBe(2);
    expect(r.body.impact.public_job_count).toBe(1);
    expect(r.body.impact.application_count).toBe(1);
    expect(r.body.impact.active_application_count).toBe(1);
    // The seeded application is ats_stage 'hired', so it must be flagged as a
    // live placement, not merely "active".
    expect(r.body.impact.placed_application_count).toBe(1);
    // The letter is composed and previewable even though it cannot be sent here.
    expect(r.body.email.to).toBe('practice-delete-test@example.invalid');
    expect(r.body.email.cc).toEqual(['reception-delete-test@example.invalid']);
    expect(r.body.email.subject).toContain('Thank you from GP Link');
    expect(r.body.email.preview_text).toContain('If you find yourself needing a GP again');
    // No mailer configured in this test env.
    expect(r.body.email.available).toBe(false);
    expect(r.body.email.configured).toBe(false);
    // Still a preview — nothing deleted.
    expect(readDb().atsPractices).toHaveLength(1);
  });

  it('refuses — and changes nothing — when the typed name does not match', async () => {
    const r = await request('POST', '/api/ats/practice/delete', {
      cookie: superCookie(),
      body: { id: PRACTICE_ID, confirm_name: 'Erina Medical' }
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('confirm_name_mismatch');
    const db = readDb();
    expect(db.atsPractices).toHaveLength(1);
    expect(db.atsJobs.every((j) => j.job_status === 'open')).toBe(true);
    expect(db.atsApplications[0].practice_id).toBe(PRACTICE_ID);
  });

  it('404s an unknown practice', async () => {
    const r = await request('POST', '/api/ats/practice/delete', {
      cookie: superCookie(),
      body: { id: 'prac_does_not_exist', confirm_name: 'whatever' }
    });
    expect(r.status).toBe(404);
  });

  it('deletes the practice, retires its jobs and unlinks the application', async () => {
    const r = await request('POST', '/api/ats/practice/delete', {
      cookie: superCookie(),
      body: { id: PRACTICE_ID, confirm_name: '  ERINA medical Centre ' + RUN_ID + '  ', send_email: true }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.deleted.row_deleted).toBe(true);
    expect(r.body.deleted.jobs_retired).toBe(2);
    expect(r.body.deleted.applications_unlinked).toBe(1);

    const db = readDb();

    // The practice row is gone.
    expect(db.atsPractices.find((p) => p.id === PRACTICE_ID)).toBeUndefined();

    // Both jobs are retired: off the public board (is_active + open is the
    // board's filter) and out of the pending queue that also feeds the directory.
    const live = db.atsJobs.find((j) => j.id === JOB_LIVE_ID);
    const pending = db.atsJobs.find((j) => j.id === JOB_PENDING_ID);
    expect(live.is_active).toBe(false);
    expect(live.job_status).toBe('closed');
    expect(pending.is_active).toBe(false);
    expect(pending.job_status).toBe('closed');
    expect(pending.approval_status).toBe('rejected');
    // An already-approved job keeps its approval history.
    expect(live.approval_status).toBe('approved');

    // The candidate's application SURVIVES, merely unlinked. Deleting it would
    // have cascade-destroyed their interviews and contracts.
    const app = db.atsApplications.find((a) => a.id === APP_ID);
    expect(app).toBeTruthy();
    expect(app.practice_id).toBeNull();
    expect(app.ats_stage).toBe('hired');
  });

  it('reports the failed email without failing the delete', async () => {
    // Asserted from the previous call's response — the practice is already gone
    // by the time the mailer is touched, so an unconfigured mailer is reported,
    // never thrown.
    const r = await request('GET', `/api/ats/practice/delete-preview?id=${encodeURIComponent(PRACTICE_ID)}`, { cookie: superCookie() });
    expect(r.status).toBe(404); // really gone
  });

  it('the deleted practice no longer has a practices-table row behind it', async () => {
    const r = await request('GET', `/api/ats/practice?id=${encodeURIComponent(PRACTICE_ID)}`, { cookie: superCookie() });
    expect(r.status).toBe(404);
  });
});

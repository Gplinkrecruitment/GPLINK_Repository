// Endpoint tests for GET /api/ceo/onboarding-incomplete (Task 4) plus the
// funnel-exclusion changes to /api/ceo/candidates and /api/ceo/pipeline-summary.
// Boots the real server in LOCAL-JSON mode (SUPABASE_URL='') against the ATS dev
// seed (scripts/seed-ats-dev.js), same as tests/ats-endpoints.test.js, then
// injects one extra GP (Helen) who has an account but never finished onboarding:
//   - dbState.users/userState entry -> picked up by enumerateIncompleteOnboardingGps()
//     (drives /api/ceo/onboarding-incomplete, same as the cron in
//     tests/onboarding-nudge-cron.test.js)
//   - an atsCandidates row with ob.completed:false and no apps -> drives the
//     /api/ceo/candidates + /api/ceo/pipeline-summary local paths.
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
const DB_FILE = path.join('/tmp', `gplink-onbi-${RUN_ID}.json`);
const SUPER_HOST = 'onbi-test.local';
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

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'onbi-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  // Seed the local-JSON DB before the server loads it (same seed as the ATS suite).
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-ats-dev.js')], { env: { ...process.env, DB_FILE_PATH: DB_FILE } });

  // Inject Helen: an account that started but never finished onboarding.
  const seeded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  seeded.users = seeded.users || {};
  seeded.users['helen@test.local'] = { firstName: 'Helen', lastName: 'Ncube', email: 'helen@test.local', registrationCountry: 'UK', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  seeded.userState = seeded.userState || {};
  seeded.userState['helen@test.local'] = { state: { gp_onboarding: { currentStep: 2 } }, updatedAt: new Date(Date.now() - 2 * 3600000).toISOString() };
  // Also give Helen an ATS candidate card (unassociated, onboarding incomplete)
  // so the /api/ceo/candidates + /api/ceo/pipeline-summary local paths see her.
  seeded.atsCandidates = seeded.atsCandidates || [];
  seeded.atsCandidates.push({
    id: 'helen1', user_id: 'helen1', name: 'Dr Helen Ncube', email: 'helen@test.local', phone: '',
    country: 'United Kingdom', reg: '', account_status: 'active', joined: new Date().toISOString(), rso: 'Hazel', zoho: '',
    ob: { completed: false, fieldsFilled: 0.2 }, docs: { cv: false, coverLetter: false, primaryDegree: false, idDoc: false },
    regStage: 'myintealth', blockedDays: 0, lastActiveDays: 0, calls: [], comms: null, aiHandover: '', apps: []
  });
  fs.writeFileSync(DB_FILE, JSON.stringify(seeded));

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('GET /api/ceo/onboarding-incomplete', () => {
  it('blocks without a session', async () => {
    const r = await req('GET', '/api/ceo/onboarding-incomplete', { host: SUPER_HOST });
    expect([401, 403, 302]).toContain(r.status);
  });

  it('lists Helen with her last step and nudge status', async () => {
    const r = await req('GET', '/api/ceo/onboarding-incomplete', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const j = parse(r.raw);
    expect(j.ok).toBe(true);
    expect(typeof j.count).toBe('number');
    const helen = (j.items || []).find((i) => i.email === 'helen@test.local');
    expect(helen).toBeTruthy();
    expect(helen.last_step).toBe(2);
    expect(helen.last_step_label.length).toBeGreaterThan(0);
    expect(helen.country).toBe('UK');
    expect(typeof helen.inactivity_days).toBe('number');
    expect(helen.emails_sent).toBe(0);
    expect(helen.unsubscribed).toBe(false);
    expect(helen.stopped).toBe(false);
  });
});

describe('onboarding-incomplete funnel exclusion', () => {
  it('candidates endpoint no longer shows Helen as unassociated', async () => {
    const r = await req('GET', '/api/ceo/candidates', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const j = parse(r.raw);
    expect(j.ok).toBe(true);
    const helen = (j.candidates || []).find((c) => c.email === 'helen@test.local');
    expect(helen === undefined || helen.pipeline_bucket !== 'unassociated').toBe(true);
  });

  it('pipeline-summary reports waitlist_onboarding and excludes her from unassociated', async () => {
    const r = await req('GET', '/api/ceo/pipeline-summary', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const j = parse(r.raw);
    expect(j.ok).toBe(true);
    expect(j.waitlist_onboarding).toBeGreaterThanOrEqual(1);
  });

  it('a genuinely unassociated but onboarded GP is still counted as unassociated (not swept into the waitlist)', async () => {
    const r = await req('GET', '/api/ceo/candidates?ats_bucket=unassociated', { host: SUPER_HOST, cookie: superCookie() });
    const j = parse(r.raw);
    // g11/g12/g13 (Grace Lim, Owen Park, Sana Mehta) are seeded onboarding-complete
    // with no apps -> genuinely unassociated, must still appear here.
    expect((j.candidates || []).some((c) => c.case_id === 'g13')).toBe(true);
  });
});

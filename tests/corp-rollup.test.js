// Phase 6 I2 — corporation parent link + rollup view.
// practices.parent_corporation_id through the ATS practice endpoints:
// persistence + read-back (with the parent's display name), the corporation
// detail rollup (members + aggregates), and the write-path validation (only a
// corporation row can be a parent; a corporation itself never has one).
// Boots the real server in LOCAL-JSON mode against the dev seed (same pattern
// as tests/ats-practice-contract.test.js).
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
const DB_FILE = path.join('/tmp', `gplink-corprollup-${RUN_ID}.json`);
const SUPER_HOST = 'ats-test.local';
let server, port;

const CORP_A = 'corpA-' + RUN_ID;
const CORP_B = 'corpB-' + RUN_ID;
const MEMBER_1 = 'member1-' + RUN_ID;
const MEMBER_2 = 'member2-' + RUN_ID;
const LONER = 'loner-' + RUN_ID;

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function adminCookie(role) {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: role || 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function superCookie() { return adminCookie('super_admin'); }
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
  process.env.AUTH_SECRET = 'corprollup-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-ats-dev.js')], { env: { ...process.env, DB_FILE_PATH: DB_FILE } });
  const seeded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  seeded.atsPractices = seeded.atsPractices || [];
  const now = new Date().toISOString();
  const base = { location_country: 'Australia', source: 'internal_ats', is_active: true, created_at: now, updated_at: now };
  seeded.atsPractices.push(
    { ...base, id: CORP_A, name: 'ForHealth Test Group ' + RUN_ID, location_city: 'Sydney', location_state: 'NSW', org_type: 'corporation', stage: 'active' },
    { ...base, id: CORP_B, name: 'Second Test Group ' + RUN_ID, location_city: 'Perth', location_state: 'WA', org_type: 'corporation', stage: 'active' },
    { ...base, id: MEMBER_1, name: 'Member One Clinic ' + RUN_ID, location_city: 'Brisbane', location_state: 'QLD', org_type: 'practice', stage: 'active', agreement_status: 'signed' },
    { ...base, id: MEMBER_2, name: 'Member Two Clinic ' + RUN_ID, location_city: 'Cairns', location_state: 'QLD', org_type: 'practice', stage: 'prospective' },
    { ...base, id: LONER, name: 'Loner Clinic ' + RUN_ID, location_city: 'Hobart', location_state: 'TAS', org_type: 'practice', stage: 'active' }
  );
  // Live jobs attach to practices by name in atsListPracticesDerived — two on
  // Member One, one on Member Two, so the group rollup totals 3.
  seeded.atsJobs = seeded.atsJobs || [];
  const jobBase = { provider: 'internal_ats', is_active: true, job_status: 'open', approval_status: 'approved', ats_created: true, created_at: now, updated_at: now };
  seeded.atsJobs.push(
    { ...jobBase, id: 'jm1a-' + RUN_ID, title: 'GP — Member One A', practice_name: 'Member One Clinic ' + RUN_ID, location_city: 'Brisbane', location_state: 'QLD' },
    { ...jobBase, id: 'jm1b-' + RUN_ID, title: 'GP — Member One B', practice_name: 'Member One Clinic ' + RUN_ID, location_city: 'Brisbane', location_state: 'QLD' },
    { ...jobBase, id: 'jm2a-' + RUN_ID, title: 'GP — Member Two A', practice_name: 'Member Two Clinic ' + RUN_ID, location_city: 'Cairns', location_state: 'QLD' }
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

describe('parent link persistence + read-back', () => {
  it('PATCH sets parent_corporation_id and it comes back with the parent name', async () => {
    const e = await req('PATCH', '/api/ats/practice?id=' + MEMBER_1, { host: SUPER_HOST, cookie: superCookie(), body: { parent_corporation_id: CORP_A } });
    expect(e.status).toBe(200);
    expect(parse(e.raw).practice.parent_corporation_id).toBe(CORP_A);
    const d = await req('GET', '/api/ats/practice?id=' + MEMBER_1, { host: SUPER_HOST, cookie: superCookie() });
    const db = parse(d.raw);
    expect(db.ok).toBe(true);
    expect(db.practice.parent_corporation_id).toBe(CORP_A);
    expect(db.practice.parent_corporation_name).toBe('ForHealth Test Group ' + RUN_ID);
    // Non-corporation detail carries no rollup.
    expect(db.members).toBeNull();
    expect(db.rollup).toBeNull();
  });

  it('list cards carry parent_corporation_id + name for member practices', async () => {
    await req('PATCH', '/api/ats/practice?id=' + MEMBER_2, { host: SUPER_HOST, cookie: superCookie(), body: { parent_corporation_id: CORP_A } });
    const l = await req('GET', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie() });
    const cards = parse(l.raw).practices;
    const m1 = cards.find((p) => p.id === MEMBER_1);
    expect(m1.parent_corporation_id).toBe(CORP_A);
    expect(m1.parent_corporation_name).toBe('ForHealth Test Group ' + RUN_ID);
    const lone = cards.find((p) => p.id === LONER);
    expect(lone.parent_corporation_id).toBeNull();
    expect(lone.parent_corporation_name).toBe('');
  });

  it('POST create accepts a parent corporation and persists it', async () => {
    const c = await req('POST', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie(), body: { name: 'Created Member ' + RUN_ID, city: 'Darwin', state: 'NT', parent_corporation_id: CORP_B } });
    expect(c.status).toBe(200);
    const created = parse(c.raw).practice;
    expect(created.parent_corporation_id).toBe(CORP_B);
    const d = await req('GET', '/api/ats/practice?id=' + encodeURIComponent(created.id), { host: SUPER_HOST, cookie: superCookie() });
    expect(parse(d.raw).practice.parent_corporation_name).toBe('Second Test Group ' + RUN_ID);
  });

  it('clearing the link with an empty value persists null', async () => {
    const c = await req('POST', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie(), body: { name: 'Clearable Member ' + RUN_ID, parent_corporation_id: CORP_B } });
    const id = parse(c.raw).practice.id;
    const e = await req('PATCH', '/api/ats/practice?id=' + encodeURIComponent(id), { host: SUPER_HOST, cookie: superCookie(), body: { parent_corporation_id: '' } });
    expect(e.status).toBe(200);
    expect(parse(e.raw).practice.parent_corporation_id).toBeNull();
  });
});

describe('corporation rollup', () => {
  it('corporation detail returns member practices + aggregate counts', async () => {
    const d = await req('GET', '/api/ats/practice?id=' + CORP_A, { host: SUPER_HOST, cookie: superCookie() });
    const db = parse(d.raw);
    expect(db.ok).toBe(true);
    expect(db.practice.org_type).toBe('corporation');
    expect(Array.isArray(db.members)).toBe(true);
    expect(db.members.length).toBe(2);
    // Sorted by job count desc: Member One (2 jobs) then Member Two (1 job).
    expect(db.members[0].id).toBe(MEMBER_1);
    expect(db.members[0].name).toBe('Member One Clinic ' + RUN_ID);
    expect(db.members[0].job_count).toBe(2);
    expect(db.members[0].stage).toBe('active');
    expect(db.members[0].agreement_status).toBe('signed');
    expect(db.members[1].id).toBe(MEMBER_2);
    expect(db.members[1].job_count).toBe(1);
    expect(db.members[1].stage).toBe('prospective');
    expect(db.rollup).toEqual({ member_count: 2, total_jobs: 3 });
  });

  it('a corporation with no members returns an empty rollup, not an error', async () => {
    // CORP_B has one member from the create test above — make a fresh corp.
    const c = await req('POST', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie(), body: { name: 'Empty Group ' + RUN_ID, org_type: 'corporation' } });
    const id = parse(c.raw).practice.id;
    const d = await req('GET', '/api/ats/practice?id=' + encodeURIComponent(id), { host: SUPER_HOST, cookie: superCookie() });
    const db = parse(d.raw);
    expect(db.ok).toBe(true);
    expect(db.members).toEqual([]);
    expect(db.rollup).toEqual({ member_count: 0, total_jobs: 0 });
  });
});

describe('write-path validation', () => {
  it('rejects a non-corporation as parent (PATCH + POST)', async () => {
    const e = await req('PATCH', '/api/ats/practice?id=' + LONER, { host: SUPER_HOST, cookie: superCookie(), body: { parent_corporation_id: MEMBER_1 } });
    expect(e.status).toBe(400);
    const c = await req('POST', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie(), body: { name: 'Bad Parent ' + RUN_ID, parent_corporation_id: MEMBER_1 } });
    expect(c.status).toBe(400);
  });

  it('rejects an unknown parent id', async () => {
    const e = await req('PATCH', '/api/ats/practice?id=' + LONER, { host: SUPER_HOST, cookie: superCookie(), body: { parent_corporation_id: 'nope-' + RUN_ID } });
    expect(e.status).toBe(400);
  });

  it('a corporation cannot be given a parent (PATCH + POST)', async () => {
    const e = await req('PATCH', '/api/ats/practice?id=' + CORP_B, { host: SUPER_HOST, cookie: superCookie(), body: { parent_corporation_id: CORP_A } });
    expect(e.status).toBe(400);
    const c = await req('POST', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie(), body: { name: 'Bad Corp ' + RUN_ID, org_type: 'corporation', parent_corporation_id: CORP_A } });
    expect(c.status).toBe(400);
  });

  it('an organisation cannot be its own parent', async () => {
    const e = await req('PATCH', '/api/ats/practice?id=' + CORP_A, { host: SUPER_HOST, cookie: superCookie(), body: { parent_corporation_id: CORP_A } });
    expect(e.status).toBe(400);
  });

  it('re-typing a member practice to corporation clears its parent link', async () => {
    const c = await req('POST', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie(), body: { name: 'Promotable ' + RUN_ID, parent_corporation_id: CORP_B } });
    const id = parse(c.raw).practice.id;
    const e = await req('PATCH', '/api/ats/practice?id=' + encodeURIComponent(id), { host: SUPER_HOST, cookie: superCookie(), body: { org_type: 'corporation' } });
    expect(e.status).toBe(200);
    const saved = parse(e.raw).practice;
    expect(saved.org_type).toBe('corporation');
    expect(saved.parent_corporation_id).toBeNull();
  });
});

describe('auth', () => {
  it('blocks all three endpoints without a session', async () => {
    const l = await req('GET', '/api/ats/practices', { host: SUPER_HOST });
    expect([302, 401, 403, 404]).toContain(l.status);
    const d = await req('GET', '/api/ats/practice?id=' + CORP_A, { host: SUPER_HOST });
    expect([302, 401, 403, 404]).toContain(d.status);
    const e = await req('PATCH', '/api/ats/practice?id=' + MEMBER_1, { host: SUPER_HOST, body: { parent_corporation_id: CORP_A } });
    expect([302, 401, 403, 404]).toContain(e.status);
  });

  it('blocks a non-ATS admin role (no cross-tenant access)', async () => {
    const e = await req('PATCH', '/api/ats/practice?id=' + MEMBER_1, { host: SUPER_HOST, cookie: adminCookie('admin'), body: { parent_corporation_id: CORP_A } });
    expect([302, 401, 403]).toContain(e.status);
  });
});

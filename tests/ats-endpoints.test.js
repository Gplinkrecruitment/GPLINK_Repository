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
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('ATS jobs', () => {
  it('lists seeded jobs', async () => {
    const r = await req('GET', '/api/ats/jobs', { host: SUPER_HOST, cookie: superCookie() });
    expect(r.status).toBe(200);
    const b = parse(r.raw);
    expect(b.ok).toBe(true);
    expect(b.jobs.length).toBe(5);
    const j1 = b.jobs.find((j) => j.id === 'j1');
    expect(j1.practice_name).toBe('Greenslopes Family Medical');
    expect(j1.active_count).toBeGreaterThan(0);
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
    expect(b.columns.length).toBe(7); // 6 stages + not_proceeding
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
  it('creates and edits a practice', async () => {
    const c = await req('POST', '/api/ats/practices', { host: SUPER_HOST, cookie: superCookie(), body: { name: 'Test Clinic ' + RUN_ID, city: 'Darwin', state: 'NT' } });
    const created = parse(c.raw).practice;
    expect(created.name).toContain('Test Clinic');
    const e = await req('PATCH', '/api/ats/practice?id=' + created.id, { host: SUPER_HOST, cookie: superCookie(), body: { phone: '08 1111 2222' } });
    expect(parse(e.raw).practice.contact_phone).toBe('08 1111 2222');
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

describe('Auth', () => {
  it('blocks without a session', async () => {
    const r = await req('GET', '/api/ats/jobs', { host: SUPER_HOST });
    expect([401, 403, 302]).toContain(r.status);
  });
});

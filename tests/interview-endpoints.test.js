// TDD test file for Task 4: POST /api/ats/interview/request
// Mirrors the bootstrap pattern in tests/ats-endpoints.test.js.
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
const DB_FILE = path.join('/tmp', `gplink-int-${RUN_ID}.json`);
const SUPER_HOST = 'ats-test.local';
// c1 is seeded by scripts/seed-ats-dev.js (board row, career_role_id:'j1').
const SEED_APP_ID = 'c1';
let server, port;

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}

function httpReq(method, p, { host, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (host) headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject); r.end(data);
  });
}

const call = (method, p, body) => httpReq(method, p, { host: SUPER_HOST, cookie: superCookie(), body });
const callNoAuth = (method, p, body) => httpReq(method, p, { host: SUPER_HOST, body });
const readDb = () => { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; } };

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'int-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-ats-dev.js')], { env: { ...process.env, DB_FILE_PATH: DB_FILE } });
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('POST /api/ats/interview/request', () => {
  it('creates an interview row + marks practice requested', async () => {
    const res = await call('POST', '/api/ats/interview/request', { application_id: SEED_APP_ID });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const db = readDb();
    const row = (db.scheduledCalls || []).find((r) => r.id === res.body.interview_id);
    expect(row).toBeTruthy();
    expect(row.meeting_kind).toBe('interview');
    expect(row.application_id).toBe(SEED_APP_ID);
    expect(row.practice_availability_status).toBe('requested');
  });

  it('is idempotent — a second request returns already:true', async () => {
    // Row already exists from the first test; both calls should return already:true.
    const a = await call('POST', '/api/ats/interview/request', { application_id: SEED_APP_ID });
    const b = await call('POST', '/api/ats/interview/request', { application_id: SEED_APP_ID });
    expect(b.body.already).toBe(true);
  });

  it('rejects without an admin session', async () => {
    const res = await callNoAuth('POST', '/api/ats/interview/request', { application_id: SEED_APP_ID });
    expect(res.status).toBe(401);
  });
});

describe('ingestPracticeAvailabilityReply', () => {
  it('parses a practice reply into windows and marks received', async () => {
    // The interview row was created by the test above; fetch its id via the idempotent endpoint.
    const res = await call('POST', '/api/ats/interview/request', { application_id: SEED_APP_ID });
    expect(res.status).toBe(200);
    const id = res.body.interview_id;
    const mod = await import('../server.js');
    await mod.__testUtils.ingestPracticeAvailabilityReply(id, 'Thursday or Friday after 7pm works for us', '2026-07-01T00:00:00Z');
    const row = (readDb().scheduledCalls || []).find((r) => r.id === id);
    expect(row.practice_availability_status).toBe('received');
    expect(Array.isArray(row.practice_availability_windows)).toBe(true);
    expect(row.practice_availability_windows.length).toBeGreaterThanOrEqual(1);
  });
});

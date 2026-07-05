// Endpoint tests for GET /api/cron/onboarding-nudge (Task 3).
// Boots the real server in LOCAL-JSON mode (SUPABASE_URL='') against an empty
// temp DB file. No Supabase in this mode, so the cron must fully work off
// dbState.users / dbState.userState / dbState.onboardingReminders.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-onbcron-${RUN_ID}.json`);
let server, port;

function req(method, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const { host, cookie, body, headers } = opts;
    const data = body ? JSON.stringify(body) : null;
    const h = {};
    if (host) h.Host = host;
    if (cookie) h.Cookie = cookie;
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    Object.assign(h, headers || {});
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
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
  process.env.AUTH_SECRET = 'onbcron-test-secret-' + RUN_ID;
  process.env.CRON_SECRET = 'cron-test-secret';
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('GET /api/cron/onboarding-nudge', () => {
  it('401s without the bearer secret', async () => {
    const r = await req('GET', '/api/cron/onboarding-nudge');
    expect(r.status).toBe(401);
  });

  it('401s with the wrong bearer secret', async () => {
    const r = await req('GET', '/api/cron/onboarding-nudge', { headers: { Authorization: 'Bearer wrong-secret' } });
    expect(r.status).toBe(401);
  });

  it('runs and reports counters with the secret (email unconfigured -> sent must be 0)', async () => {
    const r = await req('GET', '/api/cron/onboarding-nudge', { headers: { Authorization: 'Bearer cron-test-secret' } });
    expect(r.status).toBe(200);
    const j = parse(r.raw);
    expect(j.ok).toBe(true);
    expect(j).toHaveProperty('scanned');
    expect(j).toHaveProperty('created');
    expect(j).toHaveProperty('sent');
    expect(j).toHaveProperty('reset');
    expect(j).toHaveProperty('stopped');
    expect(j).toHaveProperty('skipped');
    // RESEND_API_KEY is unset in the test env -> isEmailConfigured() is false
    // for the whole process -> any due send fails -> the cron must not count
    // it as sent.
    expect(j.sent).toBe(0);
  });

  it('is idempotent on a second run (no duplicate reminder rows created)', async () => {
    const r1 = await req('GET', '/api/cron/onboarding-nudge', { headers: { Authorization: 'Bearer cron-test-secret' } });
    const j1 = parse(r1.raw);
    const r2 = await req('GET', '/api/cron/onboarding-nudge', { headers: { Authorization: 'Bearer cron-test-secret' } });
    const j2 = parse(r2.raw);
    expect(j2.ok).toBe(true);
    // Second pass shouldn't "create" rows for GPs it already has a row for.
    expect(j2.created).toBe(0);
    expect(j1.scanned).toBe(j2.scanned);
  });
});

describe('sendOnboardingNudgeEmail via __testUtils (email unconfigured)', () => {
  it('returns { ok: false } when RESEND_API_KEY is not set', async () => {
    const serverModule = await import('../server.js');
    const row = { user_id: 'user-x', email: 'unit-x@example.com', name: 'Unit X', last_step: 2 };
    const result = await serverModule.__testUtils.sendOnboardingNudgeEmail(row, 0, 3);
    expect(result).toBeTruthy();
    expect(result.ok).toBe(false);
  });
});

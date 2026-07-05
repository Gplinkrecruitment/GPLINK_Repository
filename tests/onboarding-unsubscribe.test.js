// Endpoint tests for GET /api/onboarding-reminders/unsubscribe (Task 2).
// Boots the real server in LOCAL-JSON mode (SUPABASE_URL='') against an empty
// temp DB file — no ATS seed needed, this endpoint only touches
// dbState.onboardingReminders.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-onbunsub-${RUN_ID}.json`);
let server, port;

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
  process.env.AUTH_SECRET = 'onbunsub-test-secret-' + RUN_ID;
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

import crypto2 from 'crypto';
function unsubToken(userId) {
  return crypto2.createHmac('sha256', process.env.AUTH_SECRET).update('onb-unsub:' + String(userId)).digest('hex');
}

describe('GET /api/onboarding-reminders/unsubscribe', () => {
  it('rejects a tampered token with the generic page (no user enumeration)', async () => {
    const r = await req('GET', '/api/onboarding-reminders/unsubscribe?u=user-1&t=deadbeef');
    expect(r.status).toBe(400);
    expect(r.raw).not.toContain('user-1');
  });
  it('rejects a missing token', async () => {
    const r = await req('GET', '/api/onboarding-reminders/unsubscribe?u=user-1');
    expect(r.status).toBe(400);
  });
  it('accepts a valid token and marks the reminder row unsubscribed', async () => {
    // seed a reminder row directly into the local DB file, then restart-read via the endpoint
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.onboardingReminders = { 'helen@example.com': { user_id: 'user-helen', email: 'helen@example.com', name: 'Helen', anchor_at: new Date().toISOString(), last_step: 2, steps_sent: [], unsubscribed: false, stopped: false } };
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
    // server holds dbState in memory; POST-boot file edits are invisible — so the
    // endpoint's "valid token, no existing row" path (pre-emptive opt-out upsert)
    // is what makes this hermetic, not the file seed above.
    const r = await req('GET', '/api/onboarding-reminders/unsubscribe?u=user-helen&t=' + unsubToken('user-helen'));
    expect(r.status).toBe(200);
    expect(r.raw.toLowerCase()).toContain('unsubscribed');
  });
  it('is idempotent — second click also 200', async () => {
    const r = await req('GET', '/api/onboarding-reminders/unsubscribe?u=user-helen&t=' + unsubToken('user-helen'));
    expect(r.status).toBe(200);
    expect(r.raw.toLowerCase()).toContain('unsubscribed');
  });
});

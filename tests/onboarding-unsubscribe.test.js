// Endpoint tests for GET /api/onboarding-reminders/unsubscribe (Task 2).
// Boots the real server in LOCAL-JSON mode (SUPABASE_URL='') against an empty
// temp DB file, no ATS seed needed, this endpoint only touches
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

describe('GET /api/onboarding-reminders/unsubscribe (scanner-proof: renders a confirm page, never writes)', () => {
  it('rejects a tampered token with the generic page (no user enumeration)', async () => {
    const r = await req('GET', '/api/onboarding-reminders/unsubscribe?u=user-1&t=deadbeef');
    expect(r.status).toBe(400);
    expect(r.raw).not.toContain('user-1');
  });
  it('rejects a missing token', async () => {
    const r = await req('GET', '/api/onboarding-reminders/unsubscribe?u=user-1');
    expect(r.status).toBe(400);
  });
  it('a valid token renders a 200 confirm page with a POST form, but does NOT flip the row', async () => {
    const uid = 'user-get-noop';
    const r = await req('GET', '/api/onboarding-reminders/unsubscribe?u=' + uid + '&t=' + unsubToken(uid));
    expect(r.status).toBe(200);
    expect(r.raw).toContain('method="POST"');
    expect(r.raw).toContain('action="/api/onboarding-reminders/unsubscribe"');
    expect(r.raw.toLowerCase()).toContain('unsubscribe');
    // Email-security link prefetchers follow GET automatically, this must be a no-op.
    const serverModule = await import('../server.js');
    const rows = await serverModule.__testUtils.listOnboardingReminders();
    expect(rows.find((row) => row.user_id === uid)).toBeUndefined();
  });
});

describe('POST /api/onboarding-reminders/unsubscribe', () => {
  it('rejects a tampered token with the generic page (no user enumeration)', async () => {
    const r = await req('POST', '/api/onboarding-reminders/unsubscribe?u=user-1&t=deadbeef');
    expect(r.status).toBe(400);
    expect(r.raw).not.toContain('user-1');
  });
  it('accepts a valid token via query params (RFC 8058 one-click, no body needed) and marks the reminder row unsubscribed', async () => {
    // seed a reminder row directly into the local DB file, then restart-read via the endpoint
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.onboardingReminders = { 'helen@example.com': { user_id: 'user-helen', email: 'helen@example.com', name: 'Helen', anchor_at: new Date().toISOString(), last_step: 2, steps_sent: [], unsubscribed: false, stopped: false } };
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
    // server holds dbState in memory; POST-boot file edits are invisible, so the
    // endpoint's "valid token, no existing row" path (pre-emptive opt-out upsert)
    // is what makes this hermetic, not the file seed above.
    const r = await req('POST', '/api/onboarding-reminders/unsubscribe?u=user-helen&t=' + unsubToken('user-helen'));
    expect(r.status).toBe(200);
    expect(r.raw.toLowerCase()).toContain('unsubscribed');
    const serverModule = await import('../server.js');
    const rows = await serverModule.__testUtils.listOnboardingReminders();
    const row = rows.find((r2) => r2.user_id === 'user-helen');
    expect(row).toBeTruthy();
    expect(row.unsubscribed).toBe(true);
  });
  it('is idempotent, second click also 200', async () => {
    const r = await req('POST', '/api/onboarding-reminders/unsubscribe?u=user-helen&t=' + unsubToken('user-helen'));
    expect(r.status).toBe(200);
    expect(r.raw.toLowerCase()).toContain('unsubscribed');
  });
  it('keeps ONE row per user_id, a later write with a real email lands on the pre-emptive opt-out row', async () => {
    // Regression: local-JSON key priority must be user_id BEFORE email. The
    // unsubscribe upsert writes email:null (key = user_id); when the cron later
    // upserts the same GP WITH a real email, it must hit the SAME row, not
    // fork a second email-keyed row that silently loses unsubscribed:true.
    const uid = 'user-fork-check';
    const r1 = await req('POST', '/api/onboarding-reminders/unsubscribe?u=' + uid + '&t=' + unsubToken(uid));
    expect(r1.status).toBe(200);
    // saveDbState writes DB_FILE synchronously, observe the on-disk row.
    const db1 = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const rows1 = Object.entries(db1.onboardingReminders || {}).filter(([, v]) => v.user_id === uid);
    expect(rows1.length).toBe(1);
    expect(rows1[0][0]).toBe(uid); // keyed by user_id, not email
    expect(rows1[0][1].unsubscribed).toBe(true);
    // Now simulate exactly what the Task-3 cron will do: upsert the SAME user
    // with a REAL email in the patch. Same server module instance -> same
    // in-memory dbState the endpoint wrote to.
    const serverModule = await import('../server.js');
    await serverModule.__testUtils.upsertOnboardingReminder(uid, {
      email: 'fork-check@example.com', name: 'Fork Check', last_step: 3
    });
    const db2 = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const rows2 = Object.entries(db2.onboardingReminders || {}).filter(([, v]) => v.user_id === uid);
    expect(rows2.length).toBe(1); // no forked second row
    expect(rows2[0][0]).toBe(uid); // still the user_id key
    expect(rows2[0][1].unsubscribed).toBe(true); // opt-out survived the cron write
    expect(rows2[0][1].email).toBe('fork-check@example.com'); // and the email merged in
  });
});

// Regression cover for the 2026-09-06 owner report: a practice replied with
// real availability and the doctor's card still read "No mutually available
// times in the next 2 weeks — we'll widen the search."
//
// Cause: interviews run 30 minutes (scheduled_calls.duration_minutes is NOT
// NULL DEFAULT 30, and the admin Duration select defaults to "30 minutes") but
// server.js hardcoded 45 in eleven places. computeInterviewSlots only emits a
// start where `t + durationMin <= windowEnd`, so PKG Medical Centre's exact
// 7:00–7:30pm windows produced ZERO slots. A practice offering a LONGER window
// merely lost the last slot of it, which is why this went unnoticed for months.
//
// Second half: min_notice_hours + POST /api/ats/interview/allow-short-notice
// let an operator waive the 48-hour notice rule for ONE interview, for times
// that are short-notice but genuinely still workable — PKG's windows were
// legal when they sent them on the 3rd and the clock caught up by the 6th.
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
const DB_FILE = path.join('/tmp', `gplink-ivdur-${RUN_ID}.json`);
const SUPER_HOST = 'ats-test.local';

// Everything is pinned to explicit instants so this never depends on the wall
// clock. 2026-09-10 and 2026-09-17 are both Thursdays.
const INGEST_NOW = '2026-09-10T00:00:00Z';   // practice replies
const WINDOW_DAY = '2026-09-17';             // the only window that survives validation
const BEFORE_NOTICE = '2026-09-16T00:00:00Z'; // inside the 48h notice period
const AFTER_WINDOW = '2026-09-18T00:00:00Z';  // the window is now in the past

let server, port;

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Host: SUPER_HOST, Cookie: superCookie() };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject); r.end(data);
  });
}
const call = (method, p, body) => httpReq(method, p, body);
const readDb = () => { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; } };
const slotsFor = (appId, now) => call('GET', '/api/ats/interview/slots?application_id=' + appId + '&now=' + encodeURIComponent(now));

// Drive the real practice-reply ingest so the stored windows come from the
// same code path a real reply does. "7:00pm to 7:30pm" is exactly the 30-minute
// shape PKG sent; the named weekday resolves against INGEST_NOW, and windows
// inside the notice period are dropped by the validator, leaving WINDOW_DAY.
async function setThirtyMinuteWindow(appId) {
  const req = await call('POST', '/api/ats/interview/request', { application_id: appId });
  expect(req.status).toBe(200);
  const mod = await import('../server.js');
  await mod.__testUtils.ingestPracticeAvailabilityReply(req.body.interview_id, 'Thursday 7:00pm to 7:30pm', INGEST_NOW);
  const row = (readDb().scheduledCalls || []).find((r) => String(r.id) === String(req.body.interview_id));
  expect(row.practice_availability_status).toBe('received');
  // Precisely the failing shape: one 30-minute window. (Ingest also stamps the
  // practice's derived tz onto the window, which is not what this pins.)
  expect(row.practice_availability_windows).toHaveLength(1);
  expect(row.practice_availability_windows[0]).toMatchObject({ date: WINDOW_DAY, fromMin: 1140, toMin: 1170 });
  return req.body.interview_id;
}

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'ivdur-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.INTERVIEW_MEETING_URL = 'https://zoom.us/j/testroom';
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-ats-dev.js')], { env: { ...process.env, DB_FILE_PATH: DB_FILE } });
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch { /* already gone */ }
});

describe('interview length comes from the row, not a hardcoded 45', () => {
  it('a 30-minute practice window still produces a bookable slot', async () => {
    await setThirtyMinuteWindow('c6');

    const res = await slotsFor('c6', INGEST_NOW);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // With the old hardcoded 45 this was 0 — exactly the "No mutually available
    // times in the next 2 weeks" the owner reported.
    expect(res.body.slots.length).toBe(1);

    const slot = res.body.slots[0];
    // The slot IS the window: 30 minutes, not a 45-minute block hanging over
    // the end of what the practice actually offered.
    expect(new Date(slot.endUtc) - new Date(slot.startUtc)).toBe(30 * 60000);
    // And it starts when the practice said, in the practice's own zone.
    expect(slot.local.practice.label).toMatch(/7:00\s*pm/i);
  });

  it('new interview rows carry the 30-minute default explicitly', async () => {
    const req = await call('POST', '/api/ats/interview/request', { application_id: 'c10' });
    expect(req.status).toBe(200);
    const row = (readDb().scheduledCalls || []).find((r) => String(r.id) === String(req.body.interview_id));
    expect(row.duration_minutes).toBe(30);
  });
});

describe('POST /api/ats/interview/allow-short-notice', () => {
  it('offers a window that the 48-hour notice rule was refusing', async () => {
    await setThirtyMinuteWindow('c11');

    // Six days after the reply the window is only ~1 day out — inside notice.
    const before = await slotsFor('c11', BEFORE_NOTICE);
    expect(before.status).toBe(200);
    expect(before.body.slots.length).toBe(0);

    const waive = await call('POST', '/api/ats/interview/allow-short-notice', { applicationId: 'c11' });
    expect(waive.status).toBe(200);
    expect(waive.body.ok).toBe(true);
    expect(waive.body.min_notice_hours).toBe(0);

    const after = await slotsFor('c11', BEFORE_NOTICE);
    expect(after.status).toBe(200);
    expect(after.body.slots.length).toBe(1);
  });

  it('never offers a slot in the past, even fully waived', async () => {
    await setThirtyMinuteWindow('c12');
    const waive = await call('POST', '/api/ats/interview/allow-short-notice', { applicationId: 'c12' });
    expect(waive.status).toBe(200);

    const res = await slotsFor('c12', AFTER_WINDOW);
    expect(res.status).toBe(200);
    expect(res.body.slots.length).toBe(0);
  });

  it('refuses a waiver that is not actually shorter than the standard notice', async () => {
    await setThirtyMinuteWindow('c7');
    const res = await call('POST', '/api/ats/interview/allow-short-notice', { applicationId: 'c7', hours: 48 });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('404s for an application with no interview row', async () => {
    const res = await call('POST', '/api/ats/interview/allow-short-notice', { applicationId: 'no-such-app-sn' });
    expect(res.status).toBe(404);
  });

  it('requires an ATS session', async () => {
    const res = await new Promise((resolve, reject) => {
      const data = JSON.stringify({ applicationId: 'c6' });
      const r = http.request({
        host: '127.0.0.1', port, path: '/api/ats/interview/allow-short-notice', method: 'POST',
        headers: { Host: SUPER_HOST, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      }, (res2) => { res2.resume(); res2.on('end', () => resolve({ status: res2.statusCode })); });
      r.on('error', reject); r.end(data);
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

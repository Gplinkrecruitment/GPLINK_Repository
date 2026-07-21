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
  // Zoom API unconfigured in tests → the join link comes from the standing room.
  process.env.INTERVIEW_MEETING_URL = 'https://zoom.us/j/testroom';
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
    // correlation_token is TEXT NOT NULL UNIQUE in prod, every interview row must carry one.
    expect(typeof row.correlation_token).toBe('string');
    expect(row.correlation_token.length).toBeGreaterThan(0);
  });

  it('is idempotent, a second request returns already:true', async () => {
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

describe('GET /api/ats/interview/slots', () => {
  it('returns pre-cleared 3-way slots after practice availability is received', async () => {
    // Ensure interview row exists.
    const reqRes = await call('POST', '/api/ats/interview/request', { application_id: SEED_APP_ID });
    expect(reqRes.status).toBe(200);
    const id = reqRes.body.interview_id;
    // Ingest practice availability (weekdays 6-10pm).
    const mod = await import('../server.js');
    await mod.__testUtils.ingestPracticeAvailabilityReply(id, 'weekdays 6-10pm', '2026-07-01T00:00:00Z');
    // Fetch slots (pin now for determinism).
    const res = await call('GET', '/api/ats/interview/slots?application_id=' + SEED_APP_ID + '&now=2026-07-01T00:00:00Z');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.slots.length).toBeGreaterThan(0);
    // GP is Dr Aisha Khan, country United Kingdom → timezone must be Europe/London.
    expect(res.body.slots[0].local.gp.tz).toBe('Europe/London');
  });

  it('returns {ok:true, status:"requested", slots:[]} when practice has not yet replied', async () => {
    // Use a fresh application (c3) that has no interview row yet, do NOT ingest availability.
    // This exercises the 'requested' guard branch (status !== 'received'/'defaulted' → empty slots).
    await call('POST', '/api/ats/interview/request', { application_id: 'c3' });
    const res = await call('GET', '/api/ats/interview/slots?application_id=c3&now=2026-07-01T00:00:00Z');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('requested');
    expect(res.body.slots.length).toBe(0);
  });

  it('returns 404 for a nonexistent application', async () => {
    const res = await call('GET', '/api/ats/interview/slots?application_id=nonexistent-app&now=2026-07-01T00:00:00Z');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/ats/interview/book', () => {
  it('books the slot: creates Zoom + GCal event, moves application to interview stage', async () => {
    // Ensure interview row exists and has received availability.
    const reqRes = await call('POST', '/api/ats/interview/request', { application_id: SEED_APP_ID });
    expect(reqRes.status).toBe(200);
    const id = reqRes.body.interview_id;
    const mod = await import('../server.js');
    await mod.__testUtils.ingestPracticeAvailabilityReply(id, 'weekdays 6-10pm', '2026-07-01T00:00:00Z');
    // Fetch a valid slot.
    const slotsRes = await call('GET', '/api/ats/interview/slots?application_id=' + SEED_APP_ID + '&now=2026-07-01T00:00:00Z');
    expect(slotsRes.body.slots.length).toBeGreaterThan(0);
    const slot = slotsRes.body.slots[0];
    // Book the slot (pass now for determinism so validation re-run uses the same window).
    const res = await call('POST', '/api/ats/interview/book', {
      application_id: SEED_APP_ID,
      slot_start_utc: slot.startUtc,
      now: '2026-07-01T00:00:00Z'
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Interview row must show booked + Zoom + GCal.
    const row = readDb().scheduledCalls.find((r) => r.id === id);
    expect(row.status).toBe('booked');
    expect(row.gcal_event_id).toBeTruthy();
    expect(row.zoom_join_url).toBeTruthy();
    // Application must have advanced to the interview stage.
    const app = readDb().atsApplications.find((a) => a.id === SEED_APP_ID);
    expect(app.ats_stage).toBe('interview');
    // A fake calendar entry must have been created.
    expect(readDb().fakeCalendar.length).toBe(1);
  });

  it('is idempotent, a second book returns already:true with the existing booking', async () => {
    // The previous test already booked the slot; calling again must return already:true.
    const row = readDb().scheduledCalls.find((r) => r.meeting_kind === 'interview');
    const res = await call('POST', '/api/ats/interview/book', {
      application_id: SEED_APP_ID,
      slot_start_utc: row.scheduled_at,
      now: '2026-07-01T00:00:00Z'
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.already).toBe(true);
    // Calendar length must not have grown.
    expect(readDb().fakeCalendar.length).toBe(1);
  });

  it('returns 409 when the requested slot is not in the computed available list', async () => {
    // Use a fresh application (c2) that is unbooked, independent of the c1 tests above.
    const reqRes = await call('POST', '/api/ats/interview/request', { application_id: 'c2' });
    expect(reqRes.status).toBe(200);
    const freshId = reqRes.body.interview_id;
    const mod = await import('../server.js');
    await mod.__testUtils.ingestPracticeAvailabilityReply(freshId, 'weekdays 6-10pm', '2026-07-01T00:00:00Z');
    // Book with a slot far in the past, guaranteed not to be in the computed list.
    const res = await call('POST', '/api/ats/interview/book', {
      application_id: 'c2',
      slot_start_utc: '2000-01-01T00:00:00.000Z',
      now: '2026-07-01T00:00:00Z'
    });
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
  });
});

describe('GET /api/ats/interview/slots, exhaustive windows when practice has replied', () => {
  it('returns slots ONLY on the day(s) the practice named, not on other days', async () => {
    // Use c5 (Dr Sofia Ramos), untouched by any earlier test in this file.
    const reqRes = await call('POST', '/api/ats/interview/request', { application_id: 'c5' });
    expect(reqRes.status).toBe(200);
    expect(reqRes.body.ok).toBe(true);
    const id = reqRes.body.interview_id;
    const mod = await import('../server.js');
    // Ingest a reply that names only Thursday evenings.
    await mod.__testUtils.ingestPracticeAvailabilityReply(id, 'Thursday after 7pm', '2026-07-01T00:00:00Z');
    // Fetch slots pinned to the same "now".
    const res = await call('GET', '/api/ats/interview/slots?application_id=c5&now=2026-07-01T00:00:00Z');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Must have at least one slot (the parser finds 2 Thursdays in the 14-day horizon).
    expect(res.body.slots.length).toBeGreaterThan(0);
    // Every returned slot must fall on a Thursday in Australia/Sydney.
    // (The practice tz for Greenslopes Family Medical / j1 resolves to Australia/Sydney.)
    const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Australia/Sydney' });
    const nonThursday = res.body.slots.filter(function (s) { return dayFmt.format(new Date(s.startUtc)) !== 'Thu'; });
    expect(nonThursday).toHaveLength(0);
  });
});

describe('POST /api/ats/interview/ingest-reply', () => {
  it('requests interview then ingests reply → status received + windows_count > 0', async () => {
    // Use c4 (Dr Marcus Webb), untouched by any other test in this file.
    const reqRes = await call('POST', '/api/ats/interview/request', { application_id: 'c4' });
    expect(reqRes.status).toBe(200);
    expect(reqRes.body.ok).toBe(true);
    const res = await call('POST', '/api/ats/interview/ingest-reply', { application_id: 'c4', reply_text: 'weekdays 6-10pm' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('received');
    expect(res.body.windows_count).toBeGreaterThan(0);
    // Confirm the DB row itself reflects the ingestion.
    const db = readDb();
    const row = (db.scheduledCalls || []).find((r) => r.application_id === 'c4' && r.meeting_kind === 'interview');
    expect(row).toBeTruthy();
    expect(row.practice_availability_status).toBe('received');
  });

  it('returns 401 without an admin session', async () => {
    const res = await callNoAuth('POST', '/api/ats/interview/ingest-reply', { application_id: 'c4', reply_text: 'any text' });
    expect(res.status).toBe(401);
  });

  it('returns 404 for an application with no interview row', async () => {
    const res = await call('POST', '/api/ats/interview/ingest-reply', { application_id: 'no-such-app-ir', reply_text: 'some text' });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});

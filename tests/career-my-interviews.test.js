// Tests for GET /api/career/my-interviews (Task 3 — interview-prep page data source).
// Mirrors the local-JSON bootstrap pattern in tests/interview-endpoints.test.js.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-myint-${RUN_ID}.json`);
let server, port;

const ME = { userId: 'u-me', email: 'me@gplink-test.local' };
const FUTURE = new Date(Date.now() + 3 * 24 * 3600000).toISOString();
const FUTURE_LATER = new Date(Date.now() + 6 * 24 * 3600000).toISOString();
const PAST = new Date(Date.now() - 2 * 24 * 3600000).toISOString();

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function userCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}

function httpReq(method, p, { cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject); r.end();
  });
}

const asMe = () => httpReq('GET', '/api/career/my-interviews', { cookie: userCookie(ME.email, ME.userId) });

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'myint-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;

  // Seed the local JSON DB directly (loadDbState spreads ...parsed, so the extra
  // scheduledCalls/careerInterviews collections survive the whitelisted parse).
  fs.writeFileSync(DB_FILE, JSON.stringify({
    version: 1,
    atsJobs: [
      { id: 'job1', title: 'General Practitioner — VR', practice_name: 'Greenslopes Family Medical', provider: 'internal_ats', is_active: true, job_status: 'open' }
    ],
    atsApplications: [
      { id: 'appA', user_id: ME.userId, career_role_id: 'job1', status: 'applied', ats_stage: 'interview' }
    ],
    scheduledCalls: [
      // Mine — upcoming booked interview (must come FIRST in the sorted response).
      {
        id: 'sc1', user_id: ME.userId, application_id: 'appA', meeting_kind: 'interview',
        status: 'booked', scheduled_at: FUTURE,
        zoom_join_url: 'https://zoom.us/j/111111', zoom_host_url: 'https://zoom.us/s/HOSTSECRET1', zoom_passcode: 'pc-1',
        practice_name: '', created_at: PAST
      },
      // Another user's interview — must NEVER appear.
      {
        id: 'sc-other', user_id: 'u-other', application_id: 'appB', meeting_kind: 'interview',
        status: 'booked', scheduled_at: FUTURE_LATER, zoom_join_url: 'https://zoom.us/j/999999'
      },
      // Mine but NOT an interview (standard consult) — excluded.
      { id: 'sc-consult', user_id: ME.userId, meeting_kind: 'consultation', status: 'booked', scheduled_at: FUTURE },
      // Mine but cancelled — excluded.
      { id: 'sc-cancelled', user_id: ME.userId, meeting_kind: 'interview', status: 'cancelled', scheduled_at: FUTURE }
    ],
    careerInterviews: [
      // Mine — past interview from the OLDER table (merged, sorted after the upcoming one).
      {
        id: 'ci1', user_id: ME.userId, application_id: 'appA', scheduled_at: PAST,
        duration_minutes: 30, timezone: 'Australia/Sydney', format: 'video', status: 'completed',
        zoom_join_url: 'https://zoom.us/j/222222', zoom_host_url: 'https://zoom.us/s/HOSTSECRET2',
        interviewer_name: 'Dr Rachel Thompson', interviewer_email: 'rachel@practice-secret.example'
      },
      // Another user's row — must NEVER appear.
      { id: 'ci-other', user_id: 'u-other', application_id: 'appB', scheduled_at: PAST, status: 'scheduled' },
      // Mine but cancelled — excluded.
      { id: 'ci-cancelled', user_id: ME.userId, scheduled_at: FUTURE, status: 'cancelled' }
    ]
  }, null, 2));

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('GET /api/career/my-interviews', () => {
  it('returns 401 without a session', async () => {
    const res = await httpReq('GET', '/api/career/my-interviews');
    expect(res.status).toBe(401);
  });

  it('returns only the current user\'s interviews, merged from BOTH tables', async () => {
    const res = await asMe();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const ids = res.body.interviews.map((iv) => iv.id);
    expect(ids).toContain('sc1');
    expect(ids).toContain('ci1');
    // Other users' rows, non-interview calls and cancelled rows must be absent.
    expect(ids).not.toContain('sc-other');
    expect(ids).not.toContain('ci-other');
    expect(ids).not.toContain('sc-consult');
    expect(ids).not.toContain('sc-cancelled');
    expect(ids).not.toContain('ci-cancelled');
    // Both sources represented.
    const sources = res.body.interviews.map((iv) => iv.source);
    expect(sources).toContain('scheduled_calls');
    expect(sources).toContain('career_interviews');
  });

  it('sorts the upcoming interview first, then past ones', async () => {
    const res = await asMe();
    expect(res.body.interviews.length).toBe(2);
    expect(res.body.interviews[0].id).toBe('sc1'); // upcoming
    expect(res.body.interviews[1].id).toBe('ci1'); // past
  });

  it('normalizes the shape and enriches practice/job from the linked application', async () => {
    const res = await asMe();
    const upcoming = res.body.interviews.find((iv) => iv.id === 'sc1');
    expect(upcoming.source).toBe('scheduled_calls');
    expect(upcoming.scheduled_at).toBe(FUTURE);
    expect(upcoming.zoom_join_url).toBe('https://zoom.us/j/111111');
    expect(upcoming.duration_minutes).toBe(45); // scheduled_calls interviews are 45 min
    // Enriched via gp_applications(appA) → career_roles(job1).
    expect(upcoming.practice_name).toBe('Greenslopes Family Medical');
    expect(upcoming.job_title).toBe('General Practitioner — VR');

    const past = res.body.interviews.find((iv) => iv.id === 'ci1');
    expect(past.source).toBe('career_interviews');
    expect(past.duration_minutes).toBe(30);
    expect(past.timezone).toBe('Australia/Sydney');
    expect(past.format).toBe('video');
    expect(past.interviewer_name).toBe('Dr Rachel Thompson');
  });

  it('NEVER leaks the host Zoom link, passcode or interviewer email', async () => {
    const res = await asMe();
    expect(res.raw).not.toContain('HOSTSECRET1');
    expect(res.raw).not.toContain('HOSTSECRET2');
    expect(res.raw).not.toContain('zoom_host_url');
    expect(res.raw).not.toContain('pc-1');
    expect(res.raw).not.toContain('rachel@practice-secret.example');
    expect(res.raw).not.toContain('interviewer_email');
  });
});

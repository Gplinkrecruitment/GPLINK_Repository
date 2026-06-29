// TDD test file for Task 7: GET /api/ceo/meetings + candidate apps[] extension.
// Mirrors the bootstrap pattern in tests/interview-endpoints.test.js.
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
const DB_FILE = path.join('/tmp', `gplink-mtg-${RUN_ID}.json`);
const SUPER_HOST = 'ats-test.local';

// IDs for the seeded calls; keep them deterministic so assertions can reference them.
const CEO_INTERVIEW_ID   = 'sc_ceo_int_' + RUN_ID;
const CEO_CONSULT_ID     = 'sc_ceo_con_' + RUN_ID;
const RSO_CONSULT_ID     = 'sc_rso_con_' + RUN_ID;
const CEO_DRAFT_ID       = 'sc_ceo_dft_' + RUN_ID;
// c1 is seeded by seed-ats-dev.js (application id 'c1', career_role_id 'j1').
const SEED_APP_ID        = 'c1';

let server, port;

function b64url(s) {
  return Buffer.from(String(s), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function superCookie() {
  const payload = b64url(JSON.stringify({
    userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' },
    expiresAt: Date.now() + 3600000
  }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}

function httpReq(method, p, { host, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (host)   headers.Host = host;
    if (cookie) headers.Cookie = cookie;
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
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

const call       = (method, p, body) => httpReq(method, p, { host: SUPER_HOST, cookie: superCookie(), body });
const callNoAuth = (method, p, body) => httpReq(method, p, { host: SUPER_HOST, body });

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV      = 'true';
  process.env.NODE_ENV               = 'test';
  process.env.AUTH_SECRET            = 'int-test-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB    = 'false';
  process.env.SUPABASE_URL           = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN    = 'false';
  process.env.DB_FILE_PATH           = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS     = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS           = '';

  // 1. Seed standard ATS data (practices, jobs, applications, candidates).
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-ats-dev.js')], {
    env: { ...process.env, DB_FILE_PATH: DB_FILE }
  });

  // 2. Inject scheduledCalls fixtures:
  //    - a CEO interview (booked, has meeting_summary, linked to app c1)
  //    - a CEO consultation (completed)
  //    - an RSO consultation (must be EXCLUDED from /api/ceo/meetings)
  //    - a CEO abandoned draft (status=cancelled, no scheduled_at/booked_at — EXCLUDED)
  const state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  state.scheduledCalls = [
    {
      id: CEO_INTERVIEW_ID,
      meeting_kind: 'interview',
      host_kind: 'ceo',
      application_id: SEED_APP_ID,
      case_id: 'g6',           // Dr Aisha Khan is seeded at id g6 and has app c1
      status: 'booked',
      scheduled_at: '2026-07-10T09:00:00.000Z',
      booked_at: '2026-07-01T08:00:00.000Z',
      meeting_summary: 'Candidate presented well. Strong fit for GP role.',
      gp_name: 'Dr Aisha Khan',
      created_at: '2026-07-01T07:00:00.000Z',
      updated_at: '2026-07-01T08:00:00.000Z'
    },
    {
      id: CEO_CONSULT_ID,
      meeting_kind: 'consultation',
      host_kind: 'ceo',
      application_id: null,
      case_id: 'g1',
      status: 'completed',
      scheduled_at: '2026-07-05T11:00:00.000Z',
      booked_at: '2026-07-01T06:00:00.000Z',
      meeting_summary: 'Great initial consultation.',
      gp_name: 'Dr Yuki Tanaka',
      created_at: '2026-07-01T06:00:00.000Z',
      updated_at: '2026-07-05T12:00:00.000Z'
    },
    {
      id: RSO_CONSULT_ID,
      meeting_kind: 'consultation',
      host_kind: 'rso',         // MUST be excluded — not the CEO's meeting
      application_id: null,
      case_id: 'g2',
      status: 'completed',
      scheduled_at: '2026-07-04T10:00:00.000Z',
      booked_at: '2026-07-01T05:00:00.000Z',
      meeting_summary: 'RSO-hosted call.',
      gp_name: 'Dr Sofia Ramos',
      created_at: '2026-07-01T05:00:00.000Z',
      updated_at: '2026-07-04T11:00:00.000Z'
    },
    {
      id: CEO_DRAFT_ID,
      meeting_kind: 'consultation',
      host_kind: 'ceo',         // CEO-hosted but abandoned — MUST be excluded
      application_id: null,
      case_id: 'g3',
      status: 'cancelled',
      scheduled_at: null,       // no scheduled_at → abandoned draft
      booked_at: null,          // no booked_at → abandoned draft
      meeting_summary: null,
      gp_name: 'Dr Marcus Webb',
      created_at: '2026-07-01T04:00:00.000Z',
      updated_at: '2026-07-01T04:00:00.000Z'
    }
  ];
  fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));

  // 3. Boot server against the seeded file.
  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

// ─── GET /api/ceo/meetings ──────────────────────────────────────────────────

describe('GET /api/ceo/meetings — kind=all', () => {
  it('returns exactly the 2 CEO non-draft meetings (excludes RSO + draft)', async () => {
    const res = await call('GET', '/api/ceo/meetings?kind=all');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const ids = (res.body.meetings || []).map((m) => m.id);
    expect(ids).toContain(CEO_INTERVIEW_ID);
    expect(ids).toContain(CEO_CONSULT_ID);
    expect(ids).not.toContain(RSO_CONSULT_ID);    // RSO-owned, must be excluded
    expect(ids).not.toContain(CEO_DRAFT_ID);       // abandoned draft, must be excluded
    expect(res.body.meetings.length).toBe(2);
  });

  it('each meeting has is_interview and meeting_kind_label fields (normalizeMeetingForApi applied)', async () => {
    const res = await call('GET', '/api/ceo/meetings?kind=all');
    expect(res.status).toBe(200);
    const interview = (res.body.meetings || []).find((m) => m.id === CEO_INTERVIEW_ID);
    expect(interview).toBeTruthy();
    expect(interview.is_interview).toBe(true);
    expect(interview.meeting_kind_label).toBe('Interview');
    const consult = (res.body.meetings || []).find((m) => m.id === CEO_CONSULT_ID);
    expect(consult.is_interview).toBe(false);
    expect(consult.meeting_kind_label).toBe('Standard consultation');
  });

  it('meetings carry gp_name + scheduled_at + meeting_summary', async () => {
    const res = await call('GET', '/api/ceo/meetings?kind=all');
    const interview = (res.body.meetings || []).find((m) => m.id === CEO_INTERVIEW_ID);
    expect(interview.gp_name).toBe('Dr Aisha Khan');
    expect(interview.scheduled_at).toBe('2026-07-10T09:00:00.000Z');
    expect(interview.meeting_summary).toBe('Candidate presented well. Strong fit for GP role.');
  });

  it('rejects without an admin session', async () => {
    const res = await callNoAuth('GET', '/api/ceo/meetings?kind=all');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/ceo/meetings — kind=interview', () => {
  it('returns only the interview meeting', async () => {
    const res = await call('GET', '/api/ceo/meetings?kind=interview');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.meetings.length).toBe(1);
    expect(res.body.meetings[0].id).toBe(CEO_INTERVIEW_ID);
    expect(res.body.meetings[0].meeting_kind).toBe('interview');
  });
});

describe('GET /api/ceo/meetings — kind=consultation', () => {
  it('returns only the consultation meeting', async () => {
    const res = await call('GET', '/api/ceo/meetings?kind=consultation');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.meetings.length).toBe(1);
    expect(res.body.meetings[0].id).toBe(CEO_CONSULT_ID);
    expect(res.body.meetings[0].meeting_kind).toBe('consultation');
  });
});

// ─── GET /api/ceo/candidate — apps[] extension ─────────────────────────────

describe('GET /api/ceo/candidate — apps[] has interview + offer', () => {
  // g6 = Dr Aisha Khan; she has app c1 which is linked to CEO_INTERVIEW_ID
  const CANDIDATE_ID = 'g6';

  it('returns apps[] with interview reflecting the booked CEO interview', async () => {
    const res = await call('GET', `/api/ceo/candidate?case_id=${CANDIDATE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const apps = res.body.candidate.apps;
    expect(Array.isArray(apps)).toBe(true);
    expect(apps.length).toBeGreaterThan(0);
    const app = apps.find((a) => a.id === SEED_APP_ID);
    expect(app).toBeTruthy();
    expect(app.interview).toBeTruthy();
    expect(app.interview.status).toBe('booked');
    expect(app.interview.scheduled_at).toBe('2026-07-10T09:00:00.000Z');
    expect(app.interview.summary).toBe('Candidate presented well. Strong fit for GP role.');
  });

  it('returns apps[] with offer placeholder (status=not_started)', async () => {
    const res = await call('GET', `/api/ceo/candidate?case_id=${CANDIDATE_ID}`);
    expect(res.status).toBe(200);
    const apps = res.body.candidate.apps;
    const app = apps.find((a) => a.id === SEED_APP_ID);
    expect(app).toBeTruthy();
    expect(app.offer).toBeTruthy();
    expect(app.offer.status).toBe('not_started');
    expect(app.offer.label).toBe('—');
  });

  it('returns interview:null for an app with no interview row', async () => {
    // g10 = Dr Emma Wilson; has app c10 — no scheduledCalls seeded for her
    const res = await call('GET', '/api/ceo/candidate?case_id=g10');
    expect(res.status).toBe(200);
    const apps = res.body.candidate.apps;
    expect(Array.isArray(apps)).toBe(true);
    if (apps.length > 0) {
      expect(apps[0].interview).toBeNull();
    }
  });
});

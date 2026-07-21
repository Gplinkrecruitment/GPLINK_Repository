// Phase 5 Task 2 — GP-journey gaps G2 / G6 / G8.
//
// Reuses the in-memory PostgREST emulator + fetch-mocking harness shared by
// tests/career-interview-booking.test.js and tests/ats-placement-accept.test.js
// so the REAL server drives every path. Outbound Resend email is captured by
// wrapping global fetch; the app + emulator live on 127.0.0.1, every other host
// is stubbed empty so downstream enrichment degrades offline.
//
// Covers:
//  G6 — POST /api/career/offer/accept congratulates the GP on their own
//       acceptance ("Your placement is secured") exactly once, and NOT again on
//       an idempotent repeat accept.
//  G8 — GET /api/cron/interview-reminders scans scheduled_calls booked
//       interviews and sends a 1h + a 24h reminder, each exactly once (dedupe
//       via notification_channels), skips a cancelled interview, and skips a
//       past one.
//  G2 — career.html static pins (securedInterview* ids, my-interviews fetch,
//       https-only Zoom guard, no bare "RSO").
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-gpflow-gaps-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const CRON_SECRET = 'gpflow-cron-' + RUN_ID;
const CONSULTANT = 'consultant@gplink-test.local';
const GP = { userId: 'u-gap-gp-1', email: 'gap-gp@gplink-test.local' };
const NOW = new Date().toISOString();

const resendCalls = [];

const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Gap', last_name: 'Doctor', registration_country: 'uk' }
  ],
  user_state: [],
  registration_cases: [
    { id: 'case-gap-1', user_id: GP.userId, status: 'active', assigned_rso: null, assigned_va: null }
  ],
  practices: [
    { id: 'p-gap-1', name: 'Greenslopes Family Medical', source: 'internal_ats', contact_name: 'Anna Manager', contact_email: 'anna@greenslopes-test.local', is_active: true, created_at: NOW }
  ],
  career_roles: [
    {
      id: 'role-gap-1', provider: 'internal_ats', provider_role_id: 'ats_gap_r1', title: 'General Practitioner — VR',
      practice_name: 'Greenslopes Family Medical', masked_title: 'Confidential practice', practice_id: 'p-gap-1',
      location_city: 'Brisbane', location_state: 'QLD', is_active: true, job_status: 'open', updated_at: NOW
    }
  ],
  gp_applications: [
    {
      id: 'app-gap-1', user_id: GP.userId, career_role_id: 'role-gap-1', provider_role_id: 'ats_gap_r1',
      status: 'offered', ats_stage: 'offer', applied_at: NOW, updated_at: NOW, revealed: true,
      practice_name: 'Greenslopes Family Medical', practice_submission_status: 'client_approved'
    }
  ],
  ats_offers: [
    {
      id: 'offer-gap-1', application_id: 'app-gap-1', status: 'sent', sent_by: CONSULTANT,
      practice_name: 'Greenslopes Family Medical', job_title: 'General Practitioner — VR',
      billing_split: '70 / 30', sessions_per_week: '8', start_date: '2026-09-01', created_at: NOW, updated_at: NOW
    }
  ],
  ats_stage_events: [],
  ats_placements: [],
  user_documents: [],
  integration_connections: [],
  registration_tasks: [],
  task_timeline: [],
  scheduled_calls: [],
  career_interviews: [],
  runtime_kv: []
};
function tableOf(name) { if (!db[name]) db[name] = []; return db[name]; }

const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'];
function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue;
    const val = raw.slice(dot + 1);
    filters.push({ col: key, op, val });
  }
  return (row) => filters.every(({ col, op, val }) => {
    const cell = row ? row[col] : undefined;
    if (op === 'eq') return String(cell) === val;
    if (op === 'neq') return String(cell) !== val;
    if (op === 'is') return val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    if (op === 'in') {
      return val.replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''))
        .includes(String(cell));
    }
    return true;
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); }
      catch { resolve(null); }
    });
  });
}

function startSupabaseEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const table = decodeURIComponent(m[1]);
      const rows = tableOf(table);
      const matches = buildMatcher(u.searchParams);

      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out);
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const conflictCol = u.searchParams.get('on_conflict');
        const saved = incoming.map((r) => {
          if (conflictCol) {
            const existing = rows.find((row) => row && String(row[conflictCol]) === String(r[conflictCol]));
            if (existing) { Object.assign(existing, r); return existing; }
          }
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r };
          rows.push(row);
          return row;
        });
        send(201, saved);
        return;
      }
      if (req.method === 'PATCH') {
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched);
        return;
      }
      if (req.method === 'DELETE') {
        const keep = rows.filter((row) => !matches(row));
        rows.length = 0;
        keep.forEach((row) => rows.push(row));
        send(200, []);
        return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function userCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_session=' + encodeURIComponent(payload + '.' + sig);
}

function httpReq(method, p, { cookie, body, headers: extraHeaders } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = Object.assign({}, extraHeaders || {});
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

const gpPost = (p, body) => httpReq('POST', p, { cookie: userCookie(GP.email, GP.userId), body });
const cronGet = (p) => httpReq('GET', p, { headers: { Authorization: 'Bearer ' + CRON_SECRET } });

// Reminder emails to the GP, by lead-time (subject carries "Tomorrow" for 24h,
// "Reminder" for the 2h nudge — see sendInterviewReminderEmail).
const gpEmails = (matcher) => resendCalls.filter((c) => {
  const to = c.body && c.body.to;
  const toGp = (Array.isArray(to) ? to : [to]).some((t) => String(t || '').includes(GP.email));
  return toGp && matcher(String(c.body && c.body.subject || ''));
});
const secured = () => gpEmails((s) => /placement is secured/i.test(s));
const remind2h = () => gpEmails((s) => /interview reminder/i.test(s));
const remind24h = () => gpEmails((s) => /interview tomorrow/i.test(s));

// D1a: practice-facing sends (contact anna@ on practice p-gap-1).
const practiceMails = (matcher) => resendCalls.filter((c) => {
  const to = c.body && c.body.to;
  const toPractice = (Array.isArray(to) ? to : [to]).some((t) => String(t || '').includes('anna@greenslopes-test.local'));
  return toPractice && matcher(String(c.body && c.body.subject || ''));
});
const practiceConfirm = () => practiceMails((s) => /placement confirmed/i.test(s));
const practiceRemind2h = () => practiceMails((s) => /^interview reminder/i.test(s) && /an hour/i.test(s));
const practiceRemind24h = () => practiceMails((s) => /^interview reminder/i.test(s) && /tomorrow/i.test(s));

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'gpflow-gaps-secret-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.ZOHO_RECRUIT_CLIENT_ID = '';
  process.env.ZOHO_RECRUIT_CLIENT_SECRET = '';
  process.env.ZOHO_RECRUIT_REDIRECT_URI = '';
  process.env.OPENAI_API_KEY = '';
  process.env.ZOOM_ACCOUNT_ID = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.FCM_SERVER_KEY = 'test-fcm-key';

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.resend.com/')) {
      let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
      resendCalls.push({ url: u, body: parsed });
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
    }
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    // Everything else (FCM push, geocoding, listings, …) stubbed empty/offline.
    return Promise.resolve(new Response('{}', { status: 200 }));
  };

  const { createServer } = await import('../server.js');
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }));
});

afterAll(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch {}
});

describe('G6 — GP congratulated on in-app self-accept', () => {
  it('accepts the offer, secures the placement, and emails the GP once', async () => {
    const before = secured().length;
    const r = await gpPost('/api/career/offer/accept', { applicationId: 'app-gap-1' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.placement_secured).toBe(true);

    // Exactly one "placement is secured" email to the GP.
    expect(secured().length - before).toBe(1);
    const email = secured().slice(-1)[0];
    // Real practice name is fine post-accept (identity is revealed).
    expect(String(email.body.subject)).toMatch(/placement is secured/i);

    // D1a: the practice gets exactly one placement confirmation too — real
    // doctor name (identity revealed at placement) + the commencement date.
    expect(practiceConfirm().length).toBe(1);
    const pMail = practiceConfirm()[0];
    expect(String(pMail.body.subject)).toContain('Dr Gap Doctor');
    expect(String(pMail.body.html)).toContain('Dr Gap Doctor');
    expect(String(pMail.body.html)).toContain('has confirmed the placement');
    // offer-gap-1 start_date 2026-09-01 → formatted commencement line.
    expect(String(pMail.body.text)).toContain('1 September 2026');
  });

  it('does NOT re-send the GP congratulation on an idempotent repeat accept', async () => {
    const before = secured().length;
    const beforePractice = practiceConfirm().length;
    const r = await gpPost('/api/career/offer/accept', { applicationId: 'app-gap-1' });
    expect(r.status).toBe(200);
    expect(r.body.placement_secured).toBe(true);
    expect(secured().length).toBe(before); // no second email
    expect(practiceConfirm().length).toBe(beforePractice); // practice not re-emailed either (D1a)
  });
});

describe('G8 — interview reminder cron (scheduled_calls)', () => {
  const H = 60 * 60 * 1000;
  function seedInterview(overrides) {
    const row = Object.assign({
      id: crypto.randomUUID(),
      meeting_kind: 'interview',
      host_kind: 'practice',
      status: 'booked',
      application_id: 'app-gap-1',
      user_id: GP.userId,
      practice_name: 'Greenslopes Family Medical',
      timezone: 'Europe/London',
      format: 'video',
      zoom_join_url: 'https://zoom.us/j/gap-' + crypto.randomBytes(2).toString('hex'),
      scheduled_at: new Date(Date.now() + 10 * H).toISOString(),
      notification_channels: null,
      created_at: new Date().toISOString()
    }, overrides || {});
    db.scheduled_calls.push(row);
    return row;
  }

  let rowSoon, rowDay, rowCancelled, rowPast;
  beforeAll(() => {
    db.scheduled_calls.length = 0;
    rowSoon = seedInterview({ scheduled_at: new Date(Date.now() + 0.5 * H).toISOString() });      // within 1h
    rowDay = seedInterview({ scheduled_at: new Date(Date.now() + 10 * H).toISOString() });         // within 24h, >1h
    rowCancelled = seedInterview({ status: 'cancelled', scheduled_at: new Date(Date.now() + 0.5 * H).toISOString() });
    rowPast = seedInterview({ scheduled_at: new Date(Date.now() - 2 * H).toISOString() });          // already happened
  });

  it('sends a 1h reminder and a 24h reminder, one each, and skips cancelled/past', async () => {
    const before2 = remind2h().length;
    const before24 = remind24h().length;
    const beforeP2 = practiceRemind2h().length;
    const beforeP24 = practiceRemind24h().length;

    const r = await cronGet('/api/cron/interview-reminders');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // rowSoon -> 1h nudge; rowDay -> 24h heads-up. rowCancelled + rowPast: none.
    expect(remind2h().length - before2).toBe(1);
    expect(remind24h().length - before24).toBe(1);

    // D1a: the practice contact gets a reminder per window too, with the GP
    // name, the local time and the Zoom link.
    expect(practiceRemind2h().length - beforeP2).toBe(1);
    expect(practiceRemind24h().length - beforeP24).toBe(1);
    const pMail = practiceRemind2h().slice(-1)[0];
    expect(String(pMail.body.subject)).toContain('Gap Doctor');
    expect(String(pMail.body.text)).toContain('Join the meeting: https://zoom.us/j/gap-');
    expect(String(pMail.body.text)).toContain('When: ');

    // Dedupe flags persisted on the two live rows only.
    const soon = db.scheduled_calls.find((c) => c.id === rowSoon.id);
    const day = db.scheduled_calls.find((c) => c.id === rowDay.id);
    expect(soon.notification_channels && soon.notification_channels.interview_reminders && soon.notification_channels.interview_reminders.h1).toBeTruthy();
    expect(day.notification_channels && day.notification_channels.interview_reminders && day.notification_channels.interview_reminders.h24).toBeTruthy();
    // Practice reminders dedupe independently (practice_h1/practice_h24).
    expect(soon.notification_channels.interview_reminders.practice_h1).toBeTruthy();
    expect(day.notification_channels.interview_reminders.practice_h24).toBeTruthy();
    // The cancelled + past rows were never touched.
    expect(db.scheduled_calls.find((c) => c.id === rowCancelled.id).notification_channels).toBeNull();
    expect(db.scheduled_calls.find((c) => c.id === rowPast.id).notification_channels).toBeNull();
  });

  it('is idempotent — a second cron run sends no duplicate reminders', async () => {
    const before2 = remind2h().length;
    const before24 = remind24h().length;
    const beforeP2 = practiceRemind2h().length;
    const beforeP24 = practiceRemind24h().length;
    const r = await cronGet('/api/cron/interview-reminders');
    expect(r.status).toBe(200);
    expect(remind2h().length).toBe(before2);
    expect(remind24h().length).toBe(before24);
    expect(practiceRemind2h().length).toBe(beforeP2);
    expect(practiceRemind24h().length).toBe(beforeP24);
  });

  it('rejects an unauthenticated cron call', async () => {
    const r = await httpReq('GET', '/api/cron/interview-reminders');
    expect(r.status).toBe(401);
  });
});

describe('G2 — career.html static pins', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'pages', 'career.html'), 'utf8');

  it('has the securedInterview* card markers', () => {
    expect(html).toContain('id="securedInterviewCard"');
    expect(html).toContain('id="securedInterviewJoinLink"');
    expect(html).toContain('securedInterviewWhen');
    expect(html).toContain('securedInterviewPractice');
  });

  it('fetches the interviews from /api/career/my-interviews', () => {
    expect(html).toContain('/api/career/my-interviews');
  });

  it('guards the Zoom link to https only', () => {
    expect(html).toContain('securedSafeZoomUrl');
    expect(html).toMatch(/protocol\s*===\s*"https:"/);
  });

  it('never uses the bare acronym "RSO"', () => {
    expect(/\bRSO\b/.test(html)).toBe(false);
  });
});

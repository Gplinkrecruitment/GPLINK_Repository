// Task 13 — "Secure My Interview": GP-facing instant Zoom interview booking.
//
// Reuses the same in-memory PostgREST emulator + fetch-mocking harness as
// tests/ats-accept-flow.test.js so the real server (not a stub) drives the
// full 3-way-timezone scheduler. Local mode for Zoom/GCal (no ZOOM_* /
// GOOGLE_SERVICE_ACCOUNT_* env vars set) exercises the zoom_local_* /
// dbState.fakeCalendar fallbacks end-to-end.
//
// Covers:
//  1. GET /api/career/interview/slots — creates a 'defaulted' interview row
//     on first call (no practice round-trip) and returns >=1 slot.
//  2. POST /api/career/interview/book — books the first slot: Zoom + GCal
//     (local fallbacks), scheduled_calls -> booked, application -> 'interview'
//     stage, confirmation emails sent (awaited before responding).
//  3. Idempotent re-book returns {ok:true, already:true, booked:{...}}.
//  4. 403 {error:'not_available'} when the offer hasn't been revealed.
//  5. 404 when the application belongs to a different GP.
//  6. 409 {error:'slot_taken'} for a stale/impossible slot_start_utc.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-career-interview-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const GP = { userId: 'u-int-gp-1', email: 'gp-interview@gplink-test.local' };
const GP2 = { userId: 'u-int-gp-2', email: 'other-interview@gplink-test.local' };
const NOW = new Date().toISOString();

const resendCalls = [];

const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Interview', last_name: 'Doctor', registration_country: 'uk' },
    { user_id: GP2.userId, email: GP2.email, first_name: 'Other', last_name: 'Doctor', registration_country: 'ie' }
  ],
  user_state: [],
  registration_cases: [
    { id: 'case-int-1', user_id: GP.userId, status: 'active', assigned_rso: null, assigned_va: null }
  ],
  practices: [
    { id: 'p-int-1', name: 'Greenslopes Family Medical', source: 'internal_ats', contact_name: 'Anna Manager', contact_email: 'anna@greenslopes-test.local', is_active: true, created_at: NOW },
    // Task 8: WA practice whose NAME contains no city/state keyword — the stored
    // location_state must drive the timezone (Perth), not name sniffing (Sydney).
    { id: 'p-int-wa', name: 'Sunrise Family Medical', source: 'internal_ats', contact_name: 'Wes Manager', contact_email: 'reception@sunrise-wa-test.local', location_city: 'Karratha', location_state: 'WA', is_active: true, created_at: NOW }
  ],
  career_roles: [
    {
      id: 'role-int-1', provider: 'internal_ats', provider_role_id: 'ats_int_r1', title: 'General Practitioner — VR',
      practice_name: 'Greenslopes Family Medical', practice_id: 'p-int-1', location_city: 'Brisbane', location_state: 'QLD',
      is_active: true, job_status: 'open', updated_at: NOW
    },
    // A second, distinct role for the not-revealed application below — reveal is
    // keyed by (user_id, career_role_id), so app-int-2 needs its own role or it
    // would inherit app-int-1's reveal via the same (GP, role) pair.
    {
      id: 'role-int-2', provider: 'internal_ats', provider_role_id: 'ats_int_r2', title: 'General Practitioner — VR (unrevealed role)',
      practice_name: 'Riverside Medical Centre', practice_id: 'p-int-1', location_city: 'Brisbane', location_state: 'QLD',
      is_active: true, job_status: 'open', updated_at: NOW
    },
    // Task 8: Karratha WA — neither the practice name nor the city matches the
    // legacy name-sniffing keywords, so only location_state can yield Perth time.
    {
      id: 'role-int-wa', provider: 'internal_ats', provider_role_id: 'ats_int_rwa', title: 'General Practitioner — VR',
      practice_name: 'Sunrise Family Medical', practice_id: 'p-int-wa', location_city: 'Karratha', location_state: 'WA',
      is_active: true, job_status: 'open', updated_at: NOW
    }
  ],
  gp_applications: [
    // Revealed (accepted offer) — the happy path for GP self-serve booking.
    { id: 'app-int-1', user_id: GP.userId, career_role_id: 'role-int-1', provider_role_id: 'ats_int_r1', status: 'offered', ats_stage: 'offer', applied_at: NOW, revealed: true, practice_submission_status: 'client_approved' },
    // Not revealed (different role, no offer) — used for the 403 not_available test.
    { id: 'app-int-2', user_id: GP.userId, career_role_id: 'role-int-2', provider_role_id: 'ats_int_r2', status: 'applied', ats_stage: 'reviewing', applied_at: NOW, revealed: false, practice_submission_status: 'submitted_to_practice' },
    // Belongs to GP2 — used for the wrong-owner 404 test.
    { id: 'app-int-3', user_id: GP2.userId, career_role_id: 'role-int-1', provider_role_id: 'ats_int_r3', status: 'offered', ats_stage: 'offer', applied_at: NOW, revealed: true, practice_submission_status: 'client_approved' },
    // Task 8: revealed offer at the WA practice — timezone-derivation tests.
    { id: 'app-int-wa', user_id: GP.userId, career_role_id: 'role-int-wa', provider_role_id: 'ats_int_rwa', status: 'offered', ats_stage: 'offer', applied_at: NOW, revealed: true, practice_submission_status: 'client_approved' }
  ],
  ats_offers: [],
  ats_stage_events: [],
  user_documents: [],
  integration_connections: [],
  scheduled_calls: [],
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

function httpReq(method, p, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
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

const gpGet = (p, who = GP) => httpReq('GET', p, { cookie: userCookie(who.email, who.userId) });
const gpPost = (p, body, who = GP) => httpReq('POST', p, { cookie: userCookie(who.email, who.userId), body });
const noAuthGet = (p) => httpReq('GET', p);

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'career-interview-secret-' + RUN_ID;
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
  // No Zoom / Google Calendar creds -> both endpoints exercise their local
  // fallbacks (zoom_local_* meeting ids, dbState.fakeCalendar events).
  process.env.ZOOM_ACCOUNT_ID = '';
  process.env.ZOOM_CLIENT_ID = '';
  process.env.ZOOM_CLIENT_SECRET = '';
  // Zoom API is unconfigured, so per-interview meetings aren't created; the join
  // link comes from the standing INTERVIEW_MEETING_URL room instead.
  process.env.INTERVIEW_MEETING_URL = 'https://zoom.us/j/testroom';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = '';
  process.env.GOOGLE_CALENDAR_ID = '';
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.RESEND_API_KEY = 'test-resend-key';

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://api.resend.com/')) {
      let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
      resendCalls.push({ url: u, body: parsed });
      return Promise.resolve(new Response(JSON.stringify({ id: 'email-' + resendCalls.length }), { status: 200 }));
    }
    return realFetch(url, opts);
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

describe('GET /api/career/interview/slots', () => {
  it('requires a session', async () => {
    const r = await noAuthGet('/api/career/interview/slots?applicationId=app-int-1');
    expect(r.status).toBe(401);
  });

  it('404s for an application belonging to a different GP', async () => {
    const r = await gpGet('/api/career/interview/slots?applicationId=app-int-3', GP);
    expect(r.status).toBe(404);
  });

  it('403s with not_available when the offer has not been revealed', async () => {
    const r = await gpGet('/api/career/interview/slots?applicationId=app-int-2', GP);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('not_available');
  });

  it('creates a defaulted interview row on first call and returns slots — no practice round-trip', async () => {
    const r = await gpGet('/api/career/interview/slots?applicationId=app-int-1', GP);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(Array.isArray(r.body.slots)).toBe(true);
    expect(r.body.slots.length).toBeGreaterThan(0);

    const row = db.scheduled_calls.find((c) => c.application_id === 'app-int-1' && c.meeting_kind === 'interview');
    expect(row).toBeTruthy();
    expect(row.practice_availability_status).toBe('defaulted');
    expect(typeof row.correlation_token).toBe('string');
    expect(row.correlation_token.length).toBeGreaterThan(0);

    // GP is Dr Interview Doctor, country United Kingdom -> Europe/London.
    expect(r.body.slots[0].local.gp.tz).toBe('Europe/London');
  });

  it('is idempotent — a second call reuses the same interview row (no duplicate)', async () => {
    const before = db.scheduled_calls.length;
    const r = await gpGet('/api/career/interview/slots?applicationId=app-int-1', GP);
    expect(r.status).toBe(200);
    expect(db.scheduled_calls.length).toBe(before);
  });
});

describe('POST /api/career/interview/book', () => {
  it('requires a session', async () => {
    const r = await httpReq('POST', '/api/career/interview/book', { body: { applicationId: 'app-int-1', slot_start_utc: NOW } });
    expect(r.status).toBe(401);
  });

  it('409s slot_taken for an impossible/stale slot', async () => {
    const r = await gpPost('/api/career/interview/book', { applicationId: 'app-int-1', slot_start_utc: '2000-01-01T00:00:00.000Z' }, GP);
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toBe('slot_taken');
  });

  it('books the first available slot end-to-end: Zoom + GCal local fallbacks, stage -> interview, emails sent', async () => {
    const slotsRes = await gpGet('/api/career/interview/slots?applicationId=app-int-1', GP);
    expect(slotsRes.body.slots.length).toBeGreaterThan(0);
    const slot = slotsRes.body.slots[0];

    const beforeEmails = resendCalls.length;
    const beforeCalendar = (db.runtime_kv || []).length; // placeholder; fakeCalendar lives in dbState, checked via DB file below.

    const r = await gpPost('/api/career/interview/book', { applicationId: 'app-int-1', slot_start_utc: slot.startUtc }, GP);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.booked).toBeTruthy();
    expect(r.body.booked.scheduled_at).toBe(slot.startUtc);
    expect(typeof r.body.booked.zoom_join_url).toBe('string');
    expect(r.body.booked.zoom_join_url.length).toBeGreaterThan(0);

    const row = db.scheduled_calls.find((c) => c.application_id === 'app-int-1' && c.meeting_kind === 'interview');
    expect(row.status).toBe('booked');
    expect(row.zoom_join_url).toBeTruthy();
    expect(row.gcal_event_id).toBeTruthy();
    expect(row.scheduled_at).toBe(slot.startUtc);

    const app = db.gp_applications.find((a) => a.id === 'app-int-1');
    expect(app.ats_stage).toBe('interview');

    // Confirmation emails were sent and awaited before the response returned:
    // GP + practice + the ops inbox (hello@) booking notification (GAP A4).
    expect(resendCalls.length - beforeEmails).toBe(3);

    // D1a: the practice AND the GP confirmations both carry a calendar invite
    // (.ics, METHOD:REQUEST) with a UID stable per interview row, so a later
    // cancellation (same UID, SEQUENCE 1) removes the event again.
    const sends = resendCalls.slice(beforeEmails);
    const toOf = (c) => (Array.isArray(c.body.to) ? c.body.to : [c.body.to]).join(',');
    const practiceSend = sends.find((c) => toOf(c).includes('anna@greenslopes-test.local'));
    const gpSend = sends.find((c) => toOf(c).includes(GP.email));
    expect(practiceSend).toBeTruthy();
    expect(gpSend).toBeTruthy();
    for (const send of [practiceSend, gpSend]) {
      expect(Array.isArray(send.body.attachments)).toBe(true);
      expect(send.body.attachments.length).toBe(1);
      const att = send.body.attachments[0];
      expect(att.filename).toBe('interview.ics');
      expect(att.content_type).toBe('text/calendar');
      const ics = Buffer.from(att.content, 'base64').toString('utf8');
      expect(ics).toContain('METHOD:REQUEST');
      expect(ics).toContain('STATUS:CONFIRMED');
      expect(ics).toContain('SEQUENCE:0');
      expect(ics).toContain('UID:gplink-interview-' + row.id + '@mygplink.com.au');
      expect(ics).toContain('DTSTART:' + slot.startUtc.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'));
    }
    // The ops inbox notification deliberately has NO calendar attachment.
    const opsSend = sends.find((c) => toOf(c).includes('hello@mygplink.com.au'));
    expect(opsSend).toBeTruthy();
    expect(opsSend.body.attachments).toBeUndefined();

    // A local fakeCalendar entry was created — read straight from the on-disk local DB state
    // (fakeCalendar is a dbState-only structure, independent of the Supabase emulator above).
    const localDb = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    expect(Array.isArray(localDb.fakeCalendar)).toBe(true);
    expect(localDb.fakeCalendar.length).toBeGreaterThan(0);
  });

  it('is idempotent — re-booking the same application returns already:true with the existing booking', async () => {
    const before = resendCalls.length;
    const row = db.scheduled_calls.find((c) => c.application_id === 'app-int-1' && c.meeting_kind === 'interview');
    const r = await gpPost('/api/career/interview/book', { applicationId: 'app-int-1', slot_start_utc: row.scheduled_at }, GP);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.already).toBe(true);
    expect(r.body.booked.scheduled_at).toBe(row.scheduled_at);
    expect(r.body.booked.zoom_join_url).toBe(row.zoom_join_url);
    // No new emails on the idempotent re-book path.
    expect(resendCalls.length).toBe(before);
  });

  it('404s for an application belonging to a different GP', async () => {
    const r = await gpPost('/api/career/interview/book', { applicationId: 'app-int-3', slot_start_utc: NOW }, GP);
    expect(r.status).toBe(404);
  });

  it('403s with not_available when the offer has not been revealed', async () => {
    const r = await gpPost('/api/career/interview/book', { applicationId: 'app-int-2', slot_start_utc: NOW }, GP);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('not_available');
  });
});

// Task 8 (2026-07-20 audit): the practice timezone must come from the stored
// location_state, not from sniffing the practice NAME. 'Sunrise Family Medical'
// in Karratha WA has no city/state keyword in its name, so the legacy sniffing
// guessed Australia/Sydney — availability windows 2-3h off and email prose
// disagreeing with the UTC-correct .ics.
describe('practice timezone from stored location_state (Task 8)', () => {
  it('computes interview slots with the WA practice in Australia/Perth', async () => {
    const r = await gpGet('/api/career/interview/slots?applicationId=app-int-wa', GP);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.slots.length).toBeGreaterThan(0);
    expect(r.body.slots[0].local.practice.tz).toBe('Australia/Perth');
  });

  it('labels the practice confirmation email in Perth time (AWST), matching the .ics', async () => {
    const slotsRes = await gpGet('/api/career/interview/slots?applicationId=app-int-wa', GP);
    expect(slotsRes.body.slots.length).toBeGreaterThan(0);
    const slot = slotsRes.body.slots[0];

    const beforeEmails = resendCalls.length;
    const r = await gpPost('/api/career/interview/book', { applicationId: 'app-int-wa', slot_start_utc: slot.startUtc }, GP);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const sends = resendCalls.slice(beforeEmails);
    const toOf = (c) => (Array.isArray(c.body.to) ? c.body.to : [c.body.to]).join(',');
    const practiceSend = sends.find((c) => toOf(c).includes('reception@sunrise-wa-test.local'));
    expect(practiceSend).toBeTruthy();
    // Perth is AWST year-round; the pre-fix Sydney guess rendered AEST/AEDT.
    expect(practiceSend.body.text).toContain('AWST');
    expect(practiceSend.body.text).not.toMatch(/AE[SD]T/);
  });
});

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
import sched from '../lib/interview-scheduler.js';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-career-interview-${RUN_ID}.json`);
let server, port;
let sbServer, sbPort;

const GP = { userId: 'u-int-gp-1', email: 'gp-interview@gplink-test.local' };
const GP2 = { userId: 'u-int-gp-2', email: 'other-interview@gplink-test.local' };
// Fresh GP (no prior bookings → clear of the 3/month interview cap) for the
// "booking accepts the offer" flip test.
const GP_OFF = { userId: 'u-int-gp-off', email: 'offer-interview@gplink-test.local' };
const SUPER_EMAIL = 'super@gplink-test.local';
const NOW = new Date().toISOString();

const resendCalls = [];
// Outbound DoubleTick WhatsApp sends, captured by the fetch mock below.
const doubletickCalls = [];

const db = {
  user_profiles: [
    // phone drives the interview WhatsApp confirmations (gp_link_interview_confirmed_gp).
    { user_id: GP.userId, email: GP.email, first_name: 'Interview', last_name: 'Doctor', registration_country: 'uk', phone: '+447700900001' },
    { user_id: GP2.userId, email: GP2.email, first_name: 'Other', last_name: 'Doctor', registration_country: 'ie' },
    { user_id: GP_OFF.userId, email: GP_OFF.email, first_name: 'Offer', last_name: 'Doctor', registration_country: 'uk' }
  ],
  user_state: [],
  registration_cases: [
    { id: 'case-int-1', user_id: GP.userId, status: 'active', assigned_rso: null, assigned_va: null },
    { id: 'case-int-off', user_id: GP_OFF.userId, status: 'active', assigned_rso: null, assigned_va: null }
  ],
  practices: [
    // contact_phone drives the practice-side WhatsApp confirmation.
    { id: 'p-int-1', name: 'Greenslopes Family Medical', source: 'internal_ats', contact_name: 'Anna Manager', contact_email: 'anna@greenslopes-test.local', contact_phone: '+61400111222', is_active: true, created_at: NOW },
    // Task 8: WA practice whose NAME contains no city/state keyword — the stored
    // location_state must drive the timezone (Perth), not name sniffing (Sydney).
    { id: 'p-int-wa', name: 'Sunrise Family Medical', source: 'internal_ats', contact_name: 'Wes Manager', contact_email: 'reception@sunrise-wa-test.local', location_city: 'Karratha', location_state: 'WA', is_active: true, created_at: NOW },
    // Viewer-tz feature: an NSW-state practice whose CONTACT submits availability
    // from a Perth browser — the submitted viewer_tz must beat the state guess.
    { id: 'p-int-nsw', name: 'Harbour Medical Group', source: 'internal_ats', contact_name: 'Nina Manager', contact_email: 'frontdesk@nsw-practice-test.local', location_city: 'Newcastle', location_state: 'NSW', is_active: true, created_at: NOW }
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
    },
    // Viewer-tz feature: two roles at the NSW practice — one per availability test
    // (each gp_applications row gets its own practice_action_token + interview row).
    {
      id: 'role-int-nsw', provider: 'internal_ats', provider_role_id: 'ats_int_rnsw', title: 'General Practitioner — VR',
      practice_name: 'Harbour Medical Group', practice_id: 'p-int-nsw', location_city: 'Newcastle', location_state: 'NSW',
      is_active: true, job_status: 'open', updated_at: NOW
    },
    {
      id: 'role-int-nsw2', provider: 'internal_ats', provider_role_id: 'ats_int_rnsw2', title: 'General Practitioner — VR (second)',
      practice_name: 'Harbour Medical Group', practice_id: 'p-int-nsw', location_city: 'Newcastle', location_state: 'NSW',
      is_active: true, job_status: 'open', updated_at: NOW
    },
    // Booking-accepts-offer flip test: its own role (reveal is keyed on
    // (user_id, role_id), so a fresh role keeps this GP's reveal independent).
    {
      id: 'role-int-offer', provider: 'internal_ats', provider_role_id: 'ats_int_roff', title: 'General Practitioner — VR',
      practice_name: 'Greenslopes Family Medical', practice_id: 'p-int-1', location_city: 'Brisbane', location_state: 'QLD',
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
    { id: 'app-int-wa', user_id: GP.userId, career_role_id: 'role-int-wa', provider_role_id: 'ats_int_rwa', status: 'offered', ats_stage: 'offer', applied_at: NOW, revealed: true, practice_submission_status: 'client_approved' },
    // Viewer-tz feature: approved apps with practice_action_tokens so the
    // practice-decision availability endpoint can be exercised end-to-end.
    { id: 'app-int-nsw', user_id: GP.userId, career_role_id: 'role-int-nsw', provider_role_id: 'ats_int_rnsw', status: 'offered', ats_stage: 'offer', applied_at: NOW, revealed: true, practice_submission_status: 'client_approved', practice_decision: 'approved', practice_action_token: 'tok-int-nsw-000000001' },
    { id: 'app-int-nsw2', user_id: GP2.userId, career_role_id: 'role-int-nsw2', provider_role_id: 'ats_int_rnsw2', status: 'offered', ats_stage: 'offer', applied_at: NOW, revealed: true, practice_submission_status: 'client_approved', practice_decision: 'approved', practice_action_token: 'tok-int-nsw-000000002' },
    // Flip test: revealed offer-stage app with a live 'sent' in-app offer.
    { id: 'app-int-offer', user_id: GP_OFF.userId, career_role_id: 'role-int-offer', provider_role_id: 'ats_int_roff', status: 'offered', ats_stage: 'offer', applied_at: NOW, revealed: true, practice_submission_status: 'client_approved' }
  ],
  ats_offers: [
    // The 'sent' offer that booking an interview must auto-accept.
    { id: 'offer-int-offer', application_id: 'app-int-offer', user_id: GP_OFF.userId, career_role_id: 'role-int-offer', practice_id: 'p-int-1', job_title: 'General Practitioner — VR', practice_name: 'Greenslopes Family Medical', billing_split: '65 / 35', sessions_per_week: '6', compensation_range: '$300k+ estimated', start_date: '2026-10-01', status: 'sent', sent_by: SUPER_EMAIL, sent_at: NOW, created_at: NOW }
  ],
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
  // WhatsApp confirmations are captured, never actually sent.
  process.env.DOUBLETICK_API_KEY = 'test-doubletick-key';
  process.env.HAZEL_WHATSAPP_NUMBER = '+61494391968';

  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url && url.url ? url.url : url);
    if (u.startsWith('https://public.doubletick.io/')) {
      let parsed = null; try { parsed = JSON.parse(opts && opts.body || 'null'); } catch {}
      doubletickCalls.push({ url: u, headers: (opts && opts.headers) || {}, body: parsed });
      return Promise.resolve(new Response(JSON.stringify({ messages: [{ id: 'wa-' + doubletickCalls.length }] }), { status: 200 }));
    }
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

  it('books the first available slot end-to-end: Zoom fallback, NO fake calendar id, stage -> interview, emails sent', async () => {
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
    // GOOGLE_CALENDAR_ID is blank in this suite, i.e. no calendar connected.
    // This used to store a fabricated 'gcal_local_N' id, which reads like a
    // real Google event and is exactly what disguised the fact that
    // production had never been connected (owner report 2026-07-29). With no
    // calendar there is no event, and the row must say so.
    // null, not '' — these id columns are now nulled when there is no real
    // id, because zoom_meeting_id carries a UNIQUE index and '' collided
    // across every zoomless row (2026-07-29). Still 'no fake calendar id'.
    expect(row.gcal_event_id == null || row.gcal_event_id === '').toBe(true);
    expect(String(row.gcal_event_id || '')).not.toMatch(/^gcal_local/);
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

    // WhatsApp confirmations to BOTH the doctor and the practice's primary
    // contact, each carrying the join link. Email alone left a practice contact
    // who hadn't opened their inbox with no way into the call.
    const waSends = doubletickCalls.filter((c) => c.url.includes('/whatsapp/message/template'));
    const waFor = (name) => waSends.find((c) => c.body
      && c.body.messages && c.body.messages[0]
      && c.body.messages[0].content.templateName === name);

    const waGp = waFor('gp_link_interview_confirmed_gp');
    const waPractice = waFor('gp_link_interview_confirmed_practice');
    expect(waGp).toBeTruthy();
    expect(waPractice).toBeTruthy();

    // Right recipients.
    expect(waGp.body.messages[0].to).toContain('447700900001');
    expect(waPractice.body.messages[0].to).toContain('61400111222');

    // Both carry the SAME join link the emails and the row carry.
    const gpPlaceholders = waGp.body.messages[0].content.templateData.body.placeholders;
    const prPlaceholders = waPractice.body.messages[0].content.templateData.body.placeholders;
    expect(gpPlaceholders).toHaveLength(4);
    expect(prPlaceholders).toHaveLength(4);
    expect(gpPlaceholders[3]).toBe(row.zoom_join_url);
    expect(prPlaceholders[3]).toBe(row.zoom_join_url);
    // Addressed by name, and naming the other party.
    expect(gpPlaceholders[0]).toBe('Interview');
    expect(gpPlaceholders[1]).toBe('Greenslopes Family Medical');
    expect(prPlaceholders[0]).toBe('Anna Manager');
    expect(prPlaceholders[1]).toContain('Interview Doctor');

    // The auth header must be the RAW key. A 'Bearer ' prefix is what made
    // every interview WhatsApp 403 silently before this (2026-09-06).
    expect(waGp.headers.Authorization).toBe('test-doubletick-key');
    expect(String(waGp.headers.Authorization)).not.toMatch(/^Bearer /);

    // In Supabase mode with NO calendar connected, nothing is written to the
    // local fakeCalendar stand-in either. That store exists so local/dev runs
    // can simulate a diary; writing to it from a Supabase-backed deployment
    // just produced a file nobody reads and a fake id on the real row. The
    // stand-in is still exercised by the local-mode paths.
    const localDb = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    expect(localDb.fakeCalendar === undefined || localDb.fakeCalendar.length === 0).toBe(true);
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

// Viewer-timezone feature (owner req): "interview times for practices and
// medical centres should be translated to the location of the GP or the
// practice contact, and should clearly show what timezone they are booking in."
// The browser's device tz (viewer_tz) is submitted with the availability POST
// and the booking POST; the server validates it hard and prefers it over the
// state/country-derived guesses for window interpretation + email time labels.
describe('viewer timezone: availability windows + booking labels', () => {
  const ymdPlus = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const toOf = (c) => (Array.isArray(c.body.to) ? c.body.to : [c.body.to]).join(',');

  it('(a) availability with viewer_tz Australia/Perth on an NSW-state practice: windows interpreted in Perth time', async () => {
    const D = ymdPlus(5);
    const r = await httpReq('POST', '/api/practice/application/availability', {
      body: { token: 'tok-int-nsw-000000001', windows: [{ date: D, fromMin: 1080, toMin: 1200 }], viewer_tz: 'Australia/Perth' }
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const row = db.scheduled_calls.find((c) => c.application_id === 'app-int-nsw' && c.meeting_kind === 'interview');
    expect(row).toBeTruthy();
    expect(row.practice_availability_status).toBe('received');
    // The validated viewer tz is stored WITH the windows (inside the same JSONB).
    expect(row.practice_availability_windows[0].tz).toBe('Australia/Perth');

    const slotsRes = await gpGet('/api/career/interview/slots?applicationId=app-int-nsw', GP);
    expect(slotsRes.status).toBe(200);
    expect(slotsRes.body.slots.length).toBeGreaterThan(0);
    // Concrete UTC: 18:00 in Perth (UTC+8, no DST) on D = D 10:00Z. The NSW
    // state-derived guess (Australia/Sydney) would put it at D 08:00Z (AEST).
    expect(slotsRes.body.slots[0].startUtc).toBe(D + 'T10:00:00.000Z');
    // The practice-local slot labels speak the contact's tz too.
    expect(slotsRes.body.slots[0].local.practice.tz).toBe('Australia/Perth');
  });

  it('(b) invalid viewer_tz is ignored — windows fall back to the state-derived practice tz', async () => {
    const D = ymdPlus(6);
    const r = await httpReq('POST', '/api/practice/application/availability', {
      body: { token: 'tok-int-nsw-000000002', windows: [{ date: D, fromMin: 1080, toMin: 1200 }], viewer_tz: 'Mars/OlympusMons' }
    });
    expect(r.status).toBe(200);

    const row = db.scheduled_calls.find((c) => c.application_id === 'app-int-nsw2' && c.meeting_kind === 'interview');
    expect(row.practice_availability_status).toBe('received');
    // No tz key persisted for an invalid viewer_tz.
    expect(row.practice_availability_windows[0].tz).toBeUndefined();

    const slotsRes = await gpGet('/api/career/interview/slots?applicationId=app-int-nsw2', GP2);
    expect(slotsRes.status).toBe(200);
    expect(slotsRes.body.slots.length).toBeGreaterThan(0);
    // DST-proof concrete expectation: 18:00 Sydney wall time on D, whatever
    // offset applies that day (AEST/AEDT). wallTimeToUtc is unit-tested
    // independently in tests/interview-scheduler.test.js.
    const expected = sched.wallTimeToUtc(D, 1080, 'Australia/Sydney').toISOString();
    expect(slotsRes.body.slots[0].startUtc).toBe(expected);
    expect(slotsRes.body.slots[0].startUtc).not.toBe(D + 'T10:00:00.000Z'); // NOT the Perth reading
    expect(slotsRes.body.slots[0].local.practice.tz).toBe('Australia/Sydney');
  });

  it('(c)+(d) booking with viewer_tz persists it on the row; GP email renders in it; practice email prefers the availability tz', async () => {
    const slotsRes = await gpGet('/api/career/interview/slots?applicationId=app-int-nsw', GP);
    expect(slotsRes.body.slots.length).toBeGreaterThan(0);
    const slot = slotsRes.body.slots[0];

    const before = resendCalls.length;
    const r = await gpPost('/api/career/interview/book', { applicationId: 'app-int-nsw', slot_start_utc: slot.startUtc, viewer_tz: 'Pacific/Auckland' }, GP);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // (c) persisted on the EXISTING scheduled_calls.timezone column — the same
    // column Calendly bookings use for the invitee tz, and the same one the
    // reminder cron already reads for the GP reminder label. No new column.
    const row = db.scheduled_calls.find((c) => c.application_id === 'app-int-nsw' && c.meeting_kind === 'interview');
    expect(row.status).toBe('booked');
    expect(row.timezone).toBe('Pacific/Auckland');

    const sends = resendCalls.slice(before);
    const gpSend = sends.find((c) => toOf(c).includes(GP.email));
    expect(gpSend).toBeTruthy();
    // GP confirmation speaks the tz the GP actually booked in (NZST/NZDT), not
    // the registration-country guess (Europe/London → BST/GMT).
    expect(gpSend.body.text).toMatch(/NZ[SD]T/);
    expect(gpSend.body.text).not.toMatch(/\bBST\b|\bGMT\b/);

    // (d) practice confirmation prefers the stored availability tz (Perth),
    // not the NSW state guess (AEST/AEDT).
    const practiceSend = sends.find((c) => toOf(c).includes('frontdesk@nsw-practice-test.local'));
    expect(practiceSend).toBeTruthy();
    expect(practiceSend.body.text).toContain('AWST');
    expect(practiceSend.body.text).not.toMatch(/AE[SD]T/);
  });

  it('(c-fallback) booking with an invalid viewer_tz persists nothing and falls back to country-derived labels', async () => {
    const slotsRes = await gpGet('/api/career/interview/slots?applicationId=app-int-nsw2', GP2);
    expect(slotsRes.body.slots.length).toBeGreaterThan(0);
    const slot = slotsRes.body.slots[0];

    const r = await gpPost('/api/career/interview/book', { applicationId: 'app-int-nsw2', slot_start_utc: slot.startUtc, viewer_tz: 'Mars/OlympusMons' }, GP2);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    const row = db.scheduled_calls.find((c) => c.application_id === 'app-int-nsw2' && c.meeting_kind === 'interview');
    expect(row.status).toBe('booked');
    expect(row.timezone == null).toBe(true); // invalid viewer_tz is never persisted
  });
});

// Owner rule (2026-07-23): booking an interview time IS the acceptance. So when
// the application still has a live 'sent' in-app offer, the booking flow must
// auto-accept it — flip the offer to 'accepted' and mark the application
// interview_scheduled — and quietly notify the consultant (offer sender) ONCE.
describe('POST /api/career/interview/book — booking accepts the offer', () => {
  const senderMail = () => resendCalls.filter((c) => (Array.isArray(c.body.to) ? c.body.to : [c.body.to]).some((t) => String(t || '').includes(SUPER_EMAIL)));

  it('flips the sent offer → accepted and lands the application on interview_scheduled', async () => {
    const slotsRes = await gpGet('/api/career/interview/slots?applicationId=app-int-offer', GP_OFF);
    expect(slotsRes.status).toBe(200);
    expect(slotsRes.body.slots.length).toBeGreaterThan(0);
    const slot = slotsRes.body.slots[0];

    // Precondition: offer still 'sent'.
    expect(db.ats_offers.find((o) => o.application_id === 'app-int-offer').status).toBe('sent');
    const sendersBefore = senderMail().length;

    const r = await gpPost('/api/career/interview/book', { applicationId: 'app-int-offer', slot_start_utc: slot.startUtc }, GP_OFF);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.booked.scheduled_at).toBe(slot.startUtc);

    // Booking IS the acceptance: offer → accepted (with a response timestamp).
    const offer = db.ats_offers.find((o) => o.application_id === 'app-int-offer');
    expect(offer.status).toBe('accepted');
    expect(offer.responded_at).toBeTruthy();
    // The application lands on interview_scheduled (forward-only status).
    const app = db.gp_applications.find((a) => a.id === 'app-int-offer');
    expect(app.status).toBe('interview_scheduled');
    expect(app.ats_stage).toBe('interview');
    // Exactly one quiet consultant note (the offer sender), on this transition.
    expect(senderMail().length).toBe(sendersBefore + 1);
    expect(String(senderMail().slice(-1)[0].body.subject).toLowerCase()).toContain('interview invitation');
  });

  it('re-booking is idempotent — no re-flip, no second consultant note', async () => {
    const row = db.scheduled_calls.find((c) => c.application_id === 'app-int-offer' && c.meeting_kind === 'interview');
    const sendersBefore = senderMail().length;
    const r = await gpPost('/api/career/interview/book', { applicationId: 'app-int-offer', slot_start_utc: row.scheduled_at }, GP_OFF);
    expect(r.status).toBe(200);
    expect(r.body.already).toBe(true);
    // Offer stays accepted; the sent→accepted transition already fired the note.
    expect(db.ats_offers.find((o) => o.application_id === 'app-int-offer').status).toBe('accepted');
    expect(senderMail().length).toBe(sendersBefore);
  });
});

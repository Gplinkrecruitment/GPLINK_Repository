// Phase 5 Task 3 — ATS interview-management gaps A1/A2/A4.
//
// Reuses the in-memory PostgREST emulator + fetch-mocking harness from
// tests/career-interview-booking.test.js so the real server drives the full
// 3-way scheduler AND every Resend email is captured (RESEND_API_KEY set +
// global fetch wrapped). Zoom/GCal run in local fallback mode (no creds), so
// booked interview rows carry zoom_local_* ids and the cancel path's Zoom
// delete is skipped (guarded), never hitting the network.
//
// Covers:
//  A1  POST /api/ats/interview/use-default-times flips practice availability to
//      'defaulted' so slots compute immediately (super + consultant sessions).
//  A2  POST /api/ats/interview/cancel: booked -> cancelled, GP + practice
//      cancellation emails, a fresh rebookable interview row (defaulted), and a
//      new booking succeeds; 404 (no interview) and 409 (not booked) guards.
//  A4  _bookInterviewSlot also emails the ops inbox hello@mygplink.com.au on a
//      booking.
//  UI  static pins for the candidate + meetings JS and the bumped cache-busters.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = path.join('/tmp', `gplink-ats-int-mgmt-${RUN_ID}.json`);
const SUPER_HOST = 'ats-mgmt.local';
let server, port;
let sbServer, sbPort;

const GP = { userId: 'u-mgmt-gp-1', email: 'gp-mgmt@gplink-test.local' };
const SUPER_EMAIL = 'super@gplink-test.local';
const CONSULTANT_EMAIL = 'consultant-mgmt@gplink-test.local';
const NOW = new Date().toISOString();

const resendCalls = [];

const REVEALED = { status: 'offered', ats_stage: 'offer', revealed: true, practice_submission_status: 'client_approved' };

const db = {
  user_profiles: [
    { user_id: GP.userId, email: GP.email, first_name: 'Mgmt', last_name: 'Doctor', registration_country: 'uk' }
  ],
  user_state: [],
  registration_cases: [
    { id: 'case-mgmt-1', user_id: GP.userId, status: 'active', assigned_rso: null, assigned_va: null }
  ],
  practices: [
    { id: 'p-mgmt-1', name: 'Greenslopes Family Medical', source: 'internal_ats', contact_name: 'Anna Manager', contact_email: 'anna@greenslopes-test.local', is_active: true, created_at: NOW }
  ],
  career_roles: [
    { id: 'role-mgmt-1', provider: 'internal_ats', provider_role_id: 'ats_mgmt_r1', title: 'GP — VR (default-times)', practice_name: 'Greenslopes Family Medical', practice_id: 'p-mgmt-1', location_city: 'Brisbane', location_state: 'QLD', is_active: true, job_status: 'open', updated_at: NOW },
    { id: 'role-mgmt-2', provider: 'internal_ats', provider_role_id: 'ats_mgmt_r2', title: 'GP — VR (cancel-rebook)', practice_name: 'Greenslopes Family Medical', practice_id: 'p-mgmt-1', location_city: 'Brisbane', location_state: 'QLD', is_active: true, job_status: 'open', updated_at: NOW },
    { id: 'role-mgmt-3', provider: 'internal_ats', provider_role_id: 'ats_mgmt_r3', title: 'GP — VR (no-interview)', practice_name: 'Greenslopes Family Medical', practice_id: 'p-mgmt-1', location_city: 'Brisbane', location_state: 'QLD', is_active: true, job_status: 'open', updated_at: NOW },
    { id: 'role-mgmt-4', provider: 'internal_ats', provider_role_id: 'ats_mgmt_r4', title: 'GP — VR (not-booked)', practice_name: 'Greenslopes Family Medical', practice_id: 'p-mgmt-1', location_city: 'Brisbane', location_state: 'QLD', is_active: true, job_status: 'open', updated_at: NOW },
    { id: 'role-mgmt-5', provider: 'internal_ats', provider_role_id: 'ats_mgmt_r5', title: 'GP — VR (consultant)', practice_name: 'Greenslopes Family Medical', practice_id: 'p-mgmt-1', location_city: 'Brisbane', location_state: 'QLD', is_active: true, job_status: 'open', updated_at: NOW }
  ],
  gp_applications: [
    { id: 'app-mgmt-1', user_id: GP.userId, career_role_id: 'role-mgmt-1', provider_role_id: 'ats_mgmt_r1', applied_at: NOW, ...REVEALED },
    { id: 'app-mgmt-2', user_id: GP.userId, career_role_id: 'role-mgmt-2', provider_role_id: 'ats_mgmt_r2', applied_at: NOW, ...REVEALED },
    { id: 'app-mgmt-3', user_id: GP.userId, career_role_id: 'role-mgmt-3', provider_role_id: 'ats_mgmt_r3', applied_at: NOW, ...REVEALED },
    { id: 'app-mgmt-4', user_id: GP.userId, career_role_id: 'role-mgmt-4', provider_role_id: 'ats_mgmt_r4', applied_at: NOW, ...REVEALED },
    { id: 'app-mgmt-5', user_id: GP.userId, career_role_id: 'role-mgmt-5', provider_role_id: 'ats_mgmt_r5', applied_at: NOW, ...REVEALED }
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
      const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      if (!m) { send(404, { message: 'not found' }); return; }
      const table = decodeURIComponent(m[1]);
      const rows = tableOf(table);
      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out); return;
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
          rows.push(row); return row;
        });
        send(201, saved); return;
      }
      if (req.method === 'PATCH') {
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched); return;
      }
      if (req.method === 'DELETE') {
        const keep = rows.filter((row) => !matches(row));
        rows.length = 0; keep.forEach((row) => rows.push(row));
        send(200, []); return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function b64url(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function sign(payload) { return crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex'); }
function userCookie(email, supabaseUserId) {
  const payload = b64url(JSON.stringify({ userProfile: { email, supabaseUserId }, expiresAt: Date.now() + 3600000 }));
  return 'gp_session=' + encodeURIComponent(payload + '.' + sign(payload));
}
function adminCookie(email, role) {
  const payload = b64url(JSON.stringify({ userProfile: { email, adminRole: role }, expiresAt: Date.now() + 3600000 }));
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sign(payload));
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

// Session helpers.
const gpGet = (p) => httpReq('GET', p, { cookie: userCookie(GP.email, GP.userId) });
const gpPost = (p, body) => httpReq('POST', p, { cookie: userCookie(GP.email, GP.userId), body });
const atsGet = (p) => httpReq('GET', p, { host: SUPER_HOST, cookie: adminCookie(SUPER_EMAIL, 'super_admin') });
const atsPost = (p, body) => httpReq('POST', p, { host: SUPER_HOST, cookie: adminCookie(SUPER_EMAIL, 'super_admin'), body });
const consultantPost = (p, body) => httpReq('POST', p, { host: SUPER_HOST, cookie: adminCookie(CONSULTANT_EMAIL, 'consultant'), body });

const toList = (c) => (Array.isArray(c && c.body && c.body.to) ? c.body.to : [c && c.body && c.body.to]).map((x) => String(x || '').toLowerCase());
const emailsTo = (addr) => resendCalls.filter((c) => toList(c).includes(String(addr).toLowerCase()));

// The cancel + ATS-book notify paths fire-and-forget, so poll briefly.
async function waitFor(pred, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

let realFetch;

beforeAll(async () => {
  await startSupabaseEmulator();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'ats-int-mgmt-secret-' + RUN_ID;
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
  process.env.ANTHROPIC_API_KEY = '';
  process.env.ZOOM_ACCOUNT_ID = '';
  process.env.ZOOM_CLIENT_ID = '';
  process.env.ZOOM_CLIENT_SECRET = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = '';
  process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = '';
  process.env.GOOGLE_CALENDAR_ID = '';
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = SUPER_EMAIL;
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

describe('A1 — POST /api/ats/interview/use-default-times', () => {
  it('flips a stuck "requested" interview to "defaulted" so slots compute', async () => {
    // Request an interview (leaves practice availability 'requested').
    const reqRes = await atsPost('/api/ats/interview/request', { application_id: 'app-mgmt-1' });
    expect(reqRes.status).toBe(200);

    // Before: 'requested' -> no bookable slots.
    const before = await atsGet('/api/ats/interview/slots?application_id=app-mgmt-1&now=2026-07-01T00:00:00Z');
    expect(before.status).toBe(200);
    expect(before.body.status).toBe('requested');
    expect(before.body.slots.length).toBe(0);

    // Force standard times.
    const ud = await atsPost('/api/ats/interview/use-default-times', { applicationId: 'app-mgmt-1' });
    expect(ud.status).toBe(200);
    expect(ud.body.ok).toBe(true);
    expect(ud.body.status).toBe('defaulted');

    const row = db.scheduled_calls.find((c) => c.application_id === 'app-mgmt-1' && c.meeting_kind === 'interview');
    expect(row.practice_availability_status).toBe('defaulted');

    // After: slots now compute.
    const after = await atsGet('/api/ats/interview/slots?application_id=app-mgmt-1&now=2026-07-01T00:00:00Z');
    expect(after.status).toBe(200);
    expect(after.body.status).toBe('defaulted');
    expect(after.body.slots.length).toBeGreaterThan(0);
  });

  it('404s when no interview row exists for the application', async () => {
    const r = await atsPost('/api/ats/interview/use-default-times', { applicationId: 'app-mgmt-3' });
    expect(r.status).toBe(404);
  });

  it('401s without an admin session', async () => {
    const r = await httpReq('POST', '/api/ats/interview/use-default-times', { host: SUPER_HOST, body: { applicationId: 'app-mgmt-1' } });
    expect(r.status).toBe(401);
  });

  it('is allowed for a consultant session', async () => {
    await consultantPost('/api/ats/interview/request', { application_id: 'app-mgmt-5' });
    const r = await consultantPost('/api/ats/interview/use-default-times', { applicationId: 'app-mgmt-5' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.status).toBe('defaulted');
  });
});

describe('A4 + A2 — book (ops-notified) then cancel & rebook', () => {
  it('A4: booking an interview also emails the ops inbox hello@mygplink.com.au', async () => {
    // GP self-serve slots auto-creates a 'defaulted' row; book the first slot.
    const slotsRes = await gpGet('/api/career/interview/slots?applicationId=app-mgmt-2');
    expect(slotsRes.status).toBe(200);
    expect(slotsRes.body.slots.length).toBeGreaterThan(0);
    const slot = slotsRes.body.slots[0];

    const beforeOps = emailsTo('hello@mygplink.com.au').length;
    const book = await gpPost('/api/career/interview/book', { applicationId: 'app-mgmt-2', slot_start_utc: slot.startUtc });
    expect(book.status).toBe(200);
    expect(book.body.ok).toBe(true);

    const opsMails = emailsTo('hello@mygplink.com.au');
    expect(opsMails.length).toBeGreaterThan(beforeOps);
    const opsMail = opsMails[opsMails.length - 1];
    expect(String(opsMail.body.subject)).toMatch(/booked an interview/i);
    expect(String(opsMail.body.text)).toContain('/pages/ceo-dashboard?case=');

    const row = db.scheduled_calls.find((c) => c.application_id === 'app-mgmt-2' && c.meeting_kind === 'interview' && c.status === 'booked');
    expect(row).toBeTruthy();
  });

  it('A2: cancels the booked interview (cancelled row + GP/practice emails) and stays rebookable', async () => {
    const beforeGp = emailsTo(GP.email).length;
    const beforePractice = emailsTo('anna@greenslopes-test.local').length;

    const cancel = await atsPost('/api/ats/interview/cancel', { applicationId: 'app-mgmt-2', reason: 'Practice double-booked' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.ok).toBe(true);
    expect(cancel.body.cancelled).toBe(true);
    expect(cancel.body.rebookable).toBe(true);

    // The old booked row is now cancelled.
    const cancelledRows = db.scheduled_calls.filter((c) => c.application_id === 'app-mgmt-2' && c.meeting_kind === 'interview' && c.status === 'cancelled');
    expect(cancelledRows.length).toBe(1);

    // A fresh, non-cancelled interview row exists, pre-cleared to 'defaulted'.
    const liveRows = db.scheduled_calls.filter((c) => c.application_id === 'app-mgmt-2' && c.meeting_kind === 'interview' && c.status !== 'cancelled');
    expect(liveRows.length).toBe(1);
    expect(liveRows[0].status).not.toBe('booked');
    expect(liveRows[0].practice_availability_status).toBe('defaulted');

    // GP + practice were notified (fire-and-forget → poll).
    await waitFor(() => emailsTo(GP.email).length > beforeGp && emailsTo('anna@greenslopes-test.local').length > beforePractice);
    const gpMail = emailsTo(GP.email).pop();
    expect(String(gpMail.body.subject)).toMatch(/cancel/i);
    expect(emailsTo('anna@greenslopes-test.local').length).toBeGreaterThan(beforePractice);

    // D1a: both cancellation emails carry a CANCEL-method .ics with the SAME
    // UID the booking invite used (the cancelled row's id) and SEQUENCE 1, so
    // recipient calendars remove the original event.
    const practiceMail = emailsTo('anna@greenslopes-test.local').pop();
    for (const mail of [gpMail, practiceMail]) {
      expect(Array.isArray(mail.body.attachments)).toBe(true);
      expect(mail.body.attachments.length).toBe(1);
      const att = mail.body.attachments[0];
      expect(att.filename).toBe('interview.ics');
      expect(att.content_type).toBe('text/calendar');
      const ics = Buffer.from(att.content, 'base64').toString('utf8');
      expect(ics).toContain('METHOD:CANCEL');
      expect(ics).toContain('STATUS:CANCELLED');
      expect(ics).toContain('SEQUENCE:1');
      expect(ics).toContain('UID:gplink-interview-' + cancelledRows[0].id + '@mygplink.com.au');
    }
  });

  it('A2: the interview is rebookable — GP can pick a new slot and book again', async () => {
    const slotsRes = await gpGet('/api/career/interview/slots?applicationId=app-mgmt-2');
    expect(slotsRes.status).toBe(200);
    expect(slotsRes.body.slots.length).toBeGreaterThan(0);
    const slot = slotsRes.body.slots[0];
    const book = await gpPost('/api/career/interview/book', { applicationId: 'app-mgmt-2', slot_start_utc: slot.startUtc });
    expect(book.status).toBe(200);
    expect(book.body.ok).toBe(true);
    const booked = db.scheduled_calls.filter((c) => c.application_id === 'app-mgmt-2' && c.meeting_kind === 'interview' && c.status === 'booked');
    expect(booked.length).toBe(1);
  });

  it('A2: 404 when there is no interview to cancel', async () => {
    const r = await atsPost('/api/ats/interview/cancel', { applicationId: 'app-mgmt-3' });
    expect(r.status).toBe(404);
  });

  it('A2: 409 when the interview exists but is not booked', async () => {
    await atsPost('/api/ats/interview/request', { application_id: 'app-mgmt-4' }); // status 'invited', not booked
    const r = await atsPost('/api/ats/interview/cancel', { applicationId: 'app-mgmt-4' });
    expect(r.status).toBe(409);
  });

  it('A2: cancel is allowed for a consultant session', async () => {
    // Book app-mgmt-5 (already defaulted from A1 consultant test) then cancel as consultant.
    const slotsRes = await gpGet('/api/career/interview/slots?applicationId=app-mgmt-5');
    expect(slotsRes.body.slots.length).toBeGreaterThan(0);
    await gpPost('/api/career/interview/book', { applicationId: 'app-mgmt-5', slot_start_utc: slotsRes.body.slots[0].startUtc });
    const r = await consultantPost('/api/ats/interview/cancel', { applicationId: 'app-mgmt-5' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

describe('UI static pins', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('candidate card wires the paste-reply, use-standard-times, and cancel actions', () => {
    const js = read('js/ceo-ats-candidates.js');
    expect(js).toContain('ats-int-paste-reply');
    expect(js).toContain('ats-int-use-default');
    expect(js).toContain('ats-int-cancel');
    expect(js).toContain('atsPastePracticeReply');
    expect(js).toContain('/api/ats/interview/ingest-reply');
    expect(js).toContain('/api/ats/interview/use-default-times');
    expect(js).toContain('/api/ats/interview/cancel');
  });

  it('meetings tab wires a cancel-and-rebook control', () => {
    const js = read('js/ceo-ats-meetings.js');
    expect(js).toContain('mtg-cancel-btn');
    expect(js).toContain('/api/ats/interview/cancel');
  });

  it('ceo-dashboard bumps the cache-busters for the changed ATS scripts', () => {
    const html = read('pages/ceo-dashboard.html');
    expect(html).toContain('ceo-ats-candidates.js?v=20260730a');
    expect(html).toContain('ceo-ats-meetings.js?v=20260724b');
  });
});

// Owner report 2026-07-29. When working out which times to offer, the
// scheduler only ever looked at other INTERVIEWS — a consultation already in
// the diary blocked nothing. Google Calendar was meant to cover that, but it
// is gated on GOOGLE_CALENDAR_ID (blank here, and unset in production at the
// time), so gcalReadBusy returned an empty busy list and nothing stopped an
// interview being offered straight over a booked consult.
describe('interview slots avoid booked CONSULTATIONS, not just other interviews', () => {
  const SLOTS_URL = '/api/ats/interview/slots?application_id=app-mgmt-1&now=2026-07-01T00:00:00Z';

  // Deterministic setup: make sure app-mgmt-1 has an interview row whose
  // practice availability is 'defaulted', regardless of what ran before.
  async function ensureSlotsCompute() {
    let row = db.scheduled_calls.find((c) => c.application_id === 'app-mgmt-1' && c.meeting_kind === 'interview');
    if (!row) {
      await atsPost('/api/ats/interview/request', { application_id: 'app-mgmt-1' });
      row = db.scheduled_calls.find((c) => c.application_id === 'app-mgmt-1' && c.meeting_kind === 'interview');
    }
    expect(row).toBeTruthy();
    row.practice_availability_status = 'defaulted';
  }

  it('drops the slot a booked consultation sits on, and keeps the rest', async () => {
    await ensureSlotsCompute();

    const before = await atsGet(SLOTS_URL);
    expect(before.status).toBe(200);
    expect(before.body.slots.length).toBeGreaterThan(0);
    const target = before.body.slots[0].startUtc;

    // Exactly the shape Calendly writes: meeting_kind 'consultation',
    // status 'booked', the schema's 30-minute default duration.
    db.scheduled_calls.push({
      id: 'consult-clash-1', meeting_kind: 'consultation', status: 'booked',
      scheduled_at: target, duration_minutes: 30, created_by: 'calendly_direct'
    });

    const after = await atsGet(SLOTS_URL);
    expect(after.status).toBe(200);
    expect(after.body.slots.some((s) => s.startUtc === target)).toBe(false);
    // The consult removes one time, it does not switch the feature off.
    expect(after.body.slots.length).toBeGreaterThan(0);

    db.scheduled_calls = db.scheduled_calls.filter((r) => r.id !== 'consult-clash-1');
  });

  it('a CANCELLED consultation blocks nothing', async () => {
    await ensureSlotsCompute();

    const before = await atsGet(SLOTS_URL);
    const target = before.body.slots[0].startUtc;
    db.scheduled_calls.push({
      id: 'consult-cancelled-1', meeting_kind: 'consultation', status: 'cancelled',
      scheduled_at: target, duration_minutes: 30
    });

    const after = await atsGet(SLOTS_URL);
    expect(after.body.slots.some((s) => s.startUtc === target)).toBe(true);

    db.scheduled_calls = db.scheduled_calls.filter((r) => r.id !== 'consult-cancelled-1');
  });

  it('never persists a fake gcal_local_ id on a row in Supabase mode', () => {
    // An unconfigured calendar used to write 'gcal_local_1' onto the real row,
    // which reads like a genuine Google event and hid the fact that nothing
    // had reached anyone's diary.
    const faked = db.scheduled_calls.filter((r) => String(r && r.gcal_event_id || '').startsWith('gcal_local'));
    expect(faked).toEqual([]);
  });
});

// Owner request 2026-07-29: leave a gap either side of anything
// already in the diary, so a meeting running over doesn't eat the next one and
// there is room to prepare. Implemented by widening busy blocks, NOT by
// shortening the interview.
describe('interview slots leave a gap either side of an existing meeting', () => {
  const SLOTS_URL = '/api/ats/interview/slots?application_id=app-mgmt-1&now=2026-07-01T00:00:00Z';
  // Matches INTERVIEW_GAP_MINUTES' default, which is deliberately kept equal
  // to the Calendly buffer — the gap a doctor experiences is the smaller of the
  // two, so they are changed together.
  const GAP_MIN = 10;
  const INTERVIEW_MIN = 45;

  async function ensureSlotsCompute() {
    let row = db.scheduled_calls.find((c) => c.application_id === 'app-mgmt-1' && c.meeting_kind === 'interview');
    if (!row) {
      await atsPost('/api/ats/interview/request', { application_id: 'app-mgmt-1' });
      row = db.scheduled_calls.find((c) => c.application_id === 'app-mgmt-1' && c.meeting_kind === 'interview');
    }
    row.practice_availability_status = 'defaulted';
  }

  it('never offers a slot that starts within the gap of a consult ending', async () => {
    await ensureSlotsCompute();

    const before = await atsGet(SLOTS_URL);
    expect(before.body.slots.length).toBeGreaterThan(0);
    // Anchor a 30-minute consult so it ENDS exactly where a known slot starts.
    const anchor = new Date(before.body.slots[0].startUtc).getTime();
    const consultStart = new Date(anchor - 30 * 60000).toISOString();
    db.scheduled_calls.push({
      id: 'consult-gap-1', meeting_kind: 'consultation', status: 'booked',
      scheduled_at: consultStart, duration_minutes: 30
    });

    const after = await atsGet(SLOTS_URL);
    const consultEnd = new Date(consultStart).getTime() + 30 * 60000;

    // Back-to-back is exactly what we are ruling out: without the gap the slot
    // at `anchor` (== consultEnd) would still be offered.
    expect(after.body.slots.some((s) => new Date(s.startUtc).getTime() === anchor)).toBe(false);

    // Every surviving slot keeps the full gap on BOTH sides of the consult.
    after.body.slots.forEach((s) => {
      const start = new Date(s.startUtc).getTime();
      const end = start + INTERVIEW_MIN * 60000;
      const clearBefore = end <= new Date(consultStart).getTime() - GAP_MIN * 60000;
      const clearAfter = start >= consultEnd + GAP_MIN * 60000;
      expect(clearBefore || clearAfter).toBe(true);
    });

    db.scheduled_calls = db.scheduled_calls.filter((r) => r.id !== 'consult-gap-1');
  });

  it('still returns plenty of times — the gap trims, it does not empty the list', async () => {
    await ensureSlotsCompute();
    const r = await atsGet(SLOTS_URL);
    expect(r.body.slots.length).toBeGreaterThan(3);
  });
});

// Review finding 2026-07-29. Cancelling an interview deleted the Zoom meeting
// but knowingly left the Google Calendar event in place. That was harmless
// while no real events were ever created; the moment the calendar was
// connected it meant a cancelled interview blocked that time forever — against
// Calendly's conflict check, against our own slot computation, and visibly in
// the diary. Cancel is ALSO the rebook path, so every reschedule stacked
// another phantom block.
describe('cancelling an interview clears it from the diary', () => {
  it('removes the calendar event, and frees the slot for re-offer', async () => {
    // Book an interview, capture the time it occupied.
    let row = db.scheduled_calls.find((c) => c.application_id === 'app-mgmt-1' && c.meeting_kind === 'interview');
    if (!row) {
      await atsPost('/api/ats/interview/request', { application_id: 'app-mgmt-1' });
      row = db.scheduled_calls.find((c) => c.application_id === 'app-mgmt-1' && c.meeting_kind === 'interview');
    }
    row.practice_availability_status = 'defaulted';

    const slots = await atsGet('/api/ats/interview/slots?application_id=app-mgmt-1&now=2026-07-01T00:00:00Z');
    const taken = slots.body.slots[0].startUtc;

    // Stand in for a real Google event id on a booked row.
    row.status = 'booked';
    row.scheduled_at = taken;
    row.gcal_event_id = 'evt_real_123';

    const cancelled = await atsPost('/api/ats/interview/cancel', { applicationId: 'app-mgmt-1' });
    expect(cancelled.status).toBe(200);

    const cancelledRow = db.scheduled_calls.find((c) => c.id === row.id);
    expect(cancelledRow.status).toBe('cancelled');

    // The freed time is offered again — proving nothing is still holding it.
    const fresh = db.scheduled_calls.find((c) => c.application_id === 'app-mgmt-1'
      && c.meeting_kind === 'interview' && c.status !== 'cancelled');
    expect(fresh).toBeTruthy();
    fresh.practice_availability_status = 'defaulted';
    const after = await atsGet('/api/ats/interview/slots?application_id=app-mgmt-1&now=2026-07-01T00:00:00Z');
    expect(after.body.slots.some((s) => s.startUtc === taken)).toBe(true);
  });
});

// The consultation reminders added on 2026-11-10 (lib/consult-reminders.js):
//   - a WhatsApp touch about an hour before the call (gp_link_consult_call_1h),
//     between the day-before and the "starts in 5 minutes" touches;
//   - two EMAIL reminders (day before, about an hour before) with their own
//     markers, so one channel failing never costs the doctor the other;
//   - the slot rendered on the lead's own clock instead of "(UK time)" for all;
//   - a WhatsApp reply around a consultation pages the owner at once, and the
//     "I'll be there" button stamps the booking instead.
//
// Pure rules first, then the real server in SUPABASE mode against a local
// PostgREST emulator (the reminder pass and the reply lookup both read
// scheduled_calls), with DoubleTick and Resend stubbed over HTTP.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';

const requireCjs = createRequire(import.meta.url);
const waLib = requireCjs('../lib/consult-whatsapp.js');
const rem = requireCjs('../lib/consult-reminders.js');

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-consult-reminders-${RUN_ID}.json`;
const CRON_SECRET = 'consult-reminders-secret-' + RUN_ID;
const CRON = '/api/cron/call-reminders';
const WEBHOOK = '/api/webhooks/doubletick?secret=test-dt-webhook';
const OWNER_PHONE = '+61400000000';

const MIN = 60 * 1000;
const H = 60 * MIN;

let server;
let port;
let sbServer;
let sbPort;
let dtServer;
let dtPort;
let resendServer;
let resendPort;
const dtCaptured = [];
const emails = [];
const db = { scheduled_calls: [], site_enquiries: [], doubletick_messages: [], user_profiles: [] };

// ---------------------------------------------------------------- emulator
const FILTER_OPS = ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'];

function buildMatcher(searchParams) {
  const reserved = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'or']);
  const filters = [];
  for (const [key, raw] of searchParams.entries()) {
    if (reserved.has(key)) continue;
    let negate = false;
    let rest = raw;
    if (rest.startsWith('not.')) { negate = true; rest = rest.slice(4); }
    const dot = rest.indexOf('.');
    const op = dot > 0 ? rest.slice(0, dot) : '';
    if (!FILTER_OPS.includes(op)) continue;
    filters.push({ col: key, op, val: rest.slice(dot + 1), negate });
  }
  return (row) => filters.every(({ col, op, val, negate }) => {
    const cell = row ? row[col] : undefined;
    let result;
    if (op === 'eq') result = String(cell) === val;
    else if (op === 'neq') result = String(cell) !== val;
    else if (op === 'is') result = val === 'null' ? (cell === null || cell === undefined) : String(cell) === val;
    else if (op === 'ilike' || op === 'like') {
      // The shared emulator in ai-matching-cron.test.js treats ilike as
      // match-everything, which would let findSiteEnquiryByEmail return another
      // test's lead. These reminders pick the recipient BY EMAIL, so the match
      // has to be real: translate the pattern honestly.
      const rx = new RegExp('^' + String(val).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$',
        op === 'ilike' ? 'i' : '');
      result = rx.test(String(cell == null ? '' : cell));
    } else if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
      if (cell === null || cell === undefined) { result = false; } else {
        const a = Date.parse(String(cell));
        const b = Date.parse(String(val));
        const [x, y] = (isFinite(a) && isFinite(b)) ? [a, b] : [String(cell), val];
        if (op === 'gt') result = x > y;
        else if (op === 'gte') result = x >= y;
        else if (op === 'lt') result = x < y;
        else result = x <= y;
      }
    } else result = true;
    return negate ? !result : result;
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { resolve(null); }
    });
  });
}

function startSupabaseEmulator() {
  return new Promise((resolve) => {
    sbServer = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://sb.local');
      const m = u.pathname.match(/^\/rest\/v1\/([^/]+)$/);
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (!m) { send(404, { message: 'not found' }); return; }
      const table = decodeURIComponent(m[1]);
      if (!db[table]) db[table] = [];
      const rows = db[table];
      const matches = buildMatcher(u.searchParams);
      if (req.method === 'GET') {
        let out = rows.filter(matches);
        const order = u.searchParams.get('order') || '';
        if (order.startsWith('scheduled_at')) {
          out = out.slice().sort((a, b) => Date.parse(a.scheduled_at || 0) - Date.parse(b.scheduled_at || 0));
        }
        const limit = parseInt(u.searchParams.get('limit') || '', 10);
        if (Number.isFinite(limit)) out = out.slice(0, limit);
        send(200, out);
        return;
      }
      if (req.method === 'PATCH') {
        const patch = await readBody(req);
        const matched = rows.filter(matches);
        matched.forEach((row) => Object.assign(row, patch || {}));
        send(200, matched);
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const incoming = Array.isArray(body) ? body : (body ? [body] : []);
        const saved = incoming.map((r) => {
          const row = Object.assign({ id: r.id || crypto.randomUUID() }, r);
          rows.push(row);
          return row;
        });
        send(201, saved);
        return;
      }
      send(405, { message: 'method not allowed' });
    });
    sbServer.listen(0, '127.0.0.1', () => { sbPort = sbServer.address().port; resolve(); });
  });
}

function startDoubleTickStub() {
  return new Promise((resolve) => {
    dtServer = http.createServer(async (req, res) => {
      const body = await readBody(req);
      dtCaptured.push({ path: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: [{ id: 'wa-stub' }] }));
    });
    dtServer.listen(0, '127.0.0.1', () => { dtPort = dtServer.address().port; resolve(); });
  });
}

function startResendStub() {
  return new Promise((resolve) => {
    resendServer = http.createServer(async (req, res) => {
      const body = await readBody(req);
      emails.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'email-stub-' + emails.length }));
    });
    resendServer.listen(0, '127.0.0.1', () => { resendPort = resendServer.address().port; resolve(); });
  });
}

function request(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: Object.assign({}, payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}, headers || {})
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* leave null */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const cron = () => request('GET', CRON, null, { Authorization: 'Bearer ' + CRON_SECRET });
let msgSeq = 0;
function inbound(from, text, extra) {
  msgSeq++;
  return request('POST', WEBHOOK, Object.assign({
    from: String(from).replace(/[^\d]/g, ''),
    message: { type: 'TEXT', text: text },
    messageId: 'msg-' + RUN_ID + '-' + msgSeq,
    contact: { name: 'Aisha Khan' }
  }, extra || {}));
}

// ---------------------------------------------------------------- seeding
const JOIN_URL = 'https://us06web.zoom.us/j/98765432101?pwd=abc';
let seq = 0;

function seedBooking(overrides = {}) {
  seq++;
  const email = overrides.invitee_email || `booker${seq}@doctors.org.uk`;
  const call = Object.assign({
    id: 'call-' + seq,
    invitee_email: email,
    user_id: null,
    meeting_kind: 'consultation',
    host_kind: 'ceo',
    status: 'booked',
    scheduled_at: new Date(Date.now() + 5 * H).toISOString(),
    booked_at: new Date(Date.now() - 30 * H).toISOString(),
    updated_at: new Date(Date.now() - 30 * H).toISOString(),
    zoom_join_url: JOIN_URL,
    notification_channels: null,
    invitee_notes: null,
    assigned_rso_email: null,
    reminder_sent_at: null,
    failed_attempt_count: 0
  }, overrides);
  db.scheduled_calls.push(call);
  return call;
}

function seedLead(email, overrides = {}) {
  seq++;
  const lead = Object.assign({
    id: 'lead-' + seq,
    created_at: new Date(Date.now() - 3 * 24 * H).toISOString(),
    kind: 'gp',
    name: 'Aisha Khan',
    email,
    phone: '+447700900' + String(100 + seq),
    status: 'new',
    metadata: { source: 'meta_lead_ad', consult: { token: 'TOK', qualified: true, call_booked: true, country: 'uk' } }
  }, overrides);
  db.site_enquiries.push(lead);
  return lead;
}

function templateSends(name) {
  return dtCaptured
    .filter((c) => c.path === '/whatsapp/message/template')
    .map((c) => c.body.messages[0])
    .filter((m) => !name || m.content.templateName === name);
}
const markersOf = (call) => ((call.notification_channels || {}).consult_reminders) || {};

beforeAll(async () => {
  await startSupabaseEmulator();
  await startDoubleTickStub();
  await startResendStub();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'consult-reminders-auth-' + RUN_ID;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_API_URL = `http://127.0.0.1:${resendPort}/emails`;
  process.env.DOUBLETICK_API_KEY = 'test-dt-key';
  process.env.DOUBLETICK_BASE_URL = `http://127.0.0.1:${dtPort}`;
  process.env.DOUBLETICK_WEBHOOK_SECRET = 'test-dt-webhook';
  process.env.CONSULT_OWNER_ALERT_PHONE = OWNER_PHONE;
  delete process.env.ANTHROPIC_API_KEY; // the inbound classifier must not call out
  delete process.env.SITE_ENQUIRY_NOTIFY_EMAIL;

  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  if (dtServer) await new Promise((r) => dtServer.close(r));
  if (resendServer) await new Promise((r) => resendServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

beforeEach(() => {
  Object.keys(db).forEach((k) => { db[k].length = 0; });
  dtCaptured.length = 0;
  emails.length = 0;
});

// ================================================================ pure rules
describe('the one-hour WhatsApp touch (consultCallReminderDecision)', () => {
  const now = Date.parse('2026-11-13T07:00:00Z');
  const at = (ms) => new Date(now + ms).toISOString();
  const consult = { soonMs: waLib.CONSULT_CALL_STARTING_SOON_MS, lateGraceMs: waLib.CONSULT_CALL_STARTING_LATE_GRACE_MS };
  const base = (over = {}) => Object.assign({ scheduledAt: at(60 * MIN), bookedAt: at(-30 * H), nowMs: now, markers: null }, consult, over);

  it('fires once between 70 and 30 minutes before the call, with the one-hour template', () => {
    const slot = at(60 * MIN);
    const d = waLib.consultCallReminderDecision(base({ markers: { call_at: slot, h24: at(-23 * H) } }));
    expect(d).toMatchObject({ action: 'send', window: 'h1', kind: 'call_hour_before' });
    expect(waLib.CONSULT_WA_TEMPLATES.call_hour_before.templateName).toBe('gp_link_consult_call_1h');
    // Every 5-minute tick from 70 down to 35 minutes is inside the window…
    for (const m of [70, 65, 55, 45, 35, 31]) {
      const s = at(m * MIN);
      expect(waLib.consultCallReminderDecision(base({ scheduledAt: s, markers: { call_at: s, h24: 'x' } })).window, m + ' min').toBe('h1');
    }
    // …and once it has gone it does not go again.
    expect(waLib.consultCallReminderDecision(base({ markers: { call_at: slot, h24: at(-23 * H), h1: at(-1 * MIN) } })))
      .toEqual({ action: 'skip', reason: 'already_sent' });
  });

  it('never fires outside its window, and never collides with the starting touch', () => {
    const far = at(71 * MIN);
    expect(waLib.consultCallReminderDecision(base({ scheduledAt: far, markers: { call_at: far, h24: 'x' } })))
      .toEqual({ action: 'skip', reason: 'already_sent' });
    const near = at(30 * MIN);
    expect(waLib.consultCallReminderDecision(base({ scheduledAt: near, markers: { call_at: near, h24: 'x' } })))
      .toEqual({ action: 'skip', reason: 'already_sent' });
    const soon = at(4 * MIN);
    expect(waLib.consultCallReminderDecision(base({ scheduledAt: soon, markers: { call_at: soon, h24: 'x', h1: 'y' } })))
      .toMatchObject({ action: 'send', window: 'soon', kind: 'call_starting' });
    expect(rem.HOUR_BEFORE_CLOSE_MS).toBeGreaterThan(waLib.CONSULT_CALL_STARTING_SOON_MS);
  });

  it('is skipped for a slot booked under 90 minutes ahead, and right after the day-before touch', () => {
    // Booked 80 minutes before the slot, now 60 minutes out.
    expect(waLib.consultCallReminderDecision(base({ bookedAt: at(-20 * MIN) })))
      .toEqual({ action: 'skip', reason: 'booked_late' });
    // Booked 100 minutes before the slot: fair game.
    expect(waLib.consultCallReminderDecision(base({ bookedAt: at(-40 * MIN) })).window).toBe('h1');
    // Booked 3.5 hours ahead: "coming up" went 2 hours after booking, 40 minutes ago.
    const slot = at(50 * MIN);
    expect(waLib.consultCallReminderDecision(base({ scheduledAt: slot, bookedAt: at(-160 * MIN), markers: { call_at: slot, h24: at(-40 * MIN) } })))
      .toEqual({ action: 'skip', reason: 'day_before_just_sent' });
  });

  it('stands in for a day-before touch that never went, without sending both', () => {
    // Booked 3 hours ahead: at 65 minutes out the day-before touch has not gone
    // yet (it waits 2 hours after booking). The one-hour touch goes instead…
    const slot = at(65 * MIN);
    const first = waLib.consultCallReminderDecision(base({ scheduledAt: slot, bookedAt: at(-115 * MIN) }));
    expect(first.window).toBe('h1');
    // …and "coming up" does not follow it once the window has closed.
    const later = at(20 * MIN);
    expect(waLib.consultCallReminderDecision(base({ scheduledAt: later, bookedAt: at(-160 * MIN), markers: { call_at: later, h1: 'sent' } })))
      .toEqual({ action: 'skip', reason: 'already_sent' });
  });

  it('a reschedule re-arms it, and the registration track never gets one', () => {
    const moved = at(60 * MIN);
    const d = waLib.consultCallReminderDecision(base({ scheduledAt: moved, markers: { call_at: at(9 * H), h24: 'x', h1: 'y', email_h1: 'z', confirmed_at: 'c' } }));
    expect(d.window).toBe('h1');
    expect(d.markers).toEqual({ call_at: moved });
    const reg = waLib.consultCallReminderDecision({
      scheduledAt: moved, bookedAt: at(-30 * H), nowMs: now, markers: { call_at: moved, h24: 'x' }, kinds: waLib.REGISTRATION_CALL_REMINDER_KIND
    });
    expect(reg).toEqual({ action: 'skip', reason: 'already_sent' });
    expect(waLib.REGISTRATION_CALL_REMINDER_KIND.h1).toBeUndefined();
  });

  it('builds [first name, time, link] and refuses to send without a link', () => {
    const msg = waLib.buildConsultWaMessage('call_hour_before', { name: 'Aisha Khan', callAtIso: '2026-11-13T08:00:00Z', whenText: '8:00 am (UK time)', joinUrl: JOIN_URL });
    expect(msg).toEqual({ templateName: 'gp_link_consult_call_1h', language: 'en', placeholders: ['Aisha', '8:00 am (UK time)', JOIN_URL] });
    expect(waLib.buildConsultWaMessage('call_hour_before', { name: 'A', callAtIso: '2026-11-13T08:00:00Z' })).toBe(null);
  });
});

describe('the email reminders (consultCallEmailReminderDecision)', () => {
  const now = Date.parse('2026-11-13T07:00:00Z');
  const at = (ms) => new Date(now + ms).toISOString();
  const base = (over = {}) => Object.assign({ scheduledAt: at(5 * H), bookedAt: at(-30 * H), nowMs: now, markers: {} }, over);

  it('sends the day-before email inside 24 hours and the one-hour email inside its window', () => {
    expect(rem.consultCallEmailReminderDecision(base())).toEqual({ action: 'send', window: 'email_h24' });
    expect(rem.consultCallEmailReminderDecision(base({ scheduledAt: at(60 * MIN), markers: { email_h24: at(-23 * H) } })))
      .toEqual({ action: 'send', window: 'email_h1' });
    expect(rem.consultCallEmailReminderDecision(base({ scheduledAt: at(30 * H) }))).toEqual({ action: 'skip', reason: 'too_far_out' });
    expect(rem.consultCallEmailReminderDecision(base({ scheduledAt: at(25 * MIN) }))).toEqual({ action: 'skip', reason: 'too_close' });
    expect(rem.consultCallEmailReminderDecision(base({ scheduledAt: '' }))).toEqual({ action: 'skip', reason: 'no_call_time' });
  });

  it('is independent of the WhatsApp markers, and one per window', () => {
    // WhatsApp already sent both of its touches: the emails are still owed.
    expect(rem.consultCallEmailReminderDecision(base({ markers: { h24: 'x', h1: 'y', soon: 'z' } })).window).toBe('email_h24');
    expect(rem.consultCallEmailReminderDecision(base({ markers: { email_h24: 'x' } }))).toEqual({ action: 'skip', reason: 'already_sent' });
    expect(rem.consultCallEmailReminderDecision(base({ scheduledAt: at(60 * MIN), markers: { email_h24: at(-23 * H), email_h1: 'x' } })))
      .toEqual({ action: 'skip', reason: 'already_sent' });
    // The WhatsApp decision, for its part, ignores the email markers.
    const slot = at(5 * H);
    expect(waLib.consultCallReminderDecision({ scheduledAt: slot, bookedAt: at(-30 * H), nowMs: now, markers: { call_at: slot, email_h24: 'x', email_h1: 'y' } }))
      .toMatchObject({ action: 'send', window: 'h24' });
  });

  it('never lands on top of the booking, nor twice in two hours', () => {
    expect(rem.consultCallEmailReminderDecision(base({ bookedAt: at(-10 * MIN) }))).toEqual({ action: 'skip', reason: 'just_booked' });
    expect(rem.consultCallEmailReminderDecision(base({ scheduledAt: at(60 * MIN), bookedAt: at(-20 * MIN) })))
      .toEqual({ action: 'skip', reason: 'booked_late' });
    expect(rem.consultCallEmailReminderDecision(base({ scheduledAt: at(50 * MIN), bookedAt: at(-160 * MIN), markers: { email_h24: at(-40 * MIN) } })))
      .toEqual({ action: 'skip', reason: 'day_before_just_sent' });
    // An unreadable booked_at must not silence the reminder.
    expect(rem.consultCallEmailReminderDecision(base({ bookedAt: null })).action).toBe('send');
  });

  it('writes both emails in the owner’s voice, with the time, the link and a way out', () => {
    const ctx = { name: 'Aisha Khan', callAtIso: '2026-11-13T08:00:00Z', timeZone: 'Europe/London', joinUrl: JOIN_URL };
    const day = rem.buildConsultReminderEmail('email_h24', ctx);
    expect(day.subject).toBe('Your GP Link call: Friday 13 November, 8:00 am (UK time)');
    expect(day.body).toContain('Hi Aisha,');
    expect(day.body).toContain('Friday 13 November, 8:00 am (UK time)');
    expect(day.body).toContain('reply to this email or WhatsApp us if you need another time');
    expect(day.body).toContain('Khaleed, CEO, GP Link');
    expect(day.ctaUrl).toBe(JOIN_URL);
    expect(day.text).toContain(JOIN_URL);
    const hour = rem.buildConsultReminderEmail('email_h1', ctx);
    expect(hour.subject).toBe('Your GP Link call is in about an hour (8:00 am (UK time))');
    expect(hour.body).toContain('at 8:00 am (UK time)');
    expect(hour.body).toContain('reply to this email or WhatsApp us if you need another time');
    // No em dashes in anything a doctor reads.
    [day, hour].forEach((e) => { expect(e.subject + e.title + e.body + e.ctaText).not.toMatch(/—/); });
    // No link or no time ⇒ nothing worth sending.
    expect(rem.buildConsultReminderEmail('email_h24', Object.assign({}, ctx, { joinUrl: '' }))).toBe(null);
    expect(rem.buildConsultReminderEmail('email_h24', Object.assign({}, ctx, { callAtIso: '' }))).toBe(null);
    expect(rem.buildConsultReminderEmail('nope', ctx)).toBe(null);
  });
});

describe('the lead’s own clock', () => {
  it('picks the zone from the country, then the dial code, then the UK', () => {
    expect(rem.consultLeadTimeZone({ country: 'uk' }, '+61400111222')).toBe('Europe/London');
    expect(rem.consultLeadTimeZone({ country: 'nz' }, '+447700900123')).toBe('Pacific/Auckland');
    expect(rem.consultLeadTimeZone({ country: 'new_zealand' }, '')).toBe('Pacific/Auckland');
    expect(rem.consultLeadTimeZone({ country: 'ie' }, '')).toBe('Europe/Dublin');
    expect(rem.consultLeadTimeZone({ country: 'other' }, '+61 400 111 222')).toBe('Australia/Sydney');
    expect(rem.consultLeadTimeZone(null, '+353 87 123 4567')).toBe('Europe/Dublin');
    expect(rem.consultLeadTimeZone(null, '00447700900123')).toBe('Europe/London');
    expect(rem.consultLeadTimeZone(null, '0412345678')).toBe('Europe/London');
    expect(rem.consultLeadTimeZone(undefined, undefined)).toBe('Europe/London');
  });

  it('reads exactly as before for a UK lead, and names the right clock for everyone else', () => {
    const iso = '2026-11-13T08:00:00Z';
    // Byte-identical to the rendering the approved templates were written around.
    expect(rem.formatLeadCallTime(iso, 'Europe/London')).toBe('Friday 13 November, 8:00 am (UK time)');
    expect(rem.formatLeadCallTime(iso, 'Europe/London')).toBe(waLib.formatCallTimeInZone(iso, 'Europe/London'));
    expect(rem.formatLeadCallTime(iso, 'Pacific/Auckland')).toBe('Friday 13 November, 9:00 pm (New Zealand time)');
    expect(rem.formatLeadCallTime(iso, 'Australia/Sydney')).toBe('Friday 13 November, 7:00 pm (Sydney time)');
    expect(rem.formatLeadCallTime(iso, 'Europe/Dublin')).toBe('Friday 13 November, 8:00 am (Irish time)');
    expect(rem.formatLeadCallClock(iso, 'Pacific/Auckland')).toBe('9:00 pm (New Zealand time)');
    expect(rem.formatLeadCallTimeShort(iso, 'Europe/London')).toBe('Fri 13 Nov, 8:00 am UK time');
    // A zone Intl does not know falls back to the UK rather than costing the reminder.
    expect(rem.formatLeadCallTime(iso, 'Mars/OlympusMons')).toBe('Friday 13 November, 8:00 am (UK time)');
    expect(rem.formatLeadCallTime('', 'Europe/London')).toBe('');
  });

  it('the booking confirmation accepts the lead’s clock too', () => {
    const msg = waLib.buildConsultWaMessage('call_booked', { name: 'Zara', callAtIso: '2026-11-13T08:00:00Z', whenText: 'Friday 13 November, 9:00 pm (New Zealand time)' });
    expect(msg.placeholders).toEqual(['Zara', 'Friday 13 November, 9:00 pm (New Zealand time)']);
    // Without one it renders the UK clock, as it always did.
    expect(waLib.buildConsultWaMessage('call_booked', { name: 'Zara', callAtIso: '2026-11-13T08:00:00Z' }).placeholders[1])
      .toBe('Friday 13 November, 8:00 am (UK time)');
  });
});

describe('replies around a consultation (consultReplyPageDecision)', () => {
  const now = Date.parse('2026-11-13T07:00:00Z');
  const at = (ms) => new Date(now + ms).toISOString();
  const booked = (ms, over = {}) => Object.assign({ id: 'c1', status: 'booked', scheduled_at: at(ms), failed_attempt_count: 0 }, over);

  it('recognises the two buttons', () => {
    expect(rem.classifyReminderReply("I'll be there")).toBe('confirm');
    expect(rem.classifyReminderReply('I’ll be there!')).toBe('confirm');
    expect(rem.classifyReminderReply('Need another time')).toBe('move');
    expect(rem.classifyReminderReply("I'll be there but ten minutes late")).toBe('other');
    expect(rem.classifyReminderReply('')).toBe('other');
  });

  it('tells a plain thank-you and a clear "see you then" from a message a person must read', () => {
    // Only an acknowledgement: nothing to do.
    for (const t of ['Thanks', 'thank you!', 'THANK YOU', 'ok', 'Okay \u{1F44D}', '\u{1F44D}', '\u{1F64F}\u{1F3FD}', 'great', 'Perfect, thanks',
      'will do', 'Noted.', 'Thanks so much for the reminder', 'Cheers']) {
      expect(rem.classifyReminderReply(t), t).toBe('ack');
    }
    // Clearly coming: the same as tapping "I'll be there".
    for (const t of ['yes', 'Yes!', 'Great, see you then', 'See you soon', 'see you tomorrow', 'Yes, will be there', 'ill be there',
      'Thank you Khaleed, looking forward to it', 'Confirmed']) {
      expect(rem.classifyReminderReply(t), t).toBe('confirm');
    }
    // A question mark, a time, a day name or a worry word always reaches a person,
    // however politely it starts. So does anything we do not recognise.
    for (const t of ['Thanks, can we do 12:30?', 'ok?', 'Thanks, see you at 2', 'ok see you friday', 'thanks but running late',
      'Sorry', "I can't make it", 'I cant make it', 'unable to attend', 'Is the link working', 'cannot join', 'zoom', 'Need to move it',
      'please reschedule', 'clinic overran', 'another day would suit', 'small change', 'No', 'not sure', 'ok what should I prepare',
      'great stuff', 'hi', 'Hello Khaleed', 'Thanks. My wife will be on the call as well and she has a lot of questions about schools and housing in Perth']) {
      expect(rem.classifyReminderReply(t), t).toBe('other');
    }
  });

  it('before the call: a thank-you does nothing, "see you then" confirms, everything else pages', () => {
    const ahead = [booked(3 * H)];
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'Thanks!', bookings: ahead })).toEqual({ action: 'none', reason: 'acknowledgement' });
    expect(rem.consultReplyPageDecision({ nowMs: now, text: '\u{1F44D}', bookings: ahead })).toEqual({ action: 'none', reason: 'acknowledgement' });
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'Great, see you then', bookings: ahead })).toMatchObject({ action: 'confirm' });
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'Thanks, running late', bookings: ahead })).toMatchObject({ action: 'page', why: 'upcoming' });
    // Once the call has started, or after a missed one, every message pages.
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'Thanks', bookings: [booked(-5 * MIN)] })).toMatchObject({ action: 'page', why: 'in_progress' });
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'yes', bookings: [booked(-5 * MIN)] })).toMatchObject({ action: 'page', why: 'in_progress' });
    const swept = { id: 'c2', status: 'invited', scheduled_at: null, failed_attempt_count: 1, notification_channels: { consult_reminders: { call_at: at(-5 * H) } } };
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'ok', bookings: [swept] })).toMatchObject({ action: 'page', why: 'no_show' });
  });

  it('pages at most once per person per 10 minutes', () => {
    const ahead = [booked(3 * H)];
    const q = 'Can we move it?';
    expect(rem.REPLY_PAGE_THROTTLE_MS).toBe(10 * MIN);
    expect(rem.consultReplyPageDecision({ nowMs: now, text: q, bookings: ahead, lastPagedAtMs: now - 2 * MIN })).toEqual({ action: 'none', reason: 'throttled' });
    expect(rem.consultReplyPageDecision({ nowMs: now, text: q, bookings: ahead, lastPagedAtMs: now - 9 * MIN - 59000 })).toEqual({ action: 'none', reason: 'throttled' });
    expect(rem.consultReplyPageDecision({ nowMs: now, text: q, bookings: ahead, lastPagedAtMs: now - 10 * MIN })).toMatchObject({ action: 'page' });
    // No earlier page, or an unreadable one: page.
    expect(rem.consultReplyPageDecision({ nowMs: now, text: q, bookings: ahead, lastPagedAtMs: NaN })).toMatchObject({ action: 'page' });
    expect(rem.consultReplyPageDecision({ nowMs: now, text: q, bookings: ahead })).toMatchObject({ action: 'page' });
    // The same hold applies during the call and after a missed one…
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'trying to join', bookings: [booked(-5 * MIN)], lastPagedAtMs: now - MIN })).toEqual({ action: 'none', reason: 'throttled' });
    const swept = { id: 'c2', status: 'invited', scheduled_at: null, failed_attempt_count: 1, notification_channels: { consult_reminders: { call_at: at(-5 * H) } } };
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'so sorry', bookings: [swept], lastPagedAtMs: now - MIN })).toEqual({ action: 'none', reason: 'throttled' });
    // …but never holds back a confirmation, which pages nobody anyway.
    expect(rem.consultReplyPageDecision({ nowMs: now, text: "I'll be there", bookings: ahead, lastPagedAtMs: now - MIN })).toMatchObject({ action: 'confirm' });
  });

  it('pages for a call inside 48 hours, and for one that started inside the past 2 hours', () => {
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'Can we move it to 12:30?', bookings: [booked(3 * H)] }))
      .toMatchObject({ action: 'page', why: 'upcoming', moveRequested: false });
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'Need another time', bookings: [booked(47 * H)] }))
      .toMatchObject({ action: 'page', why: 'upcoming', moveRequested: true });
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'My friend is trying to join in', bookings: [booked(-7 * MIN)] }))
      .toMatchObject({ action: 'page', why: 'in_progress' });
    // Too far out to be about the reminder.
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'hello', bookings: [booked(49 * H)] })).toMatchObject({ action: 'none' });
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'hello', bookings: [] })).toEqual({ action: 'none', reason: 'no_booking' });
  });

  it('"I\'ll be there" confirms instead of paging, but only for a call still ahead', () => {
    expect(rem.consultReplyPageDecision({ nowMs: now, text: "I'll be there", bookings: [booked(55 * MIN)] }))
      .toMatchObject({ action: 'confirm', callAtMs: now + 55 * MIN });
    // Tapped after the start: somebody should look.
    expect(rem.consultReplyPageDecision({ nowMs: now, text: "I'll be there", bookings: [booked(-10 * MIN)] }))
      .toMatchObject({ action: 'page', why: 'in_progress' });
  });

  it('pages when someone who missed a call in the past day writes in', () => {
    // Swept by the no-show sweep: re-invited, slot kept on the reminder markers.
    const swept = { id: 'c2', status: 'invited', scheduled_at: null, failed_attempt_count: 1, notification_channels: { consult_reminders: { call_at: at(-5 * H) } } };
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'So sorry, clinic time was changed', bookings: [swept] }))
      .toMatchObject({ action: 'page', why: 'no_show', callAtMs: now - 5 * H });
    // Completed by Zoom, but the participant check said the doctor never joined.
    const done = { id: 'c3', status: 'completed', scheduled_at: at(-20 * H), failed_attempt_count: 0 };
    const lead = { metadata: { consult: { call_attended: false } } };
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'Sorry I missed you', lead, bookings: [done] })).toMatchObject({ action: 'page', why: 'no_show' });
    // The same row for a doctor who DID attend is just a thank-you.
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'Thanks for today', lead: { metadata: { consult: { call_attended: true } } }, bookings: [done] }))
      .toMatchObject({ action: 'none' });
    // More than a day ago: no longer urgent.
    const old = Object.assign({}, swept, { notification_channels: { consult_reminders: { call_at: at(-30 * H) } } });
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'hi', bookings: [old] })).toMatchObject({ action: 'none' });
    // A live booking outranks an old miss.
    expect(rem.consultReplyPageDecision({ nowMs: now, text: 'hi', bookings: [swept, booked(4 * H, { id: 'c9' })] }))
      .toMatchObject({ action: 'page', why: 'upcoming' });
  });

  it('shapes the four slots to read well in the approved owner template', () => {
    const d = { action: 'page', why: 'upcoming', moveRequested: false, callAtMs: Date.parse('2026-11-13T08:00:00Z') };
    const s = rem.consultReplyPageSummary({ decision: d, name: 'Aisha Khan', phone: '+447700900123', text: 'Pls can we reschedule\nfor 12:30pm today.', timeZone: 'Europe/London' });
    expect(s).toEqual({
      name: 'Aisha Khan',
      phone: '+447700900123',
      answers: 'Pls can we reschedule for 12:30pm today',
      status: 'Call booked Fri 13 Nov, 8:00 am UK time. Replied on WhatsApp before the call'
    });
    const msg = waLib.buildConsultWaMessage('owner_lead_alert', { summary: s });
    expect(msg.templateName).toBe('gp_link_owner_lead_alert');
    msg.placeholders.forEach((p) => { expect(p).toBeTruthy(); expect(p).not.toMatch(/\n/); expect(p).not.toMatch(/\.$/); });
    expect(rem.consultReplyPageSummary({ decision: Object.assign({}, d, { moveRequested: true }), text: 'Need another time' }).status)
      .toBe('Call booked Fri 13 Nov, 8:00 am UK time. They tapped Need another time on the reminder');
    expect(rem.consultReplyPageSummary({ decision: Object.assign({}, d, { why: 'no_show' }), text: 'sorry' }).status)
      .toBe('Missed their call on Fri 13 Nov, 8:00 am UK time and has now written in');
    expect(rem.consultReplyPageSummary({ decision: Object.assign({}, d, { why: 'in_progress' }), text: '' }))
      .toMatchObject({ name: 'Unknown name', phone: 'no phone on file', answers: 'an empty message' });
  });
});

// ================================================================ cron wiring
describe('GET /api/cron/call-reminders with the new touches', () => {
  it('the day before: WhatsApp and email both go, each with its own marker', async () => {
    const call = seedBooking();
    seedLead(call.invitee_email);
    const res = await cron();
    expect(res.status).toBe(200);
    expect(res.json.consultReminders).toMatchObject({ sent: 1, emailsSent: 1 });
    expect(templateSends('gp_link_consult_call_reminder').length).toBe(1);
    expect(emails.length).toBe(1);
    expect(emails[0].to).toEqual([call.invitee_email]);
    expect(emails[0].subject).toMatch(/^Your GP Link call: /);
    expect(emails[0].html).toContain(JOIN_URL.replace('&', '&'));
    expect(emails[0].from).toContain('Khaleed at GP Link');
    const m = markersOf(db.scheduled_calls[0]);
    expect(m.h24).toBeTruthy();
    expect(m.email_h24).toBeTruthy();
    // Neither repeats.
    await cron();
    expect(templateSends().length).toBe(1);
    expect(emails.length).toBe(1);
  });

  it('about an hour before: the one-hour template with the clock time, and the one-hour email', async () => {
    const at = new Date(Date.now() + 60 * MIN).toISOString();
    const call = seedBooking({ scheduled_at: at, notification_channels: { consult_reminders: { call_at: at, h24: new Date(Date.now() - 23 * H).toISOString(), email_h24: new Date(Date.now() - 23 * H).toISOString() } } });
    seedLead(call.invitee_email);
    const res = await cron();
    expect(res.json.consultReminders).toMatchObject({ sent: 1, emailsSent: 1 });
    const wa = templateSends('gp_link_consult_call_1h');
    expect(wa.length).toBe(1);
    const ph = wa[0].content.templateData.body.placeholders;
    expect(ph[0]).toBe('Aisha');
    expect(ph[1]).toMatch(/^\d{1,2}:\d{2} (am|pm) \(UK time\)$/);
    expect(ph[2]).toBe(JOIN_URL);
    expect(emails[0].subject).toMatch(/^Your GP Link call is in about an hour/);
    const m = markersOf(db.scheduled_calls[0]);
    expect(m.h1).toBeTruthy();
    expect(m.email_h1).toBeTruthy();
    expect(m.h24).toBeTruthy(); // earlier markers survive the stamp
    await cron();
    expect(templateSends().length).toBe(1);
    expect(emails.length).toBe(1);
  });

  it('a lead with no phone still gets the email, and an email failure does not block WhatsApp', async () => {
    const nophone = seedBooking();
    seedLead(nophone.invitee_email, { phone: '' });
    let res = await cron();
    expect(res.json.consultReminders).toMatchObject({ sent: 0, emailsSent: 1 });
    expect(markersOf(db.scheduled_calls[0]).email_h24).toBeTruthy();
    expect(markersOf(db.scheduled_calls[0]).h24).toBeUndefined();

    // A booking with no usable address: WhatsApp goes, the email marker stays open.
    db.scheduled_calls.length = 0; db.site_enquiries.length = 0; emails.length = 0; dtCaptured.length = 0;
    const call = seedBooking({ invitee_email: 'not-an-address' });
    db.site_enquiries.push({ id: 'lead-x', created_at: new Date().toISOString(), kind: 'gp', name: 'Aisha Khan', email: 'not-an-address', phone: '+447700900555', status: 'new', metadata: { consult: { call_booked: true } } });
    res = await cron();
    expect(res.json.consultReminders).toMatchObject({ sent: 1, emailsSent: 0 });
    expect(markersOf(call).h24 || markersOf(db.scheduled_calls[0]).h24).toBeTruthy();
    expect(markersOf(db.scheduled_calls[0]).email_h24).toBeUndefined();
  });

  it('renders a New Zealand lead’s slot on their own clock, in both channels', async () => {
    const call = seedBooking({ scheduled_at: new Date(Date.now() + 5 * H).toISOString() });
    seedLead(call.invitee_email, { metadata: { consult: { call_booked: true, country: 'nz' } } });
    await cron();
    const when = templateSends('gp_link_consult_call_reminder')[0].content.templateData.body.placeholders[1];
    expect(when).toMatch(/\(New Zealand time\)$/);
    expect(when).toBe(rem.formatLeadCallTime(call.scheduled_at, 'Pacific/Auckland'));
    expect(emails[0].subject).toContain('(New Zealand time)');
  });

  it('an unsubscribed lead gets neither, and RSO registration calls get no email', async () => {
    const un = seedBooking();
    seedLead(un.invitee_email, { metadata: { consult: { stopped: 'unsubscribed' } } });
    const rso = seedBooking({ host_kind: 'rso', stage: 'amc', timezone: 'Australia/Sydney' });
    seedLead(rso.invitee_email);
    const res = await cron();
    expect(res.json.consultReminders).toMatchObject({ sent: 0, emailsSent: 0 });
    expect(res.json.registrationReminders.sent).toBe(1);
    expect(res.json.registrationReminders.emailsSent).toBeUndefined();
    expect(emails.length).toBe(0);
  });
});

// ================================================================ replies
describe('POST /api/webhooks/doubletick — a reply around a consultation', () => {
  const ownerPages = () => templateSends('gp_link_owner_lead_alert');
  const ownerEmails = () => emails.filter((e) => [].concat(e.to).indexOf('hello@mygplink.com.au') !== -1);

  it('pages the owner by WhatsApp and email when a booked doctor writes in before the call', async () => {
    const call = seedBooking({ scheduled_at: new Date(Date.now() + 150 * MIN).toISOString() });
    const lead = seedLead(call.invitee_email);
    const res = await inbound(lead.phone, 'Goodmorning. Pls can we reschedule for 12:30pm today. Clinic change.');
    expect(res.status).toBe(200);
    expect(ownerPages().length).toBe(1);
    const page = ownerPages()[0];
    expect(page.to).toBe(OWNER_PHONE);
    const ph = page.content.templateData.body.placeholders;
    expect(ph[0]).toBe('Aisha Khan');
    expect(ph[1]).toBe(lead.phone);
    expect(ph[2]).toBe('Goodmorning. Pls can we reschedule for 12:30pm today. Clinic change');
    expect(ph[3]).toMatch(/^Call booked .* UK time\. Replied on WhatsApp before the call$/);
    expect(ownerEmails().length).toBe(1);
    expect(ownerEmails()[0].subject).toBe('Aisha Khan replied about their call');
    // The message still took its normal path: stored for the record.
    expect(db.doubletick_messages.length).toBe(1);
  });

  it('a redelivered webhook does not page again, and a burst of messages pages once in 10 minutes', async () => {
    const call = seedBooking({ scheduled_at: new Date(Date.now() + 3 * H).toISOString() });
    const lead = seedLead(call.invitee_email);
    const first = { messageId: 'dup-' + RUN_ID };
    await inbound(lead.phone, 'Running late in clinic', first);
    await inbound(lead.phone, 'Running late in clinic', first);
    expect(ownerPages().length).toBe(1);
    // The page time is kept on the lead.
    const stamped = db.site_enquiries[0].metadata.consult.reply_paged_at;
    expect(Date.parse(stamped)).toBeGreaterThan(Date.now() - 60 * 1000);
    await inbound(lead.phone, 'Can we do 1pm instead?');
    await inbound(lead.phone, 'So sorry about this');
    expect(ownerPages().length).toBe(1);
    expect(ownerEmails().length).toBe(1);
    // …and every delivery was still stored for the record (the redelivery too,
    // as it always was).
    expect(db.doubletick_messages.length).toBe(4);
    // Eleven minutes on, the next message pages again.
    db.site_enquiries[0].metadata.consult.reply_paged_at = new Date(Date.now() - 11 * MIN).toISOString();
    await inbound(lead.phone, 'Are you there?');
    expect(ownerPages().length).toBe(2);
  });

  it('a thank-you before the call pages nobody; "see you then" stamps the booking like the button', async () => {
    const at = new Date(Date.now() + 20 * H).toISOString();
    const call = seedBooking({ scheduled_at: at, notification_channels: { consult_reminders: { call_at: at, h24: 'x' } } });
    const lead = seedLead(call.invitee_email);
    await inbound(lead.phone, 'Thank you!');
    await inbound(lead.phone, '\u{1F44D}');
    expect(ownerPages().length).toBe(0);
    expect(ownerEmails().length).toBe(0);
    expect(markersOf(db.scheduled_calls[0]).confirmed_at).toBeUndefined();
    await inbound(lead.phone, 'Great, see you then');
    expect(ownerPages().length).toBe(0);
    expect(markersOf(db.scheduled_calls[0]).confirmed_at).toBeTruthy();
    // The same lead with a real question is paged about at once.
    await inbound(lead.phone, 'Thanks. Will my wife be able to join the call too?');
    expect(ownerPages().length).toBe(1);
  });

  it('a direct booker with no lead row is throttled on the booking itself', async () => {
    seedBooking({ invitee_email: 'direct2@example.co.uk', scheduled_at: new Date(Date.now() + 4 * H).toISOString(), invitee_notes: '+44 7756 134906' });
    await inbound('+447756134906', 'Is the call still on?');
    await inbound('+447756134906', 'Hello?');
    expect(ownerPages().length).toBe(1);
    const nc = db.scheduled_calls[0].notification_channels;
    expect(nc.consult_reply_paged_at).toBeTruthy();
  });

  it('"I\'ll be there" stamps the booking and pages nobody; "Need another time" pages', async () => {
    const at = new Date(Date.now() + 55 * MIN).toISOString();
    const call = seedBooking({ scheduled_at: at, notification_channels: { consult_reminders: { call_at: at, h24: 'x', h1: 'y' } } });
    const lead = seedLead(call.invitee_email);
    await inbound(lead.phone, "I'll be there");
    expect(ownerPages().length).toBe(0);
    expect(ownerEmails().length).toBe(0);
    const m = markersOf(db.scheduled_calls[0]);
    expect(m.confirmed_at).toBeTruthy();
    expect(m.h1).toBe('y'); // the reminder markers are untouched

    await inbound(lead.phone, 'Need another time');
    expect(ownerPages().length).toBe(1);
    expect(ownerPages()[0].content.templateData.body.placeholders[3]).toMatch(/They tapped Need another time on the reminder$/);
  });

  it('pages for a doctor trying to join minutes after the start, and for one who missed yesterday', async () => {
    const live = seedBooking({ scheduled_at: new Date(Date.now() - 7 * MIN).toISOString() });
    const a = seedLead(live.invitee_email);
    await inbound(a.phone, 'So sorry, my friend Ani is trying to join in');
    expect(ownerPages().length).toBe(1);
    expect(ownerPages()[0].content.templateData.body.placeholders[3]).toMatch(/may be trying to join right now$/);

    const missedAt = new Date(Date.now() - 6 * H).toISOString();
    const missed = seedBooking({
      status: 'invited', scheduled_at: null, failed_attempt_count: 1, updated_at: new Date(Date.now() - 4 * H).toISOString(),
      notification_channels: { consult_reminders: { call_at: missedAt, h24: 'x', soon: 'y' } }
    });
    const b = seedLead(missed.invitee_email);
    await inbound(b.phone, 'Apologies, I got held up. Can we rebook?');
    expect(ownerPages().length).toBe(2);
    expect(ownerPages()[1].content.templateData.body.placeholders[3]).toMatch(/^Missed their call on .* and has now written in$/);
    expect(ownerEmails()[1].subject).toBe('Aisha Khan wrote in after missing their call');
  });

  it('finds a direct Calendly booker by the number in their booking answers', async () => {
    seedBooking({ invitee_email: 'direct@example.co.uk', scheduled_at: new Date(Date.now() + 4 * H).toISOString(), invitee_notes: '+44 7756 134905\nDo I need salaried experience?' });
    await inbound('+447756134905', 'Is the call still on?', { contact: { name: 'Dr Direct' } });
    expect(ownerPages().length).toBe(1);
    expect(ownerPages()[0].content.templateData.body.placeholders[0]).toBe('Dr Direct');
  });

  it('does not page for someone with no call in the window, or a stranger', async () => {
    const far = seedBooking({ scheduled_at: new Date(Date.now() + 5 * 24 * H).toISOString() });
    const lead = seedLead(far.invitee_email);
    await inbound(lead.phone, 'Thanks, see you next week');
    await inbound('+447700999888', 'Hello, is this GP Link?');
    expect(ownerPages().length).toBe(0);
    expect(ownerEmails().length).toBe(0);
  });
});

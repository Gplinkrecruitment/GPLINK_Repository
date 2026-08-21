// Consultation WhatsApp reminders — the day-before heads-up and the
// "starting now" nudge, both carrying the Zoom join link (lib/consult-whatsapp.js
// consultCallReminderDecision + runConsultCallReminders, driven through
// GET /api/cron/call-reminders).
//
// Runs the real server in SUPABASE mode against a local PostgREST emulator,
// because the reminder pass reads scheduled_calls and stamps its markers there —
// the local-JSON path returns early with { skippedReason: 'no_db' }. The
// DoubleTick stub is wired through DOUBLETICK_BASE_URL before import (it is a
// module-level const in server.js).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';

const requireCjs = createRequire(import.meta.url);
const waLib = requireCjs('../lib/consult-whatsapp.js');

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-call-reminders-${RUN_ID}.json`;
const CRON_SECRET = 'call-reminders-secret-' + RUN_ID;
const CRON = '/api/cron/call-reminders';

const MIN = 60 * 1000;
const H = 60 * MIN;

let server;
let port;
let sbServer;
let sbPort;
let dtServer;
let dtPort;
const dtCaptured = [];
const db = { scheduled_calls: [], site_enquiries: [] };

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

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Authorization: 'Bearer ' + CRON_SECRET } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* leave null */ }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
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
    booked_at: new Date(Date.now() - 6 * H).toISOString(),
    zoom_join_url: JOIN_URL,
    notification_channels: null,
    invitee_notes: null,
    assigned_rso_email: null,
    reminder_sent_at: null
  }, overrides);
  db.scheduled_calls.push(call);
  return call;
}

function seedLead(email, overrides = {}) {
  const lead = Object.assign({
    id: 'lead-' + email,
    created_at: new Date(Date.now() - 3 * 24 * H).toISOString(),
    kind: 'gp',
    name: 'Aisha Khan',
    email,
    phone: '+44 7700 900123',
    status: 'new',
    metadata: { source: 'meta_lead_ad', consult: { token: 'TOK', qualified: true, call_booked: true } }
  }, overrides);
  db.site_enquiries.push(lead);
  return lead;
}

function templateSends() {
  return dtCaptured.filter((c) => c.path === '/whatsapp/message/template');
}
function lastTemplate() {
  const s = templateSends();
  return s.length ? s[s.length - 1].body.messages[0] : null;
}

beforeAll(async () => {
  await startSupabaseEmulator();
  await startDoubleTickStub();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'call-reminders-auth-' + RUN_ID;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.RESEND_API_KEY = '';
  process.env.DOUBLETICK_API_KEY = 'test-dt-key';
  process.env.DOUBLETICK_BASE_URL = `http://127.0.0.1:${dtPort}`;

  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sbServer) await new Promise((r) => sbServer.close(r));
  if (dtServer) await new Promise((r) => dtServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

beforeEach(() => {
  db.scheduled_calls.length = 0;
  db.site_enquiries.length = 0;
  dtCaptured.length = 0;
});

// ---------------------------------------------------------------- pure logic
describe('consultCallReminderDecision', () => {
  const now = Date.parse('2026-08-24T09:00:00Z');
  const at = (ms) => new Date(now + ms).toISOString();
  const base = (over = {}) => Object.assign({
    scheduledAt: at(5 * H),
    bookedAt: at(-6 * H),
    nowMs: now,
    markers: null
  }, over);

  it('sends the day-before touch inside 24h and the starting-now touch inside 15 min', () => {
    const day = waLib.consultCallReminderDecision(base());
    expect(day.action).toBe('send');
    expect(day.window).toBe('h24');
    expect(day.kind).toBe('call_reminder');

    const soon = waLib.consultCallReminderDecision(base({ scheduledAt: at(8 * MIN) }));
    expect(soon.action).toBe('send');
    expect(soon.window).toBe('soon');
    expect(soon.kind).toBe('call_starting');
  });

  it('ignores a call further than 24h out and one that has already started', () => {
    expect(waLib.consultCallReminderDecision(base({ scheduledAt: at(30 * H) })))
      .toEqual({ action: 'skip', reason: 'too_far_out' });
    expect(waLib.consultCallReminderDecision(base({ scheduledAt: at(-1 * MIN) })))
      .toEqual({ action: 'skip', reason: 'already_started' });
    expect(waLib.consultCallReminderDecision(base({ scheduledAt: '' })))
      .toEqual({ action: 'skip', reason: 'no_call_time' });
  });

  it('never lands a reminder on top of its own booking confirmation', () => {
    // Booked 10 minutes ago for a call 5h away: the confirmation has only just
    // gone out, so the "coming up" reminder must wait.
    expect(waLib.consultCallReminderDecision(base({ bookedAt: at(-10 * MIN) })))
      .toEqual({ action: 'skip', reason: 'just_booked' });
    // Same booking 3h later is fair game.
    expect(waLib.consultCallReminderDecision(base({ bookedAt: at(-3 * H) })).action).toBe('send');
    // Booking 12 minutes before the call still gets the join link — that person
    // needs it most — but not in the same minute as the confirmation.
    expect(waLib.consultCallReminderDecision(base({ scheduledAt: at(12 * MIN), bookedAt: at(-1 * MIN) })))
      .toEqual({ action: 'skip', reason: 'just_booked' });
    expect(waLib.consultCallReminderDecision(base({ scheduledAt: at(12 * MIN), bookedAt: at(-8 * MIN) })).action)
      .toBe('send');
    // An unreadable booked_at must not silence the reminder.
    expect(waLib.consultCallReminderDecision(base({ bookedAt: null })).action).toBe('send');
  });

  it('is one-per-window, and a reschedule re-arms both windows', () => {
    const slot = at(5 * H);
    const sent = { call_at: slot, h24: at(-1 * MIN) };
    expect(waLib.consultCallReminderDecision(base({ scheduledAt: slot, markers: sent })))
      .toEqual({ action: 'skip', reason: 'already_sent' });
    // The same markers against a NEW slot describe a booking that no longer
    // exists — the doctor must be reminded about the time they actually hold.
    const moved = waLib.consultCallReminderDecision(base({ scheduledAt: at(9 * H), markers: sent }));
    expect(moved.action).toBe('send');
    expect(moved.window).toBe('h24');
    expect(moved.markers).toEqual({ call_at: at(9 * H) });
    // The day-before marker does not satisfy the starting-now touch.
    const soon = waLib.consultCallReminderDecision(base({ scheduledAt: at(6 * MIN), markers: { call_at: at(6 * MIN), h24: 'x' } }));
    expect(soon.action).toBe('send');
    expect(soon.window).toBe('soon');
    expect(soon.markers.h24).toBe('x'); // preserved, so it is not re-sent later
  });

  it('matches the slot by instant, not by string, so PostgREST offsets still dedupe', () => {
    const stamped = '2026-08-24T14:00:00.000Z';
    const readBack = '2026-08-24T14:00:00+00:00';
    const d = waLib.consultCallReminderDecision({
      scheduledAt: readBack,
      bookedAt: '2026-08-24T02:00:00Z',
      nowMs: Date.parse('2026-08-24T09:00:00Z'),
      markers: { call_at: stamped, h24: '2026-08-24T08:00:00Z' }
    });
    expect(d).toEqual({ action: 'skip', reason: 'already_sent' });
  });
});

describe('reminder message building', () => {
  it('carries the join link, and refuses to send a reminder without one', () => {
    const day = waLib.buildConsultWaMessage('call_reminder', {
      name: 'Louise Beet', callAtIso: '2026-08-24T13:00:00Z', joinUrl: JOIN_URL
    });
    expect(day.templateName).toBe('gp_link_consult_call_reminder');
    expect(day.placeholders[0]).toBe('Louise');
    expect(day.placeholders[1]).toContain('(UK time)');
    expect(day.placeholders[2]).toBe(JOIN_URL);

    const soon = waLib.buildConsultWaMessage('call_starting', { name: '', joinUrl: JOIN_URL });
    expect(soon.templateName).toBe('gp_link_consult_call_starting');
    expect(soon.placeholders).toEqual(['there', JOIN_URL]);

    // A link-less reminder is not worth sending.
    expect(waLib.buildConsultWaMessage('call_reminder', { name: 'A', callAtIso: '2026-08-24T13:00:00Z' })).toBe(null);
    expect(waLib.buildConsultWaMessage('call_starting', { name: 'A' })).toBe(null);
    // …and neither is one with no readable call time.
    expect(waLib.buildConsultWaMessage('call_reminder', { name: 'A', callAtIso: '', joinUrl: JOIN_URL })).toBe(null);
  });

  it('recovers the phone Calendly required at booking, and refuses to guess', () => {
    // The question naming a phone wins over a number sitting in free text.
    expect(waLib.extractConsultPhone([
      { question: 'Anything you would like to cover?', answer: 'I did my MRCGP in 2019, 4 years ago' },
      { question: 'Please share your phone number for contact via WhatsApp', answer: '+44 7474 408218' }
    ])).toBe('+447474408218');
    // A lone phone-shaped answer is accepted even with no question text.
    expect(waLib.extractConsultPhone([{ question: '', answer: '+44 7578 572757' }])).toBe('+447578572757');
    // Older bookings only have the joined notes blob — the real prod shape.
    expect(waLib.extractConsultPhone(null,
      '+44 7756 134905\nDo I need work experience as a salaried GP?')).toBe('+447756134905');
    expect(waLib.extractConsultPhone(null,
      '+44 7578 572757\nI have two children - 9 & 4 so i will need to think about their school.'))
      .toBe('+447578572757');

    // …and everything that is not convincingly a phone number is refused,
    // because the cost of a wrong number is messaging a stranger.
    expect(waLib.extractConsultPhone([{ question: 'Notes', answer: 'I have two children - 9 & 4' }])).toBe('');
    expect(waLib.extractConsultPhone(null, 'Booked on 2026-08-24, ref 12345')).toBe('');
    expect(waLib.extractConsultPhone(null, 'no numbers here at all')).toBe('');
    expect(waLib.extractConsultPhone(null, '')).toBe('');
    expect(waLib.extractConsultPhone(undefined, undefined)).toBe('');
  });

  it('only an unsubscribe silences a reminder — funnel gates do not apply', () => {
    expect(waLib.consultCallReminderAllowedForLead(null)).toBe(true);
    expect(waLib.consultCallReminderAllowedForLead({ qualified: false, screened_out: true })).toBe(true);
    expect(waLib.consultCallReminderAllowedForLead({ stopped: 'signed_up' })).toBe(true);
    expect(waLib.consultCallReminderAllowedForLead({ stopped: 'unsubscribed' })).toBe(false);
  });
});

// ---------------------------------------------------------------- cron wiring
describe('GET /api/cron/call-reminders — consultation reminders', () => {
  it('sends the day-before reminder with the join link and stamps the booking', async () => {
    const call = seedBooking();
    seedLead(call.invitee_email);

    const res = await get(CRON);
    expect(res.status).toBe(200);
    expect(res.json.consultReminders.sent).toBe(1);

    expect(templateSends().length).toBe(1);
    const msg = lastTemplate();
    expect(msg.to).toBe('+447700900123');
    expect(msg.content.templateName).toBe('gp_link_consult_call_reminder');
    expect(msg.content.templateData.body.placeholders[0]).toBe('Aisha');
    expect(msg.content.templateData.body.placeholders[2]).toBe(JOIN_URL);

    // Marker written against the slot it was sent for.
    const stored = db.scheduled_calls[0].notification_channels;
    expect(stored.consult_reminders.h24).toBeTruthy();
    expect(Date.parse(stored.consult_reminders.call_at)).toBe(Date.parse(call.scheduled_at));

    // The contact is named before the first message so the chat is not a bare number.
    expect(dtCaptured.some((c) => c.path === '/customer/assign-tags-custom-fields')).toBe(true);
  });

  it('does not send the same reminder twice, but a reschedule re-arms it', async () => {
    const call = seedBooking();
    seedLead(call.invitee_email);

    await get(CRON);
    expect(templateSends().length).toBe(1);
    await get(CRON);
    expect(templateSends().length).toBe(1); // still one

    // Doctor moves the slot: same row, new scheduled_at.
    db.scheduled_calls[0].scheduled_at = new Date(Date.now() + 7 * H).toISOString();
    await get(CRON);
    expect(templateSends().length).toBe(2);
    expect(lastTemplate().content.templateName).toBe('gp_link_consult_call_reminder');
  });

  it('sends the starting-now template with the link when the call is minutes away', async () => {
    const call = seedBooking({ scheduled_at: new Date(Date.now() + 8 * MIN).toISOString() });
    seedLead(call.invitee_email);

    const res = await get(CRON);
    expect(res.json.consultReminders.sent).toBe(1);
    const msg = lastTemplate();
    expect(msg.content.templateName).toBe('gp_link_consult_call_starting');
    expect(msg.content.templateData.body.placeholders).toEqual(['Aisha', JOIN_URL]);
    expect(db.scheduled_calls[0].notification_channels.consult_reminders.soon).toBeTruthy();
  });

  it('holds the reminder until the Zoom link exists, then sends it', async () => {
    const call = seedBooking({ zoom_join_url: null });
    seedLead(call.invitee_email);

    await get(CRON);
    expect(templateSends().length).toBe(0);
    // Nothing stamped, so the next run is free to try again.
    expect(db.scheduled_calls[0].notification_channels).toBe(null);

    db.scheduled_calls[0].zoom_join_url = JOIN_URL;
    await get(CRON);
    expect(templateSends().length).toBe(1);
  });

  it('falls back to the number Calendly took at booking when the lead has none', async () => {
    // The real shape of every consultation already on file: our lead row never
    // captured a phone, but the booking answers carry one.
    const call = seedBooking({ invitee_notes: '+44 7828 859699\nspeak with khaleed' });
    seedLead(call.invitee_email, { phone: '' });

    const res = await get(CRON);
    expect(res.json.consultReminders.sent).toBe(1);
    expect(lastTemplate().to).toBe('+447828859699');
  });

  it('prefers the number the doctor gave us over the one typed into Calendly', async () => {
    const call = seedBooking({ invitee_notes: '+44 7000 000000' });
    seedLead(call.invitee_email); // has +44 7700 900123

    await get(CRON);
    expect(lastTemplate().to).toBe('+447700900123');
  });

  it('leaves out unsubscribed leads and bookers with no phone, and never claims an RSO call', async () => {
    const un = seedBooking();
    seedLead(un.invitee_email, {
      metadata: { consult: { stopped: 'unsubscribed' } }
    });
    const rso = seedBooking({ host_kind: 'rso', stage: 'amc' });
    seedLead(rso.invitee_email);
    const nophone = seedBooking();
    seedLead(nophone.invitee_email, { phone: '' });

    const res = await get(CRON);
    expect(res.json.consultReminders.sent).toBe(0);
    // host_kind='rso' is filtered by the consult query itself, so only two rows
    // are even examined — and both are correctly declined.
    expect(res.json.consultReminders.checked).toBe(2);
    // The RSO call is not dropped, it belongs to the other track.
    expect(res.json.registrationReminders.sent).toBe(1);
    expect(templateSends().length).toBe(1);
    expect(lastTemplate().content.templateName).toBe('gp_link_reg_call_reminder');
  });

  it('ignores cancelled bookings and calls already under way', async () => {
    const cancelled = seedBooking({ status: 'cancelled' });
    seedLead(cancelled.invitee_email);
    const started = seedBooking({ scheduled_at: new Date(Date.now() - 5 * MIN).toISOString() });
    seedLead(started.invitee_email);

    const res = await get(CRON);
    expect(templateSends().length).toBe(0);
    expect(res.json.consultReminders.checked).toBe(0);
  });

  it('reports its counts even when no RSO reminder is due', async () => {
    const res = await get(CRON);
    expect(res.status).toBe(200);
    expect(res.json.consultReminders).toMatchObject({ checked: 0, sent: 0 });
    expect(res.json.registrationReminders).toMatchObject({ checked: 0, sent: 0 });
  });
});

describe('registration-support calls — the doctor now gets reminded too', () => {
  function seedGpProfile(userId, first, last, phone) {
    db.user_profiles = db.user_profiles || [];
    db.user_profiles.push({ user_id: userId, first_name: first, last_name: last, phone });
  }

  beforeEach(() => { db.user_profiles = []; });

  it('sends the generic GP Link template, in the doctor’s own timezone', async () => {
    seedBooking({
      host_kind: 'rso',
      stage: 'ahpra',
      user_id: 'user-1',
      invitee_email: 'gp1@example.com',
      timezone: 'Australia/Sydney'
    });
    seedGpProfile('user-1', 'Mercy', 'Obanimoh', '+61 400 111 222');

    const res = await get(CRON);
    expect(res.json.registrationReminders.sent).toBe(1);
    expect(res.json.consultReminders.sent).toBe(0); // the CEO track ignored it

    const msg = lastTemplate();
    expect(msg.to).toBe('+61400111222');
    expect(msg.content.templateName).toBe('gp_link_reg_call_reminder');
    expect(msg.content.templateData.body.placeholders[0]).toBe('Mercy');
    // Rendered on THEIR clock, not "(UK time)".
    expect(msg.content.templateData.body.placeholders[1]).not.toContain('UK time');
    expect(msg.content.templateData.body.placeholders[2]).toBe(JOIN_URL);

    // Its own marker key, so it can never collide with the consult track.
    const stored = db.scheduled_calls[0].notification_channels;
    expect(stored.reg_call_reminders.h24).toBeTruthy();
    expect(stored.consult_reminders).toBeUndefined();
  });

  it('sends the starting-now variant and does not repeat itself', async () => {
    seedBooking({
      host_kind: 'rso', stage: 'amc', user_id: 'user-2',
      invitee_email: 'gp2@example.com',
      scheduled_at: new Date(Date.now() + 9 * MIN).toISOString()
    });
    seedGpProfile('user-2', 'Priya', 'Patel', '+44 7700 900555');

    await get(CRON);
    expect(templateSends().length).toBe(1);
    expect(lastTemplate().content.templateName).toBe('gp_link_reg_call_starting');
    expect(lastTemplate().content.templateData.body.placeholders).toEqual(['Priya', JOIN_URL]);

    await get(CRON);
    expect(templateSends().length).toBe(1);
  });

  it('still reminds a doctor who unsubscribed from the consult funnel long ago', async () => {
    // Their marketing opt-out is not an opt-out of a call they have booked with
    // their own RSO.
    seedBooking({ host_kind: 'rso', stage: 'myintealth', user_id: 'user-3', invitee_email: 'gp3@example.com' });
    seedLead('gp3@example.com', { phone: '', metadata: { consult: { stopped: 'unsubscribed' } } });
    seedGpProfile('user-3', 'Aisha', 'Khan', '+44 7700 900777');

    const res = await get(CRON);
    expect(res.json.registrationReminders.sent).toBe(1);
    expect(lastTemplate().to).toBe('+447700900777');
  });

  it('keeps the two tracks independent when a doctor has one of each', async () => {
    seedBooking({ host_kind: 'ceo', invitee_email: 'both@example.com' });
    seedBooking({ host_kind: 'rso', stage: 'amc', user_id: 'user-4', invitee_email: 'both@example.com' });
    seedLead('both@example.com');
    seedGpProfile('user-4', 'Sam', 'Reed', '+44 7700 900888');

    const res = await get(CRON);
    expect(res.json.consultReminders.sent).toBe(1);
    expect(res.json.registrationReminders.sent).toBe(1);
    const names = templateSends().map((s) => s.body.messages[0].content.templateName).sort();
    expect(names).toEqual(['gp_link_consult_call_reminder', 'gp_link_reg_call_reminder']);
  });
});

describe('formatCallTimeInZone', () => {
  const ISO = '2026-08-24T13:00:00Z';
  it('renders the booker’s clock, and falls back to UK when it cannot', () => {
    expect(waLib.formatCallTimeInZone(ISO, 'Europe/London')).toContain('(UK time)');
    expect(waLib.formatCallTimeInZone(ISO, '')).toContain('(UK time)');
    const syd = waLib.formatCallTimeInZone(ISO, 'Australia/Sydney');
    expect(syd).not.toContain('UK time');
    expect(syd).toContain('August');
    // 13:00 UTC is the 24th in London but 11pm the same day in Sydney.
    expect(syd).toContain('Monday 24 August');
    // A nonsense zone must not cost the doctor their reminder.
    expect(waLib.formatCallTimeInZone(ISO, 'Not/AZone')).toContain('(UK time)');
    expect(waLib.formatCallTimeInZone('', 'Australia/Sydney')).toBe('');
  });
});

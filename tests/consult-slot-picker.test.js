// The /start slot picker: our own list of Calendly's open times plus a
// server-side booking, so a recognised GP never waits on Calendly's booking
// app inside Facebook's browser (8–20 s on a phone, measured 2026-10-30).
//   GET  /api/public/consult-lead/slots?token= — open times (cached 60 s)
//   POST /api/public/consult-lead/book         — books via Calendly's API,
//                                                stamps the lead like a webhook
//   GET  /book                                 — short alias → /start#book
// Boots the real server in LOCAL-JSON mode with a stub Calendly started before
// the import (CALENDLY_API_TOKEN / CALENDLY_EVENT_TYPE_URI are module-level
// consts), the same harness as tests/lead-calls-endpoints.test.js.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-slot-picker-${RUN_ID}.json`;
const TOKEN = 'a'.repeat(32);

let server;
let addrPort;
let testUtils;
let calendlyServer;
let calendlyPort;
const calendlyRequests = [];
const calendlyInvitees = [];
// What the stub answers to POST /invitees: 'ok' | 'taken' | 'down'.
let inviteeMode = 'ok';

function request(method, path, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const h = Object.assign({}, headers || {});
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
    const req = http.request({ host: '127.0.0.1', port: addrPort, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* html or empty */ }
        resolve({ status: res.statusCode, headers: res.headers, json, raw });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}

// Two days of 10:00/10:30 UTC slots starting the day after tomorrow, plus one
// in the past and one 'unavailable' that must both be filtered out.
function stubSlots() {
  const out = [];
  const d = new Date();
  d.setUTCHours(10, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 2);
  for (let day = 0; day < 2; day++) {
    for (const min of [0, 30]) {
      const t = new Date(d.getTime() + day * 86400000 + min * 60000);
      out.push({ status: 'available', start_time: t.toISOString().replace('.000Z', 'Z'), invitees_remaining: 1 });
    }
  }
  // 5-minute increments Calendly sometimes lists; only :00 and :30 may show.
  out.push({ status: 'available', start_time: new Date(d.getTime() + 5 * 60000).toISOString().replace('.000Z', 'Z'), invitees_remaining: 1 });
  out.push({ status: 'available', start_time: new Date(d.getTime() + 35 * 60000).toISOString().replace('.000Z', 'Z'), invitees_remaining: 1 });
  out.push({ status: 'available', start_time: new Date(Date.now() - 3600000).toISOString(), invitees_remaining: 1 });
  out.push({ status: 'unavailable', start_time: new Date(d.getTime() + 5 * 86400000).toISOString(), invitees_remaining: 0 });
  return out;
}

function startCalendlyStub() {
  return new Promise((resolve) => {
    calendlyServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const u = new URL(req.url, 'http://stub');
        calendlyRequests.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams) });
        const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (req.method === 'GET' && u.pathname === '/event_type_available_times') {
          // Both 7-day windows get the same list; the server must dedupe.
          return send(200, { collection: stubSlots() });
        }
        if (req.method === 'GET' && u.pathname === '/users/me') return send(200, { resource: { uri: 'https://api.calendly.com/users/U1' } });
        if (req.method === 'GET' && u.pathname === '/event_types') {
          return send(200, { collection: [
            { uri: 'https://api.calendly.com/event_types/ET123', name: 'GP Registration Assistance', active: true, scheduling_url: 'https://calendly.com/hello-mygplink/gp-registration-assistance' },
            { uri: 'https://api.calendly.com/event_types/ET30', name: 'Finding The Perfect Australian Practice', active: true, scheduling_url: 'https://calendly.com/hello-mygplink/30min/' }
          ] });
        }
        if (req.method === 'GET' && u.pathname.startsWith('/event_types/')) {
          return send(200, { resource: {
            uri: 'https://api.calendly.com/event_types/' + u.pathname.split('/').pop(), name: 'Finding The Perfect Australian Practice', duration: 30,
            locations: [{ kind: 'zoom_conference' }], pooling_type: null,
            custom_questions: [{ name: 'Please share anything that will help prepare for our meeting.', type: 'text', position: 0, required: false, enabled: true }]
          } });
        }
        if (req.method === 'POST' && u.pathname === '/invitees') {
          let parsed = null;
          try { parsed = JSON.parse(body || 'null'); } catch { parsed = null; }
          calendlyInvitees.push(parsed);
          if (inviteeMode === 'taken') return send(422, { title: 'Invalid Argument', message: 'The start_time is no longer available.' });
          if (inviteeMode === 'down') return send(500, { message: 'boom' });
          return send(201, { resource: { uri: 'https://api.calendly.com/scheduled_events/EV/invitees/INV', event: 'https://api.calendly.com/scheduled_events/EV' } });
        }
        send(404, { message: 'not found' });
      });
    });
    calendlyServer.listen(0, '127.0.0.1', () => { calendlyPort = calendlyServer.address().port; resolve(); });
  });
}

function seedLead(overrides) {
  testUtils.__seedSiteEnquiriesForTest([Object.assign({
    id: 'lead-1', created_at: new Date().toISOString(), kind: 'gp',
    name: 'Aisha Khan', email: 'aisha@example.co.uk', phone: '+447700900123', status: 'new',
    metadata: {
      source: 'meta_lead_ad', fb_form_id: '1877370023630499',
      utm: { utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'uk-cold' },
      consult: { token: TOKEN, qualified: true, is_gp: true, country: 'uk', call_booked: false, nudges: [] }
    }
  }, overrides || {})]);
}

beforeAll(async () => {
  await startCalendlyStub();
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'test-slot-picker-' + RUN_ID;
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.CALENDLY_API_BASE = 'http://127.0.0.1:' + calendlyPort;
  process.env.CALENDLY_API_TOKEN = 'cal_test';
  // Production shape: Hazel's event type is NOT the consult. The picker must
  // find the consult (ET30) by the scheduling link, never book ET123.
  process.env.CALENDLY_EVENT_TYPE_URI = 'https://api.calendly.com/event_types/ET123';
  delete process.env.CONSULT_CALENDLY_EVENT_TYPE_URI;
  process.env.CONSULT_WHATSAPP_ENABLED = 'false';

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (calendlyServer) await new Promise((resolve) => calendlyServer.close(resolve));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

beforeEach(() => {
  calendlyRequests.length = 0;
  calendlyInvitees.length = 0;
  inviteeMode = 'ok';
  seedLead();
});

describe('GET /api/public/consult-lead/slots', () => {
  it('404s without a valid token', async () => {
    expect((await request('GET', '/api/public/consult-lead/slots')).status).toBe(404);
    expect((await request('GET', '/api/public/consult-lead/slots?token=nope')).status).toBe(404);
  });

  it('returns future :00/:30 times, deduped across both 7-day windows, sorted', async () => {
    const r = await request('GET', '/api/public/consult-lead/slots?token=' + TOKEN);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.duration_min).toBe(30);
    const starts = r.json.slots.map((s) => s.start_time);
    expect(starts.length).toBe(4);
    expect(starts).toEqual([...starts].sort());
    expect(new Set(starts).size).toBe(4);
    starts.forEach((s) => expect(Date.parse(s)).toBeGreaterThan(Date.now()));
    starts.forEach((s) => expect(new Date(s).getUTCMinutes() % 30).toBe(0));
    const avail = calendlyRequests.filter((q) => q.path === '/event_type_available_times');
    expect(avail.length).toBe(2);
    // The consult event, matched by scheduling_url — not Hazel's ET123.
    expect(avail[0].query.event_type).toBe('https://api.calendly.com/event_types/ET30');
    expect(avail[1].query.event_type).toBe('https://api.calendly.com/event_types/ET30');
  });

  it('looks the consult event type up once, then reuses it', async () => {
    await request('GET', '/api/public/consult-lead/slots?token=' + TOKEN);
    const seen = (p) => calendlyRequests.filter((q) => q.path === p).length;
    // beforeEach cleared the request log; the hour-long cache was filled by an
    // earlier test, so neither lookup call should appear again.
    expect(seen('/users/me') + seen('/event_types')).toBe(0);
  });

  it('serves the second call from cache without asking Calendly again', async () => {
    await request('GET', '/api/public/consult-lead/slots?token=' + TOKEN);
    const before = calendlyRequests.length;
    const r = await request('GET', '/api/public/consult-lead/slots?token=' + TOKEN);
    expect(r.json.ok).toBe(true);
    expect(calendlyRequests.length).toBe(before);
  });
});

describe('POST /api/public/consult-lead/book', () => {
  it('rejects a bad token, a missing slot and a slot in the past', async () => {
    const future = new Date(Date.now() + 3 * 86400000).toISOString();
    expect((await request('POST', '/api/public/consult-lead/book', { body: { token: 'nope', start_time: future } })).status).toBe(404);
    const noSlot = await request('POST', '/api/public/consult-lead/book', { body: { token: TOKEN } });
    expect(noSlot.status).toBe(400);
    expect(noSlot.json.reason).toBe('bad_slot');
    const past = await request('POST', '/api/public/consult-lead/book', { body: { token: TOKEN, start_time: new Date(Date.now() - 60000).toISOString() } });
    expect(past.status).toBe(400);
    expect(calendlyInvitees.length).toBe(0);
  });

  it('books through Calendly with the lead’s own details and stamps the lead', async () => {
    const slots = (await request('GET', '/api/public/consult-lead/slots?token=' + TOKEN)).json.slots;
    const pick = slots[1].start_time;
    const r = await request('POST', '/api/public/consult-lead/book', {
      body: { token: TOKEN, start_time: pick, tz: 'Europe/London', question: 'Can my partner <work> too?' }
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, start_time: pick, tz: 'Europe/London', duration_min: 30 });

    expect(calendlyInvitees.length).toBe(1);
    const inv = calendlyInvitees[0];
    expect(inv.event_type).toBe('https://api.calendly.com/event_types/ET30');
    expect(inv.start_time).toBe(pick);
    expect(inv.invitee).toMatchObject({ name: 'Aisha Khan', first_name: 'Aisha', last_name: 'Khan', email: 'aisha@example.co.uk', timezone: 'Europe/London' });
    // The ad's tags travel with the booking; utm_content names the path; every
    // key Calendly knows is present (it 400s on a partial tracking object).
    expect(inv.tracking).toEqual({ utm_content: 'start_slot_picker', utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'uk-cold', utm_term: null, salesforce_uuid: null });
    // Calendly 400s without the event type's location, so it is named.
    expect(inv.location).toEqual({ kind: 'zoom_conference' });
    // The optional note question carries the doctor's (sanitised) question.
    expect(inv.questions_and_answers).toEqual([
      { question: 'Please share anything that will help prepare for our meeting.', answer: 'Can my partner work too?', position: 0 }
    ]);

    const row = readDb().siteEnquiries.find((x) => x.id === 'lead-1');
    expect(row.status).toBe('contacted');
    expect(row.message).toBe('Can my partner work too?');
    expect(row.metadata.consult).toMatchObject({
      call_booked: true, call_at: pick, call_question: 'Can my partner work too?', booked_via: 'start_slot_picker'
    });
    expect(typeof row.metadata.consult.call_booked_at).toBe('string');
  });

  it('falls back to Europe/London for a time zone Intl does not know', async () => {
    const slots = (await request('GET', '/api/public/consult-lead/slots?token=' + TOKEN)).json.slots;
    const r = await request('POST', '/api/public/consult-lead/book', { body: { token: TOKEN, start_time: slots[0].start_time, tz: 'Mars/Olympus' } });
    expect(r.json.ok).toBe(true);
    expect(calendlyInvitees[0].invitee.timezone).toBe('Europe/London');
  });

  it('reports slot_taken on a 4xx about the start time, booking_failed otherwise, and leaves the lead unbooked', async () => {
    const slots = (await request('GET', '/api/public/consult-lead/slots?token=' + TOKEN)).json.slots;
    inviteeMode = 'taken';
    const taken = await request('POST', '/api/public/consult-lead/book', { body: { token: TOKEN, start_time: slots[0].start_time } });
    expect(taken.status).toBe(200);
    expect(taken.json).toEqual({ ok: false, reason: 'slot_taken' });
    inviteeMode = 'down';
    const down = await request('POST', '/api/public/consult-lead/book', { body: { token: TOKEN, start_time: slots[0].start_time } });
    expect(down.json).toEqual({ ok: false, reason: 'booking_failed' });
    const row = readDb().siteEnquiries.find((x) => x.id === 'lead-1');
    expect(row.metadata.consult.call_booked).toBe(false);
  });

  it('a booking invalidates the slots cache so the next list is fresh', async () => {
    const slots = (await request('GET', '/api/public/consult-lead/slots?token=' + TOKEN)).json.slots;
    await request('POST', '/api/public/consult-lead/book', { body: { token: TOKEN, start_time: slots[0].start_time } });
    const before = calendlyRequests.filter((q) => q.path === '/event_type_available_times').length;
    await request('GET', '/api/public/consult-lead/slots?token=' + TOKEN);
    const after = calendlyRequests.filter((q) => q.path === '/event_type_available_times').length;
    expect(after).toBe(before + 2);
  });
});

describe('the page and the short address', () => {
  it('GET /book 302s to /start#book and keeps the query string', async () => {
    const r = await request('GET', '/book?src=fb');
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/start?src=fb#book');
    const bare = await request('GET', '/book');
    expect(bare.headers.location).toBe('/start#book');
  });

  it('GET /start carries the slot picker and still the Calendly embed as fallback', async () => {
    const r = await request('GET', '/start');
    expect(r.status).toBe(200);
    for (const id of ['slotPicker', 'slotsDays', 'slotsTimes', 'slotConfirm', 'slotBook', 'slotsOpenCalendly', 'calendlyEmbed', 'confirmedWhen']) {
      expect(r.raw, id).toContain('id="' + id + '"');
    }
    expect(r.raw).toContain('/api/public/consult-lead/slots?token=');
    expect(r.raw).toContain('prefetchSlots(tokenParam)');
    expect(r.raw).toContain('id="slotWait"');
    expect(r.raw).toContain("post('/api/public/consult-lead/book'");
  });
});

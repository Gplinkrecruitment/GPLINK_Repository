// Endpoint tests for the Hazel outbound-call feature (lib/lead-calls.js bound
// in server.js): the cron that places calls, the Retell webhook, Hazel's tool
// endpoints and the CEO guards. Boots the real server in LOCAL-JSON mode
// (SUPABASE_URL='', temp DB file — same harness as
// tests/consult-nudge-cron.test.js) with two stub HTTP servers started BEFORE
// the import: a fake Retell (records /v2/create-phone-call bodies) and a fake
// Calendly (availability, event type, invitee creation). RETELL_API_URL and
// CALENDLY_API_BASE are read per request, but CALENDLY_API_TOKEN /
// CALENDLY_EVENT_TYPE_URI are module-level consts, so every env var is set
// before `import('../server.js')`.
//
// LEAD_CALLS_IGNORE_HOURS=true: the cron honours it ONLY under NODE_ENV=test,
// so the "places a call" case does not depend on the wall clock being inside
// UK calling hours when the suite runs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import { signRetellBody } from '../lib/lead-calls.js';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-lead-calls-${RUN_ID}.json`;
const API_KEY = 'key_test';
const CRON = '/api/cron/lead-calls';
const AUTH = { Authorization: 'Bearer test-cron-secret' };
const MIN = 60 * 1000;

let server;
let addrPort;
let testUtils;
let retellServer;
let retellPort;
const retellCalls = [];
let calendlyServer;
let calendlyPort;
const calendlyRequests = [];
const calendlyInvitees = [];

function request(method, path, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(String(body), 'utf8');
    const h = Object.assign({}, headers || {});
    if (payload) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = payload.length; }
    const req = http.request({ host: '127.0.0.1', port: addrPort, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* plain text */ }
        resolve({ status: res.statusCode, headers: res.headers, json, raw });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// A request signed the way Retell signs webhooks and tool calls.
function signed(path, payload) {
  const raw = JSON.stringify(payload);
  return request('POST', path, { body: raw, headers: { 'X-Retell-Signature': signRetellBody(raw, API_KEY, Date.now()) } });
}

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}
function leadRow(id) {
  return (readDb().siteEnquiries || []).find((r) => r.id === id);
}

function seedLead(overrides = {}) {
  return Object.assign({
    id: 'lead-1', kind: 'gp', name: 'Dr Sarah Patel', email: 'sarah@nhs.net', phone: '+44 7700 900123',
    state: 'uk', status: 'new', created_at: new Date(Date.now() - 30 * MIN).toISOString(),
    metadata: { source: 'meta_lead_ad', consult: { token: 'TOK1', qualified: true, is_gp: true, country: 'uk', call_booked: false, nudges: [] } }
  }, overrides);
}

function startRetellStub() {
  return new Promise((resolve) => {
    retellServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body || 'null'); } catch { parsed = null; }
        if (req.method === 'POST' && req.url === '/v2/create-phone-call') {
          retellCalls.push({ auth: req.headers.authorization, body: parsed });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ call_id: 'call_test_1', call_status: 'registered', agent_id: 'agent_1' }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'not found' }));
      });
    });
    retellServer.listen(0, '127.0.0.1', () => { retellPort = retellServer.address().port; resolve(); });
  });
}

// Three future weekday slots at 10:00 UTC — a London morning all year round,
// and far enough out to clear pickSlots' 90-minute lead time.
function futureSlots() {
  const out = [];
  const d = new Date();
  d.setUTCHours(10, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 2);
  while (out.length < 3) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push({ status: 'available', start_time: d.toISOString().replace('.000Z', 'Z'), invitees_remaining: 1 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function startCalendlyStub() {
  return new Promise((resolve) => {
    calendlyServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const u = new URL(req.url, 'http://stub');
        calendlyRequests.push({ method: req.method, path: u.pathname, auth: req.headers.authorization });
        const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (req.method === 'GET' && u.pathname === '/event_type_available_times') return send(200, { collection: futureSlots() });
        if (req.method === 'GET' && u.pathname.startsWith('/event_types/')) {
          return send(200, { resource: {
            uri: 'https://api.calendly.com/event_types/ET123', name: 'GP Link consultation', duration: 30, active: true, kind: 'solo',
            locations: [{ kind: 'zoom' }],
            custom_questions: [{ name: 'Phone number', type: 'phone_number', position: 0, required: true, enabled: true }]
          } });
        }
        if (req.method === 'POST' && u.pathname === '/invitees') {
          let parsed = null;
          try { parsed = JSON.parse(body || 'null'); } catch { parsed = null; }
          calendlyInvitees.push(parsed);
          return send(201, { resource: { uri: 'https://api.calendly.com/scheduled_events/EV/invitees/INV', event: 'https://api.calendly.com/scheduled_events/EV' } });
        }
        send(404, { message: 'not found' });
      });
    });
    calendlyServer.listen(0, '127.0.0.1', () => { calendlyPort = calendlyServer.address().port; resolve(); });
  });
}

beforeAll(async () => {
  await startRetellStub();
  await startCalendlyStub();

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'test-lead-calls-' + RUN_ID;
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.LEAD_CALLS_ENABLED = 'true';
  process.env.LEAD_CALLS_IGNORE_HOURS = 'true';
  process.env.RETELL_API_KEY = API_KEY;
  process.env.RETELL_AGENT_ID = 'agent_1';
  process.env.RETELL_FROM_NUMBER_UK = '+442030000000';
  process.env.RETELL_FROM_NUMBER_AU = '+61280000000';
  process.env.RETELL_API_URL = 'http://127.0.0.1:' + retellPort;
  process.env.CALENDLY_API_BASE = 'http://127.0.0.1:' + calendlyPort;
  process.env.CALENDLY_API_TOKEN = 'cal_test';
  process.env.CALENDLY_EVENT_TYPE_URI = 'https://api.calendly.com/event_types/ET123';
  process.env.CONSULT_WHATSAPP_ENABLED = 'false';

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (retellServer) await new Promise((resolve) => retellServer.close(resolve));
  if (calendlyServer) await new Promise((resolve) => calendlyServer.close(resolve));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

describe('GET /api/cron/lead-calls', () => {
  it('401s without the secret', async () => {
    expect((await request('GET', CRON)).status).toBe(401);
    expect((await request('GET', CRON, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  it('is a no-op while LEAD_CALLS_ENABLED is unset', async () => {
    const saved = process.env.LEAD_CALLS_ENABLED;
    delete process.env.LEAD_CALLS_ENABLED;
    try {
      const r = await request('GET', CRON, { headers: AUTH });
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ok: true, disabled: true });
    } finally { process.env.LEAD_CALLS_ENABLED = saved; }
    expect(retellCalls.length).toBe(0);
  });

  it('places one call for a fresh qualified UK lead and stamps consult.ai_call', async () => {
    testUtils.__seedSiteEnquiriesForTest([seedLead()]);
    const r = await request('GET', CRON, { headers: AUTH });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.called).toBe(1);
    expect(r.json.scanned).toBe(1);
    expect(r.json.partial).toBe(false);

    expect(retellCalls.length).toBe(1);
    const sent = retellCalls[0];
    expect(sent.auth).toBe('Bearer ' + API_KEY);
    expect(sent.body.from_number).toBe('+442030000000');
    expect(sent.body.to_number).toBe('+447700900123');
    expect(sent.body.override_agent_id).toBe('agent_1');
    expect(sent.body.idempotency_key).toBe('lead-lead-1-a1');
    expect(sent.body.metadata).toEqual({ enquiry_id: 'lead-1', attempt: 1, source: 'lead-calls-cron' });
    const vars = sent.body.retell_llm_dynamic_variables;
    expect(vars.first_name).toBe('Sarah');
    expect(vars.country_spoken).toBe('the UK');
    expect(vars.lead_timezone).toBe('Europe/London');
    expect(vars.attempt).toBe('1');
    Object.values(vars).forEach((v) => expect(typeof v).toBe('string'));

    const consult = leadRow('lead-1').metadata.consult;
    expect(consult.ai_call.call_id).toBe('call_test_1');
    expect(consult.ai_call.status).toBe('registered');
    expect(consult.ai_call.attempt).toBe(1);
    expect(consult.ai_call.from_number).toBe('+442030000000');
    expect(consult.token).toBe('TOK1'); // other consult keys untouched
    expect(consult.qualified).toBe(true);
  });

  it('places nothing on the next tick while that call is in progress', async () => {
    const r = await request('GET', CRON, { headers: AUTH });
    expect(r.status).toBe(200);
    expect(r.json.called).toBe(0);
    expect(r.json.skipped).toEqual({ call_in_progress: 1 });
    expect(retellCalls.length).toBe(1);
  });
});

describe('POST /api/webhooks/retell', () => {
  const analyzed = {
    event: 'call_analyzed',
    call: {
      call_id: 'call_test_1', call_type: 'phone_call', direction: 'outbound', agent_id: 'agent_1', call_status: 'ended',
      from_number: '+442030000000', to_number: '+447700900123',
      metadata: { enquiry_id: 'lead-1', attempt: 1, source: 'lead-calls-cron' },
      start_timestamp: Date.now() - 200000, end_timestamp: Date.now() - 80000, duration_ms: 120000,
      disconnection_reason: 'agent_hangup',
      transcript: 'Agent: Hi Sarah, it is Hazel from GP Link. User: Not for me right now, thanks.',
      call_analysis: {
        call_summary: 'Sarah said she is not looking to move right now.',
        user_sentiment: 'Neutral', call_successful: true,
        custom_analysis_data: { outcome: 'not_interested' }
      }
    }
  };

  it('401s on a bad or missing signature', async () => {
    const raw = JSON.stringify(analyzed);
    const bad = await request('POST', '/api/webhooks/retell', { body: raw, headers: { 'X-Retell-Signature': 'v=' + Date.now() + ',d=' + 'ab'.repeat(32) } });
    expect(bad.status).toBe(401);
    expect((await request('POST', '/api/webhooks/retell', { body: raw })).status).toBe(401);
    expect(leadRow('lead-1').metadata.consult.ai_call.status).toBe('registered');
  });

  it('answers 204 and folds call_analyzed into the lead', async () => {
    const r = await signed('/api/webhooks/retell', analyzed);
    expect(r.status).toBe(204);
    const consult = leadRow('lead-1').metadata.consult;
    expect(consult.ai_call.call_id).toBe('call_test_1');
    expect(consult.ai_call.outcome).toBe('not_interested');
    expect(consult.ai_call.status).toBe('ended');
    expect(consult.ai_call.duration_s).toBe(120);
    expect(consult.ai_call.summary).toContain('not looking to move');
    expect(consult.ai_calls.length).toBe(1);
    expect(consult.stopped).toBe('not_interested');
    // Retell retries deliveries — the fold-in is idempotent.
    expect((await signed('/api/webhooks/retell', analyzed)).status).toBe(204);
    expect(leadRow('lead-1').metadata.consult.ai_calls.length).toBe(1);
  });

  it('answers 204 to events it does not handle', async () => {
    expect((await signed('/api/webhooks/retell', { event: 'something_else', call: { call_id: 'x' } })).status).toBe(204);
  });
});

describe('POST /api/retell/tools/*', () => {
  const call = { call_id: 'call_test_1', to_number: '+447700900123', from_number: '+442030000000', metadata: { enquiry_id: 'lead-1' } };
  let slotId = '';

  it('401s on a bad signature', async () => {
    const r = await request('POST', '/api/retell/tools/check-availability', {
      body: JSON.stringify({ name: 'check_availability', call, args: {} }),
      headers: { 'X-Retell-Signature': 'v=1,d=00' }
    });
    expect(r.status).toBe(401);
  });

  it('check-availability lists open times with slot ids', async () => {
    const r = await signed('/api/retell/tools/check-availability', { name: 'check_availability', call, args: { time_of_day: 'any' } });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.raw).toContain("Open times, shown in the doctor's local time (Europe/London)");
    expect(r.raw).toContain('slot_id');
    expect(r.raw).toContain('call book_consult with the slot_id exactly as written');
    const m = /slot_id (\S+)/.exec(r.raw);
    slotId = m && m[1];
    expect(slotId).toBeTruthy();
    expect(Number.isFinite(Date.parse(slotId))).toBe(true);
    expect(calendlyRequests.some((q) => q.path === '/event_type_available_times' && q.auth === 'Bearer cal_test')).toBe(true);
  });

  it('book-consult creates the Calendly invitee and books the lead', async () => {
    const r = await signed('/api/retell/tools/book-consult', { name: 'book_consult', call, args: { slot_id: slotId } });
    expect(r.status).toBe(200);
    expect(r.raw).toMatch(/^Booked for /);
    expect(r.raw).toContain('sarah@nhs.net');
    expect(calendlyInvitees.length).toBe(1);
    const inv = calendlyInvitees[0];
    expect(inv.event_type).toBe('https://api.calendly.com/event_types/ET123');
    expect(inv.start_time).toBe(slotId);
    expect(inv.invitee.email).toBe('sarah@nhs.net');
    expect(inv.invitee.timezone).toBe('Europe/London');
    expect(inv.questions_and_answers).toEqual([{ question: 'Phone number', answer: '+447700900123', position: 0 }]);

    const consult = leadRow('lead-1').metadata.consult;
    expect(consult.call_booked).toBe(true);
    expect(consult.call_at).toBe(slotId);
    expect(consult.ai_call.tool_outcome).toBe('booked');
    expect(consult.ai_call.booked_slot).toBe(slotId);
  });

  it('book-consult refuses to double-book', async () => {
    const r = await signed('/api/retell/tools/book-consult', { name: 'book_consult', call, args: { slot_id: slotId } });
    expect(r.status).toBe(200);
    expect(r.raw).toContain('already has a call booked');
    expect(calendlyInvitees.length).toBe(1);
  });

  it('mark-outcome stamps the call', async () => {
    const r = await signed('/api/retell/tools/mark-outcome', {
      name: 'mark_outcome', call, args: { outcome: 'callback_requested', callback_hours: 48, note: 'Ring after her shift' }
    });
    expect(r.raw).toBe('Noted.');
    const ai = leadRow('lead-1').metadata.consult.ai_call;
    expect(ai.tool_outcome).toBe('callback_requested');
    expect(ai.callback_note).toBe('Ring after her shift');
    expect(Date.parse(ai.callback_at) - Date.now()).toBeGreaterThan(47 * 3600000);
    const bad = await signed('/api/retell/tools/mark-outcome', { name: 'mark_outcome', call, args: { outcome: 'bogus' } });
    expect(bad.raw).toContain('Unknown outcome');
  });

  it('tells Hazel when no lead matches', async () => {
    const r = await signed('/api/retell/tools/check-availability', {
      name: 'check_availability', call: { call_id: 'call_x', to_number: '+447000000000', metadata: {} }, args: {}
    });
    expect(r.status).toBe(200);
    expect(r.raw).toContain('Lead record not found');
  });

  it('404s an unknown tool', async () => {
    expect((await signed('/api/retell/tools/nope', { name: 'nope', call, args: {} })).status).toBe(404);
  });
});

describe('CEO endpoints', () => {
  it('require a CEO session', async () => {
    const t = await request('POST', '/api/ceo/lead-calls/test', { body: JSON.stringify({ to_number: '+447700900123' }) });
    expect([401, 403]).toContain(t.status);
    expect([401, 403]).toContain((await request('GET', '/api/ceo/lead-calls')).status);
    expect([401, 403]).toContain((await request('GET', '/api/ceo/lead-calls/calendly-check')).status);
    expect(retellCalls.length).toBe(1);
  });
});

describe('inbound webhook (a doctor rings the UK number)', () => {
  it('returns the known caller as dynamic variables plus the lead id for the tools', async () => {
    const r = await signed('/api/webhooks/retell-inbound', { event: 'call_inbound', call_inbound: { agent_id: 'agent_in', from_number: '+447700900123', to_number: '+447862121872' } });
    expect(r.status).toBe(200);
    expect(r.json.call_inbound.dynamic_variables.first_name).toBe('Sarah');
    expect(r.json.call_inbound.dynamic_variables.email_on_file).toBe('sarah@nhs.net');
    expect(r.json.call_inbound.metadata.enquiry_id).toBe('lead-1');
  });

  it('gives blank name fields for an unknown caller and rejects an unsigned request', async () => {
    const r = await signed('/api/webhooks/retell-inbound', { event: 'call_inbound', call_inbound: { from_number: '+447700900999', to_number: '+447862121872' } });
    expect(r.status).toBe(200);
    expect(r.json.call_inbound.dynamic_variables.first_name).toBe('');
    expect(r.json.call_inbound.metadata).toBeUndefined();
    const bad = await request('POST', '/api/webhooks/retell-inbound', { body: JSON.stringify({ event: 'call_inbound' }) });
    expect(bad.status).toBe(401);
  });
});

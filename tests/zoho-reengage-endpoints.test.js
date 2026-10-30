// End-to-end for the Zoho WhatsApp re-engagement (lib/zoho-reengage.js bound in
// server.js): the drip cron sends the template once per UK mobile, the CEO
// endpoint reports and tests, and a "Yes, call me" tap on the DoubleTick webhook
// becomes a qualified lead the lead-calls cron rings. Boots the real server in
// LOCAL-JSON mode (same harness as tests/ceo-leads-endpoint.test.js) with two stub
// HTTP servers started BEFORE the import: a fake Retell and a fake DoubleTick.
// Candidate rows are written into the temp DB file before boot, since there is no
// seeding util for candidate_leads.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import { signRetellBody } from '../lib/lead-calls.js';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-zoho-reengage-${RUN_ID}.json`;
const SUPER_HOST = 'ats-test.local';
const WEBHOOK_SECRET = 'whsec-test-' + RUN_ID + '-0123456789';
const CRON_AUTH = { Authorization: 'Bearer test-cron-secret' };
const CRON = '/api/cron/zoho-reengage';
const MIN = 60 * 1000;

let server, port, testUtils;
let retellServer, retellPort, dtServer, dtPort;
const retellCalls = [];
const dtTemplates = [];
const dtTexts = [];

function b64url(s) {
  return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function superCookie() {
  const payload = b64url(JSON.stringify({ userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' }, expiresAt: Date.now() + 3600000 }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, { host, cookie, headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers || {});
    if (host) h.Host = host;
    if (cookie) h.Cookie = cookie;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let json = null; try { json = JSON.parse(raw); } catch { /* text */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    r.on('error', reject); r.end(payload);
  });
}
const ceo = (method, p, body) => httpReq(method, p, { host: SUPER_HOST, cookie: superCookie(), body });
const hook = (from, message, id) => httpReq('POST', '/api/webhooks/doubletick?secret=' + encodeURIComponent(WEBHOOK_SECRET), {
  body: { to: '61494391968', from, contact: { name: 'WhatsApp name' }, message, messageId: id || ('m_' + crypto.randomBytes(3).toString('hex')) }
});
function readDb() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; } }

function startStub(onRequest) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(body || 'null'); } catch { parsed = null; }
        const out = onRequest(req, parsed);
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
}

const CANDIDATES = [
  { id: 'cand_priya', zoho_candidate_id: 'z1', name: 'Dr Priya Patel', email: 'Priya@Example.co.uk', phone: '07700 900123', source: 'zoho_recruit', unsubscribed: false, created_at: '2026-02-01T00:00:00.000Z' },
  { id: 'cand_ben', zoho_candidate_id: 'z2', name: 'Ben Okafor', email: 'ben@example.co.uk', phone: '+447700900456', source: 'zoho_recruit', unsubscribed: false, created_at: '2025-11-01T00:00:00.000Z' },
  { id: 'cand_cara', zoho_candidate_id: 'z3', name: 'Dr Cara Byrne', email: 'cara@example.co.uk', phone: '+447700900789', source: 'zoho_recruit', unsubscribed: false, created_at: '2025-10-01T00:00:00.000Z' },
  { id: 'cand_au', zoho_candidate_id: 'z4', name: 'Dr Syd Ney', email: 'syd@example.com.au', phone: '+61406000000', source: 'zoho_recruit', unsubscribed: false, created_at: '2026-03-01T00:00:00.000Z' },
  { id: 'cand_unsub', zoho_candidate_id: 'z5', name: 'Dr Gone', email: 'gone@example.co.uk', phone: '+447700900999', source: 'zoho_recruit', unsubscribed: true, created_at: '2026-04-01T00:00:00.000Z' }
];

beforeAll(async () => {
  const retell = await startStub((req, parsed) => {
    if (req.method === 'POST' && req.url === '/v2/create-phone-call') {
      retellCalls.push(parsed);
      return { status: 201, body: { call_id: 'call_zr_' + retellCalls.length, call_status: 'registered', agent_id: 'agent_1' } };
    }
    return { status: 404, body: { message: 'not found' } };
  });
  retellServer = retell.server; retellPort = retell.port;
  const dt = await startStub((req, parsed) => {
    if (req.method === 'POST' && req.url === '/whatsapp/message/template') { dtTemplates.push(parsed); return { status: 200, body: { messages: [{ status: 'SENT', messageId: 'dt_t_' + dtTemplates.length }] } }; }
    if (req.method === 'POST' && req.url === '/whatsapp/message/text') { dtTexts.push(parsed); return { status: 200, body: { messageId: 'dt_x_' + dtTexts.length } }; }
    return { status: 404, body: { message: 'not found' } };
  });
  dtServer = dt.server; dtPort = dt.port;

  fs.writeFileSync(DB_FILE, JSON.stringify({ candidateLeads: CANDIDATES, siteEnquiries: [] }));

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'zoho-reengage-test-' + RUN_ID;
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.SUPER_ADMIN_ALLOWED_HOSTS = SUPER_HOST;
  process.env.SUPER_ADMIN_EMAILS = 'super@gplink-test.local';
  process.env.ADMIN_EMAILS = '';
  process.env.DOUBLETICK_BASE_URL = 'http://127.0.0.1:' + dtPort;
  process.env.DOUBLETICK_API_KEY = 'dt_test_key';
  process.env.DOUBLETICK_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.ZOHO_REENGAGE_PER_DAY = '2';
  process.env.ZOHO_REENGAGE_IGNORE_WINDOW = 'true';
  process.env.RETELL_API_URL = 'http://127.0.0.1:' + retellPort;
  process.env.RETELL_API_KEY = 'key_test';
  process.env.RETELL_AGENT_ID = 'agent_1';
  process.env.RETELL_FROM_NUMBER_UK = '+442030000000';
  process.env.LEAD_CALLS_ENABLED = 'true';
  process.env.LEAD_CALLS_IGNORE_HOURS = 'true';
  process.env.CONSULT_WHATSAPP_ENABLED = 'false';
  delete process.env.LEAD_CALLS_TEST_NUMBERS;
  delete process.env.NOTIFY_TEST_RECIPIENTS;

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (retellServer) await new Promise((r) => retellServer.close(r));
  if (dtServer) await new Promise((r) => dtServer.close(r));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

describe('GET /api/cron/zoho-reengage', () => {
  it('401s without the secret', async () => {
    expect((await httpReq('GET', CRON)).status).toBe(401);
    expect((await httpReq('GET', CRON, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  it('dry run counts the UK mobiles without sending anything', async () => {
    const r = await httpReq('GET', CRON + '?dry_run=1', { headers: CRON_AUTH });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, dry_run: true, sent: 0, eligible_total: 3 });
    expect(r.json.counts).toMatchObject({ scanned: 5, unsubscribed: 1, not_uk_mobile: 1, already_sent: 0, eligible: 3 });
    expect(r.json.sample.map((s) => s.name)).toEqual(['Dr Priya Patel', 'Ben Okafor', 'Dr Cara Byrne']);
    expect(dtTemplates.length).toBe(0);
  });

  it('is off until ZOHO_REENGAGE_PER_DAY is set', async () => {
    const saved = process.env.ZOHO_REENGAGE_PER_DAY;
    delete process.env.ZOHO_REENGAGE_PER_DAY;
    try {
      const r = await httpReq('GET', CRON, { headers: CRON_AUTH });
      expect(r.json).toEqual({ ok: true, skipped: 'ZOHO_REENGAGE_PER_DAY is 0' });
    } finally { process.env.ZOHO_REENGAGE_PER_DAY = saved; }
    expect(dtTemplates.length).toBe(0);
  });

  it('sends the template to the newest UK mobiles first, the daily number at a time, and never twice', async () => {
    const r1 = await httpReq('GET', CRON, { headers: CRON_AUTH });
    expect(r1.json).toMatchObject({ ok: true, sent: 2, failed: 0 });
    expect(dtTemplates.length).toBe(2);
    const m1 = dtTemplates[0].messages[0];
    expect(m1.to).toBe('+447700900123');
    expect(m1.from).toBe('61494391968');
    expect(m1.content.templateName).toBe('gp_link_reengage_hayley');
    expect(m1.content.templateData.body.placeholders).toEqual(['Priya']);
    expect(dtTemplates[1].messages[0].to).toBe('+447700900456');
    expect(dtTemplates[1].messages[0].content.templateData.body.placeholders).toEqual(['Ben']);

    const r2 = await httpReq('GET', CRON, { headers: CRON_AUTH });
    expect(r2.json).toMatchObject({ ok: true, sent: 1 });
    expect(dtTemplates[2].messages[0].to).toBe('+447700900789');

    const r3 = await httpReq('GET', CRON, { headers: CRON_AUTH });
    expect(r3.json).toMatchObject({ ok: true, sent: 0, eligible_total: 0 });
    expect(r3.json.counts.already_sent).toBe(3);
    expect(dtTemplates.length).toBe(3);
  });
});

describe('/api/ceo/reengage/zoho', () => {
  it('requires a CEO session', async () => {
    expect([401, 403]).toContain((await httpReq('GET', '/api/ceo/reengage/zoho', { host: SUPER_HOST })).status);
    expect([401, 403]).toContain((await httpReq('POST', '/api/ceo/reengage/zoho', { host: SUPER_HOST, body: { limit: 1 } })).status);
  });

  it('reports what has gone out and what is left', async () => {
    const r = await ceo('GET', '/api/ceo/reengage/zoho');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, template: 'gp_link_reengage_hayley', per_day: 2, messaged_total: 3, eligible_remaining: 0 });
    expect(r.json.replies).toMatchObject({ sent: 3, replied_yes: 0, replied_no: 0, stopped: 0 });
    expect(r.json.last_sent_at).toBeTruthy();
  });

  it('sends a test to one number without recording it', async () => {
    const before = dtTemplates.length;
    const r = await ceo('POST', '/api/ceo/reengage/zoho', { test_phone: '+61 406 281 243' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(dtTemplates.length).toBe(before + 1);
    expect(dtTemplates[before].messages[0].to).toBe('+61406281243');
    expect(dtTemplates[before].messages[0].content.templateData.body.placeholders).toEqual(['Doctor']);
    expect((await ceo('GET', '/api/ceo/reengage/zoho')).json.messaged_total).toBe(3);
    expect((await ceo('POST', '/api/ceo/reengage/zoho', { test_phone: 'not a number' })).status).toBe(400);
  });

  it('a dry-run preview sends nothing', async () => {
    const before = dtTemplates.length;
    const r = await ceo('POST', '/api/ceo/reengage/zoho', { dry_run: true, limit: 25 });
    expect(r.json).toMatchObject({ ok: true, dry_run: true, sent: 0 });
    expect(dtTemplates.length).toBe(before);
  });
});

describe('POST /api/webhooks/doubletick replies from messaged candidates', () => {
  it('401s with the wrong secret', async () => {
    const r = await httpReq('POST', '/api/webhooks/doubletick?secret=nope', { body: { from: '+447700900123', message: { type: 'TEXT', text: 'yes' } } });
    expect(r.status).toBe(401);
  });

  it('turns a "Yes, call me" button tap into a qualified lead, replies on WhatsApp, and the dialler rings it', async () => {
    const textsBefore = dtTexts.length;
    const r = await hook('+447700900123', { type: 'BUTTON', button: { text: 'Yes, call me', payload: 'Yes, call me' } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, action: 'reengage_yes' });

    const rows = (readDb().siteEnquiries || []).filter((x) => x.phone === '+447700900123');
    expect(rows.length).toBe(1);
    const lead = rows[0];
    expect(lead.kind).toBe('gp');
    expect(lead.name).toBe('Dr Priya Patel');
    expect(lead.email).toBe('priya@example.co.uk');
    expect(lead.metadata.source).toBe('zoho_reengagement');
    expect(lead.metadata.zoho_candidate_id).toBe('cand_priya');
    expect(lead.metadata.consult).toMatchObject({ qualified: true, is_gp: null, country: 'uk', call_booked: false });
    expect(lead.metadata.consult.token).toBeTruthy();
    expect(lead.metadata.consult.screened_out).toBeUndefined();
    expect(lead.message).toContain('Replied "Yes, call me"');

    expect(dtTexts.length).toBe(textsBefore + 1);
    const reply = dtTexts[textsBefore];
    expect(reply.to).toBe('+447700900123');
    expect(reply.content.text).toContain('Great, Priya. Hayley from GP Link will ring you from +442030000000');
    expect(reply.content.text).toContain('/start?lead=' + encodeURIComponent(lead.metadata.consult.token) + '#book');

    const stats = await ceo('GET', '/api/ceo/reengage/zoho');
    expect(stats.json.replies).toMatchObject({ sent: 2, replied_yes: 1 });

    // Age the lead past the dialler's minimum, then the lead-calls cron rings it.
    const all = readDb().siteEnquiries.map((x) => (x.id === lead.id ? Object.assign({}, x, { created_at: new Date(Date.now() - 30 * MIN).toISOString() }) : x));
    testUtils.__seedSiteEnquiriesForTest(all);
    const cron = await httpReq('GET', '/api/cron/lead-calls', { headers: CRON_AUTH });
    expect(cron.status).toBe(200);
    expect(cron.json.called).toBe(1);
    expect(retellCalls.length).toBe(1);
    expect(retellCalls[0].to_number).toBe('+447700900123');
    expect(retellCalls[0].from_number).toBe('+442030000000');
    const vars = retellCalls[0].retell_llm_dynamic_variables;
    expect(vars.first_name).toBe('Priya');
    expect(vars.enquiry_source).toBe('our WhatsApp message');
    expect(vars.enquiry_question).toContain('Yes, call me');
  });

  it('records "Not right now" with a polite reply and no lead', async () => {
    const textsBefore = dtTexts.length;
    const r = await hook('+447700900456', { type: 'TEXT', text: 'Not right now' });
    expect(r.json).toEqual({ ok: true, action: 'reengage_no' });
    expect((readDb().siteEnquiries || []).filter((x) => x.phone === '+447700900456').length).toBe(0);
    expect(dtTexts.length).toBe(textsBefore + 1);
    expect(dtTexts[textsBefore].to).toBe('+447700900456');
    expect(dtTexts[textsBefore].content.text).toContain('No problem at all, Ben');
    expect((await ceo('GET', '/api/ceo/reengage/zoho')).json.replies.replied_no).toBe(1);
  });

  it('STOP unsubscribes the candidate and sends nothing back', async () => {
    const textsBefore = dtTexts.length;
    const r = await hook('+447700900789', { type: 'TEXT', text: 'STOP' });
    expect(r.json).toEqual({ ok: true, action: 'reengage_stop' });
    expect(dtTexts.length).toBe(textsBefore);
    const cara = (readDb().candidateLeads || []).find((c) => c.id === 'cand_cara');
    expect(cara.unsubscribed).toBe(true);
    expect((await ceo('GET', '/api/ceo/reengage/zoho')).json.replies.stopped).toBe(1);
    // Nothing left to message and nobody double-messaged after all that.
    expect((await httpReq('GET', CRON, { headers: CRON_AUTH })).json).toMatchObject({ ok: true, sent: 0 });
  });
});

describe('GET /api/cron/zoho-import and call chaining', () => {
  const IMPORT = '/api/cron/zoho-import';
  const signed = (payload) => {
    const raw = JSON.stringify(payload);
    return httpReq('POST', '/api/webhooks/retell', { headers: { 'X-Retell-Signature': signRetellBody(raw, 'key_test', Date.now()), 'Content-Type': 'application/json' }, body: payload });
  };

  it('401s without the secret and only counts without ?confirm=1', async () => {
    expect((await httpReq('GET', IMPORT)).status).toBe(401);
    const r = await httpReq('GET', IMPORT, { headers: CRON_AUTH });
    expect(r.status).toBe(200);
    // priya is already a lead carrying her Zoho id (she said yes), cara and gone
    // are unsubscribed, syd is AU: only ben is left.
    expect(r.json).toMatchObject({ ok: true, confirm: false, imported: 0 });
    expect(r.json.counts).toMatchObject({ scanned: 5, unsubscribed: 2, not_uk_mobile: 1, already_imported: 1, already_lead: 0, eligible: 1 });
    expect(r.json.sample[0].name).toBe('Ben Okafor');
    expect((readDb().siteEnquiries || []).filter((x) => x.phone === '+447700900456').length).toBe(0);
  });

  it('imports the candidate as a lead Hayley rings, behind the real leads, with no pre-booking nudges', async () => {
    const r = await httpReq('GET', IMPORT + '?confirm=1', { headers: CRON_AUTH });
    expect(r.json).toMatchObject({ ok: true, confirm: true, imported: 1, failed: 0 });
    const rows = (readDb().siteEnquiries || []).filter((x) => x.phone === '+447700900456');
    expect(rows.length).toBe(1);
    const ben = rows[0];
    expect(ben).toMatchObject({ kind: 'gp', name: 'Ben Okafor', email: 'ben@example.co.uk', created_at: '2025-11-01T00:00:00.000Z', message: null });
    expect(ben.metadata.source).toBe('zoho_import');
    expect(ben.metadata.zoho_candidate_id).toBe('cand_ben');
    expect(ben.metadata.consult).toMatchObject({ qualified: true, is_gp: null, country: 'uk', call_booked: false, nudges_disabled: 'not_booked' });
    expect(ben.metadata.consult.token).toBeTruthy();
    // Idempotent.
    const again = await httpReq('GET', IMPORT + '?confirm=1', { headers: CRON_AUTH });
    expect(again.json).toMatchObject({ imported: 0 });
    expect(again.json.counts.already_imported).toBe(2);
  });

  it('rings one doctor at a time: nothing goes out while Priya\'s call is live', async () => {
    const before = retellCalls.length;
    const r = await httpReq('GET', '/api/cron/lead-calls', { headers: CRON_AUTH });
    expect(r.json.called).toBe(0);
    expect(r.json.skipped.another_call_in_progress).toBe(1);
    expect(retellCalls.length).toBe(before);
  });

  it('chains: the moment Priya\'s call ends, Ben is rung with the "registered a while back" opener', async () => {
    const priya = (readDb().siteEnquiries || []).find((x) => x.phone === '+447700900123');
    const before = retellCalls.length;
    const now = Date.now();
    const r = await signed({ event: 'call_ended', call: {
      call_id: 'call_zr_1', agent_id: 'agent_1', call_type: 'phone_call', direction: 'outbound',
      from_number: '+442030000000', to_number: '+447700900123', call_status: 'ended', disconnection_reason: 'user_hangup',
      start_timestamp: now - 90000, end_timestamp: now, transcript: 'Agent: Hi, is this Doctor Priya?\nUser: Sorry, not now.',
      metadata: { enquiry_id: priya.id, attempt: 1, source: 'lead-calls-cron' }
    } });
    expect(r.status).toBe(204);
    expect(retellCalls.length).toBe(before + 1);
    const chained = retellCalls[before];
    expect(chained.to_number).toBe('+447700900456');
    expect(chained.metadata).toMatchObject({ source: 'lead-calls-chain', attempt: 1 });
    expect(chained.retell_llm_dynamic_variables.first_name).toBe('Ben');
    expect(chained.retell_llm_dynamic_variables.enquiry_when).toBe('a while back');
    expect(chained.retell_llm_dynamic_variables.enquiry_source).toBe('your earlier registration with GP Link');
    const priyaAfter = (readDb().siteEnquiries || []).find((x) => x.id === priya.id);
    expect(priyaAfter.metadata.consult.ai_call.completed_at).toBeTruthy();
    // And now Ben's call is the one in flight: nothing else goes out.
    const cron = await httpReq('GET', '/api/cron/lead-calls', { headers: CRON_AUTH });
    expect(cron.json.called).toBe(0);
    expect(cron.json.skipped.call_in_progress).toBe(1);
    expect(retellCalls.length).toBe(before + 1);
  });
});

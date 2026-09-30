// The human-voice consult follow-ups (owner rule 2026-09-30):
//   1. a WhatsApp reply from a lead stops the automated notes right there
//      (POST /api/webhooks/doubletick → stopped:'replied'), and the message is
//      never silently "ignored";
//   2. the owner is paged over WhatsApp 20 minutes after the 1-hour note when
//      the lead still has not booked (GET /api/cron/consult-nudge → template
//      gp_link_owner_lead_alert to CONSULT_OWNER_ALERT_PHONE), once per lead,
//      with an email fallback while the template awaits approval.
// Boots the real server in LOCAL-JSON mode over HTTP with stub Resend and
// DoubleTick servers wired via env BEFORE import (same harness as
// tests/consult-whatsapp-followups.test.js). Paging is switched on by env at
// boot, which is why these live in their own file.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-consult-human-${RUN_ID}.json`;
let server;
let addrPort;
let testUtils;
let resendServer;
let resendPort;
let dtServer;
let dtPort;
const resendCaptured = [];
const dtCaptured = [];

const CRON = '/api/cron/consult-nudge';
const AUTH = { Authorization: 'Bearer test-cron-secret' };
const WEBHOOK = '/api/webhooks/doubletick?secret=test-dt-webhook';
const OWNER_PHONE = '+61400000000';
const M = 60 * 1000;
const H = 60 * M;

function request(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: addrPort, path, method,
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
const get = (path, headers) => request('GET', path, null, headers);
const post = (path, body) => request('POST', path, body);

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}

let leadSeq = 0;
// A qualified Meta lead `ageMs` old whose recorded steps went at the schedule's
// own times (hello at 5 min, 1-hour note at 1h) with their WhatsApp markers.
function seedLead(ageMs, steps, extra) {
  leadSeq++;
  const created = Date.now() - ageMs;
  const at = { 0: created + 5 * M, 1: created + 1 * H, 2: created + 24 * H };
  const kinds = { 0: 'hello_5m', 1: 'check_in_1h', 2: 'day_after_24h' };
  const wa = {};
  const nudges = (steps || []).map((s) => {
    wa[kinds[s]] = { sent_at: new Date(at[s]).toISOString() };
    return { seq: 'not_booked', step: s, sent_at: new Date(at[s]).toISOString(), email: s === 0 ? 'none' : 'sent' };
  });
  const lead = {
    id: 'lead-' + leadSeq, created_at: new Date(created).toISOString(), kind: 'gp', name: 'Aisha Khan',
    email: 'aisha' + leadSeq + '@example.co.uk', status: 'new', phone: '+44 7700 900123',
    message: 'Is my MRCGP enough?',
    metadata: { source: 'meta_lead_ad', consult: Object.assign({
      // Real tokens are 32 url-safe chars; the booked endpoint refuses anything under 20.
      token: 'tok-' + leadSeq + '-' + crypto.randomBytes(12).toString('hex'),
      qualified: true, is_gp: true, country: 'uk', country_raw: 'united_kingdom',
      call_booked: false, nudges, wa
    }, extra || {}) }
  };
  return lead;
}

let dtRejectTemplate = '';
function startCaptureServer(store, replyBody) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body || 'null'); } catch { parsed = null; }
        if (store === dtCaptured && dtRejectTemplate && body.indexOf('"templateName":"' + dtRejectTemplate + '"') !== -1) {
          // What DoubleTick really answers for a template still awaiting approval:
          // HTTP 200 with a per-message FAILED status — not a 4xx.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ messages: [{ status: 'FAILED', errorMessage: 'Template with given name and language not found' }] }));
          return;
        }
        store.push({ path: req.url, body: parsed });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(replyBody));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

beforeAll(async () => {
  resendServer = await startCaptureServer(resendCaptured, { id: 'stub' });
  resendPort = resendServer.address().port;
  dtServer = await startCaptureServer(dtCaptured, { messages: [{ id: 'wa-stub', status: 'ENQUEUED' }] });
  dtPort = dtServer.address().port;

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'test-consult-human-' + RUN_ID;
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_API_URL = 'http://127.0.0.1:' + resendPort + '/emails';
  // Module-level consts in server.js — must exist before import.
  process.env.DOUBLETICK_API_KEY = 'test-dt-key';
  process.env.DOUBLETICK_BASE_URL = 'http://127.0.0.1:' + dtPort;
  process.env.DOUBLETICK_WEBHOOK_SECRET = 'test-dt-webhook';
  process.env.CONSULT_OWNER_ALERT_PHONE = OWNER_PHONE;
  delete process.env.ANTHROPIC_API_KEY; // the inbound classifier must not call out

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (resendServer) await new Promise((resolve) => resendServer.close(resolve));
  if (dtServer) await new Promise((resolve) => dtServer.close(resolve));
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

function waSends() {
  return dtCaptured.filter((c) => c.path === '/whatsapp/message/template').map((c) => c.body.messages[0]);
}
function templates() {
  return waSends().map((m) => m.content.templateName);
}
function reset() {
  resendCaptured.length = 0; dtCaptured.length = 0; dtRejectTemplate = '';
}

describe('a WhatsApp reply stops the notes', () => {
  it('stamps stopped:"replied" on the lead behind the number, and the message is not ignored', async () => {
    reset();
    // 2h old with the hello out: the 1-hour note is due, but the doctor writes first.
    const lead = seedLead(2 * H, [0]);
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const res = await post(WEBHOOK, { from: '447700900123', message: { type: 'TEXT', text: 'ok thanks' }, messageId: 'dt-m-1' });
    expect(res.status).toBe(200);
    expect(res.json.action).not.toBe('ignored');
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.stopped).toBe('replied');
    expect(row.metadata.consult.replied_via).toBe('whatsapp');
    expect(row.metadata.consult.replied_at).toEqual(expect.any(String));
    // The cron now sends this doctor nothing — no email, no WhatsApp, no exhausted stop.
    const cron = await get(CRON, AUTH);
    expect(cron.json.sent).toBe(0);
    expect(resendCaptured.length).toBe(0);
    expect(templates().filter((t) => t !== 'gp_link_owner_lead_alert')).toEqual([]);
    expect(readDb().siteEnquiries[0].metadata.consult.stopped).toBe('replied');
  });

  it('leaves a booked, already-stopped or unknown number alone', async () => {
    reset();
    const booked = seedLead(2 * H, [0], { call_booked: true, call_booked_at: new Date().toISOString() });
    booked.phone = '+44 7700 900111';
    const exhausted = seedLead(2 * H, [0, 1, 2], { stopped: 'exhausted' });
    exhausted.phone = '+44 7700 900222';
    testUtils.__seedSiteEnquiriesForTest([booked, exhausted]);
    await post(WEBHOOK, { from: '447700900111', message: { type: 'TEXT', text: 'see you then' }, messageId: 'dt-m-2' });
    await post(WEBHOOK, { from: '447700900222', message: { type: 'TEXT', text: 'hello?' }, messageId: 'dt-m-3' });
    const stranger = await post(WEBHOOK, { from: '447700900999', message: { type: 'TEXT', text: 'hello?' }, messageId: 'dt-m-4' });
    expect(stranger.status).toBe(200);
    const rows = readDb().siteEnquiries;
    expect(rows.find((r) => r.phone === '+44 7700 900111').metadata.consult.stopped).toBeUndefined();
    expect(rows.find((r) => r.phone === '+44 7700 900222').metadata.consult.stopped).toBe('exhausted');
  });

  it('a later booking through /start clears the "replied" stop so the post-call drip can run', async () => {
    reset();
    const lead = seedLead(2 * H, [0], { stopped: 'replied', replied_at: new Date().toISOString(), replied_via: 'whatsapp' });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const res = await post('/api/public/consult-lead/booked', { token: lead.metadata.consult.token });
    expect(res.status).toBe(200);
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.call_booked).toBe(true);
    expect(row.metadata.consult.stopped).toBeUndefined();
  });
});

describe('owner paging 20 minutes after the 1-hour note', () => {
  it('pages the owner over WhatsApp with name, phone, answers and status — once', async () => {
    reset();
    // 81 min old: hello at 5 min, 1-hour note at 60 min, no booking since.
    const lead = seedLead(81 * M, [0, 1]);
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const res = await get(CRON, AUTH);
    expect(res.status).toBe(200);
    expect(res.json.paged).toBe(1);
    expect(res.json.sent).toBe(0); // the day-after note is not due; nothing else went to the doctor
    expect(templates()).toEqual(['gp_link_owner_lead_alert']);
    const page = waSends()[0];
    expect(page.to).toBe(OWNER_PHONE);
    const ph = page.content.templateData.body.placeholders;
    expect(ph[0]).toBe('Aisha Khan');
    expect(ph[1]).toBe('+44 7700 900123');
    expect(ph[2]).toContain('Country: united_kingdom');
    expect(ph[2]).toContain('Registered GP: yes');
    expect(ph[2]).toContain('They asked: Is my MRCGP enough?');
    expect(ph[2]).toContain('Email: ' + lead.email);
    expect(ph[3]).toMatch(/^No booking 1h 2\dm after the form, and no reply yet$/);
    ph.forEach((v) => expect(v).not.toMatch(/[\r\n\t]/));
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.owner_alert).toEqual({ sent_at: expect.any(String), via: 'whatsapp' });
    expect(resendCaptured.length).toBe(0);
    // A rerun does not page twice.
    const res2 = await get(CRON, AUTH);
    expect(res2.json.paged).toBe(0);
    expect(templates()).toEqual(['gp_link_owner_lead_alert']);
  });

  it('does not page before the 20 minutes are up, after a booking, or about a two-day-old lead', async () => {
    reset();
    const early = seedLead(70 * M, [0, 1]);
    const booked = seedLead(3 * H, [0, 1], { call_booked: true, call_booked_at: new Date().toISOString() });
    booked.email = 'booked@example.co.uk';
    const old = seedLead(49 * H, [0, 1, 2]);
    old.email = 'old@example.co.uk';
    testUtils.__seedSiteEnquiriesForTest([early, booked, old]);
    const res = await get(CRON, AUTH);
    expect(res.json.paged).toBe(0);
    expect(templates()).not.toContain('gp_link_owner_lead_alert');
    readDb().siteEnquiries.forEach((r) => expect(r.metadata.consult.owner_alert).toBeUndefined());
  });

  it('a lead who replied on WhatsApp is still paged, and the page says so', async () => {
    reset();
    const lead = seedLead(90 * M, [0, 1], { stopped: 'replied', replied_at: new Date().toISOString(), replied_via: 'whatsapp' });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const res = await get(CRON, AUTH);
    expect(res.json.paged).toBe(1);
    expect(res.json.sent).toBe(0);
    const ph = waSends()[0].content.templateData.body.placeholders;
    expect(ph[3]).toMatch(/but they replied on WhatsApp/);
  });

  it('falls back to the owner mailbox when the WhatsApp template cannot be sent, and says why', async () => {
    reset();
    dtRejectTemplate = 'gp_link_owner_lead_alert';
    try {
      const lead = seedLead(85 * M, [0, 1]);
      testUtils.__seedSiteEnquiriesForTest([lead]);
      const res = await get(CRON, AUTH);
      expect(res.json.paged).toBe(1);
      expect(templates()).toEqual([]); // the refused send is not recorded as sent
      expect(resendCaptured.length).toBe(1);
      const em = resendCaptured[0].body;
      expect(JSON.stringify(em.to)).toContain('hello@mygplink.com.au');
      expect(em.subject).toBe('Lead needs a personal follow-up: Aisha Khan');
      expect(em.text).toContain('Template with given name and language not found');
      expect(em.text).toContain('Phone: +44 7700 900123');
      expect(readDb().siteEnquiries[0].metadata.consult.owner_alert).toEqual({ sent_at: expect.any(String), via: 'email' });
    } finally {
      dtRejectTemplate = '';
    }
  });

  it('a note to the doctor that DoubleTick reports FAILED (HTTP 200) is not stamped as sent', async () => {
    reset();
    dtRejectTemplate = 'gp_link_consult_hello_5m';
    try {
      const lead = seedLead(10 * M, []);
      testUtils.__seedSiteEnquiriesForTest([lead]);
      const res = await get(CRON, AUTH);
      expect(res.json.sent).toBe(1); // the step is recorded…
      const row = readDb().siteEnquiries[0];
      expect(row.metadata.consult.nudges[0]).toMatchObject({ step: 0, email: 'none' });
      expect(row.metadata.consult.wa.hello_5m).toBeUndefined(); // …but the WhatsApp leg stays owed
      expect(row.metadata.consult.wa_skipped).toBeUndefined();
    } finally {
      dtRejectTemplate = '';
    }
  });
});

describe('after the call ends: the account email goes out at once, only for an attended call', () => {
  // A booked lead whose slot was 45 minutes ago; the booking-time email (step 0) already went.
  function seedBooked(opts) {
    const o = opts || {};
    const created = Date.now() - 3 * 24 * H;
    const bookedAt = created + 10 * M;
    const callAt = Date.now() - 45 * M;
    const lead = seedLead(3 * 24 * H, [], {
      call_booked: true, call_booked_at: new Date(bookedAt).toISOString(), call_at: new Date(callAt).toISOString(),
      nudges: o.noStep0 ? [] : [{ seq: 'booked_no_signup', step: 0, sent_at: new Date(bookedAt).toISOString(), email: 'sent' }],
      wa: { call_booked: { sent_at: 'x' } }
    });
    return lead;
  }
  const callRecordFor = (lead) => ({
    id: 'call-' + lead.id, meeting_kind: 'consultation', host_kind: 'ceo',
    invitee_email: lead.email, scheduled_at: lead.metadata.consult.call_at, invitee_notes: ''
  });
  const subjects = () => resendCaptured.map((c) => c.body && c.body.subject);

  it('Zoom says the call ended → "great speaking with you" email immediately, once, and call_completed_at is stamped', async () => {
    reset();
    const lead = seedBooked();
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const done = new Date().toISOString();
    const res = await testUtils.afterConsultCallCompleted(callRecordFor(lead), done);
    expect(res.outcome).toBe('sent');
    expect(res.step).toBe(1);
    expect(resendCaptured.length).toBe(1);
    expect(subjects()[0]).toMatch(/Great speaking with you/);
    const row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.call_completed_at).toBe(done);
    expect(row.metadata.consult.nudges[1]).toMatchObject({ seq: 'booked_no_signup', step: 1, email: 'sent' });
    // The webhook firing twice, or the cron running straight after, sends nothing more.
    const again = await testUtils.afterConsultCallCompleted(callRecordFor(lead), done);
    expect(again.skipped).toBe('nothing_due');
    const cron = await get(CRON, AUTH);
    expect(cron.json.sent).toBe(0);
    expect(resendCaptured.length).toBe(1);
  });

  it('a slot that merely passed (no completion) sends nothing — a no-show never reads "great speaking with you"', async () => {
    reset();
    testUtils.__seedSiteEnquiriesForTest([seedBooked()]);
    const cron = await get(CRON, AUTH);
    expect(cron.json.sent).toBe(0);
    expect(resendCaptured.length).toBe(0);
    expect(readDb().siteEnquiries[0].metadata.consult.nudges.length).toBe(1);
  });

  it('the cron sends the same post-call email when the completion is on the lead (backstop), and week 1 waits', async () => {
    reset();
    const lead = seedBooked();
    lead.metadata.consult.call_completed_at = new Date(Date.now() - 2 * M).toISOString();
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const cron = await get(CRON, AUTH);
    expect(cron.json.sent).toBe(1);
    expect(subjects()[0]).toMatch(/Great speaking with you/);
    const again = await get(CRON, AUTH);
    expect(again.json.sent).toBe(0);
    expect(resendCaptured.length).toBe(1);
  });

  it('when the booking-time email never went, it is superseded rather than sent after the call', async () => {
    reset();
    const lead = seedBooked({ noStep0: true });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const res = await testUtils.afterConsultCallCompleted(callRecordFor(lead), new Date().toISOString());
    expect(res.outcome).toBe('sent');
    expect(res.step).toBe(1);
    expect(resendCaptured.length).toBe(1);
    expect(subjects()[0]).toMatch(/Great speaking with you/);
    const n = readDb().siteEnquiries[0].metadata.consult.nudges;
    expect(n[0]).toMatchObject({ step: 0, email: 'superseded' });
    expect(n[1]).toMatchObject({ step: 1, email: 'sent' });
  });

  it('someone who already has an account gets nothing', async () => {
    reset();
    const lead = seedBooked();
    testUtils.__seedSiteEnquiriesForTest([lead]);
    testUtils.__seedUserForTest(lead.email);
    const res = await testUtils.afterConsultCallCompleted(callRecordFor(lead), new Date().toISOString());
    expect(res.skipped).toBe('signed_up');
    expect(resendCaptured.length).toBe(0);
  });

  it('a lead who replied on WhatsApp and then booked through Calendly is back on the account emails; an unsubscribe still holds', async () => {
    reset();
    // Replied during the notes, never booked — the notes are stopped…
    const lead = seedLead(2 * H, [0, 1], { stopped: 'replied', replied_at: new Date().toISOString(), replied_via: 'whatsapp' });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    // …then Calendly reports a booking (the webhook's stamp path).
    const slot = new Date(Date.now() + 2 * 24 * H).toISOString();
    await testUtils.ensureLeadBookedCallAt(lead.email, slot, new Date().toISOString(), lead.phone);
    let row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.call_booked).toBe(true);
    expect(row.metadata.consult.stopped).toBeUndefined();
    // The booking-time account email goes on the next cron tick…
    resendCaptured.length = 0;
    const cron = await get(CRON, AUTH);
    expect(cron.json.sent).toBe(1);
    row = readDb().siteEnquiries[0];
    expect(row.metadata.consult.nudges[row.metadata.consult.nudges.length - 1]).toMatchObject({ seq: 'booked_no_signup', step: 0, email: 'sent' });
    // …and the post-call one the moment the call ends.
    resendCaptured.length = 0;
    const res = await testUtils.afterConsultCallCompleted({
      meeting_kind: 'consultation', host_kind: 'ceo', invitee_email: lead.email, scheduled_at: slot, invitee_notes: ''
    }, new Date().toISOString());
    expect(res.outcome).toBe('sent');
    expect(subjects()[0]).toMatch(/Great speaking with you/);
    // A real unsubscribe is not lifted by a booking.
    const unsub = seedLead(2 * H, [0, 1], { stopped: 'unsubscribed' });
    unsub.phone = '+44 7700 900555';
    testUtils.__seedSiteEnquiriesForTest([unsub]);
    await testUtils.ensureLeadBookedCallAt(unsub.email, slot, new Date().toISOString(), unsub.phone);
    expect(readDb().siteEnquiries[0].metadata.consult.stopped).toBe('unsubscribed');
  });

  it('registration-support calls and interviews never trigger it', async () => {
    reset();
    const lead = seedBooked();
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const rso = await testUtils.afterConsultCallCompleted(Object.assign(callRecordFor(lead), { host_kind: 'rso' }), new Date().toISOString());
    expect(rso.skipped).toBe('not_ceo_call');
    const interview = await testUtils.afterConsultCallCompleted(Object.assign(callRecordFor(lead), { meeting_kind: 'interview' }), new Date().toISOString());
    expect(interview.skipped).toBe('not_consultation');
    expect(resendCaptured.length).toBe(0);
  });
});

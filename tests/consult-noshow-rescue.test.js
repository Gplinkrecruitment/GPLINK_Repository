// The no-show rescue end to end (lib/consult-noshow.js + server.js): a doctor
// who booked the free consultation and did not join gets ONE email, ONE
// WhatsApp and ONE call from Hazel, whichever way the miss was concluded.
//
// Boots the real server in LOCAL-JSON mode over HTTP (same harness as
// tests/consult-post-call-whatsapp.test.js) with stub Resend, DoubleTick and
// Retell wired via env BEFORE import. The gate that stops the rescue reaching
// back before its launch is moved into the past for this file only
// (CONSULT_NOSHOW_RESCUE_SINCE), because every slot here is "N minutes ago".
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-consult-noshow-${RUN_ID}.json`;
let server, addrPort, testUtils;
let resendServer, dtServer, retellServer;
const resendCaptured = [];
const dtCaptured = [];
const retellCaptured = [];
// What the DoubleTick stub answers; flipped to a failure to play a template
// that is still waiting for WhatsApp approval.
let dtReply = { messages: [{ id: 'wa-stub', status: 'SENT' }] };

const NUDGE_CRON = '/api/cron/consult-nudge';
const CALLS_CRON = '/api/cron/lead-calls';
const AUTH = { Authorization: 'Bearer test-cron-secret' };
const M = 60 * 1000;
const H = 60 * M;
const SUBJECT = 'Sorry we missed each other';
const TEMPLATE = 'gp_link_consult_missed_call';

function get(p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: addrPort, path: p, method: 'GET', headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* leave null */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function stub(store, reply) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body || 'null'); } catch { parsed = null; }
        store.push({ path: req.url, method: req.method, body: parsed });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply(req, parsed)));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}
function dbRow(id) {
  return (readDb().siteEnquiries || []).find((r) => r.id === id);
}
function missedEmails(to) {
  return resendCaptured.filter((c) => c.body && c.body.subject === SUBJECT && (!to || JSON.stringify(c.body.to).indexOf(to) !== -1));
}
function missedWa() {
  return dtCaptured.filter((c) => c.path === '/whatsapp/message/template' && c.body && c.body.messages
    && c.body.messages[0].content.templateName === TEMPLATE);
}
function reset() { resendCaptured.length = 0; dtCaptured.length = 0; retellCaptured.length = 0; dtReply = { messages: [{ id: 'wa-stub', status: 'SENT' }] }; }

let seq = 0;
// A lead who booked a consultation for `slotAgoMs` ago. The booking-time
// touches are already on record so nothing else in the cron falls due.
function seedBooked(slotAgoMs, extraConsult, overrides) {
  seq++;
  const callAt = new Date(Date.now() - slotAgoMs).toISOString();
  const bookedAt = new Date(Date.now() - slotAgoMs - 24 * H).toISOString();
  const consult = Object.assign({
    token: 'NSTOK' + seq, qualified: true, is_gp: true, country: 'uk',
    call_booked: true, call_booked_at: bookedAt, call_at: callAt,
    wa: { call_booked: { sent_at: bookedAt } },
    nudges: [{ seq: 'booked_no_signup', step: 0, email: 'sent', sent_at: bookedAt }]
  }, extraConsult || {});
  return Object.assign({
    id: 'lead-ns-' + RUN_ID + '-' + seq, created_at: new Date(Date.now() - slotAgoMs - 48 * H).toISOString(), kind: 'gp',
    name: 'Dr Aisha Khan', email: 'aisha.ns' + seq + '@nhs-test.co.uk', status: 'contacted', phone: '+44 7700 9001' + String(10 + seq),
    metadata: { source: 'meta_lead_ad', consult }
  }, overrides || {});
}
const callRowFor = (lead, over) => Object.assign({
  id: 'call-' + lead.id, meeting_kind: 'consultation', host_kind: 'ceo', user_id: null,
  invitee_email: lead.email, scheduled_at: lead.metadata.consult.call_at, invitee_notes: '', zoom_meeting_id: 'Z1'
}, over || {});

beforeAll(async () => {
  resendServer = await stub(resendCaptured, () => ({ id: 'stub' }));
  dtServer = await stub(dtCaptured, () => dtReply);
  retellServer = await stub(retellCaptured, (req) => (/create-phone-call/.test(req.url)
    ? { call_id: 'call_' + crypto.randomBytes(3).toString('hex'), call_status: 'registered', agent_id: 'agent_1' }
    : []));

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_SECRET = 'test-consult-noshow-' + RUN_ID;
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.REQUIRE_SUPABASE_DB = 'false';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PUBLISHABLE_KEY = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.ENFORCE_SAME_ORIGIN = 'false';
  process.env.DB_FILE_PATH = DB_FILE;
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_API_URL = 'http://127.0.0.1:' + resendServer.address().port + '/emails';
  process.env.DOUBLETICK_API_KEY = 'test-dt-key';
  process.env.DOUBLETICK_BASE_URL = 'http://127.0.0.1:' + dtServer.address().port;
  process.env.LEAD_CALLS_ENABLED = 'true';
  process.env.RETELL_API_KEY = 'key_test';
  process.env.RETELL_AGENT_ID = 'agent_1';
  process.env.RETELL_FROM_NUMBER_UK = '+442030000000';
  process.env.RETELL_API_URL = 'http://127.0.0.1:' + retellServer.address().port;
  process.env.LEAD_CALLS_IGNORE_HOURS = 'true';
  process.env.LEAD_CALLS_DIRECTOR_NAME = 'Khaleed';
  process.env.CONSULT_NOSHOW_RESCUE_SINCE = '2020-01-01T00:00:00Z';

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { addrPort = server.address().port; resolve(); }));
});

afterAll(async () => {
  for (const s of [server, resendServer, dtServer, retellServer]) {
    if (s) await new Promise((resolve) => s.close(resolve));
  }
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

describe('the sweep path: nobody joined a booked row', () => {
  it('records the missed slot on the lead, then the cron sends one email and one WhatsApp', async () => {
    reset();
    const lead = seedBooked(100 * M);
    testUtils.__seedSiteEnquiriesForTest([lead]);
    const marker = await testUtils.recordConsultNoShowForCall(callRowFor(lead));
    expect(marker).toMatchObject({ call_at: lead.metadata.consult.call_at, via: 'sweep', ring: 'pending' });
    expect(dbRow(lead.id).metadata.consult.no_show).toMatchObject({ call_at: lead.metadata.consult.call_at, ring: 'pending' });
    // Concluding the same slot again changes nothing.
    expect(await testUtils.recordConsultNoShowForCall(callRowFor(lead))).toBe(null);

    const r = await get(NUDGE_CRON, AUTH);
    expect(r.status).toBe(200);
    const emails = missedEmails(lead.email);
    expect(emails.length).toBe(1);
    const html = String(emails[0].body.html || '');
    const text = String(emails[0].body.text || '');
    expect(text).toContain('Hi Dr Khan,');
    expect(text).toContain('/start?lead=' + lead.metadata.consult.token + '#book');
    expect(html).toContain('/start?lead=' + lead.metadata.consult.token + '#book');
    expect(text).toContain('reply to this email with a time that suits you');
    expect(text).not.toMatch(/[—–]/);
    const wa = missedWa();
    expect(wa.length).toBe(1);
    const sent = wa[0].body.messages[0];
    expect(sent.to.replace(/\D/g, '')).toBe(lead.phone.replace(/\D/g, ''));
    expect(sent.content.templateData.body.placeholders[1]).toContain('/start?lead=' + lead.metadata.consult.token + '#book');
    const m = dbRow(lead.id).metadata.consult.no_show;
    expect(m.email_at).toEqual(expect.any(String));
    expect(m.wa_at).toEqual(expect.any(String));
    expect(m.ring).toBe('pending');

    // The next passes send nothing more.
    await get(NUDGE_CRON, AUTH);
    await get(NUDGE_CRON, AUTH);
    expect(missedEmails(lead.email).length).toBe(1);
    expect(missedWa().length).toBe(1);
  });

  it('does not touch an app user (the re-invite reaches them), a test booking, an RSO call, or a doctor already seen in the room', async () => {
    reset();
    const lead = seedBooked(100 * M);
    const joined = seedBooked(100 * M, { call_attended: true, call_attendance_source: 'zoom_participants' });
    const team = seedBooked(100 * M, {}, { email: 'registration@mygplink.com.au' });
    testUtils.__seedSiteEnquiriesForTest([lead, joined, team]);
    expect(await testUtils.recordConsultNoShowForCall(callRowFor(lead, { user_id: 'user-123' }))).toBe(null);
    expect(await testUtils.recordConsultNoShowForCall(callRowFor(lead, { host_kind: 'rso' }))).toBe(null);
    expect(await testUtils.recordConsultNoShowForCall(callRowFor(lead, { meeting_kind: 'interview' }))).toBe(null);
    expect(await testUtils.recordConsultNoShowForCall(callRowFor(lead, { scheduled_at: null }))).toBe(null);
    expect(await testUtils.recordConsultNoShowForCall(callRowFor(joined))).toBe(null);
    expect(await testUtils.recordConsultNoShowForCall(callRowFor(team))).toBe(null);
    expect(await testUtils.recordConsultNoShowForCall(callRowFor({ email: 'nobody@nhs-test.co.uk', metadata: { consult: { call_at: lead.metadata.consult.call_at } }, id: 'x' }))).toBe(null);
    await get(NUDGE_CRON, AUTH);
    expect(missedEmails().length).toBe(0);
    expect(missedWa().length).toBe(0);
    expect(dbRow(lead.id).metadata.consult.no_show).toBeUndefined();
  });

  it('handleScheduledCallFailure hands every no-show to the rescue (and only a no-show)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = src.indexOf('async function handleScheduledCallFailure(call, kind, opts) {');
    const body = src.slice(start, src.indexOf('async function handleCalendlyInviteeCanceled', start));
    expect(body).toContain("if (kind === 'no_show') await recordConsultNoShowForCall(call);");
    // It still re-invites app users exactly as before.
    expect(body).toContain('sendDoubleTickZoomCallInvite(gpPhone');
  });
});

describe('the participant-list path: the meeting ended and Zoom saw no doctor', () => {
  const verdict = (slotAgoMs, checkedAgoMs) => ({
    call_completed_at: new Date(Date.now() - slotAgoMs + 10 * M).toISOString(),
    call_attended: false, call_attendance_source: 'zoom_participants',
    call_attendance_checked_at: new Date(Date.now() - checkedAgoMs).toISOString()
  });

  it('the cron records the miss and sends, once the slot is an hour old', async () => {
    reset();
    const early = seedBooked(30 * M, verdict(30 * M, 15 * M));
    const due = seedBooked(70 * M, verdict(70 * M, 55 * M));
    testUtils.__seedSiteEnquiriesForTest([early, due]);
    await get(NUDGE_CRON, AUTH);
    expect(dbRow(early.id).metadata.consult.no_show).toMatchObject({ via: 'zoom_participants', ring: 'pending' });
    expect(missedEmails(early.email).length).toBe(0);
    expect(missedEmails(due.email).length).toBe(1);
    expect(missedWa().length).toBe(1);
    expect(dbRow(due.id).metadata.consult.no_show).toMatchObject({ via: 'zoom_participants', email_at: expect.any(String), wa_at: expect.any(String) });
  });

  it('a verdict left over from an earlier slot, a guessed verdict, and a slot that has not happened are not misses', async () => {
    reset();
    const stale = seedBooked(70 * M, verdict(70 * M, 5 * 24 * H));
    const guessed = seedBooked(70 * M, Object.assign(verdict(70 * M, 55 * M), { call_attendance_source: 'unverifiable' }));
    const manual = seedBooked(70 * M, { call_attended: false, call_attendance_source: 'zoom_participants' }); // no checked_at
    testUtils.__seedSiteEnquiriesForTest([stale, guessed, manual]);
    await get(NUDGE_CRON, AUTH);
    expect(missedEmails().length).toBe(0);
    expect(missedWa().length).toBe(0);
    [stale, guessed, manual].forEach((l) => expect(dbRow(l.id).metadata.consult.no_show).toBeUndefined());
  });
});

describe('who is left alone, and what a failed send does', () => {
  it('an unsubscribed lead gets nothing; an exhausted email chase does not silence it', async () => {
    reset();
    const unsub = seedBooked(100 * M, { stopped: 'unsubscribed', unsubscribe_reason: 'unsubscribed' });
    const exhausted = seedBooked(100 * M, { stopped: 'exhausted' });
    testUtils.__seedSiteEnquiriesForTest([unsub, exhausted]);
    await testUtils.recordConsultNoShowForCall(callRowFor(unsub));
    await testUtils.recordConsultNoShowForCall(callRowFor(exhausted));
    await get(NUDGE_CRON, AUTH);
    expect(missedEmails(unsub.email).length).toBe(0);
    expect(missedEmails(exhausted.email).length).toBe(1);
    expect(missedWa().length).toBe(1);
  });

  it('a WhatsApp template still awaiting approval fails soft: the email goes, the WhatsApp is retried, then lands', async () => {
    reset();
    dtReply = { messages: [{ status: 'FAILED', errorMessage: 'Template with given name and language not found' }] };
    const lead = seedBooked(100 * M);
    testUtils.__seedSiteEnquiriesForTest([lead]);
    await testUtils.recordConsultNoShowForCall(callRowFor(lead));
    await get(NUDGE_CRON, AUTH);
    let m = dbRow(lead.id).metadata.consult.no_show;
    expect(m.email_at).toEqual(expect.any(String));
    expect(m.wa_at).toBeUndefined();
    expect(m.wa_tries).toBe(1);
    dtReply = { messages: [{ id: 'wa-ok', status: 'SENT' }] };
    await get(NUDGE_CRON, AUTH);
    m = dbRow(lead.id).metadata.consult.no_show;
    expect(m.wa_at).toEqual(expect.any(String));
    expect(missedEmails(lead.email).length).toBe(1);
  });

  it('re-booking ends the rescue and clears the old "did not join" verdict', async () => {
    reset();
    const lead = seedBooked(30 * M, {
      call_completed_at: new Date(Date.now() - 20 * M).toISOString(), call_attended: false,
      call_attendance_source: 'zoom_participants', call_attendance_checked_at: new Date(Date.now() - 15 * M).toISOString()
    });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    await get(NUDGE_CRON, AUTH); // marker recorded, nothing sent yet (30 minutes after the slot)
    expect(dbRow(lead.id).metadata.consult.no_show).toMatchObject({ ring: 'pending' });
    const newSlot = new Date(Date.now() + 48 * H).toISOString();
    await testUtils.ensureLeadBookedCallAt(lead.email, newSlot, new Date().toISOString(), '', null);
    const c = dbRow(lead.id).metadata.consult;
    expect(c.call_at).toBe(newSlot);
    expect(c.call_attended).toBeUndefined();
    expect(c.call_completed_at).toBeUndefined();
    expect(c.call_booked).toBe(true);
    await get(NUDGE_CRON, AUTH);
    expect(missedEmails(lead.email).length).toBe(0);
    expect(missedWa().length).toBe(0);
    const calls = await get(CALLS_CRON, AUTH);
    expect(calls.status).toBe(200);
    expect(retellCaptured.filter((c) => /create-phone-call/.test(c.path)).length).toBe(0);
  });

  it('an attended call\'s record is NOT cleared when the doctor books a second conversation', async () => {
    const lead = seedBooked(3 * 24 * H, {
      call_completed_at: new Date(Date.now() - 3 * 24 * H + 30 * M).toISOString(), call_attended: true, call_attendance_source: 'zoom_participants'
    });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    await testUtils.ensureLeadBookedCallAt(lead.email, new Date(Date.now() + 48 * H).toISOString(), new Date().toISOString(), '', null);
    expect(dbRow(lead.id).metadata.consult.call_attended).toBe(true);
  });
});

describe('Hazel rings once', () => {
  const placed = () => retellCaptured.filter((c) => /create-phone-call/.test(c.path));

  it('not inside two hours of the slot; then one call that knows why it is ringing; then never again', async () => {
    reset();
    const lead = seedBooked(90 * M);
    testUtils.__seedSiteEnquiriesForTest([lead]);
    await testUtils.recordConsultNoShowForCall(callRowFor(lead));
    let r = await get(CALLS_CRON, AUTH);
    expect(r.status).toBe(200);
    expect(placed().length).toBe(0);
    expect(r.json.skipped.missed_call_later).toBe(1);

    // The same lead, the slot now two and a half hours old.
    const older = JSON.parse(JSON.stringify(dbRow(lead.id)));
    const slot = new Date(Date.now() - 150 * M).toISOString();
    older.metadata.consult.call_at = slot;
    older.metadata.consult.no_show.call_at = slot;
    testUtils.__seedSiteEnquiriesForTest([older]);
    r = await get(CALLS_CRON, AUTH);
    expect(r.json.called).toBe(1);
    expect(placed().length).toBe(1);
    const body = placed()[0].body;
    expect(body.to_number).toBe('+' + lead.phone.replace(/\D/g, ''));
    expect(body.retell_llm_dynamic_variables.missed_call_note).toContain('They had a consultation booked with Khaleed for ');
    expect(body.retell_llm_dynamic_variables.missed_call_note).toContain('did not join it');
    const after = dbRow(lead.id).metadata.consult;
    expect(after.no_show.ring).toBe('placed');
    expect(after.no_show.ring_at).toEqual(expect.any(String));
    expect(after.call_booked).toBe(true);

    // The call is still "in flight" for 15 minutes; once it is not, the lead
    // simply reads already booked and is never rung for this slot again.
    const done = JSON.parse(JSON.stringify(dbRow(lead.id)));
    done.metadata.consult.ai_call = Object.assign({}, done.metadata.consult.ai_call, { status: 'ended', outcome: 'voicemail', completed_at: new Date(Date.now() - 4 * H).toISOString(), started_at: new Date(Date.now() - 4 * H).toISOString() });
    testUtils.__seedSiteEnquiriesForTest([done]);
    r = await get(CALLS_CRON, AUTH);
    expect(r.json.called).toBe(0);
    expect(r.json.skipped.already_booked).toBe(1);
    expect(placed().length).toBe(1);
  });

  it('a doctor who asked not to be called is not rung', async () => {
    reset();
    const lead = seedBooked(150 * M, { stopped: 'do_not_call' });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    await testUtils.recordConsultNoShowForCall(callRowFor(lead));
    const r = await get(CALLS_CRON, AUTH);
    expect(r.json.called).toBe(0);
    expect(placed().length).toBe(0);
  });

  it('the prompt and its defaults carry the fact variable, and no scripted line for it', () => {
    const prompt = fs.readFileSync(path.join(__dirname, '..', 'config', 'retell', 'hazel-prompt.md'), 'utf8');
    const agent = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'retell', 'agent.json'), 'utf8'));
    expect(prompt.match(/\{\{missed_call_note\}\}/g).length).toBe(1);
    expect(JSON.stringify(agent)).toContain('"missed_call_note":""');
  });
});

describe('re-booking on Hazel\'s call and from the link', () => {
  it('the booking tool no longer refuses a doctor whose only booking is the slot they missed', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    expect(src).toContain("if (ctx.consult.call_booked && !consultNoShow.noShowRescueActive(ctx.consult)) return 'This doctor already has a call booked; no need to book again.';");
  });

  it('a booker who was never screened gets the plain booking page, not a personal link the page would refuse', async () => {
    reset();
    const lead = seedBooked(100 * M, { qualified: false, not_screened: true, token: 'NSUNSCREENED' });
    testUtils.__seedSiteEnquiriesForTest([lead]);
    await testUtils.recordConsultNoShowForCall(callRowFor(lead));
    await get(NUDGE_CRON, AUTH);
    const emails = missedEmails(lead.email);
    expect(emails.length).toBe(1);
    expect(String(emails[0].body.text)).toContain('/start#book');
    expect(String(emails[0].body.text)).not.toContain('NSUNSCREENED');
  });
});

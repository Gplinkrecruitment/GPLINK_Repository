// WP-01 of the Australian GP build, end to end over HTTP, in BOTH states of the
// AU_PATHWAY_ENABLED switch (read at call time, so one booted server serves
// both). Acceptance, from docs/au-gp/review-report.md:
//
//   switch ON   an `au` lead produces no Hazel call (regular schedule, due
//               call-back, the missed-consultation ring, the owner's "ring
//               now"), no nudge email and no WhatsApp, and still raises the
//               owner alert. A waitlisted user is absent from the onboarding
//               nudge list. The PEP gate cannot catch a non GB/IE/NZ doctor.
//               UK, IE and NZ leads are unchanged.
//   switch OFF  AU, UK, IE and NZ all behave exactly as before the build,
//               WITH ONE DELIBERATE EXCEPTION (WP-04, owner decision 7): Hazel
//               never rings an Australian-segment lead in either state. The
//               "switch OFF: … rung …, as before" cases in this file were
//               changed on purpose to pin the refusal; each carries a
//               "CHANGED in WP-04" comment saying what it used to assert.
//               docs/au-gp/CONVENTIONS.md section 2.
//
// CHANGED in WP-16 (Australian lead and consult copy). WP-01's "no nudge
// email and no WhatsApp" was an interim hold until Australian copy existed.
// It now exists, and the hold has no call site left. What this file pins for
// the switch-ON cases, deliberately:
//   - Every Australian lead in this file is from BEFORE go-live (the go-live
//     instant is set in the future in beforeAll). WP-16's go-live rule leaves
//     such a lead exactly as WP-01's hold did: no chase email, no WhatsApp, no
//     rescue, nothing recorded, the owner still paged. So the cron cases below
//     still pass unchanged, and now pin that rule.
//   - Two groups were changed on purpose and carry a "CHANGED in WP-16" note:
//     the WhatsApp helper (the skip now names its reason,
//     'au_template_not_approved') and the booking-link emails (an Australian
//     lead now gets the AUSTRALIAN email, where it used to get none).
// What a lead from AFTER go-live receives is tests/au-wp16-lead-copy-server.test.js.
//
// Boots the real server in LOCAL-JSON mode with stub Resend, DoubleTick and
// Retell servers wired through env BEFORE import (same harness as
// tests/consult-noshow-rescue.test.js). Nothing real is sent or rung. Every
// identity is fake.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';

const RUN_ID = crypto.randomBytes(4).toString('hex');
const DB_FILE = `/tmp/gplink-au-wp01-${RUN_ID}.json`;
const SUPER_HOST = 'au-wp01-test.local';
const OWNER_PHONE = '+61499000999';
const FROM_UK = '+442030000000';
const FROM_AU = '+61280000000';

let server, port, testUtils;
let resendServer, dtServer, retellServer;
const emails = [];
const dt = [];
const retell = [];

const NUDGE_CRON = '/api/cron/consult-nudge';
const CALLS_CRON = '/api/cron/lead-calls';
const ONB_CRON = '/api/cron/onboarding-nudge';
const AUTH = { Authorization: 'Bearer test-cron-secret' };
const M = 60 * 1000;
const H = 60 * M;
const D = 24 * H;

const PEOPLE = {
  au: { name: 'Dr Test Auvr', email: 'au.vr.test@gplink-test.local', phone: '+61400000111' },
  uk: { name: 'Dr Test Ukgp', email: 'uk.gp.test@gplink-test.local', phone: '+447700900111' },
  ie: { name: 'Dr Test Iegp', email: 'ie.gp.test@gplink-test.local', phone: '+353870000111' },
  nz: { name: 'Dr Test Nzgp', email: 'nz.gp.test@gplink-test.local', phone: '+64210000111' }
};
const ALL = ['au', 'uk', 'ie', 'nz'];
const OVERSEAS = ['uk', 'ie', 'nz'];

// Onboarding fixtures, written to the DB file before boot (the shape
// tests/onboarding-incomplete-endpoint.test.js seeds). The waitlisted doctor
// carries exactly what POST /api/eligibility-waitlist stores.
const WAITLISTED = 'waitlisted.test@gplink-test.local';
const STALLED = 'stalled.test@gplink-test.local';
const PEP_AU = 'pep.au.test@gplink-test.local';
const PEP_GB = 'pep.gb.test@gplink-test.local';
const PEP_REG = 'pep.register.test@gplink-test.local';

function b64url(s) {
  return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function superCookie() {
  const payload = b64url(JSON.stringify({
    userProfile: { email: 'super@gplink-test.local', adminRole: 'super_admin' },
    expiresAt: Date.now() + 3600000
  }));
  const sig = crypto.createHmac('sha512', process.env.AUTH_SECRET).update(payload).digest('hex');
  return 'gp_admin_session=' + encodeURIComponent(payload + '.' + sig);
}
function httpReq(method, p, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, o.headers || {});
    if (o.host) headers.Host = o.host;
    if (o.cookie) headers.Cookie = o.cookie;
    const payload = o.body === undefined ? null : Buffer.from(JSON.stringify(o.body), 'utf8');
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let json = null; try { json = JSON.parse(raw); } catch { /* leave null */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    r.on('error', reject); r.end(payload);
  });
}
const cron = (p) => httpReq('GET', p, { headers: AUTH });
const ceoPost = (p, body) => httpReq('POST', p, { host: SUPER_HOST, cookie: superCookie(), body: body || {} });

function stub(store, reply, status) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body || 'null'); } catch { parsed = null; }
        store.push({ path: req.url, method: req.method, body: parsed });
        res.writeHead(status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply(req, parsed)));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

const digits = (v) => String(v || '').replace(/\D/g, '');
function reset() { emails.length = 0; dt.length = 0; retell.length = 0; }
function setSwitch(on) { process.env.AU_PATHWAY_ENABLED = on ? 'true' : 'false'; }
// Emails sent to one address.
function emailsTo(addr) {
  return emails.filter((c) => c.body && JSON.stringify(c.body.to || '').toLowerCase().indexOf(String(addr).toLowerCase()) !== -1).map((c) => c.body);
}
// WhatsApp templates sent to one number.
function waTo(phone) {
  return dt.filter((c) => c.path === '/whatsapp/message/template' && c.body && c.body.messages
    && digits(c.body.messages[0].to) === digits(phone)).map((c) => c.body.messages[0].content);
}
function ownerPages() {
  return waTo(OWNER_PHONE).filter((c) => c.templateName === 'gp_link_owner_lead_alert');
}
// Calls Retell was asked to place to one number.
function callsTo(phone) {
  return retell.filter((c) => /create-phone-call/.test(c.path) && c.body && digits(c.body.to_number) === digits(phone)).map((c) => c.body);
}
function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}
function dbRow(id) {
  return (readDb().siteEnquiries || []).find((r) => r.id === id);
}

let seq = 0;
// A qualified, unbooked lead as buildConsultLeadRow stores one.
function lead(country, consultOver, rowOver) {
  seq++;
  const p = PEOPLE[country];
  return Object.assign({
    id: 'lead-' + country + '-' + RUN_ID + '-' + seq,
    created_at: new Date(Date.now() - 30 * M).toISOString(),
    kind: 'gp', name: p.name, email: p.email, phone: p.phone,
    practice_name: null, state: country, message: null, status: 'new',
    metadata: {
      source: 'meta_lead_ad',
      consult: Object.assign({
        token: 'TOK' + country.toUpperCase() + seq, qualified: true, is_gp: null, country: country,
        call_booked: false, nudges: [], country_raw: country === 'au' ? 'australia' : country, country_source: 'question'
      }, consultOver || {})
    }
  }, rowOver || {});
}
function seed(rows) { testUtils.__seedSiteEnquiriesForTest(rows); }

beforeAll(async () => {
  resendServer = await stub(emails, () => ({ id: 'stub' }));
  dtServer = await stub(dt, () => ({ messages: [{ id: 'wa-stub', status: 'SENT' }] }));
  retellServer = await stub(retell, (req) => (/create-phone-call/.test(req.url)
    ? { call_id: 'call_' + crypto.randomBytes(3).toString('hex'), call_status: 'registered', agent_id: 'agent_1' }
    : []));

  const twoHoursAgo = new Date(Date.now() - 2 * H).toISOString();
  const users = {};
  const userState = {};
  [WAITLISTED, STALLED, PEP_AU, PEP_GB, PEP_REG].forEach((em) => {
    users[em] = { email: em, firstName: 'Test', lastName: em.split('.')[0], createdAt: twoHoursAgo, updatedAt: twoHoursAgo };
    userState[em] = { state: { gp_onboarding: { currentStep: 2 } }, updatedAt: twoHoursAgo };
  });
  userState[WAITLISTED].state.gp_eligibility_waitlist = JSON.stringify({ country: 'Australia', email: WAITLISTED, at: twoHoursAgo });
  fs.writeFileSync(DB_FILE, JSON.stringify({ users, userState }));

  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_DISABLED = 'false';
  process.env.AUTH_SECRET = 'test-au-wp01-' + RUN_ID;
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
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_API_URL = 'http://127.0.0.1:' + resendServer.address().port + '/emails';
  process.env.DOUBLETICK_API_KEY = 'test-dt-key';
  process.env.DOUBLETICK_BASE_URL = 'http://127.0.0.1:' + dtServer.address().port;
  process.env.CONSULT_OWNER_ALERT_PHONE = OWNER_PHONE;
  process.env.LEAD_CALLS_ENABLED = 'true';
  process.env.RETELL_API_KEY = 'key_test';
  process.env.RETELL_AGENT_ID = 'agent_1';
  process.env.RETELL_FROM_NUMBER_UK = FROM_UK;
  // The Australian number IS set up: with the switch on, the only thing
  // standing between Hazel and an Australian lead is this package.
  process.env.RETELL_FROM_NUMBER_AU = FROM_AU;
  process.env.RETELL_API_URL = 'http://127.0.0.1:' + retellServer.address().port;
  process.env.LEAD_CALLS_IGNORE_HOURS = 'true';
  process.env.LEAD_CALLS_ONE_AT_A_TIME = 'false';
  process.env.LEAD_CALLS_PER_RUN = '20';
  process.env.CONSULT_NOSHOW_RESCUE_SINCE = '2020-01-01T00:00:00Z';
  // WP-16: Australian lead messages "go live" far in the future, so every
  // Australian lead in this file is a lead from before go-live.
  process.env.AU_LEAD_COPY_LIVE_FROM = '2099-01-01T00:00:00Z';
  delete process.env.LEAD_CALLS_TEST_NUMBERS;
  delete process.env.SITE_ENQUIRY_NOTIFY_EMAIL;

  const mod = await import('../server.js');
  testUtils = mod.__testUtils;
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

afterAll(async () => {
  delete process.env.AU_PATHWAY_ENABLED;
  delete process.env.AU_LEAD_COPY_LIVE_FROM;
  for (const s of [server, resendServer, dtServer, retellServer]) {
    if (s) await new Promise((resolve) => s.close(resolve));
  }
  try { fs.unlinkSync(DB_FILE); } catch { /* ignore */ }
});

afterEach(() => { delete process.env.AU_PATHWAY_ENABLED; });

// ── The chase: the 1-hour note (email + WhatsApp) and the owner page ─────────
// Each lead arrived 85 minutes ago and already has the 5-minute WhatsApp on
// record, so the 1-hour step (email AND WhatsApp) is due, and so is the owner
// page (20 minutes after the hour).
function oneHourDue(country) {
  const sentAt = new Date(Date.now() - 80 * M).toISOString();
  return lead(country, {
    nudges: [{ seq: 'not_booked', step: 0, sent_at: sentAt, email: 'none' }],
    wa: { hello_5m: { sent_at: sentAt } }
  }, { created_at: new Date(Date.now() - 85 * M).toISOString() });
}

describe('consult-nudge cron: an unbooked lead whose 1-hour note is due', () => {
  it('switch ON: the Australian lead gets no email and no WhatsApp, the owner is still paged, overseas leads are chased as ever', async () => {
    setSwitch(true);
    reset();
    const rows = {}; ALL.forEach((c) => { rows[c] = oneHourDue(c); });
    seed(ALL.map((c) => rows[c]));

    const r = await cron(NUDGE_CRON);
    expect(r.status).toBe(200);

    // Nothing to the Australian doctor, on either channel.
    expect(emailsTo(PEOPLE.au.email)).toEqual([]);
    expect(waTo(PEOPLE.au.phone)).toEqual([]);
    // The owner hears about all four, the Australian one included.
    expect(r.json.paged).toBe(4);
    const paged = ownerPages().map((c) => c.templateData.body.placeholders[0]).sort();
    expect(paged).toEqual(ALL.map((c) => PEOPLE[c].name).sort());
    const auPage = ownerPages().find((c) => c.templateData.body.placeholders[0] === PEOPLE.au.name);
    expect(auPage.templateData.body.placeholders[1]).toBe(PEOPLE.au.phone);
    expect(auPage.templateData.body.placeholders[2]).toContain('Country: australia');
    // The hold leaves the lead as it was: no step recorded, no stop, nothing
    // marked skipped, so Australian copy can pick the sequence up later.
    const au = dbRow(rows.au.id).metadata.consult;
    expect(au.nudges).toEqual(rows.au.metadata.consult.nudges);
    expect(au.stopped).toBeUndefined();
    expect(au.wa_skipped).toBeUndefined();
    expect(Object.keys(au.wa)).toEqual(['hello_5m']);
    expect(au.owner_alert && au.owner_alert.via).toBe('whatsapp');

    // UK, Ireland, New Zealand: the 1-hour email and the 1-hour WhatsApp.
    OVERSEAS.forEach((c) => {
      const em = emailsTo(PEOPLE[c].email);
      expect(em.length, c + ' email').toBe(1);
      expect(String(em[0].from)).toContain('Khaleed at GP Link');
      expect(waTo(PEOPLE[c].phone).map((x) => x.templateName), c + ' WhatsApp').toEqual(['gp_link_consult_check_in_1h']);
      const stored = dbRow(rows[c].id).metadata.consult;
      expect(stored.nudges.map((n) => n.seq + ':' + n.step)).toEqual(['not_booked:0', 'not_booked:1']);
      expect(stored.wa.check_in_1h).toBeTruthy();
    });

    // A second and third pass change nothing for the Australian lead.
    await cron(NUDGE_CRON);
    await cron(NUDGE_CRON);
    expect(emailsTo(PEOPLE.au.email)).toEqual([]);
    expect(waTo(PEOPLE.au.phone)).toEqual([]);
    expect(ownerPages().length).toBe(4);
  });

  it('switch OFF: the Australian lead is chased exactly like the UK lead (the pre-build behaviour)', async () => {
    setSwitch(false);
    reset();
    const rows = {}; ALL.forEach((c) => { rows[c] = oneHourDue(c); });
    seed(ALL.map((c) => rows[c]));

    const r = await cron(NUDGE_CRON);
    expect(r.status).toBe(200);
    expect(r.json.paged).toBe(4);
    expect(r.json.sent).toBe(4);
    ALL.forEach((c) => {
      const em = emailsTo(PEOPLE[c].email);
      expect(em.length, c + ' email').toBe(1);
      expect(waTo(PEOPLE[c].phone).map((x) => x.templateName), c + ' WhatsApp').toEqual(['gp_link_consult_check_in_1h']);
      const stored = dbRow(rows[c].id).metadata.consult;
      expect(stored.nudges.map((n) => n.seq + ':' + n.step)).toEqual(['not_booked:0', 'not_booked:1']);
    });
    // Same email, word for word apart from the name and the personal link.
    const strip = (body, c) => String(body.text).split(PEOPLE[c].name.split(' ').pop()).join('X').replace(/lead=[^#\s&]+/g, 'lead=T').replace(/unsubscribe\?token=\S+/g, 'unsubscribe?token=U').split(encodeURIComponent(PEOPLE[c].email)).join('E').split(PEOPLE[c].email).join('E');
    expect(emailsTo(PEOPLE.au.email)[0].subject).toBe(emailsTo(PEOPLE.uk.email)[0].subject);
    expect(strip(emailsTo(PEOPLE.au.email)[0], 'au')).toBe(strip(emailsTo(PEOPLE.uk.email)[0], 'uk'));
  });
});

// ── The sign-up drip and the post-call WhatsApp, for a lead who booked ───────
function attended(country) {
  const completed = new Date(Date.now() - 3 * H).toISOString();
  return lead(country, {
    call_booked: true, call_booked_at: new Date(Date.now() - 2 * D).toISOString(),
    call_at: new Date(Date.now() - 3.5 * H).toISOString(),
    call_completed_at: completed, call_attended: true, call_attendance_source: 'zoom_participants',
    wa: { call_booked: { sent_at: new Date(Date.now() - 2 * D).toISOString() } },
    nudges: [{ seq: 'booked_no_signup', step: 0, sent_at: new Date(Date.now() - 2 * D).toISOString(), email: 'sent' }]
  }, { created_at: new Date(Date.now() - 3 * D).toISOString(), status: 'contacted' });
}

describe('consult-nudge cron: a lead who booked and attended (sign-up drip, post-call WhatsApp)', () => {
  it('switch ON: nothing goes to the Australian lead; the UK lead gets the post-call email and WhatsApp', async () => {
    setSwitch(true);
    reset();
    const au = attended('au');
    const uk = attended('uk');
    seed([au, uk]);
    await cron(NUDGE_CRON);
    expect(emailsTo(PEOPLE.au.email)).toEqual([]);
    expect(waTo(PEOPLE.au.phone)).toEqual([]);
    const auStored = dbRow(au.id).metadata.consult;
    expect(auStored.nudges.length).toBe(1);
    expect(auStored.stopped).toBeUndefined();
    expect(auStored.wa_skipped).toBeUndefined();
    expect(emailsTo(PEOPLE.uk.email).length).toBe(1);
    expect(waTo(PEOPLE.uk.phone).map((x) => x.templateName)).toEqual(['gp_link_consult_post_call_onboard_v3']);
  });

  it('switch OFF: the Australian lead gets both, as before', async () => {
    setSwitch(false);
    reset();
    const au = attended('au');
    const uk = attended('uk');
    seed([au, uk]);
    await cron(NUDGE_CRON);
    expect(emailsTo(PEOPLE.au.email).length).toBe(1);
    expect(emailsTo(PEOPLE.au.email)[0].subject).toBe(emailsTo(PEOPLE.uk.email)[0].subject);
    expect(waTo(PEOPLE.au.phone).map((x) => x.templateName)).toEqual(['gp_link_consult_post_call_onboard_v3']);
    expect(dbRow(au.id).metadata.consult.nudges.length).toBe(2);
  });
});

// ── A missed consultation: the rescue email, the rescue WhatsApp, Hazel's ring ─
function missed(country, slotAgoMs) {
  const callAt = new Date(Date.now() - slotAgoMs).toISOString();
  const bookedAt = new Date(Date.now() - slotAgoMs - 24 * H).toISOString();
  return lead(country, {
    call_booked: true, call_booked_at: bookedAt, call_at: callAt,
    wa: { call_booked: { sent_at: bookedAt } },
    nudges: [{ seq: 'booked_no_signup', step: 0, email: 'sent', sent_at: bookedAt }],
    no_show: { call_at: callAt, detected_at: new Date(Date.now() - slotAgoMs + 40 * M).toISOString(), via: 'sweep', ring: 'pending' }
  }, { created_at: new Date(Date.now() - slotAgoMs - 48 * H).toISOString(), status: 'contacted' });
}
const MISSED_SUBJECT = 'Sorry we missed each other';
const MISSED_TEMPLATE = 'gp_link_consult_missed_call';

describe('a missed consultation', () => {
  it('switch ON: no rescue email, WhatsApp or ring for the Australian lead; overseas leads get all three', async () => {
    setSwitch(true);
    reset();
    const rows = {}; ALL.forEach((c) => { rows[c] = missed(c, 3 * H); });
    seed(ALL.map((c) => rows[c]));

    await cron(NUDGE_CRON);
    expect(emailsTo(PEOPLE.au.email)).toEqual([]);
    expect(waTo(PEOPLE.au.phone)).toEqual([]);
    OVERSEAS.forEach((c) => {
      expect(emailsTo(PEOPLE[c].email).map((e) => e.subject), c).toEqual([MISSED_SUBJECT]);
      expect(waTo(PEOPLE[c].phone).map((x) => x.templateName), c).toEqual([MISSED_TEMPLATE]);
    });

    const r = await cron(CALLS_CRON);
    expect(r.status).toBe(200);
    expect(callsTo(PEOPLE.au.phone)).toEqual([]);
    expect(r.json.skipped.au_segment).toBe(1);
    OVERSEAS.forEach((c) => expect(callsTo(PEOPLE[c].phone).length, c).toBe(1));
    // The Australian lead's marker is untouched: nothing was sent, nothing rung.
    const m = dbRow(rows.au.id).metadata.consult.no_show;
    expect(m.ring).toBe('pending');
    expect(m.email_at).toBeUndefined();
    expect(m.wa_at).toBeUndefined();
    expect(dbRow(rows.au.id).metadata.consult.ai_call).toBeUndefined();
  });

  // CHANGED in WP-04. Was "…gets the email, the WhatsApp and the ring, as
  // before" and asserted ONE call from FROM_AU with no_show.ring === 'placed'.
  // The messages are still sent with the switch off (the message hold follows
  // the switch); the ring is now refused in both states (Hazel block is
  // unconditional: docs/au-gp/CONVENTIONS.md section 2).
  it('switch OFF: the Australian lead gets the email and the WhatsApp as before, but is NOT rung', async () => {
    setSwitch(false);
    reset();
    const au = missed('au', 3 * H);
    const nz = missed('nz', 3 * H);
    seed([au, nz]);
    await cron(NUDGE_CRON);
    expect(emailsTo(PEOPLE.au.email).map((e) => e.subject)).toEqual([MISSED_SUBJECT]);
    expect(waTo(PEOPLE.au.phone).map((x) => x.templateName)).toEqual([MISSED_TEMPLATE]);
    const r = await cron(CALLS_CRON);
    expect(callsTo(PEOPLE.au.phone)).toEqual([]);
    expect(r.json.skipped.au_segment).toBe(1);
    // The ring is not consumed: nothing was placed.
    expect(dbRow(au.id).metadata.consult.no_show.ring).toBe('pending');
    expect(dbRow(au.id).metadata.consult.ai_call).toBeUndefined();
    // New Zealand shares the AU number and is untouched.
    const nzCalls = callsTo(PEOPLE.nz.phone);
    expect(nzCalls.length).toBe(1);
    expect(nzCalls[0].from_number).toBe(FROM_AU);
    expect(dbRow(nz.id).metadata.consult.no_show.ring).toBe('placed');
  });
});

// ── Hazel: the dialler's own schedule and due call-backs ─────────────────────
function fresh(country) { return lead(country); }
function ownerCallback(country) {
  // Ten days old (past the dialler's own age limit): only the call-back rings it.
  return lead(country, { call_back_at: new Date(Date.now() - 5 * M).toISOString() }, { created_at: new Date(Date.now() - 10 * D).toISOString() });
}
function doctorCallback(country) {
  return lead(country, {
    ai_calls: [{ call_id: 'old-' + country, outcome: 'callback_requested', attempt: 1 }],
    ai_call: {
      call_id: 'old-' + country, outcome: 'callback_requested', attempt: 1, status: 'ended',
      callback_at: new Date(Date.now() - 5 * M).toISOString(),
      started_at: new Date(Date.now() - 5 * H).toISOString(), completed_at: new Date(Date.now() - 5 * H + 2 * M).toISOString()
    }
  }, { created_at: new Date(Date.now() - 6 * H).toISOString() });
}
const DIALLER_PATHS = {
  'the regular schedule': fresh,
  'a call-back the owner scheduled, now due': ownerCallback,
  'a call-back the doctor asked Hazel for, now due': doctorCallback
};

describe('lead-calls cron (Hazel)', () => {
  Object.keys(DIALLER_PATHS).forEach((label) => {
    it('switch ON, ' + label + ': the Australian lead is not rung; UK, Irish and New Zealand leads are', async () => {
      setSwitch(true);
      reset();
      const rows = {}; ALL.forEach((c) => { rows[c] = DIALLER_PATHS[label](c); });
      seed(ALL.map((c) => rows[c]));
      const before = JSON.stringify(rows.au.metadata.consult);

      const r = await cron(CALLS_CRON);
      expect(r.status).toBe(200);
      expect(callsTo(PEOPLE.au.phone)).toEqual([]);
      expect(retell.filter((c) => /create-phone-call/.test(c.path)).length).toBe(3);
      expect(r.json.called).toBe(3);
      expect(r.json.skipped.au_segment).toBe(1);
      expect(callsTo(PEOPLE.uk.phone)[0].from_number).toBe(FROM_UK);
      expect(callsTo(PEOPLE.ie.phone)[0].from_number).toBe(FROM_UK);
      // New Zealand still shares the Australian number: that is unchanged.
      expect(callsTo(PEOPLE.nz.phone)[0].from_number).toBe(FROM_AU);
      // Nothing was stamped on the Australian lead (a call-back is not consumed).
      expect(JSON.stringify(dbRow(rows.au.id).metadata.consult)).toBe(before);
    });

    // CHANGED in WP-04. Was "…the Australian lead is rung from the AU number,
    // as before": called === 2, skipped.au_segment undefined, one AU call
    // from FROM_AU with country_code 'au' and ai_call.status 'registered'.
    // Now the switch-off run is the same as the switch-on run above.
    it('switch OFF, ' + label + ': the Australian lead is NOT rung; UK, Irish and New Zealand leads are', async () => {
      setSwitch(false);
      reset();
      const rows = {}; ALL.forEach((c) => { rows[c] = DIALLER_PATHS[label](c); });
      seed(ALL.map((c) => rows[c]));
      const before = JSON.stringify(rows.au.metadata.consult);

      const r = await cron(CALLS_CRON);
      expect(r.status).toBe(200);
      expect(callsTo(PEOPLE.au.phone)).toEqual([]);
      expect(retell.filter((c) => /create-phone-call/.test(c.path)).length).toBe(3);
      expect(r.json.called).toBe(3);
      expect(r.json.skipped.au_segment).toBe(1);
      expect(callsTo(PEOPLE.uk.phone)[0].from_number).toBe(FROM_UK);
      expect(callsTo(PEOPLE.ie.phone)[0].from_number).toBe(FROM_UK);
      // New Zealand shares the Australian number and is completely unaffected.
      expect(callsTo(PEOPLE.nz.phone)[0].from_number).toBe(FROM_AU);
      expect(callsTo(PEOPLE.nz.phone)[0].retell_llm_dynamic_variables.country_code).toBe('nz');
      expect(dbRow(rows.nz.id).metadata.consult.ai_call.status).toBe('registered');
      // Nothing was stamped on the Australian lead (a call-back is not consumed).
      expect(JSON.stringify(dbRow(rows.au.id).metadata.consult)).toBe(before);
    });
  });
});

describe('the Leads tab: "will Hazel ring this lead?" and the owner\'s "ring now" button', () => {
  it('switch ON: the tab says why, and "ring now" is refused without touching Retell', async () => {
    setSwitch(true);
    reset();
    const au = fresh('au');
    const uk = fresh('uk');
    seed([au, uk]);

    const one = await httpReq('GET', '/api/ceo/leads/' + au.id, { host: SUPER_HOST, cookie: superCookie() });
    expect(one.status).toBe(200);
    expect(one.json.lead.hazel.state).toBe('blocked');
    expect(one.json.lead.hazel.reason).toBe('au_segment');
    expect(one.json.lead.hazel.label).toBe('Australian GP: Hazel does not ring Australian leads');

    const refused = await ceoPost('/api/ceo/leads/' + au.id + '/call');
    expect(refused.status).toBe(409);
    expect(refused.json.ok).toBe(false);
    expect(refused.json.message).toMatch(/does not ring Australian GPs/);
    expect(retell.filter((c) => /create-phone-call/.test(c.path))).toEqual([]);
    expect(dbRow(au.id).metadata.consult.ai_call).toBeUndefined();

    const ok = await ceoPost('/api/ceo/leads/' + uk.id + '/call');
    expect(ok.status).toBe(200);
    expect(callsTo(PEOPLE.uk.phone).length).toBe(1);
  });

  // CHANGED in WP-04. Was "…shows the Australian lead queued and 'ring now'
  // rings them, as before": hazel.state 'queued', reason 'call', POST 200 and
  // one call from FROM_AU. Now identical to the switch-on case.
  it('switch OFF: the tab says why, and "ring now" is refused without touching Retell (same as switch ON)', async () => {
    setSwitch(false);
    reset();
    const au = fresh('au');
    const nz = fresh('nz');
    seed([au, nz]);
    const one = await httpReq('GET', '/api/ceo/leads/' + au.id, { host: SUPER_HOST, cookie: superCookie() });
    expect(one.status).toBe(200);
    expect(one.json.lead.hazel.state).toBe('blocked');
    expect(one.json.lead.hazel.reason).toBe('au_segment');
    expect(one.json.lead.hazel.label).toBe('Australian GP: Hazel does not ring Australian leads');
    const refused = await ceoPost('/api/ceo/leads/' + au.id + '/call');
    expect(refused.status).toBe(409);
    expect(refused.json.ok).toBe(false);
    expect(refused.json.message).toMatch(/does not ring Australian GPs/);
    expect(retell.filter((c) => /create-phone-call/.test(c.path))).toEqual([]);
    expect(dbRow(au.id).metadata.consult.ai_call).toBeUndefined();
    // A New Zealand lead's "ring now" still works, from the shared AU number.
    const okNz = await ceoPost('/api/ceo/leads/' + nz.id + '/call');
    expect(okNz.status).toBe(200);
    expect(callsTo(PEOPLE.nz.phone).length).toBe(1);
    expect(callsTo(PEOPLE.nz.phone)[0].from_number).toBe(FROM_AU);
  });
});

describe('placeLeadCall: the last line of defence, whatever path reached it', () => {
  const decisionFor = (c) => ({ phone: PEOPLE[c].phone, country: c, tz: c === 'au' ? 'Australia/Sydney' : 'Europe/London', from: c === 'au' ? FROM_AU : FROM_UK, attempt: 1 });
  const cfg = () => ({ apiKey: 'key_test', agentId: 'agent_1', directorName: 'Khaleed', agentName: 'Hayley' });

  it('switch ON: refuses an Australian lead and stamps nothing; a UK lead is placed', async () => {
    setSwitch(true);
    reset();
    const au = fresh('au');
    const uk = fresh('uk');
    seed([au, uk]);
    const res = await testUtils.placeLeadCall(au, decisionFor('au'), cfg(), { source: 'some-future-path' });
    expect(res).toEqual({ ok: false, error: 'au_segment' });
    expect(retell.filter((c) => /create-phone-call/.test(c.path))).toEqual([]);
    expect(dbRow(au.id).metadata.consult.ai_call).toBeUndefined();
    // …and a row with no country on file that is being dialled as Australian.
    const blank = lead('au', { country: '' });
    const res2 = await testUtils.placeLeadCall(blank, decisionFor('au'), cfg(), { source: 'some-future-path', persist: false });
    expect(res2).toEqual({ ok: false, error: 'au_segment' });
    expect(retell.filter((c) => /create-phone-call/.test(c.path))).toEqual([]);

    const okUk = await testUtils.placeLeadCall(uk, decisionFor('uk'), cfg(), { source: 'some-future-path' });
    expect(okUk.ok).toBe(true);
    expect(callsTo(PEOPLE.uk.phone).length).toBe(1);
  });

  // CHANGED in WP-04. Was "switch OFF: an Australian lead is placed, as
  // before" (res.ok true, one call). The last line of defence no longer looks
  // at the switch.
  it('switch OFF: refuses an Australian lead and stamps nothing, exactly as with the switch on', async () => {
    setSwitch(false);
    reset();
    const au = fresh('au');
    const nz = fresh('nz');
    seed([au, nz]);
    const res = await testUtils.placeLeadCall(au, decisionFor('au'), cfg(), { source: 'some-future-path' });
    expect(res).toEqual({ ok: false, error: 'au_segment' });
    expect(retell.filter((c) => /create-phone-call/.test(c.path))).toEqual([]);
    expect(dbRow(au.id).metadata.consult.ai_call).toBeUndefined();
    // A row with no country on file that is being dialled as Australian.
    const blank = lead('au', { country: '' });
    const res2 = await testUtils.placeLeadCall(blank, decisionFor('au'), cfg(), { source: 'some-future-path', persist: false });
    expect(res2).toEqual({ ok: false, error: 'au_segment' });
    expect(retell.filter((c) => /create-phone-call/.test(c.path))).toEqual([]);
    // New Zealand (dialled as 'nz' from the shared AU number) is placed.
    const nzDecision = { phone: PEOPLE.nz.phone, country: 'nz', tz: 'Pacific/Auckland', from: FROM_AU, attempt: 1 };
    const okNz = await testUtils.placeLeadCall(nz, nzDecision, cfg(), { source: 'some-future-path' });
    expect(okNz.ok).toBe(true);
    expect(callsTo(PEOPLE.nz.phone).length).toBe(1);
  });
});

// ── Every other message a lead can be sent ───────────────────────────────────
const WA_KINDS = {
  hello_5m: (c) => lead(c),
  check_in_1h: (c) => lead(c),
  day_after_24h: (c) => lead(c),
  call_booked: (c) => lead(c, { call_booked: true, call_at: new Date(Date.now() + 2 * D).toISOString() }),
  signed_up: (c) => lead(c, { stopped: 'signed_up' }, { status: 'converted' }),
  onboarding_incomplete: (c) => lead(c, { stopped: 'signed_up' }, { status: 'converted' }),
  post_call_onboard: (c) => attended(c)
};

describe('every WhatsApp the funnel can send a lead (maybeSendConsultWa)', () => {
  Object.keys(WA_KINDS).forEach((kind) => {
    // CHANGED in WP-16. Was "held ... reason 'au_segment'" (the blanket hold).
    // Still not sent, now through the named path: no Australian template is
    // approved, so the skip says so (and is put on the lead's record). Never
    // the overseas template.
    it(kind + ': skipped for an Australian lead with the switch ON (no approved Australian template), sent with it OFF, always sent to a UK lead', async () => {
      setSwitch(true);
      reset();
      let au = WA_KINDS[kind]('au');
      let uk = WA_KINDS[kind]('uk');
      seed([au, uk]);
      expect(await testUtils.maybeSendConsultWa(au, kind)).toEqual({ ok: false, skipped: true, reason: 'au_template_not_approved' });
      expect(waTo(PEOPLE.au.phone)).toEqual([]);
      expect(dbRow(au.id).metadata.consult.au_log.map((e) => e.ch + ' ' + e.out + ' ' + e.why)).toEqual(['whatsapp skipped au_template_not_approved']);
      expect((dbRow(au.id).metadata.consult.wa || {})[kind]).toBeUndefined();
      expect((await testUtils.maybeSendConsultWa(uk, kind)).ok).toBe(true);
      expect(waTo(PEOPLE.uk.phone).length).toBe(1);

      setSwitch(false);
      reset();
      au = WA_KINDS[kind]('au');
      uk = WA_KINDS[kind]('uk');
      seed([au, uk]);
      expect((await testUtils.maybeSendConsultWa(au, kind)).ok).toBe(true);
      expect((await testUtils.maybeSendConsultWa(uk, kind)).ok).toBe(true);
      // Same template for both: with the switch off there is one funnel.
      expect(waTo(PEOPLE.au.phone).map((x) => x.templateName)).toEqual(waTo(PEOPLE.uk.phone).map((x) => x.templateName));
      expect(dbRow(au.id).metadata.consult.wa[kind]).toBeTruthy();
    });
  });
});

describe('the booking-link emails (magic link, and the plain link Hazel can send)', () => {
  // CHANGED in WP-16. Was "switch ON: neither goes to an Australian lead"
  // ({ ok: false, skipped: true, error: 'au_segment' }, no email). The
  // Australian booking-link email now exists, so both go, in Australian
  // wording: nothing about visas or registration. (They answer something the
  // doctor just asked for, so the go-live rule does not apply to them.)
  it('switch ON: an Australian lead gets the AUSTRALIAN booking-link email; a UK lead gets the same two as ever', async () => {
    setSwitch(true);
    reset();
    const au = fresh('au');
    const uk = fresh('uk');
    expect((await testUtils.sendConsultMagicLinkEmail(au)).ok).toBe(true);
    expect((await testUtils.sendConsultGenericBookingLinkEmail(au)).ok).toBe(true);
    const auGot = emailsTo(PEOPLE.au.email);
    expect(auGot.map((e) => e.subject)).toEqual(['Your GP Link call: pick a time that suits you', 'Your GP Link call: pick a time that suits you']);
    auGot.forEach((e) => {
      expect(e.text).not.toMatch(/visa|registration, |moving|move to Australia/i);
      expect(e.text).toContain('We never contact your current practice without asking you first.');
    });
    expect((await testUtils.sendConsultMagicLinkEmail(uk)).ok).toBe(true);
    expect((await testUtils.sendConsultGenericBookingLinkEmail(uk)).ok).toBe(true);
    expect(emailsTo(PEOPLE.uk.email).length).toBe(2);
  });
  it('switch OFF: both go to an Australian lead, as before', async () => {
    setSwitch(false);
    reset();
    const au = fresh('au');
    expect((await testUtils.sendConsultMagicLinkEmail(au)).ok).toBe(true);
    expect((await testUtils.sendConsultGenericBookingLinkEmail(au)).ok).toBe(true);
    expect(emailsTo(PEOPLE.au.email).map((e) => e.subject)).toEqual(['Ready when you are, book your free GP Link call', 'Your GP Link booking link']);
  });
});

describe('a new Australian lead from the website form still raises the owner alert', () => {
  const form = () => ({ name: 'Dr Test Auform', email: 'au.form.test@gplink-test.local', phone: '+61400000222', country: 'au', question: '' });
  [true, false].forEach((on) => {
    it('switch ' + (on ? 'ON' : 'OFF') + ': the lead is admitted and the owner is emailed; the lead is sent nothing on arrival', async () => {
      setSwitch(on);
      reset();
      testUtils.__resetSiteEnquiryRateLimitForTest();
      testUtils.__resetSiteEnquiriesForTest();
      const r = await httpReq('POST', '/api/public/consult-lead', { body: form() });
      expect(r.status).toBe(200);
      expect(r.json.qualified).toBe(true);
      const stored = (readDb().siteEnquiries || []).find((x) => x.email === form().email);
      expect(stored.metadata.consult.country).toBe('au');
      expect(stored.metadata.consult.qualified).toBe(true);
      expect(stored.metadata.consult.screened_out).toBeUndefined();
      // The owner alert: one email, to the owner, about this lead.
      const alerts = emails.map((c) => c.body).filter((b) => /enquiry/i.test(String(b.subject)) && String(b.subject).indexOf('Dr Test Auform') !== -1);
      expect(alerts.length).toBe(1);
      expect(JSON.stringify(alerts[0].to)).not.toContain(form().email);
      expect(emailsTo(form().email)).toEqual([]);
      expect(waTo(form().phone)).toEqual([]);
    });
  });
});

// ── Onboarding nudges: doctors parked on the eligibility waitlist ────────────
describe('the onboarding nudge list', () => {
  const ids = (list) => list.map((g) => g.email).sort();

  it('the enumeration leaves waitlisted doctors out only when asked to', async () => {
    const all = await testUtils.enumerateIncompleteOnboardingGps();
    expect(ids(all)).toContain(WAITLISTED);
    expect(ids(all)).toContain(STALLED);
    // No options, and the option set false, are the same list as ever.
    expect(ids(await testUtils.enumerateIncompleteOnboardingGps({ excludeEligibilityWaitlisted: false }))).toEqual(ids(all));
    const nudgeable = await testUtils.enumerateIncompleteOnboardingGps({ excludeEligibilityWaitlisted: true });
    expect(ids(nudgeable)).not.toContain(WAITLISTED);
    expect(ids(nudgeable)).toEqual(ids(all).filter((e) => e !== WAITLISTED));
    // The items themselves are unchanged (no new field leaks into staff views).
    expect(Object.keys(all[0]).sort()).toEqual(['completed', 'country', 'email', 'lastActiveMs', 'lastStep', 'name', 'userId']);
  });

  it('switch ON: the cron and the step follow-up skip the waitlisted doctor; the stalled doctor is still nudged', async () => {
    setSwitch(true);
    reset();
    const total = (await testUtils.enumerateIncompleteOnboardingGps()).length;
    const r = await cron(ONB_CRON);
    expect(r.status).toBe(200);
    expect(r.json.scanned).toBe(total - 1);
    await cron(ONB_CRON);
    expect(emailsTo(WAITLISTED)).toEqual([]);
    expect(emailsTo(STALLED).length).toBeGreaterThan(0);
    const followup = await cron('/api/cron/onboarding-step-followup');
    expect(followup.status).toBe(200);
    expect(followup.raw).not.toContain(WAITLISTED);
    const reminders = readDb().onboardingReminders || {};
    expect(JSON.stringify(reminders)).not.toContain(WAITLISTED);
    // Staff still see them: the CEO waitlist tab is not a nudge.
    const tab = await httpReq('GET', '/api/ceo/onboarding-incomplete', { host: SUPER_HOST, cookie: superCookie() });
    expect(tab.status).toBe(200);
    expect(tab.raw).toContain(WAITLISTED);
  });

  it('switch OFF: the waitlisted doctor is scanned and nudged, exactly as before', async () => {
    setSwitch(false);
    reset();
    const total = (await testUtils.enumerateIncompleteOnboardingGps()).length;
    const r = await cron(ONB_CRON);
    expect(r.json.scanned).toBe(total);
    await cron(ONB_CRON);
    expect(emailsTo(WAITLISTED).length).toBeGreaterThan(0);
    expect(JSON.stringify(readDb().onboardingReminders || {})).toContain(WAITLISTED);
  });
});

// ── The PEP waitlist gate ────────────────────────────────────────────────────
describe('applyPepWaitlistGate is limited to GB, IE and NZ', () => {
  const status = (em) => {
    const st = (readDb().userState || {})[em] || {};
    return st.account_status || (st.state && st.state.account_status) || 'active';
  };
  const meta = (country) => ({ country, certType: 'Specialist certificate', dateFound: '2001-05-01', cutoffDate: '2007-08-01' });

  it('switch ON: an Australian (or any other, or unreadable) verdict cannot lock a doctor onto the PEP waitlist', async () => {
    setSwitch(true);
    for (const c of ['AU', 'au', 'US', '', undefined]) {
      expect(await testUtils.applyPepWaitlistGate(PEP_AU, null, meta(c), { first_name: 'Test', last_name: 'Pepau' })).toBe(false);
    }
    expect(await testUtils.applyPepWaitlistGate(PEP_AU, null, null, null)).toBe(false);
    expect(status(PEP_AU)).toBe('active');
    expect(testUtils.__pepWaitlistRowForTest(PEP_AU)).toBe(null);
  });

  it('switch ON: GB, IE and NZ verdicts gate exactly as before, from both call sites', async () => {
    setSwitch(true);
    expect(await testUtils.applyPepWaitlistGate(PEP_GB, null, meta('GB'), { first_name: 'Test', last_name: 'Pepgb' })).toBe(true);
    expect(status(PEP_GB)).toBe('pep_waitlist');
    expect(testUtils.__pepWaitlistRowForTest(PEP_GB)).toMatchObject({ country: 'GB', cert_type: 'Specialist certificate', date_found: '2001-05-01', cutoff_date: '2007-08-01', name: 'Test Pepgb' });
    for (const c of ['IE', 'NZ']) {
      expect(await testUtils.applyPepWaitlistGate('pep.' + c.toLowerCase() + '.test@gplink-test.local', null, meta(c), null)).toBe(true);
    }
    // The register-date call site (always GB).
    const gated = await testUtils.applyRegisterPathwayPepGate(null, { email: PEP_REG, first_name: 'Test', last_name: 'Pepreg' },
      { verdict: 'before_cutoff', gpRegisterDate: '2005-02-01', cutoff: '2007-08-01' });
    expect(gated).toBe(true);
    expect(status(PEP_REG)).toBe('pep_waitlist');
    expect(await testUtils.applyRegisterPathwayPepGate(null, { email: PEP_REG }, { verdict: 'short_gap' })).toBe(false);
  });

  it('switch OFF: the gate is the old one (no country check at all)', async () => {
    setSwitch(false);
    const em = 'pep.off.test@gplink-test.local';
    await testUtils.applyPepWaitlistGate(em, null, meta('AU'), { first_name: 'Test', last_name: 'Pepoff' });
    expect(status(em)).toBe('pep_waitlist');
    expect(testUtils.__pepWaitlistRowForTest(em)).toMatchObject({ country: 'AU' });
  });
});

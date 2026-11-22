// WP-16 (Australian GP build), against the database stub (the mode production
// runs in): the call reminders for a booked Australian-segment lead, where the
// go-live instant is kept, and the quiet-hours gate for a doctor.
//
//   - both email reminders in Australian wording, the time on the lead's own
//     clock; they are anchored on a meeting, so neither quiet hours nor the
//     go-live rule holds them;
//   - the WhatsApp reminders: a named skip (recorded once per reminder) until
//     an Australian template is approved, then sent through THAT template;
//   - the go-live instant: recorded once in runtime_kv by the consult-nudge
//     job, never by a page, never on a Vercel preview, never with the switch
//     off;
//   - auDoctorQuietHoursAllow: the gate WP-11's N13 uses and WP-17 must use.
//
// Nothing real is sent; every identity is fake. The stub does not evaluate
// `ilike`, so one lead and one booking are in the tables at a time.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootLeadCopyServer } = require('./helpers/au-wp16-harness.js');
const { forbiddenIn, htmlToText } = require('./helpers/au-wp16-copy.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const auLeadCopy = require('../lib/au-lead-copy.js');

const M = 60000;
const H = 60 * M;
const D = 24 * H;
const CALL_AT = '2027-01-14T02:30:00Z';                 // 10:30 in Perth, 13:30 in Sydney
const AU_NIGHT = Date.parse('2027-01-14T15:00:00Z');    // 02:00 in Sydney
const IN_HOURS = Date.parse('2027-01-14T02:00:00Z');
const AU = { name: 'Dr Test Auvr', email: 'au.vr.test@gplink-test.local', phone: '+61400000111' };
const UK = { name: 'Dr Test Ukgp', email: 'uk.gp.test@gplink-test.local', phone: '+447700900111' };
const DOCTORS = { vr: buildAuDoctor('au_vr'), restricted: buildAuDoctor('au_restricted'), overseas: buildAuDoctor('overseas_null') };

let h;
let t;
const auEmailsSeen = [];
const rows = (table) => h.emu.table(table);

function seedBooking(who, consultOver, callOver) {
  const isAu = who === AU;
  const leads = rows('site_enquiries');
  leads.length = 0;
  leads.push({
    id: 'wp16-lead-' + (isAu ? 'au' : 'uk'), kind: 'gp', name: who.name, email: who.email, phone: who.phone, state: isAu ? 'au' : 'uk', status: 'contacted',
    created_at: '2027-01-10T00:00:00.000Z',
    metadata: {
      source: 'gp_consult_form',
      consult: Object.assign(isAu
        ? { token: 'TOKAU', qualified: true, country: 'au', segment: 'au_vr', ahpra_registered: true, state: 'WA', call_booked: true, call_at: CALL_AT, nudges: [] }
        : { token: 'TOKUK', qualified: true, country: 'uk', call_booked: true, call_at: CALL_AT, nudges: [] }, consultOver || {})
    }
  });
  const calls = rows('scheduled_calls');
  calls.length = 0;
  calls.push(Object.assign({
    id: 'wp16-call-' + (isAu ? 'au' : 'uk'), meeting_kind: 'consultation', host_kind: 'ceo', status: 'booked', user_id: null,
    invitee_email: who.email, scheduled_at: CALL_AT, booked_at: new Date(Date.parse(CALL_AT) - 3 * D).toISOString(),
    zoom_join_url: 'https://zoom.us/j/5550016', notification_channels: {}, invitee_notes: null, timezone: isAu ? 'Australia/Perth' : 'Europe/London',
    correlation_token: 'tok-wp16', created_at: '2027-01-11T00:00:00.000Z', updated_at: '2027-01-11T00:00:00.000Z'
  }, callOver || {}));
}
const leadRow = () => rows('site_enquiries')[0];
const callRow = () => rows('scheduled_calls')[0];
const logOf = () => ((leadRow().metadata.consult.au_log) || []).map((e) => e.ch + ' ' + e.out + ' ' + e.id + (e.why ? ' (' + e.why + ')' : ''));
const emailsTo = (who) => { const got = h.emailsTo(who.email); if (who === AU) got.forEach((e) => { if (auEmailsSeen.indexOf(e) === -1) auEmailsSeen.push(e); }); return got; };
const remind = (minutesBefore) => t.runConsultCallReminders(Date.parse(CALL_AT) - minutesBefore * M, 'consult');

beforeAll(async () => {
  const tables = buildAuFixtureDb([DOCTORS.vr, DOCTORS.restricted, DOCTORS.overseas]);
  tables.site_enquiries = [];
  tables.scheduled_calls = [];
  tables.runtime_kv = [];
  h = await bootLeadCopyServer({ name: 'wp16-reminders', mode: 'supabase', tables });
  t = h.testUtils;
}, 60000);
afterAll(async () => {
  ['AU_LEAD_COPY_LIVE_FROM', 'AU_WHATSAPP_APPROVED_TEMPLATES', 'AU_WHATSAPP_DISABLED_TEMPLATES', 'VERCEL_ENV', 'NOTIFY_TEST_RECIPIENTS'].forEach((k) => { delete process.env[k]; });
  if (h) await h.closeAll();
});
beforeEach(() => {
  h.setSwitch(true);
  h.reset();
  process.env.AU_LEAD_COPY_LIVE_FROM = '2020-01-01T00:00:00Z';
  delete process.env.AU_WHATSAPP_APPROVED_TEMPLATES;
  delete process.env.AU_WHATSAPP_DISABLED_TEMPLATES;
  delete process.env.VERCEL_ENV;
  t.__setAuQuietHoursClockForTest(IN_HOURS);
});

describe('the call reminders for a booked Australian-segment lead', () => {
  it('the day before: the Australian email, on Perth time; the WhatsApp is a named skip, recorded once', async () => {
    seedBooking(AU);
    let out = await remind(23 * 60);
    expect(out).toMatchObject({ checked: 1, sent: 0, emailsSent: 1 });
    const got = emailsTo(AU);
    expect(got.map((e) => e.subject)).toEqual(['Your GP Link call: Thursday 14 January, 10:30 am (Perth time)']);
    expect(got[0].text).toContain('Hi Dr Auvr,');
    expect(got[0].text).toContain('Bring whatever you would like to talk through: the kind of practice you want, billing mix, location, hours and timing.');
    expect(got[0].text).toContain(auLeadCopy.CONFIDENTIALITY_LINE);
    expect(got[0].text).toContain('Join the call: https://zoom.us/j/5550016');
    expect(got[0].text).not.toMatch(/visas|earnings and life in Australia/);
    expect(String(got[0].from)).toContain('Khaleed at GP Link');
    expect(h.waTo(AU.phone)).toEqual([]);
    expect(callRow().notification_channels.consult_reminders.email_h24).toBeTruthy();
    expect(callRow().notification_channels.consult_reminders.h24).toBeUndefined();
    expect(logOf()).toEqual(['whatsapp skipped n02_reminder_day (au_template_not_approved)', 'email sent n02_reminder_day']);

    // The job runs every 5 minutes: nothing is sent or recorded twice.
    h.reset();
    out = await remind(23 * 60 - 5);
    expect(out.emailsSent).toBe(0);
    expect(emailsTo(AU)).toEqual([]);
    expect(logOf().length).toBe(2);
  });

  // CHANGED DELIBERATELY BY WP-18 (walk-findings T4): by default these two
  // reminders now go through the existing templates, confirmed neutral (the
  // test after next). The named skip is what happens when the owner switches
  // them off, which this test now does first.
  it('an hour before: the Australian email with the join link; both WhatsApp reminders skipped by name', async () => {
    process.env.AU_WHATSAPP_DISABLED_TEMPLATES = 'lead_call_hour_before,lead_call_starting';
    seedBooking(AU);
    await remind(60);
    const got = emailsTo(AU);
    expect(got.map((e) => e.subject)).toEqual(['Your GP Link call is in about an hour (10:30 am (Perth time))']);
    expect(got[0].html).toContain('https://zoom.us/j/5550016');
    expect(h.waTo(AU.phone)).toEqual([]);
    await remind(4);                                      // the "starts in 5 minutes" touch is WhatsApp only
    expect(h.waTo(AU.phone)).toEqual([]);
    expect(logOf()).toEqual([
      'whatsapp skipped n02_reminder_hour (au_template_not_approved)', 'email sent n02_reminder_hour',
      'whatsapp skipped n02_reminder_hour (au_template_not_approved)']);
    const keys = leadRow().metadata.consult.au_log.filter((e) => e.out === 'skipped').map((e) => e.key.split(':')[0]);
    expect(keys).toEqual(['call_hour_before', 'call_starting']);
  });

  it('they are anchored on the meeting: sent at night, and for a lead from before go-live', async () => {
    process.env.AU_LEAD_COPY_LIVE_FROM = '2099-01-01T00:00:00Z';
    t.__setAuQuietHoursClockForTest(AU_NIGHT);
    seedBooking(AU);
    await remind(23 * 60);
    await remind(60);
    expect(emailsTo(AU).map((e) => e.subject.split(':')[0].split(' is ')[0])).toEqual(['Your GP Link call', 'Your GP Link call']);
  });

  it('the unlaunched segments read the careful wording the day before', async () => {
    seedBooking(AU, { segment: 'au_non_vr' });
    await remind(23 * 60);
    const got = emailsTo(AU);
    expect(got[0].text).toContain("Bring your questions about your registration and what you are looking for, and we'll talk through what fits your registration.");
    expect(got[0].text).not.toMatch(/the kind of practice you want/);
  });

  // CHANGED DELIBERATELY BY WP-18: only the day-before reminder still needs a
  // new Australian template (the existing one invites questions about visas).
  // The one-hour and five-minute ones go through the existing neutral
  // templates without any setting.
  it('with the Australian templates approved the WhatsApp reminders go through them, with the Perth label', async () => {
    process.env.AU_WHATSAPP_APPROVED_TEMPLATES = 'lead_call_reminder';
    seedBooking(AU);
    await remind(23 * 60);
    await remind(60);
    await remind(4);
    const wa = h.waTo(AU.phone);
    expect(wa.map((c) => c.templateName)).toEqual(['gp_link_au_lead_call_reminder', 'gp_link_consult_call_1h', 'gp_link_consult_call_starting_5m']);
    expect(wa[0].templateData.body.placeholders).toEqual(['Dr', 'Thursday 14 January, 10:30 am (Perth time)', 'https://zoom.us/j/5550016']);
    expect(wa[1].templateData.body.placeholders[1]).toBe('10:30 am (Perth time)');
    wa.forEach((c) => expect(forbiddenIn(c.templateData.body.placeholders.join('\n'))).toEqual([]));
    expect(logOf().filter((x) => /whatsapp sent/.test(x)).length).toBe(3);
    expect(logOf().filter((x) => /skipped/.test(x))).toEqual([]);
  });

  it('a UK lead: the same two emails and three WhatsApps as ever, in UK time', async () => {
    seedBooking(UK);
    await remind(23 * 60);
    await remind(60);
    await remind(4);
    const got = emailsTo(UK);
    expect(got.map((e) => e.subject)).toEqual(['Your GP Link call: Thursday 14 January, 2:30 am (UK time)', 'Your GP Link call is in about an hour (2:30 am (UK time))']);
    expect(got[0].text).toContain('registration, visas, earnings and life in Australia');
    expect(h.waTo(UK.phone).map((c) => c.templateName)).toEqual(['gp_link_consult_call_reminder', 'gp_link_consult_call_1h', 'gp_link_consult_call_starting_5m']);
    expect(leadRow().metadata.consult.au_log).toBeUndefined();
  });

  it('switch OFF: the Australian-segment lead is reminded exactly as the UK lead is', async () => {
    h.setSwitch(false);
    seedBooking(AU);
    await remind(23 * 60);
    const got = h.emailsTo(AU.email);
    expect(got[0].text).toContain('registration, visas, earnings and life in Australia');
    expect(h.waTo(AU.phone).map((c) => c.templateName)).toEqual(['gp_link_consult_call_reminder']);
    expect(leadRow().metadata.consult.au_log).toBeUndefined();
  });

  it('every Australian reminder email is clean', () => {
    expect(auEmailsSeen.length).toBeGreaterThanOrEqual(5);
    auEmailsSeen.forEach((e) => expect(forbiddenIn([e.subject, htmlToText(e.html), e.text].join('\n')), e.subject).toEqual([]));
  });
});

describe('where the go-live instant is kept (runtime_kv au_lead_copy_live_from)', () => {
  const kv = () => rows('runtime_kv').filter((r) => r.key === 'au_lead_copy_live_from');
  const kvRequests = () => h.emu.requests.filter((r) => r.table === 'runtime_kv' && /au_lead_copy_live_from/.test(String(r.query || '') + JSON.stringify(r.body || '')));
  const clear = () => {
    delete process.env.AU_LEAD_COPY_LIVE_FROM;
    t.__resetAuLeadCopyLiveFromForTest();
    const all = rows('runtime_kv');
    for (let i = all.length - 1; i >= 0; i--) if (all[i].key === 'au_lead_copy_live_from') all.splice(i, 1);
    rows('site_enquiries').length = 0;
    rows('scheduled_calls').length = 0;
    h.emu.requests.length = 0;
  };

  it('the consult-nudge job records "now" the first time it runs with the switch on, once, and keeps it', async () => {
    clear();
    const r1 = await h.cron('/api/cron/consult-nudge');
    expect(r1.status).toBe(200);
    expect(kv().length).toBe(1);
    const at = kv()[0].value.at;
    expect(Math.abs(Date.parse(at) - Date.now())).toBeLessThan(15000);
    expect(r1.json.au.live_from).toBe(at);
    expect(kvRequests().map((r) => r.method)).toEqual(expect.arrayContaining(['GET', 'POST']));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const r2 = await h.cron('/api/cron/consult-nudge');
    expect(r2.json.au.live_from).toBe(at);
    expect(kv().length).toBe(1);
    // Even from a fresh process (nothing remembered), the stored instant is the answer.
    t.__resetAuLeadCopyLiveFromForTest();
    expect(await t.auLeadCopyLiveFromMs({ create: true })).toBe(Date.parse(at));
    expect(kv().length).toBe(1);
  });

  it('AU_LEAD_COPY_LIVE_FROM, when set, wins and nothing is read or written', async () => {
    clear();
    process.env.AU_LEAD_COPY_LIVE_FROM = '2026-12-01T00:00:00Z';
    const r = await h.cron('/api/cron/consult-nudge');
    expect(r.json.au.live_from).toBe('2026-12-01T00:00:00.000Z');
    expect(kv()).toEqual([]);
    expect(kvRequests()).toEqual([]);
  });

  it('the Leads tab only reads it: opening the page never starts the clock', async () => {
    clear();
    seedBooking(AU, { call_booked: false, call_at: undefined });
    const list = await h.get('/api/ceo/leads', h.superAdmin());
    expect(list.status).toBe(200);
    expect(kv()).toEqual([]);
    expect(list.json.leads[0]).toMatchObject({ au_copy_state: 'not_live', au_copy_note: 'Australian messages not live yet' });
    expect(kvRequests().length).toBeGreaterThan(0);
    expect(kvRequests().every((r) => r.method === 'GET')).toBe(true);
  });

  it('a Vercel preview (it shares the production database) never writes it', async () => {
    clear();
    process.env.VERCEL_ENV = 'preview';
    try {
      const r = await h.cron('/api/cron/consult-nudge');
      expect(r.status).toBe(200);
      expect(kv()).toEqual([]);
      expect(kvRequests().every((req) => req.method === 'GET')).toBe(true);
      // It still has an instant to work with for this process (nothing can be sent anyway: the send lock).
      expect(Math.abs(Date.parse(r.json.au.live_from) - Date.now())).toBeLessThan(15000);
    } finally { delete process.env.VERCEL_ENV; t.__resetAuLeadCopyLiveFromForTest(); }
  });

  it('switch OFF: not read, not written, and the job answers with no Australian key', async () => {
    clear();
    h.setSwitch(false);
    const r = await h.cron('/api/cron/consult-nudge');
    expect(r.status).toBe(200);
    expect(r.json.au).toBeUndefined();
    expect(kv()).toEqual([]);
    expect(kvRequests()).toEqual([]);
    expect(Number.isNaN(await t.auLeadCopyLiveFromMs({ create: true }))).toBe(true);
    expect(kv()).toEqual([]);
  });
});

describe('quiet hours for a doctor on an Australian pathway (auDoctorQuietHoursAllow)', () => {
  it('their own clock: the device zone on their profile', async () => {
    // The fixture au_vr doctor is in Melbourne, the au_restricted doctor in Perth.
    const night = await t.auDoctorQuietHoursAllow(DOCTORS.vr.userId, AU_NIGHT);                // 02:00 Melbourne
    expect(night).toMatchObject({ allow: false, applies: true, zone: 'Australia/Melbourne', localTime: '02:00', reason: 'quiet_hours' });
    expect(await t.auDoctorQuietHoursAllow(DOCTORS.vr.userId, IN_HOURS)).toMatchObject({ allow: true, applies: true, localTime: '13:00' });
    // 10:30 UTC: 21:30 in Melbourne, 18:30 in Perth.
    const evening = Date.parse('2027-01-14T10:30:00Z');
    expect((await t.auDoctorQuietHoursAllow(DOCTORS.vr.userId, evening)).allow).toBe(false);
    expect(await t.auDoctorQuietHoursAllow(DOCTORS.restricted.userId, evening)).toMatchObject({ allow: true, zone: 'Australia/Perth', localTime: '18:30' });
  });
  it('an overseas doctor, and everyone with the switch off, is never held', async () => {
    expect(await t.auDoctorQuietHoursAllow(DOCTORS.overseas.userId, AU_NIGHT)).toMatchObject({ allow: true, applies: false });
    h.setSwitch(false);
    expect(await t.auDoctorQuietHoursAllow(DOCTORS.vr.userId, AU_NIGHT)).toMatchObject({ allow: true, applies: false });
  });
});

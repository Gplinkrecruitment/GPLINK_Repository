// WP-16 (Australian GP build), end to end through the real server (local JSON
// db, recording Resend and DoubleTick stubs; nothing real is sent, every
// identity is fake).
//
//   - every former hold site now sends Australian copy or takes a named skip;
//   - the go-live rule: an old lead gets nothing, a new lead one step per run,
//     in order;
//   - quiet hours: a held step is deferred (not sent, not marked) and goes on
//     the next run inside the hours; overseas leads are not held;
//   - the unlaunched segments get the careful wording, and not the matching
//     emails;
//   - WhatsApp: skipped by name until an Australian template is approved, then
//     sent through THAT template;
//   - the Leads tab says what was sent and what was skipped and why;
//   - switch off: an Australian-segment lead is an ordinary lead again.
//
// Every email that reaches the Australian doctors in this file is scanned for
// the forbidden words at the end.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const { bootLeadCopyServer } = require('./helpers/au-wp16-harness.js');
const { forbiddenIn, htmlToText } = require('./helpers/au-wp16-copy.js');
const auLeadCopy = require('../lib/au-lead-copy.js');
const leadCalls = require('../lib/lead-calls.js');

const RUN = crypto.randomBytes(3).toString('hex');
const M = 60000;
const H = 60 * M;
const D = 24 * H;
const NUDGE = '/api/cron/consult-nudge';
// 13:00 in Sydney, 10:00 in Perth: inside everyone's hours.
const IN_HOURS = Date.parse('2027-01-14T02:00:00Z');
// 02:00 in Sydney, 23:00 in Perth, 15:00 in London: night in Australia.
const AU_NIGHT = Date.parse('2027-01-14T15:00:00Z');
// 09:00 in Sydney, 06:00 in Perth.
const SYDNEY_MORNING = Date.parse('2027-01-13T22:00:00Z');

const PEOPLE = {
  au: { name: 'Dr Test Auvr', email: 'au.vr.test@gplink-test.local', phone: '+61400000111' },
  au2: { name: 'Dr Test Aunew', email: 'au.new.test@gplink-test.local', phone: '+61400000222' },
  au3: { name: 'Dr Test Auold', email: 'au.old.test@gplink-test.local', phone: '+61400000333' },
  uk: { name: 'Dr Test Ukgp', email: 'uk.gp.test@gplink-test.local', phone: '+447700900111' }
};
const AU_ADDRESSES = [PEOPLE.au.email, PEOPLE.au2.email, PEOPLE.au3.email];

let h;
let t;
let seq = 0;
const auEmailsSeen = [];

function lead(who, consultOver, rowOver) {
  seq++;
  const p = PEOPLE[who];
  const isAu = who !== 'uk';
  return Object.assign({
    id: 'wp16-' + who + '-' + RUN + '-' + seq,
    created_at: new Date(Date.now() - 30 * M).toISOString(),
    kind: 'gp', name: p.name, email: p.email, phone: p.phone,
    practice_name: null, state: isAu ? 'au' : 'uk', message: null, status: 'new',
    metadata: {
      source: 'gp_consult_form',
      consult: Object.assign(isAu
        ? { token: 'TOK' + seq, qualified: true, country: 'au', segment: 'au_vr', ahpra_registered: true, state: 'NSW', vr_status: 'yes', call_booked: false, nudges: [] }
        : { token: 'TOK' + seq, qualified: true, country: 'uk', call_booked: false, nudges: [], country_raw: 'uk', country_source: 'question' },
      consultOver || {})
    }
  }, rowOver || {});
}
const consultOf = (id) => h.dbRow(id).metadata.consult;
const steps = (id) => (consultOf(id).nudges || []).map((n) => n.seq + ':' + n.step + ':' + n.email);
const logOf = (id) => (consultOf(id).au_log || []).map((e) => e.ch + ' ' + e.out + ' ' + e.id + (e.why ? ' (' + e.why + ')' : ''));
function emailsTo(addr) {
  const got = h.emailsTo(addr);
  if (AU_ADDRESSES.indexOf(addr) !== -1) got.forEach((e) => { if (auEmailsSeen.indexOf(e) === -1) auEmailsSeen.push(e); });
  return got;
}
const liveFrom = (ms) => { process.env.AU_LEAD_COPY_LIVE_FROM = new Date(ms).toISOString(); };
// Move a recorded step back in time, as if it had gone that long ago.
function backdateLastStep(id, agoMs) {
  const row = h.dbRow(id);
  const n = row.metadata.consult.nudges;
  // The last step went `agoMs` ago; each earlier one an hour before the next.
  n.forEach((entry, i) => { entry.sent_at = new Date(Date.now() - agoMs - (n.length - 1 - i) * H).toISOString(); });
  return row;
}

beforeAll(async () => {
  h = await bootLeadCopyServer({ name: 'wp16-server' });
  t = h.testUtils;
}, 60000);
afterAll(async () => {
  delete process.env.AU_LEAD_COPY_LIVE_FROM;
  delete process.env.AU_WHATSAPP_APPROVED_TEMPLATES;
  delete process.env.AU_WHATSAPP_DISABLED_TEMPLATES;
  if (h) await h.closeAll();
});
beforeEach(() => {
  h.setSwitch(true);
  h.reset();
  liveFrom(Date.now() - 10 * D);
  delete process.env.AU_WHATSAPP_APPROVED_TEMPLATES;
  delete process.env.AU_WHATSAPP_DISABLED_TEMPLATES;
  t.__setAuQuietHoursClockForTest(IN_HOURS);
});

describe('N01: the notes before a booking', () => {
  it('a NEW Australian lead with all three notes overdue gets ONE per run, in order; the UK lead beside them is chased as ever', async () => {
    const au = lead('au', {}, { created_at: new Date(Date.now() - 30 * H).toISOString() });
    const uk = lead('uk', {}, { created_at: new Date(Date.now() - 30 * H).toISOString() });
    h.seed([au, uk]);

    // Run 1: the 5-minute note. No Australian WhatsApp template is approved,
    // so the note goes by email; the UK lead gets the WhatsApp only, as ever.
    let r = await h.cron(NUDGE);
    expect(r.status).toBe(200);
    let got = emailsTo(PEOPLE.au.email);
    expect(got.map((e) => e.subject)).toEqual(['Thanks for getting in touch']);
    expect(got[0].html).toContain('Looking for a better-fitting practice?');
    expect(got[0].text).toContain('I help GPs who are registered in Australia find a practice that fits them better');
    expect(got[0].text).toContain(auLeadCopy.CONFIDENTIALITY_LINE);
    expect(got[0].text).toContain('/start?lead=' + au.metadata.consult.token + '#book');
    expect(got[0].text).toMatch(/Unsubscribe: https?:\/\/\S+\/api\/unsubscribe\?token=/);
    expect(got[0].html).toContain('Unsubscribe from these emails');
    expect(String(got[0].from)).toContain('Khaleed at GP Link');
    expect(h.waTo(PEOPLE.au.phone)).toEqual([]);
    expect(steps(au.id)).toEqual(['not_booked:0:sent']);
    expect(logOf(au.id)).toEqual(['email sent n01_5m', 'whatsapp skipped n01_5m (au_template_not_approved)']);
    expect(emailsTo(PEOPLE.uk.email)).toEqual([]);
    expect(h.waTo(PEOPLE.uk.phone).map((c) => c.templateName)).toEqual(['gp_link_consult_hello_5m']);
    expect(r.json.au).toMatchObject({ deferred_quiet_hours: 0, before_go_live: 0 });
    expect(r.json.au.live_from).toBe(process.env.AU_LEAD_COPY_LIVE_FROM);

    // Run 2, straight away: nothing more (the next note waits its 40 minutes).
    h.reset();
    r = await h.cron(NUDGE);
    expect(emailsTo(PEOPLE.au.email)).toEqual([]);
    expect(steps(au.id)).toEqual(['not_booked:0:sent']);

    // 2 hours on: the 1-hour note. Email for both; WhatsApp for the UK lead only.
    h.seed([backdateLastStep(au.id, 2 * H), backdateLastStep(uk.id, 2 * H)]);
    h.reset();
    await h.cron(NUDGE);
    got = emailsTo(PEOPLE.au.email);
    expect(got.map((e) => e.subject)).toEqual(['A quick one from me at GP Link']);
    expect(got[0].text).toContain('the one thing you would most want from your next practice (billing mix, location, hours, the team)');
    expect(h.waTo(PEOPLE.au.phone)).toEqual([]);
    expect(emailsTo(PEOPLE.uk.email).map((e) => e.subject)).toEqual(['Quick one from me at GP Link']);
    expect(emailsTo(PEOPLE.uk.email)[0].text).toContain('moving to Australia');
    expect(h.waTo(PEOPLE.uk.phone).map((c) => c.templateName)).toEqual(['gp_link_consult_check_in_1h']);
    expect(steps(au.id)).toEqual(['not_booked:0:sent', 'not_booked:1:sent']);

    // 13 hours on: the last note.
    h.seed([backdateLastStep(au.id, 13 * H), backdateLastStep(uk.id, 13 * H)]);
    h.reset();
    await h.cron(NUDGE);
    got = emailsTo(PEOPLE.au.email);
    expect(got.map((e) => e.subject)).toEqual(['Last note from me']);
    expect(got[0].text).toContain('If a change of practice is a someday thing');
    expect(steps(au.id)).toEqual(['not_booked:0:sent', 'not_booked:1:sent', 'not_booked:2:sent']);
    expect(logOf(au.id).filter((x) => /sent/.test(x))).toEqual(['email sent n01_5m', 'email sent n01_1h', 'email sent n01_24h']);
    expect(logOf(au.id).filter((x) => /skipped/.test(x))).toEqual([
      'whatsapp skipped n01_5m (au_template_not_approved)', 'whatsapp skipped n01_1h (au_template_not_approved)', 'whatsapp skipped n01_24h (au_template_not_approved)']);
    // No overseas WhatsApp marker was stamped for the Australian lead: the legs stay open for an approved template.
    expect(consultOf(au.id).wa).toBeUndefined();
    expect(consultOf(au.id).wa_skipped).toBeUndefined();

    // And then the sequence ends quietly, like any other.
    h.reset();
    await h.cron(NUDGE);
    expect(emailsTo(PEOPLE.au.email)).toEqual([]);
    expect(consultOf(au.id).stopped).toBe('exhausted');
  }, 60000);

  it('an OLD Australian lead (enquired before go-live) gets nothing, run after run; the owner is still paged', async () => {
    liveFrom(Date.now() - 1 * H);
    const old = lead('au3', {}, { created_at: new Date(Date.now() - 80 * M).toISOString() });   // 20 minutes before go-live
    const fresh = lead('au2', {}, { created_at: new Date(Date.now() - 10 * M).toISOString() });
    const uk = lead('uk', {}, { created_at: new Date(Date.now() - 80 * M).toISOString() });
    h.seed([old, fresh, uk]);
    const before = JSON.stringify(old.metadata.consult.nudges);

    for (let run = 0; run < 3; run++) {
      const r = await h.cron(NUDGE);
      expect(r.json.au.before_go_live, 'run ' + run).toBe(1);
    }
    expect(emailsTo(PEOPLE.au3.email)).toEqual([]);
    expect(h.waTo(PEOPLE.au3.phone)).toEqual([]);
    const c = consultOf(old.id);
    expect(JSON.stringify(c.nudges)).toBe(before);
    expect(c.stopped).toBeUndefined();
    expect(c.au_log).toBeUndefined();
    expect(c.wa_skipped).toBeUndefined();
    // The owner hears about the old lead exactly as before (20 minutes after the hour).
    expect(c.owner_alert && c.owner_alert.via).toBe('whatsapp');
    expect(h.waTo(h.OWNER_PHONE).filter((x) => x.templateName === 'gp_link_owner_lead_alert').map((x) => x.templateData.body.placeholders[0])).toContain(PEOPLE.au3.name);
    // The lead who enquired after go-live got their 5-minute note (once), the UK lead their ordinary chase.
    expect(emailsTo(PEOPLE.au2.email).map((e) => e.subject)).toEqual(['Thanks for getting in touch']);
    expect(h.waTo(PEOPLE.uk.phone).map((c) => c.templateName)).toEqual(['gp_link_consult_hello_5m']);
  }, 60000);

  it('with NO go-live instant readable, no Australian lead is sent anything; overseas leads are unaffected', async () => {
    process.env.AU_LEAD_COPY_LIVE_FROM = 'next tuesday';
    const au = lead('au', {}, { created_at: new Date(Date.now() - 10 * M).toISOString() });
    const uk = lead('uk', {}, { created_at: new Date(Date.now() - 10 * M).toISOString() });
    h.seed([au, uk]);
    const r = await h.cron(NUDGE);
    expect(r.json.au.live_from).toBeNull();
    expect(emailsTo(PEOPLE.au.email)).toEqual([]);
    expect(steps(au.id)).toEqual([]);
    expect(h.waTo(PEOPLE.uk.phone).map((c) => c.templateName)).toEqual(['gp_link_consult_hello_5m']);
  });

  it('unset, the go-live instant is "now" the first time the job runs, recorded once and kept', async () => {
    delete process.env.AU_LEAD_COPY_LIVE_FROM;
    t.__resetAuLeadCopyLiveFromForTest();
    const before = lead('au3', {}, { created_at: new Date(Date.now() - 10 * M).toISOString() });
    h.seed([before]);
    const r1 = await h.cron(NUDGE);
    const live = r1.json.au.live_from;
    expect(Math.abs(Date.parse(live) - Date.now())).toBeLessThan(15000);
    expect(h.readLocalDb().auLeadCopyLiveFrom).toBe(live);
    expect(emailsTo(PEOPLE.au3.email)).toEqual([]);                  // they enquired before the first run
    // A later run keeps the same instant, and a lead who arrives after it is in.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const after = lead('au2', {}, { created_at: new Date(Date.now() + 1000).toISOString() });
    after.created_at = new Date(Date.parse(live) + 1).toISOString();
    after.metadata.consult.nudges = [];
    h.seed([before, after]);
    const r2 = await h.cron(NUDGE);
    expect(r2.json.au.live_from).toBe(live);
    // (not yet five minutes old, so nothing is due: the point is the instant did not move)
    expect(await t.auLeadCopyLiveFromMs()).toBe(Date.parse(live));
    t.__resetAuLeadCopyLiveFromForTest();
  });

  it('the booking-link email (a Meta lead), then the 5-minute note is not emailed on top of it', async () => {
    const au = lead('au', {}, { created_at: new Date(Date.now() - 6 * M).toISOString() });
    const uk = lead('uk', {}, { created_at: new Date(Date.now() - 6 * M).toISOString() });
    h.seed([au, uk]);
    const sentAu = await t.sendConsultMagicLinkEmail(au);
    await t.sendConsultMagicLinkEmail(uk);
    expect(sentAu.ok).toBe(true);
    const got = emailsTo(PEOPLE.au.email);
    expect(got.map((e) => e.subject)).toEqual(['Your GP Link call: pick a time that suits you']);
    expect(got[0].text).toContain('what you would want from your next practice: billing mix, location, hours and flexibility');
    expect(got[0].text).toContain('/start?lead=' + au.metadata.consult.token + '#book');
    expect(got[0].html).toContain('Unsubscribe from these emails');
    expect(emailsTo(PEOPLE.uk.email)[0].subject).toBe('Ready when you are, book your free GP Link call');
    expect(emailsTo(PEOPLE.uk.email)[0].text).toContain('registration, visas, timing and pay');
    expect(logOf(au.id)).toEqual(['email sent booking_link']);

    h.reset();
    await h.cron(NUDGE);
    expect(emailsTo(PEOPLE.au.email)).toEqual([]);
    expect(steps(au.id)).toEqual(['not_booked:0:none']);
    expect(logOf(au.id)).toEqual(['email sent booking_link', 'email skipped n01_5m (au_booking_link_just_sent)', 'whatsapp skipped n01_5m (au_template_not_approved)']);

    // The link with no personal token (Hazel's tool; she never rings an Australian lead) is Australian too.
    h.reset();
    const plain = lead('au2', { token: '' });
    h.seed([plain]);
    expect((await t.sendConsultGenericBookingLinkEmail(plain)).ok).toBe(true);
    const g = emailsTo(PEOPLE.au2.email)[0];
    expect(g.subject).toBe('Your GP Link call: pick a time that suits you');
    expect(g.text).not.toMatch(/on the phone/);
    expect(g.text).toContain('/start#book');
  }, 60000);
});

describe('quiet hours: 08:00 to 20:00 on the lead\'s own clock', () => {
  it('at 2 am in Sydney the note is DEFERRED (nothing sent, nothing marked); it goes on the next run inside the hours. The UK lead is not held.', async () => {
    const au = lead('au', {}, { created_at: new Date(Date.now() - 10 * M).toISOString() });
    const uk = lead('uk', {}, { created_at: new Date(Date.now() - 10 * M).toISOString() });
    h.seed([au, uk]);
    t.__setAuQuietHoursClockForTest(AU_NIGHT);
    for (let run = 0; run < 2; run++) {
      const r = await h.cron(NUDGE);
      expect(r.json.au.deferred_quiet_hours).toBe(1);
      expect(r.json.au.deferred[0]).toMatchObject({ lead_id: au.id, messageId: 'n01_5m', reason: 'quiet_hours', localTime: '02:00', zone: 'Australia/Sydney' });
    }
    expect(emailsTo(PEOPLE.au.email)).toEqual([]);
    expect(steps(au.id)).toEqual([]);
    expect(consultOf(au.id).au_log).toBeUndefined();
    // 3 pm in London: the UK lead's message went on the first run, at the hour it always would.
    expect(h.waTo(PEOPLE.uk.phone).map((c) => c.templateName)).toEqual(['gp_link_consult_hello_5m']);

    t.__setAuQuietHoursClockForTest(IN_HOURS);
    const r = await h.cron(NUDGE);
    expect(r.json.au.deferred_quiet_hours).toBe(0);
    expect(emailsTo(PEOPLE.au.email).map((e) => e.subject)).toEqual(['Thanks for getting in touch']);
    expect(steps(au.id)).toEqual(['not_booked:0:sent']);
  }, 60000);

  it('zone not known: 9 am Sydney could be 6 am Perth, so it waits; a lead whose state is known is not held', async () => {
    const unknown = lead('au', { state: undefined }, { created_at: new Date(Date.now() - 10 * M).toISOString() });
    delete unknown.metadata.consult.state;
    const nsw = lead('au2', { state: 'NSW' }, { created_at: new Date(Date.now() - 10 * M).toISOString() });
    h.seed([unknown, nsw]);
    t.__setAuQuietHoursClockForTest(SYDNEY_MORNING);
    const r = await h.cron(NUDGE);
    expect(r.json.au.deferred.map((d) => [d.lead_id, d.reason])).toEqual([[unknown.id, 'quiet_hours_zone_uncertain']]);
    expect(emailsTo(PEOPLE.au.email)).toEqual([]);
    expect(emailsTo(PEOPLE.au2.email).length).toBe(1);
  });

  it('a Perth lead is on Perth time: held at 23:00 Perth even though Sydney is asleep too, sent at 10:00 Perth', async () => {
    const wa = lead('au', { state: 'WA' }, { created_at: new Date(Date.now() - 10 * M).toISOString() });
    h.seed([wa]);
    t.__setAuQuietHoursClockForTest(Date.parse('2027-01-14T10:30:00Z'));   // 18:30 Perth, 21:30 Sydney
    await h.cron(NUDGE);
    expect(emailsTo(PEOPLE.au.email).length).toBe(1);                       // inside PERTH's hours
  });

  it('a later step is still due on its own clock after a deferral (the 1-hour note does not wait a second night)', async () => {
    // Enquired 3 hours ago, during the night: the 5-minute note was held.
    const au = lead('au', {}, { created_at: new Date(Date.now() - 3 * H).toISOString() });
    h.seed([au]);
    t.__setAuQuietHoursClockForTest(AU_NIGHT);
    await h.cron(NUDGE);
    expect(steps(au.id)).toEqual([]);
    // Morning: the 5-minute note goes first...
    t.__setAuQuietHoursClockForTest(IN_HOURS);
    await h.cron(NUDGE);
    expect(steps(au.id)).toEqual(['not_booked:0:sent']);
    // ...and the 1-hour note 40 minutes after it, not a day later.
    h.seed([backdateLastStep(au.id, 41 * M)]);
    await h.cron(NUDGE);
    expect(steps(au.id)).toEqual(['not_booked:0:sent', 'not_booked:1:sent']);
  }, 60000);
});

describe('N02 and N03: booked, attended, the drip', () => {
  function booked(who, over, minsAgo) {
    const at = new Date(Date.now() - (minsAgo || 3) * M).toISOString();
    return lead(who, Object.assign({ call_booked: true, call_booked_at: at, call_at: new Date(Date.now() + 2 * D).toISOString(), timezone: who === 'uk' ? undefined : 'Australia/Perth', timezone_source: who === 'uk' ? undefined : 'calendly' }, over || {}),
      { created_at: new Date(Date.now() - 2 * H).toISOString(), status: 'contacted' });
  }
  function attended(who, over) {
    const done = new Date(Date.now() - 5 * M).toISOString();
    return lead(who, Object.assign({
      call_booked: true, call_booked_at: new Date(Date.now() - 2 * D).toISOString(), call_at: new Date(Date.now() - 35 * M).toISOString(),
      call_completed_at: done, call_attended: true, call_attendance_source: 'zoom_participants',
      nudges: [{ seq: 'booked_no_signup', step: 0, sent_at: new Date(Date.now() - 2 * D).toISOString(), email: 'sent' }]
    }, over || {}), { created_at: new Date(Date.now() - 3 * D).toISOString(), status: 'contacted' });
  }

  it('"your call is booked": Australian wording, the time on their own clock, sent at any hour (they just booked)', async () => {
    const au = booked('au');
    const uk = booked('uk');
    h.seed([au, uk]);
    t.__setAuQuietHoursClockForTest(AU_NIGHT);        // a confirmation is not held within 30 minutes of the booking
    await h.cron(NUDGE);
    const got = emailsTo(PEOPLE.au.email);
    expect(got.length).toBe(1);
    expect(got[0].subject).toMatch(/^Your GP Link call is booked: .+ \(Perth time\)$/);
    const words = htmlToText(got[0].html);
    expect(words).toContain('You are booked in, Dr Auvr.');
    expect(words).toContain('billing mix (bulk, mixed or private), location, hours and flexibility');
    expect(words).toContain(auLeadCopy.CONFIDENTIALITY_LINE);
    ['Booked', 'Account · you are here', 'Matched', 'Interview', 'Start date'].forEach((s) => expect(words).toContain(s));
    expect(words).not.toMatch(/Guided registration|Working in Australia/);
    expect(got[0].text).toContain('Create my free account: ');
    expect(got[0].text).toContain('ref=nudge-t0');
    expect(got[0].html).toContain('Unsubscribe from these emails');
    expect(steps(au.id)).toEqual(['booked_no_signup:0:sent']);
    expect(emailsTo(PEOPLE.uk.email)[0].subject).toContain("you've done the hard part");
  }, 60000);

  it('a late "your call is booked" keeps quiet hours, and is never sent once the call time has passed', async () => {
    const late = booked('au', {}, 45);                 // booked 45 minutes ago, the job missed it
    h.seed([late]);
    t.__setAuQuietHoursClockForTest(Date.parse('2027-01-14T13:00:00Z'));   // 21:00 Perth
    let r = await h.cron(NUDGE);
    expect(r.json.au.deferred.map((d) => d.messageId)).toEqual(['n02_booked']);
    expect(emailsTo(PEOPLE.au.email)).toEqual([]);

    const passed = booked('au2', { call_at: new Date(Date.now() - 10 * M).toISOString() }, 45);
    h.seed([passed]);
    t.__setAuQuietHoursClockForTest(IN_HOURS);
    r = await h.cron(NUDGE);
    expect(emailsTo(PEOPLE.au2.email)).toEqual([]);
    expect(steps(passed.id)).toEqual(['booked_no_signup:0:superseded']);
    expect(logOf(passed.id)).toContain('email skipped n02_booked (au_call_already_passed)');
  });

  // CHANGED DELIBERATELY BY WP-18 (walk-findings T4): by default the after-the-call
  // WhatsApp now goes through the existing template, confirmed neutral
  // (tests/au-wp18-template-guard.test.js). The named skip is what the owner's
  // off switch gives, which this test sets first.
  it('after an attended call: the Australian account email; the post-call WhatsApp is skipped by name. The UK lead gets both of theirs.', async () => {
    process.env.AU_WHATSAPP_DISABLED_TEMPLATES = 'lead_post_call_onboard';
    const au = attended('au');
    const uk = attended('uk');
    h.seed([au, uk]);
    await h.cron(NUDGE);
    const got = emailsTo(PEOPLE.au.email);
    expect(got.map((e) => e.subject)).toEqual(['Good to speak with you, Dr Auvr: the next step']);
    expect(htmlToText(got[0].html)).toContain('so that we only bring you roles worth your time');
    expect(h.waTo(PEOPLE.au.phone)).toEqual([]);
    expect(steps(au.id)).toEqual(['booked_no_signup:0:sent', 'booked_no_signup:1:sent']);
    // The post-call WhatsApp pass waits 10 minutes after the call; give it them.
    const row = h.dbRow(au.id);
    row.metadata.consult.call_completed_at = new Date(Date.now() - 12 * M).toISOString();
    const ukRow = h.dbRow(uk.id);
    ukRow.metadata.consult.call_completed_at = new Date(Date.now() - 12 * M).toISOString();
    h.seed([row, ukRow]);
    h.reset();
    await h.cron(NUDGE);
    await h.cron(NUDGE);
    expect(h.waTo(PEOPLE.au.phone)).toEqual([]);
    expect(logOf(au.id)).toEqual(['email sent n03_after_call', 'whatsapp skipped n03_after_call (au_template_not_approved)']);
    expect(consultOf(au.id).wa_skipped).toBeUndefined();
    expect(h.waTo(PEOPLE.uk.phone).map((c) => c.templateName)).toEqual(['gp_link_consult_post_call_onboard_v3']);
  }, 60000);

  it('the weekly emails: the Australian journey, one a week; the overseas day-7 email ("AHPRA, AMC, visa") never reaches an Australian lead', async () => {
    const weekAgo = (days) => new Date(Date.now() - days * D - H).toISOString();
    const au = attended('au', {
      call_completed_at: weekAgo(7), call_at: weekAgo(7),
      nudges: [{ seq: 'booked_no_signup', step: 0, sent_at: weekAgo(9), email: 'sent' }, { seq: 'booked_no_signup', step: 1, sent_at: weekAgo(7), email: 'sent' }]
    }, { created_at: weekAgo(9) });
    const uk = attended('uk', JSON.parse(JSON.stringify(au.metadata.consult)));
    uk.metadata.consult.country = 'uk'; delete uk.metadata.consult.segment; delete uk.metadata.consult.ahpra_registered; delete uk.metadata.consult.state; delete uk.metadata.consult.vr_status;
    liveFrom(Date.now() - 30 * D);
    h.seed([au, uk]);
    await h.cron(NUDGE);
    let got = emailsTo(PEOPLE.au.email);
    expect(got.map((e) => e.subject)).toEqual(['What happens after you create your account']);
    expect(htmlToText(got[0].html)).not.toMatch(/AHPRA|AMC|roadmap|checklist/);
    expect(emailsTo(PEOPLE.uk.email).map((e) => e.subject)).toEqual(['Dr, your roadmap is built — and waiting on you']);
    expect(emailsTo(PEOPLE.uk.email)[0].html).toContain('AHPRA, AMC, visa');

    // Week 2, then week 3.
    const row = h.dbRow(au.id);
    row.metadata.consult.call_completed_at = weekAgo(14);
    row.metadata.consult.nudges[2].sent_at = weekAgo(7);
    h.seed([row]);
    h.reset();
    await h.cron(NUDGE);
    expect(emailsTo(PEOPLE.au.email).map((e) => e.subject)).toEqual(['How we match GPs to practices']);
    const row3 = h.dbRow(au.id);
    row3.metadata.consult.call_completed_at = weekAgo(21);
    row3.metadata.consult.nudges[3].sent_at = weekAgo(7);
    h.seed([row3]);
    h.reset();
    await h.cron(NUDGE);
    got = emailsTo(PEOPLE.au.email);
    expect(got.map((e) => e.subject)).toEqual(['Last note from me, Dr Auvr']);
    expect(steps(au.id).length).toBe(5);
  }, 60000);

  it('an Australian lead whose call ended BEFORE go-live is left alone (no after-call email, no weekly emails)', async () => {
    liveFrom(Date.now() - 2 * M);
    const au = attended('au3');                         // the call ended 5 minutes ago, go-live was 2 minutes ago
    h.seed([au]);
    await h.cron(NUDGE);
    await h.cron(NUDGE);
    expect(emailsTo(PEOPLE.au3.email)).toEqual([]);
    expect(steps(au.id)).toEqual(['booked_no_signup:0:sent']);
    expect(consultOf(au.id).au_log).toBeUndefined();
  });

  it('the moment a call ends (the Zoom hook): the same Australian email, once, the cron does not repeat it', async () => {
    const au = attended('au2', { nudges: [] });
    h.seed([au]);
    const res = await t.afterConsultCallCompleted({ meeting_kind: 'consultation', host_kind: 'ceo', invitee_email: PEOPLE.au2.email, scheduled_at: au.metadata.consult.call_at }, au.metadata.consult.call_completed_at);
    expect(res).toMatchObject({ step: 1, outcome: 'sent' });
    expect(emailsTo(PEOPLE.au2.email).map((e) => e.subject)).toEqual(['Good to speak with you, Dr Aunew: the next step']);
    h.reset();
    await h.cron(NUDGE);
    expect(emailsTo(PEOPLE.au2.email)).toEqual([]);
  }, 60000);
});

describe('the unlaunched segments: careful wording, and no matching emails', () => {
  ['au_restricted', 'au_non_vr', 'au_registrar'].forEach((segment) => {
    it(segment + ': the notes go in the careful wording; the weekly matching emails are recorded as skipped, not sent', async () => {
      const fresh = lead('au', { segment }, { created_at: new Date(Date.now() - 10 * M).toISOString() });
      h.seed([fresh]);
      await h.cron(NUDGE);
      let got = emailsTo(PEOPLE.au.email);
      expect(got.map((e) => e.subject)).toEqual(['Thanks for getting in touch']);
      expect(got[0].text).toContain("we'll talk through what fits your registration");
      expect(got[0].text + htmlToText(got[0].html)).not.toMatch(/better-fitting|\broles?\b|next practice/);

      // Attended a week ago: the week-1 email is about being matched to roles.
      const weekAgo = new Date(Date.now() - 7 * D - H).toISOString();
      const drip = lead('au2', {
        segment, call_booked: true, call_booked_at: new Date(Date.now() - 9 * D).toISOString(), call_at: weekAgo,
        call_completed_at: weekAgo, call_attended: true, call_attendance_source: 'zoom_participants',
        nudges: [{ seq: 'booked_no_signup', step: 0, sent_at: new Date(Date.now() - 9 * D).toISOString(), email: 'sent' }, { seq: 'booked_no_signup', step: 1, sent_at: weekAgo, email: 'sent' }]
      }, { created_at: new Date(Date.now() - 9 * D).toISOString() });
      liveFrom(Date.now() - 30 * D);
      h.seed([drip]);
      h.reset();
      await h.cron(NUDGE);
      expect(emailsTo(PEOPLE.au2.email)).toEqual([]);
      expect(steps(drip.id)).toEqual(['booked_no_signup:0:sent', 'booked_no_signup:1:sent', 'booked_no_signup:2:skipped']);
      expect(consultOf(drip.id).nudges[2]).toMatchObject({ au: 'n03_week1', au_skip: 'au_segment_not_launched' });
      expect(logOf(drip.id)).toEqual(['email skipped n03_week1 (au_segment_not_launched)']);
    }, 60000);
  });

  it('au_unknown (detail not known yet) reads the main wording', async () => {
    const au = lead('au', { segment: 'au_unknown', state: undefined, vr_status: undefined }, { created_at: new Date(Date.now() - 10 * M).toISOString() });
    h.seed([au]);
    await h.cron(NUDGE);
    expect(emailsTo(PEOPLE.au.email)[0].html).toContain('Looking for a better-fitting practice?');
  });
});

describe('a missed call', () => {
  function missed(who, over) {
    const slot = new Date(Math.floor((Date.now() - 2 * H) / M) * M).toISOString();
    return lead(who, Object.assign({
      call_booked: true, call_booked_at: new Date(Date.parse(slot) - D).toISOString(), call_at: slot,
      nudges: [{ seq: 'booked_no_signup', step: 0, sent_at: new Date(Date.parse(slot) - D).toISOString(), email: 'sent' }],
      no_show: { call_at: slot, detected_at: new Date(Date.parse(slot) + 40 * M).toISOString(), via: 'sweep', ring: 'pending' }
    }, over || {}), { created_at: new Date(Date.parse(slot) - 2 * D).toISOString(), status: 'contacted' });
  }

  // CHANGED DELIBERATELY BY WP-18 (walk-findings T4): by default the missed-call
  // WhatsApp now goes through the existing template, confirmed neutral. The
  // named skip is what the owner's off switch gives, which this test sets first.
  it('the Australian email, with the slot on their clock; the WhatsApp is skipped by name; the UK lead gets both of theirs', async () => {
    process.env.AU_WHATSAPP_DISABLED_TEMPLATES = 'lead_call_missed';
    const au = missed('au', { state: 'WA' });
    const uk = missed('uk');
    h.seed([au, uk]);
    await h.cron(NUDGE);
    const got = emailsTo(PEOPLE.au.email);
    expect(got.map((e) => e.subject)).toEqual(['Sorry we missed each other']);
    expect(got[0].text).toMatch(/I had our call in the diary for \w+ \d+ \w+ at \d+:\d\d [ap]m \(Perth time\) and it looks like we missed each other/);
    expect(got[0].text).toContain('talk through what you want from your next practice');
    expect(got[0].text).toContain(auLeadCopy.CONFIDENTIALITY_LINE);
    expect(got[0].text).toMatch(/Unsubscribe: /);
    expect(h.waTo(PEOPLE.au.phone)).toEqual([]);
    const m = consultOf(au.id).no_show;
    expect(m.email_at).toBeTruthy();
    expect(m.wa_at).toBeUndefined();
    expect(m.wa_tries).toBeUndefined();
    expect(logOf(au.id)).toEqual(['whatsapp skipped n02_noshow (au_template_not_approved)', 'email sent n02_noshow']);
    expect(emailsTo(PEOPLE.uk.email)[0].text).toContain('talk through the move to Australia');
    expect(h.waTo(PEOPLE.uk.phone).map((c) => c.templateName)).toEqual(['gp_link_consult_missed_call']);
    // Once: a second run sends nothing more.
    h.reset();
    await h.cron(NUDGE);
    expect(emailsTo(PEOPLE.au.email)).toEqual([]);
    expect(logOf(au.id).length).toBe(2);
  }, 60000);

  it('held at night, sent in the morning; never for a slot missed before go-live', async () => {
    const au = missed('au');
    h.seed([au]);
    t.__setAuQuietHoursClockForTest(AU_NIGHT);
    let r = await h.cron(NUDGE);
    expect(emailsTo(PEOPLE.au.email)).toEqual([]);
    expect(consultOf(au.id).no_show.email_at).toBeUndefined();
    expect(consultOf(au.id).no_show.email_tries).toBeUndefined();
    expect(r.json.au.deferred.map((d) => d.messageId)).toEqual(['n02_noshow']);
    t.__setAuQuietHoursClockForTest(IN_HOURS);
    await h.cron(NUDGE);
    expect(emailsTo(PEOPLE.au.email).length).toBe(1);

    liveFrom(Date.now() - 30 * M);                      // the slot (2 hours ago) is before go-live
    const old = missed('au3');
    h.seed([old]);
    r = await h.cron(NUDGE);
    expect(emailsTo(PEOPLE.au3.email)).toEqual([]);
    expect(consultOf(old.id).no_show.email_at).toBeUndefined();
    expect(consultOf(old.id).au_log).toBeUndefined();
  }, 60000);

  it('one automated message per run: the rescue goes first, the sequence step waits for the next run', async () => {
    const au = missed('au', { nudges: [] });           // "your call is booked" was never sent
    h.seed([au]);
    await h.cron(NUDGE);
    expect(emailsTo(PEOPLE.au.email).map((e) => e.subject)).toEqual(['Sorry we missed each other']);
    expect(steps(au.id)).toEqual([]);
    await h.cron(NUDGE);
    // Next run: the step is dealt with (the call has passed, so it is recorded, not sent).
    expect(steps(au.id)).toEqual(['booked_no_signup:0:superseded']);
    expect(emailsTo(PEOPLE.au.email).length).toBe(1);
  }, 60000);
});

describe('WhatsApp: an approved Australian template, or a named skip. Never an overseas template.', () => {
  const KINDS = {
    hello_5m: {}, check_in_1h: {}, day_after_24h: {},
    call_booked: { call_booked: true, call_at: new Date(Date.now() + D).toISOString() },
    signed_up: { stopped: 'signed_up' },
    onboarding_incomplete: { stopped: 'signed_up' },
    post_call_onboard: { call_booked: true, call_at: new Date(Date.now() - H).toISOString(), call_completed_at: new Date(Date.now() - 30 * M).toISOString(), call_attended: true, call_attendance_source: 'zoom_participants' }
  };
  const AU_TEMPLATE = {
    hello_5m: 'gp_link_au_lead_hello', check_in_1h: 'gp_link_au_lead_check_in', day_after_24h: 'gp_link_au_lead_last_note',
    call_booked: 'gp_link_au_lead_call_booked', signed_up: 'gp_link_au_lead_signup_welcome',
    // CHANGED DELIBERATELY BY WP-18 (walk-findings T4): these two rows now
    // reuse the existing templates, confirmed neutral, and are on by default.
    onboarding_incomplete: 'gp_link_consult_onboarding_nudge', post_call_onboard: 'gp_link_consult_post_call_onboard_v3'
  };
  const REUSED = { onboarding_incomplete: true, post_call_onboard: true };
  Object.keys(KINDS).forEach((kind) => {
    it(kind + ': skipped with the reason on the lead; with the template approved it goes through ' + AU_TEMPLATE[kind], async () => {
      const au = lead('au', Object.assign({ timezone: 'Australia/Adelaide', timezone_source: 'calendly' }, KINDS[kind]));
      const uk = lead('uk', KINDS[kind]);
      h.seed([au, uk]);
      // (WP-18) A reused row is on by default: the skip half of this test is
      // the owner having switched it off.
      if (REUSED[kind]) process.env.AU_WHATSAPP_DISABLED_TEMPLATES = 'lead_' + kind;
      expect(await t.maybeSendConsultWa(au, kind)).toEqual({ ok: false, skipped: true, reason: 'au_template_not_approved' });
      expect(await t.maybeSendConsultWa(au, kind)).toEqual({ ok: false, skipped: true, reason: 'au_template_not_approved' });
      expect(h.waTo(PEOPLE.au.phone)).toEqual([]);
      const skips = (consultOf(au.id).au_log || []).filter((e) => e.out === 'skipped');
      expect(skips.length).toBe(1);                                      // recorded once, however often it is asked
      expect(skips[0]).toMatchObject({ ch: 'whatsapp', why: 'au_template_not_approved', key: kind });
      expect(consultOf(au.id).wa).toBeUndefined();
      // The UK lead: the overseas template, as ever.
      expect((await t.maybeSendConsultWa(uk, kind)).ok).toBe(true);
      const ukSent = h.waTo(PEOPLE.uk.phone);
      expect(ukSent.length).toBe(1);
      expect(ukSent[0].templateName).toMatch(/^gp_link_consult_/);

      // The owner has the Australian template approved and marks it.
      delete process.env.AU_WHATSAPP_DISABLED_TEMPLATES;
      process.env.AU_WHATSAPP_APPROVED_TEMPLATES = 'lead_' + kind;
      const fresh = h.dbRow(au.id);
      expect((await t.maybeSendConsultWa(fresh, kind)).ok).toBe(true);
      const auSent = h.waTo(PEOPLE.au.phone);
      expect(auSent.map((c) => c.templateName)).toEqual([AU_TEMPLATE[kind]]);
      expect(auSent[0].templateData.body.placeholders.length).toBe(ukSent[0].templateData.body.placeholders.length);
      expect(forbiddenIn(auSent[0].templateData.body.placeholders.join('\n'))).toEqual([]);
      if (kind === 'call_booked') expect(auSent[0].templateData.body.placeholders[1]).toMatch(/\(Adelaide time\)$/);
      expect(consultOf(au.id).wa[kind]).toBeTruthy();
      expect((consultOf(au.id).au_log || []).filter((e) => e.out === 'sent' && e.ch === 'whatsapp').length).toBe(1);
      // Marker-guarded: never twice.
      expect((await t.maybeSendConsultWa(h.dbRow(au.id), kind)).reason).toBe('not_eligible');
    }, 60000);
  });

  it('through the job: with the 1-hour template approved the note goes by email AND WhatsApp, both Australian', async () => {
    process.env.AU_WHATSAPP_APPROVED_TEMPLATES = 'gp_link_au_lead_check_in';
    const sentAt = new Date(Date.now() - 80 * M).toISOString();
    const au = lead('au', { nudges: [{ seq: 'not_booked', step: 0, sent_at: sentAt, email: 'sent', au: 'n01_5m' }] }, { created_at: new Date(Date.now() - 85 * M).toISOString() });
    h.seed([au]);
    await h.cron(NUDGE);
    expect(emailsTo(PEOPLE.au.email).map((e) => e.subject)).toEqual(['A quick one from me at GP Link']);
    const wa = h.waTo(PEOPLE.au.phone);
    expect(wa.map((c) => c.templateName)).toEqual(['gp_link_au_lead_check_in']);
    expect(wa[0].templateData.body.placeholders[1]).toContain('/start?lead=' + au.metadata.consult.token + '#book');
    expect(logOf(au.id)).toEqual(['email sent n01_1h', 'whatsapp sent n01_1h']);
  }, 60000);

  it('approved, but the lead is in quiet hours: the owed WhatsApp waits too', async () => {
    process.env.AU_WHATSAPP_APPROVED_TEMPLATES = 'lead_check_in_1h';
    const sentAt = new Date(Date.now() - 20 * M).toISOString();
    // The 1-hour step is on record (its email went) and its WhatsApp leg is owed.
    const au = lead('au', { nudges: [{ seq: 'not_booked', step: 0, sent_at: new Date(Date.now() - 90 * M).toISOString(), email: 'sent' }, { seq: 'not_booked', step: 1, sent_at: sentAt, email: 'sent' }] },
      { created_at: new Date(Date.now() - 95 * M).toISOString() });
    h.seed([au]);
    t.__setAuQuietHoursClockForTest(AU_NIGHT);
    await h.cron(NUDGE);
    expect(h.waTo(PEOPLE.au.phone)).toEqual([]);
    t.__setAuQuietHoursClockForTest(IN_HOURS);
    await h.cron(NUDGE);
    expect(h.waTo(PEOPLE.au.phone).map((c) => c.templateName)).toEqual(['gp_link_au_lead_check_in']);
  }, 60000);
});

describe('the Leads tab: what was sent, what was skipped and why', () => {
  it('the drawer lists the lead\'s own record in plain words; an old lead is marked for a personal follow-up', async () => {
    liveFrom(Date.now() - 1 * H);
    const fresh = lead('au', {}, { created_at: new Date(Date.now() - 10 * M).toISOString() });
    const old = lead('au3', {}, { created_at: new Date(Date.now() - 3 * H).toISOString() });
    const uk = lead('uk', {}, { created_at: new Date(Date.now() - 10 * M).toISOString() });
    h.seed([fresh, old, uk]);
    await h.cron(NUDGE);

    const admin = h.superAdmin();
    const list = await h.get('/api/ceo/leads?seg=au', admin);
    expect(list.status).toBe(200);
    const byId = {}; list.json.leads.forEach((l) => { byId[l.id] = l; });
    expect(byId[fresh.id]).toMatchObject({ au_copy_state: 'live', au_copy_note: '' });
    expect(byId[old.id]).toMatchObject({ au_copy_state: 'before_go_live', au_copy_note: 'Before go-live: follow up personally' });

    const one = await h.get('/api/ceo/leads/' + encodeURIComponent(fresh.id), admin);
    expect(one.json.chase.au.state).toBe('live');
    expect(one.json.chase.au.items.map((x) => x.text)).toEqual([
      'WhatsApp skipped: no approved Australian template (5-minute note)',
      'Email sent: 5-minute note'
    ]);
    const oldOne = await h.get('/api/ceo/leads/' + encodeURIComponent(old.id), admin);
    expect(oldOne.json.chase.au).toMatchObject({ state: 'before_go_live', items: [] });
    expect(oldOne.json.chase.au.note).toMatch(/enquired before Australian messages went live.+follow up personally/);
    // An overseas lead's drawer is what it was.
    const ukOne = await h.get('/api/ceo/leads/' + encodeURIComponent(uk.id), admin);
    expect(ukOne.json.chase.au).toBeUndefined();
    expect(Object.keys(ukOne.json.chase)).toEqual(['nudges', 'whatsapp']);
    const all = await h.get('/api/ceo/leads', admin);
    const ukRow = all.json.leads.find((l) => l.id === uk.id);
    expect(ukRow.au_copy_state).toBeUndefined();
    expect(ukRow.au_copy_note).toBeUndefined();
  }, 60000);

  it('switch OFF: no Australian keys anywhere, and the Australian-segment lead is chased like any other', async () => {
    h.setSwitch(false);
    const au = lead('au', {}, { created_at: new Date(Date.now() - 80 * M).toISOString() });
    au.metadata.consult.nudges = [{ seq: 'not_booked', step: 0, sent_at: new Date(Date.now() - 75 * M).toISOString(), email: 'none' }];
    au.metadata.consult.wa = { hello_5m: { sent_at: new Date(Date.now() - 75 * M).toISOString() } };
    h.seed([au]);
    t.__setAuQuietHoursClockForTest(AU_NIGHT);          // no quiet hours with the switch off
    const r = await h.cron(NUDGE);
    expect(r.json.au).toBeUndefined();
    const got = h.emailsTo(PEOPLE.au.email);
    expect(got.map((e) => e.subject)).toEqual(['Quick one from me at GP Link']);       // the overseas note, as on main
    expect(h.waTo(PEOPLE.au.phone).map((c) => c.templateName)).toEqual(['gp_link_consult_check_in_1h']);
    expect(consultOf(au.id).au_log).toBeUndefined();
    const admin = h.superAdmin();
    const one = await h.get('/api/ceo/leads/' + encodeURIComponent(au.id), admin);
    expect(Object.keys(one.json.chase)).toEqual(['nudges', 'whatsapp']);
    expect(one.json.lead.au_copy_state).toBeUndefined();
    expect(h.readLocalDb().auLeadCopyLiveFrom).toBeUndefined();
  }, 60000);
});

describe('Hazel still never rings an Australian-segment lead (both switch states)', () => {
  it('leadCallDecision refuses every Australian segment with au_segment, whatever the switch says', () => {
    const cfg = leadCalls.parseLeadCallConfig({ LEAD_CALLS_ENABLED: 'true', RETELL_API_KEY: 'k', RETELL_AGENT_ID: 'a', RETELL_FROM_NUMBER_AU: '+61280000000', RETELL_FROM_NUMBER_UK: '+442030000000', LEAD_CALLS_IGNORE_HOURS: 'true', NODE_ENV: 'test' });
    ['au_vr', 'au_unknown', 'au_restricted', 'au_non_vr', 'au_registrar'].forEach((segment) => {
      [true, false].forEach((on) => {
        const row = lead('au', { segment });
        const d = leadCalls.leadCallDecision({ row, nowMs: Date.now(), config: cfg, auPathwayEnabled: on });
        expect(d.action, segment + ' switch ' + on).toBe('skip');
        expect(d.reason, segment + ' switch ' + on).toBe('au_segment');
      });
    });
  });
});

describe('every email that reached an Australian doctor in this file', () => {
  it('carries no "move", "visa", "relocat", "UK", no section 4 word, no dollar sign and no percentage', () => {
    expect(auEmailsSeen.length).toBeGreaterThan(20);
    const subjects = {};
    auEmailsSeen.forEach((e) => {
      subjects[e.subject.replace(/Dr \w+/g, 'Dr X').replace(/: .+ time\)$/, ': WHEN')] = true;
      const words = [e.subject, htmlToText(e.html), e.text].join('\n');
      expect(forbiddenIn(words), e.subject + '\n' + words).toEqual([]);
      expect(String(e.html)).toContain('GP Link');
    });
    // The file exercised every email in the table that this server mode can send.
    ['Thanks for getting in touch', 'A quick one from me at GP Link', 'Last note from me', 'Your GP Link call: pick a time that suits you',
      'Your GP Link call is booked: WHEN', 'Good to speak with you, Dr X: the next step', 'What happens after you create your account',
      'How we match GPs to practices', 'Last note from me, Dr X', 'Sorry we missed each other'].forEach((s) => expect(Object.keys(subjects), s).toContain(s));
  });
});

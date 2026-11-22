// WP-10 (Australian GP build), the DOCTOR and PRACTICE side, end to end
// against the real server and the in-memory database stub.
//
//   - A Perth GP sees Perth times in every interview message; the Sydney
//     practice on the other side of the same interview sees Sydney times.
//   - Interviews for a candidate on an Australian pathway are offered in the
//     practice's business hours (9 to 11 am Sydney now included, weekends
//     excluded); a submitted time outside them is refused by the server.
//   - The interview-times request to the practice has neutral wording.
//   - The doctor's time zone is stored on the profile (onboarding, the slot
//     picker's device zone, a state staff set).
//   - The practice-reminder weekend skip uses the practice's own day with the
//     switch on, and the UTC day with it off.
//   - Overseas doctors: identical with the switch on and off, and no new
//     column is read with the switch off.
//
// The clock is pinned (Date only) so the slot maths is exact: "now" is Monday
// 23 November 2026, 11:00 am in Sydney (daylight time, UTC+11) and 8:00 am in
// Perth (UTC+8).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildAuDoctor, WP02_NEW_COLUMN_NAMES, WP02_NEW_TABLES } = require('./helpers/au-fixtures.js');
const { wp02NewNameViolation } = require('./helpers/au-supabase-emulator.js');
const rigLib = require('./helpers/au-wp09-intro-rig.js');
const consent = require('../lib/profile-share-consent.js');
const interviewMeetings = require('../lib/interview-meetings.js');
const interviewScheduler = require('../lib/interview-scheduler.js');
const auTimezone = require('../lib/au-timezone.js');

const NOW = '2026-11-23T00:00:00.000Z';
const SEED = '2026-11-01T00:00:00.000Z';
const STAFF = 'staff.test@gplink-test.local';
const VERIFIED_C = { staff_verified_at: SEED, staff_verified_by: STAFF };
const VERIFIED_P = { register_status: 'verified', register_body: 'ahpra', register_number: 'MED0001000001' };
const NAMES = { columns: WP02_NEW_COLUMN_NAMES, tables: WP02_NEW_TABLES };

const au = (suffix, profile) => buildAuDoctor('au_vr', {
  idSuffix: suffix, credentials: VERIFIED_C,
  profile: Object.assign({}, VERIFIED_P, { timezone: null, phone: '+6140000' + String(1000 + Number(suffix)) }, profile)
});
const blank = (suffix) => buildAuDoctor('overseas_null', {
  idSuffix: 'n' + suffix, noCase: true,
  profile: {
    registration_country: '', qualification_country: '', preferred_city: '', target_arrival_date: '', who_moving: '',
    children_count: '', gmc_number: '', register_body: null, register_number: null, register_status: null, onboarding_completed_at: null
  }
});

const DOCTORS = {
  // Perth GP, Sydney practice: the pair the acceptance is about.
  wa: au('1', { current_state: 'WA' }),
  wa_staff_booked: au('2', { current_state: 'WA' }),
  wa_refused: au('3', { current_state: 'WA' }),
  wa_reminder: au('4', { current_state: 'WA' }),
  wa_default: au('5', { current_state: 'WA' }),
  nsw: au('6', { current_state: 'NSW' }),
  wa_ask: au('7', { current_state: 'WA' }),
  wa_weekend: au('8', { current_state: 'WA' }),
  // overseas: nothing may change for these
  uk: buildAuDoctor('overseas_null'),
  uk_ask: buildAuDoctor('overseas_null', { idSuffix: '2' }),
  uk_weekend: buildAuDoctor('overseas_null', { idSuffix: '3' }),
  uk_twin: buildAuDoctor('overseas_null', { idSuffix: '4' }),
  ie: buildAuDoctor('overseas_explicit'),
  // onboarding
  onb_perth: blank('1'), onb_state_only: blank('2'), onb_bad_zone: blank('3'), onb_overseas: blank('4'), onb_off: blank('5')
};

let rig;
let ipSeq = 0;
const rows = (name) => rig.emu.table(name);
const profileOf = (d) => rows('user_profiles').filter((r) => r.user_id === d.userId)[0];
const appOf = (d) => rows('gp_applications').filter((r) => r.id === rig.appIdFor(d))[0];
const interviewOf = (d) => rows('scheduled_calls').filter((r) => r.application_id === rig.appIdFor(d) && r.status !== 'cancelled')[0];
const cookie = (d) => rig.gpCookie(d.email, d.userId);
const consentPatch = () => consent.buildConsentPatch({ source: 'doctor', application: { career_role_id: rigLib.ROLE_ID }, by: STAFF, now: SEED });
function ip() {
  ipSeq += 1;
  const a = '10.30.' + Math.floor(ipSeq / 250) + '.' + (ipSeq % 250 + 1);
  return { headers: { 'x-real-ip': a, 'x-forwarded-for': a } };
}
const emailsTo = (list, addr) => list.filter((e) => [].concat(e.to || []).indexOf(addr) !== -1);
const textOf = (e) => [e.subject, e.text, e.html].join('\n');

/** Staff introduce the doctor to the practice (consent on file for an Australian doctor). */
async function introduce(d) {
  rig.resetApplication(d, d.expected.isAu ? consentPatch() : {});
  rows('scheduled_calls').forEach((r) => { if (r.application_id === rig.appIdFor(d)) r.status = 'cancelled'; });
  const out = await rig.introduce(d, { decision: false });
  expect(out.status, JSON.stringify(out.json)).toBe(200);
  return out;
}
async function decisionContext(d) {
  return rig.get('/api/practice/application/decision-context?token=' + encodeURIComponent(rig.tokenFor(d)), ip());
}
async function approve(d, windows, viewerTz) {
  return rig.post('/api/practice/application/decision', { token: rig.tokenFor(d), action: 'approve', windows, viewer_tz: viewerTz }, ip());
}
async function gpSlots(d, viewerTz) {
  return rig.get('/api/career/interview/slots?applicationId=' + encodeURIComponent(rig.appIdFor(d)) + (viewerTz ? '&viewer_tz=' + encodeURIComponent(viewerTz) : ''), { cookie: cookie(d) });
}
async function gpBook(d, startUtc, viewerTz) {
  return rig.post('/api/career/interview/book', { applicationId: rig.appIdFor(d), slot_start_utc: startUtc, viewer_tz: viewerTz }, { cookie: cookie(d) });
}
const inZone = (iso, zone) => auTimezone.clockIn(zone, Date.parse(iso));
/** Empty the owner's diary: every interview so far is cancelled, so nothing blocks a slot. */
function clearDiary() {
  rows('scheduled_calls').forEach((r) => { r.status = 'cancelled'; });
}
/** Wait (real time; only Date is pinned) for something sent after the response. */
async function waitFor(check, ms) {
  const until = process.hrtime.bigint() + BigInt((ms || 3000) * 1e6);
  while (process.hrtime.bigint() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}

// Thursday 26 and Friday 27 November 2026, as the practice would type them.
const THU_9_TO_11 = { date: '2026-11-26', fromMin: 540, toMin: 660 };
const FRI_5_TO_730 = { date: '2026-11-27', fromMin: 1020, toMin: 1170 };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  const list = Object.keys(DOCTORS).map((k) => DOCTORS[k]);
  rig = await rigLib.bootIntroRig({
    name: 'wp10-interviews',
    doctors: list,
    tables: {
      user_documents: list.map((d) => ({
        id: 'cv-' + d.userId, user_id: d.userId, document_key: 'career_cv', status: 'uploaded', file_name: 'cv.pdf',
        country_code: 'AU', created_at: SEED, updated_at: SEED
      })),
      placements: [], candidate_leads: [], runtime_kv: [], rate_limits: [], gp_nudge_log: [], user_roles: [],
      career_suburb_geo_cache: [], match_cache: [], career_contracts: [], onboarding_reminders: [], pep_waitlist: [],
      cron_runs: [], notifications: [], user_notifications: [], doubletick_messages: [], email_suppression: []
    }
  });
  rig.setSwitch(true);
}, 60000);

afterAll(async () => {
  delete process.env.AU_WHATSAPP_APPROVED_TEMPLATES;
  if (rig) await rig.close();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.setSystemTime(new Date(NOW));
  rig.setSwitch(true);
  rig.emu.missingColumns = {};
  rig.emu.forbid(null);
  // Changed deliberately by WP-17: an Australian doctor's interview WhatsApp
  // now goes only through its approved Australian template (the existing
  // template's fixed wording is held by DoubleTick and has not been confirmed
  // neutral). None is approved by default, so every test here starts with the
  // two interview rows approved, to keep proving what this file is here to
  // prove: the time the doctor is told. (It used to start with nothing set.)
  process.env.AU_WHATSAPP_APPROVED_TEMPLATES = 'interview_confirmed,interview_times_ready';
  delete process.env.PRACTICE_REMINDER_SKIP_WEEKENDS;
});
afterEach(() => { rig.emu.forbid(null); });

describe('DAT-22 / COM-19: the practice chooses interview times for a candidate on an Australian pathway', () => {
  it('the decision page is told the business hours for an Australian candidate, and nothing new for an overseas one', async () => {
    await introduce(DOCTORS.wa);
    const auCtx = await decisionContext(DOCTORS.wa);
    expect(auCtx.status).toBe(200);
    expect(auCtx.json.candidate.interviewWindow).toEqual({
      fromMin: 480, toMin: 1170, weekdaysOnly: true, practiceTz: 'Australia/Sydney', practiceTzLabel: 'Sydney time',
      note: 'Interviews are offered Monday to Friday, 8:00 am to 7:30 pm (Sydney time).'
    });
    await introduce(DOCTORS.uk);
    const ukCtx = await decisionContext(DOCTORS.uk);
    expect(ukCtx.status).toBe(200);
    expect(Object.keys(ukCtx.json.candidate).sort()).toEqual(['facts', 'hasCv', 'paragraph', 'recommendation']);
    rig.setSwitch(false);
    const offCtx = await decisionContext(DOCTORS.wa);
    expect(offCtx.json.candidate.interviewWindow).toBeUndefined();
  });

  it.each([
    ['a Saturday', [{ date: '2026-11-28', fromMin: 540, toMin: 660 }], 'Australia/Sydney'],
    ['a Sunday', [{ date: '2026-11-29', fromMin: 600, toMin: 720 }], 'Australia/Sydney'],
    ['before 8:00 am', [{ date: '2026-11-26', fromMin: 420, toMin: 540 }], 'Australia/Sydney'],
    ['running past 7:30 pm', [{ date: '2026-11-26', fromMin: 1080, toMin: 1260 }], 'Australia/Sydney'],
    ['9:00 pm, the old UK-evening kind of slot', [{ date: '2026-11-26', fromMin: 1260, toMin: 1320 }], 'Australia/Sydney'],
    ['one good time and one bad one', [THU_9_TO_11, { date: '2026-11-28', fromMin: 540, toMin: 660 }], 'Australia/Sydney'],
    ['5:00 pm typed on a device set to Perth time (8:00 pm at the Sydney practice)', [{ date: '2026-11-26', fromMin: 1020, toMin: 1080 }], 'Australia/Perth']
  ])('server-side validation refuses %s, and nothing is written', async (_label, windows, viewerTz) => {
    await introduce(DOCTORS.wa_refused);
    const res = await approve(DOCTORS.wa_refused, windows, viewerTz);
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('windows_outside_hours');
    expect(res.json.message).toMatch(/^Interview times need to be Monday to Friday, 8:00 am to 7:30 pm \(Sydney time\)\. Please adjust the time on 2026-11-2\d\.$/);
    expect(appOf(DOCTORS.wa_refused).practice_decision).toBeNull();
    expect(interviewOf(DOCTORS.wa_refused)).toBeUndefined();
  });

  it('the same out-of-hours times are still accepted for an overseas candidate, exactly as before', async () => {
    await introduce(DOCTORS.ie);
    const res = await approve(DOCTORS.ie, [{ date: '2026-11-28', fromMin: 540, toMin: 660 }, { date: '2026-11-26', fromMin: 1260, toMin: 1320 }], 'Australia/Sydney');
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(appOf(DOCTORS.ie).practice_decision).toBe('approved');
    expect(interviewOf(DOCTORS.ie).practice_availability_windows).toHaveLength(2);
  });

  it('a later "add more times" submission is checked the same way', async () => {
    await introduce(DOCTORS.wa_refused);
    expect((await approve(DOCTORS.wa_refused, [THU_9_TO_11], 'Australia/Sydney')).status).toBe(200);
    const bad = await rig.post('/api/practice/application/availability', { token: rig.tokenFor(DOCTORS.wa_refused), windows: [{ date: '2026-11-28', fromMin: 540, toMin: 660 }], viewer_tz: 'Australia/Sydney' }, ip());
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('windows_outside_hours');
    expect(interviewOf(DOCTORS.wa_refused).practice_availability_windows).toEqual([{ date: '2026-11-26', fromMin: 540, toMin: 660, tz: 'Australia/Sydney' }]);
    const good = await rig.post('/api/practice/application/availability', { token: rig.tokenFor(DOCTORS.wa_refused), windows: [FRI_5_TO_730], viewer_tz: 'Australia/Sydney' }, ip());
    expect(good.status, JSON.stringify(good.json)).toBe(200);
  });
});

describe('a Perth GP and a Sydney practice: each side sees its own local time, everywhere', () => {
  let slots;
  let booked;
  let sent;

  it('9 to 11 am Sydney is accepted from the practice (it used to produce no slots at all)', async () => {
    await introduce(DOCTORS.wa);
    const e0 = rig.emails.length;
    const res = await approve(DOCTORS.wa, [THU_9_TO_11, FRI_5_TO_730], 'Australia/Sydney');
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(appOf(DOCTORS.wa).practice_decision).toBe('approved');
    expect(interviewOf(DOCTORS.wa)).toMatchObject({ practice_availability_status: 'received', status: 'invited' });
    // the "your interview times are ready" email carries no time at all
    const invite = emailsTo(rig.emails.slice(e0), DOCTORS.wa.email);
    invite.forEach((e) => expect(textOf(e)).not.toMatch(/AEDT|AEST|Sydney time|UK time|GMT/));
  });

  it('the doctor is offered the practice times that fall in their own day, labelled in Perth time', async () => {
    const res = await gpSlots(DOCTORS.wa, 'Australia/Perth');
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    slots = res.json.slots;
    // Thursday 9 to 11 am Sydney is 6 to 8 am in Perth: only 7:00 and 7:30 Perth
    // (10:00 and 10:30 Sydney) are inside the doctor's day. Friday 5:00 to
    // 7:30 pm Sydney is 2:00 to 4:30 pm in Perth: all five.
    expect(slots.map((s) => s.startUtc)).toEqual([
      '2026-11-25T23:00:00.000Z', '2026-11-25T23:30:00.000Z',
      '2026-11-27T06:00:00.000Z', '2026-11-27T06:30:00.000Z', '2026-11-27T07:00:00.000Z', '2026-11-27T07:30:00.000Z', '2026-11-27T08:00:00.000Z'
    ]);
    expect(slots[0].local.gp).toEqual({ tz: 'Australia/Perth', label: 'Thu 26 Nov, 7:00 am' });
    expect(slots[0].local.practice).toEqual({ tz: 'Australia/Sydney', label: 'Thu 26 Nov, 10:00 am' });
    expect(slots[6].local.gp).toEqual({ tz: 'Australia/Perth', label: 'Fri 27 Nov, 4:00 pm' });
    expect(slots[6].local.practice).toEqual({ tz: 'Australia/Sydney', label: 'Fri 27 Nov, 7:00 pm' });
    for (const s of slots) {
      expect(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).toContain(inZone(s.startUtc, 'Australia/Sydney').weekday);
      expect(inZone(s.startUtc, 'Australia/Sydney').minutes).toBeGreaterThanOrEqual(480);
      expect(inZone(s.startUtc, 'Australia/Sydney').minutes + 30).toBeLessThanOrEqual(1170);
      expect(inZone(s.startUtc, 'Australia/Perth').minutes).toBeGreaterThanOrEqual(420);
    }
  });

  it('with no device zone at all the state on the profile gives the same Perth answer (it used to be Sydney)', async () => {
    rig.emu.table('scheduled_calls').forEach((r) => { if (r.application_id === rig.appIdFor(DOCTORS.wa)) r.timezone = null; });
    const res = await rig.get('/api/ats/interview/slots?application_id=' + encodeURIComponent(rig.appIdFor(DOCTORS.wa)), rig.superAdmin());
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.slots.map((s) => s.startUtc)).toEqual(slots.map((s) => s.startUtc));
    expect(res.json.slots[0].local.gp.tz).toBe('Australia/Perth');
    expect(res.json.slots[0].local.host.tz).toBe('Australia/Sydney');
  });

  it('a time outside the offered ones is refused when submitted (server-side validation of the pick)', async () => {
    // Thursday 9:00 am Sydney is inside the practice window but 6:00 am in Perth.
    const early = await gpBook(DOCTORS.wa, '2026-11-25T22:00:00.000Z', 'Australia/Perth');
    expect(early.status).toBe(409);
    // Friday 7:30 pm Sydney would end after the close.
    const late = await gpBook(DOCTORS.wa, '2026-11-27T08:30:00.000Z', 'Australia/Perth');
    expect(late.status).toBe(409);
    // A Saturday.
    const weekend = await gpBook(DOCTORS.wa, '2026-11-28T00:00:00.000Z', 'Australia/Perth');
    expect(weekend.status).toBe(409);
    expect(interviewOf(DOCTORS.wa).status).toBe('invited');
  });

  it('booking: the confirmation to the doctor says Perth time, the one to the practice says Sydney time', async () => {
    const e0 = rig.emails.length;
    const w0 = rig.whatsapps.length;
    const res = await gpBook(DOCTORS.wa, slots[0].startUtc, 'Australia/Perth');
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    booked = interviewOf(DOCTORS.wa);
    expect(booked).toMatchObject({ status: 'booked', scheduled_at: '2026-11-25T23:00:00.000Z', timezone: 'Australia/Perth' });
    sent = { emails: rig.emails.slice(e0), whatsapps: rig.whatsapps.slice(w0) };

    const toGp = emailsTo(sent.emails, DOCTORS.wa.email);
    expect(toGp).toHaveLength(1);
    expect(toGp[0].subject).toBe('Your interview is confirmed 🎉');
    expect(toGp[0].text).toContain('is confirmed for Thursday 26 November at 7:00 am AWST.');
    expect(toGp[0].html).toContain('<strong>Thursday 26 November at 7:00 am AWST</strong>');
    expect(textOf(toGp[0])).not.toMatch(/AEDT|AEST|10:00 am|UK time|GMT/);

    const toPractice = emailsTo(sent.emails, rigLib.PRACTICE_EMAIL);
    expect(toPractice).toHaveLength(1);
    expect(toPractice[0].text).toContain('is confirmed for Thursday 26 November at 10:00 am AEDT.');
    expect(textOf(toPractice[0])).not.toMatch(/AWST|7:00 am|UK time|GMT/);
  });

  it('the calendar invite both sides receive is the same instant (UTC), so each calendar shows its own local time', async () => {
    const withIcs = sent.emails.filter((e) => Array.isArray(e.attachments) && e.attachments.length);
    expect(withIcs.length).toBeGreaterThanOrEqual(2);
    const ics = withIcs.map((e) => Buffer.from(String(e.attachments[0].content), 'base64').toString('utf8'));
    for (const body of ics) {
      expect(body).toContain('DTSTART:20261125T230000Z');
      expect(body).toContain('DTEND:20261125T233000Z');
      expect(body).not.toMatch(/TZID=/);
    }
    const toGp = emailsTo(sent.emails, DOCTORS.wa.email)[0];
    expect(toGp.html).toContain('dates=20261125T230000Z');
  });

  it('WhatsApp: anything sent to the doctor carries the Perth time, never the Sydney one', async () => {
    await waitFor(() => rig.whatsapps.length > 0, 1500);
    const digits = (v) => String(v || '').replace(/\D/g, '');
    const toNumber = (w) => digits(w && w.messages && w.messages[0] && w.messages[0].to);
    const slots = (w) => ((((w.messages[0] || {}).content || {}).templateData || {}).body || {}).placeholders || [];
    const all = rig.whatsapps.filter((w) => JSON.stringify(w).indexOf('Thursday 26 November') !== -1);
    const toGp = all.filter((w) => toNumber(w) === digits(DOCTORS.wa.profile.phone));
    const toPractice = all.filter((w) => toNumber(w) === digits(rigLib.PRACTICE_PHONE));
    // the doctor's confirmation template: [first name, practice, WHEN, join link]
    expect(toGp).toHaveLength(1);
    expect(toGp[0].messages[0].content.templateName).toBe('gp_link_au_interview_confirmed');   // the Australian row, never the existing template
    expect(slots(toGp[0])[2]).toBe('Thursday 26 November at 7:00 am AWST');
    expect(JSON.stringify(toGp[0])).not.toMatch(/AEDT|10:00 am/);
    // the practice contact's copy is on the practice's clock
    expect(toPractice).toHaveLength(1);
    expect(JSON.stringify(toPractice[0])).toContain('Thursday 26 November at 10:00 am AEDT');
    expect(JSON.stringify(toPractice[0])).not.toMatch(/AWST|7:00 am/);
  });

  it('the reminders: the doctor is reminded in Perth time and the practice in Sydney time', async () => {
    vi.setSystemTime(new Date('2026-11-25T03:00:00.000Z')); // 20 hours before
    const e0 = rig.emails.length;
    const res = await rig.get('/api/cron/interview-reminders', { headers: { Authorization: 'Bearer test-cron-secret' } });
    expect(res.status, res.raw).toBe(200);
    const out = rig.emails.slice(e0);
    const toGp = emailsTo(out, DOCTORS.wa.email);
    expect(toGp).toHaveLength(1);
    expect(textOf(toGp[0])).toContain('When: Thursday 26 November at 7:00 am AWST');
    expect(textOf(toGp[0])).not.toMatch(/AEDT|10:00 am/);
    const toPractice = emailsTo(out, rigLib.PRACTICE_EMAIL);
    expect(toPractice).toHaveLength(1);
    expect(toPractice[0].text).toContain('When: Thursday 26 November at 10:00 am AEDT');
    expect(toPractice[0].text).not.toMatch(/AWST|7:00 am/);
  });

  it('a reminder for a booking that carries no device zone still says Perth time (from the state), where it used to print server time', async () => {
    vi.setSystemTime(new Date('2026-11-25T03:00:00.000Z'));
    const row = interviewOf(DOCTORS.wa);
    row.timezone = null;
    row.notification_channels = {};
    const e0 = rig.emails.length;
    await rig.get('/api/cron/interview-reminders', { headers: { Authorization: 'Bearer test-cron-secret' } });
    const toGp = emailsTo(rig.emails.slice(e0), DOCTORS.wa.email);
    expect(toGp).toHaveLength(1);
    expect(textOf(toGp[0])).toContain('When: Thursday 26 November at 7:00 am AWST');
  });

  it('a time staff book on the practice\'s behalf (no doctor device) is confirmed to the doctor in Perth time', async () => {
    await introduce(DOCTORS.wa_staff_booked);
    expect((await approve(DOCTORS.wa_staff_booked, [FRI_5_TO_730], 'Australia/Sydney')).status).toBe(200);
    const e0 = rig.emails.length;
    const res = await rig.post('/api/ats/interview/book', { application_id: rig.appIdFor(DOCTORS.wa_staff_booked), slot_start_utc: '2026-11-27T07:30:00.000Z' }, rig.superAdmin());
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await waitFor(() => emailsTo(rig.emails.slice(e0), DOCTORS.wa_staff_booked.email).length >= 1 && emailsTo(rig.emails.slice(e0), rigLib.PRACTICE_EMAIL).length >= 1);
    const out = rig.emails.slice(e0);
    const toGp = emailsTo(out, DOCTORS.wa_staff_booked.email);
    expect(toGp).toHaveLength(1);
    expect(toGp[0].text).toContain('is confirmed for Friday 27 November at 3:30 pm AWST.');
    expect(emailsTo(out, rigLib.PRACTICE_EMAIL)[0].text).toContain('is confirmed for Friday 27 November at 6:30 pm AEDT.');
  });
});

describe('a Sydney GP and the same Sydney practice: 9 to 11 am is offered', () => {
  it('clash prevention is unchanged: times already taken in the diary (with the gap either side) are not offered to the next candidate', async () => {
    // Still in the diary from the block above: the Perth GP at Thursday 10:00 am
    // Sydney, and the staff-booked interview at Friday 6:30 pm Sydney.
    const taken = rows('scheduled_calls').filter((r) => r.status === 'booked').map((r) => r.scheduled_at).sort();
    expect(taken).toEqual(['2026-11-25T23:00:00.000Z', '2026-11-27T07:30:00.000Z']);
    await introduce(DOCTORS.nsw);
    expect((await approve(DOCTORS.nsw, [THU_9_TO_11, FRI_5_TO_730], 'Australia/Sydney')).status).toBe(200);
    const res = await gpSlots(DOCTORS.nsw, 'Australia/Sydney');
    expect(res.json.slots.map((s) => s.local.gp.label)).toEqual(['Thu 26 Nov, 9:00 am', 'Fri 27 Nov, 5:00 pm', 'Fri 27 Nov, 5:30 pm']);
    // and a pick on a taken time is refused
    expect((await gpBook(DOCTORS.nsw, '2026-11-25T23:00:00.000Z', 'Australia/Sydney')).status).toBe(409);
  });

  it('all four morning slots, and the evening ones up to a 7:30 pm finish', async () => {
    clearDiary();
    vi.setSystemTime(new Date(Date.parse(NOW) + 5 * 60000)); // past the short slots cache
    await introduce(DOCTORS.nsw);
    expect((await approve(DOCTORS.nsw, [THU_9_TO_11, FRI_5_TO_730], 'Australia/Sydney')).status).toBe(200);
    const res = await gpSlots(DOCTORS.nsw, 'Australia/Sydney');
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.slots.map((s) => s.local.gp.label)).toEqual([
      'Thu 26 Nov, 9:00 am', 'Thu 26 Nov, 9:30 am', 'Thu 26 Nov, 10:00 am', 'Thu 26 Nov, 10:30 am',
      'Fri 27 Nov, 5:00 pm', 'Fri 27 Nov, 5:30 pm', 'Fri 27 Nov, 6:00 pm', 'Fri 27 Nov, 6:30 pm', 'Fri 27 Nov, 7:00 pm'
    ]);
  });

  it('switch off: the very same interview offers none of the morning (the 11:00 to 02:00 Sydney host window is back)', async () => {
    rig.setSwitch(false);
    vi.setSystemTime(new Date(Date.parse(NOW) + 10 * 60000)); // past the short slots cache
    const res = await gpSlots(DOCTORS.nsw, 'Australia/Sydney');
    expect(res.status).toBe(200);
    expect(res.json.slots.map((s) => s.local.gp.label)).toEqual([
      'Fri 27 Nov, 5:00 pm', 'Fri 27 Nov, 5:30 pm', 'Fri 27 Nov, 6:00 pm', 'Fri 27 Nov, 6:30 pm', 'Fri 27 Nov, 7:00 pm'
    ]);
  });
});

describe('when the practice has not chosen times: GP Link\'s standard times are business hours for an Australian candidate', () => {
  it('"use default times" offers weekday business hours in the practice zone, and no weekend', async () => {
    clearDiary();
    await introduce(DOCTORS.wa_default);
    const req = await rig.post('/api/ats/interview/request', { application_id: rig.appIdFor(DOCTORS.wa_default) }, rig.superAdmin());
    expect(req.status, JSON.stringify(req.json)).toBe(200);
    const def = await rig.post('/api/ats/interview/use-default-times', { application_id: rig.appIdFor(DOCTORS.wa_default) }, rig.superAdmin());
    expect(def.status, JSON.stringify(def.json)).toBe(200);
    const res = await gpSlotsAsStaff(DOCTORS.wa_default);
    expect(res.json.slots.length).toBeGreaterThan(0);
    for (const s of res.json.slots) {
      const p = inZone(s.startUtc, 'Australia/Sydney');
      const g = inZone(s.startUtc, 'Australia/Perth');
      expect(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], s.startUtc).toContain(p.weekday);
      expect(p.minutes).toBeGreaterThanOrEqual(480);
      expect(p.minutes + 30).toBeLessThanOrEqual(1170);
      expect(g.minutes).toBeGreaterThanOrEqual(420);
      expect(s.local.gp.tz).toBe('Australia/Perth');
    }
  });
});
async function gpSlotsAsStaff(d) {
  return rig.get('/api/ats/interview/slots?application_id=' + encodeURIComponent(rig.appIdFor(d)), rig.superAdmin());
}

describe('P06: the interview-times request to the practice', () => {
  it('Australian candidate: neutral wording, no evenings or weekends', async () => {
    await introduce(DOCTORS.wa_ask);
    const e0 = rig.emails.length;
    const res = await rig.post('/api/ats/interview/request', { application_id: rig.appIdFor(DOCTORS.wa_ask) }, rig.superAdmin());
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const asks = emailsTo(rig.emails.slice(e0), rigLib.PRACTICE_EMAIL);
    expect(asks).toHaveLength(1);
    expect(asks[0].subject).toBe('Interview availability — Dr ' + DOCTORS.wa_ask.name.replace(/^Dr /, ''));
    expect(asks[0].text).toContain('Which times over the next 2 weeks suit to interview Dr ' + DOCTORS.wa_ask.name.replace(/^Dr /, '') + '? Monday to Friday, 8:00 am to 7:30 pm works best.');
    expect(asks[0].text).not.toMatch(/evening|weekend|UK|overseas/i);
  });

  it('overseas candidate, switch on and off: the request reads exactly as it always has', async () => {
    const texts = [];
    for (const on of [true, false]) {
      rig.setSwitch(true);
      await introduce(DOCTORS.uk_ask);
      rig.setSwitch(on);
      const e0 = rig.emails.length;
      const res = await rig.post('/api/ats/interview/request', { application_id: rig.appIdFor(DOCTORS.uk_ask) }, rig.superAdmin());
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      const asks = emailsTo(rig.emails.slice(e0), rigLib.PRACTICE_EMAIL);
      expect(asks).toHaveLength(1);
      texts.push(asks[0].text);
    }
    expect(texts[0]).toBe(texts[1]);
    expect(texts[0]).toContain('Which evenings/weekends over the next 2 weeks suit to interview Dr ' + DOCTORS.uk_ask.name.replace(/^Dr /, '') + '?');
  });

  it('switch off: an Australian candidate gets the old wording too', async () => {
    await introduce(DOCTORS.wa_ask);
    rig.setSwitch(false);
    const e0 = rig.emails.length;
    await rig.post('/api/ats/interview/request', { application_id: rig.appIdFor(DOCTORS.wa_ask) }, rig.superAdmin());
    await new Promise((r) => setTimeout(r, 50));
    expect(emailsTo(rig.emails.slice(e0), rigLib.PRACTICE_EMAIL)[0].text).toContain('Which evenings/weekends');
  });
});

describe('overseas parity on the real server: a UK doctor\'s interview is what it was, switch on or off', () => {
  // Evening and weekend times, the kind the overseas flow is built around.
  const windows = [
    { date: '2026-11-26', fromMin: 1080, toMin: 1320 },  // Thu 6 to 10 pm Sydney
    { date: '2026-11-28', fromMin: 540, toMin: 1320 },   // Sat 9 am to 10 pm Sydney
    { date: '2026-11-27', fromMin: 540, toMin: 660 }     // Fri 9 to 11 am Sydney: never offered overseas
  ];
  // What today's code computes, from the pure scheduler and today's constants.
  function expectedOverseas(gpTz) {
    return interviewScheduler.computeInterviewSlots({
      now: new Date(NOW), horizonDays: interviewMeetings.INTERVIEW_HORIZON_DAYS, durationMin: 30,
      leadHours: interviewMeetings.INTERVIEW_LEAD_HOURS, gridMin: 30, maxSlots: 12,
      host: { tz: 'Australia/Sydney', weekday: [660, 1560], weekend: [660, 1560] },
      practice: { tz: 'Australia/Sydney', weekday: [0, 0], weekend: [0, 0], overrides: windows.map((w) => Object.assign({ tz: 'Australia/Sydney' }, w)) },
      gp: { tz: gpTz, weekday: [360, 1380], weekend: [360, 1380] },
      busy: []
    }).slots;
  }

  it('slots: identical with the switch on and off, with and without a device zone, and equal to the frozen overseas computation', async () => {
    clearDiary();
    await introduce(DOCTORS.uk);
    expect((await approve(DOCTORS.uk, windows, 'Australia/Sydney')).status).toBe(200);
    const results = {};
    for (const on of [true, false]) {
      rig.setSwitch(on);
      results[on + '|device'] = (await gpSlots(DOCTORS.uk, 'Europe/London')).json.slots;
      interviewOf(DOCTORS.uk).timezone = null;
      results[on + '|none'] = (await gpSlotsAsStaff(DOCTORS.uk)).json.slots;
    }
    expect(results['true|device']).toEqual(results['false|device']);
    expect(results['true|none']).toEqual(results['false|none']);
    expect(results['true|device']).toEqual(expectedOverseas('Europe/London'));
    expect(results['true|none']).toEqual(expectedOverseas('Europe/London'));
    expect(results['true|device'].length).toBeGreaterThan(0);
    // no Friday 9 to 11 am Sydney, and Saturday IS offered: the overseas rules
    for (const s of results['true|device']) {
      const p = inZone(s.startUtc, 'Australia/Sydney');
      expect(p.minutes >= 660 || p.minutes < 120).toBe(true);
      expect(s.local.host.tz).toBe('Australia/Sydney');
      expect(s.local.gp.tz).toBe('Europe/London');
    }
    expect(results['true|device'].some((s) => inZone(s.startUtc, 'Australia/Sydney').weekday === 'Sat')).toBe(true);
  });

  it('confirmation emails: the same words with the switch on and off (UK time for the doctor)', async () => {
    const texts = {};
    // Two identical UK doctors (same name, same country), one booked with the
    // switch on and one with it off, each into an empty diary.
    expect(DOCTORS.uk_twin.name).toBe(DOCTORS.uk.name);
    for (const [on, d] of [[true, DOCTORS.uk], [false, DOCTORS.uk_twin]]) {
      rig.setSwitch(true);
      clearDiary();
      await introduce(d);
      expect((await approve(d, windows, 'Australia/Sydney')).status).toBe(200);
      expect(interviewOf(d).practice_availability_status).toBe('received');
      rig.setSwitch(on);
      const list = (await gpSlots(d, 'Europe/London')).json.slots;
      const e0 = rig.emails.length;
      const res = await gpBook(d, list[0].startUtc, 'Europe/London');
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const out = rig.emails.slice(e0);
      texts[on] = { gp: emailsTo(out, d.email).map((e) => e.subject + '\n' + e.text), practice: emailsTo(out, rigLib.PRACTICE_EMAIL).map((e) => e.subject + '\n' + e.text) };
      expect(texts[on].gp).toHaveLength(1);
      expect(texts[on].practice).toHaveLength(1);
      expect(profileOf(d).timezone == null).toBe(true); // never written for an overseas doctor
    }
    expect(texts.true).toEqual(texts.false);
    expect(texts.true.gp[0]).toMatch(/is confirmed for Thursday 26 November at 7:00 am GMT\./);
    expect(texts.true.practice[0]).toMatch(/is confirmed for Thursday 26 November at 6:00 pm AEDT\./);
  });

  it('switch off: none of these flows names a new column or table, for an overseas or an Australian doctor', async () => {
    rig.setSwitch(true);
    clearDiary();
    await introduce(DOCTORS.uk);
    await introduce(DOCTORS.wa_refused);
    rig.setSwitch(false);
    rig.emu.forbid((request) => wp02NewNameViolation(request, NAMES));
    for (const d of [DOCTORS.uk, DOCTORS.wa_refused]) {
      expect((await decisionContext(d)).status).toBe(200);
      expect((await approve(d, [{ date: '2026-11-26', fromMin: 1080, toMin: 1320 }], 'Australia/Sydney')).status).toBe(200);
      const list = (await gpSlots(d, d === DOCTORS.uk ? 'Europe/London' : 'Australia/Perth')).json.slots;
      expect(list.length).toBeGreaterThan(0);
      expect((await gpBook(d, list[0].startUtc, d === DOCTORS.uk ? 'Europe/London' : 'Australia/Perth')).status).toBe(200);
    }
    vi.setSystemTime(new Date('2026-11-25T12:00:00.000Z'));
    expect((await rig.get('/api/cron/interview-reminders', { headers: { Authorization: 'Bearer test-cron-secret' } })).status).toBe(200);
    expect((await rig.get('/api/cron/practice-decision-reminders', { headers: { Authorization: 'Bearer test-cron-secret' } })).status).toBe(200);
    expect(rig.emu.violations).toEqual([]);
  });
});

describe('APP-21: the doctor\'s time zone is stored on the profile', () => {
  function auBody(over, extra) {
    return Object.assign({
      _version: 2, currentStep: 4, country: '', registerNumber: '', qualDocs: {}, accountReviewFlag: false,
      targetDate: '', preferredCity: '', whoMoving: '', childrenCount: 1, childrenAges: [],
      leadSource: 'google', leadSourceDetail: '', idVerification: null, completedAt: null,
      auBranch: 'yes',
      au: Object.assign({
        step: 5, ahpraNumber: 'med 0001234567', registrationType: 'specialist', fellowship: 'fracgp', fellowshipDetail: '',
        hasConditions: false, conditionsDetail: '', moratorium19ab: 'no',
        workRights: 'citizen', permitSubclass: '', permitExpiry: '',
        currentPractice: 'Test Current Practice (FAKE)', noticeWeeks: 4, availableFrom: '2026-12-18',
        locations: ['Perth'], suburb: 'Subiaco', state: 'WA', postcode: '6008',
        sessions: 8, detailsConfirmed: true
      }, over || {})
    }, extra || {});
  }
  const complete = (d, body) => rig.post('/api/onboarding/complete', body, { cookie: cookie(d) });

  it('onboarding: the browser zone is stored with the state', async () => {
    const res = await complete(DOCTORS.onb_perth, auBody({}, { browserTz: 'Australia/Perth' }));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(profileOf(DOCTORS.onb_perth)).toMatchObject({ current_state: 'WA', timezone: 'Australia/Perth', candidate_pathway: 'au_vr' });
  });

  it('onboarding: the browser zone wins over the state when they differ (a WA doctor filling the form in Brisbane)', async () => {
    const d = DOCTORS.onb_state_only;
    const res = await complete(d, auBody({ ahpraNumber: 'MED0001234568' }, { browserTz: 'Australia/Brisbane' }));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(profileOf(d)).toMatchObject({ current_state: 'WA', timezone: 'Australia/Brisbane' });
    // staff later correct the state: a zone a browser reported is kept
    await rig.testUtils.setCandidatePreferences(d.userId, { current_state: 'NSW' });
    expect(profileOf(d)).toMatchObject({ current_state: 'NSW', timezone: 'Australia/Brisbane' });
  });

  it.each([
    ['nothing sent (an old cached page)', undefined],
    ['UTC', 'UTC'],
    ['free text', 'Perth, WA'],
    ['a zone that does not exist', 'Australia/Atlantis']
  ])('onboarding: %s falls back to the state, and the raw value is never stored', async (_label, sentZone) => {
    const d = DOCTORS.onb_bad_zone;
    profileOf(d).timezone = null;
    profileOf(d).current_state = null;
    profileOf(d).onboarding_completed_at = null;
    const res = await complete(d, auBody({ ahpraNumber: 'MED0001234569' }, sentZone === undefined ? {} : { browserTz: sentZone }));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(profileOf(d)).toMatchObject({ current_state: 'WA', timezone: 'Australia/Perth' });
    if (sentZone) expect(JSON.stringify(profileOf(d))).not.toContain(sentZone);
  });

  it('a state staff set later moves a zone that only ever came from the state', async () => {
    const d = DOCTORS.onb_bad_zone;
    expect(profileOf(d)).toMatchObject({ current_state: 'WA', timezone: 'Australia/Perth' });
    const out = await rig.testUtils.setCandidatePreferences(d.userId, { current_state: 'QLD' });
    expect(out.ok).toBe(true);
    expect(profileOf(d)).toMatchObject({ current_state: 'QLD', timezone: 'Australia/Brisbane' });
    // a write that does not touch the state does not touch the zone
    await rig.testUtils.setCandidatePreferences(d.userId, { notice_period_weeks: 6 });
    expect(profileOf(d)).toMatchObject({ current_state: 'QLD', timezone: 'Australia/Brisbane', notice_period_weeks: 6 });
  });

  it('an overseas onboarding stores no zone, even if one is sent, and reads no new column', async () => {
    const d = DOCTORS.onb_overseas;
    const body = {
      _version: 2, currentStep: 4, country: 'GB', registerNumber: '7000002', qualDocs: {}, accountReviewFlag: false,
      targetDate: '2027-08-01', preferredCity: 'Sydney', whoMoving: 'just_me', childrenCount: 1, childrenAges: [],
      leadSource: 'google', leadSourceDetail: '', idVerification: { status: 'verified', fileName: 'id.jpg' },
      completedAt: '2026-11-20T03:00:00.000Z', browserTz: 'Europe/London'
    };
    const res = await complete(d, body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(profileOf(d).timezone == null).toBe(true);
    expect(profileOf(d).current_state == null).toBe(true);
  });

  it('switch off: an Australian payload stores no zone', async () => {
    rig.setSwitch(false);
    const d = DOCTORS.onb_off;
    await complete(d, auBody({ ahpraNumber: 'MED0001234570' }, { browserTz: 'Australia/Perth' }));
    expect(profileOf(d).timezone == null).toBe(true);
    expect(profileOf(d).candidate_pathway == null).toBe(true);
  });

  it('the slot picker\'s device zone is remembered on an Australian doctor\'s profile, and only when it changed', async () => {
    const d = DOCTORS.wa_reminder;
    await introduce(d);
    expect((await approve(d, [FRI_5_TO_730], 'Australia/Sydney')).status).toBe(200);
    expect(profileOf(d).timezone == null).toBe(true);
    const profileWrites = () => rig.emu.requests.filter((r) => r.table === 'user_profiles' && r.method === 'PATCH' && JSON.stringify(r.body || '').indexOf('timezone') !== -1).length;
    const w0 = profileWrites();
    expect((await gpSlots(d, 'Australia/Perth')).status).toBe(200);
    expect(profileOf(d).timezone).toBe('Australia/Perth');
    expect(profileWrites()).toBe(w0 + 1);
    // the same device again: a read, no write
    await new Promise((r) => setTimeout(r, 5));
    vi.setSystemTime(new Date(Date.parse(NOW) + 5 * 60000)); // past the short slots cache
    expect((await gpSlots(d, 'Australia/Perth')).status).toBe(200);
    expect(profileWrites()).toBe(w0 + 1);
    // they travel: the new device zone is remembered
    vi.setSystemTime(new Date(Date.parse(NOW) + 10 * 60000));
    expect((await gpSlots(d, 'Australia/Darwin')).status).toBe(200);
    expect(profileOf(d).timezone).toBe('Australia/Darwin');
    // junk from a browser is never stored
    vi.setSystemTime(new Date(Date.parse(NOW) + 15 * 60000));
    expect((await gpSlots(d, 'UTC')).status).toBe(200);
    expect(profileOf(d).timezone).toBe('Australia/Darwin');
  });

  it('an overseas doctor\'s device zone is never written to their profile', async () => {
    await introduce(DOCTORS.uk);
    expect((await approve(DOCTORS.uk, [{ date: '2026-11-26', fromMin: 1080, toMin: 1320 }], 'Australia/Sydney')).status).toBe(200);
    expect((await gpSlots(DOCTORS.uk, 'Europe/London')).status).toBe(200);
    expect(profileOf(DOCTORS.uk).timezone == null).toBe(true);
    expect(rig.emu.requests.filter((r) => r.table === 'user_profiles' && r.method === 'PATCH' && JSON.stringify(r.body || '').indexOf('timezone') !== -1
      && String(r.query || '').indexOf(DOCTORS.uk.userId) !== -1)).toEqual([]);
  });
});

describe('COM-27: practice reminders skip the weekend on the practice\'s own clock (switch on), on the UTC day (switch off)', () => {
  const cron = () => rig.get('/api/cron/practice-decision-reminders', { headers: { Authorization: 'Bearer test-cron-secret' } });
  // Saturday 28 Nov 2026, 9:00 am in Sydney: still Friday in UTC.
  const SATURDAY_MORNING = '2026-11-27T22:00:00.000Z';
  // Monday 30 Nov 2026, 9:00 am in Sydney: still Sunday in UTC.
  const MONDAY_MORNING = '2026-11-29T22:00:00.000Z';

  async function dueApplication(d, nowIso) {
    vi.setSystemTime(new Date(NOW));
    rig.setSwitch(true);
    await introduce(d);
    const app = appOf(d);
    app.submitted_to_practice_at = new Date(Date.parse(nowIso) - 4 * 86400000).toISOString();
    app.ats_stage = 'submitted';
    app.practice_reminder_count = 0;
    app.last_practice_reminder_at = null;
    app.practice_chase_flagged_at = null;
    // every other application is out of the cron's reach
    rows('gp_applications').forEach((r) => { if (r.id !== app.id) r.practice_submission_status = 'pending_va_submission'; });
    vi.setSystemTime(new Date(nowIso));
    return app;
  }

  for (const key of ['uk_weekend', 'wa_weekend']) {
    describe(key === 'uk_weekend' ? 'an overseas candidate\'s practice' : 'an Australian candidate\'s practice', () => {
      it('Saturday morning in Sydney: switch ON sends nothing (it is the weekend there)', async () => {
        const app = await dueApplication(DOCTORS[key], SATURDAY_MORNING);
        rig.setSwitch(true);
        const e0 = rig.emails.length;
        const res = await cron();
        expect(res.status, res.raw).toBe(200);
        expect(res.json.reminders_sent).toBe(0);
        expect(emailsTo(rig.emails.slice(e0), rigLib.PRACTICE_EMAIL)).toHaveLength(0);
        expect(app.practice_reminder_count).toBe(0);
      });

      it('Saturday morning in Sydney: switch OFF sends, as it always has (Friday in UTC)', async () => {
        const app = await dueApplication(DOCTORS[key], SATURDAY_MORNING);
        rig.setSwitch(false);
        const e0 = rig.emails.length;
        const res = await cron();
        expect(res.json.reminders_sent).toBe(1);
        expect(emailsTo(rig.emails.slice(e0), rigLib.PRACTICE_EMAIL)).toHaveLength(1);
        expect(app.practice_reminder_count).toBe(1);
      });

      it('Monday morning in Sydney: switch ON sends (it is a working day there)', async () => {
        const app = await dueApplication(DOCTORS[key], MONDAY_MORNING);
        rig.setSwitch(true);
        const e0 = rig.emails.length;
        const res = await cron();
        expect(res.json.reminders_sent).toBe(1);
        expect(emailsTo(rig.emails.slice(e0), rigLib.PRACTICE_EMAIL)).toHaveLength(1);
        expect(app.practice_reminder_count).toBe(1);
      });

      it('Monday morning in Sydney: switch OFF skips, as it always has (Sunday in UTC)', async () => {
        const app = await dueApplication(DOCTORS[key], MONDAY_MORNING);
        rig.setSwitch(false);
        const e0 = rig.emails.length;
        const res = await cron();
        expect(res.json.reminders_sent).toBe(0);
        expect(emailsTo(rig.emails.slice(e0), rigLib.PRACTICE_EMAIL)).toHaveLength(0);
        expect(app.practice_reminder_count).toBe(0);
      });
    });
  }

  it('PRACTICE_REMINDER_SKIP_WEEKENDS=false still switches the skip off in both states', async () => {
    process.env.PRACTICE_REMINDER_SKIP_WEEKENDS = 'false';
    for (const on of [true, false]) {
      await dueApplication(DOCTORS.wa_weekend, SATURDAY_MORNING);
      rig.setSwitch(on);
      const res = await cron();
      expect(res.json.reminders_sent).toBe(1);
    }
  });
});

describe('COM-38: the consultation reminder a booked lead receives states their own local time', () => {
  // Thursday 26 Nov 2026: 1:00 pm in Sydney, 12:00 pm in Brisbane, 10:00 am in Perth, 2:00 am in the UK.
  const CALL_AT = '2026-11-26T02:00:00.000Z';
  const LEADS = {
    wa_state: { email: 'lead.wa.wp10@gplink-test.local', phone: '+61400111001', consult: { country: 'au', state: 'WA' }, bookingZone: null },
    booked_in_brisbane: { email: 'lead.qld.wp10@gplink-test.local', phone: '+61400111002', consult: { country: 'au', state: 'WA' }, bookingZone: 'Australia/Brisbane' },
    browser_adelaide: { email: 'lead.sa.wp10@gplink-test.local', phone: '+61400111003', consult: { country: 'au', timezone: 'Australia/Adelaide', timezone_source: 'browser' }, bookingZone: null },
    au_unknown: { email: 'lead.au.wp10@gplink-test.local', phone: '+61400111004', consult: { country: 'au' }, bookingZone: null },
    uk: { email: 'lead.uk.wp10@gplink-test.local', phone: '+447700900555', consult: { country: 'uk' }, bookingZone: 'Europe/London' },
    nz: { email: 'lead.nz.wp10@gplink-test.local', phone: '+64210000555', consult: { country: 'nz' }, bookingZone: 'Pacific/Auckland' },
    // UK-trained, living in Perth, booked from a Perth browser: an OVERSEAS lead until WP-15.
    uk_in_perth: { email: 'lead.ukau.wp10@gplink-test.local', phone: '+61400111005', consult: { country: 'uk', timezone: 'Australia/Perth', timezone_source: 'calendly' }, bookingZone: 'Australia/Perth' }
  };

  // One lead and one booking in the tables at a time: the database stub does
  // not evaluate `ilike` (the lead-by-email lookup), so with several leads
  // seeded it would hand every booking the same lead.
  function seedOne(k, i) {
    clearDiary();
    const l = LEADS[k];
    const leads = rows('site_enquiries');
    leads.length = 0;
    leads.push({
      id: 'lead-wp10-' + k, kind: 'gp', name: 'Dr Test ' + k, email: l.email, phone: l.phone, state: l.consult.country, status: 'new',
      created_at: '2026-11-20T00:00:00.000Z',
      metadata: { source: 'site_start_form', consult: Object.assign({ qualified: true, call_booked: true, call_at: CALL_AT, nudges: [] }, l.consult) }
    });
    const calls = rows('scheduled_calls');
    for (let n = calls.length - 1; n >= 0; n--) if (String(calls[n].id).indexOf('call-wp10-') === 0) calls.splice(n, 1);
    calls.push({
      id: 'call-wp10-' + k, meeting_kind: 'consultation', host_kind: 'ceo', status: 'booked', user_id: null,
      invitee_email: l.email, scheduled_at: CALL_AT, booked_at: '2026-11-22T00:00:00.000Z',
      zoom_join_url: 'https://zoom.us/j/55500' + i, notification_channels: {}, invitee_notes: null, timezone: l.bookingZone,
      correlation_token: 'tok-wp10-' + k, created_at: '2026-11-22T00:00:00.000Z', updated_at: '2026-11-22T00:00:00.000Z'
    });
  }

  async function hourBefore(on) {
    const byLead = {};
    const keys = Object.keys(LEADS);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      seedOne(k, i);
      rig.setSwitch(on);
      vi.setSystemTime(new Date(Date.parse(CALL_AT) - 60 * 60000));
      const e0 = rig.emails.length;
      const w0 = rig.whatsapps.length;
      const out = await rig.testUtils.runConsultCallReminders(Date.now(), 'consult');
      expect(out.checked, k).toBe(1);
      byLead[k] = {
        emails: emailsTo(rig.emails.slice(e0), LEADS[k].email).map((e) => e.subject + '\n' + e.text),
        whatsapps: rig.whatsapps.slice(w0).map((w) => JSON.stringify(w.messages[0].content))
      };
    }
    rows('site_enquiries').length = 0;
    return { byLead };
  }

  it('switch on: Perth, Brisbane, Adelaide and "Australia, zone unknown" leads each get their own clock and a label that names it', async () => {
    const { byLead } = await hourBefore(true);
    const expected = {
      wa_state: '10:00 am (Perth time)',
      booked_in_brisbane: '12:00 pm (Brisbane time)',   // the zone they booked in beats the state on file
      browser_adelaide: '12:30 pm (Adelaide time)',
      au_unknown: '1:00 pm (Sydney time)'               // last resort, named, never "your time"
    };
    for (const k of Object.keys(expected)) {
      expect(byLead[k].emails, k).toHaveLength(1);
      expect(byLead[k].emails[0]).toContain('Your GP Link call is in about an hour (' + expected[k] + ')');
      expect(byLead[k].emails[0]).toContain('in about an hour, at ' + expected[k] + '.');
      expect(byLead[k].emails[0]).not.toMatch(/UK time/);
      if (k !== 'au_unknown') expect(byLead[k].emails[0]).not.toMatch(/Sydney time/);
      // the overseas WhatsApp templates are still held for an Australian lead (WP-01)
      expect(byLead[k].whatsapps).toEqual([]);
    }
  });

  it('switch off: the same Australian leads are all told Sydney time, as before', async () => {
    const { byLead } = await hourBefore(false);
    for (const k of ['wa_state', 'booked_in_brisbane', 'browser_adelaide', 'au_unknown']) {
      expect(byLead[k].emails, k).toHaveLength(1);
      expect(byLead[k].emails[0]).toContain('in about an hour, at 1:00 pm (Sydney time).');
    }
  });

  it('overseas leads: every email and WhatsApp is word for word the same with the switch on and off', async () => {
    const on = await hourBefore(true);
    const off = await hourBefore(false);
    for (const k of ['uk', 'nz', 'uk_in_perth']) {
      expect(on.byLead[k].emails, k).toHaveLength(1);
      expect(on.byLead[k]).toEqual(off.byLead[k]);
    }
    expect(on.byLead.uk.emails[0]).toContain('in about an hour, at 2:00 am (UK time).');
    expect(on.byLead.nz.emails[0]).toContain('in about an hour, at 3:00 pm (New Zealand time).');
    // Known limitation, on purpose: UK-trained, living and booking in Perth, still told UK time.
    expect(on.byLead.uk_in_perth.emails[0]).toContain('in about an hour, at 2:00 am (UK time).');
    expect(on.byLead.uk.whatsapps.length).toBe(off.byLead.uk.whatsapps.length);
  });
});

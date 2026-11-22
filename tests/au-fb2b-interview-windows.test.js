// FB-2b (walk-findings W3-D11): a practice offering interview times that the
// doctor cannot book is told at the moment it submits, and a set of times
// that yields no slot at all is never accepted.
//
// The case from the walk: a Sydney practice offers 8 to 10 am to a doctor in
// Perth. That is 5 to 7 am for the doctor, outside the hours a doctor is ever
// offered (07:00 to 21:00 on their own clock), so their picker showed nothing
// for it and the practice was never told.
//
// Candidates on an Australian pathway only, switch on. An overseas candidate,
// and every candidate with the switch off, is answered exactly as before.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { buildAuDoctor } = require('./helpers/au-fixtures.js');
const rigLib = require('./helpers/au-wp09-intro-rig.js');
const consent = require('../lib/profile-share-consent.js');
const auTimezone = require('../lib/au-timezone.js');

const NOW = '2026-11-23T00:00:00.000Z';     // Monday 23 Nov 2026, 11 am in Sydney
const SEED = '2026-11-01T00:00:00.000Z';
const STAFF = 'staff.test@gplink-test.local';
const au = (suffix, profile) => buildAuDoctor('au_vr', {
  idSuffix: suffix, credentials: { staff_verified_at: SEED, staff_verified_by: STAFF },
  profile: Object.assign({ register_status: 'verified', register_body: 'ahpra', register_number: 'MED0001000001', timezone: null, phone: '+6140000' + String(2000 + Number(suffix)) }, profile)
});
const DOCTORS = {
  wa_none: au('1', { current_state: 'WA' }),
  wa_some: au('2', { current_state: 'WA' }),
  wa_fine: au('3', { current_state: 'WA' }),
  wa_later: au('4', { current_state: 'WA' }),
  nsw: au('5', { current_state: 'NSW' }),
  wa_off: au('6', { current_state: 'WA' }),
  uk: buildAuDoctor('overseas_null'),
  uk_off: buildAuDoctor('overseas_null', { idSuffix: '2' })
};
// Thursday 26 and Friday 27 November 2026, as the practice types them (Sydney).
const THU_8_TO_10 = { date: '2026-11-26', fromMin: 480, toMin: 600 };
const THU_9_TO_11 = { date: '2026-11-26', fromMin: 540, toMin: 660 };
const FRI_8_TO_930 = { date: '2026-11-27', fromMin: 480, toMin: 570 };
const FRI_5_TO_730 = { date: '2026-11-27', fromMin: 1020, toMin: 1170 };

let rig;
let ipSeq = 0;
const rows = (name) => rig.emu.table(name);
const appOf = (d) => rows('gp_applications').filter((r) => r.id === rig.appIdFor(d))[0];
const interviewOf = (d) => rows('scheduled_calls').filter((r) => r.application_id === rig.appIdFor(d) && r.status !== 'cancelled')[0];
function ip() {
  ipSeq += 1;
  const a = '10.44.' + Math.floor(ipSeq / 250) + '.' + (ipSeq % 250 + 1);
  return { headers: { 'x-real-ip': a, 'x-forwarded-for': a } };
}
async function introduce(d) {
  rig.resetApplication(d, d.expected.isAu ? consent.buildConsentPatch({ source: 'doctor', application: { career_role_id: rigLib.ROLE_ID }, by: STAFF, now: SEED }) : {});
  rows('scheduled_calls').forEach((r) => { if (r.application_id === rig.appIdFor(d)) r.status = 'cancelled'; });
  const out = await rig.introduce(d, { decision: false });
  expect(out.status, JSON.stringify(out.json)).toBe(200);
}
const approve = (d, windows, tz) => rig.post('/api/practice/application/decision', { token: rig.tokenFor(d), action: 'approve', windows, viewer_tz: tz === undefined ? 'Australia/Sydney' : tz }, ip());
const addTimes = (d, windows) => rig.post('/api/practice/application/availability', { token: rig.tokenFor(d), windows, viewer_tz: 'Australia/Sydney' }, ip());
const gpSlots = (d) => rig.get('/api/career/interview/slots?applicationId=' + encodeURIComponent(rig.appIdFor(d)) + '&viewer_tz=Australia%2FPerth', { cookie: rig.gpCookie(d.email, d.userId) });

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  const list = Object.keys(DOCTORS).map((k) => DOCTORS[k]);
  rig = await rigLib.bootIntroRig({
    name: 'fb2b-windows',
    doctors: list,
    tables: {
      user_documents: list.map((d) => ({ id: 'cv-' + d.userId, user_id: d.userId, document_key: 'career_cv', status: 'uploaded', file_name: 'cv.pdf', country_code: 'AU', created_at: SEED, updated_at: SEED })),
      placements: [], candidate_leads: [], runtime_kv: [], rate_limits: [], gp_nudge_log: [], user_roles: [],
      career_suburb_geo_cache: [], match_cache: [], career_contracts: [], onboarding_reminders: [], pep_waitlist: [],
      cron_runs: [], notifications: [], user_notifications: [], doubletick_messages: [], email_suppression: []
    }
  });
  rig.setSwitch(true);
}, 60000);
afterAll(async () => { if (rig) await rig.close(); vi.useRealTimers(); });
beforeEach(() => { vi.setSystemTime(new Date(NOW)); rig.setSwitch(true); rows('scheduled_calls').forEach((r) => { r.status = 'cancelled'; }); });

describe('auWindowDoctorFit: one window against the doctor\'s own hours', () => {
  const fit = (w, gpTz) => auTimezone.auWindowDoctorFit(w, { windowTz: 'Australia/Sydney', practiceTz: 'Australia/Sydney', gpTz, durationMin: 30 });
  it('8 to 10 am in Sydney is 5 to 7 am in Perth: nothing the doctor can book, said in plain words', () => {
    const r = fit(THU_8_TO_10, 'Australia/Perth');
    expect(r).toMatchObject({ bookable: false, reason: 'before_doctor_hours', overlapMin: 0, doctorFrom: '5:00 am', doctorTo: '7:00 am', doctorZoneLabel: 'Perth time', suggestFrom: '10:00 am', suggestTo: '7:30 pm' });
    expect(r.message).toBe('8:00 am to 10:00 am on Thu 26 Nov is 5:00 am to 7:00 am for the doctor, who is on Perth time, so the doctor cannot be offered it. On that day, a time between 10:00 am and 7:30 pm works for both of you.');
  });
  it('9 to 11 am Sydney leaves the Perth doctor an hour (7 to 8 am): bookable', () => {
    expect(fit(THU_9_TO_11, 'Australia/Perth')).toMatchObject({ bookable: true, reason: null, overlapMin: 60, message: '' });
  });
  it('the same morning for a doctor in Sydney is simply bookable', () => {
    expect(fit(THU_8_TO_10, 'Australia/Sydney')).toMatchObject({ bookable: true, overlapMin: 120 });
  });
  it('less than one interview\'s length inside the doctor\'s hours is not bookable', () => {
    const r = auTimezone.auWindowDoctorFit({ date: '2026-11-26', fromMin: 540, toMin: 615 }, { windowTz: 'Australia/Sydney', practiceTz: 'Australia/Sydney', gpTz: 'Australia/Perth', durationMin: 30 });
    expect(r).toMatchObject({ bookable: false, overlapMin: 15, reason: 'before_doctor_hours' });
  });
  it('a malformed window is "not bookable" with no sentence (the earlier validators own that message)', () => {
    expect(auTimezone.auWindowDoctorFit({ date: 'x' }, { gpTz: 'Australia/Perth' })).toMatchObject({ bookable: false, reason: 'invalid', message: '' });
  });
  it('no dollar figure, percentage or banned word in the sentence', () => {
    const words = require('./helpers/au-banned-words.js');
    expect(words.bannedIn(fit(THU_8_TO_10, 'Australia/Perth').message)).toEqual([]);
  });
});

describe('W3-D11: the practice submits times for a doctor in Perth', () => {
  it('ONLY early-Sydney times: refused, with the reason, and nothing at all is written or sent', async () => {
    await introduce(DOCTORS.wa_none);
    const emailsBefore = rig.emails.length;
    const res = await approve(DOCTORS.wa_none, [THU_8_TO_10, FRI_8_TO_930]);
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(res.json.code).toBe('windows_no_slots');
    expect(res.json.message).toContain('The doctor would not be able to book any of these times.');
    expect(res.json.message).toContain('Time 1: 8:00 am to 10:00 am on Thu 26 Nov is 5:00 am to 7:00 am for the doctor, who is on Perth time');
    expect(res.json.message).toContain('Time 2: 8:00 am to 9:30 am on Fri 27 Nov is 5:00 am to 6:30 am for the doctor');
    expect(res.json.message).toContain('Please change a time or add another one.');
    expect(res.json.windows.map((w) => [w.index, w.bookable, w.reason])).toEqual([[0, false, 'before_doctor_hours'], [1, false, 'before_doctor_hours']]);
    // nothing happened: not approved, no interview row, no message to anyone
    expect(appOf(DOCTORS.wa_none).practice_decision).toBeNull();
    expect(appOf(DOCTORS.wa_none).status).not.toBe('interview');
    expect(interviewOf(DOCTORS.wa_none)).toBeUndefined();
    expect(rig.emails.length).toBe(emailsBefore);
    // the practice changes a time and sends again: accepted
    const again = await approve(DOCTORS.wa_none, [THU_9_TO_11]);
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json).toEqual({ ok: true, decision: 'approved' });
    expect((await gpSlots(DOCTORS.wa_none)).json.slots.length).toBeGreaterThan(0);
  });

  it('one early time and one that works: accepted, and the practice is told which one the doctor cannot be offered', async () => {
    await introduce(DOCTORS.wa_some);
    const res = await approve(DOCTORS.wa_some, [THU_8_TO_10, FRI_5_TO_730]);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.decision).toBe('approved');
    expect(res.json.warnings).toHaveLength(1);
    expect(res.json.warnings[0]).toMatchObject({ index: 0, label: 'Time 1', bookable: false, reason: 'before_doctor_hours' });
    expect(res.json.warningMessage).toBe('Time 1: 8:00 am to 10:00 am on Thu 26 Nov is 5:00 am to 7:00 am for the doctor, who is on Perth time, so the doctor cannot be offered it. On that day, a time between 10:00 am and 7:30 pm works for both of you.');
    expect(appOf(DOCTORS.wa_some).practice_decision).toBe('approved');
    // and the doctor's picker really does offer only the Friday
    const slots = (await gpSlots(DOCTORS.wa_some)).json.slots;
    expect(slots.length).toBeGreaterThan(0);
    slots.forEach((s) => expect(s.startUtc.slice(0, 10)).toBe('2026-11-27'));
  });

  it('times that all work: the answer is exactly what it always was (no extra key)', async () => {
    await introduce(DOCTORS.wa_fine);
    const res = await approve(DOCTORS.wa_fine, [THU_9_TO_11, FRI_5_TO_730]);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, decision: 'approved' });
    await introduce(DOCTORS.nsw);
    const nsw = await approve(DOCTORS.nsw, [THU_8_TO_10]);
    expect(nsw.json).toEqual({ ok: true, decision: 'approved' });
  });

  it('"add more times" later is checked the same way, and a refused set does not replace the times already saved', async () => {
    await introduce(DOCTORS.wa_later);
    expect((await approve(DOCTORS.wa_later, [FRI_5_TO_730])).status).toBe(200);
    const saved = JSON.stringify(interviewOf(DOCTORS.wa_later).practice_availability_windows);
    const bad = await addTimes(DOCTORS.wa_later, [THU_8_TO_10]);
    expect([bad.status, bad.json.code]).toEqual([400, 'windows_no_slots']);
    expect(bad.json.message).toContain('5:00 am to 7:00 am for the doctor');
    expect(JSON.stringify(interviewOf(DOCTORS.wa_later).practice_availability_windows)).toBe(saved);
    const mixed = await addTimes(DOCTORS.wa_later, [THU_8_TO_10, THU_9_TO_11]);
    expect(mixed.status, JSON.stringify(mixed.json)).toBe(200);
    expect(mixed.json).toMatchObject({ ok: true, windowsSaved: 2 });
    expect(mixed.json.warnings.map((w) => w.index)).toEqual([0]);
    const fine = await addTimes(DOCTORS.wa_later, [THU_9_TO_11]);
    expect(fine.json).toEqual({ ok: true, windowsSaved: 1 });
  });

  it('times that fit the doctor\'s hours but are all already taken are refused too (never zero slots in total)', async () => {
    await introduce(DOCTORS.wa_fine);
    // The whole Thursday morning is already booked in the interviewer's diary.
    rows('scheduled_calls').push({ id: 'busy-fb2b-1', meeting_kind: 'interview', status: 'booked', scheduled_at: '2026-11-25T21:30:00.000Z', duration_minutes: 180, application_id: 'someone-else' });
    const res = await approve(DOCTORS.wa_fine, [THU_9_TO_11]);
    expect([res.status, res.json.code]).toEqual([400, 'windows_no_slots']);
    expect(res.json.message).toMatch(/^None of these times is free to book: they may be less than 48 hours away, or already taken in the interviewer's diary\. Please add another time\.$/);
    rows('scheduled_calls').forEach((r) => { if (r.id === 'busy-fb2b-1') r.status = 'cancelled'; });
  });
});

describe('OVERSEAS PARITY: an overseas candidate, and everyone with the switch off', () => {
  it('the same early times are accepted for an overseas candidate with the answer byte for byte as before, and no extra read', async () => {
    await introduce(DOCTORS.uk);
    const before = rig.emu.requests.length;
    const on = await approve(DOCTORS.uk, [THU_8_TO_10, FRI_8_TO_930]);
    const readsOn = rig.emu.requests.slice(before).map((r) => r.method + ' ' + r.table).sort();
    expect(on.status).toBe(200);
    expect(on.raw).toBe(JSON.stringify({ ok: true, decision: 'approved' }));
    const more = await addTimes(DOCTORS.uk, [THU_8_TO_10]);
    expect(more.raw).toBe(JSON.stringify({ ok: true, windowsSaved: 1 }));

    rig.setSwitch(false);
    try {
      await introduce(DOCTORS.uk_off);
      const b2 = rig.emu.requests.length;
      const off = await approve(DOCTORS.uk_off, [THU_8_TO_10, FRI_8_TO_930]);
      const readsOff = rig.emu.requests.slice(b2).map((r) => r.method + ' ' + r.table).sort();
      expect(off.raw).toBe(on.raw);
      // An overseas approval makes the same requests whether the switch is on
      // or off, apart from the pathway read every switch-on route makes.
      const strip = (list) => list.filter((x) => !/gp_credentials|user_profiles/.test(x));
      expect(strip(readsOn)).toEqual(strip(readsOff));
      // A doctor stored as Australian is an overseas doctor while it is off.
      await introduce(DOCTORS.wa_off);
      const auOff = await approve(DOCTORS.wa_off, [THU_8_TO_10]);
      expect(auOff.raw).toBe(JSON.stringify({ ok: true, decision: 'approved' }));
    } finally { rig.setSwitch(true); }
  });
});

describe('the practice page says it', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'practice-decision.html'), 'utf8');
  it('a refused set shows the server\'s sentence on the times form, which stays open for another time', () => {
    expect(html).toContain("if (res.status === 400) { showMsg(el.availMsg, (res.data && res.data.message) || 'Please choose at least one interview time before approving.', true); return; }");
  });
  it('an accepted set with a time the doctor cannot be offered shows the warning and "Add another time"', () => {
    expect(html).toContain('<div id="pdDoneWarn" class="pd-done-warn" hidden>');
    expect(html).toContain('<button id="pdDoneAddTime" class="pd-btn pd-btn-green" type="button">Add another time</button>');
    expect(html).toContain("(res.data.warnings && res.data.warnings.length && res.data.warningMessage) ? String(res.data.warningMessage) : ''");
    expect(html).toContain("doneAddTimeBtn.addEventListener('click', function () { enterAvailability('availability'); });");
    expect(html).toContain('.pd-done-warn[hidden] { display: none; }');
  });
  it('the inline script still parses', () => {
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.trim());
    expect(scripts.length).toBeGreaterThan(0);
    scripts.forEach((src) => expect(() => new Function(src)).not.toThrow());
  });
});

// Australian GP build, fix bundle FB-2a, R13: the remaining date handling is
// brought under THE CALENDAR-DATE RULE (CONVENTIONS section 25): these are
// calendar dates on the practice's own clock; "today" comes from
// auLifecycle.localDay; days are counted on dates, never as multiples of 24
// hours from an instant.
//
//   WP-11  pre-start task due dates              lib/au-prestart.js dueDateFor
//   WP-11  N13 reminder marks (3 and 7 days)     server.js runAuPrestartSweep
//   WP-12  "notice date is not in the future"    lib/au-doctor-details.js sanitiseNotice
//   WP-14  "visa already expired", task due dates lib/au-segment-b.js
//   WP-06  the 60-day Ahpra-expiry window        lib/au-staff-tools.js ahpraRecheckDue
//   WP-08  earliest start                        lib/role-eligibility.js auEarliestStart
//
// Each is asked at instants either side of midnight in UTC, Sydney and Perth.
// The file gives the same answers under any process time zone.
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const auPrestart = require('../lib/au-prestart.js');
const details = require('../lib/au-doctor-details.js');
const segB = require('../lib/au-segment-b.js');
const staffTools = require('../lib/au-staff-tools.js');
const roleEligibility = require('../lib/role-eligibility.js');
const lc = require('../lib/au-lifecycle.js');
const fees = require('../lib/au-placement-fees.js');

const SYD = 'Australia/Sydney';
const PER = 'Australia/Perth';
const ms = (s) => Date.parse(s);
// The calendar date in Sydney and in Perth at each instant, written out by hand.
const INSTANTS = [
  { at: '2026-11-21T12:30:00Z', why: 'late evening in Sydney, the same day everywhere', syd: '2026-11-21', per: '2026-11-21' },
  { at: '2026-11-21T13:30:00Z', why: 'half past midnight in Sydney; still the 21st in Perth and in UTC', syd: '2026-11-22', per: '2026-11-21' },
  { at: '2026-11-21T15:30:00Z', why: 'half an hour before midnight in Perth', syd: '2026-11-22', per: '2026-11-21' },
  { at: '2026-11-21T16:30:00Z', why: 'half past midnight in Perth; still the 21st in UTC', syd: '2026-11-22', per: '2026-11-22' },
  { at: '2026-11-21T23:30:00Z', why: 'half an hour before midnight UTC (the Australian morning)', syd: '2026-11-22', per: '2026-11-22' },
  { at: '2026-11-22T00:30:00Z', why: 'half past midnight UTC', syd: '2026-11-22', per: '2026-11-22' }
];

describe('the instants are what the table says', () => {
  it('auLifecycle.localDay', () => {
    for (const i of INSTANTS) {
      expect(lc.localDay(ms(i.at), SYD), i.why).toBe(i.syd);
      expect(lc.localDay(ms(i.at), PER), i.why).toBe(i.per);
    }
  });
});

describe('WP-11: pre-start task due dates', () => {
  const T = auPrestart.TASK_TYPE;
  it('"3 days after the placement" counts from the day it was recorded AT THE PRACTICE, at every instant', () => {
    for (const i of INSTANTS) {
      // Placed and raised at the same instant.
      const syd = auPrestart.dueDateFor(T.START_DATE_TRACKING, { placedAt: i.at, now: ms(i.at), zone: SYD });
      const per = auPrestart.dueDateFor(T.START_DATE_TRACKING, { placedAt: i.at, now: ms(i.at), zone: PER });
      expect(syd, i.why).toMatchObject({ date: fees.addDays(i.syd, 3), anchor: 'placement' });
      expect(per, i.why).toMatchObject({ date: fees.addDays(i.per, 3), anchor: 'placement' });
    }
  });

  it('THE REPORTED CASE: a task raised in the Australian morning is not due a day early', () => {
    // 08:30 on Monday 23 November in Sydney is 21:30 on the 22nd in UTC.
    const at = '2026-11-22T21:30:00Z';
    expect(lc.localDay(ms(at), SYD)).toBe('2026-11-23');
    expect(auPrestart.dueDateFor(T.START_DATE_TRACKING, { placedAt: at, now: ms(at), zone: SYD }).date).toBe('2026-11-26'); // was 2026-11-25
    expect(auPrestart.dueDateFor(T.PROVIDER_NUMBER_NEW_LOCATION, { placedAt: at, now: ms(at), zone: SYD }).date).toBe('2026-11-30'); // 7 days after
    expect(auPrestart.dueDateFor(T.INDEMNITY_CERTIFICATE, { placedAt: at, now: ms(at), zone: SYD }).date).toBe('2026-12-07');        // 14 days after
  });

  it('a date before the start date is counted on dates; never less than two days from today at the practice', () => {
    for (const i of INSTANTS) {
      expect(auPrestart.dueDateFor(T.INDEMNITY_CERTIFICATE, { startDate: '2027-02-01', now: ms(i.at), zone: SYD }).date, i.why).toBe('2027-01-18');
      expect(auPrestart.dueDateFor(T.PROVIDER_NUMBER_NEW_LOCATION, { startDate: '2027-02-01', now: ms(i.at), zone: PER }).date, i.why).toBe('2027-01-11');
      // A start date so close that the rule's date has passed: two days from today THERE.
      const soon = fees.addDays(i.syd, 5);
      expect(auPrestart.dueDateFor(T.INDEMNITY_CERTIFICATE, { startDate: soon, now: ms(i.at), zone: SYD }).date, i.why).toBe(fees.addDays(i.syd, 2));
      expect(auPrestart.dueDateFor(T.INDEMNITY_CERTIFICATE, { startDate: soon, now: ms(i.at), zone: PER }).date, i.why).toBe(fees.addDays(i.per, 2));
    }
  });

  it('no zone given: Sydney (the documented fallback), never the UTC date; a built task carries the same date', () => {
    const at = '2026-11-21T13:30:00Z'; // the 22nd in Sydney, the 21st in UTC
    expect(auPrestart.dueDateFor('reference_check', { now: ms(at) }).date).toBe(fees.addDays('2026-11-22', 5));
    const task = auPrestart.buildPrestartTask(T.START_DATE_TRACKING, { name: 'Dr Test', practiceName: 'Test Practice (FAKE)', placementKey: 'k', placedAt: at, now: ms(at), zone: PER });
    expect(String(task.due_date).slice(0, 10)).toBe('2026-11-24');
    expect(String(auPrestart.buildPrestartTask(T.START_DATE_TRACKING, { name: 'Dr Test', placementKey: 'k', placedAt: at, now: ms(at), zone: SYD }).due_date).slice(0, 10)).toBe('2026-11-25');
  });
});

describe('WP-12: "the notice date is not in the future"', () => {
  it('today at the practice is accepted, tomorrow there is refused, at every instant', () => {
    for (const i of INSTANTS) {
      for (const [zone, today] of [[SYD, i.syd], [PER, i.per]]) {
        expect(details.sanitiseNotice({ given: true, date: today }, { now: ms(i.at), zone }).ok, i.why + ' ' + zone).toBe(true);
        expect(details.sanitiseNotice({ given: true, date: fees.addDays(today, -1) }, { now: ms(i.at), zone }).ok, i.why + ' ' + zone).toBe(true);
        expect(details.sanitiseNotice({ given: true, date: fees.addDays(today, 1) }, { now: ms(i.at), zone }).errors.date, i.why + ' ' + zone).toMatch(/future/);
      }
    }
  });
  it('"too long ago" is two years of calendar days; an explicit today wins', () => {
    expect(details.sanitiseNotice({ given: true, date: '2024-11-21' }, { today: '2026-11-21' }).ok).toBe(true);
    // Round 8 (S8-05): the refusal says whose clock and what today is there.
    expect(details.sanitiseNotice({ given: true, date: '2026-11-22' }, { today: '2026-11-21', zoneLabel: 'Sydney time' }).errors.date)
      .toBe("That date is in the future on the practice's clock (Sydney time), where today is 21 November 2026. Record it once you have given notice.");
    expect(details.sanitiseNotice({ given: true, date: '2026-11-22' }, { today: '2026-11-21' }).errors.date)
      .toBe("That date is in the future on the practice's clock, where today is 21 November 2026. Record it once you have given notice.");
    // the doctor's page takes the field's latest date from the server's day, not the phone's
    const preSrc = require('fs').readFileSync(require('path').join(process.cwd(), 'js/au-prestart.js'), 'utf8');
    // eslint-disable-next-line no-new-func
    const maxDay = new Function('todayIso', preSrc.slice(preSrc.indexOf('function noticeMaxDay(view) {'), preSrc.indexOf('function formsFor(item, view, ui) {')) + '; return noticeMaxDay;')(() => '2026-11-20');
    expect(maxDay({ practiceToday: '2026-11-21' })).toBe('2026-11-21');
    expect(maxDay({})).toBe('2026-11-20');
    expect(maxDay({ practiceToday: '"><script>' })).toBe('2026-11-20');
    expect(preSrc).toContain("data-au-notice-date max=\"' + esc(noticeMaxDay(view)) + '\"");
    expect(details.sanitiseNotice({ given: true, date: '2024-11-19' }, { today: '2026-11-21' }).errors.date).toMatch(/too long ago/);
  });
});

describe('WP-14: the visa-expiry check and the segment B due dates', () => {
  const body = (expiry) => ({ decision: segB.DECISION.TRANSFER_NEEDED, current_sponsor: 'Test Current Practice (FAKE)', visa_expiry: expiry, visa_subclass: '482', note: 'Confirmed with the doctor.' });
  it('a visa that runs out today at the practice has not "already expired"; yesterday there has', () => {
    const transferKey = Object.keys(segB.DECISION).map((k) => segB.DECISION[k]).filter((v) => v !== segB.DECISION.NOT_NEEDED)[0];
    const b = (expiry) => Object.assign(body(expiry), { decision: transferKey });
    for (const i of INSTANTS) {
      for (const [zone, today] of [[SYD, i.syd], [PER, i.per]]) {
        expect(segB.validateTransferDecision(b(today), { now: ms(i.at), zone }).ok, i.why + ' ' + zone).toBe(true);
        expect(segB.validateTransferDecision(b(fees.addDays(today, -1)), { now: ms(i.at), zone }).errors.visa_expiry, i.why + ' ' + zone).toMatch(/already expired/);
      }
    }
  });
  it('a due date is today at the practice plus whole days (source: every dueInDays call passes the zone)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib/au-segment-b.js'), 'utf8');
    expect(src).toMatch(/function dueInDays\(days, now, zone\) \{\s*return fees\.addDays\(localToday\(now, zone\), days\);/);
    expect(src.match(/dueInDays\(/g).length).toBe(5);
    expect(src.match(/dueInDays\([^)]*, i\.now, i\.zone\)/g).length).toBe(4);
    expect(src).not.toMatch(/toISOString\(\)\.slice\(0, 10\)/);
  });
});

describe('WP-06: the 60-day Ahpra-expiry window', () => {
  const cred = (expiry, checkedAt) => ({ registration_expiry: expiry, ahpra_last_checked_at: checkedAt });
  it('the window opens exactly 60 calendar days before the expiry date, on the Australian date, at every instant', () => {
    for (const i of INSTANTS) {
      const today = i.syd;
      // Checked long before the window opened.
      const checked = new Date(ms(i.at) - 200 * 86400000).toISOString();
      expect(staffTools.ahpraRecheckDue(cred(fees.addDays(today, 61), checked), ms(i.at)), i.why).toMatchObject({ due: false, daysToExpiry: 61 });
      expect(staffTools.ahpraRecheckDue(cred(fees.addDays(today, 60), checked), ms(i.at)), i.why).toMatchObject({ due: true, reason: 'expiry_soon', daysToExpiry: 60 });
      // The expiry date itself counts as expired, as before; the day before does not.
      expect(staffTools.ahpraRecheckDue(cred(today, checked), ms(i.at)), i.why).toMatchObject({ due: true, daysToExpiry: 0 });
      expect(staffTools.ahpraRecheckDue(cred(fees.addDays(today, -3), checked), ms(i.at)).daysToExpiry, i.why).toBe(-3);
    }
  });
  it('a check made inside the window is not asked for again; one made before it opened is', () => {
    const now = ms('2026-11-21T23:30:00Z');             // the 22nd in Australia
    const expiry = '2027-01-10';                        // window opened on 11 November
    expect(staffTools.ahpraRecheckDue(cred(expiry, '2026-11-12T03:00:00Z'), now).due).toBe(false);
    expect(staffTools.ahpraRecheckDue(cred(expiry, '2026-11-09T03:00:00Z'), now)).toMatchObject({ due: true, reason: 'expiry_soon' });
    // The yearly re-check is counted in calendar days too.
    expect(staffTools.ahpraRecheckDue(cred('2028-01-01', '2025-11-21T03:00:00Z'), now)).toMatchObject({ due: true, reason: 'annual_recheck', daysSinceCheck: 366 });
    expect(staffTools.ahpraRecheckDue(cred('2028-01-01', '2025-11-22T03:00:00Z'), now)).toMatchObject({ due: false, daysSinceCheck: 365 });
  });
});

describe('WP-08: earliest start', () => {
  it('a notice period runs from today on the Australian clock, at every instant', () => {
    for (const i of INSTANTS) {
      expect(roleEligibility.auEarliestStart({ notice_period_weeks: 4 }, ms(i.at)), i.why).toEqual({ iso: fees.addDays(i.syd, 28), basis: 'notice_period' });
      expect(roleEligibility.auEarliestStart({ notice_period_weeks: 4 }, ms(i.at), { zone: PER }), i.why).toEqual({ iso: fees.addDays(i.per, 28), basis: 'notice_period' });
      expect(roleEligibility.auEarliestStart({ available_from: '2020-01-01' }, ms(i.at)), i.why).toEqual({ iso: i.syd, basis: 'available_from' });
    }
  });
  it('the later of the two still wins; nothing on file is still "not known"', () => {
    const now = ms('2026-11-21T13:30:00Z');
    expect(roleEligibility.auEarliestStart({ available_from: '2027-03-01', notice_period_weeks: 4 }, now)).toEqual({ iso: '2027-03-01', basis: 'both' });
    expect(roleEligibility.auEarliestStart({ available_from: '2026-11-25', notice_period_weeks: 4 }, now)).toEqual({ iso: '2026-12-20', basis: 'both' });
    expect(roleEligibility.auEarliestStart({}, now)).toEqual({ iso: '', basis: 'none' });
  });
});

describe('N13 reminder marks and the rule in the source', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  it('the daily pre-start pass counts calendar days at the practice', () => {
    expect(server).toMatch(/auPlacementFees\.daysBetween\(auLifecycle\.localDay\(placedMs, [a-zA-Z0-9_.]+\), auLifecycle\.localDay\(nowMs, [a-zA-Z0-9_.]+\)\)/);
    const sweep = server.slice(server.indexOf('async function runAuPrestartSweep('), server.indexOf('// Australian GP build, WP-17: the lifecycle messages'));
    expect(sweep).not.toMatch(/\(24 \* 60 \* 60 \* 1000\)/);
  });
  it('marks: day 3 and day 7 are the third and seventh calendar day after the placement date there', () => {
    const mark = (placedAt, now, zone) => { const d = fees.daysBetween(lc.localDay(ms(placedAt), zone), lc.localDay(ms(now), zone)); return d >= 7 ? 'd7' : (d >= 3 ? 'd3' : ''); };
    // Placed at 08:00 Sydney on Monday 23 Nov (21:00 UTC on the 22nd). The daily
    // job at 20:30 UTC on Wednesday the 25th is Thursday the 26th there: day 3.
    expect(mark('2026-11-22T21:00:00Z', '2026-11-25T20:30:00Z', SYD)).toBe('d3');
    // Elapsed time then is 71.5 hours: the old rule (whole 24-hour periods) said "not yet".
    expect(Math.floor((ms('2026-11-25T20:30:00Z') - ms('2026-11-22T21:00:00Z')) / 86400000)).toBe(2);
    expect(mark('2026-11-22T21:00:00Z', '2026-11-24T20:30:00Z', SYD)).toBe('');
    expect(mark('2026-11-22T21:00:00Z', '2026-11-29T20:30:00Z', SYD)).toBe('d7');
  });
  it('the notice route passes the practice\'s zone', () => {
    // Round 8 (S8-05): the zone is read once and its words are passed too, so the refusal names the clock.
    expect(server).toContain("const auNoticeZone = await auPracticeZoneFor(auPreView && auPreView._practiceId);");
    expect(server).toContain("auDoctorDetails.sanitiseNotice(auPreBody, { zone: auNoticeZone, zoneLabel: auZoneWords(auNoticeZone) })");
  });
  it('none of the six sites reads the UTC date any more', () => {
    for (const f of ['lib/au-prestart.js', 'lib/au-doctor-details.js', 'lib/au-staff-tools.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      const fn = f === 'lib/au-prestart.js' ? src.slice(src.indexOf('function dueDateFor('), src.indexOf('function baseMetadata('))
        : (f === 'lib/au-doctor-details.js' ? src.slice(src.indexOf('function sanitiseNotice('), src.indexOf('// A prescriber number'))
          : src.slice(src.indexOf('function ahpraRecheckDue('), src.indexOf('const CHECK_REASON_TEXT')));
      expect(fn, f).toContain('auLifecycle.localDay(');
      expect(fn, f).not.toMatch(/DAY_MS|toISOString\(\)|isoDay\(/);
    }
    const re = fs.readFileSync(path.join(__dirname, '..', 'lib/role-eligibility.js'), 'utf8');
    const fn = re.slice(re.indexOf('function auEarliestStart('), re.indexOf('module.exports = {\n  auEarliestStart,'));
    expect(fn).toContain('auLifecycleLib.localDay(');
    expect(fn).not.toMatch(/toISOString\(\)|86400000|getUTC/);
  });
});

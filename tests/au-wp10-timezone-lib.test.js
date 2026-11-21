// WP-10 (Australian GP build): the one time-zone resolver and everything pure
// that is built on it. lib/au-timezone.js, and its call sites in
// lib/consult-reminders.js and lib/lead-calls.js.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tz = require('../lib/au-timezone.js');
const interviewMeetings = require('../lib/interview-meetings.js');
const interviewScheduler = require('../lib/interview-scheduler.js');
const consultReminders = require('../lib/consult-reminders.js');
const consultNoShow = require('../lib/consult-noshow.js');
const leadCalls = require('../lib/lead-calls.js');
const auLead = require('../lib/au-lead.js');

const saved = process.env.AU_PATHWAY_ENABLED;
afterEach(() => {
  if (saved === undefined) delete process.env.AU_PATHWAY_ENABLED;
  else process.env.AU_PATHWAY_ENABLED = saved;
  delete process.env.AU_INTERVIEW_PRACTICE_HOURS;
  delete process.env.AU_INTERVIEW_GP_HOURS;
  delete process.env.AU_INTERVIEW_WEEKENDS;
});

const HOUR = 3600000;
const offsetHours = (iso, zone) => interviewScheduler.tzOffsetMs(Date.parse(iso), zone) / HOUR;

describe('the state table is the single one (lib/interview-meetings.js AU_STATE_TZ)', () => {
  it('is the same object the practice side uses, and covers all eight states and territories', () => {
    expect(tz.AU_STATE_TZ).toBe(interviewMeetings.AU_STATE_TZ);
    expect(tz.AU_STATE_TZ).toEqual({
      NSW: 'Australia/Sydney', VIC: 'Australia/Melbourne', QLD: 'Australia/Brisbane', SA: 'Australia/Adelaide',
      WA: 'Australia/Perth', TAS: 'Australia/Hobart', NT: 'Australia/Darwin', ACT: 'Australia/Sydney'
    });
    for (const code of Object.keys(tz.AU_STATE_TZ)) {
      expect(interviewMeetings.practiceTzForLocation('', code, '')).toBe(tz.AU_STATE_TZ[code]);
    }
  });

  it.each([
    ['WA', 'WA'], ['wa', 'WA'], [' Wa ', 'WA'], ['Western Australia', 'WA'], ['western  australia', 'WA'],
    ['New South Wales', 'NSW'], ['Victoria', 'VIC'], ['queensland', 'QLD'], ['South Australia', 'SA'],
    ['Tasmania', 'TAS'], ['Northern Territory', 'NT'], ['Australian Capital Territory', 'ACT'], ['act', 'ACT'],
    ['', ''], [null, ''], [undefined, ''], ['uk', ''], ['Washington', ''], ['NZ', ''], [42, ''], [{}, '']
  ])('normaliseAuState(%j) → %j', (input, expected) => {
    expect(tz.normaliseAuState(input)).toBe(expected);
  });
});

describe('daylight saving: NSW, VIC, TAS, ACT and SA move; QLD, NT and WA never do', () => {
  // NSW/VIC/TAS/ACT/SA: clocks go back on the first Sunday of April (2027-04-04
  // 03:00 local) and forward on the first Sunday of October (2027-10-03 02:00).
  const summer = '2027-01-15T02:00:00.000Z';
  const winter = '2027-07-15T02:00:00.000Z';
  const table = [
    ['NSW', 11, 10], ['ACT', 11, 10], ['VIC', 11, 10], ['TAS', 11, 10], ['SA', 10.5, 9.5],
    ['QLD', 10, 10], ['NT', 9.5, 9.5], ['WA', 8, 8]
  ];
  it.each(table)('%s: UTC+%d in January, UTC+%d in July', (state, summerOffset, winterOffset) => {
    const zone = tz.resolveZone({ state }).zone;
    expect(offsetHours(summer, zone)).toBe(summerOffset);
    expect(offsetHours(winter, zone)).toBe(winterOffset);
  });

  it.each(table)('%s: either side of the April and October changes', (state, summerOffset, winterOffset) => {
    const zone = tz.zoneForAuState(state);
    // 2027-04-03T15:59Z is one minute before the autumn change in the eastern
    // states (16:00Z); 2027-04-03T17:00Z is after it everywhere that changes
    // (South Australia changes at 16:30Z).
    expect(offsetHours('2027-04-03T15:59:00.000Z', zone)).toBe(summerOffset);
    expect(offsetHours('2027-04-03T17:00:00.000Z', zone)).toBe(winterOffset);
    // Spring: the eastern states change at 2027-10-02T16:00Z, SA at 16:30Z.
    expect(offsetHours('2027-10-02T15:59:00.000Z', zone)).toBe(winterOffset);
    expect(offsetHours('2027-10-02T17:00:00.000Z', zone)).toBe(summerOffset);
  });

  it('so 10:00 in Sydney is 07:00 in Perth in summer and 08:00 in winter', () => {
    const perth = (iso) => tz.clockIn('Australia/Perth', Date.parse(iso));
    const sydneyTenSummer = interviewScheduler.wallTimeToUtc('2027-01-15', 600, 'Australia/Sydney').toISOString();
    const sydneyTenWinter = interviewScheduler.wallTimeToUtc('2027-07-15', 600, 'Australia/Sydney').toISOString();
    expect(perth(sydneyTenSummer).minutes).toBe(7 * 60);
    expect(perth(sydneyTenWinter).minutes).toBe(8 * 60);
  });
});

describe('validZone: a client-supplied zone is checked before it is trusted', () => {
  it.each([
    ['Australia/Perth', 'Australia/Perth'],
    ['  Australia/Perth  ', 'Australia/Perth'],
    ['australia/perth', 'Australia/Perth'],
    ['Europe/London', 'Europe/London'],
    ['America/Argentina/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
    ['Pacific/Auckland', 'Pacific/Auckland']
  ])('accepts %j', (input, expected) => {
    expect(tz.validZone(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'], [null, 'null'], [undefined, 'undefined'], [42, 'a number'], [{}, 'an object'], [['Australia/Perth'], 'an array'],
    ['UTC', 'UTC says nothing about where the person is'], ['GMT', 'GMT'], ['Etc/UTC', 'the Etc family'], ['Etc/GMT+10', 'the Etc family'],
    ['EST', 'an abbreviation'], ['Perth', 'a bare city'], ['AWST', 'an abbreviation'],
    ['Mars/Olympus_Mons', 'not a real zone'], ['Australia/Atlantis', 'not a real zone'],
    ['Australia/Perth; DROP TABLE users', 'injection'], ['<script>alert(1)</script>', 'markup'],
    ['../../etc/passwd', 'a path'], ['Australia/Perth\nX-Header: 1', 'a header split'],
    ['A'.repeat(70) + '/B', 'too long'], ['Australia/', 'half a zone'], ['/Perth', 'half a zone']
  ])('ignores %j (%s)', (input) => {
    expect(tz.validZone(input)).toBe('');
  });
});

describe('resolveZone: booker zone, then browser zone, then state, then dial code, then country', () => {
  const everything = { bookerZone: 'Australia/Brisbane', browserZone: 'Australia/Adelaide', state: 'WA', phone: '+61412345678', country: 'au' };
  it.each([
    ['all five signals: the zone they booked in wins', everything, 'Australia/Brisbane', 'booker', true],
    ['no booking: the browser zone', Object.assign({}, everything, { bookerZone: '' }), 'Australia/Adelaide', 'browser', true],
    ['no browser either: the state', Object.assign({}, everything, { bookerZone: '', browserZone: '' }), 'Australia/Perth', 'state', true],
    ['only a +61 number: Australia, zone unknown, Sydney as a last resort', { phone: '+61412345678' }, 'Australia/Sydney', 'dial_code', false],
    ['+61 written 0061', { phone: '0061412345678' }, 'Australia/Sydney', 'dial_code', false],
    ['only "Australia": Sydney, marked uncertain', { country: 'Australia' }, 'Australia/Sydney', 'country', false],
    ['only "au"', { country: 'au' }, 'Australia/Sydney', 'country', false],
    ['a +44 number', { phone: '+447911123456' }, 'Europe/London', 'dial_code', true],
    ['a +353 number', { phone: '+353871234567' }, 'Europe/Dublin', 'dial_code', true],
    ['a +64 number', { phone: '+64211234567' }, 'Pacific/Auckland', 'dial_code', true],
    ['the dial code beats the country', { phone: '+64211234567', country: 'au' }, 'Pacific/Auckland', 'dial_code', true],
    ['the state beats the dial code', { state: 'QLD', phone: '+447911123456' }, 'Australia/Brisbane', 'state', true],
    ['country nz', { country: 'New Zealand' }, 'Pacific/Auckland', 'country', true],
    ['nothing at all: the long-standing default, marked uncertain', {}, 'Europe/London', 'default', false],
    ['null', null, 'Europe/London', 'default', false],
    ['an unknown number and country', { phone: '+15551234567', country: 'other' }, 'Europe/London', 'default', false]
  ])('%s', (_label, signals, zone, source, certain) => {
    expect(tz.resolveZone(signals)).toEqual({ zone, source, certain });
  });

  it('an invalid booker or browser zone is skipped, never used and never returned', () => {
    expect(tz.resolveZone({ bookerZone: 'Mars/Olympus_Mons', browserZone: 'UTC', state: 'WA' })).toEqual({ zone: 'Australia/Perth', source: 'state', certain: true });
    expect(tz.resolveZone({ bookerZone: '<script>', browserZone: 'Australia/Darwin' })).toEqual({ zone: 'Australia/Darwin', source: 'browser', certain: true });
    expect(tz.resolveZone({ browserZone: 'Etc/GMT-8', phone: '+61412345678' })).toEqual({ zone: 'Australia/Sydney', source: 'dial_code', certain: false });
  });

  it('every state resolves to its own zone with source "state"', () => {
    for (const code of tz.AU_STATES) {
      expect(tz.resolveZone({ state: code, phone: '+61412345678', country: 'au' })).toEqual({ zone: tz.AU_STATE_TZ[code], source: 'state', certain: true });
    }
  });
});

describe('leads: who gets the resolver, and what is stored on the lead', () => {
  const waLead = { id: 'l1', kind: 'gp', phone: '+61412345678', state: 'au', metadata: { consult: { country: 'au', state: 'WA', qualified: true } } };
  const ukLead = { id: 'l2', kind: 'gp', phone: '+447911123456', state: 'uk', metadata: { consult: { country: 'uk', qualified: true } } };
  const ukInAu = { id: 'l3', kind: 'gp', phone: '+61412345678', state: 'uk', metadata: { consult: { country: 'uk', qualified: true, state: 'WA', timezone: 'Australia/Perth', timezone_source: 'browser' } } };

  it('an Australian-segment lead with the switch on is resolved; with it off the helper answers null', () => {
    expect(tz.auLeadZone(waLead, { auPathwayEnabled: true })).toEqual({ zone: 'Australia/Perth', source: 'state', certain: true });
    expect(tz.auLeadZone(waLead.metadata.consult, { auPathwayEnabled: true, phone: '+61412345678' }).zone).toBe('Australia/Perth');
    expect(tz.auLeadZone(waLead, { auPathwayEnabled: false })).toBeNull();
    process.env.AU_PATHWAY_ENABLED = 'false';
    expect(tz.auLeadZone(waLead)).toBeNull();
    process.env.AU_PATHWAY_ENABLED = 'true';
    expect(tz.auLeadZone(waLead).zone).toBe('Australia/Perth');
  });

  it('an overseas lead is never resolved here, whatever is stored on it (the UK-trained GP in Australia stays overseas until WP-15)', () => {
    expect(tz.auLeadZone(ukLead, { auPathwayEnabled: true })).toBeNull();
    expect(tz.auLeadZone(ukInAu, { auPathwayEnabled: true })).toBeNull();
    expect(tz.auLeadZone(null, { auPathwayEnabled: true })).toBeNull();
    expect(tz.auLeadZone({ metadata: {} }, { auPathwayEnabled: true })).toBeNull();
    expect(auLead.isAuSegmentLead(ukInAu)).toBe(false);
  });

  it('precedence on the lead: the booking in hand, a stored Calendly zone, a stored browser zone, the state, then Sydney', () => {
    const lead = (consult) => ({ kind: 'gp', phone: '+61412345678', metadata: { consult: Object.assign({ country: 'au' }, consult) } });
    const on = { auPathwayEnabled: true };
    expect(tz.auLeadZone(lead({ state: 'WA', timezone: 'Australia/Adelaide', timezone_source: 'browser' }), Object.assign({ bookingZone: 'Australia/Brisbane' }, on)))
      .toEqual({ zone: 'Australia/Brisbane', source: 'booker', certain: true });
    expect(tz.auLeadZone(lead({ state: 'WA', timezone: 'Australia/Hobart', timezone_source: 'calendly' }), on)).toEqual({ zone: 'Australia/Hobart', source: 'booker', certain: true });
    expect(tz.auLeadZone(lead({ state: 'WA', timezone: 'Australia/Adelaide', timezone_source: 'browser' }), on)).toEqual({ zone: 'Australia/Adelaide', source: 'browser', certain: true });
    expect(tz.auLeadZone(lead({ state: 'WA' }), on)).toEqual({ zone: 'Australia/Perth', source: 'state', certain: true });
    expect(tz.auLeadZone(lead({}), on)).toEqual({ zone: 'Australia/Sydney', source: 'dial_code', certain: false });
    expect(tz.auLeadZone({ kind: 'gp', phone: '', metadata: { consult: { country: 'au' } } }, on)).toEqual({ zone: 'Australia/Sydney', source: 'country', certain: false });
    // a poisoned stored value is ignored
    expect(tz.auLeadZone(lead({ state: 'NT', timezone: 'Mars/Olympus_Mons', timezone_source: 'calendly' }), on)).toEqual({ zone: 'Australia/Darwin', source: 'state', certain: true });
  });

  it('withLeadZone stores only a validated zone, and a browser zone never replaces a booking zone', () => {
    const c = { country: 'au' };
    expect(tz.withLeadZone(c, 'Australia/Perth', 'browser')).toEqual({ country: 'au', timezone: 'Australia/Perth', timezone_source: 'browser' });
    expect(c).toEqual({ country: 'au' }); // not mutated
    expect(tz.withLeadZone(c, 'not a zone', 'browser')).toBe(c);
    expect(tz.withLeadZone(c, 'UTC', 'browser')).toBe(c);
    expect(tz.withLeadZone(c, '<img src=x>', 'calendly')).toBe(c);
    expect(tz.withLeadZone(c, 'Australia/Perth', 'somewhere')).toBe(c);
    const booked = { country: 'au', timezone: 'Australia/Brisbane', timezone_source: 'calendly' };
    expect(tz.withLeadZone(booked, 'Australia/Perth', 'browser')).toBe(booked);
    expect(tz.withLeadZone(booked, 'Australia/Brisbane', 'calendly')).toBe(booked); // unchanged: nothing to write
    expect(tz.withLeadZone(booked, 'Australia/Perth', 'calendly')).toEqual({ country: 'au', timezone: 'Australia/Perth', timezone_source: 'calendly' });
    const browsed = { country: 'au', timezone: 'Australia/Perth', timezone_source: 'browser' };
    expect(tz.withLeadZone(browsed, 'Australia/Darwin', 'calendly').timezone).toBe('Australia/Darwin');
  });

  it('withLeadState (the WP-15 hook) stores a state code and refuses anything else', () => {
    const c = { country: 'au' };
    expect(tz.withLeadState(c, 'Western Australia')).toEqual({ country: 'au', state: 'WA' });
    expect(tz.withLeadState(c, 'wa')).toEqual({ country: 'au', state: 'WA' });
    expect(tz.withLeadState(c, 'Texas')).toBe(c);
    expect(tz.withLeadState(c, '')).toBe(c);
    const already = { country: 'au', state: 'WA' };
    expect(tz.withLeadState(already, 'WA')).toBe(already);
  });
});

describe('COM-38: an Australian lead is told their own time, with a label that names the city', () => {
  const call = '2026-11-24T02:00:00.000Z'; // Tue 24 Nov: 1:00 pm Sydney, 10:00 am Perth, 12:00 pm Brisbane, 12:30 pm Adelaide
  const consult = (extra) => Object.assign({ country: 'au', qualified: true }, extra);

  it('a Perth lead: every consult message says Perth time, never Sydney and never "(UK time)"', () => {
    process.env.AU_PATHWAY_ENABLED = 'true';
    const zone = consultReminders.consultLeadTimeZone(consult({ state: 'WA' }), '+61412345678');
    expect(zone).toBe('Australia/Perth');
    expect(consultReminders.formatLeadCallTime(call, zone)).toBe('Tuesday 24 November, 10:00 am (Perth time)');
    expect(consultReminders.formatLeadCallTimeShort(call, zone)).toBe('Tue 24 Nov, 10:00 am Perth time');
    expect(consultReminders.formatLeadCallClock(call, zone)).toBe('10:00 am (Perth time)');
    const dayBefore = consultReminders.buildConsultReminderEmail('email_h24', { name: 'Dr Test Perth', callAtIso: call, timeZone: zone, joinUrl: 'https://zoom.us/j/1' });
    const hourBefore = consultReminders.buildConsultReminderEmail('email_h1', { name: 'Dr Test Perth', callAtIso: call, timeZone: zone, joinUrl: 'https://zoom.us/j/1' });
    for (const email of [dayBefore, hourBefore]) {
      const all = [email.subject, email.text, email.body].join('\n');
      expect(all).toContain('10:00 am (Perth time)');
      expect(all).not.toMatch(/UK time|Sydney time|1:00 pm/);
    }
    const page = consultReminders.consultReplyPageSummary({ decision: { why: 'upcoming', callAtMs: Date.parse(call) }, name: 'Dr Test Perth', phone: '+61412345678', text: 'ok', timeZone: zone });
    expect(page.status).toContain('Tue 24 Nov, 10:00 am Perth time');
    expect(consultNoShow.slotInWords(call, tz.auLeadZone(consult({ state: 'WA' })).zone)).toBe('Tuesday 24 November at 10:00 am');
  });

  it.each([
    ['NSW', 'Tuesday 24 November, 1:00 pm (Sydney time)'],
    ['ACT', 'Tuesday 24 November, 1:00 pm (Sydney time)'],
    ['VIC', 'Tuesday 24 November, 1:00 pm (Melbourne time)'],
    ['TAS', 'Tuesday 24 November, 1:00 pm (Hobart time)'],
    ['QLD', 'Tuesday 24 November, 12:00 pm (Brisbane time)'],
    ['SA', 'Tuesday 24 November, 12:30 pm (Adelaide time)'],
    ['NT', 'Tuesday 24 November, 11:30 am (Darwin time)'],
    ['WA', 'Tuesday 24 November, 10:00 am (Perth time)']
  ])('state %s → %s', (state, expected) => {
    process.env.AU_PATHWAY_ENABLED = 'true';
    const zone = consultReminders.consultLeadTimeZone(consult({ state }), '+61412345678');
    expect(consultReminders.formatLeadCallTime(call, zone)).toBe(expected);
  });

  it('the zone they booked in beats the state; a +61 number alone falls back to Sydney and says so by name', () => {
    process.env.AU_PATHWAY_ENABLED = 'true';
    expect(consultReminders.consultLeadTimeZone(consult({ state: 'WA' }), '+61412345678', { bookingZone: 'Australia/Brisbane' })).toBe('Australia/Brisbane');
    expect(consultReminders.consultLeadTimeZone(consult({ timezone: 'Australia/Perth', timezone_source: 'calendly' }), '+61412345678')).toBe('Australia/Perth');
    const unknown = consultReminders.consultLeadTimeZone(consult({}), '+61412345678');
    expect(unknown).toBe('Australia/Sydney');
    expect(consultReminders.formatLeadCallTime(call, unknown)).toBe('Tuesday 24 November, 1:00 pm (Sydney time)');
  });

  it('switch off: the same Perth lead is on Sydney time, exactly as before', () => {
    process.env.AU_PATHWAY_ENABLED = 'false';
    const zone = consultReminders.consultLeadTimeZone(consult({ state: 'WA', timezone: 'Australia/Perth', timezone_source: 'calendly' }), '+61412345678', { bookingZone: 'Australia/Perth' });
    expect(zone).toBe('Australia/Sydney');
    expect(consultReminders.formatLeadCallTime(call, zone)).toBe('Tuesday 24 November, 1:00 pm (Sydney time)');
  });

  it('a UK lead with an Australian state and browser zone on file is still told UK time (overseas parity)', () => {
    process.env.AU_PATHWAY_ENABLED = 'true';
    const uk = { country: 'uk', qualified: true, state: 'WA', timezone: 'Australia/Perth', timezone_source: 'browser' };
    expect(consultReminders.consultLeadTimeZone(uk, '+61412345678', { bookingZone: 'Australia/Perth' })).toBe('Europe/London');
    expect(consultReminders.formatLeadCallTime(call, 'Europe/London')).toBe('Tuesday 24 November, 2:00 am (UK time)');
  });

  it('labels: plain words for every Australian zone, and the abbreviation Australians use', () => {
    expect(tz.AU_ZONE_LABELS).toEqual({
      'Australia/Sydney': 'Sydney time', 'Australia/Melbourne': 'Melbourne time', 'Australia/Brisbane': 'Brisbane time',
      'Australia/Adelaide': 'Adelaide time', 'Australia/Perth': 'Perth time', 'Australia/Hobart': 'Hobart time', 'Australia/Darwin': 'Darwin time'
    });
    expect(tz.auZoneLabel('Europe/London')).toBe('');
    expect(tz.auZoneAbbreviation('Australia/Perth', call)).toBe('AWST');
    expect(tz.auZoneAbbreviation('Australia/Sydney', call)).toBe('AEDT');
    expect(tz.auZoneAbbreviation('Australia/Sydney', '2027-07-01T00:00:00.000Z')).toBe('AEST');
    expect(tz.auZoneAbbreviation('Australia/Adelaide', call)).toBe('ACDT');
    expect(tz.auZoneAbbreviation('Not/AZone', call)).toBe('');
  });
});

describe('lead-call window by state: never before 09:00 local (the Australian skip still comes first)', () => {
  const lead = (state, extra) => ({
    id: 'lead-' + state, kind: 'gp', name: 'Dr Test ' + state, email: state + '@gplink-test.local', phone: '+61412345678', state: 'au',
    status: 'new', created_at: '2026-11-20T00:00:00.000Z',
    metadata: { source: 'site_start_form', consult: Object.assign({ country: 'au', state, qualified: true, call_booked: false, nudges: [] }, extra || {}) }
  });
  const cfg = leadCalls.parseLeadCallConfig({
    LEAD_CALLS_ENABLED: 'true', RETELL_API_KEY: 'k', RETELL_AGENT_ID: 'a', RETELL_FROM_NUMBER_UK: '+442000000000', RETELL_FROM_NUMBER_AU: '+61200000000'
  }, { ignoreRuntime: true });
  // Tuesday 24 Nov 2026. 09:00 local in each state, as a UTC instant.
  const nineAm = { NSW: '2026-11-23T22:00:00.000Z', VIC: '2026-11-23T22:00:00.000Z', TAS: '2026-11-23T22:00:00.000Z', ACT: '2026-11-23T22:00:00.000Z', QLD: '2026-11-23T23:00:00.000Z', SA: '2026-11-23T22:30:00.000Z', NT: '2026-11-23T23:30:00.000Z', WA: '2026-11-24T01:00:00.000Z' };

  it.each(Object.keys(nineAm))('%s: closed one minute before 09:00 local, open at 09:00, closed at 19:30', (state) => {
    process.env.AU_PATHWAY_ENABLED = 'true';
    const open = Date.parse(nineAm[state]);
    expect(leadCalls.isWithinLeadCallWindow(lead(state), open - 60000)).toBe(false);
    expect(leadCalls.isWithinLeadCallWindow(lead(state), open)).toBe(true);
    expect(leadCalls.isWithinLeadCallWindow(lead(state), open + 10.5 * HOUR - 60000)).toBe(true);
    expect(leadCalls.isWithinLeadCallWindow(lead(state), open + 10.5 * HOUR)).toBe(false);
  });

  it('a Perth lead is not inside the window at 09:00 Sydney time (06:00 in Perth)', () => {
    process.env.AU_PATHWAY_ENABLED = 'true';
    const nineSydney = Date.parse(nineAm.NSW);
    expect(tz.clockIn('Australia/Perth', nineSydney).minutes).toBe(6 * 60);
    expect(leadCalls.leadCallZone(lead('WA'), 'au')).toBe('Australia/Perth');
    expect(leadCalls.isWithinLeadCallWindow(lead('WA'), nineSydney)).toBe(false);
    expect(leadCalls.isWithinLeadCallWindow(lead('NSW'), nineSydney)).toBe(true);
    // with the switch off the window is the Sydney one it always was
    expect(leadCalls.isWithinLeadCallWindow(lead('WA'), nineSydney, undefined, { auPathwayEnabled: false })).toBe(true);
  });

  it('never on a Sunday before 10:00 local, and never at 03:00 anywhere', () => {
    process.env.AU_PATHWAY_ENABLED = 'true';
    for (const state of Object.keys(nineAm)) {
      const zone = leadCalls.leadCallZone(lead(state), 'au');
      for (let h = 0; h < 7 * 24; h++) {
        const t = Date.parse('2026-11-22T00:00:00.000Z') + h * HOUR;
        if (!leadCalls.isWithinLeadCallWindow(lead(state), t)) continue;
        const clock = tz.clockIn(zone, t);
        expect(clock.minutes, state + ' ' + new Date(t).toISOString()).toBeGreaterThanOrEqual(9 * 60);
        expect(clock.minutes).toBeLessThan(19 * 60 + 30);
      }
    }
  });

  it('and Hazel still never rings one: the au_segment skip answers first, in or out of hours, switch on or off', () => {
    for (const state of ['true', 'false']) {
      process.env.AU_PATHWAY_ENABLED = state;
      for (const st of Object.keys(nineAm)) {
        for (const at of [Date.parse(nineAm[st]) + HOUR, Date.parse(nineAm[st]) - 5 * HOUR]) {
          expect(leadCalls.leadCallDecision({ row: lead(st), nowMs: at, cfg })).toEqual({ action: 'skip', reason: 'au_segment' });
          expect(leadCalls.leadCallDecision({ row: lead(st, { call_back_at: new Date(at - HOUR).toISOString() }), nowMs: at, cfg, ignoreHours: true })).toEqual({ action: 'skip', reason: 'au_segment' });
        }
      }
    }
  });

  it('the prompt variables for an inbound call from a Perth lead carry Perth time', () => {
    process.env.AU_PATHWAY_ENABLED = 'true';
    const vars = leadCalls.buildLeadCallVariables({ row: lead('WA'), nowMs: Date.parse('2026-11-24T02:00:00.000Z'), attempt: 1 });
    expect(vars.lead_timezone).toBe('Australia/Perth');
    expect(vars.local_time_now).toBe('Tuesday 10:00 am');
    process.env.AU_PATHWAY_ENABLED = 'false';
    expect(leadCalls.buildLeadCallVariables({ row: lead('WA'), nowMs: Date.parse('2026-11-24T02:00:00.000Z'), attempt: 1 }).lead_timezone).toBe('Australia/Sydney');
  });
});

describe('doctors: the zone on the profile', () => {
  it('device on this request, then the stored zone, then the state, then Sydney', () => {
    expect(tz.auDoctorZone({ profile: { timezone: 'Australia/Adelaide', current_state: 'WA' }, viewerZone: 'Australia/Brisbane' })).toEqual({ zone: 'Australia/Brisbane', source: 'browser', certain: true });
    expect(tz.auDoctorZone({ profile: { timezone: 'Australia/Adelaide', current_state: 'WA' } })).toEqual({ zone: 'Australia/Adelaide', source: 'browser', certain: true });
    expect(tz.auDoctorZone({ profile: { timezone: '', current_state: 'WA' } })).toEqual({ zone: 'Australia/Perth', source: 'state', certain: true });
    expect(tz.auDoctorZone({ profile: { timezone: 'garbage', current_state: 'WA' }, viewerZone: 'UTC' })).toEqual({ zone: 'Australia/Perth', source: 'state', certain: true });
    expect(tz.auDoctorZone({ profile: {} })).toEqual({ zone: 'Australia/Sydney', source: 'country', certain: false });
    expect(tz.auDoctorZone({ profile: {}, bookingZone: 'Australia/Darwin' })).toEqual({ zone: 'Australia/Darwin', source: 'booker', certain: true });
    expect(tz.auDoctorZone(null)).toEqual({ zone: 'Australia/Sydney', source: 'country', certain: false });
  });

  it('timezoneToStoreForState: the stored zone follows the state unless a browser said otherwise', () => {
    expect(tz.timezoneToStoreForState({ newState: 'WA' })).toBe('Australia/Perth');                                    // nothing stored
    expect(tz.timezoneToStoreForState({ newState: 'WA', storedTimezone: 'Australia/Perth' })).toBe('');                // already right
    expect(tz.timezoneToStoreForState({ newState: 'WA', previousState: 'NSW', storedTimezone: 'Australia/Sydney' })).toBe('Australia/Perth'); // was state-derived
    expect(tz.timezoneToStoreForState({ newState: 'WA', previousState: 'NSW', storedTimezone: 'Australia/Brisbane' })).toBe(''); // a browser said Brisbane: kept
    expect(tz.timezoneToStoreForState({ newState: 'WA', storedTimezone: 'not a zone' })).toBe('Australia/Perth');
    expect(tz.timezoneToStoreForState({ newState: 'Texas', storedTimezone: '' })).toBe('');
  });
});

describe('localHourFor: the hook for WP-16 quiet hours', () => {
  const at = Date.parse('2026-11-24T13:05:00.000Z'); // Wed 00:05 Sydney, Tue 21:05 Perth, Tue 13:05 London
  it('an Australian-segment lead: their own clock', () => {
    const waLead = { kind: 'gp', phone: '+61412345678', metadata: { consult: { country: 'au', state: 'WA' } } };
    expect(tz.localHourFor(waLead, at, { auPathwayEnabled: true })).toEqual({ weekday: 'Tue', hour: 21, minute: 5, minutes: 21 * 60 + 5, zone: 'Australia/Perth', source: 'state', certain: true });
    const unknown = tz.localHourFor({ kind: 'gp', phone: '+61412345678', metadata: { consult: { country: 'au' } } }, at, { auPathwayEnabled: true });
    expect(unknown).toMatchObject({ weekday: 'Wed', hour: 0, zone: 'Australia/Sydney', source: 'dial_code', certain: false });
  });

  it('an overseas lead, or any lead with the switch off: the zone the product has always used', () => {
    const uk = { kind: 'gp', phone: '+447911123456', metadata: { consult: { country: 'uk' } } };
    expect(tz.localHourFor(uk, at, { auPathwayEnabled: true })).toMatchObject({ weekday: 'Tue', hour: 13, zone: 'Europe/London', source: 'legacy' });
    const waLead = { kind: 'gp', phone: '+61412345678', metadata: { consult: { country: 'au', state: 'WA' } } };
    expect(tz.localHourFor(waLead, at, { auPathwayEnabled: false })).toMatchObject({ zone: 'Australia/Sydney', source: 'legacy', hour: 0 });
    const nz = { kind: 'gp', phone: '+64211234567', metadata: { consult: {} } };
    expect(tz.localHourFor(nz, at, { auPathwayEnabled: true })).toMatchObject({ zone: 'Pacific/Auckland', source: 'legacy' });
    expect(tz.localHourFor({ kind: 'gp', metadata: { consult: {} } }, at, { auPathwayEnabled: true })).toMatchObject({ zone: 'Europe/London', source: 'legacy' });
    // it agrees with the function the reminders use
    for (const l of [uk, nz]) {
      expect(tz.localHourFor(l, at, { auPathwayEnabled: true }).zone).toBe(consultReminders.consultLeadTimeZone(l.metadata.consult, l.phone));
    }
  });

  it('a doctor: resolved only when the caller says they are on an Australian pathway and the switch is on', () => {
    const profile = { user_id: 'u1', registration_country: 'Australia', timezone: '', current_state: 'WA' };
    expect(tz.localHourFor(profile, at, { isAu: true, auPathwayEnabled: true })).toMatchObject({ zone: 'Australia/Perth', source: 'state', hour: 21 });
    expect(tz.localHourFor(profile, at, { isAu: true, auPathwayEnabled: false })).toMatchObject({ zone: 'Australia/Sydney', source: 'legacy' });
    expect(tz.localHourFor(profile, at, { auPathwayEnabled: true })).toMatchObject({ zone: 'Australia/Sydney', source: 'legacy' });
    expect(tz.localHourFor({ user_id: 'u2', registration_country: 'United Kingdom', timezone: 'Australia/Perth', current_state: 'WA' }, at, { auPathwayEnabled: true }))
      .toMatchObject({ zone: 'Europe/London', source: 'legacy', hour: 13 });
    expect(tz.localHourFor({ user_id: 'u3' }, at, { kind: 'doctor', auPathwayEnabled: true })).toMatchObject({ zone: 'Europe/London', source: 'legacy' });
  });
});

describe('interview windows for a candidate on an Australian pathway', () => {
  it('the numbers, in one place: practice Monday to Friday 08:00 to 19:30, doctor 07:00 to 21:00, no weekends', () => {
    expect(tz.AU_INTERVIEW_DEFAULTS).toEqual({ practiceHours: [480, 1170], gpHours: [420, 1260], weekends: false });
    expect(tz.auInterviewConfig({})).toEqual({ practiceHours: [480, 1170], gpHours: [420, 1260], weekends: false });
    const p = tz.auInterviewParties('Australia/Sydney', 'Australia/Perth', {});
    expect(p.host).toEqual({ tz: 'Australia/Sydney', weekday: [480, 1170], weekend: [0, 0] });
    expect(p.practiceDefault).toEqual({ tz: 'Australia/Sydney', weekday: [480, 1170], weekend: [0, 0], overrides: [] });
    expect(p.gp).toEqual({ tz: 'Australia/Perth', weekday: [420, 1260], weekend: [420, 1260] });
    expect(tz.auInterviewHoursPhrase({})).toBe('Monday to Friday, 8:00 am to 7:30 pm');
    expect(tz.auInterviewWindowView('Australia/Sydney', {})).toEqual({
      fromMin: 480, toMin: 1170, weekdaysOnly: true, practiceTz: 'Australia/Sydney', practiceTzLabel: 'Sydney time',
      note: 'Interviews are offered Monday to Friday, 8:00 am to 7:30 pm (Sydney time).'
    });
  });

  it('environment overrides, read at call time; nonsense is ignored', () => {
    expect(tz.auInterviewConfig({ AU_INTERVIEW_PRACTICE_HOURS: '09:00-17:00', AU_INTERVIEW_GP_HOURS: '06:30-22:00', AU_INTERVIEW_WEEKENDS: 'true' }))
      .toEqual({ practiceHours: [540, 1020], gpHours: [390, 1320], weekends: true });
    expect(tz.auInterviewConfig({ AU_INTERVIEW_PRACTICE_HOURS: 'whenever', AU_INTERVIEW_GP_HOURS: '21:00-07:00', AU_INTERVIEW_WEEKENDS: 'yes' }))
      .toEqual({ practiceHours: [480, 1170], gpHours: [420, 1260], weekends: false });
    process.env.AU_INTERVIEW_PRACTICE_HOURS = '10:00-16:00';
    expect(tz.auInterviewConfig().practiceHours).toEqual([600, 960]);
    expect(tz.auInterviewParties('Australia/Sydney', 'Australia/Sydney', { AU_INTERVIEW_WEEKENDS: 'true' }).host.weekend).toEqual([480, 1170]);
  });

  // 2026-11-23 is a Monday. All slot maths below starts from there.
  function slots(practiceTz, gpTz, overrides) {
    const parties = tz.auInterviewParties(practiceTz, gpTz, {});
    const practice = overrides
      ? { tz: practiceTz, weekday: [0, 0], weekend: [0, 0], overrides }
      : parties.practiceDefault;
    return interviewScheduler.computeInterviewSlots({
      now: new Date('2026-11-23T00:00:00.000Z'), horizonDays: 14, durationMin: 30, leadHours: 48, gridMin: 30, maxSlots: 5000,
      host: parties.host, practice, gp: parties.gp, busy: []
    }).slots;
  }
  const inZone = (iso, zone) => tz.clockIn(zone, Date.parse(iso));

  it('Sydney practice, Sydney doctor: every slot is a weekday between 08:00 and 19:30 Sydney time, and 9 to 11 am is offered', () => {
    const list = slots('Australia/Sydney', 'Australia/Sydney');
    expect(list.length).toBeGreaterThan(100);
    for (const s of list) {
      const c = inZone(s.startUtc, 'Australia/Sydney');
      expect(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).toContain(c.weekday);
      expect(c.minutes).toBeGreaterThanOrEqual(480);
      expect(c.minutes + 30).toBeLessThanOrEqual(1170);
    }
    const starts = new Set(list.map((s) => inZone(s.startUtc, 'Australia/Sydney').minutes));
    for (const m of [480, 540, 570, 600, 630, 660, 1080, 1140]) expect(starts.has(m), 'start at ' + m).toBe(true);
    expect(starts.has(1170)).toBe(false); // must END by 19:30
    expect(starts.has(450)).toBe(false);
  });

  it('the overseas set never offers 9 to 11 am Sydney (that is the defect being fixed)', () => {
    const overseas = interviewScheduler.computeInterviewSlots({
      now: new Date('2026-11-23T00:00:00.000Z'), horizonDays: 14, durationMin: 30, leadHours: 48, gridMin: 30, maxSlots: 5000,
      host: interviewMeetings.DEFAULT_HOST_CONFIG,
      practice: { tz: 'Australia/Sydney', weekday: [0, 1440], weekend: [0, 1440], overrides: [] },
      gp: { tz: 'Australia/Sydney', weekday: [0, 1440], weekend: [0, 1440] }, busy: []
    }).slots;
    const morning = overseas.filter((s) => { const m = inZone(s.startUtc, 'Australia/Sydney').minutes; return m >= 540 && m < 660; });
    expect(morning).toEqual([]);
  });

  it('Sydney practice, Perth doctor: inside the practice hours AND not before 07:00 or after 21:00 for the doctor; each side has its own label', () => {
    const list = slots('Australia/Sydney', 'Australia/Perth');
    expect(list.length).toBeGreaterThan(50);
    for (const s of list) {
      const p = inZone(s.startUtc, 'Australia/Sydney');
      const g = inZone(s.startUtc, 'Australia/Perth');
      expect(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).toContain(p.weekday);
      expect(p.minutes).toBeGreaterThanOrEqual(480);
      expect(p.minutes + 30).toBeLessThanOrEqual(1170);
      expect(g.minutes).toBeGreaterThanOrEqual(420);
      expect(g.minutes + 30).toBeLessThanOrEqual(1260);
      expect(p.minutes - g.minutes).toBe(180); // AEDT is three hours ahead of AWST in November
      expect(s.local.practice.tz).toBe('Australia/Sydney');
      expect(s.local.gp.tz).toBe('Australia/Perth');
    }
    // the first slot of a full day: 10:00 Sydney, which is 07:00 in Perth
    const thursday = list.filter((s) => s.startUtc >= '2026-11-25T13:00:00.000Z');
    expect(thursday[0].startUtc).toBe('2026-11-25T23:00:00.000Z');
    expect(thursday[0].local.practice.label).toMatch(/Thu 26 Nov.*10:00\s?am/i);
    expect(thursday[0].local.gp.label).toMatch(/Thu 26 Nov.*7:00\s?am/i);
    expect(Math.min(...list.map((s) => inZone(s.startUtc, 'Australia/Sydney').minutes))).toBe(600);
  });

  it('Perth practice, Sydney doctor: Perth business hours, capped by the doctor at 21:00 Sydney', () => {
    const list = slots('Australia/Perth', 'Australia/Sydney');
    for (const s of list) {
      const p = inZone(s.startUtc, 'Australia/Perth');
      const g = inZone(s.startUtc, 'Australia/Sydney');
      expect(p.minutes).toBeGreaterThanOrEqual(480);
      expect(p.minutes + 30).toBeLessThanOrEqual(1170);
      expect(g.minutes + 30).toBeLessThanOrEqual(1260);
    }
    const lastPerthStart = Math.max(...list.map((s) => inZone(s.startUtc, 'Australia/Perth').minutes));
    expect(lastPerthStart).toBe(17 * 60 + 30); // 17:30 Perth = 20:30 Sydney, ends 21:00
  });

  it('times the practice chose are still the only bookable ones, and the business hours frame them', () => {
    const list = slots('Australia/Sydney', 'Australia/Sydney', [
      { date: '2026-11-26', fromMin: 540, toMin: 660 },    // Thu 9 to 11 am: all four slots
      { date: '2026-11-27', fromMin: 1080, toMin: 1320 },  // Fri 6 to 10 pm: only to 19:30
      { date: '2026-11-28', fromMin: 540, toMin: 720 }     // Saturday: nothing
    ]);
    const labels = list.map((s) => s.local.practice.label);
    expect(list.map((s) => s.startUtc)).toEqual([
      '2026-11-25T22:00:00.000Z', '2026-11-25T22:30:00.000Z', '2026-11-25T23:00:00.000Z', '2026-11-25T23:30:00.000Z',
      '2026-11-27T07:00:00.000Z', '2026-11-27T07:30:00.000Z', '2026-11-27T08:00:00.000Z'
    ]);
    expect(labels[0]).toMatch(/Thu 26 Nov.*9:00/);
    expect(labels[labels.length - 1]).toMatch(/Fri 27 Nov.*7:00/);
  });

  describe('server-side check of one submitted window (auInterviewWindowError)', () => {
    const ok = (w, o) => expect(tz.auInterviewWindowError(w, Object.assign({ env: {} }, o)), JSON.stringify(w)).toBeNull();
    const refused = (w, o) => expect(tz.auInterviewWindowError(w, Object.assign({ env: {} }, o)), JSON.stringify(w)).toMatch(/Interview times need to be Monday to Friday, 8:00 am to 7:30 pm/);
    const syd = { windowTz: 'Australia/Sydney', practiceTz: 'Australia/Sydney' };

    it('accepts weekday business hours on the practice clock, including 9 to 11 am and up to 19:30', () => {
      ok({ date: '2026-11-26', fromMin: 540, toMin: 660 }, syd);
      ok({ date: '2026-11-26', fromMin: 480, toMin: 1170 }, syd);
      ok({ date: '2026-11-27', fromMin: 1140, toMin: 1170 }, syd);
      ok({ date: '2026-11-26', fromMin: 540, toMin: 660 }, { practiceTz: 'Australia/Sydney' }); // no device zone: the practice's
    });

    it('rejects before 08:00, after 19:30, weekends and windows that run past midnight', () => {
      refused({ date: '2026-11-26', fromMin: 450, toMin: 540 }, syd);
      refused({ date: '2026-11-26', fromMin: 1080, toMin: 1200 }, syd);
      refused({ date: '2026-11-26', fromMin: 1200, toMin: 1320 }, syd);
      refused({ date: '2026-11-28', fromMin: 540, toMin: 660 }, syd); // Saturday
      refused({ date: '2026-11-29', fromMin: 540, toMin: 660 }, syd); // Sunday
      refused({ date: '2026-11-26', fromMin: 1380, toMin: 1500 }, syd);
      expect(tz.auInterviewWindowError({ date: '2026-11-28', fromMin: 540, toMin: 660 }, syd)).toBe(
        'Interview times need to be Monday to Friday, 8:00 am to 7:30 pm (Sydney time). Please adjust the time on 2026-11-28.');
    });

    it('is judged on the PRACTICE clock when the contact typed the time somewhere else', () => {
      // A Sydney practice's manager typing on a device set to Perth time:
      // 9:00 am Perth is midday in Sydney (fine), 5:00 pm Perth is 8:00 pm in Sydney (too late).
      ok({ date: '2026-11-26', fromMin: 540, toMin: 660 }, { windowTz: 'Australia/Perth', practiceTz: 'Australia/Sydney' });
      refused({ date: '2026-11-26', fromMin: 1020, toMin: 1080 }, { windowTz: 'Australia/Perth', practiceTz: 'Australia/Sydney' });
      // A Perth practice: 08:00 Perth is fine although it is 11:00 in Sydney.
      ok({ date: '2026-11-26', fromMin: 480, toMin: 540 }, { windowTz: 'Australia/Perth', practiceTz: 'Australia/Perth' });
      // Friday evening in London is Saturday morning in Sydney.
      refused({ date: '2026-11-27', fromMin: 1320, toMin: 1380 }, { windowTz: 'Europe/London', practiceTz: 'Australia/Sydney' });
    });

    it('malformed windows are refused, and a list reports its first problem', () => {
      expect(tz.auInterviewWindowError(null, syd)).toMatch(/needs a date/);
      expect(tz.auInterviewWindowError({ date: 'tomorrow', fromMin: 540, toMin: 600 }, syd)).toMatch(/needs a date/);
      expect(tz.auInterviewWindowError({ date: '2026-11-26', fromMin: 600, toMin: 540 }, syd)).toMatch(/needs a date/);
      expect(tz.auInterviewWindowsError([{ date: '2026-11-26', fromMin: 540, toMin: 660 }], syd)).toBeNull();
      expect(tz.auInterviewWindowsError([{ date: '2026-11-26', fromMin: 540, toMin: 660 }, { date: '2026-11-28', fromMin: 540, toMin: 660 }], syd)).toMatch(/2026-11-28/);
      expect(tz.auInterviewWindowsError(undefined, syd)).toBeNull();
    });

    it('follows the configured hours', () => {
      const env = { AU_INTERVIEW_PRACTICE_HOURS: '09:00-17:00', AU_INTERVIEW_WEEKENDS: 'true' };
      expect(tz.auInterviewWindowError({ date: '2026-11-28', fromMin: 540, toMin: 660 }, Object.assign({ env }, syd))).toBeNull();
      expect(tz.auInterviewWindowError({ date: '2026-11-26', fromMin: 480, toMin: 540 }, Object.assign({ env }, syd))).toMatch(/Any day, 9:00 am to 5:00 pm/);
    });
  });

  it('the interview-times request to a practice has no evenings-or-weekends wording', () => {
    const ask = tz.auInterviewTimesAsk('Test Auvr', {});
    expect(ask).toBe('Which times over the next 2 weeks suit to interview Dr Test Auvr? Monday to Friday, 8:00 am to 7:30 pm works best.');
    expect(ask).not.toMatch(/evening|weekend|UK|overseas/i);
  });
});

describe('COM-27: is it the weekend for this practice right now?', () => {
  // Saturday 28 Nov 2026 09:00 in Sydney is Friday 22:00 UTC.
  const saturdayMorningSydney = Date.parse('2026-11-27T22:00:00.000Z');
  // Monday 30 Nov 2026 09:00 in Sydney is Sunday 22:00 UTC.
  const mondayMorningSydney = Date.parse('2026-11-29T22:00:00.000Z');

  it('switch off: the UTC day, exactly as before (sends on Saturday morning, skips Monday morning)', () => {
    expect(tz.practiceWeekendNow(saturdayMorningSydney, { auPathwayEnabled: false })).toBe(false);
    expect(tz.practiceWeekendNow(mondayMorningSydney, { auPathwayEnabled: false })).toBe(true);
    for (let h = 0; h < 14 * 24; h++) {
      const t = Date.parse('2026-11-20T00:30:00.000Z') + h * HOUR;
      const dow = new Date(t).getUTCDay();
      expect(tz.practiceWeekendNow(t, { auPathwayEnabled: false, practiceTz: 'Australia/Perth' })).toBe(dow === 0 || dow === 6);
    }
  });

  it("switch on: the day on the practice's own clock", () => {
    expect(tz.practiceWeekendNow(saturdayMorningSydney, { auPathwayEnabled: true, practiceTz: 'Australia/Sydney' })).toBe(true);
    expect(tz.practiceWeekendNow(mondayMorningSydney, { auPathwayEnabled: true, practiceTz: 'Australia/Sydney' })).toBe(false);
    // Monday 06:00 in Sydney is still Sunday 03:00... no: it is Monday 03:00 in Perth.
    const mondaySixSydney = Date.parse('2026-11-29T19:00:00.000Z');
    expect(tz.practiceWeekendNow(mondaySixSydney, { auPathwayEnabled: true, practiceTz: 'Australia/Sydney' })).toBe(false);
    expect(tz.practiceWeekendNow(mondaySixSydney, { auPathwayEnabled: true, practiceTz: 'Australia/Perth' })).toBe(false);
    // Sunday 23:30 in Perth is already Monday 02:30 in Sydney.
    const sundayLatePerth = Date.parse('2026-11-29T15:30:00.000Z');
    expect(tz.practiceWeekendNow(sundayLatePerth, { auPathwayEnabled: true, practiceTz: 'Australia/Perth' })).toBe(true);
    expect(tz.practiceWeekendNow(sundayLatePerth, { auPathwayEnabled: true, practiceTz: 'Australia/Sydney' })).toBe(false);
    // unknown or unusable practice zone: Sydney
    expect(tz.practiceWeekendNow(saturdayMorningSydney, { auPathwayEnabled: true })).toBe(true);
    expect(tz.practiceWeekendNow(saturdayMorningSydney, { auPathwayEnabled: true, practiceTz: 'nonsense' })).toBe(true);
  });

  it('reads the switch itself when it is not passed', () => {
    process.env.AU_PATHWAY_ENABLED = 'false';
    expect(tz.practiceWeekendNow(saturdayMorningSydney, { practiceTz: 'Australia/Sydney' })).toBe(false);
    process.env.AU_PATHWAY_ENABLED = 'true';
    expect(tz.practiceWeekendNow(saturdayMorningSydney, { practiceTz: 'Australia/Sydney' })).toBe(true);
  });
});

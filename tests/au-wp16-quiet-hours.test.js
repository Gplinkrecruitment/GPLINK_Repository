// WP-16 (COM-22): local quiet hours, 08:00 to 20:00, for Australian-segment
// leads and doctors on an Australian pathway. lib/au-quiet-hours.js, pure.
//
// Table-driven by state and instant, across both daylight-saving changes, and
// the "zone not known" rule: inside the hours in EVERY Australian zone.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const q = require('../lib/au-quiet-hours.js');
const auTimezone = require('../lib/au-timezone.js');
const auLeadSends = require('../lib/au-lead-sends.js');

const ON = { auPathwayEnabled: true };
const OFF = { auPathwayEnabled: false };
const at = (iso) => Date.parse(iso);
const lead = (over) => Object.assign({ country: 'au', qualified: true, nudges: [] }, over || {});

describe('the window is 08:00 to 20:00 on the lead\'s own clock', () => {
  // [state, instant (UTC), allowed?, their local time]
  const TABLE = [
    // Summer (daylight saving in NSW, VIC, TAS, SA, ACT)
    ['NSW', '2027-01-13T20:59:00Z', false, '07:59'],
    ['NSW', '2027-01-13T21:00:00Z', true, '08:00'],
    ['NSW', '2027-01-14T08:59:00Z', true, '19:59'],
    ['NSW', '2027-01-14T09:00:00Z', false, '20:00'],
    ['ACT', '2027-01-13T21:00:00Z', true, '08:00'],
    ['VIC', '2027-01-13T21:00:00Z', true, '08:00'],
    ['VIC', '2027-01-14T09:00:00Z', false, '20:00'],
    ['TAS', '2027-01-13T20:59:00Z', false, '07:59'],
    ['TAS', '2027-01-13T21:00:00Z', true, '08:00'],
    ['QLD', '2027-01-13T21:59:00Z', false, '07:59'],
    ['QLD', '2027-01-13T22:00:00Z', true, '08:00'],
    ['QLD', '2027-01-14T10:00:00Z', false, '20:00'],
    ['SA', '2027-01-13T21:29:00Z', false, '07:59'],
    ['SA', '2027-01-13T21:30:00Z', true, '08:00'],
    ['SA', '2027-01-14T09:30:00Z', false, '20:00'],
    ['NT', '2027-01-13T22:29:00Z', false, '07:59'],
    ['NT', '2027-01-13T22:30:00Z', true, '08:00'],
    ['NT', '2027-01-14T10:30:00Z', false, '20:00'],
    ['WA', '2027-01-13T23:59:00Z', false, '07:59'],
    ['WA', '2027-01-14T00:00:00Z', true, '08:00'],
    ['WA', '2027-01-14T11:59:00Z', true, '19:59'],
    ['WA', '2027-01-14T12:00:00Z', false, '20:00'],
    // Winter (no daylight saving anywhere)
    ['NSW', '2027-07-13T21:00:00Z', false, '07:00'],
    ['NSW', '2027-07-13T22:00:00Z', true, '08:00'],
    ['NSW', '2027-07-14T10:00:00Z', false, '20:00'],
    ['SA', '2027-07-13T22:29:00Z', false, '07:59'],
    ['SA', '2027-07-13T22:30:00Z', true, '08:00'],
    ['WA', '2027-07-14T00:00:00Z', true, '08:00'],
    ['QLD', '2027-07-13T22:00:00Z', true, '08:00'],
    // The night daylight saving ENDS (Sunday 4 April 2027): the same UTC
    // instant is 08:30 the day before and 07:30 the day after.
    ['NSW', '2027-04-02T21:30:00Z', true, '08:30'],
    ['NSW', '2027-04-03T21:30:00Z', false, '07:30'],
    ['QLD', '2027-04-02T21:30:00Z', false, '07:30'],
    ['QLD', '2027-04-03T21:30:00Z', false, '07:30'],
    // The night it STARTS (Sunday 4 October 2026).
    ['VIC', '2026-10-02T21:30:00Z', false, '07:30'],
    ['VIC', '2026-10-03T21:30:00Z', true, '08:30'],
    ['WA', '2026-10-03T21:30:00Z', false, '05:30']
  ];
  TABLE.forEach(([state, iso, allow, local]) => {
    it(state + ' at ' + iso + ' is ' + local + ' there: ' + (allow ? 'send' : 'hold'), () => {
      const d = q.auQuietHoursAllow(lead({ state }), at(iso), ON);
      expect(d.applies).toBe(true);
      expect(d.certain).toBe(true);
      expect(d.zone).toBe(auTimezone.zoneForAuState(state));
      expect(d.localTime).toBe(local);
      expect(d.allow).toBe(allow);
      expect(d.reason).toBe(allow ? 'inside_hours' : 'quiet_hours');
    });
  });

  it('the zone they booked in, or their browser\'s, wins over the state (a doctor who is abroad keeps their own night)', () => {
    const abroad = lead({ segment: 'au_vr', country: 'uk', state: 'NSW', timezone: 'Europe/London', timezone_source: 'browser' });
    // 03:00 in London, 14:00 in Sydney.
    const d = q.auQuietHoursAllow(abroad, at('2027-01-14T03:00:00Z'), ON);
    expect(d).toMatchObject({ allow: false, zone: 'Europe/London', certain: true, localTime: '03:00' });
    expect(q.auQuietHoursAllow(abroad, at('2027-01-14T09:00:00Z'), ON)).toMatchObject({ allow: true, localTime: '09:00' });
    const booked = q.auQuietHoursAllow(lead({ state: 'NSW' }), at('2027-01-14T10:00:00Z'), Object.assign({ bookingZone: 'Australia/Perth' }, ON));
    expect(booked).toMatchObject({ allow: true, zone: 'Australia/Perth', localTime: '18:00' });
  });
});

describe('zone not known: inside the hours in every Australian zone', () => {
  const uncertain = [
    ['no state, nothing else', lead()],
    ['only an Australian mobile', { metadata: { consult: lead() }, phone: '+61400000111', kind: 'gp' }],
    ['an old Australian-trained row', lead({ country: 'au', country_raw: 'australia' })]
  ];
  uncertain.forEach(([label, subject]) => {
    it(label + ': summer window is 08:00 Perth to 20:00 Sydney', () => {
      const d = (iso) => q.auQuietHoursAllow(subject, at(iso), ON);
      expect(d('2027-01-13T23:59:00Z')).toMatchObject({ allow: false, certain: false, reason: 'quiet_hours_zone_uncertain' }); // 07:59 Perth
      expect(d('2027-01-14T00:00:00Z')).toMatchObject({ allow: true, certain: false, reason: 'inside_hours' });              // 08:00 Perth, 11:00 Sydney
      expect(d('2027-01-14T08:59:00Z').allow).toBe(true);                                                                     // 19:59 Sydney
      expect(d('2027-01-14T09:00:00Z').allow).toBe(false);                                                                    // 20:00 Sydney
      // 09:00 Sydney is inside Sydney's hours but 06:00 in Perth: held.
      expect(d('2027-01-13T22:00:00Z').allow).toBe(false);
    });
  });

  it('winter: the window is an hour longer at the end (Sydney is no longer ahead of Brisbane)', () => {
    const d = (iso) => q.auQuietHoursAllow(lead(), at(iso), ON).allow;
    expect(d('2027-07-13T23:59:00Z')).toBe(false);
    expect(d('2027-07-14T00:00:00Z')).toBe(true);
    expect(d('2027-07-14T09:30:00Z')).toBe(true);    // 19:30 Sydney: held in summer, fine in winter
    expect(d('2027-07-14T10:00:00Z')).toBe(false);
  });

  it('is computed from the zones, not from offsets: it agrees with a brute-force check at every half hour of four days', () => {
    const zones = q.australianZones();
    expect(zones.sort()).toEqual(['Australia/Adelaide', 'Australia/Brisbane', 'Australia/Darwin', 'Australia/Hobart', 'Australia/Melbourne', 'Australia/Perth', 'Australia/Sydney']);
    const hourIn = (zone, ms) => {
      const p = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
      return Number(p.find((x) => x.type === 'hour').value) * 60 + Number(p.find((x) => x.type === 'minute').value);
    };
    ['2027-01-14', '2027-07-14', '2026-10-04', '2027-04-04'].forEach((day) => {
      let allowed = 0;
      for (let i = 0; i < 48; i++) {
        const ms = at(day + 'T00:00:00Z') + i * 30 * 60000;
        const expected = zones.every((z) => { const m = hourIn(z, ms); return m >= 480 && m < 1200; });
        expect(q.auQuietHoursAllow(lead(), ms, ON).allow, day + ' +' + i * 30 + 'min').toBe(expected);
        expect(q.everyAustralianZoneInsideHours(ms)).toBe(expected);
        if (expected) allowed++;
      }
      // Nine hours in summer, ten in winter: never empty, never the whole day.
      expect(allowed).toBeGreaterThanOrEqual(18);
      expect(allowed).toBeLessThanOrEqual(20);
    });
  });
});

describe('who it applies to', () => {
  const NIGHT = at('2027-01-14T15:00:00Z'); // 02:00 Sydney, 15:00 London, 04:00 Auckland

  it('overseas leads are not gated at any hour (their send times are exactly what they were)', () => {
    ['uk', 'ie', 'nz', 'other'].forEach((country) => {
      for (let h = 0; h < 24; h++) {
        const d = q.auQuietHoursAllow({ country, qualified: true, nudges: [] }, NIGHT + h * 3600000, ON);
        expect(d, country + ' +' + h + 'h').toMatchObject({ allow: true, applies: false, reason: 'not_australian' });
      }
    });
    // A lead who said "No" to Ahpra and trained in the UK is overseas even on an Australian mobile.
    expect(q.auQuietHoursAllow({ metadata: { consult: { segment: 'overseas', country: 'uk' } }, phone: '+61400000111', kind: 'gp' }, NIGHT, ON).applies).toBe(false);
  });

  it('switch off: nobody is gated, Australian-segment leads included', () => {
    expect(q.auQuietHoursAllow(lead({ state: 'NSW' }), NIGHT, OFF)).toMatchObject({ allow: true, applies: false });
    expect(q.auQuietHoursAllow({ timezone: 'Australia/Sydney' }, NIGHT, Object.assign({ kind: 'doctor', isAu: true }, OFF))).toMatchObject({ allow: true, applies: false });
  });

  it('a doctor on an Australian pathway: their device zone, else their state, else every zone', () => {
    const doc = (profile, ms) => q.auQuietHoursAllow(profile, ms, Object.assign({ kind: 'doctor', isAu: true }, ON));
    expect(doc({ timezone: 'Australia/Perth', current_state: 'NSW' }, at('2027-01-14T10:00:00Z'))).toMatchObject({ allow: true, zone: 'Australia/Perth', localTime: '18:00', certain: true });
    expect(doc({ timezone: '', current_state: 'NSW' }, at('2027-01-14T10:00:00Z'))).toMatchObject({ allow: false, zone: 'Australia/Sydney', localTime: '21:00' });
    expect(doc({}, at('2027-01-13T22:00:00Z'))).toMatchObject({ allow: false, certain: false });   // 09:00 Sydney, 06:00 Perth
    expect(doc({}, at('2027-01-14T02:00:00Z'))).toMatchObject({ allow: true, certain: false });
    // A doctor who is not on an Australian pathway is never gated.
    expect(q.auQuietHoursAllow({ timezone: 'Australia/Sydney' }, NIGHT, Object.assign({ kind: 'doctor', isAu: false }, ON))).toMatchObject({ allow: true, applies: false });
  });

  it('a caller that already holds the zone (the lifecycle job knows the practice\'s)', () => {
    expect(q.auQuietHoursAllowInZone('Australia/Perth', at('2027-01-13T20:30:00Z'))).toMatchObject({ allow: false, localTime: '04:30', certain: true });
    expect(q.auQuietHoursAllowInZone('Australia/Sydney', at('2027-01-13T20:30:00Z'))).toMatchObject({ allow: false, localTime: '07:30' });
    expect(q.auQuietHoursAllowInZone('Australia/Sydney', at('2027-01-14T01:00:00Z'))).toMatchObject({ allow: true, localTime: '12:00' });
    // No zone in hand: every Australian zone must be inside the hours.
    expect(q.auQuietHoursAllowInZone('', at('2027-01-13T22:00:00Z'))).toMatchObject({ allow: false, certain: false });
    expect(q.auQuietHoursAllowInZone('not/a-zone', at('2027-01-14T01:00:00Z'))).toMatchObject({ allow: true, certain: false });
  });
});

describe('a held message is deferred, with the moment it can go', () => {
  it('names the next instant inside the hours (for logs and the Leads tab)', () => {
    const perthNight = q.auQuietHoursAllow(lead({ state: 'WA' }), at('2027-01-14T12:30:00Z'), ON);     // 20:30 Perth
    expect(perthNight.allow).toBe(false);
    expect(new Date(perthNight.nextAllowedMs).toISOString()).toBe('2027-01-15T00:00:00.000Z');          // 08:00 Perth
    const sydneyEarly = q.auQuietHoursAllow(lead({ state: 'NSW' }), at('2027-01-13T19:02:00Z'), ON);    // 06:02 Sydney
    expect(new Date(sydneyEarly.nextAllowedMs).toISOString()).toBe('2027-01-13T21:00:00.000Z');
    const unknown = q.auQuietHoursAllow(lead(), at('2027-01-14T09:10:00Z'), ON);                        // 20:10 Sydney
    expect(new Date(unknown.nextAllowedMs).toISOString()).toBe('2027-01-15T00:00:00.000Z');
    const fine = q.auQuietHoursAllow(lead({ state: 'NSW' }), at('2027-01-14T01:00:00Z'), ON);
    expect(fine.nextAllowedMs).toBe(at('2027-01-14T01:00:00Z'));
  });

  it('an exempt send is allowed at any hour, and says why', () => {
    const d = q.auQuietHoursAllow(lead({ state: 'NSW' }), at('2027-01-14T15:00:00Z'), Object.assign({ exempt: 'n02_reminder_hour' }, ON));
    expect(d).toMatchObject({ allow: true, applies: true, reason: 'exempt', exempt: 'n02_reminder_hour', localTime: '02:00' });
  });
});

describe('which messages are held (lib/au-lead-sends.js quietModeFor)', () => {
  const NOW = at('2027-01-14T03:00:00Z');
  it('elapsed-time notes are gated; reminders and the booking link are not', () => {
    ['n01_5m', 'n01_1h', 'n01_24h', 'n02_noshow', 'n03_week1', 'n03_week2', 'n03_week3'].forEach((id) => expect(auLeadSends.quietModeFor(id, NOW - 60000, NOW), id).toBe('gated'));
    ['booking_link', 'booking_link_generic', 'n02_reminder_day', 'n02_reminder_hour'].forEach((id) => expect(auLeadSends.quietModeFor(id, NaN, NOW), id).toBe('exempt'));
    // Anything this table does not know is gated (fail closed).
    expect(auLeadSends.quietModeFor('something_new', NOW, NOW)).toBe('gated');
  });
  it('a confirmation is exempt only within 30 minutes of what it confirms', () => {
    ['n02_booked', 'n03_after_call'].forEach((id) => {
      expect(auLeadSends.quietModeFor(id, NOW - 4 * 60000, NOW), id).toBe('exempt');
      expect(auLeadSends.quietModeFor(id, NOW - 30 * 60000, NOW), id).toBe('exempt');
      expect(auLeadSends.quietModeFor(id, NOW - 31 * 60000, NOW), id).toBe('gated');
      expect(auLeadSends.quietModeFor(id, NaN, NOW), id).toBe('gated');
      expect(auLeadSends.quietModeFor(id, NOW + 60000, NOW), id).toBe('gated');
    });
  });
});

describe('the lifecycle job\'s second run of the day', () => {
  it('is true on the first two hourly ticks after 08:00 has arrived everywhere in Australia, and on no other', () => {
    ['2027-01-14', '2027-07-14', '2026-10-04', '2027-04-04'].forEach((day) => {
      const ticks = [];
      for (let h = 0; h < 24; h++) {
        const ms = at(day + 'T00:00:05Z') + h * 3600000;
        if (q.allAustraliaWindowOpenedWithin(ms, 2 * 3600000)) ticks.push(new Date(ms).getUTCHours());
      }
      expect(ticks, day).toEqual([0, 1]);   // 08:00 and 09:00 in Perth
    });
    // The daily host's own hour (20:30 UTC) is never inside the hours.
    expect(q.everyAustralianZoneInsideHours(at('2027-01-14T20:30:00Z'))).toBe(false);
    expect(q.everyAustralianZoneInsideHours(at('2027-07-14T20:30:00Z'))).toBe(false);
  });
});

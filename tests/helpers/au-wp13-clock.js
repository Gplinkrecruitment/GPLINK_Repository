'use strict';
/**
 * WP-13 tests never read the real clock. This pins it.
 *
 *   import { vi } from 'vitest';
 *   const clock = require('./helpers/au-wp13-clock.js').pinWp13Clock(vi);
 *   clock.T0            the pinned instant (ms)
 *   clock.dayAt(n)      the CALENDAR DATE n days from the pinned day in Sydney
 *                       (calendar arithmetic on the date, never T0 + n * 24h:
 *                       24-hour steps drift a day across a daylight-saving
 *                       change in the hour after Sydney midnight)
 *   clock.at(n)         an instant on that calendar date in Sydney, at about
 *                       the pinned time of day
 *   clock.atHours(n)    an instant on that same calendar date in Sydney that is
 *                       inside 08:00 to 20:00 in EVERY Australian zone (WP-16
 *                       quiet hours: the lifecycle MESSAGES only go inside
 *                       those hours, so a test that expects one runs the job
 *                       at this instant, as the in-hours run does)
 *   clock.setNow(ms)    move the clock (the server runs in this process, so
 *                       its Date.now() moves too)
 *   clock.restore()     real time again (afterAll)
 *
 * Only `Date` is faked: timers, sockets and promises run for real.
 *
 * The default instant is the one the suite first failed at: 21 Nov 2026
 * 13:37 UTC, which is 00:37 on Sunday 22 Nov in Sydney (daylight time) and
 * 21:37 on Saturday 21 Nov in Perth. Set WP13_TEST_NOW (an ISO instant) to
 * run the same files at any other moment.
 */
const fees = require('../../lib/au-placement-fees.js');
const lc = require('../../lib/au-lifecycle.js');
const auQuietHours = require('../../lib/au-quiet-hours.js');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const DEFAULT_NOW = '2026-11-21T13:37:00.000Z';
const ZONE = 'Australia/Sydney';

function pinWp13Clock(vi, opts) {
  const o = opts || {};
  const pinned = Date.parse(process.env.WP13_TEST_NOW || o.now || DEFAULT_NOW);
  if (!Number.isFinite(pinned)) throw new Error('WP13_TEST_NOW is not an ISO instant: ' + process.env.WP13_TEST_NOW);
  vi.useFakeTimers({ toFake: ['Date'], now: pinned });
  const zone = o.zone || ZONE;
  const base = lc.localDay(pinned, zone);
  const dayAt = function (n) { return fees.addDays(base, n); };
  const at = function (n) {
    const target = dayAt(n);
    let c = pinned + n * DAY;
    for (let guard = 0; guard < 30 && lc.localDay(c, zone) < target; guard++) c += HOUR;
    for (let guard = 0; guard < 30 && lc.localDay(c, zone) > target; guard++) c -= HOUR;
    return c;
  };
  // The first whole hour of that Sydney date at which every Australian zone
  // is inside the hours (11:00 Sydney in summer, 10:00 in winter).
  const atHours = function (n) {
    const target = dayAt(n);
    let c = Math.floor(at(n) / HOUR) * HOUR;                       // on the hour
    while (lc.localDay(c - HOUR, zone) === target) c -= HOUR;      // back to the first hour of the date
    for (let guard = 0; guard < 30; guard++) {
      if (lc.localDay(c, zone) === target && auQuietHours.everyAustralianZoneInsideHours(c)) return c;
      c += HOUR;
    }
    throw new Error('no in-hours instant found on ' + target);
  };
  let hook = null;
  const setNow = function (ms) { vi.setSystemTime(ms); if (hook) hook(ms); };
  return {
    T0: pinned, base, zone, dayAt, at, atHours, setNow,
    onSet: function (fn) { hook = fn; },
    restore: function () { hook = null; vi.useRealTimers(); }
  };
}

module.exports = { pinWp13Clock, DEFAULT_NOW, DAY, HOUR };

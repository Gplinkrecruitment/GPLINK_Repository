import { describe, it, expect } from 'vitest';
import s from '../lib/interview-scheduler.js';

const HOST = { tz: 'Australia/Sydney', weekday: [660, 1560], weekend: [660, 1560] };
const PRACTICE = { tz: 'Australia/Sydney', weekday: [1080, 1320], weekend: [0, 1440], overrides: [] };
const GP = { tz: 'Europe/London', weekday: [360, 1380], weekend: [360, 1380] };

function base(extra) {
  return Object.assign({
    now: '2026-07-01T00:00:00.000Z', horizonDays: 7, durationMin: 45,
    leadHours: 48, gridMin: 30, maxSlots: 12, host: HOST, practice: PRACTICE, gp: GP, busy: []
  }, extra || {});
}

describe('interview-scheduler', () => {
  it('wallTimeToUtc respects DST: Sydney 18:00 on 1 Jul (AEST, UTC+10) = 08:00Z', () => {
    const d = s.wallTimeToUtc('2026-07-01', 1080, 'Australia/Sydney');
    expect(d.toISOString()).toBe('2026-07-01T08:00:00.000Z');
  });

  it('wallTimeToUtc respects DST: Sydney 18:00 on 1 Feb (AEDT, UTC+11) = 07:00Z', () => {
    const d = s.wallTimeToUtc('2026-02-01', 1080, 'Australia/Sydney');
    expect(d.toISOString()).toBe('2026-02-01T07:00:00.000Z');
  });

  it('produces weekday slots inside the practice 6–10pm Sydney window (= UK morning)', () => {
    const out = s.computeInterviewSlots(base());
    expect(out.slots.length).toBeGreaterThan(0);
    // every slot must start at or after 08:00Z and end by 11:15Z (practice 18:00–22:00 AEST in July)
    out.slots.forEach(function (sl) {
      const h = new Date(sl.startUtc).getUTCHours();
      expect(h).toBeGreaterThanOrEqual(8);
      expect(h).toBeLessThan(12);
    });
  });

  it('never offers a slot inside the GP 11pm–6am sleep window', () => {
    const out = s.computeInterviewSlots(base());
    out.slots.forEach(function (sl) {
      const label = sl.local.gp.label; // London local
      // 08:00Z in July (BST, UTC+1) = 09:00 London — fine; assert hour 6..23 in London
      const lonHour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/London' }).format(new Date(sl.startUtc)));
      expect(lonHour).toBeGreaterThanOrEqual(6);
      expect(lonHour).toBeLessThan(23);
    });
  });

  it('honours the lead time (no slot sooner than now + leadHours)', () => {
    const out = s.computeInterviewSlots(base({ leadHours: 72 }));
    const minStart = new Date('2026-07-01T00:00:00.000Z').getTime() + 72 * 3600 * 1000;
    out.slots.forEach(function (sl) {
      expect(new Date(sl.startUtc).getTime()).toBeGreaterThanOrEqual(minStart);
    });
  });

  it('subtracts host busy intervals (a consultation blocks its slot)', () => {
    const withBusy = base({ busy: [{ startUtc: '2026-07-03T08:00:00.000Z', endUtc: '2026-07-03T11:00:00.000Z' }] });
    const out = s.computeInterviewSlots(withBusy);
    out.slots.forEach(function (sl) {
      const t = new Date(sl.startUtc).getTime();
      const bs = new Date('2026-07-03T08:00:00.000Z').getTime();
      const be = new Date('2026-07-03T11:00:00.000Z').getTime();
      const overlaps = t < be && (t + 45 * 60000) > bs;
      expect(overlaps).toBe(false);
    });
  });

  it('weekend opens the practice window all day (slots exist outside 6–10pm AU)', () => {
    // horizon includes Sat 4 / Sun 5 Jul 2026
    const out = s.computeInterviewSlots(base({ horizonDays: 7, maxSlots: 50 }));
    const weekendSlot = out.slots.find(function (sl) {
      const day = new Date(sl.startUtc).getUTCDay();
      const audow = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Australia/Sydney' }).format(new Date(sl.startUtc));
      return audow === 'Sat' || audow === 'Sun';
    });
    expect(weekendSlot).toBeTruthy();
  });

  it('a practice override narrows the window for that date', () => {
    const p = Object.assign({}, PRACTICE, { overrides: [{ date: '2026-07-02', fromMin: 1140, toMin: 1200 }] }); // 19:00–20:00
    const out = s.computeInterviewSlots(base({ practice: p, horizonDays: 3, maxSlots: 50 }));
    const onJul2 = out.slots.filter(function (sl) {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date(sl.startUtc)) === '2026-07-02';
    });
    onJul2.forEach(function (sl) {
      const h = new Date(sl.startUtc).getUTCHours(); // 19:00 AEST = 09:00Z, 20:00 = 10:00Z
      expect(h).toBeGreaterThanOrEqual(9);
      expect(h).toBeLessThan(10);
    });
  });
});

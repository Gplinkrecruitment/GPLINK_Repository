// Regression: the "Plan your move" step rejected the earliest date the picker
// offered. The picker min was "today + 5 months" but validation compared
// new Date("YYYY-MM-DD") (UTC midnight) against a Date carrying the current
// time of day, so choosing exactly the min date showed "must be at least 5
// months from today" and Next did nothing (Dr Martins Iwunze, 25 Nov 2026:
// targetDate 2027-04-25 saved at 01:38Z, stuck on step 1).
//
// Runs the REAL helper code extracted from js/onboarding.js under a frozen clock.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'onboarding.js'), 'utf8');

function loadHelpers() {
  const start = src.indexOf('function localDateKey');
  const end = src.indexOf('targetDateInput.min = minDateKey');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const snippet = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(snippet + '\nreturn { localDateKey, addMonthsClamped, isBeforeMinDate, minDateKey };')();
}

describe('onboarding target date minimum', () => {
  afterEach(() => vi.useRealTimers());

  it('accepts the exact earliest date the picker offers (any time of day)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 25, 23, 59)); // 25 Nov 2026, late evening local
    const h = loadHelpers();
    expect(h.minDateKey).toBe('2027-04-25');
    expect(h.isBeforeMinDate('2027-04-25')).toBe(false);
    expect(h.isBeforeMinDate('2027-04-26')).toBe(false);
    expect(h.isBeforeMinDate('2027-04-24')).toBe(true);
  });

  it('clamps month-end overflow instead of skipping into the next month', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 30, 12, 0)); // 30 Sep 2026
    const h = loadHelpers();
    expect(h.minDateKey).toBe('2027-02-28');
    expect(h.isBeforeMinDate('2027-02-28')).toBe(false);
  });

  it('no longer compares Date objects against the current time', () => {
    expect(src).not.toMatch(/new Date\(state\.targetDate\)\s*;\s*\n\s*if \(d < minDate\)/);
    expect(src).not.toMatch(/minDate\.toISOString\(\)/);
  });
});

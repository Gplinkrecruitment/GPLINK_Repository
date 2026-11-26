// Onboarding "Plan your move" arrival-date window.
//
// History: the picker min was today + 5 months but validation compared
// new Date("YYYY-MM-DD") (UTC midnight) against a Date carrying the current
// time of day, so the earliest date the picker offered was always rejected
// (Dr Martins Iwunze, 25 Nov 2026, stuck on step 1). Owner rule from
// 26 Nov 2026: any date from today up to 12 months ahead, with a hint that
// the pathway takes ~6 months and practices will not consider a GP moving
// more than 12 months out.
//
// Runs the REAL helper code extracted from js/onboarding.js under a frozen clock.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'onboarding.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'onboarding.html'), 'utf8');

function loadHelpers() {
  const start = src.indexOf('function localDateKey');
  const end = src.indexOf('targetDateInput.min = minDateKey');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const snippet = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(snippet + '\nreturn { localDateKey, addMonthsClamped, targetDateProblem, minDateKey, maxDateKey };')();
}

describe('onboarding target date window (today .. +12 months)', () => {
  afterEach(() => vi.useRealTimers());

  it('accepts today, a near date, and exactly 12 months out (any time of day)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 25, 23, 59)); // 25 Nov 2026, late evening local
    const h = loadHelpers();
    expect(h.minDateKey).toBe('2026-11-25');
    expect(h.maxDateKey).toBe('2027-11-25');
    expect(h.targetDateProblem('2026-11-25')).toBe('');
    expect(h.targetDateProblem('2027-01-10')).toBe(''); // inside the old 5-month block
    expect(h.targetDateProblem('2027-04-25')).toBe(''); // Dr Martins' date
    expect(h.targetDateProblem('2027-11-25')).toBe('');
  });

  it('rejects past dates, dates beyond 12 months, and blanks with a clear reason', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 25, 9, 0));
    const h = loadHelpers();
    expect(h.targetDateProblem('2026-11-24')).toMatch(/today onwards/);
    expect(h.targetDateProblem('2027-11-26')).toMatch(/within the next 12 months/);
    expect(h.targetDateProblem('2027-11-26')).toMatch(/Practices will not consider/);
    expect(h.targetDateProblem('')).toMatch(/select a target date/);
  });

  it('clamps month-end overflow (29 Feb + 12 months = 28 Feb)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2028, 1, 29, 12, 0));
    const h = loadHelpers();
    expect(h.maxDateKey).toBe('2029-02-28');
  });

  it('the hint tells the GP about the 6-month pathway and the 12-month limit', () => {
    const hint = /id="targetDateHint"[^>]*>([^<]+)</.exec(html);
    expect(hint).toBeTruthy();
    expect(hint[1]).toMatch(/12 months/);
    expect(hint[1]).toMatch(/6 months/);
    expect(hint[1]).not.toMatch(/—/); // no em dashes in GP copy
    expect(src).not.toMatch(/at least 5 months from today/);
  });

  it('no longer compares Date objects against the current time', () => {
    expect(src).not.toMatch(/minDate\.toISOString\(\)/);
    expect(src).toMatch(/targetDateInput\.max = maxDateKey/);
  });
});

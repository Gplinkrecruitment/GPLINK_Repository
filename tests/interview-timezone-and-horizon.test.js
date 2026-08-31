// Owner report 2026-07-31. A practice approved a candidate and entered TWO
// availability days; the doctor's picker offered one.
//
// Both windows were stored correctly. The day vanished in the slot
// computation, which intersects the practice window with the host's hours AND
// the doctor's assumed waking hours (06:00–23:00). The doctor's zone is guessed
// from registration_country — EMPTY on that profile, and an empty country
// silently means Europe/London. So Wed 5 Aug 10:00–13:00 Sydney was judged as
// 01:00–04:00 London, fell outside those hours, and the whole day disappeared
// with nothing logged and nothing shown.
//
// Three fixes, all covered here:
//   1. the doctor's REAL device timezone is used to build (and re-check) slots
//   2. the practice's date picker, the validator and the scheduler now share
//      one bookable window instead of disagreeing by 46 days
//   3. a refused submission tells the practice the actual reason
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeInterviewSlots } from '../lib/interview-scheduler.js';
import interviewMeetings from '../lib/interview-meetings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// The real shape of the production row that caused the report.
const NOW = new Date('2026-07-29T00:00:00Z').getTime();
const SYDNEY_MORNING = { date: '2026-08-05', fromMin: 600, toMin: 780, tz: 'Australia/Sydney' };  // Wed 10:00–13:00
const SYDNEY_EVENING = { date: '2026-08-09', fromMin: 1080, toMin: 1200, tz: 'Australia/Sydney' }; // Sun 18:00–20:00

function slotsForGpTz(gpTz, overrides) {
  return computeInterviewSlots({
    now: NOW,
    horizonDays: interviewMeetings.INTERVIEW_HORIZON_DAYS,
    durationMin: 45,
    leadHours: interviewMeetings.INTERVIEW_LEAD_HOURS,
    gridMin: 30,
    maxSlots: 12,
    host: interviewMeetings.DEFAULT_HOST_CONFIG,
    practice: { tz: 'Australia/Sydney', weekday: [0, 0], weekend: [0, 0], overrides: overrides },
    gp: { tz: gpTz, weekday: interviewMeetings.DEFAULT_GP_CONFIG.weekday, weekend: interviewMeetings.DEFAULT_GP_CONFIG.weekend },
    busy: []
  }).slots;
}

const daysOf = (slots) => [...new Set(slots.map((s) => s.startUtc.slice(0, 10)))].sort();

describe('the reported bug, reproduced through the real scheduler', () => {
  it('assuming London deletes the morning window entirely', () => {
    const slots = slotsForGpTz('Europe/London', [SYDNEY_MORNING, SYDNEY_EVENING]);
    // Exactly what the doctor was shown: one day, three slots.
    expect(daysOf(slots)).toEqual(['2026-08-09']);
    expect(slots).toHaveLength(3);
  });

  it('using the doctor’s real zone gives them BOTH days back', () => {
    const slots = slotsForGpTz('Australia/Sydney', [SYDNEY_MORNING, SYDNEY_EVENING]);
    expect(daysOf(slots)).toEqual(['2026-08-05', '2026-08-09']);
    expect(slots.length).toBeGreaterThan(3);
  });

  it('the morning window alone yields NOTHING under the wrong zone — a silent total loss', () => {
    // The failure mode that matters: not "times shifted", but "the day is gone".
    expect(slotsForGpTz('Europe/London', [SYDNEY_MORNING])).toHaveLength(0);
    expect(slotsForGpTz('Australia/Sydney', [SYDNEY_MORNING]).length).toBeGreaterThan(0);
  });

  it('a genuinely overseas doctor is unaffected', () => {
    // The London default was right for the doctors this was built for, so the
    // evening window must still work exactly as before for them.
    expect(slotsForGpTz('Europe/London', [SYDNEY_EVENING])).toHaveLength(3);
  });
});

describe('country → timezone guess', () => {
  it('knows Australia, and still defaults to London for the overseas cohort', () => {
    expect(interviewMeetings.gpTzForCountry('au')).toBe('Australia/Sydney');
    expect(interviewMeetings.gpTzForCountry('Australia')).toBe('Australia/Sydney');
    expect(interviewMeetings.gpTzForCountry('ie')).toBe('Europe/Dublin');
    expect(interviewMeetings.gpTzForCountry('nz')).toBe('Pacific/Auckland');
    expect(interviewMeetings.gpTzForCountry('uk')).toBe('Europe/London');
    expect(interviewMeetings.gpTzForCountry('')).toBe('Europe/London');
  });
});

describe('the doctor’s real timezone reaches the slot computation', () => {
  it('the slots endpoint reads viewer_tz and passes it down', () => {
    expect(serverSrc).toContain("interviewMeetings.sanitizeViewerTz(url.searchParams.get('viewer_tz'))");
    expect(serverSrc).toContain('_interviewSlotContext(ciAppId, Date.now(), ciViewerTz)');
    expect(serverSrc).toContain('_interviewComputeSlots(row, appCtx, now, 12, null, gpTzOverride)');
  });

  it('an override falls back to the country guess, so an old client is unchanged', () => {
    const idx = serverSrc.indexOf('async function _interviewComputeSlots');
    const fnSrc = serverSrc.slice(idx, idx + 2200);
    expect(fnSrc).toContain('interviewMeetings.sanitizeViewerTz(gpTzOverride)');
    expect(fnSrc).toContain('|| interviewMeetings.gpTzForCountry(appCtx.gpCountry)');
  });

  it('BOOKING re-checks with the same zone the list was built with', () => {
    // Otherwise the doctor picks a slot they were just shown and gets
    // "that time was just taken" — the list and the re-check would disagree.
    expect(serverSrc).toContain('_interviewComputeSlots(meetingRow, appCtx, now, 500, meetingRow.id, gpViewerTz)');
  });
});

describe('every doctor-facing picker sends the zone on BOTH calls', () => {
  const pages = ['pages/secure-interview.html', 'pages/application-detail.html', 'pages/job.html'];
  it.each(pages)('%s requests slots with viewer_tz', (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const idx = src.indexOf('/api/career/interview/slots?applicationId=');
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 320)).toContain('viewer_tz=');
  });

  it.each(pages)('%s books with viewer_tz too', (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const idx = src.indexOf('/api/career/interview/book');
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 520)).toContain('viewer_tz');
  });
});

describe('one bookable window, not three disagreeing ones', () => {
  it('the constants exist and are exported', () => {
    expect(interviewMeetings.INTERVIEW_LEAD_HOURS).toBe(48);
    expect(interviewMeetings.INTERVIEW_HORIZON_DAYS).toBe(14);
  });

  it('the scheduler reads them instead of restating 14 and 48', () => {
    const idx = serverSrc.indexOf('async function _interviewComputeSlots');
    const fnSrc = serverSrc.slice(idx, idx + 9000);
    expect(fnSrc).toContain('horizonDays: interviewMeetings.INTERVIEW_HORIZON_DAYS');
    expect(fnSrc).toContain('leadHours: interviewMeetings.INTERVIEW_LEAD_HOURS');
    expect(fnSrc).toContain('interviewMeetings.INTERVIEW_HORIZON_DAYS * 24 * 60 * 60 * 1000');
  });

  it('the practice’s date picker offers exactly that window', () => {
    // This page is static and cannot import the module, so it restates the
    // numbers — this is the pin that stops them drifting apart again. They
    // were "today" and "+60 days" while the scheduler looked at 14.
    const src = fs.readFileSync(path.join(ROOT, 'pages/practice-decision.html'), 'utf8');
    expect(src).toContain(`dateInput.min = localYmd(new Date(Date.now() + ${interviewMeetings.INTERVIEW_LEAD_HOURS} * 60 * 60 * 1000));`);
    expect(src).toContain(`dateInput.max = localYmd(new Date(Date.now() + ${interviewMeetings.INTERVIEW_HORIZON_DAYS} * 24 * 60 * 60 * 1000));`);
    expect(src).not.toContain('60 * 24 * 60 * 60 * 1000');
  });

  it('a date beyond the horizon really would have been ignored', () => {
    // Proof the old behaviour was a silent loss, not a harmless permission:
    // the scheduler never even looks there.
    const beyond = { date: '2026-08-25', fromMin: 1080, toMin: 1200, tz: 'Australia/Sydney' };
    expect(slotsForGpTz('Australia/Sydney', [beyond])).toHaveLength(0);
  });
});

describe('a refused submission says why', () => {
  it('the approve endpoint returns the validator’s reason, not a fixed sentence', () => {
    const idx = serverSrc.indexOf("code: 'windows_required'");
    expect(idx).toBeGreaterThan(-1);
    expect(serverSrc.slice(idx - 80, idx + 120)).toContain('message: approveWindowsError');
    // The old fixed sentence is gone from the server entirely.
    expect(serverSrc).not.toContain('Please choose at least one interview time window before approving.');
  });

  it('the reasons a practice can actually trigger read like English', () => {
    // The validator was split on 2026-07-31 into bounds + one-window + array
    // (so the pasted-email route could reuse the identical rules), so slice
    // from the FIRST of the three rather than the last.
    const idx = serverSrc.indexOf('function practiceAvailabilityDateBounds');
    expect(idx).toBeGreaterThan(-1);
    const fnSrc = serverSrc.slice(idx, serverSrc.indexOf('function savePracticeAvailabilityWindows'));
    expect(fnSrc).toContain('Please add between 1 and 10 times that work for your practice.');
    expect(fnSrc).toContain('hours’ notice');
    expect(fnSrc).toContain('Each time must finish after it starts');
    // ...and it names the actual dates, so they can just fix it.
    expect(fnSrc).toContain('minYmd');
    expect(fnSrc).toContain('maxYmd');
  });
});

// ── Follow-up 2026-07-31 (same day, owner report) ───────────────────────────
// The owner opened the candidate card and saw "Sun 9 Aug, 9:00 am (your local
// time)" for an interview the doctor's own picker showed as 6:00 pm. Same
// instant — 9:00 London is 18:00 Sydney — but two separate faults:
//   a) staff screens had no doctor's browser to ask, so they fell back to the
//      country guess and disagreed with what the doctor was looking at;
//   b) the label said "your local time" on a screen where "your" is the STAFF
//      member, so a 6pm call reads as a 9am one.
// Plus: the "Paste practice reply" button only existed while a card was still
// waiting for a FIRST reply, so the add-to-existing behaviour shipped earlier
// that day was unreachable exactly when it was needed.
describe('staff and doctor see the same moment, correctly labelled', () => {
  const uiSrc = fs.readFileSync(path.join(ROOT, 'js/ceo-ats-candidates.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(ROOT, 'css/ceo-ats.css'), 'utf8');
  const dashSrc = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');

  it('the slot computation remembers where the doctor last logged in from', () => {
    const idx = serverSrc.indexOf('async function _interviewComputeSlots');
    const fnSrc = serverSrc.slice(idx, idx + 2600);
    // Live request tz → last-seen tz → country guess. Order is the point.
    expect(fnSrc).toContain('interviewMeetings.sanitizeViewerTz(gpTzOverride)');
    expect(fnSrc).toContain('interviewMeetings.sanitizeViewerTz(row && row.timezone)');
    expect(fnSrc).toContain('|| interviewMeetings.gpTzForCountry(appCtx.gpCountry)');
    expect(fnSrc.indexOf('sanitizeViewerTz(gpTzOverride)'))
      .toBeLessThan(fnSrc.indexOf('sanitizeViewerTz(row && row.timezone)'));
    expect(fnSrc.indexOf('sanitizeViewerTz(row && row.timezone)'))
      .toBeLessThan(fnSrc.indexOf('gpTzForCountry(appCtx.gpCountry)'));
  });

  it('it is recorded only when it changed, and never on a booked row', () => {
    // A booked row's timezone is what the confirmation email and the calendar
    // invite were built from — overwriting it would rewrite history.
    const idx = serverSrc.indexOf('could not record the doctor timezone');
    expect(idx).toBeGreaterThan(-1);
    const block = serverSrc.slice(idx - 900, idx);
    expect(block).toContain("ciRowNow.status !== 'booked'");
    expect(block).toContain("String(ciRowNow.timezone || '') !== ciViewerTz");
  });

  it('the staff slot button no longer claims the doctor’s time is yours', () => {
    expect(uiSrc).toContain("doctor\\'s local time");
    expect(uiSrc).not.toContain('(your local time)');
  });

  it('it also shows the practice’s and the CEO’s own time, quieter', () => {
    expect(uiSrc).toContain("conv.push('Practice ' + pr.label)");
    expect(uiSrc).toContain("conv.push('You ' + host.label)");
    expect(uiSrc).toContain('ats-slot-conv');
    expect(cssSrc).toContain('.ats-slot-conv');
  });

  it('a failed booking restores all three times, not just the doctor’s line', () => {
    expect(uiSrc).toContain('var slotHtmlBefore = btn.innerHTML;');
    expect(uiSrc).toContain('btn.innerHTML = slotHtmlBefore;');
  });

  it('“Paste practice reply” is reachable once times already exist', () => {
    // Otherwise the add-to-existing behaviour can only ever run against an
    // empty list — i.e. never in the case it was built for.
    const gridIdx = uiSrc.indexOf("var html = '<div class=\"ats-slot-grid\">'");
    expect(gridIdx).toBeGreaterThan(-1);
    expect(uiSrc.slice(gridIdx, gridIdx + 2200)).toContain('ats-int-paste-reply');
    // ...and in the "no mutual times" state too.
    const emptyIdx = uiSrc.indexOf('No mutually available times');
    expect(uiSrc.slice(emptyIdx, emptyIdx + 900)).toContain('ats-int-paste-reply');
  });

  it('re-rendering the picker cannot double-fire a booking', () => {
    // The click handler lives on the container, and this function re-renders
    // that same container after a paste — so it must only ever be wired once.
    expect(uiSrc).toContain('containerEl.__atsSlotClickWired');
  });

  it('both changed assets are cache-busted, or the dashboard serves the old ones', () => {
    expect(dashSrc).toContain('ceo-ats-candidates.js?v=20260901a');
    expect(dashSrc).toContain('ceo-ats.css?v=20260901a');
    expect(dashSrc).not.toContain('ceo-ats.css?v=20260805d');
    expect(dashSrc).not.toContain('ceo-ats.css?v=20260805c');
    expect(dashSrc).not.toContain('ceo-ats.css?v=20260805b');
    expect(dashSrc).not.toContain('ceo-ats.css?v=20260805a');
    expect(dashSrc).not.toContain('ceo-ats.css?v=20260731c');
    expect(dashSrc).not.toContain('ceo-ats.css?v=20260731b');
  });
});

import { describe, it, expect } from 'vitest';
import * as m from '../lib/interview-meetings.js';
import gcal from '../lib/google-calendar.js';

describe('interview-meetings model', () => {
  it('maps GP country to IANA timezone, defaulting to London', () => {
    expect(m.gpTzForCountry('uk')).toBe('Europe/London');
    expect(m.gpTzForCountry('ie')).toBe('Europe/Dublin');
    expect(m.gpTzForCountry('nz')).toBe('Pacific/Auckland');
    expect(m.gpTzForCountry('')).toBe('Europe/London');
  });

  it('defaults practice timezone to Sydney when location is unknown', () => {
    expect(m.practiceTzForLocation('')).toBe('Australia/Sydney');
    expect(m.practiceTzForLocation('Perth WA')).toBe('Australia/Perth');
  });

  it('prefers the stored AU state code over practice-name sniffing (Task 8)', () => {
    // Complete state/territory → canonical IANA zone map.
    expect(m.practiceTzForLocation('', 'NSW')).toBe('Australia/Sydney');
    expect(m.practiceTzForLocation('', 'VIC')).toBe('Australia/Melbourne');
    expect(m.practiceTzForLocation('', 'QLD')).toBe('Australia/Brisbane');
    expect(m.practiceTzForLocation('', 'SA')).toBe('Australia/Adelaide');
    expect(m.practiceTzForLocation('', 'WA')).toBe('Australia/Perth');
    expect(m.practiceTzForLocation('', 'TAS')).toBe('Australia/Hobart');
    expect(m.practiceTzForLocation('', 'NT')).toBe('Australia/Darwin');
    expect(m.practiceTzForLocation('', 'ACT')).toBe('Australia/Sydney');
    expect(m.practiceTzForLocation('', 'wa ')).toBe('Australia/Perth'); // case/space tolerant
    // A neutral practice name with a stored state must NOT fall back to Sydney.
    expect(m.practiceTzForLocation('Sunrise Family Medical', 'WA')).toBe('Australia/Perth');
    // The explicit stored state beats a misleading practice name.
    expect(m.practiceTzForLocation('Brisbane Road Clinic', 'WA')).toBe('Australia/Perth');
    // Unknown state code falls back to name sniffing, then Sydney.
    expect(m.practiceTzForLocation('Perth WA', '')).toBe('Australia/Perth');
    expect(m.practiceTzForLocation('Nowhere Clinic', 'ZZ')).toBe('Australia/Sydney');
    // City is folded into the sniff text when no usable state is stored.
    expect(m.practiceTzForLocation('Neutral Clinic', '', 'Perth')).toBe('Australia/Perth');
  });

  it('builds an interview row tagged interview/ceo/requested', () => {
    const row = m.buildInterviewRow({
      caseId: 'c1', userId: 'u1', applicationId: 'a1', careerRoleId: 7,
      practiceName: 'Greenslopes', createdBy: 'ceo@x', nowIso: '2026-06-30T00:00:00.000Z'
    });
    expect(row.meeting_kind).toBe('interview');
    expect(row.host_kind).toBe('ceo');
    expect(row.application_id).toBe('a1');
    expect(row.practice_name).toBe('Greenslopes');
    expect(row.practice_availability_status).toBe('requested');
    expect(row.status).toBe('invited');
    expect(row.summary_status).toBe('not_requested');
  });

  it('normalizes a meeting row with kind label + is_interview flag', () => {
    const out = m.normalizeMeetingForApi({ meeting_kind: 'interview' });
    expect(out.is_interview).toBe(true);
    expect(out.meeting_kind_label).toBe('Interview');
  });

  // Viewer-timezone feature: viewer_tz arrives from the browser
  // (Intl.DateTimeFormat().resolvedOptions().timeZone) on public/GP requests, so
  // it is validated hard — shape regex AND an Intl probe — before it is ever
  // persisted or used to render times. Invalid input → '' (caller falls back).
  it('sanitizeViewerTz accepts real IANA zones and rejects everything else', () => {
    expect(m.sanitizeViewerTz('Australia/Perth')).toBe('Australia/Perth');
    expect(m.sanitizeViewerTz('Europe/London')).toBe('Europe/London');
    expect(m.sanitizeViewerTz(' Pacific/Auckland ')).toBe('Pacific/Auckland'); // trimmed
    expect(m.sanitizeViewerTz('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
    expect(m.sanitizeViewerTz('UTC')).toBe('UTC');
    expect(m.sanitizeViewerTz('Mars/OlympusMons')).toBe('');       // shape-ok but not a real zone
    expect(m.sanitizeViewerTz('Australia/Perth;drop')).toBe('');   // shape-fail
    expect(m.sanitizeViewerTz('a/b/c/d')).toBe('');                // too many segments
    expect(m.sanitizeViewerTz('')).toBe('');
    expect(m.sanitizeViewerTz(null)).toBe('');
    expect(m.sanitizeViewerTz(undefined)).toBe('');
    expect(m.sanitizeViewerTz(42)).toBe('');
  });
});

describe('google-calendar request builders', () => {
  it('builds a freebusy request for the calendar + window', () => {
    const { url, body } = gcal.buildFreeBusyRequest({ calendarId: 'hello@x', fromUtc: '2026-07-01T00:00:00Z', toUtc: '2026-07-08T00:00:00Z' });
    expect(url).toContain('/freeBusy');
    expect(body.items[0].id).toBe('hello@x');
    expect(body.timeMin).toBe('2026-07-01T00:00:00Z');
  });
  it('parses a freebusy response into busy intervals', () => {
    const json = { calendars: { 'hello@x': { busy: [{ start: '2026-07-03T08:00:00Z', end: '2026-07-03T11:00:00Z' }] } } };
    const out = gcal.parseFreeBusy(json, 'hello@x');
    expect(out).toEqual([{ startUtc: '2026-07-03T08:00:00Z', endUtc: '2026-07-03T11:00:00Z' }]);
  });
  it('builds an event insert with attendees + zoom link', () => {
    const { url, body } = gcal.buildEventInsert({ calendarId: 'hello@x', summary: 'Interview', startUtc: '2026-07-03T08:00:00Z', endUtc: '2026-07-03T08:45:00Z', attendees: ['gp@x','prac@x'], description: 'd', zoomJoinUrl: 'https://zoom/x' });
    expect(url).toContain('/calendars/hello%40x/events');
    expect(body.attendees.map(a => a.email)).toContain('gp@x');
    expect(body.start.dateTime).toBe('2026-07-03T08:00:00Z');
    expect(body.location).toBe('https://zoom/x');
  });
});

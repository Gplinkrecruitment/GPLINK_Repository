// Phase 6 Batch D1a, unit tests for the reusable .ics calendar helper
// (lib/interview-ics.js). Pure functions, no server boot.
import { describe, it, expect } from 'vitest';
import { buildInterviewIcs, icsAttachment, icsEscape } from '../lib/interview-ics.js';

const BASE = {
  uid: 'gplink-interview-int-123@mygplink.com.au',
  start: '2026-08-14T03:30:00.000Z',
  durationMins: 45,
  summary: 'Interview, Dr Test @ Greenslopes Family Medical',
  description: 'GP Link interview. Join Zoom: https://zoom.us/j/12345',
  location: 'https://zoom.us/j/12345',
  organizerEmail: 'hello@mygplink.com.au',
  attendeeEmails: ['gp@example.com', 'practice@example.com']
};

// Unfold RFC 5545 folded lines (CRLF + single space) back into logical lines.
const unfold = (ics) => ics.replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean);

describe('buildInterviewIcs, REQUEST (booking invite)', () => {
  const ics = buildInterviewIcs(BASE);
  const lines = unfold(ics);

  it('produces a valid VCALENDAR/VEVENT wrapper with CRLF line endings', () => {
    expect(ics.includes('\r\n')).toBe(true);
    // Every line break is CRLF, no bare \n anywhere.
    expect(/[^\r]\n/.test(ics)).toBe(false);
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines[lines.length - 1]).toBe('END:VCALENDAR');
    expect(lines).toContain('BEGIN:VEVENT');
    expect(lines).toContain('END:VEVENT');
    expect(lines).toContain('VERSION:2.0');
    expect(lines).toContain('METHOD:REQUEST');
  });

  it('carries UID, DTSTAMP, DTSTART, DTEND (start + duration), SUMMARY as UTC basic format', () => {
    expect(lines).toContain('UID:gplink-interview-int-123@mygplink.com.au');
    expect(lines).toContain('DTSTART:20260814T033000Z');
    expect(lines).toContain('DTEND:20260814T041500Z'); // +45 minutes
    expect(lines.some((l) => /^DTSTAMP:\d{8}T\d{6}Z$/.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith('SUMMARY:'))).toBe(true);
  });

  it('defaults to STATUS:CONFIRMED, SEQUENCE:0, RSVP=TRUE attendees + organizer', () => {
    expect(lines).toContain('STATUS:CONFIRMED');
    expect(lines).toContain('SEQUENCE:0');
    expect(lines).toContain('ORGANIZER;CN=GP Link:mailto:hello@mygplink.com.au');
    const attendees = lines.filter((l) => l.startsWith('ATTENDEE'));
    expect(attendees.length).toBe(2);
    expect(attendees[0]).toContain('RSVP=TRUE');
    expect(attendees[0]).toContain('mailto:gp@example.com');
    expect(attendees[1]).toContain('mailto:practice@example.com');
  });

  it('folds long lines at 75 octets with a leading space on continuations', () => {
    const long = buildInterviewIcs({ ...BASE, description: 'x'.repeat(300) });
    for (const raw of long.split('\r\n')) {
      expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(75);
    }
    expect(long).toMatch(/\r\n /); // at least one folded continuation
  });
});

describe('buildInterviewIcs, CANCEL (same UID, bumped SEQUENCE)', () => {
  const ics = buildInterviewIcs({ ...BASE, method: 'CANCEL', status: 'CANCELLED', sequence: 1 });
  const lines = unfold(ics);

  it('sets METHOD:CANCEL, STATUS:CANCELLED and the incremented SEQUENCE', () => {
    expect(lines).toContain('METHOD:CANCEL');
    expect(lines).toContain('STATUS:CANCELLED');
    expect(lines).toContain('SEQUENCE:1');
  });

  it('keeps the SAME UID as the booking so calendars can match + remove the event', () => {
    expect(lines).toContain('UID:gplink-interview-int-123@mygplink.com.au');
  });

  it('defaults status to CANCELLED when only method CANCEL is given', () => {
    const l2 = unfold(buildInterviewIcs({ ...BASE, method: 'CANCEL', sequence: 2 }));
    expect(l2).toContain('STATUS:CANCELLED');
    expect(l2).toContain('SEQUENCE:2');
  });
});

describe('text escaping', () => {
  it('escapes commas, semicolons, backslashes and newlines in text fields', () => {
    expect(icsEscape('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    const ics = buildInterviewIcs({ ...BASE, summary: 'Interview; with, tricky\nchars' });
    const summary = unfold(ics).find((l) => l.startsWith('SUMMARY:'));
    expect(summary).toBe('SUMMARY:Interview\\; with\\, tricky\\nchars');
  });

  it('throws on a missing uid and an invalid start date (callers wrap in try/catch)', () => {
    expect(() => buildInterviewIcs({ ...BASE, uid: '' })).toThrow(/uid/);
    expect(() => buildInterviewIcs({ ...BASE, start: 'not-a-date' })).toThrow(/invalid date/);
  });
});

describe('icsAttachment, sendEmail attachment wrapper', () => {
  it('returns {filename, content(base64), contentType} and round-trips to the ICS text', () => {
    const att = icsAttachment(BASE);
    expect(att.filename).toBe('interview.ics');
    expect(att.contentType).toBe('text/calendar');
    const decoded = Buffer.from(att.content, 'base64').toString('utf8');
    expect(decoded).toContain('BEGIN:VCALENDAR');
    expect(decoded).toContain('UID:gplink-interview-int-123@mygplink.com.au');
    expect(decoded).toContain('METHOD:REQUEST');
  });
});

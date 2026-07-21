'use strict';

// Reusable iCalendar (.ics) generator for interview invites and cancellations
// (Phase 6 Batch D1a). Produces a minimal, standards-compliant VCALENDAR/VEVENT
// so Gmail/Outlook/Apple Mail render an "Add to calendar" card on the booking
// email, and remove the event again when a CANCEL with the same UID (and a
// higher SEQUENCE) arrives.
//
// RFC 5545 essentials honoured here:
//  - CRLF line endings throughout
//  - text values escaped (backslash, semicolon, comma, newlines)
//  - lines folded at 75 octets (continuations start with a single space)
//  - all times emitted as UTC (basic format, trailing 'Z')

// Escape a text value per RFC 5545 §3.3.11.
function icsEscape(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// 2026-08-14T03:30:00.000Z -> 20260814T033000Z
function icsDate(input) {
  var dt = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(dt.getTime())) throw new Error('buildInterviewIcs: invalid date "' + input + '"');
  return dt.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

// Fold a single content line at 75 octets (RFC 5545 §3.1). Continuation lines
// begin with one space, which costs an octet, hence max-1 on continuations.
function foldLine(line) {
  var s = String(line);
  if (Buffer.byteLength(s, 'utf8') <= 75) return s;
  var parts = [];
  var cur = '';
  var curLen = 0;
  for (var ch of s) {
    var chLen = Buffer.byteLength(ch, 'utf8');
    var max = parts.length === 0 ? 75 : 74;
    if (curLen + chLen > max) { parts.push(cur); cur = ch; curLen = chLen; }
    else { cur += ch; curLen += chLen; }
  }
  if (cur) parts.push(cur);
  return parts.map(function (p, i) { return i === 0 ? p : ' ' + p; }).join('\r\n');
}

// Build the full .ics text. UID must be stable per interview so a later
// CANCEL (same uid, sequence+1) matches the original event in the recipient's
// calendar. All text fields are escaped here, callers pass raw strings.
function buildInterviewIcs(opts) {
  opts = opts && typeof opts === 'object' ? opts : {};
  var uid = String(opts.uid || '').trim();
  if (!uid) throw new Error('buildInterviewIcs: uid is required');
  var method = String(opts.method || 'REQUEST').toUpperCase() === 'CANCEL' ? 'CANCEL' : 'REQUEST';
  var status = String(opts.status || (method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED')).toUpperCase();
  var sequence = Number.isFinite(Number(opts.sequence)) ? Math.max(0, Math.floor(Number(opts.sequence))) : 0;
  var durationMins = (Number.isFinite(Number(opts.durationMins)) && Number(opts.durationMins) > 0)
    ? Number(opts.durationMins) : 45;
  var startDt = opts.start instanceof Date ? opts.start : new Date(opts.start);
  var dtStart = icsDate(startDt); // throws on an invalid date, callers wrap in try/catch
  var dtEnd = icsDate(new Date(startDt.getTime() + durationMins * 60000));
  var dtStamp = icsDate(new Date());

  var lines = [
    'BEGIN:VCALENDAR',
    'PRODID:-//GP Link//Interview Scheduler//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:' + method,
    'BEGIN:VEVENT',
    'UID:' + icsEscape(uid),
    'DTSTAMP:' + dtStamp,
    'DTSTART:' + dtStart,
    'DTEND:' + dtEnd,
    'SUMMARY:' + icsEscape(opts.summary || 'Interview')
  ];
  if (opts.description) lines.push('DESCRIPTION:' + icsEscape(opts.description));
  if (opts.location) lines.push('LOCATION:' + icsEscape(opts.location));
  var organizerEmail = String(opts.organizerEmail || '').trim();
  if (organizerEmail) lines.push('ORGANIZER;CN=GP Link:mailto:' + organizerEmail);
  (Array.isArray(opts.attendeeEmails) ? opts.attendeeEmails : [])
    .map(function (a) { return String(a || '').trim(); })
    .filter(Boolean)
    .forEach(function (email) {
      lines.push('ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP='
        + (method === 'CANCEL' ? 'FALSE' : 'TRUE') + ':mailto:' + email);
    });
  lines.push('STATUS:' + status);
  lines.push('SEQUENCE:' + sequence);
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');

  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// Wrap the .ics text as a sendEmail() attachment object.
function icsAttachment(opts) {
  var ics = buildInterviewIcs(opts);
  return {
    filename: (opts && opts.filename) || 'interview.ics',
    content: Buffer.from(ics, 'utf8').toString('base64'),
    contentType: 'text/calendar'
  };
}

module.exports = { buildInterviewIcs, icsAttachment, icsEscape };

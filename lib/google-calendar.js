'use strict';
var API = 'https://www.googleapis.com/calendar/v3';

function buildFreeBusyRequest(o) {
  return { url: API + '/freeBusy', body: { timeMin: o.fromUtc, timeMax: o.toUtc, items: [{ id: o.calendarId }] } };
}
// Google keys the response by the calendar id it RESOLVED, which is not always
// the exact string we sent: case can differ, and a stray space from a pasted
// env var will not come back. An exact-key lookup that misses falls through to
// "no busy blocks" — indistinguishable from a genuinely free diary, and it
// silently removes all clash protection. So: exact match, then trimmed/
// case-insensitive, then — if Google returned exactly one calendar — that one,
// since we only ever ask about one.
function resolveCalendarBlock(json, calendarId) {
  var cals = (json && json.calendars) || {};
  var keys = Object.keys(cals);
  if (Object.prototype.hasOwnProperty.call(cals, calendarId)) return { block: cals[calendarId], key: calendarId, keys: keys };
  var want = String(calendarId || '').trim().toLowerCase();
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i]).trim().toLowerCase() === want) return { block: cals[keys[i]], key: keys[i], keys: keys };
  }
  if (keys.length === 1) return { block: cals[keys[0]], key: keys[0], keys: keys };
  return { block: null, key: null, keys: keys };
}

function parseFreeBusy(json, calendarId) {
  var found = resolveCalendarBlock(json, calendarId);
  var cal = found.block || { busy: [] };
  return (cal.busy || []).map(function (b) { return { startUtc: b.start, endUtc: b.end }; });
}

// Everything a human needs to tell "your diary really is empty" apart from
// "the lookup failed and we are pretending it is empty". Google reports
// per-calendar failures INSIDE a 200 response, so HTTP success proves nothing.
function freeBusyDiagnostics(json, calendarId) {
  var found = resolveCalendarBlock(json, calendarId);
  var block = found.block;
  var errs = (block && Array.isArray(block.errors)) ? block.errors : [];
  return {
    matched: !!block,
    matchedKey: found.key,
    returnedKeys: found.keys,
    busyCount: (block && Array.isArray(block.busy)) ? block.busy.length : 0,
    errorReasons: errs.map(function (e) { return String((e && e.reason) || 'unknown'); }),
    topLevelError: (json && json.error && (json.error.message || json.error.status)) ? String(json.error.message || json.error.status) : null
  };
}
function buildEventInsert(o) {
  return {
    url: API + '/calendars/' + encodeURIComponent(o.calendarId) + '/events?sendUpdates=all&conferenceDataVersion=0',
    body: {
      summary: o.summary,
      description: (o.description || '') + (o.zoomJoinUrl ? ('\n\nZoom: ' + o.zoomJoinUrl) : ''),
      location: o.zoomJoinUrl || '',
      start: { dateTime: o.startUtc }, end: { dateTime: o.endUtc },
      attendees: (o.attendees || []).map(function (e) { return { email: e }; })
    }
  };
}
// Removing a cancelled interview from the diary. sendUpdates=all so the doctor
// and the practice get the cancellation on the invitation they already accepted,
// matching the insert above (which invites them the same way).
function buildEventDelete(o) {
  return {
    url: API + '/calendars/' + encodeURIComponent(o.calendarId) + '/events/' + encodeURIComponent(o.eventId) + '?sendUpdates=all',
    method: 'DELETE'
  };
}
module.exports = { buildFreeBusyRequest, parseFreeBusy, freeBusyDiagnostics, buildEventInsert, buildEventDelete };

'use strict';
var API = 'https://www.googleapis.com/calendar/v3';

function buildFreeBusyRequest(o) {
  return { url: API + '/freeBusy', body: { timeMin: o.fromUtc, timeMax: o.toUtc, items: [{ id: o.calendarId }] } };
}
function parseFreeBusy(json, calendarId) {
  var cal = (json && json.calendars && json.calendars[calendarId]) || { busy: [] };
  return (cal.busy || []).map(function (b) { return { startUtc: b.start, endUtc: b.end }; });
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
module.exports = { buildFreeBusyRequest, parseFreeBusy, buildEventInsert, buildEventDelete };

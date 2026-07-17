'use strict';

var MEETING_KINDS = { CONSULTATION: 'consultation', INTERVIEW: 'interview' };
var PRACTICE_AVAIL = { NOT_REQUESTED: 'not_requested', REQUESTED: 'requested', RECEIVED: 'received', DEFAULTED: 'defaulted' };

// minutes from local midnight; values >1440 mean "past midnight into the next day"
var DEFAULT_HOST_CONFIG = { tz: 'Australia/Sydney', weekday: [660, 1560], weekend: [660, 1560] };   // 11:00–02:00(+1)
var DEFAULT_PRACTICE_CONFIG = { weekday: [1080, 1320], weekend: [0, 1440] };                          // 18:00–22:00 / all
var DEFAULT_GP_CONFIG = { weekday: [360, 1380], weekend: [360, 1380] };                               // 06:00–23:00

function gpTzForCountry(country) {
  switch (String(country || '').toLowerCase().trim()) {
    case 'ie': case 'ireland': return 'Europe/Dublin';
    case 'nz': case 'new zealand': return 'Pacific/Auckland';
    case 'uk': case 'gb': case 'united kingdom': default: return 'Europe/London';
  }
}

function practiceTzForLocation(loc) {
  var s = String(loc || '').toLowerCase();
  if (/\bwa\b|perth|western australia/.test(s)) return 'Australia/Perth';
  if (/\bsa\b|adelaide|south australia/.test(s)) return 'Australia/Adelaide';
  if (/\bnt\b|darwin|northern territory/.test(s)) return 'Australia/Darwin';
  if (/\bqld\b|brisbane|queensland|gold coast/.test(s)) return 'Australia/Brisbane';
  if (/\bwa\b/.test(s)) return 'Australia/Perth';
  return 'Australia/Sydney'; // NSW/VIC/ACT/TAS default
}

function buildInterviewRow(o) {
  var now = o.nowIso || new Date().toISOString();
  return {
    case_id: o.caseId || null,
    user_id: o.userId || null,
    meeting_kind: MEETING_KINDS.INTERVIEW,
    host_kind: 'ceo',
    application_id: o.applicationId || null,
    career_role_id: (o.careerRoleId === 0 || o.careerRoleId) ? o.careerRoleId : null,
    practice_name: o.practiceName || '',
    stage: null,
    status: 'invited',
    practice_availability_status: PRACTICE_AVAIL.REQUESTED,
    practice_availability_requested_at: now,
    summary_status: 'not_requested',
    created_by: o.createdBy || '',
    created_at: now,
    updated_at: now
  };
}

// A Calendly booking that matches no invited call is someone booking the public link
// directly (nobody sent them a correlation token). Builds the scheduled_calls row for
// that booking. Pure: `nowIso` and `correlationToken` are inputs, never generated here.
//   - host_kind MUST be 'ceo': GET /api/ceo/meetings scopes to
//     or=(host_kind.eq.ceo,assigned_rso_email.eq.<session email>) and the column
//     DEFAULTS to 'rso', so a row that relies on the default is invisible in the tab.
//   - correlation_token is NOT NULL UNIQUE — the caller passes generateCorrelationToken().
//   - case_id/user_id/stage/application_id/*_task_id stay null: a stranger has no
//     registration case, no auth user and no task to hang off.
function buildScheduledCallFromCalendly(o) {
  var now = o.nowIso;
  var row = {
    case_id: null,
    user_id: null,
    stage: null,
    application_id: null,
    registration_task_id: null,
    origin_task_id: null,
    meeting_kind: MEETING_KINDS.CONSULTATION,
    host_kind: 'ceo',
    status: 'booked',
    correlation_token: o.correlationToken,
    booked_at: now,
    invitee_email: o.inviteeEmail || null,
    timezone: o.timezone || null,
    calendly_invitee_uri: o.calendlyInviteeUri || null,
    calendly_event_uri: o.calendlyEventUri || null,
    summary_status: 'not_requested',
    created_by: 'calendly_direct',
    created_at: now,
    updated_at: now
  };
  if (o.scheduledAt) row.scheduled_at = o.scheduledAt;
  if (o.zoomJoinUrl) row.zoom_join_url = o.zoomJoinUrl;
  if (o.zoomMeetingId) row.zoom_meeting_id = o.zoomMeetingId;
  if (o.zoomPasscode) row.zoom_passcode = o.zoomPasscode;
  if (o.inviteeNotes) row.invitee_notes = o.inviteeNotes;
  return row;
}

function normalizeMeetingForApi(row) {
  var r = Object.assign({}, row);
  r.is_interview = row.meeting_kind === MEETING_KINDS.INTERVIEW;
  r.meeting_kind_label = r.is_interview ? 'Interview' : 'Standard consultation';
  return r;
}

module.exports = {
  MEETING_KINDS, PRACTICE_AVAIL,
  DEFAULT_HOST_CONFIG, DEFAULT_PRACTICE_CONFIG, DEFAULT_GP_CONFIG,
  gpTzForCountry, practiceTzForLocation, buildInterviewRow,
  buildScheduledCallFromCalendly, normalizeMeetingForApi
};

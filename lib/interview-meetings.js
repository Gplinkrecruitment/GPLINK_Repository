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

// Validate a browser-reported IANA timezone (viewer_tz, the value of
// Intl.DateTimeFormat().resolvedOptions().timeZone on the viewer's device).
// Public/GP requests carry it, so it is validated hard: a shape regex first
// (letter/underscore/+/- segments, at most three), then an Intl probe so a
// shape-passing fake ('Mars/OlympusMons') is still rejected. Returns the
// trimmed tz when usable, '' otherwise, callers treat '' as "fall back to
// the derived tz". Note the shape regex has no digits, so rare digit zones
// (e.g. Etc/GMT+10) are rejected here and simply fall back, safe by design.
function sanitizeViewerTz(tz) {
  var s = typeof tz === 'string' ? tz.trim() : '';
  if (!s || !/^[A-Za-z_+-]+(\/[A-Za-z_+-]+){0,2}$/.test(s)) return '';
  try { new Intl.DateTimeFormat('en', { timeZone: s }); return s; } catch (e) { return ''; }
}

// Canonical IANA zone per AU state/territory code. An explicit stored
// location_state must always beat name sniffing: a Perth practice named
// without a city keyword would otherwise get Sydney time, availability
// windows interpreted 2-3h off and email prose disagreeing with the
// UTC-correct .ics.
var AU_STATE_TZ = {
  NSW: 'Australia/Sydney',
  VIC: 'Australia/Melbourne',
  QLD: 'Australia/Brisbane',
  SA: 'Australia/Adelaide',
  WA: 'Australia/Perth',
  TAS: 'Australia/Hobart',
  NT: 'Australia/Darwin',
  ACT: 'Australia/Sydney'
};

// loc:   free text (practice name / location label), keyword-sniffed.
// state: explicit AU state code (career_roles/practices.location_state), wins
//        outright via AU_STATE_TZ when recognised.
// city:  explicit stored city (location_city), folded into the sniff text.
// Unrecognised state text (e.g. 'Western Australia' spelled out) still joins
// the sniff text, so it beats nothing rather than being dropped.
function practiceTzForLocation(loc, state, city) {
  var byState = AU_STATE_TZ[String(state || '').trim().toUpperCase()];
  if (byState) return byState;
  var s = [state, city, loc].map(function (v) { return String(v || ''); }).join(' ').toLowerCase();
  if (/\bwa\b|perth|western australia/.test(s)) return 'Australia/Perth';
  if (/\bsa\b|adelaide|south australia/.test(s)) return 'Australia/Adelaide';
  if (/\bnt\b|darwin|northern territory/.test(s)) return 'Australia/Darwin';
  if (/\bqld\b|brisbane|queensland|gold coast/.test(s)) return 'Australia/Brisbane';
  return 'Australia/Sydney'; // NSW/VIC/ACT/TAS sniff default (Sydney-equivalent offsets)
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
//   - correlation_token is NOT NULL UNIQUE, the caller passes generateCorrelationToken().
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
  gpTzForCountry, practiceTzForLocation, sanitizeViewerTz, buildInterviewRow,
  buildScheduledCallFromCalendly, normalizeMeetingForApi
};

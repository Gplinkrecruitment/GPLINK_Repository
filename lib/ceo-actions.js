// Pure, dependency-free helpers for CEO/RSO write actions.
// No DB calls. Callers pass timestamps where needed (nowIso) so logic is testable.

// The ONLY values registration_cases.blocker_status CHECK accepts (besides NULL).
// Mirrors supabase/migrations/20260403000000_registration_cases_tasks.sql:14-15.
var VALID_BLOCKER_STATUSES = ['waiting_on_gp', 'waiting_on_practice', 'waiting_on_external', 'internal_review'];

// Independent fetch cap for escalations so old ones are never sliced out of the
// shared 1000-row open-task list (#53).
var ESCALATION_FETCH_LIMIT = 1000;

// Build a constraint-safe case PATCH from a raw blocker modal payload.
// - A valid blocker_status => status:'blocked', keep blocker_status, stamp blocker_set_at.
// - The legacy "blocked" option (or any non-whitelisted value) => status:'blocked',
//   blocker_status:null (avoids the CHECK violation, #4/#19), still stamp blocker_set_at.
// - Empty/null blocker_status => clear: status:'active', blocker_status:null, blocker_set_at:null.
function normalizeBlockerPatch(body, nowIso) {
  nowIso = nowIso || new Date().toISOString();
  var raw = body && body.blocker_status != null ? String(body.blocker_status) : '';
  var reason = body && typeof body.blocker_reason === 'string' && body.blocker_reason.trim()
    ? body.blocker_reason.trim() : null;
  if (!raw) {
    return { status: 'active', blocker_status: null, blocker_reason: reason, blocker_set_at: null };
  }
  var valid = VALID_BLOCKER_STATUSES.indexOf(raw) > -1;
  return {
    status: 'blocked',
    blocker_status: valid ? raw : null,
    blocker_reason: reason,
    blocker_set_at: nowIso
  };
}

// True only for the canonical CEO resolution event — never by substring-matching free text (#54).
function isResolutionTimelineEvent(ev) {
  if (!ev) return false;
  var title = String(ev.title || '');
  return title === 'CEO resolved escalation';
}

// Human label for a timeline/escalation actor (#27). Real email passes through;
// 'system' => 'System'; empty => 'Unknown'.
function humanizeActor(actor) {
  var a = actor == null ? '' : String(actor).trim();
  if (!a) return 'Unknown';
  if (a.toLowerCase() === 'system') return 'System';
  return a;
}

module.exports = {
  VALID_BLOCKER_STATUSES: VALID_BLOCKER_STATUSES,
  ESCALATION_FETCH_LIMIT: ESCALATION_FETCH_LIMIT,
  normalizeBlockerPatch: normalizeBlockerPatch,
  isResolutionTimelineEvent: isResolutionTimelineEvent,
  humanizeActor: humanizeActor
};

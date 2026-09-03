// Stalled ("gone quiet") applications — the narrow bypass/attention detector
// (owner decision 2026-09-04). Only applications where GP Link actually made
// an introduction count: the practice approved the doctor (revealed), an
// interview or offer stage was reached, an interview happened, or staff
// applied the doctor themselves. A closed application (withdrawn, not
// proceeding, hired, placed…) never counts. "Quiet" = no movement on the
// application for `thresholdDays` (default 60), measured from the LAST stage
// or decision timestamp — never `updated_at`, which reminder crons bump.
//
// Pure + dual-exported (CommonJS for server.js and vitest). No DB, no clock
// except the injected `now`.
'use strict';

const INTRODUCED_STAGES = new Set(['interview', 'offer']);
const TERMINAL_STAGES = new Set(['hired', 'not_proceeding']);
const TERMINAL_STATUSES = new Set([
  'withdrawn', 'not_proceeding', 'rejected', 'declined', 'unsuccessful', 'offer_declined',
  'position_filled', 'hired', 'placed', 'placement_secured', 'practice_secured', 'offer_accepted', 'contract_signed'
]);
const APPROVED_DECISIONS = new Set(['approved', 'approve', 'accepted', 'accept', 'client_approved']);
// Ordered only for readability — the max wins.
const MOVEMENT_FIELDS = [
  'ats_stage_updated_at',
  'interview_completed_at',
  'practice_decision_at',
  'practice_responded_at',
  'submitted_to_practice_at',
  'matched_at',
  'applied_at'
];
const DEFAULT_THRESHOLD_DAYS = 60;
const DAY_MS = 86400000;

function norm(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function parseTs(value) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function lastMovementAt(app) {
  const a = app && typeof app === 'object' ? app : {};
  let best = 0;
  for (const field of MOVEMENT_FIELDS) {
    const ms = parseTs(a[field]);
    if (ms > best) best = ms;
  }
  return best ? new Date(best).toISOString() : null;
}

function isIntroduced(app) {
  const a = app && typeof app === 'object' ? app : {};
  if (a.revealed === true) return true;
  if (norm(a.origin) === 'admin_applied') return true;
  if (INTRODUCED_STAGES.has(norm(a.ats_stage))) return true;
  if (a.interview_completed_at) return true;
  if (APPROVED_DECISIONS.has(norm(a.practice_decision))) return true;
  return false;
}

function isOpen(app) {
  const a = app && typeof app === 'object' ? app : {};
  if (TERMINAL_STAGES.has(norm(a.ats_stage))) return false;
  if (TERMINAL_STATUSES.has(norm(a.status))) return false;
  return true;
}

// Returns one entry per stalled application, longest-quiet first.
function findStalledApplications(applications, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const nowMs = parseTs(opts.now) || Date.now();
  const thresholdDays = Number.isFinite(Number(opts.thresholdDays)) && Number(opts.thresholdDays) > 0
    ? Number(opts.thresholdDays) : DEFAULT_THRESHOLD_DAYS;
  const list = Array.isArray(applications) ? applications : [];
  const out = [];
  for (const app of list) {
    if (!app || typeof app !== 'object' || !app.id) continue;
    if (!isOpen(app) || !isIntroduced(app)) continue;
    const last = lastMovementAt(app);
    if (!last) continue; // no timestamps at all — nothing to measure against
    const daysQuiet = Math.floor((nowMs - parseTs(last)) / DAY_MS);
    if (daysQuiet < thresholdDays) continue;
    out.push({
      id: String(app.id),
      user_id: app.user_id || null,
      career_role_id: app.career_role_id != null ? app.career_role_id : null,
      practice_id: app.practice_id != null ? app.practice_id : null,
      ats_stage: app.ats_stage || 'applied',
      status: app.status || '',
      revealed: app.revealed === true,
      last_movement_at: last,
      days_quiet: daysQuiet
    });
  }
  out.sort((x, y) => y.days_quiet - x.days_quiet || String(x.id).localeCompare(String(y.id)));
  return out;
}

// Sentinel bookkeeping for the daily alert: an application is alerted once per
// "quiet stretch" — if it moves and later goes quiet again, it alerts again.
function selectFreshStalls(stalled, sentinel) {
  const seen = sentinel && typeof sentinel === 'object' ? sentinel : {};
  return (Array.isArray(stalled) ? stalled : []).filter((item) => {
    const prior = seen[item.id];
    if (!prior || typeof prior !== 'object') return true;
    return String(prior.last_movement_at || '') !== String(item.last_movement_at || '');
  });
}

function nextSentinel(stalled, sentinel, nowIso) {
  const seen = sentinel && typeof sentinel === 'object' ? sentinel : {};
  const next = {};
  for (const item of (Array.isArray(stalled) ? stalled : [])) {
    const prior = seen[item.id];
    const same = prior && typeof prior === 'object' && String(prior.last_movement_at || '') === String(item.last_movement_at || '');
    next[item.id] = same
      ? prior
      : { alerted_at: nowIso || new Date().toISOString(), last_movement_at: item.last_movement_at, days_quiet_at_alert: item.days_quiet };
  }
  return next;
}

module.exports = {
  DEFAULT_THRESHOLD_DAYS,
  MOVEMENT_FIELDS,
  lastMovementAt,
  isIntroduced,
  isOpen,
  findStalledApplications,
  selectFreshStalls,
  nextSentinel
};

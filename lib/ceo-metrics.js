'use strict';

// ── Constants ───────────────────────────────────────────────────
var OPEN_TASK_STATUSES = ['open','in_progress','waiting','waiting_on_gp','waiting_on_practice','waiting_on_external','escalated'];
var OVERDUE_EXCLUDED_STATUSES = ['completed','cancelled'];

// User-facing funnel order == true DB progression so the cumulative funnel narrows top->bottom (#28).
var FUNNEL_STAGES = [
  { key: 'myintealth', label: 'MyIntealth' },
  { key: 'amc', label: 'AMC' },
  { key: 'career', label: 'Secure Placement' },
  { key: 'ahpra', label: 'AHPRA' },
  { key: 'pbs', label: 'PBS & Medicare' },
  { key: 'commencement', label: 'Commencement' }
];

// visa shares pbs index (deferred); complete sits above the funnel (#56).
var DB_STAGE_ORDER = { myintealth: 0, amc: 1, career: 2, ahpra: 3, pbs: 4, visa: 4, commencement: 5, complete: 6 };

var SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 182;
var DAY_MS = 86400000;

// ── Status normalisation (mirrors server.js:10102) ──────────────
function normalizeStatusKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Single source of secured statuses — mirrors server.js:10126 incl. 'placed' (#8/#61).
var SECURED_STATUS_KEYS = new Set(['hired','secured','placed','placement_secured','offer_accepted','contract_signed']);
var INTERVIEW_STATUS_KEYS = new Set(['interview','interview_scheduled','interview_confirmed']);
var OFFER_STATUS_KEYS = new Set(['offer','offer_pending','offered']);

function isSecuredStatus(status) { return SECURED_STATUS_KEYS.has(normalizeStatusKey(status)); }
function isInterviewStatus(status) { return INTERVIEW_STATUS_KEYS.has(normalizeStatusKey(status)); }
function isOfferStatus(status) { return OFFER_STATUS_KEYS.has(normalizeStatusKey(status)); }

// ── Shared filters / helpers ────────────────────────────────────
// ONE activity-age fallback used everywhere (#37): GP activity, then any touch, then creation.
function caseAgeMs(c, nowMs) {
  var ref = c.last_gp_activity_at || c.updated_at || c.created_at;
  return nowMs - new Date(ref).getTime();
}

// Active = not withdrawn, and (unless allTime) not >6mo stale. Fixes "All Time" lying (#15/#52).
function filterActiveCases(cases, opts) {
  opts = opts || {};
  var nowMs = opts.nowMs;
  var allTime = !!opts.allTime;
  return (cases || []).filter(function(c) {
    if (c.status === 'withdrawn') return false;
    if (!allTime && caseAgeMs(c, nowMs) > SIX_MONTHS_MS) return false;
    return true;
  });
}

// period in {'current','7d','14d','30d','all'}; current/all => always true.
function withinPeriod(isoDate, period, nowMs) {
  if (period === 'all' || period === 'current') return true;
  if (!isoDate) return false;
  var windowMs = period === '7d' ? 7 * DAY_MS : period === '14d' ? 14 * DAY_MS : period === '30d' ? 30 * DAY_MS : 0;
  if (windowMs <= 0) return true;
  return (nowMs - new Date(isoDate).getTime()) <= windowMs;
}

// DATE compare so a task due earlier today is NOT overdue; escalated counts (#1/#30).
function isOverdue(task, todayStr) {
  if (!task || !task.due_date) return false;
  if (OVERDUE_EXCLUDED_STATUSES.indexOf(task.status) !== -1) return false;
  var due = String(task.due_date).slice(0, 10);
  return due < todayStr;
}

// user_ids of active cases — scopes apps/tickets to the same population as cases (#6/#40).
function activeUserIdSet(activeCases) {
  var s = new Set();
  (activeCases || []).forEach(function(c) { if (c.user_id) s.add(c.user_id); });
  return s;
}

module.exports = {
  OPEN_TASK_STATUSES, OVERDUE_EXCLUDED_STATUSES, FUNNEL_STAGES, DB_STAGE_ORDER, SIX_MONTHS_MS, DAY_MS,
  normalizeStatusKey, isSecuredStatus, isInterviewStatus, isOfferStatus,
  caseAgeMs, filterActiveCases, withinPeriod, isOverdue, activeUserIdSet
};

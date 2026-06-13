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

// Set of user_ids that have at least one secured/placed application (#8).
function securedAppUserIds(apps) {
  var s = new Set();
  (apps || []).forEach(function(a) { if (a.user_id && isSecuredStatus(a.status)) s.add(a.user_id); });
  return s;
}

function computeKpis(args) {
  var cases = args.cases || [], tasks = args.tasks || [], apps = args.apps || [];
  var period = args.period || 'current', nowMs = args.nowMs, todayStr = args.todayStr;
  var active = filterActiveCases(cases, { nowMs: nowMs, allTime: (period === 'all') });
  var activeIds = new Set(active.map(function(c){ return c.id; }));
  var activeUsers = activeUserIdSet(active);

  var openTasks = tasks.filter(function(t){ return activeIds.has(t.case_id) && OPEN_TASK_STATUSES.indexOf(t.status) !== -1; });
  var overdue = openTasks.filter(function(t){ return isOverdue(t, todayStr); });
  var blocked = active.filter(function(c){ return c.status === 'blocked' || !!c.blocker_status; });

  // placed = unique active GPs with a secured app (#8).
  var securedUsers = securedAppUserIds(apps);
  var placedCount = 0;
  securedUsers.forEach(function(uid){ if (activeUsers.has(uid)) placedCount++; });

  // completed_gps = ALL-TIME complete (non-withdrawn), independent of staleness/period (#15).
  var completedAll = cases.filter(function(c){ return c.stage === 'complete' && c.status !== 'withdrawn'; });

  return {
    total_gps: active.length,
    placed: placedCount,
    open_tasks: openTasks.length,
    overdue_tasks: overdue.length,
    blocked_cases: blocked.length,
    completed_gps: completedAll.length
  };
}

// ── Pipeline funnel (#2/#3/#28/#29/#56) ─────────────────────────
function _caseStageKey(c) {
  var s = c.stage || 'myintealth';
  if (s === 'visa') s = 'pbs'; // deferred (#56)
  return s;
}
function _stageIndex(stageKey) {
  return DB_STAGE_ORDER[stageKey] !== undefined ? DB_STAGE_ORDER[stageKey] : 0;
}
// Shared membership predicate used by BOTH count and id list.
function _caseInStage(c, stageKey, cumulative) {
  var caseKey = _caseStageKey(c);
  if (caseKey === 'complete') return false; // complete shown in completions, not funnel
  if (cumulative) return _stageIndex(caseKey) >= _stageIndex(stageKey);
  return caseKey === stageKey;
}

function computePipeline(activeCases, opts) {
  var cumulative = !!(opts && opts.cumulative);
  return FUNNEL_STAGES.map(function(stage) {
    var count = 0, blocked = 0;
    (activeCases || []).forEach(function(c) {
      if (!_caseInStage(c, stage.key, cumulative)) return;
      count++;
      // blocked counted ONCE, at the case's CURRENT stage (#3)
      var isBlocked = c.status === 'blocked' || !!c.blocker_status;
      if (isBlocked && _caseStageKey(c) === stage.key) blocked++;
    });
    return { key: stage.key, label: stage.label, count: count, blocked: blocked };
  });
}

// Exactly the case ids the bar counted (#2/#29).
function pipelineCaseIds(activeCases, stageKey, opts) {
  var cumulative = !!(opts && opts.cumulative);
  return (activeCases || []).filter(function(c) { return _caseInStage(c, stageKey, cumulative); })
    .map(function(c) { return c.id; });
}

// ── Blockers (#57): real days_blocked from blocker_set_at, fallback caseAgeMs (#5) ─
function computeBlockers(activeCases, nowMs) {
  return (activeCases || []).filter(function(c) {
    return c.status === 'blocked' || !!c.blocker_status;
  }).map(function(c) {
    var ms = c.blocker_set_at ? (nowMs - new Date(c.blocker_set_at).getTime()) : caseAgeMs(c, nowMs);
    return {
      case_id: c.id, user_id: c.user_id, stage: _caseStageKey(c),
      days_blocked: Math.floor(ms / DAY_MS),
      blocker_status: c.blocker_status || c.status,
      blocker_reason: c.blocker_reason || '',
      assigned_rso: c.assigned_rso || null
    };
  }).sort(function(a, b) { return b.days_blocked - a.days_blocked; });
}

// ── Task Health (#30/#31): overdue matches KPI via isOverdue; labelled avg window ─
function computeTaskHealth(tasks, completedSample, todayStr) {
  tasks = tasks || []; completedSample = completedSample || [];
  var open = 0, inProgress = 0, overdue = 0;
  tasks.forEach(function(t) {
    if (t.status === 'open') open++;
    else if (t.status === 'in_progress') inProgress++;
    if (isOverdue(t, todayStr)) overdue++;
  });
  // week boundary: midnight UTC of (todayStr - 7 days)
  var weekAgoStr = new Date(new Date(todayStr + 'T00:00:00Z').getTime() - 7 * DAY_MS).toISOString();
  var completedThisWeek = 0;
  var durations = [];
  completedSample.forEach(function(t) {
    if (t.completed_at && t.completed_at >= weekAgoStr) completedThisWeek++;
    if (t.completed_at && t.created_at) {
      durations.push((new Date(t.completed_at).getTime() - new Date(t.created_at).getTime()) / DAY_MS);
    }
  });
  var avg = durations.length ? Math.round((durations.reduce(function(a, b){ return a + b; }, 0) / durations.length) * 10) / 10 : 0;
  return {
    open: open,
    in_progress: inProgress,
    completed_this_week: completedThisWeek,
    overdue: overdue,
    avg_resolve_days: avg,
    avg_resolve_sample_size: durations.length
  };
}

// ── RSO workload (#7/#32/#33/#34): case-owner load model ────────
function _caseRsoKey(c) { return c.assigned_rso || '__unassigned__'; }

function rsoCaseIds(activeCases, rsoId) {
  return (activeCases || []).filter(function(c) { return _caseRsoKey(c) === rsoId; })
    .map(function(c) { return c.id; });
}

// Case-owner load model (#33): open/overdue are tasks on this RSO's cases.
function computeRsoWorkload(activeCases, tasks, rsoRoster, todayStr) {
  activeCases = activeCases || []; tasks = tasks || []; rsoRoster = rsoRoster || [];
  var caseRso = {};           // case_id -> rso key
  var buckets = {};           // rso key -> row
  function ensure(id, name) {
    if (!buckets[id]) buckets[id] = { rso_id: id, rso_name: name || (id === '__unassigned__' ? 'Unassigned' : id), case_count: 0, open_tasks: 0, overdue_tasks: 0 };
    return buckets[id];
  }
  // seed roster so zero-case RSOs still show
  rsoRoster.forEach(function(r) { ensure(r.rso_id, r.rso_name); });
  activeCases.forEach(function(c) {
    var key = _caseRsoKey(c);
    caseRso[c.id] = key;
    ensure(key).case_count++;
  });
  tasks.forEach(function(t) {
    var key = caseRso[t.case_id];
    if (!key || !buckets[key]) return; // task on a non-active case -> ignore
    if (OPEN_TASK_STATUSES.indexOf(t.status) !== -1) buckets[key].open_tasks++;
    if (isOverdue(t, todayStr)) buckets[key].overdue_tasks++;
  });
  return Object.keys(buckets).map(function(k) { return buckets[k]; })
    .sort(function(a, b) { return b.case_count - a.case_count; });
}

// ── Placements funnel (#8/#9/#10/#11/#60/#61) ───────────────────
// NOTE: placement buckets are an OVERLAPPING FUNNEL, not mutually exclusive (#60):
// applied >= submitted >= interviewing >= offers >= secured. Do not sum the tiles.
function _placementInScope(app, activeUserIds, period, nowMs) {
  if (activeUserIds && !activeUserIds.has(app.user_id)) return false;
  return withinPeriod(app.applied_at, period, nowMs);
}
function _inPlacementBucket(app, bucket, interviewAppIds) {
  var status = app.status;
  var isInterviewing = isInterviewStatus(status) || (interviewAppIds && interviewAppIds.has(app.id));
  if (bucket === 'secured') return isSecuredStatus(status);
  if (bucket === 'offers_made') return isOfferStatus(status) && !isSecuredStatus(status);
  if (bucket === 'interviewing') return isInterviewing && !isSecuredStatus(status);
  if (bucket === 'submitted_to_practice') return !!app.practice_submission_status && app.practice_submission_status !== 'pending_va_submission';
  if (bucket === 'applied') {
    var s = normalizeStatusKey(status);
    if (s === 'withdrawn' || s === 'rejected') return false;
    if (isSecuredStatus(status) || isOfferStatus(status) || isInterviewing) return false;
    return true;
  }
  return false;
}

function placementAppIds(apps, bucket, activeUserIds, interviewAppIds, period, nowMs) {
  return (apps || []).filter(function(a) {
    return _placementInScope(a, activeUserIds, period, nowMs) && _inPlacementBucket(a, bucket, interviewAppIds);
  }).map(function(a) { return a.id; });
}

function computePlacements(apps, careerRoles, activeUserIds, interviewAppIds, period, nowMs) {
  function n(bucket) { return placementAppIds(apps, bucket, activeUserIds, interviewAppIds, period, nowMs).length; }
  var activeRoles = (careerRoles || []).filter(function(r) { return !!r.is_active; }).length;
  return {
    applied: n('applied'),
    submitted_to_practice: n('submitted_to_practice'),
    interviewing: n('interviewing'),
    offers_made: n('offers_made'),
    secured: n('secured'),
    active_roles: activeRoles
  };
}

// ── GP activity (period-independent staleness) (#12/#36/#37) ─────
function _activityDays(c, nowMs) { return Math.floor(caseAgeMs(c, nowMs) / DAY_MS); }
function _activityBucket(c, nowMs) {
  var d = _activityDays(c, nowMs);
  if (d <= 7) return 'active';
  if (d <= 14) return 'inactive';
  return 'cold';
}

function gpActivityCaseIds(activeCases, bucket, nowMs) {
  return (activeCases || []).filter(function(c) { return _activityBucket(c, nowMs) === bucket; })
    .map(function(c) { return c.id; });
}

function computeGpActivity(activeCases, nowMs) {
  activeCases = activeCases || [];
  var active = 0, inactive = 0, cold = [];
  activeCases.forEach(function(c) {
    var b = _activityBucket(c, nowMs);
    if (b === 'active') active++;
    else if (b === 'inactive') inactive++;
    else cold.push(c);
  });
  var coldGps = cold.map(function(c) {
    return {
      case_id: c.id, user_id: c.user_id, stage: _caseStageKey(c),
      last_activity: c.last_gp_activity_at || c.updated_at || c.created_at,
      days_inactive: _activityDays(c, nowMs),
      assigned_rso: c.assigned_rso || null
    };
  }).sort(function(a, b) { return b.days_inactive - a.days_inactive; }).slice(0, 10); // sort BEFORE slice (#36)
  return { active_7d: active, inactive_7_14d: inactive, cold_14d_plus: cold.length, cold_gps: coldGps };
}

module.exports = {
  OPEN_TASK_STATUSES, OVERDUE_EXCLUDED_STATUSES, FUNNEL_STAGES, DB_STAGE_ORDER, SIX_MONTHS_MS, DAY_MS,
  normalizeStatusKey, isSecuredStatus, isInterviewStatus, isOfferStatus,
  caseAgeMs, filterActiveCases, withinPeriod, isOverdue, activeUserIdSet,
  securedAppUserIds, computeKpis,
  computePipeline, pipelineCaseIds,
  computeBlockers,
  computeTaskHealth,
  computeRsoWorkload, rsoCaseIds,
  computePlacements, placementAppIds,
  computeGpActivity, gpActivityCaseIds
};

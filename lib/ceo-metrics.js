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

// App-level bucket predicates (F1 audit 2026-07-20): modern ATS flows write
// gp_applications.ats_stage ('offer'/'interview'/'hired') WITHOUT ever touching
// the legacy status column (offer-send, interview booking, board-drag hire), so
// every placement bucket is the UNION of the legacy status and the ats_stage.
function _appAtsStageKey(app) { return normalizeStatusKey(app && app.ats_stage); }
function isSecuredApp(app) {
  return isSecuredStatus(app && app.status) || _appAtsStageKey(app) === 'hired';
}
function isOfferApp(app) {
  return isOfferStatus(app && app.status) || _appAtsStageKey(app) === 'offer';
}
// interviewAppIds: Set of application ids with a live interview row
// (career_interviews UNION booked scheduled_calls) — supplied by the caller.
function isInterviewingApp(app, interviewAppIds) {
  return isInterviewStatus(app && app.status)
    || _appAtsStageKey(app) === 'interview'
    || !!(interviewAppIds && app && interviewAppIds.has(app.id));
}

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

// Per-RSO ops grouping: return the tasks whose owning case is assigned to rsoId.
// A task with no case_id, or whose case has no assigned_rso, falls into the
// '__unassigned__' bucket (mirrors _caseRsoKey).
function opsTasksForRso(tasks, caseById, rsoId) {
  var out = [];
  for (var i = 0; i < (tasks || []).length; i++) {
    var t = tasks[i];
    var c = t && t.case_id ? caseById[t.case_id] : null;
    var key = (c && c.assigned_rso) ? c.assigned_rso : '__unassigned__';
    if (key === rsoId) out.push(t);
  }
  return out;
}

// Per-RSO support tickets: group by the assigned_rso of each ticket's linked case.
// No case_id, or a case with no assigned_rso → '__unassigned__'.
function supportTicketsForRso(tickets, caseById, rsoId) {
  var out = [];
  for (var i = 0; i < (tickets || []).length; i++) {
    var t = tickets[i];
    var c = t && t.case_id ? caseById[t.case_id] : null;
    var key = (c && c.assigned_rso) ? c.assigned_rso : '__unassigned__';
    if (key === rsoId) out.push(t);
  }
  return out;
}

// Resolve an RSO reassignment target from already-fetched rows. Pure + dependency-free.
// rosterRows: rso_team rows [{user_id,name,email,active,...}]
// vaGmailRows: va_gmail_accounts rows [{user_id,email_address,display_name}]
// masterArchiveEmail: the GP Link Admin / master-archive inbox (hello@). When the target
//   RSO is this account, it is allowed WITHOUT a va_gmail_accounts mailbox (hello@ must
//   never be Gmail-watched) and the result carries isArchive:true so the caller hands off
//   without provisioning a watched mailbox.
// Returns { ok, error, rso, mailbox, isArchive? }. ok=false carries a human-readable error
// so the caller can return a clear 4xx instead of silently no-opping (#44).
function resolveRsoReassignmentTarget(rosterRows, vaGmailRows, newRsoId, masterArchiveEmail) {
  var roster = Array.isArray(rosterRows) ? rosterRows : [];
  var mailboxes = Array.isArray(vaGmailRows) ? vaGmailRows : [];
  if (!newRsoId || newRsoId === '__unassigned__') {
    return { ok: false, error: 'Cannot reassign to the unassigned bucket.', rso: null, mailbox: null };
  }
  var rso = null;
  for (var i = 0; i < roster.length; i++) {
    if (String(roster[i].user_id) === String(newRsoId)) { rso = roster[i]; break; }
  }
  if (!rso) {
    return { ok: false, error: 'Target is not a registered RSO.', rso: null, mailbox: null };
  }
  // Refuse reassignment to a deactivated RSO (#14). Checked after the roster match
  // (so the rso row is carried) but before the mailbox lookup, so an inactive RSO
  // reports as inactive rather than as missing-a-mailbox.
  if (rso.active === false) {
    return { ok: false, error: 'Target RSO is inactive.', rso: rso, mailbox: null };
  }
  // Refuse assigning work to an RSO who is marked on leave (G2a). Their EXISTING cases
  // are untouched — moving those is the explicit bulk-reassign tool's job.
  if (rso.on_leave === true) {
    return { ok: false, error: 'Target RSO "' + (rso.name || rso.email || newRsoId) + '" is on leave. Clear the on-leave flag first, or pick another RSO.', rso: rso, mailbox: null };
  }
  // The master-archive account (GP Link Admin / hello@) is a valid central owner but has
  // NO watched Gmail mailbox by design — hello@ must never be Gmail-watched, and it already
  // mirrors every case email. Allow it without a va_gmail_accounts entry; isArchive tells
  // the caller to hand off (archive the old label) instead of provisioning a watched mailbox.
  var archiveEmail = masterArchiveEmail ? String(masterArchiveEmail).trim().toLowerCase() : '';
  if (archiveEmail && String(rso.email || '').trim().toLowerCase() === archiveEmail) {
    return { ok: true, error: null, rso: rso, mailbox: null, isArchive: true };
  }
  var mailbox = null;
  for (var j = 0; j < mailboxes.length; j++) {
    if (String(mailboxes[j].user_id) === String(newRsoId)) { mailbox = mailboxes[j]; break; }
  }
  if (!mailbox) {
    return {
      ok: false,
      error: 'RSO "' + (rso.name || rso.email || newRsoId) + '" has no Gmail mailbox registered. Add a va_gmail_accounts entry before reassigning.',
      rso: rso,
      mailbox: null
    };
  }
  return { ok: true, error: null, rso: rso, mailbox: mailbox };
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

// Choose the RSO with the fewest OPEN tasks, for routing an un-placed candidate's
// document check. Excludes on-leave / inactive RSOs, the '__unassigned__' bucket,
// and any user_id in opts.excludeUserIds (e.g. the hello@ archive mailbox).
// Tie-break: fewest cases, then name. Returns a user_id string or null.
function pickLeastLoadedRso(activeCases, tasks, rsoRoster, todayStr, opts = {}) {
  const exclude = new Set((opts.excludeUserIds || []).filter(Boolean));
  const rows = computeRsoWorkload(activeCases, tasks, rsoRoster, todayStr)
    .filter((r) => r && r.rso_id && r.rso_id !== '__unassigned__' && !exclude.has(r.rso_id));
  const activeById = {};
  (rsoRoster || []).forEach((r) => { if (r && r.user_id) activeById[r.user_id] = r; });
  const eligible = rows.filter((r) => {
    const m = activeById[r.rso_id];
    return m && m.active !== false && m.on_leave !== true;
  });
  if (!eligible.length) return null;
  eligible.sort((a, b) =>
    (a.open_tasks - b.open_tasks) ||
    (a.case_count - b.case_count) ||
    String(a.rso_name || '').localeCompare(String(b.rso_name || '')));
  return eligible[0].rso_id;
}

// Per-RSO scheduled calls: filter calls by assigned_rso_email (case-insensitive).
// An empty/null rsoEmail returns calls with no assigned_rso_email (the unassigned
// bucket), mirroring _caseRsoKey/'__unassigned__' semantics elsewhere.
function callsForRso(calls, rsoEmail) {
  var email = rsoEmail ? String(rsoEmail).trim().toLowerCase() : '';
  var out = [];
  for (var i = 0; i < (calls || []).length; i++) {
    var c = calls[i];
    var e = (c && c.assigned_rso_email) ? String(c.assigned_rso_email).trim().toLowerCase() : '';
    if (email) { if (e === email) out.push(c); }
    else { if (!e) out.push(c); }
  }
  return out;
}

// GP file Tasks sub-tab: filter + group a case's tasks for read-only display.
// - Hides completed/cancelled (OVERDUE_EXCLUDED_STATUSES) unless opts.showAll.
// - Groups by related_stage; known stages ordered by DB_STAGE_ORDER, unknown
//   stages after those (by first appearance), the no-stage bucket ('__none__') last.
// - Within a group, input order is preserved.
// - Annotates each task with an `overdue` boolean (via isOverdue), so completed/
//   cancelled tasks are never overdue even when shown via showAll.
// Returns [{ stage, tasks: [...] }].
function gpTasksByStage(tasks, opts) {
  opts = opts || {};
  var showAll = !!opts.showAll;
  var todayStr = opts.todayStr;
  var order = [];     // stage keys in display order
  var groups = {};    // stage key -> task[]
  function bucket(key) {
    if (!groups[key]) { groups[key] = []; order.push(key); }
    return groups[key];
  }
  (tasks || []).forEach(function(t) {
    if (!t) return;
    if (!showAll && OVERDUE_EXCLUDED_STATUSES.indexOf(t.status) !== -1) return;
    var key = t.related_stage ? String(t.related_stage) : '__none__';
    var row = Object.assign({}, t, { overdue: isOverdue(t, todayStr) });
    bucket(key).push(row);
  });
  function rank(key) {
    if (key === '__none__') return [2, 0];                         // always last
    if (DB_STAGE_ORDER[key] !== undefined) return [0, DB_STAGE_ORDER[key]]; // known stages first
    return [1, order.indexOf(key)];                                // unknown stages between, by first-seen
  }
  return order.slice().sort(function(a, b) {
    var ra = rank(a), rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1];
  }).map(function(key) { return { stage: key, tasks: groups[key] }; });
}

// GP file Notes sub-tab: notes are the timeline entries whose event_type is
// 'note' (there is no separate notes store). Newest first by created_at.
function gpNotesFromTimeline(timeline) {
  return (timeline || [])
    .filter(function(e) { return e && e.event_type === 'note'; })
    .slice()
    .sort(function(a, b) {
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });
}

// GP file Timeline sub-tab: merge timeline events + comms messages into one
// newest-first stream, tagging each with `kind` ('event' | 'message') so the
// renderer can pick the right icon/layout. Pure read-only; does not mutate input.
function mergeGpTimeline(timeline, messages) {
  var merged = [];
  (timeline || []).forEach(function(e) {
    if (!e) return;
    merged.push(Object.assign({}, e, { kind: 'event' }));
  });
  (messages || []).forEach(function(m) {
    if (!m) return;
    merged.push(Object.assign({}, m, { kind: 'message' }));
  });
  return merged.sort(function(a, b) {
    return new Date(b.created_at || 0) - new Date(a.created_at || 0);
  });
}

// GP file Documents sub-tab: normalize the four document categories returned by
// GET /api/admin/gp-documents into a fixed-order list of sections for rendering.
// Each section is { key, label, docs }; empty categories are kept (so the UI can
// show "no documents"). Each doc is normalized to { label, status, url, fileName,
// updatedAt }, preferring the primary field name then the admin alias:
//   label  <- label || document_key
//   status <- status || ops_status
//   url    <- file_url || webViewLink (null when neither present -> not viewable)
//   fileName <- file_name || name
// Pure read-only; does not mutate input. Doc order within a category is preserved.
var GP_DOCUMENT_CATEGORIES = [
  { key: 'directToAhpra', label: 'Direct to AHPRA' },
  { key: 'preparedByCandidate', label: 'Prepared by Candidate' },
  { key: 'preparedByGpLink', label: 'Prepared by GP LINK' },
  { key: 'otherFiles', label: 'Other Files' }
];
function gpDocumentSections(documents) {
  var src = documents || {};
  return GP_DOCUMENT_CATEGORIES.map(function(cat) {
    var list = Array.isArray(src[cat.key]) ? src[cat.key] : [];
    var docs = list.filter(function(d) { return !!d; }).map(function(d) {
      return {
        key: (d.key != null && d.key !== '') ? d.key : (d.document_key || ''),
        label: (d.label != null && d.label !== '') ? d.label : (d.document_key || ''),
        status: (d.status != null && d.status !== '') ? d.status : (d.ops_status || null),
        url: d.file_url || d.webViewLink || null,
        fileName: d.file_name || d.name || null,
        updatedAt: d.updated_at || null
      };
    });
    return { key: cat.key, label: cat.label, docs: docs };
  });
}

// The actionable practice-pack task for a document key (most recent non-terminal
// one), or null. Tasks arrive created_at.desc, so the first non-completed/cancelled
// match is the newest open task. Used to attach document controls to GP LINK doc rows.
function docTaskForKey(tasks, docKey) {
  if (!docKey) return null;
  var matches = [];
  for (var i = 0; i < (tasks || []).length; i++) {
    var t = tasks[i];
    if (t && t.task_type === 'practice_pack_child' && t.related_document_key === docKey) matches.push(t);
  }
  if (!matches.length) return null;
  for (var j = 0; j < matches.length; j++) {
    var s = matches[j].status;
    if (s !== 'completed' && s !== 'cancelled') return matches[j];
  }
  return matches[0];
}

// Which document actions are available for a task, mirroring admin.html gating
// (pages/admin.html ~1725). Upload is offered for the two uploadable pack docs;
// approve when an attachment is present; request-revision for auto-received docs.
function docActionsFor(task) {
  var key = task && task.related_document_key;
  var canUpload = key === 'offer_contract' || key === 'supervisor_cv';
  var hasAttachment = !!(task && (task.attachment_url || task.zoho_attachment_id));
  var autoReceived = !!(task && task.gmail_message_id && task.attachment_url);
  return { upload: canUpload, approve: hasAttachment, requestRevision: autoReceived };
}

// ── Placements funnel (#8/#9/#10/#11/#60/#61) ───────────────────
// NOTE: placement buckets are an OVERLAPPING FUNNEL, not mutually exclusive (#60):
// applied >= submitted >= interviewing >= offers >= secured. Do not sum the tiles.
function _placementInScope(app, activeUserIds, period, nowMs) {
  if (activeUserIds && !activeUserIds.has(app.user_id)) return false;
  return withinPeriod(app.applied_at, period, nowMs);
}
function _inPlacementBucket(app, bucket, interviewAppIds) {
  // Legacy status ∪ ats_stage predicates (F1) — precedence unchanged: secured
  // wins over offer wins over interviewing, so no app double-counts upward.
  var isInterviewing = isInterviewingApp(app, interviewAppIds);
  if (bucket === 'secured') return isSecuredApp(app);
  if (bucket === 'offers_made') return isOfferApp(app) && !isSecuredApp(app);
  if (bucket === 'interviewing') return isInterviewing && !isSecuredApp(app);
  if (bucket === 'submitted_to_practice') return !!app.practice_submission_status && app.practice_submission_status !== 'pending_va_submission';
  if (bucket === 'applied') {
    var s = normalizeStatusKey(app.status);
    if (s === 'withdrawn' || s === 'rejected') return false;
    if (isSecuredApp(app) || isOfferApp(app) || isInterviewing) return false;
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

// tickets scoped to active GPs (#40). Pass full population (#39). weekAgoIso = ISO of nowMs-7d (caller supplies).
function _ticketInScope(t, activeUserIds) {
  if (!activeUserIds) return true;
  return activeUserIds.has(t.user_id);
}
function ticketIds(tickets, bucket, activeUserIds) {
  return (tickets || []).filter(function(t) {
    if (!_ticketInScope(t, activeUserIds)) return false;
    if (bucket === 'open') return t.status !== 'closed';
    if (bucket === 'resolved') return t.status === 'closed';
    return false;
  }).map(function(t) { return t.id; });
}
function computeTicketMetrics(tickets, activeUserIds, weekAgoIso) {
  var scoped = (tickets || []).filter(function(t) { return _ticketInScope(t, activeUserIds); });
  var open = 0;
  var resolvedThisWeek = 0;
  var resDur = [], replyDur = [];
  scoped.forEach(function(t) {
    if (t.status !== 'closed') { open++; return; }
    if (t.resolved_at && weekAgoIso && t.resolved_at >= weekAgoIso) resolvedThisWeek++;
    if (t.resolved_at && t.created_at) resDur.push((new Date(t.resolved_at).getTime() - new Date(t.created_at).getTime()) / 3600000);
    if (t.first_reply_at && t.created_at) replyDur.push((new Date(t.first_reply_at).getTime() - new Date(t.created_at).getTime()) / 3600000);
  });
  function avg(arr) { return arr.length ? Math.round((arr.reduce(function(a, b){ return a + b; }, 0) / arr.length) * 10) / 10 : null; }
  return {
    open: open,
    resolved_this_week: resolvedThisWeek,
    avg_resolution_hours: avg(resDur),
    avg_resolution_sample_size: resDur.length,
    avg_first_reply_hours: avg(replyDur),
    avg_first_reply_sample_size: replyDur.length
  };
}

var _STAGE_LABEL_BY_KEY = (function() {
  var m = { complete: 'Complete' };
  FUNNEL_STAGES.forEach(function(s) { m[s.key] = s.label; });
  return m;
})();

function _milestoneToStage(ev) {
  var meta = ev.metadata;
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (e) { meta = null; } }
  if (meta && meta.to_stage) return meta.to_stage;
  var m = String(ev.title || '').match(/stage advanced to (\w+)/i);
  return m ? m[1].toLowerCase() : null;
}

function computeCompletions(completeCases, stageEvents, nowMs) {
  completeCases = completeCases || []; stageEvents = stageEvents || [];
  var d = new Date(nowMs);
  var monthStartIso = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); // UTC (#62)
  var thisMonth = 0;
  completeCases.forEach(function(c) {
    if (c.completed_at && c.completed_at >= monthStartIso) thisMonth++; // completed_at only (#62)
  });
  var milestones = stageEvents.slice()
    .sort(function(a, b) { return new Date(b.created_at).getTime() - new Date(a.created_at).getTime(); }) // global desc (#14)
    .slice(0, 5)
    .map(function(ev) {
      var stage = _milestoneToStage(ev);
      var label = stage ? (_STAGE_LABEL_BY_KEY[stage] || stage) : 'a new stage';
      return {
        case_id: ev.case_id,
        milestone: stage === 'complete' ? 'Completed Registration' : ('Reached ' + label), // humanized (#41)
        date: ev.created_at,
        days_ago: Math.floor((nowMs - new Date(ev.created_at).getTime()) / DAY_MS)
      };
    });
  return { this_month: thisMonth, total: completeCases.length, recent_milestones: milestones };
}

// ── Cross-system conversion funnel + time-to-placement (Phase 6 H2) ─────────
// Counts and durations ONLY — revenue is deliberately excluded (Xero owns money).

// GP lead-source attribution ("How did you hear about us?", asked optionally
// at onboarding). Keys here are the ONLY values ever persisted to
// user_profiles.lead_source — everything else is treated as unanswered.
var LEAD_SOURCES = [
  { key: 'google', label: 'Google search' },
  { key: 'facebook_instagram', label: 'Facebook / Instagram' },
  { key: 'colleague_referral', label: 'Referral from a colleague' },
  { key: 'medical_college_event', label: 'Medical college / event' },
  { key: 'other', label: 'Other' }
];

function sanitizeLeadSource(value) {
  var v = String(value || '').trim().toLowerCase();
  for (var i = 0; i < LEAD_SOURCES.length; i++) { if (LEAD_SOURCES[i].key === v) return v; }
  return '';
}

function _tsMs(iso) { var t = new Date(iso || '').getTime(); return isFinite(t) ? t : null; }

function _durationStats(days) {
  if (!days.length) return { median_days: null, avg_days: null, sample_size: 0 };
  var s = days.slice().sort(function(a, b) { return a - b; });
  var mid = Math.floor(s.length / 2);
  var median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  var avg = days.reduce(function(a, b) { return a + b; }, 0) / days.length;
  return {
    median_days: Math.round(median * 10) / 10,
    avg_days: Math.round(avg * 10) / 10,
    sample_size: days.length
  };
}

// Median/avg days from signup (registration_cases.created_at) and from first
// application (gp_applications.applied_at) to placement. Placement moment per
// GP = earliest placements.placed_at row; falls back to the secured
// application's updated_at (its only timestamp) when no placements row exists.
// Duration stats are period-independent: they cover every placed GP on record.
function computeTimeToPlacement(cases, apps, placements) {
  var placedAt = {}; // user_id -> earliest placement ms
  (placements || []).forEach(function(p) {
    if (!p.user_id || p.status === 'cancelled') return;
    var t = _tsMs(p.placed_at || p.created_at);
    if (t !== null && (placedAt[p.user_id] === undefined || t < placedAt[p.user_id])) placedAt[p.user_id] = t;
  });
  var securedAt = {}; // fallback per user: earliest secured-app updated_at
  (apps || []).forEach(function(a) {
    if (!a.user_id || !isSecuredStatus(a.status)) return;
    var t = _tsMs(a.updated_at || a.applied_at);
    if (t !== null && (securedAt[a.user_id] === undefined || t < securedAt[a.user_id])) securedAt[a.user_id] = t;
  });
  Object.keys(securedAt).forEach(function(u) { if (placedAt[u] === undefined) placedAt[u] = securedAt[u]; });

  var signupAt = {}; // user_id -> earliest case created_at ms
  (cases || []).forEach(function(c) {
    if (!c.user_id) return;
    var t = _tsMs(c.created_at);
    if (t !== null && (signupAt[c.user_id] === undefined || t < signupAt[c.user_id])) signupAt[c.user_id] = t;
  });
  var appliedAt = {}; // user_id -> earliest applied_at ms
  (apps || []).forEach(function(a) {
    if (!a.user_id) return;
    var t = _tsMs(a.applied_at);
    if (t !== null && (appliedAt[a.user_id] === undefined || t < appliedAt[a.user_id])) appliedAt[a.user_id] = t;
  });

  var fromSignup = [], fromApplication = [];
  Object.keys(placedAt).forEach(function(u) {
    if (signupAt[u] !== undefined) {
      var d = (placedAt[u] - signupAt[u]) / DAY_MS;
      if (d >= 0) fromSignup.push(d);
    }
    if (appliedAt[u] !== undefined) {
      var d2 = (placedAt[u] - appliedAt[u]) / DAY_MS;
      if (d2 >= 0) fromApplication.push(d2);
    }
  });
  return { from_signup: _durationStats(fromSignup), from_application: _durationStats(fromApplication) };
}

function _funnelSteps(defs) {
  var out = [];
  for (var i = 0; i < defs.length; i++) {
    var prev = i > 0 ? out[i - 1].count : null;
    out.push({
      key: defs[i].key,
      label: defs[i].label,
      count: defs[i].count,
      // step-to-step conversion; null on the first step or when the previous
      // step is 0 (a % of nothing is meaningless, not 0%).
      conversion_pct: (i === 0 || !prev) ? null : Math.round((defs[i].count / prev) * 1000) / 10
    });
  }
  return out;
}

// The end-to-end business funnel, across systems, for one selectable period.
// Practice side: leads (site_enquiries kind=practice + Facebook-lead practices)
// -> practices signed -> jobs live -> GP applicants -> interviews -> placements.
// GP side (cohort): signups in period -> onboarding complete -> placement secured.
function computeConversionFunnel(data, period, nowMs) {
  data = data || {};
  var enquiries = data.enquiries || [];
  var practices = data.practices || [];
  var roles = data.roles || [];
  var apps = data.apps || [];
  var interviews = data.interviews || [];
  var cases = data.cases || [];
  var placements = data.placements || [];
  var profiles = data.profiles || [];

  function inP(iso) { return withinPeriod(iso, period, nowMs); }

  // 1. Practice leads: marketing-site practice enquiries + FB-lead practices
  //    (FB webhook leads land directly as practices rows, never in site_enquiries).
  var practiceLeads = 0;
  enquiries.forEach(function(e) { if ((e.kind || '') === 'practice' && inP(e.created_at)) practiceLeads++; });
  practices.forEach(function(p) { if (p.source === 'facebook_lead' && inP(p.created_at)) practiceLeads++; });

  // 2. Practices signed (agreement signed, bucketed by when they signed).
  //    F14 (audit 2026-07-20): the sign endpoint stashes the signature under
  //    metadata.pipeline_agreement when the agreement_* columns are missing
  //    (degraded persist path) — dual-read like every other agreement reader.
  var practicesSigned = practices.filter(function(p) {
    var metaAgr = (p && p.metadata && p.metadata.pipeline_agreement) || null;
    var signed = p.agreement_status === 'signed' || (metaAgr && metaAgr.agreement_status === 'signed');
    if (!signed) return false;
    return inP(p.agreement_signed_at || (metaAgr && metaAgr.agreement_signed_at) || p.created_at);
  }).length;

  // 3. Jobs live (active + approved roles, bucketed by publish/create time).
  var jobsLive = roles.filter(function(r) {
    if (r.is_active === false) return false;
    if (r.approval_status && r.approval_status !== 'approved') return false;
    return inP(r.published_at || r.created_at);
  }).length;

  // 4. GP applicants (unique GPs who applied in the period).
  var applicantUsers = new Set();
  apps.forEach(function(a) { if (a.user_id && inP(a.applied_at)) applicantUsers.add(a.user_id); });

  // 5. Interviews (career_interviews created in the period, cancelled excluded).
  var interviewCount = interviews.filter(function(iv) {
    return normalizeStatusKey(iv.status) !== 'cancelled' && inP(iv.created_at);
  }).length;

  // 6. Placements (unique placed GPs: placements rows + secured apps, same
  //    dedupe rule as the dashboard's Placed KPI).
  var placedUsers = new Set();
  placements.forEach(function(p) {
    if (p.user_id && p.status !== 'cancelled' && inP(p.placed_at || p.created_at)) placedUsers.add(p.user_id);
  });
  apps.forEach(function(a) {
    if (a.user_id && isSecuredStatus(a.status) && inP(a.updated_at || a.applied_at)) placedUsers.add(a.user_id);
  });

  var practiceFunnel = _funnelSteps([
    { key: 'practice_leads', label: 'Practice leads', count: practiceLeads },
    { key: 'practices_signed', label: 'Practices signed', count: practicesSigned },
    { key: 'jobs_live', label: 'Jobs live', count: jobsLive },
    { key: 'gp_applicants', label: 'GP applicants', count: applicantUsers.size },
    { key: 'interviews', label: 'Interviews', count: interviewCount },
    { key: 'placements', label: 'Placements', count: placedUsers.size }
  ]);

  // GP-side cohort funnel: of the GPs who signed up in the period, how many
  // finished onboarding, and how many have secured a placement (any time).
  var profileByUser = {};
  profiles.forEach(function(p) { if (p.user_id) profileByUser[p.user_id] = p; });
  var allPlacedUsers = new Set();
  placements.forEach(function(p) { if (p.user_id && p.status !== 'cancelled') allPlacedUsers.add(p.user_id); });
  apps.forEach(function(a) { if (a.user_id && isSecuredStatus(a.status)) allPlacedUsers.add(a.user_id); });

  var signupUsers = new Set();
  cases.forEach(function(c) { if (c.user_id && inP(c.created_at)) signupUsers.add(c.user_id); });
  var onboarded = 0, placedOfCohort = 0;
  signupUsers.forEach(function(u) {
    var prof = profileByUser[u];
    if (prof && prof.onboarding_completed_at) onboarded++;
    if (allPlacedUsers.has(u)) placedOfCohort++;
  });

  var gpFunnel = _funnelSteps([
    { key: 'gp_signups', label: 'GP signups', count: signupUsers.size },
    { key: 'onboarding_complete', label: 'Onboarding complete', count: onboarded },
    { key: 'placement_secured', label: 'Placement secured', count: placedOfCohort }
  ]);

  return {
    practice_funnel: practiceFunnel,
    gp_funnel: gpFunnel,
    time_to_placement: computeTimeToPlacement(cases, apps, placements)
  };
}

// "How GPs found us": lead_source breakdown over the GPs who signed up in the
// period (anchored on registration_cases, same population as the trends
// new_gps series), including 'unknown' for GPs who skipped the question.
// GPs who answered at onboarding but have no registration case yet are still
// counted (period via onboarding_completed_at) so early answers aren't lost.
function computeSourceAttribution(cases, profiles, period, nowMs) {
  var byUser = {};
  (profiles || []).forEach(function(p) { if (p.user_id) byUser[p.user_id] = p; });

  var seen = new Set();
  var counts = {};
  LEAD_SOURCES.forEach(function(s) { counts[s.key] = 0; });
  var unknown = 0;
  var details = [];

  function tally(userId) {
    var prof = byUser[userId];
    var src = sanitizeLeadSource(prof && prof.lead_source);
    if (src) {
      counts[src]++;
      if (prof.lead_source_detail) details.push({ source: src, detail: String(prof.lead_source_detail).slice(0, 200) });
    } else {
      unknown++;
    }
  }

  (cases || []).forEach(function(c) {
    if (!c.user_id || seen.has(c.user_id)) return;
    if (!withinPeriod(c.created_at, period, nowMs)) return;
    seen.add(c.user_id);
    tally(c.user_id);
  });
  (profiles || []).forEach(function(p) {
    if (!p.user_id || seen.has(p.user_id)) return;
    if (!sanitizeLeadSource(p.lead_source)) return; // caseless GPs only count when they actually answered
    if (!withinPeriod(p.onboarding_completed_at || p.created_at, period, nowMs)) return;
    seen.add(p.user_id);
    tally(p.user_id);
  });

  var total = seen.size;
  function pct(n) { return total ? Math.round((n / total) * 1000) / 10 : 0; }
  var sources = LEAD_SOURCES.map(function(s) {
    return { key: s.key, label: s.label, count: counts[s.key], pct: pct(counts[s.key]) };
  });
  sources.push({ key: 'unknown', label: 'Not answered', count: unknown, pct: pct(unknown) });
  sources.sort(function(a, b) { return b.count - a.count; });

  return { total: total, sources: sources, details: details.slice(0, 50) };
}

module.exports = {
  OPEN_TASK_STATUSES, OVERDUE_EXCLUDED_STATUSES, FUNNEL_STAGES, DB_STAGE_ORDER, SIX_MONTHS_MS, DAY_MS,
  normalizeStatusKey, isSecuredStatus, isInterviewStatus, isOfferStatus,
  isSecuredApp, isOfferApp, isInterviewingApp,
  caseAgeMs, filterActiveCases, withinPeriod, isOverdue, activeUserIdSet,
  securedAppUserIds, computeKpis,
  computePipeline, pipelineCaseIds,
  computeBlockers,
  computeTaskHealth,
  computeRsoWorkload, pickLeastLoadedRso, rsoCaseIds, resolveRsoReassignmentTarget, opsTasksForRso, supportTicketsForRso, callsForRso, gpTasksByStage,
  gpNotesFromTimeline, mergeGpTimeline, gpDocumentSections, docTaskForKey, docActionsFor,
  computePlacements, placementAppIds,
  computeGpActivity, gpActivityCaseIds,
  computeTicketMetrics, ticketIds,
  computeCompletions,
  LEAD_SOURCES, sanitizeLeadSource,
  computeConversionFunnel, computeTimeToPlacement, computeSourceAttribution
};

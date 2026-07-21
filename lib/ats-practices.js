// Pure, dependency-free helpers for the ATS practices backfill + pipeline.
// No DB calls. Callers pass rows; logic is deterministic and testable.

// Kanban stages in pipeline order (excludes the terminal reject lane).
// 'shortlisted' (AI Matching) precedes 'applied' — a candidate can be matched
// to a job by the team/AI before they ever submit an application.
var ATS_STAGES = ['shortlisted', 'applied', 'submitted', 'reviewing', 'interview', 'offer', 'hired'];
var ATS_REJECT_STAGE = 'not_proceeding';

var ATS_STAGE_LABELS = {
  shortlisted: 'Shortlist',
  applied: 'Applied',
  submitted: 'Submitted to Practice',
  reviewing: 'Practice Reviewing',
  interview: 'Interview',
  offer: 'Offer',
  hired: 'Hired',
  not_proceeding: 'Not Proceeding'
};

// Rank used to compare how far a candidate has progressed.
var ATS_STAGE_RANK = {
  shortlisted: 0,
  applied: 1,
  submitted: 2,
  reviewing: 3,
  interview: 4,
  offer: 5,
  hired: 6
};

// Lowercase + trim a free-text status; null-safe.
function statusKey(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

// Canonical practice key: collapse whitespace, lowercase, strip trailing dots/commas.
function normalizePracticeName(name) {
  if (!name) return '';
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,]+$/, '');
}

// Dedupe practice names by canonical key, keeping the FIRST display spelling seen.
// Drops empties. Returns [{ key, display }] sorted by display (case-insensitive).
function dedupePracticeNames(names) {
  var list = Array.isArray(names) ? names : [];
  var byKey = {};
  list.forEach(function (raw) {
    var key = normalizePracticeName(raw);
    if (!key) return;
    if (!Object.prototype.hasOwnProperty.call(byKey, key)) {
      byKey[key] = { key: key, display: String(raw).trim() };
    }
  });
  return Object.keys(byKey)
    .map(function (k) { return byKey[k]; })
    .sort(function (a, b) {
      var da = a.display.toLowerCase();
      var db = b.display.toLowerCase();
      return da < db ? -1 : da > db ? 1 : 0;
    });
}

// Derive the kanban stage from a gp_applications row + whether an interview exists.
function deriveAtsStage(app, hasInterview) {
  var row = app || {};
  var status = statusKey(row.status);
  var sub = statusKey(row.practice_submission_status);

  // F13 (audit 2026-07-20): keep in lock-step with SECURED_STATUS_KEYS in
  // lib/ceo-metrics.js — 'secured' and 'placed' are secured there too.
  if (status === 'hired' || status === 'secured' || status === 'placed' || status === 'placement_secured' || status === 'offer_accepted' || status === 'contract_signed') {
    return 'hired';
  }
  if (status === 'rejected' || status === 'withdrawn') {
    return 'not_proceeding';
  }
  if (status === 'offer' || status === 'offered' || sub === 'client_approved') {
    return 'offer';
  }
  // Task 15: 'interview_completed' (Task 9's post-interview status, written
  // once the interview concludes and the practice-decision email fires)
  // stays in the 'interview' kanban lane — the pipeline doesn't advance
  // until the practice extends an offer or passes, so it must not fall
  // back to 'applied'.
  if (status === 'interview_scheduled' || status === 'interviewing' || status === 'interview_completed' || hasInterview === true || sub === 'interview_ready') {
    return 'interview';
  }
  if (sub === 'client_reviewed') {
    return 'reviewing';
  }
  if (status === 'submitted_to_practice' || sub === 'submitted_to_practice') {
    return 'submitted';
  }
  return 'applied';
}

// Decide whether an automatically derived stage may overwrite the stored
// kanban stage. Forward-only: a manually advanced card is never pulled
// backwards, and terminal lanes ('hired', 'not_proceeding') never move
// automatically. 'not_proceeding' may be applied from any non-terminal stage.
// Returns the stage to write, or null when nothing should change.
function planAtsStageReconciliation(storedStage, derivedStage) {
  var stored = statusKey(storedStage);
  var derived = statusKey(derivedStage);
  if (!derived || derived === stored) return null;
  // Terminal stored lanes never move automatically.
  if (stored === 'hired' || stored === ATS_REJECT_STAGE) return null;
  if (derived === ATS_REJECT_STAGE) return ATS_REJECT_STAGE;
  var storedRank = Object.prototype.hasOwnProperty.call(ATS_STAGE_RANK, stored) ? ATS_STAGE_RANK[stored] : -1;
  var derivedRank = Object.prototype.hasOwnProperty.call(ATS_STAGE_RANK, derived) ? ATS_STAGE_RANK[derived] : -1;
  if (derivedRank > storedRank) return derived;
  return null;
}

// Given a candidate's applications (each with .ats_stage), return the furthest
// non-'not_proceeding' stage, or null if there are none.
function bestAtsStage(apps) {
  var list = Array.isArray(apps) ? apps : [];
  var best = null;
  var bestRank = -1;
  list.forEach(function (app) {
    var stage = app && app.ats_stage;
    if (!stage || stage === ATS_REJECT_STAGE) return;
    if (!Object.prototype.hasOwnProperty.call(ATS_STAGE_RANK, stage)) return;
    var rank = ATS_STAGE_RANK[stage];
    if (rank > bestRank) {
      bestRank = rank;
      best = stage;
    }
  });
  return best;
}

// Pipeline buckets that PARTITION the candidate universe (every GP lands in
// exactly one). 'unassociated' = no applications at all; the rest mirror the
// kanban stages. There is deliberately NO terminal reject bucket here — owner
// rule: no GP should ever be shown sitting in a "Not proceeding" segment.
// A GP whose applications are all terminal (not_proceeding) reads as
// 'unassociated' instead (see bucketForApps below). The kanban board itself
// (ATS_STAGES / ATS_REJECT_STAGE / countAtsStages) is unaffected — that
// application-level "Not proceeding" lane still exists.
var PIPELINE_BUCKETS = ['unassociated', 'shortlisted', 'applied', 'submitted', 'reviewing', 'interview', 'offer', 'hired'];

var PIPELINE_BUCKET_LABELS = {
  unassociated: 'Unassociated',
  shortlisted: 'Shortlist',
  applied: 'Applied',
  submitted: 'Submitted',
  reviewing: 'Reviewing',
  interview: 'Interview',
  offer: 'Offer',
  hired: 'Hired'
};

// Classify a candidate into a single pipeline bucket from their applications.
// No apps -> 'unassociated'. Otherwise the furthest active stage; if every
// remaining app is 'not_proceeding' (terminal, no live application anywhere)
// -> 'unassociated' — a GP is never shown parked in a "Not proceeding"
// segment; they go back to the pool instead.
// Applications closed because the opening was filled by SOMEONE ELSE
// (match_outcome === 'position_filled') don't count at all: that candidate goes
// back to the pool ('unassociated') — or on under their other applications —
// rather than reading as "rejected". A genuine rejection has no such outcome,
// but now resolves to the SAME place (unassociated) since 'not_proceeding' is
// no longer a selectable pipeline bucket.
function bucketForApps(apps) {
  var list = (Array.isArray(apps) ? apps : []).filter(function (a) {
    return !(a && a.match_outcome === 'position_filled');
  });
  if (!list.length) return 'unassociated';
  var best = bestAtsStage(list);
  if (best) return best;
  return 'unassociated';
}

// True if ANY of a candidate's applications is a "new application" by the SAME
// definition the /api/ats/attention "New applications" tile counts: the app's
// stage resolves to 'applied' (empty/unknown treated as 'applied', matching the
// insert default) AND it was applied on/after `sinceIso`. This lets the
// candidate list reconcile with the tile's count: a GP whose furthest stage
// (bucketForApps) has already moved past 'applied' on another role — so the
// 'applied' pipeline bucket hides them — is still surfaced by their fresh apply.
function hasFreshApply(apps, sinceIso) {
  var list = Array.isArray(apps) ? apps : [];
  var since = String(sinceIso || '');
  for (var i = 0; i < list.length; i++) {
    var a = list[i] || {};
    var stage = a.ats_stage || 'applied';
    if (stage !== 'applied') continue;
    var when = a.applied_at || a.created_at || '';
    if (when && String(when) >= since) return true;
  }
  return false;
}

// Count application rows per ats_stage. Rows with an empty/unknown stage count
// as 'applied' (the insert default). Every stage key — including the terminal
// 'not_proceeding' lane — is always present (zeros included) so callers can
// render a complete funnel without null checks.
function countAtsStages(rows) {
  var counts = {};
  ATS_STAGES.forEach(function (s) { counts[s] = 0; });
  counts[ATS_REJECT_STAGE] = 0;
  (Array.isArray(rows) ? rows : []).forEach(function (row) {
    var key = statusKey(row && row.ats_stage);
    if (!Object.prototype.hasOwnProperty.call(counts, key)) key = 'applied';
    counts[key] += 1;
  });
  return counts;
}

module.exports = {
  normalizePracticeName,
  dedupePracticeNames,
  countAtsStages,
  deriveAtsStage,
  planAtsStageReconciliation,
  ATS_STAGES,
  ATS_REJECT_STAGE,
  ATS_STAGE_LABELS,
  bestAtsStage,
  PIPELINE_BUCKETS,
  PIPELINE_BUCKET_LABELS,
  bucketForApps,
  hasFreshApply
};

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

  if (status === 'hired' || status === 'placement_secured' || status === 'offer_accepted' || status === 'contract_signed') {
    return 'hired';
  }
  if (status === 'rejected' || status === 'withdrawn') {
    return 'not_proceeding';
  }
  if (status === 'offer' || status === 'offered' || sub === 'client_approved') {
    return 'offer';
  }
  if (status === 'interview_scheduled' || status === 'interviewing' || hasInterview === true || sub === 'interview_ready') {
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
// kanban stages plus the terminal reject lane.
var PIPELINE_BUCKETS = ['unassociated', 'shortlisted', 'applied', 'submitted', 'reviewing', 'interview', 'offer', 'hired', 'not_proceeding'];

var PIPELINE_BUCKET_LABELS = {
  unassociated: 'Unassociated',
  shortlisted: 'Shortlist',
  applied: 'Applied',
  submitted: 'Submitted',
  reviewing: 'Reviewing',
  interview: 'Interview',
  offer: 'Offer',
  hired: 'Hired',
  not_proceeding: 'Not proceeding'
};

// Classify a candidate into a single pipeline bucket from their applications.
// No apps -> 'unassociated'. Otherwise the furthest active stage; if every app
// is 'not_proceeding' -> 'not_proceeding'.
function bucketForApps(apps) {
  var list = Array.isArray(apps) ? apps : [];
  if (!list.length) return 'unassociated';
  var best = bestAtsStage(list);
  if (best) return best;
  return ATS_REJECT_STAGE;
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
  bucketForApps
};

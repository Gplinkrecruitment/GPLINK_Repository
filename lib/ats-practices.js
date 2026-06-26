// Pure, dependency-free helpers for the ATS practices backfill + pipeline.
// No DB calls. Callers pass rows; logic is deterministic and testable.

// Kanban stages in pipeline order (excludes the terminal reject lane).
var ATS_STAGES = ['applied', 'submitted', 'reviewing', 'interview', 'offer', 'hired'];
var ATS_REJECT_STAGE = 'not_proceeding';

var ATS_STAGE_LABELS = {
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
  applied: 0,
  submitted: 1,
  reviewing: 2,
  interview: 3,
  offer: 4,
  hired: 5
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

module.exports = {
  normalizePracticeName,
  dedupePracticeNames,
  deriveAtsStage,
  ATS_STAGES,
  ATS_REJECT_STAGE,
  ATS_STAGE_LABELS,
  bestAtsStage
};

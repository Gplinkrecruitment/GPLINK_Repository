'use strict';

// ── ATS intent (placement-likelihood) calculator ────────────────
// Pure port of the approved CEO-dashboard prototype intent score.
// Seven weighted signals, weights total 100. Pure + dependency-free +
// null/undefined-safe: computeIntent never throws and always clamps each
// signal value to 0..1 before weighting.

// Signal weights, in the same order as the signals returned by computeIntent.
var INTENT_WEIGHTS = [18, 18, 16, 14, 14, 10, 10];

// ── Small null-safe numeric helpers ─────────────────────────────
function num(value, fallback) {
  var n = Number(value);
  return isFinite(n) ? n : fallback;
}

function clamp01(value) {
  var n = Number(value);
  if (!isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// best ATS pipeline stage -> value (hired highest, applied lowest).
function atsStageVal(stage) {
  switch (String(stage || '').trim().toLowerCase()) {
    case 'hired': return 1;
    case 'offer': return 0.85;
    case 'interview': return 0.7;
    case 'reviewing': return 0.5;
    case 'submitted': return 0.4;
    case 'applied': return 0.3;
    default: return 0;
  }
}

// score -> band. Hot >= 70, Warm >= 40, else Cold.
function bandFor(score) {
  var s = num(score, 0);
  if (s >= 70) return 'Hot';
  if (s >= 40) return 'Warm';
  return 'Cold';
}

// ── Withdrawn-application penalty ───────────────────────────────
// A GP who keeps withdrawing their own job applications is a poorer
// placement bet, so their intent score is knocked down. The scale
// escalates on purpose: the first withdrawal is FREE (people change
// their minds once for good reasons, a family issue, a better offer),
// but a repeat pattern bites progressively harder and plateaus at 24
// points so it deprioritises without permanently zeroing anyone.
// This is scoring only, it is entirely separate from the career-lock
// / strike system and must never gate or lock an account.
var WITHDRAWAL_PENALTIES = [0, 0, 6, 14, 24];
var MAX_WITHDRAWAL_PENALTY = 24;

// withdrawalPenalty(count) -> 0..24 penalty points.
// Non-numeric, negative and NaN counts are treated as 0; counts of 4 or
// more all cap at the maximum penalty.
function withdrawalPenalty(count) {
  var n = Number(count);
  if (!isFinite(n) || n < 0) return 0;
  var idx = Math.floor(n);
  if (idx >= WITHDRAWAL_PENALTIES.length) return MAX_WITHDRAWAL_PENALTY;
  var penalty = WITHDRAWAL_PENALTIES[idx];
  if (!isFinite(penalty)) return 0;
  if (penalty < 0) return 0;
  if (penalty > MAX_WITHDRAWAL_PENALTY) return MAX_WITHDRAWAL_PENALTY;
  return penalty;
}

// Build the 7 zero-valued signals (fallback / shape guarantor).
function zeroSignals() {
  return [
    { label: 'Comms engagement & tone (AI)', w: 18, v: 0, points: 0 },
    { label: 'Onboarding completed', w: 18, v: 0, points: 0 },
    { label: 'Documents (CV, cover letter, ID, degree)', w: 16, v: 0, points: 0 },
    { label: 'Registration progress', w: 14, v: 0, points: 0 },
    { label: 'Call attendance', w: 14, v: 0, points: 0 },
    { label: 'Recent app activity', w: 10, v: 0, points: 0 },
    { label: 'Job pipeline engagement', w: 10, v: 0, points: 0 }
  ];
}

// computeIntent(input) -> { score, band, signals: [{ label, w, v, points }] }
// input fields are all optional and individually guarded; missing/garbage
// values fall back to neutral/zero so this never throws.
// input.withdrawnCount (optional, default 0) subtracts an escalating
// penalty from the final score, see withdrawalPenalty above. The penalty
// is applied to the score, never as a signal value, because clamp01 would
// swallow a negative v.
function computeIntent(input) {
  try {
    var src = input || {};

    // Comms engagement & tone (AI): provided 0..1 value, else 0.
    var commsVal = num(src.commsEngagementVal, 0);

    // Onboarding completed: full credit if completed, else fraction of fields filled.
    var onboardingVal = src.onboardingCompleted ? 1 : num(src.onboardingFieldsFilled, 0);

    // Documents: share of {cv, coverLetter, idDoc, primaryDegree} present.
    var docs = src.docs || {};
    var docKeys = ['cv', 'coverLetter', 'idDoc', 'primaryDegree'];
    var present = 0;
    for (var i = 0; i < docKeys.length; i++) {
      if (docs[docKeys[i]]) present++;
    }
    var docShare = present / docKeys.length;

    // Registration progress: stageIdx / stageMax, reduced while blocked.
    var stageMax = Math.max(1, num(src.regStageMax, 1));
    var stageIdx = Math.max(0, num(src.regStageIndex, 0));
    var stageVal = stageIdx / stageMax;
    var blockedDays = Math.max(0, num(src.blockedDays, 0));
    if (blockedDays > 0) {
      stageVal = Math.max(0, stageVal - Math.min(0.4, (blockedDays / 30) * 0.4));
    }

    // Call attendance: completed / (completed + missed); neutral 0.5 if none.
    var done = Math.max(0, num(src.callsCompleted, 0));
    var missed = Math.max(0, num(src.callsMissed, 0));
    var callTotal = done + missed;
    var callVal = callTotal ? done / callTotal : 0.5;

    // Recent app activity: step-down by days since last active.
    var lastActiveDays = num(src.lastActiveDays, Infinity);
    var recencyVal = lastActiveDays <= 7 ? 1
      : lastActiveDays <= 14 ? 0.6
      : lastActiveDays <= 30 ? 0.3
      : 0.1;

    // Job pipeline engagement: best ATS stage value.
    var atsVal = atsStageVal(src.bestAtsStage);

    var raw = [
      { label: 'Comms engagement & tone (AI)', w: 18, v: commsVal },
      { label: 'Onboarding completed', w: 18, v: onboardingVal },
      { label: 'Documents (CV, cover letter, ID, degree)', w: 16, v: docShare },
      { label: 'Registration progress', w: 14, v: stageVal },
      { label: 'Call attendance', w: 14, v: callVal },
      { label: 'Recent app activity', w: 10, v: recencyVal },
      { label: 'Job pipeline engagement', w: 10, v: atsVal }
    ];

    var total = 0;
    var signals = raw.map(function (s) {
      var v = clamp01(s.v);
      var product = s.w * v;
      total += product;
      return { label: s.label, w: s.w, v: v, points: Math.round(product) };
    });

    // Escalating penalty for repeatedly withdrawing own applications.
    // Only surfaced as an extra (zero-weight) signal row when it actually
    // bites, so callers that never withdraw see the same 7 rows as before.
    var withdrawnCount = Math.max(0, Math.floor(num(src.withdrawnCount, 0)));
    var penalty = withdrawalPenalty(withdrawnCount);
    if (penalty > 0) {
      signals.push({
        label: 'Withdrawn applications',
        w: 0,
        v: 0,
        points: -penalty,
        penalty: true,
        count: withdrawnCount
      });
    }

    var score = Math.max(0, Math.min(100, Math.round(total) - penalty));
    return { score: score, band: bandFor(score), signals: signals };
  } catch (err) {
    // Never throw, return a deterministic Cold zero result.
    return { score: 0, band: 'Cold', signals: zeroSignals() };
  }
}

module.exports = { computeIntent, INTENT_WEIGHTS, bandFor, withdrawalPenalty };

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

    var score = Math.round(total);
    return { score: score, band: bandFor(score), signals: signals };
  } catch (err) {
    // Never throw — return a deterministic Cold zero result.
    return { score: 0, band: 'Cold', signals: zeroSignals() };
  }
}

module.exports = { computeIntent, INTENT_WEIGHTS, bandFor };

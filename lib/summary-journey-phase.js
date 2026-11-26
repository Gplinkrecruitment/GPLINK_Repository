'use strict';

// Where a GP REALLY is, for the AI handover summary.
//
// The journey is: onboarding wizard → find a position (My Practice) → position SECURED →
// registration (MyIntealth → AMC → AHPRA → visa → PBS). That is the rule the doctor app
// itself runs on (js/gp-doctor-phase.js: onboarding / position / registration) — until a
// placement is secured the doctor cannot even SEE the MyIntealth page.
//
// The summary used to be fed `registration_cases.stage` raw. Every GP gets that row with
// stage 'myintealth' the moment they sign up, so an onboarded doctor who was simply browsing
// positions was reported as "stuck at the very first onboarding step — myintealth account
// creation", and because the previous summary is fed back in, the claim then "persisted
// across multiple handover cycles" (owner screenshot, Dr Innocent Aghadinuno, 2026-11-26).
//
// Pure — no I/O — so it is unit-testable; server.js loads the records and passes them in.

function parseVal(v) {
  if (!v) return {};
  if (typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') { try { var p = JSON.parse(v); return (p && typeof p === 'object') ? p : {}; } catch (e) { return {}; } }
  return {};
}

function flag(v) {
  if (typeof v === 'string') { var s = v.trim().toLowerCase(); return s === 'true'; }
  return v === true;
}

// Mirror of js/app-shell.js hasCareerSecured() — the check the doctor's own app uses.
function careerStateSecured(career) {
  var c = parseVal(career);
  if (c.career_secured === true || c.secured === true) return true;
  var apps = Array.isArray(c.applications) ? c.applications : [];
  for (var i = 0; i < apps.length; i++) {
    var a = apps[i];
    if (!a || typeof a !== 'object') continue;
    if (a.isPlacementSecured === true) return true;
    var st = String(a.rawStatus || a.status || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (st === 'secured' || st === 'placement_secured' || st === 'practice_secured') return true;
  }
  return false;
}

var STAGE_LABELS = {
  myintealth: 'MyIntealth', amc: 'AMC', career: 'Career', ahpra: 'AHPRA',
  visa: 'Visa', pbs: 'PBS & Medicare', commencement: 'Commencement'
};

/**
 * @param {object} input
 *   onboardingCompletedAt  user_profiles.onboarding_completed_at
 *   state                  user_state.state blob (gp_onboarding, gp_onboarding_complete, gp_career_state, gp_epic_progress)
 *   hasPlacedApplication   true when the OWNED gp_applications rows show a secured placement
 *   storedStage            registration_cases.stage
 *   storedSubstage         registration_cases.substage
 * @returns {{phase:'onboarding'|'position'|'registration', stage:string, substage:string, promptLine:string, rule:string}}
 */
function summaryJourneyPhase(input) {
  var i = input || {};
  var st = parseVal(i.state);
  var ob = parseVal(st.gp_onboarding);
  var onboarded = !!(i.onboardingCompletedAt || ob.completedAt || flag(st.gp_onboarding_complete));
  var secured = i.hasPlacedApplication === true || careerStateSecured(st.gp_career_state);

  if (!onboarded) {
    return {
      phase: 'onboarding',
      stage: 'onboarding',
      substage: '',
      promptLine: 'JOURNEY PHASE: ONBOARDING — the GP has not finished the GP Link onboarding wizard yet. Registration (MyIntealth etc.) has not begun.',
      rule: 'onboarding'
    };
  }

  if (!secured) {
    // Earlier registration work on record (older accounts did MyIntealth before the
    // position-first flow) is worth mentioning, but it does not change the phase.
    var epic = parseVal(st.gp_epic_progress);
    var ec = parseVal(epic.completed);
    var epicStarted = Object.keys(ec).some(function (k) { return ec[k] === true; });
    var line = 'JOURNEY PHASE: FINDING A POSITION — onboarding is COMPLETE and the GP is now looking for a practice (My Practice / careers). No position has been secured yet. Registration (MyIntealth → AMC → AHPRA) only begins AFTER a position is secured, so it has NOT started and is NOT overdue.';
    if (epicStarted) line += ' (Some MyIntealth progress is on record from before the position-first flow; treat it as background only.)';
    return { phase: 'position', stage: 'position', substage: '', promptLine: line, rule: 'position' };
  }

  var stage = String(i.storedStage || 'myintealth');
  var label = STAGE_LABELS[stage] || stage;
  return {
    phase: 'registration',
    stage: stage,
    substage: String(i.storedSubstage || ''),
    promptLine: 'JOURNEY PHASE: REGISTRATION — a position is SECURED; the GP is on the ' + label + ' registration step' + (i.storedSubstage ? ' (' + i.storedSubstage + ')' : '') + '.',
    rule: 'registration'
  };
}

// System-prompt rule. Kept here so the test pins the exact wording the model sees.
var JOURNEY_PHASE_RULE =
  '- The JOURNEY PHASE line is AUTHORITATIVE for where the GP is and OUTRANKS the raw STAGE field, older timeline events and any previous summary. The journey order is: onboarding wizard → finding a position → position secured → registration (MyIntealth, AMC, AHPRA, visa, PBS). ' +
  'When the phase is FINDING A POSITION or ONBOARDING, NEVER say the GP is stuck, stalled, blocked or behind at MyIntealth or any other registration step, and never list MyIntealth/AMC/AHPRA steps as overdue action items or outstanding requirements — registration has not started yet by design. ' +
  'For FINDING A POSITION, frame progress around securing a placement: matching details (preferred location, family, visa/regional eligibility), applications, interviews and engagement. If a previous summary said otherwise, it was wrong — correct it, do not repeat it.';

module.exports = { summaryJourneyPhase, careerStateSecured, JOURNEY_PHASE_RULE };

'use strict';

/**
 * Journey ladders (Australian GP build, WP-03). Pure: no I/O, no switch.
 *
 * A registration case sits on exactly one ladder, chosen by the doctor's
 * pathway (lib/candidate-pathway.js):
 *
 *   overseas (overseas_esp, overseas_pep, and anything unknown / not recorded)
 *     myintealth -> amc -> career -> ahpra -> visa -> pbs -> commencement -> complete
 *     Exactly today's ladder. It is DERIVED from the doctor's app state
 *     (EPIC / AMC / placement / AHPRA flags) by server.js _deriveStageFromState.
 *
 *   au (au_vr, au_restricted, au_non_vr, au_registrar)
 *     placement -> prestart -> commenced -> guarantee -> complete
 *     NEVER derived from EPIC / AMC / AHPRA / visa flags. It moves on facts:
 *       placement  no placement recorded yet (where every AU case starts)
 *       prestart   a placement is recorded; pre-start checks are under way
 *       commenced  staff confirmed the doctor started work (WP-13)
 *       guarantee  the placement-guarantee period is running (WP-13)
 *       complete   the guarantee period ended; the case is finished (WP-13)
 *     Moves are forward-only and go through server.js advanceAuCaseStage.
 *
 * Callers decide the pathway with resolveCandidatePathway (which already
 * honours the AU_PATHWAY_ENABLED switch) and pass it in. An unknown pathway is
 * the overseas ladder, never the Australian one.
 *
 * Segment B (au_restricted) and C use the Australian ladder too. The placement
 * matrix allows B "prestart or ahpra" when a registration change is needed:
 * that branch belongs to WP-14 and hangs off auPlacementTargetStage below.
 */

const candidatePathway = require('./candidate-pathway.js');

const LADDER = Object.freeze({ OVERSEAS: 'overseas', AU: 'au' });

// label   = what staff see.
// gpLabel = what the doctor may be shown. Australian gpLabels never contain a
//           word from AGENT-RULES section 4, and never "guarantee" (that is a
//           commercial term between GP Link and the practice).
const OVERSEAS_LADDER = Object.freeze([
  Object.freeze({ key: 'myintealth', label: 'MyIntealth', gpLabel: 'MyIntealth' }),
  Object.freeze({ key: 'amc', label: 'AMC', gpLabel: 'AMC' }),
  Object.freeze({ key: 'career', label: 'Secure Placement', gpLabel: 'Secure Placement' }),
  Object.freeze({ key: 'ahpra', label: 'AHPRA', gpLabel: 'AHPRA' }),
  Object.freeze({ key: 'visa', label: 'Visa', gpLabel: 'Visa' }),
  Object.freeze({ key: 'pbs', label: 'PBS & Medicare', gpLabel: 'PBS & Medicare' }),
  Object.freeze({ key: 'commencement', label: 'Commencement', gpLabel: 'Commencement' }),
  Object.freeze({ key: 'complete', label: 'Complete', gpLabel: 'Complete' })
]);

const AU_LADDER = Object.freeze([
  Object.freeze({ key: 'placement', label: 'Placement', gpLabel: 'Secure placement' }),
  Object.freeze({ key: 'prestart', label: 'Pre-start', gpLabel: 'Pre-start checks' }),
  Object.freeze({ key: 'commenced', label: 'Commenced', gpLabel: 'Started' }),
  Object.freeze({ key: 'guarantee', label: 'Guarantee period', gpLabel: 'Settling in' }),
  Object.freeze({ key: 'complete', label: 'Complete', gpLabel: 'Complete' })
]);

const OVERSEAS_STAGES = Object.freeze(OVERSEAS_LADDER.map(function (s) { return s.key; }));
const AU_STAGES = Object.freeze(AU_LADDER.map(function (s) { return s.key; }));

// Stage values that exist ONLY on the Australian ladder ('complete' is shared).
const AU_ONLY_STAGES = Object.freeze(AU_STAGES.filter(function (k) { return OVERSEAS_STAGES.indexOf(k) === -1; }));

// Every value registration_cases.stage may hold once the WP-03 migration is
// applied: the eight live values plus the four Australian ones.
const ALL_CASE_STAGES = Object.freeze(OVERSEAS_STAGES.concat(AU_ONLY_STAGES));

// scheduled_calls.stage (an assistance call "about" a stage).
//   Overseas: exactly today's three.
//   Australian: the server accepts only 'prestart' today (the one Australian
//   stage where staff walk a doctor through something). The DATABASE constraint
//   is widened to all four Australian stages so WP-13's commencement / guarantee
//   check-in calls need no second production migration; opening one of them is
//   a one-line change to AU_CALL_STAGES.
const OVERSEAS_CALL_STAGES = Object.freeze(['myintealth', 'amc', 'ahpra']);
const AU_CALL_STAGES = Object.freeze(['prestart']);
const ALL_CALL_STAGES_DB = Object.freeze(OVERSEAS_CALL_STAGES.concat(AU_ONLY_STAGES));

function norm(stage) {
  return String(stage == null ? '' : stage).trim().toLowerCase();
}

/** 'au' only for one of the four Australian pathways; everything else is 'overseas'. */
function ladderIdFor(pathway) {
  return candidatePathway.isAuPathway(pathway) ? LADDER.AU : LADDER.OVERSEAS;
}

/** The ladder rows for a pathway: [{ key, label, gpLabel, index }]. */
function ladderFor(pathway) {
  const rows = ladderIdFor(pathway) === LADDER.AU ? AU_LADDER : OVERSEAS_LADDER;
  return rows.map(function (s, i) { return { key: s.key, label: s.label, gpLabel: s.gpLabel, index: i }; });
}

/** The ordered stage keys for a pathway. */
function stagesFor(pathway) {
  return ladderIdFor(pathway) === LADDER.AU ? AU_STAGES : OVERSEAS_STAGES;
}

/** Order index of a stage on a pathway's ladder; -1 when it is not on it. */
function stageIndex(pathway, stage) {
  return stagesFor(pathway).indexOf(norm(stage));
}

function isStageOnLadder(pathway, stage) {
  return stageIndex(pathway, stage) !== -1;
}

/** Where a brand-new case starts: 'myintealth' overseas, 'placement' for every Australian pathway. */
function initialStageFor(pathway) {
  return stagesFor(pathway)[0];
}

function isAuOnlyStage(stage) {
  return AU_ONLY_STAGES.indexOf(norm(stage)) !== -1;
}

function isKnownStage(stage) {
  return ALL_CASE_STAGES.indexOf(norm(stage)) !== -1;
}

/**
 * Compare two stages on one pathway's ladder.
 * @returns {number|null} negative when a is before b, 0 when equal, positive
 *   when after; null when either stage is not on that ladder (not comparable).
 */
function compareStages(pathway, a, b) {
  const ia = stageIndex(pathway, a);
  const ib = stageIndex(pathway, b);
  if (ia === -1 || ib === -1) return null;
  return ia - ib;
}

/**
 * Is from -> to a forward move on this pathway's ladder? A `from` that is not
 * on the ladder (a case still parked on the other ladder) counts as "before the
 * start", so any stage on the ladder is forward of it.
 */
function isForwardMove(pathway, from, to) {
  const it = stageIndex(pathway, to);
  if (it === -1) return false;
  return it > stageIndex(pathway, from);
}

/** The stage after this one on the ladder, or null at the end / when unknown. */
function nextStage(pathway, stage) {
  const list = stagesFor(pathway);
  const i = list.indexOf(norm(stage));
  return i === -1 || i >= list.length - 1 ? null : list[i + 1];
}

function findRow(stage, pathway) {
  const key = norm(stage);
  const preferAu = pathway !== undefined && ladderIdFor(pathway) === LADDER.AU;
  const first = preferAu ? AU_LADDER : OVERSEAS_LADDER;
  const second = preferAu ? OVERSEAS_LADDER : AU_LADDER;
  for (let i = 0; i < first.length; i++) if (first[i].key === key) return first[i];
  for (let j = 0; j < second.length; j++) if (second[j].key === key) return second[j];
  return null;
}

/**
 * A staff-facing label for ANY stage value, on either ladder. Never throws:
 * an unknown value comes back as itself, an empty one as the fallback.
 */
function stageLabel(stage, pathway, fallback) {
  const row = findRow(stage, pathway);
  if (row) return row.label;
  const raw = String(stage == null ? '' : stage).trim();
  return raw || (fallback === undefined ? '' : fallback);
}

/** The doctor-facing label. Same safety as stageLabel. */
function gpStageLabel(stage, pathway, fallback) {
  const row = findRow(stage, pathway);
  if (row) return row.gpLabel;
  const raw = String(stage == null ? '' : stage).trim();
  return raw || (fallback === undefined ? '' : fallback);
}

/**
 * One sort key for a mixed list of cases from both ladders: overseas stages in
 * their order, then the Australian-only stages in theirs, then anything
 * unknown last. 'complete' sorts after every in-flight stage.
 */
function sortIndexAny(stage) {
  const key = norm(stage);
  if (key === 'complete') return 900;
  const io = OVERSEAS_STAGES.indexOf(key);
  if (io !== -1) return io;
  const ia = AU_STAGES.indexOf(key);
  if (ia !== -1) return 100 + ia;
  return 999;
}

/**
 * The Australian stage, from facts. Pure. Never looks at EPIC / AMC / AHPRA /
 * visa flags, and never moves a case backwards:
 *   - already past 'placement' on the Australian ladder -> stays where it is
 *   - a placement is recorded                         -> 'prestart'
 *   - otherwise                                       -> 'placement'
 * 'commenced', 'guarantee' and 'complete' are only ever reached through
 * advanceAuCaseStage (WP-13's commencement action), never derived here.
 *
 * @param {{ currentStage?: string, placementSecured?: boolean, pathway?: string }} facts
 */
function auStageFromFacts(facts) {
  const f = facts || {};
  const current = norm(f.currentStage);
  const idx = AU_STAGES.indexOf(current);
  if (idx > 0) return current;
  return f.placementSecured === true ? auPlacementTargetStage(f.pathway) : 'placement';
}

/**
 * The stage an Australian case moves to when a placement is recorded.
 * HOOK FOR WP-14: the placement matrix allows segment B (au_restricted)
 * "prestart or ahpra" when the placement needs a registration or visa change.
 * Today every Australian pathway goes to 'prestart'. WP-14 adds its branch
 * here (it receives the pathway; pass more context as a second argument).
 */
function auPlacementTargetStage(pathway) { // eslint-disable-line no-unused-vars
  return 'prestart';
}

// How far along an Australian stage is, expressed on the overseas 0..6 scale
// that lib/ceo-metrics.js DB_STAGE_ORDER and the ATS intent "registration
// progress" signal use. An Australian GP with no placement is job-ready, which
// is what 'career' (2) means for an overseas doctor. WP-27 may retune this.
const AU_STAGE_OVERSEAS_EQUIV_INDEX = Object.freeze({ placement: 2, prestart: 3, commenced: 5, guarantee: 5 });

/** The stages an assistance call may be about, for a pathway. */
function callStagesFor(pathway) {
  return ladderIdFor(pathway) === LADDER.AU ? AU_CALL_STAGES : OVERSEAS_CALL_STAGES;
}

module.exports = {
  LADDER,
  OVERSEAS_LADDER,
  AU_LADDER,
  OVERSEAS_STAGES,
  AU_STAGES,
  AU_ONLY_STAGES,
  ALL_CASE_STAGES,
  OVERSEAS_CALL_STAGES,
  AU_CALL_STAGES,
  ALL_CALL_STAGES_DB,
  AU_STAGE_OVERSEAS_EQUIV_INDEX,
  ladderIdFor,
  ladderFor,
  stagesFor,
  stageIndex,
  isStageOnLadder,
  initialStageFor,
  isAuOnlyStage,
  isKnownStage,
  compareStages,
  isForwardMove,
  nextStage,
  stageLabel,
  gpStageLabel,
  sortIndexAny,
  auStageFromFacts,
  auPlacementTargetStage,
  callStagesFor
};

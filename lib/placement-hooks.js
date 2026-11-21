'use strict';
/**
 * WP-11 (Australian GP build): THE one place that decides what a placement
 * sets in motion. Pure, no I/O, no switch read.
 *
 * It is the "Placement-hook matrix" of docs/au-gp/review-report.md, row by
 * row, as a function. Every place a placement is (or may be) recorded asks
 * `placementHooksFor(pathwayResult, credentials)` and does only what it says:
 * the "Career secured" block of processRegistrationTaskAutomation,
 * finalizeInAppPlacement, the Australian placement runner, and every staff
 * action that would send an overseas-style request to a practice.
 *
 * `pathwayResult` is what resolveCandidatePathway returned (it already honours
 * the switch: with the switch off every doctor is an overseas doctor, so every
 * hook reads exactly as it did before this file existed).
 *
 * Columns:
 *   overseas   nothing recorded, overseas_esp, overseas_pep, switch off,
 *              migration not applied. Today's cascade, unchanged.
 *   A          au_vr                       launched
 *   B          au_restricted               built, not launched
 *   C          au_non_vr, au_registrar     built, not launched
 *   hold       the pathway could not be read. The pathway-dependent hooks are
 *              held (never fired at a doctor who may be Australian, never
 *              skipped for a doctor who may be overseas); the neutral hooks
 *              still fire and staff are asked to confirm the pathway.
 *
 * Every row answers with one of:
 *   'fire'     do today's thing
 *   'skip'     do nothing
 *   'variant'  do the Australian version (named beside the row)
 *   'review'   not known (segment B or C): do nothing, raise a staff decision
 *   'hold'     pathway unreadable: do nothing yet
 *
 * Regulatory detail (what a moratorium doctor's new practice must lodge, when
 * supervision paperwork is needed) is NOT confirmed. Correct it here and
 * nowhere else.
 */

const candidatePathway = require('./candidate-pathway.js');
const gpCredentialsLib = require('./gp-credentials.js');
const journeyLadders = require('./journey-ladders.js');

const COLUMN = Object.freeze({ OVERSEAS: 'overseas', A: 'A', B: 'B', C: 'C', HOLD: 'hold' });
const ACTION = Object.freeze({ FIRE: 'fire', SKIP: 'skip', VARIANT: 'variant', REVIEW: 'review', HOLD: 'hold' });

// The overseas practice pack, in the order the cascade has always created it.
const PRACTICE_PACK_KEYS = Object.freeze(['sppa_00', 'section_g', 'position_description', 'offer_contract', 'supervisor_cv']);

const HOLD_REASON = Object.freeze({
  PATHWAY_UNREADABLE: 'pathway_unreadable',
  NO_PATHWAY_RESULT: 'no_pathway_result'
});

const REVIEW_REASON = Object.freeze({
  SUPERVISION_UNKNOWN: 'supervision_unknown',
  VISA_CHANGE_UNKNOWN: 'visa_change_unknown',
  SEGMENT_C_PRACTICE_PAPERWORK: 'segment_c_practice_paperwork'
});

const REVIEW_REASON_TEXT = Object.freeze({
  supervision_unknown: 'no Ahpra registration type is on file, so it is not known whether this doctor\'s registration is supervised',
  visa_change_unknown: 'it is not recorded whether this doctor\'s right to work is tied to a sponsoring employer',
  segment_c_practice_paperwork: 'a doctor who is not vocationally registered may need a position description or a program approval from the practice; this has not been confirmed'
});

const GENERAL_REGISTRATION_TYPES = ['general', 'specialist', 'general_and_specialist'];

/**
 * What is known about supervision and a visa change for a segment B doctor,
 * from the gp_credentials row. `true` / `false` are facts on file; `null`
 * means "not known" and must never be read as either.
 * @returns {{ supervised: boolean|null, visaChange: boolean|null }}
 */
function supervisionFacts(credentials) {
  const c = credentials && typeof credentials === 'object' ? credentials : null;
  if (!c) return { supervised: null, visaChange: null };
  const type = String(c.ahpra_registration_type || '').trim().toLowerCase();
  const level = String(c.supervision_level || '').trim().toLowerCase();
  let supervised = null;
  if (gpCredentialsLib.isSupervisedRegistrationType(type) || (level && level !== 'none')) supervised = true;
  else if (GENERAL_REGISTRATION_TYPES.indexOf(type) !== -1) supervised = false;
  const rights = String(c.work_rights || '').trim().toLowerCase();
  let visaChange = null;
  if (rights === 'citizen' || rights === 'pr') visaChange = false;
  else if (rights === 'visa') {
    if (c.visa_sponsor_tied === true) visaChange = true;
    else if (c.visa_sponsor_tied === false) visaChange = false;
  }
  return { supervised, visaChange };
}

function columnFor(pathwayResult) {
  const p = pathwayResult && typeof pathwayResult === 'object' ? pathwayResult : null;
  if (!p) return { column: COLUMN.HOLD, holdReason: HOLD_REASON.NO_PATHWAY_RESULT };
  // Switch off, or the migration is not applied here: nobody is Australian.
  if (p.flagEnabled === false || p.schemaMissing === true) return { column: COLUMN.OVERSEAS, holdReason: null };
  if (p.readFailed === true) return { column: COLUMN.HOLD, holdReason: HOLD_REASON.PATHWAY_UNREADABLE };
  if (!p.isAu || !candidatePathway.isAuPathway(p.pathway)) return { column: COLUMN.OVERSEAS, holdReason: null };
  const segment = candidatePathway.segmentOf(p.pathway);
  if (segment === 'A') return { column: COLUMN.A, holdReason: null };
  if (segment === 'B') return { column: COLUMN.B, holdReason: null };
  if (segment === 'C') return { column: COLUMN.C, holdReason: null };
  // An Australian pathway this file does not know: never guess a branch.
  return { column: COLUMN.HOLD, holdReason: HOLD_REASON.PATHWAY_UNREADABLE };
}

/**
 * The decision.
 *
 * @param {object|null} pathwayResult  from resolveCandidatePathway
 * @param {object|null} [credentials]  the doctor's gp_credentials row (read
 *        only for segment B; pass null when there is none)
 * @returns {object} one named answer per row of the matrix (see below)
 */
function placementHooksFor(pathwayResult, credentials) {
  const where = columnFor(pathwayResult);
  const column = where.column;
  const p = pathwayResult && typeof pathwayResult === 'object' ? pathwayResult : {};
  const overseas = column === COLUMN.OVERSEAS;
  const hold = column === COLUMN.HOLD;
  const au = column === COLUMN.A || column === COLUMN.B || column === COLUMN.C;
  const F = ACTION.FIRE, S = ACTION.SKIP, V = ACTION.VARIANT, R = ACTION.REVIEW, H = ACTION.HOLD;

  // One answer for "today's thing for overseas, something else for the rest".
  const pick = function (a, b, c) {
    if (overseas) return F;
    if (hold) return H;
    if (column === COLUMN.A) return a;
    if (column === COLUMN.B) return b;
    return c;
  };

  const facts = column === COLUMN.B ? supervisionFacts(credentials) : { supervised: null, visaChange: null };
  const reviewReasons = [];

  // Supervisor CV and SPPA-00: B only when registration is limited,
  // provisional or supervised. Not known -> a person decides.
  let supervision = S;
  if (column === COLUMN.B) {
    if (facts.supervised === true) supervision = F;
    else if (facts.supervised === false) supervision = S;
    else { supervision = R; reviewReasons.push(REVIEW_REASON.SUPERVISION_UNKNOWN); }
  }

  // Position description: B only if an Ahpra or visa change needs it.
  let positionDescription = S;
  if (column === COLUMN.B) {
    if (facts.supervised === true || facts.visaChange === true) positionDescription = F;
    else if (facts.supervised === false && facts.visaChange === false) positionDescription = S;
    else {
      positionDescription = R;
      if (facts.supervised === null && reviewReasons.indexOf(REVIEW_REASON.SUPERVISION_UNKNOWN) === -1) reviewReasons.push(REVIEW_REASON.SUPERVISION_UNKNOWN);
      if (facts.visaChange === null) reviewReasons.push(REVIEW_REASON.VISA_CHANGE_UNKNOWN);
    }
  } else if (column === COLUMN.C) {
    // The matrix says "variant" and nobody has confirmed what the variant is:
    // no overseas-style request goes out; a person decides.
    positionDescription = R;
    reviewReasons.push(REVIEW_REASON.SEGMENT_C_PRACTICE_PAPERWORK);
  }

  const hooks = {
    column,
    pathway: au ? p.pathway : (overseas ? (p.pathway || candidatePathway.DEFAULT_PATHWAY) : null),
    segment: au ? column : (overseas ? 'overseas' : null),
    isAu: au,
    hold,
    holdReason: where.holdReason,

    // ── Offer accepted, hired, placement row, job filled: fire for all ──
    offerAccepted: F,
    hired: F,
    placementRow: F,
    jobFilled: F,

    // ── Practice "Placement confirmed" email ──
    // variant = N12 (start date, provider number for your location,
    // credentialing, the guarantee period).
    practiceConfirmedEmail: pick(V, V, V),

    // ── Contract task: fire for all ──
    contractTask: F,

    // ── Position description task ──
    positionDescriptionTask: overseas ? F : (hold ? H : positionDescription),

    // ── Supervisor CV and SPPA-00 tasks ──
    supervisorCvTask: overseas ? F : (hold ? H : supervision),
    sppa00Task: overseas ? F : (hold ? H : supervision),

    // ── Section G task and auto-delivered PDF: B only with SPPA-00 ──
    sectionGTask: overseas ? F : (hold ? H : supervision),
    sectionGDelivery: overseas ? F : (hold ? H : supervision),

    // ── Practice-pack email to the GP, and the "placement secured" message ──
    // A: no pack email; the pre-start checklist (N11) instead. B, C: the same
    // checklist with one neutral extra line (variant).
    practicePackEmail: pick(S, S, S),
    gpPlacementMessage: pick(V, V, V),
    gpPrestartChecklist: au ? F : (hold ? H : S),

    // ── Drive folder and document copy: fire for all ──
    // An Australian doctor's documents are mirrored team-only (WP-07): the
    // cascade's link-public copy is never made for them.
    driveFolder: F,
    driveDocumentCopy: overseas ? F : (hold ? H : V),

    // ── "AHPRA stage" WhatsApp and AHPRA-unlocked email ──
    ahpraStageWhatsApp: pick(S, S, S),
    ahpraUnlockedEmail: pick(S, S, S),

    // ── Case stage ──
    // B's "or ahpra" branch is WP-14's, inside auPlacementTargetStage.
    caseStage: overseas ? 'ahpra' : (hold ? null : journeyLadders.auPlacementTargetStage(p.pathway)),

    // ── AHPRA-granted handler and visa case ──
    ahpraGrantedHandler: pick(S, S, S),
    visaCase: pick(S, S, S),
    // WP-14: segment B's "skip unless visa transfer". Exposed, not acted on.
    visaTransferMayApply: column === COLUMN.B ? facts.visaChange : false,

    // ── Medicare / PBS module (WP-12 builds it) ──
    medicarePbsModule: pick(V, V, V),
    medicarePbsVariant: overseas ? 'overseas' : (hold ? null
      : (column === COLUMN.A ? 'provider_number_new_location'
        : (column === COLUMN.B ? 'provider_number_plus_19ab_check' : 'provider_number_plus_program_approval'))),

    // ── Commencement checklist (WP-13 builds it) ──
    commencementChecklist: pick(V, F, F),
    commencementVariant: overseas ? 'overseas' : (hold ? null : (column === COLUMN.A ? 'no_travel_items' : 'australian')),

    // ── Invoice prompt (WP-13 builds it): none exists for overseas ──
    invoicePrompt: overseas ? S : (hold ? H : V),
    invoiceVariant: au ? 'on_commencement' : null,

    // ── The Australian pre-start work (tasks 6 to 9, RSO) ──
    prestartTasks: au ? F : (hold ? H : S),
    assignRsoForPrestart: au ? F : (hold ? H : S),

    // What is known for segment B (null = not known).
    supervised: column === COLUMN.B ? facts.supervised : (au ? false : null),

    // A person must decide something before the paperwork can be right.
    staffReview: reviewReasons.length ? { reasons: reviewReasons.slice() } : null
  };

  // The practice-pack tasks to create now, in the cascade's order.
  hooks.practicePackKeys = PRACTICE_PACK_KEYS.filter(function (key) {
    if (key === 'offer_contract') return hooks.contractTask === F;
    if (key === 'position_description') return hooks.positionDescriptionTask === F;
    if (key === 'supervisor_cv') return hooks.supervisorCvTask === F;
    if (key === 'sppa_00') return hooks.sppa00Task === F;
    if (key === 'section_g') return hooks.sectionGTask === F;
    return false;
  });
  // Is today's overseas cascade the whole answer? (Every pathway-dependent
  // row reads 'fire'.) True only for the overseas column.
  hooks.overseasCascade = overseas;
  return Object.freeze(hooks);
}

// ── Staff actions that send an overseas-style request ────────────────────────
// D8: the buttons behind these are refused server-side for a case whose hooks
// say skip. One table, so the rule and the matrix cannot drift.
const OVERSEAS_ACTION = Object.freeze({
  SUPERVISOR_CV: 'supervisor_cv',
  ALT_SUPERVISOR_CV: 'alt_supervisor_cv',
  SPPA: 'sppa',
  SECTION_G: 'section_g',
  POSITION_DESCRIPTION: 'position_description',
  OFFER_CONTRACT: 'offer_contract',
  AHPRA_LETTER: 'ahpra_letter',
  AHPRA_CONFLICT_LETTER: 'ahpra_conflict_letter',
  REGISTRATION_GRANTED: 'registration_granted',
  PRACTICE_PACK_TASK: 'practice_pack_task'
});

const ACTION_LABEL = Object.freeze({
  supervisor_cv: 'a supervisor CV request',
  alt_supervisor_cv: 'an alternate supervisor CV request',
  sppa: 'the supervised practice agreement (SPPA-00)',
  section_g: 'Section G',
  position_description: 'a position description request',
  offer_contract: 'the offer and contract',
  ahpra_letter: 'logging an AHPRA letter',
  ahpra_conflict_letter: 'the AHPRA conflict-of-interest letter',
  registration_granted: 'the registration-granted steps',
  practice_pack_task: 'a practice-pack task'
});

/** The overseas action a practice-pack document key belongs to, or ''. */
function overseasActionForDocumentKey(documentKey) {
  const key = String(documentKey || '').trim().toLowerCase();
  if (key === 'supervisor_cv') return OVERSEAS_ACTION.SUPERVISOR_CV;
  if (/^alt_supervisor_cv/.test(key)) return OVERSEAS_ACTION.ALT_SUPERVISOR_CV;
  if (key === 'sppa_00') return OVERSEAS_ACTION.SPPA;
  if (key === 'section_g') return OVERSEAS_ACTION.SECTION_G;
  if (key === 'position_description') return OVERSEAS_ACTION.POSITION_DESCRIPTION;
  if (key === 'offer_contract') return OVERSEAS_ACTION.OFFER_CONTRACT;
  return '';
}

/** The overseas action a task belongs to (by type, then document key), or ''. */
function overseasActionForTask(task) {
  const t = task && typeof task === 'object' ? task : {};
  const type = String(t.task_type || '').trim().toLowerCase();
  if (type === 'alt_supervisor_cv_request' || type === 'alt_supervisor_cv_review') return OVERSEAS_ACTION.ALT_SUPERVISOR_CV;
  if (type === 'ahpra_conflict_letter') return OVERSEAS_ACTION.AHPRA_CONFLICT_LETTER;
  if (type === 'ahpra_action_item' || type === 'ahpra_correspondence') return OVERSEAS_ACTION.AHPRA_LETTER;
  if (type === 'practice_pack_child' || type === 'practice_pack') {
    return overseasActionForDocumentKey(t.related_document_key) || OVERSEAS_ACTION.PRACTICE_PACK_TASK;
  }
  return '';
}

/**
 * May this overseas action be taken for a case with these hooks?
 * @returns {{ allowed: boolean, code?: string, message?: string }}
 *   code: 'au_pathway' (the matrix says skip) | 'pathway_unreadable' |
 *         'needs_staff_decision' (segment B / C, not yet decided)
 */
function overseasActionVerdict(hooks, action) {
  const h = hooks && typeof hooks === 'object' ? hooks : null;
  if (!h) return { allowed: false, code: 'pathway_unreadable', message: 'This doctor\'s pathway could not be read just now. Nothing was sent. Please try again.' };
  if (h.column === COLUMN.OVERSEAS) return { allowed: true };
  const what = ACTION_LABEL[action] || 'this action';
  if (h.hold) {
    return { allowed: false, code: 'pathway_unreadable', message: 'This doctor\'s pathway could not be read just now, so ' + what + ' was not sent. Please try again in a moment.' };
  }
  let row = ACTION.SKIP;
  if (action === OVERSEAS_ACTION.SUPERVISOR_CV || action === OVERSEAS_ACTION.ALT_SUPERVISOR_CV) row = h.supervisorCvTask;
  else if (action === OVERSEAS_ACTION.SPPA) row = h.sppa00Task;
  else if (action === OVERSEAS_ACTION.SECTION_G) row = h.sectionGTask;
  else if (action === OVERSEAS_ACTION.POSITION_DESCRIPTION) row = h.positionDescriptionTask;
  else if (action === OVERSEAS_ACTION.OFFER_CONTRACT) row = h.contractTask;
  else if (action === OVERSEAS_ACTION.AHPRA_CONFLICT_LETTER) row = h.sppa00Task;
  else if (action === OVERSEAS_ACTION.REGISTRATION_GRANTED) row = h.ahpraGrantedHandler;
  else if (action === OVERSEAS_ACTION.AHPRA_LETTER) row = h.ahpraGrantedHandler;
  else if (action === OVERSEAS_ACTION.PRACTICE_PACK_TASK) row = ACTION.SKIP;
  if (row === ACTION.FIRE) return { allowed: true };
  if (row === ACTION.REVIEW) {
    return {
      allowed: false, code: 'needs_staff_decision',
      message: 'This doctor is on an Australian pathway (segment ' + h.column + ') and it has not been decided whether ' + what
        + ' applies to this placement. Record the doctor\'s registration details on their profile first.'
    };
  }
  return {
    allowed: false, code: 'au_pathway',
    message: 'This doctor is on an Australian pathway (segment ' + h.column + '), so ' + what
      + ' does not apply to this placement. Use the pre-start tasks on the case instead.'
  };
}

// Words that mark a staff-composed email as an overseas practice-pack request.
// Checked for an Australian case whose hooks say skip, so the composer behind
// "Email the practice requesting the Supervisor CV" cannot be used on one.
const OVERSEAS_REQUEST_PATTERNS = Object.freeze([
  { action: OVERSEAS_ACTION.SUPERVISOR_CV, re: /supervisor(?:'s|’s)?\s+(?:cv|curriculum vitae|r[eé]sum[eé])/i },
  { action: OVERSEAS_ACTION.SPPA, re: /\bsppa\b|supervised practice (?:plan|agreement)/i },
  { action: OVERSEAS_ACTION.SECTION_G, re: /\bsection\s+g\b/i },
  { action: OVERSEAS_ACTION.POSITION_DESCRIPTION, re: /\bposition description\b/i }
]);

/**
 * The first overseas request a piece of staff-written text makes that these
 * hooks do not allow, or null.
 * @returns {{ action: string, verdict: object }|null}
 */
function overseasRequestBlockedInText(hooks, text) {
  const h = hooks && typeof hooks === 'object' ? hooks : null;
  if (h && h.column === COLUMN.OVERSEAS) return null;
  const body = String(text == null ? '' : text);
  for (let i = 0; i < OVERSEAS_REQUEST_PATTERNS.length; i++) {
    const rule = OVERSEAS_REQUEST_PATTERNS[i];
    if (!rule.re.test(body)) continue;
    const verdict = overseasActionVerdict(h, rule.action);
    if (!verdict.allowed) return { action: rule.action, verdict };
  }
  return null;
}

module.exports = {
  COLUMN, ACTION, HOLD_REASON, REVIEW_REASON, REVIEW_REASON_TEXT, PRACTICE_PACK_KEYS,
  OVERSEAS_ACTION, OVERSEAS_REQUEST_PATTERNS,
  supervisionFacts,
  placementHooksFor,
  overseasActionForDocumentKey,
  overseasActionForTask,
  overseasActionVerdict,
  overseasRequestBlockedInText
};

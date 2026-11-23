'use strict';

/**
 * Candidate pathway: the ONE home for "what kind of doctor is this?".
 *
 * WP-02 of the Australian GP build (docs/au-gp/review-report.md, "Proposed data
 * model"). Pure functions only: no database, no network, no process.env reads
 * except through the switch helper when a caller does not pass the switch in.
 * The server-side reader and writers live in server.js
 * (resolveCandidatePathway, setCandidatePathway); every later package asks
 * those, and those ask this file.
 *
 * The six pathways and their segments:
 *
 *   overseas_esp    overseas  Expedited Specialist Pathway. THE DEFAULT: a doctor
 *                             with nothing recorded is this, and behaves exactly
 *                             as every doctor did before the Australian build.
 *   overseas_pep    overseas  Practice Experience Pathway (pre-2007 UK/IE CCT).
 *   au_vr           A         In Australia, vocationally registered GP
 *                             (FRACGP / FACRRM, specialist registration).
 *                             The only Australian pathway that is LAUNCHED.
 *   au_restricted   B         In Australia but restricted (for example under
 *                             the 19AB moratorium, or on a visa tied to a
 *                             sponsor). Built, gated, flagged to staff.
 *   au_non_vr       C         In Australia, not vocationally registered.
 *   au_registrar    C         In Australia, GP registrar in training.
 *
 * Three safety rules this file enforces and every caller relies on:
 *
 *   1. Switch off  -> always overseas_esp, whatever is stored.
 *   2. Unknown     -> overseas_esp. A null, empty or unreadable pathway is
 *                     NEVER read as an Australian one.
 *   3. Fail closed -> when it is not certain an Australian doctor may be shown
 *                     non-DPA roles, they are DPA-restricted
 *                     (see computeDpaRestricted, the single place for that rule).
 */

const { isAuPathwayEnabled } = require('./au-pathway-flag.js');

// ── values ───────────────────────────────────────────────────────────────────
const PATHWAY = Object.freeze({
  OVERSEAS_ESP: 'overseas_esp',
  OVERSEAS_PEP: 'overseas_pep',
  AU_VR: 'au_vr',
  AU_RESTRICTED: 'au_restricted',
  AU_NON_VR: 'au_non_vr',
  AU_REGISTRAR: 'au_registrar'
});

const OVERSEAS_PATHWAYS = Object.freeze([PATHWAY.OVERSEAS_ESP, PATHWAY.OVERSEAS_PEP]);
const AU_PATHWAYS = Object.freeze([PATHWAY.AU_VR, PATHWAY.AU_RESTRICTED, PATHWAY.AU_NON_VR, PATHWAY.AU_REGISTRAR]);
const ALL_PATHWAYS = Object.freeze(OVERSEAS_PATHWAYS.concat(AU_PATHWAYS));
const DEFAULT_PATHWAY = PATHWAY.OVERSEAS_ESP;

// Owner decision 1: segment A is launched; B and C are built but not launched.
const LAUNCHED_AU_PATHWAYS = Object.freeze([PATHWAY.AU_VR]);

const BASIS = Object.freeze({ OVERSEAS: 'overseas', AUSTRALIA: 'australia' });
const ALL_BASES = Object.freeze([BASIS.OVERSEAS, BASIS.AUSTRALIA]);

const SEGMENT = Object.freeze({ OVERSEAS: 'overseas', A: 'A', B: 'B', C: 'C' });
const SEGMENT_BY_PATHWAY = Object.freeze({
  overseas_esp: SEGMENT.OVERSEAS,
  overseas_pep: SEGMENT.OVERSEAS,
  au_vr: SEGMENT.A,
  au_restricted: SEGMENT.B,
  au_non_vr: SEGMENT.C,
  au_registrar: SEGMENT.C
});

// The doctor's own answer to "does the 19AB moratorium apply to you?".
const MORATORIUM_19AB = Object.freeze({ YES: 'yes', NO: 'no', UNSURE: 'unsure' });

// Why a doctor is (or is not) DPA-restricted. Stable strings: staff screens and
// tests read them. Never shown to a doctor.
const DPA_REASON = Object.freeze({
  // overseas pathways: today's country-derived answer, passed in by the caller
  LEGACY_COUNTRY_EXEMPT: 'legacy_country_exempt',
  LEGACY_COUNTRY_RESTRICTED: 'legacy_country_restricted',
  LEGACY_UNKNOWN: 'legacy_unknown',
  // Australian pathways
  STAFF_CONFIRMED_NOT_APPLICABLE: 'staff_confirmed_19ab_not_applicable',
  STAFF_CONFIRMED_APPLIES: 'staff_confirmed_19ab_applies',
  SELF_DECLARED_APPLIES: 'self_declared_19ab_applies',
  AWAITING_STAFF_CONFIRMATION: 'self_declared_no_awaiting_staff_confirmation',
  UNKNOWN_19AB: '19ab_unknown',
  // the records could not be read (not "the columns do not exist yet")
  READ_FAILED: 'records_unreadable'
});

// ── small helpers ────────────────────────────────────────────────────────────
function cleanToken(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

/**
 * Is this exactly one of the six stored values? (No trimming of meaning: used
 * by writers to refuse anything else.)
 */
function isValidPathway(value) {
  return ALL_PATHWAYS.indexOf(cleanToken(value)) !== -1;
}

function isValidBasis(value) {
  return ALL_BASES.indexOf(cleanToken(value)) !== -1;
}

/**
 * Anything -> one of the six pathways. null, undefined, '', numbers, objects
 * and unknown strings all become 'overseas_esp'. Never returns an Australian
 * value for input that is not exactly an Australian value.
 */
function normalisePathway(value) {
  const v = cleanToken(value);
  return ALL_PATHWAYS.indexOf(v) !== -1 ? v : DEFAULT_PATHWAY;
}

function isAuPathway(p) {
  return AU_PATHWAYS.indexOf(cleanToken(p)) !== -1;
}

// True for the two overseas values AND for anything unknown (unknown reads as
// overseas). So isOverseasPathway(p) === !isAuPathway(p), always.
function isOverseasPathway(p) {
  return !isAuPathway(p);
}

/** 'overseas' | 'A' | 'B' | 'C' */
function segmentOf(p) {
  return SEGMENT_BY_PATHWAY[normalisePathway(p)];
}

/** True only for an Australian pathway that is launched (today: au_vr). */
function isLaunchedAuPathway(p) {
  return LAUNCHED_AU_PATHWAYS.indexOf(cleanToken(p)) !== -1;
}

/** The basis a pathway implies when none is stored. */
function defaultBasisFor(p) {
  return isAuPathway(p) ? BASIS.AUSTRALIA : BASIS.OVERSEAS;
}

function normalise19ab(value) {
  const v = cleanToken(value);
  return (v === MORATORIUM_19AB.YES || v === MORATORIUM_19AB.NO || v === MORATORIUM_19AB.UNSURE) ? v : null;
}

/**
 * The staff-confirmed 19AB answer on a gp_credentials row: 'yes', 'no' or null.
 * It only counts when all three parts are present (value, who, when); a value
 * with no name or no timestamp against it is treated as not confirmed.
 */
function staffConfirmed19ab(credentials) {
  const c = credentials && typeof credentials === 'object' ? credentials : null;
  if (!c) return null;
  const v = cleanToken(c.moratorium_19ab_confirmed_status);
  if (v !== MORATORIUM_19AB.YES && v !== MORATORIUM_19AB.NO) return null;
  if (!c.moratorium_19ab_confirmed_at) return null;
  if (!String(c.moratorium_19ab_confirmed_by == null ? '' : c.moratorium_19ab_confirmed_by).trim()) return null;
  return v;
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * computeDpaRestricted: MAY THIS DOCTOR ONLY BE SHOWN / APPLY FOR DPA ROLES?
 *
 * THIS IS THE SINGLE PLACE THE RULE LIVES. Correct it here and nowhere else.
 *
 * REGULATORY ASSUMPTION, NOT YET CONFIRMED BY THE OWNER (review-report.md,
 * "Open decisions and assumptions"): section 19AB of the Health Insurance Act
 * restricts some doctors (broadly, overseas-trained doctors and former overseas
 * students, for ten years) to Distribution Priority Areas for Medicare billing.
 * Holding fellowship, or already living in Australia, does not by itself lift
 * it. Until the owner confirms the exact rule, this function FAILS CLOSED:
 * a doctor is restricted unless there is a positive, staff-confirmed reason to
 * say otherwise.
 *
 * What `dpaRestricted: false` unlocks (do not loosen lightly): the doctor sees
 * the identifying details of, and may apply for, roles that are NOT in a DPA
 * (practicePipeline.gpQualifiesForRole, the careers list / role detail / apply
 * gates in server.js, and AI matching's dpaEligible). Shown to the wrong doctor,
 * that is a role they cannot legally be placed into.
 *
 * Rules:
 *
 *   Overseas pathways (overseas_esp, overseas_pep, and anything unknown)
 *     The answer is exactly today's country-derived answer, which the CALLER
 *     passes in as `legacyDpaExempt` (true when the doctor's country reads as
 *     Australia: server.js _resolveGpJobsProfile().australiaTrained). Nothing
 *     about credentials is consulted, so an existing doctor's result cannot
 *     change. Not passed -> restricted (the same legally-safe default
 *     _resolveGpJobsProfile uses when it knows nothing).
 *
 *   Australian pathways (au_vr, au_restricted, au_non_vr, au_registrar)
 *     Staff have confirmed 19AB does NOT apply   -> not restricted
 *     Staff have confirmed 19AB applies          -> restricted
 *     Doctor says it applies ('yes')             -> restricted
 *     Doctor says 'no', staff not yet confirmed  -> restricted (fail closed)
 *     'unsure', blank, no credentials row        -> restricted (fail closed)
 *   The pathway itself does not change the outcome: au_vr is unrestricted only
 *   on the same staff confirmation the others need. A staff confirmation wins
 *   over the doctor's own answer in both directions. A 19AB end date that has
 *   passed does NOT lift the restriction on its own; staff confirm it.
 *   `legacyDpaExempt` is ignored for Australian pathways: "trained in
 *   Australia" must never unlock a moratorium doctor.
 *
 * @param {object} input
 * @param {string} input.pathway           any value; normalised here
 * @param {object|null} [input.credentials] the doctor's gp_credentials row
 * @param {boolean} [input.legacyDpaExempt] today's country answer (overseas only)
 * @returns {{ dpaRestricted: boolean, reason: string }}
 * ════════════════════════════════════════════════════════════════════════════
 */
function computeDpaRestricted(input) {
  const i = input && typeof input === 'object' ? input : {};
  const pathway = normalisePathway(i.pathway);

  if (!isAuPathway(pathway)) {
    if (i.legacyDpaExempt === true) return { dpaRestricted: false, reason: DPA_REASON.LEGACY_COUNTRY_EXEMPT };
    if (i.legacyDpaExempt === false) return { dpaRestricted: true, reason: DPA_REASON.LEGACY_COUNTRY_RESTRICTED };
    return { dpaRestricted: true, reason: DPA_REASON.LEGACY_UNKNOWN };
  }

  const confirmed = staffConfirmed19ab(i.credentials);
  if (confirmed === MORATORIUM_19AB.NO) return { dpaRestricted: false, reason: DPA_REASON.STAFF_CONFIRMED_NOT_APPLICABLE };
  if (confirmed === MORATORIUM_19AB.YES) return { dpaRestricted: true, reason: DPA_REASON.STAFF_CONFIRMED_APPLIES };

  const self = normalise19ab(i.credentials && i.credentials.moratorium_19ab_status);
  if (self === MORATORIUM_19AB.YES) return { dpaRestricted: true, reason: DPA_REASON.SELF_DECLARED_APPLIES };
  if (self === MORATORIUM_19AB.NO) return { dpaRestricted: true, reason: DPA_REASON.AWAITING_STAFF_CONFIRMATION };
  return { dpaRestricted: true, reason: DPA_REASON.UNKNOWN_19AB };
}

/** True when an Ahpra condition, undertaking or notation is flagged. */
function hasRegistrationFlags(credentials) {
  const c = credentials && typeof credentials === 'object' ? credentials : null;
  if (!c) return false;
  return c.has_conditions === true || c.has_undertakings === true || c.has_notations === true;
}

/**
 * WP-08: has a PERSON looked at this doctor's condition / undertaking /
 * notation and decided what it means? The stamp is two staff-only columns on
 * gp_credentials (flags_reviewed_at + flags_reviewed_by). Both must be present:
 * a time with no name against it is not a review. The stamp is cleared whenever
 * the recorded flags change (lib/gp-credentials.js sanitiseCredentialsPatch),
 * so a NEW condition is looked at again.
 */
function registrationFlagsReviewed(credentials) {
  const c = credentials && typeof credentials === 'object' ? credentials : null;
  if (!c) return false;
  return !!(c.flags_reviewed_at && cleanToken(c.flags_reviewed_by));
}

// Registration types that mean the doctor works under supervision or limits.
// Mirrors SUPERVISED_REGISTRATION_TYPES in lib/gp-credentials.js (that file
// requires this one, so the list cannot be imported here).
const ROLE_FIT_SUPERVISED_TYPES = Object.freeze(['provisional', 'limited']);
const ROLE_FIT_CLEAR_TYPES = Object.freeze(['general', 'specialist', 'general_and_specialist']);
const ROLE_FIT_VR_FELLOWSHIPS = Object.freeze(['fracgp', 'facrrm', 'both']);

/**
 * WP-08: the three facts about an Australian doctor that decide which ROLES
 * they fit (lib/role-eligibility.js roleEligibilityFor reads them). Booleans
 * only: never a condition's text, a number or a date.
 *
 *   vr          may take a role that requires a vocationally registered GP
 *   registrar   is a GP registrar (needs a role that accepts registrars)
 *   supervised  works under supervision / limits (needs a role that accepts that)
 *
 * The pathway decides for A and C. For B (au_restricted) the credentials row
 * decides, and anything missing or unclear takes the restrictive answer:
 * not VR, and supervised.
 *
 * @returns {{ vr: boolean, registrar: boolean, supervised: boolean }|null} null for an overseas pathway
 */
function roleFitFromRecords(pathway, credentials) {
  const p = normalisePathway(pathway);
  if (!isAuPathway(p)) return null;
  if (p === PATHWAY.AU_VR) return { vr: true, registrar: false, supervised: false };
  if (p === PATHWAY.AU_NON_VR) return { vr: false, registrar: false, supervised: false };
  if (p === PATHWAY.AU_REGISTRAR) return { vr: false, registrar: true, supervised: false };
  const c = credentials && typeof credentials === 'object' ? credentials : {};
  const type = cleanToken(c.ahpra_registration_type);
  const level = cleanToken(c.supervision_level);
  const supervised = ROLE_FIT_SUPERVISED_TYPES.indexOf(type) !== -1
    || ROLE_FIT_CLEAR_TYPES.indexOf(type) === -1
    || (level !== '' && level !== 'none');
  const vr = !supervised && (cleanToken(c.vr_status) === 'vr'
    || (c.specialist_gp === true && ROLE_FIT_VR_FELLOWSHIPS.indexOf(cleanToken(c.fellowship_type)) !== -1));
  return { vr, registrar: false, supervised };
}

/**
 * FR-1 (B-01), the server-side belt. A pathway counts as staff-confirmed only
 * when BOTH halves the server writes together are there: the stamp
 * (pathway_confirmed_at) and a named person (pathway_confirmed_by) who is not
 * the doctor ('self') and not the 'unknown' placeholder. setCandidatePathway
 * always writes the pair, so a row with a stamp and no name was not written by
 * it. This costs no read (both columns are already in the resolver's select).
 * The control that actually stops a doctor writing these columns is the
 * database trigger in 20261123110000_au_gp_fr1_server_owned_columns_guard.sql;
 * this is only a second line.
 */
function isStaffConfirmedProfile(profile) {
  const p = profile && typeof profile === 'object' ? profile : null;
  if (!p || !p.pathway_confirmed_at) return false;
  const by = String(p.pathway_confirmed_by == null ? '' : p.pathway_confirmed_by).trim().toLowerCase();
  return by !== '' && by !== 'self' && by !== 'unknown';
}

/**
 * The resolver. Everything a caller needs to know about a doctor's pathway,
 * from the rows the server already read.
 *
 * @param {object} input
 * @param {object|null} input.profile       the user_profiles pathway columns:
 *        { candidate_pathway, candidate_basis, pathway_set_by, pathway_set_at,
 *          pathway_confirmed_at, pathway_confirmed_by } (extra keys ignored)
 * @param {object|null} input.credentials   the doctor's gp_credentials row
 * @param {boolean} [input.flagEnabled]     the AU_PATHWAY_ENABLED switch. When
 *        not a boolean it is read at call time (lib/au-pathway-flag.js).
 * @param {boolean} [input.legacyDpaExempt] today's "country is Australia"
 *        answer; decides dpaRestricted for overseas pathways (see
 *        computeDpaRestricted). WP-08 passes _resolveGpJobsProfile().australiaTrained.
 * @param {boolean} [input.readFailed]      the records could not be read for a
 *        reason other than "not migrated yet": dpaRestricted is forced true.
 * @returns {{
 *   pathway: string,            one of the six values
 *   basis: 'overseas'|'australia',
 *   segment: 'overseas'|'A'|'B'|'C',
 *   isAu: boolean,
 *   dpaRestricted: boolean,
 *   dpaRestrictedReason: string,
 *   confirmed: boolean,         a pathway is stored AND staff have confirmed it
 *   needsStaffReview: boolean,  Australian only: B or C, or not yet confirmed,
 *                               or a condition/undertaking/notation is flagged
 *   launched: boolean,          false ONLY for an Australian pathway that is
 *                               built but not launched (B and C). Overseas: true.
 *   recorded: boolean,          a valid pathway is actually stored (false = default)
 *   flagEnabled: boolean
 * }}
 */
function resolvePathwayFromRecords(input) {
  const i = input && typeof input === 'object' ? input : {};
  const flagEnabled = typeof i.flagEnabled === 'boolean' ? i.flagEnabled : isAuPathwayEnabled();
  const profile = flagEnabled && i.profile && typeof i.profile === 'object' ? i.profile : null;
  const credentials = flagEnabled && i.credentials && typeof i.credentials === 'object' ? i.credentials : null;

  // Switch off: stored values are not even looked at.
  const stored = profile ? cleanToken(profile.candidate_pathway) : '';
  const recorded = ALL_PATHWAYS.indexOf(stored) !== -1;
  const pathway = recorded ? stored : DEFAULT_PATHWAY;
  const isAu = isAuPathway(pathway);

  // Basis: the stored value when it is valid, otherwise what the pathway implies.
  // An unrecorded pathway is always overseas, whatever a stray basis says.
  const storedBasis = profile ? cleanToken(profile.candidate_basis) : '';
  const basis = (recorded && ALL_BASES.indexOf(storedBasis) !== -1) ? storedBasis : defaultBasisFor(pathway);

  let dpa = computeDpaRestricted({ pathway, credentials, legacyDpaExempt: i.legacyDpaExempt });
  if (i.readFailed === true) dpa = { dpaRestricted: true, reason: DPA_REASON.READ_FAILED };

  const confirmed = recorded && isStaffConfirmedProfile(profile);
  const launched = isAu ? isLaunchedAuPathway(pathway) : true;
  // Overseas doctors are never flagged by this build: nothing changes for them.
  // WP-08: a recorded condition stops asking for a review once a person has
  // looked at it (registrationFlagsReviewed). Unlaunched or unconfirmed still
  // always needs one.
  const flagsOutstanding = hasRegistrationFlags(credentials) && !registrationFlagsReviewed(credentials);
  const needsStaffReview = isAu && (!launched || !confirmed || flagsOutstanding);

  if (isAu) {
    return {
      pathway,
      basis,
      segment: segmentOf(pathway),
      isAu,
      dpaRestricted: dpa.dpaRestricted,
      dpaRestrictedReason: dpa.reason,
      confirmed,
      needsStaffReview,
      launched,
      recorded,
      flagEnabled,
      // WP-08 (Australian pathways only, so an overseas result is the shape it
      // always was): what roles the doctor fits, and whether a flag is on file.
      roleFit: roleFitFromRecords(pathway, credentials),
      hasRegistrationFlags: hasRegistrationFlags(credentials),
      flagsReviewed: registrationFlagsReviewed(credentials)
    };
  }

  return {
    pathway,
    basis,
    segment: segmentOf(pathway),
    isAu,
    dpaRestricted: dpa.dpaRestricted,
    dpaRestrictedReason: dpa.reason,
    confirmed,
    needsStaffReview,
    launched,
    recorded,
    flagEnabled
  };
}

/** The result every caller gets with the switch off or nothing recorded. */
function overseasDefault(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  return resolvePathwayFromRecords({
    profile: null,
    credentials: null,
    flagEnabled: typeof o.flagEnabled === 'boolean' ? o.flagEnabled : false,
    legacyDpaExempt: o.legacyDpaExempt,
    readFailed: o.readFailed
  });
}

/**
 * Which fee tier of the existing practice agreement applies (WP-13).
 * Owner decision 3: the tiers already in lib/agreement-variants.js; no prices
 * are decided here. Reads the resolver result's basis; anything missing or
 * unreadable is 'overseas'.
 *
 * @param {object} pathwayResult a resolvePathwayFromRecords / resolveCandidatePathway result
 * @returns {'australia'|'overseas'}
 */
function feeBasisFor(pathwayResult) {
  const r = pathwayResult && typeof pathwayResult === 'object' ? pathwayResult : null;
  if (!r || r.flagEnabled === false) return BASIS.OVERSEAS;
  return cleanToken(r.basis) === BASIS.AUSTRALIA ? BASIS.AUSTRALIA : BASIS.OVERSEAS;
}

/**
 * The part of a resolver result a doctor's own browser may see. Never includes
 * the DPA flag, its reason, or anything staff recorded.
 */
function publicPathwayView(pathwayResult) {
  const r = pathwayResult && typeof pathwayResult === 'object' ? pathwayResult : overseasDefault();
  return { pathway: r.pathway, segment: r.segment, isAu: r.isAu === true, launched: r.launched !== false };
}

// ── WP-05: deriving the pathway from a doctor's own onboarding answers ───────
// The answer tokens the Australian onboarding branch sends (lib/au-onboarding.js
// validates them before this is called). 'unsure' and 'registrar' are answers,
// not stored credential values.
const ONBOARDING_VR_REGISTRATION_TYPES = Object.freeze(['specialist', 'general_and_specialist']);
const ONBOARDING_SUPERVISED_REGISTRATION_TYPES = Object.freeze(['provisional', 'limited']);
const ONBOARDING_CLEAR_REGISTRATION_TYPES = Object.freeze(['general', 'specialist', 'general_and_specialist']);
const ONBOARDING_VR_FELLOWSHIPS = Object.freeze(['fracgp', 'facrrm', 'both']);
const ONBOARDING_FELLOWSHIP_ANSWERS = Object.freeze(['fracgp', 'facrrm', 'both', 'other', 'none', 'registrar']);
const ONBOARDING_WORK_RIGHTS = Object.freeze(['citizen', 'pr', 'visa']);

/**
 * THE one place a doctor's onboarding answers become a pathway (finding
 * APP-07). Pure. The result is always one of the four AUSTRALIAN pathways: the
 * caller only asks once the doctor has said "I am registered with Ahpra and
 * working in Australia". It is a self-declared, unconfirmed pathway; staff
 * confirm or correct it (WP-06).
 *
 * Regulatory detail is NOT confirmed. The rule is deliberately fail-safe and
 * lives only here, so it is one edit to correct:
 *
 *   1. Any restriction signal                         -> au_restricted (B)
 *        limited or provisional registration, a condition / undertaking /
 *        notation, a temporary right to work ('visa'), or the doctor says the
 *        19AB moratorium applies.
 *   2. Anything missing or unclear                    -> au_restricted (B)
 *        no / unknown registration type ('unsure', non-practising), no
 *        fellowship answer, conditions not answered, work rights not answered,
 *        19AB not answered. "Unclear" lands in the more restricted segment.
 *   3. GP registrar / in training                     -> au_registrar (C)
 *   4. Specialist (GP) registration + FRACGP / FACRRM
 *      + no conditions + citizen or permanent resident -> au_vr (A)
 *   5. Everything else (no fellowship, another
 *      fellowship, general registration only)         -> au_non_vr (C)
 *
 * 19AB "not sure" does NOT change the segment: the doctor stays in whichever
 * segment the other answers give, and computeDpaRestricted keeps them limited
 * to DPA roles until staff confirm. 19AB "no" from the doctor unlocks nothing
 * either (same function). Only 19AB "yes" moves the segment (to B).
 *
 * @param {object} answers
 * @param {string}  answers.registrationType  general | specialist | general_and_specialist | provisional | limited | non_practising | unsure
 * @param {string}  answers.fellowship        fracgp | facrrm | both | other | none | registrar
 * @param {boolean} [answers.inTraining]      true = GP registrar (same as fellowship 'registrar')
 * @param {boolean|null} answers.hasConditions  any condition, undertaking or notation
 * @param {string}  answers.moratorium19ab    yes | no | unsure
 * @param {string}  answers.workRights        citizen | pr | visa
 * @returns {{ pathway: string, segment: 'A'|'B'|'C', launched: boolean, reasons: string[] }}
 */
function derivePathwayFromOnboarding(answers) {
  const a = answers && typeof answers === 'object' ? answers : {};
  const regType = cleanToken(a.registrationType);
  const fellowship = cleanToken(a.fellowship);
  const workRights = cleanToken(a.workRights);
  const moratorium = normalise19ab(a.moratorium19ab);
  const hasConditions = typeof a.hasConditions === 'boolean' ? a.hasConditions : null;
  const inTraining = a.inTraining === true || fellowship === 'registrar';

  const restricted = [];
  if (ONBOARDING_SUPERVISED_REGISTRATION_TYPES.indexOf(regType) !== -1) restricted.push('supervised_registration');
  if (hasConditions === true) restricted.push('registration_conditions');
  if (workRights === 'visa') restricted.push('temporary_work_rights');
  if (moratorium === MORATORIUM_19AB.YES) restricted.push('moratorium_19ab_applies');

  const unclear = [];
  if (ONBOARDING_SUPERVISED_REGISTRATION_TYPES.indexOf(regType) === -1
    && ONBOARDING_CLEAR_REGISTRATION_TYPES.indexOf(regType) === -1) unclear.push('registration_type_unclear');
  if (ONBOARDING_FELLOWSHIP_ANSWERS.indexOf(fellowship) === -1 && !inTraining) unclear.push('fellowship_unclear');
  if (hasConditions === null) unclear.push('conditions_unclear');
  if (ONBOARDING_WORK_RIGHTS.indexOf(workRights) === -1) unclear.push('work_rights_unclear');
  if (!moratorium) unclear.push('moratorium_19ab_unanswered');

  let pathway;
  let reasons;
  if (restricted.length || unclear.length) {
    pathway = PATHWAY.AU_RESTRICTED;
    reasons = restricted.concat(unclear);
  } else if (inTraining) {
    pathway = PATHWAY.AU_REGISTRAR;
    reasons = ['in_training'];
  } else if (ONBOARDING_VR_REGISTRATION_TYPES.indexOf(regType) !== -1
    && ONBOARDING_VR_FELLOWSHIPS.indexOf(fellowship) !== -1) {
    // hasConditions === false and citizen / pr are guaranteed by the two
    // checks above (a true or missing answer never reaches this line).
    pathway = PATHWAY.AU_VR;
    reasons = ['specialist_gp_with_fellowship'];
  } else {
    pathway = PATHWAY.AU_NON_VR;
    reasons = [ONBOARDING_VR_FELLOWSHIPS.indexOf(fellowship) === -1 ? 'no_gp_fellowship' : 'not_on_specialist_register'];
  }
  if (moratorium === MORATORIUM_19AB.UNSURE) reasons.push('moratorium_19ab_unsure');
  return { pathway, segment: segmentOf(pathway), launched: isLaunchedAuPathway(pathway), reasons };
}

/**
 * WP-06. The pathway after staff have checked the doctor on the public Ahpra
 * register. It is NOT a second rule: it turns the doctor's credentials row
 * (their own onboarding answers, with the staff findings written over the top)
 * back into the answers derivePathwayFromOnboarding takes, and asks that one
 * function. So onboarding answers and staff findings always give ONE answer,
 * and a correction to the rule is still a single edit.
 *
 * What the staff check contributes: registration type, the three flags
 * (conditions, undertakings, notations: all three must have been answered
 * "no" to count as clear), the staff-confirmed 19AB answer (which wins over
 * the doctor's own), and, when staff recorded them, fellowship and right to
 * work. What stays the doctor's answer: anything staff did not record.
 * "In training" is not a credentials column: it is carried by the pathway
 * already recorded (au_registrar).
 *
 * Fail-safe exactly like the onboarding rule: anything missing lands in
 * au_restricted (B) and is flagged to a person. Staff can still set any
 * pathway by hand with the pathway control.
 *
 * FR-1 (R-05). On top of that one rule, the check can only CONFIRM segment A
 * (au_vr) against what staff actually saw on the register. Each of these is a
 * further restriction, never a relaxation, so the answer is always at least as
 * restricted as the onboarding rule's:
 *
 *   - registration expired (expiry before `today`), or no expiry recorded
 *                                              -> au_restricted (B)
 *   - any supervision level other than 'none'  -> au_restricted (B)
 *   - "on the specialist register as a GP" not answered
 *                                              -> au_restricted (B)
 *   - "on the specialist register as a GP" answered NO, where the other
 *     answers would have given au_vr           -> au_non_vr (C)
 *
 * So au_vr needs ALL of: specialist (or general and specialist) registration,
 * the specialist-GP answer YES, a GP fellowship on file, no condition /
 * undertaking / notation, no supervision, an expiry date that has not passed,
 * citizen or permanent resident, and 19AB not "applies". Every other outcome
 * is an unlaunched segment, which the caller turns into a segment-review task.
 *
 * @param {object} input
 * @param {object|null} input.credentials  the gp_credentials row as stored after the check
 * @param {string} [input.currentPathway]  the pathway recorded before the check
 * @param {string} [input.today]  today's calendar date (YYYY-MM-DD) for the
 *        expiry test. Not given: the expiry cannot be judged, which counts as
 *        not confirmed (fail closed).
 * @returns {{ pathway: string, segment: 'A'|'B'|'C', launched: boolean, reasons: string[], hasFlags: boolean }}
 */
function derivePathwayFromRegisterCheck(input) {
  const i = input && typeof input === 'object' ? input : {};
  const c = i.credentials && typeof i.credentials === 'object' ? i.credentials : {};
  const flags = [c.has_conditions, c.has_undertakings, c.has_notations];
  let hasConditions = null;
  if (flags.some(function (f) { return f === true; })) hasConditions = true;
  else if (flags.every(function (f) { return f === false; })) hasConditions = false;
  const inTraining = normalisePathway(i.currentPathway) === PATHWAY.AU_REGISTRAR;
  const out = derivePathwayFromOnboarding({
    registrationType: c.ahpra_registration_type,
    fellowship: inTraining ? 'registrar' : c.fellowship_type,
    inTraining,
    hasConditions,
    moratorium19ab: staffConfirmed19ab(c) || normalise19ab(c.moratorium_19ab_status),
    workRights: c.work_rights
  });

  // R-05: what staff saw on the register can only restrict further.
  const restrict = [];
  const level = cleanToken(c.supervision_level);
  if (level !== '' && level !== 'none' && out.reasons.indexOf('supervised_registration') === -1) restrict.push('supervised_registration');
  const expiry = /^\d{4}-\d{2}-\d{2}/.test(String(c.registration_expiry || '')) ? String(c.registration_expiry).slice(0, 10) : '';
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(i.today || '')) ? String(i.today) : '';
  if (!expiry) restrict.push('registration_expiry_missing');
  else if (!today) restrict.push('registration_expiry_not_judged');
  else if (expiry < today) restrict.push('registration_expired');
  if (c.specialist_gp !== true && c.specialist_gp !== false) restrict.push('specialist_register_unanswered');

  if (restrict.length) {
    out.reasons = (out.pathway === PATHWAY.AU_RESTRICTED ? out.reasons : []).concat(restrict);
    out.pathway = PATHWAY.AU_RESTRICTED;
  } else if (out.pathway === PATHWAY.AU_VR && c.specialist_gp !== true) {
    // The registration type on file says specialist, but staff answered that
    // the doctor is NOT on the specialist register as a GP. What staff saw wins.
    out.pathway = PATHWAY.AU_NON_VR;
    out.reasons = ['not_on_specialist_register'];
  }
  out.segment = segmentOf(out.pathway);
  out.launched = isLaunchedAuPathway(out.pathway);
  out.hasFlags = hasRegistrationFlags(c);
  return out;
}

module.exports = {
  derivePathwayFromOnboarding,
  derivePathwayFromRegisterCheck,
  PATHWAY,
  ALL_PATHWAYS,
  AU_PATHWAYS,
  OVERSEAS_PATHWAYS,
  LAUNCHED_AU_PATHWAYS,
  DEFAULT_PATHWAY,
  BASIS,
  ALL_BASES,
  SEGMENT,
  MORATORIUM_19AB,
  DPA_REASON,
  isValidPathway,
  isValidBasis,
  normalisePathway,
  isAuPathway,
  isOverseasPathway,
  segmentOf,
  isLaunchedAuPathway,
  defaultBasisFor,
  normalise19ab,
  staffConfirmed19ab,
  computeDpaRestricted,
  hasRegistrationFlags,
  registrationFlagsReviewed,
  roleFitFromRecords,
  isStaffConfirmedProfile,
  resolvePathwayFromRecords,
  overseasDefault,
  feeBasisFor,
  publicPathwayView
};

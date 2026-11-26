'use strict';

// FB-2a (R13): calendar dates on the Australian clock (auEarliestStart).
const auLifecycleLib = require('./au-lifecycle.js');
const auFees = require('./au-placement-fees.js');

/**
 * Role eligibility: the ONE place that decides whether a doctor may see,
 * identify and apply for a role.
 *
 * WP-08 of the Australian GP build. Pure: no database, no network, no switch
 * read (the pathway result handed in already honours the switch).
 *
 * Before this file, "may this doctor have a role outside a Distribution
 * Priority Area?" was answered by a country test (country = Australia) at six
 * call sites. All of them now ask roleEligibilityFor(pathwayResult, role).
 *
 * In plain words:
 *
 *   Overseas doctor (nothing recorded, overseas_esp, overseas_pep, switch off)
 *     EXACTLY the rule that has always applied: a DPA role is open; a role
 *     outside a DPA is open only when the doctor's country reads as Australia
 *     (the caller hands that in as `legacyDpaExempt`, which the pathway
 *     resolver turns into `dpaRestricted`). None of the new role fields is
 *     looked at.
 *
 *   Australian doctor (au_vr, au_restricted, au_non_vr, au_registrar)
 *     1. DPA. A doctor who is DPA-restricted (computeDpaRestricted: restricted
 *        until staff confirm 19AB does not apply) gets only roles KNOWN to be
 *        in a DPA. A role whose DPA status is unknown is not offered to them.
 *     2. Fit.  au_vr         any role
 *              au_non_vr     only a role that says it accepts non-VR doctors
 *              au_registrar  only a role that says it accepts registrars
 *              au_restricted as VR or non-VR per the sorting rule
 *                            (lib/au-work-sorting.js). Since WP-29 supervision
 *                            never filters a role: every practice accepts it.
 *                            A doctor whose right to work is tied to an
 *                            employer: only a role whose practice offers
 *                            sponsorship.
 *        A role that says nothing is treated as VR-required, no registrars,
 *        no supervised doctors (owner decision 5).
 *     3. Hold. Since WP-29 the sorting rule decides who is HELD (registrars,
 *        non-VR doctors, and a doctor whose number or name did not check
 *        out): nothing is shown and self-service apply is refused, whatever
 *        the role. Staff still see `eligible` and may put the doctor forward
 *        by hand when it is true. A restricted doctor (segment B) who is a
 *        vocationally registered GP is NOT held: they see what they may take.
 *
 *   Could not be read (readFailed), or the database has no pathway columns
 *   (schemaMissing): restricted. DPA roles only.
 *
 * REGULATORY ASSUMPTIONS ARE NOT CONFIRMED (review-report.md, open decision
 * 2). Every rule above lives in this file or in computeDpaRestricted
 * (lib/candidate-pathway.js) so it is one edit to correct.
 */

const VR_REQUIREMENTS = Object.freeze(['vr_required', 'vr_preferred', 'non_vr_accepted']);
const DEFAULT_VR_REQUIREMENT = 'vr_required';           // owner decision 5
const ENGAGEMENT_TYPES = Object.freeze(['permanent', 'contract']);   // no locum: owner decision 10
const DPA_STATUSES = Object.freeze(['yes', 'no', 'unknown']);
const BILLING_MODELS = Object.freeze(['bulk', 'mixed', 'private']);
const MAX_SPECIAL_INTERESTS = 12;

const REASON = Object.freeze({
  DPA_RESTRICTED: 'dpa_restricted',
  ROLE_DPA_UNKNOWN: 'role_dpa_unknown',
  VR_REQUIRED: 'vr_required',
  REGISTRARS_NOT_ACCEPTED: 'registrars_not_accepted',
  SUPERVISED_NOT_ACCEPTED: 'supervised_not_accepted',
  PATHWAY_ON_HOLD: 'pathway_on_hold',
  PATHWAY_UNREADABLE: 'pathway_unreadable',
  // WP-29: the doctor's right to work needs a sponsoring practice and this
  // role's practice has not said it offers sponsorship.
  SPONSORSHIP_NOT_OFFERED: 'sponsorship_not_offered'
});

// What a doctor is told. No word from AGENT-RULES section 4.
// Round 8 (S8-07): no promise of roles to a doctor we may not be able to place yet.
const HOLD_MESSAGE = 'Our team is confirming your details and will be in touch by email.';
// WP-29: GP Link does not place GP registrars. What a registrar is told, on
// every screen and in the "profile complete" email (lib/au-messages.js builds
// the email from these same strings). No promise of roles.
const REGISTRAR_HOLD_TITLE = 'We place fully qualified GPs';
const REGISTRAR_HOLD_MESSAGE = 'GP Link works with GPs who hold fellowship (FRACGP or FACRRM) or are otherwise fully qualified to practise independently. '
  + "We can't place GP registrars at the moment. "
  + 'Once you have your fellowship, sign in again and update your details and we will take it from there.';
const HOLD_TITLE = 'Thanks, we have your details';
const DOCTOR_MESSAGE = Object.freeze({
  sponsorship_not_offered: "You don't currently qualify for this role.",
  dpa_restricted: "You don't currently qualify for this role.",
  role_dpa_unknown: "You don't currently qualify for this role.",
  vr_required: 'This role is only open to vocationally registered GPs.',
  registrars_not_accepted: 'This role is not open to GP registrars.',
  supervised_not_accepted: 'This role cannot offer the supervision your registration needs.',
  pathway_on_hold: HOLD_MESSAGE,
  pathway_unreadable: "You don't currently qualify for this role."
});
// What staff are told.
const STAFF_MESSAGE = Object.freeze({
  dpa_restricted: 'The doctor is limited to DPA roles (19AB not cleared by staff) and this role is not in a DPA.',
  role_dpa_unknown: "This role's DPA status is unknown. Ask the practice, then set it on the job.",
  vr_required: 'The role does not accept non-VR doctors.',
  registrars_not_accepted: 'The role does not accept GP registrars.',
  supervised_not_accepted: 'The role does not accept doctors who need supervision.',
  pathway_on_hold: 'The doctor is held: they cannot see roles or apply themselves. Staff may put them forward by hand.',
  sponsorship_not_offered: "The doctor's right to work is tied to an employer and this role's practice has not said it offers sponsorship.",
  pathway_unreadable: 'The doctor\'s pathway could not be read. Treated as limited to DPA roles.'
});

function token(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

/**
 * One billing word from whatever a role stores. career_roles.billing_model is
 * free text today ('mixed', 'Mixed Billing', 'Bulk Billing', 'private'), with
 * two legacy booleans beside it. No new column: this reads the existing ones.
 * @returns {'bulk'|'mixed'|'private'|''}
 */
function normaliseBillingModel(role) {
  const r = role && typeof role === 'object' ? role : { billing_model: role };
  const raw = token(r.billing_model != null ? r.billing_model : r.billingModel);
  if (/^mixed/.test(raw)) return 'mixed';
  if (/^bulk/.test(raw)) return 'bulk';
  if (/^private/.test(raw)) return 'private';
  if (r.mixed_billing === true) return 'mixed';
  if (r.private_billing === true) return 'private';
  return '';
}

/**
 * A role's DPA status for an AUSTRALIAN doctor: 'yes' only when known.
 *   dpa_status 'yes'                     -> yes
 *   dpa_status 'no' / 'unknown'          -> that
 *   dpa_status not set, dpa === true     -> yes  (every existing DPA role)
 *   dpa_status not set, dpa anything else -> no  (the legacy boolean stored
 *                                           "unknown" as false: DAT-13)
 * Overseas logic never calls this: it reads the legacy boolean, unchanged.
 */
function roleDpaStatus(role) {
  const r = role && typeof role === 'object' ? role : {};
  const status = token(r.dpa_status != null ? r.dpa_status : r.dpaStatus);
  if (DPA_STATUSES.indexOf(status) !== -1) return status;
  return r.dpa === true ? 'yes' : 'no';
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The role fields in one tidy object, defaults applied (NULL = closed). */
function readRoleFields(role) {
  const r = role && typeof role === 'object' ? role : {};
  const stored = token(r.vr_requirement);
  const vrStored = VR_REQUIREMENTS.indexOf(stored) !== -1 ? stored : null;
  const engagement = token(r.engagement_type);
  const interests = Array.isArray(r.special_interests)
    ? r.special_interests.filter(function (x) { return typeof x === 'string' && x.trim(); }).map(function (x) { return x.trim(); })
    : [];
  const mmmMatch = String(r.mmm == null ? '' : r.mmm).match(/[1-7]/);
  return {
    vrRequirement: vrStored || DEFAULT_VR_REQUIREMENT,
    vrRequirementStored: vrStored,
    acceptsRegistrars: r.accepts_registrars === true,
    acceptsSupervised: r.accepts_supervised === true,
    engagementType: ENGAGEMENT_TYPES.indexOf(engagement) !== -1 ? engagement : null,
    sessionsMin: numOrNull(r.sessions_min),
    sessionsMax: numOrNull(r.sessions_max),
    specialInterests: interests,
    billingModel: normaliseBillingModel(r),
    mmm: mmmMatch ? Number(mmmMatch[0]) : null,
    dpaStatus: roleDpaStatus(r),
    dpaStatusStored: DPA_STATUSES.indexOf(token(r.dpa_status)) !== -1 ? token(r.dpa_status) : null
  };
}

/** Metro / regional from MMM (MM1 = metropolitan). Falls back to the stored flags. */
function areaFromRole(role) {
  const f = readRoleFields(role);
  if (f.mmm != null) return f.mmm === 1 ? 'metro' : 'regional';
  const r = role && typeof role === 'object' ? role : {};
  if (r.metro === true) return 'metro';
  if (r.regional === true) return 'regional';
  return '';
}

/**
 * THE "unlaunched -> hold" decision. Launching segment B or C later is one
 * change: LAUNCHED_AU_PATHWAYS in lib/candidate-pathway.js (the resolver's
 * `launched` then turns true and this stops holding).
 */
function shouldHoldSelfService(pathwayResult) {
  const p = pathwayResult && typeof pathwayResult === 'object' ? pathwayResult : null;
  if (!p || p.isAu !== true) return false;
  if (p.readFailed === true || p.schemaMissing === true) return false; // read as restricted overseas instead
  // WP-29: the decision is candidatePathway.selfServiceHold, which the
  // resolver puts on its result. A result built by hand without it keeps the
  // older, stricter reading (every unlaunched pathway is held).
  if (typeof p.selfServiceHeld === 'boolean') return p.selfServiceHeld;
  return p.launched === false;
}

/**
 * WP-29: what a HELD doctor is shown. A registrar gets the plain "we place
 * fully qualified GPs" message; every other held doctor gets the existing
 * "we are confirming your details" card. Null when the doctor is not held.
 * @returns {{ held: true, kind: 'registrar'|'review', title: string, message: string }|null}
 */
function holdViewFor(pathwayResult) {
  if (!shouldHoldSelfService(pathwayResult)) return null;
  const p = pathwayResult;
  const registrar = p.holdKind === 'registrar' || (p.holdKind == null && p.pathway === 'au_registrar');
  return registrar
    ? { held: true, kind: 'registrar', title: REGISTRAR_HOLD_TITLE, message: REGISTRAR_HOLD_MESSAGE }
    : { held: true, kind: 'review', title: HOLD_TITLE, message: HOLD_MESSAGE };
}

/**
 * THE rule.
 *
 * @param {object} pathwayResult  a resolveCandidatePathway / resolvePathwayFromRecords
 *        result. For an overseas doctor the caller must have passed
 *        `legacyDpaExempt` when resolving, so `dpaRestricted` is today's answer.
 *        Missing / not an object -> restricted.
 * @param {object} role  a career_roles row (or any object carrying `dpa` and,
 *        for Australian doctors, the WP-08 role fields).
 * @returns {{
 *   visible: boolean,       the doctor's list may show the role at all (a role
 *                           they cannot have for a DPA reason is shown blurred,
 *                           exactly as today)
 *   identifiable: boolean,  it may be shown un-blurred with its details
 *   canApply: boolean,      the doctor may apply themselves
 *   eligible: boolean,      the role fits this doctor, launch aside. Staff use
 *                           this: they may put a held doctor forward by hand
 *                           only when it is true.
 *   hold: boolean,          the doctor is in a segment that is not launched
 *   reasons: string[],      every reason that applies (REASON values)
 *   legacyReason: string    'dpa_restricted' or '' (the value today's screens read)
 * }}
 */
function roleEligibilityFor(pathwayResult, role) {
  const p = pathwayResult && typeof pathwayResult === 'object' ? pathwayResult : null;
  const r = role && typeof role === 'object' ? role : {};
  const reasons = [];
  const unreadable = !p || p.readFailed === true || p.schemaMissing === true;
  const isAu = !unreadable && p.isAu === true;

  // FR-1 (final review S-05). The doctor's records could NOT BE READ on this
  // request (`readFailed`: a failed database read, not "the migration is not
  // applied"). Nobody knows whether this is an overseas doctor, a launched
  // Australian one, or a held segment B / C doctor, so for this one request
  // nothing may be applied for and nothing is identified: every role is
  // shown blurred, including DPA roles. It used to be read as "an ordinary
  // overseas doctor", which let a held doctor apply for any DPA role whenever
  // one read failed. The next request, with a read that works, is judged
  // normally. `schemaMissing` (migration not applied = nobody is Australian
  // here) and a missing result keep today's overseas answer below; the switch
  // being off never produces `readFailed` at all.
  // (The pure resolver marks the same thing with dpaRestrictedReason 'records_unreadable'.)
  if (p && (p.readFailed === true || p.dpaRestrictedReason === 'records_unreadable') && p.schemaMissing !== true) {
    return {
      visible: true, identifiable: false, canApply: false, eligible: false, hold: false, unreadable: true,
      reasons: [REASON.DPA_RESTRICTED, REASON.PATHWAY_UNREADABLE], legacyReason: REASON.DPA_RESTRICTED
    };
  }

  if (!isAu) {
    // Overseas (and unreadable): today's rule, on today's boolean.
    const restricted = unreadable ? true : p.dpaRestricted !== false;
    const ok = r.dpa === true || !restricted;
    if (!ok) {
      reasons.push(REASON.DPA_RESTRICTED);
      if (unreadable && p) reasons.push(REASON.PATHWAY_UNREADABLE);
    }
    return {
      visible: true, identifiable: ok, canApply: ok, eligible: ok, hold: false,
      reasons, legacyReason: ok ? '' : REASON.DPA_RESTRICTED
    };
  }

  const fields = readRoleFields(r);
  // 1. DPA
  if (p.dpaRestricted !== false && fields.dpaStatus !== 'yes') {
    reasons.push(REASON.DPA_RESTRICTED);
    if (fields.dpaStatus === 'unknown') reasons.push(REASON.ROLE_DPA_UNKNOWN);
  }
  // 2. Fit. No role-fit facts on the result = the restrictive answer.
  const fit = p.roleFit && typeof p.roleFit === 'object'
    ? p.roleFit
    : { vr: p.pathway === 'au_vr', registrar: p.pathway === 'au_registrar', supervised: p.pathway === 'au_restricted' };
  let fitFailed = false;
  // WP-29 (owner, 25 November 2026): SUPERVISION NEVER FILTERS A ROLE. Every
  // GP Link practice accepts supervised doctors, so a doctor who needs
  // supervision is not limited to roles whose `accepts_supervised` box is
  // ticked. The field is still stored and shown to staff; it is simply no
  // longer a gate here (REASON.SUPERVISED_NOT_ACCEPTED is never produced).
  if (fit.registrar === true) {
    if (!fields.acceptsRegistrars) { reasons.push(REASON.REGISTRARS_NOT_ACCEPTED); fitFailed = true; }
  } else if (fit.vr !== true) {
    if (fields.vrRequirement !== 'non_vr_accepted') { reasons.push(REASON.VR_REQUIRED); fitFailed = true; }
  }
  // WP-29: a doctor whose right to work is tied to an employer is offered only
  // a role whose practice has said it offers sponsorship (the existing
  // career_roles.visa_pathway_aligned, "Visa sponsorship offered" on the
  // practice intake and the job editor). Not stated = not offered.
  if (fit.sponsorship === true && r.visa_pathway_aligned !== true) {
    reasons.push(REASON.SPONSORSHIP_NOT_OFFERED); fitFailed = true;
  }
  const eligible = reasons.length === 0;
  // 3. Launch
  const hold = shouldHoldSelfService(p);
  if (hold) reasons.push(REASON.PATHWAY_ON_HOLD);

  return {
    // A role that does not fit the doctor at all is not listed; a DPA-only
    // mismatch is listed blurred, as it always has been. A held doctor is shown
    // nothing.
    visible: !hold && !fitFailed,
    identifiable: !hold && eligible,
    canApply: !hold && eligible,
    eligible,
    hold,
    holdKind: hold ? (p.holdKind || (p.pathway === 'au_registrar' ? 'registrar' : 'review')) : null,
    reasons,
    legacyReason: reasons.indexOf(REASON.DPA_RESTRICTED) !== -1 ? REASON.DPA_RESTRICTED : ''
  };
}

/** The first reason as a sentence. `audience`: 'doctor' (default) or 'staff'. */
function eligibilityMessage(verdict, audience) {
  const v = verdict && typeof verdict === 'object' ? verdict : {};
  const list = Array.isArray(v.reasons) ? v.reasons : [];
  const map = audience === 'staff' ? STAFF_MESSAGE : DOCTOR_MESSAGE;
  if (audience !== 'staff' && list.indexOf(REASON.PATHWAY_ON_HOLD) !== -1) return v.holdKind === 'registrar' ? REGISTRAR_HOLD_MESSAGE : HOLD_MESSAGE;
  for (let i = 0; i < list.length; i++) if (map[list[i]]) return map[list[i]];
  return '';
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * WP-29. auIntroductionBlock: MAY STAFF PUT THIS AUSTRALIAN DOCTOR IN FRONT OF
 * THIS PRACTICE? The one rule for the "Submit to practice" step.
 *
 * What a doctor SEES may rest on their own answer (computeDpaRestricted). What
 * a PRACTICE is sent may not. So this asks only what staff have established:
 *
 *   1. the Ahpra register check must be complete (`facts.registerVerified`:
 *      gp_credentials.staff_verified_at), saved by a person or completed by
 *      the automatic register lookup when everything it read was clean;
 *   2. for a role that is not known to be in a DPA, the doctor's sorting
 *      (`pathwayResult.sorting`, lib/au-work-sorting.js) must say "anywhere"
 *      on the strength of the register or of staff, never of the doctor's own
 *      word alone:
 *        priority areas only (staff, register, or a person is needed) -> refused
 *        "anywhere", but only the doctor's own answer is on file      -> refused
 *                                                 until staff confirm 19AB
 *
 * Overseas doctors, the switch being off and an unreadable pathway are not
 * this function's business (the caller handles them): it answers null.
 *
 * @param {object} pathwayResult  a FULL resolver result (credentials read)
 * @param {object} role           the career_roles row
 * @param {{ registerVerified: boolean }} facts
 * @returns {null | { code: string, message: string }}
 * ════════════════════════════════════════════════════════════════════════════
 */
const INTRO_BLOCK = Object.freeze({
  REGISTER_NOT_VERIFIED: 'ahpra_check_not_verified',
  MORATORIUM_APPLIES: '19ab_applies_role_not_dpa',
  MORATORIUM_UNCONFIRMED: '19ab_not_confirmed',
  LOCATION_RESTRICTED: 'location_restricted_role_not_dpa',
  DETAILS_UNREADABLE: 'registration_details_unreadable'
});
const INTRO_BLOCK_MESSAGE = Object.freeze({
  ahpra_check_not_verified: "This doctor's Ahpra registration has not been checked yet, so nothing was sent to the practice. Open the candidate, complete the Ahpra register check and save it as verified, then submit again.",
  '19ab_applies_role_not_dpa': 'Staff have confirmed that the 19AB moratorium applies to this doctor, and this role is not in a Distribution Priority Area, so they cannot be introduced to this practice. Nothing was sent.',
  '19ab_not_confirmed': 'Staff have not confirmed whether the 19AB moratorium applies to this doctor (only the doctor\'s own answer is on file), and this role is not in a Distribution Priority Area. Confirm 19AB on the Ahpra register check, then submit again. Nothing was sent.',
  location_restricted_role_not_dpa: 'This doctor is limited to priority areas (DPA) and this role is not in a Distribution Priority Area, so they cannot be introduced to this practice. Nothing was sent. If you have evidence that 19AB does not apply, confirm it on the candidate and submit again.',
  registration_details_unreadable: "We could not read this doctor's registration details just now, so nothing was sent. Please try again in a moment."
});
// The same four, as the reason alone (for "this doctor cannot be put forward
// for this role yet: ...").
const INTRO_BLOCK_REASON = Object.freeze({
  ahpra_check_not_verified: "their Ahpra registration has not been checked and saved as verified yet.",
  '19ab_applies_role_not_dpa': 'staff have confirmed the 19AB moratorium applies to them and this role is not in a Distribution Priority Area.',
  '19ab_not_confirmed': 'staff have not confirmed whether the 19AB moratorium applies to them (it rests on the doctor\'s own answer) and this role is not in a Distribution Priority Area. Confirm 19AB on the candidate\'s Pathway card first.',
  location_restricted_role_not_dpa: 'they are limited to priority areas (DPA) and this role is not in a Distribution Priority Area.',
  registration_details_unreadable: 'their registration details could not be read just now. Please try again.'
});
function auIntroductionBlock(pathwayResult, role, facts) {
  const p = pathwayResult && typeof pathwayResult === 'object' ? pathwayResult : null;
  if (!p || p.isAu !== true || p.readFailed === true || p.schemaMissing === true) return null;
  const f = facts && typeof facts === 'object' ? facts : {};
  const block = function (code, extra) {
    return { code, message: INTRO_BLOCK_MESSAGE[code] + (extra ? ' ' + extra : ''), reason: INTRO_BLOCK_REASON[code] + (extra ? ' ' + extra : '') };
  };
  if (p.credentialsRead === false) return block(INTRO_BLOCK.DETAILS_UNREADABLE);
  if (f.registerVerified !== true) return block(INTRO_BLOCK.REGISTER_NOT_VERIFIED);
  // FR-9 (S9-08, finishing pass): a doctor the register lookup put on hold
  // (not found, a different name, not "Registered") is not introduced to ANY
  // practice, a DPA one included, until a person has checked: an earlier
  // automatic "verified" does not outweigh a later hold.
  if (p.sorting && typeof p.sorting === 'object' && p.sorting.onHold === true) return block(INTRO_BLOCK.REGISTER_NOT_VERIFIED);
  if (readRoleFields(role).dpaStatus !== 'yes') {
    const s = p.sorting && typeof p.sorting === 'object' ? p.sorting : null;
    if (p.staff19ab === 'applies') return block(INTRO_BLOCK.MORATORIUM_APPLIES);
    // The sorting rule says priority areas only (from the register, or
    // because a person is needed): not this role.
    if (!s || s.dpaOnly !== false) {
      if (s && s.basis !== 'self') return block(INTRO_BLOCK.LOCATION_RESTRICTED, s.dpaSentence || '');
      return block(INTRO_BLOCK.MORATORIUM_UNCONFIRMED);
    }
    // "Anywhere", but resting on something only the doctor has told us (their
    // 19AB answer, or being a citizen or permanent resident past the ten
    // years): not enough for a practice, whatever else the register showed
    // (FR-9 S9-03). Staff confirm 19AB first.
    if (s.restsOnDoctorsWord === true || s.basis === 'self') return block(INTRO_BLOCK.MORATORIUM_UNCONFIRMED);
  }
  return null;
}

/**
 * WP-29: what staff (and, in one honest line, the doctor) are shown on an
 * application to a role outside a DPA when the doctor's sorting does not
 * (yet) allow that location for a practice introduction. Null when there is
 * nothing to flag (a DPA role, an overseas doctor, "anywhere" on a staff or
 * register basis).
 * @returns {null | { code, staff: string, doctor: string, restricted: boolean }}
 */
const APPLICATION_FLAG_DOCTOR_LINE = 'We are checking this role fits your registration.';
function auApplicationLocationFlag(pathwayResult, role) {
  const p = pathwayResult && typeof pathwayResult === 'object' ? pathwayResult : null;
  if (!p || p.isAu !== true || p.readFailed === true || p.schemaMissing === true || p.credentialsRead === false) return null;
  if (readRoleFields(role).dpaStatus === 'yes') return null;
  const s = p.sorting && typeof p.sorting === 'object' ? p.sorting : null;
  if (p.staff19ab === 'applies') {
    return {
      code: INTRO_BLOCK.MORATORIUM_APPLIES, restricted: true,
      staff: 'Staff confirmed 19AB applies and this role is not in a DPA: this application cannot go to the practice. Talk to the doctor.',
      doctor: APPLICATION_FLAG_DOCTOR_LINE
    };
  }
  if (!s || s.dpaOnly !== false) {
    if (s && s.basis !== 'self') {
      return {
        code: INTRO_BLOCK.LOCATION_RESTRICTED, restricted: true,
        staff: 'This doctor is limited to priority areas (DPA) and this role is not in one. ' + (s.dpaSentence || '') + ' This application cannot go to the practice unless staff confirm 19AB does not apply.',
        doctor: APPLICATION_FLAG_DOCTOR_LINE
      };
    }
    return {
      code: INTRO_BLOCK.MORATORIUM_UNCONFIRMED, restricted: true,
      staff: '19AB not yet confirmed by staff: confirm before introducing to this practice.',
      doctor: APPLICATION_FLAG_DOCTOR_LINE
    };
  }
  if (s.restsOnDoctorsWord === true || s.basis === 'self') {
    return {
      code: INTRO_BLOCK.MORATORIUM_UNCONFIRMED, restricted: false,
      staff: '19AB not yet confirmed by staff: confirm before introducing to this practice.',
      doctor: APPLICATION_FLAG_DOCTOR_LINE
    };
  }
  return null;
}

/**
 * WP-29: reminders shown to staff in the "Submit to practice" confirmation.
 * They never block. Today there is one: a doctor whose registration is tied
 * to approved practice locations needs a new Board approval to move.
 * @returns {string[]}
 */
function auSubmitNotices(pathwayResult) {
  const s = pathwayResult && pathwayResult.sorting && typeof pathwayResult.sorting === 'object' ? pathwayResult.sorting : null;
  if (!s) return [];
  return (s.staffFlags || []).filter(function (f) { return f.code === 'approved_locations_only'; }).map(function (f) { return f.text; });
}

function staffEligibilityNotes(verdict) {
  const list = verdict && Array.isArray(verdict.reasons) ? verdict.reasons : [];
  return list.map(function (code) { return { code, message: STAFF_MESSAGE[code] || code }; });
}

/**
 * Clean the WP-08 fields from a job editor / intake body. Only keys present in
 * the body are returned. A wrong value is an error naming the field: nothing
 * is half-applied.
 *
 * @returns {{ ok: true, value: object, touched: boolean } | { ok: false, error: string }}
 */
function sanitiseRoleFieldsPatch(body) {
  const b = body && typeof body === 'object' ? body : {};
  const has = function (k) { return Object.prototype.hasOwnProperty.call(b, k); };
  const out = {};
  const blank = function (v) { return v == null || (typeof v === 'string' && v.trim() === ''); };

  if (has('vr_requirement')) {
    if (blank(b.vr_requirement)) out.vr_requirement = null;
    else if (VR_REQUIREMENTS.indexOf(token(b.vr_requirement)) === -1) return { ok: false, error: 'vr_requirement must be vr_required, vr_preferred or non_vr_accepted' };
    else out.vr_requirement = token(b.vr_requirement);
  }
  const bools = ['accepts_registrars', 'accepts_supervised'];
  for (let i = 0; i < bools.length; i++) {
    const k = bools[i];
    if (!has(k)) continue;
    if (blank(b[k])) out[k] = null;
    else if (b[k] === true || b[k] === 'true') out[k] = true;
    else if (b[k] === false || b[k] === 'false') out[k] = false;
    else return { ok: false, error: k + ' must be true, false or blank' };
  }
  if (has('engagement_type')) {
    if (blank(b.engagement_type)) out.engagement_type = null;
    else if (ENGAGEMENT_TYPES.indexOf(token(b.engagement_type)) === -1) return { ok: false, error: 'engagement_type must be permanent or contract' };
    else out.engagement_type = token(b.engagement_type);
  }
  const nums = ['sessions_min', 'sessions_max'];
  for (let i = 0; i < nums.length; i++) {
    const k = nums[i];
    if (!has(k)) continue;
    if (blank(b[k])) { out[k] = null; continue; }
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n < 0 || n > 14 || Math.round(n * 2) !== n * 2) return { ok: false, error: k + ' must be a number of sessions a week from 0 to 14 (halves allowed)' };
    out[k] = n;
  }
  if (out.sessions_min != null && out.sessions_max != null && out.sessions_min > out.sessions_max) {
    return { ok: false, error: 'sessions_min cannot be more than sessions_max' };
  }
  if (has('special_interests')) {
    let list = b.special_interests;
    if (blank(list)) list = [];
    if (typeof list === 'string') list = list.split(',');
    if (!Array.isArray(list)) return { ok: false, error: 'special_interests must be a list' };
    const seen = {};
    const clean = [];
    for (let i = 0; i < list.length; i++) {
      if (typeof list[i] !== 'string') return { ok: false, error: 'special_interests must be a list of words' };
      const item = list[i].replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
      if (!item || seen[item.toLowerCase()]) continue;
      seen[item.toLowerCase()] = true;
      clean.push(item);
    }
    if (clean.length > MAX_SPECIAL_INTERESTS) return { ok: false, error: 'special_interests can hold at most ' + MAX_SPECIAL_INTERESTS + ' items' };
    out.special_interests = clean;
  }
  if (has('dpa_status')) {
    if (blank(b.dpa_status)) out.dpa_status = null;
    else if (DPA_STATUSES.indexOf(token(b.dpa_status)) === -1) return { ok: false, error: 'dpa_status must be yes, no or unknown' };
    else out.dpa_status = token(b.dpa_status);
  }
  return { ok: true, value: out, touched: Object.keys(out).length > 0 };
}

/** What the job editor shows for the WP-08 fields (stored values, not defaults). */
function roleFieldsEditorView(role) {
  const r = role && typeof role === 'object' ? role : {};
  const f = readRoleFields(r);
  return {
    vr_requirement: f.vrRequirementStored || '',
    accepts_registrars: typeof r.accepts_registrars === 'boolean' ? r.accepts_registrars : null,
    accepts_supervised: typeof r.accepts_supervised === 'boolean' ? r.accepts_supervised : null,
    engagement_type: f.engagementType || '',
    sessions_min: f.sessionsMin,
    sessions_max: f.sessionsMax,
    special_interests: f.specialInterests,
    dpa_status: f.dpaStatusStored || '',
    effective: { vr_requirement: f.vrRequirement, dpa_status: f.dpaStatus, billing_model: f.billingModel, mmm: f.mmm, area: areaFromRole(r) }
  };
}

/**
 * APP-19 (data only): the facts an Australian doctor's job page should show.
 * No dollar figure, no percentage, nothing about sponsorship or where a doctor
 * trained. WP-12 / WP-22 render it. After-hours and restraint radius are not
 * stored anywhere yet, so they are null.
 */
function publicRoleFacts(role) {
  const r = role && typeof role === 'object' ? role : {};
  const f = readRoleFields(r);
  return {
    billingModel: f.billingModel || null,
    vrRequirement: f.vrRequirement,
    vrRequirementStated: f.vrRequirementStored != null,
    acceptsRegistrars: f.acceptsRegistrars,
    acceptsSupervised: f.acceptsSupervised,
    engagementType: f.engagementType,
    sessionsMin: f.sessionsMin,
    sessionsMax: f.sessionsMax,
    specialInterests: f.specialInterests,
    mmm: f.mmm,
    area: areaFromRole(r) || null,
    dpa: f.dpaStatus,
    afterHours: null,
    restraintRadiusKm: null
  };
}

// ── distance sort (DAT-11) ───────────────────────────────────────────────────

function haversineKm(lat1, lon1, lat2, lon2) {
  const vals = [lat1, lon1, lat2, lon2].map(Number);
  if (vals.some(function (v) { return !Number.isFinite(v); })) return null;
  const toRad = function (d) { return d * Math.PI / 180; };
  const dLat = toRad(vals[2] - vals[0]);
  const dLon = toRad(vals[3] - vals[1]);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRad(vals[0])) * Math.cos(toRad(vals[2])) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function validCoords(lat, lng) {
  if (lat == null || lng == null || lat === '' || lng === '') return false;
  const a = Number(lat); const b = Number(lng);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0);
}

/**
 * Order roles for an Australian doctor: nearest first.
 *
 *   Doctor has home coordinates and the role's practice has coordinates
 *     -> by distance. Roles inside the doctor's commute radius come first.
 *   Otherwise (no coordinates on one side)
 *     -> same suburb, then same state, then everything else.
 *   Ties: newest first, then the order given (stable), as today's ranking.
 *
 * `opts.getCoords(row)` returns `{ latitude, longitude }` for a row or null.
 * `opts.getRow(item)` maps a list item to the row that carries suburb / state /
 * dates (default: the item itself). Returns `[{ item, distanceKm, withinCommute }]`.
 */
function rankRolesByDistance(items, opts) {
  const o = opts || {};
  const list = Array.isArray(items) ? items : [];
  const home = o.home && typeof o.home === 'object' ? o.home : {};
  const hasHome = validCoords(home.latitude, home.longitude);
  const radius = Number(home.commuteRadiusKm);
  const homeSuburb = token(home.suburb);
  const homeState = token(home.state);
  const getRow = typeof o.getRow === 'function' ? o.getRow : function (x) { return x; };
  const getCoords = typeof o.getCoords === 'function' ? o.getCoords : function () { return null; };

  const scored = list.map(function (item, index) {
    const row = getRow(item) || {};
    const c = getCoords(row, item);
    let distanceKm = null;
    if (hasHome && c && validCoords(c.latitude, c.longitude)) {
      distanceKm = haversineKm(home.latitude, home.longitude, c.latitude, c.longitude);
    }
    const suburb = token(row.suburb || row.location_city);
    const state = token(row.location_state || row.state);
    let tier = 2;
    if (homeSuburb && suburb && suburb === homeSuburb && (!homeState || !state || state === homeState)) tier = 0;
    else if (homeState && state && state === homeState) tier = 1;
    const withinCommute = distanceKm != null && Number.isFinite(radius) && radius > 0 ? distanceKm <= radius : null;
    return { item, index, distanceKm, withinCommute, tier, ts: String(row.published_at || row.created_at || '') };
  });

  scored.sort(function (a, b) {
    const aHas = a.distanceKm != null; const bHas = b.distanceKm != null;
    if (aHas && bHas) {
      if (a.withinCommute !== b.withinCommute && a.withinCommute != null && b.withinCommute != null) return a.withinCommute ? -1 : 1;
      if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
    } else if (aHas !== bHas) {
      // A measured role against an unmeasured one: compare on the fallback
      // tiers, and prefer the measured one inside a tier.
      if (a.tier !== b.tier) return a.tier - b.tier;
      return aHas ? -1 : 1;
    } else if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
    return a.index - b.index;
  });

  return scored.map(function (s) {
    return { item: s.item, distanceKm: s.distanceKm == null ? null : Math.round(s.distanceKm * 10) / 10, withinCommute: s.withinCommute };
  });
}

// ── tags (COM-24, COM-25) ────────────────────────────────────────────────────

/**
 * Which place / fit tags a doctor may be shown for a role. Overseas doctors:
 * the list is returned untouched. Australian: the "Visa pathway aligned" tag
 * is hidden for segments A and C, the "DPA approved" tag for segment A
 * (it means nothing to a doctor who is not limited to DPA roles), and any tag
 * carrying a word an Australian doctor must never be shown is dropped.
 */
const AU_FORBIDDEN_WORDS = /\b(myintealth|amc|epic|visa|relocat\w*|your move|overseas|internationally trained|gmc|sppa|section g|supervisor cv|not yet eligible)\b/i;
function filterTagsForPathway(tags, pathwayResult) {
  const list = Array.isArray(tags) ? tags : [];
  const p = pathwayResult && typeof pathwayResult === 'object' ? pathwayResult : null;
  if (!p || p.isAu !== true) return list;
  const seg = String(p.segment || '');
  return list.filter(function (t) {
    const s = String(t || '');
    const isVisa = /visa/i.test(s);
    const isDpa = /\bdpa\b/i.test(s);
    if (isVisa && seg !== 'B') return false;
    if (isDpa && seg === 'A') return false;
    if (!isVisa && AU_FORBIDDEN_WORDS.test(s)) return false;
    return true;
  });
}

// ── re-entry (APP-22) ────────────────────────────────────────────────────────

const ENDED_PLACEMENT_STATUSES = Object.freeze(['ended', 'completed', 'complete', 'cancelled', 'canceled', 'terminated', 'withdrawn', 'inactive']);
const COMMENCED_CASE_STAGES = Object.freeze(['commenced', 'guarantee', 'complete']);

/**
 * May a previously placed AUSTRALIAN doctor look for work again?
 * Yes once every placement on record has either started or ended.
 *
 *   A placement has started  when `commenced_at` is set (WP-13 adds the column;
 *                            a row without it simply has no value), or, until
 *                            then, when staff moved the doctor's case to
 *                            `commenced` / `guarantee` / `complete`.
 *   A placement has ended    when `ended_at` is set (WP-13), or its status is
 *                            one of ENDED_PLACEMENT_STATUSES.
 *
 * No placement row at all (a placement recorded only on the application): the
 * case stage alone decides. Nothing readable: no re-entry (fail closed).
 * Overseas doctors never reach this: their rule is unchanged.
 */
function auReentryAllowed(input) {
  const i = input && typeof input === 'object' ? input : {};
  const rows = Array.isArray(i.placements) ? i.placements.filter(Boolean) : [];
  const stage = token(i.caseStage);
  const caseCommenced = COMMENCED_CASE_STAGES.indexOf(stage) !== -1;
  if (i.readFailed === true) return { allowed: false, basis: 'unreadable' };
  if (!rows.length) return { allowed: caseCommenced, basis: caseCommenced ? 'case_stage' : 'not_started' };
  let basis = '';
  const open = rows.filter(function (row) {
    if (row.ended_at) { basis = basis || 'ended_at'; return false; }
    if (ENDED_PLACEMENT_STATUSES.indexOf(token(row.status)) !== -1) { basis = basis || 'status_ended'; return false; }
    if (row.commenced_at) { basis = basis || 'commenced_at'; return false; }
    return true;
  });
  if (!open.length) return { allowed: true, basis: basis || 'ended' };
  // An open placement with no start recorded on the row: the case stage is the
  // only "started" signal that exists before WP-13.
  if (caseCommenced) return { allowed: true, basis: 'case_stage' };
  return { allowed: false, basis: 'not_started' };
}

// ── availability (COM-13) ────────────────────────────────────────────────────

/**
 * When could an Australian doctor start? From their own answers, never from an
 * arrival date (they are already here).
 *
 *   available_from and a notice period -> the later of the two
 *   only a notice period               -> today + that many weeks
 *   only available_from                -> that date (today if it has passed)
 *   neither                            -> '' (unknown: the caller shows nothing)
 *
 * @param {{ available_from?: string, notice_period_weeks?: number }} prefs
 * @param {Date|number|string} [now]
 * @returns {{ iso: string, basis: 'available_from'|'notice_period'|'both'|'none' }}
 */
function auEarliestStart(prefs, now, opts) {
  const p = prefs && typeof prefs === 'object' ? prefs : {};
  const nowDate = now == null ? new Date() : new Date(now);
  const nowMs = Number.isNaN(nowDate.getTime()) ? Date.now() : nowDate.getTime();
  // FB-2a (R13): "today" is today's calendar date on the Australian clock
  // (`opts.today`, or today in `opts.zone`, Sydney when not known), and the
  // notice period is counted in days on dates. It was the UTC date, so for most
  // of the Australian morning a doctor's earliest start was a day early.
  const todayIso = auFees.cleanDay(opts && opts.today) || auLifecycleLib.localDay(nowMs, (opts && opts.zone) || auLifecycleLib.FALLBACK_ZONE);
  const rawFrom = String(p.available_from == null ? '' : p.available_from).slice(0, 10);
  const from = auFees.cleanDay(rawFrom);
  const weeksRaw = p.notice_period_weeks;
  const weeks = (weeksRaw === null || weeksRaw === undefined || weeksRaw === '') ? null : Number(weeksRaw);
  const hasNotice = weeks != null && Number.isFinite(weeks) && weeks >= 0 && weeks <= 104;
  const afterNotice = hasNotice ? auFees.addDays(todayIso, Math.round(weeks * 7)) : '';
  if (!from && !hasNotice) return { iso: '', basis: 'none' };
  if (from && hasNotice) return { iso: from > afterNotice ? from : afterNotice, basis: 'both' };
  if (hasNotice) return { iso: afterNotice, basis: 'notice_period' };
  return { iso: from > todayIso ? from : todayIso, basis: 'available_from' };
}

module.exports = {
  auEarliestStart,
  VR_REQUIREMENTS,
  DEFAULT_VR_REQUIREMENT,
  ENGAGEMENT_TYPES,
  DPA_STATUSES,
  BILLING_MODELS,
  REASON,
  HOLD_MESSAGE,
  HOLD_TITLE,
  REGISTRAR_HOLD_TITLE,
  REGISTRAR_HOLD_MESSAGE,
  holdViewFor,
  auIntroductionBlock,
  auApplicationLocationFlag,
  auSubmitNotices,
  INTRO_BLOCK,
  INTRO_BLOCK_MESSAGE,
  APPLICATION_FLAG_DOCTOR_LINE,
  DOCTOR_MESSAGE,
  STAFF_MESSAGE,
  normaliseBillingModel,
  roleDpaStatus,
  readRoleFields,
  areaFromRole,
  shouldHoldSelfService,
  roleEligibilityFor,
  eligibilityMessage,
  staffEligibilityNotes,
  sanitiseRoleFieldsPatch,
  roleFieldsEditorView,
  publicRoleFacts,
  haversineKm,
  rankRolesByDistance,
  filterTagsForPathway,
  AU_FORBIDDEN_WORDS,
  auReentryAllowed,
  ENDED_PLACEMENT_STATUSES,
  COMMENCED_CASE_STAGES
};

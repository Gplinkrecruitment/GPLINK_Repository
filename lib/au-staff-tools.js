'use strict';

/**
 * Australian GP build, WP-06: the staff tools. Pure, no I/O, no switch.
 *
 *   - "Add candidate": what staff may send, cleaned and checked
 *   - the Ahpra register check: what staff record, the task that asks for it,
 *     when it is due again, and what the doctor is told (N06)
 *   - the "decide the segment" task (N07)
 *   - the pathway chip and filter on the candidate list
 *
 * The server side (server.js, search "WP-06") does the reading and writing and
 * decides who may call what. The pathway rule itself is NOT here: it is
 * candidatePathway.derivePathwayFromRegisterCheck, which asks the one
 * onboarding rule.
 *
 * Copy rule (AGENT-RULES section 4): every string in this file that a doctor
 * on an Australian pathway can be sent is scanned by
 * tests/au-wp06-staff-tools-lib.test.js for the words they must never see.
 * The regulator is written "Ahpra".
 */

const candidatePathway = require('./candidate-pathway.js');
const gpCredentialsLib = require('./gp-credentials.js');
const auLifecycle = require('./au-lifecycle.js');
const fees = require('./au-placement-fees.js');

const TASK_TYPE = Object.freeze({
  AHPRA_REGISTER_CHECK: 'ahpra_register_check',
  SEGMENT_REVIEW: 'segment_review'
});

// Every task type the WP-06 migration adds to registration_tasks_task_type_check.
// Only the first two have behaviour today. The rest are allowed by the database
// already so WP-11 / WP-13 need no further constraint change.
const AU_NEW_TASK_TYPES = Object.freeze([
  'ahpra_register_check', 'segment_review',
  'dpa_19ab_check', 'reference_check', 'restraint_check', 'start_date_tracking',
  'provider_number_new_location', 'credentialing_pack', 'invoice_due',
  'indemnity_certificate', 'guarantee_checkin'
]);

// The public register search page. Staff open it and check by hand. Nothing in
// this build requests it: the register blocks automated traffic, and scraping
// it is out of scope by decision (DAT-08).
const AHPRA_PUBLIC_REGISTER_URL = 'https://www.ahpra.gov.au/Registration/Registers-of-Practitioners.aspx';

const CHECK_OUTCOME = Object.freeze({ VERIFIED: 'verified', NOT_MATCHED: 'not_matched', PENDING: 'pending' });
const CHECK_OUTCOMES = Object.freeze(['verified', 'not_matched', 'pending']);

// Why a check task was opened.
const CHECK_REASON = Object.freeze({
  ONBOARDING_COMPLETED: 'onboarding_completed',
  STAFF_CREATED: 'staff_created',
  PATHWAY_SET: 'pathway_set',
  NUMBER_CHANGED: 'number_changed',
  ANNUAL_RECHECK: 'annual_recheck',
  EXPIRY_SOON: 'expiry_soon',
  // WP-12: the doctor changed a registration fact in Account.
  DETAILS_CHANGED: 'details_changed'
});

// The due-date rule, in days from the day the task is opened.
//   a new doctor (signed up, added by staff, or changed their number): 2 days
//   the yearly re-check, or registration about to expire: 14 days
const CHECK_DUE_DAYS = Object.freeze({
  onboarding_completed: 2,
  staff_created: 2,
  pathway_set: 2,
  number_changed: 2,
  annual_recheck: 14,
  expiry_soon: 14
});
const RECHECK_AFTER_DAYS = 365;      // last checked more than 12 months ago
const EXPIRY_WARNING_DAYS = 60;      // registration expires within 60 days
const INVITE_LINK_HOURS = 72;        // how long the set-password link works

const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
function nowMsOf(now) {
  const t = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.parse(now || ''));
  return Number.isFinite(t) ? t : Date.now();
}

function cleanLine(value, max) {
  if (typeof value !== 'string') return '';
  // Tabs, new lines and every other control character become a space.
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    out += (code < 32 || code === 127) ? ' ' : value[i];
  }
  return out.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanBlock(value, max) {
  if (typeof value !== 'string') return '';
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    out += ((code < 32 && code !== 10) || code === 127) ? ' ' : value[i];
  }
  return out.replace(/[<>]/g, '').trim().slice(0, max);
}

function normaliseAhpraNumber(value) {
  return String(value == null ? '' : value).replace(/[\s-]+/g, '').toUpperCase();
}
function isAhpraNumber(value) { return /^[A-Z]{3}\d{10}$/.test(normaliseAhpraNumber(value)); }

/**
 * Clean and check what staff send to "Add candidate" (POST /api/ats/candidate).
 * Nothing is defaulted silently except the consultant, which the server sets to
 * the staff member creating the candidate.
 *
 * @param {object} body  { first_name, last_name, email, phone?, pathway,
 *                         ahpra_number?, state?, notes?, consultant? }
 * @returns {{ ok: boolean, errors: object, clean: object|null }}
 */
function validateCreateCandidateInput(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = {};
  const firstName = cleanLine(b.first_name, 80);
  const lastName = cleanLine(b.last_name, 80);
  if (!firstName) errors.first_name = 'Enter the doctor\'s first name.';
  if (!lastName) errors.last_name = 'Enter the doctor\'s last name.';

  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';

  let phone = '';
  if (b.phone !== undefined && b.phone !== null && String(b.phone).trim() !== '') {
    phone = cleanLine(String(b.phone), 30);
    const digits = phone.replace(/\D+/g, '');
    if (!/^\+?[\d\s()-]+$/.test(phone) || digits.length < 8 || digits.length > 15) errors.phone = 'Enter a phone number with 8 to 15 digits, or leave it blank.';
  }

  const pathwayRaw = typeof b.pathway === 'string' ? b.pathway.trim().toLowerCase() : '';
  if (!candidatePathway.isValidPathway(pathwayRaw)) errors.pathway = 'Choose a pathway.';
  const isAu = candidatePathway.isAuPathway(pathwayRaw);

  let ahpraNumber = '';
  if (b.ahpra_number !== undefined && b.ahpra_number !== null && String(b.ahpra_number).trim() !== '') {
    if (!errors.pathway && !isAu) errors.ahpra_number = 'An Ahpra number can only be recorded for a doctor on an Australian pathway.';
    else if (!isAhpraNumber(b.ahpra_number)) errors.ahpra_number = 'An Ahpra number is three letters and ten digits, for example MED0001234567.';
    else ahpraNumber = normaliseAhpraNumber(b.ahpra_number);
  }

  let state = '';
  if (b.state !== undefined && b.state !== null && String(b.state).trim() !== '') {
    state = String(b.state).trim().toUpperCase();
    if (gpCredentialsLib.AU_STATES.indexOf(state) === -1) errors.state = 'Choose an Australian state or territory.';
    else if (!errors.pathway && !isAu) errors.state = 'A state can only be recorded for a doctor on an Australian pathway.';
  }

  const notes = cleanBlock(b.notes, 1000);
  let consultant = '';
  if (b.consultant !== undefined && b.consultant !== null && String(b.consultant).trim() !== '') {
    consultant = String(b.consultant).trim().toLowerCase();
    if (consultant.length > 254 || !EMAIL_RE.test(consultant)) errors.consultant = 'Choose a consultant.';
  }

  if (Object.keys(errors).length) return { ok: false, errors, clean: null };
  return {
    ok: true,
    errors: {},
    clean: { firstName, lastName, email, phone, pathway: pathwayRaw, isAu, ahpraNumber, state, notes, consultant }
  };
}

function asBool(v) { return v === true || v === false ? v : null; }

/**
 * Clean and check what staff record from the public Ahpra register
 * (POST /api/ats/candidate/register-verification, action 'ahpra_check').
 *
 *   outcome 'verified'     the register entry matches this doctor. Registration
 *                          type, the specialist-GP flag, the three flags
 *                          (conditions, undertakings, notations), the expiry
 *                          date and a deliberate staff 19AB answer (yes, no, or
 *                          'unconfirmed' = not confirmed yet) are all required; a flag answered "yes" needs its text; an
 *                          expiry date that has passed is refused (FR-1, R-05).
 *   outcome 'not_matched'  the number could not be matched to this doctor.
 *                          Nothing else is required and nothing about the
 *                          registration is recorded.
 *   outcome 'pending'      save what has been found so far; the check stays open.
 *
 * @returns {{ ok: boolean, errors: object, outcome: string, number: string,
 *   credentialsPatch: object, moratoriumConfirmed: 'yes'|'no'|null|undefined, note: string }}
 *   credentialsPatch uses gp_credentials column names and still goes through
 *   sanitiseCredentialsPatch (the server refuses the save if it rejects a key).
 */
function validateAhpraCheckInput(body, opts) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const o = opts && typeof opts === 'object' ? opts : {};
  // FR-1 (R-05): today's calendar date (YYYY-MM-DD), for the expiry test. The
  // caller passes it (lib code reads no clock for a calendar date).
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(o.today || '')) ? String(o.today) : '';
  const errors = {};
  const has = function (k) { return Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined; };
  const outcome = typeof b.outcome === 'string' ? b.outcome.trim().toLowerCase() : '';
  if (CHECK_OUTCOMES.indexOf(outcome) === -1) errors.outcome = 'Choose an outcome: verified, number not matched, or still pending.';
  const verified = outcome === CHECK_OUTCOME.VERIFIED;
  const patch = {};

  let number = '';
  if (has('ahpra_number') && b.ahpra_number !== null && String(b.ahpra_number).trim() !== '') {
    if (!isAhpraNumber(b.ahpra_number)) errors.ahpra_number = 'An Ahpra number is three letters and ten digits, for example MED0001234567.';
    else number = normaliseAhpraNumber(b.ahpra_number);
  }

  const note = cleanBlock(b.note, 1000);
  if (outcome === CHECK_OUTCOME.NOT_MATCHED) {
    return { ok: Object.keys(errors).length === 0, errors, outcome, number, credentialsPatch: {}, moratoriumConfirmed: undefined, note };
  }

  // Registration type.
  if (has('registration_type') && b.registration_type !== null && b.registration_type !== '') {
    const t = String(b.registration_type).trim().toLowerCase();
    if (gpCredentialsLib.AHPRA_REGISTRATION_TYPES.indexOf(t) === -1) errors.registration_type = 'Choose the registration type shown on the register.';
    else patch.ahpra_registration_type = t;
  } else if (verified) errors.registration_type = 'Choose the registration type shown on the register.';

  // On the specialist register as a GP.
  if (has('specialist_gp') && b.specialist_gp !== null) {
    if (asBool(b.specialist_gp) === null) errors.specialist_gp = 'Answer yes or no.';
    else patch.specialist_gp = b.specialist_gp;
  } else if (verified) errors.specialist_gp = 'Say whether the doctor is on the specialist register as a GP.';

  // Conditions, undertakings, notations: a flag and its text.
  [['has_conditions', 'conditions_text', 'conditions'],
    ['has_undertakings', 'undertakings_text', 'undertakings'],
    ['has_notations', 'notations_text', 'notations']].forEach(function (row) {
    const flagKey = row[0]; const textKey = row[1]; const word = row[2];
    const text = cleanBlock(b[textKey], 4000);
    if (has(flagKey) && b[flagKey] !== null) {
      if (asBool(b[flagKey]) === null) { errors[flagKey] = 'Answer yes or no.'; return; }
      patch[flagKey] = b[flagKey];
      if (b[flagKey] === true) {
        if (!text && verified) errors[textKey] = 'Copy the ' + word + ' from the register.';
        else if (text) patch[textKey] = text;
      } else {
        patch[textKey] = null;
      }
    } else if (verified) {
      errors[flagKey] = 'Say whether the register shows any ' + word + '.';
    }
  });

  // Expiry.
  if (has('registration_expiry') && b.registration_expiry !== null && b.registration_expiry !== '') {
    const d = String(b.registration_expiry).trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    const dt = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
    if (!dt || dt.getUTCDate() !== Number(m[3]) || dt.getUTCMonth() !== Number(m[2]) - 1) errors.registration_expiry = 'Enter the expiry date shown on the register.';
    else if (verified && !today) errors.registration_expiry = 'The expiry date could not be checked against today\'s date. Nothing was saved. Please try again.';
    else if (verified && d < today) {
      // R-05: a registration that has expired is not "verified". Staff are told why.
      errors.registration_expiry = 'That expiry date (' + d + ') has passed, so this registration cannot be saved as verified. '
        + 'Check the date on the register. If the registration really has expired, use "Save progress" and tell the doctor; do not verify it.';
    } else patch.registration_expiry = d;
  } else if (verified) errors.registration_expiry = 'Enter the expiry date shown on the register.';

  // Optional: what staff can see about fellowship and right to work.
  if (has('fellowship_type') && b.fellowship_type !== null && b.fellowship_type !== '') {
    const f = String(b.fellowship_type).trim().toLowerCase();
    if (gpCredentialsLib.FELLOWSHIP_TYPES.indexOf(f) === -1) errors.fellowship_type = 'Choose a fellowship from the list.';
    else patch.fellowship_type = f;
  }
  if (has('work_rights') && b.work_rights !== null && b.work_rights !== '') {
    const w = String(b.work_rights).trim().toLowerCase();
    if (gpCredentialsLib.WORK_RIGHTS.indexOf(w) === -1) errors.work_rights = 'Choose a right to work from the list.';
    else patch.work_rights = w;
  }

  // FR-2 (S2-05): the supervision the register shows ("none" is an answer).
  if (has('supervision_level') && b.supervision_level !== null && b.supervision_level !== '') {
    const sl = String(b.supervision_level).trim().toLowerCase();
    if (gpCredentialsLib.SUPERVISION_LEVELS.indexOf(sl) === -1) errors.supervision_level = 'Choose the supervision the register shows, or "None".';
    else patch.supervision_level = sl;
  }

  // 19AB: only an explicit yes or no is a confirmation. null clears one.
  let moratoriumConfirmed;
  let moratoriumAnswered = false;
  if (has('moratorium_19ab_confirmed')) {
    const raw = b.moratorium_19ab_confirmed;
    let v = raw === null || raw === '' ? null : String(raw).trim().toLowerCase();
    // 'unconfirmed' is the explicit staff answer "not confirmed yet": it is
    // stored as no confirmation. WP-29: what the doctor SEES then follows the
    // register lookup or their own answer; they cannot be introduced to a
    // practice outside a DPA until staff confirm.
    if (v === 'unconfirmed') { v = null; moratoriumAnswered = true; }
    if (v !== null && v !== 'yes' && v !== 'no') errors.moratorium_19ab_confirmed = 'Answer yes, no, or not confirmed yet.';
    else { moratoriumConfirmed = v; if (v !== null) moratoriumAnswered = true; }
  }
  // R-05: a check saved as VERIFIED carries a deliberate staff answer on
  // section 19AB: applies, does not apply, or "not confirmed yet" (which keeps
  // the doctor limited to DPA roles: fail closed). A blank is not an answer.
  if (verified && !errors.moratorium_19ab_confirmed && !moratoriumAnswered) {
    errors.moratorium_19ab_confirmed = 'Choose the section 19AB answer before saving as verified: applies, does not apply, or not confirmed yet.';
  }
  // FR-9 (smaller row, finishing pass): "19AB does not apply" opens practice
  // introductions outside a DPA, so it needs its reason here too (the Pathway
  // card's 19AB answer already does).
  if (moratoriumConfirmed === 'no' && String(note || '').trim().length < 5) {
    errors.note = 'Say why 19AB does not apply to this doctor in the note (for example the exemption letter you saw, or that they trained in Australia as a citizen). Nothing was saved.';
  }
  if (has('moratorium_19ab_end_date') && b.moratorium_19ab_end_date !== null && b.moratorium_19ab_end_date !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.moratorium_19ab_end_date).trim())) errors.moratorium_19ab_end_date = 'Enter the date as YYYY-MM-DD.';
    else patch.moratorium_19ab_end_date = String(b.moratorium_19ab_end_date).trim();
  }

  return { ok: Object.keys(errors).length === 0, errors, outcome, number, credentialsPatch: patch, moratoriumConfirmed, note };
}

/**
 * FR-2 (S2-05, R2-02). What a check must carry before it can end in a
 * CONFIRMED VR GP (segment A), beyond validateAhpraCheckInput: the three
 * things staff never had to enter (fellowship, right to work, supervision),
 * each chosen in THIS check. Pure.
 * @returns {object} field -> sentence ({} when nothing is missing)
 */
function confirmedVrMissing(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const given = function (k) { return b[k] !== undefined && b[k] !== null && String(b[k]).trim() !== ''; };
  const errors = {};
  if (!given('fellowship_type')) errors.fellowship_type = 'Choose the fellowship before confirming a VR GP.';
  if (!given('work_rights')) errors.work_rights = 'Choose the right to work before confirming a VR GP.';
  if (!given('supervision_level')) errors.supervision_level = 'Say what supervision the register shows ("None" is an answer) before confirming a VR GP.';
  return errors;
}

/** The small summary of a doctor's own answers kept for staff to compare. Pure. */
function selfAnswerSummary(credentialsPatch, derivation) {
  const c = credentialsPatch && typeof credentialsPatch === 'object' ? credentialsPatch : {};
  const d = derivation && typeof derivation === 'object' ? derivation : {};
  const out = { pathway: d.pathway || null, segment: d.segment || null, reasons: Array.isArray(d.reasons) ? d.reasons.slice(0, 12) : [], answers: {} };
  ['ahpra_registration_type', 'fellowship_type', 'has_conditions', 'work_rights', 'moratorium_19ab_status', 'supervision_level', 'specialist_gp'].forEach(function (k) {
    if (Object.prototype.hasOwnProperty.call(c, k) && c[k] !== undefined && typeof c[k] !== 'object') out.answers[k] = typeof c[k] === 'string' ? cleanLine(c[k], 60) : c[k];
  });
  return out;
}

/** The day a check task is due, as YYYY-MM-DD. */
function ahpraCheckDueDate(reason, now) {
  const days = Object.prototype.hasOwnProperty.call(CHECK_DUE_DAYS, reason) ? CHECK_DUE_DAYS[reason] : 2;
  return isoDay(nowMsOf(now) + days * DAY_MS);
}

/**
 * Is this doctor's Ahpra check due again (DAT-08)? True when staff last
 * checked more than 12 months ago, or the registration expires within 60 days
 * (or has already expired). A doctor staff have never checked is NOT due here:
 * their first check task was opened when they signed up or were added.
 *
 * @param {object|null} credentials  gp_credentials row
 * @param {Date|string|number} [now]
 * @returns {{ due: boolean, reason: string|null, daysSinceCheck: number|null, daysToExpiry: number|null }}
 */
function ahpraRecheckDue(credentials, now, opts) {
  const c = credentials && typeof credentials === 'object' ? credentials : null;
  const out = { due: false, reason: null, daysSinceCheck: null, daysToExpiry: null };
  if (!c) return out;
  // FB-2a (R13): the expiry date is a calendar date, so the 60-day window and
  // "has it expired" are counted on dates, with "today" on the Australian
  // clock (`opts.today`, or today in `opts.zone`, Sydney when not known). It
  // used to be milliseconds from the UTC midnight of the expiry date, which
  // opened the window (and called a registration expired) up to a day late or
  // early depending on the hour the job ran.
  const nowMs = nowMsOf(now);
  const zone = (opts && opts.zone) || auLifecycle.FALLBACK_ZONE;
  const today = fees.cleanDay(opts && opts.today) || auLifecycle.localDay(nowMs, zone);
  const checkedMs = Date.parse(c.ahpra_last_checked_at || '');
  const checkedDay = Number.isFinite(checkedMs) ? auLifecycle.localDay(checkedMs, zone) : '';
  if (checkedDay) out.daysSinceCheck = fees.daysBetween(checkedDay, today);
  const expiry = fees.cleanDay(typeof c.registration_expiry === 'string' ? c.registration_expiry.slice(0, 10) : '');
  if (expiry) out.daysToExpiry = fees.daysBetween(today, expiry);
  if (!checkedDay) return out;
  // Expiry first: it is the more urgent reason and the one staff must act on.
  if (out.daysToExpiry !== null && out.daysToExpiry <= EXPIRY_WARNING_DAYS) {
    // One reminder when the 60-day window opens, and one more once the date
    // has passed. A check staff already did inside that window (or after the
    // expiry) is not asked for again the next day.
    const expired = today >= expiry;
    const seenSince = expired ? expiry : fees.addDays(expiry, -EXPIRY_WARNING_DAYS);
    if (checkedDay < seenSince) { out.due = true; out.reason = CHECK_REASON.EXPIRY_SOON; return out; }
  }
  if (out.daysSinceCheck > RECHECK_AFTER_DAYS) { out.due = true; out.reason = CHECK_REASON.ANNUAL_RECHECK; }
  return out;
}

const CHECK_REASON_TEXT = Object.freeze({
  onboarding_completed: 'The doctor finished onboarding and says they hold Ahpra registration.',
  staff_created: 'This candidate was added by staff.',
  pathway_set: 'Staff put this doctor on an Australian pathway.',
  number_changed: 'The Ahpra number on file was changed.',
  annual_recheck: 'It is more than 12 months since this registration was last checked.',
  expiry_soon: 'This registration expires within 60 days (or has expired).',
  details_changed: 'The doctor changed their registration details in Account (number, registration type, fellowship or right to work). The pathway on record has not been changed.'
});

/**
 * The staff task "check this doctor on the public Ahpra register".
 * @returns {object} fields for _createRegTask
 */
function buildAhpraCheckTask(input) {
  const i = input && typeof input === 'object' ? input : {};
  const reason = Object.prototype.hasOwnProperty.call(CHECK_REASON_TEXT, i.reason) ? i.reason : CHECK_REASON.ONBOARDING_COMPLETED;
  const name = cleanLine(String(i.name || ''), 160) || 'this doctor';
  const recheck = reason === CHECK_REASON.ANNUAL_RECHECK || reason === CHECK_REASON.EXPIRY_SOON;
  return {
    task_type: TASK_TYPE.AHPRA_REGISTER_CHECK,
    status: 'open',
    title: (recheck ? 'Re-check Ahpra registration: ' : 'Check Ahpra registration on the public register: ') + name,
    description: CHECK_REASON_TEXT[reason] + ' Open the public Ahpra register, find the doctor by number and name, and record what it shows '
      + '(registration type, specialist GP, conditions, undertakings, notations, expiry, and whether section 19AB applies) '
      + 'in the candidate\'s profile on the CEO dashboard. Saving the check closes this task.',
    priority: reason === CHECK_REASON.EXPIRY_SOON ? 'high' : 'normal',
    due_date: ahpraCheckDueDate(reason, i.now),
    source_trigger: 'au_ahpra_check_' + reason,
    related_stage: i.stage || 'placement',
    metadata: { au: true, reason: reason, placing_consultant: i.placingConsultant || null }
  };
}

// FR-1 (R-04): a doctor's "my details have changed" request, in words staff
// can read. `proposed` is { gp_credentials column: { from, to } }.
const PROPOSED_FIELD_LABELS = Object.freeze({
  ahpra_number: 'Ahpra number',
  ahpra_registration_type: 'registration type',
  specialist_gp: 'on the specialist register as a GP',
  has_conditions: 'conditions',
  conditions_text: 'conditions detail',
  has_undertakings: 'undertakings',
  undertakings_text: 'undertakings detail',
  has_notations: 'notations',
  notations_text: 'notations detail',
  registration_expiry: 'registration expiry',
  fellowship_type: 'fellowship',
  fellowship_detail: 'fellowship detail',
  fellowship_year: 'fellowship year',
  vr_status: 'VR status',
  work_rights: 'right to work',
  visa_sponsor_tied: 'visa tied to a sponsor',
  supervision_level: 'supervision level'
});
function proposedValueText(v) {
  if (v === null || v === undefined || v === '') return 'nothing on file';
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return cleanLine(String(v), 120);
}
function describeProposedRegistrationChanges(proposed) {
  const p = proposed && typeof proposed === 'object' ? proposed : {};
  return Object.keys(PROPOSED_FIELD_LABELS).filter(function (k) {
    return Object.prototype.hasOwnProperty.call(p, k) && p[k] && typeof p[k] === 'object';
  }).map(function (k) {
    return PROPOSED_FIELD_LABELS[k] + ': ' + proposedValueText(p[k].from) + ' -> ' + proposedValueText(p[k].to);
  });
}

const auSafeText = require('./au-safe-text.js');   // FR-1 (R-07)

const SEGMENT_REASON_TEXT = Object.freeze({
  supervised_registration: 'registration is limited or provisional',
  segment_review_open: 'a segment review was open and was not resolved in the check',
  original_answers_restrictive: 'the doctor\'s own first answers were more restrictive and were not resolved in the check',
  registration_conditions: 'the register shows a condition, undertaking or notation',
  temporary_work_rights: 'the doctor is on a temporary right to work',
  moratorium_19ab_applies: 'section 19AB applies',
  registration_type_unclear: 'the registration type is not clear',
  registration_expired: 'the registration has expired',
  registration_expiry_missing: 'no registration expiry date is recorded',
  registration_expiry_not_judged: 'the registration expiry date could not be checked against today\'s date',
  specialist_register_unanswered: 'nobody has answered whether the doctor is on the specialist register as a GP',
  fellowship_unclear: 'fellowship is not recorded',
  conditions_unclear: 'conditions, undertakings and notations were not all answered',
  work_rights_unclear: 'right to work is not recorded',
  moratorium_19ab_unanswered: 'section 19AB has not been answered',
  in_training: 'the doctor is a GP registrar',
  no_gp_fellowship: 'no GP fellowship is recorded',
  not_on_specialist_register: 'the doctor is not on the specialist register as a GP',
  moratorium_19ab_unsure: 'the doctor is not sure whether section 19AB applies',
  onboarding_differs: 'the doctor\'s own answers point to a different segment from the one staff recorded',
  onboarding_reanswered: 'the doctor answered onboarding again and the new answers point to a different segment from the one on record (the pathway was not loosened)'
});

/**
 * N07: the staff task "a person decides the segment". Raised when the check
 * finds a condition, undertaking or notation, or the outcome is segment B or C.
 * Staff-facing only; the doctor is told nothing by it.
 * @returns {object} fields for _createRegTask
 */
function buildSegmentReviewTask(input) {
  const i = input && typeof input === 'object' ? input : {};
  const name = cleanLine(String(i.name || ''), 160) || 'this doctor';
  const d = i.derivation && typeof i.derivation === 'object' ? i.derivation : {};
  const reasons = (Array.isArray(d.reasons) ? d.reasons : []).concat(Array.isArray(i.extraReasons) ? i.extraReasons : []);
  const words = reasons.map(function (r) { return SEGMENT_REASON_TEXT[r] || cleanLine(String(r), 200); });
  const segment = cleanLine(String(d.segment || candidatePathway.segmentOf(d.pathway) || ''), 12);
  const pathwayWord = cleanLine(String(d.pathway || ''), 40) || 'unknown';
  return {
    task_type: TASK_TYPE.SEGMENT_REVIEW,
    status: 'open',
    // WP-26 (D25): `beforeCheck` = raised from the doctor's own answers (or a
    // held doctor opening Careers), before anyone has looked at the register.
    // The title must not say "Ahpra check" when no check exists yet.
    title: 'Decide the segment for ' + name + (i.beforeCheck === true
      ? ' (segment ' + segment + ' from their own answers: not yet checked on the Ahpra register)'
      : ' (Ahpra check: segment ' + segment + ')'),
    description: (i.beforeCheck === true
      ? 'This doctor\'s own answers put them in segment ' + segment + ' (' + pathwayWord + '). The Ahpra register has not been checked yet: do that first.'
      : 'The Ahpra register check put this doctor in segment ' + segment + ' (' + pathwayWord + ')')
      + (words.length ? ' because ' + words.join('; ') : '') + '. '
      + 'Read the conditions, undertakings and notations recorded on the profile, decide whether the doctor belongs in segment A, B or C, '
      + 'and set the pathway on the candidate\'s profile. Until then the doctor is held: they are shown no roles they may not take and are told nothing about this.',
    priority: 'high',
    due_date: isoDay(nowMsOf(i.now) + 2 * DAY_MS),
    source_trigger: 'au_segment_review',
    related_stage: i.stage || 'placement',
    metadata: { au: true, pathway: d.pathway || null, segment: segment, reasons: reasons, has_flags: d.hasFlags === true }
  };
}

// ── What the doctor is told ──────────────────────────────────────────────────
// Each builder returns the arguments for sendGpNotificationEmail plus a bell
// entry. `{{name}}` is filled in by the sender. `key` is the once-ever ledger
// key (gp_nudge_log). WP-17 restyles this copy: change it here.

function trimBase(url) { return String(url || '').replace(/\/+$/, ''); }

function buildAhpraVerifiedMessage(input) {
  const base = trimBase(input && input.appBaseUrl);
  // FR-9 S9-10: a doctor whose registration is confirmed but for whom one
  // thing about WHERE they can work is still open (they answered "Not sure",
  // or it could not be told) is not told "everything matches".
  const detailOpen = !!(input && input.detailToConfirm === true);
  return {
    id: 'N06',
    key: 'au_n06_ahpra_verified',
    subject: 'Your Ahpra registration is confirmed',
    title: 'You are verified, {{name}}',
    body: detailOpen
      ? 'We have checked your registration on the public Ahpra register and it is confirmed.\n\n'
        + 'There is one detail about where you can work that we still need to confirm with you. Until then you are seeing the roles we are sure fit, and you can apply for any of them. '
        + 'If you can tell us more, message us in the app or reply to this email and we will sort it out.\n\n'
        + 'Your enquiry is confidential. We never contact your current practice without asking you first.'
      : 'We have checked your registration on the public Ahpra register and everything matches.\n\n'
      + 'You can now see the GP roles that fit your profile and apply in a couple of taps. '
      + 'Your enquiry is confidential. We never contact your current practice without asking you first.',
    ctaText: 'See GP roles',
    ctaUrl: base + '/pages/career',
    footer: 'Questions? Reply to this email and our team will help.',
    bell: {
      type: 'success',
      title: 'Ahpra registration confirmed',
      body: 'We have checked your registration on the public register. You can now browse GP roles and apply.'
    }
  };
}

function buildAhpraNotMatchedMessage(input) {
  const i = input && typeof input === 'object' ? input : {};
  const number = normaliseAhpraNumber(i.number);
  return {
    id: 'N06',
    // Once per number: a corrected number that still does not match is news.
    key: 'au_n06_ahpra_not_matched' + (number ? ':' + number : ''),
    subject: 'We could not match your Ahpra number',
    title: 'Please check your Ahpra number, {{name}}',
    body: 'We looked up the registration number you gave us on the public Ahpra register and could not match it to your name.\n\n'
      + 'This is usually a typing slip. Your number starts with MED followed by ten digits. '
      + 'You can find it on your registration certificate, or by searching your name on the Ahpra register.\n\n'
      + 'Please reply to this email with the correct number and we will check it again straight away.',
    ctaText: 'Find my number on the Ahpra register',
    ctaUrl: AHPRA_PUBLIC_REGISTER_URL,
    footer: 'Nothing else is needed from you for now.',
    bell: {
      type: 'action',
      title: 'Please check your Ahpra number',
      body: 'We could not match the registration number you gave us on the public register. Reply to our email with the correct number and we will check it again.'
    }
  };
}

/**
 * The set-password invite for a candidate staff added. `setupUrl` is the
 * existing 24-hour-style bridge link (/api/auth/welcome-setup?token=...).
 */
function buildCandidateInviteEmail(input) {
  const i = input && typeof input === 'object' ? input : {};
  const staff = cleanLine(String(i.staffName || ''), 80);
  const who = staff ? staff + ' from GP Link' : 'The GP Link team';
  const hours = Number(i.linkHours) > 0 ? Number(i.linkHours) : INVITE_LINK_HOURS;
  const footer = 'This link works for ' + hours + ' hours. If it has expired, choose "Forgot password" on the sign-in page and we will send you a new one. '
    + 'If you were not expecting this email, you can ignore it.';
  if (candidatePathway.isAuPathway(i.pathway)) {
    return {
      key: 'au_staff_invite',
      subject: 'Set up your GP Link account',
      title: 'Welcome to GP Link, {{name}}',
      body: who + ' has set up an account for you, so we can help you find your next GP role in Australia.\n\n'
        + 'Choose a password to get started. Finishing your profile takes about five minutes: have your Ahpra registration number to hand.\n\n'
        + 'Your enquiry is confidential. We never contact your current practice without asking you first.',
      ctaText: 'Set my password',
      ctaUrl: auSafeText.safeUrl(i.setupUrl),   // FR-1 (R-07)
      footer: footer
    };
  }
  return {
    key: 'staff_invite',
    subject: 'Set up your GP Link account',
    title: 'Welcome to GP Link, {{name}}',
    body: who + ' has set up a GP Link account for you.\n\n'
      + 'Choose a password to get started, then complete your profile so our team can begin working with you.',
    ctaText: 'Set my password',
    ctaUrl: auSafeText.safeUrl(i.setupUrl),   // FR-1 (R-07)
    footer: footer
  };
}

// ── Candidate list: pathway chip and filter (ADM-19) ─────────────────────────
const PATHWAY_CHIP_LABEL = Object.freeze({
  overseas_esp: 'Overseas',
  overseas_pep: 'Overseas (PEP)',
  au_vr: 'Australian VR',
  au_restricted: 'Australian restricted',
  au_non_vr: 'Non-VR',
  au_registrar: 'Registrar'
});
const PATHWAY_FILTERS = Object.freeze([
  { value: '', label: 'All pathways' },
  { value: 'overseas', label: 'Overseas' },
  { value: 'au_vr', label: 'Australian VR' },
  { value: 'au_restricted', label: 'Australian restricted' },
  { value: 'au_non_vr', label: 'Non-VR' },
  { value: 'au_registrar', label: 'Registrar' },
  { value: 'needs_review', label: 'Needs review' },
  // WP-29: where the doctor sorts (lib/au-work-sorting.js).
  { value: 'group_anywhere', label: 'Can work anywhere' },
  { value: 'group_dpa_only', label: 'Priority areas only (DPA)' },
  { value: 'group_registrar', label: 'Registrar: not placed' },
  { value: 'group_non_vr_held', label: 'Non-VR: held' },
  { value: 'needs_person', label: 'Needs a person' }
]);

function pathwayChipLabel(pathway) {
  return PATHWAY_CHIP_LABEL[candidatePathway.normalisePathway(pathway)];
}
function isPathwayFilter(value) {
  return PATHWAY_FILTERS.some(function (f) { return f.value === value; });
}
/** Does a list row ({ pathway, pathway_needs_review }) pass the filter? Unknown filter = everything. */
function pathwayFilterMatches(filter, row) {
  const f = String(filter || '');
  if (!f || !isPathwayFilter(f)) return true;
  const p = candidatePathway.normalisePathway(row && row.pathway);
  if (f === 'overseas') return !candidatePathway.isAuPathway(p);
  if (f === 'needs_review') return !!(row && row.pathway_needs_review === true);
  if (f === 'needs_person') return !!(row && row.needs_person === true);
  if (f.indexOf('group_') === 0) return !!(row && row.group === f.slice('group_'.length));
  return p === f;
}

module.exports = {
  describeProposedRegistrationChanges,
  PROPOSED_FIELD_LABELS,
  TASK_TYPE,
  AU_NEW_TASK_TYPES,
  AHPRA_PUBLIC_REGISTER_URL,
  CHECK_OUTCOME,
  CHECK_OUTCOMES,
  CHECK_REASON,
  CHECK_DUE_DAYS,
  RECHECK_AFTER_DAYS,
  EXPIRY_WARNING_DAYS,
  INVITE_LINK_HOURS,
  normaliseAhpraNumber,
  isAhpraNumber,
  validateCreateCandidateInput,
  validateAhpraCheckInput,
  confirmedVrMissing,
  selfAnswerSummary,
  ahpraCheckDueDate,
  ahpraRecheckDue,
  buildAhpraCheckTask,
  buildSegmentReviewTask,
  buildAhpraVerifiedMessage,
  buildAhpraNotMatchedMessage,
  buildCandidateInviteEmail,
  PATHWAY_CHIP_LABEL,
  PATHWAY_FILTERS,
  pathwayChipLabel,
  isPathwayFilter,
  pathwayFilterMatches
};

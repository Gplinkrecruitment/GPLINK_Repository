'use strict';

/**
 * Australian GP build, WP-23: which GPs a practice will consider, and how that
 * becomes the role fields WP-08 added. Pure: no I/O, no switch. Every caller
 * asks the switch first; with it off nothing here is called.
 * Read docs/au-gp/CONVENTIONS.md section 36.
 *
 * WHERE IT IS STORED (no new column, no migration)
 *   practices.metadata.intake.au_gp      the practice's own answers (below)
 *   practices.metadata.dpa_lookup        'yes' | 'no' | 'unknown': what the
 *                                        area look-up said on the website
 *                                        lead form
 *   career_roles.source_payload.intake   a copy of the intake, so au_gp too
 *   career_roles.source_payload.au_intake_flags   the notes staff are shown
 *
 * THE ANSWERS (`au_gp`, one per clinic)
 *   gp_types: { vr, non_vr, registrar, supervised, overseas }   all booleans
 *   dpa_answer: 'yes' | 'no' | 'unsure'
 *   engagement_type: 'permanent' | 'contract' | ''     (no locum: decision 10)
 *   sessions_min, sessions_max: 0.5 to 14 in halves, or null
 *   special_interests: from SPECIAL_INTEREST_OPTIONS
 *
 * DEFAULTS (owner decision 5: non-VR is off unless the practice says yes)
 *   vr yes; non_vr, registrar, supervised no; overseas yes in a DPA, no
 *   otherwise.
 *
 * ONE SUPERVISION QUESTION. `gp_types.supervised` and the intake's existing
 * `supervision_available` are the same fact. The page shows one control; the
 * server refuses a payload where they disagree.
 *
 * THE REGULATORY LINE IS A WORKING ASSUMPTION ("GPs who trained overseas
 * generally need a DPA location"). It is said in one place, OVERSEAS_NOT_DPA_NOTE,
 * and is flagged for the owner to confirm.
 */

const GP_TYPE_KEYS = Object.freeze(['vr', 'non_vr', 'registrar', 'supervised', 'overseas']);

const GP_TYPE_LABELS = Object.freeze({
  vr: 'Vocationally registered Australian GPs',
  non_vr: 'Non-VR GPs',
  registrar: 'GP registrars',
  supervised: 'Doctors who need supervision (limited or provisional registration)',
  overseas: 'Overseas-trained GPs moving to Australia'
});

const GP_TYPE_HINTS = Object.freeze({
  vr: 'Hold Ahpra registration and a fellowship (FRACGP or FACRRM). No visa or registration wait.',
  non_vr: 'Registered GPs without vocational registration. Their patients receive lower Medicare rebates.',
  registrar: 'Doctors in GP training. Your practice would generally need to be an accredited training post.',
  supervised: 'You would need a supervisor on site or on call, as the doctor\'s registration requires.',
  overseas: 'Doctors from the UK, Ireland and New Zealand. We run their registration and visa with them.'
});

const OVERSEAS_NOT_DPA_NOTE = 'GPs who trained overseas generally need a practice in a Distribution Priority Area to bill Medicare, so this usually does not apply to a practice outside one. We will confirm with you if your position is different.';

const DPA_ANSWERS = Object.freeze(['yes', 'no', 'unsure']);
const DPA_STATES = Object.freeze(['yes', 'no', 'unknown']);
const ENGAGEMENT_TYPES = Object.freeze(['permanent', 'contract']);
const ENGAGEMENT_LABELS = Object.freeze({ permanent: 'Permanent', contract: 'Fixed-term contract' });

const SPECIAL_INTEREST_OPTIONS = Object.freeze([
  'Skin cancer medicine', 'Women\'s health', 'Men\'s health', 'Mental health', 'Chronic disease management',
  'Paediatrics', 'Aged care', 'Sports medicine', 'Travel medicine', 'Minor procedures',
  'Antenatal shared care', 'Occupational health', 'Aboriginal and Torres Strait Islander health'
]);

const SESSIONS_MIN = 0.5;
const SESSIONS_MAX = 14;

/** true -> 'yes', false -> 'no', anything else -> 'unknown'. Never guesses "no". */
function dpaLookupState(value) {
  if (value === true || value === 'yes') return 'yes';
  if (value === false || value === 'no') return 'no';
  return 'unknown';
}

function defaultGpTypes(dpa) {
  return { vr: true, non_vr: false, registrar: false, supervised: false, overseas: dpa === true };
}

function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

function sessionsValue(raw, key) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < SESSIONS_MIN || n > SESSIONS_MAX || Math.round(n * 2) !== n * 2) {
    return { ok: false, error: 'au_gp.' + key + ' must be a number of sessions a week from ' + SESSIONS_MIN + ' to ' + SESSIONS_MAX + ' (halves allowed)' };
  }
  return { ok: true, value: n };
}

/**
 * Validates one clinic's Australian answers against fixed sets.
 *
 * @param {*} raw      the `au_gp` object the page sent (undefined: the page did not ask)
 * @param {{ dpa: boolean, supervisionAvailable: (boolean|null) }} ctx  the already-validated intake answers
 * @returns {{ ok: true, value: (object|null) } | { ok: false, error: string }}
 *   value null: nothing was sent (an older copy of the page). Nothing is stored and
 *   the job is created the way WP-08 created it.
 */
function validateIntakeAuAnswers(raw, ctx) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'au_gp must be an object' };
  const c = ctx || {};
  const known = ['gp_types', 'dpa_answer', 'engagement_type', 'sessions_min', 'sessions_max', 'special_interests'];
  for (const key of Object.keys(raw)) {
    if (known.indexOf(key) === -1) return { ok: false, error: 'au_gp.' + key + ' is not a known answer' };
  }

  // Which GPs. Every key must be present and a real boolean: a missing answer
  // is never read as yes.
  const typesRaw = raw.gp_types;
  if (!typesRaw || typeof typesRaw !== 'object' || Array.isArray(typesRaw)) return { ok: false, error: 'au_gp.gp_types is required' };
  for (const key of Object.keys(typesRaw)) {
    if (GP_TYPE_KEYS.indexOf(key) === -1) return { ok: false, error: 'au_gp.gp_types.' + key + ' is not a known GP type' };
  }
  const gpTypes = {};
  for (const key of GP_TYPE_KEYS) {
    if (typeof typesRaw[key] !== 'boolean') return { ok: false, error: 'au_gp.gp_types.' + key + ' must be true or false' };
    gpTypes[key] = typesRaw[key];
  }
  if (!GP_TYPE_KEYS.some(function (k) { return gpTypes[k]; })) {
    return { ok: false, error: 'Please choose at least one type of GP your practice will consider.' };
  }

  // One supervision question, not two that can contradict.
  if (c.supervisionAvailable === true && gpTypes.supervised !== true) {
    return { ok: false, error: 'Your answers about supervision disagree: you said supervision is available, but not that you will consider doctors who need it. Please check that answer.' };
  }
  if (c.supervisionAvailable !== true && gpTypes.supervised === true) {
    return { ok: false, error: 'Your answers about supervision disagree: you said you will consider doctors who need supervision, but not that supervision is available. Please check that answer.' };
  }

  // The DPA answer in three states. It must agree with the yes / no the intake
  // has always asked: "unsure" travels with a "no" there, which is the closed
  // answer for the overseas rule.
  const dpaAnswer = String(raw.dpa_answer == null ? '' : raw.dpa_answer).trim().toLowerCase();
  if (DPA_ANSWERS.indexOf(dpaAnswer) === -1) return { ok: false, error: 'au_gp.dpa_answer must be yes, no or unsure' };
  if ((dpaAnswer === 'yes') !== (c.dpa === true)) {
    return { ok: false, error: 'Your answers about the Distribution Priority Area disagree. Please check that answer.' };
  }

  const engagement = String(raw.engagement_type == null ? '' : raw.engagement_type).trim().toLowerCase();
  if (engagement && ENGAGEMENT_TYPES.indexOf(engagement) === -1) {
    return { ok: false, error: 'au_gp.engagement_type must be permanent or contract' };
  }

  const min = sessionsValue(raw.sessions_min, 'sessions_min');
  if (!min.ok) return min;
  const max = sessionsValue(raw.sessions_max, 'sessions_max');
  if (!max.ok) return max;
  if (min.value != null && max.value != null && min.value > max.value) {
    return { ok: false, error: 'au_gp.sessions_min cannot be more than au_gp.sessions_max' };
  }

  let interests = raw.special_interests;
  if (interests === undefined || interests === null || interests === '') interests = [];
  if (!Array.isArray(interests)) return { ok: false, error: 'au_gp.special_interests must be a list' };
  const picked = [];
  for (const item of interests) {
    if (typeof item !== 'string' || SPECIAL_INTEREST_OPTIONS.indexOf(item) === -1) {
      return { ok: false, error: 'au_gp.special_interests holds a value that is not on the list' };
    }
    if (picked.indexOf(item) === -1) picked.push(item);
  }

  return {
    ok: true,
    value: {
      gp_types: gpTypes,
      dpa_answer: dpaAnswer,
      engagement_type: engagement,
      sessions_min: min.value,
      sessions_max: max.value,
      special_interests: picked
    }
  };
}

/**
 * The role's DPA status from the practice's own answer and the official look-up.
 * A disagreement is never resolved here: the status is 'unknown' (the closed
 * answer for a doctor limited to DPA roles) and staff are told to ask.
 *
 * @param {{ answer: ('yes'|'no'|'unsure'|boolean|null), lookup: (boolean|null|'yes'|'no'|'unknown') }} input
 * @returns {{ status: 'yes'|'no'|'unknown', disagreement: boolean, reason: string }}
 */
function dpaStatusFrom(input) {
  const i = input || {};
  const answer = i.answer === true ? 'yes' : (i.answer === false ? 'no' : String(i.answer == null ? '' : i.answer).trim().toLowerCase());
  const lookup = dpaLookupState(i.lookup);
  if (answer !== 'yes' && answer !== 'no') {
    // The practice did not know. The look-up alone is not the practice's
    // confirmation, so the role stays "ask" until a person settles it.
    return { status: 'unknown', disagreement: false, reason: lookup === 'unknown' ? 'practice_unsure_no_lookup' : 'practice_unsure' };
  }
  if (lookup !== 'unknown' && lookup !== answer) {
    return { status: 'unknown', disagreement: true, reason: 'practice_and_lookup_disagree' };
  }
  return { status: answer, disagreement: false, reason: lookup === 'unknown' ? 'practice_answer_only' : 'practice_and_lookup_agree' };
}

/** The intake's Australian answers, or null when the practice was never asked. */
function intakeAuAnswers(intake) {
  const a = intake && typeof intake === 'object' ? intake.au_gp : null;
  if (!a || typeof a !== 'object' || !a.gp_types || typeof a.gp_types !== 'object') return null;
  return a;
}

/**
 * The WP-08 role fields for a job created from an intake, and the notes staff
 * are shown before they approve it.
 *
 * @param {object} intake    practices.metadata.intake
 * @param {object} practice  the practices row (for dpa_suggested, the look-up)
 * @returns {{ fields: object, flags: Array<{ code: string, message: string }>, asked: boolean, dpa: object }}
 *   asked false: the practice was never asked (an intake saved before WP-23, or
 *   by an older copy of the page). `fields` is then exactly what WP-08 wrote.
 */
function roleFieldsFromIntake(intake, practice) {
  const it = intake && typeof intake === 'object' ? intake : {};
  const p = practice && typeof practice === 'object' ? practice : {};
  const answers = intakeAuAnswers(it);
  if (!answers) {
    const legacy = { dpa_status: it.dpa === true ? 'yes' : (it.dpa === false ? 'no' : 'unknown') };
    if (it.supervision_available === true) legacy.accepts_supervised = true;
    return { fields: legacy, flags: [], asked: false, dpa: { status: legacy.dpa_status, disagreement: false, reason: 'not_asked' } };
  }

  const types = answers.gp_types;
  const lookup = (p.dpa_suggested === true || p.dpa_suggested === false) ? p.dpa_suggested : null;
  const dpa = dpaStatusFrom({ answer: answers.dpa_answer, lookup: lookup });

  const fields = {
    // Owner decision 5: a role is open to non-VR GPs only when the practice
    // explicitly said so. Anything else is VR required.
    vr_requirement: types.non_vr === true ? 'non_vr_accepted' : 'vr_required',
    accepts_registrars: types.registrar === true,
    accepts_supervised: types.supervised === true,
    engagement_type: ENGAGEMENT_TYPES.indexOf(answers.engagement_type) !== -1 ? answers.engagement_type : null,
    sessions_min: typeof answers.sessions_min === 'number' ? answers.sessions_min : null,
    sessions_max: typeof answers.sessions_max === 'number' ? answers.sessions_max : null,
    special_interests: Array.isArray(answers.special_interests)
      ? answers.special_interests.filter(function (s) { return SPECIAL_INTEREST_OPTIONS.indexOf(s) !== -1; })
      : [],
    dpa_status: dpa.status
  };

  const flags = [];
  if (dpa.disagreement) {
    flags.push({
      code: 'dpa_disagreement',
      message: 'The practice says it is ' + (answers.dpa_answer === 'yes' ? 'in' : 'not in') + ' a Distribution Priority Area; the official look-up says it is ' + (lookup ? 'in' : 'not in') + ' one. The role is recorded as "DPA: ask" until you confirm with the practice and set it in the job editor.'
    });
  } else if (dpa.status === 'unknown') {
    flags.push({
      code: 'dpa_unknown',
      message: 'The practice was not sure whether it is in a Distribution Priority Area. The role is recorded as "DPA: ask": confirm with the practice and set it in the job editor.'
    });
  }
  if (types.vr !== true) {
    flags.push({
      code: 'vr_declined',
      message: 'The practice said it will NOT consider vocationally registered Australian GPs. A role cannot be closed to them, so they will still see it: talk to the practice before approving.'
    });
  }
  if (it.dpa === true && types.overseas !== true) {
    flags.push({
      code: 'overseas_declined',
      message: 'The practice is in a DPA but said it will NOT consider overseas-trained GPs. A DPA role is still shown to them: talk to the practice before approving.'
    });
  }
  if (it.dpa !== true && types.overseas === true) {
    flags.push({
      code: 'overseas_outside_dpa',
      message: 'The practice is not in a DPA but asked for overseas-trained GPs. Overseas-trained GPs are only shown DPA roles, so they will not see this one.'
    });
  }
  return { fields: fields, flags: flags, asked: true, dpa: dpa };
}

/**
 * What staff see on a practice card and on a pending job (CEO Practices view).
 * @returns {null | { asked: boolean, accepted: string[], declined: string[], gpTypes: object|null,
 *   dpa: { status, label, practiceAnswer, lookup, disagreement }, engagement: string, sessions: string,
 *   specialInterests: string[], flags: Array }}
 */
function staffSummary(practice) {
  const p = practice && typeof practice === 'object' ? practice : null;
  if (!p) return null;
  const meta = p.metadata && typeof p.metadata === 'object' ? p.metadata : {};
  const intake = meta.intake && typeof meta.intake === 'object' ? meta.intake : null;
  const answers = intakeAuAnswers(intake);
  const lookupFromIntake = (p.dpa_suggested === true || p.dpa_suggested === false) ? dpaLookupState(p.dpa_suggested) : 'unknown';
  const lookup = lookupFromIntake !== 'unknown' ? lookupFromIntake : dpaLookupState(meta.dpa_lookup);

  let dpa;
  let practiceAnswer;
  if (answers) {
    const mapped = roleFieldsFromIntake(intake, p);
    dpa = mapped.dpa;
    practiceAnswer = answers.dpa_answer;
  } else if (intake) {
    practiceAnswer = intake.dpa === true ? 'yes' : (intake.dpa === false ? 'no' : '');
    dpa = dpaStatusFrom({ answer: practiceAnswer || null, lookup: lookup });
  } else {
    // A lead that has not filled the intake yet: only the look-up is known.
    practiceAnswer = '';
    dpa = { status: lookup, disagreement: false, reason: 'lookup_only' };
  }
  const labels = { yes: 'In a DPA', no: 'Not in a DPA', unknown: 'DPA: ask the practice' };
  const out = {
    asked: !!answers,
    gpTypes: answers ? Object.assign({}, answers.gp_types) : null,
    accepted: [],
    declined: [],
    dpa: { status: dpa.status, label: labels[dpa.status], practiceAnswer: practiceAnswer || '', lookup: lookup, disagreement: dpa.disagreement === true },
    engagement: '',
    sessions: '',
    specialInterests: [],
    flags: []
  };
  if (answers) {
    GP_TYPE_KEYS.forEach(function (k) { (answers.gp_types[k] === true ? out.accepted : out.declined).push(GP_TYPE_LABELS[k]); });
    out.engagement = ENGAGEMENT_LABELS[answers.engagement_type] || '';
    const lo = answers.sessions_min;
    const hi = answers.sessions_max;
    if (typeof lo === 'number' && typeof hi === 'number') out.sessions = lo === hi ? lo + ' sessions a week' : lo + ' to ' + hi + ' sessions a week';
    else if (typeof lo === 'number') out.sessions = 'at least ' + lo + ' sessions a week';
    else if (typeof hi === 'number') out.sessions = 'up to ' + hi + ' sessions a week';
    out.specialInterests = Array.isArray(answers.special_interests) ? answers.special_interests.slice() : [];
    out.flags = roleFieldsFromIntake(intake, p).flags;
  }
  return out;
}

/** What the intake page needs to draw the question (sent only with the switch on). */
function intakeFormConfig() {
  return {
    gpTypes: GP_TYPE_KEYS.map(function (k) { return { key: k, label: GP_TYPE_LABELS[k], hint: GP_TYPE_HINTS[k] }; }),
    overseasNotDpaNote: OVERSEAS_NOT_DPA_NOTE,
    engagementTypes: ENGAGEMENT_TYPES.map(function (k) { return { key: k, label: ENGAGEMENT_LABELS[k] }; }),
    specialInterests: SPECIAL_INTEREST_OPTIONS.slice(),
    sessions: { min: SESSIONS_MIN, max: SESSIONS_MAX }
  };
}

module.exports = {
  GP_TYPE_KEYS, GP_TYPE_LABELS, GP_TYPE_HINTS, OVERSEAS_NOT_DPA_NOTE,
  DPA_ANSWERS, DPA_STATES, ENGAGEMENT_TYPES, ENGAGEMENT_LABELS, SPECIAL_INTEREST_OPTIONS, SESSIONS_MIN, SESSIONS_MAX,
  dpaLookupState, defaultGpTypes, validateIntakeAuAnswers, dpaStatusFrom, intakeAuAnswers,
  roleFieldsFromIntake, staffSummary, intakeFormConfig
};

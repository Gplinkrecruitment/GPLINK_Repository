'use strict';

/**
 * Australian GP build, WP-05: the onboarding branch for a doctor who is
 * already registered with Ahpra and working in Australia. Pure, no I/O. The
 * reading and writing live in server.js (completeAuOnboarding,
 * releaseEligibilityWaitlistForAu); the screens live in pages/onboarding.html
 * and js/onboarding.js, with the same lists mirrored in js/onboarding-au.js
 * (kept in step by tests/au-wp05-onboarding-lib.test.js: change BOTH together).
 *
 * What the browser sends (the wizard blob it already posts to
 * /api/onboarding/save and /api/onboarding/complete, plus two keys):
 *
 *   auBranch: 'yes'           the answer to the first question
 *   au: {                     the Australian answers
 *     ahpraNumber, registrationType, fellowship, fellowshipDetail,
 *     hasConditions, conditionsDetail, moratorium19ab,
 *     workRights, permitSubclass, permitExpiry,
 *     currentPractice, noticeWeeks, availableFrom, sessions, detailsConfirmed, step,
 *     base, travel, places[]      WP-29: where they are based (a place id from
 *                                 /api/au/localities), how far they would go
 *                                 (commute | state | places | anywhere), and
 *                                 the specific places (place ids)
 *     locations[], suburb, state, postcode   before WP-29 (still accepted from
 *                                 a browser that has not reloaded)
 *   }
 *
 * Nothing here is trusted until validateAuOnboarding has cleaned it. The
 * pathway is never read from the browser: it is derived from the cleaned
 * answers by candidate-pathway.derivePathwayFromOnboarding.
 */

const candidatePathway = require('./candidate-pathway.js');
const gpCredentials = require('./gp-credentials.js');
const registerVerification = require('./register-verification.js');
const practicePipeline = require('./practice-pipeline.js');
// WP-29: "Where are you based?" and "How far would you go?" (the structured
// location choice). The places come from the built-in suburb list by id, so
// nothing a browser types is trusted as a name or a coordinate.
const auLocationMatch = require('./au-location-match.js');

// Server-owned key on user_state.state. Stamped when a save of the wizard blob
// says the doctor answered "yes" to the first question, removed when it no
// longer does and when onboarding completes. NOT in USER_STATE_KEYS, so a
// browser can neither read nor write it directly. It is not the pathway: it
// only tells the scheduled jobs "this doctor is part-way through the
// Australian branch, do not send them reminders written for another journey".
const AU_BRANCH_MARKER_KEY = 'gp_au_branch_started_at';
// FR-1 (R-01). Server-owned user_state key: this account was created by
// someone who came as an Australian GP (the Australian pages, an Australian
// lead with the same email). Value 'au'. It is EVIDENCE, not a pathway: until
// the doctor answers the first onboarding question it keeps the overseas
// welcome and the overseas reminders away from them. It is removed the moment
// the saved wizard shows they answered "no" (today's wizard), and when either
// onboarding is finished.
const AU_SIGNUP_AUDIENCE_KEY = 'gp_au_signup_audience';
const AU_SIGNUP_AUDIENCE_VALUE = 'au';

/** Is the "came as an Australian GP" evidence on this state? */
function hasAuSignupAudience(state) {
  return isPlainObjectLoose(state) && state[AU_SIGNUP_AUDIENCE_KEY] === AU_SIGNUP_AUDIENCE_VALUE;
}
function isPlainObjectLoose(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/**
 * Does this request say the visitor signed up from an Australian page? Only
 * the two fixed markers the Australian pages send count ('au'); anything else
 * is no evidence.
 */
function isAuSignupAudienceMarker(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === AU_SIGNUP_AUDIENCE_VALUE;
}

/** Has this saved wizard blob answered the first question as "not Australian"? */
function blobSaysNotAustralian(blob) {
  let b = blob;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  if (!isPlainObjectLoose(b) || isAuOnboardingPayload(b)) return false;
  return b.auBranch === 'no' || Number(b.currentStep) >= 1 || !!b.completedAt;
}

const AU_COUNTRY_CODE = 'AU';
const AU_COUNTRY_NAME = 'Australia';

// ── answer lists (value = what the browser sends) ────────────────────────────
// Registration types are exactly gp-credentials AHPRA_REGISTRATION_TYPES, plus
// 'unsure' (an answer, never stored as a type).
const REGISTRATION_TYPE_ANSWERS = Object.freeze([
  { value: 'specialist', label: 'Specialist (general practice)' },
  { value: 'general_and_specialist', label: 'General and specialist (general practice)' },
  { value: 'general', label: 'General' },
  { value: 'provisional', label: 'Provisional' },
  { value: 'limited', label: 'Limited' },
  { value: 'non_practising', label: 'Non-practising' },
  { value: 'unsure', label: 'Something else, or not sure' }
]);

// Fellowships are exactly gp-credentials FELLOWSHIP_TYPES, plus 'registrar'
// (in training: stored as fellowship 'none', pathway au_registrar).
const FELLOWSHIP_ANSWERS = Object.freeze([
  { value: 'fracgp', label: 'FRACGP' },
  { value: 'facrrm', label: 'FACRRM' },
  { value: 'both', label: 'Both FRACGP and FACRRM' },
  { value: 'registrar', label: 'I am a GP registrar (in training)' },
  { value: 'other', label: 'Another fellowship' },
  { value: 'none', label: 'No fellowship' }
]);

const MORATORIUM_ANSWERS = Object.freeze([
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'unsure', label: 'Not sure' }
]);

// The browser never uses the stored word for a temporary right to work
// (AGENT-RULES section 4). 'temporary' is stored as work_rights 'visa'.
const WORK_RIGHTS_ANSWERS = Object.freeze([
  { value: 'citizen', label: 'Australian citizen', stored: 'citizen' },
  { value: 'pr', label: 'Permanent resident', stored: 'pr' },
  { value: 'temporary', label: 'Temporary resident', stored: 'visa' }
]);

const NOTICE_WEEKS_MAX = 52;
const SESSIONS_MIN = 1;
const SESSIONS_MAX = 10;
const MAX_LOCATIONS = 12;
const ANYWHERE_LOCATION = 'Anywhere in Australia';

// Where a doctor may say they want to work: the cities the role listings are
// already anchored to (lib/practice-pipeline.js MAJOR_CITIES: the eight
// capitals and five large centres), then "Regional <state>" for every state
// and territory that has regional areas, then "anywhere".
const AU_REGIONAL_STATES = Object.freeze(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT']);
const AU_CITY_LOCATIONS = Object.freeze(practicePipeline.MAJOR_CITIES.map(function (c) { return c.name; }));
const AU_REGIONAL_LOCATIONS = Object.freeze(AU_REGIONAL_STATES.map(function (s) { return 'Regional ' + s; }));
const AU_LOCATIONS = Object.freeze(AU_CITY_LOCATIONS.concat(AU_REGIONAL_LOCATIONS, [ANYWHERE_LOCATION]));

function valuesOf(list) { return list.map(function (o) { return o.value; }); }

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/** Does this wizard blob say the doctor is on the Australian branch? */
function isAuOnboardingPayload(body) {
  return isPlainObject(body) && body.auBranch === 'yes';
}

function cleanLine(v, max) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const code = v.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) { out += ' '; continue; }
    if (code < 32 || code === 127) continue;
    out += v[i];
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanIsoDate(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return m[0];
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

/**
 * Clean and check every Australian answer. Never trusts the browser: each
 * value is checked against the lists above, and the credential and preference
 * patches it returns are cleaned again by gp-credentials before they are
 * written.
 *
 * @param {object} body  the wizard blob ({ auBranch: 'yes', au: {...} })
 * @param {{ now?: string|number|Date }} [opts]
 * @returns {{
 *   ok: boolean,
 *   errors: Object<string,string>,          field -> plain message (empty when ok)
 *   answers: object|null,                   the cleaned answers
 *   credentialsPatch: object|null,          for upsertGpCredentials(..., { source: 'self' })
 *   preferencesPatch: object|null,          for setCandidatePreferences
 *   register: { body: 'ahpra', number: string }|null,
 *   preferredCity: string,                  for user_profiles.preferred_city (drives role ranking)
 *   derivation: object|null                 derivePathwayFromOnboarding(answers)
 * }}
 */
function validateAuOnboarding(body, opts) {
  const errors = {};
  const fail = function () {
    return { ok: false, errors, answers: null, credentialsPatch: null, preferencesPatch: null, register: null, preferredCity: '', derivation: null };
  };
  if (!isAuOnboardingPayload(body) || !isPlainObject(body.au)) {
    errors.au = 'Your answers are missing. Please go through the questions again.';
    return fail();
  }
  const a = body.au;
  const nowMs = opts && opts.now != null ? new Date(opts.now).getTime() : Date.now();
  const nowYear = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).getUTCFullYear();

  // Ahpra number: the same rule the register check uses (MED + 10 digits).
  const reg = registerVerification.validateRegisterDetails('ahpra', a.ahpraNumber);
  if (!reg.ok) errors.ahpraNumber = 'Enter your Ahpra registration number: MED followed by 10 digits.';

  const registrationType = typeof a.registrationType === 'string' ? a.registrationType.trim().toLowerCase() : '';
  if (valuesOf(REGISTRATION_TYPE_ANSWERS).indexOf(registrationType) === -1) errors.registrationType = 'Choose your registration type.';

  const fellowship = typeof a.fellowship === 'string' ? a.fellowship.trim().toLowerCase() : '';
  if (valuesOf(FELLOWSHIP_ANSWERS).indexOf(fellowship) === -1) errors.fellowship = 'Choose your fellowship.';
  const fellowshipDetail = fellowship === 'other' ? cleanLine(a.fellowshipDetail, 200) : '';

  if (typeof a.hasConditions !== 'boolean') errors.hasConditions = 'Tell us whether your registration has any conditions.';
  const hasConditions = a.hasConditions === true;
  const conditionsDetail = hasConditions ? cleanLine(a.conditionsDetail, 1000) : '';

  const moratorium19ab = candidatePathway.normalise19ab(a.moratorium19ab);
  if (!moratorium19ab) errors.moratorium19ab = 'Choose yes, no or not sure.';

  const workRightsAnswer = typeof a.workRights === 'string' ? a.workRights.trim().toLowerCase() : '';
  const workRightsRow = WORK_RIGHTS_ANSWERS.filter(function (o) { return o.value === workRightsAnswer; })[0] || null;
  if (!workRightsRow) errors.workRights = 'Choose your right to work in Australia.';
  const temporary = !!workRightsRow && workRightsRow.stored === 'visa';
  const permitSubclass = temporary ? cleanLine(a.permitSubclass, 20) : '';
  let permitExpiry = null;
  if (temporary && a.permitExpiry != null && String(a.permitExpiry).trim() !== '') {
    permitExpiry = cleanIsoDate(String(a.permitExpiry));
    if (!permitExpiry) errors.permitExpiry = 'Enter a valid date.';
  }

  const currentPractice = cleanLine(a.currentPractice, 200);

  const noticeWeeks = toNumber(a.noticeWeeks);
  if (!Number.isInteger(noticeWeeks) || noticeWeeks < 0 || noticeWeeks > NOTICE_WEEKS_MAX) {
    errors.noticeWeeks = 'Choose your notice period.';
  }

  // "When could you start?" has NO minimum (finding APP-04): today, or a date
  // already past ("I can start now"), is a real answer. Only an impossible or
  // far-fetched date is refused.
  const availableFrom = cleanIsoDate(typeof a.availableFrom === 'string' ? a.availableFrom : '');
  if (!availableFrom) errors.availableFrom = 'Choose the date you could start.';
  else {
    const y = Number(availableFrom.slice(0, 4));
    if (y < nowYear - 1 || y > nowYear + 5) errors.availableFrom = 'Choose a date within the next five years.';
  }

  // WP-29: the structured choice. Present when the browser sent a base or a
  // travel option (the new first screen). The server reads every place from
  // the suburb list by id and then FILLS IN the older fields from it (the
  // preferred-location names, the state, suburb and postcode), so every reader
  // of those keeps working. A browser still on the old screen sends
  // `locations` and `state` instead, and is checked the old way below.
  const usesLocationChoice = a.base != null || (a.travel != null && a.travel !== '');
  let locationChoice = null;
  if (usesLocationChoice) {
    const picked = auLocationMatch.normaliseLocationChoice({ base: a.base, travel: a.travel, places: a.places });
    if (!picked.ok) {
      if (picked.errors.base) errors.base = picked.errors.base;
      if (picked.errors.travel) errors.travel = picked.errors.travel;
      if (picked.errors.places) errors.places = picked.errors.places;
      if (!errors.base && !errors.travel && !errors.places) errors.base = 'Choose where you are based from the list.';
    } else locationChoice = picked.choice;
  }

  const locations = [];
  if (locationChoice) {
    auLocationMatch.legacyLocationsFor(locationChoice).forEach(function (v) {
      if (AU_LOCATIONS.indexOf(v) !== -1 && locations.indexOf(v) === -1 && locations.length < MAX_LOCATIONS) locations.push(v);
    });
  } else if (usesLocationChoice) {
    /* errors already recorded above */
  } else if (Array.isArray(a.locations)) {
    a.locations.forEach(function (raw) {
      const v = typeof raw === 'string' ? raw.trim() : '';
      if (AU_LOCATIONS.indexOf(v) !== -1 && locations.indexOf(v) === -1 && locations.length < MAX_LOCATIONS) locations.push(v);
    });
    if (a.locations.some(function (raw) { return AU_LOCATIONS.indexOf(typeof raw === 'string' ? raw.trim() : '') === -1; })) {
      errors.locations = 'Choose from the listed locations.';
    }
  }
  if (!usesLocationChoice && !locations.length && !errors.locations) errors.locations = 'Choose at least one place you would like to work.';

  let stateCode = typeof a.state === 'string' ? a.state.trim().toUpperCase() : '';
  let suburb = cleanLine(a.suburb, 120);
  let postcode = '';
  if (locationChoice) {
    // Where they live comes from the place they chose, not from typed text.
    stateCode = String(locationChoice.base.state || '').toUpperCase();
    suburb = cleanLine(String(locationChoice.base.name || ''), 120);
    postcode = /^\d{4}$/.test(String(locationChoice.base.postcode || '')) ? String(locationChoice.base.postcode) : '';
  } else if (!usesLocationChoice) {
    if (gpCredentials.AU_STATES.indexOf(stateCode) === -1) errors.state = 'Choose the state or territory you live in.';
    if (a.postcode != null && String(a.postcode).trim() !== '') {
      postcode = String(a.postcode).trim();
      if (!/^\d{4}$/.test(postcode)) errors.postcode = 'A postcode is four digits.';
    }
  }

  // Sessions a week: a number, or left as "not sure yet" (null).
  let sessions = null;
  if (a.sessions != null && String(a.sessions).trim() !== '') {
    sessions = toNumber(a.sessions);
    if (!Number.isInteger(sessions) || sessions < SESSIONS_MIN || sessions > SESSIONS_MAX) {
      errors.sessions = 'Choose how many sessions a week you would like.';
    }
  }

  if (a.detailsConfirmed !== true) errors.detailsConfirmed = 'Please confirm your details are correct.';

  if (Object.keys(errors).length) return fail();

  const answers = {
    ahpraNumber: reg.number,
    registrationType,
    fellowship,
    fellowshipDetail,
    inTraining: fellowship === 'registrar',
    hasConditions,
    conditionsDetail,
    moratorium19ab,
    workRights: workRightsRow.stored,
    permitSubclass,
    permitExpiry,
    currentPractice,
    noticeWeeks,
    availableFrom,
    locations,
    suburb,
    state: stateCode,
    postcode,
    sessions,
    locationChoice
  };

  const derivation = candidatePathway.derivePathwayFromOnboarding(answers);

  const storedType = registrationType === 'unsure' ? null : registrationType;
  const onSpecialistRegister = registrationType === 'specialist' || registrationType === 'general_and_specialist';
  const hasGpFellowship = fellowship === 'fracgp' || fellowship === 'facrrm' || fellowship === 'both';
  let vrStatus = 'unsure';
  if (onSpecialistRegister && hasGpFellowship) vrStatus = 'vr';
  else if (fellowship === 'none' || fellowship === 'registrar') vrStatus = 'non_vr';

  const credentialsPatch = {
    ahpra_number: reg.number,
    ahpra_registration_type: storedType,
    specialist_gp: storedType ? onSpecialistRegister : null,
    // One question covers conditions, undertakings and notations, so only the
    // first flag is the doctor's answer. The other two stay unset until the
    // staff register check (WP-06) records each one.
    has_conditions: hasConditions,
    conditions_text: conditionsDetail || null,
    fellowship_type: fellowship === 'registrar' ? 'none' : fellowship,
    fellowship_detail: fellowshipDetail || null,
    vr_status: vrStatus,
    moratorium_19ab_status: moratorium19ab,
    work_rights: workRightsRow.stored,
    visa_subclass: permitSubclass || null,
    visa_expiry: permitExpiry
  };

  const preferencesPatch = {
    current_suburb: suburb || null,
    current_state: stateCode,
    current_postcode: postcode || null,
    notice_period_weeks: noticeWeeks,
    available_from: availableFrom,
    sessions_wanted: sessions
  };
  // WP-29: the base place's own coordinates (from the suburb list), and the
  // commute distance when that is what they chose. Existing columns.
  if (locationChoice) {
    preferencesPatch.current_latitude = typeof locationChoice.base.lat === 'number' ? locationChoice.base.lat : null;
    preferencesPatch.current_longitude = typeof locationChoice.base.lng === 'number' ? locationChoice.base.lng : null;
    preferencesPatch.commute_radius_km = locationChoice.travel === auLocationMatch.TRAVEL.COMMUTE ? auLocationMatch.COMMUTE_RADIUS_KM : null;
  }

  // user_profiles.preferred_city is one city and drives role ranking by exact
  // match (practice-pipeline rankRolesForGp). The first city the doctor picked
  // goes there; a doctor who picked only regional areas has no single city.
  // The full list stays on the onboarding record (gp_onboarding.au.locations).
  const preferredCity = locations.filter(function (l) { return AU_CITY_LOCATIONS.indexOf(l) !== -1; })[0] || '';
  // (With a structured choice, `locations` was filled from it above, so this
  // is auLocationMatch.preferredCityFor(choice).)

  return {
    ok: true,
    errors: {},
    answers,
    credentialsPatch,
    preferencesPatch,
    register: { body: 'ahpra', number: reg.number },
    preferredCity,
    derivation
  };
}

/**
 * The wizard blob as it is stored for an Australian doctor: the browser's own
 * blob, with the Australian answers replaced by the cleaned ones so nothing
 * unchecked is kept.
 */
function storedAuOnboardingBlob(body, validation, nowIso) {
  const src = isPlainObject(body) ? body : {};
  const out = Object.assign({}, src);
  const a = validation.answers;
  out.auBranch = 'yes';
  out.country = AU_COUNTRY_CODE;
  out.registerNumber = a.ahpraNumber;
  out.completedAt = typeof src.completedAt === 'string' && src.completedAt ? src.completedAt : nowIso;
  out.au = {
    ahpraNumber: a.ahpraNumber,
    registrationType: a.registrationType,
    fellowship: a.fellowship,
    fellowshipDetail: a.fellowshipDetail,
    hasConditions: a.hasConditions,
    conditionsDetail: a.conditionsDetail,
    moratorium19ab: a.moratorium19ab,
    workRights: (WORK_RIGHTS_ANSWERS.filter(function (o) { return o.stored === a.workRights; })[0] || {}).value || '',
    permitSubclass: a.permitSubclass,
    permitExpiry: a.permitExpiry || '',
    currentPractice: a.currentPractice,
    noticeWeeks: a.noticeWeeks,
    availableFrom: a.availableFrom,
    locations: a.locations.slice(),
    suburb: a.suburb,
    state: a.state,
    postcode: a.postcode,
    sessions: a.sessions,
    // WP-29: what the screen needs to draw the choice again (ids and labels
    // only; the authoritative copy is the server's own, never this blob).
    base: a.locationChoice ? { id: a.locationChoice.base.id, label: a.locationChoice.base.label } : null,
    travel: a.locationChoice ? a.locationChoice.travel : '',
    places: a.locationChoice ? a.locationChoice.places.map(function (pl) { return { id: pl.id, label: pl.label }; }) : [],
    detailsConfirmed: true,
    step: isPlainObject(src.au) && Number.isInteger(src.au.step) ? src.au.step : 0
  };
  return out;
}

/**
 * Keep the server-owned "started the Australian branch" marker in step with a
 * saved wizard blob. Mutates and returns `state` (the user_state object about
 * to be written). An overseas doctor's blob has no auBranch and no marker, so
 * nothing changes for them.
 */
function reconcileAuBranchMarker(state, blob, nowIso) {
  if (!isPlainObject(state)) return state;
  let parsed = blob;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch (e) { parsed = null; } }
  const started = isAuOnboardingPayload(parsed) && !parsed.completedAt;
  if (started) {
    if (!state[AU_BRANCH_MARKER_KEY]) state[AU_BRANCH_MARKER_KEY] = nowIso || new Date().toISOString();
  } else if (Object.prototype.hasOwnProperty.call(state, AU_BRANCH_MARKER_KEY)) {
    delete state[AU_BRANCH_MARKER_KEY];
  }
  // FR-1 (R-01): the doctor's own answer outranks where they signed up from.
  if (Object.prototype.hasOwnProperty.call(state, AU_SIGNUP_AUDIENCE_KEY) && blobSaysNotAustralian(parsed)) {
    delete state[AU_SIGNUP_AUDIENCE_KEY];
  }
  return state;
}

/**
 * The invite sent to a doctor who was put on the eligibility waitlist and is
 * already registered in Australia (COM-07 / WEB-01). Returns the parts
 * sendGpNotificationEmail takes; `{{name}}` is filled in by that function.
 * Australian wording only: none of the words in AGENT-RULES section 4.
 */
function buildAuWaitlistInviteEmail(input) {
  const i = input && typeof input === 'object' ? input : {};
  const base = String(i.appBaseUrl || '').replace(/\/+$/, '');
  return {
    subject: 'You can now complete your GP Link profile',
    title: 'Good news, {{name}}: you can now complete your profile',
    body: 'You told us you are already registered in Australia. GP Link now works with GPs who hold Ahpra registration and are practising here, so you can finish setting up your profile.\n\n'
      + 'It takes about five minutes. Have your Ahpra registration number to hand, and a passport or driver\'s licence for the identity check.\n\n'
      + 'Your enquiry is confidential. We never contact your current practice without asking you first.',
    ctaText: 'Complete my profile',
    ctaUrl: base + '/pages/onboarding?au=1',
    footer: 'If you are not registered with Ahpra, you can ignore this email.'
  };
}

/**
 * FR-1 (R-02). THE rule for what an Australian onboarding completion may do to
 * the pathway, given what is already on record. Pure. A later self-answer
 * never loosens the pathway.
 *
 *   stored pathway             onboarding    answers give      -> action
 *   -------------------------  ------------  ----------------  ---------
 *   none / overseas            not finished  anything          write (first-time answer; the first question's purpose)
 *   overseas, SET BY STAFF     either        anything          refuse (FR-7 S7-01: the wizard follows the recorded pathway;
 *                                                              a doctor's answers never replace a pathway a person recorded)
 *   none / overseas            finished      anything          refuse (only staff move a doctor between overseas and Australian)
 *   Australian, set by staff   either        same              keep
 *   Australian, set by staff   either        different         keep, differs (a person decides)
 *   Australian, self-declared  either        same              keep
 *   au_vr, self, unconfirmed   either        B or C            tighten (written; still flagged)
 *   Australian, self-declared  either        any other change  keep, differs (a person decides)
 *
 * "Self-declared" means pathway_set_by is 'self'. An Australian pathway with
 * no set-by at all is treated as staff-set (the stricter reading).
 *
 * @param {object} input
 * @param {string|null} input.storedPathway   user_profiles.candidate_pathway
 * @param {string|null} input.setBy           user_profiles.pathway_set_by
 * @param {boolean} input.confirmed           staff confirmed the stored pathway
 * @param {boolean} input.onboardingComplete  either wizard was finished before
 * @param {string} input.derivedPathway       derivePathwayFromOnboarding(...).pathway for THIS submission
 * @param {boolean} [input.staffSetOverseas]  candidatePathway.isStaffSetOverseasProfile(profile)
 * @returns {{ action: 'write'|'keep'|'tighten'|'refuse', reason: string, storedPathway: string|null,
 *            differs: boolean, setBySelf: boolean, confirmed: boolean }}
 */
function decideAuOnboardingPathwayWrite(input) {
  const i = input && typeof input === 'object' ? input : {};
  const storedRaw = String(i.storedPathway == null ? '' : i.storedPathway).trim().toLowerCase();
  const stored = candidatePathway.isValidPathway(storedRaw) ? storedRaw : null;
  const derived = String(i.derivedPathway == null ? '' : i.derivedPathway).trim().toLowerCase();
  const setBySelf = String(i.setBy == null ? '' : i.setBy).trim().toLowerCase() === 'self';
  const confirmed = i.confirmed === true;
  const base = { storedPathway: stored, differs: false, setBySelf: false, confirmed: false };
  if (!stored || !candidatePathway.isAuPathway(stored)) {
    // FR-7 (S7-01): an overseas pathway a person recorded stands. Before this,
    // a doctor staff had moved to overseas could finish the Australian wizard
    // still open on their device and become Australian again.
    if (stored && i.staffSetOverseas === true) return Object.assign(base, { action: 'refuse', reason: 'staff_overseas_pathway' });
    if (i.onboardingComplete === true) return Object.assign(base, { action: 'refuse', reason: 'already_onboarded_not_australian' });
    return Object.assign(base, { action: 'write', reason: 'first_time' });
  }
  const out = Object.assign(base, { setBySelf: setBySelf, confirmed: confirmed, differs: derived !== stored });
  if (!out.differs) return Object.assign(out, { action: 'keep', reason: 'same_answers' });
  if (setBySelf && !confirmed && candidatePathway.isLaunchedAuPathway(stored)
    && candidatePathway.isAuPathway(derived) && !candidatePathway.isLaunchedAuPathway(derived)) {
    return Object.assign(out, { action: 'tighten', reason: 'self_more_restricted' });
  }
  return Object.assign(out, { action: 'keep', reason: setBySelf ? 'self_answers_differ' : 'staff_pathway' });
}

module.exports = {
  decideAuOnboardingPathwayWrite,
  AU_SIGNUP_AUDIENCE_KEY,
  AU_SIGNUP_AUDIENCE_VALUE,
  hasAuSignupAudience,
  isAuSignupAudienceMarker,
  blobSaysNotAustralian,
  AU_BRANCH_MARKER_KEY,
  AU_COUNTRY_CODE,
  AU_COUNTRY_NAME,
  REGISTRATION_TYPE_ANSWERS,
  FELLOWSHIP_ANSWERS,
  MORATORIUM_ANSWERS,
  WORK_RIGHTS_ANSWERS,
  NOTICE_WEEKS_MAX,
  SESSIONS_MIN,
  SESSIONS_MAX,
  MAX_LOCATIONS,
  ANYWHERE_LOCATION,
  AU_REGIONAL_STATES,
  AU_CITY_LOCATIONS,
  AU_REGIONAL_LOCATIONS,
  AU_LOCATIONS,
  isAuOnboardingPayload,
  validateAuOnboarding,
  storedAuOnboardingBlob,
  reconcileAuBranchMarker,
  buildAuWaitlistInviteEmail
};

'use strict';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * Australian GP build, WP-29.
 * sortDoctorByWhereTheyCanWork: THE ONE RULE that sorts an Australian-pathway
 * doctor by where they can and cannot work. Pure: no database, no network, no
 * clock (the caller passes today's date). Everything else reads its answer:
 *
 *   lib/candidate-pathway.js   puts it on the resolver result (`sorting`) and
 *                              derives `dpaRestricted`, the hold and `roleFit`
 *                              from it;
 *   lib/role-eligibility.js    applies it to each role, and to the
 *                              "Submit to practice" step.
 *
 * IN PLAIN WORDS
 *
 * Every Australian-pathway doctor lands in exactly one group:
 *
 *   anywhere      a vocationally registered GP with no location limit.
 *                 Sees every role.
 *   dpa_only      a vocationally registered GP who may, for now, only work in
 *                 a Distribution Priority Area. Sees DPA roles only (a role
 *                 whose DPA status is "not sure" is not shown).
 *   registrar     says they are a GP registrar (in training). GP Link does not
 *                 place registrars: shown no roles and told so plainly.
 *   non_vr_held   not vocationally registered and not a registrar. Held, as
 *                 before (owner decision 5).
 *
 * and may also carry `needsPerson` (a person has to look): then the doctor
 * sees DPA roles at most, and nothing at all when the number was not found,
 * the name does not match the number, or the register does not say
 * "Registered".
 *
 * WHERE THE ANSWER COMES FROM, best first:
 *   1. what STAFF have confirmed (always wins, both ways);
 *   2. the public Ahpra register, when a lookup worked AND the name on the
 *      register matches the account;
 *   3. the doctor's own onboarding answers.
 * When the register and the doctor disagree, the more restrictive answer
 * applies until staff decide, and staff are shown the disagreement.
 *
 * SECTION 19AB (the "ten year moratorium"), as this rule applies it. Section
 * 19AB of the Health Insurance Act limits where some doctors can work under
 * Medicare to Distribution Priority Areas. It applies to:
 *   - doctors whose primary medical degree is from outside Australia and New
 *     Zealand ("trained abroad"), and
 *   - doctors who graduated from an accredited Australian or New Zealand
 *     medical school but were not a citizen or permanent resident when they
 *     began the degree.
 * It runs for ten years from the doctor's first Australian registration.
 * After ten years it ends for citizens and permanent residents, but NOT for
 * temporary residents. Exemptions and scaling (time off for working in more
 * remote areas) exist and CANNOT be seen by this app.
 *
 * So this is the owner's simplification of the law ("if it says expedited
 * pathway or PEP pathway and the date is less than ten years since their
 * first registration, they need to work in a DPA"), made precise. It is not
 * legal advice, IT ERRS TO RESTRICTED whenever something is not known, and
 * staff can override it with a confirmed 19AB answer.
 *
 * SUPERVISION NEVER FILTERS ROLES. Every GP Link practice accepts supervised
 * doctors, so a supervision requirement is a fact shown to staff
 * ("Supervision required: Indirect 2"), not a gate.
 * ════════════════════════════════════════════════════════════════════════════
 */

const GROUP = Object.freeze({ ANYWHERE: 'anywhere', DPA_ONLY: 'dpa_only', REGISTRAR: 'registrar', NON_VR_HELD: 'non_vr_held' });
const BASIS = Object.freeze({ STAFF: 'staff', REGISTER: 'register', SELF: 'self' });
const TEN_YEARS = 10;

// ── patterns, each in ONE place ──────────────────────────────────────────────

// The register names the pathway a doctor came through in its "Registration
// Requirements" box ("Pathway: Expedited Specialist Pathway") and in the
// condition headings ("… – Expedited Specialist pathway"). Either of these two
// pathways means the doctor qualified outside Australia and New Zealand.
const TRAINED_ABROAD_PATHWAY_PATTERNS = Object.freeze([
  /\bexpedited\s+specialist\s+pathway\b/i,
  /\bpractice\s+experience\s+(program|programme|pathway)\b/i,
  /\bPEP\b/
]);

// A PRIMARY medical degree (the one that made the person a doctor), as the
// register prints qualification titles.
const PRIMARY_DEGREE_PATTERNS = Object.freeze([
  /\bM\.?B\.?\s?B\.?S\.?\b/i, /\bM\.?B\.?\s?Ch\.?\s?B\.?\b/i, /\bM\.?B\.?\s?B\.?\s?Ch\.?\b/i, /\bB\.?M\.?\s?B\.?S\.?\b/i,
  /\bB\.?\s?Med\b/i, /\bbachelor of medicine\b/i, /\bbachelor of surgery\b/i, /\bdoctor of medicine\b/i,
  /\bM\.?D\.?\b/, /\bmedical degree\b/i, /\bmedicinae\b/i
]);
// …and what is NOT one, even if it contains one of the words above.
const NOT_PRIMARY_DEGREE = /\b(fellow(ship)?|member(ship)?|diploma|master('?s)?|certificate|doctor of philosophy|ph\.?d|F?RACGP|FACRRM|MRCGP|MRCP|FRCGP|FRNZCGP)\b/i;

// Countries that count as "trained here".
const HOME_COUNTRIES = /^(australia|new zealand|aotearoa new zealand)$/i;
// Medical schools in Australia and New Zealand, for a qualification line that
// has no country word. Anything not on this list is "cannot tell", never
// "Australian".
const HOME_MEDICAL_SCHOOLS = Object.freeze([
  'university of sydney', 'university of new south wales', 'unsw', 'university of newcastle', 'western sydney university',
  'university of western sydney', 'university of wollongong', 'macquarie university', 'university of notre dame australia',
  'university of new england', 'university of melbourne', 'monash university', 'deakin university', 'university of queensland',
  'griffith university', 'bond university', 'james cook university', 'university of adelaide', 'flinders university',
  'university of western australia', 'curtin university', 'university of tasmania', 'australian national university',
  'charles sturt university', 'university of otago', 'university of auckland'
]);

// The standard supervised-practice condition set. A doctor who came through
// the Expedited Specialist pathway is given the same numbered conditions; when
// EVERY top-level heading on the register matches one of these, the block is
// "standard" and does not need a person. Source text (the owner's example,
// 25 November 2026; tests/fixtures/ahpra-register/details-standard-supervised-practice.html):
//   "1. Complete supervised practice for suitability and eligibility – Expedited Specialist pathway"
//   "2. Complete multi-source feedback for medical practitioners – Expedited Specialist pathway"
//   "3. Complete board-directed program of education – Orientation, cultural safety and/or specialty specific requirements"
// Anything else, or a heading that cannot be read, needs a person.
const STANDARD_CONDITION_HEADINGS = Object.freeze([
  /^complete supervised practice for suitability and eligibility\b/i,
  /^complete multi-source feedback for medical practitioners\b/i,
  /^complete board-directed program of education\b/i
]);
const CONDITION_PREAMBLE = /^on \d{1,2} [a-z]+ \d{4}, the medical board of australia \(the board\) imposed conditions\.?$/i;

function token(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

/** yyyy-mm-dd from a Date, an ISO string or a yyyy-mm-dd string. '' when unusable. */
function dayOf(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/**
 * The calendar date ten years after a first-registration date. A 29 February
 * has no anniversary in a non-leap year: the restriction then ends on 1 March
 * (the later, careful reading).
 */
function addYears(day, years) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return '';
  const y = Number(m[1]) + years; const mo = Number(m[2]); const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return y + '-03-01';
  return y + '-' + m[2] + '-' + m[3];
}

/**
 * Is a conditions block the standard supervised-practice set?
 * @returns {{ standard: boolean, headings: string[], unrecognised: string[] }}
 */
function classifyConditions(text) {
  const out = { standard: false, headings: [], unrecognised: [] };
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return out;
  let seenHeading = false;
  let strayPreamble = false;
  raw.split('\n').forEach(function (line) {
    const l = line.trim();
    if (!l) return;
    const m = /^(\d{1,2})\.\s+(\S.*)$/.exec(l);
    if (m) {
      seenHeading = true;
      out.headings.push(m[2]);
      if (!STANDARD_CONDITION_HEADINGS.some(function (re) { return re.test(m[2]); })) out.unrecognised.push(m[2]);
      return;
    }
    if (!seenHeading && !CONDITION_PREAMBLE.test(l)) strayPreamble = true;
  });
  out.standard = out.headings.length > 0 && out.unrecognised.length === 0 && !strayPreamble;
  if (strayPreamble && !out.unrecognised.length) out.unrecognised.push('text before the first numbered condition');
  return out;
}

/** The doctor's primary medical degree among the listed qualifications (the earliest), or null. */
function primaryMedicalDegree(qualifications) {
  const list = (Array.isArray(qualifications) ? qualifications : []).filter(function (q) {
    const title = String((q && q.title) || '');
    return !!title && !NOT_PRIMARY_DEGREE.test(title) && PRIMARY_DEGREE_PATTERNS.some(function (re) { return re.test(title); });
  });
  if (!list.length) return null;
  list.sort(function (a, b) { return (Number(a.year) || 9999) - (Number(b.year) || 9999); });
  return list[0];
}

/** 'home' | 'abroad' | 'unknown' for one qualification line. */
function trainedWhere(qualification) {
  const q = qualification || {};
  const country = String(q.country || '').trim();
  if (country) return HOME_COUNTRIES.test(country) ? 'home' : 'abroad';
  const school = token(q.institution);
  if (school && HOME_MEDICAL_SCHOOLS.some(function (name) { return school.indexOf(name) !== -1; })) return 'home';
  return 'unknown';
}

/**
 * What the register facts say about location, on their own. Pure.
 *
 *   trainedAbroad   true | false | 'unknown'
 *     true    the register names the Expedited Specialist Pathway or the
 *             Practice Experience Program / PEP, OR the primary medical degree
 *             is from outside Australia and New Zealand
 *     false   ONLY when a primary medical degree is positively identified as
 *             Australian or New Zealand and neither pathway is named
 *     unknown everything else (no primary degree can be told, country missing)
 *   yearsSinceFirstRegistration   whole years, or null when the date is unknown
 *   tenYearsOn                    the date ten years after first registration ('' unknown)
 *   withinTenYears                true | false | null (unknown)
 *
 * @param {object} facts  lib/ahpra-register-lookup.js facts
 * @param {string|Date} now  today's calendar date
 */
function registerDerivedRestrictions(facts, now) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const req = f.requirements && typeof f.requirements === 'object' ? f.requirements : {};
  const words = [req.pathway, req.raw, f.conditions && f.conditions.text].filter(Boolean).join('\n');
  const pathwayNamed = TRAINED_ABROAD_PATHWAY_PATTERNS.some(function (re) { return re.test(words); });
  const primary = primaryMedicalDegree(f.qualifications);
  const where = primary ? trainedWhere(primary) : 'unknown';
  let trainedAbroad = 'unknown';
  if (pathwayNamed || where === 'abroad') trainedAbroad = true;
  else if (where === 'home') trainedAbroad = false;

  const today = dayOf(now);
  const first = dayOf(f.firstRegistrationDate);
  const tenYearsOn = first ? addYears(first, TEN_YEARS) : '';
  let withinTenYears = null;
  let years = null;
  if (first && today && tenYearsOn) {
    withinTenYears = today < tenYearsOn;
    years = Number(today.slice(0, 4)) - Number(first.slice(0, 4)) - (today.slice(5) < first.slice(5) ? 1 : 0);
    if (years < 0) years = 0;
  }
  return {
    trainedAbroad, pathwayNamed, primaryDegree: primary ? { title: primary.title, country: primary.country || null, year: primary.year || null, where } : null,
    firstRegistrationDate: first || null, tenYearsOn: tenYearsOn || null, withinTenYears, yearsSinceFirstRegistration: years
  };
}

// The fields the rule cannot do without. A parse warning on any of them means
// a person looks.
const NEEDED_FIELDS = Object.freeze(['name', 'status', 'expiry', 'registrationType', 'specialty', 'conditions', 'conditionsText', 'undertakings', 'reprimands', 'notations']);

const PERSON_REASON_TEXT = Object.freeze({
  not_found: 'The registration number was not found on the Ahpra register.',
  name_mismatch: 'The name on the Ahpra register for that number does not match the name on the account.',
  not_registered: 'The register does not show the status "Registered".',
  expired: 'The registration expiry date on the register has passed.',
  declared_vr_register_not_specialist_gp: 'The doctor said they are a vocationally registered GP, but the register does not show specialist registration in general practice.',
  declared_not_vr_register_specialist_gp: 'The doctor did not say they are a vocationally registered GP, but the register shows specialist registration in general practice. They may have answered wrongly.',
  undertakings: 'The register shows an undertaking.',
  reprimands: 'The register shows a reprimand.',
  notations: 'The register shows a notation.',
  conditions_not_standard: 'The register shows a condition that is not the standard supervised-practice set.',
  conditions_declared_not_reviewed: 'The doctor said their registration has a condition, undertaking or notation, and no person has reviewed it yet.',
  flags_not_reviewed: 'A condition, undertaking or notation is on file that no person has reviewed yet.',
  parse_warnings: 'Part of the register page could not be read with confidence.',
  restriction_not_on_file: 'The doctor is recorded as restricted, but nothing on file says why.',
  last_check_not_verified: 'A person recorded that the Ahpra number could not be matched to this doctor. Check the register again and save the check.',
  register_and_doctor_disagree_19ab: 'The doctor and the register disagree about the 19AB moratorium. The more restrictive answer is applied until you confirm.'
});

/**
 * THE RULE.
 *
 * @param {object} input
 * @param {object|null} input.registerFacts  what a register lookup found, or
 *        null when there is no usable lookup (provider off, lookup failed).
 *          { found: false }                         the number is not on the register
 *          { found: true, nameMatch: boolean, ...facts }
 *        `nameMatch` is worked out by the server with the existing name
 *        matcher (surname strict). Facts whose name does not match are never
 *        used to open anything.
 * @param {object} input.doctorAnswers  the doctor's own onboarding answers
 *          registrar: boolean        said they are a GP registrar
 *          vr: boolean|null          said specialist (GP) registration with FRACGP / FACRRM
 *          moratorium19ab: 'yes'|'no'|'unsure'|null
 *          workRights: 'citizen'|'pr'|'visa'|null
 *          hasConditions: boolean|null
 *          unexplainedRestriction: boolean   recorded as restricted with nothing on file saying why
 * @param {object} input.staffConfirmed  what a PERSON on staff has confirmed
 *          moratorium19ab: 'yes'|'no'|null   (with who / when; the override)
 *          moratoriumBy, moratoriumAt
 *          pathway: string|null        a pathway a person confirmed
 *          checkByPerson: boolean      a person saved the register check as verified
 *          checkComplete: boolean      the check is saved as verified (person OR lookup)
 *          lastCheckUnverified: boolean  a check was finished but not as verified
 *          vr: boolean|null            from a person's check
 *          workRights: string|null     from a person's check
 *          sponsorTied: boolean|null
 *          hasFlags: boolean, flagsReviewed: boolean
 *          supervisionLevel: string|null
 * @param {string|Date} input.now  today's calendar date
 * @returns {{
 *   group, vr, dpaOnly, held, holdKind, needsPerson, personReasons: [{code,text}],
 *   reasons: string[], staffFlags: [{code,text,...}], basis, basisLine,
 *   dpaSentence, canAutoCompleteCheck, autoCompleteBlockers: string[],
 *   register: object|null (registerDerivedRestrictions), conditions: object|null
 * }}
 */
function sortDoctorByWhereTheyCanWork(input) {
  const i = input && typeof input === 'object' ? input : {};
  const answers = i.doctorAnswers && typeof i.doctorAnswers === 'object' ? i.doctorAnswers : {};
  const staff = i.staffConfirmed && typeof i.staffConfirmed === 'object' ? i.staffConfirmed : {};
  const today = dayOf(i.now);
  const reg = i.registerFacts && typeof i.registerFacts === 'object' ? i.registerFacts : null;

  const reasons = [];
  const personCodes = [];
  const person = function (code) { if (personCodes.indexOf(code) === -1) personCodes.push(code); };
  const staffFlags = [];
  const flag = function (code, text, extra) { staffFlags.push(Object.assign({ code, text }, extra || {})); };

  // ── the register: usable, or a hard stop ───────────────────────────────────
  // A person's own saved check outranks an earlier lookup that found nothing
  // or the wrong name: the person has looked.
  let regState = 'none';
  if (reg) {
    if (reg.found !== true) regState = 'not_found';
    else if (reg.nameMatch !== true) regState = 'name_mismatch';
    else regState = 'ok';
  }
  if (staff.checkByPerson === true && regState !== 'ok') regState = 'none';
  const facts = regState === 'ok' ? reg : null;
  const derived = facts ? registerDerivedRestrictions(facts, today) : null;
  const conditions = facts && facts.conditions && facts.conditions.present === true ? classifyConditions(facts.conditions.text) : null;

  let hardStop = false;
  if (regState === 'not_found') { person('not_found'); hardStop = true; }
  if (regState === 'name_mismatch') { person('name_mismatch'); hardStop = true; }
  const lookedByPerson = staff.checkByPerson === true;
  if (facts) {
    const registered = /^registered$/i.test(String(facts.status || '').trim());
    if (!registered && !lookedByPerson) { person('not_registered'); hardStop = true; }
    if (!lookedByPerson) {
      const expiry = dayOf(facts.expiry);
      if (expiry && today && expiry < today) person('expired');
      if (facts.undertakings && facts.undertakings.present === true) person('undertakings');
      if (facts.reprimands && facts.reprimands.present === true) person('reprimands');
      if (facts.notations && facts.notations.present === true) person('notations');
      if (conditions && !conditions.standard) person('conditions_not_standard');
      const warned = Array.isArray(facts.parseWarnings) ? facts.parseWarnings : [];
      if (warned.some(function (w) { return NEEDED_FIELDS.indexOf(w) !== -1; })) person('parse_warnings');
    }
  }
  // Without a lookup, a condition the doctor told us about still needs a
  // person, as does a flag staff recorded that nobody has reviewed.
  if (!facts && answers.hasConditions === true && staff.flagsReviewed !== true) person('conditions_declared_not_reviewed');
  if (staff.hasFlags === true && staff.flagsReviewed !== true && lookedByPerson) person('flags_not_reviewed');
  if (answers.unexplainedRestriction === true && !facts) person('restriction_not_on_file');
  // A register check that a person finished as "number not matched": until a
  // check is saved as verified the doctor sees priority-area roles at most. (Before
  // WP-29 the same thing happened because the staff 19AB answer was
  // withdrawn; the doctor's own answer must not undo that now.)
  if (staff.lastCheckUnverified === true) person('last_check_not_verified');

  // ── vocationally registered? ───────────────────────────────────────────────
  const staffPathway = token(staff.pathway);
  const saidRegistrar = answers.registrar === true;
  const registrar = staffPathway ? staffPathway === 'au_registrar' : saidRegistrar;
  let vr;
  if (staffPathway === 'au_vr') vr = true;
  else if (staffPathway === 'au_non_vr' || staffPathway === 'au_registrar') vr = false;
  else if (typeof staff.vr === 'boolean') vr = staff.vr;
  else if (facts) {
    const onRegister = facts.specialistGp === true;
    if (onRegister && answers.vr === true) vr = true;
    else {
      vr = false;
      if (onRegister && !saidRegistrar) person('declared_not_vr_register_specialist_gp');
      if (!onRegister && answers.vr === true) person('declared_vr_register_not_specialist_gp');
    }
  } else vr = answers.vr === true;
  if (registrar && facts && facts.specialistGp === true) {
    flag('registrar_but_register_specialist_gp', 'The doctor said they are a GP registrar, but the register shows specialist registration in general practice. They may have answered wrongly: check with them.');
  }

  // ── location ───────────────────────────────────────────────────────────────
  const rights = token(staff.workRights) || token(answers.workRights);
  const residentPermanent = rights === 'citizen' || rights === 'pr' ? true : (rights === 'visa' ? false : null);
  const said = token(answers.moratorium19ab);
  const staff19ab = token(staff.moratorium19ab);
  let dpaOnly;
  let basis;
  if (staff19ab === 'no') { dpaOnly = false; basis = BASIS.STAFF; reasons.push('staff_confirmed_19ab_not_applicable'); }
  else if (staff19ab === 'yes') { dpaOnly = true; basis = BASIS.STAFF; reasons.push('staff_confirmed_19ab_applies'); }
  else {
    const selfRestricted = said !== 'no';
    if (residentPermanent === false) reasons.push('temporary_resident');
    if (derived) {
      basis = BASIS.REGISTER;
      let registerRestricted;
      if (derived.trainedAbroad === true) {
        registerRestricted = !(derived.withinTenYears === false && residentPermanent === true);
        reasons.push(registerRestricted
          ? (derived.withinTenYears === false ? 'trained_abroad_not_permanent_resident' : (derived.withinTenYears === null ? 'trained_abroad_first_registration_unknown' : 'trained_abroad_within_ten_years'))
          : 'trained_abroad_ten_years_passed');
        // The doctor's own answer cannot loosen this, and "yes" from the
        // doctor against a register that says the ten years have passed is a
        // disagreement: restricted until staff decide.
        dpaOnly = registerRestricted || said === 'yes';
        if ((said === 'no' && registerRestricted) || (said === 'yes' && !registerRestricted)) person('register_and_doctor_disagree_19ab');
      } else if (derived.trainedAbroad === false) {
        // Trained here: the only way 19AB can apply is "was not a citizen or
        // permanent resident when the degree began", which only the doctor
        // can tell us. No answer, or "not sure", stays restricted.
        dpaOnly = selfRestricted;
        reasons.push(selfRestricted ? (said === 'yes' ? 'self_declared_19ab_applies' : '19ab_unknown') : 'trained_here_and_says_19ab_does_not_apply');
      } else {
        dpaOnly = true;
        reasons.push('training_country_unknown');
      }
    } else {
      basis = BASIS.SELF;
      dpaOnly = selfRestricted;
      reasons.push(said === 'yes' ? 'self_declared_19ab_applies' : (said === 'no' ? 'self_declared_19ab_does_not_apply' : '19ab_unknown'));
    }
    if (residentPermanent === false) dpaOnly = true;
  }
  const needsPerson = personCodes.length > 0;
  // While a person is needed the doctor sees DPA roles at most.
  if (needsPerson && basis !== BASIS.STAFF) dpaOnly = true;
  if (needsPerson && basis === BASIS.STAFF && hardStop) dpaOnly = true;

  // ── the group ──────────────────────────────────────────────────────────────
  let group;
  if (registrar) group = GROUP.REGISTRAR;
  else if (!vr) group = GROUP.NON_VR_HELD;
  else group = dpaOnly ? GROUP.DPA_ONLY : GROUP.ANYWHERE;
  const held = group === GROUP.REGISTRAR || group === GROUP.NON_VR_HELD || hardStop;
  const holdKind = !held ? null : (group === GROUP.REGISTRAR ? 'registrar' : 'review');

  // ── facts for staff (never change what the doctor sees) ─────────────────────
  const req = facts && facts.requirements ? facts.requirements : null;
  const superviseLevel = (req && req.supervisionLevel) || (staff.supervisionLevel && token(staff.supervisionLevel) !== 'none' ? String(staff.supervisionLevel) : '');
  if ((req && req.supervisionRequired === true) || superviseLevel) {
    flag('supervision_required', 'Supervision required' + (superviseLevel ? ': ' + superviseLevel : '') + '. (Every GP Link practice accepts supervised doctors, so this does not hide any role.)', { level: superviseLevel || null });
  }
  if (req && req.approvedLocationsOnly === true) {
    flag('approved_locations_only', 'Registration is tied to approved practice locations: a move needs a new Board approval for the new practice.');
  }
  if (residentPermanent === false && staff.sponsorTied !== false) {
    flag('temporary_resident_needs_sponsor', 'Temporary resident: needs the new practice to sponsor them or take over the nomination. They are shown only roles whose practice says it offers sponsorship.');
  }
  if (derived && derived.trainedAbroad === true && derived.withinTenYears === true && residentPermanent === true && derived.tenYearsOn) {
    flag('moratorium_ends_on', 'The ten years from first registration end on ' + derived.tenYearsOn + '.', { date: derived.tenYearsOn });
  }

  // ── may the register check complete without a person? ──────────────────────
  const blockers = [];
  if (regState !== 'ok') blockers.push(regState === 'none' ? 'no_lookup' : regState);
  else {
    if (!/^registered$/i.test(String(facts.status || '').trim())) blockers.push('not_registered');
    const expiry = dayOf(facts.expiry);
    if (!expiry || !today || expiry < today) blockers.push('expired_or_unknown_expiry');
    if (facts.specialistGp !== true) blockers.push('not_specialist_gp');
    if (answers.vr !== true || saidRegistrar) blockers.push('does_not_match_declaration');
    if (!facts.undertakings || facts.undertakings.present !== false) blockers.push('undertakings');
    if (!facts.reprimands || facts.reprimands.present !== false) blockers.push('reprimands');
    if (!facts.notations || facts.notations.present !== false) blockers.push('notations');
    if (!facts.conditions || (facts.conditions.present !== false && !(conditions && conditions.standard))) blockers.push('conditions_not_standard');
    const warned = Array.isArray(facts.parseWarnings) ? facts.parseWarnings : [];
    if (warned.some(function (w) { return NEEDED_FIELDS.indexOf(w) !== -1; })) blockers.push('parse_warnings');
  }

  // ── one sentence for staff ─────────────────────────────────────────────────
  let basisLine;
  if (basis === BASIS.STAFF) basisLine = 'Sorted from what staff confirmed' + (staff.moratoriumBy ? ' (' + staff.moratoriumBy + ')' : '') + '.';
  else if (basis === BASIS.REGISTER) basisLine = 'Sorted from the Ahpra register lookup' + (facts.fetchedAt ? ' on ' + dayOf(facts.fetchedAt) : '') + '.';
  else basisLine = "Sorted from the doctor's own answers, not yet checked.";
  let dpaSentence = '';
  if (group === GROUP.DPA_ONLY || (dpaOnly && group !== GROUP.ANYWHERE)) {
    if (hardStop) dpaSentence = 'Shown no roles until a person has looked.';
    else if (basis === BASIS.STAFF) dpaSentence = 'Staff confirmed the 19AB moratorium applies.';
    else if (reasons.indexOf('trained_abroad_within_ten_years') !== -1) {
      dpaSentence = 'Trained outside Australia and New Zealand, first registered ' + derived.firstRegistrationDate + ': restricted until ' + derived.tenYearsOn + ', or until staff confirm an exemption.';
    } else if (reasons.indexOf('trained_abroad_first_registration_unknown') !== -1) dpaSentence = 'Trained outside Australia and New Zealand and the first registration date could not be read: restricted until staff confirm.';
    else if (reasons.indexOf('trained_abroad_not_permanent_resident') !== -1) dpaSentence = 'Trained outside Australia and New Zealand; the ten years have passed, but the moratorium does not end for a temporary resident (or the right to work is not known).';
    else if (reasons.indexOf('temporary_resident') !== -1) dpaSentence = 'Temporary resident: restricted until staff confirm otherwise.';
    else if (reasons.indexOf('training_country_unknown') !== -1) dpaSentence = 'The register does not show where the primary medical degree is from: restricted until staff confirm.';
    else if (reasons.indexOf('self_declared_19ab_applies') !== -1) dpaSentence = 'The doctor says the 19AB moratorium applies to them.';
    else if (needsPerson && reasons.indexOf('19ab_unknown') === -1) dpaSentence = 'Restricted until a person has looked (see the reasons).';
    else dpaSentence = 'The doctor has not said whether the 19AB moratorium applies (or is not sure): restricted until staff confirm.';
  }

  return {
    group, vr: !!vr, dpaOnly: !!dpaOnly, held, holdKind,
    needsPerson, personReasons: personCodes.map(function (code) { return { code, text: PERSON_REASON_TEXT[code] || code }; }),
    reasons, staffFlags, basis, basisLine, dpaSentence,
    selfDeclaredOnly: basis === BASIS.SELF && !dpaOnly,
    canAutoCompleteCheck: blockers.length === 0, autoCompleteBlockers: blockers,
    register: derived, registerState: regState, conditions
  };
}

const GP_FELLOWSHIPS = Object.freeze(['fracgp', 'facrrm', 'both']);
const SPECIALIST_TYPES = Object.freeze(['specialist', 'general_and_specialist']);
const AUTO_ACTOR_PREFIX = 'automatic register lookup';
// What recordAhpraRegisterCheck appends to gp_credentials.ahpra_last_checked_by
// when a person saves the check as "number not matched".
const NOT_MATCHED_MARK = ' (number not matched)';

/** Was this "who" the automatic lookup rather than a person? */
function isAutomaticActor(by) { return token(by).indexOf(AUTO_ACTOR_PREFIX) === 0; }

/**
 * Build the rule's three inputs from the rows the server holds. Pure.
 *
 * @param {object} input
 * @param {string} input.pathway           the stored Australian pathway
 * @param {boolean} input.pathwayConfirmed a PERSON confirmed that pathway
 * @param {string} [input.pathwaySetBy]
 * @param {object|null} input.credentials  the gp_credentials row
 * @param {object|null} input.lookup       the stored lookup record
 *        ({ ok, found, nameMatch, facts }), or null
 */
function sortingInputsFromRecords(input) {
  const i = input && typeof input === 'object' ? input : {};
  const pathway = token(i.pathway);
  const c = i.credentials && typeof i.credentials === 'object' ? i.credentials : {};
  const checkComplete = !!c.staff_verified_at;
  const checkByPerson = checkComplete && !isAutomaticActor(c.staff_verified_by);
  const type = token(c.ahpra_registration_type);
  const credentialsVr = SPECIALIST_TYPES.indexOf(type) !== -1 && c.specialist_gp === true
    && (token(c.vr_status) === 'vr' || GP_FELLOWSHIPS.indexOf(token(c.fellowship_type)) !== -1);
  const hasFlags = c.has_conditions === true || c.has_undertakings === true || c.has_notations === true;
  const flagsReviewed = !!(c.flags_reviewed_at && token(c.flags_reviewed_by));
  const level = token(c.supervision_level);
  const staff19 = token(c.moratorium_19ab_confirmed_status);
  const staff19ok = (staff19 === 'yes' || staff19 === 'no') && !!c.moratorium_19ab_confirmed_at && !!token(c.moratorium_19ab_confirmed_by);
  const said19 = token(c.moratorium_19ab_status);
  const rights = token(c.work_rights);
  const saidVr = pathway === 'au_vr' ? true : (pathway === 'au_restricted' ? credentialsVr : false);
  const restrictionOnFile = hasFlags || rights === 'visa' || said19 === 'yes' || (staff19ok && staff19 === 'yes')
    || type === 'provisional' || type === 'limited' || (level !== '' && level !== 'none');

  let registerFacts = null;
  const lk = i.lookup && typeof i.lookup === 'object' ? i.lookup : null;
  if (lk && lk.ok === true) {
    registerFacts = lk.found === true && lk.facts ? Object.assign({}, lk.facts, { found: true, nameMatch: lk.nameMatch === true }) : { found: false };
  }
  return {
    registerFacts,
    doctorAnswers: {
      registrar: pathway === 'au_registrar',
      vr: saidVr,
      moratorium19ab: said19 === 'yes' || said19 === 'no' || said19 === 'unsure' ? said19 : null,
      workRights: checkByPerson ? null : (rights || null),
      hasConditions: checkByPerson ? null : (hasFlags ? true : (c.has_conditions === false ? false : null)),
      unexplainedRestriction: pathway === 'au_restricted' && i.pathwayConfirmed !== true && !restrictionOnFile
    },
    staffConfirmed: {
      moratorium19ab: staff19ok ? staff19 : null,
      moratoriumBy: staff19ok ? String(c.moratorium_19ab_confirmed_by) : null,
      moratoriumAt: staff19ok ? c.moratorium_19ab_confirmed_at : null,
      pathway: i.pathwayConfirmed === true && !isAutomaticActor(i.pathwayConfirmedBy) ? pathway : null,
      checkByPerson, checkComplete,
      // A person saved the check as "number not matched": recordAhpraRegisterCheck
      // ends the "last checked by" with NOT_MATCHED_MARK (and a later verified
      // check writes the plain name again).
      lastCheckUnverified: !checkComplete && String(c.ahpra_last_checked_by == null ? '' : c.ahpra_last_checked_by).slice(-NOT_MATCHED_MARK.length) === NOT_MATCHED_MARK,
      // A person's own check: what they recorded from the register decides.
      vr: checkByPerson ? credentialsVr : null,
      workRights: checkByPerson ? (rights || null) : null,
      sponsorTied: typeof c.visa_sponsor_tied === 'boolean' ? c.visa_sponsor_tied : null,
      hasFlags, flagsReviewed,
      supervisionLevel: level || null
    }
  };
}

const GROUP_LABEL = Object.freeze({
  anywhere: 'Can work anywhere',
  dpa_only: 'Priority areas only (DPA)',
  registrar: 'Registrar: not placed',
  non_vr_held: 'Non-VR: held'
});
const NEEDS_PERSON_LABEL = 'Needs a person';

/** The part of a sorting result staff screens show. Nothing here goes to a doctor. */
function staffSortingView(sorting) {
  const s = sorting && typeof sorting === 'object' ? sorting : null;
  if (!s) return null;
  return {
    group: s.group, label: GROUP_LABEL[s.group] || s.group, held: s.held === true,
    needs_person: s.needsPerson === true, needs_person_label: s.needsPerson ? NEEDS_PERSON_LABEL : '',
    person_reasons: (s.personReasons || []).map(function (r) { return { code: r.code, text: r.text }; }),
    dpa_only: s.dpaOnly === true, dpa_sentence: s.dpaSentence || '',
    basis: s.basis, basis_line: s.basisLine || '',
    flags: (s.staffFlags || []).map(function (f) { return { code: f.code, text: f.text }; }),
    self_declared_only: s.selfDeclaredOnly === true,
    check_can_auto_complete: s.canAutoCompleteCheck === true
  };
}

module.exports = {
  GROUP, BASIS, GROUP_LABEL, NEEDS_PERSON_LABEL, PERSON_REASON_TEXT, AUTO_ACTOR_PREFIX, NOT_MATCHED_MARK,
  TRAINED_ABROAD_PATHWAY_PATTERNS, PRIMARY_DEGREE_PATTERNS, STANDARD_CONDITION_HEADINGS, HOME_MEDICAL_SCHOOLS, NEEDED_FIELDS,
  addYears, dayOf, classifyConditions, primaryMedicalDegree, trainedWhere,
  registerDerivedRestrictions,
  sortDoctorByWhereTheyCanWork,
  sortingInputsFromRecords,
  isAutomaticActor,
  staffSortingView
};

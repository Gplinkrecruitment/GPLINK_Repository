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
// A college award (a fellowship or membership): never a medical degree, and
// the ONLY kind of qualification line that is left out when working out where
// a doctor trained (FR-9 S9-07). Everything else on the list, whatever it is
// called ("Medico Cirujano", "Lekarz", "MBBCh", "Dr. med.", "Vrach", a
// diploma), may be the degree that made the person a doctor.
const COLLEGE_AWARD = /\b(fellow(ship)?|member(ship)?|F?RACGP|FACRRM|MRCGP|MRCP|FRCGP|FRNZCGP|FRACP|FRCP|FRCS|FRACS)\b/i;

// Countries that count as "trained here".
const HOME_COUNTRIES = /^(australia|new zealand|aotearoa new zealand)$/i;
// Medical schools in Australia and New Zealand, for a qualification line that
// has no country word. A line counts as "here" only when one of its parts IS
// one of these names in full (after lower-casing, dropping a leading "the" and
// punctuation). No part-of-a-name matching: "University of Newcastle upon
// Tyne" and "Monash University Malaysia" are not on the list, and the two
// names shared with schools abroad ("University of Newcastle", "University of
// New England") count only with the country written out. Anything not on this
// list is "cannot tell", never "Australian".
const HOME_MEDICAL_SCHOOLS = Object.freeze([
  'university of sydney', 'university of new south wales', 'unsw', 'unsw sydney', 'western sydney university',
  'university of western sydney', 'university of wollongong', 'macquarie university', 'university of notre dame australia',
  'university of newcastle australia', 'university of new england australia', 'university of melbourne', 'monash university',
  'deakin university', 'university of queensland', 'griffith university', 'bond university', 'james cook university',
  'university of adelaide', 'flinders university', 'flinders university of south australia', 'university of western australia',
  'curtin university', 'university of tasmania', 'australian national university', 'charles sturt university',
  'university of otago', 'university of auckland'
]);
// Words that show a part of a qualification line is a title or a school, not a country.
const NOT_A_COUNTRY = /\b(university|universidad|universite|universitat|universiteit|college|school|institute|academy|faculty|hospital|bachelor|doctor|medicine|medical|surgery|degree|diploma|master|certificate)\b/i;

// The standard supervised-practice condition set (FR-9 S9-04). A doctor who
// came through the Expedited Specialist pathway is given the same three
// numbered conditions. The block is "standard", and needs no person, only when
// EVERY line of it is positively recognised: the opening sentence, one of the
// three headings, or a sentence that appears under that heading in the
// Board's standard text (below). Dates and numbers may differ from doctor to
// doctor; nothing else may. A line that is not recognised (an extra condition
// with no number or a letter, different wording under a standard heading,
// anything after the set) means a person looks.
// Source text: the owner's example, 25 November 2026
// (tests/fixtures/ahpra-register/details-standard-supervised-practice.html).
// The three headings, each compared as WHOLE text after normaliseConditionLine
// (FR-9 S9-04, finishing pass: they used to be matched by their first words,
// so a heading with anything added after it still counted as standard).
const STANDARD_CONDITION_HEADINGS = Object.freeze([
  'complete supervised practice for suitability and eligibility - expedited specialist pathway',
  'complete multi-source feedback for medical practitioners - expedited specialist pathway',
  'complete board-directed program of education - orientation, cultural safety and/or specialty specific requirements'
]);
// For each heading (same order), the sentences allowed under it, normalised by
// normaliseConditionLine (lower case, numbering dropped, dates -> {date},
// numbers -> {n}).
const STANDARD_CONDITION_TEMPLATES = Object.freeze([
  Object.freeze([
    "from {date}, the practitioner must not practise as a specialist general practitioner other than in accordance with an approved supervised practice arrangement including under the supervision of another registered medical practitioner.",
    "from {date}, the practitioner must not practise other than at approved practice location(s) that are published as a registration requirement.",
    "the practitioner must:",
    "comply with the supervised practice framework in force at the date these conditions are imposed and then as updated from time to time.",
    "provide acknowledgement, that they have read and understood the requirements of this condition within {n} days of the {date} or as otherwise required.",
    "only practise in accordance with the approved supervised practice arrangement.",
    "cease practice if there is no supervised practice arrangement approved and published, or if they are unable to practise according to the approved supervised practice arrangement.",
    "after approval of a supervised practice arrangement, the practitioner must:",
    "provide a supervision report in the format required, after the completion of {n} months of supervised practice or as otherwise required.",
    "provide a final supervision report which indicates if they are competent to practise the specialty and if the objectives of the supervised practice have been achieved after the completion of a minimum of {n} months, full-time equivalent, of supervised practice, or as otherwise required.",
    "the practitioner must:",
    "successfully complete a minimum of one assessment type (mini-clinical evaluation exercise (mini-cex), direct observation of procedural skills (dops) or case-based discussion (cbd) in accordance with the approved supervised practice arrangement and the board's policy: supervised practice requirements for specialist registration (the assessment).",
    "provide evidence of successful completion of the assessment within {n} months of commencement of supervised practice.",
    "for the purposes of this condition, 'practice' is defined in the supervised practice framework."
  ]),
  Object.freeze([
    "the practitioner must complete the board-approved client focused evaluations program (cfep) multi-source feedback (msf) process within five months of commencement of supervised practice.",
    "the practitioner must within {n} days of notice of imposition of conditions provide acknowledgement that:",
    "they have read and understood the requirements of this condition.",
    "they are aware information may be requested from cfep including the results of the msf process.",
    "the practitioner must, if requested, provide information on how they have incorporated recommendations from the msf process into their practice."
  ]),
  Object.freeze([
    "the practitioner must successfully complete a board-approved orientation to the australian healthcare system.",
    "orientation must cover the topics outlined in the board's approved orientation report form and satisfy the requirements of the board's policy: orientation requirements for specialist registration.",
    "the practitioner must successfully complete board-approved cultural safety education.",
    "cultural safety education must satisfy the requirements of the board's policy: cultural safety education requirements for specialist registration.",
    "the practitioner must provide their practice information within {n} calendar days of first commencing practice in australia, using the approved form.",
    "the practitioner must:",
    "complete the requirements of this condition within {n} months of commencement of supervised practice.",
    "comply with the ahpra protocol: board-directed education in force at the date these conditions are imposed and then as updated from time to time.",
    "the practitioner is not required to comply with the requirement for a reflective practice report (section {n}.{n} of the ahpra protocol: board-directed education)."
  ])
]);
const CONDITION_PREAMBLE = /^on \{date\}, the medical board of australia \(the board\) imposed conditions\.?$/;
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';

/** One line of a conditions block, reduced to what must match the standard text. */
function normaliseConditionLine(line) {
  return String(line == null ? '' : line)
    .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/^\d{1,2}(\.\d{1,2}){1,3}\.?\s+/, '')             // "1.3.2 " (a sub-clause number)
    .replace(new RegExp('\\b\\d{1,2} (' + MONTHS + ') \\d{4}\\b', 'g'), '{date}')
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, '{date}')
    .replace(/\d+/g, '{n}');
}

function token(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

// FR-9 S9-12: the supervision level the register prints, as the value kept on
// the doctor's record (gp_credentials.supervision_level). The Supervised
// practice framework's four levels, in order; the older "Level 1" to "Level 4"
// wording is accepted too. Anything else cannot be recorded automatically.
const SUPERVISION_LEVEL_CODES = Object.freeze([
  [/^(level\s*1|direct)\b/i, 'level_1'],
  [/^(level\s*2|indirect\s*1)\b/i, 'level_2'],
  [/^(level\s*3|indirect\s*2)\b/i, 'level_3'],
  [/^(level\s*4|remote)\b/i, 'level_4']
]);
function supervisionLevelCode(text) {
  const t = String(text == null ? '' : text).trim();
  if (/^level_[1-4]$/.test(t)) return t;
  const hit = SUPERVISION_LEVEL_CODES.filter(function (pair) { return pair[0].test(t); })[0];
  return hit ? hit[1] : '';
}

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
 * Is a conditions block the standard supervised-practice set? Every line must
 * be positively recognised (see STANDARD_CONDITION_TEMPLATES).
 * @returns {{ standard: boolean, headings: string[], unrecognised: string[] }}
 */
function classifyConditions(text) {
  const out = { standard: false, headings: [], unrecognised: [] };
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return out;
  let current = -1;             // index of the standard heading we are under
  const under = {};             // heading index -> recognised sentences seen
  const strange = function (l) { if (out.unrecognised.length < 12) out.unrecognised.push(l.length > 160 ? l.slice(0, 157) + '...' : l); else if (out.unrecognised.length === 12) out.unrecognised.push('(more)'); };
  raw.split('\n').forEach(function (line) {
    const l = line.replace(/\s+/g, ' ').trim();
    if (!l) return;
    const head = /^(\d{1,2})\.\s+(\S.*)$/.exec(l);
    if (head) {
      out.headings.push(head[2]);
      const idx = STANDARD_CONDITION_HEADINGS.indexOf(normaliseConditionLine(head[2]));
      if (idx !== -1 && under[idx] != null) { current = -1; strange(head[2] + ' (a second time)'); return; }
      current = idx;
      if (idx === -1) strange(head[2]); else under[idx] = {};
      return;
    }
    const n = normaliseConditionLine(l);
    if (current === -1 && !out.headings.length) {
      // before the first numbered condition only the Board's opening sentence may stand
      if (!CONDITION_PREAMBLE.test(n)) strange(l);
      return;
    }
    if (current !== -1 && STANDARD_CONDITION_TEMPLATES[current].indexOf(n) !== -1) { under[current][n] = true; return; }
    strange(l);
  });
  // Every sentence of a heading's standard text must be there (FR-9 finishing
  // pass): a heading with only part of its wording under it is not the
  // standard set either.
  const everyHeadingHasItsText = Object.keys(under).every(function (k) {
    return STANDARD_CONDITION_TEMPLATES[k].every(function (sentence) { return under[k][sentence] === true; });
  });
  if (out.headings.length && !out.unrecognised.length && !everyHeadingHasItsText) out.unrecognised.push('a standard heading without all of its standard wording under it');
  out.standard = out.headings.length > 0 && out.unrecognised.length === 0;
  return out;
}

function isCollegeAward(q) { return COLLEGE_AWARD.test(String((q && (q.title || q.raw)) || '')); }
function looksLikePrimaryTitle(title) { const t = String(title || ''); return !!t && PRIMARY_DEGREE_PATTERNS.some(function (re) { return re.test(t); }); }
function schoolKey(v) { return token(v).replace(/[.'\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, ''); }
function isHomeSchool(v) { const k = schoolKey(v); return !!k && HOME_MEDICAL_SCHOOLS.indexOf(k) !== -1; }

/**
 * 'home' | 'abroad' | 'unknown' for one qualification line (FR-9 S9-07).
 * "home" needs POSITIVE evidence: the line names Australia or New Zealand, or
 * one of its parts is, in full, the name of an Australian or New Zealand
 * medical school. A line that names another country is "abroad". Everything
 * else is "unknown".
 */
function trainedWhere(qualification) {
  const q = qualification || {};
  let parts = String(q.raw || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  if (!parts.length) parts = [q.title, q.institution, q.country].map(function (x) { return String(x || '').trim(); }).filter(Boolean);
  if (parts.length && /^(19|20)\d{2}$/.test(parts[parts.length - 1])) parts.pop();
  if (parts.some(function (x) { return HOME_COUNTRIES.test(x); })) return 'home';
  // the parser's own country column, when it holds something that is not ours
  const named = String(q.country || '').trim();
  if (named && !isHomeSchool(named) && !NOT_A_COUNTRY.test(named)) return 'abroad';
  const last = parts.length ? parts[parts.length - 1] : '';
  // title, school, country: a last part that is neither ours nor a school or a title is another country
  if (parts.length >= 3 && last && !isHomeSchool(last) && !NOT_A_COUNTRY.test(last)) return 'abroad';
  if (parts.slice(1).some(isHomeSchool)) return 'home';
  return 'unknown';
}

/**
 * Every qualification line that may be a medical degree (all but college
 * fellowships and memberships), each with where it is from.
 */
function medicalDegreeCandidates(qualifications) {
  return (Array.isArray(qualifications) ? qualifications : [])
    .filter(function (q) { return q && String(q.title || q.raw || '').trim() && !isCollegeAward(q); })
    .map(function (q) { return { q: q, where: trainedWhere(q), primaryTitle: looksLikePrimaryTitle(q.title) }; });
}

/**
 * Where the doctor trained, from the whole list (FR-9 S9-07):
 *   'abroad'   ANY possible medical degree is from another country
 *   'unknown'  any of them cannot be placed, or none is a recognised primary degree
 *   'home'     every one is from Australia or New Zealand AND at least one is a
 *              recognised primary medical degree
 * An overseas degree therefore never loses to a later Australian one, with or
 * without a year, whatever it is called.
 * @returns {{ where: 'home'|'abroad'|'unknown', degree: object|null }}
 */
function whereTrained(qualifications) {
  const list = medicalDegreeCandidates(qualifications);
  const byYear = function (a, b) { return (Number(a.q.year) || 9999) - (Number(b.q.year) || 9999); };
  const abroad = list.filter(function (c) { return c.where === 'abroad'; }).sort(byYear);
  if (abroad.length) return { where: 'abroad', degree: abroad[0].q };
  const unknown = list.filter(function (c) { return c.where === 'unknown'; }).sort(byYear);
  if (unknown.length) return { where: 'unknown', degree: unknown[0].q };
  const primary = list.filter(function (c) { return c.primaryTitle; }).sort(byYear);
  if (primary.length) return { where: 'home', degree: primary[0].q };
  return { where: 'unknown', degree: null };
}

/** The doctor's primary medical degree among the listed qualifications (the one the rule goes by), or null. */
function primaryMedicalDegree(qualifications) { return whereTrained(qualifications).degree; }

/**
 * The GP fellowship the register's own qualification list shows, if any
 * (FR-9 S9-02): 'fracgp' | 'facrrm' | 'both' | null. Read from the full name
 * of the award and the awarding college; an abbreviation alone is accepted too.
 */
function registerGpFellowship(qualifications) {
  let fracgp = false; let facrrm = false;
  (Array.isArray(qualifications) ? qualifications : []).forEach(function (q) {
    const line = String((q && (q.raw || [q.title, q.institution].join(', '))) || '');
    if (!/\bfellow(ship)?\b|\bFRACGP\b|\bFACRRM\b/i.test(line)) return;
    if (/\bFRACGP\b/.test(line) || /fellow(ship)? of the royal australian college of general practitioners/i.test(line)) fracgp = true;
    if (/\bFACRRM\b/.test(line) || /fellow(ship)? of the australian college of rural and remote medicine/i.test(line)) facrrm = true;
  });
  return fracgp && facrrm ? 'both' : (fracgp ? 'fracgp' : (facrrm ? 'facrrm' : null));
}

/**
 * What the register facts say about location, on their own. Pure.
 *
 *   trainedAbroad   true | false | 'unknown'
 *     true    the register names the Expedited Specialist Pathway or the
 *             Practice Experience Program / PEP, OR any qualification that may
 *             be a medical degree is from outside Australia and New Zealand
 *     false   ONLY when every such qualification is positively Australian or
 *             New Zealand, at least one is a recognised primary medical
 *             degree, and neither pathway is named
 *     unknown everything else (see whereTrained)
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
  const trained = whereTrained(f.qualifications);
  const primary = trained.degree;
  const where = trained.where;
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
  register_and_doctor_disagree_19ab: 'The doctor and the register disagree about the 19AB moratorium. The more restrictive answer is applied until you confirm.',
  lookup_unreadable: 'What the register lookup found for this doctor could not be read just now, so the careful answer is applied. Reload; if it stays, run the lookup again or check the register yourself.',
  held_not_found: 'An earlier register lookup did not find this number. Only a person can release the hold: check the register and save the check.',
  held_name_mismatch: 'An earlier register lookup found a different name on this number. Only a person can release the hold (a later matching lookup is not enough): check the register and save the check.',
  held_not_registered: 'An earlier register lookup did not show the status "Registered". Only a person can release the hold: check the register and save the check.',
  held_not_specialist_gp: 'An earlier register lookup did not show specialist registration in general practice for a doctor who said they are a vocationally registered GP. Only a person can release the hold: check the register and save the check.',
  held_restricted_19ab: 'An earlier register lookup showed a location limit the doctor had not told us about. They stay limited to priority areas until you confirm 19AB.'
});

// ── FR-9 S9-08 / S9-09: a hold a lookup created is written on the doctor's own
// credentials row, in gp_credentials.ahpra_last_checked_by, as a suffix. It is
// therefore read with the credentials (no extra query), it survives the lookup
// being switched off or its stored result being unreadable, and NOTHING
// automatic removes it: only a person saving the register check (which writes
// their plain name there) or, for the 19AB one, a staff 19AB answer.
const LOOKUP_HOLD_CODES = Object.freeze(['not_found', 'name_mismatch', 'not_registered', 'not_specialist_gp', 'restricted_19ab']);
const LOOKUP_HOLD_RE = / \(lookup hold: ([a-z0-9_]+)\)$/;
function lookupHoldMark(code) { return LOOKUP_HOLD_CODES.indexOf(code) === -1 ? '' : ' (lookup hold: ' + code + ')'; }
function readLookupHold(by) {
  const m = LOOKUP_HOLD_RE.exec(String(by == null ? '' : by));
  return m && LOOKUP_HOLD_CODES.indexOf(m[1]) !== -1 ? m[1] : null;
}
/**
 * The hold (if any) a sorting result calls for, to be written with
 * lookupHoldMark. Worst first. Null when the lookup found nothing to hold for.
 */
function lookupHoldFor(sorting) {
  const codes = ((sorting && sorting.personReasons) || []).map(function (r) { return r.code; });
  const has = function (c) { return codes.indexOf(c) !== -1; };
  if (has('not_found') || has('held_not_found')) return 'not_found';
  if (has('name_mismatch') || has('held_name_mismatch')) return 'name_mismatch';
  if (has('not_registered') || has('held_not_registered')) return 'not_registered';
  if (has('declared_vr_register_not_specialist_gp') || has('held_not_specialist_gp')) return 'not_specialist_gp';
  if (has('held_restricted_19ab') || (sorting && sorting.registerStricterThanDoctor === true)) return 'restricted_19ab';
  return null;
}

/**
 * THE RULE.
 *
 * @param {object} input
 * @param {object|null} input.registerFacts  what a register lookup found, or
 *        null when there is no usable lookup (provider off, lookup failed).
 *          { found: false }                         the number is not on the register
 *          { found: true, nameMatch: boolean, ...facts }
 *          { unreadable: true }                     a lookup may be on file but could not be
 *                                                   read: the careful answer applies (S9-01)
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
 *          lookupHold: string|null     a hold an earlier lookup created (LOOKUP_HOLD_CODES)
 *          fellowshipType: string|null the fellowship a PERSON recorded on their check
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
 *   register: object|null (registerDerivedRestrictions), conditions: object|null,
 *   decidedBy: [{ fact, source: 'staff'|'register'|'doctor'|'unknown' }]
 *        where each fact that decided the location answer came from,
 *   restsOnDoctorsWord: boolean   "anywhere", but at least one deciding fact is
 *        only the doctor's own word: fine for what the doctor SEES and for
 *        applying; NOT enough to introduce them to a practice outside a DPA,
 *   confirm19ab: null | 'doctors_word' | 'unknown'   staff are needed to settle
 *        19AB (a task is raised for it),
 *   fellowship: { type, source: 'staff'|'register'|null }   what may be stated
 *        to a practice as fact,
 *   supervision: { required: boolean, level: string|null }
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
    if (reg.unreadable === true) regState = 'unreadable';
    else if (reg.found !== true) regState = 'not_found';
    else if (reg.nameMatch !== true) regState = 'name_mismatch';
    else regState = 'ok';
  }
  if (staff.checkByPerson === true && regState !== 'ok') regState = 'none';
  // FR-9 S9-08: a hold an earlier lookup created. A person's own saved check
  // is the only thing that sets it aside.
  const lookupHold = staff.checkByPerson === true ? null : (LOOKUP_HOLD_CODES.indexOf(staff.lookupHold) !== -1 ? staff.lookupHold : null);
  const facts = regState === 'ok' ? reg : null;
  const derived = facts ? registerDerivedRestrictions(facts, today) : null;
  const conditions = facts && facts.conditions && facts.conditions.present === true ? classifyConditions(facts.conditions.text) : null;

  let hardStop = false;
  if (regState === 'not_found') { person('not_found'); hardStop = true; }
  if (regState === 'name_mismatch') { person('name_mismatch'); hardStop = true; }
  // FR-9 S9-01: the stored lookup could not be read. Nothing it may have said
  // can be relied on, so a person is needed and (below) the doctor sees
  // priority-area roles at most; a hold written on the credentials still holds.
  if (regState === 'unreadable') person('lookup_unreadable');
  if (lookupHold === 'not_found' && regState !== 'not_found') { person('held_not_found'); hardStop = true; }
  if (lookupHold === 'name_mismatch' && regState !== 'name_mismatch') { person('held_name_mismatch'); hardStop = true; }
  if (lookupHold === 'not_registered') { person('held_not_registered'); hardStop = true; }
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
  // FR-9 S9-08: an earlier lookup did not show specialist GP registration for
  // this doctor. A later lookup (or none) does not turn that round by itself.
  if (lookupHold === 'not_specialist_gp' && !staffPathway && typeof staff.vr !== 'boolean') {
    vr = false;
    if (personCodes.indexOf('declared_vr_register_not_specialist_gp') === -1) person('held_not_specialist_gp');
  }
  if (registrar && facts && facts.specialistGp === true) {
    flag('registrar_but_register_specialist_gp', 'The doctor said they are a GP registrar, but the register shows specialist registration in general practice. They may have answered wrongly: check with them.');
  }

  // ── location ───────────────────────────────────────────────────────────────
  const rights = token(staff.workRights) || token(answers.workRights);
  const rightsSource = token(staff.workRights) ? 'staff' : (token(answers.workRights) ? 'doctor' : 'unknown');
  // FR-9 S9-03: where each deciding fact came from.
  const decidedBy = [];
  const decided = function (fact, source) { decidedBy.push({ fact: fact, source: source }); };
  let registerStricterThanDoctor = false;
  const residentPermanent = rights === 'citizen' || rights === 'pr' ? true : (rights === 'visa' ? false : null);
  const said = token(answers.moratorium19ab);
  const staff19ab = token(staff.moratorium19ab);
  let dpaOnly;
  let basis;
  if (staff19ab === 'no') { dpaOnly = false; basis = BASIS.STAFF; reasons.push('staff_confirmed_19ab_not_applicable'); decided('19ab', 'staff'); }
  else if (staff19ab === 'yes') { dpaOnly = true; basis = BASIS.STAFF; reasons.push('staff_confirmed_19ab_applies'); decided('19ab', 'staff'); }
  else {
    const selfRestricted = said !== 'no';
    if (residentPermanent === false) { reasons.push('temporary_resident'); decided('right_to_work', rightsSource); }
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
        decided('where_trained', 'register');
        decided('first_registration', 'register');
        // "the ten years have passed" only opens anything for a citizen or
        // permanent resident, and that is the doctor's word unless a person
        // recorded it on their check.
        if (derived.withinTenYears === false && residentPermanent === true) decided('right_to_work', rightsSource);
        if (said === 'yes' && !registerRestricted) decided('19ab_answer', 'doctor');
        if ((said === 'no' && registerRestricted) || (said === 'yes' && !registerRestricted)) person('register_and_doctor_disagree_19ab');
        if (said === 'no' && registerRestricted) registerStricterThanDoctor = true;
      } else if (derived.trainedAbroad === false) {
        // Trained here: the only way 19AB can apply is "was not a citizen or
        // permanent resident when the degree began", which only the doctor
        // can tell us. No answer, or "not sure", stays restricted.
        dpaOnly = selfRestricted;
        decided('where_trained', 'register');
        decided('19ab_answer', said ? 'doctor' : 'unknown');
        reasons.push(selfRestricted ? (said === 'yes' ? 'self_declared_19ab_applies' : '19ab_unknown') : 'trained_here_and_says_19ab_does_not_apply');
      } else {
        dpaOnly = true;
        decided('where_trained', 'unknown');
        reasons.push('training_country_unknown');
        if (said === 'no') registerStricterThanDoctor = true;
      }
    } else {
      basis = BASIS.SELF;
      dpaOnly = selfRestricted;
      decided('19ab_answer', said ? 'doctor' : 'unknown');
      reasons.push(said === 'yes' ? 'self_declared_19ab_applies' : (said === 'no' ? 'self_declared_19ab_does_not_apply' : '19ab_unknown'));
    }
    if (residentPermanent === false) dpaOnly = true;
    // FR-9 S9-08: an earlier lookup showed a location limit the doctor had not
    // told us about. Later lookups, or none, do not lift it: staff decide.
    if (lookupHold === 'restricted_19ab' && !dpaOnly) { dpaOnly = true; person('held_restricted_19ab'); reasons.push('held_by_earlier_lookup'); }
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

  // FR-9 S9-03: "anywhere" that leans on anything only the doctor has told us.
  const restsOnDoctorsWord = group === GROUP.ANYWHERE && basis !== BASIS.STAFF
    && decidedBy.some(function (d) { return d.source === 'doctor' || d.source === 'unknown'; });
  // FR-9 S9-03 / S9-10: does a person need to settle 19AB with the doctor?
  //   doctors_word  they can see and apply everywhere on their own word; a
  //                 practice outside a DPA cannot be told about them until staff confirm
  //   unknown       limited to priority areas only because nobody knows (the
  //                 doctor said "not sure" or nothing, or the register does not
  //                 show where they trained): it may be lifting roles they could have
  let confirm19ab = null;
  if (vr && !registrar && !hardStop && basis !== BASIS.STAFF) {
    if (restsOnDoctorsWord) confirm19ab = 'doctors_word';
    else if (group === GROUP.DPA_ONLY && residentPermanent !== false
      && (reasons.indexOf('19ab_unknown') !== -1 || reasons.indexOf('training_country_unknown') !== -1 || reasons.indexOf('trained_abroad_first_registration_unknown') !== -1)) confirm19ab = 'unknown';
  }

  // FR-9 S9-02: the fellowship that may be stated to a practice as fact: one a
  // PERSON recorded on their own check, or one the register's own list shows
  // (name matched). Never the doctor's answer, never an automatic check alone.
  const staffFellowship = lookedByPerson && GP_FELLOWSHIPS.indexOf(token(staff.fellowshipType)) !== -1 ? token(staff.fellowshipType) : null;
  const registerFellowship = facts ? registerGpFellowship(facts.qualifications) : null;
  const fellowship = staffFellowship ? { type: staffFellowship, source: 'staff' }
    : (registerFellowship ? { type: registerFellowship, source: 'register' } : { type: null, source: null });

  // ── facts for staff (never change what the doctor sees) ─────────────────────
  const req = facts && facts.requirements ? facts.requirements : null;
  const superviseLevel = (req && req.supervisionLevel) || (staff.supervisionLevel && token(staff.supervisionLevel) !== 'none' ? String(staff.supervisionLevel) : '');
  // `code` is what an automatic check may record: 'none' only when the register
  // positively shows no supervision, a level only when it can be read.
  const supervision = {
    required: !!((req && req.supervisionRequired === true) || superviseLevel), level: superviseLevel || null,
    code: (req && req.supervisionRequired === true) || superviseLevel ? supervisionLevelCode(superviseLevel) : (req && req.supervisionRequired === false ? 'none' : '')
  };
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
  // FR-9 S9-08: a lookup never lifts, by itself, a hold a person or an earlier
  // lookup created. It may fill the form in; a person presses the button.
  // (The 19AB hold does not stop the registration itself being verified: the
  // doctor stays limited to priority areas until staff confirm 19AB.)
  if (lookupHold && lookupHold !== 'restricted_19ab') blockers.push('held_by_earlier_lookup');
  if (staff.lastCheckUnverified === true) blockers.push('earlier_check_not_matched');

  // ── one sentence for staff ─────────────────────────────────────────────────
  let basisLine;
  if (basis === BASIS.STAFF) basisLine = 'Sorted from what staff confirmed' + (staff.moratoriumBy ? ' (' + staff.moratoriumBy + ')' : '') + '.';
  else if (basis === BASIS.REGISTER) {
    basisLine = 'Sorted from the Ahpra register lookup' + (facts.fetchedAt ? ' on ' + dayOf(facts.fetchedAt) : '');
    // S9-03: say so when part of the answer is only the doctor's word.
    const fromDoctor = decidedBy.filter(function (d) { return d.source === 'doctor'; }).map(function (d) { return d.fact; });
    if (restsOnDoctorsWord) {
      basisLine += fromDoctor.indexOf('right_to_work') !== -1
        ? ", together with the doctor's own answer that they are a citizen or permanent resident, which nobody has checked. A practice outside a DPA cannot be introduced until staff confirm 19AB."
        : ", together with the doctor's own answer that 19AB does not apply, which nobody has checked (the register does not show it). A practice outside a DPA cannot be introduced until staff confirm 19AB.";
    } else if (fromDoctor.length && dpaOnly) basisLine += ", and the doctor's own answers.";
    else basisLine += '.';
  }
  else basisLine = "Sorted from the doctor's own answers, not yet checked.";
  let dpaSentence = '';
  if (group === GROUP.DPA_ONLY || (dpaOnly && group !== GROUP.ANYWHERE)) {
    if (hardStop) dpaSentence = 'Shown no roles until a person has looked.';
    else if (basis === BASIS.STAFF) dpaSentence = 'Staff confirmed the 19AB moratorium applies.';
    else if (reasons.indexOf('held_by_earlier_lookup') !== -1) dpaSentence = 'An earlier register lookup showed a location limit: restricted until staff confirm 19AB.';
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
    register: derived, registerState: regState, conditions,
    onHold: hardStop, lookupHold: lookupHold,
    // who completed the register check: a person, the automatic lookup, or nobody yet
    checkedBy: staff.checkByPerson === true ? 'person' : (staff.checkComplete === true ? 'lookup' : null),
    // The automatic check finished and left nothing for a person: no reason a
    // person is needed, no 19AB to settle, not held. (Staff screens then drop
    // the "Needs review" label.)
    settledByLookup: staff.checkByPerson !== true && staff.checkComplete === true && !needsPerson && !confirm19ab && !held,
    decidedBy, restsOnDoctorsWord, confirm19ab, registerStricterThanDoctor,
    fellowship, supervision
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
  if (lk && lk.unreadable === true) registerFacts = { unreadable: true };
  else if (lk && lk.ok === true) {
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
      // FR-9 S9-08: a hold an earlier lookup wrote on this row (see LOOKUP_HOLD_RE).
      lookupHold: checkByPerson ? null : readLookupHold(c.ahpra_last_checked_by),
      fellowshipType: checkByPerson ? (token(c.fellowship_type) || null) : null,
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
// A vocationally registered doctor shown NO roles until a person has looked
// (number not found, wrong name, not "Registered"): the chip says that, not
// "Priority areas only".
const ON_HOLD_LABEL = 'On hold: needs a person';
/** The one label for a doctor's group chip. */
function groupLabel(sorting) {
  const s = sorting && typeof sorting === 'object' ? sorting : {};
  if (s.onHold === true && (s.group === GROUP.DPA_ONLY || s.group === GROUP.ANYWHERE)) return ON_HOLD_LABEL;
  return GROUP_LABEL[s.group] || String(s.group || '');
}

/** The part of a sorting result staff screens show. Nothing here goes to a doctor. */
function staffSortingView(sorting) {
  const s = sorting && typeof sorting === 'object' ? sorting : null;
  if (!s) return null;
  return {
    group: s.group, label: groupLabel(s), held: s.held === true, on_hold: s.onHold === true,
    needs_person: s.needsPerson === true, needs_person_label: s.needsPerson ? NEEDS_PERSON_LABEL : '',
    person_reasons: (s.personReasons || []).map(function (r) { return { code: r.code, text: r.text }; }),
    dpa_only: s.dpaOnly === true, dpa_sentence: s.dpaSentence || '',
    basis: s.basis, basis_line: s.basisLine || '',
    flags: (s.staffFlags || []).map(function (f) { return { code: f.code, text: f.text }; }),
    self_declared_only: s.selfDeclaredOnly === true,
    rests_on_doctors_word: s.restsOnDoctorsWord === true,
    confirm_19ab: s.confirm19ab || null,
    decided_by: (s.decidedBy || []).map(function (d) { return { fact: d.fact, source: d.source }; }),
    lookup_hold: s.lookupHold || null,
    checked_by: s.checkedBy || null,
    settled_by_lookup: s.settledByLookup === true,
    fellowship_source: (s.fellowship && s.fellowship.source) || null,
    supervision_required: !!(s.supervision && s.supervision.required),
    check_can_auto_complete: s.canAutoCompleteCheck === true
  };
}

module.exports = {
  GROUP, BASIS, GROUP_LABEL, NEEDS_PERSON_LABEL, ON_HOLD_LABEL, PERSON_REASON_TEXT, AUTO_ACTOR_PREFIX, NOT_MATCHED_MARK,
  supervisionLevelCode, LOOKUP_HOLD_CODES, lookupHoldMark, readLookupHold, lookupHoldFor, groupLabel,
  STANDARD_CONDITION_TEMPLATES, normaliseConditionLine, whereTrained, medicalDegreeCandidates, registerGpFellowship,
  TRAINED_ABROAD_PATHWAY_PATTERNS, PRIMARY_DEGREE_PATTERNS, STANDARD_CONDITION_HEADINGS, HOME_MEDICAL_SCHOOLS, NEEDED_FIELDS,
  addYears, dayOf, classifyConditions, primaryMedicalDegree, trainedWhere,
  registerDerivedRestrictions,
  sortDoctorByWhereTheyCanWork,
  sortingInputsFromRecords,
  isAutomaticActor,
  staffSortingView
};

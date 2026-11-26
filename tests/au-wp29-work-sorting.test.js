'use strict';

// WP-29: the ONE rule that sorts an Australian-pathway doctor by where they
// can and cannot work (lib/au-work-sorting.js sortDoctorByWhereTheyCanWork).
// A table of cases through the one function, then the pieces it is made of.

import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const sorting = require('../lib/au-work-sorting.js');
const lookup = require('../lib/ahpra-register-lookup.js');
const fixtures = require('../lib/ahpra-register-fixtures.js');
const candidatePathway = require('../lib/candidate-pathway.js');
const { bannedIn } = require('./helpers/au-banned-words.js');

const TODAY = '2026-11-26';
const sort = (input) => sorting.sortDoctorByWhereTheyCanWork(Object.assign({ now: TODAY }, input));

// Register facts, read by the REAL parser from a fixture page.
function factsFor(number, over) {
  const page = fixtures.fixturePageFor(number, { accountName: 'Test Doctor' });
  const parsed = lookup.parseRegistrationDetailsHtml(page.html, number);
  if (!parsed.ok) throw new Error('fixture did not parse: ' + number);
  return Object.assign({}, parsed.facts, { found: true, nameMatch: true, fetchedAt: '2026-11-26T01:00:00.000Z' }, over || {});
}
const CLEAN_AU = () => factsFor('MED0009990001');           // Australian graduate, FRACGP, nothing on the record
const OWNER_EXAMPLE = () => factsFor('MED0009990002');      // Expedited Specialist pathway, first registered 18/12/2025
const UK_2014 = () => factsFor('MED0009990008');            // trained in the UK, first registered 10/02/2014
const NZ_GRAD = () => factsFor('MED0009990010');
const FELLOWSHIPS_ONLY = () => factsFor('MED0009990011');
const GENERAL_ONLY = () => factsFor('MED0009990007');

const VR = { registrar: false, vr: true, moratorium19ab: 'no', workRights: 'citizen', hasConditions: false };
const answers = (over) => Object.assign({}, VR, over || {});
const flagCodes = (r) => r.staffFlags.map((f) => f.code);
const personCodes = (r) => r.personReasons.map((p) => p.code);

const CASES = [
  // name, input, expected { group, dpaOnly, held, needsPerson, auto, flags (all present), person (all present), basis }
  ['1 the owner\'s example: specialist GP, Expedited Specialist pathway, first registered 18/12/2025, Russian degree, supervision Indirect 2, approved locations',
    { registerFacts: OWNER_EXAMPLE(), doctorAnswers: answers({ moratorium19ab: 'yes', hasConditions: true }) },
    { group: 'dpa_only', dpaOnly: true, held: false, needsPerson: false, auto: true, flags: ['supervision_required', 'approved_locations_only', 'moratorium_ends_on'], basis: 'register' }],
  ['2 Australian graduate, FRACGP, no conditions, says "does not apply"',
    { registerFacts: CLEAN_AU(), doctorAnswers: answers() },
    { group: 'anywhere', dpaOnly: false, held: false, needsPerson: false, auto: true, basis: 'register' }],
  ['3 the same doctor says "not sure"',
    { registerFacts: CLEAN_AU(), doctorAnswers: answers({ moratorium19ab: 'unsure' }) },
    { group: 'dpa_only', dpaOnly: true, held: false, needsPerson: false, auto: true, basis: 'register' }],
  ['4 the same doctor says it applies (a foreign graduate of an Australian school)',
    { registerFacts: CLEAN_AU(), doctorAnswers: answers({ moratorium19ab: 'yes' }) },
    { group: 'dpa_only', dpaOnly: true, needsPerson: false, basis: 'register' }],
  ['5 trained abroad, first registered over ten years ago, citizen',
    { registerFacts: UK_2014(), doctorAnswers: answers() },
    { group: 'anywhere', dpaOnly: false, needsPerson: false, auto: true, basis: 'register' }],
  ['6 trained abroad, over ten years, TEMPORARY resident',
    { registerFacts: UK_2014(), doctorAnswers: answers({ workRights: 'visa' }) },
    { group: 'dpa_only', dpaOnly: true, held: false, flags: ['temporary_resident_needs_sponsor'], basis: 'register' }],
  ['7 trained abroad, over ten years, right to work not known',
    { registerFacts: UK_2014(), doctorAnswers: answers({ workRights: null }) },
    { group: 'dpa_only', dpaOnly: true }],
  ['8 trained abroad, first-registration date could not be read',
    { registerFacts: Object.assign(UK_2014(), { firstRegistrationDate: null, parseWarnings: ['firstRegistrationDate'] }), doctorAnswers: answers() },
    { group: 'dpa_only', dpaOnly: true, held: false }],
  ['9 only fellowships listed: the primary degree cannot be told',
    { registerFacts: FELLOWSHIPS_ONLY(), doctorAnswers: answers() },
    { group: 'dpa_only', dpaOnly: true, held: false, needsPerson: false }],
  ['10 New Zealand graduate is not "trained abroad"',
    { registerFacts: NZ_GRAD(), doctorAnswers: answers() },
    { group: 'anywhere', dpaOnly: false, auto: true }],
  ['11 a reprimand',
    { registerFacts: factsFor('MED0009990006'), doctorAnswers: answers() },
    { group: 'dpa_only', dpaOnly: true, held: false, needsPerson: true, auto: false, person: ['reprimands'] }],
  ['12 an unfamiliar condition (a prescribing restriction)',
    { registerFacts: factsFor('MED0009990005'), doctorAnswers: answers() },
    { group: 'dpa_only', dpaOnly: true, held: false, needsPerson: true, auto: false, person: ['conditions_not_standard'] }],
  ['13 the name on the register does not match the account: nothing is unlocked',
    { registerFacts: Object.assign(CLEAN_AU(), { nameMatch: false }), doctorAnswers: answers() },
    { dpaOnly: true, held: true, needsPerson: true, auto: false, person: ['name_mismatch'] }],
  ['14 the number is not on the register',
    { registerFacts: { found: false }, doctorAnswers: answers() },
    { dpaOnly: true, held: true, needsPerson: true, auto: false, person: ['not_found'] }],
  ['15 registration expired',
    { registerFacts: factsFor('MED0009990009'), doctorAnswers: answers() },
    { group: 'dpa_only', dpaOnly: true, held: false, needsPerson: true, auto: false, person: ['expired'] }],
  ['16 general registration only, though the doctor said VR',
    { registerFacts: GENERAL_ONLY(), doctorAnswers: answers() },
    { group: 'non_vr_held', held: true, needsPerson: true, auto: false, person: ['declared_vr_register_not_specialist_gp'] }],
  ['17 the doctor says they are a registrar',
    { registerFacts: null, doctorAnswers: answers({ registrar: true, vr: false }) },
    { group: 'registrar', held: true, holdKind: 'registrar', auto: false }],
  ['18 says registrar, but the register shows specialist GP: still a registrar to the doctor, flagged to staff',
    { registerFacts: CLEAN_AU(), doctorAnswers: answers({ registrar: true, vr: false }) },
    { group: 'registrar', held: true, holdKind: 'registrar', auto: false, flags: ['registrar_but_register_specialist_gp'] }],
  ['19 staff override to "anywhere" (19AB confirmed not to apply) beats the register',
    { registerFacts: OWNER_EXAMPLE(), doctorAnswers: answers({ moratorium19ab: 'yes' }), staffConfirmed: { moratorium19ab: 'no', moratoriumBy: 'staff@gplink-test.local' } },
    { group: 'anywhere', dpaOnly: false, basis: 'staff' }],
  ['20 staff-confirmed "19AB applies" beats a register result of not restricted',
    { registerFacts: CLEAN_AU(), doctorAnswers: answers(), staffConfirmed: { moratorium19ab: 'yes', moratoriumBy: 'staff@gplink-test.local' } },
    { group: 'dpa_only', dpaOnly: true, basis: 'staff' }],
  ['21 no lookup (provider none), doctor says "does not apply"',
    { registerFacts: null, doctorAnswers: answers() },
    { group: 'anywhere', dpaOnly: false, basis: 'self', auto: false, selfDeclaredOnly: true }],
  ['22 no lookup, doctor says it applies',
    { registerFacts: null, doctorAnswers: answers({ moratorium19ab: 'yes' }) },
    { group: 'dpa_only', dpaOnly: true, basis: 'self' }],
  ['23 no lookup, doctor says "not sure"',
    { registerFacts: null, doctorAnswers: answers({ moratorium19ab: 'unsure' }) },
    { group: 'dpa_only', dpaOnly: true, basis: 'self' }],
  ['24 no lookup, no answer at all',
    { registerFacts: null, doctorAnswers: answers({ moratorium19ab: null }) },
    { group: 'dpa_only', dpaOnly: true, basis: 'self' }],
  ['25 exactly ten years to the day since first registration: the ten years have passed',
    { registerFacts: Object.assign(UK_2014(), { firstRegistrationDate: '2016-11-26' }), doctorAnswers: answers() },
    { group: 'anywhere', dpaOnly: false }],
  ['26 one day short of ten years',
    { registerFacts: Object.assign(UK_2014(), { firstRegistrationDate: '2016-11-27' }), doctorAnswers: answers() },
    { group: 'dpa_only', dpaOnly: true, flags: ['moratorium_ends_on'] }],
  ['27 not a VR GP and not a registrar (limited registration): held as before',
    { registerFacts: null, doctorAnswers: answers({ vr: false }) },
    { group: 'non_vr_held', held: true, holdKind: 'review' }],
  ['28 no lookup, temporary resident who says "does not apply": priority areas at least, and never held for it',
    { registerFacts: null, doctorAnswers: answers({ workRights: 'visa' }) },
    { group: 'dpa_only', dpaOnly: true, held: false, flags: ['temporary_resident_needs_sponsor'] }],
  ['29 the doctor says "does not apply" but the register shows trained abroad within ten years: the stricter one, and staff see the disagreement',
    { registerFacts: OWNER_EXAMPLE(), doctorAnswers: answers({ moratorium19ab: 'no' }) },
    { group: 'dpa_only', dpaOnly: true, needsPerson: true, person: ['register_and_doctor_disagree_19ab'] }],
  ['30 the doctor says it applies but the register says the ten years have passed: restricted until staff decide',
    { registerFacts: UK_2014(), doctorAnswers: answers({ moratorium19ab: 'yes' }) },
    { group: 'dpa_only', dpaOnly: true, needsPerson: true, person: ['register_and_doctor_disagree_19ab'] }],
  ['31 the register does not say "Registered"',
    { registerFacts: Object.assign(CLEAN_AU(), { status: 'Suspended' }), doctorAnswers: answers() },
    { held: true, needsPerson: true, auto: false, person: ['not_registered'] }],
  ['32 an undertaking',
    { registerFacts: Object.assign(CLEAN_AU(), { undertakings: { present: true, text: 'An undertaking.' } }), doctorAnswers: answers() },
    { group: 'dpa_only', needsPerson: true, auto: false, person: ['undertakings'] }],
  ['33 a parse warning on a field the rule needs',
    { registerFacts: Object.assign(CLEAN_AU(), { notations: null, parseWarnings: ['notations'] }), doctorAnswers: answers() },
    { group: 'dpa_only', needsPerson: true, auto: false, person: ['parse_warnings'] }],
  ['34 no lookup, the doctor declared a condition nobody has reviewed',
    { registerFacts: null, doctorAnswers: answers({ hasConditions: true }) },
    { group: 'dpa_only', dpaOnly: true, held: false, needsPerson: true, person: ['conditions_declared_not_reviewed'] }],
  ['35 a staff-confirmed non-VR pathway wins over a register that shows specialist GP',
    { registerFacts: CLEAN_AU(), doctorAnswers: answers(), staffConfirmed: { pathway: 'au_non_vr' } },
    { group: 'non_vr_held', held: true }],
  ['36 doctor did not say VR, register shows specialist GP: held, with a flag that they may have answered wrongly',
    { registerFacts: CLEAN_AU(), doctorAnswers: answers({ vr: false }) },
    { group: 'non_vr_held', held: true, needsPerson: true, person: ['declared_not_vr_register_specialist_gp'] }],
  ['38 a person recorded "number not matched": priority areas at most until a check is saved as verified, even though the doctor says "does not apply"',
    { registerFacts: null, doctorAnswers: answers(), staffConfirmed: { lastCheckUnverified: true } },
    { group: 'dpa_only', dpaOnly: true, held: false, needsPerson: true, person: ['last_check_not_verified'] }],
  ['37 a person saved the check after a lookup that found the wrong name: the person\'s check stands',
    { registerFacts: Object.assign(CLEAN_AU(), { nameMatch: false }), doctorAnswers: answers(), staffConfirmed: { checkByPerson: true, checkComplete: true, vr: true } },
    { group: 'anywhere', held: false, needsPerson: false, basis: 'self' }]
];

describe('WP-29 sortDoctorByWhereTheyCanWork: the table', () => {
  it('has at least 20 cases', () => { expect(CASES.length).toBeGreaterThanOrEqual(20); });
  for (const [name, input, want] of CASES) {
    it(name, () => {
      const r = sort(input);
      if (want.group) expect(r.group, 'group').toBe(want.group);
      if (typeof want.dpaOnly === 'boolean') expect(r.dpaOnly, 'dpaOnly').toBe(want.dpaOnly);
      if (typeof want.held === 'boolean') expect(r.held, 'held').toBe(want.held);
      if (want.holdKind) expect(r.holdKind).toBe(want.holdKind);
      if (typeof want.needsPerson === 'boolean') expect(r.needsPerson, 'needsPerson ' + personCodes(r).join(',')).toBe(want.needsPerson);
      if (typeof want.auto === 'boolean') expect(r.canAutoCompleteCheck, 'auto ' + r.autoCompleteBlockers.join(',')).toBe(want.auto);
      if (want.basis) expect(r.basis).toBe(want.basis);
      if (want.selfDeclaredOnly) expect(r.selfDeclaredOnly).toBe(true);
      for (const f of want.flags || []) expect(flagCodes(r), 'flag ' + f).toContain(f);
      for (const p of want.person || []) expect(personCodes(r), 'person ' + p).toContain(p);
      // Invariants that hold for EVERY case.
      expect(Object.values(sorting.GROUP)).toContain(r.group);
      if (r.needsPerson) expect(r.group === 'anywhere' && r.basis !== 'staff', 'needs a person never sits with "anywhere" unless staff said so').toBe(false);
      if (r.held) expect(r.canAutoCompleteCheck && r.group !== 'non_vr_held' && r.group !== 'registrar').toBe(false);
      if (r.group === 'anywhere') expect(r.dpaOnly).toBe(false);
      if (r.group === 'dpa_only') expect(r.dpaOnly).toBe(true);
    });
  }
});

describe('WP-29: the owner\'s example in full', () => {
  const r = sort({ registerFacts: OWNER_EXAMPLE(), doctorAnswers: answers({ moratorium19ab: 'yes', hasConditions: true }) });
  it('is priority areas only, not held, and the check may complete without a person', () => {
    expect(r.group).toBe('dpa_only');
    expect(r.held).toBe(false);
    expect(r.canAutoCompleteCheck).toBe(true);
    expect(r.conditions.standard).toBe(true);
    expect(r.conditions.headings).toHaveLength(3);
  });
  it('staff are told why and until when, and both flags are raised', () => {
    expect(r.dpaSentence).toBe('Trained outside Australia and New Zealand, first registered 2025-12-18: restricted until 2035-12-18, or until staff confirm an exemption.');
    expect(r.basisLine).toBe('Sorted from the Ahpra register lookup on 2026-11-26.');
    const sup = r.staffFlags.find((f) => f.code === 'supervision_required');
    expect(sup.text).toMatch(/^Supervision required: Indirect 2\./);
    expect(r.staffFlags.find((f) => f.code === 'approved_locations_only').text)
      .toBe('Registration is tied to approved practice locations: a move needs a new Board approval for the new practice.');
    expect(r.staffFlags.find((f) => f.code === 'moratorium_ends_on').date).toBe('2035-12-18');
  });
  it('reads the register facts the rule needs from the real saved page (personal details replaced)', () => {
    const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'ahpra-register', 'details-standard-supervised-practice.html'), 'utf8');
    const parsed = lookup.parseRegistrationDetailsHtml(html, 'MED0009990002');
    expect(parsed.ok).toBe(true);
    expect(parsed.facts.parseWarnings).toEqual([]);
    const real = sort({ registerFacts: Object.assign({}, parsed.facts, { found: true, nameMatch: true }), doctorAnswers: answers({ moratorium19ab: 'unsure' }) });
    expect(real.group).toBe('dpa_only');
    expect(real.canAutoCompleteCheck).toBe(true);
    expect(real.register.trainedAbroad).toBe(true);
    expect(real.register.pathwayNamed).toBe(true);
    expect(real.register.primaryDegree.country).toBe('Russian Federation');
    expect(flagCodes(real)).toEqual(expect.arrayContaining(['supervision_required', 'approved_locations_only']));
  });
});

describe('WP-29 registerDerivedRestrictions: the pieces', () => {
  const d = (facts, now) => sorting.registerDerivedRestrictions(facts, now || TODAY);
  it('names the two pathways from the requirements box or a condition heading', () => {
    expect(d({ requirements: { pathway: 'Expedited Specialist Pathway' } }).trainedAbroad).toBe(true);
    expect(d({ conditions: { present: true, text: '1. Something – Expedited Specialist pathway' } }).trainedAbroad).toBe(true);
    expect(d({ requirements: { raw: 'Pathway: Practice Experience Program' } }).trainedAbroad).toBe(true);
    expect(d({ requirements: { raw: 'Pathway: PEP specialist stream' } }).trainedAbroad).toBe(true);
    expect(d({ requirements: { raw: 'Position: General Practitioner' } }).trainedAbroad).toBe('unknown');
  });
  it('picks the primary medical degree, never a membership, fellowship, diploma or masters', () => {
    const q = (title, country, year, institution) => ({ title, country, year, institution: institution || 'X' });
    expect(sorting.primaryMedicalDegree([q('Membership of the Royal College of General Practitioners', 'United Kingdom', 2024), q('Doctor of Medicine in General Medicine', 'Russian Federation', 2015)]).country).toBe('Russian Federation');
    expect(sorting.primaryMedicalDegree([q('Fellowship of the Royal Australian College of General Practitioners', 'Australia', 2016)])).toBe(null);
    expect(sorting.primaryMedicalDegree([q('Master of Public Health', 'Australia', 2012), q('Diploma of Child Health', 'Australia', 2011)])).toBe(null);
    for (const t of ['MBBS', 'MB BS', 'MBChB', 'MB ChB', 'BMed', 'BMBS', 'Bachelor of Medicine / Bachelor of Surgery', 'Doctor of Medicine', 'MD']) {
      expect(sorting.primaryMedicalDegree([q(t, 'India', 2001)]), t).not.toBe(null);
    }
    // the earliest of two
    expect(sorting.primaryMedicalDegree([q('Doctor of Medicine', 'Australia', 2019), q('MBBS', 'India', 2005)]).country).toBe('India');
  });
  it('"cannot tell" is unknown, never Australian', () => {
    expect(sorting.trainedWhere({ title: 'MBBS', country: 'Australia' })).toBe('home');
    expect(sorting.trainedWhere({ title: 'MBBS', country: 'New Zealand' })).toBe('home');
    expect(sorting.trainedWhere({ title: 'MBBS', country: 'United Kingdom' })).toBe('abroad');
    expect(sorting.trainedWhere({ title: 'MBBS', country: 'Russian Federation' })).toBe('abroad');
    expect(sorting.trainedWhere({ title: 'MBBS', country: null, institution: 'University of Sydney' })).toBe('home');
    expect(sorting.trainedWhere({ title: 'MBBS', country: null, institution: 'University of Otago' })).toBe('home');
    expect(sorting.trainedWhere({ title: 'MBBS', country: null, institution: 'Some University' })).toBe('unknown');
    expect(d({ qualifications: [{ title: 'MBBS', country: null, institution: 'Some University', year: 2001 }] }).trainedAbroad).toBe('unknown');
  });
  it('counts ten years on calendar dates, including a 29 February', () => {
    expect(sorting.addYears('2025-12-18', 10)).toBe('2035-12-18');
    expect(sorting.addYears('2016-02-29', 10)).toBe('2026-03-01');   // no 29 Feb in 2026: the later day
    expect(sorting.addYears('2016-02-29', 4)).toBe('2020-02-29');
    const leap = { firstRegistrationDate: '2016-02-29', requirements: { pathway: 'Expedited Specialist Pathway' } };
    expect(d(leap, '2026-02-28').withinTenYears).toBe(true);
    expect(d(leap, '2026-03-01').withinTenYears).toBe(false);
    expect(d({ firstRegistrationDate: '2016-11-26' }, '2026-11-26').withinTenYears).toBe(false);
    expect(d({ firstRegistrationDate: '2016-11-26' }, '2026-11-25').withinTenYears).toBe(true);
    expect(d({ firstRegistrationDate: null }).withinTenYears).toBe(null);
  });
  it('a leap-day first registration sorts the careful way on the day before the ten years end', () => {
    const facts = Object.assign(UK_2014(), { firstRegistrationDate: '2016-02-29' });
    expect(sorting.sortDoctorByWhereTheyCanWork({ registerFacts: facts, doctorAnswers: answers(), now: '2026-02-28' }).group).toBe('dpa_only');
    expect(sorting.sortDoctorByWhereTheyCanWork({ registerFacts: facts, doctorAnswers: answers(), now: '2026-03-01' }).group).toBe('anywhere');
  });
});

describe('WP-29 classifyConditions: the standard supervised-practice set', () => {
  it('the real conditions block is standard', () => {
    const c = sorting.classifyConditions(fixtures.STANDARD_SUPERVISED_PRACTICE_CONDITIONS);
    expect(c.standard).toBe(true);
    expect(c.unrecognised).toEqual([]);
  });
  it('one unfamiliar heading among the standard ones is NOT standard', () => {
    const c = sorting.classifyConditions(fixtures.STANDARD_SUPERVISED_PRACTICE_CONDITIONS + '\n\n4. Restriction on prescribing\n4.1 Must not prescribe Schedule 8 medicines.');
    expect(c.standard).toBe(false);
    // FR-9 S9-04 (deliberate): every line is examined now, so the sentence under the unfamiliar heading is listed too
    expect(c.unrecognised).toEqual(['Restriction on prescribing', '4.1 Must not prescribe Schedule 8 medicines.']);
  });
  it('text with no numbered heading, stray text before the first heading, and nothing at all are not standard', () => {
    expect(sorting.classifyConditions('The practitioner must not practise alone.').standard).toBe(false);
    expect(sorting.classifyConditions('The practitioner may not see patients under 18.\n1. Complete supervised practice for suitability and eligibility – Expedited Specialist pathway').standard).toBe(false);
    expect(sorting.classifyConditions('').standard).toBe(false);
    expect(sorting.classifyConditions(null).standard).toBe(false);
  });
});

describe('WP-29: the rule from the rows the server holds (sortingInputsFromRecords + the resolver)', () => {
  const vrCreds = { ahpra_registration_type: 'specialist', specialist_gp: true, fellowship_type: 'fracgp', vr_status: 'vr', has_conditions: false, work_rights: 'citizen' };
  const resolve = (pathway, credentials, lookupRecord, profileOver) => candidatePathway.resolvePathwayFromRecords({
    profile: Object.assign({ candidate_pathway: pathway, pathway_set_by: 'self' }, profileOver || {}), credentials, lookup: lookupRecord || null, flagEnabled: true, now: TODAY
  });
  it('a self-declared VR GP who says "does not apply" sees everything, on their own word only', () => {
    const r = resolve('au_vr', Object.assign({}, vrCreds, { moratorium_19ab_status: 'no' }));
    expect(r.sorting.group).toBe('anywhere');
    expect(r.dpaRestricted).toBe(false);
    expect(r.dpaSelfDeclaredOnly).toBe(true);
    expect(r.selfServiceHeld).toBe(false);
  });
  it('"not sure", "applies" and no answer stay limited to priority areas', () => {
    for (const a of ['unsure', 'yes', null]) {
      const r = resolve('au_vr', Object.assign({}, vrCreds, { moratorium_19ab_status: a }));
      expect(r.sorting.group, String(a)).toBe('dpa_only');
      expect(r.dpaRestricted, String(a)).toBe(true);
    }
  });
  it('a restricted (segment B) VR GP is no longer held: they are sorted like anyone else', () => {
    const r = resolve('au_restricted', Object.assign({}, vrCreds, { moratorium_19ab_status: 'yes' }));
    expect(r.selfServiceHeld).toBe(false);
    expect(r.sorting.group).toBe('dpa_only');
    expect(r.launched).toBe(false);   // the segment flag itself is unchanged
  });
  it('limited or provisional registration is not VR: held as before', () => {
    for (const type of ['limited', 'provisional']) {
      const r = resolve('au_restricted', { ahpra_registration_type: type, moratorium_19ab_status: 'no', work_rights: 'citizen' });
      expect(r.sorting.group, type).toBe('non_vr_held');
      expect(r.selfServiceHeld, type).toBe(true);
      expect(r.holdKind, type).toBe('review');
    }
  });
  it('a registrar and a non-VR doctor are held, each with their own kind', () => {
    expect(resolve('au_registrar', {}).holdKind).toBe('registrar');
    expect(resolve('au_non_vr', {}).holdKind).toBe('review');
    expect(resolve('au_registrar', {}).sorting.group).toBe('registrar');
  });
  it('credentials that were not read give the closed answers (segment B held, VR limited to priority areas)', () => {
    const b = candidatePathway.resolvePathwayFromRecords({ profile: { candidate_pathway: 'au_restricted', pathway_set_by: 'self' }, credentials: null, credentialsRead: false, flagEnabled: true, now: TODAY });
    expect(b.selfServiceHeld).toBe(true);
    const a = candidatePathway.resolvePathwayFromRecords({ profile: { candidate_pathway: 'au_vr', pathway_set_by: 'self' }, credentials: null, credentialsRead: false, flagEnabled: true, now: TODAY });
    expect(a.selfServiceHeld).toBe(false);
    expect(a.dpaRestricted).toBe(true);
  });
  it('a stored lookup with a matching name sorts from the register; one with the wrong name holds the doctor', () => {
    const good = { v: 1, ok: true, found: true, nameMatch: true, facts: OWNER_EXAMPLE() };
    const r = resolve('au_vr', Object.assign({}, vrCreds, { moratorium_19ab_status: 'unsure' }), good);
    expect(r.sorting.basis).toBe('register');
    expect(r.dpaRestrictedReason).toBe('register_lookup_restricted');
    const wrong = { v: 1, ok: true, found: true, nameMatch: false, facts: CLEAN_AU() };
    const w = resolve('au_vr', Object.assign({}, vrCreds, { moratorium_19ab_status: 'no' }), wrong);
    expect(w.selfServiceHeld).toBe(true);
    expect(w.dpaRestricted).toBe(true);
    expect(w.holdWhy).toBe('name_mismatch');
  });
  it('a lookup that FAILED (ok false) changes nothing', () => {
    const failed = { v: 1, ok: false, found: false, reason: 'timeout', nameMatch: null, facts: null };
    const withIt = resolve('au_vr', Object.assign({}, vrCreds, { moratorium_19ab_status: 'no' }), failed);
    const without = resolve('au_vr', Object.assign({}, vrCreds, { moratorium_19ab_status: 'no' }), null);
    expect(withIt.sorting).toEqual(without.sorting);
  });
  it('a check completed by the automatic lookup is not "a person": the register still decides', () => {
    const auto = Object.assign({}, vrCreds, { moratorium_19ab_status: 'no', staff_verified_at: '2026-11-26T00:00:00Z', staff_verified_by: 'automatic register lookup (fixture)' });
    const inputs = sorting.sortingInputsFromRecords({ pathway: 'au_vr', credentials: auto, lookup: null });
    expect(inputs.staffConfirmed.checkByPerson).toBe(false);
    expect(inputs.staffConfirmed.checkComplete).toBe(true);
    expect(sorting.isAutomaticActor('automatic register lookup (ahpra_public)')).toBe(true);
    expect(sorting.isAutomaticActor('hello@example.com')).toBe(false);
  });
  it('a doctor recorded as restricted with nothing on file saying why needs a person and is kept to priority areas', () => {
    const r = resolve('au_restricted', Object.assign({}, vrCreds, { moratorium_19ab_status: 'no' }));
    expect(r.sorting.needsPerson).toBe(true);
    expect(r.dpaRestricted).toBe(true);
  });
});

describe('WP-29: an overseas doctor is never passed through the rule', () => {
  it('nothing recorded, an overseas pathway, and the switch off: no `sorting`, the result is the shape it always was', () => {
    const keys = ['basis', 'confirmed', 'dpaRestricted', 'dpaRestrictedReason', 'flagEnabled', 'isAu', 'launched', 'needsStaffReview', 'pathway', 'recorded', 'segment'];
    const cases = [
      candidatePathway.resolvePathwayFromRecords({ profile: null, credentials: null, flagEnabled: true, legacyDpaExempt: false }),
      candidatePathway.resolvePathwayFromRecords({ profile: { candidate_pathway: 'overseas_pep' }, credentials: { moratorium_19ab_status: 'no' }, lookup: { v: 1, ok: true, found: true, nameMatch: true, facts: CLEAN_AU() }, flagEnabled: true, legacyDpaExempt: true }),
      candidatePathway.resolvePathwayFromRecords({ profile: { candidate_pathway: 'au_vr' }, credentials: { moratorium_19ab_status: 'no' }, flagEnabled: false, legacyDpaExempt: false }),
      candidatePathway.overseasDefault({ flagEnabled: false })
    ];
    for (const r of cases) {
      expect(Object.keys(r).sort()).toEqual(keys);
      expect(r.isAu).toBe(false);
      expect(r.sorting).toBeUndefined();
    }
    expect(cases[0].dpaRestricted).toBe(true);
    expect(cases[1].dpaRestricted).toBe(false);   // today's country answer, untouched
    expect(cases[2].dpaRestricted).toBe(true);
  });
  it('computeDpaRestricted for an overseas pathway never reads credentials or a lookup', () => {
    const lk = { v: 1, ok: true, found: true, nameMatch: true, facts: CLEAN_AU() };
    expect(candidatePathway.computeDpaRestricted({ pathway: 'overseas_esp', credentials: { moratorium_19ab_status: 'no' }, lookup: lk, legacyDpaExempt: false })).toEqual({ dpaRestricted: true, reason: 'legacy_country_restricted' });
    expect(candidatePathway.computeDpaRestricted({ pathway: null, credentials: { moratorium_19ab_confirmed_status: 'no' }, legacyDpaExempt: true })).toEqual({ dpaRestricted: false, reason: 'legacy_country_exempt' });
  });
});

describe('WP-29: nothing the rule says to staff uses a word a doctor must never see by accident, and staff words are staff-only', () => {
  it('the staff view carries labels for every group', () => {
    for (const g of Object.values(sorting.GROUP)) expect(sorting.GROUP_LABEL[g]).toBeTruthy();
    const v = sorting.staffSortingView(sort({ registerFacts: OWNER_EXAMPLE(), doctorAnswers: answers({ moratorium19ab: 'yes' }) }));
    expect(v.label).toBe('Priority areas only (DPA)');
    expect(v.flags.map((f) => f.code)).toEqual(expect.arrayContaining(['supervision_required', 'approved_locations_only']));
  });
  it('the sentences shown to staff avoid the words on the banned list too (so a copy-paste to a doctor is safe)', () => {
    for (const [, input] of CASES) {
      const r = sort(input);
      const text = [r.dpaSentence, r.basisLine].concat(r.staffFlags.map((f) => f.text), r.personReasons.map((p) => p.text)).join(' \n ');
      expect(bannedIn(text.replace(/sponsor\w*/gi, '')), text).toEqual([]);
    }
  });
});

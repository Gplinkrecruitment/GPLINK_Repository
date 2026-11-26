// Australian GP build, FR-9 (finishing pass), pure parts of the sorting / register-lookup items:
//   S9-04  a condition heading is recognised as WHOLE text, once, and only with all of its standard
//          wording under it (it used to be matched by its first words)
//   S9-02 / S9-08  the staff AI context never calls the automatic register lookup "staff"
//   S9-02 / S9-08  the staff screen never labels the automatic lookup as a person's confirmation,
//          and a hold the lookup wrote is not "a person has looked"
// Each test fails on the code before this pass.
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const sorting = require('../lib/au-work-sorting.js');
const FX = require('../lib/ahpra-register-fixtures.js');
const aiContext = require('../lib/au-ai-context.js');

const STD = FX.STANDARD_SUPERVISED_PRACTICE_CONDITIONS;
const lines = STD.split('\n');
const h1 = lines.find((l) => /^1\. /.test(l));
const h2 = lines.find((l) => /^2\. /.test(l));

describe('S9-04: headings are whole text, once, with all of their wording', () => {
  it('the owner\'s standard set is still standard', () => {
    expect(sorting.classifyConditions(STD).standard).toBe(true);
  });
  it.each([
    ['words added after heading 1', STD.replace(h1, h1 + ' and must not consult female patients without a chaperone')],
    ['words added after heading 2', STD.replace(h2, h2 + '; must not prescribe Schedule 8')],
    ['a fourth condition reusing a standard heading\'s opening words', STD + '\n4. Complete supervised practice for suitability and eligibility – anything at all\n4.1 The practitioner must:'],
    ['a standard heading with only one generic sentence under it', h1 + '\n1.1 The practitioner must:'],
    ['a standard heading repeated', STD + '\n' + h1],
    ['a different pathway named in the heading', STD.replace(h1, h1.replace('Expedited Specialist pathway', 'Specialist pathway'))]
  ])('%s: not standard, a person looks', (name, text) => {
    const c = sorting.classifyConditions(text);
    expect(c.standard, JSON.stringify(c.unrecognised)).toBe(false);
    expect(c.unrecognised.length).toBeGreaterThan(0);
  });
});

describe('S9-02 / S9-08: the staff AI context says who checked', () => {
  const text = (chk) => aiContext.auStateFactLines({ ahpraChecked: chk }).join('\n');
  it('a check the automatic lookup completed is not "done by staff"', () => {
    const t = text({ at: '2026-11-26T07:25:09Z', verified: true, by: 'automatic register lookup (fixture)' });
    expect(t).not.toMatch(/by staff/i);
    expect(t).toMatch(/automatically by the register lookup/);
    expect(t).toMatch(/no staff member has checked it/);
  });
  it('a hold the lookup wrote is not "looked at by staff"', () => {
    const t = text({ at: '2026-11-26T07:25:09Z', verified: false, by: 'automatic register lookup (fixture) (lookup hold: name_mismatch)' });
    expect(t).not.toMatch(/by staff/i);
    expect(t).toMatch(/a person needs to check/);
  });
  it('a person\'s check reads as before', () => {
    expect(text({ at: '2026-11-26T07:25:09Z', verified: true, by: 'Test Consultant' })).toMatch(/done by staff on 2026-11-26/);
    expect(text({ at: '2026-11-26T07:25:09Z', verified: false, by: 'Test Consultant' })).toMatch(/looked at by staff on 2026-11-26/);
  });
});

describe('S9-02 / S9-08: the staff screen (js/ceo-ats-candidates.js)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'ceo-ats-candidates.js'), 'utf8');
  it('a pathway the automatic lookup set has its own pill, never "Confirmed by staff"', () => {
    expect(src).toMatch(/Set by the automatic register lookup \(no person has checked\)/);
    expect(src).toMatch(/autoSet = \/\^automatic register lookup\/i/);
    expect(src).toMatch(/Pathway set by the automatic register lookup; no person has checked it/);
  });
  it('the 19AB line no longer promises a task it cannot see', () => {
    expect(src).not.toMatch(/a task is open for it/);
  });
  it('a hold the lookup wrote does not count as "a person has looked" for filling in the check form', () => {
    const m = /var staffSeen = ([^;]+);/.exec(src);
    expect(m && m[1]).toMatch(/byLookup\(cred\.ahpra_last_checked_by\)/);
    expect(src).toMatch(/var autoDone = [^;]*!lk\.hold\)/);
  });
});

describe('S9-09: what the lookup found that a person must see stays on the doctor\'s row (register_flags)', () => {
  const lookupLib = require('../lib/ahpra-register-lookup.js');
  const reprimand = () => {
    const html = FX.detailsPageHtml('MED0009990006', { name: 'Dr A B', firstRegistration: '15/01/2011', reprimands: 'Reprimand issued on 1 February 2024.',
      qualifications: ['Bachelor of Medicine / Bachelor of Surgery, Example University of Sydney, Australia, 2010'],
      types: [{ word: 'Specialist', specialty: 'General practice', expiry: '30/09/2027', conditions: null, endorsements: null, notations: null, requirements: null }] }, 'Dr A B');
    return Object.assign(lookupLib.parseRegistrationDetailsHtml(html, 'MED0009990006').facts, { found: true, nameMatch: true });
  };
  const answers = { vr: true, moratorium19ab: 'no', workRights: 'citizen' };
  it('a reprimand calls for the register_flags hold', () => {
    const out = sorting.sortDoctorByWhereTheyCanWork({ registerFacts: reprimand(), doctorAnswers: answers, staffConfirmed: {}, now: '2026-11-26' });
    expect(out.group).toBe('dpa_only');
    expect(sorting.lookupHoldFor(out)).toBe('register_flags');
    expect(sorting.readLookupHold('automatic register lookup (fixture)' + sorting.lookupHoldMark('register_flags'))).toBe('register_flags');
  });
  it('with that hold on the row, the doctor stays on priority areas with the lookup switched off, or after a clean lookup', () => {
    for (const reg of [null, { found: true, nameMatch: true, status: 'Registered', specialistGp: true, expiry: '2027-09-30', firstRegistration: '2011-01-15', qualifications: [] }]) {
      const out = sorting.sortDoctorByWhereTheyCanWork({ registerFacts: reg, doctorAnswers: answers, staffConfirmed: { lookupHold: 'register_flags' }, now: '2026-11-26' });
      expect(out.group, JSON.stringify(reg)).toBe('dpa_only');
      expect(out.needsPerson).toBe(true);
      expect(out.canAutoCompleteCheck).toBe(false);
    }
  });
  it('a person\'s own saved check lifts it', () => {
    const out = sorting.sortDoctorByWhereTheyCanWork({ registerFacts: null, doctorAnswers: answers, staffConfirmed: { lookupHold: 'register_flags', checkByPerson: true, moratorium19ab: 'no' }, now: '2026-11-26' });
    expect(out.group).toBe('anywhere');
  });
});

describe('S9-01: an unreadable stored lookup means priority areas at most, even with a staff 19AB answer', () => {
  it('staff said 19AB does not apply, the check was automatic, and the lookup cannot be read: priority areas only', () => {
    const out = sorting.sortDoctorByWhereTheyCanWork({ registerFacts: { unreadable: true }, doctorAnswers: { vr: true, moratorium19ab: 'no', workRights: 'citizen' }, staffConfirmed: { moratorium19ab: 'no' }, now: '2026-11-26' });
    expect(out.group).toBe('dpa_only');
    expect(out.needsPerson).toBe(true);
  });
  it('a person\'s own saved check is not affected by the lookup being unreadable', () => {
    const out = sorting.sortDoctorByWhereTheyCanWork({ registerFacts: { unreadable: true }, doctorAnswers: { vr: true, moratorium19ab: 'no', workRights: 'citizen' }, staffConfirmed: { moratorium19ab: 'no', checkByPerson: true }, now: '2026-11-26' });
    expect(out.group).toBe('anywhere');
  });
});

describe('smaller row: "19AB does not apply" on the register check needs its reason too', () => {
  const tools = require('../lib/au-staff-tools.js');
  const FULL = { outcome: 'verified', ahpra_number: 'MED0001234567', registration_type: 'specialist', specialist_gp: true, has_conditions: false, has_undertakings: false, has_notations: false,
    registration_expiry: '2099-09-30', fellowship_type: 'fracgp', work_rights: 'citizen', supervision_level: 'none', moratorium_19ab_confirmed: 'no' };
  it('no note: refused, and the reason is asked for', () => {
    const v = tools.validateAhpraCheckInput(FULL, { today: '2026-11-26' });
    expect(v.ok).toBe(false);
    expect(v.errors.note).toMatch(/Say why 19AB does not apply/);
  });
  it('with a reason: accepted; "applies" and "not confirmed yet" need none', () => {
    expect(tools.validateAhpraCheckInput(Object.assign({}, FULL, { note: 'Trained in Australia as a citizen' }), { today: '2026-11-26' }).ok).toBe(true);
    expect(tools.validateAhpraCheckInput(Object.assign({}, FULL, { moratorium_19ab_confirmed: 'yes' }), { today: '2026-11-26' }).errors.note).toBe(undefined);
    expect(tools.validateAhpraCheckInput(Object.assign({}, FULL, { moratorium_19ab_confirmed: 'unconfirmed' }), { today: '2026-11-26' }).errors.note).toBe(undefined);
  });
  it('the staff form says so before sending', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'ceo-ats-candidates.js'), 'utf8');
    expect(src).toMatch(/a note saying why 19AB does not apply/);
  });
});

describe('S9-08: a doctor the lookup put on hold is not introduced to any practice, a DPA one included', () => {
  const re = require('../lib/role-eligibility.js');
  it('auto-verified earlier, on hold now: the DPA role is refused too', () => {
    const s = sorting.sortDoctorByWhereTheyCanWork({ registerFacts: { found: true, nameMatch: false }, doctorAnswers: { vr: true, moratorium19ab: 'no', workRights: 'citizen' }, staffConfirmed: {}, now: '2026-11-26' });
    expect(s.onHold).toBe(true);
    const p = { isAu: true, credentialsRead: true, sorting: s };
    const block = re.auIntroductionBlock(p, { dpa_status: 'yes', dpa: true }, { registerVerified: true });
    expect(block && block.code).toBe(re.INTRO_BLOCK.REGISTER_NOT_VERIFIED);
  });
});

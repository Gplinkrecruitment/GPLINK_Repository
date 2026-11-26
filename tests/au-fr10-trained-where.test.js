// Australian GP build, FR-10 (review round 13, S13-04): where a doctor trained, read from the
// register's qualification list. Three Australian / New Zealand graduates were counted as trained
// abroad (each also raised a person-review item): a home city as the last part of the line, an
// overseas POSTGRADUATE diploma beside an Australian degree, and "NZ" abbreviated. The round-12
// guards must still hold. Pure: the fixture page builder and the real parser.
import { describe, it, expect } from 'vitest';

const S = require('../lib/au-work-sorting.js');
const L = require('../lib/ahpra-register-lookup.js');
const FX = require('../lib/ahpra-register-fixtures.js');

const NOW = '2026-11-26';
const AUF = 'Fellowship of the Royal Australian College of General Practitioners, Royal Australian College of General Practitioners, Australia, 2016';
const gp = () => ({ word: 'Specialist', specialty: 'General practice', expiry: '30/09/2027', conditions: null, endorsements: null, notations: null, requirements: null });
function facts(qualifications, firstRegistration) {
  const html = FX.detailsPageHtml('MED0009990001', { name: 'Dr A B', firstRegistration: firstRegistration || '15/01/2020', types: [gp()], qualifications }, 'Dr A B');
  const r = L.parseRegistrationDetailsHtml(html, 'MED0009990001');
  if (!r.ok) throw new Error('parse failed: ' + r.reason);
  return Object.assign(r.facts, { found: true, nameMatch: true });
}
const sortOf = (qualifications, firstRegistration) => S.sortDoctorByWhereTheyCanWork({
  registerFacts: facts(qualifications, firstRegistration),
  doctorAnswers: { registrar: false, vr: true, moratorium19ab: 'no', workRights: 'citizen', hasConditions: false, unexplainedRestriction: false },
  staffConfirmed: {}, now: NOW
});
const where = (qualifications) => S.registerDerivedRestrictions(facts(qualifications), NOW).trainedAbroad;

describe('S13-04: Australian and New Zealand graduates the rule used to count as trained abroad', () => {
  it('Q12 "MBBS, University of Sydney, Sydney, 2005": trained here, can work anywhere, nothing for a person', () => {
    expect(where([AUF, 'MBBS, University of Sydney, Sydney, 2005'])).toBe(false);
    const s = sortOf([AUF, 'MBBS, University of Sydney, Sydney, 2005']);
    expect(s.group).toBe('anywhere');
    expect(s.needsPerson).toBe(false);
  });
  it('Q13 an Australian MBBS with a UK postgraduate diploma (DRCOG): trained here', () => {
    const q = [AUF, 'Bachelor of Medicine / Bachelor of Surgery, University of Sydney, Australia, 2019',
      'Diploma of the Royal College of Obstetricians and Gynaecologists, Royal College of Obstetricians and Gynaecologists, United Kingdom, 2021'];
    expect(where(q)).toBe(false);
    expect(sortOf(q).group).toBe('anywhere');
    expect(where([AUF, 'MBBS, University of Melbourne, Australia, 2010', 'DRCOG, Royal College of Obstetricians and Gynaecologists, United Kingdom, 2013'])).toBe(false);
    expect(where([AUF, 'MBBS, University of Melbourne, Australia, 2010', 'Postgraduate Diploma in Dermatology, Cardiff University, United Kingdom, 2014'])).toBe(false);
  });
  it('Q15 "Bachelor of Medicine, University of Auckland, NZ, 2012": trained here', () => {
    expect(where(['Bachelor of Medicine, University of Auckland, NZ, 2012'])).toBe(false);
    expect(sortOf(['Bachelor of Medicine, University of Auckland, NZ, 2012']).group).toBe('anywhere');
    expect(where(['MBChB, University of Otago, N.Z., 2008'])).toBe(false);
    expect(where(['MBChB, University of Otago, Dunedin, 2008'])).toBe(false);
  });
});

describe('S13-04 guards: the round-12 fixes still hold', () => {
  const abroadOrUnknown = (v) => expect(v === true || v === 'unknown', String(v)).toBe(true);
  it('a home city without an exact home school is not "here"', () => {
    abroadOrUnknown(where(['MBBS, University of Newcastle upon Tyne, Newcastle, 2001']));
    abroadOrUnknown(where(['MBBS, University of Newcastle upon Tyne, 2001']));
    abroadOrUnknown(where(['MD, Monash University Malaysia, Malaysia, 2012']));
    abroadOrUnknown(where(['MBBS, Monash University Malaysia, Clayton, 2012']));
    abroadOrUnknown(where(['MD, University of New England, Biddeford, 2012']));
    abroadOrUnknown(where(['MD, University of New England, Armidale, 2012']));   // the name is shared with a US school: needs the country
    abroadOrUnknown(where(['MBBS, Example Medical College, Hamilton, 2004']));     // a city alone never makes a line "here"
  });
  it('an overseas primary degree still decides, with or without a year, whatever it is called', () => {
    expect(where(['MBBS, University of Lagos, Nigeria', 'Doctor of Medicine, Bond University, Australia, 2022'])).toBe(true);
    expect(where(['Medico Cirujano, Universidad de Chile, Chile, 2009', 'Doctor of Medicine, Bond University, Australia, 2022'])).toBe(true);
    // a primary-looking "Diploma" title is never set aside as postgraduate
    expect(where(['Diploma of Physician, Example State Medical Academy, Russian Federation, 2010', AUF])).toBe(true);
    // a college diploma is set aside, but then there is no primary degree at all: unknown, never "here"
    expect(where([AUF, 'Diploma of the Royal College of Obstetricians and Gynaecologists, Royal College of Obstetricians and Gynaecologists, United Kingdom, 2021'])).toBe('unknown');
  });
  it('NZ written out or abbreviated, the other side is unchanged: a line naming another country is abroad', () => {
    expect(where(['MBBS, University of Delhi, India, 2005'])).toBe(true);
  });
});

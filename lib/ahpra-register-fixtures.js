'use strict';

/**
 * Australian GP build, WP-29: the made-up register pages behind the `fixture`
 * lookup provider (AHPRA_LOOKUP_PROVIDER=fixture). For tests and the local
 * test stack ONLY. Nothing here is a real practitioner: every number starts
 * MED000999, and every name, employer and university is invented.
 *
 * Each fixture is a "Registration Details" page built with the same markup as
 * the real public page (see tests/fixtures/ahpra-register/, saved from the
 * real site with the personal details replaced), so the real parser reads it.
 *
 * A fixture whose name is ACCOUNT_NAME prints the signed-up doctor's own name,
 * so the testing guide works whatever name the tester typed. (Only the
 * fixture provider does this. The real provider prints what the register
 * says, and a number that belongs to somebody else fails the name check.)
 */

const ACCOUNT_NAME = '{{account}}';

// The conditions the Medical Board puts on a specialist GP who came through
// the Expedited Specialist pathway. Copied from the public page used as the
// owner's example (dates kept, nothing personal in it).
const STANDARD_SUPERVISED_PRACTICE_CONDITIONS = [
  'On 18 December 2025, the Medical Board of Australia (the Board) imposed conditions.',
  '',
  '1. Complete supervised practice for suitability and eligibility – Expedited Specialist pathway',
  '1.1 From 18 December 2025, the practitioner must not practise as a Specialist general practitioner other than in accordance with an approved supervised practice arrangement including under the supervision of another registered medical practitioner.',
  '1.2 From 18 December 2025, the practitioner must not practise other than at approved practice location(s) that are published as a registration requirement.',
  '1.3 The practitioner must:',
  '1.3.1 comply with the Supervised practice framework in force at the date these conditions are imposed and then as updated from time to time.',
  '1.3.2 provide acknowledgement, that they have read and understood the requirements of this condition within 30 days of the 18 December 2025 or as otherwise required.',
  '1.3.3 only practise in accordance with the approved supervised practice arrangement.',
  '1.3.4 cease practice if there is no supervised practice arrangement approved and published, or if they are unable to practise according to the approved supervised practice arrangement.',
  '1.4 After approval of a supervised practice arrangement, the practitioner must:',
  '1.4.1 provide a supervision report in the format required, after the completion of 3 months of supervised practice or as otherwise required.',
  '1.4.2 provide a final supervision report which indicates if they are competent to practise the specialty and if the objectives of the supervised practice have been achieved after the completion of a minimum of 6 months, full-time equivalent, of supervised practice, or as otherwise required.',
  '1.5 The practitioner must:',
  '1.5.1 successfully complete a minimum of one assessment type (mini-clinical evaluation exercise (Mini-CEX), direct observation of procedural skills (DOPS) or case-based discussion (CBD) in accordance with the approved supervised practice arrangement and the Board’s Policy: Supervised practice requirements for specialist registration (the assessment).',
  '1.5.2 provide evidence of successful completion of the assessment within 6 months of commencement of supervised practice.',
  '',
  "For the purposes of this condition, 'practice' is defined in the Supervised practice framework.",
  '',
  '2. Complete multi-source feedback for medical practitioners – Expedited Specialist pathway',
  '2.1 The practitioner must complete the Board-approved Client Focused Evaluations Program (CFEP) multi-source feedback (MSF) process within five months of commencement of supervised practice.',
  '2.2 The practitioner must within 30 days of notice of imposition of conditions provide acknowledgement that:',
  '2.2.1 They have read and understood the requirements of this condition.',
  '2.2.2 They are aware information may be requested from CFEP including the results of the MSF process.',
  '2.3 The practitioner must, if requested, provide information on how they have incorporated recommendations from the MSF process into their practice.',
  '',
  '3. Complete board-directed program of education – Orientation, cultural safety and/or specialty specific requirements',
  '3.1 The practitioner must successfully complete a Board-approved orientation to the Australian healthcare system.',
  '3.1.1 Orientation must cover the topics outlined in the Board’s approved orientation report form and satisfy the requirements of the Board’s Policy: Orientation requirements for specialist registration.',
  '3.2 The practitioner must successfully complete Board-approved cultural safety education.',
  '3.2.1 Cultural safety education must satisfy the requirements of the Board’s Policy: Cultural safety education requirements for specialist registration.',
  '3.2.2 The practitioner must provide their practice information within 14 calendar days of first commencing practice in Australia, using the approved form.',
  '3.3 The practitioner must:',
  '3.3.1 complete the requirements of this condition within 6 months of commencement of supervised practice.',
  '3.3.2 comply with the Ahpra Protocol: Board-directed education in force at the date these conditions are imposed and then as updated from time to time.',
  '3.4 The practitioner is not required to comply with the requirement for a reflective practice report (section 3.2 of the Ahpra Protocol: Board-directed education).'
].join('\n');

const STANDARD_REQUIREMENTS = [
  'The Practitioner will only practise with supervision by a Board approved supervisor or Delegate',
  '',
  'Position: General Practitioner',
  'Pathway: Expedited Specialist Pathway',
  'Employer: FAKE PTY LTD ATF Fake Medical Trust T/A Fakeville Medical Practice',
  'Workplaces/locations(s): Fakeville Medical Practice NSW',
  'Level of supervision: Indirect 2',
  'Commencement: 18 December 2025'
].join('\n');

const AU_GRAD = ['Fellowship of the Royal Australian College of General Practitioners, Royal Australian College of General Practitioners, Australia, 2016',
  'Bachelor of Medicine / Bachelor of Surgery, Example University of Sydney, Australia, 2010'];
const UK_GRAD = ['Membership of the Royal College of General Practitioners, Royal College of General Practitioners, United Kingdom, 2012',
  'Bachelor of Medicine and Bachelor of Surgery, Example University of Leeds, United Kingdom, 2006'];

function specialistGp(over) {
  return Object.assign({ word: 'Specialist', specialty: 'General practice', expiry: '30/09/2027', conditions: null, endorsements: null, notations: null, requirements: null }, over || {});
}

/**
 * The fixture numbers. `docs/au-gp/TESTING.md` lists them for the owner.
 */
const FIXTURES = Object.freeze({
  // A clean vocationally registered GP who trained in Australia.
  MED0009990001: { name: ACCOUNT_NAME, firstRegistration: '15/01/2011', types: [specialistGp()], qualifications: AU_GRAD, place: ['PARRAMATTA', 'NSW', '2150'] },
  // Modelled on the owner's example: Expedited Specialist pathway, first
  // registered under ten years ago, supervision, approved locations only.
  MED0009990002: {
    name: ACCOUNT_NAME, firstRegistration: '18/12/2025',
    types: [specialistGp({ conditions: STANDARD_SUPERVISED_PRACTICE_CONDITIONS, requirements: STANDARD_REQUIREMENTS })],
    qualifications: ['Membership of the Royal College of General Practitioners, Royal College of General Practitioners, United Kingdom, 2024',
      'Doctor of Medicine in General Medicine, Example State Medical University, Russian Federation, 2015'],
    place: ['FAKEVILLE', 'NSW', '2999']
  },
  // Not on the register.
  MED0009990003: { notFound: true },
  // A real-looking clean record that belongs to SOMEBODY ELSE.
  MED0009990004: { name: 'Dr Someone Else-Entirely', firstRegistration: '15/01/2011', types: [specialistGp()], qualifications: AU_GRAD, place: ['CAIRNS', 'QLD', '4870'] },
  // A condition that is not the standard supervised-practice set.
  MED0009990005: {
    name: ACCOUNT_NAME, firstRegistration: '15/01/2011',
    types: [specialistGp({ conditions: 'On 3 March 2026, the Medical Board of Australia (the Board) imposed conditions.\n\n1. Restriction on prescribing\n1.1 The practitioner must not prescribe, supply or administer any Schedule 8 medicine.' })],
    qualifications: AU_GRAD, place: ['BALLARAT', 'VIC', '3350']
  },
  // A reprimand.
  MED0009990006: { name: ACCOUNT_NAME, firstRegistration: '15/01/2011', reprimands: 'Reprimand issued on 1 February 2024.', types: [specialistGp()], qualifications: AU_GRAD, place: ['HOBART', 'TAS', '7000'] },
  // General registration only (not on the specialist register).
  MED0009990007: { name: ACCOUNT_NAME, firstRegistration: '15/01/2019', types: [{ word: 'General', specialty: null, expiry: '30/09/2027', conditions: null, endorsements: null, notations: null, requirements: null }], qualifications: [AU_GRAD[1]], place: ['PERTH', 'WA', '6000'] },
  // Trained in the United Kingdom, first registered here more than ten years ago, nothing on the record.
  MED0009990008: { name: ACCOUNT_NAME, firstRegistration: '10/02/2014', types: [specialistGp()], qualifications: UK_GRAD, place: ['GEELONG', 'VIC', '3220'] },
  // Registration expired.
  MED0009990009: { name: ACCOUNT_NAME, firstRegistration: '15/01/2011', types: [specialistGp({ expiry: '30/09/2025' })], qualifications: AU_GRAD, place: ['DARWIN', 'NT', '0800'] },
  // Trained in New Zealand.
  MED0009990010: { name: ACCOUNT_NAME, firstRegistration: '15/01/2018', types: [specialistGp()], qualifications: ['Fellowship of the Royal New Zealand College of General Practitioners, Royal New Zealand College of General Practitioners, New Zealand, 2017', 'Bachelor of Medicine and Bachelor of Surgery, Example University of Otago, New Zealand, 2011'], place: ['BRISBANE', 'QLD', '4000'] },
  // Only fellowships are listed: the primary medical degree cannot be told.
  MED0009990011: { name: ACCOUNT_NAME, firstRegistration: '15/01/2011', types: [specialistGp()], qualifications: [AU_GRAD[0]], place: ['ADELAIDE', 'SA', '5000'] },
  // The lookup itself fails (as if the site did not answer).
  MED0009990012: { failure: 'timeout' }
});

function esc(text) {
  return String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function br(text) { return esc(text).replace(/\n/g, '<br />'); }
function noneOr(text) { return text ? br(text) : '<strong>None</strong>'; }
function row(title, entryHtml, extraClass) {
  return ' <div class="section-row' + (extraClass ? ' ' + extraClass : '') + '">\n'
    + ' <div class="col-xs-12 col-sm-4 col-md-3">\n <div class="field-title">\n ' + esc(title) + '\n'
    + ' <a data-toggle="popover" title="' + esc(title) + '" data-content="Help text."><span class="sr-only">' + esc(title) + '</span><i class="fa fa-question-circle"></i></a>\n </div>\n </div>\n'
    + ' <div class="col-xs-12 col-sm-9 ">\n <div class="field-entry" data-text-color="blue">\n ' + entryHtml + '\n </div>\n </div>\n </div>\n';
}

/** Build one "Registration Details" page in the real page's markup. */
function detailsPageHtml(number, spec, name) {
  const types = spec.types || [];
  const typeWords = types.map(function (t) { return t.word; });
  const anyConditions = types.filter(function (t) { return t.conditions; });
  const conditionsSummary = anyConditions.length
    ? anyConditions.map(function (t) { return '<strong>' + esc(t.word + (t.specialty ? ' - ' + t.specialty : '')) + ':</strong>\n <a href="#x">Yes, see details</a>\n <br />'; }).join('\n')
    : '<strong>None</strong>';
  let html = '<form method="post" action="/Registration/Registers-of-Practitioners#search-results-anchor" id="mainform" class="">\n'
    + ' <div id="SearchResultsPage" class="main">\n <h1 class="heading">Registration Details</h1>\n'
    + ' <div id="page-body" class="col-sm-12 col-md-9">\n <div class="practitioner-detail-header">\n'
    + ' <h2 class="practitioner-name">' + esc(name) + '</h2>\n <h3 class="practitioner-profession">Medical Practitioner</h3>\n'
    + ' <div class="practitioner-reg-details">\n <div class="reg-types">\n'
    + typeWords.map(function (w, i) { return ' <span class="reg-type-' + (i + 1) + '">' + esc(w) + '</span>\n'; }).join('')
    + ' </div>\n <span class="reg-number">No. ' + esc(number) + '</span>\n </div>\n </div>\n <div class="practitioner-detail-body">\n';
  html += ' <div class="practitioner-detail-section">\n <div class="section-title" data-background-color="blue">\n Registration details\n </div>\n'
    + row('Profession', 'Medical Practitioner')
    + row('Registration number', esc(number))
    + row('Registration status', esc(spec.status || 'Registered'))
    + row('Conditions', conditionsSummary)
    + row('Undertakings', noneOr(spec.undertakings))
    + row('Reprimands', noneOr(spec.reprimands))
    + row('Registration expiry date', 'The registration expiry date is the end date for the annual registration period.', 'expiry')
    + row('Date of first Registration in profession', esc(spec.firstRegistration || ''))
    + ' </div>\n';
  types.forEach(function (t) {
    html += ' <a name="x"></a>\n <div class="practitioner-detail-section">\n <div class="section-title" data-background-color="blue">\n Registration Type - ' + esc(t.word) + '\n </div>\n'
      + (t.specialty ? row('Specialty', esc(t.specialty)) : '')
      + ' <div class="section-row">\n <div class="col-xs-12 col-sm-4 col-md-3">\n <div class="field-title">\n Registration Expiry Date\n </div>\n </div>\n'
      + ' <div class="col-xs-12 col-sm-9 ">\n <div class="field-entry-wrapper">\n <div class="field-entry substatus-date" data-text-color="blue">\n ' + esc(t.expiry || '') + '\n </div>\n </div>\n </div>\n </div>\n'
      + row('Conditions', t.conditions
        ? '<div class="info-block visible" data-text-color="black"><a href="javascript:void(0);" title="Read More text" aria-label="read more text" class="read-more-link">Show less</a>' + br(t.conditions) + '</div>'
        : '<strong>None</strong>', 'conditions')
      + row('Endorsements', noneOr(t.endorsements))
      + row('Notations', noneOr(t.notations))
      + row('Registration Requirements', noneOr(t.requirements))
      + ' </div>\n';
  });
  const place = spec.place || [];
  html += ' <div class="practitioner-detail-section">\n <div class="section-title" data-background-color="purple">\n Personal details\n </div>\n'
    + ' <div class="section-row">\n <div class="col-xs-12 col-sm-4 col-md-3"><div class="field-title">Qualifications</div></div>\n <div class="col-xs-12 col-sm-9 ">\n <div class="field-entry">\n <ul>\n'
    + (spec.qualifications || []).map(function (q) { return ' <li>' + esc(q) + '</li>\n'; }).join('')
    + ' </ul>\n </div>\n </div>\n </div>\n </div>\n'
    + ' <div class="practitioner-detail-section">\n <div class="section-title" data-background-color="blue">\n Principal place of practice\n </div>\n'
    + ['Suburb', 'State', 'Postcode'].map(function (label, i) {
      return ' <div class="section-row">\n <div class="col-xs-12 col-sm-4 col-md-3"><div class="field-title">' + label + '</div></div>\n <div class="col-xs-12 col-sm-9 "><div class="field-entry">' + esc(place[i] || '') + '</div></div>\n </div>\n';
    }).join('')
    + ' <div class="section-row">\n <div class="col-xs-12 col-sm-4 col-md-3"><div class="field-title">Country</div></div>\n <div class="col-xs-12 col-sm-9 "><div class="field-entry">Australia</div></div>\n </div>\n'
    + ' </div>\n </div>\n </div>\n <div class="hide-for-print">Print this page</div>\n </div>\n</form>\n';
  return html;
}

/**
 * What the fixture provider answers for a number.
 * @returns {{ kind: 'details', html: string } | { kind: 'not_found' } | { kind: 'failure', reason: string } | { kind: 'unknown' }}
 */
function fixturePageFor(number, opts) {
  const n = String(number || '').toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(FIXTURES, n)) return { kind: 'unknown' };
  const spec = FIXTURES[n];
  if (spec.notFound) return { kind: 'not_found' };
  if (spec.failure) return { kind: 'failure', reason: spec.failure };
  const account = String((opts && opts.accountName) || '').trim();
  const name = spec.name === ACCOUNT_NAME ? ('Dr ' + (account || 'Fixture Doctor')) : spec.name;
  return { kind: 'details', html: detailsPageHtml(n, spec, name) };
}

module.exports = {
  ACCOUNT_NAME,
  FIXTURES,
  STANDARD_SUPERVISED_PRACTICE_CONDITIONS,
  STANDARD_REQUIREMENTS,
  detailsPageHtml,
  fixturePageFor
};

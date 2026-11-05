// AHPRA "registration granted" detection, the regex fallback parser and the
// conditions-tracker due-date maths (lib/ahpra-registration-granted.js).
//
// The real-world shapes pinned here come from the owner's spec (2026-11-05):
//   subject  "Ahpra – Final Notice of Registration – APP-1234567890"
//   files    "Final notice - Specialist registration with conditions - ESP - <Surname>, <First> - <app no>.PDF"
//            "Schedule of conditions - <name> - <app no>.DOCX" + a generic appeals fact sheet
//   a week earlier: "Ahpra: Notice to propose approval of registration with conditions - <app no>"
import { describe, it, expect } from 'vitest';
import {
  detectAhpraRegistrationOutcome, parseRegistrationFromText, normalizeRegistration,
  buildConditionsTrackerDueDates, parseDateToIso, formatDateLong, addDays, addMonths,
  docKeyForAhpraAttachment, dependantsFromHousehold, extractApplicationNumber
} from '../lib/ahpra-registration-granted.js';

const FINAL_NOTICE_EMAIL = {
  subject: 'Ahpra – Final Notice of Registration – APP-1234567890',
  bodyText: 'Dear Dr Obanimoh,\n\nPlease find the attached final notice of registration with conditions and the schedule of conditions.\n\nKind regards\nJane Officer',
  attachments: [
    { filename: 'Final notice - Specialist registration with conditions - ESP - Obanimoh, Mercy - APP-1234567890.PDF', mimeType: 'application/pdf' },
    { filename: 'Schedule of conditions - Mercy Obanimoh - APP-1234567890.DOCX', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { filename: 'Appeals fact sheet.pdf', mimeType: 'application/pdf' }
  ]
};
const PROPOSAL_EMAIL = {
  subject: 'Ahpra: Notice to propose approval of registration with conditions - APP-1234567890',
  // The proposal letter itself says a final notice will follow: body wording must not flip it to "granted".
  bodyText: 'The Board proposes to approve your registration with conditions. If you accept, a final notice of registration will be issued.',
  attachments: [{ filename: 'Notice to propose approval - Obanimoh - APP-1234567890.PDF' }]
};

describe('detectAhpraRegistrationOutcome', () => {
  it('reads the Final Notice email as granted and lifts the application number from the subject', () => {
    expect(detectAhpraRegistrationOutcome(FINAL_NOTICE_EMAIL)).toEqual({ kind: 'granted', applicationNumber: 'APP-1234567890' });
  });
  it('is granted on the attachment name alone (subject in a different form)', () => {
    const out = detectAhpraRegistrationOutcome({ subject: 'Your Ahpra application', bodyText: 'Please see attached.', attachments: [FINAL_NOTICE_EMAIL.attachments[0]] });
    expect(out.kind).toBe('granted');
  });
  it('is granted on body wording alone', () => {
    // Body wording alone never decides a grant (ordinary officer mail quotes it); it counts only
    // with a letter attached AND the doctor's MED number in the text.
    expect(detectAhpraRegistrationOutcome({ subject: 'Ahpra', bodyText: 'Your registration is made effective from 2 November 2026.', attachments: [] }).kind).toBeNull();
    expect(detectAhpraRegistrationOutcome({ subject: 'Ahpra', bodyText: 'Notice of approval for registration with conditions', attachments: [] }).kind).toBeNull();
    expect(detectAhpraRegistrationOutcome({ subject: 'Ahpra', bodyText: 'Your registration number is MED0004091669', attachments: [] }).kind).toBeNull();
    expect(detectAhpraRegistrationOutcome({ subject: 'Ahpra', bodyText: 'Your registration number is MED0004091669', attachments: [{ filename: 'Letter.pdf' }] }).kind).toBe('granted');
    expect(detectAhpraRegistrationOutcome({ subject: 'RE: APP-1234567890 further information required', bodyText: 'Once your registration is approved you will receive a final notice of registration.', attachments: [{ filename: 'Request.pdf' }] }).kind).toBeNull();
    expect(detectAhpraRegistrationOutcome({ subject: 'Notice of registration standard change', bodyText: 'The Board has updated the standard.', attachments: [] }).kind).toBeNull();
    expect(detectAhpraRegistrationOutcome({ subject: 'Ahpra Compliance Team', bodyText: 'Your registration number is MED0004091669. Please acknowledge your conditions.', attachments: [] }).kind).toBeNull();
  });
  it('reads the earlier "notice to propose approval" as a proposal, even though its body mentions the final notice', () => {
    expect(detectAhpraRegistrationOutcome(PROPOSAL_EMAIL)).toEqual({ kind: 'proposal', applicationNumber: 'APP-1234567890' });
  });
  it('is a proposal on body wording when the subject is neutral', () => {
    expect(detectAhpraRegistrationOutcome({ subject: 'Ahpra - APP-1234567890', bodyText: 'We propose to grant registration with conditions.', attachments: [] }).kind).toBe('proposal');
  });
  it('is null for ordinary officer mail (a document request)', () => {
    expect(detectAhpraRegistrationOutcome({ subject: 'Ahpra: Request for further information - APP-1234567890', bodyText: 'Please provide a certified copy of your CV.', attachments: [{ filename: 'Request.pdf' }] })).toEqual({ kind: null, applicationNumber: 'APP-1234567890' });
  });
  it('is safe on empty input', () => {
    expect(detectAhpraRegistrationOutcome(null)).toEqual({ kind: null, applicationNumber: null });
    expect(detectAhpraRegistrationOutcome({})).toEqual({ kind: null, applicationNumber: null });
  });
  it('application number: dashes, en dashes and spaces are all accepted (matches server extractAhpraApplicationNumber)', () => {
    expect(extractApplicationNumber('Ahpra – APP–1234567890', '')).toBe('APP-1234567890');
    expect(extractApplicationNumber('APP 1234567890', '')).toBe('APP-1234567890');
    expect(extractApplicationNumber('no number', 'see APP-9876543210 in body')).toBe('APP-9876543210');
    expect(extractApplicationNumber('', '')).toBeNull();
  });
});

const LETTER_TEXT = [
  'Notice of approval for registration with conditions',
  'Your registration is made effective from 2 November 2026 and will remain current until 30 September 2027.',
  'Your registration number is MED0004091669.',
  'Approved supervised practice arrangement',
  'Position: General Practitioner Employer: The Doctors Werribee, Werribee VIC Level of supervision: Indirect 2 Primary Supervisor: Dr Chamira Ranatunga Commencement: 25 January 2027',
  'The Board has set a review period of 6 months.',
  'You may appeal within 28 days of receiving this notice.'
].join('\n');

describe('parseRegistrationFromText (regex fallback)', () => {
  it('reads the number, dates, supervised practice arrangement and review period from the letter text', () => {
    const r = parseRegistrationFromText(LETTER_TEXT);
    expect(r.registration_number).toBe('MED0004091669');
    expect(r.effective_date).toBe('2026-11-02');
    expect(r.expiry_date).toBe('2027-09-30');
    expect(r.has_conditions).toBe(true);
    expect(r.review_period_months).toBe(6);
    expect(r.appeal_deadline_days).toBe(28);
    expect(r.supervised_practice).toEqual({
      position: 'General Practitioner', employer: 'The Doctors Werribee', location: 'Werribee VIC',
      level: 'Indirect 2', supervisor: 'Dr Chamira Ranatunga', commencement_date: '2027-01-25'
    });
    expect(r.source).toBe('regex');
  });
  it('reads a letter with one field per line and a spaced number', () => {
    const r = parseRegistrationFromText('Your registration number is MED 0004091669\nPrimary Supervisor: Dr A Person\nLevel of supervision: Direct\nCommencement: 01/02/2027\nSpecialist registration');
    expect(r.registration_number).toBe('MED0004091669');
    expect(r.supervised_practice.supervisor).toBe('Dr A Person');
    expect(r.supervised_practice.level).toBe('Direct');
    expect(r.supervised_practice.commencement_date).toBe('2027-02-01');
    expect(r.registration_type).toBe('Specialist registration');
  });
  it('returns nulls, never throws, on unrelated text', () => {
    const r = parseRegistrationFromText('Please find attached.');
    expect(r.registration_number).toBeNull();
    expect(r.effective_date).toBeNull();
    expect(r.supervised_practice.supervisor).toBeNull();
  });
});

describe('normalizeRegistration (validation of model or regex output)', () => {
  it('rejects a number that is not MED + 10 digits and dates that do not parse', () => {
    const n = normalizeRegistration({ registration_number: 'MED123', effective_date: 'soon', expiry_date: '2027-13-40', has_conditions: 'true', condition_items: ['a', { text: 'b' }, ''], review_period_months: '6', supervised_practice: { commencement_date: 'January 25, 2027' } });
    expect(n.registration_number).toBeNull();
    expect(n.effective_date).toBeNull();
    expect(n.expiry_date).toBeNull();
    expect(n.has_conditions).toBe(true);
    expect(n.condition_items).toEqual(['a', 'b']);
    expect(n.review_period_months).toBe(6);
    expect(n.supervised_practice.commencement_date).toBe('2027-01-25');
  });
  it('accepts a valid number (case and spaces normalised)', () => {
    expect(normalizeRegistration({ registration_number: 'med 0004091669' }).registration_number).toBe('MED0004091669');
  });
  it('infers has_conditions from condition items when the flag is missing', () => {
    expect(normalizeRegistration({ condition_items: ['supervised practice'] }).has_conditions).toBe(true);
    expect(normalizeRegistration({}).has_conditions).toBeNull();
  });
});

describe('date helpers', () => {
  it('parses the date forms AHPRA letters and the app use', () => {
    expect(parseDateToIso('2 November 2026')).toBe('2026-11-02');
    expect(parseDateToIso('2nd November 2026')).toBe('2026-11-02');
    expect(parseDateToIso('November 2, 2026')).toBe('2026-11-02');
    expect(parseDateToIso('02/11/2026')).toBe('2026-11-02'); // Australian day first
    expect(parseDateToIso('2026-11-02')).toBe('2026-11-02');
    expect(parseDateToIso('2026-11-02T10:00:00.000Z')).toBe('2026-11-02');
    expect(parseDateToIso('31 February 2026')).toBeNull();
    expect(parseDateToIso('')).toBeNull();
  });
  it('formats, adds days and calendar months (clamping to month end)', () => {
    expect(formatDateLong('2026-11-02')).toBe('2 November 2026');
    expect(addDays('2026-11-02', 30)).toBe('2026-12-02');
    expect(addDays('2027-09-30', -30)).toBe('2027-08-31');
    expect(addMonths('2027-01-25', 3)).toBe('2027-04-25');
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonths('bad', 1)).toBeNull();
  });
});

describe('buildConditionsTrackerDueDates', () => {
  it('builds every tracker item from the effective, commencement and expiry dates', () => {
    const items = buildConditionsTrackerDueDates({ effectiveDate: '2026-11-02', expiryDate: '2027-09-30', commencementDate: '2027-01-25' });
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey.acknowledge_conditions).toMatchObject({ title: 'GP to acknowledge AHPRA conditions to the Compliance Team', due: '2026-12-02', status: 'waiting' });
    expect(byKey.compliance_letter).toMatchObject({ title: 'Watch for the AHPRA Compliance Team letter and file it', due: '2026-11-16', status: 'open' });
    expect(byKey.practice_location_form).toMatchObject({ title: 'Practice location form to Ahpra within 14 days of starting', due: '2027-02-08' });
    expect(byKey.supervision_report_3m).toMatchObject({ title: '3-month supervision report', due: '2027-04-25' });
    expect(byKey.msf_5m).toMatchObject({ title: 'Multi-source feedback (CFEP) within 5 months', due: '2027-06-25' });
    expect(byKey.workplace_assessment_6m).toMatchObject({ title: 'Workplace assessment (Mini-CEX, DOPS or CBD) within 6 months', due: '2027-07-25' });
    expect(byKey.orientation_6m).toMatchObject({ title: 'Orientation and cultural safety education within 6 months', due: '2027-07-25' });
    expect(byKey.supervision_report_6m).toMatchObject({ title: 'Final 6-month supervision report', due: '2027-07-25' });
    expect(byKey.renewal).toMatchObject({ title: 'AHPRA registration renewal before expiry', due: '2027-08-31' });
    expect(items).toHaveLength(9);
  });
  it('skips the commencement-anchored items when no commencement date is known, and the renewal without an expiry', () => {
    const items = buildConditionsTrackerDueDates({ effectiveDate: '2026-11-02' });
    expect(items.map((i) => i.key)).toEqual(['acknowledge_conditions', 'compliance_letter']);
  });
  it('anchors the two early items on `now` when the effective date is unknown', () => {
    const items = buildConditionsTrackerDueDates({ now: '2026-11-05', commencementDate: '2027-01-25' });
    expect(items.find((i) => i.key === 'acknowledge_conditions').due).toBe('2026-12-05');
    expect(items.find((i) => i.key === 'practice_location_form').due).toBe('2027-02-08');
  });
  it('returns nothing without any anchor', () => {
    expect(buildConditionsTrackerDueDates({})).toEqual([]);
  });
});

describe('docKeyForAhpraAttachment', () => {
  it('maps AHPRA attachment names onto My Documents keys and skips fact sheets', () => {
    expect(docKeyForAhpraAttachment(FINAL_NOTICE_EMAIL.attachments[0].filename)).toBe('ahpra_registration_notice');
    expect(docKeyForAhpraAttachment(FINAL_NOTICE_EMAIL.attachments[1].filename)).toBe('ahpra_conditions_schedule');
    expect(docKeyForAhpraAttachment('Appeals fact sheet.pdf')).toBeNull();
    expect(docKeyForAhpraAttachment('Fact Sheet - Appeals.pdf')).toBeNull();
    expect(docKeyForAhpraAttachment('Certificate of registration.pdf')).toBe('ahpra_registration_certificate');
    expect(docKeyForAhpraAttachment('Notice to propose approval - APP.PDF')).toBe('ahpra_proposal_notice');
    expect(docKeyForAhpraAttachment('Notice of approval for registration.pdf')).toBe('ahpra_registration_notice');
    expect(docKeyForAhpraAttachment('')).toBeNull();
  });
});

describe('dependantsFromHousehold (onboarding who_moving values)', () => {
  it('just_me / me → nobody; me_partner → spouse; me_children → children; me_partner_children → both', () => {
    expect(dependantsFromHousehold('just_me', '')).toEqual([]);
    expect(dependantsFromHousehold('me', '0')).toEqual([]);
    expect(dependantsFromHousehold('me_partner', '')).toEqual([{ relationship: 'spouse', full_name: 'Partner (name to be confirmed)', label: "Partner's passport" }]);
    expect(dependantsFromHousehold('me_children', '2').map((d) => d.full_name)).toEqual(['Child 1', 'Child 2']);
    expect(dependantsFromHousehold('me_partner_children', 3).map((d) => d.label)).toEqual(["Partner's passport", 'Child 1 passport', 'Child 2 passport', 'Child 3 passport']);
  });
  it('assumes one child when children are moving but the count is blank', () => {
    expect(dependantsFromHousehold('me_children', '')).toHaveLength(1);
  });
  it('tolerates the display labels the older profile rows stored', () => {
    expect(dependantsFromHousehold('Family', '1').map((d) => d.relationship)).toEqual(['spouse', 'child']);
    expect(dependantsFromHousehold('Me & partner', '').map((d) => d.relationship)).toEqual(['spouse']);
    expect(dependantsFromHousehold('Just me', '')).toEqual([]);
  });
});

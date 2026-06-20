import { describe, it, expect } from 'vitest';
import s80 from '../lib/ahpra-s80.js';

// A representative AHPRA s80(1)(b) notice body (the real Smith Miller / ref 1460970
// example), trimmed to the parts that matter for extraction fidelity.
const NOTICE_BODY = `Notice to provide further information under section 80(1)(b)
Reference: 1460970

Dear Sir/Madam,

To progress Mr Hussain's application we require the following no later than 29 August 2025:

1. A Certificate of Good Standing from the GMC, sent directly to AHPRA.
2. Primary source verification of your qualifications via ECFMG/EPIC and the AMC.
3. Confirmation of your IELTS/OET result, sent directly from the testing body.
4. English language reference letters (your OET is more than two years old).
5. Completed Supervised practice plan (SPPA-00). While I can confirm receipt of your
   Supervised practice plan, the following attachments have not been provided and are needed:
   - A signed and dated CV of the primary supervisor (required at Q3 of SPPA-00)
   - A signed and dated CV of the alternate supervisor(s) (required at Q4 of SPPA-00)
   - If applicable, additional details on how potential conflicts of interest will be managed
   - Position description for the proposed role(s) (required at Q10 of SPPA-00)
   - Attachment to the SPPA-00 - Section G form: Supervised practice goals and activities

Please ensure all documentation is certified and submitted via return email or your Ahpra Portal.`;

// What the model would return for that notice (we test our normalisation/parsing,
// not the model itself).
const MODEL_REPLY = JSON.stringify({
  deadline: '2025-08-29',
  reference: '1460970',
  items: [
    { title: 'Certificate of Good Standing from GMC', detail: 'A Certificate of Good Standing from the GMC, sent directly to AHPRA.', sub_items: [], owner: 'gp', mode: 'request_institution', institution: 'GMC', kind: 'good_standing' },
    { title: 'Primary source verification (ECFMG/EPIC + AMC)', detail: 'Primary source verification of your qualifications via ECFMG/EPIC and the AMC.', sub_items: [], owner: 'gp', mode: 'upload', institution: '', kind: 'qualification_check' },
    { title: 'English test confirmation (IELTS/OET)', detail: 'Confirmation of your IELTS/OET result, sent directly from the testing body.', sub_items: [], owner: 'gp', mode: 'request_institution', institution: 'OET', kind: 'english' },
    { title: 'English language reference letters', detail: 'English language reference letters (your OET is more than two years old).', sub_items: [], owner: 'gp', mode: 'upload', institution: '', kind: '' },
    { title: 'Completed Supervised practice plan (SPPA-00)', detail: 'The following attachments have not been provided and are needed.', sub_items: [
      'A signed and dated CV of the primary supervisor (required at Q3 of SPPA-00)',
      'A signed and dated CV of the alternate supervisor(s) (required at Q4 of SPPA-00)',
      'If applicable, additional details on how potential conflicts of interest will be managed',
      'Position description for the proposed role(s) (required at Q10 of SPPA-00)',
      'Attachment to the SPPA-00 - Section G form: Supervised practice goals and activities'
    ], owner: 'gp', mode: 'upload', institution: '', kind: 'supervised_practice_plan' }
  ]
});

describe('ahpra-s80 extraction prompt', () => {
  it('includes the email body and the no-dropping instruction', () => {
    const prompt = s80.buildExtractionPrompt({ subject: 'Notice', sender: 'officer@ahpra.gov.au', bodyText: NOTICE_BODY });
    expect(prompt).toContain('1460970');
    expect(prompt).toContain('SPPA-00');
    expect(prompt).toContain('keep them all');
    expect(s80.EXTRACTION_SYSTEM).toMatch(/NEVER drop/i);
  });

  it('passes through a long body (>8000 chars no longer truncates it away)', () => {
    const big = 'x'.repeat(12000);
    const prompt = s80.buildExtractionPrompt({ bodyText: big });
    // Old limit was 8000; new limit is 16000, so a 12000-char body survives intact.
    expect(prompt).toContain('x'.repeat(12000));
  });
});

describe('ahpra-s80 parsing + normalisation', () => {
  it('parses JSON embedded in surrounding prose', () => {
    const parsed = s80.parseExtractionText('Here you go:\n' + MODEL_REPLY + '\nThanks');
    expect(parsed).not.toBeNull();
    expect(Array.isArray(parsed.items)).toBe(true);
  });

  it('returns null on non-JSON so the caller can fail loud', () => {
    expect(s80.parseExtractionText('sorry, no idea')).toBeNull();
    expect(s80.parseExtractionText('')).toBeNull();
  });

  it('preserves the deadline and reference', () => {
    const norm = s80.normalizeExtraction(s80.parseExtractionText(MODEL_REPLY));
    expect(norm.deadline).toBe('2025-08-29');
    expect(norm.reference).toBe('1460970');
    expect(norm.items.length).toBe(5);
  });

  it('does NOT drop the SPPA-00 sub-attachments (information fidelity)', () => {
    const norm = s80.normalizeExtraction(s80.parseExtractionText(MODEL_REPLY));
    const sppa = norm.items.find((i) => /SPPA-00/.test(i.title));
    expect(sppa).toBeTruthy();
    expect(sppa.sub_items.length).toBe(5);
    expect(sppa.sub_items.map((s) => s.label).join(' | ')).toContain('primary supervisor');
    expect(sppa.sub_items.map((s) => s.label).join(' | ')).toContain('Section G');
    // ...and the Q-references survive verbatim.
    expect(sppa.sub_items.some((s) => /Q3 of SPPA-00/.test(s.label))).toBe(true);
  });

  it('forces the supervised practice plan to be team-owned even if the model said gp/upload', () => {
    const sppa = s80.normalizeItem({ title: 'Completed Supervised practice plan (SPPA-00)', owner: 'gp', mode: 'upload' });
    expect(sppa.owner).toBe('team');
    expect(sppa.mode).toBe('team');
  });

  it('forces the qualification/PSV check to team (so the team books a guidance call)', () => {
    const psv = s80.normalizeItem({ title: 'Primary source verification (ECFMG/EPIC + AMC)', owner: 'gp', mode: 'upload', kind: 'qualification_check' });
    expect(psv.owner).toBe('team');
    expect(psv.mode).toBe('team');
  });

  it('keeps the Certificate of Good Standing as a GP request-from-institution item', () => {
    const cogs = s80.normalizeItem({ title: 'Certificate of Good Standing from GMC', owner: 'gp', mode: 'request_institution', institution: 'GMC', kind: 'good_standing' });
    expect(cogs.owner).toBe('gp');
    expect(cogs.mode).toBe('request_institution');
    expect(cogs.institution).toBe('GMC');
  });

  it('keeps reference letters as a GP upload item', () => {
    const refs = s80.normalizeItem({ title: 'English language reference letters', owner: 'gp', mode: 'upload' });
    expect(refs.owner).toBe('gp');
    expect(refs.mode).toBe('upload');
  });

  it('preserves spaces in titles (regression: cleanString must not strip spaces)', () => {
    const item = s80.normalizeItem({ title: 'Certificate of Good Standing from GMC' });
    expect(item.title).toBe('Certificate of Good Standing from GMC');
  });

  it('maps legacy owner words (practice/hazel) onto team', () => {
    expect(s80.normalizeItem({ title: 'X', owner: 'hazel' }).owner).toBe('team');
    expect(s80.normalizeItem({ title: 'Y', owner: 'practice', mode: 'upload' }).owner).toBe('team');
  });
});

describe('ahpra-s80 reference detection', () => {
  it('finds the reference number in the raw text', () => {
    expect(s80.detectReference('Reference: 1460970 blah')).toBe('1460970');
    expect(s80.detectReference('no number here')).toBeNull();
  });
});

describe('ahpra-s80 combined reply draft', () => {
  it('lists the requested items, asks AHPRA to confirm receipt, and names attachments', () => {
    const draft = s80.buildCombinedReplyDraft({
      gpFullName: 'Smith Miller',
      reference: '1460970',
      threadSubject: 'Notice to provide further information under section 80(1)(b)',
      requestedItems: [
        { title: 'Certificate of Good Standing', institution: 'GMC' },
        { title: 'English test confirmation', institution: 'OET' }
      ],
      uploadItems: [{ title: 'English language reference letters' }]
    });
    expect(draft.subject).toMatch(/^Re:/);
    expect(draft.body).toContain('1460970');
    expect(draft.body).toContain('Smith Miller');
    expect(draft.body).toContain('confirm receipt');
    expect(draft.body).toContain('Certificate of Good Standing');
    expect(draft.body).toContain('direct from GMC');
    expect(draft.body).toContain('English language reference letters');
  });

  it('does not double-prefix an already-Re: subject', () => {
    const draft = s80.buildCombinedReplyDraft({ threadSubject: 'Re: Something', requestedItems: [{ title: 'X' }] });
    expect(draft.subject).toBe('Re: Something');
  });
});

describe('ahpra-s80 shortDescription', () => {
  it('summarises owner/mode and flags multi-attachment items', () => {
    const sppa = s80.normalizeItem({ title: 'SPPA-00', sub_items: ['a', 'b', 'c'] });
    const desc = s80.shortDescription(sppa);
    expect(desc).toContain('Team');
    expect(desc).toContain('3 required attachments');
  });
});

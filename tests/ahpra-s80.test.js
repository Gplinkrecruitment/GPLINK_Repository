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

  it('maps legacy owner words (hazel/support) onto team; "practice" is now a real owner', () => {
    expect(s80.normalizeItem({ title: 'X', owner: 'hazel' }).owner).toBe('team');
    expect(s80.normalizeItem({ title: 'X', owner: 'support' }).mode).toBe('team');
    // A practice-owned item always pairs with the practice_upload mode (the model said "upload").
    const p = s80.normalizeItem({ title: 'Y', owner: 'practice', mode: 'upload' });
    expect(p.owner).toBe('practice');
    expect(p.mode).toBe('practice_upload');
  });
});

describe('ahpra-s80 calendar-date validation', () => {
  it('accepts real dates and rejects shape-valid-but-impossible ones', () => {
    expect(s80.isRealDate('2025-08-29')).toBe(true);
    expect(s80.isRealDate('2024-02-29')).toBe(true); // leap year
    expect(s80.isRealDate('2025-02-30')).toBe(false);
    expect(s80.isRealDate('2025-13-01')).toBe(false);
    expect(s80.isRealDate('2025-00-15')).toBe(false);
    expect(s80.isRealDate('not-a-date')).toBe(false);
  });

  it('normalizeExtraction nulls an impossible deadline (would otherwise crash the DATE insert)', () => {
    const norm = s80.normalizeExtraction({ deadline: '2025-02-30', items: [{ title: 'X', owner: 'gp', mode: 'upload' }] });
    expect(norm.deadline).toBeNull();
    expect(norm.items.length).toBe(1);
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

describe('ahpra-s80 GP-facing rewrite (not the officer point of view)', () => {
  it('prompt asks for gp_instructions and tells the model how to handle "to my email"', () => {
    const prompt = s80.buildExtractionPrompt(
      { subject: 'Notice', sender: 'jane@ahpra.gov.au', bodyText: NOTICE_BODY },
      { officer: { name: 'Jane Officer', email: 'jane.officer@ahpra.gov.au' } }
    );
    expect(prompt).toContain('gp_instructions');
    expect(prompt).toContain('directly to your assigned AHPRA officer');
    // The real officer address is surfaced so the model uses it instead of "my email".
    expect(prompt).toContain('jane.officer@ahpra.gov.au');
  });

  it('treats the generic placeholder officer@ahpra.gov.au as unknown', () => {
    const prompt = s80.buildExtractionPrompt(
      { bodyText: NOTICE_BODY },
      { officer: { name: '', email: 'officer@ahpra.gov.au' } }
    );
    expect(prompt).not.toContain('<officer@ahpra.gov.au>');
  });

  it('carries the model gp_instructions through normalisation', () => {
    const item = s80.normalizeItem({
      title: 'English language reference letters',
      detail: 'Your OET is more than two years old...',
      gp_instructions: 'You need to gather employer reference letters confirming your continuous employment.',
      owner: 'gp', mode: 'upload'
    });
    expect(item.gp_instructions).toContain('You need to gather employer reference letters');
    // The verbatim officer detail is preserved separately (fidelity).
    expect(item.detail).toContain('two years old');
  });

  it('synthesises a GP instruction when the model omits one', () => {
    const upload = s80.normalizeItem({ title: 'Employer reference letters', owner: 'gp', mode: 'upload' });
    expect(upload.gp_instructions.toLowerCase()).toContain('upload');
    const req = s80.normalizeItem({ title: 'Some certificate', owner: 'gp', mode: 'request_institution', institution: 'GMC' });
    expect(req.gp_instructions).toContain('GMC');
    expect(req.gp_instructions.toLowerCase()).toContain('directly to ahpra');
  });
});

describe('ahpra-s80 officer-email substitution (no "send it to my email address")', () => {
  it('replaces "to my email address" with the named assigned officer', () => {
    const out = s80.applyOfficerEmail(
      'Please request this and have the GMC send it direct from the GMC to my email address.',
      { name: 'Jane Officer', email: 'jane.officer@ahpra.gov.au' }
    );
    expect(out).not.toMatch(/my email address/i);
    expect(out).toContain('jane.officer@ahpra.gov.au');
    expect(out).toContain('Jane Officer');
  });

  it('falls back to a generic phrase when the officer email is unknown', () => {
    const out = s80.applyOfficerEmail('Send it directly to me.', {});
    expect(out).not.toMatch(/\bto me\b/i);
    expect(out).toContain('your assigned AHPRA officer');
  });

  it('does not leave a dangling "at <address>" when an email follows "to me"', () => {
    const out = s80.applyOfficerEmail('Send these to me at john@example.com.', { name: 'Jane Officer', email: 'jane@ahpra.gov.au' });
    expect(out).not.toContain('john@example.com');
    expect(out).toContain('jane@ahpra.gov.au');
    // Exactly one email address remains (the officer's) — no doubled "at … at …".
    expect((out.match(/@/g) || []).length).toBe(1);
  });

  it('does not present an email username as the officer\'s name', () => {
    const out = s80.applyOfficerEmail('Please send it to my email address.', { name: 'jane.officer', email: 'jane.officer@ahpra.gov.au' });
    expect(out).toContain('your assigned AHPRA officer at jane.officer@ahpra.gov.au');
    expect(out).not.toMatch(/officer, jane\.officer,/);
  });

  it('scrubs the officer wording from synthesised GP instructions too', () => {
    const item = s80.normalizeItem(
      { title: 'Statutory declaration', detail: 'send it to my email address', owner: 'gp', mode: 'upload', gp_instructions: 'Please email it to my email address.' },
      { officer: { name: 'Jane', email: 'jane@ahpra.gov.au' } }
    );
    expect(item.gp_instructions).not.toMatch(/my email address/i);
    expect(item.gp_instructions).toContain('jane@ahpra.gov.au');
  });
});

describe('ahpra-s80 reuse of the app\'s "Show me how" steps', () => {
  it('attaches the Certificate of Good Standing steps + AHPRA mailbox (UK)', () => {
    const item = s80.normalizeItem(
      { title: 'Certificate of Good Standing from GMC', owner: 'gp', mode: 'request_institution', institution: 'GMC', kind: 'good_standing' },
      { country: 'uk' }
    );
    expect(item.how_to_steps.length).toBeGreaterThan(0);
    expect(item.doc_guide_key).toBe('certificate_good_standing');
    expect(item.how_to_steps.join(' ')).toContain('COGS@ahpra.gov.au');
  });

  it('attaches the Confirmation of GP training steps + AHPRA mailbox (UK)', () => {
    const item = s80.normalizeItem(
      { title: 'Confirmation of GP training with the RCGP from the GMC', owner: 'gp', mode: 'request_institution', institution: 'GMC' },
      { country: 'uk' }
    );
    expect(item.doc_guide_key).toBe('confirmation_training');
    expect(item.how_to_steps.join(' ')).toContain('registration18@ahpra.gov.au');
  });

  it('does NOT attach GP steps to team-owned items (SPPA-00 / PSV)', () => {
    const sppa = s80.normalizeItem({ title: 'Supervised practice plan (SPPA-00)', owner: 'gp', mode: 'upload' }, { country: 'uk' });
    expect(sppa.owner).toBe('team');
    expect(sppa.how_to_steps.length).toBe(0);
  });

  it('leaves how_to_steps empty for documents we do not already guide', () => {
    const item = s80.normalizeItem({ title: 'English language reference letters', owner: 'gp', mode: 'upload' }, { country: 'uk' });
    expect(item.how_to_steps.length).toBe(0);
    expect(item.doc_guide_key).toBe('');
  });

  it('picks the country-specific training guide (NZ → RNZCGP)', () => {
    const item = s80.normalizeItem(
      { title: 'Confirmation of training (RNZCGP)', owner: 'gp', mode: 'upload' },
      { country: 'nz' }
    );
    expect(item.doc_guide_key).toBe('rnzcgp_confirmation_letter');
  });

  it('does NOT attach training steps to an unrelated item that merely mentions CCT', () => {
    const item = s80.normalizeItem({ title: 'Upload your CCT certificate', owner: 'gp', mode: 'upload' }, { country: 'uk' });
    expect(item.doc_guide_key).toBe('');
    expect(item.how_to_steps.length).toBe(0);
  });
});

describe('RSO refinements: team_instructions, PSV/MyIntealth/AMC → Zoom call, drop submission-info', () => {
  it('keeps a model-supplied team_instructions rewrite', () => {
    const item = s80.normalizeItem({ title: 'Reference letters', owner: 'gp', mode: 'upload', team_instructions: 'Ask the doctor to upload two recent employer reference letters.' }, {});
    expect(item.team_instructions).toBe('Ask the doctor to upload two recent employer reference letters.');
    expect(item.needs_call).toBe(false);
  });

  it('falls back to a team_instructions for a plain upload item', () => {
    const item = s80.normalizeItem({ title: 'Curriculum Vitae', owner: 'gp', mode: 'upload' }, {});
    expect(item.team_instructions).toMatch(/upload/i);
    expect(item.team_instructions).toContain('Curriculum Vitae');
  });

  it('routes a MyIntealth item to team + a book-a-Zoom-call flag', () => {
    const item = s80.normalizeItem({ title: 'MyIntealth submission still pending', detail: 'The MyIntealth portal shows no submission.' }, {});
    expect(item.owner).toBe('team');
    expect(item.mode).toBe('team');
    expect(item.kind).toBe('qualification_check');
    expect(item.needs_call).toBe(true);
    expect(item.team_instructions).toMatch(/zoom call/i);
  });

  it('routes AMC and PSV items to team + the book-a-call flag', () => {
    const amc = s80.normalizeItem({ title: 'AMC portfolio assessment outstanding' }, {});
    expect(amc.kind).toBe('qualification_check');
    expect(amc.needs_call).toBe(true);
    const psv = s80.normalizeItem({ title: 'Primary source verification via ECFMG' }, {});
    expect(psv.needs_call).toBe(true);
    expect(psv.owner).toBe('team');
  });

  it('flags a normal document upload as NOT needing a call', () => {
    const item = s80.normalizeItem({ title: 'Signed CV', owner: 'gp', mode: 'upload' }, {});
    expect(item.needs_call).toBe(false);
  });

  it('isSubmissionInfoItem detects a "how to submit" process line, not real documents', () => {
    expect(s80.isSubmissionInfoItem({ title: 'How to submit documents to Ahpra' })).toBe(true);
    expect(s80.isSubmissionInfoItem({ title: 'Submitting your documents' })).toBe(true);
    expect(s80.isSubmissionInfoItem({ title: 'Curriculum Vitae (CV)' })).toBe(false);
    expect(s80.isSubmissionInfoItem({ title: 'Certificate of Good Standing from GMC' })).toBe(false);
  });

  it('normalizeExtraction drops a "how to submit" item but keeps real documents', () => {
    const out = s80.normalizeExtraction({ items: [
      { title: 'How to submit documents to Ahpra', detail: 'Send everything through the portal.' },
      { title: 'Curriculum Vitae (CV)', owner: 'gp', mode: 'upload' },
      { title: 'Primary source verification (PSV)' }
    ] }, {});
    const titles = out.items.map(i => i.title);
    expect(titles).not.toContain('How to submit documents to Ahpra');
    expect(titles).toContain('Curriculum Vitae (CV)');
    expect(out.items.length).toBe(2);
    expect(out.items.every(i => (i.team_instructions || '').length > 0)).toBe(true);
  });

  it('isStatutoryDeclarationItem detects a stat-dec item, not real documents', () => {
    expect(s80.isStatutoryDeclarationItem({ title: 'Statutory Declaration' })).toBe(true);
    expect(s80.isStatutoryDeclarationItem({ title: 'Statutory declaration of identity' })).toBe(true);
    expect(s80.isStatutoryDeclarationItem({ title: 'Stat dec confirming an employment gap' })).toBe(true);
    expect(s80.isStatutoryDeclarationItem({ title: 'Certificate of Good Standing from GMC' })).toBe(false);
  });

  it('normalizeExtraction drops a statutory declaration item (GP waits for GMC confirmation) but keeps good standing', () => {
    const out = s80.normalizeExtraction({ items: [
      { title: 'Statutory Declaration', detail: 'A statutory declaration confirming your registration.' },
      { title: 'Certificate of Good Standing from GMC', detail: 'From the GMC; if unavailable a statutory declaration may be accepted.', owner: 'gp', mode: 'request_institution', institution: 'GMC', kind: 'good_standing' }
    ] }, {});
    const titles = out.items.map(i => i.title);
    expect(titles).not.toContain('Statutory Declaration');
    expect(titles).toContain('Certificate of Good Standing from GMC'); // kept even though its detail mentions a stat dec
    expect(out.items.length).toBe(1);
  });
});

describe('officer-reply draft + prompt', () => {
  it('template renders name/title/reference and a Re: subject', () => {
    const d = s80.buildOfficerReplyDraft({ gpName: 'Smith Miller', itemTitle: 'Curriculum Vitae', reference: '1460970', officerName: 'Helen' });
    expect(d.subject).toMatch(/^Re:/);
    expect(d.body).toContain('Curriculum Vitae');
    expect(d.body).toContain('Smith Miller');
    expect(d.body).toContain('1460970');
  });
  it('template is safe with missing fields', () => {
    const d = s80.buildOfficerReplyDraft({});
    expect(typeof d.subject).toBe('string');
    expect(d.body.length).toBeGreaterThan(0);
  });
  it('AI prompt grounds with item + gp + reference', () => {
    const m = s80.buildOfficerReplyMessages({ gpName: 'Smith Miller', itemTitle: 'Signed CV', requirement: 'A signed, dated CV', reference: '1460970', officerName: 'Helen' });
    expect(m.system).toMatch(/AHPRA/i);
    expect(m.userText).toContain('Signed CV');
    expect(m.userText).toContain('Smith Miller');
    expect(m.userText).toContain('1460970');
  });
});

// ── 2026-09-14 (Dr Mercy's notice): practice-owned items, tray routing, duplicate items ──

// The two real items the model returned for one resubmitted CV.
const MERCY_CV = { title: 'Resubmission of CV with gaps explained', owner: 'gp', mode: 'upload', kind: '',
  detail: 'Resubmission of CV - We note that you have provided your CV, however, note that you have not included periods of maternity leave in your CV (as mentioned in the documents from your employer). Therefore, please resubmit your CV, with any gaps in practice explained, and the dates of those gaps in practice.',
  gp_instructions: 'Please update and resubmit your CV so it includes your full practice history, including your maternity leave period, with clear dates and explanations for any gaps.',
  team_instructions: 'AHPRA wants an updated CV that includes all practice gaps with dates and reasons explained. Ask the doctor to resubmit a complete CV covering this.' };
const MERCY_ENGLISH = { title: 'Evidence of meeting English language skills registration standard', owner: 'gp', mode: 'upload', kind: 'english',
  detail: 'It\'s acknowledged that you have provided a copy of your PLAB completed on 8/11/2019. While this is an accepted English language test, the test is more than two years old. As your current CV does not have the dates of your gaps in practice, we require resubmission of your CV before we are able to assess this further.',
  gp_instructions: 'Your PLAB test from 8/11/2019 is now more than two years old, so AHPRA needs to see that you started work within 12 months of the test. This ties in with the CV resubmission — make sure your gaps in practice and dates are clearly shown.',
  team_instructions: 'AHPRA won\'t accept the 2019 PLAB test as-is; the work history needs to be shown clearly via the resubmitted CV. Make sure the CV resubmission addresses this alongside the gaps-in-practice request.' };
const MERCY_SUP_CV = { title: 'Supervisor CV clarification/resubmission (Dr Ranatunga)', owner: 'team', mode: 'team', kind: 'supervised_practice_plan',
  detail: 'Supervisor CV - We acknowledge receipt of your supervisor\'s CV however note in the employment section of Dr Ranatunga\'s CV, it states that they currently work at White Cross Accident and Medical Clinic in NZ. If this is not current information, we will need resubmission of Dr Ranatunga\'s CV with those dates amended.',
  gp_instructions: 'AHPRA has a query about your supervisor Dr Ranatunga\'s CV.', team_instructions: 'This is a supervisor CV query tied to the supervised practice plan.' };

describe('practice-owned items ("Practice uploads")', () => {
  it('prompt offers the practice owner, practice_upload mode, practice_instructions and deliverable', () => {
    const prompt = s80.buildExtractionPrompt({ bodyText: 'x' });
    expect(prompt).toContain('"practice"');
    expect(prompt).toContain('practice_upload');
    expect(prompt).toContain('practice_instructions');
    expect(prompt).toContain('"deliverable"');
    expect(prompt).toContain('ONE DOCUMENT = ONE ITEM');
    expect(prompt).toMatch(/Never use em dashes/);
  });

  it('routes a standalone supervisor-CV query to the practice even though the model tagged it as SPPA', () => {
    const item = s80.normalizeItem(MERCY_SUP_CV);
    expect(item.owner).toBe('practice');
    expect(item.mode).toBe('practice_upload');
    expect(item.kind).toBe('practice_document');
    expect(item.practice_instructions).toContain('Supervisor CV clarification');
    expect(item.practice_instructions).not.toMatch(/—/);
    expect(item.team_instructions).toBe(MERCY_SUP_CV.team_instructions);
  });

  it('keeps the SPPA-00 form itself (with its listed attachments) with the team', () => {
    const item = s80.normalizeItem({ title: 'Completed Supervised practice plan (SPPA-00)', detail: 'A signed and dated CV of the primary supervisor (required at Q3 of SPPA-00)', owner: 'gp', mode: 'upload', sub_items: ['CV of supervisor', 'Position description'] });
    expect(item.owner).toBe('team');
    expect(item.mode).toBe('team');
    expect(item.kind).toBe('supervised_practice_plan');
  });

  it('does NOT send the doctor\'s own CV or previous-employer reference letters to the practice', () => {
    expect(s80.normalizeItem(MERCY_CV).owner).toBe('gp');
    const ref = s80.normalizeItem({ title: 'Employer reference letters', detail: 'Reference letters from your previous employers covering the last two years.', owner: 'gp', mode: 'upload' });
    expect(ref.owner).toBe('gp');
    expect(ref.mode).toBe('upload');
    expect(s80.isPracticeDocumentItem({ title: 'Position description for the proposed role' })).toBe(true);
    expect(s80.isPracticeDocumentItem({ title: 'Certificate of Good Standing', detail: 'as mentioned in the documents from your employer' })).toBe(false);
    // Previous-employer paperwork is the doctor's history even when the words match.
    expect(s80.isPracticeDocumentItem({ title: 'Statement of service', detail: 'A statement of service signed by the practice principal at your previous employer.' })).toBe(false);
    expect(s80.isPracticeDocumentItem({ title: 'Position description for your previous role' })).toBe(false);
  });

  it('the wording test never overrides a model "gp" call — it only promotes team/untagged items', () => {
    const gpSaid = s80.normalizeItem({ title: 'Letter from the practice you worked at in 2019', detail: 'Provide a letter from the practice confirming your hours.', owner: 'gp', mode: 'upload' });
    expect(gpSaid.owner).toBe('gp');
    const untagged = s80.normalizeItem({ title: 'Letter from the practice confirming supervision arrangements', detail: 'Please provide a letter from the practice.' });
    expect(untagged.owner).toBe('practice');
    expect(untagged.mode).toBe('practice_upload');
  });

  it('a model owner "practice" always pairs with practice_upload; practice_upload always pairs with practice', () => {
    expect(s80.normalizeItem({ title: 'Letter from the practice', owner: 'practice', mode: 'upload' }).mode).toBe('practice_upload');
    const byMode = s80.normalizeItem({ title: 'Signed letter', owner: 'gp', mode: 'practice_upload' });
    expect(byMode.owner).toBe('practice');
    expect(byMode.gp_instructions).toBe('');
  });

  it('shortDescription labels practice items', () => {
    expect(s80.shortDescription({ owner: 'practice', mode: 'practice_upload', detail: 'x' })).toMatch(/^\[Practice · practice uploads\]/);
  });

  it('practice request email: template names the document, asks for a reply with it attached, no em dashes', () => {
    const d = s80.buildPracticeRequestDraft({ gpName: 'Mercy Obanimoh', contactName: 'Jane', itemTitle: 'Updated CV for Dr Ranatunga', practiceInstructions: 'AHPRA needs the dates he finished at the NZ clinics.', reference: '14805868', deadline: '29 September 2026', senderName: 'Hazel' });
    expect(d.subject).toContain('Updated CV for Dr Ranatunga');
    expect(d.subject).toContain('14805868');
    expect(d.body).toContain('Hi Jane,');
    expect(d.body).toContain('Dr Mercy Obanimoh');
    expect(d.body).toContain('reply to this email with the document attached by 29 September 2026');
    expect(d.body).toContain('AHPRA needs the dates');
    expect(d.body).toMatch(/Kind regards,\nHazel$/);
    expect(d.body).not.toMatch(/—/);
    const bare = s80.buildPracticeRequestDraft({});
    expect(bare.body).toContain('Hi there,');
    expect(bare.body).toContain('at your earliest convenience');
  });

  it('practice request AI prompt grounds with the practice, doctor, document and reference', () => {
    const m = s80.buildPracticeRequestMessages({ gpName: 'Mercy Obanimoh', contactName: 'Jane', practiceName: 'The Doctors Werribee', itemTitle: 'Updated supervisor CV', reference: '14805868', senderName: 'Hazel' });
    expect(m.system).toMatch(/practice manager/);
    expect(m.system).toMatch(/no em dashes/);
    expect(m.userText).toContain('Jane at The Doctors Werribee');
    expect(m.userText).toContain('Updated supervisor CV');
    expect(m.userText).toContain('14805868');
    expect(m.userText).toContain('Sign off as: Hazel');
  });
});

describe('tray routing (applyRouting / ensureInstructions)', () => {
  const base = { owner: 'gp', mode: 'upload', ai_owner: 'gp', ai_mode: 'upload' };
  it('every mode implies its owner', () => {
    expect(s80.applyRouting(base, { mode: 'team' })).toEqual({ owner: 'team', mode: 'team' });
    expect(s80.applyRouting(base, { mode: 'practice_upload' })).toEqual({ owner: 'practice', mode: 'practice_upload' });
    expect(s80.applyRouting({ owner: 'team', mode: 'team' }, { mode: 'request_institution' })).toEqual({ owner: 'gp', mode: 'request_institution' });
  });
  it('Who=Team → team/team; back to GP → the AI\'s original GP mode (the revert the RSO expects)', () => {
    const t = s80.applyRouting(base, { owner: 'team' });
    expect(t).toEqual({ owner: 'team', mode: 'team' });
    expect(s80.applyRouting(Object.assign({}, base, t), { owner: 'gp' })).toEqual({ owner: 'gp', mode: 'upload' });
    // Without an AI record, the item's nature decides (good standing → request from institution).
    expect(s80.applyRouting({ owner: 'team', mode: 'team', kind: 'good_standing' }, { owner: 'gp' })).toEqual({ owner: 'gp', mode: 'request_institution' });
    expect(s80.applyRouting({ owner: 'team', mode: 'team' }, { owner: 'gp' })).toEqual({ owner: 'gp', mode: 'upload' });
  });
  it('Who=Practice → practice/practice_upload; back to GP restores the GP mode', () => {
    const p = s80.applyRouting(base, { owner: 'practice' });
    expect(p).toEqual({ owner: 'practice', mode: 'practice_upload' });
    expect(s80.applyRouting(Object.assign({}, base, p), { owner: 'gp' })).toEqual({ owner: 'gp', mode: 'upload' });
  });
  it('heals Mercy\'s stored team/upload pair even with no change requested; an explicit owner wins over an explicit mode', () => {
    expect(s80.applyRouting({ owner: 'team', mode: 'upload' }, {})).toEqual({ owner: 'gp', mode: 'upload' });
    expect(s80.applyRouting({ owner: 'team', mode: 'upload', ai_owner: 'gp', ai_mode: 'upload' }, { owner: 'gp' })).toEqual({ owner: 'gp', mode: 'upload' });
    expect(s80.applyRouting(base, { owner: 'team', mode: 'upload' })).toEqual({ owner: 'team', mode: 'team' });
    expect(s80.applyRouting({}, {})).toEqual({ owner: 'gp', mode: 'upload' });
    expect(s80.applyRouting(base, { owner: 'bogus', mode: 'nonsense' })).toEqual({ owner: 'gp', mode: 'upload' });
  });
  it('ensureInstructions fills only what is missing and never overwrites the AI\'s text', () => {
    expect(s80.ensureInstructions({ owner: 'gp', mode: 'upload', title: 'Reference letter', gp_instructions: 'Keep me' }, {})).toEqual({});
    const gp = s80.ensureInstructions({ owner: 'gp', mode: 'upload', title: 'Reference letter', detail: 'x' }, {});
    expect(gp.gp_instructions.toLowerCase()).toContain('upload');
    const inst = s80.ensureInstructions({ owner: 'gp', mode: 'request_institution', institution: 'GMC', title: 'Some certificate', detail: 'send to my email address', officer: { name: 'Paige Hooper', email: 'Paige.Hooper@ahpra.gov.au' } }, {});
    expect(inst.gp_instructions).toContain('GMC');
    expect(inst.gp_instructions).toContain('directly to AHPRA');
    const pr = s80.ensureInstructions({ owner: 'practice', mode: 'practice_upload', title: 'Updated supervisor CV' }, {});
    expect(pr.practice_instructions).toContain('Updated supervisor CV');
    expect(s80.ensureInstructions({ owner: 'team', mode: 'team', title: 'X' }, {})).toEqual({});
  });
  it('dashesToSentences turns a spaced dash into a sentence break and leaves date ranges alone', () => {
    expect(s80.dashesToSentences('This ties in with the CV resubmission — make sure your dates are shown.')).toBe('This ties in with the CV resubmission. Make sure your dates are shown.');
    expect(s80.dashesToSentences('Worked 2019–2021 in Leeds.')).toBe('Worked 2019–2021 in Leeds.');
    expect(s80.dashesToSentences('No dash here.')).toBe('No dash here.');
    expect(s80.dashesToSentences('')).toBe('');
  });
});

describe('duplicate items: one document asked for twice becomes one task', () => {
  it('folds the English-language item into the CV resubmission item, keeping both requirements', () => {
    const norm = s80.normalizeExtraction({ deadline: '2026-09-29', reference: '14805868', items: [MERCY_SUP_CV, MERCY_CV, MERCY_ENGLISH] }, { country: 'uk' });
    expect(norm.items.length).toBe(2);
    const cv = norm.items.find((i) => /Resubmission of CV/.test(i.title));
    expect(cv).toBeTruthy();
    expect(cv.title).toBe('Resubmission of CV with gaps explained (also covers: Evidence of meeting English language skills registration standard)');
    expect(cv.owner).toBe('gp');
    expect(cv.mode).toBe('upload');
    expect(cv.detail).toContain('maternity leave');
    expect(cv.detail).toContain('PLAB');
    expect(cv.gp_instructions).toContain('resubmit your CV');
    expect(cv.gp_instructions).toContain('PLAB test');
    expect(cv.gp_instructions).not.toMatch(/—/);
    expect(cv.team_instructions).toContain('practice gaps');
    expect(cv.team_instructions).toContain('PLAB');
    expect(cv.kind).toBe('english');
    expect(cv.merged_from).toEqual(['Resubmission of CV with gaps explained', 'Evidence of meeting English language skills registration standard']);
    // The supervisor CV (a different document, practice-owned) is untouched.
    expect(norm.items.find((i) => /Supervisor CV/.test(i.title)).owner).toBe('practice');
  });

  it('the item whose TITLE names the CV is the base even when it comes second', () => {
    const merged = s80.mergeDuplicateItems([s80.normalizeItem(MERCY_ENGLISH), s80.normalizeItem(MERCY_CV)]);
    expect(merged.length).toBe(1);
    expect(merged[0].title).toMatch(/^Resubmission of CV with gaps explained \(also covers/);
  });

  it('does not merge items with different owners/modes, different institutions, or no shared deliverable', () => {
    const items = [
      s80.normalizeItem({ title: 'Certificate of Good Standing from GMC', owner: 'gp', mode: 'request_institution', institution: 'GMC', deliverable: 'Certificate of Good Standing' }),
      s80.normalizeItem({ title: 'Certificate of Good Standing from Medical and Dental Council of Nigeria', owner: 'gp', mode: 'request_institution', institution: 'MDCN', deliverable: 'Certificate of Good Standing' }),
      s80.normalizeItem({ title: 'English test confirmation (IELTS/OET)', owner: 'gp', mode: 'request_institution', institution: 'OET', kind: 'english' }),
      s80.normalizeItem(MERCY_CV),
      s80.normalizeItem(MERCY_SUP_CV)
    ];
    expect(s80.mergeDuplicateItems(items).length).toBe(5);
  });

  it('merges on a model-named deliverable when everything else matches', () => {
    const a = s80.normalizeItem({ title: 'Certified copy of primary degree', owner: 'gp', mode: 'upload', deliverable: 'Certified copy of MBBS' });
    const b = s80.normalizeItem({ title: 'Evidence of medical qualification', owner: 'gp', mode: 'upload', deliverable: 'Certified copy of MBBS' });
    const merged = s80.mergeDuplicateItems([a, b]);
    expect(merged.length).toBe(1);
    expect(merged[0].title).toContain('also covers: Evidence of medical qualification');
  });

  it('deliverableSignature: own CV → cv; officer asking for the CV again → weak cv?; supervisor CV → not cv; nothing known → empty', () => {
    expect(s80.deliverableSignature(MERCY_CV)).toBe('cv');
    expect(s80.deliverableSignature(MERCY_ENGLISH)).toBe('cv?');
    expect(s80.deliverableSignature(MERCY_SUP_CV)).toBe('');
    expect(s80.deliverableSignature({ title: 'Reference letters' })).toBe('');
    // A mere mention of the CV in the instructions is not a request for it.
    expect(s80.deliverableSignature({ title: 'Employer reference letters', detail: 'Reference letters from your employers.', team_instructions: 'Check them against the updated CV.' })).toBe('');
  });

  it('two items that only MENTION the CV are never merged with each other, and a mention never swallows a different document', () => {
    const refs = s80.normalizeItem({ title: 'Employer reference letters', detail: 'Reference letters covering the periods in your updated CV. Please provide the letters.', owner: 'gp', mode: 'upload' });
    const training = s80.normalizeItem({ title: 'Evidence of continuing professional development', detail: 'Please provide your CPD record and submit your CV showing the dates.', owner: 'gp', mode: 'upload' });
    expect(s80.mergeDuplicateItems([refs, training]).length).toBe(2);
    // …but the titled CV item does absorb a weak mention.
    expect(s80.mergeDuplicateItems([s80.normalizeItem(MERCY_CV), training]).length).toBe(1);
  });
});

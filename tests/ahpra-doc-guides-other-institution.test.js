// Owner rule (2026-09-17, Dr Mercy's tray): when the letter asks for a document from an issuing body
// outside the UK / Ireland / NZ guides, the steps must tell the doctor to contact THAT body and have
// it send the document straight to AHPRA at the document's mailbox (COGS@ for good standing) or to
// the assigned officer. Her Nigerian Certificate of Good Standing had been given the GMC steps.
import { describe, it, expect } from 'vitest';
import s80 from '../lib/ahpra-s80.js';
import docGuides from '../lib/ahpra-doc-guides.js';

const OFFICER = { name: 'Paige Hooper', email: 'Paige.Hooper@ahpra.gov.au' };
const NIGERIA = {
  title: 'Certificate of Good Standing from Medical and Dental Council of Nigeria',
  detail: 'A Certificate of Good Standing from the Medical and Dental Council of Nigeria, dated within three months of the application and sent directly from the council.',
  owner: 'gp', mode: 'request_institution', institution: 'Medical and Dental Council of Nigeria', kind: 'good_standing'
};

describe('issuing bodies outside the UK / Ireland / NZ guides', () => {
  it('Certificate of Good Standing from another country\'s council: contact that council, COGS@ or the officer, never the GMC steps', () => {
    const item = s80.normalizeItem(NIGERIA, { country: 'uk', officer: OFFICER });
    const steps = item.how_to_steps.join(' ');
    expect(item.doc_guide_key).toBe('certificate_good_standing_other');
    expect(steps).toContain('Contact the Medical and Dental Council of Nigeria and request a Certificate of Good Standing');
    expect(steps).toContain('directly to AHPRA at COGS@ahpra.gov.au, or to your assigned AHPRA officer (Paige Hooper, Paige.Hooper@ahpra.gov.au)');
    expect(steps).toContain('Mark as requested');
    expect(steps).not.toMatch(/GMC|CCPS/);
    expect(item.guide_reminder).toContain('The Medical and Dental Council of Nigeria must send this directly to AHPRA (COGS@ahpra.gov.au or your assigned officer)');
    expect(item.guide_reminder).not.toMatch(/GMC/);
    expect(steps + ' ' + item.guide_reminder).not.toMatch(/[—–]/);
  });

  it('finds the body in the title when the model left institution blank', () => {
    const item = s80.normalizeItem(Object.assign({}, NIGERIA, { institution: '' }), { country: 'uk', officer: OFFICER });
    expect(item.doc_guide_key).toBe('certificate_good_standing_other');
    expect(item.how_to_steps[0]).toContain('Contact the Medical and Dental Council of Nigeria');
  });

  it('without a known officer the steps still name the mailbox and the officer generically', () => {
    const item = s80.normalizeItem(NIGERIA, { country: 'uk' });
    expect(item.how_to_steps[1]).toBe('Ask them to send it directly to AHPRA at COGS@ahpra.gov.au, or to your assigned AHPRA officer.');
  });

  it('a body we guide gets its own country\'s steps whatever the doctor\'s country (UK doctor, Irish certificate)', () => {
    const item = s80.normalizeItem(
      { title: 'Certificate of Good Standing from the Medical Council of Ireland', owner: 'gp', mode: 'request_institution', institution: 'Medical Council of Ireland', kind: 'good_standing' },
      { country: 'uk', officer: OFFICER }
    );
    expect(item.doc_guide_key).toBe('certificate_good_standing');
    expect(item.how_to_steps.join(' ')).toContain('Medical Council of Ireland Doctors Portal');
  });

  it('the GMC certificate for a UK doctor is unchanged', () => {
    const item = s80.normalizeItem(
      { title: 'Certificate of Good Standing from GMC', owner: 'gp', mode: 'request_institution', institution: 'GMC', kind: 'good_standing' },
      { country: 'uk', officer: OFFICER }
    );
    expect(item.doc_guide_key).toBe('certificate_good_standing');
    expect(item.how_to_steps[0]).toContain('GMC Online');
  });

  it('confirmation of training from another body: contact that body, registration18@ or the officer', () => {
    const item = s80.normalizeItem(
      { title: 'Confirmation of specialist training from the Health Professions Council of South Africa', owner: 'gp', mode: 'request_institution', institution: 'Health Professions Council of South Africa', kind: 'training_confirmation' },
      { country: 'uk', officer: OFFICER }
    );
    expect(item.doc_guide_key).toBe('confirmation_training_other');
    const steps = item.how_to_steps.join(' ');
    expect(steps).toContain('Contact the Health Professions Council of South Africa and request confirmation of your GP / specialist training');
    expect(steps).toContain('registration18@ahpra.gov.au, or to your assigned AHPRA officer (Paige Hooper, Paige.Hooper@ahpra.gov.au)');
    expect(steps).not.toMatch(/portfolio@gmc-uk\.org/);
  });

  it('any other request-from-institution item with a named body gets generic steps addressed to the officer', () => {
    const item = s80.normalizeItem(
      { title: 'Confirmation of OET result', owner: 'gp', mode: 'request_institution', institution: 'OET', kind: 'english' },
      { country: 'uk', officer: OFFICER }
    );
    expect(item.doc_guide_key).toBe('other_institution');
    expect(item.how_to_steps[0]).toBe('Contact OET and request “Confirmation of OET result” for your AHPRA registration application.');
    expect(item.how_to_steps[1]).toBe('Ask them to send it directly to AHPRA, addressed to your assigned AHPRA officer (Paige Hooper, Paige.Hooper@ahpra.gov.au).');
    expect(item.how_to_steps.join(' ')).not.toMatch(/COGS@/);
  });

  it('an upload item that merely mentions a college keeps no steps', () => {
    const item = s80.normalizeItem({ title: 'Letter from the Royal College of Physicians', owner: 'gp', mode: 'upload' }, { country: 'uk', officer: OFFICER });
    expect(item.how_to_steps.length).toBe(0);
    expect(item.doc_guide_key).toBe('');
  });

  it('an email username is not shown as the officer\'s name', () => {
    const g = docGuides.matchGuide(NIGERIA, 'uk', { officer: { name: 'paige.hooper', email: 'paige.hooper@ahpra.gov.au' } });
    expect(g.steps[1]).toContain('your assigned AHPRA officer (paige.hooper@ahpra.gov.au)');
    expect(g.steps[1]).not.toContain('paige.hooper, ');
  });

  it('ensureInstructions synthesises the same generic steps when an item is routed back to the doctor', () => {
    const patch = s80.ensureInstructions(
      { owner: 'gp', mode: 'request_institution', institution: 'Medical and Dental Council of Nigeria', title: NIGERIA.title, detail: NIGERIA.detail, kind: 'good_standing', officer: OFFICER },
      { country: 'uk' }
    );
    expect(patch.doc_guide_key).toBe('certificate_good_standing_other');
    expect(patch.how_to_steps[0]).toContain('Contact the Medical and Dental Council of Nigeria');
    expect(patch.gp_instructions).toContain('COGS@ahpra.gov.au');
    expect(patch.how_to_steps.join(' ')).not.toMatch(/GMC/);
  });

  it('the extraction prompt tells the model to name the issuing body exactly as the letter does', () => {
    const prompt = s80.buildExtractionPrompt({ subject: 'Notice', sender: 'officer@ahpra.gov.au', bodyText: 'x' });
    expect(prompt).toContain('named exactly as the letter names it');
    expect(prompt).toContain('Medical and Dental Council of Nigeria');
  });
});

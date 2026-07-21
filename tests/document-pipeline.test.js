import { describe, it, expect } from 'vitest';
import {
  classifyConfidenceAction,
  buildRejectionMessage,
  isVisuallyClassifiable,
  isDocxMime,
  isDocMime,
  buildClassificationPrompt,
  classifyQualificationOutcome,
  buildFlagReason
} from '../lib/document-pipeline.js';

describe('classifyConfidenceAction', () => {
  it('returns auto_approve for >= 70', () => {
    expect(classifyConfidenceAction(70)).toBe('auto_approve');
    expect(classifyConfidenceAction(100)).toBe('auto_approve');
  });
  it('returns va_review for 40-69', () => {
    expect(classifyConfidenceAction(40)).toBe('va_review');
    expect(classifyConfidenceAction(69)).toBe('va_review');
  });
  it('returns auto_reject for < 40', () => {
    expect(classifyConfidenceAction(0)).toBe('auto_reject');
    expect(classifyConfidenceAction(39)).toBe('auto_reject');
  });
  it('returns va_review for null/undefined', () => {
    expect(classifyConfidenceAction(null)).toBe('va_review');
    expect(classifyConfidenceAction(undefined)).toBe('va_review');
  });
});

describe('buildRejectionMessage', () => {
  it('builds specific message with identifiedAs', () => {
    const msg = buildRejectionMessage('passport', 'MRCGP Certificate');
    expect(msg).toBe('This appears to be a passport but we expected a MRCGP Certificate. Please re-upload the correct document.');
  });
  it('handles missing identifiedAs', () => {
    const msg = buildRejectionMessage('', 'MRCGP Certificate');
    expect(msg).toContain('does not appear to match');
    expect(msg).toContain('MRCGP Certificate');
  });
});

describe('isVisuallyClassifiable', () => {
  it('returns true for PDF', () => { expect(isVisuallyClassifiable('application/pdf')).toBe(true); });
  it('returns true for JPEG', () => { expect(isVisuallyClassifiable('image/jpeg')).toBe(true); });
  it('returns true for PNG', () => { expect(isVisuallyClassifiable('image/png')).toBe(true); });
  it('returns false for DOCX', () => { expect(isVisuallyClassifiable('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false); });
  it('returns false for DOC', () => { expect(isVisuallyClassifiable('application/msword')).toBe(false); });
});

describe('isDocxMime / isDocMime', () => {
  it('detects DOCX', () => { expect(isDocxMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true); });
  it('detects DOC', () => { expect(isDocMime('application/msword')).toBe(true); });
  it('rejects PDF as DOCX', () => { expect(isDocxMime('application/pdf')).toBe(false); });
});

describe('buildClassificationPrompt', () => {
  it('includes expected label and text', () => {
    const prompt = buildClassificationPrompt('CV (Signed and dated)', 'Dr John Smith\nExperience: 10 years');
    expect(prompt).toContain('CV (Signed and dated)');
    expect(prompt).toContain('Dr John Smith');
  });
  it('truncates long text to 4000 chars', () => {
    const longText = 'x'.repeat(5000);
    const prompt = buildClassificationPrompt('CV', longText);
    expect(prompt.length).toBeLessThan(5000);
  });
});

describe('classifyQualificationOutcome', () => {
  // Contract: the outcome depends ONLY on the document's validity (`verified`). The name is
  // handled separately — a name change is recorded automatically and never blocks or masks a
  // real problem (e.g. a missing certified copy). Callers pass a `verified` that already
  // reflects validity independent of the name.
  it('approves a valid (verified) document', () => {
    const r = classifyQualificationOutcome({ verified: true });
    expect(r).toEqual({ action: 'approve', status: 'approved', reasonKind: null });
  });
  it('flags an invalid (not verified) document as failed_verification', () => {
    const r = classifyQualificationOutcome({ verified: false });
    expect(r).toEqual({ action: 'flag', status: 'under_review', reasonKind: 'failed_verification' });
  });
  it('never returns a name_change outcome — a name change does not drive the document review', () => {
    // A genuine document in a former name is still approved (name recorded elsewhere); a
    // not-certified document in a former name is flagged for the CERTIFICATION issue, not
    // the name. The classifier sees only `verified` and so cannot emit reasonKind name_change.
    expect(classifyQualificationOutcome({ verified: true }).reasonKind).toBe(null);
    expect(classifyQualificationOutcome({ verified: false }).reasonKind).toBe('failed_verification');
  });
});

describe('buildFlagReason', () => {
  it('builds a name change reason naming both parties', () => {
    const r = buildFlagReason('name_change', {
      nameFound: 'Mohammed Avais Hussain',
      profileName: 'Smith Miller',
      expectedLabel: 'Primary Medical Degree'
    });
    expect(r).toBe('The name on this document ("Mohammed Avais Hussain") differs from the account name ("Smith Miller") — this looks like a name change to confirm and record. The document itself does not need to be re-uploaded.');
  });
  it('handles a missing document name gracefully', () => {
    const r = buildFlagReason('name_change', { nameFound: '', profileName: 'Smith Miller', expectedLabel: 'Primary Medical Degree' });
    expect(r).toBe('The name on this document differs from the account name ("Smith Miller") — this looks like a name change to confirm and record.');
  });
  it('still maps the legacy name_mismatch kind to name-change wording', () => {
    const r = buildFlagReason('name_mismatch', { nameFound: 'Mercy Dzungwem', profileName: 'Mercy Obanimoh', expectedLabel: 'Primary Medical Degree' });
    expect(r).toContain('looks like a name change');
  });
  it('builds a failed verification reason with the expected label', () => {
    const r = buildFlagReason('failed_verification', { expectedLabel: 'MRCGP Certificate', issues: ['This appears to be a passport.'] });
    expect(r).toBe('MRCGP Certificate could not be verified: This appears to be a passport.');
  });
  it('falls back when no issues are provided', () => {
    const r = buildFlagReason('failed_verification', { expectedLabel: 'MRCGP Certificate', issues: [] });
    expect(r).toBe('MRCGP Certificate could not be verified and needs manual review.');
  });
});

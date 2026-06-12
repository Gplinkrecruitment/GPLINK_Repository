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
  it('approves when name matches (exact) and type is correct', () => {
    const r = classifyQualificationOutcome({ nameMatch: 'exact', verified: true });
    expect(r).toEqual({ action: 'approve', status: 'approved', reasonKind: null });
  });
  it('approves on fuzzy name match', () => {
    const r = classifyQualificationOutcome({ nameMatch: 'fuzzy', verified: true });
    expect(r.action).toBe('approve');
  });
  it('flags a name mismatch', () => {
    const r = classifyQualificationOutcome({ nameMatch: 'mismatch', verified: true });
    expect(r).toEqual({ action: 'flag', status: 'under_review', reasonKind: 'name_mismatch' });
  });
  it('flags when verification failed (wrong type / illegible)', () => {
    const r = classifyQualificationOutcome({ nameMatch: 'exact', verified: false });
    expect(r).toEqual({ action: 'flag', status: 'under_review', reasonKind: 'failed_verification' });
  });
  it('prioritises name mismatch over failed verification', () => {
    const r = classifyQualificationOutcome({ nameMatch: 'mismatch', verified: false });
    expect(r.reasonKind).toBe('name_mismatch');
  });
  it('treats unknown nameMatch as failed_verification when not verified', () => {
    const r = classifyQualificationOutcome({ nameMatch: 'unknown', verified: false });
    expect(r.reasonKind).toBe('failed_verification');
  });
  it('flags failed_verification when name is unknown but doc verified true', () => {
    const r = classifyQualificationOutcome({ nameMatch: 'unknown', verified: true });
    expect(r).toEqual({ action: 'flag', status: 'under_review', reasonKind: 'failed_verification' });
  });
});

describe('buildFlagReason', () => {
  it('builds a name mismatch reason naming both parties', () => {
    const r = buildFlagReason('name_mismatch', {
      nameFound: 'Mohammed Avais Hussain',
      profileName: 'Smith Miller',
      expectedLabel: 'Primary Medical Degree'
    });
    expect(r).toBe('Name on document ("Mohammed Avais Hussain") does not match account ("Smith Miller").');
  });
  it('handles a missing document name gracefully', () => {
    const r = buildFlagReason('name_mismatch', { nameFound: '', profileName: 'Smith Miller', expectedLabel: 'Primary Medical Degree' });
    expect(r).toBe('The name on the document does not match the account holder ("Smith Miller").');
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

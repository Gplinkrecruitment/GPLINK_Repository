import { describe, it, expect } from 'vitest';
import {
  classifyConfidenceAction,
  buildRejectionMessage,
  isVisuallyClassifiable,
  isDocxMime,
  isDocMime,
  buildClassificationPrompt
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

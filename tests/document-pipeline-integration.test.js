import { describe, it, expect } from 'vitest';
import { validateFileUpload } from '../lib/file-sanitise.js';
import {
  classifyConfidenceAction,
  buildRejectionMessage,
  isVisuallyClassifiable,
  isDocxMime,
  buildClassificationPrompt
} from '../lib/document-pipeline.js';

describe('Document Pipeline Integration', () => {
  describe('Full validation + classification flow', () => {
    it('accepts a valid PDF and routes high confidence to auto_approve', () => {
      const buf = Buffer.from('%PDF-1.4\nvalid content\n%%EOF');
      const result = validateFileUpload(buf, 'application/pdf', 'my-degree.pdf');
      expect(result.valid).toBe(true);
      expect(result.sanitisedFileName).toBe('my-degree.pdf');
      expect(isVisuallyClassifiable('application/pdf')).toBe(true);
      expect(classifyConfidenceAction(85)).toBe('auto_approve');
    });

    it('accepts a valid JPEG and routes medium confidence to va_review', () => {
      const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
      const result = validateFileUpload(buf, 'image/jpeg', 'scan.jpg');
      expect(result.valid).toBe(true);
      expect(isVisuallyClassifiable('image/jpeg')).toBe(true);
      expect(classifyConfidenceAction(55)).toBe('va_review');
    });

    it('accepts DOCX and routes to text classification', () => {
      const buf = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00]);
      const result = validateFileUpload(buf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'letter.docx');
      expect(result.valid).toBe(true);
      expect(isDocxMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
      expect(isVisuallyClassifiable('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false);
    });

    it('rejects dangerous PDF', () => {
      const buf = Buffer.from('%PDF-1.4\n/JavaScript (alert("xss"))\n%%EOF');
      const result = validateFileUpload(buf, 'application/pdf', 'evil.pdf');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('dangerous');
    });

    it('rejects mismatched magic bytes', () => {
      const buf = Buffer.from('this is not a pdf');
      const result = validateFileUpload(buf, 'application/pdf', 'fake.pdf');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('does not match');
    });

    it('rejects oversized files', () => {
      const buf = Buffer.alloc(11 * 1024 * 1024);
      buf[0] = 0x25; buf[1] = 0x50; buf[2] = 0x44; buf[3] = 0x46;
      const result = validateFileUpload(buf, 'application/pdf', 'big.pdf');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('10MB');
    });

    it('builds correct rejection message', () => {
      const msg = buildRejectionMessage('passport scan', 'MRCGP Certificate');
      expect(msg).toBe('This appears to be a passport scan but we expected a MRCGP Certificate. Please re-upload the correct document.');
    });

    it('builds DOCX classification prompt with text', () => {
      const prompt = buildClassificationPrompt('CV (Signed and dated)', 'Dr John Smith\nMBBS University of London\nExperience: 10 years GP');
      expect(prompt).toContain('CV (Signed and dated)');
      expect(prompt).toContain('Dr John Smith');
    });

    it('low confidence routes to auto_reject', () => {
      expect(classifyConfidenceAction(15)).toBe('auto_reject');
    });

    it('null confidence routes to va_review (safe fallback)', () => {
      expect(classifyConfidenceAction(null)).toBe('va_review');
    });
  });
});

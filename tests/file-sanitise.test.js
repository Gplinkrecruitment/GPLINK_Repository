import { describe, it, expect } from 'vitest';
import {
  sanitiseFileName,
  validateMimeType,
  validateMagicBytes,
  validatePdfSafety,
  validateFileUpload,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES
} from '../lib/file-sanitise.js';

describe('sanitiseFileName', () => {
  it('strips path traversal', () => {
    expect(sanitiseFileName('../../../etc/passwd')).toBe('etc_passwd');
  });
  it('strips null bytes', () => {
    expect(sanitiseFileName('file\x00.pdf')).toBe('file.pdf');
  });
  it('strips control characters', () => {
    expect(sanitiseFileName('file\x01\x02.pdf')).toBe('file.pdf');
  });
  it('limits to 255 characters', () => {
    const long = 'a'.repeat(300) + '.pdf';
    expect(sanitiseFileName(long).length).toBeLessThanOrEqual(255);
  });
  it('preserves valid names', () => {
    expect(sanitiseFileName('My-Document_2026.pdf')).toBe('My-Document_2026.pdf');
  });
  it('returns fallback for empty input', () => {
    expect(sanitiseFileName('')).toBe('document');
  });
});

describe('validateMimeType', () => {
  it('accepts PDF', () => { expect(validateMimeType('application/pdf')).toBe(true); });
  it('accepts JPEG', () => { expect(validateMimeType('image/jpeg')).toBe(true); });
  it('accepts PNG', () => { expect(validateMimeType('image/png')).toBe(true); });
  it('accepts WebP', () => { expect(validateMimeType('image/webp')).toBe(true); });
  it('accepts HEIC', () => { expect(validateMimeType('image/heic')).toBe(true); });
  it('accepts DOC', () => { expect(validateMimeType('application/msword')).toBe(true); });
  it('accepts DOCX', () => { expect(validateMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true); });
  it('rejects executable', () => { expect(validateMimeType('application/x-executable')).toBe(false); });
  it('rejects HTML', () => { expect(validateMimeType('text/html')).toBe(false); });
  it('rejects empty', () => { expect(validateMimeType('')).toBe(false); });
});

describe('validateMagicBytes', () => {
  it('validates PDF magic bytes', () => {
    const buf = Buffer.from('%PDF-1.4 rest of content');
    expect(validateMagicBytes(buf, 'application/pdf')).toBe(true);
  });
  it('validates JPEG magic bytes', () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00]);
    expect(validateMagicBytes(buf, 'image/jpeg')).toBe(true);
  });
  it('validates PNG magic bytes', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    expect(validateMagicBytes(buf, 'image/png')).toBe(true);
  });
  it('validates DOCX magic bytes (ZIP header)', () => {
    const buf = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00]);
    expect(validateMagicBytes(buf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
  });
  it('rejects mismatched bytes', () => {
    const buf = Buffer.from('not a pdf');
    expect(validateMagicBytes(buf, 'application/pdf')).toBe(false);
  });
  it('skips validation for HEIC', () => {
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x20]);
    expect(validateMagicBytes(buf, 'image/heic')).toBe(true);
  });
});

describe('validatePdfSafety', () => {
  it('accepts safe PDF', () => {
    const buf = Buffer.from('%PDF-1.4\nsome content\n%%EOF');
    expect(validatePdfSafety(buf)).toEqual({ safe: true });
  });
  it('rejects PDF with /Launch', () => {
    const buf = Buffer.from('%PDF-1.4\n/Launch /Action\n%%EOF');
    expect(validatePdfSafety(buf).safe).toBe(false);
  });
  it('rejects PDF with /JavaScript', () => {
    const buf = Buffer.from('%PDF-1.4\n/JavaScript (alert)\n%%EOF');
    expect(validatePdfSafety(buf).safe).toBe(false);
  });
  it('rejects PDF with /OpenAction', () => {
    const buf = Buffer.from('%PDF-1.4\n/OpenAction /URI\n%%EOF');
    expect(validatePdfSafety(buf).safe).toBe(false);
  });
  it('rejects PDF with /AA', () => {
    const buf = Buffer.from('%PDF-1.4\n/AA << /O >>\n%%EOF');
    expect(validatePdfSafety(buf).safe).toBe(false);
  });
});

describe('validateFileUpload', () => {
  it('accepts valid PDF', () => {
    const buf = Buffer.from('%PDF-1.4\nvalid content\n%%EOF');
    const result = validateFileUpload(buf, 'application/pdf', 'doc.pdf');
    expect(result.valid).toBe(true);
  });
  it('rejects oversized file', () => {
    const buf = Buffer.alloc(11 * 1024 * 1024);
    buf[0] = 0x25; buf[1] = 0x50; buf[2] = 0x44; buf[3] = 0x46;
    const result = validateFileUpload(buf, 'application/pdf', 'big.pdf');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('10MB');
  });
  it('rejects dangerous PDF', () => {
    const buf = Buffer.from('%PDF-1.4\n/JavaScript (alert)\n%%EOF');
    const result = validateFileUpload(buf, 'application/pdf', 'evil.pdf');
    expect(result.valid).toBe(false);
  });
});

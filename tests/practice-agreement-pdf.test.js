import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { stampAgreementExecutionPage } from '../lib/practice-agreement-pdf.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var AGREEMENT_PATH = path.join(__dirname, '..', 'assets', 'legal', 'gp-link-practice-agreement-2026.pdf');

var TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function baseParams(overrides) {
  var agreementBytes = fs.readFileSync(AGREEMENT_PATH);
  return Object.assign(
    {
      agreementBytes: agreementBytes,
      signaturePngDataUrl: TINY_PNG_DATA_URL,
      signedName: 'Dr Jane Smith',
      practiceName: 'Riverside Medical Centre',
      dateLabel: '2026-07-05',
      ipAddress: '203.0.113.42',
      token: 'abc123def456ghi789'
    },
    overrides || {}
  );
}

describe('stampAgreementExecutionPage', function () {
  it('adds an execution page (12 pages total) and adds real content vs. an unmodified round trip', async function () {
    var agreementBytes = fs.readFileSync(AGREEMENT_PATH);
    var params = baseParams({ agreementBytes: agreementBytes });

    var result = await stampAgreementExecutionPage(params);

    expect(Buffer.isBuffer(result)).toBe(true);

    var stamped = await PDFDocument.load(result);
    expect(stamped.getPageCount()).toBe(12);

    // Note: pdf-lib re-serializes the whole document more compactly than
    // however this particular asset was originally produced, so a plain
    // load+save round trip of the *unmodified* source is already smaller
    // than the raw input file (verified: ~1.78MB -> ~1.5MB with zero
    // changes). Comparing the stamped output against raw input bytes would
    // therefore not reliably reflect whether the execution page was added.
    // Instead we compare against a same-library, no-op round trip of the
    // same bytes, which isolates the bytes actually contributed by the new
    // execution page.
    var baselineDoc = await PDFDocument.load(agreementBytes, { ignoreEncryption: true });
    var baselineBytes = await baselineDoc.save();
    expect(result.length).toBeGreaterThan(baselineBytes.length);
  });

  it('throws invalid_signature_image for a non-PNG data URL', async function () {
    var params = baseParams({
      signaturePngDataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBD'
    });

    await expect(stampAgreementExecutionPage(params)).rejects.toThrow('invalid_signature_image');
  });

  it('does not throw for a practice/signed name with emoji + Vietnamese diacritics, and still stamps a 12-page PDF', async function () {
    var params = baseParams({
      practiceName: 'Phòng khám Nguyễn 🏥✨',
      signedName: 'Bác sĩ Nguyễn Thị Hương 😀'
    });

    var result = await stampAgreementExecutionPage(params);

    expect(Buffer.isBuffer(result)).toBe(true);
    var stamped = await PDFDocument.load(result);
    expect(stamped.getPageCount()).toBe(12);
  });
});

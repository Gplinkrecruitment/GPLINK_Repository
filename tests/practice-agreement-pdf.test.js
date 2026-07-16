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

async function sourcePageCount(agreementBytes) {
  var doc = await PDFDocument.load(agreementBytes, { ignoreEncryption: true });
  return doc.getPageCount();
}

function baseParams(overrides) {
  var agreementBytes = fs.readFileSync(AGREEMENT_PATH);
  return Object.assign(
    {
      agreementBytes: agreementBytes,
      signaturePngDataUrl: TINY_PNG_DATA_URL,
      signedName: 'Dr Jane Smith',
      practiceName: 'Riverside Medical Centre',
      legalEntityName: 'Riverside Medical Centre Pty Ltd',
      abnAcn: 'ABN 12345678901',
      signerJobTitle: 'Practice Manager',
      dateLabel: '2026-07-15',
      ipAddress: '203.0.113.42',
      token: 'abc123def456ghi789'
    },
    overrides || {}
  );
}

describe('stampAgreementExecutionPage', function () {
  it('adds exactly one execution page and adds real content vs. an unmodified round trip', async function () {
    var agreementBytes = fs.readFileSync(AGREEMENT_PATH);
    var params = baseParams({ agreementBytes: agreementBytes });
    var srcPages = await sourcePageCount(agreementBytes);

    var result = await stampAgreementExecutionPage(params);

    expect(Buffer.isBuffer(result)).toBe(true);

    var stamped = await PDFDocument.load(result);
    expect(stamped.getPageCount()).toBe(srcPages + 1);

    // Note: pdf-lib re-serializes the whole document more compactly than
    // however this particular asset was originally produced, so a plain
    // load+save round trip of the *unmodified* source can already differ in
    // size from the raw input file. Comparing the stamped output against a
    // same-library, no-op round trip of the same bytes isolates the bytes
    // actually contributed by the new execution page.
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

  it('does not throw for a practice/signed name with emoji + Vietnamese diacritics, and still stamps the execution page', async function () {
    var agreementBytes = fs.readFileSync(AGREEMENT_PATH);
    var srcPages = await sourcePageCount(agreementBytes);
    var params = baseParams({
      agreementBytes: agreementBytes,
      practiceName: 'Phòng khám Nguyễn 🏥✨',
      signedName: 'Bác sĩ Nguyễn Thị Hương 😀',
      legalEntityName: 'Phòng khám Nguyễn Pty Ltd 🏥'
    });

    var result = await stampAgreementExecutionPage(params);

    expect(Buffer.isBuffer(result)).toBe(true);
    var stamped = await PDFDocument.load(result);
    expect(stamped.getPageCount()).toBe(srcPages + 1);
  });

  it('still stamps when the entity fields are missing (backwards compatibility)', async function () {
    var agreementBytes = fs.readFileSync(AGREEMENT_PATH);
    var srcPages = await sourcePageCount(agreementBytes);
    var params = baseParams({
      agreementBytes: agreementBytes,
      legalEntityName: undefined,
      abnAcn: undefined,
      signerJobTitle: undefined
    });

    var result = await stampAgreementExecutionPage(params);

    expect(Buffer.isBuffer(result)).toBe(true);
    var stamped = await PDFDocument.load(result);
    expect(stamped.getPageCount()).toBe(srcPages + 1);
  });
});

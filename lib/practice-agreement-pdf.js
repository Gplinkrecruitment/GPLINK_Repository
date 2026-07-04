'use strict';

var { PDFDocument, StandardFonts } = require('pdf-lib');

var PAGE_WIDTH = 595.5;
var PAGE_HEIGHT = 842.25;
var MARGIN = 50;
var MAX_SIGNATURE_WIDTH = 260;
var PNG_DATA_URL_PREFIX = 'data:image/png;base64,';

/**
 * Stamp a signed execution page onto the end of the practice agreement PDF.
 *
 * @param {Object} params
 * @param {Buffer|Uint8Array} params.agreementBytes - The source agreement PDF bytes.
 * @param {string} params.signaturePngDataUrl - `data:image/png;base64,...` signature image.
 * @param {string} params.signedName - Name of the person who signed.
 * @param {string} params.practiceName - Name of the practice.
 * @param {string} params.dateLabel - Human-readable signing date.
 * @param {string} params.ipAddress - IP address captured at signing time.
 * @param {string} params.token - Signing/verification token (last 8 chars shown).
 * @returns {Promise<Buffer>} The stamped PDF as a Node.js Buffer.
 */
async function stampAgreementExecutionPage(params) {
  var agreementBytes = params.agreementBytes;
  var signaturePngDataUrl = params.signaturePngDataUrl;
  var signedName = params.signedName;
  var practiceName = params.practiceName;
  var dateLabel = params.dateLabel;
  var ipAddress = params.ipAddress;
  var token = params.token;

  if (typeof signaturePngDataUrl !== 'string' || signaturePngDataUrl.indexOf(PNG_DATA_URL_PREFIX) !== 0) {
    throw new Error('invalid_signature_image');
  }

  var base64Data = signaturePngDataUrl.slice(PNG_DATA_URL_PREFIX.length);
  var signatureBytes = Buffer.from(base64Data, 'base64');

  var pdfDoc = await PDFDocument.load(agreementBytes, { ignoreEncryption: true });

  var helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  var helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  var signatureImage = await pdfDoc.embedPng(signatureBytes);

  var page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  var cursorY = PAGE_HEIGHT - MARGIN;

  var titleSize = 16;
  page.drawText('Execution Page — Recruitment Services Agreement (2026)', {
    x: MARGIN,
    y: cursorY,
    size: titleSize,
    font: helveticaBold
  });
  cursorY -= titleSize + 24;

  var labelSize = 11;
  var lineGap = 22;
  var verificationRef = typeof token === 'string' && token.length > 8 ? token.slice(-8) : token;

  var lines = [
    { label: 'Practice: ', value: practiceName || '' },
    { label: 'Signed by: ', value: (signedName || '') + ' (authorised to sign on behalf of the practice)' },
    { label: 'Date: ', value: dateLabel || '' },
    { label: 'IP: ', value: ipAddress || '' },
    { label: 'Verification ref: ', value: verificationRef || '' }
  ];

  lines.forEach(function (line) {
    page.drawText(line.label + line.value, {
      x: MARGIN,
      y: cursorY,
      size: labelSize,
      font: helvetica
    });
    cursorY -= lineGap;
  });

  cursorY -= 16;

  page.drawText('Signature:', {
    x: MARGIN,
    y: cursorY,
    size: labelSize,
    font: helveticaBold
  });
  cursorY -= lineGap;

  var naturalWidth = signatureImage.width;
  var naturalHeight = signatureImage.height;
  var drawWidth = naturalWidth;
  var drawHeight = naturalHeight;
  if (drawWidth > MAX_SIGNATURE_WIDTH) {
    var scale = MAX_SIGNATURE_WIDTH / drawWidth;
    drawWidth = MAX_SIGNATURE_WIDTH;
    drawHeight = drawHeight * scale;
  }

  cursorY -= drawHeight;

  page.drawImage(signatureImage, {
    x: MARGIN,
    y: cursorY,
    width: drawWidth,
    height: drawHeight
  });

  var pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

module.exports = { stampAgreementExecutionPage };

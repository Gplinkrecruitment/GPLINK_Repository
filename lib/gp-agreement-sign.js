'use strict';
/* ============================================================================
 * gp-agreement-sign.js — turn a doctor's in-app signature into a signed PDF.
 *
 * The practice signs OUR recruitment agreement by drawing on a canvas, and the
 * server stamps that signature onto the agreement PDF (lib/practice-agreement-
 * pdf.js). Owner request 2026-08-06: give the doctor the same experience for
 * the PRACTICE's employment agreement.
 *
 * The difference is the source document. Ours is a PDF we generate, so it can
 * be stamped. Theirs is whatever the practice uploaded:
 *
 *   PDF  → append an execution page to the practice's own file. The agreement
 *          itself is byte-for-byte untouched, which is what you want on a legal
 *          document.
 *   DOCX → we cannot stamp a Word file, so the agreement text (already
 *          extracted for the in-app reader) is typeset into a PDF and the
 *          execution page appended. The practice's original file is KEPT on the
 *          contract row either way, so the source of truth never moves.
 *
 * The execution page records who signed, when, and a SHA-256 of the source file
 * so the signature can always be tied back to the exact document that was
 * signed — that hash is the audit trail, not decoration.
 * ========================================================================== */

const crypto = require('crypto');

// A drawn signature arrives as a PNG data URL from the canvas.
function decodeSignatureDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) return null;
  const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!buf.length) return null;
  return { kind: /png/i.test(m[1]) ? 'png' : 'jpg', buffer: buf };
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function formatSignedAt(iso) {
  try {
    return new Date(iso).toLocaleString('en-AU', {
      day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney'
    }) + ' (Sydney)';
  } catch (e) { return String(iso || ''); }
}

// Lines of the execution block, shared by both renderers so the PDF and DOCX
// paths can never drift apart.
function executionLines(opts) {
  const lines = [
    ['Signed by', opts.signerName],
    ['Date', formatSignedAt(opts.signedAtIso)]
  ];
  if (opts.practiceName) lines.push(['Practice', opts.practiceName]);
  if (opts.sourceFilename) lines.push(['Agreement file', opts.sourceFilename]);
  if (opts.sourceSha256) lines.push(['Document checksum (SHA-256)', opts.sourceSha256]);
  return lines;
}

// ── DOCX (or plain-text) source: typeset the agreement, then execute ────────
async function buildFromText(opts) {
  const PDFKit = require('pdfkit');
  const doc = new PDFKit({ size: 'A4', margin: 56, bufferPages: true });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  if (opts.agreementTitle) {
    doc.font('Helvetica-Bold').fontSize(15).text(String(opts.agreementTitle), { align: 'left' });
    doc.moveDown(0.8);
  }
  doc.font('Helvetica').fontSize(10.5);
  // Blank lines separate paragraphs in the extracted text; keep them so the
  // agreement stays readable rather than becoming one wall of prose.
  String(opts.agreementText || '').replace(/\r\n/g, '\n').split(/\n{2,}/).forEach((para) => {
    const t = para.replace(/\n/g, ' ').trim();
    if (!t) return;
    doc.text(t, { align: 'left', lineGap: 2 });
    doc.moveDown(0.55);
  });

  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(14).text('Execution');
  doc.moveDown(0.6);
  doc.font('Helvetica').fontSize(10.5).fillColor('#333')
    .text('This agreement was signed electronically through GP Link.');
  doc.moveDown(1.2);
  doc.fillColor('#000');

  // Explicit coordinates, not the flow cursor: doc.image() does not advance
  // doc.y the way text does, so relying on it drew the signature ON TOP of the
  // details below (caught rendering the real Erina agreement).
  const LEFT = 56;
  const sig = decodeSignatureDataUrl(opts.signatureDataUrl);
  const sigTop = doc.y;
  let sigHeight = 0;
  if (sig) {
    try {
      doc.image(sig.buffer, LEFT, sigTop, { fit: [230, 90] });
      sigHeight = 90;
    } catch (e) { /* unreadable image — the details below still stand */ }
  }
  const ruleY = sigTop + sigHeight + 8;
  doc.moveTo(LEFT, ruleY).lineTo(LEFT + 260, ruleY).strokeColor('#94a3b8').lineWidth(1).stroke();

  doc.x = LEFT;
  doc.y = ruleY + 16;
  doc.fontSize(10.5).fillColor('#000');
  executionLines(opts).forEach(([label, value]) => {
    doc.font('Helvetica-Bold').text(label + ': ', { continued: true });
    doc.font('Helvetica').text(String(value == null ? '' : value));
  });

  doc.moveDown(1.2);
  doc.font('Helvetica').fontSize(8.5).fillColor('#64748b').text(
    'The agreement text above was extracted from the file the practice supplied ('
    + (opts.sourceFilename || 'the uploaded document')
    + '). That original file is retained unaltered by GP Link; the checksum above identifies it.'
  );

  doc.end();
  return done;
}

// ── PDF source: leave the practice's document untouched, append a page ──────
async function appendToPdf(opts) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const pdf = await PDFDocument.load(opts.sourceBuffer, { ignoreEncryption: true });
  const page = pdf.addPage();
  const { width, height } = page.getSize();
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const plain = await pdf.embedFont(StandardFonts.Helvetica);

  let y = height - 70;
  page.drawText('Execution', { x: 56, y, size: 15, font: bold });
  y -= 26;
  page.drawText('This agreement was signed electronically through GP Link.', { x: 56, y, size: 10.5, font: plain, color: rgb(0.2, 0.2, 0.2) });
  y -= 40;

  const sig = decodeSignatureDataUrl(opts.signatureDataUrl);
  if (sig) {
    try {
      const img = sig.kind === 'png' ? await pdf.embedPng(sig.buffer) : await pdf.embedJpg(sig.buffer);
      const scaled = img.scaleToFit(230, 90);
      page.drawImage(img, { x: 56, y: y - scaled.height + 10, width: scaled.width, height: scaled.height });
      y -= (scaled.height + 6);
    } catch (e) { /* unreadable image — the details below still stand */ }
  }
  page.drawLine({ start: { x: 56, y: y }, end: { x: 316, y: y }, thickness: 1, color: rgb(0.58, 0.64, 0.72) });
  y -= 26;

  executionLines(opts).forEach(([label, value]) => {
    page.drawText(String(label) + ':', { x: 56, y, size: 10.5, font: bold });
    const v = String(value == null ? '' : value);
    // The SHA-256 is 64 chars — wrap it rather than letting it run off the page.
    const maxChars = Math.max(20, Math.floor((width - 250) / 5.2));
    let first = true;
    for (let i = 0; i < v.length; i += maxChars) {
      page.drawText(v.slice(i, i + maxChars), { x: 210, y, size: 10.5, font: plain });
      y -= first ? 16 : 13;
      first = false;
    }
    if (!v) y -= 16;
  });

  return Buffer.from(await pdf.save());
}

/**
 * Build the signed PDF.
 * @param {object} opts
 *  - sourceKind      'pdf' | 'text'
 *  - sourceBuffer    the practice's original file (required for 'pdf')
 *  - agreementText   extracted text (required for 'text')
 *  - agreementTitle  heading for the typeset version
 *  - signerName      the doctor's typed full name
 *  - signatureDataUrl PNG data URL from the signing pad
 *  - signedAtIso     ISO timestamp
 *  - practiceName, sourceFilename
 */
async function buildSignedAgreementPdf(opts) {
  const o = Object.assign({}, opts || {});
  if (o.sourceBuffer && Buffer.isBuffer(o.sourceBuffer)) o.sourceSha256 = sha256Hex(o.sourceBuffer);
  if (o.sourceKind === 'pdf') {
    if (!o.sourceBuffer || !o.sourceBuffer.length) throw new Error('missing source pdf');
    return appendToPdf(o);
  }
  if (!String(o.agreementText || '').trim()) throw new Error('missing agreement text');
  return buildFromText(o);
}

module.exports = { buildSignedAgreementPdf, decodeSignatureDataUrl, sha256Hex, executionLines };

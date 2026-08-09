import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/*
 * Dr Mercy Obanimoh's MRCGP certified copy is a PDF. Opening it in the reviewer's
 * "Review Document" modal showed an orange "Image normalization failed" under the
 * title — and, worse, those same three words sitting in the "Note to GP" box, which
 * the reject button emails to the doctor VERBATIM.
 *
 * Two separate faults, both covered here:
 *
 *  1. isVisuallyClassifiable() is true for a PDF as well as an image, so every PDF
 *     went down the image branch of classifyDocumentWithAI and into
 *     normalizeImageForAi — which rejects "application/pdf" outright, without even
 *     calling the normalizer. Classification of a PDF has therefore never once run:
 *     it returned confidence null (-> va_review) and the raw string "Image
 *     normalization failed" as its reason. The reviewer's own scan looked fine
 *     because THAT path uses buildQualContentBlock, which has always sent PDFs as a
 *     document block. The classifier now does the same.
 *
 *  2. A technical failure was stored, displayed, and pre-filled as though it were a
 *     finding about the document. Nothing that describes a broken check may ever
 *     reach the note a doctor receives.
 *
 * The normalization failure and both humanizer regexes are EXECUTED against real
 * bytes/strings rather than grepped — the point is what the code does, not what it
 * says. The rest are source assertions (server.js has no exports for this, and the
 * modals live inside page IIFEs with no jsdom in the repo).
 */

const ROOT = path.resolve(__dirname, '..');
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(ROOT, 'pages/admin.html'), 'utf8');
const ceoHtml = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');

function extractFunction(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  if (src.slice(start - 6, start) === 'async ') start -= 6; // keep the async keyword
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return '';
}

// A real PDF header — the same magic bytes as a certified copy off a scanner.
const PDF_BUFFER = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
const JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/* ── why the image branch could never work for a PDF ─────────────────────── */

describe('normalizeImageForAi, run for real', () => {
  const helpers = ['detectMimeFromBase64', 'stripBase64DataUrlPrefix', 'normalizeImageMimeType',
    'isClaudeSafeImageMimeType', 'normalizeImageForAi'].map((n) => extractFunction(serverJs, n));

  function build() {
    let edgeCalls = 0;
    const make = new Function('invokeSupabaseEdgeFunction', 'SUPABASE_SCAN_NORMALIZER_FUNCTION',
      helpers.join('\n\n') + '\nreturn { normalizeImageForAi };');
    const api = make(async () => { edgeCalls++; return { ok: false, message: 'stub' }; }, 'normalize-scan-image');
    return { normalizeImageForAi: api.normalizeImageForAi, edgeCalls: () => edgeCalls };
  }

  it('lifted all five helpers out of server.js', () => {
    helpers.forEach((src) => expect(src.length).toBeGreaterThan(0));
  });

  it('rejects a PDF outright — this is the "Image normalization failed" the reviewer saw', async () => {
    const { normalizeImageForAi, edgeCalls } = build();
    const result = await normalizeImageForAi(PDF_BUFFER.toString('base64'), 'application/pdf');
    expect(result.ok).toBe(false);
    expect(result.base64).toBeUndefined();
    expect(result.message).toBe('Unsupported image type.');
    // It never even reaches the normalizer, so no amount of Supabase config would fix it.
    expect(edgeCalls()).toBe(0);
  });

  it('still accepts an actual image, so the photo path is untouched', async () => {
    const { normalizeImageForAi } = build();
    const result = await normalizeImageForAi(JPEG_BUFFER.toString('base64'), 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.mediaType).toBe('image/jpeg');
    expect(result.base64).toBe(JPEG_BUFFER.toString('base64'));
  });
});

/* ── the classifier sends a PDF as a PDF ─────────────────────────────────── */

describe('classifyDocumentWithAI', () => {
  const fn = extractFunction(serverJs, 'classifyDocumentWithAI');

  it('splits PDFs from images instead of asking isVisuallyClassifiable', () => {
    expect(fn).toContain("var isPdfInput = mime === 'application/pdf' || mime.indexOf('pdf') !== -1;");
    expect(fn).toContain("var isPhotoInput = !isPdfInput && mime.startsWith('image/');");
    expect(fn).not.toContain('if (isVisuallyClassifiable(mime)) {');
  });

  it('sends a PDF as a document block, the way the GP-facing scans always have', () => {
    expect(fn).toContain("{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } }");
    // The PDF branch must be reached BEFORE the image branch, or nothing changes.
    expect(fn.indexOf('if (isPdfInput) {')).toBeGreaterThan(-1);
    expect(fn.indexOf('if (isPdfInput) {')).toBeLessThan(fn.indexOf('await normalizeImageForAi('));
  });

  it('accepts a Buffer or an already-encoded string, like the image branch does', () => {
    expect(fn).toContain("var pdfBase64 = Buffer.isBuffer(buffer) ? buffer.toString('base64') : stripBase64DataUrlPrefix(buffer);");
  });

  it('does not judge photo framing on a PDF', () => {
    // A PDF has no frame to fill and nothing can be "lying on top of it"; the shared
    // applyPhotoFramingPolicy() guards on opts.isImage for exactly this reason.
    expect(fn).toContain("var framingVerdict = isPhotoInput ? String(parsed.framing || '').trim().toLowerCase() : '';");
    expect(fn).toContain('fromPdf: isPdfInput');
  });

  it('marks every technical failure as one', () => {
    // Each of these is a broken check, not a finding about the document.
    const technical = [
      "reason: 'AI not configured', technicalError: true",
      "reason: 'The PDF file was empty or could not be read', technicalError: true",
      "reason: 'Image normalization failed', technicalError: true",
      "reason: 'Could not extract text from DOCX', technicalError: true",
      "reason: 'Cannot extract content from .doc files; sent for manual review', technicalError: true",
      "reason: 'Unsupported type for classification', technicalError: true",
      "reason: 'AI API returned ' + aiRes.status, technicalError: true",
      "reason: 'AI returned non-JSON response', technicalError: true",
      "reason: 'AI classification failed: ' + err.message, technicalError: true"
    ];
    technical.forEach((snippet) => expect(fn).toContain(snippet));
  });

  it('leaves a genuine verdict unmarked, so it still reaches the reviewer', () => {
    expect(fn).toContain("reason: String(parsed.reason || '').trim(),");
    expect(fn).toMatch(/reason: String\(parsed\.reason \|\| ''\)\.trim\(\),\s*\n\s*matches: !!parsed\.matches,\s*\n\s*fromPhoto: isPhotoInput,\s*\n\s*fromPdf: isPdfInput/);
  });
});

/* ── a newly-working classifier must not start deciding on its own ───────── */

describe('PDF auto-decide hold', () => {
  it('routes a PDF to a person until the owner opts in', () => {
    // Before this fix a PDF always landed in va_review (classification failed), so
    // letting it auto-approve into Drive unseen — or bounce back to the doctor — would
    // be a brand-new automatic decision on an unproven path.
    expect(serverJs).toContain('const DOC_PIPELINE_PDF_AUTO_DECIDE =');
    expect(serverJs).toContain("String(process.env.DOC_PIPELINE_PDF_AUTO_DECIDE || '').trim().toLowerCase() === 'true'");
    expect(serverJs).toContain("if (aiResult.fromPdf && !DOC_PIPELINE_PDF_AUTO_DECIDE && action !== 'va_review') {");
  });

  it('is a separate switch from the photo one', () => {
    expect(serverJs).toContain("if (aiResult.fromPhoto && !DOC_PIPELINE_PHOTO_AUTO_DECIDE && action !== 'va_review') {");
    expect(serverJs).not.toContain('DOC_PIPELINE_PHOTO_AUTO_DECIDE || DOC_PIPELINE_PDF_AUTO_DECIDE');
  });

  it('both default to off', () => {
    ['DOC_PIPELINE_PHOTO_AUTO_DECIDE', 'DOC_PIPELINE_PDF_AUTO_DECIDE'].forEach((flag) => {
      const decl = serverJs.slice(serverJs.indexOf('const ' + flag + ' ='));
      expect(decl.slice(0, 200)).toContain("process.env." + flag + " || ''");
    });
  });
});

/* ── no technical error ever becomes a note to a GP ──────────────────────── */

describe('reviewerSafeAiReason, run for real', () => {
  const src = extractFunction(serverJs, 'reviewerSafeAiReason');
  const constLine = serverJs.match(/const AI_CHECK_UNAVAILABLE_REASON = '[^']+';/);
  const reviewerSafeAiReason = new Function(constLine[0] + '\n' + src + '\nreturn reviewerSafeAiReason;')();

  it('replaces a technical failure with something a person can act on', () => {
    const out = reviewerSafeAiReason({ reason: 'Image normalization failed', technicalError: true });
    expect(out).toBe('The automatic document check could not run on this file — please review it manually.');
    expect(out).not.toMatch(/normalization/i);
  });

  it('replaces every other technical failure too', () => {
    ['AI API returned 500', 'AI not configured', 'AI returned non-JSON response'].forEach((reason) => {
      expect(reviewerSafeAiReason({ reason, technicalError: true })).not.toContain(reason);
    });
  });

  it('passes a real finding through untouched', () => {
    const finding = 'This appears to be a passport but we expected an MRCGP Certificate.';
    expect(reviewerSafeAiReason({ reason: finding })).toBe(finding);
  });

  it('handles an empty or missing result without inventing a reason', () => {
    expect(reviewerSafeAiReason(null)).toBe('');
    expect(reviewerSafeAiReason({})).toBe('');
    expect(reviewerSafeAiReason({ reason: '   ' })).toBe('');
    // No reason at all is not a technical failure to announce.
    expect(reviewerSafeAiReason({ reason: '', technicalError: true })).toBe('');
  });

  it('is what actually gets written to the task, in both branches', () => {
    const fn = extractFunction(serverJs, 'createDocReviewTask');
    expect(fn).toContain('ai_match_reasoning: reviewerSafeAiReason(aiResult),');
    expect(fn).not.toContain("ai_match_reasoning: aiResult.reason || ''");
    expect(fn.match(/ai_match_reasoning: reviewerSafeAiReason\(aiResult\),/g)).toHaveLength(2);
  });

  it('keeps the raw detail on the timeline, where a developer can still find it', () => {
    expect(extractFunction(serverJs, 'createDocReviewTask'))
      .toContain("aiResult.technicalError ? '. Automatic check failed: ' + String(aiResult.reason || '').trim() : ''");
  });
});

/* ── and the reviewer's two modals refuse it as well ─────────────────────── */

describe('the reject note never starts from a broken check', () => {
  // Tasks flagged BEFORE the server fix still carry "Image normalization failed" in the
  // database, so the guard has to live on the client too — including Dr Obanimoh's.
  function liftGuard(html, reName, fnName) {
    const re = html.match(new RegExp('var ' + reName + ' = (/.+?/i);'));
    expect(re, 'no ' + reName + ' in the page').not.toBeNull();
    const fn = extractFunction(html, fnName);
    expect(fn.length, 'no ' + fnName + '() in the page').toBeGreaterThan(0);
    return {
      source: re[1],
      test: new Function('var ' + reName + ' = ' + re[1] + ';\n' + fn + '\nreturn ' + fnName + ';')()
    };
  }

  const admin = liftGuard(adminHtml, 'TECHNICAL_SCAN_REASON_RE', 'isTechnicalReviewReason');
  const ceo = liftGuard(ceoHtml, 'CEO_TECHNICAL_SCAN_REASON_RE', 'ceoIsTechnicalReviewReason');

  const TECHNICAL = [
    'Image normalization failed',
    'Supabase image normalization failed with status 500.',
    'Unsupported image type.',
    'Unsupported type for classification',
    'AI API returned 400',
    'AI API returned 500',
    'AI returned non-JSON response',
    'AI classification failed: fetch failed',
    'AI not configured',
    'Could not extract text from DOCX',
    'Cannot extract content from .doc files; sent for manual review',
    'The automatic document check could not run on this file — please review it manually.'
  ];

  const REAL_FINDINGS = [
    'This appears to be a passport but we expected an MRCGP Certificate. Please re-upload the correct document.',
    'MRCGP Certificate must be a certified true copy. Please upload a copy certified by an authorised person.',
    'The document is hard to read — please upload a clearer copy.',
    'Move closer so the certificate fills the frame.',
    'The CV must include the signed, dated declaration "The curriculum vitae is true and correct as at [date]".'
  ];

  it('catches every technical string, in both modals', () => {
    TECHNICAL.forEach((text) => {
      expect(admin.test(text), 'admin: ' + text).toBe(true);
      expect(ceo.test(text), 'ceo: ' + text).toBe(true);
    });
  });

  it('lets a real finding through, in both modals', () => {
    REAL_FINDINGS.forEach((text) => {
      expect(admin.test(text), 'admin: ' + text).toBe(false);
      expect(ceo.test(text), 'ceo: ' + text).toBe(false);
    });
  });

  it('treats nothing as nothing', () => {
    ['', '   ', null, undefined].forEach((v) => {
      expect(admin.test(v)).toBe(false);
      expect(ceo.test(v)).toBe(false);
    });
  });

  it('keeps the two patterns byte-identical — drift is the real risk', () => {
    expect(ceo.source).toBe(admin.source);
  });

  it('leaves the note box empty rather than pre-filling a broken check (admin)', () => {
    expect(adminHtml).toContain("var _prefillNote=_reasonIsTechnical?'':_reviewReasonText;");
    expect(adminHtml).toContain('document.getElementById(\'reviewDocNote\').value=_prefillNote;');
    expect(adminHtml).toContain('_reviewDocInitialNote=_prefillNote;');
    // The old line seeded the box with whatever the task said.
    expect(adminHtml).not.toContain("document.getElementById('reviewDocNote').value=_reviewReasonText;");
  });

  it('leaves the note box empty rather than pre-filling a broken check (CEO)', () => {
    expect(ceoHtml).toContain('var ceoReason = ceoReasonIsTechnical ? \'\' : ceoRawReason;');
    expect(ceoHtml).not.toContain("var ceoReason = t.description || t.ai_match_reasoning || '';");
  });

  it('says plainly that the check did not run, instead of alarming the reviewer', () => {
    expect(adminHtml).toContain('The automatic check could not run on this file — please review it yourself below.');
    expect(ceoHtml).toContain('The automatic check could not run on this file — please review it yourself below.');
    // Grey, not the orange reserved for a real problem with the document.
    expect(adminHtml).toContain("_reasonEl.style.color=_reasonIsTechnical?'#6b7280':'#b45309';");
  });

  it('strips a technical string out of the AI-suggested message as well', () => {
    expect(adminHtml).toContain('&&!isTechnicalReviewReason(i);});');
  });
});

/* ── the scan panel stays on screen when the document loads ──────────────── */

describe('the AI scan does not vanish behind the document viewer', () => {
  it('is pinned outside the scroll region, not pushed off the bottom of it', () => {
    // The viewer is 44vh and the panel used to sit BELOW it inside the same scrolling
    // box, so the moment the PDF loaded the scan scrolled out of sight — and a mouse
    // over a PDF scrolls the PDF, not the modal. It reads as the scan closing itself.
    const between = adminHtml.slice(
      adminHtml.indexOf('id="reviewDocMissing"'),
      adminHtml.indexOf('id="reviewDocAiInsight"')
    );
    const closers = between.match(/<\/div>/g) || [];
    expect(closers.length).toBeGreaterThanOrEqual(3); // missing + preview box + scroll region
    expect(adminHtml).toContain('id="reviewDocAiInsight" style="display:none;flex-shrink:0;max-height:30vh;overflow-y:auto;');
  });

  it('gives the viewer room to share with the scan', () => {
    expect(adminHtml).toContain('id="reviewDocFrame" title="Document" style="display:none;width:100%;height:44vh;');
    expect(adminHtml).toContain('id="reviewDocImg" alt="Document" style="display:none;max-width:100%;max-height:44vh;');
    expect(adminHtml).not.toContain('height:60vh;border:none;background:#fff;"></iframe>');
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/*
 * Document auto-crop — "file the certificate, not the carpet".
 *
 * Doctors photograph a certificate on a desk, a bed or a carpet and upload the
 * whole scene (Dr Ibrahim Fashola's CCT, 2026-08-13: a page in the middle of a
 * beige carpet). Every reader afterwards — the AI scan, the RSO, the CEO, AHPRA
 * — gets the carpet too. js/doc-crop.js finds the page and trims the rest.
 *
 * The detector is the part that can silently ruin a document, so it is not
 * grepped: it is lifted out of the real source and EXECUTED against synthetic
 * frames. The rest are source assertions, because the wiring lives inside page
 * IIFEs with no exports and this repo has no jsdom.
 */

const ROOT = path.resolve(__dirname, '..');
const cropJs = fs.readFileSync(path.join(ROOT, 'js/doc-crop.js'), 'utf8');
const scanJs = fs.readFileSync(path.join(ROOT, 'js/qualification-scan.js'), 'utf8');
const onboardingJs = fs.readFileSync(path.join(ROOT, 'js/onboarding.js'), 'utf8');
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const onboardingHtml = fs.readFileSync(path.join(ROOT, 'pages/onboarding.html'), 'utf8');
const myDocumentsHtml = fs.readFileSync(path.join(ROOT, 'pages/my-documents.html'), 'utf8');
const ahpraHtml = fs.readFileSync(path.join(ROOT, 'pages/ahpra.html'), 'utf8');
const swJs = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

const CROP_BUSTER = '20260813a';

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

/* ── the real detector, running headless ──────────────────────────────────
 * Only document.createElement, drawImage and getImageData are touched, so the
 * whole thing runs against a synthetic frame with no browser at all. The
 * tunables are lifted from between the sentinel comments so a threshold can
 * never drift apart from the test that proves what it does.
 */
const detector = (() => {
  const tunablesStart = cropJs.indexOf('var SAMPLE_W');
  const tunablesEnd = cropJs.indexOf('/* ── end tunables ── */');
  expect(tunablesStart, 'tunables block not found in js/doc-crop.js').toBeGreaterThan(-1);
  expect(tunablesEnd, 'end-of-tunables sentinel not found in js/doc-crop.js').toBeGreaterThan(tunablesStart);
  const tunables = cropJs.slice(tunablesStart, tunablesEnd);

  const names = ['clamp01', 'boxArea', 'padBox', 'worthCropping', 'sanitizeBox',
    'sampleLuma', 'otsuThreshold', 'ringStats', 'largestRegion', 'regionToBox',
    'scoreRegion', 'detect'];
  const bodies = names.map((n) => {
    const src = extractFunction(cropJs, n);
    expect(src, n + ' not found in js/doc-crop.js').toBeTruthy();
    return src;
  }).join('\n');

  const factory = new Function('document',
    tunables + '\nvar sampleCanvas = null;\n' + bodies +
    '\nreturn { detect: detect, padBox: padBox, worthCropping: worthCropping, boxArea: boxArea, sanitizeBox: sanitizeBox };');

  return (pixels, w, h) => {
    const fakeDoc = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage() {},
          getImageData: () => ({ data: pixels })
        })
      })
    };
    const api = factory(fakeDoc);
    return { api, source: { naturalWidth: w, naturalHeight: h } };
  };
})();

// A frame of `bg` grey with an optional `fg` rectangle painted on it.
// `noise` spreads the background over a range, the way a carpet or a wood desk
// does, so the tests are not all flat-poster-paint colours.
function frame(w, h, bg, fg, box, noise) {
  const px = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 1000) / 1000;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inBox = box && x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      let v = inBox ? fg : bg;
      if (!inBox && noise) v = Math.max(0, Math.min(255, bg + Math.round((rand() - 0.5) * noise * 2)));
      const p = (y * w + x) * 4;
      px[p] = px[p + 1] = px[p + 2] = v;
      px[p + 3] = 255;
    }
  }
  return px;
}

function run(w, h, bg, fg, box, noise) {
  const { api, source } = detector(frame(w, h, bg, fg, box, noise), w, h);
  return { api, verdict: api.detect(source) };
}

const W = 64;
const H = 48;

describe('finding the document inside the photo', () => {
  it('finds a certificate marooned in the middle of a carpet', () => {
    // The shot this feature exists for: the page is a quarter of the picture.
    const { api, verdict } = run(W, H, 120, 240, { x: 16, y: 12, w: 32, h: 24 }, 30);
    expect(verdict.found).toBe(true);
    expect(verdict.confidence).toBe('high');
    // The box lands on the page, within a pixel of the sampled grid.
    expect(verdict.box.left).toBeCloseTo(16 / W, 1);
    expect(verdict.box.top).toBeCloseTo(12 / H, 1);
    expect(verdict.box.right).toBeCloseTo(48 / W, 1);
    expect(verdict.box.bottom).toBeCloseTo(36 / H, 1);
    // ...and there is enough background around it to be worth removing.
    expect(api.worthCropping(api.padBox(verdict.box, 0.02))).toBe(true);
  });

  it('finds a DARK document on a pale desk, not just a white page on a dark one', () => {
    // Both polarities are measured. Before that, a dark-mounted diploma on a
    // white table was invisible to the detector.
    const { verdict } = run(W, H, 235, 40, { x: 14, y: 10, w: 34, h: 26 });
    expect(verdict.found).toBe(true);
    expect(verdict.confidence).toBe('high');
    expect(verdict.box.left).toBeCloseTo(14 / W, 1);
    expect(verdict.box.right).toBeCloseTo(48 / W, 1);
  });

  it('leaves a flat scan alone — there is nothing to trim', () => {
    // A PDF-style scan or a screenshot. Cropping it would be pure friction, so
    // the crop sheet must never open on one.
    const { verdict } = run(W, H, 250, 250, null);
    expect(verdict.found).toBe(false);
    expect(verdict.flatScan).toBe(true);
  });

  it('says nothing about a photo of clutter rather than inventing a page', () => {
    // Scattered bright objects on a desk: no single region dominates, so the
    // honest answer is "I cannot tell" and the doctor drags the box themselves.
    const px = frame(W, H, 40, 40, null);
    for (let i = 0; i < W * H; i += 7) {
      const p = i * 4;
      px[p] = px[p + 1] = px[p + 2] = 250;
    }
    const { api } = detector(px, W, H);
    const verdict = api.detect({ naturalWidth: W, naturalHeight: H });
    expect(verdict.found).toBe(false);
    expect(verdict.reason).toBe('no-region');
  });

  it('will not crop a photo that is already all document', () => {
    // 93% of the frame. Found, but once the safety margin is added there is
    // nothing left worth trimming — so prepare() passes the original through.
    const { api, verdict } = run(W, H, 70, 240, { x: 1, y: 1, w: 62, h: 46 });
    expect(verdict.found).toBe(true);
    expect(api.worthCropping(api.padBox(verdict.box, 0.02))).toBe(false);
  });

  it('drops to LOW confidence when the page runs off the edge of the photo', () => {
    // A page already cut off must not be cropped unattended — trimming the other
    // three sides makes a bad photo look deliberate. Low confidence means the
    // doctor sees the box before anything is cut.
    const { verdict } = run(W, H, 60, 240, { x: 0, y: 6, w: 40, h: 36 });
    expect(verdict.found).toBe(true);
    expect(verdict.confidence).toBe('low');
  });

  it('measures at full detector resolution too, not just the test-sized frame', () => {
    const { verdict } = run(160, 120, 110, 245, { x: 40, y: 30, w: 80, h: 60 }, 24);
    expect(verdict.found).toBe(true);
    expect(verdict.confidence).toBe('high');
    expect(verdict.box.left).toBeCloseTo(0.25, 1);
  });
});

describe('the safety margin and the "is it worth it" test', () => {
  const { api } = detector(frame(W, H, 120, 240, { x: 16, y: 12, w: 32, h: 24 }), W, H);

  it('grows the box OUTWARDS, never inwards', () => {
    const padded = api.padBox({ left: 0.3, top: 0.3, right: 0.7, bottom: 0.7 }, 0.05);
    expect(padded.left).toBeCloseTo(0.25, 5);
    expect(padded.top).toBeCloseTo(0.25, 5);
    expect(padded.right).toBeCloseTo(0.75, 5);
    expect(padded.bottom).toBeCloseTo(0.75, 5);
  });

  it('never pads outside the photo', () => {
    const padded = api.padBox({ left: 0.01, top: 0, right: 1, bottom: 0.99 }, 0.05);
    expect(padded.left).toBe(0);
    expect(padded.top).toBe(0);
    expect(padded.right).toBe(1);
    expect(padded.bottom).toBe(1);
  });

  it('refuses a crop that would remove almost nothing, or almost everything', () => {
    expect(api.worthCropping({ left: 0, top: 0, right: 1, bottom: 1 })).toBe(false);
    expect(api.worthCropping({ left: 0.45, top: 0.45, right: 0.5, bottom: 0.5 })).toBe(false);
    expect(api.worthCropping({ left: 0.1, top: 0.1, right: 0.8, bottom: 0.8 })).toBe(true);
  });

  it('accepts a box given in percentages and rejects a nonsense one', () => {
    const pct = api.sanitizeBox({ left: 10, top: 12, right: 80, bottom: 88 });
    expect(pct.left).toBeCloseTo(0.1, 5);
    expect(pct.bottom).toBeCloseTo(0.88, 5);
    expect(api.sanitizeBox({ left: 0.8, top: 0.1, right: 0.2, bottom: 0.9 })).toBeNull(); // inverted
    expect(api.sanitizeBox({ left: 0.4, top: 0.4, right: 0.42, bottom: 0.42 })).toBeNull(); // a speck
    expect(api.sanitizeBox(null)).toBeNull();
  });
});

/* ── the AI fallback's answer is never trusted as given ──────────────────── */

describe('server-side check on an AI bounding box', () => {
  const sanitize = (() => {
    const src = extractFunction(serverJs, 'sanitizeAiCropBox');
    expect(src, 'sanitizeAiCropBox not found in server.js').toBeTruthy();
    const consts = [
      'DOC_CROP_PAD', 'DOC_CROP_MIN_SIDE', 'DOC_CROP_MIN_AREA', 'DOC_CROP_MAX_AREA'
    ].map((name) => {
      const m = serverJs.match(new RegExp('const ' + name + ' = ([0-9.]+)'));
      expect(m, name + ' not found in server.js').toBeTruthy();
      return 'var ' + name + ' = ' + m[1] + ';';
    }).join('\n');
    // eslint-disable-next-line no-new-func
    return new Function(consts + '\n' + src + '\nreturn sanitizeAiCropBox;')();
  })();

  it('pads a good box outwards, so a tight answer cannot shave a certificate', () => {
    const box = sanitize({ found: true, left: 0.2, top: 0.25, right: 0.8, bottom: 0.75 });
    expect(box.left).toBeLessThan(0.2);
    expect(box.right).toBeGreaterThan(0.8);
    expect(box.top).toBeLessThan(0.25);
    expect(box.bottom).toBeGreaterThan(0.75);
  });

  it('reads percentages as percentages', () => {
    const box = sanitize({ found: true, left: 20, top: 20, right: 80, bottom: 80 });
    expect(box.left).toBeCloseTo(0.185, 3);
    expect(box.right).toBeCloseTo(0.815, 3);
  });

  it('takes found:false at its word', () => {
    expect(sanitize({ found: false, left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 })).toBeNull();
  });

  it('throws away a box with nothing to trim, a sliver, or junk', () => {
    expect(sanitize({ found: true, left: 0, top: 0, right: 1, bottom: 1 })).toBeNull();
    expect(sanitize({ found: true, left: 0.4, top: 0.1, right: 0.5, bottom: 0.9 })).toBeNull();
    expect(sanitize({ found: true, left: 'a', top: 0, right: 1, bottom: 1 })).toBeNull();
    expect(sanitize(null)).toBeNull();
  });

  it('clamps a box that runs outside the picture', () => {
    const box = sanitize({ found: true, left: -0.2, top: 0.1, right: 0.7, bottom: 0.8 });
    expect(box.left).toBe(0);          // clamped, not rejected
    expect(box.top).toBeCloseTo(0.085, 3);
    expect(box.right).toBeCloseTo(0.715, 3);
  });

  it('rejects a box that clamps out to the whole picture', () => {
    // Over-reported on every side. Once clamped there is nothing left to trim,
    // so this is the "no crop" answer rather than a pointless full-frame crop.
    expect(sanitize({ found: true, left: -0.3, top: -0.2, right: 1.4, bottom: 1.2 })).toBeNull();
  });
});

/* ── the endpoint ────────────────────────────────────────────────────────── */

describe('/api/ai/document-crop', () => {
  // Comments are stripped before asserting on what the handler DOESN'T do — the
  // code explains itself in prose ("NOT checkUserAiLimit: that counter is..."),
  // and a comment mentioning a call is not the same as making it.
  function codeOnly(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  }
  function cropHandler() {
    const start = serverJs.indexOf("pathname === '/api/ai/document-crop'");
    const end = serverJs.indexOf("pathname === '/api/ai/verify-identity'");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return serverJs.slice(start, end);
  }

  it('exists, behind a session', () => {
    expect(serverJs).toContain("pathname === '/api/ai/document-crop' && req.method === 'POST'");
    expect(serverJs).toMatch(/document-crop[\s\S]{0,400}requireSession\(req, res\)/);
  });

  it('does NOT spend one of the doctor\'s document verification attempts', () => {
    // checkUserAiLimit is the small daily allowance for SCANS. Working out where
    // the edges of a page are must never eat into it.
    const block = codeOnly(cropHandler());
    expect(block).not.toContain('checkUserAiLimit');
    expect(block).toContain("checkRateLimitWindow('doc-crop:'");
  });

  it('uses its own model knob and sends no temperature (Opus 4.8 rejects it)', () => {
    expect(serverJs).toContain('const DOC_CROP_MODEL =');
    const block = codeOnly(cropHandler());
    expect(block).toContain('model: DOC_CROP_MODEL');
    expect(block).not.toContain('temperature');
  });

  it('tells the model to be generous, and to refuse rather than guess', () => {
    const block = serverJs.slice(
      serverJs.indexOf('const cropSystemPrompt ='),
      serverJs.indexOf('const cropController =')
    );
    expect(block).toContain('Be generous');
    expect(block).toContain('more than one document');
    expect(block).toContain('runs outside the picture');
    expect(block).toContain('nothing to trim');
  });

  it('answers 200 with found:false when it cannot help, so nothing is blocked', () => {
    const block = cropHandler();
    const softFailures = block.match(/sendJson\(res, 200, \{ ok: false, found: false/g) || [];
    expect(softFailures.length).toBeGreaterThanOrEqual(4); // not configured, budget, rate limit, AI error
  });
});

/* ── the crop must never be the reason an upload fails ───────────────────── */

describe('js/doc-crop.js never blocks an upload', () => {
  it('falls back to the original file on any failure', () => {
    expect(cropJs).toContain('return fileOrBlob; // decode failed');
    // A non-image (PDF, .docx) is returned untouched before anything else runs.
    expect(cropJs).toContain('if (!isImage(fileOrBlob)) return Promise.resolve(fileOrBlob);');
  });

  it('treats a failed AI call as "no suggestion", not an error', () => {
    expect(cropJs).toMatch(/\.catch\(function \(\) \{\s*\n\s*return null; \/\/ AI down/);
  });

  it('crops silently for a camera capture and shows the sheet for an upload', () => {
    expect(cropJs).toContain('var silent = o.origin === "camera";');
    expect(cropJs).toMatch(/if \(silent\) return cropToBlob/);
    expect(cropJs).toContain('if (silent && !force) return fileOrBlob;');
  });

  it('only crops unattended when the detector is confident AND it is worth it', () => {
    expect(cropJs).toContain('if (!force && verdict.found && verdict.confidence === "high" && worthCropping(padded))');
  });

  it('keeps a PNG a PNG, so text in a screenshot is not smeared by JPEG', () => {
    expect(cropJs).toContain('return /png/i.test(String(inputMime || "")) ? "image/png" : "image/jpeg";');
  });

  it('has no Escape handler that would also close the modal underneath it', () => {
    expect(cropJs).not.toContain('"keydown"');
    expect(cropJs).toContain('Deliberately NO Escape-to-cancel');
  });
});

/* ── every place a doctor sends us a document photo ──────────────────────── */

describe('wired into the document upload paths', () => {
  it('onboarding qualifications — both the camera and the file picker', () => {
    expect(onboardingJs).toContain('window.DocCrop.prepare(fileOrBlob, {');
    expect(onboardingJs).toContain('handleDocVerification(key, blob, doc.label + ".jpg", "camera")');
    expect(onboardingJs).toContain('handleDocVerification(key, file, file.name, "file")');
    // The crop runs BEFORE the file is prepared, so the scan AND the stored copy
    // are both the cropped document.
    expect(onboardingJs.indexOf('window.DocCrop.prepare(fileOrBlob'))
      .toBeLessThan(onboardingJs.indexOf('prepared = await prepareQualUpload(fileOrBlob)'));
  });

  it('onboarding identity document', () => {
    expect(onboardingJs).toContain('window.DocCrop.prepare(fileOrBlob, {');
    expect(onboardingJs).toContain('handleIdVerification(blob, "ID_capture.jpg", "camera")');
    expect(onboardingJs).toContain('handleIdVerification(file, file.name, "file")');
  });

  it('a cancelled crop releases the slot instead of wedging it on "Scanning..."', () => {
    expect(onboardingJs).toContain('if (!cropped) { delete activeDocUploads[docKey]; return; }');
    expect(onboardingJs).toContain('if (!croppedId) { idVerifyInProgress = false; return; }');
  });

  it('the scan modal', () => {
    expect(scanJs).toContain('function pickFile(file, origin)');
    expect(scanJs).toContain('window.DocCrop.prepare(file, {');
    expect(scanJs).toContain('pickFile(capturedFile, "camera")');
    expect(scanJs).toContain('pickFile(pickedFile, "file")');
  });

  it('Documents tab — prepared documents and the police check', () => {
    expect(myDocumentsHtml).toContain('function withDocCrop(file, label, next)');
    expect(myDocumentsHtml).toContain('withDocCrop(files[0], (docDefForCrop && docDefForCrop.title) || "document", proceed)');
    expect(myDocumentsHtml).toContain('withDocCrop(file, "police check", function (cropped) {');
  });

  it('a multi-page CV is cropped quietly — ten crop sheets would be worse', () => {
    expect(myDocumentsHtml).toContain('window.DocCrop.prepare(pageFile, { origin: "camera", ai: false })');
  });

  it('AHPRA documents, which are the ones that get emailed on', () => {
    expect(ahpraHtml).toContain('function handleIntroUpload(docKey, file)');
    expect(ahpraHtml).toContain('function handleIntroUploadFile(docKey, file)');
    expect(ahpraHtml).toContain('function handleAhpraUpload(taskId, file)');
    expect(ahpraHtml).toContain('async function handleAhpraUploadFile(taskId, file)');
    const prepares = ahpraHtml.match(/window\.DocCrop\.prepare\(file, \{ label: "document", origin: "file" \}\)/g) || [];
    expect(prepares).toHaveLength(2);
  });

  it('clears the file input before the crop, so re-picking the same file works', () => {
    // Backing out of the crop sheet and choosing the SAME file again fires no
    // change event at all unless the input was cleared first.
    expect(onboardingJs).toContain('e.target.value = "";');
    expect(scanJs).toContain('e.target.value = "";');
  });
});

/* ── cropping a document that is ALREADY on file (staff) ─────────────────── */

describe('staff can crop a stored document', () => {
  const adminHtml = fs.readFileSync(path.join(ROOT, 'pages/admin.html'), 'utf8');
  const ceoHtml = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');
  const cropEndpoint = (() => {
    const start = serverJs.indexOf("pathname === '/api/admin/va/task/crop-document'");
    const end = serverJs.indexOf("pathname === '/api/admin/va/doc-review/ai-scan'");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return serverJs.slice(start, end);
  })();

  it('is offered in BOTH staff consoles, not just one', () => {
    expect(adminHtml).toContain('id="reviewDocCropBar"');
    expect(adminHtml).toContain('cropReviewDocImage()');
    expect(ceoHtml).toContain('ceoReviewDocCropBar');
    expect(ceoHtml).toContain('function ceoCropReviewDoc(taskId)');
    // Both load the shared module.
    expect(adminHtml).toContain('doc-crop.js?v=' + CROP_BUSTER);
    expect(ceoHtml).toContain('doc-crop.js?v=' + CROP_BUSTER);
  });

  it('opens the sheet in force mode — staff see background the detector may not', () => {
    expect(adminHtml).toContain("force:true");
    expect(ceoHtml).toContain('force: true');
    expect(cropJs).toContain('var force = o.force === true;');
    expect(cropJs).toContain('if (!force && (verdict.flatScan || (padded && !worthCropping(padded))))');
  });

  it('only appears for images — a PDF has nothing to crop', () => {
    expect(adminHtml).toMatch(/indexOf\('image\/'\)===0\)\{[\s\S]{0,400}_cropBar\)_cropBar\.style\.display='flex'/);
    expect(ceoHtml).toMatch(/indexOf\('image\/'\) === 0\) \{[\s\S]{0,400}cropBar\.style\.display = 'flex'/);
  });

  it('is behind an admin session AND the per-task access check', () => {
    expect(cropEndpoint).toContain('requireAdminSession(req, res)');
    expect(cropEndpoint).toContain('ensureAdminTaskAccess(cropAdminCtx, cropTaskId, res)');
  });

  it('proves the bytes are really the image type they claim', () => {
    expect(cropEndpoint).toContain("cropMime !== 'image/jpeg' && cropMime !== 'image/png'");
    expect(cropEndpoint).toContain('0xFF && cropBuf[1] === 0xD8');
    expect(cropEndpoint).toContain('0x89 && cropBuf[1] === 0x50');
  });

  it('keeps a copy of the original before overwriting it', () => {
    expect(cropEndpoint).toContain(".precrop-'");
    // The backup is written BEFORE the new bytes land on the real path.
    expect(cropEndpoint.indexOf('backupPath')).toBeLessThan(
      cropEndpoint.indexOf('const stored = await supabaseStorageUploadObject(cropTarget.bucket, cropTarget.path'));
  });

  it('updates the Google Drive mirror, which is only ever uploaded once', () => {
    expect(cropEndpoint).toContain('replaceGoogleDriveFileContent(cropTarget.row.google_drive_file_id');
    expect(serverJs).toContain('async function replaceGoogleDriveFileContent(fileId, buffer, mimeType)');
    // reconcileGpDrive skips any row that already has an id, which is exactly why
    // the content has to be replaced in place rather than re-uploaded.
    expect(serverJs).toContain('if (d.google_drive_file_id) {');
  });

  it('drops the cached AI verdict, because the picture it judged is gone', () => {
    expect(cropEndpoint).toContain('const clearCachedScan');
    expect(cropEndpoint).toContain("delete mergedMeta.ai_scan");
    // Metadata is MERGED, never replaced — a blind write drops everything else on it.
    expect(cropEndpoint).toContain('Object.assign({}, existingMeta)');
    // ...and the reviewer's panel re-scans the clean image straight away.
    expect(adminHtml).toContain('runReviewDocAiScan(true)');
  });

  it('leaves the review decision, status and file name alone', () => {
    expect(cropEndpoint).toContain('body: { mime_type: cropMime, file_size: cropBuf.length, updated_at:');
    expect(cropEndpoint).not.toContain('status:');
    expect(cropEndpoint).not.toContain('reviewed_by');
  });

  it('handles a document stored on the task itself, not only in GP storage', () => {
    expect(cropEndpoint).toContain("cropTarget.kind === 'task_attachment'");
    expect(cropEndpoint).toContain('body: { attachment_url: cropDataUrl }');
  });

  it('resolves the file the same way the preview and the scan do', () => {
    // One resolver, and ONE table of onboarding key aliases — three hand-written
    // copies is how a key goes missing and a stored document reads as absent.
    expect(serverJs).toContain('async function resolveTaskDocumentStorage(task)');
    expect(serverJs).toContain('const ONBOARDING_DOC_KEY_ALIASES = {');
    const aliasUses = serverJs.match(/ONBOARDING_DOC_KEY_ALIASES\[/g) || [];
    expect(aliasUses.length).toBeGreaterThanOrEqual(3); // preview, ai-scan, resolver
    expect(serverJs).not.toContain('ONBOARDING_KEY_FOR_QUAL');
    expect(serverJs).not.toContain('ONBOARDING_KEY_FOR_SCAN');
  });
});

/* ── loading ─────────────────────────────────────────────────────────────── */

describe('the module is actually on the pages that need it', () => {
  it('is loaded eagerly by the three upload pages', () => {
    expect(onboardingHtml).toContain('doc-crop.js?v=' + CROP_BUSTER);
    expect(myDocumentsHtml).toContain('doc-crop.js?v=' + CROP_BUSTER);
    expect(ahpraHtml).toContain('doc-crop.js?v=' + CROP_BUSTER);
  });

  it('loads before the onboarding wizard that calls it', () => {
    expect(onboardingHtml.indexOf('doc-crop.js')).toBeLessThan(onboardingHtml.indexOf('js/onboarding.js'));
  });

  it('is fetched on demand by the scan modal on every other page', () => {
    expect(scanJs).toContain('var DOC_CROP_SRC = "/js/doc-crop.js?v=' + CROP_BUSTER + '";');
    expect(scanJs).toContain('function ensureDocCrop()');
  });

  it('keeps the lazy loader\'s buster in step with the page tags', () => {
    // One buster, four places. A mismatch means some doctors get one version of
    // the crop and some get another.
    const loaderBuster = (scanJs.match(/doc-crop\.js\?v=([0-9a-z]+)/) || [])[1];
    for (const html of [onboardingHtml, myDocumentsHtml, ahpraHtml]) {
      const pageBusters = html.match(/doc-crop\.js\?v=([0-9a-z]+)/g) || [];
      expect(pageBusters.length).toBeGreaterThan(0);
      for (const found of pageBusters) expect(found).toBe('doc-crop.js?v=' + loaderBuster);
    }
  });

  it('bumps the service worker so the new page HTML is not served a navigation late', () => {
    // Assert the SW moved to at least the crop deploy, not that it is frozen at
    // it — later fixes must be free to bump VERSION again (a page whose HTML
    // changed is served a navigation late otherwise). Stamps are sortable
    // YYYYMMDD+letter strings.
    const version = (/var VERSION = "([^"]+)"/.exec(swJs) || [])[1] || '';
    expect(version >= CROP_BUSTER).toBe(true);
  });

  it('bumps the busters of the two scripts whose code changed', () => {
    expect(onboardingHtml).toContain('onboarding.js?v=20260901a');
    expect(myDocumentsHtml).toContain('qualification-scan.js?v=' + CROP_BUSTER);
    expect(onboardingHtml).not.toContain('onboarding.js?v=20260801c');
  });
});

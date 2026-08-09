import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/*
 * Doctors photograph their certificates on a desk and send us the desk: a degree
 * with a keyboard resting on the top of it and a phone across the corner (Dr
 * Deepika Ganesh's primary medical degree, 2026-08-01) is readable enough for the
 * model to answer questions about, so nothing stopped it — it only failed later,
 * by hand. Every vision scan now judges the PICTURE as well as the document.
 *
 * Most of these are source assertions: the humanizers live inside page IIFEs with
 * no exports and the repo has no jsdom. The exceptions are the two that matter
 * most — the humanizer tables and the camera's framing measurement are pulled out
 * of the real source and executed.
 */

const ROOT = path.resolve(__dirname, '..');
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const cameraJs = fs.readFileSync(path.join(ROOT, 'js/qualification-camera.js'), 'utf8');
const scanJs = fs.readFileSync(path.join(ROOT, 'js/qualification-scan.js'), 'utf8');
const onboardingJs = fs.readFileSync(path.join(ROOT, 'js/onboarding.js'), 'utf8');
const myDocumentsHtml = fs.readFileSync(path.join(ROOT, 'pages/my-documents.html'), 'utf8');
const onboardingHtml = fs.readFileSync(path.join(ROOT, 'pages/onboarding.html'), 'utf8');

/* ── helpers that lift real literals out of the source ───────────────────── */

function extractBlock(src, opener, closer) {
  const start = src.indexOf(opener);
  if (start === -1) return '';
  const from = start + opener.length - 1; // keep the opening bracket
  const end = src.indexOf(closer, from);
  if (end === -1) return '';
  return src.slice(from, end + closer.length).replace(/;$/, '');
}

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

// The finished, GP-facing wording the server sends (one per framing verdict).
const serverIssues = (() => {
  const literal = extractBlock(serverJs, 'const PHOTO_FRAMING_ISSUES = {', '\n};');
  expect(literal, 'PHOTO_FRAMING_ISSUES not found in server.js').toBeTruthy();
  // eslint-disable-next-line no-eval
  return eval('(' + literal + ')');
})();

function loadHumanizerTable(src, label) {
  const literal = extractBlock(src, 'var PHOTO_FRAMING_MESSAGES = [', '\n  ];');
  expect(literal, 'PHOTO_FRAMING_MESSAGES not found in ' + label).toBeTruthy();
  // eslint-disable-next-line no-eval
  const table = eval('(' + literal + ')');
  return {
    table,
    match(issue) {
      const lower = String(issue).toLowerCase();
      for (const entry of table) if (entry.test.test(lower)) return entry.text;
      return '';
    }
  };
}

const scanHumanizer = loadHumanizerTable(scanJs, 'js/qualification-scan.js');
const onboardingHumanizer = loadHumanizerTable(onboardingJs, 'js/onboarding.js');

/* ── the AI is asked, everywhere a photo is scanned ──────────────────────── */

describe('every vision scan judges the photo, not just the document', () => {
  it('embeds the one shared framing rule in all four scan prompts', () => {
    expect(serverJs).toContain('const PHOTO_FRAMING_PROMPT_RULE =');
    // qualification, certification, classification, identity
    const uses = serverJs.match(/\$\{PHOTO_FRAMING_PROMPT_RULE\}/g) || [];
    expect(uses).toHaveLength(4);
    const fields = serverJs.match(/\$\{PHOTO_FRAMING_JSON_FIELD\}/g) || [];
    expect(fields).toHaveLength(4);
  });

  it('spells out what counts as too_small, cut_off and obstructed', () => {
    const rule = extractBlock(serverJs, 'const PHOTO_FRAMING_PROMPT_RULE = `', '`;');
    expect(rule).toMatch(/"too_small"/);
    expect(rule).toMatch(/"cut_off"/);
    expect(rule).toMatch(/"obstructed"/);
    expect(rule).toMatch(/keyboard/i);
    // The model must not invent a problem it cannot see — a false rejection costs
    // the doctor a re-upload of a document that was fine.
    expect(rule).toMatch(/if you are unsure.*return "ok"/i);
  });

  it('never judges the framing of a PDF or a flat scan', () => {
    const fn = extractFunction(serverJs, 'applyPhotoFramingPolicy');
    expect(fn).toContain('opts.isImage !== true');
    // The qualification scan is reached with a PDF content block too.
    expect(serverJs).toContain("isImage: !!(contentBlock && contentBlock.type === 'image')");
    // Certification + classification decide from the mime type they already parsed.
    expect(serverJs.match(/isImage: !isPdf,/g) || []).toHaveLength(2);
  });

  it('fails the scan under whichever key that endpoint treats as its verdict', () => {
    const fn = extractFunction(serverJs, 'applyPhotoFramingPolicy');
    expect(fn).toContain("const passKey = opts.passKey || 'verified'");
    expect(fn).toContain('result[passKey] = false');
    expect(fn).toContain('result.retakePhoto = true');
    expect(serverJs).toContain("passKey: 'certified'");
    expect(serverJs).toContain("passKey: 'matches'");
  });

  it('does not spend a verification attempt when only the photo was wrong', () => {
    // Five bad photos of the RIGHT degree must not end in manual review with five
    // unusable pictures attached.
    expect(serverJs).toContain('const qRetakePhotoOnly = vq.retakePhoto === true && vq.framingOnly === true && qNameOk');
    expect(serverJs).toContain('if (!qNameChange && !qRetakePhotoOnly && !(vq.verified === true && qNameOk))');
    expect(serverJs).toContain('const certRetakePhotoOnly = certFramingFailed && certVerification.framingOnly === true');
    expect(serverJs).toContain('const classifyRetakePhotoOnly = classifyFramingFailed && classifyResult.framingOnly === true');
    // framingOnly is only true when the document itself had already passed.
    expect(extractFunction(serverJs, 'applyPhotoFramingPolicy'))
      .toContain('result.framingOnly = result[passKey] === true');
  });

  it('tells a prepared-document card the photo failed, not the document', () => {
    // "This appears to be X, not Y" is plainly wrong when X and Y are the same
    // document and the picture is the problem.
    expect(serverJs).toContain('if (classifyFramingFailed) classifyResult.reason = classifyResult.framingMessage;');
    expect(myDocumentsHtml).toContain('if (cls.retakePhoto && cls.reason) return escapeHtml(cls.reason);');
  });
});

/* ── the staff-side pipeline ─────────────────────────────────────────────── */

describe('background document classifier', () => {
  it('sends the image as base64, not as a raw Buffer', () => {
    // normalizeImageForAi does String(value) internally, so a Buffer was decoded
    // as UTF-8 and Anthropic received mojibake instead of a JPEG: every call came
    // back 400 ("AI API returned 400" on the reviewer's card) and, with confidence
    // null, every document fell to the va_review default.
    const fn = extractFunction(serverJs, 'classifyDocumentWithAI');
    expect(fn).toContain("var imageBase64 = Buffer.isBuffer(buffer) ? buffer.toString('base64') : buffer;");
    expect(fn).toContain('await normalizeImageForAi(imageBase64, mime)');
    expect(fn).not.toContain('await normalizeImageForAi(buffer, mime)');
  });

  it('proves a Buffer would not have survived String()', () => {
    const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const asServerSawIt = String(jpegMagic || '').trim();
    expect(asServerSawIt).not.toBe(jpegMagic.toString('base64'));
    expect(/^[A-Za-z0-9+/=\s]*$/.test(asServerSawIt)).toBe(false);
  });

  it('never auto-approves a badly framed photo', () => {
    const fn = extractFunction(serverJs, 'classifyDocumentWithAI');
    // Image-only, deliberately: isVisuallyClassifiable() is ALSO true for a PDF, and a PDF
    // has no frame to judge (see the pdf-classification suite below).
    expect(fn).toContain("var isPhotoInput = !isPdfInput && mime.startsWith('image/');");
    expect(fn).toContain('systemPrompt += \'\\n\\n\' + PHOTO_FRAMING_PROMPT_RULE');
    // Null confidence routes to va_review in classifyConfidenceAction: a person
    // decides, but the photo cannot pass on a score.
    expect(fn).toMatch(/if \(framingIssue\) \{[\s\S]*confidence: null,[\s\S]*reason: framingIssue/);
  });

  it('only judges framing when the file was a photo', () => {
    const fn = extractFunction(serverJs, 'classifyDocumentWithAI');
    expect(fn).toContain("var framingVerdict = isPhotoInput ? String(parsed.framing || '').trim().toLowerCase() : '';");
  });

  it('does not start deciding photos on its own just because the call works now', () => {
    // Image classification never reached the model before the Buffer fix, so
    // auto-approve and auto-reject have never run against a real document. A
    // person keeps the decision until the owner turns them on deliberately.
    expect(serverJs).toContain('const DOC_PIPELINE_PHOTO_AUTO_DECIDE =');
    expect(serverJs).toContain("String(process.env.DOC_PIPELINE_PHOTO_AUTO_DECIDE || '').trim().toLowerCase() === 'true'");
    expect(serverJs).toContain("if (aiResult.fromPhoto && !DOC_PIPELINE_PHOTO_AUTO_DECIDE && action !== 'va_review') {");
    expect(serverJs).toContain("action = 'va_review';");
    // DOCX classification already worked and already decides — leave it alone.
    expect(extractFunction(serverJs, 'classifyDocumentWithAI')).toContain('fromPhoto: isPhotoInput');
  });
});

/* ── what the doctor actually reads ──────────────────────────────────────── */

describe('framing rejections read as a retake, in both humanizers', () => {
  it('covers all three verdicts', () => {
    expect(Object.keys(serverIssues).sort()).toEqual(['cut_off', 'obstructed', 'too_small']);
  });

  for (const [verdict, message] of Object.entries(serverIssues)) {
    it('maps the server "' + verdict + '" message back to itself (idempotent)', () => {
      // An issue is humanized two or three times on its way to the screen. If a
      // pass stops matching, the carefully written copy silently becomes the raw
      // model text — the failure mode that made earlier branches dead code.
      expect(scanHumanizer.match(message)).toBe(message);
      expect(onboardingHumanizer.match(message)).toBe(message);
      expect(scanHumanizer.match(scanHumanizer.match(message))).toBe(message);
      expect(onboardingHumanizer.match(onboardingHumanizer.match(message))).toBe(message);
    });
  }

  it('also catches the phrasings the model writes for itself', () => {
    const raw = {
      'The photo shows the certificate on a desk but the document is too small in the photo.':
        serverIssues.too_small,
      'The bottom edge of the document is outside the photo.': serverIssues.cut_off,
      'A keyboard is lying on top of the document, obstructing the qualifications line.':
        serverIssues.obstructed,
      'Something is covering part of the document.': serverIssues.obstructed
    };
    for (const [issue, expected] of Object.entries(raw)) {
      expect(scanHumanizer.match(issue), issue).toBe(expected);
      expect(onboardingHumanizer.match(issue), issue).toBe(expected);
    }
  });

  it('leaves unrelated scan issues alone', () => {
    const unrelated = [
      'This looks like a Certificate of Registration from the Karnataka Medical Council, not Primary Medical Degree.',
      'The document is too blurry to read. Please upload a clearer photo.',
      'The name on this document is different from the name on your account.',
      'This file is too large to scan.'
    ];
    for (const issue of unrelated) {
      expect(scanHumanizer.match(issue), issue).toBe('');
      expect(onboardingHumanizer.match(issue), issue).toBe('');
    }
  });

  it('keeps the two copies of the table identical', () => {
    // They are separate files by necessity (onboarding does not load the scan
    // bundle), so drift between them is the thing to guard.
    const a = extractBlock(scanJs, 'var PHOTO_FRAMING_MESSAGES = [', '\n  ];');
    const b = extractBlock(onboardingJs, 'var PHOTO_FRAMING_MESSAGES = [', '\n  ];');
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it('is consulted before the blurry and name branches', () => {
    // A page half out of shot also reads as blurry and its name unreadable; the
    // one useful instruction is "retake it properly".
    const framingAt = scanJs.indexOf('var framingMessage = matchPhotoFramingIssue(lower);');
    const blurryAt = scanJs.indexOf('/too blurry|blurry to read');
    expect(framingAt).toBeGreaterThan(-1);
    expect(framingAt).toBeLessThan(blurryAt);
    const oFramingAt = onboardingJs.indexOf('var framingMessage = matchPhotoFramingIssue(lower);');
    const oBlurryAt = onboardingJs.indexOf('/too blurry|blurry to read');
    expect(oFramingAt).toBeGreaterThan(-1);
    expect(oFramingAt).toBeLessThan(oBlurryAt);
  });

  it('does not show "Attempt 0 of 5" when the retake was free', () => {
    expect(onboardingJs).toContain('var retakePhotoOnly = v.retakePhoto === true && v.framingOnly === true && nameConfirmed;');
    expect(onboardingJs).toContain('if (!retakePhotoOnly) {');
    expect(onboardingJs).toMatch(/if \(retryCount > 0\) \{\s*\n\s*infoHtml \+= '<div class="qual-doc-slot-retry">Attempt '/);
  });
});

/* ── the camera measures framing itself, live, before anything is sent ───── */

describe('camera framing measurement', () => {
  // measureFraming only ever touches document.createElement, drawImage and
  // getImageData, so it runs headless against synthetic pixels.
  const measureFraming = (() => {
    const src = extractFunction(cameraJs, 'measureFraming');
    const drawSrc = extractFunction(cameraJs, 'drawSource');
    expect(src, 'measureFraming not found').toBeTruthy();
    expect(drawSrc, 'drawSource not found').toBeTruthy();
    const factory = new Function(
      'document', 'FRAMING_SAMPLE_W', 'FRAMING_MIN_COVERAGE', 'FRAMING_MIN_FILL', 'FRAMING_EDGE_RUN',
      'var framingCanvas = null;\n' + drawSrc + '\n' + src + '\nreturn measureFraming;'
    );
    return (pixels) => {
      const doc = {
        createElement: () => ({
          width: 0,
          height: 0,
          getContext: () => ({
            drawImage() {},
            getImageData: () => ({ data: pixels })
          })
        })
      };
      return factory(doc, 64, 0.55, 0.55, 0.25)({ dummy: true }, null);
    };
  })();

  const W = 64;
  const H = 48;

  // A frame of `bg` grey with a `fg` rectangle painted on it.
  function frame(bg, fg, box) {
    const px = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inBox = box && x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
        const v = inBox ? fg : bg;
        const p = (y * W + x) * 4;
        px[p] = px[p + 1] = px[p + 2] = v;
        px[p + 3] = 255;
      }
    }
    return px;
  }

  it('passes a page that fills the frame', () => {
    // 80% of the frame — a document photographed properly.
    const r = measureFraming(frame(30, 235, { x: 4, y: 3, w: 57, h: 43 }));
    expect(r.code).toBe('ok');
    expect(r.coverage).toBeGreaterThan(0.55);
  });

  it('flags a page marooned in the middle of a desk', () => {
    // ~9% of the frame: the shot the safeguard exists for.
    const r = measureFraming(frame(30, 235, { x: 24, y: 18, w: 18, h: 12 }));
    expect(r.code).toBe('too_small');
    expect(r.coverage).toBeLessThan(0.2);
  });

  it('sits exactly on the coverage line it documents', () => {
    // 60% — inside the threshold, must pass; 40% — outside it, must not.
    expect(measureFraming(frame(30, 235, { x: 8, y: 5, w: 48, h: 38 })).code).toBe('ok');
    expect(measureFraming(frame(30, 235, { x: 16, y: 12, w: 32, h: 24 })).code).toBe('too_small');
  });

  it('says nothing about a flat frame', () => {
    // All desk, all page, or a dark room — there is no edge to measure, and a
    // guess here would block a doctor over nothing.
    expect(measureFraming(frame(200, 200, null)).code).toBe('unknown');
    expect(measureFraming(frame(20, 20, null)).code).toBe('unknown');
  });

  it('never flags a page it cannot tell apart from the surface', () => {
    // White paper on a white desk, and a page that already fills the shot: both
    // must come back as "nothing to say" rather than a false "move closer".
    expect(measureFraming(frame(240, 250, { x: 20, y: 15, w: 10, h: 8 })).code).not.toBe('too_small');
    expect(measureFraming(frame(30, 240, { x: 1, y: 1, w: 62, h: 46 })).code).not.toBe('too_small');
  });

  it('catches a certificate running off the edge of the frame', () => {
    // The failure the owner photographed: an A4 certificate held too close reads
    // as "filling the frame" on coverage alone while its top and bottom are
    // outside the photo — and the old check called that "looks good".
    const r = measureFraming(frame(30, 235, { x: 0, y: 0, w: 64, h: 40 }));
    expect(r.code).toBe('cut_off');
    // ...and it is NOT reported as too_small: it is the opposite problem.
    expect(r.code).not.toBe('too_small');
  });

  it('does not cry "cut off" when a corner merely grazes the edge', () => {
    // A page that touches an edge briefly is not a page running past it, which
    // is why the test is a share of the border rather than any contact at all.
    const r = measureFraming(frame(30, 235, { x: 52, y: 40, w: 12, h: 8 }));
    expect(r.code).not.toBe('cut_off');
  });

  it('will not show a green tick over a small page on a pale desk', () => {
    // Caught in the live demo: a white page on a white desk read as "ok" via the
    // mostly-bright short-circuit, so a badly framed shot got the lock-on tick.
    // We cannot separate page from desk here — "unknown" is the honest answer,
    // and it stays neutral instead of endorsing the shot.
    const smallPageOnWhiteDesk = measureFraming(frame(228, 247, { x: 24, y: 18, w: 16, h: 12 }));
    expect(smallPageOnWhiteDesk.code).toBe('unknown');
    expect(smallPageOnWhiteDesk.code).not.toBe('ok');
  });

  it('does not mistake scattered highlights for a small document', () => {
    const px = frame(20, 20, null);
    // A dozen unrelated bright specks — a lamp, reflections, pale clutter.
    for (let i = 0; i < 12; i++) {
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          const x = (i * 5) % (W - 4) + dx;
          const y = ((i * 7) % (H - 4)) + dy;
          const p = (y * W + x) * 4;
          px[p] = px[p + 1] = px[p + 2] = 245;
        }
      }
    }
    expect(measureFraming(px).code).toBe('unknown');
  });
});

describe('the frame is A4, and the photo is what is inside it', () => {
  it('shapes the viewfinder to a portrait certificate', () => {
    // A certificate is A4 portrait. The old frame was a fixed inset box inside a
    // short, wide preview strip, so an A4 page could not fit in it — the doctor
    // watched the top and bottom of their degree get cropped away.
    expect(cameraJs).toContain('var A4_RATIO = 1.414;');
    expect(cameraJs).toMatch(/\.qcam-viewfinder\{[^}]*aspect-ratio:1 \/ " \+ A4_RATIO/);
  });

  it('captures the region behind the brackets, not the whole camera frame', () => {
    const fn = extractFunction(cameraJs, 'getCaptureCrop');
    expect(fn, 'getCaptureCrop not found').toBeTruthy();
    // object-fit: cover has to be undone to find where the brackets fall on the
    // source frame, or the crop lands somewhere else entirely.
    expect(fn).toContain('Math.max(vRect.width / vw, vRect.height / vh)');
    expect(fn).toContain('var bleedX = fRect.width * CAPTURE_BLEED;');
    // Never ask drawImage for pixels outside the frame.
    expect(fn).toContain('if (sx + sw > vw) sw = vw - sx;');
    expect(cameraJs).toContain('var crop = getCaptureCrop(video);');
    expect(cameraJs).toContain('drawSource(ctx, video, crop, w, h);');
  });

  it('captures slightly beyond the brackets so a neat shot is not clipped', () => {
    expect(cameraJs).toContain('var CAPTURE_BLEED = 0.06;');
  });

  it('does not force an A4 frame on a passport or licence', () => {
    // Both are LANDSCAPE. Shaping every scan to A4 would ask the doctor to line
    // an ID card up inside a tall rectangle — the same mismatch in reverse.
    expect(cameraJs).toContain('var ID_CARD_RATIO = 0.68;');
    expect(cameraJs).toContain('currentFrameRatio = Number(opts.frameRatio) > 0 ? Number(opts.frameRatio) : A4_RATIO;');
    expect(cameraJs).toContain('availableH / currentFrameRatio');
    // The identity capture in onboarding must actually pass it.
    expect(onboardingJs).toMatch(/QualCamera\.open\(\{[\s\S]{0,400}frameRatio: 0\.68/);
  });

  it('puts the camera behind everything instead of a black slab', () => {
    // The owner asked for the black background to go and the instructions to sit
    // on glass over the live picture.
    expect(cameraJs).toContain('.qcam-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}');
    expect(cameraJs).toMatch(/\.qcam-tipcard\{[^}]*backdrop-filter:blur\(14px\)/);
    expect(cameraJs).toMatch(/\.qcam-tipcard\{[^}]*background:rgba\(15,23,42,0\.34\)/);
    expect(cameraJs).not.toContain('.qcam-bottom{background:rgba(0,0,0,0.85)');
    // Outside the frame is dimmed rather than blacked out.
    expect(cameraJs).toMatch(/\.qcam-viewfinder\{[^}]*box-shadow:0 0 0 9999px rgba\(0,0,0,0\.55\)/);
  });

  it('keeps the checklist short so the frame stays big', () => {
    expect(cameraJs).toContain('var MAX_TIPS = 3;');
    expect(cameraJs).toContain('.slice(0, MAX_TIPS)');
  });
});

describe('camera guidance', () => {
  it('leads every checklist with framing', () => {
    expect(cameraJs).toContain('Line the page up inside the frame');
    expect(cameraJs).toContain('Nothing resting on it: no keyboard, phone or fingers');
    expect(cameraJs).toContain('return FRAMING_TIPS.concat(');
  });

  it('keeps the certification line on a per-document checklist', () => {
    expect(cameraJs).toContain('if (requireCert) specific.unshift(CERT_TIP);');
  });

  it('nudges live, while the shot is being lined up', () => {
    expect(cameraJs).toContain('Move closer — fill the frame with the document');
    expect(cameraJs).toContain('Move back — the whole page must be inside the frame');
    // Lighting is reported first: a dark or blown-out frame makes the framing
    // measurement unreliable and is the thing to fix before moving the camera.
    const darkAt = cameraJs.indexOf('setLiveHint("warn", "Too dark');
    const cutAt = cameraJs.indexOf('setLiveHint("warn", "Move back');
    expect(darkAt).toBeGreaterThan(-1);
    expect(darkAt).toBeLessThan(cutAt);
  });

  it('locks on visually once the document fills the frame', () => {
    // Green brackets + tick + a full-strength shutter are the "take it now" signal.
    expect(cameraJs).toContain('qcam-lockmark');
    expect(cameraJs).toContain('id="qcamLockMark"');
    expect(cameraJs).toContain('.qcam-locked .qcam-bracket{animation:qcamGlowOk');
    expect(cameraJs).toContain('.qcam-locked .qcam-capture{opacity:1;transform:scale(1.06);}');
    expect(cameraJs).toContain('.qcam-locked .qcam-lockmark{opacity:1;transform:translateX(-50%) scale(1);}');
    expect(cameraJs).toContain('Looks good — take the photo');
    expect(cameraJs).toContain('overlay.classList.toggle("qcam-locked", state === "ok")');
  });

  it('dims the shutter without ever disabling it', () => {
    // A doctor whose page the phone cannot measure still has to be able to shoot.
    expect(cameraJs).toMatch(/\.qcam-capture\{[^}]*opacity:\.5/);
    expect(cameraJs).not.toMatch(/qcamCapture[^\n]*\.disabled\s*=/);
    // The dimming is opacity only — the button must still take a tap.
    expect(cameraJs).not.toMatch(/\.qcam-capture\{[^}]*pointer-events:\s*none/);
  });

  it('stays neutral — not green — on a scene it could not measure', () => {
    // "unknown" must never show a tick: that would be a guess dressed as a check.
    expect(cameraJs).toContain('else if (framing.code === "ok") setLiveHint("ok", "Looks good — take the photo");');
    expect(cameraJs).toContain('else setLiveHint("idle", "Hold steady");');
    expect(cameraJs).toContain('setLiveHint("idle", "Checking the frame…")');
  });

  it('does not leave the first warning\'s wording on screen', () => {
    // Two different warnings share the "warn" state; keying the no-op check on
    // the state alone kept showing "Too dark" after the reason had changed.
    expect(cameraJs).toContain('var key = state + "|" + text;');
    expect(cameraJs).toContain('if (key === lastLiveState) return;');
  });

  it('asks before it accepts a badly framed shot — and never locks the doctor out', () => {
    // Both ways of getting it wrong stop for a look: too much background, and
    // the page running off the edge.
    expect(cameraJs).toContain('if (framing.code === "too_small" || framing.code === "cut_off") {');
    expect(cameraJs).toContain('showReview(blob, framing.code);');
    expect(cameraJs).toMatch(/REVIEW_COPY = \{[\s\S]*too_small:[\s\S]*cut_off:/);
    expect(cameraJs).toContain('Is the whole document in shot?');
    expect(cameraJs).toContain('id="qcamRetake"');
    // The measurement can be wrong, and a doctor who cannot get past their own
    // camera cannot finish onboarding at all.
    expect(cameraJs).toContain('id="qcamUseAnyway"');
    expect(cameraJs).toContain('function useReviewedPhoto()');
  });

  it('keeps the camera running for a retake and cleans up the preview', () => {
    expect(cameraJs).toContain('function retakePhoto()');
    expect(cameraJs).toContain('if (stream) startLiveHint();');
    expect(cameraJs).toContain('URL.revokeObjectURL(pendingPreviewUrl)');
    // A shot left under review must not resurface the next time the camera opens.
    expect(cameraJs).toContain('hideReview(); // a photo left under review');
  });
});

describe('cache busting', () => {
  it('ships the new camera, scan and onboarding bundles', () => {
    expect(cameraJs).toContain('measureFraming');
    const pagesDir = path.join(ROOT, 'pages');
    for (const file of fs.readdirSync(pagesDir).filter((f) => f.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(pagesDir, file), 'utf8');
      expect(html, file).not.toMatch(/qualification-camera\.js\?v=20260614a/);
      expect(html, file).not.toMatch(/qualification-scan\.js\?v=20260715a/);
    }
    expect(onboardingHtml).toContain('onboarding.js?v=20260801c');
  });
});

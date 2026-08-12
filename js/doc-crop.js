/* ═══════════════════════════════════════════════════════════════════════════
 * Document auto-crop — file the certificate, not the carpet.
 *
 * Doctors photograph a certificate lying on a desk, a bed or a kitchen floor
 * and send us the whole scene: Dr Ibrahim Fashola's CCT arrived as a page in
 * the middle of a beige carpet. The document is readable, so nothing stops it,
 * but every human who opens it afterwards — a Registration Support Officer, the
 * CEO, and eventually AHPRA — sees the carpet too.
 *
 * So before an image is scanned or stored, we find the page inside the photo
 * and trim everything else away:
 *
 *   1. AUTOMATIC, locally, in milliseconds and for free — Otsu threshold plus a
 *      flood fill for the largest page-shaped region, run in BOTH polarities so
 *      a dark diploma on a pale desk works as well as a white page on a dark one.
 *   2. AUTOMATIC, with AI, only when the local pass cannot tell (a white page on
 *      a white table). One small vision call to /api/ai/document-crop.
 *   3. MANUAL, always available — the crop sheet opens with the suggested box
 *      already drawn and the doctor drags the corners. This is the fallback the
 *      owner asked for when the automatic pass gets it wrong, and it is also the
 *      confirmation step: nothing is trimmed without the doctor seeing it first.
 *
 * Two rules run through all of it:
 *   • It NEVER blocks an upload. Any failure — a HEIC the browser cannot decode,
 *     no canvas, AI down, a detector that finds nothing — resolves the ORIGINAL
 *     file untouched. A doctor who cannot get past a crop step cannot finish
 *     onboarding, and background in a photo is a cosmetic problem.
 *   • It NEVER trims into the document. The detected page is padded outwards, a
 *     region that runs off the edge of the photo drops to "low confidence" (the
 *     sheet opens instead of cropping silently), and a photo that is already
 *     nothing but document is passed straight through.
 *
 * Public API (window.DocCrop):
 *   prepare(fileOrBlob, opts) -> Promise<File|Blob|null>
 *       The one call sites make. Resolves the file to upload — cropped, or the
 *       original — or null when the doctor cancels (caller should just stop).
 *       opts.label   what to call the document in the sheet
 *       opts.origin  "camera" crops silently (the camera already made the doctor
 *                    check the framing); anything else opens the sheet
 *       opts.ai      false to skip the AI fallback
 *       opts.force   always open the sheet, even when nothing needs trimming.
 *                    Used by staff on a document already on file: "I can see
 *                    background in this, let me crop it" has to be possible
 *                    whatever the detector thinks.
 *   detect(img)                -> the local detector's verdict (exported for tests)
 *   openEditor(...)            -> the manual sheet on its own
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";
  if (window.DocCrop) return;

  /* ── tunables ─────────────────────────────────────────────────────────────
   * Deliberately cautious. Every threshold here answers the same question: is
   * this REALLY the page? "I don't know" costs a doctor one drag of a corner.
   * Guessing wrong costs them a re-upload of a document that was fine.
   */
  var SAMPLE_W = 160;          // detector working width in px (a photo is huge; 160 is plenty)
  var MIN_LUM_SPREAD = 55;     // darkest-to-brightest: below this there is no edge to find
  var RING_FLAT_SPREAD = 18;   // a uniform border ring means a flat scan, not a photo of a desk
  var RING_MIN_MEAN = 170;     // ...and a pale one, so we are not calling a dark photo a scan
  var MIN_BOX_AREA = 0.06;     // a "page" smaller than 6% of the photo is not one we trust
  var MAX_BOX_AREA = 0.985;    // a region covering the whole photo tells us nothing
  var MIN_FILL = 0.62;         // page pixels ÷ its own box: a page is a solid rectangle
  var MIN_DOMINANCE = 0.45;    // the winner ÷ everything of that polarity — else it is clutter
  var EDGE_RUN = 0.30;         // share of a border the region hugs ⇒ it runs off the photo
  var HIGH_FILL = 0.72;        // above these two it is a page, and we may crop unattended
  var HIGH_DOMINANCE = 0.62;
  var HIGH_MAX_AREA = 0.90;
  var PAD = 0.02;              // safety margin left around the page, as a share of the photo
  var MIN_TRIM = 0.04;         // below this there is no background worth removing
  var MIN_RECT = 0.08;         // manual: the smallest crop side, as a share of the photo
  var AI_MAX_DIM = 1100;       // what the AI fallback is shown (a bounding box needs no detail)
  var OUT_MAX_DIM = 3200;      // ceiling on the cropped output's long edge
  var JPEG_QUALITY = 0.92;
  var DEFAULT_BOX = { left: 0.06, top: 0.06, right: 0.94, bottom: 0.94 };
  /* ── end tunables ── */

  var STYLE_ID = "gpDocCropStyle";
  var OVERLAY_ID = "gpDocCropOverlay";
  var sampleCanvas = null;

  /* ── geometry helpers (pure) ─────────────────────────────────────────────── */

  function clamp01(n) { return n < 0 ? 0 : (n > 1 ? 1 : n); }

  function boxArea(box) {
    if (!box) return 0;
    var w = box.right - box.left;
    var h = box.bottom - box.top;
    if (!(w > 0) || !(h > 0)) return 0;
    return w * h;
  }

  // Grow the box outwards by `pad` of the whole photo on every side, clamped to
  // the photo. Padding is the difference between "trimmed the background" and
  // "shaved the top line off a certificate".
  function padBox(box, pad) {
    if (!box) return null;
    var p = typeof pad === "number" ? pad : PAD;
    return {
      left: clamp01(box.left - p),
      top: clamp01(box.top - p),
      right: clamp01(box.right + p),
      bottom: clamp01(box.bottom + p)
    };
  }

  // A box is only worth acting on when it removes a real amount of background
  // AND still leaves a document-sized picture behind.
  function worthCropping(box) {
    var area = boxArea(box);
    return area >= MIN_BOX_AREA && area <= 1 - MIN_TRIM;
  }

  // Accept a box from anywhere (the AI, a caller, storage) only if it is sane.
  function sanitizeBox(raw) {
    if (!raw || typeof raw !== "object") return null;
    var left = Number(raw.left);
    var top = Number(raw.top);
    var right = Number(raw.right);
    var bottom = Number(raw.bottom);
    if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom)) return null;
    // Percentages (0-100) are an easy thing for a model to answer with.
    if (right > 1.5 || bottom > 1.5) { left /= 100; top /= 100; right /= 100; bottom /= 100; }
    var box = { left: clamp01(left), top: clamp01(top), right: clamp01(right), bottom: clamp01(bottom) };
    if (box.right - box.left < MIN_RECT || box.bottom - box.top < MIN_RECT) return null;
    if (boxArea(box) < MIN_BOX_AREA) return null;
    return box;
  }

  /* ── the local detector ───────────────────────────────────────────────────
   * Same machinery as the camera's live framing check (js/qualification-camera.js
   * measureFraming), but it returns WHERE the page is rather than whether it is
   * framed well, and it runs on both polarities so it is not limited to a light
   * page on a dark surface.
   */

  // Downscale the image into a small grey buffer. Uses an <img>/canvas, so the
  // browser has already applied EXIF orientation — the coordinates we return
  // therefore match what the doctor sees on screen, which is the only way the
  // manual sheet and the crop can agree.
  function sampleLuma(source) {
    var nw = (source && (source.naturalWidth || source.width)) || 0;
    var nh = (source && (source.naturalHeight || source.height)) || 0;
    if (!nw || !nh) return null;
    var w = Math.min(SAMPLE_W, nw);
    var h = Math.max(24, Math.round(w * (nh / nw)));
    var data;
    try {
      if (!sampleCanvas) sampleCanvas = document.createElement("canvas");
      if (sampleCanvas.width !== w || sampleCanvas.height !== h) {
        sampleCanvas.width = w;
        sampleCanvas.height = h;
      }
      var ctx = sampleCanvas.getContext("2d");
      ctx.drawImage(source, 0, 0, w, h);
      data = ctx.getImageData(0, 0, w, h).data;
    } catch (e) {
      return null; // no canvas, or a tainted / undecodable source
    }
    var total = w * h;
    var lum = new Uint8Array(total);
    for (var i = 0; i < total; i++) {
      var p = i * 4;
      lum[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) | 0;
    }
    return { lum: lum, w: w, h: h };
  }

  // The threshold that best splits the picture into "page" and "not page".
  function otsuThreshold(hist, total) {
    var sum = 0;
    for (var t = 0; t < 256; t++) sum += t * hist[t];
    var sumB = 0, wB = 0, best = 0, threshold = 128;
    for (var k = 0; k < 256; k++) {
      wB += hist[k];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += k * hist[k];
      var mB = sumB / wB;
      var mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; threshold = k; }
    }
    return threshold;
  }

  // Luminance statistics for a two-pixel ring around the edge of the picture.
  // A flat scan or a screenshot has a uniform pale border; a photo of a document
  // on a carpet, a desk or a duvet does not. This is what stops the crop sheet
  // appearing on top of a perfectly good PDF-style scan.
  function ringStats(lum, w, h) {
    var band = Math.max(1, Math.round(Math.min(w, h) * 0.03));
    var min = 255, max = 0, sum = 0, n = 0;
    for (var y = 0; y < h; y++) {
      var edgeRow = y < band || y >= h - band;
      for (var x = 0; x < w; x++) {
        if (!edgeRow && x >= band && x < w - band) continue;
        var v = lum[y * w + x];
        sum += v; n++;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!n) return { spread: 255, mean: 0 };
    return { spread: max - min, mean: sum / n };
  }

  // Largest connected region of the mask, with the numbers we need to judge
  // whether it is really a page. Iterative flood fill — a recursive one blows
  // the stack on a region that fills the frame.
  function largestRegion(mask, w, h) {
    var total = w * h;
    var maskCount = 0;
    for (var m = 0; m < total; m++) if (mask[m]) maskCount++;
    if (!maskCount) return null;

    var comp = new Int32Array(total);
    var stack = new Int32Array(total);
    var compId = 0, bestId = 0, bestSize = 0, bestBox = null;
    for (var s = 0; s < total; s++) {
      if (!mask[s] || comp[s]) continue;
      compId++;
      var top = 0;
      stack[top++] = s;
      comp[s] = compId;
      var size = 0, minX = w, maxX = -1, minY = h, maxY = -1;
      while (top > 0) {
        var idx = stack[--top];
        var x = idx % w;
        var y = (idx - x) / w;
        size++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x > 0 && mask[idx - 1] && !comp[idx - 1]) { comp[idx - 1] = compId; stack[top++] = idx - 1; }
        if (x < w - 1 && mask[idx + 1] && !comp[idx + 1]) { comp[idx + 1] = compId; stack[top++] = idx + 1; }
        if (y > 0 && mask[idx - w] && !comp[idx - w]) { comp[idx - w] = compId; stack[top++] = idx - w; }
        if (y < h - 1 && mask[idx + w] && !comp[idx + w]) { comp[idx + w] = compId; stack[top++] = idx + w; }
      }
      if (size > bestSize) {
        bestSize = size;
        bestId = compId;
        bestBox = { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
      }
    }
    if (!bestBox) return null;

    // How much of each border does the winner actually hug? A page that runs off
    // the photo hugs a border along most of its length; a corner grazing the edge
    // does not. Measured with component ids so only the winner counts.
    var runTop = 0, runBottom = 0, runLeft = 0, runRight = 0;
    for (var bx = 0; bx < w; bx++) {
      if (comp[bx] === bestId) runTop++;
      if (comp[(h - 1) * w + bx] === bestId) runBottom++;
    }
    for (var by = 0; by < h; by++) {
      if (comp[by * w] === bestId) runLeft++;
      if (comp[by * w + w - 1] === bestId) runRight++;
    }

    var boxW = bestBox.maxX - bestBox.minX + 1;
    var boxH = bestBox.maxY - bestBox.minY + 1;
    return {
      size: bestSize,
      box: bestBox,
      fill: bestSize / (boxW * boxH),          // solid rectangle, or a scatter?
      dominance: bestSize / maskCount,          // one page, or clutter?
      area: (boxW * boxH) / total,
      worstRun: Math.max(runTop / w, runBottom / w, runLeft / h, runRight / h)
    };
  }

  function regionToBox(region, w, h) {
    return {
      left: region.box.minX / w,
      top: region.box.minY / h,
      right: (region.box.maxX + 1) / w,
      bottom: (region.box.maxY + 1) / h
    };
  }

  // Does this region look enough like a page to use? Returns a score for
  // choosing between the light and dark candidates, or null to reject it.
  function scoreRegion(region) {
    if (!region) return null;
    if (region.area < MIN_BOX_AREA || region.area > MAX_BOX_AREA) return null;
    if (region.fill < MIN_FILL) return null;
    if (region.dominance < MIN_DOMINANCE) return null;
    return region.fill * (0.55 + 0.45 * region.dominance);
  }

  /**
   * Find the document inside a photo.
   *
   * @returns {Object} { found, box, confidence, reason, flatScan, coverage }
   *   box         normalized {left,top,right,bottom} of the page, unpadded
   *   confidence  "high" — safe to crop without asking
   *               "low"  — a suggestion for the sheet, not a decision
   *   reason      why nothing was found: "unreadable" | "flat" | "no-region"
   *   flatScan    true when this is a flat scan/screenshot rather than a photo
   *               of a document lying on something — nothing to trim
   */
  function detect(source) {
    var sampled = sampleLuma(source);
    if (!sampled) return { found: false, reason: "unreadable" };
    var lum = sampled.lum, w = sampled.w, h = sampled.h;
    var total = w * h;

    var hist = new Uint32Array(256);
    var min = 255, max = 0;
    for (var i = 0; i < total; i++) {
      var v = lum[i];
      hist[v]++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    var ring = ringStats(lum, w, h);
    var flatScan = ring.spread < RING_FLAT_SPREAD && ring.mean >= RING_MIN_MEAN;
    // No contrast anywhere: a flat scan, a screenshot, or a photo so dark or so
    // blown out that any "page" we drew would be invented.
    if (max - min < MIN_LUM_SPREAD) return { found: false, reason: "flat", flatScan: true };

    var threshold = otsuThreshold(hist, total);
    var bright = new Uint8Array(total);
    var dark = new Uint8Array(total);
    for (var b = 0; b < total; b++) {
      if (lum[b] > threshold) bright[b] = 1;
      else dark[b] = 1;
    }

    // Both polarities, then the more page-like of the two wins. A UK GMC
    // certificate on a carpet is the bright one; a dark-mounted diploma on a
    // white desk is the dark one, and before this it was invisible.
    var candidates = [largestRegion(bright, w, h), largestRegion(dark, w, h)];
    var best = null, bestScore = 0;
    for (var c = 0; c < candidates.length; c++) {
      var score = scoreRegion(candidates[c]);
      if (score !== null && score > bestScore) { bestScore = score; best = candidates[c]; }
    }
    if (!best) return { found: false, reason: "no-region", flatScan: flatScan, coverage: 0 };

    var confident = best.fill >= HIGH_FILL
      && best.dominance >= HIGH_DOMINANCE
      && best.area <= HIGH_MAX_AREA
      && best.worstRun <= EDGE_RUN;

    return {
      found: true,
      box: regionToBox(best, w, h),
      confidence: confident ? "high" : "low",
      coverage: best.area,
      flatScan: flatScan,
      fill: best.fill,
      dominance: best.dominance,
      worstRun: best.worstRun
    };
  }

  /* ── image loading & cropping ─────────────────────────────────────────────── */

  function isImage(fileOrBlob) {
    return !!fileOrBlob && /^image\//i.test(String(fileOrBlob.type || ""));
  }

  function loadImage(fileOrBlob) {
    return new Promise(function (resolve, reject) {
      var url;
      try { url = URL.createObjectURL(fileOrBlob); } catch (e) { reject(new Error("no_object_url")); return; }
      var img = new Image();
      img.onload = function () {
        if (!img.naturalWidth || !img.naturalHeight) {
          try { URL.revokeObjectURL(url); } catch (e) {}
          reject(new Error("empty_image"));
          return;
        }
        resolve({ img: img, url: url, release: function () { try { URL.revokeObjectURL(url); } catch (e) {} } });
      };
      // HEIC on a non-Safari browser lands here. The caller falls back to the
      // original file, which is exactly what happened before this module existed.
      img.onerror = function () {
        try { URL.revokeObjectURL(url); } catch (e) {}
        reject(new Error("decode_failed"));
      };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob); else reject(new Error("encode_failed"));
        }, mime, quality);
        return;
      }
      try {
        var parts = canvas.toDataURL(mime, quality).split(",");
        var bin = atob(parts[1]);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve(new Blob([bytes], { type: mime }));
      } catch (e) { reject(new Error("encode_failed")); }
    });
  }

  // PNG in, PNG out: a screenshot of a document is mostly flat colour and text,
  // and JPEG would put ringing around every letter. Everything else (including
  // HEIC/WEBP that decoded) comes back as JPEG, which is what a photo wants.
  function outputMime(inputMime) {
    return /png/i.test(String(inputMime || "")) ? "image/png" : "image/jpeg";
  }

  function cropToBlob(img, box, inputMime) {
    var nw = img.naturalWidth || img.width;
    var nh = img.naturalHeight || img.height;
    var sx = Math.max(0, Math.round(box.left * nw));
    var sy = Math.max(0, Math.round(box.top * nh));
    var sw = Math.min(nw - sx, Math.round((box.right - box.left) * nw));
    var sh = Math.min(nh - sy, Math.round((box.bottom - box.top) * nh));
    if (sw < 16 || sh < 16) return Promise.reject(new Error("crop_too_small"));

    var scale = Math.min(1, OUT_MAX_DIM / Math.max(sw, sh));
    var outW = Math.max(16, Math.round(sw * scale));
    var outH = Math.max(16, Math.round(sh * scale));
    var canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    var ctx = canvas.getContext("2d");
    if (!ctx) return Promise.reject(new Error("no_canvas"));
    var mime = outputMime(inputMime);
    if (mime === "image/jpeg") {
      // Without this, transparent PNG pixels encode to black in a JPEG.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, outW, outH);
    }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
    return canvasToBlob(canvas, mime, JPEG_QUALITY);
  }

  // Keep the doctor's file name (the RSO sees it) but move the extension to
  // whatever we actually encoded, so a .heic that came out as JPEG is not
  // mislabelled to every downstream reader.
  function renameForMime(name, mime) {
    var base = String(name || "document").replace(/\.[a-z0-9]{1,5}$/i, "");
    return base + (mime === "image/png" ? ".png" : ".jpg");
  }

  function toFile(blob, name, mime) {
    var fileName = renameForMime(name, mime);
    try { return new File([blob], fileName, { type: mime }); } catch (e) {}
    // Older Safari has no File constructor. The blob still uploads; give the
    // callers that read .name something to read.
    try { blob.name = fileName; } catch (e) {}
    return blob;
  }

  /* ── AI fallback ──────────────────────────────────────────────────────────
   * Only called when the local pass could not tell — a white certificate on a
   * white table is the case it exists for. One image, one bounding box back.
   */
  function downscaleForAi(img) {
    var nw = img.naturalWidth || img.width;
    var nh = img.naturalHeight || img.height;
    var scale = Math.min(1, AI_MAX_DIM / Math.max(nw, nh));
    var w = Math.max(1, Math.round(nw * scale));
    var h = Math.max(1, Math.round(nh * scale));
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    try { return canvas.toDataURL("image/jpeg", 0.82).split(",")[1] || ""; } catch (e) { return null; }
  }

  function requestAiBox(img) {
    var base64 = downscaleForAi(img);
    if (!base64) return Promise.resolve(null);
    return fetch("/api/ai/document-crop", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: base64, mimeType: "image/jpeg" })
    }).then(function (r) {
      return r.json().catch(function () { return null; });
    }).then(function (data) {
      if (!data || !data.ok || !data.found) return null;
      return sanitizeBox(data.box);
    }).catch(function () {
      return null; // AI down, offline, rate-limited — the sheet still works by hand
    });
  }

  /* ── the crop sheet (manual) ─────────────────────────────────────────────── */

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent =
      "#" + OVERLAY_ID + "{position:fixed;inset:0;z-index:100000;background:rgba(3,7,18,0.92);display:none;align-items:center;justify-content:center;padding:14px;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}" +
      "#" + OVERLAY_ID + ".open{display:flex;}" +
      ".dcrop-sheet{display:flex;flex-direction:column;width:100%;max-width:560px;max-height:100%;gap:10px;}" +
      ".dcrop-title{color:#fff;font-size:16px;font-weight:800;margin:0;}" +
      ".dcrop-sub{color:rgba(255,255,255,0.72);font-size:13px;line-height:1.45;margin:3px 0 0;}" +
      ".dcrop-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;}" +
      /* Sized in px by fitStage() — the crop box is positioned in % of this, so
         the box the doctor drags and the pixels we cut are the same rectangle. */
      ".dcrop-canvas{position:relative;overflow:hidden;border-radius:8px;background:#0b1220;touch-action:none;}" +
      ".dcrop-canvas img{display:block;width:100%;height:100%;-webkit-user-select:none;user-select:none;-webkit-user-drag:none;}" +
      /* box-sizing is stated OUTRIGHT, not inherited: with content-box the 2px
         border sits OUTSIDE the percentage box, so the line the doctor reads as
         the edge of the crop is ~2px away from where the pixels are actually
         cut — and whether it inherits content-box or border-box depends on
         which page the sheet opened on. */
      ".dcrop-rect{position:absolute;box-sizing:border-box;box-shadow:0 0 0 9999px rgba(3,7,18,0.62);border:2px solid #00e5ff;border-radius:3px;cursor:move;}" +
      ".dcrop-h{position:absolute;box-sizing:border-box;width:44px;height:44px;display:flex;align-items:center;justify-content:center;}" +
      ".dcrop-h::after{content:'';width:18px;height:18px;border:3px solid #00e5ff;background:rgba(3,7,18,0.35);border-radius:3px;}" +
      ".dcrop-h.tl{top:-22px;left:-22px;cursor:nwse-resize;}" +
      ".dcrop-h.tr{top:-22px;right:-22px;cursor:nesw-resize;}" +
      ".dcrop-h.bl{bottom:-22px;left:-22px;cursor:nesw-resize;}" +
      ".dcrop-h.br{bottom:-22px;right:-22px;cursor:nwse-resize;}" +
      ".dcrop-busy{position:absolute;left:0;right:0;bottom:0;padding:7px 10px;background:rgba(3,7,18,0.72);color:#fff;font-size:12px;text-align:center;}" +
      ".dcrop-foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;}" +
      ".dcrop-btn{border:1px solid rgba(255,255,255,0.28);background:rgba(255,255,255,0.06);color:#fff;border-radius:9px;padding:10px 14px;font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit;}" +
      ".dcrop-btn.primary{background:#00b8d4;border-color:#00b8d4;color:#04121a;}" +
      ".dcrop-btn.link{border-color:transparent;background:none;color:rgba(255,255,255,0.75);padding:10px 6px;}" +
      ".dcrop-foot .dcrop-spacer{flex:1;}" +
      "@media (max-width:520px){.dcrop-btn{flex:1 1 auto;text-align:center;}.dcrop-foot .dcrop-spacer{display:none;}}";
    document.head.appendChild(s);
  }

  function buildOverlay() {
    var existing = document.getElementById(OVERLAY_ID);
    if (existing) return existing;
    var el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.innerHTML =
      '<div class="dcrop-sheet">' +
        '<div>' +
          '<p class="dcrop-title" id="gpDocCropTitle">Trim the background</p>' +
          '<p class="dcrop-sub" id="gpDocCropSub"></p>' +
        '</div>' +
        '<div class="dcrop-stage" id="gpDocCropStage">' +
          '<div class="dcrop-canvas" id="gpDocCropCanvas">' +
            '<img id="gpDocCropImg" alt="Your document" />' +
            '<div class="dcrop-rect" id="gpDocCropRect">' +
              '<span class="dcrop-h tl" data-dcrop-handle="tl"></span>' +
              '<span class="dcrop-h tr" data-dcrop-handle="tr"></span>' +
              '<span class="dcrop-h bl" data-dcrop-handle="bl"></span>' +
              '<span class="dcrop-h br" data-dcrop-handle="br"></span>' +
            '</div>' +
            '<div class="dcrop-busy" id="gpDocCropBusy" style="display:none;">Looking for the document…</div>' +
          '</div>' +
        '</div>' +
        '<div class="dcrop-foot">' +
          '<button type="button" class="dcrop-btn link" data-dcrop="cancel">Cancel</button>' +
          '<span class="dcrop-spacer"></span>' +
          '<button type="button" class="dcrop-btn" data-dcrop="full">Use whole photo</button>' +
          '<button type="button" class="dcrop-btn primary" data-dcrop="crop">Use this crop</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    return el;
  }

  /**
   * The manual sheet. Resolves { action, box } where action is
   * "crop" | "full" | "cancel". Always resolves — never rejects — so a caller
   * can treat it as a straight choice.
   */
  function openEditor(opts) {
    injectStyles();
    var o = opts || {};
    var overlay = buildOverlay();
    var imgEl = document.getElementById("gpDocCropImg");
    var canvasEl = document.getElementById("gpDocCropCanvas");
    var rectEl = document.getElementById("gpDocCropRect");
    var stageEl = document.getElementById("gpDocCropStage");
    var subEl = document.getElementById("gpDocCropSub");
    var busyEl = document.getElementById("gpDocCropBusy");
    var titleEl = document.getElementById("gpDocCropTitle");

    var suggested = sanitizeBox(o.box) || DEFAULT_BOX;
    var rect = { left: suggested.left, top: suggested.top, right: suggested.right, bottom: suggested.bottom };
    var ratio = (o.img.naturalHeight || o.img.height) / (o.img.naturalWidth || o.img.width);

    titleEl.textContent = o.title || "Trim the background";
    subEl.textContent = o.subtitle || "";
    imgEl.src = o.url;
    busyEl.style.display = o.busy ? "block" : "none";

    function renderRect() {
      rectEl.style.left = (rect.left * 100) + "%";
      rectEl.style.top = (rect.top * 100) + "%";
      rectEl.style.width = ((rect.right - rect.left) * 100) + "%";
      rectEl.style.height = ((rect.bottom - rect.top) * 100) + "%";
    }

    // The crop box is a percentage of the canvas, so the canvas must be exactly
    // the size of the displayed picture — letterboxing inside it would put the
    // box somewhere the pixels are not.
    function fitStage() {
      var availW = stageEl.clientWidth || overlay.clientWidth || 320;
      var availH = stageEl.clientHeight || Math.round((overlay.clientHeight || 480) * 0.7);
      var w = Math.min(availW, availH / ratio);
      if (!(w > 0)) w = availW;
      canvasEl.style.width = Math.round(w) + "px";
      canvasEl.style.height = Math.round(w * ratio) + "px";
      renderRect();
    }

    return new Promise(function (resolve) {
      var drag = null;

      function pointerPos(ev) {
        var b = canvasEl.getBoundingClientRect();
        return {
          x: b.width ? clamp01((ev.clientX - b.left) / b.width) : 0,
          y: b.height ? clamp01((ev.clientY - b.top) / b.height) : 0
        };
      }

      function onDown(ev) {
        var handleEl = ev.target && ev.target.closest ? ev.target.closest("[data-dcrop-handle]") : null;
        var onRect = ev.target === rectEl || (ev.target && ev.target.parentNode === rectEl);
        if (!handleEl && !onRect) return;
        ev.preventDefault();
        drag = {
          handle: handleEl ? handleEl.getAttribute("data-dcrop-handle") : "move",
          start: pointerPos(ev),
          from: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        document.addEventListener("pointercancel", onUp);
      }

      function onMove(ev) {
        if (!drag) return;
        ev.preventDefault();
        var p = pointerPos(ev);
        var dx = p.x - drag.start.x;
        var dy = p.y - drag.start.y;
        var f = drag.from;
        if (drag.handle === "move") {
          var w = f.right - f.left;
          var h = f.bottom - f.top;
          var left = Math.min(Math.max(0, f.left + dx), 1 - w);
          var top = Math.min(Math.max(0, f.top + dy), 1 - h);
          rect = { left: left, top: top, right: left + w, bottom: top + h };
        } else {
          var left2 = f.left, top2 = f.top, right2 = f.right, bottom2 = f.bottom;
          if (drag.handle === "tl" || drag.handle === "bl") left2 = Math.min(clamp01(f.left + dx), f.right - MIN_RECT);
          if (drag.handle === "tr" || drag.handle === "br") right2 = Math.max(clamp01(f.right + dx), f.left + MIN_RECT);
          if (drag.handle === "tl" || drag.handle === "tr") top2 = Math.min(clamp01(f.top + dy), f.bottom - MIN_RECT);
          if (drag.handle === "bl" || drag.handle === "br") bottom2 = Math.max(clamp01(f.bottom + dy), f.top + MIN_RECT);
          rect = { left: left2, top: top2, right: right2, bottom: bottom2 };
        }
        renderRect();
      }

      function onUp() {
        drag = null;
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
      }

      /* Deliberately NO Escape-to-cancel. This sheet opens on top of pages that
       * already have their own document-level Escape handler (the scan modal
       * closes on Escape), and one key press cannot be stopped from reaching
       * both — so Escape would cancel the crop AND shut the modal underneath it.
       * The Cancel button is the way out. */

      function onClick(ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest("[data-dcrop]") : null;
        if (!btn) return;
        var action = btn.getAttribute("data-dcrop");
        if (action === "crop") finish("crop");
        else if (action === "full") finish("full");
        else finish("cancel");
      }

      var finished = false;
      function finish(action) {
        if (finished) return;
        finished = true;
        canvasEl.removeEventListener("pointerdown", onDown);
        overlay.removeEventListener("click", onClick);
        window.removeEventListener("resize", fitStage);
        window.removeEventListener("orientationchange", fitStage);
        onUp();
        overlay.classList.remove("open");
        imgEl.src = "";
        activeEditor = null;
        resolve({ action: action, box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } });
      }

      canvasEl.addEventListener("pointerdown", onDown);
      overlay.addEventListener("click", onClick);
      window.addEventListener("resize", fitStage);
      window.addEventListener("orientationchange", fitStage);

      overlay.classList.add("open");
      fitStage();
      // A second pass once the browser has laid the sheet out — on a phone the
      // first measurement can land before the stage has its final height.
      setTimeout(fitStage, 30);

      activeEditor = {
        // Lets prepare() drop a late AI suggestion into an already-open sheet
        // instead of making the doctor wait on a spinner before they can drag.
        suggest: function (box) {
          var clean = sanitizeBox(box);
          busyEl.style.display = "none";
          if (!clean || finished || drag) return;
          rect = { left: clean.left, top: clean.top, right: clean.right, bottom: clean.bottom };
          renderRect();
          if (subEl) subEl.textContent = o.suggestedSubtitle || subEl.textContent;
        },
        doneLooking: function () { busyEl.style.display = "none"; }
      };
    });
  }

  var activeEditor = null;

  /* ── the one call sites make ─────────────────────────────────────────────── */

  function describe(label) {
    return label ? String(label) : "document";
  }

  /**
   * Crop a document photo before it is scanned or stored.
   *
   * Resolves the file to upload (cropped or original), or null when the doctor
   * cancelled. Never rejects: on any internal failure the ORIGINAL file comes
   * back, because a cosmetic crop must never be the reason a doctor cannot file
   * their qualification.
   */
  function prepare(fileOrBlob, opts) {
    var o = opts || {};
    if (!fileOrBlob) return Promise.resolve(fileOrBlob);
    // PDFs, Word documents and anything else: nothing to crop, and the scan
    // pipeline treats them differently anyway.
    if (!isImage(fileOrBlob)) return Promise.resolve(fileOrBlob);
    if (typeof document === "undefined" || !document.createElement) return Promise.resolve(fileOrBlob);

    var silent = o.origin === "camera";
    var force = o.force === true;
    var loaded = null;

    return loadImage(fileOrBlob).then(function (l) {
      loaded = l;
      var verdict = detect(l.img);
      var padded = verdict.found ? padBox(verdict.box, PAD) : null;

      // Already nothing but document — a flat scan, a screenshot, or a photo
      // taken properly. Leave it completely alone: an extra step here would be
      // friction for the doctors who got it right. `force` overrides this for
      // staff, who are looking at the picture and can see what we cannot.
      if (!force && (verdict.flatScan || (padded && !worthCropping(padded)))) {
        return fileOrBlob;
      }

      // Confident and worth doing: crop it. For a camera capture that is the end
      // of it (the camera already made them confirm the framing); for a file
      // upload we still show it, pre-cropped, so they can see and adjust.
      if (!force && verdict.found && verdict.confidence === "high" && worthCropping(padded)) {
        if (silent) return cropToBlob(l.img, padded, fileOrBlob.type).then(function (blob) {
          return toFile(blob, fileOrBlob.name, outputMime(fileOrBlob.type));
        });
        return runEditor(l, fileOrBlob, padded, o, false);
      }

      // Not sure. A camera capture is left alone (it was framed in the A4
      // viewfinder); an uploaded photo goes to the sheet, and the AI is asked
      // for a box while the doctor is already looking at it. A forced (staff)
      // crop always lands here, and only pays for the AI when the local pass
      // has nothing useful to suggest.
      if (silent && !force) return fileOrBlob;
      var localBoxIsGood = verdict.found && verdict.confidence === "high" && worthCropping(padded);
      return runEditor(l, fileOrBlob, padded, o, o.ai !== false && !localBoxIsGood);
    }).then(function (result) {
      if (loaded) loaded.release();
      return result;
    }).catch(function () {
      if (loaded) loaded.release();
      return fileOrBlob; // decode failed (e.g. HEIC on Android) — upload as-is
    });
  }

  function runEditor(loaded, fileOrBlob, suggestedBox, o, askAi) {
    var label = describe(o.label);
    var sheet = openEditor({
      img: loaded.img,
      url: loaded.url,
      box: suggestedBox,
      busy: askAi,
      title: suggestedBox ? "Does this look right?" : "Trim the background",
      subtitle: suggestedBox
        ? "We have drawn a box around your " + label + " — everything outside it will not be sent. Drag the corners if it is not quite right."
        : "Drag the corners so the box sits around your " + label + ", then use this crop.",
      suggestedSubtitle: "We found your " + label + " — drag the corners if the box is not quite right."
    });
    var editor = activeEditor;
    if (askAi) {
      requestAiBox(loaded.img).then(function (aiBox) {
        if (!editor) return;
        if (aiBox && worthCropping(padBox(aiBox, PAD))) editor.suggest(padBox(aiBox, PAD));
        else editor.doneLooking();
      }).catch(function () { if (editor) editor.doneLooking(); });
    }
    return sheet.then(function (choice) {
      if (choice.action === "cancel") return null;
      if (choice.action === "full") return fileOrBlob;
      if (!worthCropping(choice.box)) return fileOrBlob; // they opened it right back up
      return cropToBlob(loaded.img, choice.box, fileOrBlob.type).then(function (blob) {
        return toFile(blob, fileOrBlob.name, outputMime(fileOrBlob.type));
      }).catch(function () { return fileOrBlob; });
    });
  }

  window.DocCrop = {
    prepare: prepare,
    detect: detect,
    openEditor: openEditor,
    cropToBlob: cropToBlob,
    padBox: padBox,
    worthCropping: worthCropping,
    sanitizeBox: sanitizeBox
  };
})();

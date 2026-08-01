(function () {
  "use strict";
  if (typeof document === "undefined") return;

  var STYLE_ID = "gpQualCameraStyle";
  var OVERLAY_ID = "gpQualCameraOverlay";

  var stream = null;
  var onCaptureCallback = null;
  var currentDocLabel = "";
  var liveTimer = null;
  var framingCanvas = null;
  var lastLiveState = "";
  var pendingBlob = null;
  var pendingPreviewUrl = "";
  var pendingReason = "";

  /*
   * Framing check. Doctors photograph a certificate lying on a desk and send us a
   * picture that is mostly desk — or worse, one with a keyboard resting on the
   * page. The scan endpoints reject those (applyPhotoFramingPolicy in server.js),
   * but a round trip to the model to be told "move closer" is a poor way to find
   * out, so the camera makes the same judgement locally, live and for free.
   *
   * The measurement is deliberately timid. It looks for one bright, page-shaped
   * region against a darker surround and reports how much of the frame it covers;
   * anything it cannot read confidently comes back "unknown" and is waved through.
   * It never blocks a capture — at worst it asks "is this the photo you meant?"
   * and offers a retake. The model remains the actual gate.
   */
  var FRAMING_MIN_COVERAGE = 0.55; // page bounding box vs the captured frame
  var FRAMING_MIN_FILL = 0.55;     // page pixels vs its own bounding box (is it page-shaped?)
  var FRAMING_EDGE_RUN = 0.25;     // share of a border the page must hug to count as running off it
  var FRAMING_SAMPLE_W = 64;       // long enough to measure, small enough to be free

  /*
   * A4 portrait, because that is what a medical certificate is.
   *
   * The viewfinder used to be a fixed inset box in a short, wide preview strip,
   * so an A4 certificate could not fit inside it: the doctor saw the top and
   * bottom of their degree cropped away while the guidance said "looks good".
   * The frame is now the real A4 ratio and the photo is cropped to it, so what
   * is inside the brackets is exactly what gets sent.
   */
  var A4_RATIO = 1.414; // height ÷ width

  /*
   * ...and we capture a little BEYOND the brackets. A doctor who lines the page
   * up neatly with the frame would otherwise be millimetres from losing an edge,
   * and "the page touches the border" would be indistinguishable from "the page
   * runs off it" — which is the check that catches a cut-off certificate.
   */
  var CAPTURE_BLEED = 0.06; // of the frame size, on every side

  /*
   * Per-document camera guidance. Keyed by the document key used in
   * COUNTRY_DOCS (see pages/my-documents.html). Resolution order:
   *   explicit key  ->  _certifiedDefault (when requireCert)  ->  _plainDefault
   * Wording is intentionally plain so it can be tuned without touching logic.
   */
  // Framing is far and away the most common reason a photo has to be redone, so
  // it leads every checklist rather than sitting third in one of them. Capped at
  // three on screen: the list used to take half the phone, squeezing the preview
  // into the strip that made an A4 page impossible to frame.
  var MAX_TIPS = 3;
  var FRAMING_TIPS = [
    "Line the page up inside the frame",
    "Nothing resting on it: no keyboard, phone or fingers"
  ];
  var CERT_TIP = "The certifier's stamp, signature & “true copy” line show";
  var SCAN_TIPS = {
    _plainDefault: [
      "Show your full name and the document date"
    ],
    primary_medical_degree: [
      "Your full name is clear and matches your account"
    ],
    criminal_history: [
      "Show the reference number (e.g. FIT1234567)"
    ]
  };

  function resolveTips(docKey, requireCert) {
    var specific = (docKey && SCAN_TIPS[docKey]) ? SCAN_TIPS[docKey].slice() : SCAN_TIPS._plainDefault.slice();
    // A certified true copy has one extra thing that must be in shot, and it
    // outranks the generic line.
    if (requireCert) specific.unshift(CERT_TIP);
    return FRAMING_TIPS.concat(specific).slice(0, MAX_TIPS);
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent =
      "#" + OVERLAY_ID + "{position:fixed;inset:0;z-index:10000;background:#000;display:none;}" +
      "#" + OVERLAY_ID + ".open{display:block;}" +
      /* The camera fills the whole screen — the old layout gave it a short strip
         above a solid black slab, which is what cropped the certificate. */
      ".qcam-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}" +
      ".qcam-ui{position:absolute;inset:0;display:flex;flex-direction:column;}" +
      ".qcam-frame-area{flex:1;display:flex;align-items:center;justify-content:center;padding:56px 16px 8px;min-height:0;}" +
      /* A4 portrait viewfinder. Everything outside it is dimmed by one huge
         box-shadow, so the eye goes where the page has to sit. */
      // Width/height are set in pixels by sizeViewfinder() on open and on every
      // resize. aspect-ratio alone was not enough: with an explicit height, a
      // max-width clamp shrank the width and left the height where it was, so
      // the frame came out at 1.80 instead of A4's 1.414 — the very shape error
      // this was meant to fix.
      ".qcam-viewfinder{position:relative;aspect-ratio:1 / " + A4_RATIO + ";pointer-events:none;box-shadow:0 0 0 9999px rgba(0,0,0,0.55);border-radius:6px;}" +
      ".qcam-bracket{position:absolute;width:34px;height:34px;}" +
      ".qcam-bracket.tl{top:0;left:0;border-top:3px solid #00e5ff;border-left:3px solid #00e5ff;border-radius:4px 0 0 0;}" +
      ".qcam-bracket.tr{top:0;right:0;border-top:3px solid #00e5ff;border-right:3px solid #00e5ff;border-radius:0 4px 0 0;}" +
      ".qcam-bracket.bl{bottom:0;left:0;border-bottom:3px solid #00e5ff;border-left:3px solid #00e5ff;border-radius:0 0 0 4px;}" +
      ".qcam-bracket.br{bottom:0;right:0;border-bottom:3px solid #00e5ff;border-right:3px solid #00e5ff;border-radius:0 0 4px 0;}" +
      /* Scanning sweep, inside the frame only */
      ".qcam-scanline{position:absolute;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#00e5ff,transparent);animation:qcamScan 2.5s ease-in-out infinite;}" +
      "@keyframes qcamScan{0%{top:2%}50%{top:96%}100%{top:2%}}" +
      /* Top document label pill */
      ".qcam-toplabel{position:absolute;top:14px;left:16px;right:64px;z-index:8;display:flex;justify-content:center;pointer-events:none;}" +
      ".qcam-pill{display:inline-flex;align-items:center;gap:8px;max-width:100%;background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.18);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);padding:8px 13px;border-radius:999px;color:#fff;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:700;}" +
      ".qcam-pill-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
      ".qcam-pill-badge{flex:0 0 auto;font-size:10px;font-weight:800;letter-spacing:.03em;color:#fde68a;background:rgba(251,191,36,0.18);padding:2px 8px;border-radius:999px;}" +
      ".qcam-pill-badge[hidden]{display:none;}" +
      /* Bottom controls: translucent glass over the live picture, not a black slab */
      ".qcam-bottom{flex:0 0 auto;padding:10px 16px calc(env(safe-area-inset-bottom,10px) + 12px);text-align:center;background:linear-gradient(to bottom,rgba(2,6,14,0) 0%,rgba(2,6,14,0.55) 38%,rgba(2,6,14,0.8) 100%);}" +
      ".qcam-tipcard{background:rgba(15,23,42,0.34);border:1px solid rgba(255,255,255,0.16);backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);border-radius:16px;padding:11px 13px;margin-bottom:10px;text-align:left;}" +
      ".qcam-tip-head{font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#7dd3fc;margin-bottom:7px;font-family:'DM Sans',sans-serif;}" +
      ".qcam-tips{list-style:none;margin:0;padding:0;}" +
      ".qcam-tips li{display:flex;align-items:flex-start;gap:8px;color:#f8fafc;font-size:12px;font-weight:600;line-height:1.3;margin-bottom:6px;font-family:'DM Sans',sans-serif;text-shadow:0 1px 2px rgba(0,0,0,0.5);}" +
      ".qcam-tips li:last-child{margin-bottom:0;}" +
      ".qcam-tips li::before{content:'\\2713';flex:0 0 auto;width:15px;height:15px;border-radius:50%;background:rgba(0,229,255,0.22);color:#00e5ff;font-size:9px;font-weight:800;display:flex;align-items:center;justify-content:center;margin-top:1px;}" +
      /* Live hint chip — neutral by default ("we cannot tell"), green only once we
         have measured a well-framed page, amber when something is actually wrong. */
      ".qcam-live{display:inline-flex;align-items:center;gap:7px;font-family:'DM Sans',sans-serif;font-size:11.5px;font-weight:700;padding:5px 11px;border-radius:999px;margin-bottom:10px;background:rgba(148,163,184,0.22);border:1px solid rgba(148,163,184,0.4);color:#e2e8f0;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);transition:background .2s,border-color .2s,color .2s;}" +
      ".qcam-live.ok{background:rgba(22,163,74,0.3);border-color:rgba(34,197,94,0.55);color:#bbf7d0;}" +
      ".qcam-live.warn{background:rgba(180,120,10,0.32);border-color:rgba(251,191,36,0.55);color:#fde68a;}" +
      ".qcam-live-dot{width:7px;height:7px;border-radius:50%;background:#94a3b8;}" +
      ".qcam-live.ok .qcam-live-dot{background:#22c55e;animation:qcamPulse 1.6s infinite;}" +
      ".qcam-live.warn .qcam-live-dot{background:#f59e0b;animation:qcamPulse 1.6s infinite;}" +
      "@keyframes qcamPulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.5)}70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}" +
      /* Shutter: dimmed until the framing reads good — but never disabled. */
      ".qcam-capture{width:64px;height:64px;border-radius:50%;border:4px solid #fff;background:transparent;cursor:pointer;margin:0 auto;display:block;position:relative;opacity:.5;transition:opacity .2s,transform .2s;}" +
      "#" + OVERLAY_ID + ".qcam-locked .qcam-capture{opacity:1;transform:scale(1.06);}" +
      ".qcam-capture::after{content:'';position:absolute;inset:4px;border-radius:50%;background:#fff;transition:transform 0.15s;}" +
      ".qcam-capture:active::after{transform:scale(0.85);}" +
      /* Lock-on tick, centred on the frame's bottom edge, clear of the brackets */
      ".qcam-lockmark{position:absolute;left:50%;bottom:-18px;width:36px;height:36px;border-radius:50%;background:#22c55e;color:#04240f;display:flex;align-items:center;justify-content:center;font-size:19px;font-weight:900;font-family:'DM Sans',sans-serif;opacity:0;transform:translateX(-50%) scale(0.6);transition:opacity .18s ease,transform .18s ease;box-shadow:0 0 0 4px rgba(34,197,94,0.25);}" +
      "#" + OVERLAY_ID + ".qcam-locked .qcam-lockmark{opacity:1;transform:translateX(-50%) scale(1);}" +
      /* Close button */
      ".qcam-close{position:absolute;top:14px;right:16px;z-index:10;width:40px;height:40px;border-radius:50%;border:none;background:rgba(0,0,0,0.5);color:#fff;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:'DM Sans',sans-serif;}" +
      /* "Check your photo" gate */
      ".qcam-review{position:absolute;inset:0;z-index:12;background:rgba(3,7,18,0.95);display:none;flex-direction:column;align-items:center;justify-content:center;padding:24px 20px calc(env(safe-area-inset-bottom,12px) + 24px);text-align:center;}" +
      ".qcam-review.open{display:flex;}" +
      ".qcam-review-img{max-width:100%;max-height:44vh;border-radius:12px;border:1px solid rgba(255,255,255,0.18);object-fit:contain;}" +
      ".qcam-review-title{margin-top:18px;color:#fff;font-family:'DM Sans',sans-serif;font-size:17px;font-weight:800;}" +
      ".qcam-review-text{margin:8px 0 0;max-width:340px;color:#cbd5e1;font-family:'DM Sans',sans-serif;font-size:13.5px;font-weight:600;line-height:1.45;}" +
      ".qcam-review-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:20px;}" +
      ".qcam-btn{font-family:'DM Sans',sans-serif;font-size:14px;font-weight:800;padding:12px 22px;border-radius:999px;cursor:pointer;border:1px solid transparent;}" +
      ".qcam-btn.primary{background:#00e5ff;color:#04202a;}" +
      ".qcam-btn.ghost{background:transparent;color:#e2e8f0;border-color:rgba(255,255,255,0.28);}" +
      /* Glow animation on brackets */
      ".qcam-bracket{animation:qcamGlow 2s ease-in-out infinite alternate;}" +
      "@keyframes qcamGlow{0%{border-color:#00e5ff;filter:drop-shadow(0 0 4px #00e5ff)}100%{border-color:#00bcd4;filter:drop-shadow(0 0 8px #00e5ff)}}" +
      /* Locked on: the brackets snap green and the scanning sweep stops hunting */
      "#" + OVERLAY_ID + ".qcam-locked .qcam-bracket{animation:qcamGlowOk 1.6s ease-in-out infinite alternate;}" +
      "@keyframes qcamGlowOk{0%{border-color:#22c55e;filter:drop-shadow(0 0 5px #22c55e)}100%{border-color:#4ade80;filter:drop-shadow(0 0 10px #22c55e)}}" +
      "#" + OVERLAY_ID + ".qcam-locked .qcam-scanline{opacity:0;}";
    document.head.appendChild(s);
  }

  function getOverlay() {
    var el = document.getElementById(OVERLAY_ID);
    if (el) return el;

    el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.innerHTML =
      '<video class="qcam-video" id="qcamVideo" autoplay playsinline muted></video>' +
      '<div class="qcam-ui">' +
        '<div class="qcam-frame-area">' +
          '<div class="qcam-viewfinder" id="qcamViewfinder">' +
            '<div class="qcam-bracket tl"></div>' +
            '<div class="qcam-bracket tr"></div>' +
            '<div class="qcam-bracket bl"></div>' +
            '<div class="qcam-bracket br"></div>' +
            '<div class="qcam-scanline"></div>' +
            '<div class="qcam-lockmark" id="qcamLockMark" aria-hidden="true">&#10003;</div>' +
          '</div>' +
        '</div>' +
        '<div class="qcam-bottom">' +
          '<div class="qcam-tipcard">' +
            '<div class="qcam-tip-head" id="qcamTipHead">For a clear scan</div>' +
            '<ul class="qcam-tips" id="qcamTips"></ul>' +
          '</div>' +
          '<div class="qcam-live" id="qcamLive"><span class="qcam-live-dot"></span><span id="qcamLiveText">Checking the frame…</span></div>' +
          '<button class="qcam-capture" id="qcamCapture" type="button" aria-label="Capture photo"></button>' +
        '</div>' +
      '</div>' +
      '<div class="qcam-toplabel">' +
        '<span class="qcam-pill">' +
          '<span class="qcam-pill-name" id="qcamPillName"></span>' +
          '<span class="qcam-pill-badge" id="qcamPillBadge" hidden>CERTIFIED COPY</span>' +
        '</span>' +
      '</div>' +
      '<button class="qcam-close" id="qcamClose" type="button">&times;</button>' +
      '<div class="qcam-review" id="qcamReview">' +
        '<img class="qcam-review-img" id="qcamReviewImg" alt="The photo you just took" />' +
        '<div class="qcam-review-title" id="qcamReviewTitle">Is the whole document in shot?</div>' +
        '<p class="qcam-review-text" id="qcamReviewText"></p>' +
        '<div class="qcam-review-actions">' +
          '<button class="qcam-btn primary" id="qcamRetake" type="button">Retake photo</button>' +
          '<button class="qcam-btn ghost" id="qcamUseAnyway" type="button">Use this photo</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);

    document.getElementById("qcamClose").addEventListener("click", closeCamera);
    document.getElementById("qcamCapture").addEventListener("click", capturePhoto);
    document.getElementById("qcamRetake").addEventListener("click", retakePhoto);
    document.getElementById("qcamUseAnyway").addEventListener("click", useReviewedPhoto);

    return el;
  }

  /**
   * Open the camera.
   * @param {string|Object} arg  Either a plain document label (legacy callers)
   *   or an options object: { docLabel, docKey, requireCert, tips }.
   * @param {Function} onCapture  (blob, errorOrNull) callback.
   */
  function openCamera(arg, onCapture) {
    injectStyles();
    var overlay = getOverlay();

    var opts = (arg && typeof arg === "object") ? arg : { docLabel: arg };
    var docLabel = opts.docLabel || "Scan Document";
    var requireCert = !!opts.requireCert;
    var tips = (opts.tips && opts.tips.length) ? opts.tips.slice(0, MAX_TIPS) : resolveTips(opts.docKey, requireCert);

    currentDocLabel = docLabel;
    onCaptureCallback = onCapture;

    document.getElementById("qcamPillName").textContent = docLabel;
    var badge = document.getElementById("qcamPillBadge");
    if (badge) badge.hidden = !requireCert;

    var head = document.getElementById("qcamTipHead");
    if (head) head.textContent = requireCert ? "Sharp & inside the frame" : "For a clear scan";

    var list = document.getElementById("qcamTips");
    if (list) {
      list.innerHTML = "";
      for (var i = 0; i < tips.length; i++) {
        var li = document.createElement("li");
        li.textContent = tips[i];
        list.appendChild(li);
      }
    }

    hideReview(); // a photo left under review from a previous open must not reappear
    resetLiveHint();
    overlay.classList.add("open");
    sizeViewfinder(); // only measurable once the overlay is displayed

    var video = document.getElementById("qcamVideo");
    // Ask for as much detail as the device will give: the photo we send is only
    // the A4 crop out of this frame, so the source resolution is what decides
    // whether small print on a certificate survives.
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 2560 }, height: { ideal: 1920 } }
    })
    .then(function (s) {
      stream = s;
      video.srcObject = s;
      startLiveHint();
    })
    .catch(function (err) {
      console.error("[QualCamera] Camera access denied:", err);
      closeCamera();
      if (onCapture) onCapture(null, "Camera access was denied. To enable it, go to your browser settings and allow camera access for this site, or use the file upload option instead.");
    });
  }

  /**
   * Size the viewfinder to a true A4 portrait rectangle, as large as the space
   * allows. Done in JS because CSS `aspect-ratio` plus a max-width clamp left the
   * height untouched (a 1.80 frame instead of 1.414) — and the whole point of
   * this frame is that its shape matches the page.
   */
  function sizeViewfinder() {
    var area = document.querySelector("#" + OVERLAY_ID + " .qcam-frame-area");
    var frame = document.getElementById("qcamViewfinder");
    if (!area || !frame) return;
    var availableW = area.clientWidth;
    var availableH = area.clientHeight;
    if (!availableW || !availableH) return;
    var w = Math.min(availableW * 0.92, availableH / A4_RATIO);
    if (!(w > 0)) return;
    frame.style.width = Math.round(w) + "px";
    frame.style.height = Math.round(w * A4_RATIO) + "px";
  }

  /* ── What actually gets photographed ──────────────────────────────────────
   * The region of the camera frame that sits behind the A4 viewfinder, plus a
   * small bleed. Returns source-pixel coordinates for drawImage, or null when
   * the video is not ready (callers then fall back to the whole frame).
   */
  function getCaptureCrop(video) {
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    var frame = document.getElementById("qcamViewfinder");
    if (!frame) return null;
    var vRect = video.getBoundingClientRect();
    var fRect = frame.getBoundingClientRect();
    if (!vRect.width || !vRect.height || !fRect.width || !fRect.height) return null;

    var vw = video.videoWidth;
    var vh = video.videoHeight;
    // The preview is object-fit: cover — the source is scaled up until it covers
    // the element, and the overflow is trimmed evenly on both sides. Undo that to
    // find where the brackets fall on the actual camera frame.
    var scale = Math.max(vRect.width / vw, vRect.height / vh);
    var offX = vRect.left + (vRect.width - vw * scale) / 2;
    var offY = vRect.top + (vRect.height - vh * scale) / 2;

    var bleedX = fRect.width * CAPTURE_BLEED;
    var bleedY = fRect.height * CAPTURE_BLEED;
    var sx = (fRect.left - bleedX - offX) / scale;
    var sy = (fRect.top - bleedY - offY) / scale;
    var sw = (fRect.width + bleedX * 2) / scale;
    var sh = (fRect.height + bleedY * 2) / scale;

    // Never ask drawImage for pixels outside the frame.
    if (sx < 0) { sw += sx; sx = 0; }
    if (sy < 0) { sh += sy; sy = 0; }
    if (sx + sw > vw) sw = vw - sx;
    if (sy + sh > vh) sh = vh - sy;
    if (sw <= 8 || sh <= 8) return null;
    return { sx: sx, sy: sy, sw: sw, sh: sh };
  }

  function drawSource(ctx, source, crop, outW, outH) {
    if (crop) ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, outW, outH);
    else ctx.drawImage(source, 0, 0, outW, outH);
  }

  /* ── Local framing measurement (no AI) ────────────────────────────────────
   * Returns { code, coverage } where code is:
   *   "ok"        the page fills enough of the frame, with all of it inside
   *   "too_small" a page-shaped region was found and it is too small
   *   "cut_off"   the page runs off an edge — part of it is not in the photo
   *   "unknown"   nothing measurable — caller must treat this as a pass
   *
   * @param source  a video or canvas
   * @param crop    optional {sx,sy,sw,sh} — measure only what will be captured
   */
  function measureFraming(source, crop) {
    if (!source) return { code: "unknown", coverage: 0 };
    var w = FRAMING_SAMPLE_W;
    // Sample at the shape of the region we are judging, so a tall A4 crop is not
    // squashed into a landscape thumbnail before we measure it.
    var aspect = crop && crop.sw ? (crop.sh / crop.sw) : ((source.videoHeight && source.videoWidth) ? source.videoHeight / source.videoWidth : 0.75);
    var h = Math.max(32, Math.min(128, Math.round(w * aspect)));
    var data;
    try {
      if (!framingCanvas) framingCanvas = document.createElement("canvas");
      if (framingCanvas.width !== w || framingCanvas.height !== h) {
        framingCanvas.width = w;
        framingCanvas.height = h;
      }
      var ctx = framingCanvas.getContext("2d");
      drawSource(ctx, source, crop, w, h);
      data = ctx.getImageData(0, 0, w, h).data;
    } catch (e) {
      return { code: "unknown", coverage: 0 }; // not ready, or a tainted frame
    }

    var total = w * h;
    var lum = new Uint8Array(total);
    var hist = new Uint32Array(256);
    var min = 255, max = 0;
    for (var i = 0; i < total; i++) {
      var p = i * 4;
      var v = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) | 0;
      lum[i] = v;
      hist[v]++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    // A flat frame (all desk, all page, or a dark room) carries no edge to find.
    if (max - min < 60) return { code: "unknown", coverage: 0 };

    // Otsu: the threshold that best splits the frame into "page" and "not page".
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

    var brightCount = 0;
    var bright = new Uint8Array(total);
    for (var b = 0; b < total; b++) {
      if (lum[b] > threshold) { bright[b] = 1; brightCount++; }
    }
    var brightFraction = brightCount / total;
    // Almost everything is bright. That is either a page already filling the frame
    // or a white page on a white desk, and we cannot tell which — so say so. It
    // must NOT come back "ok": a green tick over a small page on a pale kitchen
    // table is a guess presented as a check, and it teaches doctors to trust the
    // tick. "unknown" is neutral and still never blocks the shutter.
    if (brightFraction > 0.9) return { code: "unknown", coverage: brightFraction };
    if (brightFraction < 0.06) return { code: "unknown", coverage: brightFraction };

    // Largest connected bright region — the page, if there is one. Iterative flood
    // fill: a recursive one blows the stack on a full-frame region. Component ids
    // are kept so the winner's contact with each border can be measured below.
    var comp = new Int32Array(total); // 0 = unvisited
    var stack = new Int32Array(total);
    var compId = 0, bestId = 0, bestSize = 0, bestBox = null;
    for (var s = 0; s < total; s++) {
      if (!bright[s] || comp[s]) continue;
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
        if (x > 0 && bright[idx - 1] && !comp[idx - 1]) { comp[idx - 1] = compId; stack[top++] = idx - 1; }
        if (x < w - 1 && bright[idx + 1] && !comp[idx + 1]) { comp[idx + 1] = compId; stack[top++] = idx + 1; }
        if (y > 0 && bright[idx - w] && !comp[idx - w]) { comp[idx - w] = compId; stack[top++] = idx - w; }
        if (y < h - 1 && bright[idx + w] && !comp[idx + w]) { comp[idx + w] = compId; stack[top++] = idx + w; }
      }
      if (size > bestSize) {
        bestSize = size;
        bestId = compId;
        bestBox = { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
      }
    }
    if (!bestBox) return { code: "unknown", coverage: 0 };

    var boxArea = (bestBox.maxX - bestBox.minX + 1) * (bestBox.maxY - bestBox.minY + 1);
    var coverage = boxArea / total;
    // If the biggest region is only a fraction of everything bright in the frame,
    // we are looking at clutter — a lamp, a window, a scatter of pale objects —
    // not at one page. Say nothing rather than call a highlight "the document".
    if (bestSize / brightCount < 0.4) return { code: "unknown", coverage: coverage };
    // A page is a solid rectangle. A scatter of bright specks that happens to span
    // the frame is not one, and we should not draw conclusions from it.
    if (bestSize / boxArea < FRAMING_MIN_FILL) return { code: "unknown", coverage: coverage };

    // Does the page run off an edge? This is the check that catches the failure
    // the owner reported: a certificate held too close reads as "filling the
    // frame" on coverage alone while its top and bottom are outside the photo.
    // Measured as the share of each border the page actually hugs, so a corner
    // grazing the edge is not mistaken for a page running past it.
    var runTop = 0, runBottom = 0, runLeft = 0, runRight = 0;
    for (var bx = 0; bx < w; bx++) {
      if (comp[bx] === bestId) runTop++;
      if (comp[(h - 1) * w + bx] === bestId) runBottom++;
    }
    for (var by = 0; by < h; by++) {
      if (comp[by * w] === bestId) runLeft++;
      if (comp[by * w + w - 1] === bestId) runRight++;
    }
    var worstRun = Math.max(runTop / w, runBottom / w, runLeft / h, runRight / h);
    if (worstRun > FRAMING_EDGE_RUN) return { code: "cut_off", coverage: coverage };

    return { code: coverage >= FRAMING_MIN_COVERAGE ? "ok" : "too_small", coverage: coverage };
  }

  /* ── Live guidance (local heuristics only — no AI) ─────────────────────────
   * Three states, and the difference between the last two matters:
   *   "ok"    measured, and the document sits inside the frame — lock on:
   *           brackets turn green, tick appears, shutter goes to full strength
   *   "warn"  measured, and something is wrong — amber, shutter dimmed
   *   "idle"  could not measure this scene (a white page on a white desk, a dark
   *           document, a frame that is already all page). Neutral, shutter
   *           dimmed, never blocked — "we cannot tell, your call" is honest,
   *           where a green tick would be a guess.
   * The shutter is only ever dimmed, never disabled: a doctor whose page the
   * phone cannot read still has to be able to take the photo.
   */
  function resetLiveHint() {
    lastLiveState = "";
    setLiveHint("idle", "Checking the frame…");
  }

  function setLiveHint(state, text) {
    // Keyed on state AND text: two different warnings share a state, and keying
    // on the state alone left the first one's wording on screen.
    var key = state + "|" + text;
    if (key === lastLiveState) return;
    lastLiveState = key;
    var live = document.getElementById("qcamLive");
    var txt = document.getElementById("qcamLiveText");
    if (txt) txt.textContent = text;
    if (live) {
      live.classList.toggle("warn", state === "warn");
      live.classList.toggle("ok", state === "ok");
    }
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.classList.toggle("qcam-locked", state === "ok");
  }

  function startLiveHint() {
    stopLiveHint();
    liveTimer = setInterval(sampleFrame, 800);
  }

  function stopLiveHint() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  }

  function sampleFrame() {
    var video = document.getElementById("qcamVideo");
    if (!video || !video.videoWidth) return;
    try {
      // Judge the region we are actually going to send, not the whole camera
      // frame: a dark room around a well-lit certificate is not "too dark".
      var crop = getCaptureCrop(video);
      var framing = measureFraming(video, crop);

      var ctx = framingCanvas && framingCanvas.getContext("2d");
      var avg = 0;
      if (ctx) {
        var d = ctx.getImageData(0, 0, framingCanvas.width, framingCanvas.height).data;
        var sum = 0, count = 0;
        for (var i = 0; i < d.length; i += 16) {
          sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          count++;
        }
        avg = count ? sum / count : 0;
      }

      // Lighting first: a frame that is too dark or blown out makes the framing
      // measurement unreliable, and it is the thing to fix before moving closer.
      if (avg && avg < 55) { setLiveHint("warn", "Too dark — find more light"); return; }
      if (avg && avg > 238) { setLiveHint("warn", "Too bright — reduce glare"); return; }

      if (framing.code === "cut_off") setLiveHint("warn", "Move back — the whole page must be inside the frame");
      else if (framing.code === "too_small") setLiveHint("warn", "Move closer — fill the frame with the document");
      else if (framing.code === "ok") setLiveHint("ok", "Looks good — take the photo");
      else setLiveHint("idle", "Hold steady");
    } catch (e) {
      // getImageData can throw on some tainted/!ready frames; ignore this tick
    }
  }

  function capturePhoto() {
    var video = document.getElementById("qcamVideo");
    if (!video || !video.videoWidth) return;

    // Capture exactly what the brackets framed (plus the bleed), so the photo the
    // doctor sends is the photo they lined up. Previously the whole camera frame
    // was saved while the preview showed a cropped strip of it — what you saw was
    // never what you got.
    var crop = getCaptureCrop(video);
    var srcW = crop ? crop.sw : video.videoWidth;
    var srcH = crop ? crop.sh : video.videoHeight;

    var maxDim = 1600; // detail for the AI, still far under the upload size cap
    var scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    var w = Math.max(1, Math.round(srcW * scale));
    var h = Math.max(1, Math.round(srcH * scale));

    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    drawSource(ctx, video, crop, w, h);

    // Judge the shot we actually took, not the last live frame.
    var framing = measureFraming(canvas, null);

    canvas.toBlob(function (blob) {
      if (!blob) {
        closeCamera();
        if (onCaptureCallback) onCaptureCallback(null, new Error("Could not capture image"));
        return;
      }
      if (framing.code === "too_small" || framing.code === "cut_off") {
        showReview(blob, framing.code);
        return;
      }
      acceptPhoto(blob);
    }, "image/jpeg", 0.85);
  }

  /* ── "Check your photo" gate ──────────────────────────────────────────────
   * Shown when the page does not sit properly inside the frame. It is a prompt,
   * not a lock: the measurement can be wrong (a dark certificate, a page on a
   * white desk), and a doctor who cannot get past their own camera has no way to
   * finish onboarding at all. "Retake" is the obvious choice; "Use this photo"
   * is there for when we called it wrong.
   */
  var REVIEW_COPY = {
    too_small: "There is a lot of background in this photo. Move closer so the document fills the frame, with nothing resting on top of it.",
    cut_off: "Part of the document looks like it is outside the photo. Move back a little and line all four corners up inside the frame."
  };

  function showReview(blob, reason) {
    clearPendingPreview();
    pendingBlob = blob;
    pendingReason = reason || "too_small";
    try { pendingPreviewUrl = URL.createObjectURL(blob); } catch (e) { pendingPreviewUrl = ""; }
    var img = document.getElementById("qcamReviewImg");
    if (img) img.src = pendingPreviewUrl;
    var text = document.getElementById("qcamReviewText");
    if (text) text.textContent = REVIEW_COPY[pendingReason] || REVIEW_COPY.too_small;
    var panel = document.getElementById("qcamReview");
    if (panel) panel.classList.add("open");
    stopLiveHint();
  }

  function hideReview() {
    var panel = document.getElementById("qcamReview");
    if (panel) panel.classList.remove("open");
    clearPendingPreview();
    pendingBlob = null;
    pendingReason = "";
  }

  function clearPendingPreview() {
    if (pendingPreviewUrl) {
      try { URL.revokeObjectURL(pendingPreviewUrl); } catch (e) {}
      pendingPreviewUrl = "";
    }
    var img = document.getElementById("qcamReviewImg");
    if (img) img.removeAttribute("src");
  }

  function retakePhoto() {
    hideReview();
    resetLiveHint();
    if (stream) startLiveHint();
  }

  function useReviewedPhoto() {
    var blob = pendingBlob;
    hideReview();
    if (blob) acceptPhoto(blob);
  }

  function acceptPhoto(blob) {
    closeCamera();
    if (onCaptureCallback) onCaptureCallback(blob, null);
  }

  function closeCamera() {
    stopLiveHint();
    hideReview();
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay) {
      overlay.classList.remove("open");
      overlay.classList.remove("qcam-locked");
    }
  }

  // Keep the frame A4 when the phone is turned or the toolbar slides away.
  window.addEventListener("resize", function () {
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay && overlay.classList.contains("open")) sizeViewfinder();
  });
  window.addEventListener("orientationchange", function () {
    setTimeout(sizeViewfinder, 250); // after the browser has settled the new size
  });

  // Stop camera stream if user navigates away or hides the page
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden" && stream) closeCamera();
  });
  window.addEventListener("pagehide", function () {
    if (stream) closeCamera();
  });

  // Expose globally. measureFraming and getCaptureCrop are exported so the
  // framing rules and the region that actually gets photographed can both be
  // exercised against a known frame, without standing in front of a camera.
  window.QualCamera = {
    open: openCamera,
    close: closeCamera,
    measureFraming: measureFraming,
    getCaptureCrop: getCaptureCrop
  };
})();

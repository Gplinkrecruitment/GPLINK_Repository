(function () {
  "use strict";
  if (typeof document === "undefined") return;

  var STYLE_ID = "gpQualCameraStyle";
  var OVERLAY_ID = "gpQualCameraOverlay";

  var stream = null;
  var onCaptureCallback = null;
  var currentDocLabel = "";
  var liveTimer = null;
  var sampleCanvas = null;
  var framingCanvas = null;
  var lastLiveState = "";
  var pendingBlob = null;
  var pendingPreviewUrl = "";

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
  var FRAMING_MIN_COVERAGE = 0.55; // page bounding box vs the whole frame
  var FRAMING_MIN_FILL = 0.55;     // page pixels vs its own bounding box (is it page-shaped?)
  var FRAMING_SAMPLE_W = 64;
  var FRAMING_SAMPLE_H = 48;

  /*
   * Per-document camera guidance. Keyed by the document key used in
   * COUNTRY_DOCS (see pages/my-documents.html). Resolution order:
   *   explicit key  ->  _certifiedDefault (when requireCert)  ->  _plainDefault
   * Wording is intentionally plain so it can be tuned without touching logic.
   */
  // Framing is far and away the most common reason a photo has to be redone, so
  // it leads every checklist rather than sitting third in one of them.
  var FRAMING_TIPS = [
    "The document fills the frame — nothing else in the photo",
    "Nothing resting on the page: no keyboard, phone or fingers"
  ];
  var CERT_TIP = "The certifier's stamp, signature & “true copy” line show";
  var SCAN_TIPS = {
    _certifiedDefault: [CERT_TIP],
    _plainDefault: [
      "Show your full name and the document date",
      "Even lighting, no glare across the page"
    ],
    primary_medical_degree: [
      "Your full name is clear and matches your account"
    ],
    criminal_history: [
      "Show the reference number (e.g. FIT1234567)",
      "Your full name and the issue date are readable"
    ]
  };

  function resolveTips(docKey, requireCert) {
    var specific = (docKey && SCAN_TIPS[docKey]) ? SCAN_TIPS[docKey].slice() : null;
    if (!specific) {
      return FRAMING_TIPS.concat(requireCert ? SCAN_TIPS._certifiedDefault : SCAN_TIPS._plainDefault);
    }
    // A per-document list still needs the certification line when the document is
    // one AHPRA wants as a certified true copy.
    if (requireCert && specific.indexOf(CERT_TIP) === -1) specific.push(CERT_TIP);
    return FRAMING_TIPS.concat(specific);
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent =
      "#" + OVERLAY_ID + "{position:fixed;inset:0;z-index:10000;background:#000;display:none;flex-direction:column;}" +
      "#" + OVERLAY_ID + ".open{display:flex;}" +
      ".qcam-video-wrap{flex:1;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;}" +
      ".qcam-video{width:100%;height:100%;object-fit:cover;}" +
      /* Viewfinder brackets */
      ".qcam-viewfinder{position:absolute;top:12%;left:8%;right:8%;bottom:25%;pointer-events:none;}" +
      ".qcam-bracket{position:absolute;width:36px;height:36px;}" +
      ".qcam-bracket.tl{top:0;left:0;border-top:3px solid #00e5ff;border-left:3px solid #00e5ff;border-radius:4px 0 0 0;}" +
      ".qcam-bracket.tr{top:0;right:0;border-top:3px solid #00e5ff;border-right:3px solid #00e5ff;border-radius:0 4px 0 0;}" +
      ".qcam-bracket.bl{bottom:0;left:0;border-bottom:3px solid #00e5ff;border-left:3px solid #00e5ff;border-radius:0 0 0 4px;}" +
      ".qcam-bracket.br{bottom:0;right:0;border-bottom:3px solid #00e5ff;border-right:3px solid #00e5ff;border-radius:0 0 4px 0;}" +
      /* Scanning line animation */
      ".qcam-scanline{position:absolute;left:8%;right:8%;height:2px;background:linear-gradient(90deg,transparent,#00e5ff,transparent);animation:qcamScan 2.5s ease-in-out infinite;}" +
      "@keyframes qcamScan{0%{top:12%}50%{top:65%}100%{top:12%}}" +
      /* Top document label pill */
      ".qcam-toplabel{position:absolute;top:18px;left:16px;right:64px;z-index:8;display:flex;justify-content:center;pointer-events:none;}" +
      ".qcam-pill{display:inline-flex;align-items:center;gap:8px;max-width:100%;background:rgba(0,0,0,0.55);border:1px solid rgba(255,255,255,0.16);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);padding:8px 13px;border-radius:999px;color:#fff;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:700;}" +
      ".qcam-pill-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
      ".qcam-pill-badge{flex:0 0 auto;font-size:10px;font-weight:800;letter-spacing:.03em;color:#fde68a;background:rgba(251,191,36,0.18);padding:2px 8px;border-radius:999px;}" +
      ".qcam-pill-badge[hidden]{display:none;}" +
      /* Bottom info area */
      ".qcam-bottom{background:rgba(0,0,0,0.85);padding:14px 18px calc(env(safe-area-inset-bottom,12px) + 16px);text-align:center;}" +
      /* Tip checklist card */
      ".qcam-tipcard{background:rgba(8,12,20,0.72);border:1px solid rgba(255,255,255,0.12);border-radius:14px;padding:12px 14px;margin-bottom:12px;text-align:left;}" +
      ".qcam-tip-head{font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#7dd3fc;margin-bottom:9px;font-family:'DM Sans',sans-serif;}" +
      ".qcam-tips{list-style:none;margin:0;padding:0;}" +
      ".qcam-tips li{display:flex;align-items:flex-start;gap:9px;color:#f1f5f9;font-size:12.5px;font-weight:600;line-height:1.35;margin-bottom:7px;font-family:'DM Sans',sans-serif;}" +
      ".qcam-tips li:last-child{margin-bottom:0;}" +
      ".qcam-tips li::before{content:'\\2713';flex:0 0 auto;width:16px;height:16px;border-radius:50%;background:rgba(0,229,255,0.18);color:#00e5ff;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;margin-top:1px;}" +
      /* Live lighting hint chip */
      ".qcam-live{display:inline-flex;align-items:center;gap:7px;font-family:'DM Sans',sans-serif;font-size:11.5px;font-weight:700;padding:5px 11px;border-radius:999px;margin-bottom:14px;background:rgba(22,163,74,0.18);border:1px solid rgba(22,163,74,0.4);color:#86efac;}" +
      ".qcam-live.warn{background:rgba(251,191,36,0.16);border-color:rgba(251,191,36,0.45);color:#fde68a;}" +
      ".qcam-live-dot{width:7px;height:7px;border-radius:50%;background:#22c55e;animation:qcamPulse 1.6s infinite;}" +
      ".qcam-live.warn .qcam-live-dot{background:#f59e0b;}" +
      "@keyframes qcamPulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.5)}70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}" +
      ".qcam-capture{width:64px;height:64px;border-radius:50%;border:4px solid #fff;background:transparent;cursor:pointer;margin:0 auto;display:block;position:relative;}" +
      ".qcam-capture::after{content:'';position:absolute;inset:4px;border-radius:50%;background:#fff;transition:transform 0.15s;}" +
      ".qcam-capture:active::after{transform:scale(0.85);}" +
      /* Close button */
      ".qcam-close{position:absolute;top:16px;right:16px;z-index:10;width:40px;height:40px;border-radius:50%;border:none;background:rgba(0,0,0,0.5);color:#fff;font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:'DM Sans',sans-serif;}" +
      /* "Check your photo" gate — covers the whole overlay, bottom bar included */
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
      "@keyframes qcamGlow{0%{border-color:#00e5ff;filter:drop-shadow(0 0 4px #00e5ff)}100%{border-color:#00bcd4;filter:drop-shadow(0 0 8px #00e5ff)}}";
    document.head.appendChild(s);
  }

  function getOverlay() {
    var el = document.getElementById(OVERLAY_ID);
    if (el) return el;

    el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.innerHTML =
      '<div class="qcam-video-wrap">' +
        '<video class="qcam-video" id="qcamVideo" autoplay playsinline muted></video>' +
        '<div class="qcam-viewfinder">' +
          '<div class="qcam-bracket tl"></div>' +
          '<div class="qcam-bracket tr"></div>' +
          '<div class="qcam-bracket bl"></div>' +
          '<div class="qcam-bracket br"></div>' +
        '</div>' +
        '<div class="qcam-scanline"></div>' +
        '<div class="qcam-toplabel">' +
          '<span class="qcam-pill">' +
            '<span class="qcam-pill-name" id="qcamPillName"></span>' +
            '<span class="qcam-pill-badge" id="qcamPillBadge" hidden>CERTIFIED COPY</span>' +
          '</span>' +
        '</div>' +
        '<button class="qcam-close" id="qcamClose" type="button">&times;</button>' +
      '</div>' +
      '<div class="qcam-bottom">' +
        '<div class="qcam-tipcard">' +
          '<div class="qcam-tip-head" id="qcamTipHead">Make sure these are sharp &amp; in frame</div>' +
          '<ul class="qcam-tips" id="qcamTips"></ul>' +
        '</div>' +
        '<div class="qcam-live" id="qcamLive"><span class="qcam-live-dot"></span><span id="qcamLiveText">Checking lighting…</span></div>' +
        '<button class="qcam-capture" id="qcamCapture" type="button" aria-label="Capture photo"></button>' +
      '</div>' +
      '<div class="qcam-review" id="qcamReview">' +
        '<img class="qcam-review-img" id="qcamReviewImg" alt="The photo you just took" />' +
        '<div class="qcam-review-title">Is the whole document in shot?</div>' +
        '<p class="qcam-review-text">There is a lot of background in this photo. Move closer so the document fills the frame, with nothing resting on top of it.</p>' +
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
    var tips = (opts.tips && opts.tips.length) ? opts.tips : resolveTips(opts.docKey, requireCert);

    currentDocLabel = docLabel;
    onCaptureCallback = onCapture;

    document.getElementById("qcamPillName").textContent = docLabel;
    var badge = document.getElementById("qcamPillBadge");
    if (badge) badge.hidden = !requireCert;

    var head = document.getElementById("qcamTipHead");
    if (head) head.innerHTML = requireCert
      ? "Make sure these are sharp &amp; in frame"
      : "For a clear scan";

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

    var video = document.getElementById("qcamVideo");
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }
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

  /* ── Local framing measurement (no AI) ────────────────────────────────────
   * Returns { code, coverage } where code is:
   *   "ok"        the page fills enough of the frame
   *   "too_small" a page-shaped region was found and it is too small
   *   "unknown"   nothing measurable — caller must treat this as a pass
   */
  function measureFraming(source, sourceW, sourceH) {
    if (!source || !sourceW || !sourceH) return { code: "unknown", coverage: 0 };
    var w = FRAMING_SAMPLE_W;
    var h = FRAMING_SAMPLE_H;
    var data;
    try {
      if (!framingCanvas) {
        framingCanvas = document.createElement("canvas");
        framingCanvas.width = w;
        framingCanvas.height = h;
      }
      var ctx = framingCanvas.getContext("2d");
      ctx.drawImage(source, 0, 0, w, h);
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
    // Almost everything is bright: either the page already fills the frame or the
    // page and the surface are the same shade. Either way, nothing to complain about.
    if (brightFraction > 0.9) return { code: "ok", coverage: brightFraction };
    if (brightFraction < 0.06) return { code: "unknown", coverage: brightFraction };

    // Largest connected bright region — the page, if there is one. Iterative flood
    // fill: a recursive one blows the stack on a full-frame region.
    var seen = new Uint8Array(total);
    var stack = new Int32Array(total);
    var bestSize = 0, bestBox = null;
    for (var s = 0; s < total; s++) {
      if (!bright[s] || seen[s]) continue;
      var top = 0;
      stack[top++] = s;
      seen[s] = 1;
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
        if (x > 0 && bright[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack[top++] = idx - 1; }
        if (x < w - 1 && bright[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack[top++] = idx + 1; }
        if (y > 0 && bright[idx - w] && !seen[idx - w]) { seen[idx - w] = 1; stack[top++] = idx - w; }
        if (y < h - 1 && bright[idx + w] && !seen[idx + w]) { seen[idx + w] = 1; stack[top++] = idx + w; }
      }
      if (size > bestSize) {
        bestSize = size;
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
    return { code: coverage >= FRAMING_MIN_COVERAGE ? "ok" : "too_small", coverage: coverage };
  }

  /* ── Rule-based live lighting hint (local heuristics only — no AI) ── */
  function resetLiveHint() {
    lastLiveState = "";
    setLiveHint("ok", "Hold steady");
  }

  function setLiveHint(state, text) {
    if (state === lastLiveState) return;
    lastLiveState = state;
    var live = document.getElementById("qcamLive");
    var txt = document.getElementById("qcamLiveText");
    if (txt) txt.textContent = text;
    if (live) {
      if (state === "warn") live.classList.add("warn");
      else live.classList.remove("warn");
    }
  }

  function startLiveHint() {
    stopLiveHint();
    if (!sampleCanvas) {
      sampleCanvas = document.createElement("canvas");
      sampleCanvas.width = 40;
      sampleCanvas.height = 40;
    }
    liveTimer = setInterval(sampleFrame, 800);
  }

  function stopLiveHint() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  }

  function sampleFrame() {
    var video = document.getElementById("qcamVideo");
    if (!video || !video.videoWidth) return;
    try {
      var ctx = sampleCanvas.getContext("2d");
      ctx.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height);
      var data = ctx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
      var sum = 0, count = 0;
      // sample every 4th pixel for speed
      for (var i = 0; i < data.length; i += 16) {
        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        count++;
      }
      var avg = count ? sum / count : 0;
      // Lighting first: a frame that is too dark or blown out makes the framing
      // measurement unreliable, and it is the thing to fix before moving closer.
      if (avg < 55) { setLiveHint("warn", "Too dark — find more light"); return; }
      if (avg > 238) { setLiveHint("warn", "Too bright — reduce glare"); return; }
      var framing = measureFraming(video, video.videoWidth, video.videoHeight);
      if (framing.code === "too_small") setLiveHint("warn", "Move closer — fill the frame with the document");
      else setLiveHint("ok", "Looks good — hold steady");
    } catch (e) {
      // getImageData can throw on some tainted/!ready frames; ignore this tick
    }
  }

  function capturePhoto() {
    var video = document.getElementById("qcamVideo");
    if (!video || !video.videoWidth) return;

    var canvas = document.createElement("canvas");
    // Resize to max 1200px to stay under Vercel 4.5MB body limit
    var maxDim = 1200;
    var w = video.videoWidth;
    var h = video.videoHeight;
    if (w > maxDim || h > maxDim) {
      var scale = maxDim / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);

    // Judge the shot we actually took, not the last live frame.
    var framing = measureFraming(canvas, w, h);

    canvas.toBlob(function (blob) {
      if (!blob) {
        closeCamera();
        if (onCaptureCallback) onCaptureCallback(null, new Error("Could not capture image"));
        return;
      }
      if (framing.code === "too_small") {
        showReview(blob);
        return;
      }
      acceptPhoto(blob);
    }, "image/jpeg", 0.85);
  }

  /* ── "Check your photo" gate ──────────────────────────────────────────────
   * Shown when the document does not fill enough of the shot. It is a prompt, not
   * a lock: the measurement can be wrong (a dark certificate, a page on a white
   * desk), and a doctor who cannot get past their own camera has no way to finish
   * onboarding at all. "Retake" is the obvious choice; "Use this photo" is there
   * for when we called it wrong.
   */
  function showReview(blob) {
    clearPendingPreview();
    pendingBlob = blob;
    try { pendingPreviewUrl = URL.createObjectURL(blob); } catch (e) { pendingPreviewUrl = ""; }
    var img = document.getElementById("qcamReviewImg");
    if (img) img.src = pendingPreviewUrl;
    var panel = document.getElementById("qcamReview");
    if (panel) panel.classList.add("open");
    stopLiveHint();
  }

  function hideReview() {
    var panel = document.getElementById("qcamReview");
    if (panel) panel.classList.remove("open");
    clearPendingPreview();
    pendingBlob = null;
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
    if (overlay) overlay.classList.remove("open");
  }

  // Stop camera stream if user navigates away or hides the page
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden" && stream) closeCamera();
  });
  window.addEventListener("pagehide", function () {
    if (stream) closeCamera();
  });

  // Expose globally
  window.QualCamera = {
    open: openCamera,
    close: closeCamera
  };
})();

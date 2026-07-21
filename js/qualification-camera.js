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
  var lastLiveState = "";

  /*
   * Per-document camera guidance. Keyed by the document key used in
   * COUNTRY_DOCS (see pages/my-documents.html). Resolution order:
   *   explicit key  ->  _certifiedDefault (when requireCert)  ->  _plainDefault
   * Wording is intentionally plain so it can be tuned without touching logic.
   */
  var SCAN_TIPS = {
    _certifiedDefault: [
      "All four corners of the page are inside the frame",
      "The certifier's stamp & signature are sharp",
      "The “I certify this a true copy” line is readable"
    ],
    _plainDefault: [
      "Show your full name and the document date",
      "Whole page in frame, no fingers over the text",
      "Even lighting, no glare across the page"
    ],
    primary_medical_degree: [
      "Fit the whole certificate inside the frame",
      "Your full name is clear and matches your account",
      "The certifier's stamp, signature & “true copy” line show"
    ],
    criminal_history: [
      "Show the reference number (e.g. FIT1234567)",
      "Your full name and the issue date are readable",
      "Whole page in frame, no glare"
    ]
  };

  function resolveTips(docKey, requireCert) {
    if (docKey && SCAN_TIPS[docKey]) return SCAN_TIPS[docKey];
    return requireCert ? SCAN_TIPS._certifiedDefault : SCAN_TIPS._plainDefault;
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
      '</div>';
    document.body.appendChild(el);

    document.getElementById("qcamClose").addEventListener("click", closeCamera);
    document.getElementById("qcamCapture").addEventListener("click", capturePhoto);

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

  /* ── Rule-based live lighting hint (local heuristics only, no AI) ── */
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
      if (avg < 55) setLiveHint("warn", "Too dark, find more light");
      else if (avg > 238) setLiveHint("warn", "Too bright, reduce glare");
      else setLiveHint("ok", "Lighting looks good, hold steady");
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

    canvas.toBlob(function (blob) {
      closeCamera();
      if (!blob) {
        if (onCaptureCallback) onCaptureCallback(null, new Error("Could not capture image"));
        return;
      }
      if (onCaptureCallback) onCaptureCallback(blob, null);
    }, "image/jpeg", 0.85);
  }

  function closeCamera() {
    stopLiveHint();
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

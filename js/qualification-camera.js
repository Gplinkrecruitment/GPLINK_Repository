(function () {
  "use strict";
  if (typeof document === "undefined") return;

  var STYLE_ID = "gpQualCameraStyle";
  var OVERLAY_ID = "gpQualCameraOverlay";

  var stream = null;
  var onCaptureCallback = null;
  var currentDocLabel = "";

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
      /* Bottom info area */
      ".qcam-bottom{background:rgba(0,0,0,0.85);padding:16px 20px calc(env(safe-area-inset-bottom,12px) + 16px);text-align:center;}" +
      ".qcam-hint{font-size:12px;color:#94a3b8;margin-bottom:4px;font-family:'DM Sans',sans-serif;}" +
      ".qcam-doc-label{font-size:16px;font-weight:700;color:#fff;margin-bottom:4px;font-family:'DM Sans',sans-serif;}" +
      ".qcam-sub{font-size:12px;color:#64748b;margin-bottom:14px;font-family:'DM Sans',sans-serif;}" +
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
        '<button class="qcam-close" id="qcamClose" type="button">&times;</button>' +
      '</div>' +
      '<div class="qcam-bottom">' +
        '<div class="qcam-hint">AI recommendation: Bring Closer, ensure clear</div>' +
        '<div class="qcam-doc-label" id="qcamDocLabel"></div>' +
        '<div class="qcam-sub">Snap or upload document to be reviewed</div>' +
        '<button class="qcam-capture" id="qcamCapture" type="button" aria-label="Capture photo"></button>' +
      '</div>';
    document.body.appendChild(el);

    document.getElementById("qcamClose").addEventListener("click", closeCamera);
    document.getElementById("qcamCapture").addEventListener("click", capturePhoto);

    return el;
  }

  function openCamera(docLabel, onCapture) {
    injectStyles();
    var overlay = getOverlay();
    currentDocLabel = docLabel;
    onCaptureCallback = onCapture;

    document.getElementById("qcamDocLabel").textContent = docLabel;
    overlay.classList.add("open");

    var video = document.getElementById("qcamVideo");
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }
    })
    .then(function (s) {
      stream = s;
      video.srcObject = s;
    })
    .catch(function (err) {
      console.error("[QualCamera] Camera access denied:", err);
      closeCamera();
      if (onCapture) onCapture(null, "Camera access denied. Please allow camera permissions or upload a file instead.");
    });
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
      if (onCaptureCallback) onCaptureCallback(blob, null);
    }, "image/jpeg", 0.85);
  }

  function closeCamera() {
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

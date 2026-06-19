(function () {
  "use strict";
  if (typeof document === "undefined") return;

  /* ── Constants ── */
  var MODAL_ID = "gpScanModal";
  var STYLE_ID = "gpScanStyle";
  var AI_SCAN_ACCEPT = "image/*,.pdf";

  var DOC_LABELS = {
    primary_medical_degree: "Primary Medical Degree",
    mrcgp_certified: "MRCGP Certificate",
    cct_certified: "CCT Certificate",
    micgp_certified: "MICGP Certificate",
    cscst_certified: "CSCST Certificate",
    icgp_confirmation_letter: "ICGP Confirmation Letter",
    frnzcgp_certified: "FRNZCGP Certificate",
    rnzcgp_confirmation_letter: "RNZCGP Confirmation Letter",
    cv_signed_dated: "Signed CV",
    certificate_good_standing: "Certificate of Good Standing",
    confirmation_training: "Confirmation of Training",
    criminal_history: "Criminal History Check"
  };

  /* ── State ── */
  var selectedFile = null;
  var isOpen = false;
  var certContext = null; // { key, title, callback } when in certification scan mode

  /* ── Helpers ── */
  function canonicalQualKey(docType) {
    var t = String(docType || '').toLowerCase();
    if (t.indexOf('primary medical') !== -1 || t.indexOf('medical degree') !== -1) return 'primary_medical_degree';
    if (t.indexOf('mrcgp') !== -1) return 'mrcgp_certified';
    if (t.indexOf('cct') !== -1) return 'cct_certified';
    if (t.indexOf('good standing') !== -1 || t.indexOf('registration status') !== -1) return 'certificate_good_standing';
    if (t.indexOf('confirmation') !== -1 && t.indexOf('training') !== -1) return 'confirmation_training';
    if (t.indexOf('micgp') !== -1) return 'micgp';
    if (t.indexOf('cscst') !== -1) return 'cscst';
    if (t.indexOf('frnzcgp') !== -1) return 'frnzcgp';
    return null; // unknown → don't PUT (no canonical server key)
  }

  function esc(s) {
    if (typeof s !== "string") return "";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function formatSize(b) {
    if (!b) return "0 B";
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    return (b / 1048576).toFixed(1) + " MB";
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result.split(",")[1] || reader.result);
      };
      reader.onerror = function () { reject(new Error("Failed to read file.")); };
      reader.readAsDataURL(file);
    });
  }

  function isImageFile(file) {
    if (!file) return false;
    var type = String(file.type || "").toLowerCase();
    if (/^image\//.test(type)) return true;
    return /\.(jpe?g|png|webp|gif|bmp|tif|tiff|heic|heif|avif)$/i.test(file.name || "");
  }

  // Downscale a (potentially huge phone-camera) image in the browser before upload.
  // The platform rejects request bodies over ~4.5 MB, and base64 inflates bytes by
  // ~33%, so a 4 MB photo overflows the limit and the upload fails before it even
  // reaches the server. The vision model only needs ~1568px on the long edge, so
  // shrinking to that loses no detail the AI uses while keeping the request small.
  function downscaleImageToBase64(file, maxDim, quality) {
    maxDim = maxDim || 1600;
    quality = quality || 0.82;
    return new Promise(function (resolve, reject) {
      var url;
      try { url = URL.createObjectURL(file); } catch (e) { reject(e); return; }
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) { URL.revokeObjectURL(url); reject(new Error("no dimensions")); return; }
          var scale = Math.min(1, maxDim / Math.max(w, h));
          var canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          var ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          var q = quality;
          var dataUrl = canvas.toDataURL("image/jpeg", q);
          // If still too big for the body limit, recompress harder once.
          if (dataUrl.length > 3600000) dataUrl = canvas.toDataURL("image/jpeg", 0.6);
          URL.revokeObjectURL(url);
          var b64 = dataUrl.split(",")[1] || "";
          if (!b64) { reject(new Error("encode failed")); return; }
          resolve({ base64: b64, mimeType: "image/jpeg" });
        } catch (e) { try { URL.revokeObjectURL(url); } catch (e2) {} reject(e); }
      };
      img.onerror = function () { try { URL.revokeObjectURL(url); } catch (e) {} reject(new Error("image decode failed")); };
      img.src = url;
    });
  }

  // Returns { base64, mimeType } ready to send. Images are downscaled; PDFs and any
  // file we cannot decode fall back to raw bytes (with a clear "too large" message
  // downstream if the platform then rejects them).
  function prepareScanUpload(file) {
    var fallbackType = (file && file.type) || "application/octet-stream";
    if (isImageFile(file)) {
      return downscaleImageToBase64(file).catch(function () {
        return fileToBase64(file).then(function (b64) { return { base64: b64, mimeType: fallbackType }; });
      });
    }
    return fileToBase64(file).then(function (b64) { return { base64: b64, mimeType: fallbackType }; });
  }

  // Read a fetch response as JSON without throwing on a non-JSON body. Platform
  // errors (e.g. a 413 "Request Entity Too Large" plain-text page) would otherwise
  // make res.json() throw "Unexpected token ... is not valid JSON", which surfaced
  // to GPs verbatim. Map those to a clear, structured result instead.
  function readJsonResponse(res) {
    return res.text().then(function (text) {
      try {
        return JSON.parse(text);
      } catch (e) {
        var tooLarge = res.status === 413 || /request entity too large|payload too large|too large/i.test(text || "");
        return {
          ok: false,
          status: res.status,
          message: tooLarge
            ? "This file is too large to scan. Please upload a smaller photo, or the PDF version, and try again."
            : "We could not finish checking this document automatically just now. Please try again in a moment."
        };
      }
    });
  }

  function base64ToDataUrl(base64, mimeType) {
    if (typeof base64 !== "string" || !base64) return "";
    return "data:" + (mimeType || "application/octet-stream") + ";base64," + base64;
  }

  function isAiScannableFile(file) {
    if (!file) return false;
    var type = String(file.type || "").toLowerCase();
    var name = String(file.name || "").toLowerCase();
    if (type === "application/pdf" || /\.pdf$/i.test(name)) return true;
    if (/^image\//i.test(type)) return true;
    return /\.(jpg|jpeg|png|webp|gif|bmp|tif|tiff|heic|heif|avif)$/i.test(name);
  }

  function stripHtml(s) {
    return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  function getFriendlyTargetLabel(options) {
    // Prefer the clean document noun ("MRCGP Certificate", "Primary Medical Degree")
    // over the requirement label ("Certified copy of MRCGP"), so rejection messages
    // describe the document the user uploaded — not the requirement they were given.
    var docKey = options && options.docKey;
    if (docKey && DOC_LABELS[docKey]) return DOC_LABELS[docKey];
    var title = options && options.documentTitle ? stripHtml(options.documentTitle) : "";
    title = title.replace(/^certified copy of\s+/i, "").trim();
    return title || "the requested document";
  }

  // Single source of truth for "right document, but not certified" rejections.
  // Separates what the document IS (identity, which the AI confirmed) from what is
  // wrong with it (it has not been certified as a true copy). Used for every
  // certification-required document so the reasoning reads the same everywhere.
  // NOTE: the wording below MUST keep containing a phrase that the certification
  // regex in humanizeScanIssue matches (e.g. "has not been certified"), because this
  // message can be passed back through humanizeScanIssue a second time — it must map
  // to itself rather than fall through to the generic fallback.
  function certificationGuidance(targetLabel) {
    return "We can see this is your " + targetLabel + ", but it has not been certified as a true copy of the original. "
      + "To accept it, a solicitor or public notary must certify the copy — adding a statement that it is a true copy of the original, "
      + "plus their signature, printed name, occupation and the date. Then upload the certified copy.";
  }

  function humanizeScanIssue(issue, options) {
    var clean = stripHtml(issue);
    var lower = clean.toLowerCase();
    var mode = options && options.mode;
    var targetLabel = getFriendlyTargetLabel(options);
    var wrongDocMatch = clean.match(/appears to be\s+(.+?),\s+not\s+(.+?)(?:\.|$)/i);

    if (!clean) {
      return "We could not complete the scan. Please try again with a clear image of the full document.";
    }
    // Checked early (before the blurry/name branches) so the message stays stable if it
    // is re-humanized. Wording avoids "clearer photo" to not collide with the blurry branch.
    if (/too large|request entity too large|payload too large|image too large|file too large/.test(lower)) {
      return "This file is too large to scan. Please upload a smaller photo, or the PDF version, and try again.";
    }
    if (/does not match your account|doesn.?t match your profile|same name as your qualifications/.test(lower)) {
      return "The name on this document does not match the name on your account. Upload a document showing the same full name, or update your account details first.";
    }
    if (/could not confidently match the full name|full name on this document|full name on your id|name .*not readable|completely unreadable/.test(lower)) {
      return "We could not clearly read the full name on this document. Please upload a clearer photo with the full name fully visible.";
    }
    if (/too blurry|blurry to read|illegible|not readable|clearer photo|clearer document/.test(lower)) {
      return "We could not read this document clearly. Retake the photo in good light and make sure all text is sharp and fully visible.";
    }
    // Certification problems belong ONLY to the certification check. Gate on
    // mode === "certification" so a qualification/wrong-document issue that merely
    // mentions "certified" or "true copy" can never be rewritten into a (fabricated)
    // "not certified" verdict. The regex stays certification-specific (no bare
    // "certificate"/"certifier") so it does not collide with friendly wrong-document
    // messages — which contain labels like "MRCGP Certificate" — when those are
    // re-humanized in certification mode.
    if (mode === "certification" && /identified this as .*could not verify the certification|not been certified|not certified|properly certified|certification statement|certification markings|without any certification|no certification markings|certified as a true copy|true copy of the original/.test(lower)) {
      return certificationGuidance(targetLabel);
    }
    if (/does not appear to be the correct document|wrong document|correct document type/.test(lower)) {
      return "This looks like a different document from the one needed here. Please upload " + targetLabel + ".";
    }
    if (wrongDocMatch) {
      return "This looks like " + wrongDocMatch[1] + ", not " + targetLabel + ". Please upload the correct document for this step.";
    }
    if (/expired on|document expired|has expired|is expired|non-expired/.test(lower)) {
      return "This document has expired. Please upload a valid, non-expired document.";
    }
    if (/dated before|date on the document must be from|issue date|before the required date/.test(lower)) {
      return "The issue date on this document is outside the accepted date range for this pathway. Please upload the correct certificate or a later version if available.";
    }
    if (/passport or driver.?s licence|identity document/.test(lower)) {
      return "Please upload a passport or driver's licence with the full name clearly visible.";
    }
    if (/verification capacity reached|queued for review|manual review/.test(lower)) {
      return "We could not finish the automatic scan right now, so your document has been sent for manual review.";
    }
    if (/document verification is not ready yet|still loading/.test(lower)) {
      return "The scan tool is still loading. Please refresh the page and try again.";
    }
    if (/could not connect|failed to connect|network error|ai service returned an error|ai service returned|returned invalid response|invalid response format|returned empty response|ai returned an empty|verification service not configured|could not verify this document. please try again|unexpected token|is not valid json|json\.parse/.test(lower)) {
      return "We could not finish checking this document automatically just now. This is a temporary problem on our side, not a problem with your document. Please try again in a moment — if it keeps happening, please contact support and we'll review it for you.";
    }
    if (/please upload a pdf or image file/.test(lower)) {
      return "Please upload a PDF or image file for the scan.";
    }
    if (/failed to read file|could not read that file/.test(lower)) {
      return "We could not read that file. Please upload it again as a PDF or image.";
    }
    if (/could not verify this document/.test(lower)) {
      return "We could not verify this document automatically. Please make sure the full document is visible, clear and uploaded in the correct place.";
    }
    return clean;
  }

  function humanizeScanIssues(issues, options) {
    var opts = options || {};
    var list = Array.isArray(issues) ? issues : (issues ? [issues] : []);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var message = humanizeScanIssue(list[i], opts);
      if (message && out.indexOf(message) === -1) out.push(message);
    }
    if (!out.length && !opts.allowEmpty) {
      out.push("We could not complete the scan. Please try again with a clear image of the full document.");
    }
    return out;
  }

  function humanizeScanIssuesHtml(issues, options) {
    return humanizeScanIssues(issues, options).map(esc).join("<br>");
  }

  window.gpFriendlyScanIssues = humanizeScanIssues;
  window.gpFriendlyScanIssuesHtml = humanizeScanIssuesHtml;

  function getProfileName() {
    if (!window.gpSessionProfile) return "";
    if (window.gpSessionProfile.full_name) return window.gpSessionProfile.full_name;
    if (window.gpSessionProfile.name) return window.gpSessionProfile.name;
    var first = window.gpSessionProfile.firstName || window.gpSessionProfile.first_name || "";
    var last = window.gpSessionProfile.lastName || window.gpSessionProfile.last_name || "";
    var full = (first + " " + last).trim();
    return full || "";
  }

  function getSelectedCountryCode() {
    var raw = "";
    try { raw = localStorage.getItem("gp_selected_country") || ""; } catch (e) { raw = ""; }
    if (!raw) return "GB";
    try { raw = JSON.parse(raw); } catch (e2) {}
    var lower = String(raw || "").toLowerCase().trim();
    if (lower === "uk" || lower === "gb" || lower === "united kingdom") return "GB";
    if (lower === "ie" || lower === "ireland") return "IE";
    if (lower === "nz" || lower === "new zealand") return "NZ";
    return "GB";
  }

  function getExpectedQualificationDocumentType(docKey, fallbackTitle) {
    var mapped = DOC_LABELS[docKey];
    if (mapped) return mapped;
    var title = String(fallbackTitle || "").replace(/^certified copy of\s+/i, "").trim();
    return title || "qualification document";
  }

  function verifyQualificationDocument(file, options) {
    var opts = options || {};
    return prepareScanUpload(file).then(function (prep) {
      return fetch("/api/ai/verify-qualification", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: prep.base64,
          mimeType: prep.mimeType,
          documentType: getExpectedQualificationDocumentType(opts.docKey, opts.documentType),
          expectedCountry: opts.expectedCountry || getSelectedCountryCode(),
          profileName: opts.profileName || getProfileName()
        })
      });
    }).then(readJsonResponse);
  }

  function verifyCertificationDocument(file, options) {
    var opts = options || {};
    return prepareScanUpload(file).then(function (prep) {
      return fetch("/api/ai/verify-certification", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: prep.base64,
          mimeType: prep.mimeType,
          documentType: getExpectedQualificationDocumentType(opts.docKey, opts.documentType)
        })
      });
    }).then(readJsonResponse);
  }

  function verifyCertifiedDocument(file, options) {
    var opts = options || {};
    return verifyQualificationDocument(file, opts).then(function (qualData) {
      if (!qualData || !qualData.ok || !qualData.verification) {
        throw new Error((qualData && qualData.message) || "Could not verify this document.");
      }

      var qualVerification = qualData.verification;
      var nameMatch = qualVerification.nameMatch || "unknown";
      var nameConfirmed = nameMatch === "exact" || nameMatch === "fuzzy";
      var qualIssues = Array.isArray(qualVerification.issues) && qualVerification.issues.length
        ? qualVerification.issues.slice()
        : ["The document details could not be verified against your account."];
      var friendlyQualIssues = humanizeScanIssues(qualIssues, {
        documentTitle: getExpectedQualificationDocumentType(opts.docKey, opts.documentType),
        mode: "qualification"
      });

      if (!qualVerification.verified || !nameConfirmed) {
        return {
          ok: true,
          certified: false,
          verification: {
            certified: false,
            nameFound: qualVerification.nameFound || null,
            nameMatch: nameMatch,
            qualificationVerification: qualVerification,
            issues: friendlyQualIssues
          }
        };
      }

      return verifyCertificationDocument(file, opts).then(function (certData) {
        if (!certData || !certData.ok || !certData.verification) {
          throw new Error((certData && certData.message) || "Could not verify this document.");
        }
        var certVerification = certData.verification;
        certVerification.qualificationVerification = qualVerification;
        certVerification.nameFound = qualVerification.nameFound || null;
        certVerification.nameMatch = nameMatch;
        if (!certVerification.certified) {
          var certIssues = Array.isArray(certVerification.issues) && certVerification.issues.length
            ? certVerification.issues
            : ["The document does not appear to be properly certified."];
          certVerification.issues = humanizeScanIssues(certIssues, {
            docKey: opts.docKey,
            documentTitle: getExpectedQualificationDocumentType(opts.docKey, opts.documentType),
            mode: "certification"
          });
        }
        return {
          ok: true,
          certified: !!certVerification.certified,
          verification: certVerification
        };
      });
    });
  }

  window.gpVerifyCertifiedDocument = verifyCertifiedDocument;

  /* ── Styles ── */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent =
      "#" + MODAL_ID + "{position:fixed;inset:0;z-index:9999;display:none;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.45);}" +
      "#" + MODAL_ID + ".open{display:flex;}" +
      ".scan-sheet{width:100%;max-width:500px;max-height:90vh;background:#fff;border-radius:20px 20px 0 0;overflow-y:auto;padding:0 0 env(safe-area-inset-bottom,0);animation:scanSlideUp .3s ease;}" +
      "@keyframes scanSlideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}" +
      ".scan-bar{width:40px;height:4px;margin:10px auto 0;border-radius:4px;background:#cbd7ea;}" +
      ".scan-hdr{display:flex;align-items:center;justify-content:space-between;padding:12px 20px 10px;}" +
      ".scan-hdr h3{margin:0;font-size:17px;font-weight:800;color:#0f172a;}" +
      ".scan-close{border:0;background:0 0;font-size:24px;color:#94a3b8;cursor:pointer;padding:4px 8px;line-height:1;}" +
      ".scan-body{padding:0 20px 20px;}" +
      /* Two-button row for upload vs camera */
      ".scan-actions{display:flex;gap:10px;margin-bottom:14px;}" +
      ".scan-action-btn{flex:1;display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px 12px;border:2px solid #e2e8f0;border-radius:14px;background:#fafbfc;cursor:pointer;transition:border-color .2s,background .2s;}" +
      ".scan-action-btn:active{background:#eff6ff;border-color:#2563eb;}" +
      ".scan-action-btn svg{width:32px;height:32px;stroke:#2563eb;fill:none;stroke-width:1.5;}" +
      ".scan-action-btn span{font-size:13px;font-weight:700;color:#0f172a;}" +
      ".scan-action-btn small{font-size:11px;color:#64748b;}" +
      /* File card */
      ".scan-file{display:none;align-items:center;gap:10px;padding:12px;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:12px;background:#f8fafc;}" +
      ".scan-file.show{display:flex;}" +
      ".scan-file-name{flex:1;min-width:0;font-size:13px;font-weight:600;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
      ".scan-file-size{font-size:11px;color:#64748b;}" +
      ".scan-file-rm{border:0;background:0 0;color:#94a3b8;cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;}" +
      ".scan-submit{display:block;width:100%;margin-top:12px;padding:14px;border:0;border-radius:12px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;font-size:14px;font-weight:700;cursor:pointer;}" +
      ".scan-submit:disabled{opacity:.4;cursor:not-allowed;}" +
      /* Status/result */
      ".scan-status{text-align:center;padding:32px 0;}" +
      ".scan-status h4{margin:0 0 6px;font-size:16px;font-weight:700;color:#0f172a;}" +
      ".scan-status p{margin:0;font-size:13px;color:#64748b;}" +
      ".scan-spinner{width:40px;height:40px;border:3px solid #e2e8f0;border-top-color:#2563eb;border-radius:50%;animation:scanSpin .7s linear infinite;margin:0 auto 16px;}" +
      "@keyframes scanSpin{to{transform:rotate(360deg)}}" +
      ".scan-result{padding:20px 0;text-align:center;}" +
      ".scan-result .ok{color:#16a34a;}" +
      ".scan-result .err{color:#dc2626;}" +
      ".scan-result h4{margin:8px 0 4px;font-size:16px;font-weight:800;}" +
      ".scan-result p{margin:0 0 16px;font-size:13px;color:#64748b;}" +
      ".scan-btn-outline{display:block;width:100%;margin-top:8px;padding:12px;border:1px solid #e2e8f0;border-radius:12px;background:#fff;color:#0f172a;font-size:13px;font-weight:600;cursor:pointer;}" +
      "@media(min-width:640px){#" + MODAL_ID + "{align-items:center;}.scan-sheet{border-radius:20px;max-height:80vh;animation:scanFadeIn .25s ease;}}" +
      "@keyframes scanFadeIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}";
    document.head.appendChild(s);
  }

  /* ── Build modal DOM ── */
  function getModal() {
    var el = document.getElementById(MODAL_ID);
    if (el) return el;

    el = document.createElement("div");
    el.id = MODAL_ID;
    el.innerHTML =
      '<div class="scan-sheet">' +
        '<div class="scan-bar"></div>' +
        '<div class="scan-hdr"><h3>Scan Document</h3><button class="scan-close" data-scan-action="close" type="button">&times;</button></div>' +
        '<div class="scan-body">' +
          '<div data-scan-step="pick">' +
            '<div class="scan-actions">' +
              '<button class="scan-action-btn" data-scan-action="camera" type="button">' +
                '<svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>' +
                '<span>Use Camera</span>' +
                '<small>Snap a photo</small>' +
              '</button>' +
              '<button class="scan-action-btn" data-scan-action="browse" type="button">' +
                '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
                '<span>Upload File</span>' +
                '<small>PDF or image</small>' +
              '</button>' +
            '</div>' +
            '<input id="gpScanFile" type="file" accept="' + AI_SCAN_ACCEPT + '" style="display:none"/>' +
            '<div class="scan-file" id="gpScanFileCard">' +
              '<span class="scan-file-name" id="gpScanFileName"></span>' +
              '<span class="scan-file-size" id="gpScanFileSize"></span>' +
              '<button class="scan-file-rm" data-scan-action="remove" type="button">&times;</button>' +
            '</div>' +
            '<button class="scan-submit" id="gpScanSubmit" data-scan-action="submit" type="button" disabled>Scan with AI</button>' +
          '</div>' +
          '<div data-scan-step="scanning" style="display:none">' +
            '<div class="scan-status"><div class="scan-spinner"></div><h4 id="gpScanPhase">Analyzing...</h4><p>AI is verifying your document</p></div>' +
          '</div>' +
          '<div data-scan-step="result" style="display:none">' +
            '<div class="scan-result" id="gpScanResult"></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    return el;
  }

  /* ── Step management ── */
  function showStep(name) {
    var modal = getModal();
    var steps = modal.querySelectorAll("[data-scan-step]");
    for (var i = 0; i < steps.length; i++) {
      steps[i].style.display = steps[i].getAttribute("data-scan-step") === name ? "" : "none";
    }
  }

  function resetModal() {
    scanInProgress = false;
    selectedFile = null;
    var input = document.getElementById("gpScanFile");
    if (input) input.value = "";
    var card = document.getElementById("gpScanFileCard");
    if (card) card.classList.remove("show");
    var btn = document.getElementById("gpScanSubmit");
    if (btn) btn.disabled = true;
    var hdr = getModal().querySelector(".scan-hdr h3");
    if (hdr) hdr.textContent = certContext ? certContext.title : "Scan Document";
    showStep("pick");
  }

  /* ── Open / Close ── */
  function openModal() {
    if (isOpen) return;
    isOpen = true;
    injectStyles();
    var modal = getModal();
    resetModal();
    modal.classList.add("open");
  }

  function closeModal() {
    if (!isOpen) return;
    isOpen = false;
    scanInProgress = false;
    var modal = document.getElementById(MODAL_ID);
    if (modal) modal.classList.remove("open");
  }

  window.gpOpenScanModal = function() {
    certContext = null;
    openModal();
  };
  // Downscale an image to a data URL for STORAGE (RSO/AHPRA review copy). Kept at a
  // higher resolution than the AI-upload copy so fine print stays legible, but still
  // small enough to PUT through the serverless body-size limit. Falls back to the raw
  // data URL for non-images or if canvas decoding fails (e.g. some HEIC files).
  function downscaleImageToDataUrl(file, maxDim, quality) {
    if (!isImageFile(file)) return fileToDataUrlRaw(file);
    return downscaleImageToBase64(file, maxDim || 2400, quality || 0.88)
      .then(function (out) { return base64ToDataUrl(out.base64, out.mimeType); })
      .catch(function () { return fileToDataUrlRaw(file); });
  }
  function fileToDataUrlRaw(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(typeof reader.result === "string" ? reader.result : ""); };
      reader.onerror = function () { reject(new Error("file_read_failed")); };
      reader.readAsDataURL(file);
    });
  }

  window.gpFileToBase64 = fileToBase64;
  window.gpPrepareScanUpload = prepareScanUpload;
  window.gpReadJsonResponse = readJsonResponse;
  window.gpDownscaleImageDataUrl = downscaleImageToDataUrl;

  /** Open scan modal in certification mode for a specific document */
  window.gpOpenCertScan = function(docKey, docTitle, onComplete) {
    certContext = { key: docKey, title: docTitle, callback: onComplete };
    openModal();
  };

  /* ── File selection ── */
  function pickFile(file) {
    if (!isAiScannableFile(file)) {
      showScanError("Please upload a PDF or image file for the scan.");
      return;
    }
    selectedFile = file;
    var card = document.getElementById("gpScanFileCard");
    var nameEl = document.getElementById("gpScanFileName");
    var sizeEl = document.getElementById("gpScanFileSize");
    var btn = document.getElementById("gpScanSubmit");
    if (nameEl) nameEl.textContent = file.name;
    if (sizeEl) sizeEl.textContent = formatSize(file.size);
    if (card) card.classList.add("show");
    if (btn) btn.disabled = false;
  }

  function clearFile() {
    selectedFile = null;
    var input = document.getElementById("gpScanFile");
    if (input) input.value = "";
    var card = document.getElementById("gpScanFileCard");
    if (card) card.classList.remove("show");
    var btn = document.getElementById("gpScanSubmit");
    if (btn) btn.disabled = true;
  }

  /* ── Submit scan (uses Claude AI verification) ── */
  var scanInProgress = false;
  function submitScan() {
    if (!selectedFile || scanInProgress) return;
    scanInProgress = true;
    var file = selectedFile;

    showStep("scanning");
    var phaseEl = document.getElementById("gpScanPhase");
    if (phaseEl) phaseEl.textContent = certContext ? "Verifying certification..." : "Analyzing...";

    // Check if it's an image we can send to AI vision
    var isImage = /^image\//i.test(file.type);

    /* ── Certification scan mode ── */
    if (certContext && isImage) {
      var ctx = certContext;
      var imageBase64 = "";
      fileToBase64(file).then(function (base64) {
        imageBase64 = base64;
        return verifyCertifiedDocument(file, {
          docKey: ctx.key,
          documentType: ctx.title || "qualification document"
        });
      }).then(function (data) {
          if (data.ok && data.verification) {
            var v = data.verification;
            var isCertified = !!v.certified;
            var resultEl = document.getElementById("gpScanResult");
            if (resultEl) {
            if (isCertified) {
              resultEl.innerHTML =
                '<div class="ok"><svg viewBox="0 0 24 24" width="56" height="56" stroke="currentColor" fill="none" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></div>' +
                '<h4>Scan Successful</h4>' +
                '<p>Document and certification verified for <strong>' + esc(ctx.title) + '</strong></p>' +
                '<button class="scan-submit" data-scan-action="certdone" type="button">Done</button>';
            } else {
              var issuesList = humanizeScanIssues((v.issues && v.issues.length > 0) ? v.issues : ["The document does not appear to be properly certified."], {
                docKey: ctx.key,
                documentTitle: ctx.title,
                mode: "certification"
              });
              resultEl.innerHTML =
                '<div class="err"><svg viewBox="0 0 24 24" width="56" height="56" stroke="currentColor" fill="none" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>' +
                '<h4>Scan Failed</h4>' +
                '<p style="color:#dc2626;font-size:13px;line-height:1.5;">' + issuesList.map(esc).join("<br>") + '</p>' +
                '<p style="font-size:12px;color:#64748b;margin-top:8px;">Please adjust accordingly and try again.</p>' +
                '<button class="scan-submit" data-scan-action="another" type="button">Try Again</button>' +
                '<button class="scan-btn-outline" data-scan-action="close" type="button">Cancel</button>';
            }
          }
            if (ctx.callback) {
              ctx.callback({
                fileName: file.name,
                certified: isCertified,
                verification: v,
                mimeType: file.type || "application/octet-stream",
                fileSize: Number(file.size || 0),
                fileDataUrl: base64ToDataUrl(imageBase64, file.type || "application/octet-stream")
              });
            }
            showStep("result");
        } else {
          throw new Error(data.message || "Could not verify this document.");
        }
      }).catch(function (err) {
        showScanError(err && err.message ? err.message : err);
      });
      return;
    }

    /* ── Certification mode for non-image (PDF etc.) — full verification flow ── */
    if (certContext && !isImage) {
      var ctx2 = certContext;
      var pdfBase64 = "";
      fileToBase64(file).then(function (base64) {
        pdfBase64 = base64;
        return verifyCertifiedDocument(file, {
          docKey: ctx2.key,
          documentType: ctx2.title || "qualification document"
        });
      }).then(function (data) {
        if (data.ok && data.verification) {
          var v = data.verification;
          var isCertified = !!v.certified;
          var resultEl2 = document.getElementById("gpScanResult");
          if (resultEl2) {
            if (isCertified) {
              resultEl2.innerHTML =
                '<div class="ok"><svg viewBox="0 0 24 24" width="56" height="56" stroke="currentColor" fill="none" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></div>' +
                '<h4>Scan Successful</h4>' +
                '<p>Document and certification verified for <strong>' + esc(ctx2.title) + '</strong></p>' +
                '<button class="scan-submit" data-scan-action="certdone" type="button">Done</button>';
            } else {
              var issuesList = humanizeScanIssues((v.issues && v.issues.length > 0) ? v.issues : ["The document does not appear to be properly certified."], {
                docKey: ctx2.key,
                documentTitle: ctx2.title,
                mode: "certification"
              });
              resultEl2.innerHTML =
                '<div class="err"><svg viewBox="0 0 24 24" width="56" height="56" stroke="currentColor" fill="none" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>' +
                '<h4>Scan Failed</h4>' +
                '<p style="color:#dc2626;font-size:13px;line-height:1.5;">' + issuesList.map(esc).join("<br>") + '</p>' +
                '<p style="font-size:12px;color:#64748b;margin-top:8px;">Please adjust accordingly and try again.</p>' +
                '<button class="scan-submit" data-scan-action="another" type="button">Try Again</button>' +
                '<button class="scan-btn-outline" data-scan-action="close" type="button">Cancel</button>';
            }
          }
          if (ctx2.callback) {
            ctx2.callback({
              fileName: file.name,
              certified: isCertified,
              verification: v,
              mimeType: file.type || "application/pdf",
              fileSize: Number(file.size || 0),
              fileDataUrl: base64ToDataUrl(pdfBase64, file.type || "application/pdf")
            });
          }
          showStep("result");
        } else {
          throw new Error((data && data.message) || "Could not verify this document.");
        }
      }).catch(function (err) {
        showScanError(err && err.message ? err.message : err);
      });
      return;
    }

    if (isImage) {
      // Use the Claude AI verification endpoint (standard qualification scan)
      prepareScanUpload(file).then(function (prep) {
        return fetch("/api/ai/verify-qualification", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageBase64: prep.base64,
            mimeType: prep.mimeType,
            documentType: "Unknown - identify this document",
            expectedCountry: "any",
            profileName: getProfileName()
          })
        });
      }).then(readJsonResponse).then(function (data) {
        if (data.ok && data.verification) {
          var v = data.verification;
          var friendlyIssues = humanizeScanIssues(v.issues, { documentTitle: v.documentType || "Document", mode: "qualification", allowEmpty: true });
          v.issues = friendlyIssues;
          var docType = v.documentType || "Document";
          var nameFound = v.nameFound || "";
          var dateFound = v.dateFound || "";
          var verified = v.verified;
          var nameMatch = v.nameMatch || "unknown";
          var nameMismatch = nameMatch === "mismatch";

          // If name mismatch, override verified to false
          if (nameMismatch) verified = false;

          // Save to localStorage
          try {
            var raw = localStorage.getItem("gp_documents_prep");
            var state = raw ? JSON.parse(raw) : { country: "uk", docs: {} };
            if (!state.docs) state.docs = {};
            var key = (docType || "unknown").toLowerCase().replace(/[^a-z0-9]/g, "_");
            state.docs[key] = {
              uploaded: true,
              fileName: file.name,
              status: verified ? "verified" : (nameMismatch ? "name_mismatch" : "under_review"),
              source: "ai_scan",
              docType: docType,
              nameFound: nameFound,
              nameMatch: nameMatch,
              dateFound: dateFound,
              updatedAt: new Date().toISOString()
            };
            localStorage.setItem("gp_documents_prep", JSON.stringify(state));
            if (window.gpLinkStateSync && window.gpLinkStateSync.push) window.gpLinkStateSync.push();
          } catch (e) {}

          // Also PUT to server so the verification pipeline can run (image branch)
          try {
            var _canonKey = canonicalQualKey(docType);
            if (_canonKey) {
              var _mime = file.type || 'image/jpeg';
              fetch('/api/prepared-documents', {
                method: 'PUT', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  country: (state && state.country) || 'uk',
                  key: _canonKey,
                  fileName: file.name,
                  mimeType: _mime,
                  fileSize: file.size || 0,
                  fileDataUrl: 'data:' + _mime + ';base64,' + base64
                })
              }).catch(function(){});
            }
          } catch (e) {}

          var resultEl = document.getElementById("gpScanResult");
          if (resultEl) {
            var issuesHtml = "";
            if (friendlyIssues && friendlyIssues.length > 0) {
              issuesHtml = '<p style="color:#dc2626;font-size:12px;">' + friendlyIssues.map(esc).join("<br>") + '</p>';
            }
            var nameColor = nameMismatch ? "#dc2626" : "#64748b";
            var nameLabel = nameMismatch ? "Name (mismatch): " : "Name: ";
            resultEl.innerHTML =
              '<div class="' + (verified ? "ok" : "err") + '"><svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" fill="none" stroke-width="2">' +
              (verified ? '<polyline points="20 6 9 17 4 12"/>' : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>') +
              '</svg></div>' +
              '<h4>' + (verified ? "Document Verified" : (nameMismatch ? "Name Mismatch" : "Needs Review")) + '</h4>' +
              '<p>Identified as: <strong>' + esc(docType) + '</strong></p>' +
              (nameFound ? '<p style="font-size:12px;color:' + nameColor + ';">' + nameLabel + esc(nameFound) + (dateFound ? ' &middot; Date: ' + esc(dateFound) : '') + '</p>' : '') +
              issuesHtml +
              '<button class="scan-submit" data-scan-action="viewdocs" type="button">View in My Documents</button>' +
              '<button class="scan-btn-outline" data-scan-action="another" type="button">Scan another</button>';
          }
          showStep("result");
        } else {
          throw new Error(data.message || "Could not verify this document.");
        }
      }).catch(function (err) {
        showScanError(err && err.message ? err.message : err);
      });
    } else {
      // For PDFs/non-images, use the same AI verification endpoint (supports PDFs)
      prepareScanUpload(file).then(function (prep) {
        return fetch("/api/ai/verify-qualification", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageBase64: prep.base64,
            mimeType: prep.mimeType,
            documentType: "Unknown - identify this document",
            expectedCountry: "any",
            profileName: getProfileName()
          })
        });
      }).then(readJsonResponse).then(function (data) {
        if (data.ok && data.verification) {
          var v = data.verification;
          var friendlyIssues = humanizeScanIssues(v.issues, { documentTitle: v.documentType || "Document", mode: "qualification", allowEmpty: true });
          v.issues = friendlyIssues;
          var docType = v.documentType || "Document";
          var nameFound = v.nameFound || "";
          var dateFound = v.dateFound || "";
          var verified = v.verified;
          var nameMatch = v.nameMatch || "unknown";
          var nameMismatch = nameMatch === "mismatch";

          if (nameMismatch) verified = false;

          try {
            var raw = localStorage.getItem("gp_documents_prep");
            var state = raw ? JSON.parse(raw) : { country: "uk", docs: {} };
            if (!state.docs) state.docs = {};
            var key = (docType || "unknown").toLowerCase().replace(/[^a-z0-9]/g, "_");
            state.docs[key] = {
              uploaded: true,
              fileName: file.name,
              status: verified ? "verified" : (nameMismatch ? "name_mismatch" : "under_review"),
              source: "ai_scan",
              docType: docType,
              nameFound: nameFound,
              nameMatch: nameMatch,
              dateFound: dateFound,
              updatedAt: new Date().toISOString()
            };
            localStorage.setItem("gp_documents_prep", JSON.stringify(state));
            if (window.gpLinkStateSync && window.gpLinkStateSync.push) window.gpLinkStateSync.push();
          } catch (e) {}

          // Also PUT to server so the verification pipeline can run (PDF branch)
          try {
            var _canonKey = canonicalQualKey(docType);
            if (_canonKey) {
              var _mime = file.type || 'application/pdf';
              fetch('/api/prepared-documents', {
                method: 'PUT', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  country: (state && state.country) || 'uk',
                  key: _canonKey,
                  fileName: file.name,
                  mimeType: _mime,
                  fileSize: file.size || 0,
                  fileDataUrl: 'data:' + _mime + ';base64,' + base64
                })
              }).catch(function(){});
            }
          } catch (e) {}

          var resultEl = document.getElementById("gpScanResult");
          if (resultEl) {
            var issuesHtml = "";
            if (friendlyIssues && friendlyIssues.length > 0) {
              issuesHtml = '<p style="color:#dc2626;font-size:12px;">' + friendlyIssues.map(esc).join("<br>") + '</p>';
            }
            var nameColor = nameMismatch ? "#dc2626" : "#64748b";
            var nameLabel = nameMismatch ? "Name (mismatch): " : "Name: ";
            resultEl.innerHTML =
              '<div class="' + (verified ? "ok" : "err") + '"><svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" fill="none" stroke-width="2">' +
              (verified ? '<polyline points="20 6 9 17 4 12"/>' : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>') +
              '</svg></div>' +
              '<h4>' + (verified ? "Document Verified" : (nameMismatch ? "Name Mismatch" : "Needs Review")) + '</h4>' +
              '<p>Identified as: <strong>' + esc(docType) + '</strong></p>' +
              (nameFound ? '<p style="font-size:12px;color:' + nameColor + ';">' + nameLabel + esc(nameFound) + (dateFound ? ' &middot; Date: ' + esc(dateFound) : '') + '</p>' : '') +
              issuesHtml +
              '<button class="scan-submit" data-scan-action="viewdocs" type="button">View in My Documents</button>' +
              '<button class="scan-btn-outline" data-scan-action="another" type="button">Scan another</button>';
          }
          showStep("result");
        } else {
          throw new Error(data.message || "Could not verify this document.");
        }
      }).catch(function (err) {
        showScanError(err && err.message ? err.message : err);
      });
    }
  }

  function showScanError(msg) {
    scanInProgress = false;
    var resultEl = document.getElementById("gpScanResult");
    var friendlyIssues = humanizeScanIssues([msg || "Something went wrong."], {});
    if (resultEl) {
      resultEl.innerHTML =
        '<div class="err"><svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" fill="none" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div>' +
        '<h4>Scan Failed</h4>' +
        '<p>' + friendlyIssues.map(esc).join("<br>") + '</p>' +
        '<button class="scan-btn-outline" data-scan-action="another" type="button">Try again</button>';
    }
    showStep("result");
  }

  /* ── Event handling ── */
  /* ──────────────────────────────────────────────────────────────────────
   *  Guided scan router (Option B) — what the nav "Scan" button opens.
   *  Reads the GP's outstanding CERTIFIED documents from the shared gpDocPrep
   *  brain (certified-copies-first), routes each through the proven
   *  gpOpenCertScan flow, and persists via gpDocPrep so My Documents reflects
   *  it. Works from any page, before the AHPRA step. Falls back to the legacy
   *  generic modal if gpDocPrep isn't present.
   * ────────────────────────────────────────────────────────────────────── */
  var ROUTER_ID = "gpScanRouterOverlay";
  var routerDropdownOpen = false;
  var routerShowAll = false;
  var pendingRouterReturn = false;
  var DOC_ICON = '<svg viewBox="0 0 24 24"><path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/></svg>';

  function injectRouterStyles() {
    if (document.getElementById("gpScanRouterStyle")) return;
    var s = document.createElement("style");
    s.id = "gpScanRouterStyle";
    s.textContent =
      "#" + ROUTER_ID + "{position:fixed;inset:0;z-index:9998;display:flex;align-items:flex-end;justify-content:center;background:rgba(15,23,42,.45);opacity:0;visibility:hidden;pointer-events:none;transition:opacity .3s ease,visibility 0s linear .34s;}" +
      "#" + ROUTER_ID + ".open{opacity:1;visibility:visible;pointer-events:auto;transition:opacity .3s ease,visibility 0s;}" +
      ".gsr-sheet{width:100%;max-width:500px;max-height:90vh;overflow-y:auto;background:#fff;border-radius:20px 20px 0 0;padding:0 16px calc(env(safe-area-inset-bottom,0) + 18px);font-family:'DM Sans',system-ui,sans-serif;transform:translateY(100%);transition:transform .34s cubic-bezier(.32,.72,0,1);will-change:transform;}" +
      "#" + ROUTER_ID + ".open .gsr-sheet{transform:translateY(0);}" +
      ".gsr-grip{width:40px;height:4px;border-radius:4px;background:#d1d5db;margin:10px auto 2px;}" +
      ".gsr-hdr{display:flex;align-items:center;justify-content:space-between;padding:8px 4px;}" +
      ".gsr-hdr h3{margin:0;font-size:17px;font-weight:800;color:#0f172a;}" +
      ".gsr-x{border:0;background:0;font-size:24px;color:#94a3b8;cursor:pointer;line-height:1;padding:4px 8px;}" +
      ".gsr-prog{padding:2px 4px 12px;}" +
      ".gsr-prog-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px;}" +
      ".gsr-prog-top .l{font-size:12px;font-weight:700;color:#64748b;}" +
      ".gsr-prog-top .c{font-size:12px;font-weight:800;color:#2563eb;}" +
      ".gsr-bar{height:7px;border-radius:99px;background:#e2e8f0;overflow:hidden;}" +
      ".gsr-bar>span{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#3b82f6,#2563eb);}" +
      ".gsr-ahead{margin-top:10px;font-size:11.5px;color:#166534;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:8px 10px;font-weight:600;line-height:1.4;}" +
      ".gsr-next{border:1.5px solid #bfdbfe;border-radius:16px;padding:15px;background:linear-gradient(180deg,#f5f9ff,#fff);margin:6px 0 12px;}" +
      ".gsr-next .lbl{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:#2563eb;font-weight:800;margin-bottom:6px;}" +
      ".gsr-next .ttl{font-size:16px;font-weight:800;color:#0f172a;margin-bottom:8px;line-height:1.3;}" +
      ".gsr-chip{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 9px;border-radius:999px;background:#fef3c7;color:#92400e;}" +
      ".gsr-scan-btn{display:block;width:100%;margin-top:13px;padding:14px;border:0;border-radius:13px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;font-size:14px;font-weight:800;cursor:pointer;}" +
      ".gsr-dd{border:1px solid #e2e8f0;border-radius:13px;overflow:hidden;background:#fff;}" +
      ".gsr-dd-toggle{display:flex;align-items:center;justify-content:space-between;width:100%;padding:14px;border:0;background:#fff;cursor:pointer;font-size:13.5px;font-weight:700;color:#0f172a;}" +
      ".gsr-dd-toggle .n{font-size:11px;font-weight:800;color:#2563eb;background:#eff6ff;border-radius:999px;padding:1px 8px;margin-left:8px;}" +
      ".gsr-dd-toggle .chev{color:#94a3b8;font-size:11px;display:inline-block;transition:transform .25s ease;}" +
      ".gsr-dd.open .gsr-dd-toggle .chev{transform:rotate(180deg);}" +
      ".gsr-dd-body{max-height:0;overflow:hidden;transition:max-height .3s ease;}" +
      ".gsr-dd.open .gsr-dd-body{border-top:1px solid #e2e8f0;}" +
      ".gsr-dd-inner{padding:6px;}" +
      ".gsr-row{display:flex;align-items:center;gap:10px;padding:11px 10px;border-radius:10px;cursor:pointer;width:100%;border:0;background:0;text-align:left;}" +
      ".gsr-row+.gsr-row{border-top:1px solid #f1f5f9;}" +
      ".gsr-row .ic{width:26px;height:26px;border-radius:7px;background:#eff6ff;display:flex;align-items:center;justify-content:center;flex:0 0 auto;}" +
      ".gsr-row .ic svg{width:15px;height:15px;stroke:#3b82f6;fill:none;stroke-width:1.7;}" +
      ".gsr-row .nm{flex:1;min-width:0;}" +
      ".gsr-row .nm .t{font-size:13px;font-weight:700;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}" +
      ".gsr-row .nm .s{font-size:10.5px;font-weight:700;color:#92400e;margin-top:2px;}" +
      ".gsr-row .go{color:#cbd5e1;font-size:16px;}" +
      ".gsr-done{text-align:center;padding:26px 14px 8px;}" +
      ".gsr-done .ring{width:70px;height:70px;border-radius:50%;background:#dcfce7;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;color:#16a34a;font-size:34px;font-weight:900;}" +
      ".gsr-done h4{margin:0 0 8px;font-size:18px;font-weight:850;color:#0f172a;}" +
      ".gsr-done p{margin:0 auto 16px;font-size:13px;color:#64748b;line-height:1.5;max-width:260px;}" +
      ".gsr-ghost{display:block;width:100%;margin-top:8px;padding:12px;border:1px solid #e2e8f0;border-radius:12px;background:#fff;color:#0f172a;font-size:13px;font-weight:700;cursor:pointer;}" +
      ".gsr-chooser{padding:8px 4px 6px;}" +
      ".gsr-chooser p{font-size:13px;color:#64748b;margin:0 0 14px;line-height:1.5;}" +
      ".gsr-cbtn{display:flex;align-items:center;justify-content:space-between;width:100%;padding:14px;margin-bottom:9px;border:1px solid #e2e8f0;border-radius:13px;background:#fafbfc;font-size:14px;font-weight:700;color:#0f172a;cursor:pointer;}" +
      ".gsr-cbtn .go{color:#cbd5e1;font-size:16px;}";
    document.head.appendChild(s);
  }

  function ensureRouter() {
    var el = document.getElementById(ROUTER_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = ROUTER_ID;
    el.innerHTML =
      '<div class="gsr-sheet">' +
        '<div class="gsr-grip"></div>' +
        '<div class="gsr-hdr"><h3>Scan a document</h3><button class="gsr-x" type="button" data-router-action="close">&times;</button></div>' +
        '<div id="gpScanRouterBody"></div>' +
      '</div>';
    document.body.appendChild(el);
    return el;
  }

  function routerDocRow(doc) {
    var cert = doc.help && doc.help.certNote;
    return '<button class="gsr-row" type="button" data-router-doc="' + esc(doc.key) + '">' +
      '<span class="ic">' + DOC_ICON + '</span>' +
      '<span class="nm"><span class="t">' + esc(doc.title) + '</span>' + (cert ? '<span class="s">⚠ Certified copy needed</span>' : '') + '</span>' +
      '<span class="go">›</span>' +
    '</button>';
  }

  function renderRouter() {
    var body = document.getElementById("gpScanRouterBody");
    var dp = window.gpDocPrep;
    if (!body || !dp) return;

    if (!dp.hasCountry()) {
      body.innerHTML =
        '<div class="gsr-chooser">' +
          '<p>Where did you train? We’ll show the documents you need to prepare.</p>' +
          '<button class="gsr-cbtn" type="button" data-router-country="United Kingdom">United Kingdom <span class="go">›</span></button>' +
          '<button class="gsr-cbtn" type="button" data-router-country="Ireland">Ireland <span class="go">›</span></button>' +
          '<button class="gsr-cbtn" type="button" data-router-country="New Zealand">New Zealand <span class="go">›</span></button>' +
        '</div>';
      return;
    }

    var country = dp.getCountry();
    var prog = dp.getProgress(country);
    var list = routerShowAll ? dp.getScannableDocs(country) : dp.getOutstandingScannable(country);

    if (!routerShowAll && list.length === 0) {
      body.innerHTML =
        '<div class="gsr-done">' +
          '<div class="ring">✓</div>' +
          '<h4>You’re all caught up</h4>' +
          '<p>Every document we need has been scanned and saved. We’ll let you know if anything needs a re-scan.</p>' +
          '<button class="gsr-ghost" type="button" data-router-action="rescan">Re-scan a document</button>' +
        '</div>';
      return;
    }

    var pct = prog.total ? Math.round((prog.prepared / prog.total) * 100) : 0;
    var html = '<div class="gsr-prog">' +
      '<div class="gsr-prog-top"><span class="l">Documents prepared</span><span class="c">' + prog.prepared + ' of ' + prog.total + '</span></div>' +
      '<div class="gsr-bar"><span style="width:' + pct + '%"></span></div>' +
      (routerShowAll ? '' : '<div class="gsr-ahead">💡 Get ahead now — certified copies can take a week or two to arrange. No need to wait for the AHPRA step.</div>') +
    '</div>';

    var suggested = list[0];
    var rest = list.slice(1);
    var certNext = suggested.help && suggested.help.certNote;
    html += '<div class="gsr-next">' +
      '<div class="lbl">' + (routerShowAll ? 'Choose a document' : 'Suggested next') + '</div>' +
      '<div class="ttl">' + esc(suggested.title) + '</div>' +
      (certNext ? '<span class="gsr-chip">⚠ Certified copy needed</span>' : '') +
      '<button class="gsr-scan-btn" type="button" data-router-doc="' + esc(suggested.key) + '">Scan this now</button>' +
    '</div>';

    if (rest.length) {
      html += '<div class="gsr-dd">' +
        '<button class="gsr-dd-toggle" type="button" data-router-action="toggle">' +
          '<span>Pick another document<span class="n">' + rest.length + ' left</span></span>' +
          '<span class="chev">▼</span>' +
        '</button>' +
        '<div class="gsr-dd-body"><div class="gsr-dd-inner">' + rest.map(routerDocRow).join('') + '</div></div>' +
      '</div>';
    }
    body.innerHTML = html;
  }

  function openRouter() {
    if (!window.gpDocPrep) { openModal(); return; }  // safety fallback to legacy modal
    injectRouterStyles();
    var el = ensureRouter();
    routerDropdownOpen = false;
    routerShowAll = false;
    renderRouter();
    void el.offsetWidth;            // flush styles so the slide-up transition plays on first open
    el.classList.add("open");
  }

  function closeRouter() {
    var el = document.getElementById(ROUTER_ID);
    if (el) el.classList.remove("open");
  }

  function routeDoc(docKey) {
    var dp = window.gpDocPrep;
    if (!dp || !window.gpOpenCertScan) return;
    var country = dp.getCountry();
    var doc = dp.getScannableDocs(country).filter(function (d) { return d.key === docKey; })[0];
    if (!doc) return;
    pendingRouterReturn = true;
    closeRouter();
    window.gpOpenCertScan(doc.key, doc.title, function (result) {
      if (result && result.certified) {
        var storedFile = {
          fileName: result.fileName,
          mimeType: typeof result.mimeType === "string" ? result.mimeType : "image/jpeg",
          fileSize: Number(result.fileSize || 0),
          fileDataUrl: typeof result.fileDataUrl === "string" ? result.fileDataUrl : ""
        };
        dp.markPreparedCertified(country, doc.key, storedFile, result.verification).catch(function () {});
      }
      // On failure the scan modal already shows its "Scan Failed / Try Again" UI.
    });
  }

  function returnToRouterIfPending() {
    if (!pendingRouterReturn) return false;
    pendingRouterReturn = false;
    setTimeout(openRouter, 60);
    return true;
  }

  window.gpOpenScanRouter = openRouter;

  document.addEventListener("click", function (e) {
    var target = e.target;
    if (!(target instanceof Element)) return;

    // 0) Guided scan router interactions
    if (target.id === ROUTER_ID) { closeRouter(); return; }
    var rDoc = target.closest("[data-router-doc]");
    if (rDoc) { e.preventDefault(); routeDoc(rDoc.getAttribute("data-router-doc")); return; }
    var rCountry = target.closest("[data-router-country]");
    if (rCountry) { e.preventDefault(); if (window.gpDocPrep) window.gpDocPrep.setCountry(rCountry.getAttribute("data-router-country")); renderRouter(); return; }
    var rAction = target.closest("[data-router-action]");
    if (rAction) {
      e.preventDefault();
      var ra = rAction.getAttribute("data-router-action");
      if (ra === "close") { closeRouter(); return; }
      if (ra === "toggle") {
        routerDropdownOpen = !routerDropdownOpen;
        var dd = rAction.closest(".gsr-dd");
        if (dd) {
          dd.classList.toggle("open", routerDropdownOpen);
          var ddBody = dd.querySelector(".gsr-dd-body");
          if (ddBody) ddBody.style.maxHeight = routerDropdownOpen ? (ddBody.scrollHeight + "px") : "0px";
        }
        return;
      }
      if (ra === "rescan") { routerShowAll = true; routerDropdownOpen = false; renderRouter(); return; }
      return;
    }

    // 1) Scan trigger buttons (in nav bars)
    if (target.closest("[data-qual-scan-trigger]")) {
      e.preventDefault();
      openRouter();
      return;
    }

    // 2) Actions inside the modal
    var action = target.closest("[data-scan-action]");
    if (action) {
      var name = action.getAttribute("data-scan-action");
      if (name === "close") { closeModal(); returnToRouterIfPending(); return; }
      if (name === "camera") {
        // Open camera via QualCamera module
        if (window.QualCamera) {
          closeModal();
          var camOpts = certContext
            ? { docLabel: certContext.title, docKey: certContext.key, requireCert: true }
            : { docLabel: "Scan Document", requireCert: false };
          window.QualCamera.open(camOpts, function (blob, err) {
            if (err) {
              openModal();
              showScanError(err);
              return;
            }
            if (blob) {
              // Create a File-like object from the blob
              var capturedFile = new File([blob], "camera-scan.jpg", { type: "image/jpeg" });
              selectedFile = capturedFile;
              openModal();
              pickFile(capturedFile);
            }
          });
        } else {
          showScanError("Camera is not available. Please use Upload instead.");
        }
        return;
      }
      if (name === "browse") {
        var inp = document.getElementById("gpScanFile");
        if (inp) inp.click();
        return;
      }
      if (name === "remove") { clearFile(); return; }
      if (name === "submit") { submitScan(); return; }
      if (name === "certdone") { closeModal(); certContext = null; returnToRouterIfPending(); return; }
      if (name === "viewdocs") {
        closeModal();
        if (window.gpShellNavigate) window.gpShellNavigate("/pages/my-documents");
        else window.location.href = "/pages/my-documents";
        return;
      }
      if (name === "another") { resetModal(); return; }
      return;
    }

    // 3) Backdrop click closes modal
    if (target.id === MODAL_ID && isOpen) {
      closeModal();
    }
  });

  // File input change
  document.addEventListener("change", function (e) {
    if (e.target && e.target.id === "gpScanFile" && e.target.files && e.target.files[0]) {
      pickFile(e.target.files[0]);
    }
  });

  // ESC to close
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeModal();
  });
})();

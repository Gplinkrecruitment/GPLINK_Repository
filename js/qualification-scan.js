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
      ".scan-bar{width:40px;height:4px;margin:10px auto 0;border-radius:4px;background:#d1d5db;}" +
      ".scan-hdr{display:flex;align-items:center;justify-content:space-between;padding:12px 20px 10px;}" +
      ".scan-hdr h3{margin:0;font-size:17px;font-weight:800;color:#0f172a;}" +
      ".scan-close{border:0;background:0 0;font-size:24px;color:#94a3b8;cursor:pointer;padding:4px 8px;line-height:1;}" +
      ".scan-body{padding:0 20px 20px;}" +
      /* Two-button row for upload vs camera */
      ".scan-actions{display:flex;gap:10px;margin-bottom:14px;}" +
      ".scan-action-btn{flex:1;display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px 12px;border:2px solid #e2e8f0;border-radius:14px;background:#fafbfc;cursor:pointer;transition:border-color .2s,background .2s;}" +
      ".scan-action-btn:active{background:#eff6ff;border-color:#3b82f6;}" +
      ".scan-action-btn svg{width:32px;height:32px;stroke:#3b82f6;fill:none;stroke-width:1.5;}" +
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
    var modal = document.getElementById(MODAL_ID);
    if (modal) modal.classList.remove("open");
  }

  window.gpOpenScanModal = function() {
    certContext = null;
    openModal();
  };
  window.gpFileToBase64 = fileToBase64;

  /** Open scan modal in certification mode for a specific document */
  window.gpOpenCertScan = function(docKey, docTitle, onComplete) {
    certContext = { key: docKey, title: docTitle, callback: onComplete };
    openModal();
  };

  /* ── File selection ── */
  function pickFile(file) {
    if (!isAiScannableFile(file)) {
      showScanError("Please upload a PDF or image file so Claude can scan it.");
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
  function submitScan() {
    if (!selectedFile) return;
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
        return fetch("/api/ai/verify-certification", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageBase64: base64,
            mimeType: file.type || "application/octet-stream",
            documentType: ctx.title || "qualification document"
          })
        });
      }).then(function (res) {
        return res.json();
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
                '<p>Certification verified for <strong>' + ctx.title + '</strong></p>' +
                '<button class="scan-submit" data-scan-action="certdone" type="button">Done</button>';
            } else {
              var issuesList = (v.issues && v.issues.length > 0) ? v.issues : ["The document does not appear to be properly certified."];
              resultEl.innerHTML =
                '<div class="err"><svg viewBox="0 0 24 24" width="56" height="56" stroke="currentColor" fill="none" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>' +
                '<h4>Scan Failed</h4>' +
                '<p style="color:#dc2626;font-size:13px;line-height:1.5;">' + issuesList.join("<br>") + '</p>' +
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
        showScanError(err.message);
      });
      return;
    }

    /* ── Certification mode but non-image (PDF etc.) — use Claude AI to classify ── */
    if (certContext && !isImage) {
      var ctx2 = certContext;
      var resultEl2 = document.getElementById("gpScanResult");
      var docBase64 = "";
      var docDataUrl = "";
      showStep("result");
      if (resultEl2) {
        resultEl2.innerHTML = '<div class="cert-scanning" style="padding:32px 0;text-align:center;"><div class="cert-scan-spinner"></div> Verifying document...</div>';
      }
      fileToBase64(file).then(function(base64) {
        docBase64 = base64;
        docDataUrl = base64ToDataUrl(base64, file.type || "application/pdf");
        return fetch("/api/ai/classify-document", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileBase64: base64, mimeType: /^image\//i.test(file.type || "") ? (file.type || "application/octet-stream") : (file.type || "application/pdf"), expectedKey: ctx2.key, expectedLabel: ctx2.title })
        });
      }).then(function(res) { return res.json(); }).then(function(data) {
        if (data.ok && data.classification && data.classification.matches) {
          var certifyIssue = "Claude identified this as " + ctx2.title + ", but could not verify the certification from this file. Upload a clear image showing the certification statement, signature, occupation and date.";
          if (data.classification && data.classification.reason) {
            certifyIssue += " " + data.classification.reason;
          }
          if (ctx2.callback) ctx2.callback({
            fileName: file.name,
            certified: false,
            verification: { issues: [certifyIssue] },
            mimeType: file.type || "application/pdf",
            fileSize: Number(file.size || 0),
            fileDataUrl: docDataUrl
          });
          if (resultEl2) {
            resultEl2.innerHTML =
              '<div class="fail"><svg viewBox="0 0 24 24" width="56" height="56" stroke="currentColor" fill="none" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>' +
              '<h4>Scan Failed</h4>' +
              '<p>' + certifyIssue + '</p>' +
              '<button class="scan-submit" data-scan-action="another" type="button">Try Again</button>' +
              '<button class="scan-btn-outline" data-scan-action="close" type="button">Cancel</button>';
          }
        } else {
          var reason = "This file does not appear to be the correct document.";
          if (data.classification && data.classification.identifiedAs) {
            reason = "This appears to be <strong>" + data.classification.identifiedAs + "</strong>, not <strong>" + ctx2.title + "</strong>.";
          }
          var reasonPlain = "This file does not appear to be the correct document.";
          if (data.classification && data.classification.identifiedAs) {
            reasonPlain = "This appears to be " + data.classification.identifiedAs + ", not " + ctx2.title + ".";
          }
          if (data.classification && data.classification.reason) {
            reasonPlain += " " + data.classification.reason;
          }
          if (ctx2.callback) ctx2.callback({
            fileName: file.name,
            certified: false,
            verification: { issues: [reasonPlain] },
            mimeType: file.type || "application/pdf",
            fileSize: Number(file.size || 0),
            fileDataUrl: docDataUrl
          });
          if (resultEl2) {
            resultEl2.innerHTML =
              '<div class="fail"><svg viewBox="0 0 24 24" width="56" height="56" stroke="currentColor" fill="none" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>' +
              '<h4>Wrong Document</h4>' +
              '<p>' + reason + '</p>' +
              (data.classification && data.classification.reason ? '<p style="color:#64748b;font-size:13px;">' + data.classification.reason + '</p>' : '') +
              '<p style="color:#64748b;font-size:13px;">Please upload the correct document and try again.</p>' +
              '<button class="scan-submit" data-scan-action="certdone" type="button">OK</button>';
          }
        }
      }).catch(function(err) {
        var failureMessage = err && err.message ? err.message : "Could not verify this document.";
        if (ctx2.callback) ctx2.callback({
          fileName: file.name,
          certified: false,
          verification: { issues: [failureMessage] },
          mimeType: file.type || "application/pdf",
          fileSize: Number(file.size || 0),
          fileDataUrl: docDataUrl
        });
        if (resultEl2) {
          resultEl2.innerHTML =
            '<div class="fail"><svg viewBox="0 0 24 24" width="56" height="56" stroke="currentColor" fill="none" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>' +
            '<h4>Scan Failed</h4>' +
            '<p>' + failureMessage + '</p>' +
            '<button class="scan-submit" data-scan-action="another" type="button">Try Again</button>' +
            '<button class="scan-btn-outline" data-scan-action="close" type="button">Cancel</button>';
        }
      });
      return;
    }

    if (isImage) {
      // Use the Claude AI verification endpoint (standard qualification scan)
      fileToBase64(file).then(function (base64) {
        var profileName = "";
        if (window.gpSessionProfile) {
          profileName = window.gpSessionProfile.full_name || window.gpSessionProfile.name || "";
        }

        return fetch("/api/ai/verify-qualification", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageBase64: base64,
            mimeType: file.type || "application/octet-stream",
            documentType: "Unknown - identify this document",
            expectedCountry: "any",
            profileName: profileName
          })
        });
      }).then(function (res) {
        return res.json();
      }).then(function (data) {
        if (data.ok && data.verification) {
          var v = data.verification;
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

          var resultEl = document.getElementById("gpScanResult");
          if (resultEl) {
            var issuesHtml = "";
            if (v.issues && v.issues.length > 0) {
              issuesHtml = '<p style="color:#dc2626;font-size:12px;">' + v.issues.join("<br>") + '</p>';
            }
            var nameColor = nameMismatch ? "#dc2626" : "#64748b";
            var nameLabel = nameMismatch ? "Name (mismatch): " : "Name: ";
            resultEl.innerHTML =
              '<div class="' + (verified ? "ok" : "err") + '"><svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" fill="none" stroke-width="2">' +
              (verified ? '<polyline points="20 6 9 17 4 12"/>' : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>') +
              '</svg></div>' +
              '<h4>' + (verified ? "Document Verified" : (nameMismatch ? "Name Mismatch" : "Needs Review")) + '</h4>' +
              '<p>Identified as: <strong>' + docType + '</strong></p>' +
              (nameFound ? '<p style="font-size:12px;color:' + nameColor + ';">' + nameLabel + nameFound + (dateFound ? ' &middot; Date: ' + dateFound : '') + '</p>' : '') +
              issuesHtml +
              '<button class="scan-submit" data-scan-action="viewdocs" type="button">View in My Documents</button>' +
              '<button class="scan-btn-outline" data-scan-action="another" type="button">Scan another</button>';
          }
          showStep("result");
        } else {
          throw new Error(data.message || "Could not verify this document.");
        }
      }).catch(function (err) {
        showScanError(err.message);
      });
    } else {
      // For PDFs/non-images, use the same AI verification endpoint (supports PDFs)
      fileToBase64(file).then(function (base64) {
        var profileName = "";
        if (window.gpSessionProfile) {
          profileName = window.gpSessionProfile.full_name || window.gpSessionProfile.name || "";
        }

        return fetch("/api/ai/verify-qualification", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageBase64: base64,
            mimeType: file.type || "application/pdf",
            documentType: "Unknown - identify this document",
            expectedCountry: "any",
            profileName: profileName
          })
        });
      }).then(function (res) {
        return res.json();
      }).then(function (data) {
        if (data.ok && data.verification) {
          var v = data.verification;
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

          var resultEl = document.getElementById("gpScanResult");
          if (resultEl) {
            var issuesHtml = "";
            if (v.issues && v.issues.length > 0) {
              issuesHtml = '<p style="color:#dc2626;font-size:12px;">' + v.issues.join("<br>") + '</p>';
            }
            var nameColor = nameMismatch ? "#dc2626" : "#64748b";
            var nameLabel = nameMismatch ? "Name (mismatch): " : "Name: ";
            resultEl.innerHTML =
              '<div class="' + (verified ? "ok" : "err") + '"><svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" fill="none" stroke-width="2">' +
              (verified ? '<polyline points="20 6 9 17 4 12"/>' : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>') +
              '</svg></div>' +
              '<h4>' + (verified ? "Document Verified" : (nameMismatch ? "Name Mismatch" : "Needs Review")) + '</h4>' +
              '<p>Identified as: <strong>' + docType + '</strong></p>' +
              (nameFound ? '<p style="font-size:12px;color:' + nameColor + ';">' + nameLabel + nameFound + (dateFound ? ' &middot; Date: ' + dateFound : '') + '</p>' : '') +
              issuesHtml +
              '<button class="scan-submit" data-scan-action="viewdocs" type="button">View in My Documents</button>' +
              '<button class="scan-btn-outline" data-scan-action="another" type="button">Scan another</button>';
          }
          showStep("result");
        } else {
          throw new Error(data.message || "Could not verify this document.");
        }
      }).catch(function (err) {
        showScanError(err.message);
      });
    }
  }

  function showScanError(msg) {
    var resultEl = document.getElementById("gpScanResult");
    if (resultEl) {
      resultEl.innerHTML =
        '<div class="err"><svg viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" fill="none" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></div>' +
        '<h4>Scan Failed</h4>' +
        '<p>' + (msg || "Something went wrong.") + '</p>' +
        '<button class="scan-btn-outline" data-scan-action="another" type="button">Try again</button>';
    }
    showStep("result");
  }

  /* ── Event handling ── */
  document.addEventListener("click", function (e) {
    var target = e.target;
    if (!(target instanceof Element)) return;

    // 1) Scan trigger buttons (in nav bars)
    if (target.closest("[data-qual-scan-trigger]")) {
      e.preventDefault();
      openModal();
      return;
    }

    // 2) Actions inside the modal
    var action = target.closest("[data-scan-action]");
    if (action) {
      var name = action.getAttribute("data-scan-action");
      if (name === "close") { closeModal(); return; }
      if (name === "camera") {
        // Open camera via QualCamera module
        if (window.QualCamera) {
          closeModal();
          var camLabel = certContext ? certContext.title : "Scan Document";
          window.QualCamera.open(camLabel, function (blob, err) {
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
      if (name === "certdone") { closeModal(); certContext = null; return; }
      if (name === "viewdocs") { closeModal(); window.location.href = "/pages/my-documents.html"; return; }
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

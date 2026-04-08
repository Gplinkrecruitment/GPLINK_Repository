(function () {
  "use strict";

  const TOTAL_STEPS = 5;
  const STORAGE_KEY = "gp_onboarding";
  const MAX_RETRIES = 5;

  function escHtml(s) {
    if (typeof s !== "string") return "";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Allow clearing onboarding state via ?reset=1 query param
  if (new URLSearchParams(window.location.search).get("reset") === "1") {
    localStorage.removeItem(STORAGE_KEY);
    window.history.replaceState({}, "", window.location.pathname);
  }

  const COUNTRIES = [
    { code: "GB", name: "United Kingdom", flag: "\u{1F1EC}\u{1F1E7}" },
    { code: "IE", name: "Ireland", flag: "\u{1F1EE}\u{1F1EA}" },
    { code: "NZ", name: "New Zealand", flag: "\u{1F1F3}\u{1F1FF}" },
  ];

  const COUNTRY_DOCS = {
    GB: [
      { key: "mrcgp_cert", label: "MRCGP Certificate", type: "MRCGP Certificate" },
      { key: "primary_med_degree", label: "Primary Medical Degree", type: "Primary Medical Degree" },
    ],
    IE: [
      { key: "micgp_cert", label: "MICGP Certificate", type: "MICGP Certificate" },
      { key: "primary_med_degree", label: "Primary Medical Degree", type: "Primary Medical Degree" },
    ],
    NZ: [
      { key: "frnzcgp_cert", label: "FRNZCGP Certificate", type: "FRNZCGP Certificate" },
      { key: "primary_med_degree", label: "Primary Medical Degree", type: "Primary Medical Degree" },
    ],
  };

  // ── State ──────────────────────────────────
  let state = loadState();

  // Migrate old 8-step state to new 5-step layout
  if (state._version !== 2) {
    var stepMap = { 0: 0, 1: 0, 2: 1, 3: 3, 4: 3, 5: 3, 6: 2, 7: 4 };
    if (state.currentStep !== undefined && stepMap[state.currentStep] !== undefined) {
      state.currentStep = stepMap[state.currentStep];
    }
    delete state.specialNotes;
    delete state.cvFile;
    delete state.idFile;
    state._version = 2;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  let currentStep = state.currentStep || 0;
  let childrenCount = state.childrenCount || 1;

  function defaultState() {
    return {
      _version: 2,
      currentStep: 0,
      country: "",
      qualDocs: {},         // { [docKey]: { fileName, status, scanResult, retryCount, nameMatch } }
      accountReviewFlag: false,
      targetDate: "",
      preferredCity: "",
      whoMoving: "",
      childrenCount: 1,
      idVerification: null,
      completedAt: null,
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return { ...defaultState(), ...JSON.parse(raw) };
    } catch (e) { /* ignore */ }
    return defaultState();
  }

  function saveState() {
    state.currentStep = currentStep;
    state.childrenCount = childrenCount;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    fetch("/api/onboarding/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(state),
    }).catch(() => {});
  }

  function triggerButtonHaptic(duration) {
    try {
      if (navigator && typeof navigator.vibrate === "function") {
        navigator.vibrate(duration || 12);
      }
    } catch (e) { /* ignore */ }
  }

  // ── DOM refs ───────────────────────────────
  const shell = document.getElementById("shell");
  const slides = document.querySelectorAll(".slide");
  const dots = document.querySelectorAll(".progress-dot");
  const nextBtn = document.getElementById("nextBtn");
  const skipBtn = document.getElementById("skipBtn");
  const backBtn = document.getElementById("backBtn");
  const loadingOverlay = document.getElementById("loadingOverlay");
  const loadingText = document.getElementById("loadingText");
  const successScreen = document.getElementById("successScreen");

  // ── Country selector ───────────────────────
  const countrySearch = document.getElementById("countrySearch");
  const countryList = document.getElementById("countryList");

  function renderCountryList(filter) {
    const q = (filter || "").toLowerCase().trim();
    const filtered = q
      ? COUNTRIES.filter((c) => c.name.toLowerCase().includes(q))
      : COUNTRIES;
    countryList.innerHTML = "";
    filtered.forEach((c) => {
      const li = document.createElement("li");
      li.dataset.code = c.code;
      li.innerHTML = `<span class="country-flag">${c.flag}</span> ${c.name}`;
      if (state.country === c.code) li.classList.add("selected");
      li.addEventListener("click", () => selectCountry(c));
      countryList.appendChild(li);
    });
  }

  function selectCountry(c) {
    state.country = c.code;
    countrySearch.value = c.name;
    renderCountryList("");
    hideError("countryError");
    const hint = document.getElementById("countryHint");
    if (hint) hint.style.display = "none";
    // Reset qual docs when country changes
    state.qualDocs = {};
    state.accountReviewFlag = false;
    saveState();
  }

  countrySearch.addEventListener("input", () => renderCountryList(countrySearch.value));
  countrySearch.addEventListener("focus", () => renderCountryList(countrySearch.value));
  renderCountryList("");

  if (state.country) {
    const match = COUNTRIES.find((c) => c.code === state.country);
    if (match) countrySearch.value = match.name;
  }

  // ── Qualification document verification (Step 2) ──
  const qualDocsContainer = document.getElementById("qualDocsContainer");
  let activeDocUploads = {}; // track which docs are currently being scanned
  let unlimitedRetries = false; // set by server response for whitelisted accounts

  function getProfileName() {
    // Try to get name from session profile
    if (window.gpSessionProfile) {
      if (window.gpSessionProfile.full_name) return window.gpSessionProfile.full_name;
      if (window.gpSessionProfile.name) return window.gpSessionProfile.name;
      var fn = (window.gpSessionProfile.firstName || window.gpSessionProfile.first_name || "") + " " + (window.gpSessionProfile.lastName || window.gpSessionProfile.last_name || "");
      if (fn.trim()) return fn.trim();
    }
    return "";
  }

  function stripIssueHtml(s) {
    return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  function getFriendlyIssueTarget(options) {
    var title = options && options.documentTitle ? stripIssueHtml(options.documentTitle) : "";
    title = title.replace(/^certified copy of\s+/i, "").trim();
    return title || "the requested document";
  }

  function humanizeScanIssue(issue, options) {
    var clean = stripIssueHtml(issue);
    var lower = clean.toLowerCase();
    var targetLabel = getFriendlyIssueTarget(options);
    var wrongDocMatch = clean.match(/appears to be\s+(.+?),\s+not\s+(.+?)(?:\.|$)/i);

    if (!clean) {
      return "We could not complete the scan. Please try again with a clear image of the full document.";
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
    if (/does not appear to be the correct document|wrong document|correct document type/.test(lower)) {
      return "This looks like a different document from the one needed here. Please upload " + targetLabel + ".";
    }
    if (wrongDocMatch) {
      return "This looks like " + wrongDocMatch[1] + ", not " + targetLabel + ". Please upload the correct document for this step.";
    }
    if (/dated before|date on the document must be from|issue date/.test(lower)) {
      return "The issue date on this document is outside the accepted date range for this pathway. Please upload the correct certificate or a later version if available.";
    }
    if (/passport or driver.?s licence|identity document/.test(lower)) {
      return "Please upload a passport or driver's licence with the full name clearly visible.";
    }
    if (/queued for review|manual review|verification capacity reached/.test(lower)) {
      return "We could not finish the automatic scan right now, so your document has been sent for manual review.";
    }
    if (/could not connect|failed to connect|network error|ai service returned an error/.test(lower)) {
      return "We could not reach the scan service just now. Please try again in a moment.";
    }
    if (/could not verify identity/.test(lower)) {
      return "We could not verify your identity from this image. Please upload a clear photo of your passport or driver's licence with the full name visible.";
    }
    if (/could not verify this document/.test(lower)) {
      return "We could not verify this document automatically. Please make sure the full document is visible, clear and uploaded in the correct place.";
    }
    return clean;
  }

  function humanizeScanIssues(issues, options) {
    var list = Array.isArray(issues) ? issues : [issues];
    var out = [];
    list.forEach(function (item) {
      var message = humanizeScanIssue(item, options);
      if (message && out.indexOf(message) === -1) out.push(message);
    });
    if (!out.length) {
      out.push("We could not complete the scan. Please try again with a clear image of the full document.");
    }
    return out;
  }

  function canBypassOnboardingValidation() {
    const email = window.gpSessionProfile && typeof window.gpSessionProfile.email === "string"
      ? window.gpSessionProfile.email.trim().toLowerCase()
      : "";
    return email === "smithmiller1234@gmail.com";
  }

  function renderQualDocSlots() {
    if (!qualDocsContainer) return;
    const docs = COUNTRY_DOCS[state.country] || [];
    qualDocsContainer.innerHTML = "";

    if (docs.length === 0) {
      qualDocsContainer.innerHTML = '<p style="color:var(--muted);font-size:14px;">Select a country first.</p>';
      return;
    }

    docs.forEach((doc, idx) => {
      const docState = (state.qualDocs && state.qualDocs[doc.key]) || {};
      const status = docState.status || "pending";
      const retryCount = docState.retryCount || 0;

      const slot = document.createElement("div");
      slot.className = "qual-doc-slot" + (status === "verified" ? " verified" : status === "failed" ? " failed" : status === "scanning" ? " scanning" : "");
      slot.id = "qualSlot_" + doc.key;

      // Badge
      let badgeClass = "pending", badgeText = "Required";
      if (status === "verified") { badgeClass = "verified"; badgeText = "Verified"; }
      else if (status === "verified_name_pending") { badgeClass = "verified"; badgeText = "Verified"; }
      else if (status === "support_requested") { badgeClass = "review"; badgeText = "Support Contacted"; }
      else if (status === "failed") { badgeClass = "failed"; badgeText = "Failed"; }
      else if (status === "scanning") { badgeClass = "scanning"; badgeText = "Scanning..."; }
      else if (status === "manual_review") { badgeClass = "review"; badgeText = "Under Review"; }

      let infoHtml = "";
      if (status === "scanning") {
        infoHtml = '<div class="qual-doc-slot-info"><span class="qual-doc-spinner"></span> Checking your document now...</div>';
      } else if (status === "verified" || status === "verified_name_pending") {
        infoHtml = '<div class="qual-doc-slot-info" style="color:var(--green);">&#10003; Verified — one less thing to think about.</div>';
      } else if (status === "failed" && retryCount >= MAX_RETRIES) {
        infoHtml = '<div class="qual-doc-slot-info error">We\'ll have a team member verify this personally. No action needed from you.</div>';
        infoHtml += '<button class="qual-support-btn" data-support-doc="' + doc.key + '" type="button">Contact Support</button>';
      } else if (status === "failed") {
        const issues = humanizeScanIssues((docState.scanResult && docState.scanResult.issues) ? docState.scanResult.issues : ["Verification failed"], { documentTitle: doc.label, mode: "qualification" });
        infoHtml = '<div class="qual-doc-slot-info error">' + issues.map(escHtml).join("<br>") + '</div>';
        infoHtml += '<div class="qual-doc-slot-retry">Attempt ' + retryCount + ' of ' + MAX_RETRIES + '</div>';
        // Actionable tips based on retry count
        var tips = ["Try removing any frame or cover", "Ensure there is no glare on the document", "Hold camera steady and use good lighting", "Try uploading a flat scan or screenshot instead"];
        if (retryCount > 0 && retryCount <= tips.length) {
          infoHtml += '<div class="qual-doc-slot-retry" style="color:var(--primary, #16A34A);">Tip: ' + tips[retryCount - 1] + '</div>';
        }
        infoHtml += '<button class="qual-support-btn" data-support-doc="' + doc.key + '" type="button">Contact Support</button>';
      } else if (status === "support_requested") {
        infoHtml = '<div class="qual-doc-slot-info" style="color:var(--primary, #16A34A);">Support team will verify manually via email</div>';
      } else if (status === "manual_review") {
        var reviewIssues = humanizeScanIssues((docState.scanResult && docState.scanResult.issues) ? docState.scanResult.issues : ["Queued for review"], { documentTitle: doc.label, mode: "qualification" });
        infoHtml = '<div class="qual-doc-slot-info" style="color:var(--primary, #16A34A);">Sent for manual review.<br>' + reviewIssues.map(escHtml).join("<br>") + '</div>';
        infoHtml += '<button class="qual-support-btn" data-support-doc="' + doc.key + '" type="button">Contact Support</button>';
      }

      const showActions = status !== "verified" && status !== "verified_name_pending" && status !== "support_requested" && status !== "scanning" && !(status === "failed" && retryCount >= MAX_RETRIES && !unlimitedRetries) && status !== "manual_review";

      slot.innerHTML =
        '<div class="qual-doc-slot-header">' +
          '<span class="qual-doc-slot-label">' + doc.label + '</span>' +
          '<span class="qual-doc-slot-badge ' + badgeClass + '">' + badgeText + '</span>' +
        '</div>' +
        (showActions ?
          '<div class="qual-doc-slot-actions">' +
            '<button class="qual-doc-btn" data-qual-upload="' + doc.key + '" type="button">' +
              '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
              'Upload' +
            '</button>' +
            '<button class="qual-doc-btn" data-qual-camera="' + doc.key + '" type="button">' +
              '<svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>' +
              'Camera' +
            '</button>' +
          '</div>' +
          '<input type="file" id="qualFileInput_' + doc.key + '" accept="image/*" style="display:none;" />'
        : '') +
        infoHtml;

      qualDocsContainer.appendChild(slot);
    });

    // Wire up events
    qualDocsContainer.querySelectorAll("[data-qual-upload]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.qualUpload;
        const inp = document.getElementById("qualFileInput_" + key);
        if (inp) inp.click();
      });
    });

    qualDocsContainer.querySelectorAll("[data-qual-camera]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.qualCamera;
        const doc = (COUNTRY_DOCS[state.country] || []).find((d) => d.key === key);
        if (!doc || !window.QualCamera) return;
        window.QualCamera.open(doc.label, (blob, err) => {
          if (err) {
            showError("qualDocsError", err);
            return;
          }
          if (blob) handleDocVerification(key, blob, doc.label + ".jpg");
        });
      });
    });

    qualDocsContainer.querySelectorAll("input[type='file']").forEach((inp) => {
      inp.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const key = inp.id.replace("qualFileInput_", "");
        handleDocVerification(key, file, file.name);
      });
    });

    // Contact Support buttons
    qualDocsContainer.querySelectorAll("[data-support-doc]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.supportDoc;
        const doc = (COUNTRY_DOCS[state.country] || []).find((d) => d.key === key);
        if (!doc) return;
        var docState = (state.qualDocs && state.qualDocs[key]) || {};
        var issues = (docState.scanResult && docState.scanResult.issues) || [];
        showSupportPopup(doc.label, doc.type, issues, key);
      });
    });
  }

  function getNameMatchLevel(name1, name2) {
    var noiseParts = {
      dr: true,
      mr: true,
      mrs: true,
      ms: true,
      miss: true,
      mx: true,
      sir: true,
      prof: true,
      professor: true,
      md: true,
      mbbs: true,
      mbchb: true,
      phd: true
    };
    var normalize = function (n) {
      return String(n || "")
        .toLowerCase()
        .trim()
        .replace(/['’]/g, "")
        .replace(/-/g, " ")
        .replace(/[^a-z\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .filter(function (part) { return !noiseParts[part]; });
    };
    var parts1 = normalize(name1);
    var parts2 = normalize(name2);
    if (parts1.length < 2 || parts2.length < 2) return "unknown";
    if (parts1.join(" ") === parts2.join(" ")) return "exact";
    if (parts1[0] !== parts2[0] || parts1[parts1.length - 1] !== parts2[parts2.length - 1]) return "mismatch";

    var middle1 = parts1.slice(1, -1);
    var middle2 = parts2.slice(1, -1);
    if (!middle1.length || !middle2.length) return "fuzzy";

    var shorter = middle1.length <= middle2.length ? middle1 : middle2;
    var longer = middle1.length <= middle2.length ? middle2 : middle1;
    var longIdx = 0;
    for (var i = 0; i < shorter.length; i++) {
      var token = shorter[i];
      var matched = false;
      while (longIdx < longer.length) {
        var candidate = longer[longIdx++];
        if (!candidate) continue;
        if (token === candidate || token.charAt(0) === candidate.charAt(0)) {
          matched = true;
          break;
        }
      }
      if (!matched) return "mismatch";
    }
    return "fuzzy";
  }

  // Fuzzy name comparison (client-side mirror of server logic)
  function namesMatch(name1, name2) {
    var match = getNameMatchLevel(name1, name2);
    return match === "exact" || match === "fuzzy";
  }

  function appendIssueOnce(list, message) {
    var next = Array.isArray(list) ? list.slice() : [];
    if (next.indexOf(message) === -1) next.push(message);
    return next;
  }

  function autoUpdateAccountName(docName) {
    var parts = String(docName || "").trim().split(/\s+/);
    if (parts.length < 2) return Promise.resolve(false);
    var firstName = parts[0];
    var lastName = parts.slice(1).join(" ");

    return fetch("/api/account/update-name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ firstName: firstName, lastName: lastName }),
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (!data || !data.ok) return false;
      if (window.gpSessionProfile) {
        window.gpSessionProfile.first_name = firstName;
        window.gpSessionProfile.last_name = lastName;
        window.gpSessionProfile.firstName = firstName;
        window.gpSessionProfile.lastName = lastName;
        window.gpSessionProfile.full_name = firstName + " " + lastName;
        window.gpSessionProfile.name = firstName + " " + lastName;
      }
      return true;
    }).catch(function () {
      return false;
    });
  }

  // After both docs are scanned, confirm the names align with each other and with the account.
  function crossDocNameCheck() {
    var docs = COUNTRY_DOCS[state.country] || [];
    var specialistKey = docs.find(function (d) { return d.key !== "primary_med_degree"; });
    var medDegreeKey = docs.find(function (d) { return d.key === "primary_med_degree"; });
    if (!specialistKey || !medDegreeKey) return;

    var specDoc = state.qualDocs[specialistKey.key];
    var medDoc = state.qualDocs[medDegreeKey.key];
    if (!specDoc || !medDoc) return;

    // Both need to be verified or verified_name_pending
    var specOk = specDoc.status === "verified" || specDoc.status === "verified_name_pending";
    var medOk = medDoc.status === "verified" || medDoc.status === "verified_name_pending";
    if (!specOk || !medOk) return;

    var specName = specDoc.scanResult && specDoc.scanResult.nameFound;
    var medName = medDoc.scanResult && medDoc.scanResult.nameFound;
    if (!specName || !medName) return;

    var profileName = getProfileName();
    var docsMatchLevel = getNameMatchLevel(specName, medName);
    var accountMatchLevel = getNameMatchLevel(medName, profileName);
    var docsMatchEachOther = docsMatchLevel === "exact" || docsMatchLevel === "fuzzy";

    if (docsMatchEachOther && accountMatchLevel === "exact") {
      specDoc.status = "verified";
      medDoc.status = "verified";
      return;
    }

    if (docsMatchEachOther && accountMatchLevel === "fuzzy") {
      specDoc.status = "verified";
      medDoc.status = "verified";
      autoUpdateAccountName(medName).then(function (updated) {
        if (!updated) {
          var msg = "We verified your documents, but could not update your account name automatically. Please refresh or contact support if the name does not update.";
          specDoc.scanResult = specDoc.scanResult || {};
          medDoc.scanResult = medDoc.scanResult || {};
          specDoc.scanResult.issues = appendIssueOnce(specDoc.scanResult.issues, msg);
          medDoc.scanResult.issues = appendIssueOnce(medDoc.scanResult.issues, msg);
          saveState();
          renderQualDocSlots();
        }
      });
      return;
    }

    specDoc.status = "manual_review";
    medDoc.status = "manual_review";
    specDoc.scanResult = specDoc.scanResult || {};
    medDoc.scanResult = medDoc.scanResult || {};

    var msg = docsMatchEachOther
      ? "Your documents show the same name, but it does not match your account profile. Please update your account details or contact support for manual review."
      : "Names on your specialist qualification and medical degree do not match each other.";
    specDoc.scanResult.issues = appendIssueOnce(specDoc.scanResult.issues, msg);
    medDoc.scanResult.issues = appendIssueOnce(medDoc.scanResult.issues, msg);
    state.accountReviewFlag = true;
  }

  // ── Support popup ──────────────────────────
  function showSupportPopup(docLabel, docType, issues, docKey) {
    // Remove existing popup if any
    var existing = document.getElementById("qualSupportPopup");
    if (existing) existing.remove();

    var overlay = document.createElement("div");
    overlay.id = "qualSupportPopup";
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;";

    var card = document.createElement("div");
    card.style.cssText = "background:#1e1e2e;border-radius:16px;padding:28px 24px;max-width:380px;width:100%;text-align:center;font-family:'Inter',sans-serif;";

    card.innerHTML =
      '<div style="width:56px;height:56px;border-radius:50%;background:rgba(59,130,246,0.15);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">' +
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16A34A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
      '</div>' +
      '<h3 style="color:#fff;font-size:18px;font-weight:700;margin:0 0 8px;">Manual Verification Required</h3>' +
      '<p style="color:#94a3b8;font-size:14px;line-height:1.5;margin:0 0 20px;">' +
        'Due to discrepancies in your qualifications, our team will email you to manually verify your qualifications and resume onboarding.' +
      '</p>' +
      '<button id="qualSupportSendBtn" type="button" style="width:100%;padding:14px;border:none;border-radius:12px;background:#16A34A;color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:10px;font-family:inherit;">Send Support Request</button>' +
      '<button id="qualSupportCloseBtn" type="button" style="width:100%;padding:12px;border:none;border-radius:12px;background:transparent;color:#64748b;font-size:14px;cursor:pointer;font-family:inherit;">Close</button>';

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Close
    document.getElementById("qualSupportCloseBtn").addEventListener("click", function () { overlay.remove(); });
    overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.remove(); });

    // Send
    document.getElementById("qualSupportSendBtn").addEventListener("click", function () {
      var btn = this;
      btn.textContent = "Sending...";
      btn.disabled = true;

      fetch("/api/support/qualification-help", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          documentType: docType,
          issues: issues,
          country: state.country
        }),
      })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          // Mark doc as support_requested so user can continue onboarding
          if (docKey && state.qualDocs && state.qualDocs[docKey]) {
            state.qualDocs[docKey].status = "support_requested";
          }
          state.accountReviewFlag = true;
          try { localStorage.setItem("gp_account_under_review", "true"); } catch (e) {}
          saveState();
          renderQualDocSlots();

          card.innerHTML =
            '<div style="width:56px;height:56px;border-radius:50%;background:rgba(34,197,94,0.15);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">' +
              '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
            '</div>' +
            '<h3 style="color:#fff;font-size:18px;font-weight:700;margin:0 0 8px;">Request Sent</h3>' +
            '<p style="color:#94a3b8;font-size:14px;line-height:1.5;margin:0 0 20px;">' +
              'Our team has received your request and will email you to manually verify your qualifications. You can continue with the rest of the onboarding in the meantime.' +
            '</p>' +
            '<button id="qualSupportDoneBtn" type="button" style="width:100%;padding:14px;border:none;border-radius:12px;background:#16A34A;color:#fff;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;">OK</button>';
          document.getElementById("qualSupportDoneBtn").addEventListener("click", function () { overlay.remove(); });
        } else {
          btn.textContent = "Send Support Request";
          btn.disabled = false;
          showError("qualDocsError", data.message || "Failed to send. Please try again.");
        }
      })
      .catch(function () {
        btn.textContent = "Send Support Request";
        btn.disabled = false;
        showError("qualDocsError", "Network error. Please try again.");
      });
    });
  }

  async function handleDocVerification(docKey, fileOrBlob, fileName) {
    if (activeDocUploads[docKey]) return; // prevent double submit
    activeDocUploads[docKey] = true;

    const doc = (COUNTRY_DOCS[state.country] || []).find((d) => d.key === docKey);
    if (!doc) { delete activeDocUploads[docKey]; return; }

    // Initialize doc state
    if (!state.qualDocs) state.qualDocs = {};
    const prev = state.qualDocs[docKey] || {};
    const retryCount = (prev.retryCount || 0) + (prev.status === "failed" ? 0 : 0);

    state.qualDocs[docKey] = {
      fileName: fileName,
      status: "scanning",
      scanResult: null,
      retryCount: prev.retryCount || 0,
      nameMatch: null,
    };
    saveState();
    renderQualDocSlots();

    try {
      const base64 = await fileToBase64(fileOrBlob);
      const mimeType = fileOrBlob.type || "application/octet-stream";
      const fileDataUrl = "data:" + mimeType + ";base64," + base64;

      const resp = await fetch("/api/ai/verify-qualification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          imageBase64: base64,
          mimeType: mimeType,
          documentType: doc.type,
          expectedCountry: state.country,
          profileName: getProfileName(),
        }),
      });

      const data = await resp.json();

      if (data.ok && data.verification) {
        const v = data.verification;
        const nameConfirmed = v.nameMatch === "exact" || v.nameMatch === "fuzzy";
        let shouldPersistDocument = false;
        if (v.verified && nameConfirmed) {
          state.qualDocs[docKey].status = "verified";
          state.qualDocs[docKey].scanResult = v;
          state.qualDocs[docKey].nameMatch = v.nameMatch;
          shouldPersistDocument = true;
        } else if (v.nameMatch === "mismatch") {
          state.qualDocs[docKey].status = "failed";
          state.qualDocs[docKey].retryCount = (state.qualDocs[docKey].retryCount || 0) + 1;
          var nameIssues = (v.issues && v.issues.length > 0) ? v.issues : ["Name on document doesn't match your profile."];
          state.qualDocs[docKey].scanResult = { ...v, issues: humanizeScanIssues(nameIssues, { documentTitle: doc.label, mode: "qualification" }) };
          state.accountReviewFlag = true;
        } else {
          state.qualDocs[docKey].status = "failed";
          state.qualDocs[docKey].retryCount = (state.qualDocs[docKey].retryCount || 0) + 1;
          var failIssues = (v.issues && v.issues.length > 0) ? v.issues : ["Document could not be verified. Check it's the correct document type and clearly visible."];
          state.qualDocs[docKey].scanResult = { ...v, issues: humanizeScanIssues(failIssues, { documentTitle: doc.label, mode: "qualification" }) };
        }

        // Cross-document name matching: check if both docs have names that match each other
        crossDocNameCheck();

        if (shouldPersistDocument) {
          const savedDoc = await saveOnboardingDocumentFile(docKey, fileName, mimeType, fileDataUrl);
          if (savedDoc) {
            state.qualDocs[docKey].storedAt = savedDoc.updatedAt || new Date().toISOString();
          }
        }
      } else if (data.queued) {
        state.qualDocs[docKey].status = "manual_review";
        state.qualDocs[docKey].scanResult = { issues: humanizeScanIssues([data.message || "Queued for review"], { documentTitle: doc.label, mode: "qualification" }) };
      } else {
        state.qualDocs[docKey].status = "failed";
        state.qualDocs[docKey].retryCount = (state.qualDocs[docKey].retryCount || 0) + 1;
        state.qualDocs[docKey].scanResult = { issues: humanizeScanIssues([data.message || "Verification failed"], { documentTitle: doc.label, mode: "qualification" }) };
      }

      // If max retries reached and still failed, flag for review (skip for unlimited accounts)
      var unlimited = data && data.unlimitedRetries;
      if (unlimited) unlimitedRetries = true;
      if (!unlimited && state.qualDocs[docKey].status === "failed" && state.qualDocs[docKey].retryCount >= MAX_RETRIES) {
        state.accountReviewFlag = true;
        state.qualDocs[docKey].status = "manual_review";
      }
    } catch (err) {
      console.error("[QualVerify] Error:", err);
      state.qualDocs[docKey].status = "failed";
      // Network/system errors don't count as verification retries
      state.qualDocs[docKey].scanResult = { issues: humanizeScanIssues([err.message || "Network error. Please try again."], { documentTitle: doc.label, mode: "qualification" }) };
    }

    delete activeDocUploads[docKey];
    saveState();
    renderQualDocSlots();
  }

  function fileToBase64(fileOrBlob) {
    return new Promise((resolve, reject) => {
      if (fileOrBlob.type === "application/pdf") {
        reject(new Error("Please upload an image or use the camera. PDF scanning is not yet supported."));
        return;
      }

      var reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result.split(",")[1] || reader.result);
      };
      reader.onerror = function () { reject(new Error("Failed to read file.")); };
      reader.readAsDataURL(fileOrBlob);
    });
  }

  function getOnboardingDocumentStorageKey(docKey) {
    if (docKey === "primary_med_degree") return "onboarding_primary_med_degree";
    return "onboarding_specialist_qualification";
  }

  async function saveOnboardingDocumentFile(docKey, fileName, mimeType, fileDataUrl) {
    if (!state.country || !fileName || !mimeType || !fileDataUrl) return null;

    const response = await fetch("/api/onboarding-documents", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        country: state.country,
        key: getOnboardingDocumentStorageKey(docKey),
        fileName: fileName,
        mimeType: mimeType,
        fileSize: 0,
        fileDataUrl: fileDataUrl,
      }),
    });

    const data = await response.json().catch(function () { return null; });
    if (!response.ok || !data || !data.ok || !data.document) {
      throw new Error((data && data.message) || "Failed to store onboarding document.");
    }
    return data.document;
  }

  function allDocsComplete() {
    const docs = COUNTRY_DOCS[state.country] || [];
    if (docs.length === 0) return false;
    return docs.every((doc) => {
      const d = state.qualDocs && state.qualDocs[doc.key];
      return d && (d.status === "verified" || d.status === "manual_review" || d.status === "verified_name_pending" || d.status === "support_requested");
    });
  }

  // ── File upload helpers (CV and ID) ─────────
  const MAX_FILE_SIZE = 10 * 1024 * 1024;

  function isValidFile(file) {
    if (file.size > MAX_FILE_SIZE) return { ok: false, reason: "File must be under 10MB." };
    return { ok: true };
  }

  function simulateUpload(file, onProgress) {
    return new Promise((resolve) => {
      let progress = 0;
      const interval = setInterval(() => {
        progress += Math.random() * 30 + 10;
        if (progress >= 100) {
          progress = 100;
          clearInterval(interval);
          onProgress(100);
          setTimeout(resolve, 200);
        } else {
          onProgress(Math.min(progress, 95));
        }
      }, 200);
    });
  }

  // ── Identity verification (step 6) ─────────
  let idVerifyInProgress = false;

  function getQualDocName() {
    // Get the name found on any verified qualification document
    if (!state.qualDocs) return "";
    const docs = COUNTRY_DOCS[state.country] || [];
    for (const doc of docs) {
      const d = state.qualDocs[doc.key];
      if (d && d.scanResult && d.scanResult.nameFound) return d.scanResult.nameFound;
    }
    return "";
  }

  function renderIdVerifyStatus() {
    const statusEl = document.getElementById("idVerifyStatus");
    const actionsEl = document.getElementById("idVerifyActions");
    if (!statusEl || !actionsEl) return;

    const idState = state.idVerification || {};
    const status = idState.status || "pending";

    if (status === "scanning") {
      statusEl.innerHTML = '<div class="qual-doc-slot-info"><span class="qual-doc-spinner"></span> Confirming your identity...</div>';
      actionsEl.style.display = "none";
    } else if (status === "verified") {
      statusEl.innerHTML = '<div class="qual-doc-slot-info" style="color:var(--green);">&#10003; Identity confirmed — your document has been deleted.</div>';
      actionsEl.style.display = "none";
    } else if (status === "failed") {
      const issues = humanizeScanIssues((idState.issues && idState.issues.length) ? idState.issues : ["Verification failed"], { mode: "identity" });
      statusEl.innerHTML = '<div class="qual-doc-slot-info error">' + issues.map(escHtml).join("<br>") + '</div>';
      actionsEl.style.display = "";
    } else if (status === "support_requested") {
      statusEl.innerHTML = '<div class="qual-doc-slot-info" style="color:var(--primary, #16A34A);">Support team will verify manually via email</div>';
      actionsEl.style.display = "none";
    } else {
      statusEl.innerHTML = "";
      actionsEl.style.display = "";
    }
  }

  async function handleIdVerification(fileOrBlob, fileName) {
    if (idVerifyInProgress) return;
    idVerifyInProgress = true;

    state.idVerification = { status: "scanning", fileName: fileName };
    saveState();
    renderIdVerifyStatus();
    hideError("docsError");

    try {
      const base64 = await fileToBase64(fileOrBlob);
      const qualName = getQualDocName();

      const resp = await fetch("/api/ai/verify-identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          imageBase64: base64,
          mimeType: fileOrBlob.type || "application/octet-stream",
          qualificationName: qualName,
          profileName: getProfileName(),
        }),
      });

      const data = await resp.json();

      if (data.ok && data.verification && data.verification.verified) {
        state.idVerification = { status: "verified", fileName: fileName, nameFound: data.verification.nameFound };
      } else {
        const issues = humanizeScanIssues(
          (data.verification && data.verification.issues && data.verification.issues.length)
            ? data.verification.issues
            : [data.message || "Could not verify identity. Please try again with a clear photo of your passport or driver's licence."],
          { mode: "identity" }
        );
        state.idVerification = { status: "failed", fileName: fileName, issues: issues };
      }
    } catch (err) {
      state.idVerification = { status: "failed", fileName: fileName, issues: humanizeScanIssues([err.message || "Network error. Please try again."], { mode: "identity" }) };
    }

    idVerifyInProgress = false;
    saveState();
    renderIdVerifyStatus();
  }

  // Wire up ID verification buttons
  const idVerifyUploadBtn = document.getElementById("idVerifyUploadBtn");
  const idVerifyCameraBtn = document.getElementById("idVerifyCameraBtn");
  const idVerifyFileInput = document.getElementById("idVerifyFileInput");

  if (idVerifyUploadBtn && idVerifyFileInput) {
    idVerifyUploadBtn.addEventListener("click", () => idVerifyFileInput.click());
    idVerifyFileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (idVerifyInProgress) return;
      if (file.size > MAX_FILE_SIZE) { showError("docsError", "File must be under 10MB."); return; }
      handleIdVerification(file, file.name);
    });
  }

  if (idVerifyCameraBtn) {
    idVerifyCameraBtn.addEventListener("click", () => {
      if (!window.QualCamera) return;
      window.QualCamera.open("Passport or Driver's Licence", (blob, err) => {
        if (err) {
          showError("docsError", err);
          return;
        }
        if (blob) handleIdVerification(blob, "ID_capture.jpg");
      });
    });
  }

  // Restore state on load
  renderIdVerifyStatus();

  // ── Date picker ────────────────────────────
  const targetDateInput = document.getElementById("targetDate");
  const minDate = new Date();
  minDate.setMonth(minDate.getMonth() + 5);
  targetDateInput.min = minDate.toISOString().split("T")[0];
  if (state.targetDate) targetDateInput.value = state.targetDate;
  targetDateInput.addEventListener("change", () => {
    state.targetDate = targetDateInput.value;
    const selected = new Date(targetDateInput.value);
    if (selected < minDate) {
      showError("dateError", "Your target date must be at least 5 months from today.");
    } else {
      hideError("dateError");
    }
    saveState();
  });

  // ── City selector ──────────────────────────
  const citySelect = document.getElementById("preferredCity");
  if (state.preferredCity) citySelect.value = state.preferredCity;
  citySelect.addEventListener("change", () => {
    state.preferredCity = citySelect.value;
    hideError("cityError");
    saveState();
  });

  // ── Who is moving ──────────────────────────
  const whoCards = document.querySelectorAll("#whoMovingGrid .option-card");
  const childrenWrap = document.getElementById("childrenCountWrap");
  const childCountEl = document.getElementById("childCount");

  function updateWhoUI() {
    whoCards.forEach((c) => {
      c.classList.toggle("selected", c.dataset.value === state.whoMoving);
    });
    const hasChildren = state.whoMoving === "me_children" || state.whoMoving === "me_partner_children";
    childrenWrap.classList.toggle("show", hasChildren);
    childCountEl.textContent = childrenCount;
  }

  whoCards.forEach((card) => {
    card.addEventListener("click", () => {
      state.whoMoving = card.dataset.value;
      hideError("whoError");
      updateWhoUI();
      saveState();
    });
  });

  document.getElementById("childMinus").addEventListener("click", () => {
    if (childrenCount > 1) { childrenCount--; childCountEl.textContent = childrenCount; saveState(); }
  });
  document.getElementById("childPlus").addEventListener("click", () => {
    if (childrenCount < 20) { childrenCount++; childCountEl.textContent = childrenCount; saveState(); }
  });
  updateWhoUI();

  // ── Error helpers ──────────────────────────
  function showError(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    if (msg) el.textContent = msg;
    el.classList.add("show");
  }
  function hideError(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove("show");
  }

  // ── Step validation ────────────────────────
  function validateStep(step) {
    if (canBypassOnboardingValidation()) {
      hideError("countryError");
      hideError("qualDocsError");
      hideError("docsError");
      hideError("dateError");
      hideError("cityError");
      hideError("whoError");
      return true;
    }

    switch (step) {
      case 0: // country
        if (!state.country) { showError("countryError"); return false; }
        if (!COUNTRY_DOCS[state.country]) {
          const hint = document.getElementById("countryHint");
          if (hint) hint.style.display = "block";
          return false;
        }
        hideError("countryError");
        return true;
      case 1: // qualification docs
        if (!allDocsComplete()) {
          showError("qualDocsError", "Please verify all required documents before continuing.");
          return false;
        }
        hideError("qualDocsError");
        return true;
      case 2: // identity check
        const idStatus = state.idVerification && state.idVerification.status;
        if (idStatus === "verified" || idStatus === "support_requested") {
          hideError("docsError");
          return true;
        }
        showError("docsError", "Please upload your passport or driver's licence.");
        return false;
      case 3: // relocation details (date + city + who)
        let ok = true;
        if (!state.targetDate) { showError("dateError", "Please select a target date."); ok = false; }
        else {
          const d = new Date(state.targetDate);
          if (d < minDate) { showError("dateError", "Your target date must be at least 5 months from today."); ok = false; }
          else hideError("dateError");
        }
        if (!state.preferredCity) { showError("cityError"); ok = false; }
        else hideError("cityError");
        if (!state.whoMoving) { showError("whoError"); ok = false; }
        else hideError("whoError");
        return ok;
      case 4: return true; // review
      default: return true;
    }
  }

  // ── Skip logic ─────────────────────────────
  function isSkippable(step) {
    return false;
  }

  // ── Review builder ─────────────────────────
  function buildReview() {
    const list = document.getElementById("reviewList");
    const countryName = (COUNTRIES.find((c) => c.code === state.country) || {}).name || "Not set";

    // Qual docs summary
    const docs = COUNTRY_DOCS[state.country] || [];
    const qualRows = docs.map((doc) => {
      const d = state.qualDocs[doc.key];
      let value = "Not uploaded", cls = "status-missing";
      if (d) {
        if (d.status === "verified") { value = "Verified"; cls = "status-verified"; }
        else if (d.status === "manual_review") { value = "Under Review"; cls = "status-pending"; }
        else { value = "Not verified"; cls = "status-missing"; }
      }
      return { label: doc.label, value, cls };
    });

    const whoLabels = {
      just_me: "Just me",
      me_partner: "Me & partner",
      me_children: "Me & children",
      me_partner_children: "Family",
    };
    const hasChildren = state.whoMoving === "me_children" || state.whoMoving === "me_partner_children";

    const rows = [
      { label: "Country", value: countryName },
      ...qualRows,
      { label: "Target date", value: state.targetDate ? new Date(state.targetDate).toLocaleDateString("en-AU", { year: "numeric", month: "long", day: "numeric" }) : "Not set" },
      { label: "Preferred city", value: state.preferredCity || "Not set" },
      { label: "Who's moving", value: whoLabels[state.whoMoving] || "Not set" },
    ];
    if (hasChildren) rows.push({ label: "Children", value: String(childrenCount) });
    const idStatus = state.idVerification && state.idVerification.status;
    rows.push({
      label: "Identity check",
      value: idStatus === "verified" ? "Verified" : idStatus === "support_requested" ? "Support contacted" : "Not verified",
      cls: idStatus === "verified" ? "status-verified" : idStatus === "support_requested" ? "status-pending" : "status-missing",
    });

    if (state.accountReviewFlag) {
      rows.push({ label: "Account", value: "Under Review", cls: "status-pending" });
    }

    list.innerHTML = rows.map((r) =>
      `<div class="review-row"><span class="review-label">${escHtml(r.label)}</span><span class="review-value ${escHtml(r.cls || "")}">${escHtml(r.value)}</span></div>`
    ).join("");
  }

  // ── Navigation ─────────────────────────────
  function goToStep(step) {
    if (step < 0 || step >= TOTAL_STEPS) return;

    const prev = currentStep;
    currentStep = step;

    shell.dataset.step = step;

    slides.forEach((s, i) => {
      s.classList.remove("active", "exit-left");
      if (i === step) s.classList.add("active");
      else if (i === prev && step > prev) s.classList.add("exit-left");
    });

    dots.forEach((d, i) => {
      d.classList.remove("active", "done");
      if (i === step) d.classList.add("active");
      else if (i < step) d.classList.add("done");
    });

    backBtn.classList.toggle("visible", step > 0);

    if (isSkippable(step)) {
      skipBtn.classList.remove("invisible");
      skipBtn.textContent = "SKIP";
    } else {
      skipBtn.classList.add("invisible");
    }

    if (step === TOTAL_STEPS - 1) {
      nextBtn.textContent = "SUBMIT";
      nextBtn.classList.add("submit");
    } else {
      nextBtn.textContent = "NEXT";
      nextBtn.classList.remove("submit");
    }

    if (step === TOTAL_STEPS - 1) {
      buildReview();
    }

    if (step === 1) renderQualDocSlots();
    if (step === 2) renderIdVerifyStatus();

    saveState();
  }

  let navInProgress = false;
  nextBtn.addEventListener("click", () => {
    if (navInProgress) return;
    triggerButtonHaptic(14);
    if (!validateStep(currentStep)) return;
    if (currentStep === TOTAL_STEPS - 1) { submitOnboarding(); return; }
    navInProgress = true;
    goToStep(currentStep + 1);
    requestAnimationFrame(() => { navInProgress = false; });
  });

  skipBtn.addEventListener("click", () => {
    if (navInProgress) return;
    navInProgress = true;
    goToStep(currentStep + 1);
    requestAnimationFrame(() => { navInProgress = false; });
  });
  backBtn.addEventListener("click", () => {
    if (navInProgress) return;
    triggerButtonHaptic(10);
    navInProgress = true;
    goToStep(currentStep - 1);
    requestAnimationFrame(() => { navInProgress = false; });
  });

  // ── Submit ─────────────────────────────────
  let isSubmitting = false;
  async function submitOnboarding() {
    if (isSubmitting) return;
    isSubmitting = true;
    nextBtn.disabled = true;
    loadingText.textContent = "Setting up your dashboard...";
    loadingOverlay.classList.add("show");

    state.completedAt = new Date().toISOString();
    saveState();

    try { localStorage.setItem("gp_selected_country", JSON.stringify((COUNTRIES.find((c) => c.code === state.country) || {}).name || state.country)); } catch (e) { /* ignore */ }

    // Set account review flag in localStorage for auth-guard
    if (state.accountReviewFlag) {
      try { localStorage.setItem("gp_account_under_review", "true"); } catch (e) { /* ignore */ }
    }

    try {
      await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(state),
      });
    } catch (e) { /* continue */ }

    try {
      await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ gp_onboarding_complete: true, gp_selected_country: (COUNTRIES.find((c) => c.code === state.country) || {}).name || state.country }),
      });
    } catch (e) { /* ignore */ }

    loadingOverlay.classList.remove("show");
    successScreen.classList.add("show");
  }

  document.getElementById("successContinueBtn").addEventListener("click", () => {
    window.location.href = "/pages/index.html";
  });

  // ── Init ───────────────────────────────────
  fetch("/api/auth/session", { credentials: "same-origin" })
    .then((r) => r.json())
    .then((data) => {
      if (!data || !data.authenticated) {
        window.location.replace("/pages/signin.html");
        return;
      }
      // Store profile for name matching
      if (data.profile) window.gpSessionProfile = data.profile;

      // If onboarding already completed and navigated here directly, allow re-entry
      // (removed auto-redirect to dashboard so users can redo onboarding via button)
      goToStep(currentStep);
    })
    .catch(() => {
      window.location.replace("/pages/signin.html");
    });
})();

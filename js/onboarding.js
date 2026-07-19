(function () {
  "use strict";

  const TOTAL_STEPS = 5;
  const STORAGE_KEY = "gp_onboarding";
  const MAX_RETRIES = 5;

  function escHtml(s) {
    if (typeof s !== "string") return "";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Allow clearing onboarding state via ?reset=1 query param. stateWasReset records
  // that the GP explicitly asked to start the wizard over. Without it, the
  // cross-device restore below (mergeServerOnboarding) would re-adopt the server's
  // wizard blob right after we clear localStorage here — local state is
  // default-fresh by construction immediately after a reset, which is exactly the
  // condition mergeServerOnboarding treats as "safe to adopt the server copy" —
  // making ?reset=1 silently re-persist the old blob and do nothing.
  var stateWasReset = false;
  if (new URLSearchParams(window.location.search).get("reset") === "1") {
    localStorage.removeItem(STORAGE_KEY);
    window.history.replaceState({}, "", window.location.pathname);
    stateWasReset = true;
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
    var stepMap = { 0: 1, 1: 1, 2: 1, 3: 2, 4: 2, 5: 2, 6: 4, 7: 3 };
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
      childrenAges: [],
      leadSource: "",        // optional "How did you hear about us?" — never blocks progression
      leadSourceDetail: "",
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
    // Always-visible off-ramp: a GP trained anywhere else is NOT eligible yet —
    // route them to the "Not yet eligible" waitlist instead of a dead end.
    const liOther = document.createElement("li");
    liOther.className = "country-not-listed";
    liOther.id = "countryNotListed";
    liOther.innerHTML = '<span class="country-flag">\u{1F30E}</span> My country isn’t listed';
    liOther.addEventListener("click", () => openEligibilityOfframp(countrySearch.value || ""));
    countryList.appendChild(liOther);
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
    renderQualDocSlots();
  }

  countrySearch.addEventListener("input", () => renderCountryList(countrySearch.value));
  countrySearch.addEventListener("focus", () => renderCountryList(countrySearch.value));
  renderCountryList("");

  if (state.country) {
    const match = COUNTRIES.find((c) => c.code === state.country);
    if (match) countrySearch.value = match.name;
  }

  // ── Eligibility off-ramp: country not yet supported (Not yet eligible) ──
  // GP Link only supports UK/Ireland/NZ-trained GPs today. Anyone else gets a
  // graceful waitlist ("notify me when my country is supported") instead of
  // being trapped on step 1 forever. Once waitlisted, returning to this page
  // shows the "we'll be in touch" state, not the wizard.
  const ELIGIBILITY_WAITLIST_KEY = "gp_eligibility_waitlist";

  function getWaitlistRecord() {
    try {
      const raw = localStorage.getItem(ELIGIBILITY_WAITLIST_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function showEligibilityScreen(submitted) {
    const screen = document.getElementById("notEligibleScreen");
    if (!screen) return;
    screen.classList.toggle("waitlist-submitted", !!submitted);
    screen.classList.add("show");
  }

  function hideEligibilityScreen() {
    const screen = document.getElementById("notEligibleScreen");
    if (screen) screen.classList.remove("show", "waitlist-submitted");
  }

  function openEligibilityOfframp(countryGuess) {
    const rec = getWaitlistRecord();
    if (rec) { showEligibilityScreen(true); return; }
    const countryInput = document.getElementById("waitlistCountry");
    const emailInput = document.getElementById("waitlistEmail");
    const nameInput = document.getElementById("waitlistName");
    const profile = window.gpSessionProfile || {};
    const typed = String(countryGuess || "").trim();
    if (countryInput && !countryInput.value && typed && !COUNTRIES.some((c) => c.name.toLowerCase() === typed.toLowerCase())) {
      countryInput.value = typed;
    }
    if (emailInput && !emailInput.value && profile.email) emailInput.value = profile.email;
    if (nameInput && !nameInput.value) {
      const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
      if (fullName) nameInput.value = fullName;
    }
    showEligibilityScreen(false);
  }

  const waitlistForm = document.getElementById("waitlistForm");
  if (waitlistForm) {
    waitlistForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById("waitlistError");
      const submitBtn = document.getElementById("waitlistSubmitBtn");
      const country = (document.getElementById("waitlistCountry").value || "").trim();
      const email = (document.getElementById("waitlistEmail").value || "").trim();
      const name = (document.getElementById("waitlistName").value || "").trim();
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!country || !emailOk) {
        if (errorEl) {
          errorEl.textContent = "Please enter your country and a valid email address.";
          errorEl.classList.add("show");
        }
        return;
      }
      if (errorEl) errorEl.classList.remove("show");
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Saving…"; }
      try {
        const resp = await fetch("/api/eligibility-waitlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ email: email, country: country, name: name }),
        });
        const data = await resp.json().catch(() => null);
        if (resp.ok && data && data.ok) {
          try {
            localStorage.setItem(ELIGIBILITY_WAITLIST_KEY, JSON.stringify({ country: country, email: email, at: new Date().toISOString() }));
          } catch (err) { /* ignore */ }
          showEligibilityScreen(true);
        } else if (errorEl) {
          errorEl.textContent = (data && data.message) || "We couldn't save your details. Please try again.";
          errorEl.classList.add("show");
        }
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = "We couldn't save your details. Please check your connection and try again.";
          errorEl.classList.add("show");
        }
      } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Notify me when it's supported"; }
      }
    });
  }

  function exitEligibilityOfframp() {
    try { localStorage.removeItem(ELIGIBILITY_WAITLIST_KEY); } catch (e) { /* ignore */ }
    // Clear the server-side flag too so other devices stop showing the waitlist.
    fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ state: { gp_eligibility_waitlist: null } }),
    }).catch(() => { /* best effort */ });
    hideEligibilityScreen();
  }
  const waitlistBackBtn = document.getElementById("waitlistBackBtn");
  if (waitlistBackBtn) waitlistBackBtn.addEventListener("click", exitEligibilityOfframp);
  const waitlistDoneBackBtn = document.getElementById("waitlistDoneBackBtn");
  if (waitlistDoneBackBtn) waitlistDoneBackBtn.addEventListener("click", exitEligibilityOfframp);

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
    // A name that differs from the account on a genuine qualification is a name change
    // (e.g. marriage), not a wrong document. Never tell the GP to upload a "matching"
    // document — a certificate can only carry the name it was issued in.
    if (/looks like a previous name|changed your name|name change|previous name/.test(lower)) {
      return "The name on this document looks like a previous name. If you've changed your name, for example after marriage, that's fine — we'll record it and ask you for proof of your name change at a later step. You don't need to upload a different document.";
    }
    if (/does not match your account|doesn.?t match your profile|same name as your qualifications/.test(lower)) {
      return "The name on this document is different from the name on your account. If you've changed your name, that's fine — we'll confirm it with you. Otherwise, please check you have uploaded the correct document.";
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
    // The temporary tester bypass expired on 2026-06-10, so this already always
    // returned false; the plaintext email has been removed from client code.
    // If a new temporary bypass is ever needed, add a SHA-256 digest entry in
    // js/bypass-config.js instead of embedding an email address here.
    return false;
  }

  function renderQualDocSlots() {
    if (!qualDocsContainer) return;
    const docs = COUNTRY_DOCS[state.country] || [];
    qualDocsContainer.innerHTML = "";
    var explainer = document.getElementById("qualDocsExplainer");

    if (docs.length === 0) {
      qualDocsContainer.innerHTML = '<p style="color:var(--muted);font-size:14px;">Select a country first.</p>';
      if (explainer) explainer.style.display = "none";
      return;
    }

    if (explainer) explainer.style.display = "block";

    docs.forEach((doc, idx) => {
      const docState = (state.qualDocs && state.qualDocs[doc.key]) || {};
      const status = docState.status || "pending";
      const retryCount = docState.retryCount || 0;

      const slot = document.createElement("div");
      slot.className = "qual-doc-slot" + (status === "verified" ? " verified" : status === "failed" ? " failed" : status === "scanning" ? " scanning" : (status === "approved" ? " verified" : status === "rejected" ? " failed" : status === "storage_failed" ? " failed" : ""));
      slot.id = "qualSlot_" + doc.key;

      // Badge
      let badgeClass = "pending", badgeText = "Required";
      if (status === "verified") { badgeClass = "verified"; badgeText = "Verified"; }
      else if (status === "verified_name_pending") { badgeClass = "verified"; badgeText = "Verified"; }
      else if (status === "support_requested") { badgeClass = "review"; badgeText = "Support Contacted"; }
      else if (status === "failed") { badgeClass = "failed"; badgeText = "Failed"; }
      else if (status === "scanning") { badgeClass = "scanning"; badgeText = "Scanning..."; }
      else if (status === "manual_review") { badgeClass = "review"; badgeText = "Under Review"; }
      else if (status === "approved") { badgeClass = "verified"; badgeText = "Approved"; }
      else if (status === "rejected") { badgeClass = "failed"; badgeText = "Needs re-upload"; }
      else if (status === "under_review") { badgeClass = "review"; badgeText = "Under Review"; }
      else if (status === "storage_failed") { badgeClass = "failed"; badgeText = "Not saved"; }

      let infoHtml = "";
      if (status === "scanning") {
        infoHtml = '<div class="qual-doc-slot-info"><span class="qual-doc-spinner"></span> Checking your document now...</div>';
      } else if (status === "verified" || status === "verified_name_pending") {
        infoHtml = '<div class="qual-doc-slot-info" style="color:var(--green);">&#10003; Verified — one less thing to think about.</div>';
      } else if (status === "approved") {
        infoHtml = '<div class="qual-doc-slot-info" style="color:var(--green);">&#10003; Approved by our team — nothing more to do here.</div>';
      } else if (status === "rejected") {
        infoHtml = '<div class="qual-doc-slot-info error">' + escHtml(docState.rejectionReason || "Our team needs a clearer copy of this document.") + '<br>Please upload a new copy below.</div>';
      } else if (status === "under_review") {
        infoHtml = '<div class="qual-doc-slot-info" style="color:var(--primary, #2563eb);">Our team is reviewing this document — no action needed.</div>';
      } else if (status === "storage_failed") {
        infoHtml = '<div class="qual-doc-slot-info error">This document did not save, so we do not have a copy yet. Nothing has been lost and this does not count against you — please upload it again. If it keeps happening, try a photo taken with your phone camera.</div>';
        infoHtml += '<button class="qual-support-btn" data-support-doc="' + doc.key + '" type="button">Contact Support</button>';
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
          infoHtml += '<div class="qual-doc-slot-retry" style="color:var(--primary, #2563eb);">Tip: ' + tips[retryCount - 1] + '</div>';
        }
        infoHtml += '<button class="qual-support-btn" data-support-doc="' + doc.key + '" type="button">Contact Support</button>';
      } else if (status === "support_requested") {
        infoHtml = '<div class="qual-doc-slot-info" style="color:var(--primary, #2563eb);">Support team will verify manually via email</div>';
      } else if (status === "manual_review") {
        var reviewIssues = humanizeScanIssues((docState.scanResult && docState.scanResult.issues) ? docState.scanResult.issues : ["Queued for review"], { documentTitle: doc.label, mode: "qualification" });
        infoHtml = '<div class="qual-doc-slot-info" style="color:var(--primary, #2563eb);">Sent for manual review.<br>' + reviewIssues.map(escHtml).join("<br>") + '</div>';
        infoHtml += '<button class="qual-support-btn" data-support-doc="' + doc.key + '" type="button">Contact Support</button>';
      }

      const showActions = status !== "verified" && status !== "verified_name_pending" && status !== "support_requested" && status !== "scanning" && !(status === "failed" && retryCount >= MAX_RETRIES && !unlimitedRetries) && status !== "manual_review" && status !== "approved" && status !== "under_review";

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
    var isMatch = function (level) { return level === "exact" || level === "fuzzy"; };
    var docsMatchEachOther = isMatch(getNameMatchLevel(specName, medName));
    var specMatchesAccount = isMatch(getNameMatchLevel(specName, profileName));
    var medMatchesAccount = isMatch(getNameMatchLevel(medName, profileName));

    // The GP's CURRENT legal name is the name on their MOST RECENT qualification. The specialist
    // qualification (MRCGP / CCT / equivalent) is always obtained AFTER the primary medical
    // degree, so its name is the most recent by default; we defer to the scanned document dates
    // only when both are clearly readable and (unusually) put the medical degree later.
    var currentLegalName = pickCurrentLegalName(specDoc, medDoc, specName, medName);

    // Update the account to the current legal name (no-op if it already matches). This corrects a
    // GP whose account was created in a former/older name so it reflects their legal name.
    var applyAccountName = function () {
      if (getNameMatchLevel(currentLegalName, profileName) === "exact") return; // already correct
      autoUpdateAccountName(currentLegalName).then(function (updated) {
        if (!updated) {
          var m = "We verified your documents, but could not update your account name automatically. Please refresh or contact support if the name does not update.";
          specDoc.scanResult = specDoc.scanResult || {};
          medDoc.scanResult = medDoc.scanResult || {};
          specDoc.scanResult.issues = appendIssueOnce(specDoc.scanResult.issues, m);
          medDoc.scanResult.issues = appendIssueOnce(medDoc.scanResult.issues, m);
        }
        saveState();
        renderQualDocSlots();
      });
    };

    // CASE 1 — at least one qualification matches the account name. This is the normal case,
    // INCLUDING a genuine name change: the two certificates may carry DIFFERENT names (the older
    // one in a former/maiden name) and that is fine. Accept both — the certificate carrying the
    // current legal name is "verified", the other is a recorded NAME CHANGE (never rejected,
    // never manual review). The per-document scan already flagged the name change to the server
    // and the AMC step asks the GP for proof. Then set the account to the current legal name.
    if (specMatchesAccount || medMatchesAccount) {
      var specIsCurrent = isMatch(getNameMatchLevel(specName, currentLegalName));
      var medIsCurrent = isMatch(getNameMatchLevel(medName, currentLegalName));
      specDoc.status = specIsCurrent ? "verified" : "verified_name_pending";
      medDoc.status = medIsCurrent ? "verified" : "verified_name_pending";
      if (!specIsCurrent || !medIsCurrent) state.accountReviewFlag = true;
      applyAccountName();
      return;
    }

    // CASE 2 — NEITHER certificate matches the account name, but the two AGREE with each other:
    // a consistent name change. Accept both as name-change pending and flag for review, but do
    // NOT auto-change the account: with no qualification matching the account we cannot be sure
    // whether the account is a former name (older than the certs) or a NEWER name the GP adopted
    // after their most recent qualification — so a human confirms rather than overwriting it.
    if (docsMatchEachOther) {
      specDoc.status = "verified_name_pending";
      medDoc.status = "verified_name_pending";
      state.accountReviewFlag = true;
      return;
    }

    // CASE 3 — neither certificate matches the account AND the two disagree with each other:
    // genuinely ambiguous, so a human needs to check.
    specDoc.status = "manual_review";
    medDoc.status = "manual_review";
    specDoc.scanResult = specDoc.scanResult || {};
    medDoc.scanResult = medDoc.scanResult || {};

    var msg = "Names on your specialist qualification and medical degree do not match each other.";
    specDoc.scanResult.issues = appendIssueOnce(specDoc.scanResult.issues, msg);
    medDoc.scanResult.issues = appendIssueOnce(medDoc.scanResult.issues, msg);
    state.accountReviewFlag = true;
  }

  // The GP's current legal name = the name on their MOST RECENT qualification. The specialist
  // qualification is obtained after the primary medical degree, so it is the most recent by
  // default; only defer to the scanned dates when both are clearly readable and put the medical
  // degree later.
  function pickCurrentLegalName(specDoc, medDoc, specName, medName) {
    var specDate = parseQualDate(specDoc && specDoc.scanResult && specDoc.scanResult.dateFound);
    var medDate = parseQualDate(medDoc && medDoc.scanResult && medDoc.scanResult.dateFound);
    if (specDate != null && medDate != null && medDate > specDate) return medName;
    return specName;
  }

  // Lenient date parse for a certificate's scanned date. Returns a timestamp or null (handles
  // full dates like "03 DEC 2008" and bare years like "2021"; never throws on OCR noise).
  function parseQualDate(s) {
    if (!s) return null;
    var str = String(s).trim();
    var t = Date.parse(str);
    if (!isNaN(t)) return t;
    var y = str.match(/\b(19|20)\d{2}\b/);
    if (y) { var yt = Date.parse(y[0] + "-01-01"); return isNaN(yt) ? null : yt; }
    return null;
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
    card.style.cssText = "background:#1e1e2e;border-radius:16px;padding:28px 24px;max-width:380px;width:100%;text-align:center;font-family:'DM Sans',sans-serif;";

    card.innerHTML =
      '<div style="width:56px;height:56px;border-radius:50%;background:rgba(59,130,246,0.15);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">' +
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
      '</div>' +
      '<h3 style="color:#fff;font-size:18px;font-weight:700;margin:0 0 8px;">Manual Verification Required</h3>' +
      '<p style="color:#94a3b8;font-size:14px;line-height:1.5;margin:0 0 20px;">' +
        'Due to discrepancies in your qualifications, our team will email you to manually verify your qualifications and resume onboarding.' +
      '</p>' +
      '<button id="qualSupportSendBtn" type="button" style="width:100%;padding:14px;border:none;border-radius:12px;background:#2563eb;color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:10px;font-family:inherit;">Send Support Request</button>' +
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
            '<button id="qualSupportDoneBtn" type="button" style="width:100%;padding:14px;border:none;border-radius:12px;background:#2563eb;color:#fff;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;">OK</button>';
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

    // Prepare the file BEFORE touching the slot's state. Images are shrunk so a normal
    // phone photo fits inside the platform's request-size cap; anything still too big
    // is stopped right here instead of dying at the platform as a 502. A file we never
    // send must not leave the slot stuck on "Scanning..." or burn a verification retry.
    let prepared;
    try {
      prepared = await prepareQualUpload(fileOrBlob);
    } catch (prepErr) {
      delete activeDocUploads[docKey];
      showError("qualDocsError", (prepErr && prepErr.message) || "We could not read that file. Please try a photo of the document instead.");
      return;
    }
    if (!prepared || !prepared.base64) {
      delete activeDocUploads[docKey];
      showError("qualDocsError", "We could not read that file. Please try a photo of the document instead.");
      return;
    }
    if (prepared.base64.length > MAX_UPLOAD_BASE64_LENGTH) {
      delete activeDocUploads[docKey];
      showError("qualDocsError", "This file is too big for us to accept. Please take a photo of the document with your phone camera instead, or save a smaller copy, then try again.");
      return;
    }
    hideError("qualDocsError");

    // Initialize doc state
    if (!state.qualDocs) state.qualDocs = {};
    const prev = state.qualDocs[docKey] || {};
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
      const base64 = prepared.base64;
      const mimeType = prepared.mimeType || "application/octet-stream";
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
        // PEP pathway: a genuine specialist certificate that predates the expedited
        // cutoff means this GP belongs on the PEP (Substantially Comparable) waitlist.
        // The server has already locked the account (account_status = 'pep_waitlist');
        // hand the GP straight to the PEP pathway gate page instead of the app.
        if (v.pepEligible) {
          window.location.replace("/pages/pep-pathway");
          return;
        }
        const nameConfirmed = v.nameMatch === "exact" || v.nameMatch === "fuzzy";
        if (v.verified && nameConfirmed) {
          state.qualDocs[docKey].status = "verified";
          state.qualDocs[docKey].scanResult = v;
          state.qualDocs[docKey].nameMatch = v.nameMatch;
        } else if (v.nameMatch === "mismatch") {
          // A different name on a genuine qualification is a NAME CHANGE (e.g.
          // marriage), not a failure. Accept the document — verified_name_pending
          // counts as verified for progression and shows a "Verified" badge — and do
          // NOT burn a retry or demand a re-upload. The server records the name change
          // so the AMC step asks for proof; a Registration Support Officer still
          // sees it for confirmation.
          state.qualDocs[docKey].status = "verified_name_pending";
          var nameChangeIssues = (v.issues && v.issues.length > 0) ? v.issues : ["This looks like a name change — we'll ask you for proof at a later step."];
          state.qualDocs[docKey].scanResult = { ...v, issues: humanizeScanIssues(nameChangeIssues, { documentTitle: doc.label, mode: "qualification" }) };
          state.qualDocs[docKey].nameMatch = v.nameMatch;
          state.accountReviewFlag = true;
        } else {
          state.qualDocs[docKey].status = "failed";
          state.qualDocs[docKey].retryCount = (state.qualDocs[docKey].retryCount || 0) + 1;
          var failIssues = (v.issues && v.issues.length > 0) ? v.issues : ["Document could not be verified. Check it's the correct document type and clearly visible."];
          state.qualDocs[docKey].scanResult = { ...v, issues: humanizeScanIssues(failIssues, { documentTitle: doc.label, mode: "qualification" }) };
        }

        // Cross-document name matching: check if both docs have names that match each other
        crossDocNameCheck();
      } else if (data.queued) {
        state.qualDocs[docKey].status = "manual_review";
        state.qualDocs[docKey].scanResult = { issues: humanizeScanIssues([data.message || "Queued for review"], { documentTitle: doc.label, mode: "qualification" }) };
      } else {
        state.qualDocs[docKey].status = "failed";
        state.qualDocs[docKey].retryCount = (state.qualDocs[docKey].retryCount || 0) + 1;
        state.qualDocs[docKey].scanResult = { issues: humanizeScanIssues([data.message || "Verification failed"], { documentTitle: doc.label, mode: "qualification" }) };
      }

      // Persist the actual file regardless of the verification outcome. A name
      // mismatch / failed scan still needs a Registration Support Officer to open and review the
      // real document — previously only verified docs were saved, which is why a
      // flagged qualification showed "No document is stored for this task".
      var storedOk = false;
      try {
        const savedDoc = await saveOnboardingDocumentFile(docKey, fileName, mimeType, fileDataUrl);
        if (savedDoc) {
          state.qualDocs[docKey].storedAt = savedDoc.updatedAt || new Date().toISOString();
          storedOk = true;
        }
      } catch (persistErr) {
        console.error("[QualVerify] Persist failed:", persistErr);
      }

      // If max retries reached and still failed, flag for review (skip for unlimited accounts)
      var unlimited = data && data.unlimitedRetries;
      if (unlimited) unlimitedRetries = true;
      if (!unlimited && state.qualDocs[docKey].status === "failed" && state.qualDocs[docKey].retryCount >= MAX_RETRIES) {
        state.accountReviewFlag = true;
        state.qualDocs[docKey].status = "manual_review";
      }

      // A storage failure must NEVER leave a green "Verified" tick on the slot. The
      // scan passing only means the picture was readable — if the file did not save,
      // nothing was filed and the GP would move on believing their degree was safely
      // with us. Flip the slot to storage_failed so they are told plainly and can
      // re-upload. This runs last so it also overrides the manual_review conversion
      // above: with no stored file there is nothing for anyone to review by hand.
      // retryCount is deliberately left untouched — a storage problem is our fault,
      // not one of the GP's five verification attempts — so a retry that scans and
      // saves cleanly still lands on the correct status, and a GP already at the retry
      // ceiling still converts to manual_review on their next successful save.
      if (!storedOk) {
        state.qualDocs[docKey].scanOutcome = state.qualDocs[docKey].status;
        state.qualDocs[docKey].status = "storage_failed";
        showError("qualDocsError", "Your document was checked, but it did not save. Nothing has been lost — please upload it again.");
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

  // ── Upload size handling ───────────────────
  // The hosting platform rejects request bodies over ~4.5 MB, and base64 inflates
  // bytes by about a third, so an ordinary phone photo of a degree certificate can
  // overflow the limit and fail before it ever reaches the server. Shrink images in
  // the browser first (the same mitigation my-documents.html and the scan modal in
  // js/qualification-scan.js already use — mirrored here because those helpers live
  // behind window.gpDownscaleImageDataUrl in a script the wizard does not load), and
  // hard-stop anything that is still too big rather than letting it die as a 502.
  const MAX_UPLOAD_BASE64_LENGTH = 3600000; // ~3.4 MB of base64, safely under the cap

  function isImageUpload(fileOrBlob) {
    if (!fileOrBlob) return false;
    var type = String(fileOrBlob.type || "").toLowerCase();
    if (/^image\//.test(type)) return true;
    return /\.(jpe?g|png|webp|gif|bmp|tif|tiff|heic|heif|avif)$/i.test(fileOrBlob.name || "");
  }

  // The vision model only needs about 1568px on the long edge, so shrinking to that
  // loses no detail the scan uses while keeping the request small.
  function downscaleImageToBase64(fileOrBlob, maxDim, quality) {
    maxDim = maxDim || 1600;
    quality = quality || 0.82;
    return new Promise(function (resolve, reject) {
      var url;
      try { url = URL.createObjectURL(fileOrBlob); } catch (e) { reject(e); return; }
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
          var dataUrl = canvas.toDataURL("image/jpeg", quality);
          // If still too big for the body limit, recompress harder once.
          if (dataUrl.length > MAX_UPLOAD_BASE64_LENGTH) dataUrl = canvas.toDataURL("image/jpeg", 0.6);
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

  // Returns { base64, mimeType } ready to send. Images are downscaled; anything we
  // cannot decode (some HEIC files, for example) falls back to the raw bytes and is
  // then size-checked by the caller before anything is sent.
  function prepareQualUpload(fileOrBlob) {
    var fallbackType = (fileOrBlob && fileOrBlob.type) || "application/octet-stream";
    if (isImageUpload(fileOrBlob)) {
      return downscaleImageToBase64(fileOrBlob).catch(function () {
        return fileToBase64(fileOrBlob).then(function (b64) { return { base64: b64, mimeType: fallbackType }; });
      });
    }
    return fileToBase64(fileOrBlob).then(function (b64) { return { base64: b64, mimeType: fallbackType }; });
  }

  function getOnboardingDocumentStorageKey(docKey) {
    if (docKey === "primary_med_degree") return "onboarding_primary_med_degree";
    return "onboarding_specialist_qualification";
  }

  // Reverse of getOnboardingDocumentStorageKey for a given country's doc list.
  function getWizardKeyForStorageKey(storageKey, country) {
    var docs = COUNTRY_DOCS[country] || [];
    if (storageKey === "onboarding_primary_med_degree") {
      return (docs.find(function (d) { return d.key === "primary_med_degree"; }) || {}).key || "primary_med_degree";
    }
    var specialist = docs.find(function (d) { return d.key !== "primary_med_degree"; });
    return specialist ? specialist.key : null;
  }

  // Accept any key namespace in ?reupload= (canonical from emails, onboarding_* from
  // storage, or the wizard's own key) and resolve to the wizard key for the country.
  function resolveReuploadParamKey(raw, country) {
    var docs = COUNTRY_DOCS[country] || [];
    if (docs.some(function (d) { return d.key === raw; })) return raw;
    if (raw === "primary_medical_degree" || raw === "onboarding_primary_med_degree") {
      return getWizardKeyForStorageKey("onboarding_primary_med_degree", country);
    }
    if (raw === "specialist_qualification" || raw === "onboarding_specialist_qualification") {
      return getWizardKeyForStorageKey("onboarding_specialist_qualification", country);
    }
    return null;
  }

  function isDefaultLocalState(s) {
    return !s.country && (!s.qualDocs || Object.keys(s.qualDocs).length === 0) && !s.completedAt;
  }

  // Merge the server's copy of the wizard into local state. The server blob is the
  // cross-device base (adopted wholesale only when this browser has nothing); the
  // authoritative review decision per document ALWAYS wins over the local cache.
  function mergeServerOnboarding(serverBlob, serverCountryName) {
    // A fresh ?reset=1 means "start the wizard over" — never re-adopt the server's
    // wizard blob (that would silently undo the reset) or re-populate the country
    // from the cached gp_selected_country (that would skip the country step). The
    // per-document review-decision overlay (applyServerDocStatuses) is unaffected by
    // stateWasReset — it stays gated on state.country, which a genuine reset leaves
    // empty, so it naturally has nothing to overlay until the GP re-picks a country.
    if (!stateWasReset && serverBlob && typeof serverBlob === "object" && isDefaultLocalState(state)) {
      state = { ...defaultState(), ...serverBlob, _version: 2 };
      currentStep = Math.min(Math.max(state.currentStep || 0, 0), TOTAL_STEPS - 1);
      childrenCount = state.childrenCount || 1;
    }
    if (!stateWasReset && !state.country && serverCountryName) {
      var c = COUNTRIES.find(function (x) { return x.name === serverCountryName || x.code === serverCountryName; });
      if (c) state.country = c.code;
    }
  }

  function applyServerDocStatuses(docsByStorageKey) {
    if (!docsByStorageKey || !state.country) return;
    if (!state.qualDocs) state.qualDocs = {};
    Object.keys(docsByStorageKey).forEach(function (storageKey) {
      var serverDoc = docsByStorageKey[storageKey] || {};
      var wizardKey = getWizardKeyForStorageKey(storageKey, state.country);
      if (!wizardKey) return;
      var local = state.qualDocs[wizardKey] || {};
      var serverStatus = String(serverDoc.status || "");
      if (serverStatus === "accepted") {
        state.qualDocs[wizardKey] = { ...local, fileName: local.fileName || serverDoc.fileName || "", status: "approved", rejectionReason: "" };
      } else if (serverStatus === "rejected") {
        state.qualDocs[wizardKey] = { ...local, fileName: local.fileName || serverDoc.fileName || "", status: "rejected", rejectionReason: serverDoc.rejection_reason || "" };
      } else if ((!local.status || local.status === "rejected") && (serverStatus === "under_review" || serverStatus === "pending") && serverDoc.fileName) {
        // This browser has no memory of the upload (new device), OR this device's
        // only memory is a stale "rejected" — which is always server-derived, so a
        // newer server "under_review" (e.g. the GP re-uploaded on ANOTHER device)
        // must replace it rather than keep showing "Needs re-upload" forever. Local
        // in-progress statuses (e.g. "scanning"/"verified" from an upload in
        // progress on THIS device) are untouched since they aren't "rejected".
        state.qualDocs[wizardKey] = { fileName: serverDoc.fileName, status: "under_review", rejectionReason: "" };
      }
    });
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

  // This is an allow-list, so a document whose upload did not save ("storage_failed")
  // can never count as complete — the GP is held on this step until we really have the
  // file. Deliberately NOT gated on storedAt: "approved" and "under_review" are handed
  // to us by the server for uploads made on another device (and older saved wizards
  // predate storedAt entirely), so requiring it would lock those GPs out of a step
  // they have already finished.
  function allDocsComplete() {
    const docs = COUNTRY_DOCS[state.country] || [];
    if (docs.length === 0) return false;
    return docs.every((doc) => {
      const d = state.qualDocs && state.qualDocs[doc.key];
      return d && (d.status === "verified" || d.status === "manual_review" || d.status === "verified_name_pending" || d.status === "support_requested" || d.status === "approved" || d.status === "under_review");
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
      statusEl.innerHTML = '<div class="qual-doc-slot-info" style="color:var(--primary, #2563eb);">Support team will verify manually via email</div>';
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

  // ── How did you hear about us? (OPTIONAL — never blocks progression) ──
  const leadSourceEl = document.getElementById("leadSource");
  const leadSourceDetailEl = document.getElementById("leadSourceDetail");
  const LEAD_SOURCE_DETAIL_KEYS = ["other", "colleague_referral"];
  function updateLeadSourceUI() {
    if (!leadSourceEl) return;
    leadSourceEl.value = state.leadSource || "";
    if (leadSourceDetailEl) {
      const showDetail = LEAD_SOURCE_DETAIL_KEYS.includes(state.leadSource);
      leadSourceDetailEl.style.display = showDetail ? "block" : "none";
      leadSourceDetailEl.value = state.leadSourceDetail || "";
    }
  }
  if (leadSourceEl) {
    leadSourceEl.addEventListener("change", () => {
      state.leadSource = leadSourceEl.value;
      if (!LEAD_SOURCE_DETAIL_KEYS.includes(state.leadSource)) state.leadSourceDetail = "";
      updateLeadSourceUI();
      saveState();
    });
  }
  if (leadSourceDetailEl) {
    leadSourceDetailEl.addEventListener("change", () => {
      state.leadSourceDetail = leadSourceDetailEl.value.slice(0, 200);
      saveState();
    });
  }
  updateLeadSourceUI();

  // ── Who is moving ──────────────────────────
  const whoCards = document.querySelectorAll("#whoMovingGrid .option-card");
  const childrenWrap = document.getElementById("childrenCountWrap");
  const childCountEl = document.getElementById("childCount");

  var childrenAgesWrap = document.getElementById("childrenAgesWrap");

  function renderChildrenAges() {
    if (!childrenAgesWrap) return;
    if (!state.childrenAges) state.childrenAges = [];
    // Ensure array matches count
    while (state.childrenAges.length < childrenCount) state.childrenAges.push("");
    if (state.childrenAges.length > childrenCount) state.childrenAges.length = childrenCount;
    var html = "";
    for (var i = 0; i < childrenCount; i++) {
      var val = state.childrenAges[i] || "";
      html += '<div class="child-age-row">';
      html += '<label>Child ' + (i + 1) + ' age</label>';
      html += '<select data-child-age-idx="' + i + '">';
      html += '<option value=""' + (val === "" ? " selected" : "") + '>Select age</option>';
      for (var age = 0; age <= 17; age++) {
        var label = age === 0 ? "Under 1" : age + (age === 1 ? " year" : " years");
        html += '<option value="' + age + '"' + (String(val) === String(age) ? " selected" : "") + '>' + label + '</option>';
      }
      html += '</select></div>';
    }
    childrenAgesWrap.innerHTML = html;
    childrenAgesWrap.querySelectorAll("select").forEach(function (sel) {
      sel.addEventListener("change", function () {
        var idx = parseInt(sel.dataset.childAgeIdx, 10);
        state.childrenAges[idx] = sel.value;
        saveState();
      });
    });
  }

  function updateWhoUI() {
    whoCards.forEach((c) => {
      c.classList.toggle("selected", c.dataset.value === state.whoMoving);
    });
    const hasChildren = state.whoMoving === "me_children" || state.whoMoving === "me_partner_children";
    childrenWrap.classList.toggle("show", hasChildren);
    childCountEl.textContent = childrenCount;
    if (hasChildren) renderChildrenAges();
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
    if (childrenCount > 1) { childrenCount--; childCountEl.textContent = childrenCount; renderChildrenAges(); saveState(); }
  });
  document.getElementById("childPlus").addEventListener("click", () => {
    if (childrenCount < 20) { childrenCount++; childCountEl.textContent = childrenCount; renderChildrenAges(); saveState(); }
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
      case 0: return true; // intro
      case 1: // country + trained-where + qualification docs
        if (!state.country) { showError("countryError"); return false; }
        if (!COUNTRY_DOCS[state.country]) {
          const hint = document.getElementById("countryHint");
          if (hint) hint.style.display = "block";
          return false;
        }
        hideError("countryError");
        if (!allDocsComplete()) {
          showError("qualDocsError", "Please verify all required documents before continuing.");
          return false;
        }
        hideError("qualDocsError");
        return true;
      case 2: // relocation details (date + city + who)
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
      case 3: return true; // review
      case 4: // identity check
        const idStatus = state.idVerification && state.idVerification.status;
        if (idStatus === "verified" || idStatus === "support_requested") {
          hideError("docsError");
          return true;
        }
        showError("docsError", "Please upload your passport or driver's licence.");
        return false;
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
        else if (d.status === "approved") { value = "Approved"; cls = "status-verified"; }
        else if (d.status === "manual_review") { value = "Under Review"; cls = "status-pending"; }
        else if (d.status === "under_review") { value = "Under Review"; cls = "status-pending"; }
        else if (d.status === "rejected") { value = "Needs re-upload"; cls = "status-missing"; }
        else if (d.status === "storage_failed") { value = "Not saved — please upload again"; cls = "status-missing"; }
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
    if (hasChildren) {
      rows.push({ label: "Children", value: String(childrenCount) });
      if (state.childrenAges && state.childrenAges.length) {
        for (var ci = 0; ci < Math.min(childrenCount, state.childrenAges.length); ci++) {
          var ageVal = state.childrenAges[ci];
          var ageLabel = ageVal === "" || ageVal === undefined ? "Not set" : (ageVal === "0" || ageVal === 0 ? "Under 1" : ageVal + (String(ageVal) === "1" ? " year" : " years"));
          rows.push({ label: "Child " + (ci + 1) + " age", value: ageLabel, cls: ageVal === "" || ageVal === undefined ? "status-missing" : "" });
        }
      }
    }

    if (state.accountReviewFlag) {
      rows.push({ label: "Account", value: "Under Review", cls: "status-pending" });
    }

    list.innerHTML = rows.map((r) =>
      `<div class="review-row"><span class="review-label">${escHtml(r.label)}</span><span class="review-value ${escHtml(r.cls || "")}">${escHtml(r.value)}</span></div>`
    ).join("");
  }

  // ── Button morph (translate + width/padding/font-size) ──
  // Animates position with translateX and size with real property transitions.
  // No scaleX/scaleY — avoids text and border-radius distortion.
  var btnRow = nextBtn.parentElement;
  var flipEase = "cubic-bezier(0.22, 1, 0.36, 1)";
  var flipDur = "0.55s";

  function flipNextBtn(applyLayoutChange) {
    var cs = getComputedStyle(nextBtn);
    var firstRect = nextBtn.getBoundingClientRect();
    var firstWidth = firstRect.width;
    var firstPadding = cs.padding;
    var firstFontSize = cs.fontSize;

    nextBtn.classList.add("flipping");
    applyLayoutChange();
    void nextBtn.offsetWidth;

    var lastRect = nextBtn.getBoundingClientRect();
    var lastWidth = lastRect.width;
    var dx = firstRect.left + firstRect.width / 2 - (lastRect.left + lastRect.width / 2);

    // Snap to old state
    nextBtn.style.transition = "none";
    nextBtn.style.transform = "translateX(" + dx + "px)";
    nextBtn.style.width = firstWidth + "px";
    nextBtn.style.minWidth = "0";
    nextBtn.style.padding = firstPadding;
    nextBtn.style.fontSize = firstFontSize;

    void nextBtn.offsetWidth;

    // Animate to new state
    nextBtn.style.transition = [
      "transform " + flipDur + " " + flipEase,
      "width " + flipDur + " " + flipEase,
      "padding " + flipDur + " " + flipEase,
      "font-size " + flipDur + " " + flipEase
    ].join(", ");
    nextBtn.style.transform = "translateX(0)";
    nextBtn.style.width = lastWidth + "px";
    nextBtn.style.padding = "";
    nextBtn.style.fontSize = "";
  }

  nextBtn.addEventListener("transitionend", function (e) {
    if (e.propertyName === "transform") {
      nextBtn.style.transition = "";
      nextBtn.style.transform = "";
      nextBtn.style.width = "";
      nextBtn.style.minWidth = "";
      nextBtn.classList.remove("flipping");
    }
  });

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
    // Hide progress dots on intro slide
    var dotsEl = document.getElementById("progressDots");
    if (dotsEl) dotsEl.style.display = step === 0 ? "none" : "flex";

    // FLIP the button: capture pos → change layout → animate with transform
    var needsFlip = (prev === 0 && step === 1) || (prev === 1 && step === 0);
    if (needsFlip) {
      flipNextBtn(function () {
        nextBtn.classList.toggle("intro-size", step === 0);
        btnRow.classList.toggle("intro-center", step === 0);
      });
    } else {
      nextBtn.classList.toggle("intro-size", step === 0);
      btnRow.classList.toggle("intro-center", step === 0);
    }

    if (isSkippable(step)) {
      skipBtn.classList.remove("invisible");
      skipBtn.textContent = "SKIP";
    } else {
      skipBtn.classList.add("invisible");
    }

    // Button label — swap text mid-slide so it changes during the motion
    var newLabel = step === TOTAL_STEPS - 1 ? "SUBMIT" : step === 0 ? "Get Started" : "NEXT";
    var isSubmit = step === TOTAL_STEPS - 1;
    if (nextBtn.textContent !== newLabel) {
      var delay = needsFlip ? 300 : 0;
      setTimeout(function () {
        nextBtn.textContent = newLabel;
        nextBtn.classList.toggle("submit", isSubmit);
      }, delay);
    } else {
      nextBtn.classList.toggle("submit", isSubmit);
    }

    if (step === 3) {
      buildReview();
    }

    if (step === 1) renderQualDocSlots();
    if (step === 4) renderIdVerifyStatus();

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
      localStorage.setItem("gp_onboarding_complete", "true");
    } catch (e) { /* ignore */ }

    loadingOverlay.classList.remove("show");
    successScreen.classList.add("show");
  }

  document.getElementById("successContinueBtn").addEventListener("click", () => {
    window.location.href = "/pages/index";
  });

  function highlightQualSlot(wizardKey) {
    setTimeout(function () {
      var slot = document.getElementById("qualSlot_" + wizardKey);
      if (!slot) return;
      try { slot.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
      slot.classList.add("reupload-highlight");
      setTimeout(function () { slot.classList.remove("reupload-highlight"); }, 4200);
    }, 350);
  }

  // ── Init ───────────────────────────────────
  fetch("/api/auth/session", { credentials: "same-origin" })
    .then((r) => r.json())
    .then((data) => {
      if (!data || !data.authenticated) {
        var dest = window.location.pathname + window.location.search;
        window.location.replace("/pages/signin" + (/^\/pages\//.test(dest) ? "?next=" + encodeURIComponent(dest) : ""));
        return;
      }
      // Store profile for name matching
      if (data.profile) window.gpSessionProfile = data.profile;

      // Already on the eligibility waitlist (country not supported yet)?
      // Show the "we'll be in touch" state instead of the wizard trap.
      if (getWaitlistRecord()) {
        showEligibilityScreen(true);
        return;
      }

      // If onboarding already completed and navigated here directly, allow re-entry
      // (removed auto-redirect to dashboard so users can redo onboarding via button)

      var eligibilityScreenShown = false;
      // Guards the terminal-.catch safety net below against double-rendering: set
      // true right after this chain successfully paints something (the eligibility
      // screen or the wizard step), so a throw later in the chain never re-renders
      // on top of what's already on screen.
      var initRendered = false;

      // Cross-device restore: the server holds the wizard blob (user_state.gp_onboarding)
      // and the authoritative per-document review statuses (user_documents). Restore
      // both BEFORE first paint so a returning GP resumes instead of starting over.
      fetch("/api/state", { credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var st = (d && d.state) || {};
          var flag = st.gp_eligibility_waitlist;
          if (flag) {
            try { localStorage.setItem(ELIGIBILITY_WAITLIST_KEY, typeof flag === "string" ? flag : JSON.stringify(flag)); } catch (e) {}
            eligibilityScreenShown = true;
            showEligibilityScreen(true);
            initRendered = true;
            return null;
          }
          var blob = st.gp_onboarding;
          if (typeof blob === "string") { try { blob = JSON.parse(blob); } catch (e) { blob = null; } }
          var selCountry = st.gp_selected_country;
          if (typeof selCountry === "string") { try { var p = JSON.parse(selCountry); if (typeof p === "string") selCountry = p; } catch (e) {} }
          mergeServerOnboarding(blob, selCountry);
          if (!state.country) return null;
          return fetch("/api/onboarding-documents?country=" + encodeURIComponent(state.country), { credentials: "same-origin" })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (docsResp) {
              if (docsResp && docsResp.ok) applyServerDocStatuses(docsResp.docs || {});
            })
            .catch(function () { /* best effort */ });
        })
        .catch(function () { /* best effort — local state still works */ })
        .then(function () {
          if (eligibilityScreenShown) return; // eligibility screen already rendered — never fall through to the wizard
          // Deep link from reminder emails: ?step=N opens that step. Deep link from
          // reject emails: ?reupload=<docKey> opens the qualification step at that doc.
          var params = new URLSearchParams(window.location.search);
          var urlStep = parseInt(params.get("step"), 10);
          if (!isNaN(urlStep) && urlStep >= 0 && urlStep < TOTAL_STEPS) currentStep = urlStep;
          var reuploadRaw = params.get("reupload") || "";
          var reuploadKey = reuploadRaw && state.country ? resolveReuploadParamKey(reuploadRaw, state.country) : null;
          if (reuploadKey) currentStep = 1;
          saveState();
          goToStep(currentStep);
          initRendered = true;
          if (reuploadKey) highlightQualSlot(reuploadKey);
        })
        .catch(function (e) {
          // Safety net: a throw anywhere in the restore chain above (e.g. during
          // render) must not leave an unhandled rejection with nothing on screen.
          // Only paint the wizard here if nothing was rendered yet — avoids
          // double-rendering over an already-shown eligibility screen or wizard step.
          try { if (!initRendered) goToStep(currentStep); } catch (e2) {}
        });
    })
    .catch(() => {
      var dest = window.location.pathname + window.location.search;
      window.location.replace("/pages/signin" + (/^\/pages\//.test(dest) ? "?next=" + encodeURIComponent(dest) : ""));
    });
})();

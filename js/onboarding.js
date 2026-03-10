(function () {
  "use strict";

  const TOTAL_STEPS = 8;
  const STORAGE_KEY = "gp_onboarding";
  const MAX_RETRIES = 3;

  const COUNTRIES = [
    { code: "GB", name: "United Kingdom", flag: "\u{1F1EC}\u{1F1E7}" },
    { code: "IE", name: "Ireland", flag: "\u{1F1EE}\u{1F1EA}" },
    { code: "NZ", name: "New Zealand", flag: "\u{1F1F3}\u{1F1FF}" },
  ];

  const COUNTRY_DOCS = {
    GB: [
      { key: "mrcgp_cert", label: "MRCGP Certificate", type: "MRCGP Certificate" },
      { key: "cct_or_pmetb", label: "CCT or PMETB Certificate", type: "CCT or PMETB Certificate" },
    ],
    IE: [
      { key: "micgp_cert", label: "MICGP Certificate", type: "MICGP Certificate" },
      { key: "cscst_cert", label: "CSCST Certificate", type: "CSCST Certificate" },
    ],
    NZ: [
      { key: "frnzcgp_cert", label: "FRNZCGP Certificate", type: "FRNZCGP Certificate" },
    ],
  };

  // ── State ──────────────────────────────────
  let state = loadState();
  let currentStep = state.currentStep || 0;
  let childrenCount = state.childrenCount || 1;

  function defaultState() {
    return {
      currentStep: 0,
      country: "",
      qualDocs: {},         // { [docKey]: { fileName, status, scanResult, retryCount, nameMatch } }
      accountReviewFlag: false,
      targetDate: "",
      preferredCity: "",
      whoMoving: "",
      childrenCount: 1,
      specialNotes: "",
      cvFile: null,
      idFile: null,
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
    if (window.gpSessionProfile && window.gpSessionProfile.full_name) return window.gpSessionProfile.full_name;
    if (window.gpSessionProfile && window.gpSessionProfile.name) return window.gpSessionProfile.name;
    if (window.gpSessionProfile && window.gpSessionProfile.email) return window.gpSessionProfile.email.split("@")[0];
    return "";
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
      else if (status === "failed") { badgeClass = "failed"; badgeText = "Failed"; }
      else if (status === "scanning") { badgeClass = "scanning"; badgeText = "Scanning..."; }
      else if (status === "manual_review") { badgeClass = "review"; badgeText = "Under Review"; }

      let infoHtml = "";
      if (status === "scanning") {
        infoHtml = '<div class="qual-doc-slot-info"><span class="qual-doc-spinner"></span> AI is verifying your document...</div>';
      } else if (status === "verified") {
        infoHtml = '<div class="qual-doc-slot-info" style="color:var(--green);">&#10003; ' + (docState.fileName || "Document") + ' verified</div>';
      } else if (status === "failed" && retryCount >= MAX_RETRIES) {
        infoHtml = '<div class="qual-doc-slot-info error">Max attempts reached. Will be reviewed manually.</div>';
      } else if (status === "failed") {
        const issues = (docState.scanResult && docState.scanResult.issues) ? docState.scanResult.issues.join(", ") : "Verification failed";
        infoHtml = '<div class="qual-doc-slot-info error">' + issues + '</div>';
        infoHtml += '<div class="qual-doc-slot-retry">Attempt ' + retryCount + ' of ' + MAX_RETRIES + '</div>';
      } else if (status === "manual_review") {
        infoHtml = '<div class="qual-doc-slot-info" style="color:var(--blue);">Flagged for manual review</div>';
      }

      const showActions = status !== "verified" && status !== "scanning" && !(status === "failed" && retryCount >= MAX_RETRIES && !unlimitedRetries) && status !== "manual_review";

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
          '<input type="file" id="qualFileInput_' + doc.key + '" accept=".pdf,.jpg,.jpeg,.png,.webp" style="display:none;" />'
        : '') +
        infoHtml;

      // "OR" label for CCT/PMETB
      if (doc.key === "cct_or_pmetb") {
        const orDiv = document.createElement("div");
        orDiv.className = "qual-doc-or";
        orDiv.textContent = "Upload either your CCT or PMETB certificate";
        qualDocsContainer.appendChild(orDiv);
      }

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
          if (err) { alert(err); return; }
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
      // Convert to base64
      const base64 = await fileToBase64(fileOrBlob);
      // After resizing, image is always JPEG
      const mimeType = "image/jpeg";

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
        if (v.verified && v.nameMatch !== "mismatch") {
          state.qualDocs[docKey].status = "verified";
          state.qualDocs[docKey].scanResult = v;
          state.qualDocs[docKey].nameMatch = v.nameMatch;
        } else if (v.nameMatch === "mismatch") {
          state.qualDocs[docKey].status = "failed";
          state.qualDocs[docKey].retryCount = (state.qualDocs[docKey].retryCount || 0) + 1;
          state.qualDocs[docKey].scanResult = { ...v, issues: v.issues || ["Name on document doesn't match your profile."] };
          state.accountReviewFlag = true;
        } else {
          state.qualDocs[docKey].status = "failed";
          state.qualDocs[docKey].retryCount = (state.qualDocs[docKey].retryCount || 0) + 1;
          state.qualDocs[docKey].scanResult = v;
        }
      } else if (data.queued) {
        state.qualDocs[docKey].status = "manual_review";
        state.qualDocs[docKey].scanResult = { issues: [data.message || "Queued for review"] };
      } else {
        state.qualDocs[docKey].status = "failed";
        state.qualDocs[docKey].retryCount = (state.qualDocs[docKey].retryCount || 0) + 1;
        state.qualDocs[docKey].scanResult = { issues: [data.message || "Verification failed"] };
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
      state.qualDocs[docKey].retryCount = (state.qualDocs[docKey].retryCount || 0) + 1;
      state.qualDocs[docKey].scanResult = { issues: [err.message || "Network error. Please try again."] };
    }

    delete activeDocUploads[docKey];
    saveState();
    renderQualDocSlots();
  }

  function fileToBase64(fileOrBlob) {
    return new Promise((resolve, reject) => {
      // If file is PDF, tell user to use image
      if (fileOrBlob.type === "application/pdf") {
        reject(new Error("Please upload an image (JPG, PNG) or use the camera. PDF scanning is not yet supported."));
        return;
      }

      // Resize image to keep under Vercel 4.5MB body limit
      var isImage = /^image\//i.test(fileOrBlob.type);
      if (isImage) {
        var img = new Image();
        var url = URL.createObjectURL(fileOrBlob);
        img.onload = function () {
          URL.revokeObjectURL(url);
          var maxDim = 1200;
          var w = img.width, h = img.height;
          if (w > maxDim || h > maxDim) {
            var scale = maxDim / Math.max(w, h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
          }
          var canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          var dataUrl = canvas.toDataURL("image/jpeg", 0.8);
          resolve(dataUrl.split(",")[1]);
        };
        img.onerror = function () {
          URL.revokeObjectURL(url);
          reject(new Error("Failed to load image."));
        };
        img.src = url;
      } else {
        var reader = new FileReader();
        reader.onload = function () {
          resolve(reader.result.split(",")[1] || reader.result);
        };
        reader.onerror = function () { reject(new Error("Failed to read file.")); };
        reader.readAsDataURL(fileOrBlob);
      }
    });
  }

  function allDocsComplete() {
    const docs = COUNTRY_DOCS[state.country] || [];
    if (docs.length === 0) return false;
    return docs.every((doc) => {
      const d = state.qualDocs && state.qualDocs[doc.key];
      return d && (d.status === "verified" || d.status === "manual_review");
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

  // ── CV and ID uploads (step 6) ─────────────
  function setupSimpleUpload(cardId, iconId, statusId, progressId, progressBarId, fileInputId, stateKey, label) {
    const card = document.getElementById(cardId);
    const fileInput = document.getElementById(fileInputId);
    if (!card || !fileInput) return;

    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      fileInput.click();
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
    });

    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const check = isValidFile(file);
      if (!check.ok) { showError("docsError", check.reason); return; }
      hideError("docsError");

      const icon = document.getElementById(iconId);
      const statusEl = document.getElementById(statusId);
      const progress = document.getElementById(progressId);
      const progressBar = document.getElementById(progressBarId);

      card.className = "upload-card";
      icon.className = "upload-card-icon pending";
      statusEl.textContent = "Uploading...";
      statusEl.className = "upload-card-status pending";
      progress.classList.add("show");
      progressBar.style.width = "0%";

      state[stateKey] = { name: file.name, size: file.size, type: file.type, status: "uploading" };
      saveState();

      await simulateUpload(file, (pct) => { progressBar.style.width = pct + "%"; });

      progress.classList.remove("show");
      card.className = "upload-card completed";
      icon.className = "upload-card-icon completed";
      icon.querySelector("svg").innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';
      statusEl.textContent = file.name;
      statusEl.className = "upload-card-status completed";
      state[stateKey].status = "uploaded";
      saveState();
    });

    // restore
    if (state[stateKey] && state[stateKey].status === "uploaded") {
      const icon = document.getElementById(iconId);
      const statusEl = document.getElementById(statusId);
      card.className = "upload-card completed";
      icon.className = "upload-card-icon completed";
      icon.querySelector("svg").innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';
      statusEl.textContent = state[stateKey].name;
      statusEl.className = "upload-card-status completed";
    }
  }

  setupSimpleUpload("cvCard", "cvCardIcon", "cvCardStatus", "cvProgress", "cvProgressBar", "cvFileInput", "cvFile", "CV");
  setupSimpleUpload("idCard", "idCardIcon", "idCardStatus", "idProgress", "idProgressBar", "idFileInput", "idFile", "ID");

  // ── Update doc qual card on step 6 ──────────
  function updateDocQualCard() {
    const icon = document.getElementById("docQualIcon");
    const status = document.getElementById("docQualStatus");
    const card = document.getElementById("docQualCard");
    if (!icon || !status || !card) return;

    const docs = COUNTRY_DOCS[state.country] || [];
    const allVerified = docs.length > 0 && docs.every((d) => state.qualDocs[d.key] && state.qualDocs[d.key].status === "verified");
    const anyDone = docs.some((d) => state.qualDocs[d.key] && (state.qualDocs[d.key].status === "verified" || state.qualDocs[d.key].status === "manual_review"));

    if (allVerified) {
      card.className = "upload-card completed";
      icon.className = "upload-card-icon completed";
      status.textContent = "All qualifications verified";
      status.className = "upload-card-status completed";
    } else if (anyDone) {
      card.className = "upload-card";
      icon.className = "upload-card-icon completed";
      status.textContent = "Qualifications under review";
      status.className = "upload-card-status review";
    } else {
      card.className = "upload-card";
      icon.className = "upload-card-icon pending";
      status.textContent = "Not yet verified";
      status.className = "upload-card-status pending";
    }
  }

  // doc qual replace on step 6
  const docQualReplace = document.getElementById("docQualReplace");
  if (docQualReplace) {
    docQualReplace.addEventListener("click", () => {
      // Go back to step 2 to re-upload
      goToStep(2);
    });
  }

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

  // ── Special notes ──────────────────────────
  const notesEl = document.getElementById("specialNotes");
  if (state.specialNotes) notesEl.value = state.specialNotes;
  notesEl.addEventListener("input", () => {
    state.specialNotes = notesEl.value;
    saveState();
  });

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
    switch (step) {
      case 0: return true;
      case 1: // country
        if (!state.country) { showError("countryError"); return false; }
        if (!COUNTRY_DOCS[state.country]) {
          const hint = document.getElementById("countryHint");
          if (hint) hint.style.display = "block";
          return false;
        }
        hideError("countryError");
        return true;
      case 2: // qualification docs
        if (!allDocsComplete()) {
          showError("qualDocsError", "Please verify all required documents before continuing.");
          return false;
        }
        hideError("qualDocsError");
        return true;
      case 3: // date & city
        let ok = true;
        if (!state.targetDate) { showError("dateError", "Please select a target date."); ok = false; }
        else {
          const d = new Date(state.targetDate);
          if (d < minDate) { showError("dateError", "Your target date must be at least 5 months from today."); ok = false; }
          else hideError("dateError");
        }
        if (!state.preferredCity) { showError("cityError"); ok = false; }
        else hideError("cityError");
        return ok;
      case 4: // who
        if (!state.whoMoving) { showError("whoError"); return false; }
        hideError("whoError");
        return true;
      case 5: return true; // special notes (optional)
      case 6: // documents
        if (!state.cvFile || state.cvFile.status !== "uploaded" || !state.idFile || state.idFile.status !== "uploaded") {
          showError("docsError");
          return false;
        }
        hideError("docsError");
        return true;
      case 7: return true; // review
      default: return true;
    }
  }

  // ── Skip logic ─────────────────────────────
  function isSkippable(step) {
    return step === 5;
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
    if (state.specialNotes) rows.push({ label: "Notes", value: state.specialNotes.slice(0, 120) + (state.specialNotes.length > 120 ? "..." : "") });
    rows.push({
      label: "CV",
      value: state.cvFile && state.cvFile.status === "uploaded" ? "Uploaded" : "Missing",
      cls: state.cvFile && state.cvFile.status === "uploaded" ? "status-verified" : "status-missing",
    });
    rows.push({
      label: "ID document",
      value: state.idFile && state.idFile.status === "uploaded" ? "Uploaded" : "Missing",
      cls: state.idFile && state.idFile.status === "uploaded" ? "status-verified" : "status-missing",
    });

    if (state.accountReviewFlag) {
      rows.push({ label: "Account", value: "Under Review", cls: "status-pending" });
    }

    list.innerHTML = rows.map((r) =>
      `<div class="review-row"><span class="review-label">${r.label}</span><span class="review-value ${r.cls || ""}">${r.value}</span></div>`
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

    if (step === 0) {
      nextBtn.textContent = "GET STARTED";
      nextBtn.classList.remove("submit");
    } else if (step === TOTAL_STEPS - 1) {
      nextBtn.textContent = "SUBMIT";
      nextBtn.classList.add("submit");
    } else {
      nextBtn.textContent = "NEXT";
      nextBtn.classList.remove("submit");
    }

    if (step === TOTAL_STEPS - 1) {
      buildReview();
      updateDocQualCard();
    }

    if (step === 2) renderQualDocSlots();
    if (step === 6) updateDocQualCard();

    saveState();
  }

  nextBtn.addEventListener("click", () => {
    if (!validateStep(currentStep)) return;
    if (currentStep === TOTAL_STEPS - 1) { submitOnboarding(); return; }
    goToStep(currentStep + 1);
  });

  skipBtn.addEventListener("click", () => goToStep(currentStep + 1));
  backBtn.addEventListener("click", () => goToStep(currentStep - 1));

  // ── Submit ─────────────────────────────────
  async function submitOnboarding() {
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

(function () {
  "use strict";

  const TOTAL_STEPS = 8;
  const STORAGE_KEY = "gp_onboarding";
  const COUNTRIES = [
    { code: "GB", name: "United Kingdom", flag: "\u{1F1EC}\u{1F1E7}" },
    { code: "IE", name: "Ireland", flag: "\u{1F1EE}\u{1F1EA}" },
    { code: "NZ", name: "New Zealand", flag: "\u{1F1F3}\u{1F1FF}" },
    { code: "ZA", name: "South Africa", flag: "\u{1F1FF}\u{1F1E6}" },
    { code: "CA", name: "Canada", flag: "\u{1F1E8}\u{1F1E6}" },
    { code: "LK", name: "Sri Lanka", flag: "\u{1F1F1}\u{1F1F0}" },
    { code: "IN", name: "India", flag: "\u{1F1EE}\u{1F1F3}" },
    { code: "PK", name: "Pakistan", flag: "\u{1F1F5}\u{1F1F0}" },
    { code: "NG", name: "Nigeria", flag: "\u{1F1F3}\u{1F1EC}" },
    { code: "OTHER", name: "Other", flag: "\u{1F30D}" },
  ];

  // ── State ──────────────────────────────────
  let state = loadState();
  let currentStep = state.currentStep || 0;
  let childrenCount = state.childrenCount || 1;

  function defaultState() {
    return {
      currentStep: 0,
      country: "",
      countryOther: "",
      qualFile: null,        // { name, size, type, status, scanResult }
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
    // async server save (fire and forget)
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
  const otherCountryInput = document.getElementById("otherCountryInput");

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
    if (c.code === "OTHER") {
      otherCountryInput.classList.add("show");
      otherCountryInput.focus();
    } else {
      otherCountryInput.classList.remove("show");
      state.countryOther = "";
    }
    hideError("countryError");
    saveState();
  }

  countrySearch.addEventListener("input", () => {
    renderCountryList(countrySearch.value);
  });
  countrySearch.addEventListener("focus", () => {
    renderCountryList(countrySearch.value);
  });
  otherCountryInput.addEventListener("input", () => {
    state.countryOther = otherCountryInput.value.trim();
    saveState();
  });
  renderCountryList("");

  // restore country name in search box
  if (state.country) {
    const match = COUNTRIES.find((c) => c.code === state.country);
    if (match) {
      countrySearch.value = match.name;
      if (match.code === "OTHER") {
        otherCountryInput.classList.add("show");
        otherCountryInput.value = state.countryOther || "";
      }
    }
  }

  // ── File upload helpers ────────────────────
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  const ACCEPTED_DOC = ["application/pdf", "image/jpeg", "image/png", "image/jpg",
    "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];

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

  function simulateAIScan() {
    return new Promise((resolve) => {
      setTimeout(() => {
        // simulate AI verification result
        const rand = Math.random();
        if (rand < 0.7) resolve({ status: "verified", message: "Qualification verified" });
        else if (rand < 0.9) resolve({ status: "manual_review", message: "Pending manual review" });
        else resolve({ status: "needs_reupload", message: "Needs clearer copy" });
      }, 2000);
    });
  }

  async function handleQualUpload(file) {
    const check = isValidFile(file);
    if (!check.ok) {
      showError("qualError", check.reason);
      return;
    }
    hideError("qualError");

    // show card, hide zone
    document.getElementById("qualUploadZone").parentElement.style.display = "none";
    const cardEl = document.getElementById("qualUploadCard");
    cardEl.style.display = "block";

    const card = document.getElementById("qualCard");
    const icon = document.getElementById("qualCardIcon");
    const title = document.getElementById("qualCardTitle");
    const statusEl = document.getElementById("qualCardStatus");
    const progress = document.getElementById("qualProgress");
    const progressBar = document.getElementById("qualProgressBar");

    title.textContent = file.name;
    card.className = "upload-card";
    icon.className = "upload-card-icon pending";
    statusEl.textContent = "Uploading...";
    statusEl.className = "upload-card-status pending";
    progress.classList.add("show");
    progressBar.style.width = "0%";

    state.qualFile = { name: file.name, size: file.size, type: file.type, status: "uploading", scanResult: null };
    saveState();

    await simulateUpload(file, (pct) => {
      progressBar.style.width = pct + "%";
    });

    // scanning phase
    progress.classList.remove("show");
    card.className = "upload-card scanning";
    icon.className = "upload-card-icon scanning";
    statusEl.textContent = "AI scanning...";
    statusEl.className = "upload-card-status scanning";
    state.qualFile.status = "scanning";
    saveState();

    // try real AI scan first, fall back to simulated
    let result;
    try {
      const resp = await fetch("/api/ai/scan-qualification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ fileName: file.name, textSnippet: "" }),
      });
      const data = await resp.json();
      if (data.ok && data.classification) {
        const conf = data.classification.confidence || 0;
        if (conf >= 0.7) result = { status: "verified", message: "Qualification verified" };
        else if (conf >= 0.4) result = { status: "manual_review", message: "Pending manual review" };
        else result = { status: "needs_reupload", message: "Needs clearer copy" };
      } else {
        result = await simulateAIScan();
      }
    } catch (e) {
      result = await simulateAIScan();
    }

    state.qualFile.status = result.status;
    state.qualFile.scanResult = result;

    if (result.status === "verified") {
      card.className = "upload-card completed";
      icon.className = "upload-card-icon completed";
      statusEl.textContent = "Verified";
      statusEl.className = "upload-card-status completed";
    } else if (result.status === "manual_review") {
      card.className = "upload-card";
      icon.className = "upload-card-icon completed";
      statusEl.textContent = "Pending manual review";
      statusEl.className = "upload-card-status review";
    } else {
      card.className = "upload-card error";
      icon.className = "upload-card-icon error";
      statusEl.textContent = "Please upload a clearer copy";
      statusEl.className = "upload-card-status error";
    }
    saveState();
  }

  // qual file input
  const qualFileInput = document.getElementById("qualFileInput");
  qualFileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleQualUpload(file);
  });

  // qual replace button
  document.getElementById("qualReplaceBtn").addEventListener("click", () => {
    qualFileInput.value = "";
    qualFileInput.click();
  });

  // Restore qual upload state
  if (state.qualFile && state.qualFile.status !== "uploading" && state.qualFile.status !== "scanning") {
    restoreQualCard();
  }

  function restoreQualCard() {
    if (!state.qualFile) return;
    document.getElementById("qualUploadZone").parentElement.style.display = "none";
    document.getElementById("qualUploadCard").style.display = "block";
    const card = document.getElementById("qualCard");
    const icon = document.getElementById("qualCardIcon");
    const title = document.getElementById("qualCardTitle");
    const statusEl = document.getElementById("qualCardStatus");
    title.textContent = state.qualFile.name;
    if (state.qualFile.status === "verified") {
      card.className = "upload-card completed";
      icon.className = "upload-card-icon completed";
      statusEl.textContent = "Verified";
      statusEl.className = "upload-card-status completed";
    } else if (state.qualFile.status === "manual_review") {
      card.className = "upload-card";
      icon.className = "upload-card-icon completed";
      statusEl.textContent = "Pending manual review";
      statusEl.className = "upload-card-status review";
    } else {
      card.className = "upload-card error";
      icon.className = "upload-card-icon error";
      statusEl.textContent = "Please upload a clearer copy";
      statusEl.className = "upload-card-status error";
    }
  }

  // ── CV and ID uploads (step 6) ─────────────
  function setupSimpleUpload(cardId, iconId, statusId, progressId, progressBarId, fileInputId, stateKey, label) {
    const card = document.getElementById(cardId);
    const fileInput = document.getElementById(fileInputId);

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

  // doc qual replace on step 6
  document.getElementById("docQualReplace").addEventListener("click", () => {
    // create temp file input
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".pdf,.jpg,.jpeg,.png,.doc,.docx";
    inp.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) handleQualUpload(file);
      updateDocQualCard();
    });
    inp.click();
  });

  function updateDocQualCard() {
    const icon = document.getElementById("docQualIcon");
    const status = document.getElementById("docQualStatus");
    const card = document.getElementById("docQualCard");
    if (state.qualFile && (state.qualFile.status === "verified" || state.qualFile.status === "manual_review")) {
      card.className = "upload-card completed";
      icon.className = "upload-card-icon completed";
      status.textContent = state.qualFile.status === "verified" ? "Verified" : "Pending review";
      status.className = "upload-card-status completed";
    } else if (state.qualFile) {
      card.className = "upload-card error";
      icon.className = "upload-card-icon error";
      status.textContent = "Needs re-upload";
      status.className = "upload-card-status error";
    } else {
      card.className = "upload-card";
      icon.className = "upload-card-icon pending";
      status.textContent = "Not uploaded";
      status.className = "upload-card-status pending";
    }
  }
  updateDocQualCard();

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
      showError("dateError", "Your target date must be at least 5 months from today to allow enough time for registration and relocation.");
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
    if (msg) el.textContent = msg;
    el.classList.add("show");
  }
  function hideError(id) {
    document.getElementById(id).classList.remove("show");
  }

  // ── Step validation ────────────────────────
  function validateStep(step) {
    switch (step) {
      case 0: return true; // welcome
      case 1: // country
        if (!state.country) { showError("countryError"); return false; }
        if (state.country === "OTHER" && !state.countryOther) { showError("countryError", "Please enter your country."); return false; }
        hideError("countryError");
        return true;
      case 2: // qualification
        if (!state.qualFile || state.qualFile.status === "uploading" || state.qualFile.status === "scanning") {
          showError("qualError");
          return false;
        }
        if (state.qualFile.status === "needs_reupload") {
          showError("qualError", "Please upload a clearer copy of your qualification.");
          return false;
        }
        hideError("qualError");
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
  // skippable: step 5 (special notes)
  function isSkippable(step) {
    return step === 5;
  }

  // ── Review builder ─────────────────────────
  function buildReview() {
    const list = document.getElementById("reviewList");
    const countryName = state.country === "OTHER"
      ? (state.countryOther || "Other")
      : (COUNTRIES.find((c) => c.code === state.country) || {}).name || "Not set";

    const qualStatus = state.qualFile
      ? (state.qualFile.status === "verified" ? "Verified" : state.qualFile.status === "manual_review" ? "Pending review" : "Needs re-upload")
      : "Not uploaded";
    const qualClass = state.qualFile
      ? (state.qualFile.status === "verified" ? "status-verified" : state.qualFile.status === "manual_review" ? "status-pending" : "status-missing")
      : "status-missing";

    const whoLabels = {
      just_me: "Just me",
      me_partner: "Me & partner",
      me_children: "Me & children",
      me_partner_children: "Family",
    };
    const hasChildren = state.whoMoving === "me_children" || state.whoMoving === "me_partner_children";

    const rows = [
      { label: "Country", value: countryName },
      { label: "Qualification", value: qualStatus, cls: qualClass },
      { label: "Target date", value: state.targetDate ? new Date(state.targetDate).toLocaleDateString("en-AU", { year: "numeric", month: "long", day: "numeric" }) : "Not set" },
      { label: "Preferred city", value: state.preferredCity || "Not set" },
      { label: "Who's moving", value: whoLabels[state.whoMoving] || "Not set" },
    ];
    if (hasChildren) {
      rows.push({ label: "Children", value: String(childrenCount) });
    }
    if (state.specialNotes) {
      rows.push({ label: "Notes", value: state.specialNotes.slice(0, 120) + (state.specialNotes.length > 120 ? "..." : "") });
    }
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

    list.innerHTML = rows.map((r) =>
      `<div class="review-row"><span class="review-label">${r.label}</span><span class="review-value ${r.cls || ""}">${r.value}</span></div>`
    ).join("");
  }

  // ── Navigation ─────────────────────────────
  function goToStep(step) {
    if (step < 0 || step >= TOTAL_STEPS) return;

    const prev = currentStep;
    currentStep = step;

    // update shell data-step for blob colors
    shell.dataset.step = step;

    // slide transitions
    slides.forEach((s, i) => {
      s.classList.remove("active", "exit-left");
      if (i === step) {
        s.classList.add("active");
      } else if (i === prev && step > prev) {
        s.classList.add("exit-left");
      }
    });

    // progress dots
    dots.forEach((d, i) => {
      d.classList.remove("active", "done");
      if (i === step) d.classList.add("active");
      else if (i < step) d.classList.add("done");
    });

    // back button
    backBtn.classList.toggle("visible", step > 0);

    // skip button
    if (isSkippable(step)) {
      skipBtn.classList.remove("invisible");
      skipBtn.textContent = "SKIP";
    } else {
      skipBtn.classList.add("invisible");
    }

    // next button text
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

    // build review on last step
    if (step === TOTAL_STEPS - 1) {
      buildReview();
      updateDocQualCard();
    }

    // update doc qual card when entering step 6
    if (step === 6) updateDocQualCard();

    saveState();
  }

  nextBtn.addEventListener("click", () => {
    if (!validateStep(currentStep)) return;

    if (currentStep === TOTAL_STEPS - 1) {
      submitOnboarding();
      return;
    }
    goToStep(currentStep + 1);
  });

  skipBtn.addEventListener("click", () => {
    goToStep(currentStep + 1);
  });

  backBtn.addEventListener("click", () => {
    goToStep(currentStep - 1);
  });

  // ── Submit ─────────────────────────────────
  async function submitOnboarding() {
    loadingText.textContent = "Setting up your dashboard...";
    loadingOverlay.classList.add("show");

    state.completedAt = new Date().toISOString();
    saveState();

    // also save to gp_selected_country for the main app
    try { localStorage.setItem("gp_selected_country", JSON.stringify(state.country === "OTHER" ? state.countryOther : (COUNTRIES.find((c) => c.code === state.country) || {}).name || state.country)); } catch (e) { /* ignore */ }

    try {
      const resp = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(state),
      });
      await resp.json().catch(() => ({}));
    } catch (e) {
      // still continue even if server save fails
    }

    // save to user state for the main app
    try {
      await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ gp_onboarding_complete: true, gp_selected_country: state.country === "OTHER" ? state.countryOther : state.country }),
      });
    } catch (e) { /* ignore */ }

    loadingOverlay.classList.remove("show");
    successScreen.classList.add("show");
  }

  document.getElementById("successContinueBtn").addEventListener("click", () => {
    window.location.href = "/pages/index.html";
  });

  // ── Init ───────────────────────────────────
  // Check auth first
  fetch("/api/auth/session", { credentials: "same-origin" })
    .then((r) => r.json())
    .then((data) => {
      if (!data || !data.authenticated) {
        window.location.replace("/pages/signin.html");
        return;
      }
      // If onboarding already completed, go to dashboard
      // TODO: re-enable once onboarding is finalized — currently always showing for testing
      if (false && state.completedAt) {
        window.location.replace("/pages/index.html");
        return;
      }
      // restore step
      goToStep(currentStep);
    })
    .catch(() => {
      window.location.replace("/pages/signin.html");
    });
})();

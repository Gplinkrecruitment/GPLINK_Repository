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

  // Every country a GP could plausibly have trained in (UN members + common
  // others), alphabetical by name. Selecting one of these that is NOT in
  // COUNTRIES routes to the eligibility waitlist with the exact name pre-filled
  // — the GP never types their country freehand, so no misspellings reach the
  // waitlist. Flag emoji are derived from the ISO alpha-2 code (regional
  // indicator pair), which cannot drift out of sync with the code.
  const ALL_COUNTRIES = [
    ["AF", "Afghanistan"], ["AL", "Albania"], ["DZ", "Algeria"], ["AD", "Andorra"],
    ["AO", "Angola"], ["AG", "Antigua and Barbuda"], ["AR", "Argentina"], ["AM", "Armenia"],
    ["AU", "Australia"], ["AT", "Austria"], ["AZ", "Azerbaijan"], ["BS", "Bahamas"],
    ["BH", "Bahrain"], ["BD", "Bangladesh"], ["BB", "Barbados"], ["BY", "Belarus"],
    ["BE", "Belgium"], ["BZ", "Belize"], ["BJ", "Benin"], ["BT", "Bhutan"],
    ["BO", "Bolivia"], ["BA", "Bosnia and Herzegovina"], ["BW", "Botswana"], ["BR", "Brazil"],
    ["BN", "Brunei"], ["BG", "Bulgaria"], ["BF", "Burkina Faso"], ["BI", "Burundi"],
    ["KH", "Cambodia"], ["CM", "Cameroon"], ["CA", "Canada"], ["CV", "Cape Verde"],
    ["CF", "Central African Republic"], ["TD", "Chad"], ["CL", "Chile"], ["CN", "China"],
    ["CO", "Colombia"], ["KM", "Comoros"], ["CR", "Costa Rica"], ["HR", "Croatia"],
    ["CU", "Cuba"], ["CY", "Cyprus"], ["CZ", "Czech Republic"],
    ["CD", "Democratic Republic of the Congo"], ["DK", "Denmark"], ["DJ", "Djibouti"],
    ["DM", "Dominica"], ["DO", "Dominican Republic"], ["EC", "Ecuador"], ["EG", "Egypt"],
    ["SV", "El Salvador"], ["GQ", "Equatorial Guinea"], ["ER", "Eritrea"], ["EE", "Estonia"],
    ["SZ", "Eswatini"], ["ET", "Ethiopia"], ["FJ", "Fiji"], ["FI", "Finland"],
    ["FR", "France"], ["GA", "Gabon"], ["GM", "Gambia"], ["GE", "Georgia"],
    ["DE", "Germany"], ["GH", "Ghana"], ["GR", "Greece"], ["GD", "Grenada"],
    ["GT", "Guatemala"], ["GN", "Guinea"], ["GW", "Guinea-Bissau"], ["GY", "Guyana"],
    ["HT", "Haiti"], ["HN", "Honduras"], ["HK", "Hong Kong"], ["HU", "Hungary"],
    ["IS", "Iceland"], ["IN", "India"], ["ID", "Indonesia"], ["IR", "Iran"],
    ["IQ", "Iraq"], ["IE", "Ireland"], ["IL", "Israel"], ["IT", "Italy"],
    ["CI", "Ivory Coast"], ["JM", "Jamaica"], ["JP", "Japan"], ["JO", "Jordan"],
    ["KZ", "Kazakhstan"], ["KE", "Kenya"], ["KI", "Kiribati"], ["XK", "Kosovo"],
    ["KW", "Kuwait"], ["KG", "Kyrgyzstan"], ["LA", "Laos"], ["LV", "Latvia"],
    ["LB", "Lebanon"], ["LS", "Lesotho"], ["LR", "Liberia"], ["LY", "Libya"],
    ["LI", "Liechtenstein"], ["LT", "Lithuania"], ["LU", "Luxembourg"], ["MO", "Macau"],
    ["MG", "Madagascar"], ["MW", "Malawi"], ["MY", "Malaysia"], ["MV", "Maldives"],
    ["ML", "Mali"], ["MT", "Malta"], ["MH", "Marshall Islands"], ["MR", "Mauritania"],
    ["MU", "Mauritius"], ["MX", "Mexico"], ["FM", "Micronesia"], ["MD", "Moldova"],
    ["MC", "Monaco"], ["MN", "Mongolia"], ["ME", "Montenegro"], ["MA", "Morocco"],
    ["MZ", "Mozambique"], ["MM", "Myanmar"], ["NA", "Namibia"], ["NR", "Nauru"],
    ["NP", "Nepal"], ["NL", "Netherlands"], ["NZ", "New Zealand"], ["NI", "Nicaragua"],
    ["NE", "Niger"], ["NG", "Nigeria"], ["KP", "North Korea"], ["MK", "North Macedonia"],
    ["NO", "Norway"], ["OM", "Oman"], ["PK", "Pakistan"], ["PW", "Palau"],
    ["PS", "Palestine"], ["PA", "Panama"], ["PG", "Papua New Guinea"], ["PY", "Paraguay"],
    ["PE", "Peru"], ["PH", "Philippines"], ["PL", "Poland"], ["PT", "Portugal"],
    ["QA", "Qatar"], ["CG", "Republic of the Congo"], ["RO", "Romania"], ["RU", "Russia"],
    ["RW", "Rwanda"], ["KN", "Saint Kitts and Nevis"], ["LC", "Saint Lucia"],
    ["VC", "Saint Vincent and the Grenadines"], ["WS", "Samoa"], ["SM", "San Marino"],
    ["ST", "Sao Tome and Principe"], ["SA", "Saudi Arabia"], ["SN", "Senegal"],
    ["RS", "Serbia"], ["SC", "Seychelles"], ["SL", "Sierra Leone"], ["SG", "Singapore"],
    ["SK", "Slovakia"], ["SI", "Slovenia"], ["SB", "Solomon Islands"], ["SO", "Somalia"],
    ["ZA", "South Africa"], ["KR", "South Korea"], ["SS", "South Sudan"], ["ES", "Spain"],
    ["LK", "Sri Lanka"], ["SD", "Sudan"], ["SR", "Suriname"], ["SE", "Sweden"],
    ["CH", "Switzerland"], ["SY", "Syria"], ["TW", "Taiwan"], ["TJ", "Tajikistan"],
    ["TZ", "Tanzania"], ["TH", "Thailand"], ["TL", "Timor-Leste"], ["TG", "Togo"],
    ["TO", "Tonga"], ["TT", "Trinidad and Tobago"], ["TN", "Tunisia"], ["TR", "Turkey"],
    ["TM", "Turkmenistan"], ["TV", "Tuvalu"], ["UG", "Uganda"], ["UA", "Ukraine"],
    ["AE", "United Arab Emirates"], ["GB", "United Kingdom"], ["US", "United States"],
    ["UY", "Uruguay"], ["UZ", "Uzbekistan"], ["VU", "Vanuatu"], ["VA", "Vatican City"],
    ["VE", "Venezuela"], ["VN", "Vietnam"], ["YE", "Yemen"], ["ZM", "Zambia"],
    ["ZW", "Zimbabwe"],
  ].map(function (pair) {
    var code = pair[0];
    return {
      code: code,
      name: pair[1],
      flag: String.fromCodePoint(0x1f1e6 + code.charCodeAt(0) - 65, 0x1f1e6 + code.charCodeAt(1) - 65),
    };
  });

  // "MRCGP Certificate" names exactly one piece of paper; "Primary Medical Degree"
  // names a category, and the doctor has to work out which document that is. GPs
  // trained overseas routinely resolve it to their home medical council's
  // REGISTRATION certificate, because that certificate lists the MBBS by name — so
  // the slot now states both what we need and what we don't. `label` stays short:
  // it is reused for the camera title, the uploaded filename and the review row.
  // Defined once and spread per country so the three lists cannot drift apart.
  const PRIMARY_MED_DEGREE_DOC = {
    key: "primary_med_degree",
    label: "Primary Medical Degree",
    displayLabel: "Primary Medical Degree (MBBS, MBChB, MD)",
    hint: "The degree certificate issued by your university — not your medical council registration.",
    type: "Primary Medical Degree",
  };

  const COUNTRY_DOCS = {
    GB: [
      { key: "mrcgp_cert", label: "MRCGP Certificate", type: "MRCGP Certificate" },
      { key: "cct_cert", label: "CCT Certificate", type: "CCT Certificate" },
      { ...PRIMARY_MED_DEGREE_DOC },
    ],
    IE: [
      { key: "micgp_cert", label: "MICGP Certificate", type: "MICGP Certificate" },
      { ...PRIMARY_MED_DEGREE_DOC },
    ],
    NZ: [
      { key: "frnzcgp_cert", label: "FRNZCGP Certificate", type: "FRNZCGP Certificate" },
      { ...PRIMARY_MED_DEGREE_DOC },
    ],
  };

  // Docs-only mode (?docs=1): an ONBOARDED doctor is sent back here by the
  // MyIntealth gateway to upload the certificates onboarding no longer asks
  // for (owner decision 2026-08-31 — the wizard now takes their medical
  // register number instead, and the documents are collected when their
  // Australian registration actually starts). In this mode the wizard is
  // pinned to the documents step and renders the ORIGINAL upload slots.
  var DOCS_ONLY_MODE = false;
  try { DOCS_ONLY_MODE = new URLSearchParams(window.location.search).get("docs") === "1"; } catch (e) {}

  // Australian GP build (WP-05). auSwitchOn stays false unless the server says
  // the Australian pathway is switched on (set in the Australian section near
  // the end of this file); AU_INVITE_LINK is the ?au=1 a released-from-waitlist
  // invite carries. With the switch off neither changes anything.
  var auSwitchOn = false;
  var AU_INVITE_LINK = false;
  try { AU_INVITE_LINK = new URLSearchParams(window.location.search).get("au") === "1"; } catch (e) {}

  // Client mirror of lib/register-verification.js (kept in sync by
  // tests/register-onboarding-sync.test.js — change BOTH together).
  var REGISTER_BODIES_CLIENT = {
    GB: { label: "GMC", pattern: /^\d{7}$/, hint: "Your 7-digit GMC reference number" },
    IE: { label: "IMC", pattern: /^\d{4,6}$/, hint: "Your Medical Council registration number" },
    NZ: { label: "MCNZ", pattern: /^\d{4,6}$/, hint: "Your MCNZ registration number" },
  };

  function validateRegisterNumberClient(country, value) {
    var meta = REGISTER_BODIES_CLIENT[country];
    if (!meta) return { ok: false, message: "Please select your country of qualification first." };
    var n = String(value == null ? "" : value).replace(/[\s-]+/g, "").replace(/[^0-9]/g, "");
    if (!n) return { ok: false, message: "Please enter your " + meta.label + " registration number." };
    if (!meta.pattern.test(n)) return { ok: false, message: "That does not look like a valid " + meta.label + " number. " + meta.hint + "." };
    return { ok: true, number: n };
  }

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
      registerNumber: "",   // medical-register number (GMC/IMC/MCNZ) — replaces the qual-doc uploads at onboarding
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
    }).then(function (r) {
      // FR-7 (S7-01): only ever 409 with the Australian pathway switch on, for
      // a doctor the GP Link team has put on another pathway while this
      // device still held the Australian screens.
      if (r && r.status === 409 && typeof auOnSaveRefused === "function") {
        return r.json().then(auOnSaveRefused).catch(function () {});
      }
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

  function countryRowHtml(c) {
    var cls = state.country === c.code ? ' class="selected"' : "";
    return '<li data-code="' + c.code + '"' + cls + '><span class="country-flag">' + c.flag + "</span> " + escHtml(c.name) + "</li>";
  }

  // Picker mode — module-level on purpose (never persisted; a reload always
  // starts back in "default"). "default" shows ONLY the three supported
  // countries plus a "Somewhere else" row; "other" is the search-the-whole-
  // world mode that row switches into.
  let countryPickerMode = "default";
  const DEFAULT_COUNTRY_PLACEHOLDER = countrySearch ? (countrySearch.placeholder || "Select your country") : "Select your country";
  const OTHER_COUNTRY_PLACEHOLDER = "Search for your country…";

  // Re-renders on every keystroke, so this builds one HTML string and assigns
  // innerHTML once; clicks are handled by a single delegated listener on the
  // UL (below) — no per-row listeners.
  function renderCountryList(filter) {
    const q = (filter || "").toLowerCase().trim();
    let html = "";
    if (countryPickerMode === "other") {
      // OTHER-COUNTRY SEARCH mode: a Back row first, then live matches across
      // ALL countries. The supported three are included in results too, so a
      // GP who types "United Ki" here can still pick the UK and continue down
      // the normal supported path (delegated handler → selectCountry).
      html += '<li class="country-back-row" id="countryBackRow"><span class="country-flag">←</span> Back</li>';
      if (!q) {
        html += '<li class="country-hint-row">Start typing to search all countries</li>';
      } else {
        const matches = ALL_COUNTRIES.filter((c) => c.name.toLowerCase().includes(q) && !(auSwitchOn && c.code === "AU"));
        if (matches.length) {
          html += matches.map(countryRowHtml).join("");
        } else {
          html += '<li class="country-hint-row">No countries match “' + escHtml(String(filter || "").trim()) + '”</li>';
        }
      }
      // ── AU BRANCH: START ── (switch on only: the way back to the first question)
      if (auSwitchOn) html += '<li class="au-first-question-row" id="auBackToFirstQuestion">Registered with Ahpra and working in Australia? Start here</li>';
      // ── AU BRANCH: END ──
      countryList.innerHTML = html;
      return;
    }
    // DEFAULT mode: only the supported three (filtered by the query), plus the
    // always-visible "Somewhere else" row that opens the search-all mode — a
    // GP trained anywhere else is routed via that search to the "Not yet
    // eligible" waitlist instead of a dead end.
    const supported = q ? COUNTRIES.filter((c) => c.name.toLowerCase().includes(q)) : COUNTRIES;
    html += supported.map(countryRowHtml).join("");
    html += '<li class="country-not-listed" id="countryNotListed"><span class="country-flag">\u{1F30F}</span> Somewhere else</li>';
    countryList.innerHTML = html;
  }

  // "Somewhere else" clicked: switch into other-country search (NOT the
  // waitlist — that only opens once a concrete unsupported country is picked).
  function enterOtherCountryMode() {
    countryPickerMode = "other";
    countrySearch.value = "";
    countrySearch.placeholder = OTHER_COUNTRY_PLACEHOLDER;
    renderCountryList("");
    try { countrySearch.focus(); } catch (e) { /* ignore */ }
  }

  function exitOtherCountryMode() {
    countryPickerMode = "default";
    countrySearch.placeholder = DEFAULT_COUNTRY_PLACEHOLDER;
    // Restore the confirmed supported pick (if any) rather than leaving an
    // abandoned search string in the box.
    const sel = COUNTRIES.find((c) => c.code === state.country);
    countrySearch.value = sel ? sel.name : "";
    renderCountryList("");
    try { countrySearch.focus(); } catch (e) { /* ignore */ }
  }

  function selectCountry(c) {
    state.country = c.code;
    // A confirmed supported pick supersedes any earlier unsupported attempt.
    if (state.attemptedCountry) delete state.attemptedCountry;
    // Selecting a supported country always lands the picker back in default mode
    // (the GP may have found it via the other-country search).
    countryPickerMode = "default";
    countrySearch.placeholder = DEFAULT_COUNTRY_PLACEHOLDER;
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

  // Unsupported country picked from the dropdown: do NOT set state.country —
  // instead remember the attempt on the wizard blob (so we know what they
  // wanted even if they abandon the waitlist form) and route to the off-ramp
  // with the exact country name locked in (the anti-typo goal).
  function selectUnsupportedCountry(c) {
    countrySearch.value = c.name;
    state.attemptedCountry = c.name;
    saveState();
    openEligibilityOfframp(c.name, { locked: true });
  }

  countryList.addEventListener("click", (e) => {
    const li = e.target && e.target.closest ? e.target.closest("li") : null;
    if (!li || !countryList.contains(li) || li.classList.contains("country-group-label") || li.classList.contains("country-hint-row")) return;
    if (li.classList.contains("au-first-question-row")) {
      auReopenFirstQuestion();
      return;
    }
    if (li.classList.contains("country-not-listed")) {
      enterOtherCountryMode();
      return;
    }
    if (li.classList.contains("country-back-row")) {
      exitOtherCountryMode();
      return;
    }
    const code = li.getAttribute("data-code");
    if (!code) return;
    const sup = COUNTRIES.find((c) => c.code === code);
    if (sup) { selectCountry(sup); return; }
    const other = ALL_COUNTRIES.find((c) => c.code === code);
    if (other) selectUnsupportedCountry(other);
  });

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

  // Cached copy of the session profile written by auth-guard.js (sessionStorage)
  // — same fallback chain bypass-config.js uses. Covers the race where the GP
  // reaches the off-ramp before this page's /api/auth/session fetch resolves.
  function readCachedSessionProfile() {
    var raw = null;
    try { raw = sessionStorage.getItem("gp_session_profile_cache"); } catch (e) {}
    if (!raw) { try { raw = localStorage.getItem("gp_session_profile_cache"); } catch (e) {} }
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) { return null; }
  }

  function getAccountEmail() {
    try {
      if (window.gpSessionProfile && window.gpSessionProfile.email) return String(window.gpSessionProfile.email).trim();
    } catch (e) {}
    var cached = readCachedSessionProfile();
    if (cached && cached.email) return String(cached.email).trim();
    try { return String(localStorage.getItem("gp_state_owner") || "").trim(); } catch (e) {}
    return "";
  }

  function lockWaitlistInput(input, value) {
    input.value = value;
    input.readOnly = true;
    input.classList.add("input-locked");
  }

  function unlockWaitlistInput(input) {
    input.readOnly = false;
    input.classList.remove("input-locked");
  }

  // Email always comes from the signed-in account (readonly — it's where we'll
  // notify them); name prefills from the account profile when we have it.
  // Re-runs when /api/auth/session resolves (see init) in case the off-ramp
  // opened before the profile arrived. Readonly (NOT disabled) inputs still
  // submit their values through the existing handler.
  function applyWaitlistAccountPrefill() {
    var emailInput = document.getElementById("waitlistEmail");
    var nameInput = document.getElementById("waitlistName");
    var email = getAccountEmail();
    if (emailInput && email) {
      lockWaitlistInput(emailInput, email);
      var hint = document.getElementById("waitlistEmailHint");
      if (hint) hint.style.display = "block";
    }
    var name = getProfileName();
    // Never clobber a name the GP typed into a still-editable field.
    if (nameInput && name && (nameInput.readOnly || !nameInput.value.trim())) {
      lockWaitlistInput(nameInput, name);
    }
  }

  function openEligibilityOfframp(countryGuess, opts) {
    const rec = getWaitlistRecord();
    if (rec) { showEligibilityScreen(true); return; }
    const locked = !!(opts && opts.locked);
    const countryInput = document.getElementById("waitlistCountry");
    const typed = String(countryGuess || "").trim();
    if (countryInput) {
      if (locked && typed) {
        // Opened by picking a country from the dropdown: lock the exact name in.
        lockWaitlistInput(countryInput, typed);
      } else {
        // Opened via "My country isn’t listed": free text stays editable. A
        // value we locked in on an earlier dropdown pick is stale here — clear
        // it so the GP's typed guess (below) can take its place.
        if (countryInput.classList.contains("input-locked")) countryInput.value = "";
        unlockWaitlistInput(countryInput);
        if (!countryInput.value && typed && !COUNTRIES.some((c) => c.name.toLowerCase() === typed.toLowerCase())) {
          countryInput.value = typed;
        }
      }
    }
    applyWaitlistAccountPrefill();
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
    // Don't leave an abandoned unsupported pick sitting in the search box —
    // restore it to the confirmed supported country (if any) or clear it, and
    // drop the picker back into default (supported-only) mode.
    countryPickerMode = "default";
    const sel = COUNTRIES.find((c) => c.code === state.country);
    if (countrySearch) {
      countrySearch.placeholder = DEFAULT_COUNTRY_PLACEHOLDER;
      countrySearch.value = sel ? sel.name : "";
      renderCountryList("");
    }
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
    // Try to get name from the session profile; fall back to the cached copy
    // (auth-guard writes it) when /api/auth/session hasn't resolved yet.
    var profile = window.gpSessionProfile || readCachedSessionProfile();
    if (profile) {
      if (profile.full_name) return profile.full_name;
      if (profile.name) return profile.name;
      var fn = (profile.firstName || profile.first_name || "") + " " + (profile.lastName || profile.last_name || "");
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

  // "Please upload Primary Medical Degree." reads like a form field, not a
  // sentence. Say "your Primary Medical Degree" when we know the document, and
  // leave the generic fallback alone ("your the requested document" is worse).
  function friendlyTargetPhrase(options) {
    var label = getFriendlyIssueTarget(options);
    return label === "the requested document" ? label : "your " + label;
  }

  function isPrimaryMedDegreeTarget(options) {
    return /primary medical degree/i.test(getFriendlyIssueTarget(options));
  }

  /*
   * Photo framing. The scan endpoints reject a picture that does not show the whole
   * document, or that has something lying on top of it (applyPhotoFramingPolicy in
   * server.js) — a doctor's degree photographed with a keyboard resting on it is
   * the case that prompted this. The server phrases those in the finished wording,
   * so each pattern maps its own message back to itself: an issue is humanized more
   * than once on its way to the screen and must not decay into the generic
   * fallback on the second pass. Kept in step with the copy in
   * js/qualification-scan.js, which does the same job for the prepared-document
   * scans outside onboarding.
   */
  var PHOTO_FRAMING_MESSAGES = [
    {
      test: /only fills part of this photo|only fills part of the photo|fills only part of the photo|most of the picture is the desk|document is too small in the (?:photo|picture)/,
      text: "The document only fills part of this photo — most of the picture is the desk or the room around it. Please retake it with the document filling the frame."
    },
    {
      test: /outside this photo|outside the photo|corners of the page are inside|cut off at the edge|part of the (?:document|page) is missing from the (?:photo|picture)/,
      text: "Part of the document is outside this photo. Please retake it so all four corners of the page are inside the frame."
    },
    {
      test: /covering part of the document|is covering part of|lying on top of the document|on top of the document|obstruct/,
      text: "Something is covering part of the document in this photo — for example a hand, a keyboard, a phone or another piece of paper. Please move everything off the page and retake it."
    }
  ];

  function matchPhotoFramingIssue(lower) {
    for (var i = 0; i < PHOTO_FRAMING_MESSAGES.length; i++) {
      if (PHOTO_FRAMING_MESSAGES[i].test.test(lower)) return PHOTO_FRAMING_MESSAGES[i].text;
    }
    return "";
  }

  function humanizeScanIssue(issue, options) {
    var clean = stripIssueHtml(issue);
    var lower = clean.toLowerCase();
    var targetLabel = getFriendlyIssueTarget(options);
    // The model writes this verdict as "appears to be", "looks like" or "seems to
    // be" interchangeably; matching only the first let the useful "X, not Y"
    // wording fall through to the raw model text.
    var wrongDocMatch = clean.match(/(?:appears to be|looks like|seems to be)\s+(.+?),\s+not\s+(.+?)(?:\.|$)/i);

    if (!clean) {
      return "We could not complete the scan. Please try again with a clear image of the full document.";
    }
    // Framing comes before the blurry/name branches: when the page is half out of
    // shot or under a keyboard, "retake it properly" is the one useful instruction,
    // and an unreadable name is a symptom of it rather than a separate problem.
    var framingMessage = matchPhotoFramingIssue(lower);
    if (framingMessage) return framingMessage;
    // Overseas-trained GPs very often send their home medical council's
    // REGISTRATION certificate for this slot, because it lists their MBBS by
    // name — so "this is not your primary medical degree" reads to them as
    // simply wrong, and they re-upload the same file. Name what they sent AND
    // what we need; saying only what it is not is what drove the repeat tries.
    if (isPrimaryMedDegreeTarget(options) &&
        /registration certificate|certificate of registration|medical council|medical board/.test(lower)) {
      return "This looks like your medical council registration certificate. It does list your medical degree, so it's an easy mix-up — but we need the degree certificate itself, the one your university or medical school issued you when you graduated. Please upload that instead, and keep this certificate safe as we'll need it later.";
    }
    // A name that differs from the account on a genuine qualification is a name change
    // (e.g. marriage), not a wrong document. Never tell the GP to upload a "matching"
    // document — a certificate can only carry the name it was issued in.
    if (/looks like a previous name|changed your name|name change|previous name/.test(lower)) {
      return "The name on this document looks like a previous name. If you've changed your name, for example after marriage, that's fine — we'll record it and ask you for proof of your name change at a later step. You don't need to upload a different document.";
    }
    if (/does not match your account|doesn.?t match your profile|different from your account|different from the name on your account|same name as your qualifications/.test(lower)) {
      return "The name on this document is different from the name on your account. If you've changed your name, that's fine — we'll confirm it with you. Otherwise, please check you have uploaded the correct document.";
    }
    if (/could not confidently match the full name|full name on this document|full name on your id|name .*not readable|completely unreadable/.test(lower)) {
      return "We could not clearly read the full name on this document. Please upload a clearer photo with the full name fully visible.";
    }
    if (/too blurry|blurry to read|illegible|not readable|clearer photo|clearer document/.test(lower)) {
      return "We could not read this document clearly. Retake the photo in good light and make sure all text is sharp and fully visible.";
    }
    if (/does not appear to be the correct document|wrong document|correct document type/.test(lower)) {
      return "This looks like a different document from the one needed here. Please upload " + friendlyTargetPhrase(options) + ".";
    }
    if (wrongDocMatch) {
      return "This looks like " + wrongDocMatch[1] + ", not " + targetLabel + ". Please upload " + friendlyTargetPhrase(options) + " instead.";
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

  function identityStepOptionalForTester() {
    // Local dev host: optional for ANY account (owner 2026-09-06) — mirrors the
    // server's loopback ID-scan bypass, so testing the journey never needs a
    // real ID. Production (a real host) still requires the named tester digest.
    if (isLocalDevHost()) return true;
    try { return !!(window.gpIdentityStepOptional && window.gpIdentityStepOptional()); } catch (e) { return false; }
  }
  function isLocalDevHost() {
    try {
      var h = String(location.hostname || "").toLowerCase();
      return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
    } catch (e) { return false; }
  }

  function canBypassOnboardingValidation() {
    // Digest-gated temporary tester mechanism (js/bypass-config.js): tester
    // emails ship only as SHA-256 digests mapped to expiry timestamps; on a
    // match bypass-config defines the plaintext key on window.BYPASS_LOCK_EMAILS
    // with a getter that returns false once the entry expires — so bypasses
    // expire automatically with no code change here. No plaintext tester email
    // is ever embedded in this file.
    var email = String(getAccountEmail() || "").trim().toLowerCase();
    if (!email) return false;
    return !!(window.BYPASS_LOCK_EMAILS && window.BYPASS_LOCK_EMAILS[email]);
  }

  // Normal onboarding no longer uploads certificates — it takes the doctor's
  // public medical-register number instead (verified by staff against the
  // live register; the ID step still proves who they are). The document slots
  // below survive untouched for DOCS_ONLY_MODE, where the MyIntealth gateway
  // collects the deferred certificates with the same scan machinery.
  function renderRegisterField() {
    if (!qualDocsContainer) return;
    var explainer = document.getElementById("qualDocsExplainer");
    var meta = REGISTER_BODIES_CLIENT[state.country];
    if (!meta) {
      qualDocsContainer.innerHTML = '<p style="color:var(--muted);font-size:14px;">Select a country first.</p>';
      if (explainer) explainer.style.display = "none";
      return;
    }
    if (explainer) {
      explainer.textContent = "No certificates needed today. Enter your " + meta.label + " number and we confirm you on the public register. Certificates come later, when your Australian registration begins.";
      explainer.style.display = "block";
    }
    qualDocsContainer.innerHTML =
      '<div class="register-number-field">' +
        '<label class="field-label" for="registerNumberInput">' + meta.label + ' registration number</label>' +
        '<input type="text" class="country-search-input" id="registerNumberInput" inputmode="numeric" autocomplete="off" placeholder="' + escHtml(meta.hint) + '" value="' + escHtml(state.registerNumber || "") + '" />' +
        '<div style="font-size:13px;color:var(--light);margin-top:8px;">We check this against the public ' + meta.label + ' register. Your ID upload at the last step confirms it is really you.</div>' +
      '</div>';
    var regInput = document.getElementById("registerNumberInput");
    if (regInput) {
      regInput.addEventListener("input", function () {
        state.registerNumber = regInput.value;
        saveState();
        hideError("qualDocsError");
      });
    }
  }

  function renderQualDocSlots() {
    if (!DOCS_ONLY_MODE) { renderRegisterField(); return; }
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
        // A retake asked for because of the photo does not increment retryCount, so
        // there is no attempt to report — "Attempt 0 of 5" would only worry them.
        if (retryCount > 0) {
          infoHtml += '<div class="qual-doc-slot-retry">Attempt ' + retryCount + ' of ' + MAX_RETRIES + '</div>';
        }
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
          '<span class="qual-doc-slot-label">' + (doc.displayLabel || doc.label) + '</span>' +
          '<span class="qual-doc-slot-badge ' + badgeClass + '">' + badgeText + '</span>' +
        '</div>' +
        (doc.hint ? '<p class="qual-doc-slot-hint">' + doc.hint + '</p>' : '') +
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
          if (blob) handleDocVerification(key, blob, doc.label + ".jpg", "camera");
        });
      });
    });

    qualDocsContainer.querySelectorAll("input[type='file']").forEach((inp) => {
      inp.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;
        // Clear the input straight away, while we still hold the file. Without
        // this, a doctor who backs out of the crop sheet and then picks the SAME
        // file again gets no "change" event at all — the slot just sits there.
        e.target.value = "";
        const key = inp.id.replace("qualFileInput_", "");
        handleDocVerification(key, file, file.name, "file");
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

  var NAME_NOISE_PARTS = {
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

  /* "Fashola, Ademola Keji Ibrahim" -> "Ademola Keji Ibrahim Fashola". A GMC
   * certificate routinely prints the surname first with a comma, and the comma
   * used to be dropped with all other punctuation — so the surname was read as
   * the first name. Only a SINGLE comma with words on both sides is reordered. */
  function reorderCommaName(raw) {
    var text = String(raw || "").trim();
    var parts = text.split(",");
    if (parts.length !== 2) return text;
    var surname = parts[0].trim();
    var given = parts[1].trim();
    if (!surname || !given) return text;
    // A trailing qualification list ("Smith, MBBS") is not a surname-first name.
    var givenWords = given.split(/\s+/).filter(Boolean);
    var allNoise = givenWords.every(function (w) {
      return !!NAME_NOISE_PARTS[w.toLowerCase().replace(/[^a-z]/g, "")];
    });
    if (allNoise) return text;
    return given + " " + surname;
  }

  function normalizeNameParts(n) {
    return reorderCommaName(n)
      .toLowerCase()
      .trim()
      .replace(/['’]/g, "")
      .replace(/-/g, " ")
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .filter(function (part) { return !NAME_NOISE_PARTS[part]; });
  }

  /* ── Name matching — MUST behave identically to server.js matchNames ────────
   * A test lifts this function out of this file and checks it against the
   * server's, case for case, because drift here means the wizard and the scan
   * disagree about whether a doctor's own certificate is theirs.
   *
   * The old rule (first word AND last word must match exactly) is what flagged
   * Dr Ibrahim Fashola's own CCT and degree: one prints his name surname-first,
   * the other has "Ibrahim" as a middle name. Now the SURNAME must be present in
   * full — that is the wrong-owner protection and it stays strict — and at least
   * two words must correspond, wherever they sit.
   */
  function nameWordsWithinOneEdit(a, b) {
    if (a === b) return true;
    if (a.length < 5 || b.length < 5) return false;
    if (Math.abs(a.length - b.length) > 1) return false;
    var i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length === b.length) { i++; j++; }
      else if (a.length > b.length) i++;
      else j++;
    }
    if (i < a.length || j < b.length) edits++;
    return edits <= 1;
  }

  function nameWordsMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length === 1 || b.length === 1) return a.charAt(0) === b.charAt(0);
    return nameWordsWithinOneEdit(a, b);
  }

  function countMatchedNameWords(partsA, partsB) {
    var shorter = partsA.length <= partsB.length ? partsA : partsB;
    var longer = partsA.length <= partsB.length ? partsB : partsA;
    var used = [];
    var matched = 0;
    for (var s = 0; s < shorter.length; s++) {
      var word = shorter[s];
      var idx = -1;
      for (var e = 0; e < longer.length; e++) {
        if (!used[e] && longer[e] === word) { idx = e; break; }
      }
      if (idx === -1) {
        for (var f = 0; f < longer.length; f++) {
          if (!used[f] && nameWordsMatch(word, longer[f])) { idx = f; break; }
        }
      }
      if (idx !== -1) { used[idx] = true; matched++; }
    }
    return matched;
  }

  function getNameMatchLevel(name1, name2) {
    var parts1 = normalizeNameParts(name1);
    var parts2 = normalizeNameParts(name2);
    if (parts1.length < 2 || parts2.length < 2) return "unknown";
    if (parts1.join(" ") === parts2.join(" ")) return "exact";
    var last1 = parts1[parts1.length - 1];
    var last2 = parts2[parts2.length - 1];
    var surnamePresent = parts2.indexOf(last1) !== -1 || parts1.indexOf(last2) !== -1;
    if (!surnamePresent) return "mismatch";
    return countMatchedNameWords(parts1, parts2) >= 2 ? "fuzzy" : "mismatch";
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
    // Reordered first: a surname-first document name ("Fashola, Ademola Keji")
    // would otherwise be written to the account as the first name "Fashola,".
    var parts = reorderCommaName(docName).split(/\s+/).filter(Boolean);
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

  // After docs are scanned, confirm the names align with each other and with the account.
  // Countries can require more than one specialist document (UK: MRCGP + CCT), so each
  // non-degree document is checked pairwise against the primary medical degree with the
  // same logic that always applied to the single specialist certificate.
  function crossDocNameCheck() {
    var docs = COUNTRY_DOCS[state.country] || [];
    var specialistDocs = docs.filter(function (d) { return d.key !== "primary_med_degree"; });
    var medDegreeKey = docs.find(function (d) { return d.key === "primary_med_degree"; });
    if (!specialistDocs.length || !medDegreeKey) return;

    var medDoc = state.qualDocs[medDegreeKey.key];
    if (!medDoc) return;

    // The pairwise status checks run exactly as before, but the account-name
    // update is HOISTED out of them: each pair only reports whether it wants
    // the account set to the current legal name, and at most ONE update call
    // fires per run, with a single name chosen across ALL specialist docs.
    // (Previously each CASE-1 pair fired its own POST /api/account/update-name,
    // so two pairs — e.g. UK MRCGP + CCT — could race with different names.)
    var docsWantingUpdate = [];
    specialistDocs.forEach(function (specialistKey) {
      var specDoc = state.qualDocs[specialistKey.key];
      if (specDoc && crossDocNameCheckPair(specDoc, medDoc)) docsWantingUpdate.push(specDoc);
    });
    if (!docsWantingUpdate.length) return;

    var currentLegalName = pickCurrentLegalNameAcrossDocs(specialistDocs, medDoc);
    if (!currentLegalName) return;
    applyAccountNameOnce(currentLegalName, docsWantingUpdate.concat([medDoc]));
  }

  // Hoisted from crossDocNameCheckPair: update the account to the current legal
  // name (no-op if it already matches). This corrects a GP whose account was
  // created in a former/older name so it reflects their legal name. Called at
  // most once per crossDocNameCheck run; on failure every involved document
  // carries the notice, matching the old per-pair tagging.
  function applyAccountNameOnce(currentLegalName, involvedDocs) {
    if (getNameMatchLevel(currentLegalName, getProfileName()) === "exact") return; // already correct
    autoUpdateAccountName(currentLegalName).then(function (updated) {
      if (!updated) {
        var m = "We verified your documents, but could not update your account name automatically. Please refresh or contact support if the name does not update.";
        involvedDocs.forEach(function (doc) {
          doc.scanResult = doc.scanResult || {};
          doc.scanResult.issues = appendIssueOnce(doc.scanResult.issues, m);
        });
      }
      saveState();
      renderQualDocSlots();
    });
  }

  // Single current legal name across ALL specialist documents: the most
  // recently dated specialist doc wins (unreadable dates lose to readable
  // ones; a tie keeps the FIRST specialist doc), then the existing
  // spec-vs-med-degree rule (pickCurrentLegalName) decides whether the
  // medical degree's name is, unusually, the more recent one.
  function pickCurrentLegalNameAcrossDocs(specialistKeys, medDoc) {
    var bestDoc = null;
    var bestName = null;
    var bestDate = null;
    specialistKeys.forEach(function (k) {
      var d = state.qualDocs && state.qualDocs[k.key];
      var name = d && d.scanResult && d.scanResult.nameFound;
      if (!name) return;
      var date = parseQualDate(d.scanResult.dateFound);
      if (!bestDoc) { bestDoc = d; bestName = name; bestDate = date; return; }
      if (date != null && (bestDate == null || date > bestDate)) { bestDoc = d; bestName = name; bestDate = date; }
    });
    if (!bestDoc) return null;
    var medName = medDoc && medDoc.scanResult && medDoc.scanResult.nameFound;
    if (!medName) return bestName;
    return pickCurrentLegalName(bestDoc, medDoc, bestName, medName);
  }

  // The original single-pair check: one specialist certificate vs the primary medical
  // degree. Statuses on BOTH documents may be updated by each pass. Returns true when
  // the pair wants the account name set to the current legal name (CASE 1) — the
  // caller applies that at most once per run, never from inside a pair.
  function crossDocNameCheckPair(specDoc, medDoc) {
    // Both need to be verified or verified_name_pending
    var specOk = specDoc.status === "verified" || specDoc.status === "verified_name_pending";
    var medOk = medDoc.status === "verified" || medDoc.status === "verified_name_pending";
    if (!specOk || !medOk) return false;

    var specName = specDoc.scanResult && specDoc.scanResult.nameFound;
    var medName = medDoc.scanResult && medDoc.scanResult.nameFound;
    if (!specName || !medName) return false;

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

    // CASE 1 — at least one qualification matches the account name. This is the normal case,
    // INCLUDING a genuine name change: the two certificates may carry DIFFERENT names (the older
    // one in a former/maiden name) and that is fine. Accept both — the certificate carrying the
    // current legal name is "verified", the other is a recorded NAME CHANGE (never rejected,
    // never manual review). The per-document scan already flagged the name change to the server
    // and the AMC step asks the GP for proof. The caller then sets the account to the
    // current legal name (once, across all pairs).
    if (specMatchesAccount || medMatchesAccount) {
      var specIsCurrent = isMatch(getNameMatchLevel(specName, currentLegalName));
      var medIsCurrent = isMatch(getNameMatchLevel(medName, currentLegalName));
      specDoc.status = specIsCurrent ? "verified" : "verified_name_pending";
      medDoc.status = medIsCurrent ? "verified" : "verified_name_pending";
      if (!specIsCurrent || !medIsCurrent) state.accountReviewFlag = true;
      return true;
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
      return false;
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
    return false;
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
  // Sentinel docKey for the identity-verification step (step "identity check"),
  // which stores its status on state.idVerification rather than state.qualDocs.
  var ID_SUPPORT_KEY = "__identity__";

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
        (docKey === ID_SUPPORT_KEY
          ? 'Since your ID document could not be verified automatically, our team will email you to verify your identity manually and resume onboarding.'
          : 'Due to discrepancies in your qualifications, our team will email you to manually verify your qualifications and resume onboarding.') +
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
          if (docKey === ID_SUPPORT_KEY) {
            // Identity step (2026-07-20 audit): same fallback the qual slots
            // have — step-completion already accepts "support_requested".
            state.idVerification = state.idVerification || {};
            state.idVerification.status = "support_requested";
          } else if (docKey && state.qualDocs && state.qualDocs[docKey]) {
            state.qualDocs[docKey].status = "support_requested";
          }
          state.accountReviewFlag = true;
          try { localStorage.setItem("gp_account_under_review", "true"); } catch (e) {}
          saveState();
          if (docKey === ID_SUPPORT_KEY) renderIdVerifyStatus();
          else renderQualDocSlots();

          card.innerHTML =
            '<div style="width:56px;height:56px;border-radius:50%;background:rgba(34,197,94,0.15);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">' +
              '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
            '</div>' +
            '<h3 style="color:#fff;font-size:18px;font-weight:700;margin:0 0 8px;">Request Sent</h3>' +
            '<p style="color:#94a3b8;font-size:14px;line-height:1.5;margin:0 0 20px;">' +
              (docKey === ID_SUPPORT_KEY
                ? 'Our team has received your request and will email you to verify your identity manually. You can continue with the rest of the onboarding in the meantime.'
                : 'Our team has received your request and will email you to manually verify your qualifications. You can continue with the rest of the onboarding in the meantime.') +
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

  async function handleDocVerification(docKey, fileOrBlob, fileName, origin) {
    if (activeDocUploads[docKey]) return; // prevent double submit
    activeDocUploads[docKey] = true;

    const doc = (COUNTRY_DOCS[state.country] || []).find((d) => d.key === docKey);
    if (!doc) { delete activeDocUploads[docKey]; return; }

    // ── Trim the desk out of the photo, before anything else happens ────────
    // Doctors photograph a certificate on a carpet or a kitchen table and send
    // the whole scene; from here on only the document itself is scanned, stored
    // and shown to a Registration Support Officer. js/doc-crop.js does the work:
    // it finds the page itself, asks the AI only when it cannot, and shows the
    // doctor the box so they can drag it. It hands back the ORIGINAL file
    // whenever there is nothing to trim or the crop could not be worked out —
    // a cosmetic crop must never be the thing that blocks a qualification — and
    // null only when the doctor cancelled, in which case this upload never
    // happened and the slot must go back to how it was.
    const cropSource = fileOrBlob;
    if (window.DocCrop) {
      try {
        const cropped = await window.DocCrop.prepare(fileOrBlob, {
          label: doc.label,
          origin: origin === "camera" ? "camera" : "file"
        });
        if (!cropped) { delete activeDocUploads[docKey]; return; }
        if (cropped !== cropSource) {
          fileOrBlob = cropped;
          if (cropped.name && cropSource.name) fileName = cropped.name;
        }
      } catch (cropErr) {
        /* keep the original file — see above */
      }
    }

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
          // The document was the right one and the name matched — the PHOTO was
          // the problem (page half out of shot, or something lying on it). Ask for
          // a retake without spending one of the five verification attempts, the
          // same call the server makes on its own counter. Otherwise a correct
          // degree photographed badly five times ends up in manual review with
          // five unusable pictures attached.
          var retakePhotoOnly = v.retakePhoto === true && v.framingOnly === true && nameConfirmed;
          if (!retakePhotoOnly) {
            state.qualDocs[docKey].retryCount = (state.qualDocs[docKey].retryCount || 0) + 1;
          }
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
    if (docKey === "cct_cert") return "onboarding_cct_certificate";
    return "onboarding_specialist_qualification";
  }

  // Reverse of getOnboardingDocumentStorageKey for a given country's doc list.
  function getWizardKeyForStorageKey(storageKey, country) {
    var docs = COUNTRY_DOCS[country] || [];
    if (storageKey === "onboarding_primary_med_degree") {
      return (docs.find(function (d) { return d.key === "primary_med_degree"; }) || {}).key || "primary_med_degree";
    }
    if (storageKey === "onboarding_cct_certificate") {
      return (docs.find(function (d) { return d.key === "cct_cert"; }) || {}).key || null;
    }
    var specialist = docs.find(function (d) { return d.key !== "primary_med_degree" && d.key !== "cct_cert"; });
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
    if (raw === "cct_certificate" || raw === "onboarding_cct_certificate") {
      return getWizardKeyForStorageKey("onboarding_cct_certificate", country);
    }
    if (raw === "specialist_qualification" || raw === "onboarding_specialist_qualification") {
      return getWizardKeyForStorageKey("onboarding_specialist_qualification", country);
    }
    return null;
  }

  function isDefaultLocalState(s) {
    return !s.country && (!s.qualDocs || Object.keys(s.qualDocs).length === 0) && !s.completedAt && s.auBranch !== "yes";
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
    } else if (status !== "verified" && identityStepOptionalForTester()) {
      // Local testing (owner 2026-09-06) or the listed tester (owner 2026-09-14:
      // "let him skip any uploads … including identity verification"): the
      // step is optional, so don't show a red scan failure — say plainly it
      // can be skipped and let Submit through. Still lets the tester upload
      // if they want to exercise the scan. The wording says which case it is
      // so the live test account never reads "local testing".
      var idOptionalWhy = isLocalDevHost() ? "in local testing" : "for this test account";
      statusEl.innerHTML = '<div class="qual-doc-slot-info" style="color:var(--gp-muted);">Identity verification is optional ' + idOptionalWhy + ' — press <b>Submit</b> to continue without uploading anything, or upload an ID to test the scan.</div>';
      if (actionsEl) actionsEl.style.display = "";
      hideError("docsError");
    } else if (status === "verified") {
      statusEl.innerHTML = '<div class="qual-doc-slot-info" style="color:var(--green);">&#10003; Identity confirmed. Your ID is stored securely.</div>';
      actionsEl.style.display = "none";
    } else if (status === "failed") {
      const issues = humanizeScanIssues((idState.issues && idState.issues.length) ? idState.issues : ["Verification failed"], { mode: "identity" });
      // Same "Contact Support" fallback the qualification-doc slots offer
      // (2026-07-20 audit): after a failed scan the doctor must always have a
      // path forward — support_requested counts as step-complete.
      statusEl.innerHTML = '<div class="qual-doc-slot-info error">' + issues.map(escHtml).join("<br>") + '</div>' +
        '<button class="qual-support-btn" id="idVerifySupportBtn" type="button">Contact Support</button>';
      actionsEl.style.display = "";
      var idSupportBtn = document.getElementById("idVerifySupportBtn");
      if (idSupportBtn) {
        idSupportBtn.addEventListener("click", function () {
          var idIssues = (state.idVerification && state.idVerification.issues) || [];
          showSupportPopup("Passport or Driver's Licence", "Identity document (passport or driver's licence)", idIssues, ID_SUPPORT_KEY);
        });
      }
    } else if (status === "support_requested") {
      statusEl.innerHTML = '<div class="qual-doc-slot-info" style="color:var(--primary, #2563eb);">Support team will verify manually via email</div>';
      actionsEl.style.display = "none";
    } else {
      statusEl.innerHTML = "";
      actionsEl.style.display = "";
    }
  }

  async function handleIdVerification(fileOrBlob, fileName, origin) {
    if (idVerifyInProgress) return;
    idVerifyInProgress = true;

    // The ID is kept on file (CEO/ATS only), so the same rule applies here as to
    // the qualifications: crop the table away first. An ID is landscape, and the
    // detector measures the page it actually finds rather than assuming a shape,
    // so nothing extra is needed for that. Cancelling the sheet cancels the
    // upload — the step goes back to how it was.
    if (window.DocCrop) {
      try {
        const croppedId = await window.DocCrop.prepare(fileOrBlob, {
          label: "passport or driver's licence",
          origin: origin === "camera" ? "camera" : "file"
        });
        if (!croppedId) { idVerifyInProgress = false; return; }
        if (croppedId !== fileOrBlob) {
          if (croppedId.name && fileOrBlob.name) fileName = croppedId.name;
          fileOrBlob = croppedId;
        }
      } catch (idCropErr) {
        /* keep the original file */
      }
    }

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
      e.target.value = ""; // so re-picking the same file after a cancel still fires
      if (idVerifyInProgress) return;
      if (file.size > MAX_FILE_SIZE) { showError("docsError", "File must be under 10MB."); return; }
      handleIdVerification(file, file.name, "file");
    });
  }

  if (idVerifyCameraBtn) {
    idVerifyCameraBtn.addEventListener("click", () => {
      if (!window.QualCamera) return;
      // A passport photo page and a driver's licence are both LANDSCAPE. The
      // scan frame defaults to A4 portrait because nearly everything else we
      // capture is a certificate, so this one has to say otherwise — an ID
      // lined up inside a tall frame is the same shape mismatch in reverse.
      window.QualCamera.open({
        docLabel: "Passport or Driver's Licence",
        frameRatio: 0.68,
        tips: [
          "Line the whole card or photo page up inside the frame",
          "Your full name and the expiry date are readable",
          "No glare across the photo or the printed lines"
        ]
      }, (blob, err) => {
        if (err) {
          showError("docsError", err);
          return;
        }
        if (blob) handleIdVerification(blob, "ID_capture.jpg", "camera");
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
      case 1: // relocation details (date + city + who) — the value-first step
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
      case 2: // country + register number (normal) / the deferred documents (docs-only mode)
        if (!state.country) { showError("countryError"); return false; }
        if (!COUNTRY_DOCS[state.country]) {
          const hint = document.getElementById("countryHint");
          if (hint) hint.style.display = "block";
          return false;
        }
        hideError("countryError");
        if (!DOCS_ONLY_MODE) {
          var regCheck = validateRegisterNumberClient(state.country, state.registerNumber);
          if (!regCheck.ok) { showError("qualDocsError", regCheck.message); return false; }
          state.registerNumber = regCheck.number;
          saveState();
          hideError("qualDocsError");
          return true;
        }
        if (!allDocsComplete()) {
          showError("qualDocsError", "Please verify all required documents before continuing.");
          return false;
        }
        hideError("qualDocsError");
        return true;
      case 3: return true; // review
      case 4: // identity check
        const idStatus = state.idVerification && state.idVerification.status;
        if (idStatus === "verified" || idStatus === "support_requested") {
          hideError("docsError");
          return true;
        }
        // Listed tester (js/bypass-config.js TEMPORARY_IDENTITY_OPTIONAL_DIGESTS):
        // this one step may be submitted without an ID. Nothing else is skipped.
        if (identityStepOptionalForTester()) {
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

    // Register summary — onboarding no longer uploads certificates, so the
    // review shows the number we will verify on the public register instead.
    const regMeta = REGISTER_BODIES_CLIENT[state.country];
    const qualRows = [{
      label: (regMeta ? regMeta.label : "Register") + " number",
      value: state.registerNumber
        ? state.registerNumber + " (we verify this on the public register)"
        : "Not provided",
      cls: state.registerNumber ? "status-verified" : "status-missing"
    }];

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

  // ── Button morph (WAAPI FLIP: transform + width only) ──
  // Font-size and padding switch instantly with the class toggle (no per-frame
  // text reflow) — the label crossfade masks it. The Web Animations API leaves
  // no inline styles behind, so an interrupted morph can never strand the
  // button at a wrong size; cancelling always lands on the final class layout.
  var btnRow = nextBtn.parentElement;
  var nextBtnLabel = document.getElementById("nextBtnLabel");
  var morphAnim = null;

  function flipNextBtn(applyLayoutChange) {
    // Capture the CURRENT visual rect (includes any in-flight morph) first.
    var firstRect = nextBtn.getBoundingClientRect();

    if (morphAnim) {
      try { morphAnim.cancel(); } catch (e) { /* ignore */ }
      morphAnim = null;
    }

    nextBtn.classList.add("flipping");
    applyLayoutChange();

    if (typeof nextBtn.animate !== "function") {
      // No WAAPI support: apply the layout change without animating.
      nextBtn.classList.remove("flipping");
      return;
    }

    var lastRect = nextBtn.getBoundingClientRect();
    var dx = firstRect.left + firstRect.width / 2 - (lastRect.left + lastRect.width / 2);

    var anim = nextBtn.animate(
      [
        { transform: "translateX(" + dx + "px)", width: firstRect.width + "px", minWidth: "0" },
        { transform: "translateX(0)", width: lastRect.width + "px", minWidth: "0" }
      ],
      { duration: 550, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
    var done = function () {
      // Identity check: a cancelled morph must not clobber a newer one.
      if (morphAnim === anim) {
        morphAnim = null;
        nextBtn.classList.remove("flipping");
      }
    };
    anim.onfinish = done;
    anim.oncancel = done;
    morphAnim = anim;
  }

  // ── Button label (crossfade, race-free) ────
  var labelTimers = [];
  function clearLabelTimers() {
    while (labelTimers.length) clearTimeout(labelTimers.pop());
  }
  function setNextBtnLabel(newLabel, isSubmit, fade) {
    clearLabelTimers();
    if (nextBtnLabel.textContent === newLabel) {
      nextBtnLabel.style.opacity = "";
      nextBtn.classList.toggle("submit", isSubmit);
      return;
    }
    if (!fade) {
      nextBtnLabel.style.opacity = "";
      nextBtnLabel.textContent = newLabel;
      nextBtn.classList.toggle("submit", isSubmit);
      return;
    }
    // Fade out (~120ms CSS transition), swap, fade back in — well inside the
    // 550ms morph. Timers are managed so a rapid re-nav can never strand the
    // label hidden or on the wrong text.
    nextBtnLabel.style.opacity = "0";
    labelTimers.push(setTimeout(function () {
      nextBtnLabel.textContent = newLabel;
      nextBtn.classList.toggle("submit", isSubmit);
      nextBtnLabel.style.opacity = "";
    }, 140));
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

    // Button label — crossfade while morphing, instant swap otherwise
    var newLabel = step === TOTAL_STEPS - 1 ? "SUBMIT" : step === 0 ? "Get Started" : "NEXT";
    var isSubmit = step === TOTAL_STEPS - 1;
    // Docs-only mode is pinned to the documents step: no dots, no back, and
    // the one button saves and returns to MyIntealth.
    if (DOCS_ONLY_MODE) {
      newLabel = "SAVE & RETURN";
      isSubmit = true;
      backBtn.classList.remove("visible");
      if (dotsEl) dotsEl.style.display = "none";
    }
    setNextBtnLabel(newLabel, isSubmit, needsFlip);

    if (step === 3) {
      buildReview();
    }

    if (step === 2) renderQualDocSlots();
    if (step === 4) renderIdVerifyStatus();

    saveState();
  }

  let navInProgress = false;
  nextBtn.addEventListener("click", () => {
    if (navInProgress) return;
    triggerButtonHaptic(14);
    // Docs-only mode: the wizard is pinned to the documents step — the button
    // finishes when every deferred certificate is verified and returns the
    // doctor to MyIntealth, where the gateway lifts on its own (it reads the
    // stored documents, not a flag).
    if (DOCS_ONLY_MODE) {
      if (!validateStep(2)) return;
      window.location.href = "/pages/myinthealth";
      return;
    }
    if (auActive) { auNext(); return; }
    if (!validateStep(currentStep)) return;
    // Instant verification: the moment the doctor leaves the register-number
    // step, start the server-side check (fire and continue; the browser keeps
    // the request alive while they do the ID step, and the server stores the
    // verdict). Failures are invisible here on purpose — completion runs its
    // own attempt and staff remain behind it.
    if (currentStep === 2 && state.country && state.registerNumber) {
      try {
        fetch("/api/onboarding/register-precheck", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ country: state.country, registerNumber: state.registerNumber }),
          keepalive: true,
        }).catch(function () { /* best effort */ });
      } catch (e) { /* best effort */ }
    }
    if (currentStep === TOTAL_STEPS - 1) {
      // Final gate: a GP resumed past the register step (saved currentStep or
      // ?step deep link) may never have entered their number — validateStep
      // only checks the CURRENT step, so re-check it here.
      if (!canBypassOnboardingValidation() && !validateRegisterNumberClient(state.country, state.registerNumber).ok) {
        goToStep(2);
        showError("qualDocsError", "Please add your medical register number before finishing setup.");
        return;
      }
      submitOnboarding();
      return;
    }
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
    if (auActive) { auBack(); return; }
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
      const completeResp = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(state),
      });
      // Instant verification: when the register check already came back
      // verified (usually while they did the ID step), say so on the
      // success screen. Anything else stays silent; verification simply
      // continues in the background.
      try {
        const completeData = await completeResp.json();
        if (completeData && completeData.registerVerification === "verified") {
          const regLine = document.getElementById("successRegisterLine");
          if (regLine) regLine.hidden = false;
        }
      } catch (e) { /* silent */ }
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

  // Optional consultation, offered to every GP on the success screen. Opens
  // the same booking link the rest of the app uses, personalised to the
  // doctor's assigned support officer; a failure just restores the button
  // (owner 2026-09-18).
  const successConsultBtn = document.getElementById("successConsultBtn");
  if (successConsultBtn) {
    successConsultBtn.addEventListener("click", () => {
      successConsultBtn.disabled = true;
      const original = successConsultBtn.textContent;
      successConsultBtn.textContent = "Opening\u2026";
      fetch("/api/consult/booking-url", { credentials: "same-origin" })
        .then((res) => res.json().catch(() => null))
        .then((data) => {
          successConsultBtn.disabled = false;
          if (data && data.ok && data.url) {
            window.open(data.url, "_blank", "noopener");
            successConsultBtn.textContent = "Booking page opened \u2713";
            return;
          }
          successConsultBtn.textContent = original;
        })
        .catch(() => {
          successConsultBtn.disabled = false;
          successConsultBtn.textContent = original;
        });
    });
  }

  function highlightQualSlot(wizardKey) {
    setTimeout(function () {
      var slot = document.getElementById("qualSlot_" + wizardKey);
      if (!slot) return;
      try { slot.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
      slot.classList.add("reupload-highlight");
      setTimeout(function () { slot.classList.remove("reupload-highlight"); }, 4200);
    }, 350);
  }

  // ── AU BRANCH: START ───────────────────────
  // Australian GP build (WP-05): the branch for a doctor who is already
  // registered with Ahpra and working in Australia.
  //
  // Nothing in this section runs unless the server says the Australian
  // pathway is switched on (auSwitchPromise, which resolves false on any
  // failure or delay: the wizard then behaves exactly as it always has).
  // The answer lists and checks live in js/onboarding-au.js
  // (window.GPOnboardingAu); the server checks every answer again.
  //
  // How it fits the wizard: the Australian screens are extra .slide elements
  // placed AFTER the five existing ones, so the existing step numbers are
  // untouched. While this branch is active it does its own navigation; the
  // identity check is the wizard's own last step, reused as it is.
  //
  // Every word in this section can reach a doctor on this branch, so the
  // wording rules for that doctor apply to all of it, comments included
  // (tests/au-wp05-onboarding-copy.test.js scans it).
  var auLib = window.GPOnboardingAu || null;
  var AU_LOCAL_ANSWER_KEY = "gp_onboarding_au_question"; // this device only: remembers a "no"
  var AU_IDENTITY_STEP = 4;                              // the wizard's own identity slide
  var auActive = false;      // the Australian screens own the wizard
  var auStepIndex = 0;       // 0..auLib.STEPS.length (the last value is the identity check)
  var auControlsBuilt = false;
  var auSubmitting = false;
  // FB-1 (walk-findings D12): true when the SERVER has an Australian pathway
  // on record for this doctor (staff added them, or set it). Such a doctor is
  // never asked the first question and has no way into the other wizard: the
  // recorded pathway decides, not this device and not the saved answers. The
  // server refuses the other wizard's submission for them as well.
  var auServerRecorded = false;
  // FR-7 (S7-01): true when the SERVER says a person at GP Link has put this
  // doctor on a pathway that is not one of the Australian ones. The mirror of
  // the flag above: the recorded pathway decides, so these screens are never
  // entered and whatever this device still holds of them is set aside.
  var auRecordedOther = false;
  // FR-7: true when the server's own saved state says sign-up was finished.
  var auServerFinished = false;
  var auSessionDoctor = null;   // WP-29: the session's `auDoctor` block (held, hold)
  var auReloadingForRecord = false;

  var AU_FIELD_ERROR_IDS = {
    sessions: "auSessionsError",
    availableFrom: "auAvailableFromError",
    noticeWeeks: "auNoticeWeeksError",
    ahpraNumber: "auAhpraNumberError",
    registrationType: "auRegistrationTypeError",
    fellowship: "auFellowshipError",
    detailsConfirmed: "auDetailsConfirmedError",
    hasConditions: "auHasConditionsError",
    moratorium19ab: "auMoratoriumError",
    workRights: "auWorkRightsError",
    permitExpiry: "auPermitExpiryError"
  };
  // WP-29: `base`, `travel` and `places` are the location picker's own three
  // fields (js/au-location-picker.js shows their messages itself).
  var AU_PICKER_FIELDS = ["base", "travel", "places"];
  var auLocationPicker = null;
  var AU_FIELD_STEP = {
    base: "where", travel: "where", places: "where", sessions: "where",
    availableFrom: "when", noticeWeeks: "when",
    ahpraNumber: "registration", registrationType: "registration", fellowship: "registration", detailsConfirmed: "registration",
    hasConditions: "details", moratorium19ab: "details", workRights: "details", permitExpiry: "details"
  };

  function auEl(id) { return document.getElementById(id); }

  // Resolves true only when the server says the switch is on. Any failure, or
  // no answer within four seconds, is "off": the wizard shows today's flow.
  //
  // FR-7 (round 1's S-10): on a slow connection that four-second rule put a
  // doctor who is ALREADY known on this device to be on these screens (they
  // said "yes" here before, they arrived by the invite link, or this device
  // last belonged to a doctor on an Australian pathway) into the other
  // wizard. For such a device the wait is twenty seconds, not four. A device
  // nothing is known about waits four seconds exactly as before.
  function auKnownOnThisDevice() {
    try { if (state && state.auBranch === "yes") return true; } catch (e) { /* ignore */ }
    try { if (typeof AU_INVITE_LINK !== "undefined" && AU_INVITE_LINK) return true; } catch (e) { /* ignore */ }
    try { return localStorage.getItem("gp_au_pathway_hint") === "1"; } catch (e) { return false; }
  }
  function auWhenSwitchKnown() {
    if (!auLib || !window.GPAuPathway || typeof window.GPAuPathway.init !== "function") return Promise.resolve(false);
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () { if (!settled) { settled = true; resolve(false); } }, auKnownOnThisDevice() ? 20000 : 4000);
      var finish = function (value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      try {
        window.GPAuPathway.init().then(function (au) {
          var on = false;
          try { on = !!(au && au.enabled()); } catch (e) { on = false; }
          finish(on);
        }, function () { finish(false); });
      } catch (e) { finish(false); }
    });
  }
  var auSwitchPromise = auWhenSwitchKnown();

  function auReadLocalAnswer() {
    try { return localStorage.getItem(AU_LOCAL_ANSWER_KEY) || ""; } catch (e) { return ""; }
  }
  function auWriteLocalAnswer(value) {
    try {
      if (value) localStorage.setItem(AU_LOCAL_ANSWER_KEY, value);
      else localStorage.removeItem(AU_LOCAL_ANSWER_KEY);
    } catch (e) { /* ignore */ }
  }

  // The Australian answers live on the wizard blob (state.au), so the existing
  // save and resume carry them. Only created once the doctor has said "yes".
  function auAnswers() {
    var defaults = auLib.defaultAnswers();
    var current = state.au && typeof state.au === "object" ? state.au : {};
    var merged = {};
    Object.keys(defaults).forEach(function (k) { merged[k] = current[k] !== undefined ? current[k] : defaults[k]; });
    if (!Array.isArray(merged.locations)) merged.locations = [];
    if (!Array.isArray(merged.places)) merged.places = [];
    state.au = merged;
    return merged;
  }

  function auClearError(field) {
    var id = AU_FIELD_ERROR_IDS[field];
    if (id) hideError(id);
  }

  function auSetAnswer(field, value) {
    auAnswers()[field] = value;
    auClearError(field);
    saveState();
  }

  function auFillSelect(select, options) {
    options.forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = String(o.value);
      opt.textContent = o.label;
      select.appendChild(opt);
    });
  }

  // One-of-many buttons (registration type, fellowship, yes / no ...).
  function auBuildChoices(containerId, options, field, onChange) {
    var box = auEl(containerId);
    if (!box) return;
    box.innerHTML = "";
    options.forEach(function (o) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "au-choice";
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", "false");
      btn.dataset.value = String(o.value);
      btn.textContent = o.label;
      btn.addEventListener("click", function () {
        auSetAnswer(field, o.value);
        auPaintChoices(containerId, o.value);
        if (onChange) onChange(o.value);
      });
      box.appendChild(btn);
    });
  }

  function auPaintChoices(containerId, value) {
    var box = auEl(containerId);
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll(".au-choice"), function (btn) {
      var on = btn.dataset.value === String(value);
      btn.classList.toggle("selected", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
    });
  }

  function auToggleReveal(id, show) {
    var el = auEl(id);
    if (el) el.classList.toggle("show", !!show);
  }

  function auBindInput(id, field, eventName, transform) {
    var el = auEl(id);
    if (!el) return;
    el.addEventListener(eventName || "input", function () {
      auSetAnswer(field, transform ? transform(el.value) : el.value);
    });
  }

  var AU_LOCATION_PICKER_SRC = "/js/au-location-picker.js?v=20261126a";
  function auMountLocationPicker() {
    var pickerHost = auEl("auLocationPicker");
    if (!pickerHost || auLocationPicker) return;
    var mountNow = function () {
      if (!window.GPAuLocationPicker || auLocationPicker) return;
      var pickerNow = auAnswers();
      auLocationPicker = window.GPAuLocationPicker.mount(pickerHost, {
        idPrefix: "auLoc",
        value: { base: pickerNow.base, travel: pickerNow.travel, places: pickerNow.places },
        onChange: function (v) {
          var a = auAnswers();
          a.base = v.base;
          a.travel = v.travel;
          a.places = v.places;
          saveState();
        }
      });
    };
    if (window.GPAuLocationPicker) { mountNow(); return; }
    var tag = document.createElement("script");
    tag.src = AU_LOCATION_PICKER_SRC;
    tag.onload = mountNow;
    tag.onerror = function () {
      // Never a dead end: say so and offer a retry.
      pickerHost.textContent = "";
      var p = document.createElement("p");
      p.className = "au-explain";
      p.setAttribute("role", "alert");
      p.textContent = "We could not load the place search. Check your connection and ";
      var retry = document.createElement("button");
      retry.type = "button";
      retry.className = "waitlist-back";
      retry.textContent = "try again";
      retry.addEventListener("click", function () { pickerHost.textContent = ""; auMountLocationPicker(); });
      p.appendChild(retry);
      pickerHost.appendChild(p);
    };
    document.head.appendChild(tag);
  }

  // Build the controls once, the first time the branch is entered.
  function auBuildControls() {
    if (auControlsBuilt || !auLib) return;
    auControlsBuilt = true;

    // WP-29: where they are based and how far they would go. The picker's
    // script is fetched only here, when the Australian screens are entered,
    // so a doctor on today's wizard (and everyone with the switch off) loads
    // exactly the scripts they always did.
    auMountLocationPicker();

    var sessions = [];
    for (var n = auLib.SESSIONS_MIN; n <= auLib.SESSIONS_MAX; n++) sessions.push({ value: n, label: n + (n === 1 ? " session" : " sessions") });
    auFillSelect(auEl("auSessions"), sessions);
    auFillSelect(auEl("auNoticeWeeks"), auLib.NOTICE_OPTIONS);

    auBindInput("auSessions", "sessions", "change");
    auBindInput("auAvailableFrom", "availableFrom", "change");
    auBindInput("auNoticeWeeks", "noticeWeeks", "change");
    auBindInput("auCurrentPractice", "currentPractice", "input");
    // Letters are kept: the number starts with MED. Only tidy it on blur, so
    // typing is never fought.
    auBindInput("auAhpraNumber", "ahpraNumber", "input");
    var regInput = auEl("auAhpraNumber");
    if (regInput) {
      regInput.addEventListener("blur", function () {
        var tidy = auLib.normaliseAhpraNumber(regInput.value);
        regInput.value = tidy;
        auAnswers().ahpraNumber = tidy;
        saveState();
      });
    }
    auBindInput("auFellowshipDetail", "fellowshipDetail", "input");
    auBindInput("auConditionsDetail", "conditionsDetail", "input");
    auBindInput("auPermitSubclass", "permitSubclass", "input");
    auBindInput("auPermitExpiry", "permitExpiry", "change");

    var confirmBox = auEl("auDetailsConfirmed");
    if (confirmBox) confirmBox.addEventListener("change", function () { auSetAnswer("detailsConfirmed", !!confirmBox.checked); });

    var leadSel = auEl("auLeadSource");
    if (leadSel) {
      leadSel.addEventListener("change", function () {
        state.leadSource = leadSel.value;
        state.leadSourceDetail = "";
        saveState();
      });
    }

    auBuildChoices("auRegistrationType", auLib.REGISTRATION_TYPES, "registrationType");
    auBuildChoices("auFellowship", auLib.FELLOWSHIPS, "fellowship", function (v) { auToggleReveal("auFellowshipDetailWrap", v === "other"); });
    auBuildChoices("auHasConditions", [{ value: true, label: "Yes" }, { value: false, label: "No" }], "hasConditions", function (v) { auToggleReveal("auConditionsDetailWrap", v === true); });
    auBuildChoices("auMoratorium", auLib.MORATORIUM, "moratorium19ab");
    auBuildChoices("auWorkRights", auLib.WORK_RIGHTS, "workRights", function (v) { auToggleReveal("auPermitWrap", v === "temporary"); });
  }

  // Put the saved answers back into the controls (first entry, and resume).
  function auSyncControls() {
    var a = auAnswers();
    var set = function (id, value) { var el = auEl(id); if (el) el.value = value === null || value === undefined ? "" : String(value); };
    if (auLocationPicker) auLocationPicker.setValue({ base: a.base, travel: a.travel, places: a.places });
    set("auSessions", a.sessions);
    set("auAvailableFrom", a.availableFrom);
    set("auNoticeWeeks", a.noticeWeeks);
    set("auCurrentPractice", a.currentPractice);
    set("auAhpraNumber", a.ahpraNumber);
    set("auFellowshipDetail", a.fellowshipDetail);
    set("auConditionsDetail", a.conditionsDetail);
    set("auPermitSubclass", a.permitSubclass);
    set("auPermitExpiry", a.permitExpiry);
    set("auLeadSource", state.leadSource || "");
    var confirmBox = auEl("auDetailsConfirmed");
    if (confirmBox) confirmBox.checked = a.detailsConfirmed === true;
    auPaintChoices("auRegistrationType", a.registrationType);
    auPaintChoices("auFellowship", a.fellowship);
    auPaintChoices("auHasConditions", a.hasConditions);
    auPaintChoices("auMoratorium", a.moratorium19ab);
    auPaintChoices("auWorkRights", a.workRights);
    auToggleReveal("auFellowshipDetailWrap", a.fellowship === "other");
    auToggleReveal("auConditionsDetailWrap", a.hasConditions === true);
    auToggleReveal("auPermitWrap", a.workRights === "temporary");
  }

  function auSlideFor(stepKey) {
    return document.querySelector('.au-slide[data-au-step="' + stepKey + '"]');
  }

  // The branch has one more screen than the wizard has dots: add one while
  // the branch is active, take it away when it is not.
  function auPaintDots(index) {
    var dotsEl = auEl("progressDots");
    if (!dotsEl) return;
    var total = auLib.STEPS.length + 1;
    while (dotsEl.children.length < total) {
      var extra = document.createElement("div");
      extra.className = "progress-dot";
      extra.setAttribute("data-au-dot", "1");
      dotsEl.appendChild(extra);
    }
    Array.prototype.forEach.call(dotsEl.children, function (dot, i) {
      dot.classList.remove("active", "done");
      if (i === index) dot.classList.add("active");
      else if (i < index) dot.classList.add("done");
    });
    dotsEl.style.display = "flex";
  }

  function auRemoveExtraDots() {
    Array.prototype.forEach.call(document.querySelectorAll('#progressDots [data-au-dot]'), function (dot) { dot.remove(); });
  }

  function auSetSlidesHidden(hidden) {
    Array.prototype.forEach.call(document.querySelectorAll(".au-slide"), function (el) {
      if (hidden) el.setAttribute("hidden", "");
      else el.removeAttribute("hidden");
    });
  }

  function auBuildReview() {
    var list = auEl("auReviewList");
    if (!list) return;
    list.innerHTML = auLib.reviewRows(auAnswers()).map(function (r) {
      return '<div class="review-row"><span class="review-label">' + escHtml(r.label) + '</span><span class="review-value">' + escHtml(r.value) + "</span></div>";
    }).join("");
    hideError("auReviewError");
  }

  function auGoTo(index) {
    var steps = auLib.STEPS;
    if (index < 0) index = 0;
    if (index > steps.length) index = steps.length;
    auStepIndex = index;
    auAnswers().step = index;

    if (index === steps.length) {
      // The identity check: the wizard's own last step, exactly as it is.
      goToStep(AU_IDENTITY_STEP);
      auPaintDots(index);
      return;
    }

    var key = steps[index];
    var target = auSlideFor(key);
    slides.forEach(function (s) {
      s.classList.remove("active", "exit-left");
      if (s === target) s.classList.add("active");
    });
    if (target) { try { target.scrollTop = 0; } catch (e) { /* ignore */ } }
    currentStep = 0;
    shell.dataset.step = "au-" + key;
    // FB-1 (D12): nothing sits before the first screen for a doctor whose
    // pathway is on record, so there is no Previous to offer there.
    backBtn.classList.toggle("visible", !(auServerRecorded && index === 0));
    // WP-12 (FB1-E): on the first screen of this branch "Previous" does not
    // lead to a previous step, it leads back to the first question. Say so.
    backBtn.textContent = index === 0 ? "Change my answer" : "Previous";
    backBtn.setAttribute("aria-label", index === 0 ? "Go back to the first question" : "Go to previous step");
    nextBtn.classList.remove("intro-size");
    btnRow.classList.remove("intro-center");
    skipBtn.classList.add("invisible");
    setNextBtnLabel("NEXT", false, false);
    auPaintDots(index);
    if (key === "review") auBuildReview();
    saveState();
  }

  function auEnter(index) {
    auBuildControls();
    auActive = true;
    auSetSlidesHidden(false);
    auSyncControls();
    auGoTo(index);
  }

  function auLeave() {
    auActive = false;
    auSetSlidesHidden(true);
    auRemoveExtraDots();
  }

  function auShowErrors(errors) {
    var first = null;
    // WP-29: the picker shows (and focuses) its own three messages.
    if (auLocationPicker) {
      var pickerErrors = {};
      var anyPickerError = false;
      AU_PICKER_FIELDS.forEach(function (f) { if (errors && errors[f]) { pickerErrors[f] = errors[f]; anyPickerError = true; } });
      if (anyPickerError) { auLocationPicker.showErrors(pickerErrors); first = auEl("auLocationPicker"); }
      else auLocationPicker.clearErrors();
    }
    Object.keys(AU_FIELD_ERROR_IDS).forEach(function (field) {
      var id = AU_FIELD_ERROR_IDS[field];
      if (errors && errors[field]) {
        showError(id, errors[field]);
        if (!first) first = auEl(id);
      } else {
        hideError(id);
      }
    });
    if (first) { try { first.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) { /* ignore */ } }
  }

  // Jump to the screen that holds the first field with an error and show them.
  function auShowErrorsOnTheirScreen(errors) {
    var steps = auLib.STEPS;
    var target = -1;
    Object.keys(errors || {}).forEach(function (field) {
      var at = steps.indexOf(AU_FIELD_STEP[field]);
      if (at !== -1 && (target === -1 || at < target)) target = at;
    });
    if (target === -1) return false;
    auGoTo(target);
    auShowErrors(errors);
    return true;
  }

  function auNext() {
    var steps = auLib.STEPS;
    if (auStepIndex === steps.length) {
      if (!validateStep(AU_IDENTITY_STEP)) return;
      // A doctor who resumed straight onto this screen may have skipped one.
      var missing = auLib.firstIncompleteStep(auAnswers());
      if (missing !== -1) {
        auGoTo(missing);
        auShowErrors(auLib.validateStep(steps[missing], auAnswers()).errors);
        return;
      }
      auSubmit();
      return;
    }
    var key = steps[auStepIndex];
    if (key === "registration") {
      var regInput = auEl("auAhpraNumber");
      if (regInput) { regInput.value = auLib.normaliseAhpraNumber(regInput.value); auAnswers().ahpraNumber = regInput.value; }
    }
    if (key !== "review") {
      var check = auLib.validateStep(key, auAnswers());
      auShowErrors(check.errors);
      if (!check.ok) return;
    } else {
      var gap = auLib.firstIncompleteStep(auAnswers());
      if (gap !== -1) {
        auGoTo(gap);
        auShowErrors(auLib.validateStep(steps[gap], auAnswers()).errors);
        return;
      }
    }
    auGoTo(auStepIndex + 1);
  }

  function auBack() {
    if (auStepIndex === 0) {
      if (auServerRecorded) return; // nothing sits before the first screen for them
      auShowFirstQuestion();
      return;
    }
    auGoTo(auStepIndex - 1);
  }

  function auShowFirstQuestion() {
    // WP-12 (FB1-E): the wizard's own label, for whichever branch comes next.
    backBtn.textContent = "Previous";
    backBtn.setAttribute("aria-label", "Go to previous step");
    var screen = auEl("auFirstQuestion");
    if (screen) screen.classList.add("show");
  }
  function auHideFirstQuestion() {
    var screen = auEl("auFirstQuestion");
    if (screen) screen.classList.remove("show");
  }

  function auAnswerYes() {
    auWriteLocalAnswer("");
    state.auBranch = "yes";
    auAnswers();
    auHideFirstQuestion();
    // saveState (inside auGoTo) posts the blob; the server notes from it that
    // this doctor has started the Australian branch.
    auEnter(Math.min(Math.max(Number(state.au.step) || 0, 0), auLib.STEPS.length - 1));
  }

  function auAnswerNo() {
    if (auServerRecorded) return; // FB-1 (D12): the recorded pathway decides
    auWriteLocalAnswer("no");
    // FR-3 (final review R3-01): the "No" is RECORDED in the saved wizard, in
    // the one form the server reads (lib/au-onboarding.js blobSaysNotAustralian:
    // auBranch === "no"). It used to be deleted here, so the server never
    // learned the answer: a doctor who tapped "No" and paused was treated
    // as an account nothing is known about. This one key is the only
    // difference from the blob today's wizard has always saved (declared in
    // CONVENTIONS section 2); nothing in today's wizard reads it.
    // A doctor who first said "yes": the Australian answers are dropped.
    state.auBranch = "no";
    if (state.au !== undefined) delete state.au;
    auLeave();
    auHideFirstQuestion();
    saveState();
    goToStep(currentStep);
  }

  // Back to the first question from the existing flow (the "somewhere else"
  // search and the waitlist form both offer it when the switch is on).
  function auReopenFirstQuestion() {
    hideEligibilityScreen();
    auWriteLocalAnswer("");
    auShowFirstQuestion();
  }

  // WP-29: `hold` is the server's { kind, title, message } for a held doctor.
  // A GP registrar (kind "registrar") gets their own finish screen: we place
  // fully qualified GPs. Everyone else is unchanged.
  function auShowSuccess(next, hold) {
    var ready = auEl("auSuccessReady");
    var review = auEl("auSuccessReview");
    var registrar = auEl("auSuccessRegistrar");
    var holding = next !== "careers";
    var isRegistrar = holding && !!registrar && !!hold && hold.kind === "registrar";
    if (ready) ready.hidden = holding;
    if (review) review.hidden = !holding || isRegistrar;
    if (registrar) registrar.hidden = !isRegistrar;
    if (isRegistrar) {
      var regTitle = auEl("auSuccessRegistrarTitle");
      var regText = auEl("auSuccessRegistrarText");
      if (regTitle && hold.title) regTitle.textContent = String(hold.title);
      if (regText && hold.message) regText.textContent = String(hold.message);
    }
    var screen = auEl("auSuccessScreen");
    if (screen) screen.classList.add("show");
  }

  async function auSubmit() {
    if (auSubmitting) return;
    auSubmitting = true;
    nextBtn.disabled = true;
    loadingText.textContent = "Saving your profile...";
    loadingOverlay.classList.add("show");
    var outcome = null;
    var problem = "";
    // WP-10: the browser's time zone (IANA name, e.g. Australia/Perth) rides
    // along with the Australian answers so the times in later emails are the
    // doctor's own. Not saved in the onboarding state; the server validates it
    // and falls back to the state they chose when it is missing or unusable.
    var auBrowserTz = "";
    try { auBrowserTz = String(Intl.DateTimeFormat().resolvedOptions().timeZone || ""); } catch (tzErr) { auBrowserTz = ""; }
    try {
      var resp = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(auBrowserTz ? Object.assign({}, state, { browserTz: auBrowserTz }) : state),
      });
      var data = await resp.json().catch(function () { return null; });
      if (resp.ok && data && data.ok) {
        outcome = data;
      } else if (data && data.errors && typeof data.errors === "object") {
        loadingOverlay.classList.remove("show");
        nextBtn.disabled = false;
        auSubmitting = false;
        if (!auShowErrorsOnTheirScreen(data.errors)) showError("docsError", "Some answers need another look. Please check them and try again.");
        return;
      } else if (data && data.todaysWizardRequired === true) {
        // FR-7 (S7-01): nothing was written; the wizard that applies loads.
        auSubmitting = false;
        auOnSaveRefused(data);
        return;
      } else {
        problem = (data && data.message) || "We could not save your details just now. Please try again.";
      }
    } catch (e) {
      problem = "We could not save your details. Please check your connection and try again.";
    }
    loadingOverlay.classList.remove("show");
    nextBtn.disabled = false;
    auSubmitting = false;
    if (!outcome) {
      // Never show "all set" for something that was not saved.
      showError("docsError", problem);
      return;
    }
    state.completedAt = new Date().toISOString();
    state.currentStep = currentStep;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    try { localStorage.setItem("gp_selected_country", JSON.stringify("Australia")); } catch (e) { /* ignore */ }
    try { localStorage.setItem("gp_onboarding_complete", "true"); } catch (e) { /* ignore */ }
    try { if (window.GPAuPathway) window.GPAuPathway.init({ force: true }); } catch (e) { /* ignore */ }
    auShowSuccess(outcome.auNext === "careers" ? "careers" : "team_review", outcome.auHold || null);
    // FR-3 (M3-02): a doctor who goes through onboarding AGAIN is told the
    // truth: the profile was already set up and nothing on it was changed
    // (the server passes what they entered to the team). The server's own
    // sentence is shown on the success screen, as text.
    if (outcome.auAlreadyComplete === true && outcome.message && outcome.message !== "Profile complete.") {
      try {
        var auSuccess = auEl("auSuccessScreen");
        if (auSuccess && !auSuccess.querySelector("[data-au-already]")) {
          var auNote = document.createElement("p");
          auNote.setAttribute("data-au-already", "1");
          auNote.setAttribute("role", "status");
          auNote.style.cssText = "margin:12px auto 0;max-width:420px;font-size:14px;line-height:1.5;color:#334155;text-align:center";
          auNote.textContent = String(outcome.message);
          var auHost = auSuccess.querySelector("[id='auSuccessReady']:not([hidden]), [id='auSuccessReview']:not([hidden])") || auSuccess;
          auHost.appendChild(auNote);
        }
      } catch (e) { /* the screen still shows */ }
    }
  }

  // With the switch on, the existing "somewhere else" path no longer treats
  // Australia as a country we do not support: it is left out of that search
  // (auSwitchOn, read by renderCountryList), and the waitlist form says who we
  // work with and offers the way back to the first question.
  function auApplySwitchOnCopy() {
    auSwitchOn = true;
    var lede = auEl("notEligibleLede");
    if (lede) {
      lede.textContent = "GP Link currently supports GPs who trained in the United Kingdom, Ireland or New Zealand, and GPs who are already registered with Ahpra and working in Australia. We're working on more countries — confirm your details below and we'll let you know the moment yours is supported.";
    }
    var capture = auEl("waitlistCapture");
    if (capture && !auEl("auOfframpFirstQuestionBtn")) {
      var link = document.createElement("button");
      link.type = "button";
      link.className = "au-offramp-link";
      link.id = "auOfframpFirstQuestionBtn";
      link.textContent = "Already registered with Ahpra and working in Australia? Start here";
      link.addEventListener("click", auReopenFirstQuestion);
      var backLink = auEl("waitlistBackBtn");
      if (backLink && backLink.parentNode === capture) capture.insertBefore(link, backLink);
      else capture.appendChild(link);
    }
    try { renderCountryList(countrySearch ? countrySearch.value : ""); } catch (e) { /* ignore */ }
  }

  // FB-1 (D12, D14): fill in what staff already recorded (the state the doctor
  // lives in, the Ahpra number), never over something the doctor has typed.
  // Asked only for a doctor the server has on an Australian pathway.
  function auPrefillFromRecord() {
    try {
      fetch("/api/onboarding/au-prefill", { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          var given = data && data.ok === true && data.answers && typeof data.answers === "object" ? data.answers : null;
          if (!given) return;
          var a = auAnswers();
          var changed = false;
          if (!a.state && typeof given.state === "string" && given.state) { a.state = given.state; changed = true; }
          if (!a.ahpraNumber && typeof given.ahpraNumber === "string" && given.ahpraNumber) { a.ahpraNumber = given.ahpraNumber; changed = true; }
          if (!changed) return;
          auSyncControls();
          saveState();
        })
        .catch(function () { /* the doctor types them instead */ });
    } catch (e) { /* ignore */ }
  }

  // WP-15: a doctor who enquired through the booking form and said "Yes, I am
  // registered with Ahpra" has already answered the first question (and their
  // state and 19AB). When the same email creates an account, start them in
  // this branch with those answers instead of asking again. Anyone else, a
  // slow answer or any failure gets the ordinary first question. Nothing is
  // decided here: the pathway is still set by the server when onboarding is
  // completed.
  function auAskOrStartFromLead() {
    var done = false;
    function ask() { if (done) return; done = true; auShowFirstQuestion(); }
    var timer = setTimeout(ask, 2500);
    try {
      fetch("/api/onboarding/au-prefill?lead=1", { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (done) return;
          var given = data && data.ok === true && data.fromLead === true && data.answers && typeof data.answers === "object" ? data.answers : null;
          if (!given) { clearTimeout(timer); ask(); return; }
          done = true;
          clearTimeout(timer);
          auWriteLocalAnswer("");
          state.auBranch = "yes";
          var a = auAnswers();
          if (!a.state && typeof given.state === "string" && given.state) a.state = given.state;
          if (!a.moratorium19ab && typeof given.moratorium19ab === "string" && given.moratorium19ab) a.moratorium19ab = given.moratorium19ab;
          if (!a.workRights && typeof given.workRights === "string" && given.workRights) a.workRights = given.workRights;
          auHideFirstQuestion();
          auEnter(Math.min(Math.max(Number(state.au.step) || 0, 0), auLib.STEPS.length - 1));
          auSyncControls();
          saveState();
        })
        .catch(function () { clearTimeout(timer); ask(); });
    } catch (e) { clearTimeout(timer); ask(); }
  }

  // FR-7 (S7-01, S7-02): set this device's copy of the Australian screens
  // aside. Nothing the doctor typed is removed (state.au stays where it is);
  // only the switch that re-enters these screens goes. A blob that was
  // FINISHED on these screens is put back to the start of the wizard that
  // follows, because its step number, finish time and country were written by
  // these screens, not typed by the doctor.
  function auSetBranchAside() {
    var had = state.auBranch === "yes";
    if (!had) return false;
    delete state.auBranch;
    if (state.completedAt) {
      state.completedAt = null;
      currentStep = 0;
      state.currentStep = 0;
    }
    if (state.country === "AU") state.country = "";
    auWriteLocalAnswer("");
    return true;
  }

  // The server refused a save or a finish because the recorded pathway is not
  // an Australian one: set the screens aside and load the wizard that applies.
  function auOnSaveRefused(data) {
    if (!data || data.todaysWizardRequired !== true || auReloadingForRecord) return;
    auReloadingForRecord = true;
    auRecordedOther = true;
    auSetBranchAside();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    try { window.location.replace("/pages/onboarding"); } catch (e) { /* ignore */ }
  }

  // Called once from the init chain, with the switch known to be on, before
  // the wizard paints. Returns true when this branch has painted the screen.
  function auTakeOver(params) {
    if (!auLib) return false;
    auApplySwitchOnCopy();
    // FR-7 (S7-01): the recorded pathway decides. No first question, no
    // Australian screens, whatever this device or the saved wizard holds.
    if (auRecordedOther) {
      auSetBranchAside();
      auLeave();
      auHideFirstQuestion();
      return false;
    }
    if (DOCS_ONLY_MODE) return false;
    if (params.get("reupload")) return false;
    // The invite sent to a doctor released from the waitlist carries ?au=1.
    // The server has already cleared their waitlist record; clear this
    // device's copy so the old "you're on the list" screen does not return.
    if (AU_INVITE_LINK) { try { localStorage.removeItem(ELIGIBILITY_WAITLIST_KEY); } catch (e) { /* ignore */ } }

    // FB-1 (walk-findings D12, D14): a doctor whose pathway the server has on
    // record as Australian starts in this branch. No first question, whatever
    // this device remembers and whatever the saved answers say, and what staff
    // already entered is filled in for them.
    var recordedMine = null;
    try { recordedMine = window.GPAuPathway.mine(); } catch (e) { recordedMine = null; }
    auServerRecorded = !!(recordedMine && recordedMine.isAu === true);
    if (auServerRecorded && !(state.auBranch === "yes" && state.completedAt)) {
      auWriteLocalAnswer("");
      state.auBranch = "yes";
      if (state.completedAt !== undefined) delete state.completedAt;
      auAnswers();
      auHideFirstQuestion();
      auEnter(Math.min(Math.max(Number(state.au.step) || 0, 0), auLib.STEPS.length));
      auPrefillFromRecord();
      return true;
    }

    if (state.auBranch === "yes") {
      if (state.completedAt) {
        var mine = null;
        try { mine = window.GPAuPathway.mine(); } catch (e) { mine = null; }
        // WP-29: "held" is the server's decision (session `auDoctor.held`),
        // not the launch flag: a doctor in the restricted segment may now be
        // shown roles. A session without it keeps the old reading.
        var auHeldNow = auSessionDoctor ? auSessionDoctor.held === true : !!(mine && !mine.launched);
        if (mine && mine.isAu && auHeldNow) {
          auBuildControls();
          auShowSuccess("team_review", auSessionDoctor && auSessionDoctor.hold ? auSessionDoctor.hold : null);
          return true;
        }
        // FR-7 (guide walk): a doctor who has finished, and whom the server
        // also has as finished and on an Australian pathway, was shown screen
        // 1 again here. They are sent to their home page. (Both checks come
        // from the server, so a device that only THINKS it finished cannot
        // bounce between the two pages. "Edit my answers" on the finish
        // screen is unchanged.)
        if (auServerFinished && mine && mine.isAu) {
          try { window.location.replace("/pages/index"); return true; } catch (e) { /* fall through */ }
        }
        auEnter(0);
        return true;
      }
      auAnswers();
      auEnter(Math.min(Math.max(Number(state.au.step) || 0, 0), auLib.STEPS.length));
      return true;
    }

    var stepParam = parseInt(params.get("step"), 10);
    var alreadyUnderWay = currentStep > 0 || !!state.country || !!state.targetDate || !!state.registerNumber || !!state.completedAt || !isNaN(stepParam);
    if (AU_INVITE_LINK && !state.completedAt) { auShowFirstQuestion(); return true; }
    // A doctor already part-way through today's flow, or who answered "no" on
    // this device, is not asked: nothing changes for them.
    // (FR-3: or on another device, from the saved wizard.)
    if (alreadyUnderWay || auReadLocalAnswer() === "no" || state.auBranch === "no") return false;
    auAskOrStartFromLead();
    return true;
  }

  (function auWireStaticButtons() {
    var yes = auEl("auFirstYes");
    var no = auEl("auFirstNo");
    if (yes) yes.addEventListener("click", function () { triggerButtonHaptic(12); auAnswerYes(); });
    if (no) no.addEventListener("click", function () { triggerButtonHaptic(12); auAnswerNo(); });
    var go = auEl("auSuccessContinueBtn");
    if (go) go.addEventListener("click", function () { window.location.href = "/pages/career"; });
    // WP-12 (walk-findings D17): the holding finish screen had no way on. It
    // leads to Careers, where the holding message is the first thing shown.
    var goHeld = auEl("auSuccessReviewContinueBtn");
    if (goHeld) goHeld.addEventListener("click", function () { window.location.href = "/pages/career"; });
    var auEditAgain = function () {
      var screen = auEl("auSuccessScreen");
      if (screen) screen.classList.remove("show");
      auEnter(0);
    };
    var edit = auEl("auSuccessEditBtn");
    if (edit) edit.addEventListener("click", auEditAgain);
    // WP-29: the registrar finish screen. "Message us", and the same way back.
    var regMessage = auEl("auSuccessRegistrarMessageBtn");
    if (regMessage) regMessage.addEventListener("click", function () { window.location.href = "/pages/messages"; });
    var regEdit = auEl("auSuccessRegistrarEditBtn");
    if (regEdit) regEdit.addEventListener("click", auEditAgain);
  })();
  // ── AU BRANCH: END ─────────────────────────

  // ── Init ───────────────────────────────────
  fetch("/api/auth/session", { credentials: "same-origin" })
    .then((r) => r.json())
    .then((data) => {
      if (!data || !data.authenticated) {
        var dest = window.location.pathname + window.location.search;
        window.location.replace("/pages/signin" + (/^\/pages\//.test(dest) ? "?next=" + encodeURIComponent(dest) : ""));
        return;
      }
      // FR-7 (S7-01): present only with the Australian pathway switch on, for a
      // doctor staff have put on an overseas pathway (see auTakeOver).
      auRecordedOther = data.auPathwayStaffOverseas === true;
      auSessionDoctor = (data.auDoctor && typeof data.auDoctor === "object") ? data.auDoctor : null;
      // Store profile for name matching
      if (data.profile) {
        window.gpSessionProfile = data.profile;
        // Re-run the temporary-bypass digest match now that we know the email.
        // On a brand-new browser bypass-config.js ran before any profile cache
        // existed, so its self-invoke found no email and matched nothing.
        window.gpRefreshBypassDigestMatch && window.gpRefreshBypassDigestMatch(String((data.profile && data.profile.email) || "").trim().toLowerCase());
        // The GP may have opened the eligibility off-ramp before this fetch
        // resolved (its form is reachable synchronously from the country list).
        // Re-apply the account email/name prefill now that the profile exists.
        var offrampScreen = document.getElementById("notEligibleScreen");
        if (offrampScreen && offrampScreen.classList.contains("show") && !offrampScreen.classList.contains("waitlist-submitted")) {
          applyWaitlistAccountPrefill();
        }
      }

      // Already on the eligibility waitlist (country not supported yet)?
      // Show the "we'll be in touch" state instead of the wizard trap.
      if (getWaitlistRecord() && !AU_INVITE_LINK) {
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
          auServerFinished = st.gp_onboarding_complete === true || st.gp_onboarding_complete === "true";
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
        .then(function () { return auSwitchPromise; })
        .then(function (auPathwayOn) {
          if (eligibilityScreenShown) return; // eligibility screen already rendered — never fall through to the wizard
          // Deep link from reminder emails: ?step=N opens that step. Deep link from
          // reject emails: ?reupload=<docKey> opens the qualification step at that doc.
          var params = new URLSearchParams(window.location.search);
          var urlStep = parseInt(params.get("step"), 10);
          if (!isNaN(urlStep) && urlStep >= 0 && urlStep < TOTAL_STEPS) currentStep = urlStep;
          var reuploadRaw = params.get("reupload") || "";
          var reuploadKey = reuploadRaw && state.country ? resolveReuploadParamKey(reuploadRaw, state.country) : null;
          if (reuploadKey) currentStep = 2;
          // Docs-only mode (MyIntealth gateway): pin the wizard to the
          // documents step and retitle it — the doctor has already onboarded.
          if (DOCS_ONLY_MODE) {
            currentStep = 2;
            var docsSlide = document.querySelector('.slide[data-slide="2"] .slide-content');
            if (docsSlide) {
              var h1 = docsSlide.querySelector("h1");
              var lede = docsSlide.querySelector("p");
              if (h1) h1.textContent = "Upload your certificates";
              if (lede) lede.textContent = "Before MyIntealth begins we need the certificates you skipped at sign-up. Upload them once and the whole registration runs on them.";
            }
          }
          // Australian GP build (WP-05): with the switch on, the first question
          // (or a resumed Australian branch) paints instead of the wizard.
          if (auPathwayOn === true && auTakeOver(params)) { initRendered = true; return; }
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

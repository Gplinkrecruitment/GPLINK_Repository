(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  var EMBED_PARAM = "gp_shell";
  var EMBED_VALUE = "embedded";
  var DEFAULT_ROUTE = "/pages/index.html";
  var REGISTRATION_ENTRY_ROUTE = "/pages/myinthealth.html";
  var REGISTRATION_INTRO_ROUTE = "/pages/registration-intro.html";
  var REGISTRATION_INTRO_SEEN_KEY = "gp_registration_intro_seen";
  var REGISTRATION_INTRO_BYPASS_KEY = "gp_registration_intro_bypass_once";
  var REGISTRATION_CONTINUE_PARAM = "gp_registration_continue";
  var EPIC_PROGRESS_KEY = "gp_epic_progress";
  var AMC_PROGRESS_KEY = "gp_amc_progress";
  var AHPRA_PROGRESS_KEY = "gp_ahpra_progress";
  var CAREER_STATE_KEY = "gp_career_state";
  var REGISTRATION_RETURN_KEY = "gp_registration_return_overrides";
  var SESSION_PROFILE_CACHE_KEY = "gp_session_profile_cache";
  var SESSION_OWNER_KEY = "gp_state_owner";
  var REGISTRATION_INTRO_ALWAYS_EMAILS = {
    "hello@mygplink.com.au": true
  };
  var BYPASS_LOCK_EMAILS = {
    "hello@mygplink.com.au": true
  };
  var PAGE_PATHS = {
    "/pages/index.html": true,
    "/pages/myinthealth.html": true,
    "/pages/amc.html": true,
    "/pages/ahpra.html": true,
    "/pages/my-documents.html": true,
    "/pages/career.html": true,
    "/pages/visa.html": true,
    "/pages/pbs.html": true,
    "/pages/commencement.html": true,
    "/pages/messages.html": true,
    "/pages/account.html": true,
    "/pages/registration-intro.html": true,
    "/pages/application-detail.html": true,
    "/pages/job.html": true
  };
  var NAV_GROUPS = {
    "/pages/index.html": { desktop: "home", mobile: "/pages/index.html" },
    "/pages/registration-intro.html": { desktop: "home", mobile: "/pages/index.html" },
    "/pages/myinthealth.html": { desktop: "home", mobile: "/pages/index.html" },
    "/pages/amc.html": { desktop: "home", mobile: "/pages/index.html" },
    "/pages/ahpra.html": { desktop: "home", mobile: "/pages/index.html" },
    "/pages/visa.html": { desktop: "home", mobile: "/pages/index.html" },
    "/pages/pbs.html": { desktop: "home", mobile: "/pages/index.html" },
    "/pages/commencement.html": { desktop: "home", mobile: "/pages/index.html" },
    "/pages/my-documents.html": { desktop: "documents", mobile: "/pages/index.html" },
    "/pages/career.html": { desktop: "career", mobile: "/pages/career.html" },
    "/pages/application-detail.html": { desktop: "career", mobile: "/pages/career.html" },
    "/pages/job.html": { desktop: "career", mobile: "/pages/career.html" },
    "/pages/messages.html": { desktop: "support", mobile: "/pages/messages.html" },
    "/pages/account.html": { desktop: "account", mobile: "/pages/account.html" }
  };

  var frameEls = Array.prototype.slice.call(document.querySelectorAll(".app-shell-frame"));
  var loaderEl = document.getElementById("appShellLoader");
  var desktopNavEl = document.querySelector(".nav-menu");
  var mobileNavEl = document.querySelector(".mobile-nav");
  var navGlassEl = document.getElementById("navGlass");
  var mobileNavGlassEl = document.getElementById("mobileNavGlass");
  var desktopHostEl = document.getElementById("appShellDesktop");
  var desktopRegistrationDropdownEl = document.querySelector('[data-dropdown="registration"]');
  var desktopRegistrationTriggerEl = desktopRegistrationDropdownEl ? desktopRegistrationDropdownEl.querySelector('[data-nav="registration"]') : null;
  var registrationRowsEl = document.getElementById("regTable");
  var mobileRegistrationToggleEl = document.querySelector("[data-mobile-registration-toggle]");
  var mobileRegBackdropEl = document.getElementById("mobileRegBackdrop");
  var mobileRegSheetEl = document.getElementById("mobileRegSheet");
  var mobileRegTableEl = document.getElementById("mobileRegTable");
  var mobileRegCloseBtnEl = document.getElementById("mobileRegCloseBtn");
  var EMBED_STYLE_ID = "gp-shell-parent-embed-style";
  var WARM_ROUTE_ORDER = [
    "/pages/index.html",
    "/pages/myinthealth.html",
    "/pages/my-documents.html",
    "/pages/career.html",
    "/pages/messages.html",
    "/pages/account.html"
  ];
  var currentRoute = "";
  var activeFrameEl = document.querySelector(".app-shell-frame.is-active") || frameEls[0] || null;
  var activeDesktopItem = null;
  var activeMobileTab = null;
  var hoveredDesktopItem = null;
  var navGlassInitialized = false;
  var mobileGlassInitialized = false;
  var pendingNavigation = null;
  var warmRouteTimer = 0;
  var desktopRegistrationCloseTimer = 0;
  var mobileRegistrationSheetOpen = false;
  var mobileSheetStartY = 0;
  var mobileSheetDeltaY = 0;
  var mobileSheetDragging = false;
  var EPIC_STAGE_LABELS = {
    create_account: "Create your MyIntealth account",
    upload_qualifications: "Upload your specialist qualifications",
    waiting_verification: "EPIC is verifying your documents",
    account_establishment: "Account Establishment",
    verification_issued: "Verification issued"
  };
  var AMC_STAGE_LABELS = {
    create_portfolio: "Create an AMC account",
    upload_credentials: "Upload credentials",
    qualifications_pending: "Qualifications pending ECFMG verification",
    qualifications_verified: "Qualifications verified"
  };

  function normalizePath(pathname) {
    if (typeof pathname !== "string" || !pathname) return "";
    try {
      return new URL(pathname, window.location.origin).pathname;
    } catch (err) {
      return pathname;
    }
  }

  function getEventElement(target) {
    if (target instanceof Element) return target;
    if (target && target.nodeType === 3 && target.parentElement) return target.parentElement;
    return null;
  }

  function resolveSupportedPath(pathname) {
    var normalized = normalizePath(pathname);
    if (Object.prototype.hasOwnProperty.call(PAGE_PATHS, normalized)) return normalized;

    var parts = normalized.split("/").filter(Boolean);
    if (parts.length < 2 || parts[0] !== "registration") return "";

    var step = String(parts[1] || "").toLowerCase();
    if (step === "myintealth" || step === "myinthealth") return "/pages/myinthealth.html";
    if (step === "amc") return "/pages/amc.html";
    if (step === "ahpra" || step === "specialist-registration") return "/pages/ahpra.html";
    return "";
  }

  function isSupportedPath(pathname) {
    return !!resolveSupportedPath(pathname);
  }

  function routeFromUrl(input) {
    var url = input instanceof URL ? new URL(input.toString()) : new URL(String(input || DEFAULT_ROUTE), window.location.href);
    url.searchParams.delete(EMBED_PARAM);
    return url.pathname + url.search + url.hash;
  }

  function getResolvedRoutePath(input) {
    var routeUrl = toRouteUrl(input);
    return routeUrl ? (resolveSupportedPath(routeUrl.pathname) || "") : "";
  }

  function routesShareSupportedPage(first, second) {
    var firstUrl = toRouteUrl(first);
    var secondUrl = toRouteUrl(second);
    if (!firstUrl || !secondUrl) return false;
    return resolveSupportedPath(firstUrl.pathname) === resolveSupportedPath(secondUrl.pathname);
  }

  function toRouteUrl(input) {
    try {
      var url = input instanceof URL ? new URL(input.toString()) : new URL(String(input || DEFAULT_ROUTE), window.location.href);
      if (url.origin !== window.location.origin) return null;
      if (!isSupportedPath(url.pathname)) return null;
      url.searchParams.delete(EMBED_PARAM);
      return url;
    } catch (err) {
      return null;
    }
  }

  function toEmbeddedRoute(input) {
    var routeUrl = toRouteUrl(input);
    if (!routeUrl) return "";
    routeUrl.searchParams.set(EMBED_PARAM, EMBED_VALUE);
    return routeUrl.pathname + routeUrl.search + routeUrl.hash;
  }

  function getFrameState(frame) {
    if (!frame) return null;
    if (!frame.__gpShellState) {
      frame.__gpShellState = {
        loadedRoute: "",
        pendingRoute: "",
        title: ""
      };
    }
    return frame.__gpShellState;
  }

  function getInactiveFrame() {
    for (var i = 0; i < frameEls.length; i += 1) {
      if (frameEls[i] !== activeFrameEl) return frameEls[i];
    }
    return null;
  }

  function findLoadedFrameForRoute(route) {
    for (var i = 0; i < frameEls.length; i += 1) {
      var frame = frameEls[i];
      var state = getFrameState(frame);
      if (state && state.loadedRoute === route && !state.pendingRoute) return frame;
    }
    return null;
  }

  function isFrameShowingRoute(frame, route) {
    var state = getFrameState(frame);
    return !!state && state.loadedRoute === route && !state.pendingRoute;
  }

  function activateFrame(frame) {
    if (!frame) return;
    frameEls.forEach(function (candidate) {
      var isActive = candidate === frame;
      candidate.classList.toggle("is-active", isActive);
      if (isActive) {
        candidate.removeAttribute("aria-hidden");
        candidate.removeAttribute("tabindex");
      } else {
        candidate.setAttribute("aria-hidden", "true");
        candidate.setAttribute("tabindex", "-1");
      }
    });
    activeFrameEl = frame;
  }

  function loadRouteIntoFrame(frame, embeddedRoute, route) {
    if (!frame) return;
    var state = getFrameState(frame);
    state.pendingRoute = route;
    state.title = "";
    if (frame.getAttribute("src") !== embeddedRoute) {
      frame.setAttribute("src", embeddedRoute);
    }
  }

  function getPrimaryWarmRoute(pathname) {
    var resolved = resolveSupportedPath(pathname) || DEFAULT_ROUTE;
    if (resolved === REGISTRATION_INTRO_ROUTE || resolved === REGISTRATION_ENTRY_ROUTE || resolved === "/pages/amc.html" || resolved === "/pages/ahpra.html") {
      return "/pages/myinthealth.html";
    }
    return resolved;
  }

  function getWarmRouteCandidates(pathname) {
    var primary = getPrimaryWarmRoute(pathname);
    var candidates = [];
    var index = WARM_ROUTE_ORDER.indexOf(primary);

    if (index !== -1) {
      if (index + 1 < WARM_ROUTE_ORDER.length) candidates.push(WARM_ROUTE_ORDER[index + 1]);
      if (index - 1 >= 0) candidates.push(WARM_ROUTE_ORDER[index - 1]);
    }

    WARM_ROUTE_ORDER.forEach(function (route) {
      if (route !== primary && candidates.indexOf(route) === -1) candidates.push(route);
    });

    return candidates;
  }

  function resolveRouteUrlForNavigation(input) {
    var routeUrl = toRouteUrl(input);
    if (!routeUrl) return null;
    if (shouldRouteThroughRegistrationIntro(routeUrl)) {
      routeUrl = toRouteUrl(REGISTRATION_INTRO_ROUTE);
    }
    return routeUrl;
  }

  function getDesktopItems() {
    return Array.prototype.slice.call(document.querySelectorAll(".nav-menu [data-nav]"));
  }

  function getMobileTabs() {
    return Array.prototype.slice.call(document.querySelectorAll(".mobile-nav a.mobile-tab[href]"));
  }

  function getLinkRouteTarget(link) {
    if (!link) return "";
    return link.getAttribute("data-route") || link.getAttribute("href") || "";
  }

  function safeStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      return "";
    }
  }

  function safeStorageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (err) {}
  }

  function safeSessionGet(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch (err) {
      return "";
    }
  }

  function safeSessionRemove(key) {
    try {
      window.sessionStorage.removeItem(key);
    } catch (err) {}
  }

  function parseStorage(key) {
    var raw = safeStorageGet(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  function getRegistrationReturnOverrides() {
    var parsed = parseStorage(REGISTRATION_RETURN_KEY);
    return parsed && typeof parsed === "object" ? parsed : {};
  }

  function isRegistrationReturnAllowed(stepKey) {
    return getRegistrationReturnOverrides()[stepKey] === true;
  }

  function buildRegistrationRow(stepKey, config) {
    var locked = !!config.locked;
    var done = !!config.done;
    var returnable = done && isRegistrationReturnAllowed(stepKey);
    return {
      stepKey: stepKey,
      title: config.title,
      sub: config.sub,
      mobileDetail: config.mobileDetail,
      mobileStatus: config.mobileStatus,
      status: locked ? "Locked" : done ? "Done" : "Current",
      locked: locked,
      done: done,
      current: !locked && !done,
      returnable: returnable,
      href: !locked && (!done || returnable) ? config.href : "#",
      cta: locked ? "Locked" : returnable ? "Return" : done ? "Done" : "Continue"
    };
  }

  function hasCareerSecured() {
    var careerState = parseStorage(CAREER_STATE_KEY);
    if (!careerState) return false;
    var applications = careerState && Array.isArray(careerState.applications) ? careerState.applications : [];
    for (var i = 0; i < applications.length; i++) {
      var app = applications[i];
      if (!app || typeof app !== "object") continue;
      if (app.isPlacementSecured === true) return true;
      var status = String(app.rawStatus || app.status || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      if (status === "secured" || status === "placement_secured" || status === "practice_secured") return true;
    }
    return false;
  }

  function getProgressSnapshot() {
    var epic = parseStorage(EPIC_PROGRESS_KEY);
    var amc = parseStorage(AMC_PROGRESS_KEY);
    var ahpra = parseStorage(AHPRA_PROGRESS_KEY);

    var epicDone = !!(epic && epic.completed && epic.completed.verification_issued === true);
    var epicStage = epic && typeof epic.stage === "string" ? epic.stage : "create_account";
    var epicCurrentLabel = EPIC_STAGE_LABELS[epicStage] || EPIC_STAGE_LABELS.create_account;

    var amcDone = !!(amc && amc.completed && amc.completed.qualifications_verified === true);
    var amcStage = amc && typeof amc.stage === "string" ? amc.stage : "create_portfolio";
    var amcCurrentLabel = AMC_STAGE_LABELS[amcStage] || AMC_STAGE_LABELS.create_portfolio;

    var ahpraDone = !!(ahpra && ahpra.completed && ahpra.completed.verification_issued === true);
    var careerSecured = hasCareerSecured();

    return {
      epicDone: epicDone,
      epicCurrentLabel: epicCurrentLabel,
      amcDone: amcDone,
      amcCurrentLabel: amcCurrentLabel,
      ahpraDone: ahpraDone,
      careerSecured: careerSecured
    };
  }

  function getRegistrationRows() {
    var snap = getProgressSnapshot();
    var bypassLocks = !!BYPASS_LOCK_EMAILS[getCurrentUserEmail()];

    // NOTE: Visa step is intentionally hidden from the user-facing registration
    // journey for the v1 release. Backend + pages/visa.html remain in place so
    // the feature can be re-enabled later. See docs/deferred-visa-application.md
    // for restoration steps.
    var ahpraUnlocked = snap.careerSecured && snap.amcDone;
    var ahpraLockedHint = !snap.careerSecured
      ? "Secure a placement to unlock"
      : !snap.amcDone
        ? "Unlocked after AMC is complete"
        : snap.ahpraDone ? "Completed" : "In progress";

    return [
      buildRegistrationRow("career", {
        title: "1. Your Practice",
        sub: "View your secured practice placement.",
        mobileDetail: "Your placed practice details and contact information.",
        mobileStatus: snap.careerSecured ? "Placement secured" : "View placement",
        done: snap.careerSecured,
        href: "/pages/career.html"
      }),
      buildRegistrationRow("myinthealth", {
        title: "2. MyIntealth Account",
        sub: "Create account and complete EPIC verification.",
        mobileDetail: "EPIC verification is set up and moving forward.",
        mobileStatus: snap.epicDone ? "Completed" : snap.epicCurrentLabel,
        done: snap.epicDone,
        href: "/pages/myinthealth.html?" + REGISTRATION_CONTINUE_PARAM + "=1"
      }),
      buildRegistrationRow("amc", {
        title: "3. AMC Portfolio",
        sub: "Create AMC candidate portfolio and upload credentials.",
        mobileDetail: "AMC portfolio is created and connected to your verification.",
        mobileStatus: snap.epicDone ? (snap.amcDone ? "Completed" : snap.amcCurrentLabel) : "Unlocked after MyIntealth is complete",
        locked: !bypassLocks && !snap.epicDone,
        done: snap.amcDone,
        href: "/pages/amc.html"
      }),
      buildRegistrationRow("ahpra", {
        title: "4. AHPRA Registration",
        sub: "Prepare and submit your specialist registration application.",
        mobileDetail: "Specialist registration application is prepared and submitted correctly.",
        mobileStatus: ahpraLockedHint,
        locked: !bypassLocks && !ahpraUnlocked,
        done: snap.ahpraDone,
        href: "/pages/ahpra.html"
      }),
      buildRegistrationRow("pbs", {
        title: "5. PBS & Medicare",
        sub: "Apply for Medicare provider number and PBS prescriber number.",
        mobileDetail: "Medicare and PBS registration for prescribing authority.",
        mobileStatus: !snap.ahpraDone ? "Unlocked after AHPRA is complete" : "In progress",
        locked: !bypassLocks && !snap.ahpraDone,
        done: false,
        href: "/pages/pbs.html"
      }),
      buildRegistrationRow("commencement", {
        title: "6. Commencement",
        sub: "Pre-arrival checklist and first-day preparation.",
        mobileDetail: "Everything to prepare before your start date.",
        mobileStatus: !snap.ahpraDone ? "Unlocked after AHPRA is complete" : "In progress",
        locked: !bypassLocks && !snap.ahpraDone,
        done: false,
        href: "/pages/commencement.html"
      })
    ];
  }

  function buildRegistrationAction(row) {
    var actionDisabled = row.locked || (row.done && !row.returnable);
    var actionEl = document.createElement(actionDisabled ? "button" : "a");
    actionEl.className = ("reg-btn " + (row.done ? "done" : row.locked ? "locked" : "")).trim();
    actionEl.textContent = row.cta;
    if (actionDisabled) {
      actionEl.type = "button";
      actionEl.disabled = true;
    } else {
      actionEl.href = row.href;
      actionEl.setAttribute("data-route", row.href);
      actionEl.addEventListener("click", function (e) {
        e.preventDefault();
        navigateTo(row.href, { historyMode: "push" });
      });
    }
    return actionEl;
  }

  function renderRegistrationRows() {
    var rows = getRegistrationRows();

    if (registrationRowsEl) registrationRowsEl.innerHTML = "";
    if (mobileRegTableEl) mobileRegTableEl.innerHTML = "";

    rows.forEach(function (row) {
      var rowEl = document.createElement("div");
      rowEl.className = ("reg-row " + (row.done ? "done" : "") + " " + (row.locked ? "locked-row" : "")).trim();
      var lockedHint = row.locked && row.mobileStatus ? "<div class=\"reg-locked-hint\">" + row.mobileStatus + "</div>" : "";
      rowEl.innerHTML = [
        "<div>",
        "<div class=\"reg-name\">" + row.title + "</div>",
        "<div class=\"reg-sub\">" + row.sub + "</div>",
        lockedHint,
        "</div>"
      ].join("");
      rowEl.appendChild(buildRegistrationAction(row));
      if (registrationRowsEl) registrationRowsEl.appendChild(rowEl);
    });

    if (!mobileRegTableEl) return;
    if (!rows.length) {
      var doneEl = document.createElement("div");
      doneEl.className = "mobile-step-card";
      doneEl.innerHTML = "<div class=\"mobile-step-head\"><span class=\"mobile-step-title\">All visible steps are complete.</span></div>";
      mobileRegTableEl.appendChild(doneEl);
      return;
    }

    rows.forEach(function (row, idx) {
      var isCurrent = row.current;
      var cardEl = document.createElement("div");
      var bodyId = "mobileStepBody" + idx;

      cardEl.className = ("mobile-step-card " + (row.locked ? "locked" : "unlocked") + " " + (isCurrent ? "current open" : "")).trim();
      cardEl.innerHTML = [
        "<button class=\"mobile-step-head\" type=\"button\" " + (isCurrent ? "disabled" : "") + " aria-expanded=\"" + (isCurrent ? "true" : "false") + "\" aria-controls=\"" + bodyId + "\">",
        "<span class=\"mobile-step-title\">" + row.title + "</span>",
        "<span style=\"display:flex; align-items:center; gap:8px;\">",
        "<span class=\"mobile-step-caret\">" + (isCurrent ? "" : "\u2304") + "</span>",
        "</span>",
        "</button>",
        "<div class=\"mobile-step-body\" id=\"" + bodyId + "\" " + (isCurrent ? "" : "hidden") + ">",
        "<p class=\"mobile-step-copy\">" + (row.mobileDetail || row.sub) + "</p>",
        "<p class=\"mobile-step-status\"><b>Status:</b> " + (row.mobileStatus || row.status) + "</p>",
        "</div>"
      ].join("");

      var headBtn = cardEl.querySelector(".mobile-step-head");
      var bodyEl = cardEl.querySelector(".mobile-step-body");
      var autoCloseTimer = null;
      bodyEl.appendChild(buildRegistrationAction(row));

      if (headBtn && bodyEl && !isCurrent) {
        headBtn.addEventListener("click", function () {
          var isOpen = !bodyEl.hidden;
          if (autoCloseTimer) {
            clearTimeout(autoCloseTimer);
            autoCloseTimer = null;
          }
          bodyEl.hidden = isOpen;
          headBtn.setAttribute("aria-expanded", isOpen ? "false" : "true");
          cardEl.classList.toggle("open", !isOpen);
          if (!isOpen) {
            autoCloseTimer = window.setTimeout(function () {
              bodyEl.hidden = true;
              headBtn.setAttribute("aria-expanded", "false");
              cardEl.classList.remove("open");
              autoCloseTimer = null;
            }, 5000);
          }
        });
      }

      mobileRegTableEl.appendChild(cardEl);
    });
  }

  function normalizeEmail(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
  }

  function readCachedSessionProfile() {
    if (window.gpSessionProfile && typeof window.gpSessionProfile === "object") {
      return window.gpSessionProfile;
    }

    var raw = safeSessionGet(SESSION_PROFILE_CACHE_KEY);
    if (!raw) return null;

    try {
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (err) {
      return null;
    }
  }

  function getCurrentUserEmail() {
    var cachedProfile = readCachedSessionProfile();
    if (cachedProfile && cachedProfile.email) {
      return normalizeEmail(cachedProfile.email);
    }
    return normalizeEmail(safeStorageGet(SESSION_OWNER_KEY));
  }

  function hasSeenRegistrationIntro() {
    return !!safeStorageGet(REGISTRATION_INTRO_SEEN_KEY);
  }

  function shouldAlwaysShowRegistrationIntro() {
    return !!REGISTRATION_INTRO_ALWAYS_EMAILS[getCurrentUserEmail()];
  }

  function consumeRegistrationIntroBypass() {
    var bypassSession = safeSessionGet(REGISTRATION_INTRO_BYPASS_KEY);
    var bypassLocal = safeStorageGet(REGISTRATION_INTRO_BYPASS_KEY);
    var shouldBypass = bypassSession === "1" || bypassLocal === "1";
    if (!shouldBypass) return false;
    safeSessionRemove(REGISTRATION_INTRO_BYPASS_KEY);
    safeStorageRemove(REGISTRATION_INTRO_BYPASS_KEY);
    return true;
  }

  function shouldRouteThroughRegistrationIntro(routeUrl) {
    if (!routeUrl) return false;
    if (routeUrl.searchParams.get(REGISTRATION_CONTINUE_PARAM) === "1") return false;
    if (normalizePath(routeUrl.pathname) !== REGISTRATION_ENTRY_ROUTE) return false;
    if (consumeRegistrationIntroBypass()) return false;
    if (shouldAlwaysShowRegistrationIntro()) return true;
    return !hasSeenRegistrationIntro();
  }

  function isVisible(el) {
    if (!el) return false;
    var style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
  }

  function getMobileNavClearance() {
    if (!mobileNavEl || !isVisible(mobileNavEl)) return 0;
    return Math.max(0, Math.ceil(window.innerHeight - mobileNavEl.getBoundingClientRect().top));
  }

  function setLoading(loading) {
    document.body.classList.toggle("app-shell-loading", !!loading);
    if (loaderEl) loaderEl.hidden = !loading;
  }

  function clearDesktopRegistrationCloseTimer() {
    if (!desktopRegistrationCloseTimer) return;
    window.clearTimeout(desktopRegistrationCloseTimer);
    desktopRegistrationCloseTimer = 0;
  }

  function setDesktopRegistrationOpen(open) {
    if (!desktopRegistrationDropdownEl || !desktopRegistrationTriggerEl) return;
    if (open) clearDesktopRegistrationCloseTimer();
    if (open) renderRegistrationRows();
    desktopRegistrationDropdownEl.classList.toggle("is-open", !!open);
    desktopRegistrationTriggerEl.setAttribute("aria-expanded", open ? "true" : "false");
    if (navGlassEl) navGlassEl.classList.toggle("engulf", !!open);
  }

  function scheduleDesktopRegistrationClose() {
    clearDesktopRegistrationCloseTimer();
    desktopRegistrationCloseTimer = window.setTimeout(function () {
      setDesktopRegistrationOpen(false);
    }, 140);
  }

  function openMobileRegistrationSheet() {
    if (!mobileRegSheetEl || !mobileRegBackdropEl || !mobileRegistrationToggleEl) return;
    renderRegistrationRows();
    mobileRegistrationSheetOpen = true;
    mobileRegSheetEl.scrollTop = 0;
    mobileRegSheetEl.style.transform = "";
    mobileRegBackdropEl.classList.add("show");
    window.requestAnimationFrame(function () {
      if (mobileRegistrationSheetOpen && mobileRegSheetEl) {
        mobileRegSheetEl.classList.add("show");
      }
    });
    mobileRegistrationToggleEl.setAttribute("aria-expanded", "true");
  }

  function closeMobileRegistrationSheet() {
    if (!mobileRegSheetEl || !mobileRegBackdropEl || !mobileRegistrationToggleEl) return;
    mobileRegistrationSheetOpen = false;
    mobileRegSheetEl.style.transform = "";
    mobileRegBackdropEl.classList.remove("show");
    mobileRegSheetEl.classList.remove("show");
    mobileRegistrationToggleEl.setAttribute("aria-expanded", "false");
  }

  function handleMobileRegistrationToggle(event) {
    event.preventDefault();
    event.stopPropagation();
    if (mobileRegistrationSheetOpen) {
      closeMobileRegistrationSheet();
    } else {
      openMobileRegistrationSheet();
    }
  }

  function updateFrameOffsets() {
    var topOffset = 0;
    var frameTop = 0;
    var navClearance = 0;
    var resolvedPath = getResolvedRoutePath(currentRoute || window.location.pathname);

    if (desktopHostEl && isVisible(desktopHostEl)) {
      topOffset = Math.ceil(desktopHostEl.getBoundingClientRect().bottom + 8);
    }

    frameTop = resolvedPath === REGISTRATION_INTRO_ROUTE ? 0 : topOffset;

    navClearance = getMobileNavClearance();

    document.documentElement.style.setProperty("--app-shell-top-offset", Math.max(topOffset, 0) + "px");
    document.documentElement.style.setProperty("--app-shell-frame-top", Math.max(frameTop, 0) + "px");
    document.documentElement.style.setProperty("--app-shell-bottom-offset", "0px");
    document.documentElement.style.setProperty("--app-shell-nav-clearance", navClearance + "px");
  }

  function moveNavGlass(target, animate) {
    if (!target || !navGlassEl || !desktopNavEl || !isVisible(target)) return;
    var parentRect = desktopNavEl.getBoundingClientRect();
    var rect = target.getBoundingClientRect();
    var left = rect.left - parentRect.left;
    var top = rect.top - parentRect.top;
    var width = rect.width;
    var height = rect.height;
    if (animate === false || !navGlassInitialized) {
      var previousTransition = navGlassEl.style.transition;
      navGlassEl.style.transition = "none";
      navGlassEl.style.left = left + "px";
      navGlassEl.style.top = top + "px";
      navGlassEl.style.width = width + "px";
      navGlassEl.style.height = height + "px";
      navGlassEl.style.opacity = "1";
      void navGlassEl.offsetWidth;
      navGlassEl.style.transition = previousTransition;
      navGlassInitialized = true;
      return;
    }
    navGlassEl.style.left = left + "px";
    navGlassEl.style.top = top + "px";
    navGlassEl.style.width = width + "px";
    navGlassEl.style.height = height + "px";
    navGlassEl.style.opacity = "1";
  }

  function moveMobileGlass(target, animate) {
    if (!target || !mobileNavGlassEl || !mobileNavEl || !isVisible(target) || !isVisible(mobileNavEl)) return;
    var parentRect = mobileNavEl.getBoundingClientRect();
    var rect = target.getBoundingClientRect();
    if (animate === false || !mobileGlassInitialized) {
      var previousTransition = mobileNavGlassEl.style.transition;
      mobileNavGlassEl.style.transition = "none";
      mobileNavGlassEl.style.left = (rect.left - parentRect.left) + "px";
      mobileNavGlassEl.style.top = (rect.top - parentRect.top) + "px";
      mobileNavGlassEl.style.width = rect.width + "px";
      mobileNavGlassEl.style.height = rect.height + "px";
      mobileNavGlassEl.style.opacity = "1";
      void mobileNavGlassEl.offsetWidth;
      mobileNavGlassEl.style.transition = previousTransition;
      mobileGlassInitialized = true;
      return;
    }
    mobileNavGlassEl.style.left = (rect.left - parentRect.left) + "px";
    mobileNavGlassEl.style.top = (rect.top - parentRect.top) + "px";
    mobileNavGlassEl.style.width = rect.width + "px";
    mobileNavGlassEl.style.height = rect.height + "px";
    mobileNavGlassEl.style.opacity = "1";
  }

  function setDesktopActive(navKey, animate) {
    var items = getDesktopItems();
    var nextActive = null;
    items.forEach(function (item) {
      var isActive = item.getAttribute("data-nav") === navKey;
      item.classList.toggle("active", isActive);
      if (isActive) {
        item.setAttribute("aria-current", "page");
        nextActive = item;
      } else {
        item.removeAttribute("aria-current");
      }
    });
    activeDesktopItem = nextActive;
    if (nextActive) moveNavGlass(nextActive, animate);
  }

  function setMobileActive(pathname, animate) {
    var tabs = getMobileTabs();
    var nextActive = null;
    tabs.forEach(function (tab) {
      var resolved = toRouteUrl(getLinkRouteTarget(tab));
      var isActive = !!pathname && !!resolved && normalizePath(resolved.pathname) === pathname;
      tab.classList.toggle("mobile-tab-active", isActive);
      if (isActive) {
        tab.setAttribute("aria-current", "page");
        nextActive = tab;
      } else {
        tab.removeAttribute("aria-current");
      }
    });
    activeMobileTab = nextActive;
    if (nextActive) {
      moveMobileGlass(nextActive, animate);
    } else if (mobileNavGlassEl) {
      mobileNavGlassEl.style.opacity = "0";
    }
  }

  function syncActiveNav(routeUrl, animate) {
    var group = NAV_GROUPS[resolveSupportedPath(routeUrl.pathname) || DEFAULT_ROUTE] || NAV_GROUPS[DEFAULT_ROUTE];
    setDesktopActive(group.desktop, animate);
    setMobileActive(group.mobile ? normalizePath(group.mobile) : "", animate);
  }

  function updateTitle(nextTitle) {
    if (typeof nextTitle !== "string") return;
    var trimmed = nextTitle.trim();
    if (trimmed) document.title = trimmed;
  }

  function enforceEmbeddedChrome(childDoc) {
    if (!childDoc || !childDoc.documentElement) return;

    childDoc.documentElement.classList.add("gp-shell-embedded");
    if (childDoc.body) childDoc.body.classList.add("gp-shell-embedded");

    var style = childDoc.getElementById(EMBED_STYLE_ID);
    if (!style) {
      style = childDoc.createElement("style");
      style.id = EMBED_STYLE_ID;
      (childDoc.head || childDoc.documentElement).appendChild(style);
    }

    var bottomClearance = getMobileNavClearance();
    style.textContent = [
      ":root{--gp-shell-bottom-clearance:" + bottomClearance + "px;}",
      "html.gp-shell-embedded .desktop-topbar,html.gp-shell-embedded .topbar,html.gp-shell-embedded .mobile-nav{display:none!important;}",
      "html.gp-shell-embedded .dash-wrap{padding-bottom:32px!important;}",
      "html.gp-shell-embedded body{overflow-x:hidden;padding-bottom:" + bottomClearance + "px!important;}"
    ].join("");
  }

  function navigateTo(input, options) {
    var routeUrl = resolveRouteUrlForNavigation(input);
    var opts = options || {};
    var activeState = getFrameState(activeFrameEl);
    var targetFrame = null;
    var cachedFrame = null;

    if (!routeUrl) {
      if (typeof input === "string" && input) window.location.href = input;
      return;
    }

    setDesktopRegistrationOpen(false);
    closeMobileRegistrationSheet();

    var route = routeFromUrl(routeUrl);
    var embeddedRoute = toEmbeddedRoute(routeUrl);
    if (!embeddedRoute) return;

    if (route === currentRoute && activeFrameEl && activeFrameEl.getAttribute("src") === embeddedRoute && isFrameShowingRoute(activeFrameEl, route)) {
      if (opts.historyMode === "replace" && window.location.pathname + window.location.search + window.location.hash !== route) {
        history.replaceState({ route: route }, "", route);
      }
      scheduleRouteWarmup(route);
      return;
    }

    currentRoute = route;
    syncActiveNav(routeUrl, opts.animate !== false);

    if (opts.historyMode === "push") {
      history.pushState({ route: route }, "", route);
    } else if (opts.historyMode === "replace") {
      history.replaceState({ route: route }, "", route);
    }

    if (isFrameShowingRoute(activeFrameEl, route)) {
      setLoading(false);
      scheduleRouteWarmup(route);
      return;
    }

    cachedFrame = findLoadedFrameForRoute(route);
    if (cachedFrame) {
      activateFrame(cachedFrame);
      setLoading(false);
      try {
        if (cachedFrame.contentDocument) enforceEmbeddedChrome(cachedFrame.contentDocument);
      } catch (err) {}
      syncFromChildRoute(routeUrl, getFrameState(cachedFrame).title || "");
      scheduleRouteWarmup(route);
      return;
    }

    targetFrame = activeState && activeState.loadedRoute ? getInactiveFrame() : activeFrameEl;
    if (!targetFrame) return;

    if (pendingNavigation && pendingNavigation.route === route && getFrameState(targetFrame).pendingRoute === route) {
      if (!activeState || !activeState.loadedRoute) setLoading(true);
      return;
    }

    pendingNavigation = { route: route };
    if (!activeState || !activeState.loadedRoute) {
      setLoading(true);
    } else {
      setLoading(false);
    }

    loadRouteIntoFrame(targetFrame, embeddedRoute, route);
  }

  function prefetchSupportedRoutes() {
    Object.keys(PAGE_PATHS).forEach(function (pathname) {
      var embeddedRoute = toEmbeddedRoute(pathname);
      if (!embeddedRoute) return;
      var linkId = "gp-prefetch-" + pathname.replace(/[^a-z0-9]/gi, "-");
      if (document.getElementById(linkId)) return;
      var link = document.createElement("link");
      link.id = linkId;
      link.rel = "prefetch";
      link.as = "document";
      link.href = embeddedRoute;
      document.head.appendChild(link);
    });
  }

  function warmRoute(input) {
    var routeUrl = resolveRouteUrlForNavigation(input);
    var route = "";
    var embeddedRoute = "";
    var warmFrame = null;
    var warmState = null;

    if (!routeUrl) return;
    route = routeFromUrl(routeUrl);
    embeddedRoute = toEmbeddedRoute(routeUrl);
    if (!embeddedRoute || route === currentRoute || findLoadedFrameForRoute(route)) return;

    warmFrame = getInactiveFrame();
    warmState = getFrameState(warmFrame);
    if (!warmFrame || !warmState) return;
    if (warmState.pendingRoute === route || warmState.loadedRoute === route) return;
    if (pendingNavigation && pendingNavigation.route === route) return;

    loadRouteIntoFrame(warmFrame, embeddedRoute, route);
  }

  function scheduleRouteWarmup(route) {
    var candidates = getWarmRouteCandidates(route);
    clearTimeout(warmRouteTimer);
    warmRouteTimer = window.setTimeout(function () {
      for (var i = 0; i < candidates.length; i += 1) {
        var before = getInactiveFrame();
        var beforeState = getFrameState(before);
        var warmedRoute = beforeState ? beforeState.loadedRoute || beforeState.pendingRoute : "";
        warmRoute(candidates[i]);
        var after = getInactiveFrame();
        var afterState = getFrameState(after);
        var afterRoute = afterState ? afterState.loadedRoute || afterState.pendingRoute : "";
        if (afterRoute && afterRoute !== warmedRoute) break;
      }
    }, 140);
  }

  function handleDocumentClick(event) {
    var clickTarget = getEventElement(event.target);
    var mobileToggle = null;
    var desktopToggle = null;
    var link = null;
    var routeUrl = null;

    if (!clickTarget) return;

    desktopToggle = clickTarget.closest("#registrationMenuBtn");
    mobileToggle = clickTarget.closest("[data-mobile-registration-toggle]");

    if (desktopToggle && desktopNavEl && isVisible(desktopNavEl)) {
      event.preventDefault();
      setDesktopRegistrationOpen(!desktopRegistrationDropdownEl.classList.contains("is-open"));
      moveNavGlass(desktopRegistrationTriggerEl, true);
      return;
    }

    if (mobileToggle && mobileNavEl && isVisible(mobileNavEl)) {
      event.preventDefault();
      if (mobileRegistrationSheetOpen) {
        closeMobileRegistrationSheet();
      } else {
        openMobileRegistrationSheet();
      }
      return;
    }

    if (!desktopRegistrationDropdownEl || !desktopRegistrationDropdownEl.contains(clickTarget)) {
      setDesktopRegistrationOpen(false);
    }

    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    link = clickTarget.closest("a[href]");
    if (!link) return;
    if (link.target && link.target !== "_self") return;
    if (link.hasAttribute("download")) return;

    routeUrl = toRouteUrl(getLinkRouteTarget(link));
    if (!routeUrl) return;

    event.preventDefault();
    navigateTo(routeUrl, { historyMode: "push" });
  }

  function handleRouteWarmIntent(event) {
    var target = getEventElement(event.target);
    var link = null;

    if (!target) return;

    link = target.closest("a[href]");
    if (!link) return;
    if (link.target && link.target !== "_self") return;
    if (link.hasAttribute("download")) return;

    warmRoute(getLinkRouteTarget(link));
  }

  function handleDesktopHoverEvents() {
    if (!desktopNavEl) return;

    if (desktopRegistrationDropdownEl && desktopRegistrationTriggerEl) {
      desktopRegistrationDropdownEl.addEventListener("mouseenter", function () {
        clearDesktopRegistrationCloseTimer();
        setDesktopRegistrationOpen(true);
        moveNavGlass(desktopRegistrationTriggerEl, true);
      });
      desktopRegistrationDropdownEl.addEventListener("mouseleave", function () {
        scheduleDesktopRegistrationClose();
      });
      desktopRegistrationDropdownEl.addEventListener("focusin", function () {
        clearDesktopRegistrationCloseTimer();
        setDesktopRegistrationOpen(true);
        moveNavGlass(desktopRegistrationTriggerEl, true);
      });
      desktopRegistrationDropdownEl.addEventListener("focusout", function () {
        window.setTimeout(function () {
          if (!desktopRegistrationDropdownEl.contains(document.activeElement)) {
            scheduleDesktopRegistrationClose();
          }
        }, 0);
      });
    }

    getDesktopItems().forEach(function (item) {
      item.addEventListener("mouseenter", function () {
        hoveredDesktopItem = item;
        moveNavGlass(item, true);
        if (item !== desktopRegistrationTriggerEl) setDesktopRegistrationOpen(false);
      });
      item.addEventListener("focus", function () {
        hoveredDesktopItem = item;
        moveNavGlass(item, true);
        if (item !== desktopRegistrationTriggerEl) setDesktopRegistrationOpen(false);
      });
    });

    desktopNavEl.addEventListener("mousemove", function (event) {
      var hit = event.target instanceof Element ? event.target.closest("[data-nav]") : null;
      if (!hit || hit === hoveredDesktopItem) return;
      hoveredDesktopItem = hit;
      moveNavGlass(hit, true);
    });

    desktopNavEl.addEventListener("mouseleave", function () {
      hoveredDesktopItem = null;
      scheduleDesktopRegistrationClose();
      if (activeDesktopItem) moveNavGlass(activeDesktopItem, true);
    });
  }

  function handleKeydown(event) {
    if (event.key !== "Escape") return;
    setDesktopRegistrationOpen(false);
    closeMobileRegistrationSheet();
  }

  function handleMobileSheetTouchStart(event) {
    if (!mobileRegSheetEl || !mobileRegSheetEl.classList.contains("show")) return;
    mobileSheetStartY = event.touches[0].clientY;
    mobileSheetDeltaY = 0;
    mobileSheetDragging = true;
  }

  function handleMobileSheetTouchMove(event) {
    var currentY = 0;
    if (!mobileSheetDragging || !mobileRegSheetEl) return;
    currentY = event.touches[0].clientY;
    mobileSheetDeltaY = Math.max(0, currentY - mobileSheetStartY);
    if (mobileSheetDeltaY > 0) {
      mobileRegSheetEl.style.transform = "translateY(" + mobileSheetDeltaY + "px)";
    }
  }

  function handleMobileSheetTouchEnd() {
    if (!mobileSheetDragging) return;
    mobileSheetDragging = false;
    if (mobileSheetDeltaY > 90) {
      closeMobileRegistrationSheet();
    } else if (mobileRegSheetEl) {
      mobileRegSheetEl.style.transform = "";
    }
  }

  function syncFromChildRoute(input, nextTitle) {
    var routeUrl = toRouteUrl(input);
    var state = getFrameState(activeFrameEl);
    if (!routeUrl) return;
    currentRoute = routeFromUrl(routeUrl);
    if (state) {
      state.loadedRoute = currentRoute;
      state.pendingRoute = "";
      state.title = typeof nextTitle === "string" ? nextTitle : state.title;
    }
    syncActiveNav(routeUrl, false);
    if (window.location.pathname + window.location.search + window.location.hash !== currentRoute) {
      history.replaceState({ route: currentRoute }, "", currentRoute);
    }
    updateTitle(nextTitle);
  }

  function handleResize() {
    updateFrameOffsets();
    frameEls.forEach(function (frame) {
      try {
        if (frame && frame.contentDocument) enforceEmbeddedChrome(frame.contentDocument);
      } catch (err) {
        // Ignore same-origin race conditions during frame resize.
      }
    });
    if (desktopNavEl && !isVisible(desktopNavEl)) {
      setDesktopRegistrationOpen(false);
    }
    if (mobileNavEl && !isVisible(mobileNavEl)) {
      closeMobileRegistrationSheet();
    }
    if (activeDesktopItem) moveNavGlass(activeDesktopItem, false);
    if (activeMobileTab) moveMobileGlass(activeMobileTab, false);
  }

  function handleFrameLoad(event) {
    var frame = event && event.currentTarget;
    var frameState = getFrameState(frame);

    try {
      var childHref = frame.contentWindow.location.href;
      if (!childHref || childHref === "about:blank") return;
      var childUrl = new URL(childHref);
      if (childUrl.protocol !== "http:" && childUrl.protocol !== "https:") return;
      var childPath = normalizePath(childUrl.pathname);
      var childDoc = frame.contentDocument;
      var nextRoute = routeFromUrl(childUrl);

      enforceEmbeddedChrome(childDoc);

      if (!isSupportedPath(childPath)) {
        childUrl.searchParams.delete(EMBED_PARAM);
        window.location.replace(childUrl.pathname + childUrl.search + childUrl.hash);
        return;
      }

      if (frameState) {
        frameState.loadedRoute = nextRoute;
        frameState.pendingRoute = "";
        frameState.title = childDoc ? childDoc.title : "";
      }

      if (pendingNavigation && (pendingNavigation.route === nextRoute || routesShareSupportedPage(pendingNavigation.route, nextRoute))) {
        if (frame !== activeFrameEl) activateFrame(frame);
        setLoading(false);
        updateFrameOffsets();
        syncFromChildRoute(childUrl, childDoc ? childDoc.title : "");
        pendingNavigation = null;
        scheduleRouteWarmup(nextRoute);
        return;
      }

      if (frame === activeFrameEl && !pendingNavigation) {
        setLoading(false);
        updateFrameOffsets();
        syncFromChildRoute(childUrl, childDoc ? childDoc.title : "");
        scheduleRouteWarmup(nextRoute);
      }
    } catch (err) {
      // Same-origin access is expected; ignore transient load errors.
    }
  }

  function handleMessage(event) {
    var activeWindow = activeFrameEl && activeFrameEl.contentWindow;
    var routeUrl = null;
    var route = "";
    if (event.origin !== window.location.origin) return;
    if (!event.data || event.data.type !== "gp-shell-route") return;
    if (!activeWindow || event.source !== activeWindow) return;
    routeUrl = toRouteUrl(event.data.href);
    if (!routeUrl) return;
    route = routeFromUrl(routeUrl);
    if (pendingNavigation && route !== currentRoute) return;
    syncFromChildRoute(routeUrl, event.data.title);
  }

  function handlePopState(event) {
    var route = event.state && typeof event.state.route === "string"
      ? event.state.route
      : (window.location.pathname + window.location.search + window.location.hash);
    navigateTo(route, { historyMode: "replace", animate: false });
  }

  function resolveInitialRoute() {
    var currentUrl = new URL(window.location.href);
    var routed = currentUrl.searchParams.get("route");
    if (!routed && isSupportedPath(currentUrl.pathname)) {
      currentUrl.searchParams.delete(EMBED_PARAM);
      return routeFromUrl(currentUrl);
    }
    var initialRoute = routed || DEFAULT_ROUTE;
    var routeUrl = toRouteUrl(initialRoute);
    return routeUrl ? routeFromUrl(routeUrl) : DEFAULT_ROUTE;
  }

  function init() {
    if (!frameEls.length || !activeFrameEl) return;

    window.gpShellNavigate = function (route, options) {
      var opts = options || {};
      navigateTo(route, {
        historyMode: opts.replace ? "replace" : "push",
        animate: opts.animate
      });
    };

    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("mouseover", handleRouteWarmIntent, { passive: true });
    document.addEventListener("focusin", handleRouteWarmIntent);
    document.addEventListener("touchstart", handleRouteWarmIntent, { passive: true });
    if (mobileRegistrationToggleEl) mobileRegistrationToggleEl.addEventListener("click", handleMobileRegistrationToggle);
    if (mobileRegBackdropEl) mobileRegBackdropEl.addEventListener("click", closeMobileRegistrationSheet);
    if (mobileRegCloseBtnEl) mobileRegCloseBtnEl.addEventListener("click", closeMobileRegistrationSheet);
    if (mobileRegSheetEl) {
      mobileRegSheetEl.addEventListener("touchstart", handleMobileSheetTouchStart, { passive: true });
      mobileRegSheetEl.addEventListener("touchmove", handleMobileSheetTouchMove, { passive: true });
      mobileRegSheetEl.addEventListener("touchend", handleMobileSheetTouchEnd);
    }
    frameEls.forEach(function (frame) {
      frame.addEventListener("load", handleFrameLoad);
      getFrameState(frame);
    });
    window.addEventListener("message", handleMessage);
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("resize", handleResize);
    document.addEventListener("keydown", handleKeydown);

    handleDesktopHoverEvents();
    prefetchSupportedRoutes();
    activateFrame(activeFrameEl);

    var initialRoute = resolveInitialRoute();
    navigateTo(initialRoute, { historyMode: "replace", animate: false });

    window.requestAnimationFrame(function () {
      handleResize();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();

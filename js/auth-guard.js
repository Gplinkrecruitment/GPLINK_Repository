(function () {
  const pathname = window.location.pathname;
  const isSignInPage = pathname === "/pages/signin";
  const isPepPathwayPage = pathname === "/pages/pep-pathway" || pathname === "/pages/pep-pathway.html";
  const isPublicPage =
    isSignInPage ||
    pathname === "/pages/privacy" ||
    pathname === "/pages/terms";
  const SESSION_PROFILE_CACHE_KEY = "gp_session_profile_cache";
  const PROFILE_CACHE_KEY = "gp_profile_cache";
  const ACCOUNT_STATUS_CACHE_KEY = "gp_account_status_cache";
  const FULL_ACCESS_EMAILS = { "hello@mygplink.com.au": true };

  function safeSessionGet(key) {
    try {
      return sessionStorage.getItem(key);
    } catch (err) {
      return "";
    }
  }

  function safeSessionSet(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch (err) {}
  }

  function safeSessionRemove(key) {
    try {
      sessionStorage.removeItem(key);
    } catch (err) {}
  }

  function readCachedSessionProfile() {
    const raw = safeSessionGet(SESSION_PROFILE_CACHE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (err) {
      return null;
    }
  }

  function clearClientAuthCaches() {
    safeSessionRemove(SESSION_PROFILE_CACHE_KEY);
    safeSessionRemove(PROFILE_CACHE_KEY);
    safeSessionRemove(ACCOUNT_STATUS_CACHE_KEY);
    try { localStorage.removeItem("gp_account_under_review"); } catch (err) {}
    try { localStorage.removeItem("gp_account_pep_waitlist"); } catch (err) {}
  }

  // PEP gate: a GP whose qualification predates the expedited-specialist cutoff is
  // held on the PEP (Substantially Comparable) waitlist and must not see the app —
  // only the PEP pathway page — until that pathway launches. This is a HARD redirect
  // (unlike under_review, which is a soft overlay). Returns true if it redirected.
  function applyPepGate(status) {
    var isFullAccess = FULL_ACCESS_EMAILS[getBypassEmail()];
    if (status === "pep_waitlist" && !isFullAccess) {
      try { localStorage.setItem("gp_account_pep_waitlist", "true"); } catch (err) {}
      if (!isPepPathwayPage && !isPublicPage) {
        window.location.replace("/pages/pep-pathway");
        return true;
      }
    } else {
      try { localStorage.removeItem("gp_account_pep_waitlist"); } catch (err) {}
      // Released / not gated: don't strand them on the PEP page.
      if (isPepPathwayPage) {
        window.location.replace("/pages/index");
        return true;
      }
    }
    return false;
  }

  const cachedSessionProfile = readCachedSessionProfile();
  if (cachedSessionProfile) {
    window.gpSessionProfile = cachedSessionProfile;
  }

  const cachedAccountStatus = safeSessionGet(ACCOUNT_STATUS_CACHE_KEY);
  if (cachedAccountStatus === "under_review") {
    try { localStorage.setItem("gp_account_under_review", "true"); } catch (err) {}
  }

  // Instant PEP gate from cache (no flash-of-app-content). The PEP page
  // itself is exempt, and it self-corrects via the authoritative check below if the
  // GP has since been released. Returning here halts the guard; the redirect target
  // re-runs it cleanly.
  if ((cachedAccountStatus === "pep_waitlist" || (function () { try { return localStorage.getItem("gp_account_pep_waitlist") === "true"; } catch (e) { return false; } })())
      && !isPepPathwayPage && !isPublicPage) {
    if (!FULL_ACCESS_EMAILS[getBypassEmail()]) {
      window.location.replace("/pages/pep-pathway");
      return;
    }
  }

  var gpCacheFetch = null;
  try {
    gpCacheFetch = (window.gpCache && window.gpCache.fetch) || (window.parent && window.parent.gpCache && window.parent.gpCache.fetch) || null;
  } catch (e) {}

  const sessionPromise = (gpCacheFetch
    ? gpCacheFetch("/api/auth/session").then(function (data) {
        var profile = data && data.profile && typeof data.profile === "object" ? data.profile : null;
        return { ok: true, authenticated: true, profile: profile };
      })
    : fetch("/api/auth/session", { credentials: "same-origin" })
        .then(async (response) => {
          if (!response.ok) {
            return { ok: false, authenticated: false, profile: null };
          }
          const data = await response.json().catch(() => ({}));
          const profile = data && data.profile && typeof data.profile === "object" ? data.profile : null;
          return { ok: true, authenticated: true, profile };
        })
  ).catch(() => ({ ok: false, authenticated: false, profile: null }));

  window.gpSessionPromise = sessionPromise;

  function normalizeReviewPath(input) {
    try {
      var url = new URL(String(input || pathname), window.location.href);
      var normalized = url.pathname || "";
      var parts = normalized.split("/").filter(Boolean);
      if (url.origin !== window.location.origin) return "";
      if (/^\/pages\/[^/]+\.html$/i.test(normalized)) normalized = normalized.slice(0, -5);
      if (parts[0] === "registration") {
        var step = String(parts[1] || "").toLowerCase();
        if (step === "myintealth" || step === "myinthealth") return "/pages/myinthealth";
        if (step === "amc") return "/pages/amc";
        if (step === "ahpra" || step === "specialist-registration") return "/pages/ahpra";
      }
      return normalized;
    } catch (err) {
      return "";
    }
  }

  const currentReviewPath = normalizeReviewPath(pathname);
  const isOnboardingPage = currentReviewPath === "/pages/onboarding";
  const ALLOWED_REVIEW_PAGES = {
    "/pages/index": true,
    "/pages/account": true,
    "/pages/myinthealth": true,
    "/pages/onboarding": true,
    "/pages/privacy": true,
    "/pages/terms": true
  };

  // The post-sign-in destination carried through the auth bounce. Same rules as
  // signin.html: internal /pages/ path only, so this can never become an
  // open redirect.
  function safeSignInNextPath() {
    try {
      var dec = new URLSearchParams(window.location.search).get("next");
      var safe = gpSafeInternalPath(dec);
      // Internal /pages/ path only (see gpSafeInternalPath).
      if (!/^\/pages\//.test(safe)) return "";
      if (!safe.startsWith("/pages/")) return "";
      return safe;
    } catch (e) { return ""; }
  }

  // The one same-origin path validator (notes below).
  function gpSafeInternalPath(raw) {
    var s = String(raw == null ? "" : raw);
    if (/:\/\//.test(s)) return "";
    if (/^\/\//.test(s)) return "";
    if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(s)) return "";
    if (!s || s.length > 2048) return "";
    if (!/^\/(?:[^/\\\s\x00-\x1f\x7f][^\\\x00-\x1f\x7f]*)?$/.test(s)) return "";
    return s;
  }
  // Why each line matters:
  //  * ":\/\/" and the scheme test kill "https://evil.test" and "javascript:...".
  //  * "^\/\/" kills the protocol-relative "//evil.test/x".
  //  * the last, fully anchored test is the real gate: exactly ONE leading "/",
  //    then no backslash and no control character anywhere. Both matter, because
  //    the URL parser reads "\" as "/" (so "/\evil.test" resolves to
  //    https://evil.test) and strips TAB/LF/CR BEFORE parsing (so "/<TAB>/evil.test"
  //    becomes "//evil.test"). Query and hash pass through byte for byte, so every
  //    real deep link (?reupload=, ?applicationId=, ?match=, ?role=, ?doc=, ?id=)
  //    keeps working.
  //  * the two /pages/ checks in safeSignInNextPath above say the same thing twice
  //    on purpose: the regex documents the rule, and String#startsWith is the form
  //    static analysis recognises as "the literal prefix fixes the host".
  // This function is duplicated verbatim in pages/signin.html and pages/error.html:
  // those are self-contained inline scripts that run before any shared file has
  // loaded, so they cannot call this copy. Keep all three identical.

  function isReviewRouteAllowed(input) {
    var target = normalizeReviewPath(input);
    if (!target) return true;
    return target === currentReviewPath || ALLOWED_REVIEW_PAGES[target] === true;
  }

  // Check localStorage first for instant enforcement (no flicker)
  if (!isPublicPage && !isOnboardingPage && localStorage.getItem("gp_account_under_review") === "true") {
    enforceRestrictedUI();
  }

  sessionPromise.then((session) => {
    if (session && session.ok) {
      window.gpSessionProfile = session.profile || window.gpSessionProfile || null;
      showImpersonationBanner(session.profile);
      if (window.gpSessionProfile) {
        safeSessionSet(SESSION_PROFILE_CACHE_KEY, JSON.stringify(window.gpSessionProfile));
      }

      if (isSignInPage) {
        // 🧨 Honour ?next. This used to hard-code /pages/index, which threw the
        // deep link away: a doctor clicking "Secure my position" in their offer
        // email was bounced here with ?next=/pages/offer-review?applicationId=…,
        // signed in, and landed on the home dashboard instead of the agreement
        // (owner report 2026-08-06). signin.html honours next on its own login
        // paths, but this guard fires on the SAME page the moment a session
        // resolves — including when the doctor is already signed in and never
        // sees a login form at all — so it raced signin.html and won.
        // Validation mirrors signin.html's GP_SIGNIN_NEXT exactly: an internal
        // /pages/ path only, no scheme, no protocol-relative prefix.
        window.location.replace(safeSignInNextPath() || "/pages/index");
        return;
      }

      // Applies a KNOWN account status. "active" is the only status that grants full
      // access; "under_review" keeps the legitimate restricted overlay; any other
      // (unknown/unrecognised) status is denied by default via the same restricted
      // mode instead of failing open to full access.
      function applyAccountStatusGate(status) {
        if (applyPepGate(status)) return;
        if (status === "active") {
          try { localStorage.removeItem("gp_account_under_review"); } catch (err) {}
          return;
        }
        try { localStorage.setItem("gp_account_under_review", "true"); } catch (err) {}
        enforceRestrictedUI();
      }

      // On the PEP page, always re-fetch fresh status so a released GP is sent back
      // into the app rather than stranded. Elsewhere the cached value is fine.
      if (cachedAccountStatus && !isPepPathwayPage) {
        applyAccountStatusGate(cachedAccountStatus);
      } else {
        var fetchAccountStatus = function (useCache) {
          return (useCache && gpCacheFetch)
            ? gpCacheFetch("/api/account/status")
            : fetch("/api/account/status", { credentials: "same-origin" }).then(function (r) { return r.json(); });
        };
        var attemptStatusCheck = function (retriesLeft, useCache) {
          fetchAccountStatus(useCache).then((statusData) => {
              if (!statusData || typeof statusData.accountStatus !== "string") {
                throw new Error("No accountStatus in response");
              }
              const accountStatus = statusData.accountStatus;
              safeSessionSet(ACCOUNT_STATUS_CACHE_KEY, accountStatus);
              applyAccountStatusGate(accountStatus);
            })
            .catch((err) => {
              if (retriesLeft > 0) {
                setTimeout(function () { attemptStatusCheck(retriesLeft - 1, false); }, 2000);
                return;
              }
              // Fail-safe on persistent network failure: do NOT fabricate an
              // "Account Under Review" wall the user can't escape. Leave the cached
              // restricted state exactly as it was (a genuinely restricted account
              // already had its flag applied at startup, and the server still gates
              // everything sensitive) and let the app load normally otherwise.
              console.warn("[AuthGuard] Could not check account status after retries; keeping cached state:", err);
            });
        };
        attemptStatusCheck(2, true);
      }

      return;
    }
    clearClientAuthCaches();
    if (!isPublicPage && !isOnboardingPage) {
      // Preserve where the user was headed (e.g. a re-upload deep link) so sign-in
      // can return them there instead of dumping them on the default dashboard.
      var _dest = window.location.pathname + window.location.search;
      var _suffix = (_dest && _dest !== "/pages/index" && _dest !== "/pages/index.html")
        ? "?next=" + encodeURIComponent(_dest) : "";
      window.location.replace("/pages/signin" + _suffix);
    }
  });

  function getBypassEmail() {
    try { var sp = readCachedSessionProfile(); if (sp && sp.email) return String(sp.email).trim().toLowerCase(); } catch (e) {}
    if (window.gpSessionProfile && window.gpSessionProfile.email) return String(window.gpSessionProfile.email).trim().toLowerCase();
    try { var owner = localStorage.getItem("gp_state_owner"); if (owner) return String(owner).trim().toLowerCase(); } catch (e) {}
    return "";
  }

  function enforceRestrictedUI() {
    if (FULL_ACCESS_EMAILS[getBypassEmail()]) return;
    document.addEventListener("DOMContentLoaded", injectRestrictionUI);
    if (document.readyState !== "loading") injectRestrictionUI();
  }

  function showImpersonationBanner(profile) {
    var impBy = profile && profile._impersonatedBy;
    if (!impBy) return;
    var gpName = ((profile.firstName || '') + ' ' + (profile.lastName || '')).trim() || profile.email || 'Unknown GP';
    var bar = document.createElement('div');
    bar.id = 'gp-impersonation-banner';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:#d97706;color:#fff;display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 16px;font:600 13px/1.3 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25)';
    bar.innerHTML = '<span>Viewing as <strong>' + gpName.replace(/</g, '&lt;') + '</strong></span>'
      + '<button id="gp-impersonation-exit" style="background:#fff;color:#d97706;border:none;border-radius:4px;padding:4px 12px;font:600 12px/1 system-ui,sans-serif;cursor:pointer">Exit</button>';
    document.body.appendChild(bar);
    document.documentElement.style.setProperty('--gp-impersonation-offset', '40px');
    document.body.style.paddingTop = '40px';
    document.getElementById('gp-impersonation-exit').addEventListener('click', function () {
      fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
        .finally(function () { window.close(); });
    });
  }

  var restrictionInjected = false;
  function injectRestrictionUI() {
    if (restrictionInjected) return;
    restrictionInjected = true;

    // Inject styles
    var styleEl = document.createElement("style");
    styleEl.textContent =
      "@keyframes gpPopupFadeIn{from{opacity:0}to{opacity:1}}" +
      "@keyframes gpPopupScaleIn{from{opacity:0;transform:scale(0.85) translateY(20px)}to{opacity:1;transform:scale(1) translateY(0)}}" +
      "#gpReviewPopup.open{display:flex!important;animation:gpPopupFadeIn 0.25s ease-out}" +
      "#gpReviewPopup.open .gp-popup-card{animation:gpPopupScaleIn 0.3s cubic-bezier(0.34,1.56,0.64,1)}" +
      /* Global copy/select block */
      "body.gp-restricted{-webkit-user-select:none!important;user-select:none!important;-webkit-touch-callout:none!important;}" +
      "body.gp-restricted *{-webkit-user-select:none!important;user-select:none!important;-webkit-touch-callout:none!important;}";
    document.head.appendChild(styleEl);

    // Add restricted class to body — blocks all selection/copy globally
    document.body.classList.add("gp-restricted");

    // Block copy/cut/selectall at document level
    function blockCopy(e) { e.preventDefault(); }
    document.addEventListener("copy", blockCopy, true);
    document.addEventListener("cut", blockCopy, true);
    document.addEventListener("selectstart", blockCopy, true);

    // Also block context menu (long-press copy on mobile)
    document.addEventListener("contextmenu", function (e) { e.preventDefault(); }, true);

    // Create review popup modal — NO backdrop dismiss, only OK button closes it
    var popup = document.createElement("div");
    popup.id = "gpReviewPopup";
    popup.style.cssText = "position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);padding:20px;";
    popup.innerHTML =
      '<div class="gp-popup-card" style="background:#fff;border-radius:20px;padding:32px 24px;max-width:340px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.15);">' +
        '<div style="width:56px;height:56px;border-radius:50%;background:#fef3c7;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">' +
          '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
        '</div>' +
        '<h3 style="font-size:18px;font-weight:800;color:#0f172a;margin:0 0 10px;">Account Under Review</h3>' +
        '<p style="font-size:14px;color:#64748b;line-height:1.5;margin:0 0 20px;">Your account is currently undergoing manual verification. Our team will contact you via email to verify your qualifications and resume full access.</p>' +
        '<button class="gp-popup-ok-btn" type="button" style="width:100%;padding:14px;border:none;border-radius:12px;background:#0f172a;color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;">OK</button>' +
      '</div>';
    document.body.appendChild(popup);

    function closePopup() {
      popup.classList.remove("open");
      popup.style.display = "none";
    }

    // Only the OK button closes the popup — no backdrop dismiss
    var okBtn = popup.querySelector(".gp-popup-ok-btn");
    okBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      closePopup();
    });
    okBtn.addEventListener("touchend", function (e) {
      e.preventDefault();
      e.stopPropagation();
      closePopup();
    });

    // Prevent any touch/click on the backdrop from propagating but do NOT close
    popup.addEventListener("click", function (e) { e.stopPropagation(); });
    popup.addEventListener("touchend", function (e) { e.stopPropagation(); });

    function showReviewPopup(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      popup.style.display = "flex";
      popup.offsetHeight;
      popup.classList.add("open");
    }

    // Blur everything below the registration steps task list on the home page
    function blurDashboardContent() {
      var taskList = document.getElementById("taskList");
      if (!taskList) return;
      var sibling = taskList.nextElementSibling;
      while (sibling) {
        if (!sibling.classList.contains("help-card")) {
          sibling.style.filter = "blur(6px)";
          sibling.style.pointerEvents = "none";
        }
        sibling = sibling.nextElementSibling;
      }
      taskList.querySelectorAll("a.task-item").forEach(function (a) {
        a.style.filter = "blur(4px)";
        a.style.pointerEvents = "none";
      });

      // Also blur the registration dropdown content on desktop
      var regDropdown = document.getElementById("registrationDropdown");
      if (regDropdown) {
        regDropdown.style.filter = "blur(6px)";
        regDropdown.style.pointerEvents = "none";
      }

      // Blur mobile registration sheet content
      var mobileRegTable = document.getElementById("mobileRegTable");
      if (mobileRegTable) {
        mobileRegTable.style.filter = "blur(6px)";
        mobileRegTable.style.pointerEvents = "none";
      }

      // Intercept "View all" link to show popup instead of opening reg sheet
      var viewAllLink = document.getElementById("viewScheduleLink");
      if (viewAllLink && !viewAllLink.dataset.gpReviewBlocked) {
        viewAllLink.dataset.gpReviewBlocked = "1";
        viewAllLink.addEventListener("click", showReviewPopup, true);
        viewAllLink.addEventListener("touchend", function (e) {
          e.preventDefault();
          showReviewPopup(e);
        }, true);
      }
    }

    // Intercept all nav links and buttons that go to restricted pages
    function interceptNav() {
      // Desktop + mobile nav links
      document.querySelectorAll("a.bottom-tab, a.mobile-tab, .sidebar a, nav a").forEach(function (a) {
        if (a.dataset.gpReviewBlocked) return;
        var href = a.getAttribute("href") || "";
        if (!isReviewRouteAllowed(href)) {
          a.style.opacity = "0.4";
          a.dataset.gpReviewBlocked = "1";
          a.addEventListener("click", showReviewPopup, true);
          a.addEventListener("touchend", function (e) {
            e.preventDefault();
            showReviewPopup(e);
          }, true);
        }
      });

      // Desktop + mobile nav buttons (Registration, Messages, Scan)
      document.querySelectorAll("button.bottom-tab, button.mobile-tab, button.nav-action, button.nav-item").forEach(function (btn) {
        if (btn.dataset.gpReviewBlocked) return;
        var label = (btn.textContent || "").trim().toLowerCase();
        // Allow Home and Account tabs only
        if (label.indexOf("account") > -1 || label.indexOf("home") > -1) return;
        btn.style.opacity = "0.4";
        btn.dataset.gpReviewBlocked = "1";
        btn.addEventListener("click", showReviewPopup, true);
        btn.addEventListener("touchend", function (e) {
          e.preventDefault();
          showReviewPopup(e);
        }, true);
      });

      // Lock scan trigger
      document.querySelectorAll("[data-qual-scan-trigger]").forEach(function (el) {
        if (el.dataset.gpReviewBlocked) return;
        el.style.opacity = "0.4";
        el.dataset.gpReviewBlocked = "1";
        el.addEventListener("click", showReviewPopup, true);
        el.addEventListener("touchend", function (e) {
          e.preventDefault();
          showReviewPopup(e);
        }, true);
      });

      // Block ALL links on the page that go to non-allowed pages
      document.querySelectorAll("a[href]").forEach(function (a) {
        if (a.dataset.gpReviewBlocked) return;
        var href = a.getAttribute("href") || "";
        if (href === "#") return;
        if (!isReviewRouteAllowed(href)) {
          a.dataset.gpReviewBlocked = "1";
          a.addEventListener("click", showReviewPopup, true);
          a.addEventListener("touchend", function (e) {
            e.preventDefault();
            showReviewPopup(e);
          }, true);
        }
      });

      // Blur dashboard content on home page
      if (pathname === "/pages/index") {
        blurDashboardContent();
      }
    }

    interceptNav();
    setTimeout(interceptNav, 500);
    setTimeout(interceptNav, 1500);
  }
})();

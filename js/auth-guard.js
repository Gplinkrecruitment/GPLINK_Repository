(function () {
  const pathname = window.location.pathname;
  const isSignInPage = pathname === "/pages/signin.html";
  const isPublicPage =
    isSignInPage ||
    pathname === "/pages/privacy.html" ||
    pathname === "/pages/terms.html";
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
  }

  const cachedSessionProfile = readCachedSessionProfile();
  if (cachedSessionProfile) {
    window.gpSessionProfile = cachedSessionProfile;
  }

  const cachedAccountStatus = safeSessionGet(ACCOUNT_STATUS_CACHE_KEY);
  if (cachedAccountStatus === "under_review") {
    try { localStorage.setItem("gp_account_under_review", "true"); } catch (err) {}
  }

  const sessionPromise = fetch("/api/auth/session", { credentials: "same-origin" })
    .then(async (response) => {
      if (!response.ok) {
        return { ok: false, authenticated: false, profile: null };
      }
      const data = await response.json().catch(() => ({}));
      const profile = data && data.profile && typeof data.profile === "object" ? data.profile : null;
      return { ok: true, authenticated: true, profile };
    })
    .catch(() => ({ ok: false, authenticated: false, profile: null }));

  window.gpSessionPromise = sessionPromise;

  const isOnboardingPage = pathname === "/pages/onboarding.html";
  const ALLOWED_REVIEW_PAGES = ["/pages/index.html", "/pages/account.html", "/pages/onboarding.html"];

  // Check localStorage first for instant enforcement (no flicker)
  if (!isPublicPage && !isOnboardingPage && localStorage.getItem("gp_account_under_review") === "true") {
    enforceRestrictedUI();
  }

  sessionPromise.then((session) => {
    if (session && session.ok) {
      window.gpSessionProfile = session.profile || window.gpSessionProfile || null;
      if (window.gpSessionProfile) {
        safeSessionSet(SESSION_PROFILE_CACHE_KEY, JSON.stringify(window.gpSessionProfile));
      }

      if (isSignInPage) {
        window.location.replace("/pages/index.html");
        return;
      }

      if (cachedAccountStatus) {
        if (cachedAccountStatus === "under_review") {
          try { localStorage.setItem("gp_account_under_review", "true"); } catch (err) {}
          enforceRestrictedUI();
        } else {
          try { localStorage.removeItem("gp_account_under_review"); } catch (err) {}
        }
      } else {
        fetch("/api/account/status", { credentials: "same-origin" })
          .then((r) => r.json())
          .then((statusData) => {
            const accountStatus = statusData && typeof statusData.accountStatus === "string"
              ? statusData.accountStatus
              : "active";
            safeSessionSet(ACCOUNT_STATUS_CACHE_KEY, accountStatus);
            if (accountStatus === "under_review") {
              localStorage.setItem("gp_account_under_review", "true");
              enforceRestrictedUI();
            } else {
              localStorage.removeItem("gp_account_under_review");
            }
          })
          .catch(() => {});
      }

      return;
    }
    clearClientAuthCaches();
    if (!isPublicPage && !isOnboardingPage) {
      window.location.replace("/pages/signin.html");
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
        var target = href.replace(/^\.?\/?/, "/").replace(/^([^/])/, "/pages/$1");
        var isAllowed = ALLOWED_REVIEW_PAGES.includes(target) || target === pathname;
        if (!isAllowed) {
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
        if (href.startsWith("http") || href.startsWith("mailto:") || href === "#") return;
        var target = href.replace(/^\.?\/?/, "/").replace(/^([^/])/, "/pages/$1");
        if (!ALLOWED_REVIEW_PAGES.includes(target)) {
          a.dataset.gpReviewBlocked = "1";
          a.addEventListener("click", showReviewPopup, true);
          a.addEventListener("touchend", function (e) {
            e.preventDefault();
            showReviewPopup(e);
          }, true);
        }
      });

      // Blur dashboard content on home page
      if (pathname === "/pages/index.html") {
        blurDashboardContent();
      }
    }

    interceptNav();
    setTimeout(interceptNav, 500);
    setTimeout(interceptNav, 1500);
  }
})();

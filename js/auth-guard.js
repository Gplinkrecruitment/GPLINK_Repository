(function () {
  const pathname = window.location.pathname;
  const isSignInPage = pathname === "/pages/signin.html";
  const isPublicPage =
    isSignInPage ||
    pathname === "/pages/privacy.html" ||
    pathname === "/pages/terms.html";

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
    if (!ALLOWED_REVIEW_PAGES.includes(pathname)) {
      enforceRestrictedUI();
    }
  }

  sessionPromise.then((session) => {
    if (session && session.ok) {
      window.gpSessionProfile = session.profile || null;

      if (isSignInPage) {
        window.location.replace("/pages/index.html");
        return;
      }

      // Check account status from server
      fetch("/api/account/status", { credentials: "same-origin" })
        .then((r) => r.json())
        .then((statusData) => {
          if (statusData && statusData.accountStatus === "under_review") {
            localStorage.setItem("gp_account_under_review", "true");
            if (!ALLOWED_REVIEW_PAGES.includes(pathname)) {
              enforceRestrictedUI();
            }
          } else {
            localStorage.removeItem("gp_account_under_review");
          }
        })
        .catch(() => {});

      return;
    }
    if (!isPublicPage && !isOnboardingPage) {
      window.location.replace("/pages/signin.html");
    }
  });

  function enforceRestrictedUI() {
    // Block navigation to restricted pages
    // Show lock overlay on nav items and intercept clicks
    document.addEventListener("DOMContentLoaded", injectRestrictionUI);
    if (document.readyState !== "loading") injectRestrictionUI();
  }

  var restrictionInjected = false;
  function injectRestrictionUI() {
    if (restrictionInjected) return;
    restrictionInjected = true;

    // Create review popup modal
    var popupId = "gpReviewPopup";
    var popup = document.createElement("div");
    popup.id = popupId;
    popup.style.cssText = "position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);padding:20px;";
    popup.innerHTML =
      '<div style="background:#fff;border-radius:20px;padding:32px 24px;max-width:340px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.15);">' +
        '<div style="width:56px;height:56px;border-radius:50%;background:#fef3c7;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">' +
          '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
        '</div>' +
        '<h3 style="font-size:18px;font-weight:800;color:#0f172a;margin:0 0 10px;">Account Under Review</h3>' +
        '<p style="font-size:14px;color:#64748b;line-height:1.5;margin:0 0 20px;">Your account is currently undergoing manual verification. Our team will contact you via email to verify your qualifications and resume full access.</p>' +
        '<button id="gpReviewPopupClose" type="button" style="width:100%;padding:12px;border:none;border-radius:12px;background:#0f172a;color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;">OK</button>' +
      '</div>';
    document.body.appendChild(popup);

    document.getElementById("gpReviewPopupClose").addEventListener("click", function () {
      popup.style.display = "none";
    });
    popup.addEventListener("click", function (e) {
      if (e.target === popup) popup.style.display = "none";
    });

    function showReviewPopup(e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      popup.style.display = "flex";
    }

    // Blur everything below the registration steps task list on the home page
    function blurDashboardContent() {
      var taskList = document.getElementById("taskList");
      if (!taskList) return;
      // Blur all siblings after the task list
      var sibling = taskList.nextElementSibling;
      while (sibling) {
        // Keep the help card visible
        if (!sibling.classList.contains("help-card")) {
          sibling.style.filter = "blur(6px)";
          sibling.style.pointerEvents = "none";
          sibling.style.userSelect = "none";
        }
        sibling = sibling.nextElementSibling;
      }
      // Also blur the task list items themselves (they link to other pages)
      taskList.querySelectorAll("a.task-item").forEach(function (a) {
        a.style.filter = "blur(4px)";
        a.style.pointerEvents = "none";
      });
    }

    // Intercept all nav links and buttons that go to restricted pages
    function interceptNav() {
      // Bottom nav links
      document.querySelectorAll("a.bottom-tab, a.mobile-tab, .sidebar a, nav a").forEach(function (a) {
        var href = a.getAttribute("href") || "";
        var target = href.replace(/^\.?\/?/, "/").replace(/^([^/])/, "/pages/$1");
        var isAllowed = ALLOWED_REVIEW_PAGES.includes(target) || target === pathname;
        if (!isAllowed) {
          a.style.opacity = "0.4";
          a.style.pointerEvents = "none";
          a.addEventListener("click", showReviewPopup, true);
          // Re-enable pointer events so click fires but is intercepted
          a.style.pointerEvents = "auto";
        }
      });

      // Bottom tab buttons (like Registration, Messages, Scan)
      document.querySelectorAll("button.bottom-tab, button.mobile-tab").forEach(function (btn) {
        var label = (btn.textContent || "").trim().toLowerCase();
        // Allow Home and Account tabs only
        if (label !== "account" && label !== "home") {
          btn.style.opacity = "0.4";
          btn.addEventListener("click", showReviewPopup, true);
        }
      });

      // Lock scan trigger
      document.querySelectorAll("[data-qual-scan-trigger]").forEach(function (el) {
        el.style.opacity = "0.4";
        el.addEventListener("click", showReviewPopup, true);
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
        }
      });

      // Blur dashboard content on home page
      if (pathname === "/pages/index.html") {
        blurDashboardContent();
      }
    }

    // Run now and after a delay (for dynamically loaded content)
    interceptNav();
    setTimeout(interceptNav, 500);
    setTimeout(interceptNav, 1500);
  }
})();

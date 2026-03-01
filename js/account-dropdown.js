(function () {
  if (typeof document === "undefined") return;

  var STYLE_ID = "gp-account-dropdown-style";

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      ".account-nav-wrap{position:relative;display:inline-flex;align-items:center;}",
      ".account-nav-wrap::after{content:'';position:absolute;left:0;right:0;top:100%;height:14px;}",
      ".account-nav-dropdown{position:absolute;top:calc(100% + 2px);right:0;min-width:178px;padding:8px;border-radius:12px;background:var(--glass-bg,rgba(255,255,255,.58));border:1px solid var(--glass-border,rgba(191,220,255,.95));box-shadow:var(--glass-shadow,inset 0 1px 0 rgba(255,255,255,.85),0 10px 16px -14px rgba(37,99,235,.45)),0 14px 26px -18px rgba(15,23,42,.45);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);display:grid;gap:6px;opacity:0;transform:translateY(4px);pointer-events:none;transition:opacity .14s ease,transform .14s ease;z-index:35;}",
      ".account-nav-wrap:hover .account-nav-dropdown,.account-nav-wrap:focus-within .account-nav-dropdown,.account-nav-wrap.gp-open .account-nav-dropdown{opacity:1;transform:translateY(0);pointer-events:auto;}",
      ".account-nav-entry,.account-nav-signout{width:100%;border:1px solid rgba(191,220,255,.95);background:rgba(255,255,255,.82);border-radius:10px;padding:8px 10px;font:inherit;font-size:12px;font-weight:760;line-height:1.2;text-align:left;color:#0f172a;cursor:pointer;text-decoration:none;display:flex;align-items:center;justify-content:flex-start;}",
      ".account-nav-entry:hover,.account-nav-signout:hover{background:rgba(239,246,255,.92);border-color:rgba(147,197,253,.95);}",
      ".account-nav-signout{color:#9f1239;}",
      ".account-nav-signout:hover{background:rgba(255,241,242,.9);border-color:rgba(251,113,133,.7);}"
    ].join("");
    document.head.appendChild(style);
  }

  function buildDropdown(accountLink) {
    var wrap = document.createElement("div");
    wrap.className = "account-nav-wrap";

    accountLink.parentNode.insertBefore(wrap, accountLink);
    wrap.appendChild(accountLink);

    var dropdown = document.createElement("div");
    dropdown.className = "account-nav-dropdown";
    dropdown.setAttribute("aria-label", "Account menu");

    var details = document.createElement("a");
    details.className = "account-nav-entry";
    details.href = "account.html";
    details.textContent = "Details";

    var signOutBtn = document.createElement("button");
    signOutBtn.className = "account-nav-signout";
    signOutBtn.type = "button";
    signOutBtn.textContent = "Sign Out";
    signOutBtn.addEventListener("click", async function () {
      signOutBtn.disabled = true;
      try {
        await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
      } catch (err) {
        // Redirect regardless to ensure session is cleared via server route.
      } finally {
        window.location.href = "/logout";
      }
    });

    dropdown.appendChild(details);
    dropdown.appendChild(signOutBtn);
    wrap.appendChild(dropdown);

    function moveGlassTo(target, animate) {
      if (!target) return;
      var navMenu = target.closest(".nav-menu");
      if (!navMenu) return;
      var navGlass = navMenu.querySelector(".nav-glass");
      if (!navGlass) return;
      var targetRect = target.getBoundingClientRect();
      var menuRect = navMenu.getBoundingClientRect();
      if (animate) {
        navGlass.style.transitionDuration = "";
      } else {
        navGlass.style.transitionDuration = "0ms";
      }
      navGlass.style.left = (targetRect.left - menuRect.left) + "px";
      navGlass.style.top = (targetRect.top - menuRect.top) + "px";
      navGlass.style.width = targetRect.width + "px";
      navGlass.style.height = targetRect.height + "px";
      if (!animate) {
        requestAnimationFrame(function () {
          navGlass.style.transitionDuration = "";
        });
      }
    }

    function restoreActiveGlass() {
      var navMenu = accountLink.closest(".nav-menu");
      if (!navMenu) return;
      var isAccountPage = /\/pages\/account\.html$/.test(window.location.pathname || "");
      if (isAccountPage) {
        moveGlassTo(accountLink, true);
        return;
      }
      var active = navMenu.querySelector(".nav-item.active");
      moveGlassTo(active || accountLink, true);
    }

    function isDropdownActive() {
      return wrap.classList.contains("gp-open") || wrap.matches(":hover") || dropdown.matches(":hover") || wrap.contains(document.activeElement);
    }

    var closeTimer = null;
    var lockRaf = 0;

    function startGlassLock() {
      if (lockRaf) return;
      var tick = function () {
        if (!isDropdownActive()) {
          lockRaf = 0;
          return;
        }
        moveGlassTo(accountLink, false);
        lockRaf = window.requestAnimationFrame(tick);
      };
      tick();
    }

    function stopGlassLock() {
      if (!lockRaf) return;
      window.cancelAnimationFrame(lockRaf);
      lockRaf = 0;
    }

    function setOpen(open) {
      if (open) {
        if (closeTimer) {
          clearTimeout(closeTimer);
          closeTimer = null;
        }
        wrap.classList.add("gp-open");
        moveGlassTo(accountLink, true);
        startGlassLock();
        return;
      }
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(function () {
        closeTimer = null;
        if (wrap.matches(":hover") || wrap.contains(document.activeElement)) return;
        wrap.classList.remove("gp-open");
        stopGlassLock();
        restoreActiveGlass();
      }, 160);
    }

    wrap.addEventListener("mouseenter", function () { setOpen(true); });
    wrap.addEventListener("focusin", function () { setOpen(true); });
    wrap.addEventListener("mouseleave", function () { setOpen(false); });
    wrap.addEventListener("focusout", function () {
      setTimeout(function () {
        if (!wrap.contains(document.activeElement)) setOpen(false);
      }, 0);
    });

    // Prevent page-level nav mouseleave handlers from pulling glass away
    // while cursor is moving between Account and its dropdown panel.
    var navMenu = accountLink.closest(".nav-menu");
    if (navMenu) {
      navMenu.addEventListener("mouseenter", function (event) {
        if (!isDropdownActive()) return;
        event.stopImmediatePropagation();
        moveGlassTo(accountLink, true);
      }, true);
      navMenu.addEventListener("mousemove", function (event) {
        if (!isDropdownActive()) return;
        event.stopImmediatePropagation();
        moveGlassTo(accountLink, true);
      }, true);
      navMenu.addEventListener("mouseleave", function (event) {
        if (!isDropdownActive()) return;
        event.stopImmediatePropagation();
        moveGlassTo(accountLink, true);
      }, true);
    }

    if (/\/pages\/account\.html$/.test(window.location.pathname || "")) {
      requestAnimationFrame(function () {
        moveGlassTo(accountLink, false);
      });
    }
  }

  function init() {
    ensureStyles();
    var accountLinks = Array.prototype.slice.call(document.querySelectorAll(".nav-menu .account-pill"));
    accountLinks.forEach(function (accountLink) {
      if (!accountLink || !accountLink.parentNode) return;
      if (accountLink.closest(".account-nav-wrap")) return;
      buildDropdown(accountLink);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  var APP_SHELL_PATH = "/pages/app-shell";
  var EMBED_PARAM = "gp_shell";
  var EMBED_VALUE = "embedded";
  var STATIC_PARAM = "gp_shell_static";
  var EMBED_STYLE_ID = "gp-shell-embedded-style";
  var EMBEDDED_CHROME_HIDE_CSS = "html.gp-shell-embedded .desktop-topbar,html.gp-shell-embedded .topbar,html.gp-shell-embedded .mobile-nav,html.gp-shell-embedded .nav-menu,html.gp-shell-embedded .brand-logo,html.gp-shell-embedded .app-shell-desktop,html.gp-shell-embedded #appShellDesktop{display:none!important;}";
  var PAGE_PATHS = {
    "/pages/index": true,
    "/pages/myinthealth": true,
    "/pages/amc": true,
    "/pages/ahpra": true,
    "/pages/my-documents": true,
    "/pages/career": true,
    "/pages/visa": true,
    "/pages/pbs": true,
    "/pages/commencement": true,
    "/pages/messages": true,
    "/pages/account": true,
    "/pages/registration-intro": true,
    "/pages/application-detail": true,
    "/pages/job": true,
    "/pages/interview-prep": true,
    "/pages/offer-review": true,
    "/pages/area-guide": true
  };

  function normalizePath(pathname) {
    if (typeof pathname !== "string" || !pathname) return "";
    try {
      var normalized = new URL(pathname, window.location.origin).pathname;
      if (/^\/pages\/[^/]+\.html$/i.test(normalized)) {
        normalized = normalized.slice(0, -5);
      }
      return normalized;
    } catch (err) {
      return pathname;
    }
  }

  function resolveSupportedPath(pathname) {
    var normalized = normalizePath(pathname);
    if (Object.prototype.hasOwnProperty.call(PAGE_PATHS, normalized)) return normalized;

    var parts = normalized.split("/").filter(Boolean);
    if (parts.length < 2 || parts[0] !== "registration") return "";

    var step = String(parts[1] || "").toLowerCase();
    if (step === "myintealth" || step === "myinthealth") return "/pages/myinthealth";
    if (step === "amc") return "/pages/amc";
    if (step === "ahpra" || step === "specialist-registration") return "/pages/ahpra";
    if (step === "visa") return "/pages/visa";
    if (step === "pbs" || step === "medicare") return "/pages/pbs";
    if (step === "commencement") return "/pages/commencement";
    return "";
  }

  function isSupportedPath(pathname) {
    return !!resolveSupportedPath(pathname);
  }

  function getEventElement(target) {
    if (target instanceof Element) return target;
    if (target && target.nodeType === 3 && target.parentElement) return target.parentElement;
    return null;
  }

  function toRouteUrl(input) {
    try {
      var url = input instanceof URL ? new URL(input.toString()) : new URL(String(input || ""), window.location.href);
      var resolvedPath = "";
      if (url.origin !== window.location.origin) return null;
      resolvedPath = resolveSupportedPath(url.pathname);
      if (!resolvedPath) return null;
      url.pathname = resolvedPath;
      url.searchParams.delete(EMBED_PARAM);
      url.searchParams.delete(STATIC_PARAM);
      return url;
    } catch (err) {
      return null;
    }
  }

  function cleanRoute(input) {
    var url = input instanceof URL ? new URL(input.toString()) : new URL(String(input || window.location.href), window.location.href);
    var resolvedPath = resolveSupportedPath(url.pathname);
    if (resolvedPath) url.pathname = resolvedPath;
    url.searchParams.delete(EMBED_PARAM);
    url.searchParams.delete(STATIC_PARAM);
    return url.pathname + url.search + url.hash;
  }

  function getLinkRouteTarget(link) {
    if (!link) return "";
    return link.getAttribute("data-route") || link.getAttribute("href") || "";
  }

  function isReviewRestricted() {
    try {
      return localStorage.getItem("gp_account_under_review") === "true";
    } catch (err) {
      return false;
    }
  }

  function isSameChildRoute(routeUrl) {
    var currentUrl = new URL(window.location.href);
    currentUrl.searchParams.delete(EMBED_PARAM);
    currentUrl.searchParams.delete(STATIC_PARAM);
    return normalizePath(currentUrl.pathname) === normalizePath(routeUrl.pathname) &&
      currentUrl.search === routeUrl.search;
  }

  function postRouteToParent(routeUrl) {
    if (window.parent === window || !window.parent || typeof window.parent.postMessage !== "function") return false;
    try {
      window.parent.postMessage({
        type: "gp-shell-route",
        intent: "navigate",
        href: cleanRoute(routeUrl),
        title: document.title || ""
      }, window.location.origin);
      return true;
    } catch (err) {
      return false;
    }
  }

  function getParentMobileNavClearance() {
    try {
      if (window.parent === window || !window.parent || !window.parent.document) return 0;
      var parentNav = window.parent.document.querySelector(".mobile-nav");
      if (!parentNav) return 0;
      var style = window.parent.getComputedStyle(parentNav);
      if (style.display === "none" || style.visibility === "hidden" || parentNav.getClientRects().length === 0) {
        return 0;
      }
      return Math.max(0, Math.ceil(window.parent.innerHeight - parentNav.getBoundingClientRect().top));
    } catch (err) {
      return 0;
    }
  }

  function injectEmbeddedStyles() {
    var style = document.getElementById(EMBED_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = EMBED_STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    var bottomClearance = getParentMobileNavClearance();
    style.textContent = [
      ":root{--gp-shell-bottom-clearance:" + bottomClearance + "px;}",
      EMBEDDED_CHROME_HIDE_CSS,
      "html.gp-shell-embedded .dash-wrap{padding-bottom:32px!important;}",
      "html.gp-shell-embedded body{margin:0!important;overflow-x:hidden;padding-bottom:" + bottomClearance + "px!important;}"
    ].join("");
  }

  function setEmbeddedClass() {
    document.documentElement.classList.add("gp-shell-embedded");
    if (document.body) document.body.classList.add("gp-shell-embedded");
  }

  function notifyParent() {
    if (window.parent === window || !window.parent || typeof window.parent.postMessage !== "function") return;
    try {
      window.parent.postMessage({
        type: "gp-shell-route",
        intent: "sync",
        href: cleanRoute(window.location.href),
        title: document.title || ""
      }, window.location.origin);
    } catch (err) {
      // Best-effort sync only.
    }
  }

  function handleEmbeddedClick(event) {
    var clickTarget = getEventElement(event.target);
    var link = null;
    var rawTarget = "";
    var routeUrl = null;

    if (!clickTarget) return;
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    link = clickTarget.closest("a[href]");
    if (!link) return;
    if (link.target && link.target !== "_self") return;
    if (link.hasAttribute("download")) return;
    if (link.dataset && link.dataset.gpReviewBlocked) return;
    if (isReviewRestricted()) return;

    rawTarget = getLinkRouteTarget(link);
    if (!rawTarget || String(rawTarget).charAt(0) === "#") return;

    routeUrl = toRouteUrl(rawTarget);
    if (!routeUrl) return;
    if (isSameChildRoute(routeUrl)) return;

    event.preventDefault();
    event.stopPropagation();
    postRouteToParent(routeUrl);
  }

  function installEmbeddedBridge() {
    injectEmbeddedStyles();
    setEmbeddedClass();

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", setEmbeddedClass, { once: true });
      document.addEventListener("DOMContentLoaded", injectEmbeddedStyles, { once: true });
      document.addEventListener("DOMContentLoaded", notifyParent, { once: true });
    } else {
      notifyParent();
    }

    var originalPushState = history.pushState.bind(history);
    var originalReplaceState = history.replaceState.bind(history);

    history.pushState = function patchedPushState(state, title, url) {
      var result = originalPushState(state, title, url);
      notifyParent();
      return result;
    };

    history.replaceState = function patchedReplaceState(state, title, url) {
      var result = originalReplaceState(state, title, url);
      notifyParent();
      return result;
    };

    window.addEventListener("hashchange", notifyParent);
    window.addEventListener("popstate", notifyParent);
    window.addEventListener("pageshow", notifyParent);
    window.addEventListener("resize", injectEmbeddedStyles);
    window.addEventListener("pageshow", injectEmbeddedStyles);
    document.addEventListener("click", handleEmbeddedClick, true);
  }

  var currentUrl = new URL(window.location.href);
  var currentPath = normalizePath(currentUrl.pathname);
  if (!isSupportedPath(currentPath)) return;

  var isEmbedded = currentUrl.searchParams.get(EMBED_PARAM) === EMBED_VALUE;
  var isIframe = window.self !== window.top;

  if (isEmbedded || isIframe) {
    // Apply embedded class immediately to prevent nav flash
    setEmbeddedClass();
    injectEmbeddedStyles();
    installEmbeddedBridge();
    return;
  }

  // Hide page content immediately during redirect to prevent nav flash
  document.documentElement.style.visibility = "hidden";
  var shellUrl = new URL(APP_SHELL_PATH, currentUrl.origin);
  shellUrl.searchParams.set("route", cleanRoute(currentUrl));
  window.location.replace(shellUrl.toString());
})();

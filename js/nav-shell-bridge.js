(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  var APP_SHELL_PATH = "/pages/app-shell.html";
  var EMBED_PARAM = "gp_shell";
  var EMBED_VALUE = "embedded";
  var EMBED_STYLE_ID = "gp-shell-embedded-style";
  var PAGE_PATHS = {
    "/pages/index.html": true,
    "/pages/myinthealth.html": true,
    "/pages/amc.html": true,
    "/pages/ahpra.html": true,
    "/pages/my-documents.html": true,
    "/pages/career.html": true,
    "/pages/messages.html": true,
    "/pages/account.html": true
  };

  function normalizePath(pathname) {
    if (typeof pathname !== "string" || !pathname) return "";
    try {
      return new URL(pathname, window.location.origin).pathname;
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
    if (step === "myintealth" || step === "myinthealth") return "/pages/myinthealth.html";
    if (step === "amc") return "/pages/amc.html";
    if (step === "ahpra" || step === "specialist-registration") return "/pages/ahpra.html";
    return "";
  }

  function isSupportedPath(pathname) {
    return !!resolveSupportedPath(pathname);
  }

  function cleanRoute(input) {
    var url = input instanceof URL ? new URL(input.toString()) : new URL(String(input || window.location.href), window.location.origin);
    url.searchParams.delete(EMBED_PARAM);
    return url.pathname + url.search + url.hash;
  }

  function injectEmbeddedStyles() {
    if (document.getElementById(EMBED_STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = EMBED_STYLE_ID;
    style.textContent = [
      "html.gp-shell-embedded .desktop-topbar,",
      "html.gp-shell-embedded .topbar,",
      "html.gp-shell-embedded .mobile-nav{display:none!important;}",
      "html.gp-shell-embedded .shell,",
      "html.gp-shell-embedded .dash-wrap{padding-bottom:32px!important;}",
      "html.gp-shell-embedded body{overflow-x:hidden;}"
    ].join("");
    document.head.appendChild(style);
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
        href: cleanRoute(window.location.href),
        title: document.title || ""
      }, window.location.origin);
    } catch (err) {
      // Best-effort sync only.
    }
  }

  function installEmbeddedBridge() {
    injectEmbeddedStyles();
    setEmbeddedClass();

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", setEmbeddedClass, { once: true });
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
  }

  var currentUrl = new URL(window.location.href);
  var currentPath = normalizePath(currentUrl.pathname);
  if (!isSupportedPath(currentPath)) return;

  var isEmbedded = currentUrl.searchParams.get(EMBED_PARAM) === EMBED_VALUE;
  var isIframe = window.self !== window.top;

  if (isEmbedded || isIframe) {
    installEmbeddedBridge();
    return;
  }

  var shellUrl = new URL(APP_SHELL_PATH, currentUrl.origin);
  shellUrl.searchParams.set("route", cleanRoute(currentUrl));
  window.location.replace(shellUrl.toString());
})();

(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  var EMBED_PARAM = "gp_shell";
  var EMBED_VALUE = "embedded";
  var DEFAULT_ROUTE = "/pages/index.html";
  var PAGE_PATHS = {
    "/pages/index.html": true,
    "/pages/myinthealth.html": true,
    "/pages/amc.html": true,
    "/pages/ahpra.html": true,
    "/pages/my-documents.html": true,
    "/pages/career.html": true,
    "/pages/messages.html": true,
    "/pages/account.html": true,
    "/pages/registration-intro.html": true
  };
  var NAV_GROUPS = {
    "/pages/index.html": { desktop: "home", mobile: "/pages/index.html" },
    "/pages/registration-intro.html": { desktop: "registration", mobile: "/pages/registration-intro.html" },
    "/pages/myinthealth.html": { desktop: "registration", mobile: "/pages/myinthealth.html" },
    "/pages/amc.html": { desktop: "registration", mobile: "/pages/myinthealth.html" },
    "/pages/ahpra.html": { desktop: "registration", mobile: "/pages/myinthealth.html" },
    "/pages/my-documents.html": { desktop: "documents", mobile: "/pages/myinthealth.html" },
    "/pages/career.html": { desktop: "career", mobile: "/pages/career.html" },
    "/pages/messages.html": { desktop: "messages", mobile: "/pages/index.html" },
    "/pages/account.html": { desktop: "account", mobile: "/pages/account.html" }
  };

  var frameEl = document.getElementById("appShellFrame");
  var loaderEl = document.getElementById("appShellLoader");
  var desktopNavEl = document.querySelector(".nav-menu");
  var mobileNavEl = document.querySelector(".mobile-nav");
  var navGlassEl = document.getElementById("navGlass");
  var mobileNavGlassEl = document.getElementById("mobileNavGlass");
  var desktopHostEl = document.getElementById("appShellDesktop");
  var EMBED_STYLE_ID = "gp-shell-parent-embed-style";
  var currentRoute = "";
  var activeDesktopItem = null;
  var activeMobileTab = null;
  var hoveredDesktopItem = null;
  var navGlassInitialized = false;
  var mobileGlassInitialized = false;

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

  function routeFromUrl(input) {
    var url = input instanceof URL ? new URL(input.toString()) : new URL(String(input || DEFAULT_ROUTE), window.location.href);
    url.searchParams.delete(EMBED_PARAM);
    return url.pathname + url.search + url.hash;
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

  function updateFrameOffsets() {
    var topOffset = 0;
    var navClearance = 0;

    if (desktopHostEl && isVisible(desktopHostEl)) {
      topOffset = Math.ceil(desktopHostEl.getBoundingClientRect().bottom + 8);
    }

    navClearance = getMobileNavClearance();

    document.documentElement.style.setProperty("--app-shell-top-offset", Math.max(topOffset, 0) + "px");
    document.documentElement.style.setProperty("--app-shell-bottom-offset", "0px");
    document.documentElement.style.setProperty("--app-shell-nav-clearance", navClearance + "px");
  }

  function moveNavGlass(target, animate) {
    if (!target || !navGlassEl || !desktopNavEl || !isVisible(target)) return;
    var parentRect = desktopNavEl.getBoundingClientRect();
    var rect = target.getBoundingClientRect();
    if (animate === false || !navGlassInitialized) {
      var previousTransition = navGlassEl.style.transition;
      navGlassEl.style.transition = "none";
      navGlassEl.style.left = (rect.left - parentRect.left) + "px";
      navGlassEl.style.top = (rect.top - parentRect.top) + "px";
      navGlassEl.style.width = rect.width + "px";
      navGlassEl.style.height = rect.height + "px";
      void navGlassEl.offsetWidth;
      navGlassEl.style.transition = previousTransition;
      navGlassInitialized = true;
      return;
    }
    navGlassEl.style.left = (rect.left - parentRect.left) + "px";
    navGlassEl.style.top = (rect.top - parentRect.top) + "px";
    navGlassEl.style.width = rect.width + "px";
    navGlassEl.style.height = rect.height + "px";
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
      "html.gp-shell-embedded .desktop-topbar,html.gp-shell-embedded .topbar,html.gp-shell-embedded .mobile-nav{display:none!important;}",
      "html.gp-shell-embedded .dash-wrap{padding-bottom:32px!important;}",
      "html.gp-shell-embedded body{overflow-x:hidden;padding-bottom:" + bottomClearance + "px!important;}"
    ].join("");
  }

  function navigateTo(input, options) {
    var routeUrl = toRouteUrl(input);
    var opts = options || {};

    if (!routeUrl) {
      if (typeof input === "string" && input) window.location.href = input;
      return;
    }

    var route = routeFromUrl(routeUrl);
    var embeddedRoute = toEmbeddedRoute(routeUrl);
    if (!embeddedRoute) return;

    if (route === currentRoute && frameEl.getAttribute("src") === embeddedRoute) {
      if (opts.historyMode === "replace" && window.location.pathname + window.location.search + window.location.hash !== route) {
        history.replaceState({ route: route }, "", route);
      }
      return;
    }

    currentRoute = route;
    syncActiveNav(routeUrl, opts.animate !== false);
    setLoading(true);

    if (opts.historyMode === "push") {
      history.pushState({ route: route }, "", route);
    } else if (opts.historyMode === "replace") {
      history.replaceState({ route: route }, "", route);
    }

    if (frameEl.getAttribute("src") !== embeddedRoute) {
      frameEl.setAttribute("src", embeddedRoute);
    }
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

  function handleDocumentClick(event) {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!(event.target instanceof Element)) return;

    var link = event.target.closest("a[href]");
    if (!link) return;
    if (link.target && link.target !== "_self") return;
    if (link.hasAttribute("download")) return;

    var routeUrl = toRouteUrl(getLinkRouteTarget(link));
    if (!routeUrl) return;

    event.preventDefault();
    navigateTo(routeUrl, { historyMode: "push" });
  }

  function handleDesktopHoverEvents() {
    if (!desktopNavEl) return;

    getDesktopItems().forEach(function (item) {
      item.addEventListener("mouseenter", function () {
        hoveredDesktopItem = item;
        moveNavGlass(item, true);
      });
      item.addEventListener("focus", function () {
        hoveredDesktopItem = item;
        moveNavGlass(item, true);
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
      if (activeDesktopItem) moveNavGlass(activeDesktopItem, true);
    });
  }

  function syncFromChildRoute(input, nextTitle) {
    var routeUrl = toRouteUrl(input);
    if (!routeUrl) return;
    currentRoute = routeFromUrl(routeUrl);
    syncActiveNav(routeUrl, false);
    if (window.location.pathname + window.location.search + window.location.hash !== currentRoute) {
      history.replaceState({ route: currentRoute }, "", currentRoute);
    }
    updateTitle(nextTitle);
  }

  function handleResize() {
    updateFrameOffsets();
    try {
      if (frameEl && frameEl.contentDocument) enforceEmbeddedChrome(frameEl.contentDocument);
    } catch (err) {
      // Ignore same-origin race conditions during frame resize.
    }
    if (activeDesktopItem) moveNavGlass(activeDesktopItem, false);
    if (activeMobileTab) moveMobileGlass(activeMobileTab, false);
  }

  function handleFrameLoad() {
    setLoading(false);
    updateFrameOffsets();

    try {
      var childHref = frameEl.contentWindow.location.href;
      var childUrl = new URL(childHref);
      var childPath = normalizePath(childUrl.pathname);
      var childDoc = frameEl.contentDocument;

      enforceEmbeddedChrome(childDoc);

      if (!isSupportedPath(childPath)) {
        childUrl.searchParams.delete(EMBED_PARAM);
        window.location.replace(childUrl.pathname + childUrl.search + childUrl.hash);
        return;
      }

      syncFromChildRoute(childUrl, childDoc ? childDoc.title : "");
    } catch (err) {
      // Same-origin access is expected; ignore transient load errors.
    }
  }

  function handleMessage(event) {
    if (event.origin !== window.location.origin) return;
    if (!event.data || event.data.type !== "gp-shell-route") return;
    syncFromChildRoute(event.data.href, event.data.title);
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
    if (!frameEl) return;

    window.gpShellNavigate = function (route, options) {
      var opts = options || {};
      navigateTo(route, {
        historyMode: opts.replace ? "replace" : "push",
        animate: opts.animate
      });
    };

    document.addEventListener("click", handleDocumentClick);
    frameEl.addEventListener("load", handleFrameLoad);
    window.addEventListener("message", handleMessage);
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("resize", handleResize);

    handleDesktopHoverEvents();
    prefetchSupportedRoutes();

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

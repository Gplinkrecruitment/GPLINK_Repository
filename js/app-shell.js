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
  var SESSION_PROFILE_CACHE_KEY = "gp_session_profile_cache";
  var SESSION_OWNER_KEY = "gp_state_owner";
  var REGISTRATION_INTRO_ALWAYS_EMAILS = {
    "hello@mygplink.com.au": true
  };
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
    "/pages/registration-intro.html": { desktop: "registration", mobile: "/pages/myinthealth.html" },
    "/pages/myinthealth.html": { desktop: "registration", mobile: "/pages/myinthealth.html" },
    "/pages/amc.html": { desktop: "registration", mobile: "/pages/myinthealth.html" },
    "/pages/ahpra.html": { desktop: "registration", mobile: "/pages/myinthealth.html" },
    "/pages/my-documents.html": { desktop: "documents", mobile: "/pages/myinthealth.html" },
    "/pages/career.html": { desktop: "career", mobile: "/pages/career.html" },
    "/pages/messages.html": { desktop: "messages", mobile: "/pages/index.html" },
    "/pages/account.html": { desktop: "account", mobile: "/pages/account.html" }
  };

  var frameEls = Array.prototype.slice.call(document.querySelectorAll(".app-shell-frame"));
  var loaderEl = document.getElementById("appShellLoader");
  var desktopNavEl = document.querySelector(".nav-menu");
  var mobileNavEl = document.querySelector(".mobile-nav");
  var navGlassEl = document.getElementById("navGlass");
  var mobileNavGlassEl = document.getElementById("mobileNavGlass");
  var desktopHostEl = document.getElementById("appShellDesktop");
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
    if (resolveSupportedPath(routeUrl.pathname) !== REGISTRATION_ENTRY_ROUTE) return false;
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

  function handleRouteWarmIntent(event) {
    var target = event.target;
    var link = null;

    if (!(target instanceof Element)) return;

    link = target.closest("a[href]");
    if (!link) return;
    if (link.target && link.target !== "_self") return;
    if (link.hasAttribute("download")) return;

    warmRoute(getLinkRouteTarget(link));
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
    if (activeDesktopItem) moveNavGlass(activeDesktopItem, false);
    if (activeMobileTab) moveMobileGlass(activeMobileTab, false);
  }

  function handleFrameLoad(event) {
    var frame = event && event.currentTarget;
    var frameState = getFrameState(frame);

    try {
      var childHref = frame.contentWindow.location.href;
      var childUrl = new URL(childHref);
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

      if (pendingNavigation && pendingNavigation.route === nextRoute) {
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
    frameEls.forEach(function (frame) {
      frame.addEventListener("load", handleFrameLoad);
      getFrameState(frame);
    });
    window.addEventListener("message", handleMessage);
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("resize", handleResize);

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

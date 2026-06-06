(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  var SW_URL = "/sw.js";
  var SW_SCOPE = "/";
  var WARM_MESSAGE = "GP_CACHE_URLS";
  var DEFAULT_WARM_URLS = [
    "/pages/index?gp_shell=embedded&gp_shell_static=1",
    "/js/app-shell.js?v=20260607b",
    "/js/native-bridge.js?v=20260517a",
    "/js/nav-shell-bridge.js?v=20260516a",
    "/js/auth-guard.js?v=20260528a",
    "/js/state-sync.js?v=20260607a",
    "/js/updates-sync.js?v=20260516a",
    "/js/account-dropdown.js?v=20260516a"
  ];
  var warmedUrls = Object.create(null);
  var registrationPromise = null;

  function scheduleIdle(fn, timeout) {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(fn, { timeout: timeout || 1800 });
      return;
    }
    window.setTimeout(fn, 80);
  }

  function sameOriginUrl(value) {
    try {
      var url = new URL(String(value || ""), window.location.origin);
      return url.origin === window.location.origin ? url : null;
    } catch (err) {
      return null;
    }
  }

  function uniqueSameOriginUrls(urls) {
    var list = Array.isArray(urls) ? urls : [];
    var out = [];
    list.forEach(function (value) {
      var url = sameOriginUrl(value);
      if (!url) return;
      var href = url.pathname + url.search + url.hash;
      if (warmedUrls[href]) return;
      warmedUrls[href] = true;
      out.push(href);
    });
    return out;
  }

  function postWarmMessage(urls) {
    var cleaned = Array.isArray(urls) ? urls : [];
    if (!cleaned.length || !navigator.serviceWorker) return;

    var send = function (target) {
      try {
        if (target && typeof target.postMessage === "function") {
          target.postMessage({ type: WARM_MESSAGE, urls: cleaned });
        }
      } catch (err) {}
    };

    if (navigator.serviceWorker.controller) {
      send(navigator.serviceWorker.controller);
      return;
    }

    getRegistration().then(function (registration) {
      send(registration && (registration.active || registration.waiting || registration.installing));
    }).catch(function () {});
  }

  function linkPrefetch(urls) {
    (Array.isArray(urls) ? urls : []).forEach(function (href) {
      var id = "gp-perf-prefetch-" + href.replace(/[^a-z0-9]/gi, "-");
      if (document.getElementById(id)) return;
      var link = document.createElement("link");
      link.id = id;
      link.rel = "prefetch";
      link.href = href;
      document.head.appendChild(link);
    });
  }

  function warmFetch(urls) {
    var cleaned = uniqueSameOriginUrls(urls);
    if (!cleaned.length || typeof window.fetch !== "function") return;
    scheduleIdle(function () {
      cleaned.forEach(function (href) {
        try {
          window.fetch(href, {
            method: "GET",
            credentials: "same-origin",
            cache: "force-cache",
            priority: "low"
          }).catch(function () {});
        } catch (err) {}
      });
    }, 2200);
  }

  function warmUrls(urls) {
    var cleaned = uniqueSameOriginUrls(urls);
    if (!cleaned.length) return;
    linkPrefetch(cleaned);
    postWarmMessage(cleaned);
  }

  function getRegistration() {
    if (!("serviceWorker" in navigator)) return Promise.reject(new Error("service-worker-unavailable"));
    if (!registrationPromise) {
      registrationPromise = navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }).catch(function (err) {
        registrationPromise = null;
        throw err;
      });
    }
    return registrationPromise;
  }

  function register() {
    if (!("serviceWorker" in navigator)) return Promise.resolve(null);
    return getRegistration().then(function (registration) {
      scheduleIdle(function () {
        postWarmMessage(DEFAULT_WARM_URLS);
      }, 2400);
      return registration;
    }).catch(function () {
      return null;
    });
  }

  window.gpPerfCache = {
    register: register,
    warmUrls: warmUrls,
    warmFetch: warmFetch,
    scheduleIdle: scheduleIdle
  };

  window.addEventListener("load", function () {
    register();
  }, { once: true });
})();

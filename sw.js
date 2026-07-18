/* GP Link service worker: conservative static cache + offline fallback. */
(function () {
  "use strict";

  var VERSION = "20260718a";
  var STATIC_CACHE = "gp-link-static-" + VERSION;
  var PAGE_CACHE = "gp-link-pages-" + VERSION;
  var RUNTIME_CACHE = "gp-link-runtime-" + VERSION;
  var CACHE_NAMES = [STATIC_CACHE, PAGE_CACHE, RUNTIME_CACHE];
  // Offline/error path only: how long to give the network before a cached
  // page may answer a request that had no cache entry to serve instantly.
  var PAGE_TIMEOUT_MS = 4000;

  // Precache manifest. Page entries MUST be the extensionless embedded
  // variants the app shell actually requests ("/pages/career?gp_shell=…"):
  // the server 302-redirects "/pages/career.html" to the clean URL, redirected
  // responses are never cached (shouldCacheResponse), and an entry keyed under
  // the .html URL would not match the shell's requests anyway — the old .html
  // manifest precached NOTHING, so every page open paid a full network fetch.
  // JS busters must track what the pages currently ship with
  // (alerts-panel.test.js pins updates-sync structurally).
  var CORE_URLS = [
    "/pages/app-shell",
    "/pages/index?gp_shell=embedded&gp_shell_static=1",
    "/pages/myinthealth?gp_shell=embedded&gp_shell_static=1",
    "/pages/amc?gp_shell=embedded&gp_shell_static=1",
    "/pages/ahpra?gp_shell=embedded&gp_shell_static=1",
    "/pages/career?gp_shell=embedded&gp_shell_static=1",
    "/pages/visa?gp_shell=embedded&gp_shell_static=1",
    "/pages/pbs?gp_shell=embedded&gp_shell_static=1",
    "/pages/messages?gp_shell=embedded&gp_shell_static=1",
    "/pages/account?gp_shell=embedded&gp_shell_static=1",
    "/pages/my-documents?gp_shell=embedded&gp_shell_static=1",
    "/pages/registration-intro?gp_shell=embedded&gp_shell_static=1",
    "/pages/signin",
    "/js/app-shell.js?v=20260712e",
    "/js/nav-shell-bridge.js?v=20260608a",
    "/js/auth-guard.js?v=20260706a",
    "/js/state-sync.js?v=20260711a",
    "/js/bypass-config.js?v=20260702a",
    "/js/updates-sync.js?v=20260707b",
    "/js/qualification-scan.js?v=20260711b",
    "/js/qualification-camera.js?v=20260614a",
    "/js/account-dropdown.js?v=20260527a",
    "/js/onboarding.js?v=20260707b",
    "/js/error-reporter.js?v=20260527a",
    "/js/web-push.js?v=20260707a",
    "/js/gp-cache.js?v=20260707a",
    "/js/perf-cache.js?v=20260608a",
    "/js/journey-stages.js?v=20260711a",
    "/js/native-bridge.js?v=20260707a",
    "/js/match-popup.js?v=20260707b",
    "/js/gp-coach.js?v=20260711a",
    "/js/gp-walkthrough-state.js?v=20260711a",
    "/js/gp-walkthrough.js?v=20260711b",
    "/js/gp-walkthrough-shell.js?v=20260711b",
    "/js/document-prep.js?v=20260614a",
    "/js/career-home-card.js?v=20260709a"
  ];

  function toUrl(value) {
    try {
      return new URL(value, self.location.origin);
    } catch (err) {
      return null;
    }
  }

  function isSameOrigin(url) {
    return !!url && url.origin === self.location.origin;
  }

  function extensionOf(pathname) {
    var match = String(pathname || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? "." + match[1] : "";
  }

  function hasVersionParam(url) {
    return !!(url && url.searchParams && url.searchParams.has("v"));
  }

  function isPageDocument(request, url) {
    return request.mode === "navigate"
      || request.destination === "document"
      || (/^\/pages\/.+\.html$/i.test(url.pathname));
  }

  function isImmutableAsset(url) {
    if (!url) return false;
    var ext = extensionOf(url.pathname);
    if (url.pathname.indexOf("/media/") === 0 || url.pathname.indexOf("/documents/") === 0) return true;
    if (hasVersionParam(url) && [".js", ".css", ".json", ".svg"].indexOf(ext) !== -1) return true;
    return [".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg", ".ico", ".woff", ".woff2", ".pdf"].indexOf(ext) !== -1;
  }

  function isRuntimeStatic(url) {
    if (!url) return false;
    var ext = extensionOf(url.pathname);
    return [".js", ".css", ".json", ".svg"].indexOf(ext) !== -1;
  }

  function isSafeRuntimeApi(url) {
    if (!url) return false;
    return url.pathname === "/api/media-config";
  }

  function shouldCacheResponse(response) {
    if (!response || response.status !== 200) return false;
    if (response.redirected) return false;
    var cacheControl = response.headers.get("Cache-Control") || "";
    return !/\bno-store\b/i.test(cacheControl);
  }

  function putIfCacheable(cacheName, request, response) {
    if (!shouldCacheResponse(response)) return Promise.resolve(response);
    return caches.open(cacheName).then(function (cache) {
      return cache.put(request, response.clone()).then(function () {
        return response;
      });
    }).catch(function () {
      return response;
    });
  }

  function cacheFirst(request, cacheName) {
    return caches.match(request).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        return putIfCacheable(cacheName, request, response);
      });
    });
  }

  function networkFirst(request, cacheName, timeoutMs) {
    var timeoutId = 0;
    var timedFallback = new Promise(function (resolve) {
      timeoutId = setTimeout(function () {
        caches.match(request).then(function (cached) {
          if (cached) resolve(cached);
        });
      }, timeoutMs || PAGE_TIMEOUT_MS);
    });

    var network = fetch(request).then(function (response) {
      clearTimeout(timeoutId);
      return putIfCacheable(cacheName, request, response);
    }).catch(function () {
      clearTimeout(timeoutId);
      return caches.match(request).then(function (cached) {
        if (cached) return cached;
        throw new Error("network-and-cache-miss");
      });
    });

    return Promise.race([network, timedFallback]).then(function (response) {
      return response || network;
    });
  }

  function staleWhileRevalidate(request, cacheName) {
    var fetchPromise = fetch(request).then(function (response) {
      return putIfCacheable(cacheName, request, response);
    }).catch(function () {
      return null;
    });

    return caches.match(request).then(function (cached) {
      return cached || fetchPromise;
    }).then(function (response) {
      if (response) return response;
      return fetch(request);
    });
  }

  function warmUrls(urls) {
    if (!Array.isArray(urls) || !urls.length) return Promise.resolve();
    return caches.open(RUNTIME_CACHE).then(function (cache) {
      return Promise.all(urls.map(function (value) {
        var url = toUrl(value);
        if (!isSameOrigin(url)) return Promise.resolve();
        var request = new Request(url.toString(), {
          method: "GET",
          credentials: "same-origin",
          cache: "reload"
        });
        return fetch(request).then(function (response) {
          if (shouldCacheResponse(response)) return cache.put(request, response.clone());
          return null;
        }).catch(function () {});
      }));
    });
  }

  self.addEventListener("install", function (event) {
    event.waitUntil(
      caches.open(STATIC_CACHE).then(function (cache) {
        return Promise.all(CORE_URLS.map(function (url) {
          var request = new Request(url, { credentials: "same-origin" });
          return fetch(request).then(function (response) {
            if (shouldCacheResponse(response)) return cache.put(request, response.clone());
            return null;
          }).catch(function () {});
        }));
      }).then(function () {
        return self.skipWaiting();
      })
    );
  });

  self.addEventListener("activate", function (event) {
    event.waitUntil(
      caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (key) {
          return CACHE_NAMES.indexOf(key) === -1 ? caches.delete(key) : Promise.resolve();
        }));
      }).then(function () {
        return self.clients.claim();
      })
    );
  });

  self.addEventListener("message", function (event) {
    var data = event && event.data ? event.data : {};
    if (data.type === "GP_SKIP_WAITING") {
      self.skipWaiting();
      return;
    }
    if (data.type === "GP_CACHE_URLS") {
      event.waitUntil(warmUrls(data.urls || []));
    }
  });

  /* ── Web Push (VAPID) — Phase 6 J1 ── */
  var NOTIFICATION_ICON = "/media/icons/gp-link-icon-192.png";
  var DEFAULT_NOTIFICATION_URL = "/pages/app-shell.html";

  self.addEventListener("push", function (event) {
    var payload = {};
    try {
      payload = event.data ? event.data.json() : {};
    } catch (err) {
      payload = { body: event.data ? String(event.data.text() || "") : "" };
    }
    if (!payload || typeof payload !== "object") payload = {};
    var title = payload.title || "GP Link";
    var options = {
      body: payload.body || "",
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
      data: { url: payload.url || DEFAULT_NOTIFICATION_URL }
    };
    event.waitUntil(self.registration.showNotification(title, options));
  });

  self.addEventListener("notificationclick", function (event) {
    event.notification.close();
    var rawUrl = event.notification && event.notification.data && event.notification.data.url
      ? event.notification.data.url
      : DEFAULT_NOTIFICATION_URL;
    var target = toUrl(rawUrl);
    if (!isSameOrigin(target)) target = toUrl(DEFAULT_NOTIFICATION_URL);

    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windowClients) {
        for (var i = 0; i < windowClients.length; i++) {
          var client = windowClients[i];
          if (!isSameOrigin(toUrl(client.url))) continue;
          var focused = "focus" in client ? client.focus() : Promise.resolve(client);
          if ("navigate" in client && client.url !== target.href) {
            return Promise.resolve(focused).then(function (c) {
              var live = c || client;
              return live.navigate(target.href).catch(function () { return live; });
            });
          }
          return focused;
        }
        if (self.clients.openWindow) return self.clients.openWindow(target.href);
        return null;
      }).catch(function () {})
    );
  });

  self.addEventListener("fetch", function (event) {
    var request = event.request;
    var url = toUrl(request && request.url);

    if (!request || request.method !== "GET" || !isSameOrigin(url)) return;
    if (url.pathname === "/sw.js") return;

    if (isPageDocument(request, url)) {
      // Stale-while-revalidate: serve the cached page instantly (caches are
      // VERSION-keyed, purged+re-precached on every deploy that bumps
      // VERSION — the mandatory convention when a page's HTML changes) and
      // refresh the cache in the background so even a missed bump self-heals
      // one navigation later. network-first with a 4s window made every page
      // switch pay a full network round trip and was the main reason
      // navigation felt slow; cache misses still fall back to networkFirst
      // (offline gets the timed cached fallback).
      event.respondWith(
        caches.match(request).then(function (cached) {
          if (cached) {
            fetch(request).then(function (response) {
              if (!shouldCacheResponse(response)) return response;
              // Refresh BOTH caches: STATIC_CACHE (install precache) is
              // created first, so caches.match always prefers its entry —
              // updating only PAGE_CACHE would pin precached pages at
              // install-time HTML forever, killing the self-heal this
              // branch exists to provide.
              var forStatic = response.clone();
              var forRuntime = response.clone();
              return putIfCacheable(PAGE_CACHE, request, response).then(function (result) {
                return caches.open(STATIC_CACHE).then(function (cache) {
                  return cache.match(request).then(function (existing) {
                    if (existing) return cache.put(request, forStatic);
                    return null;
                  });
                }).then(function () {
                  // RUNTIME_CACHE can also hold page documents (idle-prefetch
                  // warmUrls stores non-precached pages there) and may have
                  // been created before PAGE_CACHE — refresh its entry too or
                  // those pages stay pinned at warm-time HTML.
                  return caches.open(RUNTIME_CACHE);
                }).then(function (cache) {
                  return cache.match(request).then(function (existing) {
                    if (existing) return cache.put(request, forRuntime);
                    return null;
                  });
                }).then(function () { return result; });
              });
            }).catch(function () {});
            return cached;
          }
          return networkFirst(request, PAGE_CACHE, PAGE_TIMEOUT_MS);
        })
      );
      return;
    }

    if (isImmutableAsset(url)) {
      event.respondWith(cacheFirst(request, STATIC_CACHE));
      return;
    }

    if (isRuntimeStatic(url) || isSafeRuntimeApi(url)) {
      event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
    }
  });
})();

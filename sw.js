/**
 * GP Link Service Worker
 * Caches app shell and career data for offline access.
 */

var CACHE_NAME = "gp-link-v1";
var RUNTIME_CACHE = "gp-link-runtime-v1";

// App shell — core files to cache on install
var APP_SHELL = [
  "/pages/career.html",
  "/pages/job.html",
  "/pages/application-detail.html",
  "/pages/app-shell.html",
  "/js/auth-guard.js",
  "/js/state-sync.js",
  "/js/updates-sync.js",
  "/js/app-shell.js",
  "/js/nav-shell-bridge.js",
  "/js/native-bridge.js",
  "/js/account-dropdown.js",
  "/js/qualification-camera.js",
  "/js/qualification-scan.js"
];

// Install — cache app shell
self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// Activate — clean old caches
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) {
            return key !== CACHE_NAME && key !== RUNTIME_CACHE;
          })
          .map(function (key) {
            return caches.delete(key);
          })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// Fetch strategy:
// - App shell: Cache first, network fallback
// - API calls: Network first, cache fallback (for career data)
// - Everything else: Network first
self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== "GET") return;

  // Skip cross-origin requests
  if (url.origin !== self.location.origin) return;

  // API endpoints — network first with cache fallback
  if (url.pathname.startsWith("/api/career/")) {
    event.respondWith(
      fetch(event.request)
        .then(function (response) {
          // Cache successful GET responses
          if (response.ok) {
            var clone = response.clone();
            caches.open(RUNTIME_CACHE).then(function (cache) {
              cache.put(event.request, clone);
            });
          }
          return response;
        })
        .catch(function () {
          return caches.match(event.request);
        })
    );
    return;
  }

  // App shell files — cache first
  if (APP_SHELL.indexOf(url.pathname) !== -1 || url.pathname.match(/^\/js\/.*\.js$/)) {
    event.respondWith(
      caches.match(event.request).then(function (cached) {
        if (cached) {
          // Return cached, but update in background
          fetch(event.request).then(function (response) {
            if (response.ok) {
              caches.open(CACHE_NAME).then(function (cache) {
                cache.put(event.request, response);
              });
            }
          }).catch(function () {});
          return cached;
        }
        return fetch(event.request).then(function (response) {
          if (response.ok) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function (cache) {
              cache.put(event.request, clone);
            });
          }
          return response;
        });
      })
    );
    return;
  }

  // Google Fonts — cache first
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(
      caches.match(event.request).then(function (cached) {
        return cached || fetch(event.request).then(function (response) {
          if (response.ok) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function (cache) {
              cache.put(event.request, clone);
            });
          }
          return response;
        });
      })
    );
    return;
  }
});

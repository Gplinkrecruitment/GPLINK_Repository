/**
 * GP Link Service Worker — self-unregistering.
 * Clears all caches and unregisters itself on activation so the browser
 * stops serving stale content from old cache-first strategies.
 */

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) { return caches.delete(key); }));
    }).then(function () {
      return self.registration.unregister();
    }).then(function () {
      return self.clients.claim();
    })
  );
});

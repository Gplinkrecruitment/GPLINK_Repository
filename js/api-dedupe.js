/**
 * api-dedupe.js — collapse duplicate in-flight API GETs.
 *
 * WHY THIS EXISTS
 * Measured 2026-07-29 (real headless browser, prod database): one logged-in page
 * load fired ~30 API calls, and several were the SAME endpoint requested within
 * milliseconds of each other by different scripts that don't know about one
 * another — /api/state three times inside 41ms, /api/career/applications twice
 * inside 17ms, /api/auth/session from both the shell and the embedded page.
 * Each of those costs a Vercel function invocation and 2+ database queries.
 *
 * WHAT IT DOES
 * While a GET to /api/... is still in flight, any identical GET issued from the
 * same document reuses that one response instead of opening a second request.
 *
 * WHY THIS IS SAFE (and why it is NOT an HTTP cache)
 * Nothing is ever stored. The moment a request settles its entry is dropped, so
 * the next call always goes to the network. A GET issued AFTER a write completes
 * can therefore never be merged with one issued before it — which is exactly the
 * failure mode that made `/api/career/role` no-store (see PRIVATE_VOLATILE_HEADERS
 * in server.js and readCachedRoleDetail in pages/job.html; commit 4e87aec). This
 * layer deliberately has no TTL and no stale-while-revalidate. Do not add one.
 *
 * Requests are only merged when they are unambiguously the same plain read:
 * same-origin GET under /api/, no body, no AbortSignal (one caller aborting must
 * never cancel another's request), no custom headers, and no cache-busting intent.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  if (window.__gpApiDedupeInstalled) return;
  window.__gpApiDedupeInstalled = true;

  var originalFetch = window.fetch.bind(window);
  var inflight = Object.create(null);

  function methodOf(init) {
    if (!init || !init.method) return "GET";
    return String(init.method).toUpperCase();
  }

  function urlOf(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url; // Request object
    return null;
  }

  // Only plain, side-effect-free reads of our own API are eligible.
  function isEligible(input, init) {
    // A Request object can carry a body/signal we cannot inspect cheaply — skip it.
    if (typeof input !== "string") return false;
    if (methodOf(init) !== "GET") return false;

    if (init) {
      if (init.body !== undefined && init.body !== null) return false;
      if (init.signal) return false;               // abort must stay per-caller
      if (init.headers) return false;              // custom headers change the response
      if (init.cache === "no-store" || init.cache === "reload") return false;
    }

    var path = input;
    try {
      var parsed = new URL(input, window.location.origin);
      if (parsed.origin !== window.location.origin) return false;
      path = parsed.pathname;
    } catch (e) {
      if (input.charAt(0) !== "/") return false;
      path = input.split("?")[0];
    }
    return path.indexOf("/api/") === 0;
  }

  // Buffer the body once and hand every caller its own independent Response.
  // (Response.clone() would leave the un-read original tee-ing in memory; building
  // fresh Responses from one ArrayBuffer is deterministic and cheap for JSON.)
  function share(url, init) {
    var pending = inflight[url];
    if (!pending) {
      pending = originalFetch(url, init).then(function (response) {
        return response.arrayBuffer().then(function (buf) {
          var headers = [];
          try {
            response.headers.forEach(function (v, k) { headers.push([k, v]); });
          } catch (e) {}
          return {
            buf: buf,
            status: response.status,
            statusText: response.statusText,
            headers: headers,
            url: response.url,
            redirected: response.redirected,
            type: response.type
          };
        });
      });
      // Always clear the slot, success or failure — this must never outlive the
      // request itself, or it becomes the cache this file promises not to be.
      pending.then(
        function () { delete inflight[url]; },
        function () { delete inflight[url]; }
      );
      inflight[url] = pending;
    }

    return pending.then(function (snap) {
      // 204/205 and 304 must not carry a body, or the Response constructor throws.
      var body = (snap.status === 204 || snap.status === 205 || snap.status === 304)
        ? null
        : snap.buf.slice(0);
      var resp = new Response(body, {
        status: snap.status,
        statusText: snap.statusText,
        headers: snap.headers
      });
      try {
        Object.defineProperty(resp, "url", { value: snap.url, configurable: true });
        Object.defineProperty(resp, "redirected", { value: snap.redirected, configurable: true });
        Object.defineProperty(resp, "type", { value: snap.type, configurable: true });
      } catch (e) {}
      return resp;
    });
  }

  window.fetch = function (input, init) {
    try {
      if (!isEligible(input, init)) return originalFetch(input, init);
      return share(urlOf(input), init);
    } catch (e) {
      // Never let the optimisation break a request.
      return originalFetch(input, init);
    }
  };
})();

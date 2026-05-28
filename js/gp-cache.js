(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  /* ── Configuration ────────────────────────────────────────────── */

  var PREFIX = "gpc:";
  var OWNER_KEY = "gp_state_owner";

  // TTL tiers: fresh (ms) and stale (ms) windows
  var TIERS = {
    auth:     { fresh:  2 * 60 * 1000, stale:  5 * 60 * 1000 },
    state:    { fresh: 30 * 1000,       stale:  2 * 60 * 1000 },
    metadata: { fresh:  5 * 60 * 1000,  stale: 15 * 60 * 1000 },
    heavy:    { fresh: 10 * 60 * 1000,  stale: 30 * 60 * 1000 },
    nudges:   { fresh:  3 * 60 * 1000,  stale:  5 * 60 * 1000 }
  };

  // Map URL prefixes/paths to tier names
  var ROUTE_TIERS = {
    "/api/auth/session":      "auth",
    "/api/account/status":    "auth",
    "/api/state":             "state",
    "/api/career/roles":      "metadata",
    "/api/career/alerts":     "metadata",
    "/api/media-config":      "metadata",
    "/api/career/hero-image": "metadata",
    "/api/career/applications": "heavy",
    "/api/user/nudges":       "nudges"
  };

  /* ── Helpers ──────────────────────────────────────────────────── */

  var _inflight = Object.create(null);
  var _lastOwner = null;

  function tierFor(url) {
    // Extract pathname from the URL for matching
    var pathname = url;
    try {
      var parsed = new URL(url, window.location.origin);
      pathname = parsed.pathname;
    } catch (e) {
      // url is likely already a pathname
    }
    // Exact match first
    if (ROUTE_TIERS[pathname]) return TIERS[ROUTE_TIERS[pathname]] || null;
    // Prefix match (for URLs that may have query strings stripped but still
    // start with a known route)
    var keys = Object.keys(ROUTE_TIERS);
    for (var i = 0; i < keys.length; i++) {
      if (pathname.indexOf(keys[i]) === 0) {
        return TIERS[ROUTE_TIERS[keys[i]]] || null;
      }
    }
    return null;
  }

  function cacheKey(url) {
    return PREFIX + url;
  }

  function now() {
    return Date.now();
  }

  /* ── Ownership enforcement ────────────────────────────────────── */

  function enforceOwnership() {
    var currentOwner = "";
    try { currentOwner = localStorage.getItem(OWNER_KEY) || ""; } catch (e) {}
    if (_lastOwner === null) {
      // First check — just record the owner
      _lastOwner = currentOwner;
      return;
    }
    if (currentOwner && currentOwner !== _lastOwner) {
      // User changed — wipe the entire cache
      clearAll();
      _lastOwner = currentOwner;
    } else if (currentOwner !== _lastOwner) {
      _lastOwner = currentOwner;
    }
  }

  /* ── sessionStorage read / write with eviction ────────────────── */

  function readEntry(key) {
    try {
      var raw = sessionStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function writeEntry(key, entry) {
    var json = JSON.stringify(entry);
    try {
      sessionStorage.setItem(key, json);
    } catch (e) {
      // Storage full — evict oldest 5 entries and retry once
      evictOldest(5);
      try {
        sessionStorage.setItem(key, json);
      } catch (e2) {
        // Still failing; silently give up
      }
    }
  }

  function evictOldest(count) {
    var entries = [];
    try {
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) {
          var entry = readEntry(k);
          entries.push({ key: k, ts: entry ? entry.ts : 0 });
        }
      }
    } catch (e) {
      return;
    }
    entries.sort(function (a, b) { return a.ts - b.ts; });
    var toRemove = Math.min(count, entries.length);
    for (var j = 0; j < toRemove; j++) {
      try { sessionStorage.removeItem(entries[j].key); } catch (e) {}
    }
  }

  /* ── Core SWR fetch ───────────────────────────────────────────── */

  function swrFetch(url, options) {
    enforceOwnership();

    var opts = options || {};
    var tier = tierFor(url);

    // Not cacheable — pass through to network
    if (!tier) {
      return window.fetch(url, { credentials: "same-origin" });
    }

    // Force network — skip cache entirely
    if (opts.forceNetwork) {
      return networkFetch(url);
    }

    var key = cacheKey(url);
    var entry = readEntry(key);
    var timestamp = now();

    if (entry) {
      var age = timestamp - entry.ts;

      // Fresh — return cached, no network
      if (age < tier.fresh) {
        return Promise.resolve(buildResponse(entry));
      }

      // Stale — return cached immediately, revalidate in background
      if (age < tier.stale) {
        revalidateBackground(url, key, entry, opts.onUpdate);
        return Promise.resolve(buildResponse(entry));
      }
    }

    // Expired or no cache — fetch from network
    return networkFetch(url);
  }

  function buildResponse(entry) {
    return new Response(entry.body, {
      status: entry.status,
      statusText: entry.statusText || "",
      headers: { "Content-Type": entry.contentType || "application/json" }
    });
  }

  function networkFetch(url) {
    // Deduplicate in-flight requests to the same URL
    if (_inflight[url]) {
      return _inflight[url];
    }

    var promise = window.fetch(url, { credentials: "same-origin" })
      .then(function (response) {
        delete _inflight[url];
        // Only cache successful responses
        if (response.ok) {
          return cacheResponse(url, response);
        }
        return response;
      })
      .catch(function (err) {
        delete _inflight[url];
        throw err;
      });

    _inflight[url] = promise;
    return promise;
  }

  function cacheResponse(url, response) {
    var tier = tierFor(url);
    if (!tier) return response;

    // Clone so the caller can still consume the original
    var clone = response.clone();
    var key = cacheKey(url);

    clone.text().then(function (bodyText) {
      var entry = {
        body: bodyText,
        status: response.status,
        statusText: response.statusText || "",
        contentType: response.headers.get("Content-Type") || "application/json",
        ts: now()
      };
      writeEntry(key, entry);
    }).catch(function () {
      // Silently ignore cache write failures
    });

    return response;
  }

  function revalidateBackground(url, key, oldEntry, onUpdate) {
    // Use deduplication — if already revalidating, skip
    if (_inflight[url]) return;

    var promise = window.fetch(url, { credentials: "same-origin" })
      .then(function (response) {
        delete _inflight[url];
        if (!response.ok) return;

        var clone = response.clone();
        clone.text().then(function (bodyText) {
          var entry = {
            body: bodyText,
            status: response.status,
            statusText: response.statusText || "",
            contentType: response.headers.get("Content-Type") || "application/json",
            ts: now()
          };
          writeEntry(key, entry);

          // Fire onUpdate if the data actually changed
          if (typeof onUpdate === "function" && oldEntry.body !== bodyText) {
            try { onUpdate(buildResponse(entry)); } catch (e) {}
          }
        }).catch(function () {});
      })
      .catch(function () {
        delete _inflight[url];
      });

    _inflight[url] = promise;
  }

  /* ── Cache management ─────────────────────────────────────────── */

  function invalidate(urls) {
    var list = Array.isArray(urls) ? urls : [urls];
    for (var i = 0; i < list.length; i++) {
      var key = cacheKey(list[i]);
      try { sessionStorage.removeItem(key); } catch (e) {}
    }
  }

  function invalidatePrefix(prefix) {
    var fullPrefix = PREFIX + prefix;
    var toRemove = [];
    try {
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if (k && k.indexOf(fullPrefix) === 0) {
          toRemove.push(k);
        }
      }
    } catch (e) {
      return;
    }
    for (var j = 0; j < toRemove.length; j++) {
      try { sessionStorage.removeItem(toRemove[j]); } catch (e) {}
    }
  }

  function clearAll() {
    var toRemove = [];
    try {
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) {
          toRemove.push(k);
        }
      }
    } catch (e) {
      return;
    }
    for (var j = 0; j < toRemove.length; j++) {
      try { sessionStorage.removeItem(toRemove[j]); } catch (e) {}
    }
  }

  /* ── Public API ───────────────────────────────────────────────── */

  window.gpCache = {
    fetch: swrFetch,
    invalidate: invalidate,
    invalidatePrefix: invalidatePrefix,
    clear: clearAll
  };
})();

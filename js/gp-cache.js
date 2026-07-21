(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  /* ── Configuration ────────────────────────────────────────────── */

  var PREFIX = "gpc:";
  var OWNER_KEY = "gp_state_owner";

  // TTL tiers (ms): fresh = serve from cache only; stale = serve + background revalidate
  var TIERS = {
    auth:     { fresh:  2 * 60 * 1000, stale:  5 * 60 * 1000 },
    state:    { fresh: 30 * 1000,       stale:  2 * 60 * 1000 },
    metadata: { fresh:  5 * 60 * 1000,  stale: 15 * 60 * 1000 },
    heavy:    { fresh: 10 * 60 * 1000,  stale: 30 * 60 * 1000 },
    nudges:   { fresh:  3 * 60 * 1000,  stale:  5 * 60 * 1000 }
  };

  // Map URL paths to tier names
  var ROUTE_TIERS = {
    "/api/auth/session":        "auth",
    "/api/account/status":      "auth",
    "/api/state":               "state",
    "/api/career/roles":        "metadata",
    "/api/career/alerts":       "metadata",
    "/api/media-config":        "metadata",
    "/api/career/hero-image":   "metadata",
    "/api/career/applications": "heavy",
    "/api/user/nudges":         "nudges",
    // C4 (audit 2026-07-07): heavy GP pages, short "state" tier (30s fresh /
    // 2m stale-revalidate) so repeated on-load GETs coalesce without serving
    // meaningfully stale document status. Both endpoints are idempotent GETs.
    "/api/ahpra/document-readiness": "state",
    "/api/gplink-docs-status":       "state"
  };

  /* ── Helpers ──────────────────────────────────────────────────── */

  var _inflight = Object.create(null);
  var _lastOwner = null;

  function tierFor(url) {
    var pathname = url;
    try {
      var parsed = new URL(url, window.location.origin);
      pathname = parsed.pathname;
    } catch (e) {}
    if (ROUTE_TIERS[pathname]) return TIERS[ROUTE_TIERS[pathname]] || null;
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

  /* ── Ownership enforcement ────────────────────────────────────── */

  function enforceOwnership() {
    var currentOwner = "";
    try { currentOwner = localStorage.getItem(OWNER_KEY) || ""; } catch (e) {}
    if (_lastOwner === null) {
      _lastOwner = currentOwner;
      return;
    }
    if (currentOwner && currentOwner !== _lastOwner) {
      clearAll();
      _lastOwner = currentOwner;
    } else if (currentOwner !== _lastOwner) {
      _lastOwner = currentOwner;
    }
  }

  /* ── sessionStorage read / write ──────────────────────────────── */

  function readEntry(key) {
    try {
      var raw = sessionStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function writeEntry(key, data) {
    var entry = { data: data, ts: Date.now() };
    var json = JSON.stringify(entry);
    try {
      sessionStorage.setItem(key, json);
    } catch (e) {
      evictOldest(5);
      try {
        sessionStorage.setItem(key, json);
      } catch (e2) {}
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

  /* ── Core SWR fetch, returns parsed JSON ─────────────────────── */

  /**
   * @param {string} url - API URL to fetch
   * @param {object} [options]
   * @param {boolean} [options.forceNetwork] - Skip cache, go straight to network
   * @param {function} [options.onUpdate] - Called with fresh parsed JSON if it differs from cached
   * @returns {Promise<object>} Parsed JSON response data
   */
  function swrFetch(url, options) {
    enforceOwnership();

    var opts = options || {};
    var tier = tierFor(url);

    // Not cacheable, pass through to network and parse JSON
    if (!tier) {
      return window.fetch(url, { credentials: "same-origin" }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
    }

    // Force network, skip cache
    if (opts.forceNetwork) {
      return networkFetch(url);
    }

    var key = cacheKey(url);
    var entry = readEntry(key);

    if (entry && entry.data !== undefined) {
      var age = Date.now() - entry.ts;

      // Fresh, return cached, no network
      if (age < tier.fresh) {
        return Promise.resolve(entry.data);
      }

      // Stale, return cached now, revalidate in background
      if (age < tier.stale) {
        revalidateBackground(url, key, entry.data, opts.onUpdate);
        return Promise.resolve(entry.data);
      }
    }

    // Expired or no cache, fetch from network
    return networkFetch(url);
  }

  function networkFetch(url) {
    if (_inflight[url]) return _inflight[url];

    var promise = window.fetch(url, { credentials: "same-origin" })
      .then(function (response) {
        delete _inflight[url];
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json().then(function (data) {
          var tier = tierFor(url);
          if (tier) writeEntry(cacheKey(url), data);
          return data;
        });
      })
      .catch(function (err) {
        delete _inflight[url];
        throw err;
      });

    _inflight[url] = promise;
    return promise;
  }

  function revalidateBackground(url, key, cachedData, onUpdate) {
    if (_inflight[url]) return;

    var promise = window.fetch(url, { credentials: "same-origin" })
      .then(function (response) {
        delete _inflight[url];
        if (!response.ok) return;
        return response.json().then(function (freshData) {
          writeEntry(key, freshData);
          if (typeof onUpdate === "function" && JSON.stringify(freshData) !== JSON.stringify(cachedData)) {
            try { onUpdate(freshData); } catch (e) {}
          }
        });
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
      try { sessionStorage.removeItem(cacheKey(list[i])); } catch (e) {}
    }
  }

  function invalidatePrefix(prefix) {
    var fullPrefix = PREFIX + prefix;
    var toRemove = [];
    try {
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if (k && k.indexOf(fullPrefix) === 0) toRemove.push(k);
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
        if (k && k.indexOf(PREFIX) === 0) toRemove.push(k);
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

/**
 * Shared bypass-lock email list, single source of truth for client-side.
 * Server-side reads from process.env.BYPASS_LOCK_EMAILS plus matching temporary
 * entries in server.js.
 *
 * Temporary personal-email bypasses are keyed by the SHA-256 hex digest of the
 * lowercase email (no plaintext personal emails are shipped to clients). The
 * current user's email is hashed at load time; on a match the plaintext key is
 * defined on BYPASS_LOCK_EMAILS from the user's own session data and the match
 * is cached in localStorage so later page loads can activate synchronously.
 */
var BYPASS_LOCK_EMAILS = {
  "hello@mygplink.com.au": true
};

(function () {
  // Three temporary tester digests are currently active (all expire 2026-09-30).
  // { "<sha256 hex of lowercase email>": "<expiry ISO timestamp>" }
  var TEMPORARY_BYPASS_LOCK_DIGESTS = {
    "f4c9faeba3c465a82adb51cebe3d80b8e94e86470b0aaa50d752b8c2a8ba8c6e": "2026-09-30T23:59:59.000Z",
    "0ddbcc0ad55d9abd429a176c9e1f53e514c1551cce517c4768ff3c0c43bbecf6": "2026-09-30T23:59:59.000Z",
    "fb28215b317f6f7327d5223f534e04a28559ca54eb80ac9b31404601e9cc82ac": "2026-09-30T23:59:59.000Z"
  };
  var DIGEST_MATCH_CACHE_KEY = "gp_bypass_digest_match";

  function getCurrentBypassEmail() {
    try { if (window.gpSessionProfile && window.gpSessionProfile.email) return String(window.gpSessionProfile.email).trim().toLowerCase(); } catch (e) {}
    try {
      var localProfile = localStorage.getItem("gp_session_profile_cache");
      if (localProfile) {
        var parsedLocal = JSON.parse(localProfile);
        if (parsedLocal && parsedLocal.email) return String(parsedLocal.email).trim().toLowerCase();
      }
    } catch (e) {}
    try {
      var sessionProfile = sessionStorage.getItem("gp_session_profile_cache");
      if (sessionProfile) {
        var parsedSession = JSON.parse(sessionProfile);
        if (parsedSession && parsedSession.email) return String(parsedSession.email).trim().toLowerCase();
      }
    } catch (e) {}
    try { return String(localStorage.getItem("gp_state_owner") || "").trim().toLowerCase(); } catch (e) {}
    return "";
  }

  function sha256Hex(text) {
    try {
      if (!(window.crypto && window.crypto.subtle && window.crypto.subtle.digest && typeof TextEncoder !== "undefined")) {
        return Promise.resolve("");
      }
      return window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text))).then(function (buffer) {
        var bytes = new Uint8Array(buffer);
        var hex = "";
        for (var i = 0; i < bytes.length; i++) hex += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
        return hex;
      });
    } catch (e) {
      return Promise.resolve("");
    }
  }

  function activateTemporaryBypass(email, expiresAt) {
    Object.defineProperty(BYPASS_LOCK_EMAILS, email, {
      configurable: true,
      enumerable: true,
      get: function () {
        return Date.now() < Date.parse(expiresAt);
      }
    });
    applyTemporaryAhpraIntroBypass(email, expiresAt);
  }

  function applyTemporaryAhpraIntroBypass(email, expiresAt) {
    var introSeenKey = "gp_ahpra_progress__intro_seen";
    var markerKey = introSeenKey + "_temporary_bypass";
    var bypassActive = !!BYPASS_LOCK_EMAILS[email];
    try {
      if (bypassActive) {
        // Don't overwrite an existing marker for the same email, repeated
        // activations (gpRefreshBypassDigestMatch is safe to call many times)
        // would otherwise capture "1" as the pre-bypass value to restore.
        var existingRaw = localStorage.getItem(markerKey);
        var existing = null;
        try { existing = existingRaw ? JSON.parse(existingRaw) : null; } catch (parseErr) {}
        if (!existing || existing.email !== email) {
          var previous = localStorage.getItem(introSeenKey);
          localStorage.setItem(markerKey, JSON.stringify({ email: email, previous: previous, expiresAt: expiresAt }));
        }
        localStorage.setItem(introSeenKey, "1");
        return;
      }

      var markerRaw = localStorage.getItem(markerKey);
      if (!markerRaw) return;
      var marker = JSON.parse(markerRaw);
      if (!marker || marker.email !== email) return;
      if (marker.previous === "1") localStorage.setItem(introSeenKey, "1");
      else localStorage.removeItem(introSeenKey);
      localStorage.removeItem(markerKey);
    } catch (e) {}
  }

  // Runs the digest comparison for the given email (or the current cached one)
  // and activates the temporary bypass on a match. Idempotent, safe to call
  // repeatedly; re-activation just redefines the same expiring getter.
  function refreshBypassDigestMatch(emailOverride) {
    var currentEmail = String(emailOverride || "").trim().toLowerCase() || getCurrentBypassEmail();
    if (!currentEmail) return;

    // Sync fast-path: a previous load on this device already matched the digest.
    try {
      var cachedRaw = localStorage.getItem(DIGEST_MATCH_CACHE_KEY);
      if (cachedRaw) {
        var cached = JSON.parse(cachedRaw);
        if (cached && cached.email === currentEmail &&
            Object.prototype.hasOwnProperty.call(TEMPORARY_BYPASS_LOCK_DIGESTS, cached.digest)) {
          activateTemporaryBypass(currentEmail, TEMPORARY_BYPASS_LOCK_DIGESTS[cached.digest]);
          return;
        }
      }
    } catch (e) {}

    // Async path: hash the current email and compare against the digest map.
    sha256Hex(currentEmail).then(function (digest) {
      if (!digest || !Object.prototype.hasOwnProperty.call(TEMPORARY_BYPASS_LOCK_DIGESTS, digest)) return;
      var expiresAt = TEMPORARY_BYPASS_LOCK_DIGESTS[digest];
      try { localStorage.setItem(DIGEST_MATCH_CACHE_KEY, JSON.stringify({ email: currentEmail, digest: digest, expiresAt: expiresAt })); } catch (e) {}
      activateTemporaryBypass(currentEmail, expiresAt);
    }).catch(function () {});
  }

  // Exposed so pages can re-run the match once their own /api/auth/session fetch
  // resolves, on a brand-new browser the profile caches are empty when this
  // script first runs, so the self-invoke below may find no email yet.
  try { window.gpRefreshBypassDigestMatch = refreshBypassDigestMatch; } catch (e) {}

  refreshBypassDigestMatch();
})();

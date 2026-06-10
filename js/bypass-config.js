/**
 * Shared bypass-lock email list — single source of truth for client-side.
 * Server-side reads from process.env.BYPASS_LOCK_EMAILS plus matching temporary
 * entries in server.js.
 */
var BYPASS_LOCK_EMAILS = {
  "hello@mygplink.com.au": true
};

(function () {
  var TEMPORARY_BYPASS_LOCK_EMAILS = {
    "smithmiller1234@gmail.com": "2026-06-10T14:05:40.018Z"
  };

  Object.keys(TEMPORARY_BYPASS_LOCK_EMAILS).forEach(function (email) {
    Object.defineProperty(BYPASS_LOCK_EMAILS, email, {
      configurable: true,
      enumerable: true,
      get: function () {
        return Date.now() < Date.parse(TEMPORARY_BYPASS_LOCK_EMAILS[email]);
      }
    });
  });

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

  function applyTemporaryAhpraIntroBypass() {
    var email = getCurrentBypassEmail();
    if (!email || !Object.prototype.hasOwnProperty.call(TEMPORARY_BYPASS_LOCK_EMAILS, email)) return;

    var introSeenKey = "gp_ahpra_progress__intro_seen";
    var markerKey = introSeenKey + "_temporary_bypass";
    var bypassActive = !!BYPASS_LOCK_EMAILS[email];
    try {
      if (bypassActive) {
        var previous = localStorage.getItem(introSeenKey);
        localStorage.setItem(markerKey, JSON.stringify({ email: email, previous: previous, expiresAt: TEMPORARY_BYPASS_LOCK_EMAILS[email] }));
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

  applyTemporaryAhpraIntroBypass();
})();

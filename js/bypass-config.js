/**
 * Shared bypass-lock email list — single source of truth for client-side.
 * Server-side reads from process.env.BYPASS_LOCK_EMAILS.
 */
var BYPASS_LOCK_EMAILS = {
  "hello@mygplink.com.au": true
};

/**
 * Temporary bypass — auto-expires after the given ISO timestamp.
 * Remove entries once expired.
 */
var TEMP_BYPASS_EMAILS = {
  "smithmiller1234@gmail.com": "2026-06-08T14:51:00Z"
};
(function () {
  var now = new Date().toISOString();
  for (var email in TEMP_BYPASS_EMAILS) {
    if (TEMP_BYPASS_EMAILS[email] > now) {
      BYPASS_LOCK_EMAILS[email] = true;
    }
  }
})();

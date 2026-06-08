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
    "smithmiller1234@gmail.com": "2026-06-08T15:08:48.001Z"
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
})();

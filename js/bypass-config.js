/**
 * Shared bypass-lock email list — single source of truth for client-side.
 * Server-side reads from process.env.BYPASS_LOCK_EMAILS.
 */
var BYPASS_LOCK_EMAILS = {
  "hello@mygplink.com.au": true,
  "smithmiller1234@gmail.com": true
};

// TEMPORARY QA gate for the in-app walkthrough.
// Asks the server (/api/walkthrough-config) whether the CURRENT logged-in user is on the
// walkthrough test allowlist. Only allowlisted testers see the tour/tips, and they see them
// every login (the controllers use sessionStorage, not the synced state, so nothing persists).
// The allowlist lives server-side (server.js WALKTHROUGH_TEST_EMAILS) so no email ships in
// client JS. Remove this file + the gate calls in the controllers to enable the real rollout.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  var CACHE_KEY = 'gp_wt_enabled'; // sessionStorage: '1' (show) | '0' (hide)
  var promise = null;

  function enabled() {
    try {
      var c = sessionStorage.getItem(CACHE_KEY);
      if (c === '1') return Promise.resolve(true);
      if (c === '0') return Promise.resolve(false);
    } catch (e) {}
    if (promise) return promise;
    promise = fetch('/api/walkthrough-config', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { show: false }; })
      .then(function (d) {
        var on = !!(d && d.show);
        try { sessionStorage.setItem(CACHE_KEY, on ? '1' : '0'); } catch (e) {}
        return on;
      })
      .catch(function () { return false; });
    return promise;
  }

  window.gpWalkthroughGate = { enabled: enabled };
})();

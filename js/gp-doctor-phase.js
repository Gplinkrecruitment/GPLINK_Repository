// Doctor phase — the ONE place that says which stage of the GP Link journey a
// doctor is in, and therefore what the app shell should show them.
//
//   onboarding    → the onboarding wizard owns the screen (no nav at all)
//   position      → onboarded, no secured placement: My Practice + Account only
//   registration  → placement secured: the full app (Home, Documents, Support,
//                   My Practice, Account, Scan)
//   restricted    → account under review / eligibility waitlist: auth-guard owns
//                   the screen; the shell changes nothing
//
// Owner brief (2026-09-03): doctors said they "did not know what to do". Until a
// position is secured the ONLY pages a doctor can see are the careers page and
// their account page — every registration surface stays out of sight (the
// server already 302s the stage pages to /pages/career; this hides the tabs).
//
// Pure + UMD so vitest can require it. No DOM here — app-shell.js applies the
// result to the nav.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.gpDoctorPhase = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var PHASES = Object.freeze(['onboarding', 'position', 'registration', 'restricted']);

  // Nav items (data-nav on desktop, mobile tab route / scan trigger) visible in
  // each phase. 'onboarding' and 'restricted' are handled by other owners
  // (index.html's gateway hides chrome; auth-guard's restricted overlay) so the
  // shell leaves the full nav in place for them.
  var NAV_VISIBILITY = Object.freeze({
    position: Object.freeze({ home: false, documents: false, support: false, career: true, account: true, scan: false }),
    registration: Object.freeze({ home: true, documents: true, support: true, career: true, account: true, scan: true }),
    onboarding: Object.freeze({ home: true, documents: true, support: true, career: true, account: true, scan: true }),
    restricted: Object.freeze({ home: true, documents: true, support: true, career: true, account: true, scan: true })
  });

  // Landing route per phase: Home only exists once a position is secured.
  var LANDING_ROUTE = Object.freeze({
    position: '/pages/career',
    registration: '/pages/index',
    onboarding: '/pages/index',
    restricted: '/pages/index'
  });

  // Routes that are HIDDEN in the position phase — navigating to one of them
  // (deep link, back button, stale bookmark) lands on the careers page instead.
  var POSITION_HIDDEN_ROUTES = Object.freeze({
    '/pages/index': true,
    '/pages/registration-intro': true,
    '/pages/myinthealth': true,
    '/pages/amc': true,
    '/pages/ahpra': true,
    '/pages/visa': true,
    '/pages/pbs': true,
    '/pages/commencement': true
  });

  function derivePhase(input) {
    var s = input && typeof input === 'object' ? input : {};
    if (s.underReview === true || s.pepWaitlist === true) return 'restricted';
    if (s.onboardingComplete !== true) return 'onboarding';
    if (s.careerSecured !== true) return 'position';
    return 'registration';
  }

  // Same derivation from the synced localStorage keys every surface shares.
  // `store` is any getItem() carrier (localStorage); `isSecured` is
  // GPJourneyStages.hasCareerSecured (passed in so this file stays pure).
  function derivePhaseFromStorage(store, isSecured) {
    function get(key) { try { return store && store.getItem ? store.getItem(key) : null; } catch (e) { return null; } }
    var secured = false;
    try {
      var raw = get('gp_career_state');
      secured = !!(raw && typeof isSecured === 'function' && isSecured(JSON.parse(raw)));
    } catch (e) { secured = false; }
    return derivePhase({
      onboardingComplete: get('gp_onboarding_complete') === 'true',
      careerSecured: secured,
      underReview: get('gp_account_under_review') === 'true',
      pepWaitlist: get('gp_account_pep_waitlist') === 'true'
    });
  }

  function navVisibility(phase) {
    return NAV_VISIBILITY[phase] || NAV_VISIBILITY.registration;
  }

  function landingRoute(phase) {
    return LANDING_ROUTE[phase] || LANDING_ROUTE.registration;
  }

  function normalizeRoute(pathname) {
    if (!pathname) return '';
    return String(pathname).replace(/[?#].*$/, '').replace(/\.html$/, '').replace(/\/+$/, '') || '';
  }

  // Where a navigation should ACTUALLY go for this phase. Returns the input
  // route unchanged unless the phase hides it. Query/hash are dropped only when
  // the route is rewritten (the careers page has no use for a home deep link).
  function resolveRouteForPhase(phase, route) {
    var clean = normalizeRoute(route);
    if (phase === 'position' && POSITION_HIDDEN_ROUTES[clean] === true) return LANDING_ROUTE.position;
    return route;
  }

  function isRouteHiddenInPhase(phase, route) {
    var clean = normalizeRoute(route);
    return phase === 'position' && POSITION_HIDDEN_ROUTES[clean] === true;
  }

  return {
    PHASES: PHASES,
    NAV_VISIBILITY: NAV_VISIBILITY,
    LANDING_ROUTE: LANDING_ROUTE,
    POSITION_HIDDEN_ROUTES: POSITION_HIDDEN_ROUTES,
    derivePhase: derivePhase,
    derivePhaseFromStorage: derivePhaseFromStorage,
    navVisibility: navVisibility,
    landingRoute: landingRoute,
    resolveRouteForPhase: resolveRouteForPhase,
    isRouteHiddenInPhase: isRouteHiddenInPhase,
    normalizeRoute: normalizeRoute
  };
});

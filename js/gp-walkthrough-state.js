// Pure walkthrough state logic — no DOM, no browser globals. UMD so vitest can require it.
// State shape: { tourDone: bool, nextStepDone: bool, introSeen: bool,
//                registrationIntroSeen: bool, tips: { home, practice, support, account, scan : bool } }
// nextStepDone: the one-off post-tour "start here" pointer. Only marked when the GP
// actually clicks the highlighted target — Escape/Skip leaves it pending so it re-arms.
// introSeen: the "How GP Link works" welcome slideshow shown once right after
// onboarding (js/gp-intro-slides.js). registrationIntroSeen: the "Your position is
// secured" slideshow shown once when the placement lands. Both are first-run
// mandatory (no close) and replayable from Account.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.gpWalkthroughState = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  var AREAS = Object.freeze(['home', 'practice', 'support', 'account', 'scan']);

  function tipsAll(v) {
    var t = {};
    for (var i = 0; i < AREAS.length; i++) t[AREAS[i]] = v;
    return t;
  }
  function defaultState() {
    return { tourDone: false, nextStepDone: false, introSeen: false, registrationIntroSeen: false, tips: tipsAll(false) };
  }
  function normalize(state) {
    var d = defaultState();
    if (!state || typeof state !== 'object') return d;
    d.tourDone = state.tourDone === true;
    d.nextStepDone = state.nextStepDone === true;
    d.introSeen = state.introSeen === true;
    d.registrationIntroSeen = state.registrationIntroSeen === true;
    var t = state.tips && typeof state.tips === 'object' ? state.tips : {};
    for (var i = 0; i < AREAS.length; i++) d.tips[AREAS[i]] = t[AREAS[i]] === true;
    return d;
  }
  function parseState(raw) {
    if (raw === null || typeof raw === 'undefined' || raw === '') return defaultState();
    if (typeof raw === 'object') return normalize(raw);
    try { return normalize(JSON.parse(raw)); } catch (e) { return defaultState(); }
  }
  function serializeState(state) { return JSON.stringify(normalize(state)); }
  function allSeenState() {
    return { tourDone: true, nextStepDone: true, introSeen: true, registrationIntroSeen: true, tips: tipsAll(true) };
  }
  function withTourDone(state) { var n = normalize(state); n.tourDone = true; return n; }
  function withNextStepDone(state) { var n = normalize(state); n.nextStepDone = true; return n; }
  function withIntroSeen(state) { var n = normalize(state); n.introSeen = true; return n; }
  function withRegistrationIntroSeen(state) { var n = normalize(state); n.registrationIntroSeen = true; return n; }
  function withTipSeen(state, area) {
    var n = normalize(state);
    if (AREAS.indexOf(area) !== -1) n.tips[area] = true;
    return n;
  }
  function shouldRunTour(state) { return normalize(state).tourDone !== true; }
  function shouldRunNextStep(state) {
    var n = normalize(state);
    return n.tourDone === true && n.nextStepDone !== true;
  }
  function shouldRunTip(state, area) {
    var n = normalize(state);
    return n.tourDone === true && AREAS.indexOf(area) !== -1 && n.tips[area] === false;
  }
  // Welcome slideshow: once, for any doctor who has not seen it — including
  // existing unplaced doctors (the group that reported not knowing what to do).
  function shouldRunIntro(state) { return normalize(state).introSeen !== true; }
  // Registration slideshow: once, after the position is secured. A doctor who
  // has already started registering (MyIntealth done) is past the moment it
  // describes — the caller retires it silently in that case.
  function shouldRunRegistrationIntro(state) { return normalize(state).registrationIntroSeen !== true; }
  var ROUTE_AREA = {
    '/pages/index': 'home',
    '/pages/career': 'practice',
    '/pages/messages': 'support',
    '/pages/account': 'account'
  };
  function routeToArea(pathname) {
    if (!pathname) return null;
    var p = String(pathname).replace(/[?#].*$/, '').replace(/\.html$/, '').replace(/\/+$/, '');
    return ROUTE_AREA[p] || null;
  }

  return {
    AREAS: AREAS, defaultState: defaultState, parseState: parseState, serializeState: serializeState,
    allSeenState: allSeenState, withTourDone: withTourDone, withNextStepDone: withNextStepDone,
    withIntroSeen: withIntroSeen, withRegistrationIntroSeen: withRegistrationIntroSeen,
    withTipSeen: withTipSeen, shouldRunTour: shouldRunTour, shouldRunNextStep: shouldRunNextStep,
    shouldRunTip: shouldRunTip, shouldRunIntro: shouldRunIntro,
    shouldRunRegistrationIntro: shouldRunRegistrationIntro, routeToArea: routeToArea
  };
});

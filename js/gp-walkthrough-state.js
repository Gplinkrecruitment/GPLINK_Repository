// Pure walkthrough state logic — no DOM, no browser globals. UMD so vitest can require it.
// State shape: { tourDone: bool, tips: { home, practice, support, account, scan : bool } }
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
    return { tourDone: false, tips: tipsAll(false) };
  }
  function normalize(state) {
    var d = defaultState();
    if (!state || typeof state !== 'object') return d;
    d.tourDone = state.tourDone === true;
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
    return { tourDone: true, tips: tipsAll(true) };
  }
  function withTourDone(state) { var n = normalize(state); n.tourDone = true; return n; }
  function withTipSeen(state, area) {
    var n = normalize(state);
    if (AREAS.indexOf(area) !== -1) n.tips[area] = true;
    return n;
  }
  function shouldRunTour(state) { return normalize(state).tourDone !== true; }
  function shouldRunTip(state, area) {
    var n = normalize(state);
    return n.tourDone === true && AREAS.indexOf(area) !== -1 && n.tips[area] === false;
  }
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
    allSeenState: allSeenState, withTourDone: withTourDone, withTipSeen: withTipSeen,
    shouldRunTour: shouldRunTour, shouldRunTip: shouldRunTip, routeToArea: routeToArea
  };
});

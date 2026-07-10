// Shell controller: runs in app-shell.html (the parent). Owns the bottom-nav spotlight
// tour and the tourDone flag. Renders in the shell so it can highlight the nav bars.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  var KEY = 'gp_walkthrough_state';
  var S = window.gpWalkthroughState, C = window.gpCoach;
  var homeLoaded = false, hydrated = false, ranAuto = false;

  var TABS = [
    { area: 'home', title: 'Home', body: 'Your dashboard — see how far along your registration is, anytime.' },
    { area: 'practice', title: 'My Practice', body: 'Browse GP roles matched to you and accept the one you want.' },
    { area: 'scan', title: 'Scan', body: 'Snap a photo of a document and we verify it for you.' },
    { area: 'support', title: 'Support', body: 'Message our team — replies land right here.' },
    { area: 'account', title: 'Account', body: 'Your profile, details and notification settings.' }
  ];
  var MOBILE = {
    home: '.mobile-nav [data-route="/pages/index"]',
    practice: '.mobile-nav [data-route="/pages/career"]',
    scan: '.mobile-nav [data-qual-scan-trigger]',
    support: '.mobile-nav [data-route="/pages/messages"]',
    account: '.mobile-nav [data-route="/pages/account"]'
  };
  var DESKTOP = {
    home: '.nav-menu [data-route="/pages/index"]',
    practice: '.nav-menu [data-route="/pages/career"]',
    support: '.nav-menu [data-route="/pages/messages"]',
    account: '.nav-menu [data-route="/pages/account"]'
  };
  function navEl(area) {
    var mobile = document.querySelector('.mobile-nav');
    var mobileVisible = mobile && getComputedStyle(mobile).display !== 'none';
    if (mobileVisible) return document.querySelector(MOBILE[area]);
    return DESKTOP[area] ? document.querySelector(DESKTOP[area]) : null; // no scan tab on desktop
  }
  function buildSteps() {
    var out = [];
    for (var i = 0; i < TABS.length; i++) {
      var el = navEl(TABS[i].area);
      if (el) out.push({ target: el, title: TABS[i].title, body: TABS[i].body });
    }
    return out;
  }

  function guarded() {
    try {
      if (localStorage.getItem('gp_account_under_review') === 'true') return true;
      if (localStorage.getItem('gp_account_pep_waitlist') === 'true') return true;
    } catch (e) {}
    if (document.body && document.body.classList.contains('gp-restricted')) return true;
    if (C && C.isActive && C.isActive()) return true;
    return false;
  }
  function readState() { try { return S.parseState(localStorage.getItem(KEY)); } catch (e) { return S.defaultState(); } }
  function markDone() {
    try {
      localStorage.setItem(KEY, S.serializeState(S.withTourDone(readState())));
      if (window.gpLinkStateSync && window.gpLinkStateSync.push) window.gpLinkStateSync.push();
    } catch (e) {}
  }
  function runTour() {
    if (!C || !S || C.isActive()) return;
    var steps = buildSteps();
    if (!steps.length) return;
    C.run(steps, { label: function (i, n) { return 'Step ' + (i + 1) + ' of ' + n; }, onDone: markDone, onSkip: markDone });
  }
  function tryAuto() {
    if (ranAuto || !homeLoaded || !hydrated) return;
    if (guarded()) return;
    ranAuto = true; // decide exactly once (transient guards no longer consume the one shot)
    if (!S.shouldRunTour(readState())) return;
    setTimeout(runTour, 350); // let the nav settle
  }

  if (window.gpLinkStateSync && window.gpLinkStateSync.isHydrated && window.gpLinkStateSync.isHydrated()) { hydrated = true; }
  else {
    window.addEventListener('gp-state-hydrated', function () { hydrated = true; tryAuto(); }, { once: true });
    window.addEventListener('gp-data-ready', function () { hydrated = true; tryAuto(); }, { once: true });
  }
  window.addEventListener('gp-shell-frame-loaded', function (e) {
    if (e && e.detail && e.detail.route === '/pages/index') { homeLoaded = true; tryAuto(); }
  });

  window.gpWalkthroughShell = { runTour: runTour };
  tryAuto();
})();

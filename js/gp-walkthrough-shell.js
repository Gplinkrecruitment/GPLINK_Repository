// Shell controller: runs in app-shell.html (the parent). Owns the bottom-nav spotlight
// tour, the tourDone flag, and the one-off post-tour "start here" pointer
// (nextStepDone). Renders in the shell so it can highlight the nav bars, and
// broadcasts `gp-shell-coach-active` to the content frames so page tips never
// stack under/over a shell overlay (separate documents, separate gpCoach).
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  var KEY = 'gp_walkthrough_state';
  var S = window.gpWalkthroughState, C = window.gpCoach;
  var homeLoaded = false, hydrated = false, ranAuto = false;
  var ranPointer = false, pointerPending = false;

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
  function isShown(el) {
    if (!el) return false;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    // offsetParent is null when the element or an ancestor is display:none
    // (the shell hides nav hosts inline); it is also null for fixed-position
    // elements, so only trust it for non-fixed ones.
    if (el.offsetParent === null && cs.position !== 'fixed') return false;
    return true;
  }
  function navEl(area) {
    var mobile = document.querySelector('.mobile-nav');
    var mobileVisible = mobile && getComputedStyle(mobile).display !== 'none';
    var el = mobileVisible
      ? document.querySelector(MOBILE[area])
      : (DESKTOP[area] ? document.querySelector(DESKTOP[area]) : null); // no scan tab on desktop
    return isShown(el) ? el : null; // never anchor the tour to hidden nav chrome
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
    // Onboarding gateway owns the screen (nav chrome is hidden and the index
    // frame is about to redirect to /pages/onboarding) — never tour over it.
    try { if (localStorage.getItem('gp_onboarding_complete') !== 'true') return true; } catch (e) {}
    try {
      if (localStorage.getItem('gp_account_under_review') === 'true') return true;
      if (localStorage.getItem('gp_account_pep_waitlist') === 'true') return true;
    } catch (e) {}
    if (document.body && document.body.classList.contains('gp-restricted')) return true;
    // The qualification-scan sheet lives in THIS document — never tour over it.
    var scanModal = document.getElementById('gpScanModal');
    if (scanModal && scanModal.classList.contains('open')) return true;
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
  function markNextStepDone() {
    try {
      localStorage.setItem(KEY, S.serializeState(S.withNextStepDone(readState())));
      if (window.gpLinkStateSync && window.gpLinkStateSync.push) window.gpLinkStateSync.push();
    } catch (e) {}
  }

  // ---- Cross-document coordination ----
  // Content pages run their own gpCoach in their own document, so the page's
  // isActive() can't see a shell overlay. Broadcast shell coach activity to ALL
  // frames (not just the active one — a frame that got `true` must always get
  // its `false` even if the GP navigated meanwhile).
  function frames() { return document.querySelectorAll('.app-shell-frame'); }
  function activeFrame() { return document.querySelector('.app-shell-frame.is-active') || frames()[0] || null; }
  function broadcastCoachActive(active) {
    var list = frames();
    for (var i = 0; i < list.length; i++) {
      try {
        if (list[i].contentWindow) list[i].contentWindow.postMessage({ type: 'gp-shell-coach-active', active: active === true }, location.origin);
      } catch (e) {}
    }
  }
  function activeFrameArea() {
    try {
      var f = activeFrame();
      var p = f && f.contentWindow && f.contentWindow.location ? f.contentWindow.location.pathname : '';
      return S.routeToArea(p);
    } catch (e) { return null; }
  }

  // ---- Placement signal (same source pages/index.html uses for the journey) ----
  function readCareerSecured() {
    try {
      var raw = localStorage.getItem('gp_career_state');
      if (!raw) return false;
      var J = window.GPJourneyStages;
      if (J && J.hasCareerSecured) return J.hasCareerSecured(JSON.parse(raw));
    } catch (e) {}
    return false;
  }
  // MyIntealth/EPIC completion — same base signal index.html derives epicDone
  // from (gp_epic_progress → completed.verification_issued). Fail-closed false.
  function readEpicDone() {
    try {
      var raw = localStorage.getItem('gp_epic_progress');
      if (!raw) return false;
      var J = window.GPJourneyStages;
      if (J && J.isEpicDone) return J.isEpicDone(JSON.parse(raw));
    } catch (e) {}
    return false;
  }

  // ---- Post-tour "start here" pointer ----
  // One directed spotlight right after the nav tour (Done or Skip): not yet
  // placed → the My Practice nav item; placed → the MyIntealth journey row
  // inside the home frame (the page controller renders that one). nextStepDone
  // is marked ONLY when the highlighted target is clicked — Escape/"Got it"
  // leaves it pending so it re-arms on the next shell boot.
  function runNextStepPointer() {
    if (!C || !S || C.isActive()) { broadcastCoachActive(false); return; }
    if (guarded() || !S.shouldRunNextStep(readState())) { broadcastCoachActive(false); return; }
    if (readCareerSecured()) {
      broadcastCoachActive(false); // page pointer must not see the shell as active
      // Placed AND MyIntealth already complete (existing users mid-journey):
      // "Start your journey here" on a done step is wrong guidance — retire the
      // pointer permanently and silently. Their start moment has passed.
      if (readEpicDone()) { markNextStepDone(); return; }
      // Placed branch: target lives inside the home page. Hand over to the page
      // controller — but only when home is actually the active route.
      if (activeFrameArea() !== 'home') return; // stays pending; re-arms next boot
      try {
        var f = activeFrame();
        if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'gp-shell-run-next-step', area: 'myintealth' }, location.origin);
      } catch (e) {}
      return;
    }
    var el = navEl('practice');
    if (!el) { broadcastCoachActive(false); return; }
    broadcastCoachActive(true);
    C.run([{
      target: el,
      title: 'Start here',
      body: 'Secure a position first — browse practices matched to you and accept the one you want.'
    }], {
      pointer: true,
      label: function () { return 'Next step'; },
      onTargetClick: markNextStepDone
    }).then(function () { broadcastCoachActive(false); });
  }
  function scheduleNextStepPointer(delay) {
    if (ranPointer || !S) return;
    if (!S.shouldRunNextStep(readState())) return;
    ranPointer = true; // decide once per shell boot (mirrors ranAuto)
    pointerPending = true; // holds the coach-active flag across the tour → pointer gap
    // Boot path (tour already done on an earlier boot): nothing has broadcast
    // coach-active yet, so a page tip could fire during the arm delay and beat
    // the pointer. Broadcast true when ARMING — idempotent after the tour
    // path's own broadcast — and every bail inside runNextStepPointer (plus its
    // run().then) answers with false, mirroring the pointerPending pattern.
    broadcastCoachActive(true);
    setTimeout(function () { pointerPending = false; runNextStepPointer(); }, delay || 600);
  }

  function runTour() {
    if (!C || !S || C.isActive()) return;
    // tryAuto arms this via setTimeout — the screen can be taken over inside
    // that window (e.g. the frame redirects to the onboarding gateway), so
    // re-check the guards at fire time, not just at decision time.
    if (guarded()) return;
    var steps = buildSteps();
    if (!steps.length) return;
    broadcastCoachActive(true);
    var after = function () { markDone(); scheduleNextStepPointer(600); };
    C.run(steps, { label: function (i, n) { return 'Step ' + (i + 1) + ' of ' + n; }, onDone: after, onSkip: after })
      .then(function () {
        // If the pointer is about to run, the shell still owns the screen — keep
        // the flag up so a page tip can't slip in between tour and pointer.
        if (!pointerPending) broadcastCoachActive(false);
      });
  }
  function tryAuto() {
    if (ranAuto || !homeLoaded || !hydrated) return;
    if (guarded()) return;
    ranAuto = true; // decide exactly once (transient guards no longer consume the one shot)
    if (S.shouldRunTour(readState())) { setTimeout(runTour, 350); return; } // new users only
    // Tour finished on an earlier boot but the "start here" pointer is still
    // pending (Escape/Skip last time) — run it once this boot.
    scheduleNextStepPointer(600);
  }

  if (window.gpLinkStateSync && window.gpLinkStateSync.isHydrated && window.gpLinkStateSync.isHydrated()) { hydrated = true; }
  else {
    window.addEventListener('gp-state-hydrated', function () { hydrated = true; tryAuto(); }, { once: true });
    window.addEventListener('gp-data-ready', function () { hydrated = true; tryAuto(); }, { once: true });
  }
  window.addEventListener('gp-shell-frame-loaded', function (e) {
    if (e && e.detail && e.detail.route === '/pages/index') { homeLoaded = true; tryAuto(); }
  });

  window.gpWalkthroughShell = { runTour: runTour, runNextStepPointer: runNextStepPointer };
  tryAuto();
})();

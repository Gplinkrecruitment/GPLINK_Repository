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
  var ranPointer = false, pointerPending = false, tourWaitedForMatch = false;

  // The info pass deliberately EXCLUDES My Practice — the tour now ends on a
  // final interactive step that spotlights the My Practice tab and requires the
  // doctor to actually tap it (owner rule, 2026-09-01): securing a position is
  // the first move, so the tour's last act IS opening the positions page.
  var TABS = [
    { area: 'home', title: 'Home', body: 'Your dashboard — see how far along your registration is, anytime.' },
    { area: 'scan', title: 'Scan', body: 'Snap a photo of a document and we verify it for you.' },
    { area: 'support', title: 'Support', body: 'Message our team — replies land right here.' },
    { area: 'account', title: 'Account', body: 'Your profile, details and notification settings.' }
  ];
  var PRACTICE_FINALE = {
    title: 'My Practice',
    body: 'Tap My Practice to start looking at open GP positions. Securing your position is step one. Every registration step unlocks from there.'
  };
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

  function guarded(ignorePendingMatchCheck) {
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
    // The AI-match popup is a full-viewport takeover in THIS document
    // (js/match-popup.js, `gpmp-open` on <html>). Owner report 2026-08-29: the
    // "Start here" pointer painted straight over it. Its check is async, so
    // block while it is still PENDING too — otherwise the coach can win the
    // race and be on screen before the popup mounts.
    if (document.documentElement.classList.contains('gpmp-open')) return true;
    // ignorePendingMatchCheck: after runTour's wait ceiling the check is
    // TREATED as settled-no-match rather than allowed to eat the mandatory
    // tour (owner report 2026-09-02: a brand-new doctor's first visit lost
    // the tour entirely). A popup actually ON SCREEN still blocks via the
    // gpmp-open class above.
    if (!ignorePendingMatchCheck && window.gpMatchCheck && window.gpMatchCheck.pending === true) return true;
    if (C && C.isActive && C.isActive()) return true;
    return false;
  }
  // A doctor already holding a live match has passed the moment the pointer
  // describes. Fail-closed: only a definite answer retires it.
  function hasLiveMatch() {
    return !!(window.gpMatchCheck && window.gpMatchCheck.pending === false && window.gpMatchCheck.hasLiveMatch === true);
  }
  function readState() { try { return S.parseState(localStorage.getItem(KEY)); } catch (e) { return S.defaultState(); } }
  // Staff "View as GP" must never be trapped in the mandatory first-run tour
  // (and its walkthrough writes never persist for the doctor anyway — the
  // server drops state writes from impersonated sessions). The session profile
  // carries _impersonatedBy; auth-guard caches it in sessionStorage, which the
  // shell and its frames share, so read both. Fail toward NOT impersonated —
  // a real doctor must never get a skippable "mandatory" tour by accident.
  function isImpersonated() {
    try { if (window.gpSessionProfile && window.gpSessionProfile._impersonatedBy) return true; } catch (e) {}
    try {
      var raw = sessionStorage.getItem('gp_session_profile_cache');
      if (raw && JSON.parse(raw)._impersonatedBy) return true;
    } catch (e) {}
    return false;
  }
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
    // Already matched to a practice: "Start here — secure a position first" is
    // stale guidance, so retire the pointer permanently instead of showing it.
    // Owner report 2026-08-29 (Dr Deepika): her state carried tourDone:true but
    // no nextStepDone key, so the pointer re-armed on EVERY boot — "Got it"
    // only ever dismissed it for that page load — while she already had a live
    // match waiting. Checked before readCareerSecured because a match arrives
    // long before a placement is secured.
    if (hasLiveMatch()) {
      broadcastCoachActive(false);
      markNextStepDone();
      return;
    }
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
      onTargetClick: markNextStepDone,
      // "Got it" used to mark nothing, so a doctor who dismissed the pointer
      // met it again on every single login, forever — the owner reported it as
      // the walkthrough "reappearing after it was completed". An explicit
      // dismissal is an answer; honour it. Covers Escape too (gpCoach routes
      // both through skip()). The one path that must still leave it pending is
      // a target that vanished mid-run — that ends via cleanup('lost'), which
      // deliberately calls neither onDone nor onSkip.
      onSkip: markNextStepDone
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
    setTimeout(function () {
      // js/match-popup.js is still asking whether this doctor has a match.
      // Deciding now would be a coin toss between "pointer over the popup" and
      // "pointer that should never have run", so wait for its answer — with a
      // ceiling so a hung/failed request can't strand the pointer for good.
      if (window.gpMatchCheck && window.gpMatchCheck.pending === true) {
        var settled = false;
        var go = function () {
          if (settled) return;
          settled = true;
          window.removeEventListener('gp-match-check-done', go);
          pointerPending = false;
          runNextStepPointer();
        };
        window.addEventListener('gp-match-check-done', go);
        setTimeout(go, 4000);
        return;
      }
      pointerPending = false;
      runNextStepPointer();
    }, delay || 600);
  }

  function runTour(afterMatchWait) {
    if (!C || !S || C.isActive()) return;
    // js/match-popup.js is still asking whether this doctor has a match. On a
    // fresh sign-in /api/state answers from the auth pre-warm cache, so the
    // hydrate that arms this tour routinely beats the slower matches call —
    // and guarded() reads pending as a block, silently spending the one shot
    // (ranAuto is already true). That boot IS the first login, the one a new
    // doctor is owed the tour on (owner report 2026-09-01). Wait for the
    // answer like scheduleNextStepPointer does, ceiling included, then
    // re-check every guard at the real fire time.
    if (!afterMatchWait && window.gpMatchCheck && window.gpMatchCheck.pending === true) {
      if (tourWaitedForMatch) return; // a second waiter is already queued
      tourWaitedForMatch = true;
      var settled = false;
      var go = function () {
        if (settled) return;
        settled = true;
        window.removeEventListener('gp-match-check-done', go);
        // Owner 2026-09-02: the old path gave up here when the check was
        // still pending, and a brand-new doctor's first visit lost the
        // MANDATORY tour entirely ("re-arms next boot" is worthless on the
        // one visit that matters). After the ceiling the check is treated
        // as settled-no-match; an actual popup on screen still blocks via
        // gpmp-open inside guarded().
        runTour(true);
      };
      window.addEventListener('gp-match-check-done', go);
      setTimeout(go, 4000);
      return;
    }
    // tryAuto arms this via setTimeout — the screen can be taken over inside
    // that window (e.g. the frame redirects to the onboarding gateway), so
    // re-check the guards at fire time, not just at decision time.
    if (guarded(afterMatchWait === true)) return;
    var steps = buildSteps();
    if (!steps.length) return;
    // First real run is MANDATORY (owner rule, 2026-09-01): no Skip, no Escape.
    // Replays (Account → "Replay the app tour") and staff "View as GP" stay
    // skippable. gpCoach's cancel/lost teardowns still apply and mark nothing,
    // so a genuine screen takeover re-arms the tour instead of trapping anyone.
    var mandatory = S.shouldRunTour(readState()) && !isImpersonated();
    broadcastCoachActive(true);
    var after = function () { markDone(); scheduleNextStepPointer(600); };
    C.run(steps, {
      label: function (i, n) { return 'Step ' + (i + 1) + ' of ' + (n + 1); }, // +1 = the My Practice finale
      mandatory: mandatory,
      doneLabel: 'Next', // the My Practice finale follows — this pass never ends the tour
      onSkip: after // only reachable when not mandatory
    }).then(function (reason) {
        if (reason === 'done') { runPracticeFinale(mandatory); return; }
        // If the pointer is about to run, the shell still owns the screen — keep
        // the flag up so a page tip can't slip in between tour and pointer.
        if (!pointerPending) broadcastCoachActive(false);
      });
  }
  // Final interactive step: spotlight the My Practice tab and require the tap.
  // The click both completes the tour AND navigates to the careers page (the
  // coach never preventDefaults, so the nav item's own data-route handling
  // runs). Completing this way also retires the post-tour "start here" pointer
  // — its guidance (go to My Practice) was just followed for real.
  function runPracticeFinale(mandatory) {
    var el = navEl('practice');
    if (!el) {
      // Nav chrome vanished mid-tour (gateway takeover etc.) — never trap the
      // doctor. Leave the tour UNMARKED so it re-arms on the next boot.
      if (!pointerPending) broadcastCoachActive(false);
      return;
    }
    C.run([{
      target: el,
      title: PRACTICE_FINALE.title,
      body: PRACTICE_FINALE.body
    }], {
      pointer: true,
      mandatory: mandatory,
      label: function () { return 'Last step'; },
      onTargetClick: function () { markDone(); markNextStepDone(); },
      // Replay / "View as" dismissal (never reachable when mandatory): count the
      // tour as done and fall back to the old post-tour pointer behaviour.
      onSkip: function () { markDone(); scheduleNextStepPointer(600); }
    }).then(function () {
      if (!pointerPending) broadcastCoachActive(false);
    });
  }
  function tryAuto() {
    if (ranAuto || !homeLoaded || !hydrated) return;
    if (guarded()) return;
    ranAuto = true; // decide exactly once (transient guards no longer consume the one shot)
    if (S.shouldRunTour(readState())) {
      setTimeout(runTour, 350);
      // Same-visit watchdog (owner 2026-09-02): if ANY transient state ate
      // the attempt above, the mandatory tour tries once more THIS visit —
      // never deferred to a next boot a new doctor may not make. runTour
      // re-checks every real guard; C.isActive() makes this a no-op when the
      // tour (or its finale) is already on screen, and shouldRunTour makes it
      // a no-op once done.
      setTimeout(function () {
        if (S.shouldRunTour(readState()) && C && !C.isActive()) runTour(true);
      }, 8000);
      return;
    } // new users only
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
  // The match check settling is the one boot-time guard that clears by itself,
  // and hydrate/home-load are {once:true} — if both fired while it was still
  // pending, nothing ever asked again and a brand-new doctor's tour was
  // silently lost for the visit. Ask again when it answers; ranAuto keeps
  // this idempotent, and guarded() is false now the check has settled.
  window.addEventListener('gp-match-check-done', function () { tryAuto(); });

  window.gpWalkthroughShell = { runTour: runTour, runNextStepPointer: runNextStepPointer };
  tryAuto();
  // Boot watchdog (owner 2026-09-02): the arming events (state hydrate, home
  // frame load) are {once:true} — if this script lost the race to their
  // dispatch, nothing would ever arm and a brand-new doctor's first visit
  // silently lost the mandatory tour. Force one evaluation; guarded() still
  // vetoes the onboarding gateway, restricted mode and a live match popup,
  // and ranAuto keeps this a no-op when the normal path already ran.
  setTimeout(function () {
    if (!ranAuto && S && S.shouldRunTour(readState())) {
      homeLoaded = true;
      hydrated = true;
      tryAuto();
    }
  }, 7000);
})();

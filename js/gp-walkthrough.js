// Page controller: runs INSIDE each content page's iframe. Owns per-page first-visit
// mini-tours. Reads/writes the shared gp_walkthrough_state via localStorage + state-sync.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  var KEY = 'gp_walkthrough_state';
  var S = window.gpWalkthroughState, C = window.gpCoach;

  function guarded() {
    // Onboarding not complete: index.html's pre-paint gate hides the body while
    // it confirms with the server, and a tip fired then would be marked seen
    // without ever being visible. Same guard as the shell controller.
    try { if (localStorage.getItem('gp_onboarding_complete') !== 'true') return true; } catch (e) {}
    try {
      if (localStorage.getItem('gp_account_under_review') === 'true') return true;
      if (localStorage.getItem('gp_account_pep_waitlist') === 'true') return true;
    } catch (e) {}
    if (document.body && document.body.classList.contains('gp-restricted')) return true;
    if (C && C.isActive && C.isActive()) return true;
    return false;
  }
  function readState() { try { return S.parseState(localStorage.getItem(KEY)); } catch (e) { return S.defaultState(); } }
  function markSeen(area) {
    try {
      localStorage.setItem(KEY, S.serializeState(S.withTipSeen(readState(), area)));
      if (window.gpLinkStateSync && window.gpLinkStateSync.push) window.gpLinkStateSync.push();
    } catch (e) {}
  }
  function markNextStepDone() {
    try {
      localStorage.setItem(KEY, S.serializeState(S.withNextStepDone(readState())));
      if (window.gpLinkStateSync && window.gpLinkStateSync.push) window.gpLinkStateSync.push();
    } catch (e) {}
  }

  // ---- Deferral: a tip must never fire (or be marked seen) while something else
  // owns the screen. Blockers today: the career CV gate modal in THIS document,
  // a shell coach run (tour / pointer) in the PARENT document — separate
  // documents mean the page's C.isActive() can't see the shell's overlay, so the
  // shell broadcasts `gp-shell-coach-active` messages instead — and this page
  // being loaded invisibly in the shell's hidden warm frame. Add future gates
  // to pageBlocked().
  var shellCoachActive = false;
  // The app shell preloads routes into a hidden second iframe; a tip fired in
  // there marks itself seen without ever being visible. Measured in Chrome:
  // a display:none host reports a 0x0 viewport inside (documentElement
  // clientWidth/clientHeight AND innerWidth all 0), but the shell's warm frame
  // is opacity:0 at FULL size — the only in-frame signal for it is the host
  // iframe's computed style, readable same-origin via window.frameElement.
  function frameHidden() {
    try {
      var de = document.documentElement;
      if (de && de.clientWidth === 0 && de.clientHeight === 0) return true; // display:none host
      var fe = window.frameElement; // null standalone; throws cross-origin (fail open)
      if (fe) {
        var pv = fe.ownerDocument && fe.ownerDocument.defaultView;
        var cs = pv && pv.getComputedStyle ? pv.getComputedStyle(fe) : null;
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0)) return true;
      }
    } catch (e) {}
    return false;
  }
  var SCRIPT_VERSION = '20260915e';
  function pageBlocked() {
    if (shellCoachActive) return true;
    if (frameHidden()) return true; // hidden warm frame — defer unmarked
    // A background tab paints nothing the doctor can see.
    try { if (document.visibilityState === 'hidden') return true; } catch (e) {}
    // Shell-level takeovers the page cannot otherwise see (the coach-active
    // message is a snapshot a late-loading frame never receives): the match /
    // interview / contract popups, a slide deck, the shell's own coach.
    try {
      var pd = (window.parent && window.parent !== window) ? window.parent.document : null;
      if (pd && pd.querySelector('#gpMatchPopup, #gpInterviewPopup, #gpContractPopup, .gp-intro-card, .gp-coach-overlay')) return true;
    } catch (e) { /* cross-origin parent: nothing to see */ }
    try {
      // First-visit careers explainer (pages/career.html): a full-screen page
      // ahead of the CV gate. Owner rule 2026-07-31 — the walkthrough must not
      // start until the doctor has closed this AND uploaded their CV, so it is
      // a blocker in exactly the same way the gate below is.
      if (document.body && document.body.classList.contains('career-intro-open')) return true;
      if (document.querySelector('.career-intro.is-open')) return true;
      // Career CV gate (pages/career.html): full-screen modal until CV verified.
      if (document.body && document.body.classList.contains('career-gate-open')) return true;
      var gate = document.querySelector('.career-gate-modal.is-open');
      if (gate) return true;
    } catch (e) {}
    return false;
  }
  var deferRetry = { armed: false, timer: null, poll: null };
  function scheduleRetry() {
    // Collapse multiple wake-ups into one re-check, ~500ms so the page settles.
    if (deferRetry.timer) return;
    deferRetry.timer = setTimeout(function () { deferRetry.timer = null; maybeRun(); }, 500);
  }
  function armRetry() {
    if (deferRetry.armed) return;
    deferRetry.armed = true;
    function disarm() {
      deferRetry.armed = false;
      window.removeEventListener('gp-career-gate-closed', fire);
      window.removeEventListener('gp-career-intro-closed', fire);
      window.removeEventListener('resize', fire);
      window.removeEventListener('gp-career-updated', fire);
      document.removeEventListener('visibilitychange', fire);
      if (deferRetry.frameObs) { try { deferRetry.frameObs.disconnect(); } catch (e) {} deferRetry.frameObs = null; }
      if (deferRetry.poll) { clearInterval(deferRetry.poll); deferRetry.poll = null; }
    }
    function fire() { disarm(); careerStepsAttempts = 0; scheduleRetry(); }
    // Primary signal: the career gate announces its close.
    window.addEventListener('gp-career-gate-closed', fire);
    // The explainer announces its own close the same way. Re-checking is what
    // matters, not which screen closed: the CV gate usually opens straight
    // after this one, and pageBlocked() will simply defer again.
    window.addEventListener('gp-career-intro-closed', fire);
    // Warm-frame wake-ups (measured in Chrome): a display:none host firing to
    // visible resizes this window 0x0 → real size, so 'resize' catches it; the
    // shell's opacity:0 warm frame NEVER resizes on activation — the is-active
    // class/style flip on the host iframe (same-origin) is the only signal.
    window.addEventListener('resize', fire);
    // The strip re-renders on every state persist; a tab coming back to the
    // foreground is when a hidden-tab deferral should be re-checked.
    window.addEventListener('gp-career-updated', fire);
    document.addEventListener('visibilitychange', fire);
    try {
      var fe = window.frameElement;
      if (fe && typeof MutationObserver !== 'undefined') {
        deferRetry.frameObs = new MutationObserver(fire);
        deferRetry.frameObs.observe(fe, { attributes: true, attributeFilter: ['class', 'style'] });
      }
    } catch (e) {}
    // Fallback: gates that close without the event — poll the blocked state for
    // up to ~60s, then give up (a fresh maybeRun() will re-arm if still blocked).
    var deadline = Date.now() + 60000;
    deferRetry.poll = setInterval(function () {
      if (!pageBlocked()) { fire(); return; }
      if (Date.now() > deadline) {
        // Stop burning the poll after a minute, but KEEP the event-driven
        // wake-ups armed: a doctor who leaves the CV gate open longer than
        // that must still get the tour when it closes (owner 2026-09-15).
        clearInterval(deferRetry.poll); deferRetry.poll = null;
      }
    }, 1000);
  }

  var HOME = [
    { target: '.glass-progress', title: 'Your journey', body: 'Every registration stage sits here — green is done, blue is your current step.' },
    { target: '#hero-next-action', title: 'Your next move', body: 'Your single next action is always shown here. Tap it to jump straight in.' },
    { target: '#journeyList', title: 'The full path', body: 'Scroll to see every step ahead, from MyIntealth through to starting work.' }
  ];
  var ACCOUNT = [
    { target: '.account-hero', title: 'Your profile', body: 'Your details and how complete your profile is, at a glance.' },
    { target: '#panel-home .section-card', title: 'Settings & quick links', body: 'Update your details, notifications and privacy from here.' }
  ];
  // Careers page tutorial (owner 2026-09-15: "There should be a tutorial once
  // the GP gets to the career page (despite if cv has been uploaded or skipped)
  // which highlights each step eg 1. Find your practice, 2. Interview, etc
  // with more information on what the step is and what it then unlocks").
  // Spotlights the four steps of the masthead strip in order. It runs once
  // (careerStepsSeen — its OWN flag: the other page tips wait for the tab
  // tour, which never runs in the two-tab position phase) the first time the
  // page is on screen; the careers explainer and the CV gate only DEFER it
  // (pageBlocked → armRetry), so it fires after "Skip for now" exactly as
  // after an upload.
  var CAREER_STEPS = [
    { target: '[data-career-step="1"]', timeout: 8000, title: '1. Find your practice',
      body: 'Every practice on the map is one you are already eligible for. Browse the roles, save the ones you like, then apply or send an enquiry — your Registration Support Officer introduces you with your CV. Unlocks: the moment a practice wants to meet you, step 2 opens.' },
    { target: '[data-career-step="2"]', timeout: 8000, title: '2. Interview',
      body: 'The practice shares its available times and you pick one straight from your application card: 30 minutes on Zoom, with your Registration Support Officer on the call so you are never in the room alone. Unlocks: a good interview leads to an offer.' },
    { target: '[data-career-step="3"]', timeout: 8000, title: '3. Offer & contract',
      body: 'The practice makes its offer and sends the employment agreement. We check it with you, you can ask for changes, and you sign it here in the app. Unlocks: signing secures your position.' },
    { target: '[data-career-step="4"]', timeout: 8000, title: '4. Registration',
      body: 'With your position secured the app grows — Home, My Documents and Support appear — and your personalised registration pathway begins: MyIntealth, AMC, AHPRA, visa and Medicare, each unlocking in order with your team guiding every step.' }
  ];
  // Practice & Support are empty for brand-new GPs, so adapt: walk live cards if present,
  // otherwise a single tip on the static container explaining what will appear.
  function stepsFor(area) {
    if (area === 'home') return HOME;
    if (area === 'account') return ACCOUNT;
    if (area === 'practice') {
      // The step strip is on screen until a position is secured — walk it.
      if (document.querySelector('[data-career-step="1"]')) return CAREER_STEPS.slice();
      if (document.querySelector('.at-match-pin')) return [
        { target: '.at-match-pin', title: 'Roles matched to you', body: 'Each match is scored against your profile — higher means a better fit.' },
        { target: '.at-match-accept', title: 'Review & accept', body: 'Open a match to meet the practice, then accept the one you want.' }
      ];
      return [{ target: '#teamMatchesSection', title: 'Roles matched to you', body: 'When we match you to a practice it appears here — ready to review and accept.' }];
    }
    if (area === 'support') {
      if (document.querySelector('.chat-card')) return [
        { target: '#chatList', title: 'Your conversations', body: 'Every chat with your GP Link team lives here.' },
        { target: '.chat-card', title: 'Open a conversation', body: 'Tap a chat to read replies and message back — we reply within a day.' }
      ];
      return [{ target: '#chatList', title: 'Message us any time', body: 'Your conversations with the GP Link team appear here — tap to start one.' }];
    }
    return [];
  }

  function firstVisitLabel(i, n) { return n > 1 ? ('First-visit · ' + (i + 1) + '/' + n) : 'First-visit tip'; }

  function runArea(area) {
    if (!area || !C || !S) return;
    var steps = stepsFor(area);
    if (!steps.length) return;
    C.run(steps, { label: firstVisitLabel }).then(function (reason) {
      if (area === 'home' && reason === 'done') openCurrentJourneyStep();
    });
  }
  // Owner 2026-09-10: "when i click done on the walkthrough it does not take
  // me straight to myintealth step". Home's first-visit tour ends on the
  // journey list, so "Done" opens the doctor's current step — the row's own
  // Continue target (MyIntealth for a newly placed doctor; the shell shows the
  // registration intro the first time). Skip and Escape leave them on Home; a
  // doctor who has not secured a position yet has nothing to open here.
  function openCurrentJourneyStep() {
    var row = document.querySelector('[data-journey-step].current')
      || document.querySelector('[data-journey-step].is-current')
      || document.querySelector('[data-journey-step="myinthealth"]');
    if (!row || row.classList.contains('done')) return;
    var cta = row.querySelector('.journey-body-cta[data-route]');
    var route = cta ? String(cta.getAttribute('data-route') || '') : '';
    if (!route || route === '/pages/career') return;
    try {
      if (window.parent && window.parent !== window && typeof window.parent.gpShellNavigate === 'function') { window.parent.gpShellNavigate(route, { replace: false }); return; }
    } catch (e) {}
    try { if (typeof window.gpShellNavigate === 'function') { window.gpShellNavigate(route, { replace: false }); return; } } catch (e) {}
    window.location.href = route;
  }
  // Priority rule: the one-off "start here" pointer ALWAYS outranks the generic
  // home tip. The shell may ask this page to run the pointer at any moment after
  // boot (its ~600ms arm delay races the hydration+250ms home tip), so while the
  // pointer is still pending the home tip defers, unmarked — deterministic
  // regardless of message timing. scheduleRetry() re-checks: pointer clicked →
  // nextStepDone → the home tip runs ~500ms later; pointer dismissed (Got it /
  // Escape, deliberately NOT marked) → the home tip stays deferred this boot and
  // the pointer keeps its priority on the next boot.
  function homeTipYields(area) {
    return area === 'home' && S.shouldRunNextStep(readState());
  }
  function markCareerStepsSeen() {
    try {
      localStorage.setItem(KEY, S.serializeState(S.withCareerStepsSeen(readState())));
      if (window.gpLinkStateSync && window.gpLinkStateSync.push) window.gpLinkStateSync.push();
    } catch (e) {}
  }
  // The careers step tutorial. Returns true when it took this boot (ran, or
  // deferred behind a gate and armed a retry) so the generic tip stays out
  // of its way; false when there is nothing to do (seen, or no strip —
  // i.e. a position is already secured).
  // The strip li exists before the strip is shown (the host starts hidden and
  // renderCareerStepStrip reveals it), and the coach treats a zero-size target
  // as lost. Wait for a real box before spotlighting it.
  function careerStripVisible() {
    var el = document.querySelector('[data-career-step="1"]');
    if (!el) return false;
    var host = document.getElementById('careerStepStrip');
    if (host && host.hidden) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  var careerStepsAttempts = 0;
  var careerStepsRunning = false;
  var careerStepsLog = [];
  function csLog(what, extra) {
    var entry = { t: Math.round(performance.now()), what: what, extra: extra || null };
    careerStepsLog.push(entry);
    try { console.info('[walkthrough] career steps:', what, extra || ''); } catch (e) {}
    // Persisted trail (last 20 decisions, synced to the doctor's user_state as
    // gp_career_steps_diag) so a "it never showed" report can be read from the
    // server instead of guessed at.
    try {
      var trail = JSON.parse(localStorage.getItem('gp_career_steps_diag') || '[]');
      if (!Array.isArray(trail)) trail = [];
      trail.push({ at: new Date().toISOString(), v: SCRIPT_VERSION, what: what, extra: extra || null });
      localStorage.setItem('gp_career_steps_diag', JSON.stringify(trail.slice(-20)));
    } catch (e) {}
  }
  function maybeRunCareerSteps() {
    if (!S || !C || typeof S.shouldRunCareerSteps !== 'function') { csLog('no-modules'); return false; }
    if (!S.shouldRunCareerSteps(readState())) { csLog('already-seen'); return false; }
    if (!document.querySelector('[data-career-step="1"]')) { csLog('no-strip'); return false; }
    if (pageBlocked()) { csLog('blocked-defer'); armRetry(); return true; } // defer — deliberately BEFORE marking seen
    setTimeout(function () {
      if (guarded()) { csLog('guarded'); return; }
      if (pageBlocked()) { csLog('blocked-defer-late'); armRetry(); return; }
      if (!S.shouldRunCareerSteps(readState())) { csLog('already-seen-late'); return; }
      if (!careerStripVisible()) {
        csLog('strip-not-visible', { attempt: careerStepsAttempts });
        // Not on screen yet (or a warm frame): look again shortly, a few times.
        if (careerStepsAttempts++ < 12) setTimeout(maybeRunCareerSteps, 700);
        return;
      }
      if (careerStepsRunning || (C.isActive && C.isActive())) { csLog('already-running'); return; }
      // Seen is recorded only when the doctor finishes or skips the tour —
      // never when it starts. Marking at start burned the one shot whenever
      // the tab was reloaded mid-tour or the tip was drawn behind something
      // (owner 2026-09-15: "reloaded 2 times and still not showing" — the
      // server had careerStepsSeen:true stamped seconds after each load).
      // Double-fire within a page is prevented by careerStepsRunning + the
      // coach's own active flag; across page loads a tour the doctor never
      // finished simply comes back.
      careerStepsRunning = true;
      csLog('run');
      C.run(CAREER_STEPS.slice(), { label: firstVisitLabel }).then(function (reason) {
        careerStepsRunning = false;
        csLog('outcome', { reason: reason });
        if (reason === 'done' || reason === 'skip' || reason === 'target') { markCareerStepsSeen(); return; }
        // 'busy' (another coach), 'empty', 'lost' (target vanished before the
        // first tip drew) and 'cancel' mean nothing was shown: try again
        // shortly, this visit.
        try { console.info('[walkthrough] career steps tutorial did not show (' + reason + ') — will retry'); } catch (e) {}
        if (careerStepsAttempts++ < 12) setTimeout(maybeRunCareerSteps, 3000);
      });
    }, 250);
    return true;
  }
  function maybeRun() {
    if (!S || !C) return;
    var area = S.routeToArea(location.pathname);
    if (!area) return;
    if (guarded()) return;
    if (area === 'practice' && maybeRunCareerSteps()) return;
    if (!S.shouldRunTip(readState(), area)) return;
    if (homeTipYields(area)) return; // defer unmarked — retried via scheduleRetry()
    if (pageBlocked()) { armRetry(); return; } // defer — deliberately BEFORE markSeen
    // Small settle delay (fonts/layout), then re-check the blockers so a gate or
    // coach that appeared meanwhile defers again instead of eating the tip.
    setTimeout(function () {
      if (guarded()) return;
      if (homeTipYields(area)) return;
      if (pageBlocked()) { armRetry(); return; }
      if (!S.shouldRunTip(readState(), area)) return;
      markSeen(area);        // mark BEFORE running so it can never double-fire
      runArea(area);
    }, 250);
  }

  // Post-tour "start here" pointer, placed branch: the shell asks this page (home)
  // to spotlight the MyIntealth journey row. Click-through pointer: tapping the row
  // performs its normal action AND marks the pointer done; Escape/"Got it" leaves
  // it pending so it re-arms on the next shell boot.
  function runNextStepPointer() {
    if (!S || !C) return;
    if (C.isActive()) return;
    if (guarded() || pageBlocked()) return;
    if (!S.shouldRunNextStep(readState())) return;
    // Belt and braces vs message races: if the rendered MyIntealth row is
    // already in its "done" state (the row builder's state class, which also
    // reflects admin stage overrides), never spotlight it as a starting point —
    // retire the pointer permanently instead.
    var row = document.querySelector('[data-journey-step="myinthealth"]');
    if (row && row.classList.contains('done')) { markNextStepDone(); return; }
    C.run([{
      target: '[data-journey-step="myinthealth"]',
      timeout: 8000, // cold journey-list renders can outlive the default 4s wait
      title: 'Start your journey here',
      // The MyIntealth row is already expanded (it IS the current step), so the
      // copy must not claim the tap will "open" anything — tapping toggles it.
      body: "Begin with MyIntealth — this is your first step. Tap it when you're ready."
    }], {
      pointer: true,
      label: function () { return 'Next step'; },
      onTargetClick: markNextStepDone
    }).then(function () { scheduleRetry(); }); // a deferred tip (e.g. home) can now run
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin) return;
    var d = e.data;
    if (!d || !d.type) return;
    if (d.type === 'gp-shell-coach-active') {
      shellCoachActive = d.active === true;
      if (!shellCoachActive) scheduleRetry(); // shell overlay gone — re-check deferred tips
      return;
    }
    if (d.type === 'gp-shell-run-next-step') runNextStepPointer();
  });

  // Replay entry (Account row): ask the shell to run the nav tour.
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-walkthrough-replay]') : null;
    if (!el) return;
    e.preventDefault();
    try { window.parent.postMessage({ type: 'gp-shell-run-tour' }, location.origin); } catch (err) {}
  });

  function boot() {
    if (window.gpLinkStateSync && window.gpLinkStateSync.isHydrated && window.gpLinkStateSync.isHydrated()) { maybeRun(); return; }
    window.addEventListener('gp-state-hydrated', maybeRun, { once: true });
    window.addEventListener('gp-data-ready', function () { setTimeout(maybeRun, 60); }, { once: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.gpWalkthrough = { maybeRun: maybeRun, runArea: runArea, runNextStepPointer: runNextStepPointer, careerStepsLog: careerStepsLog };
})();

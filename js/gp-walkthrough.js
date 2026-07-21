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

  var HOME = [
    { target: '.glass-progress', title: 'Your journey', body: 'Every registration stage sits here, green is done, blue is your current step.' },
    { target: '#hero-next-action', title: 'Your next move', body: 'Your single next action is always shown here. Tap it to jump straight in.' },
    { target: '#journeyList', title: 'The full path', body: 'Scroll to see every step ahead, from MyIntealth through to starting work.' }
  ];
  var ACCOUNT = [
    { target: '.account-hero', title: 'Your profile', body: 'Your details and how complete your profile is, at a glance.' },
    { target: '#panel-home .section-card', title: 'Settings & quick links', body: 'Update your details, notifications and privacy from here.' }
  ];
  // Practice & Support are empty for brand-new GPs, so adapt: walk live cards if present,
  // otherwise a single tip on the static container explaining what will appear.
  function stepsFor(area) {
    if (area === 'home') return HOME;
    if (area === 'account') return ACCOUNT;
    if (area === 'practice') {
      if (document.querySelector('.at-match-pin')) return [
        { target: '.at-match-pin', title: 'Roles matched to you', body: 'Each match is scored against your profile, higher means a better fit.' },
        { target: '.at-match-accept', title: 'Review & accept', body: 'Open a match to meet the practice, then accept the one you want.' }
      ];
      return [{ target: '#teamMatchesSection', title: 'Roles matched to you', body: 'When we match you to a practice it appears here, ready to review and accept.' }];
    }
    if (area === 'support') {
      if (document.querySelector('.chat-card')) return [
        { target: '#chatList', title: 'Your conversations', body: 'Every chat with your GP Link team lives here.' },
        { target: '.chat-card', title: 'Open a conversation', body: 'Tap a chat to read replies and message back, we reply within a day.' }
      ];
      return [{ target: '#chatList', title: 'Message us any time', body: 'Your conversations with the GP Link team appear here, tap to start one.' }];
    }
    return [];
  }

  function firstVisitLabel(i, n) { return n > 1 ? ('First-visit · ' + (i + 1) + '/' + n) : 'First-visit tip'; }

  function runArea(area) {
    if (!area || !C || !S) return;
    var steps = stepsFor(area);
    if (!steps.length) return;
    C.run(steps, { label: firstVisitLabel });
  }
  function maybeRun() {
    if (!S || !C) return;
    var area = S.routeToArea(location.pathname);
    if (!area) return;
    if (guarded()) return;
    if (!S.shouldRunTip(readState(), area)) return;
    markSeen(area);          // mark BEFORE running so it can never double-fire
    runArea(area);
  }

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

  window.gpWalkthrough = { maybeRun: maybeRun, runArea: runArea };
})();

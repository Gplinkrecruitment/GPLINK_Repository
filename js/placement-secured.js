/*
 * Placement secured → the doctor's view moves to the registration pathway
 * (owner 2026-09-10: "so the offer was accepted. Now we need to change the
 * gps view to the registration pathway").
 *
 * The server flips the application to placement_secured, writes the
 * placements row and its own copy of gp_career_state the moment the signed
 * agreement is finalised — but the browser kept painting from its cached
 * copies: gp-cache served the pre-signing applications payload for ten
 * minutes, the saved career state still said "finalising", and the shell's
 * phase (which is derived from that saved state) stayed at "position" — so
 * the nav kept only My Practice + Account and Home stayed hidden.
 *
 * applyPlacementSecured() is called by pages/offer-review.html the moment the
 * server confirms placementSecured (and whenever it renders an already-secured
 * contract): it marks the saved copy secured (the shell listens to that
 * storage key and moves to the registration phase at once), drops every
 * cached career payload, flags the list dirty for the next cold load, and
 * tells the shell and every open frame.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.gpPlacementSecured = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var CAREER_STATE_KEY = 'gp_career_state';

  // Pure: returns the saved career state with the application marked secured
  // (and the whole state marked career_secured), or a minimal secured state
  // when nothing was saved. Never throws on garbage input.
  function markSecured(raw, applicationId, info, nowIso) {
    var state = null;
    try { state = raw && typeof raw === 'object' ? raw : (raw ? JSON.parse(String(raw)) : null); } catch (e) { state = null; }
    if (!state || typeof state !== 'object') state = {};
    var id = String(applicationId || '');
    var apps = Array.isArray(state.applications) ? state.applications : [];
    var found = false;
    apps.forEach(function (app) {
      if (!app || typeof app !== 'object' || String(app.id || app.applicationId || '') !== id) return;
      found = true;
      app.isPlacementSecured = true;
      app.rawStatus = 'placement_secured';
      app.statusLabel = 'Practice secured';
      app.status = 'Practice secured';
      app.statusTone = 'secured';
      app.tone = 'secured';
      app.contractStage = 'signed';
      app.offerPending = false;
      if (info && typeof info === 'object') {
        if (info.practiceName && !app.practiceName) app.practiceName = String(info.practiceName);
        if (info.placement && typeof info.placement === 'object' && !app.placement) app.placement = info.placement;
      }
    });
    state.applications = apps;
    state.career_secured = true;
    state.activeView = 'secured';
    state.showSavedOnly = false;
    state.updatedAt = nowIso || new Date().toISOString();
    return { state: state, applicationFound: found };
  }

  function applyPlacementSecured(win, applicationId, info) {
    var w = win || window;
    var out = { applicationId: String(applicationId || ''), savedCopy: false, applicationFound: false, cacheCleared: false, frames: 0 };
    // 1. The saved copy — the shell derives the doctor's phase from it and
    //    reacts to this storage key, so this single write is what moves the
    //    nav to the registration pathway.
    try {
      var raw = w.localStorage.getItem(CAREER_STATE_KEY);
      var marked = markSecured(raw, applicationId, info);
      w.localStorage.setItem(CAREER_STATE_KEY, JSON.stringify(marked.state));
      out.savedCopy = true;
      out.applicationFound = marked.applicationFound;
    } catch (e) {}
    // 2. Every cached career payload, in this frame and the shell above it.
    [w, (function () { try { return w.parent && w.parent !== w ? w.parent : null; } catch (e) { return null; } })()].forEach(function (ctx) {
      if (!ctx) return;
      try {
        var gc = ctx.gpCache;
        if (gc && typeof gc.invalidatePrefix === 'function') { gc.invalidatePrefix('/api/career/'); out.cacheCleared = true; }
        if (gc && typeof gc.invalidate === 'function') gc.invalidate(['/api/career/applications', '/api/career/roles', '/api/state']);
      } catch (e) {}
    });
    try { w.sessionStorage.setItem('gp_career_apps_dirty', '1'); } catch (e) {}
    // 3. Tell the shell and every open page frame.
    var msg = { type: 'gp-placement-secured', applicationId: out.applicationId };
    var origin = '';
    try { origin = w.location.origin; } catch (e) {}
    var top = null;
    try { top = (w.parent && w.parent !== w) ? w.parent : w; } catch (e) { top = w; }
    try { if (top !== w) top.postMessage(msg, origin || '/'); } catch (e) {}
    var frames = [];
    try { frames = Array.prototype.slice.call(top.document.querySelectorAll('iframe')); } catch (e) {}
    frames.forEach(function (f) {
      try { if (f.contentWindow && f.contentWindow !== w) { f.contentWindow.postMessage(msg, origin || '/'); out.frames++; } } catch (e) {}
    });
    try { w.dispatchEvent(new CustomEvent('gp-placement-secured', { detail: msg })); } catch (e) {}
    return out;
  }

  return {
    CAREER_STATE_KEY: CAREER_STATE_KEY,
    markSecured: markSecured,
    applyPlacementSecured: applyPlacementSecured
  };
}));

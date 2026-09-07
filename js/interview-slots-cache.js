/*
 * Interview slot cache (owner 2026-09-08: "everytime a page is switched then
 * interview times start loading again, keep this cached so it loads
 * instantly").
 *
 * The slots call is slow (diary + calendar lookups, ~9 s from Australia), so
 * the card picker and the full-page popup both paint from this sessionStorage
 * cache the moment they render and refresh quietly in the background
 * (stale-while-revalidate). sessionStorage is shared by the shell document
 * and its page frames (same origin), and dies with the tab. A booking clears
 * the entry so a taken slot can never be offered again from cache.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.gpInterviewSlotsCache = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  var PREFIX = 'gp_iv_slots:';
  var TTL_MS = 10 * 60 * 1000;

  function key(appId, tz) { return PREFIX + String(appId || '') + ':' + String(tz || ''); }
  function store() { try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch (e) { return null; } }

  // { slots, savedAt } or null when missing / expired / unreadable.
  function read(appId, tz, nowMs) {
    var s = store(); if (!s || !appId) return null;
    try {
      var raw = s.getItem(key(appId, tz)); if (!raw) return null;
      var v = JSON.parse(raw);
      if (!v || !Array.isArray(v.slots) || typeof v.savedAt !== 'number') return null;
      var now = typeof nowMs === 'number' ? nowMs : Date.now();
      if (now - v.savedAt > TTL_MS) { try { s.removeItem(key(appId, tz)); } catch (e) {} return null; }
      return v;
    } catch (e) { return null; }
  }
  function write(appId, tz, slots, nowMs) {
    var s = store(); if (!s || !appId || !Array.isArray(slots)) return false;
    try { s.setItem(key(appId, tz), JSON.stringify({ slots: slots, savedAt: typeof nowMs === 'number' ? nowMs : Date.now() })); return true; } catch (e) { return false; }
  }
  // Drops every timezone variant for the application (a booking, a new set
  // of practice windows).
  function clear(appId) {
    var s = store(); if (!s || !appId) return 0;
    var dropped = [];
    try { for (var i = 0; i < s.length; i++) { var k = s.key(i); if (k && k.indexOf(PREFIX + String(appId) + ':') === 0) dropped.push(k); } } catch (e) {}
    dropped.forEach(function (k) { try { s.removeItem(k); } catch (e) {} });
    return dropped.length;
  }
  function sameSlots(a, b) {
    var x = (Array.isArray(a) ? a : []).map(function (s) { return s && s.startUtc; }).join('|');
    var y = (Array.isArray(b) ? b : []).map(function (s) { return s && s.startUtc; }).join('|');
    return x === y;
  }
  return { PREFIX: PREFIX, TTL_MS: TTL_MS, key: key, read: read, write: write, clear: clear, sameSlots: sameSlots };
}));

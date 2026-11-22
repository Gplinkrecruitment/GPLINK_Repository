/* Australian GP build (WP-02): how a page learns two things from the server.
 *
 *   GPAuPathway.enabled()  is the Australian-pathway switch on?        (boolean)
 *   GPAuPathway.mine()     the signed-in doctor's own pathway:
 *                          { pathway, segment, isAu, launched }
 *
 * Both are synchronous AFTER GPAuPathway.init() has resolved. Before that, and
 * whenever anything goes wrong (network error, old cached page, signed out),
 * the answers are the safe ones: switch OFF, doctor OVERSEAS. A page must never
 * hard-code the switch on; it asks here.
 *
 * Load it with a cache-buster, and bump the version whenever this file changes:
 *   <script src="/js/au-pathway.js?v=20261122a"></script>
 *
 * Usage:
 *   GPAuPathway.init().then(function (au) {
 *     if (au.enabled() && au.mine().isAu) { ...Australian screen... }
 *   });
 *
 * Where the answers come from (server.js):
 *   GET /api/public/features  -> { auPathwayEnabled }            no sign-in needed
 *   GET /api/auth/session     -> { auPathwayEnabled, auPathway } only with the
 *                                switch on, only for a signed-in doctor
 * With the switch off only the first, tiny request is made.
 *
 * pathway:  overseas_esp | overseas_pep | au_vr | au_restricted | au_non_vr | au_registrar
 * segment:  'overseas' | 'A' | 'B' | 'C'
 * launched: false ONLY for an Australian pathway that is built but not yet
 *           launched (segments B and C): show the safe holding experience.
 * The list below mirrors lib/candidate-pathway.js; keep the two in step.
 */
(function (root) {
  'use strict';

  var SEGMENTS = {
    overseas_esp: 'overseas',
    overseas_pep: 'overseas',
    au_vr: 'A',
    au_restricted: 'B',
    au_non_vr: 'C',
    au_registrar: 'C'
  };

  function overseas() {
    return { pathway: 'overseas_esp', segment: 'overseas', isAu: false, launched: true };
  }

  var state = { ready: false, enabled: false, mine: overseas() };
  var pending = null;

  // WP-07: the last answer is remembered on this device, as a hint only, so a
  // page can decide what NOT to paint before the server has answered (see
  // pages/my-documents.html). '1' = this device last belonged to a doctor on
  // an Australian pathway. It is never trusted on its own: init() always asks
  // the server and corrects it, and a different doctor signing in on the
  // device replaces it the next time any page calls init().
  var HINT_KEY = 'gp_au_pathway_hint';
  function remember(isAu) {
    try {
      if (!root || !root.localStorage) return;
      if (isAu) root.localStorage.setItem(HINT_KEY, '1');
      else root.localStorage.removeItem(HINT_KEY);
    } catch (e) { /* private mode: no hint, nothing else changes */ }
  }
  function hinted() {
    try { return !!(root && root.localStorage && root.localStorage.getItem(HINT_KEY) === '1'); }
    catch (e) { return false; }
  }

  // Only a pathway this file knows is accepted; anything else is overseas.
  // The segment and isAu are worked out here from the pathway, so a muddled
  // response can never make an overseas doctor look Australian.
  function readMine(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.pathway !== 'string') return overseas();
    var segment = Object.prototype.hasOwnProperty.call(SEGMENTS, raw.pathway) ? SEGMENTS[raw.pathway] : null;
    if (!segment) return overseas();
    var isAu = segment !== 'overseas';
    return {
      pathway: raw.pathway,
      segment: segment,
      isAu: isAu,
      // Not launched unless the server says so, for an Australian pathway.
      launched: isAu ? raw.launched === true : true
    };
  }

  function getJson(url) {
    if (!root || typeof root.fetch !== 'function') return Promise.resolve(null);
    return root.fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) { return res && res.ok ? res.json() : null; })
      .catch(function () { return null; });
  }

  function load() {
    return getJson('/api/public/features').then(function (features) {
      if (!features || features.auPathwayEnabled !== true) {
        state.enabled = false;
        state.mine = overseas();
        // FB-2a (W3-D1b): the switch being off says nothing about WHO this
        // device belongs to, so the hint is left as it was. It used to be
        // cleared here; when the switch came back on, a saved copy of the
        // other journey's Home was then painted to an Australian doctor
        // before anything could stop it. Only a definite answer about the
        // signed-in doctor (below) changes the hint.
        return null;
      }
      state.enabled = true;
      return getJson('/api/auth/session').then(function (session) {
        state.mine = (session && session.auPathwayEnabled === true) ? readMine(session.auPathway) : overseas();
        if (session && session.auPathwayEnabled === true) remember(state.mine.isAu === true);
        return null;
      });
    }).catch(function () {
      state.enabled = false;
      state.mine = overseas();
      return null;
    });
  }

  var api = {
    /**
     * Ask the server. Safe to call from several scripts: one request is shared.
     * Pass { force: true } to ask again (after sign-in, for example).
     * Always resolves (never rejects) with GPAuPathway itself.
     */
    init: function (options) {
      if (pending && !(options && options.force)) return pending;
      pending = load().then(function () {
        state.ready = true;
        return api;
      });
      return pending;
    },
    /** Has init() finished? */
    ready: function () { return state.ready; },
    /** Is the Australian-pathway switch on? false until init() has resolved. */
    enabled: function () { return state.enabled === true; },
    /**
     * Did this device last belong to a doctor on an Australian pathway? A hint
     * for "do not paint the other screen yet", available before init(). Never
     * a reason to show an Australian screen: only init() decides that.
     */
    hinted: hinted,
    /** The signed-in doctor's pathway (a copy). Overseas until init() says otherwise. */
    mine: function () {
      return { pathway: state.mine.pathway, segment: state.mine.segment, isAu: state.mine.isAu, launched: state.mine.launched };
    }
  };

  root.GPAuPathway = api;
})(typeof window !== 'undefined' ? window : this);

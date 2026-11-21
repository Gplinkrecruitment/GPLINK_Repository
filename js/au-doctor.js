/* Australian GP build, fix bundle FB-1 (walk-findings D9, D10, D13, D26).
 *
 * What the careers screens need to know about a doctor on an Australian
 * pathway, in one place:
 *
 *   GPAuDoctor.cached()            their details from the session this tab
 *                                  already holds (no request), or null
 *   GPAuDoctor.refresh()           ask the server now; resolves the same shape
 *   GPAuDoctor.syncEligibility(i)  throw away saved role lists when the
 *                                  doctor's eligibility has changed (D9)
 *   GPAuDoctor.limitsCopy(limits)  every sentence that names an application
 *                                  limit, built from the doctor's own limits (D10)
 *   GPAuDoctor.formatDate(value)   a date the Australian way: 20 Nov 2026 (D26)
 *
 * THIS FILE IS ONLY EVER LOADED FOR A DOCTOR ON AN AUSTRALIAN PATHWAY. Pages
 * decide that with a few inline lines (the device hint that js/au-pathway.js
 * keeps, or the session already saved in this tab) and only then add this
 * script. An overseas doctor's browser never requests it and never runs it,
 * so their screens, requests and saved data are exactly what they were.
 *
 * Where the answers come from: GET /api/auth/session carries, for a doctor on
 * an Australian pathway only (switch on), `auPathway` and
 *   auDoctor: { eligibilityVersion, limits: { active, monthly, interviewsMonthly }, onboardingComplete }
 * (lib/au-doctor-session.js). Anything missing or muddled reads as "not an
 * Australian doctor": null.
 *
 * Load with a cache-buster and bump it whenever this file changes:
 *   /js/au-doctor.js?v=20261121a
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GPAuDoctor = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';

  var SESSION_URL = '/api/auth/session';
  var SESSION_CACHE_KEY = 'gpc:' + SESSION_URL;          // written by js/gp-cache.js
  var HINT_KEY = 'gp_au_pathway_hint';                   // kept by js/au-pathway.js
  var VERSION_KEY = 'gp_au_eligibility_version';         // stored beside the saved role lists
  var ROLE_LIST_CACHE_KEY = 'gp_career_roles_cache';     // pages/career.html, pages/job.html
  var ROLE_DETAIL_CACHE_PREFIX = 'gp_career_role_detail:'; // pages/job.html
  var GP_CACHE_ROLE_PREFIX = 'gpc:/api/career/role';     // /api/career/roles and /api/career/role?...
  var AU_PATHWAYS = { au_vr: true, au_restricted: true, au_non_vr: true, au_registrar: true };
  var LOCALE = 'en-AU';

  function storages(given) {
    var g = given || {};
    var out = { local: g.local || null, session: g.session || null };
    try { if (!out.local && root && root.localStorage) out.local = root.localStorage; } catch (e) { /* private mode */ }
    try { if (!out.session && root && root.sessionStorage) out.session = root.sessionStorage; } catch (e) { /* private mode */ }
    return out;
  }

  function wholeNumber(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v > 0 ? v : null; }

  /**
   * A session response -> the doctor's details, or null unless the response
   * clearly says "switch on, Australian pathway".
   */
  function fromSession(payload) {
    var p = payload && typeof payload === 'object' ? payload : null;
    if (!p || p.auPathwayEnabled !== true) return null;
    var mine = p.auPathway && typeof p.auPathway === 'object' ? p.auPathway : null;
    if (!mine || mine.isAu !== true || !Object.prototype.hasOwnProperty.call(AU_PATHWAYS, String(mine.pathway))) return null;
    var d = p.auDoctor && typeof p.auDoctor === 'object' ? p.auDoctor : {};
    var l = d.limits && typeof d.limits === 'object' ? d.limits : {};
    var limits = { active: wholeNumber(l.active), monthly: wholeNumber(l.monthly), interviewsMonthly: wholeNumber(l.interviewsMonthly) };
    return {
      pathway: String(mine.pathway),
      launched: mine.launched === true,
      eligibilityVersion: typeof d.eligibilityVersion === 'string' ? d.eligibilityVersion : '',
      limits: (limits.active && limits.monthly && limits.interviewsMonthly) ? limits : null,
      // Only a definite `false` sends a doctor back to onboarding.
      onboardingComplete: d.onboardingComplete === false ? false : true
    };
  }

  /** The session this tab already holds (saved by js/gp-cache.js). No request. */
  function cached(given) {
    var s = storages(given);
    try {
      var raw = s.session ? s.session.getItem(SESSION_CACHE_KEY) : null;
      var entry = raw ? JSON.parse(raw) : null;
      return fromSession(entry && entry.data);
    } catch (e) {
      return null;
    }
  }

  /** Should a page bother loading this file at all? (Pages inline the same test.) */
  function isCandidate(given) {
    var s = storages(given);
    try { if (s.local && s.local.getItem(HINT_KEY) === '1') return true; } catch (e) { /* ignore */ }
    return !!cached(s);
  }

  function remember(isAu, given) {
    var s = storages(given);
    try {
      if (!s.local) return;
      if (isAu) s.local.setItem(HINT_KEY, '1');
      else s.local.removeItem(HINT_KEY);
    } catch (e) { /* ignore */ }
  }

  /**
   * Ask the server now (never the saved copy). Resolves
   *   { ok: true, info: <details or null> }   the server answered
   *   { ok: false, info: null }               it could not be asked
   * The fresh answer is also written where js/gp-cache.js keeps the session,
   * so every other page in the tab sees it.
   */
  function refresh(options) {
    var o = options || {};
    var fetcher = o.fetch || (root && typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    if (!fetcher) return Promise.resolve({ ok: false, info: null });
    var s = storages(o.storages);
    return fetcher(SESSION_URL, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) { return res && res.ok ? res.json() : null; })
      .then(function (payload) {
        if (!payload || payload.ok !== true) return { ok: false, info: null };
        try { if (s.session) s.session.setItem(SESSION_CACHE_KEY, JSON.stringify({ data: payload, ts: Date.now() })); } catch (e) { /* full or private */ }
        var info = fromSession(payload);
        remember(!!info, s);
        return { ok: true, info: info };
      })
      .catch(function () { return { ok: false, info: null }; });
  }

  /** Throw away every saved copy of a role list or a role's detail. */
  function purgeRoleCaches(given) {
    var s = storages(given);
    var removed = 0;
    var sweep = function (store, test) {
      if (!store) return;
      var keys = [];
      try { for (var i = 0; i < store.length; i++) { var k = store.key(i); if (k && test(k)) keys.push(k); } } catch (e) { return; }
      keys.forEach(function (k) { try { store.removeItem(k); removed++; } catch (e) { /* ignore */ } });
    };
    sweep(s.local, function (k) { return k === ROLE_LIST_CACHE_KEY || k.indexOf(ROLE_DETAIL_CACHE_PREFIX) === 0; });
    sweep(s.session, function (k) { return k.indexOf(GP_CACHE_ROLE_PREFIX) === 0; });
    return removed;
  }

  /**
   * D9. Compare the doctor's eligibility version with the one stored beside
   * the saved role lists. Different (or none stored, or the server sent none):
   * the saved lists are thrown away and the new version is stored.
   * `info` null (not an Australian doctor any more): the stored version is
   * dropped and nothing else is touched.
   * @returns {{ changed: boolean, purged: number }}
   */
  function syncEligibility(info, given) {
    var s = storages(given);
    if (!info) {
      try { if (s.local) s.local.removeItem(VERSION_KEY); } catch (e) { /* ignore */ }
      return { changed: false, purged: 0 };
    }
    var version = String(info.eligibilityVersion || '');
    var stored = '';
    try { stored = (s.local && s.local.getItem(VERSION_KEY)) || ''; } catch (e) { stored = ''; }
    if (version && stored === version) return { changed: false, purged: 0 };
    var purged = purgeRoleCaches(s);
    try {
      if (s.local) {
        if (version) s.local.setItem(VERSION_KEY, version);
        else s.local.removeItem(VERSION_KEY);
      }
    } catch (e) { /* ignore */ }
    return { changed: true, purged: purged };
  }

  /** D26. 20 Nov 2026. `options` are Intl options; '' for a value that is not a date. */
  function formatDate(value, options) {
    if (value === null || value === undefined || value === '') return '';
    var d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString(LOCALE, options || { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch (e) { return ''; }
  }

  /**
   * D10. Every sentence that names an application limit. null when the limits
   * are not known: the page then leaves its own wording alone rather than
   * print a sentence with a hole in it.
   */
  function limitsCopy(limits) {
    var l = limits && typeof limits === 'object' ? limits : null;
    var a = l ? wholeNumber(l.active) : null;
    var m = l ? wholeNumber(l.monthly) : null;
    var n = l ? wholeNumber(l.interviewsMonthly) : null;
    if (!a || !m || !n) return null;
    return {
      active: a, monthly: m, interviewsMonthly: n,
      activeHeading: a + ' live applications at a time',
      activeBody: 'You can have ' + a + ' applications in play at once. To apply for another, withdraw one of your current applications first. We will show you which ones they are.',
      monthlyHeading: m + ' positions a month',
      monthlyBody: 'Across a calendar month you can apply for ' + m + ' positions in total. Your allowance resets on the 1st. Withdrawing frees up a live slot, but it does not give the month\'s application back.',
      whyBody: 'When we introduce you, a real practice blocks out time to read your CV and meet you. Keeping each doctor to ' + a + ' live applications means every introduction we make is one you actually want. That is why practices take our candidates seriously, and why our doctors get interviews.',
      slideNote: 'You can have ' + a + ' applications in play at once, and ' + m + ' in a calendar month. Withdrawing from a position is final.',
      applyIntro: 'You can interview for up to ' + n + ' positions per month, so accept the roles you are genuinely serious about.',
      applyIntroMatch: 'This puts you in front of the practice for an interview. You can interview for up to ' + n + ' positions per month, so use it on the ones you are genuinely serious about.',
      activeCapTitle: 'You already have ' + a + ' live applications',
      activeCapBody: function (verb) {
        return 'You can have ' + a + ' applications in play at a time. To ' + (verb || 'apply for this position') + ', withdraw one of your current applications first.';
      },
      monthlyCapTitle: 'That\'s your ' + m + ' positions for this month',
      monthlyCapBody: 'You can apply for ' + m + ' positions each calendar month. Your allowance resets at the start of next month.',
      withdrawnBlurb: 'You withdrew this application. It no longer counts towards your ' + a + ' live applications.'
    };
  }

  return {
    SESSION_CACHE_KEY: SESSION_CACHE_KEY,
    HINT_KEY: HINT_KEY,
    VERSION_KEY: VERSION_KEY,
    ROLE_LIST_CACHE_KEY: ROLE_LIST_CACHE_KEY,
    ROLE_DETAIL_CACHE_PREFIX: ROLE_DETAIL_CACHE_PREFIX,
    LOCALE: LOCALE,
    fromSession: fromSession,
    cached: cached,
    isCandidate: isCandidate,
    refresh: refresh,
    purgeRoleCaches: purgeRoleCaches,
    syncEligibility: syncEligibility,
    formatDate: formatDate,
    limitsCopy: limitsCopy
  };
});

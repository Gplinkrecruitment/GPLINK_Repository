/* WP-24 (Australian GP build, WEB-13): the Meta pixel and the Google tag on
 * the sign-in / sign-up page and on onboarding. The public site pages have
 * always carried both; these two pages carried neither, so a campaign could
 * not see anyone past the booking form.
 *
 * NOTHING happens here unless ALL of these are true:
 *   - the Australian switch is on (asked from the server, GPAuPathway);
 *   - the page is on the real domain (the same host rule as the site pages),
 *     so local, test and preview traffic never reaches Meta or Google;
 *   - the address is clean: see `plan` below.
 * With the switch off this file does nothing at all.
 *
 * WHAT IS SENT. Page views, and at most two events:
 *   "sign-up completed"      (reported once, when onboarding first opens
 *                             after an account was created)
 *   "onboarding completed"
 * each carrying ONE fixed word and nothing else: segment = 'australian' or
 * 'overseas'. Never an email, a phone number, a name, an Ahpra number, an
 * answer from a form, or an address that carries a sign-in link.
 *
 * THE ADDRESS. Both tools read the page address by themselves, so the address
 * is checked BEFORE either tool is loaded:
 *   - `email=` (the prefill on the sign-up link) is removed from the address
 *     bar first (the page has already used it);
 *   - a sign-in or recovery link (anything after "#", or any parameter not on
 *     the short list below) means NOTHING is loaded for that page view.
 * The pixel's own form and button scanning is switched off (autoConfig).
 *
 *   <script src="/js/au-tracking.js?v=20261123a" data-page="signin"></script>
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) {
    root.GPAuTracking = api;
    try { api.start(root); } catch (e) { /* tracking must never break a page */ }
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var PIXEL_ID = '2269935553370606';
  var GTM_ID = 'GTM-WNH5QC74';
  var REAL_HOST = /^(www\.|app\.)?mygplink\.com\.au$/;
  var SIGNUP_FLAG = 'gp_signup_evt';

  // Parameters that may stay in the address a page view reports. Each has a
  // fixed shape; none can carry anything about a person.
  var KEEP = {
    signup: /^1$/,
    step: /^\d{1,2}$/,
    au: /^1$/,
    docs: /^1$/,
    reset: /^1$/,
    invite: /^1$/,
    confirmed: /^(true|false)$/,
    verify: /^(expired|invalid|error)$/,
    next: /^\/pages\/[a-z0-9-]{1,40}(\.html)?$/,
    utm_source: /^[A-Za-z0-9 _.|:+~-]{1,80}$/,
    utm_medium: /^[A-Za-z0-9 _.|:+~-]{1,80}$/,
    utm_campaign: /^[A-Za-z0-9 _.|:+~-]{1,80}$/,
    utm_content: /^[A-Za-z0-9 _.|:+~-]{1,80}$/,
    utm_term: /^[A-Za-z0-9 _.|:+~-]{1,80}$/,
    fbclid: /^[A-Za-z0-9_.-]{1,200}$/,
    gclid: /^[A-Za-z0-9_.-]{1,200}$/
  };
  // Removed from the address before anything loads (the page has read it).
  var STRIP = ['email'];

  /**
   * May this page view be reported, and with which address?
   * Returns { track: false, reason } or { track: true, url } where `url` is
   * the path and the parameters that are safe to report (and `changed` says
   * whether the address bar has to be rewritten to it first).
   */
  function plan(href) {
    var url;
    try { url = new URL(String(href)); } catch (e) { return { track: false, reason: 'unreadable address' }; }
    // Sign-in and recovery links put their token after the "#".
    if (url.hash && url.hash !== '#') return { track: false, reason: 'address carries a fragment' };
    var kept = [];
    var changed = false;
    var bad = '';
    url.searchParams.forEach(function (value, key) {
      if (bad) return;
      if (STRIP.indexOf(key) !== -1) { changed = true; return; }
      if (Object.prototype.hasOwnProperty.call(KEEP, key) && KEEP[key].test(value)) { kept.push([key, value]); return; }
      bad = key;
    });
    if (bad) return { track: false, reason: 'address carries a parameter that is not on the list' };
    var qs = kept.map(function (kv) { return encodeURIComponent(kv[0]) + '=' + encodeURIComponent(kv[1]); }).join('&');
    return { track: true, url: url.pathname + (qs ? '?' + qs : ''), changed: changed };
  }

  /** Only ever one of two words. Anything else is 'overseas'. */
  function safeSegment(value) { return value === 'australian' ? 'australian' : 'overseas'; }

  // The calls each event makes. `tool` is 'fbq' or 'dataLayer'.
  function pageViewCalls() {
    return [
      { tool: 'fbq', args: ['set', 'autoConfig', false, PIXEL_ID] },
      { tool: 'fbq', args: ['init', PIXEL_ID] },
      { tool: 'fbq', args: ['track', 'PageView'] }
    ];
  }
  function signupCompletedCalls(segment) {
    var seg = safeSegment(segment);
    return [
      { tool: 'fbq', args: ['track', 'CompleteRegistration', { segment: seg }] },
      { tool: 'dataLayer', args: [{ event: 'gp_sign_up_completed', gp_segment: seg }] }
    ];
  }
  function onboardingCompletedCalls(segment) {
    var seg = safeSegment(segment);
    return [
      { tool: 'fbq', args: ['trackCustom', 'OnboardingCompleted', { segment: seg }] },
      { tool: 'dataLayer', args: [{ event: 'gp_onboarding_completed', gp_segment: seg }] }
    ];
  }

  function readFlag(cookieHeader) {
    var m = String(cookieHeader || '').match(/(?:^|;\s*)gp_signup_evt=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function send(win, calls) {
    calls.forEach(function (c) {
      try {
        if (c.tool === 'fbq' && typeof win.fbq === 'function') win.fbq.apply(win, c.args);
        else if (c.tool === 'dataLayer' && win.dataLayer) win.dataLayer.push(c.args[0]);
      } catch (e) { /* never break the page */ }
    });
  }

  // The same bootstrap the site pages carry (pages/site-start.html), loaded
  // by script so it stays behind every check above.
  function bootstrap(win) {
    var doc = win.document;
    if (!win.fbq) {
      var n = win.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!win._fbq) win._fbq = n;
      n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      var t = doc.createElement('script'); t.async = true; t.src = 'https://connect.facebook.net/en_US/fbevents.js';
      doc.head.appendChild(t);
    }
    win.dataLayer = win.dataLayer || [];
    if (!win.gtag) win.gtag = function () { win.dataLayer.push(arguments); };
    win.gtag('js', new Date());
    var g = doc.createElement('script'); g.async = true; g.src = 'https://www.googletagmanager.com/gtm.js?id=' + GTM_ID;
    doc.head.appendChild(g);
  }

  /** Should anything load at all? (switch, host, address) */
  function decide(opts) {
    var o = opts || {};
    if (o.switchOn !== true) return { track: false, reason: 'switch off' };
    if (!REAL_HOST.test(String(o.hostname || ''))) return { track: false, reason: 'not the real domain' };
    return plan(o.href);
  }

  function start(win) {
    var doc = win.document;
    var script = doc.currentScript;
    var page = script && script.getAttribute('data-page');
    if (!win.GPAuPathway || typeof win.GPAuPathway.init !== 'function') return;
    win.GPAuPathway.init().then(function (au) {
      var d = decide({ switchOn: !!(au && au.enabled()), hostname: win.location.hostname, href: win.location.href });
      if (!d.track) return;
      if (d.changed) { try { win.history.replaceState(win.history.state, '', d.url); } catch (e) { return; } }
      bootstrap(win);
      send(win, pageViewCalls());
      if (page !== 'onboarding') return;
      // "Sign-up completed": the server left a one-word flag when the account
      // was created. Reported once, then cleared.
      var flag = readFlag(doc.cookie);
      if (flag) {
        send(win, signupCompletedCalls(flag));
        doc.cookie = SIGNUP_FLAG + '=; Path=/; Max-Age=0; SameSite=Lax';
      }
      // "Onboarding completed": when the page's own save succeeds. The
      // segment is asked from the server afterwards; if that cannot be read,
      // nothing is reported.
      var realFetch = win.fetch;
      var reported = false;
      if (typeof realFetch !== 'function') return;
      win.fetch = function (input) {
        var p = realFetch.apply(this, arguments);
        try {
          var u = String((input && input.url) || input || '');
          if (!reported && /\/api\/onboarding\/complete(\?|$)/.test(u)) {
            p.then(function (r) {
              if (!r || !r.ok || reported) return;
              reported = true;
              realFetch.call(win, '/api/auth/session', { credentials: 'same-origin' })
                .then(function (s) { return s.ok ? s.json() : null; })
                .then(function (j) {
                  if (!j) return;
                  var pathway = String((j.auPathwayEnabled === true && j.auPathway && j.auPathway.pathway) || '');
                  send(win, onboardingCompletedCalls(/^au_[a-z_]+$/.test(pathway) ? 'australian' : 'overseas'));
                }).catch(function () { /* nothing reported */ });
            }).catch(function () { /* nothing reported */ });
          }
        } catch (e) { /* leave the page's request alone */ }
        return p;
      };
    }).catch(function () { /* nothing loads */ });
  }

  return {
    PIXEL_ID: PIXEL_ID,
    GTM_ID: GTM_ID,
    KEEP: KEEP,
    STRIP: STRIP,
    plan: plan,
    decide: decide,
    safeSegment: safeSegment,
    pageViewCalls: pageViewCalls,
    signupCompletedCalls: signupCompletedCalls,
    onboardingCompletedCalls: onboardingCompletedCalls,
    readFlag: readFlag,
    start: start
  };
});

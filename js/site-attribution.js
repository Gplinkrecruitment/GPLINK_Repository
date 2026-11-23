/* WP-24 (Australian GP build): where a visitor came from, and which
 * conversion events a booking may fire. Loaded on the public site pages only
 * with the Australian switch on (from the pages' switch-on block), so with the
 * switch off this file is never requested.
 *
 * 1. The cookie. On every site page this notes the campaign tags and click
 *    ids the address carried, the page landed on (path only) and the site the
 *    visitor came from (host only), as a FIRST touch (set once) and a LAST
 *    touch (replaced by any later tagged or referred visit). It is kept in a
 *    first-party cookie, `gp_attr`, for 90 days. Nothing is sent anywhere by
 *    this file. The server reads the cookie when a lead or an account is
 *    created and checks every value again (lib/au-attribution.js).
 *    Only the listed parameters are ever read: a sign-in link, an email in
 *    the address or any other parameter is never looked at.
 *
 * 2. The gate. The booking step reports a lead and a booked call to Meta and
 *    Google. `routeConversion` decides what may be sent: for a doctor who is
 *    not Australian-segment, exactly the call that was asked for; for an
 *    Australian-segment doctor, only the Australian events, and only when the
 *    server says they are configured. Otherwise nothing.
 *
 * Bump the cache-buster wherever this file is loaded when it changes:
 *   <script src="/js/site-attribution.js?v=20261123a" defer></script>
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) {
    root.GPAttribution = api;
    try { api.run(root); } catch (e) { /* attribution must never break a page */ }
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var COOKIE_NAME = 'gp_attr';
  var MAX_AGE_SEC = 90 * 24 * 60 * 60;
  var MAX_COOKIE_CHARS = 3600;
  // [cookie key, address parameter, longest value, kind]
  var PARAMS = [
    ['s', 'utm_source', 80, 'text'],
    ['m', 'utm_medium', 80, 'text'],
    ['c', 'utm_campaign', 80, 'text'],
    ['n', 'utm_content', 80, 'text'],
    ['k', 'utm_term', 80, 'text'],
    ['fb', 'fbclid', 200, 'id'],
    ['g', 'gclid', 200, 'id'],
    // The site's own short marker on links from ads ("/start?src=fb").
    ['sr', 'src', 20, 'text']
  ];

  function clean(value, kind, cap) {
    var v = String(value == null ? '' : value);
    if (v.length > 2000) v = v.slice(0, 2000);
    if (kind === 'id') v = v.replace(/[^A-Za-z0-9_.-]/g, '');
    else if (kind === 'path') {
      v = v.split('?')[0].split('#')[0].replace(/[^A-Za-z0-9/_.-]/g, '');
      if (v.charAt(0) !== '/') v = '';
    } else if (kind === 'host') {
      v = v.toLowerCase().replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].split(':')[0].replace(/[^a-z0-9.-]/g, '');
    } else {
      // An address in a tag is never kept.
      if (v.indexOf('@') !== -1 || /%40/i.test(v)) return '';
      v = v.replace(/[^A-Za-z0-9 _.|:+~-]/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return v.slice(0, cap);
  }

  function isOwnHost(host, pageHost) {
    if (!host) return true;
    if (host === String(pageHost || '').toLowerCase()) return true;
    return /(^|\.)mygplink\.com\.au$/.test(host);
  }

  /**
   * The touch for one page view: { s, m, c, n, k, fb, g, p, r, t } with only
   * the keys that have a value. `tagged` says whether the address carried a
   * campaign tag or click id; `referred` whether the visitor came from
   * another site.
   */
  function touchFromLocation(href, referrer, nowSec) {
    var url;
    try { url = new URL(String(href)); } catch (e) { return { touch: {}, tagged: false, referred: false }; }
    var touch = {};
    var tagged = false;
    PARAMS.forEach(function (p) {
      var v = clean(url.searchParams.get(p[1]), p[3], p[2]);
      if (v) { touch[p[0]] = v; tagged = true; }
    });
    var path = clean(url.pathname, 'path', 120);
    if (path) touch.p = path;
    var refHost = clean(referrer, 'host', 80);
    var referred = !!refHost && !isOwnHost(refHost, url.hostname);
    if (referred) touch.r = refHost;
    if (isFinite(nowSec)) touch.t = Math.floor(nowSec);
    return { touch: touch, tagged: tagged, referred: referred };
  }

  function decode(value) {
    var raw = String(value == null ? '' : value);
    if (!raw || raw.length > MAX_COOKIE_CHARS || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
    try {
      var b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var json = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
      var o = JSON.parse(json);
      return (o && typeof o === 'object') ? { f: o.f || null, l: o.l || null } : null;
    } catch (e) { return null; }
  }

  function encode(rec) {
    var json = JSON.stringify({ v: 1, f: rec.f || undefined, l: rec.l || undefined });
    var b64 = typeof btoa === 'function' ? btoa(json) : Buffer.from(json, 'binary').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  /**
   * First touch: set once, never replaced. Last touch: replaced by a visit
   * that carries a tag or click id, or that arrives from another site. A
   * plain page view inside the site changes nothing. Returns the record to
   * store, or null when nothing changed.
   */
  function nextRecord(prev, seen) {
    var rec = { f: prev && prev.f ? prev.f : null, l: prev && prev.l ? prev.l : null };
    var changed = false;
    if (!rec.f) { rec.f = seen.touch; changed = true; }
    if (seen.tagged || seen.referred) { rec.l = seen.touch; changed = true; }
    return changed ? rec : null;
  }

  /** The Set-Cookie string for document.cookie. */
  function cookieString(value, hostname, isHttps) {
    var parts = [COOKIE_NAME + '=' + value, 'Path=/', 'Max-Age=' + MAX_AGE_SEC, 'SameSite=Lax'];
    // One cookie for the public site and the app (www. and app.), so what was
    // noted on the site is still there when the account is created.
    if (/(^|\.)mygplink\.com\.au$/.test(String(hostname || '').toLowerCase())) parts.push('Domain=.mygplink.com.au');
    if (isHttps) parts.push('Secure');
    return parts.join('; ');
  }

  function readCookie(cookieHeader) {
    var m = String(cookieHeader || '').match(/(?:^|;\s*)gp_attr=([^;]*)/);
    return m ? m[1] : '';
  }

  function run(win) {
    var doc = win.document;
    var loc = win.location;
    var seen = touchFromLocation(loc.href, doc.referrer, Date.now() / 1000);
    var rec = nextRecord(decode(readCookie(doc.cookie)), seen);
    if (!rec) return false;
    var value = encode(rec);
    if (value.length > MAX_COOKIE_CHARS) return false;
    doc.cookie = cookieString(value, loc.hostname, loc.protocol === 'https:');
    return true;
  }

  // ---- the conversion gate -------------------------------------------------
  // tool: 'fbq' | 'gtag'. args: what the page asked to send. state.isAu: is
  // this doctor Australian-segment (they answered "Yes", or the server
  // recognised them as one). state.tracking: the `tracking` block of
  // GET /api/public/features ({ auPixelId, auGoogleSendTo }, both null until
  // the owner configures them).
  // Returns the calls to make: [{ tool, args }]. An event carries no personal
  // data: for an Australian doctor only the event name and the fixed segment.
  function routeConversion(tool, args, state) {
    var a = Array.prototype.slice.call(args || []);
    var s = state || {};
    if (s.isAu !== true) return [{ tool: tool, args: a }];
    var t = s.tracking || {};
    if (tool === 'fbq') {
      var event = String(a[1] || '');
      if (a[0] !== 'track' || (event !== 'Lead' && event !== 'Schedule')) return [];
      if (!/^\d{5,20}$/.test(String(t.auPixelId || ''))) return [];
      return [
        { tool: 'fbq', args: ['init', String(t.auPixelId)] },
        { tool: 'fbq', args: ['trackSingle', String(t.auPixelId), event, { segment: 'australian' }] }
      ];
    }
    if (tool === 'gtag') {
      if (a[0] !== 'event' || a[1] !== 'conversion') return [];
      if (!/^AW-\d+\/[A-Za-z0-9_-]+$/.test(String(t.auGoogleSendTo || ''))) return [];
      return [{ tool: 'gtag', args: ['event', 'conversion', { send_to: String(t.auGoogleSendTo) }] }];
    }
    return [];
  }

  return {
    COOKIE_NAME: COOKIE_NAME,
    MAX_AGE_SEC: MAX_AGE_SEC,
    PARAMS: PARAMS,
    clean: clean,
    touchFromLocation: touchFromLocation,
    decode: decode,
    encode: encode,
    nextRecord: nextRecord,
    cookieString: cookieString,
    readCookie: readCookie,
    run: run,
    routeConversion: routeConversion
  };
});

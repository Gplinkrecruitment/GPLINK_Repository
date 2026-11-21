/* Australian GP build (WP-12): a saved copy of a page written for a doctor
 * moving country must never be shown to a doctor who is already registered
 * and working in Australia.
 *
 * The server sends such a doctor a different file at the same address (Home,
 * the provider-number step). But the service worker can hand back a copy of
 * the standard page it saved earlier on this device. The standard pages
 * (pages/index.html, pages/pbs.html) therefore carry one inline line in their
 * <head>: ONLY when this device last belonged to a doctor on an Australian
 * pathway (the hint js/au-pathway.js keeps) does it hide the page and load
 * this file. Nobody else requests it, and for them nothing changes.
 *
 * Here: ask the server who is signed in (GPAuPathway). A clear "this doctor
 * is on an Australian pathway" asks for the page again at an address the
 * saved copy does not answer to. Anything else (switch off, another doctor,
 * no answer) shows the page exactly as it is.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  var docEl = document.documentElement;
  var SWAP_KEY = 'gp_au_page_swap:' + window.location.pathname;
  function reveal() { docEl.classList.remove('gp-au-page-wait'); }
  function holding() {
    var show = function () {
      if (!document.body) return;
      document.body.innerHTML = '<div style="max-width:520px;margin:64px auto;padding:0 20px;text-align:center;font:500 15px/1.5 sans-serif;color:#0f172a">'
        + '<h2 style="font:600 20px/1.3 sans-serif;margin:0 0 8px">Loading your page</h2>'
        + '<p style="margin:0 0 16px;color:#475569">This is taking longer than usual. Please try again.</p>'
        + '<button type="button" id="auPageRetryBtn" style="min-height:44px;padding:10px 18px;border-radius:10px;border:0;background:#2563eb;color:#fff;font:600 14px/1 sans-serif;cursor:pointer">Try again</button></div>';
      var btn = document.getElementById('auPageRetryBtn');
      if (btn) btn.addEventListener('click', function () {
        try { sessionStorage.removeItem(SWAP_KEY); } catch (e) { /* ignore */ }
        window.location.reload();
      });
      reveal();
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  }
  if (!window.GPAuPathway || typeof window.GPAuPathway.init !== 'function') { reveal(); return; }
  // A hidden page must not stay hidden if the server never answers.
  var slow = setTimeout(reveal, 8000);
  window.GPAuPathway.init().then(function (au) {
    clearTimeout(slow);
    var isAu = false;
    try { isAu = au.enabled() === true && au.mine().isAu === true; } catch (e) { isAu = false; }
    if (!isAu) { reveal(); return; }
    var tried = false;
    try { tried = sessionStorage.getItem(SWAP_KEY) === '1'; sessionStorage.setItem(SWAP_KEY, '1'); } catch (e) { tried = true; }
    if (tried) { holding(); return; }
    var next = window.location.pathname + '?au_page=' + Date.now();
    try { if (window.self !== window.top) next += '&gp_shell=embedded'; } catch (e) { next += '&gp_shell=embedded'; }
    window.location.replace(next);
  }, reveal);
})();

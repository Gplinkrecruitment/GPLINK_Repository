/*
 * Contract-ready popup (owner 2026-09-10): "the practice extended an offer and
 * the admin submitted the contract to the GP … no in-app congratulatory page
 * with a Complete agreement CTA is in place".
 *
 * Loaded once from pages/app-shell.html (after js/interview-popup.js). Once
 * the interview check settles, fetches GET /api/career/contracts/pending; if
 * a contract is waiting for the doctor's signature, renders a full-viewport
 * takeover in the match/interview popup's visual language: badge, serif
 * congratulations, the practice card, a shiny "Complete agreement" button
 * that lands on the offer-review page, and a small "I'll do it later".
 * "Later" (and opening the agreement) records a dismissal on the server
 * (POST /api/career/contract/popup-seen); the page comes back after
 * DISMISS_HOURS while the contract is still unsigned. Never stacks over the
 * match or interview popups — those checks run first and win.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.gpContractPopup = api;
  if (typeof document !== 'undefined' && api.autoInit !== false) {
    document.addEventListener('DOMContentLoaded', api.init, { once: true });
  }
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var DISMISS_HOURS = 24;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function safeUrl(value) {
    var v = String(value || '').trim();
    return /^https?:\/\//i.test(v) ? v : '';
  }
  function agreementPath(applicationId) {
    return '/pages/offer-review?applicationId=' + encodeURIComponent(String(applicationId || ''));
  }

  // ── Pure rules (unit-tested) ─────────────────────────────────────────────
  // The newest contract awaiting the doctor's signature that they have not
  // pushed away in the last DISMISS_HOURS. null when there is nothing to show.
  function pickPendingContract(data, nowMs) {
    if (!data || data.ok !== true || data.locked === true) return null;
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    var list = Array.isArray(data.contracts) ? data.contracts.filter(function (it) {
      if (!it || !it.applicationId) return false;
      if (!it.dismissedAt) return true;
      var d = new Date(it.dismissedAt).getTime();
      return !(isFinite(d) && now - d < DISMISS_HOURS * 3600000);
    }) : [];
    if (!list.length) return null;
    list.sort(function (a, b) { return new Date(b.sentAt || 0) - new Date(a.sentAt || 0); });
    return list[0];
  }

  // ── Network ──────────────────────────────────────────────────────────────
  function getJson(url) {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (b) { return { status: r.status, body: b }; }); })
      .catch(function () { return { status: 0, body: null }; });
  }
  function postJson(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (b) { return { status: r.status, body: b }; }); })
      .catch(function () { return { status: 0, body: null }; });
  }
  function navigateTo(path) {
    try {
      if (typeof window.gpShellNavigate === 'function') { window.gpShellNavigate(path, { replace: false }); return; }
    } catch (e) {}
    window.location.href = path;
  }

  // ── Markup ───────────────────────────────────────────────────────────────
  function buildHtml(c, gp) {
    var lastName = (gp && gp.lastName) || '';
    var greet = lastName ? ('Dr ' + escapeHtml(lastName)) : 'Doctor';
    var website = safeUrl(c.website);
    var websiteLabel = website ? website.replace(/^https?:\/\//i, '').replace(/\/$/, '') : '';
    var headerImageUrl = safeUrl(c.headerImageUrl);
    var locationLine = [c.locationCity, c.locationState].filter(Boolean).join(', ');
    var practice = c.practiceName || 'The practice';
    var photoHtml = headerImageUrl
      ? '<div class="gpcp-photo"><img src="' + escapeHtml(headerImageUrl) + '" alt=""><div class="gpcp-cap">📍 ' + escapeHtml(locationLine || practice) + '</div></div>'
      : '';
    var websiteHtml = website
      ? '<a class="gpcp-weblink" href="' + escapeHtml(website) + '" target="_blank" rel="noopener">🌐 ' + escapeHtml(websiteLabel) + '</a>'
      : '';
    return (
      '<div class="gpcp-confetti-host"></div>' +
      '<div class="gpcp-badge">🎉 The position is yours</div>' +
      '<h1 class="gpcp-h">Congratulations,<br>' + greet + '</h1>' +
      '<p class="gpcp-sub"><b>' + escapeHtml(practice) + '</b> has offered you the position. This was a competitive role with strong interest from other doctors — being the one they chose is a real achievement.</p>' +
      '<div class="gpcp-job">' + photoHtml +
        '<div class="gpcp-job-inner">' +
          '<div class="gpcp-pn">' + escapeHtml(practice) + '</div>' +
          (c.jobTitle ? '<div class="gpcp-jt">' + escapeHtml(c.jobTitle) + '</div>' : '') +
          (locationLine ? '<div class="gpcp-jm">' + escapeHtml(locationLine) + '</div>' : '') +
          websiteHtml +
        '</div>' +
      '</div>' +
      '<div class="gpcp-next">' +
        '<div class="gpcp-next-t">✍️ One step left</div>' +
        '<p class="gpcp-next-p">Review your employment agreement and sign it to secure your position. If something needs adjusting before you can sign, you can request a change on the same page.</p>' +
      '</div>' +
      '<a class="gpcp-confirm shiny" data-gpcp-go href="' + escapeHtml(agreementPath(c.applicationId)) + '">Complete agreement</a>' +
      '<a href="#" class="gpcp-later" data-gpcp-later>I’ll do it later</a>'
    );
  }

  var CSS = [
    '.gpcp-overlay{position:fixed;inset:0;z-index:99998;display:flex;align-items:flex-start;justify-content:center;padding:32px 16px;overflow-y:auto;',
    "background:var(--gp-grad-hero, linear-gradient(160deg,#0b1322 0%,#14203a 55%,#0e1a30 100%));font-family:'DM Sans',-apple-system,'Segoe UI',sans-serif;}",
    '.gpcp-card{position:relative;max-width:400px;width:100%;margin:auto;color:#fff;padding:12px 6px 30px;}',
    '.gpcp-confetti-host{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:0;}',
    '.gpcp-badge{position:relative;display:table;margin:0 auto 14px;background:rgba(22,163,74,.22);border:1px solid rgba(74,222,128,.45);color:#bbf7d0;font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;padding:6px 14px;border-radius:999px;}',
    ".gpcp-h{position:relative;font-family:'Source Serif 4',Georgia,serif;font-size:30px;font-weight:700;text-align:center;line-height:1.14;margin:0 0 8px;}",
    '.gpcp-sub{position:relative;text-align:center;font-size:13px;color:rgba(226,233,246,.85);line-height:1.5;margin:0 auto 14px;max-width:330px;}',
    '.gpcp-job{position:relative;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:18px;overflow:hidden;margin-bottom:11px;}',
    '.gpcp-photo{position:relative;height:120px;overflow:hidden;}',
    '.gpcp-photo img{width:100%;height:100%;object-fit:cover;display:block;}',
    '.gpcp-cap{position:absolute;left:0;right:0;bottom:0;padding:20px 13px 8px;background:linear-gradient(transparent, rgba(11,19,34,.85));color:#fff;font-size:11.5px;font-weight:600;}',
    '.gpcp-job-inner{padding:13px 15px 14px;}',
    ".gpcp-pn{font-family:'Source Serif 4',Georgia,serif;font-size:16.5px;font-weight:700;}",
    '.gpcp-jt{font-weight:600;font-size:13px;color:rgba(226,233,246,.92);margin:1px 0;}',
    '.gpcp-jm{font-size:12px;color:rgba(226,233,246,.72);margin-bottom:7px;}',
    '.gpcp-weblink{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;color:#8fb3ff;text-decoration:none;}',
    '.gpcp-next{position:relative;background:rgba(22,163,74,.10);border:1px solid rgba(74,222,128,.28);border-radius:16px;padding:13px 15px 12px;margin-bottom:14px;}',
    '.gpcp-next-t{font-size:11px;font-weight:700;color:#bbf7d0;text-transform:uppercase;letter-spacing:.08em;margin-bottom:7px;}',
    '.gpcp-next-p{font-size:12.5px;color:rgba(226,233,246,.85);margin:0;line-height:1.5;}',
    '.gpcp-confirm{position:relative;overflow:hidden;display:block;width:100%;box-sizing:border-box;text-align:center;color:#fff;font-weight:700;text-decoration:none;font-size:15px;padding:15px;border-radius:14px;border:0;cursor:pointer;',
    'background:linear-gradient(180deg,#34d399 0%,#16a34a 45%,#15803d 100%);box-shadow:0 12px 28px -8px rgba(22,163,74,.75), inset 0 1.5px 0 rgba(255,255,255,.5), inset 0 -2px 6px rgba(9,74,36,.45);}',
    ".gpcp-confirm::after{content:'';position:absolute;top:-10%;bottom:-10%;left:-70%;width:44%;background:linear-gradient(115deg, transparent 0%, rgba(255,255,255,.55) 50%, transparent 100%);transform:skewX(-22deg);animation:gpcpshine 3s ease-in-out infinite;}",
    '@media (prefers-reduced-motion: reduce){.gpcp-confirm::after{animation:none;}}',
    '@keyframes gpcpshine{0%{left:-70%}55%{left:135%}100%{left:135%}}',
    '.gpcp-later{position:relative;display:block;text-align:center;color:rgba(226,233,246,.65);font-size:13px;text-decoration:none;padding:11px 0 0;}',
    'html.gpcp-open{overflow:hidden;}'
  ].join('\n');

  var stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    var style = document.createElement('style');
    style.id = 'gpContractPopupStyles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ── Overlay ──────────────────────────────────────────────────────────────
  var confettiHandle = null;
  var activeOverlay = null;
  function startConfetti(overlay) {
    var host = overlay.querySelector('.gpcp-confetti-host');
    if (host && typeof window.gpLaunchLoopingConfetti === 'function') {
      try { confettiHandle = window.gpLaunchLoopingConfetti(host); } catch (e) { confettiHandle = null; }
    }
  }
  function closeOverlay(overlay) {
    if (confettiHandle) { try { confettiHandle.stop(); } catch (e) {} confettiHandle = null; }
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    try { document.documentElement.classList.remove('gpcp-open'); } catch (e) {}
    document.removeEventListener('keydown', onKey, true);
    activeOverlay = null;
  }
  function onKey(e) {
    if (e.key === 'Escape' && activeOverlay) {
      e.preventDefault();
      var later = activeOverlay.querySelector('[data-gpcp-later]');
      if (later) later.click();
    }
  }

  function showOverlay(c, gp) {
    injectStyles();
    var overlay = document.createElement('div');
    overlay.id = 'gpContractPopup';
    overlay.className = 'gpcp-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = '<div class="gpcp-card">' + buildHtml(c, gp) + '</div>';
    document.body.appendChild(overlay);
    activeOverlay = overlay;
    try { document.documentElement.classList.add('gpcp-open'); } catch (e) {}
    document.addEventListener('keydown', onKey, true);
    startConfetti(overlay);

    var go = overlay.querySelector('[data-gpcp-go]');
    if (go) {
      go.addEventListener('click', function (e) {
        e.preventDefault();
        // They have seen it — do not greet them with it again on the next
        // page for a day; the card and the offer-review page carry on.
        postJson('/api/career/contract/popup-seen', { applicationId: c.applicationId });
        closeOverlay(overlay);
        navigateTo(agreementPath(c.applicationId));
      });
      try { go.focus(); } catch (e) {}
    }
    var later = overlay.querySelector('[data-gpcp-later]');
    if (later) {
      later.addEventListener('click', function (e) {
        e.preventDefault();
        postJson('/api/career/contract/popup-seen', { applicationId: c.applicationId });
        closeOverlay(overlay);
      });
    }
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function otherPopupOpen() {
    return !!(document.getElementById('gpContractPopup') || document.getElementById('gpMatchPopup') || document.getElementById('gpInterviewPopup'));
  }
  function run() {
    if (otherPopupOpen()) return;
    var mc = window.gpMatchCheck;
    if (mc && mc.popupShown) return; // the match popup owns this visit
    var ic = window.gpInterviewCheck;
    if (ic && ic.popupShown) return; // so does the interview popup
    getJson('/api/career/contracts/pending').then(function (res) {
      var c = pickPendingContract(res.body);
      if (!c) return;
      if (otherPopupOpen()) return;
      showOverlay(c, (res.body && res.body.gp) || {});
    });
  }

  function init() {
    // js/interview-popup.js (loaded before this file) publishes
    // window.gpInterviewCheck and fires gp-interview-check-done once it has
    // decided whether to take the screen; wait for it so the two never stack.
    var ic = window.gpInterviewCheck;
    if (ic && ic.pending === false) { run(); return; }
    var fired = false;
    function once() { if (fired) return; fired = true; run(); }
    window.addEventListener('gp-interview-check-done', once, { once: true });
    setTimeout(once, 8000); // the interview check never finishing must not hide a contract
  }

  return {
    DISMISS_HOURS: DISMISS_HOURS,
    pickPendingContract: pickPendingContract,
    buildHtml: buildHtml,
    agreementPath: agreementPath,
    init: init,
    run: run
  };
}));

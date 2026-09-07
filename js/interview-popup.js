/*
 * Interview-times popup (owner 2026-09-07): "when the practice accepts and
 * gives interview times then there should be a full page that shows the
 * available times and has the GP choose a time for the interview, or a small
 * 'I'll choose later' that closes the page — similar to the congratulations
 * page for when we match a GP."
 *
 * Loaded once from pages/app-shell.html (the top-level shell, after
 * js/match-popup.js). After the match check settles, fetches
 * GET /api/career/interviews/pending; if the practice has confirmed its
 * availability for an interview the doctor has not booked, renders a
 * full-viewport takeover in the match popup's visual language: badge, serif
 * headline, practice card, the open times grouped by day (doctor's own
 * timezone), a shiny "Confirm interview time" and "I'll choose later".
 *
 * Booking goes through the SAME two endpoints the card and the timeline use
 * (GET /api/career/interview/slots, POST /api/career/interview/book), so
 * there is one booking path. "I'll choose later" records a dismissal on the
 * server (POST /api/career/interview/popup-seen); the page comes back after
 * DISMISS_HOURS if the interview is still unbooked. Never stacks over the
 * match popup — the match check runs first and wins.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.gpInterviewPopup = api;
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

  // ── Pure rules (unit-tested) ─────────────────────────────────────────────
  // The newest pending interview the doctor has not pushed away in the last
  // DISMISS_HOURS. null when there is nothing to show (locked account, no
  // pending interviews, fetch failure).
  function pickPendingInterview(data, nowMs) {
    if (!data || data.ok !== true || data.locked === true) return null;
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    var list = Array.isArray(data.interviews) ? data.interviews.filter(function (it) {
      if (!it || !it.applicationId) return false;
      if (!it.dismissedAt) return true;
      var d = new Date(it.dismissedAt).getTime();
      return !(isFinite(d) && now - d < DISMISS_HOURS * 3600000);
    }) : [];
    if (!list.length) return null;
    list.sort(function (a, b) { return new Date(b.invitedAt || 0) - new Date(a.invitedAt || 0); });
    return list[0];
  }

  function formatDay(iso) {
    try { return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }); } catch (e) { return ''; }
  }
  function formatTime(iso) {
    try { return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function formatFull(iso) {
    var d = formatDay(iso), t = formatTime(iso);
    return d && t ? d + ' · ' + t : (d || t || '');
  }

  // Groups slots by the doctor's own day, keeping server order inside a day.
  function groupSlotsByDay(slots, dayFormatter) {
    var fmt = typeof dayFormatter === 'function' ? dayFormatter : formatDay;
    var groups = [];
    (Array.isArray(slots) ? slots : []).forEach(function (slot) {
      if (!slot || !slot.startUtc) return;
      var day = fmt(slot.startUtc);
      var g = null;
      for (var i = 0; i < groups.length; i++) if (groups[i].day === day) { g = groups[i]; break; }
      if (!g) { g = { day: day, slots: [] }; groups.push(g); }
      g.slots.push(slot);
    });
    return groups;
  }

  function deviceTz() {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      if (!tz) return '';
      new Intl.DateTimeFormat(undefined, { timeZone: tz });
      return tz;
    } catch (e) { return ''; }
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

  function navigateToCareer() {
    try {
      if (typeof window.gpShellNavigate === 'function') { window.gpShellNavigate('/pages/career', { replace: false }); return; }
    } catch (e) {}
    window.location.href = '/pages/career';
  }

  // ── Markup ───────────────────────────────────────────────────────────────
  function buildHtml(iv, gp) {
    var lastName = (gp && gp.lastName) || '';
    var greet = lastName ? ('Dr ' + escapeHtml(lastName)) : 'Doctor';
    var website = safeUrl(iv.website);
    var websiteLabel = website ? website.replace(/^https?:\/\//i, '').replace(/\/$/, '') : '';
    var headerImageUrl = safeUrl(iv.headerImageUrl);
    var locationLine = [iv.locationCity, iv.locationState].filter(Boolean).join(', ');
    var practice = iv.practiceName || 'The practice';
    var tz = deviceTz();
    var photoHtml = headerImageUrl
      ? '<div class="gpip-photo"><img src="' + escapeHtml(headerImageUrl) + '" alt=""><div class="gpip-cap">📍 ' + escapeHtml(locationLine || practice) + '</div></div>'
      : '';
    var websiteHtml = website
      ? '<a class="gpip-weblink" href="' + escapeHtml(website) + '" target="_blank" rel="noopener">🌐 ' + escapeHtml(websiteLabel) + '</a>'
      : '';
    return (
      '<div class="gpip-confetti-host"></div>' +
      '<div class="gpip-badge">✦ Interview invitation</div>' +
      '<h1 class="gpip-h">The practice wants<br>to meet you, ' + greet + '</h1>' +
      '<p class="gpip-sub"><b>' + escapeHtml(practice) + '</b> has confirmed their availability. Choose the time that suits you — 45 minutes on Zoom, and your Registration Support Officer joins you, so you’re never in the room alone.</p>' +
      '<div class="gpip-job">' + photoHtml +
        '<div class="gpip-job-inner">' +
          '<div class="gpip-pn">' + escapeHtml(practice) + '</div>' +
          (iv.jobTitle ? '<div class="gpip-jt">' + escapeHtml(iv.jobTitle) + '</div>' : '') +
          (locationLine ? '<div class="gpip-jm">' + escapeHtml(locationLine) + '</div>' : '') +
          websiteHtml +
        '</div>' +
      '</div>' +
      '<div class="gpip-times">' +
        '<div class="gpip-times-t">📅 Pick your interview time</div>' +
        '<p class="gpip-status" data-gpip-status>Loading available times…</p>' +
        '<div class="gpip-days" data-gpip-days></div>' +
        (tz ? '<p class="gpip-tz">Times shown in your local time (' + escapeHtml(tz) + ')</p>' : '') +
      '</div>' +
      '<button type="button" class="gpip-confirm shiny" data-gpip-confirm disabled>Confirm interview time</button>' +
      '<a href="#" class="gpip-later" data-gpip-later>I’ll choose later</a>'
    );
  }

  function buildBookedHtml(iv, booked) {
    var when = formatFull(booked && booked.scheduledAt);
    return (
      '<div class="gpip-confetti-host"></div>' +
      '<div class="gpip-badge">✓ Interview booked</div>' +
      '<h1 class="gpip-h">You’re booked in</h1>' +
      '<p class="gpip-sub">Your interview with <b>' + escapeHtml(iv.practiceName || 'the practice') + '</b>' + (when ? ' is confirmed for <b>' + escapeHtml(when) + '</b>' : ' is confirmed') + '. We’ll email you the video link before it starts, and your Registration Support Officer will be on the call with you.</p>' +
      '<button type="button" class="gpip-confirm shiny" data-gpip-done>Done</button>'
    );
  }

  var CSS = [
    '.gpip-overlay{position:fixed;inset:0;z-index:99998;display:flex;align-items:flex-start;justify-content:center;padding:32px 16px;overflow-y:auto;',
    "background:var(--gp-grad-hero, linear-gradient(160deg,#0b1322 0%,#14203a 55%,#0e1a30 100%));font-family:'DM Sans',-apple-system,'Segoe UI',sans-serif;}",
    '.gpip-card{position:relative;max-width:400px;width:100%;margin:auto;color:#fff;padding:12px 6px 30px;}',
    '.gpip-confetti-host{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:0;}',
    '.gpip-badge{position:relative;display:table;margin:0 auto 14px;background:rgba(37,99,235,.22);border:1px solid rgba(96,148,255,.45);color:#bcd3ff;font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;padding:6px 14px;border-radius:999px;}',
    ".gpip-h{position:relative;font-family:'Source Serif 4',Georgia,serif;font-size:28px;font-weight:700;text-align:center;line-height:1.16;margin:0 0 6px;}",
    '.gpip-sub{position:relative;text-align:center;font-size:13px;color:rgba(226,233,246,.85);line-height:1.5;margin:0 auto 14px;max-width:320px;}',
    '.gpip-job{position:relative;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:18px;overflow:hidden;margin-bottom:11px;}',
    '.gpip-photo{position:relative;height:120px;overflow:hidden;}',
    '.gpip-photo img{width:100%;height:100%;object-fit:cover;display:block;}',
    '.gpip-cap{position:absolute;left:0;right:0;bottom:0;padding:20px 13px 8px;background:linear-gradient(transparent, rgba(11,19,34,.85));color:#fff;font-size:11.5px;font-weight:600;}',
    '.gpip-job-inner{padding:13px 15px 14px;}',
    ".gpip-pn{font-family:'Source Serif 4',Georgia,serif;font-size:16.5px;font-weight:700;}",
    '.gpip-jt{font-weight:600;font-size:13px;color:rgba(226,233,246,.92);margin:1px 0;}',
    '.gpip-jm{font-size:12px;color:rgba(226,233,246,.72);margin-bottom:7px;}',
    '.gpip-weblink{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;color:#8fb3ff;text-decoration:none;}',
    '.gpip-times{position:relative;background:rgba(37,99,235,.10);border:1px solid rgba(96,148,255,.28);border-radius:16px;padding:13px 15px 10px;margin-bottom:12px;}',
    '.gpip-times-t{font-size:11px;font-weight:700;color:#bcd3ff;text-transform:uppercase;letter-spacing:.08em;margin-bottom:9px;}',
    '.gpip-status{font-size:12.5px;color:rgba(226,233,246,.8);margin:0 0 8px;line-height:1.45;}',
    '.gpip-day{margin-bottom:10px;}',
    '.gpip-day-lbl{font-size:12px;font-weight:700;color:#e6edfb;margin-bottom:6px;}',
    '.gpip-slots{display:flex;flex-wrap:wrap;gap:8px;}',
    '.gpip-slot{appearance:none;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.06);color:#fff;font:inherit;font-size:13px;font-weight:600;padding:9px 12px;border-radius:10px;cursor:pointer;}',
    '.gpip-slot.is-sel{background:linear-gradient(180deg,#4f8bff,#2563eb);border-color:#4f8bff;box-shadow:0 6px 16px -6px rgba(37,99,235,.8);}',
    '.gpip-tz{font-size:11px;color:rgba(226,233,246,.55);margin:4px 0 0;}',
    '.gpip-confirm{position:relative;overflow:hidden;display:block;width:100%;text-align:center;color:#fff;font-weight:700;text-decoration:none;font-size:15px;padding:15px;border-radius:14px;border:0;cursor:pointer;',
    'background:linear-gradient(180deg,#4f8bff 0%,#2563eb 45%,#1d4ed8 100%);box-shadow:0 12px 28px -8px rgba(37,99,235,.75), inset 0 1.5px 0 rgba(255,255,255,.5), inset 0 -2px 6px rgba(13,38,110,.45);}',
    '.gpip-confirm:disabled{opacity:.55;cursor:default;box-shadow:none;}',
    ".gpip-confirm:not(:disabled)::after{content:'';position:absolute;top:-10%;bottom:-10%;left:-70%;width:44%;background:linear-gradient(115deg, transparent 0%, rgba(255,255,255,.55) 50%, transparent 100%);transform:skewX(-22deg);animation:gpipshine 3s ease-in-out infinite;}",
    '@media (prefers-reduced-motion: reduce){.gpip-confirm::after{animation:none;}}',
    '@keyframes gpipshine{0%{left:-70%}55%{left:135%}100%{left:135%}}',
    '.gpip-later{position:relative;display:block;text-align:center;color:rgba(226,233,246,.65);font-size:13px;text-decoration:none;padding:11px 0 0;}',
    'html.gpip-open{overflow:hidden;}'
  ].join('\n');

  var stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    var style = document.createElement('style');
    style.id = 'gpInterviewPopupStyles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ── Overlay ──────────────────────────────────────────────────────────────
  var confettiHandle = null;
  function startConfetti(overlay) {
    var host = overlay.querySelector('.gpip-confetti-host');
    if (host && typeof window.gpLaunchLoopingConfetti === 'function') {
      try { confettiHandle = window.gpLaunchLoopingConfetti(host); } catch (e) { confettiHandle = null; }
    }
  }
  function closeOverlay(overlay) {
    if (confettiHandle) { try { confettiHandle.stop(); } catch (e) {} confettiHandle = null; }
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    try { document.documentElement.classList.remove('gpip-open'); } catch (e) {}
    document.removeEventListener('keydown', onKey, true);
  }
  var activeOverlay = null;
  function onKey(e) {
    if (e.key === 'Escape' && activeOverlay) {
      e.preventDefault();
      var later = activeOverlay.querySelector('[data-gpip-later]');
      if (later) later.click();
    }
  }

  function showOverlay(iv, gp) {
    injectStyles();
    var overlay = document.createElement('div');
    overlay.id = 'gpInterviewPopup';
    overlay.className = 'gpip-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = '<div class="gpip-card">' + buildHtml(iv, gp) + '</div>';
    document.body.appendChild(overlay);
    activeOverlay = overlay;
    try { document.documentElement.classList.add('gpip-open'); } catch (e) {}
    document.addEventListener('keydown', onKey, true);
    startConfetti(overlay);

    var state = { slots: [], selected: '', booking: false };
    var statusEl = overlay.querySelector('[data-gpip-status]');
    var daysEl = overlay.querySelector('[data-gpip-days]');
    var confirmEl = overlay.querySelector('[data-gpip-confirm]');
    var laterEl = overlay.querySelector('[data-gpip-later]');
    var tz = deviceTz();

    function paint() {
      var groups = groupSlotsByDay(state.slots);
      daysEl.innerHTML = groups.map(function (g) {
        var buttons = g.slots.map(function (s) {
          var sel = state.selected === s.startUtc ? ' is-sel' : '';
          return '<button type="button" class="gpip-slot' + sel + '" data-gpip-slot="' + escapeHtml(s.startUtc) + '" aria-pressed="' + (sel ? 'true' : 'false') + '">' + escapeHtml(formatTime(s.startUtc)) + '</button>';
        }).join('');
        return '<div class="gpip-day"><div class="gpip-day-lbl">' + escapeHtml(g.day) + '</div><div class="gpip-slots">' + buttons + '</div></div>';
      }).join('');
      confirmEl.disabled = !state.selected || state.booking;
      confirmEl.textContent = state.booking ? 'Confirming…' : 'Confirm interview time';
    }

    function loadSlots() {
      statusEl.textContent = 'Loading available times…';
      var url = '/api/career/interview/slots?applicationId=' + encodeURIComponent(iv.applicationId) + (tz ? '&viewer_tz=' + encodeURIComponent(tz) : '');
      getJson(url).then(function (res) {
        state.slots = (res.body && Array.isArray(res.body.slots)) ? res.body.slots : [];
        if (res.status === 403) statusEl.textContent = 'Your interview times open as soon as the practice confirms — we’ll let you know.';
        else if (res.status !== 200) statusEl.textContent = (res.body && res.body.message) || 'We couldn’t load your interview times just now.';
        else if (!state.slots.length) statusEl.textContent = 'The practice’s times are being confirmed — we’ll message you the moment they’re open.';
        else statusEl.textContent = 'Tap a time to select it, then confirm.';
        paint();
        var first = overlay.querySelector('[data-gpip-slot]');
        if (first) { try { first.focus(); } catch (e) {} }
      });
    }

    daysEl.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-gpip-slot]') : null;
      if (!btn || state.booking) return;
      state.selected = btn.getAttribute('data-gpip-slot') || '';
      paint();
    });

    confirmEl.addEventListener('click', function () {
      if (!state.selected || state.booking) return;
      state.booking = true;
      paint();
      postJson('/api/career/interview/book', { applicationId: iv.applicationId, slot_start_utc: state.selected, viewer_tz: tz || undefined }).then(function (res) {
        state.booking = false;
        if (res.status === 200 && res.body && res.body.ok) {
          var booked = res.body.booked || {};
          overlay.innerHTML = '<div class="gpip-card">' + buildBookedHtml(iv, { scheduledAt: booked.scheduled_at || state.selected }) + '</div>';
          startConfetti(overlay);
          var done = overlay.querySelector('[data-gpip-done]');
          if (done) done.addEventListener('click', function () { closeOverlay(overlay); navigateToCareer(); });
          try { window.dispatchEvent(new CustomEvent('gp-interview-booked', { detail: { applicationId: iv.applicationId } })); } catch (e) {}
          return;
        }
        if (res.status === 409 && res.body && res.body.error === 'slot_taken') {
          state.selected = '';
          statusEl.textContent = 'That time was just taken — here are the times still open.';
          loadSlots();
          return;
        }
        if (res.status === 409 && res.body && res.body.error === 'interview_cap') {
          statusEl.textContent = (res.body && res.body.message) || 'You’ve used your 3 interviews for this month.';
          paint();
          return;
        }
        statusEl.textContent = (res.body && res.body.message) || 'We couldn’t confirm that time — please try again.';
        paint();
      });
    });

    laterEl.addEventListener('click', function (e) {
      e.preventDefault();
      postJson('/api/career/interview/popup-seen', { applicationId: iv.applicationId });
      closeOverlay(overlay);
    });

    loadSlots();
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function run() {
    if (document.getElementById('gpInterviewPopup') || document.getElementById('gpMatchPopup')) return;
    var mc = window.gpMatchCheck;
    if (mc && mc.popupShown) return; // the match popup owns this visit
    getJson('/api/career/interviews/pending').then(function (res) {
      var iv = pickPendingInterview(res.body);
      if (!iv) return;
      if (document.getElementById('gpMatchPopup')) return;
      showOverlay(iv, (res.body && res.body.gp) || {});
    });
  }

  function init() {
    // The match popup's check (js/match-popup.js, loaded before this file)
    // publishes window.gpMatchCheck; wait for it so the two never stack.
    var mc = window.gpMatchCheck;
    if (mc && mc.pending === false) { run(); return; }
    var fired = false;
    function once() { if (fired) return; fired = true; run(); }
    window.addEventListener('gp-match-check-done', once, { once: true });
    setTimeout(once, 6000); // the match check never finishing must not hide an interview
  }

  return {
    DISMISS_HOURS: DISMISS_HOURS,
    pickPendingInterview: pickPendingInterview,
    groupSlotsByDay: groupSlotsByDay,
    buildHtml: buildHtml,
    buildBookedHtml: buildBookedHtml,
    formatFull: formatFull,
    init: init,
    run: run
  };
}));

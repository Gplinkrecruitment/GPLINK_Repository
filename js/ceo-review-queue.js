/* ============================================================================
 * ceo-review-queue.js — "Needs your review" popup + Candidates-tab "!".
 *
 * Owner 2026-10-01: "i was never made aware i had to review her GMC number. I
 * should always get a popup when something needs reviewing with a CTA that
 * takes me to the action as well as it being visible on her profile and tab
 * as an exclamation mark icon."
 *
 * Reads GET /api/ceo/review-queue (CEO-only) FRESH every time — never through
 * the SWR cache, so the popup can never show a stale list. Refreshed on boot
 * and from refreshDashboard() (every 30s + after dashboard mutations), and
 * after any review action on a candidate profile.
 *
 * Popup rules:
 *   - every fresh page load with items -> show it;
 *   - within the session, re-show only when an item appears that the CEO has
 *     not already been shown (seen tokens live in sessionStorage);
 *   - never stack, never open over another open modal/drawer (deferred until
 *     it closes).
 * Exposes window.CeoReviewQueue. Loaded after the ATS modules.
 * ========================================================================== */
(function () {
  'use strict';

  var SEEN_KEY = 'gp_ceo_review_seen_v1';
  var MODAL_MARK = 'data-review-queue-modal';
  var state = {
    data: null,          // last good payload
    inflight: null,
    shownThisLoad: false,
    pendingShow: false,
    again: false,
    deferTimer: null,
    lastFetchAt: 0
  };

  function esc(s) {
    if (window.ATS && window.ATS.esc) return window.ATS.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function role() { return String(window.__gpAdminRole || ''); }
  // Same audience as the dashboard feed: the queue endpoint is CEO-only
  // (requireCeoSession) and consultants never see the Registration side.
  function isCeo() { return role() === 'super_admin'; }

  function readSeen() {
    try {
      var raw = sessionStorage.getItem(SEEN_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function writeSeen(tokens) {
    try { sessionStorage.setItem(SEEN_KEY, JSON.stringify((tokens || []).slice(-300))); } catch (e) { /* ignore */ }
  }
  function markSeen(items) {
    var seen = readSeen();
    var set = {};
    seen.forEach(function (t) { set[t] = true; });
    (items || []).forEach(function (it) { if (it && it.seen_token && !set[it.seen_token]) { seen.push(it.seen_token); set[it.seen_token] = true; } });
    writeSeen(seen);
  }
  function hasUnseen(items) {
    var set = {};
    readSeen().forEach(function (t) { set[t] = true; });
    return (items || []).some(function (it) { return it && it.seen_token && !set[it.seen_token]; });
  }

  function timeAgo(iso) {
    var t = Date.parse(iso || '');
    if (!isFinite(t)) return '';
    var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
    var h = Math.floor(m / 60);
    if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
    var d = Math.floor(h / 24);
    return d + (d === 1 ? ' day ago' : ' days ago');
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  // "3 need your review: 1 GMC check, 2 document reviews"
  function summaryText(data) {
    var items = (data && data.items) || [];
    if (!items.length) return '';
    var parts = [];
    var regByLabel = {};
    var regOrder = [];
    var mismatch = 0, docs = 0;
    items.forEach(function (it) {
      if (it.kind === 'register_pending') {
        var l = it.register_label || 'register';
        if (!regByLabel[l]) { regByLabel[l] = 0; regOrder.push(l); }
        regByLabel[l]++;
      } else if (it.kind === 'register_mismatch') mismatch++;
      else if (it.kind === 'docs') docs += (it.count || 1);
    });
    regOrder.forEach(function (l) { parts.push(plural(regByLabel[l], l + ' check', l + ' checks')); });
    if (mismatch) parts.push(plural(mismatch, 'register mismatch', 'register mismatches'));
    if (docs) parts.push(plural(docs, 'document review', 'document reviews'));
    return items.length + (items.length === 1 ? ' needs' : ' need') + ' your review: ' + parts.join(', ');
  }

  function setTabDot(data) {
    var el = document.getElementById('masterDocReviewAlert');
    if (!el) return;
    var n = (data && data.counts && data.counts.total) || 0;
    if (n > 0) {
      el.setAttribute('data-count', String(n));
      el.textContent = '!';
      el.title = summaryText(data);
    } else {
      el.removeAttribute('data-count');
      el.textContent = '';
      el.removeAttribute('title');
    }
  }

  // ---------------- modal ----------------
  function modalOverlay() { return document.getElementById('modalOverlay'); }
  function modalBox() { return document.getElementById('modalBox'); }
  function ourModalOpen() {
    var o = modalOverlay(), b = modalBox();
    return !!(o && b && o.classList.contains('open') && b.querySelector('[' + MODAL_MARK + ']'));
  }
  // Something else is on screen that we must not cover: another dashboard
  // modal, or an ATS drawer/modal in #atsOverlayRoot.
  function otherModalOpen() {
    var o = modalOverlay();
    if (o && o.classList.contains('open') && !ourModalOpen()) return true;
    var ats = document.getElementById('atsOverlayRoot');
    if (ats && ats.children) {
      for (var i = 0; i < ats.children.length; i++) {
        var ch = ats.children[i];
        if (ch && !(ch.classList && ch.classList.contains('ats-toast'))) return true; // a toast is not a modal
      }
    }
    return false;
  }

  function itemHtml(it, i) {
    var when = timeAgo(it.since);
    return '<div class="rq-item">' +
      '<div class="rq-item-ico" aria-hidden="true">!</div>' +
      '<div class="rq-item-body">' +
        '<div class="rq-item-name">' + esc(it.gp_name || 'Doctor') + '</div>' +
        '<div class="rq-item-title">' + esc(it.title || '') + '</div>' +
        '<div class="rq-item-detail">' + esc(it.detail || '') + '</div>' +
        (when ? '<div class="rq-item-when">Waiting since ' + esc(when) + '</div>' : '') +
      '</div>' +
      '<button type="button" class="btn btn-red rq-review-now" data-rq-index="' + i + '">Review now</button>' +
    '</div>';
  }

  function modalHtml(items) {
    return '<div ' + MODAL_MARK + '="1" class="rq-modal">' +
      '<div class="modal-title rq-title"><span class="rq-title-dot" aria-hidden="true">!</span> Needs your review (' + items.length + ')</div>' +
      '<div class="rq-intro">These are waiting on you. “Review now” takes you straight to the action.</div>' +
      '<div class="rq-list">' + items.map(itemHtml).join('') + '</div>' +
      '<div class="modal-actions"><button type="button" class="btn rq-later">Remind me later</button></div>' +
    '</div>';
  }

  function closeOurModal() {
    if (!ourModalOpen()) return;
    if (typeof window.closeModal === 'function') window.closeModal();
    else { var o = modalOverlay(), b = modalBox(); if (o) o.classList.remove('open'); if (b) b.innerHTML = ''; }
  }

  function goTo(item) {
    if (!item) return;
    var id = item.case_id || item.user_id;
    if (!id) return;
    var target = 'candidate=' + encodeURIComponent(id) + (item.focus ? '&focus=' + encodeURIComponent(item.focus) : '');
    var current = String(location.hash || '').replace(/^#/, '');
    if (current === target) {
      // Same hash: hashchange will not fire — open it directly.
      if (window.ATS && typeof window.ATS.applyHash === 'function') window.ATS.applyHash();
    } else {
      location.hash = target;
    }
  }

  function showModal() {
    var data = state.data;
    var items = (data && data.items) || [];
    if (!items.length) { closeOurModal(); state.pendingShow = false; return; }
    if (otherModalOpen()) { deferShow(); return; }
    state.pendingShow = false;
    state.shownThisLoad = true;
    markSeen(items);
    var html = modalHtml(items);
    if (ourModalOpen()) { modalBox().innerHTML = html; }
    else if (typeof window.openModal === 'function') window.openModal(html);
    else return;
    var box = modalBox();
    if (!box) return;
    var later = box.querySelector('.rq-later');
    if (later) later.addEventListener('click', function () { markSeen(items); closeOurModal(); });
    var btns = box.querySelectorAll('.rq-review-now');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function (e) {
        var idx = Number(e.currentTarget.getAttribute('data-rq-index'));
        var it = items[idx];
        markSeen(items);
        closeOurModal();
        goTo(it);
      });
    }
  }

  function deferShow() {
    state.pendingShow = true;
    if (state.deferTimer) return;
    state.deferTimer = setInterval(function () {
      if (!state.pendingShow) { clearInterval(state.deferTimer); state.deferTimer = null; return; }
      if (!otherModalOpen()) {
        clearInterval(state.deferTimer); state.deferTimer = null;
        showModal();
      }
    }, 1500);
  }

  function maybeShow() {
    var items = (state.data && state.data.items) || [];
    if (!items.length) { closeOurModal(); return; }
    if (ourModalOpen()) { showModal(); return; } // refresh the open list in place
    if (!state.shownThisLoad || hasUnseen(items)) showModal();
  }

  // ---------------- data ----------------
  function emit() {
    try {
      var ev;
      if (typeof window.CustomEvent === 'function') ev = new CustomEvent('gp:review-queue', { detail: state.data });
      else { ev = document.createEvent('CustomEvent'); ev.initCustomEvent('gp:review-queue', false, false, state.data); }
      window.dispatchEvent(ev);
    } catch (e) { /* ignore */ }
  }

  function fetchQueue() {
    return fetch('/api/ceo/review-queue', { credentials: 'same-origin', cache: 'no-store', headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .catch(function () { return { ok: false }; });
  }

  // refresh() — fetch the queue fresh, update the tab "!", tell open profiles,
  // and pop the modal when the rules say so. A call made while a read is in
  // flight (e.g. right after a review action) queues ONE follow-up read, so
  // the result can never predate the action.
  function refresh() {
    if (!isCeo()) return Promise.resolve(null);
    if (state.inflight) { state.again = true; return state.inflight; }
    state.inflight = fetchQueue().then(function (d) {
      state.inflight = null;
      state.lastFetchAt = Date.now();
      if (state.again) { state.again = false; setTimeout(refresh, 0); }
      if (!d || !d.ok) return state.data;
      state.data = { items: Array.isArray(d.items) ? d.items : [], counts: d.counts || { total: 0 }, generated_at: d.generated_at || '' };
      setTabDot(state.data);
      emit();
      maybeShow();
      return state.data;
    }, function () { state.inflight = null; state.again = false; return state.data; });
    return state.inflight;
  }

  // Review items for one doctor (profile banner). Matches on user_id or case_id.
  function itemsFor(userId, caseId) {
    var items = (state.data && state.data.items) || [];
    var u = String(userId || ''), c = String(caseId || '');
    return items.filter(function (it) {
      return (u && String(it.user_id || '') === u) || (c && String(it.case_id || '') === c);
    });
  }

  window.CeoReviewQueue = {
    refresh: refresh,
    itemsFor: itemsFor,
    summaryText: summaryText,
    // True once a queue read succeeded: refreshDashboard() then leaves the
    // Candidates-tab "!" alone instead of resetting it to the doc-only count.
    ownsTabDot: function () { return !!state.data; },
    data: function () { return state.data; },
    show: function () { if (state.data) showModal(); }
  };

  // Boot: checkAuth() in the inline script stamps the role asynchronously and
  // calls refreshDashboard() (which calls refresh()) — but it can resolve
  // before this file has loaded. Kick one read ourselves once the role is known.
  (function boot(tries) {
    if (isCeo()) { if (!state.data && !state.inflight) refresh(); return; }
    if (role() === 'consultant') return;
    if (tries > 0) setTimeout(function () { boot(tries - 1); }, 250);
  })(80);
})();

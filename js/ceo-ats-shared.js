/* ============================================================================
 * ceo-ats-shared.js — master-tab switcher + shared helpers for the in-app ATS.
 * Loaded by pages/ceo-dashboard.html after its inline script. Exposes window.ATS.
 * Tab modules (candidates/jobs/practices) register window.load<Tab>Tab().
 * ========================================================================== */
(function () {
  'use strict';

  var AVATAR_COLORS = ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#22d3ee', '#fb923c', '#818cf8'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function escAttr(s) { return esc(s); }
  function initials(name) {
    return String(name || '').replace(/^Dr\s+/i, '').trim().split(/\s+/).map(function (w) { return w[0] || ''; }).slice(0, 2).join('').toUpperCase() || '?';
  }
  function avatarColor(name) {
    var s = String(name || 'x');
    return AVATAR_COLORS[(s.charCodeAt(s.length - 1) + s.length) % AVATAR_COLORS.length];
  }
  function flag(country) {
    var c = String(country || '').toLowerCase();
    if (/united kingdom|\buk\b|britain|england|scotland|wales|gb/.test(c)) return '🇬🇧';
    if (/ireland|\bie\b|irish/.test(c)) return '🇮🇪';
    if (/new zealand|\bnz\b/.test(c)) return '🇳🇿';
    if (/australia|\bau\b/.test(c)) return '🇦🇺';
    return '🌐';
  }
  function countryLabel(country) {
    var f = flag(country);
    return country ? (f + ' ' + esc(country)) : '—';
  }
  function bandClass(score) {
    if (score == null) return 'cold';
    return score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold';
  }
  function bandLabel(score) {
    if (score == null) return '—';
    return score >= 70 ? 'Hot' : score >= 40 ? 'Warm' : 'Cold';
  }

  // Fetch JSON from a same-origin endpoint. Returns parsed body or { ok:false }.
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: { 'Accept': 'application/json' } };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return { ok: false, status: r.status }; });
    }).catch(function () { return { ok: false, message: 'Network error' }; });
  }

  function toast(msg) {
    if (typeof window.showToast === 'function') { try { window.showToast(msg); return; } catch (e) { /* fall through */ } }
    var root = document.getElementById('atsOverlayRoot') || document.body;
    var t = document.createElement('div');
    t.className = 'ats-toast';
    t.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg> ' + esc(msg);
    root.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300); }, 2600);
  }

  // Overlay host (drawers / modals) rendered into #atsOverlayRoot.
  function setOverlay(html) {
    var root = document.getElementById('atsOverlayRoot');
    if (root) root.innerHTML = html || '';
  }

  // Loading / empty helpers.
  function loadingHtml(label) { return '<div class="ats-empty" style="padding:48px">' + esc(label || 'Loading…') + '</div>'; }
  function emptyHtml(label) { return '<div class="ats-empty" style="padding:40px">' + esc(label || 'Nothing here yet.') + '</div>'; }

  // Intent bar markup used by candidate list + cards.
  function intentChip(score, band) {
    var bl = (band || bandClass(score)).toLowerCase();
    var s = score == null ? '—' : score;
    return '<div class="ats-intent-chip">' +
      '<div class="ats-intent-bar"><i class="ats-fill-' + bl + '" style="width:' + (score == null ? 0 : score) + '%"></i></div>' +
      '<span class="ats-intent-score ats-band-' + bl + '">' + s + '</span>' +
      '<span class="ats-pill ' + (bl === 'hot' ? 'red' : bl === 'warm' ? 'amber' : 'muted') + '">' + bandLabel(score) + '</span></div>';
  }

  window.ATS = {
    esc: esc, escAttr: escAttr, initials: initials, avatarColor: avatarColor,
    flag: flag, countryLabel: countryLabel, bandClass: bandClass, bandLabel: bandLabel,
    api: api, toast: toast, setOverlay: setOverlay,
    loadingHtml: loadingHtml, emptyHtml: emptyHtml, intentChip: intentChip,
    activeTab: 'registration'
  };

  // -------------------- master-tab switcher --------------------
  var MASTER_PANELS = ['registration', 'candidates', 'jobs', 'practices'];
  function showMaster(name) {
    if (!name || name === window.ATS.activeTab) {
      // still (re)load if switching to same tab is requested explicitly the first time
    }
    window.ATS.activeTab = name;
    var tabs = document.querySelectorAll('#masterTabs .ats-master-tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-mtab') === name);
    MASTER_PANELS.forEach(function (k) {
      var el = document.getElementById('panel-' + k);
      if (el) el.style.display = (k === name) ? '' : 'none';
    });
    if (name !== 'registration') {
      var fn = window['load' + name.charAt(0).toUpperCase() + name.slice(1) + 'Tab'];
      if (typeof fn === 'function') { try { fn(); } catch (e) { console.error('[ATS] tab load failed', name, e); } }
    }
    if (window.scrollTo) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function initSwitcher() {
    var bar = document.getElementById('masterTabs');
    if (!bar) return;
    bar.addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('.ats-master-tab[data-mtab]') : null;
      if (!item) return;
      showMaster(item.getAttribute('data-mtab'));
    });
    // Populate the count chips once (lightweight).
    api('/api/ceo/candidates').then(function (d) { var el = document.getElementById('masterCandCount'); if (el && d && d.ok) el.textContent = d.total != null ? d.total : (d.candidates ? d.candidates.length : ''); });
    api('/api/ats/jobs').then(function (d) { var el = document.getElementById('masterJobsCount'); if (el && d && d.ok) el.textContent = d.open_count != null ? d.open_count : (d.jobs ? d.jobs.length : ''); });
    api('/api/ats/practices').then(function (d) { var el = document.getElementById('masterPracCount'); if (el && d && d.ok) el.textContent = d.total != null ? d.total : (d.practices ? d.practices.length : ''); });
  }
  window.ATS.showMaster = showMaster;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSwitcher);
  else initSwitcher();
})();

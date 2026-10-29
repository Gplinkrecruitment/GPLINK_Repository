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
    // A mutation drops only the SWR entries for the resource family it touched
    // (plus the dashboard + review queue) — see __gpSwr.invalidate in the CEO
    // dashboard's inline script. It used to purge the WHOLE namespace, so one
    // small save made every tab a cold AU→US round trip again (owner 2026-10-29:
    // "extremely slow loading times when I click through"). Unrelated views keep
    // their cached paint; every swr() view still revalidates over the network.
    if (window.__gpSwr && opts.method && opts.method !== 'GET') {
      try { if (window.__gpSwr.invalidate) window.__gpSwr.invalidate(path); } catch (e) { /* ignore */ }
    }
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: { 'Accept': 'application/json' } };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return { ok: false, status: r.status }; });
    }).catch(function () { return { ok: false, message: 'Network error' }; });
  }

  // SWR wrapper over api() — same contract as the dashboard's gpSwr(): onData
  // (payload, fromCache) runs up to twice, once synchronously with the cached
  // payload (if any), then with the network result. Storage lives in the CEO
  // dashboard's window.__gpSwr helpers (sessionStorage); when absent (module
  // loaded standalone) this degrades to a plain network fetch.
  // opts.skipCache — a quiet revalidation of a view that is already painted
  // (the cache IS what is on screen): go straight to the network and repaint
  // once, not twice. The result is still written to the cache as usual.
  function swr(path, onData, opts) {
    var S = window.__gpSwr;
    var cached = (S && !(opts && opts.skipCache)) ? S.read(path) : null;
    if (cached) { try { onData(cached, true); } catch (e) { /* ignore */ } }
    return api(path).then(function (d) {
      if (S) { if (d && d.ok) S.write(path, d); else S.drop(path); }
      onData(d, false);
      return d;
    });
  }

  // type 'error' keeps a failure notice on screen long enough to read.
  function toast(msg, type) {
    if (typeof window.showToast === 'function') { try { window.showToast(msg, type || undefined); return; } catch (e) { /* fall through */ } }
    var root = document.getElementById('atsOverlayRoot') || document.body;
    var t = document.createElement('div');
    t.className = 'ats-toast' + (type === 'error' ? ' ats-toast--error' : '');
    t.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg> ' + esc(msg);
    root.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300); }, type === 'error' ? 8000 : 2600);
  }

  // Owner 2026-10-29: the "Export CSV" controls were bare <a href="/api/admin/
  // export…"> links. When the server answered with JSON instead of a file
  // (expired session → 401, bad entity → 400, 500) the browser NAVIGATED the
  // whole dashboard to that JSON — "the entire page refreshing … taking me out
  // of the page I was on". Fetch the export ourselves, check it really is a CSV,
  // and hand it over as a Blob download; on any failure show the server's
  // message as a toast and stay exactly where we are.
  function downloadCsv(url, fallbackName) {
    return fetch(url, { credentials: 'same-origin', headers: { 'Accept': 'text/csv, application/json' } }).then(function (r) {
      var ct = String(r.headers.get('content-type') || '').toLowerCase();
      if (!r.ok || ct.indexOf('text/csv') === -1) {
        return r.json().catch(function () { return {}; }).then(function (b) {
          throw new Error((b && (b.message || b.error)) || ('export failed (HTTP ' + r.status + ')'));
        });
      }
      var name = fallbackName || 'export.csv';
      var cd = String(r.headers.get('content-disposition') || '');
      var m = /filename="?([^";]+)"?/i.exec(cd);
      if (m && m[1]) name = m[1];
      return r.blob().then(function (blob) {
        var objUrl = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = objUrl;
        a.download = name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); URL.revokeObjectURL(objUrl); }, 1500);
        return true;
      });
    }).catch(function (e) {
      toast('Export failed: ' + ((e && e.message) || 'network error'), 'error');
      return false;
    });
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

  // Role helpers — checkAuth (ceo-dashboard.html inline) stamps the session
  // role onto window.__gpAdminRole ('super_admin' | 'consultant'). Empty until
  // the session check resolves, so treat '' as "not (yet) known".
  function role() { return String(window.__gpAdminRole || ''); }
  function isConsultant() { return role() === 'consultant'; }

  window.ATS = {
    esc: esc, escAttr: escAttr, initials: initials, avatarColor: avatarColor,
    flag: flag, countryLabel: countryLabel, bandClass: bandClass, bandLabel: bandLabel,
    api: api, swr: swr, toast: toast, setOverlay: setOverlay, downloadCsv: downloadCsv,
    loadingHtml: loadingHtml, emptyHtml: emptyHtml, intentChip: intentChip,
    role: role, isConsultant: isConsultant,
    activeTab: 'registration',
    // tab name -> ms timestamp of the last time its loader (or a drill-in
    // opener via skipLoad) was asked to fill the panel. Drives quiet re-entry.
    tabLoadedAt: {}
  };

  // -------------------- master-tab switcher --------------------
  // 'registration' renders the Overview view; 'rso' + 'technical' are executive-only
  // tabs whose loaders (window.loadRsoTab / window.loadTechnicalTab) are bridged onto
  // the CEO dashboard's loadRsoOversight() / loadTechnical() inside ceo-dashboard.html.
  var MASTER_PANELS = ['registration', 'rso', 'candidates', 'jobs', 'practices', 'matching', 'meetings', 'leads', 'contracts', 'social', 'technical'];
  // A tab revisited within this window is re-entered QUIETLY: its loader is
  // told { quiet: true } and must not paint a placeholder, wipe the panel, or
  // close an open drill-in — it revalidates in the background and repaints only
  // a list/scaffold that is actually on screen. Older than this and the tab
  // reloads in full as before.
  var QUIET_REENTRY_MS = 5 * 60 * 1000;
  // Toggle the active tab + panel visibility. skipLoad=true leaves rendering to a
  // deep-link opener (so a drill-in profile/board isn't clobbered by the list loader).
  // force=true (hash navigation only) reloads even when the tab is unchanged,
  // so browser back from #candidate=<id> to #candidates still shows the list.
  function setActiveTab(name, skipLoad, force) {
    // Consultants are ATS-only: the Registration tab is hidden for them, so a
    // deep-link/hash pointing at it lands on Candidates instead (the server
    // 403s all Registration data for consultants anyway — this is cosmetic).
    if (name === 'registration' && isConsultant()) name = 'candidates';
    var sameTab = window.ATS.activeTab === name;
    window.ATS.activeTab = name;
    var tabs = document.querySelectorAll('#masterTabs .ats-master-tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-mtab') === name);
    MASTER_PANELS.forEach(function (k) {
      var el = document.getElementById('panel-' + k);
      if (el) el.style.display = (k === name) ? '' : 'none';
    });
    var loadedAt = window.ATS.tabLoadedAt || (window.ATS.tabLoadedAt = {});
    if (skipLoad) {
      // A drill-in opener is about to fill the panel with fresh content, so the
      // tab counts as loaded now (a later re-entry stays quiet and keeps it).
      loadedAt[name] = Date.now();
      return;
    }
    // Owner 2026-10-29: re-clicking the tab you are already on used to re-run
    // its loader — placeholder, refetch, scroll to top, open drill-in gone.
    // Nothing is stale on a tab that is already showing; do nothing.
    if (sameTab && loadedAt[name] && !force) return;
    var fn = window['load' + name.charAt(0).toUpperCase() + name.slice(1) + 'Tab'];
    if (typeof fn !== 'function') return;
    var quiet = !force && !!loadedAt[name] && (Date.now() - loadedAt[name]) < QUIET_REENTRY_MS;
    loadedAt[name] = Date.now();
    try {
      // Every loader, the Social hub included, takes { quiet } and decides for
      // itself what a quiet re-entry means (keep what is on screen, revalidate).
      if (quiet) fn({ quiet: true });
      else fn();
    } catch (e) { console.error('[ATS] tab load failed', name, e); }
  }
  function showMaster(name) {
    if (!name) return;
    var unchanged = window.ATS.activeTab === name;
    setActiveTab(name, false);
    // Same tab: no history rewrite, no scroll — leave the owner where they are.
    if (unchanged) return;
    try { if (('' + (location.hash || '')).replace('#', '') !== name) history.replaceState(null, '', '#' + name); } catch (e) { /* ignore */ }
    if (window.scrollTo) window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  // Deep-link: #candidates | #jobs | #practices | #registration, plus drill-ins
  // #candidate=<id> | #board=<jobId> | #practice=<id>. Returns true if handled.
  // #candidate=<id>&focus=<register|docs> (the review popup's "Review now")
  // opens the profile and scrolls to + highlights that section.
  function parseCandidateHash(h) {
    var parts = String(h || '').replace(/^candidate=/, '').split('&');
    var out = { id: '', focus: '' };
    try { out.id = decodeURIComponent(parts[0] || ''); } catch (e) { out.id = parts[0] || ''; }
    for (var i = 1; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (kv[0] === 'focus') { try { out.focus = decodeURIComponent(kv[1] || ''); } catch (e2) { out.focus = kv[1] || ''; } }
    }
    out.focus = /^[a-z_]{1,32}$/.test(out.focus) ? out.focus : '';
    return out;
  }
  function applyHash() {
    var h = ('' + (location.hash || '')).replace(/^#/, '');
    if (!h) return false;
    function drill(tab, opener, arg, opts) {
      setActiveTab(tab, true);
      var fn = window[opener];
      if (typeof fn === 'function') { try { if (opts) fn(arg, opts); else fn(arg); } catch (e) { console.error('[ATS] deep-link failed', opener, e); } }
      if (window.scrollTo) window.scrollTo({ top: 0 });
    }
    if (h.indexOf('candidate=') === 0) {
      var ch = parseCandidateHash(h);
      drill('candidates', 'atsOpenCandidate', ch.id, ch.focus ? { focus: ch.focus } : null);
      return true;
    }
    if (h.indexOf('board=') === 0) { drill('jobs', 'atsOpenJobBoard', h.split('=')[1]); return true; }
    if (h.indexOf('practice=') === 0) { drill('practices', 'atsOpenPractice', h.split('=')[1]); return true; }
    if (h === 'meetings') { setActiveTab('meetings', false, true); return true; }
    if (MASTER_PANELS.indexOf(h) !== -1) { setActiveTab(h, false, true); return true; }
    return false;
  }

  function initSwitcher() {
    var bar = document.getElementById('masterTabs');
    if (!bar) return;
    bar.addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('.ats-master-tab[data-mtab]') : null;
      if (!item) return;
      showMaster(item.getAttribute('data-mtab'));
    });
    window.addEventListener('hashchange', applyHash);
    // Populate the count chips. None of these endpoints has a counts-only
    // variant (each one builds the full list and reports total/open_count over
    // it — checked in server.js 2026-10-29), so the three list fetches are
    // heavy. SWR: a cached count paints synchronously at boot; the network
    // revalidation is deferred until the browser is idle so it never competes
    // with the first paint of whichever tab the owner actually opened (each
    // tab's own list fetch updates its chip too).
    var chipPaint = {
      '/api/ceo/candidates': function (d) { var el = document.getElementById('masterCandCount'); if (el && d && d.ok) el.textContent = d.total != null ? d.total : (d.candidates ? d.candidates.length : ''); },
      '/api/ats/jobs': function (d) { var el = document.getElementById('masterJobsCount'); if (el && d && d.ok) el.textContent = d.open_count != null ? d.open_count : (d.jobs ? d.jobs.length : ''); },
      '/api/ats/practices': function (d) { var el = document.getElementById('masterPracCount'); if (el && d && d.ok) el.textContent = d.total != null ? d.total : (d.practices ? d.practices.length : ''); }
    };
    Object.keys(chipPaint).forEach(function (path) {
      var cached = window.__gpSwr ? window.__gpSwr.read(path) : null;
      if (cached) { try { chipPaint[path](cached); } catch (e) { /* ignore */ } }
    });
    function whenIdle(fn) {
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(function () { fn(); }, { timeout: 3000 });
      else setTimeout(fn, 3000);
    }
    whenIdle(function () {
      Object.keys(chipPaint).forEach(function (path) { swr(path, chipPaint[path]); });
    });
    // Contracts is an ALERT, not a count: a contract landing means somebody is
    // waiting on the CEO, so it gets a red "!" that stays until every one is
    // actioned (submitted to the GP / returned to the practice). Setting the
    // data-count attribute is what reveals it — see .ats-alert-dot in ceo-ats.css.
    window.ATS.refreshContractsAlert = function () {
      swr('/api/ceo/contracts', function (d) {
        var el = document.getElementById('masterContractsAlert');
        if (!el || !d || !d.ok) return;
        var n = d.needsReview != null
          ? d.needsReview
          : (d.contracts || []).filter(function (c) { return c.status === 'uploaded' || c.status === 'changes_requested'; }).length;
        if (n > 0) {
          el.setAttribute('data-count', String(n));
          el.textContent = '!';
          el.title = n + (n === 1 ? ' contract needs' : ' contracts need') + ' your review';
        } else {
          el.removeAttribute('data-count');
          el.textContent = '';
          el.removeAttribute('title');
        }
      });
    };
    // Boot: same idle deferral as the chips above (it is a full contracts list
    // fetch); after an action the callers invoke it directly, right away.
    whenIdle(function () { window.ATS.refreshContractsAlert(); });
    // Same idea for the monthly social review: a month sitting unapproved means
    // the owner is the blocker, so the dot shows without opening the tab.
    if (typeof window.ATS_refreshSocialAlert === 'function') window.ATS_refreshSocialAlert();
    // Honour an initial deep-link hash (used by tab links + screenshots).
    applyHash();
  }
  window.ATS.showMaster = showMaster;
  window.ATS.applyHash = applyHash;
  window.ATS.parseCandidateHash = parseCandidateHash;
  // Final-review fix (Finding 3): exposes the skipLoad-capable tab switch so a
  // drill-in opener (e.g. the Matching board's onOpenPractice/onOpenCandidate/
  // onOpenJob) can activate the tab WITHOUT triggering its list loader — the
  // same skipLoad=true path applyHash() already uses for #candidate=/#board=/
  // #practice= deep links, so an opened detail view isn't clobbered by a
  // late-arriving list fetch racing it.
  window.ATS.setActiveTab = setActiveTab;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSwitcher);
  else initSwitcher();
})();

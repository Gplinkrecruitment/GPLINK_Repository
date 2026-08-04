/* ============================================================================
 * ceo-ats-jobs.js — Jobs (ATS) tab for the in-app CEO ATS.
 * Classic <script> (NOT a module). Loaded by pages/ceo-dashboard.html after the
 * inline script and after /js/ceo-ats-shared.js (which exposes window.ATS).
 * Renders into #panel-jobs. Exposes window.loadJobsTab + window.atsOpenJobBoard.
 * Ports pages/ceo-dashboard-prototype.html (renderJobs / openBoard / drawer /
 * modals), but fetches the REAL /api/ats/* endpoints instead of in-memory data.
 * ========================================================================== */
(function () {
  'use strict';

  var A = window.ATS;
  if (!A) { console.error('[ATS] ceo-ats-jobs.js loaded before window.ATS'); return; }

  /* -------------------- stage definitions -------------------- */
  var STAGES = [
    { key: 'shortlisted', label: 'Shortlist',           color: '#7c3aed' },
    { key: 'applied',   label: 'Applied',               color: 'var(--ats-blue)' },
    { key: 'submitted', label: 'Submitted to Practice',  color: 'var(--ats-purple)' },
    { key: 'reviewing', label: 'Practice Reviewing',     color: 'var(--ats-amber)' },
    { key: 'interview', label: 'Interview',              color: 'var(--ats-blue)' },
    { key: 'offer',     label: 'Offer',                  color: 'var(--ats-green)' },
    { key: 'hired',     label: 'Hired',                  color: 'var(--ats-green)' }
  ];
  var REJECT = { key: 'not_proceeding', label: 'Not Proceeding', color: 'var(--ats-red)' };
  var ALL_STAGES = STAGES.concat([REJECT]);

  function stageColor(k) { for (var i = 0; i < ALL_STAGES.length; i++) { if (ALL_STAGES[i].key === k) return ALL_STAGES[i].color; } return 'var(--ats-dim)'; }
  function stageLabel(k) { for (var i = 0; i < ALL_STAGES.length; i++) { if (ALL_STAGES[i].key === k) return ALL_STAGES[i].label; } return k; }

  var AU_STATES = ['QLD', 'NSW', 'VIC', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
  var JOB_TYPES = ['Permanent · Full-time', 'Permanent · Part-time', 'Locum', 'Contract'];
  var JOB_STATUSES = [
    { value: 'open', label: 'Open' },
    { value: 'filled', label: 'Filled' },
    { value: 'closed', label: 'Closed' }
  ];
  // Phase 3 (Zoho decommission): intake-parity vocabulary. These are the SAME
  // enums lib/practice-pipeline.js validates, so the editor sends exactly what
  // the practice intake form does (billing_style/mmm/state), never the legacy
  // free-text `billing` key.
  var BILLING_STYLE_OPTS = [
    { value: 'mixed', label: 'Mixed billing' },
    { value: 'bulk', label: 'Bulk billing' },
    { value: 'private', label: 'Private billing' }
  ];
  var MMM_OPTS = [
    { value: '', label: '— Not specified —' },
    { value: 'MM1', label: 'MM1' }, { value: 'MM2', label: 'MM2' }, { value: 'MM3', label: 'MM3' },
    { value: 'MM4', label: 'MM4' }, { value: 'MM5', label: 'MM5' }, { value: 'MM6', label: 'MM6' },
    { value: 'MM7', label: 'MM7' }
  ];
  // Optional booleans (visa sponsorship, nursing on site) allow a blank
  // "unknown" — the server stores that as null (not a confirmed "no").
  var TRISTATE_OPTS = [
    { value: '', label: 'Unknown / blank' },
    { value: 'true', label: 'Yes' },
    { value: 'false', label: 'No' }
  ];

  /* -------------------- intake-editor field helpers -------------------- */
  // 'true'|'false'|'' (from a select/hidden) -> true|false|null.
  function boolFromSel(v) { return v === 'true' ? true : (v === 'false' ? false : null); }
  // boolean|null -> 'true'|'false'|'' (for prefilling a select/segment).
  function boolToSel(v) { return v === true ? 'true' : (v === false ? 'false' : ''); }

  function formSection(title, inner) {
    return '<div class="ats-edit-section" style="margin-top:16px;padding-top:12px;border-top:1px solid rgba(120,120,140,0.18)">' +
      '<div style="font-size:11.5px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--ats-dim);margin-bottom:8px">' + A.esc(title) + '</div>' +
      inner + '</div>';
  }
  function boolSelect(id, value) {
    return '<select id="' + id + '">' + valueOptions(TRISTATE_OPTS, boolToSel(value)) + '</select>';
  }
  // Prominent DPA yes/no segmented control (DPA is the owner's durable control —
  // it drives the doctor-facing masked title). Writes into a hidden input.
  function dpaSegment(hiddenId, segId, value) {
    var v = boolToSel(value);
    function btn(bv, label, color) {
      var on = v === bv;
      return '<button type="button" data-dpa-val="' + bv + '" ' +
        'style="flex:1;padding:11px 10px;border-radius:8px;cursor:pointer;font-weight:600;font-size:13.5px;' +
        'border:2px solid ' + (on ? color : 'rgba(120,120,140,0.3)') + ';' +
        'background:' + (on ? color : 'transparent') + ';color:' + (on ? '#fff' : 'var(--ats-dim)') + '">' + label + '</button>';
    }
    return '<input type="hidden" id="' + hiddenId + '" value="' + A.escAttr(v) + '" />' +
      '<div id="' + segId + '" style="display:flex;gap:8px">' +
        btn('true', 'DPA eligible', 'var(--ats-green)') +
        btn('false', 'Non-DPA', 'var(--ats-red)') +
      '</div>';
  }
  function bindDpaSegment(segId, hiddenId) {
    var seg = el(segId);
    if (!seg) return;
    seg.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-dpa-val]') : null;
      if (!b) return;
      var v = b.getAttribute('data-dpa-val');
      var hidden = el(hiddenId);
      if (hidden) hidden.value = v;
      var btns = seg.querySelectorAll('[data-dpa-val]');
      for (var i = 0; i < btns.length; i++) {
        var on = btns[i].getAttribute('data-dpa-val') === v;
        var color = btns[i].getAttribute('data-dpa-val') === 'true' ? 'var(--ats-green)' : 'var(--ats-red)';
        btns[i].style.border = '2px solid ' + (on ? color : 'rgba(120,120,140,0.3)');
        btns[i].style.background = on ? color : 'transparent';
        btns[i].style.color = on ? '#fff' : 'var(--ats-dim)';
      }
    });
  }

  /* -------------------- module state -------------------- */
  var currentBoardJobId = null;   // exposed indirectly via atsOpenJobBoard
  var boardData = null;           // last /api/ats/job/pipeline response
  var drawerCardId = null;        // open candidate drawer's application id
  var draggedId = null;           // card id mid-drag
  var settingsOriginal = null;    // job object as loaded into the settings modal
  var settingsPublicId = '';      // job.public_id — feeds the pending-review preview links (Task 4)
  var approvalJobId = null;       // job id open in the Review & approve modal
  var approvalJob = null;         // that job's card data (mutated locally after upload/reuse)
  var approvalImages = [];        // last /api/ats/suburb-images response, for the reuse picker

  /* -------------------- tiny helpers -------------------- */
  function panelEl() { return document.getElementById('panel-jobs'); }
  function el(id) { return document.getElementById(id); }
  function val(id) { var n = el(id); return n ? n.value : ''; }
  function on(id, evt, fn) { var n = el(id); if (n) n.addEventListener(evt, fn); }

  function searchSvg() {
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ats-dim)" stroke-width="2">' +
      '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
  }
  function locStr(o) { return (o && o.city ? o.city : '—') + (o && o.state ? ', ' + o.state : ''); }

  function optionsWithCurrent(list, current) {
    var arr = list.slice();
    if (current && arr.indexOf(current) === -1) arr.unshift(current);
    return arr;
  }
  function plainOptions(list, selected) {
    return list.map(function (o) {
      return '<option' + (String(o) === String(selected) ? ' selected' : '') + '>' + A.esc(o) + '</option>';
    }).join('');
  }
  function valueOptions(list, selected) {
    return list.map(function (o) {
      return '<option value="' + A.escAttr(o.value) + '"' + (String(o.value) === String(selected) ? ' selected' : '') + '>' + A.esc(o.label) + '</option>';
    }).join('');
  }
  // Settings-modal enum selects where the baseline can be blank/unmapped
  // (server editor payload returns ''). Without a blank option the select
  // visually defaults to the first real option, and the diff would then PATCH
  // that untouched value (silently rewriting the doctor-facing masked title).
  // Prepend a selected "— Not set —" (value "") whenever the baseline is
  // empty or not one of the known values; an explicit admin choice still wins.
  function valueOptionsMaybeBlank(list, selected) {
    var known = selected != null && selected !== '' &&
      list.some(function (o) { return String(o.value) === String(selected); });
    return (known ? '' : '<option value="" selected>— Not set —</option>') + valueOptions(list, selected);
  }
  // Same guard for the plain-text `type` select (value === label). Empty
  // baseline -> selected blank; a real (known or unmapped) value keeps the
  // existing optionsWithCurrent behaviour so it stays selected + diff-stable.
  function plainOptionsMaybeBlank(list, selected) {
    if (selected == null || selected === '') {
      return '<option value="" selected>— Not set —</option>' + plainOptions(list, '');
    }
    return plainOptions(optionsWithCurrent(list, selected), selected);
  }

  /* ============================================================
   * JOBS MAP
   * ------------------------------------------------------------
   * Australia map above the jobs list: one pin per JOB OPENING.
   * Keyless Leaflet + markercluster from jsdelivr + CARTO dark raster tiles
   * (all three already allowed by the CSP) — the Google Maps key is
   * referrer-restricted and not authorised for geocoding, so it is a dead end
   * for this. Fed by the internal /api/ats/job-map, which unlike the public
   * maps is NOT masked: a pin can name the role and the practice behind it.
   * ========================================================== */
  var JMAP_LEAFLET = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/';
  var JMAP_MARKERCLUSTER = 'https://cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/';
  var JMAP_PIN_SVG = '<svg viewBox="0 0 28 38"><path d="M14 0C6.3 0 0 6.2 0 14c0 9.5 14 24 14 24s14-14.5 14-24C28 6.2 21.7 0 14 0z" fill="#60a5fa"/><circle cx="14" cy="14" r="5.6" fill="#0f1117"/></svg>';

  var jmapDataPromise = null;   // one fetch shared across re-renders
  var jmapL = null, jmapMap = null, jmapCluster = null;
  var jmapAll = [], jmapActivePin = null, jmapOpenId = '';

  function jmapLoadCss(href) {
    if (document.querySelector('link[data-jmap="' + href + '"]')) return Promise.resolve();
    return new Promise(function (resolve) {
      var l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = href; l.setAttribute('data-jmap', href);
      // Resolve either way — a missing stylesheet costs looks, not function.
      // (Leaflet's own CSS positions the tiles, so it is awaited before L.map.)
      l.onload = function () { resolve(); };
      l.onerror = function () { resolve(); };
      document.head.appendChild(l);
    });
  }
  function jmapLoadScript(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-jmap="' + src + '"]');
      if (existing) {
        if (existing.getAttribute('data-loaded')) resolve();
        else {
          existing.addEventListener('load', function () { resolve(); });
          existing.addEventListener('error', function () { reject(); });
        }
        return;
      }
      var s = document.createElement('script');
      s.src = src; s.setAttribute('data-jmap', src);
      s.onload = function () { s.setAttribute('data-loaded', '1'); resolve(); };
      s.onerror = function () { reject(); };
      document.head.appendChild(s);
    });
  }
  function jmapLoadLibs() {
    return Promise.all([
      jmapLoadCss(JMAP_LEAFLET + 'leaflet.css'),
      jmapLoadCss(JMAP_MARKERCLUSTER + 'MarkerCluster.css')
    ])
      .then(function () { return jmapLoadScript(JMAP_LEAFLET + 'leaflet.js'); })
      .then(function () { return jmapLoadScript(JMAP_MARKERCLUSTER + 'leaflet.markercluster.js'); })
      .then(function () { return window.L; });
  }

  function jobMapSectionHtml() {
    return '<section class="ats-jmap-wrap" id="atsJobMapWrap" aria-label="Job openings on a map">' +
      '<div class="ats-jmap-head">' +
        '<span class="ats-jmap-dot"></span>' +
        '<b><span id="atsJmapCount">—</span> openings on the map</b>' +
        '<span class="sub">Click a pin to see the opening · pinch to zoom</span>' +
      '</div>' +
      '<div class="ats-jmap-stage">' +
        '<div class="ats-jmap-shell" id="atsJmapShell">' +
          '<div class="ats-jmap-frame">' +
            '<div class="ats-jmap" id="atsJmap"></div>' +
            '<div class="ats-jmap-loading" id="atsJmapLoading">Loading the map…</div>' +
          '</div>' +
        '</div>' +
        '<aside class="ats-jmap-detail" id="atsJmapDetail" aria-hidden="true"></aside>' +
      '</div>' +
    '</section>';
  }

  // The card a pin opens: the ROLE, then the practice it belongs to. "Open"
  // routes exactly like clicking the job's card in the list below — a job still
  // awaiting approval goes to the review screen, everything else to the board.
  function jmapDetailHtml(j) {
    var pending = j.approval_status === 'pending';
    var chips = statusPill(j.status) +
      (pending ? ' <span class="ats-pill amber">Awaiting approval</span>' : '');
    var facts = '';
    if (j.type) facts += '<dt>Type</dt><dd>' + A.esc(j.type) + '</dd>';
    if (j.billing) facts += '<dt>Billing</dt><dd>' + A.esc(j.billing) + '</dd>';
    facts += '<dt>Pipeline</dt><dd>' + (j.applicants || 0) + ' candidate' + ((j.applicants === 1) ? '' : 's') + '</dd>';
    return '<button type="button" class="ats-jmap-x" id="atsJmapClose" aria-label="Close">&times;</button>' +
      '<div class="ats-jmap-idc">' +
        '<div>' +
          '<h3 class="ats-jmap-name">' + A.esc(j.display_title || j.title || 'Untitled role') + '</h3>' +
          '<div class="ats-jmap-loc">📍 ' + A.esc([j.suburb || j.city, j.state].filter(Boolean).join(', ') || '—') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="ats-jmap-prac">🏥 ' + A.esc(j.practice_name || '—') + '</div>' +
      '<div class="ats-jmap-chips">' + chips + '</div>' +
      '<dl class="ats-jmap-facts">' + facts + '</dl>' +
      '<button type="button" class="ats-btn ats-btn-primary ats-jmap-cta" id="atsJmapOpen">' +
        (pending ? 'Review &amp; approve →' : 'Open this opening →') +
      '</button>';
  }

  function jmapFail() {
    var wrap = el('atsJobMapWrap');
    if (wrap) wrap.style.display = 'none'; // never leave an empty grey box
  }
  function jmapSetActivePin(node) {
    if (jmapActivePin) jmapActivePin.classList.remove('on');
    jmapActivePin = node || null;
    if (jmapActivePin) jmapActivePin.classList.add('on');
  }
  function jmapCloseDetail() {
    var d = el('atsJmapDetail');
    if (d) { d.classList.remove('open'); d.setAttribute('aria-hidden', 'true'); }
    jmapOpenId = '';
    jmapSetActivePin(null);
  }
  function jmapOpenDetail(j, marker) {
    var d = el('atsJmapDetail');
    if (!d) return;
    jmapOpenId = String(j.id);
    d.innerHTML = jmapDetailHtml(j);
    d.classList.add('open');
    d.setAttribute('aria-hidden', 'false');
    jmapSetActivePin(marker && marker._icon ? marker._icon.querySelector('.ats-jmap-pin') : null);
    on('atsJmapClose', 'click', jmapCloseDetail);
    on('atsJmapOpen', 'click', function () {
      if (j.approval_status === 'pending') openJobReview(j.id);
      else atsOpenJobBoard(j.id);
    });
  }

  // Rebuild the cluster from jmapAll, honouring the SAME search/state/open
  // filters the list below uses — the pins and the cards must answer the same
  // question, or the map quietly contradicts the list.
  function jmapMatchesFilters(j, f) {
    if (f.q) {
      var hay = (String(j.title || '') + ' ' + String(j.practice_name || '')).toLowerCase();
      if (hay.indexOf(f.q) === -1) return false;
    }
    if (f.state && String(j.state || '').toLowerCase() !== f.state) return false;
    if (f.status === 'open' && j.status !== 'open') return false;
    return true;
  }
  function jmapRenderPins() {
    if (!jmapCluster || !jmapL) return;
    jmapCluster.clearLayers();
    var raw = currentJobFilters();
    var f = { q: String(raw.q || '').toLowerCase(), state: String(raw.state || '').toLowerCase(), status: raw.status };
    var shown = 0, present = {};
    jmapAll.forEach(function (j) {
      if (!jmapMatchesFilters(j, f)) return;
      var cls = 'ats-jmap-pin';
      if (j.approval_status === 'pending') cls += ' pending';
      else if (j.status && j.status !== 'open') cls += ' inactive';
      var icon = jmapL.divIcon({
        className: 'ats-jmap-pin-wrap',
        html: '<div class="' + cls + '"><span class="pd">' + JMAP_PIN_SVG + '</span></div>',
        iconSize: [28, 38], iconAnchor: [14, 38]
      });
      var marker = jmapL.marker([j.lat, j.lng], { icon: icon, riseOnHover: true, title: j.display_title || '' });
      marker.on('click', function (e) {
        if (jmapL.DomEvent) jmapL.DomEvent.stopPropagation(e);
        jmapOpenDetail(j, marker);
      });
      jmapCluster.addLayer(marker);
      shown++; present[String(j.id)] = 1;
    });
    var countEl = el('atsJmapCount');
    if (countEl) countEl.textContent = shown;
    // If the open card's job was filtered out, close it — the card must never
    // describe an opening that is no longer on the map.
    if (jmapOpenId && !present[jmapOpenId]) jmapCloseDetail();
  }

  // Pinch-to-zoom. Leaflet's own touchZoom covers real touchscreens; a Mac
  // trackpad pinch instead arrives as a wheel event with ctrlKey set, which
  // Leaflet only reads when scrollWheelZoom is on — and turning that on would
  // hijack ordinary two-finger scrolling of the dashboard. So: plain scroll
  // passes through to the page, a pinch zooms the map.
  function jmapBindPinchZoom(container, map, L) {
    container.addEventListener('wheel', function (e) {
      if (!e.ctrlKey) return;      // ordinary scroll — let the page move
      e.preventDefault();
      var around = map.containerPointToLatLng(map.mouseEventToContainerPoint(e));
      // deltaY is small and continuous for a pinch; scale it into zoom levels.
      var next = map.getZoom() - e.deltaY * 0.012;
      map.setZoomAround(around, Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), next)), { animate: false });
    }, { passive: false });
    // Double-tap/click still zooms in, and the +/- buttons stay whole-step.
    if (L && L.Browser && L.Browser.touch) map.touchZoom.enable();
  }

  function jmapBoot() {
    var container = el('atsJmap');
    var shell = el('atsJmapShell');
    if (!container || !shell) return;
    // loadJobsTab replaces the whole panel, so any previous instance is bound
    // to a node no longer in the document — drop it before rebuilding.
    if (jmapMap) { try { jmapMap.remove(); } catch (e) { /* already gone */ } }
    jmapMap = null; jmapCluster = null; jmapActivePin = null; jmapOpenId = '';

    if (!jmapDataPromise) {
      jmapDataPromise = A.api('/api/ats/job-map').then(function (d) {
        return (d && d.ok && Array.isArray(d.jobs)) ? d.jobs : [];
      });
    }
    Promise.all([jmapDataPromise, jmapLoadLibs()]).then(function (results) {
      var jobs = results[0], L = results[1];
      // The panel can re-render while the libraries load — if this boot's
      // container is no longer the live one, a newer boot owns the map.
      if (el('atsJmap') !== container) return;
      if (!jobs.length || !L || !L.markerClusterGroup) { jmapFail(); return; }
      jmapL = L;
      jmapAll = jobs.filter(function (j) { return isFinite(j.lat) && isFinite(j.lng); });
      if (!jmapAll.length) { jmapFail(); return; }
      jmapMap = L.map(container, {
        center: [-27.8, 134.0], zoom: 4, minZoom: 3, maxZoom: 17,
        // zoomSnap:0 lets a pinch land on fractional zooms so it feels
        // continuous instead of jumping a whole level at a time; zoomDelta
        // keeps the +/- buttons on whole steps.
        zoomSnap: 0, zoomDelta: 1,
        scrollWheelZoom: false, touchZoom: true, zoomControl: true,
        attributionControl: true, worldCopyJump: true
      });
      jmapMap.attributionControl.setPrefix(false);
      // Dark CARTO basemap — the Command Centre is a dark UI; the light Voyager
      // tiles the public site uses would glare against it.
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd', maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>, CARTO'
      }).addTo(jmapMap);
      jmapMap.on('click', jmapCloseDetail);
      jmapBindPinchZoom(container, jmapMap, L);
      jmapCluster = L.markerClusterGroup({
        showCoverageOnHover: false, maxClusterRadius: 46, spiderfyOnMaxZoom: true,
        iconCreateFunction: function (c) {
          var n = c.getChildCount();
          return L.divIcon({ html: '<div>' + n + '</div>', className: 'ats-jmap-cluster' + (n >= 25 ? ' lg' : ''), iconSize: [36, 36] });
        }
      });
      jmapMap.addLayer(jmapCluster);
      jmapRenderPins();
      var loading = el('atsJmapLoading');
      if (loading) loading.classList.add('hide');
      // The Jobs panel is display:none until its tab is opened, so the map is
      // often built at zero size. Several beats, not one: a single late
      // invalidateSize still left an unpainted column down the right edge.
      var fix = function () { try { jmapMap.invalidateSize(); } catch (e) { /* removed */ } };
      [0, 120, 350, 800].forEach(function (ms) { setTimeout(fix, ms); });
      if (typeof ResizeObserver === 'function') { try { new ResizeObserver(fix).observe(shell); } catch (e) { /* unsupported */ } }
      window.addEventListener('resize', fix);
    }).catch(jmapFail);
  }

  /* ============================================================
   * JOBS LIST VIEW
   * ========================================================== */
  function loadJobsTab() {
    currentBoardJobId = null;
    boardData = null;
    var panel = panelEl();
    if (!panel) return;
    panel.innerHTML = listShellHtml();
    // Re-ask for the pins on every tab visit, so a job added (or approved,
    // filled, closed) since last time shows up. The endpoint is briefly cached
    // server-side, so this is close to free.
    jmapDataPromise = null;
    jmapBoot();

    on('atsAddJobBtn', 'click', openAddJobModal);
    on('ats-job-search', 'input', fetchAndRenderJobList);
    on('atsJobStateFilter', 'change', fetchAndRenderJobList);
    on('atsJobOpenFilter', 'change', fetchAndRenderJobList);

    var listEl = el('atsJobList');
    if (listEl) {
      listEl.addEventListener('click', function (e) {
        // A "View in app / on website" link is a normal <a> — let it navigate in
        // its new tab; do NOT also open the pipeline board for that job card.
        if (e.target.closest && e.target.closest('[data-ats-view]')) return;
        // "Review & approve" always opens the combined review screen (Task 4) —
        // never the standalone photo-only approval modal directly; the review
        // screen itself surfaces the suburb photo + approve/reject hand-off.
        var approveBtn = e.target.closest ? e.target.closest('[data-ats-approve-job]') : null;
        if (approveBtn) { openJobReview(approveBtn.getAttribute('data-ats-approve-job')); return; }
        var card = e.target.closest ? e.target.closest('.ats-job-card[data-job-id]') : null;
        if (!card) return;
        var jobId = card.getAttribute('data-job-id');
        // A pending job (auto-created on signing, no candidates yet) opens the
        // combined review screen; any other job still opens the candidate
        // pipeline board as before.
        if (card.getAttribute('data-approval-status') === 'pending') { openJobReview(jobId); return; }
        atsOpenJobBoard(jobId);
      });
    }
    fetchAndRenderJobList();
  }

  function listShellHtml() {
    return '<div id="atsJobsListView">' +
      '<div class="ats-section-head">' +
        '<div><h2>Jobs &amp; Hiring</h2>' +
        '<p>Your built-in ATS — every job, every candidate, in one pipeline.</p></div>' +
        '<button class="ats-btn ats-btn-primary" id="atsAddJobBtn">＋ Add job</button>' +
      '</div>' +
      '<div class="ats-toolbar">' +
        '<div class="ats-search">' + searchSvg() +
          '<input type="text" id="ats-job-search" placeholder="Search jobs or practices…" /></div>' +
        '<select id="atsJobStateFilter" style="width:auto">' +
          '<option value="">All states</option>' + plainOptions(AU_STATES, '') + '</select>' +
        '<select id="atsJobOpenFilter" style="width:auto">' +
          '<option value="all">All jobs</option><option value="open">Open only</option></select>' +
      '</div>' +
      jobMapSectionHtml() +
      '<div class="ats-job-list" id="atsJobList"></div>' +
    '</div>';
  }

  function currentJobFilters() {
    var openF = el('atsJobOpenFilter');
    return {
      q: (val('ats-job-search') || '').trim(),
      state: val('atsJobStateFilter') || '',
      status: (openF && openF.value === 'open') ? 'open' : ''
    };
  }
  function buildJobsPath(f) {
    var qs = [];
    if (f.q) qs.push('q=' + encodeURIComponent(f.q));
    if (f.state) qs.push('state=' + encodeURIComponent(f.state));
    if (f.status) qs.push('status=' + encodeURIComponent(f.status));
    return '/api/ats/jobs' + (qs.length ? '?' + qs.join('&') : '');
  }

  function fetchAndRenderJobList() {
    var listEl = el('atsJobList');
    if (listEl) listEl.innerHTML = A.loadingHtml('Loading jobs…');
    var f = currentJobFilters();
    A.swr(buildJobsPath(f), function (d) {
      var list = el('atsJobList');
      if (!list) return;
      if (!d || !d.ok) { list.innerHTML = A.emptyHtml('Could not load jobs.'); return; }
      var mc = el('masterJobsCount');
      if (mc && d.open_count != null) mc.textContent = d.open_count;
      var jobs = d.jobs || [];
      jmapRenderPins(); // pins narrow with the list, never independently of it
      if (!jobs.length) { list.innerHTML = A.emptyHtml('No jobs match your search.'); return; }
      list.innerHTML = jobs.map(jobCardHtml).join('');
    });
  }

  function statusPill(status) {
    if (status === 'open') return '<span class="ats-pill green">Open</span>';
    if (status === 'filled') return '<span class="ats-pill muted">Filled</span>';
    if (status === 'closed') return '<span class="ats-pill amber">Closed</span>';
    return '<span class="ats-pill muted">' + A.esc(status || '—') + '</span>';
  }

  // Practice-client pipeline (Task 9): jobs auto-created from a signed practice
  // agreement start life as approval_status:'pending' (hidden from GPs until an
  // admin uploads a suburb header photo and approves them).
  function approvalPill(j) {
    if (j.approval_status === 'pending') return '<span class="ats-pill amber">Pending approval</span>';
    if (j.approval_status === 'rejected') return '<span class="ats-pill muted">Rejected</span>';
    return '';
  }

  function stageSpark(stageCounts) {
    stageCounts = stageCounts || {};
    return STAGES.map(function (s) {
      var n = stageCounts[s.key] || 0;
      return '<i title="' + A.escAttr(s.label + ': ' + n) + '" style="background:' +
        (n ? s.color : 'rgba(255,255,255,0.08)') + ';opacity:' + (n ? 1 : 0.4) + '"></i>';
    }).join('');
  }

  // Cosmetic DPA / Non-DPA chip — only when the list payload carries the flag.
  function dpaChip(j) {
    if (j.dpa === true) return '<span class="ats-pill green">DPA</span>';
    if (j.dpa === false) return '<span class="ats-pill muted">Non-DPA</span>';
    return '';
  }

  function jobCardHtml(j) {
    var active = j.active_count || 0;
    var pending = j.approval_status === 'pending';
    var approveBtn = pending
      ? '<button type="button" class="ats-btn ats-btn-primary ats-btn-sm" data-ats-approve-job="' + A.escAttr(j.id) + '">Review &amp; approve</button>'
      : '';
    var chip = dpaChip(j);
    return '<div class="ats-job-card" data-job-id="' + A.escAttr(j.id) + '" data-approval-status="' + A.escAttr(j.approval_status || '') + '">' +
      '<div>' +
        '<h3>' + A.esc(j.masked_title || j.title || '—') + ' ' + statusPill(j.status) + ' ' + approvalPill(j) + (chip ? ' ' + chip : '') + '</h3>' +
        '<div class="ats-job-meta">' +
          '<span>🏥 ' + A.esc(j.practice_name || '—') + '</span>' +
          '<span>📍 ' + A.esc(j.suburb ? j.suburb : locStr(j)) + '</span>' +
          '<span>🗓 ' + A.esc(j.type || '—') + '</span>' +
          '<span>💳 ' + A.esc(j.billing || '—') + '</span>' +
        '</div>' +
        jobViewLinksHtml(j) +
      '</div>' +
      '<div class="ats-job-right">' +
        (pending ? approveBtn : '<div class="ats-stage-spark">' + stageSpark(j.stage_counts) + '</div>') +
        '<div class="ats-cand-count"><b>' + active + '</b> in pipeline</div>' +
      '</div>' +
    '</div>';
  }

  // Two "open this opening" links per job card: the in-app job page and the
  // public marketing page. Uses window.buildJobViewLinks (js/ats-job-view-links.js)
  // which turns the server-supplied public_id into the two URLs. The website link
  // is only shown once the job is actually live to the public (open + approved) —
  // a filled/closed/pending job has no public page yet. data-ats-view lets the
  // list click handler ignore these clicks so they don't also open the pipeline.
  function jobViewLinksHtml(j) {
    var links = (typeof window !== 'undefined' && window.buildJobViewLinks)
      ? window.buildJobViewLinks(j) : { publicId: '', appUrl: '', websiteUrl: '' };
    if (!links.publicId) return '';
    var isPublic = j.status === 'open' && j.approval_status !== 'pending' && j.approval_status !== 'rejected';
    var LINK = 'display:inline-flex;align-items:center;gap:4px;padding:4px 10px;margin-top:8px;' +
      'border:1px solid rgba(255,255,255,0.16);border-radius:8px;font-size:12px;font-weight:600;' +
      'color:inherit;text-decoration:none;background:rgba(255,255,255,0.05)';
    var html = '<div class="ats-job-links" style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<a data-ats-view href="' + A.escAttr(links.appUrl) + '" target="_blank" rel="noopener" ' +
        'title="Open this opening in the in-app job page" style="' + LINK + '">↗ View in app</a>';
    if (isPublic) {
      html += '<a data-ats-view href="' + A.escAttr(links.websiteUrl) + '" target="_blank" rel="noopener" ' +
        'title="Open this opening on the public website" style="' + LINK + '">↗ View on website</a>';
    }
    return html + '</div>';
  }

  /* ============================================================
   * PIPELINE BOARD VIEW
   * ========================================================== */
  function atsOpenJobBoard(jobId) {
    currentBoardJobId = jobId;
    var panel = panelEl();
    if (!panel) return;
    panel.innerHTML = A.loadingHtml('Loading pipeline…');
    A.api('/api/ats/job/pipeline?id=' + encodeURIComponent(jobId)).then(function (d) {
      if (currentBoardJobId !== jobId) return; // user navigated away mid-fetch
      var p = panelEl();
      if (!p) return;
      if (!d || !d.ok) {
        p.innerHTML = '<div class="ats-board-head"><button class="ats-back-btn" id="atsJobsBack">‹ All jobs</button></div>' +
          A.emptyHtml('Could not load this job pipeline.');
        on('atsJobsBack', 'click', loadJobsTab);
        return;
      }
      boardData = d;
      renderBoardView();
    });
  }

  function renderBoardView() {
    var panel = panelEl();
    if (!panel || !boardData) return;
    var job = boardData.job || {};
    panel.innerHTML =
      '<div class="ats-board-head"><button class="ats-back-btn" id="atsJobsBack">‹ All jobs</button></div>' +
      '<div class="ats-section-head" style="margin-bottom:6px">' +
        '<div><h2>' + A.esc(job.title || 'Job') + '</h2></div>' +
        '<button class="ats-btn ats-btn-ghost ats-btn-sm" id="atsJobSettingsBtn">⚙ Job settings</button>' +
      '</div>' +
      '<div class="ats-board-meta" id="atsBoardMeta"></div>' +
      '<div class="ats-board" id="atsBoard"></div>';
    on('atsJobsBack', 'click', loadJobsTab);
    on('atsJobSettingsBtn', 'click', openJobSettings);
    renderBoardMeta();
    renderBoard();
  }

  function computeActiveCount() {
    var cols = (boardData && boardData.columns) || [];
    var n = 0;
    for (var i = 0; i < cols.length; i++) {
      if (cols[i].key === 'not_proceeding') continue;
      n += (cols[i].cards || []).length;
    }
    return n;
  }

  // http(s)-only gate for the practice-supplied website — same rule the GP-facing
  // match card and job page use. Anything else renders nothing rather than
  // producing a javascript:/data: link in the admin console.
  function boardSafeUrl(value) {
    var v = String(value || '').trim();
    return /^https?:\/\//i.test(v) ? v : '';
  }

  function renderBoardMeta() {
    var elm = el('atsBoardMeta');
    if (!elm || !boardData) return;
    var job = boardData.job || {};
    // The clinic's own website. For a corporate group (ForHealth, GP West,
    // Spectrum) the practice record holds only the GROUP site, so the server
    // resolves this per-role — see resolveCareerRoleWebsiteUrl. Hidden entirely
    // when there is no URL on file.
    var website = boardSafeUrl(job.website);
    var websiteLabel = website.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    elm.innerHTML =
      '<span>🏥 ' + A.esc(job.practice_name || '—') + '</span>' +
      '<span>📍 ' + A.esc(locStr(job)) + '</span>' +
      '<span>🗓 ' + A.esc(job.type || '—') + '</span>' +
      '<span>💳 ' + A.esc(job.billing || '—') + '</span>' +
      (website
        ? '<span>🌐 <a class="ats-board-weblink" href="' + A.esc(website) + '" target="_blank" rel="noopener">' + A.esc(websiteLabel) + '</a></span>'
        : '') +
      '<span>' + computeActiveCount() + ' active candidates</span>';
  }

  function renderBoard() {
    var board = el('atsBoard');
    if (!board || !boardData) return;
    var cols = boardData.columns || [];
    board.innerHTML = cols.map(columnHtml).join('');
    attachBoardListeners();
  }

  function columnHtml(col) {
    var isReject = col.key === 'not_proceeding';
    var cards = col.cards || [];
    var inner = cards.length ? cards.map(cardHtml).join('') : '<div class="ats-empty">Drop here</div>';
    return '<div class="ats-pipeline-col' + (isReject ? ' lane-reject' : '') + '" data-stage="' + A.escAttr(col.key) + '">' +
      '<div class="ats-col-head">' +
        '<span class="ch-left"><span class="ats-dot" style="background:' + stageColor(col.key) + '"></span> ' + A.esc(col.label || stageLabel(col.key)) + '</span>' +
        '<span class="ats-col-count">' + cards.length + '</span>' +
      '</div>' + inner +
    '</div>';
  }

  // AI Matching (Task 3): status sub-label for a Shortlist-column card that
  // was actually matched (matched_at set) — never shown on a manually-dragged
  // Shortlist card with no match_* data. amber (<24h) uses the same visual
  // language as the offer-declined flag above.
  function matchStatusHtml(c) {
    if (!c || c.ats_stage !== 'shortlisted' || !c.matched_at) return '';
    var extendBtn = '<button class="ats-btn ats-btn-ghost ats-btn-sm" data-ats-extend="' + A.escAttr(c.id) + '" style="margin-top:5px;padding:2px 9px;font-size:10.5px">Extend 5 days</button>';
    if (c.match_outcome === 'expired') {
      return '<div class="ats-match-status ats-match-expired">expired — no response</div>' + extendBtn;
    }
    if (c.match_seen_at) {
      return '<div class="ats-match-status">seen — awaiting response</div>';
    }
    if (c.match_expires_at) {
      var msLeft = new Date(c.match_expires_at).getTime() - Date.now();
      if (msLeft <= 0) return '<div class="ats-match-status ats-match-expired">expired — no response</div>' + extendBtn; // not yet swept by the lifecycle cron
      var hoursLeft = Math.floor(msLeft / 3600000);
      var d = Math.floor(hoursLeft / 24);
      var h = hoursLeft % 24;
      return '<div class="ats-match-status' + (hoursLeft < 24 ? ' ats-match-amber' : '') + '">⏳ ' + d + 'd ' + h + 'h left</div>';
    }
    return '';
  }

  function cardHtml(c) {
    var notes = c.ats_notes || '';
    var snippet = notes ? '📝 ' + (notes.length > 22 ? notes.slice(0, 22) + '…' : notes) : 'No notes yet';
    // A5: a declined offer keeps its card in the Offer lane — flag it so the
    // board shows the card still needs attention (re-send or move on).
    var declinedMark = (c.offer_status === 'declined')
      ? '<span class="ats-card-declined" data-offer-declined="1" style="display:inline-block;margin-top:6px;font-size:10.5px;font-weight:600;color:var(--ats-amber);background:rgba(245,158,11,0.12);border-radius:6px;padding:2px 7px">⚠ Offer declined</span>'
      : '';
    return '<div class="ats-cand-card" draggable="true" data-id="' + A.escAttr(c.id) + '">' +
      '<div class="cc-top">' +
        '<div class="ats-avatar" style="background:' + A.avatarColor(c.name) + '">' + A.esc(A.initials(c.name)) + '</div>' +
        '<div><div class="cc-name">' + A.esc(c.name || '—') + '</div><div class="cc-sub">' + A.countryLabel(c.country) + '</div></div>' +
      '</div>' +
      '<div class="cc-foot"><span class="cc-sub">' + A.esc(snippet) + '</span></div>' + declinedMark + matchStatusHtml(c) +
    '</div>';
  }

  function attachBoardListeners() {
    var board = el('atsBoard');
    if (!board) return;
    var cols = board.querySelectorAll('.ats-pipeline-col');
    for (var i = 0; i < cols.length; i++) {
      cols[i].addEventListener('dragover', onDragOver);
      cols[i].addEventListener('dragleave', onDragLeave);
      cols[i].addEventListener('drop', onDrop);
    }
    var cards = board.querySelectorAll('.ats-cand-card');
    for (var k = 0; k < cards.length; k++) {
      cards[k].addEventListener('dragstart', onDragStart);
      cards[k].addEventListener('dragend', onDragEnd);
      cards[k].addEventListener('click', onCardClick);
    }
    // "Extend 5 days" (expired Shortlist cards) — stopPropagation so the click
    // doesn't also bubble into the card's onCardClick (which opens the drawer).
    var extendBtns = board.querySelectorAll('[data-ats-extend]');
    for (var x = 0; x < extendBtns.length; x++) {
      extendBtns[x].addEventListener('click', onExtendClick);
    }
  }

  function onExtendClick(e) {
    e.stopPropagation();
    var id = this.getAttribute('data-ats-extend');
    if (!id) return;
    A.api('/api/ats/application?id=' + encodeURIComponent(id), { method: 'PATCH', body: { match_extend: true } }).then(function (d) {
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not extend the match window'); return; }
      A.toast('Match window extended 5 days');
      if (currentBoardJobId) atsOpenJobBoard(currentBoardJobId);
    });
  }

  /* -------------------- drag & drop -------------------- */
  function onDragStart(e) {
    draggedId = this.getAttribute('data-id');
    this.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', draggedId); } catch (_) { /* IE guard */ }
    }
  }
  function onDragEnd() { this.classList.remove('dragging'); }
  function onDragOver(e) { e.preventDefault(); this.classList.add('drop-active'); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; }
  function onDragLeave() { this.classList.remove('drop-active'); }
  function onDrop(e) {
    e.preventDefault();
    this.classList.remove('drop-active');
    var stage = this.getAttribute('data-stage');
    var id = draggedId;
    draggedId = null;
    if (id && stage) moveCard(id, stage);
  }
  function onCardClick() { openCandidateDrawer(this.getAttribute('data-id')); }

  function findCard(id) {
    var cols = (boardData && boardData.columns) || [];
    for (var i = 0; i < cols.length; i++) {
      var cards = cols[i].cards || [];
      for (var j = 0; j < cards.length; j++) {
        if (String(cards[j].id) === String(id)) return { col: cols[i], card: cards[j], cardIdx: j };
      }
    }
    return null;
  }
  function columnByKey(key) {
    var cols = (boardData && boardData.columns) || [];
    for (var i = 0; i < cols.length; i++) { if (cols[i].key === key) return cols[i]; }
    return null;
  }
  function applyStageMove(id, stage) {
    var found = findCard(id);
    if (!found) return;
    found.col.cards.splice(found.cardIdx, 1);
    found.card.ats_stage = stage;
    var target = columnByKey(stage);
    if (target) { target.cards = target.cards || []; target.cards.push(found.card); }
  }

  // AI Matching (Task 6): live-stage keys eligible for the hired/closed
  // redirect fan-out — mirrors server.js redirectOthersForJob's own stage
  // list exactly (never 'offer', 'hired', or the reject stage).
  var REDIRECT_LIVE_STAGES = ['shortlisted', 'applied', 'submitted', 'reviewing', 'interview'];

  // Count of cards currently sitting in a redirect-eligible stage, from the
  // board data already loaded for this job — excludes `excludeId` (the card
  // being moved to Hired) when given; pass nothing for a whole-job close.
  function countOtherLiveCards(excludeId) {
    var cols = (boardData && boardData.columns) || [];
    var n = 0;
    for (var i = 0; i < cols.length; i++) {
      if (REDIRECT_LIVE_STAGES.indexOf(cols[i].key) === -1) continue;
      var cards = cols[i].cards || [];
      for (var j = 0; j < cards.length; j++) {
        if (excludeId != null && String(cards[j].id) === String(excludeId)) continue;
        n++;
      }
    }
    return n;
  }

  // EXACT confirm copy (brief): "<N> other GPs are still active on this job
  // — send them the redirect email?" Returns the redirect_others value to
  // send with the PATCH — true (OK), false (Cancel — the hire/close still
  // proceeds, just without the fan-out) — or undefined to skip the dialog
  // entirely when there's no one else on the job to redirect.
  function confirmRedirectOthers(excludeId) {
    var n = countOtherLiveCards(excludeId);
    if (n <= 0) return undefined;
    return window.confirm(n + ' other GPs are still active on this job — send them the redirect email?');
  }

  function redirectedSuffix(d) {
    if (d && typeof d.redirected === 'number' && d.redirected > 0) return ' · ' + d.redirected + ' GP(s) redirected';
    // Multi-GP opening: this hire did not fill the last seat, so the opening
    // stays open and the other candidates were kept live. Tell staff where it
    // stands rather than silently leaving them wondering.
    var p = d && d.positions;
    if (p && p.full === false && p.needed > 1) {
      return ' · ' + p.hired + ' of ' + p.needed + ' hired, opening stays open';
    }
    return '';
  }

  // AI Matching (Task 7, spec §9): late-withdrawal reason capture. Moving a
  // card to `not_proceeding` FROM `submitted` or later prompts staff for an
  // optional reason — "GP withdrew after submission" is the specific value
  // Task 8's career-lock work reads as a strike source (stored verbatim on
  // the stage event by the server as `reason`).
  var STAGE_RANK = {};
  STAGES.forEach(function (s, i) { STAGE_RANK[s.key] = i; });
  function stageNeedsWithdrawReason(fromStageKey) {
    if (!Object.prototype.hasOwnProperty.call(STAGE_RANK, fromStageKey)) return false;
    return STAGE_RANK[fromStageKey] >= STAGE_RANK.submitted;
  }
  var WITHDRAW_REASONS = [
    { value: 'gp_withdrew', label: 'GP withdrew after submission' },
    { value: 'practice_passed', label: 'Practice passed on the candidate' },
    { value: 'unresponsive', label: 'Candidate went unresponsive' },
    { value: 'other', label: 'Other' }
  ];
  function withdrawReasonModalHtml() {
    var opts = '<option value="">— No reason (skip) —</option>' + WITHDRAW_REASONS.map(function (r) {
      return '<option value="' + r.value + '">' + A.esc(r.label) + '</option>';
    }).join('');
    return '<div class="ats-modal-wrap" id="atsWithdrawModal">' +
      '<div class="ats-modal" style="max-width:420px">' +
        '<div class="ats-modal-head"><h3>Why is this application not proceeding?</h3><button class="ats-drawer-close" id="atsWithdrawClose">×</button></div>' +
        '<div class="ats-modal-body">' +
          '<label>Reason (optional — helps track patterns)</label>' +
          '<select id="atsWithdrawReasonSelect">' + opts + '</select>' +
        '</div>' +
        '<div class="ats-modal-foot">' +
          '<button class="ats-btn ats-btn-ghost" id="atsWithdrawCancel">Cancel</button>' +
          '<button class="ats-btn ats-btn-primary" id="atsWithdrawSave">Move to Not Proceeding</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  // onProceed(reason) fires only on "Move to Not Proceeding" (reason may be
  // '' when skipped); Cancel/close abandons the move entirely — the caller
  // never PATCHes in that case.
  function openWithdrawReasonPrompt(onProceed) {
    A.setOverlay(withdrawReasonModalHtml());
    function close() { A.setOverlay(''); }
    on('atsWithdrawClose', 'click', close);
    on('atsWithdrawCancel', 'click', close);
    on('atsWithdrawSave', 'click', function () {
      var reason = val('atsWithdrawReasonSelect') || '';
      close();
      onProceed(reason);
    });
  }

  // PATCH the application's stage, then move the card in the board + update counts.
  function moveCard(id, stage) {
    var found = findCard(id);
    if (!found) return;
    if (found.col.key === stage) return; // already there
    var name = found.card.name || 'Candidate';
    if (stage === 'not_proceeding' && stageNeedsWithdrawReason(found.col.key)) {
      openWithdrawReasonPrompt(function (reason) { moveCardCommit(id, stage, name, reason); });
      return;
    }
    moveCardCommit(id, stage, name, null);
  }

  function moveCardCommit(id, stage, name, reason) {
    var body = { stage: stage };
    if (reason) body.reason = reason;
    if (stage === 'hired') {
      var redirectOthers = confirmRedirectOthers(id);
      if (redirectOthers !== undefined) body.redirect_others = redirectOthers;
    }
    A.api('/api/ats/application?id=' + encodeURIComponent(id), { method: 'PATCH', body: body }).then(function (d) {
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not update stage'); return; }
      applyStageMove(id, stage);
      renderBoard();
      renderBoardMeta();
      A.toast(name + ' → ' + stageLabel(stage) + redirectedSuffix(d));
    });
  }

  /* ============================================================
   * CANDIDATE DRAWER (+ embedded interview modal)
   * ========================================================== */
  function openCandidateDrawer(id) {
    var found = findCard(id);
    if (!found) return;
    var c = found.card;
    var curStage = c.ats_stage || found.col.key;
    var job = (boardData && boardData.job) || {};
    drawerCardId = id;

    var stageOptions = ALL_STAGES.map(function (s) {
      return '<option value="' + s.key + '"' + (s.key === curStage ? ' selected' : '') + '>' + A.esc(s.label) + '</option>';
    }).join('');

    var html =
      '<div class="ats-scrim" id="atsJobScrim"></div>' +
      '<aside class="ats-drawer" id="atsJobDrawer">' +
        '<div class="ats-drawer-head">' +
          '<div class="ats-avatar" style="width:38px;height:38px;font-size:13px;background:' + A.avatarColor(c.name) + '">' + A.esc(A.initials(c.name)) + '</div>' +
          '<div><div class="dh-name">' + A.esc(c.name || '—') + '</div>' +
            '<div class="dh-sub">' + A.countryLabel(c.country) + ' · ' + A.esc(c.email || '—') + '</div></div>' +
          '<button class="ats-drawer-close" id="atsJobDrawerClose">×</button>' +
        '</div>' +
        '<div class="ats-drawer-body">' +
          '<label>Applying for</label>' +
          '<div style="font-size:13.5px">' + A.esc(job.title || '—') + ' <span class="cc-sub">— ' + A.esc(job.practice_name || '') + '</span></div>' +
          '<label>Pipeline stage</label>' +
          '<select id="atsJobDrawerStage">' + stageOptions + '</select>' +
          '<button class="ats-btn ats-btn-primary" id="atsJobSchedBtn">📅 Book interview</button>' +
          // "Practice accepted" (Task 12) — hidden once the acceptance is
          // already recorded (revealed / client_approved / interview_ready),
          // mirroring ceo-ats-candidates.js's gating.
          (c.revealed === true || c.practice_submission_status === 'client_approved' || c.practice_submission_status === 'interview_ready'
            ? ''
            : '<button class="ats-btn ats-btn-primary" id="atsJobAcceptBtn" data-ats="accept-application" data-id="' + A.esc(String(id)) + '" style="background:#16a34a;border-color:#16a34a">✅ Practice accepted — reveal &amp; congratulate</button>') +
          '<label>Internal notes</label>' +
          '<textarea id="atsJobDrawerNotes" placeholder="Add a note about this candidate…">' + A.esc(c.ats_notes || '') + '</textarea>' +
        '</div>' +
        '<div class="ats-drawer-foot">' +
          '<button class="ats-btn ats-btn-ghost" id="atsJobDrawerCloseBtn" style="flex:1;justify-content:center">Close</button>' +
          '<button class="ats-btn ats-btn-primary" id="atsJobDrawerSave" style="flex:1;justify-content:center">Save</button>' +
        '</div>' +
      '</aside>';

    A.setOverlay(html);

    var scrim = el('atsJobScrim');
    var drawer = el('atsJobDrawer');
    requestAnimationFrame(function () { if (scrim) scrim.classList.add('open'); if (drawer) drawer.classList.add('open'); });

    if (scrim) scrim.addEventListener('click', closeDrawer);
    on('atsJobDrawerClose', 'click', closeDrawer);
    on('atsJobDrawerCloseBtn', 'click', closeDrawer);
    on('atsJobDrawerStage', 'change', onDrawerStageChange);
    on('atsJobDrawerSave', 'click', onDrawerSave);
    on('atsJobSchedBtn', 'click', openInterviewModal);
    on('atsJobAcceptBtn', 'click', onAcceptApplication);
  }

  function closeDrawer() {
    var scrim = el('atsJobScrim');
    var drawer = el('atsJobDrawer');
    if (scrim) scrim.classList.remove('open');
    if (drawer) drawer.classList.remove('open');
    drawerCardId = null;
    setTimeout(function () { A.setOverlay(''); }, 260);
  }

  function onDrawerStageChange() {
    var stage = val('atsJobDrawerStage');
    if (!drawerCardId || !stage) return;
    var found = findCard(drawerCardId);
    if (stage === 'not_proceeding' && found && stageNeedsWithdrawReason(found.col.key)) {
      var pendingCardId = drawerCardId;
      openWithdrawReasonPrompt(function (reason) { onDrawerStageChangeCommit(pendingCardId, stage, reason); });
      return;
    }
    onDrawerStageChangeCommit(drawerCardId, stage, null);
  }

  function onDrawerStageChangeCommit(drawerCardId, stage, reason) {
    var found = findCard(drawerCardId);
    var body = { stage: stage };
    if (reason) body.reason = reason;
    if (stage === 'hired' && (!found || found.col.key !== 'hired')) {
      var redirectOthers = confirmRedirectOthers(drawerCardId);
      if (redirectOthers !== undefined) body.redirect_others = redirectOthers;
    }
    A.api('/api/ats/application?id=' + encodeURIComponent(drawerCardId), { method: 'PATCH', body: body }).then(function (d) {
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not update stage'); return; }
      applyStageMove(drawerCardId, stage);
      renderBoard();
      renderBoardMeta();
      if (d && d.redirected) A.toast(d.redirected + ' GP(s) redirected');
      else {
        var dp = d && d.positions;
        if (dp && dp.full === false && dp.needed > 1) A.toast(dp.hired + ' of ' + dp.needed + ' hired, opening stays open');
      }
    });
  }

  function onDrawerSave() {
    if (!drawerCardId) return;
    var body = { stage: val('atsJobDrawerStage'), notes: val('atsJobDrawerNotes') };
    A.api('/api/ats/application?id=' + encodeURIComponent(drawerCardId), { method: 'PATCH', body: body }).then(function (d) {
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not save candidate'); return; }
      A.toast('Candidate saved');
      closeDrawer();
      if (currentBoardJobId) atsOpenJobBoard(currentBoardJobId);
    });
  }

  /* -------------------- practice accepted → reveal + congratulate -------------------- */
  function onAcceptApplication() {
    if (!drawerCardId) return;
    if (!window.confirm('This reveals the practice\'s real name/address to the GP, records an offer, and emails them to secure an interview. Continue?')) return;
    A.api('/api/ats/application/accept?id=' + encodeURIComponent(drawerCardId), { method: 'POST' }).then(function (d) {
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not record the practice\'s acceptance'); return; }
      A.toast(d.already ? 'Already accepted — nothing to change.' : 'Practice acceptance recorded — the GP has been notified.');
      closeDrawer();
      if (currentBoardJobId) atsOpenJobBoard(currentBoardJobId);
    }).catch(function () { A.toast('Could not record the practice\'s acceptance'); });
  }

  /* -------------------- book interview -------------------- */
  function openInterviewModal() {
    if (!drawerCardId) return;
    if (!window.confirm('Send this candidate\'s practice an availability request and start interview scheduling?')) return;
    A.api('/api/ats/interview/request', { method: 'POST', body: { application_id: drawerCardId } }).then(function (r) {
      if (r && r.ok) { A.toast(r.already ? 'An interview is already in progress for this application.' : 'Availability request sent to the practice. You\'ll be able to pick a time once they reply.'); }
      else { A.toast('Could not start interview scheduling. Please try again.'); }
    }).catch(function () { A.toast('Could not start interview scheduling. Please try again.'); });
  }

  /* ============================================================
   * ADD JOB MODAL
   * ========================================================== */
  function openAddJobModal() {
    A.api('/api/ats/practices').then(function (d) {
      var practices = (d && d.practices) || [];
      var practiceOptions = practices.map(function (p) {
        // Corporation options carry a "(Corporation)" hint when the payload marks them.
        var suffix = p.org_type === 'corporation' ? ' (Corporation)' : '';
        return '<option value="' + A.escAttr(p.id) + '">' + A.esc(p.name) + A.esc(suffix) + '</option>';
      }).join('') || '<option value="">No practices yet</option>';

      A.setOverlay(addJobModalHtml(practiceOptions));
      var modal = el('atsAddJobModal');
      if (modal) modal.classList.add('open');
      on('atsAddJobClose', 'click', closeAddJobModal);
      on('atsAddJobCancel', 'click', closeAddJobModal);
      on('atsAddJobCreate', 'click', submitAddJob);
      bindDpaSegment('atsNjDpaSeg', 'atsNjDpa');
    });
  }
  function closeAddJobModal() { A.setOverlay(''); }

  function req(label) { return '<span style="color:var(--ats-red)">*</span> ' + label; }

  // Full manual creation form — the SAME fields the practice fills on the
  // Facebook intake form, so the job lands as a pending row through the exact
  // same pipeline (approval + suburb-photo gate unchanged).
  function addJobModalHtml(practiceOptions) {
    return '<div class="ats-modal-wrap" id="atsAddJobModal">' +
      '<div class="ats-modal">' +
        '<div class="ats-modal-head"><h3>Add a job</h3><button class="ats-drawer-close" id="atsAddJobClose">×</button></div>' +
        '<div class="ats-modal-body">' +
          '<div id="atsNjError" style="display:none;background:rgba(220,60,60,0.12);border:1px solid var(--ats-red);color:var(--ats-red);border-radius:8px;padding:9px 11px;font-size:12.5px;margin-bottom:6px"></div>' +
          '<label>Practice</label>' +
          '<select id="atsNjPractice">' + practiceOptions + '</select>' +
          formSection('Role',
            '<label>' + req('Job title') + '</label>' +
            '<input type="text" id="atsNjTitle" placeholder="e.g. General Practitioner — VR" />' +
            '<label>About the role (shown to doctors)</label>' +
            '<textarea id="atsNjSummary" rows="3" placeholder="A short, friendly description of the practice and the role…"></textarea>'
          ) +
          formSection('Location',
            '<div class="ats-form-row">' +
              '<div><label>' + req('Suburb') + '</label><input type="text" id="atsNjSuburb" placeholder="Rangeville" /></div>' +
              '<div><label>' + req('Nearest city') + '</label><input type="text" id="atsNjNearestCity" placeholder="Toowoomba" /></div>' +
            '</div>' +
            '<div class="ats-form-row">' +
              '<div><label>' + req('State') + '</label><select id="atsNjState">' + valueOptions(AU_STATES.map(function (s) { return { value: s, label: s }; }), 'QLD') + '</select></div>' +
              '<div><label>General location</label><input type="text" id="atsNjGeneralLoc" placeholder="Darling Downs" /></div>' +
            '</div>' +
            '<label>' + req('Address') + '</label>' +
            '<input type="text" id="atsNjAddress" placeholder="12 Main Street, Rangeville" />'
          ) +
          formSection('Billing &amp; terms',
            '<label>' + req('Billing style') + '</label>' +
            '<select id="atsNjBilling">' + valueOptions(BILLING_STYLE_OPTS, 'mixed') + '</select>' +
            '<label style="margin-top:12px">' + req('DPA (District of Priority Area)') + '</label>' +
            dpaSegment('atsNjDpa', 'atsNjDpaSeg', null) +
            '<div class="ats-form-row" style="margin-top:12px">' +
              '<div><label>' + req('Percentage split') + '</label><input type="text" id="atsNjPctSplit" placeholder="65%" /></div>' +
              '<div><label>Estimated earnings</label><input type="text" id="atsNjEarnings" placeholder="$350k+ estimated" /></div>' +
            '</div>' +
            '<div class="ats-form-row">' +
              '<div><label>Modified Monash (MMM)</label><select id="atsNjMmm">' + valueOptions(MMM_OPTS, '') + '</select></div>' +
              '<div></div>' +
            '</div>' +
            '<label>Incentives</label>' +
            '<textarea id="atsNjIncentives" rows="2" placeholder="Relocation bonus, sign-on bonus…"></textarea>'
          ) +
          formSection('Practice profile',
            '<div class="ats-form-row">' +
              '<div><label>Ownership</label><input type="text" id="atsNjOwnership" placeholder="Privately owned" /></div>' +
              '<div><label>Number of GPs</label><input type="text" id="atsNjGpCount" placeholder="6" /></div>' +
            '</div>' +
            '<div class="ats-form-row">' +
              '<div><label>Years operating</label><input type="text" id="atsNjYears" placeholder="12" /></div>' +
              '<div><label>Nursing on site</label>' + boolSelect('atsNjNursing', null) + '</div>' +
            '</div>' +
            '<label>Visa sponsorship offered</label>' + boolSelect('atsNjVisa', null)
          ) +
          formSection('Introduction',
            '<label>Introduction text</label>' +
            '<textarea id="atsNjIntroText" rows="3" placeholder="Welcome to our practice…"></textarea>' +
            '<label>Intro video URL</label>' +
            '<input type="text" id="atsNjIntroVideo" placeholder="https://…" />'
          ) +
        '</div>' +
        '<div class="ats-modal-foot">' +
          '<button class="ats-btn ats-btn-ghost" id="atsAddJobCancel">Cancel</button>' +
          '<button class="ats-btn ats-btn-primary" id="atsAddJobCreate">Create job</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function njError(msg) {
    var e = el('atsNjError');
    if (e) { e.textContent = msg; e.style.display = msg ? 'block' : 'none'; }
  }

  function submitAddJob() {
    njError('');
    var title = (val('atsNjTitle') || '').trim();
    var practiceId = val('atsNjPractice');
    var billingStyle = val('atsNjBilling');
    var dpa = boolFromSel(val('atsNjDpa'));
    var pctSplit = (val('atsNjPctSplit') || '').trim();
    var suburb = (val('atsNjSuburb') || '').trim();
    var nearestCity = (val('atsNjNearestCity') || '').trim();
    var state = val('atsNjState');
    var address = (val('atsNjAddress') || '').trim();

    // Client-side required checks, in plain language, before the round-trip.
    if (!practiceId) { njError('Choose a practice for this job.'); return; }
    if (!title) { njError('Enter a job title.'); return; }
    if (!billingStyle) { njError('Choose a billing style.'); return; }
    if (dpa === null) { njError('Choose whether this job is DPA eligible.'); return; }
    if (!pctSplit) { njError('Enter the percentage split.'); return; }
    if (!suburb) { njError('Enter the suburb.'); return; }
    if (!nearestCity) { njError('Enter the nearest city.'); return; }
    if (!state) { njError('Choose a state.'); return; }
    if (!address) { njError('Enter the practice address.'); return; }

    var intake = {
      role_title: title,
      role_summary: (val('atsNjSummary') || '').trim(),
      billing_style: billingStyle,
      dpa: dpa,
      percentage_split: pctSplit,
      earnings_text: (val('atsNjEarnings') || '').trim(),
      mmm: val('atsNjMmm') || '',
      incentives: (val('atsNjIncentives') || '').trim(),
      suburb: suburb,
      nearest_city: nearestCity,
      state: state,
      address: address,
      general_location: (val('atsNjGeneralLoc') || '').trim(),
      ownership: (val('atsNjOwnership') || '').trim(),
      gp_count: (val('atsNjGpCount') || '').trim(),
      years_operating: (val('atsNjYears') || '').trim(),
      nursing_on_site: boolFromSel(val('atsNjNursing')),
      visa_sponsorship: boolFromSel(val('atsNjVisa')),
      intro_text: (val('atsNjIntroText') || '').trim(),
      intro_video_url: (val('atsNjIntroVideo') || '').trim()
    };

    // Guard against a double-submit while the create round-trips.
    var createBtn = el('atsAddJobCreate');
    if (createBtn) { createBtn.disabled = true; createBtn.textContent = 'Creating…'; }
    function reenableCreate() { if (createBtn) { createBtn.disabled = false; createBtn.textContent = 'Create job'; } }
    A.api('/api/ats/jobs', { method: 'POST', body: { practice_id: practiceId, intake: intake } }).then(function (d) {
      if (!d || !d.ok) { reenableCreate(); njError((d && d.message) || 'Could not create job.'); return; }
      closeAddJobModal();
      A.toast('Job created as PENDING — add a suburb header photo and approve it (Review & approve) to make it live to doctors.');
      loadJobsTab();
    }).catch(function () { reenableCreate(); njError('Could not create job.'); });
  }

  /* ============================================================
   * JOB SETTINGS MODAL
   * ========================================================== */
  // Opens the job settings modal. When the job is `approval_status:'pending'`
  // (auto-created the moment a practice signs, no candidates yet), this
  // doubles as the Task 4 combined review screen: the same editor gains an
  // AI write-up block, "preview as a GP would see it" links and a hand-off
  // into the existing suburb-photo + approve/reject modal.
  function openJobSettings() {
    if (!currentBoardJobId) return;
    A.api('/api/ats/job?id=' + encodeURIComponent(currentBoardJobId)).then(function (d) {
      if (!d || !d.ok || !d.editor) { A.toast((d && d.message) || 'Could not load job settings'); return; }
      // Baseline for the diff-only PATCH is the intake-parity editor payload
      // (billing_style/dpa/… vocabulary), NOT the display card.
      settingsOriginal = d.editor;
      settingsPublicId = (d.job && d.job.public_id) || '';
      A.setOverlay(jobSettingsModalHtml(d.editor));
      var modal = el('atsJobSettingsModal');
      if (modal) modal.classList.add('open');
      on('atsJsClose', 'click', closeJobSettings);
      on('atsJsCancel', 'click', closeJobSettings);
      on('atsJsSave', 'click', submitJobSettings);
      bindDpaSegment('atsJsDpaSeg', 'atsJsDpa');
      if (d.editor.approval_status === 'pending') bindReviewExtras();
    });
  }

  // A plain click on a pending job card, or its "Review & approve" button,
  // both land here (Task 4 — combined review screen). Just sets the same
  // module state atsOpenJobBoard would have, so openJobSettings() can be
  // reused unmodified as the review hub.
  function openJobReview(jobId) {
    if (!jobId) return;
    currentBoardJobId = jobId;
    openJobSettings();
  }
  function closeJobSettings() { A.setOverlay(''); settingsPublicId = ''; }

  function jsError(msg) {
    var e = el('atsJsError');
    if (e) { e.textContent = msg; e.style.display = msg ? 'block' : 'none'; }
  }

  // Sectioned intake-parity editor. `e` is the /api/ats/job editor payload.
  function jobSettingsModalHtml(e) {
    var pending = e.approval_status === 'pending';
    return '<div class="ats-modal-wrap" id="atsJobSettingsModal">' +
      '<div class="ats-modal">' +
        '<div class="ats-modal-head"><h3>' + (pending ? 'Review &amp; approve' : 'Job settings') + '</h3><button class="ats-drawer-close" id="atsJsClose">×</button></div>' +
        '<div class="ats-modal-body">' +
          (pending
            ? '<div style="background:rgba(224,168,60,0.12);border:1px solid rgba(224,168,60,0.35);color:#e0a83c;border-radius:8px;padding:8px 11px;font-size:12px;margin-bottom:4px">This job was auto-created when the practice signed. Review every field below, refine the AI write-up, then approve when a suburb photo is added.</div>'
            : '') +
          '<div style="background:rgba(120,120,140,0.1);border-radius:8px;padding:9px 11px;margin-bottom:4px">' +
            '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--ats-dim)">Doctor-facing title (masked)</div>' +
            '<div style="font-weight:600;font-size:13.5px" id="atsJsMaskedPreview">' + A.esc(e.masked_title || '—') + '</div>' +
            '<div style="font-size:11.5px;color:var(--ats-dim);margin-top:2px">Location, billing and DPA changes update this automatically on save.</div>' +
          '</div>' +
          '<div id="atsJsError" style="display:none;background:rgba(220,60,60,0.12);border:1px solid var(--ats-red);color:var(--ats-red);border-radius:8px;padding:9px 11px;font-size:12.5px;margin:6px 0"></div>' +
          formSection('Role',
            '<label>Job title</label>' +
            '<input type="text" id="atsJsTitle" value="' + A.escAttr(e.title || '') + '" />' +
            '<div class="ats-form-row">' +
              '<div><label>Type</label><select id="atsJsType">' + plainOptionsMaybeBlank(JOB_TYPES, e.employment_type) + '</select></div>' +
              '<div><label>Status</label><select id="atsJsStatus">' + valueOptions(JOB_STATUSES, e.job_status) + '</select></div>' +
            '</div>' +
            '<label>About the role (shown to doctors)</label>' +
            '<textarea id="atsJsSummary" rows="3" placeholder="A short, friendly description of the practice and the role…">' + A.esc(e.role_summary || '') + '</textarea>'
          ) +
          formSection('Location',
            '<div class="ats-form-row">' +
              '<div><label>Suburb</label><input type="text" id="atsJsSuburb" value="' + A.escAttr(e.suburb || '') + '" /></div>' +
              '<div><label>Nearest city</label><input type="text" id="atsJsNearestCity" value="' + A.escAttr(e.nearest_city || '') + '" /></div>' +
            '</div>' +
            '<div class="ats-form-row">' +
              '<div><label>City</label><input type="text" id="atsJsCity" value="' + A.escAttr(e.city || '') + '" /></div>' +
              '<div><label>State</label><select id="atsJsState">' + plainOptions(optionsWithCurrent(AU_STATES, e.state), e.state) + '</select></div>' +
            '</div>' +
            '<label>Address</label>' +
            '<input type="text" id="atsJsAddress" value="' + A.escAttr(e.address || '') + '" />' +
            '<label>General location</label>' +
            '<input type="text" id="atsJsGeneralLoc" value="' + A.escAttr(e.general_location || '') + '" />'
          ) +
          formSection('Billing &amp; terms',
            '<label>Billing style</label>' +
            '<select id="atsJsBilling">' + valueOptionsMaybeBlank(BILLING_STYLE_OPTS, e.billing_style) + '</select>' +
            '<label style="margin-top:12px">DPA (District of Priority Area)</label>' +
            dpaSegment('atsJsDpa', 'atsJsDpaSeg', e.dpa) +
            '<div class="ats-form-row" style="margin-top:12px">' +
              '<div><label>Percentage split</label><input type="text" id="atsJsPctSplit" value="' + A.escAttr(e.percentage_split || '') + '" /></div>' +
              '<div><label>Estimated earnings</label><input type="text" id="atsJsEarnings" value="' + A.escAttr(e.earnings_text || '') + '" /></div>' +
            '</div>' +
            '<div class="ats-form-row">' +
              '<div><label>Modified Monash (MMM)</label><select id="atsJsMmm">' + valueOptions(MMM_OPTS, e.mmm) + '</select></div>' +
              '<div></div>' +
            '</div>' +
            '<label>Incentives</label>' +
            '<textarea id="atsJsIncentives" rows="2" placeholder="Relocation bonus, sign-on bonus…">' + A.esc(e.incentives || '') + '</textarea>'
          ) +
          formSection('Practice profile',
            '<div class="ats-form-row">' +
              '<div><label>Ownership</label><input type="text" id="atsJsOwnership" value="' + A.escAttr(e.ownership || '') + '" /></div>' +
              '<div><label>Number of GPs</label><input type="text" id="atsJsGpCount" value="' + A.escAttr(e.gp_count || '') + '" /></div>' +
            '</div>' +
            '<div class="ats-form-row">' +
              '<div><label>Years operating</label><input type="text" id="atsJsYears" value="' + A.escAttr(e.years_operating || '') + '" /></div>' +
              '<div><label>Nursing on site</label>' + boolSelect('atsJsNursing', e.nursing_on_site) + '</div>' +
            '</div>' +
            '<label>Visa sponsorship offered</label>' + boolSelect('atsJsVisa', e.visa_sponsorship)
          ) +
          formSection('Introduction',
            '<label>Introduction text</label>' +
            '<textarea id="atsJsIntroText" rows="3" placeholder="Welcome to our practice…">' + A.esc(e.intro_text || '') + '</textarea>' +
            '<label>Intro video URL</label>' +
            '<input type="text" id="atsJsIntroVideo" value="' + A.escAttr(e.intro_video_url || '') + '" />'
          ) +
          (pending ? reviewExtrasHtml(e) : '') +
        '</div>' +
        '<div class="ats-modal-foot">' +
          '<button class="ats-btn ats-btn-ghost" id="atsJsCancel">Cancel</button>' +
          '<button class="ats-btn ats-btn-primary" id="atsJsSave">Save settings</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* ============================================================
   * REVIEW SCREEN EXTRAS (Task 4 — appended to the settings modal only when
   * the job is `approval_status:'pending'`). Three pieces: the AI write-up
   * (editable + regenerable, with a toggle to see the practice's own words),
   * two "preview as a GP would see it" links, and a hand-off into the
   * existing suburb-photo + approve/reject modal (reused, never duplicated).
   * ========================================================== */
  function reviewExtrasHtml(e) {
    return aiWriteupSectionHtml(e) + previewLinksSectionHtml() + approvalHandoffSectionHtml(e);
  }

  function aiHighlightsListHtml(highlights) {
    var list = Array.isArray(highlights) ? highlights : [];
    if (!list.length) return '<div style="font-size:12px;color:var(--ats-dim)">No highlights yet — regenerate to draft some.</div>';
    return '<ul style="margin:8px 0 0;padding-left:18px">' + list.map(function (h) {
      return '<li style="font-size:12.5px;color:var(--ats-dim);margin-bottom:3px">' + A.esc(h) + '</li>';
    }).join('') + '</ul>';
  }

  // The "about" textarea is seeded from editor.ai_about; highlights render as
  // a plain list (edited by regenerating, not by hand — they're short trust
  // bullets, not prose). Regenerate re-POSTs the write-up endpoint and swaps
  // both in place. The raw practice-submitted text stays one click away.
  function aiWriteupSectionHtml(e) {
    var rawText = e.intro_text || e.role_summary || '';
    return formSection('Listing write-up ✦ AI-drafted',
      '<div style="font-size:11.5px;color:var(--ats-dim);margin-bottom:8px">Written by AI from: <b>practice form</b> · <b>website</b> · <b>area</b></div>' +
      '<label>About the practice &amp; area</label>' +
      '<textarea id="atsJsAiAbout" rows="6" placeholder="Not generated yet — hit Regenerate.">' + A.esc(e.ai_about || '') + '</textarea>' +
      '<label style="margin-top:10px">Why GPs choose it</label>' +
      '<div id="atsJsAiHighlights">' + aiHighlightsListHtml(e.ai_highlights) + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">' +
        '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" id="atsJsRegenBtn" data-ats-regenerate-writeup>✦ Regenerate</button>' +
        '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" id="atsJsShowOriginal" data-ats-show-original>Show what the practice wrote</button>' +
      '</div>' +
      '<div id="atsJsAiStatus" style="font-size:11.5px;color:var(--ats-dim);margin-top:6px;min-height:14px"></div>' +
      '<div id="atsJsAiOriginal" style="display:none;margin-top:4px;padding:9px 11px;border:1px dashed rgba(120,120,140,0.3);border-radius:8px;font-size:12px;color:var(--ats-dim)">' +
        (rawText ? A.esc(rawText) : '<i>The practice did not submit an introduction.</i>') +
      '</div>'
    );
  }

  // Opens the app + website listing pages in the admin-only preview mode
  // (Task 5's ?preview=1 — only ever bypasses is_active/approval gating for
  // a request that also carries a valid admin/ATS session). settingsPublicId
  // is the job's provider:provider_role_id id, captured when the modal loaded.
  function previewLinksSectionHtml() {
    if (!settingsPublicId) return '';
    var enc = encodeURIComponent(settingsPublicId);
    var appUrl = '/pages/job.html?id=' + enc + '&preview=1';
    var siteUrl = '/jobs/view?id=' + enc + '&preview=1';
    return formSection('Preview',
      '<div style="font-size:11.5px;color:var(--ats-dim);margin-bottom:8px">See exactly how a GP would see this listing before it goes live — identity stays masked.</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<a class="ats-btn ats-btn-ghost ats-btn-sm" href="' + A.escAttr(appUrl) + '" target="_blank" rel="noopener" data-ats-preview-app>📱 Preview in app</a>' +
        '<a class="ats-btn ats-btn-ghost ats-btn-sm" href="' + A.escAttr(siteUrl) + '" target="_blank" rel="noopener" data-ats-preview-site>🌐 Preview on website</a>' +
      '</div>'
    );
  }

  // The suburb photo + approve/reject controls are NOT rebuilt here — this
  // just hands off into the existing openApprovalModal(jobId), which already
  // owns the upload/reuse-picker/approve/reject logic end to end.
  function approvalHandoffSectionHtml(e) {
    var photoLine = e.header_image_url
      ? 'Suburb header photo added.'
      : 'No suburb header photo yet — required before this can go live.';
    return formSection('Suburb photo & approval',
      '<div style="font-size:12.5px;color:var(--ats-dim);margin-bottom:10px">' + A.esc(photoLine) + '</div>' +
      '<button type="button" class="ats-btn ats-btn-primary ats-btn-sm" id="atsJsOpenApproval" data-ats-open-approval>Review photo &amp; approve / reject</button>'
    );
  }

  // Wires the review-only controls above. Only called when the modal
  // actually rendered them (approval_status === 'pending').
  function bindReviewExtras() {
    var jobId = currentBoardJobId;
    on('atsJsRegenBtn', 'click', function () { regenerateWriteup(jobId); });
    on('atsJsShowOriginal', 'click', function () {
      var box = el('atsJsAiOriginal');
      if (box) box.style.display = (box.style.display === 'none') ? 'block' : 'none';
    });
    on('atsJsOpenApproval', 'click', function () { openApprovalModal(jobId); });
  }

  // POSTs /api/ats/job/ai-writeup and re-renders just the about textarea +
  // highlights list in place (not the whole modal, so unsaved edits to other
  // fields survive a regenerate). {ok:false, reason:'ai_unavailable'} is the
  // expected local-dev shape (no ANTHROPIC_API_KEY) — shown as a small note,
  // never a hard error.
  function regenerateWriteup(jobId) {
    var btn = el('atsJsRegenBtn');
    var status = el('atsJsAiStatus');
    if (btn) { btn.disabled = true; btn.textContent = 'Regenerating…'; }
    if (status) status.textContent = '';
    A.api('/api/ats/job/ai-writeup?id=' + encodeURIComponent(jobId), { method: 'POST' }).then(function (d) {
      if (btn) { btn.disabled = false; btn.textContent = '✦ Regenerate'; }
      if (!d || !d.ok) {
        var msg = (d && d.reason === 'ai_unavailable')
          ? "AI isn't configured in this environment"
          : ((d && d.message) || 'Could not regenerate write-up');
        if (status) status.textContent = msg;
        return;
      }
      var w = d.writeup || {};
      if (settingsOriginal) {
        settingsOriginal.ai_about = w.about || '';
        settingsOriginal.ai_highlights = Array.isArray(w.highlights) ? w.highlights : [];
      }
      var aboutEl = el('atsJsAiAbout');
      if (aboutEl) aboutEl.value = w.about || '';
      var hlEl = el('atsJsAiHighlights');
      if (hlEl) hlEl.innerHTML = aiHighlightsListHtml(w.highlights);
      if (status) status.textContent = 'Write-up regenerated.';
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = '✦ Regenerate'; }
      if (status) status.textContent = 'Could not regenerate write-up';
    });
  }

  function submitJobSettings() {
    if (!currentBoardJobId || !settingsOriginal) return;
    jsError('');
    var o = settingsOriginal;
    // Captured before settingsOriginal is reassigned below — approval_status
    // never changes via this form, so this reliably says "we're mid-review".
    var wasPendingReview = o.approval_status === 'pending';
    var body = {};

    // Diff-only string/enum fields: [bodyKey, elId, baselineKey, trim].
    var strFields = [
      ['title', 'atsJsTitle', 'title', true],
      ['type', 'atsJsType', 'employment_type', false],
      ['job_status', 'atsJsStatus', 'job_status', false],
      ['role_summary', 'atsJsSummary', 'role_summary', true],
      ['suburb', 'atsJsSuburb', 'suburb', true],
      ['nearest_city', 'atsJsNearestCity', 'nearest_city', true],
      ['city', 'atsJsCity', 'city', true],
      ['state', 'atsJsState', 'state', false],
      ['address', 'atsJsAddress', 'address', true],
      ['general_location', 'atsJsGeneralLoc', 'general_location', true],
      ['billing_style', 'atsJsBilling', 'billing_style', false],
      ['percentage_split', 'atsJsPctSplit', 'percentage_split', true],
      ['earnings_text', 'atsJsEarnings', 'earnings_text', true],
      ['mmm', 'atsJsMmm', 'mmm', false],
      ['incentives', 'atsJsIncentives', 'incentives', true],
      ['ownership', 'atsJsOwnership', 'ownership', true],
      ['gp_count', 'atsJsGpCount', 'gp_count', true],
      ['years_operating', 'atsJsYears', 'years_operating', true],
      ['intro_text', 'atsJsIntroText', 'intro_text', true],
      ['intro_video_url', 'atsJsIntroVideo', 'intro_video_url', true]
    ];
    strFields.forEach(function (f) {
      var v = val(f[1]) || '';
      if (f[3]) v = v.trim();
      var orig = o[f[2]] == null ? '' : String(o[f[2]]);
      if (v !== orig) body[f[0]] = v;
    });

    // Diff-only booleans (true|false|null). DPA is required — never send a null
    // that would strip the owner's control; only send an explicit yes/no change.
    var dpaCur = boolFromSel(val('atsJsDpa'));
    var dpaOrig = typeof o.dpa === 'boolean' ? o.dpa : null;
    if (dpaCur !== dpaOrig && dpaCur !== null) body.dpa = dpaCur;

    var visaCur = boolFromSel(val('atsJsVisa'));
    var visaOrig = typeof o.visa_sponsorship === 'boolean' ? o.visa_sponsorship : null;
    if (visaCur !== visaOrig) body.visa_sponsorship = visaCur;

    var nurseCur = boolFromSel(val('atsJsNursing'));
    var nurseOrig = typeof o.nursing_on_site === 'boolean' ? o.nursing_on_site : null;
    if (nurseCur !== nurseOrig) body.nursing_on_site = nurseCur;

    if ('title' in body && !body.title) { jsError('Job title cannot be empty.'); return; }
    if (!Object.keys(body).length) { closeJobSettings(); A.toast('No changes to save'); return; }

    // AI Matching (Task 6): closing/filling a job from here is the same
    // redirect trigger as marking a candidate Hired — same confirm copy,
    // same opt-in flag. `o.job_status` is the job's status BEFORE this save,
    // so this only fires on a REAL flip into filled/closed.
    if ((body.job_status === 'filled' || body.job_status === 'closed') && o.job_status !== body.job_status) {
      var redirectOthers = confirmRedirectOthers();
      if (redirectOthers !== undefined) body.redirect_others = redirectOthers;
    }

    // Guard against a double-submit while the PATCH round-trips.
    var saveBtn = el('atsJsSave');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    function reenableSave() { if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save settings'; } }
    A.api('/api/ats/job?id=' + encodeURIComponent(currentBoardJobId), { method: 'PATCH', body: body }).then(function (d) {
      if (!d || !d.ok) {
        // 400s name the offending field — surface it inline, not just a toast.
        reenableSave();
        jsError((d && d.message) || 'Could not save job settings');
        return;
      }
      // Modal is destroyed right after; the toast carries the new masked title.
      var newMasked = (d.editor && d.editor.masked_title) || '';
      settingsOriginal = d.editor || settingsOriginal;
      closeJobSettings();
      A.toast((newMasked ? 'Saved · ' + newMasked : 'Job settings saved') + redirectedSuffix(d));
      // A pending job (Task 4 combined review) has no candidates yet — saving
      // refreshes the jobs list instead of opening the empty pipeline board.
      if (wasPendingReview) { fetchAndRenderJobList(); } else { atsOpenJobBoard(currentBoardJobId); }
    }).catch(function () { reenableSave(); jsError('Could not save job settings'); });
  }

  /* ============================================================
   * REVIEW & APPROVE MODAL (Task 9 — practice-client pipeline)
   * Pending jobs (auto-created when a practice signs its agreement) need a
   * mandatory suburb header photo before they can go live. This modal lets an
   * admin upload a fresh photo, reuse one already used for another job in the
   * same suburb, then approve (server re-checks the photo requirement) or
   * reject the job.
   * ========================================================== */
  function openApprovalModal(jobId) {
    Promise.all([
      A.api('/api/ats/job?id=' + encodeURIComponent(jobId)),
      A.api('/api/ats/suburb-images')
    ]).then(function (results) {
      var jobResp = results[0];
      var imgResp = results[1];
      if (!jobResp || !jobResp.ok || !jobResp.job) { A.toast((jobResp && jobResp.message) || 'Could not load job'); return; }
      approvalJobId = jobId;
      approvalJob = jobResp.job;
      approvalImages = (imgResp && imgResp.ok && imgResp.images) || [];
      A.setOverlay(approvalModalHtml());
      var modal = el('atsApprovalModal');
      if (modal) modal.classList.add('open');
      bindApprovalModal();
    });
  }

  function bindApprovalModal() {
    on('atsApClose', 'click', closeApprovalModal);
    on('atsApApprove', 'click', function () { submitApprovalAction('approve'); });
    on('atsApReject', 'click', function () { submitApprovalAction('reject'); });
    var fileInput = el('atsApFileInput');
    if (fileInput) fileInput.addEventListener('change', onApprovalFileChange);
    var picker = el('atsApSuburbPicker');
    if (picker) picker.addEventListener('click', onApprovalPickerClick);
  }

  function closeApprovalModal() {
    A.setOverlay('');
    approvalJobId = null;
    approvalJob = null;
    approvalImages = [];
  }

  function approvalModalHtml() {
    var job = approvalJob || {};
    var suburbLabel = job.suburb || job.city || '—';
    var previewHtml = job.header_image_url
      ? '<img src="' + A.escAttr(job.header_image_url) + '" alt="Suburb header photo" style="width:100%;max-height:180px;object-fit:cover;border-radius:8px;display:block" />'
      : '<div class="ats-empty" style="padding:24px">No photo yet</div>';
    var pickerHtml = approvalImages.length
      ? '<div id="atsApSuburbPicker" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">' +
          approvalImages.map(function (img) {
            return '<img src="' + A.escAttr(img.url) + '" data-ats-reuse-url="' + A.escAttr(img.url) + '" title="' + A.escAttr(img.suburb || 'Reuse this photo') + '" ' +
              'style="width:64px;height:64px;object-fit:cover;border-radius:6px;cursor:pointer;border:2px solid transparent" />';
          }).join('') +
        '</div>'
      : '<div class="ats-empty" style="padding:12px">No suburb photos uploaded yet.</div>';

    return '<div class="ats-modal-wrap" id="atsApprovalModal">' +
      '<div class="ats-modal">' +
        '<div class="ats-modal-head"><h3>Review &amp; approve</h3><button class="ats-drawer-close" id="atsApClose">×</button></div>' +
        '<div class="ats-modal-body">' +
          '<label>' + A.esc(job.masked_title || job.title || 'Job') + '</label>' +
          '<div style="font-size:13px;color:var(--ats-dim);margin-bottom:8px">' + A.esc(job.practice_name || '—') + ' · ' + A.esc(suburbLabel) + '</div>' +
          '<label>Suburb header photo (required)</label>' +
          '<div id="atsApPreview">' + previewHtml + '</div>' +
          '<label for="atsApFileInput" class="ats-btn ats-btn-ghost" style="margin-top:8px;display:inline-block;cursor:pointer">Upload photo</label>' +
          '<input type="file" id="atsApFileInput" accept="image/png,image/jpeg,image/webp" style="display:none" />' +
          '<label style="margin-top:14px">Reuse a photo already used for a suburb</label>' +
          pickerHtml +
          '<div id="atsApStatus" style="min-height:18px;font-size:12.5px;color:var(--ats-dim);margin-top:6px"></div>' +
        '</div>' +
        '<div class="ats-modal-foot">' +
          '<button class="ats-btn ats-btn-ghost" id="atsApReject">Reject</button>' +
          '<button class="ats-btn ats-btn-primary" id="atsApApprove"' + (job.header_image_url ? '' : ' disabled') + '>Approve</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // Re-render the modal in place after an upload/reuse action changes
  // approvalJob.header_image_url, so the preview + Approve button state stay
  // in sync with the (authoritative) server response.
  function refreshApprovalModal() {
    if (!approvalJobId) return;
    A.setOverlay(approvalModalHtml());
    var modal = el('atsApprovalModal');
    if (modal) modal.classList.add('open');
    bindApprovalModal();
  }

  function onApprovalFileChange(e) {
    var file = e.target && e.target.files && e.target.files[0];
    if (!file || !approvalJobId) return;
    var status = el('atsApStatus');
    if (status) status.textContent = 'Uploading…';
    var reader = new FileReader();
    reader.onload = function () {
      A.api('/api/ats/job/header-image?id=' + encodeURIComponent(approvalJobId), { method: 'POST', body: { file_data: reader.result, file_name: file.name } }).then(function (d) {
        if (!d || !d.ok) { A.toast((d && d.message) || 'Upload failed'); if (el('atsApStatus')) el('atsApStatus').textContent = ''; return; }
        approvalJob.header_image_url = d.url;
        A.toast('Photo uploaded');
        refreshApprovalModal();
      });
    };
    reader.readAsDataURL(file);
  }

  function onApprovalPickerClick(e) {
    var img = e.target.closest ? e.target.closest('[data-ats-reuse-url]') : null;
    if (!img || !approvalJobId) return;
    var reuseUrl = img.getAttribute('data-ats-reuse-url');
    var status = el('atsApStatus');
    if (status) status.textContent = 'Applying…';
    A.api('/api/ats/job/header-image?id=' + encodeURIComponent(approvalJobId), { method: 'POST', body: { reuse_url: reuseUrl } }).then(function (d) {
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not apply photo'); if (el('atsApStatus')) el('atsApStatus').textContent = ''; return; }
      approvalJob.header_image_url = d.url;
      A.toast('Photo applied');
      refreshApprovalModal();
    });
  }

  function submitApprovalAction(action) {
    if (!approvalJobId) return;
    if (action === 'reject' && !window.confirm('Reject this job? It will not be shown to GPs.')) return;
    A.api('/api/ats/job/approve?id=' + encodeURIComponent(approvalJobId), { method: 'POST', body: { action: action } }).then(function (d) {
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not update job'); return; }
      A.toast(action === 'approve' ? 'Job approved — now visible to GPs' : 'Job rejected');
      closeApprovalModal();
      fetchAndRenderJobList();
    });
  }

  /* -------------------- exports -------------------- */
  window.loadJobsTab = loadJobsTab;
  window.atsOpenJobBoard = atsOpenJobBoard;
})();

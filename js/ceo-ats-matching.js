/* ============================================================================
 * ceo-ats-matching.js — AI Matching tab for the in-app CEO ATS.
 * Classic <script> (NOT a module). Loaded by pages/ceo-dashboard.html after
 * ceo-ats-shared.js (which exposes window.ATS) and the other ceo-ats-*.js tab
 * modules. Renders into #panel-matching. Exposes window.loadMatchingTab.
 *
 * Two directions, one panel:
 *   "Find GPs for a job" -> GET /api/ats/matching/candidates?job_id=
 *   "Find jobs for a GP" -> GET /api/ats/matching/jobs?user_id=
 * Both directions funnel into the same POST /api/ats/matching/shortlist
 * {items:[{user_id, career_role_id}]} for the per-row + bulk
 * "Shortlist & notify" action (Task 2's endpoint — never calls the AI itself,
 * re-checks eligibility server-side, and stamps match_expires_at = +5 days).
 * ========================================================================== */
(function () {
  'use strict';

  var A = window.ATS;
  if (!A) { console.error('[ATS] ceo-ats-matching.js loaded before window.ATS'); return; }

  function panelEl() { return document.getElementById('panel-matching'); }
  function el(id) { return document.getElementById(id); }
  function val(id) { var n = el(id); return n ? n.value : ''; }
  function on(id, evt, fn) { var n = el(id); if (n) n.addEventListener(evt, fn); }

  var state = {
    direction: 'job2gp',   // 'job2gp' (find GPs for a job) | 'gp2job' (find jobs for a GP)
    jobs: [],              // cached /api/ats/jobs (open roles only) — job picker pool
    candidates: [],        // cached /api/ceo/candidates — GP picker pool
    poolsLoaded: false,
    filterText: '',
    selectedJobId: '',
    selectedUserId: '',
    result: null,          // last ranked response: {job|gp, ranked, excluded_count, ...}
    selected: {}           // row-id -> true, bulk-selection set
  };

  /* -------------------- entry point -------------------- */
  function loadMatchingTab() {
    var panel = panelEl();
    if (!panel) return;
    state.result = null;
    state.selected = {};
    panel.innerHTML = shellHtml();
    wireShell();
    if (!state.poolsLoaded) loadPools(); else renderPicker();
  }

  function shellHtml() {
    return (
      '<div class="ats-section-head">' +
        '<div><h2>AI Matching</h2>' +
        '<p>Rank the best-fit GPs for a job, or the best-fit jobs for a GP — review, then shortlist &amp; notify.</p></div>' +
      '</div>' +
      '<div class="ats-match-direction">' +
        '<button class="ats-btn' + (state.direction === 'job2gp' ? ' active' : '') + '" data-dir="job2gp">Find GPs for a job</button>' +
        '<button class="ats-btn' + (state.direction === 'gp2job' ? ' active' : '') + '" data-dir="gp2job">Find jobs for a GP</button>' +
      '</div>' +
      '<div class="ats-match-picker" id="atsMatchPickerRow"></div>' +
      '<div id="atsMatchResults">' + A.emptyHtml('Pick a job or GP above, then click "Find matches".') + '</div>'
    );
  }

  function wireShell() {
    var panel = panelEl();
    if (!panel) return;
    var bar = panel.querySelector('.ats-match-direction');
    if (bar) bar.addEventListener('click', onDirectionClick);
  }

  function onDirectionClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-dir]') : null;
    if (!btn) return;
    var dir = btn.getAttribute('data-dir');
    if (!dir || dir === state.direction) return;
    state.direction = dir;
    state.filterText = '';
    state.selectedJobId = '';
    state.selectedUserId = '';
    state.result = null;
    state.selected = {};
    var bar = btn.parentNode;
    var btns = bar.querySelectorAll('[data-dir]');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-dir') === dir);
    renderPicker();
    var results = el('atsMatchResults');
    if (results) results.innerHTML = A.emptyHtml('Pick a job or GP above, then click "Find matches".');
  }

  /* -------------------- pools (job list + GP list, fetched once) -------------------- */
  function loadPools() {
    var row = el('atsMatchPickerRow');
    if (row) row.innerHTML = A.loadingHtml('Loading jobs &amp; candidates…');
    Promise.all([A.api('/api/ats/jobs'), A.api('/api/ceo/candidates')]).then(function (res) {
      var jd = res[0], cd = res[1];
      state.jobs = (jd && jd.ok && Array.isArray(jd.jobs)) ? jd.jobs.filter(function (j) { return j.status === 'open'; }) : [];
      state.candidates = (cd && cd.ok && Array.isArray(cd.candidates)) ? cd.candidates.slice() : [];
      state.jobs.sort(function (a, b) { return String(a.title || '').localeCompare(String(b.title || '')); });
      state.candidates.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
      state.poolsLoaded = true;
      renderPicker();
    });
  }

  function optionsHtml(pool, isJob, filterText, selectedId) {
    var ft = String(filterText || '').toLowerCase();
    var opts = ['<option value="">— Select ' + (isJob ? 'a job' : 'a GP') + ' —</option>'];
    pool.forEach(function (item) {
      var id = isJob ? item.id : item.user_id;
      var label = isJob
        ? ((item.title || 'Untitled role') + ' — ' + (item.practice_name || '—') + (item.state ? ' (' + item.state + ')' : ''))
        : ((item.name || 'Unknown') + (item.country ? ' — ' + item.country : ''));
      if (ft && label.toLowerCase().indexOf(ft) === -1) return;
      opts.push('<option value="' + A.escAttr(id) + '"' + (String(id) === String(selectedId) ? ' selected' : '') + '>' + A.esc(label) + '</option>');
    });
    return opts.join('');
  }

  function pickerRowHtml() {
    var isJob = state.direction === 'job2gp';
    var pool = isJob ? state.jobs : state.candidates;
    var selectedId = isJob ? state.selectedJobId : state.selectedUserId;
    return (
      '<input type="text" id="atsMatchFilter" placeholder="' + (isJob ? 'Filter jobs…' : 'Filter GPs…') + '" value="' + A.escAttr(state.filterText || '') + '" />' +
      '<select id="atsMatchPicker">' + optionsHtml(pool, isJob, state.filterText, selectedId) + '</select>' +
      '<button class="ats-btn ats-btn-primary" id="atsMatchGo"' + (selectedId ? '' : ' disabled') + '>Find matches</button>'
    );
  }

  function renderPicker() {
    var row = el('atsMatchPickerRow');
    if (!row) return;
    row.innerHTML = pickerRowHtml();
    on('atsMatchFilter', 'input', onFilterInput);
    on('atsMatchPicker', 'change', onPickerChange);
    on('atsMatchGo', 'click', onFindMatches);
  }

  function onFilterInput() {
    state.filterText = val('atsMatchFilter');
    var sel = el('atsMatchPicker');
    if (!sel) return;
    var isJob = state.direction === 'job2gp';
    var pool = isJob ? state.jobs : state.candidates;
    var selectedId = isJob ? state.selectedJobId : state.selectedUserId;
    sel.innerHTML = optionsHtml(pool, isJob, state.filterText, selectedId);
  }

  function onPickerChange() {
    var id = val('atsMatchPicker');
    if (state.direction === 'job2gp') state.selectedJobId = id; else state.selectedUserId = id;
    var go = el('atsMatchGo');
    if (go) go.disabled = !id;
    // A prior result belongs to the old selection — clear it rather than show
    // stale ranked rows next to a newly-picked job/GP.
    state.result = null;
    state.selected = {};
    var results = el('atsMatchResults');
    if (results) results.innerHTML = '';
  }

  /* -------------------- run the ranking search -------------------- */
  function onFindMatches() { runSearch(false); }
  function onRefresh() { runSearch(true); }

  function runSearch(force) {
    var results = el('atsMatchResults');
    if (!results) return;
    state.selected = {};
    var isJob = state.direction === 'job2gp';
    var id = isJob ? state.selectedJobId : state.selectedUserId;
    if (!id) return;
    results.innerHTML = A.loadingHtml(isJob ? 'Asking the AI to rank GPs for this job…' : 'Asking the AI to rank jobs for this GP…');
    var path = isJob
      ? ('/api/ats/matching/candidates?job_id=' + encodeURIComponent(id))
      : ('/api/ats/matching/jobs?user_id=' + encodeURIComponent(id));
    if (force) path += '&force=1';
    A.api(path).then(function (d) {
      state.result = d;
      renderResults();
    });
  }

  /* -------------------- results -------------------- */
  function rowId(r, isJob) { return String(isJob ? r.user_id : r.career_role_id); }

  function selectedCount() {
    var n = 0;
    for (var k in state.selected) { if (Object.prototype.hasOwnProperty.call(state.selected, k) && state.selected[k]) n++; }
    return n;
  }

  function renderResults() {
    var host = el('atsMatchResults');
    if (!host) return;
    var d = state.result;
    if (!d || !d.ok) { host.innerHTML = A.emptyHtml((d && d.message) || 'Could not load matches.'); return; }

    var isJob = state.direction === 'job2gp';
    var ranked = d.ranked || [];
    var context = isJob ? (d.job || {}) : (d.gp || {});

    var titleHtml = isJob
      ? ('<h2>' + A.esc(context.title || 'Job') + '</h2><p>' + A.esc(context.practice_name || '—') +
          (context.location_city ? ' · ' + A.esc(context.location_city) + (context.location_state ? ', ' + A.esc(context.location_state) : '') : '') + '</p>')
      : ('<h2>' + A.esc(context.name || 'GP') + '</h2><p>Best-fit open roles</p>');
    var header = '<div class="ats-section-head" style="margin-bottom:10px"><div>' + titleHtml + '</div>' +
      '<button class="ats-btn ats-btn-ghost ats-btn-sm" id="atsMatchRefresh">↻ Refresh</button></div>';

    var degradedNote = d.degraded ? ('<div class="ats-context-note">' + A.esc(d.message || 'AI ranking is temporarily degraded — showing best-effort results.') + '</div>') : '';
    var excludedNote = d.excluded_count ? ('<div class="ats-match-excluded">' + d.excluded_count + ' ' + (isJob ? 'GP(s)' : 'job(s)') + ' excluded (not eligible right now).</div>') : '';

    if (!ranked.length) {
      host.innerHTML = header + degradedNote + excludedNote +
        A.emptyHtml(isJob ? 'No eligible GPs matched this job yet.' : 'No eligible open jobs matched this GP yet.');
      on('atsMatchRefresh', 'click', onRefresh);
      return;
    }

    var allSelected = ranked.every(function (r) { return state.selected[rowId(r, isJob)]; });
    host.innerHTML = header + degradedNote + excludedNote +
      '<div class="ats-match-toolbar">' +
        '<label><input type="checkbox" id="atsMatchSelectAll"' + (allSelected ? ' checked' : '') + ' /> Select all</label>' +
        '<button class="ats-btn ats-btn-primary ats-btn-sm" id="atsMatchBulkBtn"' + (selectedCount() ? '' : ' disabled') + '>Shortlist &amp; notify selected (' + selectedCount() + ')</button>' +
      '</div>' +
      '<div class="ats-match-list">' + ranked.map(function (r) { return rowHtml(r, isJob); }).join('') + '</div>';

    wireResultsEvents(isJob, context);
  }

  function rowHtml(r, isJob) {
    var id = rowId(r, isJob);
    var band = A.bandClass(r.score);
    var name = isJob ? (r.name || 'Candidate') : (r.title || 'Role');
    var sub = isJob
      ? (A.countryLabel(r.country) + (r.email ? ' · ' + A.esc(r.email) : ''))
      : (A.esc(r.practice_name || '—') + (r.location_city ? ' · ' + A.esc(r.location_city) + (r.location_state ? ', ' + A.esc(r.location_state) : '') : ''));
    var link = isJob ? ('#candidate=' + encodeURIComponent(id)) : ('#board=' + encodeURIComponent(id));
    var reasons = (r.reasons || []).map(function (t) { return '<li>' + A.esc(t) + '</li>'; }).join('');
    var chips = (r.chips || []).map(function (c) { return '<span class="ats-pill blue">' + A.esc(c) + '</span>'; }).join('');
    var checked = state.selected[id] ? ' checked' : '';
    return (
      '<div class="ats-match-row" data-row-id="' + A.escAttr(id) + '">' +
        '<input type="checkbox" class="ats-match-check" data-row-id="' + A.escAttr(id) + '"' + checked + ' />' +
        '<div class="ats-match-score ' + band + '">' + (r.score == null ? '—' : A.esc(r.score)) + '</div>' +
        '<div class="ats-match-body">' +
          '<div class="ats-match-name"><a href="' + link + '">' + A.esc(name) + '</a></div>' +
          '<div class="ats-match-sub">' + sub + '</div>' +
          (reasons ? '<ul class="ats-match-reasons">' + reasons + '</ul>' : '') +
          (chips ? '<div class="ats-match-chips">' + chips + '</div>' : '') +
          '<div class="ats-match-row-status" id="atsMatchStatus-' + A.escAttr(id) + '"></div>' +
        '</div>' +
        '<div class="ats-match-actions"><button class="ats-btn ats-btn-primary ats-btn-sm" data-shortlist-one="' + A.escAttr(id) + '">Shortlist &amp; notify</button></div>' +
      '</div>'
    );
  }

  function wireResultsEvents(isJob, context) {
    on('atsMatchRefresh', 'click', onRefresh);
    on('atsMatchSelectAll', 'change', function () {
      var checked = this.checked;
      var ranked = (state.result && state.result.ranked) || [];
      ranked.forEach(function (r) {
        var id = rowId(r, isJob);
        if (checked) state.selected[id] = true; else delete state.selected[id];
      });
      renderResults();
    });
    on('atsMatchBulkBtn', 'click', function () { onShortlistClick(null, isJob, context); });

    var host = el('atsMatchResults');
    if (!host) return;
    var checks = host.querySelectorAll('.ats-match-check');
    for (var i = 0; i < checks.length; i++) checks[i].addEventListener('change', onRowCheckChange);
    var oneBtns = host.querySelectorAll('[data-shortlist-one]');
    for (var j = 0; j < oneBtns.length; j++) oneBtns[j].addEventListener('click', onShortlistOneClick);
  }

  function onRowCheckChange() {
    var id = this.getAttribute('data-row-id');
    if (this.checked) state.selected[id] = true; else delete state.selected[id];
    updateBulkButton();
  }

  function updateBulkButton() {
    var btn = el('atsMatchBulkBtn');
    var n = selectedCount();
    if (btn) { btn.disabled = !n; btn.textContent = 'Shortlist & notify selected (' + n + ')'; }
  }

  function onShortlistOneClick() {
    var id = this.getAttribute('data-shortlist-one');
    var isJob = state.direction === 'job2gp';
    var context = isJob ? (state.result && state.result.job) : (state.result && state.result.gp);
    onShortlistClick(id, isJob, context);
  }

  // singleId: a specific row id (per-row action) | null (bulk — uses state.selected).
  function onShortlistClick(singleId, isJob, context) {
    var ids = singleId ? [singleId] : Object.keys(state.selected).filter(function (k) { return state.selected[k]; });
    if (!ids.length) return;
    var ranked = (state.result && state.result.ranked) || [];
    var byId = {};
    ranked.forEach(function (r) { byId[rowId(r, isJob)] = r; });

    var items = ids.map(function (id) {
      return isJob
        ? { user_id: id, career_role_id: (context && context.id) || state.selectedJobId }
        : { user_id: (context && context.user_id) || state.selectedUserId, career_role_id: id };
    });

    var gpCount, jobTitle;
    if (isJob) {
      gpCount = ids.length;
      jobTitle = (context && context.title) || 'this role';
    } else {
      // Reverse direction: exactly one GP, possibly several selected roles —
      // the confirm copy is written for the (primary) job->GP flow, so a
      // multi-role bulk send here names the roles rather than forcing a
      // single title into the template.
      gpCount = 1;
      jobTitle = (ids.length === 1) ? ((byId[ids[0]] && byId[ids[0]].title) || 'this role') : (ids.length + ' selected roles');
    }
    var msg = 'Send the match email and in-app notification to ' + gpCount + ' GP(s) for "' + jobTitle + '"?';
    if (!window.confirm(msg)) return;

    A.api('/api/ats/matching/shortlist', { method: 'POST', body: { items: items } }).then(function (d) {
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not shortlist.'); return; }
      applyShortlistResults(d.results || [], isJob);
    });
  }

  function findRowEls(id) {
    var host = el('atsMatchResults');
    var check = null, oneBtn = null;
    if (host) {
      var checks = host.querySelectorAll('.ats-match-check');
      for (var i = 0; i < checks.length; i++) { if (checks[i].getAttribute('data-row-id') === String(id)) { check = checks[i]; break; } }
      var btns = host.querySelectorAll('[data-shortlist-one]');
      for (var j = 0; j < btns.length; j++) { if (btns[j].getAttribute('data-shortlist-one') === String(id)) { oneBtn = btns[j]; break; } }
    }
    return { check: check, oneBtn: oneBtn, statusEl: el('atsMatchStatus-' + id) };
  }

  // Per-item result: ok / skipped:'live_application' / skipped:'ineligible' / reopened.
  function applyShortlistResults(results, isJob) {
    var okCount = 0, skipCount = 0, errCount = 0;
    results.forEach(function (r) {
      var id = String(isJob ? r.user_id : r.career_role_id);
      var els = findRowEls(id);
      if (r.ok) {
        okCount++;
        if (els.statusEl) els.statusEl.innerHTML = '<span class="ats-pill green">' + (r.reopened ? '✓ Re-shortlisted — email sent' : '✓ Shortlisted — email sent') + '</span>';
      } else if (r.skipped === 'live_application') {
        skipCount++;
        if (els.statusEl) els.statusEl.innerHTML = '<span class="ats-pill muted">Already an active application — skipped</span>';
      } else if (r.skipped === 'ineligible') {
        skipCount++;
        if (els.statusEl) els.statusEl.innerHTML = '<span class="ats-pill amber">Not eligible right now: ' + A.esc((r.blocks || []).join(', ')) + '</span>';
      } else {
        errCount++;
        if (els.statusEl) els.statusEl.innerHTML = '<span class="ats-pill red">Could not shortlist' + (r.error ? ': ' + A.esc(r.error) : '') + '</span>';
      }
      if (els.check) { els.check.checked = false; els.check.disabled = true; }
      if (els.oneBtn) els.oneBtn.disabled = true;
      delete state.selected[id];
    });
    updateBulkButton();
    var selAll = el('atsMatchSelectAll');
    if (selAll) selAll.checked = false;
    A.toast(okCount + ' shortlisted' + (skipCount ? ', ' + skipCount + ' skipped' : '') + (errCount ? ', ' + errCount + ' failed' : ''));
  }

  window.loadMatchingTab = loadMatchingTab;
})();

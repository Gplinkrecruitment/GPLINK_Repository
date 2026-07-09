/* ============================================================================
 * ceo-ats-candidates.js — Candidates tab for the in-app ATS.
 * Classic <script> (no module). Loaded by pages/ceo-dashboard.html AFTER the
 * page inline script and AFTER /js/ceo-ats-shared.js (window.ATS).
 * Ports pages/ceo-dashboard-prototype.html renderCandidates()/openCandidate()
 * faithfully, but fetches the REAL CEO endpoints and renders into
 * #panel-candidates. All css classes are `ats-`-prefixed (css/ceo-ats.css).
 * Exposes window.loadCandidatesTab() and window.atsOpenCandidate(caseId).
 * ========================================================================== */
(function () {
  'use strict';

  var ATS = window.ATS;
  if (!ATS) return;

  var PANEL_ID = 'panel-candidates';
  function panel() { return document.getElementById(PANEL_ID); }

  // ---- list filter / sort / search state (kept in module scope) ----
  var state = { q: '', stage: '', band: '', account_status: '', sort: 'intent', ats_bucket: '' };
  var searchTimer = null;
  var currentCandidate = null;
  var pipelineSummary = null; // last fetched /api/ceo/pipeline-summary payload
  var attentionSummary = null; // last fetched /api/ats/attention payload

  // Registration-stage filter options (rail stages).
  var STAGE_OPTS = [
    { v: 'myintealth', label: 'MyIntealth' },
    { v: 'amc', label: 'AMC' },
    { v: 'career', label: 'Career' },
    { v: 'ahpra', label: 'AHPRA' },
    { v: 'pbs', label: 'PBS & Medicare' },
    { v: 'commencement', label: 'Commencement' }
  ];

  // ATS pipeline-stage labels + colours for the job-application rows.
  var ATS_STAGE = {
    shortlisted: { l: 'Shortlisted', c: '#7c3aed' },
    applied: { l: 'Applied', c: 'var(--ats-blue)' },
    submitted: { l: 'Submitted', c: 'var(--ats-blue)' },
    reviewing: { l: 'Reviewing', c: 'var(--ats-purple)' },
    interview: { l: 'Interviewing', c: 'var(--ats-amber)' },
    offer: { l: 'Offer', c: 'var(--ats-green)' },
    hired: { l: 'Hired', c: 'var(--ats-green)' },
    not_proceeding: { l: 'Not proceeding', c: 'var(--ats-red)' }
  };
  function atsStageMeta(s) { return ATS_STAGE[s] || { l: s ? String(s) : '—', c: 'var(--ats-muted)' }; }

  // Selectable ATS pipeline stages for the per-application <select> (value, label).
  var ATS_STAGE_OPTS = [
    ['shortlisted', 'Shortlisted'],
    ['applied', 'Applied'], ['submitted', 'Submitted'], ['reviewing', 'Reviewing'],
    ['interview', 'Interview'], ['offer', 'Offer'], ['hired', 'Hired'], ['not_proceeding', 'Not proceeding']
  ];
  function stageOptLabel(s) {
    for (var i = 0; i < ATS_STAGE_OPTS.length; i++) { if (ATS_STAGE_OPTS[i][0] === s) return ATS_STAGE_OPTS[i][1]; }
    return s ? String(s) : '—';
  }

  // AI Matching (Task 7 review fix, spec §9): late-withdrawal reason capture
  // on THIS surface too — the candidate drawer's per-application stage
  // <select> can move a card to not_proceeding just like the Jobs board, and
  // without the same prompt Task 8's strike data would systematically miss
  // withdrawals made from here. Same reason values, same PATCH `reason`
  // field, same "submitted or later" trigger as js/ceo-ats-jobs.js.
  var WITHDRAW_REASONS = [
    { value: 'gp_withdrew', label: 'GP withdrew after submission' },
    { value: 'practice_passed', label: 'Practice passed on the candidate' },
    { value: 'unresponsive', label: 'Candidate went unresponsive' },
    { value: 'other', label: 'Other' }
  ];
  function stageNeedsWithdrawReason(fromStageKey) {
    var order = ATS_STAGE_OPTS.map(function (o) { return o[0]; });
    var fromIdx = order.indexOf(fromStageKey);
    var submittedIdx = order.indexOf('submitted');
    // 'not_proceeding' itself is last in ATS_STAGE_OPTS but a no-op move
    // (already there) never reaches this check via the change handler.
    return fromIdx !== -1 && fromStageKey !== 'not_proceeding' && fromIdx >= submittedIdx;
  }
  // onProceed(reason) fires only on the confirm button (reason may be ''
  // when skipped); Cancel/close calls onCancel — the caller reverts the
  // select and never PATCHes.
  function openWithdrawReasonPrompt(onProceed, onCancel) {
    ATS.setOverlay(
      '<div class="ats-modal-wrap open" id="ats-withdraw-wrap">' +
        '<div class="ats-modal" style="max-width:420px">' +
          '<div class="ats-modal-head"><h3>Why is this application not proceeding?</h3><button class="ats-drawer-close" id="ats-withdraw-close">×</button></div>' +
          '<div class="ats-modal-body">' +
            '<label>Reason (optional — helps track patterns)</label>' +
            '<select id="ats-withdraw-reason"><option value="">— No reason (skip) —</option>' +
              WITHDRAW_REASONS.map(function (r) { return '<option value="' + r.value + '">' + ATS.esc(r.label) + '</option>'; }).join('') +
            '</select>' +
          '</div>' +
          '<div class="ats-modal-foot">' +
            '<button class="ats-btn ats-btn-ghost" id="ats-withdraw-cancel">Cancel</button>' +
            '<button class="ats-btn ats-btn-primary" id="ats-withdraw-save">Move to Not Proceeding</button>' +
          '</div>' +
        '</div>' +
      '</div>');
    var root = document.getElementById('atsOverlayRoot');
    if (!root) { if (onCancel) onCancel(); return; }
    function close() { ATS.setOverlay(''); }
    function cancel() { close(); if (onCancel) onCancel(); }
    var closeBtn = root.querySelector('#ats-withdraw-close');
    var cancelBtn = root.querySelector('#ats-withdraw-cancel');
    var wrap = root.querySelector('#ats-withdraw-wrap');
    if (closeBtn) closeBtn.addEventListener('click', cancel);
    if (cancelBtn) cancelBtn.addEventListener('click', cancel);
    if (wrap) wrap.addEventListener('click', function (e) { if (e.target === wrap) cancel(); });
    var save = root.querySelector('#ats-withdraw-save');
    if (save) save.addEventListener('click', function () {
      var reason = (root.querySelector('#ats-withdraw-reason') || {}).value || '';
      close();
      onProceed(reason);
    });
  }

  // Total-pipeline funnel: colour per bucket key (labels come from the endpoint).
  var BUCKET_COLOR = {
    unassociated: 'var(--ats-dim)',
    shortlisted: '#7c3aed',
    applied: 'var(--ats-blue)',
    submitted: 'var(--ats-purple)',
    reviewing: 'var(--ats-amber)',
    interview: 'var(--ats-blue)',
    offer: 'var(--ats-green)',
    hired: 'var(--ats-green)',
    not_proceeding: 'var(--ats-red)'
  };

  var SVG_SEARCH = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ats-dim)" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
  var SVG_CHAT = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var SVG_ZOOM = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/></svg>';

  // tone string -> pill colour modifier (ported from prototype toneClass).
  function toneClass(t) {
    if (/enthus/i.test(t)) return 'green';
    if (/hesit|frustr|cautio/i.test(t)) return 'amber';
    if (/posit|commit|warm/i.test(t)) return 'blue';
    return 'muted';
  }

  function field(lbl, valHtml) {
    return '<div class="ats-detail-field"><div class="df-lbl">' + lbl +
      '</div><div class="df-val">' + valHtml + '</div></div>';
  }
  function metric(val, lbl) {
    return '<div class="ats-metric"><div class="m-val">' + ATS.esc(String(val)) +
      '</div><div class="m-lbl">' + lbl + '</div></div>';
  }
  function statusPill(s) {
    return s === 'under_review'
      ? '<span class="ats-pill amber">Under review</span>'
      : '<span class="ats-pill green">Active</span>';
  }

  /* =====================================================================
   *  LIST VIEW
   * ===================================================================== */
  window.loadCandidatesTab = function () {
    var el = panel();
    if (!el) return;
    el.innerHTML = listScaffold();
    wireListEvents(el);
    fetchAndRenderRows();
    fetchPipelineSummary();
    fetchAttention();
  };

  function listScaffold() {
    var stageOpts = '<option value="">All stages</option>' +
      STAGE_OPTS.map(function (o) { return '<option value="' + o.v + '">' + o.label + '</option>'; }).join('');
    var bandOpts = '<option value="">All intent</option>' +
      ['Hot', 'Warm', 'Cold'].map(function (b) { return '<option value="' + b + '">' + b + '</option>'; }).join('');
    var sortTxt = state.sort === 'intent' ? 'Intent' : 'Name';
    return '' +
      '<div class="ats-section-head"><div>' +
        '<h2>Candidates</h2>' +
        '<p>Every GP on file — profile, onboarding, AI call summaries &amp; pipeline position, ranked by intent.</p>' +
      '</div></div>' +
      '<div class="ats-attention-strip" id="ats-attention-strip">' + attentionStripInner() + '</div>' +
      '<div class="ats-pipeline-widget" id="ats-pipeline-widget">' + pipelineWidgetInner() + '</div>' +
      '<div class="ats-toolbar">' +
        '<div class="ats-search">' + SVG_SEARCH +
          '<input type="text" id="ats-cand-search" placeholder="Search candidates…" value="' + ATS.escAttr(state.q) + '" />' +
        '</div>' +
        '<button class="ats-btn ats-btn-ghost ats-btn-sm" id="ats-cand-sort">Sort: ' + sortTxt + ' ▾</button>' +
        '<select id="ats-cand-stage" style="width:auto;min-width:130px">' + stageOpts + '</select>' +
        '<select id="ats-cand-band" style="width:auto;min-width:120px">' + bandOpts + '</select>' +
        // Phase 6 E1 (audit B3): owner CSV download of every GP on file.
        '<a class="ats-btn ats-btn-ghost ats-btn-sm" href="/api/admin/export?entity=gps&format=csv" style="text-decoration:none">Export CSV</a>' +
      '</div>' +
      '<div class="ats-cand-head">' +
        '<span>Candidate</span><span>Country</span><span>Registration stage</span>' +
        '<span>Intent score</span><span>Onboarding</span><span>Documents</span>' +
      '</div>' +
      '<div class="ats-cand-table" id="ats-cand-table">' + ATS.loadingHtml('Loading candidates…') + '</div>';
  }

  function wireListEvents(el) {
    var search = el.querySelector('#ats-cand-search');
    if (search) search.addEventListener('input', function () {
      var v = this.value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { state.q = v; fetchAndRenderRows(); }, 250);
    });
    var sortBtn = el.querySelector('#ats-cand-sort');
    if (sortBtn) sortBtn.addEventListener('click', function () {
      state.sort = state.sort === 'intent' ? 'name' : 'intent';
      this.textContent = 'Sort: ' + (state.sort === 'intent' ? 'Intent' : 'Name') + ' ▾';
      fetchAndRenderRows();
    });
    var stageSel = el.querySelector('#ats-cand-stage');
    if (stageSel) {
      stageSel.value = state.stage;
      stageSel.addEventListener('change', function () { state.stage = this.value; fetchAndRenderRows(); });
    }
    var bandSel = el.querySelector('#ats-cand-band');
    if (bandSel) {
      bandSel.value = state.band;
      bandSel.addEventListener('change', function () { state.band = this.value; fetchAndRenderRows(); });
    }
    // delegated: pipeline-funnel segments toggle the bucket filter; "Clear" resets it.
    var widget = el.querySelector('#ats-pipeline-widget');
    if (widget) widget.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      if (e.target.closest('.ats-pw-clear')) {
        if (!state.ats_bucket) return;
        state.ats_bucket = '';
        renderPipelineWidget();
        fetchAndRenderRows();
        return;
      }
      var seg = e.target.closest('.ats-pw-seg');
      if (!seg) return;
      var bucket = seg.getAttribute('data-bucket') || '';
      state.ats_bucket = (state.ats_bucket === bucket) ? '' : bucket;
      renderPipelineWidget();
      fetchAndRenderRows();
    });
    // delegated: an attention-strip count jumps the list to that ats bucket,
    // reusing the same ats_bucket filter the pipeline funnel drives.
    var strip = el.querySelector('#ats-attention-strip');
    if (strip) strip.addEventListener('click', function (e) {
      var cell = e.target.closest ? e.target.closest('.ats-attn-cell') : null;
      if (!cell || cell.disabled) return;
      var bucket = cell.getAttribute('data-attention') || '';
      if (!bucket) return;
      state.ats_bucket = bucket;
      renderPipelineWidget();
      fetchAndRenderRows();
      var pw = el.querySelector('#ats-pipeline-widget');
      if (pw && pw.scrollIntoView) pw.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    var table = el.querySelector('#ats-cand-table');
    if (table) table.addEventListener('click', function (e) {
      var row = e.target.closest ? e.target.closest('.ats-cand-row') : null;
      if (!row) return;
      var id = row.getAttribute('data-case-id');
      if (id) window.atsOpenCandidate(id);
    });
  }

  function fetchAndRenderRows() {
    var t0 = document.getElementById('ats-cand-table');
    if (t0) t0.innerHTML = ATS.loadingHtml('Loading candidates…');
    var qs = '?q=' + encodeURIComponent(state.q || '') +
      '&stage=' + encodeURIComponent(state.stage || '') +
      '&band=' + encodeURIComponent(state.band || '') +
      '&account_status=' + encodeURIComponent(state.account_status || '') +
      '&sort=' + encodeURIComponent(state.sort || 'intent') +
      '&ats_bucket=' + encodeURIComponent(state.ats_bucket || '');
    ATS.api('/api/ceo/candidates' + qs).then(function (d) {
      var t = document.getElementById('ats-cand-table');
      if (!t) return; // navigated away (e.g. opened a candidate)
      if (!d || !d.ok) { t.innerHTML = ATS.emptyHtml('Could not load candidates.'); return; }
      var list = d.candidates || [];
      var total = d.total != null ? d.total : list.length;
      var cc = document.getElementById('masterCandCount');
      if (cc) cc.textContent = total;
      if (!list.length) { t.innerHTML = ATS.emptyHtml('No candidates match your filters.'); return; }
      t.innerHTML = list.map(rowHtml).join('');
    });
  }

  /* ---- "Needs attention" strip (above the pipeline funnel) ---- */
  function attentionStripInner() {
    if (!attentionSummary) return '<span class="ats-attn-loading" style="color:var(--ats-dim);font-size:12px">Checking what needs attention…</span>';
    var items = [
      { key: 'applied', label: 'New applications', hint: 'last 7 days', count: attentionSummary.new_applications || 0 },
      { key: 'offer', label: 'Declined offers', hint: 'awaiting action', count: attentionSummary.declined_offers || 0 },
      { key: 'interview', label: 'Interviews awaiting availability', hint: 'practice not replied', count: attentionSummary.interviews_awaiting || 0 }
    ];
    var total = items.reduce(function (s, it) { return s + it.count; }, 0);
    var title = total > 0
      ? '<span class="ats-attn-title" style="font-weight:700;color:var(--ats-amber)">⚠ Needs attention</span>'
      : '<span class="ats-attn-title" style="font-weight:700;color:var(--ats-green)">✓ Nothing needs attention</span>';
    var cells = items.map(function (it) {
      var live = it.count > 0;
      var accent = live ? 'var(--ats-amber)' : 'var(--ats-dim)';
      return '<button type="button" class="ats-attn-cell' + (live ? ' live' : '') + '" data-attention="' + ATS.escAttr(it.key) + '"' +
          (live ? '' : ' disabled') +
          ' style="display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:8px 12px;border:1px solid rgba(255,255,255,0.09);border-radius:9px;background:' + (live ? 'rgba(245,158,11,0.10)' : 'transparent') + ';cursor:' + (live ? 'pointer' : 'default') + '">' +
        '<span class="ats-attn-count" style="font-size:18px;font-weight:700;color:' + accent + '">' + it.count + '</span>' +
        '<span class="ats-attn-label" style="font-size:11.5px;color:var(--ats-text)">' + ATS.esc(it.label) + '</span>' +
        '<span class="ats-attn-hint" style="font-size:10px;color:var(--ats-dim)">' + ATS.esc(it.hint) + '</span>' +
      '</button>';
    }).join('');
    return '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">' + title +
      '<div class="ats-attn-cells" style="display:flex;gap:10px;flex-wrap:wrap">' + cells + '</div></div>';
  }

  function renderAttentionStrip() {
    var s = document.getElementById('ats-attention-strip');
    if (s) s.innerHTML = attentionStripInner();
  }

  function fetchAttention() {
    ATS.api('/api/ats/attention').then(function (d) {
      attentionSummary = (d && d.ok)
        ? d
        : { new_applications: 0, declined_offers: 0, interviews_awaiting: 0 };
      renderAttentionStrip();
    });
  }

  /* ---- total-pipeline funnel widget (top of the list view) ---- */
  function pipelineWidgetInner() {
    if (!pipelineSummary) return '<div class="ats-pw-loading">Loading pipeline…</div>';
    var buckets = pipelineSummary.buckets || [];
    var total = pipelineSummary.total != null ? pipelineSummary.total : 0;
    var active = state.ats_bucket || '';
    var segs = buckets.map(function (b) {
      var color = BUCKET_COLOR[b.key] || 'var(--ats-muted)';
      var isActive = !!active && active === b.key;
      return '<button type="button" class="ats-pw-seg' + (isActive ? ' active' : '') +
          '" data-bucket="' + ATS.escAttr(b.key) + '" style="--seg-color:' + color + '">' +
        '<span class="ats-pw-count">' + (b.count != null ? b.count : 0) + '</span>' +
        '<span class="ats-pw-label">' + ATS.esc(b.label || b.key) + '</span>' +
      '</button>';
    }).join('');
    var showing = '';
    if (active) {
      var lbl = active;
      for (var i = 0; i < buckets.length; i++) { if (buckets[i].key === active) { lbl = buckets[i].label || active; break; } }
      showing = '<span class="ats-pw-showing">Showing: <b>' + ATS.esc(lbl) + '</b>' +
        ' · <button type="button" class="ats-pw-clear">Clear</button></span>';
    }
    return '<div class="ats-pw-head"><span class="ats-pw-total">Total: <b>' + total + '</b> GPs</span>' + showing + '</div>' +
      '<div class="ats-pw-funnel">' + segs + '</div>';
  }

  function renderPipelineWidget() {
    var w = document.getElementById('ats-pipeline-widget');
    if (w) w.innerHTML = pipelineWidgetInner();
  }

  function fetchPipelineSummary() {
    ATS.api('/api/ceo/pipeline-summary').then(function (d) {
      if (!d || !d.ok) {
        pipelineSummary = null;
        var w = document.getElementById('ats-pipeline-widget');
        if (w) w.innerHTML = '<div class="ats-pw-loading">Could not load the pipeline summary.</div>';
        return;
      }
      pipelineSummary = d;
      renderPipelineWidget();
    });
  }

  // Re-pull the funnel counts after a pipeline move, but only when the list view is mounted.
  window.refreshPipelineWidget = function () {
    if (document.getElementById('ats-pipeline-widget')) fetchPipelineSummary();
    if (document.getElementById('ats-attention-strip')) fetchAttention();
  };

  function rowHtml(c) {
    var regPill = c.blocked
      ? '<span class="ats-pill red">' + ATS.esc(c.reg_stage_label || '') + ' · blocked ' + (c.blocked_days || 0) + 'd</span>'
      : '<span class="ats-pill blue">' + ATS.esc(c.reg_stage_label || '') + '</span>';
    // AI Matching (Task 7): "high application velocity" chip — 5+ applies in
    // 24h, still within its 7-day display window (spec §9). Team-only signal.
    var velocityChip = c.high_velocity
      ? ' <span class="ats-pill amber" title="5 or more applications in the last 24 hours">High application velocity</span>'
      : '';
    // AI Matching (Task 8): "CAREER LOCKED" chip — 3-strike career lock.
    var careerLockChip = c.career_locked
      ? ' <span class="ats-pill red" title="Career page paused after 3 strikes">CAREER LOCKED</span>'
      : '';
    var ob = c.onboarding_completed
      ? '<span class="ats-pill green">Complete</span>'
      : '<span class="ats-pill amber">' + (c.onboarding_pct != null ? c.onboarding_pct : 0) + '%</span>';
    var docs = c.docs || {};
    return '<div class="ats-cand-row" data-case-id="' + ATS.escAttr(c.case_id) + '">' +
      '<div class="cr-id"><div class="ats-avatar" style="background:' + ATS.avatarColor(c.name) + '">' + ATS.esc(ATS.initials(c.name)) + '</div>' +
        '<div><div class="cr-name">' + ATS.esc(c.name) + '</div><div class="cr-sub">' + ATS.esc(c.email) + '</div></div></div>' +
      '<div class="cr-sub">' + ATS.countryLabel(c.country) + '</div>' +
      '<div>' + regPill + velocityChip + careerLockChip + '</div>' +
      ATS.intentChip(c.intent_score, c.intent_band) +
      '<div>' + ob + '</div>' +
      '<div class="ats-doc-chips">' +
        '<span class="ats-doc-chip ' + (docs.cv ? 'yes' : '') + '">CV ' + (docs.cv ? '✓' : '✗') + '</span>' +
        '<span class="ats-doc-chip ' + (docs.coverLetter ? 'yes' : '') + '">Cover ' + (docs.coverLetter ? '✓' : '✗') + '</span>' +
      '</div>' +
    '</div>';
  }

  /* =====================================================================
   *  DETAIL VIEW
   * ===================================================================== */
  window.atsOpenCandidate = function (caseId) {
    var el = panel();
    if (!el) return;
    el.innerHTML = ATS.loadingHtml('Loading candidate…');
    function render(d) {
      var host = panel();
      if (!host) return;
      if (!d || !d.ok || !d.candidate) {
        host.innerHTML =
          '<div class="ats-board-head"><button class="ats-back-btn" id="ats-cand-back">‹ All candidates</button></div>' +
          ATS.emptyHtml('Could not load this candidate.');
        var b = host.querySelector('#ats-cand-back');
        if (b) b.addEventListener('click', function () { window.loadCandidatesTab(); });
        return;
      }
      currentCandidate = d.candidate;
      host.innerHTML = detailHtml(d.candidate);
      wireDetailEvents(host, d.candidate);
      if (window.scrollTo) window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    ATS.api('/api/ceo/candidate?case_id=' + encodeURIComponent(caseId)).then(function (d) {
      if (d && d.ok && d.candidate) { render(d); return; }
      // Some deep-links (the Matching tab's results only carry the GP's
      // user_id, not their registration_cases.id) pass a user_id here instead
      // of a case_id — retry once treating it as a user_id before giving up.
      ATS.api('/api/ceo/candidate?user_id=' + encodeURIComponent(caseId)).then(render);
    });
  };

  function detailHtml(c) {
    var ob = c.onboarding || {};
    var specialty = ob.specialty || '—';
    var subHtml = ATS.countryLabel(c.country) + ' · ' + ATS.esc(specialty) + ' · joined ' + ATS.esc(c.joined || '—') +
      (c.account_status === 'under_review' ? ' · <span class="ats-pill amber">Under review</span>' : '');

    return '' +
      '<div class="ats-board-head"><button class="ats-back-btn" id="ats-cand-back">‹ All candidates</button></div>' +
      '<div class="ats-section-head" style="margin-bottom:16px">' +
        '<div class="ats-profile-hero">' +
          '<div class="ats-avatar" style="background:' + ATS.avatarColor(c.name) + '">' + ATS.esc(ATS.initials(c.name)) + '</div>' +
          '<div><h2>' + ATS.esc(c.name) + '</h2><div class="ph-sub">' + subHtml + '</div></div>' +
        '</div>' +
        // Consultants are ATS-only: the RSO file lives on admin.html (closed to
        // them) and "Schedule call" posts to /api/admin/calls/schedule (a
        // registration-side RSO route we deliberately did NOT open) — hide both.
        '<div style="display:flex;gap:9px">' +
          (ATS.isConsultant && ATS.isConsultant() ? '' :
            '<button class="ats-btn ats-btn-ghost ats-btn-sm" id="ats-cand-rsofile">Open RSO file</button>' +
            '<button class="ats-btn ats-btn-primary ats-btn-sm" id="ats-cand-schedule">＋ Schedule call</button>') +
        '</div>' +
      '</div>' +
      '<div class="ats-cand-profile-grid">' +
        '<div>' +
          '<div class="ats-card" style="margin-bottom:16px">' + profileCardInner(c) + '</div>' +
          '<div class="ats-card ats-intent-card">' + intentCardInner(c) + '</div>' +
        '</div>' +
        '<div>' +
          // AI Matching (Task 8): only rendered when this GP has ever been
          // career-locked (c.career_lock is null otherwise) — no empty card.
          (c.career_lock ? '<div class="ats-card" style="margin-bottom:16px">' + strikesCardInner(c) + '</div>' : '') +
          '<div class="ats-card" style="margin-bottom:16px">' + pipelineCardInner(c) + '</div>' +
          '<div class="ats-card" style="margin-bottom:16px">' + applicationsCardInner(c) + '</div>' +
          '<div class="ats-card" style="margin-bottom:16px">' + onboardingCardInner(c) + '</div>' +
          '<div class="ats-card" style="margin-bottom:16px">' + docsCardInner(c) + '</div>' +
          '<div class="ats-card" style="margin-bottom:16px" id="ats-cand-comms">' + commsCardInner(c) + '</div>' +
          '<div class="ats-card" style="margin-bottom:16px">' + callsCardInner(c) + '</div>' +
          '<div class="ats-card">' + handoverCardInner(c) + '</div>' +
        '</div>' +
      '</div>';
  }

  function profileCardInner(c) {
    return '<div class="ats-card-title"><span class="ats-dot" style="background:var(--ats-blue)"></span> Profile</div>' +
      field('Email', ATS.esc(c.email || '—')) +
      field('Phone', ATS.esc(c.phone || '—')) +
      field('Registration country', ATS.esc(c.country || '—')) +
      field('Registration no.', ATS.esc(c.reg || '—')) +
      field('Account status', statusPill(c.account_status)) +
      field('Assigned RSO', ATS.esc(c.rso || '—')) +
      // Legacy imported-candidate id — only shown when one actually exists.
      (c.zoho ? field('Legacy candidate ID', ATS.esc(c.zoho)) : '');
  }

  function intentCardInner(c) {
    var it = c.intent || { score: null, band: '', signals: [] };
    var bandTxt = it.band || ATS.bandLabel(it.score);
    var bl = String(it.band || '').toLowerCase() || ATS.bandClass(it.score);
    var dotColor = bl === 'hot' ? 'var(--ats-red)' : bl === 'warm' ? 'var(--ats-amber)' : 'var(--ats-dim)';
    var pillMod = bl === 'hot' ? 'red' : bl === 'warm' ? 'amber' : 'muted';
    var signals = it.signals || [];
    return '<div class="ats-card-title"><span class="ats-dot" style="background:' + dotColor + '"></span> Intent calculator</div>' +
      '<div class="ats-intent-big"><span class="ib-score ats-band-' + bl + '">' + (it.score == null ? '—' : it.score) + '</span>' +
        '<span class="ib-max">/ 100</span>' +
        '<span class="ats-pill ' + pillMod + '" style="margin-left:auto;font-size:12px">' + (bandTxt === 'Hot' ? '🔥 ' : '') + ATS.esc(bandTxt) + '</span></div>' +
      '<div style="margin-top:14px">' + signals.map(signalRow).join('') + '</div>' +
      '<div class="ats-confirm-note">Signals &amp; weights are a first proposal — tell me what to change.</div>';
  }
  function signalRow(s) {
    var pts = s.points != null ? s.points : Math.round((s.w || 0) * (s.v || 0));
    return '<div class="ats-signal-row">' +
      '<span>' + ATS.esc(s.label) + '</span>' +
      '<span class="sr-bar"><i style="width:' + Math.round((s.v || 0) * 100) + '%"></i></span>' +
      '<span class="sr-pts">+' + pts + '</span></div>';
  }

  function pipelineCardInner(c) {
    var rail = c.rail || [];
    var railHtml = rail.map(function (st, i) {
      var stCls = st.state || '';
      var dotContent = stCls === 'done' ? '✓' : (i + 1);
      var priorDone = i > 0 && rail[i - 1] && (rail[i - 1].state === 'done' || rail[i - 1].state === 'current');
      var leftLine = i > 0 ? '<div class="ats-jline' + (priorDone ? ' done' : '') + '"></div>' : '<div style="flex:1"></div>';
      return '<div class="ats-jcol"><div class="ats-jtop">' + leftLine +
        '<div class="ats-jdot ' + stCls + '">' + dotContent + '</div>' +
        '<div style="flex:1"></div></div>' +
        '<div class="ats-jlabel">' + ATS.esc(st.label || '') + '</div></div>';
    }).join('');

    var blockedPill = c.blocked ? '<span class="ats-pill red" style="margin-left:6px">Blocked at ' + ATS.esc(c.reg_stage_label || '') + '</span>' : '';

    return '<div class="ats-card-title"><span class="ats-dot" style="background:var(--ats-green)"></span> Pipeline position</div>' +
      '<div class="df-lbl" style="margin-bottom:6px">Registration journey ' + blockedPill + '</div>' +
      '<div class="ats-journey-wrap">' + railHtml + '</div>';
  }

  function applicationsCardInner(c) {
    var apps = c.apps || [];
    var appsHtml = apps.length ? apps.map(function (a) {
      var meta = atsStageMeta(a.ats_stage);
      // data-stage-was: the stage at render time — the withdraw-reason prompt
      // (Task 7) needs the FROM stage to know a not_proceeding move is a
      // post-submission withdrawal, and Cancel needs it to revert the select.
      var stageSel = '<select class="ats-app-stage" data-app-id="' + ATS.escAttr(a.id) + '" data-stage-was="' + ATS.escAttr(a.ats_stage || '') + '">' +
        ATS_STAGE_OPTS.map(function (o) {
          return '<option value="' + o[0] + '"' + (a.ats_stage === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') + '</select>';

      // Interview line
      var interviewHtml;
      if (!a.interview) {
        interviewHtml = '<span class="ats-app-interview-none">No interview yet</span>';
      } else if (a.interview.status === 'booked') {
        var dt = '';
        try { dt = new Date(a.interview.scheduled_at).toLocaleString(); } catch (ex) { dt = a.interview.scheduled_at || ''; }
        interviewHtml = '<span class="ats-app-interview-booked">Booked for ' + ATS.esc(dt) + '</span>' +
          ' <button type="button" class="ats-btn ats-btn-ghost ats-btn-sm ats-int-cancel" data-app-id="' + ATS.escAttr(String(a.id)) + '" style="margin-left:8px">Cancel &amp; rebook</button>';
        // Meeting join link (resolved server-side: real Zoom → standing room → none).
        var ivJoinUrl = String((a.interview && a.interview.join_url) || '');
        if (ivJoinUrl.indexOf('https://') === 0) {
          interviewHtml += '<div class="ats-app-interview-join">🔗 <a href="' + ATS.escAttr(ivJoinUrl) + '" target="_blank" rel="noopener">Join meeting link</a></div>';
        } else {
          interviewHtml += '<div class="ats-app-interview-join ats-app-interview-join-muted">No meeting link yet — set INTERVIEW_MEETING_URL or connect Zoom</div>';
        }
        if (a.interview.summary) {
          interviewHtml += '<div class="ats-app-interview-summary">' + ATS.esc(a.interview.summary) + '</div>';
        }
      } else {
        // Awaiting GP slot pick — placeholder filled by atsRenderSlotPicker in wireDetailEvents.
        interviewHtml = '<div class="ats-app-slot-pick" data-slot-pick-id="' + ATS.escAttr(String(a.id)) + '"></div>';
      }

      // Source chip: legacy imported application vs in-app (standalone ATS).
      var sourceChip = '<span class="ats-pill muted" style="font-size:10.5px">' + (a.source === 'zoho' ? 'Imported' : 'In-app') + '</span>';

      return '<div class="ats-app-card">' +
        '<div class="ats-app-card-top">' +
          '<div>' +
            '<div class="ats-app-job-title">' + ATS.esc(a.job_title || '—') + '</div>' +
            '<div class="ats-app-practice">' + ATS.esc(a.practice_name || '') + '</div>' +
          '</div>' +
          '<div class="ats-app-right">' +
            sourceChip +
            '<span class="ats-pill" style="background:rgba(255,255,255,0.06);color:' + meta.c + '">' + ATS.esc(meta.l) + '</span>' +
            stageSel +
          '</div>' +
        '</div>' +
        '<div class="ats-app-interview"><span class="ats-app-lbl">Practice</span>' + submitPracticeLineHtml(a) + acceptApplicationLineHtml(a) + '</div>' +
        '<div class="ats-app-interview"><span class="ats-app-lbl">Interview</span>' + interviewHtml + '</div>' +
        '<div class="ats-app-offer"><span class="ats-app-lbl">Offer / contract</span>' +
          '<div class="ats-offer-box" data-offer-app-id="' + ATS.escAttr(String(a.id)) + '" style="flex:1;min-width:0">' + offerLineHtml(a) + '</div>' +
        '</div>' +
        markPlacementLineHtml(a) +
      '</div>';
    }).join('') : '<div class="ats-empty">No job applications yet.</div>';

    var appCount = apps.length;
    return '<div class="ats-card-title"><span class="ats-dot" style="background:var(--ats-amber)"></span> Applications</div>' +
      '<div class="ats-pw-apps-head" style="margin-top:0;margin-bottom:12px">' +
        '<span style="font-size:12px;color:var(--ats-dim)">' + appCount + ' application' + (appCount === 1 ? '' : 's') + '</span>' +
        '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" id="ats-add-job">＋ Add to a job</button>' +
      '</div>' +
      appsHtml;
  }

  /* ---- Submit to practice (Task D) ----
   * Works for internal (non-Zoho) applications too: the server's
   * /api/admin/career/application/submit-to-practice now emails the practice a
   * candidate introduction (with the CV) when Zoho isn't connected or the app
   * has no Zoho ids. The button shows while the app is still awaiting
   * submission and hasn't moved past the early pipeline lanes. */
  var SUBMIT_ELIGIBLE_STAGES = ['applied', 'submitted', 'reviewing'];
  var SUBMISSION_STATUS_LABELS = {
    submitted_to_practice: 'Submitted to practice',
    client_reviewed: 'Reviewed by the practice',
    client_approved: 'Approved by the practice',
    client_rejected: 'Practice declined',
    interview_ready: 'Ready for interview'
  };

  function submitPracticeLineHtml(a) {
    var st = a.practice_submission_status || '';
    if (SUBMISSION_STATUS_LABELS[st]) {
      return '<span>' + ATS.esc(SUBMISSION_STATUS_LABELS[st]) + '</span>';
    }
    // pending_va_submission (or unknown) — offer the action while the card is
    // still in an early lane; otherwise just show the neutral state.
    if (st && SUBMIT_ELIGIBLE_STAGES.indexOf(a.ats_stage) !== -1) {
      return '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm ats-submit-practice" data-app-id="' + ATS.escAttr(String(a.id)) + '">Submit to practice</button>';
    }
    return '<span class="ats-app-interview-none">Not submitted yet</span>';
  }

  // "Practice accepted" (Task 12): reveals the real practice identity to the
  // GP, records an in-app offer and congratulates them by email. Hidden once
  // the practice has already approved/reached interview-ready, or the offer
  // itself is already accepted — nothing left for this button to do.
  // A8a: record a placement the GP accepted verbally (they can't self-click the
  // in-app accept). Shown at offer/hired stage while an offer is still on the
  // table (status 'sent') — an already-accepted offer is secured via the GP
  // path, so nothing is left to do here. Confirms, with an optional start date.
  var PLACEMENT_ELIGIBLE_STAGES = ['offer', 'hired'];
  function markPlacementLineHtml(a) {
    var offerStatus = (a.offer && a.offer.status) || 'not_started';
    if (offerStatus !== 'sent') return '';
    if (PLACEMENT_ELIGIBLE_STAGES.indexOf(a.ats_stage) === -1) return '';
    return '<div class="ats-app-interview"><span class="ats-app-lbl">Placement</span>' +
      '<div class="ats-placement-box" data-placement-app-id="' + ATS.escAttr(String(a.id)) + '" style="flex:1;min-width:0">' +
        '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm ats-mark-placement" data-app-id="' + ATS.escAttr(String(a.id)) + '">✅ Mark placement secured</button>' +
      '</div></div>';
  }

  function placementBoxFor(appId) {
    var host = panel();
    return host ? host.querySelector('.ats-placement-box[data-placement-app-id="' + String(appId).replace(/"/g, '') + '"]') : null;
  }

  // Inline confirm: swap the button for a small "commencement date + confirm" form.
  function openPlacementForm(appId) {
    var box = placementBoxFor(appId);
    if (!box) return;
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<label style="font-size:11px;color:var(--ats-dim);display:flex;align-items:center;gap:6px">Commencement date (optional)' +
          '<input type="date" class="ats-placement-date" style="font-size:12px"></label>' +
        '<button type="button" class="ats-btn ats-btn-primary ats-btn-sm ats-placement-confirm" data-app-id="' + ATS.escAttr(String(appId)) + '">Confirm placement</button>' +
        '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm ats-placement-cancel" data-app-id="' + ATS.escAttr(String(appId)) + '">Cancel</button>' +
      '</div>';
  }

  function closePlacementForm(appId, c) {
    var box = placementBoxFor(appId);
    var app = appFromCurrent(appId);
    if (box) box.innerHTML = app ? '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm ats-mark-placement" data-app-id="' + ATS.escAttr(String(appId)) + '">✅ Mark placement secured</button>' : '';
  }

  function confirmPlacement(appId, c) {
    var box = placementBoxFor(appId);
    if (!box) return;
    var dateEl = box.querySelector('.ats-placement-date');
    var commencementDate = dateEl && dateEl.value ? dateEl.value : '';
    if (!window.confirm('Record this placement as secured? This finalises the doctor\'s placement (the same as them accepting in-app) and notifies them. Continue?')) return;
    var confirmBtn = box.querySelector('.ats-placement-confirm');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Recording…'; }

    // AI Matching (Task 6): a placement fills the job — same redirect confirm
    // as marking a card Hired on the kanban. The count of OTHER live
    // applications on this job comes from the job's pipeline; redirect_others
    // is only added when the dialog was actually shown (OK → true, Cancel →
    // false: the placement still proceeds, just without the fan-out). Skipped
    // entirely (no dialog, no flag) when nobody else is live on the job or
    // the pipeline can't be read.
    var REDIRECT_LIVE_STAGES = ['shortlisted', 'applied', 'submitted', 'reviewing', 'interview'];
    function submitPlacement(redirectOthers) {
      var body = { applicationId: String(appId), commencementDate: commencementDate };
      if (redirectOthers !== undefined) body.redirect_others = redirectOthers;
      ATS.api('/api/ats/placement', { method: 'POST', body: body }).then(function (res) {
        if (res && res.ok) {
          var redirectedNote = (typeof res.redirected === 'number' && res.redirected > 0)
            ? ' · ' + res.redirected + ' other GP(s) redirected' : '';
          ATS.toast('Placement secured — the doctor has been notified.' + redirectedNote);
          if (window.refreshPipelineWidget) window.refreshPipelineWidget();
          window.atsOpenCandidate(c.case_id);
        } else {
          ATS.toast((res && (res.error || res.message)) || 'Could not record the placement.');
          if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm placement'; }
        }
      });
    }

    var app = appFromCurrent(appId);
    var jobId = app && app.job_id;
    if (!jobId) { submitPlacement(); return; }
    ATS.api('/api/ats/job/pipeline?id=' + encodeURIComponent(jobId)).then(function (d) {
      var n = 0;
      var cols = (d && d.ok && Array.isArray(d.columns)) ? d.columns : [];
      cols.forEach(function (col) {
        if (REDIRECT_LIVE_STAGES.indexOf(col.key) === -1) return;
        (col.cards || []).forEach(function (card) {
          if (String(card.id) !== String(appId)) n++;
        });
      });
      if (n <= 0) { submitPlacement(); return; }
      submitPlacement(window.confirm(n + ' other GPs are still active on this job — send them the redirect email?'));
    }).catch(function () { submitPlacement(); });
  }

  function acceptApplicationLineHtml(a) {
    var st = a.practice_submission_status || '';
    var offerStatus = (a.offer && a.offer.status) || 'not_started';
    if (st === 'client_approved' || st === 'interview_ready' || offerStatus === 'accepted') return '';
    return ' <button type="button" class="ats-btn ats-btn-ghost ats-btn-sm ats-accept-application" data-ats="accept-application" data-app-id="' + ATS.escAttr(String(a.id)) + '" style="margin-left:8px">✅ Practice accepted</button>';
  }

  function acceptApplication(appId, c) {
    if (!window.confirm('This reveals the practice\'s real name/address to the GP, records an offer, and emails them to secure an interview. Continue?')) return;
    ATS.api('/api/ats/application/accept?id=' + encodeURIComponent(appId), { method: 'POST' }).then(function (res) {
      if (res && res.ok) {
        ATS.toast(res.already ? 'Already accepted — nothing to change.' : 'Practice acceptance recorded — the GP has been notified.');
        if (window.refreshPipelineWidget) window.refreshPipelineWidget();
        window.atsOpenCandidate(c.case_id);
      } else {
        ATS.toast((res && (res.error || res.message)) || 'Could not record the practice\'s acceptance.');
      }
    });
  }

  // AI Matching (Task 8): one-click Release (waitlist-release pattern) — the
  // GP becomes matchable again immediately (atsBuildGpMatchInputs reads the
  // real career_lock.released_at on its next pool build).
  function releaseCareerLock(c) {
    if (!window.confirm('Release ' + (c.name || 'this GP') + '’s career page? They’ll be matchable and able to apply again immediately.')) return;
    ATS.api('/api/ats/career-lock/release', { method: 'POST', body: { user_id: c.user_id } }).then(function (res) {
      if (res && res.ok) {
        ATS.toast('Career page released — matchable again.');
        window.atsOpenCandidate(c.case_id);
      } else {
        ATS.toast((res && (res.error || res.message)) || 'Could not release the career page.');
      }
    });
  }

  // Optional, independent of Release — recomputes intent fresh (no halving),
  // same math as the CEO's own "Recompute intent" action.
  function restoreCareerLockIntent(c) {
    ATS.api('/api/ats/career-lock/restore-intent', { method: 'POST', body: { user_id: c.user_id } }).then(function (res) {
      if (res && res.ok) {
        ATS.toast('Intent score restored to ' + res.intent_score + '.');
        window.atsOpenCandidate(c.case_id);
      } else {
        ATS.toast((res && (res.error || res.message)) || 'Could not restore the intent score.');
      }
    });
  }

  function submitToPractice(appId, c, btn) {
    if (!window.confirm('Submit this candidate\'s profile to the practice? They\'ll receive an introduction email with the candidate\'s CV.')) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
    ATS.api('/api/admin/career/application/submit-to-practice', { method: 'POST', body: { applicationId: String(appId) } }).then(function (res) {
      if (res && res.ok) {
        ATS.toast('Submitted — the practice has been introduced to this candidate.');
        if (window.refreshPipelineWidget) window.refreshPipelineWidget();
        window.atsOpenCandidate(c.case_id); // reload so the practice line + stage refresh
      } else {
        ATS.toast((res && (res.error || res.message)) || 'Could not submit to the practice.');
        if (btn) { btn.disabled = false; btn.textContent = 'Submit to practice'; }
      }
    });
  }

  /* ---- Offer state + inline send-offer form (Task B) ----
   * Same inline interaction style as the interview slot picker: the offer line
   * lives in a per-application .ats-offer-box and swaps to an inline form. */
  var OFFER_ELIGIBLE_STAGES = ['reviewing', 'interview', 'offer'];
  var OFFER_FILE_MAX_BYTES = 8 * 1024 * 1024; // base64 data URL must stay under the server's 12MB JSON body cap

  function fmtOfferDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch (ex) { return String(iso); }
  }

  // The offer line for one application: none → Send offer (eligible stages),
  // sent → "Offer sent <date>" + subtle Withdraw, accepted → celebration.
  // A7b: a "View contract" link whenever a contract was stored against the offer.
  function offerContractLinkHtml(a) {
    if (!a.offer || !a.offer.has_contract) return '';
    return '<button type="button" class="ats-offer-contract" data-app-id="' + ATS.escAttr(String(a.id)) + '"' +
      ' style="background:none;border:none;padding:0;margin-left:10px;color:var(--ats-blue);font-size:11.5px;text-decoration:underline;cursor:pointer">View contract</button>';
  }

  function offerLineHtml(a) {
    var offer = a.offer || {};
    var status = offer.status || 'not_started';
    if (status === 'accepted') {
      return '<span style="color:var(--ats-green);font-weight:600">Offer accepted 🎉</span>' + offerContractLinkHtml(a);
    }
    if (status === 'sent') {
      return '<span>Offer sent' + (offer.sent_at ? ' ' + ATS.esc(fmtOfferDate(offer.sent_at)) : '') + '</span>' +
        offerContractLinkHtml(a) +
        '<button type="button" class="ats-offer-withdraw" data-app-id="' + ATS.escAttr(String(a.id)) + '"' +
          ' style="background:none;border:none;padding:0;margin-left:10px;color:var(--ats-dim);font-size:11.5px;text-decoration:underline;cursor:pointer">Withdraw</button>';
    }
    var canSend = OFFER_ELIGIBLE_STAGES.indexOf(a.ats_stage) !== -1;
    // A declined offer needs a clear "action needed" cue right next to the
    // re-send affordance (GAP A5); a withdrawn offer is a quiet dim note.
    var priorNote = '';
    if (status === 'declined') {
      priorNote = '<span class="ats-pill amber" data-offer-declined="1" style="margin-right:10px">Declined — action needed</span>';
    } else if (status === 'withdrawn') {
      priorNote = '<span style="color:var(--ats-dim);margin-right:10px">' + ATS.esc(offer.label || '') + '</span>';
    }
    if (!canSend) return priorNote || '<span>' + ATS.esc(offer.label || '—') + '</span>';
    return priorNote +
      '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm ats-offer-send" data-app-id="' + ATS.escAttr(String(a.id)) + '">Send offer</button>';
  }

  function offerFormHtml(appId) {
    var lbl = 'display:grid;gap:3px;font-size:11px;color:var(--ats-dim)';
    return '<div class="ats-offer-form" data-offer-form-id="' + ATS.escAttr(String(appId)) + '"' +
        ' style="display:grid;gap:9px;margin-top:6px;padding:12px;border:1px solid rgba(255,255,255,0.09);border-radius:10px">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">' +
        '<label style="' + lbl + '">Billing split<input type="text" class="of-billing" placeholder="e.g. 70 / 30"></label>' +
        '<label style="' + lbl + '">Sessions / week<input type="text" class="of-sessions" placeholder="e.g. 8"></label>' +
        '<label style="' + lbl + '">Compensation range<input type="text" class="of-comp" placeholder="e.g. $350k+ estimated"></label>' +
        '<label style="' + lbl + '">Start date<input type="date" class="of-start"></label>' +
      '</div>' +
      '<label style="' + lbl + '">Notes for the doctor<textarea class="of-notes" placeholder="Anything the doctor should know about these terms…" style="min-height:56px;resize:vertical"></textarea></label>' +
      '<label style="' + lbl + '">Contract (optional, up to 8 MB)<input type="file" class="of-contract" accept=".pdf,.doc,.docx,application/pdf"></label>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end">' +
        '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm ats-offer-cancel" data-app-id="' + ATS.escAttr(String(appId)) + '">Cancel</button>' +
        '<button type="button" class="ats-btn ats-btn-primary ats-btn-sm ats-offer-submit" data-app-id="' + ATS.escAttr(String(appId)) + '">Send offer</button>' +
      '</div>' +
    '</div>';
  }

  function offerBoxFor(appId) {
    var host = panel();
    return host ? host.querySelector('.ats-offer-box[data-offer-app-id="' + String(appId).replace(/"/g, '') + '"]') : null;
  }

  function appFromCurrent(appId) {
    var apps = (currentCandidate && currentCandidate.apps) || [];
    return apps.find(function (x) { return String(x.id) === String(appId); }) || null;
  }

  function openOfferForm(appId) {
    var box = offerBoxFor(appId);
    if (box) box.innerHTML = offerFormHtml(appId);
  }

  function closeOfferForm(appId) {
    var box = offerBoxFor(appId);
    var app = appFromCurrent(appId);
    if (box) box.innerHTML = app ? offerLineHtml(app) : '—';
  }

  function submitOffer(appId, c) {
    var box = offerBoxFor(appId);
    if (!box) return;
    var form = box.querySelector('.ats-offer-form');
    if (!form) return;
    var val = function (sel) { var el = form.querySelector(sel); return el ? el.value : ''; };
    var body = {
      application_id: String(appId),
      billing_split: val('.of-billing'),
      sessions_per_week: val('.of-sessions'),
      compensation_range: val('.of-comp'),
      start_date: val('.of-start'),
      notes: val('.of-notes')
    };
    var submitBtn = form.querySelector('.ats-offer-submit');
    var fileInput = form.querySelector('.of-contract');
    var file = fileInput && fileInput.files && fileInput.files[0];

    function post() {
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending…'; }
      ATS.api('/api/ats/offer', { method: 'POST', body: body }).then(function (res) {
        if (res && res.ok) {
          ATS.toast('Offer sent — the doctor has been notified.');
          if (window.refreshPipelineWidget) window.refreshPipelineWidget();
          window.atsOpenCandidate(c.case_id); // reload so the offer state + stage pill refresh
        } else {
          ATS.toast((res && (res.error || res.message)) || 'Could not send the offer.');
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Send offer'; }
        }
      });
    }

    if (file) {
      if (file.size > OFFER_FILE_MAX_BYTES) {
        ATS.toast('That contract is too large — please attach a file under 8 MB.');
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        body.contract_data_url = String(reader.result || '');
        body.contract_file_name = file.name || '';
        post();
      };
      reader.onerror = function () { ATS.toast('Could not read the contract file.'); };
      reader.readAsDataURL(file);
    } else {
      post();
    }
  }

  function withdrawOffer(appId, c) {
    if (!window.confirm('Withdraw this offer? The doctor won\'t be notified — the card quietly moves back to Reviewing.')) return;
    ATS.api('/api/ats/offer', { method: 'PATCH', body: { application_id: String(appId), action: 'withdraw' } }).then(function (res) {
      if (res && res.ok) {
        ATS.toast('Offer withdrawn.');
        if (window.refreshPipelineWidget) window.refreshPipelineWidget();
        window.atsOpenCandidate(c.case_id);
      } else {
        ATS.toast((res && (res.error || res.message)) || 'Could not withdraw the offer.');
      }
    });
  }

  // Expose globally so GP-facing pages can reuse the slot picker.
  // applicationId  — the gp_applications.id (or ATS application id)
  // containerEl    — the DOM element to fill with the slot UI
  // caseId         — (optional) used to refresh the candidate detail after booking
  window.atsRenderSlotPicker = function (applicationId, containerEl, caseId) {
    if (!containerEl) return;
    containerEl.innerHTML = '<span style="font-size:12px;color:var(--ats-dim)">Loading available slots…</span>';
    ATS.api('/api/ats/interview/slots?application_id=' + encodeURIComponent(applicationId)).then(function (res) {
      if (!res || res.ok === false) {
        containerEl.innerHTML = '<span style="font-size:12px;color:var(--ats-red)">Could not load slots.</span>';
        return;
      }
      if (res.status === 'requested') {
        // GAP A1: unstick a practice that never replied. Operators can paste the
        // practice's emailed availability, or force GP Link's standard times.
        containerEl.innerHTML =
          '<div class="ats-app-interview-pending">Waiting for the practice to share their availability.</div>' +
          '<div class="ats-slot-actions" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
            '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm ats-int-paste-reply" data-app-id="' + ATS.escAttr(String(applicationId)) + '">Paste practice reply</button>' +
            '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm ats-int-use-default" data-app-id="' + ATS.escAttr(String(applicationId)) + '">Use standard times</button>' +
          '</div>';
        var pasteBtn = containerEl.querySelector('.ats-int-paste-reply');
        if (pasteBtn) pasteBtn.addEventListener('click', function () { atsPastePracticeReply(applicationId, containerEl, caseId); });
        var defBtn = containerEl.querySelector('.ats-int-use-default');
        if (defBtn) defBtn.addEventListener('click', function () {
          defBtn.disabled = true; defBtn.textContent = 'Applying…';
          ATS.api('/api/ats/interview/use-default-times', { method: 'POST', body: { applicationId: String(applicationId) } }).then(function (r) {
            if (r && r.ok) {
              ATS.toast('Standard times applied — pick a slot below.');
              window.atsRenderSlotPicker(applicationId, containerEl, caseId);
            } else {
              ATS.toast((r && (r.error || r.message)) || 'Could not apply standard times.');
              defBtn.disabled = false; defBtn.textContent = 'Use standard times';
            }
          });
        });
        return;
      }
      var slots = res.slots || [];
      if (!slots.length) {
        // Belt-and-braces escape hatch (folded T3): even when the practice's
        // windows produced no overlap, the operator can force GP Link's standard
        // evening/weekend times so a slot can still be booked.
        containerEl.innerHTML =
          '<span class="ats-app-interview-pending">No mutually available times in the next 2 weeks — we\'ll widen the search.</span>' +
          '<div class="ats-slot-actions" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
            '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm ats-int-use-default" data-app-id="' + ATS.escAttr(String(applicationId)) + '">Use standard times</button>' +
          '</div>';
        var emptyDefBtn = containerEl.querySelector('.ats-int-use-default');
        if (emptyDefBtn) emptyDefBtn.addEventListener('click', function () {
          emptyDefBtn.disabled = true; emptyDefBtn.textContent = 'Applying…';
          ATS.api('/api/ats/interview/use-default-times', { method: 'POST', body: { applicationId: String(applicationId) } }).then(function (r) {
            if (r && r.ok) {
              ATS.toast('Standard times applied — pick a slot below.');
              window.atsRenderSlotPicker(applicationId, containerEl, caseId);
            } else {
              ATS.toast((r && (r.error || r.message)) || 'Could not apply standard times.');
              emptyDefBtn.disabled = false; emptyDefBtn.textContent = 'Use standard times';
            }
          });
        });
        return;
      }
      var html = '<div class="ats-slot-grid">' + slots.map(function (slot) {
        var gp = (slot.local && slot.local.gp) || {};
        var label = gp.label || slot.startUtc || '';
        return '<button type="button" class="ats-slot" data-slot-utc="' + ATS.escAttr(slot.startUtc || '') + '" data-gp-label="' + ATS.escAttr(label) + '">' +
          ATS.esc(label) + '<span class="ats-slot-note">(your local time)</span>' +
        '</button>';
      }).join('') + '</div>';
      containerEl.innerHTML = html;
      containerEl.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.ats-slot') : null;
        if (!btn || btn.disabled) return;
        var slotUtc = btn.getAttribute('data-slot-utc');
        var gpLabel = btn.getAttribute('data-gp-label');
        if (!slotUtc) return;
        btn.disabled = true;
        btn.textContent = 'Booking…';
        ATS.api('/api/ats/interview/book', { method: 'POST', body: { application_id: applicationId, slot_start_utc: slotUtc } }).then(function (r) {
          if (r && r.ok) {
            ATS.toast('Interview booked for ' + gpLabel);
            if (caseId) window.atsOpenCandidate(caseId);
          } else {
            // AI Matching (Task 7): prefer the human message over a raw error
            // code — interview_cap's 409 carries both an `error` code AND a
            // friendly `message` ("This GP has used all 3 interviews this
            // month (resets …)"); showing `error` first would toast the bare
            // code string instead.
            ATS.toast((r && (r.message || r.error)) || 'Could not book the interview.');
            btn.disabled = false;
            btn.innerHTML = ATS.esc(gpLabel) + '<span class="ats-slot-note">(your local time)</span>';
          }
        });
      });
    });
  };

  // GAP A1: paste the practice's emailed availability → /api/ats/interview/ingest-reply.
  // Exposed on window so the same flow can be reused from other ATS surfaces.
  window.atsPastePracticeReply = function (applicationId, containerEl, caseId) {
    ATS.setOverlay(
      '<div class="ats-modal-wrap open" id="ats-paste-wrap">' +
        '<div class="ats-modal">' +
          '<div class="ats-modal-head"><h3>Paste the practice\'s reply</h3><button class="ats-drawer-close" id="ats-paste-close">×</button></div>' +
          '<div class="ats-modal-body">' +
            '<label>Practice availability email</label>' +
            '<textarea id="ats-paste-text" placeholder="Paste the times the practice sent, e.g. “Tuesday and Thursday evenings after 6pm, or Saturday morning”" style="min-height:120px;resize:vertical"></textarea>' +
            '<p style="font-size:11.5px;color:var(--ats-dim);margin-top:10px">We read the times from the email and turn them into bookable slots.</p>' +
          '</div>' +
          '<div class="ats-modal-foot">' +
            '<button class="ats-btn ats-btn-ghost" id="ats-paste-cancel">Cancel</button>' +
            '<button class="ats-btn ats-btn-primary" id="ats-paste-submit">Read availability</button>' +
          '</div>' +
        '</div>' +
      '</div>');
    var root = document.getElementById('atsOverlayRoot');
    if (!root) return;
    function close() { ATS.setOverlay(''); }
    var closeBtn = root.querySelector('#ats-paste-close');
    var cancelBtn = root.querySelector('#ats-paste-cancel');
    var wrap = root.querySelector('#ats-paste-wrap');
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (cancelBtn) cancelBtn.addEventListener('click', close);
    if (wrap) wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    var submit = root.querySelector('#ats-paste-submit');
    if (submit) submit.addEventListener('click', function () {
      var text = (root.querySelector('#ats-paste-text') || {}).value || '';
      if (!text.trim()) { ATS.toast('Paste the practice\'s reply first.'); return; }
      submit.disabled = true; submit.textContent = 'Reading…';
      ATS.api('/api/ats/interview/ingest-reply', { method: 'POST', body: { application_id: String(applicationId), reply_text: text } }).then(function (r) {
        if (r && r.ok) {
          close();
          if (r.status === 'received' && r.windows_count) {
            ATS.toast('Availability read — ' + r.windows_count + ' window' + (r.windows_count === 1 ? '' : 's') + ' found.');
          } else {
            // Folded T3: the parser found no usable times — the card stays on
            // 'requested' so its actions remain. Point the operator at the
            // standard-times escape hatch.
            ATS.toast('We couldn\'t read any interview times from that reply — try "Use standard times" instead.');
          }
          if (containerEl) window.atsRenderSlotPicker(applicationId, containerEl, caseId);
          else if (caseId) window.atsOpenCandidate(caseId);
        } else {
          ATS.toast((r && (r.error || r.message)) || 'Could not read the reply.');
          submit.disabled = false; submit.textContent = 'Read availability';
        }
      });
    });
  };

  // GAP A2: cancel a booked interview and re-open the slot picker (cancel & rebook).
  function cancelInterview(appId, c) {
    if (!appId) return;
    if (!window.confirm('Cancel this booked interview? The doctor and practice will be told, and you\'ll be able to book a new time straight away.')) return;
    ATS.api('/api/ats/interview/cancel', { method: 'POST', body: { applicationId: String(appId) } }).then(function (res) {
      if (res && res.ok) {
        ATS.toast('Interview cancelled — pick a new time to rebook.');
        if (window.refreshPipelineWidget) window.refreshPipelineWidget();
        if (c && c.case_id) window.atsOpenCandidate(c.case_id);
      } else {
        ATS.toast((res && (res.error || res.message)) || 'Could not cancel the interview.');
      }
    });
  }

  function onboardingCardInner(c) {
    var ob = c.onboarding || {};
    var pill = ob.completed
      ? '<span class="ats-pill green" style="margin-left:auto">Complete</span>'
      : '<span class="ats-pill amber" style="margin-left:auto">' + Math.round((ob.fieldsFilled || 0) * 100) + '% complete</span>';
    return '<div class="ats-card-title"><span class="ats-dot" style="background:var(--ats-amber)"></span> Onboarding information ' + pill + '</div>' +
      '<div class="ats-metric-grid" style="grid-template-columns:1fr 1fr">' +
        field('Qualification country', ATS.esc(ob.qualCountry || '—')) +
        field('Specialty', ATS.esc(ob.specialty || '—')) +
        field('Target arrival', ATS.esc(ob.target || '—')) +
        field('Preferred city', ATS.esc(ob.city || '—')) +
        field("Family / who's moving", ATS.esc(ob.family || '—')) +
        '<div class="ats-detail-field"><div class="df-lbl">Identity verified</div><div class="df-val">' +
          (ob.idVerified ? '<span class="ats-pill green">Yes</span>' : '<span class="ats-pill amber">Pending</span>') + '</div></div>' +
      '</div>';
  }

  function docsCardInner(c) {
    var docs = c.docs || {};
    var docDef = [
      { k: 'cv', name: 'CV / Résumé', sub: 'Signed &amp; dated' },
      { k: 'coverLetter', name: 'Cover letter', sub: 'Tailored to role' },
      { k: 'primaryDegree', name: 'Primary medical degree', sub: 'Certified copy' },
      { k: 'idDoc', name: 'Identity document', sub: 'Passport / photo ID' }
    ];
    return '<div class="ats-card-title"><span class="ats-dot" style="background:var(--ats-purple)"></span> Documents on file</div>' +
      docDef.map(function (d) {
        var has = !!docs[d.k];
        // A6: the CV is the one document consultants can actually open (the RSO
        // file is hidden from them). When present it becomes a "View CV" link;
        // ID/passport stays a plain uploaded/not-uploaded pill (never exposed).
        var right;
        if (d.k === 'cv' && has) {
          right = '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm ats-cv-view" data-case-id="' + ATS.escAttr(String(c.case_id || '')) + '" data-user-id="' + ATS.escAttr(String(c.user_id || '')) + '">View CV</button>';
        } else {
          right = has ? '<span class="ats-pill green">Uploaded</span>' : '<span class="ats-pill muted">Not uploaded</span>';
        }
        return '<div class="ats-doc-line">' +
          '<div class="ats-doc-ico ' + (has ? 'yes' : 'no') + '">' + (has ? '✓' : '○') + '</div>' +
          '<div style="flex:1"><div class="dl-name">' + d.name + '</div><div class="dl-sub">' + d.sub + '</div></div>' +
          right +
        '</div>';
      }).join('');
  }

  // A6/A7b: fetch a short-lived signed URL then open it in a new tab. A popup
  // opened synchronously before the fetch keeps the browser from blocking it.
  function openSignedDoc(apiPath, btn, failMsg) {
    var win = window.open('', '_blank');
    if (btn) { btn.disabled = true; }
    var restore = function () { if (btn) btn.disabled = false; };
    ATS.api(apiPath).then(function (res) {
      if (res && res.ok && res.url) {
        if (win) { win.location = res.url; } else { window.open(res.url, '_blank'); }
      } else {
        if (win) win.close();
        ATS.toast((res && (res.error || res.message)) || failMsg);
      }
      restore();
    }).catch(function () { if (win) win.close(); ATS.toast(failMsg); restore(); });
  }

  function viewCandidateCv(btn) {
    var caseId = btn.getAttribute('data-case-id') || '';
    var userId = btn.getAttribute('data-user-id') || '';
    var q = caseId ? ('case_id=' + encodeURIComponent(caseId)) : ('user_id=' + encodeURIComponent(userId));
    openSignedDoc('/api/ats/candidate-cv?' + q, btn, 'Could not open the CV.');
  }

  function viewOfferContract(appId, btn) {
    openSignedDoc('/api/ats/offer-contract?application_id=' + encodeURIComponent(appId), btn, 'Could not open the contract.');
  }

  function commsCardInner(c) {
    var cm = c.comms;
    var banner = '<div class="ats-ai-banner">' + SVG_CHAT +
      ' AI reads your real WhatsApp and email threads with this doctor to gauge how often they engage, how fast they reply, and their tone.</div>';
    if (!cm) {
      return '<div class="ats-card-title"><span class="ats-dot" style="background:var(--ats-green)"></span> Communication &amp; engagement (AI)' +
          '<span class="ats-pill muted" style="margin-left:auto">No data</span></div>' +
        banner +
        '<div class="ats-empty">No comms data yet.</div>' +
        '<button class="ats-btn ats-btn-sm" id="ats-comms-scan" style="margin-top:12px">Run AI comms scan</button>';
    }
    var tone = cm.tone || 'No data';
    var avg = (typeof cm.avgReplyHrs === 'number') ? (cm.avgReplyHrs + 'h') : '—';
    var engVal = cm.engagementVal || 0;
    var eng = Math.round(engVal * 100);
    var engColor = engVal >= 0.7 ? 'var(--ats-green)' : engVal >= 0.4 ? 'var(--ats-amber)' : 'var(--ats-muted)';
    return '<div class="ats-card-title"><span class="ats-dot" style="background:var(--ats-green)"></span> Communication &amp; engagement (AI)' +
        '<span class="ats-pill ' + toneClass(tone) + '" style="margin-left:auto">' + ATS.esc(tone) + '</span></div>' +
      banner +
      '<div class="ats-metric-grid" style="grid-template-columns:repeat(3,1fr)">' +
        metric(cm.messages30d != null ? cm.messages30d : '—', 'Messages / 30d') +
        metric(avg, 'Avg reply time') +
        '<div class="ats-metric"><div class="m-val" style="color:' + engColor + '">' + eng + '</div><div class="m-lbl">Engagement / 100</div></div>' +
      '</div>' +
      '<div class="ats-ai-call" style="margin-top:12px"><div class="ats-ac-head"><div class="ac-when">AI tone &amp; engagement read</div>' +
        '<span class="ats-ai-badge">✦ AI ANALYSIS</span></div>' +
        '<div class="ats-ac-sum">' + ATS.esc(cm.aiRead || '') + '</div></div>';
  }

  function callsCardInner(c) {
    var calls = c.calls || [];
    var banner = '<div class="ats-ai-banner">' + SVG_ZOOM +
      " Zoom calls are summarised automatically by Zoom's AI once the call ends — no manual notes.</div>";
    var body = calls.length ? calls.map(function (call) {
      if (call.status === 'upcoming') {
        return '<div class="ats-ai-call upcoming"><div class="ats-ac-head"><div>' +
          '<div class="ac-when">' + ATS.esc(call.when || '') + '</div><div class="ac-type">' + ATS.esc(call.type || '') + '</div></div>' +
          '<span class="ats-pill blue">Upcoming</span></div>' +
          '<div class="ats-ac-sum">Scheduled — the summary will appear automatically after the call.</div></div>';
      }
      var tag = call.status === 'no_show'
        ? '<span class="ats-pill amber">No-show</span>'
        : '<span class="ats-ai-badge">✦ AI SUMMARY</span>';
      var actions = (call.actions && call.actions.length)
        ? '<div class="ats-ac-actions"><div class="aca-lbl">AI-extracted action items</div><ul>' +
            call.actions.map(function (a) { return '<li>' + ATS.esc(a) + '</li>'; }).join('') + '</ul></div>'
        : '';
      return '<div class="ats-ai-call"><div class="ats-ac-head"><div>' +
        '<div class="ac-when">' + ATS.esc(call.when || '') + '</div><div class="ac-type">' + ATS.esc(call.type || '') + '</div></div>' + tag + '</div>' +
        '<div class="ats-ac-sum">' + ATS.esc(call.summary || '') + '</div>' + actions + '</div>';
    }).join('') : '<div class="ats-empty">No calls recorded yet.</div>';
    return '<div class="ats-card-title"><span class="ats-dot" style="background:var(--ats-purple)"></span> Zoom call summaries</div>' +
      banner + body;
  }

  function handoverCardInner(c) {
    var h = c.ai_handover;
    var inner;
    if (h && typeof h === 'object') {
      var parts = [];
      if (h.overview) parts.push('<div>' + ATS.esc(h.overview) + '</div>');
      if (h.action_items && h.action_items.length) {
        parts.push('<div class="ats-ac-actions" style="border-top:none;padding-top:0;margin-top:10px"><div class="aca-lbl">Action items</div><ul>' +
          h.action_items.map(function (a) { return '<li>' + ATS.esc(a) + '</li>'; }).join('') + '</ul></div>');
      }
      if (h.concerns) {
        var concerns = Array.isArray(h.concerns)
          ? h.concerns.map(function (x) { return ATS.esc(x); }).join('; ')
          : ATS.esc(h.concerns);
        parts.push('<div style="margin-top:10px;color:var(--ats-amber)">' + concerns + '</div>');
      }
      inner = parts.join('') || '—';
    } else {
      inner = ATS.esc(h || '—');
    }
    return '<div class="ats-card-title"><span class="ats-dot" style="background:var(--ats-blue)"></span> AI handover summary</div>' +
      '<div class="ats-handover-box">' + inner + '</div>';
  }

  // AI Matching (Task 8): "Interviews & strikes" panel (mockup v11) — only
  // ever rendered when c.career_lock is present (this GP has been locked at
  // least once). Chips CAREER LOCKED / STRIKES n/3, one row per strike
  // (practice · location · date · DID NOT PROCEED + the GP's own reason, or
  // "Not provided yet"), the pre→post intent line, answers status, and the
  // Release / Restore-intent actions.
  function strikesCardInner(c) {
    var lock = c.career_lock || {};
    var strikes = lock.strikes || [];
    var lockedChip = lock.locked
      ? '<span class="ats-pill red">CAREER LOCKED</span>'
      : '<span class="ats-pill muted">Released</span>';
    var strikeChip = '<span class="ats-pill amber">STRIKES ' + strikes.length + '/3</span>';

    var rows = strikes.length ? strikes.map(function (s) {
      var when = s.interviewedAt ? new Date(s.interviewedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
      var metaBits = [s.practiceName || 'Unknown practice', s.location || '', when].filter(Boolean);
      var reasonHtml = s.reason
        ? '<div style="font-size:12.5px;color:var(--ats-text,#0f172a);margin-top:6px">' + ATS.esc(s.reason) + '</div>'
        : '<div style="font-size:12.5px;color:var(--ats-dim,#94a3b8);font-style:italic;margin-top:6px">Not provided yet</div>';
      return '<div style="border:1px solid var(--ats-border,#e2e8f0);border-radius:10px;padding:10px 12px;margin-bottom:8px">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">' +
          '<span style="font-size:13px;font-weight:600">' + ATS.esc(metaBits.join(' · ')) + '</span>' +
          '<span class="ats-pill red" style="font-size:10px;white-space:nowrap">DID NOT PROCEED</span>' +
        '</div>' + reasonHtml +
      '</div>';
    }).join('') : '<div class="ats-empty">No strikes recorded.</div>';

    var intentLine = (lock.pre_lock_intent_score != null)
      ? '<div style="font-size:13px;margin:10px 0"><b>' + ATS.esc(String(lock.pre_lock_intent_score)) + ' → ' + ATS.esc(String((c.intent && c.intent.score != null) ? c.intent.score : '—')) + '</b> <span style="color:var(--ats-dim,#64748b)">(−50% on lock)</span></div>'
      : '';

    var answersLine = '<div style="font-size:12px;color:var(--ats-dim,#64748b);margin-bottom:4px">' +
      (lock.answers_submitted_at ? '✓ All three answers submitted' : 'Answers not yet complete') +
      '</div>';
    var callLine = '<div style="font-size:12px;color:var(--ats-dim,#64748b);margin-bottom:10px">' +
      (lock.call_booked_at ? '✓ Call booked' : 'Call not yet booked') +
      '</div>';

    var actions = '<div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">' +
      (lock.locked ? '<button type="button" class="ats-btn ats-btn-primary ats-btn-sm" id="ats-lock-release">Release career page</button>' : '') +
      '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" id="ats-lock-restore-intent">Restore intent score</button>' +
    '</div>';

    return '<div class="ats-card-title"><span class="ats-dot" style="background:var(--ats-red)"></span> Interviews &amp; strikes ' + lockedChip + ' ' + strikeChip + '</div>' +
      rows + intentLine + answersLine + callLine + actions;
  }

  function wireDetailEvents(host, c) {
    var back = host.querySelector('#ats-cand-back');
    if (back) back.addEventListener('click', function () { window.loadCandidatesTab(); });
    var rso = host.querySelector('#ats-cand-rsofile');
    if (rso) rso.addEventListener('click', function () {
      window.open('/pages/admin?gp=' + encodeURIComponent(c.user_id || ''), '_blank');
    });
    var sched = host.querySelector('#ats-cand-schedule');
    if (sched) sched.addEventListener('click', function () { openScheduleModal(c); });
    // delegated click: comms-scan + add-to-job + offer buttons (all may be re-rendered).
    host.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      if (e.target.closest('#ats-comms-scan')) { runCommsScan(c.case_id); return; }
      if (e.target.closest('#ats-add-job')) { openAddJobModal(c); return; }
      var submitPracticeBtn = e.target.closest('.ats-submit-practice');
      if (submitPracticeBtn) { submitToPractice(submitPracticeBtn.getAttribute('data-app-id'), c, submitPracticeBtn); return; }
      var sendBtn = e.target.closest('.ats-offer-send');
      if (sendBtn) { openOfferForm(sendBtn.getAttribute('data-app-id')); return; }
      var cancelBtn = e.target.closest('.ats-offer-cancel');
      if (cancelBtn) { closeOfferForm(cancelBtn.getAttribute('data-app-id')); return; }
      var submitBtn = e.target.closest('.ats-offer-submit');
      if (submitBtn) { submitOffer(submitBtn.getAttribute('data-app-id'), c); return; }
      var withdrawBtn = e.target.closest('.ats-offer-withdraw');
      if (withdrawBtn) { withdrawOffer(withdrawBtn.getAttribute('data-app-id'), c); return; }
      var acceptBtn = e.target.closest('.ats-accept-application');
      if (acceptBtn) { acceptApplication(acceptBtn.getAttribute('data-app-id'), c); return; }
      var intCancelBtn = e.target.closest('.ats-int-cancel');
      if (intCancelBtn) { cancelInterview(intCancelBtn.getAttribute('data-app-id'), c); return; }
      // A6: open the candidate's CV (consultant-accessible).
      var cvBtn = e.target.closest('.ats-cv-view');
      if (cvBtn) { viewCandidateCv(cvBtn); return; }
      // A7b: open the offer's stored contract.
      var ocBtn = e.target.closest('.ats-offer-contract');
      if (ocBtn) { viewOfferContract(ocBtn.getAttribute('data-app-id'), ocBtn); return; }
      // A8a: mark placement secured (verbal acceptance) — inline confirm.
      var markPlBtn = e.target.closest('.ats-mark-placement');
      if (markPlBtn) { openPlacementForm(markPlBtn.getAttribute('data-app-id')); return; }
      var plConfirmBtn = e.target.closest('.ats-placement-confirm');
      if (plConfirmBtn) { confirmPlacement(plConfirmBtn.getAttribute('data-app-id'), c); return; }
      var plCancelBtn = e.target.closest('.ats-placement-cancel');
      if (plCancelBtn) { closePlacementForm(plCancelBtn.getAttribute('data-app-id'), c); return; }
      // AI Matching (Task 8): career-lock release / restore-intent.
      if (e.target.closest('#ats-lock-release')) { releaseCareerLock(c); return; }
      if (e.target.closest('#ats-lock-restore-intent')) { restoreCareerLockIntent(c); return; }
    });
    // Render slot pickers for any application that is awaiting a GP slot pick.
    var pickEls = host.querySelectorAll('.ats-app-slot-pick[data-slot-pick-id]');
    for (var pi = 0; pi < pickEls.length; pi++) {
      (function (el) {
        var appId = el.getAttribute('data-slot-pick-id');
        window.atsRenderSlotPicker(appId, el, c.case_id);
      })(pickEls[pi]);
    }
    // delegated change: a per-application stage <select> moves the GP along the pipeline.
    function commitAppStageMove(sel, appId, newStage, reason) {
      sel.disabled = true;
      var body = { stage: newStage };
      if (reason) body.reason = reason;
      ATS.api('/api/ats/application?id=' + encodeURIComponent(appId), { method: 'PATCH', body: body }).then(function (res) {
        if (res && res.ok) ATS.toast('Moved to ' + stageOptLabel(newStage));
        else ATS.toast((res && (res.error || res.message)) || 'Could not update the stage.');
        if (window.refreshPipelineWidget) window.refreshPipelineWidget();
        window.atsOpenCandidate(c.case_id); // reload to refresh the pill/score (or revert on failure)
      });
    }
    host.addEventListener('change', function (e) {
      var sel = e.target.closest ? e.target.closest('.ats-app-stage') : null;
      if (!sel) return;
      var appId = sel.getAttribute('data-app-id');
      if (!appId) return;
      var newStage = sel.value;
      var stageWas = sel.getAttribute('data-stage-was') || '';
      // AI Matching (Task 7 review fix): moving to not_proceeding from
      // submitted or later prompts for the withdraw reason (same flow as the
      // Jobs board); Cancel reverts the select and never PATCHes.
      if (newStage === 'not_proceeding' && stageNeedsWithdrawReason(stageWas)) {
        openWithdrawReasonPrompt(function (reason) {
          commitAppStageMove(sel, appId, newStage, reason);
        }, function () {
          sel.value = stageWas;
        });
        return;
      }
      commitAppStageMove(sel, appId, newStage, null);
    });
  }

  function runCommsScan(caseId) {
    var box = document.getElementById('ats-cand-comms');
    if (box) box.innerHTML = ATS.loadingHtml('Scanning messages…');
    ATS.api('/api/ceo/candidate/comms-scan?case_id=' + encodeURIComponent(caseId), { method: 'POST' }).then(function (res) {
      ATS.api('/api/ceo/candidate?case_id=' + encodeURIComponent(caseId)).then(function (d) {
        var b = document.getElementById('ats-cand-comms');
        if (!b) return;
        if (d && d.ok && d.candidate) {
          currentCandidate = d.candidate;
          b.innerHTML = commsCardInner(d.candidate);
        } else {
          b.innerHTML = commsCardInner(currentCandidate || {});
        }
        if (res && res.message) ATS.toast(res.message);
        else if (res && res.ok) ATS.toast('Comms scan complete.');
        else ATS.toast('Could not run the comms scan.');
      });
    });
  }

  /* =====================================================================
   *  SCHEDULE-CALL MODAL
   * ===================================================================== */
  function scheduleModalHtml() {
    var stageOpts = [['myintealth', 'MyIntealth'], ['amc', 'AMC'], ['ahpra', 'AHPRA']]
      .map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('');
    return '<div class="ats-modal-wrap open" id="ats-sched-wrap">' +
      '<div class="ats-modal">' +
        '<div class="ats-modal-head"><h3>Schedule a call</h3><button class="ats-drawer-close" id="ats-sched-close">×</button></div>' +
        '<div class="ats-modal-body">' +
          '<label>Reason for the call</label>' +
          '<textarea id="ats-sched-reason" placeholder="What is this call about?" style="min-height:80px;resize:vertical"></textarea>' +
          '<label>Registration stage</label>' +
          '<select id="ats-sched-stage">' + stageOpts + '</select>' +
          '<p style="font-size:11.5px;color:var(--ats-dim);margin-top:10px">Sends the doctor a booking link.</p>' +
        '</div>' +
        '<div class="ats-modal-foot">' +
          '<button class="ats-btn ats-btn-ghost" id="ats-sched-cancel">Cancel</button>' +
          '<button class="ats-btn ats-btn-primary" id="ats-sched-send">Send booking link</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function openScheduleModal(c) {
    ATS.setOverlay(scheduleModalHtml());
    var root = document.getElementById('atsOverlayRoot');
    if (!root) return;
    function close() { ATS.setOverlay(''); }
    var closeBtn = root.querySelector('#ats-sched-close');
    var cancelBtn = root.querySelector('#ats-sched-cancel');
    var wrap = root.querySelector('#ats-sched-wrap');
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (cancelBtn) cancelBtn.addEventListener('click', close);
    if (wrap) wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    var sendBtn = root.querySelector('#ats-sched-send');
    if (sendBtn) sendBtn.addEventListener('click', function () {
      var reason = (root.querySelector('#ats-sched-reason') || {}).value || '';
      var stage = (root.querySelector('#ats-sched-stage') || {}).value || '';
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      ATS.api('/api/admin/calls/schedule', {
        method: 'POST',
        body: { case_id: c.case_id, stage: stage, meeting_reason: reason, notify_email: true }
      }).then(function (res) {
        close();
        if (res && res.message) ATS.toast(res.message);
        else if (res && res.ok) ATS.toast('Booking link sent.');
        else ATS.toast((res && (res.error || res.message)) || 'Could not schedule the call.');
      });
    });
  }

  /* =====================================================================
   *  ADD-TO-JOB MODAL  (Unassociated -> Applied)
   * ===================================================================== */
  function addJobModalHtml() {
    return '<div class="ats-modal-wrap open" id="ats-addjob-wrap">' +
      '<div class="ats-modal">' +
        '<div class="ats-modal-head"><h3>Add to a job</h3><button class="ats-drawer-close" id="ats-addjob-close">×</button></div>' +
        '<div class="ats-modal-body">' +
          '<label>Open job</label>' +
          '<select id="ats-addjob-select"><option value="">Loading open jobs…</option></select>' +
          '<p style="font-size:11.5px;color:var(--ats-dim);margin-top:10px">Creates an application and moves this GP into the job pipeline.</p>' +
        '</div>' +
        '<div class="ats-modal-foot">' +
          '<button class="ats-btn ats-btn-ghost" id="ats-addjob-cancel">Cancel</button>' +
          '<button class="ats-btn ats-btn-primary" id="ats-addjob-confirm">Add to job</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function openAddJobModal(c) {
    if (!c || !c.user_id) { ATS.toast('Missing candidate id'); return; }
    ATS.setOverlay(addJobModalHtml());
    var root = document.getElementById('atsOverlayRoot');
    if (!root) return;
    function close() { ATS.setOverlay(''); }
    var closeBtn = root.querySelector('#ats-addjob-close');
    var cancelBtn = root.querySelector('#ats-addjob-cancel');
    var wrap = root.querySelector('#ats-addjob-wrap');
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (cancelBtn) cancelBtn.addEventListener('click', close);
    if (wrap) wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    var confirmBtn = root.querySelector('#ats-addjob-confirm');
    // Populate the picker with the open jobs.
    ATS.api('/api/ats/jobs?status=open').then(function (d) {
      var sel = document.getElementById('ats-addjob-select');
      if (!sel) return;
      var jobs = (d && d.ok && d.jobs) ? d.jobs : [];
      if (!jobs.length) {
        sel.innerHTML = '<option value="">No open jobs available</option>';
        if (confirmBtn) confirmBtn.disabled = true;
        return;
      }
      sel.innerHTML = jobs.map(function (j) {
        var lbl = j.title || '—';
        if (j.practice_name) lbl += ' — ' + j.practice_name;
        return '<option value="' + ATS.escAttr(j.id) + '">' + ATS.esc(lbl) + '</option>';
      }).join('');
    });
    if (confirmBtn) confirmBtn.addEventListener('click', function () {
      var jobId = (document.getElementById('ats-addjob-select') || {}).value || '';
      if (!jobId) { ATS.toast('Pick a job first.'); return; }
      if (!window.confirm('This immediately reveals the practice to the GP and sends them a congratulations email with an interview booking link. Continue?')) return;
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Adding…';
      ATS.api('/api/ats/application', { method: 'POST', body: { user_id: c.user_id, career_role_id: jobId } }).then(function (res) {
        if (res && res.ok) {
          close();
          if (res.message) ATS.toast(res.message);
          else if (res.already) ATS.toast('Already in that pipeline');
          else ATS.toast('Added to ' + (res.job_title || 'job'));
          if (window.refreshPipelineWidget) window.refreshPipelineWidget();
          window.atsOpenCandidate(c.case_id); // reload so the new application appears
        } else {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Add to job';
          ATS.toast((res && (res.error || res.message)) || 'Could not add to the job.');
        }
      });
    });
  }

})();

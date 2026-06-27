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
    ['applied', 'Applied'], ['submitted', 'Submitted'], ['reviewing', 'Reviewing'],
    ['interview', 'Interview'], ['offer', 'Offer'], ['hired', 'Hired'], ['not_proceeding', 'Not proceeding']
  ];
  function stageOptLabel(s) {
    for (var i = 0; i < ATS_STAGE_OPTS.length; i++) { if (ATS_STAGE_OPTS[i][0] === s) return ATS_STAGE_OPTS[i][1]; }
    return s ? String(s) : '—';
  }

  // Total-pipeline funnel: colour per bucket key (labels come from the endpoint).
  var BUCKET_COLOR = {
    unassociated: 'var(--ats-dim)',
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
      '<div class="ats-pipeline-widget" id="ats-pipeline-widget">' + pipelineWidgetInner() + '</div>' +
      '<div class="ats-toolbar">' +
        '<div class="ats-search">' + SVG_SEARCH +
          '<input type="text" id="ats-cand-search" placeholder="Search candidates…" value="' + ATS.escAttr(state.q) + '" />' +
        '</div>' +
        '<button class="ats-btn ats-btn-ghost ats-btn-sm" id="ats-cand-sort">Sort: ' + sortTxt + ' ▾</button>' +
        '<select id="ats-cand-stage" style="width:auto;min-width:130px">' + stageOpts + '</select>' +
        '<select id="ats-cand-band" style="width:auto;min-width:120px">' + bandOpts + '</select>' +
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
  };

  function rowHtml(c) {
    var regPill = c.blocked
      ? '<span class="ats-pill red">' + ATS.esc(c.reg_stage_label || '') + ' · blocked ' + (c.blocked_days || 0) + 'd</span>'
      : '<span class="ats-pill blue">' + ATS.esc(c.reg_stage_label || '') + '</span>';
    var ob = c.onboarding_completed
      ? '<span class="ats-pill green">Complete</span>'
      : '<span class="ats-pill amber">' + (c.onboarding_pct != null ? c.onboarding_pct : 0) + '%</span>';
    var docs = c.docs || {};
    return '<div class="ats-cand-row" data-case-id="' + ATS.escAttr(c.case_id) + '">' +
      '<div class="cr-id"><div class="ats-avatar" style="background:' + ATS.avatarColor(c.name) + '">' + ATS.esc(ATS.initials(c.name)) + '</div>' +
        '<div><div class="cr-name">' + ATS.esc(c.name) + '</div><div class="cr-sub">' + ATS.esc(c.email) + '</div></div></div>' +
      '<div class="cr-sub">' + ATS.countryLabel(c.country) + '</div>' +
      '<div>' + regPill + '</div>' +
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
    ATS.api('/api/ceo/candidate?case_id=' + encodeURIComponent(caseId)).then(function (d) {
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
        '<div style="display:flex;gap:9px">' +
          '<button class="ats-btn ats-btn-ghost ats-btn-sm" id="ats-cand-rsofile">Open RSO file</button>' +
          '<button class="ats-btn ats-btn-primary ats-btn-sm" id="ats-cand-schedule">＋ Schedule call</button>' +
        '</div>' +
      '</div>' +
      '<div class="ats-cand-profile-grid">' +
        '<div>' +
          '<div class="ats-card" style="margin-bottom:16px">' + profileCardInner(c) + '</div>' +
          '<div class="ats-card ats-intent-card">' + intentCardInner(c) + '</div>' +
        '</div>' +
        '<div>' +
          '<div class="ats-card" style="margin-bottom:16px">' + pipelineCardInner(c) + '</div>' +
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
      field('Zoho candidate ID', ATS.esc(c.zoho || '—'));
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

    var apps = c.apps || [];
    var appsHtml = apps.length ? apps.map(function (a) {
      var meta = atsStageMeta(a.ats_stage);
      var stageSel = '<select class="ats-app-stage" data-app-id="' + ATS.escAttr(a.id) + '">' +
        ATS_STAGE_OPTS.map(function (o) {
          return '<option value="' + o[0] + '"' + (a.ats_stage === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') + '</select>';
      return '<div class="ats-job-app-row"><div>' +
        '<div class="jar-title">' + ATS.esc(a.job_title || '—') + '</div>' +
        '<div class="jar-sub">' + ATS.esc(a.practice_name || '') + ' · applied via ATS</div></div>' +
        '<div class="ats-app-right">' +
          '<span class="ats-pill" style="background:rgba(255,255,255,0.06);color:' + meta.c + '">' + ATS.esc(meta.l) + '</span>' +
          stageSel +
        '</div></div>';
    }).join('') : '<div class="ats-empty">No job applications yet.</div>';

    var blockedPill = c.blocked ? '<span class="ats-pill red" style="margin-left:6px">Blocked at ' + ATS.esc(c.reg_stage_label || '') + '</span>' : '';

    return '<div class="ats-card-title"><span class="ats-dot" style="background:var(--ats-green)"></span> Pipeline position</div>' +
      '<div class="df-lbl" style="margin-bottom:6px">Registration journey ' + blockedPill + '</div>' +
      '<div class="ats-journey-wrap">' + railHtml + '</div>' +
      '<div class="ats-pw-apps-head"><div class="df-lbl">Job applications (ATS)</div>' +
        '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" id="ats-add-job">＋ Add to a job</button></div>' + appsHtml;
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
        return '<div class="ats-doc-line">' +
          '<div class="ats-doc-ico ' + (has ? 'yes' : 'no') + '">' + (has ? '✓' : '○') + '</div>' +
          '<div style="flex:1"><div class="dl-name">' + d.name + '</div><div class="dl-sub">' + d.sub + '</div></div>' +
          (has ? '<span class="ats-pill green">Uploaded</span>' : '<span class="ats-pill muted">Not uploaded</span>') +
        '</div>';
      }).join('');
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

  function wireDetailEvents(host, c) {
    var back = host.querySelector('#ats-cand-back');
    if (back) back.addEventListener('click', function () { window.loadCandidatesTab(); });
    var rso = host.querySelector('#ats-cand-rsofile');
    if (rso) rso.addEventListener('click', function () {
      window.open('/pages/admin?gp=' + encodeURIComponent(c.user_id || ''), '_blank');
    });
    var sched = host.querySelector('#ats-cand-schedule');
    if (sched) sched.addEventListener('click', function () { openScheduleModal(c); });
    // delegated click: comms-scan + add-to-job buttons (either may be re-rendered).
    host.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      if (e.target.closest('#ats-comms-scan')) { runCommsScan(c.case_id); return; }
      if (e.target.closest('#ats-add-job')) { openAddJobModal(c); return; }
    });
    // delegated change: a per-application stage <select> moves the GP along the pipeline.
    host.addEventListener('change', function (e) {
      var sel = e.target.closest ? e.target.closest('.ats-app-stage') : null;
      if (!sel) return;
      var appId = sel.getAttribute('data-app-id');
      if (!appId) return;
      var newStage = sel.value;
      sel.disabled = true;
      ATS.api('/api/ats/application?id=' + encodeURIComponent(appId), { method: 'PATCH', body: { stage: newStage } }).then(function (res) {
        if (res && res.ok) ATS.toast('Moved to ' + stageOptLabel(newStage));
        else ATS.toast((res && (res.error || res.message)) || 'Could not update the stage.');
        if (window.refreshPipelineWidget) window.refreshPipelineWidget();
        window.atsOpenCandidate(c.case_id); // reload to refresh the pill/score (or revert on failure)
      });
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

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
  var BILLINGS = ['Mixed billing', 'Private billing', 'Bulk billing'];
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

  /* ============================================================
   * JOBS LIST VIEW
   * ========================================================== */
  function loadJobsTab() {
    currentBoardJobId = null;
    boardData = null;
    var panel = panelEl();
    if (!panel) return;
    panel.innerHTML = listShellHtml();

    on('atsAddJobBtn', 'click', openAddJobModal);
    on('ats-job-search', 'input', fetchAndRenderJobList);
    on('atsJobStateFilter', 'change', fetchAndRenderJobList);
    on('atsJobOpenFilter', 'change', fetchAndRenderJobList);

    var listEl = el('atsJobList');
    if (listEl) {
      listEl.addEventListener('click', function (e) {
        var approveBtn = e.target.closest ? e.target.closest('[data-ats-approve-job]') : null;
        if (approveBtn) { openApprovalModal(approveBtn.getAttribute('data-ats-approve-job')); return; }
        var card = e.target.closest ? e.target.closest('.ats-job-card[data-job-id]') : null;
        if (card) atsOpenJobBoard(card.getAttribute('data-job-id'));
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
    A.api(buildJobsPath(f)).then(function (d) {
      var list = el('atsJobList');
      if (!list) return;
      if (!d || !d.ok) { list.innerHTML = A.emptyHtml('Could not load jobs.'); return; }
      var mc = el('masterJobsCount');
      if (mc && d.open_count != null) mc.textContent = d.open_count;
      var jobs = d.jobs || [];
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
    return '<div class="ats-job-card" data-job-id="' + A.escAttr(j.id) + '">' +
      '<div>' +
        '<h3>' + A.esc(j.masked_title || j.title || '—') + ' ' + statusPill(j.status) + ' ' + approvalPill(j) + (chip ? ' ' + chip : '') + '</h3>' +
        '<div class="ats-job-meta">' +
          '<span>🏥 ' + A.esc(j.practice_name || '—') + '</span>' +
          '<span>📍 ' + A.esc(j.suburb ? j.suburb : locStr(j)) + '</span>' +
          '<span>🗓 ' + A.esc(j.type || '—') + '</span>' +
          '<span>💳 ' + A.esc(j.billing || '—') + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="ats-job-right">' +
        (pending ? approveBtn : '<div class="ats-stage-spark">' + stageSpark(j.stage_counts) + '</div>') +
        '<div class="ats-cand-count"><b>' + active + '</b> in pipeline</div>' +
      '</div>' +
    '</div>';
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

  function renderBoardMeta() {
    var elm = el('atsBoardMeta');
    if (!elm || !boardData) return;
    var job = boardData.job || {};
    elm.innerHTML =
      '<span>🏥 ' + A.esc(job.practice_name || '—') + '</span>' +
      '<span>📍 ' + A.esc(locStr(job)) + '</span>' +
      '<span>🗓 ' + A.esc(job.type || '—') + '</span>' +
      '<span>💳 ' + A.esc(job.billing || '—') + '</span>' +
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

  function cardHtml(c) {
    var notes = c.ats_notes || '';
    var snippet = notes ? '📝 ' + (notes.length > 22 ? notes.slice(0, 22) + '…' : notes) : 'No notes yet';
    return '<div class="ats-cand-card" draggable="true" data-id="' + A.escAttr(c.id) + '">' +
      '<div class="cc-top">' +
        '<div class="ats-avatar" style="background:' + A.avatarColor(c.name) + '">' + A.esc(A.initials(c.name)) + '</div>' +
        '<div><div class="cc-name">' + A.esc(c.name || '—') + '</div><div class="cc-sub">' + A.countryLabel(c.country) + '</div></div>' +
      '</div>' +
      '<div class="cc-foot"><span class="cc-sub">' + A.esc(snippet) + '</span></div>' +
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

  // PATCH the application's stage, then move the card in the board + update counts.
  function moveCard(id, stage) {
    var found = findCard(id);
    if (!found) return;
    if (found.col.key === stage) return; // already there
    var name = found.card.name || 'Candidate';
    A.api('/api/ats/application?id=' + encodeURIComponent(id), { method: 'PATCH', body: { stage: stage } }).then(function (d) {
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not update stage'); return; }
      applyStageMove(id, stage);
      renderBoard();
      renderBoardMeta();
      A.toast(name + ' → ' + stageLabel(stage));
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
    A.api('/api/ats/application?id=' + encodeURIComponent(drawerCardId), { method: 'PATCH', body: { stage: stage } }).then(function (d) {
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not update stage'); return; }
      applyStageMove(drawerCardId, stage);
      renderBoard();
      renderBoardMeta();
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

    A.api('/api/ats/jobs', { method: 'POST', body: { practice_id: practiceId, intake: intake } }).then(function (d) {
      if (!d || !d.ok) { njError((d && d.message) || 'Could not create job.'); return; }
      closeAddJobModal();
      A.toast('Job created as PENDING — add a suburb header photo and approve it (Review & approve) to make it live to doctors.');
      loadJobsTab();
    });
  }

  /* ============================================================
   * JOB SETTINGS MODAL
   * ========================================================== */
  function openJobSettings() {
    if (!currentBoardJobId) return;
    A.api('/api/ats/job?id=' + encodeURIComponent(currentBoardJobId)).then(function (d) {
      if (!d || !d.ok || !d.editor) { A.toast((d && d.message) || 'Could not load job settings'); return; }
      // Baseline for the diff-only PATCH is the intake-parity editor payload
      // (billing_style/dpa/… vocabulary), NOT the display card.
      settingsOriginal = d.editor;
      A.setOverlay(jobSettingsModalHtml(d.editor));
      var modal = el('atsJobSettingsModal');
      if (modal) modal.classList.add('open');
      on('atsJsClose', 'click', closeJobSettings);
      on('atsJsCancel', 'click', closeJobSettings);
      on('atsJsSave', 'click', submitJobSettings);
      bindDpaSegment('atsJsDpaSeg', 'atsJsDpa');
    });
  }
  function closeJobSettings() { A.setOverlay(''); }

  function jsError(msg) {
    var e = el('atsJsError');
    if (e) { e.textContent = msg; e.style.display = msg ? 'block' : 'none'; }
  }

  // Sectioned intake-parity editor. `e` is the /api/ats/job editor payload.
  function jobSettingsModalHtml(e) {
    return '<div class="ats-modal-wrap" id="atsJobSettingsModal">' +
      '<div class="ats-modal">' +
        '<div class="ats-modal-head"><h3>Job settings</h3><button class="ats-drawer-close" id="atsJsClose">×</button></div>' +
        '<div class="ats-modal-body">' +
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
              '<div><label>Type</label><select id="atsJsType">' + plainOptions(optionsWithCurrent(JOB_TYPES, e.employment_type), e.employment_type) + '</select></div>' +
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
            '<select id="atsJsBilling">' + valueOptions(BILLING_STYLE_OPTS, e.billing_style) + '</select>' +
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
        '</div>' +
        '<div class="ats-modal-foot">' +
          '<button class="ats-btn ats-btn-ghost" id="atsJsCancel">Cancel</button>' +
          '<button class="ats-btn ats-btn-primary" id="atsJsSave">Save settings</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function submitJobSettings() {
    if (!currentBoardJobId || !settingsOriginal) return;
    jsError('');
    var o = settingsOriginal;
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

    A.api('/api/ats/job?id=' + encodeURIComponent(currentBoardJobId), { method: 'PATCH', body: body }).then(function (d) {
      if (!d || !d.ok) {
        // 400s name the offending field — surface it inline, not just a toast.
        jsError((d && d.message) || 'Could not save job settings');
        return;
      }
      // Show the recomputed masked title from the PATCH response, then reload.
      var newMasked = (d.editor && d.editor.masked_title) || '';
      var prev = el('atsJsMaskedPreview');
      if (prev && newMasked) prev.textContent = newMasked;
      settingsOriginal = d.editor || settingsOriginal;
      closeJobSettings();
      A.toast(newMasked ? 'Saved · ' + newMasked : 'Job settings saved');
      atsOpenJobBoard(currentBoardJobId); // re-open the board with fresh data
    });
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

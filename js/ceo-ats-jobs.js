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

  function jobCardHtml(j) {
    var active = j.active_count || 0;
    var pending = j.approval_status === 'pending';
    var approveBtn = pending
      ? '<button type="button" class="ats-btn ats-btn-primary ats-btn-sm" data-ats-approve-job="' + A.escAttr(j.id) + '">Review &amp; approve</button>'
      : '';
    return '<div class="ats-job-card" data-job-id="' + A.escAttr(j.id) + '">' +
      '<div>' +
        '<h3>' + A.esc(j.masked_title || j.title || '—') + ' ' + statusPill(j.status) + ' ' + approvalPill(j) + '</h3>' +
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
        return '<option value="' + A.escAttr(p.id) + '">' + A.esc(p.name) + '</option>';
      }).join('') || '<option value="">No practices yet</option>';

      A.setOverlay(addJobModalHtml(practiceOptions));
      var modal = el('atsAddJobModal');
      if (modal) modal.classList.add('open');
      on('atsAddJobClose', 'click', closeAddJobModal);
      on('atsAddJobCancel', 'click', closeAddJobModal);
      on('atsAddJobCreate', 'click', submitAddJob);
    });
  }
  function closeAddJobModal() { A.setOverlay(''); }

  function addJobModalHtml(practiceOptions) {
    return '<div class="ats-modal-wrap" id="atsAddJobModal">' +
      '<div class="ats-modal">' +
        '<div class="ats-modal-head"><h3>Add a job</h3><button class="ats-drawer-close" id="atsAddJobClose">×</button></div>' +
        '<div class="ats-modal-body">' +
          '<label>Job title</label>' +
          '<input type="text" id="atsNjTitle" placeholder="e.g. General Practitioner — VR" />' +
          '<label>Practice</label>' +
          '<select id="atsNjPractice">' + practiceOptions + '</select>' +
          '<div class="ats-form-row">' +
            '<div><label>City</label><input type="text" id="atsNjCity" placeholder="Brisbane" /></div>' +
            '<div><label>State</label><select id="atsNjState">' + plainOptions(AU_STATES, 'QLD') + '</select></div>' +
          '</div>' +
          '<div class="ats-form-row">' +
            '<div><label>Type</label><select id="atsNjType">' + plainOptions(JOB_TYPES, JOB_TYPES[0]) + '</select></div>' +
            '<div><label>Billing</label><select id="atsNjBilling">' + plainOptions(BILLINGS, BILLINGS[0]) + '</select></div>' +
          '</div>' +
          '<label>About the role (shown to doctors)</label>' +
          '<textarea id="atsNjSummary" rows="3" placeholder="A short, friendly description of the practice and the role…"></textarea>' +
        '</div>' +
        '<div class="ats-modal-foot">' +
          '<button class="ats-btn ats-btn-ghost" id="atsAddJobCancel">Cancel</button>' +
          '<button class="ats-btn ats-btn-primary" id="atsAddJobCreate">Create job</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function submitAddJob() {
    var title = (val('atsNjTitle') || '').trim();
    if (!title) { A.toast('Enter a job title'); return; }
    var body = {
      title: title,
      practice_id: val('atsNjPractice'),
      city: (val('atsNjCity') || '').trim(),
      state: val('atsNjState'),
      type: val('atsNjType'),
      billing: val('atsNjBilling'),
      summary: (val('atsNjSummary') || '').trim()
    };
    A.api('/api/ats/jobs', { method: 'POST', body: body }).then(function (d) {
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not create job'); return; }
      closeAddJobModal();
      A.toast('Job created');
      loadJobsTab();
    });
  }

  /* ============================================================
   * JOB SETTINGS MODAL
   * ========================================================== */
  function openJobSettings() {
    if (!currentBoardJobId) return;
    A.api('/api/ats/job?id=' + encodeURIComponent(currentBoardJobId)).then(function (d) {
      if (!d || !d.ok || !d.job) { A.toast((d && d.message) || 'Could not load job settings'); return; }
      settingsOriginal = d.job;
      A.setOverlay(jobSettingsModalHtml(d.job));
      var modal = el('atsJobSettingsModal');
      if (modal) modal.classList.add('open');
      on('atsJsClose', 'click', closeJobSettings);
      on('atsJsCancel', 'click', closeJobSettings);
      on('atsJsSave', 'click', submitJobSettings);
    });
  }
  function closeJobSettings() { A.setOverlay(''); }

  function jobSettingsModalHtml(job) {
    return '<div class="ats-modal-wrap" id="atsJobSettingsModal">' +
      '<div class="ats-modal">' +
        '<div class="ats-modal-head"><h3>Job settings</h3><button class="ats-drawer-close" id="atsJsClose">×</button></div>' +
        '<div class="ats-modal-body">' +
          '<label>Job title</label>' +
          '<input type="text" id="atsJsTitle" value="' + A.escAttr(job.title || '') + '" />' +
          '<div class="ats-form-row">' +
            '<div><label>City</label><input type="text" id="atsJsCity" value="' + A.escAttr(job.city || '') + '" /></div>' +
            '<div><label>State</label><select id="atsJsState">' + plainOptions(optionsWithCurrent(AU_STATES, job.state), job.state) + '</select></div>' +
          '</div>' +
          '<div class="ats-form-row">' +
            '<div><label>Type</label><select id="atsJsType">' + plainOptions(optionsWithCurrent(JOB_TYPES, job.type), job.type) + '</select></div>' +
            '<div><label>Billing</label><select id="atsJsBilling">' + plainOptions(optionsWithCurrent(BILLINGS, job.billing), job.billing) + '</select></div>' +
          '</div>' +
          '<label>About the role (shown to doctors)</label>' +
          '<textarea id="atsJsSummary" rows="3" placeholder="A short, friendly description of the practice and the role…">' + A.esc(job.summary || '') + '</textarea>' +
          '<label>Status</label>' +
          '<select id="atsJsStatus">' + valueOptions(JOB_STATUSES, job.status) + '</select>' +
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
    var fields = [
      ['title', 'atsJsTitle'],
      ['city', 'atsJsCity'],
      ['state', 'atsJsState'],
      ['type', 'atsJsType'],
      ['billing', 'atsJsBilling'],
      ['summary', 'atsJsSummary'],
      ['status', 'atsJsStatus']
    ];
    var body = {};
    fields.forEach(function (f) {
      var v = val(f[1]);
      if (f[0] === 'title' || f[0] === 'city') v = (v || '').trim();
      var orig = settingsOriginal[f[0]] == null ? '' : String(settingsOriginal[f[0]]);
      if (v !== orig) body[f[0]] = v;
    });
    if ('title' in body && !body.title) { A.toast('Job title cannot be empty'); return; }
    if (!Object.keys(body).length) { closeJobSettings(); A.toast('No changes to save'); return; }

    A.api('/api/ats/job?id=' + encodeURIComponent(currentBoardJobId), { method: 'PATCH', body: body }).then(function (d) {
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not save job settings'); return; }
      closeJobSettings();
      A.toast('Job settings saved');
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

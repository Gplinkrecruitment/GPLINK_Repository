/* ============================================================================
 * ceo-ats-meetings.js — Meetings master tab for the CEO dashboard.
 * Loaded by pages/ceo-dashboard.html AFTER /js/ceo-ats-shared.js (window.ATS).
 * Shows all CEO Zoom consultations + interviews with filter chips and
 * Upcoming / Past / Summaries grouping.
 * Exposes window.loadMeetingsTab().
 * ========================================================================== */
(function () {
  'use strict';

  var ATS = window.ATS;
  if (!ATS) return;

  var PANEL_ID = 'panel-meetings';
  function panel() { return document.getElementById(PANEL_ID); }

  // Module state (persisted across re-renders).
  var state = { kind: 'all' };

  // Kind filter definitions.
  var KIND_FILTERS = [
    { v: 'all',          label: 'All' },
    { v: 'consultation', label: 'Standard consultation' },
    { v: 'interview',    label: 'Interview' }
  ];

  // Statuses that put a meeting in each group.
  var UPCOMING_STATUSES  = { invited: 1, booked: 1 };
  var PAST_STATUSES      = { completed: 1, no_show: 1, cancelled: 1 };

  // Friendly status labels + pill modifiers.
  var STATUS_META = {
    invited:   { label: 'Invited',   mod: 'blue'  },
    booked:    { label: 'Booked',    mod: 'green' },
    completed: { label: 'Completed', mod: 'muted' },
    no_show:   { label: 'No-show',   mod: 'amber' },
    cancelled: { label: 'Cancelled', mod: 'red'   }
  };
  function statusMeta(s) { return STATUS_META[s] || { label: s ? String(s) : '—', mod: 'muted' }; }

  // Format a UTC datetime string in Sydney local time.
  var sydFmt = null;
  var sydTzFmt = null;
  function sydneyTime(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      if (!sydFmt) {
        sydFmt = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Australia/Sydney',
          day:      '2-digit',
          month:    'short',
          year:     'numeric',
          hour:     '2-digit',
          minute:   '2-digit',
          hour12:   true
        });
      }
      if (!sydTzFmt) {
        sydTzFmt = new Intl.DateTimeFormat('en-AU', {
          timeZone: 'Australia/Sydney',
          timeZoneName: 'short'
        });
      }
      var tzParts = sydTzFmt.formatToParts(d);
      var tzName = (tzParts.find(function (p) { return p.type === 'timeZoneName'; }) || {}).value || 'AEST';
      return sydFmt.format(d) + ' ' + tzName;
    } catch (e) {
      return String(iso);
    }
  }

  /* =====================================================================
   *  PUBLIC ENTRY POINT
   * ===================================================================== */
  window.loadMeetingsTab = function () {
    var el = panel();
    if (!el) return;
    el.innerHTML = scaffold();
    wireEvents(el);
    fetchAndRender();
  };

  /* =====================================================================
   *  SCAFFOLD
   * ===================================================================== */
  function scaffold() {
    var chips = KIND_FILTERS.map(function (f) {
      return '<button type="button" class="mtg-chip' + (state.kind === f.v ? ' active' : '') +
        '" data-kind="' + ATS.escAttr(f.v) + '">' + ATS.esc(f.label) + '</button>';
    }).join('');
    return '' +
      '<div class="ats-section-head"><div>' +
        '<h2>Meetings</h2>' +
        '<p>All CEO Zoom consultations and interviews — upcoming, past, and AI summaries.</p>' +
      '</div></div>' +
      '<div class="mtg-filters" id="mtg-filters">' + chips + '</div>' +
      '<div id="mtg-list">' + ATS.loadingHtml('Loading meetings…') + '</div>';
  }

  /* =====================================================================
   *  EVENTS
   * ===================================================================== */
  function wireEvents(el) {
    var filters = el.querySelector('#mtg-filters');
    if (filters) filters.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.mtg-chip[data-kind]') : null;
      if (!btn) return;
      var kind = btn.getAttribute('data-kind') || 'all';
      if (state.kind === kind) return;
      state.kind = kind;
      // Update chip active state.
      var chips = filters.querySelectorAll('.mtg-chip');
      for (var i = 0; i < chips.length; i++) {
        chips[i].classList.toggle('active', chips[i].getAttribute('data-kind') === kind);
      }
      fetchAndRender();
    });

    // Delegated: expand a summary row.
    var list = el.querySelector('#mtg-list');
    if (list) list.addEventListener('click', function (e) {
      var row = e.target.closest ? e.target.closest('.mtg-row[data-summary]') : null;
      if (!row) return;
      var body = row.querySelector('.mtg-summary-body');
      if (!body) return;
      var open = row.classList.toggle('expanded');
      body.style.display = open ? '' : 'none';
    });
  }

  /* =====================================================================
   *  DATA FETCH + RENDER
   * ===================================================================== */
  function fetchAndRender() {
    var listEl = document.getElementById('mtg-list');
    if (listEl) listEl.innerHTML = ATS.loadingHtml('Loading meetings…');
    ATS.api('/api/ceo/meetings?kind=' + encodeURIComponent(state.kind)).then(function (d) {
      var el = document.getElementById('mtg-list');
      if (!el) return;
      if (!d || !d.ok) { el.innerHTML = ATS.emptyHtml('Could not load meetings.'); return; }
      var meetings = d.meetings || [];
      if (!meetings.length) { el.innerHTML = ATS.emptyHtml('No meetings found.'); return; }

      // Classify into groups.
      var upcoming  = [];
      var past      = [];
      var summaries = [];
      meetings.forEach(function (m) {
        var s = m.status || '';
        if (UPCOMING_STATUSES[s]) upcoming.push(m);
        else if (PAST_STATUSES[s]) past.push(m);
        if (s === 'completed' && m.meeting_summary) summaries.push(m);
      });

      var html = '';
      if (upcoming.length)  html += group('Upcoming',  upcoming,  false);
      if (past.length)       html += group('Past',       past,      false);
      if (summaries.length)  html += group('Summaries',  summaries, true);
      if (!html)             html  = ATS.emptyHtml('No meetings in any group.');
      el.innerHTML = html;
    });
  }

  /* =====================================================================
   *  GROUP BLOCK
   * ===================================================================== */
  function group(heading, meetings, isSummaries) {
    var rows = meetings.map(function (m) { return rowHtml(m, isSummaries); }).join('');
    return '<div class="mtg-group">' +
      '<div class="mtg-group-head">' +
        '<span class="mtg-group-label">' + ATS.esc(heading) + '</span>' +
        '<span class="mtg-group-count">' + meetings.length + '</span>' +
      '</div>' +
      rows +
    '</div>';
  }

  /* =====================================================================
   *  MEETING ROW
   * ===================================================================== */
  function rowHtml(m, isSummary) {
    var sm = statusMeta(m.status);
    var isInterview = !!(m.is_interview || m.meeting_kind_label === 'Interview');
    var kindLabel = m.meeting_kind_label || (isInterview ? 'Interview' : 'Consultation');
    var kindMod   = isInterview ? 'purple' : 'blue';

    // Join link (only for booked/invited with a URL).
    var joinHtml = '';
    if ((m.status === 'booked' || m.status === 'invited') && m.zoom_join_url) {
      joinHtml = '<a class="ats-btn ats-btn-sm mtg-join-btn" href="' + ATS.escAttr(m.zoom_join_url) +
        '" target="_blank" rel="noopener">Join</a>';
    }

    // Practice name (interviews only).
    var practiceHtml = (isInterview && m.practice_name)
      ? '<span class="mtg-practice">' + ATS.esc(m.practice_name) + '</span>'
      : '';

    // Summary expansion for Summaries group.
    var summaryAttr = isSummary && m.meeting_summary ? ' data-summary="1"' : '';
    var summaryBody = isSummary && m.meeting_summary
      ? '<div class="mtg-summary-body" style="display:none">' +
          '<div class="ats-ai-badge" style="margin-bottom:6px">✦ AI SUMMARY</div>' +
          '<div class="mtg-summary-text">' + ATS.esc(m.meeting_summary) + '</div>' +
        '</div>'
      : '';
    var expandHint = isSummary && m.meeting_summary
      ? '<span class="mtg-expand-hint">Click to read</span>'
      : '';

    return '<div class="mtg-row' + (isSummary && m.meeting_summary ? ' has-summary' : '') + '"' + summaryAttr + '>' +
      '<div class="mtg-row-main">' +
        '<div class="mtg-name">' + ATS.esc(m.gp_name || '—') + '</div>' +
        '<div class="mtg-meta">' +
          '<span class="ats-pill ' + kindMod + '">' + ATS.esc(kindLabel) + '</span>' +
          practiceHtml +
          '<span class="mtg-time">' + ATS.esc(sydneyTime(m.scheduled_at)) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="mtg-row-right">' +
        '<span class="ats-pill ' + sm.mod + '">' + ATS.esc(sm.label) + '</span>' +
        expandHint +
        joinHtml +
      '</div>' +
      summaryBody +
    '</div>';
  }

})();

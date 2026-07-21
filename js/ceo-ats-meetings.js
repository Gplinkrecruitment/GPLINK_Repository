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

  // Plain English for the funnel's stored codes — the owner reads this panel
  // right before the call, so never print a raw code at them.
  var COUNTRY_LABELS = { uk: 'United Kingdom', ie: 'Ireland', nz: 'New Zealand' };
  var SOURCE_LABELS = {
    site_start_form: 'Landing page',
    meta_lead_ad:    'Facebook lead form',
    calendly_direct: 'Booked direct, never screened'
  };

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

    // Delegated: cancel & rebook a booked interview (GAP A2).
    var list = el.querySelector('#mtg-list');
    if (list) list.addEventListener('click', function (e) {
      var cancelBtn = e.target.closest ? e.target.closest('.mtg-cancel-btn') : null;
      if (cancelBtn) {
        e.stopPropagation();
        var appId = cancelBtn.getAttribute('data-app-id');
        if (!appId) return;
        if (!window.confirm('Cancel this booked interview? The doctor and practice will be told, and it can be rebooked from the candidate\'s Applications card.')) return;
        cancelBtn.disabled = true; cancelBtn.textContent = 'Cancelling…';
        ATS.api('/api/ats/interview/cancel', { method: 'POST', body: { applicationId: String(appId) } }).then(function (r) {
          if (r && r.ok) {
            ATS.toast('Interview cancelled — rebook it from the candidate\'s card.');
            fetchAndRender();
          } else {
            ATS.toast((r && (r.error || r.message)) || 'Could not cancel the interview.');
            cancelBtn.disabled = false; cancelBtn.textContent = 'Cancel & rebook';
          }
        });
        return;
      }
      // Delegated: expand a row's detail panel (AI summary and/or booking context).
      var row = e.target.closest ? e.target.closest('.mtg-row[data-expand]') : null;
      if (!row) return;
      // A link inside the panel (mailto:/tel:/Join) must open, not collapse the panel.
      if (e.target.closest && e.target.closest('a')) return;
      var body = row.querySelector('.mtg-expand-body');
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
   *  DETAIL PANEL — what we already know about the person on the call
   * ===================================================================== */
  function detailRow(label, valueHtml) {
    return '<div class="mtg-detail-row">' +
      '<span class="mtg-detail-label">' + ATS.esc(label) + '</span>' +
      '<span class="mtg-detail-value">' + valueHtml + '</span>' +
    '</div>';
  }

  // Returns '' when we hold nothing worth showing, so the caller can skip the
  // panel entirely rather than render an empty heading.
  function detailHtml(m) {
    var lead = m.lead || null;
    var parts = '';

    if (lead) {
      var told = [];
      // not_screened = they booked the public link and were never ASKED the
      // screening questions. is_gp would be false there because we never asked,
      // not because they said no — so say nothing rather than something untrue.
      if (!lead.not_screened) {
        told.push('Registered GP: ' + (lead.is_gp ? 'Yes' : 'No'));
        if (lead.country) {
          told.push('Country: ' + (COUNTRY_LABELS[String(lead.country).trim().toLowerCase()] || 'Other'));
        }
      }
      var src = SOURCE_LABELS[String(lead.source || '').trim()];
      if (src) told.push('Came from: ' + src);
      if (told.length) parts += detailRow('What they told us', ATS.esc(told.join(' · ')));
      if (lead.question) parts += detailRow('They asked', ATS.esc(lead.question));
    }

    if (m.invitee_notes) {
      parts += detailRow('Booking notes',
        '<span class="mtg-detail-hint">What they answered when booking</span>' +
        ATS.esc(m.invitee_notes));
    }

    var contact = [];
    if (m.invitee_email) {
      contact.push('<a href="mailto:' + ATS.escAttr(m.invitee_email) + '">' + ATS.esc(m.invitee_email) + '</a>');
    }
    if (lead && lead.phone) {
      contact.push('<a href="tel:' + ATS.escAttr(String(lead.phone).replace(/[^\d+]/g, '')) + '">' +
        ATS.esc(lead.phone) + '</a>');
    }
    if (contact.length) parts += detailRow('Contact', contact.join(' · '));

    if (m.duration_minutes) parts += detailRow('Call length', ATS.esc(m.duration_minutes + ' minutes'));
    if (m.timezone) parts += detailRow('Their timezone', ATS.esc(m.timezone));

    return parts ? '<div class="mtg-detail">' + parts + '</div>' : '';
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

    // GAP A2: cancel & rebook a booked interview straight from the Meetings tab.
    var cancelHtml = '';
    if (isInterview && m.status === 'booked' && m.application_id) {
      cancelHtml = '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm mtg-cancel-btn" data-app-id="' +
        ATS.escAttr(String(m.application_id)) + '">Cancel &amp; rebook</button>';
    }

    // Practice name (interviews only).
    var practiceHtml = (isInterview && m.practice_name)
      ? '<span class="mtg-practice">' + ATS.esc(m.practice_name) + '</span>'
      : '';

    // Expanded panel: the AI summary (Summaries group) and/or everything the
    // funnel already told us about this person. Either alone makes the row
    // expandable; the compact row above stays unchanged.
    var summaryHtml = isSummary && m.meeting_summary
      ? '<div class="ats-ai-badge" style="margin-bottom:6px">✦ AI SUMMARY</div>' +
        '<div class="mtg-summary-text">' + ATS.esc(m.meeting_summary) + '</div>'
      : '';
    var detail = detailHtml(m);
    var expandable = !!(summaryHtml || detail);
    var expandAttr = expandable ? ' data-expand="1"' : '';
    var expandBody = expandable
      ? '<div class="mtg-expand-body mtg-summary-body" style="display:none">' + summaryHtml + detail + '</div>'
      : '';
    var expandHint = expandable
      ? '<span class="mtg-expand-hint">' + (summaryHtml ? 'Click to read' : 'Click for details') + '</span>'
      : '';

    return '<div class="mtg-row' + (expandable ? ' has-summary' : '') + '"' + expandAttr + '>' +
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
        cancelHtml +
      '</div>' +
      expandBody +
    '</div>';
  }

})();

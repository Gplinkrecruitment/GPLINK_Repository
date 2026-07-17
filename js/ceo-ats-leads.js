/* ============================================================================
 * ceo-ats-leads.js — Leads master tab for the CEO dashboard.
 * Loaded by pages/ceo-dashboard.html AFTER /js/ceo-ats-shared.js (window.ATS).
 * Shows every GP lead from the Meta-ads / landing-page consult funnel
 * (site_enquiries kind=gp) with filter chips, search and chase-email history.
 * Exposes window.loadLeadsTab().
 * ========================================================================== */
(function () {
  'use strict';

  var ATS = window.ATS;
  if (!ATS) return;

  var PANEL_ID = 'panel-leads';
  function panel() { return document.getElementById(PANEL_ID); }

  // Module state (persisted across re-renders).
  var state = { filter: 'all', q: '' };

  // Filter chips. `v` must match the server's ?filter= values.
  var FILTERS = [
    { v: 'all',           label: 'All' },
    { v: 'qualified',     label: 'Qualified' },
    { v: 'booked',        label: 'Booked a call' },
    { v: 'converted',     label: 'Signed up' },
    { v: 'not_qualified', label: 'Not qualified' }
  ];

  // Where the lead came from, in words the owner uses.
  var SOURCE_LABELS = {
    site_start_form: 'Landing page',
    meta_lead_ad:    'Facebook lead form',
    calendly_direct: 'Booked direct (not screened)',
    'marketing-site': 'Website enquiry form'
  };
  function sourceLabel(s) { return SOURCE_LABELS[s] || (s ? String(s) : 'Unknown'); }

  // Why the chase emails stopped, in plain words.
  var STOPPED_LABELS = {
    signed_up:    'stopped — they signed up',
    unsubscribed: 'stopped — they unsubscribed',
    exhausted:    'stopped — every email sent'
  };

  // The lead's state as ONE badge, most-decisive fact first.
  // `not_screened` outranks `call_booked` because a stranger on the calendar
  // who was never asked if they're even a GP is the thing to act on; the meta
  // line still shows the booking time, so nothing is hidden.
  // The final fallback catches website-enquiry rows with no consult data —
  // they were never screened either, so saying "Not qualified" would be a lie.
  function stateBadge(l) {
    if (l.status === 'converted')  return { label: 'Signed up',           mod: 'green'  };
    if (l.not_screened)            return { label: 'Never screened',      mod: 'purple' };
    if (l.call_booked)             return { label: 'Call booked',         mod: 'blue'   };
    if (l.screened_out)            return { label: 'Not qualified',       mod: 'red'    };
    if (l.qualified)               return { label: 'Qualified, no call yet', mod: 'amber' };
    return { label: 'Never screened', mod: 'purple' };
  }

  // Format a UTC datetime string in Sydney local time (matches ceo-ats-meetings.js).
  var sydFmt = null;
  function sydneyTime(iso) {
    if (!iso) return '—';
    try {
      if (!sydFmt) {
        sydFmt = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Australia/Sydney',
          day: '2-digit', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit', hour12: true
        });
      }
      return sydFmt.format(new Date(iso));
    } catch (e) {
      return String(iso);
    }
  }

  /* =====================================================================
   *  PUBLIC ENTRY POINT
   * ===================================================================== */
  window.loadLeadsTab = function () {
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
    return '' +
      '<div class="ats-section-head"><div>' +
        '<h2>Leads</h2>' +
        '<p>Everyone who asked about GP work — from the ads, the landing page and the website form.</p>' +
      '</div></div>' +
      '<div class="lead-toolbar">' +
        '<div class="lead-filters" id="lead-filters"></div>' +
        '<input type="search" class="lead-search" id="lead-search" placeholder="Search name or email…" ' +
          'value="' + ATS.escAttr(state.q) + '" autocomplete="off" />' +
      '</div>' +
      '<div id="lead-list">' + ATS.loadingHtml('Loading leads…') + '</div>';
  }

  // Chips are re-rendered on every fetch so the counts stay in step with the
  // active search.
  function chipsHtml(counts) {
    return FILTERS.map(function (f) {
      var n = counts && counts[f.v] != null ? counts[f.v] : null;
      return '<button type="button" class="lead-chip' + (state.filter === f.v ? ' active' : '') +
        '" data-filter="' + ATS.escAttr(f.v) + '">' + ATS.esc(f.label) +
        (n == null ? '' : ' <span class="lead-chip-n">' + n + '</span>') + '</button>';
    }).join('');
  }

  /* =====================================================================
   *  EVENTS
   * ===================================================================== */
  function wireEvents(el) {
    var filters = el.querySelector('#lead-filters');
    if (filters) filters.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.lead-chip[data-filter]') : null;
      if (!btn) return;
      var f = btn.getAttribute('data-filter') || 'all';
      if (state.filter === f) return;
      state.filter = f;
      fetchAndRender();
    });

    var search = el.querySelector('#lead-search');
    if (search) {
      var timer = null;
      search.addEventListener('input', function () {
        var v = search.value || '';
        clearTimeout(timer);
        timer = setTimeout(function () {
          if (state.q === v) return;
          state.q = v;
          fetchAndRender();
        }, 250);
      });
    }
  }

  /* =====================================================================
   *  DATA FETCH + RENDER
   * ===================================================================== */
  function fetchAndRender() {
    var listEl = document.getElementById('lead-list');
    if (listEl) listEl.innerHTML = ATS.loadingHtml('Loading leads…');
    var qs = '?filter=' + encodeURIComponent(state.filter) +
      (state.q ? '&q=' + encodeURIComponent(state.q) : '');
    ATS.api('/api/ceo/leads' + qs).then(function (d) {
      var el = document.getElementById('lead-list');
      if (!el) return;
      var chips = document.getElementById('lead-filters');
      if (chips) chips.innerHTML = chipsHtml(d && d.counts);
      if (!d || !d.ok) { el.innerHTML = ATS.emptyHtml('Could not load leads.'); return; }
      var leads = d.leads || [];
      if (!leads.length) {
        el.innerHTML = ATS.emptyHtml(state.q
          ? 'No leads match “' + state.q + '”.'
          : 'No leads here yet.');
        return;
      }
      el.innerHTML = '<div class="lead-group">' + leads.map(rowHtml).join('') + '</div>';
    });
  }

  /* =====================================================================
   *  LEAD ROW
   * ===================================================================== */
  function rowHtml(l) {
    var sb = stateBadge(l);

    var contact = ATS.esc(l.email || '—');
    if (l.phone) contact += ' <span class="lead-sep">·</span> ' + ATS.esc(l.phone);

    var bookedHtml = l.call_booked && l.call_booked_at
      ? '<span class="lead-fact">Call booked ' + ATS.esc(sydneyTime(l.call_booked_at)) + '</span>'
      : '';

    // Chase emails: count + when the last one went, then why they stopped.
    var nudgeText;
    if (!l.nudges_sent) {
      nudgeText = 'No chase emails sent';
    } else {
      nudgeText = l.nudges_sent + ' chase email' + (l.nudges_sent === 1 ? '' : 's') + ' sent';
      if (l.last_nudge_at) nudgeText += ' — last ' + sydneyTime(l.last_nudge_at);
    }
    if (l.stopped) nudgeText += ' (' + (STOPPED_LABELS[l.stopped] || 'stopped') + ')';

    var questionHtml = l.call_question
      ? '<div class="lead-question"><span class="lead-question-label">They asked:</span> ' +
          ATS.esc(l.call_question) + '</div>'
      : '';

    return '<div class="lead-row">' +
      '<div class="lead-row-main">' +
        '<div class="lead-name">' + ATS.esc(l.name || '—') + '</div>' +
        '<div class="lead-contact">' + contact + '</div>' +
        '<div class="lead-meta">' +
          '<span class="lead-source">' + ATS.esc(sourceLabel(l.source)) + '</span>' +
          (l.country ? '<span class="lead-fact">' + ATS.countryLabel(l.country) + '</span>' : '') +
          '<span class="lead-fact">Arrived ' + ATS.esc(sydneyTime(l.created_at)) + '</span>' +
          bookedHtml +
        '</div>' +
        '<div class="lead-nudges">' + ATS.esc(nudgeText) + '</div>' +
        questionHtml +
      '</div>' +
      '<div class="lead-row-right">' +
        '<span class="ats-pill ' + sb.mod + '">' + ATS.esc(sb.label) + '</span>' +
      '</div>' +
    '</div>';
  }

})();

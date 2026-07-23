/* ============================================================================
 * ceo-ats-contracts.js — Contracts master tab for the CEO dashboard (Task 12).
 * Loaded by pages/ceo-dashboard.html AFTER /js/ceo-ats-shared.js (window.ATS).
 * Lists every career_contracts row from GET /api/ceo/contracts (uploaded /
 * changes_requested first — they need the CEO now), with the AI verdict,
 * discrepancies, terms context and a signed contract link. The CEO either
 * submits the contract on to the GP or returns it to the practice for a fix.
 * Exposes window.loadContractsTab().
 * ========================================================================== */
(function () {
  'use strict';

  var ATS = window.ATS;
  if (!ATS) return;

  var PANEL_ID = 'panel-contracts';
  function panel() { return document.getElementById(PANEL_ID); }

  // Module state (persisted across re-renders). `expanded` holds the single
  // open contract id (accordion-style — mirrors the rest of the ATS tabs,
  // which show one detail view at a time).
  var state = { contracts: [], expanded: null, busy: false };

  // AI verdict → pill. `unreadable` and a missing/errored verdict both read
  // as the same neutral grey chip — the CEO acts on the words either way.
  var VERDICT_META = {
    aligned: { label: 'Aligned', mod: 'green' },
    minor_gaps: { label: 'Minor gaps', mod: 'amber' },
    major_discrepancies: { label: 'Major discrepancies', mod: 'red' },
    unreadable: { label: 'Unreadable', mod: 'muted' }
  };
  function verdictMeta(v) { return VERDICT_META[v] || { label: 'Not reviewed', mod: 'muted' }; }

  // Contract lifecycle status → pill (career_contracts.status check constraint).
  var STATUS_META = {
    awaiting_upload: { label: 'Awaiting practice upload', mod: 'muted' },
    uploaded: { label: 'Awaiting your review', mod: 'amber' },
    sent_to_gp: { label: 'Sent to GP', mod: 'blue' },
    changes_requested: { label: 'GP requested changes', mod: 'red' },
    practice_review: { label: 'With practice', mod: 'purple' },
    signed: { label: 'Signed', mod: 'green' },
    void: { label: 'Void', mod: 'muted' }
  };
  function statusMeta(s) {
    return STATUS_META[s] || { label: s ? String(s).replace(/_/g, ' ') : '—', mod: 'muted' };
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch (e) { return String(iso); }
  }

  /* =====================================================================
   *  PUBLIC ENTRY POINT
   * ===================================================================== */
  window.loadContractsTab = function () {
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
        '<h2>Contracts</h2>' +
        '<p>Employment contracts uploaded by practices — review the AI verdict, then submit to the GP or return it for changes.</p>' +
      '</div></div>' +
      '<div id="contracts-list">' + ATS.loadingHtml('Loading contracts…') + '</div>';
  }

  /* =====================================================================
   *  DATA FETCH + RENDER
   * ===================================================================== */
  function fetchAndRender() {
    var el = document.getElementById('contracts-list');
    if (el) el.innerHTML = ATS.loadingHtml('Loading contracts…');
    ATS.swr('/api/ceo/contracts', function (d) {
      var listEl = document.getElementById('contracts-list');
      if (!listEl) return;
      if (!d || !d.ok) { listEl.innerHTML = ATS.emptyHtml('Could not load contracts.'); return; }
      state.contracts = d.contracts || [];
      render(listEl);
    });
  }

  function render(el) {
    if (!state.contracts.length) { el.innerHTML = ATS.emptyHtml('No contracts yet.'); return; }
    el.innerHTML = '<div style="display:grid;gap:12px">' + state.contracts.map(cardHtml).join('') + '</div>';
  }

  /* =====================================================================
   *  CONTRACT CARD
   * ===================================================================== */
  function cardHtml(c) {
    var open = state.expanded === c.id;
    var sm = statusMeta(c.status);
    var vm = verdictMeta(c.ai_review && c.ai_review.overall);
    var head = '' +
      '<div class="ats-card-title" style="justify-content:space-between;cursor:pointer" data-toggle="' + ATS.escAttr(c.id) + '">' +
        '<div>' +
          '<div style="font-size:14px;font-weight:600">' + ATS.esc(c.gpName || 'Unknown GP') + '</div>' +
          '<div style="font-size:12px;color:var(--ats-dim)">' + ATS.esc(c.practiceName || 'Unknown practice') + ' — ' + ATS.esc(c.roleTitle || 'Unknown role') + ' · v' + ATS.esc(c.version) + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end">' +
          '<span class="ats-pill ' + sm.mod + '">' + ATS.esc(sm.label) + '</span>' +
          '<span class="ats-pill ' + vm.mod + '">' + ATS.esc(vm.label) + '</span>' +
          '<span style="font-size:11px;color:var(--ats-dim)">' + ATS.esc(fmtDate(c.uploaded_at)) + '</span>' +
        '</div>' +
      '</div>';
    return '<div class="ats-card" data-contract-card="' + ATS.escAttr(c.id) + '">' + head + (open ? detailHtml(c) : '') + '</div>';
  }

  function discrepancyRow(d) {
    d = d || {};
    return '' +
      '<div class="ats-detail-field">' +
        '<div class="df-lbl">' + ATS.esc(d.field || 'Unspecified') + (d.severity ? ' — ' + ATS.esc(d.severity) : '') + '</div>' +
        '<div class="df-val">Contract says: ' + ATS.esc(d.contract_says || '—') + '<br>Expected: ' + ATS.esc(d.expected || '—') + ' (' + ATS.esc(d.source || 'unknown source') + ')</div>' +
      '</div>';
  }

  function detailHtml(c) {
    var review = c.ai_review || null;
    var discrepancies = review && Array.isArray(review.discrepancies) ? review.discrepancies : [];

    // The GP's own change-request text, shown prominently for a bounced-back
    // contract. Task 14 wires the actual Release-to-practice / Decline-change
    // decision buttons for this in actionsHtml below — this block only
    // surfaces the text.
    var changeReqHtml = (c.status === 'changes_requested' && c.change_request)
      ? '<div class="ats-context-note" style="margin-top:14px"><b>The GP requested changes:</b><br>' + ATS.esc(c.change_request) + '</div>'
      : '';

    var summaryHtml = review
      ? '<div class="ats-detail-field"><div class="df-lbl">AI summary</div><div class="df-val">' + ATS.esc(review.summary || '—') + '</div></div>'
      : '<div class="ats-detail-field"><div class="df-lbl">AI summary</div><div class="df-val">No AI review has run yet.</div></div>';

    var termsHtml = review
      ? '<div class="ats-detail-field"><div class="df-lbl">Terms context</div><div class="df-val">' +
          (review.interview_terms_available
            ? 'Compared against the interview summary — it supersedes the advertised terms where they differ.'
            : 'No interview summary on file — compared against the advertised/offer terms only.') +
        '</div></div>'
      : '';

    var discrepanciesHtml = discrepancies.length
      ? '<div class="df-lbl" style="margin:14px 0 4px">Discrepancies</div>' + discrepancies.map(discrepancyRow).join('')
      : '';

    var linkHtml = c.contractUrl
      ? '<a class="ats-btn ats-btn-sm" href="' + ATS.escAttr(c.contractUrl) + '" target="_blank" rel="noopener">View contract</a>'
      : '<span style="font-size:12px;color:var(--ats-dim)">No contract file on this row.</span>';
    var signedLinkHtml = c.signedUrl
      ? ' <a class="ats-btn ats-btn-sm" href="' + ATS.escAttr(c.signedUrl) + '" target="_blank" rel="noopener">View signed copy</a>'
      : '';

    // Actions only apply to a row the CEO can actually act on right now.
    var canSubmit = c.status === 'uploaded';
    var canReturn = c.status === 'uploaded' || c.status === 'changes_requested';
    // Task 14: the GP's change-request triage — release it to the practice
    // for email consent (they either re-upload or decline), or decline the
    // request outright and hand the SAME contract straight back to the GP as
    // originally sent. Offered alongside Task 12's "Return to practice"
    // above, which still lets the CEO skip practice consent entirely and
    // start a fresh revision immediately if that's the faster call.
    var canTriageChange = c.status === 'changes_requested';
    var actionsHtml = (canSubmit || canReturn || canTriageChange)
      ? '' +
        '<div style="margin-top:14px">' +
          '<label>Note (optional)</label>' +
          '<textarea data-note-for="' + ATS.escAttr(c.id) + '" placeholder="Add a note for the GP or the practice…" rows="3"></textarea>' +
          '<div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">' +
            (canSubmit ? '<button type="button" class="ats-btn ats-btn-primary" data-action="submit_to_gp" data-contract="' + ATS.escAttr(c.id) + '">Submit to GP</button>' : '') +
            (canReturn ? '<button type="button" class="ats-btn ats-btn-ghost" data-action="return_to_practice" data-contract="' + ATS.escAttr(c.id) + '">Return to practice</button>' : '') +
            (canTriageChange ? '<button type="button" class="ats-btn ats-btn-primary" data-action="release_to_practice" data-contract="' + ATS.escAttr(c.id) + '">Release to practice</button>' : '') +
            (canTriageChange ? '<button type="button" class="ats-btn ats-btn-ghost" data-action="decline_change" data-contract="' + ATS.escAttr(c.id) + '">Decline change (back to GP)</button>' : '') +
          '</div>' +
        '</div>'
      : '';

    return '' +
      '<div style="margin-top:14px;border-top:1px solid var(--ats-border);padding-top:14px">' +
        changeReqHtml + summaryHtml + termsHtml + discrepanciesHtml +
        '<div style="margin-top:14px">' + linkHtml + signedLinkHtml + '</div>' +
        actionsHtml +
      '</div>';
  }

  /* =====================================================================
   *  EVENTS — single delegated listener on the panel (CLAUDE.md convention).
   * ===================================================================== */
  function wireEvents(el) {
    el.addEventListener('click', function (e) {
      var toggle = e.target.closest ? e.target.closest('[data-toggle]') : null;
      if (toggle) {
        var tid = toggle.getAttribute('data-toggle');
        state.expanded = state.expanded === tid ? null : tid;
        var listEl = document.getElementById('contracts-list');
        if (listEl) render(listEl);
        return;
      }

      var btn = e.target.closest ? e.target.closest('[data-action]') : null;
      if (btn) {
        if (state.busy) return;
        var contractId = btn.getAttribute('data-contract');
        var action = btn.getAttribute('data-action');
        if (action === 'return_to_practice' && !window.confirm('Return this contract to the practice for changes?')) return;
        if (action === 'decline_change' && !window.confirm('Decline this change and send the contract back to the GP exactly as sent?')) return;
        var noteEl = el.querySelector('[data-note-for="' + cssEscape(contractId) + '"]');
        var note = noteEl ? noteEl.value : '';
        if (action === 'release_to_practice' || action === 'decline_change') {
          submitChangeDecision(contractId, action, note);
        } else {
          submitDecision(contractId, action, note);
        }
      }
    });
  }

  // CSS.escape polyfill-lite for the attribute selector above — every id here
  // is a Supabase uuid (no quote/backslash chars), but this guards the query
  // selector from throwing if that ever isn't true.
  function cssEscape(s) {
    return String(s == null ? '' : s).replace(/["\\]/g, '\\$&');
  }

  function submitDecision(contractId, action, note) {
    state.busy = true;
    ATS.api('/api/ceo/contract/decision', { method: 'POST', body: { contractId: contractId, action: action, note: note } }).then(function (d) {
      state.busy = false;
      if (!d || !d.ok) { ATS.toast((d && d.message) || 'Could not update the contract.'); return; }
      ATS.toast(action === 'submit_to_gp' ? 'Sent to the GP.' : 'Returned to the practice.');
      state.expanded = null;
      fetchAndRender();
    });
  }

  // Task 14: the change-request triage buttons post to the dedicated
  // change-decision endpoint (distinct from Task 12's decision endpoint
  // above) since they only ever apply to a 'changes_requested' row.
  function submitChangeDecision(contractId, action, note) {
    state.busy = true;
    ATS.api('/api/ceo/contract/change-decision', { method: 'POST', body: { contractId: contractId, action: action, note: note } }).then(function (d) {
      state.busy = false;
      if (!d || !d.ok) { ATS.toast((d && d.message) || 'Could not update the contract.'); return; }
      ATS.toast(action === 'release_to_practice' ? 'Released to the practice for consent.' : 'Declined — sent back to the GP.');
      state.expanded = null;
      fetchAndRender();
    });
  }

})();

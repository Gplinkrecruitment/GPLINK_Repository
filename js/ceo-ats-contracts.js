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
  // `docs` caches the inline contract reader per contract id:
  //   { loading:true } | { kind:'text', text } | { kind:'pdf', url } | { kind:'error', message }
  var state = { contracts: [], expanded: null, busy: false, docs: {} };

  /* =====================================================================
   *  INLINE CONTRACT READER — highlighting
   *  The CEO reads the contract here rather than downloading it, with every
   *  clause the AI flagged marked in red. Matching is whitespace-insensitive
   *  and case-insensitive on purpose: DOCX extraction collapses line breaks
   *  and indentation differently from how the model quotes them back, so an
   *  exact === match would miss almost everything.
   * ===================================================================== */

  // Build a normalised copy of the text (whitespace runs → one space,
  // lowercased) plus a map from each normalised index back to the original
  // index, so a match found in normalised space can be highlighted in the
  // ORIGINAL text without disturbing its formatting.
  function normaliseWithMap(text) {
    var norm = '', map = [], prevSpace = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (/\s/.test(ch)) {
        if (prevSpace) continue;
        norm += ' '; map.push(i); prevSpace = true;
      } else {
        norm += ch.toLowerCase(); map.push(i); prevSpace = false;
      }
    }
    return { norm: norm, map: map };
  }

  function normaliseQuote(q) {
    return String(q == null ? '' : q).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // Returns { html, unmatched:[quote,…] }. Quotes are matched longest-first so
  // a short quote nested inside a longer one can't split the longer highlight.
  function highlightContract(text, quotes) {
    var raw = String(text == null ? '' : text);
    if (!raw) return { html: '', unmatched: [] };

    var wanted = [];
    (quotes || []).forEach(function (q) {
      var n = normaliseQuote(q);
      // Very short fragments ("$180", "GP") would paint the whole document
      // red — a highlight that matches everything highlights nothing.
      if (n.length >= 8 && wanted.indexOf(n) === -1) wanted.push(n);
    });
    if (!wanted.length) return { html: ATS.esc(raw), unmatched: [] };
    wanted.sort(function (a, b) { return b.length - a.length; });

    var nm = normaliseWithMap(raw);
    var ranges = [], unmatched = [];
    wanted.forEach(function (q) {
      var from = 0, found = false, guard = 0;
      while (guard++ < 50) {
        var at = nm.norm.indexOf(q, from);
        if (at === -1) break;
        found = true;
        var startOrig = nm.map[at];
        var endOrig = nm.map[at + q.length - 1];
        if (startOrig != null && endOrig != null) ranges.push([startOrig, endOrig + 1]);
        from = at + q.length;
      }
      if (!found) unmatched.push(q);
    });

    if (!ranges.length) return { html: ATS.esc(raw), unmatched: unmatched };

    // Merge overlaps so nested/adjacent hits become one <mark>.
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [ranges[0].slice()];
    for (var r = 1; r < ranges.length; r++) {
      var last = merged[merged.length - 1];
      if (ranges[r][0] <= last[1]) { last[1] = Math.max(last[1], ranges[r][1]); }
      else merged.push(ranges[r].slice());
    }

    var out = '', cursor = 0;
    merged.forEach(function (rg) {
      out += ATS.esc(raw.slice(cursor, rg[0]));
      out += '<mark>' + ATS.esc(raw.slice(rg[0], rg[1])) + '</mark>';
      cursor = rg[1];
    });
    out += ATS.esc(raw.slice(cursor));
    return { html: out, unmatched: unmatched };
  }

  function quotesFor(c) {
    var review = c && c.ai_review;
    var ds = (review && Array.isArray(review.discrepancies)) ? review.discrepancies : [];
    return ds.map(function (d) { return d && d.contract_says; }).filter(Boolean);
  }

  // Fetch the readable contract for a card once, then re-render it in place.
  function ensureDoc(c) {
    if (!c || !c.id) return;
    if (state.docs[c.id]) return;                 // cached (or in flight)
    state.docs[c.id] = { loading: true };
    ATS.api('/api/ceo/contract/preview?contractId=' + encodeURIComponent(c.id)).then(function (d) {
      if (!d || !d.ok) {
        state.docs[c.id] = { kind: 'error', message: (d && d.message) || 'Could not open the contract.' };
      } else {
        state.docs[c.id] = d;
      }
      var slot = document.querySelector('[data-doc-slot="' + cssEscape(c.id) + '"]');
      if (slot) slot.innerHTML = docHtml(c);
    });
  }

  function docHtml(c) {
    var doc = state.docs[c.id];
    if (!doc || doc.loading) return ATS.loadingHtml('Opening the contract…');
    if (doc.kind === 'pdf') {
      return doc.url
        ? '<iframe class="ats-doc-frame" src="' + ATS.escAttr(doc.url) + '#view=FitH" title="Contract"></iframe>' +
          '<div class="ats-doc-unmatched">This is a PDF, so it is shown as-is — the flagged clauses are listed underneath.</div>'
        : '<div class="ats-doc-missing">Could not open this PDF.</div>';
    }
    if (doc.kind === 'text') {
      var res = highlightContract(doc.text || '', quotesFor(c));
      if (!String(doc.text || '').trim()) return '<div class="ats-doc-missing">This contract has no readable text in it.</div>';
      var note = res.unmatched.length
        ? '<div class="ats-doc-unmatched">' + res.unmatched.length + ' flagged ' + (res.unmatched.length === 1 ? 'clause is' : 'clauses are') + ' listed below but could not be located word-for-word in the text — read them against the contract yourself.</div>'
        : '';
      return '<div class="ats-doc-view">' + res.html + '</div>' + note;
    }
    return '<div class="ats-doc-missing">' + ATS.esc(doc.message || 'No contract file on this row.') + '</div>';
  }

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
  // Exposed for tests (tests/career-contracts-flow.test.js): the highlighter is
  // the only real algorithm in this file — a silent regression there means the
  // CEO reads a contract with nothing marked and assumes it is clean.
  window.__ceoContractHighlight = highlightContract;

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
    // Load the inline contract for whichever card is open. Deliberately only
    // the expanded one — fetching + text-extracting every contract in the list
    // on every render would be a lot of storage reads for documents nobody
    // has asked to see.
    if (state.expanded) {
      var openCard = state.contracts.filter(function (c) { return c.id === state.expanded; })[0];
      if (openCard) ensureDoc(openCard);
    }
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
    var minor = String(d.severity || '').toLowerCase() === 'minor';
    return '' +
      '<div class="ats-detail-field ats-disc-row ' + (minor ? 'minor' : '') + '">' +
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

    // A failed review is a state the CEO can DO something about (the file was
    // unreadable, the AI service errored) — so say it failed and offer the
    // re-run, rather than presenting the failure text as if it were a verdict.
    var reviewFailed = c.ai_review_status === 'error';
    var summaryHtml = review
      ? '<div class="ats-detail-field"><div class="df-lbl">AI summary' + (reviewFailed ? ' — could not complete' : '') + '</div><div class="df-val">' + ATS.esc(review.summary || '—') + '</div></div>'
      : '<div class="ats-detail-field"><div class="df-lbl">AI summary</div><div class="df-val">No AI review has run yet.</div></div>';
    var rerunHtml = (reviewFailed || !review || c.ai_review_status === 'not_run')
      ? '<div style="margin-top:10px"><button type="button" class="ats-btn ats-btn-sm" data-action="rerun_ai" data-contract="' + ATS.escAttr(c.id) + '">Re-run AI review</button></div>'
      : '';

    var termsHtml = review
      ? '<div class="ats-detail-field"><div class="df-lbl">Terms context</div><div class="df-val">' +
          (review.interview_terms_available
            ? 'Compared against the interview summary — it supersedes the advertised terms where they differ.'
            : 'No interview summary on file — compared against the advertised/offer terms only.') +
        '</div></div>'
      : '';

    var discrepanciesHtml = discrepancies.length
      ? '<div class="df-lbl" style="margin:14px 0 4px">Discrepancies — highlighted in red in the contract above</div>' + discrepancies.map(discrepancyRow).join('')
      : (review && !reviewFailed ? '<div class="ats-detail-field"><div class="df-val">The AI found nothing that contradicts the interview or the advertised terms.</div></div>' : '');

    // The contract itself, read INLINE — downloading it was the only way to
    // see it before. The signed-URL links stay as a secondary escape hatch
    // (printing, or a browser that refuses to frame the PDF).
    var readerHtml = '' +
      '<div class="df-lbl" style="margin:16px 0 6px">Contract</div>' +
      '<div data-doc-slot="' + ATS.escAttr(c.id) + '">' + docHtml(c) + '</div>';

    var linkHtml = c.contractUrl
      ? '<a class="ats-btn ats-btn-sm" href="' + ATS.escAttr(c.contractUrl) + '" target="_blank" rel="noopener">Open in a new tab</a>'
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
        changeReqHtml + summaryHtml + rerunHtml + termsHtml +
        readerHtml + discrepanciesHtml +
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
        if (action === 'rerun_ai') { rerunAiReview(contractId); return; }
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

  // Re-run the AI review on a contract whose review failed (e.g. the practice
  // has since re-uploaded a readable file). Clears the cached inline doc so
  // the reader re-fetches and re-highlights against the new verdict.
  function rerunAiReview(contractId) {
    state.busy = true;
    ATS.toast('Re-running the AI review…');
    ATS.api('/api/ceo/contract/ai-check', { method: 'POST', body: { contractId: contractId } }).then(function (d) {
      state.busy = false;
      if (!d || !d.ok) { ATS.toast((d && d.message) || 'Could not re-run the AI review.'); return; }
      delete state.docs[contractId];
      ATS.toast(d.ai_review_status === 'done' ? 'AI review complete.' : 'The AI review could not complete — see the summary.');
      fetchAndRender();
    });
  }

  function submitDecision(contractId, action, note) {
    state.busy = true;
    ATS.api('/api/ceo/contract/decision', { method: 'POST', body: { contractId: contractId, action: action, note: note } }).then(function (d) {
      state.busy = false;
      if (!d || !d.ok) { ATS.toast((d && d.message) || 'Could not update the contract.'); return; }
      ATS.toast(action === 'submit_to_gp' ? 'Sent to the GP.' : 'Returned to the practice.');
      state.expanded = null;
      fetchAndRender();
      // The red "!" on the nav tab must clear the moment the queue empties.
      if (ATS.refreshContractsAlert) ATS.refreshContractsAlert();
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
      if (ATS.refreshContractsAlert) ATS.refreshContractsAlert();
    });
  }

})();

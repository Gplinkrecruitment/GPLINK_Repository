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

    var wanted = collateQuotes(quotes);
    if (!wanted.length) return { html: ATS.esc(raw), unmatched: [] };

    var nm = normaliseWithMap(raw);
    var ranges = [], unmatched = [];
    wanted.forEach(function (w) {
      var from = 0, found = false, guard = 0;
      while (guard++ < 50) {
        var at = nm.norm.indexOf(w.norm, from);
        if (at === -1) break;
        found = true;
        var startOrig = nm.map[at];
        var endOrig = nm.map[at + w.norm.length - 1];
        if (startOrig != null && endOrig != null) ranges.push({ s: startOrig, e: endOrig + 1, idxs: w.idxs.slice() });
        from = at + w.norm.length;
      }
      if (!found) unmatched.push(w.norm);
    });

    if (!ranges.length) return { html: ATS.esc(raw), unmatched: unmatched };

    var merged = mergeRanges(ranges);

    var out = '', cursor = 0;
    merged.forEach(function (rg) {
      out += ATS.esc(raw.slice(cursor, rg.s));
      // data-disc carries which discrepancy (or discrepancies) produced this
      // mark, so clicking a row in the list can scroll straight to it.
      out += '<mark data-disc="' + ATS.escAttr(rg.idxs.join(',')) + '">' + ATS.esc(raw.slice(rg.s, rg.e)) + '</mark>';
      cursor = rg.e;
    });
    out += ATS.esc(raw.slice(cursor));
    return { html: out, unmatched: unmatched };
  }

  // Normalise the quotes ONCE and remember which discrepancy row each one came
  // from. Two rows can quote the same clause (the Erina contract states its
  // hourly rate twice), so a normalised quote maps to a LIST of row indexes.
  function collateQuotes(quotes) {
    var byNorm = {}, order = [];
    (quotes || []).forEach(function (q, i) {
      var n = normaliseQuote(q);
      // Very short fragments ("$180", "GP") would paint the whole document
      // red — a highlight that matches everything highlights nothing.
      if (n.length < 8) return;
      if (!byNorm[n]) { byNorm[n] = { norm: n, idxs: [] }; order.push(byNorm[n]); }
      if (byNorm[n].idxs.indexOf(i) === -1) byNorm[n].idxs.push(i);
    });
    // Longest first, so a short quote nested inside a longer one can't split it.
    return order.sort(function (a, b) { return b.norm.length - a.norm.length; });
  }

  // Merge overlapping/adjacent ranges into one mark, unioning their row indexes.
  function mergeRanges(ranges) {
    ranges.sort(function (a, b) { return a.s - b.s; });
    var merged = [{ s: ranges[0].s, e: ranges[0].e, idxs: ranges[0].idxs.slice() }];
    for (var i = 1; i < ranges.length; i++) {
      var last = merged[merged.length - 1];
      if (ranges[i].s <= last.e) {
        last.e = Math.max(last.e, ranges[i].e);
        ranges[i].idxs.forEach(function (ix) { if (last.idxs.indexOf(ix) === -1) last.idxs.push(ix); });
      } else {
        merged.push({ s: ranges[i].s, e: ranges[i].e, idxs: ranges[i].idxs.slice() });
      }
    }
    return merged;
  }

  // Highlighting inside the RENDERED document. The text version can be marked
  // up as a string, but the rich version is real HTML — wrapping a quote there
  // means walking the DOM's text nodes, because a single clause routinely spans
  // several of them (a bolded dollar amount mid-sentence is its own text node).
  // Naively string-replacing into the HTML would corrupt the tags.
  function applyDomHighlights(root, quotes) {
    if (!root || !quotes || !quotes.length) return { marks: 0, unmatched: [] };

    // Walk ELEMENTS as well as text so block boundaries can be turned into a
    // real break in the flattened string. Without this, "…Guaranteed Hours per
    // week" in one cell and "[____] hours" in the next concatenate as
    // "week[____]" and the clause can never be matched — verified against the
    // real Erina contract, where exactly one of nine quotes was lost this way.
    // The inserted "\n" belongs to no text node, so it simply never falls
    // inside a highlight range; it only restores the word gap for matching.
    var BLOCK_TAGS = /^(P|DIV|LI|UL|OL|TR|TD|TH|TABLE|THEAD|TBODY|TFOOT|H[1-6]|BLOCKQUOTE|HR|SECTION|ARTICLE)$/;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null, false);
    var infos = [], full = '', node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 1) {
        var tag = node.tagName || '';
        if (tag === 'BR' || BLOCK_TAGS.test(tag)) full += '\n';
        continue;
      }
      var v = node.nodeValue || '';
      if (!v) continue;
      infos.push({ node: node, start: full.length, end: full.length + v.length });
      full += v;
    }
    if (!full.trim()) return { marks: 0, unmatched: [] };

    var wanted = collateQuotes(quotes);
    if (!wanted.length) return { marks: 0, unmatched: [] };

    var nm = normaliseWithMap(full);
    var ranges = [], unmatched = [];
    wanted.forEach(function (w) {
      var from = 0, found = false, guard = 0;
      while (guard++ < 50) {
        var at = nm.norm.indexOf(w.norm, from);
        if (at === -1) break;
        found = true;
        var s = nm.map[at], e = nm.map[at + w.norm.length - 1];
        if (s != null && e != null) ranges.push({ s: s, e: e + 1, idxs: w.idxs.slice() });
        from = at + w.norm.length;
      }
      if (!found) unmatched.push(w.norm);
    });
    if (!ranges.length) return { marks: 0, unmatched: unmatched };

    var merged = mergeRanges(ranges);

    // Group the slices by the text node they land in, so each node is rebuilt
    // exactly once — replacing a node mid-loop would invalidate every offset
    // still queued against it.
    var perNode = [];
    infos.forEach(function (info) {
      var pieces = [];
      merged.forEach(function (rg) {
        var s = Math.max(rg.s, info.start), e = Math.min(rg.e, info.end);
        if (s < e) pieces.push({ from: s - info.start, to: e - info.start, idxs: rg.idxs });
      });
      if (pieces.length) perNode.push({ info: info, pieces: pieces });
    });

    var marks = 0;
    perNode.forEach(function (entry) {
      var t = entry.info.node;
      var val = t.nodeValue || '';
      var frag = document.createDocumentFragment();
      var cursor = 0;
      entry.pieces.forEach(function (p) {
        if (p.from > cursor) frag.appendChild(document.createTextNode(val.slice(cursor, p.from)));
        var mk = document.createElement('mark');
        // Which discrepancy row(s) produced this mark — the click-to-jump
        // handler looks it up by this attribute.
        mk.setAttribute('data-disc', p.idxs.join(','));
        mk.textContent = val.slice(p.from, p.to);
        frag.appendChild(mk);
        marks++;
        cursor = p.to;
      });
      if (cursor < val.length) frag.appendChild(document.createTextNode(val.slice(cursor)));
      if (t.parentNode) t.parentNode.replaceChild(frag, t);
    });
    return { marks: marks, unmatched: unmatched };
  }

  /* =====================================================================
   *  CLICK A DISCREPANCY → JUMP TO IT IN THE CONTRACT
   *  Owner request 2026-08-05. The findings list sits below a long scrolling
   *  document; without this you read "the Contractor will receive not less
   *  than $170.00…" and then hunt for it by eye.
   * ===================================================================== */
  function jumpToDiscrepancy(contractId, index) {
    var slot = document.querySelector('[data-doc-slot="' + cssEscape(contractId) + '"]');
    if (!slot) return;
    var pane = slot.querySelector('.ats-doc-view');
    var doc = state.docs[contractId];

    if (!pane) {
      // A PDF renders inside an <iframe> we cannot reach into or scroll.
      ATS.toast(doc && doc.kind === 'pdf'
        ? 'This contract is a PDF — open it to find the clause.'
        : 'The contract is still loading.');
      return;
    }

    // Marks carry a comma-separated list because one clause can be quoted by
    // more than one finding — match on the exact index, not a substring.
    var marks = pane.querySelectorAll('mark[data-disc]');
    var target = null;
    for (var i = 0; i < marks.length; i++) {
      var list = String(marks[i].getAttribute('data-disc') || '').split(',');
      if (list.indexOf(String(index)) !== -1) { target = marks[i]; break; }
    }
    if (!target) {
      ATS.toast('That clause could not be located word-for-word in the contract — read it against the document.');
      return;
    }

    // Scroll the PANE, not the page: getBoundingClientRect deltas work no
    // matter how deeply the mark is nested (table cells are positioned, so
    // offsetTop would be measured against the wrong ancestor).
    var pRect = pane.getBoundingClientRect();
    var tRect = target.getBoundingClientRect();
    // A third of the way down the pane, so the clause lands where the eye is
    // rather than jammed against the top edge.
    var wantTop = Math.max(0, pane.scrollTop + (tRect.top - pRect.top) - (pane.clientHeight / 3));
    var startTop = pane.scrollTop;
    try {
      if (pane.scrollTo) pane.scrollTo({ top: wantTop, behavior: 'smooth' });
      else pane.scrollTop = wantTop;
    } catch (e) { pane.scrollTop = wantTop; }
    // 🧨 `behavior:'smooth'` is silently IGNORED by some engines (verified: it
    // is a complete no-op in headless Chrome, while scrollTop and
    // behavior:'auto' both work). Landing on the clause matters more than the
    // animation, so if nothing has moved shortly after, jump there outright.
    // Checking "moved at all" rather than "arrived" leaves a real smooth
    // scroll mid-animation untouched.
    setTimeout(function () {
      if (pane.scrollTop === startTop && startTop !== wantTop) pane.scrollTop = wantTop;
    }, 250);

    // Flash it, so it's obvious WHICH highlight was meant when several sit
    // close together.
    for (var j = 0; j < marks.length; j++) marks[j].classList.remove('is-target');
    target.classList.add('is-target');
    if (jumpToDiscrepancy._t) clearTimeout(jumpToDiscrepancy._t);
    jumpToDiscrepancy._t = setTimeout(function () { target.classList.remove('is-target'); }, 2200);
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
      paintDoc(c);
    });
  }

  // Write the reader into its slot, then run the DOM highlight pass. The rich
  // (rendered Word) view can only be highlighted after it is in the document,
  // so painting and highlighting always happen together — never innerHTML alone.
  function paintDoc(c) {
    var slot = document.querySelector('[data-doc-slot="' + cssEscape(c.id) + '"]');
    if (!slot) return;
    slot.innerHTML = docHtml(c);
    var rich = slot.querySelector('[data-doc-rich]');
    if (!rich) return;
    var res = applyDomHighlights(rich, quotesFor(c));
    var note = slot.querySelector('[data-doc-note]');
    if (note && res.unmatched.length) {
      note.textContent = res.unmatched.length + ' flagged '
        + (res.unmatched.length === 1 ? 'clause is' : 'clauses are')
        + ' listed below but could not be located word-for-word in the document — read them against the contract yourself.';
    }
  }

  function docHtml(c) {
    var doc = state.docs[c.id];
    if (!doc || doc.loading) return ATS.loadingHtml('Opening the contract…');
    if (doc.kind === 'html') {
      // The document as Word actually formats it — headings, bold, tables,
      // embedded images. Server-sanitised to an allow-list before it gets here.
      return '<div class="ats-doc-view ats-doc-rich" data-doc-rich="1">' + doc.html + '</div>' +
             '<div class="ats-doc-unmatched" data-doc-note></div>';
    }
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
  // The DOM variant needs a real browser to exercise (this repo has no jsdom),
  // so it is verified with headless Chrome against the real rendered contract.
  window.__ceoContractDomHighlight = applyDomHighlights;
  window.__ceoContractJump = jumpToDiscrepancy;

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
      if (openCard) {
        ensureDoc(openCard);
        // Already cached (re-render after a toggle): detailHtml embedded the
        // markup but nothing has highlighted it yet — that pass only runs here.
        var cached = state.docs[openCard.id];
        if (cached && !cached.loading) paintDoc(openCard);
      }
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

  // `i` is the discrepancy's position in ai_review.discrepancies — the same
  // number stamped onto its <mark> in the document, which is what makes
  // click-to-jump possible. Rendered as a real button role + tabindex so it is
  // reachable by keyboard, not mouse-only.
  function discrepancyRow(d, i, contractId) {
    d = d || {};
    var minor = String(d.severity || '').toLowerCase() === 'minor';
    return '' +
      '<div class="ats-detail-field ats-disc-row ' + (minor ? 'minor' : '') + '"' +
        ' data-jump-disc="' + ATS.escAttr(String(i)) + '" data-jump-contract="' + ATS.escAttr(contractId) + '"' +
        ' role="button" tabindex="0" title="Jump to this clause in the contract">' +
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
      ? '<div class="df-lbl" style="margin:14px 0 4px">Discrepancies — click one to jump to it in the contract above</div>' +
        discrepancies.map(function (d, i) { return discrepancyRow(d, i, c.id); }).join('')
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
    // 🧨 Attach ONCE. loadContractsTab() runs every time the master-tab
    // switcher opens the Contracts tab, but #panel-contracts is a PERSISTENT
    // element — so each visit stacked another delegated click listener on it.
    // With two listeners a single click ran the toggle twice: expand, then
    // immediately collapse, so the card looked completely dead. An even number
    // of visits broke it, an odd number appeared to fix it, which is why it
    // came and went. Owner report 2026-08-05: "nothing happens when i click
    // the card". Present since the tab's first commit (64125b2).
    if (el.__gpContractsWired) return;
    el.__gpContractsWired = true;

    el.addEventListener('click', function (e) {
      // Checked BEFORE the card toggle: a discrepancy row sits inside the open
      // card, so falling through would collapse the very card you're reading.
      var jump = e.target.closest ? e.target.closest('[data-jump-disc]') : null;
      if (jump) {
        e.stopPropagation();
        jumpToDiscrepancy(jump.getAttribute('data-jump-contract'), jump.getAttribute('data-jump-disc'));
        return;
      }

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

    // Keyboard parity for the jump rows — they present as buttons (role +
    // tabindex), so Enter and Space must do what a click does.
    el.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      var jump = e.target.closest ? e.target.closest('[data-jump-disc]') : null;
      if (!jump) return;
      e.preventDefault();
      jumpToDiscrepancy(jump.getAttribute('data-jump-contract'), jump.getAttribute('data-jump-disc'));
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

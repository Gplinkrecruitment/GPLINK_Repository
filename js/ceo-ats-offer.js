/* ============================================================================
 * ceo-ats-offer.js — the post-interview OFFER band on the candidate card.
 *
 * Classic <script> (no module). Loaded by pages/ceo-dashboard.html AFTER the
 * page inline script, AFTER /js/ceo-ats-shared.js (window.ATS) and alongside
 * /js/ceo-ats-candidates.js.
 *
 * WHY THIS EXISTS (owner, 2026-07-31). Everything that happens after the
 * interview lived on a separate Contracts tab, so the candidate card could not
 * answer the questions staff actually ask while looking at a doctor:
 *   1. what did the practice do after the interview — and how long ago?
 *   2. what is in the uploaded contract, and what did the AI review make of it?
 *   3. has the doctor got it yet, and how long has he been sitting on it?
 *   4. which versions came before this one?
 *   5. if the practice said no, is this doctor out of the offer pipeline?
 * The band answers all of them in one place, in the same visual language as
 * the .cr-strip action band directly beneath it (css/ceo-ats.css).
 *
 * Lazily hydrated exactly like the interview slot picker
 * (window.atsRenderSlotPicker): applicationsCardInner() in
 * js/ceo-ats-candidates.js renders an empty placeholder and wireDetailEvents()
 * calls in here, so a card with ten applications does ten small fetches only
 * when the drawer is actually open.
 *
 * Data:   GET  /api/ats/application/offer-state?applicationId=<uuid>
 * Actions POST /api/ceo/contract/decision         (submit_to_gp | return_to_practice)
 *         POST /api/ceo/contract/change-decision  (release_to_practice | decline_change)
 *         POST /api/ceo/contract/ai-check         (re-run the AI review)
 *         POST /api/ats/contract/nudge            (chase whoever has the ball)
 *
 * Exposes window.atsRenderOfferBand(applicationId, containerEl, caseId).
 * ========================================================================== */
(function () {
  'use strict';

  var ATS = window.ATS;
  if (!ATS) return;

  /* =====================================================================
   *  ONE elapsed-time formatter (owner's ask: "the amount of time that has
   *  lapsed"). EVERY "how long has this been sitting" number in this file
   *  comes through here — the endpoint's precomputed day counts and any raw
   *  ISO stamp alike — so the band can never say "5 days" on one line and
   *  "4d" on the next. This is the only place in the module that is allowed
   *  to divide by a day in milliseconds.
   * ===================================================================== */
  var MS_PER_DAY = 86400000;

  // days: the server's precomputed whole-day count (preferred — it is the
  // number the reminder crons and escalation rules are keyed off).
  // iso:  a fallback timestamp for when the server did not send a count.
  function elapsedDays(days, iso) {
    var n = Number(days);
    if (days !== null && days !== undefined && days !== '' && isFinite(n)) return Math.max(0, Math.floor(n));
    if (!iso) return null;
    var t = new Date(iso).getTime();
    if (!t || isNaN(t)) return null;
    return Math.max(0, Math.floor((Date.now() - t) / MS_PER_DAY));
  }

  // '' | 'today' | '1 day' | '5 days'
  function elapsedLabel(days, iso) {
    var n = elapsedDays(days, iso);
    if (n === null) return '';
    if (n <= 0) return 'today';
    return n === 1 ? '1 day' : n + ' days';
  }

  // "Uploaded <b>5 days</b> ago" / "Uploaded <b>today</b>".
  // `prefix` is always a literal from this file, never user input.
  function agoHtml(prefix, days, iso) {
    var label = elapsedLabel(days, iso);
    if (!label) return '';
    return prefix + ' <b class="ats-ob-days">' + label + '</b>' + (label === 'today' ? '' : ' ago');
  }

  /* ---- Escalation cues (owner, 2026-07-31) ----
   * Past 7 days waiting on the practice, or past 5 waiting on the doctor, the
   * band turns amber and says it needs a personal chase — the same wording
   * the waiting-on-practice tracker already uses (waitingRowHtml in
   * js/ceo-ats-candidates.js). */
  var PRACTICE_CHASE_DAYS = 7;
  var GP_CHASE_DAYS = 5;
  function chaseHtml(days) {
    return '<span class="ats-ob-warn">⚠ no reply after ' + days + ' days — chase personally</span>';
  }

  /* ---- Contract lifecycle status → pill tone.
   * The LABEL always comes from the endpoint (statusLabel) so the band and the
   * Contracts tab cannot drift; only the colour is decided here. */
  var STATUS_TONE = {
    awaiting_upload: 'muted',
    uploaded: 'amber',
    sent_to_gp: 'blue',
    changes_requested: 'red',
    practice_review: 'purple',
    signed: 'green',
    void: 'muted'
  };
  function statusTone(s) { return STATUS_TONE[s] || 'muted'; }
  function statusLabel(c) {
    return c.statusLabel || String(c.status || '—').replace(/_/g, ' ');
  }

  /* ---- AI verdict → pill (aligned=green, minor_gaps=amber,
   * major_discrepancies=red, unreadable=muted). */
  var VERDICT_META = {
    aligned: { label: 'Aligned', mod: 'green' },
    minor_gaps: { label: 'Minor gaps', mod: 'amber' },
    major_discrepancies: { label: 'Major discrepancies', mod: 'red' },
    unreadable: { label: 'Unreadable', mod: 'muted' }
  };

  /* ---- Role gate.
   * /api/ceo/contract/* is CEO-only today. A consultant must not be shown a
   * button that can only ever fail, so the contract ACTIONS are hidden up
   * front — and if the server refuses anyway (the guard may be widened or
   * tightened server-side), the handler says why rather than leaving a dead
   * button. ATS.api parses the JSON body and drops the HTTP status, so the
   * refusal message is the only signal we get back. */
  function isConsultant() { return !!(ATS.isConsultant && ATS.isConsultant()); }
  var ROLE_DENIED_MSG = 'Your role can’t do this — a CEO account has to action the contract.';
  function isPermissionError(res) {
    if (!res || res.ok) return false;
    if (res.status === 401 || res.status === 403) return true;
    return /access required|super admin|forbidden|not authoris|not authoriz/i.test(String(res.message || res.error || ''));
  }
  function failToast(res, fallback) {
    ATS.toast(isPermissionError(res) ? ROLE_DENIED_MSG : ((res && (res.message || res.error)) || fallback));
  }

  /* ---- Who has the ball.
   * Mirrors the branch inside POST /api/ats/contract/nudge so the band never
   * offers a chase the endpoint would answer with 409 nothing_to_nudge. */
  function nudgeTarget(d) {
    if (d.outOfPipeline) return '';
    var c = d.contract;
    var history = d.history || [];
    if (!c) return history.length ? '' : 'practice'; // only void rows left → nobody
    if (c.status === 'awaiting_upload') return 'practice';
    if (c.status === 'sent_to_gp' || c.status === 'changes_requested') return 'gp';
    if (c.status === 'practice_review') return 'practice';
    return '';
  }

  /* =====================================================================
   *  MARKUP
   * ===================================================================== */
  function line(inner) { return '<div class="ats-ob-line">' + inner + '</div>'; }
  function btn(cls, action, attrs, label) {
    return '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm ' + cls + '" data-ob-action="' + action + '"' +
      (attrs || '') + '>' + label + '</button>';
  }

  /* ---- 1. What the practice did after the interview ---- */
  function practiceLineHtml(d) {
    var p = d.practice || {};
    var days = elapsedDays(p.daysSinceEmail, p.emailSentAt);
    var reminders = Number(p.remindersSent || 0);
    var who = p.name ? ATS.esc(p.name) : 'The practice';

    if (p.decision === 'declined') {
      // Terminal. Say it plainly — no actions beyond looking at the history.
      var reason = String(p.declineReason || '').trim();
      return line(
        '<span class="ats-pill red">Practice declined</span>' +
        '<span class="ats-ob-txt">' + who + ' decided not to proceed after the interview' +
          (reason ? ' — “' + ATS.esc(reason) + '”' : '') + '. ' +
          '<b class="ats-ob-out">This doctor has left the offer pipeline for this application.</b>' +
          (p.emailSentAt ? ' <span class="ats-ob-since">' + agoHtml('Post-interview email sent', p.daysSinceEmail, p.emailSentAt) + '</span>' : '') +
        '</span>'
      );
    }

    if (p.decision === 'extended') {
      return line(
        '<span class="ats-pill green">Practice extended an offer</span>' +
        '<span class="ats-ob-txt">' + who +
          (p.emailSentAt ? ' · ' + agoHtml('post-interview email sent', p.daysSinceEmail, p.emailSentAt) : '') +
        '</span>'
      );
    }

    // awaiting
    var chase = days !== null && days >= PRACTICE_CHASE_DAYS;
    var bits = [];
    if (p.emailSentAt) bits.push(agoHtml('Post-interview email sent', p.daysSinceEmail, p.emailSentAt));
    else if (p.interviewCompletedAt) bits.push(agoHtml('Interview completed', null, p.interviewCompletedAt) + ' — the post-interview email has not gone out yet');
    else bits.push('No post-interview email on file yet');
    bits.push(reminders + ' reminder' + (reminders === 1 ? '' : 's') + ' sent');
    if (p.lastReminderAt) bits.push(agoHtml('last chased', null, p.lastReminderAt));
    return line(
      '<span class="ats-pill ' + (chase ? 'amber' : 'blue') + '">Awaiting the practice</span>' +
      '<span class="ats-ob-txt">' + bits.join(' · ') + '</span>' +
      (chase ? chaseHtml(PRACTICE_CHASE_DAYS) : '')
    );
  }

  /* ---- 2 + 3 + 4. The contract itself, its clock, and what to do with it ---- */
  function contractLineHtml(d) {
    var c = d.contract;
    var p = d.practice || {};
    if (!c) {
      if (p.decision === 'declined') return '';
      // While the practice is still deciding, the row above already says so —
      // a second "no contract yet" line is noise. It earns its place only
      // once there ARE discarded versions to explain.
      if (!(d.history && d.history.length)) return '';
      return line('<span class="ats-pill muted">No live contract</span>' +
        '<span class="ats-ob-txt">Every version below has been discarded — the practice has not re-uploaded.</span>');
    }

    var cid = ATS.escAttr(String(c.id || ''));
    var consultant = isConsultant();

    // The clock that matters right now: with the doctor → how long since he
    // received it (the owner's question 4); otherwise → since the upload.
    var withGp = c.status === 'sent_to_gp' || c.status === 'changes_requested';
    var gpDays = elapsedDays(c.daysSinceSentToGp, c.sentToGpAt);
    var chase = withGp && gpDays !== null && gpDays >= GP_CHASE_DAYS;
    var when = '';
    if (c.status === 'signed' && c.signedAt) when = agoHtml('Signed', null, c.signedAt);
    else if (withGp) when = agoHtml('The doctor received it', c.daysSinceSentToGp, c.sentToGpAt);
    if (!when) when = agoHtml('Uploaded by the practice', c.daysSinceUploaded, c.uploadedAt);
    if (!when) when = 'No dates recorded on this version.';

    var links = '';
    if (c.fileUrl) {
      links += '<a class="ats-btn ats-btn-ghost ats-btn-sm ats-ob-view" href="' + ATS.escAttr(String(c.fileUrl)) + '" target="_blank" rel="noopener">View contract</a>';
    } else {
      links += '<span class="ats-ob-txt">No file on this version.</span>';
    }
    if (c.signedFileUrl) {
      links += '<a class="ats-btn ats-btn-ghost ats-btn-sm ats-ob-view" href="' + ATS.escAttr(String(c.signedFileUrl)) + '" target="_blank" rel="noopener">View signed copy</a>';
    }

    // CEO-only decisions. `submit_to_gp` is only legal on an 'uploaded' row
    // (the server enforces it too); the change-request triage only on a
    // 'changes_requested' one.
    var acts = '';
    if (!consultant) {
      if (c.status === 'uploaded') {
        acts += '<button type="button" class="ats-btn ats-btn-primary ats-btn-sm ats-ob-act" data-ob-action="submit_to_gp" data-contract-id="' + cid + '">Release to the doctor</button>';
      }
      if (c.status === 'uploaded' || c.status === 'changes_requested') {
        acts += btn('ats-ob-act', 'return_to_practice', ' data-contract-id="' + cid + '"', 'Return to the practice');
      }
      if (c.status === 'changes_requested') {
        acts += btn('ats-ob-act', 'release_to_practice', ' data-contract-id="' + cid + '"', 'Release change to the practice');
        acts += btn('ats-ob-act ats-danger-ghost', 'decline_change', ' data-contract-id="' + cid + '"', 'Decline change');
      }
    }

    var note = (!consultant && acts)
      ? '<input type="text" class="ats-ob-note" data-note-for="' + cid + '" placeholder="Note for the practice or the doctor (optional)">'
      : '';

    // A consultant sees the whole picture but none of the buttons — say why,
    // rather than leaving an actionable contract looking like a dead end.
    var roleNote = (consultant && (c.status === 'uploaded' || c.status === 'changes_requested'))
      ? line('<span class="ats-pill muted">CEO decision</span>' +
          '<span class="ats-ob-txt">Releasing this contract, returning it to the practice, or re-running the AI check is a CEO action.</span>')
      : '';

    var changeReq = c.changeRequest
      ? line('<span class="ats-pill red">Doctor requested changes</span><span class="ats-ob-txt">“' + ATS.esc(c.changeRequest) + '”</span>')
      : '';
    var changeRes = c.changeResponse
      ? line('<span class="ats-pill muted">Practice replied</span><span class="ats-ob-txt">“' + ATS.esc(c.changeResponse) + '”</span>')
      : '';
    var ceoNote = c.ceoNote
      ? line('<span class="ats-pill muted">Your note</span><span class="ats-ob-txt">' + ATS.esc(c.ceoNote) + '</span>')
      : '';

    return line(
      '<span class="ats-pill ' + statusTone(c.status) + '">v' + ATS.esc(String(c.version || 1)) + ' · ' + ATS.esc(statusLabel(c)) + '</span>' +
      '<span class="ats-ob-txt">' + when + '</span>' +
      (chase ? chaseHtml(GP_CHASE_DAYS) : '') +
      '<span class="ats-ob-btns">' + links + acts + '</span>'
    ) + (note ? line(note) : '') + roleNote + changeReq + changeRes + ceoNote;
  }

  /* ---- The AI review verdict + its discrepancies ---- */
  function aiLineHtml(d) {
    var c = d.contract;
    if (!c) return '';
    var ai = c.ai || {};
    var cid = ATS.escAttr(String(c.id || ''));
    var st = String(ai.status || 'not_run');
    var rerun = isConsultant() ? '' :
      btn('ats-ob-act', 'ai_check', ' data-contract-id="' + cid + '"', st === 'not_run' ? 'Run the AI check' : 'Re-run AI check');
    var rerunBtns = rerun ? ('<span class="ats-ob-btns">' + rerun + '</span>') : '';

    if (st === 'running') {
      return line('<span class="ats-pill blue">AI check running…</span>' +
        '<span class="ats-ob-txt">Reopen the card in a moment to see the verdict.</span>');
    }
    // This was the real gap: a contract whose AI review errored showed nothing
    // at all and had no retry, so it silently read as "no discrepancies".
    if (st === 'error') {
      return line('<span class="ats-pill red">AI check failed</span>' +
        '<span class="ats-ob-txt">Nothing was compared against the agreed terms — read the contract yourself or run the check again.</span>' +
        rerunBtns);
    }
    if (st === 'not_run') {
      return line('<span class="ats-pill muted">AI check not run</span>' +
        '<span class="ats-ob-txt">This contract has never been compared against the interview / advertised terms.</span>' +
        rerunBtns);
    }

    var vm = VERDICT_META[ai.overall] || { label: 'No verdict', mod: 'muted' };
    var terms = ai.interviewTermsAvailable
      ? 'Compared against the interview summary — it supersedes the advertised terms where they differ.'
      : 'No interview summary on file — compared against the advertised / offer terms only.';
    var head = line(
      '<span class="ats-pill ' + vm.mod + '">AI: ' + ATS.esc(vm.label) + '</span>' +
      '<span class="ats-ob-txt">' + ATS.esc(ai.summary || terms) + '</span>' +
      rerunBtns
    );

    var list = Array.isArray(ai.discrepancies) ? ai.discrepancies : [];
    if (!list.length) return head;
    return head + '<div class="ats-ob-discs">' + list.map(function (x) {
      x = x || {};
      return '<div class="ats-ob-disc">' +
        '<span class="ats-ob-disc-h">' + ATS.esc(x.field || 'Unspecified') + ' · ' + ATS.esc(x.severity || 'unrated') + '</span>' +
        '<span class="ats-ob-disc-b">contract says ' + ATS.esc(x.contract_says || '—') +
          ' / expected ' + ATS.esc(x.expected || '—') +
          (x.source ? ' <span class="ats-ob-disc-src">(' + ATS.esc(x.source) + ')</span>' : '') +
        '</span>' +
      '</div>';
    }).join('') + '</div>';
  }

  /* ---- Contract iterations: every superseded version, collapsed ----
   * Omitted entirely when the live version is the only one — an "Earlier
   * versions (0)" line is noise. */
  function historyHtml(d) {
    var all = Array.isArray(d.history) ? d.history : [];
    var earlier = all.filter(function (h) { return !h.isLive; });
    if (!earlier.length) return '';
    return '<details class="ats-ob-versions">' +
      '<summary>Earlier versions (' + earlier.length + ')</summary>' +
      earlier.map(function (h) {
        return '<div class="ats-ob-ver">' +
          '<span class="ats-pill ' + statusTone(h.status) + '">v' + ATS.esc(String(h.version || 0)) + '</span> ' +
          ATS.esc(h.statusLabel || String(h.status || '—').replace(/_/g, ' ')) +
          ' · ' + agoHtml('updated', null, h.updatedAt || h.createdAt) +
        '</div>';
      }).join('') +
    '</details>';
  }

  /* ---- The nudge, and the out-of-pipeline notice ---- */
  function nudgeLineHtml(d, applicationId) {
    if (d.outOfPipeline && (d.practice || {}).decision !== 'declined') {
      return line('<span class="ats-pill muted">Out of the offer pipeline</span>' +
        '<span class="ats-ob-txt">This application is closed — nothing here is actionable. Earlier versions stay listed below.</span>');
    }
    var target = nudgeTarget(d);
    if (!target) return '';
    return line('<span class="ats-ob-btns ats-ob-nudge-wrap">' +
      btn('ats-ob-nudge', 'nudge', ' data-app-id="' + ATS.escAttr(String(applicationId)) + '"',
        target === 'gp' ? 'Nudge the doctor' : 'Nudge the practice') +
    '</span>');
  }

  function bandHtml(d, applicationId) {
    var p = d.practice || {};
    var c = d.contract;
    var tone = 'blue';
    if (p.decision === 'declined') tone = 'red';
    else if (c && c.status === 'signed') tone = 'green';
    else if (d.outOfPipeline) tone = 'muted';
    else {
      var pDays = elapsedDays(p.daysSinceEmail, p.emailSentAt);
      var gDays = c ? elapsedDays(c.daysSinceSentToGp, c.sentToGpAt) : null;
      var waitingPractice = p.decision === 'awaiting' && pDays !== null && pDays >= PRACTICE_CHASE_DAYS;
      var waitingGp = c && (c.status === 'sent_to_gp' || c.status === 'changes_requested') && gDays !== null && gDays >= GP_CHASE_DAYS;
      if (waitingPractice || waitingGp || (c && c.status === 'uploaded')) tone = 'amber';
    }
    return '<div class="ats-offer-band tone-' + tone + '" data-offer-band-app="' + ATS.escAttr(String(applicationId)) + '">' +
      practiceLineHtml(d) +
      contractLineHtml(d) +
      aiLineHtml(d) +
      nudgeLineHtml(d, applicationId) +
      historyHtml(d) +
    '</div>';
  }

  /* =====================================================================
   *  ACTIONS
   * ===================================================================== */
  // Everything the two CEO decision endpoints accept, with the confirm copy
  // and the toast that follows. Keeping them in one table is what stops a
  // button drifting away from the endpoint it is supposed to call.
  var DECISION_ACTIONS = {
    submit_to_gp: {
      path: '/api/ceo/contract/decision',
      confirm: 'Release this contract to the doctor? They’ll be emailed a link to read and sign it.',
      done: 'Released — the doctor has been sent the contract.',
      fail: 'Could not release the contract to the doctor.'
    },
    return_to_practice: {
      path: '/api/ceo/contract/decision',
      confirm: 'Return this contract to the practice for changes?',
      done: 'Returned to the practice.',
      fail: 'Could not return the contract to the practice.'
    },
    release_to_practice: {
      path: '/api/ceo/contract/change-decision',
      confirm: 'Send the doctor’s change request to the practice for consent?',
      done: 'Released to the practice for consent.',
      fail: 'Could not release the change to the practice.'
    },
    decline_change: {
      path: '/api/ceo/contract/change-decision',
      confirm: 'Decline this change and hand the contract back to the doctor exactly as sent?',
      done: 'Declined — sent back to the doctor.',
      fail: 'Could not decline the change.'
    }
  };

  function noteFor(containerEl, contractId) {
    var el = containerEl.querySelector('.ats-ob-note[data-note-for="' + String(contractId).replace(/["\\]/g, '\\$&') + '"]');
    return el ? el.value : '';
  }

  function runDecision(action, contractId, ctx, button) {
    var meta = DECISION_ACTIONS[action];
    if (!meta || !contractId) return;
    if (!window.confirm(meta.confirm)) return;
    var label = button ? button.textContent : '';
    if (button) { button.disabled = true; button.textContent = 'Working…'; }
    ATS.api(meta.path, {
      method: 'POST',
      body: { contractId: contractId, action: action, note: noteFor(ctx.containerEl, contractId) }
    }).then(function (res) {
      if (res && res.ok) { ATS.toast(meta.done); refreshCard(ctx); return; }
      failToast(res, meta.fail);
      if (button) { button.disabled = false; button.textContent = label; }
    });
  }

  function runAiCheck(contractId, ctx, button) {
    if (!contractId) return;
    var label = button ? button.textContent : '';
    if (button) { button.disabled = true; button.textContent = 'Checking…'; }
    ATS.api('/api/ceo/contract/ai-check', { method: 'POST', body: { contractId: contractId } }).then(function (res) {
      if (res && res.ok) { ATS.toast('AI check re-run.'); refreshCard(ctx); return; }
      failToast(res, 'Could not re-run the AI check.');
      if (button) { button.disabled = false; button.textContent = label; }
    });
  }

  function runNudge(applicationId, ctx, button) {
    if (!applicationId) return;
    var label = button ? button.textContent : '';
    if (button) { button.disabled = true; button.textContent = 'Sending…'; }
    ATS.api('/api/ats/contract/nudge', { method: 'POST', body: { applicationId: String(applicationId) } }).then(function (res) {
      if (res && res.ok) {
        ATS.toast(res.target === 'gp' ? 'Reminder emailed to the doctor.' : 'Reminder emailed to the practice.');
        refreshCard(ctx);
        return;
      }
      // The endpoint's two designed refusals read as plain English, not codes.
      if (res && res.code === 'too_soon') {
        var mins = Number(res.retryAfterMinutes || 0);
        ATS.toast('Already nudged recently — you can chase again in about ' +
          (mins >= 60 ? Math.round(mins / 60) + ' hour' + (Math.round(mins / 60) === 1 ? '' : 's') : Math.max(1, mins) + ' minutes') + '.');
      } else if (res && res.code === 'nothing_to_nudge') {
        ATS.toast('There is nobody to chase on this application right now.');
      } else {
        failToast(res, 'Could not send the reminder.');
      }
      if (button) { button.disabled = false; button.textContent = label; }
    });
  }

  /* After any successful action, show the result where the user is standing —
     the same convention every other in-card action follows
     (refreshAfterAppAction in js/ceo-ats-candidates.js). Falls back to
     re-rendering just this band if the candidates module isn't loaded. */
  function refreshCard(ctx) {
    if (window.refreshPipelineWidget) window.refreshPipelineWidget();
    if (typeof window.atsRefreshAfterAppAction === 'function') {
      window.atsRefreshAfterAppAction(ctx.caseId ? { case_id: ctx.caseId } : null);
      return;
    }
    if (ctx.caseId && window.atsOpenCandidate) { window.atsOpenCandidate(ctx.caseId); return; }
    window.atsRenderOfferBand(ctx.applicationId, ctx.containerEl, ctx.caseId);
  }

  /* =====================================================================
   *  PUBLIC ENTRY POINT
   *  applicationId — gp_applications.id
   *  containerEl   — the placeholder rendered by applicationsCardInner()
   *  caseId        — (optional) refreshes the candidate drawer after an action
   * ===================================================================== */
  window.atsRenderOfferBand = function (applicationId, containerEl, caseId) {
    if (!containerEl || !applicationId) return;
    var ctx = { applicationId: applicationId, containerEl: containerEl, caseId: caseId };

    // Never an empty box: a quiet loading line first, an error + Retry on
    // failure, the band otherwise.
    containerEl.innerHTML = '<span class="ats-ob-loading">Loading the offer…</span>';

    // Wire the delegated handler ONCE — this function re-renders the same
    // container after every action, and the listener lives on the container
    // rather than the buttons (same trap the slot picker hit: without the
    // guard one click would fire two requests).
    if (!containerEl.__atsOfferWired) {
      containerEl.__atsOfferWired = true;
      containerEl.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-ob-action]') : null;
        if (!b || b.disabled) return;
        e.stopPropagation();
        var action = b.getAttribute('data-ob-action');
        if (action === 'retry') { window.atsRenderOfferBand(applicationId, containerEl, caseId); return; }
        if (action === 'nudge') { runNudge(b.getAttribute('data-app-id') || applicationId, ctx, b); return; }
        if (action === 'ai_check') { runAiCheck(b.getAttribute('data-contract-id'), ctx, b); return; }
        if (DECISION_ACTIONS[action]) { runDecision(action, b.getAttribute('data-contract-id'), ctx, b); return; }
      });
    }

    ATS.api('/api/ats/application/offer-state?applicationId=' + encodeURIComponent(applicationId)).then(function (d) {
      if (!d || !d.ok) {
        containerEl.innerHTML = '<span class="ats-ob-err">' +
          ATS.esc((d && (d.message || d.error)) || 'Could not load the offer state.') + '</span> ' +
          btn('ats-ob-retry', 'retry', '', 'Retry');
        return;
      }
      containerEl.innerHTML = bandHtml(d, applicationId);
    });
  };

  // Exposed for reuse (and so there is provably ONE elapsed formatter).
  window.atsOfferElapsedLabel = elapsedLabel;

})();

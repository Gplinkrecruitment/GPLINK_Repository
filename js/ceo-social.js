/* ============================================================================
 * ceo-social.js — the CEO's monthly social review.
 *
 * A generator uploads ~60 creatives for a month. This screen is the gate: every
 * image and caption has to be approved or rejected before anything can be
 * scheduled, and the Approve button stays disabled until that is true. Approval
 * is what stamps the schedule, so nothing can go out unreviewed by construction.
 *
 * Registers window.loadSocialTab() for the master-tab switcher.
 * ========================================================================== */
(function () {
  'use strict';

  var A = window.ATS || {};
  var esc = A.esc || function (s) { return String(s == null ? '' : s); };

  var state = { month: null, campaign: null, posts: [], summary: null, config: [], loading: false };

  // 🧨 #panel-social is a PERSISTENT element in ceo-dashboard.html — renderInner()
  // only replaces its innerHTML, never the node. So attaching the delegated click
  // handler inside wire() (which runs on every render) stacked one more listener
  // every time. Measured in a real browser: the POSTs and toasts one Approve click
  // produced DOUBLED each time — 1, 2, 4, 8, 16 — which is the column of "Approved"
  // toasts the owner saw, plus 16 identical writes to the server. Attach once.
  // Same trap that made the Contracts card refuse to open (stacked toggles
  // cancelling each other); ceo-ats-matching.js already guards it this way.
  var panelWired = false;

  // Post ids with a decision in flight, so a double-click cannot double-post.
  var inFlight = {};

  // The captions the LAST render painted, keyed by post id. This is the baseline
  // that tells "the owner has unsaved edits" apart from "the server's copy moved
  // on" when restoring state across a re-render.
  var lastPainted = {};

  function el() { return document.getElementById('panel-social'); }

  function statusPill(status) {
    var map = {
      draft: ['amber', 'Needs review'],
      approved: ['green', 'Approved'],
      rejected: ['muted', 'Rejected'],
      posted: ['blue', 'Posted'],
      failed: ['red', 'Failed'],
      skipped: ['muted', 'Skipped']
    };
    var m = map[status] || ['muted', status || '—'];
    return '<span class="ats-pill ' + m[0] + '">' + esc(m[1]) + '</span>';
  }

  function fmtWhen(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('en-AU', {
        weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
      });
    } catch (e) { return String(iso); }
  }

  // The image route caches for a day and its URL is keyed only on the post id,
  // so replacing a creative on an existing row left every reviewer looking at
  // the old picture with no way to tell. Version the URL by the row's
  // updated_at: a replaced image is a new URL, an unchanged one still hits cache.
  // The server ignores the extra parameter, so the canonical URL Meta fetches at
  // publish time is unaffected.
  function imgUrl(post) {
    var v = post.updated_at || post.created_at || '';
    return '/api/public/social-image?id=' + encodeURIComponent(post.id) +
      (v ? '&v=' + encodeURIComponent(String(v).replace(/[^0-9]/g, '').slice(0, 14)) : '');
  }

  // ── rendering ────────────────────────────────────────────────────────────
  // The master-tab switcher calls the loader inside a try/catch, so anything
  // thrown in here used to surface as a silently blank panel with the error only
  // in the console. A blank tab is indistinguishable from "no data", which costs
  // far more to diagnose than it should. Every failure now paints itself.
  function render() {
    try {
      renderInner();
    } catch (err) {
      var root = el();
      if (!root) return;
      root.innerHTML = '<div class="content" style="padding:32px">' +
        '<div class="soc-warn"><strong>The Social tab hit an error while drawing.</strong><br>' +
        esc(String((err && err.message) || err)) +
        '<br><br>The data loaded fine, so this is a display problem. Send this message over ' +
        'and it can be fixed directly.</div></div>';
      try { console.error('[social] render failed', err); } catch (e2) { /* ignore */ }
    }
  }

  function renderInner() {
    var root = el();
    if (!root) {
      try { console.error('[social] #panel-social is missing — the page HTML is stale, hard-reload'); } catch (e) { /* ignore */ }
      return;
    }
    if (state.loading && !state.campaign) { root.innerHTML = (A.loadingHtml ? A.loadingHtml() : '<div class="content">Loading…</div>'); return; }

    if (!state.campaign) {
      root.innerHTML = '<div class="content" style="padding:32px">' + emptyState() + '</div>';
      return;
    }

    var c = state.campaign;
    var s = state.summary || {};
    var by = s.by_status || {};

    // ⚖️ Scheduling is per BATCH, not all-or-nothing (owner, 2026-08-18: "I should
    // be able to approve and schedule in less than all of the creatives"). What the
    // button books is the approved posts that do not have a date yet, so that count
    // is the gate and the label. Undecided posts are irrelevant to it: nothing
    // unreviewed can ever publish, because a date is only ever written to an
    // approved post and the publisher needs BOTH.
    var pending = state.posts.filter(function (p) { return p.status === 'approved' && !p.publish_at; }).length;
    var scheduled = state.posts.filter(function (p) { return !!p.publish_at; }).length;
    var approvedTotal = state.posts.filter(function (p) { return p.status === 'approved'; }).length;
    var isLiveMonth = c.status === 'approved' || c.status === 'publishing' || c.status === 'complete';
    // "Start today" re-lays the WHOLE approved batch from now instead of adding to
    // the campaign month, so it stays available even when nothing new is pending —
    // moving an already-booked batch forward is an action in its own right.
    var startToday = !!state.startToday;
    var canApprove = (startToday ? approvedTotal > 0 : pending > 0) && c.status !== 'complete';

    var html = '<div class="content" style="padding:20px 24px 60px">';

    // Header: which month, where it is up to, and the one action. The Scheduled pill
    // and the button now coexist — a part-scheduled month is both live AND still
    // has work to add, and hiding the button behind the pill was what made the
    // remaining posts unreachable.
    html += '<div class="soc-head">' +
      '<div>' +
        '<h2 class="soc-title">' + esc(monthLabel(c.month)) + '</h2>' +
        '<div class="soc-sub">' + esc(campaignBlurb(c, s)) + '</div>' +
      '</div>' +
      '<div class="soc-head-actions">' + monthPicker() +
        (isLiveMonth ? '<span class="ats-pill green" style="align-self:center">Scheduled</span>' : '') +
        (c.status === 'complete' ? '' :
          '<label class="soc-start-today" title="Book the whole approved batch from today instead of ' +
            monthLabel(c.month) + '. Anything already posted stays where it is.">' +
            '<input type="checkbox" id="socStartToday"' + (startToday ? ' checked' : '') + '> Start today</label>' +
          '<button class="btn-primary" id="socApproveBtn"' + (canApprove ? '' : ' disabled') + '>' +
            (startToday ? 'Schedule from today' : (scheduled ? 'Schedule' : 'Approve &amp; schedule')) +
            (startToday ? (approvedTotal ? ' (' + approvedTotal + ')' : '') : (pending ? ' (' + pending + ')' : '')) +
          '</button>') +
      '</div>' +
    '</div>';

    if (startToday && scheduled) {
      html += '<div class="soc-note"><strong>Start today is on.</strong> The next click moves all ' +
        approvedTotal + ' approved post' + (approvedTotal === 1 ? '' : 's') + ' to run from today at ' +
        esc((c.slot_times || ['09:00', '15:00']).join(' and ')) + ', ' + esc(c.time_zone || '') +
        ', replacing the dates they hold now. Anything already posted stays where it is.</div>';
    }

    // Two different messages on purpose. Nothing configured is a real problem.
    // One network configured is a normal state while the other is being set up,
    // and saying so plainly stops it reading as a fault.
    var ct = state.configuredTargets || {};
    if (state.nothingConfigured) {
      html += '<div class="soc-warn"><strong>Publishing is not configured.</strong> ' +
        esc(state.config.join(' ')) +
        ' Nothing will post until these are set, even after approval.</div>';
    } else if (ct.facebook && !ct.instagram) {
      html += '<div class="soc-note"><strong>Facebook only.</strong> Instagram is not configured yet' +
        ' (IG_USER_ID is not set), so this month posts to the Page and skips Instagram. Nothing is' +
        ' broken, and Instagram can be switched on later without redoing a campaign.</div>';
    } else if (ct.instagram && !ct.facebook) {
      html += '<div class="soc-note"><strong>Instagram only.</strong> Facebook is not configured yet' +
        ' (FB_PAGE_ID is not set), so this month posts to Instagram and skips the Page.</div>';
    }
    if (state.publishingDisabled) {
      html += '<div class="soc-warn"><strong>Publishing is switched off.</strong> ' +
        'SOCIAL_PUBLISH_DISABLED is true, so approved posts will be scheduled but held.</div>';
    }
    // Approving a card marks the creative good; it does NOT schedule anything. Only
    // the button above stamps a date, which is what makes an unreviewed post
    // unpublishable by construction. Without saying so, the natural read after
    // approving a card is "done", and the month then sits silently doing nothing.
    // Keyed off `pending`, NOT `canApprove`: with "Start today" armed the button is
    // live even when nothing new is pending, and these notes would otherwise
    // announce "0 posts ready for dates". The start-today note above covers that case.
    var plural = function (n) { return n === 1 ? '' : 's'; };
    if (pending > 0 && by.draft > 0) {
      // The case the old copy got wrong: it said scheduling was LOCKED until every
      // post had a decision, which is no longer true and was never necessary.
      html += '<div class="soc-note"><strong>' + pending + ' post' + plural(pending) +
        ' ready for dates.</strong> Approving a card marks the creative good, it does not set a date.' +
        ' Click <strong>' + (scheduled ? 'Schedule' : 'Approve &amp; schedule') + '</strong> above to book' +
        ' ' + (pending === 1 ? 'it' : 'them') + ' now. The other ' + by.draft + ' can be reviewed and added' +
        ' later, and nothing goes out until you do.</div>';
    } else if (pending > 0) {
      html += '<div class="soc-note"><strong>Every post is reviewed. ' +
        (scheduled ? pending + ' still ' + (pending === 1 ? 'has' : 'have') + ' no date.' : 'Nothing is scheduled yet.') +
        '</strong> Approving a card marks the creative good, it does not set a date.' +
        ' Click <strong>' + (scheduled ? 'Schedule' : 'Approve &amp; schedule') + '</strong> above to lock in the' +
        ' dates and start publishing.</div>';
    } else if (by.draft > 0) {
      html += '<div class="soc-note">' + by.draft + ' post' + plural(by.draft) +
        ' still need a decision.' + (scheduled ? ' The ' + scheduled + ' already scheduled will keep going out.' : '') +
        ' Approve any of them and they can be added to this month.</div>';
    }

    html += '<div class="soc-stats">' +
      stat(s.total || 0, 'creatives') +
      stat(by.draft || 0, 'to review') +
      stat(by.approved || 0, 'approved') +
      // With batch scheduling, "approved" and "has a date" are no longer the same
      // thing, so the split has to be visible or a part-scheduled month is unreadable.
      stat(scheduled, 'scheduled') +
      stat(by.rejected || 0, 'rejected') +
      stat(by.posted || 0, 'posted') +
      (by.failed ? stat(by.failed, 'failed') : '') +
    '</div>';

    html += '<div class="soc-grid">';
    state.posts.forEach(function (p) { html += card(p); });
    html += '</div></div>';

    // 🧨 A card decision reloads the month and repaints the whole grid, which
    // destroys and rebuilds all ~60 textareas. Measured: a caption the owner had
    // scrolled to read snapped back to the top the moment they approved a
    // DIFFERENT card, and an unsaved edit in it was silently thrown away. Carry
    // the per-caption state across the repaint.
    var prevState = captureCaptionState();
    var prevPainted = lastPainted;

    root.innerHTML = html;

    lastPainted = {};
    state.posts.forEach(function (p) { lastPainted[p.id] = String(p.caption == null ? '' : p.caption); });
    restoreCaptionState(prevState, prevPainted);
    wire();
  }

  // Scroll position, unsaved text, focus and selection for every caption on screen.
  function captureCaptionState() {
    var root = el();
    var out = {};
    if (!root) return out;
    var active = document.activeElement;
    var boxes = root.querySelectorAll('.soc-caption');
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      var card = box.closest ? box.closest('.soc-card') : null;
      var id = card && card.getAttribute('data-id');
      if (!id) continue;
      out[id] = {
        scrollTop: box.scrollTop,
        value: box.value,
        focused: box === active,
        selStart: box.selectionStart,
        selEnd: box.selectionEnd
      };
    }
    return out;
  }

  function restoreCaptionState(prev, prevPainted) {
    var root = el();
    if (!root || !prev) return;
    var boxes = root.querySelectorAll('.soc-caption');
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      var card = box.closest ? box.closest('.soc-card') : null;
      var id = card && card.getAttribute('data-id');
      var was = id && prev[id];
      if (!was) continue;
      // An edit the owner has not saved yet is theirs to keep — but ONLY while the
      // stored copy is unchanged. If the server's caption really moved on, the
      // server wins, otherwise a genuine change would be silently masked by a
      // stale box (and "Save copy" would then write the stale text back).
      var painted = prevPainted ? prevPainted[id] : undefined;
      if (was.value !== box.value && was.value !== painted && box.value === painted) {
        box.value = was.value;
      }
      box.scrollTop = was.scrollTop;
      if (was.focused) {
        // preventScroll so restoring the caret cannot yank the page around.
        try {
          box.focus({ preventScroll: true });
          if (was.selStart != null) box.setSelectionRange(was.selStart, was.selEnd);
        } catch (e) { /* ignore */ }
        box.scrollTop = was.scrollTop;
      }
    }
  }

  function stat(n, label) {
    return '<div class="soc-stat"><b>' + n + '</b><span>' + esc(label) + '</span></div>';
  }

  function monthLabel(m) {
    if (!m) return 'Social';
    var parts = String(m).split('-');
    var d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, 1));
    try { return d.toLocaleDateString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' }); }
    catch (e) { return m; }
  }

  function campaignBlurb(c, s) {
    var perDay = c.posts_per_day || 2;
    var times = (c.slot_times || ['09:00', '15:00']).join(' and ');
    if (c.status === 'approved' || c.status === 'publishing') {
      return (s.by_status && s.by_status.posted || 0) + ' of ' + (s.total || 0) + ' posted · ' +
        perDay + ' a day at ' + times + ' ' + (c.time_zone || '');
    }
    return (s.total || 0) + ' creatives · ' + perDay + ' a day at ' + times + ' ' + (c.time_zone || '');
  }

  function monthPicker() {
    var months = state.months || [];
    if (months.length < 2) return '';
    var out = '<select id="socMonthSel" class="soc-select">';
    months.forEach(function (m) {
      out += '<option value="' + esc(m.month) + '"' + (m.month === state.campaign.month ? ' selected' : '') + '>' +
        esc(monthLabel(m.month)) + '</option>';
    });
    return out + '</select>';
  }

  function emptyState() {
    return '<div class="soc-empty">' +
      '<h2 class="soc-title">No campaign yet</h2>' +
      '<p>Creatives for a month are generated outside the app and uploaded to ' +
      '<code>/api/admin/social/ingest</code>. Once a batch lands, every post appears here for ' +
      'your review, and approving the month schedules two a day to Facebook and Instagram.</p>' +
      '</div>';
  }

  function card(p) {
    var v = p.validation || {};
    var warn = (v.warnings || []);
    var errs = (v.errors || []);
    var live = p.status === 'posted';

    return '<article class="soc-card' + (p.status === 'rejected' ? ' is-rejected' : '') + '" data-id="' + esc(p.id) + '">' +
      '<div class="soc-card-img">' +
        '<img loading="lazy" src="' + esc(imgUrl(p)) + '" alt="' + esc(p.alt_text || ('Post ' + p.slot)) + '">' +
        '<span class="soc-slot">#' + esc(String(p.slot)) + '</span>' +
      '</div>' +
      '<div class="soc-card-body">' +
        '<div class="soc-card-top">' + statusPill(p.status) +
          (p.pillar ? '<span class="ats-pill muted">' + esc(p.pillar) + '</span>' : '') +
          (p.publish_at ? '<span class="soc-when">' + esc(fmtWhen(p.publish_at)) + '</span>' : '') +
        '</div>' +
        '<textarea class="soc-caption" data-role="caption"' + (live ? ' readonly' : '') + '>' + esc(p.caption || '') + '</textarea>' +
        (errs.length ? '<div class="soc-err">' + esc(errs.join(' ')) + '</div>' : '') +
        (warn.length ? '<div class="soc-warn-sm">' + esc(warn.join(' ')) + '</div>' : '') +
        (function () {
          // A post waiting on a missing env var is not a failure, and must not
          // be dressed as one. It publishes by itself once the value lands.
          var err = [p.facebook_error, p.instagram_error].filter(Boolean).join(' · ');
          if (!err) return '';
          var waiting = err.indexOf('Waiting on configuration') === 0;
          return '<div class="' + (waiting ? 'soc-warn-sm' : 'soc-err') + '">' +
            esc(waiting ? err + ' It will go out on its own once that is set.' : err) + '</div>';
        })() +
        '<div class="soc-card-actions">' +
          (live
            ? '<span class="soc-when">Live' + (p.facebook_post_id ? ' · Facebook' : '') + (p.instagram_media_id ? ' · Instagram' : '') + '</span>'
            : '<button class="soc-btn" data-act="save">Save copy</button>' +
              '<button class="soc-btn ok" data-act="approve"' + (p.status === 'approved' ? ' disabled' : '') + '>Approve</button>' +
              '<button class="soc-btn no" data-act="reject"' + (p.status === 'rejected' ? ' disabled' : '') + '>Reject</button>' +
              // Only on an approved post: sending immediately skips the clock, never
              // the review. Useful to prove a network end to end before a whole
              // month rides on the schedule.
              (p.status === 'approved'
                ? '<button class="soc-btn now" data-act="publish-now" title="Send this one to ' +
                    'Facebook and Instagram right now, ahead of its slot.">Post now</button>'
                : '')) +
        '</div>' +
      '</div>' +
    '</article>';
  }

  // ── actions ──────────────────────────────────────────────────────────────
  function wire() {
    var root = el();
    if (!root) return;

    // These two live INSIDE the replaced innerHTML, so they are new nodes on every
    // render and must be re-bound each time.
    var sel = document.getElementById('socMonthSel');
    if (sel) sel.addEventListener('change', function () { load(sel.value); });

    var approve = document.getElementById('socApproveBtn');
    if (approve) approve.addEventListener('click', approveCampaign);

    var startToday = document.getElementById('socStartToday');
    if (startToday) {
      startToday.addEventListener('change', function () {
        state.startToday = !!startToday.checked;
        render(); // repaint the label + warning; caption state is preserved
      });
    }

    // The delegated card handler is bound to the PERSISTENT root, so exactly once.
    if (panelWired) return;
    panelWired = true;
    root.addEventListener('click', onCardClick);
  }

  function onCardClick(e) {
    var btn = e.target.closest ? e.target.closest('.soc-btn[data-act]') : null;
    if (!btn) return;
    var card = btn.closest('.soc-card');
    if (!card) return;
    var id = card.getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    // Belt and braces on top of the once-only binding: an impatient double-click
    // must not write the same decision twice.
    if (!id || inFlight[id]) return;
    var caption = (card.querySelector('[data-role="caption"]') || {}).value;
    if (act === 'save') return postUpdate(id, { caption: caption }, 'Copy saved');
    if (act === 'approve') return postUpdate(id, { caption: caption, decision: 'approve' }, 'Approved');
    if (act === 'reject') return postUpdate(id, { decision: 'reject' }, 'Rejected');
    if (act === 'publish-now') return publishNow(id, card);
  }

  // Publishing is public and cannot be undone from here, so it asks first. Naming
  // the slot makes a mis-click on the wrong card obvious before it goes out.
  function publishNow(id, card) {
    var slotEl = card.querySelector('.soc-slot');
    var slot = slotEl ? slotEl.textContent : 'this post';
    if (!window.confirm('Send ' + slot + ' to Facebook and Instagram right now?\n\n' +
      'It goes out publicly and cannot be taken back from here. The rest of the month ' +
      'keeps its schedule.')) return;

    inFlight[id] = true;
    card.querySelectorAll('.soc-btn').forEach(function (b) { b.disabled = true; });
    A.toast('Sending…');
    return A.api('/api/ceo/social/publish-now', { method: 'POST', body: { id: id } }).then(function (d) {
      delete inFlight[id];
      if (!d || !d.ok) {
        A.toast((d && d.message) || 'Could not send that post.');
        card.querySelectorAll('.soc-btn').forEach(function (b) { b.disabled = false; });
        return;
      }
      // Say exactly what happened. "Sent" when a network is still waiting on its
      // configuration would be a lie, and the whole point of this button is to
      // show the real Meta error rather than hide it.
      if (d.failed) A.toast('Meta refused it: ' + ((d.errors || []).join(' ') || 'unknown error'));
      else if (d.held) A.toast('Nothing could be sent: ' + (d.reason || 'publishing is not configured.'));
      else if (d.partial) A.toast('Sent to the network that is configured. The other is still waiting on its setting.');
      else A.toast('Sent to Facebook and Instagram.');
      return load(state.month, true);
    });
  }

  function postUpdate(id, body, okMsg) {
    body.id = id;
    inFlight[id] = true;
    // Grey the row's buttons out while it is in flight so the click visibly landed.
    var pending = el() && el().querySelector('.soc-card[data-id="' + id + '"]');
    if (pending) {
      pending.querySelectorAll('.soc-btn').forEach(function (b) { b.disabled = true; });
    }
    return A.api('/api/ceo/social/post', { method: 'POST', body: body }).then(function (d) {
      delete inFlight[id];
      if (!d || !d.ok) {
        A.toast((d && d.message) || 'Could not save.');
        // Give the buttons back — the decision did not land, so it must be retryable.
        if (pending) pending.querySelectorAll('.soc-btn').forEach(function (b) { b.disabled = false; });
        return;
      }
      A.toast(okMsg);
      return load(state.month, true).then(function () {
        // Say the quiet part out loud at the moment it matters: approving a card is
        // where people assume the job is finished, and it sets no date at all.
        var by = (state.summary || {}).by_status || {};
        var c = state.campaign;
        if (!body.decision || !c || c.status === 'complete') return;
        var undated = state.posts.filter(function (p) { return p.status === 'approved' && !p.publish_at; }).length;
        if (!undated) return;
        if (by.draft === 0) {
          A.toast('All reviewed. Now click ' + (undated === state.posts.length ? 'Approve & schedule' : 'Schedule') +
            ' to set the dates.');
        }
      });
    });
  }

  function approveCampaign() {
    var btn = document.getElementById('socApproveBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Scheduling…'; }
    var body = { month: state.month };
    if (state.startToday) body.start_today = true;
    A.api('/api/ceo/social/approve', { method: 'POST', body: body }).then(function (d) {
      if (!d || !d.ok) {
        A.toast((d && d.message) || 'Could not approve.');
        return load(state.month, true);
      }
      // Name the first date explicitly. Approving in the evening books the next
      // morning's slot, which reads as "nothing happened" unless it is said.
      A.toast(d.scheduled + (d.rescheduled ? ' moved. Now starting ' : ' scheduled. ') +
        (d.rescheduled ? '' : (d.already_scheduled ? 'Next of this batch goes out ' : 'First one goes out ')) +
        (d.first_publish_at ? fmtWhen(d.first_publish_at) : 'shortly') +
        (d.rescheduled && d.last_publish_at ? ', last one ' + fmtWhen(d.last_publish_at) : '') + '.');
      if (d.note) A.toast(d.note);
      // A re-lay is a one-off action, not a mode to leave armed.
      state.startToday = false;
      return load(state.month, true);
    });
  }

  // ── data ─────────────────────────────────────────────────────────────────
  function load(month, quiet) {
    state.loading = !quiet;
    if (!quiet) render();
    var path = '/api/ceo/social' + (month ? '?month=' + encodeURIComponent(month) : '');
    return A.api(path).then(function (d) {
      state.loading = false;
      if (!d || !d.ok) {
        var root = el();
        if (root) {
          root.innerHTML = '<div class="content" style="padding:32px"><div class="soc-warn">' +
            esc((d && d.message) || 'Could not load the campaign.') + '</div></div>';
        }
        return;
      }
      state.campaign = d.campaign || null;
      state.posts = d.posts || [];
      state.months = d.months || [];
      state.summary = d.summary || null;
      state.config = d.config_problems || [];
      state.configuredTargets = d.configured_targets || {};
      state.nothingConfigured = !!d.nothing_configured;
      state.publishingDisabled = !!d.publishing_disabled;
      state.month = state.campaign ? state.campaign.month : null;
      render();
      refreshAlert();
    }).catch(function (err) {
      // A rejected fetch used to leave the loading state on screen forever,
      // which reads as an empty tab. Say what happened instead.
      state.loading = false;
      var root = el();
      if (root) {
        root.innerHTML = '<div class="content" style="padding:32px">' +
          '<div class="soc-warn"><strong>Could not reach the campaign.</strong><br>' +
          esc(String((err && err.message) || err)) + '</div></div>';
      }
      try { console.error('[social] load failed', err); } catch (e) { /* ignore */ }
    });
  }

  // The dot on the tab: anything waiting on the owner turns it on. Mirrors the
  // Contracts alert so the two read the same way.
  function refreshAlert() {
    var elDot = document.getElementById('masterSocialAlert');
    if (!elDot) return;
    var n = (state.summary && state.summary.needs_review) || 0;
    if (n > 0) {
      elDot.setAttribute('data-count', String(n));
      elDot.textContent = '!';
      elDot.title = n + ' social post' + (n === 1 ? '' : 's') + ' need your review';
    } else {
      elDot.removeAttribute('data-count');
      elDot.textContent = '';
      elDot.removeAttribute('title');
    }
  }

  window.loadSocialTab = function () { load(state.month || null); };

  // Prime the alert once at boot so the owner sees the dot without opening the
  // tab. Deliberately quiet: a missing table or an unconfigured month must not
  // throw an error into a dashboard that is otherwise fine.
  window.ATS_refreshSocialAlert = function () {
    if (!A.api) return;
    A.api('/api/ceo/social').then(function (d) {
      if (!d || !d.ok) return;
      state.summary = d.summary || null;
      refreshAlert();
    }).catch(function () { /* ignore */ });
  };
})();

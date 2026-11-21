/* Australian GP build (WP-12): what a doctor on an Australian pathway sees
 * after sign-in on the three pages only they are ever sent.
 *
 *   GPAuPrestart.mountHome(el)            pages/index-au.html   Home
 *   GPAuPrestart.mountPrestart(el, o)     pages/prestart.html   the pre-start checklist
 *   GPAuPrestart.mountProviderNumber(el)  pages/pbs-au.html     the provider-number step
 *
 * All three draw from one request, GET /api/gp/au-prestart, which the server
 * composes from the real state (staff tasks, documents, what the doctor has
 * recorded). The doctor's own actions are three small POSTs:
 *
 *   POST /api/gp/au-prestart/notice            { given: true, date }
 *   POST /api/gp/au-prestart/referees          { referees: [ {...}, {...} ] }
 *   POST /api/gp/au-prestart/provider-details  { existingProviderNumbers, prescriberNumber, newLocationProviderNumber }
 *
 * The server sends this file only to a doctor on an Australian pathway, and
 * answers 404 to those routes for anyone else. Every word here is checked by
 * tests/au-wp12-banned-words.test.js.
 */
(function (root) {
  'use strict';

  var API = '/api/gp/au-prestart';
  var LOCALE = 'en-AU';
  var CONFIDENTIAL = 'We never contact your current practice without asking you first.';

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 2027-02-01 -> 1 February 2027. '' for anything that is not a date. */
  function formatDay(value) {
    var s = String(value == null ? '' : value).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
    var d = new Date(s + 'T00:00:00');
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return s; }
  }
  // A sentence from the server may carry a date as YYYY-MM-DD: show it the
  // Australian way.
  function withDates(text) {
    return String(text == null ? '' : text).replace(/\b(\d{4}-\d{2}-\d{2})\b/g, function (m) { return formatDay(m) || m; });
  }

  function todayIso() {
    var d = new Date();
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    return d.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (day.length < 2 ? '0' + day : day);
  }

  function isView(view) {
    return !!view && typeof view === 'object' && view.ok === true && Array.isArray(view.steps) && Array.isArray(view.items);
  }

  function routeLink(href, label, primary) {
    return '<a class="aua-btn' + (primary ? ' aua-btn-primary' : '') + '" href="' + esc(href) + '" data-au-route="' + esc(href) + '">' + esc(label) + '</a>';
  }

  function messageHtml(title, body, withRetry) {
    return '<div class="aua-state"><h3>' + esc(title) + '</h3><p>' + esc(body) + '</p>'
      + (withRetry ? '<button type="button" class="aua-btn aua-btn-primary" data-au-retry>Try again</button>' : '') + '</div>';
  }

  // ── the four steps ─────────────────────────────────────────────────────────
  var STEP_STATE_LABEL = { done: 'Done', current: 'Current step', open: 'Open', locked: '' };

  function stepsHtml(steps) {
    return '<ol class="aua-steps">' + steps.map(function (s) {
      var cls = 'aua-step' + (s.done ? ' is-done' : '') + (s.state === 'current' ? ' is-current' : '') + (s.locked ? ' is-locked' : '');
      var sub = s.locked ? (s.lockReason || '') : (s.description || '');
      var label = STEP_STATE_LABEL[s.state] || '';
      var inner = '<span class="aua-step-num" aria-hidden="true">' + (s.done ? '&#10003;' : esc(s.num)) + '</span>'
        + '<span class="aua-step-body"><span class="aua-step-title">' + esc(s.title) + '</span>'
        + '<span class="aua-step-sub" style="display:block">' + esc(sub) + '</span></span>'
        + (label ? '<span class="aua-pill tone-' + (s.done ? 'done' : (s.state === 'current' ? 'todo' : 'waiting')) + '">' + esc(label) + '</span>' : '');
      if (s.locked) return '<li><div class="' + cls + '" data-au-step="' + esc(s.key) + '">' + inner + '</div></li>';
      return '<li><a class="' + cls + '" data-au-step="' + esc(s.key) + '" href="' + esc(s.href) + '" data-au-route="' + esc(s.href) + '">' + inner + '</a></li>';
    }).join('') + '</ol>';
  }

  // The one thing to do next: the first item that is waiting on the doctor.
  function nextForDoctor(view) {
    var items = view.items || [];
    for (var i = 0; i < items.length; i++) if (items[i].status === 'attention') return items[i];
    for (var j = 0; j < items.length; j++) if (items[j].status === 'todo') return items[j];
    return null;
  }

  // WP-13: the doctor's placement has ended (they left the practice). No
  // reason, and nothing about what happens between GP Link and the practice.
  function endedHtml(view) {
    var where = view.endedPracticeName ? ' at ' + esc(view.endedPracticeName) : '';
    return '<section class="aua-card"><p class="aua-kicker">Your placement has ended</p><h2>Your time' + where + ' has finished</h2>'
      + '<p>' + esc(view.teamLabel ? view.teamLabel.charAt(0).toUpperCase() + view.teamLabel.slice(1) : 'Your GP Link team')
      + ' will be in touch about what comes next. When you are ready, you can look at roles again.</p>'
      + '<div class="aua-actions">' + routeLink('/pages/career', 'See roles', true) + routeLink('/pages/messages', 'Message us', false) + '</div></section>';
  }

  var HOLD_TITLE = 'Thanks, we have your details';
  var HOLD_BODY = 'Thank you for telling us about your registration. Before we show you roles, one of our team needs to confirm a few details with you. You do not need to do anything now: we will be in touch by email, usually within two working days.';

  // ── Home ───────────────────────────────────────────────────────────────────
  function homeHtml(view) {
    if (!isView(view)) return messageHtml('We could not load your home page', 'Check your connection and try again. Nothing has been lost.', true);
    var out = [];
    if (!view.placed) {
      if (view.launched === false) {
        out.push('<section class="aua-card aua-hold"><h2>' + esc(HOLD_TITLE) + '</h2><p>' + esc(HOLD_BODY) + '</p>'
          + '<div class="aua-actions">' + routeLink('/pages/messages', 'Message us', false) + '</div></section>');
      } else {
        out.push('<section class="aua-card aua-next"><p class="aua-kicker">Your next step</p><h2>Find your practice</h2>'
          + '<p>Browse the roles that fit you, meet the practice and sign your offer in the app. ' + esc(CONFIDENTIAL) + '</p>'
          + '<div class="aua-actions">' + routeLink('/pages/career', 'See roles', true) + '</div></section>');
      }
    } else if (view.placementEnded) {
      // WP-13: the placement has ended. Say so; never draw an empty checklist.
      out.push(endedHtml(view));
    } else {
      var next = nextForDoctor(view);
      var practice = view.practiceName ? esc(view.practiceName) : 'your new practice';
      if (view.started) {
        // WP-13: staff have confirmed the doctor started work.
        out.push('<section class="aua-card"><p class="aua-kicker">You have started</p><h2>Welcome to ' + practice + '</h2>'
          + '<p>' + (view.startedOn ? 'You started on ' + esc(formatDay(view.startedOn)) + '. ' : '') + 'We will check in with you over your first weeks. If anything needs sorting out, message us.</p>'
          + '<div class="aua-actions">' + routeLink('/pages/messages', 'Message us', false) + '</div></section>');
      } else if (view.complete) {
        out.push('<section class="aua-card"><p class="aua-kicker">You are all set</p><h2>Everything on your checklist is done</h2>'
          + '<p>' + (view.startDate ? 'Your start date at ' + practice + ' is ' + esc(formatDay(view.startDate)) + '.' : 'We will confirm your start date at ' + practice + ' with you.') + '</p></section>');
      } else if (next) {
        out.push('<section class="aua-card aua-next"><p class="aua-kicker">Your next step</p><h2>' + esc(next.title) + '</h2>'
          + '<p>' + esc(withDates(next.whatToDo)) + '</p>'
          + '<div class="aua-actions">' + routeLink(next.key === 'provider_number' ? '/pages/pbs' : '/pages/prestart', 'Open my pre-start checklist', true) + '</div></section>');
      } else {
        out.push('<section class="aua-card"><p class="aua-kicker">Nothing needed from you right now</p><h2>We are working through the rest</h2>'
          + '<p>The remaining items on your checklist are with GP Link or ' + practice + '. We will message you if we need anything.</p>'
          + '<div class="aua-actions">' + routeLink('/pages/prestart', 'See my checklist', false) + '</div></section>');
      }
      out.push('<section class="aua-card"><h3>' + practice + '</h3>'
        + '<p>' + (view.started && view.startedOn
          ? 'Started: <strong>' + esc(formatDay(view.startedOn)) + '</strong>'
          : (view.startDate
            ? (view.startDateConfirmed ? 'Start date: ' : 'Expected start date: ') + '<strong>' + esc(formatDay(view.startDate)) + '</strong>'
            : 'Start date: to be confirmed')) + '</p>'
        + (view.counts && view.counts.total ? '<p class="aua-muted">' + esc(view.counts.done) + ' of ' + esc(view.counts.total) + ' pre-start items done</p>'
          + '<div class="aua-bar" aria-hidden="true"><span style="width:' + Math.round((view.counts.done / view.counts.total) * 100) + '%"></span></div>' : '')
        + '</section>');
    }
    out.push('<h2 class="aua-section-title">Your steps</h2>');
    out.push(stepsHtml(view.steps));
    out.push('<section class="aua-card"><h3>Need a hand?</h3><p>' + esc(view.teamLabel ? view.teamLabel.charAt(0).toUpperCase() + view.teamLabel.slice(1) : 'Your GP Link team')
      + ' can help with anything on this page.</p><div class="aua-actions">' + routeLink('/pages/messages', 'Message us', false) + '</div></section>');
    return out.join('');
  }

  // ── the pre-start checklist ────────────────────────────────────────────────
  function refereeBlock(n, r) {
    var v = r || {};
    var id = 'auRef' + n;
    var at = v.atCurrentPractice === true ? 'yes' : (v.atCurrentPractice === false ? 'no' : '');
    return '<fieldset class="aua-fieldset"><legend>Referee ' + n + '</legend>'
      + '<label class="aua-field">Full name<input type="text" autocomplete="off" maxlength="120" data-au-ref="' + n + '" data-au-ref-field="name" value="' + esc(v.name) + '"></label>'
      + '<label class="aua-field">Their role<input type="text" autocomplete="off" maxlength="120" placeholder="For example practice principal" data-au-ref="' + n + '" data-au-ref-field="role" value="' + esc(v.role) + '"></label>'
      + '<label class="aua-field">How you know them<input type="text" autocomplete="off" maxlength="160" placeholder="For example my supervisor for two years" data-au-ref="' + n + '" data-au-ref-field="relationship" value="' + esc(v.relationship) + '"></label>'
      + '<div class="aua-row">'
      + '<label class="aua-field">Phone<input type="tel" inputmode="tel" autocomplete="off" maxlength="40" data-au-ref="' + n + '" data-au-ref-field="phone" value="' + esc(v.phone) + '"></label>'
      + '<label class="aua-field">Email<input type="email" inputmode="email" autocomplete="off" maxlength="254" data-au-ref="' + n + '" data-au-ref-field="email" value="' + esc(v.email) + '"></label>'
      + '</div>'
      + '<div class="aua-field" role="group" aria-labelledby="' + id + 'Cur">'
      + '<span id="' + id + 'Cur">Is this person at your current practice?</span>'
      + '<span class="aua-radio-row">'
      + '<label><input type="radio" name="' + id + 'Current" value="yes" data-au-ref="' + n + '" data-au-ref-field="current"' + (at === 'yes' ? ' checked' : '') + '> Yes</label>'
      + '<label><input type="radio" name="' + id + 'Current" value="no" data-au-ref="' + n + '" data-au-ref-field="current"' + (at === 'no' ? ' checked' : '') + '> No</label>'
      + '</span></div>'
      + '<label class="aua-check"><input type="checkbox" data-au-ref="' + n + '" data-au-ref-field="agreed"' + (v.agreedToContact === true ? ' checked' : '') + '>'
      + '<span>This person has agreed to be contacted by GP Link about me.</span></label>'
      + '</fieldset>';
  }

  function formsFor(item, view, ui) {
    var open = ui && ui.open === item.key;
    var d = view.details || {};
    if (item.action && item.action.kind === 'notice') {
      return '<div class="aua-form" data-au-form="notice"' + (open ? '' : ' hidden') + '>'
        + '<label class="aua-check"><input type="checkbox" data-au-notice-given' + (d.noticeGiven ? ' checked' : '') + '><span>I have given notice at my current practice.</span></label>'
        + '<label class="aua-field">Date you gave notice<input type="date" data-au-notice-date max="' + esc(todayIso()) + '" value="' + esc(d.noticeGivenDate || '') + '"></label>'
        + '<p class="aua-msg" data-au-msg="notice" hidden></p>'
        + '<div class="aua-actions"><button type="button" class="aua-btn aua-btn-primary" data-au-save="notice">Save</button></div></div>';
    }
    if (item.action && item.action.kind === 'referees') {
      var refs = Array.isArray(d.referees) ? d.referees : [];
      return '<div class="aua-form" data-au-form="referees"' + (open ? '' : ' hidden') + '>'
        + '<p class="aua-muted">Please ask each person first. ' + esc(CONFIDENTIAL) + '</p>'
        + refereeBlock(1, refs[0]) + refereeBlock(2, refs[1])
        + '<p class="aua-msg" data-au-msg="referees" hidden></p>'
        + '<div class="aua-actions"><button type="button" class="aua-btn aua-btn-primary" data-au-save="referees">Save referees</button></div></div>';
    }
    return '';
  }

  function itemHtml(item, view, ui) {
    var action = '';
    if (item.action) {
      if (item.action.kind === 'link') action = routeLink(item.action.href, item.action.label, item.status === 'todo');
      else if (item.action.kind === 'upload') action = '<a class="aua-btn' + (item.status !== 'done' ? ' aua-btn-primary' : '') + '" href="#auDoc-' + esc(item.action.documentKey) + '" data-au-jump="' + esc(item.action.documentKey) + '">' + esc(item.action.label) + '</a>';
      else action = '<button type="button" class="aua-btn' + (item.status === 'todo' ? ' aua-btn-primary' : '') + '" data-au-open="' + esc(item.key) + '">' + esc(item.action.label) + '</button>';
    }
    return '<section class="aua-card" data-au-item="' + esc(item.key) + '"' + (item.key === 'start_date' ? ' id="start-date"' : '') + '>'
      + '<div class="aua-item-head"><h3>' + esc(item.title) + '</h3><span class="aua-pill tone-' + esc(item.status) + '">' + esc(item.statusLabel) + '</span></div>'
      + '<p class="aua-who">Who: ' + esc(item.whoLabel) + '</p>'
      + '<p>' + esc(withDates(item.whatToDo)) + '</p>'
      + (item.note ? '<p class="aua-note">' + esc(item.note) + '</p>' : '')
      + (action ? '<div class="aua-actions">' + action + '</div>' : '')
      + formsFor(item, view, ui)
      + '</section>';
  }

  function prestartHtml(view, ui) {
    if (!isView(view)) return messageHtml('We could not load your checklist', 'Check your connection and try again. Nothing has been lost.', true);
    if (!view.placed) {
      return '<section class="aua-card"><h2>Your checklist opens once your placement is secured</h2>'
        + '<p>There is nothing to do here yet.</p><div class="aua-actions">' + routeLink('/pages/career', 'Go to Careers', true) + '</div></section>';
    }
    // WP-13: the placement has ended. There is no checklist to show.
    if (view.placementEnded) return endedHtml(view);
    var practice = view.practiceName ? esc(view.practiceName) : 'your new practice';
    var out = [];
    // WP-13: a truthful state once staff have confirmed the doctor started.
    if (view.started) {
      out.push('<section class="aua-card" data-au-started><p class="aua-kicker">You have started</p><h2>You have started at ' + practice + '</h2>'
        + '<p>' + (view.startedOn ? 'Your first day was <strong>' + esc(formatDay(view.startedOn)) + '</strong>. ' : '')
        + 'We will check in with you over your first weeks. Your checklist from before you started is below for your records.</p>'
        + '<div class="aua-actions">' + routeLink('/pages/messages', 'Message us', false) + '</div></section>');
    }
    out.push('<p class="aua-progress">' + esc(view.counts.done) + ' of ' + esc(view.counts.total) + ' done'
      + '<span class="aua-bar" aria-hidden="true" style="display:block"><span style="width:' + (view.counts.total ? Math.round((view.counts.done / view.counts.total) * 100) : 0) + '%"></span></span></p>');
    if (view.complete && !view.started) {
      out.push('<section class="aua-card"><p class="aua-kicker">All done</p><h2>You are ready for your first day at ' + practice + '</h2>'
        + (view.startDate ? '<p>Start date: <strong>' + esc(formatDay(view.startDate)) + '</strong></p>' : '') + '</section>');
    }
    view.items.forEach(function (item) { out.push(itemHtml(item, view, ui)); });
    out.push('<h2 class="aua-section-title" id="auDocsHeading">Documents to upload</h2>');
    out.push('<div id="auPrestartDocs" data-au-docs></div>');
    return out.join('');
  }

  // ── the provider-number step ───────────────────────────────────────────────
  function existingRow(i, row) {
    var r = row || {};
    return '<div class="aua-row" data-au-existing-row>'
      + '<label class="aua-field">Provider number<input type="text" autocomplete="off" autocapitalize="characters" maxlength="20" placeholder="123456AB" data-au-existing="number" value="' + esc(r.number) + '"></label>'
      + '<label class="aua-field">Location it is for<input type="text" autocomplete="off" maxlength="160" placeholder="Practice or suburb" data-au-existing="location" value="' + esc(r.location) + '"></label>'
      + '</div>';
  }

  function providerHtml(view, ui) {
    if (!isView(view)) return messageHtml('We could not load this step', 'Check your connection and try again. Nothing has been lost.', true);
    if (!view.placed) {
      return '<section class="aua-card"><h2>This step opens once your placement is secured</h2>'
        + '<p>There is nothing to do here yet.</p><div class="aua-actions">' + routeLink('/pages/career', 'Go to Careers', true) + '</div></section>';
    }
    var step = view.providerStep || {};
    var practice = view.practiceName ? esc(view.practiceName) : 'your new practice';
    var d = view.details || {};
    var existing = Array.isArray(d.existingProviderNumbers) ? d.existingProviderNumbers.slice() : [];
    var rows = Math.max(1, existing.length + ((ui && ui.extraRows) || 0));
    var out = [];
    out.push('<section class="aua-card"><p>' + esc(step.intro || 'Your new practice location needs its own provider number.') + '</p>'
      + (Array.isArray(step.steps) && step.steps.length ? '<ol class="aua-list">' + step.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' : '')
      + (step.extraNote ? '<p class="aua-note" style="color:var(--gp-amber-ink);background:var(--gp-amber-soft);border-color:var(--gp-amber-border)">' + esc(step.extraNote) + '</p>' : '')
      + '</section>');

    var np = view.providerNumber || {};
    out.push('<section class="aua-card" data-au-item="new_number"><div class="aua-item-head"><h3>Provider number for ' + practice + '</h3>'
      + '<span class="aua-pill tone-' + (np.recorded ? 'done' : 'todo') + '">' + (np.recorded ? 'On file' : 'To do') + '</span></div>'
      + (np.recorded
        ? '<p class="aua-number">' + esc(np.number) + '</p><p class="aua-muted">This is the number we hold for ' + practice + '. Message us if it is wrong.</p>'
        : '<p>When Services Australia issues your number for this location, enter it here.</p>'
          + '<label class="aua-field">Provider number<input type="text" autocomplete="off" autocapitalize="characters" maxlength="20" placeholder="123456AB" data-au-new-number></label>'
          + '<p class="aua-msg" data-au-msg="new" hidden></p>'
          + '<div class="aua-actions"><button type="button" class="aua-btn aua-btn-primary" data-au-save="new">Save number</button></div>')
      + '</section>');

    var list = [];
    for (var i = 0; i < rows; i++) list.push(existingRow(i, existing[i]));
    out.push('<section class="aua-card" data-au-item="existing"><h3>Numbers you already hold</h3>'
      + '<p class="aua-muted">' + esc(step.prescriberNote || '') + '</p>'
      + '<div data-au-existing-list>' + list.join('') + '</div>'
      + '<div class="aua-actions"><button type="button" class="aua-btn" data-au-add-row>Add another provider number</button></div>'
      + '<label class="aua-field">Prescriber number (if you have one)<input type="text" inputmode="numeric" autocomplete="off" maxlength="20" data-au-prescriber value="' + esc(d.prescriberNumber || '') + '"></label>'
      + '<p class="aua-msg" data-au-msg="existing" hidden></p>'
      + '<div class="aua-actions"><button type="button" class="aua-btn aua-btn-primary" data-au-save="existing">Save</button></div>'
      + '</section>');
    out.push('<div class="aua-actions">' + routeLink('/pages/prestart', 'Back to my pre-start checklist', false) + '</div>');
    return out.join('');
  }

  // ── browser-only below ─────────────────────────────────────────────────────
  function mount(el, kind, options) {
    var opts = options || {};
    var fetcher = opts.fetch || (root.fetch ? root.fetch.bind(root) : null);
    var state = { view: null, ui: { open: '', extraRows: 0 }, busy: false, docs: null };

    function draw() {
      if (kind === 'home') el.innerHTML = homeHtml(state.view);
      else if (kind === 'provider') el.innerHTML = providerHtml(state.view, state.ui);
      else {
        el.innerHTML = prestartHtml(state.view, state.ui);
        mountDocs();
      }
      if (typeof opts.onDraw === 'function') { try { opts.onDraw(state.view); } catch (e) { /* the page still works */ } }
    }

    // The document cards are the My Documents ones (js/my-documents-au.js):
    // one upload, one store, shown on both pages.
    function mountDocs() {
      var host = el.querySelector('[data-au-docs]');
      if (!host || !root.GPMyDocumentsAu || !isView(state.view) || !state.view.placed) return;
      var keys = [];
      state.view.items.forEach(function (item) { if (item.documentKey && keys.indexOf(item.documentKey) === -1) keys.push(item.documentKey); });
      if (!keys.length) { host.innerHTML = '<div class="aud-state"><p>Nothing to upload right now.</p></div>'; return; }
      state.docs = root.GPMyDocumentsAu.mount(host, {
        keys: keys,
        anchorPrefix: 'auDoc-',
        emptyHtml: '<div class="aud-state"><p>Nothing to upload right now.</p></div>',
        onChange: function () { refresh(true); }
      });
      state.docs.load();
    }

    function say(key, text, tone) {
      var node = el.querySelector('[data-au-msg="' + key + '"]');
      if (!node) return;
      node.textContent = text || '';
      node.className = 'aua-msg' + (tone ? ' tone-' + tone : '');
      node.hidden = !text;
    }

    function load() {
      el.innerHTML = '<div class="aua-state" aria-busy="true"><p>Loading…</p></div>';
      return refresh(false);
    }

    // `quiet`: keep what is on screen and only redraw the checklist cards.
    function refresh(quiet) {
      if (!fetcher) { el.innerHTML = messageHtml('We could not load this page', 'Please refresh the page.', true); return Promise.resolve(false); }
      return fetcher(API, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
        .then(function (res) {
          if (res && res.status === 404) return { notHere: true };
          if (!res || !res.ok) return null;
          return res.json();
        })
        .then(function (data) {
          if (data && data.notHere) {
            if (typeof opts.onNotAvailable === 'function') opts.onNotAvailable();
            else el.innerHTML = messageHtml('Nothing to show here', 'Please go back to your home page.', false);
            return false;
          }
          if (!isView(data)) {
            if (!quiet) el.innerHTML = messageHtml('We could not load this page', 'Check your connection and try again. Nothing has been lost.', true);
            return false;
          }
          state.view = data;
          // The right page for this doctor is on screen: forget the "asked
          // for it again" markers js/au-page-handover.js leaves.
          try {
            var gone = [];
            for (var i = 0; i < root.sessionStorage.length; i++) {
              var k = root.sessionStorage.key(i);
              if (k && k.indexOf('gp_au_page_swap:') === 0) gone.push(k);
            }
            gone.forEach(function (k) { root.sessionStorage.removeItem(k); });
          } catch (e) { /* private mode */ }
          if (quiet && kind === 'prestart') redrawItems(); else draw();
          return true;
        })
        .catch(function () {
          if (!quiet) el.innerHTML = messageHtml('We could not load this page', 'Check your connection and try again. Nothing has been lost.', true);
          return false;
        });
    }

    // After an upload: update the checklist cards and the progress line, and
    // leave the document cards (and the message just shown on one) alone.
    function redrawItems() {
      var scratch = document.createElement('div');
      scratch.innerHTML = prestartHtml(state.view, state.ui);
      Array.prototype.forEach.call(scratch.querySelectorAll('[data-au-item]'), function (fresh) {
        var old = el.querySelector('[data-au-item="' + fresh.getAttribute('data-au-item') + '"]');
        if (old && old.parentNode) old.parentNode.replaceChild(fresh, old);
      });
      var freshProgress = scratch.querySelector('.aua-progress');
      var oldProgress = el.querySelector('.aua-progress');
      if (freshProgress && oldProgress && oldProgress.parentNode) oldProgress.parentNode.replaceChild(freshProgress, oldProgress);
    }

    function post(path, body, msgKey, okText) {
      if (state.busy || !fetcher) return Promise.resolve(false);
      state.busy = true;
      say(msgKey, 'Saving…', '');
      return fetcher(API + path, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body)
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          state.busy = false;
          if (!res.ok || !data || data.ok !== true) {
            say(msgKey, (data && data.message) || 'We could not save that. Please try again.', 'bad');
            return false;
          }
          if (data.impersonated === true) {
            say(msgKey, 'Preview only: nothing was saved.', '');
            return false;
          }
          if (isView(data)) state.view = data;
          state.ui.open = '';
          state.ui.extraRows = 0;
          draw();
          say(msgKey, okText, 'good');
          if (typeof opts.onSaved === 'function') { try { opts.onSaved(state.view); } catch (e) { /* ignore */ } }
          return true;
        });
      }).catch(function () {
        state.busy = false;
        say(msgKey, 'We could not save that. Check your connection and try again.', 'bad');
        return false;
      });
    }

    function readReferees() {
      var out = [{}, {}];
      Array.prototype.forEach.call(el.querySelectorAll('[data-au-ref]'), function (input) {
        var n = Number(input.getAttribute('data-au-ref')) - 1;
        var field = input.getAttribute('data-au-ref-field');
        if (n !== 0 && n !== 1) return;
        if (field === 'agreed') out[n].agreedToContact = input.checked === true;
        else if (field === 'current') { if (input.checked) out[n].atCurrentPractice = input.value === 'yes'; }
        else out[n][field] = input.value;
      });
      return out;
    }

    function readExisting() {
      var rows = [];
      Array.prototype.forEach.call(el.querySelectorAll('[data-au-existing-row]'), function (row) {
        var number = row.querySelector('[data-au-existing="number"]');
        var location = row.querySelector('[data-au-existing="location"]');
        var value = number ? String(number.value || '').trim() : '';
        if (value) rows.push({ number: value, location: location ? String(location.value || '').trim() : '' });
      });
      return rows;
    }

    function shellRoute(href) {
      try {
        if (root.parent && root.parent !== root) {
          root.parent.postMessage({ type: 'gp-shell-route', href: href, title: 'GP Link' }, root.location.origin);
          return true;
        }
      } catch (e) { /* fall through */ }
      return false;
    }

    el.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var route = target.closest('[data-au-route]');
      if (route) {
        if (shellRoute(route.getAttribute('data-au-route'))) event.preventDefault();
        return;
      }
      if (target.closest('[data-au-retry]')) { load(); return; }
      var opener = target.closest('[data-au-open]');
      if (opener) {
        var key = opener.getAttribute('data-au-open');
        state.ui.open = state.ui.open === key ? '' : key;
        var card = el.querySelector('[data-au-item="' + key + '"]');
        var form = card ? card.querySelector('.aua-form') : null;
        if (form) {
          form.hidden = state.ui.open !== key;
          if (!form.hidden) { var first = form.querySelector('input'); if (first) { try { first.focus({ preventScroll: true }); } catch (e) { /* older browsers */ } } }
        }
        return;
      }
      var jump = target.closest('[data-au-jump]');
      if (jump) {
        event.preventDefault();
        var cardEl = el.querySelector('[data-aud-key="' + String(jump.getAttribute('data-au-jump')).replace(/[^a-z0-9_]/gi, '') + '"]');
        if (cardEl) { cardEl.classList.add('is-focus'); try { cardEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { cardEl.scrollIntoView(); } }
        return;
      }
      if (target.closest('[data-au-add-row]')) {
        var listEl = el.querySelector('[data-au-existing-list]');
        if (listEl && listEl.querySelectorAll('[data-au-existing-row]').length < 8) {
          var holder = document.createElement('div');
          holder.innerHTML = existingRow(0, null);
          listEl.appendChild(holder.firstChild);
        }
        return;
      }
      var save = target.closest('[data-au-save]');
      if (!save) return;
      var what = save.getAttribute('data-au-save');
      if (what === 'notice') {
        var given = el.querySelector('[data-au-notice-given]');
        var date = el.querySelector('[data-au-notice-date]');
        if (!given || given.checked !== true) { say('notice', 'Please tick the box once you have given notice.', 'bad'); return; }
        if (!date || !date.value) { say('notice', 'Please give the date you gave notice.', 'bad'); return; }
        post('/notice', { given: true, date: date.value }, 'notice', 'Saved. Thank you.');
      } else if (what === 'referees') {
        post('/referees', { referees: readReferees() }, 'referees', 'Saved. Thank you.');
      } else if (what === 'existing') {
        var prescriber = el.querySelector('[data-au-prescriber]');
        post('/provider-details', { existingProviderNumbers: readExisting(), prescriberNumber: prescriber ? prescriber.value : '' }, 'existing', 'Saved.');
      } else if (what === 'new') {
        var input = el.querySelector('[data-au-new-number]');
        var value = input ? String(input.value || '').trim() : '';
        if (!value) { say('new', 'Please enter the provider number.', 'bad'); return; }
        post('/provider-details', { newLocationProviderNumber: value }, 'new', 'Saved. Your number is on file.');
      }
    });

    return { load: load, refresh: refresh, state: state };
  }

  var api = {
    mountHome: function (el, options) { return mount(el, 'home', options); },
    mountPrestart: function (el, options) { return mount(el, 'prestart', options); },
    mountProviderNumber: function (el, options) { return mount(el, 'provider', options); },
    formatDay: formatDay,
    // Exposed for tests: pure rendering and wording.
    _homeHtml: homeHtml,
    _prestartHtml: prestartHtml,
    _providerHtml: providerHtml,
    _stepsHtml: stepsHtml,
    _nextForDoctor: nextForDoctor
  };

  root.GPAuPrestart = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);

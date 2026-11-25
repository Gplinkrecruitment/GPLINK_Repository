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

  /**
   * 2027-02-01 -> 1 Feb 2027. '' for anything that is not a date.
   * FB-2b (W3-D23, R14): the one Australian date style ("20 Nov 2026"), and a
   * date-only value is that calendar date wherever the device is: it is read
   * as UTC and printed in UTC, never moved by the viewer's own zone.
   */
  var MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function formatDay(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value == null ? '' : value).slice(0, 10));
    if (!m) return '';
    var month = Number(m[2]);
    var day = Number(m[3]);
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return '';
    var check = new Date(Date.UTC(Number(m[1]), month - 1, day));
    if (isNaN(check.getTime()) || check.getUTCDate() !== day) return '';
    return day + ' ' + MONTHS_SHORT[month - 1] + ' ' + m[1];
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
  var HOLD_BODY = 'Thank you for telling us about your registration. Before we can take things further, one of our team needs to confirm a few details with you. You do not need to do anything now: we will be in touch by email, usually within two working days.';

  // ── Home ───────────────────────────────────────────────────────────────────
  // FB-2b: Home is drawn from ONE value, `view.viewState`, which the server
  // works out (lib/au-gp-app.js doctorViewState):
  //   looking | prestart | cleared | first_week | settling_in | settled | ended
  // Nothing here decides the state from a date, a stage or a count.
  function capTeam(view) {
    return esc(view.teamLabel ? view.teamLabel.charAt(0).toUpperCase() + view.teamLabel.slice(1) : 'Your GP Link team');
  }
  function viewStateOf(view) {
    var known = { looking: 1, prestart: 1, cleared: 1, first_week: 1, settling_in: 1, settled: 1, ended: 1 };
    if (view && known[view.viewState]) return view.viewState;
    // A server that has not said (an older response): the same answer from the
    // fields that were always sent.
    if (!view || !view.placed) return 'looking';
    if (view.placementEnded) return 'ended';
    if (view.started) return 'settling_in';
    return view.complete ? 'cleared' : 'prestart';
  }
  // "Start date: 14 Dec 2026", "Expected start date: ...", or "to be confirmed"
  // only when there truly is no date on file.
  function startLineHtml(view) {
    if (!view.startDate) return 'Start date: to be confirmed';
    var confirmed = view.startDateSource === 'confirmed' || (view.startDateSource === undefined && view.startDateConfirmed);
    return (confirmed ? 'Start date: ' : 'Expected start date: ') + '<strong>' + esc(formatDay(view.startDate)) + '</strong>'
      + (confirmed ? '' : ' (to be confirmed)');
  }
  function daysToStartText(view) {
    var n = view.startsInDays;
    if (typeof n !== 'number' || !isFinite(n)) return '';
    if (n > 1) return n + ' days to go.';
    if (n === 1) return 'You start tomorrow.';
    if (n === 0) return 'You start today.';
    return '';
  }
  function countHtml(view) {
    if (!view.counts || !view.counts.total) return '';
    return '<p class="aua-muted">' + esc(view.counts.done) + ' of ' + esc(view.counts.total) + ' pre-start items done</p>'
      + '<div class="aua-bar" aria-hidden="true"><span style="width:' + Math.round((view.counts.done / view.counts.total) * 100) + '%"></span></div>';
  }
  function stillNeededHtml(view) {
    var n = Array.isArray(view.stillNeeded) ? view.stillNeeded.length : 0;
    if (!n) return '';
    return '<p>' + (n === 1 ? 'One item is' : n + ' items are') + ' still needed from before you started.</p>'
      + '<div class="aua-actions">' + routeLink('/pages/prestart', 'See what is still needed', true) + '</div>';
  }

  // FR-1 (R-09): the doctor has given notice at this practice. Said plainly,
  // in place of "we will check in with you".
  function leavingHtml(view) {
    var day = view && view.leaving && view.leaving.lastWorkingDay ? view.leaving.lastWorkingDay : '';
    if (!day) return '';
    var practice = view.practiceName ? esc(view.practiceName) : 'this practice';
    return '<section class="aua-card" data-au-state="leaving"><p class="aua-kicker">Your notice</p><h2>Your last working day at ' + practice + ' is ' + esc(formatDay(day)) + '</h2>'
      + '<p>We have this on file, so you will not get our usual check-in messages about this role. When you are ready to look at what is next, message us or browse roles.</p>'
      + '<div class="aua-actions">' + routeLink('/pages/messages', 'Message us', false) + routeLink('/pages/career', 'See roles', false) + '</div></section>';
  }

  function homeHtml(view) {
    if (!isView(view)) return messageHtml('We could not load your home page', 'Check your connection and try again. Nothing has been lost.', true);
    var out = [];
    var state = viewStateOf(view);
    var practice = view.practiceName ? esc(view.practiceName) : 'your new practice';
    var showSteps = true;
    if (view.leaving && view.leaving.lastWorkingDay && (state === 'first_week' || state === 'settling_in' || state === 'settled')) {
      out.push(leavingHtml(view));
      return out.join('');
    }
    if (state === 'looking') {
      if (view.launched === false) {
        out.push('<section class="aua-card aua-hold"><h2>' + esc(HOLD_TITLE) + '</h2><p>' + esc(HOLD_BODY) + '</p>'
          + '<div class="aua-actions">' + routeLink('/pages/messages', 'Message us', false) + '</div></section>');
      } else {
        out.push('<section class="aua-card aua-next"><p class="aua-kicker">Your next step</p><h2>Find your practice</h2>'
          + '<p>Browse the roles that fit you, meet the practice and sign your offer in the app. ' + esc(CONFIDENTIAL) + '</p>'
          + '<div class="aua-actions">' + routeLink('/pages/career', 'See roles', true) + '</div></section>');
      }
    } else if (state === 'ended') {
      // WP-13: the placement has ended. Say so; never draw an empty checklist.
      out.push(endedHtml(view));
      showSteps = false;
    } else if (state === 'settled') {
      // The settling-in period has finished and the doctor is still there.
      out.push('<section class="aua-card" data-au-state="settled"><p class="aua-kicker">Your practice</p><h2>You are with ' + practice + '</h2>'
        + '<p>' + (view.startedOn ? 'You have been there since <strong>' + esc(formatDay(view.startedOn)) + '</strong>. ' : '')
        + 'There is nothing you need to do here. If anything comes up, ' + esc(view.teamLabel || 'your GP Link team') + ' is a message away.</p>'
        + '<div class="aua-actions">' + routeLink('/pages/messages', 'Message us', false) + routeLink('/pages/career', 'See roles', false) + '</div></section>');
      showSteps = false;
    } else if (state === 'first_week') {
      out.push('<section class="aua-card" data-au-state="first_week"><p class="aua-kicker">You have started</p><h2>Welcome to ' + practice + '</h2>'
        + '<p>' + (view.startedOn ? 'You started on <strong>' + esc(formatDay(view.startedOn)) + '</strong>. ' : '')
        + 'We will check in with you at the end of your first week. If anything needs sorting out before then, message us.</p>'
        + '<div class="aua-actions">' + routeLink('/pages/messages', 'Message us', false) + '</div>'
        + stillNeededHtml(view) + '</section>');
    } else if (state === 'settling_in') {
      out.push('<section class="aua-card" data-au-state="settling_in"><p class="aua-kicker">Settling in</p><h2>You have started at ' + practice + '</h2>'
        + '<p>' + (view.startedOn ? 'Your first day was <strong>' + esc(formatDay(view.startedOn)) + '</strong>. ' : '')
        + capTeam(view) + ' will check in with you from time to time. You can message us whenever you like.</p>'
        + '<div class="aua-actions">' + routeLink('/pages/messages', 'Message us', false) + '</div>'
        + stillNeededHtml(view) + '</section>');
    } else {
      // prestart | cleared
      var next = nextForDoctor(view);
      if (state === 'cleared') {
        out.push('<section class="aua-card" data-au-state="cleared"><p class="aua-kicker">You are cleared to start</p><h2>Everything on your checklist is done</h2>'
          + '<p>' + startLineHtml(view) + ' at ' + practice + '. ' + esc(daysToStartText(view)) + '</p></section>');
      } else if (next) {
        out.push('<section class="aua-card aua-next" data-au-state="prestart"><p class="aua-kicker">Your next step</p><h2>' + esc(next.title) + '</h2>'
          + '<p>' + esc(withDates(next.whatToDo)) + '</p>'
          + '<div class="aua-actions">' + routeLink(next.key === 'provider_number' ? '/pages/pbs' : '/pages/prestart', 'Open my pre-start checklist', true) + '</div></section>');
      } else {
        out.push('<section class="aua-card" data-au-state="prestart"><p class="aua-kicker">Nothing needed from you right now</p><h2>We are working through the rest</h2>'
          + '<p>The remaining items on your checklist are with GP Link or ' + practice + '. We will message you if we need anything.</p>'
          + '<div class="aua-actions">' + routeLink('/pages/prestart', 'See my checklist', false) + '</div></section>');
      }
      out.push('<section class="aua-card"><h3>' + practice + '</h3>'
        + '<p>' + startLineHtml(view) + (daysToStartText(view) && state !== 'cleared' ? ' <span class="aua-muted">' + esc(daysToStartText(view)) + '</span>' : '') + '</p>'
        + countHtml(view)
        + '</section>');
    }
    if (showSteps) {
      out.push('<h2 class="aua-section-title">Your steps</h2>');
      out.push(stepsHtml(view.steps));
    }
    out.push('<section class="aua-card"><h3>Need a hand?</h3><p>' + capTeam(view)
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

  // Round 8 (S8-05): the latest date the notice field allows is today at the
  // PRACTICE (sent by the server), not on this phone. Falls back to the
  // phone's day when the server did not say; the server checks either way.
  function noticeMaxDay(view) {
    var day = view && typeof view.practiceToday === 'string' ? view.practiceToday : '';
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : todayIso();
  }

  function formsFor(item, view, ui) {
    var open = ui && ui.open === item.key;
    var d = view.details || {};
    if (item.action && item.action.kind === 'notice') {
      return '<div class="aua-form" data-au-form="notice"' + (open ? '' : ' hidden') + '>'
        + '<label class="aua-check"><input type="checkbox" data-au-notice-given' + (d.noticeGiven ? ' checked' : '') + '><span>I have given notice at my current practice.</span></label>'
        + '<label class="aua-field">Date you gave notice<input type="date" data-au-notice-date max="' + esc(noticeMaxDay(view)) + '" value="' + esc(d.noticeGivenDate || '') + '"></label>'
        + (view.practiceClock ? '<p class="aua-step-sub" data-au-notice-clock>Dates use the practice\'s clock (' + esc(view.practiceClock) + ').</p>' : '')
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
    // FB-2b (A3): a card that is shown but not counted says so, beside its
    // title ("Optional" / "For your information"): the count above the list is
    // then the number the doctor can check against the cards.
    var countTag = item.countLabel ? '<span class="aua-tag" data-au-not-counted>' + esc(item.countLabel) + '</span>' : '';
    // FB-2b (W3-D14): after the start, an open counted item is "Still needed",
    // drawn as needing attention, with the reason under it.
    var tone = item.stillNeeded && item.status !== 'waiting' ? 'needed' : item.status;
    return '<section class="aua-card" data-au-item="' + esc(item.key) + '"' + (item.key === 'start_date' ? ' id="start-date"' : '') + '>'
      + '<div class="aua-item-head"><h3>' + esc(item.title) + countTag + '</h3><span class="aua-pill tone-' + esc(tone) + '">' + esc(item.statusLabel) + '</span></div>'
      + '<p class="aua-who">Who: ' + esc(item.whoLabel) + '</p>'
      + '<p>' + esc(withDates(item.whatToDo)) + '</p>'
      + (item.why ? '<p class="aua-why"><strong>Why it is still needed:</strong> ' + esc(item.why) + '</p>' : '')
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
    var state = viewStateOf(view);
    // WP-13: the placement has ended. There is no checklist to show.
    if (state === 'ended' || view.placementEnded) return endedHtml(view);
    var practice = view.practiceName ? esc(view.practiceName) : 'your new practice';
    var out = [];
    var started = state === 'first_week' || state === 'settling_in' || state === 'settled' || view.started === true;
    if (started) {
      // FB-2b (W3-D14, R3): after the start this page is a record, not a
      // to-do list. What is genuinely still needed comes first, with why;
      // then what was completed. No "N of M" counter.
      var needed = view.items.filter(function (item) { return item.stillNeeded === true; });
      var rest = view.items.filter(function (item) { return item.stillNeeded !== true; });
      out.push('<section class="aua-card" data-au-started data-au-state="' + esc(state) + '"><p class="aua-kicker">' + (state === 'settled' ? 'Your practice' : 'You have started') + '</p>'
        + '<h2>' + (state === 'settled' ? 'You are with ' + practice : 'You have started at ' + practice) + '</h2>'
        + '<p>' + (view.startedOn ? (state === 'settled' ? 'You have been there since <strong>' : 'Your first day was <strong>') + esc(formatDay(view.startedOn)) + '</strong>. ' : '')
        + (needed.length
          ? (needed.length === 1 ? 'One item from before you started is still needed.' : needed.length + ' items from before you started are still needed.') + ' The rest is here for your records.'
          : 'Everything we needed before you started is done. It is here for your records.')
        + '</p><div class="aua-actions">' + routeLink('/pages/messages', 'Message us', false) + '</div></section>');
      if (needed.length) {
        out.push('<h2 class="aua-section-title" data-au-section="still-needed">Still needed (' + needed.length + ')</h2>');
        needed.forEach(function (item) { out.push(itemHtml(item, view, ui)); });
      }
      out.push('<h2 class="aua-section-title" data-au-section="completed">' + (needed.length ? 'Completed' : 'Completed before you started') + '</h2>');
      rest.forEach(function (item) { out.push(itemHtml(item, view, ui)); });
      if (needed.some(function (item) { return !!item.documentKey; })) {
        out.push('<h2 class="aua-section-title" id="auDocsHeading">Documents to upload</h2>');
        out.push('<div id="auPrestartDocs" data-au-docs data-au-docs-keys="' + esc(needed.filter(function (item) { return !!item.documentKey; }).map(function (item) { return item.documentKey; }).join(',')) + '"></div>');
      }
      return out.join('');
    }
    var anyNotCounted = view.items.some(function (item) { return !!item.countLabel; });
    out.push('<p class="aua-progress">' + esc(view.counts.done) + ' of ' + esc(view.counts.total) + ' done'
      + '<span class="aua-bar" aria-hidden="true" style="display:block"><span style="width:' + (view.counts.total ? Math.round((view.counts.done / view.counts.total) * 100) : 0) + '%"></span></span>'
      + (anyNotCounted ? '<span class="aua-muted" style="display:block" data-au-count-note>Items marked "Optional" or "For your information" are not part of this count.</span>' : '')
      + '</p>');
    if (state === 'cleared' || view.complete) {
      out.push('<section class="aua-card" data-au-state="cleared"><p class="aua-kicker">You are cleared to start</p><h2>You are ready for your first day at ' + practice + '</h2>'
        + '<p>' + startLineHtml(view) + (daysToStartText(view) ? ' <span class="aua-muted">' + esc(daysToStartText(view)) + '</span>' : '') + '</p></section>');
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
      + '<span class="aua-pill tone-' + (np.recorded ? 'done' : (np.pending ? 'waiting' : 'todo')) + '">' + (np.recorded ? 'On file' : (np.pending ? 'Being confirmed' : 'To do')) + '</span></div>'
      + (np.recorded
        ? '<p class="aua-number">' + esc(np.number) + '</p><p class="aua-muted">This is the number we hold for ' + practice + '. Message us if it is wrong.</p>'
        : (np.locked
          ? '<p class="aua-muted">There is nothing to enter here now. Message us if you need to tell us about a provider number.</p>'
          : ((np.pending
            ? '<p class="aua-number">' + esc(np.pendingNumber) + '</p><p class="aua-muted">This is the number you entered. We are confirming it. If you made a mistake, enter the right number below.</p>'
            : '<p>When Services Australia issues your number for this location, enter it here.</p>')
            + '<label class="aua-field">Provider number<input type="text" autocomplete="off" autocapitalize="characters" maxlength="20" placeholder="123456AB" data-au-new-number></label>'
            + '<p class="aua-msg" data-au-msg="new" hidden></p>'
            + '<div class="aua-actions"><button type="button" class="aua-btn aua-btn-primary" data-au-save="new">' + (np.pending ? 'Save corrected number' : 'Save number') + '</button></div>')))
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
      var only = host.getAttribute('data-au-docs-keys');
      if (only) keys = only.split(',').filter(Boolean);
      else state.view.items.forEach(function (item) { if (item.documentKey && keys.indexOf(item.documentKey) === -1) keys.push(item.documentKey); });
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
    _leavingHtml: leavingHtml,
    _stepsHtml: stepsHtml,
    _nextForDoctor: nextForDoctor
  };

  root.GPAuPrestart = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);

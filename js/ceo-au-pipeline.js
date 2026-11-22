/* Australian GP build, WP-27: the Australian pipeline, drawn in two places on
 * the CEO dashboard from ONE renderer so they cannot disagree:
 *
 *   - the Overview, as its own card under the lead -> placement funnel
 *     (js/ceo-overview.js hands it the `au` section of GET /api/ceo/overview);
 *   - Registration -> Pipeline, beside the overseas registration funnel
 *     (this file fetches GET /api/ceo/au-pipeline itself).
 *
 * It draws only what the server says. No number is worked out here, no stage
 * word is printed raw, and the commercial tile is drawn only when the server
 * sent one (the CEO). Nothing is drawn, and nothing is requested, unless the
 * server says the Australian switch is on (the Overview payload has `au`, or
 * the page's session says so). Classes are `aup-*` (never `ad-*`).
 *
 *   window.GPAuPipeline.html(view, opts)   -> HTML for the card ('' when off)
 *   window.GPAuPipeline.mount(el, opts)    -> fetch + draw into el (Pipeline tab)
 *   window.GPAuPipeline.wire(el)           -> click handling for a drawn card
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function num(n) { var v = Number(n); return isFinite(v) ? String(v) : '0'; }
  function plural(n, one, many) { n = Number(n) || 0; return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  // A calendar date (YYYY-MM-DD) as "15 Nov 2026": never through a time zone.
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function day(d) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
    return m ? Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1] : '';
  }
  function daysWords(n) {
    if (n === null || n === undefined || n === '' || !isFinite(Number(n))) return '';
    var v = Number(n);
    if (v < 14) { var d = Math.round(v); return d + (d === 1 ? ' day' : ' days'); }
    return (Math.round((v / 7) * 10) / 10) + ' weeks';
  }
  function money(n) {
    var v = Number(n);
    if (n === null || n === undefined || !isFinite(v)) return 'amount not on file';
    return '$' + String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' ex GST';
  }
  function windowWords(view) { return Number(view && view.window_days) === 30 ? 'last 30 days' : 'last 7 days'; }

  var INVOICE_WORDS = { due: 'not sent yet', sent: 'sent, waiting to be paid', overdue: 'sent, unpaid past its terms' };

  function doctorLink(d, focus) {
    var id = d.case_id || d.user_id || '';
    if (!id) return esc(d.name || d.gp_name || 'Doctor');
    return '<button type="button" class="aup-link" data-aup-act="open" data-id="' + esc(id) + '"' + (focus ? ' data-focus="' + esc(focus) + '"' : '') + '>' + esc(d.name || d.gp_name || 'Doctor') + '</button>';
  }
  function doctorRow(d) {
    var bits = [];
    if (d.pathway_label) bits.push(esc(d.pathway_label));
    if (d.practice_name) bits.push(esc(d.practice_name));
    if (d.start && d.start.text) bits.push(esc(d.start.text));
    if (d.days_in_stage !== null && d.days_in_stage !== undefined) bits.push(esc(daysWords(d.days_in_stage)) + ' here');
    return '<div class="aup-row"><div class="aup-row-main">' + doctorLink(d) + '<div class="aup-row-sub">' + bits.join(' · ') + '</div></div></div>';
  }
  function groupList(group) {
    var list = (group && group.doctors) || [];
    if (!list.length) return '<div class="aup-empty">Nobody here.</div>';
    return list.map(doctorRow).join('');
  }

  function cell(group, i) {
    var t = group.time_in_stage || {};
    var sub = group.count && t.sample_size ? 'typically ' + daysWords(t.median_days) + ' here' : '&nbsp;';
    return '<button type="button" class="aup-col' + (group.count ? '' : ' aup-zero') + '" data-aup-act="group" data-group="' + esc(group.key) + '" aria-expanded="false">' +
      '<span class="aup-col-step">' + (i + 1) + '</span>' +
      '<span class="aup-col-l">' + esc(group.label) + '</span>' +
      '<span class="aup-col-n">' + num(group.count) + '</span>' +
      '<span class="aup-col-s">' + sub + '</span></button>';
  }
  function chip(group, cls) {
    return '<button type="button" class="aup-chip' + (cls ? ' ' + cls : '') + (group.count ? '' : ' aup-zero') + '" data-aup-act="group" data-group="' + esc(group.key) + '" aria-expanded="false">' +
      esc(group.label) + ' <b>' + num(group.count) + '</b></button>';
  }
  function box(label, value, sub) {
    return '<div class="aup-box"><div class="aup-box-l">' + esc(label) + '</div><div class="aup-box-v">' + value + '</div>' + (sub ? '<div class="aup-box-s">' + sub + '</div>' : '') + '</div>';
  }

  function commercialHtml(c) {
    if (!c || !c.counts) return '';
    var n = c.counts;
    var line = function (key, label, count, extra) {
      return '<button type="button" class="aup-money' + (count ? '' : ' aup-zero') + '" data-aup-act="money" data-list="' + key + '" aria-expanded="false">' +
        '<span class="aup-money-n">' + num(count) + '</span><span class="aup-money-l">' + esc(label) + (extra ? ' <em>' + esc(extra) + '</em>' : '') + '</span></button>';
    };
    return '<div class="aup-sec">Invoices and the guarantee period <span class="aup-lock">you only</span></div>' +
      '<div class="aup-money-row">' +
        line('invoices_due', 'invoices due', n.invoicesDue, n.invoicesOverdue ? n.invoicesOverdue + ' unpaid past terms' : '') +
        line('in_guarantee', 'in the guarantee period', n.inGuarantee, '') +
        line('guarantee_ending_soon', 'guarantee ending within ' + (Number(c.ending_within_days) || 14) + ' days', n.guaranteeEndingSoon, '') +
      '</div>';
  }
  function moneyList(c, key) {
    var list = (c && c[key]) || [];
    if (!list.length) return '<div class="aup-empty">None.</div>';
    return list.map(function (it) {
      var bits = [];
      if (it.practice_name) bits.push(esc(it.practice_name));
      if (key === 'invoices_due') {
        bits.push(esc(money(it.fee_amount_ex_gst)));
        bits.push('invoice ' + esc(INVOICE_WORDS[it.invoice] || it.invoice || ''));
        if (it.invoice_sent_at) bits.push('sent ' + esc(day(it.invoice_sent_at)));
        else if (it.invoice_due_at) bits.push('due ' + esc(day(it.invoice_due_at)));
      } else {
        if (it.guarantee_ends_at) bits.push('guarantee period ends ' + esc(day(it.guarantee_ends_at)));
        if (it.guarantee_days_left !== null && it.guarantee_days_left !== undefined) bits.push(plural(it.guarantee_days_left, 'day') + ' left');
      }
      return '<div class="aup-row"><div class="aup-row-main">' + doctorLink(it, 'au_commencement') + '<div class="aup-row-sub">' + bits.join(' · ') + '</div></div></div>';
    }).join('');
  }

  function reviewHtml(r) {
    if (!r) return '';
    var items = r.items || [];
    if (!r.count) return '<div class="aup-sec">Needs you</div><div class="aup-empty">Nothing Australian is waiting on you.</div>';
    var rows = items.map(function (it) {
      return '<div class="aup-row"><div class="aup-row-main"><div class="aup-row-t">' + esc(it.title) + '</div><div class="aup-row-sub">' + esc(it.detail) + '</div></div>' +
        '<button type="button" class="aup-btn" data-aup-act="open" data-id="' + esc(it.case_id || it.user_id || '') + '" data-focus="' + esc(it.focus || '') + '">Open</button></div>';
    }).join('');
    var more = r.count > items.length ? '<div class="aup-more">and ' + (r.count - items.length) + ' more in <button type="button" class="aup-link" data-aup-act="queue">the review queue</button></div>' : '';
    return '<div class="aup-sec">Needs you <span class="aup-count">' + num(r.count) + '</span></div>' + rows + more;
  }

  /**
   * The card. `view` is the server's Australian section.
   *   opts.heading   the card title (default 'Australian GPs')
   *   opts.note      a line under the title
   */
  function html(view, opts) {
    var o = opts || {};
    if (!view || view.enabled !== true) return '';
    var head = '<div class="aup-head"><h3>' + esc(o.heading || 'Australian GPs') + '</h3><span class="aup-tag">already registered in Australia</span>' +
      '<span class="aup-head-note">' + esc(o.note || 'Counted here only. None of these doctors is in the overseas numbers.') + '</span></div>';
    if (view.ok !== true) {
      return '<div class="aup-card" data-aup-root="1">' + head + '<div class="aup-body"><div class="aup-empty">' + esc(view.message || 'The Australian doctors could not be read just now.') + '</div></div></div>';
    }
    var p = view.pipeline || {};
    var cols = p.columns || [];
    var before = p.before || [];
    var closing = p.closing || [];
    var held = p.held || { key: 'held', label: 'Needs review (not launched)', count: 0, doctors: [] };
    var a = p.activity || {};
    var t = (p.timing && p.timing.application_to_placement) || {};
    var latest = p.placements && p.placements.latest;
    var w = windowWords(view);

    var body = '';
    if (view.brief) body += '<p class="aup-brief">' + esc(view.brief) + '</p>';
    body += '<div class="aup-strip" role="group" aria-label="Australian pipeline">' + cols.map(cell).join('') + '</div>';
    body += '<div class="aup-chips"><span class="aup-chips-l">Not in the pipeline</span>' + before.map(function (g) { return chip(g); }).join('') +
      closing.map(function (g) { return chip(g); }).join('') + chip(held, 'aup-held') + '</div>';
    body += '<div class="aup-panel" data-aup-panel="1" hidden></div>';
    body += '<div class="aup-boxes">' +
      box('New leads', num(a.leads), w) +
      box('New sign-ups', num(a.signups), w) +
      box('Interviews booked', num(a.interviews_booked), w) +
      box('Placements', num(a.placements), w + ' · ' + num(p.placements && p.placements.total) + ' in all') +
      box('Commenced', num(a.commenced), w + ' · ' + num(p.commenced && p.commenced.total) + ' in all') +
      box('Application to placement', t.sample_size ? esc(daysWords(t.median_days)) : '<span class="aup-dim">no placements yet</span>', t.sample_size ? 'typical, over ' + plural(t.sample_size, 'placement') : 'Australian placements only') +
      '</div>';
    if (latest) {
      body += '<div class="aup-latest"><b>Latest placement:</b> ' + doctorLink(latest, 'au_commencement') + (latest.practice_name ? ' at ' + esc(latest.practice_name) : '') +
        (latest.start && latest.start.text ? ' · ' + esc(latest.start.text) : '') + '</div>';
    }
    var awaiting = (p.awaiting_ahpra_check && p.awaiting_ahpra_check.count) || 0;
    if (awaiting) body += '<div class="aup-latest">' + plural(awaiting, 'doctor is', 'doctors are') + ' waiting for their first Ahpra register check.</div>';
    body += commercialHtml(view.commercial);
    body += reviewHtml(view.review);
    return '<div class="aup-card" data-aup-root="1">' + head + '<div class="aup-body">' + body + '</div></div>';
  }

  // The view behind each drawn card (the node keeps no data of its own).
  var views = typeof WeakMap === 'function' ? new WeakMap() : null;
  function remember(el, view) { if (views && el) views.set(el, view); else if (el) el._aupView = view; }
  function recall(el) { return views ? views.get(el) : (el && el._aupView); }

  function groupOf(view, key) {
    var p = (view && view.pipeline) || {};
    var all = (p.columns || []).concat(p.before || [], p.closing || [], p.held ? [p.held] : []);
    for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
    return null;
  }
  function openDoctor(id, focus) {
    if (!id) return;
    var target = 'candidate=' + encodeURIComponent(id) + (focus ? '&focus=' + encodeURIComponent(focus) : '');
    var current = String(location.hash || '').replace(/^#/, '');
    if (current === target && window.ATS && typeof window.ATS.applyHash === 'function') window.ATS.applyHash();
    else location.hash = target;
  }
  function onClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-aup-act]') : null;
    if (!b) return;
    var rootEl = b.closest('[data-aup-root]');
    var host = rootEl ? rootEl.parentNode : null;
    var view = recall(host) || recall(rootEl);
    var act = b.getAttribute('data-aup-act');
    if (act === 'open') { openDoctor(b.getAttribute('data-id'), b.getAttribute('data-focus') || ''); return; }
    if (act === 'queue') { if (window.CeoReviewQueue && typeof window.CeoReviewQueue.open === 'function') window.CeoReviewQueue.open(); return; }
    var panel = rootEl ? rootEl.querySelector('[data-aup-panel]') : null;
    if (!panel || !view) return;
    var wasOpen = b.getAttribute('aria-expanded') === 'true';
    var all = rootEl.querySelectorAll('[aria-expanded="true"]');
    for (var i = 0; i < all.length; i++) all[i].setAttribute('aria-expanded', 'false');
    if (wasOpen) { panel.hidden = true; panel.innerHTML = ''; return; }
    var title = '', inner = '';
    if (act === 'group') {
      var g = groupOf(view, b.getAttribute('data-group'));
      if (!g) return;
      title = g.label + ' (' + g.count + ')';
      inner = groupList(g);
    } else if (act === 'money') {
      var key = b.getAttribute('data-list');
      title = ({ invoices_due: 'Invoices due', in_guarantee: 'In the guarantee period', guarantee_ending_soon: 'Guarantee period ending soon' })[key] || '';
      inner = moneyList(view.commercial, key);
    } else return;
    b.setAttribute('aria-expanded', 'true');
    panel.innerHTML = '<div class="aup-panel-h">' + esc(title) + '<button type="button" class="aup-link" data-aup-act="' + esc(act) + '" data-group="' + esc(b.getAttribute('data-group') || '') + '" data-list="' + esc(b.getAttribute('data-list') || '') + '" aria-expanded="true">Close</button></div>' + inner;
    panel.hidden = false;
  }
  function wire(el, view) {
    if (!el) return;
    if (view) remember(el, view);
    if (el._aupWired) return;
    el._aupWired = true;
    el.addEventListener('click', onClick);
  }

  /** Registration -> Pipeline: fetch the section and draw it into `el`. */
  function mount(el, opts) {
    if (!el) return Promise.resolve(null);
    var o = opts || {};
    var api = (window.ATS && typeof window.ATS.api === 'function') ? window.ATS.api : null;
    var get = api ? function (p) { return api(p); } : function (p) {
      return fetch(p, { credentials: 'same-origin' }).then(function (r) { return r.status === 404 ? { ok: false, off: true } : r.json(); });
    };
    return Promise.resolve(get('/api/ceo/au-pipeline?window=' + (o.window === '30d' ? '30d' : '7d'))).then(function (d) {
      var view = d && d.ok ? d.au : null;
      el.innerHTML = view ? html(view, o) : '';
      el.hidden = !view;
      if (view) wire(el, view);
      return view;
    }, function () { el.innerHTML = ''; el.hidden = true; return null; });
  }

  window.GPAuPipeline = { html: html, mount: mount, wire: wire, daysWords: daysWords, day: day, money: money };
})();

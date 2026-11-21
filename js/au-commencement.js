/*
 * WP-13 (Australian GP build): the staff "Commencement and guarantee" card.
 *
 * One small widget used by both staff screens: the CEO dashboard's candidate
 * profile and the admin case page. It draws what GET /api/admin/au/commencement
 * says and posts to the actions under it. The server decides everything: who
 * may press what (`can`), the fee (from the practice's signed agreement, or
 * "confirm sessions/agreement before invoicing"), and every date rule.
 *
 * It shows NOTHING unless the server answers for an Australian placement: with
 * the Australian switch off the route is a 404, and for an overseas doctor it
 * is a 409, and in both cases the card stays hidden and the page is exactly
 * what it was.
 *
 * Nothing here raises an invoice. "Mark invoice sent" records what a person
 * did by hand in the accounting system.
 *
 *   GPAuCommencement.mount(element, { caseId, onChange? }) -> { reload }
 */
(function (root) {
  'use strict';

  var API = '/api/admin/au/commencement';
  var STYLE_ID = 'gp-au-commencement-style';
  var CSS = ''
    + '.auc{font:inherit;color:inherit}'
    + '.auc h4{margin:0 0 4px;font-size:15px;font-weight:700}'
    + '.auc .auc-sub{margin:0 0 12px;font-size:13px;opacity:.75}'
    + '.auc dl{display:grid;grid-template-columns:minmax(120px,34%) 1fr;gap:6px 12px;margin:0 0 12px;font-size:13px}'
    + '.auc dt{opacity:.7}.auc dd{margin:0;font-weight:600;word-break:break-word}'
    + '.auc .auc-warn{background:#fff7ed;border:1px solid #fdba74;color:#7c2d12;border-radius:8px;padding:8px 10px;font-size:13px;margin:0 0 12px}'
    + '.auc .auc-ok{background:#f0fdf4;border:1px solid #86efac;color:#14532d;border-radius:8px;padding:8px 10px;font-size:13px;margin:0 0 12px}'
    + '.auc .auc-actions{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 4px}'
    + '.auc button{font:inherit;font-size:13px;font-weight:600;border-radius:8px;border:1px solid #cbd5e1;background:#fff;color:#0f172a;padding:8px 12px;cursor:pointer;min-height:36px}'
    + '.auc button.auc-primary{background:#2563eb;border-color:#2563eb;color:#fff}'
    + '.auc button.auc-danger{border-color:#fca5a5;color:#b91c1c}'
    + '.auc button:disabled{opacity:.55;cursor:default}'
    + '.auc form{border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:10px 0 0;background:#f8fafc;color:#0f172a}'
    + '.auc form h5{margin:0 0 8px;font-size:14px}'
    + '.auc label{display:block;font-size:12px;font-weight:600;margin:8px 0 4px}'
    + '.auc input[type=text],.auc input[type=date],.auc input[type=number],.auc select,.auc textarea{width:100%;box-sizing:border-box;font:inherit;font-size:14px;padding:8px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#0f172a}'
    + '.auc textarea{min-height:60px;resize:vertical}'
    + '.auc .auc-check{display:flex;gap:8px;align-items:flex-start;font-weight:500;font-size:13px}'
    + '.auc .auc-check input{margin-top:2px}'
    + '.auc .auc-hint{font-size:12px;opacity:.75;margin:4px 0 0}'
    + '.auc .auc-err{color:#b91c1c;font-size:13px;margin:8px 0 0}'
    + '.auc ul.auc-tasks{list-style:none;margin:0 0 12px;padding:0;font-size:13px}'
    + '.auc ul.auc-tasks li{display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-top:1px solid rgba(148,163,184,.3)}'
    + '.auc ul.auc-tasks li span:last-child{opacity:.7;white-space:nowrap}';

  function ensureStyle(doc) {
    if (!doc || doc.getElementById(STYLE_ID)) return;
    var s = doc.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // "1 Feb 2027" for 2027-02-01 (a calendar day: no clock, no time zone).
  function day(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
    if (!m) return '';
    return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1];
  }
  function money(v) {
    var n = Number(v);
    if (v === null || v === undefined || v === '' || !isFinite(n)) return '';
    return '$' + n.toLocaleString('en-AU', { maximumFractionDigits: 2 });
  }
  var TIER = { full_time: 'Full-time (8 or more sessions a week)', part_time: 'Part-time (fewer than 8 sessions a week)' };
  var INVOICE = { not_due: 'Not due yet', due: 'Due: not yet sent', sent: 'Sent, waiting for payment', overdue: 'Sent and past its 7-day terms', paid: 'Paid' };
  var STATUS = { open: 'Open', in_progress: 'In progress', waiting: 'Waiting', completed: 'Done', cancelled: 'Cancelled' };

  function row(label, value) { return value ? '<dt>' + esc(label) + '</dt><dd>' + value + '</dd>' : ''; }

  function feeLine(p) {
    if (p.fee_amount_ex_gst !== null && p.fee_amount_ex_gst !== undefined) {
      return esc(money(p.fee_amount_ex_gst)) + ' ex GST' + (p.agreement_variant_label ? ' <span style="font-weight:400">(' + esc(p.agreement_variant_label) + ')</span>' : ' <span style="font-weight:400">(amount entered by hand)</span>');
    }
    return 'Not on file: confirm sessions/agreement before invoicing';
  }

  function previewHtml(v) {
    var f = v.fee_preview;
    if (!f) return '';
    if (f.known) {
      return '<p class="auc-ok">Fee on commencement, from the agreement this practice signed (' + esc(f.variant_label || f.variant) + '): '
        + esc(TIER[f.tier] || f.tier) + ', <strong>' + esc(money(f.amount_ex_gst)) + ' ex GST</strong>, invoiced in full on commencement.</p>';
    }
    return '<p class="auc-warn">The fee cannot be worked out yet: ' + esc(f.reason_text || 'something is missing') + '. '
      + 'You can still confirm commencement. The invoice task will then say "confirm sessions/agreement before invoicing" and show no amount.</p>';
  }

  function tasksHtml(v) {
    if (!v.tasks || !v.tasks.length) return '';
    return '<ul class="auc-tasks">' + v.tasks.map(function (t) {
      return '<li><span>' + esc(t.title) + '</span><span>' + (t.status === 'completed' || t.status === 'cancelled' ? esc(STATUS[t.status]) : (t.due_date ? 'Due ' + esc(day(t.due_date)) : esc(STATUS[t.status] || t.status))) + '</span></li>';
    }).join('') + '</ul>';
  }

  function btn(action, label, cls) { return '<button type="button" class="' + (cls || '') + '" data-auc-open="' + action + '">' + esc(label) + '</button>'; }

  function formHtml(action, v) {
    var p = v.placement || {};
    var today = v.today || '';
    var wrap = function (title, inner, submit, danger) {
      return '<form data-auc-form="' + action + '" novalidate><h5>' + esc(title) + '</h5>' + inner
        + '<p class="auc-err" data-auc-err hidden></p>'
        + '<div class="auc-actions" style="margin-top:12px"><button type="submit" class="' + (danger ? 'auc-danger' : 'auc-primary') + '">' + esc(submit) + '</button>'
        + '<button type="button" data-auc-cancel>Cancel</button></div></form>';
    };
    if (action === 'confirm') {
      var sessions = p.sessions_per_week_numeric !== null && p.sessions_per_week_numeric !== undefined ? p.sessions_per_week_numeric : (p.sessions_suggested || '');
      var pre = v.prestart || { complete: true, missing: [], open: [] };
      var outstanding = (pre.open || []).concat(pre.missing || []);
      return wrap('Confirm commenced',
        '<label for="aucDate">The day the doctor actually started</label><input type="date" id="aucDate" name="commenced_at" max="' + esc(today) + '" value="' + esc(p.start_date && p.start_date <= today ? p.start_date : today) + '" required>'
        + '<label for="aucSessions">Sessions a week (a number)</label><input type="number" id="aucSessions" name="sessions_per_week" min="0.5" max="14" step="0.5" inputmode="decimal" value="' + esc(sessions) + '">'
        + '<p class="auc-hint">8 or more is full-time under the agreement. ' + (p.sessions_text ? 'The offer says: "' + esc(p.sessions_text) + '".' : '') + '</p>'
        + '<label class="auc-check"><input type="checkbox" name="sessions_unknown"><span>Not known yet (the invoice task will ask for it before anything is invoiced)</span></label>'
        + (pre.complete ? '' : '<p class="auc-warn" style="margin-top:12px">The pre-start checklist is not finished' + (outstanding.length ? ': ' + esc(outstanding.join(', ')) : '') + '.</p>'
          + '<label class="auc-check"><input type="checkbox" name="override"><span>Confirm anyway: the doctor has started</span></label>'
          + '<label for="aucOverride">Why the doctor started without it (recorded in the audit log)</label><textarea id="aucOverride" name="override_reason" maxlength="500"></textarea>'),
        'Confirm commenced');
    }
    if (action === 'invoice-sent') {
      var needAmount = p.fee_amount_ex_gst === null || p.fee_amount_ex_gst === undefined;
      return wrap('Mark invoice sent',
        '<p class="auc-hint">Record an invoice you have already raised and sent by hand. The app sends nothing.</p>'
        + '<label for="aucSent">Date sent</label><input type="date" id="aucSent" name="sent_at" min="' + esc(p.commenced_at || '') + '" max="' + esc(today) + '" value="' + esc(today) + '" required>'
        + '<label for="aucRef">Invoice number</label><input type="text" id="aucRef" name="reference" maxlength="60" autocomplete="off" required>'
        + (needAmount ? '<label for="aucAmount">Amount invoiced, ex GST (the app could not work the fee out)</label><input type="text" id="aucAmount" name="amount_ex_gst" inputmode="decimal" autocomplete="off">' : ''),
        'Save');
    }
    if (action === 'invoice-paid') {
      return wrap('Mark invoice paid',
        '<label for="aucPaid">Date paid</label><input type="date" id="aucPaid" name="paid_at" min="' + esc(p.invoice_sent_at || '') + '" max="' + esc(today) + '" value="' + esc(today) + '" required>'
        + (p.invoice_payment_due_by ? '<p class="auc-hint">Due by ' + esc(day(p.invoice_payment_due_by)) + ' (seven days from the invoice date).</p>' : ''),
        'Save');
    }
    if (action === 'correct') {
      return wrap('Correct commencement details',
        '<p class="auc-hint">Changes the date (and the sessions, if needed) and re-dates the invoice due date, the guarantee end date and the open check-ins.</p>'
        + '<label for="aucCDate">Commencement date</label><input type="date" id="aucCDate" name="commenced_at" max="' + esc(today) + '" value="' + esc(p.commenced_at || '') + '">'
        + '<label for="aucCSessions">Sessions a week</label><input type="number" id="aucCSessions" name="sessions_per_week" min="0.5" max="14" step="0.5" inputmode="decimal" value="' + esc(p.sessions_per_week_numeric === null || p.sessions_per_week_numeric === undefined ? '' : p.sessions_per_week_numeric) + '">'
        + '<label for="aucCReason">Why it is being corrected</label><textarea id="aucCReason" name="reason" maxlength="500" required></textarea>',
        'Save correction');
    }
    if (action === 'undo') {
      return wrap('Commencement recorded in error',
        '<p class="auc-warn">Use this only when commencement was recorded for the wrong doctor, or the doctor did not start after all. It removes the commencement, cancels the invoice task and the check-ins, and returns the case to pre-start.</p>'
        + '<label for="aucUReason">What happened</label><textarea id="aucUReason" name="reason" maxlength="500" required></textarea>',
        'Remove the commencement', true);
    }
    if (action === 'early-exit') {
      return wrap('Doctor left during the guarantee',
        '<p class="auc-hint">Record this on or after the doctor\'s last working day. The agreement works the credit out from the last working day, not from the day notice is given.</p>'
        + '<label for="aucLast">Last working day</label><input type="date" id="aucLast" name="last_working_day" min="' + esc(p.commenced_at || '') + '" max="' + esc(today) + '" value="' + esc(today) + '" required>'
        + '<label for="aucWhy">Why the doctor left</label><select id="aucWhy" name="reason" required><option value="">Choose…</option>'
        + (v.exit_reasons || []).map(function (r) { return '<option value="' + esc(r.value) + '">' + esc(r.label) + '</option>'; }).join('') + '</select>'
        + '<label for="aucCond">Has the practice met the other conditions of clause 7.2? (told us promptly and in writing, inducted the doctor, met its other obligations, paid every other invoice on time)</label>'
        + '<select id="aucCond" name="conditions_confirmed"><option value="unknown">Not sure yet</option><option value="yes">Yes</option><option value="no">No</option></select>'
        + '<p class="auc-hint">If anything is not known, no credit is recorded and the CEO is asked to decide. The app never guesses a credit.</p>'
        + '<label for="aucNote">Note (staff only)</label><textarea id="aucNote" name="note" maxlength="400"></textarea>',
        'Record that the doctor left', true);
    }
    if (action === 'credit-decision') {
      return wrap('Record credit decision',
        '<p class="auc-hint">Read clause 7 of the agreement first. Enter the percentage of the placement fee to be credited (0 for none).</p>'
        + '<label for="aucPct">Credit (%)</label><input type="number" id="aucPct" name="credit_pct" min="0" max="100" step="1" inputmode="decimal" required>'
        + '<label for="aucPReason">How it was decided</label><textarea id="aucPReason" name="reason" maxlength="500" required></textarea>',
        'Save decision');
    }
    return '';
  }

  function viewHtml(v, openAction) {
    var p = v.placement;
    var s = v.state || {};
    var can = v.can || {};
    var out = ['<div class="auc"><h4>Commencement and guarantee</h4>'];
    if (!p) {
      out.push('<p class="auc-sub">No placement is recorded for this doctor yet.</p></div>');
      return out.join('');
    }
    out.push('<p class="auc-sub">' + esc(p.practice_name || 'Placement') + (p.job_title ? ' · ' + esc(p.job_title) : '') + '</p>');
    if (!s.commenced) {
      out.push('<dl>' + row('Planned start date', p.start_date ? esc(day(p.start_date)) : 'Not set')
        + row('Pre-start checklist', v.prestart && v.prestart.complete ? 'Complete' : 'Not finished') + '</dl>');
      out.push(previewHtml(v));
      if (can.confirm) out.push('<div class="auc-actions">' + btn('confirm', 'Confirm commenced', 'auc-primary') + '</div>');
      else out.push('<p class="auc-hint">A consultant or the CEO confirms commencement once the doctor has started.</p>');
    } else {
      out.push('<dl>'
        + row('Commenced', esc(day(p.commenced_at)) + (p.commencement_confirmed_by ? ' <span style="font-weight:400">(confirmed by ' + esc(p.commencement_confirmed_by) + ')</span>' : ''))
        + row('Sessions a week', p.sessions_per_week_numeric === null || p.sessions_per_week_numeric === undefined ? 'Not known yet' : esc(p.sessions_per_week_numeric))
        + row('Fee tier', p.fee_tier ? esc(TIER[p.fee_tier] || p.fee_tier) : 'Not known yet')
        + row('Placement fee', feeLine(p))
        + row('Invoice', esc(INVOICE[s.invoice] || s.invoice)
          + (p.invoice_sent_at ? ' <span style="font-weight:400">· ' + esc(p.invoice_reference || '') + ' sent ' + esc(day(p.invoice_sent_at)) + (p.invoice_paid_at ? ', paid ' + esc(day(p.invoice_paid_at)) : ', due by ' + esc(day(p.invoice_payment_due_by))) + '</span>' : ''))
        + row('Guarantee period ends', esc(day(p.guarantee_ends_at)) + (s.inGuarantee ? ' <span style="font-weight:400">(' + esc(s.guaranteeDaysLeft) + ' day' + (s.guaranteeDaysLeft === 1 ? '' : 's') + ' left)</span>' : ''))
        + (s.ended ? row('Doctor left', esc(day(p.ended_at)) + (p.end_reason ? ' <span style="font-weight:400">· ' + esc(p.end_reason) + '</span>' : ''))
          + row('Guarantee credit', p.credit_pct === null || p.credit_pct === undefined ? 'Not decided yet: the CEO decides (clause 7)' : esc(p.credit_pct) + '% of the placement fee') : '')
        + '</dl>');
      out.push(tasksHtml(v));
      var buttons = [];
      if (can.invoice_sent && !p.invoice_sent_at) buttons.push(btn('invoice-sent', 'Mark invoice sent', 'auc-primary'));
      if (can.invoice_paid) buttons.push(btn('invoice-paid', 'Mark invoice paid', 'auc-primary'));
      if (can.close) buttons.push('<button type="button" class="auc-primary" data-auc-post="close">Close case</button>');
      if (can.credit_decision) buttons.push(btn('credit-decision', 'Record credit decision', p.credit_pct === null || p.credit_pct === undefined ? 'auc-primary' : ''));
      if (can.early_exit) buttons.push(btn('early-exit', 'Doctor left during the guarantee'));
      if (can.correct) buttons.push(btn('correct', 'Correct commencement details'));
      if (can.undo) buttons.push(btn('undo', 'Commencement recorded in error', 'auc-danger'));
      if (buttons.length) out.push('<div class="auc-actions">' + buttons.join('') + '</div>');
    }
    if (openAction) out.push(formHtml(openAction, v));
    out.push('<p class="auc-err" data-auc-top-err hidden></p></div>');
    return out.join('');
  }

  function readForm(form) {
    var body = {};
    Array.prototype.forEach.call(form.querySelectorAll('input,select,textarea'), function (el) {
      if (!el.name) return;
      if (el.type === 'checkbox') body[el.name] = !!el.checked;
      else if (String(el.value).trim() !== '') body[el.name] = String(el.value).trim();
    });
    return body;
  }

  function mount(el, options) {
    var opts = options || {};
    var caseId = String(opts.caseId || '');
    var state = { view: null, open: '' };
    if (!el || !caseId || !root.fetch) return { reload: function () {} };
    ensureStyle(el.ownerDocument);

    function hide() { el.innerHTML = ''; el.hidden = true; }
    function draw() {
      if (!state.view) { hide(); return; }
      el.hidden = false;
      el.innerHTML = viewHtml(state.view, state.open);
    }
    function showErr(scope, text) {
      var node = (scope || el).querySelector(scope ? '[data-auc-err]' : '[data-auc-top-err]');
      if (node) { node.textContent = text; node.hidden = false; }
    }
    function reload() {
      return root.fetch(API + '?case_id=' + encodeURIComponent(caseId), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) { state.view = data && data.ok ? data : null; draw(); return state.view; })
        .catch(function () { state.view = null; hide(); return null; });
    }
    function post(action, body, scope, button) {
      if (button) button.disabled = true;
      return root.fetch(API + '/' + action, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(Object.assign({ case_id: caseId }, body || {}))
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (button) button.disabled = false;
          if (!res.ok || !data || !data.ok) {
            showErr(scope, (data && data.message) || 'That could not be saved. Please try again.');
            return null;
          }
          state.open = '';
          if (data.view) { state.view = data.view; draw(); } else reload();
          if (typeof opts.onChange === 'function') { try { opts.onChange(data); } catch (e) { /* the card is already redrawn */ } }
          return data;
        });
      }).catch(function () {
        if (button) button.disabled = false;
        showErr(scope, 'Could not reach the server. Nothing was saved.');
        return null;
      });
    }

    el.addEventListener('click', function (event) {
      var t = event.target;
      if (!t || !t.closest) return;
      var open = t.closest('[data-auc-open]');
      if (open) { event.preventDefault(); state.open = open.getAttribute('data-auc-open'); draw(); var f = el.querySelector('form [name]'); if (f && f.focus) { try { f.focus(); } catch (e) { /* not focusable */ } } return; }
      if (t.closest('[data-auc-cancel]')) { event.preventDefault(); state.open = ''; draw(); return; }
      var direct = t.closest('[data-auc-post]');
      if (direct) { event.preventDefault(); post(direct.getAttribute('data-auc-post'), {}, null, direct); }
    });
    el.addEventListener('submit', function (event) {
      var form = event.target && event.target.closest ? event.target.closest('[data-auc-form]') : null;
      if (!form) return;
      event.preventDefault();
      post(form.getAttribute('data-auc-form'), readForm(form), form, form.querySelector('button[type=submit]'));
    });

    reload();
    return { reload: reload };
  }

  root.GPAuCommencement = { mount: mount, _viewHtml: viewHtml, _formHtml: formHtml, _day: day, _money: money };
})(typeof window !== 'undefined' ? window : globalThis);

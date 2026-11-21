/*
 * WP-14 (Australian GP build): the staff "Segment B" card.
 *
 * One small widget used by both staff screens (the CEO dashboard's candidate
 * profile and the admin case page). It draws what GET /api/admin/au/segment-b
 * says and posts to the actions under it. The server decides everything.
 *
 * It shows NOTHING unless the server answers for a doctor it applies to: with
 * the Australian switch off the route is a 404, for an overseas doctor a 409,
 * and for a segment A doctor with nothing to do there is nothing to draw. In
 * each case the card stays hidden and the page is exactly what it was.
 *
 * Segment B is NOT launched. Nothing on this card contacts the doctor or the
 * practice except "Send the update (N21)", which a person must tick to confirm.
 *
 *   GPAuSegmentB.mount(element, { caseId, onChange? }) -> { reload }
 */
(function (root) {
  'use strict';

  var API = '/api/admin/au/segment-b';
  var STYLE_ID = 'gp-au-segment-b-style';
  var CSS = ''
    + '.asb{font:inherit;color:inherit}'
    + '.asb h4{margin:0 0 4px;font-size:15px;font-weight:700}'
    + '.asb h5{margin:16px 0 6px;font-size:14px;font-weight:700}'
    + '.asb .asb-sub{margin:0 0 10px;font-size:13px;opacity:.75}'
    + '.asb dl{display:grid;grid-template-columns:minmax(120px,34%) 1fr;gap:6px 12px;margin:0 0 10px;font-size:13px}'
    + '.asb dt{opacity:.7}.asb dd{margin:0;font-weight:600;word-break:break-word}'
    + '.asb .asb-warn{background:#fff7ed;border:1px solid #fdba74;color:#7c2d12;border-radius:8px;padding:8px 10px;font-size:13px;margin:0 0 10px}'
    + '.asb .asb-ok{background:#f0fdf4;border:1px solid #86efac;color:#14532d;border-radius:8px;padding:8px 10px;font-size:13px;margin:0 0 10px}'
    + '.asb .asb-note{background:#eff6ff;border:1px solid #93c5fd;color:#1e3a8a;border-radius:8px;padding:8px 10px;font-size:13px;margin:0 0 10px}'
    + '.asb .asb-actions{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 4px}'
    + '.asb button{font:inherit;font-size:13px;font-weight:600;border-radius:8px;border:1px solid #cbd5e1;background:#fff;color:#0f172a;padding:8px 12px;cursor:pointer;min-height:36px}'
    + '.asb button.asb-primary{background:#2563eb;border-color:#2563eb;color:#fff}'
    + '.asb button:disabled{opacity:.55;cursor:default}'
    + '.asb form{border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:10px 0 0;background:#f8fafc;color:#0f172a}'
    + '.asb form h6{margin:0 0 8px;font-size:14px;font-weight:700;color:#0f172a}'
    + '.asb form label{display:block;font-size:12px;font-weight:600;margin:10px 0 4px;color:#334155;text-transform:none;letter-spacing:0}'
    + '.asb form label.asb-check{display:flex;gap:8px;align-items:flex-start;font-weight:500;font-size:13px;color:#0f172a}'
    + '.asb form label.asb-check input{margin-top:2px}'
    + '.asb input[type=text],.asb input[type=date],.asb select,.asb textarea{width:100%;box-sizing:border-box;font:inherit;font-size:14px;padding:8px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#0f172a}'
    + '.asb textarea{min-height:60px;resize:vertical}'
    + '.asb .asb-hint{font-size:12px;opacity:.8;margin:4px 0 0;color:#0f172a}'
    + '.asb .asb-err{color:#b91c1c;font-size:13px;margin:8px 0 0}'
    + '.asb pre{white-space:pre-wrap;word-break:break-word;font:inherit;font-size:13px;background:#f8fafc;color:#0f172a;border:1px solid #e2e8f0;border-radius:8px;padding:10px;margin:6px 0 10px;max-height:260px;overflow:auto}'
    + '.asb ul.asb-tasks{list-style:none;margin:0 0 10px;padding:0;font-size:13px}'
    + '.asb ul.asb-tasks li{display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-top:1px solid rgba(148,163,184,.3)}'
    + '.asb ul.asb-tasks li span:last-child{opacity:.7;white-space:nowrap}';

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
  function day(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
    if (!m) return '';
    return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1];
  }
  var STATUS = { open: 'Open', in_progress: 'In progress', waiting: 'Waiting', waiting_on_practice: 'Waiting on the practice', waiting_on_gp: 'Waiting on the doctor', deferred: 'Not started', completed: 'Done', cancelled: 'Cancelled' };
  var REG_TYPE = { general: 'General', specialist: 'Specialist', general_and_specialist: 'General and specialist', provisional: 'Provisional', limited: 'Limited', non_practising: 'Non-practising' };
  var LEVEL = { none: 'None', level_1: 'Level 1', level_2: 'Level 2', level_3: 'Level 3', level_4: 'Level 4' };
  var RIGHTS = { citizen: 'Australian citizen', pr: 'Permanent resident', visa: 'Temporary visa' };
  var VISA_REASON = {
    citizen_or_permanent_resident: 'Citizen or permanent resident: there is no visa step.',
    segment_has_no_visa_stage: 'No visa step for this pathway.',
    visa_not_tied_to_an_employer: 'On a visa that is not tied to an employer: no transfer is needed.',
    visa_tied_to_an_employer: 'On a visa tied to the current employer: a transfer of nomination may be needed.',
    no_credentials_on_file: 'Nothing is on file about this doctor\'s right to work.',
    right_to_work_not_recorded: 'The right to work is not recorded.',
    sponsor_tie_not_recorded: 'On a visa, but it is not recorded whether it is tied to an employer.'
  };
  var MISSING = { moratorium: 'the 19AB result', supervision: 'the supervision answer (the registration must be checked on the register first)', visa: 'the visa decision' };

  function row(label, value) { return value ? '<dt>' + esc(label) + '</dt><dd>' + value + '</dd>' : ''; }
  function yesNo(v) { return v === true ? 'Yes' : (v === false ? 'No' : 'Not recorded'); }
  function taskList(tasks) {
    if (!tasks || !tasks.length) return '';
    return '<ul class="asb-tasks">' + tasks.map(function (t) {
      return '<li><span>' + esc(t.title) + '</span><span>' + esc(STATUS[t.status] || t.status || '') + (t.open && t.due_date ? ', due ' + esc(day(t.due_date)) : '') + '</span></li>';
    }).join('') + '</ul>';
  }
  function btn(action, label, cls) {
    return '<button type="button" class="' + (cls || '') + '" data-asb-open="' + esc(action) + '">' + esc(label) + '</button>';
  }
  function options(list, labels, selected) {
    return '<option value="">Leave as it is</option>' + (list || []).map(function (v) {
      return '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(labels[v] || v) + '</option>';
    }).join('');
  }

  // ── the forms ──
  function formHtml(action, v) {
    var visa = v.visa || {};
    var sup = v.supervision || {};
    var tc = visa.transfer_case || {};
    var head = function (title) { return '<form data-asb-form="' + esc(action) + '" novalidate><h6>' + esc(title) + '</h6>'; };
    var foot = function (label) {
      return '<p class="asb-err" data-asb-err hidden></p><div class="asb-actions" style="margin-top:12px">'
        + '<button type="submit" class="asb-primary">' + esc(label) + '</button><button type="button" data-asb-cancel>Cancel</button></div></form>';
    };
    if (action === 'visa-transfer/decision:confirm') {
      return head('Confirm: a nomination transfer is needed')
        + '<input type="hidden" name="decision" value="confirm">'
        + '<label>Current sponsoring employer</label><input type="text" name="current_sponsor" maxlength="200" value="' + esc(visa.sponsor_name || '') + '">'
        + '<label>Visa expiry date</label><input type="date" name="visa_expiry" value="' + esc(visa.visa_expiry || '') + '">'
        + '<label>Visa subclass (optional)</label><input type="text" name="visa_subclass" maxlength="40" value="' + esc(visa.visa_subclass || '') + '" placeholder="482">'
        + '<label>Note (optional): who confirmed it</label><textarea name="note" maxlength="500"></textarea>'
        + '<p class="asb-hint">This opens one nomination-transfer case and its four tasks. Nothing is sent to the doctor or the practice.</p>'
        + foot('Confirm and open the transfer case');
    }
    if (action === 'visa-transfer/decision:not_needed') {
      return head('No nomination transfer is needed')
        + '<input type="hidden" name="decision" value="not_needed">'
        + '<label>Why not (who confirmed it)</label><textarea name="note" maxlength="500"></textarea>'
        + '<p class="asb-hint">This closes the decision. No visa case is opened.</p>'
        + foot('Record: not needed');
    }
    if (action === 'visa-transfer/update') {
      return head('Correct the transfer details')
        + '<label>Current sponsoring employer</label><input type="text" name="current_sponsor" maxlength="200" value="' + esc(tc.current_sponsor_name || '') + '">'
        + '<label>Visa expiry date</label><input type="date" name="visa_expiry" value="' + esc(tc.current_visa_expiry || '') + '">'
        + '<label>Visa subclass</label><input type="text" name="visa_subclass" maxlength="40" value="' + esc(tc.current_visa_subclass || '') + '">'
        + '<label>New employer\'s sponsorship contact</label><input type="text" name="new_sponsor_contact" maxlength="200" value="' + esc(tc.new_sponsor_contact || '') + '">'
        + '<label>Reference number</label><input type="text" name="reference_number" maxlength="100" value="' + esc(tc.reference_number || '') + '">'
        + foot('Save');
    }
    if (action === 'visa-transfer/nomination-approved') {
      return head('The new nomination is approved')
        + '<label>Date approved</label><input type="date" name="approved_on">'
        + '<p class="asb-hint">This closes the tracking task. Nothing is sent to the doctor or the practice.</p>'
        + foot('Record the approval');
    }
    if (action === 'ahpra-outcome') {
      return head('Record the Ahpra outcome')
        + '<label>What did Ahpra decide?</label><select name="outcome"><option value="">Choose</option><option value="approved">Approved</option><option value="not_approved">Not approved (or more is needed)</option></select>'
        + '<label>Registration type now on the register</label><select name="registration_type">' + options(sup.registration_types, REG_TYPE, '') + '</select>'
        + '<label>Supervision level</label><select name="supervision_level">' + options(sup.supervision_levels, LEVEL, '') + '</select>'
        + '<label>Registration expiry (optional)</label><input type="date" name="registration_expiry">'
        + '<label>Visa</label><select name="visa_action"><option value="">Choose</option><option value="transfer_of_nomination">Transfer of nomination</option><option value="no_visa_action">No visa action</option></select>'
        + '<label>Note</label><textarea name="note" maxlength="500"></textarea>'
        + '<p class="asb-hint">Approved closes the supervision task. No visa case is opened and nothing is sent: you are shown a draft for the practice to send yourself.</p>'
        + foot('Record the outcome');
    }
    if (action === 'dpa-19ab') {
      return head('Complete the 19AB and DPA check')
        + '<label>Does section 19AB apply to this doctor?</label><select name="applies"><option value="">Choose</option><option value="yes">Yes: DPA locations only</option><option value="no">No: not restricted</option></select>'
        + '<label>19AB end date (optional)</label><input type="date" name="end_date">'
        + '<label>How you checked</label><textarea name="note" maxlength="500"></textarea>'
        + '<p class="asb-hint">File an exemption letter in the doctor\'s "Section 19AB exemption letter" document slot. "No" is the only answer that opens roles outside a DPA.</p>'
        + foot('Save the result');
    }
    if (action === 'n21-send') {
      var p = v.__preview || {};
      return head('Send the update to the doctor and the practice (N21)')
        + (p.gp ? '<label>To the doctor</label><pre>' + esc(p.gp.subject) + '\n\n' + esc(p.gp.body) + '</pre>' : '')
        + (p.practice ? '<label>To the practice' + (p.practice_email_on_file ? '' : ' (no contact email on file)') + '</label><pre>' + esc(p.practice.subject) + '\n\n' + esc(p.practice.text) + '</pre>' : '')
        + '<label class="asb-check"><input type="checkbox" name="to_gp" checked> Send to the doctor</label>'
        + '<label class="asb-check"><input type="checkbox" name="to_practice"' + (p.practice_email_on_file ? ' checked' : ' disabled') + '> Send to the practice</label>'
        + '<label class="asb-check"><input type="checkbox" name="confirm"> I have checked each outcome above with the doctor\'s records</label>'
        + foot('Send now');
    }
    return '';
  }

  // ── the card ──
  function viewHtml(v, openAction) {
    if (!v || !v.ok) return '';
    var m = v.moratorium || {};
    var can = v.can || {};
    var out = ['<div class="asb">'];
    var isB = v.applies === true;
    out.push('<h4>' + (isB ? 'Segment B: 19AB, supervision and visa' : '19AB and DPA check') + '</h4>');
    out.push('<p class="asb-sub">' + (isB
      ? 'This doctor is already in Australia on the restricted pathway. This pathway is not launched: the doctor sees a holding screen, and nothing here contacts them unless you send it.'
      : 'Whether section 19AB limits this doctor to Distribution Priority Area locations.') + '</p>');

    // 19AB
    if (isB) out.push('<h5>Section 19AB</h5>');
    out.push('<dl>'
      + row('Doctor\'s own answer', esc(m.doctor_answer === 'yes' ? 'It applies' : (m.doctor_answer === 'no' ? 'It does not apply' : (m.doctor_answer === 'unsure' ? 'Not sure' : 'Not answered'))))
      + row('Confirmed by staff', esc(m.staff_confirmed === 'yes' ? 'Yes, it applies' : (m.staff_confirmed === 'no' ? 'It does not apply' : 'Not yet')) + (m.confirmed_by ? ' <span style="font-weight:400">(' + esc(m.confirmed_by) + ')</span>' : ''))
      + row('End date', esc(day(m.end_date)))
      + row('Roles this doctor can be put forward for', m.dpa_restricted ? 'DPA locations only' : 'Any location')
      + row('Exemption letter', m.exemption_letter && m.exemption_letter.has ? 'On file' : 'Not on file')
      + '</dl>');
    out.push(taskList(m.check_tasks));
    if (can.complete_19ab) out.push('<div class="asb-actions">' + btn('dpa-19ab', m.staff_confirmed ? 'Change the 19AB result' : 'Complete the 19AB check', m.staff_confirmed ? '' : 'asb-primary') + '</div>');
    if (openAction === 'dpa-19ab') out.push(formHtml('dpa-19ab', v));

    if (isB) {
      var sup = v.supervision || {};
      var visa = v.visa || {};
      // Supervision
      out.push('<h5>Supervision</h5>');
      out.push('<dl>'
        + row('Registration on file', esc(REG_TYPE[sup.registration_type] || 'Not recorded') + (sup.registration_verified ? '' : ' <span style="font-weight:400">(not yet checked on the register)</span>'))
        + row('Supervision level', esc(LEVEL[sup.supervision_level] || ''))
        + row('Supervision paperwork needed', sup.supervised === true ? 'Yes' : (sup.supervised === false ? 'No' : 'Not known: record the registration first'))
        + row('Ahpra approval filed', sup.task ? (sup.task.approval_filed ? 'Yes' : 'Not yet') : '')
        + '</dl>');
      if (sup.supervised === null || sup.supervised === undefined) out.push('<p class="asb-warn">Nothing was created for supervision because the registration type is not on file. Complete the Ahpra register check on this profile; the tasks then appear by themselves.</p>');
      out.push(taskList((sup.task ? [sup.task] : []).concat(sup.pack_tasks || [])));
      if (sup.task && sup.task.open) out.push('<p class="asb-note">To finish the supervision task: file the Ahpra approval in the doctor\'s "Supervision plan" document slot, or record it below.</p>');
      if (can.record_ahpra_outcome) out.push('<div class="asb-actions">' + btn('ahpra-outcome', 'Record Ahpra outcome', sup.task && sup.task.open ? 'asb-primary' : '') + '</div>');
      if (openAction === 'ahpra-outcome') out.push(formHtml('ahpra-outcome', v));
      if (v.__draft) out.push('<p class="asb-note">Draft for the practice (not sent): copy it into an email if you want to send it.</p><pre>' + esc(v.__draft.subject) + '\n\n' + esc(v.__draft.body) + '</pre>');

      // Visa
      out.push('<h5>Visa</h5>');
      out.push('<dl>'
        + row('Right to work', esc(RIGHTS[visa.work_rights] || 'Not recorded'))
        + (visa.work_rights === 'visa' ? row('Tied to an employer', yesNo(visa.sponsor_tied)) : '')
        + row('Current sponsor', esc(visa.sponsor_name || ''))
        + row('Visa expiry', esc(day(visa.visa_expiry)))
        + row('Subclass', esc(visa.visa_subclass || ''))
        + '</dl>');
      if (visa.schema_missing) out.push('<p class="asb-warn">The nomination-transfer database changes have not been applied here, so a transfer case cannot be opened yet.</p>');
      var tc = visa.transfer_case;
      var d = visa.decision;
      if (visa.mode === 'none') out.push('<p class="asb-ok">' + esc(VISA_REASON[visa.reason] || 'No visa step.') + ' No visa case, task or page exists for this doctor.</p>');
      else if (!v.placement) out.push('<p class="asb-note">' + esc(VISA_REASON[visa.reason] || '') + ' The decision is raised when a placement is recorded.</p>');
      else if (tc) {
        out.push('<p class="asb-ok">Nomination-transfer case open: ' + esc(tc.stage_label || tc.stage) + (tc.nomination_approved_on ? ' on ' + esc(day(tc.nomination_approved_on)) : '') + '.</p>');
        out.push('<dl>' + row('From', esc(tc.current_sponsor_name || '')) + row('To', esc(tc.new_employer || '')) + row('Visa expiry', esc(day(tc.current_visa_expiry)))
          + row('Subclass', esc(tc.current_visa_subclass || '')) + row('New employer\'s contact', esc(tc.new_sponsor_contact || '')) + row('Reference', esc(tc.reference_number || ''))
          + row('Confirmed by', esc(tc.decided_by || '') + (tc.decided_at ? ' on ' + esc(day(tc.decided_at)) : '')) + '</dl>');
        out.push(taskList(visa.tasks));
      } else if (d && d.status === 'not_needed') {
        out.push('<p class="asb-ok">Decided: no nomination transfer is needed' + (d.decided_by ? ' (' + esc(d.decided_by) + ')' : '') + '.' + (d.note ? ' ' + esc(d.note) : '') + '</p>');
      } else {
        out.push('<p class="asb-warn"><strong>Decision needed.</strong> ' + esc((d && d.what_to_do) || VISA_REASON[visa.reason] || 'Confirm whether a nomination transfer is needed for the new employer.') + '</p>');
      }
      var vb = [];
      if (can.decide_visa && !tc) {
        vb.push(btn('visa-transfer/decision:confirm', 'Confirm: transfer needed', 'asb-primary'));
        if (!d || d.status !== 'not_needed') vb.push(btn('visa-transfer/decision:not_needed', 'Not needed'));
      }
      if (can.nomination_approved) vb.push(btn('visa-transfer/nomination-approved', 'Nomination approved', 'asb-primary'));
      if (can.update_transfer) vb.push(btn('visa-transfer/update', 'Correct the details'));
      if (vb.length) out.push('<div class="asb-actions">' + vb.join('') + '</div>');
      if (openAction && openAction.indexOf('visa-transfer/') === 0) out.push(formHtml(openAction, v));
      if (visa.drafts) {
        out.push('<p class="asb-note">Drafts for the transfer (not sent): copy into an email to send.</p>'
          + '<label style="font-size:12px;font-weight:600">To the practice: who is your migration agent?</label><pre>' + esc(visa.drafts.practice_request.subject) + '\n\n' + esc(visa.drafts.practice_request.body) + '</pre>'
          + '<label style="font-size:12px;font-weight:600">To the migration agent: the brief</label><pre>' + esc(visa.drafts.agent_brief.subject) + '\n\n' + esc(visa.drafts.agent_brief.body) + '</pre>');
      }

      // N21
      out.push('<h5>Tell the doctor and the practice</h5>');
      var pv = v.__preview;
      if (pv && !pv.ready) {
        out.push('<p class="asb-warn">This update cannot be sent yet. Not confirmed: ' + esc((pv.missing || []).map(function (k) { return MISSING[k] || k; }).join('; ')) + '.</p>');
      } else if (pv && pv.ready && openAction !== 'n21-send') {
        out.push('<p class="asb-note">Every outcome is confirmed. Nothing has been sent automatically.</p>');
      }
      if (v.__sent) out.push('<p class="asb-ok">' + esc(v.__sent) + '</p>');
      if (can.send_n21) out.push('<div class="asb-actions"><button type="button" data-asb-preview>' + (pv ? 'Refresh the preview' : 'Preview the update (N21)') + '</button>'
        + (pv && pv.ready ? btn('n21-send', 'Send the update', 'asb-primary') : '') + '</div>');
      if (openAction === 'n21-send') out.push(formHtml('n21-send', v));
    }
    out.push('<p class="asb-err" data-asb-top-err hidden></p></div>');
    return out.join('');
  }

  // Is there anything to show for this doctor? Segment B: always. Segments A
  // and C: only when a 19AB check task exists or staff may record the result
  // (segment C). A segment A doctor with no check task shows nothing.
  function hasContent(v) {
    if (!v || !v.ok) return false;
    if (v.applies === true) return true;
    var m = v.moratorium || {};
    return !!(v.can && v.can.complete_19ab) || !!(m.check_tasks && m.check_tasks.length);
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
    var state = { view: null, open: '', preview: null, draft: null, sent: '' };
    if (!el || !caseId || !root.fetch) return { reload: function () {} };
    ensureStyle(el.ownerDocument);

    function hide() { el.innerHTML = ''; el.hidden = true; }
    function draw() {
      if (!hasContent(state.view)) { hide(); return; }
      el.hidden = false;
      el.innerHTML = viewHtml(Object.assign({}, state.view, { __preview: state.preview, __draft: state.draft, __sent: state.sent }), state.open);
    }
    function showErr(scope, text) {
      var node = (scope || el).querySelector(scope ? '[data-asb-err]' : '[data-asb-top-err]');
      if (node) { node.textContent = text; node.hidden = false; }
    }
    function reload() {
      return root.fetch(API + '?case_id=' + encodeURIComponent(caseId), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) { state.view = data && data.ok ? data : null; draw(); return state.view; })
        .catch(function () { state.view = null; hide(); return null; });
    }
    function send(action, body, scope, button) {
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
          return data;
        });
      }).catch(function () {
        if (button) button.disabled = false;
        showErr(scope, 'Could not reach the server. Nothing was saved.');
        return null;
      });
    }
    function post(openKey, body, scope, button) {
      var action = String(openKey).split(':')[0];
      if (action === 'n21-send') {
        var to = [];
        if (body.to_gp) to.push('gp');
        if (body.to_practice) to.push('practice');
        body = { to: to, confirm: body.confirm === true };
      }
      return send(action, body, scope, button).then(function (data) {
        if (!data) return null;
        state.open = '';
        if (action === 'ahpra-outcome') state.draft = data.practice_draft || null;
        if (action === 'n21-send') {
          var s = data.sent || {};
          var told = [];
          if (s.gp) told.push('doctor: ' + (s.gp.sent ? 'sent' : (s.gp.reason === 'already_sent' ? 'already sent' : 'not sent')));
          if (s.practice) told.push('practice: ' + (s.practice.sent ? 'sent' : (s.practice.reason === 'already_sent' ? 'already sent' : (s.practice.reason === 'no_practice_email' ? 'no contact email on file' : 'not sent'))));
          state.sent = 'Update (N21): ' + told.join('; ') + '.';
        } else { state.preview = null; state.sent = ''; }
        if (data.view) { state.view = data.view; draw(); } else reload();
        if (typeof opts.onChange === 'function') { try { opts.onChange(data); } catch (e) { /* the card is already redrawn */ } }
        return data;
      });
    }
    function preview(button) {
      return send('n21-preview', {}, null, button).then(function (data) {
        if (!data) return null;
        state.preview = data; state.sent = '';
        draw();
        return data;
      });
    }

    el.addEventListener('click', function (event) {
      var t = event.target;
      if (!t || !t.closest) return;
      var open = t.closest('[data-asb-open]');
      if (open) { event.preventDefault(); state.open = open.getAttribute('data-asb-open'); draw(); var f = el.querySelector('form [name]:not([type=hidden])'); if (f && f.focus) { try { f.focus(); } catch (e) { /* not focusable */ } } return; }
      if (t.closest('[data-asb-cancel]')) { event.preventDefault(); state.open = ''; draw(); return; }
      var pv = t.closest('[data-asb-preview]');
      if (pv) { event.preventDefault(); preview(pv); }
    });
    el.addEventListener('submit', function (event) {
      var form = event.target && event.target.closest ? event.target.closest('[data-asb-form]') : null;
      if (!form) return;
      event.preventDefault();
      post(form.getAttribute('data-asb-form'), readForm(form), form, form.querySelector('button[type=submit]'));
    });

    reload();
    return { reload: reload };
  }

  root.GPAuSegmentB = { mount: mount, _viewHtml: viewHtml, _formHtml: formHtml, _hasContent: hasContent, _day: day };
})(typeof window !== 'undefined' ? window : globalThis);

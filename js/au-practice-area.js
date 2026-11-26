/* ============================================================================
 * au-practice-area.js: Australian GP build, WP-30.
 * The staff view of a practice's AREA: is it in a Distribution Priority Area
 * for GPs, and what is its Modified Monash level. Classic <script>, loaded by
 * pages/ceo-dashboard.html before ceo-ats-jobs.js and ceo-ats-practices.js.
 * Exposes window.GPAuArea. Draws nothing unless the server sent `au_area`
 * (which it does only with the Australian switch on AND a look-up provider
 * configured), so with either off this file is inert.
 *
 * The server is the rule (lib/au-practice-area.js, lib/au-workforce-locator.js).
 * This file only shows what it was sent and posts the staff actions:
 *   POST /api/ats/practice/area            recheck | set_address | manual | clear_manual
 *   POST /api/ats/job/area                 recheck | use_lookup | keep
 *   POST /api/ats/practices/area/check-all (CEO only)
 * ========================================================================== */
(function () {
  'use strict';

  var host = null;
  var checkAllRunning = false;
  var checkAllSummary = '';   // the last summary, so it survives the list being redrawn after a run

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pillClass(status) { return status === 'yes' ? 'green' : (status === 'no' ? 'blue' : 'amber'); }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return d.toISOString().slice(0, 10); }
  }
  function dpaWord(v) { return v === 'yes' ? 'In a DPA' : (v === 'no' ? 'Not in a DPA' : 'Not confirmed'); }
  function row(label, html) {
    return '<div style="display:flex;gap:12px;padding:7px 0;border-top:1px solid var(--ats-border);font-size:13px">' +
      '<div style="flex:0 0 112px;color:var(--ats-dim)">' + esc(label) + '</div><div style="flex:1;min-width:0">' + html + '</div></div>';
  }
  function banner(kind, html) {
    var c = kind === 'red' ? '220,38,38' : '224,168,60';
    return '<div class="au-area-banner au-area-banner-' + kind + '" style="margin-top:8px;padding:9px 11px;border-radius:8px;background:rgba(' + c + ',.09);border:1px solid rgba(' + c + ',.35);font-size:12.5px;line-height:1.5">' + html + '</div>';
  }
  function statusHtml(v) {
    return '<span class="ats-pill ' + pillClass(v.status) + '">' + esc(v.label || dpaWord(v.status)) + '</span>' +
      (v.consequence ? '<div class="au-area-consequence" style="font-size:12px;color:#e0a83c;margin-top:5px">' + esc(v.consequence) + '</div>' : '');
  }
  function yearText(year) {
    var y = year || {};
    return 'DPA: ' + (y.dpa ? esc(y.dpa) : 'the Department\'s current list') + ' · Modified Monash: ' + (y.mmm ? esc(y.mmm) + ' edition' : 'not stated');
  }

  /* ---------- practice list card ---------- */
  function chipHtml(c) {
    if (!c) return '';
    // Never checked: a quiet note, beside the pill the card already shows.
    var out;
    // (movedUnanswered: the address changed and the new one has no answer: that IS "not confirmed".)
    if (!c.checked && !c.movedUnanswered) out = '<span class="ats-pill muted">' + esc(c.label || 'Area not checked yet') + '</span>';
    else {
      out = '<span class="ats-pill ' + pillClass(c.status) + '" title="' + esc(c.consequence || '') + '">' + esc(c.label || '') + '</span>';
      if (c.mmmLabel) out += '<span class="ats-pill muted">' + esc(c.mmmLabel) + '</span>';
    }
    if (c.disagreement) out += '<span class="ats-pill red">Area: two answers</span>';
    if (c.disputes) out += '<span class="ats-pill red">Practice queried its area</span>';
    // FR-9 (M9-06, M9-08): anything else on the practice's area to-do list.
    var others = (c.needsPerson || []).filter(function (n) { return n && n.code !== 'two_answers' && n.code !== 'practice_query'; });
    if (others.length) out += '<span class="ats-pill red" title="' + esc(others.map(function (n) { return n.message; }).join(' ')) + '">Area: needs a person</span>';
    return out;
  }

  /* ---------- FR-9 (M9-06, M9-08): the list of practices whose area is waiting for a person ---------- */
  // Drawn at the top of the Practices tab from the cards the server already
  // sent (each card's au_area.needsPerson). It is the to-do list for the area
  // check: an item leaves it when the thing is settled (the address is
  // confirmed, a value is set by hand, a disagreement is settled, the
  // practice's note is marked as looked at). Each line opens the practice.
  function attentionListHtml(practices) {
    var rows = [];
    (practices || []).forEach(function (p) {
      var list = p && p.au_area && p.au_area.needsPerson;
      if (!list || !list.length) return;
      rows.push('<div class="au-area-todo" data-ats="open-practice" data-id="' + esc(p.id) + '" style="cursor:pointer;padding:8px 0;border-top:1px solid var(--ats-border)">' +
        '<b>' + esc(p.name || 'Practice') + '</b>' +
        list.map(function (n) { return '<div style="margin-top:3px">' + esc(n.message) + '</div>'; }).join('') + '</div>');
    });
    if (!rows.length) return '';
    return '<div id="auAreaTodo" style="margin:0 0 14px;padding:10px 12px;border:1px solid rgba(220,38,38,.35);background:rgba(220,38,38,.06);border-radius:10px;font-size:12.5px;line-height:1.5">' +
      '<div style="font-weight:600;margin-bottom:2px">Area: needs a person (' + rows.length + ')</div>' +
      '<div style="color:var(--ats-dim);margin-bottom:4px">These stay here until someone settles them. Press one to open the practice.</div>' +
      rows.join('') + '</div>';
  }

  /* ---------- practice detail card ---------- */
  var STATES = ['NSW', 'QLD', 'VIC', 'SA', 'WA', 'TAS', 'NT', 'ACT'];
  function manualFormHtml(v) {
    var m = v.manual || {};
    var dpa = m.dpa || '';
    function opt(val, label, cur) { return '<option value="' + val + '"' + (String(cur) === String(val) ? ' selected' : '') + '>' + label + '</option>'; }
    var mmmOpts = opt('', 'Leave to the automatic check', m.mmm == null ? '' : m.mmm);
    for (var i = 1; i <= 7; i++) mmmOpts += opt(i, 'MM ' + i, m.mmm == null ? '' : m.mmm);
    return '<div id="auAreaManualForm" style="display:none;margin-top:10px;padding:11px;border:1px solid var(--ats-border);border-radius:8px">' +
      '<div style="font-weight:600;font-size:13px;margin-bottom:6px">Set by hand</div>' +
      '<div style="font-size:12px;color:var(--ats-dim);margin-bottom:8px">Use this when you have confirmed the answer yourself (for example on the Health Workforce Locator website). Your name, the date and your reason are kept, and the automatic check will not replace it.</div>' +
      '<label style="font-size:12px">Distribution Priority Area for GPs</label>' +
      '<select id="auAreaManualDpa">' + opt('', 'Choose…', dpa) + opt('yes', 'Yes, in a DPA', dpa) + opt('no', 'No, not in a DPA', dpa) + opt('unknown', 'Not confirmed', dpa) + '</select>' +
      '<label style="font-size:12px;margin-top:8px;display:block">Modified Monash level</label>' +
      '<select id="auAreaManualMmm">' + mmmOpts + '</select>' +
      '<label style="font-size:12px;margin-top:8px;display:block">Reason</label>' +
      '<input type="text" id="auAreaManualReason" maxlength="500" placeholder="e.g. Checked on the locator website with the practice manager" />' +
      '<div style="margin-top:10px;display:flex;gap:8px"><button type="button" class="ats-btn ats-btn-primary ats-btn-sm" data-au-area="save-manual">Save</button>' +
      '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-au-area="toggle-manual">Cancel</button></div></div>';
  }
  function addressFormHtml() {
    var stateOpts = '<option value="">State…</option>' + STATES.map(function (s) { return '<option>' + s + '</option>'; }).join('');
    return '<div id="auAreaAddressForm" style="display:none;margin-top:10px;padding:11px;border:1px solid var(--ats-border);border-radius:8px">' +
      '<div style="font-weight:600;font-size:13px;margin-bottom:6px">Correct the address</div>' +
      '<div style="font-size:12px;color:var(--ats-dim);margin-bottom:8px">The exact street address is what gets checked. Saving replaces the address on file and runs the check again.</div>' +
      '<input type="text" id="auAreaAddrStreet" maxlength="300" placeholder="Street number and street, e.g. 12 Example Street" />' +
      '<div class="ats-form-row" style="margin-top:8px">' +
        '<div><input type="text" id="auAreaAddrSuburb" maxlength="120" placeholder="Suburb" /></div>' +
        '<div><select id="auAreaAddrState">' + stateOpts + '</select></div>' +
        '<div><input type="text" id="auAreaAddrPostcode" maxlength="4" inputmode="numeric" placeholder="Postcode" /></div>' +
      '</div>' +
      '<div style="margin-top:10px;display:flex;gap:8px"><button type="button" class="ats-btn ats-btn-primary ats-btn-sm" data-au-area="save-address">Save and check</button>' +
      '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-au-area="toggle-address">Cancel</button></div></div>';
  }
  function roleLineHtml(job, rv) {
    var out = '<div class="au-area-role" style="padding:8px 0;border-top:1px solid var(--ats-border);font-size:13px">' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b style="flex:1;min-width:140px">' + esc(job.title || 'Role') + '</b>' +
      '<span class="ats-pill ' + pillClass(rv.status) + '">' + esc(rv.label || '') + '</span>' +
      (rv.mmmLabel ? '<span class="ats-pill muted">' + esc(rv.mmmLabel) + '</span>' : '') + '</div>' +
      '<div style="font-size:12px;color:var(--ats-dim);margin-top:3px">' + esc(rv.basis || '') + (rv.site === 'own' ? ' · at a different address from the practice' : '') + '</div>';
    if (rv.consequence) out += '<div style="font-size:12px;color:#e0a83c;margin-top:3px">' + esc(rv.consequence) + '</div>';
    if (rv.disagreement) {
      out += banner('red', '<b>Two different answers.</b> ' + esc(rv.disagreement.message || '') + ' Nothing was changed. ' +
        '<div style="margin-top:7px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button type="button" class="ats-btn ats-btn-primary ats-btn-sm" data-au-area="role-use" data-job="' + esc(job.id) + '">Use the check\'s answer</button>' +
        (rv.manual ? '' : '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-au-area="role-keep" data-job="' + esc(job.id) + '">Keep this role\'s value…</button>') +
        '</div>');
    }
    return out + '</div>';
  }
  function practiceCardHtml(p, jobs) {
    var v = p && p.au_area;
    if (!v) return '';
    var roles = p.au_area_roles || {};
    var body = row('DPA for GPs', (v.checked || v.movedUnanswered) ? statusHtml(v)
      : '<span class="ats-pill muted">' + esc(v.label || 'Area not checked yet') + '</span>' +
        '<div style="font-size:12px;color:var(--ats-dim);margin-top:5px">' +
        (v.recordedBefore ? 'Recorded earlier on this practice: ' + esc(dpaWord(v.recordedBefore)) + '. ' : '') +
        'Its roles keep the labels they have until this address is checked. Press Re-check.</div>');
    body += row('Modified Monash', v.mmmLabel ? esc(v.mmmLabel) : '<span style="color:var(--ats-dim)">Not known</span>');
    body += row('Set by', esc(v.setByLabel || '') + (v.manual && v.manual.at ? ' on ' + esc(fmtDate(v.manual.at)) : '') +
      (v.manual && v.manual.reason ? '<div style="font-size:12px;color:var(--ats-dim);margin-top:3px">Reason: ' + esc(v.manual.reason) + '</div>' : ''));
    if (v.lookup) {
      body += row('Automatic check', esc(dpaWord(v.lookup.dpa)) + (v.lookup.mmm ? ' · MM ' + esc(v.lookup.mmm) : '') + ' · ' + esc(v.confidenceLabel || '') +
        (v.checkedAt ? ' · checked ' + esc(fmtDate(v.checkedAt)) : '') +
        (v.indicativeDpa && v.indicativeDpa !== 'unknown' ? '<div style="font-size:12px;color:var(--ats-dim);margin-top:3px">The centre of the suburb is ' + esc(v.indicativeDpa === 'yes' ? 'in a DPA' : 'not in a DPA') + '. That is a hint only: it is not used.</div>' : ''));
      body += row('Source', esc(v.source || '') + '<div style="font-size:12px;color:var(--ats-dim);margin-top:3px">' + yearText(v.year) + (v.catchment ? ' · GP catchment: ' + esc(v.catchment) : '') + '</div>');
    } else {
      body += row('Automatic check', '<span style="color:var(--ats-dim)">' + (v.lastAttempt ? 'No answer yet.' : 'Not run yet. Press Re-check.') + '</span>');
    }
    body += row('Address checked', (v.address ? esc(v.address) : '<span style="color:var(--ats-dim)">No address on file</span>') +
      (v.method ? '<div style="font-size:12px;color:var(--ats-dim);margin-top:3px">Point used: ' + esc(v.method) + '</div>' : ''));
    var notes = '';
    if (v.disagreement) {
      notes += banner('red', '<b>The automatic check and the value set by hand disagree.</b> ' + esc(v.disagreement.message || '') +
        '<div style="margin-top:4px">Automatic check: ' + esc(dpaWord(v.disagreement.lookup.dpa)) + (v.disagreement.lookup.mmm ? ', MM ' + esc(v.disagreement.lookup.mmm) : '') + ' (' + esc(fmtDate(v.disagreement.lookup.at)) + '). ' +
        'Set by hand: ' + esc(dpaWord(v.disagreement.manual.dpa)) + (v.disagreement.manual.mmm ? ', MM ' + esc(v.disagreement.manual.mmm) : '') + ' by ' + esc(v.disagreement.manual.by || 'staff') + ' (' + esc(fmtDate(v.disagreement.manual.at)) + ').</div>' +
        '<div style="margin-top:4px">The value set by hand is the one in use. To use the automatic answer instead, press "Remove the value set by hand".</div>');
    }
    (v.warnings || []).forEach(function (w) { notes += banner('amber', esc(w)); });
    (v.disputes || []).forEach(function (d) {
      notes += banner('red', '<b>The practice told us this looks wrong</b>' + (d.at ? ' (' + esc(fmtDate(d.at)) + ')' : '') + ': ' + esc(d.note || ''));
    });
    // FR-9 (M9-08): the note is an open item until a named person has looked.
    if ((v.disputes || []).length) {
      notes += '<div style="margin-top:8px"><button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-au-area="dispute-done">Mark as looked at</button>' +
        '<span style="font-size:12px;color:var(--ats-dim);margin-left:8px">Check the address (Re-check, Correct the address, or Set by hand) first. Your name is recorded.</span></div>';
    }
    // FR-9 (M9-06): what is still waiting for a person on this practice's area.
    (v.needsPerson || []).forEach(function (n) {
      if (n.code === 'not_confirmed') notes += banner('red', '<b>Needs a person.</b> ' + esc(n.message));
    });
    var actions = '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
      '<button type="button" class="ats-btn ats-btn-primary ats-btn-sm" data-au-area="recheck">Re-check</button>' +
      '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-au-area="toggle-manual">Set by hand…</button>' +
      (v.manual ? '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-au-area="clear-manual">Remove the value set by hand</button>' : '') +
      '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-au-area="toggle-address">Correct the address…</button>' +
      '</div>';
    var roleLines = (jobs || []).filter(function (j) { return j && roles[String(j.id)]; }).map(function (j) { return roleLineHtml(j, roles[String(j.id)]); }).join('');
    return '<div class="ats-card" id="auAreaCard" data-practice-id="' + esc(p.id) + '" style="margin-top:16px">' +
      '<div class="ats-card-title"><span class="ats-dot" style="background:var(--ats-amber, #e0a83c)"></span> Area: priority area and remoteness</div>' +
      '<p style="font-size:12px;color:var(--ats-dim);margin:0 0 6px">Looked up from the Government\'s Health Workforce Locator for this practice\'s address. It decides which doctors are shown this practice\'s roles: the practice is not asked.</p>' +
      body + notes + actions + manualFormHtml(v) + addressFormHtml() +
      (roleLines ? '<div style="margin-top:14px;font-weight:600;font-size:13px">Roles at this practice</div>' + roleLines : '') +
      '</div>';
  }

  /* ---------- job editor ---------- */
  function jobSectionHtml(area, jobId) {
    if (!area || !area.role) return '';
    var rv = area.role;
    var out = '<div id="auAreaJob" data-job-id="' + esc(jobId) + '" style="font-size:12.5px;line-height:1.6;margin-bottom:12px;padding:10px 12px;border-radius:8px;border:1px solid var(--ats-border)">' +
      '<div style="font-weight:600;margin-bottom:4px">Area labels on this role</div>' +
      '<div>' + statusHtml(rv) + '</div>' +
      '<div style="margin-top:6px"><b>Modified Monash:</b> ' + (rv.mmmLabel ? esc(rv.mmmLabel) : (rv.approxMmmLabel ? esc(rv.approxMmmLabel) + ' (not recorded on the role)' : 'not known')) + '</div>' +
      '<div><b>Where it came from:</b> ' + esc(rv.basis || '') + (rv.site === 'own' ? ' (this role is at a different address from its practice)' : '') +
      (rv.checkedAt ? ' · ' + esc(fmtDate(rv.checkedAt)) : '') + '</div>' +
      (rv.source ? '<div><b>Source:</b> ' + esc(rv.source) + ' · ' + yearText(rv.year) + '</div>' : '') +
      (rv.manual && rv.manual.reason ? '<div><b>Reason given:</b> ' + esc(rv.manual.reason) + '</div>' : '');
    if (rv.disagreement) {
      out += banner('red', '<b>Two different answers.</b> ' + esc(rv.disagreement.message || '') + ' Nothing was changed.' +
        '<div style="margin-top:7px;display:flex;gap:8px;flex-wrap:wrap">' +
        '<button type="button" class="ats-btn ats-btn-primary ats-btn-sm" data-au-area="job-use">Use the check\'s answer</button>' +
        (rv.manual ? '' : '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-au-area="job-keep">Keep this role\'s value…</button>') + '</div>');
    }
    out += '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
      '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-au-area="job-recheck">Re-check</button>' +
      '<span style="color:var(--ats-dim)">To set this role by hand, change "DPA status" or "Modified Monash" and save: your name and the reason below are recorded, and the automatic check will not replace it.</span></div>' +
      '<input type="text" id="atsJsAreaReason" maxlength="500" style="margin-top:8px" placeholder="Reason (needed when you change the DPA status or Modified Monash by hand)" />' +
      '<div style="color:var(--ats-dim);margin-top:4px">Choosing "Not recorded" hands this role back to the automatic check: no reason is needed.</div>' +
      '</div>';
    return out;
  }
  function collectJobReason(body) {
    var el = document.getElementById('atsJsAreaReason');
    if (!el || !body) return;
    var touched = ['dpa', 'dpa_status', 'mmm'].some(function (k) { return Object.prototype.hasOwnProperty.call(body, k); });
    var reason = String(el.value || '').trim();
    if (touched && reason) body.au_area_reason = reason;
  }

  /* ---------- job approval ---------- */
  function approvalHtml(area) {
    if (!area || !area.role) return '';
    var rv = area.role;
    return '<div id="auAreaApproval" style="margin:8px 0 10px;padding:9px 11px;border-radius:8px;border:1px solid var(--ats-border);font-size:12.5px">' +
      '<span class="ats-pill ' + pillClass(rv.status) + '">' + esc(rv.label || '') + '</span> ' +
      (rv.mmmLabel ? '<span class="ats-pill muted">' + esc(rv.mmmLabel) + '</span>' : '') +
      (rv.status === 'unknown' ? banner('amber', '<b>The priority-area status is not confirmed.</b> If you approve now, this role is hidden from every doctor who may only work in a priority area (that includes doctors moving to Australia from overseas) until it is confirmed. Open the practice and press Re-check, or set it by hand.') : '') +
      (rv.disagreement ? banner('red', '<b>Two different answers.</b> ' + esc(rv.disagreement.message || '') + ' Settle it in the job settings before approving.') : '') +
      '</div>';
  }
  function approvalConfirmText(area) {
    if (!area || !area.role) return '';
    if (area.role.status === 'unknown') return 'The priority-area status of this role is not confirmed, so no doctor who may only work in a priority area will see it (that includes doctors moving to Australia from overseas). Approve anyway?';
    if (area.role.disagreement) return 'This role has two different priority-area answers that nobody has settled. Approve anyway?';
    return '';
  }

  /* ---------- check all ---------- */
  function checkAllButtonHtml() {
    return '<div id="auAreaCheckAll" style="margin:0 0 14px;padding:10px 12px;border:1px solid var(--ats-border);border-radius:10px;font-size:12.5px">' +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><b>Priority areas and remoteness</b>' +
      '<span style="color:var(--ats-dim);flex:1;min-width:200px">Looks up every practice\'s address on the Health Workforce Locator. It never replaces a value set by hand, and it is safe to run again.</span>' +
      '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-au-area="check-all">Check all practices</button></div>' +
      '<div id="auAreaCheckAllStatus" style="margin-top:6px">' + checkAllSummary + '</div></div>';
  }
  function runCheckAll() {
    if (checkAllRunning || !host) return;
    if (!window.confirm('Check every practice\'s address on the Health Workforce Locator now? This can take a few minutes. Values set by hand are not replaced.')) return;
    checkAllRunning = true;
    var statusEl = document.getElementById('auAreaCheckAllStatus');
    var totals = { practices: 0, changed: 0, unchanged: 0, not_confident: 0, disagreed: 0, failed: 0, roles_updated: 0, roles_disagree: 0, roles_manual: 0, loose_roles: 0 };
    var attention = [];
    function say(html) { var live = document.getElementById('auAreaCheckAllStatus') || statusEl; if (live) live.innerHTML = html; }
    function finish(note) {
      checkAllRunning = false;
      // Kept in `checkAllSummary` as well: refreshing the list below redraws
      // this whole panel, and the summary must still be there afterwards.
      say(checkAllSummary = '<div class="au-area-summary"><b>' + esc(note) + '</b> ' + totals.practices + ' practices checked: ' +
        totals.changed + ' changed, ' + totals.unchanged + ' unchanged, ' + totals.not_confident + ' not confident, ' +
        totals.disagreed + ' disagreed with a value set by hand, ' + totals.failed + ' could not be checked. ' +
        'Roles: ' + totals.roles_updated + ' updated, ' + totals.roles_disagree + ' need a decision, ' + totals.roles_manual + ' set by hand and left alone' +
        (totals.loose_roles ? ', ' + totals.loose_roles + ' roles with no practice record checked' : '') + '.</div>' +
        (attention.length ? '<div style="margin-top:6px">Needs a look: ' + attention.slice(0, 40).map(esc).join('; ') + (attention.length > 40 ? '…' : '') + '</div>' : ''));
      if (host.refreshList) host.refreshList();
    }
    function step(cursor) {
      host.api('/api/ats/practices/area/check-all', { method: 'POST', body: { cursor: cursor, limit: 3 } }).then(function (d) {
        if (!d || !d.ok) { finish('Stopped: ' + ((d && d.message) || 'the check did not answer') + '.'); return; }
        (d.items || []).forEach(function (it) {
          if (it.kind === 'role') { totals.loose_roles++; return; }
          totals.practices++;
          if (Object.prototype.hasOwnProperty.call(totals, it.outcome)) totals[it.outcome]++; else totals.failed++;
          var r = it.roles || {};
          totals.roles_updated += r.applied || 0;
          totals.roles_disagree += r.disagreements || 0;
          totals.roles_manual += r.manual_kept || 0;
          if (it.outcome !== 'changed' && it.outcome !== 'unchanged' || r.disagreements) {
            attention.push(it.name + ' (' + (it.outcome === 'not_confident' ? 'not confident' : it.outcome === 'disagreed' ? 'disagrees with a value set by hand' : it.outcome === 'failed' ? 'could not be checked' : 'a role needs a decision') + ')');
          }
        });
        if (d.done) { finish('Finished.'); return; }
        say('Checking… ' + (d.phase === 'practices' ? d.position + ' of ' + d.total_practices + ' practices' : 'roles with no practice record'));
        window.setTimeout(function () { step(d.next_cursor); }, 1500);
      });
    }
    say('Checking…');
    step('');
  }

  /* ---------- actions ---------- */
  var OUTCOME_WORDS = {
    changed: 'Checked: the labels were updated.',
    unchanged: 'Checked: no change.',
    not_confident: 'Checked, but not confirmed: the exact address could not be matched.',
    disagreed: 'Checked: the automatic answer differs from the value set by hand. Nothing was changed.',
    failed: 'The check could not be completed. The earlier answer was kept.',
    set_by_hand: 'Saved. The value is now set by hand.',
    hand_value_removed: 'Removed. The automatic answer applies again.',
    applied: 'Updated.', in_step: 'Checked: no change.', disagreements: 'Checked: two different answers. Nothing was changed.',
    manual_kept: 'Checked: this role is set by hand and was left alone.', legacy_kept: 'Checked, but not confirmed: the recorded value was kept.',
    nothing_known: 'Nothing is known about this address yet.', kept: 'Kept, with your reason recorded.',
    dispute_done: 'Marked as looked at.'
  };
  function practiceId() { var c = document.getElementById('auAreaCard'); return c ? c.getAttribute('data-practice-id') : ''; }
  function jobId() { var c = document.getElementById('auAreaJob'); return c ? c.getAttribute('data-job-id') : ''; }
  function val(id) { var e = document.getElementById(id); return e ? String(e.value || '') : ''; }
  function toggle(id) { var e = document.getElementById(id); if (e) e.style.display = e.style.display === 'none' ? 'block' : 'none'; }
  function postPractice(body, btn) {
    if (btn) btn.disabled = true;
    host.api('/api/ats/practice/area', { method: 'POST', body: body }).then(function (d) {
      if (btn) btn.disabled = false;
      if (!d || !d.ok) { host.toast((d && d.message) || 'That could not be done.'); return; }
      host.toast(OUTCOME_WORDS[d.outcome] || 'Done.');
      if (host.refreshPractice) host.refreshPractice();
    });
  }
  function postJob(id, body, btn, after) {
    if (!id) return;
    if (btn) btn.disabled = true;
    body.id = id;
    host.api('/api/ats/job/area', { method: 'POST', body: body }).then(function (d) {
      if (btn) btn.disabled = false;
      if (!d || !d.ok) { host.toast((d && d.message) || 'That could not be done.'); return; }
      host.toast(OUTCOME_WORDS[d.outcome] || 'Done.');
      if (after) after(d);
    });
  }
  function askReason() {
    var reason = window.prompt('Why should this role keep its own value? (Your name and this reason are recorded.)', '');
    if (reason == null) return null;
    reason = String(reason).trim();
    if (reason.length < 5) { host.toast('Please give a reason (a few words is enough).'); return null; }
    return reason;
  }
  function onClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-au-area]') : null;
    if (!t || !host) return;
    var action = t.getAttribute('data-au-area');
    var pid = practiceId();
    if (action === 'check-all') { runCheckAll(); return; }
    if (action === 'toggle-manual') { toggle('auAreaManualForm'); return; }
    if (action === 'toggle-address') { toggle('auAreaAddressForm'); return; }
    if (action === 'recheck' && pid) { postPractice({ id: pid, action: 'recheck' }, t); return; }
    if (action === 'dispute-done' && pid) { postPractice({ id: pid, action: 'dispute_done' }, t); return; }
    if (action === 'clear-manual' && pid) {
      if (!window.confirm('Remove the value set by hand? The automatic answer will apply again.')) return;
      postPractice({ id: pid, action: 'clear_manual' }, t); return;
    }
    if (action === 'save-manual' && pid) {
      var dpa = val('auAreaManualDpa');
      if (!dpa) { host.toast('Choose yes, no or not confirmed.'); return; }
      postPractice({ id: pid, action: 'manual', dpa: dpa, mmm: val('auAreaManualMmm') || null, reason: val('auAreaManualReason') }, t); return;
    }
    if (action === 'save-address' && pid) {
      postPractice({ id: pid, action: 'set_address', address: val('auAreaAddrStreet'), suburb: val('auAreaAddrSuburb'), state: val('auAreaAddrState'), postcode: val('auAreaAddrPostcode') }, t); return;
    }
    if (action === 'role-use') { postJob(t.getAttribute('data-job'), { action: 'use_lookup' }, t, function () { if (host.refreshPractice) host.refreshPractice(); }); return; }
    if (action === 'role-keep') {
      var r1 = askReason(); if (r1 == null) return;
      postJob(t.getAttribute('data-job'), { action: 'keep', reason: r1 }, t, function () { if (host.refreshPractice) host.refreshPractice(); }); return;
    }
    if (action === 'job-recheck') { postJob(jobId(), { action: 'recheck' }, t, function () { if (host.reopenJob) host.reopenJob(); }); return; }
    if (action === 'job-use') { postJob(jobId(), { action: 'use_lookup' }, t, function () { if (host.reopenJob) host.reopenJob(); }); return; }
    if (action === 'job-keep') {
      var r2 = askReason(); if (r2 == null) return;
      postJob(jobId(), { action: 'keep', reason: r2 }, t, function () { if (host.reopenJob) host.reopenJob(); }); return;
    }
  }

  var bound = false;
  /** host: { api, toast, refreshPractice?, refreshList?, reopenJob? }. May be called by both tabs; the callbacks are merged. */
  function bind(h) {
    host = Object.assign(host || {}, h || {});
    if (bound || typeof document === 'undefined') return;
    bound = true;
    document.addEventListener('click', onClick);
  }

  window.GPAuArea = {
    chipHtml: chipHtml, attentionListHtml: attentionListHtml, practiceCardHtml: practiceCardHtml, jobSectionHtml: jobSectionHtml, collectJobReason: collectJobReason,
    approvalHtml: approvalHtml, approvalConfirmText: approvalConfirmText, checkAllButtonHtml: checkAllButtonHtml, bind: bind
  };
})();

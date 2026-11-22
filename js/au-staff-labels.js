/* Australian GP build, WP-26: the ONE place the two staff dashboards
 * (pages/admin.html and pages/ceo-dashboard.html) turn a stored key into words
 * for an Australian case: stage, pathway, task type, task owner, the matching
 * board's block codes, a due date, and the Australian journey rail.
 *
 * Pure: no request, no storage, no DOM. It only defines window.GPAuStaff.
 * Nothing here runs for an overseas doctor unless the page asks, and every
 * page asks only for a case that is Australian, so an overseas doctor's
 * screens are exactly what they were.
 *
 * The stage labels are the staff labels of lib/journey-ladders.js and the task
 * labels those of lib/au-prestart.js / lib/au-lifecycle.js; a test pins that
 * they agree (tests/au-wp26-staff-labels.test.js). Do not add a second map.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.GPAuStaff = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var AU_STAGES = [
    { key: 'placement', label: 'Placement', rail: 'Secure placement' },
    { key: 'prestart', label: 'Pre-start', rail: 'Pre-start' },
    { key: 'commenced', label: 'Commenced', rail: 'Commenced' },
    { key: 'guarantee', label: 'Guarantee period', rail: 'Guarantee' },
    { key: 'complete', label: 'Complete', rail: 'Complete' }
  ];
  var AU_ONLY = { placement: 1, prestart: 1, commenced: 1, guarantee: 1 };
  var OVERSEAS_STAGE_LABELS = {
    onboarding: 'Onboarding', myintealth: 'MyIntealth', amc: 'AMC', career: 'Secure Placement',
    ahpra: 'AHPRA', visa: 'Visa', pbs: 'PBS & Medicare', commencement: 'Commencement', complete: 'Complete'
  };
  var PATHWAY_LABELS = {
    au_vr: 'Australian VR', au_restricted: 'Australian restricted', au_non_vr: 'Non-VR', au_registrar: 'Registrar',
    overseas_esp: 'Overseas', overseas_pep: 'Overseas (PEP)'
  };
  var PATHWAY_SEGMENT = { au_vr: 'A', au_restricted: 'B', au_non_vr: 'C', au_registrar: 'C' };
  var TASK_LABELS = {
    ahpra_register_check: 'Ahpra register check',
    segment_review: 'Segment decision',
    dpa_19ab_check: '19AB and DPA check',
    reference_check: 'Reference checks',
    restraint_check: 'Restraint-of-trade check',
    start_date_tracking: 'Notice period and start date',
    indemnity_certificate: 'Indemnity certificate',
    provider_number_new_location: 'Medicare provider number (new location)',
    credentialing_pack: 'Practice credentialing pack',
    invoice_due: 'Placement-fee invoice',
    guarantee_checkin: 'Guarantee check-in',
    replacement_or_credit: 'Replacement or credit',
    doc_review: 'Document review',
    flagged_doc: 'Document review',
    practice_pack_child: 'Practice document',
    manual: 'Task',
    followup: 'Follow-up',
    visa_stage: 'Sponsorship transfer',
    migration_agent: 'Migration agent'
  };
  var OWNER_LABELS = { consultant: 'Consultant', rso: 'RSO', ceo: 'CEO' };
  // The matching board's block codes added by WP-08 (lib/role-eligibility.js
  // through lib/ai-candidate-job-match.js ROLE_REASON_TO_BLOCK).
  var BLOCK_LABELS = {
    role_dpa_unknown: 'Role’s DPA status not set',
    vr_required: 'Role needs a VR doctor',
    registrars_not_accepted: 'Role does not take registrars',
    supervised_not_accepted: 'Role cannot supervise',
    pathway_on_hold: 'Pathway not launched: put forward by hand',
    pathway_unreadable: 'Pathway could not be read'
  };
  var DOC_STATUS_LABELS = {
    pending: 'Not on file', uploaded: 'Waiting for review', under_review: 'Waiting for review',
    approved: 'Approved', rejected: 'Sent back to the doctor'
  };

  function str(v) { return v == null ? '' : String(v); }
  function esc(v) {
    return str(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function words(key) {
    var s = str(key).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  function isAuPathway(p) { return /^au_/.test(str(p)); }
  function isAuOnlyStage(s) { return AU_ONLY[str(s)] === 1; }
  // A case is Australian when its own row says so: the mirrored pathway, or a
  // stage only the Australian ladder has. Neither can exist with the switch off.
  function caseIsAu(c) {
    if (!c) return false;
    return isAuPathway(c.pathway) || isAuOnlyStage(c.stage);
  }
  function auStage(key) {
    for (var i = 0; i < AU_STAGES.length; i++) if (AU_STAGES[i].key === key) return AU_STAGES[i];
    return null;
  }
  // A label for ANY stage value. `au` true reads the Australian ladder first
  // (so 'complete' and a not-yet-moved case read correctly).
  function stageLabel(stage, au) {
    var k = str(stage).toLowerCase();
    if (!k) return '';
    var a = auStage(k);
    if (a && (au || AU_ONLY[k])) return a.label;
    return OVERSEAS_STAGE_LABELS[k] || (a ? a.label : words(k));
  }
  // The stage an Australian case is shown at: its own if on the ladder, else
  // the first rung (a case not yet moved off an overseas stage).
  function auStageOf(stage) { return auStage(str(stage).toLowerCase()) ? str(stage).toLowerCase() : 'placement'; }
  function auStageOptions() { return AU_STAGES.map(function (s) { return { value: s.key, label: s.label }; }); }

  function pathwayLabel(p) { return PATHWAY_LABELS[str(p)] || (p ? words(p) : 'Overseas'); }
  function pathwayBadge(p) {
    var seg = PATHWAY_SEGMENT[str(p)];
    return pathwayLabel(p) + (seg ? ' (segment ' + seg + ')' : '');
  }
  function taskTypeLabel(t) { return TASK_LABELS[str(t)] || words(t); }
  function blockLabel(code) { return BLOCK_LABELS[str(code)] || ''; }
  function docStatusLabel(s) { return DOC_STATUS_LABELS[str(s)] || words(s); }

  function taskMeta(task) {
    var m = task && task.metadata;
    if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { m = null; } }
    return (m && typeof m === 'object' && m.au === true) ? m : null;
  }
  // Who owns an Australian task, in words. '' for any other task.
  function ownerLabel(taskOrMeta) {
    var m = taskOrMeta && taskOrMeta.owner !== undefined && taskOrMeta.task_type === undefined ? taskOrMeta : taskMeta(taskOrMeta);
    if (!m || !m.owner) return '';
    var first = OWNER_LABELS[str(m.owner)] || words(m.owner);
    var then = m.owner_then ? (OWNER_LABELS[str(m.owner_then)] || words(m.owner_then)) : '';
    return then ? first + ', then ' + then : first;
  }
  function ownerShort(taskOrMeta) {
    var m = taskOrMeta && taskOrMeta.owner !== undefined && taskOrMeta.task_type === undefined ? taskOrMeta : taskMeta(taskOrMeta);
    return (m && m.owner) ? (OWNER_LABELS[str(m.owner)] || words(m.owner)) : '';
  }

  // ── dates ────────────────────────────────────────────────────────────────
  // A due date on an Australian task is a CALENDAR date ('2026-11-22'). Read
  // as an instant it is midnight UTC, which is already "in the past" on the
  // morning of the day itself, so the task showed as overdue on its due day.
  // Here it is compared day against day on the viewer's own calendar.
  function dayNumber(y, m, d) { return Math.round(Date.UTC(y, m - 1, d) / 86400000); }
  function dueDayNumber(value) {
    var s = str(value);
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m && (s.length === 10 || /T00:00:00(\.0+)?(Z|\+00:?00)?$/.test(s))) return dayNumber(+m[1], +m[2], +m[3]);
    var dt = new Date(s);
    if (isNaN(dt.getTime())) return null;
    return dayNumber(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  }
  // Whole days from the viewer's today to the due day: 0 on the day, negative after.
  function dueInDays(value, now) {
    var due = dueDayNumber(value);
    if (due == null) return null;
    var n = now instanceof Date ? now : new Date();
    return due - dayNumber(n.getFullYear(), n.getMonth() + 1, n.getDate());
  }
  function dueWords(value, now) {
    var d = dueInDays(value, now);
    if (d == null) return '';
    if (d < 0) return 'Overdue by ' + (-d) + (d === -1 ? ' day' : ' days');
    if (d === 0) return 'Due today';
    if (d === 1) return 'Due tomorrow';
    return 'Due in ' + d + ' days';
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // '22 Nov 2026'. A date-only value is printed as written; a timestamp in
  // the viewer's own zone (dashboard times are viewer-local).
  function formatDate(value) {
    var s = str(value);
    if (!s) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return (+m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1];
    var dt = new Date(s);
    if (isNaN(dt.getTime())) return s;
    return dt.getDate() + ' ' + MONTHS[dt.getMonth()] + ' ' + dt.getFullYear();
  }
  // Open first, then by due date (none last), then title: week 4, 8, 12 in order.
  function sortTasks(list) {
    return (list || []).slice().sort(function (a, b) {
      var ao = a.open === false ? 1 : 0, bo = b.open === false ? 1 : 0;
      if (ao !== bo) return ao - bo;
      var ad = dueDayNumber(a.due_date), bd = dueDayNumber(b.due_date);
      if (ad == null) ad = 9e9;
      if (bd == null) bd = 9e9;
      if (ad !== bd) return ad - bd;
      return str(a.title).localeCompare(str(b.title));
    });
  }

  // ── the Australian journey rail ──────────────────────────────────────────
  function railSteps(stage) {
    var cur = auStageOf(stage);
    var idx = 0;
    for (var i = 0; i < AU_STAGES.length; i++) if (AU_STAGES[i].key === cur) idx = i;
    return AU_STAGES.map(function (s, i) {
      return { key: s.key, label: s.rail, status: i < idx ? 'done' : (i === idx ? (cur === 'complete' ? 'done' : 'current') : 'pending') };
    });
  }
  // Same markup classes as the admin page's own rail (.journey-rail / .jr-*).
  function railHtml(stage, opts) {
    var steps = railSteps(stage);
    var practice = opts && opts.practiceName ? str(opts.practiceName) : '';
    var html = '<div class="journey-rail" data-au-rail="1">';
    steps.forEach(function (step, i) {
      var cls = step.status === 'done' ? 'done' : (step.status === 'current' ? 'current' : 'pending');
      var text = step.label + (step.key === 'placement' && practice && step.status === 'done' ? ' — ' + practice : '');
      var label = (step.status === 'done' ? '✓ ' : (step.status === 'current' ? '● ' : '')) + text;
      html += '<div class="jr-step"><div style="display:flex;flex-direction:column;align-items:center">' +
        '<div class="jr-pill ' + cls + '">' + esc(label) + '</div></div>' +
        (i < steps.length - 1 ? '<div class="jr-arrow ' + cls + '"></div>' : '') + '</div>';
    });
    return html + '</div>';
  }

  return {
    AU_STAGES: AU_STAGES, BLOCK_LABELS: BLOCK_LABELS, TASK_LABELS: TASK_LABELS, PATHWAY_LABELS: PATHWAY_LABELS,
    esc: esc, words: words,
    isAuPathway: isAuPathway, isAuOnlyStage: isAuOnlyStage, caseIsAu: caseIsAu,
    stageLabel: stageLabel, auStageOf: auStageOf, auStageOptions: auStageOptions,
    pathwayLabel: pathwayLabel, pathwayBadge: pathwayBadge,
    taskTypeLabel: taskTypeLabel, blockLabel: blockLabel, docStatusLabel: docStatusLabel,
    taskMeta: taskMeta, ownerLabel: ownerLabel, ownerShort: ownerShort,
    dueInDays: dueInDays, dueWords: dueWords, formatDate: formatDate, sortTasks: sortTasks,
    railSteps: railSteps, railHtml: railHtml
  };
});

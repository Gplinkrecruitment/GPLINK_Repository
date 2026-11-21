'use strict';
/**
 * WP-11 (Australian GP build): the staff tasks an Australian placement needs.
 * Pure, no I/O, no switch read. server.js creates what these builders return.
 *
 * Two groups (the "Proposed admin task checklist" of the review report):
 *
 *   Before placement (rows 2 to 4), raised at an ATS stage change:
 *     dpa_19ab_check    segments B and C, on shortlisted or applied
 *     reference_check   every Australian pathway, on submitted to practice
 *     restraint_check   every Australian pathway, at offer stage
 *
 *   Pre-start (rows 6 to 9), raised when a placement is recorded:
 *     start_date_tracking            consultant, then RSO
 *     indemnity_certificate          RSO
 *     provider_number_new_location   RSO
 *     credentialing_pack             RSO, only once the Ahpra register check
 *                                    (row 1) and the indemnity certificate
 *                                    (row 7) are done
 *
 * Every rule a person might want to change is in one of the tables below:
 * owner, due date, what "done" means. The task-type CHECK already allows all
 * of these (WP-06 migration), so nothing here needs a database change.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const TASK_TYPE = Object.freeze({
  DPA_19AB_CHECK: 'dpa_19ab_check',
  REFERENCE_CHECK: 'reference_check',
  RESTRAINT_CHECK: 'restraint_check',
  START_DATE_TRACKING: 'start_date_tracking',
  INDEMNITY_CERTIFICATE: 'indemnity_certificate',
  PROVIDER_NUMBER_NEW_LOCATION: 'provider_number_new_location',
  CREDENTIALING_PACK: 'credentialing_pack',
  // WP-06's decision task, reused for "decide the paperwork for this placement".
  SEGMENT_REVIEW: 'segment_review'
});

const OWNER = Object.freeze({ CONSULTANT: 'consultant', RSO: 'rso', CEO: 'ceo' });

// The document whose approval completes the indemnity task (WP-07's key).
const INDEMNITY_DOCUMENT_KEY = 'au_indemnity_certificate';

const SOURCE = Object.freeze({
  PLACEMENT: 'au_placement',
  PLACEMENT_REVIEW: 'au_placement_review',
  PATHWAY_HOLD: 'au_placement_pathway_hold',
  ATS_STAGE: 'au_ats_stage',
  MANUAL: 'va_manual'
});

/**
 * THE DUE-DATE RULES. One row per task type.
 *
 *   afterPlacementDays   due this many days after the placement was recorded
 *                        (used when no start date is known, and as a floor)
 *   beforeStartDays      when a start date is known: due this many days
 *                        before it
 *   afterTriggerDays     for a task raised by something other than the
 *                        placement: due this many days after it was raised
 *
 * A due date is never before `MIN_LEAD_DAYS` from the day the task is raised
 * (a placement recorded a week before the start date must not create tasks
 * that are already overdue).
 */
const MIN_LEAD_DAYS = 2;
const DUE_RULES = Object.freeze({
  start_date_tracking: Object.freeze({ afterPlacementDays: 3 }),
  indemnity_certificate: Object.freeze({ afterPlacementDays: 14, beforeStartDays: 14 }),
  provider_number_new_location: Object.freeze({ afterPlacementDays: 7, beforeStartDays: 21 }),
  credentialing_pack: Object.freeze({ afterTriggerDays: 7, beforeStartDays: 7 }),
  dpa_19ab_check: Object.freeze({ afterTriggerDays: 2 }),
  reference_check: Object.freeze({ afterTriggerDays: 5 }),
  restraint_check: Object.freeze({ afterTriggerDays: 3 }),
  segment_review: Object.freeze({ afterTriggerDays: 2 })
});

/**
 * WHO OWNS IT, WHAT TO DO, WHEN IT IS DONE. One row per task type. `label` is
 * what the manual task form shows; `whatToDo` is the plain line on the card;
 * `doneWhen` is the completion condition in words (the code that enforces it
 * is named beside it).
 */
const TASK_INFO = Object.freeze({
  dpa_19ab_check: Object.freeze({
    label: '19AB and DPA check (role location)',
    owner: OWNER.CONSULTANT, ownerThen: null, checklistRow: 2, manual: true,
    whatToDo: 'Check whether section 19AB applies to this doctor and whether the role\'s location is in a Distribution Priority Area. Record the outcome on the candidate\'s profile, then mark this complete.',
    doneWhen: 'Staff record the location eligibility and mark the task complete.'
  }),
  reference_check: Object.freeze({
    label: 'Reference checks (two referees)',
    owner: OWNER.CONSULTANT, ownerThen: null, checklistRow: 3, manual: true,
    whatToDo: 'Take two references for this doctor and file the completed checks in the doctor\'s References slot. The doctor gives two referees on their pre-start page in the app (they are in this case\'s pre-start details, each marked if they are at the doctor\'s current practice: ask the doctor before contacting those). If none are there yet, ask the doctor for two names.',
    doneWhen: 'The completed reference checks are filed in the doctor\'s References slot (this task then closes by itself), or staff mark it complete.'
  }),
  restraint_check: Object.freeze({
    label: 'Restraint-of-trade check (current contract)',
    owner: OWNER.CONSULTANT, ownerThen: null, checklistRow: 4, manual: true,
    whatToDo: 'Ask the doctor whether their current contract has a restraint clause (distance and duration) that affects this role. Record the outcome in the task note, then mark this complete.',
    doneWhen: 'Staff record the outcome and mark the task complete.'
  }),
  start_date_tracking: Object.freeze({
    label: 'Notice period and confirmed start date',
    owner: OWNER.CONSULTANT, ownerThen: OWNER.RSO, checklistRow: 6, manual: true,
    whatToDo: 'Confirm the doctor\'s notice period and agree the start date with the doctor and the practice. Save the confirmed start date on this task.',
    doneWhen: 'The confirmed start date is saved with "Save start date".'
  }),
  indemnity_certificate: Object.freeze({
    label: 'Collect indemnity certificate',
    owner: OWNER.RSO, ownerThen: null, checklistRow: 7, manual: true,
    whatToDo: 'Get the doctor\'s current medical indemnity certificate of currency (it must cover the new practice and the start date). The doctor uploads it in the app, or you file it for them.',
    doneWhen: 'The doctor\'s indemnity certificate is approved. This task then closes by itself.'
  }),
  provider_number_new_location: Object.freeze({
    label: 'Medicare provider number (new location)',
    owner: OWNER.RSO, ownerThen: null, checklistRow: 8, manual: true,
    whatToDo: 'Make sure the doctor has applied for a Medicare provider number for the new practice location, and record the number here once it is issued.',
    doneWhen: 'The provider number for the new location is recorded with "Record number".'
  }),
  credentialing_pack: Object.freeze({
    label: 'Practice credentialing pack',
    owner: OWNER.RSO, ownerThen: null, checklistRow: 9, manual: true,
    whatToDo: 'Put together the credentialing pack the practice needs (Ahpra registration, indemnity certificate, CV, right to work, Working with Children Check) and send it to the practice. Mark this complete once it is sent.',
    doneWhen: 'Staff mark the task complete once the pack has been sent to the practice.'
  })
});

// The task types the manual task form offers for an Australian case, in
// checklist order.
const MANUAL_TASK_TYPES = Object.freeze(Object.keys(TASK_INFO).filter(function (k) { return TASK_INFO[k].manual; }));
const PRESTART_TASK_TYPES = Object.freeze(['start_date_tracking', 'indemnity_certificate', 'provider_number_new_location', 'credentialing_pack']);
const EARLY_TASK_TYPES = Object.freeze(['dpa_19ab_check', 'reference_check', 'restraint_check']);

function isAuTaskType(type) { return Object.prototype.hasOwnProperty.call(TASK_INFO, String(type || '')); }

function nowMsOf(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  if (typeof now === 'string' && now) { const t = Date.parse(now); if (Number.isFinite(t)) return t; }
  return Date.now();
}
function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
function dayMs(value) {
  const s = typeof value === 'string' ? value.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) ? t : NaN;
}
/** A YYYY-MM-DD date, or '' when the value is not one. */
function cleanDay(value) {
  const t = dayMs(value);
  return Number.isFinite(t) ? isoDay(t) : '';
}
function cleanLine(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
}

/**
 * The due date for one task, as YYYY-MM-DD.
 *
 * Anchored on the confirmed start date when one is known (`startDate`), else
 * on the day the placement was recorded (`placedAt`), else on today.
 *
 * @param {string} taskType
 * @param {{ startDate?: string, placedAt?: string, now?: Date|string|number }} [input]
 * @returns {{ date: string, anchor: 'start_date'|'placement'|'raised', rule: object|null }}
 */
function dueDateFor(taskType, input) {
  const i = input && typeof input === 'object' ? input : {};
  const rule = DUE_RULES[taskType] || null;
  const nowMs = nowMsOf(i.now);
  const floorMs = nowMs + MIN_LEAD_DAYS * DAY_MS;
  if (!rule) return { date: isoDay(floorMs), anchor: 'raised', rule: null };
  const startMs = dayMs(i.startDate);
  if (Number.isFinite(startMs) && typeof rule.beforeStartDays === 'number') {
    return { date: isoDay(Math.max(floorMs, startMs - rule.beforeStartDays * DAY_MS)), anchor: 'start_date', rule };
  }
  if (typeof rule.afterPlacementDays === 'number') {
    const placedMs = Date.parse(i.placedAt || '');
    const base = Number.isFinite(placedMs) ? placedMs : nowMs;
    return { date: isoDay(Math.max(floorMs, base + rule.afterPlacementDays * DAY_MS)), anchor: 'placement', rule };
  }
  return { date: isoDay(Math.max(floorMs, nowMs + (rule.afterTriggerDays || MIN_LEAD_DAYS) * DAY_MS)), anchor: 'raised', rule };
}

function baseMetadata(type, i, due) {
  const info = TASK_INFO[type] || {};
  return {
    au: true,
    checklist_row: info.checklistRow || null,
    owner: info.owner || null,
    owner_then: info.ownerThen || null,
    what_to_do: info.whatToDo || '',
    done_when: info.doneWhen || '',
    due_auto: true,
    due_anchor: due.anchor,
    placement_key: i.placementKey || null,
    application_id: i.applicationId || null,
    placing_consultant: i.placingConsultant || null
  };
}

/**
 * One pre-start task (rows 6 to 9), as fields for _createRegTask.
 * @param {string} type  one of PRESTART_TASK_TYPES
 * @param {{ name?, practiceName?, placementKey, applicationId?, startDate?,
 *           placedAt?, placingConsultant?, stage?, now? }} input
 */
function buildPrestartTask(type, input) {
  if (PRESTART_TASK_TYPES.indexOf(type) === -1) return null;
  const i = input && typeof input === 'object' ? input : {};
  const info = TASK_INFO[type];
  const name = cleanLine(i.name, 160) || 'this doctor';
  const practice = cleanLine(i.practiceName, 160);
  const start = cleanDay(i.startDate);
  const due = dueDateFor(type, { startDate: start, placedAt: i.placedAt, now: i.now });
  const at = practice ? ' at ' + practice : '';
  const titles = {
    start_date_tracking: 'Confirm notice period and start date: ' + name + at,
    indemnity_certificate: 'Collect indemnity certificate: ' + name,
    provider_number_new_location: 'Medicare provider number for the new location: ' + name + at,
    credentialing_pack: 'Send the practice credentialing pack: ' + name + at
  };
  const metadata = baseMetadata(type, i, due);
  if (type === TASK_TYPE.START_DATE_TRACKING) {
    metadata.expected_start_date = start || null;
    metadata.confirmed_start_date = null;
  }
  if (type === TASK_TYPE.INDEMNITY_CERTIFICATE) metadata.document_key = INDEMNITY_DOCUMENT_KEY;
  if (type === TASK_TYPE.PROVIDER_NUMBER_NEW_LOCATION) {
    metadata.location_name = practice || null;
    metadata.practice_id = i.practiceId || null;
    metadata.provider_number = null;
  }
  return {
    task_type: type,
    status: 'open',
    title: titles[type],
    description: info.whatToDo
      + (type === TASK_TYPE.START_DATE_TRACKING
        ? (start ? ' Expected start date on the placement: ' + start + '.' : ' No start date is on the placement yet.')
        : '')
      + ' Done when: ' + info.doneWhen,
    priority: type === TASK_TYPE.START_DATE_TRACKING && !start ? 'high' : 'normal',
    due_date: due.date,
    source_trigger: SOURCE.PLACEMENT,
    related_stage: i.stage || 'prestart',
    metadata
  };
}

/**
 * One before-placement task (rows 2 to 4), as fields for _createRegTask.
 * @param {string} type  one of EARLY_TASK_TYPES
 * @param {{ name?, practiceName?, roleTitle?, roleLocation?, applicationId?,
 *           placingConsultant?, stage?, now? }} input
 */
function buildEarlyTask(type, input) {
  if (EARLY_TASK_TYPES.indexOf(type) === -1) return null;
  const i = input && typeof input === 'object' ? input : {};
  const info = TASK_INFO[type];
  const name = cleanLine(i.name, 160) || 'this doctor';
  const practice = cleanLine(i.practiceName, 160);
  const where = cleanLine(i.roleLocation, 120);
  const due = dueDateFor(type, { now: i.now });
  const role = (practice ? ' for ' + practice : '') + (where ? ' (' + where + ')' : '');
  const titles = {
    dpa_19ab_check: '19AB and DPA check: ' + name + role,
    reference_check: 'Reference checks (two referees): ' + name,
    restraint_check: 'Restraint-of-trade check: ' + name + (practice ? ' (offer from ' + practice + ')' : '')
  };
  return {
    task_type: type,
    status: 'open',
    title: titles[type],
    description: info.whatToDo + ' Done when: ' + info.doneWhen,
    priority: 'normal',
    due_date: due.date,
    source_trigger: SOURCE.ATS_STAGE,
    related_stage: i.stage || 'placement',
    metadata: Object.assign(baseMetadata(type, i, due), { trigger_stage: i.triggerStage || null })
  };
}

/**
 * Which before-placement tasks an ATS stage change raises for a doctor on an
 * Australian pathway. `segment` is 'A' | 'B' | 'C'. Anything else: none.
 */
function earlyTasksForStage(stage, segment) {
  const s = String(stage || '').trim().toLowerCase();
  const seg = String(segment || '').trim().toUpperCase();
  if (seg !== 'A' && seg !== 'B' && seg !== 'C') return [];
  if (s === 'shortlisted' || s === 'applied') return (seg === 'B' || seg === 'C') ? [TASK_TYPE.DPA_19AB_CHECK] : [];
  if (s === 'submitted') return [TASK_TYPE.REFERENCE_CHECK];
  if (s === 'offer') return [TASK_TYPE.RESTRAINT_CHECK];
  return [];
}

// reference_check is about the doctor, not one role: one per case. The other
// two are about one role: one per application.
function earlyTaskScope(type) { return type === TASK_TYPE.REFERENCE_CHECK ? 'case' : 'application'; }

/**
 * Is the credentialing pack's trigger met? (Checklist row 9: "Tasks 1 and 7
 * done".) Task 1 is the Ahpra register check, task 7 the indemnity certificate.
 * @param {{ ahpraVerified: boolean, ahpraCheckOpen: boolean, indemnityDone: boolean }} facts
 * @returns {{ met: boolean, waitingOn: string[] }}
 */
function credentialingPackTrigger(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const waitingOn = [];
  if (f.ahpraVerified !== true || f.ahpraCheckOpen === true) waitingOn.push('ahpra_register_check');
  if (f.indemnityDone !== true) waitingOn.push('indemnity_certificate');
  return { met: waitingOn.length === 0, waitingOn };
}

/**
 * The staff decision task for a placement whose paperwork is not known
 * (segment B with nothing on file, segment C). Reuses WP-06's `segment_review`
 * type. Closed when the hooks no longer ask for a review (a person recorded
 * the registration details) or staff set a confirmed pathway.
 */
function buildPlacementReviewTask(input) {
  const i = input && typeof input === 'object' ? input : {};
  const name = cleanLine(i.name, 160) || 'this doctor';
  const practice = cleanLine(i.practiceName, 160);
  const reasons = Array.isArray(i.reasons) ? i.reasons.slice() : [];
  const words = reasons.map(function (r) { return (i.reasonText && i.reasonText[r]) || String(r); });
  const due = dueDateFor(TASK_TYPE.SEGMENT_REVIEW, { now: i.now });
  return {
    task_type: TASK_TYPE.SEGMENT_REVIEW,
    status: 'open',
    title: 'Decide the registration paperwork for ' + name + '\'s placement' + (practice ? ' at ' + practice : '') + ' (segment ' + (i.segment || '?') + ')',
    description: 'A placement is recorded for a doctor in segment ' + (i.segment || '?') + ' (' + (i.pathway || 'unknown') + '), and the app cannot tell what the practice must lodge'
      + (words.length ? ': ' + words.join('; ') : '') + '. '
      + 'Nothing has been requested from the practice and no supervision paperwork has been started. '
      + 'Record the doctor\'s registration type, supervision level and right to work on their profile (the Ahpra register check), then decide what this placement needs. '
      + 'The pre-start tasks on this case have been created and are not affected.',
    priority: 'high',
    due_date: due.date,
    source_trigger: SOURCE.PLACEMENT_REVIEW,
    related_stage: i.stage || 'prestart',
    metadata: { au: true, pathway: i.pathway || null, segment: i.segment || null, reasons, placement_key: i.placementKey || null,
      what_to_do: 'Record the doctor\'s registration details on their profile, then decide what this placement needs from the practice.' }
  };
}

/**
 * The staff task raised when a placement is recorded and the doctor's pathway
 * could not be read. An ordinary `manual` task (a type every database allows).
 */
function buildPathwayHoldTask(input) {
  const i = input && typeof input === 'object' ? input : {};
  const name = cleanLine(i.name, 160) || 'this doctor';
  return {
    task_type: 'manual',
    status: 'open',
    title: 'Confirm pathway before pre-start / registration pack: ' + name,
    description: 'A placement was recorded for ' + name + ', but the app could not read which pathway the doctor is on at that moment. '
      + 'The placement itself is saved. The steps that differ by pathway have been held: the practice pack and registration messages for a doctor moving to Australia, '
      + 'or the pre-start tasks and messages for a doctor already working in Australia. Nothing has been sent to the doctor or the practice about next steps. '
      + 'Open the candidate\'s profile and check the pathway is recorded correctly. The held steps run by themselves the next time the pathway can be read '
      + '(when the doctor next opens the app, or overnight). Mark this complete once you have checked.',
    priority: 'high',
    due_date: isoDay(nowMsOf(i.now) + 1 * DAY_MS),
    source_trigger: SOURCE.PATHWAY_HOLD,
    // No stage on purpose: the placement cascade closes the open tasks filed
    // under 'career' when a placement lands, and must never close this one.
    related_stage: null,
    metadata: { au_placement_hold: true, application_id: i.applicationId || null, reason: i.reason || 'pathway_unreadable' }
  };
}

/**
 * What the manual task form offers, and how an Ops Queue card describes a task
 * of each type. Sent to the staff pages by GET /api/admin/au/task-types.
 */
function manualTaskOptions() {
  return MANUAL_TASK_TYPES.map(function (type) {
    const info = TASK_INFO[type];
    const rule = DUE_RULES[type] || {};
    return {
      task_type: type,
      label: info.label,
      owner: info.owner,
      owner_then: info.ownerThen,
      what_to_do: info.whatToDo,
      done_when: info.doneWhen,
      default_due_days: typeof rule.afterTriggerDays === 'number' ? rule.afterTriggerDays
        : (typeof rule.afterPlacementDays === 'number' ? rule.afterPlacementDays : MIN_LEAD_DAYS),
      default_stage: PRESTART_TASK_TYPES.indexOf(type) !== -1 ? 'prestart' : 'placement'
    };
  });
}

/**
 * Fields for a task of an Australian type created by hand in the manual task
 * form: the title the person typed, with this file's defaults for whatever
 * they left blank (due date, description, the "what to do" line).
 */
function buildManualAuTask(type, input) {
  if (!isAuTaskType(type) || !TASK_INFO[type].manual) return null;
  const i = input && typeof input === 'object' ? input : {};
  const info = TASK_INFO[type];
  const due = cleanDay(i.dueDate)
    ? { date: cleanDay(i.dueDate), anchor: 'manual', rule: null }
    : dueDateFor(type, { startDate: i.startDate, placedAt: i.placedAt, now: i.now });
  const metadata = baseMetadata(type, i, due);
  metadata.due_auto = !cleanDay(i.dueDate);
  metadata.created_by_hand = true;
  if (type === TASK_TYPE.INDEMNITY_CERTIFICATE) metadata.document_key = INDEMNITY_DOCUMENT_KEY;
  if (type === TASK_TYPE.START_DATE_TRACKING) { metadata.expected_start_date = cleanDay(i.startDate) || null; metadata.confirmed_start_date = null; }
  if (type === TASK_TYPE.PROVIDER_NUMBER_NEW_LOCATION) { metadata.location_name = cleanLine(i.practiceName, 160) || null; metadata.provider_number = null; }
  return {
    task_type: type,
    title: cleanLine(i.title, 300) || info.label,
    description: cleanLine(i.description, 2000) || (info.whatToDo + ' Done when: ' + info.doneWhen),
    priority: ['low', 'normal', 'high', 'urgent'].indexOf(i.priority) !== -1 ? i.priority : 'normal',
    due_date: due.date,
    related_stage: i.stage || (PRESTART_TASK_TYPES.indexOf(type) !== -1 ? 'prestart' : 'placement'),
    metadata
  };
}

// A provider number as Medicare prints it: six digits, one check character,
// one location character (for example 123456AB). Regulatory detail is not
// confirmed, so the check is deliberately loose: 6 to 8 digits followed by
// one or two letters or digits. Returns the cleaned value or ''.
function normaliseProviderNumber(value) {
  const s = String(value == null ? '' : value).replace(/[\s-]+/g, '').toUpperCase();
  return /^\d{6,8}[A-Z0-9]{1,2}$/.test(s) ? s : '';
}

/** Is every pre-start task for this placement finished? (`tasks`: rows with task_type, status.) */
function prestartCompleteFromTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const out = { complete: false, missing: [], open: [] };
  PRESTART_TASK_TYPES.forEach(function (type) {
    const mine = list.filter(function (t) { return t && t.task_type === type; });
    if (!mine.length) { out.missing.push(type); return; }
    if (!mine.every(function (t) { return t.status === 'completed'; })) out.open.push(type);
  });
  out.complete = out.missing.length === 0 && out.open.length === 0;
  return out;
}

module.exports = {
  TASK_TYPE, OWNER, SOURCE, INDEMNITY_DOCUMENT_KEY,
  DUE_RULES, MIN_LEAD_DAYS, TASK_INFO,
  MANUAL_TASK_TYPES, PRESTART_TASK_TYPES, EARLY_TASK_TYPES,
  isAuTaskType, cleanDay, dueDateFor,
  buildPrestartTask, buildEarlyTask, earlyTasksForStage, earlyTaskScope,
  credentialingPackTrigger,
  buildPlacementReviewTask, buildPathwayHoldTask,
  manualTaskOptions, buildManualAuTask,
  normaliseProviderNumber, prestartCompleteFromTasks
};

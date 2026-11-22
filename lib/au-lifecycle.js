'use strict';
/**
 * WP-13 (Australian GP build): commencement, invoice and guarantee tracking.
 * Pure, no I/O, no switch read. server.js creates what these builders return
 * and acts on what the two "what is due" functions say.
 *
 *   validateCommencement     the rules for "Confirm commenced"
 *   build*Task               the staff tasks (fields for _createRegTask)
 *   prestartRemindersDue     what the daily job owes a placement before the
 *                            doctor has started
 *   commencedRemindersDue    ... and after
 *
 * Commercial figures come only from lib/au-placement-fees.js (which copies
 * them from the agreement, with file and line). Nothing here states a fee, a
 * credit or a percentage of its own.
 *
 * Every rule a person might want to change is a constant in this file.
 */

const fees = require('./au-placement-fees.js');

const DAY_MS = 24 * 60 * 60 * 1000;

const SOURCE = Object.freeze({
  COMMENCEMENT: 'au_commencement',
  LIFECYCLE: 'au_lifecycle',
  EARLY_EXIT: 'au_early_exit'
});

const TASK_TYPE = Object.freeze({
  INVOICE_DUE: 'invoice_due',
  GUARANTEE_CHECKIN: 'guarantee_checkin',
  // Every other lifecycle task is an ordinary `manual` task (a type every
  // database allows), told apart by metadata.lifecycle_kind. `followup` is
  // deliberately not used: the reconcile-followups job hands those to an AI
  // check that closes or escalates them.
  MANUAL: 'manual'
});

const OWNER = Object.freeze({ CEO: 'ceo', CONSULTANT: 'consultant', RSO: 'rso' });

const KIND = Object.freeze({
  INVOICE: 'invoice_due',
  CHECKIN: 'guarantee_checkin',
  WEEK1: 'week1_checkin',
  START_REACHED: 'start_date_reached',
  PRESTART_AT_RISK: 'prestart_at_risk',
  NOTICE: 'notice_not_recorded',
  PROVIDER_PENDING: 'provider_number_pending',
  INDEMNITY: 'indemnity_expiring',
  GUARANTEE_ENDING: 'guarantee_ending',
  GUARANTEE_ENDED: 'guarantee_ended',
  UPLIFT: 'part_time_uplift',
  INVOICE_OVERDUE: 'invoice_overdue',
  REPLACEMENT_OR_CREDIT: 'replacement_or_credit'
});

// The tasks "Confirm commenced" creates, and "recorded in error" cancels.
const COMMENCEMENT_DERIVED_KINDS = Object.freeze([KIND.INVOICE, KIND.CHECKIN, KIND.WEEK1]);
// The tasks an early exit cancels (the invoice task is not one of them).
const EXIT_CANCELLED_KINDS = Object.freeze([KIND.CHECKIN, KIND.WEEK1, KIND.GUARANTEE_ENDING]);

// ── the timing rules of the daily job (GP Link's own practice) ───────────────
const WEEK1_DAYS = 7;                    // N18 and the first check-in
const PROVIDER_PENDING_DAYS = 14;        // provider number still open this long after the placement
const PRESTART_AT_RISK_DAYS = Object.freeze([14, 3]); // start date this close with pre-start unfinished
const NOTICE_DEFAULT_LEAD_DAYS = 28;     // no notice period on file: prompt this long before the start date
const NOTICE_MARGIN_DAYS = 7;            // notice period on file: prompt a week before the last day to give it
const INDEMNITY_WARN_DAYS = 30;          // certificate runs out within this many days
const GUARANTEE_ENDING_DAYS = 14;        // "guarantee ending in 14 days"
// A message is not sent long after its moment (the job was off, or a
// commencement was confirmed late): the staff task still exists.
const MESSAGE_LATE_DAYS = 14;
const REFERRAL_LATE_DAYS = 30;
// After this many days past the last milestone the job stops looking at a
// placement (month 12 plus a month).
const LIFECYCLE_HORIZON_DAYS = 400;

function clean(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
}
function drName(name) {
  const n = clean(name, 160);
  if (!n) return 'this doctor';
  return /^dr\b/i.test(n) ? n : 'Dr ' + n;
}
function atPractice(practiceName) {
  const p = clean(practiceName, 160);
  return p ? ' at ' + p : '';
}
/** "1 February 2027" for a YYYY-MM-DD day; the raw value for anything else. */
function longDay(value) {
  const day = fees.cleanDay(value);
  if (!day) return clean(value, 40);
  try {
    return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(day + 'T00:00:00Z'));
  } catch (e) { return day; }
}
/** "$21,000" for 21000. Used in STAFF text only. */
function formatAud(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  return '$' + n.toLocaleString('en-AU', { maximumFractionDigits: 2 });
}
// The zone used when a practice's own is not known (no practice on the
// placement, no state on the practice, a state that is not Australian).
// Sydney: the same last resort lib/au-timezone.js uses.
const FALLBACK_ZONE = 'Australia/Sydney';

/**
 * THE one way an instant becomes a calendar date in WP-13: the date it is in
 * an IANA zone at `nowMs` (YYYY-MM-DD). `Intl` does the zone and daylight-
 * saving work; nothing is added or subtracted by hand. FALLBACK_ZONE when the
 * zone is missing or unusable.
 */
function localDay(nowMs, zone) {
  const ms = Number.isFinite(nowMs) ? nowMs : Date.now();
  const fmt = function (tz) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  };
  try { return fmt(zone || FALLBACK_ZONE); } catch (e) { return fmt(FALLBACK_ZONE); }
}

const TIER_LABEL = Object.freeze({ full_time: 'full-time', part_time: 'part-time' });
const FEE_UNKNOWN_TEXT = Object.freeze({
  sessions_unknown: 'the number of sessions a week is not on file as a number, so full-time or part-time cannot be told',
  agreement_variant_unknown: 'which agreement the practice signed is not on file',
  practice_not_on_file: 'the placement is not linked to a practice record, so the agreement it signed cannot be read',
  agreement_not_signed: 'the practice has no signed agreement on file',
  no_esignature_on_file: 'the practice is marked as signed but there is no e-signature on file (a paper agreement uploaded by hand): its terms are not held in the app',
  signed_before_2026_agreement: 'the practice signed before the 2026 agreement went live, so it is on an earlier agreement whose terms are not held in the app',
  agreement_variant_unrecognised: 'the agreement version recorded for the practice is not one the app knows',
  not_australian_basis: 'this doctor is not recorded as based in Australia, so the Australian-based fee does not apply'
});

// ── "Confirm commenced": the rules ───────────────────────────────────────────

const OVERRIDE_REASON_MIN = 10;

/**
 * @param {{ commencedAt, today, placedDay?, sessions?, sessionsOnFile?, sessionsUnknown?: boolean,
 *           prestartComplete: boolean, override?: boolean, overrideReason?: string }} input
 *   today      the calendar day it is at the practice (localDay)
 *   placedDay  the day the placement was recorded, on the same clock
 * @returns {{ ok: boolean, code?: string, message?: string, commencedAt?: string,
 *             sessions?: number|null, overridden?: boolean, overrideReason?: string }}
 */
function validateCommencement(input) {
  const i = input && typeof input === 'object' ? input : {};
  const day = fees.cleanDay(i.commencedAt);
  if (!day) return { ok: false, code: 'invalid_date', message: 'Please give the day the doctor started as a date (YYYY-MM-DD).' };
  const today = fees.cleanDay(i.today);
  if (today && day > today) {
    return { ok: false, code: 'date_in_future', message: 'That date is in the future at the practice (today there is ' + longDay(today) + '). Confirm commencement on or after the day the doctor actually starts.' };
  }
  const placed = fees.cleanDay(i.placedDay);
  if (placed && day < placed) {
    return { ok: false, code: 'date_before_placement', message: 'That date is before the placement was recorded (' + longDay(placed) + '). Check the date.' };
  }
  let sessions = null;
  const given = i.sessions !== undefined && i.sessions !== null && String(i.sessions).trim() !== '';
  if (given) {
    sessions = fees.cleanSessions(i.sessions);
    if (sessions === null) return { ok: false, code: 'invalid_sessions', message: 'Sessions a week must be a number between 0.5 and ' + fees.MAX_SESSIONS + ' (for example 8 or 7.5).' };
  } else if (fees.cleanSessions(i.sessionsOnFile) !== null) {
    sessions = fees.cleanSessions(i.sessionsOnFile);
  } else if (i.sessionsUnknown !== true) {
    return { ok: false, code: 'sessions_required', message: 'How many sessions a week is the doctor working? Enter the number, or tick "not known yet" (the invoice task will then ask for it before anything is invoiced).' };
  }
  let overridden = false;
  let overrideReason = '';
  if (i.prestartComplete !== true) {
    overrideReason = clean(i.overrideReason, 500);
    if (i.override !== true || overrideReason.length < OVERRIDE_REASON_MIN) {
      return { ok: false, code: 'prestart_incomplete', message: 'The pre-start checklist is not finished. Finish it first, or confirm anyway with a reason (at least ' + OVERRIDE_REASON_MIN + ' characters) saying why the doctor started without it.' };
    }
    overridden = true;
  }
  return { ok: true, commencedAt: day, sessions, overridden, overrideReason };
}

// ── tasks ────────────────────────────────────────────────────────────────────

function meta(kind, i, extra) {
  return Object.assign({
    au: true,
    lifecycle_kind: kind,
    placement_key: i.placementKey || null,
    application_id: i.applicationId || null,
    placing_consultant: i.placingConsultant || null
  }, extra || {});
}

/**
 * Checklist row 13: ONE task for the CEO to raise the placement-fee invoice BY
 * HAND. Nothing is issued by code and nothing talks to Xero.
 * @param {{ name, practiceName, placementKey, applicationId?, commencedAt, fee, variantLabel?, placingConsultant?, stage? }} input
 *   fee: the result of fees.placementFeeFor
 */
function buildInvoiceTask(input) {
  const i = input && typeof input === 'object' ? input : {};
  const fee = i.fee && typeof i.fee === 'object' ? i.fee : { known: false, reason: fees.UNKNOWN_REASON.VARIANT };
  const who = drName(i.name) + atPractice(i.practiceName);
  const started = longDay(i.commencedAt);
  const terms = 'Payment terms in the agreement: within seven (7) days of the date of invoice.';
  const how = 'Raise the invoice by hand in your accounting system (the app sends nothing). Then record the date and invoice number with "Mark invoice sent", and "Mark invoice paid" when it is paid.';
  let title;
  let description;
  let whatToDo;
  if (fee.known) {
    title = 'Raise placement-fee invoice: ' + who;
    description = drName(i.name) + ' commenced' + atPractice(i.practiceName) + ' on ' + started + '. '
      + 'Fee from the agreement the practice signed (' + clean(i.variantLabel || fee.variant, 80) + '): ' + TIER_LABEL[fee.tier] + ' placement of a GP based in Australia, '
      + formatAud(fee.amountExGst) + ' exclusive of GST, invoiced in full on commencement. '
      + 'Sessions a week on file: ' + fee.sessionsPerWeek + ' (full-time is ' + fees.FULL_TIME_MIN_SESSIONS + ' or more). '
      + terms + ' ' + how;
    whatToDo = 'Raise the invoice for ' + formatAud(fee.amountExGst) + ' ex GST (' + TIER_LABEL[fee.tier] + ', ' + clean(i.variantLabel || fee.variant, 80) + ') by hand, then mark it sent.';
  } else {
    const why = FEE_UNKNOWN_TEXT[fee.reason] || 'the fee could not be read from the agreement for this placement';
    title = 'Confirm sessions/agreement before invoicing: ' + who;
    description = drName(i.name) + ' commenced' + atPractice(i.practiceName) + ' on ' + started + ', so the placement fee is now due to be invoiced. '
      + 'Confirm sessions/agreement before invoicing: ' + why + '. '
      + 'No fee amount is shown here because the app will not guess one. '
      + (fee.tier ? 'On the sessions on file (' + fee.sessionsPerWeek + ' a week) this is a ' + TIER_LABEL[fee.tier] + ' placement. ' : '')
      + 'Once you have confirmed it, ' + (fee.reason === fees.UNKNOWN_REASON.SESSIONS ? 'record the sessions a week with "Correct commencement details" so the fee is worked out, then ' : '')
      + 'raise the invoice by hand. ' + terms + ' ' + how;
    whatToDo = 'Confirm sessions/agreement before invoicing (' + why + '), then raise the invoice by hand and mark it sent.';
  }
  return {
    task_type: TASK_TYPE.INVOICE_DUE,
    status: 'open',
    title,
    description,
    priority: 'high',
    due_date: fees.cleanDay(i.commencedAt) || null,
    source_trigger: SOURCE.COMMENCEMENT,
    related_stage: i.stage || 'commenced',
    metadata: meta(KIND.INVOICE, i, {
      checklist_row: 13, owner: OWNER.CEO, what_to_do: whatToDo,
      done_when: 'The invoice is recorded as sent with "Mark invoice sent" (this task then closes by itself).',
      commenced_at: fees.cleanDay(i.commencedAt) || null,
      fee_known: fee.known === true, fee_unknown_reason: fee.known ? null : (fee.reason || null),
      fee_tier: fee.tier || null, fee_amount_ex_gst: fee.known ? fee.amountExGst : null,
      agreement_variant: fee.variant || null, candidate_basis: fee.basis || null,
      sessions_per_week: fee.sessionsPerWeek === undefined ? null : fee.sessionsPerWeek
    })
  };
}

/**
 * Checklist row 14: one guarantee check-in (week 4, 8 or 12), for the placing
 * consultant.
 */
function buildCheckinTask(week, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (fees.CHECKIN_WEEKS.indexOf(week) === -1) return null;
  const date = fees.addDays(i.commencedAt, week * 7);
  const who = drName(i.name) + atPractice(i.practiceName);
  const last = week === fees.GUARANTEE_WEEKS;
  return {
    task_type: TASK_TYPE.GUARANTEE_CHECKIN,
    status: 'open',
    title: 'Week ' + week + ' check-in: ' + who,
    description: 'Check in with ' + drName(i.name) + ' and with the practice ' + week + ' weeks after commencement (' + longDay(i.commencedAt) + '). '
      + 'Ask each how it is going and whether anything needs sorting out, and write what you heard in the task note. '
      + (last ? 'This is the last check-in: the 12-week guarantee period ends on ' + longDay(date) + '. ' : '')
      + 'If the doctor is leaving or has left, record it with "Doctor left during the guarantee" straight away. Done when: you have logged the check-in and marked this complete.',
    priority: 'normal',
    due_date: date || null,
    source_trigger: SOURCE.COMMENCEMENT,
    related_stage: i.stage || 'guarantee',
    metadata: meta(KIND.CHECKIN, i, {
      checklist_row: 14, owner: OWNER.CONSULTANT, week, mark: 'w' + week,
      what_to_do: 'Speak to the doctor and the practice, note how it is going, then mark this complete.',
      done_when: 'The check-in is logged in the task note and the task is marked complete.',
      commenced_at: fees.cleanDay(i.commencedAt) || null
    })
  };
}

/** N18's staff side: the week-1 check-in, for the placing consultant. */
function buildWeek1Task(input) {
  const i = input && typeof input === 'object' ? input : {};
  const date = fees.addDays(i.commencedAt, WEEK1_DAYS);
  const who = drName(i.name) + atPractice(i.practiceName);
  return {
    task_type: TASK_TYPE.MANUAL,
    status: 'open',
    title: 'First-week check-in: ' + who,
    description: drName(i.name) + ' commenced' + atPractice(i.practiceName) + ' on ' + longDay(i.commencedAt) + '. '
      + 'One week in, check with the doctor and the practice that the first week went well (rooms, systems, patient bookings, provider number working). '
      + 'The app emails both a short check-in on that day. Note what you heard and mark this complete.',
    priority: 'normal',
    due_date: date || null,
    source_trigger: SOURCE.COMMENCEMENT,
    related_stage: i.stage || 'commenced',
    metadata: meta(KIND.WEEK1, i, {
      owner: OWNER.CONSULTANT, mark: 'w1',
      what_to_do: 'Check in with the doctor and the practice after the first week, then mark this complete.',
      done_when: 'The check-in is logged in the task note and the task is marked complete.',
      commenced_at: fees.cleanDay(i.commencedAt) || null
    })
  };
}

/**
 * A reminder task from the daily job. `kind` is one of the lifecycle kinds
 * below; `mark` distinguishes repeats (a month, a date).
 */
function buildLifecycleTask(kind, input) {
  const i = input && typeof input === 'object' ? input : {};
  const who = drName(i.name) + atPractice(i.practiceName);
  const due = fees.cleanDay(i.dueDate) || fees.cleanDay(i.today) || null;
  const base = function (owner, title, description, whatToDo, doneWhen, priority, extra) {
    return {
      task_type: TASK_TYPE.MANUAL, status: 'open', title, description, priority: priority || 'normal', due_date: due,
      source_trigger: SOURCE.LIFECYCLE, related_stage: i.stage || null,
      metadata: meta(kind, i, Object.assign({ owner, mark: i.mark || null, what_to_do: whatToDo, done_when: doneWhen }, extra || {}))
    };
  };
  if (kind === KIND.START_REACHED) {
    return base(OWNER.CONSULTANT, 'Confirm commenced: ' + who,
      'The start date on this placement (' + longDay(i.startDate) + ') has been reached and commencement has not been confirmed. '
      + 'Check with the practice that ' + drName(i.name) + ' has started, then use "Confirm commenced" on the candidate with the actual date. '
      + 'That is what raises the invoice task and the guarantee check-ins. If the start has moved, save the new start date instead.',
      'Confirm the doctor has started, then use "Confirm commenced" with the actual date.',
      'Commencement is confirmed (this task then closes by itself), or a new start date is saved.', 'high',
      { checklist_row: 12, start_date: fees.cleanDay(i.startDate) || null });
  }
  if (kind === KIND.PRESTART_AT_RISK) {
    const open = (Array.isArray(i.outstanding) ? i.outstanding : []).map(function (x) { return clean(x, 80); }).filter(Boolean);
    return base(OWNER.RSO, 'Start date in ' + i.daysToStart + ' day' + (i.daysToStart === 1 ? '' : 's') + ', pre-start not finished: ' + who,
      drName(i.name) + ' is due to start on ' + longDay(i.startDate) + ' and the pre-start checklist is not finished'
      + (open.length ? ': ' + open.join(', ') : '') + '. Chase what is outstanding, or agree a new start date with the doctor and the practice.',
      'Finish the outstanding pre-start items, or move the start date.',
      'The pre-start checklist is complete, or a new start date is saved. Mark this complete then.',
      i.daysToStart <= 3 ? 'urgent' : 'high', { start_date: fees.cleanDay(i.startDate) || null, days_to_start: i.daysToStart });
  }
  if (kind === KIND.NOTICE) {
    return base(OWNER.CONSULTANT, 'Has the doctor given notice? ' + who,
      drName(i.name) + ' is due to start on ' + longDay(i.startDate) + ' and has not recorded giving notice at their current practice'
      + (i.noticeWeeks ? ' (notice period on file: ' + i.noticeWeeks + ' week' + (i.noticeWeeks === 1 ? '' : 's') + ')' : ' (no notice period is on file)') + '. '
      + 'Ask the doctor. Never contact the doctor\'s current practice without asking the doctor first. If the start date needs to move, save the new date.',
      'Ask the doctor whether notice has been given and when; move the start date if it no longer works.',
      'The doctor has recorded their notice date in the app, or you have noted the answer. Mark this complete then.', 'high',
      { start_date: fees.cleanDay(i.startDate) || null });
  }
  if (kind === KIND.INDEMNITY) {
    const before = i.beforeStart === true;
    return base(OWNER.RSO, 'Indemnity certificate expires ' + longDay(i.expiry) + ': ' + who,
      'The indemnity expiry date on file for ' + drName(i.name) + ' is ' + longDay(i.expiry)
      + (before ? ', which is before the start date (' + longDay(i.startDate) + ')' : ', which is within ' + INDEMNITY_WARN_DAYS + ' days') + '. '
      + 'Ask the doctor for the renewed certificate of currency and file it in their Indemnity slot. The practice needs a current one.',
      'Get the renewed indemnity certificate from the doctor and file it.',
      'A certificate covering the new period is on file and the expiry date is updated. Mark this complete then.',
      before ? 'high' : 'normal', { indemnity_expiry: fees.cleanDay(i.expiry) || null });
  }
  if (kind === KIND.GUARANTEE_ENDING) {
    return base(OWNER.CONSULTANT, 'Guarantee period ends ' + longDay(i.guaranteeEndsAt) + ': ' + who,
      'The 12-week guarantee period for ' + drName(i.name) + atPractice(i.practiceName) + ' ends on ' + longDay(i.guaranteeEndsAt) + '. '
      + 'Make sure the week-12 check-in happens with both the doctor and the practice before then, and that anything the practice has raised is recorded. '
      + (i.invoiceState ? 'Invoice: ' + clean(i.invoiceState, 120) + '. ' : '')
      + 'The case closes by itself the day after the period ends.',
      'Do the final check-in with the doctor and the practice before the guarantee period ends.',
      'The week-12 check-in is logged. Mark this complete then.', 'normal',
      { guarantee_ends_at: fees.cleanDay(i.guaranteeEndsAt) || null });
  }
  if (kind === KIND.UPLIFT) {
    // Commercial issue 6. States NO amount: a person checks, then decides.
    return base(OWNER.CEO, 'Part-time check at month ' + i.month + ': has ' + drName(i.name) + ' gone full-time?',
      drName(i.name) + ' was placed' + atPractice(i.practiceName) + ' as a part-time placement (fewer than ' + fees.FULL_TIME_MIN_SESSIONS + ' sessions a week) and commenced on ' + longDay(i.commencedAt) + '. '
      + 'It is now ' + i.month + ' months since commencement. Ask the practice how many sessions a week the doctor is averaging. '
      + 'Clause 6.12 of the agreement applies if a part-time placement increases to full-time hours within twelve (12) months of commencement: read the clause before raising anything with the practice. '
      + (i.month >= fees.UPLIFT_WINDOW_MONTHS ? 'This is the last reminder: the twelve months end now.' : 'There is one more reminder at month ' + fees.UPLIFT_WINDOW_MONTHS + '.'),
      'Ask the practice how many sessions a week the doctor now works, and read clause 6.12 if it is ' + fees.FULL_TIME_MIN_SESSIONS + ' or more.',
      'You have checked and noted the answer. Mark this complete then.', 'normal',
      { month: i.month, commenced_at: fees.cleanDay(i.commencedAt) || null });
  }
  if (kind === KIND.INVOICE_OVERDUE) {
    return base(OWNER.CEO, 'Invoice past its 7-day terms: ' + who,
      'The placement-fee invoice' + (i.invoiceReference ? ' ' + clean(i.invoiceReference, 60) : '') + ' was recorded as sent on ' + longDay(i.invoiceSentAt)
      + ' and is not recorded as paid. The agreement\'s terms are seven (7) days from the date of invoice, so it was due by ' + longDay(i.paymentDueBy) + '. '
      + 'Chase the practice, and record the payment with "Mark invoice paid" when it arrives. '
      + 'Clause 6.5 and clause 7.2(c) of the agreement say what an overdue invoice does to the guarantee: read them before discussing the guarantee with the practice.',
      'Chase the invoice; mark it paid when the money arrives.',
      'The invoice is recorded as paid. Mark this complete then.', 'high',
      { invoice_sent_at: fees.cleanDay(i.invoiceSentAt) || null });
  }
  return null;
}

/**
 * Checklist row 15, early exit: ONE task for the CEO, "replacement or credit".
 * `credit` is the result of fees.guaranteeCreditFor. When the credit could not
 * be worked out the task says what a person must decide and states no figure
 * of its own (it may quote the schedule's band, which is the agreement's).
 */
function buildExitTask(input) {
  const i = input && typeof input === 'object' ? input : {};
  const credit = i.credit && typeof i.credit === 'object' ? i.credit : { known: false, creditPct: null, needsDecision: ['dates_unknown'] };
  const who = drName(i.name) + atPractice(i.practiceName);
  const reasonLabel = fees.EXIT_REASON_LABEL[i.reason] || fees.EXIT_REASON_LABEL.other;
  const facts = drName(i.name) + ' commenced' + atPractice(i.practiceName) + ' on ' + longDay(i.commencedAt)
    + ' and their last working day was ' + longDay(i.lastWorkingDay)
    + (Number.isFinite(credit.daysWorked) ? ' (' + credit.daysWorked + ' days after commencement)' : '') + '. '
    + 'Reason recorded: ' + reasonLabel + (i.note ? ' (' + clean(i.note, 300) + ')' : '') + '. ';
  let title;
  let verdict;
  if (credit.known && credit.reason === 'schedule') {
    title = 'Replacement or credit: ' + who;
    verdict = 'Credit under clause 7.1 of the agreement: ' + credit.creditPct + '% of the placement fee, credited towards future placements or services (the schedule\'s band for this last working day; the other conditions of clause 7.2 were confirmed by the person who recorded the exit). ';
  } else if (credit.known && credit.reason === 'forfeited_invoice_overdue') {
    title = 'Replacement or credit: ' + who + ' (guarantee forfeited: invoice overdue)';
    verdict = 'No credit: the placement\'s invoice was not paid within seven days of its date, and clause 6.5 / clause 7.2(c) of the agreement say all credit and guarantee entitlements are then forfeited. Check the invoice dates on file before telling the practice. ';
  } else if (credit.known && credit.reason === 'conditions_not_met') {
    title = 'Replacement or credit: ' + who + ' (clause 7.2 conditions not met)';
    verdict = 'No credit: the person who recorded the exit said the conditions of clause 7.2 were not met. Check that before telling the practice. ';
  } else if (credit.known && credit.reason === 'outside_guarantee_period') {
    title = 'Doctor left after the guarantee period: ' + who;
    verdict = 'No credit: the last working day is after the 12-week guarantee period. ';
  } else {
    title = 'Decide the guarantee credit, then replacement or credit: ' + who;
    const whys = (Array.isArray(credit.needsDecision) ? credit.needsDecision : []).map(function (k) { return fees.CREDIT_DECISION_TEXT[k] || k; });
    verdict = 'The credit could NOT be worked out from what is on file, so none has been recorded: ' + (whys.join('; ') || 'a condition could not be checked') + '. '
      + (Number.isFinite(credit.scheduleBandPct) ? 'For reference, the schedule\'s band for this last working day is ' + credit.scheduleBandPct + '% (clause 7.1), subject to clauses 7.2 and 7.3. ' : '')
      + 'Read clause 7 of the agreement, decide, and record the decision with "Record credit decision". ';
  }
  return {
    task_type: TASK_TYPE.MANUAL,
    status: 'open',
    title,
    description: facts + verdict
      + (String(i.roleStatus || '').toLowerCase() === 'filled'
        ? 'The role this placement filled is still marked "filled" on the Jobs board, so no doctor can see it or apply: if the practice wants a replacement, reopen the role there (nothing reopens it automatically). '
        : '')
      + 'Then agree with the practice whether they want a replacement search or the credit, and note the outcome here. The remaining check-ins for this placement have been cancelled, and the doctor can look for a new role.',
    priority: 'high',
    due_date: fees.cleanDay(i.today) ? fees.addDays(i.today, 2) : null,
    source_trigger: SOURCE.EARLY_EXIT,
    related_stage: i.stage || null,
    metadata: meta(KIND.REPLACEMENT_OR_CREDIT, i, {
      checklist_row: 15, owner: OWNER.CEO,
      what_to_do: credit.known ? 'Agree replacement or credit with the practice and note the outcome.' : 'Decide the credit under clause 7 (the app could not), record it, then agree replacement or credit with the practice.',
      done_when: 'The credit decision is on file and the outcome with the practice is noted. Mark this complete then.',
      ended_at: fees.cleanDay(i.lastWorkingDay) || null, end_reason: i.reason || null,
      credit_known: credit.known === true, credit_pct: credit.known ? credit.creditPct : null,
      credit_reason: credit.reason || null, credit_needs_decision: credit.known ? [] : (credit.needsDecision || []),
      schedule_band_pct: Number.isFinite(credit.scheduleBandPct) ? credit.scheduleBandPct : null
    })
  };
}

// ── what the daily job owes a placement ──────────────────────────────────────

function onceKey(kind, placementKey, mark) {
  const part = function (v) { return String(v == null ? '' : v).replace(/[^a-zA-Z0-9_.-]+/g, '').slice(0, 80) || 'none'; };
  return 'au_lc:' + kind + ':' + part(placementKey) + (mark ? ':' + part(mark) : '');
}

/**
 * Before the doctor has started. Every item is due at most once (its `key` is
 * claimed in the once-ever ledger by the caller).
 *
 * @param {{ today, placementKey, ageDays, startDate?, prestartComplete: boolean,
 *           providerTaskOpen: boolean, noticeGiven: boolean, noticeWeeks?: number|null,
 *           indemnityExpiry?: string|null }} facts
 *   ageDays  whole days since the placement was recorded (auCaseAgeDays: the
 *            case is aged from its placement milestone, never from the
 *            doctor's activity in the app)
 * @returns {Array<{ kind, mark, key, ...detail }>}
 */
function prestartRemindersDue(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const today = fees.cleanDay(f.today);
  const out = [];
  if (!today) return out;
  const add = function (kind, mark, detail) { out.push(Object.assign({ kind, mark, key: onceKey(kind, f.placementKey, mark) }, detail || {})); };
  const start = fees.cleanDay(f.startDate);
  const daysToStart = start ? fees.daysBetween(today, start) : NaN;

  if (f.providerTaskOpen === true && Number.isFinite(f.ageDays) && f.ageDays >= PROVIDER_PENDING_DAYS) {
    add(KIND.PROVIDER_PENDING, 'd' + PROVIDER_PENDING_DAYS, { ageDays: f.ageDays });
  }
  // The start date has been reached and nobody has confirmed commencement
  // (checklist row 12's trigger). Once per start date: a moved date asks again.
  if (start && daysToStart <= 0) add(KIND.START_REACHED, start, { startDate: start });
  // Only BEFORE the start date. On the day itself (and after) the one prompt
  // is "confirm commenced": asking that day whether notice has been given, or
  // warning that the start is "0 days" away, would be noise.
  if (start && daysToStart > 0) {
    if (f.prestartComplete !== true) {
      // Only the tightest threshold reached is due: a placement recorded two
      // days before the start date gets one task, not two.
      const reached = PRESTART_AT_RISK_DAYS.filter(function (d) { return daysToStart <= d; });
      if (reached.length) add(KIND.PRESTART_AT_RISK, 'd' + reached[reached.length - 1], { startDate: start, daysToStart });
    }
    if (f.noticeGiven !== true) {
      const weeks = Number.isFinite(Number(f.noticeWeeks)) && Number(f.noticeWeeks) > 0 ? Math.round(Number(f.noticeWeeks)) : null;
      const lead = weeks ? weeks * 7 + NOTICE_MARGIN_DAYS : NOTICE_DEFAULT_LEAD_DAYS;
      if (daysToStart <= lead) add(KIND.NOTICE, start, { startDate: start, noticeWeeks: weeks });
    }
  }
  const expiry = fees.cleanDay(f.indemnityExpiry);
  if (expiry) {
    if (start && expiry < start) add(KIND.INDEMNITY, expiry, { expiry, beforeStart: true, startDate: start });
    else if (fees.daysBetween(today, expiry) <= INDEMNITY_WARN_DAYS) add(KIND.INDEMNITY, expiry, { expiry, beforeStart: false, startDate: start || null });
  }
  return out;
}

/**
 * After commencement, for a placement that has not ended.
 *
 * @param {{ today, placementKey, commencedAt, guaranteeEndsAt?, feeTier?,
 *           invoiceSentAt?, invoicePaidAt?, indemnityExpiry? }} facts
 * @returns {Array<{ kind, mark, key, message?: boolean, stale?: boolean, ...detail }>}
 *   message: the item also sends N18 / N19 / N20; stale: too long after its
 *   moment for the message to go (the caller records it and sends nothing).
 */
function commencedRemindersDue(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const today = fees.cleanDay(f.today);
  const commenced = fees.cleanDay(f.commencedAt);
  const out = [];
  if (!today || !commenced) return out;
  const ends = fees.cleanDay(f.guaranteeEndsAt) || fees.guaranteeEndsOn(commenced);
  const add = function (kind, mark, detail) { out.push(Object.assign({ kind, mark, key: onceKey(kind, f.placementKey, mark) }, detail || {})); };
  const since = fees.daysBetween(commenced, today);
  if (!(since >= 0) || since > LIFECYCLE_HORIZON_DAYS) return out;

  const week1 = fees.addDays(commenced, WEEK1_DAYS);
  if (today >= week1) add(KIND.WEEK1, 'w1', { message: true, date: week1, stale: fees.daysBetween(week1, today) > MESSAGE_LATE_DAYS });

  const checkins = fees.guaranteeCheckinDays(commenced);
  checkins.forEach(function (c, idx) {
    if (today < c.date) return;
    const next = checkins[idx + 1];
    // A check-in message is not sent once the next one is due (or two weeks
    // after the last): the doctor and practice get the current one only.
    const stale = next ? today >= next.date : fees.daysBetween(c.date, today) > MESSAGE_LATE_DAYS;
    add(KIND.CHECKIN, 'w' + c.week, { message: true, week: c.week, date: c.date, stale });
  });

  if (today >= fees.addDays(ends, -GUARANTEE_ENDING_DAYS) && today <= ends) add(KIND.GUARANTEE_ENDING, ends, { guaranteeEndsAt: ends });
  // The period includes its last day, so the case closes the day after.
  if (today > ends) add(KIND.GUARANTEE_ENDED, ends, { message: true, guaranteeEndsAt: ends, stale: fees.daysBetween(ends, today) > REFERRAL_LATE_DAYS });

  if (f.feeTier === fees.FEE_TIER.PART_TIME) {
    fees.upliftReminderDays(commenced).forEach(function (u) {
      if (today >= u.date) add(KIND.UPLIFT, 'm' + u.month, { month: u.month, date: u.date });
    });
  }

  const sent = fees.cleanDay(f.invoiceSentAt);
  if (sent && !fees.cleanDay(f.invoicePaidAt)) {
    const dueBy = fees.invoicePaymentDueOn(sent);
    if (today > dueBy) add(KIND.INVOICE_OVERDUE, sent, { invoiceSentAt: sent, paymentDueBy: dueBy });
  }

  const expiry = fees.cleanDay(f.indemnityExpiry);
  if (expiry && today <= ends && fees.daysBetween(today, expiry) <= INDEMNITY_WARN_DAYS) {
    add(KIND.INDEMNITY, expiry, { expiry, beforeStart: false });
  }
  return out;
}

// ── read functions (WP-27 draws the tiles; nothing is drawn here) ────────────

/**
 * The commercial state of one placement row, for staff screens and exports.
 * @param {object} row  a `placements` row (select=*)
 * @param {string} today  YYYY-MM-DD
 */
function commercialState(row, today) {
  const r = row && typeof row === 'object' ? row : {};
  const day = fees.cleanDay(today);
  const commenced = fees.cleanDay(r.commenced_at);
  const ends = fees.cleanDay(r.guarantee_ends_at);
  const ended = fees.cleanDay(r.ended_at);
  const sent = fees.cleanDay(r.invoice_sent_at);
  const paid = fees.cleanDay(r.invoice_paid_at);
  const due = fees.cleanDay(r.invoice_due_at);
  const invoice = !commenced ? 'not_due' : (paid ? 'paid' : (sent ? (day && day > fees.invoicePaymentDueOn(sent) ? 'overdue' : 'sent') : 'due'));
  const inGuarantee = !!(commenced && ends && !ended && day && day <= ends);
  return {
    commenced: !!commenced, commencedAt: commenced || null, ended: !!ended, endedAt: ended || null,
    invoice, invoiceDueAt: due || null, invoiceSentAt: sent || null, invoicePaidAt: paid || null,
    guaranteeEndsAt: ends || null, inGuarantee,
    guaranteeDaysLeft: inGuarantee ? fees.daysBetween(day, ends) : null,
    guaranteeEndingSoon: inGuarantee && fees.daysBetween(day, ends) <= GUARANTEE_ENDING_DAYS
  };
}

/**
 * WP-27 hook: the three commercial lists, from `placements` rows.
 * @returns {{ invoicesDue: object[], inGuarantee: object[], guaranteeEndingSoon: object[], counts: object }}
 */
function commercialSummary(rows, today) {
  const out = { invoicesDue: [], inGuarantee: [], guaranteeEndingSoon: [], counts: { invoicesDue: 0, invoicesOverdue: 0, inGuarantee: 0, guaranteeEndingSoon: 0 } };
  // `today` is a calendar date, or a function giving each row its own (the
  // practice's day: a Perth placement and a Sydney one are on different dates
  // for two or three hours every evening).
  const dayFor = typeof today === 'function' ? today : function () { return today; };
  (Array.isArray(rows) ? rows : []).forEach(function (row) {
    if (!row) return;
    const s = commercialState(row, dayFor(row));
    if (!s.commenced) return;
    const item = {
      placement_id: row.id || null, application_id: row.application_id || null, user_id: row.user_id || null,
      practice_name: row.practice_name || '', commenced_at: s.commencedAt, guarantee_ends_at: s.guaranteeEndsAt,
      guarantee_days_left: s.guaranteeDaysLeft, invoice: s.invoice, invoice_due_at: s.invoiceDueAt, invoice_sent_at: s.invoiceSentAt,
      fee_tier: row.fee_tier || null,
      fee_amount_ex_gst: row.fee_amount_ex_gst === null || row.fee_amount_ex_gst === undefined ? null : Number(row.fee_amount_ex_gst)
    };
    if (s.invoice === 'due' || s.invoice === 'sent' || s.invoice === 'overdue') {
      out.invoicesDue.push(item);
      if (s.invoice === 'overdue') out.counts.invoicesOverdue += 1;
    }
    if (s.inGuarantee) out.inGuarantee.push(item);
    if (s.guaranteeEndingSoon) out.guaranteeEndingSoon.push(item);
  });
  out.counts.invoicesDue = out.invoicesDue.length;
  out.counts.inGuarantee = out.inGuarantee.length;
  out.counts.guaranteeEndingSoon = out.guaranteeEndingSoon.length;
  return out;
}

// ── exports (ADM-30) ─────────────────────────────────────────────────────────

// The columns the placements export gains with the switch on, after today's.
const PLACEMENT_EXPORT_COLUMNS = Object.freeze([
  Object.freeze({ key: 'pathway', label: 'Pathway' }),
  Object.freeze({ key: 'candidate_basis', label: 'Candidate based in' }),
  Object.freeze({ key: 'sessions_per_week_numeric', label: 'Sessions per week' }),
  Object.freeze({ key: 'fee_tier', label: 'Fee tier' }),
  Object.freeze({ key: 'fee_amount_ex_gst', label: 'Fee (ex GST)' }),
  Object.freeze({ key: 'agreement_variant', label: 'Agreement variant' }),
  Object.freeze({ key: 'commenced_at', label: 'Commenced (actual)' }),
  Object.freeze({ key: 'invoice_due_at', label: 'Invoice due' }),
  Object.freeze({ key: 'invoice_sent_at', label: 'Invoice sent' }),
  Object.freeze({ key: 'invoice_reference', label: 'Invoice reference' }),
  Object.freeze({ key: 'invoice_paid_at', label: 'Invoice paid' }),
  Object.freeze({ key: 'guarantee_ends_at', label: 'Guarantee ends' }),
  Object.freeze({ key: 'ended_at', label: 'Ended (last working day)' }),
  Object.freeze({ key: 'end_reason', label: 'End reason' }),
  Object.freeze({ key: 'credit_pct', label: 'Credit %' })
]);
// ... and the candidate (GPs) export.
const GP_EXPORT_COLUMNS = Object.freeze([
  Object.freeze({ key: 'pathway', label: 'Pathway' }),
  Object.freeze({ key: 'commenced_at', label: 'Commenced (actual)' }),
  Object.freeze({ key: 'fee_tier', label: 'Fee tier' }),
  Object.freeze({ key: 'fee_amount_ex_gst', label: 'Fee (ex GST)' }),
  Object.freeze({ key: 'invoice_status', label: 'Invoice' }),
  Object.freeze({ key: 'guarantee_ends_at', label: 'Guarantee ends' })
]);

function exportValue(v) { return v === null || v === undefined ? '' : String(v); }

/** The extra placement-export cells for one `placements` row. */
function placementExportCells(row, pathway) {
  const r = row && typeof row === 'object' ? row : {};
  const out = { pathway: exportValue(pathway) };
  PLACEMENT_EXPORT_COLUMNS.forEach(function (c) {
    if (c.key === 'pathway') return;
    const v = r[c.key];
    out[c.key] = /_at$/.test(c.key) ? (fees.cleanDay(String(v || '')) || '') : exportValue(v);
  });
  return out;
}

// ── FB-2a (W3-D1, W3-D3): where an Australian case belongs, from the facts ────

/**
 * The Australian stage a case should be on, worked out from what is on file
 * about the doctor's placements. Used ONLY to put a case back on the
 * Australian ladder when it is found off it (a case the overseas stage code
 * rewrote while the switch was off, or one whose doctor has just been given an
 * Australian pathway). A case already on the ladder is never re-derived: it
 * moves forward through advanceAuCaseStage as each thing happens.
 *
 * `placements` are the doctor's `placements` rows (any status). `dayFor(row)`
 * gives today's calendar date at that row's practice (the calendar-date
 * rule); `today` is the fallback. The newest placement decides:
 *
 *   an active one, not yet commenced          -> prestart
 *   active, commenced within the last week    -> commenced
 *   active, past the first week               -> guarantee
 *   active, the guarantee period over         -> complete
 *   ended                                     -> complete, or placement when
 *                                                the doctor has asked for
 *                                                roles again since
 *                                                (`lookingAgain`)
 *   cancelled, or none                        -> prestart when an application
 *                                                is recorded as secured with no
 *                                                row yet, else placement
 *
 * @returns {{ stage: string, basis: string, placementId: string|null }}
 */
function caseStageFromPlacementFacts(input) {
  const i = input && typeof input === 'object' ? input : {};
  const rows = (Array.isArray(i.placements) ? i.placements : []).filter(Boolean).slice().sort(function (a, b) {
    return String(b.placed_at || b.created_at || '').localeCompare(String(a.placed_at || a.created_at || ''));
  });
  const dayOf = function (row) {
    let d = '';
    try { d = typeof i.dayFor === 'function' ? i.dayFor(row) : ''; } catch (e) { d = ''; }
    return fees.cleanDay(String(d || i.today || '')) || '';
  };
  const idOf = function (row) { return row && row.id != null ? String(row.id) : null; };
  const status = function (row) { return String(row.status || '').trim().toLowerCase(); };
  const live = rows.filter(function (r) { return status(r) === 'active' && !fees.cleanDay(String(r.ended_at || '')); });
  const fresh = live.filter(function (r) { return !fees.cleanDay(String(r.commenced_at || '')); })[0];
  // A placement still to start outranks one already under way: it is the
  // newest thing that has happened to this doctor.
  if (fresh) return { stage: 'prestart', basis: 'placement_recorded', placementId: idOf(fresh) };
  const newest = rows[0] || null;
  const running = live[0] || null;
  const ended = rows.filter(function (r) { return status(r) === 'ended' || !!fees.cleanDay(String(r.ended_at || '')); })[0] || null;
  if (running && (!ended || rows.indexOf(running) < rows.indexOf(ended))) {
    const commenced = fees.cleanDay(String(running.commenced_at || ''));
    const today = dayOf(running);
    const ends = fees.cleanDay(String(running.guarantee_ends_at || '')) || fees.guaranteeEndsOn(commenced);
    if (today && ends && today > ends) {
      return { stage: i.lookingAgain === true ? 'placement' : 'complete', basis: i.lookingAgain === true ? 'looking_again' : 'guarantee_ended', placementId: idOf(running) };
    }
    if (today && fees.daysBetween(commenced, today) >= WEEK1_DAYS) return { stage: 'guarantee', basis: 'first_week_over', placementId: idOf(running) };
    return { stage: 'commenced', basis: 'commenced', placementId: idOf(running) };
  }
  if (ended && newest === ended) {
    return i.lookingAgain === true
      ? { stage: 'placement', basis: 'looking_again', placementId: idOf(ended) }
      : { stage: 'complete', basis: 'placement_ended', placementId: idOf(ended) };
  }
  if (i.securedApplicationWithoutRow === true) return { stage: 'prestart', basis: 'application_secured', placementId: null };
  return { stage: 'placement', basis: rows.length ? 'placement_cancelled' : 'no_placement', placementId: null };
}

/**
 * FB-2b (A4): where ONE placement row is in its life, from its own dates.
 *
 * `placements.status` has three values and stays truthful: a doctor who is
 * still at the practice after the guarantee period has an `active` placement.
 * What changed is that nothing may read `active` to mean "in pre-start or in
 * the guarantee period" any more. This is the one place that tells them
 * apart:
 *
 *   cancelled     status 'cancelled'
 *   ended         status 'ended', or an `ended_at`
 *   prestart      active, no `commenced_at` yet
 *   first_week    started, fewer than WEEK1_DAYS days ago
 *   settling_in   started, the guarantee period still running
 *   settled       started, and the guarantee period has finished
 *
 * `today` is the practice's own calendar date (section 25). The guarantee
 * period includes its last day, as everywhere else. With no usable `today` a
 * started row reads `settling_in` (never "settled" on a guess). Pure.
 *
 * @param {object} row    a `placements` row
 * @param {string} today  YYYY-MM-DD on the practice's clock
 * @returns {'cancelled'|'ended'|'prestart'|'first_week'|'settling_in'|'settled'|''}
 */
const PLACEMENT_PHASE = Object.freeze({
  CANCELLED: 'cancelled', ENDED: 'ended', PRESTART: 'prestart',
  FIRST_WEEK: 'first_week', SETTLING_IN: 'settling_in', SETTLED: 'settled'
});
function placementPhase(row, today) {
  if (!row || typeof row !== 'object') return '';
  const status = String(row.status || '').trim().toLowerCase();
  if (status === 'cancelled') return PLACEMENT_PHASE.CANCELLED;
  if (status === 'ended' || fees.cleanDay(String(row.ended_at || ''))) return PLACEMENT_PHASE.ENDED;
  const commenced = fees.cleanDay(String(row.commenced_at || ''));
  if (!commenced) return PLACEMENT_PHASE.PRESTART;
  const day = fees.cleanDay(String(today || ''));
  if (!day) return PLACEMENT_PHASE.SETTLING_IN;
  const ends = fees.cleanDay(String(row.guarantee_ends_at || '')) || fees.guaranteeEndsOn(commenced);
  if (ends && day > ends) return PLACEMENT_PHASE.SETTLED;
  return fees.daysBetween(commenced, day) >= WEEK1_DAYS ? PLACEMENT_PHASE.SETTLING_IN : PLACEMENT_PHASE.FIRST_WEEK;
}

module.exports = {
  PLACEMENT_PHASE, placementPhase,
  SOURCE, TASK_TYPE, OWNER, KIND, caseStageFromPlacementFacts, COMMENCEMENT_DERIVED_KINDS, EXIT_CANCELLED_KINDS,
  WEEK1_DAYS, PROVIDER_PENDING_DAYS, PRESTART_AT_RISK_DAYS, NOTICE_DEFAULT_LEAD_DAYS, NOTICE_MARGIN_DAYS,
  INDEMNITY_WARN_DAYS, GUARANTEE_ENDING_DAYS, MESSAGE_LATE_DAYS, REFERRAL_LATE_DAYS, LIFECYCLE_HORIZON_DAYS,
  OVERRIDE_REASON_MIN, FEE_UNKNOWN_TEXT, TIER_LABEL,
  longDay, formatAud, localDay, FALLBACK_ZONE, onceKey,
  validateCommencement,
  buildInvoiceTask, buildCheckinTask, buildWeek1Task, buildLifecycleTask, buildExitTask,
  prestartRemindersDue, commencedRemindersDue,
  commercialState, commercialSummary,
  PLACEMENT_EXPORT_COLUMNS, GP_EXPORT_COLUMNS, placementExportCells
};

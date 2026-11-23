'use strict';
/**
 * Australian GP build, fix bundle FR-2 (final review R2-03, M2-04).
 * THE one rule for "may this Australian task be closed from a general task
 * screen?" (PUT /api/admin/task: the admin task list, the Ops Queue, the case
 * profile). Pure, no I/O.
 *
 * Some Australian tasks stand for a FACT and are finished by their own action:
 * ticking or cancelling them from a general screen would change what the app
 * believes with nothing behind it. Round 2 of the review found the worst one:
 * a plain tick on the "Notice given" task silently took the notice back (the
 * check-in messages resumed, no exit was recorded).
 *
 *   completed   refused for every task below until its fact is on the task
 *   cancelled   "Notice given": always refused (use "Withdraw notice").
 *               The others: refused unless a reason of at least
 *               CANCEL_REASON_MIN characters is given; the reason is kept on
 *               the task and written to the timeline by the caller.
 *
 * A task that is not Australian (metadata.au !== true), or is none of the
 * kinds below, is never touched: the function answers { refuse: false }.
 */
const auPrestart = require('./au-prestart.js');
const auLifecycle = require('./au-lifecycle.js');
const auSegmentB = require('./au-segment-b.js');

const CANCEL_REASON_MIN = 10;
const RESTRAINT_OUTCOMES = Object.freeze(['no_restraint', 'restraint_does_not_apply', 'restraint_applies']);

function metaOf(task) {
  let m = task && task.metadata;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { m = null; } }
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

/**
 * Which own-action task is this, and is its fact on file yet?
 * @returns {{ kind: string, done: boolean, how: string }|null} null = an ordinary task
 */
function ownActionOf(task) {
  const m = metaOf(task);
  if (!task || m.au !== true) return null;
  const type = String(task.task_type || '');
  if (m.lifecycle_kind === auLifecycle.KIND.EXIT_NOTICE) {
    return { kind: 'exit_notice', done: false,
      how: 'This task records that the doctor has given notice. It closes by itself when the exit is recorded on the last working day. To take the notice back, open the candidate\'s "Commencement and guarantee" card and use "Withdraw notice"; if the doctor has already left, use "Doctor left" there.' };
  }
  if (type === auPrestart.TASK_TYPE.PROVIDER_NUMBER_NEW_LOCATION) {
    return { kind: 'provider_number', done: !!m.provider_number, how: 'This task is finished by recording the provider number for the new location. Record the number and it closes by itself.' };
  }
  if (type === auPrestart.TASK_TYPE.START_DATE_TRACKING) {
    return { kind: 'start_date', done: !!m.confirmed_start_date, how: 'This task is finished by saving the confirmed start date. Save the date and it closes by itself.' };
  }
  if (type === auPrestart.TASK_TYPE.INDEMNITY_CERTIFICATE) {
    return { kind: 'indemnity', done: false, how: 'This task closes by itself when the doctor\'s indemnity certificate is approved. Approve the certificate (or file it for the doctor) instead.' };
  }
  if (type === auLifecycle.TASK_TYPE.INVOICE_DUE && m.lifecycle_kind === auLifecycle.KIND.INVOICE) {
    return { kind: 'invoice', done: false, how: 'This task closes by itself when the invoice is recorded as sent. Open the candidate\'s "Commencement and guarantee" card and use "Mark invoice sent" (the CEO does this).' };
  }
  if (type === auPrestart.TASK_TYPE.RESTRAINT_CHECK) {
    return { kind: 'restraint_check', done: RESTRAINT_OUTCOMES.indexOf(String(m.restraint_outcome || '')) !== -1,
      how: 'This task is finished by recording what the restraint check found. Open the candidate on the CEO dashboard, choose "Mark done" on this task and pick the outcome (the placing consultant or the CEO does this).' };
  }
  if (m.needs_its_action === true && m.lifecycle_kind === auSegmentB.KIND.VISA_TRANSFER_DECISION) {
    return { kind: 'visa_transfer_decision', done: false, how: 'This task is finished by recording the decision. Open the candidate\'s "Segment B" card and choose "Confirm: transfer needed" or "Not needed".' };
  }
  if (m.needs_its_action === true && m.lifecycle_kind === auSegmentB.KIND.SUPERVISION_RELODGEMENT) {
    return { kind: 'supervision', done: false, how: 'This task closes by itself when the Ahpra approval is filed in the doctor\'s "Supervision plan" slot, or recorded with "Record Ahpra outcome" on the candidate\'s "Segment B" card.' };
  }
  if (m.needs_its_action === true && m.lifecycle_kind === auSegmentB.KIND.VISA_TRANSFER_TASK && (m.mark === 'tracking' || m.mark === 'grant_notice')) {
    return { kind: 'visa_transfer_task', done: false,
      how: m.mark === 'tracking' ? 'This task closes by itself when the new nomination is recorded as approved. Use "Nomination approved" on the candidate\'s "Segment B" card.'
        : 'This task closes by itself when the visa grant notice is filed in the doctor\'s document slot.' };
  }
  return null;
}

/**
 * @param {{ task_type, metadata }} task   the task row as stored
 * @param {string} newStatus               the status the request asks for
 * @param {string} [reason]                the reason given with a cancellation
 * @returns {{ refuse: boolean, code?: string, message?: string, kind?: string, recordReason?: string }}
 */
function statusChangeDecision(task, newStatus, reason) {
  const status = String(newStatus || '');
  if (status !== 'completed' && status !== 'cancelled') return { refuse: false };
  const own = ownActionOf(task);
  if (!own) return { refuse: false };
  if (status === 'completed') {
    if (own.done) return { refuse: false, kind: own.kind };
    return { refuse: true, code: 'au_task_needs_its_action', kind: own.kind, message: own.how };
  }
  // cancelled
  if (own.kind === 'exit_notice') return { refuse: true, code: 'au_task_needs_its_action', kind: own.kind, message: own.how };
  if (own.done) return { refuse: false, kind: own.kind };
  const why = String(reason == null ? '' : reason).replace(/\s+/g, ' ').trim();
  if (why.length < CANCEL_REASON_MIN) {
    return { refuse: true, code: 'au_task_cancel_needs_reason', kind: own.kind,
      message: 'This task stands for something that has to be done or recorded for this placement, so it cannot be cancelled without a reason. Say why it is no longer needed (at least ' + CANCEL_REASON_MIN + ' characters). ' + own.how };
  }
  return { refuse: false, kind: own.kind, recordReason: why.slice(0, 400) };
}

module.exports = { statusChangeDecision, ownActionOf, CANCEL_REASON_MIN, RESTRAINT_OUTCOMES };

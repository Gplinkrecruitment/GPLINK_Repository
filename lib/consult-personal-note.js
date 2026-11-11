// A personal WhatsApp note the owner approved in advance, held on the lead and
// sent later by the consult-nudge cron — but only if the doctor still has no
// app account when its time comes.
//
// Why it exists (owner, 2026-11-12): after a consultation the owner wanted two
// doctors chased "if they haven't signed up after a week", each with wording he
// had read and approved. A session-only timer does not survive a week and a
// cloud routine has no WhatsApp key, so the note lives where the follow-up job
// already looks: site_enquiries.metadata.consult.personal_note
//
//   { id, send_after, name, first, second, created_at, created_by,
//     sent_at?, cancelled?, cancelled_at?, tries? }
//
// One note per lead at a time. It goes out through the approved template
// gp_link_khaleed_personal_checkin:
//   "Hi {{1}}, Khaleed here from GP Link. Hope all is well!\n\n{{2}}\n\n{{3}} 😊
//    \n\nWarm regards,\nKhaleed"
// {{2}} and {{3}} are whole paragraphs and WhatsApp refuses a template
// parameter that holds a line break, a tab or a run of spaces — validated here
// so a bad note is cancelled with a reason instead of failing every five
// minutes.
//
// Pure: no I/O. The server asks "does an account exist?" and passes the answer.
'use strict';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const PERSONAL_NOTE_TEMPLATE = { templateName: 'gp_link_khaleed_personal_checkin', language: 'en' };
// A note that could not go out within this long of its time is dropped: a
// "one week after our call" message three weeks late reads wrong.
const PERSONAL_NOTE_EXPIRES_MS = 3 * DAY;
// A send that keeps failing (template paused, number not on WhatsApp) stops
// after this many passes.
const PERSONAL_NOTE_MAX_TRIES = 6;
// The lead said stop, or no longer needs asking.
const PERSONAL_NOTE_STOP_REASONS = ['unsubscribed', 'do_not_call', 'not_interested', 'signed_up'];

function clean(v) { return String(v == null ? '' : v).trim(); }

// A template parameter WhatsApp will accept.
function validParam(v) {
  const s = clean(v);
  return !!s && !/[\n\r\t]/.test(s) && !/ {4,}/.test(s) && s.length <= 900;
}

function personalNote(consult) {
  const n = consult && consult.personal_note;
  return n && typeof n === 'object' && !Array.isArray(n) ? n : null;
}

// What to do with the lead's note right now.
//   { action: 'none' }                       nothing held, or already settled
//   { action: 'wait' }                       not time yet
//   { action: 'cancel', reason }             settle it without sending
//   { action: 'check_account' }              due: the caller must look up the account first
//   { action: 'send', message, phoneNeeded } due and clear to go
// `accountExists` is undefined until the caller has looked.
function personalNoteDecision(input) {
  const row = (input && input.row) || {};
  const consult = (row.metadata && row.metadata.consult) || {};
  const note = personalNote(consult);
  if (!note || note.sent_at || note.cancelled) return { action: 'none' };
  const nowMs = Number(input && input.nowMs) || Date.now();
  const afterMs = Date.parse(note.send_after || '');
  if (!Number.isFinite(afterMs)) return { action: 'cancel', reason: 'bad_send_after' };
  if (!validParam(note.name) || !validParam(note.first) || !validParam(note.second)) return { action: 'cancel', reason: 'bad_text' };
  // Stops are honoured the moment they appear, not only when the note is due.
  if (row.status === 'converted' || consult.stopped === 'signed_up') return { action: 'cancel', reason: 'signed_up' };
  if (PERSONAL_NOTE_STOP_REASONS.indexOf(consult.stopped) !== -1) return { action: 'cancel', reason: 'stopped_' + consult.stopped };
  if (nowMs < afterMs) return { action: 'wait' };
  if (nowMs > afterMs + PERSONAL_NOTE_EXPIRES_MS) return { action: 'cancel', reason: 'expired' };
  if ((Number(note.tries) || 0) >= PERSONAL_NOTE_MAX_TRIES) return { action: 'cancel', reason: 'send_failed' };
  if (!(input && input.hasPhone)) return { action: 'cancel', reason: 'no_phone' };
  if (input.accountExists === undefined) return { action: 'check_account' };
  if (input.accountExists) return { action: 'cancel', reason: 'signed_up' };
  return {
    action: 'send',
    message: {
      templateName: PERSONAL_NOTE_TEMPLATE.templateName,
      language: PERSONAL_NOTE_TEMPLATE.language,
      placeholders: [clean(note.name), clean(note.first), clean(note.second)]
    }
  };
}

// The message exactly as the doctor reads it (for logs and the approval record).
function renderPersonalNote(note) {
  const n = note || {};
  return 'Hi ' + clean(n.name) + ', Khaleed here from GP Link. Hope all is well!\n\n' + clean(n.first) + '\n\n' + clean(n.second) + ' 😊\n\nWarm regards,\nKhaleed';
}

module.exports = {
  PERSONAL_NOTE_TEMPLATE,
  PERSONAL_NOTE_EXPIRES_MS,
  PERSONAL_NOTE_MAX_TRIES,
  PERSONAL_NOTE_STOP_REASONS,
  validParam,
  personalNote,
  personalNoteDecision,
  renderPersonalNote
};

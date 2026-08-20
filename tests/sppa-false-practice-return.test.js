// Owner report 2026-08-20, Dr Mercy Obanimoh: "the practice did not in fact send the SPPA-00 but
// the system is saying they did and is showing a copy of the gp completed part and saying its
// from the practice."
//
// Reconstructed from prod, end to end:
//   23:05:05  hazel@ clicks "Check for practice reply now" on the SPPA-00 task.
//   The recheck sweeps `from:chamiraranatunga@yahoo.com newer_than:30d` across three mailboxes,
//   which surfaces his Position Description emails of 2 Aug and 9 Aug — 17 days old, already
//   filed on the Position Description task, and about a different document entirely.
//   matchResponseToTask routes them to the SPPA-00 task on an ai_content_match of 72-82%
//   ("Below is the Position description" reads like a delivery), so earlyIsDoc is true.
//   Neither email has an attachment, so NOTHING is stored — and the task flips to
//   `practice_returned` anyway. The card then renders the newest document it holds, which is the
//   CANDIDATE's own form returned on 13 Aug, under "Completed SPPA-00 returned by practice",
//   with a "Submit — Deliver to GP" button. The practice had sent nothing.
//
// Three independent defects, each of which alone would have prevented it.
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

// The inbound-mail match block, from the idempotency guard to the end of the SPPA transitions.
const EARLY = SERVER.slice(
  SERVER.indexOf('var _alreadyAttached = await supabaseDbRequest'),
  SERVER.indexOf("await _logCaseEvent(earlyGpCase.id, earlyTask.id, 'status_change'"),
);

describe('a practice "return" requires a document that actually arrived', () => {
  it('does not advance the SPPA state on a message that stored nothing', () => {
    expect(EARLY).toContain("earlyTask.related_document_key === 'sppa_00' && earlyIsDoc && _earlyStoredDocIds.length > 0");
  });

  it('the transitions themselves are unreachable without a stored document', () => {
    const gate = EARLY.indexOf('_earlyStoredDocIds.length > 0');
    const practiceReturn = EARLY.indexOf("sppaMeta.sppa_state = 'practice_returned'");
    const gpReturn = EARLY.indexOf("sppaMeta.sppa_state = 'gp_returned'");
    expect(gate).toBeGreaterThan(-1);
    expect(practiceReturn).toBeGreaterThan(gate);
    expect(gpReturn).toBeGreaterThan(gate);
  });

  it('does not mark a sibling practice document "completed" on an email that merely sounds like a delivery', () => {
    expect(EARLY).toContain("if (earlyIsDoc && _earlyStoredDocIds.length > 0 && earlyTask.task_type === 'practice_pack_child'");
  });
});

describe('one email belongs to one task — idempotency spans the case', () => {
  it('checks the whole case, not just the task being matched', () => {
    expect(EARLY).toContain("'select=id,task_id&case_id=eq.' + encodeURIComponent(earlyGpCase.id) + '&gmail_message_id=eq.'");
  });

  it('no longer asks only whether this TASK has seen the message', () => {
    expect(EARLY).not.toContain("'select=id&task_id=eq.' + encodeURIComponent(earlyTask.id) + '&gmail_message_id=eq.'");
  });
});

describe('a reply cannot predate the email it is replying to', () => {
  it('the sender-recovery sweep is bounded by when we last asked them', () => {
    expect(SERVER).toContain('var _recAfter = Number(options.recoverFromSenderAfterMs);');
    expect(SERVER).toContain("? ' after:' + Math.floor(_recAfter / 1000)");
  });

  it('the recheck endpoint passes that bound from the SPPA state timestamps', () => {
    expect(SERVER).toContain('recoverFromSenderAfterMs: _recheckAwaitingSince || null,');
    expect(SERVER).toContain('_recheckMeta.corrections_requested_at || _recheckMeta.sent_to_practice_at');
  });

  it('recoverSppaThreadReply bounds its own sender search the same way', () => {
    const fn = SERVER.slice(
      SERVER.indexOf('async function recoverSppaThreadReply'),
      SERVER.indexOf('var pick = selectSppaReplyMessage'),
    );
    expect(fn).toContain("' has:attachment' + _sWindow");
    expect(fn).toContain('var _awaitMs = _awaitIso ? Date.parse(_awaitIso) : NaN;');
  });

  it('still falls back to a 30-day window when no timestamp is on file', () => {
    expect(SERVER).toContain(": ' newer_than:30d';");
  });
});

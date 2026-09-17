// Owner report 2026-09-17 (Dr Mercy Obanimoh): the supervisor emailed the AHPRA officer with
// hazel@ in CC on 9 Sep, but the "Conflict of interest — ask practice to email AHPRA officer"
// card still offered to send the request eight days later. The CC copy arrived on OUR request
// thread (the practice replied from our email), so the early thread-match path filed it, flipped
// the task back to "open" and `continue`d — the dedicated practice→officer auto-close that lives
// further down the inbound pipeline never ran. These pins keep the early path closing the task.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');

describe('conflict-letter: practice CC on our own thread completes the task', () => {
  it('has a shared completion helper that checks isConflictLetterConfirmation and completes the task', () => {
    const start = src.indexOf('async function _completeConflictLetterFromCc(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 3000);
    expect(body).toContain('isConflictLetterConfirmation(emailMeta, { practiceEmail: meta.practice_email');
    expect(body).toContain("completed_by: 'system:practice_cc'");
    expect(body).toContain("confirmed_via: 'practice_cc'");
    expect(body).toContain('Practice emailed AHPRA officer — conflict letter confirmed');
  });

  it('the early thread-match path tries the helper BEFORE the SPPA / generic "flip to open" branches', () => {
    const early = src.indexOf('var earlyResponseMatched = false;');
    const cont = src.indexOf('if (earlyResponseMatched) continue;', early);
    expect(early).toBeGreaterThan(-1);
    expect(cont).toBeGreaterThan(early);
    const block = src.slice(early, cont);
    const helperCall = block.indexOf("earlyTask.task_type === 'ahpra_conflict_letter'");
    const sppaBranch = block.indexOf("earlyTask.related_document_key === 'sppa_00' && earlyIsDoc && _earlyStoredDocIds.length > 0");
    const flipOpen = block.indexOf('// Flip task status to open');
    expect(helperCall).toBeGreaterThan(-1);
    expect(block.slice(helperCall, helperCall + 400)).toContain('await _completeConflictLetterFromCc(earlyTask, earlyGpCase.id, emailMeta, currentMsgId)');
    expect(sppaBranch).toBeGreaterThan(helperCall);
    expect(flipOpen).toBeGreaterThan(sppaBranch);
    // A confirmed copy skips both later branches.
    expect(block).toContain('if (_earlyConflictClosed) {');
  });

  it('a non-confirmation reply never flips a waiting_on_practice conflict-letter task back to open', () => {
    expect(src).toContain("var _earlyKeepWaiting = earlyTask.task_type === 'ahpra_conflict_letter' && earlyTask.status === 'waiting_on_practice';");
    expect(src).toContain("_earlyKeepWaiting ? { updated_at: new Date().toISOString() } : { status: 'open', updated_at: new Date().toISOString() }");
  });

  it('the dedicated auto-close for fresh (non-threaded) practice emails is still in place', () => {
    expect(src).toContain("result: 'conflict_letter_confirmed'");
    expect(src).toContain("task_type=eq.ahpra_conflict_letter&status=in.(open,waiting_on_practice)");
  });
});

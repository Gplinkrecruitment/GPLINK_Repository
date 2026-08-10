// Owner report 2026-08-10 (Dr Mercy Obanimoh): the practice manager
// (pm@thefamilydoctors.com.au) replied to OUR OWN "Position Description" thread with the
// supervisor CV and the position description attached. Neither document reached the task.
// Both tasks still read "Waiting on practice", with no documents and no sign the email
// existed. It had happened three times for that one sender.
//
// Root cause was a chain, not a single bug:
//   1. the early response match resolves the CASE from the SENDER only — a GP profile email,
//      or practice_contact_email on a placed application. A practice manager is neither.
//   2. with no case, matchResponseToTask() never ran — so the gmail_thread_id signal that
//      would have matched her instantly was never even consulted.
//   3. counted as "genuinely unmatched", the scoped-rollout allow-list then SUPPRESSED the
//      message entirely, so it never appeared as an Unknown triage task either. Silent loss.
//
// Fix: resolve the case from the thread we already own. These tests pin that, and pin that
// it cannot be abused to drive the SPPA state machine.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
const recover = require('../lib/alt-supervisor-cv-recover.js');
const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

// The early-response-match block, from the role declaration to the task match.
function earlyMatchBlock() {
  const start = serverSrc.indexOf('var earlySenderRole = null;');
  const end = serverSrc.indexOf('var earlyMatch = await matchResponseToTask(');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return serverSrc.slice(start, end);
}

describe('case resolution falls back to the thread', () => {
  it('looks the case up by gmail_thread_id when the sender is nobody we know', () => {
    const block = earlyMatchBlock();
    expect(block).toContain("'select=case_id&gmail_thread_id=eq.'");
    expect(block).toContain('&case_id=not.is.null&limit=1');
  });

  it('only falls back — a sender-resolved case still wins', () => {
    const block = earlyMatchBlock();
    // The fallback is guarded on the sender lookups having produced nothing.
    expect(block).toContain('if (!earlyGpCase && emailMeta.threadId) {');
    const profileAt = block.indexOf("supabaseDbRequest('user_profiles'");
    const appAt = block.indexOf("supabaseDbRequest('gp_applications'");
    const fallbackAt = block.indexOf('if (!earlyGpCase && emailMeta.threadId) {');
    expect(profileAt).toBeGreaterThan(-1);
    expect(appAt).toBeGreaterThan(profileAt);
    expect(fallbackAt).toBeGreaterThan(appAt); // runs last
  });

  it('runs BEFORE the task match, or the thread signal is never consulted', () => {
    const fallbackAt = serverSrc.indexOf('if (!earlyGpCase && emailMeta.threadId) {');
    const matchAt = serverSrc.indexOf('var earlyMatch = await matchResponseToTask(');
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(matchAt).toBeGreaterThan(fallbackAt);
  });

  it("labels a thread-resolved sender 'unknown', never 'practice'", () => {
    const block = earlyMatchBlock();
    const fallback = block.slice(block.indexOf('if (!earlyGpCase && emailMeta.threadId) {'));
    expect(fallback).toContain("earlySenderRole = 'unknown';");
    expect(fallback).not.toContain("earlySenderRole = 'practice';");
    expect(fallback).not.toContain("earlySenderRole = 'candidate';");
  });
});

// A thread-resolved sender is an unidentified party. Attaching their document is right;
// letting them advance a signature workflow is not.
describe('SPPA transitions are fail-closed for an unidentified sender', () => {
  it('requires a POSITIVELY identified candidate to record a GP return', () => {
    expect(serverSrc).toContain("sppaMeta.sppa_state === 'gp_corrections_requested') && earlySenderRole === 'candidate'");
    expect(serverSrc).not.toContain("sppaMeta.sppa_state === 'gp_corrections_requested') && earlySenderRole !== 'practice'");
  });

  it('requires a POSITIVELY identified practice to record a practice return', () => {
    expect(serverSrc).toContain("sppaMeta.sppa_state === 'corrections_requested') && earlySenderRole === 'practice'");
    expect(serverSrc).not.toContain("sppaMeta.sppa_state === 'corrections_requested') && earlySenderRole !== 'candidate'");
  });
});

// The SPPA sweep re-pulls a task's Gmail thread directly, which is immune to a missed push,
// an advanced history cursor and INBOX archiving. Ordinary practice documents had no such
// net — which is why these two were lost rather than merely delayed.
describe('practice-pack tasks get the same cursor-independent safety net as SPPA', () => {
  it('sweeps practice_pack_child tasks that are waiting on the practice', () => {
    expect(serverSrc).toContain('practicePackReconcile');
    const sweep = serverSrc.slice(serverSrc.indexOf('practicePackReconcile') - 1800);
    expect(sweep).toContain('task_type=eq.practice_pack_child&status=eq.waiting_on_practice');
    expect(sweep).toContain('gmail_thread_id=not.is.null');
  });

  it('re-pulls the thread directly rather than trusting the history cursor', () => {
    const at = serverSrc.indexOf('practicePackReconcile');
    const sweep = serverSrc.slice(at - 1800, at);
    expect(sweep).toContain('processGmailNotification(ppInbox, null, { recoverThreadId: ppTask.gmail_thread_id })');
  });

  it('leaves the two state machines that own their own recovery alone', () => {
    const at = serverSrc.indexOf('practicePackReconcile');
    const sweep = serverSrc.slice(at - 1800, at);
    expect(sweep).toContain('related_document_key=not.in.(sppa_00,section_g)');
  });
});

// The suppression gate is what turned a matching miss into SILENT data loss, so pin the
// exemption the fix relies on: once the thread resolves a case, nothing is suppressed.
describe('rollout allow-list never suppresses a message we could place', () => {
  const allowSet = new Set(['smithmiller1234@gmail.com']);

  it('suppresses a genuinely unplaceable stranger (unchanged behaviour)', () => {
    expect(recover.shouldSuppressUnmatched({
      allowSet, fromAddr: 'pm@thefamilydoctors.com.au',
      earlyResponseMatched: false, altCvMatched: false, hasKnownCase: false,
    })).toBe(true);
  });

  it('does NOT suppress once the thread has resolved a case — the whole fix', () => {
    expect(recover.shouldSuppressUnmatched({
      allowSet, fromAddr: 'pm@thefamilydoctors.com.au',
      earlyResponseMatched: false, altCvMatched: false, hasKnownCase: true,
    })).toBe(false);
  });

  it('does NOT suppress a reply that matched a task', () => {
    expect(recover.shouldSuppressUnmatched({
      allowSet, fromAddr: 'pm@thefamilydoctors.com.au',
      earlyResponseMatched: true, altCvMatched: false, hasKnownCase: false,
    })).toBe(false);
  });

  it('is disabled entirely in full production ("*" / empty allow-list)', () => {
    expect(recover.shouldSuppressUnmatched({
      allowSet: new Set(), fromAddr: 'anyone@anywhere.com',
      earlyResponseMatched: false, altCvMatched: false, hasKnownCase: false,
    })).toBe(false);
  });
});

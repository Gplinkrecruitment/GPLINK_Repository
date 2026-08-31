import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

// A stale 'escalated' relic from the SPPA chase hid Dr Mercy Obanimoh's only live task from
// the GP-list count ("0 tasks") and taught the AI case summary that the signed form "does not
// appear to be on file" while it sat stored and completeness-checked (2026-09-01). Three
// guards: the count sees escalated tasks, the return transition retires the chase's deadline
// and escalation (the weekly overdue sweep had re-escalated 3 days after the return), and the
// candidate-summary prompt carries the state machine's own facts, ranked above everything else.
describe('escalated SPPA relics cannot mislead the list count or the AI summary', () => {
  it('per-case task counts include escalated tasks in BOTH admin list endpoints', () => {
    // The GP-list count (/api/admin/cases) and the /api/admin/gps count. Other queries with
    // this status list are dedupe/existence checks with their own semantics — not pinned here.
    expect(serverSrc).toContain('select=id,case_id,priority,status,due_date&status=in.(open,in_progress,waiting,waiting_on_gp,waiting_on_practice,waiting_on_external,escalated)');
    expect(serverSrc).toContain('select=*&status=in.(open,in_progress,waiting,waiting_on_gp,waiting_on_practice,waiting_on_external,escalated)&order=priority.asc');
  });

  it('the practice-return transition retires the chase deadline and stands escalation down', () => {
    const fn = serverSrc.slice(
      serverSrc.indexOf('async function _applySppaPracticeReturn'),
      serverSrc.indexOf('async function _repairSppaMissingAttachments'),
    );
    expect(fn).toContain("status: 'in_progress'");
    expect(fn).toContain('due_date: new Date(Date.now() + 2 * 86400000)');
    expect(fn).toContain('escalated_reason: null');
    expect(fn).toContain('escalated_at: null');
  });

  it('candidate-summary prompt spells out the SPPA state machine on the task line', () => {
    expect(serverSrc).toContain('function sppaStateFacts(');
    expect(serverSrc).toContain("' — SPPA STATE: ' + tm.sppa_state");
    expect(serverSrc).toContain('completed signed form ON FILE');
    expect(serverSrc).toContain('AI completeness check PASSED');
  });

  it('ties the under_review sppa_00 ops chip to the state line so it cannot read as missing', () => {
    expect(serverSrc).toContain("d.document_key === 'sppa_00' && d.ops_status === 'under_review'");
    expect(serverSrc).toContain('under_review here means awaiting the RSO');
  });

  it('system prompt makes SPPA STATE facts outrank status, emails and old notes', () => {
    expect(serverSrc).toContain('These are authoritative and OUTRANK');
    expect(serverSrc).toContain('never report it as missing, unreceived, or still being chased');
  });

  it('the summary cache write is awaited so the serverless freeze cannot drop it', () => {
    // Fire-and-forget right before sendJson dies with the frozen instance (same class as
    // _maybeRunSppaConflictScan): the client got the fresh summary, the 24h cache kept the
    // stale one.
    const at = serverSrc.indexOf('var handoverPayload = {');
    expect(at).toBeGreaterThan(-1);
    const seg = serverSrc.slice(at, at + 800);
    expect(seg).toContain('var handoverSave = await supabaseDbRequest');
  });
});

// Owner report 2026-08-10: "why is the AI not scanning and giving its suggestions alike to
// the practice pack documents when a gp uploads their document… The AI should also be able to
// match the documents to the correct task automatically by scanning the content."
//
// A GP's own upload is classified by AI and the reviewer sees a verdict. A document the
// PRACTICE emails in got neither — it was attached to whichever task the thread matched and
// left unread. When the practice manager sent the supervisor CV and the position description
// in ONE email, both landed on the Position Description task and were sorted out by hand.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
const lib = require('../lib/practice-doc-classify.js');
const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const adminSrc = readFileSync(new URL('../pages/admin.html', import.meta.url), 'utf8');

const CANDIDATES = [{ key: 'position_description' }, { key: 'supervisor_cv' }];

describe('buildPracticeDocPrompt', () => {
  it('offers the exact outstanding keys and forbids inventing one', () => {
    const { system, text, keys } = lib.buildPracticeDocPrompt(CANDIDATES, { gpName: 'Mercy Obanimoh' });
    expect(keys).toEqual(['position_description', 'supervisor_cv']);
    expect(text).toContain('"position_description"');
    expect(text).toContain('"supervisor_cv"');
    expect(system).toContain('MUST be exactly one of the listed keys');
    expect(system).toContain('Never invent a key');
  });

  it('carries each document\'s real requirement, so the check matches what we asked for', () => {
    const { text } = lib.buildPracticeDocPrompt(CANDIDATES);
    expect(text).toContain('dated and signed by the supervisor');
    expect(text).toContain('practice letterhead and signed by the practice owner');
  });

  // The supervisor CV and the candidate's CV are both "a CV" — the single most likely confusion.
  it('warns that the CV must be the SUPERVISOR\'s, not the doctor being registered', () => {
    const { text } = lib.buildPracticeDocPrompt(CANDIDATES, { gpName: 'Mercy Obanimoh' });
    expect(text).toContain('Mercy Obanimoh');
    expect(text).toContain('A CV belonging to the SUPERVISOR is a supervisor_cv');
  });

  it('tells the model a poor scan is not automatically a failure', () => {
    const { system } = lib.buildPracticeDocPrompt(CANDIDATES);
    expect(system).toContain('That alone is not a failure');
  });

  // Measured on the real documents: without this the model hedged at 62% on the supervisor's
  // CV — under the routing threshold — purely because the CV never says "supervisor".
  it('removes the hedge on a supervisor CV that does not label itself one', () => {
    const { text } = lib.buildPracticeDocPrompt(CANDIDATES, { supervisorName: 'Dr Chamira Ranatunga' });
    expect(text).toContain('Dr Chamira Ranatunga');
    expect(text).toContain('the ONLY CV we ever ask a practice for');
    expect(text).toContain('do not lower your confidence merely because');
  });
});

describe('parsePracticeDocResult', () => {
  const allowed = ['position_description', 'supervisor_cv'];

  it('parses a clean verdict', () => {
    const out = lib.parsePracticeDocResult(JSON.stringify({
      document_key: 'supervisor_cv', confidence: 93, identified_as: "Dr Ranatunga's CV",
      meets_requirement: false, issues: ['no visible signature', 'no date'], summary: 'A CV for the supervising GP.',
    }), allowed);
    expect(out.document_key).toBe('supervisor_cv');
    expect(out.confidence).toBe(93);
    expect(out.meets_requirement).toBe(false);
    expect(out.issues).toEqual(['no visible signature', 'no date']);
  });

  // Routing acts on this value, so a hallucinated key must never survive.
  it('collapses a key we did not offer to "other"', () => {
    const out = lib.parsePracticeDocResult('{"document_key":"medicare_form","confidence":95}', allowed);
    expect(out.document_key).toBe('other');
  });

  it('clamps a nonsense confidence and tolerates fences', () => {
    expect(lib.parsePracticeDocResult('```json\n{"document_key":"supervisor_cv","confidence":900}\n```', allowed).confidence).toBe(100);
    expect(lib.parsePracticeDocResult('{"document_key":"supervisor_cv","confidence":"abc"}', allowed).confidence).toBeNull();
  });

  it('returns null on junk so the caller simply shows no verdict', () => {
    expect(lib.parsePracticeDocResult('', allowed)).toBeNull();
    expect(lib.parsePracticeDocResult('sorry, I cannot', allowed)).toBeNull();
  });

  it('never lets meets_requirement default to true', () => {
    expect(lib.parsePracticeDocResult('{"document_key":"supervisor_cv"}', allowed).meets_requirement).toBe(false);
  });
});

// Fail-safe: the only automatic action is moving a document onto a task that is genuinely
// waiting for exactly that document type, on a confident read.
describe('decideDocumentRouting', () => {
  const siblings = [{ key: 'supervisor_cv', taskId: 'cv-task' }];
  const routeFor = (result) => lib.decideDocumentRouting({ result, matchedKey: 'position_description', siblings });

  it('keeps a document that IS what this task asked for', () => {
    const d = routeFor({ document_key: 'position_description', confidence: 96 });
    expect(d.action).toBe('keep');
  });

  // The exact 2026-08-10 case: the CV arrived on the Position Description thread.
  it('moves a confidently-identified sibling document to the task waiting for it', () => {
    const d = routeFor({ document_key: 'supervisor_cv', confidence: 93 });
    expect(d.action).toBe('move');
    expect(d.targetTaskId).toBe('cv-task');
    expect(d.reason).toContain('Supervisor CV');
  });

  it('refuses to move on a shaky read — suggests instead', () => {
    const d = routeFor({ document_key: 'supervisor_cv', confidence: 55 });
    expect(d.action).toBe('flag');
    expect(d.reason).toContain('too unsure');
  });

  it('refuses to move when confidence is missing entirely', () => {
    expect(routeFor({ document_key: 'supervisor_cv', confidence: null }).action).toBe('flag');
  });

  it('flags something that is none of the outstanding documents', () => {
    const d = routeFor({ document_key: 'other', confidence: 90, identified_as: 'a Medicare form' });
    expect(d.action).toBe('flag');
    expect(d.reason).toContain('Medicare form');
  });

  it('does not move to a task that is not open — no sibling, no move', () => {
    const d = lib.decideDocumentRouting({ result: { document_key: 'supervisor_cv', confidence: 99 }, matchedKey: 'position_description', siblings: [] });
    expect(d.action).toBe('flag');
    expect(d.targetTaskId).toBeNull();
  });

  it('keeps the document when there is no verdict at all', () => {
    expect(lib.decideDocumentRouting({ result: null, matchedKey: 'position_description', siblings }).action).toBe('keep');
  });
});

describe('server wiring', () => {
  it('scans practice documents on arrival, and AWAITS it so a frozen instance cannot drop it', () => {
    expect(serverSrc).toContain('await _scanAndRoutePracticeDocs(earlyTask, earlyGpCase, _earlyStoredDocIds)');
  });

  it('sends the actual file to the model — these scans have no text layer', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function classifyPracticeDocumentWithAI'));
    expect(fn).toContain("type: 'document'");
    expect(fn).toContain("media_type: 'application/pdf'");
    expect(fn).toContain("type: 'image'");
  });

  it('scans deterministically — a re-scan of an unchanged document must not flip its verdict', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function classifyPracticeDocumentWithAI'));
    expect(fn.slice(0, fn.indexOf('async function classifyDocumentWithAI'))).toContain('body.temperature = 0');
  });

  // SUGGEST_REPLY_MODEL is an env var. Opus 4.6 accepts temperature; 4.7/4.8 reject it with a
  // 400, which would otherwise turn every scan into a silent no-verdict after a config change.
  it('survives a model that rejects temperature instead of losing the verdict', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function classifyPracticeDocumentWithAI'));
    const body = fn.slice(0, fn.indexOf('async function classifyDocumentWithAI'));
    expect(body).toContain('if (resp.status === 400)');
    expect(body).toContain('_callScan(false)');
  });

  it('names the supervisor, which is what makes the CV a confident match', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function _scanAndRoutePracticeDocs'));
    expect(fn).toContain('resolvePlacedPracticeContact(gpCase.user_id)');
    expect(fn).toContain('supervisorName: supervisorName');
  });

  it('is limited to ordinary practice-pack documents and gated on key + budget', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function _scanAndRoutePracticeDocs'));
    expect(fn).toContain("if (task.task_type !== 'practice_pack_child') return;");
    expect(fn).toContain("task.related_document_key === 'sppa_00' || task.related_document_key === 'section_g'");
    expect(fn).toContain('if (!ANTHROPIC_API_KEY) return;');
    expect(fn).toContain('checkAnthropicBudget()');
  });

  it('only offers the model documents the practice still owes us', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function _scanAndRoutePracticeDocs'));
    expect(fn).toContain('status=in.(open,in_progress,waiting_on_practice,waiting_on_external)');
  });

  it('a move re-parents the document AND unblocks the receiving task', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function _scanAndRoutePracticeDocs'));
    expect(fn).toContain('task_id: routing.targetTaskId, is_current: true');
    expect(fn).toContain("body: { status: 'open', updated_at:");
    expect(fn).toContain("ops_status: 'completed'");
  });

  it('records verdicts where the dashboards can read them', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function _scanAndRoutePracticeDocs'));
    expect(fn).toContain('meta.practice_doc_scans');
  });
});

// "we dont need a reply email if the document is approved by rso when received by the practice"
describe('no chase-up draft once the task holds the document', () => {
  it('treats the TASK holding a current document as "we have it", not just this email', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function _recordPracticeReplyFollowup'));
    const upTo = fn.slice(0, fn.indexOf('meta.practice_reply = {'));
    expect(upTo).toContain("'select=id&task_id=eq.'");
    expect(upTo).toContain('is_current=eq.true&limit=1');
    expect(upTo).toContain('hasDocument = true');
  });

  it('still short-circuits before drafting when we have the document', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function _recordPracticeReplyFollowup'));
    expect(fn).toContain('if (hasDocument) return meta.practice_reply;');
  });
});

describe('admin wiring', () => {
  it('renders the verdict on the practice document panel', () => {
    expect(adminSrc).toContain('function opsRenderPracticeDocScans');
    expect(adminSrc).toContain('opsRenderPracticeDocScans(task,currentDocs2)');
    expect(adminSrc).toContain('practice_doc_scans');
  });

  it('presents it as a suggestion, not a decision', () => {
    expect(adminSrc).toContain('AI suggestion only; you decide.');
  });
});

// Every OUTBOUND side effect of the career-secured hook must fire at most once per case.
//
// Owner report 2026-08-14 (Resend): Dr Sana Ahsan received "Documents Needed, GP Link"
// three times and "Section G (Supervised Practice Goals) added..." three times, minutes
// apart. Her task_timeline shows "Stage advanced to career/ahpra" and "Section G
// auto-delivered" repeating in the same window.
//
// Cause: `prevSecured` is derived from the state blob in the REQUEST, so a client posting
// a career payload where career_secured flips false->true again (a stale localStorage
// sync is enough) replays the whole `!prevSecured && nextSecured` block. The WhatsApp
// template inside it had always been guarded by _hasDoubleTickBeenSent; the two emails
// beside it had no guard at all, so each replay re-sent them. This is the same replay
// that used to silently complete the practice pack.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'server.js');

let serverJs;
let securedBlock;

beforeAll(() => {
  serverJs = fs.readFileSync(SERVER_PATH, 'utf8');
  // The career-secured block: from the transition test to the end of its stage sweep.
  const start = serverJs.indexOf('if (!prevSecured && nextSecured) {');
  const end = serverJs.indexOf('// ── Document uploads', start);
  expect(start, 'career-secured block not found').toBeGreaterThan(-1);
  expect(end, 'end of career-secured block not found').toBeGreaterThan(start);
  securedBlock = serverJs.slice(start, end);
});

describe('a once-per-case marker helper exists', () => {
  it('defines _hasCaseSystemEvent against task_timeline', () => {
    expect(serverJs).toContain('async function _hasCaseSystemEvent(caseId, title)');
    expect(serverJs).toMatch(/_hasCaseSystemEvent[\s\S]{0,400}task_timeline/);
    expect(serverJs).toMatch(/event_type=eq\.system&title=eq\./);
  });

  it('names both markers as constants so the guard and the log cannot drift', () => {
    expect(serverJs).toContain("const PRACTICE_PACK_EMAIL_MARKER = 'Practice pack email sent to GP'");
    expect(serverJs).toContain("const SECTION_G_DELIVERED_MARKER = 'Section G auto-delivered to MyDocuments and Google Drive'");
  });
});

describe('the practice pack email is sent once', () => {
  it('is wrapped in a marker check', () => {
    expect(securedBlock).toMatch(/if \(!\(await _hasCaseSystemEvent\(caseId, PRACTICE_PACK_EMAIL_MARKER\)\)\)/);
  });

  it('writes the marker BEFORE sending, because the send is fire-and-forget', () => {
    const guardIdx = securedBlock.indexOf('PRACTICE_PACK_EMAIL_MARKER)))');
    const logIdx = securedBlock.indexOf("_logCaseEvent(caseId, null, 'system', PRACTICE_PACK_EMAIL_MARKER");
    const sendIdx = securedBlock.indexOf('sendPracticePackEmail(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(logIdx).toBeGreaterThan(guardIdx);
    expect(sendIdx).toBeGreaterThan(logIdx);
  });

  it('has no unguarded sendPracticePackEmail call left in the block', () => {
    const calls = securedBlock.match(/sendPracticePackEmail\(/g) || [];
    expect(calls.length).toBe(1);
  });
});

describe('Section G is auto-delivered once', () => {
  it('checks the delivered marker before doing any delivery work', () => {
    expect(securedBlock).toContain('_sectionGAlreadyDelivered = await _hasCaseSystemEvent(caseId, SECTION_G_DELIVERED_MARKER)');
    expect(securedBlock).toMatch(/if \(!_sectionGAlreadyDelivered && _fs\.existsSync\(sectionGPath\)\)/);
  });

  it('logs the SAME constant it guards on', () => {
    expect(securedBlock).toContain("_logCaseEvent(caseId, null, 'system', SECTION_G_DELIVERED_MARKER");
    // The old literal must be gone from the log call, or the guard would never match.
    expect(securedBlock).not.toContain("'system', 'Section G auto-delivered to MyDocuments and Google Drive'");
  });
});

describe('the guards that were already correct are still there', () => {
  it('keeps the WhatsApp / AHPRA-unlocked email guard', () => {
    expect(securedBlock).toContain("_hasDoubleTickBeenSent(caseId, 'AHPRA stage')");
    expect(securedBlock).toContain('sendAhpraUnlockedEmail');
  });

  it('keeps practice_pack_child out of the stage sweep', () => {
    expect(securedBlock).toContain('task_type=neq.practice_pack_child');
  });
});

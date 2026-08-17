// A doctor's WhatsApp message must always reach a human.
//
// 2026-08-18, owner: "dr mercy sent a message on doubletick, why is there no task on the
// rso dashboard for it". Two independent silent failures, both confirmed against live
// prod rather than reasoned about:
//
//  1. THE CLASSIFIER DROPPED IT. `classifyDoubleTickMessage` asks a model "is this a
//     question / help request / complaint / confusion?" and a NO ended the request. Her
//     message was "Hi Hazel. I have sent back the SPPA-00 form , signed" - a status
//     update, not a question - so the model answered NO exactly as instructed, and a
//     placed doctor telling her RSO that a signed statutory form was on its way reached
//     nobody. Replayed through the live model on 2026-08-18: NO.
//
//  2. THE STORED COPY WAS ORPHANED. The fallback copy in `doubletick_messages` is read
//     by the case-detail views via `case_id=eq.<id>`, but the phone->user lookup ran
//     `select=id,user_id` on user_profiles, which HAS NO `id` COLUMN. PostgREST 400s the
//     whole query for one unknown column and supabaseDbRequest never throws, so every
//     row in all of prod was written with case_id null. Verified by replaying both
//     queries against prod: with `id` -> 400; without -> her user_id and case resolve.
//
// Together the message existed in exactly one table that nothing could join to her.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let serverJs;
let webhookBody;

beforeAll(() => {
  serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = serverJs.indexOf('async function handleDoubleTickWebhook');
  const end = serverJs.indexOf('\nasync function ', start + 40);
  expect(start, 'handleDoubleTickWebhook not found').toBeGreaterThan(-1);
  webhookBody = serverJs.slice(start, end > start ? end : start + 14000);
});

describe('the classifier may not decide whether a human sees a known doctor', () => {
  it('only ignores a message when the number is NOT a known GP with a case', () => {
    expect(webhookBody).toMatch(/if \(!isHelpRequest && !knownGpCaseId\) \{/);
  });

  it('resolves whether the sender is a known GP BEFORE that gate', () => {
    const resolvedAt = webhookBody.indexOf('knownGpCaseId = dtCaseId');
    const gateAt = webhookBody.indexOf('if (!isHelpRequest && !knownGpCaseId)');
    expect(resolvedAt, 'knownGpCaseId must be assigned').toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(resolvedAt);
  });

  it('marks a known GP\'s non-question message as a message, not a help request', () => {
    expect(webhookBody).toContain("isSocialFromKnownGp ? 'GP message — ' : 'GP requested WhatsApp help — '");
  });

  it('files it low priority so the queue still reads honestly', () => {
    expect(webhookBody).toContain("priority: (activeCase && !isSocialFromKnownGp) ? 'normal' : 'low'");
  });

  it('records WHY this gate exists, so it is not "simplified" back', () => {
    expect(webhookBody).toContain('THE CLASSIFIER MAY NOT DECIDE WHETHER A HUMAN EVER SEES');
  });
});

// The decision rule itself, mirrored. The handler needs a live Supabase to run (the
// storage block is inside `if (isSupabaseDbConfigured())`), so this pins the logic while
// the assertions above pin the wiring.
describe('the rule, as a table', () => {
  function reaches(isHelpRequest, knownGpCaseId) {
    return !(!isHelpRequest && !knownGpCaseId);
  }
  it('a question from anyone reaches a human', () => {
    expect(reaches(true, null)).toBe(true);
    expect(reaches(true, 'case-1')).toBe(true);
  });
  it('a status update from a doctor we know reaches a human', () => {
    // The exact case that failed: "I have sent back the SPPA-00 form, signed".
    expect(reaches(false, 'case-1')).toBe(true);
  });
  it('small talk from an unknown number is still ignored', () => {
    expect(reaches(false, null)).toBe(false);
  });
});

describe('the phone lookup must not 400 the whole query', () => {
  it('does not select a column user_profiles does not have', () => {
    // user_profiles is keyed by user_id; there is NO `id` column. One unknown column
    // 400s the entire PostgREST request, and supabaseDbRequest returns ok:false rather
    // than throwing, so the failure is invisible at the call site.
    const selects = [...serverJs.matchAll(/supabaseDbRequest\(\s*'user_profiles',\s*\n?\s*'select=([^&']+)/g)]
      .map((m) => m[1]);
    expect(selects.length, 'expected some user_profiles selects').toBeGreaterThan(0);
    for (const sel of selects) {
      const cols = sel.split(',').map((c) => c.trim());
      expect(cols, 'user_profiles has no `id` column: ' + sel).not.toContain('id');
    }
  });

  it('still matches on both phone columns, so either spelling resolves', () => {
    expect(webhookBody).toContain('or=(phone.ilike.*');
    expect(webhookBody).toContain('phone_number.ilike.*');
  });

  it('links the stored message to the case it belongs to', () => {
    expect(webhookBody).toMatch(/case_id: dtCaseId/);
    expect(webhookBody).toMatch(/user_id: dtUserId/);
  });
});

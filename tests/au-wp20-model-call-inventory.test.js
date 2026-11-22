// Australian GP build, WP-20: every model call in the app is classified.
//
// This test reads the source. It fails when a call to a model provider exists
// that is not in tests/helpers/au-wp20-model-call-inventory.js, when a listed
// call has gone, or when a provider appears that the scan does not know. That
// is the guard against the next AI feature being written for "an overseas GP"
// by default: adding a call means adding a row and deciding its verdict.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { scanModelCalls } = require('./helpers/au-wp20-model-call-scan.js');
const { INVENTORY, VERDICT, NOT_MODEL_CALLS_HERE } = require('./helpers/au-wp20-model-call-inventory.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const scan = scanModelCalls(ROOT);

describe('WP-20: the model-call inventory', () => {
  it('finds the calls (a scan that finds nothing proves nothing)', () => {
    expect(scan.calls.length).toBeGreaterThanOrEqual(50);
    expect(scan.calls.some((c) => c.key === 'server.js#/api/admin/candidate-summary')).toBe(true);
    expect(scan.calls.some((c) => c.key === 'server.js#createCareerRoleAiProfile')).toBe(true);   // the OpenAI one
    expect(scan.calls.some((c) => c.key === 'lib/ads-review.js#callClaude')).toBe(true);          // the indirect one
  });

  it('every model call in server.js and lib/ is in the inventory, with the same number of calls', () => {
    const listed = {};
    INVENTORY.forEach((row) => { listed[row.key] = row.calls; });
    const unlisted = Object.keys(scan.counts).filter((k) => !(k in listed));
    expect(unlisted, 'A model call was added without being classified. Add a row to tests/helpers/au-wp20-model-call-inventory.js '
      + '(and an Australian branch if the prompt describes a doctor\'s journey or its answer reaches a doctor or a practice): ' + unlisted.join(', ')).toEqual([]);
    const gone = Object.keys(listed).filter((k) => !(k in scan.counts));
    expect(gone, 'A listed model call no longer exists (renamed or removed). Update the inventory: ' + gone.join(', ')).toEqual([]);
    Object.keys(listed).forEach((k) => { expect(scan.counts[k], k + ': number of provider requests').toBe(listed[k]); });
  });

  it('no provider or SDK the scan does not understand has appeared', () => {
    expect(scan.unknown, JSON.stringify(scan.unknown)).toEqual([]);
    // a second, cruder count: every provider URL in the two places calls live is accounted for
    const urlLines = ['server.js'].concat(fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => /\.js$/.test(f)).map((f) => 'lib/' + f))
      .reduce((n, file) => n + read(file).split('\n').filter((line) =>
        /fetch(Impl)?\(\s*['"`]https:\/\/api\.(anthropic|openai)\.com\/v1\/(messages|responses|chat)/.test(line)
        || /fetch\(\s*ANTHROPIC_MESSAGES_URL/.test(line) || /doFetch\(\s*o\.url \|\| MESSAGES_URL/.test(line)).length, 0);
    expect(urlLines).toBe(scan.calls.length);
  });

  it('every row is complete and uses a known verdict; keys are unique', () => {
    const verdicts = Object.keys(VERDICT).map((k) => VERDICT[k]);
    const seen = {};
    INVENTORY.forEach((row) => {
      expect(seen[row.key], row.key + ' listed twice').toBeUndefined();
      seen[row.key] = true;
      expect(verdicts, row.key).toContain(row.verdict);
      for (const field of ['purpose', 'audience', 'note']) expect(String(row[field] || '').length, row.key + '.' + field).toBeGreaterThanOrEqual(5);
      expect(row.calls, row.key).toBeGreaterThan(0);
    });
    NOT_MODEL_CALLS_HERE.forEach((row) => { expect(verdicts).toContain(row.verdict); expect(row.note.length).toBeGreaterThan(5); });
  });

  it('every row of the report\'s "AI prompts needing an Australian branch" table is answered (COM-36)', () => {
    const byKey = {};
    INVENTORY.forEach((row) => { byKey[row.key] = row; });
    const TABLE = [
      ['Match reasons shown to GPs', ['lib/ai-candidate-job-match.js#_callAnthropicRanking']],
      ['Job-board practice profile', ['server.js#createCareerRoleAiProfile']],
      ['Staff reply drafts', ['server.js#/api/admin/email-triage/suggest-reply']],
      ['Candidate summary', ['server.js#/api/admin/candidate-summary']],
      ['Zoom call reason', ['server.js#/api/admin/calls/suggest-reason']],
      ['Document verification', ['server.js#verifyQualificationDocument', 'server.js#verifyAuDocument']],
      ['Practice chase drafts', ['server.js#/api/admin/practice-nudge/draft', 'server.js#_buildPracticeReplyDraft', 'lib/ai-matching.js#aiMatchEmail']],
      ['Migration agent emails', ['server.js#_buildMigrationAgentReplyDraft', 'server.js#_draftMigrationAgentNudge']],
      ['Inbound triage', ['lib/email-triage.js#triageEmailWithSonnet']]
    ];
    TABLE.forEach(([name, keys]) => keys.forEach((k) => {
      expect(byKey[k], name + ': ' + k).toBeTruthy();
      expect([VERDICT.AU_BRANCH, VERDICT.AU_EARLIER], name + ': ' + k).toContain(byKey[k].verdict);
    }));
    // the two rows that are another package's
    // WP-24 took this over: the ads call now has an Australian branch (was OUT_OF_SCOPE until then).
    expect(byKey['lib/ads-review.js#callClaude'].verdict).toBe(VERDICT.AU_BRANCH);
    expect(NOT_MODEL_CALLS_HERE.some((r) => /Hazel/.test(r.what) && r.verdict === VERDICT.OUT_OF_SCOPE)).toBe(true);   // WP-19
    // and the WP-24 draft exists for them to wire
    expect(read('docs/au-gp/ads-au-house-context.md')).toMatch(/DRAFT/);
  });

  it('every prompt marked "Australian branch added" takes its description of the doctor from the one context module', () => {
    const server = read('server.js');
    // the server builds the context in one function, and each branch asks it
    expect(server.match(/await auAiContextFor\(/g).length).toBeGreaterThanOrEqual(5);
    for (const lib of ['lib/suggest-reply-prompt.js', 'lib/practice-nudge-draft.js', 'lib/practice-reply-followup.js']) {
      expect(read(lib), lib).toMatch(/require\('\.\/au-ai-context\.js'\)/);
    }
    // the overseas premise is written in exactly the places it always was (nobody copied it into a new prompt)
    const premise = /overseas GPs register/g;
    const where = ['server.js', 'lib/suggest-reply-prompt.js', 'lib/practice-nudge-draft.js', 'lib/practice-reply-followup.js', 'lib/ai-matching.js']
      .map((f) => [f, (read(f).match(premise) || []).length]);
    // (server.js: the summary prompt itself, and one comment that quotes it; suggest-reply: the prompt and one comment)
    expect(where).toEqual([['server.js', 2], ['lib/suggest-reply-prompt.js', 2], ['lib/practice-nudge-draft.js', 1], ['lib/practice-reply-followup.js', 1], ['lib/ai-matching.js', 1]]);
  });

  it('the things that are NOT model calls here really are not: the Overview brief and the review queue make no provider request', () => {
    for (const lib of ['lib/ceo-overview.js', 'lib/ceo-review-queue.js']) {
      expect(read(lib), lib).not.toMatch(/api\.anthropic\.com|api\.openai\.com|ANTHROPIC_API_KEY|OPENAI_API_KEY/);
    }
  });

  it('the identity-document check has no overseas premise (an Australian licence or passport is read the same way)', () => {
    const server = read('server.js');
    const start = server.indexOf('const idSystemPrompt = `');
    const prompt = server.slice(start, server.indexOf('`;', start));
    expect(prompt.length).toBeGreaterThan(500);
    expect(prompt).toMatch(/passport or driver's licence/);
    expect(prompt).not.toMatch(/overseas|international|United Kingdom|\bUK\b|Ireland|New Zealand|GMC|visa/i);
  });

  it('Hazel and the ads prompts were not touched by this package', () => {
    // (compared with the commit this package started from, by content the package must not have added)
    for (const f of ['config/retell/hazel-prompt.md', 'config/retell/hazel-prompt-au.md', 'lib/lead-calls.js', 'lib/ads-review.js', 'lib/ads-context.js']) {
      expect(read(f), f).not.toMatch(/WP-20|au-ai-context/);
    }
  });
});

// Owner 2026-09-14: re-testing with the recreated smithmiller1234@gmail.com
// account — "let him skip any uploads he may have to do including identity
// verification (only for onboarding)". The mechanism already existed
// (js/bypass-config.js TEMPORARY_IDENTITY_OPTIONAL_DIGESTS + the localhost
// rule); this pins it and the copy that tells the tester they can Submit.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('onboarding identity step is optional for the listed tester', () => {
  it('the tester digest is Smith Miller\'s address and has not expired', () => {
    const cfg = read('js/bypass-config.js');
    const digest = crypto.createHash('sha256').update('smithmiller1234@gmail.com').digest('hex');
    const m = cfg.match(new RegExp('"' + digest + '":\\s*"([^"]+)"'));
    expect(m).toBeTruthy();
    expect(Date.parse(m[1])).toBeGreaterThan(Date.parse('2026-09-14T00:00:00Z'));
  });
  it('the step submits without an ID for the tester (and on localhost), and the copy says so without calling the live app "local testing"', () => {
    const js = read('js/onboarding.js');
    expect(js).toContain('if (identityStepOptionalForTester()) {\n          hideError("docsError");\n          return true;');
    expect(js).toContain('function isLocalDevHost() {');
    expect(js).toContain('var idOptionalWhy = isLocalDevHost() ? "in local testing" : "for this test account";');
    expect(js).toContain("press <b>Submit</b> to continue without uploading anything");
    // skipping never flags the account for review — only scan outcomes do
    expect(js).not.toMatch(/identityStepOptionalForTester\(\)[\s\S]{0,200}accountReviewFlag = true/);
  });
  it('the server passes any picked photo for the test account and busters moved', () => {
    const s = read('server.js');
    expect(s).toContain("? 'smithmiller1234@gmail.com'\n      : process.env.ID_CHECK_BYPASS_EMAILS)");
    expect(read('pages/onboarding.html')).toContain('onboarding.js?v=20260914a');
    expect(read('sw.js')).toContain('var VERSION = "20260915c"');
  });
});

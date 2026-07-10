import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('walkthrough QA gate (Helen-only, every login)', () => {
  it('server exposes /api/walkthrough-config gated on the test allowlist', () => {
    const src = read('server.js');
    expect(src).toContain("pathname === '/api/walkthrough-config'");
    expect(src).toContain('WALKTHROUGH_TEST_EMAILS');
    expect(src).toContain('helenwazalski@gmail.com');
    // the allowlist is consulted with the session email
    expect(src).toMatch(/WALKTHROUGH_TEST_EMAILS\.indexOf\(/);
  });

  it('client gate helper asks the server and exposes gpWalkthroughGate.enabled', () => {
    const src = read('js/gp-walkthrough-gate.js');
    expect(src).toContain('window.gpWalkthroughGate');
    expect(src).toContain('/api/walkthrough-config');
    expect(src).toMatch(/enabled\s*:/);
  });

  it('all three controllers gate on gpWalkthroughGate.enabled()', () => {
    for (const f of ['js/gp-walkthrough-shell.js', 'js/gp-walkthrough.js', 'js/qualification-scan.js']) {
      expect(read(f), f).toContain('gpWalkthroughGate');
    }
  });

  it('every page that runs the walkthrough loads the gate script', () => {
    for (const p of ['app-shell.html', 'index.html', 'career.html', 'messages.html', 'account.html', 'ahpra.html', 'my-documents.html']) {
      expect(read(path.join('pages', p)), p).toMatch(/gp-walkthrough-gate\.js\?v=/);
    }
  });
});

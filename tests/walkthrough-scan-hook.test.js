import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('scan modal triggers a first-visit Scan mini-tour', () => {
  it('qualification-scan.js references the scan-area walkthrough hook', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'js', 'qualification-scan.js'), 'utf8');
    expect(src).toContain('gpWalkthroughGate');
    expect(src).toMatch(/maybeScanTour|'scan'|"scan"/);
  });
});

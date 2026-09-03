import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('account has a replay-the-tour row', () => {
  it('renders a [data-walkthrough-replay] control', () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'pages', 'account.html'), 'utf8');
    expect(html).toContain('data-walkthrough-replay');
    expect(html).toMatch(/Replay the app tour|Show me around again/i);
  });
});

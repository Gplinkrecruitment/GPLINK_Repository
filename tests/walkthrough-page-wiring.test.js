import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), 'pages', p), 'utf8');
const PAGES = ['index.html', 'career.html', 'messages.html', 'account.html'];

describe('content pages load the walkthrough scripts', () => {
  for (const p of PAGES) {
    it(`${p} includes gp-coach, gp-walkthrough-state and gp-walkthrough`, () => {
      const html = read(p);
      expect(html).toMatch(/\/js\/gp-coach\.js\?v=/);
      expect(html).toMatch(/\/js\/gp-walkthrough-state\.js\?v=/);
      expect(html).toMatch(/\/js\/gp-walkthrough\.js\?v=/);
    });

    it(`${p} loads the walkthrough scripts in dependency order`, () => {
      const html = read(p);
      const iStateSync = html.indexOf('state-sync.js');
      const iCoach = html.indexOf('gp-coach.js');
      const iState = html.indexOf('gp-walkthrough-state.js');
      const iWalkthrough = html.indexOf('gp-walkthrough.js');
      expect(iStateSync).toBeGreaterThan(-1);
      expect(iCoach).toBeGreaterThan(-1);
      expect(iState).toBeGreaterThan(-1);
      expect(iWalkthrough).toBeGreaterThan(-1);
      expect(iStateSync).toBeLessThan(iCoach);
      expect(iCoach).toBeLessThan(iState);
      expect(iState).toBeLessThan(iWalkthrough);
    });
  }
});

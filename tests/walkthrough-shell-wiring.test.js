import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('shell wiring', () => {
  it('app-shell.html loads state-sync, coach, state and the shell controller', () => {
    const html = read('pages/app-shell.html');
    expect(html).toMatch(/\/js\/state-sync\.js\?v=/);
    expect(html).toMatch(/\/js\/gp-coach\.js\?v=/);
    expect(html).toMatch(/\/js\/gp-walkthrough-state\.js\?v=/);
    expect(html).toMatch(/\/js\/gp-walkthrough-shell\.js\?v=/);
  });
  it('app-shell.js dispatches gp-shell-frame-loaded and handles gp-shell-run-tour', () => {
    const js = read('js/app-shell.js');
    expect(js).toContain('gp-shell-frame-loaded');
    expect(js).toContain('gp-shell-run-tour');
  });
});

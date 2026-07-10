import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('gp_walkthrough_state is registered on both sides', () => {
  it('client STATE_KEYS in js/state-sync.js', () => {
    const src = read('js/state-sync.js');
    const block = src.slice(src.indexOf('STATE_KEYS'), src.indexOf('STATE_KEYS') + 900);
    expect(block).toContain("'gp_walkthrough_state'");
  });
  it('server USER_STATE_KEYS in server.js', () => {
    const src = read('server.js');
    const block = src.slice(src.indexOf('USER_STATE_KEYS'), src.indexOf('USER_STATE_KEYS') + 900);
    expect(block).toContain("'gp_walkthrough_state'");
  });
});

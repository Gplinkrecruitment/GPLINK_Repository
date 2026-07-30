import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

// A key must appear in BOTH lists or it is silently dropped on the way to the
// server — the doctor's flag then lives only in that one browser's
// localStorage, which looks like it works until they open the app anywhere else.
//
// These used to slice a fixed 900 characters from the start of each array,
// which quietly stopped covering the tail of the list as keys and comments were
// added — a key could fall out of the window and the guard would fail for a
// reason that has nothing to do with what it is guarding. Slice to the real end
// of the array instead.
function keyBlock(src, name) {
  const start = src.indexOf(name + ' = [');
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const end = src.indexOf('];', start);
  expect(end, `${name} array not terminated`).toBeGreaterThan(start);
  return src.slice(start, end);
}

const SYNCED_KEYS = [
  'gp_walkthrough_state',
  // First-visit careers explainer (the process + the 2-live / 3-a-month rules).
  'gp_career_intro_seen'
];

describe('GP state keys are registered on both sides', () => {
  it('client STATE_KEYS in js/state-sync.js', () => {
    const block = keyBlock(read('js/state-sync.js'), 'STATE_KEYS');
    for (const key of SYNCED_KEYS) expect(block).toContain(`'${key}'`);
  });

  it('server USER_STATE_KEYS in server.js', () => {
    const block = keyBlock(read('server.js'), 'USER_STATE_KEYS');
    for (const key of SYNCED_KEYS) expect(block).toContain(`'${key}'`);
  });
});

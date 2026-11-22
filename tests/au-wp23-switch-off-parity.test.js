// Australian GP build, WP-23: with the switch OFF the practice front door is
// exactly what it is on main. The snapshot was written by
// tests/helpers/au-wp23-parity.js on the tree BEFORE WP-23 changed anything.
// Never regenerate it to make this pass (WP23_WRITE_SNAPSHOT exists only so
// the first run could record it).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const { bootLeadCopyServer } = require('./helpers/au-wp16-harness.js');
const parity = require('./helpers/au-wp23-parity.js');

const SNAPSHOT = path.join(__dirname, 'fixtures', 'au-wp23-switch-off.snapshot.json');
let h;

beforeAll(async () => {
  h = await bootLeadCopyServer({ name: 'wp23-parity', mode: 'supabase', tables: parity.parityTables(), emulator: parity.PARITY_EMULATOR, env: parity.PARITY_ENV });
  h.setSwitch(false);
});
afterAll(async () => { if (h) await h.closeAll(); });

describe('WP-23 switch off: lead form, webhook, intake, agreement, pending job, approval, public board', () => {
  it('is exactly what it was before WP-23', async () => {
    h.setSwitch(false);
    const got = await parity.computePracticeParity(h);
    if (process.env.WP23_WRITE_SNAPSHOT === '1' && !fs.existsSync(SNAPSHOT)) {
      fs.writeFileSync(SNAPSHOT, JSON.stringify(got, null, 2) + '\n');
    }
    const want = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    // sanity: the walk really did reach the end
    expect(got.sign.status).toBe(200);
    expect(got.approve.status).toBe(200);
    expect(got.sign.job).toBeTruthy();
    expect(got).toEqual(want);
  }, 60000);
});

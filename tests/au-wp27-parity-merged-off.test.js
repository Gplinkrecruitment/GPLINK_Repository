// WP-27 (Australian GP build): every metric endpoint, the weekly owner digest,
// the gone-quiet email, the review queue and the gone-quiet list, for one
// database and one switch position (KEY below).
//
// tests/fixtures/au-wp27-parity.<KEY>.snapshot.json was written by this file
// BEFORE WP-27 changed any code (WP27_WRITE_SNAPSHOT=1). Never regenerate it
// to make the test pass.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootLeadCopyServer } = require('./helpers/au-wp16-harness.js');
const fx = require('./helpers/au-wp27-fixtures.js');
const parity = require('./helpers/au-wp27-parity.js');

// KEY: the overseas + Australian database, switch off.
const KEY = 'merged-off';
const DATABASE = 'merged';
const SWITCH_ON = false;
let h;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: fx.NOW_MS });
  const tables = DATABASE === 'merged' ? fx.merged(fx.overseasTables(), fx.auTables()) : fx.overseasTables();
  h = await bootLeadCopyServer({ name: 'wp27-' + KEY, mode: 'supabase', tables, env: { GP_OWNER_EMAIL: 'owner.test@gplink-test.local' } });
  h.setSwitch(SWITCH_ON);
}, 60000);

afterAll(async () => {
  if (h) await h.closeAll();
  vi.useRealTimers();
});

describe('WP-27 parity: ' + KEY, () => {
  // Takes about 6 seconds alone: it calls every metric endpoint once.
  it('answers exactly what it answered before WP-27', { timeout: 90000 }, async () => {
    const got = await parity.captureAll(h);
    if (process.env.WP27_WRITE_SNAPSHOT === '1') { parity.writeSnapshot(KEY, got); return; }
    const want = parity.comparable(parity.readSnapshot(KEY));
    const mine = parity.comparable(got);
    Object.keys(want.endpoints).forEach((name) => { expect(mine.endpoints[name], 'endpoint ' + name).toEqual(want.endpoints[name]); });
    Object.keys(want.csv).forEach((name) => { expect(mine.csv[name], 'export ' + name).toEqual(want.csv[name]); });
    Object.keys(want.staff).forEach((name) => { expect(mine.staff[name], 'staff ' + name).toEqual(want.staff[name]); });
    expect(mine.digest).toEqual(want.digest);
    expect(mine.stalled).toEqual(want.stalled);
  });
});

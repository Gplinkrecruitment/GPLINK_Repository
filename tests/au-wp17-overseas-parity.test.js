// WP-17 overseas parity: every existing message this package's code touches
// reaches a UK, Irish or New Zealand doctor (nothing recorded on their profile)
// byte for byte as it did before WP-17, with the Australian switch ON and OFF.
//
// The snapshot was written on the tree before WP-17 changed any behaviour.
// NEVER regenerate it to make this test pass: a difference here means an
// overseas doctor's message changed. (WP17_WRITE_PARITY=1 exists only so the
// file could be created once.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { bootLeadCopyServer } = require('./helpers/au-wp16-harness.js');
const { overseasTables, computeServerParity } = require('./helpers/au-wp17-parity.js');
const { PRODUCTION_UNIQUE_RULES } = require('./helpers/au-supabase-emulator.js');

const SNAPSHOT = path.join(__dirname, 'fixtures', 'au-wp17-overseas-parity.snapshot.json');

function reseed(h) {
  const fresh = overseasTables(Date.now());
  Object.keys(h.emu.db).forEach((t) => { if (t !== 'rso_team') delete h.emu.db[t]; });
  Object.keys(fresh).forEach((t) => { h.emu.db[t] = JSON.parse(JSON.stringify(fresh[t])); });
}

describe('WP-17: overseas messages are byte-identical', () => {
  let on = null;
  let off = null;
  let h = null;
  beforeAll(async () => {
    h = await bootLeadCopyServer({
      name: 'wp17-parity', mode: 'supabase', tables: overseasTables(Date.now()),
      emulator: { unique: PRODUCTION_UNIQUE_RULES },
      env: { OWNER_NOTIFY_EMAIL: 'owner@gplink-test.local' }
    });
    h.setSwitch(false);
    off = await computeServerParity(h);
    reseed(h);
    h.setSwitch(true);
    on = await computeServerParity(h);
    if (process.env.WP17_WRITE_PARITY === '1') fs.writeFileSync(SNAPSHOT, JSON.stringify(off, null, 2) + '\n');
  }, 120000);
  afterAll(async () => { if (h) await h.closeAll(); });

  it('the capture is not empty (every sender really sent)', () => {
    for (const key of ['uk', 'ie', 'nz']) {
      const p = off.people[key];
      expect(p.welcome.emails.length).toBe(1);
      expect(p.profileComplete.emails.length).toBe(1);
      expect(p.onboardingNudges.every((n) => n.emails.length === 1)).toBe(true);
      expect(p.stalled.myintealth.emails.length).toBe(1);
      expect(p.stalledPosition.emails.length).toBe(1);
      expect(p.documentApproved.emails.length).toBe(1);
      expect(p.documentRevision.emails.length).toBe(1);
      expect(p.applicationCold.emails.length).toBeGreaterThanOrEqual(1);
      expect(p.applicationMatched.emails.length).toBeGreaterThanOrEqual(1);
      expect(p.staffNudge.result.status).toBe(200);
      expect(p.staffNudge.emails.length).toBe(1);
    }
    expect(off.onboardingCron.emails.length).toBe(3);
    expect(off.ownerDigest.emails.length).toBe(1);
    expect(off.emailTemplates.status).toBe(200);
  });

  it('switch OFF: identical to the snapshot taken before WP-17', () => {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    expect(off).toEqual(snap);
  });

  it('switch ON, nothing recorded on the doctor: identical to the same snapshot', () => {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    expect(on).toEqual(snap);
  });
});

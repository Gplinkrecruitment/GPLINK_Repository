// FR-7 (final review S7-03; round 1's S-15): a held placement is released
// ONCE, whoever asks and however many ask at the same moment.
//
// The old guard was "clear the key, then run": two state syncs that both
// carried the hold each found it, each cleared it and each ran the steps
// (duplicate "placement secured" / "Documents Needed" / "Section G added"
// emails and duplicate SPPA-00, Section G, Position Description and
// Supervisor CV tasks); and a sync that had read the state before the other
// cleared it wrote the key back, so the hold was released again later.
// The release is now a claim in the once-ever ledger (gp_nudge_log, unique on
// user + key + channel), keyed on the hold's own timestamp.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootPlacementRig } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');
const { PRODUCTION_UNIQUE_RULES } = require('./helpers/au-supabase-emulator.js');

let rig;
let t;
let seq = 0;
const packKeys = (cap) => cap.tasks.filter((x) => x.task_type === 'practice_pack_child').map((x) => x.related_document_key).sort();
const subjects = (list) => list.map((e) => e.subject).sort();
const FULL_PACK = ['offer_contract', 'position_description', 'section_g', 'sppa_00', 'supervisor_cv'];
const OVERSEAS_EMAILS = ['AHPRA Registration Unlocked, GP Link', 'Documents Needed, GP Link',
  'Section G (Supervised Practice Goals) added to your documents, GP Link', 'Your placement is secured 🎉, GP Link'].sort();
const failPathwayRead = () => rig.emu.forbid((r) => (r.table === 'user_profiles' && r.method === 'GET' && (r.select || []).indexOf('candidate_pathway') !== -1 ? 'pathway read forced to fail' : ''));
const sync = (d) => rig.put('/api/state', { state: { gp_career_intro_seen: true }, updatedAt: new Date().toISOString() }, { cookie: rig.gpCookie(d.email, d.userId) });
const released = (d) => rig.capture(d).timeline.filter((x) => x.title === 'Held placement steps released').length;

function overseasDoctor() {
  seq += 1;
  const d = buildAuDoctor('overseas_null', {
    idSuffix: String(7700 + seq), profile: { phone: '+447700922' + String(100 + seq) }, caseRow: { stage: 'career' },
    state: { gp_epic_progress: { stage: 'verification_issued', completed: { verification_issued: true } }, gp_amc_progress: { completed: { qualifications_verified: true } }, gp_career_state: { career_secured: false, applications: [] } }
  });
  rig.addDoctor(d);
  return d;
}

beforeAll(async () => {
  rig = await bootPlacementRig({
    name: 'fr7-hold',
    env: { LAUNCH_DEFAULT_RSO_EMAIL: 'rso.test@gplink-test.local' },
    emulator: { defaults: { registration_tasks: { status: 'open' }, placements: { status: 'active' } }, unique: PRODUCTION_UNIQUE_RULES }
  });
  t = rig.testUtils;
}, 60000);
afterAll(async () => { if (rig) await rig.close(); });
beforeEach(() => {
  rig.setSwitch(true);
  rig.emu.forbid(null);
  rig.emu.failTables = {};
  rig.resetRecorders();
});

describe('S7-03: a held placement is released once', () => {
  it('two state syncs at the same moment (the shell and a frame): one release, one set of emails, one set of tasks', async () => {
    const d = overseasDoctor();
    failPathwayRead();
    expect((await rig.place(d, 'ats_placement')).status).toBe(200);
    const hold = rig.stateOf(d)[t.AU_PLACEMENT_HOLD_KEY];
    expect(hold && hold.at).toBeTruthy();
    expect(packKeys(rig.capture(d))).toEqual(['offer_contract']);

    rig.emu.forbid(null);
    await Promise.all([sync(d), sync(d), sync(d)]);
    await rig.settle(900);
    const cap = rig.capture(d);
    expect(released(d)).toBe(1);
    expect(packKeys(cap)).toEqual(FULL_PACK);
    expect(subjects(cap.emailsToDoctor)).toEqual(OVERSEAS_EMAILS);
    expect(cap.emailsToPractice.map((e) => e.subject)).toEqual(['Placement confirmed, ' + d.name]);
    expect(cap.whatsapps.length).toBe(1);
    // the claim is on record, keyed on the hold's own timestamp
    expect(rig.table('gp_nudge_log').filter((r) => r.user_id === d.userId && r.channel === 'placement_hold').map((r) => r.nudge_key))
      .toEqual(['au_placement_hold_release:' + hold.at]);
  });

  it('two direct releases in the same tick: exactly one caller is told it released', async () => {
    const d = overseasDoctor();
    failPathwayRead();
    await rig.place(d, 'ats_placement');
    const hold = rig.stateOf(d)[t.AU_PLACEMENT_HOLD_KEY];
    rig.emu.forbid(null);
    rig.resetRecorders();
    const results = await Promise.all([t.auReleasePlacementHold(d.userId, hold), t.auReleasePlacementHold(d.userId, hold)]);
    await rig.settle(600);
    expect(results.filter((r) => r.released === true).length).toBe(1);
    expect(results.filter((r) => r.released === false).map((r) => r.reason)).toEqual(['already_released']);
    expect(released(d)).toBe(1);
    expect(packKeys(rig.capture(d))).toEqual(FULL_PACK);
    expect(rig.stateOf(d)[t.AU_PLACEMENT_HOLD_KEY]).toBeUndefined();
  });

  it('a sync that read the state before the release writes the key back: the stale key is dropped and nothing runs again', async () => {
    const d = overseasDoctor();
    failPathwayRead();
    await rig.place(d, 'ats_placement');
    const hold = rig.stateOf(d)[t.AU_PLACEMENT_HOLD_KEY];
    rig.emu.forbid(null);
    await sync(d);
    await rig.settle(600);
    expect(released(d)).toBe(1);
    const before = rig.capture(d);

    // the late write: the same hold is back on the stored state
    rig.stateOf(d)[t.AU_PLACEMENT_HOLD_KEY] = hold;
    rig.resetRecorders();
    await sync(d);
    await rig.settle(600);
    const after = rig.capture(d);
    expect(released(d)).toBe(1);
    expect(after.emailsToDoctor).toEqual([]);
    expect(after.emailsToPractice).toEqual([]);
    expect(after.whatsapps).toEqual([]);
    expect(after.tasks.length).toBe(before.tasks.length);
    expect(rig.stateOf(d)[t.AU_PLACEMENT_HOLD_KEY]).toBeUndefined();
    // and the daily pass finds nothing to release either
    rig.stateOf(d)[t.AU_PLACEMENT_HOLD_KEY] = hold;
    const sweep = await t.runAuPrestartSweep({});
    expect(sweep.released).toBe(0);
    expect(released(d)).toBe(1);
  });

  it('a ledger that cannot be written: nothing runs and the hold stays for the next attempt, which then releases once', async () => {
    const d = overseasDoctor();
    failPathwayRead();
    await rig.place(d, 'ats_placement');
    const hold = rig.stateOf(d)[t.AU_PLACEMENT_HOLD_KEY];
    rig.emu.forbid((r) => (r.table === 'gp_nudge_log' ? 'ledger down' : ''));
    const res = await t.auReleasePlacementHold(d.userId, hold);
    expect(res).toMatchObject({ released: false, reason: 'claim_failed' });
    expect(rig.stateOf(d)[t.AU_PLACEMENT_HOLD_KEY]).toBeTruthy();
    expect(packKeys(rig.capture(d))).toEqual(['offer_contract']);
    rig.emu.forbid(null);
    await sync(d);
    await rig.settle(600);
    expect(released(d)).toBe(1);
    expect(packKeys(rig.capture(d))).toEqual(FULL_PACK);
  });

  it('a later hold (another placement) has its own claim: it is not swallowed by the first', async () => {
    const d = overseasDoctor();
    failPathwayRead();
    await rig.place(d, 'ats_placement');
    const first = rig.stateOf(d)[t.AU_PLACEMENT_HOLD_KEY];
    rig.emu.forbid(null);
    expect((await t.auReleasePlacementHold(d.userId, first)).released).toBe(true);
    const second = Object.assign({}, first, { at: new Date(Date.parse(first.at) + 60000).toISOString() });
    rig.stateOf(d)[t.AU_PLACEMENT_HOLD_KEY] = second;
    expect((await t.auReleasePlacementHold(d.userId, second)).released).toBe(true);
  });

  it('switch off: no release, and the ledger is not asked', async () => {
    const d = overseasDoctor();
    rig.setSwitch(false);
    const before = rig.emu.requests.length;
    const res = await t.auReleasePlacementHold(d.userId, { at: '2026-11-25T00:00:00.000Z' });
    expect(res).toMatchObject({ released: false, reason: 'feature_off' });
    expect(rig.emu.requests.length).toBe(before);
  });

  it('an overseas doctor whose pathway read never failed has no hold and no claim (nothing changes for them)', async () => {
    const d = overseasDoctor();
    expect((await rig.place(d, 'ats_placement')).status).toBe(200);
    await rig.settle(400);
    expect(rig.stateOf(d)[t.AU_PLACEMENT_HOLD_KEY]).toBeUndefined();
    expect(rig.table('gp_nudge_log').filter((r) => r.user_id === d.userId && r.channel === 'placement_hold')).toEqual([]);
    expect(packKeys(rig.capture(d))).toEqual(FULL_PACK);
  });
});

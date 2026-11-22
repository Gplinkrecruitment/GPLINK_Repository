// The daily Australian lifecycle job has a REQUEST BUDGET.
//
// In production every database request is a real round trip to another region
// (about a quarter of a second from Australia), and the job runs inside a
// serverless time limit. A sweep that makes N more sequential reads per doctor
// is a real cost. This file pins, for a fixed set of doctors (one Australian
// doctor at each stage and two overseas doctors):
//   - how many requests one quiet run of the job makes (nothing left to send);
//   - that the WP-17 message pass costs a fixed handful of reads per RUN and
//     nothing per doctor when nothing is owed;
//   - that an overseas case costs the message pass NOTHING: adding overseas
//     doctors does not add one request.
// If you add a read to the daily job, batch it per run (one read for all the
// doctors) or this fails. Do not raise a number here without measuring why.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootPlacementRig } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');
const { PRODUCTION_UNIQUE_RULES } = require('./helpers/au-supabase-emulator.js');

// What the WP-17 message pass may cost on a run with nothing to send: the
// pathway index (2 reads) and one batched read each of the cases, the
// placements, the pre-start tasks, what the doctors recorded, and the ledger.
const MESSAGE_PASS_QUIET_BUDGET = 7;
// One quiet run of the whole daily job over the fixture set (measured: see the
// test's log line).
// LOWERED by FB-2a (walk-findings R16) from 145 to 35. The two passes that
// still read per doctor were batched the way the message pass was: WP-11's
// pre-start pass (about 23 reads per pre-start doctor per run) and WP-13's
// lifecycle pass (per pre-start case and per commenced placement). Measured on
// this fixture: 142 requests before, 35 after; and it no longer grows with the
// number of doctors (the test below adds three pre-start doctors: 35 before
// and after, where it used to go from 73 to 142).
const DAILY_JOB_QUIET_BUDGET = 35;

let rig, t, w;
let seq = 0;
const DAY = 86400000;
const today = (hourUtc) => { const d = new Date(); d.setUTCHours(hourUtc, 0, 0, 0); return d.getTime(); };
const IN_HOURS = today(2);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function doctor(kind, overrides) {
  seq += 1;
  const o = overrides || {};
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: String(5000 + seq) }, o, {
    profile: Object.assign({ last_name: 'Bud' + String(5000 + seq), phone: '+614005' + String(10000 + seq), phone_number: '4005' + String(10000 + seq), country_dial: '+61', current_state: 'NSW' }, o.profile || {})
  }));
  rig.addDoctor(d, o.extra);
  return d;
}
async function counted(fn) {
  rig.emu.reset();
  const result = await fn();
  return { result, requests: rig.emu.requests.slice() };
}
const mentions = (requests, ids) => requests.filter((r) => {
  const hay = String(r.query || '') + ' ' + JSON.stringify(r.body || '');
  return ids.some((id) => hay.indexOf(id) !== -1);
});
const byTable = (requests) => { const m = {}; requests.forEach((r) => { m[r.table] = (m[r.table] || 0) + 1; }); return m; };

let au = {};
let overseas = [];

beforeAll(async () => {
  rig = await bootPlacementRig({
    name: 'wp17-budget',
    env: { LAUNCH_DEFAULT_RSO_EMAIL: 'rso.test@gplink-test.local' },
    emulator: { defaults: { registration_tasks: { status: 'open' } }, unique: PRODUCTION_UNIQUE_RULES },
    tables: { au_gp_doctor_details: [], pbs_applications: [] }
  });
  t = rig.testUtils;
  w = t.__wp17;
  rig.setSwitch(true);
  t.__setAuQuietHoursClockForTest(IN_HOURS);

  // One Australian doctor at each stage.
  au.placement = doctor('au_vr');                                  // not placed yet
  au.prestart = doctor('au_vr');
  au.commenced = doctor('au_vr');
  au.guarantee = doctor('au_vr');
  au.complete = doctor('au_vr');
  for (const k of ['prestart', 'commenced', 'guarantee', 'complete']) await rig.place(au[k], 'ats_placement');
  const row = (d) => rig.table('placements').find((p) => p.user_id === d.userId);
  const kase = (d) => rig.table('registration_cases').find((c) => c.user_id === d.userId);
  Object.assign(row(au.commenced), { commenced_at: isoDay(Date.now() - 2 * DAY), guarantee_ends_at: isoDay(Date.now() + 82 * DAY), invoice_due_at: isoDay(Date.now() - 2 * DAY), candidate_basis: 'australia' });
  kase(au.commenced).stage = 'commenced';
  Object.assign(row(au.guarantee), { commenced_at: isoDay(Date.now() - 20 * DAY), guarantee_ends_at: isoDay(Date.now() + 64 * DAY), invoice_due_at: isoDay(Date.now() - 20 * DAY), candidate_basis: 'australia' });
  kase(au.guarantee).stage = 'guarantee';
  Object.assign(row(au.complete), { commenced_at: isoDay(Date.now() - 200 * DAY), guarantee_ends_at: isoDay(Date.now() - 116 * DAY), invoice_due_at: isoDay(Date.now() - 200 * DAY), candidate_basis: 'australia' });
  kase(au.complete).stage = 'complete';
  // Two overseas doctors: one placed (the overseas cascade), one not.
  overseas = [doctor('overseas_null'), doctor('overseas_explicit')];
  await rig.place(overseas[0], 'ats_placement');
  // Let the job do everything it owes once, so the runs measured below are quiet ones.
  await t.runAuLifecycleSweep(IN_HOURS);
  await t.runAuLifecycleSweep(IN_HOURS);
}, 60000);
afterAll(async () => { if (rig) { t.__setAuQuietHoursClockForTest(null); await rig.close(); } });

describe('the daily Australian job: request budget', () => {
  it('a quiet run of the WP-17 message pass costs a fixed handful of reads, none per doctor', async () => {
    const run = await counted(() => w.runAuMessagePass(IN_HOURS));
    console.log('[budget] message pass, quiet run: ' + run.requests.length + ' requests ' + JSON.stringify(byTable(run.requests)));
    expect(run.result.ok).toBe(true);
    expect(run.requests.every((r) => r.method === 'GET')).toBe(true);     // nothing to send: nothing written
    expect(run.requests.length).toBeLessThanOrEqual(MESSAGE_PASS_QUIET_BUDGET);
  });

  it('an overseas case costs the message pass nothing: two more overseas doctors, one of them placed, add no request', async () => {
    const before = await counted(() => w.runAuMessagePass(IN_HOURS));
    const wholeBefore = await counted(() => t.runAuLifecycleSweep(IN_HOURS));
    const more = [doctor('overseas_null'), doctor('overseas_explicit')];
    await rig.place(more[0], 'ats_placement');
    const after = await counted(() => w.runAuMessagePass(IN_HOURS));
    const wholeAfter = await counted(() => t.runAuLifecycleSweep(IN_HOURS));
    console.log('[budget] two more overseas doctors (one placed): message pass ' + before.requests.length + ' -> ' + after.requests.length
      + '; whole daily job ' + wholeBefore.requests.length + ' -> ' + wholeAfter.requests.length);
    expect(after.requests.length).toBe(before.requests.length);
    // The whole job too: an overseas doctor, placed or not, adds nothing to it.
    expect(wholeAfter.requests.length).toBe(wholeBefore.requests.length);
    // And no request of the pass is ABOUT an overseas doctor (a filter or a body naming one of them alone).
    const ids = overseas.concat(more).map((d) => d.userId);
    const single = after.requests.filter((r) => ids.some((id) => String(r.query || '').indexOf('user_id=eq.' + id) !== -1));
    expect(single).toEqual([]);
    overseas = overseas.concat(more);
  });

  it('more Australian doctors with nothing owed do not add per-doctor reads to the message pass, or to the whole daily job', async () => {
    const before = await counted(() => w.runAuMessagePass(IN_HOURS));
    const wholeBefore = await counted(() => t.runAuLifecycleSweep(IN_HOURS));
    const extra = [doctor('au_vr'), doctor('au_vr'), doctor('au_vr')];
    for (const d of extra) await rig.place(d, 'ats_placement');
    await w.runAuMessagePass(IN_HOURS);                                   // nothing is owed three minutes after a placement
    await t.runAuLifecycleSweep(IN_HOURS);
    const after = await counted(() => w.runAuMessagePass(IN_HOURS));
    const wholeAfter = await counted(() => t.runAuLifecycleSweep(IN_HOURS));
    console.log('[budget] three more pre-start doctors: message pass ' + before.requests.length + ' -> ' + after.requests.length
      + '; whole daily job ' + wholeBefore.requests.length + ' -> ' + wholeAfter.requests.length);
    expect(after.requests.length).toBe(before.requests.length);
    // FB-2a (R16): the whole job reads per run too. Three more doctors in
    // pre-start, with nothing owed, cost it nothing (it used to be about 23
    // requests each).
    expect(wholeAfter.requests.length).toBe(wholeBefore.requests.length);
    // And no request of the quiet job is about ONE doctor.
    const ids = extra.concat([au.prestart, au.commenced, au.guarantee, au.complete]).map((d) => d.userId);
    const single = wholeAfter.requests.filter((r) => ids.some((id) => String(r.query || '').indexOf('user_id=eq.' + id) !== -1));
    expect(single.map((r) => r.table + ' ' + String(r.query).slice(0, 80))).toEqual([]);
    au.extra = extra;
  });

  it('a quiet run of the whole daily job stays inside its budget, and the message pass is a small part of it', async () => {
    const pass = await counted(() => w.runAuMessagePass(IN_HOURS));
    const whole = await counted(() => t.runAuLifecycleSweep(IN_HOURS));
    console.log('[budget] whole daily job, quiet run: ' + whole.requests.length + ' requests (message pass ' + pass.requests.length + ') ' + JSON.stringify(byTable(whole.requests)));
    expect(whole.result.ok).toBe(true);
    expect(whole.result.au_messages).toMatchObject({ ok: true, n15: 0, n16: 0, n17: 0 });
    expect(whole.requests.length).toBeLessThanOrEqual(DAILY_JOB_QUIET_BUDGET);
    expect(mentions(pass.requests, overseas.map((d) => d.caseId))).toEqual([]);
  });

  // FB-2a (R16): "could not be read" is never "nothing found".
  it('a batched read that fails: nothing is done for those doctors this run, and nothing is written or sent', async () => {
    const tasksBefore = rig.table('registration_tasks').length;
    const ledgerBefore = rig.table('gp_nudge_log').length;
    const stagesBefore = JSON.stringify(rig.table('registration_cases').map((c) => c.id + ':' + c.stage));
    rig.resetRecorders();
    for (const table of ['placements', 'registration_tasks', 'gp_nudge_log', 'user_documents']) {
      rig.emu.failTables = { [table]: 500 };
      const run = await t.runAuLifecycleSweep(IN_HOURS);
      rig.emu.failTables = {};
      expect(run.fired, table).toEqual([]);
      expect(run.au_prestart, table).toMatchObject({ reminded: 0, finished: 0 });
    }
    expect(rig.table('registration_tasks').length).toBe(tasksBefore);
    expect(rig.table('gp_nudge_log').length).toBe(ledgerBefore);
    expect(JSON.stringify(rig.table('registration_cases').map((c) => c.id + ':' + c.stage))).toBe(stagesBefore);
    expect(rig.emails).toEqual([]);
    // The next run, with the database back, is an ordinary quiet run.
    const again = await counted(() => t.runAuLifecycleSweep(IN_HOURS));
    expect(again.result.ok).toBe(true);
    expect(again.requests.length).toBeLessThanOrEqual(DAILY_JOB_QUIET_BUDGET);
  });

  it('switch off: the job makes no request at all', async () => {
    rig.setSwitch(false);
    const off = await counted(async () => { await w.runAuMessagePass(IN_HOURS); return t.runAuLifecycleSweep(IN_HOURS); });
    rig.setSwitch(true);
    expect(off.requests).toEqual([]);
  });
});

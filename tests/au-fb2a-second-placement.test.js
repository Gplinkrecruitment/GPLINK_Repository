// Australian GP build, fix bundle FB-2a, W3-D3 (and R1): a doctor whose
// placement ended, or whose guarantee period finished, gets a fresh journey.
//
// One registration case per doctor is the model (registration_cases_user_id_key),
// so the finished case re-opens through one deliberate, audited transition in
// advanceAuCaseStage: a NEW PLACEMENT CYCLE ('complete' -> 'placement', with the
// cycle number and the placement that ended on the timeline). From there the
// second placement runs the ordinary Australian journey. Everything a
// placement derives is keyed on the placement (the application id), so the
// second placement gets its own pre-start tasks, contract task, N11 / N12,
// commencement, invoice and check-ins, and nothing of the first is re-sent or
// blocks it.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const rigLib = require('./helpers/au-wp11-placement-rig.js');
const { bootPlacementRig, PRACTICE_ID, PRACTICE_NAME } = rigLib;
const { buildAuDoctor, fakeUuid } = require('./helpers/au-fixtures.js');
const { PRODUCTION_UNIQUE_RULES } = require('./helpers/au-supabase-emulator.js');
const lc = require('../lib/au-lifecycle.js');
const fees = require('../lib/au-placement-fees.js');

const ROLE2 = 9112;
let rig; let t; let seq = 0;
const metaOf = (x) => (typeof x.metadata === 'string' ? JSON.parse(x.metadata) : (x.metadata || {}));
const today = () => lc.localDay(Date.now(), 'Australia/Sydney');
const OVERRIDE = { override: true, override_reason: 'The practice confirmed by phone that the doctor has started.' };
const N11 = /Your placement is secured/;
const N12 = /^Placement confirmed: /;

function doctor(kind) {
  seq += 1;
  const d = buildAuDoctor(kind || 'au_vr', { idSuffix: String(7500 + seq), profile: { phone: '+614009' + String(10000 + seq) } });
  rig.addDoctor(d);
  d.app1 = rig.appIdFor(d);
  d.app2 = fakeUuid('a', '2' + String(d.userId).slice(-5));
  return d;
}
// The doctor's second application, with an offer on the table (the ordinary
// route: applied with consent, submitted to the practice).
function secondApplication(d) {
  rig.table('gp_applications').push(rigLib.freshApplication(d, {
    id: d.app2, career_role_id: ROLE2, provider_role_id: 'ats_fb2a_role2', profile_share_consent_role_id: String(ROLE2),
    applied_at: new Date().toISOString(), updated_at: new Date().toISOString()
  }));
  rig.table('ats_offers').push(rigLib.freshOffer(d, { id: fakeUuid('f', '2' + String(d.userId).slice(-5)), application_id: d.app2, career_role_id: ROLE2 }));
}
const caseStage = (d) => rig.caseOf(d).stage;
const tasks = (d) => rig.table('registration_tasks').filter((x) => x.case_id === d.caseId);
const tasksFor = (d, key) => tasks(d).filter((x) => metaOf(x).placement_key === key);
const kinds = (d, key) => tasksFor(d, key).map((x) => metaOf(x).placement_task_kind || ('lifecycle:' + metaOf(x).lifecycle_kind + (metaOf(x).mark ? ':' + metaOf(x).mark : ''))).sort();
const stageLines = (d) => rig.table('task_timeline').filter((x) => x.case_id === d.caseId && x.event_type === 'stage_change');
const settle = async () => { let last = -1; for (let i = 0; i < 200; i++) { const seen = rig.emu.requests.length + rig.emails.length; if (seen === last) return; last = seen; await new Promise((r) => setTimeout(r, 80)); } };
const call = (action, d, body) => rig.post('/api/admin/au/commencement/' + action, Object.assign({ case_id: d.caseId }, body || {}), rig.superAdmin());
const place = async (d, appId) => { const r = await rig.post('/api/ats/placement', { applicationId: appId, commencementDate: fees.addDays(today(), 40) }, rig.consultant()); await settle(); return r; };

// Placement one, from recorded to ended early.
async function firstPlacementEnded(d) {
  expect((await place(d, d.app1)).status).toBe(200);
  expect(caseStage(d)).toBe('prestart');
  const c = await call('confirm', d, Object.assign({ commenced_at: today(), sessions_per_week: 8 }, OVERRIDE));
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  const x = await call('early-exit', d, { last_working_day: today(), reason: 'doctor_resigned', conditions_confirmed: 'yes', note: 'test' });
  expect(x.status, JSON.stringify(x.json)).toBe(200);
  await settle();
  expect(caseStage(d)).toBe('complete');
}

beforeAll(async () => {
  rig = await bootPlacementRig({
    name: 'fb2a-d3', env: { LAUNCH_DEFAULT_RSO_EMAIL: 'rso.test@gplink-test.local' },
    emulator: { defaults: { registration_tasks: { status: 'open' }, placements: { status: 'active' } }, unique: PRODUCTION_UNIQUE_RULES }
  });
  t = rig.testUtils;
  const role1 = rig.table('career_roles')[0];
  rig.table('career_roles').push(Object.assign({}, role1, { id: ROLE2, provider_role_id: 'ats_fb2a_role2', title: 'General Practitioner 2 (FAKE role)' }));
  Object.assign(rig.table('practices').find((p) => p.id === PRACTICE_ID), { agreement_status: 'signed', agreement_signed_at: '2026-09-01T02:00:00.000Z', metadata: {} });
}, 60000);
afterAll(async () => { if (rig) await rig.close(); });
beforeEach(() => { rig.setSwitch(true); rig.emu.forbid(null); rig.resetRecorders(); });

describe('W3-D3: placement -> commencement -> early exit -> apply again -> second placement', () => {
  // About 5 seconds alone: two full placements with their messages.
  it('the whole second journey: its own cycle, tasks, messages and commencement; nothing of the first is re-sent', { timeout: 60000 }, async () => {
    const d = doctor();
    await firstPlacementEnded(d);
    const cycleOne = { kinds: kinds(d, d.app1), statuses: tasksFor(d, d.app1).map((x) => x.id + ':' + x.status).sort() };
    expect(cycleOne.kinds).toEqual(expect.arrayContaining(['indemnity_certificate', 'provider_number_new_location', 'start_date_tracking', 'practice_pack_child:offer_contract']));
    const mailBefore = { n11: rig.capture(d).emailsToDoctor.filter((e) => N11.test(e.subject)).length, n12: rig.capture(d).emailsToPractice.filter((e) => N12.test(e.subject)).length };
    expect(mailBefore).toEqual({ n11: 1, n12: 1 });

    // Between placements: the ended placement no longer counts as "placed".
    expect(await t._auPlacementSecuredFact(d.userId)).toBe(false);
    expect((await t.auPlacedReentryAllowed(d.userId)).allowed).toBe(true);

    // The doctor applies again: the finished case starts a new placement cycle.
    secondApplication(d);
    const opened = await t.auOpenNewPlacementCycle(d.userId, { trigger: 'applied', actor: 'doctor' });
    expect(opened).toEqual({ ok: true, moved: true, cycle: 2 });
    expect(caseStage(d)).toBe('placement');
    expect(rig.caseOf(d).completed_at).toBeNull();
    const line = stageLines(d).pop();
    expect(line.title).toBe('New placement cycle 2 opened: stage set to placement');
    expect(line.metadata).toMatchObject({ from_stage: 'complete', to_stage: 'placement', ladder: 'au', placement_cycle: 2, cycle_opened: true, cycle_trigger: 'applied', previous_placement_key: d.app1 });
    // Asking again changes nothing: the case is no longer finished.
    expect(await t.auOpenNewPlacementCycle(d.userId, { trigger: 'applied' })).toMatchObject({ moved: false, reason: 'case_not_finished' });
    // A state sync while looking does not send them back to pre-start for the old practice.
    await t.processRegistrationTaskAutomationForTest(d.userId, d.email, {}, { gp_career_intro_seen: true });
    expect(caseStage(d)).toBe('placement');

    // Placed a second time.
    rig.resetRecorders();
    const second = await place(d, d.app2);
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect(caseStage(d)).toBe('prestart');
    expect((await t.auPlacementCycleFor(d.caseId)).cycle).toBe(2);
    // Its own set of tasks, keyed on the second placement.
    expect(kinds(d, d.app2)).toEqual(['indemnity_certificate', 'practice_pack_child:offer_contract', 'provider_number_new_location', 'start_date_tracking']);
    // The first placement's tasks are exactly as they were.
    expect(tasksFor(d, d.app1).map((x) => x.id + ':' + x.status).sort()).toEqual(cycleOne.statuses);
    // N11 and N12 went again, once each, for the second placement.
    const cap = rig.capture(d);
    expect(cap.emailsToDoctor.filter((e) => N11.test(e.subject))).toHaveLength(1);
    expect(cap.emailsToPractice.filter((e) => N12.test(e.subject))).toHaveLength(1);
    const ledger = rig.table('gp_nudge_log').filter((n) => n.user_id === d.userId).map((n) => n.nudge_key);
    expect(ledger).toEqual(expect.arrayContaining(['au_n11_placement_secured:' + d.app1, 'au_n11_placement_secured:' + d.app2, 'au_n12_placement_confirmed:' + d.app1, 'au_n12_placement_confirmed:' + d.app2]));
    // The pre-start question is about the second placement.
    const pre = await t.auPrestartComplete(d.caseId);
    expect(pre).toMatchObject({ ok: true, complete: false, placementKey: d.app2 });
    // The doctor's own view: placed again, with the new practice's checklist.
    const view = await rig.get('/api/gp/au-prestart', { cookie: rig.gpCookie(d.email, d.userId) });
    expect(view.json).toMatchObject({ ok: true, placed: true, stage: 'prestart', started: false });
    expect(view.json.placementEnded).toBeUndefined();

    // Commencement of the second placement: its own invoice and check-ins, and the stage moves.
    rig.resetRecorders();
    const c2 = await call('confirm', d, Object.assign({ commenced_at: today(), sessions_per_week: 6 }, OVERRIDE));
    expect(c2.status, JSON.stringify(c2.json)).toBe(200);
    await settle();
    expect(caseStage(d)).toBe('commenced');
    expect(kinds(d, d.app2).filter((k) => /^lifecycle:/.test(k))).toEqual(['lifecycle:guarantee_checkin:w12', 'lifecycle:guarantee_checkin:w4', 'lifecycle:guarantee_checkin:w8', 'lifecycle:invoice_due', 'lifecycle:week1_checkin:w1']);
    const p2 = rig.table('placements').find((p) => p.application_id === d.app2);
    expect(p2).toMatchObject({ status: 'active', commenced_at: today(), fee_tier: 'part_time' });
    const p1 = rig.table('placements').find((p) => p.application_id === d.app1);
    expect(p1).toMatchObject({ status: 'ended', fee_tier: 'full_time' });
    expect(tasksFor(d, d.app1).map((x) => x.id + ':' + x.status).sort()).toEqual(cycleOne.statuses);
    // The whole history is on the one case, in order.
    expect(stageLines(d).map((x) => x.metadata.to_stage)).toEqual(['prestart', 'commenced', 'complete', 'placement', 'prestart', 'commenced']);
  });

  it('staff place the doctor again without the doctor applying first: the placement itself opens the cycle', { timeout: 60000 }, async () => {
    const d = doctor();
    await firstPlacementEnded(d);
    secondApplication(d);
    const res = await place(d, d.app2);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(caseStage(d)).toBe('prestart');
    const lines = stageLines(d).slice(-2);
    expect(lines[0].metadata).toMatchObject({ to_stage: 'placement', placement_cycle: 2, cycle_trigger: 'placement_recorded' });
    expect(lines[1].metadata).toMatchObject({ from_stage: 'placement', to_stage: 'prestart' });
    expect(kinds(d, d.app2)).toEqual(expect.arrayContaining(['start_date_tracking', 'indemnity_certificate', 'provider_number_new_location']));
  });

  it('a third placement is cycle 3', { timeout: 60000 }, async () => {
    const d = doctor();
    await firstPlacementEnded(d);
    secondApplication(d);
    await place(d, d.app2);
    await call('confirm', d, Object.assign({ commenced_at: today(), sessions_per_week: 8 }, OVERRIDE));
    await call('early-exit', d, { last_working_day: today(), reason: 'doctor_resigned', conditions_confirmed: 'yes', note: 'test' });
    await settle();
    expect(caseStage(d)).toBe('complete');
    expect(await t.auOpenNewPlacementCycle(d.userId, { trigger: 'applied' })).toEqual({ ok: true, moved: true, cycle: 3 });
    expect(stageLines(d).pop().metadata).toMatchObject({ placement_cycle: 3, previous_placement_key: d.app2 });
  });
});

describe('the daily job and an earlier placement that is still on file as active', () => {
  it('a finished guarantee period (doctor never recorded as leaving), then a second placement: the old row never moves the case again', { timeout: 60000 }, async () => {
    const d = doctor();
    expect((await place(d, d.app1)).status).toBe(200);
    expect((await call('confirm', d, Object.assign({ commenced_at: today(), sessions_per_week: 8 }, OVERRIDE))).status).toBe(200);
    // One hundred days on: the guarantee period is over and the case was completed.
    const p1 = rig.table('placements').find((p) => p.application_id === d.app1);
    Object.assign(p1, { commenced_at: fees.addDays(today(), -100), guarantee_ends_at: fees.addDays(today(), -16), invoice_due_at: fees.addDays(today(), -100),
      placed_at: new Date(Date.now() - 120 * 86400000).toISOString(), created_at: new Date(Date.now() - 120 * 86400000).toISOString() });
    await t.runAuLifecycleSweep(Date.now());
    await settle();
    expect(caseStage(d)).toBe('complete');
    // Placed again elsewhere: cycle two, pre-start.
    secondApplication(d);
    expect((await place(d, d.app2)).status).toBe(200);
    expect(caseStage(d)).toBe('prestart');
    const before = stageLines(d).length;
    // The daily job, twice: placement one is still "active, commenced" on file.
    await t.runAuLifecycleSweep(Date.now());
    await t.runAuLifecycleSweep(Date.now() + 86400000);
    await settle();
    expect(caseStage(d)).toBe('prestart');
    expect(stageLines(d)).toHaveLength(before);
    // And once placement two has started, it is placement two that moves the case.
    expect((await call('confirm', d, Object.assign({ commenced_at: today(), sessions_per_week: 8 }, OVERRIDE))).status).toBe(200);
    await t.runAuLifecycleSweep(Date.now());
    await settle();
    expect(caseStage(d)).toBe('commenced');
  });
});

describe('the cycle transition is the only way back, and only when it is true', () => {
  it('advanceAuCaseStage still refuses complete -> placement without the cycle flag, a cycle number and a reason', async () => {
    const d = doctor();
    await firstPlacementEnded(d);
    expect(await t.advanceAuCaseStage(d.caseId, 'placement', 'staff@gplink-test.local', {})).toMatchObject({ moved: false, reason: 'backward_move' });
    expect(await t.advanceAuCaseStage(d.caseId, 'placement', 'x', { newPlacementCycle: true, cycle: 2 })).toMatchObject({ moved: false, reason: 'backward_move' });
    expect(await t.advanceAuCaseStage(d.caseId, 'placement', 'x', { newPlacementCycle: true, cycle: 1, reason: 'r' })).toMatchObject({ moved: false, reason: 'backward_move' });
    expect(await t.advanceAuCaseStage(d.caseId, 'prestart', 'x', { newPlacementCycle: true, cycle: 2, reason: 'r' })).toMatchObject({ moved: false, reason: 'backward_move' });
    expect(caseStage(d)).toBe('complete');
  });

  it('never from a case that is still running, never for an overseas doctor, never with the switch off', async () => {
    const running = doctor();
    await place(running, running.app1);
    expect(await t.auOpenNewPlacementCycle(running.userId, { trigger: 'applied' })).toMatchObject({ moved: false, reason: 'case_not_finished' });
    expect(await t.advanceAuCaseStage(running.caseId, 'placement', 'x', { newPlacementCycle: true, cycle: 2, reason: 'r' })).toMatchObject({ moved: false, reason: 'backward_move' });
    const os = doctor('overseas_null');
    rig.caseOf(os).stage = 'complete';
    expect(await t.auOpenNewPlacementCycle(os.userId, { trigger: 'applied' })).toMatchObject({ moved: false, reason: 'not_au_pathway' });
    expect(rig.caseOf(os).stage).toBe('complete');
    const off = doctor();
    await firstPlacementEnded(off);
    rig.setSwitch(false);
    expect(await t.auOpenNewPlacementCycle(off.userId, { trigger: 'applied' })).toEqual({ ok: false, moved: false, reason: 'feature_off' });
  });

  it('"a placement was recorded" opens a cycle only for a placement that has not started; an unknown trigger is refused', async () => {
    const d = doctor();
    await firstPlacementEnded(d);
    expect(await t.auOpenNewPlacementCycle(d.userId, { trigger: 'placement_recorded' })).toMatchObject({ moved: false, reason: 'no_new_placement' });
    expect(await t.auOpenNewPlacementCycle(d.userId, { trigger: 'because' })).toMatchObject({ moved: false, reason: 'unknown_trigger' });
    // A finished guarantee period with the doctor still in place: the bulk sync and a state sync leave it finished.
    await rig.post('/api/admin/cases/sync', {}, rig.superAdmin());
    await t.processRegistrationTaskAutomationForTest(d.userId, d.email, {}, { gp_career_intro_seen: true });
    expect(caseStage(d)).toBe('complete');
  });

  it('two requests opening the cycle at once: one cycle', async () => {
    const d = doctor();
    await firstPlacementEnded(d);
    const both = await Promise.all([t.auOpenNewPlacementCycle(d.userId, { trigger: 'applied' }), t.auOpenNewPlacementCycle(d.userId, { trigger: 'applied' })]);
    expect(both.filter((r) => r.moved)).toHaveLength(1);
    expect(stageLines(d).filter((x) => x.metadata && x.metadata.cycle_opened)).toHaveLength(1);
  });
});

describe('what the doctor is sent about an earlier placement', () => {
  it('Careers: an ended placement is "Placement ended", not a secured practice; a current one is unchanged', async () => {
    const d = doctor();
    await firstPlacementEnded(d);
    const secured = { id: d.app1, status: 'placement_secured', isPlacementSecured: true, statusLabel: 'Placement secured', placement: { practiceName: PRACTICE_NAME }, role: { id: 'x' } };
    const [out] = await t.auRetireFinishedPlacements(d.userId, [secured]);
    expect(out).toMatchObject({ id: d.app1, status: 'placement_ended', isPlacementSecured: false, statusLabel: 'Placement ended', statusTone: 'review' });
    expect(out.placement).toBeUndefined();
    const live = doctor();
    await place(live, live.app1);
    const kept = await t.auRetireFinishedPlacements(live.userId, [Object.assign({}, secured, { id: live.app1 })]);
    expect(kept[0]).toMatchObject({ status: 'placement_secured', isPlacementSecured: true });
  });

  it('a finished guarantee period (the doctor is still there): "Placement complete" once the case is finished', async () => {
    const d = doctor();
    await place(d, d.app1);
    await call('confirm', d, Object.assign({ commenced_at: today(), sessions_per_week: 8 }, OVERRIDE));
    const secured = { id: d.app1, status: 'placement_secured', isPlacementSecured: true, placement: { practiceName: PRACTICE_NAME } };
    expect((await t.auRetireFinishedPlacements(d.userId, [secured]))[0].status).toBe('placement_secured'); // still in the guarantee period
    rig.caseOf(d).stage = 'complete';
    expect((await t.auRetireFinishedPlacements(d.userId, [secured]))[0]).toMatchObject({ status: 'placement_complete', statusLabel: 'Placement complete', isPlacementSecured: false });
  });

  it('the careers page treats both as finished applications, and the apply route opens the cycle after a re-entry', () => {
    const career = fs.readFileSync(path.join(__dirname, '..', 'pages/career.html'), 'utf8');
    expect(career).toContain('const TERMINAL_APPLICATION_STATUS_KEYS = ["withdrawn", "not_proceeding", "offer_declined", "placement_ended", "placement_complete"];');
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const apply = server.slice(server.indexOf("if (pathname === '/api/career/apply' && req.method === 'POST') {"));
    expect(apply.indexOf('applyAuReentry = applyReentry.allowed === true;')).toBeGreaterThan(-1);
    expect(apply.indexOf("await auOpenNewPlacementCycle(userId, { trigger: 'applied', actor: 'doctor' })")).toBeGreaterThan(apply.indexOf('const savedApplication = insertResult.data'));
  });

  it('OVERSEAS PARITY: an overseas doctor\'s applications are returned untouched, switch on and off', async () => {
    const os = doctor('overseas_null');
    const list = [{ id: os.app1, status: 'placement_secured', isPlacementSecured: true, placement: { practiceName: 'X' } }];
    for (const on of [true, false]) {
      rig.setSwitch(on);
      rig.emu.reset();
      expect(await t.auScrubCareerPayloadFor(os.userId, list)).toBe(list);
      if (!on) expect(rig.emu.requests).toEqual([]);
    }
  });
});

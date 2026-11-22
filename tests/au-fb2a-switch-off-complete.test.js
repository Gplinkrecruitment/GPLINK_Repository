// Australian GP build, fix bundle FB-2a, W3-D1 (blocker).
//
// 'complete' is the one stage both ladders use. The P1-D1 guard recognised an
// Australian case from its stored STAGE alone ('placement', 'prestart',
// 'commenced', 'guarantee'), so a FINISHED Australian case was handed to the
// overseas stage code the moment its doctor opened the app with the switch
// off, and rewritten to 'myintealth'. Switched back on, a doctor whose
// placement had ended was then sent to 'prestart' for the practice they left.
//
//   A. Switch off: no overseas stage writer touches a finished Australian case
//      (state sync, the staff stage control, Reset GP, the bulk sync, the
//      registration-granted flow), and nothing new is asked of the database.
//   B. How the case is recognised: `pathway` on the row in hand, else the
//      ladder marker on its timeline; migrations not applied means overseas.
//   C. Overseas parity: an overseas 'complete' case is derived exactly as
//      before, switch on and off, and no other stage costs a read.
//   D. Rows the old code already demoted are put back where the FACTS say
//      (pre-start / started / guarantee period / finished / ended), not just
//      to the first two rungs.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { wp02NewNameViolation } = require('./helpers/au-supabase-emulator.js');
const {
  buildAuDoctor, buildAuFixtureDb, WP02_NEW_COLUMN_NAMES, WP02_NEW_TABLES, wp06NewNameViolation, wp13NewNameViolation
} = require('./helpers/au-fixtures.js');
const auLifecycle = require('../lib/au-lifecycle.js');
const fees = require('../lib/au-placement-fees.js');

const NAMES = { columns: WP02_NEW_COLUMN_NAMES, tables: WP02_NEW_TABLES };
const EMPTY_TABLES = ['registration_tasks', 'task_timeline', 'gp_applications', 'placements', 'user_documents',
  'admin_audit_log', 'candidate_leads', 'onboarding_reminders', 'pep_waitlist', 'runtime_kv', 'rate_limits',
  'gp_nudge_log', 'password_setup_tokens', 'user_roles', 'career_roles', 'practices', 'ats_offers', 'pbs_applications'];

let h, t;
let seq = 0;
const rows = (table) => h.emu.table(table);
const row = (table, userId) => rows(table).filter((r) => r.user_id === userId)[0] || null;
const caseOf = (userId) => row('registration_cases', userId);
const stageChanges = (userId) => rows('task_timeline').filter((e) => caseOf(userId) && e.case_id === caseOf(userId).id && e.event_type === 'stage_change');
const today = () => auLifecycle.localDay(Date.now(), auLifecycle.FALLBACK_ZONE);

function add(kind, overrides) {
  seq += 1;
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: 'c' + seq }, overrides || {}));
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}
// The timeline line advanceAuCaseStage writes for every Australian move.
function markAuLadder(d, to) {
  rows('task_timeline').push({
    id: 'tl-' + d.userId + '-' + to, case_id: d.caseId, task_id: null, event_type: 'stage_change', title: 'Stage advanced to ' + to,
    actor: 'system', metadata: { from_stage: 'guarantee', to_stage: to, ladder: 'au', pathway: 'au_vr' }, created_at: '2026-10-01T00:00:00.000Z'
  });
}
function finishedAuCase(overrides) {
  const d = add('au_vr', Object.assign({ caseRow: { stage: 'complete' } }, overrides || {}));
  markAuLadder(d, 'complete');
  return d;
}
const blankVisit = { gp_career_intro_seen: true };

beforeAll(async () => {
  const tables = buildAuFixtureDb([]);
  EMPTY_TABLES.forEach((name) => { tables[name] = []; });
  h = await bootAuTestServer({ name: 'fb2a-d1', tables, emulator: { auth: true } });
  t = h.testUtils;
});
afterAll(async () => { if (h) await h.close(); });
beforeEach(() => { h.setSwitch(true); h.emu.forbid(null); h.emu.failTables = {}; h.emu.missingColumns = {}; h.emu.reset(); });

describe('A. switch off never rewrites a finished Australian case', () => {
  it('THE REPORTED BUG: complete, switch off, the doctor opens Home -> still complete, nothing stamped, nothing new asked', async () => {
    const d = finishedAuCase();
    h.setSwitch(false);
    h.emu.reset();
    h.emu.forbid((r) => wp02NewNameViolation(r, NAMES) || wp06NewNameViolation(r) || wp13NewNameViolation(r));
    const put = await h.put('/api/state', { state: blankVisit, updatedAt: new Date().toISOString() }, { cookie: d.cookie });
    expect(put.status).toBe(200);
    await t.processRegistrationTaskAutomationForTest(d.userId, d.email, {}, blankVisit);
    await new Promise((r) => setTimeout(r, 200));
    expect(caseOf(d.userId).stage).toBe('complete');
    expect(stageChanges(d.userId).map((e) => e.title)).toEqual(['Stage advanced to complete']);
    const st = row('user_state', d.userId).state;
    expect(st.gp_admin_stage_override).toBeUndefined();
    expect(st.gp_registration_return_overrides).toBeUndefined();
    expect(h.emu.violations).toEqual([]);
    // Back on: nothing has to be restored, because nothing was changed.
    h.emu.forbid(null);
    h.setSwitch(true);
    await t.processRegistrationTaskAutomationForTest(d.userId, d.email, {}, blankVisit);
    expect(caseOf(d.userId).stage).toBe('complete');
    expect(stageChanges(d.userId)).toHaveLength(1);
  });

  it('every overseas stage writer, switch off, with overseas progress flags in the doctor\'s state', async () => {
    const d = finishedAuCase();
    h.setSwitch(false);
    await t.processRegistrationTaskAutomationForTest(d.userId, d.email, {}, {
      gp_epic_progress: { completed: { verification_issued: true } }, gp_amc_progress: { completed: { qualifications_verified: true } }
    });
    expect(caseOf(d.userId).stage).toBe('complete');
    const applied = await t.applyVerifiedStageToGp(d.caseId, d.userId, 'ahpra', 'staff@gplink-test.local', { fromStage: 'complete' });
    expect(applied).toMatchObject({ ok: false, held: true });
    expect(row('user_state', d.userId).state.gp_admin_stage_override).toBeUndefined();
    const reset = await h.post('/api/admin/reset-gp', { email: d.email }, h.superAdmin());
    expect(reset.status).toBe(409);
    expect(reset.json.code).toBe('au_stage');
    const sync = await h.post('/api/admin/cases/sync', {}, h.superAdmin());
    expect(sync.status).toBe(200);
    const granted = await t.handleAhpraRegistrationGranted({ caseId: d.caseId, userId: d.userId, source: { type: 'manual' }, registration: { number: 'MED0001234567' }, actor: 'staff@gplink-test.local' });
    expect(granted.skipped).toBeTruthy();
    const pos = await t.resolveGpJourneyPositionForTest(d.userId, 'complete', null);
    expect(pos.ladder).toBe('au');
    expect(pos.stage).toBe('complete');
    expect(caseOf(d.userId).stage).toBe('complete');
    expect(stageChanges(d.userId)).toHaveLength(1);
  });
});

describe('B. how a finished case is recognised as Australian', () => {
  it('the pathway on the row in hand answers with no read at all', async () => {
    const d = finishedAuCase();
    h.setSwitch(false);
    h.emu.reset();
    expect(await t._auSharedStageEvidence(d.userId, caseOf(d.userId))).toBe('au');
    expect(h.emu.requests).toEqual([]);
  });

  it('no pathway on the row (the mirror write failed): the ladder marker on the timeline answers', async () => {
    const d = finishedAuCase();
    caseOf(d.userId).pathway = null;
    h.setSwitch(false);
    h.emu.reset();
    expect(await t._auStageModeFor(d.userId, caseOf(d.userId))).toMatchObject({ mode: 'hold', strandedAuStage: true });
    expect(h.emu.requests.map((r) => r.table)).toEqual(['task_timeline']);
    await t.processRegistrationTaskAutomationForTest(d.userId, d.email, {}, blankVisit);
    expect(caseOf(d.userId).stage).toBe('complete');
  });

  it('a caller with only the stage in hand (no row, no id) still finds the case and its marker', async () => {
    const d = finishedAuCase();
    h.setSwitch(false);
    expect(await t._auStageModeFor(d.userId, { stage: 'complete' })).toMatchObject({ mode: 'hold', strandedAuStage: true });
  });

  it('MIGRATIONS NOT APPLIED: no pathway column, no marker -> overseas, as today, and no query fails', async () => {
    const d = add('overseas_null', { caseRow: { stage: 'complete' } });
    h.emu.missingColumns = { registration_cases: ['pathway', 'placing_consultant'] };
    h.setSwitch(false);
    h.emu.reset();
    h.emu.forbid((r) => wp02NewNameViolation(r, NAMES) || wp06NewNameViolation(r) || wp13NewNameViolation(r));
    expect(await t._auStageModeFor(d.userId, { id: d.caseId, stage: 'complete' })).toEqual({ mode: 'overseas', pathway: null });
    expect(h.emu.violations).toEqual([]);
    expect(h.emu.requests.filter((r) => r.status >= 400)).toEqual([]);
  });

  it('the evidence cannot be read: the case is held this once and nothing is written', async () => {
    const d = finishedAuCase();
    caseOf(d.userId).pathway = null;
    h.setSwitch(false);
    h.emu.failTables = { task_timeline: 500 };
    expect(await t._auSharedStageEvidence(d.userId, caseOf(d.userId))).toBe('unknown');
    await t.processRegistrationTaskAutomationForTest(d.userId, d.email, {}, blankVisit);
    h.emu.failTables = {};
    expect(caseOf(d.userId).stage).toBe('complete');
  });

  it('a pathway staff recorded as overseas on the row is believed', async () => {
    const d = add('overseas_explicit', { caseRow: { stage: 'complete' } });
    h.emu.reset();
    expect(await t._auSharedStageEvidence(d.userId, caseOf(d.userId))).toBe('overseas');
    expect(h.emu.requests).toEqual([]);
  });
});

describe('C. OVERSEAS PARITY', () => {
  it('an overseas case at complete is derived exactly as before (switch on and off) at the cost of one read', async () => {
    for (const on of [true, false]) {
      const d = add('overseas_null', { caseRow: { stage: 'complete' } });
      h.setSwitch(on);
      h.emu.reset();
      expect(await t._auStageModeFor(d.userId, caseOf(d.userId))).toMatchObject({ mode: 'overseas' });
      expect(h.emu.requestsTo('task_timeline')).toHaveLength(1);
      await t.processRegistrationTaskAutomationForTest(d.userId, d.email, {}, { gp_epic_progress: { completed: { verification_issued: true } } });
      // What main does today for such a case: the derivation rewrites it.
      expect(caseOf(d.userId).stage).toBe('amc');
      expect(stageChanges(d.userId).map((e) => e.title)).toEqual(['Stage advanced to amc']);
      expect(stageChanges(d.userId)[0].metadata).toEqual({ from_stage: 'complete', to_stage: 'amc' });
    }
  });

  it('no other overseas stage costs anything with the switch off', async () => {
    for (const stage of ['myintealth', 'amc', 'career', 'ahpra', 'visa', 'pbs', 'commencement']) {
      const d = add('overseas_null', { caseRow: { stage } });
      h.setSwitch(false);
      h.emu.reset();
      expect(await t._auStageModeFor(d.userId, caseOf(d.userId)), stage).toEqual({ mode: 'overseas', pathway: null });
      expect(h.emu.requests, stage).toEqual([]);
    }
  });
});

describe('D. a case the old code demoted goes back where the facts say', () => {
  const practice = { id: 'prac-fb2a-1', name: 'Test Metro Practice (FAKE)', location_state: 'NSW' };
  function placementFor(d, over) {
    const appId = 'app-' + d.userId;
    rows('gp_applications').push({ id: appId, user_id: d.userId, status: 'placement_secured', ats_stage: 'hired', applied_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-10T00:00:00.000Z' });
    const pl = Object.assign({
      id: 'pl-' + d.userId, user_id: d.userId, application_id: appId, practice_id: practice.id, practice_name: practice.name,
      status: 'active', placed_at: '2026-08-10T00:00:00.000Z', created_at: '2026-08-10T00:00:00.000Z', start_date: null,
      commenced_at: null, guarantee_ends_at: null, ended_at: null
    }, over || {});
    rows('placements').push(pl);
    return pl;
  }
  const demoted = () => add('au_vr', { caseRow: { stage: 'myintealth' } });
  beforeAll(() => { rows('practices').push(practice); });

  const cases = [
    ['no placement at all', () => null, 'placement'],
    ['a placement recorded, not started', () => ({}), 'prestart'],
    ['started three days ago', () => ({ commenced_at: fees.addDays(today(), -3), guarantee_ends_at: fees.addDays(today(), 81) }), 'commenced'],
    ['started three weeks ago', () => ({ commenced_at: fees.addDays(today(), -21), guarantee_ends_at: fees.addDays(today(), 63) }), 'guarantee'],
    ['the guarantee period is over', () => ({ commenced_at: fees.addDays(today(), -100), guarantee_ends_at: fees.addDays(today(), -16) }), 'complete'],
    ['the placement ended early', () => ({ status: 'ended', commenced_at: fees.addDays(today(), -30), guarantee_ends_at: fees.addDays(today(), 54), ended_at: fees.addDays(today(), -5) }), 'complete']
  ];
  for (const [name, over, expected] of cases) {
    it('syncCaseToPathway: ' + name + ' -> ' + expected, async () => {
      const d = demoted();
      const o = over();
      if (o) placementFor(d, o);
      const moved = await t.syncCaseToPathway(d.userId, { actor: 'system', reason: 'test' });
      expect(moved).toMatchObject({ ok: true, moved: true, to: expected });
      expect(caseOf(d.userId).stage).toBe(expected);
      const line = stageChanges(d.userId).pop();
      expect(line.metadata).toMatchObject({ from_stage: 'myintealth', to_stage: expected, ladder: 'au' });
      expect(typeof line.metadata.restored_from_facts).toBe('string');
      // And again: nothing more happens.
      expect(await t.syncCaseToPathway(d.userId, {})).toMatchObject({ moved: false, reason: 'already_on_ladder' });
    });
  }

  it('the state sync does the same for a demoted case (the doctor simply opens the app)', async () => {
    const d = demoted();
    placementFor(d, { status: 'ended', commenced_at: fees.addDays(today(), -30), ended_at: fees.addDays(today(), -5) });
    await t.processRegistrationTaskAutomationForTest(d.userId, d.email, {}, blankVisit);
    // NOT 'prestart' for the practice the doctor has left (the second half of W3-D1).
    expect(caseOf(d.userId).stage).toBe('complete');
  });

  it('an ended placement is not "a placement on record", although its application still reads secured', async () => {
    const d = add('au_vr');
    placementFor(d, { status: 'ended', ended_at: fees.addDays(today(), -5) });
    expect(await t._auPlacementSecuredFact(d.userId)).toBe(false);
    const live = add('au_vr');
    placementFor(live, {});
    expect(await t._auPlacementSecuredFact(live.userId)).toBe(true);
  });

  it('the rows cannot be read: the case is left alone', async () => {
    const d = demoted();
    h.emu.failTables = { placements: 500 };
    expect(await t.syncCaseToPathway(d.userId, {})).toMatchObject({ moved: false, reason: 'facts_unreadable' });
    h.emu.failTables = {};
    expect(caseOf(d.userId).stage).toBe('myintealth');
  });
});

describe('caseStageFromPlacementFacts (pure)', () => {
  const f = auLifecycle.caseStageFromPlacementFacts;
  const T = '2026-11-22';
  it('the newest fact decides', () => {
    expect(f({ placements: [], today: T }).stage).toBe('placement');
    expect(f({ placements: [], today: T, securedApplicationWithoutRow: true }).stage).toBe('prestart');
    expect(f({ placements: [{ id: 1, status: 'cancelled', placed_at: '2026-09-01' }], today: T }).stage).toBe('placement');
    expect(f({ placements: [{ id: 1, status: 'active', placed_at: '2026-09-01' }], today: T }).stage).toBe('prestart');
    expect(f({ placements: [{ id: 1, status: 'active', placed_at: '2026-09-01', commenced_at: '2026-11-20' }], today: T }).stage).toBe('commenced');
    expect(f({ placements: [{ id: 1, status: 'active', placed_at: '2026-09-01', commenced_at: '2026-11-15' }], today: T }).stage).toBe('guarantee');
    expect(f({ placements: [{ id: 1, status: 'active', placed_at: '2026-06-01', commenced_at: '2026-08-01' }], today: T }).stage).toBe('complete');
    expect(f({ placements: [{ id: 1, status: 'ended', placed_at: '2026-06-01', commenced_at: '2026-08-01', ended_at: '2026-09-01' }], today: T }).stage).toBe('complete');
  });
  it('a second placement after an ended one, and a doctor looking again', () => {
    const ended = { id: 1, status: 'ended', placed_at: '2026-06-01', commenced_at: '2026-08-01', ended_at: '2026-09-01' };
    expect(f({ placements: [ended, { id: 2, status: 'active', placed_at: '2026-10-01' }], today: T })).toMatchObject({ stage: 'prestart', placementId: '2' });
    expect(f({ placements: [ended], today: T, lookingAgain: true }).stage).toBe('placement');
    expect(f({ placements: [ended, { id: 2, status: 'active', placed_at: '2026-10-01', commenced_at: '2026-11-21' }], today: T })).toMatchObject({ stage: 'commenced', placementId: '2' });
  });
  it('today is the practice\'s own date, per row', () => {
    const p = { id: 1, status: 'active', practice_id: 'perth', placed_at: '2026-09-01', commenced_at: '2026-11-15' };
    expect(f({ placements: [p], dayFor: () => '2026-11-21' }).stage).toBe('commenced');
    expect(f({ placements: [p], dayFor: () => '2026-11-22' }).stage).toBe('guarantee');
  });
});

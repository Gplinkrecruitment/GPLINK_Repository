// WP-03 of the Australian GP build, server side: the Australian stage ladder
// and case creation, against the real server and the in-memory Supabase
// emulator. Both states of AU_PATHWAY_ENABLED (read at call time).
//
// Proves:
//   - an Australian doctor's case is created at 'placement' (pathway copied),
//     and nothing the GP app or staff are told ever says 'myintealth';
//   - it moves to 'prestart' when a placement is recorded, at each entry point,
//     and never on the browser's word alone;
//   - a doctor who signed up before their pathway was set is moved once;
//   - stray overseas state flags never change an Australian stage;
//   - the staff stage setter never writes EPIC / AMC / AHPRA flags for an
//     Australian doctor; Reset GP and stage rollback are refused;
//   - OVERSEAS REGRESSION: a doctor with nothing recorded (switch on) and any
//     doctor (switch off) derive exactly the stages they do on main.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb, STAFF_EMAIL } = require('./helpers/au-fixtures.js');

let h, t;
let seq = 0;
const made = [];

const cases = () => h.emu.table('registration_cases');
const caseOf = (d) => cases().find((r) => r.user_id === d.userId);
const stateOf = (d) => (h.emu.table('user_state').find((r) => r.user_id === d.userId) || {}).state;
const stageChanges = (d) => {
  const c = caseOf(d);
  return h.emu.table('task_timeline').filter((e) => c && e.case_id === c.id && e.event_type === 'stage_change');
};
const stageWrites = (d) => {
  const c = caseOf(d);
  return h.emu.requests.filter((r) => r.table === 'registration_cases' && (r.method === 'PATCH' || r.method === 'POST')
    && r.bodyKeys.indexOf('stage') !== -1 && (!c || r.query.indexOf(c.id) !== -1 || r.method === 'POST'));
};
const OVERSEAS_FLAG_KEYS = ['gp_epic_progress', 'gp_amc_progress', 'gp_ahpra_progress',
  'gp_registration_return_overrides', 'gp_admin_stage_override', 'gp_stage_override_at'];

// A fresh doctor added to the running emulator (unique ids, so tests do not share rows).
function add(kind, overrides) {
  seq += 1;
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: String(100 + seq) }, overrides || {}));
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((row) => h.emu.table(table).push(row)));
  made.push(d);
  return d;
}
const epicDone = { stage: 'verification_issued', completed: { create_account: true, account_establishment: true, upload_qualifications: true, verification_issued: true } };
const amcDone = { stage: 'qualifications_verified', completed: { create_portfolio: true, upload_credentials: true, qualifications_verified: true } };
const ahpraDone = { completed: { account_establishment: true, upload_qualifications: true, waiting_verification: true, verification_issued: true } };

async function automate(d, next, prev) {
  const base = stateOf(d) || {};
  const nextState = Object.assign({}, base, next);
  const row = h.emu.table('user_state').find((r) => r.user_id === d.userId);
  if (row) row.state = nextState;
  await t.processRegistrationTaskAutomationForTest(d.userId, d.email, Object.assign({}, base, prev || {}), nextState);
}

beforeAll(async () => {
  h = await bootAuTestServer({
    name: 'wp03-stages',
    tables: Object.assign(buildAuFixtureDb([]), { gp_applications: [], placements: [], task_timeline: [], registration_tasks: [] }),
    env: { CALENDLY_EVENT_URL: 'https://calendly.test/gplink-test/assist' }
  });
  t = h.testUtils;
});

afterAll(async () => { if (h) await h.close(); });

beforeEach(() => {
  h.setSwitch(true);
  h.emu.reset();
  h.emu.forbid(null);
  h.emu.missingColumns = {};
  h.emu.missingTables = new Set();
  h.emu.failTables = {};
});

// ─────────────────────────────────────────────────────────────────────────────
describe('case creation (_ensureRegCase)', () => {
  it('an au_vr doctor\'s case is created at placement, with the pathway copied onto it', async () => {
    const d = add('au_vr', { noCase: true });
    const c = await t._ensureRegCase(d.userId);
    expect(c).toMatchObject({ user_id: d.userId, stage: 'placement', pathway: 'au_vr', status: 'active' });
    expect(caseOf(d)).toMatchObject({ stage: 'placement', pathway: 'au_vr' });
    // Asking again returns the same case and creates nothing.
    const again = await t._ensureRegCase(d.userId);
    expect(again.id).toBe(c.id);
    expect(cases().filter((r) => r.user_id === d.userId).length).toBe(1);
  });

  it('every Australian pathway starts at placement (segments B and C use the same ladder)', async () => {
    for (const kind of ['au_restricted', 'au_non_vr', 'au_registrar']) {
      const d = add(kind, { noCase: true });
      const c = await t._ensureRegCase(d.userId);
      expect(c, kind).toMatchObject({ stage: 'placement', pathway: kind });
    }
  });

  it('OVERSEAS: nothing recorded -> myintealth, and the insert is exactly today\'s body (no pathway key)', async () => {
    const d = add('overseas_null', { noCase: true });
    const c = await t._ensureRegCase(d.userId);
    expect(c.stage).toBe('myintealth');
    const inserts = h.emu.requests.filter((r) => r.table === 'registration_cases' && r.method === 'POST');
    expect(inserts.length).toBe(1);
    expect(inserts[0].body).toEqual([{ user_id: d.userId, stage: 'myintealth', status: 'active' }]);
  });

  it('OVERSEAS: a recorded overseas pathway also starts at myintealth with today\'s body', async () => {
    const d = add('overseas_explicit', { noCase: true });
    const c = await t._ensureRegCase(d.userId);
    expect(c.stage).toBe('myintealth');
    expect(h.emu.requests.filter((r) => r.table === 'registration_cases' && r.method === 'POST')[0].body)
      .toEqual([{ user_id: d.userId, stage: 'myintealth', status: 'active' }]);
  });

  it('SWITCH OFF: a stored au_vr doctor gets today\'s case, and the pathway is never asked for', async () => {
    const d = add('au_vr', { noCase: true });
    h.setSwitch(false);
    const c = await t._ensureRegCase(d.userId);
    expect(c.stage).toBe('myintealth');
    expect(h.emu.requests.filter((r) => r.table === 'registration_cases' && r.method === 'POST')[0].body)
      .toEqual([{ user_id: d.userId, stage: 'myintealth', status: 'active' }]);
    expect(h.emu.requests.some((r) => JSON.stringify(r).indexOf('candidate_pathway') !== -1)).toBe(false);
  });

  it('degrades safely when the case cannot take the Australian values yet: the case is still created', async () => {
    const d = add('au_vr', { noCase: true });
    h.emu.missingColumns = { registration_cases: ['pathway'] };
    const c = await t._ensureRegCase(d.userId);
    expect(c).toBeTruthy();
    expect(c.user_id).toBe(d.userId);
    expect(cases().filter((r) => r.user_id === d.userId).length).toBe(1);
    // ... and even then the doctor is not TOLD they are at MyIntealth.
    h.emu.missingColumns = {};
    const view = await t.buildAuJourneyView(d.userId, await t.resolveCandidatePathway(d.userId));
    expect(view.stage).toBe('placement');
  });

  it('pathway unreadable: falls back to today\'s case rather than guessing Australian', async () => {
    const d = add('au_vr', { noCase: true });
    h.emu.failTables = { user_profiles: 500 };
    const c = await t._ensureRegCase(d.userId);
    h.emu.failTables = {};
    expect(c.stage).toBe('myintealth');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('what the GP app and staff are told (APP-08): never myintealth for an Australian doctor', () => {
  it('GET /api/auth/session carries the Australian stage and ladder under a new key', async () => {
    const d = add('au_vr');
    const res = await h.get('/api/auth/session', { cookie: h.gpCookie(d.email, d.userId) });
    expect(res.status).toBe(200);
    expect(res.json.auPathway).toEqual({ pathway: 'au_vr', segment: 'A', isAu: true, launched: true });
    expect(res.json.auJourney).toEqual({
      ladder: 'au', pathway: 'au_vr', stage: 'placement', stageLabel: 'Secure placement', stageIndex: 0, stageKnown: true,
      stages: [
        { key: 'placement', label: 'Secure placement', index: 0, state: 'current' },
        { key: 'prestart', label: 'Pre-start checks', index: 1, state: 'upcoming' },
        { key: 'commenced', label: 'Started', index: 2, state: 'upcoming' },
        { key: 'guarantee', label: 'Settling in', index: 3, state: 'upcoming' },
        { key: 'complete', label: 'Complete', index: 4, state: 'upcoming' }
      ],
      // WP-12 added two keys to this block: the four steps a DOCTOR is shown
      // (lib/au-gp-app.js) and where "continue" leads. The ladder above is
      // unchanged.
      steps: [
        { key: 'placement', title: 'Secure placement', description: 'Find the practice that suits you, interview and sign.', href: '/pages/career', num: 1, state: 'current', done: false, locked: false, lockReason: null },
        { key: 'prestart', title: 'Pre-start checks', description: 'The short list to finish before your first day.', href: '/pages/prestart', num: 2, state: 'locked', done: false, locked: true, lockReason: 'Opens once your placement is secured' },
        { key: 'provider_number', title: 'Medicare provider number', description: 'Your new practice location needs its own provider number.', href: '/pages/pbs', num: 3, state: 'locked', done: false, locked: true, lockReason: 'Opens once your placement is secured' },
        { key: 'start', title: 'Start date', description: 'Your start date, agreed with you and the practice.', href: '/pages/prestart#start-date', num: 4, state: 'locked', done: false, locked: true, lockReason: 'Opens once your placement is secured' }
      ],
      entryRoute: '/pages/career'
    });
    expect(res.raw).not.toMatch(/myintealth|\bamc\b|epic|visa|overseas|guarantee period/i);
    // Existing keys are all still there.
    expect(res.json).toMatchObject({ ok: true, authenticated: true, auPathwayEnabled: true });
  });

  it('a later stage marks the earlier rungs done', async () => {
    const d = add('au_vr', { caseRow: { stage: 'commenced' } });
    const j = (await h.get('/api/auth/session', { cookie: h.gpCookie(d.email, d.userId) })).json.auJourney;
    expect(j.stage).toBe('commenced');
    expect(j.stages.map((s) => s.state)).toEqual(['done', 'done', 'current', 'upcoming', 'upcoming']);
  });

  it('a case still parked at myintealth (not moved over yet) is reported as placement, never myintealth', async () => {
    const d = add('au_vr', { caseRow: { stage: 'myintealth' } });
    const res = await h.get('/api/auth/session', { cookie: h.gpCookie(d.email, d.userId) });
    expect(res.json.auJourney.stage).toBe('placement');
    expect(res.raw).not.toMatch(/myintealth/i);
  });

  it('OVERSEAS: no auJourney key, switch on; and the response is the switch-off one plus the two WP-02 keys', async () => {
    const d = add('overseas_null');
    const cookie = h.gpCookie(d.email, d.userId);
    const on = await h.get('/api/auth/session', { cookie });
    expect(Object.keys(on.json).sort()).toEqual(['auPathway', 'auPathwayEnabled', 'authenticated', 'ok', 'profile']);
    h.setSwitch(false);
    const off = await h.get('/api/auth/session', { cookie });
    expect(off.raw).toBe(JSON.stringify({ ok: true, authenticated: true, profile: { email: d.email, supabaseUserId: d.userId } }));
  });

  it('SWITCH OFF: a stored au_vr doctor gets no auJourney key', async () => {
    const d = add('au_vr');
    h.setSwitch(false);
    const res = await h.get('/api/auth/session', { cookie: h.gpCookie(d.email, d.userId) });
    expect(res.json.auJourney).toBeUndefined();
    expect(await t.buildAuJourneyView(d.userId, { isAu: true, pathway: 'au_vr' })).toBe(null);
  });

  it('staff lists: the stage index and rail label used by the candidate profile and the intent score', () => {
    // An Australian stage used to fall through to index 0, i.e. read as MyIntealth.
    expect(t.atsRegStageIndexForTest('myintealth')).toBe(0);
    expect(t.atsRegStageIndexForTest('placement')).toBe(2);
    expect(t.atsRegStageIndexForTest('prestart')).toBe(3);
    expect(t.atsRegStageIndexForTest('commenced')).toBe(5);
    expect(t.atsRegStageIndexForTest('guarantee')).toBe(5);
    expect(t.atsRegStageIndexForTest('complete')).toBe(6);
    expect(t.atsRailLabelForTest('prestart')).toBe('Pre-start');
    expect(t.atsRailLabelForTest('guarantee')).toBe('Guarantee period');
    // Overseas answers unchanged.
    expect(['amc', 'career', 'ahpra', 'pbs', 'visa', 'commencement'].map(t.atsRegStageIndexForTest)).toEqual([1, 2, 3, 4, 4, 5]);
    expect(t.atsRailLabelForTest('career')).toBe('Secure Placement');
    expect(t.atsRailLabelForTest('')).toBe('—');
    expect(t.atsRegStageIndexForTest('zzz')).toBe(0);
    expect(t.atsRailLabelForTest('zzz')).toBe('zzz');
  });

  it('the stalled-doctor position is the Australian stage, and the overseas stage reminder stands down (APP-14)', async () => {
    const d = add('au_vr', { state: { gp_epic_progress: epicDone } });
    const pos = await t.resolveGpJourneyPositionForTest(d.userId, 'placement', null);
    expect(pos).toMatchObject({ phase: 'registration', stage: 'placement', ladder: 'au', pathway: 'au_vr', substage: null });
    const parked = await t.resolveGpJourneyPositionForTest(d.userId, 'myintealth', 'create_account');
    expect(parked.stage).toBe('placement');
    // Changed deliberately by WP-17 (N17): an Australian doctor now has a
    // stalled reminder of their own, which goes only when something is
    // waiting on THEM. Nothing is waiting on this doctor, so nothing is sent
    // (and the overseas stage reminder still never is).
    expect(await t.sendStalledNudgeForPositionForTest(pos)).toEqual({ ok: false, skipped: 'nothing_for_doctor' });
  });

  it('OVERSEAS: the stalled-doctor position is exactly as before, switch on and off', async () => {
    const d = add('overseas_null', { state: { gp_epic_progress: epicDone } });
    const on = await t.resolveGpJourneyPositionForTest(d.userId, 'myintealth', null);
    h.setSwitch(false);
    const off = await t.resolveGpJourneyPositionForTest(d.userId, 'myintealth', null);
    expect(on).toEqual(off);
    expect(on).toMatchObject({ phase: 'registration', stage: 'amc' });
    expect(on.ladder).toBeUndefined();
  });

  it('the overseas-only step pages are not served to an Australian doctor', async () => {
    const au = add('au_vr', { caseRow: { stage: 'prestart' }, state: { gp_career_state: { career_secured: true } } });
    const os = add('overseas_null');
    for (const page of ['/pages/myinthealth', '/pages/amc', '/pages/ahpra', '/pages/visa']) {
      const res = await h.get(page, { cookie: h.gpCookie(au.email, au.userId) });
      expect(res.status, page).toBe(302);
      expect(res.headers.location, page).toBe('/pages/index');
    }
    // An overseas doctor is gated exactly as with the switch off.
    for (const page of ['/pages/myinthealth', '/pages/ahpra', '/pages/career']) {
      h.setSwitch(true);
      const on = await h.get(page, { cookie: h.gpCookie(os.email, os.userId) });
      h.setSwitch(false);
      const off = await h.get(page, { cookie: h.gpCookie(os.email, os.userId) });
      expect([on.status, on.headers.location], page).toEqual([off.status, off.headers.location]);
    }
    // Switch off: the Australian-stored doctor is an overseas doctor again.
    h.setSwitch(false);
    const offAu = await h.get('/pages/ahpra', { cookie: h.gpCookie(au.email, au.userId) });
    expect(offAu.headers.location).not.toBe('/pages/index');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('advanceAuCaseStage: forward only, one timeline entry', () => {
  it('walks the whole ladder forward, logging each move', async () => {
    const d = add('au_vr');
    const id = caseOf(d).id;
    expect(await t.advanceAuCaseStage(id, 'prestart', STAFF_EMAIL, { reason: 'test' })).toMatchObject({ ok: true, moved: true, from: 'placement', to: 'prestart' });
    expect(await t.advanceAuCaseStage(id, 'commenced', STAFF_EMAIL)).toMatchObject({ ok: true, moved: true });
    expect(await t.advanceAuCaseStage(id, 'guarantee', STAFF_EMAIL)).toMatchObject({ ok: true, moved: true });
    expect(await t.advanceAuCaseStage(id, 'complete', STAFF_EMAIL)).toMatchObject({ ok: true, moved: true });
    expect(caseOf(d).stage).toBe('complete');
    expect(caseOf(d).completed_at).toBeTruthy();
    const log = stageChanges(d);
    expect(log.map((e) => [e.metadata.from_stage, e.metadata.to_stage])).toEqual(
      [['placement', 'prestart'], ['prestart', 'commenced'], ['commenced', 'guarantee'], ['guarantee', 'complete']]);
    expect(log[0]).toMatchObject({ title: 'Stage advanced to prestart', actor: STAFF_EMAIL, detail: 'test' });
    expect(log[0].metadata).toMatchObject({ ladder: 'au', pathway: 'au_vr' });
  });

  it('the same move twice is a no-op with no second timeline entry', async () => {
    const d = add('au_vr');
    const id = caseOf(d).id;
    await t.advanceAuCaseStage(id, 'prestart', 'system');
    expect(await t.advanceAuCaseStage(id, 'prestart', 'system')).toMatchObject({ ok: true, moved: false, reason: 'already_there' });
    expect(stageChanges(d).length).toBe(1);
  });

  it('refuses a backward move, an overseas stage and nonsense, and writes nothing', async () => {
    const d = add('au_vr', { caseRow: { stage: 'commenced' } });
    const id = caseOf(d).id;
    expect(await t.advanceAuCaseStage(id, 'prestart', STAFF_EMAIL)).toMatchObject({ ok: false, moved: false, reason: 'backward_move' });
    expect(await t.advanceAuCaseStage(id, 'placement', STAFF_EMAIL)).toMatchObject({ ok: false, reason: 'backward_move' });
    for (const bad of ['myintealth', 'amc', 'ahpra', 'visa', 'pbs', 'commencement', 'career', '', null, 'zzz']) {
      expect(await t.advanceAuCaseStage(id, bad, STAFF_EMAIL), String(bad)).toMatchObject({ ok: false, moved: false, reason: 'invalid_stage' });
    }
    expect(caseOf(d).stage).toBe('commenced');
    expect(stageChanges(d)).toEqual([]);
    expect(await t.advanceAuCaseStage('no-such-case', 'prestart', STAFF_EMAIL)).toMatchObject({ ok: false, reason: 'case_not_found' });
  });

  it('never moves an overseas doctor\'s case, even to a stage on the Australian ladder', async () => {
    for (const kind of ['overseas_null', 'overseas_explicit']) {
      const d = add(kind);
      for (const to of ['placement', 'prestart', 'complete']) {
        expect(await t.advanceAuCaseStage(caseOf(d).id, to, STAFF_EMAIL)).toMatchObject({ ok: false, moved: false, reason: 'not_au_pathway' });
      }
      expect(caseOf(d).stage).toBe('myintealth');
      expect(stageChanges(d)).toEqual([]);
    }
  });

  it('SWITCH OFF: refuses and asks the database nothing', async () => {
    const d = add('au_vr');
    h.setSwitch(false);
    h.emu.reset();
    expect(await t.advanceAuCaseStage(caseOf(d).id, 'prestart', STAFF_EMAIL)).toEqual({ ok: false, moved: false, reason: 'feature_off' });
    expect(await t.syncCaseToPathway(d.userId)).toEqual({ ok: false, moved: false, reason: 'feature_off' });
    expect(await t.auMoveCaseOnPlacement(d.userId)).toEqual({ ok: false, moved: false, reason: 'feature_off' });
    expect(await t.checkVerifiedStageForCase(caseOf(d).id, 'prestart')).toBe(null);
    // Changed deliberately by WP-06 (carry-over F1). This used to expect
    // { mode: 'overseas' } for a case stored at 'placement', which is exactly
    // what let the overseas stage code rewrite an Australian stage once the
    // switch was turned off. A case whose STORED stage is an Australian-ladder
    // value is now held, still without a query. An overseas stage is
    // 'overseas' as before.
    expect(await t._auStageModeFor(d.userId, caseOf(d))).toEqual({ mode: 'hold', pathway: null, strandedAuStage: true, storedPathway: null });
    expect(await t._auStageModeFor(d.userId, { stage: 'myintealth' })).toEqual({ mode: 'overseas', pathway: null });
    expect(h.emu.requests).toEqual([]);
    expect(caseOf(d).stage).toBe('placement');
  });

  it('pathway unreadable: refuses rather than guessing', async () => {
    const d = add('au_vr');
    h.emu.failTables = { user_profiles: 500 };
    const res = await t.advanceAuCaseStage(caseOf(d).id, 'prestart', STAFF_EMAIL);
    h.emu.failTables = {};
    expect(res).toMatchObject({ ok: false, moved: false, reason: 'pathway_unreadable' });
    expect(caseOf(d).stage).toBe('placement');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('syncCaseToPathway: a doctor who signed up before their pathway was set', () => {
  it('no pathway (case at myintealth) -> set to au_vr -> placement, exactly once', async () => {
    const d = add('overseas_null');
    expect(caseOf(d).stage).toBe('myintealth');
    const set = await t.setCandidatePathway(d.userId, { pathway: 'au_vr', setBy: STAFF_EMAIL, confirmed: true });
    expect(set).toMatchObject({ ok: true, pathway: 'au_vr', mirroredCases: 1 });
    expect(set.caseStage).toMatchObject({ ok: true, moved: true, from: 'myintealth', to: 'placement' });
    expect(caseOf(d)).toMatchObject({ stage: 'placement', pathway: 'au_vr', substage: null });
    expect(stageChanges(d).length).toBe(1);
    expect(stageChanges(d)[0].metadata).toMatchObject({ from_stage: 'myintealth', to_stage: 'placement', ladder: 'au' });

    // Setting it again is a no-op.
    const again = await t.setCandidatePathway(d.userId, { pathway: 'au_vr', setBy: STAFF_EMAIL, confirmed: true });
    expect(again.caseStage).toMatchObject({ ok: true, moved: false, reason: 'already_on_ladder' });
    expect(await t.syncCaseToPathway(d.userId)).toMatchObject({ ok: true, moved: false });
    expect(caseOf(d).stage).toBe('placement');
    expect(stageChanges(d).length).toBe(1);
  });

  it('a self-declared pathway (WP-05 onboarding) moves the case too', async () => {
    const d = add('overseas_null');
    const set = await t.setCandidatePathway(d.userId, { pathway: 'au_vr', setBy: 'self', confirmed: false });
    expect(set.caseStage).toMatchObject({ moved: true, to: 'placement' });
    expect(caseOf(d).stage).toBe('placement');
  });

  it('a doctor already placed when the pathway is set lands on prestart', async () => {
    const d = add('overseas_null', { caseRow: { stage: 'ahpra' } });
    h.emu.table('placements').push({ id: 'pl-sync-1', user_id: d.userId, application_id: 'app-sync-1', status: 'active' });
    const set = await t.setCandidatePathway(d.userId, { pathway: 'au_restricted', setBy: STAFF_EMAIL, confirmed: true });
    expect(set.caseStage).toMatchObject({ moved: true, from: 'ahpra', to: 'prestart' });
  });

  it('never demotes an Australian case', async () => {
    for (const stage of ['prestart', 'commenced', 'guarantee', 'complete']) {
      const d = add('au_vr', { caseRow: { stage } });
      expect(await t.syncCaseToPathway(d.userId)).toMatchObject({ ok: true, moved: false });
      // Changing between Australian pathways does not move it either.
      const set = await t.setCandidatePathway(d.userId, { pathway: 'au_restricted', setBy: STAFF_EMAIL, confirmed: true });
      expect(set.caseStage.moved).toBe(false);
      expect(caseOf(d).stage).toBe(stage);
      expect(stageChanges(d)).toEqual([]);
    }
  });

  it('an overseas doctor is never moved: nothing recorded, recorded overseas, or set to overseas', async () => {
    const a = add('overseas_null', { caseRow: { stage: 'amc' } });
    expect(await t.syncCaseToPathway(a.userId)).toMatchObject({ ok: true, moved: false, reason: 'overseas_unchanged' });
    const b = add('overseas_explicit', { caseRow: { stage: 'ahpra' } });
    expect(await t.syncCaseToPathway(b.userId)).toMatchObject({ ok: true, moved: false, reason: 'overseas_unchanged' });
    const c = add('overseas_null', { caseRow: { stage: 'visa' } });
    const set = await t.setCandidatePathway(c.userId, { pathway: 'overseas_pep', setBy: STAFF_EMAIL, confirmed: true });
    expect(set.caseStage).toMatchObject({ ok: true, moved: false });
    expect([caseOf(a).stage, caseOf(b).stage, caseOf(c).stage]).toEqual(['amc', 'ahpra', 'visa']);
    [a, b, c].forEach((d) => expect(stageChanges(d)).toEqual([]));
    expect(h.emu.requests.filter((r) => r.table === 'registration_cases' && r.bodyKeys.indexOf('stage') !== -1)).toEqual([]);
  });

  it('staff correct Australian -> overseas: the case goes back to the stage the state derives', async () => {
    const d = add('au_vr', { caseRow: { stage: 'prestart' }, state: { gp_epic_progress: epicDone } });
    const set = await t.setCandidatePathway(d.userId, { pathway: 'overseas_esp', setBy: STAFF_EMAIL, confirmed: true });
    expect(set.caseStage).toMatchObject({ ok: true, moved: true, from: 'prestart', to: 'amc' });
    expect(caseOf(d)).toMatchObject({ stage: 'amc', pathway: 'overseas_esp' });
    expect(stageChanges(d)[0].metadata).toMatchObject({ from_stage: 'prestart', to_stage: 'amc', ladder: 'overseas' });
    // Clearing the pathway altogether does the same.
    const e = add('au_vr');
    const cleared = await t.setCandidatePathway(e.userId, { pathway: null, setBy: STAFF_EMAIL });
    expect(cleared.caseStage).toMatchObject({ moved: true, from: 'placement', to: 'myintealth' });
    expect(caseOf(e).stage).toBe('myintealth');
  });

  it('a doctor with no case yet: nothing to move, and nothing is created', async () => {
    const d = add('overseas_null', { noCase: true });
    const set = await t.setCandidatePathway(d.userId, { pathway: 'au_vr', setBy: STAFF_EMAIL, confirmed: true });
    expect(set.caseStage).toMatchObject({ ok: true, moved: false, reason: 'no_case' });
    expect(caseOf(d)).toBeUndefined();
    // ... and when the case IS created it starts in the right place.
    expect((await t._ensureRegCase(d.userId)).stage).toBe('placement');
  });

  it('the staff pathway endpoint moves the case as part of the same request', async () => {
    const d = add('overseas_null');
    const res = await h.post('/api/admin/candidate/pathway', { user_id: d.userId, pathway: 'au_vr' }, h.superAdmin());
    expect(res.status).toBe(200);
    expect(caseOf(d)).toMatchObject({ stage: 'placement', pathway: 'au_vr' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('moves to prestart when a placement is recorded (each entry point)', () => {
  it('entry point 1, finalizeInAppPlacement (offer accepted / staff "record placement" / signed contract)', async () => {
    const d = add('au_vr');
    const app = { id: 'app-fin-' + d.userId.slice(-4), user_id: d.userId, career_role_id: null, ats_stage: 'offer', status: 'applied', provider_role_id: '' };
    h.emu.table('gp_applications').push(app);
    const offer = { id: 'offer-fin-1', application_id: app.id, user_id: d.userId, status: 'sent', practice_name: 'Test Metro Practice (FAKE)', job_title: 'GP', sent_by: STAFF_EMAIL };
    await t.finalizeInAppPlacementForTest(Object.assign({}, app), offer, d.userId, d.email, { placementConfirmed: true });
    expect(caseOf(d).stage).toBe('prestart');
    const log = stageChanges(d);
    expect(log.length).toBe(1);
    expect(log[0].metadata).toMatchObject({ from_stage: 'placement', to_stage: 'prestart', ladder: 'au' });
    // The placement really was recorded.
    expect(h.emu.table('placements').some((p) => p.user_id === d.userId && p.status === 'active')).toBe(true);
    // No overseas unlock keys were stamped on the doctor's state.
    ['gp_registration_return_overrides', 'gp_admin_stage_override', 'gp_stage_override_at'].forEach((k) => {
      expect(stateOf(d)[k], k).toBeUndefined();
    });
  });

  it('entry point 1 still moves the case when the doctor has no state row (the automation pass is skipped)', async () => {
    const d = add('au_vr');
    const rows = h.emu.table('user_state');
    rows.splice(rows.findIndex((r) => r.user_id === d.userId), 1);
    const app = { id: 'app-nostate-' + d.userId.slice(-4), user_id: d.userId, career_role_id: null, ats_stage: 'offer', status: 'applied', provider_role_id: '' };
    h.emu.table('gp_applications').push(app);
    await t.finalizeInAppPlacementForTest(Object.assign({}, app), { application_id: app.id, status: 'sent' }, d.userId, d.email, { placementConfirmed: true });
    expect(caseOf(d).stage).toBe('prestart');
    expect(stageChanges(d).length).toBe(1);
  });

  it('entry point 2, the state-change path: moves once the placement is on record', async () => {
    const d = add('au_vr');
    h.emu.table('gp_applications').push({ id: 'app-state-' + d.userId.slice(-4), user_id: d.userId, status: 'placement_secured', ats_stage: 'hired' });
    await automate(d, { gp_career_state: { career_secured: true, applications: [{ id: 'x', isPlacementSecured: true }] } },
      { gp_career_state: { career_secured: false } });
    expect(caseOf(d).stage).toBe('prestart');
    expect(stageChanges(d).length).toBe(1);
    // Later syncs change nothing.
    await automate(d, { gp_career_intro_seen: true });
    await automate(d, { gp_epic_progress: epicDone });
    expect(caseOf(d).stage).toBe('prestart');
    expect(stageChanges(d).length).toBe(1);
  });

  it('entry point 2 over HTTP: PUT /api/state from the doctor\'s browser', async () => {
    const d = add('au_vr');
    h.emu.table('placements').push({ id: 'pl-http-' + d.userId.slice(-4), user_id: d.userId, application_id: 'app-http', status: 'active' });
    const res = await h.put('/api/state', { state: { gp_career_intro_seen: true }, updatedAt: new Date().toISOString() },
      { cookie: h.gpCookie(d.email, d.userId) });
    expect(res.status).toBe(200);
    for (let i = 0; i < 100 && caseOf(d).stage !== 'prestart'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(caseOf(d).stage).toBe('prestart');
  });

  it('a kanban card merely dragged to Hired is not a recorded placement (staff can drag it back; the stage cannot go back)', async () => {
    const d = add('au_vr');
    h.emu.table('gp_applications').push({ id: 'app-drag-' + d.userId.slice(-4), user_id: d.userId, status: 'applied', ats_stage: 'hired' });
    expect(await t._auPlacementSecuredFact(d.userId)).toBe(false);
    expect(await t.auMoveCaseOnPlacement(d.userId, { source: 'test' })).toMatchObject({ ok: true, moved: false, reason: 'no_placement' });
    expect(caseOf(d).stage).toBe('placement');
  });

  it('entry point 3, the ops replay / any later pass: a placement recorded while nothing was listening is picked up', async () => {
    const d = add('au_vr');
    h.emu.table('gp_applications').push({ id: 'app-late-' + d.userId.slice(-4), user_id: d.userId, status: 'placement_secured', ats_stage: 'hired' });
    expect(await t.auMoveCaseOnPlacement(d.userId, { source: 'test' })).toMatchObject({ ok: true, moved: true, from: 'placement', to: 'prestart' });
    expect(await t.auMoveCaseOnPlacement(d.userId, { source: 'test' })).toMatchObject({ ok: true, moved: false, reason: 'already_past_placement' });
    expect(stageChanges(d).length).toBe(1);
  });

  it('the browser saying "secured" is NOT a placement: with nothing on record the case stays at placement', async () => {
    const d = add('au_vr');
    await automate(d, { gp_career_state: { career_secured: true, secured: true, applications: [{ id: 'fake', status: 'placement_secured', isPlacementSecured: true }] } },
      { gp_career_state: {} });
    expect(caseOf(d).stage).toBe('placement');
    expect(stageChanges(d)).toEqual([]);
    expect(await t._auPlacementSecuredFact(d.userId)).toBe(false);
  });

  it('an ended or cancelled placement, or a live application that is not secured, does not count', async () => {
    const d = add('au_vr');
    h.emu.table('placements').push({ id: 'pl-ended-' + d.userId.slice(-4), user_id: d.userId, status: 'ended' });
    h.emu.table('gp_applications').push({ id: 'app-live-' + d.userId.slice(-4), user_id: d.userId, status: 'applied', ats_stage: 'interview' });
    expect(await t._auPlacementSecuredFact(d.userId)).toBe(false);
    expect(await t.auMoveCaseOnPlacement(d.userId)).toMatchObject({ moved: false, reason: 'no_placement' });
  });

  it('an OVERSEAS doctor\'s placement leaves the stage to the overseas derivation', async () => {
    const d = add('overseas_null', { state: { gp_epic_progress: epicDone, gp_amc_progress: amcDone } });
    h.emu.table('placements').push({ id: 'pl-os-' + d.userId.slice(-4), user_id: d.userId, status: 'active' });
    expect(await t.auMoveCaseOnPlacement(d.userId)).toMatchObject({ ok: true, moved: false, reason: 'not_au_pathway' });
    await automate(d, { gp_career_state: { career_secured: true } }, { gp_career_state: {} });
    expect(caseOf(d).stage).toBe('ahpra');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('stray overseas state flags never change an Australian stage', () => {
  const STRAY = [
    ['EPIC verified', { gp_epic_progress: epicDone }],
    ['EPIC + AMC verified', { gp_epic_progress: epicDone, gp_amc_progress: amcDone }],
    ['everything verified', { gp_epic_progress: epicDone, gp_amc_progress: amcDone, gp_ahpra_progress: ahpraDone, gp_career_state: { career_secured: true } }],
    ['as JSON strings', { gp_epic_progress: JSON.stringify(epicDone), gp_amc_progress: JSON.stringify(amcDone) }],
    ['blank progress', { gp_epic_progress: {}, gp_amc_progress: {} }]
  ];

  for (const stage of ['placement', 'prestart', 'commenced', 'guarantee', 'complete']) {
    it('an au_vr case at ' + stage + ' stays there', async () => {
      const d = add('au_vr', { caseRow: { stage } });
      for (const [label, flags] of STRAY) {
        await automate(d, flags);
        expect(caseOf(d).stage, label).toBe(stage);
      }
      expect(stageChanges(d)).toEqual([]);
      expect(stageWrites(d)).toEqual([]);
      // The overseas unlock keys the derivation stamps are never written.
      ['gp_registration_return_overrides', 'gp_admin_stage_override', 'gp_stage_override_at'].forEach((k) => {
        expect(stateOf(d)[k], k).toBeUndefined();
      });
      // The doctor's activity is still recorded.
      expect(caseOf(d).last_gp_activity_at).toBeTruthy();
    });
  }

  it('over HTTP: a PUT /api/state full of overseas flags leaves the Australian case where it is', async () => {
    const d = add('au_vr');
    const res = await h.put('/api/state', {
      state: { gp_epic_progress: Object.assign({ updatedAt: new Date().toISOString() }, epicDone), gp_amc_progress: Object.assign({ updatedAt: new Date().toISOString() }, amcDone) },
      updatedAt: new Date().toISOString()
    }, { cookie: h.gpCookie(d.email, d.userId) });
    expect(res.status).toBe(200);
    for (let i = 0; i < 100 && !caseOf(d).last_gp_activity_at; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 60));
    expect(caseOf(d).stage).toBe('placement');
    expect(stageChanges(d)).toEqual([]);
  });

  it('a case not yet on the Australian ladder is moved onto it by the next sync, not derived', async () => {
    const d = add('au_vr', { caseRow: { stage: 'myintealth' } });
    await automate(d, { gp_epic_progress: epicDone, gp_amc_progress: amcDone });
    expect(caseOf(d).stage).toBe('placement');
  });

  it('pathway unreadable and the case looks Australian: the stage is not touched at all', async () => {
    const d = add('au_vr', { caseRow: { stage: 'prestart' } });
    expect(await t._auStageModeFor(d.userId, caseOf(d))).toEqual({ mode: 'au', pathway: 'au_vr' });
    h.emu.failTables = { user_profiles: 500 };
    expect(await t._auStageModeFor(d.userId, caseOf(d))).toEqual({ mode: 'hold', pathway: null });
    expect(await t._auStageModeFor(d.userId, { stage: 'myintealth', pathway: null })).toEqual({ mode: 'overseas', pathway: null });
    h.emu.failTables = {};
  });

  it('the bulk case sync never rewrites an Australian case, and still derives overseas ones', async () => {
    const au = add('au_vr', { caseRow: { stage: 'prestart' }, state: { gp_epic_progress: epicDone } });
    const au2 = add('au_registrar', { state: { gp_epic_progress: epicDone, gp_amc_progress: amcDone } });
    const os = add('overseas_null', { state: { gp_epic_progress: epicDone } });
    const res = await h.post('/api/admin/cases/sync', {}, h.superAdmin());
    expect(res.status).toBe(200);
    expect(caseOf(au).stage).toBe('prestart');
    expect(caseOf(au2).stage).toBe('placement');
    expect(caseOf(os).stage).toBe('amc');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the staff stage setter is pathway-aware (ADM-05)', () => {
  const setStage = (d, stage, who) => h.put('/api/admin/case?id=' + caseOf(d).id, { gp_verified_stage: stage }, who || h.superAdmin());

  it('Australian doctor: an Australian stage moves the case and writes NO EPIC / AMC / AHPRA flag', async () => {
    const d = add('au_vr');
    const before = JSON.stringify(stateOf(d));
    const res = await setStage(d, 'prestart');
    expect(res.status).toBe(200);
    expect(caseOf(d)).toMatchObject({ stage: 'prestart', gp_verified_stage: 'prestart' });
    // The doctor's state is byte-for-byte what it was.
    expect(JSON.stringify(stateOf(d))).toBe(before);
    OVERSEAS_FLAG_KEYS.concat(['gp_link_updates']).forEach((k) => expect(stateOf(d)[k], k).toBeUndefined());
    expect(h.emu.requests.filter((r) => r.table === 'user_state' && r.method !== 'GET')).toEqual([]);
    expect(stageChanges(d).length).toBe(1);
    expect(stageChanges(d)[0]).toMatchObject({ actor: h.SUPER_EMAIL });
  });

  it('Australian doctor: every overseas stage is refused with a plain message and nothing is written', async () => {
    const d = add('au_vr');
    const before = JSON.stringify([caseOf(d), stateOf(d)]);
    for (const stage of ['myintealth', 'amc', 'career', 'ahpra', 'visa', 'pbs', 'commencement']) {
      const res = await setStage(d, stage);
      expect(res.status, stage).toBe(400);
      expect(res.json).toMatchObject({ ok: false, code: 'stage_not_allowed_for_pathway' });
      expect(res.json.message).toMatch(/Australian pathway/);
      expect(res.json.message).toMatch(/placement, prestart, commenced, guarantee, complete/);
    }
    expect(JSON.stringify([caseOf(d), stateOf(d)])).toBe(before);
    expect(h.emu.requests.filter((r) => r.method !== 'GET' && (r.table === 'registration_cases' || r.table === 'user_state'))).toEqual([]);
  });

  it('Australian doctor: moving backwards is refused (409), forwards and "no change" are fine', async () => {
    const d = add('au_vr', { caseRow: { stage: 'commenced' } });
    const back = await setStage(d, 'prestart');
    expect(back.status).toBe(409);
    expect(back.json.message).toMatch(/only moves forward/);
    expect(caseOf(d).stage).toBe('commenced');
    expect((await setStage(d, 'commenced')).status).toBe(200);
    expect((await setStage(d, 'guarantee')).status).toBe(200);
    expect(caseOf(d).stage).toBe('guarantee');
    // Clearing the control writes nothing into the doctor's state either.
    const before = JSON.stringify(stateOf(d));
    expect((await setStage(d, '')).status).toBe(200);
    expect(JSON.stringify(stateOf(d))).toBe(before);
    expect(caseOf(d).stage).toBe('guarantee');
  });

  it('the internal propagation helper cannot be used to fabricate milestones either (e.g. the registration-granted flow)', async () => {
    const d = add('au_vr');
    const before = JSON.stringify(stateOf(d));
    const out = await t.applyVerifiedStageToGp(caseOf(d).id, d.userId, 'visa', 'system', { reason: 'AHPRA registration granted', fromStage: 'placement' });
    expect(out.ok).toBe(false);
    expect(caseOf(d).stage).toBe('placement');
    expect(JSON.stringify(stateOf(d))).toBe(before);
  });

  it('the second case endpoint (/api/admin/ops/case) applies the same check', async () => {
    const d = add('au_vr');
    const bad = await h.put('/api/admin/ops/case?id=' + caseOf(d).id, { gp_verified_stage: 'amc' }, h.superAdmin());
    expect(bad.status).toBe(400);
    expect(caseOf(d).gp_verified_stage).toBeUndefined();
    const os = add('overseas_null');
    const badOs = await h.put('/api/admin/ops/case?id=' + caseOf(os).id, { gp_verified_stage: 'guarantee' }, h.superAdmin());
    expect(badOs.status).toBe(400);
    expect((await h.put('/api/admin/ops/case?id=' + caseOf(os).id, { gp_verified_stage: 'amc' }, h.superAdmin())).status).toBe(200);
  });

  it('OVERSEAS doctor: Australian stages are refused; nothing is written', async () => {
    const d = add('overseas_null');
    const before = JSON.stringify([caseOf(d), stateOf(d)]);
    for (const stage of ['prestart', 'commenced', 'guarantee']) {
      const res = await setStage(d, stage);
      expect(res.status, stage).toBe(400);
      expect(res.json.message).toMatch(/only for doctors on the Australian pathway/);
    }
    expect(JSON.stringify([caseOf(d), stateOf(d)])).toBe(before);
  });

  it('OVERSEAS doctor: behaves exactly as with the switch off (same case row, same state flags)', async () => {
    const snapshot = (d) => {
      const s = stateOf(d);
      const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
      return {
        stage: caseOf(d).stage, substage: caseOf(d).substage, verified: caseOf(d).gp_verified_stage,
        epic: parse(s.gp_epic_progress).completed, amc: parse(s.gp_amc_progress).completed, ahpra: parse(s.gp_ahpra_progress).completed,
        overrides: parse(s.gp_registration_return_overrides), override: parse(s.gp_admin_stage_override),
        note: (s.gp_link_updates || []).map((u) => u.title),
        log: stageChanges(d).map((e) => [e.title, e.metadata])
      };
    };
    for (const stage of ['myintealth', 'amc', 'career', 'ahpra', 'visa', 'pbs', 'commencement', 'placement']) {
      const on = add('overseas_null');
      const off = add('overseas_null');
      h.setSwitch(true);
      const resOn = await setStage(on, stage);
      h.setSwitch(false);
      const resOff = await setStage(off, stage);
      expect(resOn.status, stage).toBe(200);
      expect(resOff.status, stage).toBe(200);
      expect(snapshot(on), stage).toEqual(snapshot(off));
    }
    // And the flags really are written for an overseas doctor, as they always were.
    h.setSwitch(true);
    const d = add('overseas_null');
    await setStage(d, 'ahpra');
    expect(caseOf(d).stage).toBe('ahpra');
    expect(JSON.parse(stateOf(d).gp_epic_progress).completed.verification_issued).toBe(true);
    expect(JSON.parse(stateOf(d).gp_amc_progress).completed.qualifications_verified).toBe(true);
  });

  it('OVERSEAS doctor: the "placement" override never parks the case on the Australian ladder', async () => {
    // The live CHECK has always rejected stage 'placement', so this control has
    // always left the case row alone for it. It must stay that way now that
    // the value is legal for Australian cases.
    for (const on of [true, false]) {
      h.setSwitch(on);
      const d = add('overseas_null', { caseRow: { stage: 'amc' } });
      expect((await setStage(d, 'placement')).status).toBe(200);
      expect(caseOf(d).stage, 'switch ' + on).toBe('amc');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Reset GP and stage rollback are refused for an Australian doctor (ADM-05)', () => {
  it('Reset GP: 409 with a plain message, nothing touched, the refusal is audited', async () => {
    const d = add('au_vr', { caseRow: { stage: 'prestart' } });
    h.emu.table('registration_tasks').push({ id: 'task-keep-' + d.userId.slice(-4), case_id: caseOf(d).id, status: 'open', title: 'keep me' });
    const before = JSON.stringify([caseOf(d), stateOf(d)]);
    const res = await h.post('/api/admin/reset-gp', { email: d.email }, h.superAdmin());
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ ok: false, code: 'au_pathway' });
    expect(res.json.message).toMatch(/not available for a doctor on the Australian pathway/);
    expect(JSON.stringify([caseOf(d), stateOf(d)])).toBe(before);
    expect(h.emu.table('registration_tasks').find((x) => x.case_id === caseOf(d).id).status).toBe('open');
    expect(h.emu.requests.filter((r) => r.method === 'DELETE')).toEqual([]);
    const audit = h.emu.table('admin_audit_log').filter((a) => a.action === 'admin_reset_gp' && a.target_id === d.userId);
    expect(audit.length).toBe(1);
    expect(audit[0].success).toBe(false);
  });

  it('stage rollback: 409, the doctor\'s state is untouched', async () => {
    const d = add('au_vr');
    const before = JSON.stringify(stateOf(d));
    const res = await h.post('/api/admin/registration-return-overrides', { email: d.email, steps: { myintealth: true, amc: true } }, h.superAdmin());
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ ok: false, code: 'au_pathway' });
    expect(res.json.message).toMatch(/not available for a doctor on the Australian pathway/);
    expect(JSON.stringify(stateOf(d))).toBe(before);
  });

  it('OVERSEAS doctor: both still work, switch on and off, with the same outcome', async () => {
    const outcomes = [];
    for (const on of [true, false]) {
      h.setSwitch(on);
      const d = add('overseas_null');
      const roll = await h.post('/api/admin/registration-return-overrides', { email: d.email, steps: { myintealth: true } }, h.superAdmin());
      const overrides = stateOf(d).gp_registration_return_overrides;
      const reset = await h.post('/api/admin/reset-gp', { email: d.email }, h.superAdmin());
      outcomes.push({
        roll: roll.status, overrides, reset: reset.status, body: reset.json, stage: caseOf(d).stage,
        epic: stateOf(d).gp_epic_progress.completed, career: stateOf(d).gp_career_state
      });
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]).toMatchObject({ roll: 200, reset: 200, stage: 'ahpra', overrides: JSON.stringify({ myintealth: true }) });
  });

  it('SWITCH OFF: a stored au_vr doctor is an overseas doctor, so neither is refused', async () => {
    h.setSwitch(false);
    const d = add('au_vr', { caseRow: { stage: 'myintealth' } });
    expect((await h.post('/api/admin/registration-return-overrides', { email: d.email, steps: { amc: true } }, h.superAdmin())).status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('assistance-call stages (scheduled_calls.stage)', () => {
  const schedule = (d, stage) => h.post('/api/admin/calls/schedule',
    { case_id: caseOf(d).id, stage, notify_whatsapp: false, notify_email: false }, h.superAdmin());

  it('Australian doctor: prestart is accepted; MyIntealth / AMC / AHPRA and other stages are refused', async () => {
    const d = add('au_vr', { caseRow: { stage: 'prestart' } });
    for (const stage of ['myintealth', 'amc', 'ahpra', 'placement', 'commenced', 'zzz']) {
      const res = await schedule(d, stage);
      expect(res.status, stage).toBe(400);
      expect(res.json.message).toMatch(/Australian pathway/);
    }
    expect(h.emu.table('scheduled_calls').filter((c) => c.user_id === d.userId)).toEqual([]);
    const ok = await schedule(d, 'prestart');
    expect(ok.status).toBe(201);
    expect(h.emu.table('scheduled_calls').filter((c) => c.user_id === d.userId).map((c) => c.stage)).toEqual(['prestart']);
  });

  it('OVERSEAS doctor: exactly today\'s three, switch on and off', async () => {
    for (const on of [true, false]) {
      h.setSwitch(on);
      const d = add('overseas_null');
      for (const stage of ['prestart', 'placement', 'career', 'visa']) {
        const res = await schedule(d, stage);
        expect(res.status, stage).toBe(400);
        expect(res.json.message).toBe('Invalid stage. Must be one of: myintealth, amc, ahpra');
      }
      expect((await schedule(d, 'amc')).status).toBe(201);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('OVERSEAS REGRESSION: stages derive exactly as on main', () => {
  // The ladder on main (server.js _deriveStageFromState), written out by hand:
  // first gate that is not passed wins.
  const MATRIX = [
    ['nothing at all', {}, 'myintealth'],
    ['EPIC in progress', { gp_epic_progress: { stage: 'upload_qualifications', completed: { create_account: true } } }, 'myintealth'],
    ['EPIC verified', { gp_epic_progress: epicDone }, 'amc'],
    ['AMC verified but EPIC not', { gp_amc_progress: amcDone }, 'myintealth'],
    ['placement secured but EPIC not', { gp_career_state: { career_secured: true } }, 'myintealth'],
    ['EPIC + AMC verified', { gp_epic_progress: epicDone, gp_amc_progress: amcDone }, 'career'],
    ['EPIC + AMC + placement (career_secured)', { gp_epic_progress: epicDone, gp_amc_progress: amcDone, gp_career_state: { career_secured: true } }, 'ahpra'],
    ['EPIC + AMC + placement (legacy `secured`)', { gp_epic_progress: epicDone, gp_amc_progress: amcDone, gp_career_state: { secured: true } }, 'ahpra'],
    ['EPIC + AMC + placement (application flag)', { gp_epic_progress: epicDone, gp_amc_progress: amcDone, gp_career_state: { applications: [{ id: 'a', isPlacementSecured: true }] } }, 'ahpra'],
    ['EPIC + placement, AMC not verified', { gp_epic_progress: epicDone, gp_career_state: { career_secured: true } }, 'amc'],
    ['everything + AHPRA verified', { gp_epic_progress: epicDone, gp_amc_progress: amcDone, gp_career_state: { career_secured: true }, gp_ahpra_progress: ahpraDone }, 'visa'],
    ['AHPRA verified without placement', { gp_epic_progress: epicDone, gp_amc_progress: amcDone, gp_ahpra_progress: ahpraDone }, 'career'],
    ['values stored as JSON strings', { gp_epic_progress: JSON.stringify(epicDone), gp_amc_progress: JSON.stringify(amcDone) }, 'career'],
    ['"true" as a string is not verified', { gp_epic_progress: { completed: { verification_issued: 'true' } } }, 'myintealth']
  ];

  it('the pure derivation gives main\'s answer for every row, whatever the switch says', () => {
    for (const on of [true, false]) {
      h.setSwitch(on);
      MATRIX.forEach(([label, state, expected]) => expect(t._deriveStageFromStateForTest(state), label).toBe(expected));
    }
  });

  for (const [label, state, expected] of MATRIX) {
    it(label + ' -> ' + expected + ' (nothing recorded + switch ON; switch OFF; stored au_vr + switch OFF)', async () => {
      const run = async (d, on) => {
        h.setSwitch(on);
        h.emu.reset();
        await automate(d, state);
        return {
          stage: caseOf(d).stage,
          log: stageChanges(d).map((e) => [e.title, e.metadata]),
          override: stateOf(d).gp_admin_stage_override,
          overrides: stateOf(d).gp_registration_return_overrides
        };
      };
      const onNull = await run(add('overseas_null'), true);
      const offNull = await run(add('overseas_null'), false);
      // "Any doctor with the switch off": even one whose stored pathway is Australian.
      const offAu = await run(add('au_vr', { caseRow: { stage: 'myintealth' } }), false);
      expect(onNull.stage).toBe(expected);
      expect(offNull.stage).toBe(expected);
      expect(offAu.stage).toBe(expected);
      expect(onNull).toEqual(offNull);
      expect(offAu).toEqual(offNull);
      if (expected !== 'myintealth') {
        expect(onNull.log).toEqual([['Stage advanced to ' + expected, { from_stage: 'myintealth', to_stage: expected }]]);
        expect(JSON.parse(onNull.override)).toBe(expected);
      } else {
        expect(onNull.log).toEqual([]);
      }
    });
  }

  it('switch ON adds exactly one read (the pathway) to an overseas doctor\'s automation pass, and no write', async () => {
    const shape = (rs) => rs.map((r) => r.method + ' ' + r.table + ' ' + r.bodyKeys.join(','));
    const a = add('overseas_null');
    const b = add('overseas_null');
    h.setSwitch(true); h.emu.reset();
    await automate(a, { gp_epic_progress: epicDone });
    const on = shape(h.emu.requests);
    h.setSwitch(false); h.emu.reset();
    await automate(b, { gp_epic_progress: epicDone });
    const off = shape(h.emu.requests);
    const extra = on.slice();
    off.forEach((line) => { const i = extra.indexOf(line); if (i !== -1) extra.splice(i, 1); });
    expect(extra).toEqual(['GET user_profiles ']);
    expect(on.filter((l) => !/^GET/.test(l))).toEqual(off.filter((l) => !/^GET/.test(l)));
  });

  it('the state-sync regression guard is untouched: a blank progress object still cannot move an overseas doctor back', async () => {
    for (const on of [true, false]) {
      h.setSwitch(on);
      const d = add('overseas_null', { state: { gp_epic_progress: epicDone, gp_amc_progress: amcDone }, caseRow: { stage: 'career' } });
      const res = await h.put('/api/state', { state: { gp_epic_progress: { updatedAt: new Date().toISOString(), completed: {} } }, updatedAt: new Date().toISOString() },
        { cookie: h.gpCookie(d.email, d.userId) });
      expect(res.status).toBe(200);
      expect(t._deriveStageFromStateForTest(stateOf(d)), 'switch ' + on).toBe('career');
    }
  });
});

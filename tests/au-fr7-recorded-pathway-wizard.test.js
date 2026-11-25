/**
 * FR-7 (round 7 of the final review): the sign-up wizard follows the RECORDED
 * pathway.
 *
 * S7-01  A doctor staff had moved to an overseas pathway could carry on in the
 *        Australian wizard still open on their device; its saves re-armed the
 *        branch for every other device, and finishing it made them Australian
 *        again (self-declared), overwriting the staff member's choice.
 * S7-02  A doctor moved to overseas AFTER finishing the Australian sign-up was
 *        never asked today's sign-up questions, and nobody was told.
 * guide  A finished Australian doctor who opened /pages/onboarding was shown
 *        screen 1 again.
 *
 * And the other side of every rule: a doctor with nothing recorded (every
 * doctor today) answers the first question exactly as before, and with the
 * switch off none of it exists.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const candidatePathway = require('../lib/candidate-pathway.js');
const auOnboarding = require('../lib/au-onboarding.js');

const ROOT = path.resolve(__dirname, '..');
const onboardingJs = fs.readFileSync(path.join(ROOT, 'js/onboarding.js'), 'utf8');

let h;
let counter = 0;
const EMPTY = ['gp_nudge_log', 'gp_applications', 'user_roles', 'registration_tasks', 'task_timeline', 'notification_preferences', 'email_suppression',
  'site_enquiries', 'placements', 'user_documents', 'admin_audit_log', 'runtime_kv', 'onboarding_reminders', 'gp_credentials', 'registration_cases'];
function loadDb(doctors) {
  const db = buildAuFixtureDb(doctors);
  EMPTY.forEach((name) => { if (!db[name]) db[name] = []; });
  Object.keys(h.emu.db).forEach((name) => { if (name !== 'rso_team') delete h.emu.db[name]; });
  Object.keys(db).forEach((name) => { h.emu.db[name] = JSON.parse(JSON.stringify(db[name])); });
  h.emu.reset();
}
const rows = (table) => h.emu.db[table] || (h.emu.db[table] = []);
const row = (table, userId) => rows(table).find((r) => r.user_id === userId) || null;
const stateOf = (d) => { const r = row('user_state', d.userId); let s = r ? r.state : {}; if (typeof s === 'string') s = JSON.parse(s); return s || {}; };
const blobOf = (d) => { let b = stateOf(d).gp_onboarding; if (typeof b === 'string') b = JSON.parse(b); return b || null; };
const caseOf = (d) => row('registration_cases', d.userId);
const tasksOf = (d) => { const c = caseOf(d); return c ? rows('registration_tasks').filter((x) => x.case_id === c.id) : []; };
const timelineOf = (d) => { const c = caseOf(d); return c ? rows('task_timeline').filter((x) => x.case_id === c.id) : []; };
const TASK_SOURCE = 'au_moved_overseas_needs_onboarding';
function fresh() {
  counter += 1;
  const d = buildAuDoctor('overseas_null', { idSuffix: 'w' + counter, noCase: true,
    profile: { first_name: 'Testw' + counter, registration_country: '', qualification_country: '', preferred_city: '', onboarding_completed_at: null } });
  d.state.state = {};
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}
function auBody(over, top) {
  return Object.assign({
    _version: 2, currentStep: 4, country: '', registerNumber: '', qualDocs: {}, accountReviewFlag: false,
    targetDate: '', preferredCity: '', whoMoving: '', childrenCount: 1, childrenAges: [],
    leadSource: 'google', leadSourceDetail: '', idVerification: null, completedAt: null,
    auBranch: 'yes',
    au: Object.assign({
      step: 5, ahpraNumber: 'med 0001234567', registrationType: 'specialist', fellowship: 'fracgp', fellowshipDetail: '',
      hasConditions: false, conditionsDetail: '', moratorium19ab: 'no',
      workRights: 'citizen', permitSubclass: '', permitExpiry: '',
      currentPractice: 'Test Current Practice (FAKE)', noticeWeeks: 4, availableFrom: '2027-03-18',
      locations: ['Regional NSW', 'Sydney', 'Newcastle'], suburb: 'Parramatta', state: 'NSW', postcode: '2150',
      sessions: 8, detailsConfirmed: true
    }, over || {})
  }, top || {});
}
const todaysBody = () => ({ _version: 2, currentStep: 1, country: 'GB', registerNumber: '', qualDocs: {}, targetDate: '', completedAt: null });
const save = (d, body) => h.post('/api/onboarding/save', body, { cookie: d.cookie });
const complete = (d, over) => h.post('/api/onboarding/complete', auBody(over), { cookie: d.cookie });
const session = (d) => h.get('/api/auth/session', { cookie: d.cookie });
const setPathway = (d, body, who) => h.post('/api/admin/candidate/pathway', Object.assign({ user_id: d.userId }, body), who || h.superAdmin());
const pathwayReads = () => h.emu.requests.filter((r) => r.table === 'user_profiles' && r.method === 'GET' && (r.select || []).indexOf('candidate_pathway') !== -1).length;

beforeAll(async () => { h = await bootAuTestServer({ name: 'fr7-wizard' }); }, 60000);
afterAll(async () => { if (h) await h.close(); });
beforeEach(() => { h.setSwitch(true); });

describe('the rule, in one place', () => {
  it('isStaffSetOverseasProfile: only a valid overseas pathway that a person recorded', () => {
    const f = candidatePathway.isStaffSetOverseasProfile;
    expect(f(null)).toBe(false);
    expect(f({})).toBe(false);
    expect(f({ candidate_pathway: null, pathway_set_by: 'consultant@x' })).toBe(false);
    expect(f({ candidate_pathway: 'nonsense', pathway_set_by: 'consultant@x' })).toBe(false);
    expect(f({ candidate_pathway: 'au_vr', pathway_set_by: 'consultant@x' })).toBe(false);
    expect(f({ candidate_pathway: 'overseas_esp', pathway_set_by: 'consultant@x' })).toBe(true);
    expect(f({ candidate_pathway: 'overseas_pep', pathway_set_by: 'ceo@x', pathway_confirmed_at: '2026-11-25T00:00:00Z', pathway_confirmed_by: 'ceo@x' })).toBe(true);
    expect(f({ candidate_pathway: 'overseas_esp', pathway_set_by: null })).toBe(true); // no set-by: the stricter reading
    expect(f({ candidate_pathway: 'overseas_esp', pathway_set_by: 'self' })).toBe(false);
    expect(f({ candidate_pathway: 'overseas_esp', pathway_set_by: 'self', pathway_confirmed_at: '2026-11-25T00:00:00Z', pathway_confirmed_by: 'ceo@x' })).toBe(true);
  });

  it('decideAuOnboardingPathwayWrite: a staff-set overseas pathway is never replaced; everything else is as it was', () => {
    const d = auOnboarding.decideAuOnboardingPathwayWrite;
    expect(d({ storedPathway: 'overseas_esp', setBy: 'consultant@x', staffSetOverseas: true, onboardingComplete: false, derivedPathway: 'au_vr' }))
      .toMatchObject({ action: 'refuse', reason: 'staff_overseas_pathway' });
    expect(d({ storedPathway: 'overseas_pep', setBy: 'consultant@x', staffSetOverseas: true, onboardingComplete: true, derivedPathway: 'au_restricted' }))
      .toMatchObject({ action: 'refuse', reason: 'staff_overseas_pathway' });
    // unchanged rows of the table
    expect(d({ storedPathway: null, setBy: null, onboardingComplete: false, derivedPathway: 'au_vr' })).toMatchObject({ action: 'write', reason: 'first_time' });
    expect(d({ storedPathway: null, setBy: null, staffSetOverseas: true, onboardingComplete: false, derivedPathway: 'au_vr' })).toMatchObject({ action: 'write', reason: 'first_time' });
    expect(d({ storedPathway: null, setBy: null, onboardingComplete: true, derivedPathway: 'au_vr' })).toMatchObject({ action: 'refuse', reason: 'already_onboarded_not_australian' });
    expect(d({ storedPathway: 'au_vr', setBy: 'consultant@x', onboardingComplete: false, derivedPathway: 'au_vr' })).toMatchObject({ action: 'keep' });
  });
});

describe('S7-01: staff moved the doctor to an overseas pathway; the Australian wizard is still open on their device', () => {
  it('the reviewer\'s case (staff-created au_vr, wizard on screen, moved before finishing): the device\'s save is not stored, the finish is refused, the staff choice stands', async () => {
    const d = fresh();
    loadDb([d]);
    expect((await setPathway(d, { pathway: 'au_vr' })).status).toBe(200);
    expect((await save(d, auBody({ step: 1 }))).status).toBe(200);
    expect(blobOf(d).auBranch).toBe('yes');
    expect((await setPathway(d, { pathway: 'overseas_esp' })).status).toBe(200);
    expect(blobOf(d).auBranch).toBeUndefined();
    const profileBefore = JSON.stringify(row('user_profiles', d.userId));
    const stateBefore = JSON.stringify(stateOf(d));

    // the page learns it
    const s = await session(d);
    expect(s.json.auPathwayStaffOverseas).toBe(true);
    expect(s.json.auPathway).toMatchObject({ pathway: 'overseas_esp', isAu: false });

    // the same device saves the Australian branch back
    const resave = await save(d, auBody({ step: 2 }));
    expect(resave.status).toBe(409);
    expect(resave.json).toMatchObject({ ok: false, code: 'overseas_pathway', todaysWizardRequired: true });
    expect(JSON.stringify(stateOf(d))).toBe(stateBefore);
    expect(stateOf(d)[auOnboarding.AU_BRANCH_MARKER_KEY]).toBeUndefined();

    // and finishes it
    const done = await complete(d);
    expect(done.status).toBe(409);
    expect(done.json).toMatchObject({ ok: false, code: 'overseas_pathway', todaysWizardRequired: true });
    expect(JSON.stringify(row('user_profiles', d.userId))).toBe(profileBefore);
    expect(row('user_profiles', d.userId)).toMatchObject({ candidate_pathway: 'overseas_esp', pathway_set_by: h.SUPER_EMAIL });
    expect(row('gp_credentials', d.userId)).toBe(null);
    expect(JSON.stringify(stateOf(d))).toBe(stateBefore);

    // today's wizard works for them
    expect((await save(d, todaysBody())).status).toBe(200);
    expect(blobOf(d)).toMatchObject({ country: 'GB', currentStep: 1 });
  });

  it('the doctor answered "Yes" themselves (no pathway recorded yet), then staff set overseas: the branch is cleared, what they typed is kept', async () => {
    const d = fresh();
    loadDb([d]);
    expect((await save(d, auBody({ step: 2, suburb: 'Typed By The Doctor' }))).status).toBe(200);
    expect(blobOf(d).auBranch).toBe('yes');
    expect(stateOf(d)[auOnboarding.AU_BRANCH_MARKER_KEY]).toBeTruthy();
    expect(row('user_profiles', d.userId).candidate_pathway == null).toBe(true);

    expect((await setPathway(d, { pathway: 'overseas_esp' }, h.consultant())).status).toBe(200);
    const blob = blobOf(d);
    expect(blob.auBranch).toBeUndefined();
    expect(blob.au).toMatchObject({ suburb: 'Typed By The Doctor', ahpraNumber: 'med 0001234567' });
    expect(stateOf(d)[auOnboarding.AU_BRANCH_MARKER_KEY]).toBeUndefined();
    expect((await session(d)).json.auPathwayStaffOverseas).toBe(true);
    expect((await complete(d)).status).toBe(409);
    expect(row('user_profiles', d.userId).candidate_pathway).toBe('overseas_esp');
    // no "still needs onboarding" task: they never finished the Australian sign-up
    expect(tasksOf(d).filter((x) => x.source_trigger === TASK_SOURCE)).toEqual([]);
  });

  it('a move from an unfinished Australian pathway keeps the typed answers too (only the switch into the branch goes)', async () => {
    const d = fresh();
    loadDb([d]);
    await setPathway(d, { pathway: 'au_vr' });
    await save(d, auBody({ step: 3, currentPractice: 'Typed Practice (FAKE)' }));
    await setPathway(d, { pathway: 'overseas_esp' });
    expect(blobOf(d).auBranch).toBeUndefined();
    expect(blobOf(d).au.currentPractice).toBe('Typed Practice (FAKE)');
  });

  it('staff set the pathway back to an Australian one: the Australian wizard is accepted again', async () => {
    const d = fresh();
    loadDb([d]);
    await setPathway(d, { pathway: 'overseas_esp' });
    expect((await complete(d)).status).toBe(409);
    await setPathway(d, { pathway: 'au_vr' });
    expect((await session(d)).json.auPathwayStaffOverseas).toBeUndefined();
    expect((await save(d, auBody({ step: 1 }))).status).toBe(200);
    expect((await complete(d)).status).toBe(200);
    expect(row('user_profiles', d.userId).candidate_pathway).toBe('au_vr');
  });
});

describe('S7-02: moved to overseas AFTER finishing the Australian sign-up', () => {
  it('staff are told once (a task and a timeline line); nothing the doctor entered is deleted; the Australian wizard is closed to them', async () => {
    const d = fresh();
    loadDb([d]);
    expect((await complete(d)).status).toBe(200);
    expect(row('user_profiles', d.userId).candidate_pathway).toBe('au_vr');
    const blobBefore = JSON.stringify(blobOf(d));

    const move = await setPathway(d, { pathway: 'overseas_esp' });
    expect(move.status, JSON.stringify(move.json)).toBe(200);
    const tasks = tasksOf(d).filter((x) => x.source_trigger === TASK_SOURCE);
    expect(tasks.length).toBe(1);
    expect(tasks[0]).toMatchObject({ task_type: 'manual', priority: 'high' });
    expect(tasks[0].title).toMatch(/^Still needs today's onboarding: /);
    expect(tasks[0].description).toMatch(/country of training/);
    expect(tasks[0].description).toMatch(/\/pages\/onboarding/);
    expect(timelineOf(d).filter((x) => x.title === 'Still needs today\'s onboarding').length).toBe(1);
    // the finished blob is left exactly as it was
    expect(JSON.stringify(blobOf(d))).toBe(blobBefore);

    // the Australian wizard cannot make them Australian again
    expect((await session(d)).json.auPathwayStaffOverseas).toBe(true);
    expect((await complete(d, { sessions: 2 })).status).toBe(409);
    expect((await save(d, auBody({ step: 0 }))).status).toBe(409);
    expect(row('user_profiles', d.userId).candidate_pathway).toBe('overseas_esp');

    // a second change of overseas pathway does not raise a second task
    await setPathway(d, { pathway: 'overseas_pep' });
    expect(tasksOf(d).filter((x) => x.source_trigger === TASK_SOURCE).length).toBe(1);
  });

  it('a doctor who finished TODAY\'s wizard and is moved Australian and back: no task (they were asked today\'s questions)', async () => {
    const d = fresh();
    loadDb([d]);
    d.profile.onboarding_completed_at = '2026-10-01T00:00:00.000Z';
    row('user_profiles', d.userId).onboarding_completed_at = '2026-10-01T00:00:00.000Z';
    row('user_state', d.userId).state = { gp_onboarding_complete: true, gp_onboarding: { _version: 2, currentStep: 4, country: 'GB', completedAt: '2026-10-01T00:00:00.000Z' } };
    await setPathway(d, { pathway: 'au_restricted' });
    await setPathway(d, { pathway: 'overseas_esp' });
    expect(tasksOf(d).filter((x) => x.source_trigger === TASK_SOURCE)).toEqual([]);
    expect(blobOf(d)).toMatchObject({ country: 'GB', completedAt: '2026-10-01T00:00:00.000Z' });
  });
});

describe('a doctor with nothing recorded is untouched', () => {
  it('switch on: no new key on the session; "Yes" is saved and finished exactly as before; today\'s saves ask nothing about the pathway', async () => {
    const d = fresh();
    loadDb([d]);
    const s = await session(d);
    expect(s.json.auPathwayEnabled).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(s.json, 'auPathwayStaffOverseas')).toBe(false);

    h.emu.reset();
    expect((await save(d, todaysBody())).status).toBe(200);
    expect(pathwayReads()).toBe(0);

    expect((await save(d, auBody({ step: 1 }))).status).toBe(200);
    expect(blobOf(d).auBranch).toBe('yes');
    const done = await complete(d);
    expect(done.status).toBe(200);
    expect(row('user_profiles', d.userId)).toMatchObject({ candidate_pathway: 'au_vr', pathway_set_by: 'self' });
  });

  it('switch off: the session has neither key, an Australian-shaped save is stored as any other blob, and nothing reads the pathway', async () => {
    const d = fresh();
    loadDb([d]);
    row('user_profiles', d.userId).candidate_pathway = 'overseas_esp';
    row('user_profiles', d.userId).pathway_set_by = 'consultant@gplink-test.local';
    h.setSwitch(false);
    h.emu.reset();
    const s = await session(d);
    expect(s.json.auPathwayEnabled).toBeUndefined();
    expect(s.json.auPathwayStaffOverseas).toBeUndefined();
    expect((await save(d, auBody({ step: 1 }))).status).toBe(200);
    expect(blobOf(d).auBranch).toBe('yes');
    expect(pathwayReads()).toBe(0);
  });
});

describe('the page (js/onboarding.js)', () => {
  // The page has no test DOM: the function is lifted out of the file and run
  // against stand-ins for the wizard's own variables.
  function liftSetAside() {
    const m = /function auSetBranchAside\(\) \{[\s\S]*?\n  \}\n/.exec(onboardingJs);
    expect(m, 'auSetBranchAside is in js/onboarding.js').toBeTruthy();
    // eslint-disable-next-line no-new-func
    return new Function('state', 'box', 'var currentStep = box.currentStep; function auWriteLocalAnswer(v) { box.local = v; }\n'
      + m[0] + '\nvar out = auSetBranchAside(); box.currentStep = currentStep; return out;');
  }

  it('setting the branch aside keeps what the doctor typed; an unfinished blob keeps its place', () => {
    const state = { auBranch: 'yes', au: { suburb: 'Typed' }, currentStep: 0, completedAt: null, country: '' };
    const box = { currentStep: 0, local: 'x' };
    expect(liftSetAside()(state, box)).toBe(true);
    expect(state).toEqual({ au: { suburb: 'Typed' }, currentStep: 0, completedAt: null, country: '' });
    expect(box.local).toBe('');
  });

  it('a blob FINISHED on the Australian screens goes back to the start of today\'s wizard (step, finish time and country were written by those screens)', () => {
    const state = { auBranch: 'yes', au: { suburb: 'Typed' }, currentStep: 4, completedAt: '2026-11-20T00:00:00.000Z', country: 'AU', registerNumber: 'MED0001234567' };
    const box = { currentStep: 4 };
    expect(liftSetAside()(state, box)).toBe(true);
    expect(state.auBranch).toBeUndefined();
    expect(state.au).toEqual({ suburb: 'Typed' });
    expect(state.completedAt).toBe(null);
    expect(state.country).toBe('');
    expect(state.currentStep).toBe(0);
    expect(box.currentStep).toBe(0);
  });

  it('a blob that never entered the branch is not touched at all', () => {
    const state = { currentStep: 2, completedAt: null, country: 'GB' };
    const before = JSON.stringify(state);
    expect(liftSetAside()(state, { currentStep: 2 })).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('the recorded pathway is checked before anything else decides, and the flag comes from the session', () => {
    const takeOver = onboardingJs.slice(onboardingJs.indexOf('function auTakeOver(params) {'));
    const iOther = takeOver.indexOf('if (auRecordedOther) {');
    expect(iOther).toBeGreaterThan(0);
    expect(iOther).toBeLessThan(takeOver.indexOf('if (DOCS_ONLY_MODE) return false;'));
    expect(iOther).toBeLessThan(takeOver.indexOf('auServerRecorded = !!('));
    expect(onboardingJs).toContain('auRecordedOther = data.auPathwayStaffOverseas === true;');
    // a refused save and a refused finish both hand over to today's wizard
    expect(onboardingJs).toContain('if (r && r.status === 409 && typeof auOnSaveRefused === "function")');
    expect(onboardingJs).toContain('} else if (data && data.todaysWizardRequired === true) {');
  });

  it('a finished Australian doctor is sent home, only when the SERVER says both "finished" and "Australian"', () => {
    expect(onboardingJs).toContain('auServerFinished = st.gp_onboarding_complete === true || st.gp_onboarding_complete === "true";');
    const takeOver = onboardingJs.slice(onboardingJs.indexOf('function auTakeOver(params) {'));
    const iHome = takeOver.indexOf('if (auServerFinished && mine && mine.isAu) {');
    expect(iHome).toBeGreaterThan(0);
    expect(takeOver.slice(iHome, iHome + 160)).toContain('window.location.replace("/pages/index")');
    // the held (not launched) finish screen still comes first
    expect(takeOver.indexOf('auShowSuccess("team_review");')).toBeLessThan(iHome);
  });
});

/**
 * Fix bundle FR-2, R2-02 (round 2 of the final review), with S2-04 and S2-05.
 *
 * (a) A held doctor's LATER answers could still end in a staff-confirmed VR
 *     GP: the repeat completion kept the pathway but overwrote the stored
 *     answers, and an ordinary verified check (right to work optional) then
 *     derived segment A with nothing to warn the person verifying.
 * (b) "Already onboarded" rested on onboarding_completed_at alone, a column a
 *     doctor can null through the database API.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const candidatePathway = require('../lib/candidate-pathway.js');
const auStaffTools = require('../lib/au-staff-tools.js');

let h, t;
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
const caseOf = (userId) => row('registration_cases', userId);
const tasksOf = (userId, type) => { const c = caseOf(userId); return c ? rows('registration_tasks').filter((x) => x.case_id === c.id && (!type || x.task_type === type)) : []; };
const openTasks = (userId, type) => tasksOf(userId, type).filter((x) => !/^(completed|cancelled)$/.test(String(x.status)));
const kv = (userId) => { const r = rows('runtime_kv').find((x) => x.key === 'au_onboarded:' + userId); return r ? r.value : null; };
function fresh() {
  counter += 1;
  const d = buildAuDoctor('overseas_null', { idSuffix: 'r' + counter, noCase: true,
    profile: { first_name: 'Testr' + counter, registration_country: '', qualification_country: '', preferred_city: '', onboarding_completed_at: null } });
  d.state.state = {};
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}
function auBody(over) {
  return {
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
  };
}
const complete = (d, over) => h.post('/api/onboarding/complete', auBody(over), { cookie: d.cookie });
const CHECK = { action: 'ahpra_check', outcome: 'verified', ahpra_number: 'MED0001234567', registration_type: 'specialist', specialist_gp: true,
  has_conditions: false, has_undertakings: false, has_notations: false, registration_expiry: '2099-09-30', moratorium_19ab_confirmed: 'no',
  fellowship_type: 'fracgp', work_rights: 'citizen', supervision_level: 'none' };
const check = (d, body) => h.post('/api/ats/candidate/register-verification', Object.assign({ userId: d.userId }, body), h.consultant());
const W = () => (t.__wp17 && t.__wp17.auWriteOnboardedRecord ? t.__wp17 : t);
const RESTRICTIVE = { workRights: 'temporary', moratorium19ab: 'yes', permitSubclass: '482', permitExpiry: '2028-01-01' };

beforeAll(async () => { h = await bootAuTestServer({ name: 'fr2-r202' }); t = h.testUtils; }, 60000);
afterAll(async () => { if (h) await h.close(); });
beforeEach(() => { h.setSwitch(true); });

describe('R2-02 (a): a repeat completion overwrites nothing', () => {
  it('the answers used here are accepted by the server (so the tests below test the rule, not a typo)', async () => {
    const d = fresh();
    loadDb([d]);
    const first = await complete(d, RESTRICTIVE);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.auPathway.launched).toBe(false);
    expect(row('user_profiles', d.userId).candidate_pathway).not.toBe('au_vr');
    expect(kv(d.userId)).toMatchObject({ kind: 'au' });
    expect(kv(d.userId).original.segment).not.toBe('A');
    expect(kv(d.userId).original.answers).toMatchObject({ work_rights: 'visa' });
  });

  it('the reviewer\'s reproduction: held (temporary resident, 19AB applies), re-posts "citizen, 19AB no": nothing stored changes, the proposal is kept separately, staff are asked', async () => {
    const d = fresh();
    loadDb([d]);
    await complete(d, RESTRICTIVE);
    const snap = () => JSON.stringify({ c: row('gp_credentials', d.userId), p: Object.assign({}, row('user_profiles', d.userId), { updated_at: 0 }), s: row('user_state', d.userId).state });
    const credBefore = JSON.parse(JSON.stringify(row('gp_credentials', d.userId)));
    const profBefore = JSON.parse(JSON.stringify(row('user_profiles', d.userId)));
    const stateBefore = JSON.stringify(row('user_state', d.userId).state);
    const again = await complete(d, { sessions: 3, noticeWeeks: 1 });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ ok: true, auAlreadyComplete: true });
    expect(again.json.auPathway.launched).toBe(false);
    expect(again.json.message).toMatch(/nothing on it was changed/);
    const credAfter = row('gp_credentials', d.userId);
    for (const k of ['work_rights', 'moratorium_19ab_status', 'ahpra_registration_type', 'fellowship_type', 'has_conditions', 'self_declared_at']) expect(credAfter[k], k).toEqual(credBefore[k]);
    const profAfter = row('user_profiles', d.userId);
    for (const k of ['candidate_pathway', 'pathway_set_by', 'sessions_wanted', 'notice_period_weeks', 'register_number', 'register_status', 'onboarding_completed_at']) expect(profAfter[k], k).toEqual(profBefore[k]);
    expect(JSON.stringify(row('user_state', d.userId).state)).toBe(stateBefore);
    // the proposal is on the server's own record and in front of staff
    expect(kv(d.userId).original.answers.work_rights).toBe('visa');
    expect(kv(d.userId).proposed.answers.work_rights).toBe('citizen');
    expect(kv(d.userId).proposed.segment).toBe('A');
    expect(openTasks(d.userId, 'segment_review').length).toBe(1);
    expect(openTasks(d.userId, 'ahpra_register_check').length).toBe(1);
    expect(openTasks(d.userId, 'ahpra_register_check')[0].description).toMatch(/THE DOCTOR SAYS THEIR DETAILS HAVE CHANGED/);
    expect(snap()).toBeTruthy();
  });

  it('then an ordinary verified check does NOT end in a confirmed VR GP: nothing is saved until the person resolves the review in the same action', async () => {
    const d = fresh();
    loadDb([d]);
    await complete(d, RESTRICTIVE);
    await complete(d, {});
    const blocked = await check(d, CHECK);
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe('segment_review_must_be_resolved');
    expect(blocked.json.segment_compare.original.answers.work_rights).toBe('visa');
    expect(blocked.json.segment_compare.proposed.answers.work_rights).toBe('citizen');
    expect(row('gp_credentials', d.userId).staff_verified_at || null).toBeNull();
    expect(row('user_profiles', d.userId).pathway_confirmed_at || null).toBeNull();
    expect(row('user_profiles', d.userId).candidate_pathway).not.toBe('au_vr');
    // resolved in the same action: confirmed, the review closed, both sets on the record
    const ok = await check(d, Object.assign({}, CHECK, { resolve_segment_review: true }));
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.derived).toMatchObject({ pathway: 'au_vr' });
    expect(openTasks(d.userId, 'segment_review')).toEqual([]);
    const line = rows('task_timeline').find((x) => x.title === 'Segment review resolved in the Ahpra check');
    expect(line).toBeTruthy();
    expect(String(line.detail)).toMatch(/first answers: segment [BC]/);
  });

  it('original answers restrictive and NO review task open (someone closed it): still gated', async () => {
    const d = fresh();
    loadDb([d]);
    await complete(d, RESTRICTIVE);
    tasksOf(d.userId, 'segment_review').forEach((x) => { x.status = 'completed'; });
    const blocked = await check(d, CHECK);
    expect(blocked.status).toBe(409);
    expect(blocked.json.message).toMatch(/first answers were more restrictive/);
  });

  it('S2-05: a check that would confirm a VR GP needs fellowship, right to work and supervision chosen in the check', async () => {
    const d = fresh();
    loadDb([d]);
    await complete(d, {});
    for (const k of ['fellowship_type', 'work_rights', 'supervision_level']) {
      const body = Object.assign({}, CHECK); delete body[k];
      const res = await check(d, body);
      expect(res.status, k).toBe(400);
      expect(Object.keys(res.json.errors), k).toEqual([k]);
    }
    expect(row('gp_credentials', d.userId).staff_verified_at || null).toBeNull();
    expect((await check(d, Object.assign({}, CHECK, { supervision_level: 'nonsense' }))).status).toBe(400);
    const ok = await check(d, CHECK);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.derived).toMatchObject({ pathway: 'au_vr' });
    expect(row('gp_credentials', d.userId).supervision_level).toBe('none');
    // a check that does NOT end in segment A is not held to it (it is flagged for a person anyway)
    const d2 = fresh();
    rows('user_profiles').push(JSON.parse(JSON.stringify(d2.profile)));
    rows('user_state').push(JSON.parse(JSON.stringify(d2.state)));
    await complete(d2, {});
    const b = Object.assign({}, CHECK, { has_conditions: true, conditions_text: 'A condition (FAKE).' });
    delete b.fellowship_type; delete b.work_rights; delete b.supervision_level;
    expect((await check(d2, b)).status).toBe(200);
  });

  it('S2-04: a VERIFIED doctor re-posting changes no register field and never withdraws the staff 19AB confirmation; it becomes a change request', async () => {
    const d = fresh();
    loadDb([d]);
    await complete(d, {});
    await check(d, CHECK);
    const before = JSON.parse(JSON.stringify({ p: row('user_profiles', d.userId), c: row('gp_credentials', d.userId) }));
    expect(before.p).toMatchObject({ register_status: 'verified', candidate_pathway: 'au_vr' });
    expect(before.c.moratorium_19ab_confirmed_status).toBe('no');
    const again = await complete(d, { ahpraNumber: 'MED0009998887', moratorium19ab: 'yes', registrationType: 'limited' });
    expect(again.status).toBe(200);
    const after = { p: row('user_profiles', d.userId), c: row('gp_credentials', d.userId) };
    for (const k of ['register_number', 'register_status', 'register_verified_at', 'register_verified_by', 'candidate_pathway', 'pathway_confirmed_at']) expect(after.p[k], k).toEqual(before.p[k]);
    for (const k of ['ahpra_number', 'moratorium_19ab_confirmed_status', 'moratorium_19ab_confirmed_by', 'moratorium_19ab_status', 'ahpra_registration_type', 'staff_verified_at']) expect(after.c[k], k).toEqual(before.c[k]);
    expect(openTasks(d.userId, 'ahpra_register_check').length).toBe(1);
    expect(rows('task_timeline').some((x) => x.title === 'Doctor says their registration details have changed')).toBe(true);
  });

  it('the same answers again: 200, nothing changed, nothing raised', async () => {
    const d = fresh();
    loadDb([d]);
    await complete(d, {});
    const tasksBefore = tasksOf(d.userId).length;
    const again = await complete(d, {});
    expect(again.status).toBe(200);
    expect(again.json.message).toBe('Profile complete.');
    expect(tasksOf(d.userId).length).toBe(tasksBefore);
    expect(openTasks(d.userId, 'segment_review')).toEqual([]);
  });

  it('pure: the one rule refuses segment A while a review is open or the first answers were restrictive, unless resolved', () => {
    const credentials = { ahpra_registration_type: 'specialist', specialist_gp: true, fellowship_type: 'fracgp', has_conditions: false, has_undertakings: false, has_notations: false,
      work_rights: 'citizen', moratorium_19ab_status: 'no', registration_expiry: '2099-01-01', supervision_level: 'none' };
    const base = { credentials, currentPathway: 'au_restricted', today: '2026-11-24' };
    expect(candidatePathway.derivePathwayFromRegisterCheck(base).pathway).toBe('au_vr');
    expect(candidatePathway.derivePathwayFromRegisterCheck(Object.assign({ segmentReviewOpen: true }, base))).toMatchObject({ pathway: 'au_restricted', launched: false, reasons: ['segment_review_open'] });
    expect(candidatePathway.derivePathwayFromRegisterCheck(Object.assign({ originalRestrictive: true }, base))).toMatchObject({ pathway: 'au_restricted', reasons: ['original_answers_restrictive'] });
    expect(candidatePathway.derivePathwayFromRegisterCheck(Object.assign({ segmentReviewOpen: true, originalRestrictive: true, reviewResolved: true }, base)).pathway).toBe('au_vr');
    expect(auStaffTools.confirmedVrMissing({ fellowship_type: 'fracgp', work_rights: 'citizen', supervision_level: 'none' })).toEqual({});
  });
});

describe('R2-02 (b): "already onboarded" does not rest on a column the doctor can change', () => {
  it('the reviewer\'s reproduction: an onboarded overseas doctor nulls onboarding_completed_at and posts Australian onboarding: refused, nothing written', async () => {
    const d = fresh();
    d.profile.onboarding_completed_at = '2026-09-01T00:00:00.000Z';
    d.profile.registration_country = 'United Kingdom';
    d.state.state = { gp_onboarding_complete: true, gp_onboarding: { currentStep: 5, country: 'GB', completedAt: '2026-09-01T00:00:00.000Z' } };
    loadDb([d]);
    // the server's own record (written by the FR-2 migration's trigger when the column was first set)
    rows('runtime_kv').push({ key: 'au_onboarded:' + d.userId, value: { v: 1, at: '2026-09-01T00:00:00.000Z', by: 'trigger' } });
    // what the doctor can do with their own token: null the column AND clear the state flag
    row('user_profiles', d.userId).onboarding_completed_at = null;
    row('user_state', d.userId).state = {};
    const res = await complete(d, {});
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('onboarding_already_complete');
    expect(row('user_profiles', d.userId).candidate_pathway || null).toBeNull();
    expect(row('gp_credentials', d.userId)).toBeNull();
  });

  it('the state the server wrote at completion counts too (column nulled, record missing)', async () => {
    const d = fresh();
    d.state.state = { gp_onboarding_complete: true };
    loadDb([d]);
    const res = await complete(d, {});
    expect(res.status).toBe(409);
    expect(row('user_profiles', d.userId).candidate_pathway || null).toBeNull();
  });

  it('an Australian doctor who nulls the column and re-posts as segment A is still a REPEAT: nothing overwritten', async () => {
    const d = fresh();
    loadDb([d]);
    await complete(d, RESTRICTIVE);
    row('user_profiles', d.userId).onboarding_completed_at = null;
    row('user_state', d.userId).state = {};
    const credBefore = JSON.stringify(row('gp_credentials', d.userId));
    const res = await complete(d, {});
    expect(res.status).toBe(200);
    expect(res.json.auAlreadyComplete).toBe(true);
    expect(JSON.stringify(row('gp_credentials', d.userId))).toBe(credBefore);
    expect(row('user_profiles', d.userId).candidate_pathway).not.toBe('au_vr');
  });

  it('the record cannot be read: refused, nothing written (fail closed); a first completion still works when nothing says "finished"', async () => {
    const d = fresh();
    loadDb([d]);
    h.emu.forbid((req) => (req.table === 'runtime_kv' && req.method === 'GET' && /au_onboarded/.test(String(req.query || '')) ? 'record read fails' : ''));
    let res;
    try { res = await complete(d, {}); } finally { h.emu.forbid(null); }
    expect(res.status).toBe(503);
    expect(row('gp_credentials', d.userId)).toBeNull();
    expect((await complete(d, {})).status).toBe(200);
  });

  it('the record is the server\'s only: the first answers are never overwritten by a later write', async () => {
    const d = fresh();
    loadDb([d]);
    await complete(d, RESTRICTIVE);
    expect(await W().auWriteOnboardedRecord(d.userId, 'au', { segment: 'A', answers: {} })).toBe(false);
    expect(kv(d.userId).original.segment).not.toBe('A');
    // a record the trigger wrote first (no answers yet) is completed, not replaced
    const e = fresh();
    rows('runtime_kv').push({ key: 'au_onboarded:' + e.userId, value: { v: 1, at: '2026-01-01T00:00:00.000Z', by: 'trigger' } });
    expect(await W().auWriteOnboardedRecord(e.userId, 'au', { segment: 'B', answers: {} })).toBe(true);
    expect(kv(e.userId)).toMatchObject({ at: '2026-01-01T00:00:00.000Z', by: 'trigger', kind: 'au', original: { segment: 'B' } });
  });
});

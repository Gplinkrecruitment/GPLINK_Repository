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
    // FR-4 (M4-03), deliberate: preferences (sessions, notice period) are not
    // pathway facts, so a repeat now SAVES them and says so; every
    // registration answer and the pathway are still untouched.
    expect(again.json.message).toMatch(/Your registration details were not changed/);
    const credAfter = row('gp_credentials', d.userId);
    for (const k of ['work_rights', 'moratorium_19ab_status', 'ahpra_registration_type', 'fellowship_type', 'has_conditions', 'self_declared_at']) expect(credAfter[k], k).toEqual(credBefore[k]);
    const profAfter = row('user_profiles', d.userId);
    for (const k of ['candidate_pathway', 'pathway_set_by', 'register_number', 'register_status', 'onboarding_completed_at']) expect(profAfter[k], k).toEqual(profBefore[k]);
    expect(profAfter).toMatchObject({ sessions_wanted: 3, notice_period_weeks: 1 });
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
    expect(again.json.message).toBe('Your preferences have been saved.');   // FR-4 (M4-03), deliberate: it says what happened
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

// ─────────────────────────────────────────────────────────────────────────────
// Fix bundle FR-3, S3-07 (round 3 of the final review).
describe('FR-3 S3-07: "Set and confirm pathway" cannot confirm a VR GP past restrictive first answers or an open review', () => {
  const setPathway = (d, body) => h.post('/api/admin/candidate/pathway', Object.assign({ user_id: d.userId }, body), h.consultant());

  it('the reviewer\'s case: restrictive first answers: refused with both sets of answers, nothing saved; with the explicit resolve it is saved, the review closed and both sets recorded', async () => {
    const d = fresh();
    loadDb([d]);
    await complete(d, RESTRICTIVE);
    await complete(d, {});
    const before = JSON.stringify({ p: row('user_profiles', d.userId).candidate_pathway, c: row('user_profiles', d.userId).pathway_confirmed_at || null });
    const blocked = await setPathway(d, { pathway: 'au_vr', confirmed: true });
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe('segment_review_must_be_resolved');
    expect(blocked.json.segment_compare.original.answers.work_rights).toBe('visa');
    expect(blocked.json.segment_compare.proposed.answers.work_rights).toBe('citizen');
    expect(JSON.stringify({ p: row('user_profiles', d.userId).candidate_pathway, c: row('user_profiles', d.userId).pathway_confirmed_at || null })).toBe(before);
    expect(openTasks(d.userId, 'segment_review').length).toBe(1);
    const ok = await setPathway(d, { pathway: 'au_vr', confirmed: true, resolve_segment_review: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(row('user_profiles', d.userId).candidate_pathway).toBe('au_vr');
    expect(openTasks(d.userId, 'segment_review')).toEqual([]);
    expect(rows('task_timeline').some((x) => x.title === 'Segment review resolved when the pathway was confirmed' && /first answers: segment [BC]/.test(String(x.detail)))).toBe(true);
  });

  it('nothing restrictive and no review: unchanged (no extra step); another pathway, or "not confirmed", is never gated; unreadable: nothing saved', async () => {
    const d = fresh();
    loadDb([d]);
    await complete(d, {});
    expect((await setPathway(d, { pathway: 'au_vr', confirmed: true })).status).toBe(200);
    const b = fresh();
    rows('user_profiles').push(JSON.parse(JSON.stringify(b.profile)));
    rows('user_state').push(JSON.parse(JSON.stringify(b.state)));
    await complete(b, RESTRICTIVE);
    expect((await setPathway(b, { pathway: 'au_restricted', confirmed: true })).status).toBe(200);
    // FR-4 (S4-04), deliberate: "not confirmed" is no longer a way round the
    // comparison (a held doctor became an unconfirmed VR GP with the hold gone).
    expect((await setPathway(b, { pathway: 'au_vr', confirmed: false })).status).toBe(409);
    h.emu.forbid((req) => (req.table === 'runtime_kv' && req.method === 'GET' && /au_onboarded/.test(String(req.query || '')) ? 'record read fails' : ''));
    let res;
    try { res = await setPathway(b, { pathway: 'au_vr', confirmed: true, resolve_segment_review: true }); } finally { h.emu.forbid(null); }
    expect(res.status).toBe(503);
    expect(row('user_profiles', b.userId).candidate_pathway).toBe('au_restricted');   // FR-4: (the earlier unconfirmed change is now refused, so the staff-set held pathway still stands)
  });

  it('the screen: the 409 is answered with the comparison in plain words and resent only on an explicit yes; the Ahpra form shows plain labels and the tick box only when there is a review', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'ceo-ats-candidates.js'), 'utf8');
    expect(src).toContain("res.code === 'segment_review_must_be_resolved' && !resolve");
    expect(src).toContain('if (resolve) body.resolve_segment_review = true;');
    const from = src.indexOf('  var AU_COMPARE_LABELS');
    const to = src.indexOf('\n  }\n', src.indexOf('  function auSegmentCompareText')) + 5;
    const text = new Function(src.slice(from, to) + '\nreturn auSegmentCompareText;')()({
      original: { segment: 'B', answers: { work_rights: 'visa', moratorium_19ab_status: 'yes', ahpra_registration_type: 'specialist' } },
      proposed: { segment: 'A', answers: { work_rights: 'citizen', moratorium_19ab_status: 'no' } }
    });
    expect(text).toMatch(/Right to work: temporary resident/);
    expect(text).toMatch(/Section 19AB applies: yes/);
    expect(text).toMatch(/Right to work: Australian citizen/);
    expect(text).not.toMatch(/work_rights|moratorium_19ab_status|ahpra_/);
    expect(src).toContain("((open || c.original_restrictive) ? '<label class=\"ats-au-resolve\">");
    expect(src).toContain("ATS.esc(auCompareLabel(k)) + ': ' + ATS.esc(auCompareValue(v))");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix bundle FR-4, S4-04 and the {pathway:null} case (round 4 of the final review).
describe('FR-4 S4-04: any pathway change that lifts a hold or widens what a held doctor sees needs the explicit resolve', () => {
  const setPathway = (d, body) => h.post('/api/admin/candidate/pathway', Object.assign({ user_id: d.userId }, body), h.consultant());
  const pathwayOf = (d) => row('user_profiles', d.userId).candidate_pathway || null;
  async function heldB() {
    const d = fresh();
    rows('user_profiles').push(JSON.parse(JSON.stringify(d.profile)));
    rows('user_state').push(JSON.parse(JSON.stringify(d.state)));
    await complete(d, RESTRICTIVE);
    expect(pathwayOf(d)).toBe('au_restricted');
    return d;
  }

  it('the reviewer\'s doors, every one refused with nothing saved: confirmed:false, no pathway at all, an overseas pathway, and after the review task was ticked first', async () => {
    loadDb([]);
    const d = await heldB();
    for (const body of [{ pathway: 'au_vr', confirmed: false }, { pathway: 'au_vr', confirmed: true }, { pathway: 'au_vr' }, { pathway: null }, { pathway: 'overseas_esp' }]) {
      const res = await setPathway(d, body);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(res.json.code).toBe('segment_review_must_be_resolved');
      expect(res.json.segment_compare.original.answers.work_rights).toBe('visa');
      expect(pathwayOf(d), JSON.stringify(body)).toBe('au_restricted');
    }
    // the "Decide the segment" task ticked (or cancelled) by itself is not a resolution
    tasksOf(d.userId, 'segment_review').forEach((x) => { x.status = 'completed'; });
    for (const body of [{ pathway: 'au_vr', confirmed: false }, { pathway: null }]) {
      const res = await setPathway(d, body);
      expect(res.status, 'after the tick: ' + JSON.stringify(body)).toBe(409);
      expect(res.json.needs_resolution_because).toContain('held_pathway');
    }
    expect(pathwayOf(d)).toBe('au_restricted');
    // with the explicit acknowledgement it is saved and who decided what is on the record
    const ok = await setPathway(d, { pathway: 'au_vr', confirmed: false, resolve_segment_review: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(pathwayOf(d)).toBe('au_vr');
    const line = rows('task_timeline').find((x) => x.title === 'Segment review resolved when the pathway was confirmed');
    expect(String(line.detail)).toMatch(/Pathway set to au_vr by .*first answers: segment [BC]/);
  });

  it('a change that does not widen is never gated; a doctor with nothing restrictive is unchanged; an overseas doctor is never looked at', async () => {
    loadDb([]);
    const b = await heldB();
    expect((await setPathway(b, { pathway: 'au_non_vr', confirmed: true })).status).toBe(200);        // held to held
    expect((await setPathway(b, { pathway: 'au_restricted', confirmed: true })).status).toBe(200);
    const clean = fresh();
    rows('user_profiles').push(JSON.parse(JSON.stringify(clean.profile)));
    rows('user_state').push(JSON.parse(JSON.stringify(clean.state)));
    await complete(clean, {});
    expect((await setPathway(clean, { pathway: 'au_vr', confirmed: true })).status).toBe(200);
    expect((await setPathway(clean, { pathway: 'au_restricted', confirmed: true })).status).toBe(200);    // tightening: free
    const uk = fresh();
    rows('user_profiles').push(JSON.parse(JSON.stringify(uk.profile)));
    rows('user_state').push(JSON.parse(JSON.stringify(uk.state)));
    h.emu.reset();
    expect((await setPathway(uk, { pathway: 'overseas_esp' })).status).toBe(200);
    expect(h.emu.requests.some((r) => r.table === 'runtime_kv' && /au_onboarded/.test(String(r.query || '')))).toBe(false);   // nothing extra is read for them
  });

  it('pure: the one rule, by comparing how much each pathway opens', () => {
    const cp = candidatePathway;
    expect([cp.pathwayOpenness(null), cp.pathwayOpenness('overseas_esp'), cp.pathwayOpenness('au_vr'), cp.pathwayOpenness('au_restricted'), cp.pathwayOpenness('au_non_vr'), cp.pathwayOpenness('au_registrar'), cp.pathwayOpenness('nonsense')])
      .toEqual([3, 3, 2, 1, 1, 1, 3]);
    const need = (o) => cp.pathwayChangeNeedsResolution(o).needed;
    for (const from of ['au_restricted', 'au_non_vr', 'au_registrar']) {
      for (const to of ['au_vr', null, 'overseas_esp', 'overseas_pep']) for (const toConfirmed of [true, false]) expect(need({ fromPathway: from, toPathway: to, toConfirmed }), from + '>' + to).toBe(true);
      for (const to of ['au_restricted', 'au_non_vr', 'au_registrar']) expect(need({ fromPathway: from, toPathway: to }), from + '>' + to).toBe(false);
    }
    // au_vr with restrictive first answers or an open review
    expect(need({ fromPathway: 'au_vr', fromConfirmed: false, toPathway: 'au_vr', toConfirmed: true, originalRestrictive: true })).toBe(true);
    expect(need({ fromPathway: 'au_vr', fromConfirmed: true, toPathway: 'au_vr', toConfirmed: true, originalRestrictive: true })).toBe(false);
    expect(need({ fromPathway: 'au_vr', toPathway: null, segmentReviewOpen: true })).toBe(true);
    expect(need({ fromPathway: 'au_vr', toPathway: 'au_restricted', originalRestrictive: true })).toBe(false);
    // nothing sensitive: never
    expect(need({ fromPathway: 'au_vr', fromConfirmed: true, toPathway: null })).toBe(false);
    expect(need({ fromPathway: null, toPathway: 'au_vr' })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix bundle FR-4, M4-03.
describe('FR-4 M4-03: a repeat onboarding saves the preferences (they are not pathway facts) and says plainly what was and was not changed', () => {
  it('only preferences changed: they are saved, nothing about registration is, and the reply says so', async () => {
    const d = fresh();
    loadDb([d]);
    await complete(d, {});
    const credBefore = JSON.stringify(row('gp_credentials', d.userId));
    const pathwayBefore = row('user_profiles', d.userId).candidate_pathway;
    const again = await complete(d, { sessions: 3, noticeWeeks: 1, suburb: 'Newtown', postcode: '2042' });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ auAlreadyComplete: true, auPreferencesSaved: true, message: 'Your preferences have been saved.' });
    expect(row('user_profiles', d.userId)).toMatchObject({ sessions_wanted: 3, notice_period_weeks: 1, current_suburb: 'Newtown', candidate_pathway: pathwayBefore });
    expect(JSON.stringify(row('gp_credentials', d.userId))).toBe(credBefore);
    expect(openTasks(d.userId, 'segment_review')).toEqual([]);
  });

  it('registration answers changed too: preferences saved, registration answers NOT, and the reply says both', async () => {
    const d = fresh();
    loadDb([d]);
    await complete(d, RESTRICTIVE);
    const credBefore = JSON.stringify(row('gp_credentials', d.userId));
    const again = await complete(d, { sessions: 4 });
    expect(again.json.message).toMatch(/preferences .* have been saved\. Your registration details were not changed/);
    expect(row('user_profiles', d.userId).sessions_wanted).toBe(4);
    expect(JSON.stringify(row('gp_credentials', d.userId))).toBe(credBefore);
    expect(row('user_profiles', d.userId).candidate_pathway).toBe('au_restricted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix bundle FR-6, R6-02: a doctor staff move from Australian to overseas.
describe('FR-6 R6-02: moved by staff from an Australian pathway to an overseas one', () => {
  const setPathway = (d, body) => h.post('/api/admin/candidate/pathway', Object.assign({ user_id: d.userId }, body), h.consultant());
  const stateOf = (d) => row('user_state', d.userId).state;

  it('the reviewer\'s steps: Australian onboarding finished, staff set overseas_esp: everything the doctor then saves is kept; nothing of their finished onboarding is rewritten', async () => {
    const d = fresh();
    loadDb([d]);
    await complete(d, {});
    const before = JSON.stringify(stateOf(d));
    const res = await setPathway(d, { pathway: 'overseas_esp', resolve_segment_review: true });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(JSON.stringify(stateOf(d))).toBe(before);            // a finished doctor: the pages read the recorded pathway, so nothing is changed
    // the doctor's own state sync afterwards
    const put = await h.put('/api/state', { state: { gp_amc_myintealth_id: 'EPIC-445566', gp_registration_return_overrides: JSON.stringify({ visa: true, myintealth: true }), gp_epic_note: 'EPIC check for my overseas degree' } }, { cookie: d.cookie });
    expect([200, 204]).toContain(put.status);
    const got = await h.get('/api/state', { cookie: d.cookie });
    const sent = got.json.state || {};
    const stored = stateOf(d);
    for (const [k, v] of [['gp_amc_myintealth_id', 'EPIC-445566'], ['gp_registration_return_overrides', JSON.stringify({ visa: true, myintealth: true })]]) {
      if (Object.prototype.hasOwnProperty.call(stored, k)) expect(stored[k], 'stored ' + k).toBe(v);
      if (Object.prototype.hasOwnProperty.call(sent, k)) expect(sent[k], 'sent ' + k).toBe(v);
    }
    expect(Object.prototype.hasOwnProperty.call(stored, 'gp_amc_myintealth_id') || Object.prototype.hasOwnProperty.call(stored, 'gp_registration_return_overrides')).toBe(true);
  });

  it('a doctor who had NOT finished the Australian onboarding: the saved Australian branch and markers are cleared, so their next visit starts today\'s wizard', async () => {
    const d = fresh();
    d.profile.candidate_pathway = 'au_vr'; d.profile.candidate_basis = 'australia'; d.profile.pathway_set_by = 'staff@gplink-test.local';
    d.state.state = { gp_onboarding: { auBranch: 'yes', au: { step: 2, answers: {} }, currentStep: 0, country: '' }, gp_au_branch_started_at: '2026-11-20T00:00:00.000Z', gp_au_signup_audience: 'au', other: 'kept' };
    loadDb([d]);
    const res = await setPathway(d, { pathway: 'overseas_esp', resolve_segment_review: true });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const st = stateOf(d);
    expect(st.gp_onboarding.auBranch).toBeUndefined();
    // FR-7 (S7-01), deliberate: what the doctor typed is KEPT. Only the
    // `auBranch` switch that re-enters the Australian screens is removed
    // (nothing reads `au` without it). FR-6 deleted the answers as well.
    expect(st.gp_onboarding.au).toEqual({ step: 2, answers: {} });
    expect(st.gp_au_branch_started_at).toBeUndefined();
    expect(st.gp_au_signup_audience).toBeUndefined();
    expect(st.other).toBe('kept');
  });

  it('a doctor who was never Australian: nothing of their state is written, and the new step is not reached', async () => {
    const uk = fresh();
    loadDb([uk]);
    h.emu.reset();
    expect((await setPathway(uk, { pathway: 'overseas_pep' })).status).toBe(200);
    // Nothing of their state is WRITTEN (no Australian branch, no marker on it).
    // FR-7 (S7-01), deliberate: recording an overseas pathway now also clears
    // an unfinished Australian branch the doctor started themselves, so this
    // staff action reads the state once to look for one. Clearing the pathway
    // (to none) for a doctor who was never Australian still does not.
    expect(h.emu.requests.some((r) => r.table === 'user_state' && r.method !== 'GET')).toBe(false);
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
    expect(src).toContain("if ((auPwFrom.isAu === true && !candidatePathway.isAuPathway(auPwBody.pathway)) || auPwToOverseas) {");
  });
});

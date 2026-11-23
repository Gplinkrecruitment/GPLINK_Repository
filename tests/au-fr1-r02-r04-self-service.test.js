// Fix bundle FR-1 (final review):
//   R-02  a later self-answer never loosens the pathway
//   R-04  staff-verified registration facts are locked for the doctor
// Against the real server and the in-memory database stub.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb, FIXED_NOW, STAFF_EMAIL } = require('./helpers/au-fixtures.js');
const auOnboarding = require('../lib/au-onboarding.js');
const gpCredentials = require('../lib/gp-credentials.js');
const careerIntro = require('../lib/career-intro.js');
const candidatePathway = require('../lib/candidate-pathway.js');

const EMPTY_TABLES = ['registration_tasks', 'task_timeline', 'gp_applications', 'placements', 'user_documents',
  'admin_audit_log', 'candidate_leads', 'onboarding_reminders', 'pep_waitlist', 'runtime_kv', 'rate_limits', 'gp_nudge_log',
  'au_gp_doctor_details'];

let h;
let counter = 0;

function loadDb(doctors) {
  const db = buildAuFixtureDb(doctors);
  EMPTY_TABLES.forEach((name) => { if (!db[name]) db[name] = []; });
  Object.keys(h.emu.db).forEach((name) => { if (name !== 'rso_team') h.emu.db[name].length = 0; });
  Object.keys(db).forEach((name) => {
    const target = h.emu.table(name);
    db[name].forEach((row) => target.push(JSON.parse(JSON.stringify(row))));
  });
  h.emu.missingColumns = {};
  h.emu.missingTables = new Set();
  h.emu.forbid(null);
  h.emu.reset();
}
const row = (table, userId) => h.emu.table(table).filter((r) => r.user_id === userId)[0] || null;
const tasks = (caseId, type) => h.emu.table('registration_tasks').filter((r) => r.case_id === caseId && (!type || r.task_type === type));
const openTasks = (caseId, type) => tasks(caseId, type).filter((r) => ['open', 'in_progress', 'waiting', 'waiting_on_gp', 'blocked'].indexOf(r.status) !== -1 || !r.status);

function auBody(over) {
  return {
    _version: 2, currentStep: 4, country: '', registerNumber: '', qualDocs: {}, accountReviewFlag: false,
    targetDate: '', preferredCity: '', whoMoving: '', childrenCount: 1, childrenAges: [],
    leadSource: 'google', leadSourceDetail: '', idVerification: null, completedAt: null,
    auBranch: 'yes',
    au: Object.assign({
      step: 5, ahpraNumber: 'MED0001234567', registrationType: 'specialist', fellowship: 'fracgp', fellowshipDetail: '',
      hasConditions: false, conditionsDetail: '', moratorium19ab: 'no',
      workRights: 'citizen', permitSubclass: '', permitExpiry: '',
      currentPractice: 'Test Current Practice (FAKE)', noticeWeeks: 4, availableFrom: '2026-12-18',
      locations: ['Sydney'], suburb: 'Parramatta', state: 'NSW', postcode: '2150',
      sessions: 8, detailsConfirmed: true
    }, over || {})
  };
}
const A_ANSWERS = {};
const B_ANSWERS = { workRights: 'temporary', permitSubclass: '482', permitExpiry: '2028-01-01' };
const C_REGISTRAR = { fellowship: 'registrar', registrationType: 'general' };
const C_NON_VR = { fellowship: 'none', registrationType: 'general' };

function fresh() {
  counter += 1;
  const d = buildAuDoctor('overseas_null', {
    idSuffix: 'r' + counter, noCase: true,
    profile: { registration_country: '', qualification_country: '', preferred_city: '', register_body: null, register_number: null, register_status: null, onboarding_completed_at: null }
  });
  d.state.state = {};
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}
const complete = (d, over) => h.post('/api/onboarding/complete', auBody(over), { cookie: d.cookie });

beforeAll(async () => { h = await bootAuTestServer({ name: 'fr1-r02-r04' }); }, 60000);
afterAll(async () => { if (h) await h.close(); });

describe('R-02: the rule (decideAuOnboardingPathwayWrite), every direction', () => {
  const decide = auOnboarding.decideAuOnboardingPathwayWrite;
  const AU = ['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar'];
  it('nothing recorded, onboarding not finished: the first-time answer is written', () => {
    for (const d of AU) expect(decide({ storedPathway: null, onboardingComplete: false, derivedPathway: d }).action).toBe('write');
    for (const stored of ['overseas_esp', 'overseas_pep', '', 'garbage']) {
      expect(decide({ storedPathway: stored, setBy: STAFF_EMAIL, onboardingComplete: false, derivedPathway: 'au_vr' }).action).toBe('write');
    }
  });
  it('an already-onboarded overseas doctor (nothing or an overseas pathway recorded) is refused, whatever the answers', () => {
    for (const stored of [null, 'overseas_esp', 'overseas_pep']) for (const d of AU) {
      expect(decide({ storedPathway: stored, onboardingComplete: true, derivedPathway: d }).action).toBe('refuse');
    }
  });
  it('a self-declared pathway: the whole 4 x 4 table', () => {
    for (const stored of AU) for (const derived of AU) {
      const r = decide({ storedPathway: stored, setBy: 'self', confirmed: false, onboardingComplete: true, derivedPathway: derived });
      if (stored === derived) expect(r.action, stored + '->' + derived).toBe('keep');
      else if (stored === 'au_vr') expect(r.action, stored + '->' + derived).toBe('tighten');   // A -> B / C: more restricted only
      else expect(r.action, stored + '->' + derived).toBe('keep');                             // B/C -> anything: never by the doctor
      expect(r.differs).toBe(stored !== derived);
      // The one thing that must never happen: a held doctor ends on the launched pathway by their own answer.
      if (stored !== 'au_vr' && derived === 'au_vr') expect(['keep']).toContain(r.action);
    }
  });
  it('a staff-set or staff-confirmed pathway is never changed by the doctor, in any direction, finished or not', () => {
    for (const stored of AU) for (const derived of AU) for (const done of [true, false]) {
      for (const who of [{ setBy: STAFF_EMAIL, confirmed: true }, { setBy: STAFF_EMAIL, confirmed: false }, { setBy: '', confirmed: false }, { setBy: 'self', confirmed: true }]) {
        const r = decide(Object.assign({ storedPathway: stored, onboardingComplete: done, derivedPathway: derived }, who));
        expect(r.action, JSON.stringify([stored, derived, who])).toBe('keep');
      }
    }
  });
});

describe('R-02: POST /api/onboarding/complete, run again', () => {
  it('the reviewer\'s reproduction: a self-declared registrar re-posts with segment A answers and stays held; staff are asked to decide', async () => {
    const d = fresh();
    loadDb([d]);
    const first = await complete(d, C_REGISTRAR);
    expect(first.status).toBe(200);
    expect(first.json.auPathway).toMatchObject({ pathway: 'au_registrar', launched: false });
    const caseId = row('registration_cases', d.userId).id;

    const again = await complete(d, A_ANSWERS);
    expect(again.status).toBe(200);
    expect(again.json.auPathway).toMatchObject({ pathway: 'au_registrar', launched: false });
    expect(again.json.auNext).toBe('team_review');
    const prof = row('user_profiles', d.userId);
    expect(prof.candidate_pathway).toBe('au_registrar');
    expect(prof.pathway_confirmed_at).toBeNull();
    expect(row('registration_cases', d.userId).pathway).toBe('au_registrar');
    const review = openTasks(caseId, 'segment_review');
    expect(review.length).toBe(1);
    expect(review[0].metadata.reasons).toContain('onboarding_reanswered');
    expect(h.emu.table('task_timeline').some((e) => e.case_id === caseId && /answered onboarding again/.test(e.title || ''))).toBe(true);

    // and the careers gate still holds them
    const roles = await h.get('/api/career/roles', { cookie: d.cookie });
    expect(roles.status).toBe(200);
    expect(Array.isArray(roles.json.roles) ? roles.json.roles.length : 0).toBe(0);
  });

  it.each([
    ['B -> A', B_ANSWERS, 'au_restricted'],
    ['C (non-VR) -> A', C_NON_VR, 'au_non_vr'],
    ['C (registrar) -> A', C_REGISTRAR, 'au_registrar']
  ])('%s: refused to loosen', async (_label, firstAnswers, held) => {
    const d = fresh();
    loadDb([d]);
    expect((await complete(d, firstAnswers)).json.auPathway.pathway).toBe(held);
    const again = await complete(d, A_ANSWERS);
    expect(again.json.auPathway.pathway).toBe(held);
    expect(row('user_profiles', d.userId).candidate_pathway).toBe(held);
    expect(row('user_profiles', d.userId).pathway_set_by).toBe('self');
  });

  it('B <-> C by the doctor: not changed either, and flagged', async () => {
    const d = fresh();
    loadDb([d]);
    await complete(d, C_NON_VR);
    const again = await complete(d, B_ANSWERS);
    expect(again.json.auPathway.pathway).toBe('au_non_vr');
    const caseId = row('registration_cases', d.userId).id;
    expect(openTasks(caseId, 'segment_review').length).toBe(1);
  });

  it('A -> B (self-declared, unconfirmed): allowed, because it is MORE restricted, and still flagged to staff', async () => {
    const d = fresh();
    loadDb([d]);
    expect((await complete(d, A_ANSWERS)).json.auPathway.pathway).toBe('au_vr');
    const again = await complete(d, B_ANSWERS);
    expect(again.status).toBe(200);
    expect(again.json.auPathway).toMatchObject({ pathway: 'au_restricted', launched: false });
    expect(row('user_profiles', d.userId).candidate_pathway).toBe('au_restricted');
    const caseId = row('registration_cases', d.userId).id;
    expect(openTasks(caseId, 'segment_review').length).toBe(1);
    // ...and it cannot be walked back
    const back = await complete(d, A_ANSWERS);
    expect(back.json.auPathway.pathway).toBe('au_restricted');
  });

  it('the same answers again change nothing and raise no review', async () => {
    const d = fresh();
    loadDb([d]);
    await complete(d, A_ANSWERS);
    const setAt = row('user_profiles', d.userId).pathway_set_at;
    const again = await complete(d, A_ANSWERS);
    expect(again.status).toBe(200);
    expect(row('user_profiles', d.userId).pathway_set_at).toBe(setAt);
    expect(tasks(row('registration_cases', d.userId).id, 'segment_review').length).toBe(0);
  });

  it('overseas -> Australian AFTER onboarding is refused: nothing is written', async () => {
    const d = buildAuDoctor('overseas_null', { idSuffix: 'done1' });
    d.cookie = h.gpCookie(d.email, d.userId);
    loadDb([d]);
    expect(row('user_profiles', d.userId).onboarding_completed_at).toBeTruthy();
    const before = JSON.stringify([row('user_profiles', d.userId), row('user_state', d.userId), row('registration_cases', d.userId)]);
    h.emu.reset();
    const res = await complete(d, A_ANSWERS);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ ok: false, code: 'onboarding_already_complete' });
    expect(h.emu.requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD').length).toBe(0);
    expect(JSON.stringify([row('user_profiles', d.userId), row('user_state', d.userId), row('registration_cases', d.userId)])).toBe(before);
    expect(row('gp_credentials', d.userId)).toBeNull();
  });

  it('the same for a doctor whose pathway staff recorded as overseas', async () => {
    const d = buildAuDoctor('overseas_explicit', { idSuffix: 'done2' });
    d.cookie = h.gpCookie(d.email, d.userId);
    loadDb([d]);
    const res = await complete(d, A_ANSWERS);
    expect(res.status).toBe(409);
    expect(row('user_profiles', d.userId).candidate_pathway).toBe('overseas_esp');
  });

  it('a FIRST-time Australian onboarding by a doctor who signed up as overseas and never finished is still allowed', async () => {
    const d = fresh();
    d.profile.registration_country = 'United Kingdom';
    d.state.state = { gp_selected_country: 'United Kingdom', gp_onboarding: { country: 'GB', currentStep: 1 } };
    loadDb([d]);
    const res = await complete(d, A_ANSWERS);
    expect(res.status).toBe(200);
    expect(row('user_profiles', d.userId)).toMatchObject({ candidate_pathway: 'au_vr', pathway_set_by: 'self', pathway_confirmed_at: null });
  });

  it('Australian -> overseas by the doctor is refused (the overseas wizard cannot be completed)', async () => {
    const d = fresh();
    loadDb([d]);
    await complete(d, C_REGISTRAR);
    const res = await h.post('/api/onboarding/complete', {
      _version: 2, currentStep: 4, country: 'GB', registerNumber: '7654321', qualDocs: {}, targetDate: '2027-08-01', preferredCity: 'Sydney',
      whoMoving: 'just_me', childrenCount: 1, childrenAges: [], leadSource: 'google', idVerification: { status: 'verified', fileName: 'id.jpg' }, completedAt: '2026-11-20T03:00:00.000Z'
    }, { cookie: d.cookie });
    expect(res.status).toBe(409);
    expect(row('user_profiles', d.userId).candidate_pathway).toBe('au_registrar');
  });

  it('a staff-set segment B doctor answering as segment A: unchanged (as before this fix)', async () => {
    const d = buildAuDoctor('au_restricted', { idSuffix: 'st1', profile: { onboarding_completed_at: null } });
    d.cookie = h.gpCookie(d.email, d.userId);
    loadDb([d]);
    const res = await complete(d, A_ANSWERS);
    expect(res.status).toBe(200);
    expect(res.json.auPathway.pathway).toBe('au_restricted');
    expect(row('user_profiles', d.userId).pathway_set_by).toBe(STAFF_EMAIL);
  });

  it('FAIL CLOSED: if the pathway on record cannot be read, the completion is refused and nothing is written', async () => {
    const d = fresh();
    loadDb([d]);
    await complete(d, C_REGISTRAR);
    h.emu.failTables = { user_profiles: 500 };
    let res;
    try { res = await complete(d, A_ANSWERS); } finally { h.emu.failTables = {}; }
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('pathway_unreadable');
    expect(row('user_profiles', d.userId).candidate_pathway).toBe('au_registrar');
  });

  it('switch off: the Australian keys are ignored exactly as before (no refusal, no new read)', async () => {
    const d = buildAuDoctor('overseas_null', { idSuffix: 'off1' });
    d.cookie = h.gpCookie(d.email, d.userId);
    loadDb([d]);
    h.setSwitch(false);
    try {
      const res = await complete(d, A_ANSWERS);
      expect(res.json && res.json.code).not.toBe('onboarding_already_complete');
      expect(row('user_profiles', d.userId).candidate_pathway == null).toBe(true);
    } finally { h.setSwitch(true); }
  });
});

describe('R-04: the cleaner locks staff-verified facts for a self write', () => {
  const verified = { staff_verified_at: FIXED_NOW, staff_verified_by: STAFF_EMAIL, ahpra_registration_type: 'specialist', fellowship_type: 'fracgp', work_rights: 'citizen' };
  it('every locked field is refused, listed, and nothing staff wrote is touched', () => {
    const patch = {
      ahpra_number: 'MED0009999999', ahpra_registration_type: 'general', specialist_gp: true, has_conditions: false, conditions_text: 'x',
      has_undertakings: false, undertakings_text: 'x', has_notations: false, notations_text: 'x', registration_expiry: '2030-01-01',
      fellowship_type: 'both', fellowship_detail: 'x', fellowship_year: 2001, vr_status: 'vr', work_rights: 'pr', visa_sponsor_tied: false, supervision_level: 'none',
      indemnity_provider: 'Test Indemnity (FAKE)'
    };
    const out = gpCredentials.sanitiseCredentialsPatch(patch, { source: 'self', existing: verified, now: FIXED_NOW });
    expect(out.locked.slice().sort()).toEqual(gpCredentials.STAFF_VERIFIED_LOCKED_FIELDS.slice().sort());
    expect(Object.keys(out.clean).sort()).toEqual(['indemnity_provider', 'self_declared_at']);
    expect(out.clean.staff_verified_at).toBeUndefined();
  });
  it('not verified yet: a doctor can still edit their own answers (unchanged)', () => {
    const out = gpCredentials.sanitiseCredentialsPatch({ fellowship_type: 'both', work_rights: 'pr' }, { source: 'self', existing: { fellowship_type: 'fracgp' }, now: FIXED_NOW });
    expect(out.locked).toEqual([]);
    expect(out.clean).toMatchObject({ fellowship_type: 'both', work_rights: 'pr' });
  });
  it('staff are never locked', () => {
    const out = gpCredentials.sanitiseCredentialsPatch({ fellowship_type: 'both', ahpra_registration_type: 'general' }, { source: 'staff', actor: STAFF_EMAIL, existing: verified, now: FIXED_NOW });
    expect(out.locked).toEqual([]);
    expect(out.clean).toMatchObject({ fellowship_type: 'both', ahpra_registration_type: 'general' });
  });
});

describe('R-04: POST /api/account/au-details for a staff-verified doctor', () => {
  function verifiedDoctor(suffix) {
    const d = buildAuDoctor('au_vr', { idSuffix: suffix, credentials: { staff_verified_at: FIXED_NOW, staff_verified_by: STAFF_EMAIL } });
    d.cookie = h.gpCookie(d.email, d.userId);
    return d;
  }

  it('the reviewer\'s reproduction: editing type / fellowship / right to work changes NOTHING verified; it becomes a request staff see', async () => {
    const d = verifiedDoctor('acc1');
    loadDb([d]);
    const before = JSON.parse(JSON.stringify(row('gp_credentials', d.userId)));
    expect(before.staff_verified_at).toBeTruthy();
    const res = await h.post('/api/account/au-details', { registrationType: 'general', fellowshipType: 'both', workRights: 'temporary' }, { cookie: d.cookie });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, changeRequested: true, registrationChanged: false, registrationLocked: true });
    expect(res.json.changeRequestedFields.sort()).toEqual(['ahpra_registration_type', 'fellowship_type', 'work_rights']);
    // what the page shows after the save is still the verified record
    expect(res.json.registrationType).toBe(before.ahpra_registration_type);
    expect(res.json.fellowshipType).toBe(before.fellowship_type);
    const after = row('gp_credentials', d.userId);
    for (const k of gpCredentials.STAFF_VERIFIED_LOCKED_FIELDS) expect(after[k], k).toEqual(before[k]);
    expect(after.staff_verified_at).toBe(before.staff_verified_at);
    expect(after.staff_verified_by).toBe(before.staff_verified_by);
    // the pathway and its confirmation are untouched
    expect(row('user_profiles', d.userId)).toMatchObject({ candidate_pathway: 'au_vr', pathway_confirmed_by: d.profile.pathway_confirmed_by });
    // staff see it: the Ahpra check task is open again and carries the proposal
    const check = openTasks(d.caseId, 'ahpra_register_check');
    expect(check.length).toBe(1);
    expect(check[0].metadata.proposed_changes).toMatchObject({
      ahpra_registration_type: { from: before.ahpra_registration_type, to: 'general' },
      fellowship_type: { from: before.fellowship_type, to: 'both' },
      work_rights: { from: before.work_rights, to: 'visa' }
    });
    expect(check[0].description).toMatch(/THE DOCTOR SAYS THEIR DETAILS HAVE CHANGED/);
    expect(check[0].description).toMatch(/fellowship: fracgp -> both/);
    expect(h.emu.table('task_timeline').some((e) => e.case_id === d.caseId && /registration details have changed/.test(e.title || ''))).toBe(true);
  });

  it('a second request updates the same open task (no second task) and the proposal is replaced, not stacked', async () => {
    const d = verifiedDoctor('acc2');
    loadDb([d]);
    await h.post('/api/account/au-details', { fellowshipType: 'both' }, { cookie: d.cookie });
    await h.post('/api/account/au-details', { fellowshipType: 'facrrm' }, { cookie: d.cookie });
    const check = openTasks(d.caseId, 'ahpra_register_check');
    expect(check.length).toBe(1);
    expect(check[0].metadata.proposed_changes.fellowship_type.to).toBe('facrrm');
    expect((check[0].description.match(/THE DOCTOR SAYS/g) || []).length).toBe(1);
  });

  it('unlocked details (where they are now, notice period) still save normally for a verified doctor', async () => {
    const d = verifiedDoctor('acc3');
    loadDb([d]);
    const res = await h.post('/api/account/au-details', { noticePeriodWeeks: 6, currentState: 'WA' }, { cookie: d.cookie });
    expect(res.status).toBe(200);
    expect(res.json.changeRequested).toBe(false);
    expect(row('user_profiles', d.userId)).toMatchObject({ notice_period_weeks: 6, current_state: 'WA' });
    expect(openTasks(d.caseId, 'ahpra_register_check').length).toBe(0);
  });

  it('a doctor who is NOT yet verified edits their own answers as before (written, staff asked to check)', async () => {
    const d = buildAuDoctor('au_vr', { idSuffix: 'acc4', selfDeclared: true, credentials: { staff_verified_at: null, staff_verified_by: null } });
    d.cookie = h.gpCookie(d.email, d.userId);
    loadDb([d]);
    const res = await h.post('/api/account/au-details', { fellowshipType: 'both' }, { cookie: d.cookie });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ registrationChanged: true, changeRequested: false, registrationLocked: false });
    expect(row('gp_credentials', d.userId).fellowship_type).toBe('both');
  });

  it('onboarding again cannot change them either', async () => {
    const d = verifiedDoctor('acc5');
    loadDb([d]);
    const before = JSON.parse(JSON.stringify(row('gp_credentials', d.userId)));
    const res = await h.post('/api/onboarding/complete', auBody({ fellowship: 'both', registrationType: 'general_and_specialist', workRights: 'pr' }), { cookie: d.cookie });
    expect(res.status).toBe(200);
    const after = row('gp_credentials', d.userId);
    for (const k of gpCredentials.STAFF_VERIFIED_LOCKED_FIELDS) expect(after[k], k).toEqual(before[k]);
    expect(row('user_profiles', d.userId).candidate_pathway).toBe('au_vr');
  });

  it('an overseas doctor and the switch-off product: the route answers exactly as before (not available)', async () => {
    const o = buildAuDoctor('overseas_null', { idSuffix: 'acc6' });
    o.cookie = h.gpCookie(o.email, o.userId);
    loadDb([o]);
    const on = await h.post('/api/account/au-details', { fellowshipType: 'both' }, { cookie: o.cookie });
    h.setSwitch(false);
    let off;
    try { off = await h.post('/api/account/au-details', { fellowshipType: 'both' }, { cookie: o.cookie }); } finally { h.setSwitch(true); }
    expect(on.status).toBe(off.status);
    expect(on.status).toBeGreaterThanOrEqual(400);
    expect(row('gp_credentials', o.userId)).toBeNull();
  });
});

describe('R-04: the practice introduction states a fellowship as fact only from a staff-verified record', () => {
  const base = () => buildAuDoctor('au_vr', { idSuffix: 'intro', credentials: { staff_verified_at: FIXED_NOW, staff_verified_by: STAFF_EMAIL } });
  const facts = (d, credOver, profOver) => {
    const credentials = Object.assign({}, d.credentials, credOver || {});
    const profile = Object.assign({}, d.profile, { register_status: 'verified' }, profOver || {});
    const pathwayResult = candidatePathway.resolvePathwayFromRecords({ profile, credentials, flagEnabled: true });
    return careerIntro.auIntroFactsFromRecords({ pathwayResult, credentials, profile });
  };
  it('verified record: stated', () => {
    const f = facts(base());
    expect(f.fellowshipConfirmed).toBe(true);
  });
  it('a confirmed pathway WITHOUT the verified stamp: the fellowship on file is still the doctor\'s word, so not stated', () => {
    const f = facts(base(), { staff_verified_at: null, staff_verified_by: null });
    expect(f.pathwayConfirmed).toBe(true);
    expect(f.fellowshipConfirmed).toBe(false);
  });
});

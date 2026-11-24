// Australian GP build, WP-05: the Australian onboarding branch, end to end
// against the real server and the in-memory database stub.
//
//   - An Australian payload writes: country (explicitly Australia), the
//     register number, the pathway (self-declared, not confirmed), credentials,
//     preferences, the complete flag, and a case on the Australian ladder.
//   - Bad answers are refused and nothing is written.
//   - Switch off: the Australian keys are just unread keys on the stored blob;
//     nothing new is written or queried.
//   - UK / Ireland / New Zealand payloads store and answer exactly the same
//     with the switch on as with it off.
//   - Resume, the "started the Australian branch" marker, and the sweeps.
//   - Release from the eligibility waitlist, and the invite.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { wp02NewNameViolation } = require('./helpers/au-supabase-emulator.js');
const { buildAuDoctor, buildAuFixtureDb, WP02_NEW_COLUMN_NAMES, WP02_NEW_TABLES, wp03NewStageViolation } = require('./helpers/au-fixtures.js');
const auOnboarding = require('../lib/au-onboarding.js');

const MARKER = auOnboarding.AU_BRANCH_MARKER_KEY;
const NAMES = { columns: WP02_NEW_COLUMN_NAMES, tables: WP02_NEW_TABLES };
const EMPTY_TABLES = ['registration_tasks', 'task_timeline', 'gp_applications', 'placements', 'user_documents',
  'admin_audit_log', 'candidate_leads', 'onboarding_reminders', 'pep_waitlist', 'runtime_kv', 'rate_limits'];

let h, t;
let counter = 0;
const resendCalls = [];

// A brand-new doctor: signed up, nothing answered yet.
function fresh(opts) {
  const o = opts || {};
  counter += 1;
  const d = buildAuDoctor('overseas_null', {
    idSuffix: 'w' + counter,
    noCase: !o.withCase,
    profile: {
      registration_country: '', qualification_country: '', preferred_city: '', target_arrival_date: '',
      who_moving: '', children_count: '', gmc_number: '', register_body: null, register_number: null,
      register_status: null, onboarding_completed_at: null
    }
  });
  d.state.state = Object.assign({}, o.state || {});
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}

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
  resendCalls.length = 0;
}

const row = (table, userId) => h.emu.table(table).filter((r) => r.user_id === userId)[0] || null;
const writes = () => h.emu.requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD');

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
      currentPractice: 'Test Current Practice (FAKE)', noticeWeeks: 4, availableFrom: '2026-12-18',
      locations: ['Regional NSW', 'Sydney', 'Newcastle'], suburb: 'Parramatta', state: 'NSW', postcode: '2150',
      sessions: 8, detailsConfirmed: true
    }, over || {})
  };
}

function overseasBody(country, registerNumber) {
  return {
    _version: 2, currentStep: 4, country, registerNumber, qualDocs: {}, accountReviewFlag: false,
    targetDate: '2027-08-01', preferredCity: 'Sydney', whoMoving: 'just_me', childrenCount: 1, childrenAges: [],
    leadSource: 'google', leadSourceDetail: '', idVerification: { status: 'verified', fileName: 'id.jpg' },
    completedAt: '2026-11-20T03:00:00.000Z'
  };
}

beforeAll(async () => {
  h = await bootAuTestServer({ name: 'wp05' });
  t = h.testUtils;
  // Record anything that would have gone to the email provider.
  const stubbed = globalThis.fetch;
  globalThis.fetch = function (url, init) {
    const u = String(url && url.url ? url.url : url);
    if (u.indexOf('api.resend.com') !== -1) {
      let body = null;
      try { body = JSON.parse(init && init.body ? init.body : 'null'); } catch (e) { body = null; }
      resendCalls.push({ url: u, body });
      return Promise.resolve(new Response(JSON.stringify({ id: 'stub-email' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return stubbed(url, init);
  };
}, 60000);

afterAll(async () => { if (h) await h.close(); });

beforeEach(() => {
  h.setSwitch(true);
  delete process.env.RESEND_API_KEY;
});

describe('an Australian payload (switch on)', () => {
  it('writes country, register number, pathway, credentials, preferences, the complete flag and a case on the Australian ladder', async () => {
    const d = fresh({ state: { [MARKER]: '2026-11-20T01:00:00.000Z', gp_link_updates: '[]' } });
    loadDb([d]);
    process.env.RESEND_API_KEY = 'test-key';   // so a "profile complete" email WOULD be sent if the branch sent one
    const res = await h.post('/api/onboarding/complete', auBody(), { cookie: d.cookie });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      ok: true, registerVerification: null, pepGated: false,
      auPathway: { pathway: 'au_vr', segment: 'A', isAu: true, launched: true },
      auNext: 'careers', auCaseStage: 'placement'
    });
    // The reply never carries the DPA flag or anything staff-side.
    expect(JSON.stringify(res.json)).not.toMatch(/dpa|needsStaffReview|confirmed/i);

    const p = row('user_profiles', d.userId);
    // APP-18: country written explicitly, in the fields today's code reads.
    expect(p.qualification_country).toBe('AU');
    expect(p.registration_country).toBe('Australia');
    // DAT-01: the register number through the existing register columns.
    expect(p).toMatchObject({ register_body: 'ahpra', register_number: 'MED0001234567', register_status: 'pending_verification' });
    expect(p.preferred_city).toBe('Sydney');
    expect(p.onboarding_completed_at).toBeTruthy();
    expect(p.lead_source).toBe('google');
    // Pathway: self-declared, not confirmed.
    expect(p).toMatchObject({ candidate_pathway: 'au_vr', candidate_basis: 'australia', pathway_set_by: 'self', pathway_confirmed_at: null, pathway_confirmed_by: null });
    // Preferences.
    expect(p).toMatchObject({ current_suburb: 'Parramatta', current_state: 'NSW', current_postcode: '2150', notice_period_weeks: 4, available_from: '2026-12-18', sessions_wanted: 8 });
    // Nothing about a move was written.
    expect(p.target_arrival_date).toBe('');
    expect(p.who_moving).toBe('');

    const c = row('gp_credentials', d.userId);
    expect(c).toMatchObject({
      ahpra_number: 'MED0001234567', ahpra_registration_type: 'specialist', specialist_gp: true,
      has_conditions: false, fellowship_type: 'fracgp', vr_status: 'vr',
      moratorium_19ab_status: 'no', work_rights: 'citizen', visa_subclass: null, visa_expiry: null
    });
    expect(c.self_declared_at).toBeTruthy();
    expect(c.staff_verified_at == null).toBe(true);
    expect(c.moratorium_19ab_confirmed_status == null).toBe(true);

    const s = row('user_state', d.userId).state;
    expect(s.gp_onboarding_complete).toBe(true);
    expect(s.gp_selected_country).toBe('Australia');
    expect(MARKER in s).toBe(false);
    expect(s.gp_link_updates).toBe('[]');                       // other keys untouched
    expect(s.gp_onboarding).toMatchObject({ auBranch: 'yes', country: 'AU', registerNumber: 'MED0001234567' });
    expect(s.gp_onboarding.completedAt).toBeTruthy();
    expect(s.gp_onboarding.au).toMatchObject({ ahpraNumber: 'MED0001234567', locations: ['Regional NSW', 'Sydney', 'Newcastle'], currentPractice: 'Test Current Practice (FAKE)', workRights: 'citizen' });

    const k = row('registration_cases', d.userId);
    expect(k).toMatchObject({ stage: 'placement', pathway: 'au_vr', status: 'active' });

    // What every later package asks: Australian, needs a person to confirm,
    // and STILL limited to DPA roles (the doctor's own 19AB "no" unlocks nothing).
    const resolved = await t.resolveCandidatePathway(d.userId, { legacyDpaExempt: true });
    expect(resolved).toMatchObject({ pathway: 'au_vr', isAu: true, launched: true, confirmed: false, needsStaffReview: true, dpaRestricted: true });
    expect(resolved.dpaRestrictedReason).toBe('self_declared_no_awaiting_staff_confirmation');

    // The "profile complete, next step MyIntealth" email is NOT sent on this branch.
    // Changed deliberately by WP-17 (N08): the Australian "profile complete"
    // email is sent instead, once (its words are tested in
    // tests/au-wp17-welcome-onboarding-server.test.js).
    expect(resendCalls.map((c) => (c.body || c).subject)).toEqual(['Your profile is complete: we are lining up matches']);
    expect(JSON.stringify(resendCalls)).not.toMatch(/MyIntealth/);
  });

  it('each segment: stored pathway, what the doctor is told next, and that staff review is readable', async () => {
    const cases = [
      ['au_vr', {}, 'careers', true],
      ['au_vr', { fellowship: 'facrrm', workRights: 'pr', registrationType: 'general_and_specialist', moratorium19ab: 'unsure' }, 'careers', true],
      ['au_restricted', { moratorium19ab: 'yes' }, 'team_review', false],
      ['au_restricted', { hasConditions: true, conditionsDetail: 'Test condition (FAKE)' }, 'team_review', false],
      ['au_restricted', { workRights: 'temporary', permitSubclass: '482', permitExpiry: '2028-06-30' }, 'team_review', false],
      ['au_restricted', { registrationType: 'limited' }, 'team_review', false],
      ['au_restricted', { registrationType: 'provisional' }, 'team_review', false],
      ['au_restricted', { registrationType: 'unsure' }, 'team_review', false],
      ['au_restricted', { registrationType: 'non_practising' }, 'team_review', false],
      ['au_non_vr', { fellowship: 'none' }, 'team_review', false],
      ['au_non_vr', { fellowship: 'other', fellowshipDetail: 'Test Fellowship (FAKE)' }, 'team_review', false],
      ['au_non_vr', { registrationType: 'general' }, 'team_review', false],
      ['au_registrar', { fellowship: 'registrar', registrationType: 'general' }, 'team_review', false]
    ];
    for (const [pathway, over, next, launched] of cases) {
      const d = fresh();
      loadDb([d]);
      const res = await h.post('/api/onboarding/complete', auBody(over), { cookie: d.cookie });
      const label = pathway + ' ' + JSON.stringify(over);
      expect(res.status, label).toBe(200);
      expect(res.json.auPathway, label).toMatchObject({ pathway, isAu: true, launched });
      expect(res.json.auNext, label).toBe(next);
      expect(row('user_profiles', d.userId).candidate_pathway, label).toBe(pathway);
      expect(row('user_profiles', d.userId).pathway_confirmed_at, label).toBeNull();
      expect(row('registration_cases', d.userId), label).toMatchObject({ stage: 'placement', pathway });
      expect(row('user_state', d.userId).state.gp_onboarding_complete, label).toBe(true);
      const resolved = await t.resolveCandidatePathway(d.userId);
      expect(resolved.needsStaffReview, label).toBe(true);
      expect(resolved.dpaRestricted, label).toBe(true);
      expect(resolved.launched, label).toBe(launched);
    }
  });

  it('stores the answers that are not stored values the way the credentials model spells them', async () => {
    const d = fresh();
    loadDb([d]);
    await h.post('/api/onboarding/complete', auBody({
      workRights: 'temporary', permitSubclass: '482', permitExpiry: '2028-06-30',
      fellowship: 'registrar', registrationType: 'unsure', hasConditions: true, conditionsDetail: 'Test condition (FAKE)',
      locations: ['Regional QLD'], sessions: ''
    }), { cookie: d.cookie });
    expect(row('gp_credentials', d.userId)).toMatchObject({
      work_rights: 'visa', visa_subclass: '482', visa_expiry: '2028-06-30',
      fellowship_type: 'none', vr_status: 'non_vr', ahpra_registration_type: null,
      has_conditions: true, conditions_text: 'Test condition (FAKE)'
    });
    const p = row('user_profiles', d.userId);
    expect(p.preferred_city).toBe('');           // regional only: no single city to rank by
    expect(p.sessions_wanted).toBeNull();
    expect(p.candidate_pathway).toBe('au_restricted');
  });

  it('a doctor who already has a case at "myintealth" is moved onto the Australian ladder', async () => {
    const d = fresh({ withCase: true });
    loadDb([d]);
    expect(row('registration_cases', d.userId).stage).toBe('myintealth');
    const res = await h.post('/api/onboarding/complete', auBody(), { cookie: d.cookie });
    expect(res.status).toBe(200);
    expect(row('registration_cases', d.userId)).toMatchObject({ stage: 'placement', pathway: 'au_vr' });
    expect(h.emu.table('registration_cases').filter((r) => r.user_id === d.userId).length).toBe(1);
  });

  it('finishing twice is safe, and a settled register check is not downgraded', async () => {
    const d = fresh();
    loadDb([d]);
    await h.post('/api/onboarding/complete', auBody(), { cookie: d.cookie });
    row('user_profiles', d.userId).register_status = 'verified';
    const sessionsBefore = row('user_profiles', d.userId).sessions_wanted;
    const again = await h.post('/api/onboarding/complete', auBody({ sessions: 6 }), { cookie: d.cookie });
    expect(again.status).toBe(200);
    expect(row('user_profiles', d.userId).register_status).toBe('verified');
    // FR-2 (R2-02), deliberate: finishing a second time is still safe (200),
    // but it no longer overwrites anything stored the first time. (It used
    // to store the new sessions, 6.)
    expect(again.json.auAlreadyComplete).toBe(true);
    expect(sessionsBefore).not.toBe(6);
    // FR-4 (M4-03), deliberate: preferences are not pathway facts, so the
    // repeat saves them again (as it did before FR-2); registration answers
    // are still never overwritten (tests/au-fr2-r202-repeat-completion.test.js).
    expect(row('user_profiles', d.userId).sessions_wanted).toBe(6);
    expect(h.emu.table('gp_credentials').filter((r) => r.user_id === d.userId).length).toBe(1);
    expect(h.emu.table('registration_cases').filter((r) => r.user_id === d.userId).length).toBe(1);
  });

  it('a pathway typed into the payload is ignored: the server derives it', async () => {
    const d = fresh();
    loadDb([d]);
    const body = auBody({ hasConditions: true });
    Object.assign(body, { candidate_pathway: 'au_vr', pathway: 'au_vr', pathway_confirmed_at: '2026-01-01T00:00:00.000Z' });
    Object.assign(body.au, { pathway: 'au_vr', staff_verified_at: '2026-01-01T00:00:00.000Z', moratorium_19ab_confirmed_status: 'no' });
    const res = await h.post('/api/onboarding/complete', body, { cookie: d.cookie });
    expect(res.json.auPathway.pathway).toBe('au_restricted');
    expect(row('user_profiles', d.userId)).toMatchObject({ candidate_pathway: 'au_restricted', pathway_confirmed_at: null });
    const c = row('gp_credentials', d.userId);
    expect(c.staff_verified_at == null).toBe(true);
    expect(c.moratorium_19ab_confirmed_status == null).toBe(true);
  });
});

describe('writing "Australia" as the country does not open roles outside a DPA', () => {
  // The careers gate used to read "country = Australia" as "may see non-DPA
  // roles". The branch writes that country, so for a doctor on an Australian
  // pathway the answer must come from the pathway rule instead.
  //
  // REWRITTEN BY WP-08, same intent. WP-05 enforced this with an interim guard
  // INSIDE _resolveGpJobsProfile (it rewrote `australiaTrained` to false for
  // an Australian doctor), and these tests pinned that boolean. WP-08 moved
  // the decision to the one role rule (resolveRoleEligibilityContext ->
  // roleEligibility.roleEligibilityFor) and removed the guard, so
  // `australiaTrained` is once more only "the country reads as Australia"
  // (true here) and is IGNORED for an Australian pathway. What is asserted
  // now is the thing that matters: the doctor cannot have a role outside a DPA.
  const NON_DPA_ROLE = { id: 'r-non-dpa', dpa: false, vr_requirement: 'non_vr_accepted', accepts_registrars: true, accepts_supervised: true };
  const DPA_ROLE = { id: 'r-dpa', dpa: true, vr_requirement: 'non_vr_accepted', accepts_registrars: true, accepts_supervised: true };
  const roleEligibility = require('../lib/role-eligibility.js');

  it('a doctor who finished the branch stays DPA-only whatever they said about 19AB, until staff confirm', async () => {
    for (const answer of ['no', 'unsure', 'yes']) {
      const d = fresh();
      loadDb([d]);
      const res = await h.post('/api/onboarding/complete', auBody({ moratorium19ab: answer }), { cookie: d.cookie });
      expect(res.status, answer).toBe(200);
      expect(row('user_profiles', d.userId).registration_country).toBe('Australia');
      const jobs = await t._resolveGpJobsProfile(d.userId);
      expect(jobs.australiaTrained, answer).toBe(true);   // the country, nothing more
      expect(jobs.preferredCity).toBe('Sydney');
      const ctx = await t.resolveRoleEligibilityContext(d.userId, d.email);
      expect(ctx.pathway.isAu, answer).toBe(true);
      expect(ctx.pathway.dpaRestricted, answer).toBe(true);
      const nonDpa = roleEligibility.roleEligibilityFor(ctx.pathway, NON_DPA_ROLE);
      expect(nonDpa.eligible, answer).toBe(false);
      expect(nonDpa.canApply, answer).toBe(false);
      expect(nonDpa.reasons, answer).toContain('dpa_restricted');
      expect(roleEligibility.roleEligibilityFor(ctx.pathway, DPA_ROLE).eligible, answer).toBe(true);
    }
  });

  it('staff confirming "19AB does not apply" is what opens them', async () => {
    const d = fresh();
    loadDb([d]);
    await h.post('/api/onboarding/complete', auBody(), { cookie: d.cookie });
    Object.assign(row('gp_credentials', d.userId), {
      moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: 'staff.test@gplink-test.local',
      moratorium_19ab_confirmed_at: '2026-11-20T02:00:00.000Z'
    });
    expect((await t._resolveGpJobsProfile(d.userId)).australiaTrained).toBe(true);
    const ctx = await t.resolveRoleEligibilityContext(d.userId, d.email);
    expect(ctx.pathway.dpaRestricted).toBe(false);
    expect(roleEligibility.roleEligibilityFor(ctx.pathway, NON_DPA_ROLE).eligible).toBe(true);
  });

  it('an existing doctor whose country says Australia but who has no pathway is answered as before, switch on or off', async () => {
    const legacy = fresh();
    legacy.profile.registration_country = 'Australia';
    legacy.profile.onboarding_completed_at = '2026-10-02T00:00:00.000Z';
    const uk = fresh();
    uk.profile.registration_country = 'United Kingdom';
    uk.profile.preferred_city = 'Perth';
    loadDb([legacy, uk]);
    expect((await t._resolveGpJobsProfile(legacy.userId)).australiaTrained).toBe(true);
    // An overseas doctor: no extra query at all, switch on.
    h.emu.reset();
    expect(await t._resolveGpJobsProfile(uk.userId)).toEqual({ australiaTrained: false, preferredCity: 'Perth' });
    const onRequests = h.emu.requests.map((r) => r.table + ' ' + r.query);
    expect(onRequests.join('\n')).not.toMatch(/candidate_pathway|gp_credentials/);
    h.setSwitch(false);
    h.emu.reset();
    h.emu.forbid((r) => wp02NewNameViolation(r, NAMES));
    expect((await t._resolveGpJobsProfile(legacy.userId)).australiaTrained).toBe(true);
    expect(await t._resolveGpJobsProfile(uk.userId)).toEqual({ australiaTrained: false, preferredCity: 'Perth' });
    expect(h.emu.violations).toEqual([]);
  });
});

describe('bad or unsaveable answers', () => {
  it('invalid values are refused by name and NOTHING is written', async () => {
    const bad = [
      [{ ahpraNumber: '0001234567' }, 'ahpraNumber'],
      [{ registrationType: 'consultant' }, 'registrationType'],
      [{ fellowship: '' }, 'fellowship'],
      [{ hasConditions: 'no' }, 'hasConditions'],
      [{ moratorium19ab: 'maybe' }, 'moratorium19ab'],
      [{ workRights: 'visa' }, 'workRights'],
      [{ locations: ['Atlantis'] }, 'locations'],
      [{ locations: [] }, 'locations'],
      [{ state: 'ZZ' }, 'state'],
      [{ availableFrom: 'soon' }, 'availableFrom'],
      [{ noticeWeeks: 999 }, 'noticeWeeks'],
      [{ detailsConfirmed: false }, 'detailsConfirmed']
    ];
    for (const [over, field] of bad) {
      const d = fresh();
      loadDb([d]);
      const before = JSON.stringify(h.emu.db);
      const res = await h.post('/api/onboarding/complete', auBody(over), { cookie: d.cookie });
      expect(res.status, field).toBe(400);
      expect(res.json.code, field).toBe('au_invalid_answers');
      expect(Object.keys(res.json.errors), field).toContain(field);
      expect(writes(), field).toEqual([]);
      expect(JSON.stringify(h.emu.db), field).toBe(before);
    }
    const d = fresh();
    loadDb([d]);
    const noAnswers = await h.post('/api/onboarding/complete', { auBranch: 'yes' }, { cookie: d.cookie });
    expect(noAnswers.status).toBe(400);
    expect(writes()).toEqual([]);
  });

  it('if the pathway cannot be saved (migration not applied), nothing else is: the doctor is never left looking Australian', async () => {
    const d = fresh();
    loadDb([d]);
    h.emu.missingColumns = { user_profiles: WP02_NEW_COLUMN_NAMES.slice(), registration_cases: ['pathway'] };
    h.emu.missingTables = new Set(WP02_NEW_TABLES);
    const res = await h.post('/api/onboarding/complete', auBody(), { cookie: d.cookie });
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ ok: false, code: 'schema_missing' });
    const p = row('user_profiles', d.userId);
    expect(p.registration_country).toBe('');
    expect(p.qualification_country).toBe('');
    expect(p.onboarding_completed_at).toBeNull();
    expect(row('user_state', d.userId).state.gp_onboarding_complete).toBeUndefined();
  });

  it('needs a signed-in doctor', async () => {
    loadDb([fresh()]);
    const res = await h.post('/api/onboarding/complete', auBody());
    expect(res.status).toBe(401);
  });
});

describe('switch OFF: the Australian payload is not an Australian payload', () => {
  it('nothing new is written or queried; the two keys are just unread keys on the stored blob', async () => {
    const d = fresh();
    loadDb([d]);
    h.setSwitch(false);
    h.emu.forbid((r) => wp02NewNameViolation(r, NAMES) || wp03NewStageViolation(r));
    const body = auBody();
    const save = await h.post('/api/onboarding/save', body, { cookie: d.cookie });
    expect(save.json).toEqual({ ok: true });
    const res = await h.post('/api/onboarding/complete', body, { cookie: d.cookie });
    expect(res.status).toBe(200);
    // Exactly the reply every doctor gets today: no Australian key in it.
    expect(Object.keys(res.json).sort()).toEqual(['message', 'ok', 'pepGated', 'registerVerification']);
    expect(h.emu.violations).toEqual([]);
    expect(h.emu.requestsTo('gp_credentials')).toEqual([]);
    const p = row('user_profiles', d.userId);
    expect(p.candidate_pathway).toBeNull();
    expect(p.current_state).toBeNull();
    expect(p.available_from).toBeNull();
    expect(p.registration_country).toBe('');          // not written explicitly: as on main
    expect(p.qualification_country).toBe('');         // body.country is '' on this payload
    expect(row('gp_credentials', d.userId)).toBeNull();
    const s = row('user_state', d.userId).state;
    expect(MARKER in s).toBe(false);
    expect(s.gp_onboarding).toEqual(body);            // stored verbatim, as any blob is today
    const k = row('registration_cases', d.userId);
    expect(k === null || k.stage === 'myintealth').toBe(true);
  });

  it('the release endpoint does not exist, and the release function and the invite do nothing', async () => {
    const d = fresh({ state: { gp_eligibility_waitlist: JSON.stringify({ country: 'Australia', email: 'x', at: 'y' }) } });
    loadDb([d]);
    h.setSwitch(false);
    const sa = h.superAdmin();
    const res = await h.post('/api/admin/eligibility-waitlist/release', { user_id: d.userId, send_invite: true }, sa);
    expect(res.status).toBe(404);
    expect(await t.releaseEligibilityWaitlistForAu({ userId: d.userId }, { sendInvite: true })).toEqual({ ok: false, reason: 'feature_off' });
    expect(await t.sendAuWaitlistInviteEmail(d.userId)).toEqual({ ok: false, reason: 'feature_off' });
    expect(h.emu.requests).toEqual([]);
    expect(row('user_state', d.userId).state.gp_eligibility_waitlist).toBeTruthy();
  });
});

describe('UK / Ireland / New Zealand: identical with the switch on and off', () => {
  // Everything that legitimately differs between two runs: ids, emails, clocks.
  function normalise(value, d) {
    return JSON.parse(JSON.stringify(value)
      .split(d.userId).join('<user>')
      .split(d.email).join('<email>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<time>')
      .replace(/"id":"[0-9a-f-]{36}"/g, '"id":"<id>"'));
  }
  function stored(d) {
    return normalise({
      profile: row('user_profiles', d.userId),
      state: row('user_state', d.userId),
      cases: h.emu.table('registration_cases').filter((r) => r.user_id === d.userId),
      credentials: row('gp_credentials', d.userId)
    }, d);
  }
  const requestLog = (d) => normalise(h.emu.requests.map((r) => r.method + ' ' + r.table + ' ' + r.query + ' ' + JSON.stringify(r.body)), d);

  async function run(country, number, switchOn) {
    const d = fresh();
    loadDb([d]);
    h.setSwitch(switchOn);
    const body = overseasBody(country, number);
    const save = await h.post('/api/onboarding/save', Object.assign({}, body, { completedAt: null, currentStep: 2 }), { cookie: d.cookie });
    const done = await h.post('/api/onboarding/complete', body, { cookie: d.cookie });
    const state = await h.get('/api/state', { cookie: d.cookie });
    return {
      d,
      replies: normalise({ save: [save.status, save.json], done: [done.status, done.json], state: [state.status, state.json] }, d),
      stored: stored(d),
      requests: requestLog(d)
    };
  }

  [['GB', '7654321'], ['IE', '12345'], ['NZ', '54321']].forEach(([country, number]) => {
    it(country + ': same replies, same stored rows, same database requests', async () => {
      const off = await run(country, number, false);
      const on = await run(country, number, true);
      expect(on.replies).toEqual(off.replies);
      expect(on.stored).toEqual(off.stored);
      // Changed deliberately by FB-1 (walk-findings D12): with the switch on,
      // finishing this wizard first asks what pathway the SERVER has on record
      // for the doctor (a doctor staff recorded as Australian must not be able
      // to complete it). That is one read of the pathway columns, in a query
      // of its own, and for a doctor with nothing recorded it changes nothing:
      // every other request, and everything stored and replied, is identical.
      const PATHWAY_READ = 'GET user_profiles ?select=candidate_pathway,candidate_basis,pathway_set_by,pathway_set_at,pathway_confirmed_at,pathway_confirmed_by&user_id=eq.<user>&limit=1 null';
      expect(off.requests.filter((r) => r === PATHWAY_READ)).toHaveLength(0);
      expect(on.requests.filter((r) => r === PATHWAY_READ)).toHaveLength(1);
      // Changed deliberately by WP-17 (N04): the first save that carries the
      // doctor's answer to the first question asks once whether a welcome
      // was held for them (one small read of the nudge ledger, a table that
      // already exists). Nothing was held here, so nothing else changes.
      // FR-3 (R3-01), deliberate: still ONE read, now asking two things at
      // once (is a welcome held? has the neutral welcome already gone?).
      const HOLD_READ = 'GET gp_nudge_log ?select=nudge_key,channel&user_id=eq.<user>&nudge_key=in.(au_welcome_hold,au_n04_neutral_welcome,au_n04_welcome,au_welcome_after_neutral,au_welcome_released,au_onb_unknown_pending,au_onb_unknown_parked)&limit=12 null';   // FR-4: the same one read also sees the reminder memos
      expect(off.requests.filter((r) => r === HOLD_READ)).toHaveLength(0);
      expect(on.requests.filter((r) => r === HOLD_READ)).toHaveLength(1);
      expect(on.requests.filter((r) => r !== PATHWAY_READ && r !== HOLD_READ)).toEqual(off.requests);
      // And it is today's result: no pathway, no credentials, no marker, country as before.
      expect(on.stored.profile.candidate_pathway).toBeNull();
      expect(on.stored.profile.qualification_country).toBe(country);
      expect(on.stored.profile.registration_country).toBe('');
      expect(on.stored.profile.target_arrival_date).toBe('2027-08-01');
      expect(on.stored.credentials).toBeNull();
      expect(MARKER in on.stored.state.state).toBe(false);
      expect(Object.keys(on.replies.done[1]).sort()).toEqual(['message', 'ok', 'pepGated', 'registerVerification']);
      // (FB-1: apart from that one read, nothing names a pathway or credentials.)
      expect(on.requests.filter((r) => r !== PATHWAY_READ).join('\n')).not.toMatch(/candidate_pathway|gp_credentials|gp_au_branch/);
      expect(on.requests.filter((r) => r === PATHWAY_READ).every((r) => r.indexOf('GET ') === 0)).toBe(true);
    });
  });
});

describe('resume, and the "started the Australian branch" marker (COM-07)', () => {
  it('a save with the answer "yes" stamps the marker; the blob comes back for resume; the marker never reaches the browser', async () => {
    const d = fresh();
    loadDb([d]);
    const partial = auBody({ step: 2, registrationType: '', fellowship: '', detailsConfirmed: false });
    partial.currentStep = 0;
    const save = await h.post('/api/onboarding/save', partial, { cookie: d.cookie });
    expect(save.json).toEqual({ ok: true });
    const s = row('user_state', d.userId).state;
    expect(typeof s[MARKER]).toBe('string');
    const first = s[MARKER];
    // No pathway yet: the doctor has not finished.
    expect(row('user_profiles', d.userId).candidate_pathway).toBeNull();

    const state = await h.get('/api/state', { cookie: d.cookie });
    expect(state.status).toBe(200);
    expect(state.json.state.gp_onboarding).toMatchObject({ auBranch: 'yes', au: { step: 2, ahpraNumber: 'med 0001234567', locations: ['Regional NSW', 'Sydney', 'Newcastle'] } });
    expect(JSON.stringify(state.json)).not.toContain(MARKER);

    // A later save keeps the first stamp.
    await h.post('/api/onboarding/save', auBody({ step: 3 }), { cookie: d.cookie });
    expect(row('user_state', d.userId).state[MARKER]).toBe(first);
  });

  it('a browser cannot write the marker through /api/state', async () => {
    const d = fresh();
    loadDb([d]);
    await h.put('/api/state', { state: { [MARKER]: '2026-01-01T00:00:00.000Z', gp_selected_country: 'United Kingdom' } }, { cookie: d.cookie });
    const s = row('user_state', d.userId).state;
    expect(MARKER in s).toBe(false);
  });

  it('changing the answer to "no" removes the marker; with the switch off none is ever stamped', async () => {
    const d = fresh();
    loadDb([d]);
    await h.post('/api/onboarding/save', auBody({ step: 1 }), { cookie: d.cookie });
    expect(row('user_state', d.userId).state[MARKER]).toBeTruthy();
    const overseas = overseasBody('GB', '');
    overseas.completedAt = null;
    await h.post('/api/onboarding/save', overseas, { cookie: d.cookie });
    expect(MARKER in row('user_state', d.userId).state).toBe(false);

    h.setSwitch(false);
    await h.post('/api/onboarding/save', auBody({ step: 1 }), { cookie: d.cookie });
    expect(MARKER in row('user_state', d.userId).state).toBe(false);
  });

  it('finishing the existing (overseas) flow clears a marker left by an earlier "yes"', async () => {
    const d = fresh({ state: { [MARKER]: '2026-11-19T00:00:00.000Z' } });
    loadDb([d]);
    const res = await h.post('/api/onboarding/complete', overseasBody('GB', '7654321'), { cookie: d.cookie });
    expect(res.status).toBe(200);
    expect(MARKER in row('user_state', d.userId).state).toBe(false);
    expect(row('user_profiles', d.userId).candidate_pathway).toBeNull();
  });

  it('the sweep index treats a part-way doctor as Australian (and only with the switch on)', async () => {
    const started = fresh({ state: { [MARKER]: '2026-11-20T01:00:00.000Z', gp_onboarding: { auBranch: 'yes', au: { step: 1 } } } });
    const overseasMidway = fresh({ state: { gp_onboarding: { country: 'GB', currentStep: 2 } } });
    const untouched = fresh();
    loadDb([started, overseasMidway, untouched]);
    const idx = await t.auSweepPathwayIndex('test-job');
    expect(idx.unreadable).toBe(false);
    expect(idx.excludesUser(started.userId)).toBe(true);
    expect(idx.reasonForUser(started.userId)).toBe('au_pathway');
    expect(idx.excludesUser(overseasMidway.userId)).toBe(false);
    expect(idx.excludesUser(untouched.userId)).toBe(false);
    expect(idx.size).toBe(1);

    h.setSwitch(false);
    h.emu.reset();
    const off = await t.auSweepPathwayIndex('test-job');
    expect(off.excludesUser(started.userId)).toBe(false);
    expect(h.emu.requests).toEqual([]);
  });

  it('a stub that ignores the marker filter cannot turn every doctor Australian', async () => {
    const a = fresh({ state: { gp_onboarding: { country: 'GB' } } });
    const b = fresh({ state: { [MARKER]: '2026-11-20T01:00:00.000Z' } });
    loadDb([a, b]);
    // Hand the index rows shaped the way a filter-blind stub would: whole state objects.
    const realTable = h.emu.table('user_state');
    const rowsBefore = realTable.map((r) => JSON.parse(JSON.stringify(r)));
    const idx = await t.auSweepPathwayIndex('test-job');
    expect(idx.isAuUser(a.userId)).toBe(false);
    expect(idx.isAuUser(b.userId)).toBe(true);
    expect(realTable).toEqual(rowsBefore);
  });

  it('the hourly onboarding reminder leaves a part-way Australian doctor alone and still reaches an overseas one', async () => {
    const longAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    const started = fresh({ state: { [MARKER]: longAgo, gp_onboarding: { auBranch: 'yes', currentStep: 0, au: { step: 1 } } } });
    const overseasMidway = fresh({ state: { gp_onboarding: { country: 'GB', currentStep: 2 } } });
    [started, overseasMidway].forEach((d) => { d.state.updated_at = longAgo; d.profile.created_at = longAgo; d.profile.updated_at = longAgo; });
    loadDb([started, overseasMidway]);
    const res = await h.get('/api/cron/onboarding-nudge', { headers: { Authorization: 'Bearer test-cron-secret' } });
    expect(res.status).toBe(200);
    const reminded = h.emu.table('onboarding_reminders').map((r) => r.user_id);
    expect(reminded).toContain(overseasMidway.userId);
    // Changed deliberately by WP-17 (N05): a part-way Australian doctor now
    // gets reminders of their own (Australian words and step labels,
    // tests/au-wp17-welcome-onboarding-server.test.js), through the same
    // reminder row. First sight only starts the row: nothing is sent yet.
    expect(reminded).toContain(started.userId);
    expect(resendCalls).toEqual([]);
  });
});

describe('release from the eligibility waitlist (WEB-01, COM-07)', () => {
  const waitlisted = () => fresh({ state: { gp_eligibility_waitlist: JSON.stringify({ country: 'Australia', email: 'kept-out-of-reports', at: '2026-11-01T00:00:00.000Z' }), gp_onboarding: { attemptedCountry: 'Australia', currentStep: 2 } } });

  it('the CEO releases a waitlisted doctor: the marker is cleared, nothing else changes, and it is audited', async () => {
    const d = waitlisted();
    loadDb([d]);
    const res = await h.post('/api/admin/eligibility-waitlist/release', { user_id: d.userId }, h.superAdmin());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, user_id: d.userId, was_waitlisted: true, released: true, invite: null });
    const s = row('user_state', d.userId).state;
    expect('gp_eligibility_waitlist' in s).toBe(false);
    expect(s.gp_onboarding).toEqual({ attemptedCountry: 'Australia', currentStep: 2 });   // wizard blob untouched
    expect(s.gp_onboarding_complete).toBeUndefined();
    expect(MARKER in s).toBe(false);                    // they re-enter at the first question: no answer assumed
    const p = row('user_profiles', d.userId);
    expect(p.candidate_pathway).toBeNull();             // release sets no pathway
    expect(p.onboarding_completed_at).toBeNull();
    expect(resendCalls).toEqual([]);                    // no invite unless asked
    const audit = h.emu.table('admin_audit_log').filter((r) => r.action === 'admin_release_eligibility_waitlist');
    expect(audit.length).toBe(1);

    // Released doctors are back in the onboarding list the reminders use
    // (WP-01 left waitlisted doctors out of it).
    const list = await t.enumerateIncompleteOnboardingGps({ excludeEligibilityWaitlisted: true });
    expect(list.map((g) => g.userId)).toContain(d.userId);

    // Idempotent.
    const again = await h.post('/api/admin/eligibility-waitlist/release', { user_id: d.userId }, h.superAdmin());
    expect(again.json).toMatchObject({ ok: true, was_waitlisted: false, released: false });
  });

  it('by email, as a consultant, with the invite: one email, Australian wording, through the normal sender', async () => {
    const d = waitlisted();
    loadDb([d]);
    process.env.RESEND_API_KEY = 'test-key';
    const res = await h.post('/api/admin/eligibility-waitlist/release', { email: d.email.toUpperCase(), send_invite: true }, h.consultant());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, user_id: d.userId, released: true, invite: { sent: true } });
    expect(resendCalls.length).toBe(1);
    const mail = resendCalls[0].body;
    expect([].concat(mail.to)).toEqual([d.email]);
    expect(mail.subject).toBe('You can now complete your GP Link profile');
    expect(mail.html).toContain('/pages/onboarding?au=1');
    expect(mail.html).toContain('already registered in Australia');
    expect(mail.html).toContain('Good news, Test');
    expect(mail.html).not.toMatch(/overseas|visa|relocat|GMC|MyIntealth|not yet eligible/i);
  });

  it('who may call it, and what it refuses', async () => {
    const d = waitlisted();
    const done = fresh({ state: { gp_onboarding_complete: true, gp_eligibility_waitlist: 'x' } });
    loadDb([d, done]);
    expect((await h.post('/api/admin/eligibility-waitlist/release', { user_id: d.userId })).status).toBe(401);
    expect((await h.post('/api/admin/eligibility-waitlist/release', { user_id: d.userId }, { cookie: d.cookie })).status).toBe(401);
    const rso = await h.post('/api/admin/eligibility-waitlist/release', { user_id: d.userId }, h.rso());
    expect(rso.status).toBe(403);
    expect(row('user_state', d.userId).state.gp_eligibility_waitlist).toBeTruthy();

    const sa = h.superAdmin();
    expect((await h.post('/api/admin/eligibility-waitlist/release', {}, sa)).status).toBe(400);
    expect((await h.post('/api/admin/eligibility-waitlist/release', { user_id: '00000000-0000-4000-8000-00000000dead' }, sa)).status).toBe(404);
    const finished = await h.post('/api/admin/eligibility-waitlist/release', { user_id: done.userId, send_invite: true }, sa);
    expect(finished.status).toBe(409);
    expect(finished.json.code).toBe('onboarding_complete');
    expect(row('user_state', done.userId).state.gp_eligibility_waitlist).toBe('x');
    expect(resendCalls).toEqual([]);
  });

  it('after release the doctor can finish the Australian branch', async () => {
    const d = waitlisted();
    loadDb([d]);
    await t.releaseEligibilityWaitlistForAu({ userId: d.userId });
    const res = await h.post('/api/onboarding/complete', auBody(), { cookie: d.cookie });
    expect(res.status).toBe(200);
    expect(row('user_profiles', d.userId).candidate_pathway).toBe('au_vr');
    expect('gp_eligibility_waitlist' in row('user_state', d.userId).state).toBe(false);
  });
});

describe('the WP-06 hook', () => {
  it('onAuOnboardingCompleted reports whether a person needs to look, and never throws', async () => {
    expect(await t.onAuOnboardingCompleted('u', { pathway: 'au_restricted', needsStaffReview: true, launched: false })).toEqual({ handled: false, needsStaffReview: true });
    expect(await t.onAuOnboardingCompleted('u', { pathway: 'au_vr', needsStaffReview: false, launched: true })).toEqual({ handled: false, needsStaffReview: false });
    expect(await t.onAuOnboardingCompleted(null, null)).toEqual({ handled: false, needsStaffReview: false });
  });
});

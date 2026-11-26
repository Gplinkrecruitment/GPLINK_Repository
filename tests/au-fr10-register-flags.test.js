// Australian GP build, FR-10 (review round 13, R13-02 and S13-01): a register lookup that finds an
// undertaking, reprimand, notation or unusual condition ('register_flags') means priority areas at
// most and NO introduction to any practice until a person saves the Ahpra check, whatever the 19AB
// source; and it withdraws an earlier AUTOMATIC "verified" exactly as the four hard holds do (a
// person's verification is never touched). S13-01: the staff sentence for a stored lookup that
// cannot be read, when staff said 19AB does not apply.
// The pure matrix and the server walk both fail on the code before FR-10. Fixture provider only.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const sorting = require('../lib/au-work-sorting.js');
const re = require('../lib/role-eligibility.js');
const ci = require('../lib/career-intro.js');
const cp = require('../lib/candidate-pathway.js');
const L = require('../lib/ahpra-register-lookup.js');
const FX = require('../lib/ahpra-register-fixtures.js');

const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const STAFF = 'staff.test@gplink-test.local';
const AUTO = 'automatic register lookup (fixture)';
const AU_GRAD = ['Fellowship of the Royal Australian College of General Practitioners, Royal Australian College of General Practitioners, Australia, 2016',
  'Bachelor of Medicine / Bachelor of Surgery, University of Sydney, Australia, 2010'];
const gpType = (o) => Object.assign({ word: 'Specialist', specialty: 'General practice', expiry: '30/09/2027', conditions: null, endorsements: null, notations: null, requirements: null }, o || {});
function lookupRecord(spec) {
  const html = FX.detailsPageHtml('MED0009990001', Object.assign({ name: 'Dr A B', firstRegistration: '15/01/2011', types: [gpType()], qualifications: AU_GRAD }, spec), 'Dr A B');
  const r = L.parseRegistrationDetailsHtml(html, 'MED0009990001');
  if (!r.ok) throw new Error('fixture did not parse: ' + r.reason);
  return { v: 1, ok: true, found: true, nameMatch: true, number: 'MED0009990001', provider: 'fixture', at: NOW, facts: r.facts };
}
const FLAGS = {
  reprimand: { reprimands: 'Reprimand issued on 1 February 2024.' },
  undertaking: { undertakings: 'The practitioner has undertaken not to perform procedures under sedation.' },
  notation: { types: [gpType({ notations: 'Endorsed for acupuncture (FAKE notation).' })] },
  'unusual condition': { types: [gpType({ conditions: 'On 3 March 2026, the Medical Board of Australia (the Board) imposed conditions.\n\n1. Restriction on prescribing\n1.1 The practitioner must not prescribe, supply or administer any Schedule 8 medicine.' })] }
};
const NINETEEN_AB = {
  'staff no': { moratorium_19ab_status: 'no', moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW },
  'staff yes': { moratorium_19ab_status: 'no', moratorium_19ab_confirmed_status: 'yes', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW },
  doctor: { moratorium_19ab_status: 'no' },
  none: { moratorium_19ab_status: null }
};
const PREVIOUS = {
  // auto-verified earlier; the later lookup's hold was written on the row (as auRunRegisterLookup does)
  automatic: { staff_verified_at: NOW, staff_verified_by: AUTO, ahpra_last_checked_by: AUTO + sorting.lookupHoldMark('register_flags') },
  // a person verified; a person's check is never withdrawn and the lookup writes no hold over it
  person: { staff_verified_at: NOW, staff_verified_by: STAFF, ahpra_last_checked_by: STAFF, ahpra_last_checked_at: NOW }
};
const VR_CRED = { ahpra_number: 'MED0009990001', ahpra_registration_type: 'specialist', specialist_gp: true, fellowship_type: 'fracgp', vr_status: 'vr', has_conditions: false, has_undertakings: false, has_notations: false, work_rights: 'citizen' };
const METRO_ROLE = { id: 'm', dpa: false, dpa_status: 'no', vr_requirement: 'vr_required' };
const DPA_ROLE = { id: 'd', dpa: true, dpa_status: 'yes', vr_requirement: 'vr_preferred' };

function resolved(flag, ab, prev) {
  const credentials = Object.assign({}, VR_CRED, NINETEEN_AB[ab], PREVIOUS[prev]);
  const profile = { user_id: 'u-1', candidate_pathway: 'au_vr', pathway_set_by: 'self', pathway_confirmed_at: null, register_status: 'verified', register_body: 'ahpra', register_number: 'MED0009990001' };
  const p = cp.resolvePathwayFromRecords({ profile, credentials, lookup: lookupRecord(FLAGS[flag]), now: TODAY, flagEnabled: true });
  return { p, credentials, profile };
}

describe('R13-02, the rule: register_flags × 19AB source × previous verification', () => {
  Object.keys(FLAGS).forEach((flag) => {
    Object.keys(NINETEEN_AB).forEach((ab) => {
      it(flag + ', 19AB ' + ab + ', earlier AUTOMATIC verification: priority areas at most, no practice at all, never "verified" to a practice', () => {
        const { p, credentials, profile } = resolved(flag, ab, 'automatic');
        expect(p.sorting.group).toBe('dpa_only');
        expect(p.sorting.dpaOnly).toBe(true);
        expect(p.sorting.registerFlagHold).toBe(true);
        expect(p.sorting.needsPerson).toBe(true);
        expect(p.sorting.dpaSentence).toMatch(/no introduction to any practice, until a person checks the register and saves the Ahpra check/);
        expect(p.sorting.dpaSentence).not.toMatch(/Staff confirmed the 19AB moratorium applies/);
        for (const role of [METRO_ROLE, DPA_ROLE]) {
          const b = re.auIntroductionBlock(p, role, { registerVerified: true });
          expect(b && b.code).toBe('register_flags_need_person');
          expect(b.message).toMatch(/Nothing was sent/);
          expect(re.auApplicationLocationFlag(p, role)).toMatchObject({ code: 'register_flags_need_person', restricted: true });
        }
        const facts = ci.auIntroFactsFromRecords({ pathwayResult: p, credentials, profile, now: NOW });
        const intro = ci.buildAuCandidateIntro({ gpName: 'Dr Test Flag', facts });
        expect(intro.paragraph).not.toMatch(/has verified/);
        expect(JSON.stringify(intro.facts)).not.toMatch(/registration verified/);
      });
      it(flag + ', 19AB ' + ab + ', earlier verification by a PERSON: the person\'s check stands (as for the four hard holds)', () => {
        const { p } = resolved(flag, ab, 'person');
        expect(p.sorting.registerFlagHold).toBe(false);
        expect(p.sorting.checkedBy).toBe('person');
        const expectedGroup = ab === 'staff no' || ab === 'doctor' ? 'anywhere' : 'dpa_only';
        expect(p.sorting.group).toBe(expectedGroup);
        const metro = re.auIntroductionBlock(p, METRO_ROLE, { registerVerified: true });
        if (ab === 'staff no') expect(metro).toBe(null);
        else expect(metro && metro.code).not.toBe('register_flags_need_person');
        expect(re.auIntroductionBlock(p, DPA_ROLE, { registerVerified: true })).toBe(null);
      });
    });
  });
  it('a lookup with nothing to flag, staff 19AB "no", automatic verification: still "anywhere" and introducible (unchanged)', () => {
    const credentials = Object.assign({}, VR_CRED, NINETEEN_AB['staff no'], { staff_verified_at: NOW, staff_verified_by: AUTO, ahpra_last_checked_by: AUTO });
    const profile = { user_id: 'u-1', candidate_pathway: 'au_vr', pathway_set_by: 'self', register_status: 'verified', register_body: 'ahpra' };
    const p = cp.resolvePathwayFromRecords({ profile, credentials, lookup: lookupRecord({}), now: TODAY, flagEnabled: true });
    expect(p.sorting.group).toBe('anywhere');
    expect(p.sorting.registerFlagHold).toBe(false);
    expect(re.auIntroductionBlock(p, METRO_ROLE, { registerVerified: true })).toBe(null);
  });
  it('THIS lookup shows the flag (no hold written yet): the same, with staff 19AB "no"', () => {
    const out = sorting.sortDoctorByWhereTheyCanWork(sorting.sortingInputsFromRecords({
      pathway: 'au_vr', credentials: Object.assign({}, VR_CRED, NINETEEN_AB['staff no'], { staff_verified_at: NOW, staff_verified_by: AUTO }), lookup: lookupRecord(FLAGS.reprimand)
    }));
    expect(out.group).toBe('dpa_only');
    expect(out.registerFlagHold).toBe(true);
    expect(sorting.staffSortingView(out).register_flag_hold).toBe(true);
  });
});

describe('S13-01: the staff sentence when the stored lookup cannot be read and staff said 19AB does not apply', () => {
  it('says the record could not be read, never "Staff confirmed the 19AB moratorium applies"', () => {
    const out = sorting.sortDoctorByWhereTheyCanWork({ registerFacts: { unreadable: true }, doctorAnswers: { vr: true, moratorium19ab: 'no', workRights: 'citizen' }, staffConfirmed: { moratorium19ab: 'no', moratoriumBy: STAFF }, now: TODAY });
    expect(out.group).toBe('dpa_only');
    expect(out.dpaSentence).toBe('The register record could not be read just now: shown priority-area roles until it can be.');
    const p = { isAu: true, credentialsRead: true, staff19ab: 'not_applicable', sorting: out };
    const b = re.auIntroductionBlock(p, METRO_ROLE, { registerVerified: true });
    expect(b.code).toBe('location_restricted_role_not_dpa');
    expect(b.message).toMatch(/could not be read just now/);
    expect(b.message).not.toMatch(/Staff confirmed the 19AB moratorium applies/);
    const f = re.auApplicationLocationFlag(p, METRO_ROLE);
    expect(f.staff).toMatch(/could not be read just now/);
    expect(f.staff).toMatch(/until the register record can be read/);
    expect(f.staff).not.toMatch(/applies\./);
  });
  it('staff "19AB applies" still says so (unchanged), unreadable or not', () => {
    const out = sorting.sortDoctorByWhereTheyCanWork({ registerFacts: { unreadable: true }, doctorAnswers: { vr: true, moratorium19ab: 'no', workRights: 'citizen' }, staffConfirmed: { moratorium19ab: 'yes' }, now: TODAY });
    expect(out.dpaSentence).toBe('Staff confirmed the 19AB moratorium applies.');
  });
  it('no staff answer, unreadable: the reason is the unreadable record', () => {
    const out = sorting.sortDoctorByWhereTheyCanWork({ registerFacts: { unreadable: true }, doctorAnswers: { vr: true, moratorium19ab: 'no', workRights: 'citizen' }, staffConfirmed: {}, now: TODAY });
    expect(out.dpaSentence).toBe('The register record could not be read just now: shown priority-area roles until it can be.');
  });
});

// ── through the real server (the reviewer's reproduction) ───────────────────
const EMPTY_TABLES = ['registration_tasks', 'task_timeline', 'gp_applications', 'placements', 'user_documents',
  'admin_audit_log', 'candidate_leads', 'runtime_kv', 'rate_limits', 'gp_nudge_log', 'user_roles', 'career_interviews',
  'scheduled_calls', 'career_suburb_geo_cache', 'ats_stage_events', 'ats_offers', 'match_cache', 'career_contracts', 'onboarding_reminders', 'pep_waitlist'];
const ROLE_BASE = { provider: 'internal_ats', is_active: true, approval_status: 'approved', job_status: 'open', ats_created: true, updated_at: NOW, published_at: NOW, location_country: 'Australia', tags: [] };
const seedRoles = () => [
  Object.assign({}, ROLE_BASE, {
    id: 'role-metro', provider_role_id: 'ats_fr10_metro', title: 'GP (FAKE metro)', masked_title: 'Non-DPA - Parramatta - Mixed Billing',
    practice_name: 'FR10 Metro Practice (FAKE)', practice_id: 'p-metro', suburb: 'Parramatta', location_city: 'Parramatta', location_state: 'NSW', nearest_city: 'Sydney',
    billing_model: 'mixed', mixed_billing: true, dpa: false, dpa_status: 'no', mmm: 'MM1', metro: true, visa_pathway_aligned: false,
    vr_requirement: 'vr_required', accepts_registrars: false, accepts_supervised: false
  }),
  Object.assign({}, ROLE_BASE, {
    id: 'role-dpa', provider_role_id: 'ats_fr10_dpa', title: 'GP (FAKE regional DPA)', masked_title: 'DPA - Dubbo - Bulk Billing',
    practice_name: 'FR10 Regional Practice (FAKE)', practice_id: 'p-dubbo', suburb: 'Dubbo', location_city: 'Dubbo', location_state: 'NSW', nearest_city: 'Dubbo',
    billing_model: 'bulk', dpa: true, dpa_status: 'yes', mmm: 'MM3', regional: true, visa_pathway_aligned: true,
    vr_requirement: 'vr_preferred', accepts_registrars: false, accepts_supervised: false
  })
];
const PRACTICES = [
  { id: 'p-metro', name: 'FR10 Metro Practice (FAKE)', latitude: -33.815, longitude: 151.0011, location_state: 'NSW', suburb: 'Parramatta', metadata: {}, is_active: true, contact_email: 'metro.fr10@gplink-test.local', contact_name: 'Metro Manager (FAKE)' },
  { id: 'p-dubbo', name: 'FR10 Regional Practice (FAKE)', latitude: -32.2569, longitude: 148.6011, location_state: 'NSW', suburb: 'Dubbo', metadata: {}, is_active: true, contact_email: 'dubbo.fr10@gplink-test.local', contact_name: 'Dubbo Manager (FAKE)' }
];
const METRO = 'internal_ats:ats_fr10_metro';
const DPA = 'internal_ats:ats_fr10_dpa';
let h, t;
let seq = 0;
const rows = (table) => h.emu.table(table);
const row = (table, userId) => rows(table).filter((r) => r.user_id === userId)[0] || null;
const cred = (d) => row('gp_credentials', d.userId);
const profile = (d) => row('user_profiles', d.userId);
const caseOf = (d) => row('registration_cases', d.userId);
const openTasks = (d, type) => rows('registration_tasks').filter((x) => caseOf(d) && x.case_id === caseOf(d).id && x.task_type === type && x.status !== 'completed' && x.status !== 'cancelled');
function add(kind, overrides) {
  seq += 1;
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: 'f10r' + seq }, overrides || {}));
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
  rows('user_documents').push({ id: 'cv-' + d.userId, user_id: d.userId, document_key: 'career_cv', status: 'uploaded', file_name: 'cv.pdf', country_code: 'AU', created_at: NOW, updated_at: NOW });
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}
const selfVr = (number, credentials) => {
  const d = add('au_vr', { selfDeclared: true, credentials: Object.assign({}, VR_CRED, { ahpra_number: number, moratorium_19ab_status: 'no', staff_verified_at: null, staff_verified_by: null, ahpra_last_checked_at: null, ahpra_last_checked_by: null }, credentials || {}) });
  profile(d).register_number = number; profile(d).register_body = 'ahpra';
  return d;
};
const withFixture = async (fn) => {
  const saved = process.env.AHPRA_LOOKUP_PROVIDER;
  process.env.AHPRA_LOOKUP_PROVIDER = 'fixture';
  try { return await fn(); } finally { if (saved === undefined) delete process.env.AHPRA_LOOKUP_PROVIDER; else process.env.AHPRA_LOOKUP_PROVIDER = saved; }
};
const lookUp = (d) => h.post('/api/ats/candidate/register-lookup', { user_id: d.userId }, h.superAdmin());
const staff19 = (d, value, note) => h.post('/api/admin/candidate/pathway', Object.assign({ user_id: d.userId, moratorium_19ab_confirmed: value }, note ? { note } : {}), h.superAdmin());
const apply = (d, roleId) => h.post('/api/career/apply', { roleId, shareConsent: { agreed: true, version: require('../lib/profile-share-consent.js').CONSENT_VERSION } }, { cookie: d.cookie });
const appFor = (d, roleRowId) => rows('gp_applications').filter((a) => a.user_id === d.userId && String(a.career_role_id) === roleRowId)[0] || null;
const submit = (appId) => h.post('/api/admin/career/application/submit-to-practice', { applicationId: appId }, h.superAdmin());
const staffCandidate = (d) => h.get('/api/ceo/candidate?case_id=' + caseOf(d).id, h.superAdmin());
const crisp = (res) => (res.json.roles || []).filter((r) => r.qualifies && !r.blurred).map((r) => r.id);
const roles = (d) => h.get('/api/career/roles', { cookie: d.cookie });

beforeAll(async () => {
  const tables = { career_roles: seedRoles(), practices: PRACTICES.map((p) => Object.assign({}, p)) };
  EMPTY_TABLES.forEach((name) => { tables[name] = []; });
  ['user_profiles', 'gp_credentials', 'registration_cases', 'user_state'].forEach((name) => { tables[name] = []; });
  h = await bootAuTestServer({ name: 'fr10-flags', tables });
  t = h.testUtils;
}, 60000);
afterAll(async () => { if (h) await h.close(); });
beforeEach(() => {
  h.setSwitch(true);
  delete process.env.AHPRA_LOOKUP_PROVIDER;
  h.emu.forbid(null);
  h.emu.failTables = {};
  L._resetForTests && L._resetForTests();
});

describe('R13-02 through the server: auto-verified, staff 19AB "no", then a lookup finds a reprimand', () => {
  it('the automatic "verified" is withdrawn, Submit is refused in plain words for any role, the practice is never told "verified", staff see why; a person saving the check releases it', async () => {
    await withFixture(async () => {
      const d = selfVr('MED0009990001');
      expect((await lookUp(d)).json.auto_completed).toBe(true);
      expect(cred(d).staff_verified_by).toBe(AUTO);
      expect((await staff19(d, 'no', 'Citizen at enrolment, confirmed by phone (FAKE)')).status).toBe(200);
      expect((await apply(d, METRO)).status).toBe(200);
      expect((await apply(d, DPA)).status).toBe(200);
      // the register changes (stood in for by the number now answering with the reprimand fixture)
      cred(d).ahpra_number = 'MED0009990006'; profile(d).register_number = 'MED0009990006';
      L._resetForTests && L._resetForTests();
      const second = await lookUp(d);
      expect(second.status).toBe(200);
      expect(cred(d).ahpra_last_checked_by).toMatch(/\(lookup hold: register_flags\)$/);
      expect(cred(d).staff_verified_at).toBe(null);           // was kept before FR-10
      expect(cred(d).staff_verified_by).toBe(null);
      // staff: refused for the non-DPA role AND the DPA role, with the reason
      for (const roleRowId of ['role-metro', 'role-dpa']) {
        const sub = await submit(appFor(d, roleRowId).id);
        expect(sub.status).toBe(409);
        expect(sub.json).toMatchObject({ au_introduction_blocked: true, code: 'register_flags_need_person' });
        expect(sub.json.message).toMatch(/found something a person must look at/);
        expect(sub.json.message).toMatch(/Nothing was sent/);
      }
      expect(h.emu.table('gp_applications').filter((a) => a.user_id === d.userId && a.submitted_to_practice_at).length).toBe(0);
      // the practice text never says verified
      const intro = await t.auPracticeIntroFor(d.userId, profile(d), 'Test Doctor');
      expect(intro.intro.paragraph).not.toMatch(/has verified/);
      // the doctor sees priority-area roles at most
      expect(crisp(await roles(d))).toEqual([DPA]);
      // staff see the reason, and the check is waiting for a person
      const view = await staffCandidate(d);
      const sv = view.json.candidate.au.sorting;
      expect(sv.group).toBe('dpa_only');
      expect(sv.register_flag_hold).toBe(true);
      expect(sv.person_reasons.map((r) => r.code)).toContain('reprimands');
      expect(sv.dpa_sentence).toMatch(/until a person checks the register and saves the Ahpra check/);
      const card = view.json.candidate.apps.filter((a) => String(a.id) === String(appFor(d, 'role-dpa').id))[0];
      expect(card.au_location_flag).toMatchObject({ code: 'register_flags_need_person' });
      expect(openTasks(d, 'ahpra_register_check').length).toBe(1);
      // a person checks the register (the reprimand seen) and saves the check: released
      const saved = await h.post('/api/ats/candidate/register-verification', { userId: d.userId, action: 'ahpra_check', outcome: 'verified', ahpra_number: 'MED0009990006',
        registration_type: 'specialist', specialist_gp: true, has_conditions: false, has_undertakings: false, has_notations: false, registration_expiry: '2027-09-30',
        fellowship_type: 'fracgp', work_rights: 'citizen', supervision_level: 'none', moratorium_19ab_confirmed: 'no',
        note: 'Reprimand of 1 Feb 2024 read on the register; historical, no conditions (FAKE).' }, h.superAdmin());
      expect(saved.status).toBe(200);
      expect(cred(d).ahpra_last_checked_by).toBe(h.SUPER_EMAIL);
      expect(cred(d).staff_verified_at).toBeTruthy();
      const after = await t.auIntroductionGate({ id: 'x', user_id: d.userId }, rows('career_roles').filter((r) => r.id === 'role-metro')[0]);
      expect(after).toBe(null);
      expect(crisp(await roles(d)).sort()).toEqual([DPA, METRO].sort());
    });
  });
  it('a hold already on the row before FR-10 (automatic "verified" kept): the next lookup withdraws it', async () => {
    await withFixture(async () => {
      const d = selfVr('MED0009990006', { staff_verified_at: NOW, staff_verified_by: AUTO, ahpra_last_checked_by: AUTO + ' (lookup hold: register_flags)' });
      await lookUp(d);
      expect(cred(d).staff_verified_at).toBe(null);
      expect(cred(d).ahpra_last_checked_by).toMatch(/\(lookup hold: register_flags\)$/);
    });
  });
  it('a PERSON\'s verification is never withdrawn by a lookup that finds a reprimand', async () => {
    await withFixture(async () => {
      const d = selfVr('MED0009990006', { staff_verified_at: NOW, staff_verified_by: STAFF, ahpra_last_checked_by: STAFF });
      await lookUp(d);
      expect(cred(d).staff_verified_at).toBe(NOW);
      expect(cred(d).staff_verified_by).toBe(STAFF);
    });
  });
  it('a clean lookup for an auto-verified doctor with staff 19AB "no": still introduced outside a DPA (unchanged)', async () => {
    await withFixture(async () => {
      const d = selfVr('MED0009990001');
      expect((await lookUp(d)).json.auto_completed).toBe(true);
      expect((await staff19(d, 'no', 'Citizen at enrolment, confirmed by phone (FAKE)')).status).toBe(200);
      expect(await t.auIntroductionGate({ id: 'x', user_id: d.userId }, rows('career_roles').filter((r) => r.id === 'role-metro')[0])).toBe(null);
    });
  });
  it('an overseas doctor: the gate reads nothing more and answers null (unchanged)', async () => {
    const d = add('overseas_null', {});
    h.emu.reset();
    expect(await t.auIntroductionGate({ id: 'x', user_id: d.userId }, rows('career_roles').filter((r) => r.id === 'role-metro')[0])).toBe(null);
    expect(h.emu.requestsTo('gp_credentials').length).toBe(0);
  });
});

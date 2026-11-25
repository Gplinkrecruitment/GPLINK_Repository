// Australian GP build, WP-29, end to end against the real server and the
// in-memory database stub: who sees which roles, registrars, the practice
// introduction gate, the register lookup (fixture provider only: the real
// register is never reached from a test), and the location choice.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const re = require('../lib/role-eligibility.js');
const { bannedIn } = require('./helpers/au-banned-words.js');

const NOW = new Date().toISOString();
const STAFF = 'staff.test@gplink-test.local';
const AUTO = 'automatic register lookup (fixture)';
const EMPTY_TABLES = ['registration_tasks', 'task_timeline', 'gp_applications', 'placements', 'user_documents',
  'admin_audit_log', 'candidate_leads', 'runtime_kv', 'rate_limits', 'gp_nudge_log', 'user_roles', 'career_interviews',
  'scheduled_calls', 'career_suburb_geo_cache', 'ats_stage_events', 'ats_offers', 'match_cache', 'career_contracts', 'onboarding_reminders', 'pep_waitlist'];

const ROLE_BASE = { provider: 'internal_ats', is_active: true, approval_status: 'approved', job_status: 'open', ats_created: true, updated_at: NOW, published_at: NOW, location_country: 'Australia', tags: [] };
function seedRoles() {
  return [
    Object.assign({}, ROLE_BASE, {
      id: 'role-metro', provider_role_id: 'ats_wp29_metro', title: 'GP (FAKE metro)', masked_title: 'Non-DPA - Parramatta - Mixed Billing',
      practice_name: 'Test Metro Practice (FAKE)', practice_id: 'p-metro', suburb: 'Parramatta', location_city: 'Parramatta', location_state: 'NSW', nearest_city: 'Sydney',
      billing_model: 'mixed', mixed_billing: true, dpa: false, dpa_status: 'no', mmm: 'MM1', metro: true, visa_pathway_aligned: false,
      vr_requirement: 'vr_required', accepts_registrars: false, accepts_supervised: false
    }),
    Object.assign({}, ROLE_BASE, {
      id: 'role-unknown', provider_role_id: 'ats_wp29_unknown', title: 'GP (FAKE, DPA not sure)', masked_title: 'Newcastle - Mixed Billing',
      practice_name: 'Test Coast Practice (FAKE)', practice_id: 'p-coast', suburb: 'Newcastle', location_city: 'Newcastle', location_state: 'NSW', nearest_city: 'Newcastle',
      billing_model: 'mixed', mixed_billing: true, dpa: false, dpa_status: 'unknown', visa_pathway_aligned: false,
      vr_requirement: 'vr_required', accepts_registrars: false, accepts_supervised: false
    }),
    Object.assign({}, ROLE_BASE, {
      id: 'role-dpa', provider_role_id: 'ats_wp29_dpa', title: 'GP (FAKE regional DPA)', masked_title: 'DPA - Dubbo - Bulk Billing',
      practice_name: 'Test Regional Practice (FAKE)', practice_id: 'p-dubbo', suburb: 'Dubbo', location_city: 'Dubbo', location_state: 'NSW', nearest_city: 'Dubbo',
      billing_model: 'bulk', dpa: true, dpa_status: 'yes', mmm: 'MM3', regional: true, visa_pathway_aligned: true,
      vr_requirement: 'vr_preferred', accepts_registrars: false, accepts_supervised: false
    })
  ];
}
// The coast practice has the live product's bug on purpose: a hand-typed address stored as 0,0.
const PRACTICES = [
  { id: 'p-metro', name: 'Test Metro Practice (FAKE)', latitude: -33.815, longitude: 151.0011, location_state: 'NSW', suburb: 'Parramatta', metadata: {}, is_active: true, contact_email: 'metro.practice@gplink-test.local', contact_name: 'Metro Manager (FAKE)' },
  { id: 'p-coast', name: 'Test Coast Practice (FAKE)', latitude: 0, longitude: 0, location_state: 'NSW', suburb: 'Newcastle', metadata: {}, is_active: true, contact_email: 'coast.practice@gplink-test.local', contact_name: 'Coast Manager (FAKE)' },
  { id: 'p-dubbo', name: 'Test Regional Practice (FAKE)', latitude: -32.2569, longitude: 148.6011, location_state: 'NSW', suburb: 'Dubbo', metadata: {}, is_active: true, contact_email: 'dubbo.practice@gplink-test.local', contact_name: 'Dubbo Manager (FAKE)' }
];
const METRO = 'internal_ats:ats_wp29_metro';
const UNKNOWN = 'internal_ats:ats_wp29_unknown';
const DPA = 'internal_ats:ats_wp29_dpa';

let h, t;
let seq = 0;
const rows = (table) => h.emu.table(table);
const row = (table, userId) => rows(table).filter((r) => r.user_id === userId)[0] || null;
const cred = (d) => row('gp_credentials', d.userId);
const profile = (d) => row('user_profiles', d.userId);
const caseOf = (d) => row('registration_cases', d.userId);
const tasks = (d, type) => rows('registration_tasks').filter((x) => caseOf(d) && x.case_id === caseOf(d).id && x.task_type === type);
const openTasks = (d, type) => tasks(d, type).filter((x) => x.status !== 'completed' && x.status !== 'cancelled');
const timeline = (d) => rows('task_timeline').filter((x) => caseOf(d) && x.case_id === caseOf(d).id);
const kv = (key) => { const r = rows('runtime_kv').filter((x) => x.key === key)[0]; return r ? r.value : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + (ms || 3000); while (Date.now() < end) { if (await fn()) return true; await sleep(25); } return false; }

const SELF_NO = { moratorium_19ab_status: 'no', moratorium_19ab_confirmed_status: null, moratorium_19ab_confirmed_by: null, moratorium_19ab_confirmed_at: null };
const SELF_UNSURE = Object.assign({}, SELF_NO, { moratorium_19ab_status: 'unsure' });
const SELF_YES = Object.assign({}, SELF_NO, { moratorium_19ab_status: 'yes' });
const UNVERIFIED = { staff_verified_at: null, staff_verified_by: null, ahpra_last_checked_at: null, ahpra_last_checked_by: null };
const VR_FACTS = { ahpra_registration_type: 'specialist', specialist_gp: true, fellowship_type: 'fracgp', vr_status: 'vr', has_conditions: false, has_undertakings: false, has_notations: false, work_rights: 'citizen' };

function add(kind, overrides) {
  seq += 1;
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: 'x' + seq }, overrides || {}));
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
  rows('user_documents').push({ id: 'cv-' + d.userId, user_id: d.userId, document_key: 'career_cv', status: 'uploaded', file_name: 'cv.pdf', country_code: 'AU', created_at: NOW, updated_at: NOW });
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}
// A self-declared Australian doctor whose check nobody has done yet.
const selfVr = (credentials, extra) => add('au_vr', Object.assign({ selfDeclared: true, credentials: Object.assign({}, VR_FACTS, UNVERIFIED, credentials || {}) }, extra || {}));
const selfB = (credentials, extra) => add('au_restricted', Object.assign({ selfDeclared: true, credentials: Object.assign({}, VR_FACTS, UNVERIFIED, credentials || {}) }, extra || {}));

const roles = (d) => h.get('/api/career/roles', { cookie: d.cookie });
const WP09_AGREED = { agreed: true, version: require('../lib/profile-share-consent.js').CONSENT_VERSION };
const apply = (d, roleId) => h.post('/api/career/apply', /^au_/.test(d.kind) ? { roleId, shareConsent: WP09_AGREED } : { roleId }, { cookie: d.cookie });
const submit = (appId) => h.post('/api/admin/career/application/submit-to-practice', { applicationId: appId }, h.superAdmin());
const appFor = (d, roleRowId) => rows('gp_applications').filter((a) => a.user_id === d.userId && String(a.career_role_id) === roleRowId)[0] || null;
const staffCandidate = (d) => h.get('/api/ceo/candidate?case_id=' + caseOf(d).id, h.superAdmin());
const crisp = (res) => (res.json.roles || []).filter((r) => r.qualifies && !r.blurred).map((r) => r.id);
const blurred = (res) => (res.json.roles || []).filter((r) => r.blurred).length;
const withProvider = async (name, fn) => {
  const saved = process.env.AHPRA_LOOKUP_PROVIDER;
  if (name) process.env.AHPRA_LOOKUP_PROVIDER = name; else delete process.env.AHPRA_LOOKUP_PROVIDER;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.AHPRA_LOOKUP_PROVIDER; else process.env.AHPRA_LOOKUP_PROVIDER = saved; }
};
const lookupKey = (d) => 'au_register_lookup:' + d.userId;

beforeAll(async () => {
  const tables = { career_roles: seedRoles(), practices: PRACTICES.map((p) => Object.assign({}, p)) };
  EMPTY_TABLES.forEach((name) => { tables[name] = []; });
  ['user_profiles', 'gp_credentials', 'registration_cases', 'user_state'].forEach((name) => { tables[name] = []; });
  h = await bootAuTestServer({ name: 'wp29', tables });
  t = h.testUtils;
}, 60000);
afterAll(async () => { if (h) await h.close(); });
beforeEach(() => {
  h.setSwitch(true);
  delete process.env.AHPRA_LOOKUP_PROVIDER;
  h.emu.forbid(null);
  h.emu.missingColumns = {};
  h.emu.failTables = {};
  rows('career_roles').length = 0;
  seedRoles().forEach((r) => rows('career_roles').push(r));
});

describe('A1: the doctor\'s own first answer decides what THEY see (staff still win)', () => {
  it('"19AB does not apply", not yet confirmed by anyone: every role, at once, none blurred', async () => {
    const d = selfVr(SELF_NO);
    const res = await roles(d);
    expect(res.status).toBe(200);
    expect(crisp(res).sort()).toEqual([DPA, METRO, UNKNOWN].sort());
    expect(blurred(res)).toBe(0);
    expect(res.json.auAreaLimited).toBeUndefined();
    expect(res.json.auHold).toBeUndefined();
    expect((await apply(d, METRO)).status).toBe(200);
  });
  it('"not sure", "applies" and no answer: DPA roles only; a role whose DPA status is unknown is not offered; one honest line', async () => {
    for (const c of [SELF_UNSURE, SELF_YES, Object.assign({}, SELF_NO, { moratorium_19ab_status: null })]) {
      const d = selfVr(c);
      const res = await roles(d);
      expect(crisp(res), JSON.stringify(c.moratorium_19ab_status)).toEqual([DPA]);
      expect(blurred(res)).toBe(2);
      expect(res.json.auAreaLimited).toBe(true);
      const refused = await apply(d, UNKNOWN);
      expect(refused.status).toBe(403);
      expect((await apply(d, METRO)).status).toBe(403);
    }
  });
  it('a staff answer wins both ways: "applies" shrinks a doctor who said no; "does not apply" opens one who said yes', async () => {
    const shrunk = selfVr(Object.assign({}, SELF_NO, { moratorium_19ab_confirmed_status: 'yes', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW }));
    expect(crisp(await roles(shrunk))).toEqual([DPA]);
    const opened = selfVr(Object.assign({}, SELF_YES, { moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW }));
    expect(crisp(await roles(opened)).length).toBe(3);
  });
  it('a temporary resident who says "does not apply" is still limited to DPA roles, and only where the practice offers sponsorship', async () => {
    const d = selfB(Object.assign({}, SELF_NO, { work_rights: 'visa' }));
    const res = await roles(d);
    expect(res.json.auHold).toBeUndefined();            // not held just for being on a temporary right to work
    expect(crisp(res)).toEqual([DPA]);                  // the DPA practice offers sponsorship
    rows('career_roles').filter((r) => r.id === 'role-dpa')[0].visa_pathway_aligned = false;
    const none = await roles(d);
    expect(crisp(none)).toEqual([]);
    expect((await apply(d, DPA)).json.code).toBe('sponsorship_not_offered');
  });
});

describe('A2: a restricted doctor (segment B) is shown what they could work in; supervision never hides a role', () => {
  it('a VR GP who says 19AB applies: not held, the DPA role is theirs, the rest are blurred, apply works', async () => {
    const d = selfB(SELF_YES);
    const res = await roles(d);
    expect(res.json.auHold).toBeUndefined();
    expect(crisp(res)).toEqual([DPA]);
    expect(blurred(res)).toBe(2);
    expect((await apply(d, DPA)).status).toBe(200);
    expect((await apply(d, METRO)).status).toBe(403);
    const session = await h.get('/api/auth/session', { cookie: d.cookie });
    expect(session.json.auPathway.launched).toBe(false);          // the segment flag is unchanged
    expect(session.json.auDoctor.held).toBe(false);               // but they are not held
    expect(session.json.auDoctor.hold).toBe(null);
  });
  it('no role says it accepts supervised doctors, and a doctor who needs supervision still sees them (it is a staff fact, not a gate)', async () => {
    expect(rows('career_roles').every((r) => r.accepts_supervised !== true)).toBe(true);
    const d = selfB(Object.assign({}, SELF_YES, { supervision_level: 'level_2' }));
    expect(crisp(await roles(d))).toEqual([DPA]);
    const cleared = selfB(Object.assign({}, SELF_YES, { supervision_level: 'level_2', moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW }));
    expect(crisp(await roles(cleared)).length).toBe(3);
  });
  it('limited or provisional registration is not vocational registration: held exactly as a non-VR doctor is', async () => {
    const d = selfB(Object.assign({}, SELF_NO, { ahpra_registration_type: 'limited', specialist_gp: false, fellowship_type: 'none', vr_status: 'non_vr' }));
    const res = await roles(d);
    expect(res.json.roles).toEqual([]);
    expect(res.json.auHold).toEqual({ held: true, kind: 'review', title: 'Thanks, we have your details', message: re.HOLD_MESSAGE });
    expect((await apply(d, DPA)).status).toBe(403);
  });
});

describe('A3: registrars. "We place fully qualified GPs", everywhere, and staff are not asked to review them', () => {
  const REG = { held: true, kind: 'registrar', title: 'We place fully qualified GPs', message: re.REGISTRAR_HOLD_MESSAGE };
  it('the words are the agreed ones, with no promise of roles and nothing from the banned list', () => {
    expect(re.REGISTRAR_HOLD_TITLE).toBe('We place fully qualified GPs');
    expect(re.REGISTRAR_HOLD_MESSAGE).toBe("GP Link works with GPs who hold fellowship (FRACGP or FACRRM) or are otherwise fully qualified to practise independently. We can't place GP registrars at the moment. Once you have your fellowship, sign in again and update your details and we will take it from there.");
    expect(bannedIn(re.REGISTRAR_HOLD_TITLE + ' ' + re.REGISTRAR_HOLD_MESSAGE)).toEqual([]);
    expect(/roles? (will|may) open|we will find|match(es)? /i.test(re.REGISTRAR_HOLD_MESSAGE)).toBe(false);
  });
  it('no roles, the message on Careers, the role page and the session; apply refused by the API; NO segment-review task', async () => {
    const d = add('au_registrar', { selfDeclared: true });
    const list = await roles(d);
    expect(list.json.roles).toEqual([]);
    expect(list.json.auHold).toEqual(REG);
    const one = await h.get('/api/career/role?id=' + encodeURIComponent(DPA), { cookie: d.cookie });
    expect(one.json.auHold).toEqual(REG);
    expect(one.json.role.blurred).toBe(true);
    const refused = await apply(d, DPA);
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ error: 'pathway_on_hold', code: 'au_hold', auHoldKind: 'registrar', title: REG.title, message: REG.message });
    expect(rows('gp_applications').filter((a) => a.user_id === d.userId)).toEqual([]);
    const session = await h.get('/api/auth/session', { cookie: d.cookie });
    expect(session.json.auDoctor.held).toBe(true);
    expect(session.json.auDoctor.hold).toEqual({ kind: 'registrar', title: REG.title, message: REG.message });
    expect(tasks(d, 'segment_review')).toEqual([]);
    // a non-VR doctor, for contrast, is still flagged to staff exactly as before
    const nonVr = add('au_non_vr', { selfDeclared: true });
    const held = await roles(nonVr);
    expect(held.json.auHold.kind).toBe('review');
    expect(openTasks(nonVr, 'segment_review').length).toBe(1);
  });
  it('finishing sign-up as a registrar: the registrar finish screen and email, a record on the timeline, and NO staff task at all', async () => {
    const d = add('overseas_null', { noCase: true, profile: { registration_country: '', qualification_country: '', onboarding_completed_at: null, register_body: null, register_number: null, register_status: null } });
    row('user_state', d.userId).state = {};
    const res = await h.post('/api/onboarding/complete', {
      auBranch: 'yes',
      au: { ahpraNumber: 'MED0001234567', registrationType: 'general', fellowship: 'registrar', hasConditions: false, moratorium19ab: 'yes', workRights: 'temporary',
        noticeWeeks: 4, availableFrom: '2026-12-18', base: 'loc:VIC:3350:ballarat', travel: 'state', places: [], sessions: 8, detailsConfirmed: true }
    }, { cookie: d.cookie });
    expect(res.status).toBe(200);
    expect(res.json.auPathway.pathway).toBe('au_registrar');      // a registrar whatever else they answered
    expect(res.json.auNext).toBe('team_review');
    expect(res.json.auHold).toEqual(REG);
    expect(profile(d).candidate_pathway).toBe('au_registrar');
    expect(tasks(d, 'ahpra_register_check')).toEqual([]);
    expect(tasks(d, 'segment_review')).toEqual([]);
    expect(timeline(d).some((e) => e.title === 'Signed up as a GP registrar')).toBe(true);
    // Opening Careers afterwards raises nothing either.
    await roles(d);
    expect(tasks(d, 'segment_review')).toEqual([]);
  });
  it('a registrar who comes back with fellowship is handed to a person (the way out), and is never moved by their own answers', async () => {
    const d = add('au_registrar', { selfDeclared: true, credentials: Object.assign({}, UNVERIFIED, { ahpra_registration_type: 'general', specialist_gp: false, fellowship_type: 'none', vr_status: 'non_vr', moratorium_19ab_status: 'no', work_rights: 'citizen' }) });
    const res = await h.post('/api/onboarding/complete', {
      auBranch: 'yes',
      au: { ahpraNumber: 'MED0001234567', registrationType: 'specialist', fellowship: 'fracgp', hasConditions: false, moratorium19ab: 'no', workRights: 'citizen',
        noticeWeeks: 4, availableFrom: '2026-12-18', base: 'loc:VIC:3350:ballarat', travel: 'state', places: [], sessions: 8, detailsConfirmed: true }
    }, { cookie: d.cookie });
    expect(res.status).toBe(200);
    expect(res.json.auAlreadyComplete).toBe(true);
    expect(res.json.auPathway.pathway).toBe('au_registrar');       // R-02: a later answer never loosens
    expect(res.json.auHold.kind).toBe('registrar');
    expect(profile(d).candidate_pathway).toBe('au_registrar');
    expect(cred(d).fellowship_type).toBe('none');                  // R2-02: nothing stored was overwritten
    expect(openTasks(d, 'segment_review').length).toBe(1);         // a person decides
    expect(openTasks(d, 'ahpra_register_check').length).toBe(1);
    expect((await roles(d)).json.roles).toEqual([]);
  });
  it('a registrar who arrived from a job\'s "Apply now" is told the same thing, not "we will be in touch about that role"', () => {
    const intent = require('../lib/au-apply-intent.js');
    const record = intent.newRecord({ job: 'internal_ats:ats_wp29_dpa', at: Date.now() }, 'public_job_page');
    const base = { record, onboardingComplete: true, roleOpen: true, isAu: true };
    const reg = intent.decide(Object.assign({}, base, { verdict: { hold: true, holdKind: 'registrar', canApply: false } }));
    expect(reg).toMatchObject({ action: 'held', consume: true, keepFlag: false, outcome: 'held_registrar', notice: { title: 'We place fully qualified GPs', body: re.REGISTRAR_HOLD_MESSAGE } });
    // every other held doctor: exactly as before (the role is remembered for staff)
    const held = intent.decide(Object.assign({}, base, { verdict: { hold: true, holdKind: 'review', canApply: false } }));
    expect(held).toEqual({ action: 'held', consume: false, keepFlag: false, outcome: 'held', notice: intent.MESSAGES.held });
  });
  it('the "profile complete" email for a registrar says the same thing and promises nothing', () => {
    const m = require('../lib/au-messages.js').buildProfileCompleteMessage({ appBaseUrl: 'https://x', group: 'safe', registrar: true });
    expect(m.title).toBe('We place fully qualified GPs');
    expect(m.body).toContain(re.REGISTRAR_HOLD_MESSAGE);
    expect(m.ctaText).toBe('Message us');
    expect(m.ctaUrl).toBe('https://x/pages/messages');
    expect(m.key).toBe('au_n08_profile_complete');                 // the same once-ever message: never a second one
    expect(bannedIn([m.subject, m.title, m.body, m.footer].join('\n'))).toEqual([]);
    expect(/public Ahpra register|gets in touch|lining up/i.test(m.body)).toBe(false);
  });
});

describe('A5: seeing or applying on the doctor\'s own word never reaches a practice by itself', () => {
  it('applies to a non-DPA role on their own "does not apply": accepted and flagged to staff; "Submit to practice" refused until the check is verified AND 19AB is confirmed', async () => {
    const d = selfVr(SELF_NO);
    expect((await apply(d, METRO)).status).toBe(200);
    const app = appFor(d, 'role-metro');
    expect(app).toBeTruthy();
    // staff see the flag on the application
    const view = await staffCandidate(d);
    const card = view.json.candidate.apps.filter((a) => String(a.id) === String(app.id))[0];
    expect(card.au_location_flag).toEqual({ code: '19ab_not_confirmed', message: '19AB not yet confirmed by staff: confirm before introducing to this practice.' });
    expect(view.json.candidate.au.sorting).toMatchObject({ group: 'anywhere', self_declared_only: true, basis: 'self' });
    // 1. the register check is not saved as verified
    let res = await submit(app.id);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ ok: false, code: 'ahpra_check_not_verified', au_introduction_blocked: true });
    expect(res.json.message).toMatch(/complete the Ahpra register check and save it as verified/);
    // 2. verified by a person, 19AB still only the doctor's word
    Object.assign(cred(d), { staff_verified_at: NOW, staff_verified_by: STAFF });
    res = await submit(app.id);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('19ab_not_confirmed');
    expect(res.json.message).toMatch(/Confirm 19AB on the Ahpra register check, then submit again/);
    expect(appFor(d, 'role-metro').practice_submission_status || 'pending_va_submission').toBe('pending_va_submission');
    expect(appFor(d, 'role-metro').zoho_submission_id || null).toBe(null);
    // 3. staff confirm 19AB does not apply: this gate lets it through
    Object.assign(cred(d), { moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW });
    res = await submit(app.id);
    expect(res.json.au_introduction_blocked).toBeUndefined();
    expect(['ahpra_check_not_verified', '19ab_not_confirmed', '19ab_applies_role_not_dpa', 'location_restricted_role_not_dpa']).not.toContain(res.json.code);
    const after = await staffCandidate(d);
    expect(after.json.candidate.apps.filter((a) => String(a.id) === String(app.id))[0].au_location_flag).toBeUndefined();
  });
  it('a DPA role needs the verified check but no 19AB answer', async () => {
    const d = selfVr(SELF_UNSURE);
    expect((await apply(d, DPA)).status).toBe(200);
    const app = appFor(d, 'role-dpa');
    expect((await submit(app.id)).json.code).toBe('ahpra_check_not_verified');
    Object.assign(cred(d), { staff_verified_at: NOW, staff_verified_by: STAFF });
    const res = await submit(app.id);
    expect(res.json.au_introduction_blocked).toBeUndefined();
  });
  it('staff then confirm 19AB DOES apply: roles shrink on the next load, the open application is flagged (not withdrawn), and the doctor sees one honest line', async () => {
    const d = selfVr(SELF_NO);
    expect(crisp(await roles(d)).length).toBe(3);
    await apply(d, METRO);
    await apply(d, DPA);
    const app = appFor(d, 'role-metro');
    Object.assign(cred(d), { staff_verified_at: NOW, staff_verified_by: STAFF, moratorium_19ab_confirmed_status: 'yes', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW });
    const res = await roles(d);
    expect(crisp(res)).toEqual([DPA]);
    expect(res.json.auAreaLimited).toBe(true);
    // not withdrawn, the practice told nothing
    expect(appFor(d, 'role-metro')).toBeTruthy();
    expect(appFor(d, 'role-metro').withdrawn_at || null).toBe(null);
    const view = await staffCandidate(d);
    const card = view.json.candidate.apps.filter((a) => String(a.id) === String(app.id))[0];
    expect(card.au_location_flag.code).toBe('19ab_applies_role_not_dpa');
    expect(view.json.candidate.apps.filter((a) => String(a.id) === String(appFor(d, 'role-dpa').id))[0].au_location_flag).toBeUndefined();
    const refused = await submit(app.id);
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('19ab_applies_role_not_dpa');
    const mine = await h.get('/api/career/applications', { cookie: d.cookie });
    const metroCard = mine.json.applications.filter((a) => String(a.id) === String(app.id))[0];
    const dpaCard = mine.json.applications.filter((a) => String(a.id) === String(appFor(d, 'role-dpa').id))[0];
    expect(metroCard.auRoleCheckNote).toBe('We are checking this role fits your registration.');
    expect(dpaCard.auRoleCheckNote).toBeUndefined();
  });
  it('staff putting a doctor forward by hand: still refused for a non-DPA role while 19AB is only the doctor\'s word', async () => {
    const d = selfVr(SELF_NO);
    const block = await t.auIntroductionGate({ id: 'x', user_id: d.userId }, rows('career_roles')[0]);
    expect(block.status).toBe(409);
    const manual = await h.post('/api/ats/application', { user_id: d.userId, career_role_id: 'role-metro' }, h.superAdmin());
    expect(manual.status).toBe(409);
    expect(manual.json.code).toBe('19ab_not_confirmed');
    expect(manual.json.message).toMatch(/^This doctor cannot be put forward for this role yet:/);
    expect(rows('gp_applications').filter((a) => a.user_id === d.userId)).toEqual([]);
  });
  it('an overseas doctor, and the switch off, never meet this gate (and nothing is queried for it with the switch off)', async () => {
    const o = add('overseas_null');
    h.emu.reset();
    expect(await t.auIntroductionGate({ id: 'x', user_id: o.userId }, rows('career_roles')[0])).toBe(null);
    // an overseas doctor costs the one small pathway read the consent gate already makes, and no credentials read
    expect(h.emu.requests.filter((r) => r.table === 'gp_credentials').length).toBe(0);
    expect(h.emu.requests.filter((r) => r.table === 'runtime_kv').length).toBe(0);
    expect(h.emu.requests.length).toBeLessThanOrEqual(1);
    h.setSwitch(false);
    const d = selfVr(SELF_NO);
    h.emu.reset();
    expect(await t.auIntroductionGate({ id: 'x', user_id: d.userId }, rows('career_roles')[0])).toBe(null);
    expect(await t.auApplicationLocationFlags([{ id: 'a', user_id: d.userId, career_role_id: 'role-metro' }])).toEqual({});
    expect(await t.auRunRegisterLookup(d.userId, { trigger: 'staff', force: true })).toMatchObject({ ok: false, ran: false, reason: 'provider_off' });
    expect(h.emu.requests.length).toBe(0);
  });
});

describe('A5(d): a doctor cannot loosen their own answers after the fact', () => {
  it('Account: a restricted doctor changing registration type, fellowship or right to work makes a REQUEST, never a change (R-04 extended)', async () => {
    const d = selfB(Object.assign({}, SELF_NO, { work_rights: 'visa' }));
    expect(crisp(await roles(d))).toEqual([DPA]);
    const res = await h.post('/api/account/au-details', { workRights: 'citizen', registrationType: 'general_and_specialist' }, { cookie: d.cookie });
    expect(res.status).toBe(200);
    expect(res.json.changeRequested).toBe(true);
    expect(res.json.changeRequestedFields.sort()).toEqual(['ahpra_registration_type', 'work_rights']);
    expect(cred(d).work_rights).toBe('visa');
    expect(cred(d).ahpra_registration_type).toBe('specialist');
    expect(crisp(await roles(d))).toEqual([DPA]);                 // nothing opened
    expect(openTasks(d, 'ahpra_register_check').length).toBe(1);  // a person is asked
  });
  it('Account has no 19AB field at all, and the doctor\'s own write can never withdraw a staff "applies"', async () => {
    const d = selfVr(Object.assign({}, SELF_NO, { moratorium_19ab_confirmed_status: 'yes', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW }));
    await h.post('/api/account/au-details', { moratorium19ab: 'no', moratorium_19ab_status: 'no', moratorium_19ab_confirmed_status: 'no' }, { cookie: d.cookie });
    expect(cred(d).moratorium_19ab_confirmed_status).toBe('yes');
    const w = await t.upsertGpCredentials(d.userId, { moratorium_19ab_status: 'unsure' }, { source: 'self' });
    expect(w.ok).toBe(true);
    expect(cred(d).moratorium_19ab_confirmed_status).toBe('yes');
    expect(cred(d).moratorium_19ab_confirmed_by).toBe(STAFF);
    expect(crisp(await roles(d))).toEqual([DPA]);
    // a staff "does not apply" IS still withdrawn when the doctor changes their answer
    const e = selfVr(Object.assign({}, SELF_NO, { moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW }));
    await t.upsertGpCredentials(e.userId, { moratorium_19ab_status: 'yes' }, { source: 'self' });
    expect(cred(e).moratorium_19ab_confirmed_status).toBe(null);
    expect(crisp(await roles(e))).toEqual([DPA]);
  });
  it('a VR GP\'s Account edit before any check is unchanged from before WP-29 (their roles do not depend on those fields)', async () => {
    const d = selfVr(SELF_NO);
    const res = await h.post('/api/account/au-details', { fellowshipType: 'facrrm' }, { cookie: d.cookie });
    expect(res.status).toBe(200);
    expect(res.json.changeRequested).toBe(false);
    expect(res.json.registrationChanged).toBe(true);
    expect(cred(d).fellowship_type).toBe('facrrm');
  });
});

describe('D: the register lookup (fixture provider; default is OFF)', () => {
  const numbered = (kindFn, number, credentials, extra) => {
    const d = kindFn(Object.assign({ ahpra_number: number }, credentials || {}), extra);
    profile(d).register_number = number; profile(d).register_body = 'ahpra';
    return d;
  };
  it('OFF by default: the staff button answers 409, nothing is requested for it, and resolving a doctor reads no lookup', async () => {
    const d = numbered(selfVr, 'MED0009990001', SELF_NO);
    h.emu.reset();
    const res = await h.post('/api/ats/candidate/register-lookup', { user_id: d.userId }, h.superAdmin());
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('lookup_off');
    await roles(d);
    await staffCandidate(d);
    expect(h.emu.requests.filter((r) => r.table === 'runtime_kv' && /au_register_lookup/.test(JSON.stringify(r))).length).toBe(0);
    expect(kv(lookupKey(d))).toBe(null);
    const view = await staffCandidate(d);
    // FR-9 (deliberate): `hold` says whether an earlier lookup left a hold (S9-09); none here
    expect(view.json.candidate.au.register_lookup).toEqual({ provider: 'none', available: false, looked_up: false, hold: null });
  });
  it('switch off: the route does not exist', async () => {
    h.setSwitch(false);
    const res = await h.post('/api/ats/candidate/register-lookup', { user_id: 'x' }, h.superAdmin());
    expect(res.status).toBe(404);
  });
  it('a doctor cannot start a lookup: the route is staff only', async () => {
    await withProvider('fixture', async () => {
      const d = numbered(selfVr, 'MED0009990001', SELF_NO);
      const res = await h.post('/api/ats/candidate/register-lookup', { user_id: d.userId }, { cookie: d.cookie });
      expect([401, 403]).toContain(res.status);
      expect(kv(lookupKey(d))).toBe(null);
    });
  });
  it('CLEAN (Australian graduate, nothing on the record): the check completes with no person, recorded as the lookup\'s, and counts for "Submit to practice"', async () => {
    await withProvider('fixture', async () => {
      const d = numbered(selfVr, 'MED0009990001', SELF_NO);
      await t.auRaiseAhpraCheckTask(d.userId, { reason: 'onboarding_completed', actor: 'system' });
      expect(openTasks(d, 'ahpra_register_check').length).toBe(1);
      const res = await h.post('/api/ats/candidate/register-lookup', { user_id: d.userId }, h.superAdmin());
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ ok: true, auto_completed: true });
      const c = cred(d);
      expect(c.staff_verified_by).toBe(AUTO);                      // never attributed to a staff member
      expect(c.staff_verified_at).toBeTruthy();
      expect(c.ahpra_last_checked_by).toBe(AUTO);
      expect(c).toMatchObject({ ahpra_registration_type: 'specialist', specialist_gp: true, has_conditions: false, has_undertakings: false, has_notations: false });
      expect(String(c.registration_expiry).slice(0, 10)).toBe('2027-09-30');
      // what the register does not show is NOT claimed
      expect(c.fellowship_type).toBe('fracgp');                    // still the doctor's own answer, untouched
      expect(c.work_rights).toBe('citizen');
      expect(c.moratorium_19ab_confirmed_status).toBe(null);       // the lookup never sets a 19AB answer
      expect(c.moratorium_19ab_status).toBe('no');
      expect(openTasks(d, 'ahpra_register_check')).toEqual([]);
      expect(profile(d).register_status).toBe('verified');
      expect(profile(d).candidate_pathway).toBe('au_vr');
      expect(profile(d).pathway_confirmed_by).toBe(AUTO);
      const tl = timeline(d).map((e) => e.title);
      expect(tl).toContain('Ahpra register lookup (fixture)');
      expect(tl).toContain('Ahpra register check: verified');
      expect(timeline(d).filter((e) => e.title === 'Ahpra register check: verified')[0].detail).toMatch(/Completed automatically: no staff member checked it/);
      expect(rows('admin_audit_log').some((a) => a.action === 'admin_ahpra_register_lookup')).toBe(true);
      // FR-9 S9-03 (deliberate): sorted from the register PLUS the doctor's own "19AB does not apply"
      // (the register cannot show that). They see and can apply everywhere; the introduction to a
      // practice outside a DPA waits for a staff 19AB answer, and a task asks for it.
      const view = await staffCandidate(d);
      expect(view.json.candidate.au.sorting).toMatchObject({ group: 'anywhere', basis: 'register', needs_person: false, self_declared_only: false, rests_on_doctors_word: true, confirm_19ab: 'doctors_word' });
      expect(view.json.candidate.au.sorting.basis_line).toMatch(/together with the doctor's own answer that 19AB does not apply, which nobody has checked/);
      await apply(d, METRO);
      const sub = await submit(appFor(d, 'role-metro').id);
      expect(sub.status).toBe(409);
      expect(sub.json).toMatchObject({ au_introduction_blocked: true, code: '19ab_not_confirmed' });
    });
  });
  it('THE OWNER\'S EXAMPLE (Expedited Specialist pathway, first registered under ten years ago, supervision, approved locations): DPA roles only, check completes, both flags, segment untouched', async () => {
    await withProvider('fixture', async () => {
      const d = numbered(selfB, 'MED0009990002', Object.assign({}, SELF_YES, { has_conditions: true, conditions_text: 'Supervised practice' }));
      await t.auRaiseAhpraCheckTask(d.userId, { reason: 'onboarding_completed', actor: 'system' });
      const res = await h.post('/api/ats/candidate/register-lookup', { user_id: d.userId }, h.superAdmin());
      expect(res.json).toMatchObject({ ok: true, auto_completed: true });
      const c = cred(d);
      expect(c.staff_verified_by).toBe(AUTO);
      expect(c.has_conditions).toBe(true);
      expect(c.conditions_text).toMatch(/^On 18 December 2025, the Medical Board of Australia/);
      expect(profile(d).candidate_pathway).toBe('au_restricted');   // the lookup never moves a doctor between segments
      expect(profile(d).pathway_confirmed_at || null).toBe(null);
      expect(tasks(d, 'segment_review')).toEqual([]);               // and does not send them to a person
      expect(openTasks(d, 'ahpra_register_check')).toEqual([]);
      const s = res.json.au.sorting;
      expect(s).toMatchObject({ group: 'dpa_only', label: 'Priority areas only (DPA)', needs_person: false, basis: 'register' });
      expect(s.dpa_sentence).toBe('Trained outside Australia and New Zealand, first registered 2025-12-18: restricted until 2035-12-18, or until staff confirm an exemption.');
      expect(s.flags.map((f) => f.code)).toEqual(expect.arrayContaining(['supervision_required', 'approved_locations_only', 'moratorium_ends_on']));
      // the doctor: DPA roles only, though no role says it accepts supervised doctors
      const list = await roles(d);
      expect(crisp(list)).toEqual([DPA]);
      expect(list.json.auHold).toBeUndefined();
      // nothing of the register text reaches the doctor
      const seen = JSON.stringify([list.json, (await h.get('/api/auth/session', { cookie: d.cookie })).json]);
      expect(/Expedited|Supervision required|supervised practice|Indirect 2|approved practice location|Russian|dpa_only|Priority areas|Board approval/i.test(seen)).toBe(false);
      // the application card reminds staff about the Board approval; it does not block
      await apply(d, DPA);
      const view = await staffCandidate(d);
      const card = view.json.candidate.apps.filter((a) => String(a.id) === String(appFor(d, 'role-dpa').id))[0];
      expect(card.au_submit_notice).toBe('Registration is tied to approved practice locations: a move needs a new Board approval for the new practice.');
      expect(card.au_location_flag).toBeUndefined();
      const sub = await submit(appFor(d, 'role-dpa').id);
      expect(sub.json.au_introduction_blocked).toBeUndefined();
    });
  });
  it('the register beats the doctor when it is stricter: says "does not apply", register shows trained abroad within ten years → DPA only, staff see the disagreement, a non-DPA introduction is refused', async () => {
    await withProvider('fixture', async () => {
      const d = numbered(selfVr, 'MED0009990002', SELF_NO);
      const res = await h.post('/api/ats/candidate/register-lookup', { user_id: d.userId }, h.superAdmin());
      expect(res.json.auto_completed).toBe(true);
      expect(res.json.au.sorting.group).toBe('dpa_only');
      expect(res.json.au.sorting.person_reasons.map((r) => r.code)).toContain('register_and_doctor_disagree_19ab');
      expect(crisp(await roles(d))).toEqual([DPA]);
      rows('gp_applications').push({ id: 'app-disagree-' + d.userId, user_id: d.userId, career_role_id: 'role-metro', provider_role_id: 'ats_wp29_metro', status: 'applied', ats_stage: 'applied', origin: 'gp_applied', applied_at: NOW, updated_at: NOW,
        profile_share_consent_at: NOW, profile_share_consent_source: 'doctor_apply', profile_share_consent_role_id: 'role-metro', profile_share_consent_version: WP09_AGREED.version });
      const sub = await submit('app-disagree-' + d.userId);
      expect(sub.status).toBe(409);
      expect(['location_restricted_role_not_dpa', 'profile_share_consent_required']).toContain(sub.json.code);
      // a staff answer with a reason overrides, and is on the timeline with who and why
      const over = await h.post('/api/admin/candidate/pathway', { user_id: d.userId, moratorium_19ab_confirmed: 'no', note: 'Exemption letter dated 1 Nov 2026 (test)' }, h.superAdmin());
      expect(over.status).toBe(200);
      expect(crisp(await roles(d)).length).toBe(3);
      const line = timeline(d).filter((e) => /^Section 19AB: staff answer recorded/.test(e.title))[0];
      expect(line.detail).toMatch(/does NOT apply/);
      expect(line.detail).toMatch(/Reason: Exemption letter dated 1 Nov 2026 \(test\)/);
    });
  });
  it('NAME MISMATCH (a number that belongs to somebody else): nothing verified, nothing unlocked, the doctor is shown no roles, staff are warned and nothing is pre-filled', async () => {
    await withProvider('fixture', async () => {
      const d = numbered(selfVr, 'MED0009990004', SELF_NO);
      expect(crisp(await roles(d)).length).toBe(3);                 // before any lookup
      const res = await h.post('/api/ats/candidate/register-lookup', { user_id: d.userId }, h.superAdmin());
      expect(res.json.auto_completed).toBe(false);
      expect(cred(d).staff_verified_at).toBe(null);
      expect(profile(d).register_status).not.toBe('verified');
      const lk = res.json.au.register_lookup;
      expect(lk).toMatchObject({ found: true, name_match: false, name_on_register: 'Dr Someone Else-Entirely' });
      expect(res.json.au.sorting.person_reasons.map((r) => r.code)).toEqual(['name_mismatch']);
      const list = await roles(d);
      expect(list.json.roles).toEqual([]);
      expect(list.json.auHold.kind).toBe('review');
      expect((await apply(d, DPA)).status).toBe(403);
    });
  });
  it('NOT FOUND: not verified, the doctor is shown no roles, the check stays with staff', async () => {
    await withProvider('fixture', async () => {
      const d = numbered(selfVr, 'MED0009990003', SELF_NO);
      const res = await h.post('/api/ats/candidate/register-lookup', { user_id: d.userId }, h.superAdmin());
      expect(res.status).toBe(200);
      expect(res.json.auto_completed).toBe(false);
      expect(res.json.message).toBe('That number was not found on the register.');
      expect(cred(d).staff_verified_at).toBe(null);
      expect((await roles(d)).json.auHold.kind).toBe('review');
      expect(openTasks(d, 'ahpra_register_check').length).toBe(1);
      // a person then checks by hand and saves: their check stands over the lookup
      Object.assign(cred(d), { staff_verified_at: NOW, staff_verified_by: STAFF });
      expect((await roles(d)).json.auHold).toBeUndefined();
    });
  });
  it('NOT AUTO-VERIFIED, form pre-filled, reasons listed: a reprimand; an unfamiliar condition; expired; general registration only', async () => {
    await withProvider('fixture', async () => {
      const cases = [['MED0009990006', 'reprimands'], ['MED0009990005', 'conditions_not_standard'], ['MED0009990009', 'expired'], ['MED0009990007', 'declared_vr_register_not_specialist_gp']];
      for (const [number, reason] of cases) {
        const d = numbered(selfVr, number, SELF_NO);
        const res = await h.post('/api/ats/candidate/register-lookup', { user_id: d.userId }, h.superAdmin());
        expect(res.json.auto_completed, number).toBe(false);
        expect(cred(d).staff_verified_at, number).toBe(null);
        expect(res.json.au.sorting.person_reasons.map((r) => r.code), number).toContain(reason);
        expect(res.json.au.sorting.needs_person, number).toBe(true);
        const lk = res.json.au.register_lookup;
        expect(lk.source_line, number).toMatch(/^From the register lookup \(fixture\), \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC: check and save$/);
        expect(lk.prefill.registration_type, number).toBeTruthy();
        expect(lk.person_reasons.length, number).toBeGreaterThan(0);
        expect(openTasks(d, 'ahpra_register_check').length, number).toBe(1);
        const list = await roles(d);
        if (reason === 'declared_vr_register_not_specialist_gp') expect(list.json.auHold.kind, number).toBe('review');
        else expect(crisp(list), number).toEqual([DPA]);            // priority areas at most while a person is needed
      }
    });
  });
  it('the lookup FAILS: nothing changes at all', async () => {
    await withProvider('fixture', async () => {
      const d = numbered(selfVr, 'MED0009990012', SELF_NO);
      const before = JSON.stringify([cred(d), profile(d)]);
      const rolesBefore = crisp(await roles(d));
      const res = await h.post('/api/ats/candidate/register-lookup', { user_id: d.userId }, h.superAdmin());
      expect(res.status).toBe(502);
      expect(res.json.ok).toBe(false);
      expect(res.json.message).toMatch(/Nothing was changed/);
      expect(JSON.stringify([cred(d), profile(d)])).toBe(before);
      expect(crisp(await roles(d))).toEqual(rolesBefore);
      expect(kv(lookupKey(d))).toMatchObject({ ok: false, reason: 'timeout', facts: null });
    });
  });
  it('an automatic check cannot lift a hold or move a segment: a non-VR doctor whose number shows specialist GP stays held, flagged', async () => {
    await withProvider('fixture', async () => {
      const d = add('au_non_vr', { selfDeclared: true, credentials: Object.assign({}, UNVERIFIED, SELF_NO, { ahpra_number: 'MED0009990001', ahpra_registration_type: 'general', specialist_gp: false, fellowship_type: 'none', vr_status: 'non_vr', work_rights: 'citizen' }) });
      const res = await h.post('/api/ats/candidate/register-lookup', { user_id: d.userId }, h.superAdmin());
      expect(res.json.auto_completed).toBe(false);
      expect(profile(d).candidate_pathway).toBe('au_non_vr');
      expect(cred(d).staff_verified_at).toBe(null);
      expect(res.json.au.sorting.group).toBe('non_vr_held');
      expect(res.json.au.sorting.person_reasons.map((r) => r.code)).toContain('declared_not_vr_register_specialist_gp');
      expect((await roles(d)).json.auHold.kind).toBe('review');
    });
  });
  it('when the doctor finishes sign-up the lookup runs in the background; the same number is not looked up twice in a day unless staff press the button', async () => {
    await withProvider('fixture', async () => {
      const d = add('overseas_null', { noCase: true, profile: { first_name: 'Test', last_name: 'Onboarder', registration_country: '', qualification_country: '', onboarding_completed_at: null, register_body: null, register_number: null, register_status: null } });
      row('user_state', d.userId).state = {};
      const res = await h.post('/api/onboarding/complete', {
        auBranch: 'yes',
        au: { ahpraNumber: 'MED0009990001', registrationType: 'specialist', fellowship: 'fracgp', hasConditions: false, moratorium19ab: 'no', workRights: 'citizen',
          noticeWeeks: 4, availableFrom: '2026-12-18', base: 'loc:NSW:2150:parramatta', travel: 'commute', places: [], sessions: 8, detailsConfirmed: true }
      }, { cookie: d.cookie });
      expect(res.status).toBe(200);
      expect(await until(() => !!(cred(d) && cred(d).staff_verified_at))).toBe(true);
      expect(cred(d).staff_verified_by).toBe(AUTO);
      expect(kv(lookupKey(d))).toMatchObject({ ok: true, found: true, nameMatch: true, trigger: 'onboarding', provider: 'fixture', number: 'MED0009990001' });
      const first = kv(lookupKey(d)).at;
      const again = await t.auRunRegisterLookup(d.userId, { trigger: 'onboarding' });
      expect(again).toMatchObject({ ok: true, ran: false, reason: 'cooldown' });
      expect(kv(lookupKey(d)).at).toBe(first);
      const forced = await t.auRunRegisterLookup(d.userId, { trigger: 'staff', actor: STAFF, force: true });
      expect(forced.ran).toBe(true);
      expect(kv(lookupKey(d)).trigger).toBe('staff');
    });
  });
  it('turning the provider off again is the kill switch: stored register facts stop deciding anything', async () => {
    // (fixture 0011 lists only fellowships: the register cannot tell where the
    // primary degree is from, so with the lookup on this doctor is DPA only.)
    const d = numbered(selfVr, 'MED0009990011', SELF_NO);
    await withProvider('fixture', async () => {
      const run = await h.post('/api/ats/candidate/register-lookup', { user_id: d.userId }, h.superAdmin());
      expect(run.json.au.sorting).toMatchObject({ group: 'dpa_only', basis: 'register' });
      expect(crisp(await roles(d))).toEqual([DPA]);
    });
    // FR-9 S9-09 (deliberate; this used to be "the doctor's own answer decides the view again").
    // Provider back to the default (none): NEW lookups stop and stored register facts are no
    // longer read, but a limit the lookup put on this doctor stays until a person decides.
    h.emu.reset();
    expect(crisp(await roles(d))).toEqual([DPA]);
    expect(h.emu.requests.filter((r) => r.table === 'runtime_kv' && /au_register_lookup/.test(JSON.stringify(r))).length).toBe(0);
    expect(cred(d).ahpra_last_checked_by).toMatch(/ \(lookup hold: restricted_19ab\)$/);
    const block = await t.auIntroductionGate({ id: 'x', user_id: d.userId }, rows('career_roles').filter((r) => r.id === 'role-metro')[0]);
    expect(block).toBeTruthy();
    // a staff 19AB answer (with its reason) is what releases it
    const over = await h.post('/api/admin/candidate/pathway', { user_id: d.userId, moratorium_19ab_confirmed: 'no', note: 'Australian graduate, citizen at enrolment (test)' }, h.superAdmin());
    expect(over.status).toBe(200);
    expect(crisp(await roles(d)).length).toBe(3);
  });
});

describe('B: where they are based and how far they would go', () => {
  it('GET /api/au/localities: signed-in doctors only, at most 8, ids and labels only, 404 with the switch off', async () => {
    const d = selfVr(SELF_NO);
    expect((await h.get('/api/au/localities?q=parra')).status).toBe(401);
    const res = await h.get('/api/au/localities?q=parra', { cookie: d.cookie });
    expect(res.status).toBe(200);
    expect(res.json.results.length).toBeLessThanOrEqual(8);
    expect(res.json.results[0]).toEqual({ id: 'loc:NSW:2150:parramatta', label: 'Parramatta NSW 2150', kind: 'locality' });
    res.json.results.forEach((r) => expect(Object.keys(r).sort()).toEqual(['id', 'kind', 'label']));
    expect((await h.get('/api/au/localities?q=2150', { cookie: d.cookie })).json.results.map((r) => r.label)).toContain('Parramatta NSW 2150');
    expect((await h.get('/api/au/localities?q=sydney', { cookie: d.cookie })).json.results[0]).toMatchObject({ kind: 'city', label: 'Sydney (whole city)' });
    expect((await h.get('/api/au/localities?q=regional', { cookie: d.cookie })).json.results.map((r) => r.label)).toContain('Regional NSW');
    expect((await h.get('/api/au/localities?q=zzzzqq', { cookie: d.cookie })).json.results).toEqual([]);
    expect((await h.get('/api/au/localities?q=' + encodeURIComponent('<script>'.repeat(40)), { cookie: d.cookie })).status).toBe(200);
    h.setSwitch(false);
    expect((await h.get('/api/au/localities?q=parra', { cookie: d.cookie })).status).toBe(404);
  });
  it('sign-up stores the choice server-side and fills in the older fields from it; a repeat sign-up saves it too', async () => {
    const d = add('overseas_null', { noCase: true, profile: { registration_country: '', qualification_country: '', onboarding_completed_at: null, register_body: null, register_number: null, register_status: null } });
    row('user_state', d.userId).state = {};
    const body = (over) => ({ auBranch: 'yes', au: Object.assign({ ahpraNumber: 'MED0001234567', registrationType: 'specialist', fellowship: 'fracgp', hasConditions: false, moratorium19ab: 'no', workRights: 'citizen',
      noticeWeeks: 4, availableFrom: '2026-12-18', base: { id: 'loc:NSW:2150:parramatta', label: 'typed by the browser', lat: 0, lng: 0 }, travel: 'places', places: ['city:newcastle', 'region:NSW'], sessions: 8, detailsConfirmed: true }, over || {}) });
    const res = await h.post('/api/onboarding/complete', body(), { cookie: d.cookie });
    expect(res.status).toBe(200);
    const stored = kv('au_location_choice:' + d.userId);
    expect(stored).toMatchObject({ v: 1, travel: 'places', base: { id: 'loc:NSW:2150:parramatta', name: 'Parramatta', state: 'NSW', postcode: '2150', label: 'Parramatta NSW 2150' } });
    expect(stored.base.lat).toBeLessThan(-33);                    // the suburb list's coordinates, not the browser's 0,0
    expect(stored.places.map((p) => p.label)).toEqual(['Newcastle (whole city)', 'Regional NSW']);
    const p = profile(d);
    expect(p).toMatchObject({ current_suburb: 'Parramatta', current_state: 'NSW', current_postcode: '2150', preferred_city: 'Newcastle', commute_radius_km: null });
    expect(p.preferred_locations).toEqual(['Newcastle', 'Regional NSW']);
    expect(p.current_latitude).toBeLessThan(-33);
    // FR-4: a repeat saves preferences (not pathway facts)
    const again = await h.post('/api/onboarding/complete', body({ travel: 'anywhere', places: [], moratorium19ab: 'yes' }), { cookie: d.cookie });
    expect(again.json.auPreferencesSaved).toBe(true);
    expect(kv('au_location_choice:' + d.userId).travel).toBe('anywhere');
    expect(profile(d).preferred_locations).toEqual(['Anywhere in Australia']);
    expect(cred(d).moratorium_19ab_status).toBe('no');            // the registration answers were NOT rewritten
    // a made-up place is refused, nothing half-saved
    const bad = add('overseas_null', { noCase: true, profile: { registration_country: '', qualification_country: '', onboarding_completed_at: null } });
    row('user_state', bad.userId).state = {};
    const refused = await h.post('/api/onboarding/complete', body({ base: 'loc:NSW:9999:nowhere' }), { cookie: bad.cookie });
    expect(refused.status).toBe(400);
    expect(refused.json.errors.base).toBe('Choose where you are based from the list.');
    expect(profile(bad).candidate_pathway || null).toBe(null);
  });
  it('roles are ORDERED and LABELLED by the choice, never hidden; two doctors based in different places get different orders; 0,0 is "unknown", never 0 km', async () => {
    const sydney = selfVr(SELF_NO);
    const dubbo = selfVr(SELF_NO);
    const none = selfVr(SELF_NO);
    const match = require('../lib/au-location-match.js');
    await t.auWriteLocationChoice(sydney.userId, match.normaliseLocationChoice({ base: 'loc:NSW:2150:parramatta', travel: 'commute' }).choice);
    await t.auWriteLocationChoice(dubbo.userId, match.normaliseLocationChoice({ base: 'loc:NSW:2830:dubbo', travel: 'commute' }).choice);
    const a = await roles(sydney);
    const b = await roles(dubbo);
    const c = await roles(none);
    // Based in Parramatta: the Parramatta practice (inside a commute), then the
    // rest nearest first (Newcastle about 120 km, Dubbo about 280 km).
    expect(a.json.roles.map((r) => r.id)).toEqual([METRO, UNKNOWN, DPA]);
    // Based in Dubbo: the Dubbo practice first.
    expect(b.json.roles.map((r) => r.id)[0]).toBe(DPA);
    expect(b.json.roles.map((r) => r.id)).not.toEqual(a.json.roles.map((r) => r.id));
    // never hides: the same three roles, whatever was chosen
    for (const res of [a, b, c]) expect(res.json.roles.map((r) => r.id).sort()).toEqual([DPA, METRO, UNKNOWN].sort());
    const line = (res, id) => res.json.roles.filter((r) => r.id === id)[0].auLocation;
    expect(line(a, METRO)).toEqual({ line: 'Less than 1 km from Parramatta', within: true, distanceKm: expect.any(Number) });
    expect(line(a, DPA).line).toMatch(/^Outside the area you chose · about \d+ km from Parramatta$/);
    expect(line(a, DPA).within).toBe(false);
    expect(line(b, DPA).line).toMatch(/^(Less than 1 km|About \d+ km) from Dubbo$/);
    // the practice stored at 0,0 is looked up by its suburb in the list: a real distance, never "0 km"
    expect(line(a, UNKNOWN).distanceKm).toBeGreaterThan(80);
    expect(line(a, UNKNOWN).line).toMatch(/Newcastle|Parramatta/);
    rows('practices').filter((p) => p.id === 'p-coast')[0].suburb = 'Nowhereville';
    rows('career_roles').filter((r) => r.id === 'role-unknown')[0].suburb = 'Nowhereville';
    rows('career_roles').filter((r) => r.id === 'role-unknown')[0].location_city = 'Nowhereville';
    const unknown = line(await roles(sydney), UNKNOWN);
    expect(unknown.distanceKm).toBe(null);                         // unknown, never 0
    expect(unknown.line).not.toMatch(/\b0 km|Less than 1 km/);
    // a doctor with no choice at all has no line
    expect(c.json.roles.every((r) => r.auLocation === undefined)).toBe(true);
  });
  it('a doctor who signed up BEFORE this change: their old places still order and label the roles', async () => {
    const d = selfVr(SELF_NO, { profile: { preferred_locations: ['Sydney', 'Regional NSW'], current_suburb: 'Parramatta', current_state: 'NSW', current_postcode: '2150' } });
    const res = await roles(d);
    expect(res.json.roles.map((r) => r.id).sort()).toEqual([DPA, METRO, UNKNOWN].sort());
    expect(res.json.roles[0].id).toBe(METRO);
    expect(res.json.roles.filter((r) => r.id === METRO)[0].auLocation.within).toBe(true);
    expect(res.json.roles.filter((r) => r.id === DPA)[0].auLocation.within).toBe(true);     // regional NSW was one of their places
    const acct = await h.get('/api/account/au-details', { cookie: d.cookie });
    expect(acct.json.locationChoice).toMatchObject({ base: { id: 'loc:NSW:2150:parramatta', label: 'Parramatta NSW 2150' }, travel: 'places', fromEarlierAnswers: true });
    expect(acct.json.locationChoice.places.map((p) => p.label)).toEqual(['Sydney (whole city)', 'Regional NSW']);
  });
  it('Account: the same choice can be read and changed; staff see it in plain words', async () => {
    const d = selfVr(SELF_NO);
    const save = await h.post('/api/account/au-details', { locationChoice: { base: 'loc:QLD:4870:cairns', travel: 'state', places: [] } }, { cookie: d.cookie });
    expect(save.status).toBe(200);
    expect(save.json.locationChoice).toEqual({ base: { id: 'loc:QLD:4870:cairns', label: 'Cairns QLD 4870' }, travel: 'state', places: [], fromEarlierAnswers: false });
    expect(profile(d)).toMatchObject({ current_suburb: 'Cairns', current_state: 'QLD', current_postcode: '4870' });
    expect(profile(d).preferred_locations).toEqual(['Brisbane', 'Gold Coast', 'Sunshine Coast', 'Regional QLD']);
    const bad = await h.post('/api/account/au-details', { locationChoice: { base: 'region:QLD', travel: 'state' } }, { cookie: d.cookie });
    expect(bad.status).toBe(400);
    expect(kv('au_location_choice:' + d.userId).base.id).toBe('loc:QLD:4870:cairns');
    const view = await staffCandidate(d);
    expect(JSON.stringify(view.json.candidate)).toContain('Based in Cairns QLD 4870; anywhere in QLD');
  });
  it('an overseas doctor: the role list has none of the new keys and the order is today\'s, switch on and off', async () => {
    const o = add('overseas_null');
    const on = await roles(o);
    h.setSwitch(false);
    const off = await roles(o);
    expect(on.json).toEqual(off.json);
    const text = JSON.stringify(on.json);
    for (const key of ['auLocation', 'auAreaLimited', 'auHold', 'auFacts', 'auRegistrationPending']) expect(text.indexOf('"' + key + '"'), key).toBe(-1);
  });
});

describe('B6: the AI is told about location (and never an address)', () => {
  const match = require('../lib/ai-candidate-job-match.js');
  it('the Australian prompt says how to use it and forbids an address or a postcode', () => {
    expect(match.AI_MATCH_SYSTEM_PROMPT_AU).toMatch(/close to where you are based/);
    expect(match.AI_MATCH_SYSTEM_PROMPT_AU).toMatch(/in the state you chose/);
    expect(match.AI_MATCH_SYSTEM_PROMPT_AU).toMatch(/NEVER mention a street address or a postcode/);
    expect(match.AI_MATCH_SYSTEM_PROMPT_AU).toMatch(/NEVER mention a dollar figure, a percentage/);   // owner decision 9 still stands
  });
  it('the safety net drops a reason with a street address or a postcode, keeps suburb-level ones, and still drops money', () => {
    const kept = match.sanitiseAuMatchReasons([
      'Close to where you are based in Parramatta', 'In the state you chose', 'Mixed billing suits what you asked for',
      'The practice is at 12 Smith Street, Parramatta', 'It is in Parramatta NSW 2150', 'Postcode 2150 is near you', 'Suite 4 is on the ground floor',
      'You would earn about $300k', '70% of billings'
    ]);
    expect(kept).toEqual(['Close to where you are based in Parramatta', 'In the state you chose', 'Mixed billing suits what you asked for']);
  });
  it('the matching inputs carry suburb-level facts only: no postcode, no coordinates in what the model is shown', async () => {
    const d = selfVr(SELF_NO);
    const lm = require('../lib/au-location-match.js');
    await t.auWriteLocationChoice(d.userId, lm.normaliseLocationChoice({ base: 'loc:NSW:2150:parramatta', travel: 'commute' }).choice);
    const built = await t.atsBuildGpMatchInputs([d.userId]);
    const gp = built[d.userId];
    expect(gp.au.location).toEqual({ based_in: 'Parramatta NSW', travel_preference: 'within a commute of where they are based', chosen_places: [] });
    const shown = JSON.stringify(match._gpForPromptAu ? match._gpForPromptAu(t.atsGpForRanking(gp)) : gp.au.location);
    expect(/2150|-33\.|151\.0/.test(JSON.stringify(gp.au.location))).toBe(false);
    if (match._gpForPromptAu) expect(/"based_in":"Parramatta NSW"/.test(shown)).toBe(true);
  });
});

describe('the pieces a browser loads', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  it('the location picker carries no word from the banned list, asks only our own server, and says the agreed things', () => {
    const { stripJsComments } = require('./helpers/au-banned-words.js');
    const js = read('js/au-location-picker.js');
    expect(bannedIn(stripJsComments(js))).toEqual([]);
    expect(js).toContain('"/api/au/localities"');
    expect(/https?:\/\/|googleapis|maps\.google/i.test(stripJsComments(js))).toBe(false);
    const picker = require('../js/au-location-picker.js');
    expect(picker.TRAVEL_OPTIONS.map((o) => o.label)).toEqual([
      'Within a commute of where I am now (about 45 minutes)', 'Anywhere in my state', 'Specific places', 'Anywhere in Australia']);
    expect(picker.NOTHING_FOUND).toBe('Nothing found. Try a nearby town or a postcode.');
    for (const need of ['role", "combobox"', 'role", "listbox"', 'role", "option"', 'aria-activedescendant', 'aria-expanded', 'aria-live', 'aria-labelledby']) expect(js, need).toContain(need);
    // only a complete, well-formed value survives
    expect(picker.cleanValue({ base: { id: 'loc:NSW:2150:parramatta', label: 'Parramatta NSW 2150', lat: 1 }, travel: 'teleport', places: [{ id: 'city:sydney', label: 'Sydney (whole city)' }, { id: 'city:sydney' }, { nope: 1 }] }))
      .toEqual({ base: { id: 'loc:NSW:2150:parramatta', label: 'Parramatta NSW 2150' }, travel: '', places: [{ id: 'city:sydney', label: 'Sydney (whole city)' }] });
  });
  it('the onboarding page loads the picker only when the Australian screens are entered (nothing new for a doctor on today\'s wizard)', () => {
    const html = read('pages/onboarding.html');
    expect(html).not.toMatch(/<script[^>]+au-location-picker/);
    expect(html).toContain('<div id="auLocationPicker"></div>');
    expect(read('js/onboarding.js')).toContain('var AU_LOCATION_PICKER_SRC = "/js/au-location-picker.js?v=20261126a";');
    expect(read('sw.js')).not.toContain('"/js/au-location-picker');      // not pre-fetched for everyone
    // the 19AB helper: answerable by a normal doctor, and the three answers stay
    expect(html).toContain('It usually applies to doctors who trained outside Australia or New Zealand, or who were not an Australian or New Zealand citizen or permanent resident when they started their medical degree, for ten years from their first Australian registration. If you are not sure, choose Not sure and we will confirm with you.');
    expect(html).toContain('id="auSuccessRegistrarTitle">We place fully qualified GPs<');
  });
  it('Account: the picker replaces the three typed fields and the old list only when it is on the page; the form still works without it', () => {
    const acc = require('../js/account-au.js');
    const view = { ok: true, options: { registrationTypes: [], fellowshipTypes: [], workRights: [], states: ['NSW'], locations: ['Sydney'] }, preferredLocations: ['Sydney'], existingProviderNumbers: [],
      locationChoice: { base: { id: 'loc:NSW:2150:parramatta', label: 'Parramatta NSW 2150' }, travel: 'commute', places: [], fromEarlierAnswers: true } };
    const htmlOut = acc._viewHtml(view);
    expect(htmlOut).toContain('id="auAccLocationPickerWrap" hidden');
    expect(htmlOut).toContain('This is from what you told us when you signed up. Check it and save.');
    const el = { querySelector: () => null, querySelectorAll: () => [] };
    expect(acc._readForm(el, view).locationChoice).toBeUndefined();
    const picked = { base: { id: 'loc:NSW:2150:parramatta', label: 'x' }, travel: 'places', places: [{ id: 'city:sydney', label: 'y' }] };
    expect(acc._readForm(el, view, picked).locationChoice).toEqual({ base: 'loc:NSW:2150:parramatta', travel: 'places', places: ['city:sydney'] });
    expect(acc._readForm(el, view, { base: null, travel: 'state', places: [] }).locationChoice).toBeUndefined();
  });
});

describe('the candidate list: the group read is made only when it is needed', () => {
  it('a list with no Australian doctor makes no extra credentials read; one with an Australian doctor makes exactly one', async () => {
    const saved = {};
    ['user_profiles', 'gp_credentials', 'registration_cases', 'user_state', 'gp_applications', 'registration_tasks', 'runtime_kv'].forEach((name) => { saved[name] = rows(name).splice(0); });
    try {
      add('overseas_null');
      h.emu.reset();
      const res = await h.get('/api/ceo/candidates', h.superAdmin());
      expect(res.status).toBe(200);
      expect(h.emu.requests.filter((r) => r.table === 'gp_credentials' && /select=\*/.test(r.query || '')).length).toBe(0);
      expect(h.emu.requests.filter((r) => r.table === 'runtime_kv').length).toBe(0);
      const d = selfVr(SELF_NO);
      h.emu.reset();
      const withAu = await h.get('/api/ceo/candidates', h.superAdmin());
      expect(h.emu.requests.filter((r) => r.table === 'gp_credentials' && /select=\*/.test(r.query || '')).length).toBe(1);
      expect(h.emu.requests.filter((r) => r.table === 'runtime_kv' && /au_register_lookup/.test(r.query || '')).length).toBe(0);   // provider off
      const mine = withAu.json.candidates.filter((c) => c.user_id === d.userId)[0];
      expect(mine.au).toMatchObject({ group: 'anywhere', group_label: 'Can work anywhere', needs_person: false });
      const filtered = await h.get('/api/ceo/candidates?pathway=group_dpa_only', h.superAdmin());
      expect(filtered.json.candidates.filter((c) => c.user_id === d.userId)).toEqual([]);
      expect((await h.get('/api/ceo/candidates?pathway=group_anywhere', h.superAdmin())).json.candidates.map((c) => c.user_id)).toContain(d.userId);
    } finally {
      Object.keys(saved).forEach((name) => { rows(name).length = 0; saved[name].forEach((r) => rows(name).push(r)); });
    }
  });
  it('a person records "number not matched": the doctor who said "does not apply" is kept to DPA roles until a check is saved as verified', async () => {
    const d = selfVr(SELF_NO);
    profile(d).register_number = 'MED0001000099'; profile(d).register_body = 'ahpra';
    expect(crisp(await roles(d)).length).toBe(3);
    const res = await h.post('/api/ats/candidate/register-verification', { userId: d.userId, action: 'ahpra_check', outcome: 'not_matched', note: 'Different name.' }, h.superAdmin());
    expect(res.status).toBe(200);
    expect(profile(d).register_status).toBe('mismatch');
    expect(cred(d).ahpra_last_checked_by).toBe(h.SUPER_EMAIL + ' (number not matched)');
    expect(crisp(await roles(d))).toEqual([DPA]);
    const view = await staffCandidate(d);
    expect(view.json.candidate.au.sorting.person_reasons.map((r) => r.code)).toContain('last_check_not_verified');
  });
});

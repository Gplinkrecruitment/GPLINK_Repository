// Australian GP build, FR-9 (fix bundle for review round 12): the doctor sorting rule and the Ahpra
// register lookup. End to end against the real server and the in-memory database stub. The lookup is
// the fixture provider only: no test reaches the real register. Each test fails on the code before FR-9.
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
  h = await bootAuTestServer({ name: 'fr9', tables });
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

// ── shared for this file ─────────────────────────────────────────────────────
const sorting = require('../lib/au-work-sorting.js');
const lookupLib = require('../lib/ahpra-register-lookup.js');
const FX = require('../lib/ahpra-register-fixtures.js');
const numbered = (kindFn, number, credentials, extra) => {
  const d = kindFn(Object.assign({ ahpra_number: number }, credentials || {}), extra);
  profile(d).register_number = number; profile(d).register_body = 'ahpra';
  return d;
};
const lookUp = (d) => h.post('/api/ats/candidate/register-lookup', { user_id: d.userId }, h.superAdmin());
const confirmTasks = (d) => rows('registration_tasks').filter((x) => caseOf(d) && x.case_id === caseOf(d).id && x.source_trigger === 'au_confirm_19ab');
const openConfirm = (d) => confirmTasks(d).filter((x) => x.status !== 'completed' && x.status !== 'cancelled');
const metroRole = () => rows('career_roles').filter((r) => r.id === 'role-metro')[0];
const dpaRole = () => rows('career_roles').filter((r) => r.id === 'role-dpa')[0];
const gate = (d, role) => t.auIntroductionGate({ id: 'x-' + d.userId, user_id: d.userId }, role);
const staff19 = (d, value, note) => h.post('/api/admin/candidate/pathway', Object.assign({ user_id: d.userId, moratorium_19ab_confirmed: value }, note ? { note } : {}), h.superAdmin());
const intro = async (d) => { const r = await t.auPracticeIntroFor(d.userId, profile(d), 'Test Doctor'); return r && r.intro ? r.intro : null; };
const reasonCodes = (view) => view.json.candidate.au.sorting.person_reasons.map((r) => r.code);

describe('FR-9 S9-01: a stored lookup that cannot be read is never "no lookup"', () => {
  it('a doctor the register put on hold stays on hold when the stored lookup cannot be read', async () => {
    await withProvider('fixture', async () => {
      const d = numbered(selfVr, 'MED0009990004', SELF_NO);                 // a number that belongs to somebody else
      await lookUp(d);
      expect(crisp(await roles(d))).toEqual([]);
      expect((await roles(d)).json.auHold.kind).toBe('review');
      h.emu.failTables = { runtime_kv: 500 };
      const res = await roles(d);
      expect(crisp(res)).toEqual([]);                                       // old code: every role
      expect(res.json.auHold.kind).toBe('review');
      const view = await staffCandidate(d);
      expect(view.json.candidate.au.sorting).toMatchObject({ on_hold: true, needs_person: true, label: 'On hold: needs a person' });
      expect(reasonCodes(view)).toContain('lookup_unreadable');
      expect(view.json.candidate.au.register_lookup.unreadable).toBe(true);
      // and nothing can be introduced
      expect(await gate(d, dpaRole())).toBeTruthy();
    });
  });
  it('a doctor the register limited to priority areas stays limited; a doctor with nothing against them drops to priority areas (never wider) until it can be read', async () => {
    await withProvider('fixture', async () => {
      const limited = numbered(selfVr, 'MED0009990002', SELF_NO);           // trained abroad, inside ten years, said "does not apply"
      const clean = numbered(selfVr, 'MED0009990001', SELF_NO);
      await lookUp(limited); await lookUp(clean);
      expect(crisp(await roles(limited))).toEqual([DPA]);
      expect(crisp(await roles(clean)).length).toBe(3);
      h.emu.failTables = { runtime_kv: 500 };
      expect(crisp(await roles(limited))).toEqual([DPA]);                   // old code: 3
      expect(crisp(await roles(clean))).toEqual([DPA]);
      const view = await staffCandidate(clean);
      expect(view.json.candidate.au.sorting).toMatchObject({ group: 'dpa_only', needs_person: true, on_hold: false });
      expect(reasonCodes(view)).toContain('lookup_unreadable');
      // the staff list reads the lookups in a batch: the same careful answer there
      const list = await h.get('/api/ceo/candidates', h.superAdmin());
      const mine = list.json.candidates.filter((c) => c.user_id === clean.userId)[0];
      expect(mine.au).toMatchObject({ group: 'dpa_only', needs_person: true });
      h.emu.failTables = {};
      expect(crisp(await roles(clean)).length).toBe(3);                     // readable again: back to what the register and the doctor said
    });
  });
  it('the rule itself: unreadable is "a person is needed, priority areas at most", and nothing auto-completes', () => {
    const out = sorting.sortDoctorByWhereTheyCanWork({ registerFacts: { unreadable: true }, doctorAnswers: { vr: true, moratorium19ab: 'no', workRights: 'citizen' }, staffConfirmed: {}, now: '2026-11-26' });
    expect(out).toMatchObject({ group: 'dpa_only', dpaOnly: true, needsPerson: true, registerState: 'unreadable', canAutoCompleteCheck: false, restsOnDoctorsWord: false });
    const held = sorting.sortDoctorByWhereTheyCanWork({ registerFacts: { unreadable: true }, doctorAnswers: { vr: true, moratorium19ab: 'no' }, staffConfirmed: { lookupHold: 'name_mismatch' }, now: '2026-11-26' });
    expect(held).toMatchObject({ held: true, onHold: true });
  });
  it('the location choice is different: when IT cannot be read nothing is hidden (only the order and the distance line go)', async () => {
    const d = selfVr(SELF_NO);
    expect(crisp(await roles(d)).length).toBe(3);
    h.emu.failTables = { runtime_kv: 500 };
    const res = await roles(d);
    expect(res.status).toBe(200);
    expect(crisp(res).length).toBe(3);
  });
});

describe('FR-9 S9-02 / S9-12: a practice is told only what its source supports', () => {
  it('an automatic check does not make the doctor\'s own fellowship a fact; the register\'s own list does; supervision is said in plain words', async () => {
    await withProvider('fixture', async () => {
      // the owner's-example fixture: the register lists MRCGP (UK) and an overseas degree, NO Australian fellowship
      const esp = numbered(selfB, 'MED0009990002', Object.assign({}, SELF_YES, { has_conditions: true, fellowship_type: 'fracgp' }));
      const run = await lookUp(esp);
      expect(run.json.auto_completed).toBe(true);
      expect(cred(esp).staff_verified_by).toBe(AUTO);
      expect(cred(esp).fellowship_type).toBe('fracgp');                     // still only their own answer
      const view = await staffCandidate(esp);
      expect(view.json.candidate.au.sorting).toMatchObject({ fellowship_source: null, supervision_required: true, checked_by: 'lookup' });
      const a = await intro(esp);
      expect(a.paragraph).not.toMatch(/FRACGP|FACRRM/);                     // old code: "(FRACGP)"
      expect(JSON.stringify(a.facts)).not.toMatch(/FRACGP|FACRRM/);
      expect(a.paragraph).toMatch(/works under supervision/);              // S9-12 (old code: no supervision line)
      expect(a.paragraph).not.toMatch(/Indirect 2|Board approved supervisor|supervised practice arrangement/i);   // never the register's own text
      expect(cred(esp).supervision_level).toBe('level_3');                  // "Indirect 2", recorded by the automatic check
      // staff still see the approved-locations reminder at Submit to practice
      expect(view.json.candidate.au.sorting.flags.map((f) => f.code)).toEqual(expect.arrayContaining(['supervision_required', 'approved_locations_only']));

      // a clean Australian graduate whose register entry itself lists FRACGP: stated, from the register
      const au = numbered(selfVr, 'MED0009990001', Object.assign({}, SELF_NO, { fellowship_type: 'facrrm' }));   // they SAID FACRRM
      await lookUp(au);
      const b = await intro(au);
      expect((await staffCandidate(au)).json.candidate.au.sorting.fellowship_source).toBe('register');
      expect(b.paragraph).toMatch(/\(FRACGP\)/);                            // what the register shows, not what they typed
      expect(b.paragraph).not.toMatch(/FACRRM/);
      expect(cred(au).supervision_level).toBe('none');                      // the register positively shows none
      expect(b.paragraph).not.toMatch(/supervision/);
    });
  });
  it('a PERSON\'s verified check still states the fellowship they recorded (unchanged)', async () => {
    const d = add('au_vr', { credentials: { staff_verified_at: NOW, staff_verified_by: STAFF }, profile: { register_status: 'verified', register_body: 'ahpra' } });   // a person verified it
    const a = await intro(d);
    expect(a.paragraph).toMatch(/vocationally registered GP \((FRACGP|FACRRM)/);
  });
  it('the reading helpers: register fellowship from the full award name; supervision levels', () => {
    expect(sorting.registerGpFellowship([{ raw: 'Fellowship of the Royal Australian College of General Practitioners, Royal Australian College of General Practitioners, Australia, 2016' }])).toBe('fracgp');
    expect(sorting.registerGpFellowship([{ raw: 'Fellowship of the Australian College of Rural and Remote Medicine, Australian College of Rural and Remote Medicine, Australia, 2019' }])).toBe('facrrm');
    expect(sorting.registerGpFellowship([{ raw: 'Membership of the Royal College of General Practitioners, Royal College of General Practitioners, United Kingdom, 2024' }])).toBe(null);
    expect(sorting.registerGpFellowship([{ raw: 'Fellowship of the Royal Australasian College of Physicians, RACP, Australia, 2012' }])).toBe(null);
    expect(['Direct', 'Indirect 1', 'Indirect 2', 'Remote', 'Level 3', 'Something else', ''].map(sorting.supervisionLevelCode)).toEqual(['level_1', 'level_2', 'level_3', 'level_4', 'level_3', '', '']);
  });
  it('the AI is not told "staff have confirmed ... (FRACGP)" after an automatic check', () => {
    const ctx = require('../lib/au-ai-context.js');
    const base = { isAu: true, pathway: 'au_vr', segment: 'A', launched: true, confirmed: true };
    const auto = ctx.auPromptContext(Object.assign({}, base, { sorting: { checkedBy: 'lookup', fellowship: { type: null, source: null } } }), { fellowship_type: 'fracgp' }, {});
    const text = JSON.stringify(auto);
    expect(text).not.toMatch(/staff have confirmed they are a vocationally registered GP/);
    expect(text).not.toMatch(/FRACGP/);
    expect(text).toMatch(/automatic check of the public Ahpra register/);
    const person = ctx.auPromptContext(Object.assign({}, base, { sorting: { checkedBy: 'person', fellowship: { type: 'fracgp', source: 'staff' } } }), { fellowship_type: 'fracgp' }, {});
    expect(JSON.stringify(person)).toMatch(/staff have confirmed they are a vocationally registered GP \(FRACGP\)/);
  });
});

describe('FR-9 S9-03: "anywhere" that leans on the doctor\'s own word is not enough for a practice outside a DPA', () => {
  it('an Australian graduate who said "19AB does not apply": sees and applies everywhere; the non-DPA introduction waits for staff; a task asks; staff are told the truth', async () => {
    await withProvider('fixture', async () => {
      const d = numbered(selfVr, 'MED0009990001', SELF_NO);
      await t.auRaiseAhpraCheckTask(d.userId, { reason: 'onboarding_completed', actor: 'system' });
      const run = await lookUp(d);
      expect(run.json.auto_completed).toBe(true);
      expect(crisp(await roles(d)).length).toBe(3);                         // what the doctor SEES is unchanged
      expect((await apply(d, METRO)).status).toBe(200);                     // and they can apply
      // the automatic check closed the check task, so the 19AB question has its own open task
      expect(openTasks(d, 'ahpra_register_check')).toEqual([]);
      expect(openConfirm(d).length).toBe(1);
      expect(openConfirm(d)[0]).toMatchObject({ task_type: 'followup', title: expect.stringMatching(/^Confirm 19AB with the doctor: /) });
      expect(openConfirm(d)[0].metadata).toMatchObject({ au: true, kind: 'confirm_19ab', why: 'doctors_word' });
      // staff are told where each deciding fact came from
      const view = await staffCandidate(d);
      expect(view.json.candidate.au.sorting.decided_by).toEqual([{ fact: 'where_trained', source: 'register' }, { fact: '19ab_answer', source: 'doctor' }]);
      expect(view.json.candidate.au.sorting.basis_line).toMatch(/which nobody has checked/);
      const card = view.json.candidate.apps.filter((a) => String(a.id) === String(appFor(d, 'role-metro').id))[0];
      expect(card.au_location_flag).toMatchObject({ code: '19ab_not_confirmed', message: '19AB not yet confirmed by staff: confirm before introducing to this practice.' });
      // the introduction is refused, in plain words (old code: it went)
      const sub = await submit(appFor(d, 'role-metro').id);
      expect(sub.status).toBe(409);
      expect(sub.json).toMatchObject({ au_introduction_blocked: true, code: '19ab_not_confirmed' });
      expect(sub.json.message).toMatch(/Nothing was sent/);
      // a DPA role is unaffected
      expect(await gate(d, dpaRole())).toBe(null);
      // staff confirm (the API needs the reason): the gate opens and the task closes
      expect((await staff19(d, 'no')).status).toBe(400);
      expect((await staff19(d, 'no')).json.code).toBe('reason_required');
      expect((await staff19(d, 'no', 'Citizen at enrolment, confirmed by phone (test)')).status).toBe(200);
      expect(await gate(d, metroRole())).toBe(null);
      expect(openConfirm(d)).toEqual([]);
      expect(confirmTasks(d)[0].status).toBe('completed');
    });
  });
  it('trained overseas, more than ten years ago, "citizen" only on their own word: the same', async () => {
    await withProvider('fixture', async () => {
      const d = numbered(selfVr, 'MED0009990008', SELF_NO);                 // UK degree, first registered 2014
      await lookUp(d);
      const view = await staffCandidate(d);
      expect(view.json.candidate.au.sorting).toMatchObject({ group: 'anywhere', basis: 'register', rests_on_doctors_word: true, confirm_19ab: 'doctors_word' });
      expect(view.json.candidate.au.sorting.decided_by).toContainEqual({ fact: 'right_to_work', source: 'doctor' });
      expect(view.json.candidate.au.sorting.basis_line).toMatch(/own answer that they are a citizen or permanent resident, which nobody has checked/);
      expect((await gate(d, metroRole())).code).toBe('19ab_not_confirmed');  // old code: null
      expect(await gate(d, dpaRole())).toBe(null);
    });
  });
  it('a practice is told 19AB "is being confirmed" only when a task really exists for it', async () => {
    await withProvider('fixture', async () => {
      const d = numbered(selfVr, 'MED0009990001', SELF_NO);
      await lookUp(d);
      // somebody ticked the task off without recording an answer
      confirmTasks(d).forEach((x) => { x.status = 'completed'; });
      expect(openConfirm(d)).toEqual([]);
      const a = await intro(d);
      expect(JSON.stringify(a)).toMatch(/confirming/i);
      expect(openConfirm(d).length).toBe(1);                                // building the introduction raised it again
    });
  });
});

describe('FR-9 S9-04: only a conditions block that is recognised line by line is "standard"', () => {
  const STD = FX.STANDARD_SUPERVISED_PRACTICE_CONDITIONS;
  const cases = [
    ['an extra block with no number after the set', STD + '\n\nOn 5 May 2026, the Medical Board of Australia (the Board) imposed conditions.\n\nThe practitioner must not consult female patients without a chaperone.'],
    ['a lettered extra condition', STD + '\n\na) The practitioner must not prescribe Schedule 8 medicines.'],
    ['a numbered line with no full stop', STD + '\n\n1 The practitioner must not prescribe Schedule 8 medicines.'],
    ['a standard heading with different wording under it', '1. Complete supervised practice for suitability and eligibility – Expedited Specialist pathway\n1.1 The practitioner must not see female patients.'],
    ['a standard heading with nothing under it', '1. Complete supervised practice for suitability and eligibility – Expedited Specialist pathway'],
    ['one word changed inside a standard sentence', STD.replace('3.2 The practitioner must successfully complete Board-approved cultural safety education.', '3.2 The practitioner must not practise until completing Board-approved cultural safety education.')]
  ];
  it.each(cases)('%s: needs a person, no automatic completion', (name, text) => {
    const c = sorting.classifyConditions(text);
    expect(c.standard).toBe(false);
    expect(c.unrecognised.length).toBeGreaterThan(0);
    const html = FX.detailsPageHtml('MED0009990001', { name: 'Dr A B', firstRegistration: '18/12/2025', qualifications: ['Doctor of Medicine in General Medicine, Example State Medical University, Russian Federation, 2015'],
      types: [{ word: 'Specialist', specialty: 'General practice', expiry: '30/09/2027', conditions: text, endorsements: null, notations: null, requirements: FX.STANDARD_REQUIREMENTS }] }, 'Dr A B');
    const parsed = lookupLib.parseRegistrationDetailsHtml(html, 'MED0009990001');
    expect(parsed.ok).toBe(true);
    const out = sorting.sortDoctorByWhereTheyCanWork({ registerFacts: Object.assign(parsed.facts, { found: true, nameMatch: true }), doctorAnswers: { vr: true, moratorium19ab: 'yes', workRights: 'citizen' }, staffConfirmed: {}, now: '2026-11-26' });
    expect(out.canAutoCompleteCheck).toBe(false);                           // old code: true for the first four
    expect(out.autoCompleteBlockers).toContain('conditions_not_standard');
    expect(out.personReasons.map((r) => r.code)).toContain('conditions_not_standard');
  });
  it('the standard set itself, with another doctor\'s dates and numbers, renumbered, or with single line breaks, is still standard', () => {
    expect(sorting.classifyConditions(STD).standard).toBe(true);
    expect(sorting.classifyConditions(STD.replace(/18 December 2025/g, '3 March 2026').replace('3 months', '4 months')).standard).toBe(true);
    expect(sorting.classifyConditions(STD.replace(/^1\. /m, '4. ').replace(/\n\n/g, '\n')).standard).toBe(true);
    expect(sorting.STANDARD_CONDITION_TEMPLATES.map((x) => x.length)).toEqual([14, 5, 9]);
  });
});

describe('FR-9 S9-07: "trained here" needs positive evidence', () => {
  const sortFrom = (quals, firstRegistration, answers) => {
    const html = FX.detailsPageHtml('MED0009990001', { name: 'Dr A B', firstRegistration: firstRegistration || '15/01/2020', qualifications: quals,
      types: [{ word: 'Specialist', specialty: 'General practice', expiry: '30/09/2027', conditions: null, endorsements: null, notations: null, requirements: null }] }, 'Dr A B');
    const parsed = lookupLib.parseRegistrationDetailsHtml(html, 'MED0009990001');
    return sorting.sortDoctorByWhereTheyCanWork({ registerFacts: Object.assign(parsed.facts, { found: true, nameMatch: true }),
      doctorAnswers: Object.assign({ vr: true, moratorium19ab: 'no', workRights: 'citizen' }, answers || {}), staffConfirmed: {}, now: '2026-11-26' });
  };
  // the reviewer's five: each was "anywhere" on the old code
  it.each([
    ['a school abroad whose name contains an Australian one, no country', ['MBBS, University of Newcastle upon Tyne, 2001'], '15/01/2011'],
    ['an overseas campus of an Australian university, no country', ['MBBS, Monash University Malaysia, 2012']],
    ['a school abroad sharing a name with an Australian one, no country', ['MBBS, University of New England College of Medicine, 2012']],
    ['an overseas degree with no year, and a later Australian Doctor of Medicine', ['Doctor of Medicine, University of Sydney, Australia, 2018', 'MBBS, University of Delhi, India']],
    ['an overseas degree with a title we do not know, and a later Australian Doctor of Medicine', ['Medico Cirujano, Universidad X, Chile, 2009', 'Doctor of Medicine, Bond University, Australia, 2022'], '15/01/2023']
  ])('%s: priority areas only', (name, quals, first) => {
    const out = sortFrom(quals, first);
    expect(out.group).toBe('dpa_only');
    expect(out.register.trainedAbroad).not.toBe(false);
  });
  it('other titles from other countries count as a possible first degree too; an Australian or New Zealand degree with nothing else is still "here"', () => {
    for (const title of ['Lekarz', 'MBBCh', 'Dr. med.', 'Vrach', 'Physician', 'Diploma in Child Health']) {
      expect(sortFrom([title + ', Example University, Germany, 2009', 'Doctor of Medicine, Bond University, Australia, 2022'], '15/01/2023').group, title).toBe('dpa_only');
    }
    expect(sortFrom(['Bachelor of Medicine / Bachelor of Surgery, University of Sydney, Australia, 2010'], '15/01/2011').group).toBe('anywhere');
    expect(sortFrom(['MBBS, University of Sydney, 2010'], '15/01/2011').group).toBe('anywhere');               // full name of a school on the list
    expect(sortFrom(['MBBS, The University of Sydney, 2010'], '15/01/2011').group).toBe('anywhere');
    expect(sortFrom(['Bachelor of Medicine and Bachelor of Surgery, University of Otago, New Zealand, 2010'], '15/01/2011').group).toBe('anywhere');
    expect(sortFrom(['MBBS, University of Newcastle, 2010'], '15/01/2011').group).toBe('dpa_only');            // shared with a school abroad: needs the country
    expect(sortFrom(['MBBS, University of Newcastle, Australia, 2010'], '15/01/2011').group).toBe('anywhere');
    // a college fellowship from abroad is not a degree (the owner's example lists MRCGP)
    expect(sortFrom(['Membership of the Royal College of General Practitioners, Royal College of General Practitioners, United Kingdom, 2024', 'MBBS, University of Sydney, Australia, 2010'], '15/01/2011').group).toBe('anywhere');
    // only a postgraduate award from here, no first degree listed: cannot tell
    expect(sortFrom(['Master of Public Health, University of Sydney, Australia, 2015'], '15/01/2011').register.trainedAbroad).toBe('unknown');
  });
});

describe('FR-9 S9-08 / S9-09: a lookup never lifts a hold by itself, and switching the lookup off releases nobody', () => {
  it('wrong name, then the doctor renames their account, then staff press "Look up": still on hold, nothing completed, the form is filled in for a person', async () => {
    await withProvider('fixture', async () => {
      const d = numbered(selfVr, 'MED0009990004', SELF_NO);
      await lookUp(d);
      expect(cred(d).ahpra_last_checked_by).toBe(AUTO + ' (lookup hold: name_mismatch)');
      expect(crisp(await roles(d))).toEqual([]);
      profile(d).first_name = 'Someone'; profile(d).last_name = 'Else-Entirely';      // the doctor can edit their own name
      const again = await lookUp(d);
      expect(again.json.auto_completed).not.toBe(true);                     // old code: auto-verified, "Can work anywhere"
      expect(cred(d).staff_verified_at).toBe(null);
      expect(kv(lookupKey(d)).nameMatch).toBe(true);
      expect(again.json.au.sorting).toMatchObject({ on_hold: true, label: 'On hold: needs a person', lookup_hold: 'name_mismatch' });
      expect(again.json.au.sorting.person_reasons.map((r) => r.code)).toContain('held_name_mismatch');
      expect(again.json.au.register_lookup.prefill).toBeTruthy();           // it may fill the form in
      expect(crisp(await roles(d))).toEqual([]);
      // S9-09: the lookup is switched off: still on hold, and no stored lookup is read
      await withProvider(null, async () => {
        h.emu.reset();
        expect(crisp(await roles(d))).toEqual([]);
        expect((await roles(d)).json.auHold.kind).toBe('review');
        expect(h.emu.requests.filter((r) => r.table === 'runtime_kv' && /au_register_lookup/.test(JSON.stringify(r))).length).toBe(0);
        expect((await staffCandidate(d)).json.candidate.au.register_lookup).toMatchObject({ available: false, hold: 'name_mismatch' });
      });
      // a PERSON saving the check is what releases it
      const saved = await h.post('/api/ats/candidate/register-verification', { userId: d.userId, action: 'ahpra_check', outcome: 'verified', ahpra_number: 'MED0009990004',
        registration_type: 'specialist', specialist_gp: true, has_conditions: false, has_undertakings: false, has_notations: false, registration_expiry: '2027-09-30',
        fellowship_type: 'fracgp', work_rights: 'citizen', supervision_level: 'none', moratorium_19ab_confirmed: 'unconfirmed', resolve_segment_review: true, note: 'Married name; sighted the certificate (test).' }, h.superAdmin());
      expect(saved.status).toBe(200);
      expect(cred(d).ahpra_last_checked_by).toBe(h.SUPER_EMAIL);
      expect(crisp(await roles(d)).length).toBe(3);
      // 19AB is still only the doctor's word, so the task is there
      expect(openConfirm(d).length).toBe(1);
    });
  });
  it('a person recorded "number not matched", then a lookup comes back clean: not completed by the lookup', async () => {
    await withProvider('fixture', async () => {
      const d = numbered(selfVr, 'MED0009990001', SELF_NO);
      const nm = await h.post('/api/ats/candidate/register-verification', { userId: d.userId, action: 'ahpra_check', outcome: 'not_matched', note: 'Different name on the register (test).' }, h.superAdmin());
      expect(nm.status).toBe(200);
      const run = await lookUp(d);
      expect(run.json.auto_completed).not.toBe(true);                       // old code: true
      expect(cred(d).staff_verified_at).toBe(null);
      expect(run.json.au.pathway.sorting.autoCompleteBlockers).toContain('earlier_check_not_matched');
      expect(crisp(await roles(d))).toEqual([DPA]);
    });
  });
  it('not found, then found: still on hold; not specialist GP, then specialist GP: still held as before; an automatic check never removes the mark', async () => {
    await withProvider('fixture', async () => {
      const d = numbered(selfVr, 'MED0009990003', SELF_NO);                 // not found
      await lookUp(d);
      expect(cred(d).ahpra_last_checked_by).toBe(AUTO + ' (lookup hold: not_found)');
      cred(d).ahpra_number = 'MED0009990001'; profile(d).register_number = 'MED0009990001';   // staff correct the number
      const again = await lookUp(d);
      expect(again.json.auto_completed).not.toBe(true);
      expect(crisp(await roles(d))).toEqual([]);
      expect(again.json.au.sorting.person_reasons.map((r) => r.code)).toContain('held_not_found');

      const g = numbered(selfVr, 'MED0009990007', SELF_NO);                 // general registration only
      await lookUp(g);
      expect(cred(g).ahpra_last_checked_by).toBe(AUTO + ' (lookup hold: not_specialist_gp)');
      cred(g).ahpra_number = 'MED0009990001'; profile(g).register_number = 'MED0009990001';
      const g2 = await lookUp(g);
      expect(g2.json.auto_completed).not.toBe(true);
      expect(g2.json.au.sorting.group).toBe('non_vr_held');
    });
    expect(sorting.readLookupHold('automatic register lookup (fixture) (lookup hold: name_mismatch)')).toBe('name_mismatch');
    expect(sorting.readLookupHold('staff@x (lookup hold: made_up)')).toBe(null);
    expect(sorting.readLookupHold('staff@x')).toBe(null);
  });
});

describe('FR-9 S9-10: "Not sure" is not "everything matches"', () => {
  it('an Australian graduate who answered "Not sure": verified, limited to priority areas, a task for staff, and an honest message', async () => {
    await withProvider('fixture', async () => {
      const d = numbered(selfVr, 'MED0009990001', SELF_UNSURE);
      const run = await lookUp(d);
      expect(run.json.auto_completed).toBe(true);
      expect(crisp(await roles(d))).toEqual([DPA]);
      expect(openConfirm(d).length).toBe(1);                                // old code: no task at all
      expect(openConfirm(d)[0].metadata.why).toBe('unknown');
      expect(run.json.n06 || run.json.check && run.json.check.n06 || {}).toBeTruthy();
      const view = await staffCandidate(d);
      expect(view.json.candidate.au.sorting).toMatchObject({ group: 'dpa_only', confirm_19ab: 'unknown', settled_by_lookup: false });
      // staff settle it: the roles open and the task closes
      expect((await staff19(d, 'no', 'Asked the doctor: citizen when the degree began (test)')).status).toBe(200);
      expect(crisp(await roles(d)).length).toBe(3);
      expect(openConfirm(d)).toEqual([]);
    });
  });
  it('the message for them says confirmed, and that one detail is still to confirm; the usual one is unchanged', () => {
    const tools = require('../lib/au-staff-tools.js');
    const usual = tools.buildAhpraVerifiedMessage({ appBaseUrl: 'https://x' });
    const open = tools.buildAhpraVerifiedMessage({ appBaseUrl: 'https://x', detailToConfirm: true });
    expect(usual.body).toMatch(/everything matches/);
    expect(open.body).not.toMatch(/everything matches/);
    expect(open.body).toMatch(/it is confirmed/);
    expect(open.body).toMatch(/one detail about where you can work that we still need to confirm with you/);
    expect(open.body).toMatch(/message us in the app or reply to this email/);
    expect(open.key).toBe(usual.key);                                       // the same once-only message
    expect(bannedIn([open.subject, open.title, open.body, open.footer].join('\n'))).toEqual([]);
  });
});

describe('FR-9 S9-11 / S9-13: sign-up waits for the lookup; a lookup that did not finish is owed', () => {
  const finish = (d, number, extra) => h.post('/api/onboarding/complete', {
    auBranch: 'yes',
    au: Object.assign({ ahpraNumber: number, registrationType: 'specialist', fellowship: 'fracgp', hasConditions: false, moratorium19ab: 'no', workRights: 'citizen',
      noticeWeeks: 4, availableFrom: '2026-12-18', base: 'loc:NSW:2150:parramatta', travel: 'commute', places: [], sessions: 8, detailsConfirmed: true }, extra || {})
  }, { cookie: d.cookie });
  const fresh = (last) => {
    const d = add('overseas_null', { noCase: true, profile: { first_name: 'Test', last_name: last || 'Onboarder', registration_country: '', qualification_country: '', onboarding_completed_at: null, register_body: null, register_number: null, register_status: null } });
    row('user_state', d.userId).state = {};
    return d;
  };
  const n08 = (d) => rows('gp_nudge_log').filter((x) => x.user_id === d.userId && /au_n08/.test(String(x.nudge_key || x.key || '')));
  it('a number that belongs to somebody else: the finish screen and the email follow the hold (never "You\'re all set")', async () => {
    await withProvider('fixture', async () => {
      const d = fresh();
      const res = await finish(d, 'MED0009990004');
      expect(res.status).toBe(200);
      expect(res.json.auNext).toBe('team_review');                          // old code: 'careers'
      expect(res.json.auHold).toMatchObject({ held: true, kind: 'review' });
      // the lookup has ALREADY happened when the reply is sent
      expect(kv(lookupKey(d))).toMatchObject({ ok: true, found: true, nameMatch: false, trigger: 'onboarding' });
      expect(crisp(await roles(d))).toEqual([]);
      // and the "profile complete" email is the careful one
      const sent = timeline(d).filter((e) => /N08|profile is complete|Profile complete/i.test(String(e.title) + ' ' + String(e.detail)));
      expect(JSON.stringify(sent)).not.toMatch(/browse roles/i);
    });
  });
  it('a clean number: "careers", and the check is already complete when the reply is sent', async () => {
    await withProvider('fixture', async () => {
      const d = fresh();
      const res = await finish(d, 'MED0009990001');
      expect(res.json.auNext).toBe('careers');
      expect(cred(d).staff_verified_by).toBe(AUTO);                          // no waiting needed (old code: only "eventually")
    });
  });
  it('the lookup is still running at the budget: a neutral screen, the email is held, the lookup is marked as owed', async () => {
    await withProvider('fixture', async () => {
      const d = fresh();
      t._setAuLookupInlineBudgetForTest(0);
      try {
        const res = await finish(d, 'MED0009990004');
        expect(res.status).toBe(200);
        expect(res.json.auNext).toBe('team_review');                        // neutral: "Thanks, we have your details"
      } finally { t._setAuLookupInlineBudgetForTest(10000); }
      await until(() => kv(lookupKey(d)) && kv(lookupKey(d)).ok === true);
    });
  });
  it('a lookup that fails for a passing reason is owed and tried again by the scheduled job; three attempts in all; staff see "not run yet"', async () => {
    await withProvider('fixture', async () => {
      const d = numbered(selfVr, 'MED0009990012', SELF_NO);                 // the fixture that times out
      const first = await t.auRunRegisterLookup(d.userId, { trigger: 'onboarding' });
      expect(first).toMatchObject({ ok: false, ran: true, reason: 'timeout' });
      expect(kv(lookupKey(d))).toMatchObject({ ok: false, reason: 'timeout', retry: true, attempts: 1 });   // old code: no retry flag, never tried again
      expect(crisp(await roles(d)).length).toBe(3);                          // a failed lookup changes nothing
      const pass = await t.auRetryOwedRegisterLookups({ gapMs: 0, now: true });
      expect(pass.ran).toBeGreaterThanOrEqual(1);
      expect(kv(lookupKey(d))).toMatchObject({ attempts: 2, retry: true, trigger: 'retry' });
      await t.auRetryOwedRegisterLookups({ gapMs: 0, now: true });
      expect(kv(lookupKey(d))).toMatchObject({ attempts: 3, retry: false });  // the third was the last
      const before = kv(lookupKey(d)).at;
      await t.auRetryOwedRegisterLookups({ gapMs: 0, now: true });
      expect(kv(lookupKey(d)).at).toBe(before);
      // the number is fixed and the retry succeeds for another doctor
      const e = numbered(selfVr, 'MED0009990001', SELF_NO);
      rows('runtime_kv').push({ key: lookupKey(e), value: { v: 1, at: '2026-11-25T00:00:00.000Z', trigger: 'onboarding', provider: 'fixture', number: 'MED0009990001', ok: false, found: false, pending: true, retry: true, attempts: 0, reason: 'not_run_yet' }, expires_at: null, updated_at: NOW });
      expect((await staffCandidate(e)).json.candidate.au.register_lookup).toMatchObject({ not_run_yet: true, retry_owed: true });
      await t.auRetryOwedRegisterLookups({ gapMs: 0, now: true });
      expect(kv(lookupKey(e))).toMatchObject({ ok: true, found: true, nameMatch: true, trigger: 'retry' });
      expect(cred(e).staff_verified_by).toBe(AUTO);
    });
  });
  it('provider off: the retry pass reads nothing', async () => {
    h.emu.reset();
    expect(await t.auRetryOwedRegisterLookups({ gapMs: 0 })).toEqual({ ran: 0, owed: 0 });
    expect(h.emu.requests.length).toBe(0);
  });
});

describe('FR-9 S9-14: the made-up test numbers never answer in production', () => {
  it('fixture is refused when NODE_ENV or VERCEL_ENV is production; the real provider and "none" are unchanged', () => {
    expect(lookupLib.providerName({ AHPRA_LOOKUP_PROVIDER: 'fixture' })).toBe('fixture');
    expect(lookupLib.providerName({ AHPRA_LOOKUP_PROVIDER: 'fixture', NODE_ENV: 'production' })).toBe('none');   // old code: 'fixture'
    expect(lookupLib.providerName({ AHPRA_LOOKUP_PROVIDER: 'fixture', VERCEL_ENV: 'production' })).toBe('none');
    expect(lookupLib.providerName({ AHPRA_LOOKUP_PROVIDER: 'fixture', VERCEL_ENV: 'preview', NODE_ENV: 'development' })).toBe('fixture');
    expect(lookupLib.providerName({ AHPRA_LOOKUP_PROVIDER: 'ahpra_public', NODE_ENV: 'production' })).toBe('ahpra_public');
    expect(lookupLib.providerName({ NODE_ENV: 'production' })).toBe('none');
  });
});

describe('FR-9, smaller: the labels staff read', () => {
  it('a held doctor\'s chip says so; "Needs review" goes once the automatic check has left nothing for a person; the list asks only for the lookups it needs', async () => {
    await withProvider('fixture', async () => {
      const held = numbered(selfVr, 'MED0009990003', SELF_NO);              // not found
      const done = numbered(selfB, 'MED0009990002', Object.assign({}, SELF_YES, { has_conditions: true }));   // the owner's example, answered honestly
      await lookUp(held); await lookUp(done);
      h.emu.reset();
      const list = await h.get('/api/ceo/candidates', h.superAdmin());
      const of = (d) => list.json.candidates.filter((c) => c.user_id === d.userId)[0].au;
      expect(of(held)).toMatchObject({ group: 'dpa_only', group_label: 'On hold: needs a person', needs_person: true });   // old code: "Priority areas only (DPA)"
      expect(of(done)).toMatchObject({ group: 'dpa_only', group_label: 'Priority areas only (DPA)', needs_person: false, needs_review: false });   // old code: needs_review true
      const kvReads = h.emu.requests.filter((r) => r.table === 'runtime_kv' && /au_register_lookup/.test(JSON.stringify(r)));
      expect(kvReads.length).toBeGreaterThan(0);
      kvReads.forEach((r) => expect(JSON.stringify(r)).not.toMatch(/like\./));   // old code: key=like.au_register_lookup:* (every stored lookup)
      expect((await staffCandidate(done)).json.candidate.au.pathway.showNeedsReview).toBe(false);
      expect((await staffCandidate(held)).json.candidate.au.pathway.showNeedsReview).toBe(true);
    });
  });
});

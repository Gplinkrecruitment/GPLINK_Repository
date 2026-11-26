// Australian GP build, WP-06: the staff tools, end to end against the real
// server and the in-memory database stub. Both states of AU_PATHWAY_ENABLED.
//
//   A. POST /api/ats/candidate: account + profile + case + pathway + ownership
//      + invite + audit in one call; duplicate email; who may call it; rollback.
//   B. The Ahpra register check: credentials, pathway confirmation, 19AB and
//      the DPA flag, N06 (verified / not matched, once only), N07 on conditions.
//   C. The ahpra_register_check task: raised on onboarding completion and on
//      staff create, one open task per doctor, closed by the check.
//   D. register-auto-verify never attempts an Ahpra row; the yearly re-check.
//   E. Ownership; consultant read access to an Australian case's tasks; the
//      eligibility waitlist list and release; pathway chip and filter.
//   F. Carry-over fixes F1 (switch-off never overwrites an Australian stage),
//      F2 (altered URL), F3 (stale stage in the response).
//   Overseas parity: nothing recorded (switch on) and every doctor (switch off).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { wp02NewNameViolation } = require('./helpers/au-supabase-emulator.js');
const {
  buildAuDoctor, buildAuFixtureDb, WP02_NEW_COLUMN_NAMES, WP02_NEW_TABLES,
  wp03NewStageViolation, wp06NewNameViolation
} = require('./helpers/au-fixtures.js');

const NAMES = { columns: WP02_NEW_COLUMN_NAMES, tables: WP02_NEW_TABLES };
const EMPTY_TABLES = ['registration_tasks', 'task_timeline', 'gp_applications', 'placements', 'user_documents',
  'admin_audit_log', 'candidate_leads', 'onboarding_reminders', 'pep_waitlist', 'runtime_kv', 'rate_limits',
  'gp_nudge_log', 'password_setup_tokens', 'user_roles', 'career_roles'];
// AGENT-RULES section 4.
const BANNED = /MyIntealth|\bAMC\b|\bEPIC\b|\bvisa\b|relocat|your move|overseas|internationally trained|\bGMC\b|\bSPPA\b|Section G|supervisor CV|Not yet eligible|AHPRA/;

let h, t;
let seq = 0;
const resendCalls = [];

const rows = (table) => h.emu.table(table);
const row = (table, userId) => rows(table).filter((r) => r.user_id === userId)[0] || null;
const caseOf = (userId) => row('registration_cases', userId);
const tasksOf = (userId, type) => {
  const c = caseOf(userId);
  return rows('registration_tasks').filter((x) => c && x.case_id === c.id && (!type || x.task_type === type));
};
const openTasks = (userId, type) => tasksOf(userId, type).filter((x) => x.status !== 'completed' && x.status !== 'cancelled');
const mailsTo = (email) => resendCalls.filter((c) => [].concat(c.body && c.body.to).indexOf(email) !== -1).map((c) => c.body);
const bell = (userId) => {
  const st = row('user_state', userId);
  const list = st && st.state && st.state.gp_link_updates;
  return Array.isArray(list) ? list : [];
};
const cron = (path) => h.get(path, { headers: { Authorization: 'Bearer test-cron-secret' } });

function add(kind, overrides) {
  seq += 1;
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: 's' + seq }, overrides || {}));
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}

// An Australian doctor exactly as the onboarding branch leaves them: pathway
// self-declared, register number pending, credentials self-declared.
function selfDeclaredAu(extra) {
  const o = extra || {};
  return add('au_vr', Object.assign({
    selfDeclared: true,
    profile: Object.assign({ register_body: 'ahpra', register_number: 'MED0001234567', register_status: 'pending_verification', register_verified_at: null, register_verified_by: null }, o.profile || {}),
    credentials: Object.assign({
      ahpra_number: 'MED0001234567', ahpra_registration_type: 'specialist', specialist_gp: true, fellowship_type: 'fracgp',
      vr_status: 'vr', work_rights: 'citizen', has_conditions: false, has_undertakings: null, has_notations: null,
      moratorium_19ab_status: 'no', moratorium_19ab_confirmed_status: null, moratorium_19ab_confirmed_by: null,
      moratorium_19ab_confirmed_at: null, staff_verified_at: null, staff_verified_by: null,
      ahpra_last_checked_at: null, ahpra_last_checked_by: null, registration_expiry: null
    }, o.credentials || {})
  }, o.rest || {}));
}

// FR-1 (R-05): a check saved as verified now carries a deliberate 19AB answer.
// 'unconfirmed' is "not confirmed yet": stored as no confirmation, which is
// what this fixture meant before the answer became required.
const VERIFIED = {
  action: 'ahpra_check', outcome: 'verified', registration_type: 'specialist', specialist_gp: true,
  has_conditions: false, has_undertakings: false, has_notations: false, registration_expiry: '2027-09-30',
  moratorium_19ab_confirmed: 'unconfirmed',
  // FR-2 (S2-05), deliberate: a check that confirms a VR GP must carry the
  // fellowship, the right to work and the supervision staff saw (they were
  // optional, so a confirmed VR GP could rest on things staff never entered).
  fellowship_type: 'fracgp', work_rights: 'citizen', supervision_level: 'none'
};
const check = (d, body, who) => h.post('/api/ats/candidate/register-verification',
  Object.assign({ userId: d.userId }, body), who || h.consultant());

function auOnboardingBody(over) {
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
      locations: ['Sydney'], suburb: 'Parramatta', state: 'NSW', postcode: '2150', sessions: 8, detailsConfirmed: true
    }, over || {})
  };
}

function freshSignup() {
  seq += 1;
  const d = buildAuDoctor('overseas_null', {
    idSuffix: 'n' + seq, noCase: true,
    profile: {
      registration_country: '', qualification_country: '', preferred_city: '', target_arrival_date: '', who_moving: '',
      children_count: '', gmc_number: '', register_body: null, register_number: null, register_status: null, onboarding_completed_at: null
    }
  });
  d.state.state = {};
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}

beforeAll(async () => {
  const tables = buildAuFixtureDb([]);
  EMPTY_TABLES.forEach((name) => { tables[name] = []; });
  h = await bootAuTestServer({ name: 'wp06', tables, emulator: { auth: true } });
  t = h.testUtils;
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
  process.env.RESEND_API_KEY = 'test-key';
  delete process.env.LAUNCH_DEFAULT_RSO_EMAIL;
  h.emu.reset();
  h.emu.forbid(null);
  h.emu.missingColumns = {};
  h.emu.missingTables = new Set();
  h.emu.failTables = {};
  h.emu.authFail = {};
  h.emu.authRequests.length = 0;
  resendCalls.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
describe('A. POST /api/ats/candidate (ADM-02)', () => {
  const body = (over) => Object.assign({
    first_name: 'Test', last_name: 'Auvrstaff', email: 'au.staff.' + (++seq) + '@gplink-test.local', phone: '+61 400 000 111',
    pathway: 'au_vr', ahpra_number: 'med0001234567', state: 'NSW', notes: 'Met at a conference (FAKE).'
  }, over || {});

  it('a consultant creates an Australian candidate: account, profile, case, pathway, ownership, task, invite, audit', async () => {
    const b = body();
    const res = await h.post('/api/ats/candidate', b, h.consultant());
    expect(res.status).toBe(201);
    const userId = res.json.user_id;
    expect(res.json).toMatchObject({
      ok: true, pathway: 'au_vr', pathway_confirmed: false, case_stage: 'placement',
      placing_consultant: h.CONSULTANT_EMAIL, invite: { sent: true }
    });

    // The sign-in account: created once, confirmed, with NO password.
    const account = h.emu.authUsers.filter((u) => u.email === b.email);
    expect(account.length).toBe(1);
    expect(account[0]).toMatchObject({ id: userId, has_password: false, app_metadata: { created_by_staff: h.CONSULTANT_EMAIL } });

    // The profile: country written explicitly, register number pending.
    const p = row('user_profiles', userId);
    expect(p).toMatchObject({
      email: b.email, first_name: 'Test', last_name: 'Auvrstaff', registration_country: 'Australia', qualification_country: 'AU',
      register_body: 'ahpra', register_number: 'MED0001234567', register_status: 'pending_verification', current_state: 'NSW'
    });
    expect(p.onboarding_completed_at == null).toBe(true);

    // The pathway: SET BY the staff member, NOT confirmed. Creating a candidate
    // does not check the register, so the doctor still needs staff review and
    // is still limited to DPA roles.
    expect(p).toMatchObject({ candidate_pathway: 'au_vr', candidate_basis: 'australia', pathway_set_by: h.CONSULTANT_EMAIL });
    expect(p.pathway_confirmed_at).toBe(null);
    const resolved = await t.resolveCandidatePathway(userId);
    expect(resolved).toMatchObject({ pathway: 'au_vr', isAu: true, confirmed: false, needsStaffReview: true, dpaRestricted: true });
    expect(row('gp_credentials', userId)).toMatchObject({ ahpra_number: 'MED0001234567' });
    expect(row('gp_credentials', userId).staff_verified_at == null).toBe(true);

    // The case: Australian ladder, owned by the placing consultant, no RSO.
    const c = caseOf(userId);
    expect(c).toMatchObject({ id: res.json.case_id, stage: 'placement', pathway: 'au_vr', placing_consultant: h.CONSULTANT_EMAIL });
    expect(c.assigned_va == null && c.assigned_rso == null).toBe(true);

    // One open Ahpra check task.
    const open = openTasks(userId, 'ahpra_register_check');
    expect(open.length).toBe(1);
    expect(open[0]).toMatchObject({ id: res.json.ahpra_check_task_id, source_trigger: 'au_ahpra_check_staff_created', related_stage: 'placement', priority: 'normal' });
    expect(open[0].due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The invite: one email, through the normal sender, set-password link
    // through the existing welcome-setup bridge and its token table.
    const mails = mailsTo(b.email);
    expect(mails.length).toBe(1);
    expect(mails[0].subject).toBe('Set up your GP Link account');
    const token = rows('password_setup_tokens').filter((r) => r.user_id === userId);
    expect(token.length).toBe(1);
    expect(token[0].email).toBe(b.email);
    expect(new Date(token[0].expires_at).getTime()).toBeGreaterThan(Date.now() + 71 * 3600 * 1000);
    expect(mails[0].html).toContain('/api/auth/welcome-setup?token=' + token[0].token);
    expect(mails[0].html).toContain('Welcome to GP Link, Test');
    expect(mails[0].html).toContain('Set my password');
    const visible = mails[0].html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
    expect(visible).not.toMatch(BANNED);

    // The note and the audit row.
    expect(rows('task_timeline').some((e) => e.case_id === c.id && e.event_type === 'note' && /Met at a conference/.test(e.detail))).toBe(true);
    const audit = rows('admin_audit_log').filter((a) => a.action === 'admin_create_candidate');
    expect(audit.length).toBe(1);
    expect(audit[0]).toMatchObject({ target_id: userId });
  });

  it('duplicate email: 409 with the existing candidate id, and never a second account', async () => {
    const b = body();
    const first = await h.post('/api/ats/candidate', b, h.consultant());
    expect(first.status).toBe(201);
    resendCalls.length = 0;
    const again = await h.post('/api/ats/candidate', Object.assign({}, b, { email: b.email.toUpperCase(), first_name: 'Other' }), h.superAdmin());
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ ok: false, code: 'candidate_exists', user_id: first.json.user_id, case_id: first.json.case_id });
    expect(h.emu.authUsers.filter((u) => u.email === b.email).length).toBe(1);
    expect(rows('user_profiles').filter((p) => p.email === b.email).length).toBe(1);
    expect(resendCalls).toEqual([]);
    // An existing doctor who signed up themselves is found the same way.
    const existing = add('overseas_null');
    const dup = await h.post('/api/ats/candidate', body({ email: existing.email }), h.consultant());
    expect(dup.status).toBe(409);
    expect(dup.json.user_id).toBe(existing.userId);
    // An account with no profile behind it is still refused.
    h.emu.authUsers.push({ id: 'orphan-1', email: 'orphan.' + seq + '@gplink-test.local' });
    const orphan = await h.post('/api/ats/candidate', body({ email: 'orphan.' + seq + '@gplink-test.local' }), h.consultant());
    expect(orphan.status).toBe(409);
  });

  it('who may call it', async () => {
    const b = body();
    expect((await h.post('/api/ats/candidate', b)).status).toBe(401);
    const doctor = add('overseas_null');
    expect((await h.post('/api/ats/candidate', b, { cookie: doctor.cookie })).status).toBe(401);
    const rso = await h.post('/api/ats/candidate', b, h.rso());
    expect(rso.status).toBe(403);
    expect(h.emu.authUsers.filter((u) => u.email === b.email)).toEqual([]);
    expect((await h.post('/api/ats/candidate', b, h.superAdmin())).status).toBe(201);
    expect((await h.get('/api/ats/candidate/options', h.rso())).status).toBe(403);
    const options = await h.get('/api/ats/candidate/options', h.consultant());
    expect(options.json.pathways.map((p) => p.value)).toEqual(['overseas_esp', 'overseas_pep', 'au_vr', 'au_restricted', 'au_non_vr', 'au_registrar']);
    expect(options.json.consultants.map((k) => k.email)).toContain(h.CONSULTANT_EMAIL);
  });

  it('validates before anything is created; a staff email is refused; the chosen consultant must be one', async () => {
    const before = h.emu.authUsers.length;
    const bad = await h.post('/api/ats/candidate', { first_name: '', last_name: 'X', email: 'nope', pathway: 'au_everything' }, h.consultant());
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.json.errors).sort()).toEqual(['email', 'first_name', 'pathway']);
    expect((await h.post('/api/ats/candidate', body({ email: h.RSO_EMAIL }), h.consultant())).status).toBe(400);
    expect((await h.post('/api/ats/candidate', body({ consultant: 'someone.else@gplink-test.local' }), h.consultant())).status).toBe(400);
    expect(h.emu.authUsers.length).toBe(before);
    expect(h.emu.requests.filter((r) => r.method === 'POST' && r.table === 'user_profiles')).toEqual([]);
    // A consultant picked in the form (here the CEO) becomes the owner.
    const ok = await h.post('/api/ats/candidate', body({ consultant: h.SUPER_EMAIL }), h.consultant());
    expect(ok.status).toBe(201);
    expect(caseOf(ok.json.user_id).placing_consultant).toBe(h.SUPER_EMAIL);
  });

  it('an overseas candidate: today\'s case, no Australian extras, a neutral invite, and visible in the list', async () => {
    const b = body({ pathway: 'overseas_esp', ahpra_number: '', state: '' });
    const res = await h.post('/api/ats/candidate', b, h.consultant());
    expect(res.status).toBe(201);
    const userId = res.json.user_id;
    expect(res.json).toMatchObject({ pathway: 'overseas_esp', case_stage: 'myintealth', placing_consultant: null, ahpra_check_task_id: null });
    expect(caseOf(userId)).toMatchObject({ stage: 'myintealth' });
    expect(caseOf(userId).placing_consultant == null).toBe(true);
    expect(tasksOf(userId)).toEqual([]);
    expect(row('gp_credentials', userId)).toBe(null);
    expect(row('user_profiles', userId)).toMatchObject({ candidate_pathway: 'overseas_esp', pathway_set_by: h.CONSULTANT_EMAIL, registration_country: '' });
    expect(await t.resolveCandidatePathway(userId)).toMatchObject({ pathway: 'overseas_esp', isAu: false, needsStaffReview: false });
    expect(mailsTo(b.email)[0].html).not.toMatch(/Ahpra/);
    const list = await h.get('/api/ceo/candidates', h.consultant());
    expect(list.json.candidates.map((r) => r.user_id)).toContain(userId);
  });

  it('if the pathway cannot be saved the account is removed again: nothing half-made is left', async () => {
    h.emu.missingColumns = { user_profiles: WP02_NEW_COLUMN_NAMES.slice(), registration_cases: ['pathway', 'placing_consultant'] };
    h.emu.missingTables = new Set(WP02_NEW_TABLES);
    const b = body();
    const res = await h.post('/api/ats/candidate', b, h.consultant());
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('schema_missing');
    expect(h.emu.authUsers.filter((u) => u.email === b.email)).toEqual([]);
    expect(rows('user_profiles').filter((p) => p.email === b.email)).toEqual([]);
    expect(mailsTo(b.email)).toEqual([]);
  });

  it('the invite can be sent again, and a failed send is reported, not hidden', async () => {
    const res = await h.post('/api/ats/candidate', body(), h.consultant());
    const userId = res.json.user_id;
    resendCalls.length = 0;
    const again = await h.post('/api/ats/candidate/invite', { user_id: userId }, h.consultant());
    expect(again.status).toBe(200);
    expect(resendCalls.length).toBe(1);
    expect(rows('password_setup_tokens').filter((r) => r.user_id === userId).length).toBe(2);
    delete process.env.RESEND_API_KEY;
    const unsent = await h.post('/api/ats/candidate/invite', { user_id: userId }, h.consultant());
    expect(unsent.status).toBe(502);
    expect(unsent.json.invite).toMatchObject({ sent: false, reason: 'email_not_configured' });
    expect((await h.post('/api/ats/candidate/invite', { user_id: userId }, h.rso())).status).toBe(403);
  });

  it('SWITCH OFF: the routes do not exist and nothing is asked of the database', async () => {
    h.setSwitch(false);
    h.emu.reset();
    for (const res of [
      await h.post('/api/ats/candidate', body(), h.consultant()),
      await h.post('/api/ats/candidate/invite', { user_id: 'x' }, h.consultant()),
      await h.get('/api/ats/candidate/options', h.consultant()),
      await h.get('/api/ats/candidate/tasks?case_id=x', h.consultant()),
      await h.get('/api/admin/eligibility-waitlist', h.superAdmin())
    ]) {
      expect(res.status).toBe(404);
    }
    expect(h.emu.requests).toEqual([]);
    expect(h.emu.authRequests).toEqual([]);
    expect(resendCalls).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('B. the Ahpra register check (ADM-12, APP-06, DAT-08, COM-11)', () => {
  it('verified, nothing flagged, 19AB "no": credentials, confirmed segment A, DPA flag lifted, task closed, N06 once', async () => {
    const d = selfDeclaredAu();
    await t.auRaiseAhpraCheckTask(d.userId, { reason: 'onboarding_completed' });
    expect(openTasks(d.userId, 'ahpra_register_check').length).toBe(1);
    // WP-29 (deliberate): before the check this doctor's own "19AB does not
    // apply" now opens their OWN view of roles outside a DPA (it was
    // `dpaRestricted: true`). It is marked as their word only, the check is
    // not saved, and so nothing can be sent to a practice yet.
    const beforeCheck = await t.resolveCandidatePathway(d.userId);
    expect(beforeCheck).toMatchObject({ confirmed: false, needsStaffReview: true, dpaRestricted: false, dpaSelfDeclaredOnly: true, dpaRestrictedReason: 'self_declared_no_awaiting_staff_confirmation', staff19ab: 'unconfirmed', checkComplete: false });
    expect(require('../lib/role-eligibility.js').auIntroductionBlock(beforeCheck, { dpa: false, dpa_status: 'no' }, { registerVerified: beforeCheck.checkComplete })).toMatchObject({ code: 'ahpra_check_not_verified' });

    const res = await check(d, Object.assign({}, VERIFIED, { moratorium_19ab_confirmed: 'no', note: 'Trained in Australia as a citizen (FAKE test reason)' }));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      ok: true, outcome: 'verified', register_status: 'verified', tasks_closed: 1, segment_review_task_id: null,
      derived: { pathway: 'au_vr', segment: 'A', launched: true, has_flags: false }
    });

    // gp_credentials, through upsertGpCredentials (source staff, verified stamp).
    const c = row('gp_credentials', d.userId);
    expect(c).toMatchObject({
      ahpra_number: 'MED0001234567', ahpra_registration_type: 'specialist', specialist_gp: true,
      has_conditions: false, has_undertakings: false, has_notations: false, registration_expiry: '2027-09-30',
      ahpra_last_checked_by: h.CONSULTANT_EMAIL, staff_verified_by: h.CONSULTANT_EMAIL,
      moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: h.CONSULTANT_EMAIL
    });
    expect(c.ahpra_last_checked_at && c.staff_verified_at && c.moratorium_19ab_confirmed_at).toBeTruthy();
    expect(row('user_profiles', d.userId)).toMatchObject({ register_status: 'verified', register_verified_by: h.CONSULTANT_EMAIL, candidate_pathway: 'au_vr', pathway_confirmed_by: h.CONSULTANT_EMAIL });

    // The pathway is staff-confirmed, and the DPA restriction is now lifted on
    // STAFF's answer (WP-29, deliberate: it is no longer "the only thing that
    // lifted it" for the doctor's own view, but it is the only thing that lets
    // a practice introduction outside a DPA go ahead).
    const after = await t.resolveCandidatePathway(d.userId);
    expect(after).toMatchObject({ pathway: 'au_vr', confirmed: true, needsStaffReview: false, dpaRestricted: false, dpaRestrictedReason: 'staff_confirmed_19ab_not_applicable', dpaSelfDeclaredOnly: false, staff19ab: 'not_applicable', checkComplete: true });
    expect(require('../lib/role-eligibility.js').auIntroductionBlock(after, { dpa: false, dpa_status: 'no' }, { registerVerified: after.checkComplete })).toBe(null);
    expect(openTasks(d.userId, 'ahpra_register_check')).toEqual([]);
    expect(tasksOf(d.userId, 'ahpra_register_check')[0]).toMatchObject({ status: 'completed', completed_by: h.CONSULTANT_EMAIL });
    expect(tasksOf(d.userId, 'segment_review')).toEqual([]);

    // N06 verified: one email with the jobs call to action, one bell item.
    const mails = mailsTo(d.email);
    expect(mails.length).toBe(1);
    expect(mails[0].subject).toBe('Your Ahpra registration is confirmed');
    expect(mails[0].html).toContain('/pages/career');
    expect(mails[0].html).toContain('See GP roles');
    expect(mails[0].html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ')).not.toMatch(BANNED);
    expect(bell(d.userId).filter((b) => b.title === 'Ahpra registration confirmed').length).toBe(1);
    expect(JSON.stringify(bell(d.userId))).not.toMatch(BANNED);
    expect(rows('gp_nudge_log').filter((n) => n.user_id === d.userId).map((n) => n.channel + ':' + n.nudge_key).sort())
      .toEqual(['bell:au_n06_ahpra_verified', 'email:au_n06_ahpra_verified']);

    // Saving the same check again tells the doctor nothing twice.
    const again = await check(d, Object.assign({}, VERIFIED, { moratorium_19ab_confirmed: 'no', note: 'Trained in Australia as a citizen (FAKE test reason)' }));
    expect(again.status).toBe(200);
    expect(again.json.n06).toMatchObject({ email: { sent: false, reason: 'already_sent' }, bell: { sent: false, reason: 'already_sent' } });
    expect(mailsTo(d.email).length).toBe(1);
    expect(bell(d.userId).filter((b) => b.title === 'Ahpra registration confirmed').length).toBe(1);
    expect(rows('admin_audit_log').filter((a) => a.action === 'admin_ahpra_register_check' && a.target_id === d.userId).length).toBe(2);
  });

  // WP-29 (deliberate): was "...the doctor is verified but stays limited to DPA
  // roles". With no STAFF 19AB answer the doctor's own answer now decides what
  // the doctor sees: "no" opens their own view (and still cannot be introduced
  // outside a DPA); "not sure" stays limited to DPA roles, as before.
  it('without a staff 19AB answer the doctor is verified and their own answer decides their view ("not sure" stays DPA only; "no" is never enough for an introduction); confirming it later flips the flag', async () => {
    const intro = require('../lib/role-eligibility.js').auIntroductionBlock;
    const unsure = selfDeclaredAu({ credentials: { moratorium_19ab_status: 'unsure' } });
    expect((await check(unsure, VERIFIED)).status).toBe(200);
    const unsureAfter = await t.resolveCandidatePathway(unsure.userId);
    expect(unsureAfter).toMatchObject({ pathway: 'au_vr', confirmed: true, dpaRestricted: true, dpaRestrictedReason: '19ab_unknown', dpaSelfDeclaredOnly: false, checkComplete: true });
    expect(intro(unsureAfter, { dpa: false, dpa_status: 'no' }, { registerVerified: true })).toMatchObject({ code: '19ab_not_confirmed' });

    const d = selfDeclaredAu();
    const res = await check(d, VERIFIED);
    expect(res.status).toBe(200);
    const ownWord = await t.resolveCandidatePathway(d.userId);
    expect(ownWord).toMatchObject({ pathway: 'au_vr', confirmed: true, dpaRestricted: false, dpaRestrictedReason: 'self_declared_no_awaiting_staff_confirmation', dpaSelfDeclaredOnly: true, staff19ab: 'unconfirmed', checkComplete: true });
    expect(intro(ownWord, { dpa: false, dpa_status: 'no' }, { registerVerified: true })).toMatchObject({ code: '19ab_not_confirmed' });
    expect(intro(ownWord, { dpa: true, dpa_status: 'yes' }, { registerVerified: true })).toBe(null);
    const yes = await check(d, Object.assign({}, VERIFIED, { moratorium_19ab_confirmed: 'yes' }));
    expect(yes.json.derived).toMatchObject({ pathway: 'au_restricted', segment: 'B' });
    expect(await t.resolveCandidatePathway(d.userId)).toMatchObject({ pathway: 'au_restricted', dpaRestricted: true, dpaRestrictedReason: 'staff_confirmed_19ab_applies' });
    // FR-2 (R2-02), deliberate: the "yes" above opened a segment review. A
    // later check cannot end in a confirmed VR GP while it is open unless the
    // person resolves it in the same action.
    const blocked = await check(d, Object.assign({}, VERIFIED, { moratorium_19ab_confirmed: 'no', note: 'Trained in Australia as a citizen (FAKE test reason)' }));
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe('segment_review_must_be_resolved');
    expect((await t.resolveCandidatePathway(d.userId)).pathway).toBe('au_restricted');
    const no = await check(d, Object.assign({}, VERIFIED, { moratorium_19ab_confirmed: 'no', resolve_segment_review: true, note: 'Trained in Australia as a citizen (FAKE test reason)' }));
    expect(no.json.derived).toMatchObject({ pathway: 'au_vr' });
    expect(openTasks(d.userId, 'segment_review')).toEqual([]);
    expect((await t.resolveCandidatePathway(d.userId)).dpaRestricted).toBe(false);
  });

  it('N07: conditions found -> segment B, a staff task to decide, and the doctor is told nothing', async () => {
    const d = selfDeclaredAu();
    await t.auRaiseAhpraCheckTask(d.userId, { reason: 'onboarding_completed' });
    const res = await check(d, Object.assign({}, VERIFIED, { has_conditions: true, conditions_text: 'Must practise under supervision (FAKE).', moratorium_19ab_confirmed: 'no', note: 'Trained in Australia as a citizen (FAKE test reason)' }), h.superAdmin());
    expect(res.status).toBe(200);
    expect(res.json.derived).toMatchObject({ pathway: 'au_restricted', segment: 'B', launched: false, has_flags: true });
    expect(res.json.n06).toBe(null);
    expect(row('gp_credentials', d.userId)).toMatchObject({ has_conditions: true, conditions_text: 'Must practise under supervision (FAKE).' });

    const review = openTasks(d.userId, 'segment_review');
    expect(review.length).toBe(1);
    expect(review[0]).toMatchObject({ id: res.json.segment_review_task_id, priority: 'high', source_trigger: 'au_segment_review' });
    expect(review[0].description).toMatch(/condition, undertaking or notation/);
    expect(openTasks(d.userId, 'ahpra_register_check')).toEqual([]);

    // The doctor: no email, no bell item, and the app is told "not launched",
    // which is what holds them on the "our team will confirm" screen.
    expect(mailsTo(d.email)).toEqual([]);
    expect(bell(d.userId)).toEqual([]);
    const session = await h.get('/api/auth/session', { cookie: d.cookie });
    expect(session.json.auPathway).toEqual({ pathway: 'au_restricted', segment: 'B', isAu: true, launched: false });
    expect(JSON.stringify(session.json)).not.toMatch(/condition|supervis|needsStaffReview/i);
    expect(await t.resolveCandidatePathway(d.userId)).toMatchObject({ confirmed: true, needsStaffReview: true });

    // Saving again does not open a second task.
    await check(d, Object.assign({}, VERIFIED, { has_conditions: true, conditions_text: 'Must practise under supervision (FAKE).' }));
    expect(openTasks(d.userId, 'segment_review').length).toBe(1);

    // A person decides: setting the pathway by hand closes the review task.
    const decide = await h.post('/api/admin/candidate/pathway', { user_id: d.userId, pathway: 'au_restricted' }, h.superAdmin());
    expect(decide.status).toBe(200);
    expect(openTasks(d.userId, 'segment_review')).toEqual([]);
    expect(mailsTo(d.email)).toEqual([]);
  });

  it('undertakings or notations alone are flags too; an outcome of C raises the task with nothing flagged', async () => {
    const flagged = selfDeclaredAu();
    const res = await check(flagged, Object.assign({}, VERIFIED, { has_notations: true, notations_text: 'A notation (FAKE).' }));
    expect(res.json.derived).toMatchObject({ pathway: 'au_restricted', has_flags: true });
    expect(openTasks(flagged.userId, 'segment_review').length).toBe(1);
    const nonVr = selfDeclaredAu({ credentials: { fellowship_type: 'none' } });
    const c = await check(nonVr, Object.assign({}, VERIFIED, { registration_type: 'general', specialist_gp: false }));
    expect(c.json.derived).toMatchObject({ pathway: 'au_non_vr', segment: 'C', has_flags: false });
    expect(openTasks(nonVr.userId, 'segment_review').length).toBe(1);
    expect(mailsTo(nonVr.email)).toEqual([]);
  });

  it('number not matched: mismatch, nothing confirmed stands, the task closes, N06 asks the doctor to check (once per number)', async () => {
    const d = selfDeclaredAu();
    await check(d, Object.assign({}, VERIFIED, { moratorium_19ab_confirmed: 'no', note: 'Trained in Australia as a citizen (FAKE test reason)' }));
    await t.auRaiseAhpraCheckTask(d.userId, { reason: 'annual_recheck' });
    resendCalls.length = 0;
    const res = await check(d, { action: 'ahpra_check', outcome: 'not_matched', note: 'Different name on the register.' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ outcome: 'not_matched', register_status: 'mismatch', tasks_closed: 1 });
    expect(row('user_profiles', d.userId)).toMatchObject({ register_status: 'mismatch', candidate_pathway: 'au_vr', pathway_confirmed_at: null });
    const c = row('gp_credentials', d.userId);
    expect(c.staff_verified_at).toBe(null);
    expect(c.moratorium_19ab_confirmed_status).toBe(null);
    expect(c.ahpra_last_checked_at).toBeTruthy();
    // Fail closed: back to needing review, with NOTHING staff established left
    // standing (the pathway confirmation, the staff 19AB answer and the saved
    // check are all withdrawn), so no practice introduction can be made.
    // WP-29 (deliberate): STILL limited to DPA roles, as before, though for a
    // new reason. The doctor's own "no" would now open their own view, so a
    // check that a person finished without verifying is itself what limits
    // them (the sorting rule's `last_check_not_verified`), until a check is
    // saved as verified.
    const unmatched = await t.resolveCandidatePathway(d.userId);
    expect(unmatched).toMatchObject({ confirmed: false, needsStaffReview: true, staff19ab: 'unconfirmed', checkComplete: false, dpaSelfDeclaredOnly: false, dpaRestricted: true });
    expect(unmatched.sorting.personReasons.map((r) => r.code)).toContain('last_check_not_verified');
    expect(unmatched.sorting.group).toBe('dpa_only');
    for (const role of [{ dpa: false, dpa_status: 'no' }, { dpa: true, dpa_status: 'yes' }]) {
      expect(require('../lib/role-eligibility.js').auIntroductionBlock(unmatched, role, { registerVerified: unmatched.checkComplete })).toMatchObject({ code: 'ahpra_check_not_verified' });
    }

    const mails = mailsTo(d.email);
    expect(mails.length).toBe(1);
    expect(mails[0].subject).toBe('We could not match your Ahpra number');
    expect(mails[0].html).toContain('could not match it to your name');
    expect(mails[0].html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ')).not.toMatch(BANNED);
    expect(bell(d.userId).filter((b) => b.title === 'Please check your Ahpra number').length).toBe(1);

    // The same number again: nothing more is sent.
    await check(d, { action: 'ahpra_check', outcome: 'not_matched' });
    expect(mailsTo(d.email).length).toBe(1);

    // Staff correct the number: back to pending, a new check task, and a
    // different number that still does not match IS news.
    const fix = await check(d, { action: 'update_number', registerNumber: 'MED0007654321' });
    expect(fix.status).toBe(200);
    expect(row('user_profiles', d.userId)).toMatchObject({ register_number: 'MED0007654321', register_status: 'pending_verification' });
    expect(row('gp_credentials', d.userId).ahpra_number).toBe('MED0007654321');
    expect(openTasks(d.userId, 'ahpra_register_check').length).toBe(1);
    expect(openTasks(d.userId, 'ahpra_register_check')[0].source_trigger).toBe('au_ahpra_check_number_changed');
    await check(d, { action: 'ahpra_check', outcome: 'not_matched' });
    expect(mailsTo(d.email).length).toBe(2);
  });

  it('pending saves what was found and changes nothing else', async () => {
    const d = selfDeclaredAu();
    await t.auRaiseAhpraCheckTask(d.userId, { reason: 'onboarding_completed' });
    const res = await check(d, { action: 'ahpra_check', outcome: 'pending', registration_type: 'general_and_specialist' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ outcome: 'pending', register_status: 'pending_verification', tasks_closed: 0 });
    expect(row('gp_credentials', d.userId)).toMatchObject({ ahpra_registration_type: 'general_and_specialist', staff_verified_at: null, ahpra_last_checked_at: null });
    expect(row('user_profiles', d.userId)).toMatchObject({ register_status: 'pending_verification', pathway_confirmed_at: null });
    expect(openTasks(d.userId, 'ahpra_register_check').length).toBe(1);
    expect(mailsTo(d.email)).toEqual([]);
  });

  it('refuses a bad check before writing, an overseas doctor, and roles that may not', async () => {
    const d = selfDeclaredAu();
    h.emu.reset();
    const bad = await check(d, { action: 'ahpra_check', outcome: 'verified', registration_type: 'specialist' });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('invalid_check');
    expect(h.emu.requests.filter((r) => r.method !== 'GET' && r.table !== 'admin_audit_log')).toEqual([]);
    const overseas = add('overseas_null', { profile: { register_body: 'gmc', register_number: '7654321', register_status: 'pending_verification' } });
    const refused = await check(overseas, VERIFIED);
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('not_au_pathway');
    expect(row('gp_credentials', overseas.userId)).toBe(null);
    expect((await check(d, VERIFIED, h.rso())).status).toBe(403);
    expect((await check(d, VERIFIED, { cookie: d.cookie })).status).toBe(401);
    // No number anywhere: asked for it.
    const noNumber = selfDeclaredAu({ profile: { register_body: null, register_number: null, register_status: null }, credentials: { ahpra_number: null } });
    expect((await check(noNumber, VERIFIED)).status).toBe(400);
    expect((await check(noNumber, Object.assign({}, VERIFIED, { ahpra_number: 'MED0005556667' }))).status).toBe(200);
    expect(row('user_profiles', noNumber.userId)).toMatchObject({ register_body: 'ahpra', register_number: 'MED0005556667', register_status: 'verified' });
  });

  it('the one-click stamps: refused for an Australian doctor, unchanged for an overseas doctor', async () => {
    const au = selfDeclaredAu();
    for (const action of ['verified', 'mismatch']) {
      const res = await check(au, { action });
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('use_ahpra_check');
    }
    expect(row('user_profiles', au.userId).register_status).toBe('pending_verification');
    const overseas = add('overseas_null', { profile: { register_body: 'gmc', register_number: '7654321', register_status: 'pending_verification' } });
    const res = await check(overseas, { action: 'verified' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.json).sort()).toEqual(['ok', 'register_status', 'register_verified_at']);
    expect(row('user_profiles', overseas.userId)).toMatchObject({ register_status: 'verified', register_verified_by: h.CONSULTANT_EMAIL });
    expect(row('gp_credentials', overseas.userId)).toBe(null);
    expect(tasksOf(overseas.userId)).toEqual([]);
  });

  it('SWITCH OFF: "ahpra_check" is not an action, exactly like any unknown action on main', async () => {
    const d = selfDeclaredAu();
    h.setSwitch(false);
    h.emu.reset();
    const res = await check(d, VERIFIED);
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ ok: false, message: 'userId and action (verified | mismatch | auto | update_number) are required.' });
    expect(h.emu.requests).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('C. the ahpra_register_check task', () => {
  it('is raised when an Australian doctor finishes onboarding, once, and the default RSO is taken off the case', async () => {
    process.env.LAUNCH_DEFAULT_RSO_EMAIL = h.RSO_EMAIL;
    const d = freshSignup();
    // The account was made before the pathway was known: today's case, default RSO.
    const first = await t._ensureRegCase(d.userId);
    expect(first).toMatchObject({ stage: 'myintealth', assigned_va: h.RSO_USER_ID, assigned_rso: h.RSO_USER_ID });

    const res = await h.post('/api/onboarding/complete', auOnboardingBody(), { cookie: d.cookie });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ auPathway: { pathway: 'au_vr' }, auCaseStage: 'placement', auStaffFlagged: true });
    const open = openTasks(d.userId, 'ahpra_register_check');
    expect(open.length).toBe(1);
    expect(open[0]).toMatchObject({ source_trigger: 'au_ahpra_check_onboarding_completed', related_stage: 'placement' });
    // ADM-09: no RSO before pre-start; nobody recorded as consultant on a self sign-up.
    const c = caseOf(d.userId);
    expect(c.assigned_va == null && c.assigned_rso == null).toBe(true);
    expect(c.placing_consultant == null).toBe(true);
    // Changed deliberately by WP-17 (N08): the doctor is sent the Australian
    // "profile complete" email, and nothing else (no result of a check that
    // has not been done).
    expect(mailsTo(d.email).map((m) => m.subject)).toEqual(['Your profile is complete: we are lining up matches']);

    // Finishing again (a retry, a second device) opens nothing twice.
    const again = await h.post('/api/onboarding/complete', auOnboardingBody(), { cookie: d.cookie });
    expect(again.status).toBe(200);
    expect(tasksOf(d.userId, 'ahpra_register_check').length).toBe(1);
  });

  it('a doctor in segment B or C gets the same task; an overseas completion gets none', async () => {
    const b = freshSignup();
    const res = await h.post('/api/onboarding/complete', auOnboardingBody({ hasConditions: true, conditionsDetail: 'A condition (FAKE).' }), { cookie: b.cookie });
    expect(res.json.auPathway.pathway).toBe('au_restricted');
    expect(openTasks(b.userId, 'ahpra_register_check').length).toBe(1);
    expect(await t.onAuOnboardingCompleted(add('overseas_null').userId, { pathway: 'overseas_esp', isAu: false })).toEqual({ handled: false, needsStaffReview: false });
  });

  it('one open task per doctor, whoever asks; it closes on the check and can be raised again afterwards', async () => {
    const d = selfDeclaredAu();
    const a = await t.auRaiseAhpraCheckTask(d.userId, { reason: 'staff_created' });
    const b = await t.auRaiseAhpraCheckTask(d.userId, { reason: 'onboarding_completed' });
    const c = await t.auRaiseAhpraCheckTask(d.userId, { reason: 'annual_recheck' });
    expect(a).toMatchObject({ ok: true, raised: true });
    expect(b).toEqual({ ok: true, raised: false, reason: 'already_open', taskId: a.taskId });
    expect(c.taskId).toBe(a.taskId);
    expect(tasksOf(d.userId, 'ahpra_register_check').length).toBe(1);
    // A task a person parked ("waiting on the GP") still counts as open.
    tasksOf(d.userId, 'ahpra_register_check')[0].status = 'waiting_on_gp';
    expect((await t.auRaiseAhpraCheckTask(d.userId, { reason: 'annual_recheck' })).reason).toBe('already_open');
    await check(d, VERIFIED);
    expect(openTasks(d.userId, 'ahpra_register_check')).toEqual([]);
    expect((await t.auRaiseAhpraCheckTask(d.userId, { reason: 'annual_recheck' })).raised).toBe(true);
    expect(tasksOf(d.userId, 'ahpra_register_check').length).toBe(2);
  });

  it('never for an overseas doctor, and never with the switch off', async () => {
    const overseas = add('overseas_null');
    expect(await t.auRaiseAhpraCheckTask(overseas.userId, { reason: 'staff_created' })).toEqual({ ok: true, raised: false, reason: 'not_au_pathway' });
    const au = selfDeclaredAu();
    h.setSwitch(false);
    h.emu.reset();
    expect(await t.auRaiseAhpraCheckTask(au.userId, {})).toEqual({ ok: false, raised: false, reason: 'feature_off' });
    expect(await t.auRaiseSegmentReviewTask(au.userId, caseOf(au.userId), {})).toMatchObject({ raised: false, reason: 'feature_off' });
    expect(await t.auNotifyAhpraCheckResult(au.userId, 'verified')).toMatchObject({ email: { sent: false, reason: 'feature_off' }, bell: { sent: false, reason: 'feature_off' } });
    expect(await t.auApplyCaseOwnership(au.userId, { consultant: 'x@gplink-test.local' })).toEqual({ ok: false, reason: 'feature_off' });
    expect(await t.assignRsoForPrestart(caseOf(au.userId).id)).toMatchObject({ assigned: false, reason: 'feature_off' });
    expect(await t.runAuAhpraRecheckSweep()).toMatchObject({ ok: false, reason: 'feature_off' });
    expect(h.emu.requests).toEqual([]);
    expect(tasksOf(au.userId)).toEqual([]);
  });

  it('a candidate staff added keeps the staff pathway when they then finish onboarding; a different answer asks a person', async () => {
    const created = await h.post('/api/ats/candidate', {
      first_name: 'Test', last_name: 'Staffkept', email: 'au.kept.' + (++seq) + '@gplink-test.local', pathway: 'au_vr'
    }, h.consultant());
    const userId = created.json.user_id;
    const cookie = h.gpCookie(row('user_profiles', userId).email, userId);
    rows('user_state').push({ user_id: userId, state: {}, updated_at: new Date().toISOString() });
    // The doctor's own answers point to segment C (no fellowship).
    const res = await h.post('/api/onboarding/complete', auOnboardingBody({ fellowship: 'none', registrationType: 'general' }), { cookie });
    expect(res.status).toBe(200);
    expect(res.json.auPathway.pathway).toBe('au_vr');
    expect(row('user_profiles', userId)).toMatchObject({ candidate_pathway: 'au_vr', pathway_set_by: h.CONSULTANT_EMAIL });
    expect(row('gp_credentials', userId)).toMatchObject({ fellowship_type: 'none', ahpra_registration_type: 'general' });
    expect(openTasks(userId, 'ahpra_register_check').length).toBe(1);
    const review = openTasks(userId, 'segment_review');
    expect(review.length).toBe(1);
    expect(review[0].description).toMatch(/own answers point to a different segment/);
    // The consultant still owns the case.
    expect(caseOf(userId).placing_consultant).toBe(h.CONSULTANT_EMAIL);
  });

  it('facts staff verified are not overwritten when the doctor finishes onboarding afterwards', async () => {
    const created = await h.post('/api/ats/candidate', {
      first_name: 'Test', last_name: 'Verifiedfirst', email: 'au.vfirst.' + (++seq) + '@gplink-test.local', pathway: 'au_vr', ahpra_number: 'MED0001234567'
    }, h.consultant());
    const userId = created.json.user_id;
    const d = { userId, email: row('user_profiles', userId).email };
    await check(d, Object.assign({}, VERIFIED, { fellowship_type: 'fracgp', work_rights: 'citizen', moratorium_19ab_confirmed: 'no', note: 'Trained in Australia as a citizen (FAKE test reason)' }));
    expect(await t.resolveCandidatePathway(userId)).toMatchObject({ pathway: 'au_vr', confirmed: true, dpaRestricted: false });
    rows('user_state').push({ user_id: userId, state: {}, updated_at: new Date().toISOString() });
    const res = await h.post('/api/onboarding/complete', auOnboardingBody({ registrationType: 'limited', hasConditions: true, conditionsDetail: 'x' }), { cookie: h.gpCookie(d.email, userId) });
    expect(res.status).toBe(200);
    expect(row('gp_credentials', userId)).toMatchObject({ ahpra_registration_type: 'specialist', has_conditions: false, staff_verified_by: h.CONSULTANT_EMAIL });
    expect(row('user_profiles', userId)).toMatchObject({ candidate_pathway: 'au_vr', register_status: 'verified' });
    expect(row('user_profiles', userId).pathway_confirmed_at).toBeTruthy();
    // No new check task (already verified); the differing answers ask a person.
    expect(openTasks(userId, 'ahpra_register_check')).toEqual([]);
    expect(openTasks(userId, 'segment_review').length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('D. register-auto-verify and the yearly re-check (COM-11, DAT-08)', () => {
  it('never attempts an Ahpra row, pathway or no pathway: nothing stamped, nothing counted', async () => {
    const au = selfDeclaredAu();
    const noPathway = add('overseas_null', { profile: { register_body: 'ahpra', register_number: 'MED0002223334', register_status: 'pending_verification', register_auto_checked_at: null } });
    h.emu.reset();
    const res = await cron('/api/cron/register-auto-verify');
    expect(res.status).toBe(200);
    const attempted = (res.json.results || []).map((r) => r.user_id);
    expect(attempted).not.toContain(au.userId);
    expect(attempted).not.toContain(noPathway.userId);
    expect(row('user_profiles', au.userId).register_auto_checked_at == null).toBe(true);
    expect(row('user_profiles', noPathway.userId).register_auto_checked_at == null).toBe(true);
    expect(h.emu.requests.filter((r) => r.table === 'user_profiles' && r.method === 'PATCH' && r.bodyKeys.indexOf('register_auto_checked_at') !== -1
      && (r.query.indexOf(au.userId) !== -1 || r.query.indexOf(noPathway.userId) !== -1))).toEqual([]);

    // Whoever calls the function (the drawer's Auto-check button too).
    h.emu.reset();
    const direct = await t.attemptAutomaticRegisterVerification(noPathway.userId);
    expect(direct).toMatchObject({ outcome: 'manual_only', staffCheckOnly: true });
    // (runtime_kv is the cron run's own "last run" stamp, written after it answers.)
    expect(h.emu.requests.filter((r) => r.method !== 'GET' && r.table !== 'runtime_kv')).toEqual([]);
    const button = await check(noPathway, { action: 'auto' });
    expect(button.json).toMatchObject({ ok: true, auto: true, outcome: 'manual_only' });
    expect(row('user_profiles', noPathway.userId).register_auto_checked_at == null).toBe(true);
  });

  it('SWITCH OFF: an Ahpra row is handled exactly as on main (stamped, "manual only")', async () => {
    const d = add('overseas_null', { profile: { register_body: 'ahpra', register_number: 'MED0002223335', register_status: 'pending_verification', register_auto_checked_at: null } });
    h.setSwitch(false);
    const out = await t.attemptAutomaticRegisterVerification(d.userId);
    expect(out).toEqual({ outcome: 'manual_only', evidence: 'No automated source for this register. Use the one-click staff check.' });
    expect(row('user_profiles', d.userId).register_auto_checked_at).toBeTruthy();
  });

  it('the yearly re-check opens one task per doctor who is due, through the daily sla-sweep job', async () => {
    const longAgo = selfDeclaredAu({ credentials: { ahpra_last_checked_at: '2025-06-01T00:00:00.000Z', staff_verified_at: '2025-06-01T00:00:00.000Z', registration_expiry: '2028-09-30' }, rest: { selfDeclared: false } });
    const expiring = selfDeclaredAu({ credentials: { ahpra_last_checked_at: new Date(Date.now() - 200 * 86400000).toISOString(), registration_expiry: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10) } });
    const fine = selfDeclaredAu({ credentials: { ahpra_last_checked_at: new Date(Date.now() - 30 * 86400000).toISOString(), registration_expiry: '2028-09-30' } });
    const neverChecked = selfDeclaredAu({ credentials: { ahpra_last_checked_at: null, registration_expiry: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) } });
    const overseas = add('overseas_null', { credentials: { ahpra_last_checked_at: '2024-01-01T00:00:00.000Z' } });

    const res = await cron('/api/cron/sla-sweep');
    expect(res.status).toBe(200);
    expect(res.json.au_ahpra_recheck).toMatchObject({ ok: true, due: 3, raised: 2 });
    expect(openTasks(longAgo.userId, 'ahpra_register_check')[0]).toMatchObject({ source_trigger: 'au_ahpra_check_annual_recheck', priority: 'normal' });
    expect(openTasks(longAgo.userId, 'ahpra_register_check')[0].title).toMatch(/^Re-check Ahpra registration: /);
    expect(openTasks(expiring.userId, 'ahpra_register_check')[0]).toMatchObject({ source_trigger: 'au_ahpra_check_expiry_soon', priority: 'high' });
    expect(tasksOf(fine.userId, 'ahpra_register_check')).toEqual([]);
    expect(tasksOf(neverChecked.userId, 'ahpra_register_check')).toEqual([]);
    expect(tasksOf(overseas.userId, 'ahpra_register_check')).toEqual([]);

    // The next day's run changes nothing.
    const again = await t.runAuAhpraRecheckSweep();
    expect(again).toMatchObject({ raised: 0, already_open: 2 });
    expect(tasksOf(longAgo.userId, 'ahpra_register_check').length).toBe(1);
    // Doing the check clears it for a year.
    await check(longAgo, VERIFIED);
    expect((await t.runAuAhpraRecheckSweep()).already_open).toBe(1);
    expect(openTasks(longAgo.userId, 'ahpra_register_check')).toEqual([]);

    h.setSwitch(false);
    const off = await cron('/api/cron/sla-sweep');
    expect('au_ahpra_recheck' in off.json).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E. ownership, consultant task access, the waitlist, the chip and filter', () => {
  it('assignRsoForPrestart (WP-11 hook): fills an empty assignment on an Australian case only', async () => {
    process.env.LAUNCH_DEFAULT_RSO_EMAIL = h.RSO_EMAIL;
    const au = selfDeclaredAu();
    expect(await t.assignRsoForPrestart(caseOf(au.userId).id, { actor: 'system' })).toEqual({ ok: true, assigned: true, rsoUserId: h.RSO_USER_ID });
    expect(caseOf(au.userId)).toMatchObject({ assigned_va: h.RSO_USER_ID, assigned_rso: h.RSO_USER_ID });
    expect(await t.assignRsoForPrestart(caseOf(au.userId).id)).toMatchObject({ assigned: false, reason: 'already_assigned' });
    const picked = selfDeclaredAu();
    expect(await t.assignRsoForPrestart(caseOf(picked.userId).id, { rsoUserId: h.OTHER_RSO_USER_ID })).toMatchObject({ assigned: true, rsoUserId: h.OTHER_RSO_USER_ID });
    const overseas = add('overseas_null');
    expect(await t.assignRsoForPrestart(caseOf(overseas.userId).id)).toMatchObject({ assigned: false, reason: 'not_au_pathway' });
    expect(caseOf(overseas.userId).assigned_rso == null).toBe(true);
  });

  it('ownership leaves an RSO a person assigned, a case past placement, and every overseas case alone', async () => {
    process.env.LAUNCH_DEFAULT_RSO_EMAIL = h.RSO_EMAIL;
    const deliberate = selfDeclaredAu({ rest: { caseRow: { assigned_va: h.OTHER_RSO_USER_ID, assigned_rso: h.OTHER_RSO_USER_ID } } });
    await t.auApplyCaseOwnership(deliberate.userId, { consultant: h.CONSULTANT_EMAIL });
    expect(caseOf(deliberate.userId)).toMatchObject({ assigned_rso: h.OTHER_RSO_USER_ID, placing_consultant: h.CONSULTANT_EMAIL });
    const prestart = selfDeclaredAu({ rest: { caseRow: { stage: 'prestart', assigned_va: h.RSO_USER_ID, assigned_rso: h.RSO_USER_ID } } });
    await t.auApplyCaseOwnership(prestart.userId, {});
    expect(caseOf(prestart.userId).assigned_rso).toBe(h.RSO_USER_ID);
    const overseas = add('overseas_null', { caseRow: { assigned_va: h.RSO_USER_ID, assigned_rso: h.RSO_USER_ID } });
    expect(await t.auApplyCaseOwnership(overseas.userId, { consultant: h.CONSULTANT_EMAIL })).toEqual({ ok: true, reason: 'not_au_pathway' });
    expect(caseOf(overseas.userId).assigned_rso).toBe(h.RSO_USER_ID);
    expect(caseOf(overseas.userId).placing_consultant == null).toBe(true);
    // A new overseas case still gets the default RSO, exactly as before.
    const fresh = add('overseas_null', { noCase: true });
    expect(await t._ensureRegCase(fresh.userId)).toMatchObject({ stage: 'myintealth', assigned_va: h.RSO_USER_ID, assigned_rso: h.RSO_USER_ID });
    // And a new Australian case does not.
    const freshAu = selfDeclaredAu({ rest: { noCase: true } });
    const made = await t._ensureRegCase(freshAu.userId);
    expect(made).toMatchObject({ stage: 'placement', pathway: 'au_vr' });
    expect(made.assigned_va == null && made.assigned_rso == null).toBe(true);
  });

  it('a consultant can read the tasks of an Australian case, and only that', async () => {
    const au = selfDeclaredAu();
    await t.auRaiseAhpraCheckTask(au.userId, { reason: 'staff_created' });
    rows('registration_tasks').push({
      id: 'task-doc-1', case_id: caseOf(au.userId).id, task_type: 'doc_review', title: 'Review uploaded: indemnity certificate', status: 'completed',
      priority: 'normal', description: 'PRIVATE DESCRIPTION', attachment_url: 'https://files.test/passport.jpg', document_html: '<p>secret</p>',
      email_body_snippet: 'secret snippet', related_stage: 'prestart', created_at: '2026-11-01T00:00:00.000Z', completed_at: '2026-11-02T00:00:00.000Z'
    });
    const res = await h.get('/api/ats/candidate/tasks?case_id=' + caseOf(au.userId).id, h.consultant());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, read_only: true, open: 1 });
    expect(res.json.tasks.map((x) => x.task_type).sort()).toEqual(['ahpra_register_check', 'doc_review']);
    // WP-26 widened this list on purpose (W3-D22): each task now also says who
    // owns it, what to do and what this viewer may do from the drawer. It still
    // carries no description, attachment, email text or document (next line).
    expect(Object.keys(res.json.tasks[0]).sort()).toEqual(['action', 'au', 'can_complete', 'completed_at', 'completed_by', 'completion', 'completion_note',
      'created_at', 'doctor_provided_number', 'document_key', 'done_when', 'due_date', 'expected_start_date', 'id', 'mark', 'open', 'owner', 'owner_then', 'priority', 'stage',
      'stage_label', 'status', 'task_type', 'title', 'what_to_do']);
    expect(res.raw).not.toMatch(/PRIVATE DESCRIPTION|passport\.jpg|secret/);
    expect((await h.get('/api/ats/candidate/tasks?user_id=' + au.userId, h.superAdmin())).json.tasks.length).toBe(2);

    // An overseas doctor's tasks are refused, whoever they are assigned to.
    const overseas = add('overseas_null');
    rows('registration_tasks').push({ id: 'task-os-1', case_id: caseOf(overseas.userId).id, task_type: 'doc_review', title: 'Review uploaded: passport', status: 'open' });
    const denied = await h.get('/api/ats/candidate/tasks?case_id=' + caseOf(overseas.userId).id, h.consultant());
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe('not_au_pathway');
    expect(denied.raw).not.toMatch(/passport/);
    // Unreadable pathway fails closed.
    h.emu.failTables = { user_profiles: 500 };
    expect((await h.get('/api/ats/candidate/tasks?case_id=' + caseOf(au.userId).id, h.consultant())).status).toBe(403);
    h.emu.failTables = {};
    // Read only: there is no way to write through it. RSOs are not let in at
    // all (they read tasks through the admin routes, scoped to their doctors).
    expect((await h.post('/api/ats/candidate/tasks?case_id=' + caseOf(au.userId).id, {}, h.consultant())).status).not.toBe(200);
    expect((await h.get('/api/ats/candidate/tasks?case_id=' + caseOf(au.userId).id, h.rso())).status).toBe(403);
    expect((await h.get('/api/ats/candidate/tasks?case_id=' + caseOf(au.userId).id)).status).toBe(401);
    // The consultant still cannot open the admin task routes.
    expect([401, 403]).toContain((await h.get('/api/admin/tasks', h.consultant())).status);
  });

  it('RSO lockdown is unchanged: an RSO sees only their assigned doctors, and not an unassigned Australian case', async () => {
    const au = selfDeclaredAu();
    const mine = add('overseas_null', { caseRow: { assigned_va: h.RSO_USER_ID, assigned_rso: h.RSO_USER_ID } });
    const res = await h.get('/api/admin/cases', h.rso());
    expect(res.status).toBe(200);
    const ids = (res.json.cases || []).map((c) => c.user_id);
    expect(ids).toContain(mine.userId);
    expect(ids).not.toContain(au.userId);
    expect((await h.get('/api/admin/candidate/pathway?user_id=' + au.userId, h.rso())).status).toBe(403);
  });

  it('the eligibility waitlist: listed for the CEO and consultants, released with an invite', async () => {
    const parked = freshSignup();
    row('user_state', parked.userId).state = { gp_eligibility_waitlist: JSON.stringify({ country: 'Australia', email: parked.email, at: '2026-11-10T00:00:00.000Z' }) };
    const finished = add('overseas_null', { state: { gp_eligibility_waitlist: 'x' } });
    const list = await h.get('/api/admin/eligibility-waitlist', h.consultant());
    expect(list.status).toBe(200);
    const mine = list.json.items.filter((i) => i.user_id === parked.userId);
    expect(mine).toEqual([{ user_id: parked.userId, name: 'Test Ukgp', email: parked.email, country: 'Australia', waitlisted_at: '2026-11-10T00:00:00.000Z' }]);
    // A doctor who has since finished onboarding is not parked.
    expect(list.json.items.map((i) => i.user_id)).not.toContain(finished.userId);
    expect((await h.get('/api/admin/eligibility-waitlist', h.rso())).status).toBe(403);
    expect((await h.get('/api/admin/eligibility-waitlist')).status).toBe(401);

    // "Release and invite" from the tab.
    const rel = await h.post('/api/admin/eligibility-waitlist/release', { user_id: parked.userId, send_invite: true }, h.consultant());
    expect(rel.json).toMatchObject({ ok: true, released: true, invite: { sent: true } });
    expect(mailsTo(parked.email).length).toBe(1);
    const after = await h.get('/api/admin/eligibility-waitlist', h.consultant());
    expect(after.json.items.map((i) => i.user_id)).not.toContain(parked.userId);
  });

  it('the candidate list: a pathway chip on every row, the filter, and Australian doctors visible before onboarding is finished', async () => {
    const overseas = add('overseas_null');
    const vr = add('au_vr');
    const restricted = add('au_restricted');
    const registrar = add('au_registrar');
    const notOnboardedAu = selfDeclaredAu({ profile: { onboarding_completed_at: null }, rest: { state: { gp_onboarding_complete: false, gp_onboarding: {} } } });
    const notOnboardedOverseas = add('overseas_null', { profile: { onboarding_completed_at: null }, state: { gp_onboarding_complete: false, gp_onboarding: {} } });
    const res = await h.get('/api/ceo/candidates', h.consultant());
    expect(res.status).toBe(200);
    expect(res.json.au_pathway_enabled).toBe(true);
    // WP-29 (deliberate): five filters were added after the existing seven.
    expect(res.json.pathway_filters.map((f) => f.value)).toEqual(['', 'overseas', 'au_vr', 'au_restricted', 'au_non_vr', 'au_registrar', 'needs_review',
      'group_anywhere', 'group_dpa_only', 'group_registrar', 'group_non_vr_held', 'needs_person']);
    const by = {};
    res.json.candidates.forEach((r) => { by[r.user_id] = r; });
    // WP-29 (deliberate): an Australian row also says where the doctor sorts;
    // an overseas row has none of the three keys.
    expect(by[vr.userId].au).toMatchObject({ group: 'anywhere', group_label: 'Can work anywhere', needs_person: false });
    expect(by[restricted.userId].au).toMatchObject({ group: 'dpa_only', group_label: 'Priority areas only (DPA)', needs_person: false });
    expect(by[registrar.userId].au).toMatchObject({ group: 'registrar', group_label: 'Registrar: not placed', needs_person: false });
    expect(Object.keys(by[overseas.userId].au).sort()).toEqual(['confirmed', 'is_au', 'label', 'needs_review', 'pathway', 'recorded', 'set_by_staff', 'stage_label']);
    const groupIds = async (filter) => (await h.get('/api/ceo/candidates?pathway=' + filter, h.superAdmin())).json.candidates.map((r) => r.user_id);
    expect(await groupIds('group_anywhere')).toContain(vr.userId);
    expect(await groupIds('group_anywhere')).not.toContain(restricted.userId);
    expect(await groupIds('group_dpa_only')).toContain(restricted.userId);
    expect(await groupIds('group_registrar')).toEqual(expect.arrayContaining([registrar.userId]));
    for (const f of ['group_anywhere', 'group_dpa_only', 'group_registrar', 'group_non_vr_held', 'needs_person']) expect(await groupIds(f)).not.toContain(overseas.userId);
    expect(by[overseas.userId].au).toMatchObject({ pathway: 'overseas_esp', label: 'Overseas', is_au: false, recorded: false, needs_review: false });
    expect(by[vr.userId].au).toMatchObject({ pathway: 'au_vr', label: 'Australian VR', is_au: true, confirmed: true, needs_review: false, stage_label: 'Placement' });
    expect(by[restricted.userId].au).toMatchObject({ pathway: 'au_restricted', label: 'Australian restricted', needs_review: true });
    expect(by[registrar.userId].au).toMatchObject({ label: 'Registrar', needs_review: true });
    expect(by[notOnboardedAu.userId].au).toMatchObject({ pathway: 'au_vr', confirmed: false, needs_review: true });
    expect(by[notOnboardedOverseas.userId]).toBeUndefined();

    const ids = async (filter) => (await h.get('/api/ceo/candidates?pathway=' + filter, h.superAdmin())).json.candidates.map((r) => r.user_id);
    expect(await ids('au_restricted')).toContain(restricted.userId);
    expect(await ids('au_restricted')).not.toContain(vr.userId);
    expect(await ids('au_registrar')).toContain(registrar.userId);
    const overseasIds = await ids('overseas');
    expect(overseasIds).toContain(overseas.userId);
    expect(overseasIds).not.toContain(vr.userId);
    const review = await ids('needs_review');
    expect(review).toContain(restricted.userId);
    expect(review).toContain(notOnboardedAu.userId);
    expect(review).not.toContain(vr.userId);
    expect(review).not.toContain(overseas.userId);

    // The profile carries the staff block; an overseas doctor's says so.
    const profile = await h.get('/api/ceo/candidate?case_id=' + caseOf(vr.userId).id, h.consultant());
    expect(profile.json.candidate.au).toMatchObject({ enabled: true, chip: 'Australian VR', pathway: { pathway: 'au_vr', isAu: true }, public_register_url: 'https://www.ahpra.gov.au/Registration/Registers-of-Practitioners.aspx' });
    expect(profile.json.candidate.rail.map((s) => s.key)).toEqual(['placement', 'prestart', 'commenced', 'guarantee', 'complete']);
    const osProfile = await h.get('/api/ceo/candidate?case_id=' + caseOf(overseas.userId).id, h.consultant());
    expect(osProfile.json.candidate.au).toMatchObject({ enabled: true, chip: 'Overseas', pathway: { isAu: false }, check_task: null });

    // SWITCH OFF: no chip, no filter, the not-onboarded doctors are hidden as
    // before, and the profile has no `au` key.
    h.setSwitch(false);
    h.emu.reset();
    h.emu.forbid((r) => wp02NewNameViolation(r, NAMES) || wp06NewNameViolation(r));
    const off = await h.get('/api/ceo/candidates?pathway=au_vr', h.consultant());
    expect(Object.keys(off.json).sort()).toEqual(['applications_unavailable', 'candidates', 'ok', 'total']);
    expect(off.json.candidates.every((r) => !('au' in r))).toBe(true);
    const offIds = off.json.candidates.map((r) => r.user_id);
    expect(offIds).toContain(overseas.userId);
    expect(offIds).toContain(vr.userId);   // the pathway filter is ignored with the switch off
    expect(offIds).not.toContain(notOnboardedAu.userId);
    const offProfile = await h.get('/api/ceo/candidate?case_id=' + caseOf(overseas.userId).id, h.consultant());
    expect('au' in offProfile.json.candidate).toBe(false);
    await h.get('/api/ceo/pipeline-summary', h.consultant());
    expect(h.emu.violations).toEqual([]);
  });

  it('setting a doctor to an Australian pathway by hand opens the check and records the consultant', async () => {
    const d = add('overseas_null');
    const res = await h.post('/api/admin/candidate/pathway', { user_id: d.userId, pathway: 'au_vr' }, h.consultant());
    expect(res.status).toBe(200);
    expect(caseOf(d.userId)).toMatchObject({ stage: 'placement', placing_consultant: h.CONSULTANT_EMAIL });
    expect(openTasks(d.userId, 'ahpra_register_check')[0]).toMatchObject({ source_trigger: 'au_ahpra_check_pathway_set' });
    // Confirmed by hand, but the register is not checked: no N06 yet.
    expect(mailsTo(d.email)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('F1. switch-off never overwrites an Australian-ladder stage', () => {
  const stageChanges = (userId) => rows('task_timeline').filter((e) => caseOf(userId) && e.case_id === caseOf(userId).id && e.event_type === 'stage_change');

  it('the reported bug: prestart, switch off, the doctor opens the app -> the case is left at prestart', async () => {
    const d = add('au_vr', { caseRow: { stage: 'prestart' } });
    h.setSwitch(false);
    h.emu.reset();
    h.emu.forbid((r) => wp02NewNameViolation(r, NAMES) || wp06NewNameViolation(r));
    const put = await h.put('/api/state', { state: { gp_career_intro_seen: true }, updatedAt: new Date().toISOString() }, { cookie: d.cookie });
    expect(put.status).toBe(200);
    await t.processRegistrationTaskAutomationForTest(d.userId, d.email, {}, { gp_career_intro_seen: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(caseOf(d.userId).stage).toBe('prestart');
    expect(stageChanges(d.userId)).toEqual([]);
    // No overseas unlock keys were stamped on the doctor either.
    const st = row('user_state', d.userId).state;
    expect(st.gp_admin_stage_override).toBeUndefined();
    expect(st.gp_registration_return_overrides).toBeUndefined();
    // Still nothing new was asked of the database.
    expect(h.emu.violations).toEqual([]);
    // Switch back on: still prestart (not 'placement').
    h.emu.forbid(null);
    h.setSwitch(true);
    await t.processRegistrationTaskAutomationForTest(d.userId, d.email, {}, { gp_career_intro_seen: true });
    expect(caseOf(d.userId).stage).toBe('prestart');
    expect(stageChanges(d.userId)).toEqual([]);
  });

  it('every Australian-ladder stage, every overseas stage writer, switch off', async () => {
    for (const stage of ['placement', 'prestart', 'commenced', 'guarantee']) {
      const d = add('au_vr', { caseRow: { stage } });
      h.setSwitch(false);
      // The state sync, with overseas progress flags in the doctor's state.
      await t.processRegistrationTaskAutomationForTest(d.userId, d.email, {}, {
        gp_epic_progress: { completed: { verification_issued: true } }, gp_amc_progress: { completed: { qualifications_verified: true } }
      });
      expect(caseOf(d.userId).stage, stage).toBe(stage);
      // The staff "verified stage" control.
      const applied = await t.applyVerifiedStageToGp(caseOf(d.userId).id, d.userId, 'ahpra', 'staff@gplink-test.local', { fromStage: stage });
      expect(applied).toMatchObject({ ok: false, held: true });
      expect(caseOf(d.userId).stage, stage).toBe(stage);
      expect(row('user_state', d.userId).state.gp_admin_stage_override).toBeUndefined();
      // Reset GP.
      const reset = await h.post('/api/admin/reset-gp', { email: d.email }, h.superAdmin());
      expect(reset.status, stage).toBe(409);
      expect(reset.json.code).toBe('au_stage');
      expect(caseOf(d.userId).stage, stage).toBe(stage);
      // The bulk case sync.
      const sync = await h.post('/api/admin/cases/sync', {}, h.superAdmin());
      expect(sync.status).toBe(200);
      expect(caseOf(d.userId).stage, stage).toBe(stage);
      // The registration-granted flow.
      const granted = await t.handleAhpraRegistrationGranted({ caseId: caseOf(d.userId).id, userId: d.userId, source: { type: 'manual' }, registration: { number: 'MED0001234567' }, actor: 'staff@gplink-test.local' });
      expect(granted.skipped, stage).toBeTruthy();
      expect(caseOf(d.userId).stage, stage).toBe(stage);
      expect(stageChanges(d.userId), stage).toEqual([]);
      // The stall chase reads the doctor as on the Australian ladder and stands down.
      const pos = await t.resolveGpJourneyPositionForTest(d.userId, stage, null);
      expect(pos.ladder, stage).toBe('au');
      expect(pos.stage, stage).toBe(stage);
      h.setSwitch(true);
    }
  });

  it('switch ON, non-Australian code path: a case on an Australian stage whose doctor reads as overseas is left alone too', async () => {
    const d = add('overseas_null', { caseRow: { stage: 'commenced' } });
    await t.processRegistrationTaskAutomationForTest(d.userId, d.email, {}, { gp_career_intro_seen: true });
    expect(caseOf(d.userId).stage).toBe('commenced');
    expect(await t._auStageModeFor(d.userId, caseOf(d.userId))).toMatchObject({ mode: 'hold', strandedAuStage: true });
    const set = await h.put('/api/admin/case?id=' + caseOf(d.userId).id, { gp_verified_stage: 'ahpra' }, h.superAdmin());
    expect(set.status).toBe(409);
    expect(set.json.message).toMatch(/Australian stage/);
    expect(caseOf(d.userId).stage).toBe('commenced');
    // The one thing that moves it: staff correcting the pathway.
    const fixed = await h.post('/api/admin/candidate/pathway', { user_id: d.userId, pathway: 'overseas_esp' }, h.superAdmin());
    expect(fixed.status).toBe(200);
    expect(caseOf(d.userId).stage).toBe('myintealth');
  });

  it('OVERSEAS PARITY: an overseas case is derived exactly as before, switch on and off', async () => {
    for (const on of [true, false]) {
      const d = add('overseas_null');
      h.setSwitch(on);
      expect(await t._auStageModeFor(d.userId, caseOf(d.userId))).toMatchObject({ mode: 'overseas' });
      await t.processRegistrationTaskAutomationForTest(d.userId, d.email, {}, {
        gp_epic_progress: { completed: { verification_issued: true } }
      });
      expect(caseOf(d.userId).stage).toBe('amc');
      expect(stageChanges(d.userId).map((e) => e.title)).toEqual(['Stage advanced to amc']);
      const pos = await t.resolveGpJourneyPositionForTest(d.userId, 'amc', null);
      expect(pos.ladder).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('F2. the Australian page gate cannot be bypassed with an altered URL', () => {
  it('auGatePageKey resolves a path the way the static handler finds the file', () => {
    for (const p of ['/pages/visa.html', '/pages/visa', '/pages/%76isa', '/pages/%76isa.html', '/pages/VISA', '/pages/Visa.html', '/pages/visa.HTML',
      '/pages//visa.html', '/pages/./visa', '/pages/x/../visa', '/PAGES/visa.html', '/pages\\visa.html', '/pages/visa.html?x=1']) {
      expect(t.auGatePageKey(p), p).toBe('/pages/visa.html');
    }
    expect(t.auGatePageKey('/pages/%E0%A4%A')).toBe('');
    expect(t.auGatePageKey('/pages/visa%00.html')).toBe('');
    expect(t.auGatePageKey('/pages/career')).toBe('/pages/career.html');
    // A doubly-encoded path is decoded once, like the file lookup, and is not the page.
    expect(t.auGatePageKey('/pages/%2576isa')).toBe('/pages/%76isa.html');
  });

  it('every spelling of the four blocked pages redirects an Australian doctor', async () => {
    const au = add('au_vr');
    const spellings = ['/pages/visa', '/pages/%76isa', '/pages/VISA', '/pages/visa.HTML?gp_shell=1', '/pages/Visa.html?gp_shell=1', '/pages/%76isa.html?gp_shell=1',
      '/pages/%41hpra', '/pages/AMC', '/pages/MyIntHealth', '/pages/%6dyinthealth', '/pages/amc.HTML?gp_shell=1'];
    for (const page of spellings) {
      const res = await h.get(page, { cookie: au.cookie });
      expect(res.status, page).toBe(302);
      expect(res.headers.location, page).toBe('/pages/index');
    }
    // Pages that are not blocked are not affected.
    const career = await h.get('/pages/career', { cookie: au.cookie });
    expect(career.headers.location).not.toBe('/pages/index');
  });

  it('OVERSEAS PARITY: an overseas doctor gets exactly the answer they got before, for every spelling, switch on and off', async () => {
    const d = add('overseas_null');
    const pages = ['/pages/visa', '/pages/%76isa', '/pages/VISA', '/pages/visa.HTML?gp_shell=1', '/pages/ahpra', '/pages/myinthealth', '/pages/career'];
    h.setSwitch(false);
    const off = {};
    for (const p of pages) { const r = await h.get(p, { cookie: d.cookie }); off[p] = r.status + ' ' + (r.headers.location || ''); }
    h.setSwitch(true);
    for (const p of pages) {
      const r = await h.get(p, { cookie: d.cookie });
      expect(r.status + ' ' + (r.headers.location || ''), p).toBe(off[p]);
    }
    // And with the switch off an Australian doctor is not gated by this at all.
    h.setSwitch(false);
    const au = add('au_vr');
    const res = await h.get('/pages/%76isa', { cookie: au.cookie });
    expect(res.headers.location).not.toBe('/pages/index');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('F3. the stage setter answers with the row after the move', () => {
  it('Australian doctor: the response carries the new stage', async () => {
    const d = add('au_vr');
    const res = await h.put('/api/admin/case?id=' + caseOf(d.userId).id, { gp_verified_stage: 'prestart' }, h.superAdmin());
    expect(res.status).toBe(200);
    expect(res.json.case).toMatchObject({ id: caseOf(d.userId).id, stage: 'prestart', gp_verified_stage: 'prestart' });
    expect(caseOf(d.userId).stage).toBe('prestart');
    // Setting it to where it already is moves nothing and still answers truthfully.
    const same = await h.put('/api/admin/case?id=' + caseOf(d.userId).id, { gp_verified_stage: 'prestart' }, h.superAdmin());
    expect(same.json.case.stage).toBe('prestart');
  });

  it('OVERSEAS PARITY: the response is built as before (the row the PATCH returned), with no extra read', async () => {
    const d = add('overseas_null');
    h.emu.reset();
    const res = await h.put('/api/admin/case?id=' + caseOf(d.userId).id, { gp_verified_stage: 'amc' }, h.superAdmin());
    expect(res.status).toBe(200);
    expect(Object.keys(res.json).sort()).toEqual(['case', 'email_transferred', 'ok', 'transfer_error']);
    // As on main: the row from the first PATCH, before the propagation ran.
    expect(res.json.case.stage).toBe('myintealth');
    expect(caseOf(d.userId).stage).toBe('amc');
    expect(h.emu.requests.filter((r) => r.table === 'registration_cases' && r.method === 'GET' && /select=\*/.test(r.query) && r.query.indexOf('id=eq.') !== -1)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SWITCH OFF: nothing WP-06 added is named anywhere', () => {
  it('staff and doctor flows run with no new column, table or task type', async () => {
    const overseas = add('overseas_null', { profile: { register_body: 'gmc', register_number: '7654321', register_status: 'pending_verification' } });
    const au = selfDeclaredAu();
    const signup = freshSignup();
    h.setSwitch(false);
    h.emu.reset();
    h.emu.forbid((r) => wp02NewNameViolation(r, NAMES) || wp03NewStageViolation(r) || wp06NewNameViolation(r));
    expect((await h.get('/api/ceo/candidates', h.consultant())).status).toBe(200);
    expect((await h.get('/api/ceo/candidate?case_id=' + caseOf(overseas.userId).id, h.consultant())).status).toBe(200);
    expect((await h.get('/api/ceo/pipeline-summary', h.consultant())).status).toBe(200);
    expect((await check(overseas, { action: 'verified' })).status).toBe(200);
    expect((await check(overseas, { action: 'update_number', registerNumber: '7654322' })).status).toBe(200);
    expect((await check(au, { action: 'verified' })).status).toBe(200);   // on main the one-click works for anyone
    expect((await cron('/api/cron/register-auto-verify')).status).toBe(200);
    expect((await cron('/api/cron/sla-sweep')).status).toBe(200);
    expect((await h.put('/api/admin/case?id=' + caseOf(overseas.userId).id, { gp_verified_stage: 'amc' }, h.superAdmin())).status).toBe(200);
    const gb = { _version: 2, currentStep: 4, country: 'GB', registerNumber: '7654329', qualDocs: {}, accountReviewFlag: false, targetDate: '2027-08-01',
      preferredCity: 'Sydney', whoMoving: 'just_me', childrenCount: 1, childrenAges: [], leadSource: 'google', leadSourceDetail: '',
      idVerification: { status: 'verified', fileName: 'id.jpg' }, completedAt: '2026-11-20T03:00:00.000Z' };
    expect((await h.post('/api/onboarding/complete', gb, { cookie: signup.cookie })).status).toBe(200);
    for (const page of ['/pages/visa', '/pages/%76isa']) await h.get(page, { cookie: overseas.cookie });
    await new Promise((r) => setTimeout(r, 300));
    expect(h.emu.violations).toEqual([]);
    expect(tasksOf(signup.userId).filter((x) => x.task_type === 'ahpra_register_check')).toEqual([]);
  });
});

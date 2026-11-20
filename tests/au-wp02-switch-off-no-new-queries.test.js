// WP-02 acceptance: "no existing query changes result for existing rows".
//
// Until the WP-02 migration is applied, production does not have the new
// columns or the gp_credentials table, and PostgREST fails a WHOLE query that
// names a column that is not there. So:
//
//   1. SWITCH OFF  no request the server makes may name a new column or
//                  gp_credentials. Proved by running representative doctor and
//                  staff flows against a database stub that FAILS (500) and
//                  records any request mentioning the new names.
//   2. SWITCH ON, an existing overseas doctor with nothing recorded
//                  every existing endpoint answers exactly as with the switch
//                  off, except the two documented additive keys on
//                  /api/auth/session (auPathwayEnabled, auPathway).
//   3. SWITCH ON, MIGRATION NOT APPLIED (a preview before the owner's go-ahead)
//                  the same: nothing breaks, the doctor reads as overseas.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { wp02NewNameViolation } = require('./helpers/au-supabase-emulator.js');
const {
  buildAuDoctor, buildAuFixtureDb, STAFF_EMAIL, WP02_NEW_COLUMN_NAMES, WP02_NEW_TABLES,
  WP03_NEW_STAGE_VALUES, wp03NewStageViolation
} = require('./helpers/au-fixtures.js');

let h, t, gp, auGp, writer;
const NOW = new Date().toISOString();
const NAMES = { columns: WP02_NEW_COLUMN_NAMES, tables: WP02_NEW_TABLES };

// What production looks like before the migration: the new columns and the new
// table do not exist.
function pretendNotMigrated() {
  h.emu.missingColumns = { user_profiles: WP02_NEW_COLUMN_NAMES.slice(), registration_cases: ['pathway'] };
  h.emu.missingTables = new Set(WP02_NEW_TABLES);
}

// Read-only flows, so the same request can be compared across switch states.
function gpReads(d) {
  const cookie = h.gpCookie(d.email, d.userId);
  return [
    ['GET /api/auth/session', () => h.get('/api/auth/session', { cookie })],
    ['GET /api/profile', () => h.get('/api/profile', { cookie })],
    ['GET /api/state', () => h.get('/api/state', { cookie })],
    ['GET /api/career/roles', () => h.get('/api/career/roles', { cookie })],
    ['GET /api/career/applications', () => h.get('/api/career/applications', { cookie })],
    ['GET /api/account/career-documents', () => h.get('/api/account/career-documents', { cookie })],
    ['GET /api/account/export', () => h.get('/api/account/export', { cookie })]
  ];
}
function staffReads(d) {
  return [
    ['GET /api/admin/dashboard (CEO)', () => h.get('/api/admin/dashboard', h.superAdmin())],
    ['GET /api/admin/dashboard (RSO)', () => h.get('/api/admin/dashboard', h.rso())],
    ['GET /api/admin/va/dashboard (CEO)', () => h.get('/api/admin/va/dashboard', h.superAdmin())],
    ['GET /api/ceo/candidates (CEO)', () => h.get('/api/ceo/candidates', h.superAdmin())],
    ['GET /api/ceo/candidates (consultant)', () => h.get('/api/ceo/candidates', h.consultant())],
    ['GET /api/ceo/pipeline-summary (CEO)', () => h.get('/api/ceo/pipeline-summary', h.superAdmin())],
    // Impersonate answers with a redirect into the app.
    ['GET /api/admin/impersonate (CEO)', () => h.get('/api/admin/impersonate?user_id=' + d.userId, h.superAdmin()), 302]
  ];
}

// Timestamps the server stamps at request time differ between two calls;
// everything else must match byte for byte.
function comparable(res, dropAuKeys) {
  let body = res.json;
  if (dropAuKeys && body && typeof body === 'object') {
    body = Object.assign({}, body);
    delete body.auPathwayEnabled;
    delete body.auPathway;
  }
  const text = body === null ? res.raw : JSON.stringify(body);
  return res.status + ' ' + text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g, '<ts>').replace(/\b1[6-9]\d{11}\b/g, '<ms>');
}

beforeAll(async () => {
  gp = buildAuDoctor('overseas_null');
  auGp = buildAuDoctor('au_vr');
  writer = buildAuDoctor('overseas_null', { idSuffix: '5' });
  const tables = buildAuFixtureDb([gp, auGp, writer]);
  tables.user_documents = [
    { id: 'doc-cv-1', user_id: gp.userId, document_key: 'career_cv', status: 'uploaded', file_name: 'cv.pdf', created_at: NOW, updated_at: NOW }
  ];
  tables.career_roles = [
    { id: 'role-dpa-1', provider: 'internal_ats', provider_role_id: 'ats_dpa1', title: 'GP - DPA role', practice_name: 'Test Regional Practice (FAKE)', masked_title: 'DPA - Toowoomba', is_active: true, approval_status: 'approved', job_status: 'open', ats_created: true, dpa: true, location_state: 'QLD', nearest_city: 'Toowoomba', updated_at: NOW },
    { id: 'role-nondpa-1', provider: 'internal_ats', provider_role_id: 'ats_nondpa1', title: 'GP - Non-DPA role', practice_name: 'Test Metro Practice (FAKE)', masked_title: 'Non-DPA - Melbourne', is_active: true, approval_status: 'approved', job_status: 'open', ats_created: true, dpa: false, location_state: 'VIC', nearest_city: 'Melbourne', updated_at: NOW }
  ];
  tables.gp_applications = [];
  h = await bootAuTestServer({ name: 'wp02-off', tables });
  t = h.testUtils;
  h.emu.table('registration_cases').forEach((c) => { if (c.user_id === gp.userId) c.assigned_rso = h.RSO_USER_ID; });
});

afterAll(async () => { if (h) await h.close(); });

beforeEach(() => {
  h.setSwitch(true);
  h.emu.reset();
  h.emu.forbid(null);
  h.emu.missingColumns = {};
  h.emu.missingTables = new Set();
});

describe('SWITCH OFF: nothing the server asks the database names a WP-02 column or table', () => {
  it('the stub really does fail a request that names a new column (the test can catch a leak)', async () => {
    h.emu.forbid((r) => wp02NewNameViolation(r, NAMES));
    h.setSwitch(true);
    await t.resolveCandidatePathway(auGp.userId);
    expect(h.emu.violations.length).toBeGreaterThan(0);
    expect(wp02NewNameViolation({ table: 'user_profiles', query: '?select=timezone', select: ['timezone'], filterColumns: [], bodyKeys: [], body: null }, NAMES)).toBe('user_profiles.timezone');
    expect(wp02NewNameViolation({ table: 'registration_cases', query: '', select: null, filterColumns: [], bodyKeys: ['pathway'], body: { pathway: 'au_vr' } }, NAMES)).toBe('registration_cases.pathway');
    expect(wp02NewNameViolation({ table: 'gp_credentials', query: '', select: null, filterColumns: [], bodyKeys: [], body: null }, NAMES)).toBe('table gp_credentials');
    expect(wp02NewNameViolation({ table: 'user_profiles', query: '?select=user_id,email', select: ['user_id', 'email'], filterColumns: ['user_id'], bodyKeys: [], body: null }, NAMES)).toBe('');
  });

  it('a doctor\'s requests (overseas doctor AND a stored au_vr doctor): no new name, and they still work', async () => {
    h.setSwitch(false);
    h.emu.forbid((r) => wp02NewNameViolation(r, NAMES));
    for (const d of [gp, auGp]) {
      for (const [label, run] of gpReads(d)) {
        const res = await run();
        expect(res.status, label + ' for ' + d.kind).toBe(200);
      }
    }
    // Writes a doctor's browser makes.
    const cookie = h.gpCookie(writer.email, writer.userId);
    expect((await h.put('/api/profile', { profile: { firstName: 'Test', lastName: 'Ukgp', phone: '+447700900999' } }, { cookie })).status).toBe(200);
    expect((await h.put('/api/state', { state: { gp_career_intro_seen: true }, updatedAt: new Date().toISOString() }, { cookie })).status).toBe(200);
    expect((await h.post('/api/onboarding/complete', { country: 'GB', preferredCity: 'Melbourne', targetDate: '2027-03', whoMoving: 'Just me', childrenCount: '0' }, { cookie })).status).toBe(200);
    expect((await h.get('/api/public/features')).json).toEqual({ ok: true, auPathwayEnabled: false });

    expect(h.emu.violations).toEqual([]);
    expect(h.emu.requests.length).toBeGreaterThan(20);
  });

  it('staff requests: no new name, and they still work', async () => {
    h.setSwitch(false);
    h.emu.forbid((r) => wp02NewNameViolation(r, NAMES));
    for (const [label, run, expected] of staffReads(gp)) {
      const res = await run();
      expect(res.status, label).toBe(expected || 200);
    }
    // The onboarding override, with the Australian inputs it now understands when on.
    const seed = await h.post('/api/admin/seed-onboarding', { email: writer.email, country: 'AU', pathway: 'au_vr' }, h.superAdmin());
    expect(seed.status).toBe(200);
    // The staff pathway endpoints do not exist.
    expect((await h.post('/api/admin/candidate/pathway', { user_id: gp.userId, pathway: 'au_vr' }, h.superAdmin())).status).toBe(404);
    expect((await h.get('/api/admin/candidate/pathway?user_id=' + gp.userId, h.superAdmin())).status).toBe(404);
    // The onboarding-nudge sweep (a scheduled job that enumerates doctors).
    const cron = await h.get('/api/cron/onboarding-nudge', { headers: { Authorization: 'Bearer test-cron-secret' } });
    expect(cron.status).toBe(200);

    expect(h.emu.violations).toEqual([]);
    expect(h.emu.requests.length).toBeGreaterThan(10);
  });

  it('the helpers themselves: resolver and writers ask nothing', async () => {
    h.setSwitch(false);
    h.emu.forbid((r) => wp02NewNameViolation(r, NAMES));
    await t.resolveCandidatePathway(auGp.userId, { legacyDpaExempt: true });
    await t.resolveCandidatePathwayForSession({ userProfile: { email: auGp.email, supabaseUserId: auGp.userId } });
    await t.resolveCandidatePathwayForSession({ userProfile: { email: auGp.email } });
    await t.setCandidatePathway(gp.userId, { pathway: 'au_vr', setBy: STAFF_EMAIL, confirmed: true });
    await t.upsertGpCredentials(gp.userId, { ahpra_number: 'MED0001234567' }, { source: 'staff', actor: STAFF_EMAIL });
    await t.setCandidatePreferences(gp.userId, { timezone: 'Australia/Perth' });
    await t.readCandidatePreferences(gp.userId);
    expect(h.emu.requests).toEqual([]);
    expect(h.emu.violations).toEqual([]);
  });

  // WP-03 adds no column: it widens two CHECKs so four new stage VALUES are
  // legal. Until that migration is applied the live database rejects them, so
  // with the switch off nothing may write (or filter on) one, and nothing may
  // name a WP-02 column either, across every flow WP-03 touched.
  it('WP-03 flows: no Australian stage value is written and no new name is used', async () => {
    const rule = (r) => wp02NewNameViolation(r, NAMES) || wp03NewStageViolation(r);
    // The rule can catch a leak.
    expect(wp03NewStageViolation({ table: 'registration_cases', query: '', body: [{ user_id: 'u', stage: 'placement' }] })).toBe('registration_cases.stage = placement');
    expect(wp03NewStageViolation({ table: 'registration_cases', query: '?id=eq.1&stage=eq.prestart', body: { stage: 'commenced' } })).toBe('registration_cases.stage = commenced');
    expect(wp03NewStageViolation({ table: 'registration_cases', query: '?id=eq.1&stage=eq.prestart', body: null })).toBe('registration_cases filtered on stage prestart');
    expect(wp03NewStageViolation({ table: 'scheduled_calls', query: '', body: [{ stage: 'guarantee' }] })).toBe('scheduled_calls.stage = guarantee');
    expect(wp03NewStageViolation({ table: 'registration_cases', query: '?stage=eq.myintealth', body: { stage: 'amc' } })).toBe('');
    expect(wp03NewStageViolation({ table: 'registration_tasks', query: '', body: [{ related_stage: 'placement', stage: 'placement' }] })).toBe('');
    expect(WP03_NEW_STAGE_VALUES).toEqual(['placement', 'prestart', 'commenced', 'guarantee']);

    h.setSwitch(false);
    // A doctor whose stored pathway is Australian, with no case yet, and one
    // with a case: with the switch off both are overseas doctors.
    const fresh = buildAuDoctor('au_vr', { idSuffix: '61', noCase: true });
    const staffTarget = buildAuDoctor('overseas_null', { idSuffix: '62' });
    const db = buildAuFixtureDb([fresh, staffTarget]);
    Object.keys(db).forEach((table) => db[table].forEach((row) => h.emu.table(table).push(row)));
    // The stored au_vr fixture case sits at 'placement' (as if the switch had
    // been on). Put it back to what a switch-off world holds.
    h.emu.table('registration_cases').forEach((c) => { if (c.user_id === auGp.userId) c.stage = 'myintealth'; });
    h.emu.forbid(rule);

    // Case creation.
    const created = await t._ensureRegCase(fresh.userId);
    expect(created.stage).toBe('myintealth');
    // The state-sync automation (stage derivation), directly and through the API.
    const flags = { gp_epic_progress: { stage: 'verification_issued', completed: { verification_issued: true } }, gp_career_state: { career_secured: true } };
    await t.processRegistrationTaskAutomationForTest(auGp.userId, auGp.email, {}, flags);
    await t.processRegistrationTaskAutomationForTest(fresh.userId, fresh.email, {}, flags);
    expect((await h.put('/api/state', { state: { gp_career_intro_seen: true }, updatedAt: new Date().toISOString() }, { cookie: h.gpCookie(auGp.email, auGp.userId) })).status).toBe(200);
    expect((await h.get('/api/auth/session', { cookie: h.gpCookie(auGp.email, auGp.userId) })).json.auJourney).toBeUndefined();
    // Step pages are gated as they always were.
    expect((await h.get('/pages/myinthealth', { cookie: h.gpCookie(auGp.email, auGp.userId) })).status).toBeLessThan(500);
    // The stalled-doctor position.
    await t.resolveGpJourneyPositionForTest(auGp.userId, 'myintealth', null);
    // The staff stage setter, including the overseas 'placement' override value.
    const caseId = h.emu.table('registration_cases').find((c) => c.user_id === staffTarget.userId).id;
    for (const stage of ['amc', 'ahpra', 'placement', '']) {
      expect((await h.put('/api/admin/case?id=' + caseId, { gp_verified_stage: stage }, h.superAdmin())).status, stage).toBe(200);
    }
    expect((await h.put('/api/admin/ops/case?id=' + caseId, { gp_verified_stage: 'amc' }, h.superAdmin())).status).toBe(200);
    // Stage rollback, Reset GP and the bulk case sync.
    expect((await h.post('/api/admin/registration-return-overrides', { email: staffTarget.email, steps: { amc: true } }, h.superAdmin())).status).toBe(200);
    expect((await h.post('/api/admin/reset-gp', { email: staffTarget.email }, h.superAdmin())).status).toBe(200);
    expect((await h.post('/api/admin/cases/sync', {}, h.superAdmin())).status).toBe(200);
    // The Australian stage movers refuse and ask nothing.
    const before = h.emu.requests.length;
    await t.syncCaseToPathway(auGp.userId);
    await t.advanceAuCaseStage(caseId, 'prestart', STAFF_EMAIL);
    await t.auMoveCaseOnPlacement(auGp.userId);
    await t.buildAuJourneyView(auGp.userId, { isAu: true, pathway: 'au_vr' });
    expect(h.emu.requests.length).toBe(before);

    // Let the fire-and-forget automation behind PUT /api/state finish.
    await new Promise((r) => setTimeout(r, 300));
    expect(h.emu.violations).toEqual([]);
    // No case anywhere holds an Australian stage.
    expect(h.emu.table('registration_cases').filter((c) => WP03_NEW_STAGE_VALUES.indexOf(c.stage) !== -1)).toEqual([]);
  });

  // WP-04 adds no column, table or value. It adds ONE read (the doctors on an
  // Australian pathway, `user_profiles?candidate_pathway=in.(…)`) that every
  // pathway-aware scheduled job makes once per run. With the switch off that
  // read must never happen, and no job may name a new column any other way.
  it('WP-04 flows: every pathway-aware job runs with no new name and no pathway read', async () => {
    h.setSwitch(false);
    const rule = (r) => wp02NewNameViolation(r, NAMES) || wp03NewStageViolation(r);
    // Rows that make the jobs do real work for the stored au_vr doctor too
    // (with the switch off they are an overseas doctor like any other).
    h.emu.table('registration_cases').forEach((c) => {
      if (c.user_id === auGp.userId) { c.stage = 'myintealth'; c.created_at = '2026-01-01T00:00:00.000Z'; c.last_gp_activity_at = '2026-01-02T00:00:00.000Z'; }
    });
    const auCaseId = h.emu.table('registration_cases').find((c) => c.user_id === auGp.userId).id;
    h.emu.table('registration_tasks').push(
      { id: 'wp04-sppa', case_id: auCaseId, task_type: 'practice_pack_child', related_document_key: 'sppa_00', status: 'waiting_on_practice', title: 'SPPA-00', metadata: { sppa_state: 'sent_to_practice', sent_to_practice_email: 'practice.test@gplink-test.local', sent_to_practice_at: '2026-01-05T00:00:00.000Z' }, updated_at: '2026-01-05T00:00:00.000Z' },
      { id: 'wp04-sg', case_id: auCaseId, task_type: 'practice_pack_child', related_document_key: 'section_g', status: 'deferred', title: 'Section G', metadata: {} }
    );
    h.emu.table('user_documents').push({ id: 'wp04-doc', user_id: auGp.userId, document_key: 'mrcgp_cert', country_code: 'uk', status: 'under_review', flag_reason: 'name_mismatch', ai_review_state: null, reviewed_by: null, storage_path: 'docs/wp04.pdf', created_at: NOW, updated_at: NOW });
    h.emu.table('visa_applications').push({ id: 'wp04-visa', user_id: auGp.userId });
    h.emu.forbid(rule);

    const cronAuth = { headers: { Authorization: 'Bearer test-cron-secret' } };
    const jobs = [
      '/api/cron/weekly-sweep', '/api/cron/sla-sweep', '/api/cron/chase-nonresponders', '/api/cron/reconcile-doc-tasks',
      '/api/cron/register-auto-verify', '/api/cron/sppa-backfill-scan', '/api/cron/onboarding-nudge',
      '/api/cron/onboarding-step-followup?send=1', '/api/cron/dropoff-nudge', '/api/cron/doc-ai-review',
      '/api/cron/refresh-summaries', '/api/cron/recompute-intent', '/api/cron/stalled-applications'
    ];
    for (const path of jobs) {
      const res = await h.get(path, cronAuth);
      expect(res.status, path).toBe(200);
    }
    expect((await h.post('/api/admin/va/weekly-checkin/sweep', {}, h.superAdmin())).status).toBe(200);
    expect((await h.get('/api/admin/stuck-cases', h.superAdmin())).status).toBe(200);

    // The helpers themselves: inert, and they ask nothing.
    const before = h.emu.requests.length;
    const idx = await t.auSweepPathwayIndex('switch-off-test');
    expect(idx.enabled).toBe(false);
    expect(idx.excludesUser(auGp.userId)).toBe(false);
    expect(idx.excludesCase({ id: auCaseId, user_id: auGp.userId, stage: 'prestart', pathway: 'au_vr' })).toBe(false);
    expect(await t.auSweepExcludesCaseId(idx, auCaseId)).toBe(false);
    expect(await t.auOverseasActionBlock(auGp.userId)).toBe(null);
    expect(await t.auStaffActionBlock(auGp.userId)).toBe(null);
    expect(h.emu.requests.length).toBe(before);

    // The event-driven gates: the stored au_vr doctor is an overseas doctor.
    const flags = { gp_epic_progress: { stage: 'verification_issued', completed: { verification_issued: true } }, gp_ahpra_progress: { completed: { account_establishment: true } } };
    await t.processRegistrationTaskAutomationForTest(auGp.userId, auGp.email, {}, flags);
    expect((await t._maybeNotifyAhpraDocsReady(auCaseId)).reason).not.toBe('au_pathway');
    await t.pushVisaNotificationToOwner('wp04-visa', { type: 'info', title: 'Visa update', detail: 'test' });
    const pos = await t.resolveGpJourneyPositionForTest(auGp.userId, 'myintealth', null);
    expect(pos.ladder).toBeUndefined();
    // With the switch off the chase opens its task for them, exactly as on main.
    const chased = await t.chaseStalledCase({ id: auCaseId, user_id: auGp.userId, stage: 'myintealth', substage: null }, { days: 14, sourceTrigger: 'weekly_checkin', actor: 'system' });
    expect(chased.skipped).toBeUndefined();

    await new Promise((r) => setTimeout(r, 300));
    expect(h.emu.violations).toEqual([]);
    // Belt and braces on the one read WP-04 added: it was never made.
    expect(h.emu.requests.filter((r) => /candidate_pathway/.test(r.query))).toEqual([]);
    // The jobs did act on the stored au_vr doctor as an overseas doctor
    // (a stalled-GP chase task and an SLA task on their case).
    const opened = h.emu.requests.filter((r) => r.table === 'registration_tasks' && r.method === 'POST')
      .reduce((all, r) => all.concat(Array.isArray(r.body) ? r.body : [r.body]), [])
      .filter((row) => row && row.case_id === auCaseId).map((row) => row.task_type);
    expect(opened).toContain('chase');
    expect(opened).toContain('sla_overdue');
  });

  it('a stored Australian pathway is invisible with the switch off: the doctor is an overseas doctor', async () => {
    h.setSwitch(false);
    const res = await h.get('/api/auth/session', { cookie: h.gpCookie(auGp.email, auGp.userId) });
    expect(res.raw).toBe(JSON.stringify({ ok: true, authenticated: true, profile: { email: auGp.email, supabaseUserId: auGp.userId } }));
    expect(await t.resolveCandidatePathway(auGp.userId)).toMatchObject({ pathway: 'overseas_esp', isAu: false });
  });
});

describe('SWITCH ON, existing overseas doctor with nothing recorded: every response is unchanged', () => {
  async function snapshot(flows) {
    const out = {};
    for (const [label, run] of flows) out[label] = await run();
    return out;
  }

  it('doctor and staff reads match the switch-off responses, apart from the two additive session keys', async () => {
    const flows = gpReads(gp).concat(staffReads(gp));
    h.setSwitch(false);
    const off = await snapshot(flows);
    h.setSwitch(true);
    h.emu.reset();
    const on = await snapshot(flows);

    for (const [label, , expected] of flows) {
      const isSession = label === 'GET /api/auth/session';
      expect(comparable(on[label], isSession), label).toBe(comparable(off[label], false));
      expect(on[label].status, label).toBe(expected || 200);
    }
    // The additive keys, exactly.
    const session = on['GET /api/auth/session'].json;
    expect(Object.keys(session).sort()).toEqual(['auPathway', 'auPathwayEnabled', 'authenticated', 'ok', 'profile']);
    expect(session.auPathwayEnabled).toBe(true);
    expect(session.auPathway).toEqual({ pathway: 'overseas_esp', segment: 'overseas', isAu: false, launched: true });

    // With the switch on, the ONLY thing that named a new column in all of
    // those flows is the session's own separate pathway read.
    const named = h.emu.requests.filter((r) => wp02NewNameViolation(r, NAMES));
    expect(named.length).toBe(1);
    expect(named[0]).toMatchObject({ method: 'GET', table: 'user_profiles' });
    expect(named[0].select).toEqual(['candidate_pathway', 'candidate_basis', 'pathway_set_by', 'pathway_set_at', 'pathway_confirmed_at', 'pathway_confirmed_by']);
  });

  it('the careers DPA gate is untouched: the overseas doctor still gets the non-DPA role blurred', async () => {
    const cookie = h.gpCookie(gp.email, gp.userId);
    h.setSwitch(false);
    const off = await h.get('/api/career/roles', { cookie });
    h.setSwitch(true);
    const on = await h.get('/api/career/roles', { cookie });
    expect(on.raw).toBe(off.raw);
    // The gate really ran: the DPA role is there, the non-DPA one is a stub.
    expect(on.raw).toContain('DPA - Toowoomba');
    expect(on.raw).not.toContain('Non-DPA - Melbourne');
    expect(on.raw).not.toContain('Test Metro Practice (FAKE)');
  });
});

describe('SWITCH ON but the migration is NOT applied (a preview before the go-ahead): nothing breaks', () => {
  it('every doctor and staff read still answers 200 with the switch-off body', async () => {
    const flows = gpReads(gp).concat(staffReads(gp));
    h.setSwitch(false);
    const off = {};
    for (const [label, run] of flows) off[label] = await run();

    h.setSwitch(true);
    pretendNotMigrated();
    for (const [label, run, expected] of flows) {
      const res = await run();
      expect(res.status, label).toBe(expected || 200);
      expect(comparable(res, label === 'GET /api/auth/session'), label).toBe(comparable(off[label], false));
    }
    const session = await h.get('/api/auth/session', { cookie: h.gpCookie(auGp.email, auGp.userId) });
    expect(session.json.auPathway).toEqual({ pathway: 'overseas_esp', segment: 'overseas', isAu: false, launched: true });
  });

  it('a doctor\'s writes still work', async () => {
    pretendNotMigrated();
    const cookie = h.gpCookie(writer.email, writer.userId);
    expect((await h.put('/api/profile', { profile: { firstName: 'Test', lastName: 'Ukgp' } }, { cookie })).status).toBe(200);
    expect((await h.put('/api/state', { state: { gp_career_intro_seen: true }, updatedAt: new Date().toISOString() }, { cookie })).status).toBe(200);
    expect((await h.post('/api/admin/seed-onboarding', { email: writer.email, country: 'GB' }, h.superAdmin())).status).toBe(200);
  });
});

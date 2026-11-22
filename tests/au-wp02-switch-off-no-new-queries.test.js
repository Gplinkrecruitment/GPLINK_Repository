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
  WP03_NEW_STAGE_VALUES, wp03NewStageViolation, wp06NewNameViolation, WP08_NEW_COLUMN_NAMES, wp08NewNameViolation,
  WP09_NEW_COLUMN_NAMES, wp09NewNameViolation, WP06_NEW_TASK_TYPES, WP11_NEW_NAMES, wp11NewNameViolation,
  WP12_NEW_COLUMN_NAMES, WP12_NEW_TABLES, wp12NewNameViolation,
  WP13_NEW_COLUMN_NAMES, wp13NewNameViolation,
  WP14_NEW_COLUMN_NAMES, WP14_NEW_NAMES, wp14NewNameViolation
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
// WP-06 (ADM-19) deliberately adds a pathway chip to the staff candidate list
// with the switch on: three additive keys on GET /api/ceo/candidates
// (`au_pathway_enabled`, `pathway_filters`, and one `au` object per row).
// They are dropped here so everything else is still compared byte for byte,
// and asserted exactly in the test below.
function dropWp06StaffKeys(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.candidates)) return body;
  const out = Object.assign({}, body);
  delete out.au_pathway_enabled;
  delete out.pathway_filters;
  // WP-26: the Australian stages for the stage filter (switch on only).
  delete out.au_stage_filters;
  delete out.au_schema_missing;
  out.candidates = body.candidates.map(function (row) {
    const copy = Object.assign({}, row);
    delete copy.au;
    return copy;
  });
  return out;
}

function comparable(res, dropAuKeys) {
  let body = dropWp06StaffKeys(res.json);
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

  // WP-08 adds eleven columns (role fields, the server-owned preferred
  // locations list, the reviewed stamp) and rewires every place that decided
  // "may this doctor have this role?". With the switch off none of those flows
  // may name a WP-08 column, a WP-02 column or table, a WP-06 name or a WP-03
  // stage value, and each must answer exactly as it does on main.
  it('WP-08 flows: careers list, role page, apply, caps, matching inputs, job editor, intent, re-entry: no new name', async () => {
    const rule = (r) => wp02NewNameViolation(r, NAMES) || wp03NewStageViolation(r) || wp06NewNameViolation(r) || wp08NewNameViolation(r);
    // The rule can catch a leak.
    expect(wp08NewNameViolation({ table: 'career_roles', query: '?select=id,vr_requirement', select: ['id', 'vr_requirement'], body: null })).toBe('mentions vr_requirement');
    expect(wp08NewNameViolation({ table: 'career_roles', query: '?id=eq.1', select: null, bodyKeys: ['dpa', 'dpa_status'], body: { dpa: true, dpa_status: 'yes' } })).toBe('mentions dpa_status');
    expect(wp08NewNameViolation({ table: 'career_roles', query: '?select=id,special_interests', select: ['id', 'special_interests'], body: null })).toBe('career_roles.special_interests');
    expect(wp08NewNameViolation({ table: 'user_profiles', query: '?user_id=eq.1', select: null, bodyKeys: ['preferred_locations'], body: { preferred_locations: ['Sydney'] } })).toBe('mentions preferred_locations');
    expect(wp08NewNameViolation({ table: 'gp_credentials', query: '', select: null, bodyKeys: ['flags_reviewed_at'], body: [{ flags_reviewed_at: 'x' }] })).toBe('mentions flags_reviewed_at');
    expect(wp08NewNameViolation({ table: 'career_roles', query: '?select=*&is_active=eq.true', select: ['*'], body: null })).toBe('');
    expect(wp08NewNameViolation({ table: 'career_roles', query: '?id=eq.1', select: null, bodyKeys: ['dpa', 'summary'], body: { dpa: true, summary: 'x' } })).toBe('');
    expect(Object.keys(WP08_NEW_COLUMN_NAMES).sort()).toEqual(['career_roles', 'gp_credentials', 'user_profiles']);

    h.setSwitch(false);
    h.emu.reset();
    h.emu.forbid(rule);
    const ROLE_DPA = 'internal_ats:ats_dpa1';
    const ROLE_NON_DPA = 'internal_ats:ats_nondpa1';
    // Both the overseas doctor and the stored au_vr doctor (who, with the switch
    // off, is an overseas doctor whose country reads Australia).
    for (const d of [gp, auGp]) {
      const cookie = h.gpCookie(d.email, d.userId);
      const list = await h.get('/api/career/roles', { cookie });
      expect(list.status, d.kind).toBe(200);
      expect(list.json.auHold, d.kind).toBeUndefined();
      expect(list.raw, d.kind).not.toMatch(/auFacts|distanceKm/);
      expect((await h.get('/api/career/role?id=' + encodeURIComponent(ROLE_DPA), { cookie })).status, d.kind).toBe(200);
      expect((await h.get('/api/career/role?id=' + encodeURIComponent(ROLE_NON_DPA), { cookie })).status, d.kind).toBe(200);
      expect((await h.get('/api/career/application-usage', { cookie })).json, d.kind).toMatchObject({ active: { limit: 2 }, monthly: { limit: 3 } });
      expect((await h.get('/api/career/interview-usage', { cookie })).json.limit, d.kind).toBe(3);
      expect((await h.get('/api/career/matches', { cookie })).status, d.kind).toBe(200);
    }
    // Apply: the overseas doctor is refused the non-DPA role with today's body
    // and accepted for the DPA role.
    const gpCookie = h.gpCookie(gp.email, gp.userId);
    const refused = await h.post('/api/career/apply', { roleId: ROLE_NON_DPA }, { cookie: gpCookie });
    expect(refused.raw).toBe(JSON.stringify({ ok: false, error: 'not_qualified', message: "You don't currently qualify for this role." }));
    expect((await h.post('/api/career/apply', { roleId: ROLE_DPA }, { cookie: gpCookie })).status).toBe(200);

    // Staff: the job editor (read, an ordinary edit, a DPA flip, and the new
    // keys, which are ignored), a manual add, and the eligibility endpoint,
    // which does not exist.
    const admin = h.superAdmin();
    const editor = await h.get('/api/ats/job?id=role-nondpa-1', admin);
    expect(editor.status).toBe(200);
    expect(editor.json.editor.au_role_fields).toBeUndefined();
    const patchJob = (body) => h.request('PATCH', '/api/ats/job?id=role-nondpa-1', Object.assign({}, admin, { body }));
    expect((await patchJob({ summary: 'FAKE summary (switch off).' })).status).toBe(200);
    expect((await patchJob({ dpa: true })).status).toBe(200);
    expect((await patchJob({ dpa: false, vr_requirement: 'non_vr_accepted', dpa_status: 'unknown', sessions_min: 2, accepts_supervised: true })).status).toBe(200);
    expect((await h.post('/api/ats/job/candidate', { user_id: auGp.userId, career_role_id: 'role-nondpa-1', stage: 'applied' }, admin)).status).toBe(200);
    expect((await h.get('/api/ats/candidate/role-eligibility?user_id=' + gp.userId, admin)).status).toBe(404);

    // The helpers behind matching, caps, re-entry, start dates and intent.
    const inputs = await t.atsBuildGpMatchInputs([gp.userId, auGp.userId]);
    expect(inputs[gp.userId].dpaEligible).toBe(false);
    expect(inputs[auGp.userId].dpaEligible).toBe(true);        // the country rule, as on main
    expect(inputs[auGp.userId].au).toBeUndefined();
    expect(await t.auCapsForUser(auGp.userId)).toMatchObject({ active: 2, monthly: 3, interviewsMonthly: 3 });
    expect((await t.auPlacedReentryAllowed(auGp.userId)).allowed).toBe(false);
    expect(await t.auStartDateForUser(auGp.userId)).toBe(null);
    expect(await t.auIntentFactsFor(auGp.userId, {})).toBe(null);
    expect((await t.auWritePreferredLocations(auGp.userId, ['Sydney'])).reason).toBe('feature_off');
    expect(await t.auReadPreferredLocations(auGp.userId)).toEqual([]);
    expect((await t.auAttachRoleFields([{ id: 'role-dpa-1', dpa: true }]))[0]).toEqual({ id: 'role-dpa-1', dpa: true });
    expect((await t.auFlagHeldDoctor(auGp.userId, { pathway: 'au_non_vr' }, 'test')).raised).toBe(false);
    // The nightly intent score, for every case.
    const cron = await h.get('/api/cron/recompute-intent', { headers: { Authorization: 'Bearer test-cron-secret' } });
    expect(cron.status).toBe(200);

    await new Promise((r) => setTimeout(r, 200));
    expect(h.emu.violations).toEqual([]);
    expect(h.emu.requests.length).toBeGreaterThan(30);
    // Nothing was written to career_roles beyond what main writes.
    const roleWrites = h.emu.requests.filter((r) => r.table === 'career_roles' && r.method === 'PATCH').map((r) => Object.keys(r.body).sort().join(','));
    roleWrites.forEach((keys) => expect(keys).not.toMatch(/vr_requirement|dpa_status|sessions_|accepts_/));
  });

  // WP-09 adds five consent columns to gp_applications. With the switch off
  // nothing may name one, across every flow WP-09 touched: the role page,
  // applying, accepting a match, staff submitting to the practice, the
  // decision page and the verbal-consent route (which does not exist).
  it('WP-09 flows: role page, apply, staff submit, decision page: no consent column is named and no consent is asked for', async () => {
    const rule = (r) => wp02NewNameViolation(r, NAMES) || wp03NewStageViolation(r) || wp06NewNameViolation(r) || wp08NewNameViolation(r) || wp09NewNameViolation(r);
    // The rule can catch a leak.
    expect(wp09NewNameViolation({ table: 'gp_applications', query: '?id=eq.1', body: { profile_share_consent_at: 'x' } })).toBe('mentions a profile_share_consent column');
    expect(wp09NewNameViolation({ table: 'gp_applications', query: '?select=id,profile_share_consent_role_id', body: null })).toBe('mentions a profile_share_consent column');
    expect(wp09NewNameViolation({ table: 'gp_applications', query: '?select=*&id=eq.1', body: { status: 'review' } })).toBe('');
    expect(WP09_NEW_COLUMN_NAMES.gp_applications).toHaveLength(5);

    h.setSwitch(false);
    h.emu.reset();
    // A contact for the DPA role so the introduction really is sent.
    h.emu.table('career_roles').filter((r) => r.id === 'role-dpa-1')[0].contact_email = 'manager@regional-practice.gplink-test.local';
    h.emu.table('user_documents').push({ id: 'doc-cv-au', user_id: auGp.userId, document_key: 'career_cv', status: 'uploaded', file_name: 'cv.pdf', created_at: NOW, updated_at: NOW });
    // An earlier case in this file may already have applied these two doctors
    // to the DPA role: start from "not applied".
    const apps = h.emu.table('gp_applications');
    for (let i = apps.length - 1; i >= 0; i--) {
      if (String(apps[i].career_role_id) === 'role-dpa-1' && (apps[i].user_id === gp.userId || apps[i].user_id === auGp.userId)) apps.splice(i, 1);
    }
    h.emu.forbid(rule);
    const ROLE_DPA = 'internal_ats:ats_dpa1';
    const admin = h.superAdmin();
    // Both the overseas doctor and the stored au_vr doctor, who with the
    // switch off is an overseas doctor.
    for (const d of [gp, auGp]) {
      const cookie = h.gpCookie(d.email, d.userId);
      const detail = await h.get('/api/career/role?id=' + encodeURIComponent(ROLE_DPA), { cookie });
      expect(detail.status, d.kind).toBe(200);
      expect(detail.raw, d.kind).not.toContain('auShareConsent');
      const applied = await h.post('/api/career/apply', { roleId: ROLE_DPA }, { cookie });
      expect(applied.status, d.kind + ' ' + applied.raw).toBe(200);
      expect(applied.raw, d.kind).not.toMatch(/consent/i);
      const app = h.emu.table('gp_applications').filter((a) => a.user_id === d.userId && String(a.career_role_id) === 'role-dpa-1')[0];
      expect(Object.keys(app).filter((k) => /consent/.test(k)), d.kind).toEqual([]);
      // This file boots with no email key, so the submit runs every read and
      // builds the introduction, then stops at the send (502): never a consent
      // refusal (409). The full send with the switch off is proved in
      // tests/au-wp09-server.test.js and tests/au-wp09-overseas-intro-parity.test.js.
      // (Applying links the role to a practice row; give that row a contact too.)
      h.emu.table('practices').forEach((p) => { if (!p.contact_email) p.contact_email = 'manager@regional-practice.gplink-test.local'; });
      const submitted = await h.post('/api/admin/career/application/submit-to-practice', { applicationId: app.id }, admin);
      expect(submitted.status, d.kind + ' ' + submitted.raw).toBe(502);
      expect(submitted.raw, d.kind).not.toMatch(/consent/i);
      // The decision page for that application (give it a link, as a sent one has).
      const stored = h.emu.table('gp_applications').filter((a) => a.id === app.id)[0];
      stored.practice_action_token = 'tok_wp09_off_' + (d === gp ? 'a' : 'b');
      stored.practice_submission_status = 'submitted_to_practice';
      const page = await h.get('/api/practice/application/decision-context?token=' + stored.practice_action_token, { headers: { 'x-real-ip': '10.9.9.' + (d === gp ? 1 : 2) } });
      if (page.status === 200) {
        expect(Object.keys(page.json.candidate).sort(), d.kind).toEqual(['facts', 'hasCv', 'paragraph', 'recommendation']);
        expect(page.json.candidate.paragraph, d.kind).toContain('internationally trained GP');
      } else {
        expect(page.status, d.kind).toBe(429); // this boot has no rate-limit function: the page is refused, nothing leaks
      }
      expect((await h.post('/api/admin/career/application/share-consent', { applicationId: app.id, note: 'By phone, 20 Nov' }, admin)).status, d.kind).toBe(404);
    }
    // The helpers.
    expect(await t.auPracticeIntroFor(auGp.userId, {}, 'Test Auvr')).toBe(null);
    expect(await t.auShareConsentGate({ id: 'x', user_id: auGp.userId })).toEqual({ isAu: false });
    expect((await t.auRecordProfileShareConsent({ id: 'x', user_id: auGp.userId, career_role_id: 1 }, { source: 'doctor' })).reason).toBe('feature_off');
    await new Promise((r) => setTimeout(r, 200));
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

  // WP-12 adds five columns to pbs_applications and the au_gp_doctor_details
  // table. With the switch off: the doctor's Australian routes and pages do
  // not exist, the provider-number and Account helpers refuse and ask nothing,
  // Home / the PBS page / the registration introduction are today's files, the
  // "can I proceed?" answer is today's, and no request names a new column or
  // the new table, for an overseas doctor AND for a stored Australian one.
  it('WP-12 flows: Home, the PBS page, can-proceed, roles, applications, the doctor routes and the helpers: no new name', async () => {
    const rule = (r) => wp02NewNameViolation(r, NAMES) || wp03NewStageViolation(r) || wp06NewNameViolation(r) || wp08NewNameViolation(r) || wp09NewNameViolation(r) || wp11NewNameViolation(r) || wp12NewNameViolation(r);
    expect(wp12NewNameViolation({ table: 'au_gp_doctor_details', query: '?select=*', body: null })).toBe('uses table au_gp_doctor_details');
    expect(wp12NewNameViolation({ table: 'pbs_applications', query: '', body: { au_location_name: 'x' } })).toBe('mentions an au_location_ column');
    expect(wp12NewNameViolation({ table: 'pbs_applications', query: '?select=*&user_id=eq.1', body: { provider_number: '123456AB' } })).toBe('');
    expect(WP12_NEW_COLUMN_NAMES.pbs_applications).toHaveLength(5);
    expect(WP12_NEW_TABLES).toEqual(['au_gp_doctor_details']);

    h.setSwitch(false);
    h.emu.forbid(rule);
    const embedded = '?gp_shell=embedded&gp_shell_static=1';
    for (const d of [gp, auGp]) {
      const who = { cookie: h.gpCookie(d.email, d.userId) };
      // the Australian routes do not exist
      for (const u of ['/api/gp/au-prestart', '/api/account/au-details']) expect((await h.get(u, who)).status, u).toBe(404);
      for (const u of ['/api/gp/au-prestart/notice', '/api/gp/au-prestart/referees', '/api/gp/au-prestart/provider-details', '/api/account/au-details']) {
        expect((await h.post(u, { given: true, date: '2026-11-01', referees: [], newLocationProviderNumber: '123456AB' }, who)).status, u).toBe(404);
      }
      // the pages are today's, and the three Australian files are not served
      const home = await h.get('/pages/index' + embedded, who);
      expect(home.raw).toContain('<title>Dashboard - GP Link</title>');
      for (const p of ['/pages/prestart', '/pages/index-au', '/pages/pbs-au']) {
        const r = await h.get(p + embedded, who);
        expect([p, r.status, r.headers.location]).toEqual([p, 302, '/pages/index']);
      }
      expect((await h.get('/pages/pbs' + embedded, who)).status).toBe(302); // position-locked, as today
      expect((await h.get('/pages/registration-intro' + embedded, who)).raw).not.toContain('auHomeRoot');
      // today's answers
      const cp = await h.get('/api/registration/can-proceed', who);
      expect(Object.keys(cp.json.steps)).toEqual(['career', 'ahpra', 'visa', 'pbs', 'commencement']);
      const roles = await h.get('/api/career/roles', who);
      expect(roles.status).toBe(200);
      expect('auRegistrationPending' in roles.json).toBe(false);
      expect((await h.get('/api/career/applications', who)).status).toBe(200);
      expect((await h.get('/api/pbs/status', who)).status).toBe(200);
      const session = await h.get('/api/auth/session', who);
      expect(Object.keys(session.json).sort()).toEqual(['authenticated', 'ok', 'profile']);
    }
    // every WP-12 helper refuses and asks nothing
    const before = h.emu.requests.length;
    expect(await t.auReadDoctorDetails(auGp.userId)).toEqual({ ok: false, row: null, schemaMissing: false });
    expect(await t.auWriteDoctorDetails(auGp.userId, { notice_given: true })).toEqual({ ok: false, reason: 'feature_off' });
    expect((await t.auReadNewLocationProviderNumber(auGp.userId, '', [])).recorded).toBe(false);
    expect((await t.auRecordProviderNumber(auGp.caseId, { providerNumber: '123456AB' }, 'staff')).status).toBe(404);
    expect(h.emu.requests.length).toBe(before);
    expect(h.emu.violations).toEqual([]);
    expect(h.emu.table('au_gp_doctor_details')).toEqual([]);
    h.emu.forbid(null);
  });

  // WP-13 adds fifteen columns to `placements`. With the switch off nothing
  // may name one: not the commencement routes (they do not exist), not the
  // daily job (it returns at once), not the exports (today's columns only),
  // not the placement list or anything a doctor's browser asks for. (A whole
  // placement recorded with the switch off, through every entry point, is
  // covered byte for byte by tests/au-wp11-overseas-parity.test.js; the
  // commencement actions and the job against a stored placement are covered
  // against this same rule in tests/au-wp13-server.test.js.)
  it('WP-13 flows: the commencement routes, the daily job, the exports, the placement list and the helpers: no new name', async () => {
    const rule = (r) => wp02NewNameViolation(r, NAMES) || wp03NewStageViolation(r) || wp06NewNameViolation(r) || wp08NewNameViolation(r) || wp09NewNameViolation(r)
      || wp11NewNameViolation(r) || wp12NewNameViolation(r) || wp13NewNameViolation(r);
    expect(wp13NewNameViolation({ table: 'placements', query: '?select=*&commenced_at=not.is.null', body: null })).toBe('names the WP-13 column placements.commenced_at');
    expect(wp13NewNameViolation({ table: 'placements', query: '?id=eq.1', body: { invoice_sent_at: '2027-02-01' } })).toBe('names the WP-13 column placements.invoice_sent_at');
    expect(wp13NewNameViolation({ table: 'placements', query: '?select=*&user_id=eq.1&status=eq.active', body: null })).toBe('');
    expect(wp13NewNameViolation({ table: 'user_profiles', query: '?select=candidate_basis', body: null })).toBe('');   // WP-02's column of the same name, another table
    expect(WP13_NEW_COLUMN_NAMES.placements).toHaveLength(15);

    h.setSwitch(false);
    // an overseas placement already on record, and a commenced Australian one left over from when the switch was on
    h.emu.table('placements').push(
      { id: 'pl-wp13-uk', user_id: gp.userId, application_id: 'app-wp13-uk', practice_name: 'Test Regional Practice (FAKE)', job_title: 'GP', start_date: '2027-03-01', status: 'active', placed_at: NOW, created_at: NOW },
      { id: 'pl-wp13-au', user_id: auGp.userId, application_id: 'app-wp13-au', practice_name: 'Test Metro Practice (FAKE)', job_title: 'GP', start_date: '2026-10-01', status: 'active', placed_at: NOW, created_at: NOW,
        commenced_at: '2026-10-01', guarantee_ends_at: '2026-12-24', fee_tier: 'part_time', invoice_due_at: '2026-10-01' }
    );
    h.emu.forbid(rule);
    const before = h.emu.requests.length;
    for (const d of [gp, auGp]) {
      // the routes do not exist, for anyone
      expect((await h.get('/api/admin/au/commencement?case_id=' + d.caseId, h.superAdmin())).status).toBe(404);
      for (const action of ['confirm', 'correct', 'undo', 'invoice-sent', 'invoice-paid', 'early-exit', 'credit-decision', 'close']) {
        const res = await h.post('/api/admin/au/commencement/' + action, { case_id: d.caseId, commenced_at: '2026-11-01', sessions_per_week: 8, sent_at: '2026-11-02', reference: 'INV-1', paid_at: '2026-11-03', last_working_day: '2026-11-10', reason: 'doctor_resigned' }, h.superAdmin());
        expect(res.status, action).toBe(404);
      }
      // the helpers refuse and ask nothing
      expect(await t.auCommencement.confirmCommencement(d.caseId, { commenced_at: '2026-11-01', sessions_per_week: 8 }, STAFF_EMAIL)).toMatchObject({ ok: false, status: 404 });
      expect(await t.auCommencement.recordEarlyExit(d.caseId, { last_working_day: '2026-11-10', reason: 'doctor_resigned' }, STAFF_EMAIL)).toMatchObject({ ok: false, status: 404 });
      expect(await t.auCommencement.staffView(d.caseId, 'super_admin')).toMatchObject({ ok: false, status: 404 });
    }
    expect(await t.runAuLifecycleSweep(Date.now() + 400 * 86400000)).toMatchObject({ ok: false, reason: 'feature_off', fired: [] });
    expect(await t.auPlacementCommercialSummary()).toMatchObject({ ok: false, invoicesDue: [], inGuarantee: [], guaranteeEndingSoon: [] });
    expect(h.emu.requests.length).toBe(before);          // none of that touched the database at all

    // the daily job's host, the exports and the placement list are today's
    const sla = await h.get('/api/cron/sla-sweep', { headers: { Authorization: 'Bearer test-cron-secret' } });
    expect(sla.status).toBe(200);
    expect(Object.keys(sla.json).sort()).toEqual(['buckets', 'checked', 'created', 'ok']);
    const pl = await h.get('/api/admin/export?entity=placements&format=csv', h.superAdmin());
    expect(pl.status).toBe(200);
    expect(pl.raw.split('\r\n')[0]).toBe('GP,Practice,Role,Location,Secured,Commencement');
    const gps = await h.get('/api/admin/export?entity=gps&format=csv', h.superAdmin());
    expect(gps.raw.split('\r\n')[0]).toBe('Name,Email,Country,Registration stage,Assigned RSO,Created');
    expect((await h.get('/api/ats/placements', h.superAdmin())).status).toBe(200);
    for (const d of [gp, auGp]) {
      const who = { cookie: h.gpCookie(d.email, d.userId) };
      expect((await h.get('/api/career/applications', who)).status).toBe(200);
      expect((await h.get('/api/state', who)).status).toBe(200);
      expect((await h.get('/api/gp/au-prestart', who)).status).toBe(404);
    }
    expect(h.emu.violations).toEqual([]);
    // the stored rows are exactly as they were
    expect(h.emu.table('placements').find((p) => p.id === 'pl-wp13-au')).toMatchObject({ commenced_at: '2026-10-01', status: 'active', fee_tier: 'part_time' });
    expect(Object.keys(h.emu.table('placements').find((p) => p.id === 'pl-wp13-uk')).sort()).toEqual(['application_id', 'created_at', 'id', 'job_title', 'placed_at', 'practice_name', 'start_date', 'status', 'user_id']);
    h.emu.forbid(null);
  });

  // WP-14 adds seven columns to `visa_applications` and its own task kinds. With
  // the switch off none of it may be named, the staff and doctor routes do not
  // exist, the visa module and the supervised-practice jobs behave exactly as
  // they did (for an overseas doctor AND for a doctor whose stored pathway is
  // Australian, who is an overseas doctor while the switch is off), and
  // regulator mail goes down today's pipeline.
  it('WP-14 flows: the visa module, the segment B routes, the supervised-practice jobs, regulator mail and the helpers: no new name', async () => {
    const rule = (r) => wp02NewNameViolation(r, NAMES) || wp03NewStageViolation(r) || wp06NewNameViolation(r) || wp08NewNameViolation(r) || wp09NewNameViolation(r)
      || wp11NewNameViolation(r) || wp12NewNameViolation(r) || wp13NewNameViolation(r) || wp14NewNameViolation(r);
    expect(wp14NewNameViolation({ table: 'visa_applications', query: '?select=*&case_type=eq.nomination_transfer', body: null })).toBe('names the WP-14 column visa_applications.case_type');
    expect(wp14NewNameViolation({ table: 'visa_applications', query: '?id=eq.1', body: { current_sponsor_name: 'x' } })).toBe('names the WP-14 column visa_applications.current_sponsor_name');
    expect(wp14NewNameViolation({ table: 'registration_tasks', query: '', body: [{ metadata: { lifecycle_kind: 'visa_transfer_decision' } }] })).toBe('mentions visa_transfer_decision');
    expect(wp14NewNameViolation({ table: 'visa_applications', query: '?select=*&user_id=eq.1&order=created_at.desc&limit=1', body: null })).toBe('');
    expect(wp14NewNameViolation({ table: 'visa_applications', query: '', body: [{ user_id: 'u', stage: 'nomination', visa_subclass: '482', sponsor_name: 'x' }] })).toBe('');
    expect(WP14_NEW_COLUMN_NAMES.visa_applications).toHaveLength(7);
    expect(WP14_NEW_NAMES.length).toBeGreaterThan(5);

    h.setSwitch(false);
    for (const name of ['visa_applications', 'visa_timeline_events', 'visa_documents', 'visa_updates', 'visa_dependants', 'task_messages', 'processed_gmail_messages']) h.emu.table(name);
    h.emu.forbid(rule);
    const before = h.emu.requests.length;
    for (const d of [gp, auGp]) {
      // the staff routes do not exist, for anyone
      expect((await h.get('/api/admin/au/segment-b?case_id=' + d.caseId, h.superAdmin())).status).toBe(404);
      for (const action of ['visa-transfer/decision', 'visa-transfer/update', 'visa-transfer/nomination-approved', 'ahpra-outcome', 'dpa-19ab', 'n21-preview', 'n21-send']) {
        const res = await h.post('/api/admin/au/segment-b/' + action, { case_id: d.caseId, decision: 'confirm', current_sponsor: 'Test Old Practice (FAKE)', visa_expiry: '2028-01-31', applies: 'no', note: 'switch-off check', to: ['gp'], confirm: true }, h.superAdmin());
        expect(res.status, action).toBe(404);
      }
      // the helpers answer "overseas" / nothing, and ask nothing
      expect((await t.auVisaStageForUser(d.userId)).verdict).toEqual({ mode: 'overseas', reason: null });
      expect(await t.auVisaCaseCreationBlock(d.userId)).toBe(null);
      expect(await t.auDoctorTransferPageView(d.userId)).toBe(null);
      expect(await t.auOnSegmentBDocumentFiled(d.userId, 'au_supervision_plan')).toBe(null);
      expect(await t.auNoteSupervisionPaperworkComplete(d.caseId, d.userId)).toBe(null);
      expect(await t.auAhpraMailRouteForCase({ id: d.caseId, user_id: d.userId, stage: 'ahpra' })).toBe('overseas');
      expect(await t.auEmailRoutingPathwayFor({ id: d.caseId, user_id: d.userId, stage: 'ahpra' })).toBe(null);
      const index = await t.auSweepPathwayIndex('wp14-off');
      expect(await t.auSupervisedSweepVerdict(index, d.userId, 'sppa00Task')).toBe('overseas');
      expect(await t.auSupervisedSweepVerdictForCase(index, d.caseId, 'sppa00Task')).toBe('overseas');
    }
    expect(await t.auSegmentBAhpraMailCandidates()).toEqual([]);
    expect(h.emu.requests.length).toBe(before);          // none of that touched the database at all

    for (const d of [gp, auGp]) {
      const who = { cookie: h.gpCookie(d.email, d.userId) };
      // the doctor-facing visa module is today's, for both (a stored Australian pathway is invisible with the switch off)
      expect((await h.get('/api/visa/status', who)).status, d.kind).toBe(200);
      expect((await h.get('/api/visa/timeline', who)).status, d.kind).toBe(200);
      expect((await h.get('/api/gp/au-visa-transfer', who)).status, d.kind).toBe(404);
      // staff open a fresh visa case exactly as before, with exactly the columns they always wrote
      const made = await h.post('/api/visa/update', { userId: d.userId, stage: 'nomination', visaSubclass: '482', sponsorName: 'Test Sponsor (FAKE)' }, h.rso());
      expect([200, 201], d.kind).toContain(made.status);   // 200 when an earlier flow in this file already opened one
      const row = h.emu.table('visa_applications').find((x) => x.user_id === d.userId);
      for (const col of WP14_NEW_COLUMN_NAMES.visa_applications) expect(Object.prototype.hasOwnProperty.call(row, col), d.kind + ' ' + col).toBe(false);
      await t.processVisaTaskAutomation(row.id, d.userId, { stage: 'lodgement' }, STAFF_EMAIL);
      await t.pushVisaNotificationToOwner(row.id, { type: 'action', title: 'Visa stage updated', detail: 'Your visa case has moved to Lodgement' });
      // regulator mail matched to this doctor's case takes today's pipeline (the six-mode card), never an Australian route
      await t._processAhpraEmail({ sender: 'Test Officer <officer@ahpra.gov.au>', to: d.email, subject: 'Query about your application', bodyText: 'Please reply.', threadId: 'thr-off-' + d.userId, rfc822MessageId: '<off-' + d.userId + '@ahpra.gov.au>', attachments: [] },
        'gm-off-' + d.userId, { id: d.caseId, user_id: d.userId, stage: 'ahpra' }, {});
      const card = h.emu.table('registration_tasks').find((x) => x.source_gmail_message_id === 'gm-off-' + d.userId);
      expect(card, d.kind).toBeTruthy();
      expect(card.source_trigger, d.kind).toBe('ahpra_officer_email');
      expect(card.related_stage, d.kind).toBe('ahpra');
    }
    // the supervised-practice jobs and the docs notifier run with no pathway read
    for (const job of ['/api/cron/chase-nonresponders', '/api/cron/sppa-backfill-scan', '/api/cron/reconcile-doc-tasks']) {
      expect((await h.get(job, { headers: { Authorization: 'Bearer test-cron-secret' } })).status, job).toBe(200);
    }
    for (const d of [gp, auGp]) await t._maybeNotifyAhpraDocsReady(d.caseId);
    expect(h.emu.violations).toEqual([]);
    h.emu.forbid(null);
  });

  // WP-11 adds no column, table or constraint value. What it must not do with
  // the switch off: read a pathway, write one of the Australian task types,
  // write its server-owned state keys, its ledger keys or its timeline markers.
  // (The full placement, through every entry point, is covered against the
  // same rule in tests/au-wp11-staff-actions-server.test.js and byte for byte
  // in tests/au-wp11-overseas-parity.test.js.)
  it('WP-11 flows: a placement, the state sync, a card moved to Hired, manual tasks, the staff guards: no new name', async () => {
    const rule = (r) => wp02NewNameViolation(r, NAMES) || wp03NewStageViolation(r) || wp06NewNameViolation(r) || wp11NewNameViolation(r);
    expect(wp11NewNameViolation({ query: '', body: { state: { gp_au_placement_hold: { at: 'x' } } } })).toBe('mentions gp_au_placement_hold');
    expect(wp11NewNameViolation({ query: '?nudge_key=eq.au_task:start_date_tracking:x', body: null })).toBe('mentions au_task:');
    expect(wp11NewNameViolation({ query: '?select=state&user_id=eq.1', body: { state: { gp_link_updates: [] } } })).toBe('');
    expect(WP11_NEW_NAMES.length).toBeGreaterThan(5);

    h.setSwitch(false);
    const placed = buildAuDoctor('au_vr', { idSuffix: '71', caseRow: { stage: 'career', pathway: null }, state: { gp_career_state: { career_secured: false } } });
    const db = buildAuFixtureDb([placed]);
    Object.keys(db).forEach((table) => db[table].forEach((row) => h.emu.table(table).push(row)));
    const app = { id: 'app-wp11-off', user_id: placed.userId, career_role_id: null, ats_stage: 'offer', status: 'offer', provider_role_id: '' };
    const card = { id: 'app-wp11-card', user_id: placed.userId, career_role_id: null, ats_stage: 'interview', status: 'interview', provider_role_id: '' };
    h.emu.table('gp_applications').push(app, card);
    const caseId = h.emu.table('registration_cases').find((c) => c.user_id === placed.userId).id;
    h.emu.forbid(rule);

    // The placement itself (the same call the three placement routes make).
    await t.finalizeInAppPlacementForTest(Object.assign({}, app), { id: 'offer-wp11-off', application_id: app.id, user_id: placed.userId, status: 'sent', practice_name: 'Test Metro Practice (FAKE)', job_title: 'GP', sent_by: STAFF_EMAIL },
      placed.userId, placed.email, { placementConfirmed: true });
    // The doctor's browser syncs, including its own bell list.
    expect((await h.put('/api/state', { state: { gp_link_updates: '[]', gp_career_intro_seen: true }, updatedAt: new Date().toISOString() }, { cookie: h.gpCookie(placed.email, placed.userId) })).status).toBe(200);
    // A card moved to Offer, then to Hired: allowed, and no task is raised.
    for (const stage of ['offer', 'hired']) {
      expect((await h.request('PATCH', '/api/ats/application?id=' + card.id, Object.assign({ body: { stage } }, h.consultant()))).status, stage).toBe(200);
    }
    // Manual task creation: today's types work, an Australian type is refused with nothing written.
    expect((await h.post('/api/admin/tasks', { case_id: caseId, title: 'An ordinary task' }, h.superAdmin())).status).toBe(201);
    const writesBefore = h.emu.requests.filter((r) => r.method !== 'GET').length;
    expect((await h.post('/api/admin/tasks', { case_id: caseId, title: 'x', task_type: 'credentialing_pack' }, h.superAdmin())).status).toBe(502);
    expect(h.emu.requests.filter((r) => r.method !== 'GET').length).toBe(writesBefore);
    // The staff routes do not exist.
    expect((await h.get('/api/admin/au/task-types', h.superAdmin())).status).toBe(404);
    expect((await h.get('/api/admin/au/prestart?case_id=' + caseId, h.superAdmin())).status).toBe(404);
    // The overseas practice actions are not refused, and no pathway is read for them.
    expect((await h.post('/api/admin/redeliver-section-g', { case_id: caseId }, h.superAdmin())).status).not.toBe(409);
    expect((await h.post('/api/admin/tasks', { case_id: caseId, title: 'Supervisor CV', task_type: 'practice_pack_child', related_document_key: 'supervisor_cv' }, h.superAdmin())).status).toBe(201);
    // Every WP-11 helper refuses and asks nothing.
    const before = h.emu.requests.length;
    expect((await t.auPlacementHooksForUser(placed.userId)).hooks.column).toBe('overseas');
    expect(await t.auRunPlacementHooks(placed.userId, { force: true })).toEqual({ ok: false, ran: false, reason: 'feature_off' });
    await t.auSyncPrestartTasks(placed.userId);
    await t.auPrestartComplete(caseId);
    await t.auOnApplicationStage(placed.userId, card, 'offer');
    await t.runAuPrestartSweep({});
    await t.auOverseasPracticeActionRefusal({ caseId }, 'sppa');
    expect(h.emu.requests.length).toBe(before);

    await new Promise((r) => setTimeout(r, 300));
    expect(h.emu.violations).toEqual([]);
    // Today's cascade ran for this doctor: the overseas pack, no Australian task.
    const tasks = h.emu.table('registration_tasks').filter((x) => x.case_id === caseId);
    expect(tasks.filter((x) => x.task_type === 'practice_pack_child' && x.source_trigger === 'career_secured').map((x) => x.related_document_key).sort())
      .toEqual(['offer_contract', 'position_description', 'section_g', 'sppa_00', 'supervisor_cv']);
    expect(tasks.filter((x) => WP06_NEW_TASK_TYPES.indexOf(x.task_type) !== -1)).toEqual([]);
    const state = h.emu.table('user_state').find((r) => r.user_id === placed.userId).state;
    expect(state.gp_au_bell_pending).toBeUndefined();
    expect(state.gp_au_placement_hold).toBeUndefined();

    // Leave the shared fixtures as they were: later cases count the doctors
    // on an Australian pathway.
    h.emu.forbid(null);
    for (const table of ['user_profiles', 'gp_credentials', 'registration_cases', 'user_state', 'gp_applications', 'placements', 'ats_offers']) {
      const rows = h.emu.table(table);
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].user_id === placed.userId) rows.splice(i, 1);
    }
  });

  it('WP-15 flows: the lead form, the Leads tab, a booking and the onboarding pre-fill: nothing new is read or written', async () => {
    // WP-15 added no column and no table (the segment lives in the existing
    // site_enquiries.metadata JSON and scheduled_calls.notification_channels).
    // With the switch off none of it is written, and no earlier package's new
    // name is touched on the way.
    const rule = (r) => wp02NewNameViolation(r, NAMES) || wp03NewStageViolation(r) || wp06NewNameViolation(r) || wp08NewNameViolation(r) || wp09NewNameViolation(r)
      || wp11NewNameViolation(r) || wp12NewNameViolation(r) || wp13NewNameViolation(r) || wp14NewNameViolation(r);
    h.setSwitch(false);
    for (const name of ['site_enquiries', 'scheduled_calls', 'webhook_events']) h.emu.table(name).length = 0;
    h.emu.forbid(rule);
    const before = h.emu.requests.length;
    const email = 'lead.off.wp15@gplink-test.local';
    const res = await h.post('/api/public/consult-lead', {
      name: 'Dr Test Leadoff', email, phone: '+447700900715', country: 'uk', question: '', website: '', utm: {}, tz: 'Australia/Perth',
      ahpraRegistered: true, state: 'WA', vrStatus: 'yes', restriction19ab: 'no', rightToWork: 'citizen_pr', consentVersion: 'au_a1_draft_2026_11'
    }, { headers: { 'x-forwarded-for': '10.15.15.15', 'x-real-ip': '10.15.15.15' } });
    expect(res.status).toBe(200);
    expect(res.json.qualified).toBe(true);
    const lead = h.emu.table('site_enquiries').find((r) => r.email === email);
    expect(Object.keys(lead.metadata.consult).sort()).toEqual(['call_booked', 'country', 'is_gp', 'nudges', 'qualified', 'token']);
    await t.handleCalendlyInviteeCreated({ payload: {
      uri: 'https://api.calendly.com/scheduled_events/EVOFF/invitees/INVOFF', email, name: 'Dr Test Leadoff', timezone: 'Australia/Perth',
      scheduled_event: { uri: 'https://api.calendly.com/scheduled_events/EVOFF', start_time: '2026-12-01T02:00:00.000Z' }, questions_and_answers: [], tracking: {}
    } });
    const call = h.emu.table('scheduled_calls').find((r) => r.invitee_email === email);
    expect(call).toBeTruthy();
    expect(call.notification_channels).toBeUndefined();
    const tab = await h.get('/api/ceo/leads?seg=au', h.superAdmin());
    expect(tab.status).toBe(200);
    expect(tab.json.segment_counts).toBeUndefined();
    expect(tab.json.leads.find((l) => l.email === email).segment).toBeUndefined();
    expect((await h.get('/api/onboarding/au-prefill?lead=1', { cookie: h.gpCookie(email, gp.userId) })).status).toBe(404);
    const made = h.emu.requests.slice(before);
    expect(JSON.stringify(made.map((r) => r.body))).not.toMatch(/"segment"|ahpra_registered|vr_status|restriction_19ab|"lead":\{/);
    expect(h.emu.violations).toEqual([]);
    for (const name of ['site_enquiries', 'scheduled_calls', 'webhook_events']) h.emu.table(name).length = 0;
  });

  it('WP-16 flows: the consult-nudge job, the call reminders, the Leads tab, the lifecycle host and the gates: nothing new is read or written', async () => {
    // WP-16 added no column and no table. Its one new stored value is the
    // go-live instant (runtime_kv key au_lead_copy_live_from), and its one new
    // record is consult.au_log inside the existing site_enquiries.metadata
    // JSON. With the switch off neither is read or written: an
    // Australian-segment lead is an ordinary lead, and no quiet-hours or
    // go-live read happens.
    const rule = (r) => wp02NewNameViolation(r, NAMES) || wp03NewStageViolation(r) || wp06NewNameViolation(r) || wp08NewNameViolation(r) || wp09NewNameViolation(r)
      || wp11NewNameViolation(r) || wp12NewNameViolation(r) || wp13NewNameViolation(r) || wp14NewNameViolation(r)
      || ((r.table === 'runtime_kv' && /au_lead_copy_live_from/.test(String(r.query || '') + JSON.stringify(r.body || ''))) ? 'reads or writes the WP-16 go-live instant' : null);
    h.setSwitch(false);
    for (const name of ['site_enquiries', 'scheduled_calls', 'webhook_events']) h.emu.table(name).length = 0;
    const email = 'lead.off.wp16@gplink-test.local';
    const callAt = new Date(Date.now() + 60 * 60000).toISOString();
    h.emu.table('site_enquiries').push({
      id: 'wp16-off-lead', kind: 'gp', name: 'Dr Test Leadoff', email, phone: '+61400000716', state: 'au', status: 'new',
      created_at: new Date(Date.now() - 90 * 60000).toISOString(),
      metadata: { source: 'gp_consult_form', consult: { token: 'TOKOFF16', qualified: true, country: 'au', segment: 'au_vr', state: 'NSW', call_booked: false, nudges: [] } }
    });
    h.emu.forbid(rule);
    const before = h.emu.requests.length;
    const nudge = await h.get('/api/cron/consult-nudge', { headers: { Authorization: 'Bearer test-cron-secret' } });
    expect(nudge.status).toBe(200);
    expect(nudge.json.au).toBeUndefined();
    // A booked call an hour away, for the reminders job.
    h.emu.table('site_enquiries')[0].metadata.consult.call_booked = true;
    h.emu.table('site_enquiries')[0].metadata.consult.call_at = callAt;
    h.emu.table('scheduled_calls').push({
      id: 'wp16-off-call', meeting_kind: 'consultation', host_kind: 'ceo', status: 'booked', user_id: null, invitee_email: email,
      scheduled_at: callAt, booked_at: new Date(Date.now() - 3 * 86400000).toISOString(), zoom_join_url: 'https://zoom.us/j/5550716',
      notification_channels: {}, invitee_notes: null, timezone: 'Australia/Sydney'
    });
    await t.runConsultCallReminders(Date.now(), 'consult');
    expect((await h.get('/api/cron/consult-nudge', { headers: { Authorization: 'Bearer test-cron-secret' } })).status).toBe(200);
    const tab = await h.get('/api/ceo/leads', h.superAdmin());
    expect(tab.status).toBe(200);
    expect(tab.json.leads[0].au_copy_state).toBeUndefined();
    const one = await h.get('/api/ceo/leads/wp16-off-lead', h.superAdmin());
    expect(Object.keys(one.json.chase)).toEqual(['nudges', 'whatsapp']);
    // The gates and the lifecycle host answer without a read.
    expect(Number.isNaN(await t.auLeadCopyLiveFromMs({ create: true }))).toBe(true);
    expect(await t.auDoctorQuietHoursAllow(auGp.userId, Date.now())).toMatchObject({ allow: true, applies: false });
    expect(await t.runAuLifecycleInHoursPass(Date.parse('2027-01-14T00:00:05Z'))).toBeNull();
    expect(t.auLeadQuietGate(h.emu.table('site_enquiries')[0], 'n01_1h', NaN)).toMatchObject({ allow: true, applies: false });
    const made = h.emu.requests.slice(before);
    expect(made.length).toBeGreaterThan(3);
    expect(JSON.stringify(made.map((r) => r.body))).not.toMatch(/au_log|au_lead_copy_live_from/);
    expect(h.emu.table('site_enquiries')[0].metadata.consult.au_log).toBeUndefined();
    expect(h.emu.table('runtime_kv').filter((r) => r.key === 'au_lead_copy_live_from')).toEqual([]);
    expect(h.emu.violations).toEqual([]);
    for (const name of ['site_enquiries', 'scheduled_calls', 'webhook_events']) h.emu.table(name).length = 0;
  });

  it('WP-17 flows: the welcome, onboarding saves, the hourly reminder job, the staff nudge, the composer list, the role label and the message senders: nothing new is read or written', async () => {
    // WP-17 added no column and no table. Its only new stored values are rows
    // in the EXISTING once-ever ledger (gp_nudge_log) under new keys: every
    // Australian message key (`au_n…`), and the held-welcome keys. With the
    // switch off none is read or written, the pathway is never asked for, and
    // a doctor recorded as Australian is welcomed, reminded and nudged as an
    // overseas doctor.
    const WP17_KEYS = /au_welcome_hold|au_welcome_released|au_message_backfill|au_existing_wa|au_n(0[4-9]|1\d|2[0-2])_/;
    const rule = (r) => wp02NewNameViolation(r, NAMES) || wp03NewStageViolation(r) || wp06NewNameViolation(r) || wp08NewNameViolation(r) || wp09NewNameViolation(r)
      || wp11NewNameViolation(r) || wp12NewNameViolation(r) || wp13NewNameViolation(r) || wp14NewNameViolation(r)
      || (WP17_KEYS.test(String(r.query || '') + JSON.stringify(r.body || '')) ? 'reads or writes a WP-17 ledger key' : null);
    h.setSwitch(false);
    const w = t.__wp17;
    h.emu.forbid(rule);
    const before = h.emu.requests.length;
    // The welcome moment, an onboarding save and completion-style reads.
    await w.sendWelcomeEmail(auGp.userId);
    await w.sendWelcomeEmail(gp.userId);
    const saved = await h.post('/api/onboarding/save', { currentStep: 1, country: 'GB' }, { cookie: h.gpCookie(gp.email, gp.userId) });
    expect(saved.status).toBe(200);
    const savedAu = await h.post('/api/onboarding/save', { currentStep: 0, auBranch: 'yes', au: { step: 1 } }, { cookie: h.gpCookie(auGp.email, auGp.userId) });
    expect(savedAu.status).toBe(200);
    // The hourly job that hosts the Australian reminders and the held-welcome backstop.
    const cron = await h.get('/api/cron/onboarding-nudge', { headers: { Authorization: 'Bearer test-cron-secret' } });
    expect(cron.status).toBe(200);
    expect(cron.json.au_onboarding).toBeUndefined();
    expect(cron.json.au_welcome_held).toBeUndefined();
    // Staff: the nudge default and the composer list, for a doctor recorded as Australian.
    const nudge = await h.post('/api/admin/va/nudge', { user_id: auGp.userId }, h.rso());
    expect(nudge.status).toBe(200);
    expect(nudge.json.nudge.title).not.toBe('Anything we can help with?');
    const tpl = await h.get('/api/admin/email-templates?user_id=' + encodeURIComponent(auGp.userId), h.rso());
    expect(Object.keys(tpl.json).sort()).toEqual(['ok', 'templates']);
    expect(tpl.json.templates.map((x) => x.key)).toContain('welcome_next_steps');
    // The senders and helpers answer without a read.
    const text = 'Your Registration Support Officer will join you.';
    const mid = h.emu.requests.length;
    expect(await w.auRoleLabelText(auGp.userId, text)).toBe(text);
    expect(await w.auRoleCtxForUser(auGp.userId)).toBeNull();
    expect(await w.auExistingDoctorWhatsAppGate(auGp.userId, 'match_invitation')).toEqual({ send: true });
    expect(await w.auWelcomeDecision(auGp.userId)).toEqual({ action: 'overseas', why: 'feature_off' });
    expect(await w.auSendWelcomeMessage(auGp.userId, {})).toBeNull();
    expect(await w.auReleaseHeldWelcome(auGp.userId, 'au')).toEqual({ held: false });
    expect(await w.runAuHeldWelcomeBackstop(Date.now())).toBeNull();
    expect(await w.auSendProfileCompleteMessage(auGp.userId, { isAu: true, pathway: 'au_vr', launched: true })).toBeNull();
    expect(await w.auSendNoticeStartMessages(auGp.userId, 'start_date', { event: true })).toBeNull();
    expect(await w.auMaybeSendClearedToStart(auGp.userId, {})).toBeNull();
    expect(await w.auAfterPrestartChange(auGp.userId, { startDateConfirmed: true })).toBeNull();
    expect(await w.auSendStalledReminder(auGp.userId, { force: true })).toEqual({ ok: false, skipped: 'feature_off' });
    expect(await w.runAuMessagePass(Date.now())).toBeNull();
    expect(await w.auPipelineSnapshot()).toBeNull();
    expect(await w.auOwnerDigestBlock()).toEqual({ html: '', text: '', rows: [] });
    expect(await w.auBackfillMessageTimeline(auGp.userId, auGp.caseId)).toBe(false);
    expect(await w.auComposerAudienceFor(new URLSearchParams('user_id=' + auGp.userId))).toBe('');
    expect(h.emu.requests.length).toBe(mid);
    // The stalled-position sender still stands down for a case on an Australian stage.
    expect(await t.sendStalledNudgeForPositionForTest({ userId: auGp.userId, phase: 'registration', stage: 'prestart', ladder: 'au' })).toEqual({ ok: false, skipped: 'au_pathway' });
    const made = h.emu.requests.slice(before);
    expect(made.length).toBeGreaterThan(5);
    expect(made.some((r) => /candidate_pathway/.test(String(r.query || '')))).toBe(false);
    expect((h.emu.table('gp_nudge_log') || []).filter((r) => WP17_KEYS.test(String(r.nudge_key || '')))).toEqual([]);
    expect(h.emu.violations).toEqual([]);
  });

  it('WP-18 flows: the WhatsApp gates (staff welcome, call reminders, drop-off nudges, account released, the practice\'s interview confirmation): nothing new is read or written', async () => {
    // WP-18 added no column and no table. With the switch on it reads the
    // doctor's pathway (and, for a call reminder, user_profiles.timezone and
    // current_state) before a WhatsApp, and writes notes under new keys in the
    // existing once-ever ledger (`au_existing_wa:*`, `au_existing_wa_via:*`).
    // With the switch off none of that happens: the pathway is never asked
    // for, and a doctor recorded as Australian is messaged as an overseas one.
    const WP18_KEYS = /au_existing_wa/;
    const rule = (r) => wp02NewNameViolation(r, NAMES) || wp03NewStageViolation(r) || wp06NewNameViolation(r) || wp08NewNameViolation(r) || wp09NewNameViolation(r)
      || wp11NewNameViolation(r) || wp12NewNameViolation(r) || wp13NewNameViolation(r) || wp14NewNameViolation(r)
      || (WP18_KEYS.test(String(r.query || '') + JSON.stringify(r.body || '')) ? 'reads or writes a WP-18 ledger key' : null)
      || (/timezone|current_state/.test(String(r.query || '').split('&').filter((x) => /^select=/.test(x)).join('')) && r.table === 'user_profiles' ? 'reads the doctor\'s zone' : null);
    h.setSwitch(false);
    const w = t.__wp18;
    h.emu.forbid(rule);
    // The gates themselves answer without a read.
    const mid = h.emu.requests.length;
    expect(await t.__wp17.auExistingDoctorWhatsAppGate(auGp.userId, 'rso_welcome')).toEqual({ send: true });
    expect(await t.__wp17.auExistingDoctorWhatsAppGate(auGp.userId, 'account_released')).toEqual({ send: true });
    expect(await t.__wp17.auExistingDoctorWhatsAppGate(auGp.userId, 'interview_confirmed_practice')).toEqual({ send: true });
    expect(await w.auBlocksOverseasTemplates(auGp.userId)).toBe(false);
    expect(await w.auBookingDoctorCtx(auGp.userId)).toBeNull();
    expect(h.emu.requests.length).toBe(mid);
    // The senders, for a doctor recorded as Australian.
    const before = h.emu.requests.length;
    await w.ensureRsoWelcomeSent({ caseId: auGp.caseId, gpUserId: auGp.userId, gpPhone: '+61400000555', rsoUserId: '00000000-0000-4000-8000-00000000e001' });
    await w.ensureRsoWelcomeSent({ caseId: auGp.caseId, gpUserId: '', gpPhone: '+61400000555', rsoUserId: '00000000-0000-4000-8000-00000000e001' });
    await w.maybeSendDropoffWa(auGp.userId, 'Test Auvr', 'career_start');
    await w.sendAccountReleasedWhatsApp(auGp.userId);
    await w.sendInterviewWhatsappTemplate('+61400000556', 'confirmed_practice', ['Test Manager', 'Dr Test Auvr', 'x', 'https://zoom.us/j/0'], undefined, auGp.userId);
    // A call booked with a staff member, and one with the CEO, by that doctor.
    for (const host of ['rso', 'ceo']) {
      h.emu.table('scheduled_calls').push({
        id: 'wp18-off-' + host, user_id: auGp.userId, invitee_email: auGp.email, meeting_kind: 'consultation', host_kind: host, status: 'booked',
        scheduled_at: new Date(Date.now() + 20 * 3600000).toISOString(), booked_at: new Date(Date.now() - 3 * 86400000).toISOString(),
        zoom_join_url: 'https://zoom.us/j/0000000000', notification_channels: {}, invitee_notes: '', timezone: 'Australia/Perth'
      });
    }
    await w.runConsultCallReminders(Date.now(), 'registration');
    await w.runConsultCallReminders(Date.now(), 'consult');
    const calls = h.emu.table('scheduled_calls');
    for (let i = calls.length - 1; i >= 0; i--) if (String(calls[i].id).indexOf('wp18-off-') === 0) calls.splice(i, 1);
    const made = h.emu.requests.slice(before);
    expect(made.some((r) => /candidate_pathway/.test(String(r.query || '')))).toBe(false);
    expect((h.emu.table('gp_nudge_log') || []).filter((r) => WP18_KEYS.test(String(r.nudge_key || '')))).toEqual([]);
    expect(h.emu.violations).toEqual([]);
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

    // WP-07 (ADM-08) changed ONE thing in these responses on purpose: in the
    // staff case list a doctor who is on an AUSTRALIAN pathway is now counted
    // against the Australian document set (5 required for segment A) instead
    // of being shown as a UK doctor with 3. That is the finding being fixed,
    // and it only exists with the switch on. So the document counts on the
    // Australian doctors' own rows are set aside before comparing, and checked
    // separately below. Every other byte, including every overseas doctor's
    // row and counts, must still be identical.
    const DASH = 'GET /api/admin/va/dashboard (CEO)';
    // WP-26 (ADM-08, D8): with the switch on an AUSTRALIAN doctor's row also
    // says country AU and carries one `au` block (never the legacy "GB").
    // Those two are set aside for the Australian rows only, so every overseas
    // row is still compared byte for byte.
    const QUAL_KEYS = ['quals_required', 'quals_approved', 'quals_missing', 'country', 'au'];
    const isAuRow = (u) => /^au\./.test(String((u && u.gp_email) || ''));
    const withoutAuQualCounts = (res) => {
      const copy = JSON.parse(JSON.stringify(res));
      ((copy.json && copy.json.users) || []).forEach((u) => { if (isAuRow(u)) QUAL_KEYS.forEach((k) => { delete u[k]; }); });
      // WP-27 (ADM-04 follow-through) changed ONE more thing on purpose: with
      // the switch on, an Australian case that nobody is assigned to is no
      // longer counted in the caseload strip's "Unassigned" row (an Australian
      // case has no RSO until pre-start, so it is not RSO work waiting for an
      // owner). That row's counts are set aside here and checked below; every
      // named RSO's row is still compared byte for byte.
      ((copy.json && copy.json.rso_workload) || []).forEach((w) => {
        if (w && w.rso_id === '__unassigned__') { delete w.case_count; delete w.open_tasks; delete w.overdue_tasks; }
      });
      copy.raw = JSON.stringify(copy.json);
      return copy;
    };
    for (const [label, , expected] of flows) {
      const isSession = label === 'GET /api/auth/session';
      const onRes = label === DASH ? withoutAuQualCounts(on[label]) : on[label];
      const offRes = label === DASH ? withoutAuQualCounts(off[label]) : off[label];
      expect(comparable(onRes, isSession), label).toBe(comparable(offRes, false));
      expect(on[label].status, label).toBe(expected || 200);
    }
    if (on[DASH] && on[DASH].json && Array.isArray(on[DASH].json.users)) {
      const onUsers = on[DASH].json.users;
      const offUsers = off[DASH].json.users;
      // every overseas doctor's counts are untouched
      onUsers.filter((u) => !isAuRow(u)).forEach((u) => {
        const before = offUsers.find((x) => x.case_id === u.case_id);
        QUAL_KEYS.forEach((k) => expect(u[k], u.gp_email + ' ' + k).toBe(before[k]));
        expect('au' in u, u.gp_email).toBe(false);
      });
      // WP-27: the "Unassigned" row counts the overseas unassigned cases only
      const unassigned = (res) => ((res.json.rso_workload || []).find((w) => w.rso_id === '__unassigned__') || { case_count: 0 });
      const auUnassigned = h.emu.table('registration_cases').filter((c) => c && c.status !== 'withdrawn' && !c.assigned_rso
        && (/^au_/.test(String(c.pathway || '')) || ['placement', 'prestart', 'commenced', 'guarantee'].indexOf(String(c.stage)) !== -1)).length;
      expect(unassigned(off[DASH]).case_count - unassigned(on[DASH]).case_count).toBe(auUnassigned);
      expect(auUnassigned).toBeGreaterThan(0);
      // WP-26: an Australian doctor reads as AU with the Australian count
      onUsers.filter(isAuRow).forEach((u) => {
        expect(u.country, u.gp_email).toBe('AU');
        expect(u.au.docs_total, u.gp_email).toBeGreaterThan(0);
        expect(u.au.stage_label, u.gp_email).not.toMatch(/myintealth|_/i);
      });
      offUsers.filter(isAuRow).forEach((u) => { expect('au' in u).toBe(false); expect(u.country).not.toBe('AU'); });
      // switch off: an Australian doctor is an overseas doctor, counted as before
      offUsers.filter(isAuRow).forEach((u) => expect(u.quals_required, u.gp_email).toBe(3));
      // switch on: counted against the Australian set, never the UK three
      const auOn = onUsers.filter(isAuRow);
      expect(auOn.length).toBeGreaterThan(0);
      auOn.forEach((u) => expect(u.quals_required, u.gp_email).toBe(5));
    }
    // The additive keys, exactly.
    const session = on['GET /api/auth/session'].json;
    expect(Object.keys(session).sort()).toEqual(['auPathway', 'auPathwayEnabled', 'authenticated', 'ok', 'profile']);
    expect(session.auPathwayEnabled).toBe(true);
    expect(session.auPathway).toEqual({ pathway: 'overseas_esp', segment: 'overseas', isAu: false, launched: true });

    // WP-06's additive keys on the staff candidate list, exactly: the switch,
    // the filter options, and one `au` object per row. The overseas doctor
    // with nothing recorded reads as overseas and is flagged for nothing.
    for (const label of ['GET /api/ceo/candidates (CEO)', 'GET /api/ceo/candidates (consultant)']) {
      const offKeys = Object.keys(off[label].json).sort();
      // (+ WP-26: `au_stage_filters`, the Australian stages for the stage filter)
      expect(Object.keys(on[label].json).sort()).toEqual(offKeys.concat(['au_pathway_enabled', 'au_stage_filters', 'pathway_filters']).sort());
      expect(offKeys).not.toContain('au_pathway_enabled');
      expect(off[label].json.candidates.every((row) => !('au' in row))).toBe(true);
      const row = on[label].json.candidates.filter((r) => r.user_id === gp.userId)[0];
      expect(row.au).toEqual({ pathway: 'overseas_esp', label: 'Overseas', is_au: false, recorded: false, confirmed: false, needs_review: false, set_by_staff: false, stage_label: '' });
    }

    // With the switch on, the only things that named a new column in all of
    // those flows are READS in their own queries: the session's pathway read
    // and (changed deliberately by WP-06, which added the pathway chip) the
    // candidate list's and pipeline summary's own reads of the pathway columns
    // and the register flags. Nothing was written, and no existing select
    // gained a column.
    const named = h.emu.requests.filter((r) => wp02NewNameViolation(r, NAMES));
    expect(named.every((r) => r.method === 'GET')).toBe(true);
    expect(named.map((r) => r.table).filter((tbl) => tbl !== 'user_profiles' && tbl !== 'gp_credentials')).toEqual([]);
    const sessionRead = named.filter((r) => (r.select || []).join(',') === 'candidate_pathway,candidate_basis,pathway_set_by,pathway_set_at,pathway_confirmed_at,pathway_confirmed_by');
    // Changed deliberately by WP-07 (ADM-08): the staff case list now counts a
    // doctor on an Australian pathway against the Australian document set, so
    // it reads that doctor's pathway in the same small query of its own that
    // the session uses: once per Australian doctor in the list (two in these
    // fixtures), never for an overseas doctor. 1 (session) + 2.
    // Changed deliberately by WP-08 (APP-17, COM-13): with the switch on, the
    // careers list now asks the ONE role rule, which needs the doctor's
    // pathway (GET /api/career/roles: +1), and the applications list asks
    // whether the doctor is on an Australian pathway before it derives a start
    // date from an arrival date (GET /api/career/applications: +1). Each is
    // the same small query of its own. 1 (session) + 2 (WP-07) + 2 (WP-08).
    // Changed deliberately by FB-1 (walk-findings D16): with the switch on,
    // the Account page's career documents ask whether the doctor is on an
    // Australian pathway (their CV card then shows the careers CV), the same
    // small query of its own (GET /api/account/career-documents: +1). The
    // response for a doctor with nothing recorded is unchanged (checked above).
    expect(sessionRead.length).toBe(6);
    // The staff reads are whole-table reads of their own, never a column
    // added to a query an overseas feature depends on.
    // WP-08: the careers list's role rule also reads the doctor's OWN
    // gp_credentials row (the second of the resolver's "two separate small
    // reads"): one whole-row read, filtered to that doctor. It was not made
    // before because the gate did not ask the resolver.
    const ownCredentialsRead = named.filter((r) => r.table === 'gp_credentials' && r.query.indexOf('user_id=eq.') !== -1);
    expect(ownCredentialsRead.length).toBe(1);
    expect(ownCredentialsRead[0].query).toContain('user_id=eq.' + gp.userId);
    const staffReadsNamed = named.filter((r) => sessionRead.indexOf(r) === -1 && ownCredentialsRead.indexOf(r) === -1);
    // candidates x2 (pathway + flags each), pipeline summary x1; plus, from
    // WP-07, the "who is on an Australian pathway" index read made once by the
    // staff case list before it counts documents.
    expect(staffReadsNamed.length).toBe(6);
    for (const r of staffReadsNamed) {
      if (r.table === 'user_profiles') expect(r.select.filter((c) => ['user_id', 'candidate_pathway', 'pathway_set_by', 'pathway_confirmed_at'].indexOf(c) === -1)).toEqual([]);
      else expect(r.select).toEqual(['user_id', 'has_conditions', 'has_undertakings', 'has_notations', 'staff_verified_at']);
    }
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

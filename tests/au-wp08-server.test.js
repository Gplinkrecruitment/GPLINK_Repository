// Australian GP build, WP-08: job eligibility, role fields, caps, re-entry,
// matching inputs, start dates and the reviewed stamp, end to end against the
// real server and the in-memory database stub. Both states of the switch.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const re = require('../lib/role-eligibility.js');

const NOW = new Date().toISOString();
const STAFF = 'staff.test@gplink-test.local';
const HOLD = 'Our team is confirming your details and will be in touch by email.';
const EMPTY_TABLES = ['registration_tasks', 'task_timeline', 'gp_applications', 'placements', 'user_documents',
  'admin_audit_log', 'candidate_leads', 'runtime_kv', 'rate_limits', 'gp_nudge_log', 'user_roles', 'career_interviews',
  'scheduled_calls', 'career_suburb_geo_cache', 'ats_stage_events', 'ats_offers', 'match_cache', 'career_contracts'];

const ROLE_BASE = { provider: 'internal_ats', is_active: true, approval_status: 'approved', job_status: 'open', ats_created: true, updated_at: NOW, published_at: NOW, location_country: 'Australia', tags: [] };
function seedRoles() {
  return [
    Object.assign({}, ROLE_BASE, {
      id: 'role-metro-vr', provider_role_id: 'ats_wp08_metro_vr', title: 'GP (FAKE metro, VR only)', masked_title: 'Non-DPA - Parramatta - Mixed Billing',
      practice_name: 'Test Metro Practice (FAKE)', practice_id: 'p-metro', suburb: 'Parramatta', location_city: 'Parramatta', location_state: 'NSW', nearest_city: 'Sydney',
      billing_model: 'mixed', mixed_billing: true, dpa: false, dpa_status: 'no', mmm: 'MM1', metro: true, visa_pathway_aligned: false,
      vr_requirement: 'vr_required', accepts_registrars: false, accepts_supervised: false, engagement_type: 'permanent', sessions_min: 6, sessions_max: 10, special_interests: ['Skin cancer medicine']
    }),
    Object.assign({}, ROLE_BASE, {
      id: 'role-metro-open', provider_role_id: 'ats_wp08_metro_open', title: 'GP (FAKE metro, non-VR accepted)', masked_title: 'Non-DPA - Parramatta - Mixed Billing (part time)',
      practice_name: 'Test Metro Practice (FAKE)', practice_id: 'p-metro', suburb: 'Parramatta', location_city: 'Parramatta', location_state: 'NSW', nearest_city: 'Sydney',
      billing_model: 'mixed', mixed_billing: true, dpa: false, dpa_status: 'no', mmm: 'MM1', metro: true,
      vr_requirement: 'non_vr_accepted', accepts_registrars: true, accepts_supervised: false, engagement_type: 'contract', sessions_min: 2, sessions_max: 6, special_interests: []
    }),
    Object.assign({}, ROLE_BASE, {
      id: 'role-dpa', provider_role_id: 'ats_wp08_dpa', title: 'GP (FAKE regional DPA)', masked_title: 'DPA - Dubbo - Bulk Billing',
      practice_name: 'Test Regional Practice (FAKE)', practice_id: 'p-dubbo', suburb: 'Dubbo', location_city: 'Dubbo', location_state: 'NSW', nearest_city: 'Dubbo',
      billing_model: 'bulk', dpa: true, dpa_status: 'yes', mmm: 'MM3', regional: true, visa_pathway_aligned: true,
      vr_requirement: 'vr_preferred', accepts_registrars: false, accepts_supervised: true, engagement_type: 'permanent', sessions_min: 8, sessions_max: 10, special_interests: []
    })
  ];
}
const PRACTICES = [
  { id: 'p-metro', name: 'Test Metro Practice (FAKE)', latitude: -33.815, longitude: 151.0011, location_state: 'NSW', suburb: 'Parramatta', metadata: {}, is_active: true },
  { id: 'p-dubbo', name: 'Test Regional Practice (FAKE)', latitude: -32.2569, longitude: 148.6011, location_state: 'NSW', suburb: 'Dubbo', metadata: {}, is_active: true }
];
const METRO_VR = 'internal_ats:ats_wp08_metro_vr';
const METRO_OPEN = 'internal_ats:ats_wp08_metro_open';
const DPA = 'internal_ats:ats_wp08_dpa';

let h, t;
let seq = 0;
const rows = (table) => h.emu.table(table);
const row = (table, userId) => rows(table).filter((r) => r.user_id === userId)[0] || null;
const caseOf = (userId) => row('registration_cases', userId);
const openTasks = (userId, type) => {
  const c = caseOf(userId);
  return rows('registration_tasks').filter((x) => c && x.case_id === c.id && x.task_type === type && x.status !== 'completed' && x.status !== 'cancelled');
};

function add(kind, overrides) {
  seq += 1;
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: 'w' + seq }, overrides || {}));
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
  rows('user_documents').push({ id: 'cv-' + d.userId, user_id: d.userId, document_key: 'career_cv', status: 'uploaded', file_name: 'cv.pdf', country_code: 'AU', created_at: NOW, updated_at: NOW });
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}
const UNCONFIRMED_19AB = { moratorium_19ab_status: 'no', moratorium_19ab_confirmed_status: null, moratorium_19ab_confirmed_by: null, moratorium_19ab_confirmed_at: null };
// WP-29 (deliberate): UNCONFIRMED_19AB (the doctor says "no", staff have not
// answered) no longer limits what the DOCTOR sees: their own answer now counts
// for their own view. The fail-closed cases these tests protect are now spelled
// with the answers that still restrict: "not sure" (and a temporary resident
// who says "no").
const UNSURE_19AB = { moratorium_19ab_status: 'unsure', moratorium_19ab_confirmed_status: null, moratorium_19ab_confirmed_by: null, moratorium_19ab_confirmed_at: null };
const REGISTRAR_HOLD = re.REGISTRAR_HOLD_MESSAGE;
const HOLD_CARD = { held: true, kind: 'review', title: 'Thanks, we have your details', message: HOLD };
const REGISTRAR_CARD = { held: true, kind: 'registrar', title: 'We place fully qualified GPs', message: REGISTRAR_HOLD };
const STAFF_NO_19AB = { moratorium_19ab_status: 'no', moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW };
const HOME_PARRAMATTA = { current_suburb: 'Parramatta', current_state: 'NSW', current_latitude: -33.8170, current_longitude: 151.0030, commute_radius_km: 30 };

const roles = (d) => h.get('/api/career/roles', { cookie: d.cookie });
// WP-09: a doctor on an Australian pathway must tick "I agree to my details
// being sent to this practice" on the apply sheet, so the page sends that
// agreement with the apply. These WP-08 cases are about eligibility and caps,
// so an Australian doctor here always applies with the tick, as the page does;
// an overseas doctor's request is unchanged. (The consent gate itself is
// covered in tests/au-wp09-server.test.js.)
const WP09_AGREED = { agreed: true, version: require('../lib/profile-share-consent.js').CONSENT_VERSION };
const apply = (d, roleId) => h.post('/api/career/apply',
  /^au_/.test(d.kind) ? { roleId, shareConsent: WP09_AGREED } : { roleId }, { cookie: d.cookie });
function seedApps(d, n, extra) {
  for (let i = 0; i < n; i++) {
    rows('gp_applications').push(Object.assign({
      id: 'app-' + d.userId + '-' + i + '-' + Math.random().toString(36).slice(2, 7), user_id: d.userId, career_role_id: 'role-other-' + i, provider_role_id: 'ats_other_' + i,
      status: 'applied', ats_stage: 'applied', origin: 'gp_applied', applied_at: '2026-01-05T00:00:00.000Z', updated_at: NOW
    }, extra || {}));
  }
}

beforeAll(async () => {
  const tables = { career_roles: seedRoles(), practices: PRACTICES.map((p) => Object.assign({}, p)) };
  EMPTY_TABLES.forEach((name) => { tables[name] = []; });
  ['user_profiles', 'gp_credentials', 'registration_cases', 'user_state'].forEach((name) => { tables[name] = []; });
  h = await bootAuTestServer({ name: 'wp08', tables });
  t = h.testUtils;
});
afterAll(async () => { if (h) await h.close(); });
beforeEach(() => {
  h.setSwitch(true);
  h.emu.forbid(null);
  h.emu.missingColumns = {};
  h.emu.failTables = {};
  rows('career_roles').length = 0;
  seedRoles().forEach((r) => rows('career_roles').push(r));
  delete process.env.AU_APPLICATION_CAPS_JSON;
});

describe('Careers: who sees which of the three roles', () => {
  it('segment A, staff-confirmed 19AB "no": all three, nearest first, with the plain facts and no visa / DPA hint', async () => {
    const d = add('au_vr', { profile: HOME_PARRAMATTA });
    const res = await roles(d);
    expect(res.status).toBe(200);
    expect(res.json.auHold).toBeUndefined();
    expect(res.json.roles.length).toBe(3);
    expect(res.json.roles.every((r) => r.qualifies === true && !r.blurred)).toBe(true);
    expect(res.json.roles.map((r) => r.id)).toEqual([METRO_VR, METRO_OPEN, DPA].sort((a, b) => (a === DPA ? 1 : b === DPA ? -1 : 0)));
    expect(res.json.roles[0].distanceKm).toBeLessThan(2);
    expect(res.json.roles[0].withinCommute).toBe(true);
    expect(res.json.roles[2].distanceKm).toBeGreaterThan(250);
    expect(res.json.roles[2].withinCommute).toBe(false);
    const vr = res.json.roles.filter((r) => r.id === METRO_VR)[0];
    expect(vr.auFacts).toEqual({ billingModel: 'mixed', vrRequirement: 'vr_required', vrRequirementStated: true, acceptsRegistrars: false, acceptsSupervised: false, engagementType: 'permanent', sessionsMin: 6, sessionsMax: 10, specialInterests: ['Skin cancer medicine'], mmm: 1, area: 'metro', dpa: 'no', afterHours: null, restraintRadiusKm: null });
    // COM-25: the regional role is "Visa pathway" / "DPA eligible" to an overseas doctor; neither is shown to segment A
    const dpaRole = res.json.roles.filter((r) => r.id === DPA)[0];
    expect(dpaRole.qualifyHint).toBe('');
    expect(JSON.stringify(res.json.roles.map((r) => [r.qualifyHint, r.tags]))).not.toMatch(/visa/i);
  });

  // WP-29 (deliberate): this doctor used to be "says no, staff not confirmed".
  // That answer now opens the doctor's own view (next test), so the restricted
  // doctor here is the one who is "not sure": still DPA roles only.
  it('segment A, "not sure" about 19AB and staff have not confirmed: only the DPA role is open; the two metro roles are blurred stubs', async () => {
    const d = add('au_vr', { credentials: UNSURE_19AB });
    const res = await roles(d);
    expect(res.json.auAreaLimited).toBe(true);
    const crisp = res.json.roles.filter((r) => r.qualifies);
    const blurred = res.json.roles.filter((r) => !r.qualifies);
    expect(crisp.map((r) => r.id)).toEqual([DPA]);
    expect(blurred.length).toBe(2);
    blurred.forEach((r) => {
      expect(r).toMatchObject({ blurred: true, title: 'GP Opportunity', practiceName: 'Confidential practice', qualifyReason: 'dpa_restricted' });
      expect(r.auFacts).toBeUndefined();
    });
    expect(res.raw).not.toContain('Parramatta');
    const detail = await h.get('/api/career/role?id=' + encodeURIComponent(METRO_VR), { cookie: d.cookie });
    expect(detail.json.role.blurred).toBe(true);
    expect(detail.raw).not.toContain('Parramatta');
    const ok = await h.get('/api/career/role?id=' + encodeURIComponent(DPA), { cookie: d.cookie });
    expect(ok.json.role.blurred).toBeUndefined();
    expect(ok.json.role.auFacts.dpa).toBe('yes');
  });

  // WP-29 (deliberate): the new rule, end to end. The doctor's own "19AB does
  // not apply" opens roles outside a DPA for THEM before staff confirm it. A
  // temporary resident saying the same thing stays limited to DPA roles.
  it('segment A, the doctor says 19AB does not apply and staff have not confirmed: all three roles are open to the doctor; a temporary resident saying the same is still DPA only', async () => {
    const d = add('au_vr', { credentials: UNCONFIRMED_19AB });
    const res = await roles(d);
    expect(res.json.auHold).toBeUndefined();
    expect(res.json.auAreaLimited).toBeUndefined();
    expect(res.json.roles.map((r) => r.id).sort()).toEqual([DPA, METRO_OPEN, METRO_VR].sort());
    expect(res.json.roles.every((r) => r.qualifies === true && !r.blurred)).toBe(true);
    const detail = await h.get('/api/career/role?id=' + encodeURIComponent(METRO_VR), { cookie: d.cookie });
    expect(detail.json.role.blurred).toBeUndefined();
    expect(detail.json.role.auFacts.dpa).toBe('no');
    expect(await t.resolveCandidatePathway(d.userId)).toMatchObject({ dpaRestricted: false, dpaSelfDeclaredOnly: true, staff19ab: 'unconfirmed', dpaRestrictedReason: 'self_declared_no_awaiting_staff_confirmation' });

    const temporary = add('au_vr', { credentials: Object.assign({}, UNCONFIRMED_19AB, { work_rights: 'visa' }) });
    const limited = await roles(temporary);
    expect(limited.json.auAreaLimited).toBe(true);
    expect(limited.json.roles.filter((r) => r.qualifies).map((r) => r.id)).toEqual([DPA]);
    expect(limited.json.roles.filter((r) => !r.qualifies).every((r) => r.blurred === true && r.qualifyReason === 'dpa_restricted')).toBe(true);
    expect(limited.raw).not.toContain('Parramatta');
    expect((await apply(temporary, METRO_VR)).status).toBe(403);
    expect(await t.resolveCandidatePathway(temporary.userId)).toMatchObject({ dpaRestricted: true, dpaRestrictedReason: 'temporary_resident' });
  });

  it('a role whose DPA status is unknown is not offered to a restricted doctor, but is to one staff have cleared', async () => {
    rows('career_roles').filter((r) => r.id === 'role-dpa')[0].dpa_status = 'unknown';
    // WP-29 (deliberate): the restricted doctor is the one who is "not sure" (see UNSURE_19AB).
    const restricted = add('au_vr', { credentials: UNSURE_19AB });
    expect((await roles(restricted)).json.roles.filter((r) => r.qualifies)).toEqual([]);
    expect((await apply(restricted, DPA)).status).toBe(403);
    // ...and the same for a doctor who SAYS 19AB applies, and for one staff confirmed it applies to.
    const saysYes = add('au_vr', { credentials: Object.assign({}, UNSURE_19AB, { moratorium_19ab_status: 'yes' }) });
    expect((await roles(saysYes)).json.roles.filter((r) => r.qualifies)).toEqual([]);
    const staffYes = add('au_vr', { credentials: { moratorium_19ab_status: 'no', moratorium_19ab_confirmed_status: 'yes', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW } });
    expect((await roles(staffYes)).json.roles.filter((r) => r.qualifies)).toEqual([]);
    expect((await apply(staffYes, DPA)).status).toBe(403);
    const cleared = add('au_vr');
    expect((await roles(cleared)).json.roles.filter((r) => r.qualifies).length).toBe(3);
  });

  // WP-29 (deliberate): who is held is the sorting rule's answer, not "every
  // pathway but au_vr". Held: a segment B doctor who is NOT a vocationally
  // registered GP (which includes limited registration), au_non_vr and
  // au_registrar. The standard segment B doctor (a VR GP) is no longer held:
  // see the test after this loop. The hold payloads carry a kind and a title;
  // a registrar gets their own words and is NOT sent to staff for review.
  const NOT_VR = { ahpra_registration_type: 'general', specialist_gp: false, fellowship_type: 'none', vr_status: 'non_vr' };
  const HELD = [
    { label: 'au_restricted, not a vocationally registered GP', kind: 'au_restricted', overrides: { credentials: NOT_VR }, card: HOLD_CARD, reviewTasks: 1 },
    { label: 'au_restricted, limited registration', kind: 'au_restricted', overrides: { credentials: { ahpra_registration_type: 'limited' } }, card: HOLD_CARD, reviewTasks: 1 },
    { label: 'au_non_vr', kind: 'au_non_vr', overrides: null, card: HOLD_CARD, reviewTasks: 1 },
    { label: 'au_registrar', kind: 'au_registrar', overrides: null, card: REGISTRAR_CARD, reviewTasks: 0 }
  ];
  for (const c of HELD) {
    it(c.label + ': held. No roles, the honest message, staff flagged once (never for a registrar), apply refused', async () => {
      const d = add(c.kind, c.overrides);
      const res = await roles(d);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ ok: true, source: 'hold', roles: [] });
      expect(res.json.auHold).toEqual(c.card);
      expect(res.headers['cache-control']).toMatch(/no-store/);
      expect(res.raw).not.toMatch(/Parramatta|Dubbo|Test Metro|Test Regional/);
      expect(openTasks(d.userId, 'segment_review').length).toBe(c.reviewTasks);
      await roles(d);
      const detail = await h.get('/api/career/role?id=' + encodeURIComponent(DPA), { cookie: d.cookie });
      expect(detail.json.auHold).toEqual(c.card);
      expect(detail.json.role).toMatchObject({ blurred: true, practiceName: 'Confidential practice', summary: c.card.message });
      expect(detail.raw).not.toMatch(/Dubbo|Test Regional/);
      for (const roleId of [DPA, METRO_OPEN, METRO_VR]) {
        const a = await apply(d, roleId);
        expect(a.status, roleId).toBe(403);
        expect(a.json, roleId).toEqual({ ok: false, error: 'pathway_on_hold', code: 'au_hold', auHold: true, auHoldKind: c.card.kind, title: c.card.title, message: c.card.message });
      }
      expect(rows('gp_applications').filter((a) => a.user_id === d.userId)).toEqual([]);
      expect(openTasks(d.userId, 'segment_review').length).toBe(c.reviewTasks);   // still one (none for a registrar)
      // nothing was sent to the doctor about it
      expect(rows('gp_nudge_log').filter((n) => n.user_id === d.userId)).toEqual([]);
      expect(await t.resolveCandidatePathway(d.userId)).toMatchObject({ launched: false, selfServiceHeld: true, holdKind: c.card.kind });
    });
  }

  // WP-29 (deliberate): the standard segment B doctor is a vocationally
  // registered GP under 19AB on a sponsored visa. They used to be held. Now
  // they see what they may take, and nothing else: the DPA role whose practice
  // offers sponsorship. Roles outside a DPA are not theirs to see or apply for.
  it('au_restricted, a vocationally registered GP: NOT held. Only DPA roles, and only from a practice that offers sponsorship when their visa needs one', async () => {
    const d = add('au_restricted');
    expect(await t.resolveCandidatePathway(d.userId)).toMatchObject({ launched: false, selfServiceHeld: false, holdKind: null, dpaRestricted: true, roleFit: { vr: true, registrar: false, sponsorship: true } });
    const res = await roles(d);
    expect(res.status).toBe(200);
    expect(res.json.auHold).toBeUndefined();
    expect(res.json.source).not.toBe('hold');
    expect(res.json.auAreaLimited).toBe(true);
    expect(res.json.roles.filter((r) => r.qualifies).map((r) => r.id)).toEqual([DPA]);
    // the metro practice has not said it offers sponsorship: its roles are not listed at all
    expect(res.json.roles.map((r) => r.id)).toEqual([DPA]);
    expect(res.raw).not.toMatch(/Parramatta|Test Metro/);
    expect(openTasks(d.userId, 'segment_review')).toEqual([]);
    for (const roleId of [METRO_OPEN, METRO_VR]) {
      const a = await apply(d, roleId);
      expect(a.status, roleId).toBe(403);
      expect(a.json.error, roleId).toBe('not_qualified');
    }
    // the DPA practice stops offering sponsorship: nothing is left for this doctor
    rows('career_roles').filter((r) => r.id === 'role-dpa')[0].visa_pathway_aligned = false;
    expect((await roles(d)).json.roles).toEqual([]);
    expect((await apply(d, DPA)).status).toBe(403);
    rows('career_roles').filter((r) => r.id === 'role-dpa')[0].visa_pathway_aligned = true;
    expect((await apply(d, DPA)).status).toBe(200);
    expect(rows('gp_applications').filter((a) => a.user_id === d.userId).map((a) => a.career_role_id)).toEqual(['role-dpa']);

    // A citizen in segment B under 19AB needs no sponsor: the DPA role is open, the metro roles are blurred stubs.
    const citizen = add('au_restricted', { credentials: { work_rights: 'citizen', visa_subclass: null, visa_expiry: null, visa_sponsor_tied: null, visa_sponsor_name: null } });
    const list = await roles(citizen);
    expect(list.json.roles.filter((r) => r.qualifies).map((r) => r.id)).toEqual([DPA]);
    const stubs = list.json.roles.filter((r) => !r.qualifies);
    expect(stubs.length).toBe(2);
    stubs.forEach((r) => expect(r).toMatchObject({ blurred: true, title: 'GP Opportunity', practiceName: 'Confidential practice', qualifyReason: 'dpa_restricted' }));
    expect(list.raw).not.toContain('Parramatta');
  });

  it('an overseas doctor (nothing recorded): exactly the switch-off response, and no new key', async () => {
    const d = add('overseas_null');
    const on = await roles(d);
    h.setSwitch(false);
    const off = await roles(d);
    expect(on.raw).toBe(off.raw);
    expect(on.json.roles.filter((r) => r.qualifies).map((r) => r.id)).toEqual([DPA]);
    expect(on.json.roles.filter((r) => r.blurred).length).toBe(2);
    expect(on.raw).not.toMatch(/auFacts|auHold|distanceKm/);
    // the role page too
    h.setSwitch(true);
    const detailOn = await h.get('/api/career/role?id=' + encodeURIComponent(DPA), { cookie: d.cookie });
    h.setSwitch(false);
    const detailOff = await h.get('/api/career/role?id=' + encodeURIComponent(DPA), { cookie: d.cookie });
    expect(detailOn.raw).toBe(detailOff.raw);
    expect(detailOn.json.role.qualifyHint).toBe('Visa pathway');   // unchanged for them
  });

  it('SWITCH OFF: a stored Australian pathway changes nothing (no hold, no facts, country rule only)', async () => {
    const held = add('au_non_vr');
    h.setSwitch(false);
    const res = await roles(held);
    expect(res.json.auHold).toBeUndefined();
    expect(res.json.roles.length).toBe(3);
    expect(res.raw).not.toMatch(/auFacts|distanceKm/);
    expect(openTasks(held.userId, 'segment_review')).toEqual([]);
  });
});

describe('apply is enforced server-side', () => {
  it('segment A, 19AB "not sure": refused for a role outside a DPA, accepted for the DPA role', async () => {
    // WP-29 (deliberate): the doctor's own "no" now lets THEM apply outside a
    // DPA (their own view only: the practice introduction still waits for
    // staff, tests/au-wp09-server.test.js). "Not sure" is still refused.
    const own = add('au_vr', { credentials: UNCONFIRMED_19AB });
    expect((await apply(own, METRO_VR)).status).toBe(200);
    expect(rows('gp_applications').filter((a) => a.user_id === own.userId).map((a) => a.career_role_id)).toEqual(['role-metro-vr']);
    const d = add('au_vr', { credentials: UNSURE_19AB });
    const no = await apply(d, METRO_VR);
    expect(no.status).toBe(403);
    expect(no.json).toEqual({ ok: false, error: 'not_qualified', code: 'dpa_restricted', message: "You don't currently qualify for this role." });
    const yes = await apply(d, DPA);
    expect(yes.status).toBe(200);
    expect(rows('gp_applications').filter((a) => a.user_id === d.userId).map((a) => a.career_role_id)).toEqual(['role-dpa']);
  });

  it('an overseas doctor is refused with today\'s exact body', async () => {
    const d = add('overseas_null');
    const res = await apply(d, METRO_OPEN);
    expect(res.status).toBe(403);
    expect(res.raw).toBe(JSON.stringify({ ok: false, error: 'not_qualified', message: "You don't currently qualify for this role." }));
  });

  it('a non-VR doctor cannot be put on a VR-only role, by themselves or by staff', async () => {
    const d = add('au_non_vr', { credentials: STAFF_NO_19AB });
    // by themselves: refused (segment C is held)
    expect((await apply(d, METRO_VR)).status).toBe(403);
    // the rule itself, for this real doctor and this real role row
    const ctx = await t.resolveRoleEligibilityContext(d.userId, d.email);
    const vrOnly = rows('career_roles').filter((r) => r.id === 'role-metro-vr')[0];
    expect(re.roleEligibilityFor(ctx.pathway, vrOnly)).toMatchObject({ eligible: false, canApply: false });
    expect(re.roleEligibilityFor(ctx.pathway, vrOnly).reasons).toContain('vr_required');
    // by staff, both manual routes: 409 with a plain reason, nothing written
    for (const path of ['/api/ats/application', '/api/ats/job/candidate']) {
      const res = await h.post(path, { user_id: d.userId, career_role_id: 'role-metro-vr', stage: 'applied' }, h.consultant());
      expect(res.status, path).toBe(409);
      expect(res.json.code, path).toBe('not_eligible_for_role');
      expect(res.json.reasons.map((r) => r.code), path).toContain('vr_required');
      expect(res.json.message, path).toMatch(/does not accept non-VR doctors/);
    }
    expect(rows('gp_applications').filter((a) => a.user_id === d.userId)).toEqual([]);
    // ...and staff CAN put the same held doctor on the role that accepts non-VR doctors
    const ok = await h.post('/api/ats/job/candidate', { user_id: d.userId, career_role_id: 'role-metro-open', stage: 'applied' }, h.consultant());
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, already: false, notified: false });
    const made = rows('gp_applications').filter((a) => a.user_id === d.userId);
    expect(made.length).toBe(1);
    expect(made[0]).toMatchObject({ career_role_id: 'role-metro-open', origin: 'admin_applied' });
  });

  it('a held doctor limited to DPA roles cannot be put by staff on a role outside a DPA; an overseas doctor\'s manual submit is as open as ever', async () => {
    const restricted = add('au_restricted');
    const res = await h.post('/api/ats/job/candidate', { user_id: restricted.userId, career_role_id: 'role-metro-open', stage: 'applied' }, h.superAdmin());
    expect(res.status).toBe(409);
    expect(res.json.reasons.map((r) => r.code)).toContain('dpa_restricted');
    const uk = add('overseas_null');
    const open = await h.post('/api/ats/job/candidate', { user_id: uk.userId, career_role_id: 'role-metro-vr', stage: 'applied' }, h.superAdmin());
    expect(open.status).toBe(200);
    h.setSwitch(false);
    const off = await h.post('/api/ats/job/candidate', { user_id: restricted.userId, career_role_id: 'role-metro-open', stage: 'applied' }, h.superAdmin());
    expect(off.status).toBe(200);   // switch off: no Australian gate exists
  });
});

describe('staff can see the computed eligibility per role', () => {
  it('GET /api/ats/candidate/role-eligibility: one row per open role, with the reasons in plain words', async () => {
    const d = add('au_non_vr', { credentials: STAFF_NO_19AB });
    const res = await h.get('/api/ats/candidate/role-eligibility?user_id=' + d.userId, h.consultant());
    expect(res.status).toBe(200);
    expect(res.json.pathway).toMatchObject({ pathway: 'au_non_vr', segment: 'C', is_au: true, launched: false, dpa_restricted: false, role_fit: { vr: false, registrar: false, supervised: false } });
    expect(res.json.hold).toBe(true);
    expect(res.json.hold_kind).toBe('review');   // WP-29 (deliberate): staff are told which kind of hold
    expect(res.json.caps).toMatchObject({ active: 4, monthly: 6, interviewsMonthly: 6 });
    const by = {};
    res.json.roles.forEach((r) => { by[r.career_role_id] = r; });
    expect(by['role-metro-open']).toMatchObject({ eligible: true, can_self_apply: false, hold: true });
    expect(by['role-metro-vr']).toMatchObject({ eligible: false, can_self_apply: false });
    expect(by['role-metro-vr'].reasons.map((r) => r.code)).toEqual(['vr_required', 'pathway_on_hold']);
    expect(by['role-dpa'].eligible).toBe(false);   // VR preferred does not accept non-VR
    const one = await h.get('/api/ats/candidate/role-eligibility?user_id=' + d.userId + '&career_role_id=role-metro-open', h.superAdmin());
    expect(one.json.roles.length).toBe(1);
    // not for a doctor, not for nobody, not with the switch off
    expect((await h.get('/api/ats/candidate/role-eligibility?user_id=' + d.userId, { cookie: d.cookie })).status).toBe(401);
    h.setSwitch(false);
    const before = h.emu.requests.length;
    expect((await h.get('/api/ats/candidate/role-eligibility?user_id=' + d.userId, h.consultant())).status).toBe(404);
    expect(h.emu.requests.length).toBe(before);
  });
});

describe('application caps per pathway', () => {
  it('an Australian doctor may hold 4 live applications; the 5th is blocked with their own number', async () => {
    const d = add('au_vr');
    seedApps(d, 3);
    expect((await h.get('/api/career/application-usage', { cookie: d.cookie })).json).toMatchObject({ active: { used: 3, limit: 4 }, monthly: { limit: 6 }, canApply: true });
    expect((await apply(d, METRO_VR)).status).toBe(200);          // the 4th
    const blocked = await apply(d, METRO_OPEN);                     // the 5th
    expect(blocked.status).toBe(409);
    expect(blocked.json).toMatchObject({ ok: false, error: 'active_cap', activeUsed: 4, activeLimit: 4, message: 'You already have 4 live applications. To apply for this position, withdraw one of your current applications first.' });
    expect((await h.get('/api/career/application-usage', { cookie: d.cookie })).json).toMatchObject({ active: { used: 4, limit: 4 }, canApply: false });
    expect((await h.get('/api/career/interview-usage', { cookie: d.cookie })).json).toMatchObject({ used: 0, limit: 6 });
  });

  it('an Australian doctor may start 6 a month; the 7th is blocked', async () => {
    const d = add('au_vr');
    seedApps(d, 6, { status: 'withdrawn', ats_stage: 'not_proceeding', applied_at: NOW });
    const blocked = await apply(d, METRO_VR);
    expect(blocked.status).toBe(409);
    expect(blocked.json).toMatchObject({ error: 'monthly_cap', monthlyUsed: 6, monthlyLimit: 6 });
    expect(blocked.json.message).toMatch(/^You have applied for 6 positions this month, which is the monthly limit\. Your limit resets on /);
    const five = add('au_vr');
    seedApps(five, 5, { status: 'withdrawn', ats_stage: 'not_proceeding', applied_at: NOW });
    expect((await apply(five, METRO_VR)).status).toBe(200);
  });

  it('an overseas doctor keeps today\'s numbers and today\'s exact words: 2 live, 3 a month, 3 interviews', async () => {
    const d = add('overseas_null');
    seedApps(d, 2);
    const blocked = await apply(d, DPA);
    expect(blocked.status).toBe(409);
    expect(blocked.json).toEqual({ ok: false, error: 'active_cap', activeUsed: 2, activeLimit: 2, message: 'You already have 2 live applications. To apply for this position, withdraw one of your current applications first.' });
    expect((await h.get('/api/career/application-usage', { cookie: d.cookie })).json).toMatchObject({ active: { used: 2, limit: 2 }, monthly: { limit: 3 }, canApply: false });
    expect((await h.get('/api/career/interview-usage', { cookie: d.cookie })).json).toMatchObject({ limit: 3 });
    const monthly = add('overseas_null');
    seedApps(monthly, 3, { status: 'withdrawn', ats_stage: 'not_proceeding', applied_at: NOW });
    expect((await apply(monthly, DPA)).json).toMatchObject({ error: 'monthly_cap', monthlyUsed: 3, monthlyLimit: 3 });
    expect(t.ACTIVE_APPLICATION_CAP).toBe(2);
    expect(t.MONTHLY_APPLICATION_CAP).toBe(3);
    expect(t.INTERVIEW_MONTHLY_CAP).toBe(3);
  });

  it('SWITCH OFF: an Australian doctor is an overseas doctor (2 / 3 / 3), and nothing is read to decide', async () => {
    const d = add('au_vr');
    seedApps(d, 2);
    h.setSwitch(false);
    h.emu.reset();
    expect(await t.auCapsForUser(d.userId)).toMatchObject({ active: 2, monthly: 3, interviewsMonthly: 3, strikeLock: 3, basis: 'overseas' });
    expect(h.emu.requests.length).toBe(0);
    expect((await h.get('/api/career/application-usage', { cookie: d.cookie })).json).toMatchObject({ active: { used: 2, limit: 2 }, monthly: { limit: 3 }, canApply: false });
    expect((await apply(d, DPA)).json).toMatchObject({ error: 'active_cap', activeLimit: 2 });
  });

  it('the Australian numbers can be changed without code (environment), the overseas ones cannot', async () => {
    process.env.AU_APPLICATION_CAPS_JSON = '{"au_vr":{"active":1},"overseas":{"active":9}}';
    const au = add('au_vr');
    seedApps(au, 1);
    expect((await apply(au, METRO_VR)).json).toMatchObject({ error: 'active_cap', activeLimit: 1 });
    const uk = add('overseas_null');
    seedApps(uk, 2);
    expect((await apply(uk, DPA)).json).toMatchObject({ error: 'active_cap', activeLimit: 2 });
  });
});

describe('re-entry after a placement (APP-22)', () => {
  function placed(kind, stage) {
    const d = add(kind, { caseRow: { stage } });
    rows('gp_applications').push({ id: 'placed-' + d.userId, user_id: d.userId, career_role_id: 'role-old', provider_role_id: 'ats_old', status: 'placement_secured', ats_stage: 'hired', origin: 'gp_applied', applied_at: '2026-01-05T00:00:00.000Z' });
    rows('placements').push({ id: 'pl-' + d.userId, user_id: d.userId, application_id: 'placed-' + d.userId, status: 'active', placed_at: '2026-02-01T00:00:00.000Z' });
    return d;
  }
  it('an Australian doctor who has not started yet is still blocked; once commenced (or the placement ended) they may apply again', async () => {
    const waiting = placed('au_vr', 'prestart');
    const blocked = await apply(waiting, METRO_VR);
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe('already_placed');
    expect(await t.auPlacedReentryAllowed(waiting.userId)).toEqual({ allowed: false, basis: 'not_started' });

    const started = placed('au_vr', 'commenced');
    expect(await t.auPlacedReentryAllowed(started.userId)).toEqual({ allowed: true, basis: 'case_stage' });
    expect((await apply(started, METRO_VR)).status).toBe(200);

    const ended = placed('au_vr', 'prestart');
    rows('placements').filter((p) => p.user_id === ended.userId)[0].status = 'ended';
    expect((await apply(ended, METRO_VR)).status).toBe(200);

    // WP-13's columns, when they exist
    const wp13 = placed('au_vr', 'prestart');
    rows('placements').filter((p) => p.user_id === wp13.userId)[0].commenced_at = '2026-06-01T00:00:00.000Z';
    expect(await t.auPlacedReentryAllowed(wp13.userId)).toEqual({ allowed: true, basis: 'commenced_at' });
  });

  it('an overseas doctor, and every doctor with the switch off, is blocked exactly as before', async () => {
    const uk = placed('overseas_null', 'commencement');
    const res = await apply(uk, DPA);
    expect(res.status).toBe(409);
    expect(res.raw).toBe(JSON.stringify({ ok: false, code: 'already_placed', message: 'You already have a secured placement — contact your recruitment officer if anything needs to change.' }));
    const au = placed('au_vr', 'commenced');
    h.setSwitch(false);
    h.emu.reset();
    expect(await t.auPlacedReentryAllowed(au.userId)).toEqual({ allowed: false, basis: 'not_applicable' });
    expect(h.emu.requests.length).toBe(0);
    expect((await apply(au, DPA)).json.code).toBe('already_placed');
  });

  it('the matching inputs stop treating a re-entered Australian doctor as placed', async () => {
    const started = placed('au_vr', 'commenced');
    const waiting = placed('au_vr', 'prestart');
    const uk = placed('overseas_null', 'commencement');
    const map = await t.atsBuildGpMatchInputs([started.userId, waiting.userId, uk.userId]);
    expect(map[started.userId]).toMatchObject({ placed: false, reentry: 'case_stage' });
    expect(map[waiting.userId].placed).toBe(true);
    expect(map[uk.userId].placed).toBe(true);
  });
});

describe('the job editor: role fields', () => {
  const patch = (id, body, who) => h.request('PATCH', '/api/ats/job?id=' + id, Object.assign({}, who || h.superAdmin(), { body }));

  it('staff can set them, they are validated, and the change takes effect for doctors', async () => {
    const get = await h.get('/api/ats/job?id=role-metro-vr', h.superAdmin());
    expect(get.json.editor.au_role_fields).toMatchObject({ vr_requirement: 'vr_required', accepts_registrars: false, engagement_type: 'permanent', sessions_min: 6, sessions_max: 10, dpa_status: 'no' });

    const bad = await patch('role-metro-vr', { vr_requirement: 'anyone' });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toMatch(/vr_requirement/);
    expect((await patch('role-metro-vr', { engagement_type: 'locum' })).status).toBe(400);
    expect((await patch('role-metro-vr', { sessions_min: 12 })).status).toBe(400);   // above the stored max of 10
    expect(rows('career_roles').filter((r) => r.id === 'role-metro-vr')[0].vr_requirement).toBe('vr_required');

    // A segment A doctor limited to DPA roles sees the regional role...
    // WP-29 (deliberate): "limited to DPA roles" is now the doctor who is not sure about 19AB.
    const restricted = add('au_vr', { credentials: UNSURE_19AB });
    expect((await roles(restricted)).json.roles.filter((r) => r.qualifies).map((r) => r.id)).toEqual([DPA]);
    // ...until staff mark its DPA status unknown.
    const saved = await patch('role-dpa', { dpa_status: 'unknown', special_interests: 'Emergency medicine, Aboriginal health', sessions_min: 4 }, h.consultant());
    expect(saved.status).toBe(200);
    expect(saved.json.editor.au_role_fields).toMatchObject({ dpa_status: 'unknown', special_interests: ['Emergency medicine', 'Aboriginal health'], sessions_min: 4 });
    const stored = rows('career_roles').filter((r) => r.id === 'role-dpa')[0];
    expect(stored).toMatchObject({ dpa_status: 'unknown', dpa: false, sessions_min: 4 });
    expect(stored.masked_title).toMatch(/^Non-DPA/);          // the doctor-facing title follows the boolean, as it always has
    expect((await roles(restricted)).json.roles.filter((r) => r.qualifies)).toEqual([]);

    // Answering the existing DPA yes / no question records the status too (DAT-13).
    const flipped = await patch('role-dpa', { dpa: true });
    expect(flipped.status).toBe(200);
    expect(rows('career_roles').filter((r) => r.id === 'role-dpa')[0]).toMatchObject({ dpa: true, dpa_status: 'yes' });
    expect((await roles(restricted)).json.roles.filter((r) => r.qualifies).map((r) => r.id)).toEqual([DPA]);
  });

  it('SWITCH OFF: the keys are ignored, nothing new is written, and the editor payload is the one it always was', async () => {
    h.setSwitch(false);
    h.emu.reset();
    const res = await patch('role-metro-vr', { vr_requirement: 'non_vr_accepted', dpa_status: 'yes', summary: 'FAKE summary edited with the switch off.' });
    expect(res.status).toBe(200);
    expect(res.json.editor.au_role_fields).toBeUndefined();
    expect(rows('career_roles').filter((r) => r.id === 'role-metro-vr')[0]).toMatchObject({ vr_requirement: 'vr_required', dpa_status: 'no', dpa: false, summary: 'FAKE summary edited with the switch off.' });
    const writes = h.emu.requests.filter((r) => r.table === 'career_roles' && r.method === 'PATCH');
    expect(writes.length).toBe(1);
    expect(Object.keys(writes[0].body).sort()).toEqual(['summary', 'updated_at']);
    // a DPA flip with the switch off writes the boolean and nothing else new
    await patch('role-metro-vr', { dpa: true });
    const flip = h.emu.requests.filter((r) => r.table === 'career_roles' && r.method === 'PATCH')[1];
    expect(Object.keys(flip.body)).not.toContain('dpa_status');
    expect((await h.get('/api/ats/job?id=role-metro-vr', h.superAdmin())).json.editor.au_role_fields).toBeUndefined();
  });

  it('a database without the WP-08 columns says so instead of "not found"', async () => {
    h.emu.missingColumns = { career_roles: ['vr_requirement', 'accepts_registrars', 'accepts_supervised', 'engagement_type', 'sessions_min', 'sessions_max', 'special_interests', 'dpa_status'] };
    const res = await patch('role-metro-vr', { vr_requirement: 'non_vr_accepted' });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('schema_missing');
    // and an ordinary edit still saves there
    expect((await patch('role-metro-vr', { summary: 'FAKE summary.' })).status).toBe(200);
  });
});

describe('the reviewed stamp (WP-06 hook): a recorded-and-accepted condition stops asking for review', () => {
  it('a person deciding segment A stamps the review once; the doctor then reads as cleared, and is told once', async () => {
    const d = add('au_vr', {
      profile: { register_body: 'ahpra', register_number: 'MED0001234567', register_status: 'verified' },
      credentials: Object.assign({ has_conditions: true, conditions_text: 'A condition (FAKE).', staff_verified_at: NOW, staff_verified_by: STAFF }, STAFF_NO_19AB)
    });
    expect(await t.resolveCandidatePathway(d.userId)).toMatchObject({ pathway: 'au_vr', confirmed: true, needsStaffReview: true, flagsReviewed: false });

    const decided = await h.post('/api/admin/candidate/pathway', { user_id: d.userId, pathway: 'au_vr', note: 'Condition reviewed (FAKE).' }, h.superAdmin());
    expect(decided.status).toBe(200);
    const cred = row('gp_credentials', d.userId);
    expect(cred.flags_reviewed_by).toBe(h.SUPER_EMAIL);
    expect(typeof cred.flags_reviewed_at).toBe('string');
    expect(await t.resolveCandidatePathway(d.userId)).toMatchObject({ needsStaffReview: false, flagsReviewed: true, hasRegistrationFlags: true });
    // N06 "verified": claimed once in the once-ever ledger. (No email provider
    // is configured in this harness, so the email claim is handed back and
    // only the bell is recorded; tests/au-wp06-staff-tools-server covers the
    // email itself.)
    const told = () => rows('gp_nudge_log').filter((n) => n.user_id === d.userId && n.nudge_key === 'au_n06_ahpra_verified');
    expect(told().map((n) => n.channel)).toContain('bell');
    const toldCount = told().length;

    // Deciding again changes nothing and tells nobody twice.
    const stampedAt = cred.flags_reviewed_at;
    await h.post('/api/admin/candidate/pathway', { user_id: d.userId, pathway: 'au_vr' }, h.superAdmin());
    expect(row('gp_credentials', d.userId).flags_reviewed_at).toBe(stampedAt);
    expect(told().filter((n) => n.channel === 'bell').length).toBe(1);
    expect(told().length).toBe(toldCount);

    // A NEW flag withdraws the review: a person looks again.
    const changed = await t.upsertGpCredentials(d.userId, { has_undertakings: true, undertakings_text: 'An undertaking (FAKE).' }, { source: 'staff', actor: STAFF });
    expect(changed.ok).toBe(true);
    expect(row('gp_credentials', d.userId)).toMatchObject({ flags_reviewed_at: null, flags_reviewed_by: null });
    expect((await t.resolveCandidatePathway(d.userId)).needsStaffReview).toBe(true);
  });

  it('a doctor with nothing flagged gets no stamp, and a database without the stamp columns still saves the rest', async () => {
    const clean = add('au_vr', { credentials: STAFF_NO_19AB });
    await h.post('/api/admin/candidate/pathway', { user_id: clean.userId, pathway: 'au_vr' }, h.superAdmin());
    expect(row('gp_credentials', clean.userId).flags_reviewed_at == null).toBe(true);

    const flagged = add('au_vr', { credentials: Object.assign({ has_conditions: true, flags_reviewed_at: NOW, flags_reviewed_by: STAFF }, STAFF_NO_19AB) });
    h.emu.missingColumns = { gp_credentials: ['flags_reviewed_at', 'flags_reviewed_by'] };
    const write = await t.upsertGpCredentials(flagged.userId, { has_notations: true, notations_text: 'A notation (FAKE).' }, { source: 'staff', actor: STAFF });
    expect(write.ok).toBe(true);
    expect(row('gp_credentials', flagged.userId)).toMatchObject({ has_notations: true, notations_text: 'A notation (FAKE).' });
  });
});

describe('matching inputs (ADM-16, DAT-10) and tags', () => {
  it('an Australian doctor carries the Australian block; an overseas doctor is exactly as before', async () => {
    const au = add('au_vr', {
      profile: Object.assign({ notice_period_weeks: 4, available_from: '2027-03-01', sessions_wanted: 8, billing_preference: 'mixed', special_interests: ['Skin cancer medicine'], preferred_locations: ['Sydney', 'Regional NSW'] }, HOME_PARRAMATTA),
      credentials: { has_conditions: true, conditions_text: 'SECRET CONDITION TEXT (FAKE)' }
    });
    // WP-29 (deliberate): the restricted doctor is "not sure" about 19AB; the
    // doctor whose own answer is "no" is matched outside a DPA on their own word.
    const restricted = add('au_vr', { credentials: UNSURE_19AB });
    const ownWord = add('au_vr', { credentials: UNCONFIRMED_19AB });
    const held = add('au_registrar');
    const uk = add('overseas_null');
    const map = await t.atsBuildGpMatchInputs([au.userId, restricted.userId, held.userId, uk.userId, ownWord.userId]);
    expect(map[ownWord.userId].dpaEligible).toBe(true);
    expect(map[ownWord.userId].au).toMatchObject({ pathway: 'au_vr', dpaRestricted: false });
    expect(t.atsMatchGpChip(map[ownWord.userId])).toBe('Australian GP, segment A');

    expect(map[au.userId].dpaEligible).toBe(true);
    expect(map[au.userId].au).toMatchObject({
      pathway: 'au_vr', segment: 'A', vr: true, registrar: false, supervised: false, registrationFlag: true, dpaRestricted: false,
      currentSuburb: 'Parramatta', currentState: 'NSW', commuteRadiusKm: 30, preferredLocations: ['Sydney', 'Regional NSW'],
      sessionsWanted: 8, availableFrom: '2027-03-01', noticePeriodWeeks: 4, earliestStart: '2027-03-01',
      specialInterests: ['Skin cancer medicine'], billingPreference: 'mixed'
    });
    expect(JSON.stringify(map[au.userId].au)).not.toContain('SECRET CONDITION TEXT');
    expect(JSON.stringify(t.atsGpForRanking(map[au.userId]))).not.toContain('SECRET CONDITION TEXT');
    expect(map[restricted.userId].dpaEligible).toBe(false);          // country Australia unlocks nothing
    expect(map[held.userId].au.registrar).toBe(true);
    expect(map[uk.userId].au).toBeUndefined();
    expect(map[uk.userId].dpaEligible).toBe(false);
    expect(Object.keys(t.atsGpForRanking(map[uk.userId])).sort()).toEqual(['childrenCount', 'handoverSummary', 'id', 'name', 'preferredCity', 'qualificationCountry', 'targetArrivalDate', 'whoMoving']);
    expect(t.atsGpForRanking(map[au.userId]).au).toBe(map[au.userId].au);

    // staff chip
    expect(t.atsMatchGpChip(map[au.userId])).toBe('Australian GP, segment A');
    expect(t.atsMatchGpChip(map[restricted.userId])).toBe('Australian GP, segment A (DPA roles only)');
    expect(t.atsMatchGpChip(map[uk.userId])).toBe('');
    expect(t.atsMatchGpChip({ dpaEligible: true })).toBe('Australia-trained');

    // the job summary handed to the prompt carries the role fields (read only by the Australian prompt)
    const summary = t.atsJobMatchSummary(rows('career_roles')[0]);
    expect(summary).toMatchObject({ billing_model: 'mixed', vr_requirement: 'vr_required', sessions_min: 6, sessions_max: 10, mmm: 'MM1' });
  });

  it('SWITCH OFF: the old country answer, no Australian block, and none of the three new reads', async () => {
    const au = add('au_vr', { credentials: UNCONFIRMED_19AB });   // country Australia
    const uk = add('overseas_null');
    h.setSwitch(false);
    h.emu.reset();
    const map = await t.atsBuildGpMatchInputs([au.userId, uk.userId]);
    expect(map[au.userId].dpaEligible).toBe(true);    // exactly what main does today for this row
    expect(map[au.userId].au).toBeUndefined();
    expect(map[uk.userId].dpaEligible).toBe(false);
    expect(h.emu.requests.filter((r) => r.table === 'gp_credentials')).toEqual([]);
    expect(h.emu.requests.filter((r) => /candidate_pathway|preferred_locations/.test(r.query))).toEqual([]);
  });

  it('the pathway rows cannot be read: every doctor in the batch is limited to DPA roles for that request', async () => {
    const au = add('au_vr');
    h.emu.failTables = { gp_credentials: 500 };
    const map = await t.atsBuildGpMatchInputs([au.userId]);
    expect(map[au.userId].dpaEligible).toBe(false);
    expect(map[au.userId].au).toBeUndefined();
  });

  it('place tags: no visa tag for A and C, no DPA tag for A; an overseas doctor\'s are untouched', async () => {
    const job = { dpa: true, visa_pathway_aligned: true, family_friendly: true, regional: true, location_state: 'NSW', practice_type: 'Independent' };
    const all = ['DPA approved', 'Visa pathway aligned', 'Family friendly', 'Regional NSW', 'Independent'];
    expect(t.buildRedirectAlternativeTags(job)).toEqual(all);
    const a = await t.resolveCandidatePathway(add('au_vr').userId);
    const b = await t.resolveCandidatePathway(add('au_restricted').userId);
    const c = await t.resolveCandidatePathway(add('au_non_vr').userId);
    const uk = await t.resolveCandidatePathway(add('overseas_null').userId, { legacyDpaExempt: false });
    expect(t.buildRedirectAlternativeTags(job, a)).toEqual(['Family friendly', 'Regional NSW', 'Independent']);
    expect(t.buildRedirectAlternativeTags(job, b)).toEqual(all);
    expect(t.buildRedirectAlternativeTags(job, c)).toEqual(['DPA approved', 'Family friendly', 'Regional NSW', 'Independent']);
    expect(t.buildRedirectAlternativeTags(job, uk)).toEqual(all);
  });

  it('match reasons are sanitised for an Australian doctor wherever they are stored or shown, and left alone for anyone else', async () => {
    const reasons = ['Mixed billing, as you prefer.', 'About 70% of billings.', 'Visa sponsorship is available.', 'Close to home.'];
    const a = await t.resolveCandidatePathway(add('au_vr').userId);
    expect(t.auReasonsForGp({ pathway: a }, reasons)).toEqual(['Mixed billing, as you prefer.', 'Close to home.']);
    expect(t.auReasonsForGp(a, reasons)).toEqual(['Mixed billing, as you prefer.', 'Close to home.']);
    expect(t.auReasonsForGp({ pathway: { isAu: false } }, reasons)).toBe(reasons);
    expect(t.auReasonsForGp(null, reasons)).toBe(reasons);
    // the match email: reasons sanitised and no "DPA approved" line for segment A
    const rowWithReasons = { id: 'app-1', match_reasons: { reasons }, match_expires_at: new Date(Date.now() + 86400000).toISOString() };
    const job = { title: 'GP', dpa: true, location_city: 'Dubbo', location_state: 'NSW', billing_model: 'bulk' };
    const auHtml = t.buildMatchEmailHtml(rowWithReasons, job, { name: 'Test Regional Practice (FAKE)' }, { gpLastName: 'Auvr', auPathway: a });
    expect(auHtml).toContain('Mixed billing, as you prefer.');
    expect(auHtml).not.toContain('70%');
    expect(auHtml).not.toContain('Visa sponsorship');
    expect(auHtml).not.toContain('DPA approved');
    const overseasHtml = t.buildMatchEmailHtml(rowWithReasons, job, { name: 'Test Regional Practice (FAKE)' }, { gpLastName: 'Ukgp' });
    expect(overseasHtml).toContain('DPA approved');
    expect(overseasHtml).toContain('Visa sponsorship is available.');
  });
});

describe('start date (COM-13) and the server-owned preferred locations', () => {
  it('an Australian doctor\'s start date comes from availability and notice; an overseas doctor keeps the arrival date', async () => {
    const au = add('au_vr', { profile: { available_from: '2027-04-01', notice_period_weeks: 2, target_arrival_date: '2029-09' } });
    expect(await t.auStartDateForUser(au.userId)).toEqual({ iso: '2027-04-01', basis: 'both' });
    expect(await t.auIntroTargetDate(au.userId, row('user_profiles', au.userId), '2029-09')).toBe('2027-04-01');
    const none = add('au_vr', { profile: { available_from: null, notice_period_weeks: null } });
    expect(await t.auStartDateForUser(none.userId)).toEqual({ iso: '', basis: 'none' });
    const uk = add('overseas_null', { profile: { target_arrival_date: '2027-06' } });
    expect(await t.auStartDateForUser(uk.userId)).toBe(null);
    expect(await t.auIntroTargetDate(uk.userId, row('user_profiles', uk.userId), '2027-06')).toBe('2027-06');
    h.setSwitch(false);
    h.emu.reset();
    expect(await t.auStartDateForUser(au.userId)).toBe(null);
    expect(await t.auIntroTargetDate(au.userId, {}, '2029-09')).toBe('2029-09');
    expect(h.emu.requests.length).toBe(0);
  });

  it('the full list is stored from validated values only, in its own write', async () => {
    const d = add('au_vr');
    h.emu.reset();
    const write = await t.auWritePreferredLocations(d.userId, ['Sydney', 'Regional NSW', 'Sydney', 'Atlantis', 7, 'Anywhere in Australia']);
    expect(write).toEqual({ ok: true, locations: ['Sydney', 'Regional NSW', 'Anywhere in Australia'] });
    expect(row('user_profiles', d.userId).preferred_locations).toEqual(['Sydney', 'Regional NSW', 'Anywhere in Australia']);
    const writes = h.emu.requests.filter((r) => r.method === 'PATCH');
    expect(writes.length).toBe(1);
    expect(Object.keys(writes[0].body)).toEqual(['preferred_locations']);
    expect(await t.auReadPreferredLocations(d.userId)).toEqual(['Sydney', 'Regional NSW', 'Anywhere in Australia']);
    h.emu.missingColumns = { user_profiles: ['preferred_locations'] };
    expect(await t.auWritePreferredLocations(d.userId, ['Perth'])).toEqual({ ok: false, reason: 'schema_missing' });
    expect(await t.auReadPreferredLocations(d.userId)).toEqual([]);
    h.setSwitch(false);
    expect(await t.auWritePreferredLocations(d.userId, ['Perth'])).toEqual({ ok: false, reason: 'feature_off' });
  });

  it('finishing the Australian onboarding branch stores it', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function completeAuOnboarding('), src.indexOf('async function completeAuOnboarding(') + 16000);   // FR-2: the function grew (the repeat-completion branch sits before this write)
    expect(fn).toContain('auWritePreferredLocations(userId, validation.answers && validation.answers.locations)');
  });

  it('home for the distance sort: stored coordinates, else our own suburb cache, else none. No outside lookup', async () => {
    expect(await t.auHomeForMatching(HOME_PARRAMATTA)).toMatchObject({ latitude: -33.817, longitude: 151.003, source: 'profile', commuteRadiusKm: 30 });
    rows('career_suburb_geo_cache').push({ id: 1, suburb: 'Dubbo', state_code: 'NSW', latitude: -32.25, longitude: 148.6, geocode_status: 'success' });
    h.emu.reset();
    expect(await t.auHomeForMatching({ current_suburb: 'dubbo', current_state: 'nsw' })).toMatchObject({ latitude: -32.25, longitude: 148.6, source: 'suburb_cache' });
    expect(await t.auHomeForMatching({ current_suburb: 'Nowhereville', current_state: 'NSW' })).toMatchObject({ latitude: null, longitude: null, source: 'none' });
    expect(await t.auHomeForMatching(null)).toMatchObject({ source: 'none' });
    expect(h.emu.requests.every((r) => r.table === 'career_suburb_geo_cache')).toBe(true);
  });
});

describe('intent facts for the Australian model', () => {
  it('verified needs both the staff check and the register status; an overseas doctor has no Australian facts', async () => {
    const verified = add('au_vr', { profile: { register_body: 'ahpra', register_number: 'MED0001234567', register_status: 'verified' }, credentials: { ahpra_number: 'MED0001234567', staff_verified_at: NOW, staff_verified_by: STAFF } });
    expect(await t.auIntentFactsFor(verified.userId, row('user_profiles', verified.userId))).toEqual({ model: 'au', pathway: 'au_vr', ahpraVerified: true, ahpraOnFile: true, fellowshipType: 'fracgp' }); // fellowshipType: WP-09, for the staff drawer's FRACGP / FACRRM line
    const pending = add('au_vr', { selfDeclared: true, profile: { register_body: 'ahpra', register_number: 'MED0001234567', register_status: 'pending_verification' }, credentials: { ahpra_number: 'MED0001234567', staff_verified_at: null, staff_verified_by: null } });
    expect(await t.auIntentFactsFor(pending.userId, row('user_profiles', pending.userId))).toMatchObject({ model: 'au', ahpraVerified: false, ahpraOnFile: true });
    const uk = add('overseas_null');
    expect(await t.auIntentFactsFor(uk.userId, row('user_profiles', uk.userId))).toBe(null);
    h.emu.failTables = { gp_credentials: 500 };
    expect(await t.auIntentFactsFor(verified.userId, {})).toEqual({ unreadable: true });
    h.emu.failTables = {};
    h.setSwitch(false);
    h.emu.reset();
    expect(await t.auIntentFactsFor(verified.userId, {})).toBe(null);
    expect(h.emu.requests.length).toBe(0);
    // the input the scorer is handed
    expect(t.atsIntentInputFromFacts({ auIntent: { model: 'au', ahpraVerified: true, ahpraOnFile: true }, regStage: 'placement' })).toMatchObject({ pathwayModel: 'au', ahpraVerified: true, ahpraOnFile: true });
    expect(Object.keys(t.atsIntentInputFromFacts({ regStage: 'myintealth' }))).not.toContain('pathwayModel');
    expect(Object.keys(t.atsIntentInputFromFacts({ auIntent: { unreadable: true } }))).not.toContain('pathwayModel');
  });
});

// Australian GP build, FR-9 (finishing pass): the location doors the first FR-9 pass left open.
//   - a practice point outside Australia is no point on the OLDER ordering path too (a doctor with
//     a home but no location choice), not only on the location-choice path (S9-16)
//   - a saved location choice that cannot be read only changes the ORDER: every role still shows
//   - anything going wrong while ordering hands the roles back in the usual order (never blanks them)
//   - the older place list (saved when the picker did not load) replaces an earlier picker choice
//     and keeps preferred_city in step, in Account and on a repeat sign-up
// Each test fails on the code before this pass. Fixture and in-memory database only.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const auLocationMatch = require('../lib/au-location-match.js');

const NOW = new Date().toISOString();
const EMPTY_TABLES = ['registration_tasks', 'task_timeline', 'gp_applications', 'placements', 'user_documents',
  'admin_audit_log', 'candidate_leads', 'runtime_kv', 'rate_limits', 'gp_nudge_log', 'user_roles', 'career_interviews',
  'scheduled_calls', 'career_suburb_geo_cache', 'ats_stage_events', 'ats_offers', 'match_cache', 'career_contracts', 'onboarding_reminders', 'pep_waitlist'];
const ROLE_BASE = { provider: 'internal_ats', is_active: true, approval_status: 'approved', job_status: 'open', ats_created: true, updated_at: NOW, published_at: NOW, location_country: 'Australia', tags: [] };
function seedRoles() {
  return [
    Object.assign({}, ROLE_BASE, {
      id: 'role-metro', provider_role_id: 'ats_fr9b_metro', title: 'GP (FAKE metro)', masked_title: 'Parramatta - Mixed Billing',
      practice_name: 'FR9B Metro Practice (FAKE)', practice_id: 'p-metro', suburb: 'Parramatta', location_city: 'Parramatta', location_state: 'NSW', nearest_city: 'Sydney',
      billing_model: 'mixed', mixed_billing: true, dpa: false, dpa_status: 'no', mmm: 'MM1', metro: true, visa_pathway_aligned: false,
      vr_requirement: 'vr_required', accepts_registrars: false, accepts_supervised: false
    }),
    Object.assign({}, ROLE_BASE, {
      id: 'role-dpa', provider_role_id: 'ats_fr9b_dpa', title: 'GP (FAKE regional DPA)', masked_title: 'DPA - Dubbo - Bulk Billing',
      practice_name: 'FR9B Regional Practice (FAKE)', practice_id: 'p-dubbo', suburb: 'Dubbo', location_city: 'Dubbo', location_state: 'NSW', nearest_city: 'Dubbo',
      billing_model: 'bulk', dpa: true, dpa_status: 'yes', mmm: 'MM3', regional: true, visa_pathway_aligned: true,
      vr_requirement: 'vr_preferred', accepts_registrars: false, accepts_supervised: false
    })
  ];
}
// The metro practice's point is in London (a wrong geocode); Dubbo's is real.
const PRACTICES = [
  { id: 'p-metro', name: 'FR9B Metro Practice (FAKE)', latitude: 51.5072, longitude: -0.1276, location_state: 'NSW', suburb: 'Parramatta', metadata: {}, is_active: true },
  { id: 'p-dubbo', name: 'FR9B Regional Practice (FAKE)', latitude: -32.2569, longitude: 148.6011, location_state: 'NSW', suburb: 'Dubbo', metadata: {}, is_active: true }
];
const METRO = 'internal_ats:ats_fr9b_metro';
const DPA = 'internal_ats:ats_fr9b_dpa';
const VR = { ahpra_registration_type: 'specialist', specialist_gp: true, fellowship_type: 'fracgp', vr_status: 'vr', has_conditions: false, work_rights: 'citizen', moratorium_19ab_status: 'no' };

let h;
let seq = 0;
const rows = (table) => h.emu.table(table);
const row = (table, userId) => rows(table).filter((r) => r.user_id === userId)[0] || null;
const profile = (d) => row('user_profiles', d.userId);
const kv = (key) => { const r = rows('runtime_kv').filter((x) => x.key === key)[0]; return r ? r.value : null; };
function add(kind, overrides) {
  seq += 1;
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: 'f9b' + seq }, overrides || {}));
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}
const doctor = () => add('au_vr', { selfDeclared: true, credentials: VR });
const roles = (d) => h.get('/api/career/roles', { cookie: d.cookie });
const crisp = (res) => (res.json.roles || []).filter((r) => r.qualifies && !r.blurred);
const saveChoice = (d, choice) => h.post('/api/account/au-details', { locationChoice: choice }, { cookie: d.cookie });

beforeAll(async () => {
  const tables = { career_roles: seedRoles(), practices: PRACTICES.map((p) => Object.assign({}, p)) };
  EMPTY_TABLES.forEach((name) => { tables[name] = []; });
  ['user_profiles', 'gp_credentials', 'registration_cases', 'user_state'].forEach((name) => { tables[name] = []; });
  h = await bootAuTestServer({ name: 'fr9b-loc', tables });
}, 60000);
afterAll(async () => { if (h) await h.close(); });
beforeEach(() => {
  h.setSwitch(true);
  delete process.env.AHPRA_LOOKUP_PROVIDER;
  h.emu.failTables = {};
  vi.restoreAllMocks();
});

describe('S9-16 on the older ordering path: a practice point outside Australia is no distance', () => {
  it('a doctor with a home point but no location choice gets no distance to a practice placed in London', async () => {
    const d = doctor();
    Object.assign(profile(d), { current_latitude: -33.8688, current_longitude: 151.2093, current_suburb: 'Sydney', current_state: 'NSW', preferred_locations: [] });
    const res = await roles(d);
    expect(res.status).toBe(200);
    const byId = {};
    crisp(res).forEach((r) => { byId[r.id] = r; });
    expect(Object.keys(byId).sort()).toEqual([DPA, METRO].sort());
    expect(byId[METRO].distanceKm).toBe(null);          // it used to be about 17,000 km
    expect(byId[DPA].distanceKm).toBeGreaterThan(250);   // a real point still measures
  });
});

describe('location only orders: when it fails, every role is still shown', () => {
  it('a saved location choice that cannot be read: both roles still shown (the order is the only thing that may change)', async () => {
    const d = doctor();
    expect((await saveChoice(d, { base: 'loc:NSW:2150:parramatta', travel: 'commute', places: [] })).status).toBe(200);
    expect(kv('au_location_choice:' + d.userId)).toBeTruthy();
    expect(crisp(await roles(d)).length).toBe(2);
    h.emu.failTables = { runtime_kv: 500 };
    const res = await roles(d);
    expect(res.status).toBe(200);
    expect(crisp(res).map((r) => r.id).sort()).toEqual([DPA, METRO].sort());
  });
  it('the ordering itself throwing hands the roles back unblurred in the usual order', async () => {
    const d = doctor();
    expect((await saveChoice(d, { base: 'loc:NSW:2150:parramatta', travel: 'commute', places: [] })).status).toBe(200);
    vi.spyOn(auLocationMatch, 'orderRolesByLocation').mockImplementation(() => { throw new Error('boom'); });
    const res = await roles(d);
    expect(res.status).toBe(200);
    expect(crisp(res).map((r) => r.id).sort()).toEqual([DPA, METRO].sort());
    expect((res.json.roles || []).filter((r) => r.blurred).length).toBe(0);
  });
});

describe('the older place list (no picker) replaces an earlier picker choice and keeps preferred_city in step', () => {
  it('Account: a picker choice of Sydney, then the older list "Regional NSW": the city is cleared and the new answer is the one used', async () => {
    const d = doctor();
    expect((await saveChoice(d, { base: 'loc:NSW:2150:parramatta', travel: 'commute', places: [] })).status).toBe(200);
    expect(profile(d).preferred_city).toBe('Sydney');
    const save = await h.post('/api/account/au-details', { preferredLocations: ['Regional NSW'], currentState: 'NSW', currentSuburb: 'Dubbo', currentPostcode: '2830' }, { cookie: d.cookie });
    expect(save.status).toBe(200);
    expect(profile(d).preferred_city).toBe(null);
    const stored = kv('au_location_choice:' + d.userId);
    expect(stored.legacy).toBe(true);
    expect(stored.base && stored.base.label).toMatch(/Dubbo NSW 2830/);
    expect((stored.places || []).map((p) => p.label)).toEqual(['Regional NSW']);
    const read = await h.get('/api/account/au-details', { cookie: d.cookie });
    expect(JSON.stringify(read.json)).toMatch(/Regional NSW/);
    // and back to a city through the same older list
    await h.post('/api/account/au-details', { preferredLocations: ['Melbourne'], currentState: 'VIC' }, { cookie: d.cookie });
    expect(profile(d).preferred_city).toBe('Melbourne');
  });
  it('a repeat sign-up with the older list only: the earlier picker choice is replaced, the city follows', async () => {
    const d = add('overseas_null', { noCase: true, profile: { registration_country: '', qualification_country: '', onboarding_completed_at: null, register_body: null, register_number: null, register_status: null } });
    row('user_state', d.userId).state = {};
    const body = (over) => ({ auBranch: 'yes', au: Object.assign({ ahpraNumber: 'MED0001234567', registrationType: 'specialist', fellowship: 'fracgp', hasConditions: false, moratorium19ab: 'no', workRights: 'citizen',
      noticeWeeks: 4, availableFrom: '2026-12-18', sessions: 8, detailsConfirmed: true }, over || {}) });
    expect((await h.post('/api/onboarding/complete', body({ base: 'loc:NSW:2150:parramatta', travel: 'commute', places: [] }), { cookie: d.cookie })).status).toBe(200);
    expect(profile(d).preferred_city).toBe('Sydney');
    const again = await h.post('/api/onboarding/complete', body({ locations: ['Regional NSW'], state: 'NSW', suburb: 'Dubbo', postcode: '2830' }), { cookie: d.cookie });
    expect(again.status).toBe(200);
    expect(profile(d).preferred_locations).toEqual(['Regional NSW']);
    expect(profile(d).preferred_city).toBe(null);
    const stored = kv('au_location_choice:' + d.userId);
    expect(stored.legacy).toBe(true);
    expect((stored.places || []).map((p) => p.label)).toEqual(['Regional NSW']);
  });
});

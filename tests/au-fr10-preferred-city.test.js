// Australian GP build, FR-10 (review round 13, R13-01): an Australian doctor whose chosen places
// include no major city could not finish signing up. user_profiles.preferred_city is NOT NULL
// (default '') in the real database and the sign-up wrote null; Account, a repeat sign-up and
// the older place-list sync wrote null too and the failure was swallowed, so the old city stayed.
// The emulator here refuses a null in any live NOT NULL user_profiles column, as Postgres does.
// Every test that writes a regional-only choice fails on the code before FR-10.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const { PRODUCTION_NOT_NULL } = require('./helpers/au-supabase-emulator.js');

const EMPTY_TABLES = ['registration_tasks', 'task_timeline', 'gp_applications', 'placements', 'user_documents',
  'admin_audit_log', 'candidate_leads', 'runtime_kv', 'rate_limits', 'gp_nudge_log', 'user_roles', 'career_interviews',
  'scheduled_calls', 'career_suburb_geo_cache', 'ats_stage_events', 'ats_offers', 'match_cache', 'career_contracts',
  'onboarding_reminders', 'pep_waitlist', 'career_roles', 'practices'];
const VR = { ahpra_registration_type: 'specialist', specialist_gp: true, fellowship_type: 'fracgp', vr_status: 'vr', has_conditions: false, work_rights: 'citizen', moratorium_19ab_status: 'no' };

let h;
let seq = 0;
const rows = (table) => h.emu.table(table);
const row = (table, userId) => rows(table).filter((r) => r.user_id === userId)[0] || null;
const profile = (d) => row('user_profiles', d.userId);
function add(kind, overrides) {
  seq += 1;
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: 'f10c' + seq }, overrides || {}));
  const db = buildAuFixtureDb([d]);
  Object.keys(db).forEach((table) => db[table].forEach((r) => rows(table).push(JSON.parse(JSON.stringify(r)))));
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}
function newDoctor() {
  const d = add('overseas_null', { noCase: true, profile: { registration_country: '', qualification_country: '', onboarding_completed_at: null, register_body: null, register_number: null, register_status: null } });
  row('user_state', d.userId).state = {};
  return d;
}
const signUp = (d, where) => h.post('/api/onboarding/complete', { auBranch: 'yes', au: Object.assign({ ahpraNumber: 'MED0001234567', registrationType: 'specialist', fellowship: 'fracgp', hasConditions: false, moratorium19ab: 'no', workRights: 'citizen',
  noticeWeeks: 4, availableFrom: '2026-12-18', sessions: 8, detailsConfirmed: true }, where) }, { cookie: d.cookie });

beforeAll(async () => {
  const tables = {};
  EMPTY_TABLES.forEach((name) => { tables[name] = []; });
  ['user_profiles', 'gp_credentials', 'registration_cases', 'user_state'].forEach((name) => { tables[name] = []; });
  h = await bootAuTestServer({ name: 'fr10-city', tables, emulator: { notNull: PRODUCTION_NOT_NULL } });
}, 60000);
afterAll(async () => { if (h) await h.close(); });
beforeEach(() => {
  h.setSwitch(true);
  delete process.env.AHPRA_LOOKUP_PROVIDER;
  h.emu.failTables = {};
  vi.restoreAllMocks();
});

describe('R13-01: sign-up finishes when no chosen place is a major city', () => {
  const cases = [
    ['based in Ballarat, commute', { base: 'loc:VIC:3350:ballarat', travel: 'commute', places: [] }],
    ['based in Dubbo, anywhere', { base: 'loc:NSW:2830:dubbo', travel: 'anywhere', places: [] }],
    ['based in Dubbo, a region only (Regional NSW)', { base: 'loc:NSW:2830:dubbo', travel: 'places', places: ['region:NSW'] }],
    ['based in Dubbo, specific places that are all regional towns', { base: 'loc:NSW:2830:dubbo', travel: 'places', places: ['loc:VIC:3350:ballarat', 'loc:NSW:2800:orange'] }]
  ];
  cases.forEach(([label, where]) => {
    it(label + ': 200, onboarding complete, preferred_city is the empty value (never null)', async () => {
      const d = newDoctor();
      const res = await signUp(d, where);
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(profile(d).onboarding_completed_at).toBeTruthy();
      expect(profile(d).preferred_city).toBe('');
      expect(h.emu.requests.filter((r) => r.notNullViolation).length).toBe(0);
    });
  });
  it('a choice that includes a city still stores that city (Parramatta commute: Sydney; Ballarat within the state: Melbourne)', async () => {
    const d = newDoctor();
    const res = await signUp(d, { base: 'loc:NSW:2150:parramatta', travel: 'commute', places: [] });
    expect(res.status).toBe(200);
    expect(profile(d).preferred_city).toBe('Sydney');
    const e = newDoctor();
    expect((await signUp(e, { base: 'loc:VIC:3350:ballarat', travel: 'state', places: [] })).status).toBe(200);
    expect(profile(e).preferred_city).toBe('Melbourne');
  });
  it('a repeat sign-up that moves from Sydney to Ballarat clears the city (and says the preferences were saved)', async () => {
    const d = newDoctor();
    expect((await signUp(d, { base: 'loc:NSW:2150:parramatta', travel: 'commute', places: [] })).status).toBe(200);
    expect(profile(d).preferred_city).toBe('Sydney');
    const again = await signUp(d, { base: 'loc:VIC:3350:ballarat', travel: 'commute', places: [] });
    expect(again.status).toBe(200);
    expect(again.json.auPreferencesSaved).toBe(true);
    expect(profile(d).preferred_city).toBe('');
  });
  it('a repeat sign-up whose city write fails does not say the preferences were saved, and it is logged', async () => {
    const d = newDoctor();
    expect((await signUp(d, { base: 'loc:NSW:2150:parramatta', travel: 'commute', places: [] })).status).toBe(200);
    const warn = vi.spyOn(console, 'warn');
    h.emu.forbid((r) => (r.table === 'user_profiles' && r.method === 'PATCH' && /preferred_city/.test(JSON.stringify(r.body || '')) ? 'city write refused for the test' : null));
    try {
      const again = await signUp(d, { base: 'loc:VIC:3350:ballarat', travel: 'commute', places: [] });
      expect(again.status).toBe(200);
      expect(again.json.auPreferencesSaved).toBe(false);
    } finally { h.emu.forbid(null); }
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/preferred city not saved/);
  });
});

describe('R13-01: Account moves', () => {
  const doctor = () => add('au_vr', { selfDeclared: true, credentials: VR });
  const save = (d, body) => h.post('/api/account/au-details', body, { cookie: d.cookie });
  it('Sydney to Ballarat in Account: 200 and preferred_city becomes the empty value, not "Sydney"', async () => {
    const d = doctor();
    expect((await save(d, { locationChoice: { base: 'loc:NSW:2150:parramatta', travel: 'commute', places: [] } })).status).toBe(200);
    expect(profile(d).preferred_city).toBe('Sydney');
    const res = await save(d, { locationChoice: { base: 'loc:VIC:3350:ballarat', travel: 'commute', places: [] } });
    expect(res.status).toBe(200);
    expect(profile(d).preferred_city).toBe('');
  });
  it('the older place list in Account (Regional NSW): the city is cleared to the empty value', async () => {
    const d = doctor();
    expect((await save(d, { locationChoice: { base: 'loc:NSW:2150:parramatta', travel: 'commute', places: [] } })).status).toBe(200);
    const res = await save(d, { preferredLocations: ['Regional NSW'], currentState: 'NSW', currentSuburb: 'Dubbo', currentPostcode: '2830' });
    expect(res.status).toBe(200);
    expect(profile(d).preferred_city).toBe('');
  });
  it('a city write that fails in Account is not reported as saved (502, a plain message)', async () => {
    const d = doctor();
    expect((await save(d, { locationChoice: { base: 'loc:NSW:2150:parramatta', travel: 'commute', places: [] } })).status).toBe(200);
    h.emu.forbid((r) => (r.table === 'user_profiles' && r.method === 'PATCH' && /preferred_city/.test(JSON.stringify(r.body || '')) ? 'city write refused for the test' : null));
    let res;
    try { res = await save(d, { locationChoice: { base: 'loc:VIC:3350:ballarat', travel: 'commute', places: [] } }); } finally { h.emu.forbid(null); }
    expect(res.status).toBe(502);
    expect(res.json.message).toMatch(/could not save where you would like to work/i);
    const legacy = await (async () => {
      h.emu.forbid((r) => (r.table === 'user_profiles' && r.method === 'PATCH' && /preferred_city/.test(JSON.stringify(r.body || '')) ? 'city write refused for the test' : null));
      try { return await save(d, { preferredLocations: ['Regional NSW'], currentState: 'NSW' }); } finally { h.emu.forbid(null); }
    })();
    expect(legacy.status).toBe(502);
  });
});

describe('R13-01: overseas doctors and the switch off are unchanged', () => {
  it('switch off: the Australian Account route stays closed and no preferred_city write is made', async () => {
    const d = add('au_vr', { selfDeclared: true, credentials: VR });
    Object.assign(profile(d), { preferred_city: 'Sydney' });
    h.setSwitch(false);
    h.emu.reset();
    const res = await h.post('/api/account/au-details', { locationChoice: { base: 'loc:VIC:3350:ballarat', travel: 'commute', places: [] } }, { cookie: d.cookie });
    expect(res.status).not.toBe(200);
    expect(profile(d).preferred_city).toBe('Sydney');
    expect(h.emu.requestsTo('user_profiles').filter((r) => r.method === 'PATCH').length).toBe(0);
  });
});

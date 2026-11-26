// WP-02 of the Australian GP build, server side, against the real server and an
// in-memory Supabase emulator. Both states of AU_PATHWAY_ENABLED (read at call
// time, so one booted server serves both).
//
// Covers: resolveCandidatePathway for the six standard doctors; switch off
// (nothing queried); the migration not applied yet (schemaMissing, logged
// once); unreadable records (fail closed); the writers and the case mirror;
// the staff endpoint (who may call it, validation, audit row, switch off);
// the doctor's browser cannot set a pathway; how a page learns the switch;
// and the admin onboarding override (DAT-19).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const {
  buildAllAuDoctors, buildAuDoctor, buildAuFixtureDb, AU_DOCTOR_KINDS, STAFF_EMAIL, WP02_NEW_COLUMN_NAMES
} = require('./helpers/au-fixtures.js');
const gc = require('../lib/gp-credentials.js');

let h, t, doctors, target, seedTarget;
const PATHWAY_COLS = gc.PATHWAY_PROFILE_COLUMNS;

const profileRow = (d) => h.emu.table('user_profiles').find((r) => r.user_id === d.userId);
const caseRowOf = (d) => h.emu.table('registration_cases').find((r) => r.user_id === d.userId);
const credRow = (d) => h.emu.table('gp_credentials').find((r) => r.user_id === d.userId);
const audits = () => h.emu.table('admin_audit_log');
// Requests that named a WP-02 pathway column or table.
const newNameRequests = () => h.emu.requests.filter((r) => {
  if (r.table === 'gp_credentials') return true;
  const named = (r.select || []).concat(r.filterColumns).concat(r.bodyKeys);
  if (r.table === 'user_profiles' && named.some((c) => WP02_NEW_COLUMN_NAMES.indexOf(c) !== -1)) return true;
  return r.table === 'registration_cases' && named.indexOf('pathway') !== -1;
});

beforeAll(async () => {
  doctors = buildAllAuDoctors();
  // A spare overseas doctor the staff endpoint tests move around, assigned to the test RSO.
  target = buildAuDoctor('overseas_null', { idSuffix: '7' });
  // And one for the onboarding override.
  seedTarget = buildAuDoctor('overseas_null', { idSuffix: '8' });
  const tables = buildAuFixtureDb(Object.values(doctors).concat([target, seedTarget]));
  h = await bootAuTestServer({ name: 'wp02-server', tables });
  t = h.testUtils;
  caseRowOf(target).assigned_rso = h.RSO_USER_ID;
});

afterAll(async () => { if (h) await h.close(); });

beforeEach(() => {
  h.setSwitch(true);
  h.emu.reset();
  h.emu.missingColumns = {};
  h.emu.missingTables = new Set();
  h.emu.failTables = {};
});

describe('resolveCandidatePathway (switch on)', () => {
  AU_DOCTOR_KINDS.forEach((kind) => {
    it(kind + ' resolves to its expected pathway, segment and DPA answer', async () => {
      const d = doctors[kind];
      const r = await t.resolveCandidatePathway(d.userId, { legacyDpaExempt: false });
      expect(r).toMatchObject(d.expected);
      expect(r.flagEnabled).toBe(true);
      expect(r.schemaMissing).toBeUndefined();
      expect(r.readFailed).toBeUndefined();
    });
  });

  it('reads the new columns in their own two small queries, never widening another select', async () => {
    await t.resolveCandidatePathway(doctors.au_vr.userId);
    expect(h.emu.requests.map((r) => r.table)).toEqual(['user_profiles', 'gp_credentials']);
    expect(h.emu.requests[0].select).toEqual(PATHWAY_COLS.slice());
  });

  it('credentials: false skips gp_credentials (enough for pathway / segment / isAu / launched)', async () => {
    const r = await t.resolveCandidatePathway(doctors.au_vr.userId, { credentials: false });
    expect(h.emu.requests.map((q) => q.table)).toEqual(['user_profiles']);
    expect(r).toMatchObject({ pathway: 'au_vr', segment: 'A', isAu: true, launched: true });
    // Without credentials the DPA answer is the closed one.
    expect(r.dpaRestricted).toBe(true);
  });

  it('an overseas doctor: the DPA answer is exactly the country answer passed in', async () => {
    const d = doctors.overseas_null;
    expect((await t.resolveCandidatePathway(d.userId, { legacyDpaExempt: true })).dpaRestricted).toBe(false);
    expect((await t.resolveCandidatePathway(d.userId, { legacyDpaExempt: false })).dpaRestricted).toBe(true);
    expect((await t.resolveCandidatePathway(d.userId)).dpaRestricted).toBe(true);
  });

  it('an unknown user, an empty id and a garbage stored value all read as overseas', async () => {
    expect(await t.resolveCandidatePathway('00000000-0000-4000-8000-00000000ffff')).toMatchObject({ pathway: 'overseas_esp', isAu: false, recorded: false });
    expect(await t.resolveCandidatePathway('')).toMatchObject({ pathway: 'overseas_esp', isAu: false });
    expect(await t.resolveCandidatePathway(null)).toMatchObject({ pathway: 'overseas_esp', isAu: false });
    const row = profileRow(doctors.overseas_null);
    row.candidate_pathway = 'AUSTRALIA!!';
    row.candidate_basis = 'australia';
    try {
      expect(await t.resolveCandidatePathway(doctors.overseas_null.userId)).toMatchObject({ pathway: 'overseas_esp', basis: 'overseas', isAu: false, recorded: false });
    } finally { row.candidate_pathway = null; row.candidate_basis = null; }
  });
});

describe('resolveCandidatePathway: switch off', () => {
  it('returns the overseas default for every doctor and queries NOTHING', async () => {
    h.setSwitch(false);
    for (const kind of AU_DOCTOR_KINDS) {
      const r = await t.resolveCandidatePathway(doctors[kind].userId, { legacyDpaExempt: false });
      expect(r).toMatchObject({ pathway: 'overseas_esp', basis: 'overseas', segment: 'overseas', isAu: false, launched: true, needsStaffReview: false, flagEnabled: false, dpaRestricted: true });
    }
    expect((await t.resolveCandidatePathway(doctors.au_restricted.userId, { legacyDpaExempt: true })).dpaRestricted).toBe(false);
    expect(h.emu.requests).toEqual([]);
  });

  it('the writers refuse and query nothing', async () => {
    h.setSwitch(false);
    expect(await t.setCandidatePathway(target.userId, { pathway: 'au_vr', setBy: STAFF_EMAIL, confirmed: true })).toEqual({ ok: false, reason: 'feature_off' });
    expect(await t.upsertGpCredentials(target.userId, { ahpra_number: 'MED0001234567' }, { source: 'staff', actor: STAFF_EMAIL })).toMatchObject({ ok: false, reason: 'feature_off' });
    expect(await t.setCandidatePreferences(target.userId, { timezone: 'Australia/Perth' })).toMatchObject({ ok: false, reason: 'feature_off' });
    expect(await t.readCandidatePreferences(target.userId)).toBe(null);
    expect(h.emu.requests).toEqual([]);
    expect(profileRow(target).candidate_pathway).toBe(null);
  });
});

describe('resolveCandidatePathway: the migration has not been applied yet', () => {
  it('missing columns -> overseas default with schemaMissing, logged once, gp_credentials not even asked', async () => {
    h.emu.missingColumns = { user_profiles: WP02_NEW_COLUMN_NAMES.slice(), registration_cases: ['pathway'] };
    h.emu.missingTables = new Set(['gp_credentials']);
    t.__resetAuPathwaySchemaLogForTest();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const kind of AU_DOCTOR_KINDS) {
        const r = await t.resolveCandidatePathway(doctors[kind].userId, { legacyDpaExempt: true });
        expect(r).toMatchObject({ pathway: 'overseas_esp', basis: 'overseas', isAu: false, launched: true, needsStaffReview: false, schemaMissing: true });
        // Correct, not just safe: with no columns nobody is Australian, so today's country answer stands.
        expect(r.dpaRestricted).toBe(false);
        expect(r.readFailed).toBeUndefined();
      }
      expect(h.emu.requestsTo('gp_credentials')).toEqual([]);
      const logged = warn.mock.calls.filter((c) => String(c[0]).indexOf('[au-pathway]') === 0);
      expect(logged.length).toBe(1);
    } finally { warn.mockRestore(); }
  });

  it('a missing gp_credentials table alone -> the pathway still reads, DPA closed, schemaMissing', async () => {
    h.emu.missingTables = new Set(['gp_credentials']);
    const r = await t.resolveCandidatePathway(doctors.au_vr.userId, { legacyDpaExempt: true });
    expect(r).toMatchObject({ pathway: 'au_vr', isAu: true, schemaMissing: true, dpaRestricted: true, dpaRestrictedReason: '19ab_unknown' });
  });

  it('the writers report schema_missing instead of pretending to save', async () => {
    h.emu.missingColumns = { user_profiles: WP02_NEW_COLUMN_NAMES.slice() };
    h.emu.missingTables = new Set(['gp_credentials']);
    expect(await t.setCandidatePathway(target.userId, { pathway: 'au_vr', setBy: STAFF_EMAIL, confirmed: true })).toEqual({ ok: false, reason: 'schema_missing' });
    expect(await t.upsertGpCredentials(target.userId, { ahpra_number: 'MED0001234567' }, { source: 'staff', actor: STAFF_EMAIL })).toMatchObject({ ok: false, reason: 'schema_missing' });
    expect(await t.upsertGpCredentials(target.userId, { ahpra_number: 'MED0001234567' }, { source: 'self' })).toMatchObject({ ok: false, reason: 'schema_missing' });
    expect(await t.setCandidatePreferences(target.userId, { timezone: 'Australia/Perth' })).toMatchObject({ ok: false, reason: 'schema_missing' });
  });
});

describe('resolveCandidatePathway: records that cannot be read (not a missing migration)', () => {
  it('FAIL CLOSED: a failing profile read -> readFailed, DPA restricted even for an exempt doctor', async () => {
    h.emu.failTables = { user_profiles: 500 };
    const r = await t.resolveCandidatePathway(doctors.overseas_null.userId, { legacyDpaExempt: true });
    expect(r).toMatchObject({ pathway: 'overseas_esp', readFailed: true, dpaRestricted: true, dpaRestrictedReason: 'records_unreadable' });
    expect(r.schemaMissing).toBeUndefined();
  });

  it('FAIL CLOSED: a failing credentials read keeps the Australian pathway and stays restricted', async () => {
    h.emu.failTables = { gp_credentials: 500 };
    const r = await t.resolveCandidatePathway(doctors.au_vr.userId);
    expect(r).toMatchObject({ pathway: 'au_vr', isAu: true, readFailed: true, dpaRestricted: true });
  });
});

describe('setCandidatePathway / upsertGpCredentials / setCandidatePreferences', () => {
  const d = () => doctors.overseas_explicit;

  it('writes the profile columns AND mirrors the case; staff-confirmed stamps who and when', async () => {
    const out = await t.setCandidatePathway(d().userId, { pathway: 'au_vr', setBy: STAFF_EMAIL, confirmed: true });
    expect(out).toMatchObject({ ok: true, pathway: 'au_vr', basis: 'australia', confirmed: true, mirroredCases: 1, caseMirror: 'ok' });
    expect(profileRow(d())).toMatchObject({ candidate_pathway: 'au_vr', candidate_basis: 'australia', pathway_set_by: STAFF_EMAIL, pathway_confirmed_by: STAFF_EMAIL });
    expect(profileRow(d()).pathway_set_at).toBeTruthy();
    expect(profileRow(d()).pathway_confirmed_at).toBeTruthy();
    expect(caseRowOf(d()).pathway).toBe('au_vr');
    // Exactly the six pathway columns were written to the profile, nothing else.
    const write = h.emu.requests.find((r) => r.table === 'user_profiles' && r.method === 'PATCH');
    expect(write.bodyKeys.slice().sort()).toEqual(PATHWAY_COLS.slice().sort());
    expect((await t.resolveCandidatePathway(d().userId)).pathway).toBe('au_vr');
  });

  it('a self-declared pathway is recorded as NOT confirmed (pending staff)', async () => {
    const out = await t.setCandidatePathway(d().userId, { pathway: 'au_non_vr', setBy: 'self' });
    expect(out).toMatchObject({ ok: true, confirmed: false });
    expect(profileRow(d())).toMatchObject({ candidate_pathway: 'au_non_vr', pathway_set_by: 'self', pathway_confirmed_at: null, pathway_confirmed_by: null });
    expect(await t.resolveCandidatePathway(d().userId)).toMatchObject({ confirmed: false, needsStaffReview: true });
  });

  it('an explicit basis is kept; a bad pathway or basis is refused and writes nothing', async () => {
    expect(await t.setCandidatePathway(d().userId, { pathway: 'au_restricted', basis: 'overseas', setBy: STAFF_EMAIL, confirmed: true })).toMatchObject({ ok: true, basis: 'overseas' });
    h.emu.reset();
    for (const bad of ['AU', 'australia', '', undefined, 7, {}, 'au_vr; drop table']) {
      expect(await t.setCandidatePathway(d().userId, { pathway: bad, setBy: STAFF_EMAIL })).toEqual({ ok: false, reason: 'invalid_pathway' });
    }
    expect(await t.setCandidatePathway(d().userId, { pathway: 'au_vr', basis: 'mars', setBy: STAFF_EMAIL })).toEqual({ ok: false, reason: 'invalid_basis' });
    expect(await t.setCandidatePathway('', { pathway: 'au_vr', setBy: STAFF_EMAIL })).toEqual({ ok: false, reason: 'missing_user' });
    expect(h.emu.requests).toEqual([]);
    expect(profileRow(d()).candidate_pathway).toBe('au_restricted');
  });

  it('null clears the pathway back to "nothing recorded" (reads as overseas) on the profile and the case', async () => {
    const out = await t.setCandidatePathway(d().userId, { pathway: null, setBy: STAFF_EMAIL, confirmed: true });
    expect(out).toMatchObject({ ok: true, pathway: null, basis: null, confirmed: false });
    expect(profileRow(d())).toMatchObject({ candidate_pathway: null, candidate_basis: null, pathway_confirmed_at: null });
    expect(caseRowOf(d()).pathway).toBe(null);
    expect(await t.resolveCandidatePathway(d().userId)).toMatchObject({ pathway: 'overseas_esp', recorded: false });
    // Put the fixture back as it was.
    await t.setCandidatePathway(d().userId, { pathway: 'overseas_esp', setBy: STAFF_EMAIL, confirmed: true });
  });

  it('an unknown user is reported, and a doctor with no case is still saved', async () => {
    expect(await t.setCandidatePathway('00000000-0000-4000-8000-00000000ffff', { pathway: 'au_vr', setBy: STAFF_EMAIL })).toEqual({ ok: false, reason: 'user_not_found' });
    const noCase = buildAuDoctor('overseas_null', { idSuffix: '9', noCase: true });
    h.emu.table('user_profiles').push(Object.assign({}, noCase.profile));
    expect(await t.setCandidatePathway(noCase.userId, { pathway: 'au_vr', setBy: STAFF_EMAIL, confirmed: true })).toMatchObject({ ok: true, mirroredCases: 0, caseMirror: 'no_case' });
  });

  it('upsertGpCredentials inserts, then updates only the columns sent', async () => {
    const who = doctors.overseas_null;
    expect(credRow(who)).toBeUndefined();
    const first = await t.upsertGpCredentials(who.userId, { ahpra_number: 'med0001234567', vr_status: 'vr', moratorium_19ab_status: 'no', nonsense: 1 }, { source: 'self' });
    expect(first.ok).toBe(true);
    expect(first.rejected).toEqual(['nonsense']);
    expect(credRow(who)).toMatchObject({ user_id: who.userId, ahpra_number: 'MED0001234567', vr_status: 'vr', moratorium_19ab_status: 'no' });
    expect(credRow(who).self_declared_at).toBeTruthy();

    const staff = await t.upsertGpCredentials(who.userId, { moratorium_19ab_confirmed_status: 'no' }, { source: 'staff', actor: STAFF_EMAIL });
    expect(staff.ok).toBe(true);
    expect(credRow(who)).toMatchObject({ ahpra_number: 'MED0001234567', moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: STAFF_EMAIL });

    // The doctor changing their own answer clears the staff confirmation (fail closed).
    await t.upsertGpCredentials(who.userId, { moratorium_19ab_status: 'unsure' }, { source: 'self' });
    expect(credRow(who)).toMatchObject({ moratorium_19ab_status: 'unsure', moratorium_19ab_confirmed_status: null, moratorium_19ab_confirmed_by: null, moratorium_19ab_confirmed_at: null });

    // A doctor's own submission cannot write staff-only columns.
    const sneaky = await t.upsertGpCredentials(who.userId, { moratorium_19ab_confirmed_status: 'no', staff_verified_at: new Date().toISOString() }, { source: 'self' });
    expect(sneaky).toMatchObject({ ok: false, reason: 'nothing_to_write' });
    expect(credRow(who).moratorium_19ab_confirmed_status).toBe(null);

    // Credentials on an overseas doctor change nothing about how they resolve.
    expect(await t.resolveCandidatePathway(who.userId, { legacyDpaExempt: false })).toMatchObject({ pathway: 'overseas_esp', isAu: false, needsStaffReview: false, dpaRestricted: true });
    h.emu.db.gp_credentials = h.emu.table('gp_credentials').filter((r) => r.user_id !== who.userId);
  });

  it('setCandidatePreferences writes only preference columns and can never touch the pathway', async () => {
    const who = doctors.au_registrar;
    const out = await t.setCandidatePreferences(who.userId, {
      current_suburb: 'Test Suburb', timezone: 'Australia/Darwin', commute_radius_km: 45,
      candidate_pathway: 'au_vr', pathway_confirmed_at: new Date().toISOString()
    });
    expect(out.ok).toBe(true);
    expect(out.rejected.sort()).toEqual(['candidate_pathway', 'pathway_confirmed_at']);
    expect(profileRow(who)).toMatchObject({ current_suburb: 'Test Suburb', timezone: 'Australia/Darwin', commute_radius_km: 45, candidate_pathway: 'au_registrar', pathway_confirmed_at: null });
    expect(await t.readCandidatePreferences(who.userId)).toMatchObject({ current_suburb: 'Test Suburb', timezone: 'Australia/Darwin', commute_radius_km: 45, open_to_locum: null });
  });
});

describe('POST /api/admin/candidate/pathway (staff set / override)', () => {
  const URL = '/api/admin/candidate/pathway';
  const body = (extra) => Object.assign({ user_id: target.userId }, extra || {});

  it('switch off: 404 for everyone, nothing read, nothing written, no audit row', async () => {
    h.setSwitch(false);
    const before = audits().length;
    for (const who of [h.superAdmin(), h.consultant(), h.rso()]) {
      const post = await h.post(URL, body({ pathway: 'au_vr' }), who);
      expect(post.status).toBe(404);
      const get = await h.get(URL + '?user_id=' + target.userId, who);
      expect(get.status).toBe(404);
    }
    expect(h.emu.requests).toEqual([]);
    expect(profileRow(target).candidate_pathway).toBe(null);
    expect(audits().length).toBe(before);
  });

  it('auth: no sign-in is refused; a doctor\'s own session is not a staff session', async () => {
    expect((await h.post(URL, body({ pathway: 'au_vr' }), { host: h.SUPER_HOST })).status).toBe(401);
    const asDoctor = await h.post(URL, body({ pathway: 'au_vr' }), { host: h.SUPER_HOST, cookie: h.gpCookie(target.email, target.userId) });
    expect(asDoctor.status).toBe(401);
    // Not an admin host at all: the route does not exist.
    expect((await h.post(URL, body({ pathway: 'au_vr' }), { host: 'app.gplink-test.local', cookie: h.superAdmin().cookie })).status).toBe(404);
    expect(profileRow(target).candidate_pathway).toBe(null);
  });

  it('auth: an RSO may act only on doctors assigned to them', async () => {
    const other = await h.post(URL, body({ pathway: 'au_vr' }), h.rso(h.OTHER_RSO_EMAIL));
    expect(other.status).toBe(403);
    // A doctor with a case that is not theirs (unassigned): 403 as well.
    const unassigned = await h.post(URL, { user_id: doctors.au_non_vr.userId, pathway: 'au_vr' }, h.rso());
    expect(unassigned.status).toBe(403);
    expect((await h.get(URL + '?user_id=' + doctors.au_non_vr.userId, h.rso())).status).toBe(403);
    expect(profileRow(target).candidate_pathway).toBe(null);
    expect(profileRow(doctors.au_non_vr).candidate_pathway).toBe('au_non_vr');

    const mine = await h.post(URL, body({ pathway: 'au_restricted' }), h.rso());
    expect(mine.status).toBe(200);
    expect(mine.json.pathway).toMatchObject({ pathway: 'au_restricted', segment: 'B', confirmed: true, launched: false, needsStaffReview: true });
    expect(profileRow(target)).toMatchObject({ candidate_pathway: 'au_restricted', pathway_set_by: h.RSO_EMAIL, pathway_confirmed_by: h.RSO_EMAIL });
  });

  it('auth: a consultant and the CEO may act on any doctor', async () => {
    const byConsultant = await h.post(URL, { user_id: doctors.au_non_vr.userId, moratorium_19ab_end_date: '2030-06-30' }, h.consultant());
    expect(byConsultant.status).toBe(200);
    expect(credRow(doctors.au_non_vr).moratorium_19ab_end_date).toBe('2030-06-30');
    const byCeo = await h.post(URL, { user_id: doctors.au_non_vr.userId, moratorium_19ab_end_date: null }, h.superAdmin());
    expect(byCeo.status).toBe(200);
    expect(credRow(doctors.au_non_vr).moratorium_19ab_end_date).toBe(null);
  });

  it('validation: every bad request is a 400 and writes NOTHING', async () => {
    await t.setCandidatePathway(target.userId, { pathway: null, setBy: STAFF_EMAIL });
    h.emu.reset();
    const auditsBefore = audits().length;
    const bad = [
      {},                                                          // no user_id
      { user_id: target.userId },                                   // nothing to change
      body({ pathway: 'australia' }),
      body({ pathway: 'AU' }),
      body({ pathway: 7 }),
      body({ pathway: 'au_vr', basis: 'mars' }),
      body({ basis: 'australia' }),                                 // basis without a pathway
      body({ pathway: null, basis: 'australia' }),
      body({ pathway: 'au_vr', confirmed: 'yes' }),
      body({ moratorium_19ab_confirmed: 'unsure' }),
      body({ moratorium_19ab_confirmed: 'maybe' }),
      body({ pathway: 'au_vr', moratorium_19ab_confirmed: 'nope' }), // valid pathway + bad 19AB: nothing at all is written
      body({ moratorium_19ab_end_date: '30/06/2030' }),
      body({ pathway: 'au_vr', moratorium_19ab_end_date: 'soon' })
    ];
    for (const b of bad) {
      const res = await h.post(URL, b, h.superAdmin());
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect(res.json.ok).toBe(false);
    }
    expect(h.emu.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(profileRow(target).candidate_pathway).toBe(null);
    expect(credRow(target)).toBeUndefined();
    expect(audits().length).toBe(auditsBefore);

    const notJson = await h.request('POST', URL, Object.assign({ headers: { 'Content-Type': 'application/json' } }, h.superAdmin()));
    expect([400, 200]).toContain(notJson.status);
    expect(profileRow(target).candidate_pathway).toBe(null);
  });

  it('an unknown doctor is a 404', async () => {
    const res = await h.post(URL, { user_id: '00000000-0000-4000-8000-00000000ffff', pathway: 'au_vr' }, h.superAdmin());
    expect(res.status).toBe(404);
  });

  it('FAIL CLOSED: if the 19AB step cannot be saved, the reply says so and the doctor stays DPA-restricted', async () => {
    const auditsBefore = audits().length;
    h.emu.failTables = { gp_credentials: 500 };
    // FR-9 (deliberate): "19AB does not apply" now needs the reason the screen asks for.
    expect((await h.post(URL, body({ pathway: 'au_vr', moratorium_19ab_confirmed: 'no' }), h.superAdmin())).json).toMatchObject({ ok: false, code: 'reason_required' });
    const res = await h.post(URL, body({ pathway: 'au_vr', moratorium_19ab_confirmed: 'no', note: 'Exemption letter sighted (test)' }), h.superAdmin());
    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({ ok: false, pathwaySaved: true });
    expect(audits().length).toBe(auditsBefore + 1);
    expect(audits()[audits().length - 1]).toMatchObject({ action: 'admin_set_candidate_pathway', success: false });
    h.emu.failTables = {};
    expect(await t.resolveCandidatePathway(target.userId)).toMatchObject({ pathway: 'au_vr', dpaRestricted: true });
    await t.setCandidatePathway(target.userId, { pathway: null, setBy: STAFF_EMAIL });
  });

  it('sets pathway + basis + staff-confirmed 19AB, mirrors the case, and writes an audit row', async () => {
    const auditsBefore = audits().length;
    const res = await h.post(URL, body({ pathway: 'au_vr', moratorium_19ab_confirmed: 'no', note: 'Checked the public register (test).' }), h.superAdmin());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, caseMirror: 'ok', mirroredCases: 1, feeBasis: 'australia' });
    expect(res.json.pathway).toMatchObject({
      pathway: 'au_vr', basis: 'australia', segment: 'A', isAu: true, launched: true, confirmed: true,
      dpaRestricted: false, dpaRestrictedReason: 'staff_confirmed_19ab_not_applicable'
    });
    expect(res.json.record).toMatchObject({ candidate_pathway: 'au_vr', candidate_basis: 'australia', pathway_set_by: h.SUPER_EMAIL, pathway_confirmed_by: h.SUPER_EMAIL });
    expect(res.json.case).toMatchObject({ id: target.caseId, pathway: 'au_vr' });

    expect(profileRow(target)).toMatchObject({ candidate_pathway: 'au_vr', candidate_basis: 'australia' });
    expect(caseRowOf(target).pathway).toBe('au_vr');
    expect(credRow(target)).toMatchObject({ moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: h.SUPER_EMAIL });
    expect(credRow(target).moratorium_19ab_confirmed_at).toBeTruthy();

    expect(audits().length).toBe(auditsBefore + 1);
    const row = audits()[audits().length - 1];
    expect(row).toMatchObject({ actor_email: h.SUPER_EMAIL, actor_role: 'super_admin', action: 'admin_set_candidate_pathway', target_type: 'user', target_id: target.userId, success: true });
    expect(row.detail.before).toMatchObject({ pathway: null, moratorium_19ab_confirmed: null });
    expect(row.detail.after).toMatchObject({ pathway: 'au_vr', basis: 'australia', confirmed: true, moratorium_19ab_confirmed: 'no' });
    expect(row.detail).toMatchObject({ caseMirror: 'ok', mirroredCases: 1, note: 'Checked the public register (test).', changed: { pathway: true, moratorium_19ab: true } });
  });

  it('confirmed: false records a staff-entered but unconfirmed pathway', async () => {
    const res = await h.post(URL, body({ pathway: 'au_vr', confirmed: false }), h.superAdmin());
    expect(res.status).toBe(200);
    expect(res.json.pathway).toMatchObject({ pathway: 'au_vr', confirmed: false, needsStaffReview: true });
    expect(profileRow(target).pathway_confirmed_at).toBe(null);
  });

  it('can override back to overseas, and clear with null; both are audited', async () => {
    const auditsBefore = audits().length;
    const overseas = await h.post(URL, body({ pathway: 'overseas_pep' }), h.superAdmin());
    expect(overseas.status).toBe(200);
    expect(overseas.json.pathway).toMatchObject({ pathway: 'overseas_pep', basis: 'overseas', isAu: false, needsStaffReview: false });
    expect(overseas.json.feeBasis).toBe('overseas');
    expect(caseRowOf(target).pathway).toBe('overseas_pep');

    const cleared = await h.post(URL, body({ pathway: null }), h.superAdmin());
    expect(cleared.status).toBe(200);
    expect(cleared.json.pathway).toMatchObject({ pathway: 'overseas_esp', recorded: false });
    expect(profileRow(target).candidate_pathway).toBe(null);
    expect(caseRowOf(target).pathway).toBe(null);
    expect(audits().length).toBe(auditsBefore + 2);
  });

  it('the migration not applied: a clear 503, nothing written', async () => {
    h.emu.missingColumns = { user_profiles: WP02_NEW_COLUMN_NAMES.slice(), registration_cases: ['pathway'] };
    h.emu.missingTables = new Set(['gp_credentials']);
    const res = await h.post(URL, body({ pathway: 'au_vr' }), h.superAdmin());
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('schema_missing');
    expect(h.emu.requests.filter((r) => r.method === 'PATCH' || r.method === 'POST').filter((r) => r.table !== 'admin_audit_log')).toEqual([]);
  });
});

describe('GET /api/admin/candidate/pathway (staff read)', () => {
  const URL = '/api/admin/candidate/pathway';

  it('returns the resolved pathway, the stored record, credentials, the Ahpra source and preferences', async () => {
    const d = doctors.au_restricted;
    const res = await h.get(URL + '?user_id=' + d.userId, h.superAdmin());
    expect(res.status).toBe(200);
    expect(res.json.pathway).toMatchObject(d.expected);
    expect(res.json.record).toMatchObject({ candidate_pathway: 'au_restricted', candidate_basis: 'australia' });
    expect(res.json.credentials).toMatchObject({ ahpra_number: 'MED0001000002', work_rights: 'visa', visa_sponsor_tied: true });
    expect(res.json.ahpra).toMatchObject({ source: 'gp_credentials', number: 'MED0001000002' });
    expect(res.json.case).toMatchObject({ id: d.caseId, pathway: 'au_restricted' });
    expect(res.json.preferences).toMatchObject({ current_state: 'WA', timezone: 'Australia/Perth' });
    expect(res.json.feeBasis).toBe('australia');
  });

  it('an overseas doctor reads as overseas with today\'s country-derived DPA answer', async () => {
    const res = await h.get(URL + '?user_id=' + doctors.overseas_null.userId, h.consultant());
    expect(res.status).toBe(200);
    expect(res.json.pathway).toMatchObject({ pathway: 'overseas_esp', isAu: false, needsStaffReview: false, dpaRestricted: true, dpaRestrictedReason: 'legacy_country_restricted' });
    expect(res.json.credentials).toBe(null);
    expect(res.json.ahpra.source).toBe('none');
    expect(res.json.feeBasis).toBe('overseas');
  });

  it('needs a user_id, staff sign-in, and a doctor that exists', async () => {
    expect((await h.get(URL, h.superAdmin())).status).toBe(400);
    expect((await h.get(URL + '?user_id=' + doctors.au_vr.userId, { host: h.SUPER_HOST })).status).toBe(401);
    expect((await h.get(URL + '?user_id=00000000-0000-4000-8000-00000000ffff', h.superAdmin())).status).toBe(404);
  });
});

describe('the doctor\'s browser can never set a pathway', () => {
  const POISON = {
    candidate_pathway: 'au_vr', candidatePathway: 'au_vr', pathway: 'au_vr', candidate_basis: 'australia', candidateBasis: 'australia',
    pathway_set_by: 'me', pathway_set_at: '2026-11-20T00:00:00.000Z', pathway_confirmed_at: '2026-11-20T00:00:00.000Z', pathway_confirmed_by: 'me',
    moratorium_19ab_confirmed_status: 'no', gp_credentials: { moratorium_19ab_confirmed_status: 'no' }
  };
  const assertUntouched = async (d) => {
    const row = profileRow(d);
    PATHWAY_COLS.forEach((c) => expect(row[c], c).toBe(null));
    expect(caseRowOf(d).pathway).toBe(null);
    expect(credRow(d)).toBeUndefined();
    expect(await t.resolveCandidatePathway(d.userId)).toMatchObject({ pathway: 'overseas_esp', isAu: false, recorded: false });
    // No write the server made carried a pathway or credentials name.
    expect(newNameRequests().filter((r) => r.method !== 'GET')).toEqual([]);
  };

  it('PUT /api/profile ignores pathway fields', async () => {
    const d = doctors.overseas_null;
    const cookie = h.gpCookie(d.email, d.userId);
    const res = await h.put('/api/profile', { profile: Object.assign({ firstName: 'Test', lastName: 'Ukgp' }, POISON) }, { cookie });
    expect(res.status).toBe(200);
    Object.keys(POISON).forEach((k) => expect(res.json.profile[k]).toBeUndefined());
    const flat = await h.put('/api/profile', Object.assign({ firstName: 'Test', lastName: 'Ukgp' }, POISON), { cookie });
    expect(flat.status).toBe(200);
    await assertUntouched(d);
  });

  it('PUT /api/state ignores pathway keys (they are not in the allow-list)', async () => {
    const d = doctors.overseas_null;
    const res = await h.put('/api/state', { state: Object.assign({ gp_career_intro_seen: true }, POISON), updatedAt: new Date().toISOString() }, { cookie: h.gpCookie(d.email, d.userId) });
    expect(res.status).toBe(200);
    const stored = h.emu.table('user_state').find((r) => r.user_id === d.userId).state;
    Object.keys(POISON).forEach((k) => expect(stored[k]).toBeUndefined());
    await assertUntouched(d);
  });

  it('POST /api/onboarding/complete ignores pathway fields', async () => {
    const d = doctors.overseas_null;
    const res = await h.post('/api/onboarding/complete', Object.assign({ country: 'GB', preferredCity: 'Melbourne', targetDate: '2027-03', whoMoving: 'Just me', childrenCount: '0' }, POISON), { cookie: h.gpCookie(d.email, d.userId) });
    expect(res.status).toBe(200);
    expect(profileRow(d).onboarding_completed_at).not.toBe(d.profile.onboarding_completed_at);
    await assertUntouched(d);
  });

  it('a doctor cannot reach the staff endpoint', async () => {
    const d = doctors.overseas_null;
    const cookie = h.gpCookie(d.email, d.userId);
    for (const host of [undefined, h.SUPER_HOST, h.ADMIN_HOST]) {
      const res = await h.post('/api/admin/candidate/pathway', { user_id: d.userId, pathway: 'au_vr' }, { cookie, host });
      expect([401, 403, 404]).toContain(res.status);
    }
    await assertUntouched(d);
  });
});

describe('how a page learns the switch and the doctor\'s own pathway', () => {
  it('GET /api/public/features needs no sign-in and reports the switch', async () => {
    const on = await h.get('/api/public/features');
    expect(on.status).toBe(200);
    // WP-24 added `tracking` with the switch on (which Australian conversion events exist: none until configured).
    expect(on.json).toEqual({ ok: true, auPathwayEnabled: true, tracking: { auPixelId: null, auGoogleSendTo: null } });
    h.setSwitch(false);
    const off = await h.get('/api/public/features');
    expect(off.json).toEqual({ ok: true, auPathwayEnabled: false });
    expect(h.emu.requests).toEqual([]);
  });

  it('switch on: /api/auth/session adds auPathwayEnabled and the caller\'s own { pathway, segment, isAu, launched }', async () => {
    const expected = {
      au_vr: { pathway: 'au_vr', segment: 'A', isAu: true, launched: true },
      au_restricted: { pathway: 'au_restricted', segment: 'B', isAu: true, launched: false },
      au_non_vr: { pathway: 'au_non_vr', segment: 'C', isAu: true, launched: false },
      au_registrar: { pathway: 'au_registrar', segment: 'C', isAu: true, launched: false },
      overseas_null: { pathway: 'overseas_esp', segment: 'overseas', isAu: false, launched: true },
      overseas_explicit: { pathway: 'overseas_esp', segment: 'overseas', isAu: false, launched: true }
    };
    for (const kind of AU_DOCTOR_KINDS) {
      const d = doctors[kind];
      const res = await h.get('/api/auth/session', { cookie: h.gpCookie(d.email, d.userId) });
      expect(res.status).toBe(200);
      expect(res.json.auPathwayEnabled).toBe(true);
      expect(res.json.auPathway).toEqual(expected[kind]);
      // Nothing staff recorded, and no DPA answer, ever reaches the browser.
      expect(res.raw).not.toMatch(/dpaRestricted|moratorium|needsStaffReview|pathway_set_by|ahpra/i);
    }
    // Changed deliberately by FB-1 (walk-findings D9): a doctor on an
    // Australian pathway also gets `auDoctor`, whose eligibility version
    // depends on the staff 19AB confirmation, so THEIR OWN credentials row is
    // read (one small read, filtered to them). It is still never read for a
    // doctor who is not on an Australian pathway, and none of it reaches the
    // browser (the check above).
    const credentialReads = h.emu.requestsTo('gp_credentials');
    ['overseas_null', 'overseas_explicit'].forEach((kind) => {
      expect(credentialReads.filter((r) => String(r.query).indexOf(doctors[kind].userId) !== -1)).toEqual([]);
      expect(doctors[kind].userId).toBeTruthy();
    });
    expect(credentialReads.every((r) => r.method === 'GET' && /user_id=eq\./.test(String(r.query)))).toBe(true);
  });

  it('switch off: /api/auth/session is byte-identical to before, with no query at all', async () => {
    h.setSwitch(false);
    for (const kind of AU_DOCTOR_KINDS) {
      const d = doctors[kind];
      const res = await h.get('/api/auth/session', { cookie: h.gpCookie(d.email, d.userId) });
      expect(res.raw).toBe(JSON.stringify({ ok: true, authenticated: true, profile: { email: d.email, supabaseUserId: d.userId } }));
    }
    expect(h.emu.requests).toEqual([]);
    expect((await h.get('/api/auth/session')).raw).toBe(JSON.stringify({ ok: false, authenticated: false }));
  });

  it('switch on, migration not applied: the session still answers, as overseas', async () => {
    h.emu.missingColumns = { user_profiles: WP02_NEW_COLUMN_NAMES.slice() };
    h.emu.missingTables = new Set(['gp_credentials']);
    const d = doctors.au_vr;
    const res = await h.get('/api/auth/session', { cookie: h.gpCookie(d.email, d.userId) });
    expect(res.status).toBe(200);
    expect(res.json.profile).toEqual({ email: d.email, supabaseUserId: d.userId });
    expect(res.json.auPathway).toEqual({ pathway: 'overseas_esp', segment: 'overseas', isAu: false, launched: true });
  });

  it('signed out is unchanged in both states', async () => {
    const on = await h.get('/api/auth/session');
    expect(on.status).toBe(401);
    expect(on.raw).toBe(JSON.stringify({ ok: false, authenticated: false }));
  });
});

describe('admin onboarding override accepts Australia (DAT-19)', () => {
  const URL = '/api/admin/seed-onboarding';
  const stateOf = (d) => h.emu.table('user_state').find((r) => r.user_id === d.userId).state;

  it('switch OFF: accepts exactly what it accepts today; "AU" is stored as the bare code and no pathway is written', async () => {
    h.setSwitch(false);
    const res = await h.post(URL, { email: seedTarget.email, country: 'AU', pathway: 'au_vr' }, h.superAdmin());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, message: 'Onboarding seeded for ' + seedTarget.email + ' with country AU' });
    expect(stateOf(seedTarget).gp_selected_country).toBe('AU');
    expect(stateOf(seedTarget).gp_onboarding).toMatchObject({ country: 'AU', targetDate: '2026-09', whoMoving: 'Just me', childrenCount: '0' });
    expect(profileRow(seedTarget)).toMatchObject({ qualification_country: 'AU', target_arrival_date: '2026-09', candidate_pathway: null });
    expect(caseRowOf(seedTarget).pathway).toBe(null);
    expect(newNameRequests()).toEqual([]);

    const gb = await h.post(URL, { email: seedTarget.email, country: 'GB' }, h.superAdmin());
    expect(gb.json).toEqual({ ok: true, message: 'Onboarding seeded for ' + seedTarget.email + ' with country United Kingdom' });
  });

  it('switch ON: an overseas country behaves exactly as with the switch off', async () => {
    const res = await h.post(URL, { email: seedTarget.email, country: 'IE' }, h.superAdmin());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, message: 'Onboarding seeded for ' + seedTarget.email + ' with country Ireland' });
    expect(stateOf(seedTarget).gp_onboarding).toMatchObject({ country: 'IE', targetDate: '2026-09', whoMoving: 'Just me' });
    expect(profileRow(seedTarget)).toMatchObject({ qualification_country: 'IE', candidate_pathway: null });
    expect(newNameRequests()).toEqual([]);
  });

  it('switch ON: Australia needs an Australian pathway, so a doctor is never left Australian-looking with none', async () => {
    for (const b of [{ country: 'AU' }, { country: 'Australia' }, { country: 'AU', pathway: 'overseas_esp' }, { country: 'AU', pathway: 'nonsense' }, { country: 'GB', pathway: 'nonsense' }]) {
      const res = await h.post(URL, Object.assign({ email: seedTarget.email }, b), h.superAdmin());
      expect(res.status, JSON.stringify(b)).toBe(400);
    }
    expect(profileRow(seedTarget)).toMatchObject({ qualification_country: 'IE', candidate_pathway: null });
  });

  it('switch ON: Australia + au_vr seeds an Australian doctor: pathway set and confirmed, no move answers', async () => {
    const auditsBefore = audits().length;
    const res = await h.post(URL, { email: seedTarget.email, country: 'AU', pathway: 'au_vr' }, h.superAdmin());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, message: 'Onboarding seeded for ' + seedTarget.email + ' with country Australia', pathway: 'au_vr' });
    expect(stateOf(seedTarget).gp_selected_country).toBe('Australia');
    expect(stateOf(seedTarget).gp_onboarding_complete).toBe(true);
    const ob = stateOf(seedTarget).gp_onboarding;
    expect(ob).toMatchObject({ country: 'AU', step: 5 });
    expect(ob.targetDate).toBeUndefined();
    expect(ob.whoMoving).toBeUndefined();
    expect(ob.childrenCount).toBeUndefined();
    expect(profileRow(seedTarget)).toMatchObject({ qualification_country: 'AU', candidate_pathway: 'au_vr', candidate_basis: 'australia', pathway_confirmed_by: h.SUPER_EMAIL });
    expect(caseRowOf(seedTarget).pathway).toBe('au_vr');
    expect(await t.resolveCandidatePathway(seedTarget.userId)).toMatchObject({ pathway: 'au_vr', segment: 'A', confirmed: true });
    expect(audits().length).toBe(auditsBefore + 1);
    expect(audits()[audits().length - 1]).toMatchObject({ action: 'admin_set_candidate_pathway', target_id: seedTarget.userId });
  });

  it('switch ON: an overseas-trained doctor already in Australia (GB + au_restricted) is accepted', async () => {
    const res = await h.post(URL, { email: seedTarget.email, country: 'GB', pathway: 'au_restricted' }, h.superAdmin());
    expect(res.status).toBe(200);
    expect(res.json.pathway).toBe('au_restricted');
    expect(profileRow(seedTarget)).toMatchObject({ qualification_country: 'GB', candidate_pathway: 'au_restricted' });
  });

  it('switch ON, migration not applied: refuses and seeds nothing', async () => {
    await t.setCandidatePathway(seedTarget.userId, { pathway: null, setBy: STAFF_EMAIL });
    const before = JSON.stringify(stateOf(seedTarget));
    h.emu.missingColumns = { user_profiles: WP02_NEW_COLUMN_NAMES.slice(), registration_cases: ['pathway'] };
    const res = await h.post(URL, { email: seedTarget.email, country: 'AU', pathway: 'au_vr' }, h.superAdmin());
    expect(res.status).toBe(503);
    expect(JSON.stringify(stateOf(seedTarget))).toBe(before);
  });
});

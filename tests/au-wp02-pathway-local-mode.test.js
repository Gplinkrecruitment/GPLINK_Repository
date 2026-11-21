// WP-02 in LOCAL JSON-file mode (no Supabase): the mode a worktree's
// `npm start` and many existing tests use. There the user key is the doctor's
// lowercased email, the pathway columns sit on dbState.userProfiles[email]
// (where the other snake_case profile fields are kept), and credentials live in
// dbState.gpCredentials[email]. There is no registration_cases store locally,
// so there is no case to mirror.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const { buildAllAuDoctors, buildAuLocalDb, AU_DOCTOR_KINDS, STAFF_EMAIL } = require('./helpers/au-fixtures.js');

let h, t, doctors;

beforeAll(async () => {
  doctors = buildAllAuDoctors();
  h = await bootAuTestServer({ name: 'wp02-local', mode: 'local', localDb: buildAuLocalDb(doctors) });
  t = h.testUtils;
});
afterAll(async () => { if (h) await h.close(); });
beforeEach(() => { h.setSwitch(true); });

describe('local JSON mode: resolveCandidatePathway', () => {
  AU_DOCTOR_KINDS.forEach((kind) => {
    it(kind + ' resolves from the JSON store, keyed by email (any case)', async () => {
      const d = doctors[kind];
      expect(await t.resolveCandidatePathway(d.email, { legacyDpaExempt: false })).toMatchObject(d.expected);
      expect((await t.resolveCandidatePathway(d.email.toUpperCase())).pathway).toBe(d.expected.pathway);
      expect((await t.resolveCandidatePathwayForSession({ userProfile: { email: d.email } })).pathway).toBe(d.expected.pathway);
    });
  });

  it('switch off: every doctor is overseas', async () => {
    h.setSwitch(false);
    for (const kind of AU_DOCTOR_KINDS) {
      expect(await t.resolveCandidatePathway(doctors[kind].email)).toMatchObject({ pathway: 'overseas_esp', isAu: false, flagEnabled: false });
    }
  });

  it('an unknown email reads as overseas', async () => {
    expect(await t.resolveCandidatePathway('nobody.test@gplink-test.local')).toMatchObject({ pathway: 'overseas_esp', recorded: false });
  });
});

describe('local JSON mode: writers', () => {
  it('setCandidatePathway stores on the profile and survives a re-read of the file', async () => {
    const d = doctors.overseas_null;
    const out = await t.setCandidatePathway(d.email, { pathway: 'au_vr', setBy: STAFF_EMAIL, confirmed: true });
    expect(out).toMatchObject({ ok: true, pathway: 'au_vr', basis: 'australia', confirmed: true, caseMirror: 'no_local_cases' });
    const stored = h.readLocalDb().userProfiles[d.email];
    expect(stored).toMatchObject({ candidate_pathway: 'au_vr', candidate_basis: 'australia', pathway_set_by: STAFF_EMAIL, pathway_confirmed_by: STAFF_EMAIL });
    // The profile fields that were already there are kept.
    expect(stored.firstName).toBe('Test');
    expect(await t.resolveCandidatePathway(d.email)).toMatchObject({ pathway: 'au_vr', confirmed: true });

    expect(await t.setCandidatePathway(d.email, { pathway: null, setBy: STAFF_EMAIL })).toMatchObject({ ok: true, pathway: null });
    expect(await t.resolveCandidatePathway(d.email)).toMatchObject({ pathway: 'overseas_esp', recorded: false });
  });

  it('refuses an unknown user, a bad value, and everything when the switch is off', async () => {
    expect(await t.setCandidatePathway('nobody.test@gplink-test.local', { pathway: 'au_vr', setBy: STAFF_EMAIL })).toEqual({ ok: false, reason: 'user_not_found' });
    expect(await t.setCandidatePathway(doctors.overseas_null.email, { pathway: 'australia', setBy: STAFF_EMAIL })).toEqual({ ok: false, reason: 'invalid_pathway' });
    h.setSwitch(false);
    expect(await t.setCandidatePathway(doctors.overseas_null.email, { pathway: 'au_vr', setBy: STAFF_EMAIL })).toEqual({ ok: false, reason: 'feature_off' });
    expect(await t.upsertGpCredentials(doctors.overseas_null.email, { vr_status: 'vr' }, { source: 'self' })).toMatchObject({ ok: false, reason: 'feature_off' });
    expect(h.readLocalDb().userProfiles[doctors.overseas_null.email].candidate_pathway).toBe(null);
  });

  it('upsertGpCredentials and setCandidatePreferences store and read back', async () => {
    const d = doctors.au_registrar;
    const staff = await t.upsertGpCredentials(d.email, { moratorium_19ab_confirmed_status: 'no' }, { source: 'staff', actor: STAFF_EMAIL });
    expect(staff.ok).toBe(true);
    expect(h.readLocalDb().gpCredentials[d.email]).toMatchObject({ ahpra_number: 'MED0001000004', moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: STAFF_EMAIL });
    expect(await t.resolveCandidatePathway(d.email)).toMatchObject({ pathway: 'au_registrar', dpaRestricted: false, dpaRestrictedReason: 'staff_confirmed_19ab_not_applicable' });
    // The doctor changing their answer clears the confirmation.
    await t.upsertGpCredentials(d.email, { moratorium_19ab_status: 'unsure' }, { source: 'self' });
    expect((await t.resolveCandidatePathway(d.email)).dpaRestricted).toBe(true);

    expect((await t.setCandidatePreferences(d.email, { timezone: 'Australia/Adelaide', sessions_wanted: 6 })).ok).toBe(true);
    expect(await t.readCandidatePreferences(d.email)).toMatchObject({ timezone: 'Australia/Adelaide', sessions_wanted: 6 });
  });
});

describe('local JSON mode: what the doctor\'s browser sees and cannot do', () => {
  it('session: additive keys with the switch on, byte-identical with it off', async () => {
    const d = doctors.au_restricted;
    const cookie = h.gpCookie(d.email);
    const on = await h.get('/api/auth/session', { cookie });
    expect(on.json).toEqual({
      ok: true, authenticated: true, profile: { email: d.email },
      auPathwayEnabled: true, auPathway: { pathway: 'au_restricted', segment: 'B', isAu: true, launched: false },
      // FB-1 (walk-findings D9, D10, D13) added a fourth key, for a doctor on
      // an Australian pathway only: an opaque eligibility version, their own
      // application limits and whether onboarding is finished.
      auDoctor: {
        eligibilityVersion: expect.stringMatching(/^[0-9a-f]{16}$/),
        limits: { active: 4, monthly: 6, interviewsMonthly: 6 },
        onboardingComplete: false
      },
      // WP-03 (APP-08) added a third key, for a doctor on an Australian pathway
      // only: their stage and the ladder to draw. Local JSON mode has no case
      // store, so the stage is the first rung and `stageKnown` is false.
      auJourney: {
        ladder: 'au', pathway: 'au_restricted', stage: 'placement', stageLabel: 'Secure placement',
        stageIndex: 0, stageKnown: false,
        stages: [
          { key: 'placement', label: 'Secure placement', index: 0, state: 'current' },
          { key: 'prestart', label: 'Pre-start checks', index: 1, state: 'upcoming' },
          { key: 'commenced', label: 'Started', index: 2, state: 'upcoming' },
          { key: 'guarantee', label: 'Settling in', index: 3, state: 'upcoming' },
          { key: 'complete', label: 'Complete', index: 4, state: 'upcoming' }
        ]
      }
    });
    h.setSwitch(false);
    const off = await h.get('/api/auth/session', { cookie });
    expect(off.raw).toBe(JSON.stringify({ ok: true, authenticated: true, profile: { email: d.email } }));
  });

  it('PUT /api/profile and PUT /api/state cannot set a pathway', async () => {
    const d = doctors.overseas_explicit;
    const cookie = h.gpCookie(d.email);
    const poison = { candidate_pathway: 'au_vr', candidate_basis: 'australia', pathway_confirmed_at: '2026-11-20T00:00:00.000Z', pathway_confirmed_by: 'me' };
    expect((await h.put('/api/profile', { profile: Object.assign({ firstName: 'Test', lastName: 'Iegp' }, poison) }, { cookie })).status).toBe(200);
    expect((await h.put('/api/state', { state: Object.assign({ gp_career_intro_seen: true }, poison), updatedAt: new Date().toISOString() }, { cookie })).status).toBe(200);
    const db = h.readLocalDb();
    expect(db.userProfiles[d.email]).toMatchObject({ candidate_pathway: 'overseas_esp', candidate_basis: 'overseas', pathway_confirmed_by: STAFF_EMAIL });
    expect(JSON.stringify(db.userState[d.email])).not.toContain('candidate_pathway');
    expect(await t.resolveCandidatePathway(d.email)).toMatchObject({ pathway: 'overseas_esp', isAu: false });
  });

  it('the staff endpoint works for the CEO locally; the RSO scope fails closed with no case store', async () => {
    const d = doctors.au_non_vr;
    const res = await h.post('/api/admin/candidate/pathway', { user_id: d.email, pathway: 'au_vr', moratorium_19ab_confirmed: 'no' }, h.superAdmin());
    expect(res.status).toBe(200);
    expect(res.json.pathway).toMatchObject({ pathway: 'au_vr', confirmed: true, dpaRestricted: false });
    expect((await h.post('/api/admin/candidate/pathway', { user_id: d.email, pathway: 'au_non_vr' }, h.rso())).status).toBe(403);
    expect((await h.get('/api/admin/candidate/pathway?user_id=' + encodeURIComponent(d.email), h.superAdmin())).json.record.candidate_pathway).toBe('au_vr');
  });
});

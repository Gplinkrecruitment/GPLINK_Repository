// Australian GP build, WP-05: the Australian onboarding branch in local
// JSON-file mode (no Supabase), where a doctor is keyed by email.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const { bootAuTestServer } = require('./helpers/au-server-harness.js');
const auOnboarding = require('../lib/au-onboarding.js');

const MARKER = auOnboarding.AU_BRANCH_MARKER_KEY;
const AU_EMAIL = 'au.local.test@gplink-test.local';
const UK_EMAIL = 'uk.local.test@gplink-test.local';
const WAIT_EMAIL = 'au.waitlisted.local.test@gplink-test.local';

let h, t;

function user(email, first) {
  return { email, firstName: first, lastName: 'Localdoctor', createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z' };
}

function auBody(over) {
  return {
    _version: 2, currentStep: 4, country: '', registerNumber: '', qualDocs: {}, leadSource: '',
    auBranch: 'yes',
    au: Object.assign({
      step: 5, ahpraNumber: 'MED0007654321', registrationType: 'specialist', fellowship: 'facrrm',
      hasConditions: false, moratorium19ab: 'unsure', workRights: 'pr',
      noticeWeeks: 0, availableFrom: '2026-11-20', locations: ['Regional WA', 'Perth'],
      state: 'WA', suburb: '', postcode: '', sessions: '', detailsConfirmed: true
    }, over || {})
  };
}

beforeAll(async () => {
  h = await bootAuTestServer({
    name: 'wp05-local', mode: 'local',
    localDb: {
      users: { [AU_EMAIL]: user(AU_EMAIL, 'Test'), [UK_EMAIL]: user(UK_EMAIL, 'Test'), [WAIT_EMAIL]: user(WAIT_EMAIL, 'Test') },
      userProfiles: {},
      userState: { [WAIT_EMAIL]: { gp_eligibility_waitlist: JSON.stringify({ country: 'Australia', email: WAIT_EMAIL, at: '2026-11-01T00:00:00.000Z' }) } }
    }
  });
  t = h.testUtils;
}, 60000);

afterAll(async () => { if (h) await h.close(); });
beforeEach(() => h.setSwitch(true));

describe('local JSON mode', () => {
  it('a part-way save stamps the marker, and the sweep index counts the doctor as Australian', async () => {
    const cookie = h.gpCookie(AU_EMAIL);
    const save = await h.post('/api/onboarding/save', auBody({ step: 1, detailsConfirmed: false }), { cookie });
    expect(save.json).toEqual({ ok: true });
    expect(typeof h.readLocalDb().userState[AU_EMAIL][MARKER]).toBe('string');
    const idx = await t.auSweepPathwayIndex('local-test');
    expect(idx.excludesUser(AU_EMAIL)).toBe(true);
    expect(idx.excludesUser(UK_EMAIL)).toBe(false);
    h.setSwitch(false);
    expect((await t.auSweepPathwayIndex('local-test')).excludesUser(AU_EMAIL)).toBe(false);
  });

  it('finishing writes the same things as in Supabase mode', async () => {
    const cookie = h.gpCookie(AU_EMAIL);
    const res = await h.post('/api/onboarding/complete', auBody(), { cookie });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, auPathway: { pathway: 'au_vr', isAu: true, launched: true }, auNext: 'careers' });
    const db = h.readLocalDb();
    expect(db.userProfiles[AU_EMAIL]).toMatchObject({
      qualification_country: 'AU', registration_country: 'Australia',
      register_body: 'ahpra', register_number: 'MED0007654321', register_status: 'pending_verification',
      preferred_city: 'Perth',
      candidate_pathway: 'au_vr', candidate_basis: 'australia', pathway_set_by: 'self', pathway_confirmed_at: null,
      current_state: 'WA', notice_period_weeks: 0, available_from: '2026-11-20', sessions_wanted: null
    });
    expect(db.userProfiles[AU_EMAIL].onboarding_completed_at).toBeTruthy();
    expect(db.gpCredentials[AU_EMAIL]).toMatchObject({
      ahpra_number: 'MED0007654321', ahpra_registration_type: 'specialist', fellowship_type: 'facrrm',
      vr_status: 'vr', moratorium_19ab_status: 'unsure', work_rights: 'pr', has_conditions: false
    });
    const st = db.userState[AU_EMAIL];
    expect(st.gp_onboarding_complete).toBe(true);
    expect(st.gp_selected_country).toBe('Australia');
    expect(MARKER in st).toBe(false);
    expect(st.gp_onboarding).toMatchObject({ auBranch: 'yes', country: 'AU', au: { locations: ['Regional WA', 'Perth'] } });
    const resolved = await t.resolveCandidatePathway(AU_EMAIL);
    expect(resolved).toMatchObject({ pathway: 'au_vr', isAu: true, confirmed: false, needsStaffReview: true, dpaRestricted: true });
  });

  it('bad answers are refused and nothing is written; switch off stores the blob and nothing else', async () => {
    const cookie = h.gpCookie(UK_EMAIL);
    const before = JSON.stringify(h.readLocalDb());
    const bad = await h.post('/api/onboarding/complete', auBody({ ahpraNumber: '123' }), { cookie });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.json.errors)).toEqual(['ahpraNumber']);
    expect(JSON.stringify(h.readLocalDb())).toBe(before);

    h.setSwitch(false);
    const off = await h.post('/api/onboarding/complete', auBody(), { cookie });
    expect(off.status).toBe(200);
    expect(Object.keys(off.json).sort()).toEqual(['message', 'ok', 'pepGated', 'registerVerification']);
    const db = h.readLocalDb();
    expect(db.userProfiles[UK_EMAIL].candidate_pathway).toBeUndefined();
    expect(db.userProfiles[UK_EMAIL].registration_country).toBeUndefined();
    expect((db.gpCredentials || {})[UK_EMAIL]).toBeUndefined();
    expect(MARKER in db.userState[UK_EMAIL]).toBe(false);
  });

  it('release from the waitlist clears the marker (no email in this mode)', async () => {
    const out = await t.releaseEligibilityWaitlistForAu({ email: WAIT_EMAIL }, { sendInvite: true });
    expect(out).toMatchObject({ ok: true, userId: WAIT_EMAIL, wasWaitlisted: true, released: true, invite: null });
    expect('gp_eligibility_waitlist' in h.readLocalDb().userState[WAIT_EMAIL]).toBe(false);
    expect(await t.releaseEligibilityWaitlistForAu({ email: WAIT_EMAIL })).toMatchObject({ ok: true, wasWaitlisted: false });
    expect(await t.releaseEligibilityWaitlistForAu({ email: 'nobody.test@gplink-test.local' })).toMatchObject({ ok: false, reason: 'user_not_found' });
    expect(await t.releaseEligibilityWaitlistForAu({ email: AU_EMAIL })).toMatchObject({ ok: false, reason: 'onboarding_complete' });
  });
});

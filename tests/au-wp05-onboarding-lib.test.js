// Australian GP build, WP-05: the rules of the Australian onboarding branch.
// Pure tests (no server): the pathway derivation (APP-07), the server-side
// answer checks, the client helper the wizard uses, and that the two agree.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const requireCjs = createRequire(import.meta.url);
const candidatePathway = requireCjs('../lib/candidate-pathway.js');
const gpCredentials = requireCjs('../lib/gp-credentials.js');
const registerVerification = requireCjs('../lib/register-verification.js');
const practicePipeline = requireCjs('../lib/practice-pipeline.js');
const auOnboarding = requireCjs('../lib/au-onboarding.js');
const client = requireCjs('../js/onboarding-au.js');

const derive = candidatePathway.derivePathwayFromOnboarding;

// A clean segment-A set of answers; each test changes one thing.
function vrAnswers(over) {
  return Object.assign({
    registrationType: 'specialist', fellowship: 'fracgp', hasConditions: false,
    moratorium19ab: 'no', workRights: 'citizen'
  }, over || {});
}

function validBody(over) {
  return {
    auBranch: 'yes',
    au: Object.assign({
      ahpraNumber: 'MED0001234567', registrationType: 'specialist', fellowship: 'fracgp', fellowshipDetail: '',
      hasConditions: false, conditionsDetail: '', moratorium19ab: 'no',
      workRights: 'citizen', permitSubclass: '', permitExpiry: '',
      currentPractice: 'Test Current Practice (FAKE)', noticeWeeks: 4, availableFrom: '2026-11-21',
      locations: ['Regional NSW', 'Sydney', 'Newcastle'], suburb: 'Parramatta', state: 'NSW', postcode: '2150',
      sessions: 8, detailsConfirmed: true, step: 4
    }, over || {})
  };
}
const NOW = '2026-11-20T02:00:00.000Z';

describe('derivePathwayFromOnboarding (APP-07): one rule, fail-safe', () => {
  it('specialist GP + FRACGP / FACRRM / both + no conditions + citizen or PR is au_vr', () => {
    ['fracgp', 'facrrm', 'both'].forEach((fellowship) => {
      ['citizen', 'pr'].forEach((workRights) => {
        ['specialist', 'general_and_specialist'].forEach((registrationType) => {
          const r = derive(vrAnswers({ fellowship, workRights, registrationType }));
          expect(r).toMatchObject({ pathway: 'au_vr', segment: 'A', launched: true });
        });
      });
    });
  });

  it('every restriction signal lands in au_restricted (B), whatever else is said', () => {
    const cases = [
      [{ registrationType: 'limited' }, 'supervised_registration'],
      [{ registrationType: 'provisional' }, 'supervised_registration'],
      [{ hasConditions: true }, 'registration_conditions'],
      [{ workRights: 'visa' }, 'temporary_work_rights'],
      [{ moratorium19ab: 'yes' }, 'moratorium_19ab_applies']
    ];
    cases.forEach(([change, reason]) => {
      const r = derive(vrAnswers(change));
      expect(r.pathway, JSON.stringify(change)).toBe('au_restricted');
      expect(r.segment).toBe('B');
      expect(r.launched).toBe(false);
      expect(r.reasons).toContain(reason);
    });
    // A registrar on a temporary right to work is restricted first.
    expect(derive(vrAnswers({ fellowship: 'registrar', workRights: 'visa' })).pathway).toBe('au_restricted');
  });

  it('a GP registrar is au_registrar (C)', () => {
    expect(derive(vrAnswers({ fellowship: 'registrar', registrationType: 'general' }))).toMatchObject({ pathway: 'au_registrar', segment: 'C', launched: false });
    expect(derive(vrAnswers({ inTraining: true }))).toMatchObject({ pathway: 'au_registrar' });
  });

  it('no GP fellowship, another fellowship, or general registration only is au_non_vr (C)', () => {
    expect(derive(vrAnswers({ fellowship: 'none' }))).toMatchObject({ pathway: 'au_non_vr', segment: 'C', launched: false });
    expect(derive(vrAnswers({ fellowship: 'other' })).pathway).toBe('au_non_vr');
    expect(derive(vrAnswers({ registrationType: 'general' })).pathway).toBe('au_non_vr');
    expect(derive(vrAnswers({ registrationType: 'general', fellowship: 'none' })).pathway).toBe('au_non_vr');
  });

  it('anything missing or unclear lands in the more restricted segment, never in A', () => {
    const unclear = [
      {}, null, undefined, 'au_vr', 42,
      vrAnswers({ registrationType: 'unsure' }),
      vrAnswers({ registrationType: 'non_practising' }),
      vrAnswers({ registrationType: '' }),
      vrAnswers({ registrationType: 'made_up' }),
      vrAnswers({ fellowship: '' }),
      vrAnswers({ fellowship: 'made_up' }),
      vrAnswers({ hasConditions: null }),
      vrAnswers({ hasConditions: 'no' }),
      vrAnswers({ workRights: '' }),
      vrAnswers({ workRights: 'temporary' }),
      vrAnswers({ moratorium19ab: '' }),
      vrAnswers({ moratorium19ab: 'maybe' })
    ];
    unclear.forEach((answers) => {
      const r = derive(answers);
      expect(r.pathway, JSON.stringify(answers)).toBe('au_restricted');
      expect(r.launched).toBe(false);
    });
  });

  it('only ever returns an Australian pathway, and never one the doctor typed in', () => {
    const r = derive(Object.assign(vrAnswers({ hasConditions: true }), { pathway: 'au_vr', candidate_pathway: 'au_vr' }));
    expect(r.pathway).toBe('au_restricted');
    expect(candidatePathway.isAuPathway(derive({}).pathway)).toBe(true);
  });

  it('19AB "not sure" keeps the segment; 19AB "no" unlocks nothing (the DPA rule still fails closed)', () => {
    const unsure = derive(vrAnswers({ moratorium19ab: 'unsure' }));
    expect(unsure.pathway).toBe('au_vr');
    expect(unsure.reasons).toContain('moratorium_19ab_unsure');
    // The doctor's own "no", not confirmed by staff: still limited to DPA roles.
    ['no', 'unsure'].forEach((answer) => {
      const dpa = candidatePathway.computeDpaRestricted({
        pathway: 'au_vr', credentials: { moratorium_19ab_status: answer }, legacyDpaExempt: true
      });
      expect(dpa.dpaRestricted, answer).toBe(true);
    });
  });
});

describe('validateAuOnboarding: the server checks every answer', () => {
  it('accepts a complete answer set and builds clean patches', () => {
    const v = auOnboarding.validateAuOnboarding(validBody({ ahpraNumber: ' med 000-1234567 ' }), { now: NOW });
    expect(v.ok).toBe(true);
    expect(v.register).toEqual({ body: 'ahpra', number: 'MED0001234567' });
    expect(v.derivation.pathway).toBe('au_vr');
    expect(v.credentialsPatch).toEqual({
      ahpra_number: 'MED0001234567', ahpra_registration_type: 'specialist', specialist_gp: true,
      has_conditions: false, conditions_text: null, fellowship_type: 'fracgp', fellowship_detail: null,
      vr_status: 'vr', moratorium_19ab_status: 'no', work_rights: 'citizen', visa_subclass: null, visa_expiry: null
    });
    expect(v.preferencesPatch).toEqual({
      current_suburb: 'Parramatta', current_state: 'NSW', current_postcode: '2150',
      notice_period_weeks: 4, available_from: '2026-11-21', sessions_wanted: 8
    });
    // The first CITY picked drives role ranking; regional picks do not.
    expect(v.preferredCity).toBe('Sydney');
    // Every key survives the WP-02 cleaners untouched (nothing rejected).
    expect(gpCredentials.sanitiseCredentialsPatch(v.credentialsPatch, { source: 'self', now: NOW }).rejected).toEqual([]);
    expect(gpCredentials.sanitisePreferencesPatch(v.preferencesPatch).rejected).toEqual([]);
  });

  it('never carries a pathway or a staff-only column in what it hands to the writers', () => {
    const body = validBody();
    Object.assign(body.au, { pathway: 'au_vr', candidate_pathway: 'au_vr', staff_verified_at: NOW, moratorium_19ab_confirmed_status: 'no' });
    body.candidate_pathway = 'au_vr';
    const v = auOnboarding.validateAuOnboarding(body, { now: NOW });
    const keys = Object.keys(v.credentialsPatch).concat(Object.keys(v.preferencesPatch));
    gpCredentials.PATHWAY_PROFILE_COLUMNS.concat(Object.keys(gpCredentials.STAFF_ONLY_CREDENTIAL_FIELDS)).forEach((k) => {
      expect(keys).not.toContain(k);
    });
    const blob = auOnboarding.storedAuOnboardingBlob(body, v, NOW);
    expect(Object.keys(blob.au)).not.toContain('pathway');
    expect(Object.keys(blob.au)).not.toContain('staff_verified_at');
  });

  it('available-from has NO minimum (APP-04): today, tomorrow and last month all pass', () => {
    ['2026-11-20', '2026-11-21', '2026-10-01', '2027-06-30'].forEach((d) => {
      expect(auOnboarding.validateAuOnboarding(validBody({ availableFrom: d }), { now: NOW }).ok, d).toBe(true);
    });
    expect(auOnboarding.validateAuOnboarding(validBody({ availableFrom: '2026-02-30' }), { now: NOW }).errors.availableFrom).toBeTruthy();
    expect(auOnboarding.validateAuOnboarding(validBody({ availableFrom: '2040-01-01' }), { now: NOW }).errors.availableFrom).toBeTruthy();
  });

  it('rejects each bad value by name and returns no patches at all', () => {
    const bad = {
      ahpraNumber: ['0001234567', 'MED123', 'GMC1234567', '', null, 'MED00012345678'],
      registrationType: ['', 'consultant', null],
      fellowship: ['', 'frcgp', 7],
      hasConditions: ['no', null, 0],
      moratorium19ab: ['', 'maybe', null],
      workRights: ['', 'visa', 'tourist'],
      noticeWeeks: ['', -1, 53, 2.5, 'soon'],
      availableFrom: ['', '21/11/2026', null],
      locations: [[], ['Atlantis'], 'Sydney', null, ['Sydney', 'London']],
      state: ['', 'New South Wales', 'XX'],
      postcode: ['215', '21500', 'abcd'],
      sessions: [0, 11, 2.5, 'lots'],
      detailsConfirmed: [false, 'true', undefined],
      permitExpiry: ['not-a-date']
    };
    Object.keys(bad).forEach((field) => {
      bad[field].forEach((value) => {
        const over = { [field]: value };
        if (field === 'permitExpiry') over.workRights = 'temporary';
        const v = auOnboarding.validateAuOnboarding(validBody(over), { now: NOW });
        expect(v.ok, field + '=' + JSON.stringify(value)).toBe(false);
        expect(Object.keys(v.errors), field + '=' + JSON.stringify(value)).toContain(field);
        expect(v.credentialsPatch).toBeNull();
        expect(v.preferencesPatch).toBeNull();
        expect(v.derivation).toBeNull();
      });
    });
    expect(auOnboarding.validateAuOnboarding({ auBranch: 'yes' }).ok).toBe(false);
    expect(auOnboarding.validateAuOnboarding({ auBranch: 'no', au: validBody().au }).ok).toBe(false);
    expect(auOnboarding.validateAuOnboarding(null).ok).toBe(false);
  });

  it('maps the answers that are not stored values', () => {
    const temp = auOnboarding.validateAuOnboarding(validBody({ workRights: 'temporary', permitSubclass: '482', permitExpiry: '2028-01-31' }), { now: NOW });
    expect(temp.credentialsPatch).toMatchObject({ work_rights: 'visa', visa_subclass: '482', visa_expiry: '2028-01-31' });
    expect(temp.derivation.pathway).toBe('au_restricted');
    const registrar = auOnboarding.validateAuOnboarding(validBody({ fellowship: 'registrar', registrationType: 'general' }), { now: NOW });
    expect(registrar.credentialsPatch).toMatchObject({ fellowship_type: 'none', vr_status: 'non_vr', specialist_gp: false });
    expect(registrar.derivation.pathway).toBe('au_registrar');
    const unsure = auOnboarding.validateAuOnboarding(validBody({ registrationType: 'unsure' }), { now: NOW });
    expect(unsure.credentialsPatch).toMatchObject({ ahpra_registration_type: null, specialist_gp: null, vr_status: 'unsure' });
    expect(unsure.derivation.pathway).toBe('au_restricted');
    const cond = auOnboarding.validateAuOnboarding(validBody({ hasConditions: true, conditionsDetail: '  Test\ncondition (FAKE) ' }), { now: NOW });
    expect(cond.credentialsPatch).toMatchObject({ has_conditions: true, conditions_text: 'Test condition (FAKE)' });
    const regionalOnly = auOnboarding.validateAuOnboarding(validBody({ locations: ['Regional QLD'], sessions: '' }), { now: NOW });
    expect(regionalOnly.preferredCity).toBe('');
    expect(regionalOnly.preferencesPatch.sessions_wanted).toBeNull();
  });

  it('uses exactly the value sets of gp-credentials and the register rule of register-verification', () => {
    const types = auOnboarding.REGISTRATION_TYPE_ANSWERS.map((o) => o.value).filter((v) => v !== 'unsure');
    expect(types.slice().sort()).toEqual(gpCredentials.AHPRA_REGISTRATION_TYPES.slice().sort());
    const fellowships = auOnboarding.FELLOWSHIP_ANSWERS.map((o) => o.value).filter((v) => v !== 'registrar');
    expect(fellowships.slice().sort()).toEqual(gpCredentials.FELLOWSHIP_TYPES.slice().sort());
    expect(auOnboarding.WORK_RIGHTS_ANSWERS.map((o) => o.stored).sort()).toEqual(gpCredentials.WORK_RIGHTS.slice().sort());
    expect(auOnboarding.MORATORIUM_ANSWERS.map((o) => o.value)).toEqual(['yes', 'no', 'unsure']);
    expect(String(registerVerification.REGISTER_BODIES.ahpra.numberPattern)).toBe('/^MED\\d{10}$/i');
    // Locations reuse the cities the role listings are anchored to, plus regional.
    expect(auOnboarding.AU_CITY_LOCATIONS).toEqual(practicePipeline.MAJOR_CITIES.map((c) => c.name));
    expect(auOnboarding.AU_LOCATIONS).toContain('Regional NSW');
    expect(auOnboarding.AU_LOCATIONS.length).toBeGreaterThan(7);
  });
});

describe('js/onboarding-au.js (the wizard helper) mirrors the server', () => {
  const values = (list) => list.map((o) => o.value);

  it('the lists are the same on both sides', () => {
    expect(client.REGISTRATION_TYPES).toEqual(auOnboarding.REGISTRATION_TYPE_ANSWERS.map((o) => ({ value: o.value, label: o.label })));
    expect(client.FELLOWSHIPS).toEqual(auOnboarding.FELLOWSHIP_ANSWERS.map((o) => ({ value: o.value, label: o.label })));
    expect(client.MORATORIUM).toEqual(auOnboarding.MORATORIUM_ANSWERS.map((o) => ({ value: o.value, label: o.label })));
    expect(client.WORK_RIGHTS).toEqual(auOnboarding.WORK_RIGHTS_ANSWERS.map((o) => ({ value: o.value, label: o.label })));
    expect(client.ALL_LOCATIONS).toEqual(auOnboarding.AU_LOCATIONS.slice());
    expect(values(client.STATES).sort()).toEqual(gpCredentials.AU_STATES.slice().sort());
    expect(client.NOTICE_WEEKS_MAX).toBe(auOnboarding.NOTICE_WEEKS_MAX);
    expect(client.SESSIONS_MIN).toBe(auOnboarding.SESSIONS_MIN);
    expect(client.SESSIONS_MAX).toBe(auOnboarding.SESSIONS_MAX);
    expect(client.MAX_LOCATIONS).toBe(auOnboarding.MAX_LOCATIONS);
    values(client.NOTICE_OPTIONS).forEach((w) => expect(w).toBeLessThanOrEqual(auOnboarding.NOTICE_WEEKS_MAX));
  });

  it('APP-02: the Ahpra number keeps its letters and is checked by the server rule', () => {
    expect(client.normaliseAhpraNumber(' med 0001-234567 ')).toBe('MED0001234567');
    expect(client.validateAhpraNumber('med0001234567')).toEqual({ ok: true, number: 'MED0001234567' });
    ['0001234567', 'MED123', 'MED00012345678', 'ABC0001234567', ''].forEach((bad) => {
      expect(client.validateAhpraNumber(bad).ok, bad).toBe(false);
      expect(registerVerification.validateRegisterDetails('ahpra', bad).ok, bad).toBe(false);
    });
    expect(registerVerification.validateRegisterDetails('ahpra', 'med 0001234567')).toMatchObject({ ok: true, number: 'MED0001234567' });
    expect(String(client.AHPRA_NUMBER_PATTERN)).toBe('/^MED\\d{10}$/');
  });

  it('an answer set the wizard passes is one the server passes, and the reverse for each bad field', () => {
    const body = validBody();
    client.STEPS.forEach((step) => expect(client.validateStep(step, body.au, 2026).ok, step).toBe(true));
    expect(client.firstIncompleteStep(body.au, 2026)).toBe(-1);
    expect(auOnboarding.validateAuOnboarding(body, { now: NOW }).ok).toBe(true);
    const perField = {
      locations: [], availableFrom: '', noticeWeeks: '', state: '', postcode: '12',
      ahpraNumber: '1234567', registrationType: '', fellowship: '', detailsConfirmed: false,
      hasConditions: null, moratorium19ab: '', workRights: ''
    };
    Object.keys(perField).forEach((field) => {
      const au = Object.assign({}, body.au, { [field]: perField[field] });
      expect(client.firstIncompleteStep(au, 2026), field).not.toBe(-1);
      expect(auOnboarding.validateAuOnboarding({ auBranch: 'yes', au }, { now: NOW }).ok, field).toBe(false);
    });
  });

  it('APP-04: no minimum start date in the wizard either', () => {
    const today = Object.assign({}, validBody().au, { availableFrom: '2026-11-20' });
    expect(client.validateStep('when', today, 2026).ok).toBe(true);
    expect(client.validateStep('when', Object.assign({}, today, { availableFrom: '2026-12-18' }), 2026).ok).toBe(true);
  });

  it('a fresh answer set is empty and fails the first screen; the review rows are plain text', () => {
    const blank = client.defaultAnswers();
    expect(client.firstIncompleteStep(blank, 2026)).toBe(0);
    const rows = client.reviewRows(validBody().au);
    expect(rows.find((r) => r.label === 'Ahpra registration number').value).toBe('MED0001234567');
    expect(rows.find((r) => r.label === 'Where you would like to work').value).toBe('Regional NSW, Sydney, Newcastle');
    expect(rows.find((r) => r.label === 'Could start from').value).toBe('21 November 2026');
    rows.forEach((r) => { expect(typeof r.value).toBe('string'); expect(r.value).not.toMatch(/[<>]/); });
  });
});

describe('the "started the Australian branch" marker follows the saved blob', () => {
  const KEY = auOnboarding.AU_BRANCH_MARKER_KEY;

  it('is set when the blob says yes, kept on later saves, removed on no and on completion', () => {
    const state = { gp_onboarding: {}, other: 1 };
    auOnboarding.reconcileAuBranchMarker(state, { auBranch: 'yes', au: {} }, '2026-11-20T00:00:00.000Z');
    expect(state[KEY]).toBe('2026-11-20T00:00:00.000Z');
    auOnboarding.reconcileAuBranchMarker(state, JSON.stringify({ auBranch: 'yes', au: { step: 2 } }), '2026-11-21T00:00:00.000Z');
    expect(state[KEY]).toBe('2026-11-20T00:00:00.000Z');
    auOnboarding.reconcileAuBranchMarker(state, { auBranch: 'yes', completedAt: '2026-11-22T00:00:00.000Z' });
    expect(KEY in state).toBe(false);
    state[KEY] = 'x';
    auOnboarding.reconcileAuBranchMarker(state, { country: 'GB' });
    expect(KEY in state).toBe(false);
    expect(state.other).toBe(1);
  });

  it('an overseas doctor\'s state is left exactly as it was', () => {
    const state = { gp_onboarding: { country: 'GB' }, gp_selected_country: 'United Kingdom' };
    const before = JSON.stringify(state);
    auOnboarding.reconcileAuBranchMarker(state, { country: 'GB', currentStep: 2 });
    auOnboarding.reconcileAuBranchMarker(state, null);
    auOnboarding.reconcileAuBranchMarker(state, 'not json');
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('sweep index: a doctor part-way through the branch counts as Australian', () => {
  const auSweeps = requireCjs('../lib/au-sweeps.js');
  it('excludesUser is true for an id passed in from the marker read, like any Australian doctor', () => {
    const idx = auSweeps.buildAuSweepIndex({ enabled: true, userIds: ['started-1', 'pathway-1'], job: 't' });
    expect(idx.excludesUser('started-1')).toBe(true);
    expect(idx.excludesUser('someone-else')).toBe(false);
    expect(auSweeps.inertAuSweepIndex('t').excludesUser('started-1')).toBe(false);
  });
});

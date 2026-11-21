// WP-15 (Australian GP build): the lead's segment, as pure rules.
//
//   deriveLeadSegment     explicit answers only; the phone is not an input
//   isAuSegmentLead       the recorded segment, else (old rows) country === 'au'
//   readLeadFormAnswers   every value from a browser is checked against a fixed set
//   Meta lead forms       form id → segment by configuration; answers read as slugs
//   Hazel / message hold  apply to new-style segment rows; NZ and UK unaffected
//
// Stored-row fixtures are the shapes buildConsultLeadRow writes (see
// tests/fixtures/au-wp15-overseas-parity.snapshot.json, taken from the real
// server). Every identity is fake.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const auLead = require('../lib/au-lead.js');
const consultLead = require('../lib/consult-lead.js');
const leadCalls = require('../lib/lead-calls.js');
const auTimezone = require('../lib/au-timezone.js');

// A stored site_enquiries row in the shape the server writes for the /start form.
function storedRow(consult, over) {
  return Object.assign({
    id: '11111111-1111-4111-8111-111111111111',
    created_at: '2026-11-20T00:00:00.000Z',
    kind: 'gp',
    name: 'Dr Test Lead',
    email: 'lead.wp15@gplink-test.local',
    phone: '+61400000215',
    practice_name: null,
    state: consult.country || null,
    message: null,
    status: 'new',
    metadata: {
      source: 'site_start_form', ip: '10.0.0.1', user_agent: 'test', utm: {}, fb_lead_id: null,
      consult: Object.assign({ qualified: true, is_gp: null, country: 'uk', call_booked: false, nudges: [], token: 'tok-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, consult)
    }
  }, over || {});
}

describe('deriveLeadSegment: explicit answers only', () => {
  const yes = (over) => Object.assign({ ahpraRegistered: true }, over);
  it.each([
    // said Yes to Ahpra
    [yes({ vrStatus: 'yes', restriction19ab: 'no', visaStatus: 'citizen_pr' }), 'au_vr'],
    [yes({ vrStatus: 'yes', restriction19ab: 'yes', visaStatus: 'citizen_pr' }), 'au_restricted'],
    [yes({ vrStatus: 'yes', restriction19ab: 'no', visaStatus: 'temporary' }), 'au_restricted'],
    [yes({ vrStatus: 'no', restriction19ab: 'yes', visaStatus: 'citizen_pr' }), 'au_restricted'],
    [yes({ vrStatus: 'registrar', restriction19ab: 'no', visaStatus: 'temporary' }), 'au_restricted'],
    [yes({ vrStatus: 'registrar', restriction19ab: 'no', visaStatus: 'citizen_pr' }), 'au_registrar'],
    [yes({ vrStatus: 'registrar', restriction19ab: 'unsure', visaStatus: 'unsure' }), 'au_registrar'],
    [yes({ vrStatus: 'no', restriction19ab: 'no', visaStatus: 'citizen_pr' }), 'au_non_vr'],
    [yes({ vrStatus: 'no', restriction19ab: 'unsure', visaStatus: 'unsure' }), 'au_non_vr'],
    // a "not sure" never claims the unrestricted segment, and never the restricted one
    [yes({ vrStatus: 'yes', restriction19ab: 'unsure', visaStatus: 'citizen_pr' }), 'au_unknown'],
    [yes({ vrStatus: 'yes', restriction19ab: 'no', visaStatus: 'unsure' }), 'au_unknown'],
    [yes({ vrStatus: 'unsure', restriction19ab: 'no', visaStatus: 'citizen_pr' }), 'au_unknown'],
    [yes({ vrStatus: 'yes' }), 'au_unknown'],
    [yes({}), 'au_unknown'],
    // values we never offered are not answers
    [yes({ vrStatus: 'definitely', restriction19ab: 'nope', visaStatus: 'x' }), 'au_unknown'],
    // said No to Ahpra
    [{ ahpraRegistered: false, country: 'uk' }, 'overseas'],
    [{ ahpraRegistered: false, country: 'ie' }, 'overseas'],
    [{ ahpraRegistered: false, country: 'nz' }, 'overseas'],
    [{ ahpraRegistered: false, country: 'other' }, 'overseas'],
    [{ ahpraRegistered: false, country: '' }, 'overseas'],
    // trained in Australia but not registered: still Australian-segment, as before WP-15
    [{ ahpraRegistered: false, country: 'au' }, 'au_unknown'],
    // "No" beats an Australian Meta form
    [{ ahpraRegistered: false, country: 'uk', auForm: true }, 'overseas'],
    // not asked
    [{ auForm: true }, 'au_unknown'],
    [{ ahpraRegistered: null, auForm: true, country: 'uk' }, 'au_unknown'],
    [{}, null],
    [{ country: 'au' }, null],
    [{ country: 'uk', vrStatus: 'yes', restriction19ab: 'no', visaStatus: 'citizen_pr' }, null],
    [null, null]
  ])('%j → %s', (answers, expected) => {
    expect(auLead.deriveLeadSegment(answers)).toBe(expected);
  });

  it('training country never changes an Ahpra-registered doctor\'s segment', () => {
    for (const country of ['uk', 'ie', 'nz', 'au', 'other', '', undefined]) {
      expect(auLead.deriveLeadSegment({ ahpraRegistered: true, vrStatus: 'yes', restriction19ab: 'no', visaStatus: 'citizen_pr', country })).toBe('au_vr');
    }
  });

  it('COM-15: the phone is not an input. No phone number, in any key, moves the answer', () => {
    const base = { ahpraRegistered: false, country: 'uk' };
    for (const phone of ['+61400000111', '+447700900111', '+919800000111', '']) {
      expect(auLead.deriveLeadSegment(Object.assign({ phone, phone_number: phone, tel: phone }, base))).toBe('overseas');
      expect(auLead.deriveLeadSegment({ ahpraRegistered: true, vrStatus: 'yes', restriction19ab: 'no', visaStatus: 'citizen_pr', phone })).toBe('au_vr');
      expect(auLead.deriveLeadSegment({ phone })).toBeNull();
    }
    // and the function's source never mentions a phone
    expect(String(auLead.deriveLeadSegment)).not.toMatch(/phone|dial/i);
    // (its one mention of the word is the comment about the consent wording)
    expect(String(auLead.leadFieldsFromAnswers)).not.toMatch(/\.phone|\[['"]phone|dial/i);
  });

  it('every result is a known segment', () => {
    for (const ahpraRegistered of [true, false, null]) {
      for (const vrStatus of [null].concat(auLead.LEAD_VR_STATUSES)) {
        for (const restriction19ab of [null].concat(auLead.LEAD_19AB_ANSWERS)) {
          for (const visaStatus of [null].concat(auLead.LEAD_VISA_STATUSES)) {
            const seg = auLead.deriveLeadSegment({ ahpraRegistered, vrStatus, restriction19ab, visaStatus, country: 'uk' });
            if (ahpraRegistered === null) expect(seg).toBeNull();
            else expect(auLead.LEAD_SEGMENTS).toContain(seg);
            if (ahpraRegistered === true) expect(seg.indexOf('au_')).toBe(0);
          }
        }
      }
    }
  });
});

describe('isAuSegmentLead: the recorded segment, else the old country test', () => {
  it.each([
    [{ segment: 'au_vr', country: 'uk' }, true],
    [{ segment: 'au_restricted', country: 'other' }, true],
    [{ segment: 'au_non_vr', country: 'ie' }, true],
    [{ segment: 'au_registrar', country: 'nz' }, true],
    [{ segment: 'au_unknown', country: 'other' }, true],
    [{ segment: 'AU_VR', country: 'uk' }, true],
    [{ segment: 'overseas', country: 'uk' }, false],
    // a recorded "overseas" wins over the training country
    [{ segment: 'overseas', country: 'au' }, false],
    // rows from before WP-15, and Meta leads from a form that does not ask
    [{ country: 'au' }, true],
    [{ country: 'AU ' }, true],
    [{ country: 'uk' }, false],
    [{ country: 'nz' }, false],
    [{ country: 'other' }, false],
    [{}, false],
    // junk in the field is "nothing recorded"
    [{ segment: 'banana', country: 'au' }, true],
    [{ segment: 'banana', country: 'uk' }, false],
    [{ segment: '', country: 'au' }, true],
    [{ segment: null, country: 'uk' }, false]
  ])('%j → %s', (consult, expected) => {
    expect(auLead.isAuSegmentLead(consult)).toBe(expected);
    expect(auLead.isAuSegmentLead(storedRow(consult))).toBe(expected);
  });

  it('leadSegmentFor (WP-24): always one of the six, with the same fallback', () => {
    expect(auLead.leadSegmentFor(storedRow({ segment: 'au_vr', country: 'uk' }))).toBe('au_vr');
    expect(auLead.leadSegmentFor(storedRow({ segment: 'overseas', country: 'uk' }))).toBe('overseas');
    expect(auLead.leadSegmentFor(storedRow({ country: 'au' }))).toBe('au_unknown');
    expect(auLead.leadSegmentFor(storedRow({ country: 'uk' }))).toBe('overseas');
    expect(auLead.leadSegmentFor(storedRow({ country: 'other', qualified: false, screened_out: true }))).toBe('overseas');
    expect(auLead.leadSegmentFor(storedRow({ segment: 'au_something_new', country: 'uk' }))).toBe('au_unknown');
    expect(auLead.leadSegmentFor(null)).toBe('overseas');
    expect(auLead.leadSegmentFor({ kind: 'gp', metadata: {} })).toBe('overseas');
    for (const seg of auLead.LEAD_SEGMENTS) {
      expect(auLead.leadSegmentLabel(seg)).toBeTruthy();
      expect(auLead.leadSegmentLabel(seg, true)).toBeTruthy();
    }
  });
});

describe('readLeadFormAnswers: nothing a browser sends is stored raw', () => {
  it('no answer to the first question (an old cached page): nothing is asked, nothing is recorded', () => {
    expect(auLead.readLeadFormAnswers({ name: 'x', country: 'uk' })).toEqual({ ok: true, asked: false, answers: null });
    expect(auLead.readLeadFormAnswers({ state: 'WA', vrStatus: 'yes' })).toEqual({ ok: true, asked: false, answers: null });
    expect(auLead.readLeadFormAnswers(null)).toEqual({ ok: true, asked: false, answers: null });
  });

  it('"Yes" with every follow-up', () => {
    const r = auLead.readLeadFormAnswers({ ahpraRegistered: true, state: 'Western Australia', vrStatus: 'YES', restriction19ab: 'unsure', rightToWork: 'citizen_pr', consentVersion: 'au_a1_draft_2026_11' });
    expect(r).toEqual({ ok: true, asked: true, answers: { ahpraRegistered: true, state: 'WA', stateOutside: false, vrStatus: 'yes', restriction19ab: 'unsure', visaStatus: 'citizen_pr', consentVersion: 'au_a1_draft_2026_11' } });
  });

  it('"Yes", outside Australia at the moment', () => {
    const r = auLead.readLeadFormAnswers({ ahpraRegistered: true, state: 'outside' });
    expect(r.answers).toMatchObject({ state: '', stateOutside: true });
  });

  it('"No": the Australian keys are not read at all', () => {
    const r = auLead.readLeadFormAnswers({ ahpraRegistered: false, state: 'WA', vrStatus: 'yes', restriction19ab: 'no', rightToWork: 'temporary', consentVersion: 'overseas_v0' });
    expect(r.answers).toEqual({ ahpraRegistered: false, state: '', stateOutside: false, vrStatus: null, restriction19ab: null, visaStatus: null, consentVersion: 'overseas_v0' });
  });

  it.each([
    [{ ahpraRegistered: 'yes' }, 'ahpraRegistered must be true or false.'],
    [{ ahpraRegistered: 1 }, 'ahpraRegistered must be true or false.'],
    [{ ahpraRegistered: true, state: 'Texas' }, 'state is not an Australian state or territory.'],
    [{ ahpraRegistered: true, state: '<script>' }, 'state is not an Australian state or territory.'],
    [{ ahpraRegistered: true, vrStatus: 'maybe' }, 'vrStatus must be one of: yes, no, registrar, unsure.'],
    [{ ahpraRegistered: true, restriction19ab: 'n/a' }, 'restriction19ab must be one of: yes, no, unsure.'],
    [{ ahpraRegistered: true, rightToWork: 'tourist' }, 'rightToWork must be one of: citizen_pr, temporary, unsure.'],
    [{ ahpraRegistered: true, rightToWork: { a: 1 } }, 'rightToWork must be one of: citizen_pr, temporary, unsure.'],
    [{ ahpraRegistered: false, consentVersion: 'made_up_v9' }, 'consentVersion is not recognised.']
  ])('%j is refused', (body, error) => {
    expect(auLead.readLeadFormAnswers(body)).toEqual({ ok: false, error });
  });
});

describe('leadFieldsFromAnswers / applyLeadFields: what lands on consult', () => {
  const NOW = '2026-11-21T03:00:00.000Z';
  it('an Ahpra-registered doctor in WA', () => {
    const { answers } = auLead.readLeadFormAnswers({ ahpraRegistered: true, state: 'wa', vrStatus: 'yes', restriction19ab: 'no', rightToWork: 'citizen_pr', consentVersion: 'au_a1_draft_2026_11' });
    const consult = { qualified: true, country: 'uk' };
    auLead.applyLeadFields(consult, auLead.leadFieldsFromAnswers(answers, { country: 'uk', nowIso: NOW }));
    expect(consult).toEqual({
      qualified: true, country: 'uk',
      segment: 'au_vr', ahpra_registered: true, location_country: 'au', state: 'WA',
      vr_status: 'yes', restriction_19ab: 'no', visa_status: 'citizen_pr',
      consent: { wording_version: 'au_a1_draft_2026_11', shown_at: NOW, ai_call: 'not_asked' }
    });
  });

  it('outside Australia: no state, location is not Australia', () => {
    const { answers } = auLead.readLeadFormAnswers({ ahpraRegistered: true, state: 'outside', vrStatus: 'unsure', restriction19ab: 'unsure', rightToWork: 'unsure' });
    const consult = { country: 'other', state: 'NSW' };
    auLead.applyLeadFields(consult, auLead.leadFieldsFromAnswers(answers, { country: '' }));
    expect(consult).toEqual({ country: 'other', segment: 'au_unknown', ahpra_registered: true, location_country: 'other', vr_status: 'unsure', restriction_19ab: 'unsure', visa_status: 'unsure' });
  });

  it('"No" records the answer and the segment, and removes Australian answers left by an earlier "Yes"', () => {
    const consult = { country: 'uk', segment: 'au_vr', ahpra_registered: true, location_country: 'au', vr_status: 'yes', restriction_19ab: 'no', visa_status: 'citizen_pr' };
    const { answers } = auLead.readLeadFormAnswers({ ahpraRegistered: false, consentVersion: 'overseas_v0' });
    auLead.applyLeadFields(consult, auLead.leadFieldsFromAnswers(answers, { country: 'uk', nowIso: NOW }));
    expect(consult).toEqual({ country: 'uk', segment: 'overseas', ahpra_registered: false, consent: { wording_version: 'overseas_v0', shown_at: NOW, ai_call: 'not_asked' } });
  });

  it('nothing asked: nothing to record', () => {
    expect(auLead.leadFieldsFromAnswers({ ahpraRegistered: null }, { country: 'au' })).toBeNull();
    const consult = { country: 'au' };
    expect(auLead.applyLeadFields(consult, null)).toEqual({ country: 'au' });
  });
});

describe('Meta lead forms: form id → segment by configuration', () => {
  it('today (no Australian form configured): the allowed list IS FB_GP_LEAD_FORM_IDS', () => {
    const cfg = auLead.metaFormSegmentConfig({ FB_GP_LEAD_FORM_IDS: ' 111, 222 ,,333 ' });
    expect(cfg).toEqual({ gp: ['111', '222', '333'], au: [], conflicts: [], allowed: ['111', '222', '333'] });
    expect(cfg.allowed).toEqual(consultLead.parseGpFormIds(' 111, 222 ,,333 '));
    expect(auLead.metaFormSegmentConfig({})).toEqual({ gp: [], au: [], conflicts: [], allowed: [] });
  });

  it('an Australian form is a doctor\'s form without being listed twice', () => {
    expect(auLead.metaFormSegmentConfig({ FB_GP_LEAD_FORM_IDS: '111', FB_AU_GP_LEAD_FORM_IDS: '900, 901' }))
      .toEqual({ gp: ['111'], au: ['900', '901'], conflicts: [], allowed: ['111', '900', '901'] });
    expect(auLead.metaFormSegmentConfig({ FB_AU_GP_LEAD_FORM_IDS: '900' })).toEqual({ gp: [], au: ['900'], conflicts: [], allowed: ['900'] });
  });

  it('a form id in BOTH lists is a configuration error: it is an overseas form, and reported', () => {
    const cfg = auLead.metaFormSegmentConfig({ FB_GP_LEAD_FORM_IDS: '111,900', FB_AU_GP_LEAD_FORM_IDS: '900,901' });
    expect(cfg.conflicts).toEqual(['900']);
    expect(cfg.au).toEqual(['901']);
    expect(cfg.allowed).toEqual(['111', '900', '901']);
  });

  // The question keys and answer values below follow Meta's proven convention
  // (the stored production row for the live form holds
  // `_where_did_you_complete_your_gp_training?` → `united_kingdom`): the label
  // the advertiser typed, lower-cased, spaces to underscores. The wording is
  // the proposed form in docs/au-gp/meta-au-lead-form.md. No Australian form
  // exists in Meta yet, so there is no real stored row to copy: when the first
  // one arrives, replace these with its keys.
  const AU_FORM_ANSWERS = {
    full_name: 'Test Doctor',
    email: 'au.meta.wp15@gplink-test.local',
    phone_number: '+61400000216',
    'are_you_currently_registered_with_ahpra?': 'yes',
    'which_state_or_territory_are_you_in?': 'western_australia',
    'are_you_a_vocationally_registered_gp_(fracgp_or_facrrm)?': "i'm_a_gp_registrar",
    'does_the_19ab_moratorium_apply_to_you?': 'not_sure',
    'what_is_your_right_to_work_in_australia?': 'australian_citizen_or_permanent_resident'
  };

  it('reads the Australian answers from slugs', () => {
    expect(auLead.readMetaAuAnswers(AU_FORM_ANSWERS)).toEqual({
      ahpraRegistered: true, state: 'WA', stateOutside: false, vrStatus: 'registrar', restriction19ab: 'unsure', visaStatus: 'citizen_pr', locationCountry: null
    });
  });

  it.each([
    ['yes', true], ['yes_i_am', true], ['Yes', true], ['no', false], ['no_not_yet', false],
    ['not_sure', null], ['', null], ['maybe_next_year', null]
  ])('Ahpra answer %j → %s', (slug, expected) => {
    expect(auLead.readMetaAuAnswers({ 'are_you_currently_registered_with_ahpra?': slug }).ahpraRegistered).toBe(expected);
  });

  it.each([
    ['new_south_wales', 'NSW'], ['victoria', 'VIC'], ['queensland', 'QLD'], ['western_australia', 'WA'],
    ['south_australia', 'SA'], ['tasmania', 'TAS'], ['australian_capital_territory', 'ACT'], ['northern_territory', 'NT'],
    ['nsw', 'NSW'], ['WA', 'WA'], ['texas', ''], ['', '']
  ])('state answer %j → %j', (slug, expected) => {
    expect(auLead.readMetaAuAnswers({ 'which_state_or_territory_are_you_in?': slug }).state).toBe(expected);
  });

  it('"where are you based" gives the location, and a state when it names one', () => {
    expect(auLead.readMetaAuAnswers({ 'where_are_you_based?': 'queensland' })).toMatchObject({ state: 'QLD', locationCountry: 'au' });
    expect(auLead.readMetaAuAnswers({ 'where_are_you_based?': 'in_australia' })).toMatchObject({ state: '', locationCountry: 'au' });
    expect(auLead.readMetaAuAnswers({ 'where_are_you_based?': 'united_kingdom' })).toMatchObject({ locationCountry: 'uk' });
    expect(auLead.readMetaAuAnswers({ 'where_are_you_based?': 'new_zealand' })).toMatchObject({ locationCountry: 'nz' });
    expect(auLead.readMetaAuAnswers({ 'where_are_you_based?': 'outside_australia' })).toMatchObject({ locationCountry: 'other' });
    expect(auLead.readMetaAuAnswers({ 'where_are_you_based?': 'glasgow_royal_infirmary' })).toMatchObject({ locationCountry: null });
  });

  it('contact fields are never read as answers, and the live overseas form reads as "nothing Australian"', () => {
    // a surname, an email and a practice name that contain the hint words
    expect(auLead.readMetaAuAnswers({ full_name: 'Yes Ahpra', email: 'ahpra.yes@gplink-test.local', phone_number: '+61400000217' }))
      .toEqual({ ahpraRegistered: null, state: '', stateOutside: false, vrStatus: null, restriction19ab: null, visaStatus: null, locationCountry: null });
    // the live form's real keys (tests/live-form-journey.test.js)
    const live = {
      full_name: 'Test Doctor', email: 'x@gplink-test.local', phone_number: '+447700900123',
      'are_you_a_currently_registered_gp?': 'yes',
      '_where_did_you_complete_your_gp_training?': 'united_kingdom',
      "anything_you'd_like_us_to_cover_on_the_call?": 'pay and schools in victoria'
    };
    expect(auLead.readMetaAuAnswers(live)).toEqual({ ahpraRegistered: null, state: '', stateOutside: false, vrStatus: null, restriction19ab: null, visaStatus: null, locationCountry: null });
  });

  function metaBody(formId, fields) {
    return { entry: [{ changes: [{ value: {
      leadgen_id: 'L-wp15-1', form_id: formId,
      field_data: Object.keys(fields).map((name) => ({ name, values: [fields[name]] }))
    } }] }] };
  }

  it('normalizeFacebookGpLead: without the option, the result is exactly what it was', () => {
    const body = metaBody('900', AU_FORM_ANSWERS);
    const plain = consultLead.normalizeFacebookGpLead(body, ['900']);
    expect(Object.keys(plain)).toEqual(['leadId', 'formId', 'adId', 'name', 'email', 'phone', 'isGp', 'country', 'countryRaw', 'countrySource', 'countryRecognised', 'fieldNames', 'question']);
    const withAu = consultLead.normalizeFacebookGpLead(body, ['900'], { auFormIds: ['900'] });
    expect(Object.assign({}, withAu, { auForm: undefined, auAnswers: undefined })).toEqual(Object.assign({}, plain, { auForm: undefined, auAnswers: undefined }));
    expect(withAu.auForm).toBe(true);
    expect(withAu.auAnswers).toMatchObject({ ahpraRegistered: true, state: 'WA' });
    // the same answers on a form that is NOT configured as Australian are still read
    const other = consultLead.normalizeFacebookGpLead(metaBody('111', AU_FORM_ANSWERS), ['111'], { auFormIds: ['900'] });
    expect(other.auForm).toBe(false);
    expect(other.auAnswers.ahpraRegistered).toBe(true);
    // a form id outside the allowed list is still not a doctor's lead
    expect(consultLead.normalizeFacebookGpLead(body, ['111'], { auFormIds: ['900'] })).toBeNull();
  });
});

describe('Hazel never rings an Australian-segment lead (owner decision 7), new-style rows included', () => {
  const cfg = leadCalls.parseLeadCallConfig({
    LEAD_CALLS_ENABLED: 'true', RETELL_API_KEY: 'k', RETELL_AGENT_ID: 'a',
    RETELL_FROM_NUMBER_UK: '+442030000000', RETELL_FROM_NUMBER_AU: '+61280000000', LEAD_CALLS_MAX_LEAD_AGE_DAYS: '30'
  });
  const WHEN = Date.parse('2026-11-18T11:00:00Z'); // a Wednesday
  const created = new Date(WHEN - 3 * 3600 * 1000).toISOString();

  for (const sw of [true, false]) {
    it('switch ' + (sw ? 'ON' : 'OFF') + ': every Australian segment is refused with au_segment, whatever the training country or the phone', () => {
      const prev = process.env.AU_PATHWAY_ENABLED;
      process.env.AU_PATHWAY_ENABLED = sw ? 'true' : 'false';
      try {
        for (const segment of ['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar', 'au_unknown']) {
          for (const [country, phone] of [['uk', '+447700900215'], ['other', '+919800000215'], ['au', '+61400000215'], ['nz', '+64210000215']]) {
            const row = storedRow({ segment, ahpra_registered: true, country, state: 'WA' }, { phone, created_at: created });
            expect(auLead.auHazelBlocked(row), segment + ' ' + country).toBe(true);
            expect(leadCalls.leadCallDecision({ row, nowMs: WHEN, cfg }), segment + ' ' + country).toEqual({ action: 'skip', reason: 'au_segment' });
            // a due call-back does not get through either
            const cb = storedRow({ segment, country, call_back_at: new Date(WHEN - 60000).toISOString() }, { phone, created_at: created });
            expect(leadCalls.leadCallDecision({ row: cb, nowMs: WHEN, cfg })).toEqual({ action: 'skip', reason: 'au_segment' });
          }
        }
      } finally {
        if (prev === undefined) delete process.env.AU_PATHWAY_ENABLED; else process.env.AU_PATHWAY_ENABLED = prev;
      }
    });

    it('switch ' + (sw ? 'ON' : 'OFF') + ': a New Zealand lead and a UK lead who answered "No" are not blocked by this rule', () => {
      const prev = process.env.AU_PATHWAY_ENABLED;
      process.env.AU_PATHWAY_ENABLED = sw ? 'true' : 'false';
      try {
        const nzOld = storedRow({ country: 'nz' }, { phone: '+64210000215', created_at: created });
        const nzNew = storedRow({ country: 'nz', segment: 'overseas', ahpra_registered: false }, { phone: '+64210000215', created_at: created });
        const ukNew = storedRow({ country: 'uk', segment: 'overseas', ahpra_registered: false }, { phone: '+447700900215', created_at: created });
        // a UK-trained doctor on an Australian number who said "No": overseas, exactly as before
        const ukOnAu = storedRow({ country: 'uk', segment: 'overseas', ahpra_registered: false }, { phone: '+61400000215', created_at: created });
        const ukOnAuOld = storedRow({ country: 'uk' }, { phone: '+61400000215', created_at: created });
        for (const row of [nzOld, nzNew, ukNew, ukOnAu, ukOnAuOld]) {
          expect(auLead.auHazelBlocked(row)).toBe(false);
          expect(leadCalls.leadCallDecision({ row, nowMs: WHEN, cfg }).reason).not.toBe('au_segment');
        }
        // the new keys change nothing about the decision itself
        expect(leadCalls.leadCallDecision({ row: nzNew, nowMs: WHEN, cfg })).toEqual(leadCalls.leadCallDecision({ row: nzOld, nowMs: WHEN, cfg }));
        expect(leadCalls.leadCallDecision({ row: ukOnAu, nowMs: WHEN, cfg })).toEqual(leadCalls.leadCallDecision({ row: ukOnAuOld, nowMs: WHEN, cfg }));
      } finally {
        if (prev === undefined) delete process.env.AU_PATHWAY_ENABLED; else process.env.AU_PATHWAY_ENABLED = prev;
      }
    });
  }
});

describe('the WP-01 message hold applies to new-style Australian-segment rows', () => {
  const created = Date.parse('2026-11-20T00:00:00Z');
  const later = created + 2 * 3600 * 1000;
  const auNew = { qualified: true, country: 'uk', segment: 'au_vr', ahpra_registered: true, state: 'WA', token: 't', call_booked: false, nudges: [] };
  const ukNew = { qualified: true, country: 'uk', segment: 'overseas', ahpra_registered: false, token: 't', call_booked: false, nudges: [] };
  const ukOld = { qualified: true, country: 'uk', token: 't', call_booked: false, nudges: [] };

  it('switch on: held for an Ahpra-registered UK-trained doctor; a "No" lead is nudged exactly like an old row', () => {
    expect(auLead.auMessagesHeld(auNew, { auPathwayEnabled: true })).toBe(true);
    expect(consultLead.nextConsultNudge({ consult: auNew, nowMs: later, createdAtMs: created, auPathwayEnabled: true })).toBeNull();
    const a = consultLead.nextConsultNudge({ consult: ukNew, nowMs: later, createdAtMs: created, auPathwayEnabled: true });
    const b = consultLead.nextConsultNudge({ consult: ukOld, nowMs: later, createdAtMs: created, auPathwayEnabled: true });
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
  });

  it('switch off: nothing is held (the interim hold sits behind the switch)', () => {
    expect(auLead.auMessagesHeld(auNew, { auPathwayEnabled: false })).toBe(false);
    expect(consultLead.nextConsultNudge({ consult: auNew, nowMs: later, createdAtMs: created, auPathwayEnabled: false }))
      .toEqual(consultLead.nextConsultNudge({ consult: ukOld, nowMs: later, createdAtMs: created, auPathwayEnabled: false }));
  });

  it('time zone: an Ahpra-registered UK-trained doctor in WA is on Perth time; the same doctor answering "No" stays on the old clock', () => {
    expect(auTimezone.auLeadZone(storedRow(auNew), { auPathwayEnabled: true })).toMatchObject({ zone: 'Australia/Perth', source: 'state' });
    expect(auTimezone.auLeadZone(storedRow(ukNew), { auPathwayEnabled: true })).toBeNull();
    expect(auTimezone.auLeadZone(storedRow(auNew), { auPathwayEnabled: false })).toBeNull();
    expect(leadCalls.leadCallZone(storedRow(auNew), 'uk', { auPathwayEnabled: true })).toBe('Australia/Perth');
    expect(leadCalls.leadCallZone(storedRow(ukNew), 'uk', { auPathwayEnabled: true })).toBe('Europe/London');
  });
});

describe('the owner\'s WhatsApp page (free-text "answers" slot): segment, state, VR', () => {
  const row = storedRow({ segment: 'au_vr', ahpra_registered: true, country: 'uk', state: 'WA', vr_status: 'yes' });
  it('switch on: an Australian-segment lead carries them', () => {
    const s = consultLead.consultOwnerAlertSummary(row, { nowMs: Date.parse('2026-11-20T02:00:00Z'), auPathwayEnabled: true });
    expect(s.answers).toBe('Country: UK · Segment: Australian GP: vocationally registered · State: WA · VR: Yes (FRACGP / FACRRM) · Email: lead.wp15@gplink-test.local');
  });
  it('switch off, and every overseas lead: the summary is what it was', () => {
    const off = consultLead.consultOwnerAlertSummary(row, { nowMs: Date.parse('2026-11-20T02:00:00Z'), auPathwayEnabled: false });
    expect(off.answers).toBe('Country: UK · Email: lead.wp15@gplink-test.local');
    const uk = storedRow({ segment: 'overseas', ahpra_registered: false, country: 'uk' });
    const ukOld = storedRow({ country: 'uk' });
    const opts = { nowMs: Date.parse('2026-11-20T02:00:00Z'), auPathwayEnabled: true };
    expect(consultLead.consultOwnerAlertSummary(uk, opts)).toEqual(consultLead.consultOwnerAlertSummary(ukOld, opts));
  });
});

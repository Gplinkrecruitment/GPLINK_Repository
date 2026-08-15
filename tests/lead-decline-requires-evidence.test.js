// A doctor is turned away ONLY when we can point at the evidence for it.
// Failing to understand someone is never evidence about them.
//
// This file exists because the SAME doctor profile was lost twice in two weeks, and
// each fix addressed the instance rather than the class:
//
//   2026-08-13, Rabeeaa   - the country QUESTION KEY did not match our hints, so the
//                           lookup returned '' and she was screened out. b12cc37 taught
//                           the code to FIND the answer (resolveFbLeadCountry).
//   2026-08-14, Louise    - the answer WAS found, but Meta delivered it as the slug
//                           `united_kingdom`, which the matcher did not recognise. She
//                           was screened out again, shown "we can't take this one on",
//                           and never offered the calendar. aca00a0 taught the code to
//                           READ that spelling.
//
// Both were the same bug: the code treated "we do not recognise this" as "they are not
// eligible". Recognition can always be improved and will always be incomplete, so the
// class only closes by changing WHAT JUSTIFIES A DECLINE. That is what these tests pin.
//
// THE RULE FOR FIXTURES: anything asserting how an external payload is shaped must come
// from a REAL stored row, never from our own spec. Both incidents hid behind tests that
// asserted our own guess at Meta's naming.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
process.env.NODE_ENV = 'test';

const consultLead = require('../lib/consult-lead.js');
const { parseYesNo, parseCountryAnswer, isRecognisedCountryAnswer, countryFromPhone,
        resolveFbLeadCountry, normalizeFacebookGpLead } = consultLead;

let buildConsultLeadRow;
beforeAll(() => {
  buildConsultLeadRow = require('../server.js').__testUtils.buildConsultLeadRow;
});

// Verbatim from the stored prod row for lead 1044950714846926 (Louise Beet).
const REAL_META_FIELDS = {
  '_where_did_you_complete_your_gp_training?': 'united_kingdom',
  'full_name': 'Louise Beet',
  'are_you_a_currently_registered_gp?': 'yes',
  "anything_you'd_like_us_to_cover_on_the_call?": 'possible areas where work is needed, hours, rates of pay, help with family relocation, schools etc',
  'phone_number': '+447913895013',
  'email': 'louisecbeet@gmail.com'
};

function decide(over) {
  return buildConsultLeadRow(Object.assign({
    name: 'Test GP', email: 't@example.com', phone: '', isGp: true,
    country: 'other', countryRaw: '', countrySource: 'question',
    countryRecognised: false, source: 'meta_lead_ad'
  }, over)).metadata.consult;
}

describe('parseYesNo survives Meta slugs (the trap that was still armed)', () => {
  // `_` is a WORD character, so \b never fires after "yes" - parseYesNo('yes_i_am')
  // returned null, isGp was not true, and that ALSO disabled the country_unknown
  // safety net, producing a confident terminal screen-out of a real GP.
  it('reads a slugged yes', () => {
    expect(parseYesNo('yes_i_am')).toBe(true);
    expect(parseYesNo('yes_i_am_currently_registered')).toBe(true);
    expect(parseYesNo('YES_I_AM')).toBe(true);
  });
  it('reads a slugged no', () => {
    expect(parseYesNo('no_not_yet')).toBe(false);
    expect(parseYesNo('no-not-registered')).toBe(false);
  });
  it('still returns null for a genuinely unreadable answer', () => {
    expect(parseYesNo('')).toBe(null);
    expect(parseYesNo('maybe')).toBe(null);
    expect(parseYesNo('i am a nurse')).toBe(null);
  });
});

describe('isRecognisedCountryAnswer separates "declined" from "unreadable"', () => {
  it('recognises a country we serve', () => {
    expect(isRecognisedCountryAnswer('united_kingdom')).toBe(true);
    expect(isRecognisedCountryAnswer('New Zealand')).toBe(true);
  });
  it('recognises Australia, which we DO serve since 2026-08-15', () => {
    expect(isRecognisedCountryAnswer('australia')).toBe(true);
    expect(parseCountryAnswer('australia')).toBe('au');
  });
  it('recognises a country we do NOT serve', () => {
    expect(isRecognisedCountryAnswer('south_africa')).toBe(true);
    expect(isRecognisedCountryAnswer('India')).toBe(true);
  });
  it('recognises the form\'s own opt-out options', () => {
    expect(isRecognisedCountryAnswer('other')).toBe(true);
    expect(isRecognisedCountryAnswer('none_of_the_above')).toBe(true);
  });
  it('does NOT claim to recognise something it cannot read', () => {
    expect(isRecognisedCountryAnswer('')).toBe(false);
    expect(isRecognisedCountryAnswer('Glasgow Royal Infirmary')).toBe(false);
    expect(isRecognisedCountryAnswer('NHS Grampian')).toBe(false);
    expect(isRecognisedCountryAnswer('Manchester')).toBe(false);
  });
});

describe('countryFromPhone corroborates only', () => {
  it('reads the served dialling codes', () => {
    expect(countryFromPhone('+61406281243')).toBe('au');
    expect(countryFromPhone('+447913895013')).toBe('uk');
    expect(countryFromPhone('+353 87 123 4567')).toBe('ie');
    expect(countryFromPhone('+64 21 123 456')).toBe('nz');
  });
  it('is empty for anything else', () => {
    expect(countryFromPhone('+61406281243')).toBe('au');
    expect(countryFromPhone('07913895013')).toBe('');
    expect(countryFromPhone('')).toBe('');
  });
});

describe('THE RULE: a decline requires positive evidence', () => {
  it('qualifies a doctor who names a country we serve', () => {
    const c = decide({ country: 'uk', countryRecognised: true });
    expect(c.qualified).toBe(true);
    expect(c.screened_out).toBeUndefined();
    expect(c.token).toBeTruthy();
  });

  it('DECLINES someone who names a country we do not serve', () => {
    const c = decide({ country: 'other', countryRaw: 'South Africa', countryRecognised: true });
    expect(c.qualified).toBe(false);
    expect(c.screened_out).toBe(true);
  });

  it('DECLINES someone who says they are not a registered GP', () => {
    const c = decide({ isGp: false, country: 'uk', countryRecognised: true });
    expect(c.qualified).toBe(false);
    expect(c.screened_out).toBe(true);
  });

  it('NEVER declines an answer it could not read - that is country_unknown', () => {
    const c = decide({ countryRaw: 'Glasgow Royal Infirmary', countryRecognised: false, phone: '' });
    expect(c.screened_out).toBeUndefined();
    expect(c.country_unknown).toBe(true);
  });

  it('NEVER declines when the GP question itself was unreadable', () => {
    // isGp null = "we could not tell", which is not "they said no".
    const c = decide({ isGp: null, countryRaw: 'somewhere odd', countryRecognised: false, phone: '' });
    expect(c.screened_out).toBeUndefined();
    expect(c.country_unknown).toBe(true);
  });

  it('rescues an unreadable answer when the phone says a country we serve', () => {
    const c = decide({ countryRaw: 'NHS Grampian', countryRecognised: false, phone: '+447913895013' });
    expect(c.qualified).toBe(true);
    expect(c.country).toBe('uk');
    expect(c.country_inferred_from_phone).toBe(true);
    expect(c.token).toBeTruthy();
  });

  it('does NOT let the phone override an answer we DID understand', () => {
    // A UK mobile does not turn "South Africa" into an eligible lead.
    const c = decide({ countryRaw: 'South Africa', countryRecognised: true, phone: '+447913895013' });
    expect(c.qualified).toBe(false);
    expect(c.screened_out).toBe(true);
    expect(c.country_inferred_from_phone).toBeUndefined();
  });

  it('does NOT rescue someone who explicitly said they are not a GP', () => {
    const c = decide({ isGp: false, countryRecognised: false, phone: '+447913895013' });
    expect(c.qualified).toBe(false);
    expect(c.screened_out).toBe(true);
  });

  it('does NOT decline a doctor who named a country we serve but whose GP answer was unreadable', () => {
    // The subtle one. She answered "United Kingdom" correctly; only the OTHER
    // question was unreadable. Deciding the decline from "is this lead qualified?"
    // rather than "what country did she name?" would turn her away on the strength
    // of an answer that was right - which is exactly the original bug, relocated.
    const c = decide({ isGp: null, country: 'uk', countryRaw: 'united_kingdom', countryRecognised: true, phone: '' });
    expect(c.screened_out).toBeUndefined();
    expect(c.country_unknown).toBe(true);
  });

  it('and qualifies her outright when her phone agrees', () => {
    const c = decide({ isGp: null, country: 'uk', countryRaw: 'united_kingdom', countryRecognised: true, phone: '+447913895013' });
    expect(c.qualified).toBe(true);
    expect(c.screened_out).toBeUndefined();
  });
});

describe('the regression that would have caught BOTH incidents', () => {
  it('the real Meta payload qualifies end to end', () => {
    const lead = normalizeFacebookGpLead({
      entry: [{ changes: [{ value: {
        form_id: '2029012337751132',
        leadgen_id: '1044950714846926',
        field_data: Object.entries(REAL_META_FIELDS).map(([name, v]) => ({ name, values: [v] }))
      } }] }]
    }, ['2029012337751132']);

    expect(lead).toBeTruthy();
    expect(lead.country).toBe('uk');
    expect(lead.isGp).toBe(true);
    expect(lead.countryRecognised).toBe(true);

    const c = buildConsultLeadRow({
      name: lead.name, email: lead.email, phone: lead.phone, isGp: lead.isGp,
      country: lead.country, countryRaw: lead.countryRaw,
      countrySource: lead.countrySource, countryRecognised: lead.countryRecognised,
      source: 'meta_lead_ad'
    }).metadata.consult;

    expect(c.qualified).toBe(true);
    expect(c.screened_out).toBeUndefined();
    expect(c.token).toBeTruthy();
  });

  it('and would STILL qualify her if we had never learned to read the slug', () => {
    // The durable property: even with recognition failing completely, a UK GP is
    // not turned away. This is what makes the class closed rather than the instance.
    const c = decide({
      country: 'other', countryRaw: 'some_spelling_we_have_never_seen',
      countryRecognised: false, phone: '+447913895013', isGp: true
    });
    expect(c.screened_out).toBeUndefined();
    expect(c.qualified).toBe(true);
  });
});

// The property that matters, stated as a table rather than as anecdotes about the two
// doctors we already lost. If a future edit re-opens the class, one of these fails.
describe('SWEEP: no eligible doctor is turned away, however she phrases it', () => {
  const FORM = '2029012337751132';

  function score(country, gp, phone) {
    const field_data = [
      { name: 'full_name', values: ['Test Doctor'] },
      { name: 'email', values: ['t@example.com'] },
      { name: 'phone_number', values: [phone] },
      { name: '_where_did_you_complete_your_gp_training?', values: [country] }
    ];
    if (gp !== null) field_data.push({ name: 'are_you_a_currently_registered_gp?', values: [gp] });
    const lead = normalizeFacebookGpLead(
      { entry: [{ changes: [{ value: { form_id: FORM, leadgen_id: 'x', field_data } }] }] }, [FORM]
    );
    return buildConsultLeadRow({
      name: lead.name, email: lead.email, phone: lead.phone, isGp: lead.isGp,
      country: lead.country, countryRaw: lead.countryRaw, countrySource: lead.countrySource,
      countryRecognised: lead.countryRecognised, source: 'meta_lead_ad'
    }).metadata.consult;
  }

  const ELIGIBLE = [
    ['the real Louise payload',    'united_kingdom',           'yes', '+447913895013'],
    ['display text',               'United Kingdom',           'Yes', '+447913895013'],
    ['slugged yes',                'united_kingdom',           'yes_i_am_currently_registered', '+447913895013'],
    ['kebab case',                 'united-kingdom',           'yes', '+447913895013'],
    ['uppercase slug',             'UNITED_KINGDOM',           'YES_I_AM', '+447913895013'],
    ['short code in a slug',       'uk_trained',               'yes', '+447913895013'],
    ['a nation, not the state',    'scotland',                 'yes', '+447700900123'],
    ['northern ireland',           'northern_ireland',         'yes', '+447700900123'],
    ['ireland',                    'republic_of_ireland',      'yes', '+353871234567'],
    ['new zealand',                'new_zealand',              'yes', '+6421123456'],
    ['aotearoa',                   'aotearoa',                 'yes', '+6421123456'],
    ['gp answer unreadable',       'united_kingdom',           'i am a gp', '+447700900123'],
    ['gp question missing',        'united_kingdom',           null,  '+447700900123'],
    ['a hospital, not a country',  'NHS Grampian',             'yes', '+447700900123'],
    ['a city, not a country',      'Manchester',               'yes', '+447700900123'],
    ['blank country',              '',                         'yes', '+447700900123'],
    ['australia (served since 2026-08-15)', 'australia',      'yes', '+61406281243']
  ];

  it.each(ELIGIBLE)('never turns away: %s', (_label, country, gp, phone) => {
    const c = score(country, gp, phone);
    expect(c.screened_out).toBeUndefined();
    // She must remain reachable: either offered the call, or queued for a human.
    expect(c.qualified === true || c.country_unknown === true).toBe(true);
  });

  const INELIGIBLE = [
    ['india',           'india',          'yes', '+919812345678'],
    ['south africa',    'south_africa',   'yes', '+27821234567'],
    ['picked "Other"',  'other',          'yes', '+447700900123'],
    ['says not a GP',   'united_kingdom', 'no',  '+447700900123'],
    ['slugged no',      'united_kingdom', 'no_not_yet', '+447700900123']
  ];

  it.each(INELIGIBLE)('still declines: %s', (_label, country, gp, phone) => {
    const c = score(country, gp, phone);
    expect(c.qualified).toBe(false);
    expect(c.screened_out).toBe(true);
  });
});

describe('where they TRAINED is the governing fact (owner-confirmed)', () => {
  // The expedited pathway needs the training certificate itself: a UK GP needs MRCGP
  // AND the CCT, and the CCT is only issued on completing UK GP training. So an answer
  // of "Australia" or "Somewhere else" on the training question is a genuine decline,
  // and a UK phone number must not soften it into a review queue.
  it('declines someone who trained outside all four, even on a UK number', () => {
    const c = decide({
      country: 'other', countryRaw: 'south_africa', countryRecognised: true,
      phone: '+447700900123', isGp: true
    });
    expect(c.screened_out).toBe(true);
    expect(c.qualified).toBe(false);
  });

  it('declines the form\'s own "Somewhere else" option', () => {
    const c = decide({
      country: 'other', countryRaw: 'somewhere_else', countryRecognised: true,
      phone: '+447700900123', isGp: true
    });
    expect(c.screened_out).toBe(true);
  });
});

describe('opt-out answers are matched exactly, never as substrings', () => {
  it('treats a bare "Other" as a real opt-out', () => {
    expect(isRecognisedCountryAnswer('other')).toBe(true);
    expect(isRecognisedCountryAnswer('none_of_the_above')).toBe(true);
  });
  it('does not read "other" inside ordinary words as an opt-out', () => {
    // "another region" / "mother and baby unit" must stay UNREADABLE, not become a
    // decline - a substring match here would manufacture the exact false rejection
    // this whole file exists to prevent.
    expect(isRecognisedCountryAnswer('another region')).toBe(false);
    expect(isRecognisedCountryAnswer('mother and baby unit')).toBe(false);
  });
});

describe('multi-value answers are not silently truncated', () => {
  it('keeps every value, so a country in the second one is still found', () => {
    const lead = normalizeFacebookGpLead({
      entry: [{ changes: [{ value: {
        form_id: 'f1', leadgen_id: 'l1',
        field_data: [
          { name: 'email', values: ['a@b.co'] },
          { name: 'full_name', values: ['Jane Doe'] },
          { name: 'are_you_a_currently_registered_gp?', values: ['yes'] },
          { name: 'where_have_you_worked?', values: ['locum_posts', 'united_kingdom'] }
        ]
      } }] }]
    }, ['f1']);
    expect(lead.country).toBe('uk');
  });
});

describe('the flat relay branch gets the same protection', () => {
  it('finds a country stated outside the body.country field', () => {
    const lead = normalizeFacebookGpLead({
      form_id: 'f2', lead_id: 'l2', full_name: 'Jane Doe', email: 'a@b.co',
      is_gp: 'yes', where_trained: 'united_kingdom'
    }, ['f2']);
    expect(lead.country).toBe('uk');
  });
  it('does not read a country out of the contact fields', () => {
    const lead = normalizeFacebookGpLead({
      form_id: 'f2', lead_id: 'l2', full_name: 'Jane Wales', email: 'jane@nhs.uk', is_gp: 'yes'
    }, ['f2']);
    expect(lead.country).toBe('other');
    expect(lead.countryRecognised).toBe(false);
  });
});

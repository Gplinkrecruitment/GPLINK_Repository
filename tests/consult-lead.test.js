import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  SUPPORTED_CONSULT_COUNTRIES,
  CONSULT_NUDGE_SCHEDULE_MS,
  screenConsultLead,
  generateConsultToken,
  parseGpFormIds,
  parseYesNo,
  parseCountryAnswer,
  resolveFbLeadCountry,
  looksLikeGpLeadForm,
  normalizeFacebookGpLead,
  validateConsultLeadPayload,
  nextConsultNudge,
  isConsultExhausted,
  consultNudgeCopy,
  consultDisplayName,
} = require('../lib/consult-lead.js');

const MIN = 60 * 1000;
const H = 60 * MIN;
const D = 24 * H;

describe('screenConsultLead', () => {
  it('passes a registered GP from uk/ie/nz only', () => {
    expect(screenConsultLead({ isGp: true, country: 'uk' })).toBe(true);
    expect(screenConsultLead({ isGp: true, country: 'ie' })).toBe(true);
    expect(screenConsultLead({ isGp: true, country: 'nz' })).toBe(true);
    expect(screenConsultLead({ isGp: true, country: 'other' })).toBe(false);
    expect(screenConsultLead({ isGp: false, country: 'uk' })).toBe(false);
    expect(screenConsultLead({ isGp: null, country: 'uk' })).toBe(false);
  });
});

describe('parseYesNo / parseCountryAnswer', () => {
  it('parses yes/no answers tolerantly', () => {
    expect(parseYesNo('Yes')).toBe(true);
    expect(parseYesNo('yes — fully registered')).toBe(true);
    expect(parseYesNo('No')).toBe(false);
    expect(parseYesNo('')).toBe(null);
    expect(parseYesNo(undefined)).toBe(null);
  });
  it('maps country answers to codes (northern ireland is uk)', () => {
    expect(parseCountryAnswer('United Kingdom')).toBe('uk');
    expect(parseCountryAnswer('UK (GMC)')).toBe('uk');
    expect(parseCountryAnswer('Northern Ireland')).toBe('uk');
    expect(parseCountryAnswer('Ireland')).toBe('ie');
    expect(parseCountryAnswer('New Zealand')).toBe('nz');
    expect(parseCountryAnswer('NZ')).toBe('nz');
    expect(parseCountryAnswer('South Africa')).toBe('other');
    expect(parseCountryAnswer('')).toBe('other');
  });
});

describe('parseGpFormIds', () => {
  it('splits and trims a comma list, dropping empties', () => {
    expect(parseGpFormIds(' 123, 456 ,,789 ')).toEqual(['123', '456', '789']);
    expect(parseGpFormIds('')).toEqual([]);
    expect(parseGpFormIds(undefined)).toEqual([]);
  });
});

describe('generateConsultToken', () => {
  it('returns a url-safe token of decent length, unique per call', () => {
    const a = generateConsultToken();
    const b = generateConsultToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    expect(a).not.toBe(b);
  });
});

function nativeFbBody(overrides = {}) {
  return {
    entry: [{
      changes: [{
        value: Object.assign({
          leadgen_id: 'L-1001',
          form_id: 'F-77',
          field_data: [
            { name: 'full_name', values: ['Aisha Khan'] },
            { name: 'email', values: ['aisha@example.co.uk'] },
            { name: 'phone_number', values: ['+447700900123'] },
            { name: 'are_you_a_currently_registered_gp?', values: ['Yes'] },
            { name: 'where_are_you_registered?', values: ['United Kingdom'] },
            { name: 'whats_your_main_question?', values: ['Visa timing'] },
          ],
        }, overrides),
      }],
    }],
  };
}

describe('normalizeFacebookGpLead', () => {
  it('parses the native Meta webhook shape when form id is allow-listed', () => {
    const lead = normalizeFacebookGpLead(nativeFbBody(), ['F-77']);
    expect(lead).toMatchObject({
      leadId: 'L-1001', formId: 'F-77', name: 'Aisha Khan',
      email: 'aisha@example.co.uk', phone: '+447700900123',
      isGp: true, country: 'uk', question: 'Visa timing',
    });
  });
  it('returns null when the form id is not allow-listed', () => {
    expect(normalizeFacebookGpLead(nativeFbBody(), ['OTHER'])).toBe(null);
    expect(normalizeFacebookGpLead(nativeFbBody(), [])).toBe(null);
  });

  // The live form asks about TRAINING, not current registration — a doctor who
  // trained in the UK and is registered elsewhere still holds the qualification
  // that decides eligibility. That key shares no substring with the older
  // registration wording, so both must resolve or a form re-word silently
  // screens out every lead.
  it('reads the country from a GP-training question as well as a registration one', () => {
    const trained = normalizeFacebookGpLead(nativeFbBody({
      field_data: [
        { name: 'full_name', values: ['Aisha Khan'] },
        { name: 'email', values: ['aisha@example.co.uk'] },
        { name: 'are_you_a_currently_registered_gp?', values: ['Yes'] },
        { name: 'where_did_you_complete_your_gp_training?', values: ['Ireland'] },
      ],
    }), ['F-77']);
    expect(trained).toMatchObject({ isGp: true, country: 'ie' });
  });

  it('still reads a plainly-named training question', () => {
    for (const key of ['gp_training_country', 'where_were_you_trained', 'training_location']) {
      const lead = normalizeFacebookGpLead(nativeFbBody({
        field_data: [
          { name: 'full_name', values: ['Aisha Khan'] },
          { name: 'email', values: ['aisha@example.co.uk'] },
          { name: 'are_you_a_currently_registered_gp?', values: ['Yes'] },
          { name: key, values: ['New Zealand'] },
        ],
      }), ['F-77']);
      expect(lead.country, `key ${key} should resolve`).toBe('nz');
    }
  });
  it('parses the flat (Zapier-relay) shape', () => {
    const lead = normalizeFacebookGpLead({
      form_id: 'F-77', lead_id: 'L-2002', full_name: 'Sean Byrne',
      email: 'sean@example.ie', phone: '+353860000000',
      is_gp: 'yes', country: 'Ireland', question: '',
    }, ['F-77']);
    expect(lead).toMatchObject({
      leadId: 'L-2002', formId: 'F-77', name: 'Sean Byrne',
      email: 'sean@example.ie', isGp: true, country: 'ie',
    });
  });
  it('returns null without an email', () => {
    const body = nativeFbBody({ field_data: [{ name: 'full_name', values: ['X'] }] });
    expect(normalizeFacebookGpLead(body, ['F-77'])).toBe(null);
  });
  it('strips <, >, & from name and question (HTML-injection guard)', () => {
    const body = nativeFbBody({
      field_data: [
        { name: 'full_name', values: ['Khan <b>evil</b>'] },
        { name: 'email', values: ['aisha@example.co.uk'] },
        { name: 'whats_your_main_question?', values: ['<img src=x onerror=alert(1)> & more'] },
      ],
    });
    const lead = normalizeFacebookGpLead(body, ['F-77']);
    expect(lead.name).not.toMatch(/[<>&]/);
    expect(lead.name).toBe('Khan bevil/b');
    expect(lead.question).not.toMatch(/[<>&]/);
  });
});

// 2026-08-13 — the first REAL lead through this funnel was screened out while
// answering "United Kingdom". Whatever Meta named that question's field, it
// matched none of our key hints, so the country resolved to 'other', the lead
// was filed screened_out, and she was never emailed at all: no magic link, and
// nextConsultNudge drops a screened_out lead forever.
//
// It hid because every "qualified" row in prod before her was a simulator lead
// built with the key WE chose — the old tests asserted our own assumption about
// Meta's naming rather than Meta's behaviour. These use a key that deliberately
// matches NO hint, which is the only honest stand-in for a form we don't
// control. Do not "fix" them by renaming the key to something we match.
describe('normalizeFacebookGpLead — country comes from the ANSWER, not the key', () => {
  function bodyWithCountryKey(key, answer, extra = []) {
    return nativeFbBody({
      field_data: [
        { name: 'full_name', values: ['Rabeeaa'] },
        { name: 'email', values: ['rabeeaa@example.com'] },
        { name: 'phone_number', values: ['+447342960304'] },
        { name: 'are_you_a_currently_registered_gp?', values: ['Yes'] },
        { name: key, values: [answer] },
        ...extra,
      ],
    });
  }

  it('recovers the country when the question key matches nothing we expect', () => {
    const lead = normalizeFacebookGpLead(
      bodyWithCountryKey('qualification_origin_5b2?', 'United Kingdom'), ['F-77']);
    expect(lead.country).toBe('uk');
    expect(lead.countrySource).toBe('answers');
    expect(lead.countryRaw).toBe('United Kingdom');
    // The whole point: this lead now passes screening instead of vanishing.
    expect(screenConsultLead({ isGp: lead.isGp, country: lead.country })).toBe(true);
  });

  it('recovers ie and nz the same way', () => {
    expect(normalizeFacebookGpLead(bodyWithCountryKey('q2', 'Ireland'), ['F-77']).country).toBe('ie');
    expect(normalizeFacebookGpLead(bodyWithCountryKey('q2', 'New Zealand'), ['F-77']).country).toBe('nz');
  });

  it('still prefers a real country question when one is recognisable', () => {
    // Keyed answer wins, so a stray country mentioned in free text cannot
    // overrule what they actually picked.
    const lead = normalizeFacebookGpLead(nativeFbBody({
      field_data: [
        { name: 'full_name', values: ['Aisha Khan'] },
        { name: 'email', values: ['aisha@example.co.uk'] },
        { name: 'are_you_a_currently_registered_gp?', values: ['Yes'] },
        { name: 'where_did_you_complete_your_gp_training?', values: ['Ireland'] },
        { name: 'anything_else?', values: ['I trained in New Zealand originally'] },
      ],
    }), ['F-77']);
    expect(lead.country).toBe('ie');
    expect(lead.countrySource).toBe('question');
  });

  it('never guesses a country from a name, email or phone number', () => {
    const lead = normalizeFacebookGpLead(nativeFbBody({
      field_data: [
        { name: 'full_name', values: ['Gareth Wales'] },
        { name: 'email', values: ['gareth@practice.nhs.uk'] },
        { name: 'phone_number', values: ['+447700900123'] },
        { name: 'are_you_a_currently_registered_gp?', values: ['Yes'] },
      ],
    }), ['F-77']);
    expect(lead.country).toBe('other');
    expect(lead.countrySource).toBe('none');
  });

  it('keeps an explicit answer we do not serve as their own words', () => {
    const lead = normalizeFacebookGpLead(
      bodyWithCountryKey('where_did_you_complete_your_gp_training?', 'India'), ['F-77']);
    expect(lead.country).toBe('other');
    expect(lead.countrySource).toBe('question');
    expect(lead.countryRaw).toBe('India');
  });

  it('reports source "none" when the form named no country anywhere', () => {
    const lead = normalizeFacebookGpLead(
      bodyWithCountryKey('unrelated_q?', 'Contract details'), ['F-77']);
    expect(lead.country).toBe('other');
    expect(lead.countrySource).toBe('none');
  });

  it('records the field names Meta sent so the next mystery is answerable', () => {
    const lead = normalizeFacebookGpLead(bodyWithCountryKey('mystery_key?', 'United Kingdom'), ['F-77']);
    expect(lead.fieldNames).toContain('mystery_key?');
    expect(lead.fieldNames).toContain('are_you_a_currently_registered_gp?');
  });
});

describe('looksLikeGpLeadForm', () => {
  it('recognises a doctor answering our GP form', () => {
    expect(looksLikeGpLeadForm([
      { name: 'full_name' }, { name: 'email' },
      { name: 'are_you_a_currently_registered_gp?' },
    ])).toBe(true);
  });
  it('does NOT claim a practice enquiry that happens to mention GPs', () => {
    expect(looksLikeGpLeadForm([
      { name: 'practice_name' }, { name: 'email' },
      { name: 'are_you_a_registered_gp_practice?' }, { name: 'gp_needed_by' },
    ])).toBe(false);
  });
  it('is false for an empty or answerless payload', () => {
    expect(looksLikeGpLeadForm([])).toBe(false);
    expect(looksLikeGpLeadForm(undefined)).toBe(false);
  });
});

// ── Meta sends the ANSWER as a snake_cased slug ──────────────────────────────
// Ground truth, not a guess: this is the field map a REAL lead produced on
// 2026-08-14 (Louise Beet, lead 1044950714846926), copied from the stored row.
// She tapped "United Kingdom" and Meta delivered `united_kingdom`. Because the
// matcher looked for 'united kingdom' WITH A SPACE she scored 'other' and a UK
// GP was shown "We're sorry, we can't take this one on" — a turndown that names
// the UK as a country we serve. Keep this fixture byte-for-byte: it is the only
// thing in the suite that reflects Meta's real naming rather than our own.
const REAL_META_GP_LEAD_FIELDS = {
  '_where_did_you_complete_your_gp_training?': 'united_kingdom',
  'full_name': 'Louise Beet',
  'are_you_a_currently_registered_gp?': 'yes',
  "anything_you'd_like_us_to_cover_on_the_call?": 'possible areas where work is needed, hours, rates of pay, help with family relocation, schools etc',
  'phone_number': '+447913895013',
  'email': 'louisecbeet@gmail.com'
};

describe('the real Meta payload (2026-08-14 regression)', () => {
  it('reads United Kingdom out of the slug Meta actually sends', () => {
    expect(parseCountryAnswer('united_kingdom')).toBe('uk');
  });

  it('qualifies the real lead end to end', () => {
    expect(resolveFbLeadCountry(REAL_META_GP_LEAD_FIELDS))
      .toMatchObject({ country: 'uk', raw: 'united_kingdom', source: 'question' });
  });

  it('handles the other slugged answers the same form can return', () => {
    expect(parseCountryAnswer('new_zealand')).toBe('nz');
    expect(parseCountryAnswer('northern_ireland')).toBe('uk');
    expect(parseCountryAnswer('republic_of_ireland')).toBe('ie');
    expect(parseCountryAnswer('united-kingdom')).toBe('uk');   // kebab too
    expect(parseCountryAnswer('UK/Ireland')).toBe('uk');       // punctuation
  });

  it('matches a short code that underscores used to hide', () => {
    // `_` is a word character, so \buk\b could never match inside these.
    expect(parseCountryAnswer('uk_trained')).toBe('uk');
    expect(parseCountryAnswer('trained_in_nz')).toBe('nz');
  });

  it('still says other for a country we do not serve', () => {
    expect(parseCountryAnswer('south_africa')).toBe('other');
    expect(parseCountryAnswer('australia')).toBe('other');
    expect(parseCountryAnswer('india')).toBe('other');
  });
});

describe('resolveFbLeadCountry', () => {
  it('reads a country out of a free-text answer when there is no country question', () => {
    expect(resolveFbLeadCountry({ 'anything?': 'I am a GP in Scotland' }))
      .toMatchObject({ country: 'uk', source: 'answers' });
  });
  it('returns source none for an empty form', () => {
    expect(resolveFbLeadCountry({})).toMatchObject({ country: 'other', source: 'none' });
  });
  it('still refuses to read a country out of the contact fields', () => {
    // A surname "Wales" or an @nhs.uk address is not a statement about where
    // someone trained — normalising separators must not have opened that door.
    expect(resolveFbLeadCountry({ full_name: 'Jane Wales', email: 'j@x.com' }))
      .toMatchObject({ country: 'other', source: 'none' });
    expect(resolveFbLeadCountry({ full_name: 'Jane Smith', email: 'jane@nhs.uk' }))
      .toMatchObject({ country: 'other', source: 'none' });
  });
});

describe('validateConsultLeadPayload', () => {
  const good = { name: 'Aisha Khan', email: 'a@b.co', phone: '+4477', isGp: true, country: 'uk', question: 'hi' };
  it('accepts a valid payload and normalizes country to lowercase', () => {
    const r = validateConsultLeadPayload({ ...good, country: 'UK' });
    expect(r.ok).toBe(true);
    expect(r.value.country).toBe('uk');
  });
  it('rejects missing name/email, bad email, bad country, non-boolean isGp', () => {
    expect(validateConsultLeadPayload({ ...good, name: '' }).ok).toBe(false);
    expect(validateConsultLeadPayload({ ...good, email: 'nope' }).ok).toBe(false);
    expect(validateConsultLeadPayload({ ...good, country: 'fr' }).ok).toBe(false);
    expect(validateConsultLeadPayload({ ...good, isGp: 'yes' }).ok).toBe(false);
  });
  it('caps question at 2000 chars', () => {
    const r = validateConsultLeadPayload({ ...good, question: 'x'.repeat(3000) });
    expect(r.ok).toBe(true);
    expect(r.value.question.length).toBe(2000);
  });
  it('strips <, >, & from name and question (HTML-injection guard)', () => {
    const r = validateConsultLeadPayload({ ...good, name: 'Khan <b>evil</b>', question: '<img src=x> & bye' });
    expect(r.ok).toBe(true);
    expect(r.value.name).not.toMatch(/[<>&]/);
    expect(r.value.name).toBe('Khan bevil/b');
    expect(r.value.question).not.toMatch(/[<>&]/);
  });
  it('rejects a name that is only angle-bracket/ampersand characters (empty after sanitizing)', () => {
    expect(validateConsultLeadPayload({ ...good, name: '<<<>>>' }).ok).toBe(false);
  });
});

describe('nextConsultNudge', () => {
  const t0 = Date.parse('2026-07-14T00:00:00Z');
  // Both touches are CHASES: the magic link now goes out on qualification from
  // the FB webhook, because Meta gives us no way to identify a GP who taps the
  // thank-you button, so the email is the only zero-typing route to a booking.
  it('not-booked: fires step 0 at 2h, step 1 at 48h, one per pass, never repeats', () => {
    const base = { consult: { call_booked: false, nudges: [] }, createdAtMs: t0 };
    expect(nextConsultNudge({ ...base, nowMs: t0 + 45 * MIN })).toBe(null);
    expect(nextConsultNudge({ ...base, nowMs: t0 + 1 * H })).toBe(null);
    expect(nextConsultNudge({ ...base, nowMs: t0 + 3 * H })).toEqual({ seq: 'not_booked', step: 0 });
    // after step 0 recorded, step 1 not due until 48h even if 3h elapsed
    const afterStep0 = { consult: { call_booked: false, nudges: [{ seq: 'not_booked', step: 0 }] }, createdAtMs: t0 };
    expect(nextConsultNudge({ ...afterStep0, nowMs: t0 + 3 * H })).toBe(null);
    expect(nextConsultNudge({ ...afterStep0, nowMs: t0 + 49 * H })).toEqual({ seq: 'not_booked', step: 1 });
    const done = { consult: { call_booked: false, nudges: [{ seq: 'not_booked', step: 0 }, { seq: 'not_booked', step: 1 }] }, createdAtMs: t0 };
    expect(nextConsultNudge({ ...done, nowMs: t0 + 90 * D })).toBe(null);
  });
  it('booked: touch 0 fires right after booking (anchored at call_booked_at)', () => {
    const bookedAt = t0 + 1 * H;
    const consult = { call_booked: true, call_booked_at: new Date(bookedAt).toISOString(), nudges: [] };
    expect(nextConsultNudge({ consult, createdAtMs: t0, nowMs: bookedAt })).toEqual({ seq: 'booked_no_signup', step: 0 });
    expect(nextConsultNudge({ consult, createdAtMs: t0, nowMs: bookedAt - 1 })).toBe(null);
  });
  it('booked: touch 1 waits until 20h AFTER the call, not the booking', () => {
    const bookedAt = t0;
    const callAt = t0 + 5 * D; // the call is 5 days after they booked
    const consult = { call_booked: true, call_booked_at: new Date(bookedAt).toISOString(), nudges: [{ seq: 'booked_no_signup', step: 0 }] };
    const input = { consult, createdAtMs: t0, callAtMs: callAt };
    expect(nextConsultNudge({ ...input, nowMs: bookedAt + 3 * D })).toBe(null);        // call not happened yet
    expect(nextConsultNudge({ ...input, nowMs: callAt + 19 * H })).toBe(null);         // just before 20h post-call
    expect(nextConsultNudge({ ...input, nowMs: callAt + 20 * H })).toEqual({ seq: 'booked_no_signup', step: 1 });
  });
  it('booked: weekly touches 2–4 anchor on the call time (7/14/21 days)', () => {
    const callAt = t0 + 5 * D;
    const mk = (steps) => ({ consult: { call_booked: true, call_booked_at: new Date(t0).toISOString(), nudges: steps.map((s) => ({ seq: 'booked_no_signup', step: s })) }, createdAtMs: t0, callAtMs: callAt });
    expect(nextConsultNudge({ ...mk([0, 1]), nowMs: callAt + 6 * D })).toBe(null);
    expect(nextConsultNudge({ ...mk([0, 1]), nowMs: callAt + 7 * D })).toEqual({ seq: 'booked_no_signup', step: 2 });
    expect(nextConsultNudge({ ...mk([0, 1, 2]), nowMs: callAt + 14 * D })).toEqual({ seq: 'booked_no_signup', step: 3 });
    expect(nextConsultNudge({ ...mk([0, 1, 2, 3]), nowMs: callAt + 21 * D })).toEqual({ seq: 'booked_no_signup', step: 4 });
    // all five sent → nothing more, ever
    expect(nextConsultNudge({ ...mk([0, 1, 2, 3, 4]), nowMs: callAt + 400 * D })).toBe(null);
  });
  it('booked: an UNQUALIFIED (never-screened direct) booker STILL gets the drip', () => {
    const bookedAt = t0 + 1 * H;
    const consult = { call_booked: true, qualified: false, call_booked_at: new Date(bookedAt).toISOString(), nudges: [] };
    expect(nextConsultNudge({ consult, createdAtMs: t0, nowMs: bookedAt })).toEqual({ seq: 'booked_no_signup', step: 0 });
  });
  it('booked: an UNKNOWN call time DEFERS the call-anchored steps (never falls back to booking)', () => {
    // Regression — a direct Calendly booker whose lead carried call_booked but no call_at
    // was told "that's the conversation done" ~20h after BOOKING, two days before the call
    // actually happened. No call time ⇒ nothing is "after the call" ⇒ nothing is due.
    const consult = { call_booked: true, call_booked_at: new Date(t0).toISOString(), nudges: [{ seq: 'booked_no_signup', step: 0 }] };
    expect(nextConsultNudge({ consult, createdAtMs: t0, nowMs: t0 + 20 * H })).toBe(null);
    expect(nextConsultNudge({ consult, createdAtMs: t0, nowMs: t0 + 400 * D })).toBe(null);
    // Non-finite anchors are treated the same as absent — an unparseable call_at must not
    // resurrect the booking-time fallback via NaN comparisons.
    expect(nextConsultNudge({ consult, createdAtMs: t0, callAtMs: NaN, nowMs: t0 + 20 * H })).toBe(null);
    expect(nextConsultNudge({ consult, createdAtMs: t0, callAtMs: Date.parse('not-a-date'), nowMs: t0 + 20 * H })).toBe(null);
    // …and once the call time is known, step 1 schedules off THAT, not the booking.
    const callAt = t0 + 3 * D;
    expect(nextConsultNudge({ consult, createdAtMs: t0, callAtMs: callAt, nowMs: t0 + 20 * H })).toBe(null);
    expect(nextConsultNudge({ consult, createdAtMs: t0, callAtMs: callAt, nowMs: callAt + 20 * H })).toEqual({ seq: 'booked_no_signup', step: 1 });
  });
  it('booked: step 0 still fires with no call time (it is booking-anchored, not call-anchored)', () => {
    const consult = { call_booked: true, call_booked_at: new Date(t0).toISOString(), nudges: [] };
    expect(nextConsultNudge({ consult, createdAtMs: t0, nowMs: t0 })).toEqual({ seq: 'booked_no_signup', step: 0 });
  });
  it('stopped / screened leads never nudge; unqualified stops ONLY the not_booked funnel', () => {
    const late = t0 + 10 * D;
    expect(nextConsultNudge({ consult: { stopped: 'signed_up', nudges: [] }, createdAtMs: t0, nowMs: late })).toBe(null);
    expect(nextConsultNudge({ consult: { screened_out: true, call_booked: true, call_booked_at: new Date(t0).toISOString(), nudges: [] }, createdAtMs: t0, nowMs: late })).toBe(null);
    expect(nextConsultNudge({ consult: { qualified: false, nudges: [] }, createdAtMs: t0, nowMs: late })).toBe(null); // not booked → stays gated
  });
});

describe('isConsultExhausted', () => {
  it('empty nudges → false', () => {
    expect(isConsultExhausted({ call_booked: false, nudges: [] })).toBe(false);
    expect(isConsultExhausted({})).toBe(false);
  });
  it('not_booked: exhausted once both steps 0 and 1 are recorded', () => {
    expect(isConsultExhausted({ call_booked: false, nudges: [{ seq: 'not_booked', step: 0 }] })).toBe(false);
    expect(isConsultExhausted({
      call_booked: false,
      nudges: [{ seq: 'not_booked', step: 0 }, { seq: 'not_booked', step: 1 }],
    })).toBe(true);
  });
  it('booked_no_signup: exhausted only once all 5 steps (0–4) are recorded', () => {
    const upTo = (n) => Array.from({ length: n + 1 }, (_, s) => ({ seq: 'booked_no_signup', step: s }));
    expect(isConsultExhausted({ call_booked: true, nudges: upTo(0) })).toBe(false);
    expect(isConsultExhausted({ call_booked: true, nudges: upTo(3) })).toBe(false);
    expect(isConsultExhausted({ call_booked: true, nudges: upTo(4) })).toBe(true);
  });
  it('a finished not_booked run is NOT exhausted once call_booked flips the applicable sequence', () => {
    const consult = {
      call_booked: true,
      nudges: [{ seq: 'not_booked', step: 0 }, { seq: 'not_booked', step: 1 }],
    };
    expect(isConsultExhausted(consult)).toBe(false);
    // Only exhausted once the NOW-applicable booked_no_signup steps (all 5) are sent too.
    const allBooked = Array.from({ length: 5 }, (_, s) => ({ seq: 'booked_no_signup', step: s }));
    expect(isConsultExhausted({
      call_booked: true,
      nudges: consult.nudges.concat(allBooked),
    })).toBe(true);
  });
});

describe('consultNudgeCopy + consultDisplayName', () => {
  it('builds all four copies with the right cta url', () => {
    const opts = { displayName: 'Dr Khan', bookUrl: 'https://x/start?lead=T#book', signupUrl: 'https://x/pages/signin?signup=1' };
    for (const [seq, steps] of [['not_booked', 2], ['booked_no_signup', 2]]) {
      for (let s = 0; s < steps; s++) {
        const c = consultNudgeCopy(seq, s, opts);
        expect(c.subject.length).toBeGreaterThan(4);
        expect(c.body).toContain('Dr Khan');
        expect(c.ctaUrl).toBe(seq === 'not_booked' ? opts.bookUrl : opts.signupUrl);
      }
    }
  });
  it('booked copy is no-show tolerant (mentions grabbing another time)', () => {
    const c = consultNudgeCopy('booked_no_signup', 0, { displayName: 'Dr K', bookUrl: 'https://b', signupUrl: 'https://s' });
    expect(c.body.toLowerCase()).toContain('another time');
  });
  it('booked_no_signup copy (both steps) carries the booking link as a secondary CTA', () => {
    const opts = { displayName: 'Dr K', bookUrl: 'https://x/start?lead=T#book', signupUrl: 'https://x/pages/signin?signup=1' };
    for (const step of [0, 1]) {
      const c = consultNudgeCopy('booked_no_signup', step, opts);
      expect(c.secondaryCtaUrl).toBe(opts.bookUrl);
      expect(c.secondaryCtaText).toMatch(/another/i);
    }
  });
  it('not_booked copy carries no secondary CTA', () => {
    const opts = { displayName: 'Dr K', bookUrl: 'https://x/start?lead=T#book', signupUrl: 'https://x/pages/signin?signup=1' };
    expect(consultNudgeCopy('not_booked', 0, opts).secondaryCtaUrl).toBeUndefined();
    expect(consultNudgeCopy('not_booked', 1, opts).secondaryCtaUrl).toBeUndefined();
  });
  it('consultDisplayName uses the last word', () => {
    expect(consultDisplayName('Aisha Khan')).toBe('Dr Khan');
    expect(consultDisplayName('Cher')).toBe('Dr Cher');
    expect(consultDisplayName('')).toBe('there');
  });
  it('consultDisplayName of a sanitized (angle-bracket-stripped) name stays sensible', () => {
    const sanitized = validateConsultLeadPayload({
      name: 'Khan <b>evil</b>', email: 'a@b.co', isGp: true, country: 'uk',
    }).value.name;
    expect(consultDisplayName(sanitized)).toBe('Dr bevil/b');
  });
});

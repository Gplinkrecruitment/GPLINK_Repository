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
  normalizeFacebookGpLead,
  validateConsultLeadPayload,
  nextConsultNudge,
  consultNudgeCopy,
  consultDisplayName,
} = require('../lib/consult-lead.js');

const H = 60 * 60 * 1000;
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
});

describe('nextConsultNudge', () => {
  const t0 = Date.parse('2026-07-14T00:00:00Z');
  it('not-booked: fires step 0 at 2h, step 1 at 48h, one per pass, never repeats', () => {
    const base = { consult: { call_booked: false, nudges: [] }, createdAtMs: t0 };
    expect(nextConsultNudge({ ...base, nowMs: t0 + 1 * H })).toBe(null);
    expect(nextConsultNudge({ ...base, nowMs: t0 + 3 * H })).toEqual({ seq: 'not_booked', step: 0 });
    // after step 0 recorded, step 1 not due until 48h even if 3h elapsed
    const afterStep0 = { consult: { call_booked: false, nudges: [{ seq: 'not_booked', step: 0 }] }, createdAtMs: t0 };
    expect(nextConsultNudge({ ...afterStep0, nowMs: t0 + 3 * H })).toBe(null);
    expect(nextConsultNudge({ ...afterStep0, nowMs: t0 + 49 * H })).toEqual({ seq: 'not_booked', step: 1 });
    const done = { consult: { call_booked: false, nudges: [{ seq: 'not_booked', step: 0 }, { seq: 'not_booked', step: 1 }] }, createdAtMs: t0 };
    expect(nextConsultNudge({ ...done, nowMs: t0 + 90 * D })).toBe(null);
  });
  it('booked: switches to booked_no_signup anchored at call_booked_at; not_booked stops', () => {
    const consult = { call_booked: true, call_booked_at: new Date(t0 + 1 * H).toISOString(), nudges: [] };
    expect(nextConsultNudge({ consult, createdAtMs: t0, nowMs: t0 + 2 * D })).toBe(null);
    expect(nextConsultNudge({ consult, createdAtMs: t0, nowMs: t0 + 1 * H + 3 * D + 1 })).toEqual({ seq: 'booked_no_signup', step: 0 });
  });
  it('stopped / screened / unqualified leads never nudge', () => {
    const late = t0 + 10 * D;
    expect(nextConsultNudge({ consult: { stopped: 'signed_up', nudges: [] }, createdAtMs: t0, nowMs: late })).toBe(null);
    expect(nextConsultNudge({ consult: { screened_out: true, nudges: [] }, createdAtMs: t0, nowMs: late })).toBe(null);
    expect(nextConsultNudge({ consult: { qualified: false, nudges: [] }, createdAtMs: t0, nowMs: late })).toBe(null);
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
  it('consultDisplayName uses the last word', () => {
    expect(consultDisplayName('Aisha Khan')).toBe('Dr Khan');
    expect(consultDisplayName('Cher')).toBe('Dr Cher');
    expect(consultDisplayName('')).toBe('there');
  });
});

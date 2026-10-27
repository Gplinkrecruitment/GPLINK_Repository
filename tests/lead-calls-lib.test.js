// Pure-logic tests for lib/lead-calls.js — the outbound AI call rules.
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  parseLeadCallConfig, normalizeE164, countryFromDialCode, fromNumberForCountry,
  isWithinCallWindow, leadCallDecision, buildLeadCallVariables,
  verifyRetellSignature, signRetellBody, outcomeFromCall, applyCallEventToConsult,
  calendlyAvailabilityWindows, formatSlotForSpeech, pickSlots, buildCalendlyInviteeBody,
  firstNameOf, OUTCOMES
} from '../lib/lead-calls.js';

// Tuesday 2026-10-27 11:00 UTC = 11:00 London (GMT), 22:00 Sydney (AEDT).
const TUE_11_UTC = Date.parse('2026-10-27T11:00:00Z');

const CFG = parseLeadCallConfig({
  LEAD_CALLS_ENABLED: 'true',
  RETELL_API_KEY: 'key_test',
  RETELL_AGENT_ID: 'agent_1',
  RETELL_FROM_NUMBER_UK: '+442030000000',
  RETELL_FROM_NUMBER_AU: '+61280000000'
});

function lead(over = {}) {
  const base = {
    id: 'lead-1',
    kind: 'gp',
    name: 'Dr Sarah Patel',
    email: 'sarah@nhs.net',
    phone: '+44 7700 900123',
    state: 'uk',
    status: 'new',
    created_at: new Date(TUE_11_UTC - 30 * 60000).toISOString(),
    metadata: { source: 'meta_lead_ad', consult: { qualified: true, is_gp: true, country: 'uk', call_booked: false } }
  };
  const r = Object.assign({}, base, over);
  if (over.consult) r.metadata = { source: 'meta_lead_ad', consult: Object.assign({}, base.metadata.consult, over.consult) };
  return r;
}

describe('config + phone helpers', () => {
  it('parses defaults and the test allow-list', () => {
    const c = parseLeadCallConfig({ LEAD_CALLS_TEST_NUMBERS: '+44 7700 900123, 0061 400 000 000' });
    expect(c.enabled).toBe(false);
    expect(c.maxAttempts).toBe(2);
    expect(c.maxLeadAgeMs).toBe(3 * 86400000);
    expect(c.testNumbers).toEqual(['+447700900123', '+61400000000']);
  });
  it('normalises to E.164 and refuses numbers without a country code', () => {
    expect(normalizeE164('+44 (0)7700 900123')).toBe('+4407700900123');
    expect(normalizeE164('07700900123')).toBe('');
    expect(normalizeE164('00353 87 123 4567')).toBe('+353871234567');
  });
  it('maps dial codes and chooses the local from-number', () => {
    expect(countryFromDialCode('+353871234567')).toBe('ie');
    expect(fromNumberForCountry('ie', CFG.fromNumbers)).toBe('+442030000000');
    expect(fromNumberForCountry('nz', CFG.fromNumbers)).toBe('+61280000000');
    expect(fromNumberForCountry('us', CFG.fromNumbers)).toBe('');
  });
});

describe('calling hours are judged in the lead\'s own zone', () => {
  it('11:00 Tuesday in London is inside hours; 22:00 Sydney is not', () => {
    expect(isWithinCallWindow(TUE_11_UTC, 'Europe/London')).toBe(true);
    expect(isWithinCallWindow(TUE_11_UTC, 'Australia/Sydney')).toBe(false);
  });
  it('Saturday afternoon is fine, Sunday never is', () => {
    const sat14London = Date.parse('2026-10-31T14:00:00Z');
    expect(isWithinCallWindow(sat14London, 'Europe/London')).toBe(true);
    const sun = Date.parse('2026-11-01T12:00:00Z');
    expect(isWithinCallWindow(sun, 'Europe/London')).toBe(false);
  });
  it('the 19:30 cut-off is respected', () => {
    expect(isWithinCallWindow(Date.parse('2026-10-27T19:29:00Z'), 'Europe/London')).toBe(true);
    expect(isWithinCallWindow(Date.parse('2026-10-27T19:31:00Z'), 'Europe/London')).toBe(false);
  });
});

describe('leadCallDecision', () => {
  it('calls a fresh, qualified UK GP with a phone during UK hours', () => {
    const d = leadCallDecision({ row: lead(), nowMs: TUE_11_UTC, cfg: CFG });
    expect(d.action).toBe('call');
    expect(d.phone).toBe('+447700900123');
    expect(d.from).toBe('+442030000000');
    expect(d.tz).toBe('Europe/London');
    expect(d.attempt).toBe(1);
  });
  it('skips the obvious non-starters with a named reason', () => {
    const at = (over) => leadCallDecision({ row: lead(over), nowMs: TUE_11_UTC, cfg: CFG }).reason;
    expect(at({ kind: 'practice' })).toBe('not_gp_lead');
    expect(at({ consult: { qualified: false } })).toBe('not_qualified');
    expect(at({ consult: { call_booked: true } })).toBe('already_booked');
    expect(at({ consult: { stopped: 'unsubscribed' } })).toBe('stopped_unsubscribed');
    expect(at({ phone: '' })).toBe('no_phone');
    expect(at({ phone: '+1 212 555 0100', consult: { country: 'uk' } })).toBe('dial_code_not_served');
    expect(at({ state: 'us', consult: { country: 'us' } })).toBe('country_not_served');
    expect(at({ status: 'converted' })).toBe('converted');
  });
  it('waits a few minutes after the form and never rings the back-catalogue', () => {
    const tooNew = lead({ created_at: new Date(TUE_11_UTC - 60000).toISOString() });
    expect(leadCallDecision({ row: tooNew, nowMs: TUE_11_UTC, cfg: CFG }).reason).toBe('too_new');
    const tooOld = lead({ created_at: new Date(TUE_11_UTC - 10 * 86400000).toISOString() });
    expect(leadCallDecision({ row: tooOld, nowMs: TUE_11_UTC, cfg: CFG }).reason).toBe('too_old');
  });
  it('an AU lead is skipped at 22:00 Sydney time, called at 10:00', () => {
    const au = lead({ phone: '+61 400 000 000', state: 'au', consult: { country: 'au' } });
    expect(leadCallDecision({ row: au, nowMs: TUE_11_UTC, cfg: CFG }).reason).toBe('outside_hours');
    expect(leadCallDecision({ row: au, nowMs: TUE_11_UTC, cfg: CFG, ignoreHours: true }).action).toBe('call');
    const tue10Sydney = Date.parse('2026-10-26T23:00:00Z');
    const d = leadCallDecision({ row: lead({ phone: '+61 400 000 000', state: 'au', created_at: new Date(tue10Sydney - 600000).toISOString(), consult: { country: 'au' } }), nowMs: tue10Sydney, cfg: CFG });
    expect(d.action).toBe('call');
    expect(d.from).toBe('+61280000000');
  });
  it('respects attempts, retry spacing, live calls and terminal outcomes', () => {
    const inProgress = lead({ consult: { ai_call: { call_id: 'c1', started_at: new Date(TUE_11_UTC - 2 * 60000).toISOString() } } });
    expect(leadCallDecision({ row: inProgress, nowMs: TUE_11_UTC, cfg: CFG }).reason).toBe('call_in_progress');

    const justEnded = lead({ consult: { ai_calls: [{ call_id: 'c1', outcome: 'no_answer' }], ai_call: { call_id: 'c1', outcome: 'no_answer', started_at: new Date(TUE_11_UTC - 40 * 60000).toISOString(), completed_at: new Date(TUE_11_UTC - 30 * 60000).toISOString() } } });
    expect(leadCallDecision({ row: justEnded, nowMs: TUE_11_UTC, cfg: CFG }).reason).toBe('retry_too_soon');

    const retryDue = lead({ created_at: new Date(TUE_11_UTC - 8 * 3600000).toISOString(), consult: { ai_calls: [{ call_id: 'c1', outcome: 'no_answer' }], ai_call: { call_id: 'c1', outcome: 'no_answer', started_at: new Date(TUE_11_UTC - 5 * 3600000).toISOString(), completed_at: new Date(TUE_11_UTC - 4 * 3600000).toISOString() } } });
    const d = leadCallDecision({ row: retryDue, nowMs: TUE_11_UTC, cfg: CFG });
    expect(d.action).toBe('call');
    expect(d.attempt).toBe(2);

    const maxed = lead({ created_at: new Date(TUE_11_UTC - 30 * 3600000).toISOString(), consult: { ai_calls: [{ call_id: 'c1', outcome: 'no_answer' }, { call_id: 'c2', outcome: 'voicemail' }], ai_call: { call_id: 'c2', outcome: 'voicemail', completed_at: new Date(TUE_11_UTC - 20 * 3600000).toISOString() } } });
    expect(leadCallDecision({ row: maxed, nowMs: TUE_11_UTC, cfg: CFG }).reason).toBe('max_attempts');

    const notInterested = lead({ consult: { ai_call: { call_id: 'c1', outcome: 'not_interested', completed_at: new Date(TUE_11_UTC - 5 * 3600000).toISOString() } } });
    expect(leadCallDecision({ row: notInterested, nowMs: TUE_11_UTC, cfg: CFG }).reason).toBe('outcome_not_interested');
  });
  it('a callback request is honoured until the asked-for time', () => {
    const later = new Date(TUE_11_UTC + 2 * 3600000).toISOString();
    const cb = lead({ created_at: new Date(TUE_11_UTC - 8 * 3600000).toISOString(), consult: { ai_call: { call_id: 'c1', outcome: 'callback_requested', callback_at: later, completed_at: new Date(TUE_11_UTC - 5 * 3600000).toISOString() } } });
    expect(leadCallDecision({ row: cb, nowMs: TUE_11_UTC, cfg: CFG }).reason).toBe('callback_later');
    expect(leadCallDecision({ row: cb, nowMs: TUE_11_UTC + 3 * 3600000, cfg: CFG }).action).toBe('call');
  });
  it('the test allow-list restricts dialling to listed numbers', () => {
    const cfg = parseLeadCallConfig({ RETELL_FROM_NUMBER_UK: '+442030000000', LEAD_CALLS_TEST_NUMBERS: '+447700900999' });
    expect(leadCallDecision({ row: lead(), nowMs: TUE_11_UTC, cfg }).reason).toBe('not_in_test_list');
  });
});

describe('dynamic variables for the prompt', () => {
  it('are all strings and describe the lead in spoken terms', () => {
    const v = buildLeadCallVariables({ row: lead(), nowMs: TUE_11_UTC, tz: 'Europe/London', country: 'uk', attempt: 1, directorName: 'Mo' });
    Object.values(v).forEach((val) => expect(typeof val).toBe('string'));
    expect(v.first_name).toBe('Sarah');
    expect(v.country_spoken).toBe('the UK');
    expect(v.enquiry_when).toBe('30 minutes ago');
    expect(v.enquiry_source).toBe('a Facebook ad');
    expect(v.local_time_now).toMatch(/^Tuesday 11:00 am$/);
    expect(v.director_name).toBe('Mo');
    expect(v.attempt).toBe('1');
  });
  it('strips a Dr prefix from the first name', () => {
    expect(firstNameOf('dr. james O\'Brien')).toBe('James');
    expect(firstNameOf('')).toBe('there');
  });
});

describe('Retell signature', () => {
  it('round-trips and rejects stale or tampered signatures', () => {
    const body = JSON.stringify({ event: 'call_ended', call: { call_id: 'c1' } });
    const sig = signRetellBody(body, 'key_test', TUE_11_UTC);
    expect(verifyRetellSignature(body, sig, 'key_test', TUE_11_UTC + 1000)).toBe(true);
    expect(verifyRetellSignature(body + ' ', sig, 'key_test', TUE_11_UTC + 1000)).toBe(false);
    expect(verifyRetellSignature(body, sig, 'other_key', TUE_11_UTC + 1000)).toBe(false);
    expect(verifyRetellSignature(body, sig, 'key_test', TUE_11_UTC + 6 * 60000)).toBe(false);
    expect(verifyRetellSignature(body, 'garbage', 'key_test', TUE_11_UTC)).toBe(false);
  });
  it('matches the documented v=ts,d=hmac(apiKey, body+ts) scheme', () => {
    const body = '{"a":1}';
    const d = crypto.createHmac('sha256', 'k').update(body + '1700000000000').digest('hex');
    expect(verifyRetellSignature(body, 'v=1700000000000,d=' + d, 'k', 1700000000000)).toBe(true);
  });
});

describe('outcomes from a finished call', () => {
  it('telephony reasons win over the transcript model', () => {
    expect(outcomeFromCall({ disconnection_reason: 'user_requested_dnc', call_analysis: { custom_analysis_data: { outcome: 'booked' } } })).toBe('do_not_call');
    expect(outcomeFromCall({ disconnection_reason: 'voicemail_reached' })).toBe('voicemail');
    expect(outcomeFromCall({ disconnection_reason: 'dial_no_answer' })).toBe('no_answer');
    expect(outcomeFromCall({ disconnection_reason: 'dial_failed' })).toBe('failed');
    expect(outcomeFromCall({ disconnection_reason: 'call_transfer' })).toBe('transferred');
  });
  it('uses the extracted outcome when the call connected, else "unclear"/"no_answer"', () => {
    expect(outcomeFromCall({ disconnection_reason: 'user_hangup', transcript: 'Agent: hi', call_analysis: { custom_analysis_data: { outcome: 'not_interested' } } })).toBe('not_interested');
    expect(outcomeFromCall({ disconnection_reason: 'user_hangup', transcript: 'Agent: hi\nUser: hello' })).toBe('unclear');
    expect(outcomeFromCall({ disconnection_reason: 'user_hangup', transcript: '' })).toBe('no_answer');
    expect(Object.keys(OUTCOMES)).toContain('link_sent');
  });
});

describe('applyCallEventToConsult', () => {
  const started = { call_id: 'c1', from_number: '+442030000000' };
  const ended = { call_id: 'c1', disconnection_reason: 'user_hangup', duration_ms: 185000, transcript: 'Agent: Hi\nUser: Hello' };
  const analyzed = Object.assign({}, ended, { call_analysis: { call_summary: 'Booked Thursday.', user_sentiment: 'Positive', custom_analysis_data: { outcome: 'booked', gp_status: 'gp' } }, recording_url: 'https://r/x.wav' });
  const base = { qualified: true, ai_call: { call_id: 'c1', attempt: 1, started_at: '2026-10-27T10:58:00.000Z' } };

  it('marks the live call as answered once, then folds the ended + analysed events', () => {
    const s1 = applyCallEventToConsult(base, 'call_started', started, '2026-10-27T10:58:05.000Z');
    expect(s1.ai_call.status).toBe('ongoing');
    expect(applyCallEventToConsult(s1, 'call_started', started, '2026-10-27T10:58:06.000Z')).toBeNull();

    const s2 = applyCallEventToConsult(s1, 'call_ended', ended, '2026-10-27T11:01:10.000Z');
    expect(s2.ai_call.status).toBe('ended');
    expect(s2.ai_call.outcome).toBe('unclear');
    expect(s2.ai_call.duration_s).toBe(185);
    expect(s2.ai_calls).toHaveLength(1);

    const s3 = applyCallEventToConsult(s2, 'call_analyzed', analyzed, '2026-10-27T11:01:40.000Z');
    expect(s3.ai_call.outcome).toBe('booked');
    expect(s3.ai_call.summary).toBe('Booked Thursday.');
    expect(s3.ai_call.gp_status).toBe('gp');
    expect(s3.ai_call.recording_url).toBe('https://r/x.wav');
    expect(s3.ai_calls).toHaveLength(1);
    expect(s3.ai_calls[0].outcome).toBe('booked');
    // Retries of the same event are no-ops.
    expect(applyCallEventToConsult(s3, 'call_analyzed', analyzed, '2026-10-27T11:02:00.000Z')).toBeNull();
    expect(applyCallEventToConsult(s3, 'call_ended', ended, '2026-10-27T11:02:00.000Z')).toBeNull();
  });
  it('a tool-stamped outcome is never overruled by the analysis model', () => {
    const withTool = { qualified: true, ai_call: { call_id: 'c1', attempt: 1, started_at: '2026-10-27T10:58:00.000Z', tool_outcome: 'link_sent' } };
    const s = applyCallEventToConsult(withTool, 'call_analyzed', analyzed, '2026-10-27T11:01:40.000Z');
    expect(s.ai_call.outcome).toBe('link_sent');
  });
  it('a do-not-call or not-interested result stops the chase', () => {
    const dnc = applyCallEventToConsult(base, 'call_ended', { call_id: 'c1', disconnection_reason: 'user_requested_dnc' }, '2026-10-27T11:01:10.000Z');
    expect(dnc.stopped).toBe('do_not_call');
    const ni = applyCallEventToConsult(base, 'call_analyzed', { call_id: 'c1', disconnection_reason: 'user_hangup', transcript: 'x', call_analysis: { custom_analysis_data: { outcome: 'not_interested' } } }, '2026-10-27T11:01:10.000Z');
    expect(ni.stopped).toBe('not_interested');
  });
  it('an event for an unknown call still records a history entry', () => {
    const s = applyCallEventToConsult({ qualified: true }, 'call_ended', { call_id: 'c9', disconnection_reason: 'dial_no_answer' }, '2026-10-27T11:01:10.000Z');
    expect(s.ai_call.call_id).toBe('c9');
    expect(s.ai_call.outcome).toBe('no_answer');
    expect(s.ai_call.attempt).toBe(1);
  });
});

describe('Calendly slots', () => {
  it('splits the look-ahead into 7-day windows starting in two hours', () => {
    const w = calendlyAvailabilityWindows(TUE_11_UTC, 14);
    expect(w).toHaveLength(2);
    expect(w[0].start_time).toBe('2026-10-27T13:00:00.000Z');
    expect(w[0].end_time).toBe('2026-11-03T13:00:00.000Z');
    expect(w[1].end_time).toBe('2026-11-10T13:00:00.000Z');
  });
  it('speaks a slot in the lead\'s zone', () => {
    expect(formatSlotForSpeech('2026-10-29T18:30:00Z', 'Europe/London')).toBe('Thursday the 29th of October at 6:30 pm');
    expect(formatSlotForSpeech('2026-10-29T18:30:00Z', 'Australia/Sydney')).toBe('Friday the 30th of October at 5:30 am');
  });
  it('offers up to three slots on different days inside the lead\'s waking hours, honouring preferences', () => {
    const avail = [
      { status: 'available', start_time: '2026-10-27T12:00:00Z' }, // too soon (<90 min)
      { status: 'available', start_time: '2026-10-28T02:00:00Z' }, // 2am London — out
      { status: 'available', start_time: '2026-10-28T09:00:00Z' },
      { status: 'available', start_time: '2026-10-28T18:30:00Z' },
      { status: 'available', start_time: '2026-10-29T18:30:00Z' },
      { status: 'available', start_time: '2026-10-30T09:00:00Z' },
      { status: 'unavailable', start_time: '2026-10-31T09:00:00Z' }
    ];
    const any = pickSlots(avail, { tz: 'Europe/London', nowMs: TUE_11_UTC });
    expect(any.map((s) => s.start_time)).toEqual(['2026-10-28T09:00:00Z', '2026-10-29T18:30:00Z', '2026-10-30T09:00:00Z']);
    const evenings = pickSlots(avail, { tz: 'Europe/London', nowMs: TUE_11_UTC, timeOfDay: 'evening' });
    expect(evenings.map((s) => s.start_time)).toEqual(['2026-10-28T18:30:00Z', '2026-10-29T18:30:00Z']);
    const thursday = pickSlots(avail, { tz: 'Europe/London', nowMs: TUE_11_UTC, preferredDay: 'thursday' });
    expect(thursday.map((s) => s.start_time)).toEqual(['2026-10-29T18:30:00Z']);
    const tomorrow = pickSlots(avail, { tz: 'Europe/London', nowMs: TUE_11_UTC, preferredDay: 'tomorrow', limit: 2 });
    expect(tomorrow.map((s) => s.start_time)).toEqual(['2026-10-28T09:00:00Z', '2026-10-28T18:30:00Z']);
    expect(any[0].spoken).toBe('Wednesday the 28th of October at 9:00 am');
  });
  it('builds the invitee body with the phone question answered', () => {
    const body = buildCalendlyInviteeBody({
      eventTypeUri: 'https://api.calendly.com/event_types/ABC',
      startTime: '2026-10-29T18:30:00Z',
      name: 'Dr Sarah Patel',
      email: 'Sarah@NHS.net',
      tz: 'Europe/London',
      phone: '+447700900123',
      customQuestions: [
        { name: 'Phone number', type: 'phone_number', position: 0, required: true, enabled: true },
        { name: 'Anything you want to ask?', type: 'text', position: 1, required: false, enabled: true },
        { name: 'Where are you based?', type: 'string', position: 2, required: true, enabled: true }
      ]
    });
    expect(body.event_type).toBe('https://api.calendly.com/event_types/ABC');
    expect(body.invitee).toEqual({ name: 'Sarah Patel', first_name: 'Sarah', last_name: 'Patel', email: 'sarah@nhs.net', timezone: 'Europe/London' });
    expect(body.questions_and_answers).toEqual([
      { question: 'Phone number', answer: '+447700900123', position: 0 },
      { question: 'Where are you based?', answer: 'Booked over the phone with Hazel from GP Link.', position: 2 }
    ]);
    expect(body.tracking.utm_source).toBe('ai_call');
    expect(body.location).toBeUndefined();
  });
});

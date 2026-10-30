// Pure-logic tests for lib/lead-calls.js — the outbound AI call rules.
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  parseLeadCallConfig, normalizeE164, countryFromDialCode, fromNumberForCountry,
  isWithinCallWindow, leadCallDecision, buildLeadCallVariables,
  verifyRetellSignature, signRetellBody, outcomeFromCall, applyCallEventToConsult,
  calendlyAvailabilityWindows, formatSlotForSpeech, pickSlots, buildCalendlyInviteeBody,
  firstNameOf, OUTCOMES, CALL_STOP_REASONS, nextCallWindowStart, leadStage, leadCallPlan
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
  it('weekends are 10:00 to 18:00, both days', () => {
    const sat14London = Date.parse('2026-10-31T14:00:00Z');
    expect(isWithinCallWindow(sat14London, 'Europe/London')).toBe(true);
    expect(isWithinCallWindow(Date.parse('2026-10-31T18:30:00Z'), 'Europe/London')).toBe(false);
    const sun = Date.parse('2026-11-01T12:00:00Z');
    expect(isWithinCallWindow(sun, 'Europe/London')).toBe(true);
    expect(isWithinCallWindow(Date.parse('2026-11-01T09:30:00Z'), 'Europe/London')).toBe(false);
    expect(isWithinCallWindow(Date.parse('2026-11-01T18:00:00Z'), 'Europe/London')).toBe(false);
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
      { question: 'Where are you based?', answer: 'Booked over the phone with Hayley from GP Link.', position: 2 }
    ]);
    expect(body.tracking.utm_source).toBe('ai_call');
    // Calendly rejects a partial tracking object, so every key must be present.
    expect(Object.keys(body.tracking).sort()).toEqual(['salesforce_uuid', 'utm_campaign', 'utm_content', 'utm_medium', 'utm_source', 'utm_term']);
    expect(body.tracking.utm_content).toBeNull();
    expect(body.location).toBeUndefined();
  });
});

// ── 2026-10-30: calling PAST leads from the Leads tab ───────────────────────
// The owner's plan is to have Hazel ring the back-catalogue. Three rules
// changed for that: an exhausted email chase no longer blocks the phone, the
// owner can pause one lead or schedule a call-back, and a DUE call-back waives
// the dialler's self-pacing guards (age, attempts, spacing) but never consent,
// the number checks or local hours.
describe('leadCallDecision — past-leads rules', () => {
  const at = (over) => leadCallDecision({ row: lead(over), nowMs: TUE_11_UTC, cfg: CFG }).reason;
  const old = () => new Date(TUE_11_UTC - 40 * 86400000).toISOString();

  it('only consent/won values of consult.stopped block the phone', () => {
    expect(CALL_STOP_REASONS).toEqual(['do_not_call', 'not_interested', 'unsubscribed', 'signed_up']);
    expect(at({ consult: { stopped: 'exhausted' } })).toBeUndefined();
    expect(leadCallDecision({ row: lead({ consult: { stopped: 'exhausted' } }), nowMs: TUE_11_UTC, cfg: CFG }).action).toBe('call');
    expect(leadCallDecision({ row: lead({ consult: { stopped: 'replied' } }), nowMs: TUE_11_UTC, cfg: CFG }).action).toBe('call');
    expect(at({ consult: { stopped: 'do_not_call' } })).toBe('stopped_do_not_call');
    expect(at({ consult: { stopped: 'signed_up' } })).toBe('stopped_signed_up');
  });

  it('a paused lead is skipped until the owner resumes it', () => {
    expect(at({ consult: { calls_paused: true } })).toBe('paused');
  });

  it("the owner's call-back waits for its time, then rings despite age, attempts and screening", () => {
    const later = new Date(TUE_11_UTC + 3600000).toISOString();
    const due = new Date(TUE_11_UTC - 60000).toISOString();
    expect(at({ consult: { call_back_at: later } })).toBe('callback_later');
    // Too old for the dialler on its own, attempts used up, never screened:
    // a due owner call-back rings anyway.
    const hist = [{ call_id: 'a', outcome: 'no_answer', completed_at: old() }, { call_id: 'b', outcome: 'voicemail', completed_at: old() }];
    const d = leadCallDecision({ row: lead({ created_at: old(), consult: { call_back_at: due, qualified: false, ai_calls: hist, ai_call: { call_id: 'b', outcome: 'link_sent', completed_at: old() } } }), nowMs: TUE_11_UTC, cfg: CFG });
    expect(d.action).toBe('call');
    expect(d.attempt).toBe(3);
  });

  it('a due call-back never overrides consent, the number, the allow-list or local hours', () => {
    const due = new Date(TUE_11_UTC - 60000).toISOString();
    expect(at({ consult: { call_back_at: due, stopped: 'do_not_call' } })).toBe('stopped_do_not_call');
    expect(at({ phone: '', consult: { call_back_at: due } })).toBe('no_phone');
    expect(at({ phone: '+1 212 555 0100', consult: { call_back_at: due, country: 'us' } })).toBe('country_not_served');
    const testCfg = parseLeadCallConfig({ LEAD_CALLS_TEST_NUMBERS: '+447000000000', RETELL_FROM_NUMBER_UK: '+442030000000' });
    expect(leadCallDecision({ row: lead({ consult: { call_back_at: due } }), nowMs: TUE_11_UTC, cfg: testCfg }).reason).toBe('not_in_test_list');
    // Sunday 09:00 London — before the weekend window opens, even for a call-back.
    const sun = Date.parse('2026-11-01T09:00:00Z');
    expect(leadCallDecision({ row: lead({ consult: { call_back_at: due } }), nowMs: sun, cfg: CFG }).reason).toBe('outside_hours');
  });

  it("Hazel's own callback, once due, is not blocked by the lead-age guard", () => {
    const due = new Date(TUE_11_UTC - 60000).toISOString();
    const d = leadCallDecision({ row: lead({ created_at: old(), consult: { ai_call: { call_id: 'c1', outcome: 'callback_requested', callback_at: due, completed_at: old() }, ai_calls: [{ call_id: 'c1', outcome: 'callback_requested', completed_at: old() }] } }), nowMs: TUE_11_UTC, cfg: CFG });
    expect(d.action).toBe('call');
  });
});

describe('nextCallWindowStart', () => {
  it('returns now when the window is open, else the next opening', () => {
    expect(nextCallWindowStart(TUE_11_UTC, 'Europe/London')).toBe(TUE_11_UTC);
    // Saturday 20:00 London → Sunday 10:00 London (weekends 10-18; GMT in November).
    const satNight = Date.parse('2026-10-31T20:00:00Z');
    expect(new Date(nextCallWindowStart(satNight, 'Europe/London')).toISOString()).toBe('2026-11-01T10:00:00.000Z');
    // Friday 19:35 Sydney (AEDT, UTC+11) → Saturday 10:00 Sydney = 23:00Z Friday.
    const friNight = Date.parse('2026-10-30T08:35:00Z');
    expect(new Date(nextCallWindowStart(friNight, 'Australia/Sydney')).toISOString()).toBe('2026-10-30T23:00:00.000Z');
  });
});

describe('leadStage — one badge per lead', () => {
  const stage = (over) => leadStage(lead(over)).key;
  it('ranks the decisive fact first', () => {
    expect(stage({ status: 'converted', consult: { call_booked: true } })).toBe('signed_up');
    expect(stage({ consult: { call_booked: true, not_screened: true } })).toBe('unscreened');
    expect(stage({ consult: { call_booked: true } })).toBe('booked');
    expect(leadStage(lead({ consult: { call_booked: true, call_completed_at: '2026-10-20T10:00:00Z' } })).label).toBe('Consult done');
    expect(stage({})).toBe('open');
    expect(stage({ consult: { qualified: false, screened_out: true } })).toBe('not_qualified');
    expect(stage({ consult: { qualified: undefined } })).toBe('unscreened');
  });
  it('burnt = they told us to stop, with the reason in words', () => {
    expect(leadStage(lead({ consult: { stopped: 'unsubscribed' } }))).toMatchObject({ key: 'burnt', reason: 'unsubscribed' });
    expect(leadStage(lead({ consult: { stopped: 'do_not_call' } }))).toMatchObject({ key: 'burnt', reason: 'asked not to be called' });
    expect(leadStage(lead({ consult: { stopped: 'not_interested', ai_call: { outcome: 'not_a_gp' } } })).reason).toMatch(/not a GP/);
    expect(leadStage(lead({ consult: { stopped: 'not_interested', ai_call: { outcome: 'not_interested' } } })).reason).toMatch(/not interested/);
    // Email-sequence states are NOT burnt.
    expect(stage({ consult: { stopped: 'exhausted' } })).toBe('open');
  });
});

describe('leadCallPlan — what Hazel will do next, in words', () => {
  const plan = (over, nowMs) => leadCallPlan({ row: lead(over), nowMs: nowMs || TUE_11_UTC, cfg: CFG });
  it('queued now, or queued for the next window', () => {
    expect(plan({})).toMatchObject({ state: 'queued', label: 'Queued — rings within 5 minutes' });
    const satNight = Date.parse('2026-10-31T20:00:00Z');
    const p = plan({ created_at: new Date(satNight - 3600000).toISOString() }, satNight);
    expect(p.state).toBe('queued');
    expect(p.due_at).toBe('2026-11-01T10:00:00.000Z');
  });
  it('explains every reason the dialler will not ring', () => {
    expect(plan({ created_at: new Date(TUE_11_UTC - 40 * 86400000).toISOString() })).toMatchObject({ state: 'blocked', reason: 'too_old' });
    expect(plan({ created_at: new Date(TUE_11_UTC - 40 * 86400000).toISOString() }).label).toContain('3-day limit');
    expect(plan({ phone: '' })).toMatchObject({ state: 'blocked', label: 'No phone number' });
    expect(plan({ consult: { calls_paused: true } })).toMatchObject({ state: 'paused' });
    expect(plan({ consult: { stopped: 'do_not_call' } })).toMatchObject({ state: 'burnt', label: 'No calls — asked not to be called' });
    expect(plan({ consult: { qualified: false, screened_out: true } })).toMatchObject({ state: 'none' });
  });
  it('scheduled, retry and gave-up read back the time or the attempts', () => {
    const later = new Date(TUE_11_UTC + 2 * 3600000).toISOString();
    expect(plan({ consult: { call_back_at: later } })).toMatchObject({ state: 'scheduled', label: 'Call-back scheduled by you', due_at: later });
    const hz = plan({ consult: { ai_call: { call_id: 'c', outcome: 'callback_requested', callback_at: later, callback_note: 'after clinic', completed_at: new Date(TUE_11_UTC - 3600000).toISOString() }, ai_calls: [{ call_id: 'c', outcome: 'callback_requested' }] } });
    expect(hz).toMatchObject({ state: 'scheduled', label: 'Call-back requested by the doctor', detail: 'after clinic', due_at: later });
    const justEnded = new Date(TUE_11_UTC - 10 * 60000).toISOString();
    const r = plan({ consult: { ai_call: { call_id: 'c', outcome: 'voicemail', completed_at: justEnded }, ai_calls: [{ call_id: 'c', outcome: 'voicemail', completed_at: justEnded }] } });
    expect(r.state).toBe('retry');
    expect(r.due_at).toBe(new Date(Date.parse(justEnded) + CFG.retryAfterMs).toISOString());
    const oldMs = new Date(TUE_11_UTC - 5 * 3600000).toISOString();
    const g = plan({ consult: { ai_call: { call_id: 'b', outcome: 'no_answer', completed_at: oldMs }, ai_calls: [{ call_id: 'a', outcome: 'voicemail' }, { call_id: 'b', outcome: 'no_answer' }] } });
    expect(g).toMatchObject({ state: 'gave_up', label: 'Gave up after 2 attempts', detail: 'voicemail, no answer' });
  });
  it('terminal outcomes say so', () => {
    const done = new Date(TUE_11_UTC - 3600000).toISOString();
    expect(plan({ consult: { ai_call: { call_id: 'c', outcome: 'link_sent', completed_at: done }, ai_calls: [{ call_id: 'c', outcome: 'link_sent' }] } })).toMatchObject({ state: 'done' });
    expect(plan({ consult: { ai_call: { call_id: 'c', outcome: 'wrong_number', completed_at: done }, ai_calls: [{ call_id: 'c', outcome: 'wrong_number' }] } })).toMatchObject({ state: 'burnt', label: 'Wrong number — no more calls' });
    expect(plan({ consult: { ai_call: { call_id: 'c', status: 'ongoing', started_at: new Date(TUE_11_UTC - 60000).toISOString() } } })).toMatchObject({ state: 'in_progress', label: 'On the phone now' });
  });
});

describe('pickSlots offers only hour and half-hour starts', () => {
  it('drops Calendly 5-minute increments like 1:35 and 1:40', () => {
    const nowMs = Date.parse('2026-11-02T09:00:00Z');
    const avail = ['2026-11-07T13:30:00Z', '2026-11-07T13:35:00Z', '2026-11-07T13:40:00Z', '2026-11-07T14:00:00Z', '2026-11-07T14:05:00Z']
      .map((start_time) => ({ status: 'available', start_time }));
    const picked = pickSlots(avail, { tz: 'Europe/London', nowMs, limit: 3 }).map((s) => s.start_time);
    expect(picked).toEqual(['2026-11-07T13:30:00Z', '2026-11-07T14:00:00Z']);
  });
});

describe('website leads that never answered the GP question', () => {
  it('are called when qualified, even if is_gp was stored as false', () => {
    const row = { id: 'w1', kind: 'gp', phone: '+447700900123', created_at: new Date(Date.now() - 10 * 60000).toISOString(),
      metadata: { source: 'site_start_form', consult: { qualified: true, is_gp: false, country: 'uk', call_booked: false } } };
    const cfg = parseLeadCallConfig({ LEAD_CALLS_ENABLED: 'true', RETELL_API_KEY: 'k', RETELL_AGENT_ID: 'a', RETELL_FROM_NUMBER_UK: '+447000000000' });
    const d = leadCallDecision({ row, nowMs: Date.now(), cfg, ignoreHours: true });
    expect(d.action).toBe('call');
  });
});

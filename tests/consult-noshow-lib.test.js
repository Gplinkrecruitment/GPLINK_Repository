// Pure-logic tests for lib/consult-noshow.js (the rescue for a doctor who
// booked the free consultation and did not join) and for the one change it
// makes to the dialler: a booked lead is rung ONCE after a missed slot.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { parseLeadCallConfig, leadCallDecision, leadCallPlan, buildLeadCallVariables } from '../lib/lead-calls.js';

const requireCjs = createRequire(import.meta.url);
const ns = requireCjs('../lib/consult-noshow.js');
const waLib = requireCjs('../lib/consult-whatsapp.js');

const M = 60000;
const H = 60 * M;
// Thursday 2026-11-12. Slot at 10:00 London (GMT); "now" values hang off it.
const SLOT = '2026-11-12T10:00:00.000Z';
const SLOT_MS = Date.parse(SLOT);

const CFG = parseLeadCallConfig({
  LEAD_CALLS_ENABLED: 'true', RETELL_API_KEY: 'key_test', RETELL_AGENT_ID: 'agent_1',
  RETELL_FROM_NUMBER_UK: '+442030000000', RETELL_FROM_NUMBER_AU: '+61280000000'
});

function marker(over) {
  return Object.assign({ call_at: SLOT, detected_at: '2026-11-12T11:30:00.000Z', via: 'sweep', ring: 'pending' }, over || {});
}
function lead(consultOver, rowOver) {
  const consult = Object.assign({
    token: 'TOK1', qualified: true, is_gp: true, country: 'uk',
    call_booked: true, call_booked_at: '2026-11-10T09:00:00.000Z', call_at: SLOT, no_show: marker()
  }, consultOver || {});
  return Object.assign({
    id: 'lead-ns-1', kind: 'gp', name: 'Dr Sarah Patel', email: 'sarah@nhs.net', phone: '+44 7700 900123',
    state: 'uk', status: 'contacted', created_at: '2026-11-09T09:00:00.000Z',
    metadata: { source: 'meta_lead_ad', consult }
  }, rowOver || {});
}

describe('newNoShowMarker', () => {
  it('records a slot that has passed, once', () => {
    const m = ns.newNoShowMarker({ consult: {}, callAtIso: SLOT, nowIso: '2026-11-12T11:30:00.000Z', via: 'sweep' });
    expect(m).toEqual({ call_at: SLOT, detected_at: '2026-11-12T11:30:00.000Z', via: 'sweep', ring: 'pending' });
    // The other path concluding the same slot does not start a second rescue.
    expect(ns.newNoShowMarker({ consult: { no_show: m }, callAtIso: SLOT, nowIso: '2026-11-12T11:40:00.000Z', via: 'zoom_participants' })).toBe(null);
  });

  it('a second missed booking gets its own marker', () => {
    const later = '2026-11-14T09:00:00.000Z';
    const m = ns.newNoShowMarker({ consult: { no_show: marker({ ring: 'placed', email_at: 'x' }) }, callAtIso: later, nowIso: '2026-11-14T10:40:00.000Z' });
    expect(m.call_at).toBe(later);
    expect(m.ring).toBe('pending');
    expect(m.email_at).toBeUndefined();
  });

  it('never backfills: a slot before the gate is not recorded', () => {
    expect(ns.CONSULT_NOSHOW_RESCUE_SINCE_MS).toBe(Date.parse('2026-11-11T00:00:00Z'));
    expect(ns.newNoShowMarker({ consult: {}, callAtIso: '2026-11-10T23:30:00.000Z', nowIso: '2026-11-11T02:00:00.000Z' })).toBe(null);
    expect(ns.newNoShowMarker({ consult: {}, callAtIso: '2026-11-07T12:00:00.000Z', nowIso: '2026-11-12T02:00:00.000Z' })).toBe(null);
  });

  it('a slot still in the future, or no slot time, is not a miss', () => {
    expect(ns.newNoShowMarker({ consult: {}, callAtIso: SLOT, nowIso: '2026-11-12T09:40:00.000Z' })).toBe(null);
    expect(ns.newNoShowMarker({ consult: {}, callAtIso: '', nowIso: '2026-11-12T12:00:00.000Z' })).toBe(null);
    expect(ns.newNoShowMarker({ consult: {}, callAtIso: 'garbage', nowIso: '2026-11-12T12:00:00.000Z' })).toBe(null);
  });
});

describe('noShowRescueDecision: the email and the WhatsApp', () => {
  const dec = (row, afterMs, extra) => ns.noShowRescueDecision(Object.assign({ row, nowMs: SLOT_MS + afterMs }, extra || {}));

  it('waits an hour from the slot, then owes both, each once', () => {
    expect(dec(lead(), 40 * M)).toEqual({ email: false, wa: false, reason: 'too_soon' });
    expect(dec(lead(), 61 * M)).toEqual({ email: true, wa: true, reason: 'due' });
    expect(dec(lead({ no_show: marker({ email_at: 'x' }) }), 61 * M)).toEqual({ email: false, wa: true, reason: 'due' });
    expect(dec(lead({ no_show: marker({ email_at: 'x', wa_at: 'y' }) }), 61 * M)).toEqual({ email: false, wa: false, reason: 'done' });
  });

  it('gives up after a day and a half, and after repeated failed sends', () => {
    expect(dec(lead(), 37 * H).reason).toBe('expired');
    expect(dec(lead({ no_show: marker({ wa_tries: ns.NOSHOW_WA_MAX_TRIES }) }), 2 * H)).toEqual({ email: true, wa: false, reason: 'due' });
    expect(dec(lead({ no_show: marker({ email_tries: ns.NOSHOW_EMAIL_MAX_TRIES }) }), 2 * H)).toEqual({ email: false, wa: true, reason: 'due' });
  });

  it('no phone ⇒ email only; a bounced address ⇒ WhatsApp only', () => {
    expect(dec(lead({}, { phone: '' }), 2 * H)).toEqual({ email: true, wa: false, reason: 'due' });
    expect(dec(lead({ email_bounced: true }), 2 * H)).toEqual({ email: false, wa: true, reason: 'due' });
  });

  it('a real stop silences it; an exhausted or replied email chase does not', () => {
    ['unsubscribed', 'do_not_call', 'not_interested'].forEach((stop) => {
      expect(dec(lead({ stopped: stop }), 2 * H)).toEqual({ email: false, wa: false, reason: 'stopped_' + stop });
    });
    expect(dec(lead({ stopped: 'exhausted' }), 2 * H).reason).toBe('due');
    expect(dec(lead({ stopped: 'replied' }), 2 * H).reason).toBe('due');
    expect(dec(lead({ stopped: 'signed_up' }), 2 * H).reason).toBe('due');
  });

  it('nothing for a doctor who joined after all, or who has re-booked', () => {
    expect(dec(lead({ call_attended: true }), 2 * H).reason).toBe('inactive');
    expect(dec(lead({ call_at: '2026-11-14T09:00:00.000Z' }), 2 * H).reason).toBe('inactive');
    // The same instant written another way is still the same slot.
    expect(dec(lead({ call_at: '2026-11-12T10:00:00Z' }), 2 * H).reason).toBe('due');
  });

  it('nothing for the team\'s own test leads, or with no marker', () => {
    expect(dec(lead({}, { email: 'hello+test1@mygplink.com.au' }), 2 * H).reason).toBe('test_lead');
    expect(dec(lead({}, { email: 'registration@mygplink.com.au' }), 2 * H).reason).toBe('test_lead');
    expect(dec(lead({}, { email: 'test@meta.com' }), 2 * H).reason).toBe('test_lead');
    expect(dec(lead({ no_show: undefined }), 2 * H).reason).toBe('no_marker');
    expect(ns.isTestLeadEmail('sarah@nhs.net')).toBe(false);
    expect(ns.isTestLeadEmail('')).toBe(false);
  });
});

describe('copy', () => {
  it('the email is the owner\'s voice, blames nobody, offers the link or a reply, and has no em dash', () => {
    const copy = ns.noShowEmailCopy({ displayName: 'Dr Patel', whenText: ns.slotInWords(SLOT, 'Europe/London') });
    expect(copy.subject).toBe('Sorry we missed each other');
    expect(copy.body).toContain('Hi Dr Patel,');
    expect(copy.body).toContain('for Thursday 12 November at 10:00 am');
    expect(copy.body).toContain('reply to this email with a time that suits you');
    expect(copy.body).toContain('Khaleed\nCEO, GP Link');
    expect(copy.ctaText).toBe('Pick a new time');
    expect(JSON.stringify(copy)).not.toMatch(/[—–]/);
    expect(copy.body.toLowerCase()).not.toMatch(/no.?show|failed to|did not attend|didn't attend/);
  });

  it('slotInWords renders the slot in the doctor\'s own zone', () => {
    expect(ns.slotInWords(SLOT, 'Europe/London')).toBe('Thursday 12 November at 10:00 am');
    expect(ns.slotInWords(SLOT, 'Australia/Sydney')).toBe('Thursday 12 November at 9:00 pm');
    expect(ns.slotInWords('garbage', 'Europe/London')).toBe('');
  });

  it('the WhatsApp template carries [first name, re-book link] and is skipped without a link', () => {
    expect(waLib.CONSULT_WA_TEMPLATES.call_missed).toEqual({ templateName: 'gp_link_consult_missed_call', language: 'en' });
    const msg = waLib.buildConsultWaMessage('call_missed', { name: 'Dr Sarah Patel', bookUrl: 'https://www.mygplink.com.au/start?lead=TOK1#book' });
    expect(msg.templateName).toBe('gp_link_consult_missed_call');
    expect(msg.placeholders.length).toBe(2);
    expect(msg.placeholders[1]).toBe('https://www.mygplink.com.au/start?lead=TOK1#book');
    expect(msg.placeholders[0]).toBe(waLib.buildConsultWaMessage('call_booked', { name: 'Dr Sarah Patel', callAtIso: SLOT }).placeholders[0]);
    expect(waLib.buildConsultWaMessage('call_missed', { name: 'Dr Sarah Patel' })).toBe(null);
  });
});

describe('Hazel rings once after a missed consultation', () => {
  // 12:30 London on the Thursday = 2.5 hours after the slot, inside calling hours.
  const NOW = SLOT_MS + 150 * M;
  const decide = (row, nowMs, cfg) => leadCallDecision({ row, nowMs: nowMs || NOW, cfg: cfg || CFG });

  it('a booked lead with no missed slot is still never rung', () => {
    expect(decide(lead({ no_show: undefined }))).toEqual({ action: 'skip', reason: 'already_booked' });
  });

  it('waits two hours from the slot, then rings, naming the missed slot', () => {
    const early = decide(lead(), SLOT_MS + 90 * M);
    expect(early.action).toBe('skip');
    expect(early.reason).toBe('missed_call_later');
    expect(early.due_at).toBe(new Date(SLOT_MS + 2 * H).toISOString());
    const d = decide(lead());
    expect(d.action).toBe('call');
    expect(d.missed_call_at).toBe(SLOT);
    expect(d.phone).toBe('+447700900123');
  });

  it('is consumed by the placement: after it, the lead reads already booked again', () => {
    const consumed = ns.consumeMissedCallRing(lead().metadata.consult, new Date(NOW).toISOString());
    expect(consumed.no_show.ring).toBe('placed');
    expect(consumed.no_show.ring_at).toBe(new Date(NOW).toISOString());
    expect(decide(lead({ no_show: consumed.no_show }))).toEqual({ action: 'skip', reason: 'already_booked' });
    // Nothing to consume ⇒ the consult object is returned untouched.
    const none = { call_booked: true };
    expect(ns.consumeMissedCallRing(none, 'x')).toBe(none);
  });

  it('waives the dialler\'s own pacing: a lead Hazel booked, twice tried, a week old', () => {
    const booked = { call_id: 'c1', status: 'ended', outcome: 'booked', attempt: 2, started_at: '2026-11-10T09:00:00.000Z', completed_at: '2026-11-10T09:04:00.000Z' };
    const row = lead({ ai_call: booked, ai_calls: [{ outcome: 'voicemail' }, { outcome: 'booked' }] }, { created_at: '2026-11-01T09:00:00.000Z' });
    expect(decide(row).action).toBe('call');
    // A past (Zoho) lead whose campaign has not been started is still owed it.
    const zoho = lead({}, { created_at: '2025-06-01T09:00:00.000Z', metadata: { source: 'zoho_import', consult: lead().metadata.consult } });
    expect(decide(zoho).action).toBe('call');
    // Someone who booked without ever being screened is rung too…
    expect(decide(lead({ qualified: false, not_screened: true })).action).toBe('call');
    // …an explicit turn-down is not.
    expect(decide(lead({ qualified: false, screened_out: true }))).toEqual({ action: 'skip', reason: 'not_qualified' });
  });

  it('never waives consent, a pause, a refusal Hazel heard, the number checks, test mode or calling hours', () => {
    expect(decide(lead({ stopped: 'do_not_call' })).reason).toBe('stopped_do_not_call');
    expect(decide(lead({ stopped: 'unsubscribed' })).reason).toBe('stopped_unsubscribed');
    expect(decide(lead({ stopped: 'not_interested' })).reason).toBe('stopped_not_interested');
    expect(decide(lead({ stopped: 'signed_up' })).reason).toBe('stopped_signed_up');
    expect(decide(lead({ calls_paused: true })).reason).toBe('paused');
    expect(decide(lead({}, { status: 'converted' })).reason).toBe('converted');
    const wrong = { call_id: 'c1', status: 'ended', outcome: 'wrong_number', attempt: 1, started_at: '2026-11-10T09:00:00.000Z', completed_at: '2026-11-10T09:01:00.000Z' };
    expect(decide(lead({ ai_call: wrong, ai_calls: [wrong] })).reason).toBe('outcome_wrong_number');
    expect(decide(lead({}, { phone: '' })).reason).toBe('no_phone');
    expect(decide(lead({}, { phone: '+1 415 555 0100' })).reason).toBe('dial_code_not_served');
    const pinned = parseLeadCallConfig({ LEAD_CALLS_ENABLED: 'true', RETELL_API_KEY: 'k', RETELL_AGENT_ID: 'a', RETELL_FROM_NUMBER_UK: '+442030000000', LEAD_CALLS_TEST_NUMBERS: '+447700900999' });
    expect(decide(lead(), NOW, pinned).reason).toBe('not_in_test_list');
    // 22:00 London on the Thursday: owed, but not at night.
    const night = decide(lead(), Date.parse('2026-11-12T22:00:00Z'));
    expect(night).toMatchObject({ action: 'skip', reason: 'outside_hours' });
    // A live call blocks it like everything else.
    const live = { call_id: 'c9', status: 'registered', attempt: 1, started_at: new Date(NOW - 2 * M).toISOString() };
    expect(decide(lead({ ai_call: live })).reason).toBe('call_in_progress');
  });

  it('lapses by itself: joined after all, re-booked, or three days gone', () => {
    expect(decide(lead({ call_attended: true }))).toEqual({ action: 'skip', reason: 'already_booked' });
    expect(decide(lead({ call_at: '2026-11-14T09:00:00.000Z' }))).toEqual({ action: 'skip', reason: 'already_booked' });
    expect(decide(lead(), SLOT_MS + 73 * H)).toEqual({ action: 'skip', reason: 'already_booked' });
    expect(ns.missedCallRing({ consult: lead().metadata.consult, nowMs: SLOT_MS + 73 * H })).toEqual({ state: 'none' });
  });

  it('a call-back the doctor asks for on that call is honoured, once', () => {
    const cbAt = new Date(NOW + 4 * H).toISOString(); // 16:30 London
    const asked = { call_id: 'c2', status: 'ended', outcome: 'callback_requested', callback_at: cbAt, attempt: 3, started_at: new Date(NOW).toISOString(), completed_at: new Date(NOW + 2 * M).toISOString() };
    const row = lead({ no_show: marker({ ring: 'placed', ring_at: new Date(NOW).toISOString() }), ai_call: asked });
    expect(decide(row, NOW + 1 * H).reason).toBe('callback_later');
    const due = decide(row, NOW + 4 * H + 5 * M);
    expect(due.action).toBe('call');
    expect(due.missed_call_at).toBeUndefined();
    // Once that call is placed ai_call is a new, outcome-less entry.
    const after = lead({ no_show: row.metadata.consult.no_show, ai_call: { call_id: 'c3', status: 'ended', outcome: 'voicemail', attempt: 4, started_at: cbAt, completed_at: cbAt } });
    expect(decide(after, NOW + 8 * H)).toEqual({ action: 'skip', reason: 'already_booked' });
  });

  it('the Leads tab says what is happening', () => {
    const waiting = leadCallPlan({ row: lead(), nowMs: SLOT_MS + 90 * M, cfg: CFG });
    expect(waiting.state).toBe('scheduled');
    expect(waiting.label).toContain('Missed the consultation');
    expect(waiting.due_at).toBe(new Date(SLOT_MS + 2 * H).toISOString());
    const queued = leadCallPlan({ row: lead(), nowMs: NOW, cfg: CFG });
    expect(queued.state).toBe('queued');
    expect(queued.label).toBe('Missed the consultation — rings within 5 minutes');
    const overnight = leadCallPlan({ row: lead(), nowMs: Date.parse('2026-11-12T22:00:00Z'), cfg: CFG });
    expect(overnight.label).toBe('Missed the consultation — rings in the next calling window');
    expect(overnight.due_at).toBe('2026-11-13T09:00:00.000Z');
  });
});

describe('what Hazel is told', () => {
  it('a fact and the purpose, never a line to say; empty when nothing applies', () => {
    const consult = lead().metadata.consult;
    const note = ns.missedCallNote({ consult, nowMs: SLOT_MS + 150 * M, tz: 'Europe/London', directorName: 'Khaleed' });
    expect(note).toBe('They had a consultation booked with Khaleed for Thursday 12 November at 10:00 am (their time) and did not join it. This call is to find a new time that suits them. They already know what GP Link is.');
    expect(note).not.toMatch(/[—–"]/);
    expect(ns.missedCallNote({ consult: { call_booked: true }, nowMs: SLOT_MS })).toBe('');
    expect(ns.missedCallNote({ consult: Object.assign({}, consult, { call_attended: true }), nowMs: SLOT_MS + 150 * M })).toBe('');
    expect(ns.missedCallNote({ consult, nowMs: SLOT_MS + 80 * H })).toBe('');
  });

  it('every call carries missed_call_note as a string (inbound calls from the doctor included)', () => {
    const v = buildLeadCallVariables({ row: lead(), nowMs: SLOT_MS + 150 * M, tz: 'Europe/London', country: 'uk', directorName: 'Khaleed' });
    expect(v.missed_call_note).toContain('did not join it');
    const plain = buildLeadCallVariables({ row: lead({ no_show: undefined, call_booked: false }), nowMs: SLOT_MS, tz: 'Europe/London', country: 'uk' });
    expect(plain.missed_call_note).toBe('');
    Object.values(v).forEach((x) => expect(typeof x).toBe('string'));
  });
});

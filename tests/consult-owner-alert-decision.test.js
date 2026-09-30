// Pure logic for paging the owner about an unbooked consult lead (owner rule
// 2026-09-30): "if a lead has not booked 20 minutes after the hourly WhatsApp,
// message me their name, lead answers and phone number". lib/consult-lead.js
// consultOwnerAlertDecision + consultOwnerAlertSummary; the cron wiring is
// covered in tests/consult-human-followups.test.js.
import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  consultOwnerAlertDecision,
  consultOwnerAlertSummary,
  CONSULT_OWNER_ALERT_WINDOW_MS,
  CONSULT_OWNER_ALERT_AFTER_STEP_MS,
} = require('../lib/consult-lead.js');

const t0 = Date.parse('2026-09-30T10:00:00Z');
const M = 60 * 1000;
const H = 60 * M;
const step1At = new Date(t0 + 62 * M).toISOString();
const live = {
  qualified: true, call_booked: false,
  nudges: [
    { seq: 'not_booked', step: 0, sent_at: new Date(t0 + 6 * M).toISOString() },
    { seq: 'not_booked', step: 1, sent_at: step1At },
  ],
};
const at = (consult, nowMs) => consultOwnerAlertDecision({ consult, createdAtMs: t0, nowMs });

describe('consultOwnerAlertDecision', () => {
  it('waits 20 minutes after the 1-hour note actually went, then pages once', () => {
    expect(CONSULT_OWNER_ALERT_AFTER_STEP_MS).toBe(20 * M);
    expect(at(live, t0 + 62 * M + 19 * M)).toEqual({ action: 'skip', reason: 'not_yet' });
    expect(at(live, t0 + 62 * M + 20 * M)).toEqual({ action: 'send', replied: false });
    expect(at({ ...live, owner_alert: { sent_at: 'x', via: 'whatsapp' } }, t0 + 3 * H)).toEqual({ action: 'skip', reason: 'already_sent' });
  });

  it('falls back to the scheduled hour when the 1-hour note never recorded', () => {
    const noStep1 = { qualified: true, call_booked: false, nudges: [] };
    expect(at(noStep1, t0 + 79 * M)).toEqual({ action: 'skip', reason: 'not_yet' });
    expect(at(noStep1, t0 + 80 * M)).toEqual({ action: 'send', replied: false });
  });

  it('a booking, a screen-out, an unqualified lead or any stop but "replied" silences it; a reply still pages', () => {
    const due = t0 + 2 * H;
    expect(at({ ...live, call_booked: true }, due)).toEqual({ action: 'skip', reason: 'booked' });
    expect(at({ ...live, qualified: false }, due)).toEqual({ action: 'skip', reason: 'not_qualified' });
    expect(at({ ...live, screened_out: true }, due)).toEqual({ action: 'skip', reason: 'not_qualified' });
    ['exhausted', 'unsubscribed', 'signed_up'].forEach((s) => {
      expect(at({ ...live, stopped: s }, due)).toEqual({ action: 'skip', reason: 'stopped' });
    });
    expect(at({ ...live, stopped: 'replied' }, due)).toEqual({ action: 'send', replied: true });
  });

  it('never pages about a lead older than the window, and refuses unreadable times', () => {
    expect(at(live, t0 + CONSULT_OWNER_ALERT_WINDOW_MS + M)).toEqual({ action: 'skip', reason: 'too_old' });
    expect(consultOwnerAlertDecision({ consult: live, createdAtMs: NaN, nowMs: t0 })).toEqual({ action: 'skip', reason: 'bad_input' });
  });
});

describe('consultOwnerAlertSummary', () => {
  const row = {
    name: 'Aisha  Khan', phone: '+44 7700 900123', email: 'aisha@example.co.uk',
    message: 'Is my\nMRCGP enough?', created_at: new Date(t0).toISOString(),
    metadata: { consult: { ...live, is_gp: true, country: 'uk', country_raw: 'united_kingdom' } },
  };

  it('gives four single-line strings — name, phone, what they answered, status', () => {
    const s = consultOwnerAlertSummary(row, { nowMs: t0 + 82 * M });
    expect(s.name).toBe('Aisha Khan');
    expect(s.phone).toBe('+44 7700 900123');
    expect(s.answers).toBe('Country: united_kingdom · Registered GP: yes · They asked: Is my MRCGP enough? · Email: aisha@example.co.uk');
    expect(s.status).toBe('No booking 1h 22m after the form, and no reply yet');
    expect(Object.values(s).some((v) => /[\r\n\t]/.test(v))).toBe(false);
  });

  it('says so when the doctor replied, and never produces an empty slot', () => {
    const replied = consultOwnerAlertSummary({ ...row, metadata: { consult: { ...live, stopped: 'replied' } } }, { nowMs: t0 + 90 * M });
    expect(replied.status).toBe('No booking 1h 30m after the form, but they replied on WhatsApp — pick up the chat');
    const bare = consultOwnerAlertSummary({ metadata: { consult: {} } }, { nowMs: t0 });
    expect(bare).toEqual({ name: 'Unknown name', phone: 'no phone on the lead', answers: 'no answers recorded', status: 'No booking a while after the form, and no reply yet' });
    // A country code alone (no raw answer stored) is still reported.
    const coded = consultOwnerAlertSummary({ metadata: { consult: { country: 'ie' } } }, { nowMs: t0 });
    expect(coded.answers).toBe('Country: IE');
  });
});

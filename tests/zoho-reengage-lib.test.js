// Unit tests for lib/zoho-reengage.js: who gets the WhatsApp re-engagement, how a
// reply is read, and what a "yes" turns into. Pure functions, no server boot.
import { describe, it, expect } from 'vitest';
import zr from '../lib/zoho-reengage.js';
import { buildLeadCallVariables } from '../lib/lead-calls.js';
import { screenConsultLead } from '../lib/consult-lead.js';

describe('ukMobileE164', () => {
  it('normalises every way a UK mobile has been stored', () => {
    for (const p of ['07700 900123', '+44 7700 900123', '447700900123', '0044 7700900123', '+44 07700900123', '+44 +447700900123', '(07700) 900-123']) {
      expect(zr.ukMobileE164(p)).toBe('+447700900123');
    }
  });
  it('rejects landlines, other countries and junk', () => {
    for (const p of ['+44 20 7946 0958', '01onal', '+61 406 281 243', '+353 87 123 4567', '', null, '7700900123', '+4477009001234']) {
      expect(zr.ukMobileE164(p)).toBe('');
    }
  });
});

describe('pickReengageBatch', () => {
  const rows = [
    { id: 'a', name: 'Dr Amy Jones', email: 'amy@x.com', phone: '07700 900001', unsubscribed: false, created_at: '2025-01-01T00:00:00Z' },
    { id: 'b', name: 'Ben Smith', email: 'ben@x.com', phone: '+447700900002', unsubscribed: false, created_at: '2026-03-01T00:00:00Z' },
    { id: 'c', name: 'Cara', email: 'cara@x.com', phone: '+447700900003', unsubscribed: true, created_at: '2026-02-01T00:00:00Z' },
    { id: 'd', name: 'Dan', email: 'dan@x.com', phone: '', unsubscribed: false, created_at: '2026-02-02T00:00:00Z' },
    { id: 'e', name: 'Eve', email: 'eve@x.com', phone: '+61 406 000 000', unsubscribed: false, created_at: '2026-02-03T00:00:00Z' },
    { id: 'f', name: 'Fay', email: 'fay@x.com', phone: '447700900002', unsubscribed: false, created_at: '2025-06-01T00:00:00Z' },
    { id: 'g', name: 'Gus', email: 'gus@x.com', phone: '+447700900007', unsubscribed: false, created_at: '2026-01-01T00:00:00Z' }
  ];
  it('keeps UK mobiles, newest first, one per number, never the unsubscribed or the already messaged', () => {
    const r = zr.pickReengageBatch(rows, { sentIds: ['g'], sentPhones: [] });
    expect(r.batch.map((c) => c.id)).toEqual(['b', 'a']);
    expect(r.counts).toEqual({ scanned: 7, unsubscribed: 1, no_phone: 1, not_uk_mobile: 1, already_sent: 1, duplicate_phone: 1, eligible: 2 });
    expect(r.batch[0]).toMatchObject({ phone: '+447700900002', first_name: 'Ben', email: 'ben@x.com' });
    expect(r.batch[1].first_name).toBe('Amy');
  });
  it('also treats a number already messaged under another row as sent, and honours the limit', () => {
    const r = zr.pickReengageBatch(rows, { sentPhones: ['+44 7700 900002'], limit: 1 });
    expect(r.counts.already_sent).toBe(2);
    expect(r.eligible_total).toBe(2);           // g (2026-01) then a (2025-01)
    expect(r.batch.map((c) => c.id)).toEqual(['g']);
  });
});

describe('classifyReengageReply', () => {
  it('reads the two quick replies and typed variants', () => {
    expect(zr.classifyReengageReply('Yes, call me')).toBe('yes');
    expect(zr.classifyReengageReply('yes please')).toBe('yes');
    expect(zr.classifyReengageReply('Ok sure')).toBe('yes');
    expect(zr.classifyReengageReply('Not right now')).toBe('no');
    expect(zr.classifyReengageReply('No thanks, already moved')).toBe('no');
    expect(zr.classifyReengageReply('not interested anymore')).toBe('no');
    expect(zr.classifyReengageReply('STOP')).toBe('stop');
    expect(zr.classifyReengageReply('please unsubscribe me')).toBe('stop');
    expect(zr.classifyReengageReply('Remove me from your list')).toBe('stop');
  });
  it('sends questions and anything unclear to a human', () => {
    expect(zr.classifyReengageReply('Who is this?')).toBe('other');
    expect(zr.classifyReengageReply('How long does registration take?')).toBe('other');
    expect(zr.classifyReengageReply('')).toBe('other');
    expect(zr.classifyReengageReply('Nottingham is where I am based, can you call?')).toBe('other');
  });
});

describe('buttonReplyText', () => {
  it('reads the button title out of the shapes a quick-reply tap arrives as', () => {
    expect(zr.buttonReplyText({ type: 'BUTTON', button: { text: 'Yes, call me', payload: 'Yes, call me' } })).toBe('Yes, call me');
    expect(zr.buttonReplyText({ type: 'INTERACTIVE', interactive: { type: 'button_reply', button_reply: { id: 'x', title: 'Not right now' } } })).toBe('Not right now');
    expect(zr.buttonReplyText({ type: 'BUTTON', buttonText: ' Yes, call me ' })).toBe('Yes, call me');
    expect(zr.buttonReplyText({ type: 'BUTTON', payload: 'Not right now' })).toBe('Not right now');
    expect(zr.buttonReplyText({ type: 'IMAGE', url: 'https://x' })).toBe(null);
    expect(zr.buttonReplyText(null)).toBe(null);
  });
});

describe('leadInput and replyText', () => {
  const cand = { id: 'c1', name: 'Dr Priya Patel', email: 'Priya@Example.com', phone: '07700 900123' };
  it('builds a lead the screen accepts without the GP question', () => {
    const input = zr.leadInput(cand, 'Yes, call me');
    expect(input).toMatchObject({ name: 'Dr Priya Patel', email: 'priya@example.com', phone: '+447700900123', isGp: null, country: 'uk', countryRecognised: true, source: 'zoho_reengagement' });
    expect(input.question).toContain('Replied "Yes, call me"');
    expect(screenConsultLead(input)).toBe(true);
  });
  it('tells the dialler the lead came from our WhatsApp message', () => {
    const vars = buildLeadCallVariables({ row: { name: 'Priya Patel', email: 'p@x.com', phone: '+447700900123', created_at: new Date().toISOString(), metadata: { source: 'zoho_reengagement', consult: { country: 'uk' } } } });
    expect(vars.enquiry_source).toBe('our WhatsApp message');
    const fb = buildLeadCallVariables({ row: { name: 'A', created_at: new Date().toISOString(), metadata: { source: 'meta_lead_ad', consult: { country: 'uk' } } } });
    expect(fb.enquiry_source).toBe('a Facebook ad');
  });
  it('writes the two auto replies', () => {
    const yes = zr.replyText('yes', { first: 'Priya', fromNumber: '+447862121872', bookUrl: 'https://app.mygplink.com.au/start?lead=t#book' });
    expect(yes).toContain('Hayley from GP Link will ring you from +447862121872');
    expect(yes).toContain('https://app.mygplink.com.au/start?lead=t#book');
    expect(zr.replyText('no', { first: 'Priya' })).toContain('No problem at all, Priya');
    expect(zr.replyText('stop', {})).toBe('');
  });
});

describe('isSendWindow', () => {
  it('is UK weekday daytime only', () => {
    expect(zr.isSendWindow(Date.parse('2026-11-02T10:30:00Z'))).toBe(true);   // Mon 10:30 GMT
    expect(zr.isSendWindow(Date.parse('2026-11-02T17:30:00Z'))).toBe(false);  // Mon 17:30 GMT
    expect(zr.isSendWindow(Date.parse('2026-11-01T11:00:00Z'))).toBe(false);  // Sun
    expect(zr.isSendWindow(Date.parse('2026-07-06T08:30:00Z'))).toBe(true);   // Mon 09:30 BST
  });
});

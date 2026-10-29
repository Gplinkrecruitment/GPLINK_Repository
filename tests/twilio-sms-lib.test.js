// Unit tests for lib/twilio-sms.js: Twilio's webhook signature, form parsing,
// the auto-reply and the forwarded email. Pure functions, no server boot.
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import sms from '../lib/twilio-sms.js';

const TOKEN = 'test-auth-token-0123456789';
const URL = 'https://app.mygplink.com.au/api/webhooks/twilio-sms';

function sign(url, params, token) {
  const keys = Object.keys(params).sort();
  let data = url;
  for (const k of keys) data += k + params[k];
  return crypto.createHmac('sha1', token).update(data, 'utf8').digest('base64');
}

describe('verifyTwilioSignature', () => {
  const params = { From: '+447700900123', To: '+447476996057', Body: 'Who is this?', MessageSid: 'SM123' };

  it('accepts the signature Twilio would send', () => {
    expect(sms.verifyTwilioSignature(URL, params, sign(URL, params, TOKEN), TOKEN)).toBe(true);
  });

  it('rejects a wrong token, a changed body, a changed url, and a missing header', () => {
    const good = sign(URL, params, TOKEN);
    expect(sms.verifyTwilioSignature(URL, params, good, 'other-token')).toBe(false);
    expect(sms.verifyTwilioSignature(URL, { ...params, Body: 'Who is this?!' }, good, TOKEN)).toBe(false);
    expect(sms.verifyTwilioSignature(URL + '?x=1', params, good, TOKEN)).toBe(false);
    expect(sms.verifyTwilioSignature(URL, params, '', TOKEN)).toBe(false);
    expect(sms.verifyTwilioSignature(URL, params, good, '')).toBe(false);
  });

  it('includes the query string in the signed url', () => {
    const url = URL + '?secret=abc';
    expect(sms.verifyTwilioSignature(url, params, sign(url, params, TOKEN), TOKEN)).toBe(true);
  });
});

describe('parseFormBody and publicUrl', () => {
  it('decodes urlencoded fields including spaces and plus signs', () => {
    const p = sms.parseFormBody(Buffer.from('From=%2B447700900123&Body=Call+me+after+6%21&NumMedia=0'));
    expect(p.From).toBe('+447700900123');
    expect(p.Body).toBe('Call me after 6!');
    expect(p.NumMedia).toBe('0');
  });

  it('builds the public url from the app base, never the host header', () => {
    expect(sms.publicUrl('https://app.mygplink.com.au/', '/api/webhooks/twilio-sms?secret=1')).toBe('https://app.mygplink.com.au/api/webhooks/twilio-sms?secret=1');
    expect(sms.publicUrl('https://app.mygplink.com.au', 'api/webhooks/twilio-sms')).toBe('https://app.mygplink.com.au/api/webhooks/twilio-sms');
  });
});

describe('auto reply and TwiML', () => {
  it('points the sender to WhatsApp and email', () => {
    const t = sms.autoReplyText({ whatsapp: '+61494391968', email: 'hello@mygplink.com.au' });
    expect(t).toContain('WhatsApp at +61494391968');
    expect(t).toContain('email hello@mygplink.com.au');
    expect(t.length).toBeLessThan(320);
  });

  it('escapes the message in TwiML and allows an empty response', () => {
    expect(sms.twiml('A & B <c>')).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Message>A &amp; B &lt;c&gt;</Message></Response>');
    expect(sms.twiml('')).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it('recognises opt-out keywords', () => {
    expect(sms.isOptOut('STOP')).toBe(true);
    expect(sms.isOptOut(' unsubscribe please')).toBe(true);
    expect(sms.isOptOut('Stop calling after 6pm though, call me at 7')).toBe(true);
    expect(sms.isOptOut('Who is this?')).toBe(false);
  });
});

describe('forwardEmail', () => {
  it('summarises the text for the owner', () => {
    const e = sms.forwardEmail({ from: '+447700900123', to: '+447476996057', body: 'Who is this?', messageSid: 'SM1', numMedia: '1', receivedAt: new Date('2026-10-30T09:00:00Z') });
    expect(e.subject).toBe("Text to Hazel's number from +447700900123");
    expect(e.bodyText).toContain('Message: Who is this?');
    expect(e.bodyText).toContain('Attachments: 1');
    expect(e.bodyText).toContain('2026-10-30T09:00:00.000Z');
  });
});

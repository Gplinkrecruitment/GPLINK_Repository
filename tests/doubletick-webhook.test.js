/**
 * Unit tests for DoubleTick webhook security helpers.
 *
 * Inline copies of the three helpers from server.js are used here so the
 * tests are fast and have no server startup dependency.  Keep the copies in
 * sync with the implementations in server.js whenever you change them there.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Inline copies of security helpers (keep in sync with server.js)
// ---------------------------------------------------------------------------

const TEST_SECRET = 'test-webhook-secret-minimum-32chars!';
const DOUBLETICK_CONVERSATION_URL_PREFIX = 'https://app.doubletick.io/';
const DOUBLETICK_MESSAGE_BODY_MAX_LEN = 4096;

function validateDoubleTickSignature(rawBody, signatureHeader, secret = TEST_SECRET) {
  if (!secret) return false;
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  try {
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const incoming = signatureHeader.replace(/^sha256=/, '');
    const incomingBuf = Buffer.from(incoming, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (incomingBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(incomingBuf, expectedBuf);
  } catch {
    return false;
  }
}

function sanitizeDoubleTickPayload(body) {
  if (!body || typeof body !== 'object') return null;

  // Extract message text: DoubleTick nests it under message.text (TEXT) or message.caption (media)
  const msg = body.message && typeof body.message === 'object' ? body.message : null;
  const rawMessageBody = msg
    ? (typeof msg.text === 'string' ? msg.text : (typeof msg.caption === 'string' ? msg.caption : null))
    : null;
  const messageBody = typeof rawMessageBody === 'string'
    ? rawMessageBody.slice(0, DOUBLETICK_MESSAGE_BODY_MAX_LEN)
    : null;

  // Phone: DoubleTick uses "from"
  const rawPhone = typeof body.from === 'string' ? body.from : null;
  const fromPhone = typeof rawPhone === 'string'
    ? rawPhone.replace(/[^\d+\-() ]/g, '').slice(0, 30)
    : null;

  // Contact name from DoubleTick's contact object
  const contactName = (body.contact && typeof body.contact.name === 'string')
    ? body.contact.name.replace(/[<>]/g, '').slice(0, 200)
    : null;

  // Allow-list: conversation URL must start with the DoubleTick app origin (not sent by default)
  const rawUrl = typeof body.conversation_url === 'string' ? body.conversation_url.trim() : '';
  const conversationUrl = rawUrl.startsWith(DOUBLETICK_CONVERSATION_URL_PREFIX) ? rawUrl : null;

  // Idempotency key: DoubleTick uses "messageId" or "dtMessageId"
  const rawMsgId = typeof body.dtMessageId === 'string'
    ? body.dtMessageId
    : (typeof body.messageId === 'string' ? body.messageId : null);
  const messageId = typeof rawMsgId === 'string'
    ? rawMsgId.replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 128)
    : null;

  if (!fromPhone || !messageBody) return null;
  return { messageBody, fromPhone, contactName, conversationUrl, messageId };
}

function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('0') && digits.length === 10) return '+61' + digits.slice(1);
  if (digits.length >= 10 && digits.length <= 15) return '+' + digits;
  return digits;
}

// ---------------------------------------------------------------------------
// Inline copy of classifyDoubleTickMessage (keyword-only path for unit tests)
// The AI fallback is tested via integration tests; here we verify keyword matching.
// ---------------------------------------------------------------------------

function classifyDoubleTickMessageKeywords(messageBody) {
  const HELP_PATTERNS = [/\bhelp\b/i, /\bneed help\b/i, /\bassist\b/i, /\bsupport\b/i, /\bstuck\b/i, /\bproblem\b/i, /\bissue\b/i, /\bquestion\b/i];
  return HELP_PATTERNS.some((p) => p.test(messageBody));
}

// ---------------------------------------------------------------------------

const SAMPLE_BODY = Buffer.from('{"from":"+61400000001","message":{"type":"TEXT","text":"I need help"}}');

function signBody(body, secret = TEST_SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// ── validateDoubleTickSignature ─────────────────────────────────────────────

describe('validateDoubleTickSignature', () => {
  it('accepts a valid sha256= prefixed signature', () => {
    expect(validateDoubleTickSignature(SAMPLE_BODY, signBody(SAMPLE_BODY))).toBe(true);
  });

  it('accepts a valid plain-hex signature (no sha256= prefix)', () => {
    const plainHex = crypto.createHmac('sha256', TEST_SECRET).update(SAMPLE_BODY).digest('hex');
    expect(validateDoubleTickSignature(SAMPLE_BODY, plainHex)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = signBody(SAMPLE_BODY);
    const tampered = Buffer.from('{"from":"+61400000001","message":{"type":"TEXT","text":"injected payload"}}');
    expect(validateDoubleTickSignature(tampered, sig)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const sig = signBody(SAMPLE_BODY, 'wrong-secret');
    expect(validateDoubleTickSignature(SAMPLE_BODY, sig)).toBe(false);
  });

  it('rejects empty signature string', () => {
    expect(validateDoubleTickSignature(SAMPLE_BODY, '')).toBe(false);
  });

  it('rejects null/undefined signature', () => {
    expect(validateDoubleTickSignature(SAMPLE_BODY, null)).toBe(false);
    expect(validateDoubleTickSignature(SAMPLE_BODY, undefined)).toBe(false);
  });

  it('rejects when secret is absent (returns false, not throw)', () => {
    expect(validateDoubleTickSignature(SAMPLE_BODY, signBody(SAMPLE_BODY), '')).toBe(false);
  });

  it('uses timingSafeEqual — flipping one hex digit is rejected', () => {
    const valid = crypto.createHmac('sha256', TEST_SECRET).update(SAMPLE_BODY).digest('hex');
    const flipped = valid.slice(0, -1) + (valid.endsWith('0') ? '1' : '0');
    expect(validateDoubleTickSignature(SAMPLE_BODY, flipped)).toBe(false);
  });
});

// ── sanitizeDoubleTickPayload (DoubleTick actual format) ────────────────────

describe('sanitizeDoubleTickPayload', () => {
  it('accepts a complete DoubleTick TEXT message payload', () => {
    const result = sanitizeDoubleTickPayload({
      from: '+61400000001',
      messageId: 'HBgMOTE3NjAwNzI4MjU0',
      dtMessageId: '3bf23c11-6c34-4c1e-b259-12a0e518d3cd',
      contact: { name: 'Dr Smith' },
      message: { type: 'TEXT', text: 'I need help please' }
    });
    expect(result).not.toBeNull();
    expect(result.fromPhone).toBe('+61400000001');
    expect(result.messageBody).toBe('I need help please');
    expect(result.contactName).toBe('Dr Smith');
    expect(result.messageId).toBe('3bf23c11-6c34-4c1e-b259-12a0e518d3cd');
  });

  it('extracts caption from media messages (IMAGE, DOCUMENT, etc.)', () => {
    const result = sanitizeDoubleTickPayload({
      from: '+61400000001',
      messageId: 'msg-001',
      message: { type: 'IMAGE', caption: 'Is this the right document?', url: 'https://example.com/img.jpg' }
    });
    expect(result).not.toBeNull();
    expect(result.messageBody).toBe('Is this the right document?');
  });

  it('prefers dtMessageId over messageId for idempotency', () => {
    const result = sanitizeDoubleTickPayload({
      from: '+61400000001',
      messageId: 'whatsapp-id-abc',
      dtMessageId: 'dt-uuid-preferred',
      message: { type: 'TEXT', text: 'help' }
    });
    expect(result.messageId).toBe('dt-uuid-preferred');
  });

  it('falls back to messageId when dtMessageId is absent', () => {
    const result = sanitizeDoubleTickPayload({
      from: '+61400000001',
      messageId: 'whatsapp-id-only',
      message: { type: 'TEXT', text: 'help' }
    });
    expect(result.messageId).toBe('whatsapp-id-only');
  });

  it('returns null when from is missing', () => {
    expect(sanitizeDoubleTickPayload({
      message: { type: 'TEXT', text: 'help' }
    })).toBeNull();
  });

  it('returns null when message is missing', () => {
    expect(sanitizeDoubleTickPayload({ from: '+61400000001' })).toBeNull();
  });

  it('returns null when message.text is missing (e.g. status update)', () => {
    expect(sanitizeDoubleTickPayload({
      from: '+61400000001',
      message: { type: 'LOCATION', latitude: '-33.8', longitude: '151.2' }
    })).toBeNull();
  });

  it('caps message text at 4096 characters', () => {
    const longBody = 'a'.repeat(5000);
    const result = sanitizeDoubleTickPayload({
      from: '+61400000001',
      message: { type: 'TEXT', text: longBody }
    });
    expect(result).not.toBeNull();
    expect(result.messageBody.length).toBe(4096);
  });

  it('strips script tags from contact name', () => {
    const result = sanitizeDoubleTickPayload({
      from: '+61400000001',
      contact: { name: '<script>alert(1)</script>Dr Evil' },
      message: { type: 'TEXT', text: 'help' }
    });
    expect(result.contactName).not.toContain('<');
    expect(result.contactName).not.toContain('>');
  });

  it('rejects conversation_url not on https://app.doubletick.io/', () => {
    const result = sanitizeDoubleTickPayload({
      from: '+61400000001',
      message: { type: 'TEXT', text: 'help' },
      conversation_url: 'https://evil.example.com/redirect'
    });
    expect(result).not.toBeNull();
    expect(result.conversationUrl).toBeNull();
  });

  it('strips special characters from messageId', () => {
    const result = sanitizeDoubleTickPayload({
      from: '+61400000001',
      message: { type: 'TEXT', text: 'help' },
      messageId: 'msg<script>alert(1)</script>'
    });
    expect(result).not.toBeNull();
    expect(result.messageId).not.toContain('<');
    expect(result.messageId).not.toContain('>');
  });

  it('handles null and non-object body gracefully', () => {
    expect(sanitizeDoubleTickPayload(null)).toBeNull();
    expect(sanitizeDoubleTickPayload('string')).toBeNull();
    expect(sanitizeDoubleTickPayload(42)).toBeNull();
    expect(sanitizeDoubleTickPayload(undefined)).toBeNull();
  });
});

// ── normalizePhone ──────────────────────────────────────────────────────────

describe('normalizePhone', () => {
  it('preserves an already-E.164 number unchanged', () => {
    expect(normalizePhone('+61400000001')).toBe('+61400000001');
  });

  it('converts Australian 04xx local format to E.164', () => {
    expect(normalizePhone('0400000001')).toBe('+61400000001');
  });

  it('prepends + to bare international digit string', () => {
    expect(normalizePhone('61400000001')).toBe('+61400000001');
  });

  it('returns empty string for null input', () => {
    expect(normalizePhone(null)).toBe('');
  });

  it('returns empty string for empty string input', () => {
    expect(normalizePhone('')).toBe('');
  });
});

// ── classifyDoubleTickMessage (keyword path) ────────────────────────────────

describe('classifyDoubleTickMessageKeywords', () => {
  it('matches explicit help keywords', () => {
    expect(classifyDoubleTickMessageKeywords('I need help with my application')).toBe(true);
    expect(classifyDoubleTickMessageKeywords('Can you assist me?')).toBe(true);
    expect(classifyDoubleTickMessageKeywords('I have a problem')).toBe(true);
    expect(classifyDoubleTickMessageKeywords('I have a question about AMC')).toBe(true);
    expect(classifyDoubleTickMessageKeywords('There is an issue with my documents')).toBe(true);
    expect(classifyDoubleTickMessageKeywords('I am stuck on this step')).toBe(true);
    expect(classifyDoubleTickMessageKeywords('contact support please')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(classifyDoubleTickMessageKeywords('HELP ME PLEASE')).toBe(true);
    expect(classifyDoubleTickMessageKeywords('I Have A Question')).toBe(true);
  });

  it('rejects messages without help keywords (these go to AI)', () => {
    expect(classifyDoubleTickMessageKeywords('Thanks for the update')).toBe(false);
    expect(classifyDoubleTickMessageKeywords('ok sounds good')).toBe(false);
    expect(classifyDoubleTickMessageKeywords('I uploaded the document')).toBe(false);
  });
});

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
  const messageBody = typeof body.message_body === 'string'
    ? body.message_body.slice(0, DOUBLETICK_MESSAGE_BODY_MAX_LEN)
    : null;
  const fromPhone = typeof body.from_phone === 'string'
    ? body.from_phone.replace(/[^\d+\-() ]/g, '').slice(0, 30)
    : null;
  const rawUrl = typeof body.conversation_url === 'string' ? body.conversation_url.trim() : '';
  const conversationUrl = rawUrl.startsWith(DOUBLETICK_CONVERSATION_URL_PREFIX) ? rawUrl : null;
  const messageId = typeof body.message_id === 'string'
    ? body.message_id.replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 128)
    : null;
  if (!fromPhone || !messageBody) return null;
  return { messageBody, fromPhone, conversationUrl, messageId };
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

const SAMPLE_BODY = Buffer.from('{"from_phone":"+61400000001","message_body":"I need help"}');

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
    const tampered = Buffer.from('{"from_phone":"+61400000001","message_body":"injected payload"}');
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

// ── sanitizeDoubleTickPayload ───────────────────────────────────────────────

describe('sanitizeDoubleTickPayload', () => {
  it('accepts a complete valid payload', () => {
    const result = sanitizeDoubleTickPayload({
      from_phone: '+61400000001',
      message_body: 'I need help please',
      conversation_url: 'https://app.doubletick.io/conversations/abc-123',
      message_id: 'msg-abc-123'
    });
    expect(result).not.toBeNull();
    expect(result.fromPhone).toBe('+61400000001');
    expect(result.messageBody).toBe('I need help please');
    expect(result.conversationUrl).toBe('https://app.doubletick.io/conversations/abc-123');
    expect(result.messageId).toBe('msg-abc-123');
  });

  it('returns null when from_phone is missing', () => {
    expect(sanitizeDoubleTickPayload({ message_body: 'help' })).toBeNull();
  });

  it('returns null when message_body is missing', () => {
    expect(sanitizeDoubleTickPayload({ from_phone: '+61400000001' })).toBeNull();
  });

  it('caps message_body at 4096 characters', () => {
    const longBody = 'a'.repeat(5000);
    const result = sanitizeDoubleTickPayload({ from_phone: '+61400000001', message_body: longBody });
    expect(result).not.toBeNull();
    expect(result.messageBody.length).toBe(4096);
  });

  it('rejects conversation_url not on https://app.doubletick.io/', () => {
    const result = sanitizeDoubleTickPayload({
      from_phone: '+61400000001',
      message_body: 'help',
      conversation_url: 'https://evil.example.com/redirect'
    });
    expect(result).not.toBeNull();
    expect(result.conversationUrl).toBeNull();
  });

  it('rejects javascript: conversation_url (protocol injection)', () => {
    const result = sanitizeDoubleTickPayload({
      from_phone: '+61400000001',
      message_body: 'help',
      conversation_url: 'javascript:alert(1)'
    });
    expect(result).not.toBeNull();
    expect(result.conversationUrl).toBeNull();
  });

  it('strips special characters from message_id', () => {
    const result = sanitizeDoubleTickPayload({
      from_phone: '+61400000001',
      message_body: 'help',
      message_id: 'msg<script>alert(1)</script>'
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

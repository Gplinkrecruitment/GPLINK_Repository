// Phase 6 C1 — lib/totp.js unit tests.
// Verified against the RFC 6238 Appendix B test vectors (SHA1 mode): the
// standard 20-byte ASCII secret "12345678901234567890" produces the published
// 8-digit codes at the published times; the 6-digit code is the same dynamic
// truncation mod 10^6 (i.e. the last 6 digits of the 8-digit vector).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const totp = require('../lib/totp.js');

const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_B32 = totp.base32Encode(Buffer.from(RFC_SECRET_ASCII, 'utf8'));

// [unix time seconds, 8-digit RFC 6238 SHA1 TOTP]
const RFC_VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130']
];

describe('base32', () => {
  it('encodes the RFC secret to the canonical base32 form', () => {
    expect(RFC_SECRET_B32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });
  it('round-trips arbitrary bytes', () => {
    for (const len of [1, 5, 10, 16, 20, 32]) {
      const buf = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37 + len) % 256));
      expect(totp.base32Decode(totp.base32Encode(buf)).equals(buf)).toBe(true);
    }
  });
  it('tolerates lowercase, spaces and dashes on decode', () => {
    const decoded = totp.base32Decode('gezd gnbv-gy3t qojq GEZD GNBV GY3T QOJQ');
    expect(decoded.toString('utf8')).toBe(RFC_SECRET_ASCII);
  });
  it('throws on invalid characters', () => {
    expect(() => totp.base32Decode('ABC1!')).toThrow();
  });
});

describe('RFC 6238 test vectors (SHA1)', () => {
  for (const [seconds, code8] of RFC_VECTORS) {
    it(`T=${seconds} → ${code8}`, () => {
      expect(totp.generateTotp(RFC_SECRET_B32, { time: seconds * 1000, digits: 8 })).toBe(code8);
      // 6-digit mode is the same truncation mod 10^6
      expect(totp.generateTotp(RFC_SECRET_B32, { time: seconds * 1000 })).toBe(code8.slice(-6));
    });
  }
});

describe('verifyTotp', () => {
  const secret = totp.generateSecret();
  const T = 1_700_000_000_000; // fixed reference time

  it('generateSecret returns a base32 string of the expected size (20 bytes → 32 chars)', () => {
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(totp.base32Decode(secret).length).toBe(20);
  });

  it('accepts the code for the current step', () => {
    const code = totp.generateTotp(secret, { time: T });
    expect(totp.verifyTotp(secret, code, { time: T })).toBe(true);
  });

  it('accepts codes one step behind and ahead (window 1 — clock drift)', () => {
    const prev = totp.generateTotp(secret, { time: T - 30_000 });
    const next = totp.generateTotp(secret, { time: T + 30_000 });
    expect(totp.verifyTotp(secret, prev, { time: T, window: 1 })).toBe(true);
    expect(totp.verifyTotp(secret, next, { time: T, window: 1 })).toBe(true);
  });

  it('rejects a code two steps away with window 1', () => {
    const stale = totp.generateTotp(secret, { time: T - 60_000 });
    const current = totp.generateTotp(secret, { time: T });
    // In the rare case the two codes collide, the assertion below would be
    // vacuous — regenerate deterministically far away instead of flaking.
    if (stale !== current) {
      expect(totp.verifyTotp(secret, stale, { time: T, window: 1 })).toBe(false);
    }
    expect(totp.verifyTotp(secret, stale, { time: T, window: 2 })).toBe(true);
  });

  it('rejects wrong codes, malformed input and empty secrets', () => {
    const code = totp.generateTotp(secret, { time: T });
    const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
    expect(totp.verifyTotp(secret, wrong, { time: T })).toBe(false);
    expect(totp.verifyTotp(secret, '', { time: T })).toBe(false);
    expect(totp.verifyTotp(secret, 'abcdef', { time: T })).toBe(false);
    expect(totp.verifyTotp(secret, '12345', { time: T })).toBe(false);
    expect(totp.verifyTotp('', code, { time: T })).toBe(false);
    expect(totp.verifyTotp('!!notbase32!!', code, { time: T })).toBe(false);
  });

  it('ignores whitespace in the submitted token ("123 456" style)', () => {
    const code = totp.generateTotp(secret, { time: T });
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(totp.verifyTotp(secret, spaced, { time: T })).toBe(true);
  });
});

describe('totpUri', () => {
  it('builds a scannable otpauth URI with issuer + label', () => {
    const uri = totp.totpUri({ secret: 'ABC234DEF567', label: 'ceo@mygplink.com.au', issuer: 'GP Link Admin' });
    expect(uri).toBe(
      'otpauth://totp/GP%20Link%20Admin%3Aceo%40mygplink.com.au?secret=ABC234DEF567&algorithm=SHA1&digits=6&period=30&issuer=GP%20Link%20Admin'
    );
  });
});

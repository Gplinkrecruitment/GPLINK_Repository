import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// The REAL normalizePhone from server.js (tests/doubletick-webhook.test.js pins
// a private copy). Prod GPs never got a WhatsApp because of shapes the signup
// form stores: "+44 07734408785" (trunk 0 kept) and "+44 +447581364436"
// (dial code glued onto a number that already had it).
const require = createRequire(import.meta.url);
const { normalizePhone } = require('../server.js').__testUtils;

describe('normalizePhone (server.js)', () => {
  it('drops the UK/IE/NZ/AU trunk 0 after the country code', () => {
    expect(normalizePhone('+44 07734408785')).toBe('+447734408785');
    expect(normalizePhone('+353 0871234567')).toBe('+353871234567');
    expect(normalizePhone('+64 0211234567')).toBe('+64211234567');
    expect(normalizePhone('4407734408785')).toBe('+447734408785');
  });
  it('keeps the last full number when the dial code was prefixed twice', () => {
    expect(normalizePhone('+44 +447581364436')).toBe('+447581364436');
  });
  it('leaves correct numbers and Australian local format alone', () => {
    expect(normalizePhone('+44 7756134905')).toBe('+447756134905');
    expect(normalizePhone('+61400000001')).toBe('+61400000001');
    expect(normalizePhone('0400000001')).toBe('+61400000001');
    expect(normalizePhone('61400000001')).toBe('+61400000001');
    expect(normalizePhone('+39 06 1234 5678')).toBe('+390612345678'); // Italy keeps its 0
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(null)).toBe('');
  });
});

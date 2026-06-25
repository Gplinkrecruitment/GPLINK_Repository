import { describe, it, expect } from 'vitest';
import {
  normalizeIchcReference, isValidIchcReference, sha256Hex,
  isExampleIchcReference, isExampleIchcFile,
  EXAMPLE_ICHC_REFERENCES, EXAMPLE_ICHC_FILE_SHA256,
} from '../lib/ichc-verify.js';

describe('normalizeIchcReference', () => {
  it('extracts and canonicalises a reference from messy text', () => {
    expect(normalizeIchcReference('Check ReferenceNumber FIT7623801')).toBe('FIT7623801');
    expect(normalizeIchcReference('fit 1234567')).toBe('FIT1234567');
    expect(normalizeIchcReference('FIT-7654321 done')).toBe('FIT7654321');
  });
  it('returns null when there is no valid reference', () => {
    expect(normalizeIchcReference('no number here')).toBeNull();
    expect(normalizeIchcReference('FIT123')).toBeNull();      // too short
    expect(normalizeIchcReference('')).toBeNull();
    expect(normalizeIchcReference(null)).toBeNull();
  });
});

describe('isValidIchcReference', () => {
  it('accepts FIT + 7 digits only', () => {
    expect(isValidIchcReference('FIT0000001')).toBe(true);
    expect(isValidIchcReference('FIT123456')).toBe(false);
    expect(isValidIchcReference('XIT1234567')).toBe(false);
  });
});

describe('example detection', () => {
  it('flags the example reference numbers', () => {
    expect(isExampleIchcReference('FIT1234567')).toBe(true);
    expect(isExampleIchcReference('fit7623801')).toBe(true);
    expect(isExampleIchcReference('FIT7654321')).toBe(false);
    expect(EXAMPLE_ICHC_REFERENCES).toContain('FIT1234567');
  });
  it('flags the example files by sha256', () => {
    const exampleBuf = Buffer.from('x');
    expect(isExampleIchcFile(exampleBuf)).toBe(false);
    EXAMPLE_ICHC_FILE_SHA256.forEach((h) => expect(h).toMatch(/^[0-9a-f]{64}$/));
    // sha256 of known bytes is stable:
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

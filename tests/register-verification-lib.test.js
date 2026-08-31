// lib/register-verification.js — pure register-details validation for the
// onboarding wizard's document-free step (owner decision 2026-08-31).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const requireCjs = createRequire(import.meta.url);
const reg = requireCjs('../lib/register-verification.js');

describe('registerBodyForCountry', () => {
  it('maps every onboarding country spelling to its register', () => {
    expect(reg.registerBodyForCountry('uk')).toBe('gmc');
    expect(reg.registerBodyForCountry('GB')).toBe('gmc');
    expect(reg.registerBodyForCountry('United Kingdom')).toBe('gmc');
    expect(reg.registerBodyForCountry('ie')).toBe('imc');
    expect(reg.registerBodyForCountry('Ireland')).toBe('imc');
    expect(reg.registerBodyForCountry('nz')).toBe('mcnz');
    expect(reg.registerBodyForCountry('AU')).toBe('ahpra');
    expect(reg.registerBodyForCountry('')).toBe('');
    expect(reg.registerBodyForCountry('france')).toBe('');
  });
});

describe('validateRegisterDetails', () => {
  it('accepts well-formed numbers, normalizing spaces and dashes', () => {
    expect(reg.validateRegisterDetails('gmc', ' 7654 321 ')).toEqual({ ok: true, body: 'gmc', number: '7654321' });
    expect(reg.validateRegisterDetails('imc', '409876')).toEqual({ ok: true, body: 'imc', number: '409876' });
    expect(reg.validateRegisterDetails('mcnz', '54321')).toEqual({ ok: true, body: 'mcnz', number: '54321' });
    expect(reg.validateRegisterDetails('ahpra', 'med 0001234567')).toEqual({ ok: true, body: 'ahpra', number: 'MED0001234567' });
  });

  it('refuses malformed numbers with a plain-words message', () => {
    expect(reg.validateRegisterDetails('gmc', '123').ok).toBe(false);
    expect(reg.validateRegisterDetails('gmc', '12345678').ok).toBe(false);
    // A pasted "GMC 7654321" is normalized to the digits, not refused.
    expect(reg.validateRegisterDetails('gmc', 'GMC7654321')).toEqual({ ok: true, body: 'gmc', number: '7654321' });
    expect(reg.validateRegisterDetails('imc', '').ok).toBe(false);
    expect(reg.validateRegisterDetails('nope', '1234567').ok).toBe(false);
    const msg = reg.validateRegisterDetails('gmc', '123').message;
    expect(msg).toContain('GMC');
  });

  it('every register body carries a public search URL and label', () => {
    for (const key of Object.keys(reg.REGISTER_BODIES)) {
      const meta = reg.registerBodyMeta(key);
      expect(meta.searchUrl).toMatch(/^https:\/\//);
      expect(meta.label.length).toBeGreaterThan(1);
      expect(meta.name.length).toBeGreaterThan(5);
    }
  });
});

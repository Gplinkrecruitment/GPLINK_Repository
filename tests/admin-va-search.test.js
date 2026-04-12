/**
 * Unit tests for the VA global-search query helpers.
 *
 * The helpers are pure functions exported from server.js via __testUtils.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { __testUtils } = require('../server.js');
const { sanitizeVaSearchQuery, parseVaSearchScope } = __testUtils;

describe('sanitizeVaSearchQuery', () => {
  it('trims whitespace and returns the cleaned string', () => {
    expect(sanitizeVaSearchQuery('  cct  ')).toBe('cct');
  });

  it('returns empty string for non-string input', () => {
    expect(sanitizeVaSearchQuery(null)).toBe('');
    expect(sanitizeVaSearchQuery(undefined)).toBe('');
    expect(sanitizeVaSearchQuery(42)).toBe('');
    expect(sanitizeVaSearchQuery({})).toBe('');
  });

  it('caps length at 80 characters', () => {
    const long = 'x'.repeat(200);
    expect(sanitizeVaSearchQuery(long).length).toBe(80);
  });

  it('strips SQL keyword patterns', () => {
    expect(sanitizeVaSearchQuery("smith'; DROP TABLE users --")).not.toContain('DROP TABLE');
    expect(sanitizeVaSearchQuery("smith'; DROP TABLE users --")).not.toContain("'");
    expect(sanitizeVaSearchQuery("smith'; DROP TABLE users --")).not.toContain(';');
  });

  it('strips PostgREST wildcard and comma characters that break ilike filters', () => {
    expect(sanitizeVaSearchQuery('a*b,c')).toBe('abc');
  });

  it('strips percent signs so callers control wildcard placement', () => {
    expect(sanitizeVaSearchQuery('100%')).toBe('100');
  });

  it('leaves normal alphanumeric and space characters alone', () => {
    expect(sanitizeVaSearchQuery('jane smith 2026')).toBe('jane smith 2026');
  });
});

describe('parseVaSearchScope', () => {
  it('defaults to "both" when scope is omitted', () => {
    expect(parseVaSearchScope(undefined)).toBe('both');
    expect(parseVaSearchScope(null)).toBe('both');
    expect(parseVaSearchScope('')).toBe('both');
  });

  it('accepts "documents" exactly', () => {
    expect(parseVaSearchScope('documents')).toBe('documents');
  });

  it('accepts "notes" exactly', () => {
    expect(parseVaSearchScope('notes')).toBe('notes');
  });

  it('normalizes case and trims whitespace', () => {
    expect(parseVaSearchScope('  DOCUMENTS ')).toBe('documents');
    expect(parseVaSearchScope('Notes')).toBe('notes');
  });

  it('falls back to "both" for unknown values', () => {
    expect(parseVaSearchScope('all')).toBe('both');
    expect(parseVaSearchScope('users')).toBe('both');
    expect(parseVaSearchScope(42)).toBe('both');
  });
});

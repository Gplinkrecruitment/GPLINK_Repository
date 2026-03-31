import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
const { __testUtils } = require('../server.js');

const { applyQualificationNameMatchPolicy, crossCheckDocumentName, matchNames } = __testUtils;

describe('Qualification name matching', () => {
  it('accepts matching first and last names when middle names are omitted', () => {
    expect(matchNames('Dr Mary Jane Smith', 'Mary Smith')).toBe('fuzzy');
    expect(matchNames('Mary J Smith', 'Mary Jane Smith')).toBe('fuzzy');
  });

  it('does not treat partial single-name OCR reads as a valid match', () => {
    expect(matchNames('Smith', 'Mary Jane Smith')).toBe('unknown');
    expect(crossCheckDocumentName('Smith', 'Mary Jane Smith', [])).toEqual({
      match: 'unknown',
      matchedAgainst: 'profile'
    });
  });

  it('rejects different first or last names', () => {
    expect(matchNames('Mary Jane Smith', 'Mary Jane Jones')).toBe('mismatch');
    expect(matchNames('Jane Smith', 'Mary Smith')).toBe('mismatch');
  });

  it('does not let a previous document override an account mismatch', () => {
    expect(crossCheckDocumentName('Mary J Smith', 'Jane Doe', ['Mary Jane Smith'])).toEqual({
      match: 'mismatch',
      matchedAgainst: 'profile'
    });
  });

  it('can fall back to a previously verified document name when the account name is unavailable', () => {
    expect(crossCheckDocumentName('Mary J Smith', '', ['Mary Jane Smith'])).toEqual({
      match: 'fuzzy',
      matchedAgainst: 'previous_document'
    });
  });

  it('blocks qualification auto-verification when the account has no usable full name', () => {
    const verification = { verified: true, nameFound: 'Mary Jane Smith', issues: [] };
    applyQualificationNameMatchPolicy(verification, '', []);
    expect(verification.verified).toBe(false);
    expect(verification.issues).toContain(
      'We could not compare the name on this document because your account does not have a full first and last name yet. Please update your account name and try again.'
    );
  });
});

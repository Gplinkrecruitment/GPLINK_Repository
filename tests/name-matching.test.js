import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
const { __testUtils } = require('../server.js');

const { matchNames, crossCheckDocumentName } = __testUtils;

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

  it('can fall back to a previously verified document name', () => {
    expect(crossCheckDocumentName('Mary J Smith', 'Jane Doe', ['Mary Jane Smith'])).toEqual({
      match: 'fuzzy',
      matchedAgainst: 'previous_document'
    });
  });
});

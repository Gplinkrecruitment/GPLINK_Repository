import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
const { __testUtils } = require('../server.js');

const { applyQualificationNameMatchPolicy, crossCheckDocumentName, matchNames } = __testUtils;

/* The wizard carries its own copy of this logic (js/onboarding.js has no imports),
 * and it is the copy that decides whether a doctor's two certificates agree with
 * each other. Lift it out of the real source and hold it to the SAME answers as
 * the server's, case for case — drift here means the wizard and the scan disagree
 * about whether a doctor's own certificate is theirs. */
const clientGetNameMatchLevel = (() => {
  const src = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'js/onboarding.js'), 'utf8');
  const extract = (name) => {
    const start = src.indexOf('function ' + name + '(');
    expect(start, name + ' not found in js/onboarding.js').toBeGreaterThan(-1);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('unterminated function: ' + name);
  };
  const noise = src.match(/var NAME_NOISE_PARTS = \{[\s\S]*?\n {2}\};/);
  expect(noise, 'NAME_NOISE_PARTS not found in js/onboarding.js').toBeTruthy();
  const bodies = ['reorderCommaName', 'normalizeNameParts', 'nameWordsWithinOneEdit',
    'nameWordsMatch', 'countMatchedNameWords', 'getNameMatchLevel'].map(extract).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(noise[0] + '\n' + bodies + '\nreturn getNameMatchLevel;')();
})();

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

  /* ── Dr Ibrahim Fashola, 2026-08-13 ────────────────────────────────────────
   * Both of his real certificates were flagged as "the name on this document
   * looks like a previous name", and each other's, when the name is his own on
   * all three. The old rule demanded the FIRST and LAST word match exactly.
   * These are the exact strings the scan read off his documents. */
  const FASHOLA_ACCOUNT = 'Ibrahim Fashola';
  const FASHOLA_CCT = 'Fashola, Ademola Kelil Ilrahim';     // GMC prints surname first; OCR slips
  const FASHOLA_DEGREE = 'Ademola-Keji Ibrahim A. Fashola'; // "Ibrahim" is a MIDDLE name here

  describe('the names on Dr Fashola\'s own documents', () => {
    it('accepts a surname-first certificate ("Fashola, Ademola Keji Ibrahim")', () => {
      expect(matchNames(FASHOLA_CCT, FASHOLA_ACCOUNT)).toBe('fuzzy');
      expect(matchNames('Smith, Mary Jane', 'Mary Smith')).toBe('fuzzy');
    });

    it('accepts the name the doctor goes by being a MIDDLE name on the document', () => {
      expect(matchNames(FASHOLA_DEGREE, FASHOLA_ACCOUNT)).toBe('fuzzy');
    });

    it('accepts his two documents as the same person', () => {
      expect(matchNames(FASHOLA_CCT, FASHOLA_DEGREE)).toBe('fuzzy');
      expect(clientGetNameMatchLevel(FASHOLA_CCT, FASHOLA_DEGREE)).toBe('fuzzy');
    });

    it('forgives a single-letter OCR slip on a long name, but not a short one', () => {
      expect(matchNames('Ademola Ilrahim Fashola', 'Ademola Ibrahim Fashola')).toBe('fuzzy');
      // Four letters and one apart is a different name, not a misread.
      expect(matchNames('Jane Khan', 'Jade Khan')).toBe('mismatch');
      expect(matchNames('Ali Khun', 'Ali Khan')).toBe('mismatch');
    });

    it('reads "Smith, MBBS" as a qualification suffix, not a surname-first name', () => {
      // Reordering that would invent the name "MBBS Smith".
      expect(matchNames('Smith, MBBS', 'Mary Smith')).toBe('unknown');
    });
  });

  describe('what must still be caught (this is the wrong-owner guard)', () => {
    it('still rejects a document belonging to a different doctor', () => {
      // The Sana Ahsan CV filed under Helen Wazalski — a PII breach once emailed.
      expect(matchNames('Sana Ahsan', 'Helen Wazalski')).toBe('mismatch');
      expect(crossCheckDocumentName('Sana Ahsan', 'Helen Wazalski', []).match).toBe('mismatch');
    });

    it('still rejects a relative who shares the surname', () => {
      expect(matchNames('Ademola Fashola', 'Ibrahim Fashola')).toBe('mismatch');
      expect(matchNames('John Smith', 'Jane Smith')).toBe('mismatch');
    });

    it('still treats a changed surname as a name change, not a match', () => {
      expect(matchNames('Mary Jane Smith', 'Mary Jane Jones')).toBe('mismatch');
    });

    it('needs more than the surname alone', () => {
      expect(matchNames('Fashola Adebayo Olumide', 'Ibrahim Fashola')).toBe('mismatch');
    });
  });

  describe('the wizard\'s copy answers exactly the same', () => {
    const cases = [
      [FASHOLA_CCT, FASHOLA_ACCOUNT],
      [FASHOLA_DEGREE, FASHOLA_ACCOUNT],
      [FASHOLA_CCT, FASHOLA_DEGREE],
      ['Dr Mary Jane Smith', 'Mary Smith'],
      ['Mary J Smith', 'Mary Jane Smith'],
      ['Smith, Mary Jane', 'Mary Smith'],
      ['Smith, MBBS', 'Mary Smith'],
      ['Sana Ahsan', 'Helen Wazalski'],
      ['John Smith', 'Jane Smith'],
      ['Mary Jane Smith', 'Mary Jane Jones'],
      ['Ademola Fashola', 'Ibrahim Fashola'],
      ['Jane Khan', 'Jade Khan'],
      ['Smith', 'Mary Jane Smith'],
      ['', 'Mary Smith'],
      ['Mary Smith', 'Mary Smith']
    ];
    it.each(cases)('%s vs %s', (a, b) => {
      expect(clientGetNameMatchLevel(a, b)).toBe(matchNames(a, b));
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

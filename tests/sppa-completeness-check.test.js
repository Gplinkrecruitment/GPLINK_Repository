import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isOnlyAltCvOutstanding } = require('../lib/sppa-completeness-check.js');

// When a returned SPPA-00 is complete + signed and the ONLY outstanding item is an alternate
// supervisor's CV (collected via its own task), the submit gate must not hard-block and the panel
// should reframe it as a reminder. This classifier decides that case.
describe('isOnlyAltCvOutstanding', () => {
  const altDoc = 'Alternate supervisor 1 (Ahmed Mahmoud) signed CV (Q5), not present in GP Link\'s document inventory';

  it('is true when the only gap is an alternate-supervisor CV', () => {
    expect(isOnlyAltCvOutstanding({
      is_complete: false, missing_fields: [], missing_signatures: [], issues: [],
      missing_documents: [altDoc]
    })).toBe(true);
  });

  it('is true for two alternate-supervisor CVs', () => {
    expect(isOnlyAltCvOutstanding({
      missing_fields: [], missing_signatures: [], issues: [],
      missing_documents: [altDoc, 'Alternate supervisor 2 (Jane Doe) signed CV (Q5)']
    })).toBe(true);
  });

  it('is false when a required field is also missing', () => {
    expect(isOnlyAltCvOutstanding({
      missing_fields: ['Q2 supervisor registration number'], missing_signatures: [], issues: [],
      missing_documents: [altDoc]
    })).toBe(false);
  });

  it('is false when a signature is also missing', () => {
    expect(isOnlyAltCvOutstanding({
      missing_fields: [], missing_signatures: ['Section J unsigned'], issues: [],
      missing_documents: [altDoc]
    })).toBe(false);
  });

  it('is false when there is another issue', () => {
    expect(isOnlyAltCvOutstanding({
      missing_fields: [], missing_signatures: [], issues: ['Q7 answered YES with no details'],
      missing_documents: [altDoc]
    })).toBe(false);
  });

  it('is false when a non-alt document is also missing (e.g. primary supervisor CV)', () => {
    expect(isOnlyAltCvOutstanding({
      missing_fields: [], missing_signatures: [], issues: [],
      missing_documents: [altDoc, 'Primary supervisor CV (Q3) not on file']
    })).toBe(false);
  });

  it('is false when nothing is missing at all', () => {
    expect(isOnlyAltCvOutstanding({
      missing_fields: [], missing_signatures: [], issues: [], missing_documents: []
    })).toBe(false);
  });

  it('is false for null / non-object input', () => {
    expect(isOnlyAltCvOutstanding(null)).toBe(false);
    expect(isOnlyAltCvOutstanding(undefined)).toBe(false);
  });
});

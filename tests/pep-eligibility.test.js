import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { classifyPepEligibility } = require('../lib/document-pipeline.js');

// classifyPepEligibility gates a GP onto the PEP (Substantially Comparable) pathway
// only for a HIGH-CONFIDENCE verified specialist-certificate read from a gated country
// (GB/IE/NZ) dated clearly BEFORE that country's cutoff.
//   GB mrcgp certificate  -> 2007-08-01
//   IE micgp certificate  -> 2009-01-01
//   NZ frnzcgp certificate-> 2010-01-01
describe('classifyPepEligibility', () => {
  it('1. GB MRCGP dated before the cutoff, verified -> PEP eligible', () => {
    const result = classifyPepEligibility({
      documentType: 'mrcgp certificate',
      expectedCountry: 'GB',
      verified: true,
      dateFound: '2005-06-01'
    });
    expect(result.pepEligible).toBe(true);
    expect(result.pepMeta).not.toBeNull();
    expect(result.pepMeta.country).toBe('GB');
    expect(result.pepMeta.cutoffDate).toBe('2007-08-01');
    expect(result.pepMeta.dateFound).toBe('2005-06-01');
  });

  it('2. IE MICGP dated 2008-12-31 (day before cutoff), verified -> PEP eligible', () => {
    const result = classifyPepEligibility({
      documentType: 'micgp certificate',
      expectedCountry: 'IE',
      verified: true,
      dateFound: '2008-12-31'
    });
    expect(result.pepEligible).toBe(true);
    expect(result.pepMeta.country).toBe('IE');
    expect(result.pepMeta.cutoffDate).toBe('2009-01-01');
  });

  it('3. NZ FRNZCGP dated 2009-05-01 (before cutoff), verified -> PEP eligible', () => {
    const result = classifyPepEligibility({
      documentType: 'frnzcgp certificate',
      expectedCountry: 'NZ',
      verified: true,
      dateFound: '2009-05-01'
    });
    expect(result.pepEligible).toBe(true);
    expect(result.pepMeta.country).toBe('NZ');
    expect(result.pepMeta.cutoffDate).toBe('2010-01-01');
  });

  it('4. GB MRCGP dated ON or after the cutoff, verified -> NOT eligible', () => {
    // Exactly on the cutoff (>= cutoff is excluded).
    const onCutoff = classifyPepEligibility({
      documentType: 'mrcgp certificate',
      expectedCountry: 'GB',
      verified: true,
      dateFound: '2007-08-01'
    });
    expect(onCutoff.pepEligible).toBe(false);
    expect(onCutoff.pepMeta).toBeNull();

    // Well after the cutoff.
    const afterCutoff = classifyPepEligibility({
      documentType: 'mrcgp certificate',
      expectedCountry: 'GB',
      verified: true,
      dateFound: '2010-01-01'
    });
    expect(afterCutoff.pepEligible).toBe(false);
    expect(afterCutoff.pepMeta).toBeNull();
  });

  it('5. Not verified (bad scan) even with an early date -> NOT eligible', () => {
    const result = classifyPepEligibility({
      documentType: 'mrcgp certificate',
      expectedCountry: 'GB',
      verified: false,
      dateFound: '2005-06-01'
    });
    expect(result.pepEligible).toBe(false);
    expect(result.pepMeta).toBeNull();
  });

  it('6. Primary Medical Degree (not the specialist cert) with an early date -> NOT eligible', () => {
    const result = classifyPepEligibility({
      documentType: 'Primary Medical Degree',
      expectedCountry: 'GB',
      verified: true,
      dateFound: '2005-06-01'
    });
    expect(result.pepEligible).toBe(false);
    expect(result.pepMeta).toBeNull();
  });

  it('7. Wrong cert for the country (GB expected, MICGP supplied) -> NOT eligible', () => {
    const result = classifyPepEligibility({
      documentType: 'micgp certificate',
      expectedCountry: 'GB',
      verified: true,
      dateFound: '2005-06-01'
    });
    expect(result.pepEligible).toBe(false);
    expect(result.pepMeta).toBeNull();
  });

  it('8. Non-gated expectedCountry (any / AU / empty) -> NOT eligible', () => {
    for (const country of ['any', 'AU', '']) {
      const result = classifyPepEligibility({
        documentType: 'mrcgp certificate',
        expectedCountry: country,
        verified: true,
        dateFound: '2005-06-01'
      });
      expect(result.pepEligible).toBe(false);
      expect(result.pepMeta).toBeNull();
    }
  });

  it('9. Unparseable or empty dateFound -> NOT eligible', () => {
    const empty = classifyPepEligibility({
      documentType: 'mrcgp certificate',
      expectedCountry: 'GB',
      verified: true,
      dateFound: ''
    });
    expect(empty.pepEligible).toBe(false);
    expect(empty.pepMeta).toBeNull();

    const garbage = classifyPepEligibility({
      documentType: 'mrcgp certificate',
      expectedCountry: 'GB',
      verified: true,
      dateFound: 'not-a-date'
    });
    expect(garbage.pepEligible).toBe(false);
    expect(garbage.pepMeta).toBeNull();
  });

  it('10. documentType is matched case-insensitively (mixed-case still gates)', () => {
    const result = classifyPepEligibility({
      documentType: 'MRCGP Certificate',
      expectedCountry: 'GB',
      verified: true,
      dateFound: '2005-06-01'
    });
    expect(result.pepEligible).toBe(true);
    expect(result.pepMeta.country).toBe('GB');
    // certType echoes the original documentType as supplied.
    expect(result.pepMeta.certType).toBe('MRCGP Certificate');
  });
});

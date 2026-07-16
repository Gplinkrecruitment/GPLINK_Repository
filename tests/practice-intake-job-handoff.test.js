const { buildIntakeJobDetails, buildPackageTerms } = require('../lib/practice-intake-logic');

const intake = {
  gp_count: '8',
  percentage_split: '70/30',
  incentives: '$10,000 relocation package\n$3,000 CPD allowance',
  nursing_on_site: true,
  years_operating: '14 years',
  general_location: 'Erina, NSW - near Central Coast',
  address: '60 Erina Valley Rd, Erina NSW 2250',
  earnings_text: '$300,000-$400,000 per year',
  supervision_available: true,
};

describe('buildIntakeJobDetails - the six boxes the CEO editor reads', () => {
  const d = buildIntakeJobDetails(intake);
  // These key names are the contract with atsJobEditorPayload. If they drift, the
  // CEO editor silently shows blank boxes again -- which is the bug we are fixing.
  it('carries every key the editor reads', () => {
    expect(d).toMatchObject({
      gp_count: '8',
      percentage_split: '70/30',
      incentives: '$10,000 relocation package\n$3,000 CPD allowance',
      nursing_on_site: true,
      years_operating: '14 years',
      general_location: 'Erina, NSW - near Central Coast',
    });
  });
  it('does not invent values for fields the practice left blank', () => {
    const d2 = buildIntakeJobDetails({ gp_count: '3' });
    expect(d2.gp_count).toBe('3');
    expect(d2.incentives == null || d2.incentives === '').toBe(true);
  });
  it('survives an empty intake', () => {
    expect(() => buildIntakeJobDetails({})).not.toThrow();
    expect(() => buildIntakeJobDetails(null)).not.toThrow();
  });
});

describe('buildPackageTerms - turns on render code that has never had input', () => {
  it('states the split with the GP share first', () => {
    const pt = buildPackageTerms(intake);
    expect(pt.billingSplit).toBe('GP 70% / Practice 30%');
  });
  it('passes the incentives through for the bonus row', () => {
    expect(buildPackageTerms(intake).agreementBonus).toContain('relocation');
  });
  it('carries the earnings text', () => {
    expect(buildPackageTerms(intake).earnings).toBe('$300,000-$400,000 per year');
  });
  it('reports supervision', () => {
    expect(buildPackageTerms(intake).supervision).toBeTruthy();
  });
  it('omits a row rather than showing an empty one', () => {
    const pt = buildPackageTerms({ percentage_split: '70' });
    expect(pt.billingSplit).toBe('GP 70% / Practice 30%');
    expect(pt.agreementBonus == null || pt.agreementBonus === '').toBe(true);
  });
  it('omits the split entirely when it cannot be parsed', () => {
    const pt = buildPackageTerms({ percentage_split: 'negotiable' });
    expect(pt.billingSplit == null || pt.billingSplit === '').toBe(true);
  });
});

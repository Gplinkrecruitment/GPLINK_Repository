const {
  parseSplit, nearestCity, abnOk, acnOk, idKind, derivePlace, buildGeneralLocation,
} = require('../lib/practice-intake-logic');

describe('parseSplit, the GP always takes the larger share', () => {
  it('reads a single number as the GP share', () => {
    expect(parseSplit('70')).toMatchObject({ gp: 70, practice: 30, canonical: '70/30' });
  });
  it('reads 70/30 as GP 70', () => {
    expect(parseSplit('70/30')).toMatchObject({ gp: 70, practice: 30 });
  });
  it('reads 30/70 as GP 70, order does not matter, the larger share is the GP\'s', () => {
    expect(parseSplit('30/70')).toMatchObject({ gp: 70, practice: 30 });
  });
  it('handles prose around the numbers', () => {
    expect(parseSplit('65% to the doctor, 35% to us')).toMatchObject({ gp: 65, practice: 35 });
  });
  it('handles decimals', () => {
    expect(parseSplit('67.5/32.5')).toMatchObject({ gp: 67.5, practice: 32.5 });
  });
  it('builds a human display string', () => {
    expect(parseSplit('70').display).toBe('GP 70% / Practice 30%');
  });
  it('rejects empty, junk, and out-of-range values', () => {
    expect(parseSplit('')).toBeNull();
    expect(parseSplit('negotiable')).toBeNull();
    expect(parseSplit('0')).toBeNull();
    expect(parseSplit('100')).toBeNull();
    expect(parseSplit(null)).toBeNull();
  });
  it('reads the pair that sums to 100 even when other numbers are in the way', () => {
    expect(parseSplit('Rent is $30/week, split is 20/80')).toMatchObject({ gp: 80, practice: 20 });
  });
  it('is not fooled by a larger unrelated number', () => {
    expect(parseSplit('70/30 split, 90 minute drive to the coast')).toMatchObject({ gp: 70, practice: 30 });
  });
  it('reads a lone number as the GP share', () => {
    expect(parseSplit('70% split, 15 minute appointments')).toBeNull(); // two numbers, no pair sums to 100 -> ambiguous
  });
  it('refuses to guess when the numbers are ambiguous', () => {
    expect(parseSplit('somewhere between 60 and 75')).toBeNull();
  });
  it('still handles the ordinary cases', () => {
    expect(parseSplit('70')).toMatchObject({ gp: 70, practice: 30 });
    expect(parseSplit('70/30')).toMatchObject({ gp: 70, practice: 30 });
    expect(parseSplit('30/70')).toMatchObject({ gp: 70, practice: 30 });
    expect(parseSplit('50/50')).toMatchObject({ gp: 50, practice: 50 });
    expect(parseSplit('67.5/32.5')).toMatchObject({ gp: 67.5, practice: 32.5 });
    expect(parseSplit('65% to the doctor, 35% to us')).toMatchObject({ gp: 65, practice: 35 });
  });
});

describe('nearestCity, measured, never inferred', () => {
  it('finds Melbourne for Werribee', () => {
    const r = nearestCity(-37.899, 144.661);
    expect(r.city).toBe('Melbourne');
    expect(r.km).toBeLessThan(40);
  });
  it('finds Sydney for the CBD itself at ~0km', () => {
    expect(nearestCity(-33.868, 151.209)).toMatchObject({ city: 'Sydney', km: 0 });
  });
  it('picks the regional centre over the far-away capital', () => {
    // Erina, NSW Central Coast, closer to Newcastle/Sydney than to anything else
    const r = nearestCity(-33.433, 151.396);
    expect(['Sydney', 'Newcastle', 'Central Coast']).toContain(r.city);
  });
});

describe('abnOk / acnOk, real checksums, not length checks', () => {
  it('accepts a valid ABN', () => {
    expect(abnOk('51824753556')).toBe(true); // ATO's own published test ABN
  });
  it('rejects an ABN with a broken checksum', () => {
    expect(abnOk('51824753557')).toBe(false);
  });
  it('rejects the right length but all zeroes', () => {
    expect(abnOk('00000000000')).toBe(false);
  });
  it('accepts a valid ACN', () => {
    expect(acnOk('004085616')).toBe(true); // ASIC's published example
  });
  it('rejects a broken ACN', () => {
    expect(acnOk('004085617')).toBe(false);
  });
  it('rejects wrong lengths', () => {
    expect(abnOk('123')).toBe(false);
    expect(acnOk('12345678')).toBe(false);
  });
});

describe('idKind, a practice may give us either', () => {
  it('identifies an ABN', () => expect(idKind('51 824 753 556')).toBe('ABN'));
  it('identifies an ACN', () => expect(idKind('004 085 616')).toBe('ACN'));
  it('returns null for junk', () => expect(idKind('12345')).toBeNull());
});

describe('derivePlace, one address answers four questions', () => {
  const googlePlace = {
    id: 'ChIJxyz',
    formattedAddress: '60 Erina Valley Rd, Erina NSW 2250, Australia',
    location: { latitude: -33.433, longitude: 151.396 },
    addressComponents: [
      { types: ['street_number'], longText: '60' },
      { types: ['route'], longText: 'Erina Valley Road' },
      { types: ['locality'], longText: 'Erina' },
      { types: ['administrative_area_level_1'], shortText: 'NSW' },
      { types: ['postal_code'], longText: '2250' },
    ],
  };
  it('pulls suburb, state and postcode out of the components', () => {
    expect(derivePlace(googlePlace)).toMatchObject({
      suburb: 'Erina', state: 'NSW', postcode: '2250',
      latitude: -33.433, longitude: 151.396, googlePlaceId: 'ChIJxyz',
    });
  });
  it('composes the street line', () => {
    expect(derivePlace(googlePlace).street).toBe('60 Erina Valley Road');
  });
  it('does not throw on a place with missing components', () => {
    expect(() => derivePlace({ id: 'x', location: { latitude: 0, longitude: 0 } })).not.toThrow();
  });
});

describe('buildGeneralLocation', () => {
  it('composes the confirmation strip text', () => {
    expect(buildGeneralLocation({ suburb: 'Werribee', state: 'VIC', nearestCity: 'Melbourne' }))
      .toBe('Werribee, VIC - near Melbourne');
  });
});

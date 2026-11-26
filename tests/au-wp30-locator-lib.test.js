// Australian GP build, WP-30: the look-up (lib/au-workforce-locator.js).
// No test here reaches the real Health Workforce Locator: the real responses
// are the saved ones in tests/fixtures/au-wp30-locator-responses.json, and
// every network call goes to a stub this file controls.
import { describe, it, expect, beforeEach } from 'vitest';

const locator = require('../lib/au-workforce-locator.js');
const dpaLookup = require('../lib/dpa-lookup.js');
const SAVED = require('./fixtures/au-wp30-locator-responses.json');
const FIXTURE = require('../lib/au-workforce-locator-fixture.json');

const FIX = { AU_WORKFORCE_LOCATOR_PROVIDER: 'fixture' };
const REAL = { AU_WORKFORCE_LOCATOR_PROVIDER: 'health_gov', AU_WORKFORCE_LOCATOR_GEOCODER: 'none' };

beforeEach(() => { locator._resetForTests(); });

/** A stand-in for the locator's data service that answers from the saved real responses. */
function stubService(opts) {
  const o = opts || {};
  const calls = { token: 0, point: 0, other: [] };
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/auth/guest-token')) {
      calls.token += 1;
      if (o.tokenFails) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ accessToken: 'guest-' + calls.token, expiresIn: 3600 }) };
    }
    if (u.endsWith('/theme/getResult/locator/address')) {
      calls.point += 1;
      if (o.failFirst && calls.point <= o.failFirst) return { ok: false, status: 500, json: async () => ({}) };
      if (o.hang) return new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
      const body = JSON.parse(init.body);
      const [lng, lat] = body.inputs[0].selection.record.geometry.coordinates;
      const hit = Object.values(SAVED.responses).find((r) => Math.abs(r.point.lat - lat) < 0.01 && Math.abs(r.point.lng - lng) < 0.01);
      const answer = o.body || (hit ? hit.body : SAVED.responses.ocean.body);
      return { ok: true, status: 201, json: async () => answer };
    }
    calls.other.push(u);
    return { ok: true, status: 200, json: async () => (o.geocode ? o.geocode(u) : []) };
  };
  return { fetchImpl, calls };
}

describe('the saved real responses are read correctly', () => {
  const cases = [
    ['dubbo', { dpaGp: 'yes', catchment: 'Dubbo', mmm: 3, mmmYear: 2023 }],
    ['parramatta', { dpaGp: 'no', catchment: 'Parramatta', mmm: 1, mmmYear: 2023 }],
    ['tennant-creek', { dpaGp: 'yes', catchment: 'Tennant Creek', mmm: 7, mmmYear: 2023 }],
    ['ocean', { dpaGp: 'unknown', catchment: '', mmm: null, mmmYear: 2023 }]
  ];
  for (const [name, want] of cases) {
    it(name, () => {
      const got = locator.parseLocatorResponse(SAVED.responses[name].body);
      expect({ dpaGp: got.dpaGp, catchment: got.catchment, mmm: got.mmm, mmmYear: got.mmmYear }).toEqual(want);
    });
  }
  it('uses the newest Modified Monash edition the source serves, and never an older one to fill a gap', () => {
    const body = JSON.parse(JSON.stringify(SAVED.responses.dubbo.body));
    body.results.mmm2027 = { features: [{ properties: { value: 4, class: 'mmm4' } }] };
    expect(locator.parseLocatorResponse(body)).toMatchObject({ mmm: 4, mmmYear: 2027 });
    body.results.mmm2027 = { features: [] };
    expect(locator.parseLocatorResponse(body)).toMatchObject({ mmm: null, mmmYear: 2027 });
  });
  it('anything other than a clear Y or N is unknown, never a guess', () => {
    for (const value of ['', null, undefined, 'y?', 'Maybe', 1, true]) {
      const body = JSON.parse(JSON.stringify(SAVED.responses.dubbo.body));
      body.results.dpa_gps.features[0].properties.value = value;
      expect(locator.parseLocatorResponse(body).dpaGp).toBe('unknown');
    }
    expect(() => locator.parseLocatorResponse(null)).toThrow();
    expect(() => locator.parseLocatorResponse({ errors: {} })).toThrow();
  });
  it('the existing lookup (lib/dpa-lookup.js) still reads the same responses the way it always did', () => {
    expect(dpaLookup.parseHwlResult(SAVED.responses.dubbo.body)).toMatchObject({ dpa: true, dpaCatchment: 'Dubbo', mmm: 'MM3' });
    expect(dpaLookup.parseHwlResult(SAVED.responses.parramatta.body)).toMatchObject({ dpa: false, mmm: 'MM1' });
    expect(() => dpaLookup.parseHwlResult(SAVED.responses.ocean.body)).toThrow();
  });
});

describe('what counts as coordinates', () => {
  const bad = [[0, 0], [null, null], [undefined, undefined], ['', ''], [null, 151], [-33.8, null], [true, true], ['abc', 'def'],
    [51.5, -0.12], [-33.8, -151.0], [-45.5, 147], [-8.5, 130], [-25, 111], [-25, 155], [NaN, NaN]];
  for (const [lat, lng] of bad) {
    it('not coordinates: ' + JSON.stringify([lat, lng]), () => { expect(locator.validAuPoint(lat, lng)).toBe(null); });
  }
  const good = [[-33.815, 151.0011], ['-32.2569', '148.6011'], [-12.46, 130.84], [-42.88, 147.33], [-31.95, 115.86]];
  for (const [lat, lng] of good) {
    it('coordinates: ' + JSON.stringify([lat, lng]), () => { expect(locator.validAuPoint(lat, lng)).toEqual({ lat: Number(lat), lng: Number(lng) }); });
  }
});

describe('provider selection and the kill switch', () => {
  it('defaults to none; anything unrecognised is none', () => {
    for (const v of [undefined, '', 'NONE', 'off', 'true', 'real', 'healthgov']) {
      expect(locator.providerName({ AU_WORKFORCE_LOCATOR_PROVIDER: v })).toBe('none');
    }
    expect(locator.providerName({ AU_WORKFORCE_LOCATOR_PROVIDER: ' Fixture ' })).toBe('fixture');
    expect(locator.providerName({ AU_WORKFORCE_LOCATOR_PROVIDER: 'health_gov' })).toBe('health_gov');
  });
  it('none: no network at all, and an answer that can never be read as yes', async () => {
    const stub = stubService();
    const r = await locator.classifyLocation({ address: '2 Test Road, Dubbo NSW 2830', suburb: 'Dubbo', state: 'NSW', latitude: -32.2569, longitude: 148.6011, placeId: 'x' }, { env: {}, fetchImpl: stub.fetchImpl });
    expect(r).toMatchObject({ ok: false, provider: 'none', dpaGp: 'unknown', mmm: null, confidence: 'none', error: 'provider_off' });
    expect(stub.calls).toEqual({ token: 0, point: 0, other: [] });
  });
});

describe('confidence decides trust (fixture provider)', () => {
  const table = [
    ['an exact street address in a DPA', { address: '2 Test Road, Dubbo NSW 2830', suburb: 'Dubbo', state: 'NSW', postcode: '2830' },
      { ok: true, dpaGp: 'yes', mmm: 3, confidence: 'exact', method: 'geocoded_address' }],
    ['an exact street address outside a DPA', { address: '1 Test Street', suburb: 'Parramatta', state: 'NSW', postcode: '2150' },
      { ok: true, dpaGp: 'no', mmm: 1, confidence: 'exact', method: 'geocoded_address' }],
    ['a remote town', { address: '5 Sample Road', suburb: 'Tennant Creek', state: 'NT' },
      { ok: true, dpaGp: 'yes', mmm: 7, confidence: 'exact' }],
    ['suburb only: approximate, DPA stays unknown even though the centre of the suburb is in one', { suburb: 'Dubbo', state: 'NSW', postcode: '2830' },
      { ok: true, dpaGp: 'unknown', mmm: 3, mmmApproximate: true, confidence: 'approximate', method: 'suburb_centroid' }],
    ['a street the geocoder does not know: approximate', { address: '77 Other Street', suburb: 'Dubbo', state: 'NSW' },
      { ok: true, dpaGp: 'unknown', confidence: 'approximate' }],
    ['latitude 0 / longitude 0 (the hand-typed-address bug) is NOT a point: the address is used', { address: '1 Test Street, Parramatta NSW 2150', suburb: 'Parramatta', state: 'NSW', latitude: 0, longitude: 0, placeId: 'p' },
      { ok: true, dpaGp: 'no', confidence: 'exact', method: 'geocoded_address' }],
    ['0,0 and nothing else: nothing to classify', { latitude: 0, longitude: 0 },
      { ok: false, dpaGp: 'unknown', confidence: 'none', error: 'address_not_located' }],
    ['a point outside Australia is ignored', { latitude: 51.5, longitude: -0.12, placeId: 'p' },
      { ok: false, dpaGp: 'unknown', confidence: 'none' }],
    ['a selected address whose point matches the written address', { address: '1 Test Street, Parramatta NSW 2150', suburb: 'Parramatta', state: 'NSW', latitude: -33.815, longitude: 151.0011, placeId: 'p' },
      { ok: true, dpaGp: 'no', confidence: 'exact', method: 'selected_address' }],
    ['a point that is NOT where the written address is: the point is refused', { address: '1 Test Street, Parramatta NSW 2150', suburb: 'Parramatta', state: 'NSW', latitude: -32.2569, longitude: 148.6011, placeId: 'p' },
      { ok: true, dpaGp: 'no', confidence: 'exact', method: 'geocoded_address' }],
    ['a far-away point with only a suburb to check it against: refused, suburb centre used, not confident', { suburb: 'Parramatta', state: 'NSW', latitude: -32.2569, longitude: 148.6011, placeId: 'p' },
      { ok: true, dpaGp: 'unknown', confidence: 'approximate', method: 'suburb_centroid' }],
    ['a point with nothing to say it was selected is never trusted on its own', { suburb: 'Dubbo', state: 'NSW', latitude: -32.2569, longitude: 148.6011 },
      { ok: true, dpaGp: 'unknown', confidence: 'approximate', method: 'suburb_centroid' }],
    ['a place the source has no answer for', { address: '9 Unknown Lane', suburb: 'Nowhere Creek', state: 'QLD', postcode: '4999' },
      { ok: false, dpaGp: 'unknown', mmm: null, confidence: 'none', error: 'no_classification_at_point' }],
    ['a suburb nobody can find', { suburb: 'Atlantis', state: 'WA' },
      { ok: false, dpaGp: 'unknown', confidence: 'none', error: 'address_not_located' }],
    ['nothing at all', {}, { ok: false, dpaGp: 'unknown', confidence: 'none' }]
  ];
  for (const [name, input, want] of table) {
    it(name, async () => {
      const r = await locator.classifyLocation(input, { env: FIX });
      expect(r).toMatchObject(want);
      expect(r.provider).toBe('fixture');
      // The invariant: a yes or a no only ever comes with an exact point.
      if (r.dpaGp !== 'unknown') expect(r.confidence).toBe('exact');
      if (r.confidence !== 'exact') expect(r.dpaGp).toBe('unknown');
    });
  }
  it('an approximate answer carries what the centre of the suburb said separately, for wording only', async () => {
    const r = await locator.classifyLocation({ suburb: 'Dubbo', state: 'NSW' }, { env: FIX });
    expect(r.dpaGp).toBe('unknown');
    expect(r.indicative).toEqual({ dpaGp: 'yes', catchment: 'Dubbo' });
    expect(r.warnings).toContain('address_not_precise');
    expect(r.pointUsed).toMatchObject({ source: 'suburb_centroid' });
  });
  it('a refused point is reported', async () => {
    const r = await locator.classifyLocation({ address: '1 Test Street, Parramatta NSW 2150', suburb: 'Parramatta', state: 'NSW', latitude: -32.2569, longitude: 148.6011, placeId: 'p' }, { env: FIX });
    expect(r.warnings).toContain('point_address_mismatch');
    expect(r.pointUsed.lat).toBeCloseTo(-33.815, 3);
  });
  it('records the point, the method, the years and the time', async () => {
    const r = await locator.classifyLocation({ address: '2 Test Road', suburb: 'Dubbo', state: 'NSW' }, { env: FIX, now: () => Date.parse('2026-11-26T01:02:03Z') });
    expect(r.pointUsed).toEqual({ lat: -32.2569, lng: 148.6011, source: 'geocoded_address' });
    expect(r.classificationYear).toEqual({ dpa: 'fixture', mmm: 2023 });
    expect(r.checkedAt).toBe('2026-11-26T01:02:03.000Z');
    expect(r.catchment).toBe('Dubbo');
  });
});

describe('the fixture entries marked verified match the saved real responses', () => {
  for (const place of FIXTURE.places.filter((p) => p.verified)) {
    it(place.id, () => {
      const saved = Object.values(SAVED.responses).find((r) => Math.abs(r.point.lat - place.lat) < 0.001 && Math.abs(r.point.lng - place.lng) < 0.001);
      expect(saved, 'a saved real response for ' + place.id).toBeTruthy();
      const real = locator.parseLocatorResponse(saved.body);
      expect({ dpaGp: place.dpaGp, mmm: place.mmm, catchment: place.catchment }).toEqual({ dpaGp: real.dpaGp, mmm: real.mmm, catchment: real.catchment });
    });
  }
  it('has an entry that is deliberately unknown, and it is not marked verified', () => {
    const unknown = FIXTURE.places.filter((p) => p.dpaGp === 'unknown');
    expect(unknown.length).toBe(1);
    expect(unknown[0].verified).toBe(false);
  });
});

describe('the real provider, against a stand-in service', () => {
  const selected = (lat, lng) => ({ address: '1 Example Street', suburb: 'Exampleton', state: 'NSW', latitude: lat, longitude: lng, placeId: 'place-1' });
  // FR-9 (M9-05, deliberate): a point sent with the address is believed only
  // when the server's OWN geocoder finds the same building at the same spot.
  // These tests are about the classification service, so they supply a
  // geocoder that does (its name carries the point: the geocode cache is per geocoder).
  const sameBuilding = (lat, lng) => ({ name: 'standin:' + lat + ',' + lng, street: async () => ({ lat, lng, precision: 'exact' }), suburb: async () => null });

  it('a selected address the server itself finds at the same spot: exact, no warning', async () => {
    const stub = stubService();
    const r = await locator.classifyLocation(selected(-32.2569, 148.6011), { geocoder: sameBuilding(-32.2569, 148.6011), env: REAL, fetchImpl: stub.fetchImpl });
    expect(r).toMatchObject({ ok: true, provider: 'health_gov', dpaGp: 'yes', mmm: 3, confidence: 'exact', method: 'selected_address', catchment: 'Dubbo' });
    expect(r.classificationYear).toEqual({ dpa: null, mmm: 2023 });
    expect(r.warnings).toEqual([]);
    expect(stub.calls.other).toEqual([]);
  });
  it('FR-9 (M9-05): with nothing to confirm it against, the browser\'s point is NOT used (it used to be believed as exact)', async () => {
    const stub = stubService();
    const r = await locator.classifyLocation(selected(-32.2569, 148.6011), { env: REAL, fetchImpl: stub.fetchImpl });
    expect(r).toMatchObject({ ok: false, dpaGp: 'unknown', confidence: 'none', error: 'address_not_located' });
    expect(r.warnings).toContain('point_not_corroborated');
    expect(stub.calls.point).toBe(0);     // the classification service was never asked about that point
  });
  it('the edition label the owner sets is recorded as the DPA year', async () => {
    const stub = stubService();
    const r = await locator.classifyLocation(selected(-33.815, 151.0011), { geocoder: sameBuilding(-33.815, 151.0011), env: Object.assign({ AU_WORKFORCE_LOCATOR_EDITION: '2026' }, REAL), fetchImpl: stub.fetchImpl });
    expect(r.classificationYear).toEqual({ dpa: '2026', mmm: 2023 });
    expect(r).toMatchObject({ dpaGp: 'no', mmm: 1 });
  });
  it('the sea: no classification, unknown', async () => {
    const stub = stubService({ body: SAVED.responses.ocean.body });
    const r = await locator.classifyLocation(selected(-33.815, 151.0011), { geocoder: sameBuilding(-33.815, 151.0011), env: REAL, fetchImpl: stub.fetchImpl });
    expect(r).toMatchObject({ ok: false, dpaGp: 'unknown', mmm: null, confidence: 'none', error: 'no_classification_at_point' });
  });
  it('one retry: a failure then a success is a success', async () => {
    const stub = stubService({ failFirst: 1 });
    const r = await locator.classifyLocation(selected(-32.2569, 148.6011), { geocoder: sameBuilding(-32.2569, 148.6011), env: REAL, fetchImpl: stub.fetchImpl });
    expect(r.ok).toBe(true);
    expect(stub.calls.point).toBe(2);
  });
  it('two failures: unknown, and exactly two attempts (never a third)', async () => {
    const stub = stubService({ failFirst: 5 });
    const r = await locator.classifyLocation(selected(-32.2569, 148.6011), { geocoder: sameBuilding(-32.2569, 148.6011), env: REAL, fetchImpl: stub.fetchImpl });
    expect(r).toMatchObject({ ok: false, dpaGp: 'unknown', confidence: 'none', error: 'locator_unavailable' });
    expect(stub.calls.point).toBe(2);
  });
  it('the token service down: unknown', async () => {
    const stub = stubService({ tokenFails: true });
    const r = await locator.classifyLocation(selected(-32.2569, 148.6011), { geocoder: sameBuilding(-32.2569, 148.6011), env: REAL, fetchImpl: stub.fetchImpl });
    expect(r).toMatchObject({ ok: false, dpaGp: 'unknown', error: 'locator_unavailable' });
  });
  it('a service that never answers is given up on within the 8 second budget', async () => {
    const stub = stubService({ hang: true });
    let clock = 1000;
    const started = Date.now();
    // The module's clock is advanced by the test so the budget runs out at once.
    const r = await locator.classifyLocation(selected(-32.2569, 148.6011), { geocoder: sameBuilding(-32.2569, 148.6011), env: REAL, fetchImpl: stub.fetchImpl, now: () => { clock += 4100; return clock; } });
    expect(r).toMatchObject({ ok: false, dpaGp: 'unknown', error: 'timeout' });
    expect(Date.now() - started).toBeLessThan(9000);
    expect(locator.TOTAL_BUDGET_MS).toBe(8000);
  }, 15000);
  it('an unreadable answer: unknown', async () => {
    const stub = stubService({ body: { hello: 'world' } });
    const r = await locator.classifyLocation(selected(-32.2569, 148.6011), { geocoder: sameBuilding(-32.2569, 148.6011), env: REAL, fetchImpl: stub.fetchImpl });
    expect(r).toMatchObject({ ok: false, dpaGp: 'unknown' });
  });

  it('cache: the same rounded point is asked once; a new edition label asks again', async () => {
    const stub = stubService();
    const a = await locator.classifyLocation(selected(-32.2569, 148.6011), { geocoder: sameBuilding(-32.2569, 148.6011), env: REAL, fetchImpl: stub.fetchImpl });
    const b = await locator.classifyLocation(selected(-32.25691, 148.60112), { geocoder: sameBuilding(-32.25691, 148.60112), env: REAL, fetchImpl: stub.fetchImpl });
    expect(stub.calls.point).toBe(1);
    expect(b.dpaGp).toBe(a.dpaGp);
    await locator.classifyLocation(selected(-32.2569, 148.6011), { geocoder: sameBuilding(-32.2569, 148.6011), env: Object.assign({ AU_WORKFORCE_LOCATOR_EDITION: '2027' }, REAL), fetchImpl: stub.fetchImpl });
    expect(stub.calls.point).toBe(2);
    await locator.classifyLocation(selected(-33.815, 151.0011), { geocoder: sameBuilding(-33.815, 151.0011), env: REAL, fetchImpl: stub.fetchImpl });
    expect(stub.calls.point).toBe(3);
  });
  it('a failure is not cached', async () => {
    const stub = stubService({ failFirst: 2 });
    const first = await locator.classifyLocation(selected(-32.2569, 148.6011), { geocoder: sameBuilding(-32.2569, 148.6011), env: REAL, fetchImpl: stub.fetchImpl });
    expect(first.ok).toBe(false);
    const second = await locator.classifyLocation(selected(-32.2569, 148.6011), { geocoder: sameBuilding(-32.2569, 148.6011), env: REAL, fetchImpl: stub.fetchImpl });
    expect(second).toMatchObject({ ok: true, dpaGp: 'yes' });
  });
  it('the global rate limit: past it the answer is unknown and the service is not asked', async () => {
    const stub = stubService();
    const env = Object.assign({ AU_WORKFORCE_LOCATOR_MAX_PER_MINUTE: '2' }, REAL);
    const points = [[-32.2569, 148.6011], [-33.815, 151.0011], [-19.6484, 134.19]];
    const out = [];
    for (const [lat, lng] of points) out.push(await locator.classifyLocation(selected(lat, lng), { geocoder: sameBuilding(lat, lng), env, fetchImpl: stub.fetchImpl }));
    expect(out.map((r) => r.ok)).toEqual([true, true, false]);
    expect(out[2]).toMatchObject({ dpaGp: 'unknown', error: 'rate_limited' });
    expect(stub.calls.point).toBe(2);
  });

  describe('geocoding the written address (Nominatim, the geocoder the app already uses)', () => {
    const env = { AU_WORKFORCE_LOCATOR_PROVIDER: 'health_gov' };
    const written = { address: '14 Example Street, Dubbo NSW 2830', suburb: 'Dubbo', state: 'NSW', postcode: '2830' };
    it('found to the building: exact', async () => {
      const stub = stubService({ geocode: () => [{ lat: '-32.2569', lon: '148.6011', address: { house_number: '14', road: 'Example Street', postcode: '2830' } }] });
      const r = await locator.classifyLocation(written, { env, fetchImpl: stub.fetchImpl });
      expect(r).toMatchObject({ ok: true, dpaGp: 'yes', confidence: 'exact', method: 'geocoded_address' });
      expect(stub.calls.other.length).toBe(1);
      expect(stub.calls.other[0]).toContain('nominatim.openstreetmap.org/search');
      expect(stub.calls.other[0]).toContain('countrycodes=au');
    });
    it('the street but not the building: approximate, DPA unknown', async () => {
      const stub = stubService({ geocode: () => [{ lat: '-32.2569', lon: '148.6011', address: { road: 'Example Street', postcode: '2830' } }] });
      const r = await locator.classifyLocation(written, { env, fetchImpl: stub.fetchImpl });
      expect(r).toMatchObject({ ok: true, dpaGp: 'unknown', confidence: 'approximate', method: 'street_centroid' });
      expect(r.indicative.dpaGp).toBe('yes');
    });
    it('a different house number is not "the building"', async () => {
      const stub = stubService({ geocode: () => [{ lat: '-32.2569', lon: '148.6011', address: { house_number: '140', road: 'Example Street', postcode: '2830' } }] });
      const r = await locator.classifyLocation(written, { env, fetchImpl: stub.fetchImpl });
      expect(r.confidence).toBe('approximate');
    });
    it('a result in the wrong postcode is not used for the street', async () => {
      const stub = stubService({ geocode: (u) => (/q=14/.test(u) ? [{ lat: '-33.815', lon: '151.0011', address: { house_number: '14', postcode: '2150' } }] : [{ lat: '-32.2569', lon: '148.6011', address: {} }]) });
      const r = await locator.classifyLocation(written, { env, fetchImpl: stub.fetchImpl });
      expect(r).toMatchObject({ confidence: 'approximate', method: 'suburb_centroid' });
    }, 10000);
    it('nothing found: unknown', async () => {
      const stub = stubService({ geocode: () => [] });
      const r = await locator.classifyLocation(written, { env, fetchImpl: stub.fetchImpl });
      expect(r).toMatchObject({ ok: false, dpaGp: 'unknown', error: 'address_not_located' });
    }, 10000);
    it('a result outside Australia is ignored', async () => {
      const stub = stubService({ geocode: () => [{ lat: '51.5', lon: '-0.12', address: { house_number: '14' } }] });
      const r = await locator.classifyLocation(written, { env, fetchImpl: stub.fetchImpl });
      expect(r.ok).toBe(false);
    }, 10000);
  });

  describe('geocoding with Google when the owner turns it on', () => {
    const env = { AU_WORKFORCE_LOCATOR_PROVIDER: 'health_gov', AU_WORKFORCE_LOCATOR_GEOCODER: 'google', GOOGLE_MAPS_SERVER_API_KEY: 'test-key' };
    const written = { address: '14 Example Street, Dubbo NSW 2830', suburb: 'Dubbo', state: 'NSW', postcode: '2830' };
    const g = (extra) => () => ({ status: 'OK', results: [Object.assign({ geometry: { location: { lat: -32.2569, lng: 148.6011 }, location_type: 'ROOFTOP' }, types: ['street_address'] }, extra || {})] });
    it('a rooftop match: exact', async () => {
      const stub = stubService({ geocode: g() });
      const r = await locator.classifyLocation(written, { env, fetchImpl: stub.fetchImpl });
      expect(r).toMatchObject({ ok: true, dpaGp: 'yes', confidence: 'exact', method: 'geocoded_address' });
      expect(stub.calls.other[0]).toContain('maps.googleapis.com/maps/api/geocode/json');
    });
    it('a partial match, or only the suburb: approximate', async () => {
      for (const extra of [{ partial_match: true }, { types: ['locality'], geometry: { location: { lat: -32.2569, lng: 148.6011 }, location_type: 'APPROXIMATE' } }]) {
        locator._resetForTests();
        const stub = stubService({ geocode: g(extra) });
        const r = await locator.classifyLocation(written, { env, fetchImpl: stub.fetchImpl });
        expect(r).toMatchObject({ dpaGp: 'unknown', confidence: 'approximate' });
      }
    });
    it('without a key the existing geocoder is used instead', async () => {
      const stub = stubService({ geocode: () => [] });
      await locator.classifyLocation(written, { env: Object.assign({}, env, { GOOGLE_MAPS_SERVER_API_KEY: '' }), fetchImpl: stub.fetchImpl });
      expect(stub.calls.other.every((u) => u.includes('nominatim'))).toBe(true);
    }, 10000);
  });
});

describe('address helpers', () => {
  it('the street part', () => {
    expect(locator.streetOf({ address: '12 Example Street, Dubbo NSW 2830', suburb: 'Dubbo' })).toBe('12 example street');
    expect(locator.streetOf({ address: '12 Example Street Dubbo NSW 2830', suburb: 'Dubbo' })).toBe('12 example street');
    expect(locator.streetOf({ address: 'Dubbo NSW 2830', suburb: 'Dubbo' })).toBe('');
    expect(locator.streetOf({ address: '', suburb: 'Dubbo' })).toBe('');
    expect(locator.streetOf({ address: '2830' })).toBe('');
    expect(locator.streetOf({ address: 'Dubbo NSW 2830' })).toBe('');
    expect(locator.streetOf({ address: '5 Dubbo Road, Dubbo NSW 2830', suburb: 'Dubbo' })).toBe('5 dubbo road');
    expect(locator.streetOf({ address: 'Suite 4, 12 Example Street, Dubbo', suburb: 'Dubbo' })).toBe('suite 4 12 example street');
    expect(locator.streetOf({ address: '3/45 Main St', suburb: 'Dubbo' })).toBe('3 45 main st');
    expect(locator.streetOf({ address: 'Example Street', suburb: 'Dubbo' })).toBe('');
  });
  it('the address key changes when the place changes, not when the typing does', () => {
    const a = locator.addressKey({ address: '12 Example Street, Dubbo NSW 2830', suburb: 'Dubbo', state: 'nsw', postcode: '2830' });
    expect(locator.addressKey({ address: '12  example street,  Dubbo NSW 2830', suburb: ' DUBBO ', state: 'NSW', postcode: '2830' })).toBe(a);
    expect(locator.addressKey({ address: '14 Example Street, Dubbo NSW 2830', suburb: 'Dubbo', state: 'NSW', postcode: '2830' })).not.toBe(a);
    expect(locator.addressKey({ address: '12 Example Street', suburb: 'Orange', state: 'NSW', postcode: '2800' })).not.toBe(a);
  });
  it('Modified Monash words and codes', () => {
    expect(locator.mmmNumber('MM3')).toBe(3);
    expect(locator.mmmNumber('MM 7')).toBe(7);
    expect(locator.mmmNumber(1)).toBe(1);
    for (const v of ['', null, undefined, 'MM8', 0, 'metro', 'MM']) expect(locator.mmmNumber(v)).toBe(null);
    expect(locator.mmmCode(3)).toBe('MM3');
    expect(locator.mmmCode(null)).toBe('');
    expect(locator.mmmWords(3)).toBe('Large rural town (MM 3)');
    expect(locator.mmmWords(1)).toBe('Metropolitan (MM 1)');
    expect(locator.mmmWords(7)).toBe('Very remote community (MM 7)');
  });
});

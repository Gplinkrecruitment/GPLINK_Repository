// WP-29 of the Australian GP build: where a doctor is based, how far they
// would go, and how a practice compares. No server, no database, no network.
import { describe, it, expect } from 'vitest';

const loc = require('../lib/au-localities.js');
const m = require('../lib/au-location-match.js');
const pipeline = require('../lib/practice-pipeline.js');

const PARRAMATTA = 'loc:NSW:2150:parramatta';
const CAIRNS = 'loc:QLD:4870:cairns';
const HOBART = 'loc:TAS:7000:hobart';
const LAUNCESTON = 'loc:TAS:7250:launceston';
const OCONNOR_ACT = 'loc:ACT:2602:o-connor';
const DUBBO = 'loc:NSW:2830:dubbo';

const choose = (base, travel, places) => {
  const r = m.normaliseLocationChoice({ base, travel, places });
  if (!r.ok) throw new Error('test setup: ' + JSON.stringify(r.errors));
  return r.choice;
};

// Practices at known points. Some carry real coordinates, some only a suburb.
const SYDNEY_CBD = { id: 'syd', latitude: -33.8688, longitude: 151.2093, suburb: 'Sydney', location_state: 'NSW', postcode: '2000' };
const NEWCASTLE = { id: 'new', latitude: -32.9283, longitude: 151.7817, suburb: 'Newcastle', location_state: 'NSW', postcode: '2300' };
const MELBOURNE = { id: 'mel', latitude: -37.8136, longitude: 144.9631, suburb: 'Melbourne', location_state: 'VIC', postcode: '3000' };
const CAIRNS_ROW = { id: 'cns', latitude: -16.9186, longitude: 145.7405, suburb: 'Cairns', location_state: 'QLD', postcode: '4870' };
const DUBBO_ROW = { id: 'dbo', latitude: -32.2569, longitude: 148.6011, suburb: 'Dubbo', location_state: 'NSW', postcode: '2830' };
const NOWHERE = { id: 'unk', latitude: 0, longitude: 0 };
const ALL = [SYDNEY_CBD, NEWCASTLE, MELBOURNE, CAIRNS_ROW, DUBBO_ROW, NOWHERE];

const ALLOWED_LEGACY = pipeline.MAJOR_CITIES.map((c) => c.name)
  .concat(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT'].map((s) => 'Regional ' + s))
  .concat(['Anywhere in Australia']);

// Words that must never reach an Australian doctor from these modules.
const BANNED = [
  /MyIntealth/i, /\bAMC\b/, /\bEPIC\b/, /visa/i, /relocate/i, /relocation/i, /your move/i, /overseas/i,
  /internationally trained/i, /\bGMC\b/, /\bSPPA\b/, /Section G/i, /supervisor CV/i, /Not yet eligible/i,
];

function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.keys(value).forEach((k) => { out.push(k); collectStrings(value[k], out); });
  return out;
}

describe('constants', () => {
  it('has one commute radius and the four travel options', () => {
    expect(m.COMMUTE_RADIUS_KM).toBe(45);
    expect(m.TRAVEL).toEqual({ COMMUTE: 'commute', STATE: 'state', PLACES: 'places', ANYWHERE: 'anywhere' });
    expect(m.MAX_PLACES).toBe(20);
  });

  it('has the doctor-facing labels word for word', () => {
    expect(m.TRAVEL_LABELS).toEqual({
      commute: 'Within a commute of where I am now (about 45 minutes)',
      state: 'Anywhere in my state',
      places: 'Specific places',
      anywhere: 'Anywhere in Australia',
    });
  });
});

describe('validCoords and haversineKm', () => {
  it('accepts real points', () => {
    expect(m.validCoords(-33.8688, 151.2093)).toBe(true);
    expect(m.validCoords(0, 151)).toBe(true);
    expect(m.validCoords(-33, 0)).toBe(true);
    expect(m.validCoords(90, 180)).toBe(true);
  });

  it('rejects 0,0, missing values, text and points off the globe', () => {
    const bad = [
      [0, 0], [null, null], [undefined, undefined], ['', ''], [null, 151], [-33, null], ['-33.8', '151.2'],
      [NaN, 151], [-33, Infinity], [91, 151], [-91, 151], [-33, 181], [-33, -181], [{}, []], [true, true],
    ];
    bad.forEach((pair) => expect(m.validCoords(pair[0], pair[1])).toBe(false));
  });

  it('measures a known distance', () => {
    // Sydney to Melbourne is about 713 km in a straight line
    const km = m.haversineKm(-33.8688, 151.2093, -37.8136, 144.9631);
    expect(km).toBeGreaterThan(705);
    expect(km).toBeLessThan(720);
    expect(m.haversineKm(-33.8688, 151.2093, -33.8688, 151.2093)).toBe(0);
  });

  it('returns null, not 0, when either point is unknown', () => {
    expect(m.haversineKm(0, 0, -33.8688, 151.2093)).toBeNull();
    expect(m.haversineKm(-33.8688, 151.2093, 0, 0)).toBeNull();
    expect(m.haversineKm(null, null, -33.8688, 151.2093)).toBeNull();
    expect(m.haversineKm(-33.8688, 151.2093, undefined, undefined)).toBeNull();
    expect(m.haversineKm('', '', '', '')).toBeNull();
  });
});

describe('normaliseLocationChoice', () => {
  it('stores a commute choice with the place read from the dataset', () => {
    const r = m.normaliseLocationChoice({ base: PARRAMATTA, travel: 'commute' });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual({});
    expect(r.choice).toEqual({
      v: 1,
      base: { id: PARRAMATTA, kind: 'locality', name: 'Parramatta', state: 'NSW', postcode: '2150', lat: -33.8136, lng: 151.0034, label: 'Parramatta NSW 2150' },
      travel: 'commute',
      places: [],
    });
  });

  it('accepts a whole city as the base', () => {
    const r = m.normaliseLocationChoice({ base: 'city:perth', travel: 'anywhere' });
    expect(r.ok).toBe(true);
    expect(r.choice.base.label).toBe('Perth (whole city)');
  });

  it('never trusts coordinates or names sent by the browser', () => {
    const r = m.normaliseLocationChoice({
      base: { id: PARRAMATTA, name: 'Somewhere Else', state: 'WA', postcode: '6000', lat: 10, lng: 20, label: 'Fake', kind: 'city' },
      travel: 'places',
      places: [{ id: 'city:sydney', lat: -1, lng: 1, name: 'Fake City' }, { id: 'region:NSW', lat: 5, lng: 5 }],
    });
    expect(r.ok).toBe(true);
    expect(r.choice.base).toEqual(loc.getPlaceById(PARRAMATTA));
    expect(r.choice.base.lat).toBe(-33.8136);
    expect(r.choice.base.lng).toBe(151.0034);
    expect(r.choice.places).toEqual([loc.getPlaceById('city:sydney'), loc.getPlaceById('region:NSW')]);
    expect(r.choice.places[1].lat).toBeNull();
    expect(JSON.stringify(r.choice)).not.toMatch(/Fake|Somewhere Else/);
  });

  it('rejects a made-up or missing base', () => {
    [undefined, null, '', 'loc:NSW:2150:nowhere', 'parramatta', '__proto__', {}, { id: 'nope' }, { lat: -33, lng: 151 }, 5, []].forEach((base) => {
      const r = m.normaliseLocationChoice({ base, travel: 'commute' });
      expect(r.ok).toBe(false);
      expect(r.choice).toBeNull();
      expect(r.errors.base).toBe('Choose where you are based from the list.');
    });
  });

  it('rejects a region as the base', () => {
    const r = m.normaliseLocationChoice({ base: 'region:NSW', travel: 'state' });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual({ base: 'Choose where you are based from the list.' });
  });

  it('rejects an unknown travel value', () => {
    [undefined, null, '', 'far', 'COMMUTE', 'Anywhere', 5, {}, ['commute']].forEach((travel) => {
      const r = m.normaliseLocationChoice({ base: PARRAMATTA, travel });
      expect(r.ok).toBe(false);
      expect(r.errors).toEqual({ travel: 'Choose how far you would go.' });
    });
  });

  it('needs at least one place for "places"', () => {
    [undefined, null, [], 'city:sydney', {}].forEach((places) => {
      const r = m.normaliseLocationChoice({ base: PARRAMATTA, travel: 'places', places });
      expect(r.ok).toBe(false);
      expect(r.errors).toEqual({ places: 'Add at least one place.' });
    });
  });

  it('rejects a made-up place id', () => {
    const r = m.normaliseLocationChoice({ base: PARRAMATTA, travel: 'places', places: ['city:sydney', 'city:atlantis'] });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual({ places: 'Choose places from the list.' });
    expect(m.normaliseLocationChoice({ base: PARRAMATTA, travel: 'places', places: [null] }).errors.places).toBe('Choose places from the list.');
  });

  it('drops duplicate places and allows cities, regions and suburbs', () => {
    const c = choose(PARRAMATTA, 'places', ['city:sydney', LAUNCESTON, 'region:TAS', 'city:sydney', { id: LAUNCESTON }]);
    expect(c.places.map((p) => p.id)).toEqual(['city:sydney', LAUNCESTON, 'region:TAS']);
  });

  it('allows up to 20 places and no more', () => {
    const ids = loc.searchLocalities('20').concat(loc.searchLocalities('30'), loc.searchLocalities('40'), loc.searchLocalities('50')).map((p) => p.id);
    expect(new Set(ids).size).toBe(32);
    expect(m.normaliseLocationChoice({ base: PARRAMATTA, travel: 'places', places: ids.slice(0, 20) }).ok).toBe(true);
    const over = m.normaliseLocationChoice({ base: PARRAMATTA, travel: 'places', places: ids.slice(0, 21) });
    expect(over.ok).toBe(false);
    expect(over.errors).toEqual({ places: 'Choose up to 20 places.' });
    const huge = m.normaliseLocationChoice({ base: PARRAMATTA, travel: 'places', places: new Array(5000).fill('city:sydney') });
    expect(huge.ok).toBe(false);
  });

  it('stores no places for the other travel options, even if some were sent', () => {
    ['commute', 'state', 'anywhere'].forEach((travel) => {
      const r = m.normaliseLocationChoice({ base: PARRAMATTA, travel, places: ['city:sydney', 'city:atlantis'] });
      expect(r.ok).toBe(true);
      expect(r.choice.places).toEqual([]);
    });
  });

  it('reports every problem at once and never throws', () => {
    [undefined, null, 'x', 5, [], {}].forEach((raw) => {
      const r = m.normaliseLocationChoice(raw);
      expect(r.ok).toBe(false);
      expect(r.choice).toBeNull();
      expect(r.errors).toEqual({ base: 'Choose where you are based from the list.', travel: 'Choose how far you would go.' });
    });
  });
});

describe('readLocationChoice', () => {
  it('reads back what was stored, as an object or as JSON text', () => {
    const c = choose(PARRAMATTA, 'places', ['city:sydney', 'region:NSW']);
    expect(m.readLocationChoice(c)).toEqual(c);
    expect(m.readLocationChoice(JSON.stringify(c))).toEqual(c);
  });

  it('returns null for the wrong shape', () => {
    [undefined, null, '', ' ', 'not json', '[]', '5', 5, [], {}, { travel: 'commute' }, { base: loc.getPlaceById(PARRAMATTA) },
      { base: loc.getPlaceById(PARRAMATTA), travel: 'far' }, { base: loc.getPlaceById('region:NSW'), travel: 'state' },
      { base: { id: 5 }, travel: 'commute' }, { base: 'loc:NSW:2150:parramatta', travel: 'commute' }].forEach((stored) => {
      expect(m.readLocationChoice(stored)).toBeNull();
    });
  });

  it('drops places without an id and places for other travel options', () => {
    const base = loc.getPlaceById(PARRAMATTA);
    const read = m.readLocationChoice({ v: 1, base, travel: 'places', places: [{ name: 'No id', kind: 'city' }, null, 'city:sydney', loc.getPlaceById('city:sydney')] });
    expect(read.places.map((p) => p.id)).toEqual(['city:sydney']);
    expect(m.readLocationChoice({ v: 1, base, travel: 'commute', places: [loc.getPlaceById('city:sydney')] }).places).toEqual([]);
  });

  it('reads a stored 0,0 as unknown coordinates', () => {
    const read = m.readLocationChoice({ base: { id: 'loc:x', kind: 'locality', name: 'X', state: 'NSW', postcode: '2000', lat: 0, lng: 0 }, travel: 'commute' });
    expect(read.base.lat).toBeNull();
    expect(read.base.lng).toBeNull();
  });

  it('keeps a legacy choice with no base', () => {
    const read = m.readLocationChoice({ v: 1, base: null, travel: 'places', places: [loc.getPlaceById('city:sydney')], legacy: true });
    expect(read).toEqual({ v: 1, base: null, travel: 'places', places: [loc.getPlaceById('city:sydney')], legacy: true });
    expect(m.readLocationChoice({ v: 1, base: null, travel: 'places', places: [] })).toBeNull();
  });
});

describe('practiceLocationOf', () => {
  it('uses real coordinates first', () => {
    expect(m.practiceLocationOf(SYDNEY_CBD)).toEqual({ lat: -33.8688, lng: 151.2093, state: 'NSW', suburb: 'Sydney', postcode: '2000', basis: 'coordinates' });
    expect(m.practiceLocationOf({ lat: '-37.8136', lng: '144.9631', state: 'vic' })).toEqual({ lat: -37.8136, lng: 144.9631, state: 'VIC', suburb: null, postcode: null, basis: 'coordinates' });
  });

  it('reads 0,0 and nulls as unknown, never as a point', () => {
    [{ latitude: 0, longitude: 0 }, { latitude: null, longitude: null }, { latitude: '', longitude: '' }, { lat: 0, lng: 0 },
      { latitude: '0', longitude: '0' }, {}, null, undefined, 'x', 5].forEach((row) => {
      expect(m.practiceLocationOf(row)).toEqual({ lat: null, lng: null, state: null, suburb: null, postcode: null, basis: 'unknown' });
    });
  });

  it('looks the suburb up when the coordinates are 0,0', () => {
    expect(m.practiceLocationOf({ latitude: 0, longitude: 0, suburb: 'Dubbo', location_state: 'NSW' }))
      .toEqual({ lat: loc.getPlaceById(DUBBO).lat, lng: loc.getPlaceById(DUBBO).lng, state: 'NSW', suburb: 'Dubbo', postcode: null, basis: 'suburb' });
    expect(m.practiceLocationOf({ location_city: 'Cairns', state: 'QLD', location_postcode: '4870' }).basis).toBe('suburb');
  });

  it('falls back to the postcode, and reads the state from it', () => {
    const p = m.practiceLocationOf({ latitude: null, longitude: null, postcode: '3350' });
    expect(p.basis).toBe('postcode');
    expect(p.state).toBe('VIC');
    expect(p.lat).toBeCloseTo(-37.56, 1);
    expect(m.practiceLocationOf({ postcode: 800 }).state).toBe('NT');
  });

  it('stays unknown when nothing can be looked up', () => {
    expect(m.practiceLocationOf({ latitude: 0, longitude: 0, suburb: 'Nowhereville', location_state: 'NSW' }))
      .toEqual({ lat: null, lng: null, state: 'NSW', suburb: 'Nowhereville', postcode: null, basis: 'unknown' });
  });
});

describe('matchRoleLocation', () => {
  it('with no choice says so', () => {
    [null, undefined, {}, 'x', { travel: 'far' }].forEach((choice) => {
      expect(m.matchRoleLocation(choice, SYDNEY_CBD)).toEqual({ withinPreference: null, distanceKm: null, nearestChosenPlace: null, basis: 'no_choice', band: 'unknown' });
    });
  });

  it('commute: inside 45 km is in, outside is out', () => {
    const c = choose(PARRAMATTA, 'commute');
    expect(m.matchRoleLocation(c, SYDNEY_CBD)).toEqual({ withinPreference: true, distanceKm: 20, nearestChosenPlace: 'Parramatta', basis: 'coordinates', band: '10_to_25km' });
    const newcastle = m.matchRoleLocation(c, NEWCASTLE);
    expect(newcastle.withinPreference).toBe(false);
    expect(newcastle.distanceKm).toBeGreaterThan(110);
    expect(newcastle.distanceKm).toBeLessThan(135);
    expect(newcastle.band).toBe('over_100km');
    expect(m.matchRoleLocation(c, MELBOURNE).withinPreference).toBe(false);
    expect(m.matchRoleLocation(c, CAIRNS_ROW).withinPreference).toBe(false);
    expect(m.matchRoleLocation(c, CAIRNS_ROW).distanceKm).toBeGreaterThan(1900);
  });

  it('state: the same state is in, another state is out, distance is from the base', () => {
    const c = choose(PARRAMATTA, 'state');
    expect(m.matchRoleLocation(c, SYDNEY_CBD).withinPreference).toBe(true);
    expect(m.matchRoleLocation(c, NEWCASTLE).withinPreference).toBe(true);
    expect(m.matchRoleLocation(c, NEWCASTLE).nearestChosenPlace).toBe('Parramatta');
    expect(m.matchRoleLocation(c, MELBOURNE).withinPreference).toBe(false);
    expect(m.matchRoleLocation(c, CAIRNS_ROW).withinPreference).toBe(false);
    // state known, coordinates not: still judged, distance stays unknown
    const noPoint = m.matchRoleLocation(c, { location_state: 'NSW', latitude: 0, longitude: 0 });
    expect(noPoint).toEqual({ withinPreference: true, distanceKm: null, nearestChosenPlace: null, basis: 'unknown', band: 'unknown' });
    // coordinates known, state not: cannot be judged
    expect(m.matchRoleLocation(c, { latitude: -33.8688, longitude: 151.2093 }).withinPreference).toBeNull();
  });

  it('anywhere: always in, distance still from the base', () => {
    const c = choose(PARRAMATTA, 'anywhere');
    ALL.forEach((row) => expect(m.matchRoleLocation(c, row).withinPreference).toBe(true));
    expect(m.matchRoleLocation(c, MELBOURNE).nearestChosenPlace).toBe('Parramatta');
    expect(m.matchRoleLocation(c, MELBOURNE).distanceKm).toBeGreaterThan(690);
    expect(m.matchRoleLocation(c, NOWHERE).distanceKm).toBeNull();
  });

  it('places: within a commute of a chosen suburb or city is in', () => {
    const c = choose(PARRAMATTA, 'places', ['city:melbourne', CAIRNS]);
    const mel = m.matchRoleLocation(c, MELBOURNE);
    expect(mel).toEqual({ withinPreference: true, distanceKm: 0, nearestChosenPlace: 'Melbourne', basis: 'coordinates', band: 'within_10km' });
    expect(m.matchRoleLocation(c, CAIRNS_ROW).nearestChosenPlace).toBe('Cairns');
    expect(m.matchRoleLocation(c, CAIRNS_ROW).withinPreference).toBe(true);
    // the base is not one of the chosen places, so Sydney is out
    const syd = m.matchRoleLocation(c, SYDNEY_CBD);
    expect(syd.withinPreference).toBe(false);
    expect(syd.nearestChosenPlace).toBe('Melbourne');
    expect(syd.distanceKm).toBeGreaterThan(700);
  });

  it('places: "Regional X" means in that state and not near a major city', () => {
    const c = choose(PARRAMATTA, 'places', ['region:NSW']);
    expect(m.matchRoleLocation(c, DUBBO_ROW).withinPreference).toBe(true);
    expect(m.matchRoleLocation(c, SYDNEY_CBD).withinPreference).toBe(false);
    expect(m.matchRoleLocation(c, NEWCASTLE).withinPreference).toBe(false);
    expect(m.matchRoleLocation(c, MELBOURNE).withinPreference).toBe(false);
    // a region has no coordinates, so the distance falls back to the base
    expect(m.matchRoleLocation(c, DUBBO_ROW).nearestChosenPlace).toBe('Parramatta');
    expect(m.matchRoleLocation(c, DUBBO_ROW).distanceKm).toBeGreaterThan(250);
    // in the state but no coordinates: cannot tell whether it is near a city
    expect(m.matchRoleLocation(c, { location_state: 'NSW' }).withinPreference).toBeNull();
    // another state needs no coordinates to be ruled out
    expect(m.matchRoleLocation(c, { location_state: 'VIC' }).withinPreference).toBe(false);
  });

  it('places: a city and a region together', () => {
    const c = choose(PARRAMATTA, 'places', ['city:sydney', 'region:NSW']);
    expect(m.matchRoleLocation(c, SYDNEY_CBD).withinPreference).toBe(true);
    expect(m.matchRoleLocation(c, DUBBO_ROW).withinPreference).toBe(true);
    expect(m.matchRoleLocation(c, NEWCASTLE).withinPreference).toBe(false);
    expect(m.matchRoleLocation(c, NEWCASTLE).nearestChosenPlace).toBe('Sydney');
    expect(m.matchRoleLocation(c, NOWHERE).withinPreference).toBeNull();
  });

  it('0,0 and null practice coordinates are unknown: distance null, never 0', () => {
    ['commute', 'state', 'anywhere'].forEach((travel) => {
      const c = choose(PARRAMATTA, travel);
      [NOWHERE, { latitude: null, longitude: null }, { latitude: '', longitude: '' }, {}, null].forEach((row) => {
        const match = m.matchRoleLocation(c, row);
        expect(match.distanceKm).toBeNull();
        expect(match.distanceKm).not.toBe(0);
        expect(match.nearestChosenPlace).toBeNull();
        expect(match.band).toBe('unknown');
        expect(match.basis).toBe('unknown');
      });
    });
    expect(m.matchRoleLocation(choose(PARRAMATTA, 'commute'), NOWHERE).withinPreference).toBeNull();
    expect(m.matchRoleLocation(choose(PARRAMATTA, 'places', ['city:sydney']), NOWHERE).withinPreference).toBeNull();
  });

  it('0,0 with a suburb or postcode that can be looked up gets a real distance', () => {
    const c = choose(PARRAMATTA, 'commute');
    const bySuburb = m.matchRoleLocation(c, { latitude: 0, longitude: 0, suburb: 'Dubbo', location_state: 'NSW' });
    expect(bySuburb.basis).toBe('suburb');
    expect(bySuburb.withinPreference).toBe(false);
    expect(bySuburb.distanceKm).toBeGreaterThan(250);
    const byPostcode = m.matchRoleLocation(c, { latitude: 0, longitude: 0, postcode: '2150' });
    expect(byPostcode.basis).toBe('postcode');
    expect(byPostcode.withinPreference).toBe(true);
    expect(byPostcode.distanceKm).toBeLessThan(5);
  });

  it('a legacy choice with no base still judges places, and has no base distance', () => {
    const legacy = m.choiceFromLegacy({ locations: ['Sydney'] });
    expect(m.matchRoleLocation(legacy, SYDNEY_CBD).withinPreference).toBe(true);
    expect(m.matchRoleLocation(legacy, MELBOURNE).withinPreference).toBe(false);
    const regionOnly = m.choiceFromLegacy({ locations: ['Regional NSW'] });
    expect(m.matchRoleLocation(regionOnly, DUBBO_ROW)).toEqual({ withinPreference: true, distanceKm: null, nearestChosenPlace: null, basis: 'coordinates', band: 'unknown' });
  });
});

describe('distanceBand', () => {
  it('bands a distance', () => {
    expect(m.distanceBand(0)).toBe('within_10km');
    expect(m.distanceBand(10)).toBe('within_10km');
    expect(m.distanceBand(10.1)).toBe('10_to_25km');
    expect(m.distanceBand(25)).toBe('10_to_25km');
    expect(m.distanceBand(25.1)).toBe('25_to_45km');
    expect(m.distanceBand(45)).toBe('25_to_45km');
    expect(m.distanceBand(45.1)).toBe('45_to_100km');
    expect(m.distanceBand(100)).toBe('45_to_100km');
    expect(m.distanceBand(100.1)).toBe('over_100km');
    [null, undefined, '', '12', NaN, -1, {}].forEach((v) => expect(m.distanceBand(v)).toBe('unknown'));
  });
});

describe('locationLine', () => {
  const commute = choose(PARRAMATTA, 'commute');
  const line = (over) => m.locationLine(Object.assign({ withinPreference: true, distanceKm: 12, nearestChosenPlace: 'Parramatta', basis: 'coordinates', band: '10_to_25km' }, over), commute);

  it('says the distance in whole kilometres', () => {
    expect(line({})).toBe('About 12 km from Parramatta');
    expect(line({ distanceKm: 12.4 })).toBe('About 12 km from Parramatta');
    expect(line({ distanceKm: 1 })).toBe('About 1 km from Parramatta');
    expect(line({ distanceKm: 44.6 })).toBe('About 45 km from Parramatta');
  });

  it('says "Less than 1 km" under a kilometre', () => {
    expect(line({ distanceKm: 0.4 })).toBe('Less than 1 km from Parramatta');
    expect(line({ distanceKm: 0 })).toBe('Less than 1 km from Parramatta');
  });

  it('rounds to the nearest 10 from 100 km up', () => {
    expect(line({ distanceKm: 100 })).toBe('About 100 km from Parramatta');
    expect(line({ distanceKm: 122.1 })).toBe('About 120 km from Parramatta');
    expect(line({ distanceKm: 1967.3, withinPreference: null })).toBe('About 1970 km from Parramatta');
  });

  it('is honest about a role outside the area', () => {
    expect(line({ withinPreference: false, distanceKm: 312.2 })).toBe('Outside the area you chose · about 310 km from Parramatta');
    expect(line({ withinPreference: false, distanceKm: 60 })).toBe('Outside the area you chose · about 60 km from Parramatta');
    expect(line({ withinPreference: false, distanceKm: null, nearestChosenPlace: null })).toBe('Outside the area you chose');
  });

  it('with no distance, says only what is known', () => {
    const unknownIn = { withinPreference: true, distanceKm: null, nearestChosenPlace: null, basis: 'unknown', band: 'unknown' };
    expect(m.locationLine(unknownIn, choose(PARRAMATTA, 'state'))).toBe('In the state you chose');
    expect(m.locationLine(unknownIn, choose(PARRAMATTA, 'places', ['region:NSW']))).toBe('In an area you chose');
    expect(m.locationLine(unknownIn, choose(PARRAMATTA, 'anywhere'))).toBe('');
    expect(m.locationLine(Object.assign({}, unknownIn, { withinPreference: null }), commute)).toBe('');
    expect(m.locationLine(m.matchRoleLocation(null, SYDNEY_CBD), null)).toBe('');
    [null, undefined, 'x', 5, {}].forEach((match) => expect(m.locationLine(match, commute)).toBe(''));
  });

  it('works end to end from a real match', () => {
    expect(m.locationLine(m.matchRoleLocation(commute, SYDNEY_CBD), commute)).toBe('About 20 km from Parramatta');
    expect(m.locationLine(m.matchRoleLocation(commute, NEWCASTLE), commute)).toMatch(/^Outside the area you chose · about 1[12]0 km from Parramatta$/);
    expect(m.locationLine(m.matchRoleLocation(commute, NOWHERE), commute)).toBe('');
  });
});

describe('orderRolesByLocation', () => {
  const ids = (ordered) => ordered.map((o) => o.item.id);

  it('puts matches first and nearest first, and never drops a role', () => {
    const c = choose(PARRAMATTA, 'commute');
    const ordered = m.orderRolesByLocation(ALL, c);
    expect(ordered.length).toBe(ALL.length);
    expect(ids(ordered)).toEqual(['syd', 'new', 'dbo', 'mel', 'cns', 'unk']);
    expect(ordered[0].match.withinPreference).toBe(true);
    expect(ordered[5].match.distanceKm).toBeNull();
    ordered.forEach((o) => expect(ALL).toContain(o.item));
  });

  it('two doctors based in different places get different orders for the same roles', () => {
    const fromParramatta = ids(m.orderRolesByLocation(ALL, choose(PARRAMATTA, 'commute')));
    const fromCairns = ids(m.orderRolesByLocation(ALL, choose(CAIRNS, 'commute')));
    expect(fromCairns[0]).toBe('cns');
    expect(fromParramatta[0]).toBe('syd');
    expect(fromCairns).not.toEqual(fromParramatta);
    expect(fromCairns.slice().sort()).toEqual(fromParramatta.slice().sort());
  });

  it('state: every role in the state comes before the rest', () => {
    const ordered = m.orderRolesByLocation(ALL, choose(PARRAMATTA, 'state'));
    expect(ids(ordered)).toEqual(['syd', 'new', 'dbo', 'mel', 'cns', 'unk']);
    expect(ordered.slice(0, 3).every((o) => o.match.withinPreference === true)).toBe(true);
    expect(ordered.slice(3).every((o) => o.match.withinPreference !== true)).toBe(true);
  });

  it('within the matches, an unknown distance comes after a known one', () => {
    const stateOnly = { id: 'nsw-no-point', location_state: 'NSW' };
    const ordered = m.orderRolesByLocation([stateOnly, MELBOURNE, DUBBO_ROW, SYDNEY_CBD], choose(PARRAMATTA, 'state'));
    expect(ids(ordered)).toEqual(['syd', 'dbo', 'nsw-no-point', 'mel']);
  });

  it('is stable: ties keep the order they came in', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const c = { id: 'c' };
    const twinOne = Object.assign({}, SYDNEY_CBD, { id: 't1' });
    const twinTwo = Object.assign({}, SYDNEY_CBD, { id: 't2' });
    expect(ids(m.orderRolesByLocation([c, twinTwo, a, twinOne, b], choose(PARRAMATTA, 'commute')))).toEqual(['t2', 't1', 'c', 'a', 'b']);
    expect(ids(m.orderRolesByLocation([b, a, c], choose(PARRAMATTA, 'anywhere')))).toEqual(['b', 'a', 'c']);
  });

  it('with no choice keeps the incoming order exactly', () => {
    const ordered = m.orderRolesByLocation(ALL, null);
    expect(ordered.map((o) => o.item)).toEqual(ALL);
    ordered.forEach((o) => expect(o.match.basis).toBe('no_choice'));
  });

  it('reads the row through getRow, and survives a getRow that throws', () => {
    const wrapped = ALL.map((row) => ({ id: row.id, role: row }));
    const ordered = m.orderRolesByLocation(wrapped, choose(PARRAMATTA, 'commute'), (item) => item.role);
    expect(ids(ordered)).toEqual(['syd', 'new', 'dbo', 'mel', 'cns', 'unk']);
    const broken = m.orderRolesByLocation(wrapped, choose(PARRAMATTA, 'commute'), () => { throw new Error('no'); });
    expect(broken.length).toBe(wrapped.length);
    expect(ids(broken)).toEqual(wrapped.map((w) => w.id));
  });

  it('never drops anything, whatever the items are', () => {
    const odd = [null, undefined, 5, 'x', {}, [], NOWHERE, SYDNEY_CBD];
    ['commute', 'state', 'anywhere'].forEach((travel) => {
      expect(m.orderRolesByLocation(odd, choose(PARRAMATTA, travel)).length).toBe(odd.length);
    });
    expect(m.orderRolesByLocation(odd, choose(PARRAMATTA, 'places', ['region:NSW'])).length).toBe(odd.length);
    expect(m.orderRolesByLocation(null, choose(PARRAMATTA, 'commute'))).toEqual([]);
    expect(m.orderRolesByLocation(undefined, null)).toEqual([]);
  });
});

describe('legacyLocationsFor and preferredCityFor', () => {
  it('anywhere', () => {
    expect(m.legacyLocationsFor(choose(PARRAMATTA, 'anywhere'))).toEqual(['Anywhere in Australia']);
    expect(m.preferredCityFor(choose(PARRAMATTA, 'anywhere'))).toBe('');
  });

  it('state: the cities in the state, then its regional entry', () => {
    expect(m.legacyLocationsFor(choose(PARRAMATTA, 'state'))).toEqual(['Sydney', 'Newcastle', 'Wollongong', 'Regional NSW']);
    expect(m.legacyLocationsFor(choose(CAIRNS, 'state'))).toEqual(['Brisbane', 'Gold Coast', 'Sunshine Coast', 'Regional QLD']);
    expect(m.legacyLocationsFor(choose(HOBART, 'state'))).toEqual(['Hobart', 'Regional TAS']);
    expect(m.legacyLocationsFor(choose(OCONNOR_ACT, 'state'))).toEqual(['Canberra']);
    expect(m.legacyLocationsFor(choose('city:perth', 'state'))).toEqual(['Perth', 'Regional WA']);
    expect(m.preferredCityFor(choose(PARRAMATTA, 'state'))).toBe('Sydney');
  });

  it('commute: the nearest city within reach, otherwise the regional entry', () => {
    expect(m.legacyLocationsFor(choose(PARRAMATTA, 'commute'))).toEqual(['Sydney']);
    expect(m.legacyLocationsFor(choose('city:geelong', 'commute'))).toEqual(['Geelong']);
    expect(m.legacyLocationsFor(choose(CAIRNS, 'commute'))).toEqual(['Regional QLD']);
    expect(m.legacyLocationsFor(choose(DUBBO, 'commute'))).toEqual(['Regional NSW']);
    expect(m.legacyLocationsFor(choose(OCONNOR_ACT, 'commute'))).toEqual(['Canberra']);
    expect(m.preferredCityFor(choose(PARRAMATTA, 'commute'))).toBe('Sydney');
    expect(m.preferredCityFor(choose(CAIRNS, 'commute'))).toBe('');
  });

  it('places: each place in the old vocabulary, no repeats, in a stable order', () => {
    const c = choose(HOBART, 'places', [LAUNCESTON, 'region:TAS', 'city:melbourne', PARRAMATTA, 'city:sydney', DUBBO]);
    expect(m.legacyLocationsFor(c)).toEqual(['Regional TAS', 'Melbourne', 'Sydney', 'Regional NSW']);
    expect(m.legacyLocationsFor(c)).toEqual(m.legacyLocationsFor(c));
    expect(m.preferredCityFor(c)).toBe('Melbourne');
  });

  it('never returns more than 12', () => {
    const everything = loc.CITY_ENTRIES.map((c) => 'city:' + c.name.toLowerCase().replace(/ /g, '-')).concat(loc.REGION_ENTRIES.map((r) => 'region:' + r.state));
    const out = m.legacyLocationsFor(choose(PARRAMATTA, 'places', everything));
    expect(out.length).toBe(12);
    expect(new Set(out).size).toBe(12);
  });

  it('only ever returns strings from the fixed list', () => {
    const bases = [PARRAMATTA, CAIRNS, HOBART, LAUNCESTON, OCONNOR_ACT, DUBBO, 'loc:NT:0800:darwin', 'loc:WA:6000:perth', 'loc:SA:5000:adelaide', 'loc:VIC:3350:ballarat']
      .concat(loc.CITY_ENTRIES.map((c) => 'city:' + c.name.toLowerCase().replace(/ /g, '-')));
    const somePlaces = [PARRAMATTA, CAIRNS, LAUNCESTON, OCONNOR_ACT, 'city:darwin', 'region:NT', 'region:SA', 'loc:WA:6000:perth'];
    let checked = 0;
    bases.forEach((base) => {
      expect(loc.getPlaceById(base)).not.toBeNull();
      ['commute', 'state', 'places', 'anywhere'].forEach((travel) => {
        const out = m.legacyLocationsFor(choose(base, travel, somePlaces));
        expect(out.length).toBeGreaterThan(0);
        out.forEach((name) => {
          expect(ALLOWED_LEGACY).toContain(name);
          checked += 1;
        });
        const city = m.preferredCityFor(choose(base, travel, somePlaces));
        if (city) expect(pipeline.MAJOR_CITIES.map((c) => c.name)).toContain(city);
      });
    });
    expect(checked).toBeGreaterThan(100);
    // every suburb in a sample of the dataset maps into the list too
    const data = require('../data/au-localities.json');
    for (let i = 0; i < data.rows.length; i += 97) {
      const r = data.rows[i];
      const id = 'loc:' + r[1] + ':' + r[2] + ':' + r[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      m.legacyLocationsFor(choose(id, 'commute')).concat(m.legacyLocationsFor(choose(id, 'state'))).forEach((name) => {
        expect(ALLOWED_LEGACY).toContain(name);
      });
    }
  });

  it('returns [] for no choice, and tampered stored places cannot add new strings', () => {
    [null, undefined, {}, 'x'].forEach((c) => expect(m.legacyLocationsFor(c)).toEqual([]));
    const tampered = { v: 1, base: loc.getPlaceById(PARRAMATTA), travel: 'places', places: [
      { id: 'city:x', kind: 'city', name: 'Atlantis', state: 'NSW', lat: -33, lng: 151 },
      { id: 'region:x', kind: 'region', name: 'Regional Mars', state: 'ZZ' },
      { id: 'loc:x', kind: 'locality', name: 'X', state: 'ZZ', lat: 0, lng: 0 },
    ] };
    expect(m.legacyLocationsFor(tampered)).toEqual([]);
  });
});

describe('choiceFromLegacy', () => {
  it('"Anywhere in Australia" becomes the anywhere option', () => {
    const c = m.choiceFromLegacy({ locations: ['Sydney', 'Anywhere in Australia'], suburb: 'Parramatta', state: 'NSW', postcode: '2150' });
    expect(c).toEqual({ v: 1, base: loc.getPlaceById(PARRAMATTA), travel: 'anywhere', places: [], legacy: true });
    expect(m.legacyLocationsFor(c)).toEqual(['Anywhere in Australia']);
  });

  it('old pills become specific places', () => {
    const c = m.choiceFromLegacy({ locations: ['Sydney', 'Regional NSW', 'Gold Coast', 'Sydney', 'Not A Pill'], suburb: 'parramatta', state: 'nsw' });
    expect(c.travel).toBe('places');
    expect(c.legacy).toBe(true);
    expect(c.base.id).toBe(PARRAMATTA);
    expect(c.places.map((p) => p.id)).toEqual(['city:sydney', 'region:NSW', 'city:gold-coast']);
    // the old field survives the round trip unchanged
    expect(m.legacyLocationsFor(c)).toEqual(['Sydney', 'Regional NSW', 'Gold Coast']);
  });

  it('every old pill survives the round trip', () => {
    ALLOWED_LEGACY.forEach((pill) => {
      expect(m.legacyLocationsFor(m.choiceFromLegacy({ locations: [pill] }))).toEqual([pill]);
    });
  });

  it('the base may be missing', () => {
    const c = m.choiceFromLegacy({ locations: ['Melbourne'] });
    expect(c).toEqual({ v: 1, base: null, travel: 'places', places: [loc.getPlaceById('city:melbourne')], legacy: true });
    expect(m.readLocationChoice(JSON.stringify(c))).toEqual(c);
    expect(m.describeChoiceForStaff(c)).toBe('Base not recorded; specific places: Melbourne (whole city)');
  });

  it('falls back to the middle of the postcode for the base', () => {
    const c = m.choiceFromLegacy({ locations: ['Sydney'], suburb: 'Somewhere I Typed', state: 'NSW', postcode: '2150' });
    expect(c.base.postcode).toBe('2150');
    expect(c.base.state).toBe('NSW');
    expect(c.base.lat).toBeCloseTo(-33.81, 1);
    const onlyPostcode = m.choiceFromLegacy({ locations: [], postcode: '4870' });
    expect(onlyPostcode.base.state).toBe('QLD');
    expect(onlyPostcode.travel).toBe('places');
    expect(onlyPostcode.places).toEqual([]);
    // we know where they are but not how far they would go: nothing is judged
    expect(m.matchRoleLocation(onlyPostcode, CAIRNS_ROW).withinPreference).toBeNull();
    expect(m.matchRoleLocation(onlyPostcode, CAIRNS_ROW).distanceKm).toBeLessThan(15);
  });

  it('returns null when there is nothing to go on', () => {
    [undefined, null, {}, { locations: [] }, { locations: ['Not A Pill'] }, { locations: 'nonsense' }, { locations: [5, null, {}] },
      { suburb: 'Nowhereville', state: 'NSW' }, { postcode: '9999' }, { locations: null, suburb: '', state: '', postcode: '' }].forEach((input) => {
      expect(m.choiceFromLegacy(input)).toBeNull();
    });
  });

  it('accepts the pills as JSON text', () => {
    expect(m.choiceFromLegacy({ locations: '["Perth","Regional WA"]' }).places.map((p) => p.id)).toEqual(['city:perth', 'region:WA']);
    expect(m.choiceFromLegacy({ locations: 'Perth' }).places.map((p) => p.id)).toEqual(['city:perth']);
  });
});

describe('describeChoiceForStaff', () => {
  it('describes each travel option plainly', () => {
    expect(m.describeChoiceForStaff(choose(PARRAMATTA, 'commute'))).toBe('Based in Parramatta NSW 2150; within a commute (about 45 km)');
    expect(m.describeChoiceForStaff(choose(CAIRNS, 'state'))).toBe('Based in Cairns QLD 4870; anywhere in QLD');
    expect(m.describeChoiceForStaff(choose(HOBART, 'places', [LAUNCESTON, 'region:TAS']))).toBe('Based in Hobart TAS 7000; specific places: Launceston TAS 7250, Regional TAS');
    expect(m.describeChoiceForStaff(choose('city:perth', 'anywhere'))).toBe('Based in Perth (whole city); anywhere in Australia');
  });

  it('says when nothing is recorded', () => {
    [null, undefined, {}, 'x', { travel: 'far' }].forEach((c) => expect(m.describeChoiceForStaff(c)).toBe('Not recorded'));
    expect(m.describeChoiceForStaff(m.choiceFromLegacy({ locations: ['Anywhere in Australia'] }))).toBe('Base not recorded; anywhere in Australia');
    expect(m.describeChoiceForStaff(m.choiceFromLegacy({ postcode: '4870' }))).toMatch(/^Based in .+ QLD 4870; how far they would go is not recorded$/);
  });
});

describe('aiLocationFacts', () => {
  it('gives suburb-level facts for each travel option', () => {
    const commute = choose(PARRAMATTA, 'commute');
    expect(m.aiLocationFacts(commute, m.matchRoleLocation(commute, SYDNEY_CBD))).toEqual({
      travel_preference: 'within a commute of where they are based',
      based_in: 'Parramatta NSW',
      chosen_places: [],
      distance_band: '10 to 25 km',
      nearest_chosen_place: 'Parramatta',
      within_preference: true,
    });
    const places = choose(PARRAMATTA, 'places', ['city:sydney', 'region:NSW']);
    expect(m.aiLocationFacts(places, m.matchRoleLocation(places, NEWCASTLE))).toEqual({
      travel_preference: 'specific places',
      based_in: 'Parramatta NSW',
      chosen_places: ['Sydney', 'Regional NSW'],
      distance_band: 'over 100 km',
      nearest_chosen_place: 'Sydney',
      within_preference: false,
    });
    expect(m.aiLocationFacts(choose(CAIRNS, 'state'), null).travel_preference).toBe('anywhere in their state');
    expect(m.aiLocationFacts(choose(CAIRNS, 'anywhere'), null).travel_preference).toBe('anywhere in Australia');
  });

  it('words every distance band', () => {
    const c = choose(PARRAMATTA, 'anywhere');
    const band = (km) => m.aiLocationFacts(c, { distanceKm: km, band: m.distanceBand(km) }).distance_band;
    expect([5, 20, 40, 80, 500, null].map(band)).toEqual(['within 10 km', '10 to 25 km', '25 to 45 km', '45 to 100 km', 'over 100 km', 'unknown']);
    expect(m.aiLocationFacts(c, { distanceKm: 5 }).distance_band).toBe('within 10 km');
    expect(m.aiLocationFacts(c, undefined).distance_band).toBe('unknown');
  });

  it('never puts a postcode, a number or coordinates in based_in or the place names', () => {
    const bases = [PARRAMATTA, CAIRNS, HOBART, OCONNOR_ACT, 'loc:NT:0800:darwin', 'city:gold-coast'];
    bases.forEach((base) => {
      ['commute', 'state', 'places', 'anywhere'].forEach((travel) => {
        const c = choose(base, travel, [LAUNCESTON, 'city:sydney', 'region:NSW', PARRAMATTA]);
        ALL.forEach((row) => {
          const facts = m.aiLocationFacts(c, m.matchRoleLocation(c, row));
          expect(facts.based_in).not.toMatch(/\d/);
          expect(facts.based_in).toMatch(/^[A-Za-z' -]+ (NSW|VIC|QLD|WA|SA|TAS|NT|ACT)$/);
          facts.chosen_places.forEach((name) => expect(name).not.toMatch(/\d/));
          if (facts.nearest_chosen_place !== null) expect(facts.nearest_chosen_place).not.toMatch(/\d/);
          expect(Object.keys(facts).sort()).toEqual(['based_in', 'chosen_places', 'distance_band', 'nearest_chosen_place', 'travel_preference', 'within_preference']);
          expect(JSON.stringify(facts)).not.toMatch(/-?\d+\.\d{3,}/);
        });
      });
    });
  });

  it('strips digits even from a stored name that should not have had any', () => {
    const stored = { v: 1, base: { id: 'loc:x', kind: 'locality', name: '12 Smith Street Parramatta 2150', state: 'NSW', postcode: '2150', lat: -33.8, lng: 151 }, travel: 'places',
      places: [{ id: 'loc:y', kind: 'locality', name: 'Unit 4 Ballarat 3350', state: 'VIC', lat: -37.5, lng: 143.8 }] };
    const facts = m.aiLocationFacts(stored, { nearestChosenPlace: 'Ballarat 3350', distanceKm: 3 });
    expect(facts.based_in).toBe('Smith Street Parramatta NSW');
    expect(facts.chosen_places).toEqual(['Unit Ballarat']);
    expect(facts.nearest_chosen_place).toBe('Ballarat');
  });

  it('names at most 8 chosen places', () => {
    const ids = loc.searchLocalities('20').concat(loc.searchLocalities('30')).map((p) => p.id);
    expect(m.aiLocationFacts(choose(PARRAMATTA, 'places', ids), null).chosen_places.length).toBe(8);
  });

  it('with no choice says so', () => {
    expect(m.aiLocationFacts(null, null)).toEqual({
      travel_preference: 'not recorded', based_in: null, chosen_places: [], distance_band: 'unknown', nearest_chosen_place: null, within_preference: null,
    });
    expect(m.aiLocationFacts(m.choiceFromLegacy({ locations: ['Sydney'] }), null).based_in).toBeNull();
  });
});

describe('wording', () => {
  it('no banned word in any string these modules return for a set of sample inputs', () => {
    const strings = [];
    collectStrings(m.TRAVEL_LABELS, strings);
    collectStrings(m.TRAVEL, strings);
    collectStrings(loc.CITY_ENTRIES.map((c) => loc.placeFromLegacyPill(c.name)), strings);
    collectStrings(loc.REGION_ENTRIES.map((r) => loc.placeFromLegacyPill(r.name)), strings);
    ['parra', 'sydney', 'regional', 'nsw', '2150', 'paramatta', 'cairns'].forEach((q) => collectStrings(loc.searchLocalities(q), strings));
    [undefined, {}, { base: 'region:NSW', travel: 'x' }, { base: PARRAMATTA, travel: 'places' }, { base: PARRAMATTA, travel: 'places', places: ['nope'] },
      { base: PARRAMATTA, travel: 'places', places: new Array(30).fill(0).map((_, i) => 'x' + i) }].forEach((raw) => {
      collectStrings(m.normaliseLocationChoice(raw), strings);
    });
    const choices = [
      null,
      choose(PARRAMATTA, 'commute'), choose(PARRAMATTA, 'state'), choose(PARRAMATTA, 'anywhere'),
      choose(PARRAMATTA, 'places', ['city:sydney', 'region:NSW', LAUNCESTON]), choose('city:perth', 'commute'),
      m.choiceFromLegacy({ locations: ['Sydney', 'Regional QLD'] }), m.choiceFromLegacy({ postcode: '4870' }),
      m.choiceFromLegacy({ locations: ['Anywhere in Australia'] }),
    ];
    const rows = ALL.concat([{ location_state: 'NSW' }, { location_state: 'VIC' }, { postcode: '2150' }, {}, null]);
    choices.forEach((c) => {
      collectStrings(c, strings);
      strings.push(m.describeChoiceForStaff(c));
      strings.push(m.preferredCityFor(c));
      collectStrings(m.legacyLocationsFor(c), strings);
      rows.forEach((row) => {
        const match = m.matchRoleLocation(c, row);
        collectStrings(match, strings);
        strings.push(m.locationLine(match, c));
        collectStrings(m.aiLocationFacts(c, match), strings);
        collectStrings(m.practiceLocationOf(row), strings);
      });
      collectStrings(m.orderRolesByLocation(rows, c).map((o) => o.match), strings);
    });
    [5, 20, 40, 80, 500, null].forEach((km) => strings.push(m.distanceBand(km)));
    [0.3, 12, 60, 310].forEach((km) => {
      [true, false, null].forEach((within) => {
        strings.push(m.locationLine({ withinPreference: within, distanceKm: km, nearestChosenPlace: 'Parramatta' }, choices[1]));
        strings.push(m.locationLine({ withinPreference: within, distanceKm: null, nearestChosenPlace: null }, choices[2]));
        strings.push(m.locationLine({ withinPreference: within, distanceKm: null, nearestChosenPlace: null }, choices[4]));
      });
    });

    expect(strings.length).toBeGreaterThan(500);
    const hits = [];
    strings.forEach((s) => {
      BANNED.forEach((re) => { if (re.test(s)) hits.push(s); });
    });
    expect(hits).toEqual([]);
  });
});

// WP-29 of the Australian GP build: the suburb list and the search over it.
// No server, no database, no network.
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const loc = require('../lib/au-localities.js');
const pipeline = require('../lib/practice-pipeline.js');

const DATA_PATH = path.join(__dirname, '..', 'data', 'au-localities.json');
const data = require('../data/au-localities.json');

const labels = (list) => list.map((p) => p.label);
const firstLocality = (list) => list.filter((p) => p.kind === 'locality')[0];

describe('the dataset', () => {
  it('loads with its header fields', () => {
    expect(data.v).toBe(1);
    expect(typeof data.source).toBe('string');
    expect(data.source).toMatch(/Matthew Proctor/);
    expect(data.generated).toBe('2026-11-25');
    expect(Array.isArray(data.rows)).toBe(true);
  });

  it('has more than 10,000 rows and every one is indexed', () => {
    expect(data.rows.length).toBeGreaterThan(10000);
    expect(loc.stats()).toEqual({ rows: data.rows.length, cities: 13, regions: 7 });
  });

  it('every row has a name, a valid state, a 4-digit postcode and coordinates inside Australia', () => {
    const bad = data.rows.filter((r) => !(
      Array.isArray(r) && r.length === 5
      && typeof r[0] === 'string' && r[0].length >= 2 && r[0] === r[0].trim()
      && loc.AU_STATES.includes(r[1])
      && typeof r[2] === 'string' && /^\d{4}$/.test(r[2])
      && typeof r[3] === 'number' && typeof r[4] === 'number'
      && r[3] >= -44.5 && r[3] <= -9 && r[4] >= 112 && r[4] <= 154.5
    ));
    expect(bad).toEqual([]);
  });

  it('has no row at 0,0 and no row with more than 4 decimal places', () => {
    expect(data.rows.filter((r) => r[3] === 0 || r[4] === 0)).toEqual([]);
    const tooFine = data.rows.filter((r) => Math.abs(r[3] * 10000 - Math.round(r[3] * 10000)) > 1e-6
      || Math.abs(r[4] * 10000 - Math.round(r[4] * 10000)) > 1e-6);
    expect(tooFine).toEqual([]);
  });

  it('has no duplicate ids', () => {
    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const ids = new Set(data.rows.map((r) => 'loc:' + r[1] + ':' + r[2] + ':' + slug(r[0])));
    expect(ids.size).toBe(data.rows.length);
  });

  it('is sorted by state, then name, then postcode', () => {
    for (let i = 1; i < data.rows.length; i += 1) {
      const a = data.rows[i - 1];
      const b = data.rows[i];
      const sa = loc.AU_STATES.indexOf(a[1]);
      const sb = loc.AU_STATES.indexOf(b[1]);
      const ordered = sa < sb
        || (sa === sb && a[0].toLowerCase() < b[0].toLowerCase())
        || (sa === sb && a[0].toLowerCase() === b[0].toLowerCase() && a[2] <= b[2]);
      if (!ordered) throw new Error('out of order at row ' + i + ': ' + JSON.stringify([a, b]));
    }
  });

  it('is under 1.6 MB', () => {
    expect(fs.statSync(DATA_PATH).size).toBeLessThan(1.6 * 1024 * 1024);
  });

  it('writes names in Title Case and keeps leading zeros', () => {
    const names = new Set(data.rows.map((r) => r[0] + '|' + r[1] + '|' + r[2]));
    expect(names.has('Parramatta|NSW|2150')).toBe(true);
    expect(names.has('McMahons Point|NSW|2060')).toBe(true);
    expect(names.has("O'Connor|ACT|2602")).toBe(true);
    expect(names.has('Mount Isa|QLD|4825')).toBe(true);
    expect(names.has('St Kilda|VIC|3182')).toBe(true);
    expect(names.has('Darwin|NT|0800')).toBe(true);
    expect(data.rows.filter((r) => r[0] === r[0].toUpperCase() && r[0].length > 3)).toEqual([]);
  });

  it('leaves out PO-box and bulk-mail postcodes', () => {
    expect(data.rows.filter((r) => /^1\d{3}$/.test(r[2]) || /^8\d{3}$/.test(r[2]) || /^9\d{3}$/.test(r[2]))).toEqual([]);
    expect(data.rows.filter((r) => / (Mc|Dc|Bc|Gpo)$/.test(r[0]))).toEqual([]);
  });
});

describe('the fixed entries', () => {
  it('exports the eight states', () => {
    expect(loc.AU_STATES).toEqual(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'ACT']);
  });

  it('has the 13 cities from MAJOR_CITIES, in order, each with its state', () => {
    expect(loc.CITY_ENTRIES.map((c) => c.name)).toEqual(pipeline.MAJOR_CITIES.map((c) => c.name));
    const states = {};
    loc.CITY_ENTRIES.forEach((c) => { states[c.name] = c.state; });
    expect(states).toEqual({
      Sydney: 'NSW', Melbourne: 'VIC', Brisbane: 'QLD', Perth: 'WA', Adelaide: 'SA', Canberra: 'ACT',
      Hobart: 'TAS', Darwin: 'NT', 'Gold Coast': 'QLD', Newcastle: 'NSW', Wollongong: 'NSW',
      'Sunshine Coast': 'QLD', Geelong: 'VIC',
    });
    loc.CITY_ENTRIES.forEach((c, i) => {
      expect(c.lat).toBe(pipeline.MAJOR_CITIES[i].lat);
      expect(c.lng).toBe(pipeline.MAJOR_CITIES[i].lng);
      expect(c.capital).toBe(pipeline.MAJOR_CITIES[i].capital);
    });
  });

  it('has seven regions and none for the ACT', () => {
    expect(loc.REGION_ENTRIES.map((r) => r.name)).toEqual([
      'Regional NSW', 'Regional VIC', 'Regional QLD', 'Regional WA', 'Regional SA', 'Regional TAS', 'Regional NT',
    ]);
    expect(loc.REGION_ENTRIES.some((r) => r.state === 'ACT')).toBe(false);
  });
});

describe('searchLocalities', () => {
  it('"parra" finds Parramatta NSW 2150, first among the suburbs', () => {
    const res = loc.searchLocalities('parra');
    expect(firstLocality(res)).toEqual({
      id: 'loc:NSW:2150:parramatta',
      kind: 'locality',
      name: 'Parramatta',
      state: 'NSW',
      postcode: '2150',
      lat: -33.8136,
      lng: 151.0034,
      label: 'Parramatta NSW 2150',
    });
    // a later word that starts with the text is found too
    expect(labels(res)).toContain('North Parramatta NSW 2151');
    // names that start with the text come before names that only contain it
    expect(labels(res).indexOf('Parramatta Park QLD 4870')).toBeLessThan(labels(res).indexOf('North Parramatta NSW 2151'));
  });

  it('a postcode lists the suburbs in it, by postcode then name', () => {
    const res = loc.searchLocalities('2150');
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((p) => p.postcode === '2150' && p.kind === 'locality')).toBe(true);
    expect(labels(res)).toContain('Parramatta NSW 2150');
    expect(res.map((p) => p.name)).toEqual(res.map((p) => p.name).slice().sort());
  });

  it('part of a postcode matches from the start, and leading zeros work', () => {
    const res = loc.searchLocalities('08');
    expect(res.length).toBe(8);
    expect(res.every((p) => p.postcode.startsWith('08'))).toBe(true);
    expect(res.map((p) => p.postcode)).toEqual(res.map((p) => p.postcode).slice().sort());
    expect(res[0].label).toBe('Darwin NT 0800');
    expect(loc.searchLocalities('215').every((p) => p.postcode.startsWith('215'))).toBe(true);
    expect(loc.searchLocalities('21500')).toEqual([]);
  });

  it('finds Ballarat in VIC and Cairns in QLD first', () => {
    expect(loc.searchLocalities('ballarat')[0].label).toBe('Ballarat VIC 3350');
    expect(loc.searchLocalities('cairns')[0].label).toBe('Cairns QLD 4870');
    expect(loc.searchLocalities('BALLARAT')[0].label).toBe('Ballarat VIC 3350');
    expect(loc.searchLocalities('  cairns  ')[0].label).toBe('Cairns QLD 4870');
  });

  it('a state code or postcode after the name narrows the search', () => {
    const nsw = loc.searchLocalities('Parramatta nsw');
    expect(nsw[0].label).toBe('Parramatta NSW 2150');
    expect(nsw.every((p) => p.state === 'NSW')).toBe(true);

    const vic = loc.searchLocalities('richmond vic');
    expect(vic.length).toBeGreaterThan(0);
    expect(vic.every((p) => p.state === 'VIC')).toBe(true);
    expect(vic[0].label).toBe('Richmond VIC 3121');

    expect(labels(loc.searchLocalities('parramatta 2150'))).toEqual(['Parramatta NSW 2150']);
    expect(labels(loc.searchLocalities('parramatta nsw 2150'))).toEqual(['Parramatta NSW 2150']);
    expect(loc.searchLocalities('2150 nsw').every((p) => p.postcode === '2150' && p.state === 'NSW')).toBe(true);
  });

  it('forgives small typos', () => {
    expect(labels(loc.searchLocalities('paramatta'))).toContain('Parramatta NSW 2150');
    expect(labels(loc.searchLocalities('balarat'))).toContain('Ballarat VIC 3350');
    expect(labels(loc.searchLocalities('balarat'))[0]).toBe('Ballarat VIC 3350');
    expect(labels(loc.searchLocalities('cairnes'))[0]).toBe('Cairns QLD 4870');
    expect(labels(loc.searchLocalities('melborne'))[0]).toBe('Melbourne (whole city)');
    expect(labels(loc.searchLocalities('arramatta'))).toContain('Parramatta NSW 2150');
  });

  it('ignores apostrophes and hyphens when comparing', () => {
    expect(labels(loc.searchLocalities('oconnor'))).toContain("O'Connor ACT 2602");
    expect(labels(loc.searchLocalities("o'connor"))).toContain("O'Connor ACT 2602");
    expect(labels(loc.searchLocalities('mount isa'))[0]).toBe('Mount Isa QLD 4825');
  });

  it('returns [] when nothing matches', () => {
    expect(loc.searchLocalities('zzzzqq')).toEqual([]);
  });

  it('returns [] for fewer than two usable characters', () => {
    ['', ' ', 'p', '2', ' p ', '!', '!!!!', 'p!', '@#$%^&*'].forEach((q) => {
      expect(loc.searchLocalities(q)).toEqual([]);
    });
  });

  it('never throws, whatever is passed in', () => {
    const junk = [
      undefined, null, 0, 1, NaN, Infinity, true, false, {}, [], () => 1, Symbol('x'),
      { toString() { throw new Error('no'); } },
      'x'.repeat(500), '<script>'.repeat(60), '\u0000￿\ud83d', "'''''", '-----', '     ', '%%%%', 'a'.repeat(60),
      '../../etc/passwd', '__proto__', 'constructor', 'regional regional regional',
    ];
    junk.forEach((q) => {
      let res;
      expect(() => { res = loc.searchLocalities(q); }).not.toThrow();
      expect(Array.isArray(res)).toBe(true);
      expect(res.length).toBeLessThanOrEqual(8);
    });
    expect(() => loc.searchLocalities('parra', null)).not.toThrow();
    expect(() => loc.searchLocalities('parra', 'x')).not.toThrow();
    expect(() => loc.searchLocalities('parra', { limit: {} })).not.toThrow();
  });

  it('500 characters of junk is cut down and finds nothing', () => {
    expect(loc.searchLocalities('q7!'.repeat(167))).toEqual([]);
    // only the first 60 characters count
    expect(labels(loc.searchLocalities('parramatta' + '!'.repeat(50) + 'zzzz'))).toContain('Parramatta NSW 2150');
    expect(loc.searchLocalities('parramatta' + '!'.repeat(40) + 'zzzz')).toEqual([]);
  });

  it('never returns more than 8, and honours a smaller limit', () => {
    ['a', 'ab', 'st', 'mount', 'north', 'new', 'wa', '2', '20', '3', 'regional', 'park', 'ee'].forEach((q) => {
      expect(loc.searchLocalities(q).length).toBeLessThanOrEqual(8);
      expect(loc.searchLocalities(q, { limit: 500 }).length).toBeLessThanOrEqual(8);
    });
    expect(loc.searchLocalities('mount', { limit: 3 }).length).toBe(3);
    expect(loc.searchLocalities('mount', { limit: 1 }).length).toBe(1);
    expect(loc.searchLocalities('mount', { limit: 0 }).length).toBe(1);
    expect(loc.searchLocalities('mount', { limit: -4 }).length).toBe(1);
    expect(loc.searchLocalities('mount', { limit: 'lots' }).length).toBe(8);
    expect(loc.searchLocalities('mount').length).toBe(8);
  });

  it('never returns the same place twice', () => {
    ['parra', 'sydney', 'regional', 'nsw', 'perth', 'paramatta', 'newcastle', 'st kil', '2000'].forEach((q) => {
      const ids = loc.searchLocalities(q).map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  it('"sydney" offers the whole-city entry first', () => {
    const res = loc.searchLocalities('sydney');
    expect(res[0]).toEqual({
      id: 'city:sydney',
      kind: 'city',
      name: 'Sydney',
      state: 'NSW',
      postcode: null,
      lat: -33.8688,
      lng: 151.2093,
      label: 'Sydney (whole city)',
    });
    expect(res[1].label).toBe('Sydney NSW 2000');
  });

  it('every city name offers its whole-city entry first', () => {
    loc.CITY_ENTRIES.forEach((c) => {
      const res = loc.searchLocalities(c.name);
      expect(res[0].kind).toBe('city');
      expect(res[0].label).toBe(c.name + ' (whole city)');
    });
  });

  it('"regional" lists the regions and more letters narrow them', () => {
    expect(labels(loc.searchLocalities('regional'))).toEqual([
      'Regional NSW', 'Regional VIC', 'Regional QLD', 'Regional WA', 'Regional SA', 'Regional TAS', 'Regional NT',
    ]);
    expect(labels(loc.searchLocalities('regional n'))).toEqual(['Regional NSW', 'Regional NT']);
    expect(labels(loc.searchLocalities('regional nsw'))).toEqual(['Regional NSW']);
    expect(loc.searchLocalities('regional')[0]).toEqual({
      id: 'region:NSW', kind: 'region', name: 'Regional NSW', state: 'NSW', postcode: null, lat: null, lng: null, label: 'Regional NSW',
    });
  });

  it('a state code on its own offers that state\'s region first', () => {
    ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT'].forEach((s) => {
      expect(loc.searchLocalities(s.toLowerCase())[0].label).toBe('Regional ' + s);
    });
    // the ACT has no region
    expect(loc.searchLocalities('act').every((p) => p.kind !== 'region')).toBe(true);
  });

  it('a search stays fast after warm-up', () => {
    loc.searchLocalities('warm up');
    const queries = ['parra', 'paramatta', 'balarat', 'cairnes', 'sydney', 'regional', '2150', 'st', 'zzzzqq', 'x'.repeat(500)];
    queries.forEach((q) => {
      let best = Infinity;
      for (let i = 0; i < 5; i += 1) {
        const start = process.hrtime.bigint();
        loc.searchLocalities(q);
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        if (ms < best) best = ms;
      }
      expect(best).toBeLessThan(50);
    });
  });
});

describe('getPlaceById', () => {
  it('round-trips every search result', () => {
    ['parra', '2150', 'ballarat', 'cairns', 'sydney', 'regional', 'nsw', 'paramatta', 'perth', "o'connor", '08', 'gold coast'].forEach((q) => {
      const res = loc.searchLocalities(q);
      expect(res.length).toBeGreaterThan(0);
      res.forEach((p) => {
        expect(loc.getPlaceById(p.id)).toEqual(p);
      });
    });
  });

  it('round-trips every row in the dataset', () => {
    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    let missing = 0;
    data.rows.forEach((r) => {
      const p = loc.getPlaceById('loc:' + r[1] + ':' + r[2] + ':' + slug(r[0]));
      if (!p || p.name !== r[0] || p.lat !== r[3] || p.lng !== r[4]) missing += 1;
    });
    expect(missing).toBe(0);
  });

  it('gives a fresh object each time', () => {
    const a = loc.getPlaceById('loc:NSW:2150:parramatta');
    a.lat = 1;
    a.name = 'Changed';
    expect(loc.getPlaceById('loc:NSW:2150:parramatta').lat).toBe(-33.8136);
    expect(loc.getPlaceById('loc:NSW:2150:parramatta').name).toBe('Parramatta');
  });

  it('rejects junk ids', () => {
    const junk = [
      undefined, null, '', ' ', 0, 1, true, {}, [], { id: 'city:sydney' }, ['city:sydney'],
      '__proto__', 'constructor', 'toString', 'loc:__proto__', 'city:__proto__', 'region:__proto__', 'city:constructor',
      'region:constructor', 'loc:constructor', 'loc:NSW:2150:nowhere', 'loc:VIC:2150:parramatta', 'loc:NSW:2150:Parramatta',
      'LOC:NSW:2150:parramatta', 'loc:NSW:2150:parramatta ', ' loc:NSW:2150:parramatta', 'city:Sydney', 'city:atlantis',
      'region:ACT', 'region:nsw', 'region:', 'city:', 'loc:', 'parramatta', 'x'.repeat(5000), 'loc:' + 'a'.repeat(5000),
    ];
    junk.forEach((id) => {
      let res;
      expect(() => { res = loc.getPlaceById(id); }).not.toThrow();
      expect(res).toBeNull();
    });
  });

  it('resolves every city and region id', () => {
    loc.CITY_ENTRIES.forEach((c) => {
      const p = loc.getPlaceById('city:' + c.name.toLowerCase().replace(/ /g, '-'));
      expect(p.kind).toBe('city');
      expect(p.name).toBe(c.name);
      expect(p.postcode).toBeNull();
    });
    loc.REGION_ENTRIES.forEach((r) => {
      const p = loc.getPlaceById('region:' + r.state);
      expect(p).toEqual({ id: 'region:' + r.state, kind: 'region', name: r.name, state: r.state, postcode: null, lat: null, lng: null, label: r.name });
    });
  });
});

describe('findLocality', () => {
  it('finds an exact suburb whatever the letter case', () => {
    expect(loc.findLocality({ name: 'parramatta', state: 'nsw', postcode: '2150' }).id).toBe('loc:NSW:2150:parramatta');
    expect(loc.findLocality({ name: '  PARRAMATTA ', state: ' NSW ', postcode: 2150 }).id).toBe('loc:NSW:2150:parramatta');
    expect(loc.findLocality({ name: 'oconnor', state: 'ACT' }).label).toBe("O'Connor ACT 2602");
  });

  it('accepts name + state alone, taking the first postcode when there are several', () => {
    expect(loc.findLocality({ name: 'Parramatta', state: 'NSW' }).postcode).toBe('2150');
    expect(loc.findLocality({ name: 'Melbourne', state: 'VIC' }).postcode).toBe('3000');
    expect(loc.findLocality({ name: 'Darwin', state: 'NT' }).postcode).toBe('0800');
  });

  it('keeps a leading zero when the postcode arrives as a number', () => {
    expect(loc.findLocality({ name: 'Darwin', state: 'NT', postcode: 800 }).postcode).toBe('0800');
  });

  it('does not find a suburb in the wrong state', () => {
    expect(loc.findLocality({ name: 'Parramatta', state: 'VIC' })).toBeNull();
    expect(loc.findLocality({ name: 'Parramatta', state: 'ZZ' })).toBeNull();
    expect(loc.findLocality({ name: 'Nowhereville', state: 'NSW' })).toBeNull();
  });

  it('a name with no state is only accepted when there is one such place in the country', () => {
    expect(loc.findLocality({ name: 'Parramatta' }).id).toBe('loc:NSW:2150:parramatta');
    // Perth is in WA and in TAS
    expect(loc.findLocality({ name: 'Perth' })).toBeNull();
    expect(loc.findLocality({ name: 'Perth', postcode: '7300' }).state).toBe('TAS');
  });

  it('a postcode alone is not enough', () => {
    expect(loc.findLocality({ postcode: '2150' })).toBeNull();
    expect(loc.findLocality({ postcode: '2150', state: 'NSW' })).toBeNull();
    expect(loc.findLocality({ postcode: '2150' }, {})).toBeNull();
    expect(loc.findLocality({ postcode: '2150' }, { allowPostcodeCentroid: 'yes' })).toBeNull();
    // a name that was given but is not usable does not fall back to the postcode
    expect(loc.findLocality({ name: 'Nowhereville', postcode: '2150' }, { allowPostcodeCentroid: true })).toBeNull();
  });

  it('gives the middle of a postcode only when asked', () => {
    const mid = loc.findLocality({ postcode: '2150' }, { allowPostcodeCentroid: true });
    const inIt = data.rows.filter((r) => r[2] === '2150' && r[1] === 'NSW');
    const names = inIt.map((r) => r[0]).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
    expect(mid.kind).toBe('locality');
    expect(mid.name).toBe(names[0]);
    expect(mid.state).toBe('NSW');
    expect(mid.postcode).toBe('2150');
    expect(mid.lat).toBeCloseTo(inIt.reduce((s, r) => s + r[3], 0) / inIt.length, 3);
    expect(mid.lng).toBeCloseTo(inIt.reduce((s, r) => s + r[4], 0) / inIt.length, 3);
    expect(Object.keys(mid).sort()).toEqual(['id', 'kind', 'label', 'lat', 'lng', 'name', 'postcode', 'state']);
    expect(loc.findLocality({ postcode: '2150', state: 'VIC' }, { allowPostcodeCentroid: true })).toBeNull();
    expect(loc.findLocality({ postcode: '9999' }, { allowPostcodeCentroid: true })).toBeNull();
  });

  it('never throws on odd input', () => {
    [undefined, null, 'x', 5, [], {}, { name: {} }, { name: 5, state: [], postcode: {} }, { name: 'x'.repeat(5000) }].forEach((input) => {
      expect(() => loc.findLocality(input)).not.toThrow();
      expect(loc.findLocality(input)).toBeNull();
    });
  });
});

describe('coordsFor', () => {
  it('finds a known suburb', () => {
    expect(loc.coordsFor({ suburb: 'Cairns', state: 'QLD' })).toEqual({ lat: -16.9186, lng: 145.7405, basis: 'suburb' });
    expect(loc.coordsFor({ suburb: 'parramatta', state: 'nsw', postcode: '2150' })).toEqual({ lat: -33.8136, lng: 151.0034, basis: 'suburb' });
    expect(loc.coordsFor({ suburb: 'Ballarat', postcode: '3350' }).basis).toBe('suburb');
  });

  it('falls back to the middle of the postcode', () => {
    const byPostcode = loc.coordsFor({ postcode: '3350' });
    expect(byPostcode.basis).toBe('postcode');
    expect(byPostcode.lat).toBeCloseTo(-37.56, 1);
    expect(byPostcode.lng).toBeCloseTo(143.86, 1);
    // a suburb we do not know, with a postcode we do
    expect(loc.coordsFor({ suburb: 'Nowhereville', state: 'NSW', postcode: '2150' }).basis).toBe('postcode');
    expect(loc.coordsFor({ suburb: '', state: 'NSW', postcode: 2150 }).basis).toBe('postcode');
  });

  it('will not use a postcode that is not in the state given', () => {
    expect(loc.coordsFor({ postcode: '2150', state: 'VIC' })).toBeNull();
    expect(loc.coordsFor({ suburb: 'Nowhereville', state: 'VIC', postcode: '2150' })).toBeNull();
  });

  it('returns null for nonsense and never 0,0', () => {
    const inputs = [
      undefined, null, 'x', 5, {}, [], { suburb: 'Nowhereville', state: 'NSW' }, { suburb: 'zzzzqq' }, { postcode: '9999' },
      { postcode: '0000' }, { postcode: 'abcd' }, { suburb: '', state: '', postcode: '' }, { suburb: 0, state: 0, postcode: 0 },
      { state: 'NSW' }, { suburb: {}, state: {}, postcode: {} },
    ];
    inputs.forEach((input) => {
      expect(() => loc.coordsFor(input)).not.toThrow();
      expect(loc.coordsFor(input)).toBeNull();
    });
    [{ suburb: 'Cairns', state: 'QLD' }, { postcode: '0800' }, { postcode: '2150' }, { suburb: 'Hobart', state: 'TAS' }].forEach((input) => {
      const c = loc.coordsFor(input);
      expect(c.lat).not.toBe(0);
      expect(c.lng).not.toBe(0);
      expect(c.lat).toBeLessThan(-9);
      expect(c.lng).toBeGreaterThan(112);
    });
  });
});

describe('placeFromLegacyPill', () => {
  it('maps all 13 city pills to their city entry', () => {
    pipeline.MAJOR_CITIES.forEach((c) => {
      const p = loc.placeFromLegacyPill(c.name);
      expect(p.kind).toBe('city');
      expect(p.name).toBe(c.name);
      expect(p.lat).toBe(c.lat);
      expect(p.lng).toBe(c.lng);
      expect(loc.getPlaceById(p.id)).toEqual(p);
    });
  });

  it('maps all 7 regional pills to their region entry', () => {
    ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT'].forEach((s) => {
      const p = loc.placeFromLegacyPill('Regional ' + s);
      expect(p).toEqual({ id: 'region:' + s, kind: 'region', name: 'Regional ' + s, state: s, postcode: null, lat: null, lng: null, label: 'Regional ' + s });
    });
  });

  it('"Anywhere in Australia" and anything else map to null', () => {
    ['Anywhere in Australia', 'Regional ACT', 'Regional', 'Regional XYZ', 'Parramatta', 'London', '', ' ', 'x'.repeat(500)].forEach((t) => {
      expect(loc.placeFromLegacyPill(t)).toBeNull();
    });
    [undefined, null, 5, {}, []].forEach((t) => {
      expect(loc.placeFromLegacyPill(t)).toBeNull();
    });
  });

  it('is forgiving about case and spaces', () => {
    expect(loc.placeFromLegacyPill(' gold coast ').id).toBe('city:gold-coast');
    expect(loc.placeFromLegacyPill('regional nsw').id).toBe('region:NSW');
  });
});

describe('stateOfPostcode', () => {
  it('reads the state from the dataset', () => {
    expect(loc.stateOfPostcode('2150')).toBe('NSW');
    expect(loc.stateOfPostcode('3350')).toBe('VIC');
    expect(loc.stateOfPostcode('4870')).toBe('QLD');
    expect(loc.stateOfPostcode('0800')).toBe('NT');
    expect(loc.stateOfPostcode(800)).toBe('NT');
    expect(loc.stateOfPostcode('7000')).toBe('TAS');
  });

  it('returns null when it does not know', () => {
    ['9999', '', 'abcd', '21500', null, undefined, {}, []].forEach((pc) => {
      expect(loc.stateOfPostcode(pc)).toBeNull();
    });
  });
});

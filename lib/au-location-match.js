'use strict';

// WP-29: where an Australian doctor is based, how far they would go, and how
// that compares with where a practice is.
//
// Everything here is pure: no database, no network, no environment. Places
// come from lib/au-localities.js. The browser sends place ids only; names and
// coordinates are always read from the dataset on the server.
//
// One rule runs through the whole file: a location we do not know is
// "unknown" (null), never 0 km and never a made-up point. The live product
// stores a hand-typed address as 0,0, so 0,0 is read as "unknown" too.

const loc = require('./au-localities.js');

// A stand-in for 'about 45 minutes'. Straight-line kilometres, not travel
// time. One number, here, so it is easy to change.
const COMMUTE_RADIUS_KM = 45;

const TRAVEL = Object.freeze({ COMMUTE: 'commute', STATE: 'state', PLACES: 'places', ANYWHERE: 'anywhere' });

// Shown to doctors, word for word.
const TRAVEL_LABELS = Object.freeze({
  commute: 'Within a commute of where I am now (about 45 minutes)',
  state: 'Anywhere in my state',
  places: 'Specific places',
  anywhere: 'Anywhere in Australia',
});

const MAX_PLACES = 20;
const MAX_LEGACY_LOCATIONS = 12;
const ANYWHERE_PILL = 'Anywhere in Australia';
const TRAVEL_VALUES = [TRAVEL.COMMUTE, TRAVEL.STATE, TRAVEL.PLACES, TRAVEL.ANYWHERE];
// 'region' is "Regional <state>" (no point of its own); 'area' is a named
// region with an approximate centre and radius (FR-9, lib/au-localities.js).
const PLACE_KINDS = ['locality', 'city', 'region', 'area'];

// ---------------------------------------------------------------------------
// Coordinates and distance
// ---------------------------------------------------------------------------

function isNumber(n) {
  return typeof n === 'number' && isFinite(n);
}

// Both numbers, inside the globe, and not the 0,0 placeholder.
function validCoords(lat, lng) {
  if (!isNumber(lat) || !isNumber(lng)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Straight-line distance in kilometres, or null when either point is unknown.
function haversineKm(lat1, lng1, lat2, lng2) {
  if (!validCoords(lat1, lng1) || !validCoords(lat2, lng2)) return null;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// A database value -> a number, or null. '' and null are "not there", not 0.
function toCoord(value) {
  if (typeof value === 'number') return isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

function validState(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toUpperCase();
  return loc.AU_STATES.indexOf(s) >= 0 ? s : null;
}

// The nearest of the 13 city centres that is within a commute, or null.
function cityWithinCommute(lat, lng) {
  let best = null;
  loc.CITY_ENTRIES.forEach((c) => {
    const km = haversineKm(lat, lng, c.lat, c.lng);
    if (km != null && km <= COMMUTE_RADIUS_KM && (!best || km < best.km)) best = { name: c.name, km };
  });
  return best;
}

// The old-list name for "outside the cities" in a state. The ACT has no
// regional entry in the old list, so it reads as Canberra.
function regionalNameFor(state) {
  const s = validState(state);
  if (!s) return null;
  return s === 'ACT' ? 'Canberra' : 'Regional ' + s;
}

// ---------------------------------------------------------------------------
// The stored choice
// ---------------------------------------------------------------------------

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

// One stored place, tidied. Null when it is not a usable place.
function cleanStoredPlace(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (typeof p.id !== 'string' || !p.id || p.id.length > 120) return null;
  if (PLACE_KINDS.indexOf(p.kind) < 0) return null;
  const lat = toCoord(p.lat);
  const lng = toCoord(p.lng);
  const ok = validCoords(lat, lng);
  const name = text(p.name, 80);
  return {
    id: p.id,
    kind: p.kind,
    name,
    state: validState(p.state),
    postcode: typeof p.postcode === 'string' && /^\d{4}$/.test(p.postcode) ? p.postcode : null,
    lat: ok ? lat : null,
    lng: ok ? lng : null,
    label: text(p.label, 120) || name,
  };
}

function idOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id;
  return null;
}

// What a browser sent -> a checked choice ready to store. Only ids are read
// from the browser; every place is looked up again in the dataset.
function normaliseLocationChoice(raw) {
  const errors = {};
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const baseId = idOf(input.base);
  const base = baseId ? loc.getPlaceById(baseId) : null;
  if (!base || (base.kind !== 'locality' && base.kind !== 'city' && base.kind !== 'area')) {
    errors.base = 'Choose where you are based from the list.';
  }

  const travel = TRAVEL_VALUES.indexOf(input.travel) >= 0 ? input.travel : null;
  if (!travel) errors.travel = 'Choose how far you would go.';

  const places = [];
  if (travel === TRAVEL.PLACES) {
    const list = Array.isArray(input.places) ? input.places : [];
    const seen = new Set();
    let unknown = false;
    // Look at a bounded number of entries however long the list sent is.
    for (let i = 0; i < list.length && i < MAX_PLACES * 5; i += 1) {
      const id = idOf(list[i]);
      const place = id ? loc.getPlaceById(id) : null;
      if (!place) {
        unknown = true;
      } else if (!seen.has(place.id)) {
        seen.add(place.id);
        places.push(place);
      }
    }
    if (unknown) errors.places = 'Choose places from the list.';
    else if (!places.length) errors.places = 'Add at least one place.';
    else if (places.length > MAX_PLACES || list.length > MAX_PLACES * 5) errors.places = 'Choose up to ' + MAX_PLACES + ' places.';
  }

  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    choice: ok ? { v: 1, base, travel, places } : null,
  };
}

// Read a stored choice back, carefully. Does not need the dataset.
function readLocationChoice(stored) {
  try {
    let value = stored;
    if (typeof value === 'string') {
      if (!value.trim() || value.length > 200000) return null;
      value = JSON.parse(value);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (TRAVEL_VALUES.indexOf(value.travel) < 0) return null;
    const legacy = value.legacy === true;
    const base = cleanStoredPlace(value.base);
    if (base && base.kind === 'region') return null;
    // Only a choice rebuilt from the old pills may have no base.
    if (!base && !legacy) return null;
    const places = [];
    if (value.travel === TRAVEL.PLACES && Array.isArray(value.places)) {
      const seen = new Set();
      for (let i = 0; i < value.places.length && places.length < MAX_PLACES; i += 1) {
        const p = cleanStoredPlace(value.places[i]);
        if (p && !seen.has(p.id)) {
          seen.add(p.id);
          places.push(p);
        }
      }
    }
    const choice = { v: 1, base, travel: value.travel, places };
    if (legacy) choice.legacy = true;
    return choice;
  } catch (_) {
    return null;
  }
}

// Accept a choice in any stored form; null when it is not one.
function asChoice(choice) {
  if (!choice) return null;
  if (typeof choice === 'object' && !Array.isArray(choice) && TRAVEL_VALUES.indexOf(choice.travel) >= 0) {
    return {
      base: choice.base && typeof choice.base === 'object' ? choice.base : null,
      travel: choice.travel,
      places: Array.isArray(choice.places) ? choice.places.filter((p) => p && typeof p === 'object') : [],
      legacy: choice.legacy === true,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Keeping the old preferred_locations field filled in
// ---------------------------------------------------------------------------

function oldListNameFor(place) {
  if (!place) return null;
  if (place.kind === 'city') {
    const city = loc.CITY_ENTRIES.filter((c) => c.name === place.name)[0];
    return city ? city.name : null;
  }
  if (place.kind === 'region') {
    const region = loc.REGION_ENTRIES.filter((r) => r.state === place.state)[0];
    return region ? region.name : null;
  }
  const near = cityWithinCommute(place.lat, place.lng);
  return near ? near.name : regionalNameFor(place.state);
}

// The new choice written in the old vocabulary (13 cities, 7 "Regional X",
// "Anywhere in Australia"), for the code that still reads that field.
function legacyLocationsFor(choice) {
  const c = asChoice(choice);
  if (!c) return [];
  const out = [];
  const add = (name) => {
    if (name && out.indexOf(name) < 0 && out.length < MAX_LEGACY_LOCATIONS) out.push(name);
  };
  if (c.travel === TRAVEL.ANYWHERE) return [ANYWHERE_PILL];
  if (c.travel === TRAVEL.STATE) {
    const state = c.base ? validState(c.base.state) : null;
    if (!state) return [];
    loc.CITY_ENTRIES.forEach((city) => { if (city.state === state) add(city.name); });
    loc.REGION_ENTRIES.forEach((r) => { if (r.state === state) add(r.name); });
    return out;
  }
  if (c.travel === TRAVEL.COMMUTE) {
    add(oldListNameFor(c.base && c.base.kind !== 'region' ? c.base : null));
    return out;
  }
  c.places.forEach((p) => add(oldListNameFor(p)));
  return out;
}

// The first city name in the old-vocabulary list, or ''.
function preferredCityFor(choice) {
  const names = legacyLocationsFor(choice);
  for (let i = 0; i < names.length; i += 1) {
    if (loc.CITY_ENTRIES.some((c) => c.name === names[i])) return names[i];
  }
  return '';
}

function pillList(locations) {
  let list = locations;
  if (typeof list === 'string') {
    try {
      const parsed = JSON.parse(list);
      list = Array.isArray(parsed) ? parsed : [list];
    } catch (_) {
      list = [list];
    }
  }
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(0, 50) : [];
}

// A doctor who onboarded before this change: build the nearest honest choice
// from their old pills and whatever suburb/state/postcode they typed. The
// result is marked `legacy: true` and its base may be null. A doctor with a
// base but no usable pills gets travel 'places' with no places: we know where
// they are but they never told us how far they would go.
function choiceFromLegacy(input) {
  try {
    const src = input && typeof input === 'object' ? input : {};
    let base = null;
    if (typeof src.suburb === 'string' && src.suburb.trim()) {
      base = loc.findLocality({ name: src.suburb, state: src.state, postcode: src.postcode });
    }
    if (!base) base = loc.findLocality({ state: src.state, postcode: src.postcode }, { allowPostcodeCentroid: true });

    const pills = pillList(src.locations);
    const anywhere = pills.some((p) => p.trim().toLowerCase() === ANYWHERE_PILL.toLowerCase());
    const places = [];
    if (!anywhere) {
      const seen = new Set();
      pills.forEach((p) => {
        const place = loc.placeFromLegacyPill(p);
        if (place && !seen.has(place.id) && places.length < MAX_PLACES) {
          seen.add(place.id);
          places.push(place);
        }
      });
    }
    if (!anywhere && !places.length && !base) return null;
    return {
      v: 1,
      base: base || null,
      travel: anywhere ? TRAVEL.ANYWHERE : TRAVEL.PLACES,
      places,
      legacy: true,
    };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Where a practice is
// ---------------------------------------------------------------------------

function firstText(row, keys) {
  for (let i = 0; i < keys.length; i += 1) {
    const v = row[keys[i]];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && isFinite(v)) return String(v);
  }
  return '';
}

// A practice's own map point. FR-9 (S9-16): only a point INSIDE Australia is
// believed. A point overseas, swapped, with the sign dropped, or 0,0 is a
// data-entry slip: it is ignored, and the suburb is used instead if there is
// one (otherwise the distance is unknown).
function firstCoords(row) {
  const pairs = [['latitude', 'longitude'], ['lat', 'lng']];
  for (let i = 0; i < pairs.length; i += 1) {
    const lat = toCoord(row[pairs[i][0]]);
    const lng = toCoord(row[pairs[i][1]]);
    if (validCoords(lat, lng) && loc.inAustralia(lat, lng)) return { lat, lng };
  }
  return null;
}

// A role or practice row -> where it is, and how we know.
function practiceLocationOf(row) {
  const r = row && typeof row === 'object' ? row : {};
  const suburb = firstText(r, ['suburb', 'location_city']);
  let postcode = firstText(r, ['postcode', 'location_postcode']);
  if (/^\d{3}$/.test(postcode)) postcode = '0' + postcode;
  if (!/^\d{4}$/.test(postcode)) postcode = '';
  const state = validState(firstText(r, ['location_state', 'state'])) || loc.stateOfPostcode(postcode);
  const out = { lat: null, lng: null, state: state || null, suburb: suburb || null, postcode: postcode || null, basis: 'unknown' };

  const own = firstCoords(r);
  if (own) {
    out.lat = own.lat;
    out.lng = own.lng;
    out.basis = 'coordinates';
    return out;
  }
  const looked = loc.coordsFor({ suburb, state: state || '', postcode });
  if (looked && validCoords(looked.lat, looked.lng)) {
    out.lat = looked.lat;
    out.lng = looked.lng;
    out.basis = looked.basis;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching a role to a choice
// ---------------------------------------------------------------------------

function distanceBand(km) {
  if (!isNumber(km) || km < 0) return 'unknown';
  if (km <= 10) return 'within_10km';
  if (km <= 25) return '10_to_25km';
  if (km <= COMMUTE_RADIUS_KM) return '25_to_45km';
  if (km <= 100) return '45_to_100km';
  return 'over_100km';
}

// How far from its point a chosen place reaches. A suburb or a whole city: a
// commute. A named region: its own (approximate) radius. One place, here.
function reachKm(place) {
  if (place && place.kind === 'area') {
    const r = loc.areaRadiusKm(place.id);
    if (isNumber(r) && r > 0) return r;
  }
  return COMMUTE_RADIUS_KM;
}

function pointOf(place) {
  if (!place || place.kind === 'region') return null;
  if (!validCoords(place.lat, place.lng)) return null;
  return { lat: place.lat, lng: place.lng, name: typeof place.name === 'string' ? place.name : '', area: place.kind === 'area', reach: reachKm(place) };
}

function noChoiceMatch() {
  return { withinPreference: null, distanceKm: null, nearestChosenPlace: null, basis: 'no_choice', band: 'unknown' };
}

// Is this practice inside one chosen place? true / false / null (cannot tell).
function judgePlace(place, practice, known) {
  if (place.kind === 'region') {
    const state = validState(place.state);
    if (!state || !practice.state) return null;
    if (practice.state !== state) return false;
    if (!known) return null;
    // "Regional X" means in the state and not within a commute of a major city.
    return !cityWithinCommute(practice.lat, practice.lng);
  }
  const point = pointOf(place);
  if (!point || !known) return null;
  return haversineKm(practice.lat, practice.lng, point.lat, point.lng) <= reachKm(place);
}

function matchRoleLocation(choice, row) {
  const c = asChoice(choice);
  if (!c) return noChoiceMatch();

  const practice = practiceLocationOf(row);
  const known = validCoords(practice.lat, practice.lng);
  const basePoint = pointOf(c.base);

  // The points the distance is measured to.
  let points = [];
  if (c.travel === TRAVEL.PLACES) points = c.places.map(pointOf).filter(Boolean);
  if (!points.length && basePoint) points = [basePoint];

  let nearest = null;
  if (known) {
    points.forEach((p) => {
      const km = haversineKm(practice.lat, practice.lng, p.lat, p.lng);
      if (km != null && (!nearest || km < nearest.km)) nearest = { km, name: p.name, insideArea: p.area === true && km <= p.reach };
    });
  }

  let within = null;
  if (c.travel === TRAVEL.ANYWHERE) {
    within = true;
  } else if (c.travel === TRAVEL.STATE) {
    const baseState = c.base ? validState(c.base.state) : null;
    within = practice.state && baseState ? practice.state === baseState : null;
  } else if (c.travel === TRAVEL.COMMUTE) {
    const km = known && basePoint ? haversineKm(practice.lat, practice.lng, basePoint.lat, basePoint.lng) : null;
    // Based in a named region: anywhere in that region, or a commute past its centre.
    within = km == null ? null : km <= reachKm(c.base);
  } else if (c.places.length) {
    let anyTrue = false;
    let allJudged = true;
    c.places.forEach((p) => {
      const verdict = judgePlace(p, practice, known);
      if (verdict === true) anyTrue = true;
      else if (verdict === null) allJudged = false;
    });
    within = anyTrue ? true : (allJudged ? false : null);
  }

  const distanceKm = nearest ? Math.round(nearest.km * 10) / 10 : null;
  return {
    withinPreference: within,
    distanceKm,
    nearestChosenPlace: nearest && nearest.name ? nearest.name : null,
    basis: practice.basis,
    band: distanceBand(nearest ? nearest.km : null),
    // The practice's suburb (a name, never an address): the card line uses it
    // when the distance is only to the middle of that suburb.
    practiceSuburb: practice.suburb || null,
    // The nearest chosen place is a named region and the practice is inside it:
    // a distance to the region's centre would mean nothing, so the line says so.
    insideChosenArea: !!(nearest && nearest.insideArea),
  };
}

function kmWords(km) {
  if (km < 1) return 'less than 1 km';
  if (km >= 100) return 'about ' + (Math.round(km / 10) * 10) + ' km';
  return 'about ' + Math.round(km) + ' km';
}

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// The one short, honest line for a doctor's role card. '' when there is
// nothing true and useful to say.
function locationLine(match, choice) {
  if (!match || typeof match !== 'object') return '';
  const km = isNumber(match.distanceKm) && match.distanceKm >= 0 ? match.distanceKm : null;
  const from = typeof match.nearestChosenPlace === 'string' && match.nearestChosenPlace ? match.nearestChosenPlace : '';
  let distance = km == null ? '' : kmWords(km) + (from ? ' from ' + from : ' away');
  // FR-9 (S9-16): when the practice has no map point of its own, the distance
  // is to the middle of its suburb (or postcode). Say so, and never claim
  // "less than 1 km": the practice could be anywhere in that suburb.
  const approx = match.basis === 'suburb' || match.basis === 'postcode';
  if (match.insideChosenArea === true && from && match.withinPreference !== false) return 'In the ' + from + ' region';
  if (approx && km != null) {
    const suburb = typeof match.practiceSuburb === 'string' ? match.practiceSuburb.replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    const tail = match.basis === 'suburb' ? ' (to the suburb centre)' : ' (approximate)';
    if (km < 1) distance = suburb ? 'in ' + suburb : (from ? 'close to ' + from + ' (approximate)' : 'nearby (approximate)');
    else distance += tail;
  }

  if (match.withinPreference === false) {
    return distance ? 'Outside the area you chose · ' + distance : 'Outside the area you chose';
  }
  if (distance) return capitalise(distance);
  if (match.withinPreference === true) {
    const c = asChoice(choice);
    if (c && c.travel === TRAVEL.STATE) return 'In the state you chose';
    if (c && c.travel === TRAVEL.PLACES) return 'In an area you chose';
  }
  return '';
}

// Put roles in order for one doctor: inside their area first (nearest first),
// then the rest (nearest first). Nothing is ever removed.
function orderRolesByLocation(items, choice, getRow) {
  const list = Array.isArray(items) ? items : [];
  const rowOf = typeof getRow === 'function' ? getRow : (item) => item;
  const c = asChoice(choice);
  const decorated = list.map((item, i) => {
    let match = noChoiceMatch();
    if (c) {
      try {
        match = matchRoleLocation(c, rowOf(item));
      } catch (_) {
        match = noChoiceMatch();
      }
    }
    return { item, match, i };
  });
  if (c) {
    decorated.sort((a, b) => {
      const ga = a.match.withinPreference === true ? 0 : 1;
      const gb = b.match.withinPreference === true ? 0 : 1;
      if (ga !== gb) return ga - gb;
      const da = a.match.distanceKm;
      const db = b.match.distanceKm;
      if (da == null && db != null) return 1;
      if (da != null && db == null) return -1;
      if (da != null && db != null && da !== db) return da - db;
      return a.i - b.i;
    });
  }
  return decorated.map((d) => ({ item: d.item, match: d.match }));
}

// ---------------------------------------------------------------------------
// Wording for staff and facts for the AI
// ---------------------------------------------------------------------------

function labelOf(place) {
  if (!place) return '';
  return (typeof place.label === 'string' && place.label) || (typeof place.name === 'string' && place.name) || '';
}

function describeChoiceForStaff(choice) {
  const c = asChoice(choice);
  if (!c) return 'Not recorded';
  const baseLabel = labelOf(c.base);
  const based = baseLabel ? 'Based in ' + baseLabel : 'Base not recorded';
  let how;
  if (c.travel === TRAVEL.COMMUTE) {
    how = 'within a commute (about ' + COMMUTE_RADIUS_KM + ' km)';
  } else if (c.travel === TRAVEL.STATE) {
    const state = c.base ? validState(c.base.state) : null;
    how = state ? 'anywhere in ' + state : 'anywhere in their state';
  } else if (c.travel === TRAVEL.ANYWHERE) {
    how = 'anywhere in Australia';
  } else {
    const labels = c.places.map(labelOf).filter(Boolean);
    how = labels.length ? 'specific places: ' + labels.join(', ') : 'how far they would go is not recorded';
  }
  return based + '; ' + how;
}

const AI_TRAVEL_WORDS = {
  commute: 'within a commute of where they are based',
  state: 'anywhere in their state',
  places: 'specific places',
  anywhere: 'anywhere in Australia',
};

const AI_BAND_WORDS = {
  within_10km: 'within 10 km',
  '10_to_25km': '10 to 25 km',
  '25_to_45km': '25 to 45 km',
  '45_to_100km': '45 to 100 km',
  over_100km: 'over 100 km',
  unknown: 'unknown',
};

// A place name with no digits in it, so no postcode or street number can
// reach a prompt even if a stored name was wrong.
function nameOnly(value) {
  return typeof value === 'string' ? value.replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
}

// Facts that are safe to give an AI prompt: suburb level only.
function aiLocationFacts(choice, match) {
  const c = asChoice(choice);
  const m = match && typeof match === 'object' ? match : {};
  const band = AI_BAND_WORDS[m.band] ? m.band : distanceBand(m.distanceKm);
  const within = m.withinPreference === true || m.withinPreference === false ? m.withinPreference : null;
  const nearest = nameOnly(m.nearestChosenPlace) || null;
  if (!c) {
    return {
      travel_preference: 'not recorded',
      based_in: null,
      chosen_places: [],
      distance_band: AI_BAND_WORDS[band],
      nearest_chosen_place: nearest,
      within_preference: within,
    };
  }
  const baseName = c.base ? nameOnly(c.base.name) : '';
  const baseState = c.base ? validState(c.base.state) : null;
  return {
    travel_preference: AI_TRAVEL_WORDS[c.travel],
    based_in: baseName ? (baseName + (baseState ? ' ' + baseState : '')) : null,
    chosen_places: c.travel === TRAVEL.PLACES ? c.places.map((p) => nameOnly(p.name)).filter(Boolean).slice(0, 8) : [],
    distance_band: AI_BAND_WORDS[band],
    nearest_chosen_place: nearest,
    within_preference: within,
  };
}

module.exports = {
  COMMUTE_RADIUS_KM,
  TRAVEL,
  TRAVEL_LABELS,
  MAX_PLACES,
  validCoords,
  haversineKm,
  normaliseLocationChoice,
  readLocationChoice,
  legacyLocationsFor,
  preferredCityFor,
  choiceFromLegacy,
  practiceLocationOf,
  matchRoleLocation,
  distanceBand,
  locationLine,
  orderRolesByLocation,
  describeChoiceForStaff,
  aiLocationFacts,
};

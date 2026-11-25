'use strict';

// WP-29: the list of Australian suburbs and towns, and the search over it.
//
// One job: turn what a doctor types ("parra", "2150", "ballarat vic") into a
// short list of real places, and turn a place id back into that place. The
// browser only ever sends ids; the server reads the name, state, postcode and
// coordinates from the dataset here, so nothing a browser sends is trusted.
//
// Pure: no database, no network, no environment. The dataset
// (data/au-localities.json) is read once, the first time it is needed.

const AU_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'NT', 'ACT'];

const MAX_RESULTS = 8;
const MAX_QUERY_LENGTH = 60;
const MAX_ID_LENGTH = 120;
// A suburb this close to a city centre is treated as "part of that city" when
// search results are put in order. It is only used for ordering here.
const CITY_SUBURB_KM = 45;

const CITY_STATES = {
  Sydney: 'NSW',
  Melbourne: 'VIC',
  Brisbane: 'QLD',
  Perth: 'WA',
  Adelaide: 'SA',
  Canberra: 'ACT',
  Hobart: 'TAS',
  Darwin: 'NT',
  'Gold Coast': 'QLD',
  Newcastle: 'NSW',
  Wollongong: 'NSW',
  'Sunshine Coast': 'QLD',
  Geelong: 'VIC',
};

function loadMajorCities() {
  try {
    const list = require('./practice-pipeline.js').MAJOR_CITIES;
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

// The 13 whole-city entries, in the same order as MAJOR_CITIES.
const CITY_ENTRIES = Object.freeze(
  loadMajorCities()
    .filter((c) => c && CITY_STATES[c.name])
    .map((c) => Object.freeze({
      name: c.name,
      capital: !!c.capital,
      lat: c.lat,
      lng: c.lng,
      state: CITY_STATES[c.name],
    }))
);

// "Regional <state>" for every state except the ACT.
const REGION_ENTRIES = Object.freeze(
  AU_STATES.filter((s) => s !== 'ACT').map((s) => Object.freeze({ name: 'Regional ' + s, state: s }))
);

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

function slug(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The form names and queries are compared in: lower case, apostrophes removed,
// hyphens treated as spaces, anything else that is not a letter or digit
// dropped. So "o'connor", "oconnor" and "O'Connor" all compare equal.
function searchKey(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanState(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toUpperCase();
  return AU_STATES.indexOf(s) >= 0 ? s : null;
}

function cleanPostcode(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  let s = String(value).trim();
  // A postcode kept as a number loses its leading zero ("0800" -> 800).
  if (/^\d{3}$/.test(s)) s = '0' + s;
  return /^\d{4}$/.test(s) ? s : null;
}

function roundCoord(n) {
  return Math.round(n * 10000) / 10000;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function kmBetween(aLat, aLng, bLat, bLng) {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------
// The index (built once)
// ---------------------------------------------------------------------------

let INDEX = null;

function inAustralia(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number'
    && isFinite(lat) && isFinite(lng)
    && !(lat === 0 && lng === 0)
    && lat >= -44.5 && lat <= -9 && lng >= 112 && lng <= 154.5;
}

// 1 = within reach of a capital city, 2 = within reach of another major city,
// 3 = everywhere else. Only used to put the suburbs most people mean first.
function cityTier(lat, lng) {
  let tier = 3;
  for (let i = 0; i < CITY_ENTRIES.length; i += 1) {
    const c = CITY_ENTRIES[i];
    if (kmBetween(lat, lng, c.lat, c.lng) <= CITY_SUBURB_KM) {
      if (c.capital) return 1;
      tier = 2;
    }
  }
  return tier;
}

function buildIndex() {
  let rows = [];
  try {
    const data = require('../data/au-localities.json');
    if (data && Array.isArray(data.rows)) rows = data.rows;
  } catch (_) {
    rows = [];
  }

  const all = [];
  const byId = new Map();
  const byNameState = new Map();
  const byName = new Map();
  const byPostcode = new Map();
  const byFirstLetter = new Map();

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (!Array.isArray(r) || r.length < 5) continue;
    const name = typeof r[0] === 'string' ? r[0] : '';
    const state = cleanState(r[1]);
    const postcode = cleanPostcode(r[2]);
    const lat = r[3];
    const lng = r[4];
    if (!name || !state || !postcode || !inAustralia(lat, lng)) continue;
    const key = searchKey(name);
    if (!key) continue;
    const id = 'loc:' + state + ':' + postcode + ':' + slug(name);
    if (byId.has(id)) continue;
    const entry = { id, name, state, postcode, lat, lng, key, tier: cityTier(lat, lng) };
    all.push(entry);
    byId.set(id, entry);
    pushTo(byNameState, key + '|' + state, entry);
    pushTo(byName, key, entry);
    pushTo(byPostcode, postcode, entry);
    pushTo(byFirstLetter, key.charAt(0), entry);
  }

  const byPostcodeOrder = all.slice().sort((a, b) => cmp(a.postcode, b.postcode) || cmp(a.key, b.key) || cmp(a.state, b.state));
  byNameState.forEach((list) => list.sort((a, b) => cmp(a.postcode, b.postcode)));
  byPostcode.forEach((list) => list.sort((a, b) => cmp(a.key, b.key) || cmp(a.state, b.state)));

  const cityBySlug = new Map();
  const cityByKey = new Map();
  CITY_ENTRIES.forEach((c) => {
    cityBySlug.set(slug(c.name), c);
    cityByKey.set(searchKey(c.name), c);
  });
  const regionByState = new Map();
  REGION_ENTRIES.forEach((r) => regionByState.set(r.state, r));

  return { all, byId, byNameState, byName, byPostcode, byFirstLetter, byPostcodeOrder, cityBySlug, cityByKey, regionByState };
}

function pushTo(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function index() {
  if (!INDEX) INDEX = buildIndex();
  return INDEX;
}

// ---------------------------------------------------------------------------
// Place objects: the one shape used everywhere. Always a fresh object, so a
// caller can never change what is held in the index.
// ---------------------------------------------------------------------------

function localityPlace(e) {
  return {
    id: e.id,
    kind: 'locality',
    name: e.name,
    state: e.state,
    postcode: e.postcode,
    lat: e.lat,
    lng: e.lng,
    label: e.name + ' ' + e.state + ' ' + e.postcode,
  };
}

function cityPlace(c) {
  return {
    id: 'city:' + slug(c.name),
    kind: 'city',
    name: c.name,
    state: c.state,
    postcode: null,
    lat: c.lat,
    lng: c.lng,
    label: c.name + ' (whole city)',
  };
}

function regionPlace(r) {
  return {
    id: 'region:' + r.state,
    kind: 'region',
    name: r.name,
    state: r.state,
    postcode: null,
    lat: null,
    lng: null,
    label: r.name,
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function cleanQuery(query) {
  if (typeof query !== 'string' && typeof query !== 'number') return '';
  const capped = String(query).trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_LENGTH);
  return capped
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/[^a-z0-9 '\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanLimit(opts) {
  const n = opts && typeof opts === 'object' ? Number(opts.limit) : NaN;
  if (!isFinite(n)) return MAX_RESULTS;
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(n)));
}

function byRank(a, b) {
  return (a.tier - b.tier)
    || (a.key.length - b.key.length)
    || cmp(a.key, b.key)
    || cmp(a.state, b.state)
    || cmp(a.postcode, b.postcode);
}

// Edit distance between two short strings, giving up (returning max + 1) as
// soon as it is certain to be more than `max`.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before = null;
  let prev = [];
  for (let j = 0; j <= b.length; j += 1) prev.push(j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      // Two neighbouring letters typed the wrong way round count as one slip.
      if (before && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        v = Math.min(v, before[j - 2] + 1);
      }
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    // (A swap can reach back two rows, so only stop when both rows are out.)
    if (rowMin > max && Math.min.apply(null, prev) > max) return max + 1;
    before = prev;
    prev = cur;
  }
  return prev[b.length];
}

// How far the typed text is from the start of a name: the name is cut to the
// same length as the text first, so "paramatta" is compared with "parramatt".
function prefixDistance(text, key, max) {
  return editDistance(text, key.length > text.length ? key.slice(0, text.length) : key, max);
}

function searchPostcode(idx, digits, limit) {
  const out = [];
  const list = idx.byPostcodeOrder;
  for (let i = 0; i < list.length && out.length < limit; i += 1) {
    if (list[i].postcode.indexOf(digits) === 0) out.push(localityPlace(list[i]));
  }
  return out;
}

function searchText(idx, text, stateFilter, postcodeFilter, limit) {
  const out = [];
  const seen = new Set();
  const add = (place) => {
    if (out.length >= limit || seen.has(place.id)) return;
    seen.add(place.id);
    out.push(place);
  };
  const passes = (e) => (!stateFilter || e.state === stateFilter)
    && (!postcodeFilter || e.postcode.indexOf(postcodeFilter) === 0);

  // 1. Whole-city entries whose name starts with the text.
  if (!postcodeFilter) {
    CITY_ENTRIES.forEach((c) => {
      if ((!stateFilter || c.state === stateFilter) && searchKey(c.name).indexOf(text) === 0) add(cityPlace(c));
    });
    // 2. Region entries: "regional", "regional n", or a state code on its own.
    REGION_ENTRIES.forEach((r) => {
      if (stateFilter && r.state !== stateFilter) return;
      const key = searchKey(r.name);
      if (key.indexOf(text) === 0 || r.state.toLowerCase() === text) add(regionPlace(r));
    });
  }

  // 3-5. Localities: starts with, then a later word starts with, then contains.
  const starts = [];
  const wordStarts = [];
  const contains = [];
  const all = idx.all;
  for (let i = 0; i < all.length; i += 1) {
    const e = all[i];
    const at = e.key.indexOf(text);
    if (at < 0 || !passes(e)) continue;
    if (at === 0) starts.push(e);
    else if (e.key.indexOf(' ' + text) >= 0) wordStarts.push(e);
    else contains.push(e);
  }
  // An exact name always leads its group.
  starts.sort((a, b) => ((a.key === text ? 0 : 1) - (b.key === text ? 0 : 1)) || byRank(a, b));
  wordStarts.sort(byRank);
  contains.sort(byRank);
  starts.forEach((e) => add(localityPlace(e)));
  wordStarts.forEach((e) => add(localityPlace(e)));
  contains.forEach((e) => add(localityPlace(e)));

  // 6. Small typos, only when little was found.
  const letters = text.replace(/[^a-z]/g, '');
  if (out.length < 3 && letters.length >= 4 && out.length < limit) {
    const max = letters.length >= 7 ? 2 : 1;
    if (!postcodeFilter) {
      CITY_ENTRIES.forEach((c) => {
        if (stateFilter && c.state !== stateFilter) return;
        if (prefixDistance(text, searchKey(c.name), max) <= max) add(cityPlace(c));
      });
    }
    // Names that start with the first typed letter, plus names that start with
    // the second (covers a dropped first letter). Two buckets, never the lot.
    const buckets = [idx.byFirstLetter.get(text.charAt(0)) || []];
    if (text.charAt(1) !== text.charAt(0) && text.charAt(1) !== ' ') buckets.push(idx.byFirstLetter.get(text.charAt(1)) || []);
    const distanceOf = new Map();
    const near = [];
    buckets.forEach((bucket) => {
      for (let i = 0; i < bucket.length; i += 1) {
        const e = bucket[i];
        if (!passes(e)) continue;
        let d = distanceOf.get(e.key);
        if (d === undefined) {
          d = prefixDistance(text, e.key, max);
          distanceOf.set(e.key, d);
        }
        // `whole` is how far the text is from the full name: it puts
        // "Ballarat" ahead of longer names that merely start alike.
        if (d <= max) near.push({ e, d, whole: editDistance(text, e.key, 4) });
      }
    });
    near.sort((a, b) => (Math.min(a.d, a.whole) - Math.min(b.d, b.whole)) || (a.whole - b.whole) || byRank(a.e, b.e));
    near.forEach((n) => add(localityPlace(n.e)));
  }
  return out;
}

// What a doctor typed -> up to 8 places. Never throws.
function searchLocalities(query, opts) {
  try {
    const q = cleanQuery(query);
    if (q.replace(/ /g, '').length < 2) return [];
    const limit = cleanLimit(opts);
    const idx = index();

    const digitsOnly = q.replace(/[ '\-]/g, '');
    if (/^\d+$/.test(digitsOnly)) {
      return digitsOnly.length <= 4 ? searchPostcode(idx, digitsOnly, limit) : [];
    }

    // A state code or postcode at the end (or a postcode at the start) narrows
    // the search: "parramatta nsw", "richmond vic 3121", "2150 parramatta".
    const tokens = searchKey(q).split(' ').filter(Boolean);
    const fullText = tokens.join(' ');
    let stateFilter = null;
    let postcodeFilter = null;
    for (let pass = 0; pass < 2 && tokens.length > 1; pass += 1) {
      const last = tokens[tokens.length - 1];
      if (!postcodeFilter && /^\d{2,4}$/.test(last)) {
        postcodeFilter = last;
        tokens.pop();
      } else if (!stateFilter && cleanState(last)) {
        stateFilter = cleanState(last);
        tokens.pop();
      }
    }
    if (!postcodeFilter && tokens.length > 1 && /^\d{4}$/.test(tokens[0])) postcodeFilter = tokens.shift();
    const text = tokens.join(' ');
    // e.g. "2150 nsw": nothing but a postcode and a state.
    if (/^\d{1,4}$/.test(text)) return searchPostcodeInState(idx, text, stateFilter, limit);
    if (text.length < 2) return [];

    let found = searchText(idx, text, stateFilter, postcodeFilter, limit);
    // If narrowing found nothing, the "state code" may have been part of a name.
    if (!found.length && (stateFilter || postcodeFilter) && fullText !== text) {
      found = searchText(idx, fullText, null, null, limit);
    }
    return found;
  } catch (_) {
    return [];
  }
}

function searchPostcodeInState(idx, digits, state, limit) {
  if (!digits || !/^\d{1,4}$/.test(digits)) return [];
  const out = [];
  const list = idx.byPostcodeOrder;
  for (let i = 0; i < list.length && out.length < limit; i += 1) {
    if (list[i].postcode.indexOf(digits) === 0 && (!state || list[i].state === state)) out.push(localityPlace(list[i]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

// A place id -> the place, read from the dataset. Unknown or odd input -> null.
function getPlaceById(id) {
  try {
    if (typeof id !== 'string' || !id || id.length > MAX_ID_LENGTH) return null;
    const idx = index();
    if (id.indexOf('loc:') === 0) {
      const e = idx.byId.get(id);
      return e ? localityPlace(e) : null;
    }
    if (id.indexOf('city:') === 0) {
      const c = idx.cityBySlug.get(id.slice(5));
      return c ? cityPlace(c) : null;
    }
    if (id.indexOf('region:') === 0) {
      const r = idx.regionByState.get(id.slice(7));
      return r ? regionPlace(r) : null;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function majorityState(list) {
  const counts = {};
  let best = null;
  list.forEach((e) => {
    counts[e.state] = (counts[e.state] || 0) + 1;
    if (!best || counts[e.state] > counts[best]) best = e.state;
  });
  return best;
}

// The middle of a postcode: the average of its localities' coordinates.
function postcodeCentroid(idx, postcode, state) {
  const list = idx.byPostcode.get(postcode);
  if (!list || !list.length) return null;
  const inState = state || majorityState(list);
  const use = list.filter((e) => e.state === inState);
  if (!use.length) return null;
  let lat = 0;
  let lng = 0;
  use.forEach((e) => { lat += e.lat; lng += e.lng; });
  lat = roundCoord(lat / use.length);
  lng = roundCoord(lng / use.length);
  if (!inAustralia(lat, lng)) return null;
  // `use` is already in name order, so the first one is alphabetically first.
  const place = localityPlace(use[0]);
  place.lat = lat;
  place.lng = lng;
  return place;
}

// Exact lookup of a suburb. See the rules in the comments below.
function findLocality(input, opts) {
  try {
    if (!input || typeof input !== 'object') return null;
    const idx = index();
    const key = typeof input.name === 'string' ? searchKey(input.name) : '';
    const state = cleanState(input.state);
    const postcode = cleanPostcode(input.postcode);
    // A state was given but is not one we know: do not guess past it.
    const badState = input.state != null && String(input.state).trim() !== '' && !state;

    if (!key) {
      // A postcode alone says "somewhere in this postcode", not a suburb. Only
      // answer when the caller has said an approximate point is acceptable.
      if (typeof input.name === 'string' && input.name.trim()) return null;
      if (!postcode || badState || !(opts && opts.allowPostcodeCentroid === true)) return null;
      return postcodeCentroid(idx, postcode, state);
    }
    if (badState) return null;

    if (state) {
      const list = idx.byNameState.get(key + '|' + state);
      if (!list || !list.length) return null;
      if (postcode) {
        const exact = list.filter((e) => e.postcode === postcode)[0];
        if (exact) return localityPlace(exact);
      }
      // Name + state: unique, or the first by postcode.
      return localityPlace(list[0]);
    }

    const named = idx.byName.get(key);
    if (!named || !named.length) return null;
    if (postcode) {
      const exact = named.filter((e) => e.postcode === postcode)[0];
      return exact ? localityPlace(exact) : null;
    }
    // A name with no state and no postcode: only when there is exactly one
    // place with that name in the whole country.
    const states = new Set(named.map((e) => e.state));
    return states.size === 1 && named.length === 1 ? localityPlace(named[0]) : null;
  } catch (_) {
    return null;
  }
}

// Coordinates for a PRACTICE whose own coordinates are missing or unusable.
// Suburb match first, then the middle of the postcode. Never 0,0.
function coordsFor(input) {
  try {
    if (!input || typeof input !== 'object') return null;
    const suburb = typeof input.suburb === 'string' ? input.suburb.trim() : '';
    const state = cleanState(input.state);
    const postcode = cleanPostcode(input.postcode);
    if (suburb && (state || postcode)) {
      const place = findLocality({ name: suburb, state, postcode });
      if (place) return { lat: place.lat, lng: place.lng, basis: 'suburb' };
    } else if (suburb) {
      const place = findLocality({ name: suburb });
      if (place) return { lat: place.lat, lng: place.lng, basis: 'suburb' };
    }
    if (postcode) {
      const idx = index();
      const list = idx.byPostcode.get(postcode);
      if (!list) return null;
      // When a state is given it has to be a state this postcode is really in.
      if (state && !list.some((e) => e.state === state)) return null;
      const mid = postcodeCentroid(idx, postcode, state);
      if (mid) return { lat: mid.lat, lng: mid.lng, basis: 'postcode' };
    }
    return null;
  } catch (_) {
    return null;
  }
}

// The old onboarding pills: 13 city names, 7 "Regional <STATE>" strings and
// "Anywhere in Australia". The last one is a travel choice, not a place.
function placeFromLegacyPill(text) {
  try {
    if (typeof text !== 'string') return null;
    const key = searchKey(text);
    if (!key || key.length > 40) return null;
    const idx = index();
    const city = idx.cityByKey.get(key);
    if (city) return cityPlace(city);
    const m = /^regional ([a-z]{2,3})$/.exec(key);
    if (m) {
      const region = idx.regionByState.get(m[1].toUpperCase());
      if (region) return regionPlace(region);
    }
    return null;
  } catch (_) {
    return null;
  }
}

// The state most localities with this postcode are in.
function stateOfPostcode(postcode) {
  try {
    const pc = cleanPostcode(postcode);
    if (!pc) return null;
    const list = index().byPostcode.get(pc);
    return list && list.length ? majorityState(list) : null;
  } catch (_) {
    return null;
  }
}

function stats() {
  return { rows: index().all.length, cities: CITY_ENTRIES.length, regions: REGION_ENTRIES.length };
}

module.exports = {
  AU_STATES,
  CITY_ENTRIES,
  REGION_ENTRIES,
  searchLocalities,
  getPlaceById,
  findLocality,
  coordsFor,
  placeFromLegacyPill,
  stateOfPostcode,
  stats,
};

'use strict';

/**
 * Australian GP build, WP-30: THE lookup. "Is this address in a Distribution
 * Priority Area for GPs, and what is its Modified Monash level?"
 * Read docs/au-gp/workforce-locator.md first.
 *
 * WHERE THE ANSWER COMES FROM
 *   The Department of Health's public Health Workforce Locator. This module
 *   does not have a second way of asking: it uses the request the live product
 *   already makes (lib/dpa-lookup.js, fetchHwlPoint) and reads two layers of
 *   the answer: `dpa_gps` (Y / N + the GP catchment name) and the newest
 *   `mmmYYYY` layer (today `mmm2023`, value 1 to 7).
 *
 * PROVIDERS (env AU_WORKFORCE_LOCATOR_PROVIDER)
 *   none        the default, and the kill switch: no network, { ok:false }.
 *   fixture     a small map in lib/au-workforce-locator-fixture.json (tests and
 *               the local test stack). No network.
 *   health_gov  the real service.
 *   Anything else reads as `none`. Every caller ALSO asks the one Australian
 *   switch first; this module never reads it.
 *
 * THE RULES THAT LIVE HERE AND NOWHERE ELSE
 *   1. validAuPoint: 0,0 / null / '' / outside Australia are NOT coordinates.
 *   2. resolvePoint: which point stands for the address (a selected address's
 *      own point, else the street address geocoded by the server, else the
 *      suburb's centre), and whether that point is `exact` or `approximate`.
 *   3. classifyLocation: confidence decides trust. Only an `exact` point may
 *      say yes or no about DPA. An approximate point always gives
 *      dpaGp 'unknown' (what the centre of the suburb said travels separately
 *      as `indicative`, for wording only). A failure gives 'unknown'.
 *      NEVER turns an unknown into a yes.
 *
 * Never throws. No policy is hard-coded (no "all of the NT is DPA"): what the
 * source returns is what is recorded.
 */

const dpaLookup = require('./dpa-lookup');
const FIXTURE = require('./au-workforce-locator-fixture.json');

const PROVIDERS = Object.freeze(['none', 'fixture', 'health_gov']);
const TOTAL_BUDGET_MS = 8000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const DEFAULT_MAX_PER_MINUTE = 30;
const NOMINATIM_SPACING_MS = 1100;

// How far a point the browser or a record supplied may sit from where the
// server's own geocoder puts the same address before it is refused.
const CORROBORATE_EXACT_KM = 1;
const CORROBORATE_STREET_KM = 15;
const CORROBORATE_SUBURB_KM = 25;

const AU_BOUNDS = Object.freeze({ latMin: -44.5, latMax: -9.0, lngMin: 112.0, lngMax: 154.5 });
const AU_STATES = Object.freeze(['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']);

const SOURCE_NAME = 'Health Workforce Locator, Australian Government Department of Health';

// ── small helpers ───────────────────────────────────────────────────────────

function envOf(opts) { return (opts && opts.env) || process.env; }

const providerGuard = require('./au-provider-guard');
function providerName(env) {
  const v = String(((env || process.env).AU_WORKFORCE_LOCATOR_PROVIDER) || '').trim().toLowerCase();
  // FR-9 (S9-14): the made-up test map is never used in production.
  return providerGuard.guardProvider(PROVIDERS.indexOf(v) === -1 ? 'none' : v, 'AU_WORKFORCE_LOCATOR_PROVIDER', env || process.env);
}

/** A label the owner sets when the Department publishes a new DPA list (e.g. "2026"). The source itself does not say. */
function editionLabel(env) {
  return String(((env || process.env).AU_WORKFORCE_LOCATOR_EDITION) || '').trim().slice(0, 24);
}

function text(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
function norm(v) { return text(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

/**
 * RULE 1. A usable Australian point, or null. The live product stores a
 * hand-typed address as latitude 0 / longitude 0 (Number(null) is 0): that,
 * nulls, blanks, booleans and anything outside Australia are NOT coordinates.
 */
function validAuPoint(lat, lng) {
  if (lat === null || lng === null || lat === undefined || lng === undefined) return null;
  if (lat === '' || lng === '' || typeof lat === 'boolean' || typeof lng === 'boolean') return null;
  const a = Number(lat); const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a === 0 && b === 0) return null;
  if (a < AU_BOUNDS.latMin || a > AU_BOUNDS.latMax || b < AU_BOUNDS.lngMin || b > AU_BOUNDS.lngMax) return null;
  return { lat: a, lng: b };
}

function haversineKm(p, q) {
  const toRad = function (d) { return d * Math.PI / 180; };
  const dLat = toRad(q.lat - p.lat); const dLng = toRad(q.lng - p.lng);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRad(p.lat)) * Math.cos(toRad(q.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function cleanState(v) {
  const s = text(v).toUpperCase();
  return AU_STATES.indexOf(s) === -1 ? '' : s;
}
function cleanPostcode(v) {
  const s = text(v);
  return /^\d{4}$/.test(s) ? s : '';
}

/** The location as this module reads it. Nothing is invented: a blank stays blank. */
function normaliseInput(input) {
  const i = input && typeof input === 'object' ? input : {};
  return {
    address: text(i.address).slice(0, 300),
    suburb: text(i.suburb).slice(0, 120),
    state: cleanState(i.state),
    postcode: cleanPostcode(i.postcode),
    latitude: i.latitude,
    longitude: i.longitude,
    placeId: text(i.placeId || i.google_place_id).slice(0, 300),
    pointSource: text(i.pointSource)
  };
}

/** The street part of an address, or '' when there is none ("Dubbo NSW" has none). */
function streetOf(input) {
  const i = normaliseInput(input);
  if (!i.address) return '';
  const parts = i.address.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  let first = parts[0] || '';
  // "Suite 4, 12 Example Street": the unit is its own comma part.
  if (/^(unit|suite|shop|level|lot|u)\s*[a-z0-9]+$/i.test(first) && parts[1]) first = first + ' ' + parts[1];
  let street = norm(first);
  // A street address starts with a number (after an optional unit) and then a
  // street name. "Dubbo NSW 2830" has a number but is not a street address.
  const STREET = /^(?:(?:unit|suite|shop|level|lot|u)\s*[a-z0-9]+\s+)?\d+[a-z]?(?:\s+\d+[a-z]?)?\s+\S*[a-z]{2,}/;
  street = street.replace(/\s+(nsw|vic|qld|sa|wa|tas|nt|act)(\s+\d{4})?$/, '').replace(/\s+\d{4}$/, '').trim();
  // "1 Test Street Parramatta" typed with no commas: cut the suburb off the
  // end, but only when a street is left ("5 Dubbo Road" in Dubbo keeps its name).
  const sub = norm(i.suburb);
  if (sub && street.length > sub.length && street.slice(-sub.length - 1) === ' ' + sub) {
    const cut = street.slice(0, -sub.length - 1).trim();
    if (STREET.test(cut)) street = cut;
  }
  if (!STREET.test(street)) return '';
  return street;
}

/**
 * One string that changes when the place changes and not when the typing does.
 * Used to tell "the address changed" from "the same address was saved again".
 */
function addressKey(input) {
  const i = normaliseInput(input);
  const street = streetOf(i);
  return [street, norm(i.suburb), i.state.toLowerCase(), i.postcode].join('|');
}

function fullAddressText(i) {
  const parts = [i.address];
  const a = norm(i.address);
  if (i.suburb && a.indexOf(norm(i.suburb)) === -1) parts.push(i.suburb);
  if (i.state && (' ' + a + ' ').indexOf(' ' + i.state.toLowerCase() + ' ') === -1) parts.push(i.state);
  if (i.postcode && a.indexOf(i.postcode) === -1) parts.push(i.postcode);
  parts.push('Australia');
  return parts.filter(Boolean).join(', ');
}

// ── reading the source's answer ─────────────────────────────────────────────

function firstProps(raw, key) {
  const fc = ((raw || {}).results || {})[key];
  const feats = fc && Array.isArray(fc.features) ? fc.features : [];
  return feats.length && feats[0] && typeof feats[0].properties === 'object' && feats[0].properties ? feats[0].properties : null;
}

/**
 * Reads one answer of the Health Workforce Locator's data service.
 * @returns {{ dpaGp: 'yes'|'no'|'unknown', catchment: string, mmm: (number|null), mmmYear: (number|null), mmmByYear: object }}
 * Throws only when the body is not an answer at all.
 */
function parseLocatorResponse(raw) {
  if (!raw || typeof raw !== 'object' || !raw.results || typeof raw.results !== 'object') {
    throw new Error('locator_bad_response');
  }
  const gp = firstProps(raw, 'dpa_gps');
  const value = gp ? String(gp.value == null ? '' : gp.value).trim().toUpperCase() : '';
  // Anything other than a clear Y or N is unknown. Never coerced.
  const dpaGp = value === 'Y' ? 'yes' : (value === 'N' ? 'no' : 'unknown');

  const mmmByYear = {};
  const years = [];
  Object.keys(raw.results).forEach(function (key) {
    const m = /^mmm(\d{4})$/.exec(key);
    if (!m) return;
    const year = Number(m[1]);
    years.push(year);
    const p = firstProps(raw, key);
    const n = p ? Number(p.value) : NaN;
    mmmByYear[year] = Number.isInteger(n) && n >= 1 && n <= 7 ? n : null;
  });
  years.sort(function (a, b) { return b - a; });
  // The NEWEST edition the source serves is the current one. An older edition
  // is never used to fill a gap in the newest.
  const mmmYear = years.length ? years[0] : null;
  const mmm = mmmYear != null ? mmmByYear[mmmYear] : null;
  return { dpaGp: dpaGp, catchment: gp && gp.catchment ? text(gp.catchment).slice(0, 120) : '', mmm: mmm, mmmYear: mmmYear, mmmByYear: mmmByYear };
}

// ── the cache and the rate limit (per server instance) ──────────────────────

let pointCache = new Map();
let geoCache = new Map();
let callTimes = [];
let lastNominatimAt = 0;

function _resetForTests() {
  pointCache = new Map(); geoCache = new Map(); callTimes = []; lastNominatimAt = 0;
  dpaLookup._resetTokenCache();
}

function cacheGet(map, key, now) {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (now - hit.at > CACHE_TTL_MS) { map.delete(key); return undefined; }
  return hit.value;
}
function cacheSet(map, key, value, now) {
  if (map.size >= CACHE_MAX) { const oldest = map.keys().next().value; map.delete(oldest); }
  map.set(key, { at: now, value: value });
}

function maxPerMinute(env) {
  const n = Number((env || process.env).AU_WORKFORCE_LOCATOR_MAX_PER_MINUTE);
  return Number.isFinite(n) && n >= 1 && n <= 600 ? Math.floor(n) : DEFAULT_MAX_PER_MINUTE;
}
/** true when one more outbound question may be asked now (and counts it). */
function takeRateSlot(env, now) {
  callTimes = callTimes.filter(function (t) { return now - t < 60000; });
  if (callTimes.length >= maxPerMinute(env)) return false;
  callTimes.push(now);
  return true;
}

function codedError(code) { const e = new Error(code); e.code = code; return e; }

function budget(startedAt, nowFn) {
  return function remaining() { return TOTAL_BUDGET_MS - (nowFn() - startedAt); };
}

async function timedFetch(fetchImpl, url, init, ms) {
  if (!(ms > 0)) throw codedError('timeout');
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, ms);
  try {
    return await fetchImpl(url, Object.assign({}, init || {}, { signal: controller.signal }));
  } catch (err) {
    if (controller.signal.aborted) throw codedError('timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── classifying ONE point ───────────────────────────────────────────────────

function fixturePlaces(opts) {
  const f = (opts && opts.fixture) || FIXTURE;
  return { edition: f.edition || 'fixture', mmmYear: f.mmmYear || null, places: Array.isArray(f.places) ? f.places : [] };
}

function fixtureClassifyPoint(lat, lng, opts) {
  const fx = fixturePlaces(opts);
  let best = null; let bestKm = Infinity;
  fx.places.forEach(function (pl) {
    const km = haversineKm({ lat: lat, lng: lng }, { lat: pl.lat, lng: pl.lng });
    if (km <= (Number(pl.radiusKm) || 5) && km < bestKm) { best = pl; bestKm = km; }
  });
  if (!best) return { dpaGp: 'unknown', catchment: '', mmm: null, mmmYear: fx.mmmYear };
  const d = best.dpaGp === 'yes' || best.dpaGp === 'no' ? best.dpaGp : 'unknown';
  const m = Number.isInteger(best.mmm) && best.mmm >= 1 && best.mmm <= 7 ? best.mmm : null;
  return { dpaGp: d, catchment: text(best.catchment), mmm: m, mmmYear: fx.mmmYear };
}

async function healthGovClassifyPoint(lat, lng, ctx) {
  const fetchImpl = ctx.fetchImpl;
  const guarded = function (url, init) { return timedFetch(fetchImpl, url, init, ctx.remaining()); };
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // One retry, and only while there is time left for it to finish.
    if (attempt === 1 && ctx.remaining() < 1500) break;
    try {
      if (attempt === 1) dpaLookup._resetTokenCache(); // an expired guest token is the usual cause
      const raw = await dpaLookup.fetchHwlPoint(lat, lng, { fetchImpl: guarded });
      return parseLocatorResponse(raw);
    } catch (err) {
      lastErr = err;
    }
  }
  throw codedError(lastErr && lastErr.code === 'timeout' ? 'timeout' : (lastErr && lastErr.message === 'locator_bad_response' ? 'locator_bad_response' : 'locator_unavailable'));
}

/** Cached by the rounded point, the provider and the edition label. */
async function classifyPoint(provider, lat, lng, ctx) {
  const key = [provider, editionLabel(ctx.env), lat.toFixed(4), lng.toFixed(4)].join('|');
  const now = ctx.now();
  const cached = cacheGet(pointCache, key, now);
  if (cached !== undefined) return Object.assign({ cached: true }, cached);
  if (!takeRateSlot(ctx.env, now)) throw codedError('rate_limited');
  const value = provider === 'fixture'
    ? fixtureClassifyPoint(lat, lng, ctx.opts)
    : await healthGovClassifyPoint(lat, lng, ctx);
  cacheSet(pointCache, key, value, now);
  return Object.assign({ cached: false }, value);
}

// ── geocoders (address text -> a point). Each answers
//    { lat, lng, precision: 'exact' | 'approximate', source } or null. ────────

function fixtureGeocoder(opts) {
  const fx = fixturePlaces(opts);
  function placeFor(i) {
    const sub = norm(i.suburb);
    const whole = norm(i.address);
    return fx.places.find(function (pl) {
      const ps = norm(pl.suburb);
      const named = sub ? sub === ps : (' ' + whole + ' ').indexOf(' ' + ps + ' ') !== -1;
      if (!named) return false;
      if (i.state && pl.state !== i.state) return false;
      if (i.postcode && pl.postcode && pl.postcode !== i.postcode) return false;
      return true;
    }) || null;
  }
  return {
    name: 'fixture',
    street: async function (i) {
      const pl = placeFor(i); const street = streetOf(i);
      if (!pl || !street) return null;
      const hit = (pl.addresses || []).find(function (a) { return norm(a.street) === street; });
      return hit ? { lat: hit.lat, lng: hit.lng, precision: 'exact', source: 'fixture' } : null;
    },
    suburb: async function (i) {
      const pl = placeFor(i);
      return pl ? { lat: pl.lat, lng: pl.lng, precision: 'approximate', source: 'fixture' } : null;
    }
  };
}

function nominatimGeocoder(ctx) {
  async function ask(query) {
    const wait = NOMINATIM_SPACING_MS - (ctx.now() - lastNominatimAt);
    if (wait > 0) {
      if (wait >= ctx.remaining()) throw codedError('timeout');
      await new Promise(function (r) { setTimeout(r, wait); });
    }
    lastNominatimAt = ctx.now();
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&countrycodes=au&addressdetails=1&q=' + encodeURIComponent(query);
    const res = await timedFetch(ctx.fetchImpl, url, { headers: { 'User-Agent': ctx.userAgent, Accept: 'application/json' } }, ctx.remaining());
    if (!res || !res.ok) return [];
    const body = await res.json().catch(function () { return null; });
    return Array.isArray(body) ? body : [];
  }
  return {
    name: 'nominatim',
    street: async function (i) {
      const rows = await ask(fullAddressText(i));
      const street = streetOf(i);
      for (const row of rows) {
        const pt = validAuPoint(row && row.lat, row && row.lon);
        if (!pt) continue;
        const a = (row && row.address) || {};
        const house = norm(a.house_number);
        const houseOk = !!house && (' ' + street + ' ').indexOf(' ' + house + ' ') !== -1;
        const postcodeOk = !i.postcode || !a.postcode || String(a.postcode) === i.postcode;
        if (houseOk && postcodeOk) return { lat: pt.lat, lng: pt.lng, precision: 'exact', source: 'nominatim' };
        if (postcodeOk) return { lat: pt.lat, lng: pt.lng, precision: 'approximate', source: 'nominatim' };
      }
      return null;
    },
    suburb: async function (i) {
      if (!i.suburb) return null;
      const rows = await ask([i.suburb, [i.state, i.postcode].filter(Boolean).join(' '), 'Australia'].filter(Boolean).join(', '));
      for (const row of rows) {
        const pt = validAuPoint(row && row.lat, row && row.lon);
        if (pt) return { lat: pt.lat, lng: pt.lng, precision: 'approximate', source: 'nominatim' };
      }
      return null;
    }
  };
}

function googleGeocoder(ctx, key) {
  async function ask(params) {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?' + params + '&region=au&key=' + encodeURIComponent(key);
    const res = await timedFetch(ctx.fetchImpl, url, { headers: { Accept: 'application/json' } }, ctx.remaining());
    if (!res || !res.ok) return [];
    const body = await res.json().catch(function () { return null; });
    return body && body.status === 'OK' && Array.isArray(body.results) ? body.results : [];
  }
  function read(result, wantStreet) {
    const loc = result && result.geometry && result.geometry.location;
    const pt = loc ? validAuPoint(loc.lat, loc.lng) : null;
    if (!pt) return null;
    const type = String((result.geometry && result.geometry.location_type) || '');
    const types = Array.isArray(result.types) ? result.types : [];
    const streetLevel = types.some(function (t) { return t === 'street_address' || t === 'premise' || t === 'subpremise' || t === 'establishment' || t === 'point_of_interest'; });
    const exact = wantStreet && result.partial_match !== true && streetLevel && (type === 'ROOFTOP' || type === 'RANGE_INTERPOLATED');
    return { lat: pt.lat, lng: pt.lng, precision: exact ? 'exact' : 'approximate', source: 'google' };
  }
  return {
    name: 'google',
    street: async function (i) {
      const rows = await ask('address=' + encodeURIComponent(fullAddressText(i)) + '&components=country:AU');
      return rows.length ? read(rows[0], true) : null;
    },
    suburb: async function (i) {
      if (!i.suburb) return null;
      const rows = await ask('address=' + encodeURIComponent([i.suburb, i.state, i.postcode, 'Australia'].filter(Boolean).join(', ')) + '&components=country:AU');
      const r = rows.length ? read(rows[0], false) : null;
      return r ? Object.assign(r, { precision: 'approximate' }) : null;
    }
  };
}

function pickGeocoder(provider, ctx) {
  if (ctx.opts && ctx.opts.geocoder) return ctx.opts.geocoder;
  if (provider === 'fixture') return fixtureGeocoder(ctx.opts);
  const choice = String(ctx.env.AU_WORKFORCE_LOCATOR_GEOCODER || '').trim().toLowerCase();
  if (choice === 'none') return null;
  const googleKey = String(ctx.env.GOOGLE_MAPS_SERVER_API_KEY || '').trim();
  if (choice === 'google' && googleKey) return googleGeocoder(ctx, googleKey);
  return nominatimGeocoder(ctx);
}

/**
 * RULE 2. Which point stands for this address, and how sure that is.
 * @returns {Promise<null | { point: { lat, lng, source }, precision: 'exact'|'approximate', warnings: string[] }>}
 *   source: 'selected_address'  the point that came with an address picked from a list (or pinned by staff)
 *           'geocoded_address'  the server geocoded the street address to a building
 *           'street_centroid'   the server found the street but not the building
 *           'suburb_centroid'   only the suburb could be found
 */
async function resolvePoint(input, geocoder, ctx) {
  const i = normaliseInput(input);
  const warnings = [];
  const stored = validAuPoint(i.latitude, i.longitude);
  const selected = !!stored && (!!i.placeId || i.pointSource === 'staff');
  const hasStreet = !!streetOf(i);

  async function geo(kind) {
    if (!geocoder) return null;
    if (kind === 'street' && !hasStreet) return null;
    if (kind === 'suburb' && !i.suburb) return null;
    const key = (geocoder.name || 'custom') + '|' + kind + '|' + addressKey(i);
    const cached = cacheGet(geoCache, key, ctx.now());
    if (cached !== undefined) return cached;
    try {
      const found = await geocoder[kind](i);
      const clean = found && validAuPoint(found.lat, found.lng)
        ? { lat: Number(found.lat), lng: Number(found.lng), precision: found.precision === 'exact' ? 'exact' : 'approximate' }
        : null;
      cacheSet(geoCache, key, clean, ctx.now());
      return clean;
    } catch (err) {
      warnings.push('geocoder_unavailable');
      return null;
    }
  }

  const street = await geo('street');

  // FR-9 (M9-05). A point that arrived with the address is only ever the
  // BROWSER's word (a place id proves nothing: anybody can send one). It is
  // believed as "exact" only when this server, through its own geocoder,
  // finds the same written address to the building at (nearly) the same
  // point. In every other case the browser's point is ignored and the server
  // works from the written address by itself: exact if it finds the building,
  // otherwise approximate (never yes or no), otherwise not located.
  // The one exception is a point a named staff member placed (pointSource
  // 'staff', recorded by the server, never sent by a browser): it is kept as
  // before, cross-checked where there is something to check it against.
  if (stored && i.pointSource === 'staff') {
    if (street) {
      const km = haversineKm(stored, street);
      if (km <= (street.precision === 'exact' ? CORROBORATE_EXACT_KM : CORROBORATE_STREET_KM)) {
        return { point: { lat: stored.lat, lng: stored.lng, source: 'selected_address' }, precision: 'exact', warnings: warnings };
      }
      warnings.push('point_address_mismatch');
    } else {
      const subStaff = await geo('suburb');
      if (subStaff) {
        if (haversineKm(stored, subStaff) <= CORROBORATE_SUBURB_KM) {
          return { point: { lat: stored.lat, lng: stored.lng, source: 'selected_address' }, precision: 'exact', warnings: warnings };
        }
        warnings.push('point_address_mismatch');
        return { point: { lat: subStaff.lat, lng: subStaff.lng, source: 'suburb_centroid' }, precision: 'approximate', warnings: warnings };
      }
      if (warnings.indexOf('point_not_corroborated') === -1) warnings.push('point_not_corroborated');
      return { point: { lat: stored.lat, lng: stored.lng, source: 'selected_address' }, precision: 'exact', warnings: warnings };
    }
  } else if (stored) {
    if (street && street.precision === 'exact' && haversineKm(stored, street) <= CORROBORATE_EXACT_KM) {
      // The server found the same building itself. (With a place id the
      // selected point is the one used, as before; they are within a kilometre.)
      if (selected) return { point: { lat: stored.lat, lng: stored.lng, source: 'selected_address' }, precision: 'exact', warnings: warnings };
    } else if (street) {
      warnings.push(haversineKm(stored, street) <= (street.precision === 'exact' ? CORROBORATE_EXACT_KM : CORROBORATE_STREET_KM) ? 'point_not_corroborated' : 'point_address_mismatch');
    } else {
      const subCheck = await geo('suburb');
      warnings.push(subCheck && haversineKm(stored, subCheck) > CORROBORATE_SUBURB_KM ? 'point_address_mismatch' : 'point_not_corroborated');
    }
    // ...and from here the browser's point plays no part.
  }

  if (street) {
    return street.precision === 'exact'
      ? { point: { lat: street.lat, lng: street.lng, source: 'geocoded_address' }, precision: 'exact', warnings: warnings }
      : { point: { lat: street.lat, lng: street.lng, source: 'street_centroid' }, precision: 'approximate', warnings: warnings };
  }
  const sub = await geo('suburb');
  if (sub) return { point: { lat: sub.lat, lng: sub.lng, source: 'suburb_centroid' }, precision: 'approximate', warnings: warnings };
  return warnings.length ? { point: null, precision: 'none', warnings: warnings } : null;
}

// ── THE function ────────────────────────────────────────────────────────────

function emptyResult(provider, ctx, error, warnings) {
  return {
    ok: false, provider: provider, dpaGp: 'unknown', mmm: null, mmmApproximate: false,
    confidence: 'none', method: 'none',
    classificationYear: { dpa: editionLabel(ctx.env) || null, mmm: null },
    checkedAt: new Date(ctx.now()).toISOString(), pointUsed: null, catchment: '',
    warnings: warnings || [], error: error
  };
}

/**
 * RULE 3. Classify one location.
 *
 * @param {{ address?, suburb?, state?, postcode?, latitude?, longitude?, placeId?, pointSource? }} input
 * @param {{ env?, fetchImpl?, now?, geocoder?, fixture?, userAgent? }} [opts]
 * @returns {Promise<{ ok: boolean, provider: string, dpaGp: 'yes'|'no'|'unknown', mmm: (number|null),
 *   mmmApproximate: boolean, confidence: 'exact'|'approximate'|'none', method: string,
 *   classificationYear: { dpa: (string|null), mmm: (number|null) }, checkedAt: string,
 *   pointUsed: (null|{ lat, lng, source }), catchment: string, warnings: string[],
 *   indicative?: { dpaGp: string, catchment: string }, error?: string }>}
 */
async function classifyLocation(input, opts) {
  const o = opts || {};
  const env = envOf(o);
  const nowFn = typeof o.now === 'function' ? o.now : Date.now;
  const startedAt = nowFn();
  const ctx = {
    env: env, opts: o, now: nowFn, remaining: budget(startedAt, nowFn),
    fetchImpl: o.fetchImpl || globalThis.fetch,
    userAgent: o.userAgent || 'Mozilla/5.0 (compatible; practice-location-check/1.0)'
  };
  const provider = providerName(env);
  if (provider === 'none') return emptyResult('none', ctx, 'provider_off');

  try {
    const resolved = await resolvePoint(input, pickGeocoder(provider, ctx), ctx);
    if (!resolved || !resolved.point) {
      return emptyResult(provider, ctx, 'address_not_located', ((resolved && resolved.warnings) || []).concat(['address_not_located']));
    }
    const cls = await classifyPoint(provider, resolved.point.lat, resolved.point.lng, ctx);
    const warnings = resolved.warnings.slice();
    const year = { dpa: (provider === 'fixture' ? fixturePlaces(o).edition : editionLabel(env)) || null, mmm: cls.mmmYear == null ? null : cls.mmmYear };
    if (cls.dpaGp === 'unknown' && cls.mmm == null) {
      // The source has nothing for this point (the sea, or outside its data).
      const none = emptyResult(provider, ctx, 'no_classification_at_point', warnings.concat(['no_classification_at_point']));
      none.pointUsed = resolved.point; none.classificationYear = year;
      return none;
    }
    const exact = resolved.precision === 'exact';
    const out = {
      ok: true, provider: provider,
      // Only an exact point may say yes or no. An approximate one never does.
      dpaGp: exact ? cls.dpaGp : 'unknown',
      mmm: cls.mmm, mmmApproximate: !exact && cls.mmm != null,
      confidence: exact ? 'exact' : 'approximate',
      method: resolved.point.source,
      classificationYear: year,
      checkedAt: new Date(nowFn()).toISOString(),
      pointUsed: { lat: Number(resolved.point.lat.toFixed(6)), lng: Number(resolved.point.lng.toFixed(6)), source: resolved.point.source },
      catchment: exact ? cls.catchment : '',
      warnings: warnings
    };
    if (!exact) {
      out.indicative = { dpaGp: cls.dpaGp, catchment: cls.catchment };
      warnings.push('address_not_precise');
    } else if (cls.dpaGp === 'unknown') {
      warnings.push('dpa_not_returned');
    }
    return out;
  } catch (err) {
    const code = err && err.code ? String(err.code) : 'locator_unavailable';
    return emptyResult(provider, ctx, code, [code]);
  }
}

// ── words ───────────────────────────────────────────────────────────────────

// The Department's own names for the seven Modified Monash categories.
const MMM_NAMES = Object.freeze({
  1: 'Metropolitan', 2: 'Regional centre', 3: 'Large rural town', 4: 'Medium rural town',
  5: 'Small rural town', 6: 'Remote community', 7: 'Very remote community'
});

/** 'MM3', 'MM 3', 'mmm3', 3 -> 3. Anything else -> null. */
function mmmNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const m = /^\s*(?:m{2,3}\s*)?([1-7])\s*$/i.exec(String(value));
  return m ? Number(m[1]) : null;
}
/** 3 -> 'MM3' (the form career_roles.mmm and the intake use). null -> ''. */
function mmmCode(n) { const v = mmmNumber(n); return v == null ? '' : 'MM' + v; }
/** 3 -> 'Large rural town (MM 3)'. null -> ''. */
function mmmWords(n) { const v = mmmNumber(n); return v == null ? '' : MMM_NAMES[v] + ' (MM ' + v + ')'; }

module.exports = {
  PROVIDERS, TOTAL_BUDGET_MS, SOURCE_NAME, AU_BOUNDS, MMM_NAMES,
  CORROBORATE_EXACT_KM, CORROBORATE_STREET_KM, CORROBORATE_SUBURB_KM,
  providerName, editionLabel, validAuPoint, haversineKm, normaliseInput, streetOf, addressKey,
  parseLocatorResponse, resolvePoint, classifyLocation, fixtureGeocoder,
  mmmNumber, mmmCode, mmmWords, _resetForTests
};

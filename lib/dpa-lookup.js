'use strict';

/* Distribution Priority Area (DPA), the official answer, never a guess.
 *
 * DPA decides which GPs can see a job at all: get it wrong and the listing is
 * silently invisible to the entire overseas-trained pool. So this module asks
 * the Department of Health rather than inferring anything.
 *
 * The public Health Workforce Locator (health.gov.au) is an Angular app over
 * this backend. It issues a guest token to anyone, no credentials. `dpa_gps`
 * is the IMG/FGAMS answer -- the exact field the official tool renders under
 * "Distribution Priority Area for GPs".
 *
 * If anything here fails, the caller MUST ask the practice. Never default.
 */

const HWL = 'https://trueview.spectrumspatial.com/trueviewapi';
const SOURCE = 'Health Workforce Locator - Australian Department of Health';

let tokenCache = { value: null, expiresAt: 0 };
function _resetTokenCache() { tokenCache = { value: null, expiresAt: 0 }; }

async function hwlGuestToken(fetchImpl) {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiresAt - 60000) return tokenCache.value;
  const res = await fetchImpl(`${HWL}/auth/guest-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: 'dhac' }),
  });
  if (!res.ok) throw new Error(`HWL guest token failed: ${res.status}`);
  const data = await res.json();
  if (!data || !data.accessToken) throw new Error('HWL guest token missing from response');
  tokenCache = {
    value: data.accessToken,
    expiresAt: now + (Number(data.expiresIn) || 3600) * 1000,
  };
  return tokenCache.value;
}

function featureProps(raw, key) {
  const fc = ((raw || {}).results || {})[key] || {};
  const feats = fc.features || [];
  return feats.length ? (feats[0].properties || {}) : {};
}

function parseHwlResult(raw) {
  if (!raw || !raw.results) throw new Error('HWL returned no results for this point');
  const gp = featureProps(raw, 'dpa_gps');
  const value = String(gp.value == null ? '' : gp.value).trim().toUpperCase();
  // Anything other than a clear Y/N is an error. Do not coerce to false.
  if (value !== 'Y' && value !== 'N') throw new Error('HWL returned no DPA value for this point');
  const mmmValue = featureProps(raw, 'mmm2023').value;
  return {
    dpa: value === 'Y',
    dpaCatchment: gp.catchment || null,
    dpaBonded: String(featureProps(raw, 'dpa_bmp').value || '').trim().toUpperCase() === 'Y',
    mmm: mmmValue === null || mmmValue === undefined || mmmValue === '' ? null : `MM${mmmValue}`,
    source: SOURCE,
  };
}

async function lookupDpa(lat, lon, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof lat !== 'number' || typeof lon !== 'number' || Number.isNaN(lat) || Number.isNaN(lon)) {
    throw new Error('lookupDpa needs numeric lat/lon');
  }
  const token = await hwlGuestToken(fetchImpl);
  const body = {
    inputs: [{
      selection: {
        record: {
          geometry: {
            type: 'Point',
            coordinates: [lon, lat],
            crs: { type: 'name', properties: { name: 'epsg:4326' } },
          },
        },
      },
      location: null,
      search: 'address',
    }],
    pageName: 'map',
  };
  const res = await fetchImpl(`${HWL}/theme/getResult/locator/address`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HWL lookup failed: ${res.status}`);
  return parseHwlResult(await res.json());
}

module.exports = { lookupDpa, parseHwlResult, _resetTokenCache, HWL, SOURCE };

'use strict';

/* Pure rules for the practice intake form. No network, no DB — so the parts
   that are easy to get subtly wrong are the parts that are unit-tested. */

/* ---- the split ------------------------------------------------------------
   Practices write this a dozen different ways: "70", "70/30", "30/70",
   "65% doctor 35% practice" — often with unrelated numbers mixed into the
   same sentence ("rent is $30/week, split is 20/80"). Picking "the first
   two numbers" or "the two biggest numbers" both misread prose like that.
   A real split is two numbers that sum to 100 — that is a much stronger
   signal, so we look for that pair first. If no such pair exists and there
   isn't exactly one number to fall back on, the text is genuinely
   ambiguous: we return null rather than guess, because a wrong guess here
   silently misprices the job (same principle as never inventing a DPA
   answer). The GP always takes the larger share of a matching pair. */
function parseSplit(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => n > 0 && n < 100);
  if (!nums.length) return null;
  let gp = null;
  outer:
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      if (Math.abs(nums[i] + nums[j] - 100) < 0.01) {
        gp = Math.max(nums[i], nums[j]);
        break outer;
      }
    }
  }
  if (gp === null) {
    if (nums.length !== 1) return null;
    gp = nums[0];
  }
  if (gp < 1 || gp > 99) return null;
  const practice = Math.round((100 - gp) * 100) / 100;
  return { gp, practice, canonical: `${gp}/${practice}`, display: `GP ${gp}% / Practice ${practice}%` };
}

/* ---- nearest city ---------------------------------------------------------
   Measured by great-circle distance against a fixed table. Deliberately not
   AI-inferred: a hallucinated city goes straight into a live job advert. */
const AU_CITIES = [
  ['Sydney', -33.868, 151.209], ['Melbourne', -37.814, 144.963], ['Brisbane', -27.470, 153.021],
  ['Perth', -31.953, 115.857], ['Adelaide', -34.928, 138.600], ['Canberra', -35.281, 149.129],
  ['Hobart', -42.883, 147.327], ['Darwin', -12.463, 130.846], ['Gold Coast', -28.017, 153.400],
  ['Newcastle', -32.927, 151.777], ['Wollongong', -34.425, 150.893], ['Geelong', -38.150, 144.361],
  ['Sunshine Coast', -26.650, 153.067], ['Townsville', -19.259, 146.817], ['Cairns', -16.920, 145.771],
  ['Toowoomba', -27.560, 151.950], ['Ballarat', -37.562, 143.850], ['Bendigo', -36.758, 144.283],
  ['Launceston', -41.439, 147.139], ['Mackay', -21.144, 149.186], ['Rockhampton', -23.378, 150.512],
  ['Bunbury', -33.327, 115.641], ['Bundaberg', -24.866, 152.351], ['Wagga Wagga', -35.108, 147.369],
  ['Hervey Bay', -25.289, 152.842], ['Mildura', -34.207, 142.137], ['Shepparton', -36.383, 145.400],
  ['Port Macquarie', -31.431, 152.909], ['Gladstone', -23.843, 151.256], ['Tamworth', -31.092, 150.929],
  ['Traralgon', -38.195, 146.541], ['Orange', -33.284, 149.101], ['Dubbo', -32.243, 148.604],
  ['Geraldton', -28.774, 114.615], ['Nowra', -34.881, 150.602], ['Warrnambool', -38.381, 142.488],
  ['Kalgoorlie', -30.749, 121.466], ['Albany', -35.023, 117.881], ['Mount Gambier', -37.829, 140.783],
  ['Alice Springs', -23.698, 133.881], ['Central Coast', -33.425, 151.342], ['Albury', -36.081, 146.916],
];

function km(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const r = (d) => (d * Math.PI) / 180;
  const dLat = r(lat2 - lat1);
  const dLon = r(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nearestCity(lat, lon) {
  let best = null;
  let bestD = Infinity;
  for (const [name, cLat, cLon] of AU_CITIES) {
    const d = km(lat, lon, cLat, cLon);
    if (d < bestD) { bestD = d; best = name; }
  }
  return { city: best, km: Math.round(bestD) };
}

/* ---- ABN / ACN ------------------------------------------------------------
   Real checksums (ATO / ASIC published algorithms). A practice may legitimately
   hold either, so we accept both and tell them which one we read. */
function digitsOf(raw) { return String(raw == null ? '' : raw).replace(/\D/g, ''); }

function abnOk(raw) {
  const d = digitsOf(raw);
  if (!/^\d{11}$/.test(d)) return false;
  const W = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const n = d.split('').map(Number);
  n[0] -= 1; // the ATO algorithm subtracts 1 from the first digit
  const sum = W.reduce((s, w, i) => s + n[i] * w, 0);
  return sum > 0 && sum % 89 === 0;
}

function acnOk(raw) {
  const d = digitsOf(raw);
  if (!/^\d{9}$/.test(d)) return false;
  const W = [8, 7, 6, 5, 4, 3, 2, 1];
  const n = d.split('').map(Number);
  const sum = W.reduce((s, w, i) => s + n[i] * w, 0);
  return (10 - (sum % 10)) % 10 === n[8];
}

function idKind(raw) {
  const d = digitsOf(raw);
  if (d.length === 11 && abnOk(d)) return 'ABN';
  if (d.length === 9 && acnOk(d)) return 'ACN';
  return null;
}

/* ---- Google place → our columns ------------------------------------------ */
function derivePlace(place) {
  const p = place || {};
  const comps = p.addressComponents || [];
  const pick = (type, prefer) => {
    const c = comps.find((x) => (x.types || []).includes(type));
    if (!c) return '';
    return (prefer === 'short' ? (c.shortText || c.longText) : (c.longText || c.shortText)) || '';
  };
  const street = [pick('street_number'), pick('route')].filter(Boolean).join(' ');
  const suburb = pick('locality') || pick('sublocality') || pick('postal_town') || '';
  const loc = p.location || {};
  return {
    street,
    suburb,
    state: pick('administrative_area_level_1', 'short'),
    postcode: pick('postal_code'),
    latitude: typeof loc.latitude === 'number' ? loc.latitude : null,
    longitude: typeof loc.longitude === 'number' ? loc.longitude : null,
    googlePlaceId: p.id || '',
    formatted: p.formattedAddress || '',
  };
}

function buildGeneralLocation({ suburb, state, nearestCity: city } = {}) {
  const head = [suburb, state].filter(Boolean).join(', ');
  return city ? `${head} - near ${city}` : head;
}

module.exports = {
  parseSplit, AU_CITIES, nearestCity, abnOk, acnOk, idKind, derivePlace, buildGeneralLocation,
};

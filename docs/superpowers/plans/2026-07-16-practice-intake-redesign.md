# Practice Intake Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the practice intake form (one address question, official DPA lookup, parsed split, corporate groups, no-prefill agreement) and fix the four seams where the practice's answers never reach a GP's screen.

**Architecture:** Pure logic lands in two new testable modules (`lib/practice-intake-logic.js`, `lib/dpa-lookup.js`) with zero network/DB coupling, so the interesting rules are unit-tested. `server.js` gains one new route (`/api/dpa/check`) and stops dropping intake data on the floor at the intake→job seam. `pages/practice-intake.html` is rewritten as a 5-step form, ported from the proven prototype. Google Places is called **from the browser** with the existing referrer-locked key; the DPA lookup is called **from the server** because the government endpoint is not CORS-enabled.

**Tech Stack:** Vanilla JS/HTML, Node `server.js` monolith, Supabase Postgres, vitest.

## Global Constraints

- **Node is not installed system-wide.** Prepend to PATH first: `export PATH="/Users/gplinkrecruitment/.claude/jobs/2afa6df4/tmp/node-v20.18.1-darwin-arm64/bin:$PATH"`. Verify with `node --version` → `v20.18.1`.
- **Run tests from the worktree:** `/Users/gplinkrecruitment/Downloads/GP LINK APP (Visual Studio) copy/.claude/worktrees/practice-intake-build` (`node_modules` is symlinked there).
- **Syntax-check `server.js` before every commit:** `node --check server.js`. It is a huge file; a syntax error takes production down.
- **CommonJS.** This repo uses `require`/`module.exports`, not ESM.
- **Never `require('vitest')` in a test file.** `vitest.config.js` sets `globals: true`, so `describe`/`it`/`expect` are already global; requiring vitest from CommonJS throws *"Vitest cannot be imported in a CommonJS module using require()"*. All 205 existing test files rely on the globals. (Found the hard way in Task 1.)
- **Never guess DPA.** A failed lookup means "ask the practice", never a default value. Confidently-wrong DPA silently hides a job from every overseas-trained GP.
- **The larger share of a split always goes to the GP.** `70`, `70/30`, `30/70` all mean GP 70 / practice 30.
- **Cache busters** on changed script/style tags: `?v=20260716a`.
- **No em dashes in user-facing copy** on marketing pages (house rule); the intake form is app-side, but keep copy plain either way.
- **Plain English in all practice-facing copy.** The reader is a practice manager, not an engineer.
- Commit after each task. Do not push to `main`.

---

### Task 1: Pure intake logic module

The rules worth testing, with no network or DB in the way. Ported from the proven prototype at `~/.claude/jobs/eead77ab/tmp/map/practice-form.html` and `server.py`.

**Files:**
- Create: `lib/practice-intake-logic.js`
- Test: `tests/practice-intake-logic.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseSplit(raw: string) → {gp: number, practice: number, canonical: string, display: string} | null`
  - `AU_CITIES: Array<[name: string, lat: number, lon: number]>`
  - `nearestCity(lat: number, lon: number) → {city: string, km: number}`
  - `abnOk(digits: string) → boolean`
  - `acnOk(digits: string) → boolean`
  - `idKind(raw: string) → 'ABN' | 'ACN' | null`
  - `derivePlace(googlePlace: object) → {street, suburb, state, postcode, latitude, longitude, googlePlaceId, formatted}`
  - `buildGeneralLocation({suburb, state, nearestCity}) → string`

- [ ] **Step 1: Write the failing test**

Create `tests/practice-intake-logic.test.js`:

```js
const {
  parseSplit, nearestCity, abnOk, acnOk, idKind, derivePlace, buildGeneralLocation,
} = require('../lib/practice-intake-logic');

describe('parseSplit — the GP always takes the larger share', () => {
  it('reads a single number as the GP share', () => {
    expect(parseSplit('70')).toMatchObject({ gp: 70, practice: 30, canonical: '70/30' });
  });
  it('reads 70/30 as GP 70', () => {
    expect(parseSplit('70/30')).toMatchObject({ gp: 70, practice: 30 });
  });
  it('reads 30/70 as GP 70 — order does not matter, the larger share is the GP\'s', () => {
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
});

describe('nearestCity — measured, never inferred', () => {
  it('finds Melbourne for Werribee', () => {
    const r = nearestCity(-37.899, 144.661);
    expect(r.city).toBe('Melbourne');
    expect(r.km).toBeLessThan(40);
  });
  it('finds Sydney for the CBD itself at ~0km', () => {
    expect(nearestCity(-33.868, 151.209)).toMatchObject({ city: 'Sydney', km: 0 });
  });
  it('picks the regional centre over the far-away capital', () => {
    // Erina, NSW Central Coast — closer to Newcastle/Sydney than to anything else
    const r = nearestCity(-33.433, 151.396);
    expect(['Sydney', 'Newcastle', 'Central Coast']).toContain(r.city);
  });
});

describe('abnOk / acnOk — real checksums, not length checks', () => {
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

describe('idKind — a practice may give us either', () => {
  it('identifies an ABN', () => expect(idKind('51 824 753 556')).toBe('ABN'));
  it('identifies an ACN', () => expect(idKind('004 085 616')).toBe('ACN'));
  it('returns null for junk', () => expect(idKind('12345')).toBeNull());
});

describe('derivePlace — one address answers four questions', () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="/Users/gplinkrecruitment/.claude/jobs/2afa6df4/tmp/node-v20.18.1-darwin-arm64/bin:$PATH" && npx vitest run tests/practice-intake-logic.test.js`
Expected: FAIL — `Cannot find module '../lib/practice-intake-logic'`

- [ ] **Step 3: Write the implementation**

Create `lib/practice-intake-logic.js`:

```js
'use strict';

/* Pure rules for the practice intake form. No network, no DB — so the parts
   that are easy to get subtly wrong are the parts that are unit-tested. */

/* ---- the split ------------------------------------------------------------
   Practices write this a dozen different ways: "70", "70/30", "30/70",
   "65% doctor 35% practice". The one invariant is that the GP takes the
   LARGER share — that is the deal GP Link sells. */
function parseSplit(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => n > 0 && n < 100);
  if (!nums.length) return null;
  const gp = nums.length === 1 ? nums[0] : Math.max(nums[0], nums[1]);
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
    return (prefer === 'short' ? c.shortText : c.longText) || c.longText || c.shortText || '';
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/practice-intake-logic.test.js`
Expected: PASS, all tests green. If the `nearestCity` Erina case fails, check the `Central Coast` entry exists in `AU_CITIES`.

- [ ] **Step 5: Commit**

```bash
git add lib/practice-intake-logic.js tests/practice-intake-logic.test.js
git commit -m "feat(intake): pure logic module - split parser, nearest city, ABN/ACN, place derivation"
```

---

### Task 2: Official DPA lookup module

**Files:**
- Create: `lib/dpa-lookup.js`
- Test: `tests/dpa-lookup.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseHwlResult(raw: object) → {dpa: boolean, dpaCatchment: string|null, dpaBonded: boolean, mmm: string|null, source: string}` — **pure**, throws on a missing/invalid `dpa_gps` value
  - `lookupDpa(lat: number, lon: number, {fetchImpl?}) → Promise<result>` — network
  - `_resetTokenCache()` — test seam

- [ ] **Step 1: Write the failing test**

Create `tests/dpa-lookup.test.js`:

```js
const { parseHwlResult } = require('../lib/dpa-lookup');

const hwlResponse = (dpaValue, mmmValue = 2, catchment = 'Gosford') => ({
  results: {
    dpa_gps: { features: [{ properties: { value: dpaValue, class: 'DPA', catchment } }] },
    dpa_bmp: { features: [{ properties: { value: 'N' } }] },
    mmm2023: { features: [{ properties: { value: mmmValue } }] },
  },
});

describe('parseHwlResult — the official Department of Health answer', () => {
  it('reads Y as in-DPA', () => {
    expect(parseHwlResult(hwlResponse('Y'))).toMatchObject({
      dpa: true, dpaCatchment: 'Gosford', dpaBonded: false, mmm: 'MM2',
    });
  });
  it('reads N as not-in-DPA', () => {
    expect(parseHwlResult(hwlResponse('N')).dpa).toBe(false);
  });
  it('is case and whitespace tolerant', () => {
    expect(parseHwlResult(hwlResponse(' y ')).dpa).toBe(true);
  });
  it('reads the bonded flag separately', () => {
    const r = hwlResponse('N');
    r.results.dpa_bmp.features[0].properties.value = 'Y';
    expect(parseHwlResult(r).dpaBonded).toBe(true);
  });
  it('names its source so the practice can check us', () => {
    expect(parseHwlResult(hwlResponse('Y')).source).toMatch(/Health Workforce Locator/i);
  });

  // The whole point: we must never invent an answer.
  it('THROWS rather than defaulting when the value is missing', () => {
    expect(() => parseHwlResult({ results: { dpa_gps: { features: [] } } })).toThrow();
  });
  it('THROWS on an unexpected value instead of treating it as false', () => {
    expect(() => parseHwlResult(hwlResponse('MAYBE'))).toThrow();
  });
  it('THROWS on an empty response', () => {
    expect(() => parseHwlResult({})).toThrow();
    expect(() => parseHwlResult(null)).toThrow();
  });
  it('returns null mmm when absent rather than guessing', () => {
    const r = hwlResponse('Y');
    r.results.mmm2023.features = [];
    expect(parseHwlResult(r).mmm).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dpa-lookup.test.js`
Expected: FAIL — `Cannot find module '../lib/dpa-lookup'`

- [ ] **Step 3: Write the implementation**

Create `lib/dpa-lookup.js`:

```js
'use strict';

/* Distribution Priority Area (DPA) — the official answer, never a guess.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dpa-lookup.test.js`
Expected: PASS.

**Verified live on 2026-07-16** (probe run from this machine, real responses):

| Point | HTTP | `dpa_gps` | MMM |
|---|---|---|---|
| Werribee VIC (-37.899, 144.661) | 201 | `{value:'Y', class:'Y', catchment:'Wyndham'}` | 1 |
| Erina NSW (-33.433, 151.396) | 201 | `{value:'Y', class:'Y', catchment:'Erina - Green Point'}` | 1 |
| Sydney CBD (-33.868, 151.209) | 201 | `{value:'N', class:'N', catchment:'Sydney Inner City'}` | 1 |

**Note the `201`** — the lookup returns 201, not 200. Use `res.ok` (any 2xx), not `res.status === 200`. Do not "fix" this to 200.

- [ ] **Step 5: Prove the live endpoint still answers (transparency check)**

This hits the real government API. Run it, and **report the actual output** — do not claim it works without showing the result:

```bash
node -e "
const { lookupDpa } = require('./lib/dpa-lookup');
lookupDpa(-37.899, 144.661).then(r => console.log('WERRIBEE:', JSON.stringify(r)))
  .catch(e => console.log('LIVE LOOKUP FAILED:', e.message));
"
```
Expected: a JSON object with a `dpa` boolean and a `source`. **If it fails, say so plainly and continue** — the form's fallback path (ask the practice) is designed for exactly this. Do not fake a result.

- [ ] **Step 6: Commit**

```bash
git add lib/dpa-lookup.js tests/dpa-lookup.test.js
git commit -m "feat(intake): official DPA/MMM lookup against the Health Workforce Locator"
```

---

### Task 3: Database migration — practice groups and the new columns

**Files:**
- Create: `supabase/migrations/20260716120000_practice_intake_redesign.sql`

**Interfaces:**
- Produces: table `practice_groups`; columns on `practices`: `group_id`, `entity_name`, `abn`, `urgency`, `latitude`, `longitude`, `google_place_id`, `postcode`, `dpa_suggested`, `dpa_mismatch`, `employment_type`, `gps_needed`, `supervision_available`.

**Context you need:** migrations in this repo are applied by hand via Supabase `rpc/exec_sql` with the service key (see any existing migration's header). There is no migration ledger. Code must tolerate the columns not existing yet — the existing pipeline already does this and returns 503 `pipeline_migration_required`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260716120000_practice_intake_redesign.sql`:

```sql
-- Practice intake redesign: corporate groups + the columns the form now derives.
-- Apply via Supabase rpc/exec_sql with the service role key (param name: query).
-- Safe to re-run: every statement is IF NOT EXISTS / idempotent.

-- One group per contracting arrangement. A solo practice gets a group of one,
-- so there is exactly one code path -- no "is this a group?" branching downstream.
CREATE TABLE IF NOT EXISTS practice_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_name text,
  abn text,
  contact_name text,
  contact_email text,
  contact_phone text,
  contact_role text,
  intake_token text,
  agreement_status text DEFAULT 'unsigned' CHECK (agreement_status IN ('unsigned','sent','signed')),
  agreement_signed_at timestamptz,
  agreement_signed_by text,
  agreement_signed_pdf_key text,
  source text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS practice_groups_intake_token_idx
  ON practice_groups (intake_token) WHERE intake_token IS NOT NULL;

ALTER TABLE practices ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES practice_groups(id);
ALTER TABLE practices ADD COLUMN IF NOT EXISTS entity_name text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS abn text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS urgency text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS longitude double precision;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS google_place_id text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS postcode text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS dpa_suggested boolean;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS dpa_mismatch boolean DEFAULT false;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS employment_type text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS gps_needed text;
ALTER TABLE practices ADD COLUMN IF NOT EXISTS supervision_available boolean;

-- urgency is a small closed set; add the constraint only if it is not already there.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'practices_urgency_check') THEN
    ALTER TABLE practices ADD CONSTRAINT practices_urgency_check
      CHECK (urgency IS NULL OR urgency IN ('asap','3_6m','12m'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'practices_employment_type_check') THEN
    ALTER TABLE practices ADD CONSTRAINT practices_employment_type_check
      CHECK (employment_type IS NULL OR employment_type IN ('full_time','part_time','either'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS practices_group_id_idx ON practices (group_id);

-- Backfill: every existing practice becomes a group of one, carrying its current
-- token and agreement state up. In-flight intake links keep working because the
-- server reads the token from the group and falls back to practices.intake_token.
INSERT INTO practice_groups (entity_name, contact_name, contact_email, contact_phone,
                             intake_token, agreement_status, agreement_signed_at,
                             agreement_signed_by, agreement_signed_pdf_key, source, metadata)
SELECT p.name, p.contact_name, p.contact_email, p.contact_phone,
       p.intake_token, COALESCE(p.agreement_status, 'unsigned'), p.agreement_signed_at,
       p.agreement_signed_by, p.agreement_signed_pdf_key, p.source,
       jsonb_build_object('backfilled_from_practice', p.id)
FROM practices p
WHERE p.group_id IS NULL;

UPDATE practices p
SET group_id = g.id
FROM practice_groups g
WHERE p.group_id IS NULL
  AND g.metadata->>'backfilled_from_practice' = p.id::text;
```

- [ ] **Step 2: Verify the SQL parses**

There is no local Postgres. Do **not** claim the migration is applied. Verify only that it is syntactically well-formed by eye and that every `ALTER` is `IF NOT EXISTS`. Then check nothing else in the repo already claims that filename:

```bash
ls supabase/migrations/ | grep 20260716
```
Expected: only your new file.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260716120000_practice_intake_redesign.sql
git commit -m "feat(intake): migration - practice_groups + derived location/urgency columns"
```

**Do not apply this to production in this task.** Applying it is a deliberate, separate step (see "Shipping" at the foot of this plan).

---

### Task 4: Intake field schema + Facebook lead mapping

**Files:**
- Modify: `lib/practice-pipeline.js:21-42` (`INTAKE_FIELDS`), `:89-148` (`normalizeFacebookLeadPayload`), `:157` (`validatePracticeIntakePayload`)
- Test: `tests/practice-pipeline.test.js` (existing — 46 tests, all currently passing; **do not break them**)

**Interfaces:**
- Consumes: nothing.
- Produces: `INTAKE_FIELDS` gains `urgency`, `employment_type`, `gps_needed`, `website`, `supervision_available`; loses `role_title`. `normalizeFacebookLeadPayload` maps `contact_role`, `gp_needed_by` → `urgency`, `postcode`.

- [ ] **Step 1: Read the existing shape first**

```bash
sed -n '15,60p' lib/practice-pipeline.js
sed -n '85,175p' lib/practice-pipeline.js
```
Understand `INTAKE_FIELDS`' exact structure (labels/types/required) and how `validatePracticeIntakePayload` consumes it, including `{partial: true}`.

- [ ] **Step 2: Write the failing tests**

Append to `tests/practice-pipeline.test.js` (match the existing file's import style and `describe` conventions):

```js
describe('intake redesign - new fields', () => {
  it('asks for urgency, employment type, headcount and website', () => {
    const keys = INTAKE_FIELDS.map((f) => f.key);
    expect(keys).toContain('urgency');
    expect(keys).toContain('employment_type');
    expect(keys).toContain('gps_needed');
    expect(keys).toContain('website');
    expect(keys).toContain('supervision_available');
  });
  it('no longer asks for the role title - the system generates it', () => {
    expect(INTAKE_FIELDS.map((f) => f.key)).not.toContain('role_title');
  });
  it('accepts a valid urgency', () => {
    const r = validatePracticeIntakePayload({ urgency: 'asap' }, { partial: true });
    expect(r.errors.urgency).toBeUndefined();
  });
  it('rejects an urgency outside the closed set', () => {
    const r = validatePracticeIntakePayload({ urgency: 'someday' }, { partial: true });
    expect(r.errors.urgency).toBeTruthy();
  });
  it('rejects an employment type outside the closed set', () => {
    const r = validatePracticeIntakePayload({ employment_type: 'casual' }, { partial: true });
    expect(r.errors.employment_type).toBeTruthy();
  });
  it('accepts full_time, part_time and either', () => {
    for (const v of ['full_time', 'part_time', 'either']) {
      expect(validatePracticeIntakePayload({ employment_type: v }, { partial: true }).errors.employment_type)
        .toBeUndefined();
    }
  });
});

describe('facebook lead - the three new qualifiers', () => {
  it('maps the native Meta field_data shape', () => {
    const out = normalizeFacebookLeadPayload({
      field_data: [
        { name: 'practice_name', values: ['Erina Medical'] },
        { name: 'email', values: ['manager@erina.com.au'] },
        { name: 'contact_role', values: ['owner'] },
        { name: 'gp_needed_by', values: ['asap'] },
        { name: 'postcode', values: ['2250'] },
      ],
    });
    expect(out).toMatchObject({
      practice_name: 'Erina Medical', contact_role: 'owner', urgency: 'asap', postcode: '2250',
    });
  });
  it('maps the flat Zapier/Make shape too', () => {
    const out = normalizeFacebookLeadPayload({
      practice_name: 'X', contact_role: 'practice_manager', gp_needed_by: '3_6m', postcode: '3030',
    });
    expect(out).toMatchObject({ contact_role: 'practice_manager', urgency: '3_6m', postcode: '3030' });
  });
  it('survives a lead with none of the new fields', () => {
    expect(() => normalizeFacebookLeadPayload({ practice_name: 'Old Lead' })).not.toThrow();
  });
});
```

Add `INTAKE_FIELDS`, `validatePracticeIntakePayload` and `normalizeFacebookLeadPayload` to the file's existing `require` destructuring if they are not already imported.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/practice-pipeline.test.js`
Expected: the 46 existing tests still pass; the new ones fail.

- [ ] **Step 4: Implement**

In `lib/practice-pipeline.js`:
1. In `INTAKE_FIELDS`, **remove** the `role_title` entry and **add** (following the existing entry shape exactly):
   - `urgency` — label `"When do you need a GP?"`, required, one of `asap` / `3_6m` / `12m`
   - `employment_type` — label `"Full-time or part-time?"`, required, one of `full_time` / `part_time` / `either`
   - `gps_needed` — label `"How many GPs do you need?"`, required, text
   - `website` — label `"Your practice website"`, optional, text
   - `supervision_available` — label `"Is supervision available?"`, optional, boolean
2. In `validatePracticeIntakePayload`, enforce the two closed sets. Follow the existing error-shape convention (`errors[key] = '...'`).
3. In `normalizeFacebookLeadPayload`, map `contact_role`, `gp_needed_by` → `urgency`, `postcode` in **both** the native `field_data` shape and the flat shape. Keep unknown fields flowing into `metadata.fb_raw` as they do now.

- [ ] **Step 5: Run to verify all pass**

Run: `npx vitest run tests/practice-pipeline.test.js`
Expected: PASS — all 46 originals plus the new ones. **If any of the 46 broke, fix your change, not the test.**

- [ ] **Step 6: Commit**

```bash
git add lib/practice-pipeline.js tests/practice-pipeline.test.js
git commit -m "feat(intake): field schema for urgency/employment/headcount/website; FB lead qualifiers"
```

---

### Task 5: The intake→job seam — stop dropping the practice's answers

**This is display fixes 2 and 3.** The single highest-value task in the plan: the data already exists and is already rendered; nothing carries it across.

**Files:**
- Modify: `server.js` — `createPendingJobFromIntake` (~`:26466-26489`), `atsJobEditorPayload` (~`:29430-29475`)
- Test: `tests/practice-intake-job-handoff.test.js` (create)

**Interfaces:**
- Consumes: `parseSplit` from `lib/practice-intake-logic.js` (Task 1).
- Produces: `buildIntakeJobDetails(intake) → object` and `buildPackageTerms(intake) → object`, both exported from `lib/practice-intake-logic.js` so they can be tested without booting the server.

- [ ] **Step 1: Read the two functions before touching them**

```bash
grep -n "createPendingJobFromIntake" server.js | head
sed -n '26455,26500p' server.js
sed -n '29430,29480p' server.js
```
Note exactly which keys `atsJobEditorPayload` reads from `j.details` — your `details` object must use those same key names or the boxes stay blank.

- [ ] **Step 2: Write the failing test**

Create `tests/practice-intake-job-handoff.test.js`:

```js
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/practice-intake-job-handoff.test.js`
Expected: FAIL — `buildIntakeJobDetails is not a function`.

- [ ] **Step 4: Implement the two builders**

Add to `lib/practice-intake-logic.js` (and to its `module.exports`):

```js
/* The CEO job editor reads these exact keys off career_roles.details. If a key
   name drifts, the editor silently renders a blank box -- so this is a contract,
   not a convenience. See atsJobEditorPayload in server.js. */
function buildIntakeJobDetails(intake) {
  const i = intake || {};
  return {
    gp_count: i.gp_count,
    percentage_split: i.percentage_split,
    incentives: i.incentives,
    nursing_on_site: i.nursing_on_site,
    years_operating: i.years_operating,
    general_location: i.general_location,
    ownership: i.ownership,
    earnings_text: i.earnings_text,
    employment_type: i.employment_type,
    gps_needed: i.gps_needed,
    supervision_available: i.supervision_available,
    website: i.website,
  };
}

/* Both job pages already render a package/terms table; until now nothing has
   ever written it. Every row is omitted when empty rather than shown blank. */
function buildPackageTerms(intake) {
  const i = intake || {};
  const split = parseSplit(i.percentage_split);
  const pt = {};
  if (split) pt.billingSplit = split.display;
  if (i.incentives) pt.agreementBonus = i.incentives;
  if (i.earnings_text) pt.earnings = i.earnings_text;
  if (i.supervision_available === true) pt.supervision = 'Supervision available';
  else if (i.supervision_available === false) pt.supervision = 'No supervision on site';
  return pt;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/practice-intake-job-handoff.test.js`
Expected: PASS.

- [ ] **Step 6: Wire them into server.js**

In `createPendingJobFromIntake`, on the row it builds (`intakeJobRow`), add:
- `address: intake.address`
- `details: buildIntakeJobDetails(intake)`
- into the `source_payload.gpLink` object: `packageTerms: buildPackageTerms(intake)`

`require` the two builders from `lib/practice-intake-logic` at the top of `server.js` alongside the other lib requires.

Then in `atsJobEditorPayload`, add a `source_payload.intake` fallback for the seven `details`-backed fields, mirroring the existing `intro_text` / `intro_video_url` fallback at `:29466-29467` — so **jobs created before this change** also light up, not just new ones.

- [ ] **Step 7: Syntax-check and run the full suite**

```bash
node --check server.js && npx vitest run 2>&1 | tail -15
```
Expected: `node --check` silent (success), and no test regressions. Report the actual pass/fail counts.

- [ ] **Step 8: Commit**

```bash
git add lib/practice-intake-logic.js tests/practice-intake-job-handoff.test.js server.js
git commit -m "fix(intake): carry intake data to the job - details, address, packageTerms

The practice filled these in, we stored them, and the CEO editor rendered
empty boxes because nothing wrote career_roles.details. packageTerms was
render code that had never had a writer."
```

---

### Task 6: `/api/dpa/check` route

**Files:**
- Modify: `server.js` (add the route next to the other `/api/practice-intake` routes, ~`:33012`)
- Test: `tests/dpa-check-endpoint.test.js` (create; follow the shape of `tests/practice-intake-endpoints.test.js`)

**Interfaces:**
- Consumes: `lookupDpa` from `lib/dpa-lookup.js` (Task 2).
- Produces: `GET /api/dpa/check?lat=<n>&lon=<n>` → `200 {dpa, dpaCatchment, dpaBonded, mmm, source}` or `502 {error:'dpa_lookup_failed'}`.

- [ ] **Step 1: Read how a sibling public route is registered**

```bash
grep -n "'/api/practice-intake'" server.js | head -3
sed -n '33012,33050p' server.js
grep -n "practice-intake" server.js | grep -i "exempt\|public\|auth" | head
```
The intake page is token-gated and has **no session**, so this route must be reachable without auth — check the auth exemption list near `server.js:59071` and add the route there if required.

- [ ] **Step 2: Write the failing test**

Create `tests/dpa-check-endpoint.test.js` following the existing endpoint-test conventions in `tests/practice-intake-endpoints.test.js`. Cover:
- valid lat/lon → 200 with a `dpa` boolean
- missing or non-numeric lat/lon → 400
- lookup throws → **502 and no `dpa` field at all** (it must not fall back to `false`)
- the route is reachable without a session cookie

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/dpa-check-endpoint.test.js`

- [ ] **Step 4: Implement**

```js
// GET /api/dpa/check?lat=&lon= -- official DPA/MMM for one point.
// Server-side because the government endpoint is not CORS-enabled.
// On failure we return an error, never a default: the form then asks the practice.
if (pathname === '/api/dpa/check' && req.method === 'GET') {
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return sendJson(res, 400, { error: 'lat and lon are required' });
  }
  try {
    return sendJson(res, 200, await lookupDpa(lat, lon));
  } catch (err) {
    console.warn('[dpa] lookup failed', err && err.message);
    return sendJson(res, 502, { error: 'dpa_lookup_failed' });
  }
}
```

Match the file's actual local conventions for `sendJson`/`url`/`pathname` — read the surrounding routes and copy their style rather than pasting this verbatim. Apply the same rate-limit treatment the intake POST uses (`practice_intake:<ip>`, 30/hr) keyed as `dpa_check:<ip>`.

- [ ] **Step 5: Verify**

```bash
node --check server.js && npx vitest run tests/dpa-check-endpoint.test.js
```

- [ ] **Step 6: Commit**

```bash
git add server.js tests/dpa-check-endpoint.test.js
git commit -m "feat(intake): GET /api/dpa/check - official DPA lookup, errors never default to false"
```

---

### Task 7: Persist the redesigned intake

**Files:**
- Modify: `server.js` — `POST /api/practice-intake` (~`:33048-33130`)
- Test: `tests/practice-intake-endpoints.test.js` (extend)

**Interfaces:**
- Consumes: Task 3's columns; `nearestCity`, `buildGeneralLocation` from Task 1.
- Produces: the POST persists derived location + urgency + DPA confirmation to real columns.

**Context:** today the POST writes only 7 of 20 fields to columns (`server.js:33098-33110`); the rest live in `practices.metadata.intake`. Keep writing `metadata.intake` (it is the compatibility surface and other code reads it), **and additionally** write the new columns.

- [ ] **Step 1: Write the failing tests**

Extend `tests/practice-intake-endpoints.test.js` to assert the POST persists: `urgency`, `postcode`, `latitude`, `longitude`, `google_place_id`, `dpa`, `dpa_suggested`, `dpa_mismatch`, `employment_type`, `gps_needed`, `supervision_available`, and derived `suburb` / `nearest_city` / `general_location`. Add the key case:

```js
it('flags a mismatch when the practice contradicts the official DPA answer', async () => {
  // The practice's answer always wins -- we flag it for a human, we never overrule them.
  const saved = await submitIntake({ dpa: true, dpa_suggested: false /* ...rest */ });
  expect(saved.dpa).toBe(true);
  expect(saved.dpa_mismatch).toBe(true);
});

it('does not flag a mismatch when they agree', async () => {
  const saved = await submitIntake({ dpa: true, dpa_suggested: true /* ...rest */ });
  expect(saved.dpa_mismatch).toBe(false);
});

it('does not flag a mismatch when we had no suggestion to compare against', async () => {
  const saved = await submitIntake({ dpa: true, dpa_suggested: null /* ...rest */ });
  expect(saved.dpa_mismatch).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/practice-intake-endpoints.test.js`

- [ ] **Step 3: Implement the per-practice columns**

In the POST handler's patch object, add the new columns. Compute server-side (never trust the browser for these):
- `nearest_city` + `general_location` via `nearestCity(lat, lon)` and `buildGeneralLocation(...)`
- `dpa_mismatch = (dpa_suggested === true || dpa_suggested === false) && dpa !== dpa_suggested`

Keep the existing missing-column tolerance: if the migration has not been applied, the 503 `pipeline_migration_required` path must still work rather than throwing.

- [ ] **Step 4: Handle a group submission (multiple practices in one payload)**

The redesigned form can submit **several practices under one token**. The existing endpoint assumes one lead = one practice = one row; that assumption is what breaks for corporate groups.

Write these tests first, then implement:

```js
it('creates one practice row per clinic in the group', async () => {
  const saved = await submitIntake({ practices: [clinicA, clinicB, clinicC] });
  expect(saved.practices).toHaveLength(3);
  expect(new Set(saved.practices.map((p) => p.group_id)).size).toBe(1); // one group
});

it('inherits the group entity and ABN when a clinic does not override', async () => {
  const saved = await submitIntake({ entity_name: 'Head Co', abn: '51824753556', practices: [clinicA] });
  // Null on the practice means "inherit". Resolution happens on read, so a later
  // change to the group entity does not leave stale copies on each clinic.
  expect(saved.practices[0].entity_name).toBeNull();
});

it('records the override when a clinic trades under a different company', async () => {
  const saved = await submitIntake({
    entity_name: 'Head Co', abn: '51824753556',
    practices: [{ ...clinicB, entity_name: 'Branch Pty Ltd', abn: '004085616' }],
  });
  expect(saved.practices[0].entity_name).toBe('Branch Pty Ltd');
});

it('keeps a single-practice submission working exactly as before', async () => {
  const saved = await submitIntake({ practices: [clinicA] });
  expect(saved.practices).toHaveLength(1);
  expect(saved.practices[0].group_id).toBeTruthy(); // a group of one
});

it('still accepts a legacy single-practice payload with no practices array', async () => {
  // In-flight intake links predate this change and must not break.
  const saved = await submitIntake({ address: '...', billing_style: 'mixed', dpa: true });
  expect(saved.practices).toHaveLength(1);
});
```

Implementation notes:
- The token resolves to a **group**, falling back to `practices.intake_token` so in-flight links keep working (the migration backfilled a group of one for every existing practice).
- A clinic's `entity_name` / `abn` stay **NULL** when it inherits. Resolve on read (`clinic.entity_name ?? group.entity_name`), never by copying down.
- Each clinic keeps its own address, billing, split, DPA, urgency, and generates its own masked job.

- [ ] **Step 5: Verify**

```bash
node --check server.js && npx vitest run tests/practice-intake-endpoints.test.js
```

- [ ] **Step 5: Commit**

```bash
git add server.js tests/practice-intake-endpoints.test.js
git commit -m "feat(intake): persist derived location, urgency and the DPA confirmation to columns"
```

---

### Task 8: The form itself

**Files:**
- Rewrite: `pages/practice-intake.html`
- Reference (read-only, do not import): `~/.claude/jobs/eead77ab/tmp/map/practice-form.html` — the proven prototype
- Test: `tests/practice-intake-form.test.js` (create — this repo tests HTML pages by reading the file and asserting on its contents; see `tests/practice-status-page.test.js` for the pattern)

**Context:** the current page is 759 lines, two-step (form → e-sign), token-gated, `noindex`, no session. It builds its payload **by element ID from three arrays** (`:470-475`), not by `name=`. Keep that mechanism.

- [ ] **Step 1: Read both files fully before writing anything**

```bash
sed -n '1,120p' pages/practice-intake.html      # head, styles, token handling
sed -n '420,540p' pages/practice-intake.html    # the payload builder + submit
```
And read the prototype end to end. The prototype is the design; the existing page is the plumbing (token load, submit, e-sign, error handling). **You are porting the prototype's form into the existing page's plumbing.**

- [ ] **Step 2: Write the failing test**

Create `tests/practice-intake-form.test.js`:

```js
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'practice-intake.html'), 'utf8');

describe('practice intake form - the redesign', () => {
  it('asks for the address once, with autocomplete', () => {
    expect(html).toMatch(/id="addr"/);
    expect(html).toMatch(/places\.googleapis\.com|placesService|autocomplete/i);
  });
  it('no longer asks for suburb, nearest city or general location as questions', () => {
    // They are derived from the address and shown back for confirmation.
    expect(html).not.toMatch(/<input[^>]+id="suburb"/);
    expect(html).not.toMatch(/<input[^>]+id="nearest_city"/);
    expect(html).not.toMatch(/<input[^>]+id="general_location"/);
  });
  it('offers a manual fallback so a missed lookup can never block a submit', () => {
    expect(html).toMatch(/id="manual"/);
  });
  it('asks for urgency with the three agreed options', () => {
    expect(html).toMatch(/asap/); expect(html).toMatch(/3_6m/); expect(html).toMatch(/12m/);
  });
  it('asks full-time or part-time and never asks days and hours', () => {
    expect(html).toMatch(/full_time/); expect(html).toMatch(/part_time/);
    expect(html).not.toMatch(/days\s*&amp;?\s*hours/i);
    expect(html).not.toMatch(/sessions per week/i);
  });
  it('does not ask for a role title', () => {
    expect(html).not.toMatch(/<input[^>]+id="role_title"/);
  });
  it('asks for the practice website', () => {
    expect(html).toMatch(/id="website"/);
  });
  it('gives the incentives box a worked example including an income guarantee', () => {
    expect(html).toMatch(/income guarantee/i);
    expect(html).toMatch(/relocation/i);
  });
  it('accepts an ABN or an ACN', () => {
    expect(html).toMatch(/ACN/);
  });
  it('makes the practice confirm DPA rather than accepting our suggestion', () => {
    expect(html).toMatch(/dpaYes/); expect(html).toMatch(/dpaNo/);
    expect(html).toMatch(/confirm/i);
  });
  it('embeds the agreement so nobody signs a document they have not seen', () => {
    expect(html).toMatch(/gp-link-practice-agreement-2026\.pdf/);
  });
  it('gates the submit on all 8 fields', () => {
    expect(html).toMatch(/of 8 completed/);
    expect(html).toMatch(/id="submit"[^>]*disabled/);
  });
  it('persists a draft so a reload does not lose the practice\'s work', () => {
    expect(html).toMatch(/gplink_intake_draft_v3/);
  });
  it('stays out of search results', () => {
    expect(html).toMatch(/noindex/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/practice-intake-form.test.js`
Expected: most cases fail against the current page.

- [ ] **Step 4: Port the form**

Rewrite `pages/practice-intake.html` as the 5 steps in the spec, porting from the prototype:

1. **Where** — address autocomplete → derived strip (suburb / state / postcode / nearest city, with an edit link) → DPA suggest + mandatory confirm → urgency → billing style → split with the live "GP 70% / Practice 30%" readout.
2. **The job** — GPs needed, employment type.
3. **The pitch** — about the area & the job, incentives, earnings, visa, website, years operating, ownership, nursing, supervision, video. Tooltips and worked examples on every free-text field.
4. **Your practices** — one by default. "Add another" for groups; per-clinic "trades under a different company" override. **Adding a second practice must be reversible** — the prototype fixed this; do not reintroduce the trap.
5. **Sign** — embedded agreement PDF, 8 gates, no pre-fill, live "n of 8 completed" listing what is missing.

Rules to carry across:
- Google Places is called **from the browser** with `GOOGLE_MAPS_BROWSER_API_KEY` (already exposed to the client at `server.js:20791-20793`). The key is referrer-locked, which is the protection. **Do not proxy it** — a server key would need that protection removed. (The prototype proxied it only because it ran on localhost.)
- The DPA panel calls **our** `/api/dpa/check`. On any error: say we could not check, leave DPA unanswered, require an answer. Never pre-select.
- Draft persistence under `gplink_intake_draft_v3`, debounced ~250ms.
- Keep the existing token load / submit / e-sign plumbing and the ID-array payload builder.
- Bump the cache buster to `?v=20260716a`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/practice-intake-form.test.js && npx vitest run 2>&1 | tail -8`
Expected: PASS, no regressions elsewhere. Report real numbers.

- [ ] **Step 6: Commit**

```bash
git add pages/practice-intake.html tests/practice-intake-form.test.js
git commit -m "feat(intake): rewrite the practice intake form - 5 steps, one address, confirmed DPA"
```

---

### Task 9: Show the practice's answers to the GP

**This is display fixes 1 and 4.**

**Files:**
- Modify: `pages/job.html` (package block at `:1818-1839`, benefits at `:1842`), `pages/site-job.html` (package rows at `:340-360`)
- Modify: `server.js:19002-19007` (`PUBLIC_JOB_FIELDS` whitelist) if `introText`/practice facts need to reach the public page
- Test: `tests/job-page-practice-about.test.js` (create)

**Interfaces:**
- Consumes: `gpLink.packageTerms` (now written — Task 5), `intro_text`.

**Context:** `PUBLIC_JOB_FIELDS` deliberately never includes `practice_name` — the public board is **identity-masked**. Whatever you surface must not deanonymise the practice. An "about the area" paragraph is fine; the practice's name, website or street address is **not**.

- [ ] **Step 1: Read the render blocks and the whitelist**

```bash
sed -n '1810,1850p' pages/job.html
sed -n '335,365p' pages/site-job.html
sed -n '18995,19010p' server.js
```

- [ ] **Step 2: Write the failing test**

Create `tests/job-page-practice-about.test.js`:

```js
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const jobPage = read('pages/job.html');
const sitePage = read('pages/site-job.html');
const server = read('server.js');

describe('the practice writes an introduction and a GP finally reads it', () => {
  it('the in-app job page renders an about section', () => {
    expect(jobPage).toMatch(/About the practice/i);
  });
  it('the public job page renders an about section', () => {
    expect(sitePage).toMatch(/About the practice/i);
  });
  it('the about text reaches the public page through the whitelist', () => {
    expect(server).toMatch(/introText|intro_text/);
  });
});

describe('practice facts', () => {
  it('the job page can show GP count, years operating and nursing', () => {
    expect(jobPage).toMatch(/gp_count|gpCount/);
    expect(jobPage).toMatch(/years_operating|yearsOperating/);
    expect(jobPage).toMatch(/nursing_on_site|nursingOnSite/);
  });
});

describe('masking is not weakened', () => {
  it('the public whitelist still refuses the practice name', () => {
    const block = server.slice(server.indexOf('PUBLIC_JOB_FIELDS'), server.indexOf('PUBLIC_JOB_FIELDS') + 700);
    expect(block).not.toMatch(/'practice_name'|"practice_name"/);
  });
  it('the public page does not expose the practice website or street address', () => {
    expect(sitePage).not.toMatch(/practice\.website|job\.website/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/job-page-practice-about.test.js`

- [ ] **Step 4: Implement**

1. Add an **"About the practice & the area"** section to both pages, fed by `intro_text`, rendered only when non-empty. Escape it — it is practice-authored text going onto a public page. Follow each page's existing section markup and class names.
2. Add a small **practice facts** row (GPs on site, years operating, nursing on site) — again, only render a fact that exists. Do not print "Nursing: undefined".
3. Extend `PUBLIC_JOB_FIELDS` with the about text and the three facts. **Do not add the practice name, website, or street address** — the board is masked.
4. `packageTerms` needs no render work: it is already rendered on both pages and now has a writer.

- [ ] **Step 5: Verify**

```bash
node --check server.js && npx vitest run 2>&1 | tail -8
```

- [ ] **Step 6: Commit**

```bash
git add pages/job.html pages/site-job.html server.js tests/job-page-practice-about.test.js
git commit -m "feat(job): show the practice's introduction and facts to GPs"
```

---

### Task 10: Schedule 1 — the covered practices

**Files:**
- Modify: `lib/practice-agreement-pdf.js` (`stampAgreementExecutionPage`, ~`:74`), `server.js` — `POST /api/practice-intake/sign` (~`:33137-33280`)
- Test: `tests/practice-agreement-pdf.test.js` (extend — read it first; the agreement is legally sensitive and already covered)

**Context:** **Read `docs/handover-practice-agreement-2026.md` before touching anything here.** The agreement was rebuilt on 2026-07-15 and has traps documented in that handover. One signature covers every practice in the group; Schedule 1 is what makes that true, listing each practice against its contracting entity and ABN.

- [ ] **Step 1: Read the handover and the existing test**

```bash
cat docs/handover-practice-agreement-2026.md
sed -n '1,60p' tests/practice-agreement-pdf.test.js
sed -n '60,120p' lib/practice-agreement-pdf.js
```

- [ ] **Step 2: Write the failing test**

Extend `tests/practice-agreement-pdf.test.js`: given a group of three practices where the second overrides the group entity, the stamped PDF contains a Schedule 1 listing all three, each against its correct contracting entity and ABN. Follow the existing test's mechanism for asserting on stamped output.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/practice-agreement-pdf.test.js`
Expected: the existing tests pass; the new one fails.

- [ ] **Step 4: Implement**

Add the Schedule 1 page to `stampAgreementExecutionPage`, and pass the group's practices into it from the sign endpoint. A solo practice still gets a Schedule 1 of one — one code path, no branching.

- [ ] **Step 5: Verify**

```bash
node --check server.js && npx vitest run tests/practice-agreement-pdf.test.js tests/practice-intake-endpoints.test.js
```

- [ ] **Step 6: Commit**

```bash
git add lib/practice-agreement-pdf.js server.js tests/practice-agreement-pdf.test.js
git commit -m "feat(agreement): Schedule 1 - one signature covers every practice in the group"
```

---

## ⚠️ MERGE BLOCKER — discovered during execution, 2026-07-16

**Task 4 and Task 8 are coupled. Do not merge this branch with Task 4 done and Task 8 unfinished.**

Task 4 makes `urgency`, `employment_type` and `gps_needed` **required**. The currently-live `pages/practice-intake.html` sends none of them (grep: 0 hits) — Task 8 is what makes the form send them. Verified by hand on this branch:

```
validatePracticeIntakePayload(<payload the live form actually sends>)
  -> {"ok":false,"error":"urgency is required"}
```

Merging before Task 8 lands would **400 every practice intake submission in production** — the front door for every paying client.

**Ordering that is safe:**
1. Apply the Task 3 migration **first** (before any code that writes the new columns), or the intake POST 503s with `pipeline_migration_required`.
2. Land Tasks 4 and 8 **together**.

**Also note:** Tasks 5, 6, 7, 9 and 10 all modify `server.js`. Run them **sequentially** — parallel implementers will conflict.

## Measured test baseline (do not misread these as regressions)

Full suite on **pristine `origin/main` @ `e91c128`**, measured 2026-07-16:

```
Test Files  8 failed | 196 passed (204)
     Tests  30 failed | 2916 passed (2946)
```

Already failing on main, untouched by this branch: `eligibility-waitlist`, `onboarding-review-roundtrip`, `practice-intake-endpoints`, `practice-status-page`, `site-enquiry`, `site-jobs-page`, `site-link-audit`, `site-public-routes`.

**Judge regressions against `30 failed`, not against zero.** Note `tests/practice-intake-endpoints.test.js` already fails on main (the sign happy-path and `already_signed` cases) — Task 7 extends that file, so characterise those two failures before adding to it.

## Shipping

After Task 10, in this order:

1. **Full suite:** `npx vitest run` — report the real numbers, including any pre-existing failures you did not cause.
2. **Syntax:** `node --check server.js`.
3. **Apply the migration** (Task 3) to production Supabase via `rpc/exec_sql` with the service role key from `.env` (**not** `.env.prod`). Until it is applied, the intake POST returns 503 `pipeline_migration_required` and the form cannot save — so the migration goes first, and it is backwards-compatible by design.
4. **Browser click-through is owed** and has never been done on this form. It cannot be skipped: the form is the front door for every paying client.
5. **Owner actions** (not ours): the two Facebook env vars in Vercel + point Meta's webhook at `/api/webhooks/facebook-lead`.

## What this plan does not do

- Import DPA/MMM shapefiles into PostGIS (open item 5 in the spec). Live HWL calls until then.
- Fix the pre-existing `career_roles.dpa = false` Zoho legacy data (spec open item 4). Verify before spending on ads.
- Open the Facebook front door. That is env config, not code.
</content>
</invoke>

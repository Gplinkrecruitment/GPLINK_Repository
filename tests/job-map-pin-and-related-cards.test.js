// Two closely-related changes on the job-advert surfaces (2026-07-24):
//
//  (1) INTERACTIVE MAP, PIN LOCKED TO THE SUBURB. The area map is now a real
//      google.maps.Map (the visitor CAN pan and zoom), and the branded pin is
//      drawn INSIDE the map as an OverlayView that re-projects to the suburb's
//      lat/lng on every move (getProjection().fromLatLngToDivPixel) — so the
//      pin stays on the suburb as the map moves, instead of floating at the
//      container centre like the old absolute overlay did. The browser Maps key
//      comes from GET /api/public/maps-config; on failure (no key / geocode
//      miss) it falls back to the raw Google embed, which carries its own pin
//      and is itself pan/zoomable. Applies to the public website advert
//      (pages/site-job.html) and the in-app advert (pages/job.html).
//
//  (2) RICHER "OTHER ROLES YOU MIGHT LIKE" CARDS (public advert): show the
//      suburb photo (header_image_url), billing type (billing_model) and income
//      (earnings_text, falling back to packageTerms.incomeGuarantee) — the same
//      fields the main jobs list card renders. All already ship on every
//      /api/public/jobs item (PUBLIC_JOB_FIELDS), so this is a client-only change.
//
// Source-level assertions (read the page files as strings), the same idiom
// tests/job-writeup-render.test.js and tests/site-jobs-page.test.js use for
// these inline-script marketing pages — there is no jsdom in this repo.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const siteJob = fs.readFileSync(path.join(ROOT, 'pages', 'site-job.html'), 'utf8');
const appJob = fs.readFileSync(path.join(ROOT, 'pages', 'job.html'), 'utf8');
const siteJobs = fs.readFileSync(path.join(ROOT, 'pages', 'site-jobs.html'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const relatedCardFn = (siteJob.match(/function buildRelatedCard\(job\)\s*\{[\s\S]*?\n  \}/) || [''])[0];

describe('area map: keyless Leaflet, interactive, pin locked to the suburb', () => {
  it('public advert (site-job.html) uses keyless Leaflet + CARTO tiles, not Google Maps', () => {
    // Real interactive Leaflet map, no API key (Google key is referrer-restricted
    // + not authorized for Geocoding, so it breaks across domains like preview).
    expect(siteJob).toMatch(/leaflet@1\.9\.4\/dist\/leaflet\.js/);
    expect(siteJob).toMatch(/L\.map\(/);
    expect(siteJob).toMatch(/L\.divIcon\(/);
    // CARTO started stamping "API KEY REQUIRED" over keyless requests
    // (2026-09-01), so every map's basemap moved to Esri's keyless tiles.
    expect(siteJob).toMatch(/server\.arcgisonline\.com/);
    expect(siteJob).not.toMatch(/basemaps\.cartocdn\.com/);
    // Coordinates from OUR keyless endpoint; never Google Maps JS / Geocoder.
    expect(siteJob).toMatch(/\/api\/public\/suburb-geo/);
    expect(siteJob).not.toMatch(/maps\.googleapis\.com\/maps\/api\/js/);
    expect(siteJob).not.toMatch(/new maps\.Map\(/);
    expect(siteJob).not.toMatch(/new maps\.Geocoder/);
    // The old "lock the iframe so a centred overlay stays put" hack is gone.
    expect(siteJob).not.toMatch(/\.job-profile-map iframe\{[^}]*pointer-events:\s*none/);
    // Graceful fallback to the raw embed keeps the map area from going blank.
    expect(siteJob).toMatch(/showSuburbMapFallback/);
  });

  it('in-app advert (job.html) uses keyless Leaflet + Esri tiles, not Google Maps', () => {
    expect(appJob).toMatch(/leaflet@1\.9\.4\/dist\/leaflet\.js/);
    expect(appJob).toMatch(/L\.map\(/);
    expect(appJob).toMatch(/L\.divIcon\(/);
    expect(appJob).toMatch(/server\.arcgisonline\.com/);
    expect(appJob).not.toMatch(/basemaps\.cartocdn\.com/);
    expect(appJob).toMatch(/\/api\/public\/suburb-geo/);
    expect(appJob).not.toMatch(/maps\.googleapis\.com\/maps\/api\/js/);
    expect(appJob).not.toMatch(/new maps\.Map\(/);
    // buildMapHtml emits a map canvas wired up by initAtMaps(), not a centred
    // absolute overlay pin over a locked iframe.
    expect(appJob).toMatch(/data-at-map/);
    expect(appJob).toMatch(/function initAtMaps\(/);
    expect(appJob).not.toMatch(/\.at-map iframe \{[^}]*pointer-events:\s*none/);
    expect(appJob).not.toMatch(/class="at-map-overlay/);
    expect(appJob).toMatch(/function atMapFallback\(/);
  });

  it('server exposes the keyless suburb-geo endpoint + allows the tile/library hosts in CSP', () => {
    expect(server).toMatch(/\/api\/public\/suburb-geo/);
    // Reuses the cached, keyless suburb geocoder (Supabase cache -> Nominatim).
    expect(server).toMatch(/resolveCareerSuburbCoordinates\(\{\s*suburb,\s*state,\s*country\s*\}\)/);
    // CSP must permit the Leaflet CDN (style) and the raster tiles (img).
    expect(server).toMatch(/KEYLESS_MAP_CSP_STYLE_SOURCES/);
    expect(server).toMatch(/server\.arcgisonline\.com/);
  });
});

describe('/jobs Australia practice map section', () => {
  it('has the map section that "falls off" the search bar (finder wraps the form + map)', () => {
    // Form tag must stay exactly as tests elsewhere assert, now inside the finder.
    expect(siteJobs).toMatch(/<div class="jobs-finder">/);
    expect(siteJobs).toMatch(/<form class="jobs-filter-card" id="jobSearch">/);
    expect(siteJobs).toMatch(/id="jobsMapShell"/);
    expect(siteJobs).toMatch(/id="pmap"/);
  });

  it('renders a keyless clustered Leaflet map fed by /api/public/practice-map', () => {
    expect(siteJobs).toMatch(/\/api\/public\/practice-map/);
    expect(siteJobs).toMatch(/leaflet@1\.9\.4\/dist\//);
    expect(siteJobs).toMatch(/leaflet\.markercluster@1\.5\.3/);
    expect(siteJobs).toMatch(/server\.arcgisonline\.com/);
    expect(siteJobs).not.toMatch(/basemaps\.cartocdn\.com/);
    expect(siteJobs).toMatch(/markerClusterGroup/);
    // Opens on all of Australia.
    expect(siteJobs).toMatch(/center:\s*\[-2[0-9](\.\d+)?\s*,\s*13[0-9](\.\d+)?\]/);
    // Never Google Maps here either.
    expect(siteJobs).not.toMatch(/maps\.googleapis\.com\/maps\/api\/js/);
  });

  it('pin sidebar shows suburb photo, income, benefits and a real job link', () => {
    expect(siteJobs).toMatch(/id="pmapPhoto"/);
    expect(siteJobs).toMatch(/id="pmapIncome"/);
    expect(siteJobs).toMatch(/id="pmapBenefits"/);
    expect(siteJobs).toMatch(/'\/jobs\/view\?id='\s*\+\s*encodeURIComponent\(p\.id\)/);
    // Sidebar is a bottom sheet on mobile.
    expect(siteJobs).toMatch(/@media\(max-width:760px\)\{[\s\S]*\.pmap-detail\{[^}]*translateY/);
  });

  it('captions the public map with a DYNAMIC member-exclusive split', () => {
    // 2026-07-25: the public map shows only the openly-advertised roles; the
    // exclusive % is no longer hardcoded — it's derived from the weekly headline
    // total R vs the shown practice count A as (R−A)/R, with a 90% fallback.
    expect(siteJobs).toContain('practices with public advertisement');
    expect(siteJobs).toContain('id="pmapExcl"');
    expect(siteJobs).toContain('exclusive to members');
    expect(siteJobs).not.toContain('practices across Australia · tap a pin');
    // weeklyTotal (R) + the true public total (A) flow from the practice-map
    // payload; the split is (R−A)/R.
    expect(siteJobs).toContain('d&&d.weeklyTotal');
    expect(siteJobs).toContain('d&&d.total');
    expect(siteJobs).toMatch(/\(R-A\)\/R/);
    // Caption count = the true public-roles total (matches the "N roles
    // available right now" list), NOT the geocodable pin subset — so the two
    // numbers can never contradict each other.
    expect(siteJobs).toMatch(/A=Number\(total\)/);
    // The caption is repainted on every live filter change, so it moved into
    // drawCaption() and now guards the lookup instead of assuming the element.
    expect(siteJobs).toMatch(/function drawCaption\(practices,weeklyTotal,total,isFiltered\)/);
    expect(siteJobs).toMatch(/if\(countEl\)countEl\.textContent=A;/);
  });

  it('server builds the masked, keyless practice-map payload', () => {
    expect(server).toMatch(/\/api\/public\/practice-map/);
    expect(server).toMatch(/function buildPracticeMapData/);
    // Same mask path as /api/public/jobs (mapCareerRoleRowToPublicJob -> sanitize).
    expect(server).toMatch(/mapCareerRoleRowToPublicJob/);
    expect(server).toMatch(/readAllSuccessfulSuburbGeo/);
    // Weekly headline total (241–260) exposed so the map can derive the split.
    expect(server).toMatch(/function getWeeklyPublicJobsTotal/);
    // Attached conditionally now: the member-exclusive split compares against
    // the week's FULL role count, so it is omitted on a filtered request.
    expect(server).toMatch(/payload\.weeklyTotal = getWeeklyPublicJobsTotal\(\)/);
    expect(server).toMatch(/if \(!filtered\) payload\.weeklyTotal/);
    // Payload also carries the true public-roles total (== the /jobs list count)
    // so the caption states it, never the geocodable-pin subset.
    // radiusM rides along so every map draws the same 10km perimeter and none
    // of them hardcodes it.
    expect(server).toMatch(/\{ ok: true, practices, total, filtered, radiusM: PUBLIC_PIN_RADIUS_M \}/);
  });

  it('the map payload is filtered by the same params as the jobs list', () => {
    // Regression (2026-07-29): the endpoint took no params, so the pins ignored
    // every filter and always drew the full set.
    expect(server).toMatch(/function filterPracticeMapPractices/);
    expect(server).toMatch(/function practiceMapHasFilters/);
    expect(server).toMatch(/filterPracticeMapPractices\(allPractices, mapParams\)/);
    // Billing rules shared with the jobs API rather than reimplemented.
    expect(server).toMatch(/classifyPublicJobBilling\(\{ billing_model: p && p\.billing \}\)/);
  });
});

// 2026-07-29: the "area" ring around every public pin used to be a CSS disc at
// a fixed pixel size (112px on the website advert, 60px in the app), so it
// scaled with the SCREEN, not the map — it represented a few hundred metres
// zoomed in and tens of kilometres zoomed out. It is now a real L.circle whose
// radius is metres on the ground, served by the API so all three maps agree.
describe('map area ring is a real 10km circle, not a fixed-pixel CSS disc', () => {
  const appJobSrc = appJob;

  it('server defines the radius once and ships it with the coordinates', () => {
    expect(server).toMatch(/const PUBLIC_PIN_RADIUS_M = 10000;/);
    expect(server).toMatch(/radiusM: PUBLIC_PIN_RADIUS_M/);
  });

  it('the website advert draws L.circle in metres and drops the CSS ring', () => {
    expect(siteJob).toMatch(/L\.circle\(\[coords\.lat, coords\.lng\], \{\s*radius: coords\.radiusM/);
    expect(siteJob).not.toMatch(/<span class="map-ring">/);
    expect(siteJob).not.toMatch(/\.map-ring\{[^}]*width:112px/);
    // A fixed zoom would clip a 20km-wide circle; frame it instead.
    expect(siteJob).toMatch(/fitBounds\(areaCircle\.getBounds\(\)/);
  });

  it('the in-app advert draws L.circle in metres and drops the CSS ring', () => {
    expect(appJobSrc).toMatch(/L\.circle\(\[coords\.lat, coords\.lng\], \{\s*radius: coords\.radiusM/);
    expect(appJobSrc).not.toMatch(/<span class="at-ring/);
    expect(appJobSrc).toMatch(/fitBounds\(areaCircle\.getBounds\(\)/);
  });

  it('the /jobs board draws the areas in their own layer, outside the cluster', () => {
    // A collapsed cluster hides its child markers; the area must stay visible.
    expect(siteJobs).toMatch(/function drawAreas\(L,practices,radiusM\)/);
    expect(siteJobs).toMatch(/areaLayer=L\.layerGroup\(\)\.addTo\(mapObj\)/);
    expect(siteJobs).toMatch(/radius:r,interactive:false/);
    expect(siteJobs).toMatch(/d&&d\.radiusM/);
  });
});

// 2026-07-29: the advert maps still carried Leaflet's full-size corner
// branding — "[flag] Leaflet | © OpenStreetMap © CARTO" in blue link text —
// while the /jobs board had already been toned down. All three now match.
// The OSM/CARTO credit itself must SURVIVE: the tile licences require
// attribution, so this is a styling change, never a removal.
describe('map attribution is small and subtle on every map', () => {
  for (const [name, src, scope] of [
    ['/jobs board', siteJobs, '.jobs-map-shell'],
    ['website advert', siteJob, '.job-profile-map'],
    ['in-app advert', appJob, '.at-map']
  ]) {
    it(`${name}: drops the Leaflet prefix but keeps the licence credit`, () => {
      expect(src).toMatch(/attributionControl\.setPrefix\(false\)/);
      expect(src).toContain(`${scope} .leaflet-control-attribution`);
      expect(src).toMatch(/font-size:\s*10px/);
      // The credit is a licence obligation — it must still be emitted.
      expect(src).toMatch(/openstreetmap\.org\/copyright/);
      expect(src).toMatch(/CARTO/);
      // Attribution must never be switched off wholesale.
      expect(src).not.toMatch(/attributionControl:\s*false/);
    });
  }
});

describe('public map pins are nudged off the suburb centre', () => {
  it('the server jitters before the point leaves the building', () => {
    expect(server).toMatch(/function applyPublicPinJitter/);
    expect(server).toMatch(/const pin = applyPublicPinJitter\(coords\.lat, coords\.lng, job\.id\)/);
    // suburb-geo takes an optional stable seed so the advert maps get the same
    // treatment as the board pins.
    expect(server).toMatch(/searchParams\.get\('seed'\)/);
    expect(server).toMatch(/applyPublicPinJitter\(rawLat, rawLng, seed\)/);
  });

  it('both advert pages send the role id as that seed', () => {
    expect(siteJob).toMatch(/params \+= '&seed=' \+ encodeURIComponent\(seed\)/);
    expect(siteJob).toMatch(/renderSuburbMap\(job\.suburb, job\.location_state, job\.id\)/);
    expect(appJob).toMatch(/params \+= '&seed=' \+ encodeURIComponent\(seed\)/);
    expect(appJob).toMatch(/data-map-seed/);
    // Seed is part of the app's geocode cache key, or two roles in one suburb
    // would share the first one's pin.
    expect(appJob).toMatch(/var key = suburb \+ '\|' \+ state \+ '\|' \+ \(seed \|\| ''\)/);
  });
});

describe('related roles cards show suburb photo, billing type and income', () => {
  it('extracted buildRelatedCard exists', () => {
    expect(relatedCardFn).not.toBe('');
  });

  it('renders the suburb photo thumbnail from header_image_url', () => {
    expect(relatedCardFn).toMatch(/job\.header_image_url/);
    expect(relatedCardFn).toMatch(/jrc-hero/);
  });

  it('renders the billing type as a chip', () => {
    expect(relatedCardFn).toMatch(/chipHtml\(job\.billing_model\)/);
  });

  it('renders income from earnings_text with an incomeGuarantee fallback', () => {
    expect(relatedCardFn).toMatch(/job\.earnings_text\s*\|\|\s*pt\.incomeGuarantee/);
    expect(relatedCardFn).toMatch(/jrc-income/);
  });

  it('has matching CSS for the new card elements', () => {
    expect(siteJob).toMatch(/\.jrc-hero\{/);
    expect(siteJob).toMatch(/\.jrc-chips \.chip\{/);
    expect(siteJob).toMatch(/\.jrc-income\{/);
  });
});

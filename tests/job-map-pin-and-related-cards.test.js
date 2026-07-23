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

const relatedCardFn = (siteJob.match(/function buildRelatedCard\(job\)\s*\{[\s\S]*?\n  \}/) || [''])[0];

describe('area map: interactive (pan/zoom) with pin locked to the suburb', () => {
  it('public advert (site-job.html) renders a real google.maps.Map, not a locked embed', () => {
    // A real interactive map, keyed from the public maps-config endpoint.
    expect(siteJob).toMatch(/\/api\/public\/maps-config/);
    expect(siteJob).toMatch(/new maps\.Map\(/);
    expect(siteJob).toMatch(/gestureHandling:\s*'cooperative'/);
    // The pin is an OverlayView re-projected to the suburb on every move.
    expect(siteJob).toMatch(/OverlayView/);
    expect(siteJob).toMatch(/fromLatLngToDivPixel/);
    expect(siteJob).toMatch(/new maps\.Geocoder\(\)/);
    // The old "lock the iframe so a centred overlay stays put" hack is gone.
    expect(siteJob).not.toMatch(/\.job-profile-map iframe\{[^}]*pointer-events:\s*none/);
    // Graceful fallback to the raw embed keeps the map area from going blank.
    expect(siteJob).toMatch(/showSuburbMapFallback/);
  });

  it('in-app advert (job.html) renders a real google.maps.Map, not a locked embed', () => {
    expect(appJob).toMatch(/\/api\/public\/maps-config/);
    expect(appJob).toMatch(/new maps\.Map\(/);
    expect(appJob).toMatch(/gestureHandling:\s*'cooperative'/);
    expect(appJob).toMatch(/OverlayView/);
    expect(appJob).toMatch(/fromLatLngToDivPixel/);
    expect(appJob).toMatch(/new maps\.Geocoder\(\)/);
    // buildMapHtml now emits a map canvas wired up by initAtMaps(), not a
    // centred absolute overlay pin over a locked iframe.
    expect(appJob).toMatch(/data-at-map/);
    expect(appJob).toMatch(/function initAtMaps\(/);
    expect(appJob).not.toMatch(/\.at-map iframe \{[^}]*pointer-events:\s*none/);
    expect(appJob).not.toMatch(/class="at-map-overlay/);
    expect(appJob).toMatch(/function atMapFallback\(/);
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

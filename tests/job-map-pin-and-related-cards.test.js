// Two closely-related fixes on the job-advert surfaces (2026-07-24):
//
//  (1) MAP PIN STAYS FIXED. The suburb/area map is a Google Maps `output=embed`
//      iframe with an absolutely-positioned pin/ring/label overlay anchored to
//      the container CENTRE. If the visitor can pan the iframe, the map slides
//      out from under the fixed overlay and the pin appears to "move with" the
//      drag. Locking the embed (pointer-events:none on the iframe, the same
//      pattern career.html's .at-match-map already uses) keeps the map centre
//      on the suburb so the pin always marks it. Applies to BOTH the public
//      website advert (pages/site-job.html) and the in-app advert (pages/job.html).
//
//  (2) RICHER "OTHER ROLES YOU MIGHT LIKE" CARDS. The related-roles rail on the
//      public advert now shows the suburb photo (header_image_url), the billing
//      type (billing_model) and the income (earnings_text, falling back to the
//      owner-supplied packageTerms.incomeGuarantee) — the same fields the main
//      jobs list card already renders. All of these already ship on every
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

// Pull out the buildRelatedCard function body so the card assertions can't be
// satisfied by an unrelated part of the (large) page.
const relatedCardFn = (siteJob.match(/function buildRelatedCard\(job\)\s*\{[\s\S]*?\n  \}/) || [''])[0];

describe('job map pin stays fixed (embed is pan/zoom-locked)', () => {
  it('public advert (site-job.html) locks .job-profile-map iframe', () => {
    expect(relatedCardFn).not.toBe('');
    expect(siteJob).toMatch(/\.job-profile-map iframe\{[^}]*pointer-events:\s*none[^}]*\}/);
  });

  it('in-app advert (job.html) locks .at-map iframe', () => {
    expect(appJob).toMatch(/\.at-map iframe \{[^}]*pointer-events:\s*none;[^}]*\}/);
  });
});

describe('related roles cards show suburb photo, billing type and income', () => {
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

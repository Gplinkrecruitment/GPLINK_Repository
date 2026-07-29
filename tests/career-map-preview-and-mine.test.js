// Two owner-reported fixes on the in-app careers map (pages/career.html,
// 2026-07-30):
//
//  (1) TAPPING A PIN SHOWED NOTHING ON iOS. The preview card opened (it got
//      .open + aria-hidden=false) but was never painted. Cause: the card was
//      `position:absolute; top:100%` INSIDE .cmap-shell, escaping downward, and
//      its ancestor .cmap-wrap carried `overflow-x:clip; overflow-y:visible`.
//      That mixed pair is resolved by some engines (iOS Safari/WebKit) as if
//      overflow-y were `auto`, which turns .cmap-wrap into a scroll box and
//      clips the card away entirely. Reproduced in Chromium by forcing
//      overflow-y:auto: the card's own coordinates hit-tested to the role list
//      behind it. Fix: the card is a sibling of the map shell inside a new
//      .cmap-stage, in-flow (position:static, display:none/block) on mobile, and
//      .cmap-wrap no longer clips on either axis. The closed card no longer
//      parks off to the right, so there is nothing left to clip.
//
//  (2) MATCHES/APPLICATIONS UNDER THE MAP. The practices the doctor has been
//      matched with or has applied to are listed beneath the map and their pins
//      are highlighted. Each card carries the SAME data-open-application ids the
//      Offers list uses, so the existing document-level handler opens that
//      application's timeline (application-detail) with no second routing path.
//
// Source-level assertions (the page is one big inline-script file; there is no
// jsdom in this repo) — the same idiom as job-map-pin-and-related-cards.test.js.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const career = fs.readFileSync(path.join(ROOT, 'pages', 'career.html'), 'utf8');
const siteJobs = fs.readFileSync(path.join(ROOT, 'pages', 'site-jobs.html'), 'utf8');

const cmapWrapRule = (career.match(/\.cmap-wrap\{[^}]*\}/) || [''])[0];
const cmapDetailRule = (career.match(/\.cmap-detail\{[^}]*\}/) || [''])[0];
const mobileBlock = (career.match(/@media\(max-width:760px\)\{[\s\S]*?\n    \}/) || [''])[0];

describe('career map: the pin preview card can never be clipped away', () => {
  it('.cmap-wrap does not mix overflow-x:clip with overflow-y:visible', () => {
    expect(cmapWrapRule).toBeTruthy();
    // The exact pair that iOS resolves as a scroll box.
    expect(cmapWrapRule).not.toMatch(/overflow-x:\s*clip/);
    expect(cmapWrapRule).toMatch(/overflow:\s*visible/);
  });

  it('the closed card does not park off to the right (nothing needs clipping)', () => {
    expect(cmapDetailRule).toBeTruthy();
    expect(cmapDetailRule).not.toMatch(/translateX\(10\d%\)/);
    expect(cmapDetailRule).toMatch(/visibility:\s*hidden/);
  });

  it('the card is a sibling of the map shell inside .cmap-stage, not inside it', () => {
    expect(career).toMatch(/<div class="cmap-stage">/);
    // shell closes BEFORE the detail card opens
    const stage = career.slice(career.indexOf('<div class="cmap-stage">'));
    const shellEnd = stage.indexOf('</div>', stage.indexOf('id="cmapLoading"'));
    const detailStart = stage.indexOf('<aside class="cmap-detail"');
    expect(detailStart).toBeGreaterThan(shellEnd);
  });

  it('on mobile the card is in-flow (static) and takes no space when closed', () => {
    expect(mobileBlock).toBeTruthy();
    expect(mobileBlock).toMatch(/\.cmap-detail\{position:static;display:none/);
    expect(mobileBlock).toMatch(/\.cmap-detail\.open\{display:block/);
    // The old escape-downward positioning must not come back.
    expect(mobileBlock).not.toMatch(/top:100%/);
  });

  it('.cmap-stage is the positioning context for the desktop card', () => {
    expect(career).toMatch(/\.cmap-stage\{position:relative;\}/);
  });
});

// The public /jobs map was built from the same pattern and carried the same
// latent defect: .jobs-finder-band had the clip/visible pair and .pmap-detail
// parked at translateX(103%), so on iOS the pin tap opened a card nobody saw.
describe('public /jobs map: the same clipping trap must not come back', () => {
  const bandRule = (siteJobs.match(/\.jobs-finder-band\{[^}]*\}/) || [''])[0];
  const detailRule = (siteJobs.match(/\.pmap-detail\{[^}]*\}/) || [''])[0];

  it('.jobs-finder-band does not mix overflow-x:clip with overflow-y:visible', () => {
    expect(bandRule).toBeTruthy();
    expect(bandRule).not.toMatch(/overflow-x:\s*clip/);
    expect(bandRule).toMatch(/overflow:\s*visible/);
  });

  it('the closed card does not park off to the right', () => {
    expect(detailRule).toBeTruthy();
    expect(detailRule).not.toMatch(/translateX\(10\d%\)/);
    expect(detailRule).toMatch(/visibility:\s*hidden/);
  });
});

describe('career map: your matches & applications under the map', () => {
  it('renders a strip outside .cmap-wrap so a failed map never hides it', () => {
    const wrapEnd = career.indexOf('</section>', career.indexOf('id="careerMapWrap"'));
    const strip = career.indexOf('id="cmapMine"');
    expect(strip).toBeGreaterThan(wrapEnd);
    expect(career).toMatch(/<section class="cmap-mine" id="cmapMine"[^>]*hidden>/);
    expect(career).toMatch(/id="cmapMineList"/);
  });

  it('each card carries the ids the existing application handler routes on', () => {
    expect(career).toMatch(/data-open-application="'\+esc\(m\.appId\)\+'"/);
    expect(career).toMatch(/data-open-application-role="'\+esc\(m\.roleId\)\+'"/);
    // The handler that turns those ids into the timeline still exists.
    expect(career).toMatch(/event\.target\.closest\("\[data-open-application\]"\)/);
    expect(career).toMatch(/\/pages\/application-detail\?id=/);
  });

  it('publishes the doctor\'s applications to the map script', () => {
    expect(career).toMatch(/function syncCareerMapMine\(applications\)/);
    expect(career).toMatch(/window\.__careerMineApplications = list/);
    expect(career).toMatch(/window\.__careerMapMine = function\(list\)|window\.__careerMapMine=function\(list\)/);
    // Published before renderApplications' empty-list early return, so the strip
    // clears itself when the last application goes away.
    const fn = (career.match(/function renderApplications\(\)\s*\{[\s\S]*?\n    \}/) || [''])[0];
    expect(fn.indexOf('syncCareerMapMine(applications)')).toBeGreaterThan(-1);
    expect(fn.indexOf('syncCareerMapMine(applications)')).toBeLessThan(fn.indexOf('if (!applications.length) return;'));
  });

  it('marks the doctor\'s own practices on the map with a distinct pin', () => {
    expect(career).toMatch(/MINE_BY_ROLE\[String\(p\.id\)\]\?' mine':''/);
    expect(career).toMatch(/\.cmap-pin\.mine \.pd svg path\{fill:#16a34a;\}/);
  });

  it('status wording matches the Offers list ribbons', () => {
    const fn = (career.match(/function careerMineStatusLabel\(application\)[\s\S]*?\n    \}/) || [''])[0];
    expect(fn).toMatch(/"Matched"/);
    expect(fn).toMatch(/"Secured"/);
    expect(fn).toMatch(/"Interview"/);
    expect(fn).toMatch(/"Submitted"/);
    expect(fn).toMatch(/"With practice"/);
    expect(fn).toMatch(/"Under review"/);
  });
});

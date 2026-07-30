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

  // The strip and the Offers list used to carry two hand-synced copies of the
  // same status chain. They now read ONE state map, so the wording cannot drift
  // between them by construction — that is what these assertions protect.
  it('status wording lives in one shared state map', () => {
    const fn = (career.match(/function careerApplicationState\(application\)[\s\S]*?\n    \}\n\n/) || [''])[0];
    expect(fn).toMatch(/label: "Matched"/);
    expect(fn).toMatch(/label: "Secured"/);
    expect(fn).toMatch(/label: "Interview"/);
    expect(fn).toMatch(/label: "Submitted"/);
    expect(fn).toMatch(/label: "With practice"/);
    expect(fn).toMatch(/label: "Under review"/);
  });

  it('both the strip and the list read that map rather than re-deriving it', () => {
    expect(career).toMatch(/function careerMineStatusLabel\(application\) \{ return careerApplicationState\(application\)\.label; \}/);
    expect(career).toMatch(/function careerMineTone\(application\) \{\s*const tone = careerApplicationState\(application\)\.tone;/);
    // One card builder, used by the Offers list AND the under-map strip.
    expect(career).toMatch(/function buildCareerApplicationCardHtml\(application, options\)/);
    expect(career).toMatch(/function buildApplicationRowHtml\(application\) \{\s*return buildCareerApplicationCardHtml\(application, \{\}\);/);
    expect(career).toMatch(/window\.__careerBuildMineCard = function \(entry, practice\)/);
    expect(career).toMatch(/window\.__careerBuildMineCard==='function'/);
  });

  // Owner rule 2026-07-31: an application card must be the SAME card the doctor
  // is shown when asked to accept a match.
  it('the application card is the accept-the-match card shell', () => {
    const builder = (career.match(/function buildCareerApplicationCardHtml[\s\S]*?\n    \}\n/) || [''])[0];
    expect(builder).toMatch(/class="at-match-pin at-match-pin--app at-match-pin--\$\{escapeHtml\(st\.tone\)\}"/);
    expect(builder).toMatch(/class="at-match-ribbon at-match-ribbon--/);
    expect(builder).toMatch(/class="at-match-photo"/);
    expect(builder).toMatch(/class="at-match-pn"/);
    expect(builder).toMatch(/class="at-match-inner"/);
    // The accept-the-match card it must match still uses the same shell.
    expect(career).toMatch(/<article class="at-match-pin\$\{countdown\.amber/);
  });
});

// Owner ask 2026-07-31: "allow the user to select an interview time from the card".
describe('career cards: pick an interview time in place', () => {
  it('an interview card that is not booked yet renders the picker', () => {
    expect(career).toMatch(/function buildInterviewPickerHtml\(appId\)/);
    expect(career).toMatch(/bookable: !when/);
    expect(career).toMatch(/booked: !!when/);
    // interview_completed is behind the doctor — it must never offer a picker.
    const done = (career.match(/if \(key === "interview_completed"\)[\s\S]*?\}\n/) || [''])[0];
    expect(done).not.toMatch(/bookable: true/);
  });

  it('uses the same two endpoints as the application-detail picker', () => {
    expect(career).toMatch(/"\/api\/career\/interview\/slots\?applicationId=" \+ encodeURIComponent\(appId\)/);
    expect(career).toMatch(/fetch\("\/api\/career\/interview\/book"/);
  });

  // Regression guard for the bug fixed on main in 1960ca0: without viewer_tz the
  // server guesses the doctor's zone from an empty registration_country, falls
  // back to Europe/London, and silently drops whole days from the list. Listing
  // and booking must also agree, or a valid pick returns "slot_taken".
  it('sends the doctor\'s real timezone on BOTH the slots and book calls', () => {
    expect(career).toMatch(/const careerDeviceTz = \(function \(\) \{/);
    expect(career).toMatch(/Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
    const load = (career.match(/function careerIvLoad\(appId\)[\s\S]*?\n    \}\n/) || [''])[0];
    expect(load).toMatch(/viewer_tz=" \+ encodeURIComponent\(careerDeviceTz\)/);
    const book = (career.match(/function careerIvBook\(appId\)[\s\S]*?\n    \}\n/) || [''])[0];
    expect(book).toMatch(/viewer_tz: careerDeviceTz \|\| undefined/);
  });

  it('choosing a time does not navigate away from the card', () => {
    // The picker sits inside a clickable card, so its controls must be handled
    // before the [data-open-application] branch and must return.
    const slotIdx = career.indexOf('const ivSlotBtn = event.target.closest("[data-iv-slot]")');
    const openIdx = career.indexOf('const openAppBtn = event.target.closest("[data-open-application]")');
    expect(slotIdx).toBeGreaterThan(-1);
    expect(openIdx).toBeGreaterThan(slotIdx);
    expect(career).toMatch(/if \(event\.target\.closest\("\.ivc"\)\) \{ event\.stopPropagation\(\); return; \}/);
  });

  it('a confirmed booking updates the card everywhere and drops the cached list', () => {
    const apply = (career.match(/function careerIvApplyBooking[\s\S]*?\n    \}\n/) || [''])[0];
    expect(apply).toMatch(/window\.gpCache\.invalidate\("\/api\/career\/applications"\)/);
    expect(apply).toMatch(/renderApplications\(\)/);
  });
});

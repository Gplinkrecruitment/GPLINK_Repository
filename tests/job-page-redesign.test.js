// Job page redesign (2026-07): restructures the NON-offer body of
// pages/job.html to match the owner-approved mockup — a name-on-acceptance
// dropdown directly under the hero, "The package" headline figures + blue-
// icon rows, About moved above a new "The practice" facts panel, and blue
// line-SVG icons everywhere (no emojis). Offer mode, apply, and the reveal
// gate are untouched.
//
// job.html is a static file served verbatim (no server-side templating), so
// reading it straight from disk is an honest check of exactly what the
// browser receives — same source-level pattern as
// tests/practice-status-page.test.js / tests/job-writeup-render.test.js's
// "source —" describe block.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOB_PAGE_PATH = path.join(__dirname, '..', 'pages', 'job.html');

let html;

beforeAll(() => {
  html = fs.readFileSync(JOB_PAGE_PATH, 'utf8');
});

describe('job.html — redesign (2026-07)', () => {
  it('references role.aiPerks for "The package" rows', () => {
    expect(html).toContain('aiPerks');
  });

  it('renders a name-on-acceptance dropdown as a real <details> disclosure', () => {
    expect(html).toContain('<details class="at-noa');
    expect(html).toContain('at-noa-mask');
    expect(html).toContain('REVEALED ON ACCEPTANCE');
  });

  it('keeps the reveal branch (role.revealed && role.realPracticeName) inside the same builder', () => {
    const fn = html.match(/function buildPracticeIdentityHtml\(role\) \{[\s\S]*?\n  \}/);
    expect(fn).toBeTruthy();
    expect(fn[0]).toMatch(/role\.revealed && role\.realPracticeName/);
    expect(fn[0]).toContain('role.realPracticeName');
    expect(fn[0]).toContain('role.practiceAddress');
  });

  it('renderBody puts the name-on-acceptance dropdown first, directly after the applied banner', () => {
    const fn = html.match(/function renderBody\(role, ctx\) \{[\s\S]*?\n  \}/);
    expect(fn).toBeTruthy();
    const body = fn[0];
    const identityIdx = body.indexOf('buildPracticeIdentityHtml(role)');
    const urgencyIdx = body.indexOf('buildUrgencyHtml(role)');
    const packageIdx = body.indexOf('buildPackageCellsHtml(role)');
    expect(identityIdx).toBeGreaterThan(-1);
    expect(identityIdx).toBeLessThan(urgencyIdx);
    expect(urgencyIdx).toBeLessThan(packageIdx);
  });

  it('renderBody renders the About block before the practice facts panel', () => {
    const fn = html.match(/function renderBody\(role, ctx\) \{[\s\S]*?\n  \}/);
    expect(fn).toBeTruthy();
    const body = fn[0];
    const aboutIdx = body.indexOf('at-sech">About the practice');
    const benefitsIdx = body.indexOf('buildBenefitsHtml(role)');
    const factsIdx = body.indexOf('buildPracticeFactsHtml(role)');
    expect(aboutIdx).toBeGreaterThan(-1);
    expect(benefitsIdx).toBeGreaterThan(-1);
    expect(factsIdx).toBeGreaterThan(-1);
    expect(aboutIdx).toBeLessThan(benefitsIdx);
    expect(benefitsIdx).toBeLessThan(factsIdx);
  });

  it('"The practice" facts panel only renders rows whose data exists (DPA/supervision/visa/team)', () => {
    const fn = html.match(/function buildPracticeFactsHtml\(role\) \{[\s\S]*?\n  \}/);
    expect(fn).toBeTruthy();
    expect(fn[0]).toContain('role.dpa');
    expect(fn[0]).toContain('pt.supervision');
    expect(fn[0]).toMatch(/role\.visa.*pt\.visaSponsorship|pt\.visaSponsorship.*role\.visa/s);
    expect(fn[0]).toContain('buildRoleTeamLine');
    // Empty-panel guard — never an empty shell.
    expect(fn[0]).toMatch(/if \(!rows\.length\) return ""/);
  });

  it('"The package" shows a two-figure headline (Earnings + Billing split) and a Billing row', () => {
    const fn = html.match(/function buildPackageCellsHtml\(role\) \{[\s\S]*?\n  \}/);
    expect(fn).toBeTruthy();
    expect(fn[0]).toContain('role.earnings');
    expect(fn[0]).toContain('shortBillingSplitPct');
    expect(fn[0]).toContain('role.billing');
    expect(fn[0]).toContain('at-headline');
  });

  it('map is interactive (pan/zoom) with the branded pin locked to the suburb, keeping the suburb pin label (never the exact address pre-reveal)', () => {
    const fn = html.match(/function buildMapHtml\(role\) \{[\s\S]*?\n  \}/);
    expect(fn).toBeTruthy();
    // Pin label preserved (never the exact address pre-reveal) — now carried on
    // the map figure as data-map-pinlabel for the Leaflet pin to render.
    expect(fn[0]).toContain('getRoleMapPinLabel');
    expect(fn[0]).toContain('data-map-pinlabel');
    // buildMapHtml emits a real interactive map canvas wired up after render.
    expect(fn[0]).toContain('data-at-map');
    expect(html).toContain('function initAtMaps(');
    // The branded pin is a keyless Leaflet divIcon anchored to the suburb's
    // lat/lng, so it stays on the suburb as the map moves. Not Google Maps.
    const pinFn = html.match(/function atMakePinIcon\([\s\S]*?\n  \}/);
    expect(pinFn).toBeTruthy();
    expect(pinFn[0]).toContain('at-pin');
    expect(pinFn[0]).toContain('at-map-pinlabel');
    expect(pinFn[0]).toContain('L.divIcon');
    expect(html).toContain('L.map(');
    expect(html).not.toContain('maps.googleapis.com/maps/api/js');
  });

  it('no raw emoji in the new perk/practice-facts/name-on-acceptance icon markup — svg only', () => {
    const packageFn = html.match(/function buildPackageCellsHtml\(role\) \{[\s\S]*?\n  \}/)[0];
    const factsFn = html.match(/function buildPracticeFactsHtml\(role\) \{[\s\S]*?\n  \}/)[0];
    const identityFn = html.match(/function buildPracticeIdentityHtml\(role\) \{[\s\S]*?\n  \}/)[0];
    // Icon rows are built from named AT_ICON_*_SVG / AT_NOA_*_SVG constants,
    // not inline emoji glyphs — check the reference AND that each referenced
    // constant is itself an actual <svg>.
    expect(packageFn).toMatch(/AT_ICON_\w+_SVG/);
    expect(factsFn).toMatch(/AT_ICON_\w+_SVG/);
    expect(identityFn).toMatch(/AT_NOA_LOCK_SVG|AT_CHECK_SVG/);
    const iconConstants = html.match(/const AT_(?:ICON|NOA)_\w+_SVG = '<svg[^']*'/g) || [];
    expect(iconConstants.length).toBeGreaterThanOrEqual(8);
    const combined = packageFn + factsFn + identityFn;
    // A conservative emoji-range sweep across the astral + BMP pictograph
    // blocks actually used elsewhere on this page (avoids flagging normal
    // punctuation like the middle dot / smart quotes used in copy).
    const emojiRange = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    expect(emojiRange.test(combined)).toBe(false);
  });

  it('package/practice-facts icons use blue tokens (var(--gp-blue...)) not hardcoded colors', () => {
    expect(html).toContain('.at-prow-ic { width: 30px; height: 30px; border-radius: 8px; background: var(--gp-blue-soft');
  });
});

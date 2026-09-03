import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const I = require(path.join(__dirname, '..', 'js', 'gp-intro-slides.js'));
const J = (() => {
  // journey-stages is a browser IIFE; lift its visible STAGES the same way pages do.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'journey-stages.js'), 'utf8');
  const sandbox = { window: {} };
  new Function('window', src)(sandbox.window);
  return sandbox.window.GPJourneyStages;
})();

describe('gp-intro-slides — welcome deck (after onboarding)', () => {
  const slides = I.buildWelcomeSlides({ lastName: 'Okafor', stages: J.STAGES });
  it('is six slides: welcome, the four steps, and a one-thing-at-a-time close', () => {
    expect(slides).toHaveLength(6);
    expect(slides[0].title).toBe('Welcome, Dr Okafor');
    expect(slides.slice(1, 5).map((s) => s.kicker)).toEqual(['Step 1 of 4', 'Step 2 of 4', 'Step 3 of 4', 'Step 4 of 4']);
  });
  it('covers the owner brief: apply or enquire, interview times to suit, offer→registration unlock', () => {
    const text = slides.map((s) => [s.title, s.body, s.note].join(' ')).join('\n');
    expect(text).toMatch(/Apply directly/);
    expect(text).toMatch(/enquiry/i);
    expect(text).toMatch(/interview time that suits you/);
    expect(text).toMatch(/sign the contract in the app/);
    expect(text).toMatch(/registration pathway appears/);
  });
  it('carries the application rules so the careers explainer need not stack on top', () => {
    expect(slides[1].note).toMatch(/two applications/i);
    expect(slides[1].note).toMatch(/three in a calendar month/i);
    expect(slides[1].note).toMatch(/Withdrawing .* is final/i);
  });
  it('names the live registration stages (never the vaulted Commencement, never Secure Placement)', () => {
    expect(slides[4].body).toContain('MyIntealth Account, AMC Portfolio, AHPRA Registration, Visa Application and PBS & Medicare');
    expect(slides[4].body).not.toMatch(/Commencement|Secure Placement/);
  });
  it('ends on the careers CTA', () => {
    expect(slides[5].cta).toBe('Find my practice');
    expect(slides.slice(0, 5).every((s) => !s.cta)).toBe(true);
  });
  it('greets safely without a name and falls back to first name', () => {
    expect(I.buildWelcomeSlides({})[0].title).toBe('Welcome, Doctor');
    expect(I.buildWelcomeSlides({ firstName: 'Amara' })[0].title).toBe('Welcome, Dr Amara');
    expect(I.cleanName({ lastName: '  Lee ' })).toBe('Dr Lee');
  });
});

describe('gp-intro-slides — registration deck (position secured)', () => {
  const slides = I.buildRegistrationSlides({ lastName: 'Okafor', practiceName: 'Bayside Family Practice', stages: J.STAGES });
  it('congratulates with the practice name and lists the five steps in order', () => {
    expect(slides[0].body).toContain('Your position at Bayside Family Practice is secured.');
    expect(slides[1].title).toBe('5 steps, in order');
    expect(slides[1].bullets.map((b) => b.title)).toEqual(['MyIntealth Account', 'AMC Portfolio', 'AHPRA Registration', 'Visa Application', 'PBS & Medicare']);
  });
  it('explains the tabs that just appeared and ends on the registration CTA', () => {
    expect(slides[2].body).toMatch(/Home .* Scan .* Support/);
    expect(slides[3].title).toBe('Start with MyIntealth');
    expect(slides[3].cta).toBe('Start my registration');
  });
  it('copes without a practice name', () => {
    expect(I.buildRegistrationSlides({ stages: J.STAGES })[0].body).toContain('Your position is secured.');
  });
});

describe('gp-intro-slides — engine surface', () => {
  it('exposes run/isActive/cancel and is idle under Node', () => {
    expect(typeof I.run).toBe('function');
    expect(I.isActive()).toBe(false);
    expect(() => I.cancel()).not.toThrow();
  });
});

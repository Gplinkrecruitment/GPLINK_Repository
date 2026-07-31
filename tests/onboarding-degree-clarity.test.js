import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// A UK-trained GP whose primary medical degree is Indian uploaded her Karnataka
// Medical Council REGISTRATION certificate into the "Primary Medical Degree"
// slot three times running (2026-07-31). The certificate lists "M.B.B.S." in its
// Qualifications line, so from her side the rejection — which said only what the
// document was NOT — read as simply wrong, and she re-sent the same file.
//
// These are source assertions rather than behavioural ones: humanizeScanIssue
// lives inside the onboarding IIFE with no export, and the repo has no jsdom, so
// booting the page to call it is not available. The regex check below is the
// exception — it pulls the real literal out of the source and runs it against
// the exact model output from her file.

const ROOT = path.resolve(__dirname, '..');
const onboardingJs = fs.readFileSync(path.join(ROOT, 'js/onboarding.js'), 'utf8');
const onboardingHtml = fs.readFileSync(path.join(ROOT, 'pages/onboarding.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// Verbatim from her stored scan result (user_documents / gp_onboarding state).
const REAL_SCAN_ISSUE =
  'This looks like a Certificate of Registration from the Karnataka Medical Council, ' +
  'not Primary Medical Degree. Please upload the correct document for this step.';

describe('primary medical degree slot is unambiguous', () => {
  it('names the degrees it accepts and rules out the council registration', () => {
    expect(onboardingJs).toContain('Primary Medical Degree (MBBS, MBChB, MD)');
    expect(onboardingJs).toMatch(
      /degree certificate issued by your university .* not your medical council registration/
    );
  });

  it('renders the hint and prefers displayLabel over the short label', () => {
    expect(onboardingJs).toContain('(doc.displayLabel || doc.label)');
    expect(onboardingJs).toContain('qual-doc-slot-hint');
    expect(onboardingHtml).toContain('.qual-doc-slot-hint');
  });

  it('shares one degree entry across GB/IE/NZ so the lists cannot drift', () => {
    const spreads = onboardingJs.match(/\{ \.\.\.PRIMARY_MED_DEGREE_DOC \}/g) || [];
    expect(spreads).toHaveLength(3);
    // The short label is what the camera title, uploaded filename and review row
    // reuse — keeping it short is deliberate, so guard it against being replaced
    // by the long display string.
    expect(onboardingJs).toContain('label: "Primary Medical Degree"');
  });
});

describe('rejection messages say what to send instead', () => {
  it('matches the "looks like X, not Y" phrasing the model actually produces', () => {
    const literal = onboardingJs.match(/var wrongDocMatch = clean\.match\((\/.*?\/i)\);/);
    expect(literal, 'wrongDocMatch regex not found').toBeTruthy();

    const src = literal[1].replace(/^\//, '').replace(/\/i$/, '');
    const re = new RegExp(src, 'i');
    expect(REAL_SCAN_ISSUE).toMatch(re);

    // The pre-existing "appears to be" wording must keep working.
    expect('This appears to be a driver\'s licence, not an MRCGP certificate.').toMatch(re);
  });

  it('has a dedicated branch for a medical council registration certificate', () => {
    expect(onboardingJs).toContain('isPrimaryMedDegreeTarget');
    expect(onboardingJs).toMatch(/registration certificate\|certificate of registration\|medical council/);
    expect(onboardingJs).toMatch(/we need the degree certificate itself/);
  });

  it('recognises the account-name wording the model actually uses', () => {
    // Her second issue read "...is different from your account name..."; the old
    // pattern only knew "does not match your account", so the raw model text was
    // shown instead of the reassuring name-change copy.
    const nameBranch = onboardingJs.match(/does not match your account\|[^\n]*/);
    expect(nameBranch, 'name-mismatch branch not found').toBeTruthy();
    expect(nameBranch[0]).toContain('different from your account');
  });

  it('phrases the target as "your <document>", not a bare form label', () => {
    expect(onboardingJs).toContain('function friendlyTargetPhrase');
    expect(onboardingJs).toContain('friendlyTargetPhrase(options) + " instead."');
  });
});

describe('the scan prompt rules out registration certificates', () => {
  it('tells the model a council registration certificate is not the degree', () => {
    const rule = serverJs
      .split('\n')
      .find((l) => l.includes('- Primary Medical Degree: The degree certificate itself'));
    expect(rule, 'primary medical degree prompt rule not found').toBeTruthy();
    expect(rule).toContain('REGISTRATION certificate is NOT the primary medical degree');
    expect(rule).toContain('Qualifications');
  });
});

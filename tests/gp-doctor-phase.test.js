import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const P = require(path.join(__dirname, '..', 'js', 'gp-doctor-phase.js'));

describe('gp-doctor-phase — derivePhase', () => {
  it('no onboarding flag → onboarding (the wizard owns the screen)', () => {
    expect(P.derivePhase({})).toBe('onboarding');
    expect(P.derivePhase({ onboardingComplete: false })).toBe('onboarding');
    expect(P.derivePhase(null)).toBe('onboarding');
  });
  it('onboarded but no secured placement → position (My Practice + Account only)', () => {
    expect(P.derivePhase({ onboardingComplete: true })).toBe('position');
    expect(P.derivePhase({ onboardingComplete: true, careerSecured: false })).toBe('position');
  });
  it('secured placement → registration (full app)', () => {
    expect(P.derivePhase({ onboardingComplete: true, careerSecured: true })).toBe('registration');
  });
  it('under review / waitlist outrank everything (auth-guard owns those screens)', () => {
    expect(P.derivePhase({ onboardingComplete: true, careerSecured: true, underReview: true })).toBe('restricted');
    expect(P.derivePhase({ onboardingComplete: false, pepWaitlist: true })).toBe('restricted');
  });
});

describe('gp-doctor-phase — nav visibility', () => {
  it('position phase shows exactly My Practice and Account', () => {
    const v = P.navVisibility('position');
    expect(v).toEqual({ home: false, documents: false, support: false, career: true, account: true, scan: false });
  });
  it('registration phase shows the full nav; unknown phases fail open to the full nav', () => {
    const all = { home: true, documents: true, support: true, career: true, account: true, scan: true };
    expect(P.navVisibility('registration')).toEqual(all);
    expect(P.navVisibility('onboarding')).toEqual(all);
    expect(P.navVisibility('restricted')).toEqual(all);
    expect(P.navVisibility('bogus')).toEqual(all);
  });
});

describe('gp-doctor-phase — routing', () => {
  it('landing route is the careers page until a position is secured, Home after', () => {
    expect(P.landingRoute('position')).toBe('/pages/career');
    expect(P.landingRoute('registration')).toBe('/pages/index');
    expect(P.landingRoute('onboarding')).toBe('/pages/index');
  });
  it('position phase rewrites Home and every registration route to the careers page', () => {
    for (const r of ['/pages/index', '/pages/index.html', '/pages/index?x=1', '/pages/myinthealth', '/pages/amc', '/pages/ahpra', '/pages/visa', '/pages/pbs', '/pages/commencement', '/pages/registration-intro']) {
      expect(P.resolveRouteForPhase('position', r), r).toBe('/pages/career');
      expect(P.isRouteHiddenInPhase('position', r), r).toBe(true);
    }
  });
  it('position phase leaves careers sub-pages, account, and deep-linked pages untouched', () => {
    for (const r of ['/pages/career', '/pages/career#secured', '/pages/job?id=4', '/pages/application-detail?id=1', '/pages/offer-review?applicationId=2', '/pages/secure-interview', '/pages/account', '/pages/messages', '/pages/my-documents?reupload=cv', '/pages/onboarding']) {
      expect(P.resolveRouteForPhase('position', r), r).toBe(r);
      expect(P.isRouteHiddenInPhase('position', r), r).toBe(false);
    }
  });
  it('registration phase never rewrites', () => {
    expect(P.resolveRouteForPhase('registration', '/pages/index')).toBe('/pages/index');
    expect(P.resolveRouteForPhase('registration', '/pages/myinthealth')).toBe('/pages/myinthealth');
    expect(P.isRouteHiddenInPhase('registration', '/pages/index')).toBe(false);
  });
});

describe('gp-doctor-phase — derivePhaseFromStorage (what the shell and pages actually call)', () => {
  const mem = (obj) => ({ getItem: (k) => (Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : null) });
  const secured = (st) => !!(st && st.career_secured === true);
  it('empty storage → onboarding', () => {
    expect(P.derivePhaseFromStorage(mem({}), secured)).toBe('onboarding');
  });
  it('onboarded, no career state → position', () => {
    expect(P.derivePhaseFromStorage(mem({ gp_onboarding_complete: 'true' }), secured)).toBe('position');
  });
  it('onboarded + secured career state → registration', () => {
    expect(P.derivePhaseFromStorage(mem({ gp_onboarding_complete: 'true', gp_career_state: '{"career_secured":true}' }), secured)).toBe('registration');
  });
  it('malformed career state reads as not secured; under review wins', () => {
    expect(P.derivePhaseFromStorage(mem({ gp_onboarding_complete: 'true', gp_career_state: '{oops' }), secured)).toBe('position');
    expect(P.derivePhaseFromStorage(mem({ gp_onboarding_complete: 'true', gp_account_under_review: 'true' }), secured)).toBe('restricted');
  });
  it('a throwing store is treated as a fresh device', () => {
    expect(P.derivePhaseFromStorage({ getItem: () => { throw new Error('x'); } }, secured)).toBe('onboarding');
  });
});

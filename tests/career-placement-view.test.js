// A GP must only ever see the page matching where they are in the process,
// never a "Placement Secured" page they haven't reached. Smith Miller was stuck
// on the placement page (finalising note + upcoming-interview card) while the
// server said his application was only status "review" (submitted / under
// review). Cause: the browser's careerState.activeView was a stale "secured"
// that nothing downgraded, and the anti-flash head script painted the secured
// view on cold load from loose heuristics. Both must key off the authoritative
// server flag isPlacementSecured. These pages are static files served verbatim.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAREER_PATH = path.join(__dirname, '..', 'pages', 'career.html');
const SERVER_PATH = path.join(__dirname, '..', 'server.js');

let careerHtml;
let serverJs;
beforeAll(() => {
  careerHtml = fs.readFileSync(CAREER_PATH, 'utf8');
  serverJs = fs.readFileSync(SERVER_PATH, 'utf8');
});

describe('career placement view, only shown to an actually-placed GP', () => {
  it('the anti-flash head script keys off isPlacementSecured only', () => {
    // The pre-lock decision must use the same authoritative flag the JS lock
    // uses, not a placement object or a non-"confidential" practice name,
    // which false-positived a review/interview-stage GP onto the secured page.
    const head = careerHtml.slice(0, careerHtml.indexOf('native-bridge.js'));
    expect(head).toContain('application.isPlacementSecured === true');
    // The loose heuristics that caused the false positive are gone.
    expect(head).not.toMatch(/hasConcretePlacement = true;\s*\n\s*return;/);
    expect(head).not.toContain('!/confidential/i.test(practiceName)');
  });

  it('mergeRemoteApplications downgrades a stale "secured" view when the server has no placement', () => {
    const merge = careerHtml.slice(
      careerHtml.indexOf('function mergeRemoteApplications'),
      careerHtml.indexOf('async function loadRemoteApplications')
    );
    // Upgrades to secured when the server reports a secured app…
    expect(merge).toContain('careerState.activeView = "secured";');
    // …and DOWNGRADES off a stale secured view when it does not.
    expect(merge).toMatch(/else if \(careerState\.activeView === "secured" && !shouldLockCareerToSecuredView\(\)\)/);
    expect(merge).toContain('careerState.activeView = careerState.applications.length ? "applications" : "browse";');
    // The correction is persisted, so the cached view is right next load too.
    expect(merge).toContain('persistCareerState();');
  });

  it('the lock/secured detection is driven solely by isPlacementSecured', () => {
    // shouldLockCareerToSecuredView + hasSecuredPlacement both derive from the
    // server-decided flag, so reconciling applications reconciles the view.
    const lock = careerHtml.slice(
      careerHtml.indexOf('function hasSecuredPlacement'),
      careerHtml.indexOf('function enforceLockedCareerView')
    );
    expect(lock).toContain('application.isPlacementSecured');
    expect(lock).not.toContain('application.placement');
  });

  it('renderPage still self-corrects a stale secured view defensively', () => {
    // Belt-and-suspenders: even outside the merge, rendering a secured view
    // with no real placement (and not locked) drops to the real stage view.
    expect(careerHtml).toMatch(
      /careerState\.activeView === "secured" && !hasSecuredPlacement\(\) && !isLockedToSecured/
    );
  });
});

describe('career application card, submitted-to-practice stage reads correctly', () => {
  it('an in-app-originated application presents from its stage, not as Zoho', () => {
    // Zoho is decommissioned: a legacy zoho_application_id must not force the
    // generic status when the GP applied in-app (origin gp_applied/admin_applied)
    //, that app is managed by the in-app ATS pipeline. A pure Zoho-synced app
    // with no in-app origin still stays raw.
    const fn = serverJs.slice(
      serverJs.indexOf('function isInternalCareerApplication'),
      serverJs.indexOf('function buildInternalCareerStatusPresentation')
    );
    expect(fn).toContain("origin === 'gp_applied' || origin === 'admin_applied'");
    // The origin check comes BEFORE the zoho_application_id disqualifier.
    expect(fn.indexOf('appRow.origin')).toBeLessThan(fn.indexOf('appRow.zoho_application_id'));
  });

  it('server maps the submitted stage to "Sent to the practice"', () => {
    expect(serverJs).toMatch(/stage === 'submitted'[\s\S]*?statusLabel: 'Sent to the practice'/);
  });

  it('the GP card copy reflects "submitted to practice", not "before it reaches"', () => {
    // The bug: a profile already sent to the practice still read "reviewing
    // your application before it reaches the practice". Submitted + reviewing
    // stages now get honest copy.
    expect(careerHtml).toContain('actionStatusKey === "submitted"');
    expect(careerHtml).toContain('actionStatusKey === "reviewing"');
    expect(careerHtml).toContain("Your profile has been submitted to the practice");
    expect(careerHtml).toContain("The practice is reviewing your profile now");
    // The pre-submission fallback copy is preserved for the truly-applied stage.
    expect(careerHtml).toContain("reviewing your application before it reaches the practice");
  });
});

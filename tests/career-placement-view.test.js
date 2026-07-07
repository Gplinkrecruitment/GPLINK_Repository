// A GP must only ever see the page matching where they are in the process —
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

let careerHtml;
beforeAll(() => { careerHtml = fs.readFileSync(CAREER_PATH, 'utf8'); });

describe('career placement view — only shown to an actually-placed GP', () => {
  it('the anti-flash head script keys off isPlacementSecured only', () => {
    // The pre-lock decision must use the same authoritative flag the JS lock
    // uses — not a placement object or a non-"confidential" practice name,
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

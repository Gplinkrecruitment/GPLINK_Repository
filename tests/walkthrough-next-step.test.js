// Post-tour "start here" pointer + walkthrough sequencing (2026-07-22).
// Pins the source-level wiring of three behaviors:
//   1. Career CV gate: career.html announces `gp-career-gate-closed` on every
//      close path, and the page walkthrough DEFERS (no markSeen, no run) while
//      the gate owns the screen — the "Roles matched to you" tip must never
//      fire over the "Upload your CV to continue" modal.
//   2. Shell ↔ page sequencing: the shell broadcasts `gp-shell-coach-active`
//      around every shell coach run so page tips never stack under/over the
//      shell tour or pointer (separate documents, separate gpCoach instances).
//   3. The one-off pointer itself: pointer mode is click-through (overlay lets
//      the click hit the real target, no preventDefault) and nextStepDone is
//      marked ONLY via onTargetClick — Done/Skip/Escape leave it pending.
// Extended 2026-07-22 after a real-browser verification pass:
//   4. Priority rule — the pending pointer ALWAYS outranks the generic home tip
//      (deterministic on the page side; shell boot path broadcasts as backup).
//   5. Warm-frame guard — tips defer unmarked inside the shell's hidden
//      preloaded iframe instead of burning invisibly.
//   6. Coach hardening — document-level pointer click listener, detached-node
//      re-resolve, pointer-mode Escape focus, sliver-rect clamp, 8s pointer wait.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('career gate announces its close (Task 1)', () => {
  const html = read('pages/career.html');
  it('defines announceCareerGateClosed dispatching gp-career-gate-closed on window', () => {
    expect(html).toMatch(/function announceCareerGateClosed\(\)[^\n]*window\.dispatchEvent\(new CustomEvent\('gp-career-gate-closed'\)\)/);
  });
  it('closeCareerGateModal announces the close', () => {
    const fn = html.slice(html.indexOf('function closeCareerGateModal'), html.indexOf('function careerGateSetScanState'));
    expect(fn).toContain('announceCareerGateClosed()');
  });
  it('the leaked-lock defence (ensureSecuredScrollable) announces only when a lock was cleared', () => {
    const fn = html.slice(html.indexOf('function ensureSecuredScrollable'), html.indexOf('function renderSecuredPlacement'));
    expect(fn).toContain('hadGateLock');
    expect(fn).toMatch(/if \(hadGateLock[^\n]*announceCareerGateClosed/);
  });
});

describe('page walkthrough defers instead of firing over a gate (Tasks 1+3)', () => {
  const js = read('js/gp-walkthrough.js');
  it('pageBlocked() covers the career gate class and open modal, plus the shell coach flag', () => {
    const fn = js.slice(js.indexOf('function pageBlocked'), js.indexOf('var deferRetry'));
    expect(fn).toContain("classList.contains('career-gate-open')");
    expect(fn).toContain('.career-gate-modal.is-open');
    expect(fn).toContain('shellCoachActive');
  });
  it('maybeRun defers BEFORE markSeen (deferred tip is never lost)', () => {
    const fn = js.slice(js.indexOf('function maybeRun'), js.indexOf('function runNextStepPointer'));
    const iDefer = fn.indexOf('pageBlocked()');
    const iMark = fn.indexOf('markSeen(area)');
    expect(iDefer).toBeGreaterThan(-1);
    expect(iMark).toBeGreaterThan(-1);
    expect(iDefer).toBeLessThan(iMark);
    expect(fn).toContain('armRetry()');
  });
  it('retry re-arms on gp-career-gate-closed with a bounded fallback poll', () => {
    const fn = js.slice(js.indexOf('function armRetry'), js.indexOf('function maybeRun'));
    expect(fn).toContain("addEventListener('gp-career-gate-closed'");
    expect(fn).toContain('60000');
  });
  it('tracks gp-shell-coach-active and re-tries when the shell overlay clears', () => {
    expect(js).toContain("'gp-shell-coach-active'");
    expect(js).toMatch(/shellCoachActive = d\.active === true;\s*\n\s*if \(!shellCoachActive\) scheduleRetry\(\)/);
  });
  it('handles gp-shell-run-next-step and retries deferred tips after the in-page pointer', () => {
    expect(js).toContain("'gp-shell-run-next-step'");
    const fn = js.slice(js.indexOf('function runNextStepPointer'), js.indexOf("window.addEventListener('message'"));
    expect(fn).toContain('[data-journey-step="myinthealth"]');
    expect(fn).toContain('onTargetClick: markNextStepDone');
    expect(fn).toMatch(/\.then\(function \(\) \{ scheduleRetry\(\); \}\)/);
    // done/skip must NOT mark the pointer done — only the target click does
    expect(fn).not.toContain('onDone');
    expect(fn).not.toContain('onSkip');
  });
});

describe('shell broadcasts coach activity and runs the pointer (Tasks 2+3)', () => {
  const js = read('js/gp-walkthrough-shell.js');
  it('broadcasts gp-shell-coach-active to the content frames', () => {
    expect(js).toContain("type: 'gp-shell-coach-active'");
    const fn = js.slice(js.indexOf('function broadcastCoachActive'), js.indexOf('function activeFrameArea'));
    expect(fn).toContain('postMessage');
  });
  it('runTour broadcasts around the run and schedules the pointer on Done AND Skip', () => {
    const fn = js.slice(js.indexOf('function runTour'), js.indexOf('function tryAuto'));
    expect(fn).toContain('broadcastCoachActive(true)');
    expect(fn).toMatch(/onDone: after, onSkip: after/);
    expect(fn).toContain('scheduleNextStepPointer');
  });
  it('pointer branches: placed → message to the home frame; not placed → My Practice nav', () => {
    const fn = js.slice(js.indexOf('function runNextStepPointer'), js.indexOf('function scheduleNextStepPointer'));
    expect(fn).toContain('readCareerSecured()');
    expect(fn).toContain("type: 'gp-shell-run-next-step', area: 'myintealth'");
    expect(fn).toMatch(/activeFrameArea\(\) !== 'home'/); // placed branch only over the journey list
    expect(fn).toContain("navEl('practice')");
    expect(fn).toContain('pointer: true');
    expect(fn).toContain('onTargetClick: markNextStepDone');
    // Done/Skip must NOT mark the pointer done — Escape/"Got it" re-arms next boot
    expect(fn).not.toContain('onDone');
    expect(fn).not.toContain('onSkip');
  });
  it('placement signal reuses GPJourneyStages.hasCareerSecured over gp_career_state', () => {
    const fn = js.slice(js.indexOf('function readCareerSecured'), js.indexOf('function runNextStepPointer'));
    expect(fn).toContain("localStorage.getItem('gp_career_state')");
    expect(fn).toContain('hasCareerSecured');
  });
  it('later boots run the pending pointer once per boot (like ranAuto)', () => {
    const fn = js.slice(js.indexOf('function scheduleNextStepPointer'), js.indexOf('function runTour'));
    expect(fn).toContain('if (ranPointer');
    expect(fn).toContain('ranPointer = true');
    const auto = js.slice(js.indexOf('function tryAuto'), js.indexOf('window.gpWalkthroughShell'));
    expect(auto).toContain('scheduleNextStepPointer');
  });
  it('shell guard also covers the qualification-scan sheet', () => {
    const fn = js.slice(js.indexOf('function guarded'), js.indexOf('function readState'));
    expect(fn).toContain('gpScanModal');
  });
});

describe('gp-coach pointer mode (click-through spotlight)', () => {
  const js = read('js/gp-coach.js');
  it('overlay lets clicks through, tip stays interactive', () => {
    expect(js).toContain('.gp-coach-overlay.gp-coach-pointer{pointer-events:none;}');
    expect(js).toContain('.gp-coach-overlay.gp-coach-pointer .gp-coach-tip{pointer-events:auto;}');
  });
  it('target click never preventDefaults and resolves via onTargetClick', () => {
    const fn = js.slice(js.indexOf('function onTargetClick'), js.indexOf('function onKey'));
    expect(fn).not.toMatch(/\.preventDefault\(/); // the click must fully proceed
    expect(fn).toContain('opts.onTargetClick');
    expect(fn).toContain("cleanup('target')");
  });
  it('pointer mode hides Next and offers only a subtle dismiss', () => {
    const fn = js.slice(js.indexOf('function renderActions'), js.indexOf('function render()'));
    expect(fn).toMatch(/if \(pointerMode\) \{[\s\S]*?'Got it'[\s\S]*?return;/);
  });
  it('run() still refuses re-entry while active', () => {
    expect(js).toMatch(/if \(active\) return Promise\.resolve\('busy'\)/);
  });
});

describe('index.html journey rows expose stable pointer anchors', () => {
  const html = read('pages/index.html');
  it('each journey row gets data-journey-step=<stage key>', () => {
    expect(html).toContain('el.setAttribute("data-journey-step", step.key)');
  });
  it('hasCareerSecured delegates to the shared GPJourneyStages helper', () => {
    const fn = html.slice(html.indexOf('function hasCareerSecured'), html.indexOf('function getProgressSnapshot'));
    expect(fn).toContain('window.GPJourneyStages.hasCareerSecured(careerState)');
  });
});

describe('placed + MyIntealth already done → pointer retires instead of mispointing', () => {
  // An existing mid-journey GP (placed, EPIC verified, launch-backfilled blob
  // without nextStepDone) must NEVER see "Start your journey here" on a step
  // that is already Done — the pointer is marked done silently instead.
  it('shell: placed branch checks readEpicDone() and retires BEFORE posting the pointer', () => {
    const js = read('js/gp-walkthrough-shell.js');
    const fn = js.slice(js.indexOf('function runNextStepPointer'), js.indexOf('function scheduleNextStepPointer'));
    const iSecured = fn.indexOf('readCareerSecured()');
    const iRetire = fn.indexOf('if (readEpicDone()) { markNextStepDone(); return; }');
    const iPost = fn.indexOf("gp-shell-run-next-step");
    expect(iSecured).toBeGreaterThan(-1);
    expect(iRetire).toBeGreaterThan(iSecured);  // guard lives inside the placed branch…
    expect(iPost).toBeGreaterThan(iRetire);     // …and fires before the message is posted
  });
  it('shell: placed + NOT epicDone still reaches the gp-shell-run-next-step post (pointer runs)', () => {
    const js = read('js/gp-walkthrough-shell.js');
    const fn = js.slice(js.indexOf('function runNextStepPointer'), js.indexOf('function scheduleNextStepPointer'));
    // The retire path is an early return guarded ONLY on readEpicDone(); the
    // post + the not-placed C.run both remain reachable when it is false.
    expect(fn).toContain("postMessage({ type: 'gp-shell-run-next-step', area: 'myintealth' }");
    expect(fn).not.toMatch(/readEpicDone\(\)[^\n]*\n[^\n]*postMessage/); // post is not inside the retire guard
  });
  it('shell: readEpicDone reads gp_epic_progress via the shared isEpicDone helper, fail-closed', () => {
    const js = read('js/gp-walkthrough-shell.js');
    const fn = js.slice(js.indexOf('function readEpicDone'), js.indexOf('function runNextStepPointer'));
    expect(fn).toContain("localStorage.getItem('gp_epic_progress')");
    expect(fn).toContain('isEpicDone');
    expect(fn).toContain('return false;'); // any failure reads as "not done"
  });
  it('page: handler independently skips + retires when the rendered row is already done', () => {
    const js = read('js/gp-walkthrough.js');
    const fn = js.slice(js.indexOf('function runNextStepPointer'), js.indexOf("window.addEventListener('message'"));
    const iGuard = fn.indexOf("row.classList.contains('done')");
    const iRun = fn.indexOf('C.run');
    expect(iGuard).toBeGreaterThan(-1);
    expect(iGuard).toBeLessThan(iRun); // checked before any spotlight
    expect(fn).toMatch(/contains\('done'\)\) \{ markNextStepDone\(\); return; \}/);
  });
  it('index.html epicDone delegates to the shared helper', () => {
    const html = read('pages/index.html');
    expect(html).toContain('window.GPJourneyStages.isEpicDone(epic)');
  });
});

describe('GPJourneyStages.isEpicDone (behavioural, shared MyIntealth signal)', () => {
  const stagesJs = read('js/journey-stages.js');
  const sandbox = { window: {} };
  // eslint-disable-next-line no-new-func
  new Function('window', stagesJs)(sandbox.window);
  const api = sandbox.window.GPJourneyStages;
  it('true only for completed.verification_issued === true; garbage fails closed', () => {
    expect(typeof api.isEpicDone).toBe('function');
    expect(api.isEpicDone({ completed: { verification_issued: true } })).toBe(true);
    expect(api.isEpicDone({ completed: { verification_issued: false } })).toBe(false);
    expect(api.isEpicDone({ completed: { verification_issued: 'true' } })).toBe(false);
    expect(api.isEpicDone({ completed: {} })).toBe(false);
    expect(api.isEpicDone({})).toBe(false);
    expect(api.isEpicDone(null)).toBe(false);
    expect(api.isEpicDone('garbage')).toBe(false);
  });
});

describe('pointer priority: the home tip yields while the pointer is pending', () => {
  const js = read('js/gp-walkthrough.js');
  it('homeTipYields = home area AND shouldRunNextStep (re-read from state each check)', () => {
    const fn = js.slice(js.indexOf('function homeTipYields'), js.indexOf('function maybeRun'));
    expect(fn).toContain("area === 'home'");
    expect(fn).toContain('S.shouldRunNextStep(readState())');
  });
  it('maybeRun defers via homeTipYields at BOTH check points, unmarked, before markSeen', () => {
    const fn = js.slice(js.indexOf('function maybeRun'), js.indexOf('function runNextStepPointer'));
    const first = fn.indexOf('homeTipYields(area)');
    const second = fn.indexOf('homeTipYields(area)', first + 1);
    const iMark = fn.indexOf('markSeen(area)');
    expect(first).toBeGreaterThan(-1);        // outer hydration-time check…
    expect(second).toBeGreaterThan(first);    // …AND the settle-delay re-check
    expect(second).toBeLessThan(iMark);       // both strictly before the tip is marked seen
  });
  it('shell boot path broadcasts coach-active true when ARMING the pointer (not just the tour path)', () => {
    const shell = read('js/gp-walkthrough-shell.js');
    const fn = shell.slice(shell.indexOf('function scheduleNextStepPointer'), shell.indexOf('function runTour'));
    const iBroadcast = fn.indexOf('broadcastCoachActive(true)');
    const iTimer = fn.indexOf('setTimeout');
    expect(iBroadcast).toBeGreaterThan(-1);
    expect(iBroadcast).toBeLessThan(iTimer); // flag is up BEFORE the arm-delay window opens
  });
});

describe('warm-frame guard: tips defer inside a hidden preloaded frame (never burned)', () => {
  const js = read('js/gp-walkthrough.js');
  it('frameHidden treats a 0x0 viewport (display:none host) as blocked', () => {
    const fn = js.slice(js.indexOf('function frameHidden'), js.indexOf('function pageBlocked'));
    expect(fn).toContain('clientWidth === 0');
    expect(fn).toContain('clientHeight === 0');
  });
  it('frameHidden also reads the host iframe computed style — the shell warm frame is opacity:0 at FULL size', () => {
    const fn = js.slice(js.indexOf('function frameHidden'), js.indexOf('function pageBlocked'));
    expect(fn).toContain('window.frameElement');
    expect(fn).toContain("display === 'none'");
    expect(fn).toContain("visibility === 'hidden'");
    expect(fn).toContain('opacity');
  });
  it('pageBlocked includes frameHidden so the defer happens before markSeen', () => {
    const fn = js.slice(js.indexOf('function pageBlocked'), js.indexOf('var deferRetry'));
    expect(fn).toContain('frameHidden()');
  });
  it('armRetry wakes on resize (display:none host reveal) AND host class/style flips (opacity host)', () => {
    const fn = js.slice(js.indexOf('function armRetry'), js.indexOf('var HOME'));
    expect(fn).toContain("window.addEventListener('resize', fire)");
    expect(fn).toContain('MutationObserver');
    expect(fn).toContain("attributeFilter: ['class', 'style']");
    // the poll stays bounded, but the event wake-ups survive it for hidden frames
    expect(fn).toContain('frameHidden()');
  });
});

describe('gp-coach pointer hardening (click resilience, Escape focus, sliver clamp, wait)', () => {
  const js = read('js/gp-coach.js');
  it('pointer click listener lives at DOCUMENT level (capture) and matches string targets via closest()', () => {
    expect(js).toContain("d.addEventListener('click', onPointerDocClick, true)");
    const fn = js.slice(js.indexOf('function onPointerDocClick'), js.indexOf('function onKey'));
    expect(fn).toContain('closest');
    expect(fn).toContain('curTarget.contains'); // element-target fallback match
  });
  it('cleanup still removes the document-level listener', () => {
    const fn = js.slice(js.indexOf('function detachPointerClick'), js.indexOf('function cleanup'));
    expect(fn).toContain("d.removeEventListener('click', onPointerDocClick, true)");
  });
  it('reposition re-resolves a DETACHED string target and keeps tracking the replacement', () => {
    const fn = js.slice(js.indexOf('function reposition'), js.indexOf('function renderActions'));
    expect(fn).toContain('isConnected');
    expect(fn).toContain('d.querySelector(steps[idx].target)');
  });
  it('reposition clamps sliver rects to a 44px minimum BEFORE the pure computePlacement call', () => {
    const fn = js.slice(js.indexOf('function reposition'), js.indexOf('function renderActions'));
    const iClamp = fn.indexOf('MIN_EDGE = 44');
    const iPlace = fn.indexOf('var pl = computePlacement'); // the CALL, not the comment
    expect(iClamp).toBeGreaterThan(-1);
    expect(iClamp).toBeLessThan(iPlace);
  });
  it('pointer mode focuses the Got-it dismiss on render so Escape reaches the coach document', () => {
    const fn = js.slice(js.indexOf('function render()'), js.indexOf("window.addEventListener('resize'"));
    expect(fn).toMatch(/pointerMode \? '\.gp-coach-skip' : '\.gp-coach-next'/);
  });
  it('steps/opts can extend the target wait; the next-step pointer uses 8s', () => {
    expect(js).toContain('waitForElement(t, timeout || 4000)');
    expect(js).toContain('steps[idx].timeout || opts.timeout');
    const w = read('js/gp-walkthrough.js');
    const fn = w.slice(w.indexOf('function runNextStepPointer'), w.indexOf("window.addEventListener('message'"));
    expect(fn).toContain('timeout: 8000');
  });
});

describe('placed pointer copy: never claims the tap will "open" the already-expanded row', () => {
  const js = read('js/gp-walkthrough.js');
  it('keeps the title and uses the non-toggling body copy', () => {
    expect(js).toContain('Start your journey here');
    expect(js).toContain("Begin with MyIntealth — this is your first step. Tap it when you're ready.");
    expect(js).not.toContain('tap to open your first step');
  });
});

describe('GPJourneyStages.hasCareerSecured (behavioural, shared placement signal)', () => {
  const stagesJs = read('js/journey-stages.js');
  const sandbox = { window: {} };
  // eslint-disable-next-line no-new-func
  new Function('window', stagesJs)(sandbox.window);
  const api = sandbox.window.GPJourneyStages;
  it('is exported', () => {
    expect(typeof api.hasCareerSecured).toBe('function');
  });
  it('matches the index.html semantics: flags, application status variants, garbage', () => {
    expect(api.hasCareerSecured(null)).toBe(false);
    expect(api.hasCareerSecured({})).toBe(false);
    expect(api.hasCareerSecured({ career_secured: true })).toBe(true);
    expect(api.hasCareerSecured({ secured: true })).toBe(true);
    expect(api.hasCareerSecured({ applications: [{ isPlacementSecured: true }] })).toBe(true);
    expect(api.hasCareerSecured({ applications: [{ status: 'Placement Secured' }] })).toBe(true);
    expect(api.hasCareerSecured({ applications: [{ rawStatus: 'practice-secured' }] })).toBe(true);
    expect(api.hasCareerSecured({ applications: [{ status: 'applied' }] })).toBe(false);
    expect(api.hasCareerSecured({ applications: ['garbage', null] })).toBe(false);
  });
});

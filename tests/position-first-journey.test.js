import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ── Position-first registration lock + mandatory walkthrough (owner rules, 2026-09-01) ──
// 1. Until a position is secured, every registration step (MyIntealth, AMC,
//    AHPRA, Visa, PBS) is locked and its call to action routes to the careers
//    page. Completed steps stay revisitable.
// 2. The first-run walkthrough cannot be skipped, and it ends on an interactive
//    "tap My Practice" step that both completes the tour and opens the careers
//    page. Replays and staff "View as GP" stay skippable.

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function loadJourneyStages() {
  const sandbox = { window: {} };
  // eslint-disable-next-line no-new-func
  new Function('window', read('js/journey-stages.js'))(sandbox.window);
  return sandbox.window.GPJourneyStages;
}

describe('journey-stages — position-first lock state (behavioural)', () => {
  const api = loadJourneyStages();
  const UNPLACED_FRESH = { careerSecured: false, epicDone: false, amcDone: false, ahpraDone: false, visaDone: false, pbsDone: false };

  it('locks every registration step for an unplaced doctor, career stays open', () => {
    const rows = Object.fromEntries(api.getStageStates(UNPLACED_FRESH, false).map((s) => [s.key, s]));
    expect(rows.career.locked).toBe(false);
    for (const key of ['myinthealth', 'amc', 'ahpra', 'visa', 'pbs']) {
      expect(rows[key].locked, key).toBe(true);
      expect(rows[key].positionLocked, key).toBe(true);
      expect(rows[key].lockReason, key).toBe('Unlocks after you secure your position');
    }
  });

  it('an unplaced doctor mid-journey keeps completed steps revisitable (never locked)', () => {
    // Ibrahim's shape: MyIntealth complete, AMC in progress, no placement.
    const rows = Object.fromEntries(api.getStageStates({ ...UNPLACED_FRESH, epicDone: true }, false).map((s) => [s.key, s]));
    expect(rows.myinthealth.done).toBe(true);
    expect(rows.myinthealth.locked).toBe(false); // done wins — quick-view stays
    expect(rows.amc.locked).toBe(true);
    expect(rows.amc.positionLocked).toBe(true);
  });

  it('a secured position restores the old prerequisite locks exactly', () => {
    const rows = Object.fromEntries(api.getStageStates({ ...UNPLACED_FRESH, careerSecured: true }, false).map((s) => [s.key, s]));
    expect(rows.myinthealth.locked).toBe(false);
    expect(rows.ahpra.locked).toBe(false);
    expect(rows.visa.locked).toBe(false);
    expect(rows.amc.locked).toBe(true); // still needs MyIntealth
    expect(rows.amc.positionLocked).toBe(false);
    expect(rows.amc.lockReason).toBe('Unlocked after MyIntealth is complete');
    expect(rows.pbs.locked).toBe(true); // still needs AHPRA
  });

  it('bypass accounts skip the position lock', () => {
    const rows = Object.fromEntries(api.getStageStates(UNPLACED_FRESH, true).map((s) => [s.key, s]));
    for (const key of ['myinthealth', 'amc', 'ahpra', 'visa', 'pbs']) {
      expect(rows[key].locked, key).toBe(false);
    }
  });
});

describe('journey surfaces route position-locked steps to the careers page', () => {
  const indexHtml = read('pages/index.html');
  const appShellJs = read('js/app-shell.js');

  it('index journey list renders an active careers CTA on position-locked rows', () => {
    expect(indexHtml).toMatch(/step\.positionLocked[\s\S]{0,400}href="\/pages\/career" data-route="\/pages\/career">Secure your position first/);
  });
  it('index hero next-action points at securing a position while unplaced', () => {
    expect(indexHtml).toMatch(/if \(!careerSecured\) \{ currentRoute = "career"/);
  });
  it('both registration-row builders keep an active careers link when position-locked', () => {
    expect(indexHtml).toMatch(/href: positionLocked \? "career"/);
    expect(appShellJs).toMatch(/href: positionLocked \? "\/pages\/career"/);
    expect(indexHtml).toMatch(/cta: positionLocked \? "Secure position first"/);
    expect(appShellJs).toMatch(/cta: positionLocked \? "Secure position first"/);
    // The disabled-action checks must exempt positionLocked rows in all three renderers.
    expect(appShellJs).toMatch(/\(row\.locked && !row\.positionLocked\) \|\| \(row\.done && !row\.returnable\)/);
    const idxMatches = indexHtml.match(/\(row\.locked && !row\.positionLocked\) \|\| \(row\.done && !row\.returnable\)/g) || [];
    expect(idxMatches.length).toBeGreaterThanOrEqual(2); // desktop rows + mobile cards
  });
  it('both builders pass positionLocked through from the shared stage state', () => {
    expect(indexHtml).toMatch(/positionLocked: stage\.positionLocked/);
    expect(appShellJs).toMatch(/positionLocked: stage\.positionLocked/);
  });
});

describe('gp-coach — mandatory mode', () => {
  const js = read('js/gp-coach.js');

  it('skip() is inert in mandatory mode (covers Skip, Got it, Escape and Enter-in-pointer)', () => {
    const fn = js.slice(js.indexOf('function skip()'), js.indexOf('function next()'));
    expect(fn).toContain('if (mandatoryMode) return;');
  });
  it('mandatory mode renders no Skip / Got it button', () => {
    const fn = js.slice(js.indexOf('function renderActions'), js.indexOf('function render()'));
    expect(fn).toMatch(/if \(pointerMode\) \{[\s\S]*?if \(mandatoryMode\) return;/);
    expect(fn).toMatch(/if \(!mandatoryMode\) \{[\s\S]*?'Skip'/);
  });
  it('mandatory pointer mode still gives keyboard focus a home (the tip itself)', () => {
    expect(js).toContain("if (!f && mandatoryMode) { tip.setAttribute('tabindex', '-1'); f = tip; }");
  });
  it('cancel() and the lost-target teardown stay untouched as safety valves', () => {
    expect(js).toContain("cleanup('lost')");
    expect(js).toMatch(/function cancel\(\) \{ if \(activeCancel\) activeCancel\(\); \}/);
  });
  it('doneLabel lets the shell chain the finale ("Next" on the last info card)', () => {
    expect(js).toContain("opts.doneLabel || 'Done'");
  });
});

describe('walkthrough shell — mandatory first run ends on the My Practice tap', () => {
  const js = read('js/gp-walkthrough-shell.js');

  it('the info pass excludes My Practice; the finale carries it', () => {
    const tabs = js.slice(js.indexOf('var TABS'), js.indexOf('var PRACTICE_FINALE'));
    expect(tabs).not.toContain("area: 'practice'");
    expect(js).toContain('var PRACTICE_FINALE');
    expect(js).toMatch(/Tap My Practice to start looking at open GP positions/);
  });
  it('first run is mandatory; impersonated staff sessions are not', () => {
    expect(js).toMatch(/var mandatory = S\.shouldRunTour\(readState\(\)\) && !isImpersonated\(\)/);
    const imp = js.slice(js.indexOf('function isImpersonated'), js.indexOf('// ---- Cross-document coordination'));
    expect(imp).toContain('_impersonatedBy');
    expect(imp).toContain("sessionStorage.getItem('gp_session_profile_cache')");
  });
  it('the finale click marks the tour done AND retires the start-here pointer', () => {
    const fn = js.slice(js.indexOf('function runPracticeFinale'), js.indexOf('function tryAuto'));
    expect(fn).toContain('pointer: true');
    expect(fn).toContain('mandatory: mandatory');
    expect(fn).toMatch(/onTargetClick: function \(\) \{ markDone\(\); markNextStepDone\(\); \}/);
    // A vanished nav target must never trap the doctor — leave unmarked, re-arm next boot.
    expect(fn).toMatch(/if \(!el\) \{/);
  });
  it('the info pass chains into the finale only on a real Done', () => {
    const fn = js.slice(js.indexOf('function runTour'), js.indexOf('function runPracticeFinale'));
    expect(fn).toMatch(/if \(reason === 'done'\) \{ runPracticeFinale\(mandatory\); return; \}/);
    expect(fn).toContain("doneLabel: 'Next'");
  });
});

describe('server twin stays in lockstep (source pins)', () => {
  const serverJs = read('server.js');
  it('declares the position-gated stage set and the derive-ladder order', () => {
    expect(serverJs).toContain("const POSITION_GATED_STAGES = new Set(['myintealth', 'amc', 'ahpra', 'visa', 'pbs']);");
    expect(serverJs).toContain("const POSITION_GATE_STAGE_ORDER = ['myintealth', 'amc', 'career', 'ahpra', 'visa', 'pbs'];");
  });
  it('journey-stages mirrors the same five gated stages', () => {
    expect(read('js/journey-stages.js')).toContain('var POSITION_GATED = { myinthealth: true, amc: true, ahpra: true, visa: true, pbs: true };');
  });
});

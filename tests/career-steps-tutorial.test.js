// Owner 2026-09-15: "There should be a tutorial once the GP gets to the
// career page (despite if cv has been uploaded or skipped) which highlights
// each step eg 1. Find your practice, 2. Interview, etc which should [have]
// more information on what the step is and what it then unlocks".
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('careers page tutorial — the four steps of the strip', () => {
  const js = read('js/gp-walkthrough.js');
  const steps = js.slice(js.indexOf('var CAREER_STEPS = ['), js.indexOf('];', js.indexOf('var CAREER_STEPS = [')));
  it('spotlights each strip step in order, and every tip says what the step unlocks', () => {
    ['1. Find your practice', '2. Interview', '3. Offer & contract', '4. Registration'].forEach((t, i) => {
      expect(steps).toContain("target: '[data-career-step=\"" + (i + 1) + "\"]'");
      expect(steps).toContain("title: '" + t + "'");
    });
    expect(steps.split('Unlocks:').length - 1).toBe(3); // steps 1–3 name what opens next
    expect(steps).toContain('registration pathway begins');
    expect(steps).toContain('30 minutes on Zoom');
  });
  it('the careers page area walks the strip when it is on screen (before any match/roles fallback)', () => {
    const fn = js.slice(js.indexOf('function stepsFor(area) {'), js.indexOf('function firstVisitLabel'));
    expect(fn.indexOf("document.querySelector('[data-career-step=\"1\"]')")).toBeLessThan(fn.indexOf("document.querySelector('.at-match-pin')"));
    expect(fn).toContain('return CAREER_STEPS.slice();');
  });
  it('the strip renders addressable steps', () => {
    expect(read('pages/career.html')).toContain("data-career-step=\"' + st.num + '\"");
  });
  it('the explainer and the CV gate only defer the tour — it fires after "Skip for now" as after an upload', () => {
    expect(js).toContain("var gate = document.querySelector('.career-gate-modal.is-open');");
    expect(js).toContain("window.addEventListener('gp-career-gate-closed', fire);");
    expect(js).toContain("window.addEventListener('gp-career-intro-closed', fire);");
    expect(read('pages/career.html')).toContain("function announceCareerGateClosed() { try { window.dispatchEvent(new CustomEvent('gp-career-gate-closed')); }");
  });
  it('runs on its own once-only flag, not behind the tab tour (which never runs in the two-tab phase)', async () => {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const S = req(path.join(process.cwd(), 'js', 'gp-walkthrough-state.js'));
    expect(S.defaultState().careerStepsSeen).toBe(false);
    expect(S.shouldRunCareerSteps({ tourDone: false })).toBe(true);          // no tour needed
    expect(S.shouldRunCareerSteps(S.withCareerStepsSeen({}))).toBe(false);   // once only
    expect(S.allSeenState().careerStepsSeen).toBe(true);
    const fn = js.slice(js.indexOf('function maybeRunCareerSteps()'), js.indexOf('function maybeRun()'));
    expect(fn).toContain("if (!S.shouldRunCareerSteps(readState())) { csLog('already-seen'); return false; }");
    expect(fn).toContain("if (!document.querySelector('[data-career-step=\"1\"]')) return false;");
    expect(fn).toContain("if (pageBlocked()) { csLog('blocked-defer'); armRetry(); return true; }");
    // seen is recorded only when the doctor finishes or skips — never at start
    // (a reload mid-tour used to burn the one shot; owner 2026-09-15)
    expect(fn).toContain("if (reason === 'done' || reason === 'skip' || reason === 'target') { markCareerStepsSeen(); return; }");
    expect(fn).toContain('if (careerStepsRunning || (C.isActive && C.isActive())) {');
    expect(js).not.toContain('function unmarkCareerStepsSeen');
    expect(fn).toContain('if (!careerStripVisible()) {');
    expect(js).toContain("var host = document.getElementById('careerStepStrip');");
    expect(fn).not.toContain('shouldRunTip');
    expect(js).toContain("if (area === 'practice' && maybeRunCareerSteps()) return;");
  });
  it('busters moved together', () => {
    ['pages/index.html', 'pages/account.html', 'pages/career.html', 'pages/messages.html'].forEach((p) => expect(read(p)).toContain('/js/gp-walkthrough.js?v=20260915d'));
    expect(read('sw.js')).toContain('"/js/gp-walkthrough.js?v=20260915d"');
    expect(read('sw.js')).toContain('var VERSION = "20260915d"');
  });
});

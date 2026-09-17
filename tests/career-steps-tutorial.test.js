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
    expect(fn).toContain("if (!document.querySelector('[data-career-step=\"1\"]')) { csLog('no-strip'); return false; }");
    expect(fn).toContain("if (pageBlocked(CAREER_STEPS_BLOCK_OPTS)) { csLog('blocked-defer'); armRetry(); return true; }");
    // seen is recorded only when the doctor finishes or skips — never at start
    // (a reload mid-tour used to burn the one shot; owner 2026-09-15)
    expect(fn).toContain("if (reason === 'done' || reason === 'skip' || reason === 'target') { markCareerStepsSeen(); announceCareerStepsDone(); return; }");
    expect(fn).toContain('if (careerStepsRunning || (C.isActive && C.isActive())) {');
    expect(js).not.toContain('function unmarkCareerStepsSeen');
    expect(fn).toContain('if (!careerStripVisible()) {');
    expect(js).toContain("var host = document.getElementById('careerStepStrip');");
    expect(fn).not.toContain('shouldRunTip');
    expect(js).toContain("if (area === 'practice' && maybeRunCareerSteps()) return;");
  });
  it('sees what the page alone cannot: a hidden tab and shell-level takeovers defer it; wake-ups stay armed', () => {
    const js = read('js/gp-walkthrough.js');
    const pb = js.slice(js.indexOf('function pageBlocked('), js.indexOf('function scheduleRetry()'));
    expect(pb).toContain("if (document.visibilityState === 'hidden') return true;");
    expect(pb).toContain("pd.querySelector('#gpMatchPopup, #gpInterviewPopup, #gpContractPopup, .gp-intro-card, .gp-coach-overlay')");
    const ar = js.slice(js.indexOf('function armRetry() {'), js.indexOf('var HOME = ['));
    expect(ar).toContain("document.addEventListener('visibilitychange', fire);");
    expect(ar).toContain("window.addEventListener('gp-career-updated', fire);");
    expect(ar).not.toContain('        disarm();\n      }'); // the 60 s deadline stops the poll only
    expect(ar).toContain('function fire() { disarm(); careerStepsAttempts = 0; scheduleRetry(); }');
  });
  it('the coach never reports a tour it never painted as done, and ignores keys until a tip is on screen', () => {
    const c = read('js/gp-coach.js');
    expect(c).toContain("if (!el) { if (idx >= total - 1) { if (painted === 0) cleanup('lost'); else done(); } else { idx++; render(); } return; }");
    expect(c).toContain('painted++; lastPaintAt = Date.now();');
    expect(c).toContain("if (Date.now() - lastPaintAt < 300) return; // a key still travelling from the previous screen");
    expect(c).toContain("if (!keyArmed) { keyArmed = true; d.addEventListener('keydown', onKey, true); }");
    expect(c.split("d.addEventListener('keydown', onKey, true)").length - 1).toBe(1);
  });
  it('keeps a decision trail the server can read (gp_career_steps_diag, synced like the walkthrough state)', () => {
    expect(read('js/gp-walkthrough.js')).toContain("localStorage.setItem('gp_career_steps_diag', JSON.stringify(trail.slice(-20)));");
    expect(read('js/state-sync.js')).toContain("'gp_career_steps_diag'");
    expect(read('server.js')).toContain("'gp_walkthrough_state',\n  'gp_career_steps_diag',");
  });
  // Owner 2026-09-18: "there is a clash here the upload cv popup should only
  // pop up after the walkthrough". Order is explainer -> tutorial -> CV gate.
  describe('the CV gate waits for the tutorial, not the other way round', () => {
    const js = read('js/gp-walkthrough.js');
    const career = read('pages/career.html');

    it('only the careers tutorial is exempt from the CV gate — every other tip still defers', () => {
      expect(js).toContain('var CAREER_STEPS_BLOCK_OPTS = { ignoreCvGate: true };');
      expect(js).toContain("if (!(opts && opts.ignoreCvGate)) {");
      // Both of the tutorial's own checks opt out...
      expect(js).toContain("if (pageBlocked(CAREER_STEPS_BLOCK_OPTS)) { csLog('blocked-defer');");
      expect(js).toContain("if (pageBlocked(CAREER_STEPS_BLOCK_OPTS)) { csLog('blocked-defer-late');");
      // ...and nothing else passes the opt-out.
      expect(js.split('ignoreCvGate: true').length - 1).toBe(1);
      // The gate itself is still in pageBlocked for the generic tips.
      expect(js).toContain("var gate = document.querySelector('.career-gate-modal.is-open');");
    });

    it('the first-visit EXPLAINER still blocks the tutorial, so it stays first', () => {
      const pb = js.slice(js.indexOf('function pageBlocked('), js.indexOf('function scheduleRetry()'));
      const introChecks = pb.slice(0, pb.indexOf('ignoreCvGate'));
      expect(introChecks).toContain("classList.contains('career-intro-open')");
      expect(introChecks).toContain(".career-intro.is-open");
    });

    it('the gate asks the walkthrough whether it is still pending', () => {
      expect(js).toContain('function careerStepsPending() {');
      expect(js).toContain('careerStepsPending: careerStepsPending');
      expect(career).toContain("function careerTutorialPending() { return careerTutorialAsk('careerStepsPending'); }");
      expect(career).toContain("function careerTutorialActive() { return careerTutorialAsk('careerStepsActive'); }");
      expect(career).toContain('openCareerGateAfterTutorial();');
      // ensureCareerGate must no longer open the modal directly.
      const ensure = career.slice(career.indexOf('async function ensureCareerGate'), career.indexOf("document.addEventListener('change'"));
      expect(ensure).toContain('openCareerGateAfterTutorial();');
      expect(ensure).not.toContain('openCareerGateModal();');
    });

    it('a finished tutorial releases the gate, and a returning doctor is not made to wait', () => {
      expect(js).toContain("window.dispatchEvent(new CustomEvent('gp-career-steps-done'))");
      expect(js).toContain("{ markCareerStepsSeen(); announceCareerStepsDone(); return; }");
      expect(career).toContain("window.addEventListener('gp-career-steps-done', openNow);");
      // Already seen -> careerStepsPending() false -> gate opens at once.
      expect(js).toContain('if (careerStepsRunning) return true;');
      expect(js).toContain('return !!S.shouldRunCareerSteps(readState());');
    });

    it('a tutorial that never runs cannot strand the gate', () => {
      expect(career).toContain('var CAREER_GATE_TUTORIAL_CEILING_MS = 90000;');
      expect(career).toContain('setTimeout(ceiling, CAREER_GATE_TUTORIAL_CEILING_MS);');
    });

    it('the ceiling NEVER cuts across a tour the doctor is reading', () => {
      // Owner 2026-09-18: the first version fired at 20s and opened the gate
      // on step 3 of 4. While a tip is on screen the ceiling re-arms.
      expect(career).toContain('if (careerTutorialActive()) { setTimeout(ceiling, CAREER_GATE_TUTORIAL_RECHECK_MS); return; }');
      expect(js).toContain('function careerStepsActive() { return !!careerStepsRunning; }');
      expect(js).toContain('careerStepsActive: careerStepsActive');
      // Only the done event opens the gate outright.
      expect(career).toContain("window.addEventListener('gp-career-steps-done', openNow);");
    });
  });

  it('busters moved together', () => {
    ['pages/index.html', 'pages/account.html', 'pages/career.html', 'pages/messages.html'].forEach((p) => expect(read(p)).toContain('/js/gp-walkthrough.js?v=20260918b'));
    expect(read('sw.js')).toContain('"/js/gp-walkthrough.js?v=20260918b"');
    expect(read('sw.js')).toContain('var VERSION = "20260918e"');
    expect(read('sw.js')).toContain('"/js/gp-coach.js?v=20260915a"');
    expect(read('sw.js')).toContain('"/js/state-sync.js?v=20260918b"');
  });
});

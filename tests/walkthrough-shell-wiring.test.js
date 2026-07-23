import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('shell wiring', () => {
  it('app-shell.html loads state-sync, coach, state and the shell controller', () => {
    const html = read('pages/app-shell.html');
    expect(html).toMatch(/\/js\/state-sync\.js\?v=/);
    expect(html).toMatch(/\/js\/gp-coach\.js\?v=/);
    expect(html).toMatch(/\/js\/gp-walkthrough-state\.js\?v=/);
    expect(html).toMatch(/\/js\/gp-walkthrough-shell\.js\?v=/);
  });
  it('app-shell.html loads the walkthrough scripts in dependency order', () => {
    const html = read('pages/app-shell.html');
    const iStateSync = html.indexOf('state-sync.js');
    const iCoach = html.indexOf('gp-coach.js');
    const iState = html.indexOf('gp-walkthrough-state.js');
    const iShell = html.indexOf('gp-walkthrough-shell.js');
    expect(iStateSync).toBeGreaterThan(-1);
    expect(iCoach).toBeGreaterThan(-1);
    expect(iState).toBeGreaterThan(-1);
    expect(iShell).toBeGreaterThan(-1);
    expect(iStateSync).toBeLessThan(iCoach);
    expect(iCoach).toBeLessThan(iState);
    expect(iState).toBeLessThan(iShell);
  });
  it('app-shell.js dispatches gp-shell-frame-loaded and handles gp-shell-run-tour', () => {
    const js = read('js/app-shell.js');
    expect(js).toContain('gp-shell-frame-loaded');
    expect(js).toContain('gp-shell-run-tour');
  });
  it('both walkthrough controllers stay guarded until onboarding is complete', () => {
    for (const file of ['js/gp-walkthrough-shell.js', 'js/gp-walkthrough.js']) {
      const src = read(file);
      const guardedBlock = src.slice(src.indexOf('function guarded'), src.indexOf('function readState'));
      expect(guardedBlock, `${file} guarded() checks the onboarding flag`).toContain('gp_onboarding_complete');
    }
  });
  it('shell tour never anchors to hidden nav elements', () => {
    const js = read('js/gp-walkthrough-shell.js');
    const navBlock = js.slice(js.indexOf('function isShown'), js.indexOf('function buildSteps'));
    expect(navBlock).toContain('offsetParent');
    expect(navBlock).toMatch(/isShown\(el\) \? el : null/);
  });
  it('runTour re-checks guarded() after its arm delay', () => {
    // tryAuto checks guarded() then arms runTour via setTimeout — the screen
    // can be taken over (onboarding gateway) inside that window, so runTour
    // must re-check before painting the overlay.
    const js = read('js/gp-walkthrough-shell.js');
    const block = js.slice(js.indexOf('function runTour'), js.indexOf('function tryAuto'));
    expect(block).toContain('guarded()');
  });
  it('shell cancels an active coach when onboarding takes over the screen', () => {
    const js = read('js/app-shell.js');
    const hideStart = js.indexOf('event.data.type === "gp-shell-hide-chrome"');
    const hideEnd = js.indexOf('event.data.type === "gp-shell-show-chrome"');
    expect(hideStart).toBeGreaterThan(-1);
    const hideBlock = js.slice(hideStart, hideEnd);
    expect(hideBlock, 'gp-shell-hide-chrome handler cancels the coach').toContain('gpCoach.cancel');
    const navStart = js.indexOf('var isOnboarding');
    expect(navStart).toBeGreaterThan(-1);
    const navBlock = js.slice(navStart, navStart + 600);
    expect(navBlock, 'navigateTo onboarding branch cancels the coach').toContain('gpCoach.cancel');
  });
});

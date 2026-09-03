// Doctor-guided flow (owner brief 2026-09-03): until a position is secured the
// app shows only My Practice + Account, a welcome slideshow explains the
// journey once, the careers page carries a "where am I" strip, and the
// registration slideshow fires when the placement lands. These pins keep the
// shell, the pages and the service worker in lockstep.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const between = (src, a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i + 1); expect(i, a).toBeGreaterThan(-1); return src.slice(i, j === -1 ? undefined : j); };

describe('shell: phase-driven nav', () => {
  const html = read('pages/app-shell.html');
  const js = read('js/app-shell.js');
  it('loads the phase module before app-shell.js and the slides before the walkthrough controller', () => {
    expect(html.indexOf('/js/gp-doctor-phase.js?v=')).toBeGreaterThan(-1);
    expect(html.indexOf('/js/gp-doctor-phase.js?v=')).toBeLessThan(html.indexOf('/js/app-shell.js?v='));
    expect(html.indexOf('/js/gp-intro-slides.js?v=')).toBeGreaterThan(html.indexOf('/js/gp-coach.js?v='));
    expect(html.indexOf('/js/gp-intro-slides.js?v=')).toBeLessThan(html.indexOf('/js/gp-walkthrough-shell.js?v='));
  });
  it('hides nav items via .gp-nav-hidden and collapses the mobile grid to two tabs in the position phase', () => {
    expect(html).toMatch(/\.mobile-tab\.gp-nav-hidden\s*\{[^}]*display:\s*none\s*!important/);
    expect(html).toMatch(/html\.gp-phase-position \.mobile-nav\s*\{[^}]*repeat\(2,/);
  });
  it('mirrors the unread dot onto the Account tab only while Support is hidden', () => {
    expect(html.match(/gp-account-alert/g).length).toBe(4);
    expect(html).toMatch(/html\.gp-phase-position \.gp-account-alert:not\(\[hidden\]\)\s*\{\s*display:\s*inline-flex/);
    expect(html).toMatch(/\.gp-account-alert\s*\{\s*display:\s*none;\s*\}/);
  });
  it('app-shell.js boots the phase before the first route and rewrites hidden routes', () => {
    const init = between(js, 'function init() {', 'prefetchSupportedRoutes();');
    expect(init.indexOf('bootPhase();')).toBeLessThan(init.indexOf('resolveInitialRoute()'));
    const nav = between(js, 'function navigateTo(input, options) {', 'var isOnboarding');
    expect(nav).toContain('isRouteHiddenInPhase(currentPhase, route)');
    expect(nav).toContain('landingRoute(currentPhase)');
    const initial = between(js, 'function resolveInitialRoute() {', 'function init() {');
    expect(initial.match(/isRouteHiddenInPhase/g).length).toBe(2); // both the direct-path and ?route= branches
  });
  it('phase changes re-evaluate on storage + hydration and bounce a now-hidden route to the landing page', () => {
    const boot = between(js, 'function bootPhase() {', 'window.gpShellPhase = {');
    expect(boot).toContain('addEventListener("storage"');
    expect(boot).toContain('gp-state-hydrated');
    const refresh = between(js, 'function refreshPhase(reason) {', 'function settlePhase');
    expect(refresh).toContain('gp-shell-phase-changed');
    expect(refresh).toContain('navigateTo(P.landingRoute(next)');
    expect(refresh).toContain('previous &&'); // never on the boot pass
  });
  it('show-chrome waits for a trustworthy phase (no two-tab flash for placed doctors on a fresh device)', () => {
    const block = between(js, 'event.data.type === "gp-shell-show-chrome"', 'event.data.type !== "gp-shell-route"');
    expect(block).toContain('whenPhaseReady(');
    expect(block).toContain('refreshPhase("show-chrome")');
  });
  it('Account replay runs the phase slideshow; the spotlight tour has its own message', () => {
    expect(js).toContain('event.data.type === "gp-shell-run-nav-tour"');
    const replay = between(js, 'event.data.type === "gp-shell-run-tour"', 'gp-shell-run-nav-tour');
    expect(replay).toContain('W.replay()');
  });
});

describe('walkthrough controller: slideshows own the first-run guidance', () => {
  const js = read('js/gp-walkthrough-shell.js');
  it('position phase → welcome deck only; no tab tour, no pointer', () => {
    const block = between(js, "if (ph === 'position') {", "if (ph !== 'registration') return;");
    expect(block).toContain('runWelcomeSlides(false)');
    expect(block).not.toContain('runTour');
    expect(block).not.toContain('scheduleNextStepPointer');
  });
  it('registration phase → registration deck once, retired silently for doctors already past MyIntealth', () => {
    const block = between(js, 'if (S.shouldRunRegistrationIntro(stNow)) {', 'if (!homeLoaded) return;');
    expect(block).toContain('readEpicDone()');
    expect(block).toContain('markRegistrationIntroSeen()');
    expect(block).toContain('runRegistrationSlides(false)');
  });
  it('first runs are mandatory except for impersonated staff; replays never mark anything', () => {
    for (const fn of ['function runWelcomeSlides(replay)', 'function runRegistrationSlides(replay)']) {
      const block = between(js, fn, 'broadcastCoachActive(true);');
      expect(block, fn).toContain('!isImpersonated()');
      expect(block, fn).toMatch(/var mandatory = first &&/);
    }
    const welcome = between(js, 'function runWelcomeSlides(replay)', 'function runRegistrationSlides');
    expect(welcome).toContain("if (!replay) { markIntroSeen(); markCareerIntroSeen(); }");
  });
  it('the welcome deck absorbs the careers explainer (marks its key, tells the frame) and lands on My Practice', () => {
    const welcome = between(js, 'function runWelcomeSlides(replay)', 'function runRegistrationSlides');
    expect(welcome).toContain("tellFrames('gp-shell-intro-done'");
    expect(welcome).toContain("gpShellNavigate('/pages/career'");
    expect(js).toContain("var CAREER_INTRO_SEEN_KEY = 'gp_career_intro_seen';");
  });
  it('the registration deck counts the tab tour as done and hands over to the Home pointer', () => {
    const reg = between(js, 'function runRegistrationSlides(replay)', 'function replay()');
    expect(reg).toContain('markDone();');
    expect(reg).toContain("gpShellNavigate('/pages/index'");
    expect(reg).toContain("afterFrame('/pages/index'");
    expect(reg).toContain('scheduleNextStepPointer(');
  });
  it('a running slideshow blocks the coach, and a phase change re-arms the one-shot', () => {
    const guardedBlock = between(js, 'function guarded', 'function hasLiveMatch');
    expect(guardedBlock).toContain('I.isActive()');
    expect(js).toContain("window.addEventListener('gp-shell-phase-changed', function () { ranAuto = false; tryAuto(); });");
  });
});

describe('careers page: "where am I" strip', () => {
  const html = read('pages/career.html');
  it('loads the pure helper and renders the strip inside the masthead', () => {
    expect(html).toContain('/js/career-step-strip.js?v=');
    const mast = between(html, '<div class="at-mast-inner">', '</header>');
    expect(mast).toContain('id="careerStepStrip"');
    expect(mast).toContain('id="careerStepRow"');
    expect(mast).toContain('id="careerStepHint"');
  });
  it('re-renders on every state persist and hides once secured', () => {
    expect(html).toContain('window.addEventListener("gp-career-updated", renderCareerStepStrip);');
    const fn = between(html, 'function renderCareerStepStrip() {', 'window.addEventListener("gp-career-updated"');
    expect(fn).toContain('r.step >= 4');
    expect(fn).toContain('helper.deriveCareerStep(apps)');
    expect(html).toMatch(/body\.career-mode-secured \.at-steps \{ display: none !important; \}/);
  });
  it('closes its own explainer when the shell says the welcome deck covered it', () => {
    const block = between(html, 'event.data.type !== "gp-shell-intro-done"', 'function ensureCareerIntro()');
    expect(block).toContain('closeCareerIntro()');
  });
});

describe('account page: team card + replay rows', () => {
  const html = read('pages/account.html');
  it('loads journey-stages + the phase module and carries Messages/Documents while Support is hidden', () => {
    expect(html).toContain('/js/gp-doctor-phase.js?v=');
    expect(html).toContain('/js/journey-stages.js?v=');
    const card = between(html, 'id="phaseTeamCard"', 'Account overview');
    expect(card).toContain('href="messages"');
    expect(card).toContain('href="my-documents"');
    expect(card).toContain('data-inbox-alert');
  });
  it('replay row is the welcome guide; the tab tour row only appears once registered', () => {
    expect(html).toContain('data-walkthrough-replay');
    expect(html).toContain('Replay the welcome guide');
    expect(html).toContain('data-walkthrough-nav-tour');
    expect(html).toContain('gp-shell-run-nav-tour');
    expect(html).toContain('navTour.hidden = ph !== "registration"');
    expect(html).toContain('team.hidden = ph !== "position"');
  });
});

describe('cache: busters and service worker moved together', () => {
  it('sw.js VERSION moved and precaches the new scripts at the busters the shell ships', () => {
    const sw = read('sw.js');
    const shell = read('pages/app-shell.html');
    expect(sw).toContain('var VERSION = "20260903a"');
    for (const f of ['app-shell.js', 'gp-walkthrough-state.js', 'gp-walkthrough-shell.js', 'gp-doctor-phase.js', 'gp-intro-slides.js']) {
      const m = shell.match(new RegExp('/js/' + f.replace('.', '\\.') + '\\?v=([0-9a-z]+)'));
      expect(m, f).not.toBeNull();
      expect(sw, f).toContain('"/js/' + f + '?v=' + m[1] + '"');
    }
    const career = read('pages/career.html').match(/\/js\/career-step-strip\.js\?v=([0-9a-z]+)/);
    expect(sw).toContain('"/js/career-step-strip.js?v=' + career[1] + '"');
  });
  it('state module shipped with the new slide flags', () => {
    expect(read('js/gp-walkthrough-state.js')).toContain('registrationIntroSeen');
  });
});

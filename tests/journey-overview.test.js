// Phase 6 Batch F1 — G1: one canonical 7-stage journey overview incl Commencement.
//
// These pages/scripts are static files served verbatim (no server templating),
// so reading them straight from disk is an honest check of what the browser
// receives. Contract pinned here:
//   - js/journey-stages.js is the single source of truth: the ordered 7-stage
//     list (Secure Placement → MyIntealth → AMC → AHPRA → Visa → PBS & Medicare
//     → Commencement) with lock copy, exposed as window.GPJourneyStages.
//   - BOTH surfaces (pages/index.html journey + js/app-shell.js registration
//     dropdown) consume GPJourneyStages.getStageStates — so they can't drift.
//   - The horizontal journey stepper and the ?locked bounce notice were
//     REMOVED from index.html by owner request (2026-07-07): the vertical
//     journey list is the only journey renderer on the dashboard. The server
//     stage-gate still bounces with ?locked=<stage>; the page now ignores it.
//   - Commencement's lock is explained ("Unlocks once PBS & Medicare is
//     complete") in the journey list + registration dropdown.
//   - Index has an honest API-failure retry affordance for its server refresh.
// GP-visible copy must never say the bare "RSO" abbreviation.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAGES_JS_PATH = path.join(__dirname, '..', 'js', 'journey-stages.js');
const INDEX_PATH = path.join(__dirname, '..', 'pages', 'index.html');
const APP_SHELL_JS_PATH = path.join(__dirname, '..', 'js', 'app-shell.js');
const APP_SHELL_HTML_PATH = path.join(__dirname, '..', 'pages', 'app-shell.html');
const SERVER_PATH = path.join(__dirname, '..', 'server.js');

const SEVEN_STAGE_TITLES = [
  'Secure Placement',
  'MyIntealth Account',
  'AMC Portfolio',
  'AHPRA Registration',
  'Visa Application',
  'PBS & Medicare',
  'Commencement'
];
const SEVEN_STAGE_KEYS = ['career', 'myinthealth', 'amc', 'ahpra', 'visa', 'pbs', 'commencement'];
// Commencement is currently VAULTED (js/journey-stages.js) — its definition is
// retained (so the 7 text-presence checks below still hold) but it is excluded
// from the GP-facing list, so the journey the GP actually sees is six stages.
const SIX_STAGE_TITLES = SEVEN_STAGE_TITLES.slice(0, 6);
const SIX_STAGE_KEYS = SEVEN_STAGE_KEYS.slice(0, 6);

let stagesJs;
let indexHtml;
let appShellJs;
let appShellHtml;
let serverJs;

beforeAll(() => {
  stagesJs = fs.readFileSync(STAGES_JS_PATH, 'utf8');
  indexHtml = fs.readFileSync(INDEX_PATH, 'utf8');
  appShellJs = fs.readFileSync(APP_SHELL_JS_PATH, 'utf8');
  appShellHtml = fs.readFileSync(APP_SHELL_HTML_PATH, 'utf8');
  serverJs = fs.readFileSync(SERVER_PATH, 'utf8');
});

describe('js/journey-stages.js — canonical journey source of truth (commencement vaulted)', () => {
  it('defines all 7 stage titles in journey order', () => {
    let lastIdx = -1;
    for (const title of SEVEN_STAGE_TITLES) {
      const idx = stagesJs.indexOf(`title: "${title}"`);
      expect(idx, `missing stage title: ${title}`).toBeGreaterThan(-1);
      expect(idx, `stage out of order: ${title}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it('defines all 7 stage keys including commencement', () => {
    for (const key of SEVEN_STAGE_KEYS) {
      expect(stagesJs).toContain(`key: "${key}"`);
    }
  });

  it('exposes window.GPJourneyStages with getStageStates', () => {
    expect(stagesJs).toContain('window.GPJourneyStages');
    expect(stagesJs).toContain('function getStageStates(');
  });

  it('explains the Commencement lock (server-gated after PBS)', () => {
    expect(stagesJs).toContain('Unlocks once PBS & Medicare is complete');
  });

  it('exposes six visible stages with commencement vaulted (behavioural)', () => {
    // Evaluate the file in a sandbox and drive the derivation both surfaces use.
    const sandbox = { window: {} };
    // eslint-disable-next-line no-new-func
    new Function('window', stagesJs)(sandbox.window);
    const api = sandbox.window.GPJourneyStages;
    expect(api).toBeTruthy();
    // Commencement is vaulted: excluded from the GP-facing list, but its
    // definition is retained (ALL_STAGES) so a flag flip restores it.
    expect(api.VAULTED.commencement).toBe(true);
    expect(api.STAGES.map((s) => s.title)).toEqual(SIX_STAGE_TITLES);
    expect(api.STAGES.some((s) => s.key === 'commencement')).toBe(false);
    expect(api.ALL_STAGES.map((s) => s.title)).toEqual(SEVEN_STAGE_TITLES);

    // Six agreeing stage states; PBS & Medicare is now the final visible stage.
    const midway = api.getStageStates({ careerSecured: true, epicDone: true, amcDone: true, ahpraDone: true, visaDone: false, pbsDone: false }, false);
    expect(midway).toHaveLength(6);
    expect(midway.some((s) => s.key === 'commencement')).toBe(false);
    expect(midway[5].key).toBe('pbs');

    const late = api.getStageStates({ careerSecured: true, epicDone: true, amcDone: true, ahpraDone: true, visaDone: true, pbsDone: true }, false);
    expect(late).toHaveLength(6);
    // Visa/PBS done-flags derive from the snapshot (no hardcoded false).
    expect(late[4].done).toBe(true);
    expect(late[5].done).toBe(true);
  });
});

describe('pages/index.html — journey surface (commencement vaulted)', () => {
  it('loads the canonical stage list and consumes it in both renderers', () => {
    expect(indexHtml).toMatch(/js\/journey-stages\.js\?v=/);
    // Journey list + nav/mobile registration rows both go through the shared list.
    const consumerCount = (indexHtml.match(/GPJourneyStages\.getStageStates\(/g) || []).length;
    expect(consumerCount).toBeGreaterThanOrEqual(2);
  });

  it('does not load or render the horizontal stepper (removed by owner request)', () => {
    expect(indexHtml).not.toMatch(/js\/registration-stepper\.js/);
    expect(indexHtml).not.toContain('id="journeyStepper"');
    expect(indexHtml).not.toContain('GPRegistrationStepper');
    // The journey list still re-renders once deferred journey-stages.js has executed.
    expect(indexHtml).toMatch(/DOMContentLoaded[\s\S]*?renderJourneyList\(\)/);
  });

  it('counts progress across the six visible stages (commencement vaulted)', () => {
    expect(indexHtml).toContain('const TOTAL_STEPS = 6;');
    expect(indexHtml).toMatch(/\[careerSecured, epicDone, amcDone, ahpraDone, visaDone, pbsDone\]/);
  });

  it('does not route the "next step" to the vaulted commencement page', () => {
    expect(indexHtml).not.toContain('currentRoute = "commencement"');
    // After PBS & Medicare the visible journey is complete — CTA points at the practice.
    expect(indexHtml).toContain("You're all set");
  });

  it('locked-stage bounce lands silently (notice removed by owner request)', () => {
    expect(indexHtml).not.toContain('id="stageLockedNotice"');
    expect(indexHtml).not.toContain('.get("locked")');
  });

  it('no longer shows the false "couldn\'t refresh your progress" banner (owner request 2026-07-08)', () => {
    // The journey renders from locally cached progress and the page is
    // auth-guarded, so a transient background /api/state hiccup never meant the
    // data shown was actually stale — the red banner only ever cried wolf.
    // An earlier "resilient" retry/self-heal attempt (2026-07-07) still let it
    // stick, so the whole banner + its server-ping machinery were removed.
    expect(indexHtml).not.toContain("We couldn't refresh your latest progress");
    expect(indexHtml).not.toContain('id="dataErrorBanner"');
    expect(indexHtml).not.toContain('id="dataErrorRetry"');
    expect(indexHtml).not.toContain('id="dataErrorDetail"');
    expect(indexHtml).not.toContain('checkServerState');
    expect(indexHtml).not.toContain('dataErrorRecheckTimer');
    expect(indexHtml).not.toContain('data-error-banner');
  });

  it('never uses the bare "RSO" abbreviation in GP-visible copy', () => {
    expect(indexHtml).not.toMatch(/\bRSO\b/);
  });
});

describe('pages/index.html — featured practice banner', () => {
  it('adapts its copy to placement state (find-a-position until secured)', () => {
    // Placed GPs keep the secured-practice framing…
    expect(indexHtml).toContain('"Your Practice"');
    expect(indexHtml).toContain('"View your secured placement details and practice information"');
    // …while unplaced GPs are pointed at finding + securing a position.
    expect(indexHtml).toContain('"Find Your Practice"');
    expect(indexHtml).toContain('"Browse open GP positions and secure your placement to advance your journey"');
    expect(indexHtml).toContain('"Browse jobs"');
    // The switch is driven by the placement flag, not hardcoded.
    expect(indexHtml).toMatch(/if \(snap\.careerSecured\) \{[\s\S]{0,500}\} else \{[\s\S]{0,500}Find Your Practice/);
    expect(indexHtml).toContain('id="dreamBannerTitle"');
    expect(indexHtml).toContain('id="dreamBannerCtaLabel"');
  });

  it('carries the shiny sweep in both states, with a reduced-motion opt-out', () => {
    expect(indexHtml).toContain('.dream-banner::after');
    expect(indexHtml).toContain('@keyframes dreamBannerShine');
    expect(indexHtml).toMatch(/prefers-reduced-motion[\s\S]{0,200}dream-banner::after/);
  });
});

describe('js/app-shell.js — registration dropdown agrees with the journey', () => {
  it('consumes the same canonical stage list', () => {
    expect(appShellJs).toContain('GPJourneyStages.getStageStates(');
  });

  it('renders a commencement row with the lock explanation fallback', () => {
    expect(appShellJs).toContain('commencement: {');
    expect(appShellJs).toContain('Unlocks once PBS & Medicare is complete');
    expect(appShellJs).toContain('"/pages/commencement"');
  });

  it('never uses the bare "RSO" abbreviation', () => {
    expect(appShellJs).not.toMatch(/\bRSO\b/);
  });
});

describe('pages/app-shell.html — script wiring', () => {
  it('loads journey-stages.js before app-shell.js', () => {
    const stagesIdx = appShellHtml.indexOf('/js/journey-stages.js');
    const shellIdx = appShellHtml.indexOf('/js/app-shell.js');
    expect(stagesIdx).toBeGreaterThan(-1);
    expect(shellIdx).toBeGreaterThan(-1);
    expect(stagesIdx).toBeLessThan(shellIdx);
  });
});

describe('server.js — stage-gate bounce explains itself (display only)', () => {
  it('redirects blocked stage pages with ?locked=<stage>', () => {
    expect(serverJs).toMatch(/\/pages\/index'\s*\+\s*\(lockedStage\s*\?\s*'\?locked='/);
  });

  it('keeps the access gates untouched (visa/ahpra/career force-allowed)', () => {
    expect(serverJs).toContain("if (stage === 'career' || stage === 'ahpra' || stage === 'visa') return true;");
    expect(serverJs).toMatch(/commencement:\s*\{\s*accessible:\s*bypassAll\s*\|\|\s*pbsApproved/);
  });

  it('vaults commencement from GP page access (server mirror of journey-stages)', () => {
    expect(serverJs).toContain("const VAULTED_STAGES = new Set(['commencement']);");
    expect(serverJs).toContain('if (VAULTED_STAGES.has(stage)) return false;');
  });
});

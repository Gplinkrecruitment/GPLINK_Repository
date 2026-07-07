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

describe('js/journey-stages.js — canonical 7-stage source of truth', () => {
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

  it('actually derives 7 agreeing stage states from a snapshot (behavioural)', () => {
    // Evaluate the file in a sandbox and drive the derivation both surfaces use.
    const sandbox = { window: {} };
    // eslint-disable-next-line no-new-func
    new Function('window', stagesJs)(sandbox.window);
    const api = sandbox.window.GPJourneyStages;
    expect(api).toBeTruthy();
    expect(api.STAGES.map((s) => s.title)).toEqual(SEVEN_STAGE_TITLES);

    // GP with PBS not done → commencement locked with the explanation.
    const midway = api.getStageStates({ careerSecured: true, epicDone: true, amcDone: true, ahpraDone: true, visaDone: false, pbsDone: false }, false);
    expect(midway).toHaveLength(7);
    const commencement = midway[6];
    expect(commencement.key).toBe('commencement');
    expect(commencement.locked).toBe(true);
    expect(commencement.lockReason).toBe('Unlocks once PBS & Medicare is complete');

    // GP past PBS → commencement unlocked (available), never "done" client-side.
    const late = api.getStageStates({ careerSecured: true, epicDone: true, amcDone: true, ahpraDone: true, visaDone: true, pbsDone: true }, false);
    expect(late[6].locked).toBe(false);
    expect(late[6].done).toBe(false);
    // Visa/PBS done-flags derive from the snapshot (no hardcoded false).
    expect(late[4].done).toBe(true);
    expect(late[5].done).toBe(true);
  });
});

describe('pages/index.html — 7-stage journey surface', () => {
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

  it('counts progress across all 7 stages (visa included, no 6-step remnant)', () => {
    expect(indexHtml).toContain('const TOTAL_STEPS = 7;');
    expect(indexHtml).toMatch(/\[careerSecured, epicDone, amcDone, ahpraDone, visaDone, pbsDone\]/);
  });

  it('routes the "next step" chain through commencement after PBS', () => {
    expect(indexHtml).toContain('currentRoute = "commencement"');
  });

  it('locked-stage bounce lands silently (notice removed by owner request)', () => {
    expect(indexHtml).not.toContain('id="stageLockedNotice"');
    expect(indexHtml).not.toContain('.get("locked")');
  });

  it('has an honest API-failure retry affordance for the server refresh', () => {
    expect(indexHtml).toContain('id="dataErrorBanner"');
    expect(indexHtml).toContain('id="dataErrorRetry"');
    expect(indexHtml).toContain("We couldn't refresh your latest progress");
  });

  it('refresh check is resilient: retries, self-healing banner, 401 → sign-in', () => {
    // One transient hiccup must not permanently brand the page (2026-07-07:
    // owner saw a stuck banner while the server logged nothing but 200s).
    // Retries before first showing the banner…
    expect(indexHtml).toMatch(/checkServerState\(attempt \+ 1\)/);
    // …keeps re-checking while visible so it hides itself on recovery…
    expect(indexHtml).toMatch(/setInterval\(\(\) => checkServerState\(2\), 30000\)/);
    expect(indexHtml).toContain('clearInterval(dataErrorRecheckTimer)');
    // …and a dead session bounces to sign-in instead of claiming stale data.
    expect(indexHtml).toContain('r.status === 401');
    expect(indexHtml).toContain('"/pages/signin"');
    // The banner states its technical reason so screenshots are diagnosable.
    expect(indexHtml).toContain('id="dataErrorDetail"');
  });

  it('never uses the bare "RSO" abbreviation in GP-visible copy', () => {
    expect(indexHtml).not.toMatch(/\bRSO\b/);
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
});

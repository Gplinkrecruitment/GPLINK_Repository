import { describe, it, expect, beforeAll } from 'vitest';

// Regression coverage for the "Visa application loads the home page" bug.
// Stage-advance writes a full gp_registration_return_overrides map where
// overrides[stage] = (stageIndex <= currentStageIndex). visa is index 5, so every GP
// before the visa stage gets overrides.visa === false. The journey's Visa card is
// always unlocked and links to /pages/visa; the server stage-gate must therefore treat
// visa as always-accessible (like ahpra/career) — otherwise the shell iframe load of
// /pages/visa.html is 302'd to /pages/index and the home journey renders at /pages/visa.

// 2026-09-01 position-first update (owner rule): a 4th `positionGate` argument
// ({careerSecured, stageCompleted} from positionGateFor) locks EVERY
// registration stage — myintealth/amc/ahpra/visa/pbs — for an unplaced GP,
// bouncing them to the careers page. The always-accessible behaviour below
// still holds whenever the position gate is open (secured) or not supplied
// (legacy callers), which is what these original tests exercise.

let stageGateDecision;
let positionGateFor;

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  const mod = await import('../server.js');
  stageGateDecision = mod.__testUtils.stageGateDecision;
  positionGateFor = mod.__testUtils.positionGateFor;
});

// The exact overrides written by stage-advance for a GP currently at the AHPRA stage
// (index 4) — every later stage, including visa (index 5), is false.
const PRE_VISA_OVERRIDES = {
  placement: true, myintealth: true, amc: true, career: true,
  ahpra: true, visa: false, pbs: false, commencement: false
};

describe('stageGateDecision — visa is always accessible', () => {
  it('allows visa even when the overrides explicitly lock it', () => {
    expect(stageGateDecision('visa', { visa: false }, false)).toBe(true);
  });
  it('allows visa for a GP still at an earlier stage (real pre-visa override)', () => {
    expect(stageGateDecision('visa', PRE_VISA_OVERRIDES, false)).toBe(true);
  });
  it('keeps ahpra and career always accessible too', () => {
    expect(stageGateDecision('ahpra', { ahpra: false }, false)).toBe(true);
    expect(stageGateDecision('career', { career: false }, false)).toBe(true);
  });
});

describe('stageGateDecision — other stages still honour overrides (no regression)', () => {
  it('blocks a genuinely locked stage', () => {
    expect(stageGateDecision('pbs', PRE_VISA_OVERRIDES, false)).toBe(false);
    expect(stageGateDecision('commencement', { commencement: false }, false)).toBe(false);
  });
  it('allows an unlocked stage', () => {
    expect(stageGateDecision('pbs', { pbs: true }, false)).toBe(true);
  });
  it('allows a stage absent from the overrides (natural progression)', () => {
    expect(stageGateDecision('amc', {}, false)).toBe(true);
    expect(stageGateDecision('amc', null, false)).toBe(true);
  });
  it('allows everything for a bypass-lock account', () => {
    expect(stageGateDecision('pbs', { pbs: false }, true)).toBe(true);
  });
  it('allows when there is no stage (ungated page)', () => {
    expect(stageGateDecision('', {}, false)).toBe(true);
  });
});

describe('stageGateDecision — vaulted commencement is fully shelved', () => {
  it('blocks commencement regardless of overrides or bypass', () => {
    expect(stageGateDecision('commencement', {}, false)).toBe(false);                    // natural progression can't reach it
    expect(stageGateDecision('commencement', { commencement: true }, false)).toBe(false); // an override cannot unlock it
    expect(stageGateDecision('commencement', {}, true)).toBe(false);                     // bypass cannot reach it either
  });
  it('leaves the live stages unaffected', () => {
    expect(stageGateDecision('pbs', { pbs: true }, false)).toBe(true);
    expect(stageGateDecision('visa', {}, false)).toBe(true);
  });
});

// ── Position-first registration lock (owner rule, 2026-09-01) ──
describe('stageGateDecision — position gate locks registration steps until secured', () => {
  const UNSECURED = { careerSecured: false, stageCompleted: false };
  const SECURED = { careerSecured: true, stageCompleted: false };
  const COMPLETED = { careerSecured: false, stageCompleted: true };

  it('locks every registration stage for an unplaced GP, even natural-progression ones', () => {
    for (const stage of ['myintealth', 'amc', 'ahpra', 'visa', 'pbs']) {
      expect(stageGateDecision(stage, {}, false, UNSECURED), stage).toBe(false);
      expect(stageGateDecision(stage, { [stage]: true }, false, UNSECURED), stage).toBe(false);
    }
  });
  it('career itself is never locked — it is where the lock sends people', () => {
    expect(stageGateDecision('career', {}, false, UNSECURED)).toBe(true);
  });
  it('a secured position restores the old behaviour exactly', () => {
    expect(stageGateDecision('visa', { visa: false }, false, SECURED)).toBe(true);  // force-allow
    expect(stageGateDecision('ahpra', { ahpra: false }, false, SECURED)).toBe(true); // force-allow
    expect(stageGateDecision('myintealth', {}, false, SECURED)).toBe(true);
    expect(stageGateDecision('pbs', { pbs: false }, false, SECURED)).toBe(false);    // overrides still honoured
  });
  it('a step the GP already completed stays reachable (read-only review)', () => {
    expect(stageGateDecision('myintealth', {}, false, COMPLETED)).toBe(true);
  });
  it('bypass accounts skip the position lock like every other gateway', () => {
    expect(stageGateDecision('myintealth', {}, true, UNSECURED)).toBe(true);
  });
  it('no positionGate argument means legacy behaviour (this file above)', () => {
    expect(stageGateDecision('myintealth', {}, false)).toBe(true);
  });
});

describe('positionGateFor — reads the user_state blob', () => {
  it('null for stages the position rule does not touch', () => {
    expect(positionGateFor('career', {})).toBe(null);
    expect(positionGateFor('commencement', {})).toBe(null);
  });
  it('unplaced by default (no state / empty state)', () => {
    expect(positionGateFor('myintealth', null)).toEqual({ careerSecured: false, stageCompleted: false });
    expect(positionGateFor('myintealth', {})).toEqual({ careerSecured: false, stageCompleted: false });
  });
  it('secured via gp_career_state flags or a secured/hired application', () => {
    expect(positionGateFor('visa', { gp_career_state: { career_secured: true } }).careerSecured).toBe(true);
    expect(positionGateFor('visa', { gp_career_state: { secured: true } }).careerSecured).toBe(true);
    expect(positionGateFor('visa', { gp_career_state: { applications: [{ isPlacementSecured: true }] } }).careerSecured).toBe(true);
    expect(positionGateFor('visa', { gp_career_state: { applications: [{ status: 'hired' }] } }).careerSecured).toBe(true);
    expect(positionGateFor('visa', { gp_career_state: JSON.stringify({ career_secured: true }) }).careerSecured).toBe(true); // state values are often stringified
    expect(positionGateFor('visa', { gp_career_state: { applications: [{ status: 'applied' }] } }).careerSecured).toBe(false);
  });
  it('marks a stage completed from the derive ladder (unplaced doctor mid-AMC keeps MyIntealth)', () => {
    // Epic verification issued → derived stage is 'amc' → myintealth is complete.
    const state = { gp_epic_progress: { completed: { verification_issued: true } } };
    expect(positionGateFor('myintealth', state)).toEqual({ careerSecured: false, stageCompleted: true });
    expect(positionGateFor('amc', state)).toEqual({ careerSecured: false, stageCompleted: false });
    expect(positionGateFor('ahpra', state).stageCompleted).toBe(false);
  });
});

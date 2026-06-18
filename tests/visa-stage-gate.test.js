import { describe, it, expect, beforeAll } from 'vitest';

// Regression coverage for the "Visa application loads the home page" bug.
// Stage-advance writes a full gp_registration_return_overrides map where
// overrides[stage] = (stageIndex <= currentStageIndex). visa is index 5, so every GP
// before the visa stage gets overrides.visa === false. The journey's Visa card is
// always unlocked and links to /pages/visa; the server stage-gate must therefore treat
// visa as always-accessible (like ahpra/career) — otherwise the shell iframe load of
// /pages/visa.html is 302'd to /pages/index and the home journey renders at /pages/visa.

let stageGateDecision;

beforeAll(async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  const mod = await import('../server.js');
  stageGateDecision = mod.__testUtils.stageGateDecision;
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

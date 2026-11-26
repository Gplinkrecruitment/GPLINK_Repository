// Owner screenshot 2026-11-26: the AI handover summary said an onboarded GP who was still
// finding a position was "stuck at the very first onboarding step — myintealth account
// creation", and the claim persisted across handover cycles. Registration (MyIntealth) only
// starts once a position is secured; the raw registration_cases.stage is 'myintealth' from
// sign-up. These pin the phase derivation and the prompt/caching guards.
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { summaryJourneyPhase, careerStateSecured, JOURNEY_PHASE_RULE } = require('../lib/summary-journey-phase.js');
const { selectStaleSummaryCases } = require('../lib/summary-refresh.js');
const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

describe('summaryJourneyPhase', () => {
  it('onboarded + no secured position = finding a position, even though the case row says myintealth', () => {
    const p = summaryJourneyPhase({ onboardingCompletedAt: '2026-11-14T00:00:00Z', state: {}, hasPlacedApplication: false, storedStage: 'myintealth', storedSubstage: 'create_account' });
    expect(p.phase).toBe('position');
    expect(p.promptLine).toContain('FINDING A POSITION');
    expect(p.promptLine).not.toMatch(/create_account/);
  });

  it('onboarding not finished = onboarding', () => {
    expect(summaryJourneyPhase({ state: { gp_onboarding: { currentStep: 2 } }, storedStage: 'myintealth' }).phase).toBe('onboarding');
  });

  it('wizard state alone counts as onboarded (same rule as the app)', () => {
    expect(summaryJourneyPhase({ state: { gp_onboarding_complete: 'true' } }).phase).toBe('position');
    expect(summaryJourneyPhase({ state: { gp_onboarding: JSON.stringify({ completedAt: 'x' }) } }).phase).toBe('position');
  });

  it('secured via owned application rows = registration at the stored stage', () => {
    const p = summaryJourneyPhase({ onboardingCompletedAt: 'x', hasPlacedApplication: true, storedStage: 'myintealth', storedSubstage: 'create_account' });
    expect(p.phase).toBe('registration');
    expect(p.promptLine).toContain('MyIntealth');
    expect(p.promptLine).toContain('create_account');
  });

  it('secured via the career-state mirror = registration', () => {
    const state = { gp_onboarding_complete: true, gp_career_state: JSON.stringify({ applications: [{ status: 'Placement Secured' }] }) };
    expect(summaryJourneyPhase({ state, storedStage: 'ahpra' }).phase).toBe('registration');
  });

  it('careerStateSecured mirrors the app check', () => {
    expect(careerStateSecured({ career_secured: true })).toBe(true);
    expect(careerStateSecured({ applications: [{ isPlacementSecured: true }] })).toBe(true);
    expect(careerStateSecured({ applications: [{ status: 'interview' }] })).toBe(false);
    expect(careerStateSecured(null)).toBe(false);
  });

  it('the rule forbids "stuck at MyIntealth" before a position is secured', () => {
    expect(JOURNEY_PHASE_RULE).toContain('NEVER say the GP is stuck, stalled, blocked or behind at MyIntealth');
    expect(JOURNEY_PHASE_RULE).toContain('If a previous summary said otherwise, it was wrong');
  });
});

describe('candidate-summary endpoint wiring', () => {
  it('feeds the phase line and the rule to the model, and hides the raw stage before registration', () => {
    expect(serverSrc).toContain("prompt += journeyPhase.promptLine + '\\n';");
    expect(serverSrc).toContain("if (journeyPhase.phase === 'registration') {");
    expect(serverSrc).toContain("' + JOURNEY_PHASE_RULE + '");
  });

  it('never serves a cached summary written for another phase, and stamps the phase it wrote', () => {
    expect(serverSrc).toContain('regCase.ai_handover_summary.journey_phase === journeyPhase.phase');
    expect(serverSrc).toContain('journey_phase: journeyPhase.phase,');
  });

  it('does not feed back a previous summary written under a different phase', () => {
    expect(serverSrc).toContain('handover.journey_phase !== journeyPhase.phase');
  });
});

describe('refresh cron picks pre-fix summaries once', () => {
  const T = Date.parse('2026-11-26T00:00:00Z');
  it('a summary with no journey_phase is stale; a stamped fresh one is not', () => {
    const old = { id: 'old', ai_handover_summary: { generated_at: new Date(T - 3600e3).toISOString() }, updated_at: new Date(T - 7200e3).toISOString() };
    const ok = { id: 'ok', ai_handover_summary: { journey_phase: 'position', generated_at: new Date(T - 3600e3).toISOString() }, updated_at: new Date(T - 7200e3).toISOString() };
    expect(selectStaleSummaryCases([old, ok], T).map((c) => c.id)).toEqual(['old']);
  });
});

describe('matchingDetailsLine', () => {
  const { matchingDetailsLine } = require('../lib/summary-journey-phase.js');
  it('reads the wizard answers when the profile columns are empty', () => {
    const line = matchingDetailsLine({}, { gp_onboarding: JSON.stringify({ preferredCity: 'Sydney', whoMoving: 'just_me', targetDate: '2027-06-30', childrenCount: 0 }) });
    expect(line).toContain('preferred city: Sydney');
    expect(line).toContain('who is moving: just me');
    expect(line).toContain('target arrival: 2027-06-30');
    expect(line).not.toContain('children');
  });
  it('prefers profile columns and says so when nothing was given', () => {
    expect(matchingDetailsLine({ preferred_city: 'Perth' }, { gp_onboarding: { preferredCity: 'Sydney' } })).toContain('Perth');
    expect(matchingDetailsLine({}, {})).toContain('none given');
  });
  it('is fed into the summary prompt', () => {
    expect(serverSrc).toContain("prompt += matchingDetailsLine(phaseProf, gpUserState) + '\\n';");
  });
});

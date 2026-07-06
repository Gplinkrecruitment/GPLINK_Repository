import { describe, it, expect } from 'vitest';
import pkg from '../lib/registration-playbook.js';
const { playbookForStage, STAGE_PLAYBOOK } = pkg;

describe('playbookForStage', () => {
  it('returns the AHPRA section for "ahpra"', () => {
    expect(playbookForStage('ahpra').toLowerCase()).toContain('ahpra');
  });
  it('is case-insensitive and trims whitespace', () => {
    expect(playbookForStage('  AHPRA ')).toBe(playbookForStage('ahpra'));
  });
  it('maps the "placement" stage to the same section as "career"', () => {
    expect(playbookForStage('placement')).toBe(playbookForStage('career'));
  });
  it('visa has its own playbook section, distinct from AHPRA', () => {
    const visa = playbookForStage('visa');
    expect(visa.length).toBeGreaterThan(0);
    expect(visa).not.toBe(playbookForStage('ahpra'));
    const t = visa.toLowerCase();
    expect(t).toContain('482');
    expect(t).toContain('sponsor');
    // No medical-registration specifics grounded into visa replies
    expect(t).not.toContain('certified cop');
    expect(t).not.toContain('english language');
  });
  it('returns empty string for an unknown stage (no crash)', () => {
    expect(playbookForStage('nonsense')).toBe('');
    expect(playbookForStage(null)).toBe('');
  });
  it('the career/placement section spells out the practice signing requirements', () => {
    const t = playbookForStage('career').toLowerCase();
    expect(t).toContain('sign');
    expect(t).toContain('supervisor cv');
  });
  it('every section is non-empty and reasonably small (<1200 chars)', () => {
    Object.values(STAGE_PLAYBOOK).forEach((v) => {
      expect(v.length).toBeGreaterThan(0);
      expect(v.length).toBeLessThan(1200);
    });
  });
});

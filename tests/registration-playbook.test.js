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
  it('returns empty string for an unknown stage (no crash)', () => {
    expect(playbookForStage('nonsense')).toBe('');
    expect(playbookForStage(null)).toBe('');
  });
  it('every section is non-empty and reasonably small (<1200 chars)', () => {
    Object.values(STAGE_PLAYBOOK).forEach((v) => {
      expect(v.length).toBeGreaterThan(0);
      expect(v.length).toBeLessThan(1200);
    });
  });
});

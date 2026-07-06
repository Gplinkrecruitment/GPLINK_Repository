import { describe, it, expect } from 'vitest';
import { buildCandidateIntro, formatTargetDate } from '../lib/career-intro.js';

describe('formatTargetDate', () => {
  it('formats YYYY-MM', () => expect(formatTargetDate('2026-11')).toBe('November 2026'));
  it('formats YYYY-MM-DD', () => expect(formatTargetDate('2026-11-15')).toBe('November 2026'));
  it('returns empty for junk', () => {
    expect(formatTargetDate('')).toBe('');
    expect(formatTargetDate('soon')).toBe('');
    expect(formatTargetDate(null)).toBe('');
  });
});

describe('buildCandidateIntro', () => {
  const base = {
    gpName: 'Smith Miller', countryCode: 'uk', accountStatus: '',
    specialty: 'MRCGP — General Practice', targetDate: '2026-11',
    practiceName: 'SOP Medical Centre', roleTitle: 'General Practitioner (VR)'
  };
  it('builds the expedited-pathway paragraph', () => {
    const out = buildCandidateIntro(base);
    expect(out.pathwayLabel).toBe('Expedited Specialist Pathway');
    expect(out.paragraph).toContain('Dr Smith Miller');
    expect(out.paragraph).toContain('United Kingdom');
    expect(out.paragraph).toContain('Expedited Specialist Pathway');
    expect(out.paragraph).toContain('November 2026');
    expect(out.paragraph).not.toContain('RACGP');
  });
  it('uses PEP label for pep_waitlist accounts', () => {
    const out = buildCandidateIntro({ ...base, accountStatus: 'pep_waitlist' });
    expect(out.pathwayLabel).toBe('Practice Experience Program (PEP) pathway');
  });
  it('emits facts chips with flag / pathway / start date', () => {
    const out = buildCandidateIntro(base);
    const labels = out.facts.map((f) => f.label).join(' | ');
    expect(labels).toContain('Trained in the UK');
    expect(labels).toContain('Expedited Specialist Pathway');
    expect(labels).toContain('Nov 2026');
  });
  it('omits the start-date sentence and chip when targetDate missing', () => {
    const out = buildCandidateIntro({ ...base, targetDate: '' });
    expect(out.paragraph).not.toContain('commence');
    expect(out.facts.some((f) => /Available/.test(f.label))).toBe(false);
  });
  it('survives fully-empty input', () => {
    const out = buildCandidateIntro({});
    expect(typeof out.paragraph).toBe('string');
    expect(Array.isArray(out.facts)).toBe(true);
  });
});

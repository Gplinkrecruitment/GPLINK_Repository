import { describe, it, expect } from 'vitest';
import chk from '../lib/ahpra-upload-check.js';

describe('ahpra-upload-check', () => {
  it('prompt includes the requirement fields', () => {
    const p = chk.buildUploadCheckPrompt({ title: 'Signed CV', detail: 'A signed and dated CV in AHPRA format', team_instructions: 'Ask the doctor to upload their CV', sub_items: [] });
    expect(p).toContain('Signed CV');
    expect(p).toContain('signed and dated CV');
  });
  it('parses a clean verdict', () => {
    const r = chk.parseUploadCheck('{"verdict":"match","summary":"A signed, dated CV in the right format."}');
    expect(r.verdict).toBe('match');
    expect(r.summary).toMatch(/signed/i);
  });
  it('coerces an unknown verdict to unclear and is safe on garbage', () => {
    expect(chk.parseUploadCheck('{"verdict":"weird","summary":"x"}').verdict).toBe('unclear');
    expect(chk.parseUploadCheck('not json').verdict).toBe('unclear');
    expect(chk.parseUploadCheck('').summary).toBe('');
  });
  it('maps possible_issue through', () => {
    expect(chk.parseUploadCheck('{"verdict":"possible_issue","summary":"Not signed."}').verdict).toBe('possible_issue');
  });
});

describe('ahpra-upload-check — CV work-history rules', () => {
  const p = chk.buildUploadCheckPrompt({ title: 'Evidence of meeting English language skills registration standard', detail: 'PLAB older than two years; show continuous employment on the CV' });
  it('accepts breaks of 12 months or less without an explanation', () => {
    expect(p).toMatch(/12 months or LESS is acceptable and needs NO explanation/);
    expect(p).toMatch(/LONGER than 12 months needs a written explanation/);
  });
  it('treats listed leave as covered time, not a gap', () => {
    expect(p).toMatch(/maternity/i);
  });
  it('does not treat a job starting before PLAB as an overlap', () => {
    expect(p).toMatch(/started BEFORE an exam, test or registration date[^\n]*PLAB[^\n]*NOT an overlap/);
  });
  it('does not demand an FTE / weekly pattern unless the officer asked', () => {
    expect(p).toMatch(/Do not require the CV to state hours, FTE/);
  });
});

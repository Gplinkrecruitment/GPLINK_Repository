import { describe, it, expect } from 'vitest';
import chk from '../lib/ahpra-upload-check.js';

describe('ahpra-upload-check', () => {
  it('prompt includes the requirement fields', () => {
    const p = chk.buildUploadCheckPrompt({ title: 'Signed CV', detail: 'A signed and dated CV in AHPRA format', team_instructions: 'Ask the doctor to upload their CV', sub_items: [] });
    expect(p).toContain('Signed CV');
    expect(p).toContain('signed and dated CV');
  });
  it('prompt is lenient: it tells the model not to nitpick optional checklist details', () => {
    const p = chk.buildUploadCheckPrompt({ title: 'Curriculum Vitae (CV)', detail: 'CV with dates, responsibilities and full-time/part-time hours', sub_items: [] });
    expect(p).toMatch(/lenient/i);
    expect(p).toMatch(/do NOT flag missing optional details/i);
    expect(p).toMatch(/full-time\/part-time hours/i); // the exact example an officer would not enforce
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

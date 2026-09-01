import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isOnlyAltCvOutstanding } = require('../lib/sppa-completeness-check.js');

// When a returned SPPA-00 is complete + signed and the ONLY outstanding item is an alternate
// supervisor's CV (collected via its own task), the submit gate must not hard-block and the panel
// should reframe it as a reminder. This classifier decides that case.
describe('isOnlyAltCvOutstanding', () => {
  const altDoc = 'Alternate supervisor 1 (Ahmed Mahmoud) signed CV (Q5) — not present in GP Link\'s document inventory';

  it('is true when the only gap is an alternate-supervisor CV', () => {
    expect(isOnlyAltCvOutstanding({
      is_complete: false, missing_fields: [], missing_signatures: [], issues: [],
      missing_documents: [altDoc]
    })).toBe(true);
  });

  it('is true for two alternate-supervisor CVs', () => {
    expect(isOnlyAltCvOutstanding({
      missing_fields: [], missing_signatures: [], issues: [],
      missing_documents: [altDoc, 'Alternate supervisor 2 (Jane Doe) signed CV (Q5)']
    })).toBe(true);
  });

  it('is false when a required field is also missing', () => {
    expect(isOnlyAltCvOutstanding({
      missing_fields: ['Q2 supervisor registration number'], missing_signatures: [], issues: [],
      missing_documents: [altDoc]
    })).toBe(false);
  });

  it('is false when a signature is also missing', () => {
    expect(isOnlyAltCvOutstanding({
      missing_fields: [], missing_signatures: ['Section J unsigned'], issues: [],
      missing_documents: [altDoc]
    })).toBe(false);
  });

  it('is false when there is another issue', () => {
    expect(isOnlyAltCvOutstanding({
      missing_fields: [], missing_signatures: [], issues: ['Q7 answered YES with no details'],
      missing_documents: [altDoc]
    })).toBe(false);
  });

  it('is false when a non-alt document is also missing (e.g. primary supervisor CV)', () => {
    expect(isOnlyAltCvOutstanding({
      missing_fields: [], missing_signatures: [], issues: [],
      missing_documents: [altDoc, 'Primary supervisor CV (Q3) not on file']
    })).toBe(false);
  });

  it('is false when nothing is missing at all', () => {
    expect(isOnlyAltCvOutstanding({
      missing_fields: [], missing_signatures: [], issues: [], missing_documents: []
    })).toBe(false);
  });

  it('is false for null / non-object input', () => {
    expect(isOnlyAltCvOutstanding(null)).toBe(false);
    expect(isOnlyAltCvOutstanding(undefined)).toBe(false);
  });
});

// ── Form identity (owner 2026-08-25, Dr Mercy Obanimoh) ─────────────────────────────────────
// The practice returned its own home-drafted "supervision plan" alongside the real SPPA-00;
// the pipeline must know which document is which, and the completeness verdict must be able to
// say "this is not the SPPA-00 at all".
const { parseCompletenessResponse, parseIdentifyResponse, COMPLETENESS_SYSTEM_PROMPT, IDENTIFY_SYSTEM_PROMPT } = require('../lib/sppa-completeness-check.js');

describe('completeness verdict carries form identity', () => {
  it('parses is_sppa_form and document_identity', () => {
    const v = parseCompletenessResponse(JSON.stringify({
      is_sppa_form: false,
      document_identity: 'A practice-drafted Level 3 supervision plan, not the AHPRA SPPA-00',
      is_complete: false, confidence: 'high',
      missing_fields: [], missing_signatures: [], missing_documents: [], issues: [],
      summary: 'This is not the SPPA-00 form GP Link sent.'
    }));
    expect(v.is_sppa_form).toBe(false);
    expect(v.document_identity).toContain('practice-drafted');
  });

  it('a verdict without the field is null (back-compat), never false', () => {
    const v = parseCompletenessResponse(JSON.stringify({ is_complete: true, confidence: 'high', missing_fields: [], missing_signatures: [], missing_documents: [], issues: [], summary: 'ok' }));
    expect(v.is_sppa_form).toBe(null);
  });

  it('the prompt instructs the identity check', () => {
    expect(COMPLETENESS_SYSTEM_PROMPT).toContain('is_sppa_form');
    expect(COMPLETENESS_SYSTEM_PROMPT).toContain('document_identity');
  });
});

// ── Owner-corrected rules (2026-08-27, Dr Mercy Obanimoh's return) ──────────────────────────
// Four false-positive classes the AI must never raise:
// Q4 template pre-ticks are not an "incomplete alternate entry"; Q8/Q9 are irrelevant with no
// named alternate; a blank Q12 start date is GP Link's job (5 months from the return); Q12
// hours placement never matters; an unticked Q14 is NO (GP Link pre-selects it).
describe('completeness prompt: Mercy false-positive rules', () => {
  it('never flags a blank start date (GP Link auto-fills it)', () => {
    expect(COMPLETENESS_SYSTEM_PROMPT).toContain('NEVER flag a blank,');
    expect(COMPLETENESS_SYSTEM_PROMPT).toContain('5 months after the practice returns the form');
  });

  it('hours placement never matters, only total absence', () => {
    expect(COMPLETENESS_SYSTEM_PROMPT).toContain('NEVER flag the value\'s placement');
    expect(COMPLETENESS_SYSTEM_PROMPT).toContain('40hrs Per Week');
  });

  it('Q8/Q9 are ignored when no alternate supervisor is named at Q4', () => {
    expect(COMPLETENESS_SYSTEM_PROMPT).toContain('IGNORE Q8 and Q9 entirely');
    expect(COMPLETENESS_SYSTEM_PROMPT).toContain('they are NOT always required');
  });

  it('Q4 template pre-ticks with no name are never an inconsistency', () => {
    expect(COMPLETENESS_SYSTEM_PROMPT).toContain('Q4/Q8 inconsistency');
    expect(COMPLETENESS_SYSTEM_PROMPT).toContain('pre-ticked');
  });

  it('an unticked Q14 is treated as NO (GP Link pre-selects it)', () => {
    expect(COMPLETENESS_SYSTEM_PROMPT).toContain('GP Link pre-selects NO on Q14');
    expect(COMPLETENESS_SYSTEM_PROMPT).toContain('unmistakably ticked YES');
  });

  it('the AI observes the start-date box state (drives the scan stamp), never flags it', () => {
    expect(COMPLETENESS_SYSTEM_PROMPT).toContain('q12_start_date_observed');
    expect(COMPLETENESS_SYSTEM_PROMPT).toContain('neutral OBSERVATION');
  });

  it('q12_start_date_observed parses, defaulting to unclear', () => {
    const base = { is_complete: true, confidence: 'high', missing_fields: [], missing_signatures: [], missing_documents: [], issues: [], summary: 'ok' };
    expect(parseCompletenessResponse(JSON.stringify({ ...base, q12_start_date_observed: 'blank' })).q12_start_date_observed).toBe('blank');
    expect(parseCompletenessResponse(JSON.stringify({ ...base, q12_start_date_observed: 'filled' })).q12_start_date_observed).toBe('filled');
    expect(parseCompletenessResponse(JSON.stringify({ ...base, q12_start_date_observed: 'maybe' })).q12_start_date_observed).toBe('unclear');
    expect(parseCompletenessResponse(JSON.stringify(base)).q12_start_date_observed).toBe('unclear');
  });
});

// ── Q7 conflict cross-check (owner 2026-09-01, Dr Mercy Obanimoh) ───────────────────────────
// The conflict scan had already found the supervisor IS the practice owner (is_conflict=true),
// yet the practice's returned scan showed Q7 crossed NO (their printed copy had lost the
// pre-filled YES + details) and the completeness check reported "ready to submit". The AI now
// reports a neutral q7_observed and deterministic server code compares it against is_conflict.
const { q7ConflictMismatchIssue } = require('../lib/sppa-completeness-check.js');

describe('Q7 conflict cross-check', () => {
  const base = { is_complete: true, confidence: 'high', missing_fields: [], missing_signatures: [], missing_documents: [], issues: [], summary: 'ok' };

  it('the prompt asks for the neutral q7_observed observation', () => {
    expect(COMPLETENESS_SYSTEM_PROMPT).toContain('"q7_observed": "yes" | "no" | "blank" | "unclear"');
    expect(COMPLETENESS_SYSTEM_PROMPT).toContain('q7_observed is likewise a neutral OBSERVATION');
  });

  it('q7_observed parses, defaulting to unclear', () => {
    expect(parseCompletenessResponse(JSON.stringify({ ...base, q7_observed: 'yes' })).q7_observed).toBe('yes');
    expect(parseCompletenessResponse(JSON.stringify({ ...base, q7_observed: 'no' })).q7_observed).toBe('no');
    expect(parseCompletenessResponse(JSON.stringify({ ...base, q7_observed: 'blank' })).q7_observed).toBe('blank');
    expect(parseCompletenessResponse(JSON.stringify({ ...base, q7_observed: 'maybe' })).q7_observed).toBe('unclear');
    expect(parseCompletenessResponse(JSON.stringify(base)).q7_observed).toBe('unclear');
  });

  it('flags a NO or blank Q7 when the conflict scan said the supervisor is the owner', () => {
    expect(q7ConflictMismatchIssue(true, 'no')).toMatch(/marked NO/);
    expect(q7ConflictMismatchIssue(true, 'no')).toMatch(/practice\s+owner/);
    expect(q7ConflictMismatchIssue(true, 'blank')).toMatch(/unanswered/);
  });

  it('never flags when there is no conflict, no verdict, or Q7 already reads YES', () => {
    expect(q7ConflictMismatchIssue(true, 'yes')).toBe(null);
    expect(q7ConflictMismatchIssue(true, 'unclear')).toBe(null); // a bad scan is not a contradiction
    expect(q7ConflictMismatchIssue(false, 'no')).toBe(null);
    expect(q7ConflictMismatchIssue(undefined, 'no')).toBe(null); // legacy tasks with no scan verdict
    expect(q7ConflictMismatchIssue('true', 'no')).toBe(null);    // only strict true arms it
  });

  it('server wires the cross-check into the completeness verdict', () => {
    const fs = require('fs');
    const { fileURLToPath } = require('url');
    const server = fs.readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');
    expect(server).toContain('q7ConflictMismatchIssue(meta.is_conflict, verdict.q7_observed)');
    expect(server).toContain('q7_conflict_mismatch: !!_q7Issue');
    // the mismatch must force is_complete=false before the verdict is stored
    const idx = server.indexOf('q7ConflictMismatchIssue(meta.is_conflict');
    const after = server.slice(idx, idx + 900);
    expect(after).toContain('verdict.is_complete = false');
  });
});

describe('parseIdentifyResponse', () => {
  it('maps verdicts back by position', () => {
    const out = parseIdentifyResponse(JSON.stringify({
      documents: [
        { position: 1, is_sppa_form: false, is_cv: false, looks_like: 'Practice-drafted supervision plan', confidence: 'high' },
        { position: 2, is_sppa_form: true, is_cv: false, looks_like: 'AHPRA SPPA-00 supervised practice plan', confidence: 'high' },
      ]
    }), 2);
    expect(out[0].is_sppa_form).toBe(false);
    expect(out[1].is_sppa_form).toBe(true);
    expect(out[1].position).toBe(2);
  });

  it('unparseable output yields null verdicts (fail open, never a false)', () => {
    const out = parseIdentifyResponse('nonsense', 2);
    expect(out).toHaveLength(2);
    expect(out[0].is_sppa_form).toBe(null);
    expect(out[1].is_sppa_form).toBe(null);
    expect(out[0].confidence).toBe('low');
  });

  it('an out-of-range position is ignored', () => {
    const out = parseIdentifyResponse(JSON.stringify({ documents: [{ position: 5, is_sppa_form: true }] }), 2);
    expect(out[0].is_sppa_form).toBe(null);
    expect(out[1].is_sppa_form).toBe(null);
  });

  it('the identify prompt describes the SPPA-00 and the home-drafted trap', () => {
    expect(IDENTIFY_SYSTEM_PROMPT).toContain('SPPA-00');
    expect(IDENTIFY_SYSTEM_PROMPT).toContain('drafted');
  });
});

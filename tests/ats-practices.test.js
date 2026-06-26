import { describe, it, expect } from 'vitest';
import * as M from '../lib/ats-practices.js';

describe('normalizePracticeName', () => {
  it('collapses whitespace, lowercases, and strips trailing dots/commas', () => {
    expect(M.normalizePracticeName('  Bondi   Medical  Centre  ')).toBe('bondi medical centre');
    expect(M.normalizePracticeName('Bondi Medical Centre.')).toBe('bondi medical centre');
    expect(M.normalizePracticeName('Bondi Medical Centre,,')).toBe('bondi medical centre');
    expect(M.normalizePracticeName('Bondi Medical Centre., ')).toBe('bondi medical centre');
    expect(M.normalizePracticeName('BONDI\tMedical\nCentre')).toBe('bondi medical centre');
  });

  it('returns empty string for falsy input', () => {
    expect(M.normalizePracticeName('')).toBe('');
    expect(M.normalizePracticeName(null)).toBe('');
    expect(M.normalizePracticeName(undefined)).toBe('');
  });
});

describe('dedupePracticeNames', () => {
  it('merges case-insensitively, keeps the first spelling, drops empties, sorts by display', () => {
    const out = M.dedupePracticeNames([
      'Bondi Medical Centre',
      'bondi medical centre.',
      '  BONDI   MEDICAL   CENTRE ',
      'Apollo Clinic',
      '',
      null,
      '   ',
      'apollo clinic'
    ]);
    expect(out).toEqual([
      { key: 'apollo clinic', display: 'Apollo Clinic' },
      { key: 'bondi medical centre', display: 'Bondi Medical Centre' }
    ]);
  });

  it('returns [] for empty/missing input', () => {
    expect(M.dedupePracticeNames([])).toEqual([]);
    expect(M.dedupePracticeNames(null)).toEqual([]);
  });
});

describe('deriveAtsStage truth table', () => {
  it("status hired => 'hired'", () => {
    expect(M.deriveAtsStage({ status: 'hired' }, false)).toBe('hired');
  });
  it("status placement_secured => 'hired'", () => {
    expect(M.deriveAtsStage({ status: 'placement_secured' }, false)).toBe('hired');
  });
  it("status offer_accepted => 'hired'", () => {
    expect(M.deriveAtsStage({ status: 'offer_accepted' }, false)).toBe('hired');
  });
  it("status contract_signed => 'hired'", () => {
    expect(M.deriveAtsStage({ status: 'contract_signed' }, false)).toBe('hired');
  });
  it("status rejected => 'not_proceeding'", () => {
    expect(M.deriveAtsStage({ status: 'rejected' }, false)).toBe('not_proceeding');
  });
  it("status withdrawn => 'not_proceeding'", () => {
    expect(M.deriveAtsStage({ status: 'withdrawn' }, false)).toBe('not_proceeding');
  });
  it("status offer => 'offer'", () => {
    expect(M.deriveAtsStage({ status: 'offer' }, false)).toBe('offer');
  });
  it("status offered => 'offer'", () => {
    expect(M.deriveAtsStage({ status: 'offered' }, false)).toBe('offer');
  });
  it("practice_submission_status client_approved => 'offer'", () => {
    expect(M.deriveAtsStage({ status: 'whatever', practice_submission_status: 'client_approved' }, false)).toBe('offer');
  });
  it("status interview_scheduled => 'interview'", () => {
    expect(M.deriveAtsStage({ status: 'interview_scheduled' }, false)).toBe('interview');
  });
  it("status interviewing => 'interview'", () => {
    expect(M.deriveAtsStage({ status: 'interviewing' }, false)).toBe('interview');
  });
  it("hasInterview === true promotes to 'interview'", () => {
    expect(M.deriveAtsStage({ status: 'applied' }, true)).toBe('interview');
  });
  it("practice_submission_status interview_ready => 'interview'", () => {
    expect(M.deriveAtsStage({ status: 'applied', practice_submission_status: 'interview_ready' }, false)).toBe('interview');
  });
  it("practice_submission_status client_reviewed => 'reviewing'", () => {
    expect(M.deriveAtsStage({ status: 'applied', practice_submission_status: 'client_reviewed' }, false)).toBe('reviewing');
  });
  it("status submitted_to_practice => 'submitted'", () => {
    expect(M.deriveAtsStage({ status: 'submitted_to_practice' }, false)).toBe('submitted');
  });
  it("practice_submission_status submitted_to_practice => 'submitted'", () => {
    expect(M.deriveAtsStage({ status: 'applied', practice_submission_status: 'submitted_to_practice' }, false)).toBe('submitted');
  });
  it("anything else => 'applied'", () => {
    expect(M.deriveAtsStage({ status: 'applied' }, false)).toBe('applied');
    expect(M.deriveAtsStage({ status: 'new' }, false)).toBe('applied');
  });

  it('normalizes case/whitespace and is null-safe', () => {
    expect(M.deriveAtsStage({ status: '  HIRED  ' }, false)).toBe('hired');
    expect(M.deriveAtsStage({ status: 'Offer' }, false)).toBe('offer');
    expect(M.deriveAtsStage({ status: null, practice_submission_status: null }, false)).toBe('applied');
    expect(M.deriveAtsStage(null, false)).toBe('applied');
    expect(M.deriveAtsStage(undefined)).toBe('applied');
  });
});

describe('bestAtsStage', () => {
  it('picks the furthest non-not_proceeding stage by rank', () => {
    expect(M.bestAtsStage([
      { ats_stage: 'applied' },
      { ats_stage: 'interview' },
      { ats_stage: 'submitted' }
    ])).toBe('interview');
    expect(M.bestAtsStage([
      { ats_stage: 'offer' },
      { ats_stage: 'hired' }
    ])).toBe('hired');
  });

  it('ignores not_proceeding when ranking', () => {
    expect(M.bestAtsStage([
      { ats_stage: 'not_proceeding' },
      { ats_stage: 'applied' }
    ])).toBe('applied');
    // not_proceeding alone yields null
    expect(M.bestAtsStage([{ ats_stage: 'not_proceeding' }])).toBe(null);
  });

  it('returns null when empty/missing or no valid stages', () => {
    expect(M.bestAtsStage([])).toBe(null);
    expect(M.bestAtsStage(null)).toBe(null);
    expect(M.bestAtsStage([{ ats_stage: null }, { ats_stage: 'bogus' }])).toBe(null);
  });
});

describe('ats-practices API surface', () => {
  it('exports every function the backfill + pipeline call', () => {
    ['normalizePracticeName', 'dedupePracticeNames', 'deriveAtsStage', 'bestAtsStage'].forEach((name) => {
      expect(typeof M[name], name).toBe('function');
    });
  });
  it('exports the shared constants', () => {
    expect(M.ATS_STAGES).toEqual(['applied', 'submitted', 'reviewing', 'interview', 'offer', 'hired']);
    expect(M.ATS_REJECT_STAGE).toBe('not_proceeding');
    expect(M.ATS_STAGE_LABELS).toEqual({
      applied: 'Applied',
      submitted: 'Submitted to Practice',
      reviewing: 'Practice Reviewing',
      interview: 'Interview',
      offer: 'Offer',
      hired: 'Hired',
      not_proceeding: 'Not Proceeding'
    });
  });
});

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
  // F13 (audit 2026-07-20): 'secured'/'placed' are in SECURED_STATUS_KEYS
  // (lib/ceo-metrics.js) — deriveAtsStage must agree or the kanban parks a
  // secured GP in 'applied'.
  it("status secured => 'hired' (F13)", () => {
    expect(M.deriveAtsStage({ status: 'secured' }, false)).toBe('hired');
  });
  it("status placed => 'hired' (F13)", () => {
    expect(M.deriveAtsStage({ status: 'placed' }, false)).toBe('hired');
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
  // Task 15: 'interview_completed' (Task 9's post-interview status) must still
  // bucket into the 'interview' kanban lane — the interview isn't over from a
  // pipeline standpoint until the practice decides, so it must not fall back
  // to 'applied'.
  it("status interview_completed => 'interview'", () => {
    expect(M.deriveAtsStage({ status: 'interview_completed' }, false)).toBe('interview');
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

describe('pipeline buckets', () => {
  it('PIPELINE_BUCKETS lists the 8 buckets in order, each with a label', () => {
    expect(M.PIPELINE_BUCKETS).toEqual([
      'unassociated', 'shortlisted', 'applied', 'submitted', 'reviewing', 'interview', 'offer', 'hired'
    ]);
    M.PIPELINE_BUCKETS.forEach((key) => {
      expect(typeof M.PIPELINE_BUCKET_LABELS[key], key).toBe('string');
      expect(M.PIPELINE_BUCKET_LABELS[key].length).toBeGreaterThan(0);
    });
  });

  // Owner rule: no GP should ever land in a "Not proceeding" segment on the
  // GP-level pipeline. A GP with only terminal (not_proceeding) applications
  // reverts to 'unassociated' (back in the pool) instead of a dead-end bucket.
  it("does not list 'not_proceeding' as a pipeline bucket", () => {
    expect(M.PIPELINE_BUCKETS).not.toContain('not_proceeding');
  });

  it("treats empty / missing apps as 'unassociated'", () => {
    expect(M.bucketForApps([])).toBe('unassociated');
    expect(M.bucketForApps(undefined)).toBe('unassociated');
  });

  it("buckets a single not_proceeding app as 'unassociated' (terminal-only GPs go back to the pool)", () => {
    expect(M.bucketForApps([{ ats_stage: 'not_proceeding' }])).toBe('unassociated');
  });

  it('terminal-only GPs land in unassociated regardless of extra fields on the row', () => {
    expect(M.bucketForApps([{ status: 'rejected', ats_stage: 'not_proceeding' }])).toBe('unassociated');
  });

  it('uses the furthest active stage when several apps exist', () => {
    expect(M.bucketForApps([{ ats_stage: 'applied' }, { ats_stage: 'interview' }])).toBe('interview');
    expect(M.bucketForApps([{ ats_stage: 'hired' }, { ats_stage: 'offer' }])).toBe('hired');
  });

  it('ignores not_proceeding when an active app exists', () => {
    expect(M.bucketForApps([{ ats_stage: 'not_proceeding' }, { ats_stage: 'applied' }])).toBe('applied');
  });

  it("sends a candidate whose ONLY app was filled by someone else back to the pool (unassociated), not 'not_proceeding'", () => {
    expect(M.bucketForApps([{ ats_stage: 'not_proceeding', match_outcome: 'position_filled' }])).toBe('unassociated');
  });

  it('a genuine rejection (no position_filled outcome) ALSO reverts to unassociated — the not_proceeding bucket no longer exists at GP level', () => {
    expect(M.bucketForApps([{ ats_stage: 'not_proceeding' }])).toBe('unassociated');
    expect(M.bucketForApps([{ ats_stage: 'not_proceeding', match_outcome: 'gp_withdrew' }])).toBe('unassociated');
  });

  it('multiple terminal-only apps (all not_proceeding, mixed outcomes) still resolve to unassociated', () => {
    expect(M.bucketForApps([
      { ats_stage: 'not_proceeding', match_outcome: 'gp_withdrew' },
      { ats_stage: 'not_proceeding', match_outcome: 'position_filled' },
      { ats_stage: 'not_proceeding' }
    ])).toBe('unassociated');
  });

  it('a position-filled app is ignored, so another active app decides the bucket', () => {
    expect(M.bucketForApps([{ ats_stage: 'not_proceeding', match_outcome: 'position_filled' }, { ats_stage: 'interview' }])).toBe('interview');
  });
});

describe('hasFreshApply', () => {
  const NOW = '2026-07-19T13:00:00.000Z';
  const SINCE = '2026-07-12T13:00:00.000Z'; // 7 days before NOW

  it('is true when an app is applied within the window', () => {
    expect(M.hasFreshApply([{ ats_stage: 'applied', applied_at: NOW }], SINCE)).toBe(true);
  });

  it('treats an empty/missing stage as applied (mirrors the insert default)', () => {
    expect(M.hasFreshApply([{ applied_at: NOW }], SINCE)).toBe(true);
    expect(M.hasFreshApply([{ ats_stage: '', applied_at: NOW }], SINCE)).toBe(true);
  });

  it('is false for an applied app older than the window', () => {
    expect(M.hasFreshApply([{ ats_stage: 'applied', applied_at: '2026-07-01T00:00:00.000Z' }], SINCE)).toBe(false);
  });

  it('is false when the only app has advanced past applied', () => {
    expect(M.hasFreshApply([{ ats_stage: 'interview', applied_at: NOW }], SINCE)).toBe(false);
  });

  it('is TRUE for a GP whose furthest app is advanced but who ALSO has a fresh applied app (the Helen Wazalski case)', () => {
    const apps = [
      { ats_stage: 'interview', applied_at: '2026-07-08T00:00:00.000Z' }, // advanced, on another role
      { ats_stage: 'applied', applied_at: NOW } // brand-new application to a different practice
    ];
    expect(M.bucketForApps(apps)).toBe('interview'); // furthest-stage bucket HIDES the fresh apply
    expect(M.hasFreshApply(apps, SINCE)).toBe(true); // ...but the fresh-apply filter still surfaces her
  });

  it('handles empty / missing input', () => {
    expect(M.hasFreshApply([], SINCE)).toBe(false);
    expect(M.hasFreshApply(undefined, SINCE)).toBe(false);
  });
});

describe('ats-practices API surface', () => {
  it('exports every function the backfill + pipeline call', () => {
    ['normalizePracticeName', 'dedupePracticeNames', 'deriveAtsStage', 'bestAtsStage'].forEach((name) => {
      expect(typeof M[name], name).toBe('function');
    });
  });
  it('exports the shared constants', () => {
    expect(M.ATS_STAGES).toEqual(['shortlisted', 'applied', 'submitted', 'reviewing', 'interview', 'offer', 'hired']);
    expect(M.ATS_REJECT_STAGE).toBe('not_proceeding');
    expect(M.ATS_STAGE_LABELS).toEqual({
      shortlisted: 'Shortlist',
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

// Secondary practice contacts (owner spec 2026-08-05): extra people at a
// practice who are CC'd on the candidate introduction only. The normalizer is
// the single gate between free-text admin input / legacy rows and a real CC
// line on an email that goes to a client, so it is deliberately strict.
describe('normalizeSecondaryContacts', () => {
  it('keeps valid contacts, lowercasing the address and trimming the name', () => {
    expect(M.normalizeSecondaryContacts([
      { name: '  Bob Nurse ', email: '  Bob@Practice.com.au ' }
    ])).toEqual([{ name: 'Bob Nurse', email: 'bob@practice.com.au' }]);
  });

  it('accepts bare email strings as well as objects', () => {
    expect(M.normalizeSecondaryContacts(['a@b.com', { email: 'c@d.com', name: 'C' }]))
      .toEqual([{ name: '', email: 'a@b.com' }, { name: 'C', email: 'c@d.com' }]);
  });

  it('drops anything that is not a usable address', () => {
    expect(M.normalizeSecondaryContacts([
      { email: 'no-at-sign' }, { email: 'no@tld' }, { email: '' }, { email: null },
      { email: 'has space@x.com' }, { email: 'trailing@comma.com,' }, { name: 'nameless' }, null, 42
    ])).toEqual([]);
  });

  it('de-duplicates case-insensitively, keeping the first name given', () => {
    expect(M.normalizeSecondaryContacts([
      { name: 'First', email: 'dup@x.com' },
      { name: 'Second', email: 'DUP@x.com' }
    ])).toEqual([{ name: 'First', email: 'dup@x.com' }]);
  });

  it('excludes the primary contact so the To can never also be a CC', () => {
    expect(M.normalizeSecondaryContacts(
      [{ email: 'anna@x.com' }, { email: 'bob@x.com' }],
      'ANNA@X.com'
    )).toEqual([{ name: '', email: 'bob@x.com' }]);
  });

  it('caps the list so one practice can never fan an email out endlessly', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ email: `p${i}@x.com` }));
    expect(M.normalizeSecondaryContacts(many)).toHaveLength(M.MAX_SECONDARY_CONTACTS);
  });

  it('parses a JSON string (jsonb column read back as text) and splits a plain list', () => {
    expect(M.normalizeSecondaryContacts('[{"email":"a@b.com","name":"A"}]'))
      .toEqual([{ name: 'A', email: 'a@b.com' }]);
    expect(M.normalizeSecondaryContacts('a@b.com, c@d.com'))
      .toEqual([{ name: '', email: 'a@b.com' }, { name: '', email: 'c@d.com' }]);
  });

  it('normalizes junk to an empty list instead of throwing', () => {
    // A malformed row must never break a practice save or an introduction email.
    expect(M.normalizeSecondaryContacts(null)).toEqual([]);
    expect(M.normalizeSecondaryContacts(undefined)).toEqual([]);
    expect(M.normalizeSecondaryContacts({})).toEqual([]);
    expect(M.normalizeSecondaryContacts('not json at all')).toEqual([]);
    expect(M.normalizeSecondaryContacts('')).toEqual([]);
  });
});

describe('secondaryContactEmails', () => {
  it('returns just the addresses, ready for sendEmail cc', () => {
    expect(M.secondaryContactEmails([{ email: 'A@b.com' }, { email: 'c@d.com' }], 'c@d.com'))
      .toEqual(['a@b.com']);
  });

  it('returns an empty array (never null) for an empty practice', () => {
    expect(M.secondaryContactEmails(null)).toEqual([]);
  });
});

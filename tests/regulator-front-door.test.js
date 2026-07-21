// Phase 6 I1, wider regulator front door (lib/email-triage.js).
//
// The AHPRA 6-mode classifier stays gated to @ahpra.gov.au (isAhpraEmail /
// isAhpraSender in server.js). The NEW allowlist (isRegulatorEmail /
// matchRegulatorDomain) only widens the GENERIC triage path so mail from other
// Australian medical regulators / colleges (AMC, RACGP, ACRRM, Medical Board)
// is routed as regulator correspondence instead of collapsing into the
// one-bucket email_triage default, without misclassifying random mail.
import { describe, it, expect } from 'vitest';
import {
  isAhpraEmail,
  isRegulatorEmail,
  matchRegulatorDomain,
  resolveEmailRouting,
  REGULATOR_DOMAIN_STAGES
} from '../lib/email-triage.js';

describe('regulator front door, allowlist recognition', () => {
  it('recognises AMC, RACGP, ACRRM and Medical Board senders as regulators', () => {
    expect(isRegulatorEmail('assessments@amc.org.au')).toBe(true);
    expect(isRegulatorEmail('"RACGP Assessments" <pep@racgp.org.au>')).toBe(true);
    expect(isRegulatorEmail('fellowship@acrrm.org.au')).toBe(true);
    expect(isRegulatorEmail('notifications@medicalboard.gov.au')).toBe(true);
  });

  it('recognises subdomain senders of allowlisted domains', () => {
    expect(isRegulatorEmail('noreply@mail.amc.org.au')).toBe(true);
    expect(isRegulatorEmail('do-not-reply@notifications.racgp.org.au')).toBe(true);
  });

  it('does NOT classify random / lookalike senders as regulators', () => {
    expect(isRegulatorEmail('randomperson@gmail.com')).toBe(false);
    expect(isRegulatorEmail('practice.manager@sunshinemedical.com.au')).toBe(false);
    // Lookalike suffixes must not match (endsWith-style spoofing).
    expect(isRegulatorEmail('spoof@amc.org.au.evil.com')).toBe(false);
    expect(isRegulatorEmail('x@fakeamc.org.au')).toBe(false);
    expect(isRegulatorEmail('x@notracgp.org.au')).toBe(false);
    expect(isRegulatorEmail('')).toBe(false);
    expect(isRegulatorEmail(null)).toBe(false);
  });

  it('maps each regulator domain to the right stage group', () => {
    expect(matchRegulatorDomain('a@amc.org.au')).toEqual({ domain: 'amc.org.au', stage: 'amc' });
    expect(matchRegulatorDomain('a@racgp.org.au').stage).toBe('amc');
    expect(matchRegulatorDomain('a@acrrm.org.au').stage).toBe('amc');
    expect(matchRegulatorDomain('a@medicalboard.gov.au').stage).toBe('ahpra');
    expect(matchRegulatorDomain('a@ahpra.gov.au').stage).toBe('ahpra');
    expect(matchRegulatorDomain('a@gmail.com')).toBeNull();
  });

  it('the allowlist is documented and conservative (exact known domains only)', () => {
    expect(Object.keys(REGULATOR_DOMAIN_STAGES).sort()).toEqual([
      'acrrm.org.au', 'ahpra.gov.au', 'amc.org.au', 'medicalboard.gov.au', 'racgp.org.au'
    ]);
  });
});

describe('regulator front door, AHPRA 6-mode gate unchanged', () => {
  it('isAhpraEmail still matches ONLY @ahpra.gov.au (the 6-mode gate)', () => {
    expect(isAhpraEmail('officer@ahpra.gov.au')).toBe(true);
    // Widened regulator domains must NOT enter the AHPRA 6-mode path.
    expect(isAhpraEmail('assessments@amc.org.au')).toBe(false);
    expect(isAhpraEmail('pep@racgp.org.au')).toBe(false);
    expect(isAhpraEmail('notifications@medicalboard.gov.au')).toBe(false);
    expect(isAhpraEmail('random@gmail.com')).toBe(false);
  });
});

describe('regulator front door, generic routing outcome', () => {
  it('a case-matched AMC email routes as high-priority regulator correspondence on the amc stage', () => {
    const r = resolveEmailRouting({
      sender: 'AMC Assessments <assessments@amc.org.au>',
      subject: 'Primary source verification outcome',
      bodySnippet: 'Your EPIC verification is complete.',
      category: 'other', urgency: 'normal',
      matched: true, gpStage: 'myintealth', senderIsGp: false
    });
    expect(r.regulator).toBe(true);
    expect(r.category).toBe('regulator');
    expect(r.related_stage).toBe('amc');
    expect(r.priority).toBe('high');
  });

  it('a Medical Board email routes to the ahpra stage group', () => {
    const r = resolveEmailRouting({
      sender: 'notifications@medicalboard.gov.au',
      subject: 'Registration standard update', bodySnippet: '',
      category: 'other', urgency: 'normal',
      matched: true, gpStage: 'amc', senderIsGp: false
    });
    expect(r.related_stage).toBe('ahpra');
    expect(r.category).toBe('regulator');
  });

  it('an UNMATCHED regulator email stays a low-priority Support task (nothing dropped)', () => {
    const r = resolveEmailRouting({
      sender: 'pep@racgp.org.au', subject: 'PEP query', bodySnippet: '',
      category: 'other', urgency: 'normal', matched: false
    });
    expect(r.priority).toBe('low');
    expect(r.regulator).toBe(true);
    expect(r.related_stage).toBe('amc'); // stage tag kept for the Support row
  });

  it('a random gmail sender is NOT routed as regulator correspondence', () => {
    const r = resolveEmailRouting({
      sender: 'randomperson@gmail.com', subject: 'hello', bodySnippet: 'just a question',
      category: 'other', urgency: 'normal', matched: true, gpStage: 'visa', senderIsGp: true
    });
    expect(r.regulator).toBe(false);
    expect(r.category).not.toBe('regulator');
    expect(r.related_stage).toBe('visa'); // GP-sent mail keeps the GP's stage
  });
});

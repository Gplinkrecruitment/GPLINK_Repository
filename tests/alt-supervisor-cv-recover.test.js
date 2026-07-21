import { describe, it, expect } from 'vitest';
import {
  bareEmail,
  isAlwaysTrustedSender,
  shouldSuppressUnmatched,
  selectAltCvReplyCandidates,
  interpretAltCvMatch,
  summarizeAltCvMatch
} from '../lib/alt-supervisor-cv-recover.js';

describe('bareEmail', function () {
  it('extracts the bare address from a display-name sender', function () {
    expect(bareEmail('Khaleed Mahmoud <khaleedmahmoud1211@gmail.com>')).toBe('khaleedmahmoud1211@gmail.com');
  });
  it('lowercases and handles a plain address', function () {
    expect(bareEmail('Foo@Example.COM')).toBe('foo@example.com');
  });
  it('returns empty string for junk', function () {
    expect(bareEmail('')).toBe('');
    expect(bareEmail(null)).toBe('');
    expect(bareEmail('no address here')).toBe('');
  });
});

describe('isAlwaysTrustedSender', function () {
  it('trusts @ahpra.gov.au by default', function () {
    expect(isAlwaysTrustedSender('Kiran.George@ahpra.gov.au')).toBe(true);
    expect(isAlwaysTrustedSender('officer@notification.ahpra.gov.au')).toBe(true);
  });
  it('does not trust other domains by default', function () {
    expect(isAlwaysTrustedSender('someone@gmail.com')).toBe(false);
    expect(isAlwaysTrustedSender('x@evil-ahpra.gov.au.attacker.com')).toBe(false);
  });
  it('honours a custom trusted-domain list', function () {
    expect(isAlwaysTrustedSender('a@medboard.gov.au', ['medboard.gov.au'])).toBe(true);
    expect(isAlwaysTrustedSender('a@ahpra.gov.au', ['medboard.gov.au'])).toBe(false);
  });
});

describe('shouldSuppressUnmatched (the moved triage gate, regression guard)', function () {
  const allow = new Set(['smithmiller1234@gmail.com', 'khaleedmahmoud1211@gmail.com']);

  it('suppresses an unmatched, non-allowlisted, non-trusted sender', function () {
    expect(shouldSuppressUnmatched({ allowSet: allow, fromAddr: 'random@spam.com',
      earlyResponseMatched: false, altCvMatched: false, hasKnownCase: false })).toBe(true);
  });
  it('NEVER suppresses when the allow-list is empty (full production "*")', function () {
    expect(shouldSuppressUnmatched({ allowSet: new Set(), fromAddr: 'random@spam.com',
      earlyResponseMatched: false, altCvMatched: false, hasKnownCase: false })).toBe(false);
  });
  it('NEVER suppresses an allow-listed sender', function () {
    expect(shouldSuppressUnmatched({ allowSet: allow, fromAddr: 'khaleedmahmoud1211@gmail.com',
      earlyResponseMatched: false, altCvMatched: false, hasKnownCase: false })).toBe(false);
  });
  it('NEVER suppresses a reply that matched a tracked task (earlyResponseMatched)', function () {
    expect(shouldSuppressUnmatched({ allowSet: allow, fromAddr: 'practice@realclinic.com.au',
      earlyResponseMatched: true, altCvMatched: false, hasKnownCase: false })).toBe(false);
  });
  it('NEVER suppresses a matched alt-CV', function () {
    expect(shouldSuppressUnmatched({ allowSet: allow, fromAddr: 'practice@realclinic.com.au',
      earlyResponseMatched: false, altCvMatched: true, hasKnownCase: false })).toBe(false);
  });
  it('NEVER suppresses a sender that resolved to a known GP case', function () {
    expect(shouldSuppressUnmatched({ allowSet: allow, fromAddr: 'practice@realclinic.com.au',
      earlyResponseMatched: false, altCvMatched: false, hasKnownCase: true })).toBe(false);
  });
  it('NEVER suppresses an always-trusted AHPRA sender even when unmatched', function () {
    expect(shouldSuppressUnmatched({ allowSet: allow, fromAddr: 'Kiran.George@ahpra.gov.au',
      earlyResponseMatched: false, altCvMatched: false, hasKnownCase: false })).toBe(false);
  });
});

describe('selectAltCvReplyCandidates', function () {
  const expectedSender = 'khaleedmahmoud1211@gmail.com';
  function meta(over) {
    return Object.assign({ messageId: 'm1', sender: 'Khaleed <khaleedmahmoud1211@gmail.com>',
      attachments: [{ filename: 'cv.pdf' }], internalDate: '1000' }, over);
  }

  it('drops messages whose sender is not the expected practice sender', function () {
    const out = selectAltCvReplyCandidates([meta({ messageId: 'a', sender: 'other@x.com' })], { expectedSender });
    expect(out).toHaveLength(0);
  });
  it('drops messages with no attachments', function () {
    const out = selectAltCvReplyCandidates([meta({ messageId: 'a', attachments: [] })], { expectedSender });
    expect(out).toHaveLength(0);
  });
  it('drops already-ingested messages (idempotency / excludes the SPPA form already filed)', function () {
    const out = selectAltCvReplyCandidates(
      [meta({ messageId: 'sppa-form' }), meta({ messageId: 'fresh-cv' })],
      { expectedSender, attachedIds: ['sppa-form'] });
    expect(out.map(function (m) { return m.messageId; })).toEqual(['fresh-cv']);
  });
  it('returns newest-first by internalDate', function () {
    const out = selectAltCvReplyCandidates(
      [meta({ messageId: 'old', internalDate: '1000' }), meta({ messageId: 'new', internalDate: '5000' })],
      { expectedSender });
    expect(out.map(function (m) { return m.messageId; })).toEqual(['new', 'old']);
  });
  it('with no expectedSender accepts any in-thread message that has an attachment', function () {
    const out = selectAltCvReplyCandidates([meta({ messageId: 'a', sender: 'anyone@x.com' })], { expectedSender: '' });
    expect(out).toHaveLength(1);
  });
  it('a re-run after delivery (messageId now in attachedIds) yields zero candidates', function () {
    const msgs = [meta({ messageId: 'cv1' })];
    expect(selectAltCvReplyCandidates(msgs, { expectedSender })).toHaveLength(1);
    expect(selectAltCvReplyCandidates(msgs, { expectedSender, attachedIds: ['cv1'] })).toHaveLength(0);
  });
});

describe('interpretAltCvMatch (is_cv gate, stops the SPPA form being delivered as the CV)', function () {
  it('matches a genuine CV with a confident name match', function () {
    const r = interpretAltCvMatch({ is_cv: true, cv_name: 'Ahmed Mahmoud', matched_supervisor: 'Ahmed Mahmoud', confidence: 0.95 });
    expect(r.matched).toBe(true);
    expect(r.matchedSupervisor).toBe('Ahmed Mahmoud');
  });
  it('REJECTS a non-CV document (SPPA form/contract) even if it names the supervisor', function () {
    const r = interpretAltCvMatch({ is_cv: false, cv_name: 'Ahmed Mahmoud', matched_supervisor: 'Ahmed Mahmoud', confidence: 0.99 });
    expect(r.matched).toBe(false);
    expect(r.isCv).toBe(false);
  });
  it('rejects a low-confidence match', function () {
    expect(interpretAltCvMatch({ is_cv: true, matched_supervisor: 'Ahmed Mahmoud', confidence: 0.3 }).matched).toBe(false);
  });
  it('rejects when no supervisor matched', function () {
    expect(interpretAltCvMatch({ is_cv: true, matched_supervisor: null, confidence: 0.9 }).matched).toBe(false);
  });
  it('treats a missing is_cv as not a CV (fail-closed)', function () {
    expect(interpretAltCvMatch({ matched_supervisor: 'X', confidence: 0.9 }).matched).toBe(false);
  });
});

describe('summarizeAltCvMatch', function () {
  it('collects matched CVs', function () {
    const s = summarizeAltCvMatch([{ matched: true, matchedSupervisor: 'A' }, { matched: false }]);
    expect(s.matchedCvs).toHaveLength(1);
    expect(s.foundAttachmentButNoMatch).toBe(false);
  });
  it('flags found-attachment-but-no-match (never silent, do not complete the task)', function () {
    const s = summarizeAltCvMatch([{ matched: false }, { matched: false }]);
    expect(s.matchedCvs).toHaveLength(0);
    expect(s.foundAttachmentButNoMatch).toBe(true);
  });
  it('no attachments processed → not flagged', function () {
    const s = summarizeAltCvMatch([]);
    expect(s.matchedCvs).toHaveLength(0);
    expect(s.foundAttachmentButNoMatch).toBe(false);
  });
});

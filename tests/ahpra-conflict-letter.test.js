// tests/ahpra-conflict-letter.test.js
import { describe, it, expect } from 'vitest';
import { buildConflictLetterEmail, isConflictLetterConfirmation, shouldEnsureConflictLetter } from '../lib/ahpra-conflict-letter.js';

describe('buildConflictLetterEmail', () => {
  const base = {
    gpName: 'Smith Miller', supervisorName: 'Dr John Miller',
    practiceName: 'SOP Medical Centre', contactName: 'Reception',
    officerName: 'Jane Officer', officerEmail: 'jane.officer@ahpra.gov.au',
    ccEmail: 'hazel@mygplink.com.au', rsoSignoffName: 'Hazel'
  };

  it('interpolates the dynamic officer, supervisor, GP and CC into the body', () => {
    const { subject, bodyHtml } = buildConflictLetterEmail(base);
    expect(subject).toBe('Conflict-of-interest confirmation for Dr Smith Miller — please email AHPRA');
    expect(bodyHtml).toContain('Dr John Miller');
    expect(bodyHtml).toContain('jane.officer@ahpra.gov.au');
    expect(bodyHtml).toContain('hazel@mygplink.com.au');
    expect(bodyHtml).toContain('not impair');
    expect(bodyHtml).toContain('SOP Medical Centre');
    expect(bodyHtml).toContain('Hazel — GP Link Registration Team');
  });

  it('HTML-escapes interpolated values in the body but not the subject', () => {
    const { subject, bodyHtml } = buildConflictLetterEmail({ ...base, practiceName: 'A & B <Clinic>' });
    expect(bodyHtml).toContain('A &amp; B &lt;Clinic&gt;');
    const subj = buildConflictLetterEmail({ ...base, gpName: 'A & B' }).subject;
    expect(subj).toContain('A & B'); // subject is a plain header, not escaped
  });

  it('falls back gracefully when optional fields are blank', () => {
    const { bodyHtml } = buildConflictLetterEmail({ gpName: 'Test GP' });
    expect(bodyHtml).toContain('Dear Practice Contact,');
    expect(bodyHtml).toContain('the supervisor');
    expect(bodyHtml).toContain('GP Link Registration Team');
  });
});

describe('isConflictLetterConfirmation', () => {
  const ctx = { practiceEmail: 'reception@sopclinic.com.au', officerEmail: 'jane.officer@ahpra.gov.au' };

  it('matches a practice→officer email that CCs us (officer in To)', () => {
    const meta = { sender: 'Reception <reception@sopclinic.com.au>',
      to: 'jane.officer@ahpra.gov.au', cc: 'hazel@mygplink.com.au' };
    expect(isConflictLetterConfirmation(meta, ctx)).toBe(true);
  });

  it('matches when to/cc are arrays and officer is in cc', () => {
    const meta = { sender: 'reception@sopclinic.com.au',
      to: ['someone@x.com'], cc: ['hazel@mygplink.com.au', 'Jane <jane.officer@ahpra.gov.au>'] };
    expect(isConflictLetterConfirmation(meta, ctx)).toBe(true);
  });

  it('rejects when sender is not the practice', () => {
    const meta = { sender: 'random@gmail.com', to: 'jane.officer@ahpra.gov.au' };
    expect(isConflictLetterConfirmation(meta, ctx)).toBe(false);
  });

  it('rejects when the officer is not a recipient', () => {
    const meta = { sender: 'reception@sopclinic.com.au', to: 'hazel@mygplink.com.au' };
    expect(isConflictLetterConfirmation(meta, ctx)).toBe(false);
  });

  it('rejects when context is incomplete', () => {
    expect(isConflictLetterConfirmation({ sender: 'reception@sopclinic.com.au' }, { practiceEmail: '', officerEmail: '' })).toBe(false);
  });
});

describe('shouldEnsureConflictLetter', () => {
  it('true only when conflict AND officer email both present', () => {
    expect(shouldEnsureConflictLetter({ hasConflict: true, officerEmail: 'o@ahpra.gov.au' })).toBe(true);
  });
  it('false when no conflict', () => {
    expect(shouldEnsureConflictLetter({ hasConflict: false, officerEmail: 'o@ahpra.gov.au' })).toBe(false);
  });
  it('false when no officer email', () => {
    expect(shouldEnsureConflictLetter({ hasConflict: true, officerEmail: '' })).toBe(false);
  });
});

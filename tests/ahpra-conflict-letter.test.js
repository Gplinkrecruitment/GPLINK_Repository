// tests/ahpra-conflict-letter.test.js
import { describe, it, expect } from 'vitest';
import { buildConflictLetterEmail } from '../lib/ahpra-conflict-letter.js';

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

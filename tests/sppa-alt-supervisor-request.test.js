import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
const { buildAltCvRequestEmail, altSupervisorsNeedingCv, altCvCardStatus } = require('../lib/sppa-alt-supervisor-request.js');

describe('buildAltCvRequestEmail', () => {
  it('puts the GP name in the subject and the alt, contact and signoff names in the body', () => {
    const { subject, bodyHtml } = buildAltCvRequestEmail({
      gpName: 'Smith Miller',
      altNames: ['Ahmed Mahmoud'],
      contactName: 'Jane Doe',
      rsoSignoffName: 'Hazel',
    });
    expect(subject).toContain('Smith Miller');
    expect(subject).toContain('Alternate Supervisor CV needed');
    expect(bodyHtml).toContain('Ahmed Mahmoud');
    expect(bodyHtml).toContain('Jane Doe');
    expect(bodyHtml).toContain('Hazel, GP Link Registration Team');
  });

  it('joins multiple alternate supervisors into a readable list', () => {
    const { bodyHtml } = buildAltCvRequestEmail({
      gpName: 'Smith Miller',
      altNames: ['Alpha One', 'Beta Two', 'Gamma Three'],
      contactName: 'Jane Doe',
      rsoSignoffName: 'Hazel',
    });
    expect(bodyHtml).toContain('Alpha One, Beta Two and Gamma Three');
  });

  it('joins exactly two alternate supervisors with "and"', () => {
    const { bodyHtml } = buildAltCvRequestEmail({
      gpName: 'Smith Miller',
      altNames: ['Alpha One', 'Beta Two'],
      contactName: 'Jane Doe',
      rsoSignoffName: 'Hazel',
    });
    expect(bodyHtml).toContain('Alpha One and Beta Two');
  });

  it('falls back to "Practice Contact" when contactName is empty', () => {
    const { bodyHtml } = buildAltCvRequestEmail({
      gpName: 'Smith Miller',
      altNames: ['Ahmed Mahmoud'],
      contactName: '',
      rsoSignoffName: 'Hazel',
    });
    expect(bodyHtml).toContain('Practice Contact');
  });

  it('falls back to "GP Link Registration Team" when rsoSignoffName is empty', () => {
    const { bodyHtml } = buildAltCvRequestEmail({
      gpName: 'Smith Miller',
      altNames: ['Ahmed Mahmoud'],
      contactName: 'Jane Doe',
      rsoSignoffName: '',
    });
    expect(bodyHtml).toContain('GP Link Registration Team');
    expect(bodyHtml).not.toContain(', GP Link Registration Team');
  });

  it('HTML-escapes interpolated values so injected markup cannot survive', () => {
    const { bodyHtml } = buildAltCvRequestEmail({
      gpName: 'Smith Miller',
      altNames: ['Tom & Jerry'],
      contactName: '<script>alert(1)</script>',
      rsoSignoffName: 'Hazel',
    });
    expect(bodyHtml).not.toContain('<script>');
    expect(bodyHtml).toContain('&lt;script&gt;');
    expect(bodyHtml).toContain('&amp;');
  });
});

describe('altSupervisorsNeedingCv', () => {
  it('returns [] when every alternate already has a CV (case/trim-insensitive)', () => {
    expect(altSupervisorsNeedingCv(['Ahmed Mahmoud', 'Jane Doe'], ['  ahmed mahmoud ', 'JANE DOE'])).toEqual([]);
  });

  it('returns all alternates when none are on file', () => {
    expect(altSupervisorsNeedingCv(['Ahmed Mahmoud', 'Jane Doe'], [])).toEqual(['Ahmed Mahmoud', 'Jane Doe']);
  });

  it('returns only the remainder when some are on file', () => {
    expect(altSupervisorsNeedingCv(['Ahmed Mahmoud', 'Jane Doe'], ['ahmed mahmoud'])).toEqual(['Jane Doe']);
  });

  it('returns [] when altNames is empty or falsy', () => {
    expect(altSupervisorsNeedingCv([], ['x'])).toEqual([]);
    expect(altSupervisorsNeedingCv(null, ['x'])).toEqual([]);
  });

  it('returns a copy of altNames when onFileNames is falsy', () => {
    const alts = ['Ahmed Mahmoud'];
    const result = altSupervisorsNeedingCv(alts, undefined);
    expect(result).toEqual(['Ahmed Mahmoud']);
    expect(result).not.toBe(alts);
  });
});

describe('altCvCardStatus', () => {
  it('shows "pending" when the alternate is detected but the request email has not been sent', () => {
    expect(altCvCardStatus('pending', 'open')).toBe('pending');
    expect(altCvCardStatus('pending', null)).toBe('pending');
    expect(altCvCardStatus('pending', '')).toBe('pending');
  });

  it('shows "requested" once the request email task has been sent to the practice', () => {
    expect(altCvCardStatus('pending', 'waiting_on_practice')).toBe('requested');
  });

  it('shows "under_review" when the CV has arrived (uploaded / under review / received)', () => {
    expect(altCvCardStatus('uploaded', 'waiting_on_practice')).toBe('under_review');
    expect(altCvCardStatus('under_review', 'waiting_on_practice')).toBe('under_review');
    expect(altCvCardStatus('received', 'completed')).toBe('under_review');
  });

  it('shows "under_review" when the request task is completed but the doc has not flipped to approved yet', () => {
    expect(altCvCardStatus('pending', 'completed')).toBe('under_review');
  });

  it('shows "completed" once the CV is approved/accepted', () => {
    expect(altCvCardStatus('approved', 'completed')).toBe('completed');
    expect(altCvCardStatus('accepted', 'waiting_on_practice')).toBe('completed');
  });

  it('shows "under_review" when a received CV was rejected / needs correction (RSO action needed)', () => {
    expect(altCvCardStatus('rejected', 'completed')).toBe('under_review');
    expect(altCvCardStatus('needs_correction', 'waiting_on_practice')).toBe('under_review');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(altCvCardStatus('  PENDING ', '  Waiting_On_Practice ')).toBe('requested');
    expect(altCvCardStatus('Approved', '')).toBe('completed');
  });

  it('defaults to "pending" for an unknown/empty doc status with no request task', () => {
    expect(altCvCardStatus('', '')).toBe('pending');
    expect(altCvCardStatus(null, null)).toBe('pending');
  });
});

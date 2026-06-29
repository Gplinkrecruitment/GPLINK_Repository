import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
const { buildAltCvRequestEmail, altSupervisorsNeedingCv } = require('../lib/sppa-alt-supervisor-request.js');

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
    expect(bodyHtml).toContain('Hazel — GP Link Registration Team');
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
    expect(bodyHtml).not.toContain('— GP Link Registration Team');
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

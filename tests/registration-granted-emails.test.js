// The two one-click drafts raised when AHPRA grants a registration
// (lib/registration-granted-emails.js). Owner style rule: no dashes anywhere.
import { describe, it, expect } from 'vitest';
import { buildPracticeRegistrationEmail, buildGpPassportRequest, passportPeopleLabels, describeHousehold, noDashes } from '../lib/registration-granted-emails.js';

const DASH = /[-‐-―−]/;

const CTX = {
  practiceName: 'The Doctors Werribee', contactName: 'Naomi Milne', contactEmail: 'pm@thefamilydoctors.example',
  gpFirstName: 'Mercy', gpLastName: 'Obanimoh',
  registrationNumber: 'MED0004091669', registrationType: 'Specialist registration',
  effectiveDate: '2026-11-02', expiryDate: '2027-09-30', hasConditions: true,
  supervisionLevel: 'Indirect 2', supervisorName: 'Dr Chamira Ranatunga', commencementDate: '2027-01-25',
  practiceCoversVisaCosts: true, senderName: 'Hazel Mwangi'
};

describe('buildPracticeRegistrationEmail', () => {
  const out = buildPracticeRegistrationEmail(CTX);
  it('addresses the practice contact by first name, never "Hi X, <sender> here"', () => {
    expect(out.bodyText.startsWith('Hi Naomi,')).toBe(true);
    expect(out.bodyText).not.toMatch(/Hazel here/i);
  });
  it('congratulates on the registration with number, dates and the supervised practice conditions', () => {
    expect(out.subject).toBe('Dr Mercy Obanimoh AHPRA registration approved, next step is the visa');
    expect(out.bodyText).toContain('AHPRA has approved Dr Mercy Obanimoh’s specialist registration');
    expect(out.bodyText).toContain('MED0004091669');
    expect(out.bodyText).toContain('effective from 2 November 2026');
    expect(out.bodyText).toContain('current until 30 September 2027');
    expect(out.bodyText).toContain('supervised practice at Indirect 2 level under Dr Chamira Ranatunga, with commencement planned for 25 January 2027');
  });
  it('asks for a registered migration agent for the Subclass 482 nomination and a reply with the agent\'s name and email', () => {
    expect(out.bodyText).toMatch(/engage a registered migration agent/);
    expect(out.bodyText).toMatch(/Subclass 482 nomination/);
    expect(out.bodyText).toMatch(/reply to this email with their name and email address/);
    expect(out.bodyText).toContain('The visa must be granted before Dr Obanimoh can start on 25 January 2027');
  });
  it('reminds gently about visa costs only when the offer commits the practice', () => {
    expect(out.bodyText).toContain('covers the visa costs for Dr Obanimoh as the primary applicant');
    const noCosts = buildPracticeRegistrationEmail(Object.assign({}, CTX, { practiceCoversVisaCosts: false }));
    expect(noCosts.bodyText).not.toMatch(/visa costs/);
  });
  it('mentions the 3 and 6 month supervision reports and signs off from the RSO', () => {
    expect(out.bodyText).toMatch(/supervision reports at three months and six months after commencement/);
    expect(out.bodyText.trim().endsWith('Warm regards,\nHazel Mwangi\nGP Link')).toBe(true);
  });
  it('carries to/cc/subject/bodyHtml/bodyText and contains no dashes anywhere', () => {
    expect(out.to).toBe('pm@thefamilydoctors.example');
    expect(out.cc).toBe('');
    expect(out.bodyHtml).toContain('<p>');
    expect(out.subject).not.toMatch(DASH);
    expect(out.bodyText).not.toMatch(DASH);
    expect(out.bodyHtml).not.toMatch(DASH);
  });
  it('strips dashes that data values drag in and copes with missing values', () => {
    const o = buildPracticeRegistrationEmail({ practiceName: 'Co-op Medical', contactName: '', contactEmail: 'x@y.z', gpFirstName: 'Ann', gpLastName: 'Lee-Smith', registrationNumber: '', effectiveDate: null, hasConditions: true, supervisionLevel: 'Indirect-2', senderName: '' });
    expect(o.bodyText).not.toMatch(DASH);
    expect(o.subject).not.toMatch(DASH);
    expect(o.bodyText.startsWith('Hi there,')).toBe(true);
    expect(o.bodyText).toContain('Co op Medical');
    expect(o.bodyText).toContain('The GP Link team');
  });
  it('escapes HTML in the html body', () => {
    const o = buildPracticeRegistrationEmail(Object.assign({}, CTX, { practiceName: 'A <b>Practice</b> & Co' }));
    expect(o.bodyHtml).toContain('A &lt;b&gt;Practice&lt;/b&gt; &amp; Co');
  });
});

describe('buildGpPassportRequest', () => {
  const ctx = { gpFirstName: 'Mercy', gpLastName: 'Obanimoh', practiceName: 'The Doctors Werribee', registrationNumber: 'MED0004091669', effectiveDate: '2026-11-02', whoMoving: 'me_partner_children', childrenCount: 2, appBaseUrl: 'https://app.mygplink.com.au/', senderName: 'Hazel Mwangi' };
  const out = buildGpPassportRequest(ctx);
  it('builds the email with congratulations, what happens next, the passports needed and the visa page CTA', () => {
    expect(out.email.subject).toBe('Congratulations Dr Obanimoh, your AHPRA registration is approved');
    expect(out.email.title).toBe('Congratulations, {{name}}!');
    expect(out.email.body).toContain('Your registration number is MED0004091669 and it is effective from 2 November 2026.');
    expect(out.email.body).toContain('The Doctors Werribee is engaging a registered migration agent to sponsor your Subclass 482 visa');
    expect(out.email.body).toContain('You do not need to lodge anything yourself.');
    expect(out.email.body).toContain('for you, your partner and your 2 children:');
    expect(out.email.body).toContain('• Your passport\n• Partner\'s passport\n• Child 1 passport\n• Child 2 passport');
    expect(out.email.ctaText).toBe('Open your visa page');
    expect(out.email.ctaUrl).toBe('https://app.mygplink.com.au/pages/visa');
    expect(out.email.body.trim().endsWith('Warm regards,\nHazel\nGP Link')).toBe(true);
  });
  it('carries the WhatsApp template name and placeholders ({{1}} first name, {{2}} link)', () => {
    expect(out.whatsapp).toEqual({ templateName: 'gp_link_visa_passports', placeholders: ['Mercy', 'https://app.mygplink.com.au/pages/visa'] });
  });
  it('lists the people (labels the visa page and the request rows share)', () => {
    expect(out.people).toEqual(['Your passport', "Partner's passport", 'Child 1 passport', 'Child 2 passport']);
  });
  it('contains no dashes', () => {
    expect(out.email.subject).not.toMatch(DASH);
    expect(out.email.title).not.toMatch(DASH);
    expect(out.email.body).not.toMatch(DASH);
  });
  it('adapts to the household: alone, partner only, children only', () => {
    expect(buildGpPassportRequest(Object.assign({}, ctx, { whoMoving: 'just_me', childrenCount: '' })).email.body).toContain('for you:\n\n• Your passport\n\n');
    expect(buildGpPassportRequest(Object.assign({}, ctx, { whoMoving: 'me_partner', childrenCount: '' })).people).toEqual(['Your passport', "Partner's passport"]);
    const kids = buildGpPassportRequest(Object.assign({}, ctx, { whoMoving: 'me_children', childrenCount: '1' }));
    expect(kids.email.body).toContain('for you and your child:');
    expect(kids.people).toEqual(['Your passport', 'Child 1 passport']);
  });
  it('falls back sensibly when names are missing', () => {
    const o = buildGpPassportRequest({ appBaseUrl: 'https://app.mygplink.com.au' });
    expect(o.email.subject).toBe('Congratulations Doctor, your AHPRA registration is approved');
    expect(o.whatsapp.placeholders[0]).toBe('Doctor');
    expect(o.email.body).toContain('Your practice is engaging');
  });
});

describe('helpers', () => {
  it('passportPeopleLabels / describeHousehold', () => {
    expect(passportPeopleLabels('me_partner_children', 1)).toEqual(['Your passport', "Partner's passport", 'Child 1 passport']);
    expect(describeHousehold('me_partner_children', 3)).toBe('you, your partner and your 3 children');
    expect(describeHousehold('just_me', '')).toBe('you');
  });
  it('noDashes replaces every dash family character with a space', () => {
    expect(noDashes('a-b – c — d')).toBe('a b c d');
  });
});

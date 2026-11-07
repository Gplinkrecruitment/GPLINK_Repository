// The two one-click drafts raised when AHPRA grants a registration
// (lib/registration-granted-emails.js). Owner style rule: no dashes anywhere.
import { describe, it, expect } from 'vitest';
import { buildPracticeRegistrationEmail, buildGpPassportRequest, buildGpPassportReminder, passportStatusSummary, describeOutstanding, passportPeopleLabels, describeHousehold, greetingName, noDashes } from '../lib/registration-granted-emails.js';

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

describe('greetingName (who the practice email opens to)', () => {
  it('greets a doctor by title and surname, a person by first name, and a role as nobody', () => {
    // Dr Obanimoh's first draft opened "Hi Dr," because the title was read as a first name.
    expect(greetingName('Dr Chamira Ranatunga')).toBe('Dr Ranatunga');
    expect(greetingName('Doctor Chamira Ranatunga')).toBe('Dr Ranatunga');
    expect(greetingName('Prof. Ann Lee')).toBe('Prof Lee');
    expect(greetingName('Naomi Milne')).toBe('Naomi');
    expect(greetingName('Practice Manager')).toBe('');
    expect(greetingName('')).toBe('');
    expect(buildPracticeRegistrationEmail({ ...CTX, contactName: 'Dr Chamira Ranatunga' }).bodyText.startsWith('Hi Dr Ranatunga,')).toBe(true);
    expect(buildPracticeRegistrationEmail({ ...CTX, contactName: 'Practice Manager' }).bodyText.startsWith('Hi there,')).toBe(true);
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

describe('buildGpPassportReminder (the nudge once the first request has gone, owner 2026-11-08)', () => {
  const base = { gpFirstName: 'Mercy', gpLastName: 'Obanimoh', practiceName: 'The Doctors Werribee', requestedAt: '2026-11-06T03:27:36.144Z', commencementDate: '2027-01-25', appBaseUrl: 'https://app.mygplink.com.au/', senderName: 'Hazel Mwangi' };

  it('lists only what is still missing, acknowledges what is in, and is never the congratulations email', () => {
    const r = buildGpPassportReminder({ ...base, outstanding: ['Your passport', 'Child 1 passport', 'Child 2 passport'], received: ["Partner's passport"], reminderCount: 0 });
    expect(r.email.subject).toBe('A quick reminder about the passports for your visa, Dr Obanimoh');
    expect(r.email.title).toBe('Just a gentle nudge, {{name}}');
    expect(r.email.body).toContain('On 6 November 2026 we asked for the passport photo pages for your Subclass 482 visa.');
    expect(r.email.body).toContain("Thank you, we have your partner's passport already.");
    expect(r.email.body).toContain('• Your passport\n• Child 1 passport\n• Child 2 passport');
    expect(r.email.body).not.toContain("• Partner's passport");
    expect(r.email.body).toContain('The Doctors Werribee is engaging a migration agent, and the agent cannot lodge the nomination or the visa until every passport is in, so your start date of 25 January 2027 depends on it.');
    expect(r.email.body).not.toContain('AHPRA has approved');
    expect(r.email.body).toContain('Warm regards,\nHazel\nGP Link');
    expect(r.email.ctaText).toBe('Upload the passports');
    expect(r.email.ctaUrl).toBe('https://app.mygplink.com.au/pages/visa');
    expect(r.people).toEqual(['Your passport', 'Child 1 passport', 'Child 2 passport']);
    expect(r.reminder_number).toBe(1);
  });

  it('carries the reminder WhatsApp template with the first name, what is missing, and the link', () => {
    const r = buildGpPassportReminder({ ...base, outstanding: ["Partner's passport", 'Child 1 passport', 'Child 2 passport'], received: ['Your passport'], reminderCount: 0 });
    expect(r.whatsapp).toEqual({ templateName: 'gp_link_visa_passports_reminder', placeholders: ['Mercy', "your partner's passport and your 2 children's passports", 'https://app.mygplink.com.au/pages/visa'] });
    expect(r.email.body).toContain('Thank you, we have yours already.');
  });

  it('a second reminder says so and names the original request date', () => {
    const r = buildGpPassportReminder({ ...base, outstanding: ['Your passport'], received: [], reminderCount: 1 });
    expect(r.email.subject).toBe('Still waiting on the passports for your visa, Dr Obanimoh');
    expect(r.email.title).toBe('Another gentle nudge, {{name}}');
    expect(r.email.body).toContain('We are still waiting on the passports for your Subclass 482 visa, which we first asked for on 6 November 2026. We are still waiting on:');
    expect(r.reminder_number).toBe(2);
  });

  it('contains no dashes and copes without a commencement date, a request date or a last name', () => {
    const r = buildGpPassportReminder({ gpFirstName: 'Sam', outstanding: ['Your passport'], received: [], appBaseUrl: 'https://x.test' });
    // Same name fallback as the first request: a lone name is treated as the surname.
    expect(r.email.subject).toBe('A quick reminder about the passports for your visa, Dr Sam');
    expect(r.email.subject).not.toMatch(DASH);
    expect(r.email.body).not.toMatch(DASH);
    expect(r.email.body).toContain('We asked for the passport photo pages for your Subclass 482 visa. We are still waiting on:');
    expect(r.email.body).toContain('until every passport is in.');
    expect(r.email.body).toContain('Warm regards,\nThe GP Link team\nGP Link');
    expect(r.whatsapp.placeholders).toEqual(['Sam', 'your passport', 'https://x.test/pages/visa']);
  });
});

describe('passportStatusSummary / describeOutstanding', () => {
  it('reads the live request rows: uploaded or approved are in, missing or rejected still need the doctor', () => {
    const s = passportStatusSummary([
      { id: 'a', document_type: 'passport', label: 'Your passport', status: 'missing' },
      { id: 'b', document_type: 'passport', label: "Partner's passport", status: 'uploaded', file_path: 'x', uploaded_at: '2026-11-07T00:00:00Z', dependant_id: 'd1' },
      { id: 'c', document_type: 'passport', label: 'Child 1 passport', status: 'rejected', rejection_reason: 'blurry' },
      { id: 'd', document_type: 'passport', label: 'Child 2 passport', status: 'approved', verified: true, file_path: 'y' },
      { id: 'e', document_type: 'police_check', status: 'uploaded', file_path: 'z' }
    ], []);
    expect(s.people.map((p) => p.label + ':' + p.status)).toEqual(['Your passport:missing', "Partner's passport:uploaded", 'Child 1 passport:rejected', 'Child 2 passport:approved']);
    expect(s.outstanding).toEqual(['Your passport', 'Child 1 passport']);
    expect(s.received).toEqual(["Partner's passport", 'Child 2 passport']);
    expect(s.all_received).toBe(false);
    expect(s.people[1].uploaded_at).toBe('2026-11-07T00:00:00Z');
    expect(s.people[2].rejection_reason).toBe('blurry');
  });

  it('is all_received only when every row is in, and falls back to the card labels (all outstanding) when there are no rows', () => {
    expect(passportStatusSummary([{ document_type: 'passport', label: 'Your passport', status: 'uploaded', file_path: 'x' }], []).all_received).toBe(true);
    const fb = passportStatusSummary([], ['Your passport', "Partner's passport"]);
    expect(fb.outstanding).toEqual(['Your passport', "Partner's passport"]);
    expect(fb.all_received).toBe(false);
    expect(passportStatusSummary([], []).all_received).toBe(false);
  });

  it('describeOutstanding reads naturally', () => {
    expect(describeOutstanding(['Your passport'])).toBe('your passport');
    expect(describeOutstanding(["Partner's passport"])).toBe("your partner's passport");
    expect(describeOutstanding(['Child 1 passport'])).toBe("your child's passport");
    expect(describeOutstanding(['Your passport', "Partner's passport", 'Child 1 passport', 'Child 2 passport'])).toBe("your passport, your partner's passport and your 2 children's passports");
    expect(describeOutstanding([])).toBe('the passports');
  });
});

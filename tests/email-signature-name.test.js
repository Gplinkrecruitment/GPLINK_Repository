// Owner report 2026-08-19: the practice replied "Naomi will get back to you today", and the AI's
// note to the RSO said "Naomi is not on the email thread and we do not have her email address".
// We did have it. Naomi Milne is pm@thefamilydoctors.com.au — CC'd on that thread and the sender
// of four earlier emails. Her HEADER name is the generic "Practice Manager", so nothing could
// join "Naomi" to the address. Her real name was only ever in her sign-off.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const lib = require('../lib/email-signature-name.js');
const followup = require('../lib/practice-reply-followup.js');

const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const adminSrc = readFileSync(new URL('../pages/admin.html', import.meta.url), 'utf8');
const ceoSrc = readFileSync(new URL('../pages/ceo-dashboard.html', import.meta.url), 'utf8');

// Naomi's actual email, as stored in prod.
const REAL_SIGNATURE = [
  'No worries at all.',
  '',
  'Thank you',
  'Have a great day.',
  '',
  'Kind Regards,',
  'Naomi Milne',
  'Practice Manager',
  '',
  'The Doctors Werribee',
  'Availability: Monday - Friday',
  '9:00am - 5:00pm',
  '03 8579 0976',
  'Please consider the environment before printing this e-mail.',
].join('\n');

describe('nameFromSignature', () => {
  it('recovers the name from the real email that caused the report', () => {
    expect(lib.nameFromSignature(REAL_SIGNATURE)).toBe('Naomi Milne');
  });

  it('takes the sign-off at the BOTTOM, not a "Thank you" in the opening line', () => {
    // "Thank you" appears above "Have a great day." — a first-match reader returns that.
    expect(lib.nameFromSignature(REAL_SIGNATURE)).not.toBe('Have a great day');
  });

  it('skips a blank line between the sign-off and the name', () => {
    expect(lib.nameFromSignature('Hi,\n\nSee attached.\n\nRegards,\n\nSarah Chen\nReception')).toBe('Sarah Chen');
  });

  it('never takes a name out of quoted history — that is somebody else signing', () => {
    const body = 'Naomi will get back to you today\n\n> On 18 Aug 2026, Hazel wrote:\n> Kind regards,\n> Hazel Smith';
    expect(lib.nameFromSignature(body)).toBe('');
  });

  it('stops at a forwarded-message header too', () => {
    expect(lib.nameFromSignature('Passing this on.\n\nFrom: Someone Else\nKind regards,\nWrong Person')).toBe('');
  });

  it('rejects a role or company line standing where a name would be', () => {
    expect(lib.nameFromSignature('Thanks,\nThe Practice Team')).toBe('');
    expect(lib.nameFromSignature('Regards,\nWerribee Medical Centre')).toBe('');
    expect(lib.nameFromSignature('Regards,\nSent from my iPhone')).toBe('');
  });

  it('keeps a doctor title, which is a useful answer', () => {
    expect(lib.nameFromSignature('Regards,\nDr Chamira Ranatunga')).toBe('Dr Chamira Ranatunga');
  });

  it('returns empty rather than guessing when there is no sign-off', () => {
    expect(lib.nameFromSignature('Naomi will get back to you today')).toBe('');
    expect(lib.nameFromSignature('')).toBe('');
    expect(lib.nameFromSignature(null)).toBe('');
  });

  it('does not mistake a phone number or address line for a name', () => {
    expect(lib.nameFromSignature('Regards,\n03 8579 0976')).toBe('');
    expect(lib.nameFromSignature('Regards,\npm@thefamilydoctors.com.au')).toBe('');
  });
});

describe('the prompt now names the person, not just their role', () => {
  function threadLine(contacts) {
    const built = followup.buildPracticeReplyMessages({
      docTitle: 'SPPA-00', gpName: 'Mercy Obanimoh', contactName: 'Dr Chamira Ranatunga',
      replyText: 'Naomi will get back to you today', knownContacts: contacts,
    });
    return built.userText;
  }

  it('lists the signed name alongside the header role, so "Naomi" can be matched', () => {
    const text = threadLine([{ email_address: 'pm@thefamilydoctors.com.au', display_name: 'Practice Manager', signature_name: 'Naomi Milne' }]);
    expect(text).toContain('Naomi Milne (Practice Manager) <pm@thefamilydoctors.com.au>');
  });

  it('falls back to the header name when no signature name was recoverable', () => {
    const text = threadLine([{ email_address: 'pm@thefamilydoctors.com.au', display_name: 'Practice Manager' }]);
    expect(text).toContain('Practice Manager <pm@thefamilydoctors.com.au>');
  });

  it('does not print the same name twice when header and signature agree', () => {
    const text = threadLine([{ email_address: 'n@x.com', display_name: 'Naomi Milne', signature_name: 'Naomi Milne' }]);
    expect(text).toContain('Naomi Milne <n@x.com>');
    expect(text).not.toContain('Naomi Milne (Naomi Milne)');
  });
});

describe('wiring', () => {
  it('collectCaseThreadContacts fills signature_name from the sender\'s own last email', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function collectCaseThreadContacts'));
    expect(fn).toContain('emailSignatureName.nameFromSignature(body)');
    expect(fn).toContain('direction=eq.inbound');
  });

  it('is best-effort — a failure here must never cost the contact list', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function collectCaseThreadContacts'), serverSrc.indexOf('async function searchGmailForGP'));
    expect(fn).toContain("console.warn('[email-contacts] signature-name pass failed:'");
  });

  it('the CC picker shows the person, not the role, in both dashboards', () => {
    expect(adminSrc).toContain('var ccLabel = c.signature_name || c.display_name;');
    expect(ceoSrc).toContain('var ccLabel = c.signature_name || c.display_name;');
  });
});

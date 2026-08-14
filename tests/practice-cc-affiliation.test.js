// A CC suggestion on a practice email must be someone we can SHOW belongs to the practice.
//
// Owner report 2026-08-14: "why has mini been cc'd... she is my personal accountant".
// mini@valantisadvisors.com.au was offered as a CC on Dr Sana Ahsan's "Supervisor CV
// needed" email to Halekulani Medical Centre. She had appeared on the case exactly once:
// an unrelated email, "Re: Your Personal TR for FY 2025", which the Gmail triage filed
// against the case because someone from the practice's domain happened to be on it too.
//
// collectCaseThreadContacts then offered EVERY address that had ever touched the case, so
// one stray thread put a stranger one click away from a doctor's registration
// correspondence. Appearing beside the practice once is not evidence of anything.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
process.env.NODE_ENV = 'test';
const { __testUtils: T } = require('../server.js');

const { emailDomainOf, practiceIdentityTokens, isPracticeAffiliatedAddress, PUBLIC_EMAIL_DOMAINS } = T;

function signals({ trusted = [], domains = [], tokens = [], ourThreads = [] } = {}) {
  return {
    trusted: new Set(trusted),
    domains: new Set(domains),
    tokens,
    ourThreads: new Set(ourThreads)
  };
}

describe('emailDomainOf', () => {
  it('reads the domain', () => {
    expect(emailDomainOf('sonia@halekulanimedical.com.au')).toBe('halekulanimedical.com.au');
    expect(emailDomainOf('MINI@Valantisadvisors.com.au')).toBe('valantisadvisors.com.au');
  });
  it('is empty for junk', () => {
    expect(emailDomainOf('')).toBe('');
    expect(emailDomainOf('not-an-address')).toBe('');
    expect(emailDomainOf(null)).toBe('');
  });
});

describe('practiceIdentityTokens', () => {
  it('keeps only the distinctive words', () => {
    expect(practiceIdentityTokens('Halekulani Medical Centre')).toEqual(['halekulani']);
    expect(practiceIdentityTokens('The Doctors Werribee')).toEqual(['werribee']);
  });
  it('drops words that identify nobody, so they can never vouch for a domain', () => {
    // Otherwise "medical" would match medical-anything.com.au and let any stranger in.
    expect(practiceIdentityTokens('Medical Centre Clinic Health Practice Surgery')).toEqual([]);
    expect(practiceIdentityTokens('Family Doctors Group')).toEqual([]);
  });
  it('handles empty input', () => {
    expect(practiceIdentityTokens('')).toEqual([]);
    expect(practiceIdentityTokens(null)).toEqual([]);
  });
});

describe('the reported case: Halekulani Medical Centre', () => {
  // Exactly what the case can prove: the practice contact is on a FREE domain
  // (drtarig@yahoo.co.uk) and the practices row has no website, so the practice NAME is
  // the only usable signal.
  const s = signals({ trusted: ['drtarig@yahoo.co.uk'], tokens: ['halekulani'] });

  it('offers Sonia, who is on the practice domain', () => {
    expect(isPracticeAffiliatedAddress('sonia@halekulanimedical.com.au', [], s)).toBe(true);
  });

  it('HIDES the accountant', () => {
    expect(isPracticeAffiliatedAddress('mini@valantisadvisors.com.au', [], s)).toBe(false);
  });

  it('still offers the practice contact itself', () => {
    expect(isPracticeAffiliatedAddress('drtarig@yahoo.co.uk', [], s)).toBe(true);
  });

  it('does not let one free-domain contact vouch for every other free-domain address', () => {
    // drtarig@yahoo.co.uk is trusted, but yahoo.co.uk must NOT become a trusted domain.
    expect(isPracticeAffiliatedAddress('stranger@yahoo.co.uk', [], s)).toBe(false);
    expect(isPracticeAffiliatedAddress('stranger@gmail.com', [], s)).toBe(false);
  });
});

describe('the signals that DO vouch for an address', () => {
  it('someone we have already emailed from this case', () => {
    const s = signals({ trusted: ['manager@gmail.com'] });
    expect(isPracticeAffiliatedAddress('manager@gmail.com', [], s)).toBe(true);
  });

  it('someone on the practice’s own domain', () => {
    const s = signals({ domains: ['halekulanimedical.com.au'] });
    expect(isPracticeAffiliatedAddress('reception@halekulanimedical.com.au', [], s)).toBe(true);
  });

  it('someone brought in on a thread WE wrote on (the practice-manager-on-a-reply case)', () => {
    const s = signals({ ourThreads: ['thread-we-started'] });
    expect(isPracticeAffiliatedAddress('manager@gmail.com', ['thread-we-started'], s)).toBe(true);
    // ...but not someone on a thread that merely landed in the case.
    expect(isPracticeAffiliatedAddress('manager@gmail.com', ['thread-that-just-arrived'], s)).toBe(false);
  });

  it('nobody, when there is nothing to judge against', () => {
    const s = signals();
    expect(isPracticeAffiliatedAddress('anyone@anywhere.com', ['t1'], s)).toBe(false);
  });
});

describe('contacts recorded on the practice itself', () => {
  const fs = require('fs');
  const path = require('path');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  it('are collected from practices.secondary_contacts', () => {
    expect(serverSrc).toContain('async function collectPracticeSecondaryContacts');
    expect(serverSrc).toMatch(/normalizeSecondaryContacts\(practice\.secondary_contacts, practice\.contact_email\)/);
    expect(serverSrc).toContain("source: 'practice_record'");
  });

  it('are offered by the CC endpoint alongside the thread contacts', () => {
    expect(serverSrc).toMatch(/collectPracticeSecondaryContacts\(contactsCaseId\)\)\s*\n?\s*\.concat\(await collectCaseThreadContacts\(contactsCaseId\)\)/);
  });

  it('are trusted by the affiliation check, so they can never be filtered back out', () => {
    const start = serverSrc.indexOf('async function buildPracticeAffiliationSignals');
    const end = serverSrc.indexOf('function isPracticeAffiliatedAddress');
    const block = serverSrc.slice(start, end);
    expect(block).toContain('normalizeSecondaryContacts(practiceRow.secondary_contacts');
    expect(block).toContain('addTrusted(c.email)');
  });

  it('resolve the practice down the authoritative chain, not the career-state mirror', () => {
    expect(serverSrc).toContain('async function resolvePlacedPracticeRow');
    expect(serverSrc).toMatch(/resolvePlacedPracticeRow[\s\S]{0,900}fetchPlacedApplicationRows/);
    expect(serverSrc).toMatch(/resolvePlacedPracticeRow[\s\S]{0,1200}select=id,name,contact_email,contact_name,website,secondary_contacts/);
  });

  it('use the practice website domain as a signal, ignoring a public host', () => {
    const start = serverSrc.indexOf('async function buildPracticeAffiliationSignals');
    const end = serverSrc.indexOf('function isPracticeAffiliatedAddress');
    const block = serverSrc.slice(start, end);
    expect(block).toContain('practiceRow.website');
    expect(block).toContain('!PUBLIC_EMAIL_DOMAINS.has(host)');
  });
});

describe('public mailbox providers', () => {
  it('covers the providers a practice contact actually uses', () => {
    for (const d of ['gmail.com', 'yahoo.co.uk', 'hotmail.com', 'outlook.com', 'bigpond.com.au', 'icloud.com']) {
      expect(PUBLIC_EMAIL_DOMAINS.has(d), d + ' must be treated as public').toBe(true);
    }
  });

  it('does not treat a real clinic domain as public', () => {
    expect(PUBLIC_EMAIL_DOMAINS.has('halekulanimedical.com.au')).toBe(false);
  });

  it('a public domain can never match by name affinity either', () => {
    // A practice literally called "Gmail Medical" must not whitelist all of gmail.com.
    const s = signals({ tokens: ['gmail'] });
    expect(isPracticeAffiliatedAddress('stranger@gmail.com', [], s)).toBe(false);
  });
});

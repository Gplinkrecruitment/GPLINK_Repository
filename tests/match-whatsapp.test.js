// The "you've been matched" WhatsApp touch (2026-08-29). Before it, a shortlist
// reached the doctor by email, in-app update and push only — never WhatsApp.
//
// The brief was to convey competition so doctors respond quickly. These tests
// pin the line between urgency and invention: the message may state a number of
// rival doctors ONLY when that number was actually counted, and may promise an
// ordering it cannot control NEVER.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import M from '../lib/match-whatsapp.js';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const base = {
  firstName: 'Deepika',
  practiceName: 'PKG Medical Centre',
  city: 'Tweed Heads West',
  state: 'NSW',
  expiresAt: '2026-09-03T06:21:59.554Z',
  matchUrl: 'https://app.mygplink.com.au/pages/signin?next=%2Fpages%2Fcareer%3Fmatch%3Dabc'
};

describe('urgency copy is competitive but never invented', () => {
  it('names the REAL number of rival doctors when there are some', () => {
    expect(M.buildUrgencyLine({ ...base, otherShortlistedCount: 3 }))
      .toContain('3 other doctors have also been shortlisted');
  });

  it('claims no EXISTING rivals when nobody else is shortlisted', () => {
    const line = M.buildUrgencyLine({ ...base, otherShortlistedCount: 0 });
    // "released to other doctors" is a true statement about what happens when
    // the hold lapses; what must never appear is a claim that other doctors
    // are ALREADY on this role.
    expect(line).not.toMatch(/also been shortlisted/);
    expect(line).not.toMatch(/\d+ other doctors? (has|have)/);
    // the real deadline carries the urgency instead
    expect(line).toContain('Thu 3 Sep');
    expect(line).toContain('released to other doctors');
  });

  it('never promises an interview ordering we do not control', () => {
    for (const n of [0, 1, 3, 12]) {
      const line = M.buildUrgencyLine({ ...base, otherShortlistedCount: n });
      expect(line).not.toMatch(/first/i);
      expect(line).not.toMatch(/guarantee/i);
    }
  });

  it('singular reads as English, not "1 other doctors"', () => {
    const line = M.buildUrgencyLine({ ...base, otherShortlistedCount: 1 });
    expect(line).toContain('One other doctor has also been shortlisted');
    expect(line).not.toContain('1 other doctors');
  });

  it('a missing/garbled count degrades to the deadline-only line', () => {
    for (const bad of [undefined, null, NaN, 'lots']) {
      expect(M.buildUrgencyLine({ ...base, otherShortlistedCount: bad })).not.toMatch(/also been shortlisted/);
    }
  });
});

describe('the hold date is a real date, not a countdown', () => {
  it('renders a day+date the doctor can still trust three days later', () => {
    expect(M.formatHoldDate('2026-09-03T06:21:59.554Z')).toBe('Thu 3 Sep'); // 3 Sep 2026 is a Thursday
  });
  it('an unparseable expiry falls back to wording that states no date', () => {
    expect(M.formatHoldDate('')).toBe('');
    const line = M.buildUrgencyLine({ ...base, expiresAt: 'nonsense', otherShortlistedCount: 2 });
    expect(line).toContain('your spot is held for a short window');
    expect(line).not.toContain('undefined');
    expect(line).not.toContain('NaN');
  });
});

describe('placeholders', () => {
  it('builds the four template variables in order', () => {
    const p = M.buildMatchWhatsAppPlaceholders({ ...base, otherShortlistedCount: 2 });
    expect(p.templateName).toBe('gp_link_app_match_invitation');
    expect(p.placeholders).toHaveLength(4);
    expect(p.placeholders[0]).toBe('Deepika');
    expect(p.placeholders[1]).toBe('PKG Medical Centre in Tweed Heads West, NSW');
    expect(p.placeholders[3]).toBe(base.matchUrl);
  });

  it('returns null without a link — the message exists to deliver one', () => {
    expect(M.buildMatchWhatsAppPlaceholders({ ...base, matchUrl: '' })).toBeNull();
    expect(M.buildMatchWhatsAppPlaceholders({ ...base, matchUrl: '   ' })).toBeNull();
  });

  it('degrades gracefully with no name, practice or location', () => {
    const p = M.buildMatchWhatsAppPlaceholders({ matchUrl: base.matchUrl });
    expect(p.placeholders[0]).toBe('there');
    expect(p.placeholders[1]).toBe('an Australian practice');
    expect(p.placeholders[1]).not.toContain('undefined');
  });

  it('uses only the first name, never the full name', () => {
    const p = M.buildMatchWhatsAppPlaceholders({ ...base, firstName: 'Deepika Ganesh', otherShortlistedCount: 0 });
    expect(p.placeholders[0]).toBe('Deepika');
  });

  it('falls back to the location alone when the practice has no name', () => {
    const p = M.buildMatchWhatsAppPlaceholders({ ...base, practiceName: '', otherShortlistedCount: 0 });
    expect(p.placeholders[1]).toBe('a practice in Tweed Heads West, NSW');
  });
});

describe('rendered message', () => {
  const text = M.renderMatchWhatsAppText({ ...base, otherShortlistedCount: 3 });
  it('greets, names the practice, carries the urgency line and the link', () => {
    expect(text).toContain('Hi Deepika');
    expect(text).toContain('PKG Medical Centre in Tweed Heads West, NSW');
    expect(text).toContain('3 other doctors have also been shortlisted');
    expect(text).toContain(base.matchUrl);
  });
  it('offers a no-pressure way out — a doctor must be able to decline', () => {
    expect(text).toMatch(/Not the right fit/i);
  });
  it('is well under the WhatsApp body limit', () => {
    expect(text.length).toBeLessThan(1024);
  });
  it('renders nothing at all when there is no link', () => {
    expect(M.renderMatchWhatsAppText({ ...base, matchUrl: '' })).toBe('');
  });
});

describe('server wiring', () => {
  const server = read('server.js');

  it('announceShortlistToGp sends WhatsApp alongside email/in-app/push', () => {
    const fn = server.slice(server.indexOf('async function announceShortlistToGp'),
      server.indexOf('// Turn an existing pipeline row into a live shortlist invitation'));
    expect(fn).toContain('sendMatchWhatsAppToGp(row)');
    // every leg is individually caught — one failure must not lose the others
    expect(fn).toMatch(/sendMatchWhatsAppToGp\(row\)\s*\n\s*\.catch\(/);
    expect(fn).toContain('whatsapp: results[3]');
  });

  it('the WhatsApp link is the same destination as the match email button', () => {
    const fn = server.slice(server.indexOf('async function sendMatchWhatsAppToGp'),
      server.indexOf('async function announceShortlistToGp'));
    expect(fn).toContain("'/pages/career?match=' + row.id");
    const emailFn = server.slice(server.indexOf('function buildMatchEmailHtml'), server.indexOf('async function sendMatchEmail'));
    expect(emailFn).toContain("'/pages/career?match=' + applicationId");
  });

  it('fails soft on every missing precondition rather than throwing', () => {
    const fn = server.slice(server.indexOf('async function sendMatchWhatsAppToGp'),
      server.indexOf('async function announceShortlistToGp'));
    expect(fn).toContain("skipped: 'no_api_key'");
    expect(fn).toContain("skipped: 'no_phone'");
    expect(fn).toContain("skipped: 'no_link'");
    expect(fn).toContain('pending WhatsApp approval');
  });

  it('the competitor count is live shortlists only, excluding this doctor', () => {
    const fn = server.slice(server.indexOf('async function countOtherLiveShortlistsForRole'),
      server.indexOf('// The WhatsApp leg of a shortlist'));
    expect(fn).toContain('ats_stage=eq.shortlisted');
    expect(fn).toContain('match_outcome=is.null');
    expect(fn).toContain('String(r.id) === String(excludeApplicationId)');
    // any failure must return 0 (deadline-only copy), never a guess
    expect(fn).toMatch(/catch[\s\S]*return 0;/);
  });

  it('never logs the doctor\'s phone number in the clear', () => {
    const fn = server.slice(server.indexOf('async function sendMatchWhatsAppToGp'),
      server.indexOf('async function announceShortlistToGp'));
    expect(fn).toContain('maskPhone(toPhone)');
    expect(fn).not.toMatch(/console\.log\([^)]*',\s*toPhone/);
  });
});

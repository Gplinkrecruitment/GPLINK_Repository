// WP-16 (Australian GP build): the WORDS of every message to an
// Australian-segment lead.
//
// Acceptance (docs/au-gp/review-report.md, WP-16): "snapshot tests show no
// 'move', 'visa', 'relocat' or 'UK' in any AU-segment message". This file
// renders every message id for every segment through the builders the server
// calls and checks, for each: none of those four, none of the AGENT-RULES
// section 4 words, no dollar sign, no percentage, the regulator spelt "Ahpra",
// the confidentiality line in its agreed wording, and nothing that promises a
// role to a segment that is not launched.
//
// The snapshot (tests/fixtures/au-wp16-au-copy.snapshot.json) and the copy
// deck (docs/au-gp/au-lead-copy.md) are committed so a change of wording shows
// up in review as a change to one readable file. WP16_WRITE_COPY=1 rewrites
// both from the code.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const auLeadCopy = require('../lib/au-lead-copy.js');
const auWhatsAppTemplates = require('../lib/au-whatsapp-templates.js');
const consultWhatsapp = require('../lib/consult-whatsapp.js');
const { AU_SEGMENTS, SAMPLE_ZONES, forbiddenIn, renderOne, renderAllAuMessages, renderCopyDeck, htmlToText } = require('./helpers/au-wp16-copy.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'au-wp16-au-copy.snapshot.json');
const DECK = path.join(__dirname, '..', 'docs', 'au-gp', 'au-lead-copy.md');
const WRITE = process.env.WP16_WRITE_COPY === '1';

describe('WP-16: the scan itself can tell the words apart', () => {
  it('catches each forbidden word, on a word boundary', () => {
    expect(forbiddenIn('Thinking about a move to Perth?')).toContain('move');
    expect(forbiddenIn('We can help with moving.')).toContain('move');
    expect(forbiddenIn('Your visa is sorted.')).toContain('visa');
    expect(forbiddenIn('Relocating is easy.')).toContain('relocat');
    expect(forbiddenIn('10:30 am (UK time)')).toContain('UK');
    expect(forbiddenIn('Earn $300k')).toContain('dollar figure');
    expect(forbiddenIn('70% of billings')).toContain('percentage');
    expect(forbiddenIn('Registered with AHPRA')).toContain('AHPRA (write Ahpra)');
    expect(forbiddenIn('AMC exam and MyIntealth')).toEqual(expect.arrayContaining(['AMC', 'MyIntealth']));
    expect(forbiddenIn('doctors from overseas')).toContain('overseas');
  });
  it('does not cry wolf', () => {
    expect(forbiddenIn('You can remove yourself from these emails.')).toEqual([]);
    expect(forbiddenIn('removed, movement, immovable, bulk billing, Ahpra')).toEqual([]);
    expect(forbiddenIn('a duke, a tuk-tuk, Auckland time, London time')).toEqual([]);
    expect(forbiddenIn('Sign up: https://x.test/signin?email=a%40b.test&ref=uk-visa')).toEqual([]); // a link is not prose
  });
});

describe('WP-16: every Australian-segment message, every segment', () => {
  const all = renderAllAuMessages('Australia/Perth');

  it.runIf(WRITE)('writes the snapshot and the copy deck', () => {
    fs.writeFileSync(FIXTURE, JSON.stringify(all, null, 2) + '\n');
    fs.writeFileSync(DECK, renderCopyDeck());
  });

  it('matches the committed snapshot (a change of wording is a reviewed change)', () => {
    expect(all).toEqual(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')));
  });

  it('the copy deck the owner reads is exactly what the code sends', () => {
    expect(fs.readFileSync(DECK, 'utf8')).toBe(renderCopyDeck());
  });

  it('covers every message id for every Australian segment', () => {
    expect(Object.keys(all.messages)).toEqual(AU_SEGMENTS);
    AU_SEGMENTS.forEach((seg) => expect(Object.keys(all.messages[seg])).toEqual(auLeadCopy.MESSAGE_IDS));
    expect(auLeadCopy.MESSAGE_IDS).toEqual(['booking_link', 'booking_link_generic', 'n01_5m', 'n01_1h', 'n01_24h', 'n02_booked',
      'n02_reminder_day', 'n02_reminder_hour', 'n02_noshow', 'n03_after_call', 'n03_week1', 'n03_week2', 'n03_week3']);
  });

  AU_SEGMENTS.forEach((segment) => {
    auLeadCopy.MESSAGE_IDS.forEach((id) => {
      it(segment + ' / ' + id + ': no "move", "visa", "relocat", "UK", no section 4 word, no $ or %, in any zone', () => {
        SAMPLE_ZONES.forEach((zone) => {
          const r = renderOne(id, segment, zone);
          if (!r.sent) return;
          const everything = [r.subject, r.title, r.text, r.html ? htmlToText(r.html) : '', r.button].join('\n');
          expect(forbiddenIn(everything), segment + ' ' + id + ' ' + zone + ':\n' + everything).toEqual([]);
        });
      });
    });
  });

  it('the time names the doctor\'s city, including for a doctor who is abroad', () => {
    expect(renderOne('n02_reminder_day', 'au_vr', 'Australia/Perth').subject).toBe('Your GP Link call: Thursday 14 January, 10:30 am (Perth time)');
    expect(renderOne('n02_reminder_day', 'au_vr', 'Australia/Sydney').subject).toContain('1:30 pm (Sydney time)');
    expect(renderOne('n02_reminder_day', 'au_vr', 'Europe/London').subject).toContain('2:30 am (London time)');
    expect(renderOne('n02_reminder_hour', 'au_vr', 'Australia/Adelaide').subject).toBe('Your GP Link call is in about an hour (1:00 pm (Adelaide time))');
    expect(renderOne('n02_noshow', 'au_unknown', 'Australia/Darwin').text).toContain('Thursday 14 January at 12:00 pm (Darwin time)');
    expect(renderOne('n02_booked', 'au_vr', 'Australia/Perth').subject).toBe('Your GP Link call is booked: Thursday 14 January, 10:30 am (Perth time)');
  });

  it('every message carries the confidentiality line in its agreed wording (the one-hour reminder is only the join link)', () => {
    expect(auLeadCopy.CONFIDENTIALITY_LINE).toBe('We never contact your current practice without asking you first.');
    AU_SEGMENTS.forEach((segment) => {
      auLeadCopy.MESSAGE_IDS.forEach((id) => {
        const r = all.messages[segment][id];
        if (!r.sent || id === 'n02_reminder_hour') return;
        expect(r.text, segment + ' ' + id).toContain(auLeadCopy.CONFIDENTIALITY_LINE);
      });
    });
  });

  it('au_vr and au_unknown read the same words (the main copy is true for any Ahpra-registered doctor)', () => {
    expect(all.messages.au_unknown).toEqual(all.messages.au_vr);
    // ... and it never asserts the doctor's own status.
    const text = JSON.stringify(all.messages.au_unknown);
    expect(text).not.toMatch(/vocationally registered|as a VR GP|FRACGP|FACRRM|you are eligible|unrestricted/i);
  });

  it('the unlaunched segments get the careful wording: no promise about roles, and the weekly matching emails are not sent', () => {
    ['au_restricted', 'au_non_vr', 'au_registrar'].forEach((segment) => {
      expect(auLeadCopy.segmentGroup(segment)).toBe('safe');
      ['n03_week1', 'n03_week2', 'n03_week3'].forEach((id) => {
        expect(all.messages[segment][id]).toEqual({ sent: false, reason: 'au_segment_not_launched' });
        expect(auLeadCopy.messagePlan(id, segment)).toEqual({ send: false, group: 'safe', reason: 'au_segment_not_launched' });
      });
      auLeadCopy.MESSAGE_IDS.forEach((id) => {
        const r = all.messages[segment][id];
        if (!r.sent) return;
        const words = [r.subject, r.title, r.text, r.htmlText || ''].join('\n');
        expect(words, segment + ' ' + id).not.toMatch(/\broles?\b|\bmatch(ed|ing)?\b|better-fitting|next practice|Interview|Start date/i);
        if (id !== 'n02_reminder_hour') expect(words, segment + ' ' + id).toMatch(/fits your registration|your registration details/);
      });
      expect(all.messages[segment]).toEqual(all.messages.au_restricted);
    });
    // An Australian segment nobody has heard of gets the careful wording too.
    expect(auLeadCopy.segmentGroup('au_something_new')).toBe('safe');
    expect(auLeadCopy.segmentGroup('')).toBe('safe');
  });

  it('no message promises a role or pay, or says the current employer will be contacted', () => {
    const text = JSON.stringify(all.messages);
    expect(text).not.toMatch(/guarantee|we have a role|roles? (are|is) waiting|hiring right now|before it.s taken|limited (places|number)|holding your place|salary|\bearn(ing|ings|s)?\b|per year|a year\b/i);
    expect(text).not.toMatch(/we (will|may|might) (contact|call|speak to|talk to) your (current )?(practice|employer)/i);
    expect(text).not.toMatch(/AHPRA, AMC|already solved|Guided registration|Working in Australia/);
  });

  it('the journey is Booked, Account, Matched, Interview, Start date', () => {
    expect(auLeadCopy.JOURNEY_STEPS.map((s) => s.title)).toEqual(['Booked', 'Account', 'Matched', 'Interview', 'Start date']);
    const week1 = renderOne('n03_week1', 'au_vr');
    ['1. Booked', '2. Account (you are here)', '3. Matched', '4. Interview', '5. Start date'].forEach((s) => expect(week1.text).toContain(s));
    expect(htmlToText(week1.html)).toContain('Account · you are here');
  });

  it('the overseas day-7 email is replaced, never sent: the Australian week-1 email shares none of its words', () => {
    const week1 = renderOne('n03_week1', 'au_vr');
    expect(week1.subject).toBe('What happens after you create your account');
    expect(week1.text + htmlToText(week1.html)).not.toMatch(/roadmap|checklist|registration maze|scary/i);
  });
});

describe('WP-16: the proposed WhatsApp templates', () => {
  const proposed = auLeadCopy.PROPOSED_WHATSAPP_TEMPLATES;

  it('there is one row, not approved, for every consult WhatsApp a lead can be sent', () => {
    const leadKinds = Object.keys(consultWhatsapp.CONSULT_WA_TEMPLATES).filter((k) => !/^reg_/.test(k) && k !== 'owner_lead_alert');
    expect(Object.keys(proposed).sort()).toEqual(leadKinds.map((k) => 'lead_' + k).sort());
    Object.keys(proposed).forEach((key) => {
      const row = auWhatsAppTemplates.AU_WHATSAPP_TEMPLATES[key];
      expect(row, key).toBeTruthy();
      expect(row.approved, key).toBe(false);
      expect(row.templateName, key).toMatch(/^gp_link_au_lead_/);
      // Never an overseas template name.
      expect(Object.keys(consultWhatsapp.CONSULT_WA_TEMPLATES).map((k) => consultWhatsapp.CONSULT_WA_TEMPLATES[k].templateName)).not.toContain(row.templateName);
    });
  });

  it('each takes the same number of variables as the overseas template for the same touch', () => {
    const ctx = { name: 'Jane Citizen', callAtIso: '2027-01-14T02:30:00Z', whenText: 'x', bookUrl: 'https://b', joinUrl: 'https://j', signupUrl: 'https://s' };
    Object.keys(proposed).forEach((key) => {
      const kind = key.replace(/^lead_/, '');
      const built = consultWhatsapp.buildConsultWaMessage(kind, ctx);
      const slots = (proposed[key].body.match(/\{\{\d\}\}/g) || []).filter((v, i, a) => a.indexOf(v) === i);
      expect(slots.length, key).toBe(built.placeholders.length);
      expect(proposed[key].placeholders.length, key).toBe(built.placeholders.length);
    });
  });

  it('their fixed words keep every rule the emails keep', () => {
    Object.keys(proposed).forEach((key) => {
      expect(forbiddenIn(proposed[key].body), key).toEqual([]);
      expect(proposed[key].body, key).not.toMatch(/guarantee|salary|\broles? (are|is) waiting/i);
    });
  });
});

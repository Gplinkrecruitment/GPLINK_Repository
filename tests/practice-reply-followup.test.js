import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
const lib = require('../lib/practice-reply-followup.js');
const server = require('../server.js');

const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const adminSrc = readFileSync(new URL('../pages/admin.html', import.meta.url), 'utf8');
const ceoSrc = readFileSync(new URL('../pages/ceo-dashboard.html', import.meta.url), 'utf8');

describe('plainTextToHtml', () => {
  it('escapes HTML before converting newlines so a reply cannot inject markup', () => {
    const html = lib.plainTextToHtml('Hi <script>alert(1)</script>\nSecond line');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<br>');
  });

  it('turns a blank line into a paragraph break and a single newline into <br>', () => {
    expect(lib.plainTextToHtml('One\n\nTwo')).toBe('One<br><br>Two');
    expect(lib.plainTextToHtml('One\nTwo')).toBe('One<br>Two');
  });

  it('returns empty string for blank input', () => {
    expect(lib.plainTextToHtml('')).toBe('');
    expect(lib.plainTextToHtml(null)).toBe('');
    expect(lib.plainTextToHtml('   \n  ')).toBe('');
  });
});

describe('parsePracticeReplyResult', () => {
  it('parses a clean JSON answer and normalises the outcome', () => {
    const out = lib.parsePracticeReplyResult(JSON.stringify({
      outcome: 'Delegated',
      summary: 'Chamira asked Naomi to send his CV.',
      handed_to: 'Naomi',
      suggested_subject: 'Re: Supervisor CV for Dr Mercy Obanimoh',
      suggested_reply: 'Hi Chamira,\n\nThanks for organising that.',
    }));
    expect(out.outcome).toBe('delegated');
    expect(out.handed_to).toBe('Naomi');
    expect(out.suggested_reply).toContain('Thanks for organising that.');
  });

  it('tolerates ```json fences and surrounding prose', () => {
    const out = lib.parsePracticeReplyResult('Sure!\n```json\n{"outcome":"will_send_later","suggested_reply":"Thanks."}\n```\n');
    expect(out).not.toBeNull();
    expect(out.outcome).toBe('will_send_later');
  });

  it('falls back to "unclear" for an outcome it does not recognise', () => {
    const out = lib.parsePracticeReplyResult('{"outcome":"banana","suggested_reply":"Hello."}');
    expect(out.outcome).toBe('unclear');
  });

  it('returns null when there is no usable draft, so the caller uses the deterministic one', () => {
    expect(lib.parsePracticeReplyResult('')).toBeNull();
    expect(lib.parsePracticeReplyResult('no json here')).toBeNull();
    expect(lib.parsePracticeReplyResult('{"outcome":"delegated"}')).toBeNull();
    expect(lib.parsePracticeReplyResult('{"outcome":"delegated","suggested_reply":"   "}')).toBeNull();
  });
});

describe('buildFallbackFollowup', () => {
  it('acknowledges the reply instead of repeating the original request', () => {
    const out = lib.buildFallbackFollowup({
      docTitle: 'Supervisor CV',
      gpName: 'Mercy Obanimoh',
      contactName: 'Chamira',
      rsoName: 'Hazel',
      signRequirement: 'Please make sure the CV is dated and signed by the supervisor.',
    });
    expect(out.suggested_reply).toContain('Thank you for coming back to us');
    expect(out.suggested_reply).toContain('Supervisor CV');
    expect(out.suggested_reply).toContain('Hazel — GP Link Registration Team');
    // The whole point: it must NOT be the first-contact request email.
    expect(out.suggested_reply).not.toContain('We are preparing the registration documents');
    expect(out.source).toBe('fallback');
  });

  it('still produces a usable draft with no names supplied', () => {
    const out = lib.buildFallbackFollowup({});
    expect(out.suggested_reply).toContain('Hi there,');
    expect(out.suggested_subject).toContain('Re:');
  });
});

describe('buildPracticeReplyMessages', () => {
  it('forbids re-sending the original request and asks for JSON back', () => {
    const { system, userText } = lib.buildPracticeReplyMessages({
      docTitle: 'Supervisor CV',
      gpName: 'Mercy Obanimoh',
      contactName: 'Chamira',
      rsoName: 'Hazel',
      replyText: 'Hi Naomi, could you kindly organise for my CV to be emailed to them',
      replySender: 'chamiraranatunga@yahoo.com',
    });
    const systemText = system[0].text;
    expect(systemText).toContain('NEVER re-send the original request');
    expect(systemText).toContain('delegated');
    expect(systemText).toContain('"suggested_reply"');
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(userText).toContain('could you kindly organise for my CV');
    expect(userText).toContain('Supervisor CV');
    expect(userText).toContain('Hazel');
  });

  it('keeps the reply text bounded so one huge email cannot blow the prompt', () => {
    const { userText } = lib.buildPracticeReplyMessages({ docTitle: 'X', gpName: 'Y', replyText: 'z'.repeat(20000) });
    expect(userText.length).toBeLessThan(12000);
  });

  // Owner report 2026-08-10 (Dr Mercy Obanimoh / Position Description): the practice CC'd
  // their practice manager on the reply and the draft still asked "would you be able to
  // share Naomi's email address with us?". The model was right given what it was told —
  // the FACTS block never listed anyone but the sender.
  it('tells the model who else is already on the thread', () => {
    const { userText } = lib.buildPracticeReplyMessages({
      docTitle: 'Position Description',
      gpName: 'Mercy Obanimoh',
      replyText: 'Naomi fyi could you do this Monday?',
      replySender: 'chamiraranatunga@yahoo.com',
      knownContacts: [{ email: 'pm@thefamilydoctors.com.au', name: 'Practice Manager' }],
    });
    expect(userText).toContain('others_on_the_email_thread');
    expect(userText).toContain('Practice Manager <pm@thefamilydoctors.com.au>');
  });

  it('accepts the CC picker\'s {email_address,display_name} shape too', () => {
    const { userText } = lib.buildPracticeReplyMessages({
      docTitle: 'Position Description',
      gpName: 'Mercy Obanimoh',
      replyText: 'x',
      knownContacts: [{ email_address: 'pm@thefamilydoctors.com.au', display_name: 'Naomi' }],
    });
    expect(userText).toContain('Naomi <pm@thefamilydoctors.com.au>');
  });

  it('leaves others_on_the_email_thread null when we genuinely have nobody else', () => {
    const { userText } = lib.buildPracticeReplyMessages({
      docTitle: 'Position Description', gpName: 'Mercy Obanimoh', replyText: 'x', knownContacts: [],
    });
    expect(userText).toContain('"others_on_the_email_thread": null');
  });

  it('instructs the model NOT to ask for an address that is already on the thread', () => {
    const { system } = lib.buildPracticeReplyMessages({ docTitle: 'X', gpName: 'Y', replyText: 'z' });
    const systemText = system[0].text;
    expect(systemText).toContain('others_on_the_email_thread');
    expect(systemText).toContain('do NOT ask for it');
    // The escape hatch must survive: when we really do lack the address, still ask.
    expect(systemText).toContain('Only ask for the address when the person is genuinely not in that list');
  });
});

describe('outcomeGuidance', () => {
  it('explains a delegation as still needing a chase', () => {
    expect(lib.outcomeGuidance('delegated')).toContain('still needs chasing');
  });
  it('explains pasted content as still needing the document', () => {
    expect(lib.outcomeGuidance('content_in_body')).toContain('we still need it as a document');
  });
  it('has a safe default for anything unrecognised', () => {
    expect(lib.outcomeGuidance('who_knows')).toContain('No document was attached');
  });
});

describe('server wiring', () => {
  it('records the practice reply from BOTH inbound-mail match paths', () => {
    const calls = serverSrc.match(/_recordPracticeReplyFollowup\(/g) || [];
    // definition + early thread-match path + response-match path + the draft endpoint
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(serverSrc).toContain('Early match practice reply follow-up failed');
    expect(serverSrc).toContain('[ResponseMatch] Practice reply follow-up failed');
  });

  it('exposes the on-demand draft endpoint for replies that predate the feature', () => {
    expect(serverSrc).toContain("pathname === '/api/admin/practice-reply/draft'");
    expect(serverSrc).toContain('No practice reply on this task yet.');
  });

  it('leaves Section G alone — it auto-delivers and has no detail panel', () => {
    expect(serverSrc).toContain("if (task.related_document_key === 'section_g') return null;");
  });

  // Owner 2026-08-19: the SPPA-00 card showed the raw email thread and no word on what it
  // meant. It now gets the same AI read as the other practice-pack tasks — but ONLY the read.
  it('reads a reply on the SPPA-00 without touching its state machine', () => {
    const fn = serverSrc.slice(
      serverSrc.indexOf('async function _recordPracticeReplyFollowup'),
      serverSrc.indexOf('async function _buildPracticeReplyDraft'),
    );
    expect(fn).toContain("var isSppa = task.related_document_key === 'sppa_00';");
    // The status nudge is the only write outside metadata.practice_reply — skipped for SPPA,
    // whose status and pill are owned by sppa_state.
    expect(fn).toContain("if (!isSppa && String(task.status || '').indexOf('waiting') === 0) firstPatch.status = 'open';");
    // Nothing in here may WRITE sppa_state (the comments name the field; the code must not set it).
    expect(fn).not.toMatch(/sppa_state\s*[:=][^=]/);
  });

  it('judges "did a document arrive" per message on the SPPA-00, which carries earlier documents', () => {
    const fn = serverSrc.slice(
      serverSrc.indexOf('async function _recordPracticeReplyFollowup'),
      serverSrc.indexOf('async function _buildPracticeReplyDraft'),
    );
    expect(fn).toContain('if (!hasDocument && !isSppa) {');
  });

  it('shows the read on the SPPA card in both dashboards, gated on the last message being inbound', () => {
    expect(adminSrc).toContain('function sppaReplyRead()');
    expect(adminSrc).toContain("if (!lastMsg || lastMsg.direction !== 'inbound') return '';");
    expect(ceoSrc).toContain("_sppaLast && _sppaLast.direction === 'inbound'");
  });

  it('writes the deterministic marker before the AI runs, so the next step is right even if AI is down', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function _recordPracticeReplyFollowup'));
    const markerAt = fn.indexOf('meta.practice_reply = {');
    const draftAt = fn.indexOf('_buildPracticeReplyDraft(');
    expect(markerAt).toBeGreaterThan(-1);
    expect(draftAt).toBeGreaterThan(markerAt);
  });

  it('falls back to the deterministic draft when the AI is unconfigured or over budget', () => {
    expect(serverSrc).toContain('if (!apiKey) return fallback;');
    expect(serverSrc).toContain('Anthropic daily budget exhausted');
  });

  it('feeds the thread participants into the draft, minus the sender and the doctor', () => {
    const fn = serverSrc.slice(serverSrc.indexOf('async function _buildPracticeReplyDraft'));
    expect(fn).toContain('collectCaseThreadContacts(caseId)');
    expect(fn).toContain('knownContacts: knownContacts');
    // The person who wrote to us is the "To", and the doctor is never a practice CC.
    expect(fn).toContain('addr === replyFromAddr');
    expect(fn).toContain('addr === gpEmail');
  });

  it('unions thread participants into the CC picker, not just the harvested table', () => {
    const ep = serverSrc.slice(serverSrc.indexOf("pathname.endsWith('/email-contacts')"));
    expect(ep).toContain('collectCaseThreadContacts(contactsCaseId)');
    // The harvested table stays a source — the thread is added on top of it, never instead.
    expect(ep).toContain('practice_detected_contacts');
  });
});

// The CC picker read only practice_detected_contacts, which records an address ONLY when it
// is on the practice's own domain AND registration_cases.practice_contact is set. In prod that
// table held 2 rows in total, so a plainly-CC'd practice manager showed as "No additional
// contacts detected". These addresses were always in task_messages.recipient.
describe('thread contact extraction', () => {
  const { parseEmailListWithNames, isOurOwnAddress } = server.__testUtils;

  it('pulls a display name and address out of a real stored recipient header', () => {
    const out = parseEmailListWithNames('registration@mygplink.com.au, Practice Manager <pm@thefamilydoctors.com.au>');
    expect(out).toEqual([
      { email: 'registration@mygplink.com.au', name: '' },
      { email: 'pm@thefamilydoctors.com.au', name: 'Practice Manager' },
    ]);
  });

  it('handles bare addresses, semicolons and quoted names', () => {
    const out = parseEmailListWithNames('"Ranatunga, Chamira" <c@yahoo.com>; b@x.com');
    expect(out.map((c) => c.email)).toEqual(['c@yahoo.com', 'b@x.com']);
    expect(out[0].name).toContain('Chamira');
  });

  it('returns nothing for blank or address-free input', () => {
    expect(parseEmailListWithNames('')).toEqual([]);
    expect(parseEmailListWithNames(null)).toEqual([]);
    expect(parseEmailListWithNames('no address here')).toEqual([]);
  });

  it('never offers one of our own addresses as a CC', () => {
    expect(isOurOwnAddress('registration@mygplink.com.au')).toBe(true);
    expect(isOurOwnAddress('hello@mygplink.com.au')).toBe(true);
    expect(isOurOwnAddress('Hazel@MyGPLink.com.au')).toBe(true);
    expect(isOurOwnAddress('')).toBe(true);
    expect(isOurOwnAddress('pm@thefamilydoctors.com.au')).toBe(false);
  });
});

describe('dashboard wiring', () => {
  for (const [name, src] of [['admin.html', adminSrc], ['ceo-dashboard.html', ceoSrc]]) {
    it(`${name}: shows the owner-specified line once the practice has replied`, () => {
      expect(src).toContain(lib.PRACTICE_REPLY_GUIDE_LINE);
      expect(src).toContain(lib.PRACTICE_DOC_RECEIVED_GUIDE_LINE);
    });

    it(`${name}: checks practice_reply BEFORE the "Email the practice requesting" fallbacks`, () => {
      const replyAt = src.indexOf('practice_reply');
      const pdRequestAt = src.indexOf('Email the practice requesting the Position Description');
      const cvRequestAt = src.indexOf("Email the practice requesting the ' + docLabel");
      expect(replyAt).toBeGreaterThan(-1);
      expect(replyAt).toBeLessThan(pdRequestAt);
      if (cvRequestAt > -1) expect(replyAt).toBeLessThan(cvRequestAt);
    });

    it(`${name}: stands down once we have answered (waiting_* status wins)`, () => {
      expect(src).toMatch(/indexOf\('waiting'\) !== 0|indexOf\('waiting'\)!==0/);
    });

    it(`${name}: only claims "they just replied" while the last message is theirs`, () => {
      expect(src).toMatch(/awaitingOurReply/);
      expect(src).toMatch(/lastMsg && lastMsg\.direction === 'inbound'|lastMsg&&lastMsg\.direction==='inbound'/);
    });

    it(`${name}: offers a follow-up draft button wired to the draft endpoint`, () => {
      expect(src).toContain('data-ops-practice-draft');
      expect(src).toContain('/api/admin/practice-reply/draft');
    });

    it(`${name}: escapes the AI draft before putting it in the composer`, () => {
      expect(src).toMatch(/esc\(p\)\.replace\(\/\\n\/g, ?'<br>'\)/);
    });
  }
});

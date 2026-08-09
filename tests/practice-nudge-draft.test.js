// Owner report 2026-08-10 (Dr Mercy Obanimoh / Supervisor CV): "Nudge Practice" opened a
// composer pre-filled with a hardcoded "Just following up on our earlier email regarding
// the Supervisor CV…" — on a thread where the practice had already replied TWICE and named
// the colleague who would send the document. Sent unedited it reads as though we never
// opened their emails.
//
// These tests pin the two halves of the fix:
//   A. the thread is rendered into the prompt faithfully (order, who-said-what, no quoted
//      chain blowing the budget), and the prompt forbids the tone-deaf failure modes;
//   B. an AI outage degrades to EXACTLY the old wording rather than to an empty box.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
const lib = require('../lib/practice-nudge-draft.js');
const replyLib = require('../lib/practice-reply-followup.js');

const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const adminSrc = readFileSync(new URL('../pages/admin.html', import.meta.url), 'utf8');

// Shape of the real Mercy Obanimoh / Supervisor CV thread (prod, 2026-07-30 → 2026-08-08).
const THREAD = [
  {
    direction: 'outbound', sender: 'registration@mygplink.com.au', created_at: '2026-07-29T21:08:00Z',
    body_html: 'Hi Dr Chamira Ranatunga,<br><br>We are preparing the registration documents for Dr Mercy Obanimoh and need the following: Supervisor CV.',
  },
  {
    direction: 'inbound', sender: 'chamiraranatunga@yahoo.com', created_at: '2026-07-30T02:33:17Z',
    body_text: 'Hi Naomi,\n\nCould you kindly organise for my CV to be emailed to them\n\nThanks\nChamira\n\n> On 30 Jul 2026, at 7:08 am, Hazel, GP Link <registration@mygplink.com.au> wrote:\n> \n> Hi Dr Chamira Ranatunga,\n> We are preparing the registration documents',
  },
  {
    direction: 'inbound', sender: 'chamiraranatunga@yahoo.com', created_at: '2026-08-02T05:03:18Z',
    body_text: 'Hi ,\nHerewith I have cc’d Naomi’s email address.\n\nThanks\nChamira',
  },
  {
    direction: 'outbound', sender: 'registration@mygplink.com.au', created_at: '2026-08-08T05:44:05Z',
    body_html: 'Hi Dr Ranatunga,<br><br>Thank you for looping Naomi in — that’s great.',
  },
];

describe('stripQuotedTail', () => {
  it('drops the "On <date> … wrote:" chain the practice replied above', () => {
    const out = lib.stripQuotedTail(THREAD[1].body_text);
    expect(out).toContain('Could you kindly organise for my CV');
    expect(out).not.toContain('We are preparing the registration documents');
    expect(out).not.toContain('wrote:');
  });

  it('drops leftover quoted "> " lines', () => {
    expect(lib.stripQuotedTail('Real line\n> quoted line\n> more quoting')).toBe('Real line');
  });

  it('leaves an unquoted body untouched and is safe on blanks', () => {
    expect(lib.stripQuotedTail('Just this.')).toBe('Just this.');
    expect(lib.stripQuotedTail('')).toBe('');
    expect(lib.stripQuotedTail(null)).toBe('');
  });
});

describe('htmlToText', () => {
  it('turns our stored body_html into readable text', () => {
    expect(lib.htmlToText('Hi there,<br><br>Line two &amp; three')).toBe('Hi there,\n\nLine two & three');
  });
});

describe('formatThreadForPrompt', () => {
  it('renders oldest-first and labels who actually sent each message', () => {
    const out = lib.formatThreadForPrompt(THREAD);
    const usFirst = out.indexOf('US (GP Link)');
    const practiceNext = out.indexOf('THE PRACTICE (chamiraranatunga@yahoo.com)');
    expect(usFirst).toBeGreaterThan(-1);
    expect(practiceNext).toBeGreaterThan(usFirst); // chronological, not grouped
    expect(out).toContain('[2026-07-30]');
    expect(out).toContain('Herewith I have cc');
  });

  it('sorts by date even when the rows arrive newest-first from PostgREST', () => {
    const reversed = THREAD.slice().reverse();
    expect(lib.formatThreadForPrompt(reversed)).toBe(lib.formatThreadForPrompt(THREAD));
  });

  it('keeps the MOST RECENT messages when the thread is too long to fit', () => {
    const many = [];
    for (let i = 0; i < 30; i++) {
      many.push({
        direction: i % 2 ? 'inbound' : 'outbound', sender: 'x@y.com',
        created_at: '2026-07-' + String(i + 1).padStart(2, '0') + 'T00:00:00Z',
        body_text: 'message number ' + i,
      });
    }
    const out = lib.formatThreadForPrompt(many);
    expect(out).toContain('message number 29');  // newest survives
    expect(out).not.toContain('message number 0\n'); // oldest dropped
  });

  it('is safe on an empty thread', () => {
    expect(lib.formatThreadForPrompt([])).toBe('');
    expect(lib.formatThreadForPrompt(null)).toBe('');
  });
});

describe('buildPracticeNudgeMessages', () => {
  const built = () => lib.buildPracticeNudgeMessages({
    docTitle: 'Supervisor CV',
    signRequirement: 'Please make sure the CV is dated and signed by the supervisor.',
    gpName: 'Mercy Obanimoh',
    contactName: 'Dr Ranatunga',
    rsoName: 'Hazel',
    threadText: lib.formatThreadForPrompt(THREAD),
    daysSinceLastContact: 1,
    practiceEverReplied: true,
    knownContacts: [{ email_address: 'pm@thefamilydoctors.com.au', display_name: 'Practice Manager' }],
  });

  it('forbids thanking them for a reply that never came', () => {
    const systemText = built().system[0].text;
    expect(systemText).toContain('THEY HAVE NOT REPLIED');
    expect(systemText).toContain('Never thank them for a reply that did not come');
  });

  it('tells the model to chase the specific promise, not re-ask generically', () => {
    const systemText = built().system[0].text;
    expect(systemText).toContain('chase that promise by name');
    expect(systemText).toContain('Do NOT restate the whole');
  });

  it('bans a colder tone and invented deadlines as silence grows', () => {
    const systemText = built().system[0].text;
    expect(systemText).toContain('no deadlines we have not actually agreed');
    expect(systemText).toContain('never a colder tone');
  });

  it('keeps internal notes out of the sendable body', () => {
    const systemText = built().system[0].text;
    expect(systemText).toContain('NEVER write a note, instruction or square-bracket placeholder');
    expect(systemText).toContain('"rso_notes"');
  });

  it('carries the thread and the grounding facts', () => {
    const { userText } = built();
    expect(userText).toContain('THE EMAIL THREAD SO FAR');
    expect(userText).toContain('Herewith I have cc');
    expect(userText).toContain('"document_still_outstanding": "Supervisor CV"');
    expect(userText).toContain('"days_since_our_last_email": 1');
    expect(userText).toContain('"practice_has_ever_replied_on_this_thread": true');
    expect(userText).toContain('Practice Manager <pm@thefamilydoctors.com.au>');
    expect(userText).toContain('Hazel');
  });

  it('caches the static instructions, not the per-thread facts', () => {
    expect(built().system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('nulls the optional facts rather than inventing them', () => {
    const { userText } = lib.buildPracticeNudgeMessages({ docTitle: 'X', gpName: 'Y', threadText: 'z' });
    expect(userText).toContain('"days_since_our_last_email": null');
    expect(userText).toContain('"others_on_the_email_thread": null');
    expect(userText).toContain('"practice_has_ever_replied_on_this_thread": false');
  });
});

// A nudge that starts a NEW subject lands as a separate conversation in the practice's
// inbox, detached from the request it is chasing.
describe('threadReplySubject', () => {
  it('reuses the thread subject with exactly one Re:', () => {
    expect(lib.threadReplySubject('Supervisor CV needed for Dr Mercy Obanimoh - GP Link'))
      .toBe('Re: Supervisor CV needed for Dr Mercy Obanimoh - GP Link');
  });

  it('collapses a stack of Re: prefixes instead of adding another', () => {
    expect(lib.threadReplySubject('Re: Re: RE: Supervisor CV')).toBe('Re: Supervisor CV');
    expect(lib.threadReplySubject('Re[2]: Supervisor CV')).toBe('Re: Supervisor CV');
  });

  it('returns empty for nothing usable, so the caller keeps its own subject', () => {
    expect(lib.threadReplySubject('')).toBe('');
    expect(lib.threadReplySubject(null)).toBe('');
    expect(lib.threadReplySubject('  Re:  ')).toBe('');
  });
});

describe('rso_notes are held to the same evidence rule', () => {
  // First live run wrote "It's been 6 days since our last email" when the fact said 1.
  it('forbids an elapsed time other than the supplied fact', () => {
    const { system } = lib.buildPracticeNudgeMessages({ docTitle: 'X', gpName: 'Y', threadText: 'z' });
    expect(system[0].text).toContain('Never state an elapsed time');
    expect(system[0].text).toContain('days_since_our_last_email');
  });
});

describe('parsePracticeNudgeResult', () => {
  it('parses a clean answer', () => {
    const out = lib.parsePracticeNudgeResult(JSON.stringify({
      suggested_subject: 'Re: Supervisor CV needed for Dr Mercy Obanimoh',
      suggested_reply: 'Hi Dr Ranatunga,\n\nYou mentioned Naomi would send your CV through.',
      rso_notes: '',
    }));
    expect(out.suggested_subject).toContain('Supervisor CV');
    expect(out.suggested_reply).toContain('You mentioned Naomi');
    expect(out.rso_notes).toBe('');
  });

  it('tolerates ```json fences and surrounding prose', () => {
    const out = lib.parsePracticeNudgeResult('Sure!\n```json\n{"suggested_reply":"Body here"}\n```\n');
    expect(out.suggested_reply).toBe('Body here');
  });

  // The exact leak that reached Dr Ranatunga on 8 Aug — it must never survive into the body.
  it('lifts an inlined [RSO: …] note out of the body and into the notes', () => {
    const out = lib.parsePracticeNudgeResult(JSON.stringify({
      suggested_reply: 'Hi there, [RSO: check the cc field for Naomi] thanks for your help.',
      rso_notes: '',
    }));
    expect(out.suggested_reply).not.toContain('[RSO');
    expect(out.rso_notes).toContain('check the cc field');
  });

  it('returns null on junk so the caller can fall back', () => {
    expect(lib.parsePracticeNudgeResult('')).toBeNull();
    expect(lib.parsePracticeNudgeResult('not json at all')).toBeNull();
    expect(lib.parsePracticeNudgeResult('{"suggested_reply":""}')).toBeNull();
  });
});

describe('buildFallbackNudge', () => {
  // Degrading to the OLD wording (not an empty box) is the whole safety property.
  it('reproduces the historical hardcoded nudge exactly', () => {
    const out = lib.buildFallbackNudge({
      docTitle: 'Supervisor CV', gpName: 'Mercy Obanimoh', contactName: 'Dr Ranatunga',
      rsoName: 'Hazel', signRequirement: 'Please make sure the CV is dated and signed by the supervisor.',
    });
    expect(out.suggested_subject).toBe('Follow-up: Supervisor CV for Dr Mercy Obanimoh');
    expect(out.suggested_reply).toContain('Just following up on our earlier email regarding the Supervisor CV for Dr Mercy Obanimoh.');
    expect(out.suggested_reply).toContain('We need this document to proceed with their registration.');
    expect(out.suggested_reply).toContain('Please make sure the CV is dated and signed by the supervisor.');
    expect(out.suggested_reply).toContain('Hazel — GP Link Registration Team');
    expect(out.source).toBe('fallback');
  });

  it('still reads properly with no contact name or RSO', () => {
    const out = lib.buildFallbackNudge({ docTitle: 'X', gpName: 'Y' });
    expect(out.suggested_reply).toContain('Hi there,');
    expect(out.suggested_reply).toContain('GP Link Registration Team');
  });
});

describe('shared draft envelope', () => {
  it('the reply drafter and the nudge drafter strip internal notes the same way', () => {
    const payload = JSON.stringify({
      outcome: 'delegated',
      suggested_reply: 'Body text [RSO: internal aside] continues.',
      rso_notes: '',
    });
    const asReply = replyLib.parsePracticeReplyResult(payload);
    const asNudge = lib.parsePracticeNudgeResult(payload);
    expect(asReply.suggested_reply).not.toContain('[RSO');
    expect(asNudge.suggested_reply).not.toContain('[RSO');
    expect(asReply.suggested_reply).toBe(asNudge.suggested_reply);
  });
});

describe('server wiring', () => {
  it('exposes the nudge draft endpoint behind an admin session and RSO scoping', () => {
    expect(serverSrc).toContain("pathname === '/api/admin/practice-nudge/draft'");
    const ep = serverSrc.slice(serverSrc.indexOf("pathname === '/api/admin/practice-nudge/draft'"));
    expect(ep).toContain('requireAdminSession');
    expect(ep).toContain('taskVisibleToRso');
  });

  it('always answers with a usable draft — no API key, no budget, bad JSON all fall back', () => {
    const ep = serverSrc.slice(serverSrc.indexOf("pathname === '/api/admin/practice-nudge/draft'"));
    expect(ep).toContain('if (!apiKeyPn) { sendJson(res, 200, { ok: true, nudge: pnFallback }); return; }');
    expect(ep).toContain('Anthropic daily budget exhausted');
    expect(ep).toContain('if (!pnDraft) { sendJson(res, 200, { ok: true, nudge: pnFallback }); return; }');
  });

  it('reads the whole thread, both directions', () => {
    const ep = serverSrc.slice(serverSrc.indexOf("pathname === '/api/admin/practice-nudge/draft'"));
    expect(ep).toContain('formatThreadForPrompt(pnMsgs)');
    expect(ep).toContain("'select=direction,sender,subject,created_at,body_text,body_html&task_id='");
  });

  it('forces the thread subject over anything the model wrote, so the chase stays in-thread', () => {
    const ep = serverSrc.slice(serverSrc.indexOf("pathname === '/api/admin/practice-nudge/draft'"));
    expect(ep).toContain('threadReplySubject(pnMsgs[pnSi].subject)');
    expect(ep).toContain('pnDraft.suggested_subject = pnThreadSubject || pnDraft.suggested_subject');
  });
});

describe('admin wiring', () => {
  it('drafts when the composer opens and offers an explicit re-draft', () => {
    expect(adminSrc).toContain('data-ops-nudge-toggle');
    expect(adminSrc).toContain('data-ops-nudge-draft');
    expect(adminSrc).toContain('opsEnsureNudgeDraft');
    expect(adminSrc).toContain("'/api/admin/practice-nudge/draft'");
  });

  // The toggle was an inline onclick, which worked in every render context for free.
  // Both delegated listeners (Ops Queue + GP Profile) must now handle it.
  it('handles the toggle in BOTH the ops queue and the GP profile listeners', () => {
    const matches = adminSrc.match(/closest\("\[data-ops-nudge-toggle\]"\)/g) || [];
    expect(matches.length).toBe(2);
  });

  it('renders RSO notes outside the sendable body', () => {
    expect(adminSrc).toContain('opsNudgeNotes_');
    expect(adminSrc).toContain('Check before sending — not part of the email');
  });
});

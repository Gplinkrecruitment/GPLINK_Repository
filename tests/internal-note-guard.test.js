import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  RSO_NOTES_MARKER,
  findInternalNotes,
  hasInternalNote,
  stripInternalNotes,
  splitDraftAndNotes,
  internalNoteBlockMessage
} from '../lib/internal-note-guard.js';
import { parsePracticeReplyResult, buildFallbackFollowup } from '../lib/practice-reply-followup.js';
import { GROUNDING_RULES, buildSystemBlocks } from '../lib/suggest-reply-prompt.js';

/*
 * Dr Ranatunga received this from us, in a real sent email:
 *
 *   "Hi Dr Ranatunga, Thank you for looping Naomi in — that's great. [RSO: please check
 *    the cc field of Dr Ranatunga's email for Naomi's address. If it is visible, note it
 *    down so we can follow up with Naomi directly if needed. If the cc address is not
 *    visible, we may need to ask again.] Just a gentle note — we do need Dr Ranatunga's
 *    CV (dated and signed) as the document we requested."
 *
 * The bracketed sentence was an instruction to the RSO, written into the body by the
 * drafting AI because BOTH prompts asked for exactly that ("flag what the RSO must
 * confirm, e.g. [RSO: please confirm whether X]"). The composer sends the body verbatim.
 *
 * Notes to staff now travel beside a draft, never inside it, and three independent
 * layers have to fail before this can repeat: the prompts, the split before the draft
 * reaches the composer, and a refusal at the send endpoints.
 */

const ROOT = path.resolve(__dirname, '..');
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(ROOT, 'pages/admin.html'), 'utf8');
const ceoHtml = fs.readFileSync(path.join(ROOT, 'pages/ceo-dashboard.html'), 'utf8');

// The email as it actually went out.
const THE_SENT_EMAIL = "Hi Dr Ranatunga, Thank you for looping Naomi in — that's great. " +
  "[RSO: please check the cc field of Dr Ranatunga's email for Naomi's address. If it is " +
  "visible, note it down so we can follow up with Naomi directly if needed. If the cc " +
  "address is not visible, we may need to ask again.] Just a gentle note — we do need Dr " +
  "Ranatunga's CV (dated and signed) as the document we requested.";

/* ── what counts as an internal note ─────────────────────────────────────── */

describe('findInternalNotes', () => {
  it('catches the note that actually reached Dr Ranatunga', () => {
    const found = findInternalNotes(THE_SENT_EMAIL);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('please check the cc field');
    expect(hasInternalNote(THE_SENT_EMAIL)).toBe(true);
  });

  it('catches the other shapes a draft reaches for', () => {
    [
      '[RSO: please confirm whether the CV was signed]',
      '[RSO please confirm the date]',
      '[Note to RSO: check the AHPRA portal first]',
      '[note for the VA: chase this Friday]',
      '[Internal: do not send until the contract lands]',
      '[Internal note — she has not paid yet]',
      '[Staff note: this practice is difficult]',
      '[Admin: verify the address]',
      '[TODO: add the reference number]',
      '[VA: ring her first]'
    ].forEach((note) => {
      expect(hasInternalNote('Hi Doctor,\n\n' + note + '\n\nKind regards'), note).toBe(true);
    });
  });

  it('leaves ordinary brackets in a real email alone', () => {
    [
      'Please send your CV [PDF or Word is fine].',
      'Your specialty is listed as [Internal Medicine] on the form.',
      'See the attached form [1] and the checklist [2].',
      'The fee is $560 (AHPRA) [correct as at July].',
      'Dr Smith [the supervisor] will sign it.',
      'We have received your CV (dated and signed) as the document we requested.',
      'RSO Hazel will be in touch shortly.',
      'Our internal team has reviewed it.'
    ].forEach((text) => {
      expect(hasInternalNote(text), text).toBe(false);
    });
  });

  it('does not answer differently on a second call', () => {
    // A shared /g regex carries lastIndex between .test() calls; this is that bug.
    for (let i = 0; i < 4; i++) expect(hasInternalNote(THE_SENT_EMAIL)).toBe(true);
  });

  it('handles empty input', () => {
    [null, undefined, '', '   '].forEach((v) => {
      expect(findInternalNotes(v)).toEqual([]);
      expect(hasInternalNote(v)).toBe(false);
    });
  });

  it('cannot let one stray bracket swallow the rest of the email', () => {
    const text = 'Hi Doctor, [RSO: check this] and here is the rest [see attached] of the email.';
    expect(stripInternalNotes(text)).toContain('[see attached]');
    expect(stripInternalNotes(text)).toContain('rest');
  });
});

/* ── removing one leaves a readable email ────────────────────────────────── */

describe('stripInternalNotes', () => {
  it('reads correctly once the note is gone', () => {
    const cleaned = stripInternalNotes(THE_SENT_EMAIL);
    expect(cleaned).not.toContain('[RSO');
    expect(cleaned).not.toContain('cc field');
    expect(cleaned).toContain("Thank you for looping Naomi in");
    expect(cleaned).toContain("we do need Dr Ranatunga's CV");
    expect(cleaned).not.toMatch(/ {2,}/);        // no gap where the note was
    expect(cleaned).not.toMatch(/\s+[.,]/);      // no orphaned punctuation
  });

  it('does not leave a hole in the paragraph structure', () => {
    const text = 'Hi Doctor,\n\n[RSO: confirm the date]\n\nYour CV has been received.\n\nKind regards';
    const cleaned = stripInternalNotes(text);
    expect(cleaned).not.toMatch(/\n{3,}/);
    expect(cleaned).toBe('Hi Doctor,\n\nYour CV has been received.\n\nKind regards');
  });
});

/* ── the draft is split before it can be sent ────────────────────────────── */

describe('splitDraftAndNotes', () => {
  it('separates the notes block the prompts now ask for', () => {
    const raw = 'Hi Doctor,\n\nYour CV has been received.\n\nKind regards\nHazel\n\n' +
      RSO_NOTES_MARKER + '\nCheck whether the CV was actually signed before sending.';
    const { body, notes } = splitDraftAndNotes(raw);
    expect(body).toBe('Hi Doctor,\n\nYour CV has been received.\n\nKind regards\nHazel');
    expect(body).not.toContain('RSO NOTES');
    expect(notes).toEqual(['Check whether the CV was actually signed before sending.']);
  });

  it('lifts an inline note out when the model ignores the marker', () => {
    const { body, notes } = splitDraftAndNotes(THE_SENT_EMAIL);
    expect(hasInternalNote(body)).toBe(false);
    expect(body).toContain("Thank you for looping Naomi in");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('please check the cc field');
    expect(notes[0].startsWith('[')).toBe(false); // brackets stripped for display
  });

  it('handles both at once', () => {
    const raw = 'Hi Doctor, [RSO: confirm the date] your CV is fine.\n\n' + RSO_NOTES_MARKER + '\nAlso chase the degree.';
    const { body, notes } = splitDraftAndNotes(raw);
    expect(hasInternalNote(body)).toBe(false);
    expect(notes).toHaveLength(2);
    expect(notes.join(' ')).toContain('Also chase the degree');
    expect(notes.join(' ')).toContain('confirm the date');
  });

  it('is a no-op on a clean draft', () => {
    const clean = 'Hi Doctor,\n\nYour CV has been received.\n\nKind regards\nHazel';
    expect(splitDraftAndNotes(clean)).toEqual({ body: clean, notes: [] });
  });

  it('tolerates marker spelling and CRLF', () => {
    ['---RSO NOTES---', '--- RSO NOTES ---', '----RSO NOTE----', '---rso notes---'].forEach((marker) => {
      const { body, notes } = splitDraftAndNotes('Body text.\r\n' + marker + '\r\nA note.');
      expect(body, marker).toBe('Body text.');
      expect(notes, marker).toEqual(['A note.']);
    });
  });
});

describe('internalNoteBlockMessage', () => {
  it('names the offending text so the RSO can find it', () => {
    const msg = internalNoteBlockMessage(findInternalNotes(THE_SENT_EMAIL));
    expect(msg).toContain('internal note');
    expect(msg).toContain('please check the cc field');
    expect(msg).toContain('delete it before sending');
  });

  it('does not dump a whole paragraph into a toast', () => {
    expect(internalNoteBlockMessage(['x'.repeat(500)]).length).toBeLessThan(260);
  });
});

/* ── layer 1: the prompts stopped asking for it ──────────────────────────── */

describe('the drafting prompts', () => {
  it('no longer tells the model to write [RSO: …] into the email', () => {
    expect(GROUNDING_RULES).not.toContain('[RSO: please confirm whether X]');
    expect(GROUNDING_RULES).not.toMatch(/flag what the RSO must confirm/i);
  });

  it('forbids addressing the RSO in the body, and says where notes go instead', () => {
    expect(GROUNDING_RULES).toMatch(/NEVER address the RSO inside the email body/);
    expect(GROUNDING_RULES).toContain(RSO_NOTES_MARKER);
    expect(GROUNDING_RULES).toMatch(/never sent/i);
    // The rule has to survive into the actual system prompt, not just the constant.
    expect(buildSystemBlocks('')[0].text).toContain(RSO_NOTES_MARKER);
  });

  it('the practice follow-up prompt moved its notes into a JSON field', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/practice-reply-followup.js'), 'utf8');
    expect(src).not.toContain('"[RSO: please confirm ...]"');
    expect(src).toContain('"rso_notes"');
    expect(src).toMatch(/NEVER write a note, instruction or square-bracket placeholder to the RSO/);
  });
});

/* ── layer 2: the draft is cleaned before it reaches the composer ────────── */

describe('parsePracticeReplyResult', () => {
  it('returns rso_notes separately from the reply', () => {
    const out = parsePracticeReplyResult(JSON.stringify({
      outcome: 'delegated',
      summary: 'They asked Naomi to send it.',
      handed_to: 'Naomi',
      suggested_subject: 'Re: Supervisor CV',
      suggested_reply: 'Hi Dr Ranatunga,\n\nThank you for looping Naomi in.\n\nKind regards',
      rso_notes: 'Check the cc field for Naomi\'s address.'
    }));
    expect(out.suggested_reply).not.toContain('cc field');
    expect(out.rso_notes).toBe("Check the cc field for Naomi's address.");
  });

  it('lifts an inline note out of suggested_reply if the model still writes one', () => {
    const out = parsePracticeReplyResult(JSON.stringify({
      outcome: 'delegated',
      summary: 's',
      suggested_subject: 'Re: CV',
      suggested_reply: THE_SENT_EMAIL,
      rso_notes: ''
    }));
    expect(hasInternalNote(out.suggested_reply)).toBe(false);
    expect(out.suggested_reply).toContain('Thank you for looping Naomi in');
    expect(out.rso_notes).toContain('please check the cc field');
  });

  it('keeps the fallback draft shape consistent', () => {
    const fb = buildFallbackFollowup({ docTitle: 'Supervisor CV', gpName: 'Mercy Obanimoh' });
    expect(fb.rso_notes).toBe('');
    expect(hasInternalNote(fb.suggested_reply)).toBe(false);
  });
});

describe('the suggest-reply endpoint', () => {
  it('splits the notes out before returning the draft', () => {
    expect(serverJs).toContain('var sgSplit = internalNoteGuard.splitDraftAndNotes(sgRaw);');
    expect(serverJs).toContain('var suggestedReply = sgSplit.body;');
    expect(serverJs).toContain('rsoNotes: sgSplit.notes,');
    // The raw model text must never be what the composer receives.
    expect(serverJs).not.toContain("suggestedReply: (aiData.content && aiData.content[0] && aiData.content[0].text) || ''");
  });
});

/* ── layer 3: the send endpoints refuse ──────────────────────────────────── */

describe('the send endpoints', () => {
  it('the composer endpoint blocks a body that still has one', () => {
    expect(serverJs).toContain("var emailNotes = internalNoteGuard.findInternalNotes(emailBodyText || '')");
    expect(serverJs).toContain(".concat(internalNoteGuard.findInternalNotes(emailBodyHtml || ''));");
    expect(serverJs).toContain("code: 'internal_note_in_body'");
  });

  it('checks the HTML body too, not just the plain text', () => {
    // hubTextToHtml wraps the typed text, so the note survives into bodyHtml.
    expect(hasInternalNote('<p>Hi Doctor, [RSO: check the cc field] thanks.</p>')).toBe(true);
  });

  it('the document-rejection email is guarded the same way', () => {
    // That note IS the email body the doctor receives (no template wrapper).
    expect(serverJs).toContain('var rfNotes = internalNoteGuard.findInternalNotes(rfNote);');
    const at = serverJs.indexOf('var rfNotes = internalNoteGuard.findInternalNotes(rfNote);');
    expect(serverJs.slice(at, at + 400)).toContain("code: 'internal_note_in_body'");
  });

  it('refuses rather than asking for confirmation', () => {
    // A confirm dialog is what gets clicked through in a hurry.
    expect(serverJs).not.toMatch(/internal_note_in_body[\s\S]{0,200}confirm/i);
  });
});

/* ── the RSO still gets the information, where it cannot be sent ─────────── */

describe('the reviewer still sees the notes', () => {
  it('renders them outside the textarea in the admin composer', () => {
    expect(adminHtml).toContain('function renderRsoNotes(box,notes)');
    expect(adminHtml).toContain('id="hubRsoNotes"');
    expect(adminHtml).toContain('renderRsoNotes(panel.querySelector("#hubRsoNotes"),j&&j.rsoNotes);');
    expect(adminHtml).toContain('renderRsoNotes(document.getElementById("et-rso-notes-"+replyTaskId),rd.rsoNotes);');
    expect(adminHtml).toContain('Check before sending — not part of the email');
  });

  it('renders them outside the textarea in the CEO dashboard', () => {
    expect(ceoHtml).toContain('function ceoRenderRsoNotes(box, notes)');
    expect(ceoHtml).toContain("ceoRenderRsoNotes(document.getElementById('et-rso-notes-' + taskId), d.rsoNotes);");
    expect(ceoHtml).toContain('Check before sending — not part of the email');
  });

  it('shows the practice follow-up notes above that composer, in both pages', () => {
    expect(adminHtml).toContain("if(pr&&pr.rso_notes)");
    expect(ceoHtml).toContain('if (pr && pr.rso_notes)');
  });

  it('tells the RSO why a send was refused instead of failing silently', () => {
    expect(adminHtml).toContain('id="hubSendErr"');
    expect(adminHtml).toContain('if(errBox){errBox.textContent=e.message||"Could not send.";errBox.style.display="block";}');
  });
});

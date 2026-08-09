'use strict';

/*
 * Dr Ranatunga received this from us, in the body of a real sent email:
 *
 *   "Hi Dr Ranatunga, Thank you for looping Naomi in — that's great. [RSO: please
 *    check the cc field of Dr Ranatunga's email for Naomi's address. If it is
 *    visible, note it down so we can follow up with Naomi directly if needed...]
 *    Just a gentle note — we do need Dr Ranatunga's CV..."
 *
 * The bracketed part was an instruction the drafting AI had written TO the RSO —
 * because both draft prompts explicitly asked for it ("flag what the RSO must
 * confirm, e.g. [RSO: please confirm whether X]"). The composer sends the body
 * verbatim, so one unedited send put our internal working notes in front of a doctor.
 *
 * Notes to staff now travel BESIDE a draft, never inside it. This module is the one
 * place that knows what such a note looks like, so the prompts, the draft pipeline
 * and the send endpoints cannot drift apart:
 *
 *   - the prompts append them after RSO_NOTES_MARKER instead of inlining them
 *   - splitDraftAndNotes() separates them before a draft reaches the composer
 *   - the send endpoints refuse a body that still contains one
 */

// The line a drafting model writes after the finished email body. Everything below
// it is for the RSO and is never sent.
var RSO_NOTES_MARKER = '---RSO NOTES---';
var RSO_NOTES_MARKER_RE = /^[ \t]*-{2,}\s*RSO\s*NOTES?\s*-{2,}[ \t]*$/im;

// A bracketed aside addressed to whoever is sending the email, rather than to the
// person receiving it. Deliberately narrow — it has to OPEN with an internal-audience
// word, so "[Internal Medicine]", "[see attached]" or "[1]" are left alone. Nested
// brackets are excluded ([^\[\]]) so one stray "[" cannot swallow a paragraph.
var INTERNAL_NOTE_SOURCE = '\\[\\s*(?:' + [
  '(?:please\\s+)?(?:note|notes|reminder)\\s+(?:to|for)\\s+(?:the\\s+)?(?:rso|va|staff|admin|self|team)',
  'rso\\b',
  'va\\s*:',
  'internal\\s*(?:note)?\\s*:',
  'internal\\s+note\\b',
  'staff\\s*(?:note)?\\s*:',
  'admin\\s*(?:note)?\\s*:',
  'todo\\b',
  'to\\s*-?\\s*do\\s*:'
].join('|') + ')[^\\[\\]]*\\]';

// Built fresh per call: a /g regex carries lastIndex between .test() calls, which
// makes a shared instance answer differently on alternate invocations.
function internalNoteRegex() {
  return new RegExp(INTERNAL_NOTE_SOURCE, 'gi');
}

/** Every internal note in the text, as written (including the brackets). */
function findInternalNotes(text) {
  var s = String(text == null ? '' : text);
  if (!s) return [];
  return s.match(internalNoteRegex()) || [];
}

function hasInternalNote(text) {
  return findInternalNotes(text).length > 0;
}

/** The same text with the notes removed and the hole they leave tidied up. */
function stripInternalNotes(text) {
  var s = String(text == null ? '' : text);
  if (!s) return '';
  return s
    .replace(internalNoteRegex(), '')
    .replace(/[ \t]{2,}/g, ' ')          // the gap the note left mid-sentence
    .replace(/[ \t]+([.,;:!?])/g, '$1')  // " ." when a note ended a sentence
    .replace(/^[ \t]+$/gm, '')           // a line that held nothing else
    .replace(/\n{3,}/g, '\n\n')          // the paragraph break it left behind
    .trim();
}

/**
 * Split a drafted email into the part that gets sent and the part that never does.
 * Handles both shapes: the RSO NOTES block the prompts now ask for, and inline
 * "[RSO: …]" asides from a model that ignored the instruction — the latter are
 * lifted OUT of the body rather than trusted to be harmless.
 *
 * @returns {{body: string, notes: string[]}}
 */
function splitDraftAndNotes(raw) {
  var text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n');
  var notes = [];
  var body = text;

  var marker = text.match(RSO_NOTES_MARKER_RE);
  if (marker) {
    var at = text.indexOf(marker[0]);
    body = text.slice(0, at);
    var tail = text.slice(at + marker[0].length).trim();
    if (tail) notes.push(tail);
  }

  var inline = findInternalNotes(body);
  if (inline.length) {
    body = stripInternalNotes(body);
    inline.forEach(function (note) {
      var cleaned = String(note).replace(/^\[\s*/, '').replace(/\s*\]$/, '').trim();
      if (cleaned) notes.push(cleaned);
    });
  }

  return { body: String(body).trim(), notes: notes.filter(Boolean) };
}

/**
 * What a send endpoint tells the RSO when it refuses. Names the offending text so
 * they can find and delete it, rather than hunting through their own email.
 */
function internalNoteBlockMessage(notes) {
  var list = (Array.isArray(notes) ? notes : []).filter(Boolean);
  var first = list.length ? String(list[0]).replace(/\s+/g, ' ').trim() : '';
  // Short enough to read in a toast — the RSO only needs the opening words to find it.
  if (first.length > 120) first = first.slice(0, 117) + '…';
  return 'This email still contains an internal note' + (list.length > 1 ? 's' : '') +
    ' that the recipient must not see' + (first ? ': ' + first : '') +
    '. Please delete it before sending.';
}

module.exports = {
  RSO_NOTES_MARKER,
  RSO_NOTES_MARKER_RE,
  INTERNAL_NOTE_SOURCE,
  internalNoteRegex,
  findInternalNotes,
  hasInternalNote,
  stripInternalNotes,
  splitDraftAndNotes,
  internalNoteBlockMessage,
};

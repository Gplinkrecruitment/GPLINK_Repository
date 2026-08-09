'use strict';

/*
 * Shared, defensive parsing for every AI-drafted email in the app.
 *
 * Two drafters now produce the same envelope — the practice-reply follow-up
 * (they answered without the document) and the practice nudge (they went quiet) —
 * and both must fail the SAME way: return null rather than hand the composer
 * something half-parsed, so the caller can fall back to its deterministic draft.
 *
 * Splitting internal notes out of the body happens HERE, once, because it is the
 * safety property that matters most: a note the model addressed to the RSO must
 * never reach the practice. See lib/internal-note-guard.js for why.
 */

var internalNoteGuard = require('./internal-note-guard.js');

/**
 * Pull the JSON object out of a model answer and separate body from staff notes.
 *
 * @param {string} raw Whatever the model returned — may be fenced, may have prose either side.
 * @returns {{obj: Object, body: string, notes: string}|null} null when nothing usable came back.
 */
function parseDraftJson(raw) {
  var text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  // Tolerate ```json fences and any stray prose either side of the object.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  var start = text.indexOf('{');
  var end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  var parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (e) { return null; }
  if (!parsed || typeof parsed !== 'object') return null;

  var rawBody = String(parsed.suggested_reply == null ? '' : parsed.suggested_reply).trim();
  if (!rawBody) return null;

  // Belt and braces on top of the prompt rule: if the model inlined "[RSO: …]" anyway,
  // lift it out of the body and into the notes rather than letting the RSO send it.
  var split = internalNoteGuard.splitDraftAndNotes(rawBody);
  var body = split.body;
  if (!body) return null;
  var notes = String(parsed.rso_notes == null ? '' : parsed.rso_notes).trim();
  if (split.notes.length) notes = [notes].concat(split.notes).filter(Boolean).join('\n');

  return { obj: parsed, body: body, notes: notes };
}

module.exports = { parseDraftJson: parseDraftJson };

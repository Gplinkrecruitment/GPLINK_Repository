'use strict';

var internalNoteGuard = require('./internal-note-guard.js');

var GROUNDING_RULES = [
  'You draft a reply for a GP Link Registration Support Officer to review and send. It is never sent automatically.',
  'Use ONLY the facts provided below. Do not invent document statuses, dates, requirements, or outcomes.',
  // This rule used to say the opposite — "flag what the RSO must confirm, e.g. [RSO: please
  // confirm whether X]" — and a doctor duly received "[RSO: please check the cc field of Dr
  // Ranatunga's email for Naomi's address...]" in a real sent email. The RSO sends the body
  // verbatim, so anything written to the RSO has to live outside it.
  'NEVER address the RSO inside the email body. No notes, instructions, questions, reminders, or square-bracket placeholders for them to fill in — the RSO sends the body exactly as you write it, so it must contain only words the recipient should read.',
  'If the answer depends on something not in the context, do not guess and do not assert it — leave it out of the email entirely. Then, AFTER the finished email body, write the line ' + internalNoteGuard.RSO_NOTES_MARKER + ' on its own and list underneath whatever the RSO should check or confirm. Everything above that line is the email; everything below it is for the RSO and is never sent. Leave the line out completely when there is nothing to flag.',
  'Never state that a document or step is complete unless the facts explicitly say so.',
  'If the facts include practice_documents: you may ONLY ask a practice to provide, sign, complete or send items listed under outstanding_from_practice. NEVER request anything under do_not_request (already received, automatic, under review, waiting on the GP, or not yet formally requested). If outstanding_from_practice is empty, do not request any documents — give a brief, accurate progress update instead.',
  'Use a warm, clear, plain-English tone. Avoid jargon the doctor would not understand.',
  'Write the reply as PLAIN TEXT only — no markdown: no ** asterisks for bold, no # headings, no --- separators, no emoji check/bullet symbols. Separate paragraphs with a blank line; for a list of steps use simple "1.", "2." each on its own line. Keep paragraphs short. Output ONLY the email body — do not write a "Subject:" line or any email headers.',
].join('\n');

function buildSystemBlocks(playbookText) {
  var text =
    'You are a Registration Support Officer at GP Link (helping overseas GPs register to work in Australia).\n\n' +
    GROUNDING_RULES +
    (playbookText ? ('\n\n--- Standard guidance for this stage ---\n' + playbookText) : '');
  return [{ type: 'text', text: text, cache_control: { type: 'ephemeral' } }];
}

function buildUserText(opts) {
  opts = opts || {};
  var parts = [];
  if (opts.handoverSummary) parts.push('CANDIDATE SUMMARY (background, may be up to a day old):\n' + opts.handoverSummary);
  if (opts.facts) parts.push('CURRENT FACTS (authoritative — prefer these over the summary):\n' + JSON.stringify(opts.facts, null, 2));
  if (opts.threadText) parts.push('RECENT EMAILS IN THIS CONVERSATION:\n' + opts.threadText);
  parts.push('THE EMAIL TO REPLY TO:\n' + (opts.currentEmail || ''));
  parts.push(opts.senderIsGp
    ? 'Write a reply addressed directly to the doctor.'
    : 'Write a reply addressed to this person (a medical practice or third party); refer to the doctor in the third person.');
  parts.push(opts.rsoName
    ? ('Sign the reply off as ' + opts.rsoName + ' (Registration Support Officer, GP Link).')
    : 'Sign the reply off as the GP Link Registration team.');
  return parts.join('\n\n');
}

function buildSuggestReplyMessages(opts) {
  opts = opts || {};
  return {
    system: buildSystemBlocks(opts.playbookText || ''),
    userText: buildUserText(opts),
  };
}

module.exports = { GROUNDING_RULES, buildSystemBlocks, buildUserText, buildSuggestReplyMessages };

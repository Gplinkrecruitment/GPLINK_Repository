'use strict';

var GROUNDING_RULES = [
  'You draft a reply for a GP Link Registration Support Officer to review and send. It is never sent automatically.',
  'Use ONLY the facts provided below. Do not invent document statuses, dates, requirements, or outcomes.',
  'If the answer depends on something not in the context, do not guess — write the reply but flag what the RSO must confirm, e.g. "[RSO: please confirm whether X]".',
  'Never state that a document or step is complete unless the facts explicitly say so.',
  'Use a warm, clear, plain-English tone. Avoid jargon the doctor would not understand.',
].join('\n');

function buildSystemBlocks(playbookText) {
  var text =
    'You are Hazel, a Registration Support Officer at GP Link (helping overseas GPs register to work in Australia).\n\n' +
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

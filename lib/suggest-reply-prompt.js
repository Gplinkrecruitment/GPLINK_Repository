'use strict';

var internalNoteGuard = require('./internal-note-guard.js');
var auAiContext = require('./au-ai-context.js');

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

// ── WP-20 (Australian GP build) ──────────────────────────────────────────────
// `opts.au` is passed by the server ONLY for a doctor on an Australian pathway
// with the switch on: { ctx, practiceIntro, practiceStateFacts, secrets }
// (lib/au-ai-context.js). Without it every function in this file returns
// exactly what it always has.
//
// With it: the opening line no longer says "helping overseas GPs register";
// the doctor is described by the shared context paragraph; and when the reply
// goes to a practice or another third party, the stored case summary is left
// out and every string is passed through redactForPractice, so the model is
// never handed a condition's wording, a registration or provider number, or
// the doctor's current employer for a reply that leaves the building.
function auOf(opts) {
  var au = opts && opts.au && typeof opts.au === 'object' ? opts.au : null;
  return au && au.ctx && au.ctx.isAu === true ? au : null;
}

function buildAuSystemBlocks(playbookText) {
  var text =
    auAiContext.auIdentityLine('staff_reply') + '\n\n' +
    GROUNDING_RULES +
    (playbookText ? ('\n\n--- Standard guidance for this stage ---\n' + playbookText) : '');
  return [{ type: 'text', text: text, cache_control: { type: 'ephemeral' } }];
}

function buildAuUserText(opts, au) {
  var toDoctor = !!opts.senderIsGp;
  var audience = toDoctor ? auAiContext.AUDIENCE.DOCTOR : auAiContext.AUDIENCE.PRACTICE;
  var clean = function (v) { return toDoctor ? String(v == null ? '' : v) : auAiContext.redactForPractice(v, au.secrets); };
  var parts = [];
  parts.push(auAiContext.auPromptBlock(au.ctx, audience, { practiceIntro: au.practiceIntro, practiceStateFacts: au.practiceStateFacts }));
  // The stored summary is written for staff. It goes into a reply to the
  // doctor (it is about them); it is never given to a reply to anyone else.
  if (toDoctor && opts.handoverSummary) parts.push('CANDIDATE SUMMARY (background, may be up to a day old):\n' + opts.handoverSummary);
  if (opts.facts) parts.push('CURRENT FACTS (authoritative — prefer these over the summary):\n' + clean(JSON.stringify(opts.facts, null, 2)));
  if (opts.threadText) parts.push('RECENT EMAILS IN THIS CONVERSATION:\n' + clean(opts.threadText));
  parts.push('THE EMAIL TO REPLY TO:\n' + clean(opts.currentEmail || ''));
  parts.push(toDoctor
    ? 'Write a reply addressed directly to the doctor.'
    : 'Write a reply addressed to this person (a medical practice or third party); refer to the doctor in the third person.');
  parts.push(opts.rsoName
    ? ('Sign the reply off as ' + opts.rsoName + ' (GP Link).')
    : 'Sign the reply off as the GP Link team.');
  return parts.join('\n\n');
}

function buildUserText(opts) {
  opts = opts || {};
  var au = auOf(opts);
  if (au) return buildAuUserText(opts, au);
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
    system: auOf(opts) ? buildAuSystemBlocks(opts.playbookText || '') : buildSystemBlocks(opts.playbookText || ''),
    userText: buildUserText(opts),
  };
}

module.exports = { GROUNDING_RULES, buildSystemBlocks, buildAuSystemBlocks, buildUserText, buildSuggestReplyMessages };

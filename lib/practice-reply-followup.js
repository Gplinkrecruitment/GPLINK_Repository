'use strict';

/**
 * Pure helpers for the "practice replied, but did not attach the document" case on a
 * practice pack task (Supervisor CV, Position Description, Offer/Contract, SPPA-00).
 *
 * WHY THIS EXISTS
 * ---------------
 * When a practice replies to one of our document-request emails, the inbound-mail path
 * flips the task back to `open` ("your ball") because a human has to read what they said.
 * The task's one-line next step used to be computed from status + attachment alone, so an
 * `open` task with no attachment re-printed the FIRST step — "Email the practice requesting
 * the Supervisor CV" — even though the request had already gone out and been answered. The
 * RSO was being told to send a duplicate of an email the practice had already replied to.
 *
 * A reply with no attachment is almost never "nothing happened". It is usually one of:
 *   - delegated       — the contact asked somebody else to send it
 *                       (real case: "Hi Naomi, could you kindly organise for my CV to be
 *                        emailed to them")
 *   - content_in_body — they typed the document into the email instead of attaching a file
 *                       (real case: the Position Description pasted as plain text)
 *   - will_send_later — they acknowledged and promised to send it
 *   - question_for_us — they need something answered before they can send it
 *   - cannot_provide  — they cannot or will not provide it
 * Every one of those needs a DIFFERENT follow-up, and none of them is the original request.
 *
 * So we read the reply and draft the follow-up that actually fits it. The draft is always
 * reviewed and sent by a human — nothing here sends email.
 *
 * No external dependencies — safe to require from anywhere (server + tests).
 */

// The exact one-line next step shown on a practice pack task once the practice has replied.
// Owner-specified wording (2026-08-01). Kept here so both dashboards and the tests share
// one source of truth instead of three drifting copies of the same sentence.
var internalNoteGuard = require('./internal-note-guard.js');
var aiDraftJson = require('./ai-draft-json.js');

var PRACTICE_REPLY_GUIDE_LINE = 'Practice replied — read the reply';
var PRACTICE_DOC_RECEIVED_GUIDE_LINE = 'Practice sent the document — review it';

var OUTCOMES = ['delegated', 'content_in_body', 'will_send_later', 'question_for_us', 'cannot_provide', 'unclear'];

// Escape the five characters that matter inside HTML text/attribute content.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Turn a plain-text email body into the HTML the contenteditable composer expects.
 * Escapes first (so a practice name containing "&" or "<" can never inject markup),
 * then maps blank lines to paragraph breaks and single newlines to <br>.
 */
function plainTextToHtml(text) {
  var raw = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
  if (!raw) return '';
  return raw.split(/\n{2,}/).map(function (para) {
    return escapeHtml(para).replace(/\n/g, '<br>');
  }).join('<br><br>');
}

// Short RSO-facing explanation of what the practice's reply actually amounted to.
// Shown above the draft so the RSO knows why the draft says what it says.
function outcomeGuidance(outcome) {
  switch (outcome) {
    case 'delegated':
      return 'They passed it to someone else — nothing has arrived yet, so this still needs chasing.';
    case 'content_in_body':
      return 'They put the content in the email itself instead of attaching a file — we still need it as a document.';
    case 'will_send_later':
      return 'They said they will send it — no document has arrived yet.';
    case 'question_for_us':
      return 'They asked us something before they can send it — answer them to unblock it.';
    case 'cannot_provide':
      return 'They said they cannot provide it — this may need a different route.';
    default:
      return 'No document was attached to this reply — read it and decide what to send back.';
  }
}

function normalizeOutcome(value) {
  var v = String(value == null ? '' : value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return OUTCOMES.indexOf(v) > -1 ? v : 'unclear';
}

/**
 * Build the grounded prompt that reads one practice reply and drafts the follow-up.
 *
 * @param {Object} params
 * @param {string} params.docTitle          e.g. "Supervisor CV"
 * @param {string} [params.signRequirement] Signing rule spelled out in the original request.
 * @param {string} params.gpName            The doctor this pack belongs to.
 * @param {string} [params.contactName]     Practice contact name.
 * @param {string} [params.rsoName]         RSO to sign the draft off as.
 * @param {string} params.replyText         The practice's reply, as text.
 * @param {string} [params.replySender]     Who sent the reply.
 * @param {string} [params.requestText]     The request email we sent them.
 * @param {Array}  [params.knownContacts]   Others already on the thread ({email,name} or the
 *                                          {email_address,display_name} shape the CC picker
 *                                          uses) — so the draft never asks for an address we hold.
 * @returns {{system: Array, userText: string}}
 */
function buildPracticeReplyMessages(params) {
  params = params || {};
  var docTitle = String(params.docTitle == null ? '' : params.docTitle).trim() || 'the requested document';
  var gpName = String(params.gpName == null ? '' : params.gpName).trim() || 'the doctor';
  var contactName = String(params.contactName == null ? '' : params.contactName).trim();
  var rsoName = String(params.rsoName == null ? '' : params.rsoName).trim();
  var signRequirement = String(params.signRequirement == null ? '' : params.signRequirement).trim();

  var systemText = [
    'You are a Registration Support Officer at GP Link, which helps overseas GPs register to work in Australia.',
    '',
    'A medical practice was emailed asking for a specific document. They have replied WITHOUT attaching it.',
    'Your job is to (a) work out what their reply actually means and (b) draft the follow-up reply the RSO should send.',
    '',
    'RULES',
    '- The draft is reviewed and sent by a human. Never claim it was sent.',
    '- Use ONLY the facts given below. Never invent dates, names, statuses or requirements.',
    '- NEVER re-send the original request as if they had not replied. They did reply. Acknowledge what they said first.',
    '- If they passed the job to another person, address that: confirm we are happy for that person to send it directly.',
    '  Check "others_on_the_email_thread" FIRST. If that person is already on the thread (they were CC\'d, or they have',
    '  written to us before), we ALREADY have their address — say we will copy them in from here, and do NOT ask for it.',
    '  Asking a practice for an address that is visibly in the CC line reads as though we did not read their email.',
    '  Only ask for the address when the person is genuinely not in that list. Never pretend we can email someone',
    '  whose address we lack, and never invent one.',
    '- If they pasted the document content into the email body, thank them for the detail and explain plainly that we need',
    '  it as an actual document (PDF or Word) on practice letterhead, signed, because the regulator requires the document',
    '  itself — not the text of it.',
    // This rule used to say "otherwise mark it for the RSO with [RSO: please confirm ...]",
    // inside the reply body. The RSO sends that body verbatim, and a doctor received one of
    // those notes in a real email. Anything for the RSO goes in rso_notes instead.
    '- If they asked us a question, answer it if the facts below allow. Otherwise leave it out of the reply',
    '  and put it in "rso_notes" — NEVER write a note, instruction or square-bracket placeholder to the RSO',
    '  inside "suggested_reply". That text is sent to the practice exactly as you write it.',
    '- Keep it short, warm and plain-English. No jargon a practice manager would not use.',
    '- Write the reply body as PLAIN TEXT: no markdown, no asterisks, no headings, no emoji. Blank line between paragraphs.',
    '- Do not include a "Subject:" line inside the reply body.',
    '',
    'Respond with ONLY a JSON object, no prose around it, in this exact shape:',
    '{',
    '  "outcome": one of ' + JSON.stringify(OUTCOMES) + ',',
    '  "summary": "one plain-English sentence saying what the practice actually said",',
    '  "handed_to": "name of the person they delegated to, plus their email in angle brackets when it is known from',
    '                 others_on_the_email_thread, or empty string",',
    '  "suggested_subject": "subject line for the follow-up",',
    '  "suggested_reply": "the follow-up email body as plain text — nothing addressed to the RSO",',
    '  "rso_notes": "anything the RSO should check or confirm before sending, or empty string — never sent"',
    '}',
  ].join('\n');

  // Everyone else already on the email thread (CC'd on their reply, or a previous
  // correspondent). Without this the model has no way to know we already hold the address
  // of the person the practice just delegated to, so it dutifully asks them to send it —
  // even when that person is sitting in the CC line of the very email it is answering.
  var knownContacts = Array.isArray(params.knownContacts) ? params.knownContacts : [];
  var threadPeople = knownContacts.map(function (c) {
    var email = String((c && (c.email || c.email_address)) || '').trim();
    if (!email) return null;
    var name = String((c && (c.name || c.display_name)) || '').trim();
    return name ? (name + ' <' + email + '>') : email;
  }).filter(Boolean);

  var facts = {
    document_requested: docTitle,
    signing_requirement: signRequirement || null,
    doctor: gpName,
    practice_contact: contactName || null,
    reply_from: String(params.replySender == null ? '' : params.replySender).trim() || null,
    others_on_the_email_thread: threadPeople.length ? threadPeople : null,
    sign_off_as: rsoName || 'the GP Link Registration team',
  };

  var parts = [];
  parts.push('FACTS:\n' + JSON.stringify(facts, null, 2));
  if (params.requestText) {
    parts.push('THE REQUEST WE SENT THEM:\n' + String(params.requestText).slice(0, 4000));
  }
  parts.push('THEIR REPLY (no document was attached to it):\n' + String(params.replyText == null ? '' : params.replyText).slice(0, 8000));
  parts.push(rsoName
    ? ('Sign the draft off as ' + rsoName + ' — GP Link Registration Team.')
    : 'Sign the draft off as the GP Link Registration Team.');

  return {
    // cache_control mirrors the suggest-reply prompt: the instructions are static across
    // every practice reply, so they are worth caching; the per-reply facts are not.
    system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
    userText: parts.join('\n\n'),
  };
}

/**
 * Parse the model's JSON answer defensively. Returns null when nothing usable came back,
 * so the caller can fall back to the deterministic draft rather than storing garbage.
 */
function parsePracticeReplyResult(raw) {
  // Envelope handling (fences, brace extraction, lifting an inlined [RSO: …] note out of
  // the body) is shared with the nudge drafter — see lib/ai-draft-json.js.
  var env = aiDraftJson.parseDraftJson(raw);
  if (!env) return null;
  var parsed = env.obj;

  return {
    outcome: normalizeOutcome(parsed.outcome),
    summary: String(parsed.summary == null ? '' : parsed.summary).trim(),
    handed_to: String(parsed.handed_to == null ? '' : parsed.handed_to).trim(),
    suggested_subject: String(parsed.suggested_subject == null ? '' : parsed.suggested_subject).trim(),
    suggested_reply: env.body,
    rso_notes: env.notes,
  };
}

/**
 * Deterministic follow-up used when the AI is unavailable, over budget, or returns junk.
 * It is deliberately generic — it acknowledges the reply and asks for the document as a
 * file — but it is still NOT the original request, which is the whole point.
 */
function buildFallbackFollowup(params) {
  params = params || {};
  var docTitle = String(params.docTitle == null ? '' : params.docTitle).trim() || 'the requested document';
  var gpName = String(params.gpName == null ? '' : params.gpName).trim() || 'the doctor';
  var contactName = String(params.contactName == null ? '' : params.contactName).trim();
  var rsoName = String(params.rsoName == null ? '' : params.rsoName).trim();
  var signRequirement = String(params.signRequirement == null ? '' : params.signRequirement).trim();

  var body = 'Hi ' + (contactName || 'there') + ',\n\n'
    + 'Thank you for coming back to us about the ' + docTitle + ' for Dr ' + gpName + '.\n\n'
    + 'We could not see the document attached to your reply. Could you please send it through as an attachment '
    + '(PDF or Word)?' + (signRequirement ? ' ' + signRequirement : '') + '\n\n'
    + 'If someone else at the practice is sending it, just let us know who and we will follow up with them directly.\n\n'
    + 'Kind regards,\n' + (rsoName ? rsoName + ' — GP Link Registration Team' : 'GP Link Registration Team');

  return {
    outcome: 'unclear',
    summary: 'The practice replied but no document was attached.',
    handed_to: '',
    suggested_subject: 'Re: ' + docTitle + ' for Dr ' + gpName,
    suggested_reply: body,
    rso_notes: '',
    source: 'fallback',
  };
}

module.exports = {
  PRACTICE_REPLY_GUIDE_LINE,
  PRACTICE_DOC_RECEIVED_GUIDE_LINE,
  OUTCOMES,
  escapeHtml,
  plainTextToHtml,
  outcomeGuidance,
  normalizeOutcome,
  buildPracticeReplyMessages,
  parsePracticeReplyResult,
  buildFallbackFollowup,
};

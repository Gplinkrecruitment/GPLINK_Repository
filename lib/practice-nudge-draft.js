'use strict';

/*
 * The "Nudge Practice" draft.
 *
 * Owner report 2026-08-10: the nudge composer opened with a hardcoded template —
 * "Just following up on our earlier email regarding the Supervisor CV…" — on a thread
 * where the practice had already replied twice and named the person who would send the
 * document. Sending it unedited reads as though we never opened their emails.
 *
 * This is the sibling of practice-reply-followup.js, and the distinction matters:
 *   - practice-reply-followup = they REPLIED, without the document. Answer what they said.
 *   - practice-nudge (here)   = they have gone QUIET since our last email. Chase, using
 *                               everything already said on the thread.
 *
 * The nudge is the harder one to get right, because the failure mode is not a wrong fact
 * but a tone-deaf one: thanking someone for a reply that never came, or re-asking for a
 * document a named colleague already promised to send.
 *
 * No external dependencies beyond the shared draft helpers — safe to require from
 * anywhere (server + tests).
 */

var aiDraftJson = require('./ai-draft-json.js');

// How much of the thread the prompt will carry. A practice pack thread is short (a
// handful of emails), but a long quoted chain can blow the budget on repeated quoting,
// so each message is clipped and the oldest are dropped first.
var MAX_THREAD_MESSAGES = 12;
var MAX_CHARS_PER_MESSAGE = 1500;
var MAX_THREAD_CHARS = 12000;

/**
 * Strip the quoted-reply tail from an email body. Practices reply above the quote, so
 * everything from the first "On <date>, X wrote:" / leading ">" block onwards is a copy
 * of what we already have in earlier thread entries — carrying it multiplies the prompt.
 */
function stripQuotedTail(text) {
  var s = String(text == null ? '' : text);
  if (!s) return '';
  var markers = [
    /\n\s*On .{0,120}\bwrote:/,            // "On 2 Aug 2026, at 3:03 am, Hazel wrote:"
    /\n\s*-{2,}\s*Original Message\s*-{2,}/i,
    /\n\s*From:\s.+\nSent:\s/i,
  ];
  var cut = s.length;
  for (var i = 0; i < markers.length; i++) {
    var m = s.match(markers[i]);
    if (m && m.index != null && m.index < cut) cut = m.index;
  }
  s = s.slice(0, cut);
  // Drop any remaining fully-quoted lines.
  s = s.split('\n').filter(function (line) { return !/^\s*>/.test(line); }).join('\n');
  return s.trim();
}

/** Collapse HTML to readable text — thread rows store body_html for our own sends. */
function htmlToText(html) {
  return String(html == null ? '' : html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Render the thread for the prompt, oldest first, newest last, each turn labelled with
 * who sent it. Newest messages are kept when the budget forces a trim — the most recent
 * exchange is what the nudge has to sound aware of.
 *
 * @param {Array} messages task_messages rows ({direction, sender, created_at, body_text, body_html})
 * @returns {string}
 */
function formatThreadForPrompt(messages) {
  var rows = Array.isArray(messages) ? messages.slice() : [];
  rows.sort(function (a, b) {
    return new Date(a && a.created_at || 0).getTime() - new Date(b && b.created_at || 0).getTime();
  });
  if (rows.length > MAX_THREAD_MESSAGES) rows = rows.slice(rows.length - MAX_THREAD_MESSAGES);

  var parts = rows.map(function (m) {
    m = m || {};
    var who = m.direction === 'outbound' ? 'US (GP Link)' : ('THE PRACTICE (' + (m.sender || 'unknown') + ')');
    var when = m.created_at ? String(m.created_at).slice(0, 10) : '';
    var body = m.body_text ? String(m.body_text) : htmlToText(m.body_html);
    body = stripQuotedTail(body);
    if (body.length > MAX_CHARS_PER_MESSAGE) body = body.slice(0, MAX_CHARS_PER_MESSAGE) + '…';
    return '[' + when + '] ' + who + ':\n' + (body || '(no text)');
  });

  var out = parts.join('\n\n');
  // Trim from the FRONT if still oversized — keep the most recent exchange.
  if (out.length > MAX_THREAD_CHARS) out = '…\n' + out.slice(out.length - MAX_THREAD_CHARS);
  return out;
}

/**
 * Build the grounded prompt for a chase-up on a practice that has not replied.
 *
 * @param {Object} params
 * @param {string} params.docTitle             e.g. "Supervisor CV"
 * @param {string} [params.signRequirement]    Signing rule spelled out in the original request.
 * @param {string} params.gpName               The doctor this pack belongs to.
 * @param {string} [params.contactName]        Practice contact name.
 * @param {string} [params.rsoName]            RSO to sign the draft off as.
 * @param {string} params.threadText           Rendered thread from formatThreadForPrompt().
 * @param {number} [params.daysSinceLastContact] Days since OUR last email went out.
 * @param {boolean} [params.practiceEverReplied] Whether they have ever replied on this thread.
 * @param {Array}  [params.knownContacts]      Others already on the thread ({email,name} or
 *                                             {email_address,display_name}).
 * @returns {{system: Array, userText: string}}
 */
function buildPracticeNudgeMessages(params) {
  params = params || {};
  var docTitle = String(params.docTitle == null ? '' : params.docTitle).trim() || 'the requested document';
  var gpName = String(params.gpName == null ? '' : params.gpName).trim() || 'the doctor';
  var contactName = String(params.contactName == null ? '' : params.contactName).trim();
  var rsoName = String(params.rsoName == null ? '' : params.rsoName).trim();
  var signRequirement = String(params.signRequirement == null ? '' : params.signRequirement).trim();

  var systemText = [
    'You are a Registration Support Officer at GP Link, which helps overseas GPs register to work in Australia.',
    '',
    'A medical practice was asked for a specific document and has NOT responded to our most recent email.',
    'Your job is to draft the chase-up (a "nudge") that the RSO will review and send.',
    '',
    'RULES',
    '- The draft is reviewed and sent by a human. Never claim it was sent.',
    '- Use ONLY the facts and the thread below. Never invent dates, names, statuses or requirements.',
    '- THEY HAVE NOT REPLIED to our last email. Never thank them for a reply that did not come.',
    '- This is the opposite of a fresh request: they have heard from us already. Do NOT restate the whole',
    '  original ask as though this were first contact. Reference where things actually got to.',
    '- Read the thread and chase the SPECIFIC thing outstanding. If they already said a named colleague',
    '  would send it, chase that promise by name ("you mentioned Naomi would send it through") rather than',
    '  asking the practice generically again. If they asked us something we already answered, do not re-ask it.',
    '- If the thread shows the document was promised for a particular day that has passed, refer to it',
    '  plainly and without blame.',
    '- Be warm and short. A nudge is a favour being asked, not a demand. No guilt, no "as per my last email",',
    '  no deadlines we have not actually agreed. Never imply they have done something wrong.',
    '- Longer silence earns a slightly more direct ask, never a colder tone.',
    '- Say plainly which document is still outstanding, and repeat any signing requirement exactly once.',
    '- If someone else is already on the email thread (see others_on_the_email_thread), you may note that we',
    '  are copying them in. Never ask for an address that is already in that list, and never invent one.',
    '- Write the body as PLAIN TEXT: no markdown, no asterisks, no headings, no emoji. Blank line between paragraphs.',
    '- Do not include a "Subject:" line inside the body.',
    // Observed on the first live run: the model wrote "It\'s been 6 days since our last email"
    // into rso_notes when the facts said 1. Notes are internal, but a wrong number there still
    // misleads the person deciding how hard to push.
    '- "rso_notes" is held to the SAME evidence rule as the body. Never state an elapsed time',
    '  other than days_since_our_last_email, and if that value is null do not guess one.',
    '- NEVER write a note, instruction or square-bracket placeholder to the RSO inside "suggested_reply" —',
    '  that text is sent to the practice exactly as you write it. Anything for the RSO goes in "rso_notes".',
    '',
    'Respond with ONLY a JSON object, no prose around it, in this exact shape:',
    '{',
    '  "suggested_subject": "subject line for the nudge — keep the existing thread subject when there is one",',
    '  "suggested_reply": "the nudge email body as plain text — nothing addressed to the RSO",',
    '  "rso_notes": "anything the RSO should check before sending, or empty string — never sent"',
    '}',
  ].join('\n');

  var knownContacts = Array.isArray(params.knownContacts) ? params.knownContacts : [];
  var threadPeople = knownContacts.map(function (c) {
    var email = String((c && (c.email || c.email_address)) || '').trim();
    if (!email) return null;
    var name = String((c && (c.name || c.display_name)) || '').trim();
    return name ? (name + ' <' + email + '>') : email;
  }).filter(Boolean);

  var days = params.daysSinceLastContact;
  var facts = {
    document_still_outstanding: docTitle,
    signing_requirement: signRequirement || null,
    doctor: gpName,
    practice_contact: contactName || null,
    days_since_our_last_email: (typeof days === 'number' && isFinite(days)) ? days : null,
    practice_has_ever_replied_on_this_thread: !!params.practiceEverReplied,
    others_on_the_email_thread: threadPeople.length ? threadPeople : null,
    sign_off_as: rsoName || 'the GP Link Registration team',
  };

  var parts = [];
  parts.push('FACTS:\n' + JSON.stringify(facts, null, 2));
  parts.push('THE EMAIL THREAD SO FAR (oldest first — the last entry is our unanswered email):\n'
    + String(params.threadText == null ? '' : params.threadText));
  parts.push(rsoName
    ? ('Sign the draft off as ' + rsoName + ' — GP Link Registration Team.')
    : 'Sign the draft off as the GP Link Registration Team.');

  return {
    // Same caching rationale as the reply drafter: the instructions are identical on every
    // nudge, the thread is not.
    system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
    userText: parts.join('\n\n'),
  };
}

/**
 * The subject that keeps a nudge in the thread the practice is already reading.
 *
 * Mail clients group by subject + References, so a fresh subject line ("Follow-up: …",
 * which is what the composer used to pre-fill, or whatever the model invents) starts a
 * SEPARATE conversation in their inbox — the chase then arrives detached from the request
 * it is chasing. Reuse the thread's own subject, with exactly one "Re: ".
 *
 * @param {string} threadSubject Subject of the most recent message on the thread.
 * @returns {string} '' when there is no usable thread subject.
 */
function threadReplySubject(threadSubject) {
  var s = String(threadSubject == null ? '' : threadSubject).trim();
  if (!s) return '';
  // Collapse any stack of Re:/RE:/Re[2]: prefixes down to one.
  s = s.replace(/^(\s*re\s*(\[\d+\])?\s*:\s*)+/i, '').trim();
  if (!s) return '';
  return 'Re: ' + s;
}

/**
 * Parse the model's JSON answer. Returns null when nothing usable came back, so the
 * caller falls back to the deterministic nudge rather than showing the RSO garbage.
 */
function parsePracticeNudgeResult(raw) {
  var env = aiDraftJson.parseDraftJson(raw);
  if (!env) return null;
  return {
    suggested_subject: String(env.obj.suggested_subject == null ? '' : env.obj.suggested_subject).trim(),
    suggested_reply: env.body,
    rso_notes: env.notes,
  };
}

/**
 * The deterministic nudge — byte-for-byte the wording the composer used before this
 * feature existed, so an AI outage degrades to exactly the old behaviour rather than to
 * an empty box.
 */
function buildFallbackNudge(params) {
  params = params || {};
  var docTitle = String(params.docTitle == null ? '' : params.docTitle).trim() || 'the requested document';
  var gpName = String(params.gpName == null ? '' : params.gpName).trim() || 'the doctor';
  var contactName = String(params.contactName == null ? '' : params.contactName).trim();
  var rsoName = String(params.rsoName == null ? '' : params.rsoName).trim();
  var signRequirement = String(params.signRequirement == null ? '' : params.signRequirement).trim();

  var body = 'Hi ' + (contactName || 'there') + ',\n\n'
    + 'Just following up on our earlier email regarding the ' + docTitle + ' for Dr ' + gpName + '.\n\n'
    + 'Could you please provide this at your earliest convenience? We need this document to proceed with '
    + 'their registration.' + (signRequirement ? ' ' + signRequirement : '') + '\n\n'
    + 'Kind regards,\n' + (rsoName ? rsoName + ' — GP Link Registration Team' : 'GP Link Registration Team');

  return {
    suggested_subject: 'Follow-up: ' + docTitle + ' for Dr ' + gpName,
    suggested_reply: body,
    rso_notes: '',
    source: 'fallback',
  };
}

module.exports = {
  MAX_THREAD_MESSAGES,
  stripQuotedTail,
  htmlToText,
  formatThreadForPrompt,
  threadReplySubject,
  buildPracticeNudgeMessages,
  parsePracticeNudgeResult,
  buildFallbackNudge,
};

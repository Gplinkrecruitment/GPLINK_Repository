'use strict';

/**
 * Pure helpers for a practice reply on the "congratulate the practice and ask them to
 * engage a migration agent" card (task_type 'migration_agent', raised when AHPRA grants
 * a doctor's registration).
 *
 * WHY THIS EXISTS
 * ---------------
 * The inbound-mail path matches the practice's reply onto the card (same Gmail thread),
 * records it and flips the task back to open. Until now nothing READ that reply: the card
 * kept showing the original congratulations email with a "Send again" button, so the RSO
 * was being invited to re-send an email the practice had already answered (Dr Ranatunga,
 * The Doctors Werribee, 6 Nov 2026: "Hi Nangi, will you be able to do the below for this
 * doctor?" with the migration agent copied in).
 *
 * A reply here is almost always one of:
 *   agent_named        they gave us the agent's name and email (or copied the agent in)
 *   delegated          they passed it to a colleague or to the agent without saying who
 *                      will do what, usually with that person copied in
 *   will_engage_later  they acknowledged and will come back to us
 *   question_for_us    they need something answered first (costs, timing, what an agent does)
 *   declined           they will not engage an agent, or want us to arrange one
 *   unclear            none of the above
 * Each needs a DIFFERENT follow-up, and none of them is the original request. The draft is
 * always reviewed and sent by a human. Nothing here sends email or touches a database.
 *
 * Owner style rule for everything that reaches a practice: warm, plain, no dashes at all.
 */

var aiDraftJson = require('./ai-draft-json.js');

var OUTCOMES = ['agent_named', 'delegated', 'will_engage_later', 'question_for_us', 'declined', 'unclear'];

var GUIDE_LINE = 'Practice replied — read the reply and send the follow-up';

function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

// Any dash family character a data value drags in becomes a space (owner rule: no dashes).
function noDashes(s) {
  return clean(String(s == null ? '' : s).replace(/[-‐-―−]+/g, ' '));
}

function firstName(name) {
  var n = clean(name).replace(/^(dr|doctor|mr|mrs|ms|miss)\.?\s+/i, '');
  return n ? n.split(' ')[0] : '';
}

// How to greet someone from the name we hold: "Dr Chamira Ranatunga" / "Dr Ranatunga" ->
// "Dr Ranatunga"; "Naomi Milne" -> "Naomi"; a bare title or a role ("Practice Manager") -> "".
function greetName(name) {
  var n = clean(name);
  if (!n) return '';
  var m = n.match(/^(dr|doctor|prof|professor)\.?\s+(.+)$/i);
  if (m) {
    var parts = m[2].trim().split(' ');
    return noDashes((/^prof/i.test(m[1]) ? 'Prof' : 'Dr') + ' ' + parts[parts.length - 1]);
  }
  if (/^(dr|doctor|prof|professor)\.?$/i.test(n)) return '';
  if (/\b(manager|reception|receptionist|administrator|admin|coordinator|team|office)\b/i.test(n)) return '';
  return noDashes(firstName(n));
}

// "Re: Re: X" -> "Re: X"; keeps the chase in the conversation the practice is already reading.
function threadReplySubject(subject) {
  var s = clean(subject).replace(/^(\s*re\s*(\[\d+\])?\s*:\s*)+/i, '').trim();
  return s ? 'Re: ' + s : '';
}

function normalizeOutcome(value) {
  var v = String(value == null ? '' : value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return OUTCOMES.indexOf(v) > -1 ? v : 'unclear';
}

// Short RSO-facing explanation of what the practice's reply amounted to.
function outcomeGuidance(outcome) {
  switch (outcome) {
    case 'agent_named':
      return 'They named the migration agent. Confirm the details below, record the agent, then send the follow-up so the agent hears from us.';
    case 'delegated':
      return 'They passed it to someone else. Nothing is confirmed yet: the follow-up goes to that person so the agent is actually engaged.';
    case 'will_engage_later':
      return 'They will come back to us. The follow-up thanks them and asks for a date so the visa timeline holds.';
    case 'question_for_us':
      return 'They asked us something first. Answer it in the follow-up, then the agent can be engaged.';
    case 'declined':
      return 'They do not want to engage an agent themselves. Read the notes before sending anything.';
    default:
      return 'Read what they said and decide what to send back. The draft acknowledges their reply rather than repeating the request.';
  }
}

// "Name <addr>, addr2; Other <addr3>" -> [{ email, name }], lower-cased, de-duplicated.
function parseEmailList(value) {
  var out = [];
  var seen = Object.create(null);
  var raw = String(value == null ? '' : value);
  if (!raw.trim()) return out;
  var parts = raw.split(/,|;/);
  for (var i = 0; i < parts.length; i++) {
    var piece = parts[i].trim();
    if (!piece) continue;
    var m = piece.match(/[\w.+-]+@[\w.-]+\.\w+/);
    if (!m) continue;
    var email = m[0].toLowerCase();
    if (seen[email]) continue;
    seen[email] = true;
    var name = piece.replace(/<[^>]*>/g, '').replace(/[\w.+-]+@[\w.-]+\.\w+/g, '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
    out.push({ email: email, name: name });
  }
  return out;
}

function isOwn(email, ownAddresses) {
  var e = String(email || '').toLowerCase();
  if (!e) return true;
  if (/@mygplink\.com\.au$/i.test(e)) return true;
  return (ownAddresses || []).some(function (a) { return String(a || '').toLowerCase() === e; });
}

/**
 * The third parties the practice brought onto the thread with this reply: everyone in the
 * CC line (and any extra To) who is not us, not the sender and not the doctor.
 * -> [{ email, name }]
 */
function thirdPartiesOnReply(params) {
  params = params || {};
  var sender = parseEmailList(params.replyFrom)[0];
  var senderEmail = sender ? sender.email : '';
  var gpEmail = String(params.gpEmail || '').toLowerCase();
  var found = parseEmailList(params.replyCc).concat(parseEmailList(params.replyTo));
  var out = [];
  var seen = Object.create(null);
  found.forEach(function (p) {
    if (!p.email || seen[p.email]) return;
    if (p.email === senderEmail || p.email === gpEmail) return;
    if (isOwn(p.email, params.ownAddresses)) return;
    seen[p.email] = true;
    out.push(p);
  });
  return out;
}

/**
 * Who the follow-up should go to.
 *   to: the person they handed it to when we hold that address, otherwise whoever replied;
 *   cc: whoever else of (reply sender, our original contact) is not already the To.
 */
function suggestFollowupRecipients(params) {
  params = params || {};
  var sender = parseEmailList(params.replyFrom)[0];
  var senderEmail = sender ? sender.email : '';
  var originalTo = parseEmailList(params.originalTo)[0];
  var originalEmail = originalTo ? originalTo.email : '';
  var handed = parseEmailList(params.handedToEmail)[0];
  var handedEmail = handed ? handed.email : '';
  var to = handedEmail || senderEmail || originalEmail || '';
  var cc = [];
  [senderEmail, originalEmail].forEach(function (e) {
    if (e && e !== to && cc.indexOf(e) < 0 && !isOwn(e, params.ownAddresses)) cc.push(e);
  });
  return { to: to, cc: cc };
}

/**
 * Build the grounded prompt that reads one practice reply on the migration-agent card and
 * drafts the follow-up.
 *
 * @param {Object} params
 * @param {string} params.gpName              "Mercy Obanimoh"
 * @param {string} [params.practiceName]
 * @param {string} [params.contactName]       Who we wrote to ("Dr Ranatunga")
 * @param {string} [params.commencementDate]  Long date, e.g. "25 January 2027"
 * @param {boolean} [params.practiceCoversVisaCosts]
 * @param {string} [params.rsoName]
 * @param {string} params.replyText
 * @param {string} [params.replySender]       "Name <addr>" or bare address
 * @param {string} [params.replyCc]           CC header of their reply
 * @param {string} [params.requestText]       The email we sent them
 * @param {Array}  [params.knownContacts]     [{email|email_address, name|display_name, signature_name?}]
 * @returns {{system: Array, userText: string}}
 */
function buildMigrationAgentReplyMessages(params) {
  params = params || {};
  var gpName = clean(params.gpName) || 'the doctor';
  var practiceName = clean(params.practiceName);
  var contactName = clean(params.contactName);
  var rsoName = clean(params.rsoName);

  var systemText = [
    'You are a Registration Support Officer at GP Link, which helps overseas GPs register and relocate to work in Australia.',
    '',
    'Context: AHPRA has just granted a doctor\'s registration. We emailed the sponsoring practice to congratulate them and',
    'asked them to engage a registered migration agent to prepare the Subclass 482 nomination for the practice and lodge the',
    'doctor\'s visa, and to reply with the agent\'s name and email. The practice has now replied.',
    'Your job is to (a) work out what their reply actually means and (b) draft the follow-up the RSO should send.',
    '',
    'RULES',
    '- The draft is reviewed and sent by a human. Never claim anything was sent.',
    '- Use ONLY the facts given below. Never invent names, email addresses, dates, fees or legal requirements.',
    '- NEVER re-send the original request as if they had not replied. They did reply. Acknowledge what they said first.',
    '- Ignore any quoted copy of our own earlier email inside their reply (lines starting with ">" or after "wrote:").',
    '- Read the CC line. If they copied somebody in and asked that person to handle it, that person is who we now need to',
    '  talk to: address the follow-up TO that person (by first name if known), copy the original contact, introduce GP Link',
    '  in one sentence (we support the doctor\'s registration and relocation, and will share the doctor\'s documents), ask',
    '  them to confirm they will handle the Subclass 482 nomination and visa and what they need from us and the practice.',
    '  Never ask the practice for an address that is visibly in the CC line.',
    '- If they named an agent WITHOUT an email address and that person is not on the thread, ask for the email address.',
    '- If they asked a question, answer it only if the facts below allow; otherwise leave it out of the reply and put it in',
    '  "rso_notes". NEVER write a note, instruction or square-bracket placeholder to the RSO inside "suggested_reply".',
    '- Only fill "agent_name" / "agent_email" when the reply, or the CC line, clearly identifies the migration agent or the',
    '  person who will act as one. A colleague being asked to "look into it" is "delegated", not an agent. Say which in',
    '  "agent_confidence": "confirmed" (they said this is the agent) or "likely" (copied in and asked to do it) or "".',
    '- "reply_to" must be an email address that appears in the facts or in their reply. "cc" likewise. Never invent one.',
    '- Keep it short, warm and plain. No jargon. Do not use any dashes or hyphens anywhere in the subject or body, not even',
    '  in words like "follow up"; write "follow up" as two words.',
    '- Write the reply body as PLAIN TEXT: no markdown, no asterisks, no headings, no emoji. Blank line between paragraphs.',
    '- Do not include a "Subject:" line inside the reply body. Sign off exactly as "Warm regards,", a new line with the',
    '  sender name, and a new line with "GP Link".',
    '',
    'Respond with ONLY a JSON object, no prose around it, in this exact shape:',
    '{',
    '  "outcome": one of ' + JSON.stringify(OUTCOMES) + ',',
    '  "summary": "one plain sentence saying what the practice actually said",',
    '  "handed_to": "name and email in angle brackets of the person they passed it to, or empty string",',
    '  "agent_name": "the migration agent or firm, or empty string",',
    '  "agent_email": "the agent\'s email address if known from the facts or the reply, or empty string",',
    '  "agent_confidence": "confirmed" | "likely" | "",',
    '  "reply_to": "the one email address the follow-up should go to",',
    '  "cc": ["other addresses to copy, usually the original contact"],',
    '  "suggested_subject": "subject line for the follow-up",',
    '  "suggested_reply": "the follow-up email body as plain text, nothing addressed to the RSO",',
    '  "rso_notes": "anything the RSO should check or confirm before sending, or empty string. Never sent."',
    '}',
  ].join('\n');

  var knownContacts = Array.isArray(params.knownContacts) ? params.knownContacts : [];
  var threadPeople = knownContacts.map(function (c) {
    var email = String((c && (c.email || c.email_address)) || '').trim();
    if (!email) return null;
    var header = String((c && (c.name || c.display_name)) || '').trim();
    var signed = String((c && c.signature_name) || '').trim();
    var label = signed || header;
    if (signed && header && header.toLowerCase() !== signed.toLowerCase()) label = signed + ' (' + header + ')';
    return label ? (label + ' <' + email + '>') : email;
  }).filter(Boolean);

  var copied = parseEmailList(params.replyCc).map(function (p) { return p.name ? p.name + ' <' + p.email + '>' : p.email; });

  var facts = {
    doctor: 'Dr ' + gpName,
    practice: practiceName || null,
    practice_contact_we_wrote_to: contactName || null,
    visa: 'Subclass 482 (Temporary Skill Shortage), nominated by the practice',
    planned_start_date: clean(params.commencementDate) || null,
    practice_covers_visa_costs_for_the_doctor: params.practiceCoversVisaCosts === true ? true : (params.practiceCoversVisaCosts === false ? false : null),
    reply_from: clean(params.replySender) || null,
    copied_on_their_reply: copied.length ? copied : null,
    others_on_the_email_thread: threadPeople.length ? threadPeople : null,
    sign_off_as: rsoName || 'The GP Link team',
  };

  var parts = [];
  parts.push('FACTS:\n' + JSON.stringify(facts, null, 2));
  if (params.requestText) parts.push('THE EMAIL WE SENT THEM:\n' + String(params.requestText).slice(0, 4000));
  parts.push('THEIR REPLY:\n' + String(params.replyText == null ? '' : params.replyText).slice(0, 8000));

  return {
    system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
    userText: parts.join('\n\n'),
  };
}

/**
 * Parse the model's JSON answer defensively. Returns null when nothing usable came back.
 */
function parseMigrationAgentReplyResult(raw) {
  var env = aiDraftJson.parseDraftJson(raw);
  if (!env) return null;
  var parsed = env.obj;
  var cc = Array.isArray(parsed.cc) ? parsed.cc : (typeof parsed.cc === 'string' ? parsed.cc.split(/[,;]/) : []);
  cc = cc.map(function (c) { var p = parseEmailList(c)[0]; return p ? p.email : ''; }).filter(Boolean);
  var agentEmailParsed = parseEmailList(parsed.agent_email)[0];
  var replyToParsed = parseEmailList(parsed.reply_to)[0];
  var conf = String(parsed.agent_confidence == null ? '' : parsed.agent_confidence).trim().toLowerCase();
  return {
    outcome: normalizeOutcome(parsed.outcome),
    summary: clean(parsed.summary),
    handed_to: clean(parsed.handed_to),
    agent_name: noDashes(parsed.agent_name),
    agent_email: agentEmailParsed ? agentEmailParsed.email : '',
    agent_confidence: conf === 'confirmed' || conf === 'likely' ? conf : '',
    reply_to: replyToParsed ? replyToParsed.email : '',
    cc: cc,
    suggested_subject: noDashes(parsed.suggested_subject),
    suggested_reply: String(env.body || '').replace(/[-‐-―−]+/g, ' ').replace(/ {2,}/g, ' '),
    rso_notes: env.notes || '',
  };
}

/**
 * Drop any recipient the model produced that is not an address we actually hold on this
 * thread (sender, CC line, our original contact, known thread contacts). Falls back to the
 * deterministic suggestion so a draft always has somewhere real to go.
 */
function applyRecipientGuard(draft, params) {
  params = params || {};
  var allowed = Object.create(null);
  (Array.isArray(params.allowed) ? params.allowed : []).forEach(function (a) {
    parseEmailList(a).forEach(function (p) { allowed[p.email] = true; });
  });
  var out = Object.assign({}, draft || {});
  if (out.agent_email && !allowed[out.agent_email]) {
    // An address that appears nowhere on the thread cannot be trusted as the agent's.
    out.rso_notes = (out.rso_notes ? out.rso_notes + ' ' : '') + 'The drafted agent email (' + out.agent_email + ') does not appear anywhere on the thread. Check it before recording.';
    out.agent_email = '';
    out.agent_confidence = '';
  }
  // The deterministic recipients only ever hand the follow-up to an agent address we hold.
  var fallback = suggestFollowupRecipients({
    replyFrom: params.replyFrom, originalTo: params.originalTo, handedToEmail: out.agent_email || '',
    ownAddresses: params.ownAddresses,
  });
  if (!out.reply_to || !allowed[out.reply_to]) out.reply_to = fallback.to;
  out.cc = (Array.isArray(out.cc) ? out.cc : []).filter(function (c) { return allowed[c] && c !== out.reply_to && !isOwn(c, params.ownAddresses); });
  if (!out.cc.length) out.cc = fallback.cc.filter(function (c) { return c !== out.reply_to; });
  return out;
}

/**
 * Deterministic follow-up used when the AI is unavailable, over budget, or returns junk.
 * Still NOT the original request: it reads the CC line and talks to the person the
 * practice brought in when there is exactly one, otherwise acknowledges and asks the
 * contact to confirm who the agent is.
 */
function buildMigrationAgentFallback(params) {
  params = params || {};
  var gpName = clean(params.gpName) || 'the doctor';
  var gpLast = gpName.split(' ').slice(-1)[0];
  var drShort = noDashes('Dr ' + gpLast);
  var drLong = noDashes('Dr ' + gpName);
  var practice = noDashes(params.practiceName) || 'the practice';
  var contactFirst = noDashes(firstName(params.contactName));
  var sender = noDashes(params.rsoName) || 'The GP Link team';
  var from = params.replySender || params.replyFrom || '';
  var third = thirdPartiesOnReply({ replyFrom: from, replyCc: params.replyCc, replyTo: params.replyTo, gpEmail: params.gpEmail, ownAddresses: params.ownAddresses });
  var recipients = suggestFollowupRecipients({
    replyFrom: from, originalTo: params.originalTo,
    handedToEmail: third.length === 1 ? third[0].email : '', ownAddresses: params.ownAddresses,
  });
  var subject = noDashes('Re: ' + drLong + ' Subclass 482 nomination and visa, migration agent');

  if (third.length === 1) {
    var personFirst = noDashes(firstName(third[0].name)) || 'there';
    // "Dr Ranatunga has copied you in", never "Dr has copied you in" (a bare title greeting
    // was what the first congratulations draft carried).
    var contactLabel = greetName(params.contactName) || 'The practice';
    var body = 'Hi ' + personFirst + ',\n\n'
      + contactLabel + ' has copied you in on the next step for ' + drLong + ', whose AHPRA registration has now been granted. '
      + 'We are GP Link, we support ' + drShort + '\'s registration and relocation, and we will share the documents the visa needs.\n\n'
      + 'Could you please confirm that you will be preparing the Subclass 482 nomination for ' + practice + ' and lodging ' + drShort + '\'s visa, '
      + 'and let us know what you need from the practice and from ' + drShort + ' to get started?\n\n'
      + 'The visa has to be granted before ' + drShort + ' can start, so the sooner we are underway the better.\n\n'
      + 'Warm regards,\n' + sender + '\nGP Link';
    return {
      outcome: 'delegated',
      summary: 'The practice passed the request to ' + (third[0].name || third[0].email) + ', who was copied on the reply. Nothing is confirmed yet.',
      handed_to: (third[0].name ? third[0].name + ' ' : '') + '<' + third[0].email + '>',
      agent_name: noDashes(third[0].name),
      agent_email: third[0].email,
      agent_confidence: 'likely',
      reply_to: recipients.to,
      cc: recipients.cc,
      suggested_subject: subject,
      suggested_reply: body,
      rso_notes: 'Confirm ' + (third[0].name || 'this person') + ' is a registered migration agent (or is engaging one) before recording them as the agent.',
      source: 'fallback',
    };
  }

  var body2 = 'Hi ' + (greetName(params.contactName) || contactFirst || 'there') + ',\n\n'
    + 'Thank you for coming back to us about ' + drLong + '\'s visa.\n\n'
    + 'So that we can get the Subclass 482 nomination and visa moving, could you please confirm who will be acting as the migration agent, with their name and email address? '
    + 'We will then connect them with ' + drShort + ' and share the documents they need.\n\n'
    + 'If you would like a hand choosing an agent, just say so and we will help.\n\n'
    + 'Warm regards,\n' + sender + '\nGP Link';
  return {
    outcome: 'unclear',
    summary: 'The practice replied, but did not confirm who the migration agent is.',
    handed_to: '',
    agent_name: '',
    agent_email: '',
    agent_confidence: '',
    reply_to: recipients.to,
    cc: recipients.cc,
    suggested_subject: subject,
    suggested_reply: body2,
    rso_notes: '',
    source: 'fallback',
  };
}

// ── The nudge: the practice (or the person they handed it to) has gone quiet ─────────────────
//
// Owner report 2026-11-08 (second screenshot): once the follow-up to the migration agent had
// gone, the card went back to offering the ORIGINAL congratulations email with "Send again".
// What the RSO needs then is a chase that continues the conversation with whoever we last
// wrote to. Nothing here sends.

/**
 * Who we are waiting on, from the card's own records: the person the last follow-up went to
 * (with its cc), otherwise the original practice contact.
 * params: { outboundEmail: {to, cc, subject, sent_at}, followups: [{to, cc, subject, sent_at}],
 *           practiceReply, knownContacts, ownAddresses, contactName }
 * -> { to, cc: [], name, greeting, subject, lastSentAt, waitingOn: 'followup' | 'contact' }
 */
function nudgeTarget(params) {
  params = params || {};
  var fus = Array.isArray(params.followups) ? params.followups : [];
  var last = fus.length ? fus[fus.length - 1] : null;
  var em = params.outboundEmail || {};
  var pr = params.practiceReply || null;
  var to = parseEmailList((last && last.to) || em.to || '')[0] || null;
  var toEmail = to ? to.email : '';
  var cc = parseEmailList(last ? (last.cc || '') : (em.cc || '')).map(function (p) { return p.email; })
    .filter(function (e) { return e !== toEmail && !isOwn(e, params.ownAddresses); });
  var name = '';
  if (to) {
    var known = (Array.isArray(params.knownContacts) ? params.knownContacts : []).filter(function (c) {
      return String((c && (c.email_address || c.email)) || '').toLowerCase() === toEmail;
    })[0];
    name = (known && (known.signature_name || known.display_name || known.name)) || to.name || '';
    if (!name && pr && pr.handed_to) { var h = parseEmailList(pr.handed_to)[0]; if (h && h.email === toEmail) name = h.name; }
  }
  var waitingOn = last ? 'followup' : 'contact';
  // The original contact is greeted the way our first email greeted them when we have that.
  var greeting = waitingOn === 'contact' ? (greetName(params.contactName) || greetName(name)) : greetName(name);
  return {
    to: toEmail, cc: cc, name: noDashes(name), greeting: greeting,
    subject: threadReplySubject((last && last.subject) || em.subject || ''),
    lastSentAt: (last && last.sent_at) || em.sent_at || null, waitingOn: waitingOn,
  };
}

/**
 * Deterministic chase, used before the AI answers and whenever it cannot.
 * params: { gpName, practiceName, commencementDate (long date), rsoName, target (from nudgeTarget),
 *           daysSinceLastContact }
 */
function buildMigrationAgentNudgeFallback(params) {
  params = params || {};
  var gpName = clean(params.gpName) || 'the doctor';
  var gpLast = gpName.split(' ').slice(-1)[0];
  var drShort = noDashes('Dr ' + gpLast);
  var drLong = noDashes('Dr ' + gpName);
  var practice = noDashes(params.practiceName) || 'the practice';
  var sender = noDashes(params.rsoName) || 'The GP Link team';
  var commencement = clean(params.commencementDate);
  var t = params.target || {};
  var timeline = commencement
    ? 'The visa has to be granted before ' + drShort + ' starts on ' + commencement + ', so the sooner we are underway the better.'
    : 'The visa has to be granted before ' + drShort + ' can start, so the sooner we are underway the better.';
  var body;
  if (t.waitingOn === 'followup') {
    body = 'Hi ' + (t.greeting || 'there') + ',\n\n'
      + 'Just checking in on my note below about ' + drLong + '\'s Subclass 482 nomination and visa for ' + practice + '.\n\n'
      + 'Could you let us know whether you will be handling it, and what you need from us and from the practice to get started? ' + timeline + '\n\n'
      + 'Warm regards,\n' + sender + '\nGP Link';
  } else {
    body = 'Hi ' + (t.greeting || 'there') + ',\n\n'
      + 'Just following up on my email below about ' + drLong + '\'s visa. Have you been able to engage a registered migration agent for the Subclass 482 nomination? '
      + 'If you reply with their name and email address we will connect them with ' + drShort + ' straight away and share the documents they need.\n\n'
      + timeline + '\n\n'
      + 'Warm regards,\n' + sender + '\nGP Link';
  }
  return {
    suggested_subject: t.subject || noDashes('Re: ' + drLong + ' Subclass 482 nomination and visa, migration agent'),
    suggested_reply: body,
    rso_notes: '',
    to: t.to || '',
    cc: Array.isArray(t.cc) ? t.cc : [],
    source: 'fallback',
  };
}

/**
 * Prompt for the AI chase: continue the thread with whoever we last wrote to, say only what
 * is still open, never re-send the original request.
 * params: { gpName, practiceName, commencementDate, rsoName, target, daysSinceLastContact,
 *           practiceEverReplied, lastSaid, threadText, knownContacts }
 */
function buildMigrationAgentNudgeMessages(params) {
  params = params || {};
  var t = params.target || {};
  var systemText = [
    'You are a Registration Support Officer at GP Link, which helps overseas GPs register and relocate to work in Australia.',
    '',
    'Context: AHPRA has granted a doctor\'s registration. We asked the sponsoring practice to engage a registered migration agent',
    'for the Subclass 482 nomination and the doctor\'s visa. The email thread so far is below. Nobody has answered our LAST email,',
    'so the RSO is about to send a short chase. Draft it.',
    '',
    'RULES',
    '- The draft is reviewed and sent by a human. Never claim anything was sent.',
    '- Use ONLY the facts and the thread below. Never invent names, email addresses, dates, fees or requirements.',
    '- Write to the person in "we_last_wrote_to". Continue that conversation: refer to our last email, acknowledge anything they',
    '  or the practice already said, and ask only what is still open (usually: will they handle the nomination and visa, and what',
    '  they need from us and the practice). NEVER repeat the original congratulations email or re-explain the registration.',
    '- Mention the planned start date once, as the reason the timing matters.',
    '- Keep it short (three short paragraphs at most), warm and plain. No dashes or hyphens anywhere; write "follow up" as two',
    '  words. Plain text only: no markdown, no headings, no emoji. Blank line between paragraphs. No "Subject:" line in the body.',
    '- Sign off exactly as "Warm regards,", a new line with the sender name, and a new line with "GP Link".',
    '- Anything the RSO should check goes in "rso_notes", never inside the reply body.',
    '',
    'Respond with ONLY a JSON object, no prose around it:',
    '{ "suggested_subject": "subject line", "suggested_reply": "the chase as plain text", "rso_notes": "notes for the RSO or empty string" }',
  ].join('\n');
  var knownContacts = Array.isArray(params.knownContacts) ? params.knownContacts : [];
  var threadPeople = knownContacts.map(function (c) {
    var email = String((c && (c.email || c.email_address)) || '').trim();
    if (!email) return null;
    var label = String((c && (c.signature_name || c.name || c.display_name)) || '').trim();
    return label ? (label + ' <' + email + '>') : email;
  }).filter(Boolean);
  var facts = {
    doctor: 'Dr ' + (clean(params.gpName) || 'the doctor'),
    practice: clean(params.practiceName) || null,
    planned_start_date: clean(params.commencementDate) || null,
    we_last_wrote_to: t.to ? ((t.name ? t.name + ' ' : '') + '<' + t.to + '>') : null,
    copied_on_our_last_email: (Array.isArray(t.cc) && t.cc.length) ? t.cc : null,
    days_since_our_last_email: typeof params.daysSinceLastContact === 'number' ? params.daysSinceLastContact : null,
    practice_ever_replied: !!params.practiceEverReplied,
    what_the_practice_said_last: clean(params.lastSaid) || null,
    others_on_the_email_thread: threadPeople.length ? threadPeople : null,
    sign_off_as: clean(params.rsoName) || 'The GP Link team',
  };
  var userText = 'FACTS:\n' + JSON.stringify(facts, null, 2) + '\n\nTHE THREAD SO FAR (oldest first):\n' + String(params.threadText || '(no thread)');
  return {
    system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
    userText: userText,
  };
}

/**
 * Everyone this card has corresponded with, from its own records, so a reply that arrives in a
 * NEW thread (not threaded onto our email) can still be placed on the card by address alone.
 *   contact:  the practice contact we first wrote to (outbound_email to/cc)
 *   specific: people only this card knows: whoever a follow-up or nudge went to, the person the
 *             practice handed it to, the agent, whoever replied from a different address
 * -> { contact: [emails], specific: [emails] }
 */
function cardParties(meta) {
  meta = meta || {};
  var em = meta.outbound_email || {};
  var pr = (meta.practice_reply && typeof meta.practice_reply === 'object') ? meta.practice_reply : {};
  var fus = Array.isArray(meta.followups) ? meta.followups : [];
  var contact = [], specific = [];
  var add = function (list, v) {
    parseEmailList(v).forEach(function (p) { if (p.email && list.indexOf(p.email) < 0 && !isOwn(p.email)) list.push(p.email); });
  };
  add(contact, em.to); add(contact, em.cc);
  fus.forEach(function (f) { add(specific, f && f.to); add(specific, f && f.cc); });
  add(specific, pr.reply_to); add(specific, pr.agent_email); add(specific, pr.handed_to); add(specific, pr.sender);
  (Array.isArray(pr.cc) ? pr.cc : []).forEach(function (c) { add(specific, c); });
  specific = specific.filter(function (e) { return contact.indexOf(e) < 0; });
  return { contact: contact, specific: specific };
}

function parseMigrationAgentNudgeResult(raw) {
  var env = aiDraftJson.parseDraftJson(raw);
  if (!env || !env.body) return null;
  return {
    suggested_subject: noDashes(env.obj.suggested_subject),
    suggested_reply: String(env.body).replace(/[-‐-―−]+/g, ' ').replace(/ {2,}/g, ' '),
    rso_notes: env.notes || '',
  };
}

module.exports = {
  OUTCOMES: OUTCOMES,
  GUIDE_LINE: GUIDE_LINE,
  greetName: greetName,
  threadReplySubject: threadReplySubject,
  nudgeTarget: nudgeTarget,
  buildMigrationAgentNudgeFallback: buildMigrationAgentNudgeFallback,
  buildMigrationAgentNudgeMessages: buildMigrationAgentNudgeMessages,
  parseMigrationAgentNudgeResult: parseMigrationAgentNudgeResult,
  cardParties: cardParties,
  normalizeOutcome: normalizeOutcome,
  outcomeGuidance: outcomeGuidance,
  parseEmailList: parseEmailList,
  thirdPartiesOnReply: thirdPartiesOnReply,
  suggestFollowupRecipients: suggestFollowupRecipients,
  buildMigrationAgentReplyMessages: buildMigrationAgentReplyMessages,
  parseMigrationAgentReplyResult: parseMigrationAgentReplyResult,
  applyRecipientGuard: applyRecipientGuard,
  buildMigrationAgentFallback: buildMigrationAgentFallback,
  noDashes: noDashes,
};

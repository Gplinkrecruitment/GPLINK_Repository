'use strict';

/**
 * Recover the name a correspondent actually signs off with.
 *
 * WHY THIS EXISTS
 * ---------------
 * Owner report 2026-08-19, on Dr Mercy Obanimoh's SPPA-00: the practice replied "Naomi will get
 * back to you today", and the AI's note to the RSO said *"Naomi is not on the email thread and we
 * do not have her email address"* — while the owner knew perfectly well that we do.
 *
 * We did. Naomi Milne, Practice Manager at The Doctors Werribee, is `pm@thefamilydoctors.com.au`:
 * CC'd on that very thread and the sender of four earlier emails to us. The problem was the NAME.
 * `collectCaseThreadContacts` reads names out of the mail HEADERS, and her header name is the
 * generic "Practice Manager". So the model was handed `Practice Manager <pm@thefamilydoctors.com.au>`,
 * told to look for "Naomi", found no match, and correctly-but-uselessly concluded she was a stranger.
 * The one place "Naomi Milne" appears is the sign-off of her own emails.
 *
 * A practice delegating by first name ("Naomi will send it", "ask Sarah") is the NORMAL case, so a
 * contact list keyed on role titles will keep failing exactly when it matters most.
 *
 * Deliberately deterministic rather than an AI call: it also feeds the RSO's CC picker, it has to
 * be right when the AI is off or over budget, and a wrong name here would be pasted into an email
 * to a real practice. When it cannot find a confident personal name it returns '' — the caller
 * then behaves exactly as it did before, which is the safe direction to fail.
 *
 * No external dependencies — safe to require from anywhere (server + tests).
 */

// Sign-off lines that introduce a name. Matched on a whole trimmed line, comma/dash optional.
var SIGN_OFF = /^(kind(est)? regards|warm(est)? regards|best regards|regards|many thanks|thanks|thank you|cheers|sincerely|yours sincerely|yours faithfully|best wishes|all the best|best|warmly)[,.!\s-]*$/i;

// A quoted-history marker — everything from here down belongs to somebody else's email, so their
// signature must not be mistaken for the sender's.
var QUOTE_START = /^(>|on .+ wrote:|from:\s|sent:\s|-{2,}\s*original message|_{5,})/i;

// Words that mean this line is a role, a company or boilerplate — not the human's name.
var NOT_A_NAME = /\b(practice|manager|reception|receptionist|administrat|admin|office|team|clinic|medical|centre|center|surgery|health|group|pty|ltd|limited|inc|llc|gp|doctors|hospital|department|dept|coordinator|director|officer|assistant|secretary|support|services|availability|mobile|phone|tel|fax|email|www|http|confidential|disclaimer|sent from my)\b/i;

/**
 * Is this line plausibly a person's name?
 * 1-4 words, each starting with a capital, letters plus the punctuation real names carry.
 * An optional leading title ("Dr", "Dr.") is kept — "Dr Chamira Ranatunga" is a useful answer.
 */
function looksLikePersonName(line) {
  var s = String(line == null ? '' : line).trim().replace(/[,.;:]+$/, '');
  if (!s || s.length > 60) return false;
  if (s.indexOf('@') !== -1 || /\d/.test(s)) return false;
  if (NOT_A_NAME.test(s)) return false;
  var words = s.split(/\s+/);
  if (words.length < 1 || words.length > 4) return false;
  for (var i = 0; i < words.length; i++) {
    // Allow "Dr." / "Mr." style titles and initials like "J."
    if (!/^[A-Z][A-Za-z'’.-]*$/.test(words[i])) return false;
  }
  // A single word is only a name when it is not a bare closing word ("Thanks", "Cheers").
  if (words.length === 1 && SIGN_OFF.test(words[0])) return false;
  return true;
}

/**
 * Pull the signer's name out of an email body.
 *
 * Reads only the part above any quoted history, finds sign-off lines, and takes the next line
 * that looks like a person. Uses the LAST such match, because a body can open with "Thank you"
 * long before the real sign-off at the bottom.
 *
 * @param {string} bodyText  Plain-text email body.
 * @returns {string} The name, or '' when nothing is confident.
 */
function nameFromSignature(bodyText) {
  var raw = String(bodyText == null ? '' : bodyText).replace(/\r\n/g, '\n');
  if (!raw.trim()) return '';

  var lines = raw.split('\n');
  var own = [];
  for (var i = 0; i < lines.length; i++) {
    if (QUOTE_START.test(lines[i].trim())) break;   // quoted history starts — stop
    own.push(lines[i].trim());
  }

  var found = '';
  for (var j = 0; j < own.length; j++) {
    if (!SIGN_OFF.test(own[j])) continue;
    // Look at the next couple of non-empty lines: signatures often have a blank line first.
    var checked = 0;
    for (var k = j + 1; k < own.length && checked < 2; k++) {
      if (!own[k]) continue;
      checked++;
      if (looksLikePersonName(own[k])) { found = own[k].replace(/[,.;:]+$/, ''); break; }
    }
  }
  return found;
}

module.exports = {
  nameFromSignature: nameFromSignature,
  looksLikePersonName: looksLikePersonName,
};

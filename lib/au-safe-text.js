'use strict';
/**
 * Australian GP build, fix bundle FR-1 (final review R-07).
 * THE one helper for putting a value that comes from data (a practice name, a
 * doctor's name, a role title, a staff note, a date, a link) into an
 * Australian message. Pure, no I/O.
 *
 * Why it exists. The shared email shell (server.js buildCareerEmailHtml)
 * treats a body as ready-made HTML the moment it contains anything that looks
 * like a tag, and always puts the title into the page as it is. So a practice
 * called `Evil <a href=...>click</a> Clinic` used to arrive in a doctor's
 * email as a live link. The Australian builders write plain text, so the rule
 * for them is simple: a data value must never be able to look like a tag, and
 * must never carry a line break into a subject line.
 *
 *   safeText(value, max)   for plain-text bodies, titles, subjects, bell text
 *                          and WhatsApp values. Control characters and line
 *                          breaks become one space; "<" and ">" become the
 *                          look-alike quotation marks "‹" and "›", which no
 *                          browser, mail client or header parser acts on. The
 *                          text still reads as it was typed.
 *   escapeHtml(value)      for a value placed inside HTML the builder writes
 *                          itself (an attribute or element content).
 *   safeUrl(value)         a link from data: http(s) only, no quotes, angle
 *                          brackets, spaces or control characters; '' otherwise.
 *
 * The overseas builders do not use this file and are unchanged.
 */

const LT = String.fromCharCode(0x2039); // single left-pointing angle quotation mark
const GT = String.fromCharCode(0x203a); // single right-pointing angle quotation mark

// Characters that never belong in a one-line value: every control character
// (tabs and line breaks included), the Unicode line and paragraph separators,
// and the bidirectional override characters. Built from code points so this
// file holds no raw control character.
function isUnsafeCode(code, keepNewline) {
  if (keepNewline && code === 10) return false;
  return code < 32 || (code >= 127 && code <= 159)
    || code === 0x2028 || code === 0x2029
    || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}
function scrub(value, keepNewline) {
  const raw = String(value == null ? '' : value);
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (isUnsafeCode(code, keepNewline)) out += ' ';
    else if (code === 60) out += LT;       // <
    else if (code === 62) out += GT;       // >
    else out += raw[i];
  }
  return out;
}

function safeText(value, max) {
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : 200;
  return scrub(value, false).replace(/\s+/g, ' ').trim().slice(0, limit);
}

/** The same for a block of text that may keep its own line breaks (a staff note). */
function safeBlock(value, max) {
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : 2000;
  const s = scrub(String(value == null ? '' : value).replace(/\r\n?/g, '\n'), true);
  return s.split('\n').map(function (line) { return line.replace(/[ \t]+/g, ' ').trim(); }).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, limit);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeUrl(value) {
  const s = String(value == null ? '' : value).trim();
  if (!/^https?:\/\//i.test(s)) return '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (isUnsafeCode(code, false) || code === 32 || code === 34 || code === 39 || code === 60 || code === 62 || code === 96 || code === 92) return '';
  }
  return s.slice(0, 2000);
}

/**
 * FR-2 (final review R2-04). For text that goes through the SHARED doctor
 * email shell (server.js sendGpNotificationEmail), used for every doctor,
 * overseas included. The shell pastes a body in as ready-made HTML the moment
 * it contains a tag, so a practice or doctor name carrying a tag went out
 * live. This makes every "<" inert UNLESS it starts one of the plain
 * formatting tags the app's own copy uses, written with no attributes:
 *   <br> <br/> <strong> <b> <em> <p> <ul> <ol> <li> and their closing tags.
 * Nothing else is touched: no "&", no quote, no apostrophe, no white space.
 * So any text without a foreign tag (every ordinary name, including
 * O'Brien, Smith & Sons, Zoe-accented names) comes back byte for byte.
 */
const SHELL_FORMATTING_TAG = /^<\/?(?:br|strong|b|em|p|ul|ol|li)\s*\/?>/i;
// What a browser may read as the start of markup: "<" followed by a letter,
// "/", "!" or "?". A bare "<" (as in "a scan <5MB", "x < y") is not markup.
const TAG_LIKE = /^<[\/!?a-zA-Z]/;
/**
 * FR-3 (final review S3-06). The FR-2 version turned EVERY other "<" into the
 * look-alike "‹", so an ordinary sentence such as "Is a scan <5MB OK" changed
 * in every doctor email, switch off included. The rule now changes only what
 * could be live markup:
 *   - a plain formatting tag the app's own copy uses: kept;
 *   - any other "<" that could start markup: written as the entity "&lt;"
 *     (the reader sees "<"; nothing runs);
 *   - a bare "<": left exactly as it is. The shell already sends it safely
 *     (as "&lt;" on its plain-text path), byte for byte as on main.
 * So a title or body with no foreign tag comes back byte for byte.
 */
function neutraliseForeignTags(value) {
  const s = String(value == null ? '' : value);
  if (s.indexOf('<') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 60) { out += s[i]; continue; }
    const next = s.slice(i, i + 12);
    if (SHELL_FORMATTING_TAG.test(next) || !TAG_LIKE.test(next)) out += '<';
    else out += '&lt;';
  }
  return out;
}

/**
 * FR-3 (M3-07). For a NAME placed into a title or body: a name is never
 * formatted, so anything in it that could start markup is written as "&lt;",
 * the plain formatting tags included ("<b>Jo</b>" used to arrive bold). A
 * name with no such "<" (every ordinary name) comes back byte for byte.
 */
function escapeTagLike(value) {
  const s = String(value == null ? '' : value);
  if (s.indexOf('<') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 60 && TAG_LIKE.test(s.slice(i, i + 2))) out += '&lt;';
    else out += s[i];
  }
  return out;
}

/** Does this string contain anything a browser would treat as a tag? */
function hasLiveTag(text) {
  return /<\s*\/?\s*[a-zA-Z!?]/.test(String(text == null ? '' : text));
}

module.exports = { neutraliseForeignTags, escapeTagLike, safeText, safeBlock, escapeHtml, safeUrl, hasLiveTag, LT, GT };

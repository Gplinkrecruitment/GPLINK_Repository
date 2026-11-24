'use strict';
/**
 * WP-12 (Australian GP build): the words a doctor on an Australian pathway
 * must never be shown (AGENT-RULES section 4), in one place, and a last line
 * of defence that takes them out of text the server did not write itself
 * (a practice's own job description, a benefit synced from a job ad, a label
 * built for the overseas journey).
 *
 * Pure, no I/O, no switch read. Loadable in a browser too (it is plain
 * CommonJS with no requires; tests/helpers/au-banned-words.js re-exports it).
 *
 *   BANNED_WORDS            [[name, RegExp], ...]
 *   violations(text)        the names found in a string
 *   scrubText(text)         the string with every sentence that carries one
 *                           removed ('' when nothing is left)
 *   scrubRolePayload(role)  a copy of a role / placement payload with those
 *                           words gone: list entries dropped, sentences cut
 *
 * Word boundaries are deliberate: "advisable" is not "visa", "moved" and
 * "remove" are not "your move", "epicentre" is not "EPIC".
 */

const BANNED_WORDS = Object.freeze([
  ['MyIntealth', /my\s?int(e)?alth/i],
  ['AMC', /\bAMC\b/i],
  ['EPIC', /\bEPIC\b/i],
  ['visa', /\bvisas?\b/i],
  ['relocate / relocation', /\brelocat(e|es|ed|ing|ion|ions)\b/i],
  ['your move', /\byour\s+move\b/i],
  ['overseas', /\boverseas\b/i],
  ['internationally trained', /\binternationally[\s-]+trained\b/i],
  ['GMC', /\bGMC\b/i],
  ['SPPA', /\bSPPA\b/i],
  ['Section G', /\bsection\s+G\b/i],
  ['supervisor CV', /\bsupervisor\s+CV\b/i],
  ['Not yet eligible', /\bnot\s+yet\s+eligible\b/i]
]);

/** The banned words found in `text`, by name. [] when it is clean. */
function violations(text) {
  const s = String(text == null ? '' : text);
  if (!s) return [];
  return BANNED_WORDS.filter(function (pair) { return pair[1].test(s); }).map(function (pair) { return pair[0]; });
}

function isClean(text) { return violations(text).length === 0; }

/**
 * Remove every sentence (or line, or bullet) that carries a banned word.
 * A string with no banned word comes back unchanged, byte for byte.
 */
function scrubText(text) {
  const s = String(text == null ? '' : text);
  if (!s || isClean(s)) return s;
  const lines = s.split(/\r?\n/).map(function (line) {
    if (isClean(line)) return line;
    const parts = line.match(/[^.!?;•·|]+[.!?;•·|]*\s*/g) || [line];
    return parts.filter(isClean).join('').replace(/\s+$/, '');
  });
  return lines.filter(function (line, i, all) {
    // drop a line that was emptied, keep deliberate blank lines
    return line.trim() !== '' || (s.split(/\r?\n/)[i] || '').trim() === '';
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Labels built for the overseas journey that have a plain Australian
// equivalent (APP-20). Matched whole, case-insensitively.
const RELABEL = Object.freeze([
  [/^relocation package$/i, 'Moving allowance'],
  [/^relocation explorer$/i, 'Explore the area'],
  [/^relocation support$/i, 'Moving support']
]);

function relabel(value) {
  const s = String(value == null ? '' : value).trim();
  for (let i = 0; i < RELABEL.length; i += 1) {
    if (RELABEL[i][0].test(s)) return RELABEL[i][1];
  }
  return null;
}

// Keys whose value is an address, an id or a machine token: never rewritten.
const SKIP_KEY = /(^id$|Id$|_id$|url$|Url$|href$|^src$|image|photo|logo|slug|token|^key$|email|phone|^status$|^rawStatus$|stage$|^type$|^code$|At$|_at$|date$|Date$)/;

// A role's title or a practice's name.
const NAME_KEY = /^(title|name|roleTitle|jobTitle|practiceName|practice)$/;

function looksLikeAddress(s) {
  return /^(https?:|\/|data:|mailto:|tel:)/i.test(s);
}

function isPendingValue(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '' || s === 'pending' || s === '—' || s === '-' || s === 'n/a' || s === 'tbc';
}

function scrubNode(node, depth) {
  if (depth > 12 || node === null || node === undefined) return node;
  if (typeof node === 'string') return looksLikeAddress(node) ? node : scrubText(node);
  if (Array.isArray(node)) {
    const out = [];
    node.forEach(function (entry) {
      if (typeof entry === 'string') {
        if (looksLikeAddress(entry)) { out.push(entry); return; }
        // A list of short strings (benefits, tags, filter tokens): an entry
        // that carries a banned word is dropped whole.
        if (isClean(entry)) out.push(entry);
        else { const kept = entry.length > 120 ? scrubText(entry) : ''; if (kept) out.push(kept); }
        return;
      }
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        // A labelled tile / row ({ label, value }): relabel when there is an
        // Australian word for it; drop a relabelled tile that has no value
        // (an Australian GP is not waiting on a "pending" allowance); drop any
        // other tile whose label still carries a banned word.
        if (typeof entry.label === 'string') {
          const next = relabel(entry.label);
          if (next) {
            if (isPendingValue(entry.value)) return;
            out.push(scrubNode(Object.assign({}, entry, { label: next }), depth + 1));
            return;
          }
          if (!isClean(entry.label)) return;
        }
        out.push(scrubNode(entry, depth + 1));
        return;
      }
      out.push(scrubNode(entry, depth + 1));
    });
    return out;
  }
  if (typeof node === 'object') {
    const out = {};
    Object.keys(node).forEach(function (key) {
      const value = node[key];
      if (typeof value === 'string') {
        if (SKIP_KEY.test(key) || looksLikeAddress(value)) { out[key] = value; return; }
        const next = relabel(value);
        if (next) { out[key] = next; return; }
        if (NAME_KEY.test(key) && !isClean(value)) {
          // A title or a name is never blanked: only the words themselves go.
          let kept = value;
          BANNED_WORDS.forEach(function (pair) { kept = kept.replace(new RegExp(pair[1].source, 'gi'), ''); });
          out[key] = kept.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:)])/g, '$1').replace(/^[\s,;:|–-]+|[\s,;:|–-]+$/g, '');
          return;
        }
        out[key] = scrubText(value);
        return;
      }
      out[key] = scrubNode(value, depth + 1);
    });
    return out;
  }
  return node;
}

/**
 * A copy of a role, application or placement payload that is safe to send to
 * a doctor on an Australian pathway. Ids, addresses, statuses and dates are
 * never touched. Nothing is added.
 */
function scrubRolePayload(payload) {
  return scrubNode(payload, 0);
}

/**
 * FR-5 (final review R5-01). A doctor's SAVED STATE, or their data export,
 * made safe for a doctor on an Australian pathway. The server used to write
 * the overseas placement text into saved state ("Relocation Explorer",
 * "before you relocate", "Relocation package") and only the browser corrected
 * it, so the raw state and "Download my data" still carried the words.
 *
 * Same rules as scrubRolePayload, applied to the whole document, then made
 * strict: nothing that still carries a banned word is left in ANY value
 * (a value saved as a JSON string is opened, cleaned and saved back as a
 * string; a short token that is itself a banned word is emptied; a key that
 * carries one is dropped).
 * A document with no banned word anywhere comes back as THE SAME OBJECT.
 */
function sanitiseDoctorState(value) {
  let flat = '';
  try { flat = JSON.stringify(value); } catch (e) { flat = ''; }
  if (flat && isClean(flat)) return value;
  return strictNode(scrubNode(openJsonStrings(value, 0), 0), 0);
}
function openJsonStrings(node, depth) {
  if (depth > 12 || node === null || node === undefined) return node;
  if (typeof node === 'string') {
    const t = node.trim();
    if ((t.charAt(0) === '{' || t.charAt(0) === '[') && !isClean(t)) {
      try {
        const parsed = JSON.parse(t);
        if (parsed && typeof parsed === 'object') return { __auJsonString: strictNode(scrubNode(openJsonStrings(parsed, depth + 1), 0), 0) };
      } catch (e) { /* not JSON: treated as text */ }
    }
    return node;
  }
  if (Array.isArray(node)) return node.map(function (x) { return openJsonStrings(x, depth + 1); });
  if (typeof node === 'object') {
    const out = {};
    Object.keys(node).forEach(function (k) { out[k] = openJsonStrings(node[k], depth + 1); });
    return out;
  }
  return node;
}
function strictNode(node, depth) {
  if (depth > 14 || node === null || node === undefined) return node;
  if (typeof node === 'string') {
    if (isClean(node)) return node;
    const kept = scrubText(node);
    return isClean(kept) ? kept : '';
  }
  if (Array.isArray(node)) return node.map(function (x) { return strictNode(x, depth + 1); }).filter(function (x) { return x !== ''; });
  if (typeof node === 'object') {
    if (Object.prototype.hasOwnProperty.call(node, '__auJsonString') && Object.keys(node).length === 1) return JSON.stringify(node.__auJsonString);
    const out = {};
    Object.keys(node).forEach(function (k) { if (isClean(k)) out[k] = strictNode(node[k], depth + 1); });
    return out;
  }
  return node;
}

// ── WP-14: the ONE named exception to the list above ───────────────────────
// AGENT-RULES section 4 bans "visa" for an Australian doctor. It was written
// for segment A, who has no visa. A segment B doctor whose right to work is
// tied to a sponsoring employer has a message that is legitimately ABOUT their
// visa: the transfer of their nomination to the new employer.
//
// The exception is exactly this narrow:
//   WHO    a doctor on `au_restricted` (segment B) whose gp_credentials row
//          says work_rights = 'visa' AND visa_sponsor_tied = true. Never
//          segment A or C, and never a segment B doctor who is a citizen or a
//          permanent resident, or whose sponsor tie is unknown.
//   WHERE  message N21 (to the doctor, and to their practice) and the
//          doctor's transfer page. Nowhere else: N11, N13, the checklist, the
//          bell, every other email still ban it.
//   WHAT   the word "visa" only. ("Nomination" was never on the list.) Every
//          other banned word still applies in those two places.
// Anything that wants the exception must ask sponsorTiedVisaException() with
// the doctor's own records; passing a context name alone unlocks nothing.
const SPONSOR_TIED_B_EXCEPTION = Object.freeze({
  name: 'sponsor_tied_segment_b_visa',
  pathway: 'au_restricted',
  allowedWords: Object.freeze(['visa']),
  contexts: Object.freeze(['n21', 'visa_transfer_page'])
});

/**
 * The banned words this doctor may be shown in this context ([] = none: the
 * full list applies).
 * @param {{ pathway?: string, credentials?: object, context?: string }} who
 */
function sponsorTiedVisaException(who) {
  const w = who && typeof who === 'object' ? who : {};
  if (String(w.pathway || '') !== SPONSOR_TIED_B_EXCEPTION.pathway) return [];
  if (SPONSOR_TIED_B_EXCEPTION.contexts.indexOf(String(w.context || '')) === -1) return [];
  const c = w.credentials && typeof w.credentials === 'object' ? w.credentials : null;
  if (!c || String(c.work_rights || '').trim().toLowerCase() !== 'visa' || c.visa_sponsor_tied !== true) return [];
  return SPONSOR_TIED_B_EXCEPTION.allowedWords.slice();
}

/**
 * violations() for a named doctor and place: the full list, minus only what
 * sponsorTiedVisaException allows them there.
 */
function violationsFor(text, who) {
  const allowed = sponsorTiedVisaException(who);
  const found = violations(text);
  return allowed.length ? found.filter(function (name) { return allowed.indexOf(name) === -1; }) : found;
}

module.exports = {
  sanitiseDoctorState,
  BANNED_WORDS, violations, isClean, scrubText, relabel, scrubRolePayload,
  SPONSOR_TIED_B_EXCEPTION, sponsorTiedVisaException, violationsFor
};

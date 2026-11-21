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

module.exports = { BANNED_WORDS, violations, isClean, scrubText, relabel, scrubRolePayload };

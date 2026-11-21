'use strict';
/**
 * The words a doctor on an Australian pathway must never be shown or sent
 * (AGENT-RULES section 4), for tests. The list itself lives in
 * lib/au-doctor-text.js (the server uses it too); this file adds the ways a
 * test pulls readable text out of a source file.
 *
 * Word boundaries are deliberate: "advisable" is not "visa", "moved" and
 * "remove" are not "your move", "epicentre" is not "EPIC".
 */
const text = require('../../lib/au-doctor-text.js');

/** The banned words found in a string, by name. */
function bannedIn(value) { return text.violations(value); }

/** Each line of a text that carries a banned word: ["[visa] the line", ...]. */
function bannedLines(value) {
  const out = [];
  String(value == null ? '' : value).split(/\r?\n/).forEach(function (line) {
    const v = text.violations(line);
    if (v.length) out.push('[' + v.join(', ') + '] ' + line.trim().slice(0, 200));
  });
  return out;
}

/** A script with its comments removed (what is left can reach a screen). */
function stripJsComments(js) {
  return String(js).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

/** An HTML file with comments removed (text, attributes, inline script and style stay). */
function stripHtmlComments(html) {
  return String(html).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, function (all, js) {
    return all.replace(js, stripJsComments(js));
  });
}

/** Every string a JSON-like value holds, joined by newlines. */
function allStrings(value) {
  const out = [];
  (function walk(v) {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { walk(v[k]); });
  })(value);
  return out.join('\n');
}

/** The readable text of a piece of HTML: tags removed, entities kept simple. */
function htmlText(html) {
  return String(html).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, '\n').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

module.exports = { BANNED_WORDS: text.BANNED_WORDS, bannedIn, bannedLines, stripJsComments, stripHtmlComments, allStrings, htmlText };

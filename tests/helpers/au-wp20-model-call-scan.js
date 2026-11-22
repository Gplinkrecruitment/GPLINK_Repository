'use strict';
/**
 * WP-20 (Australian GP build): find every place the app asks a generative
 * model for something, by reading the source. Used by
 * tests/au-wp20-model-call-inventory.test.js, which fails when a call exists
 * that nobody has classified ("does this prompt describe a doctor's journey,
 * and if so does it have an Australian branch?").
 *
 * A "call" is a line that sends a request to a model provider:
 *   - fetch(... 'https://api.anthropic.com/v1/messages' ...)
 *   - fetch(ANTHROPIC_MESSAGES_URL, ...)            (server.js's own constant)
 *   - doFetch(o.url || MESSAGES_URL, ...)           (lib/ads-review.js)
 *   - fetch(... 'https://api.openai.com/v1/...' ...)
 * Each is keyed by the file and the function (or the route) it sits in, so a
 * line moving up or down the file changes nothing, and a new call in a new
 * function or route is a new key.
 */
const fs = require('fs');
const path = require('path');

const CALL_PATTERNS = [
  /\bfetch(?:Impl)?\(\s*['"`]https:\/\/api\.anthropic\.com\/v1\/messages['"`]/,
  /\bfetch\(\s*ANTHROPIC_MESSAGES_URL\b/,
  /\bdoFetch\(\s*o\.url \|\| MESSAGES_URL\b/,
  /\bfetch(?:Impl)?\(\s*['"`]https:\/\/api\.openai\.com\/v1\/[a-z/]+['"`]/
];

// Anything that would be a model call this scan does not understand: another
// provider's host, or a provider SDK. None exists today; if one appears the
// inventory test fails until the scan and the inventory are taught about it.
const UNKNOWN_PROVIDER_PATTERNS = [
  /generativelanguage\.googleapis\.com/, /aiplatform\.googleapis\.com/, /api\.x\.ai/, /api\.mistral\.ai/, /api\.groq\.com/,
  /openrouter\.ai/, /api\.cohere\.(ai|com)/, /bedrock-runtime/, /api\.deepseek\.com/, /api\.together\.xyz/, /api\.perplexity\.ai/,
  /require\(\s*['"]@anthropic-ai\/sdk['"]\s*\)/, /require\(\s*['"]openai['"]\s*\)/, /from\s+['"]@anthropic-ai\/sdk['"]/, /from\s+['"]openai['"]/
];

// Where a call "lives": the nearest function declared at the start of a line,
// or the nearest API route test, above it.
const FUNCTION_LINE = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/;
const NESTED_FUNCTION_LINE = /^ {2}(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/;
const ROUTE_LINE = /pathname === '(\/api\/[^']+)'/;

function sourceFiles(root) {
  const lib = fs.readdirSync(path.join(root, 'lib')).filter(function (f) { return /\.js$/.test(f); }).sort().map(function (f) { return 'lib/' + f; });
  return ['server.js'].concat(lib);
}

/**
 * @param {string} root  the repository root
 * @returns {{ calls: Array<{ file, line, key, where }>, counts: Object<string, number>, unknown: Array<{ file, line, text }> }}
 */
function scanModelCalls(root) {
  const calls = [];
  const unknown = [];
  sourceFiles(root).forEach(function (file) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    let fn = '';
    let nested = '';
    let route = '';
    let routeLine = -1;
    let fnLine = -1;
    lines.forEach(function (text, i) {
      const f = FUNCTION_LINE.exec(text);
      if (f) { fn = f[1]; fnLine = i; nested = ''; }
      const n = NESTED_FUNCTION_LINE.exec(text);
      if (n) nested = n[1];
      const r = ROUTE_LINE.exec(text);
      if (r) { route = r[1]; routeLine = i; }
      if (UNKNOWN_PROVIDER_PATTERNS.some(function (p) { return p.test(text); }) && !/^\s*(\/\/|\*)/.test(text)) {
        unknown.push({ file, line: i + 1, text: text.trim().slice(0, 160) });
      }
      if (!CALL_PATTERNS.some(function (p) { return p.test(text); })) return;
      // The route wins when it was seen after the enclosing top-level function
      // began (the giant request handler holds every route).
      const where = routeLine > fnLine && route ? route : (fn || nested || '(top level)');
      calls.push({ file, line: i + 1, key: file + '#' + where, where });
    });
  });
  const counts = {};
  calls.forEach(function (c) { counts[c.key] = (counts[c.key] || 0) + 1; });
  return { calls, counts, unknown };
}

module.exports = { scanModelCalls, CALL_PATTERNS, UNKNOWN_PROVIDER_PATTERNS };

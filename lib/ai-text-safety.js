'use strict';

/**
 * Keep text that is on its way to the Anthropic API valid as JSON.
 *
 * WHY THIS EXISTS
 * ---------------
 * Owner report 2026-08-19: the RSO "AI Summary" box on Dr Mercy Obanimoh's case showed
 *
 *   AI service error: The request body is not valid JSON:
 *   no low surrogate in string: line 1 column 7765 (char 7764)
 *
 * That is the Anthropic API refusing to parse OUR request body. Char 7764 lands inside the
 * "EMAILS FROM GMAIL" block of the candidate-summary prompt, which is built by truncating each
 * Gmail snippet with `.substring(0, 200)`.
 *
 * A JavaScript string is UTF-16, so an emoji (and anything else outside the BMP) is stored as a
 * SURROGATE PAIR — two code units that only mean something together. `.substring`, `.slice` and
 * `.length` all count code units, so a cut that lands between the two halves leaves a lone
 * surrogate at the end of the string. `JSON.stringify` faithfully encodes it as `\udXXX`
 * (well-formed stringify, ES2019), which is syntactically legal JSON but decodes to nothing —
 * so the receiving parser rejects the whole body and every AI feature on that case dies at once.
 * One emoji in one email footer is enough.
 *
 * Two layers here, deliberately:
 *   1. `clipText`  — the ROOT fix. Truncate on a character boundary so a pair is never split.
 *   2. `installAnthropicRequestGuard` — the BELT. There are ~39 `fetch('https://api.anthropic.com/…')`
 *      call sites across server.js and lib/, each stringifying text harvested from email, PDFs,
 *      CVs and WhatsApp. Fixing only the one that was reported leaves the other 38 able to fail
 *      the same way. The guard scrubs lone surrogates out of any Anthropic request body once,
 *      centrally, so no future call site has to remember.
 *
 * The scrub DROPS lone surrogates rather than substituting U+FFFD: a half-character carries no
 * meaning, and a replacement character in the middle of a prompt is just noise the model has to
 * explain away. Well-formed text is returned untouched.
 *
 * No external dependencies — safe to require from anywhere (server + tests).
 */

var ANTHROPIC_ORIGIN = 'https://api.anthropic.com/';

/**
 * Remove unpaired UTF-16 surrogates. Valid pairs (real emoji and other astral characters)
 * survive untouched.
 * @param {*} value
 * @returns {string}
 */
function stripLoneSurrogates(value) {
  var str = String(value == null ? '' : value);
  // Fast path: the overwhelming majority of strings have no surrogates at all.
  if (!/[\uD800-\uDFFF]/.test(str)) return str;
  var out = '';
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      var next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xDC00 && next <= 0xDFFF) { out += str[i] + str[i + 1]; i++; }
      // else: lone high surrogate — drop it
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      // lone low surrogate — drop it (a paired one is consumed by the branch above)
    } else {
      out += str[i];
    }
  }
  return out;
}

/**
 * Truncate to at most `max` UTF-16 code units WITHOUT splitting a surrogate pair.
 * Use this everywhere a `.substring(0, n)` feeds text into an AI prompt.
 * @param {*} value
 * @param {number} max
 * @returns {string}
 */
function clipText(value, max) {
  var str = String(value == null ? '' : value);
  var limit = Number(max);
  if (!Number.isFinite(limit) || limit <= 0) return '';
  if (str.length <= limit) return stripLoneSurrogates(str);
  // If the cut lands on a high surrogate, step back one so the pair stays whole.
  var end = limit;
  var last = str.charCodeAt(end - 1);
  if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
  return stripLoneSurrogates(str.slice(0, end));
}

/**
 * Deep-scrub every string in a JSON-serialisable value. Returns a new value; the input is
 * never mutated (the callers pass request payloads that other code may still be reading).
 */
function scrubDeep(value) {
  if (typeof value === 'string') return stripLoneSurrogates(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') {
    var out = {};
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) out[keys[i]] = scrubDeep(value[keys[i]]);
    return out;
  }
  return value;
}

// A `\uXXXX` escape for a surrogate, as it appears in JSON TEXT. This matters because
// `JSON.stringify` does NOT leave a lone surrogate as a raw code unit — it encodes it as the
// six ASCII characters `\ud83d`. A well-formed pair is emitted as the literal character
// instead, so any surrogate ESCAPE in stringify output is, by construction, a lone one.
// The leading `(^|[^\\])(\\\\)*` makes sure the backslash we matched is a real escape and not
// itself escaped — `\\ud83d` in the text is a literal backslash followed by "ud83d", which is
// somebody writing about an escape sequence, not a broken character.
var LONE_SURROGATE_ESCAPE = /(^|[^\\])(\\\\)*\\u[dD][0-9a-fA-F]{3}/;

/**
 * Clean one outbound request body.
 *
 * Two different shapes of the same damage, and both have to be handled:
 *   1. Raw lone code units — a body that was assembled without JSON.stringify.
 *   2. Lone `\udXXX` ESCAPES — what JSON.stringify produces, and what the remote parser
 *      actually rejects. Stripping code units alone would be a no-op here, which is exactly
 *      the trap this function exists to avoid.
 *
 * For (2) the body is parsed, scrubbed as a value, and re-serialised — exact, where a regex
 * over JSON text would have to reason about escaping and nesting. Only paid for when the cheap
 * pre-check fires, so a healthy body is never round-tripped. A body that is not JSON is left
 * with its escapes: there is nothing safe to do, and this is a guard, not a rewriter.
 */
function scrubRequestBody(body) {
  var out = stripLoneSurrogates(body);
  if (LONE_SURROGATE_ESCAPE.test(out)) {
    try { out = JSON.stringify(scrubDeep(JSON.parse(out))); } catch (e) { /* not JSON — leave as-is */ }
  }
  return out;
}

/**
 * Is this the URL of an Anthropic API call? Accepts the string/URL/Request forms `fetch` takes.
 */
function isAnthropicUrl(input) {
  var url = '';
  if (typeof input === 'string') url = input;
  else if (input && typeof input.url === 'string') url = input.url;       // Request
  else if (input && typeof input.href === 'string') url = input.href;      // URL
  else if (input != null) { try { url = String(input); } catch (e) { url = ''; } }
  return url.indexOf(ANTHROPIC_ORIGIN) === 0;
}

/**
 * Install a one-time `fetch` wrapper that scrubs lone surrogates out of Anthropic request
 * bodies. Idempotent, and a no-op for every other host — a request to anything but
 * api.anthropic.com is passed straight through, untouched and unparsed.
 *
 * Only string bodies are touched. A stream/Buffer body is left alone: nothing here sends one,
 * and silently re-encoding binary would be worse than the bug this prevents.
 *
 * @param {Object} scope  Usually `globalThis`. Injectable so tests need no global side effects.
 * @returns {boolean} true if the guard was installed by this call, false if already present.
 */
function installAnthropicRequestGuard(scope) {
  var target = scope || globalThis;
  if (typeof target.fetch !== 'function') return false;
  if (target.fetch.__anthropicSurrogateGuard) return false;
  var original = target.fetch;
  var wrapped = function (input, init) {
    if (init && typeof init.body === 'string' && isAnthropicUrl(input)) {
      var scrubbed = scrubRequestBody(init.body);
      if (scrubbed !== init.body) {
        console.warn('[ai-text-safety] stripped unpaired surrogate(s) from an Anthropic request body');
        init = Object.assign({}, init, { body: scrubbed });
      }
    }
    return original.call(target, input, init);
  };
  wrapped.__anthropicSurrogateGuard = true;
  target.fetch = wrapped;
  return true;
}

module.exports = {
  stripLoneSurrogates: stripLoneSurrogates,
  scrubRequestBody: scrubRequestBody,
  clipText: clipText,
  scrubDeep: scrubDeep,
  isAnthropicUrl: isAnthropicUrl,
  installAnthropicRequestGuard: installAnthropicRequestGuard,
  ANTHROPIC_ORIGIN: ANTHROPIC_ORIGIN,
};

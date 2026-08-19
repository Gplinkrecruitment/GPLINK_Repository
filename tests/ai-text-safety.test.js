// The bug this file exists for (owner report 2026-08-19, Dr Mercy Obanimoh's case):
//
//   AI service error: The request body is not valid JSON:
//   no low surrogate in string: line 1 column 7765 (char 7764)
//
// That is Anthropic refusing to parse OUR request. The candidate-summary prompt truncates each
// Gmail snippet with `.substring(0, 200)`; a cut that lands between the two halves of an emoji
// leaves a lone UTF-16 surrogate, JSON.stringify encodes it as `\udXXX`, and the receiving
// parser rejects the whole body — taking every AI feature on that case down with it.
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const lib = require('../lib/ai-text-safety.js');

const serverSrc = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

// A lone surrogate escape in serialised JSON — what the remote parser chokes on.
const LONE_ESCAPE = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i;

const EMOJI = '\u{1F4E7}';            // 📧 — one character, two UTF-16 code units
const LONE_HIGH = '\uD83D';           // the first half of one, on its own
const LONE_LOW = '\uDCE7';            // the second half, on its own

describe('stripLoneSurrogates', () => {
  it('leaves ordinary text exactly as it was', () => {
    expect(lib.stripLoneSurrogates('Naomi will get back to you today')).toBe('Naomi will get back to you today');
  });

  it('keeps a real emoji — a valid pair is a character, not damage', () => {
    expect(lib.stripLoneSurrogates('Call me ' + EMOJI + ' today')).toBe('Call me ' + EMOJI + ' today');
    expect(lib.stripLoneSurrogates(EMOJI).length).toBe(2);
  });

  it('drops a lone high surrogate left by a truncation', () => {
    expect(lib.stripLoneSurrogates('Regards,' + LONE_HIGH)).toBe('Regards,');
  });

  it('drops a lone low surrogate left by a slice from the middle', () => {
    expect(lib.stripLoneSurrogates(LONE_LOW + ' sent from my iPhone')).toBe(' sent from my iPhone');
  });

  it('handles empty and nullish input without throwing', () => {
    expect(lib.stripLoneSurrogates('')).toBe('');
    expect(lib.stripLoneSurrogates(null)).toBe('');
    expect(lib.stripLoneSurrogates(undefined)).toBe('');
  });

  it('produces JSON with no lone-surrogate escape — the actual failure condition', () => {
    const broken = JSON.stringify({ snippet: 'Kind regards' + LONE_HIGH });
    expect(LONE_ESCAPE.test(broken)).toBe(true);          // reproduces the 400
    const fixed = JSON.stringify({ snippet: lib.stripLoneSurrogates('Kind regards' + LONE_HIGH) });
    expect(LONE_ESCAPE.test(fixed)).toBe(false);
  });
});

describe('clipText', () => {
  it('truncates to the limit like substring does', () => {
    expect(lib.clipText('abcdefghij', 4)).toBe('abcd');
  });

  it('returns the whole string when it is already short enough', () => {
    expect(lib.clipText('short', 200)).toBe('short');
  });

  it('never splits an emoji — the exact cut that broke the summary', () => {
    // 199 plain characters then an emoji: substring(0, 200) lands between its halves.
    const text = 'a'.repeat(199) + EMOJI + ' more text';
    expect(LONE_ESCAPE.test(JSON.stringify(text.substring(0, 200)))).toBe(true);
    const clipped = lib.clipText(text, 200);
    expect(LONE_ESCAPE.test(JSON.stringify(clipped))).toBe(false);
    expect(clipped).toBe('a'.repeat(199));                // stepped back, kept the pair whole
  });

  it('keeps an emoji that fits inside the limit', () => {
    const text = 'a'.repeat(198) + EMOJI + ' more';
    expect(lib.clipText(text, 200)).toBe('a'.repeat(198) + EMOJI);
  });

  it('returns empty for a non-positive or unusable limit', () => {
    expect(lib.clipText('anything', 0)).toBe('');
    expect(lib.clipText('anything', NaN)).toBe('');
  });
});

describe('scrubRequestBody', () => {
  // The trap: JSON.stringify does not leave a lone surrogate as a code unit, it writes the six
  // ASCII characters `\ud83d`. A scrub that only looks for code units sees a clean body and
  // does nothing — which is precisely the bug that reached production.
  it('removes the lone-surrogate ESCAPE that JSON.stringify writes', () => {
    const body = JSON.stringify({ content: 'Kind regards' + LONE_HIGH });
    expect(body).toContain('\\ud83d');
    const cleaned = lib.scrubRequestBody(body);
    expect(LONE_ESCAPE.test(cleaned)).toBe(false);
    expect(JSON.parse(cleaned).content).toBe('Kind regards');
  });

  it('leaves a healthy body untouched, emoji and all', () => {
    const body = JSON.stringify({ content: 'Call me ' + EMOJI, n: 4096 });
    expect(lib.scrubRequestBody(body)).toBe(body);
  });

  it('does not mangle text that merely talks about an escape sequence', () => {
    const body = JSON.stringify({ content: 'the escape \\ud83d means an emoji half' });
    expect(JSON.parse(lib.scrubRequestBody(body)).content).toBe('the escape \\ud83d means an emoji half');
  });

  it('still handles a raw code unit in a body that is not JSON at all', () => {
    expect(lib.scrubRequestBody('plain text' + LONE_HIGH)).toBe('plain text');
  });
});

describe('isAnthropicUrl', () => {
  it('recognises the messages endpoint', () => {
    expect(lib.isAnthropicUrl('https://api.anthropic.com/v1/messages')).toBe(true);
  });

  it('does not match any other host, including a lookalike', () => {
    expect(lib.isAnthropicUrl('https://api.openai.com/v1/chat')).toBe(false);
    expect(lib.isAnthropicUrl('https://evil.example/api.anthropic.com/v1/messages')).toBe(false);
    expect(lib.isAnthropicUrl(undefined)).toBe(false);
  });
});

describe('installAnthropicRequestGuard', () => {
  function scopeWithSpy() {
    const seen = [];
    const scope = { fetch: (input, init) => { seen.push({ input, init }); return Promise.resolve('ok'); } };
    return { scope, seen };
  }

  it('scrubs a lone surrogate out of an Anthropic body', async () => {
    const { scope, seen } = scopeWithSpy();
    expect(lib.installAnthropicRequestGuard(scope)).toBe(true);
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'Kind regards' + LONE_HIGH }] });
    expect(LONE_ESCAPE.test(body)).toBe(true);
    await scope.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body });
    expect(LONE_ESCAPE.test(seen[0].init.body)).toBe(false);
    expect(seen[0].init.body).toContain('Kind regards');
  });

  it('leaves a well-formed body byte-for-byte identical', async () => {
    const { scope, seen } = scopeWithSpy();
    lib.installAnthropicRequestGuard(scope);
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'Call me ' + EMOJI }] });
    await scope.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body });
    expect(seen[0].init.body).toBe(body);
  });

  it('does not touch requests to any other host', async () => {
    const { scope, seen } = scopeWithSpy();
    lib.installAnthropicRequestGuard(scope);
    const body = 'raw' + LONE_HIGH;
    await scope.fetch('https://graph.facebook.com/v21.0/me', { method: 'POST', body });
    expect(seen[0].init.body).toBe(body);
  });

  it('passes through a request with no body at all', async () => {
    const { scope, seen } = scopeWithSpy();
    lib.installAnthropicRequestGuard(scope);
    await scope.fetch('https://api.anthropic.com/v1/messages');
    expect(seen[0].init).toBeUndefined();
  });

  it('is idempotent — requiring server.js twice must not stack wrappers', () => {
    const { scope } = scopeWithSpy();
    expect(lib.installAnthropicRequestGuard(scope)).toBe(true);
    expect(lib.installAnthropicRequestGuard(scope)).toBe(false);
  });

  it('does nothing when the scope has no fetch', () => {
    expect(lib.installAnthropicRequestGuard({})).toBe(false);
  });
});

describe('server wiring', () => {
  it('installs the guard once, at require time, so every call site is covered', () => {
    expect(serverSrc).toContain("require('./lib/ai-text-safety.js')");
    expect(serverSrc).toContain('aiTextSafety.installAnthropicRequestGuard(globalThis);');
  });

  it('clips the candidate-summary prompt on character boundaries instead of substring', () => {
    const summaryFrom = serverSrc.indexOf("prompt += '\\n--- EMAILS FROM GMAIL (");
    expect(summaryFrom).toBeGreaterThan(-1);
    const block = serverSrc.slice(summaryFrom, summaryFrom + 3000);
    expect(block).toContain('aiTextSafety.clipText(e.snippet, 200)');
    expect(block).toContain('aiTextSafety.clipText(m.body_text, 200)');
    expect(block).not.toContain('.substring(0, 200)');
  });
});

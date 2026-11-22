'use strict';
/**
 * WP-20 (Australian GP build): boot the real server with a STUBBED model.
 *
 * No AI provider is ever reached: every request to api.anthropic.com or
 * api.openai.com is answered here, recorded in `rig.ai.calls`, and replied to
 * with whatever the test set in `rig.ai.reply` (a string, or a function of
 * the parsed request body). The API keys are obvious fakes; they only switch
 * the server's "is AI configured?" checks on.
 */
const { bootAuTestServer } = require('./au-server-harness.js');

const FAKE_KEY = 'test-key-not-real';
// The app's own base address in these tests (APP_BASE_URL). Never resolved: the
// rig sends anything addressed to it back to the booted test server.
const SELF_ORIGIN = 'http://wp20-self.gplink-test.local';

function isAiUrl(u) {
  return u.indexOf('https://api.anthropic.com/') === 0 || u.indexOf('https://api.openai.com/') === 0;
}

async function bootWp20Rig(opts) {
  const o = opts || {};
  const h = await bootAuTestServer({
    name: o.name || 'wp20',
    tables: o.tables || {},
    env: Object.assign({ ANTHROPIC_API_KEY: FAKE_KEY, OPENAI_API_KEY: FAKE_KEY, APP_BASE_URL: SELF_ORIGIN }, o.env || {})
  });
  const harnessFetch = globalThis.fetch;
  const ai = {
    calls: [],
    /** string | (body, url) => string. The text the "model" answers with. */
    reply: 'OK',
    /** HTTP status the provider answers with (200 unless a test says otherwise). */
    status: 200,
    reset() { ai.calls.length = 0; ai.reply = 'OK'; ai.status = 200; },
    last() { return ai.calls[ai.calls.length - 1] || null; },
    /** Every string the model was sent in one call (system + messages), joined. */
    textOf(call) {
      const b = (call && call.body) || {};
      const out = [];
      const walk = function (v) {
        if (typeof v === 'string') out.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') {
          if (typeof v.text === 'string') out.push(v.text);
          if (v.content !== undefined) walk(v.content);
        }
      };
      walk(b.system); walk(b.messages); walk(b.input);
      return out.join('\n');
    }
  };
  globalThis.fetch = function (url, init) {
    const u = String(url && url.url ? url.url : url);
    // A job that calls the app's own endpoints (the summary refresher) is sent
    // back to this test server.
    if (u.indexOf(SELF_ORIGIN) === 0) return harnessFetch('http://127.0.0.1:' + h.port + u.slice(SELF_ORIGIN.length), init);
    if (!isAiUrl(u)) return harnessFetch(url, init);
    let body = null;
    try { body = JSON.parse(String((init && init.body) || '')); } catch (e) { body = null; }
    ai.calls.push({ url: u, body, raw: String((init && init.body) || '') });
    const text = typeof ai.reply === 'function' ? ai.reply(body, u) : ai.reply;
    const payload = u.indexOf('api.openai.com') !== -1
      ? { output_text: String(text) }
      : { content: [{ type: 'text', text: String(text) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    return Promise.resolve(new Response(JSON.stringify(payload), { status: ai.status, headers: { 'Content-Type': 'application/json' } }));
  };
  const close = h.close;
  h.ai = ai;
  h.close = async function () { globalThis.fetch = harnessFetch; await close(); };
  return h;
}

module.exports = { bootWp20Rig, FAKE_KEY, SELF_ORIGIN };

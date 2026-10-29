// Inbound SMS on Hazel's Twilio number (the UK mobile she calls from).
// Pure helpers, bound to HTTP in server.js (handleTwilioSms). GPs sometimes text
// the number back ("who is this?", "call me after 6"); Twilio has no inbox, so
// every text is forwarded to the owner by email and the sender gets one
// automatic reply pointing them to WhatsApp or email. Nothing here throws on
// bad input: a malformed request becomes a 4xx in the handler, never a crash.
'use strict';

const crypto = require('crypto');

// Twilio signs each webhook: base64(HMAC-SHA1(authToken, url + sortedParamsConcat)).
// `url` must be exactly what Twilio requested (scheme, host, path, query).
function expectedTwilioSignature(url, params, authToken) {
  const keys = Object.keys(params || {}).sort();
  let data = String(url || '');
  for (const k of keys) data += k + String(params[k] == null ? '' : params[k]);
  return crypto.createHmac('sha1', String(authToken || '')).update(data, 'utf8').digest('base64');
}

function verifyTwilioSignature(url, params, signatureHeader, authToken) {
  if (!authToken || !signatureHeader || typeof signatureHeader !== 'string') return false;
  const expected = Buffer.from(expectedTwilioSignature(url, params, authToken), 'utf8');
  const got = Buffer.from(signatureHeader.trim(), 'utf8');
  if (expected.length !== got.length) return false;
  try { return crypto.timingSafeEqual(expected, got); } catch (e) { return false; }
}

// Twilio posts application/x-www-form-urlencoded.
function parseFormBody(raw) {
  const out = {};
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  for (const [k, v] of new URLSearchParams(text)) out[k] = v;
  return out;
}

// The public URL Twilio signed: APP_BASE_URL + the request path and query,
// never the Host header (Vercel rewrites it behind the proxy).
function publicUrl(baseUrl, reqUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const pathAndQuery = String(reqUrl || '/').replace(/^\/*/, '/');
  return base + pathAndQuery;
}

const OPT_OUT = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|opt\s*out)\b/i;
function isOptOut(body) { return OPT_OUT.test(String(body || '')); }

function autoReplyText({ whatsapp, email }) {
  const wa = String(whatsapp || '').trim();
  const em = String(email || '').trim();
  return 'Hi, this is GP Link. This number is our call line and texts here aren\'t read straight away. '
    + 'For anything about GP work in Australia, message us on WhatsApp' + (wa ? ' at ' + wa : '')
    + (em ? ' or email ' + em : '') + ' and we\'ll come straight back to you.';
}

function xmlEscape(s) {
  return String(s == null ? '' : s).replace(/[<>&'"]/g, function (c) {
    return { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c];
  });
}

// TwiML: an empty <Response/> acknowledges without replying.
function twiml(message) {
  const body = message ? '<Message>' + xmlEscape(message) + '</Message>' : '';
  return '<?xml version="1.0" encoding="UTF-8"?><Response>' + body + '</Response>';
}

function forwardEmail({ from, to, body, messageSid, numMedia, receivedAt }) {
  const when = receivedAt instanceof Date ? receivedAt.toISOString() : String(receivedAt || new Date().toISOString());
  const text = String(body || '').trim() || '(no text)';
  const media = Number(numMedia || 0) > 0 ? '\nAttachments: ' + Number(numMedia) + ' (view in Twilio Console, Monitor, Logs, Messaging)' : '';
  return {
    subject: 'Text to Hazel\'s number from ' + String(from || 'unknown'),
    bodyText: 'A text arrived on ' + String(to || 'the call line') + ' at ' + when + ' UTC.\n\n'
      + 'From: ' + String(from || 'unknown') + '\n'
      + 'Message: ' + text + media + '\n\n'
      + 'Twilio message id: ' + String(messageSid || '') + '\n'
      + 'The sender has been told to use WhatsApp or email; reply to them on WhatsApp or by calling back.'
  };
}

module.exports = {
  expectedTwilioSignature,
  verifyTwilioSignature,
  parseFormBody,
  publicUrl,
  isOptOut,
  autoReplyText,
  xmlEscape,
  twiml,
  forwardEmail
};

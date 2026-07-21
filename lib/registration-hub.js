'use strict';

function buildSenderDisplayName(rsoName) {
  var name = (rsoName == null ? '' : String(rsoName)).trim();
  return name ? name + ', GP Link' : 'GP Link Registration';
}

function resolveSender(opts) {
  opts = opts || {};
  var hubEmail = String(opts.hubEmail || '').trim().toLowerCase();
  var rsoEmail = String(opts.rsoEmail || '').trim().toLowerCase();
  var fallback = String(opts.fallback || 'hazel@mygplink.com.au').trim().toLowerCase();
  if (hubEmail && /@mygplink\.com\.au$/.test(hubEmail)) {
    return { from: hubEmail, fromName: buildSenderDisplayName(opts.rsoName) };
  }
  var from = /@mygplink\.com\.au$/.test(rsoEmail) ? rsoEmail : fallback;
  return { from: from, fromName: 'GP Link Registration' };
}

function isHubInbox(email, hubEmail) {
  if (!hubEmail) return false;
  return String(email || '').trim().toLowerCase() === String(hubEmail).trim().toLowerCase();
}

function buildFromHeader(fromName, fromEmail) {
  var name = String(fromName || '').trim() || 'GP Link Registration';
  // RFC 2047-encode the display name when it contains any non-ASCII character (e.g. the
  // em dash in "Hazel, GP Link", or an accented RSO name). Without this the raw UTF-8
  // bytes render as mojibake in the From header ("GP Link Admin Ã¢Â€Â" GP Link"), which
  // also looks malformed to spam filters. ASCII names keep the plain quoted form.
  var display = /[^\x00-\x7F]/.test(name)
    ? '=?UTF-8?B?' + Buffer.from(name, 'utf8').toString('base64') + '?='
    : '"' + name.replace(/"/g, '') + '"';
  return 'From: ' + display + ' <' + fromEmail + '>';
}

module.exports = { buildSenderDisplayName, resolveSender, isHubInbox, buildFromHeader };

'use strict';

function buildSenderDisplayName(rsoName) {
  var name = (rsoName == null ? '' : String(rsoName)).trim();
  return name ? name + ' — GP Link' : 'GP Link Registration';
}

function resolveSender(opts) {
  opts = opts || {};
  var hubEmail = String(opts.hubEmail || '').trim().toLowerCase();
  var rsoEmail = String(opts.rsoEmail || '').trim().toLowerCase();
  var fallback = String(opts.fallback || 'hazel@mygplink.com.au').trim().toLowerCase();
  if (hubEmail) {
    return { from: hubEmail, fromName: buildSenderDisplayName(opts.rsoName) };
  }
  var from = /@mygplink\.com\.au$/.test(rsoEmail) ? rsoEmail : fallback;
  return { from: from, fromName: 'GP Link Registration' };
}

function isHubInbox(email, hubEmail) {
  if (!hubEmail) return false;
  return String(email || '').trim().toLowerCase() === String(hubEmail).trim().toLowerCase();
}

module.exports = { buildSenderDisplayName, resolveSender, isHubInbox };

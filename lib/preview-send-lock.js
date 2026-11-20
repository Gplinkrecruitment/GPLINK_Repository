'use strict';

// Preview send lock (WP-00S, Australian GP build).
//
// The Vercel PREVIEW deployment shares the production database and the
// production Resend, DoubleTick, Gmail, Google Calendar and Calendly keys.
// Anything a tester does there would message a real doctor or practice. This
// module decides, for one environment, what may leave the building.
//
//   "Vercel preview"  = VERCEL_ENV is set and is not "production".
//                       NODE_ENV is NOT used: Vercel sets it to "production"
//                       on previews, and tests/local runs must be unaffected.
//
//   production / localhost / test runner  -> mode 'off'. Nothing here changes
//       anything: the existing NOTIFY_TEST_RECIPIENTS allow-list behaves
//       exactly as it always has (unset = unrestricted).
//   preview, NOTIFY_TEST_RECIPIENTS set   -> mode 'allowlist'. Only the listed
//       addresses/numbers can be reached, on EVERY channel below.
//   preview, list unset or empty          -> mode 'block_all'. Nothing is sent.
//
// Deliberately NOT tied to AU_PATHWAY_ENABLED: it protects any preview.
//
// Pure module: every function takes `env` (or a lock built from one). No env
// reads at load, no I/O. server.js calls resolveSendLock(process.env) at call
// time, never caching the answer in a module-level constant.

const { createNotifyAllowlist, normaliseEmail, phoneDigits, maskRecipient } = require('./notify-allowlist.js');

function isVercelPreview(env) {
  const v = String((env && env.VERCEL_ENV) == null ? '' : env.VERCEL_ENV).trim().toLowerCase();
  return !!v && v !== 'production';
}

// One-entry memo so a hot send path does not re-parse the list every call.
// Keyed on the two inputs, so a changed env is always picked up.
let memoKey = null;
let memoLock = null;

// Returns { preview, mode, allowlist }.
//   mode: 'off' | 'allowlist' | 'block_all'
//   allowlist: a lib/notify-allowlist instance. On a preview it is always
//   active (an empty list permits nobody). Off a preview it is the ordinary
//   list: inactive when unset.
function resolveSendLock(env) {
  const e = env || {};
  const preview = isVercelPreview(e);
  const raw = String(e.NOTIFY_TEST_RECIPIENTS == null ? '' : e.NOTIFY_TEST_RECIPIENTS);
  const key = (preview ? 'p' : 'n') + '\u0000' + raw;
  if (key === memoKey && memoLock) return memoLock;
  const allowlist = createNotifyAllowlist(raw, { failClosed: preview });
  const mode = !preview ? 'off' : (allowlist.size > 0 ? 'allowlist' : 'block_all');
  memoKey = key;
  memoLock = { preview, mode, allowlist };
  return memoLock;
}

// 'allowlist' | 'block_all' on a preview, null everywhere else.
function previewSendLockMode(env) {
  const lock = resolveSendLock(env);
  return lock.preview ? lock.mode : null;
}

// Split an address header ("A <a@x>, \"Last, First\" <b@y>") on the commas
// that separate recipients, not the ones inside quotes or angle brackets.
function splitAddressList(value) {
  if (Array.isArray(value)) {
    return value.reduce(function (acc, v) { return acc.concat(splitAddressList(v)); }, []);
  }
  const s = String(value == null ? '' : value);
  const out = [];
  let cur = '';
  let inQuote = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === '<') depth++;
    else if (!inQuote && ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && !inQuote && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(function (t) { return t.trim(); }).filter(Boolean);
}

// A recipient the lock can vouch for: exactly one plain address. Anything it
// cannot read cleanly ("a@x b@y", "a@x; b@y", two <…> groups) is refused.
function cleanSingleAddress(token) {
  const t = String(token || '');
  if ((t.match(/</g) || []).length > 1 || (t.match(/>/g) || []).length > 1) return '';
  const addr = normaliseEmail(t);
  return /^[^\s@<>,;"]+@[^\s@<>,;"]+$/.test(addr) ? addr : '';
}

// Email recipients for a send that does not go through Resend (Gmail API).
// input: { to, cc, bcc } — each a header string or an array.
// Off a preview: { send: true, unchanged: true } and the caller sends what it
// was going to send. On a preview: only allow-listed addresses survive, and
// they are returned as BARE addresses (display names dropped, so a crafted
// name can never smuggle a second recipient). send is false when no "to"
// survives.
function filterEmailRecipients(lock, input) {
  const i = input || {};
  if (!lock || !lock.preview) {
    return { send: true, unchanged: true, to: i.to, cc: i.cc, bcc: i.bcc, allowed: [], blocked: [] };
  }
  const allowed = [];
  const blocked = [];
  const keep = function (value) {
    const kept = [];
    splitAddressList(value).forEach(function (token) {
      const addr = cleanSingleAddress(token);
      if (addr && lock.allowlist.permitsEmail(addr)) { kept.push(addr); allowed.push(addr); } else blocked.push(token);
    });
    return kept;
  };
  const to = keep(i.to);
  const cc = keep(i.cc);
  const bcc = keep(i.bcc);
  return {
    send: to.length > 0,
    unchanged: false,
    to: to.join(', '),
    cc: cc.join(', '),
    bcc: bcc.join(', '),
    allowed,
    blocked
  };
}

// Google Calendar event create. Google emails every attendee when
// sendUpdates=all. On a preview: unlisted attendees are dropped and, if any
// were dropped or no list is set, Google is told to notify nobody.
function calendarEventPlan(lock, attendees) {
  const list = (Array.isArray(attendees) ? attendees : []).filter(Boolean);
  if (!lock || !lock.preview) return { attendees: attendees, sendUpdates: 'all', dropped: [] };
  const kept = [];
  const dropped = [];
  list.forEach(function (a) {
    const addr = cleanSingleAddress(a);
    if (addr && lock.allowlist.permitsEmail(addr)) kept.push(a); else dropped.push(a);
  });
  return {
    attendees: kept,
    sendUpdates: (dropped.length || lock.mode !== 'allowlist') ? 'none' : 'all',
    dropped
  };
}

// Google Calendar event delete/update. The attendees on an existing event are
// not known here (the event may have been created by production with real
// people on it), so a preview never lets Google notify anyone.
function calendarChangeSendUpdates(lock) {
  return lock && lock.preview ? 'none' : 'all';
}

// Writes to a third-party ACCOUNT that are not messages (DoubleTick chat
// assignment, contact name/tags). Skipped on every preview.
function blocksAccountWrites(lock) {
  return !!(lock && lock.preview);
}

// Phone calls (Retell). On a preview only numbers in the caller's own test
// list (LEAD_CALLS_TEST_NUMBERS) may be rung; an empty test list rings nobody.
function permitsCallTo(lock, phone, testNumbers) {
  if (!lock || !lock.preview) return true;
  const want = phoneDigits(phone);
  if (!want) return false;
  return (Array.isArray(testNumbers) ? testNumbers : []).some(function (n) { return phoneDigits(n) === want; });
}

// Anything else that reaches one email address through a third party
// (a Calendly booking makes Calendly email the invitee).
function permitsEmailTo(lock, address) {
  if (!lock || !lock.preview) return true;
  const addr = cleanSingleAddress(address);
  return !!addr && lock.allowlist.permitsEmail(addr);
}

// Server-to-server reporting that must only ever come from production
// (Meta Conversions API events).
function blocksProductionOnlyReporting(lock) {
  return !!(lock && lock.preview);
}

// The startup log line. '' off a preview.
function describeSendLock(lock) {
  if (!lock || !lock.preview) return '';
  if (lock.mode === 'allowlist') {
    return 'preview send lock ACTIVE: ' + lock.allowlist.size + ' allow-listed recipients ('
      + lock.allowlist.describe() + '). Email, WhatsApp, Gmail and calendar invites reach only those; everyone else is skipped and logged.';
  }
  return 'preview send lock ACTIVE: blocking ALL outbound email/WhatsApp (NOTIFY_TEST_RECIPIENTS not set). '
    + 'Set NOTIFY_TEST_RECIPIENTS on the Vercel Preview environment to addresses/numbers you own to receive test messages.';
}

// Log-safe form of a recipient. "Dr Real <dr.real@clinic>" is reduced to its
// address first, so a display name is never printed either.
function maskForLog(value) {
  const s = String(value == null ? '' : value);
  return maskRecipient(s.indexOf('@') !== -1 ? normaliseEmail(s) : s);
}

module.exports = {
  isVercelPreview,
  resolveSendLock,
  previewSendLockMode,
  splitAddressList,
  filterEmailRecipients,
  calendarEventPlan,
  calendarChangeSendUpdates,
  blocksAccountWrites,
  permitsCallTo,
  permitsEmailTo,
  blocksProductionOnlyReporting,
  describeSendLock,
  mask: maskForLog
};

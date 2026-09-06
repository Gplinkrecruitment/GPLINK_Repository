'use strict';

// Test-recipient allowlist for outbound messages (owner 2026-09-07).
//
// Localhost runs against the PRODUCTION database with production sending
// keys, so any action that notifies a doctor or practice sends a real email
// or WhatsApp. When NOTIFY_TEST_RECIPIENTS is set (comma/space-separated
// emails and phone numbers), outbound email (Resend) and WhatsApp
// (DoubleTick) may only reach the listed recipients; everyone else is
// skipped and logged. Unset/empty = no restriction (production behaviour).
// Entries are comma-separated (semicolons/newlines also work); spaces INSIDE
// a phone number are fine, but spaces are not separators. Phones compare in
// E.164 after normalising an Australian local number (0400 000 000 / 400 000
// 000) to +61 — never by suffix, so a foreign number can never match.
//
// Pure module: no env reads, no I/O. server.js builds one instance from
// process.env.NOTIFY_TEST_RECIPIENTS and routes every message-sending fetch
// through guardedNotifyFetch(), which calls filterBody() below.

function normaliseEmail(value) {
  const s = String(value || '').trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

// Digits only, leading zeros dropped: "+61 406 281 243" and "0406281243"
// both compare on their significant digits.
const DEFAULT_COUNTRY_CODE = '61';
function phoneDigits(value) {
  const raw = String(value || '').trim();
  let d = raw.replace(/\D+/g, '');
  if (!d) return '';
  // "+61 4…" / "61 4…" stay as they are; a local form ("04…" / "4…", 9-10
  // digits) is an Australian number written without its country code.
  if (raw.charAt(0) !== '+' && !d.startsWith(DEFAULT_COUNTRY_CODE)) {
    const local = d.replace(/^0+/, '');
    if (local.length === 9) d = DEFAULT_COUNTRY_CODE + local;
  }
  return d.replace(/^0+/, '');
}

function phoneMatches(a, b) {
  return !!a && !!b && a === b;
}

function parseRecipients(raw) {
  const emails = new Set();
  const phones = new Set();
  const warnings = [];
  // Comma/semicolon/newline separated. Spaces are NOT separators, so a number
  // written as "+61 406 000 111" stays one entry.
  String(raw || '').split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean).forEach((token) => {
    if (token.indexOf('@') !== -1) {
      if (/\s/.test(token)) warnings.push('entry "' + token.slice(0, 40) + '" mixes an email with something else — separate entries with commas');
      emails.add(normaliseEmail(token));
    } else {
      const d = phoneDigits(token);
      if (d.length >= 6) phones.add(d);
    }
  });
  return { emails, phones, warnings };
}

// Never log a full address or number.
function maskRecipient(value) {
  const s = String(value || '');
  if (!s) return '(empty)';
  if (s.indexOf('@') !== -1) {
    const at = s.indexOf('@');
    return s.slice(0, Math.min(2, at)) + '…' + s.slice(at);
  }
  const d = s.replace(/\D+/g, '');
  if (!d) return s;
  return (s.trim().charAt(0) === '+' ? '+' : '') + d.slice(0, 2) + '…' + d.slice(-3);
}

function createNotifyAllowlist(raw) {
  const parsed = parseRecipients(raw);
  const emails = parsed.emails;
  const phones = parsed.phones;
  const warnings = parsed.warnings;
  const active = emails.size + phones.size > 0;

  function permitsEmail(addr) {
    if (!active) return true;
    return emails.has(normaliseEmail(addr));
  }

  function permitsPhone(phone) {
    if (!active) return true;
    const d = phoneDigits(phone);
    if (!d) return false;
    for (const p of phones) if (phoneMatches(p, d)) return true;
    return false;
  }

  // Rewrites a JSON request body so only permitted recipients remain.
  // Returns { body, allowed, blocked }: body is the (possibly reduced) JSON
  // string to send, or null when nobody permitted is left. Fails CLOSED: a
  // body whose recipients cannot be read is blocked, never sent blind.
  function filterBody(kind, bodyText) {
    const out = { body: null, allowed: [], blocked: [] };
    if (!active) { out.body = bodyText; return out; }
    let payload = null;
    try { payload = JSON.parse(String(bodyText || '')); } catch (e) { payload = null; }
    if (!payload || typeof payload !== 'object') { out.blocked.push('(unreadable request body)'); return out; }

    if (kind === 'email') {
      const keep = (list) => {
        const kept = [];
        [].concat(list || []).filter(Boolean).forEach((a) => {
          if (permitsEmail(a)) { kept.push(a); out.allowed.push(a); } else out.blocked.push(a);
        });
        return kept;
      };
      const to = keep(payload.to);
      const cc = keep(payload.cc);
      const bcc = keep(payload.bcc);
      if (!to.length) return out;
      const next = Object.assign({}, payload, { to });
      if (payload.cc !== undefined) next.cc = cc;
      if (payload.bcc !== undefined) next.bcc = bcc;
      out.body = JSON.stringify(next);
      return out;
    }

    // WhatsApp (DoubleTick): { to, body } for text, { messages: [{ to, … }] }
    // for templates.
    if (Array.isArray(payload.messages)) {
      const kept = payload.messages.filter((m) => {
        const to = m && (m.to || m.recipient || m.phone);
        if (to && permitsPhone(to)) { out.allowed.push(to); return true; }
        out.blocked.push(to || '(no recipient)');
        return false;
      });
      if (!kept.length) return out;
      out.body = JSON.stringify(Object.assign({}, payload, { messages: kept }));
      return out;
    }
    const to = payload.to || payload.phone || payload.recipient;
    if (to && permitsPhone(to)) { out.allowed.push(to); out.body = String(bodyText); return out; }
    out.blocked.push(to || '(no recipient)');
    return out;
  }

  function describe() {
    return active ? (emails.size + ' email address(es), ' + phones.size + ' phone number(s)') : 'inactive';
  }

  return { active, size: emails.size + phones.size, warnings, permitsEmail, permitsPhone, filterBody, describe, mask: maskRecipient };
}

module.exports = { createNotifyAllowlist, parseRecipients, normaliseEmail, phoneDigits, maskRecipient };

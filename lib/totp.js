'use strict';
// RFC 6238 TOTP (time-based one-time passwords), hand-rolled with node's
// built-in crypto — deliberately NO npm dependency (audit S1 / Phase 6 C1).
//
//   generateSecret()                  → random base32 secret (RFC 4648 alphabet)
//   totpUri({secret,label,issuer})    → otpauth:// URI for authenticator apps
//   generateTotp(secret, opts)        → current 6-digit code (used by tests/UI)
//   verifyTotp(secret, token, opts)   → boolean; 30s step, ±window steps,
//                                       HMAC-SHA1, 6 digits, constant-time compare
//
// Defaults match Google Authenticator / 1Password / Authy expectations:
// SHA1, 6 digits, 30-second period.

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 160-bit secret (SHA1 block-friendly, what most authenticator apps expect).
function generateSecret(byteLength = 20) {
  return base32Encode(crypto.randomBytes(byteLength));
}

function totpUri({ secret, label, issuer } = {}) {
  const enc = encodeURIComponent;
  const safeLabel = String(label || 'account');
  const safeIssuer = String(issuer || '');
  const qualified = safeIssuer ? `${safeIssuer}:${safeLabel}` : safeLabel;
  let uri = `otpauth://totp/${enc(qualified)}?secret=${enc(String(secret || ''))}&algorithm=SHA1&digits=6&period=30`;
  if (safeIssuer) uri += `&issuer=${enc(safeIssuer)}`;
  return uri;
}

// RFC 4226 HOTP dynamic truncation over an 8-byte big-endian counter.
function hotp(secretBuf, counter, digits) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return String(code % (10 ** digits)).padStart(digits, '0');
}

function generateTotp(secret, { time = Date.now(), step = 30, digits = 6 } = {}) {
  const counter = Math.floor(time / 1000 / step);
  return hotp(base32Decode(secret), counter, digits);
}

// Like verifyTotp, but returns WHICH timestep (HOTP counter) the token matched
// — or null when nothing matched. Callers use the counter to reject replays
// (never accept the same or an older step twice) while keeping the ±window
// tolerance for clock skew.
function matchTotpStep(secret, token, { window = 1, time = Date.now(), step = 30, digits = 6 } = {}) {
  const candidate = String(token || '').replace(/[\s-]/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return null;
  let secretBuf;
  try { secretBuf = base32Decode(secret); } catch (err) { return null; }
  if (!secretBuf.length) return null;
  const counter = Math.floor(time / 1000 / step);
  const candidateBuf = Buffer.from(candidate, 'utf8');
  let matchedCounter = null;
  // Check every window without early exit so timing does not reveal which
  // (if any) step matched. Codes are fixed-length so timingSafeEqual is safe.
  for (let w = -window; w <= window; w++) {
    const expected = Buffer.from(hotp(secretBuf, counter + w, digits), 'utf8');
    if (crypto.timingSafeEqual(expected, candidateBuf)) matchedCounter = counter + w;
  }
  return matchedCounter;
}

function verifyTotp(secret, token, opts = {}) {
  return matchTotpStep(secret, token, opts) !== null;
}

module.exports = { generateSecret, totpUri, generateTotp, verifyTotp, matchTotpStep, base32Encode, base32Decode };

'use strict';
const SIX_MONTHS_MS = 182 * 24 * 60 * 60 * 1000;   // ~6 months
const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;
function identityRetentionDue({ placedAtMs, lastActiveMs, nowMs }) {
  if (placedAtMs && (nowMs - placedAtMs) >= SIX_MONTHS_MS) return { due: true, reason: 'placement' };
  if (lastActiveMs && (nowMs - lastActiveMs) >= TWELVE_MONTHS_MS) return { due: true, reason: 'inactivity' };
  return { due: false, reason: null };
}
module.exports = { identityRetentionDue, SIX_MONTHS_MS, TWELVE_MONTHS_MS };

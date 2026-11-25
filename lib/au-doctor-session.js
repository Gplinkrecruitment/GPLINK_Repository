'use strict';

/**
 * Australian GP build, fix bundle FB-1 (walk-findings D9, D10, D13).
 *
 * What an Australian doctor's own browser is told about itself on
 * GET /api/auth/session, under the key `auDoctor`. Pure: no database, no
 * switch read. Only ever built for a doctor on an Australian pathway; an
 * overseas doctor's session has no such key.
 *
 *   auDoctor: {
 *     eligibilityVersion: 'a1b2c3d4e5f60718',   // opaque
 *     limits: { active: 4, monthly: 6, interviewsMonthly: 6 },
 *     onboardingComplete: true
 *   }
 *
 * eligibilityVersion (D9). The careers page keeps the role list in the
 * browser for several minutes. The list depends on things staff change (the
 * Ahpra check, the pathway, the 19AB confirmation) and nothing in the browser
 * knows when they do. The version is a fingerprint of everything that decides
 * which roles this doctor may see. The page stores the version next to its
 * saved role list and throws the saved list away when the version differs.
 *
 * It is an HMAC keyed with the server secret, NOT a plain hash: the inputs
 * are a handful of low-entropy facts (including the DPA flag, which the
 * browser must never learn), so a plain hash could be reversed by trying
 * every combination. With the key it tells the browser only "something
 * changed". The doctor's id is mixed in so two doctors sharing a device never
 * share a version.
 *
 * limits (D10). The doctor's own application caps, so every number a screen
 * shows comes from one place (lib/application-caps.js) rather than from
 * wording written for the overseas caps.
 *
 * onboardingComplete (D13). False until the doctor has finished onboarding;
 * the careers page sends such a doctor back to onboarding.
 */

const crypto = require('crypto');

const VERSION_LENGTH = 16;

function isAuResult(p) {
  return !!(p && typeof p === 'object' && p.isAu === true && p.readFailed !== true && p.schemaMissing !== true);
}

function cleanLimits(caps) {
  const c = caps && typeof caps === 'object' ? caps : {};
  const n = function (v) { return Number.isInteger(v) && v > 0 ? v : null; };
  return { active: n(c.active), monthly: n(c.monthly), interviewsMonthly: n(c.interviewsMonthly) };
}

/**
 * The fingerprint. Changes whenever anything that decides role visibility,
 * the hold, or the caps changes. Returns '' when it cannot be made (no
 * secret, not an Australian result): the page treats '' as "unknown" and
 * reads the list from the network.
 */
function eligibilityVersion(input) {
  const i = input || {};
  const p = i.pathwayResult;
  const secret = String(i.secret || '');
  if (!secret || !isAuResult(p)) return '';
  const fit = p.roleFit && typeof p.roleFit === 'object' ? p.roleFit : {};
  const limits = cleanLimits(i.caps);
  const facts = [
    'v1',
    String(i.userKey || ''),
    String(p.pathway || ''),
    p.launched === true ? 1 : 0,
    // Anything but a definite `false` is restricted (fail closed), so the
    // three states collapse to two here exactly as the role rule reads them.
    p.dpaRestricted === false ? 0 : 1,
    p.confirmed === true ? 1 : 0,
    p.needsStaffReview === true ? 1 : 0,
    fit.vr === true ? 1 : 0,
    fit.registrar === true ? 1 : 0,
    fit.supervised === true ? 1 : 0,
    p.hasRegistrationFlags === true ? 1 : 0,
    p.flagsReviewed === true ? 1 : 0,
    limits.active, limits.monthly, limits.interviewsMonthly,
    // WP-29: the hold itself (segment B is no longer held just for being
    // restricted), its kind, and the sponsorship need.
    p.selfServiceHeld === true ? 1 : 0,
    String(p.holdKind || ''),
    fit.sponsorship === true ? 1 : 0
  ];
  return crypto.createHmac('sha256', secret).update(JSON.stringify(facts)).digest('hex').slice(0, VERSION_LENGTH);
}

/**
 * The whole `auDoctor` block, or null for anyone who is not clearly on an
 * Australian pathway (overseas, nothing recorded, unreadable, switch off).
 */
function buildAuDoctorSessionBlock(input) {
  const i = input || {};
  if (!isAuResult(i.pathwayResult)) return null;
  // WP-29: whether the doctor is held, and which message they are shown. The
  // one decision is candidatePathway.selfServiceHold (on the resolver result);
  // `i.hold` is roleEligibility.holdViewFor(pathwayResult), built by the caller.
  const hold = i.hold && typeof i.hold === 'object' && i.hold.held === true
    ? { kind: i.hold.kind === 'registrar' ? 'registrar' : 'review', title: String(i.hold.title || ''), message: String(i.hold.message || '') }
    : null;
  return {
    eligibilityVersion: eligibilityVersion(i),
    limits: cleanLimits(i.caps),
    onboardingComplete: i.onboardingComplete === true,
    held: !!hold,
    hold
  };
}

module.exports = { VERSION_LENGTH, eligibilityVersion, buildAuDoctorSessionBlock };

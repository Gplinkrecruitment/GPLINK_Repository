'use strict';

/**
 * Application caps, per pathway. WP-08 of the Australian GP build (DAT-23,
 * owner decision 8). Pure: no database, no switch read.
 *
 * One object holds every number:
 *
 *   active              how many live applications a doctor may hold at once
 *   monthly             how many applications they may start in a calendar month
 *   interviewsMonthly   how many interviews they may book in a calendar month
 *   strikeLock          how many strikes pause the careers page (the
 *                       "three-strike lock")
 *
 * Overseas doctors (overseas_esp, overseas_pep, nothing recorded, switch off):
 * the numbers the product has always used, 2 / 3 / 3 / 3. They are constants
 * here and CANNOT be changed by an environment variable, so turning the
 * Australian switch on can never move an overseas doctor's limits.
 *
 * Australian doctors: 4 / 6 / 6, and the same three-strike lock. The lock is
 * kept as it is on purpose: it counts interviews that went nowhere and late
 * withdrawals, which waste a practice's time just as much when the doctor
 * lives down the road, and nothing in the owner's decision asked for it to
 * change. It is in the object so it can be changed without code.
 *
 * Overriding the Australian numbers (optional, read at call time):
 *
 *   AU_APPLICATION_CAPS_JSON   a JSON object. Top-level keys set every
 *                              Australian pathway; a key named after a pathway
 *                              sets just that one.
 *       {"active":5}                              all four Australian pathways
 *       {"au_vr":{"active":5,"monthly":8}}        segment A only
 *       {"monthly":8,"au_restricted":{"active":2}} both
 *
 * A value that is not a whole number from 1 to 50 is ignored (the default
 * stays), and so is JSON that does not parse: a typo can never remove a cap.
 */

const OVERSEAS_CAPS = Object.freeze({ active: 2, monthly: 3, interviewsMonthly: 3, strikeLock: 3 });
const AU_DEFAULT_CAPS = Object.freeze({ active: 4, monthly: 6, interviewsMonthly: 6, strikeLock: 3 });
const CAP_KEYS = Object.freeze(['active', 'monthly', 'interviewsMonthly', 'strikeLock']);
const AU_PATHWAY_KEYS = Object.freeze(['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar']);
const ENV_NAME = 'AU_APPLICATION_CAPS_JSON';

function validCap(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 50;
}

function applyOverrides(base, source) {
  const out = Object.assign({}, base);
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
  CAP_KEYS.forEach(function (k) { if (validCap(source[k])) out[k] = source[k]; });
  return out;
}

function parseOverrides(env) {
  const e = env || process.env;
  const raw = String(e[ENV_NAME] == null ? '' : e[ENV_NAME]).trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    return null;
  }
}

/**
 * The whole config: `{ overseas, au_vr, au_restricted, au_non_vr, au_registrar }`.
 * @param {object} [env] defaults to process.env (read at call time)
 */
function applicationCapsConfig(env) {
  const overrides = parseOverrides(env);
  const config = { overseas: Object.assign({}, OVERSEAS_CAPS) };
  AU_PATHWAY_KEYS.forEach(function (p) {
    let caps = applyOverrides(AU_DEFAULT_CAPS, overrides);
    if (overrides && overrides[p]) caps = applyOverrides(caps, overrides[p]);
    config[p] = caps;
  });
  return config;
}

/**
 * The caps for one doctor.
 * @param {object|null} pathwayResult a resolveCandidatePathway result. Anything
 *        that is not clearly an Australian pathway (null, overseas, switch off,
 *        unreadable) gets the overseas numbers: the tighter set.
 * @param {object} [env]
 * @returns {{ active: number, monthly: number, interviewsMonthly: number, strikeLock: number, basis: 'overseas'|'au', pathway: string }}
 */
function capsForPathway(pathwayResult, env) {
  const p = pathwayResult && typeof pathwayResult === 'object' ? pathwayResult : null;
  const isAu = !!(p && p.isAu === true && p.readFailed !== true && p.schemaMissing !== true
    && AU_PATHWAY_KEYS.indexOf(String(p.pathway)) !== -1);
  if (!isAu) return Object.assign({ basis: 'overseas', pathway: (p && p.pathway) || 'overseas_esp' }, OVERSEAS_CAPS);
  return Object.assign({ basis: 'au', pathway: p.pathway }, applicationCapsConfig(env)[p.pathway]);
}

/** True when every pathway shares one strike-lock threshold (the default). */
function strikeLockIsUniform(env) {
  const config = applicationCapsConfig(env);
  return AU_PATHWAY_KEYS.every(function (p) { return config[p].strikeLock === OVERSEAS_CAPS.strikeLock; });
}

/** The smallest strike-lock threshold any pathway uses (a cheap pre-filter). */
function minStrikeLock(env) {
  const config = applicationCapsConfig(env);
  return AU_PATHWAY_KEYS.reduce(function (m, p) { return Math.min(m, config[p].strikeLock); }, OVERSEAS_CAPS.strikeLock);
}

// The wording a doctor sees. With the overseas number (2) these are, character
// for character, the sentences the product has always used.
function activeCapMessage(limit, context) {
  const tail = context === 'match'
    ? 'To accept this match, withdraw one of your current applications first.'
    : 'To apply for this position, withdraw one of your current applications first.';
  return 'You already have ' + limit + ' live applications. ' + tail;
}
function monthlyCapMessage(limit, resetsLabel) {
  return 'You have applied for ' + limit + ' positions this month, which is the monthly limit. Your limit resets on ' + resetsLabel + '.';
}

module.exports = {
  OVERSEAS_CAPS,
  AU_DEFAULT_CAPS,
  CAP_KEYS,
  ENV_NAME,
  applicationCapsConfig,
  capsForPathway,
  strikeLockIsUniform,
  minStrikeLock,
  activeCapMessage,
  monthlyCapMessage
};

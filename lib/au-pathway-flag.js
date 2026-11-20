'use strict';

/**
 * The ONE switch for everything Australian-GP.
 *
 * Every piece of Australian-pathway behaviour (onboarding branch, stage ladder,
 * placement branch, messages, dashboards, site pages) must ask this function
 * and nothing else. With the switch OFF the product must behave exactly as it
 * did before the Australian build: every doctor is an overseas doctor.
 *
 * Resolution order:
 *   1. AU_PATHWAY_ENABLED set explicitly  -> that value wins, everywhere.
 *        on:  "true", "1", "on", "yes"
 *        off: "false", "0", "off", "no"
 *   2. On Vercel (VERCEL_ENV is set)      -> ON for preview/development
 *                                            deployments, OFF for production.
 *      (Vercel sets NODE_ENV=production on previews too, so NODE_ENV cannot be
 *      used to tell a preview from the live site.)
 *   3. Anywhere else (localhost, tests)   -> ON unless NODE_ENV=production.
 *
 * Read at call time, never cached, so a test can flip process.env between
 * cases and so one warm serverless instance never pins a stale answer.
 *
 * @param {object} [env] defaults to process.env (injectable for tests)
 * @returns {boolean}
 */
function isAuPathwayEnabled(env) {
  const e = env || process.env;
  const raw = String(e.AU_PATHWAY_ENABLED == null ? '' : e.AU_PATHWAY_ENABLED).trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  // Unset, or set to something unreadable: fall through to the environment
  // default. An unreadable value in production therefore stays OFF.
  const vercelEnv = String(e.VERCEL_ENV || '').trim().toLowerCase();
  if (vercelEnv) return vercelEnv !== 'production';
  return String(e.NODE_ENV || '').trim().toLowerCase() !== 'production';
}

module.exports = { isAuPathwayEnabled };

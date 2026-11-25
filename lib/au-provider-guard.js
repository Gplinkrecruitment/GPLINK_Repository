'use strict';

/**
 * Australian GP build, FR-9 (S9-14): the `fixture` providers answer from
 * made-up data. They exist for the local test stack and the test suite, and
 * must never be what a production deployment answers from, however the
 * setting got there. One rule, used by both look-ups
 * (lib/au-workforce-locator.js and lib/ahpra-register-lookup.js).
 *
 * Production = NODE_ENV=production or VERCEL_ENV=production. (Every Vercel
 * build runs with NODE_ENV=production, Preview included, so on Vercel a
 * fixture provider is refused everywhere. That is intended: Preview reads the
 * real database.)
 */
function isProduction(env) {
  const e = env || process.env;
  const is = function (v) { return String(v == null ? '' : v).trim().toLowerCase() === 'production'; };
  return is(e.NODE_ENV) || is(e.VERCEL_ENV);
}

/** May a `fixture` provider be used in this environment? */
function fixtureAllowed(env) { return !isProduction(env); }

const warned = {};
/**
 * The provider to really use: `fixture` falls back to `none` in production,
 * with ONE log line per setting per process.
 * @param {string} name     the provider the setting asked for (already validated)
 * @param {string} setting  the environment variable's name (for the log line)
 * @param {object} [env]
 */
function guardProvider(name, setting, env) {
  if (name !== 'fixture' || fixtureAllowed(env)) return name;
  if (!warned[setting]) {
    warned[setting] = true;
    console.warn('[au-provider-guard] ' + setting + '=fixture is refused in production: treated as none (made-up test data is never used for real doctors or practices).');
  }
  return 'none';
}
function _resetForTests() { Object.keys(warned).forEach(function (k) { delete warned[k]; }); }

module.exports = { isProduction, fixtureAllowed, guardProvider, _resetForTests };

'use strict';

/*
 * Which Recruitment Services Agreement a given practice signs.
 *
 * Until now there was exactly one: assets/legal/gp-link-practice-agreement-2026.pdf,
 * hard-coded in both the intake page's iframe and the server-side stamper. A
 * negotiated rate therefore could not be e-signed at all — the practice would sign
 * the standard $25,000 schedule no matter what had been agreed over email.
 *
 * A practice now carries `metadata.agreement_variant`. Anything unrecognised (or
 * absent) resolves to the standard agreement, so a typo can never quietly hand a
 * practice a discounted contract — the failure direction is "charge full price".
 *
 * Adding a variant: build its PDF with scripts/build-practice-agreement-pdf.sh
 * (it takes a source name), drop it in assets/legal/, and add a row here.
 */

var VARIANTS = {
  standard: {
    key: 'standard',
    label: 'Standard 2026 rates',
    file: 'assets/legal/gp-link-practice-agreement-2026.pdf',
    source: 'assets/legal/src/agreement-2026.html'
  },
  'discounted-2026': {
    key: 'discounted-2026',
    label: 'Discounted 2026 rates',
    // Overseas FT $20,000 · AU FT $19,000 · overseas PT $18,000 · AU PT $17,000,
    // each shown against the struck-through standard fee.
    file: 'assets/legal/gp-link-practice-agreement-2026-discounted.pdf',
    source: 'assets/legal/src/agreement-2026-discounted.html'
  }
};

var DEFAULT_VARIANT = 'standard';

function listAgreementVariants() {
  return Object.keys(VARIANTS).map(function (k) {
    return { key: k, label: VARIANTS[k].label };
  });
}

function isAgreementVariant(key) {
  return Object.prototype.hasOwnProperty.call(VARIANTS, String(key || ''));
}

/** The variant record for a key — always a real record; unknown keys fall back. */
function getAgreementVariant(key) {
  var k = String(key || '').trim();
  return VARIANTS[k] || VARIANTS[DEFAULT_VARIANT];
}

/**
 * The variant a practice row signs. Reads metadata.agreement_variant, which is
 * where the sign-link endpoint writes it (practices has no dedicated column).
 */
function resolveAgreementVariant(practice) {
  var meta = (practice && practice.metadata) || {};
  return getAgreementVariant(meta.agreement_variant);
}

/**
 * True when this practice is on a sign-only link: no intake form, straight to the
 * agreement. The sign endpoint waives its intake requirement for these, and no
 * pending job is created (there are no job details to create one from).
 */
function isSignOnlyPractice(practice) {
  var meta = (practice && practice.metadata) || {};
  return meta.sign_only === true;
}

module.exports = {
  VARIANTS,
  DEFAULT_VARIANT,
  listAgreementVariants,
  isAgreementVariant,
  getAgreementVariant,
  resolveAgreementVariant,
  isSignOnlyPractice
};

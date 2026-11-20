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

/*
 * DRAFT variants (WP-28). NOT selectable, NOT sendable, NOT signable.
 *
 * These are kept in a SEPARATE map on purpose. Everything that offers, validates,
 * serves or stamps an agreement goes through VARIANTS above:
 *   - the sign-link endpoint validates with isAgreementVariant()  -> false for a draft
 *   - the intake page, the token-gated PDF endpoint and the signing endpoint all
 *     resolve with resolveAgreementVariant() / getAgreementVariant()
 *                                                                -> standard for a draft
 *   - listAgreementVariants() and the exported VARIANTS never contain a draft
 * So a draft key that somehow reached a practice row (hand-edited metadata, a
 * crafted request) behaves exactly like any other unknown key: the request to
 * mint a link is refused, and anything already stored falls back to the standard
 * agreement. The failure direction stays "charge full price".
 *
 * A draft has no built PDF (`file: null`) and its source lives OUTSIDE assets/,
 * because server.js serves everything under assets/ publicly.
 *
 * The only way to see a draft is through the explicit accessors below
 * (listDraftAgreementVariants / getDraftAgreementVariant). Nothing in server.js
 * calls them. Do not add a draft to VARIANTS until a lawyer has reviewed it:
 * docs/au-gp/agreement-au-variant-legal-review.md says what flipping it involves.
 */
var DRAFT_VARIANTS = {
  'au-2026-draft': {
    key: 'au-2026-draft',
    label: 'DRAFT - Australian GP presentation (for legal review, not for signature)',
    draft: true,
    selectable: false,
    // Same fees as `standard` (decision 3): based in Australia FT $21,000 / PT $18,000,
    // invoiced in full on commencement (decision 4). Pages 4 to 16 carry the standard
    // wording unchanged; only the cover and introductory pages differ.
    file: null,
    source: 'docs/au-gp/legal-draft/agreement-2026-au-draft.html',
    basedOn: 'standard',
    legalReview: 'docs/au-gp/agreement-au-variant-legal-review.md'
  }
};

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

/** Draft variants, for documentation and tests only. Never feed this to a picker. */
function listDraftAgreementVariants() {
  return Object.keys(DRAFT_VARIANTS).map(function (k) {
    return Object.assign({}, DRAFT_VARIANTS[k]);
  });
}

function isDraftAgreementVariant(key) {
  return Object.prototype.hasOwnProperty.call(DRAFT_VARIANTS, String(key || '').trim());
}

/** A copy of one draft record, or null. Never falls back to a real agreement. */
function getDraftAgreementVariant(key) {
  var k = String(key || '').trim();
  return isDraftAgreementVariant(k) ? Object.assign({}, DRAFT_VARIANTS[k]) : null;
}

module.exports = {
  // DRAFT_VARIANTS itself is deliberately not exported: only copies leave this module.
  listDraftAgreementVariants,
  isDraftAgreementVariant,
  getDraftAgreementVariant,
  VARIANTS,
  DEFAULT_VARIANT,
  listAgreementVariants,
  isAgreementVariant,
  getAgreementVariant,
  resolveAgreementVariant,
  isSignOnlyPractice
};

// Which document set does a doctor's file belong to? ONE place answers it.
//
// Australian GP build, WP-07 (findings DAT-07, ADM-08, APP-23, APP-24, DAT-21).
//
// Before this file at least thirty places in server.js each wrote their own
// `|| 'uk'` / `|| 'GB'`, so a doctor whose country the server could not read
// was silently treated as a UK doctor. That is how an Australian GP came to be
// asked for a GMC certificate and shown to staff as "GB 0/3 docs".
//
// The rules now:
//
//   1. A doctor on an Australian pathway (the switch on, pathway resolved by
//      resolveCandidatePathway) belongs to the Australian set, code `au_reg`.
//      Their country field is not consulted at all.
//   2. Any other doctor is an overseas doctor and gets EXACTLY what they got
//      before this file existed: uk / ie / nz when their country says so, and
//      the LEGACY fallback to `uk` when it does not. The fallback is kept only
//      so nothing an existing overseas doctor sees changes (parity is the
//      rule of the build); it is flagged on the result (`legacyFallback: true`,
//      `supported: false`) and lives in this one function, so removing it is a
//      one-line change once the owner decides to.
//   3. Callers that want the strict answer ("unknown means unsupported, show
//      nothing") pass `{ strict: true }` and get `{ code: '', set: null }`.
//      New code must use strict. lib/document-requirements.js has always been
//      strict (`getDocumentRequirements('fr')` is null) and stays that way.
//
// Pure: no I/O, no switch read. The pathway result passed in already honours
// the switch (switch off = every doctor is overseas).
//
// ── user_documents.country_code: every meaning in use (DAT-21) ──────────────
// The column is part of the table's unique key (user_id, document_key,
// country_code), so two features using the same code for different things
// would overwrite each other's rows. The values, found by reading every writer:
//
//   'uk' | 'ie' | 'nz'  overseas registration documents: the doctor's
//                       "You prepare" uploads, the onboarding qualification
//                       scans (onboarding_*), institution rows, AHPRA s80
//                       uploads. Lower case. (normalizeDocumentCountry)
//   'AU'                careers-profile documents: career_cv,
//                       career_cover_letter and the legacy account CV
//                       (cv_signed_dated). Upper case. NOT "an Australian
//                       doctor": every doctor's careers CV is stored here.
//                       (ACCOUNT_CAREER_DOCUMENT_COUNTRY)
//   'zz'                the onboarding identity document (key `identity`),
//                       filed country-agnostically. (saveIdentityDocumentForUser)
//   'GB' | 'IE' | 'NZ'  legacy upper-case rows written by the review-flagged-
//                       doc decision before 2026-07; still read, never written
//                       by new code.
//   '' / null           rows delivered by GP Link staff with no country
//                       (offer_contract via deliverToMyDocuments, alternate
//                       supervisor CV placeholders).
//   'au_reg'            NEW (WP-07): an Australian GP's registration and
//                       pre-start documents. Every key under it starts `au_`.
//
// `au_reg` cannot collide with any of the above: it differs from 'AU' and 'au'
// in every casing, it is not a value normalizeDocumentCountry produces, and
// the keys filed under it (au_*) are used nowhere else.

'use strict';

const AU_DOCUMENT_COUNTRY = 'au_reg';
const CAREERS_DOCUMENT_COUNTRY = 'AU';
const IDENTITY_DOCUMENT_COUNTRY = 'zz';
const OVERSEAS_DOCUMENT_COUNTRIES = ['uk', 'ie', 'nz'];
// The one place the legacy default lives. See rule 2 above.
const LEGACY_OVERSEAS_FALLBACK = 'uk';

const UPPER_CODES = { uk: 'GB', ie: 'IE', nz: 'NZ' };

const COUNTRY_CODE_SCHEME = Object.freeze([
  { code: 'uk', meaning: 'Overseas registration documents, UK set' },
  { code: 'ie', meaning: 'Overseas registration documents, Ireland set' },
  { code: 'nz', meaning: 'Overseas registration documents, New Zealand set' },
  { code: 'AU', meaning: 'Careers-profile documents for every doctor (career_cv, career_cover_letter, legacy cv_signed_dated)' },
  { code: 'zz', meaning: 'Onboarding identity document (key identity)' },
  { code: 'au_reg', meaning: 'Australian GP registration and pre-start documents (keys au_*)' }
]);

// State values can arrive double-stringified ("\"United Kingdom\"").
function unwrap(value) {
  if (value == null) return '';
  let raw = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed && (trimmed[0] === '"' || trimmed[0] === '{' || trimmed[0] === '[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'string') raw = parsed;
      } catch (e) { /* not JSON-wrapped: use the raw value */ }
    }
  }
  return typeof raw === 'string' ? raw.trim() : '';
}

// uk / ie / nz for a value that names one of them, '' for anything else.
// Deliberately identical to normalizeDocumentCountry in server.js and
// normalizeRequirementCountry in lib/document-requirements.js. Never 'uk' for
// an unknown value, and never 'au_reg' (a country field cannot put a doctor in
// the Australian set; only the pathway can).
function normalizeOverseasCountry(value) {
  const raw = unwrap(value).toLowerCase();
  if (!raw) return '';
  if (raw === 'uk' || raw === 'gb' || raw === 'united kingdom') return 'uk';
  if (raw === 'ie' || raw === 'ireland') return 'ie';
  if (raw === 'nz' || raw === 'new zealand') return 'nz';
  return '';
}

function candidatesOf(profile) {
  if (profile == null) return [];
  if (typeof profile === 'string') return [profile];
  if (Array.isArray(profile)) return profile;
  if (typeof profile !== 'object') return [];
  if (Array.isArray(profile.candidates)) return profile.candidates;
  // Today's precedence everywhere: the profile's registration country, then
  // the country the doctor picked in the app.
  return [
    profile.registration_country,
    profile.registrationCountry,
    profile.gp_selected_country,
    profile.selectedCountry,
    profile.country
  ];
}

function isAuPathwayResult(pathwayResult) {
  return !!(pathwayResult && typeof pathwayResult === 'object' && pathwayResult.isAu === true
    && pathwayResult.flagEnabled !== false);
}

/**
 * @param profile        a country string, a list of candidates in precedence
 *                       order, `{ candidates: [...] }`, or a row / state-like
 *                       object (`registration_country`, `gp_selected_country`).
 * @param pathwayResult  what resolveCandidatePathway returned, or null when the
 *                       caller is not pathway-aware (it is then an overseas
 *                       answer by definition).
 * @param opts.strict    true: an unknown overseas country is unsupported
 *                       (`code: ''`, `set: null`) instead of the legacy `uk`.
 * @returns { code, set, supported, isAu, legacyFallback, upper }
 *   code   the user_documents.country_code bucket ('' when unsupported)
 *   set    the requirement-set key, or null when there is none
 */
function resolveDocumentCountry(profile, pathwayResult, opts) {
  if (isAuPathwayResult(pathwayResult)) {
    return {
      code: AU_DOCUMENT_COUNTRY, set: AU_DOCUMENT_COUNTRY, supported: true,
      isAu: true, legacyFallback: false, upper: 'AU'
    };
  }
  const list = candidatesOf(profile);
  // Today's behaviour, kept exactly: the FIRST truthy candidate decides
  // (`registration_country || gp_selected_country`). A later candidate is not
  // consulted when the first one is present but unrecognised.
  let first = '';
  for (let i = 0; i < list.length; i++) {
    if (list[i]) { first = list[i]; break; }
  }
  const norm = normalizeOverseasCountry(first);
  if (norm) {
    return { code: norm, set: norm, supported: true, isAu: false, legacyFallback: false, upper: UPPER_CODES[norm] };
  }
  if (opts && opts.strict) {
    return { code: '', set: null, supported: false, isAu: false, legacyFallback: false, upper: '' };
  }
  return {
    code: LEGACY_OVERSEAS_FALLBACK, set: LEGACY_OVERSEAS_FALLBACK, supported: false,
    isAu: false, legacyFallback: true, upper: UPPER_CODES[LEGACY_OVERSEAS_FALLBACK]
  };
}

// Shorthand for the many overseas-only call sites that used to write
// `normalizeDocumentCountry(x) || 'uk'`. Same answer, one home for the default.
function legacyOverseasCode() {
  return resolveDocumentCountry({ candidates: Array.prototype.slice.call(arguments) }, null).code;
}

// The upper-case form some staff views key on ('GB' | 'IE' | 'NZ'), with the
// same legacy default.
function legacyOverseasUpper() {
  return resolveDocumentCountry({ candidates: Array.prototype.slice.call(arguments) }, null).upper;
}

function upperCountryCode(code) {
  const c = String(code || '').trim().toLowerCase();
  if (c === AU_DOCUMENT_COUNTRY) return 'AU';
  return UPPER_CODES[c] || '';
}

function isAuDocumentCountry(code) {
  return String(code == null ? '' : code) === AU_DOCUMENT_COUNTRY;
}

module.exports = {
  AU_DOCUMENT_COUNTRY,
  CAREERS_DOCUMENT_COUNTRY,
  IDENTITY_DOCUMENT_COUNTRY,
  OVERSEAS_DOCUMENT_COUNTRIES,
  LEGACY_OVERSEAS_FALLBACK,
  COUNTRY_CODE_SCHEME,
  normalizeOverseasCountry,
  resolveDocumentCountry,
  legacyOverseasCode,
  legacyOverseasUpper,
  upperCountryCode,
  isAuDocumentCountry
};

'use strict';
// Medical-register verification details (owner decision 2026-08-31): instead
// of uploading qualification documents during onboarding, a doctor gives
// their public medical-register number and staff verify it against the LIVE
// public register with a one-click check. The register websites themselves
// are the up-to-date source — nothing is mirrored locally. Automated lookups
// were investigated and rejected for now: gmc-uk.org 403s non-browser
// traffic outright (TLS/bot fingerprinting), so a scripted check would be
// fragile where a 20-second staff click is dependable at current volume.
// Pure module — no I/O — so it is unit-testable.

var REGISTER_BODIES = {
  gmc: {
    label: 'GMC',
    name: 'General Medical Council (UK)',
    countries: ['uk', 'gb', 'united kingdom', 'great britain'],
    // GMC reference numbers are exactly 7 digits.
    numberPattern: /^\d{7}$/,
    numberHint: 'Your 7-digit GMC reference number',
    searchUrl: 'https://www.gmc-uk.org/registrants/register'
  },
  imc: {
    label: 'IMC',
    name: 'Medical Council of Ireland',
    countries: ['ie', 'ireland'],
    numberPattern: /^\d{4,6}$/,
    numberHint: 'Your Medical Council registration number',
    searchUrl: 'https://www.medicalcouncil.ie/public-information/check-the-register/'
  },
  mcnz: {
    label: 'MCNZ',
    name: 'Medical Council of New Zealand',
    countries: ['nz', 'new zealand'],
    numberPattern: /^\d{4,6}$/,
    numberHint: 'Your MCNZ registration number',
    searchUrl: 'https://www.mcnz.org.nz/registration/register-of-doctors/'
  },
  ahpra: {
    label: 'Ahpra',
    name: 'Australian Health Practitioner Regulation Agency',
    countries: ['au', 'australia'],
    // e.g. MED0001234567 — MED + 10 digits.
    numberPattern: /^MED\d{10}$/i,
    numberHint: 'Your Ahpra registration number (MED…)',
    searchUrl: 'https://www.ahpra.gov.au/Registration/Registers-of-Practitioners.aspx'
  }
};

var REGISTER_STATUSES = ['pending_verification', 'verified', 'mismatch'];

// The certificates onboarding used to collect, now DEFERRED to the MyIntealth
// gateway. Keys are the CANONICAL user_documents storage keys the wizard's
// uploads write (getOnboardingDocumentStorageKey maps its per-country wizard
// keys — mrcgp_cert / micgp_cert / frnzcgp_cert → specialist qualification,
// and so on). Labels are per-country because the specialist qualification is
// a different piece of paper in each. Kept in sync with COUNTRY_DOCS in
// js/onboarding.js by tests/register-onboarding-sync.test.js.
var DEFERRED_QUAL_DOCS = {
  GB: [
    { key: 'onboarding_specialist_qualification', label: 'MRCGP Certificate' },
    { key: 'onboarding_cct_certificate', label: 'CCT Certificate' },
    { key: 'onboarding_primary_med_degree', label: 'Primary Medical Degree' }
  ],
  IE: [
    { key: 'onboarding_specialist_qualification', label: 'MICGP Certificate' },
    { key: 'onboarding_primary_med_degree', label: 'Primary Medical Degree' }
  ],
  NZ: [
    { key: 'onboarding_specialist_qualification', label: 'FRNZCGP Certificate' },
    { key: 'onboarding_primary_med_degree', label: 'Primary Medical Degree' }
  ]
};

// Wizard picker code (GB/IE/NZ) from however the profile spells the country.
function qualCountryCode(country) {
  var k = String(country || '').trim().toLowerCase();
  if (k === 'gb' || k === 'uk' || k === 'united kingdom' || k === 'great britain') return 'GB';
  if (k === 'ie' || k === 'ireland') return 'IE';
  if (k === 'nz' || k === 'new zealand') return 'NZ';
  return '';
}

function registerBodyForCountry(country) {
  var k = String(country || '').trim().toLowerCase();
  if (!k) return '';
  var keys = Object.keys(REGISTER_BODIES);
  for (var i = 0; i < keys.length; i++) {
    if (REGISTER_BODIES[keys[i]].countries.indexOf(k) !== -1) return keys[i];
  }
  return '';
}

function normalizeRegisterNumber(body, value) {
  var s = String(value == null ? '' : value).replace(/[\s-]+/g, '').toUpperCase();
  if (body === 'ahpra') return s;
  return s.replace(/[^0-9]/g, '');
}

// Returns { ok, body, number, message } — never throws. An unknown body or a
// number that can't match the register's format is refused with a plain-words
// message the wizard can show inline.
function validateRegisterDetails(body, number) {
  var b = String(body || '').trim().toLowerCase();
  var meta = REGISTER_BODIES[b];
  if (!meta) return { ok: false, message: 'Choose which medical register you are on.' };
  var n = normalizeRegisterNumber(b, number);
  if (!n) return { ok: false, message: 'Enter your ' + meta.label + ' registration number.' };
  if (!meta.numberPattern.test(n)) {
    return { ok: false, message: 'That does not look like a valid ' + meta.label + ' number. ' + meta.numberHint + '.' };
  }
  return { ok: true, body: b, number: n };
}

function registerBodyMeta(body) {
  return REGISTER_BODIES[String(body || '').trim().toLowerCase()] || null;
}

module.exports = {
  REGISTER_BODIES,
  REGISTER_STATUSES,
  DEFERRED_QUAL_DOCS,
  qualCountryCode,
  registerBodyForCountry,
  normalizeRegisterNumber,
  validateRegisterDetails,
  registerBodyMeta
};

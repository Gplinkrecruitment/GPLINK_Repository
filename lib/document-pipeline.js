'use strict';

const CONFIDENCE_AUTO_APPROVE = 70;
const CONFIDENCE_VA_REVIEW = 40;

function classifyConfidenceAction(confidence) {
  if (confidence === null || confidence === undefined) return 'va_review';
  const n = Number(confidence);
  if (!Number.isFinite(n)) return 'va_review';
  if (n >= CONFIDENCE_AUTO_APPROVE) return 'auto_approve';
  if (n >= CONFIDENCE_VA_REVIEW) return 'va_review';
  return 'auto_reject';
}

function buildRejectionMessage(identifiedAs, expectedLabel) {
  const expected = String(expectedLabel || 'the expected document').trim();
  const identified = String(identifiedAs || '').trim();
  if (identified) {
    return 'This appears to be a ' + identified + ' but we expected a ' + expected + '. Please re-upload the correct document.';
  }
  return 'The uploaded file does not appear to match ' + expected + '. Please re-upload the correct document.';
}

function isVisuallyClassifiable(mimeType) {
  const m = String(mimeType || '').trim().toLowerCase();
  return m === 'application/pdf' || m.startsWith('image/');
}

function isDocxMime(mimeType) {
  return String(mimeType || '').trim().toLowerCase() === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

function isDocMime(mimeType) {
  return String(mimeType || '').trim().toLowerCase() === 'application/msword';
}

function buildClassificationPrompt(expectedLabel, extractedText) {
  return 'The user uploaded a document for: ' + String(expectedLabel || 'Unknown').trim() +
    '\n\nExtracted text from the document:\n' + String(extractedText || '').slice(0, 4000) +
    '\n\nBased on the text content, determine if this document matches what was expected. ' +
    'Return ONLY valid JSON: {"matches": true/false, "confidence": 0-100, "identifiedAs": "what it actually is", "reason": "brief explanation"}';
}

// Expedited-specialist-pathway cutoffs, by country. A specialist GP certificate
// dated BEFORE its country's cutoff is not a bad scan, the doctor belongs on the
// PEP (Practice Experience Program) Substantially Comparable pathway instead.
const PEP_DATE_CUTOFFS = { GB: '2007-08-01', IE: '2009-01-01', NZ: '2010-01-01' };

// The specialist GP certificate that carries the pathway cutoff, per country.
// Primary Medical Degree is deliberately excluded, its date does not matter.
const PEP_SPECIALIST_CERTS = {
  GB: 'mrcgp certificate',
  IE: 'micgp certificate',
  NZ: 'frnzcgp certificate'
};

/**
 * Decide whether a verified qualification read means the GP belongs on the PEP
 * (Substantially Comparable) pathway rather than the expedited specialist pathway.
 *
 * Pure: no I/O. Returns { pepEligible: boolean, pepMeta: {...}|null }.
 *
 * PEP eligibility requires a HIGH-CONFIDENCE read: the AI must already have marked
 * the document `verified` (correct specialist certificate type, name matched,
 * legible), the country must be one we gate (GB/IE/NZ), the document must be the
 * specialist certificate for that country (not the primary medical degree), and the
 * parsed date must be clearly BEFORE the country cutoff. Anything blurry, wrong-type,
 * or name-mismatched has `verified === false` and never reaches here, it stays on
 * the normal retry / manual-review path.
 */
function classifyPepEligibility({ documentType, expectedCountry, verified, dateFound }) {
  const none = { pepEligible: false, pepMeta: null };
  if (!verified) return none;
  const country = String(expectedCountry || '').toUpperCase();
  const cutoff = PEP_DATE_CUTOFFS[country];
  if (!cutoff) return none;
  const docType = String(documentType || '').trim().toLowerCase();
  if (docType !== PEP_SPECIALIST_CERTS[country]) return none;
  if (!dateFound) return none;
  const docDate = new Date(dateFound);
  const cutoffDate = new Date(cutoff);
  if (isNaN(docDate.getTime())) return none;
  if (docDate >= cutoffDate) return none;
  return {
    pepEligible: true,
    pepMeta: {
      country: country,
      certType: documentType,
      dateFound: dateFound,
      cutoffDate: cutoff
    }
  };
}

/**
 * Decide what to do with a qualification document after AI verification.
 * Pure: no I/O. nameMatch is one of 'exact' | 'fuzzy' | 'mismatch' | 'unknown'.
 * Returns { action: 'approve'|'flag', status, reasonKind }.
 */
function classifyQualificationOutcome({ verified }) {
  // Decide purely on whether the DOCUMENT itself is valid (genuine, right type/country,
  // legible, and where required a certified true copy). A name that differs from the
  // account is a NAME CHANGE, which is handled separately (recorded automatically and
  // confirmed at the AMC name-change-evidence step); it must NOT drive this outcome or
  // mask a real problem such as a missing certification. The caller is responsible for
  // passing a `verified` that already reflects the document's validity independent of the
  // name (the name-match policy sets verified=false for any name it could not confirm,
  // and a genuine document in a former name keeps its true validity).
  if (verified) {
    return { action: 'approve', status: 'approved', reasonKind: null };
  }
  return { action: 'flag', status: 'under_review', reasonKind: 'failed_verification' };
}

/**
 * Build a human-readable reason for a flagged qualification document.
 * Pure. kind is 'name_change' | 'failed_verification' (legacy 'name_mismatch' still maps to the name-change wording).
 */
function buildFlagReason(kind, opts) {
  const o = opts || {};
  const label = o.expectedLabel || 'This document';
  if (kind === 'name_change' || kind === 'name_mismatch') {
    const profile = o.profileName || 'the account holder';
    if (o.nameFound) {
      return 'The name on this document ("' + o.nameFound + '") differs from the account name ("' + profile + '"), this looks like a name change to confirm and record. The document itself does not need to be re-uploaded.';
    }
    return 'The name on this document differs from the account name ("' + profile + '"), this looks like a name change to confirm and record.';
  }
  const issues = Array.isArray(o.issues) ? o.issues.filter(Boolean) : [];
  if (issues.length > 0) {
    return label + ' could not be verified: ' + issues.join(' ');
  }
  return label + ' could not be verified and needs manual review.';
}

module.exports = {
  CONFIDENCE_AUTO_APPROVE, CONFIDENCE_VA_REVIEW,
  classifyConfidenceAction, buildRejectionMessage,
  isVisuallyClassifiable, isDocxMime, isDocMime, buildClassificationPrompt,
  classifyQualificationOutcome, buildFlagReason,
  classifyPepEligibility, PEP_DATE_CUTOFFS, PEP_SPECIALIST_CERTS
};

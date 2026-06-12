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

/**
 * Decide what to do with a qualification document after AI verification.
 * Pure: no I/O. nameMatch is one of 'exact' | 'fuzzy' | 'mismatch' | 'unknown'.
 * Returns { action: 'approve'|'flag', status, reasonKind }.
 */
function classifyQualificationOutcome({ nameMatch, verified }) {
  if (nameMatch === 'mismatch') {
    return { action: 'flag', status: 'under_review', reasonKind: 'name_mismatch' };
  }
  const nameConfirmed = nameMatch === 'exact' || nameMatch === 'fuzzy';
  if (verified && nameConfirmed) {
    return { action: 'approve', status: 'approved', reasonKind: null };
  }
  return { action: 'flag', status: 'under_review', reasonKind: 'failed_verification' };
}

/**
 * Build a human-readable reason for a flagged qualification document.
 * Pure. kind is 'name_mismatch' | 'failed_verification'.
 */
function buildFlagReason(kind, opts) {
  const o = opts || {};
  const label = o.expectedLabel || 'This document';
  if (kind === 'name_mismatch') {
    const profile = o.profileName || 'the account holder';
    if (o.nameFound) {
      return 'Name on document ("' + o.nameFound + '") does not match account ("' + profile + '").';
    }
    return 'The name on the document does not match the account holder ("' + profile + '").';
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
  classifyQualificationOutcome, buildFlagReason
};

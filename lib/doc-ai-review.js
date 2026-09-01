// ── Automatic document review decision policy (owner rule, 2026-09-01) ──
// "The AI does this automatically unless it cannot come to a verdict, then it
// goes to a person and the CEO is alerted."
//
// The policy is deliberately narrow on the reject side:
//   - APPROVE only when the scan positively verified the document, it is
//     legible, the name matches (or is unknown-but-not-mismatched), and any
//     certified-copy requirement is positively met.
//   - REJECT only for the two unambiguous cases a doctor can fix by
//     re-uploading: an unreadable file, or a file that is clearly a different
//     document from the one asked for.
//   - EVERYTHING else goes to a human: name mismatches (a legitimate name
//     change is a real flow and must never be auto-bounced), unclear
//     certification, technical failures, and any scan the model could not
//     settle. Those are the "cannot come to a verdict" cases the CEO alert
//     exists for.
'use strict';

function normalizeDocTypeToken(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Generic words that appear in almost every certificate label — sharing one of
// these proves nothing about the documents being the same kind.
const GENERIC_DOC_WORDS = new Set([
  'certificate', 'certified', 'certification', 'copy', 'of', 'the', 'a', 'an',
  'document', 'qualification', 'medical', 'letter', 'form', 'statement'
]);

// The slots have SYNONYMS the label words alone cannot see: an "MRCGP
// Certificate" IS a specialist qualification, a "Completion of Training"
// letter IS the CCT, an MBBS/MBChB/MD IS the primary degree. Caught live on
// the sweep's first backlog pass (2026-09-01): a document the AI identified as
// "MRCGP Certificate" was about to be bounced as the wrong document for the
// "Specialist Qualification" slot. A found type naming any synonym of the
// expected slot is NEVER "wrong" — an unverified one goes to a person instead.
const SLOT_SYNONYMS = {
  'specialist qualification': ['mrcgp', 'cct', 'micgp', 'cscst', 'frnzcgp', 'specialist', 'fellowship', 'membership royal college'],
  'cct certificate': ['cct', 'completion training', 'certificate completion'],
  'mrcgp': ['mrcgp', 'membership royal college', 'royal college general practitioners'],
  'primary medical degree': ['mbbs', 'mbchb', 'md', 'doctor medicine', 'bachelor medicine', 'medical degree', 'degree']
};

// Every meaningful WORD from the expected label plus its slot synonyms —
// matched word-by-word so "Membership of the Royal College" still hits the
// "membership royal college" synonym.
function expectedTokenSet(expected) {
  const tokens = new Set(expected.split(' ').filter(function (w) { return w && !GENERIC_DOC_WORDS.has(w); }));
  for (const key in SLOT_SYNONYMS) {
    if (expected.indexOf(key) !== -1) {
      for (const syn of SLOT_SYNONYMS[key]) {
        for (const w of normalizeDocTypeToken(syn).split(' ')) {
          if (w && !GENERIC_DOC_WORDS.has(w)) tokens.add(w);
        }
      }
    }
  }
  return tokens;
}

// True only when the scan named a document type that shares NO meaningful word
// with the expected label OR its known synonyms — i.e. the model read the file
// fine and it is simply a different document (a bank statement where a degree
// should be).
function looksLikeWrongDocument(scan) {
  if (!scan || scan.verified === true) return false;
  const found = normalizeDocTypeToken(scan.documentType);
  const expected = normalizeDocTypeToken(scan.expectedLabel);
  if (!found || !expected) return false;
  const foundTokens = found.split(' ').filter(function (w) { return w && !GENERIC_DOC_WORDS.has(w); });
  const expectedTokens = expectedTokenSet(expected);
  if (!foundTokens.length || !expectedTokens.size) return false;
  return !foundTokens.some(function (w) { return expectedTokens.has(w); });
}

// scan: { verified, legible, nameMatch, requiresCertification, certified,
//         documentType, expectedLabel, technicalError }
// Returns { action: 'approve' | 'reject' | 'manual', reason }.
function docAiReviewDecision(scan) {
  if (!scan || typeof scan !== 'object') return { action: 'manual', reason: 'no_scan' };
  if (scan.technicalError) return { action: 'manual', reason: 'technical_error' };
  const legible = scan.legible !== false;
  const nm = scan.nameMatch;
  const nameBad = nm === false || nm === 'mismatch' || nm === 'no' || nm === 'false';
  // A name mismatch is NEVER decided by the machine — it is either the wrong
  // person's document (serious) or a legitimate name change (has its own flow).
  if (nameBad) return { action: 'manual', reason: 'name_mismatch' };
  if (scan.verified === true) {
    if (!legible) return { action: 'manual', reason: 'contradictory_scan' };
    if (scan.requiresCertification && scan.certified !== true) {
      return { action: 'manual', reason: 'certification_unclear' };
    }
    return { action: 'approve', reason: 'verified' };
  }
  if (!legible) return { action: 'reject', reason: 'illegible' };
  if (looksLikeWrongDocument(scan)) return { action: 'reject', reason: 'wrong_document' };
  return { action: 'manual', reason: 'not_verified' };
}

// Doctor-facing rejection copy. Plain words, no em dashes, always names the
// fix. NEVER put a technical error string here — technical failures must go
// through the manual path instead.
function rejectionMessageFor(reason, expectedLabel, foundType) {
  const label = String(expectedLabel || 'document').trim();
  if (reason === 'illegible') {
    return 'We could not read your ' + label + ' clearly. Please upload a sharper photo or scan where every part of the page is visible.';
  }
  const found = String(foundType || '').trim();
  return 'The file you uploaded looks like ' + (found || 'a different document') + ', not your ' + label + '. Please upload your ' + label + '.';
}

module.exports = {
  docAiReviewDecision,
  rejectionMessageFor,
  looksLikeWrongDocument,
  normalizeDocTypeToken
};

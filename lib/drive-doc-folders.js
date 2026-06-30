'use strict';

// document_key -> Drive folder name. Names match the labels the GP Link app shows
// on each document card, sanitised to be Drive-safe (no bare "/").
const DOC_FOLDER_NAMES = {
  // GP-Link-prepared (AHPRA pack)
  sppa_00: 'SPPA-00',
  section_g: 'Section G',
  position_description: 'Position description',
  offer_contract: 'Offer / Contract',
  supervisor_cv: 'Supervisor CV',
  // Candidate-prepared
  primary_medical_degree: 'Primary medical degree',
  cv_signed_dated: 'Signed CV',
  mrcgp_certified: 'MRCGP certificate',
  cct_certified: 'CCT certificate',
  micgp_certified: 'MICGP certificate',
  cscst_certified: 'CSCST certificate',
  icgp_confirmation_letter: 'ICGP confirmation letter',
  frnzcgp_certified: 'FRNZCGP certificate',
  rnzcgp_confirmation_letter: 'RNZCGP confirmation letter',
  // Institution / AHPRA direct
  certificate_good_standing: 'Certificate of good standing',
  criminal_history: 'Criminal history check',
  confirmation_training: 'Confirmation of training',
  // Commencement
  professional_indemnity_insurance: 'Professional indemnity insurance',
};

const OTHER_FILES_FOLDER = 'Other Files';
const ID_FOLDER = 'ID';
const ALT_CV_FOLDER = 'Alternate Supervisor CV';

function driveFolderForDocKey(docKey) {
  var key = String(docKey || '').trim().toLowerCase();
  if (!key) return null;
  if (/^alt_supervisor_cv(_\d+)?$/.test(key)) return ALT_CV_FOLDER;
  if (key === 'id_document' || key === 'identity' || key === 'id_copy' || key === 'id_private' || key === 'id') return ID_FOLDER;
  return DOC_FOLDER_NAMES[key] || null;
}

function folderNameForDoc(docKey) {
  return driveFolderForDocKey(docKey) || OTHER_FILES_FOLDER;
}

// ── Filename → docKey heuristic (for GP-Link pack files with NO stored Drive id) ──
// Mirrors the legacy /api/admin/gp-documents "Attempt 2" matcher so the sweep (filing) and
// the documents view (display) agree. Same order as GP_LINK_DOCUMENT_META so the first match
// wins deterministically. Used as a LAST RESORT, after a stored google_drive_file_id; callers
// also require corroborating evidence (a practice_doc_ops/task row) before FILING by filename.
function sanitizeForMatch(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}
const GP_LINK_FILENAME_MATCHERS = [
  { key: 'sppa_00', label: 'SPPA-00', extra: /sppa/ },
  { key: 'section_g', label: 'Section G' },
  { key: 'position_description', label: 'Position description' },
  { key: 'offer_contract', label: 'Offer/contract', extra: /contract|agreement|offer|employment/ },
  { key: 'supervisor_cv', label: 'Supervisor CV' },
];
function docKeyForFilename(fileName) {
  var n = sanitizeForMatch(fileName);
  if (!n) return null;
  // An alternate-supervisor CV name ("Alternate Supervisor CV …" → "alternatesupervisorcv…")
  // CONTAINS "supervisorcv", so it must never resolve to the PRIMARY supervisor_cv card/folder.
  var isAlt = /alternat|altsupervisor/.test(n);
  for (var i = 0; i < GP_LINK_FILENAME_MATCHERS.length; i++) {
    var m = GP_LINK_FILENAME_MATCHERS[i];
    if (m.key === 'supervisor_cv' && isAlt) continue;
    var lbl = sanitizeForMatch(m.label);
    if ((lbl && n.indexOf(lbl) > -1) || (m.extra && m.extra.test(n))) return m.key;
  }
  return null;
}

module.exports = {
  DOC_FOLDER_NAMES, OTHER_FILES_FOLDER, ID_FOLDER, ALT_CV_FOLDER,
  driveFolderForDocKey, folderNameForDoc,
  sanitizeForMatch, GP_LINK_FILENAME_MATCHERS, docKeyForFilename
};

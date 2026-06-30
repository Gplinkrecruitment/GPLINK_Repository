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

module.exports = { DOC_FOLDER_NAMES, OTHER_FILES_FOLDER, ID_FOLDER, ALT_CV_FOLDER, driveFolderForDocKey, folderNameForDoc };

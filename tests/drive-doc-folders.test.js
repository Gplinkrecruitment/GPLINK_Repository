import { describe, it, expect } from 'vitest';
import { driveFolderForDocKey, folderNameForDoc, OTHER_FILES_FOLDER, ALT_CV_FOLDER, ID_FOLDER } from '../lib/drive-doc-folders.js';

describe('driveFolderForDocKey', () => {
  it('maps GP-Link prepared docs to their app labels', () => {
    expect(driveFolderForDocKey('sppa_00')).toBe('SPPA-00');
    expect(driveFolderForDocKey('section_g')).toBe('Section G');
    expect(driveFolderForDocKey('position_description')).toBe('Position description');
    expect(driveFolderForDocKey('supervisor_cv')).toBe('Supervisor CV');
  });
  it('uses a Drive-safe name for offer/contract (no bare slash)', () => {
    expect(driveFolderForDocKey('offer_contract')).toBe('Offer / Contract');
  });
  it('maps every alt-supervisor CV (any index) to one folder', () => {
    expect(driveFolderForDocKey('alt_supervisor_cv_1')).toBe(ALT_CV_FOLDER);
    expect(driveFolderForDocKey('alt_supervisor_cv_2')).toBe(ALT_CV_FOLDER);
    expect(ALT_CV_FOLDER).toBe('Alternate Supervisor CV');
  });
  it('maps candidate-prepared + institution docs to their labels', () => {
    expect(driveFolderForDocKey('primary_medical_degree')).toBe('Primary medical degree');
    expect(driveFolderForDocKey('cv_signed_dated')).toBe('Signed CV');
    expect(driveFolderForDocKey('mrcgp_certified')).toBe('MRCGP certificate');
    expect(driveFolderForDocKey('certificate_good_standing')).toBe('Certificate of good standing');
    expect(driveFolderForDocKey('criminal_history')).toBe('Criminal history check');
  });
  it('maps ID/identity keys to the ID folder', () => {
    expect(driveFolderForDocKey('id_document')).toBe(ID_FOLDER);
    expect(ID_FOLDER).toBe('ID');
  });
  it('returns null for unknown/empty keys', () => {
    expect(driveFolderForDocKey('something_else')).toBeNull();
    expect(driveFolderForDocKey('')).toBeNull();
    expect(driveFolderForDocKey(null)).toBeNull();
  });
  it('maps the commencement professional indemnity insurance doc to its own folder', () => {
    expect(driveFolderForDocKey('professional_indemnity_insurance')).toBe('Professional indemnity insurance');
    expect(folderNameForDoc('professional_indemnity_insurance')).not.toBe(OTHER_FILES_FOLDER);
  });
  it('folderNameForDoc falls back to Other Files', () => {
    expect(folderNameForDoc('sppa_00')).toBe('SPPA-00');
    expect(folderNameForDoc('mystery')).toBe(OTHER_FILES_FOLDER);
    expect(OTHER_FILES_FOLDER).toBe('Other Files');
  });
  it('no folder name contains a bare slash', () => {
    Object.values(require('../lib/drive-doc-folders.js').DOC_FOLDER_NAMES).forEach((n) => {
      expect(/\S\/\S/.test(n)).toBe(false);
    });
  });
});

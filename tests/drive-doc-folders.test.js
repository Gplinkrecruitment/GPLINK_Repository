import { describe, it, expect } from 'vitest';
import { driveFolderForDocKey, folderNameForDoc, OTHER_FILES_FOLDER, ALT_CV_FOLDER, ID_FOLDER, docKeyForFilename, GP_LINK_FILENAME_MATCHERS, sanitizeForMatch } from '../lib/drive-doc-folders.js';

describe('docKeyForFilename (filename → docKey, mirrors gp-documents Attempt 2)', () => {
  it('matches exact labels (punctuation/case/space insensitive)', () => {
    expect(docKeyForFilename('Section G.pdf')).toBe('section_g');
    expect(docKeyForFilename('SECTION-G (1).PDF')).toBe('section_g');
    expect(docKeyForFilename('Position description.pdf')).toBe('position_description');
    expect(docKeyForFilename('position_description_final.docx')).toBe('position_description');
    expect(docKeyForFilename('Supervisor CV.pdf')).toBe('supervisor_cv');
  });
  it('uses the sppa special-case', () => {
    expect(docKeyForFilename('SPPA-00.pdf')).toBe('sppa_00');
    expect(docKeyForFilename('My sppa application.pdf')).toBe('sppa_00');
  });
  it('uses the offer_contract special-case (contract/agreement/offer/employment)', () => {
    expect(docKeyForFilename('INDEPENDENT AGREEMENT (1).pdf')).toBe('offer_contract');
    expect(docKeyForFilename('Signed Contract.pdf')).toBe('offer_contract');
    expect(docKeyForFilename('Employment Offer.pdf')).toBe('offer_contract');
  });
  it('returns null for unrelated / empty names (so they are NOT promoted)', () => {
    expect(docKeyForFilename('random notes.pdf')).toBeNull();
    expect(docKeyForFilename('practice photos.png')).toBeNull();
    expect(docKeyForFilename('')).toBeNull();
    expect(docKeyForFilename(null)).toBeNull();
    expect(docKeyForFilename(undefined)).toBeNull();
  });
  it('NEVER resolves an alternate-supervisor CV to the primary supervisor_cv (substring collision guard)', () => {
    expect(docKeyForFilename('Alternate Supervisor CV - Dr Jones.pdf')).toBeNull();
    expect(docKeyForFilename('Alternative Supervisor CV.pdf')).toBeNull();
    expect(docKeyForFilename('alt supervisor cv ahmed.pdf')).toBeNull();
  });
  it('first matcher wins, in GP_LINK_DOCUMENT_META order', () => {
    expect(docKeyForFilename('SPPA-00 offer contract.pdf')).toBe('sppa_00');
    expect(docKeyForFilename('Section G agreement.pdf')).toBe('section_g');
  });
  it('is deterministic and folder-invariant (same name → same key → stable filing)', () => {
    const names = ['Section G.pdf', 'INDEPENDENT AGREEMENT.pdf', 'Supervisor CV.pdf', 'random.pdf'];
    names.forEach((nm) => {
      const k = docKeyForFilename(nm);
      expect(docKeyForFilename(nm)).toBe(k);
      // a file filed into folderNameForDoc(k) must re-resolve to the same key (no ping-pong)
      if (k) expect(sanitizeForMatch(folderNameForDoc(k))).toContain(sanitizeForMatch(GP_LINK_FILENAME_MATCHERS.find(m => m.key === k).label).slice(0, 4));
    });
  });
  it('matcher key order matches the GP-Link card order', () => {
    expect(GP_LINK_FILENAME_MATCHERS.map((m) => m.key)).toEqual(['sppa_00', 'section_g', 'position_description', 'offer_contract', 'supervisor_cv']);
  });
  it('offer_contract regex is intentionally loose (documents the server-side corroboration/ambiguity guard)', () => {
    // These resolve to offer_contract by the legacy regex; the server only FILES/BINDS them when the
    // case expects offer_contract AND the match is unambiguous (see organizeCaseDrive weakKeyCount).
    expect(docKeyForFilename('INDEPENDENT AGREEMENT (1).pdf')).toBe('offer_contract'); // Smith's real offer
    expect(docKeyForFilename('Lease Agreement.pdf')).toBe('offer_contract'); // a potential decoy
  });
});

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

import { describe, it, expect } from 'vitest';
import server from '../server.js';

const { canonicalQualKey, isQualificationDocKey, inferStageFromDocKey } = server.__testUtils;

// These helpers unify the several key spellings a single qualification document
// can arrive under (onboarding wizard / onboarding storage / scan upload) so that
// onboarding qualification reviews are de-duplicated, filed under the "onboarding"
// stage, and their stored file stays resolvable by the admin preview + approve
// endpoints. See server.js canonicalQualKey for the full rationale.

describe('canonicalQualKey', () => {
  it('collapses onboarding-origin Primary Medical Degree variants onto the canonical key', () => {
    expect(canonicalQualKey('primary_med_degree')).toBe('primary_medical_degree');
    expect(canonicalQualKey('onboarding_primary_med_degree')).toBe('primary_medical_degree');
    expect(canonicalQualKey('primary_medical_degree')).toBe('primary_medical_degree');
  });

  it('collapses every onboarding specialist-cert variant onto specialist_qualification', () => {
    for (const k of ['mrcgp_cert', 'micgp_cert', 'frnzcgp_cert', 'cscst_cert', 'onboarding_specialist_qualification']) {
      expect(canonicalQualKey(k)).toBe('specialist_qualification');
    }
    expect(canonicalQualKey('specialist_qualification')).toBe('specialist_qualification');
  });

  it('is case-insensitive on the incoming key', () => {
    expect(canonicalQualKey('Onboarding_Specialist_Qualification')).toBe('specialist_qualification');
  });

  it('leaves non-onboarding qualification keys unchanged (so their own user_documents rows still resolve)', () => {
    // A "My Documents" upload of an MRCGP certificate lives under user_documents
    // keyed by 'mrcgp_certified' — collapsing it would break file retrieval.
    expect(canonicalQualKey('mrcgp_certified')).toBe('mrcgp_certified');
    expect(canonicalQualKey('cct_certified')).toBe('cct_certified');
    expect(canonicalQualKey('supervisor_cv')).toBe('supervisor_cv');
  });

  it('returns falsy/unknown input unchanged', () => {
    expect(canonicalQualKey('')).toBe('');
    expect(canonicalQualKey(undefined)).toBe(undefined);
    expect(canonicalQualKey('section_g')).toBe('section_g');
  });
});

describe('isQualificationDocKey', () => {
  it('recognises qualification keys across all capture-flow spellings', () => {
    for (const k of [
      'primary_med_degree', 'onboarding_primary_med_degree', 'primary_medical_degree',
      'mrcgp_cert', 'micgp_cert', 'frnzcgp_cert', 'cscst_cert',
      'onboarding_specialist_qualification', 'specialist_qualification',
      'mrcgp_certified', 'cct_certified', 'mrcgp', 'cct'
    ]) {
      expect(isQualificationDocKey(k)).toBe(true);
    }
  });

  it('does not treat AHPRA practice-pack docs as qualification docs', () => {
    for (const k of ['sppa_00', 'section_g', 'position_description', 'offer_contract', 'supervisor_cv']) {
      expect(isQualificationDocKey(k)).toBe(false);
    }
  });

  it('is false for empty/unknown keys', () => {
    expect(isQualificationDocKey('')).toBe(false);
    expect(isQualificationDocKey('cover_letter')).toBe(false);
  });
});

describe('inferStageFromDocKey', () => {
  it('routes every onboarding qualification document to the onboarding stage', () => {
    for (const k of [
      'primary_med_degree', 'onboarding_primary_med_degree', 'primary_medical_degree',
      'onboarding_specialist_qualification', 'specialist_qualification', 'mrcgp_certified', 'cct'
    ]) {
      expect(inferStageFromDocKey(k)).toBe('onboarding');
    }
  });

  it('still routes AHPRA practice-pack docs to the ahpra stage', () => {
    for (const k of ['sppa_00', 'section_g', 'position_description', 'offer_contract', 'supervisor_cv']) {
      expect(inferStageFromDocKey(k)).toBe('ahpra');
    }
  });

  it('falls back to career for unrelated documents', () => {
    expect(inferStageFromDocKey('cv_signed_dated')).toBe('career');
    expect(inferStageFromDocKey('career_cover_letter')).toBe('career');
  });
});

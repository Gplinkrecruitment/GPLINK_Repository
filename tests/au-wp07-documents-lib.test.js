// Australian GP build, WP-07: the document rules that live in lib/.
//
//   1. lib/document-country.js      which document set a doctor belongs to,
//                                   and the ONE home of the legacy UK default
//   2. lib/document-requirements.js the Australian set per pathway and phase
//   3. lib/au-document-review.js    the Australian review rules and their routing
//   4. lib/doc-ai-review.js         the verdict policy still decides, unchanged
//   5. lib/drive-doc-folders.js     Drive folders for the new document types
//
// Pure: no server, no network.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const dc = require('../lib/document-country.js');
const docReq = require('../lib/document-requirements.js');
const auReview = require('../lib/au-document-review.js');
const docAiReview = require('../lib/doc-ai-review.js');
const drive = require('../lib/drive-doc-folders.js');
const cp = require('../lib/candidate-pathway.js');

// What every server call site did before WP-07, written out by hand so the
// parity assertions below do not depend on the code under test:
//   resolveGpDocumentCountry(profile, state) =
//     normalize(json-unwrap(profile || state || 'uk')) || 'uk'
function legacyAnswerBeforeWp07(profileCountry, stateCountry) {
  let raw = profileCountry || stateCountry || 'uk';
  if (typeof raw === 'string') {
    try { const parsed = JSON.parse(raw); if (typeof parsed === 'string') raw = parsed; } catch (e) { /* not wrapped */ }
  }
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'uk' || v === 'gb' || v === 'united kingdom') return 'uk';
  if (v === 'ie' || v === 'ireland') return 'ie';
  if (v === 'nz' || v === 'new zealand') return 'nz';
  return 'uk';
}

const AU_ON = (pathway) => cp.resolvePathwayFromRecords({ profile: { candidate_pathway: pathway }, credentials: null, flagEnabled: true });
const AU_OFF = (pathway) => cp.resolvePathwayFromRecords({ profile: { candidate_pathway: pathway }, credentials: null, flagEnabled: false });
const OVERSEAS_NULL_ON = cp.resolvePathwayFromRecords({ profile: {}, credentials: null, flagEnabled: true });

describe('resolveDocumentCountry: the one resolver', () => {
  const OVERSEAS_INPUTS = [
    // [label, profile country, state country]
    ['UK by name', 'United Kingdom', ''],
    ['UK by code', 'GB', ''],
    ['uk lower', 'uk', ''],
    ['Ireland', 'Ireland', ''],
    ['ie', 'ie', ''],
    ['New Zealand', 'New Zealand', ''],
    ['NZ upper', 'NZ', ''],
    ['state only, double-stringified', '', '"New Zealand"'],
    ['state only, plain', '', 'Ireland'],
    ['profile wins over state', 'Ireland', 'New Zealand'],
    ['blank country (existing overseas doctor)', '', ''],
    ['null country', null, null],
    ['undefined country', undefined, undefined],
    ['Australia in the country field, no pathway', 'Australia', ''],
    ['AU code in the country field, no pathway', 'AU', ''],
    ['garbage', 'zz-not-a-country', ''],
    ['garbage profile hides a good state value (today\'s precedence)', 'Narnia', 'Ireland'],
    ['whitespace profile', '   ', 'Ireland'],
    ['number', 42, ''],
    ['object', { a: 1 }, ''],
    ['wrapped garbage', '"France"', '']
  ];

  for (const [label, profileCountry, stateCountry] of OVERSEAS_INPUTS) {
    it(`overseas parity: ${label} gives exactly today's answer, switch on (nothing recorded) and switch off`, () => {
      const today = legacyAnswerBeforeWp07(profileCountry, stateCountry);
      const profile = { candidates: [profileCountry, stateCountry] };
      // no pathway passed at all (a caller that is not pathway-aware)
      expect(dc.resolveDocumentCountry(profile, null).code).toBe(today);
      // switch on, nothing recorded
      expect(dc.resolveDocumentCountry(profile, OVERSEAS_NULL_ON).code).toBe(today);
      // switch off, whatever is stored (even an Australian pathway reads as overseas)
      expect(dc.resolveDocumentCountry(profile, AU_OFF('au_vr')).code).toBe(today);
      expect(dc.legacyOverseasCode(profileCountry, stateCountry)).toBe(today);
    });
  }

  it('the row / state object form reads registration_country then gp_selected_country', () => {
    expect(dc.resolveDocumentCountry({ registration_country: 'Ireland', gp_selected_country: 'New Zealand' }, null).code).toBe('ie');
    expect(dc.resolveDocumentCountry({ gp_selected_country: '"New Zealand"' }, null).code).toBe('nz');
    expect(dc.resolveDocumentCountry('GB', null).code).toBe('uk');
  });

  for (const pathway of ['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar']) {
    it(`${pathway}, switch on: the Australian set, whatever the country field says`, () => {
      for (const country of ['Australia', 'United Kingdom', '', null, 'garbage']) {
        const out = dc.resolveDocumentCountry({ candidates: [country] }, AU_ON(pathway));
        expect(out).toEqual({ code: 'au_reg', set: 'au_reg', supported: true, isAu: true, legacyFallback: false, upper: 'AU' });
      }
    });
    it(`${pathway}, switch OFF: an overseas doctor again (the Australian set is unreachable)`, () => {
      expect(dc.resolveDocumentCountry({ candidates: ['Australia'] }, AU_OFF(pathway)).isAu).toBe(false);
      expect(dc.resolveDocumentCountry({ candidates: ['Ireland'] }, AU_OFF(pathway)).code).toBe('ie');
    });
  }

  it('a known overseas country is supported and is not flagged as a fallback', () => {
    expect(dc.resolveDocumentCountry('Ireland', null)).toEqual({ code: 'ie', set: 'ie', supported: true, isAu: false, legacyFallback: false, upper: 'IE' });
  });

  it('an unknown overseas country is FLAGGED: not supported, legacy fallback, so nobody mistakes it for a real answer', () => {
    const out = dc.resolveDocumentCountry('', null);
    expect(out.supported).toBe(false);
    expect(out.legacyFallback).toBe(true);
    expect(out.code).toBe(dc.LEGACY_OVERSEAS_FALLBACK);
  });

  it('strict mode: unknown means unsupported, an EMPTY answer, never UK and never GB', () => {
    for (const v of ['', null, 'Australia', 'garbage', 'fr']) {
      const out = dc.resolveDocumentCountry(v, null, { strict: true });
      expect(out).toEqual({ code: '', set: null, supported: false, isAu: false, legacyFallback: false, upper: '' });
    }
    // strict does not change a real answer
    expect(dc.resolveDocumentCountry('nz', null, { strict: true }).code).toBe('nz');
    expect(dc.resolveDocumentCountry('', AU_ON('au_vr'), { strict: true }).code).toBe('au_reg');
  });

  it('a country field can never put a doctor in the Australian set', () => {
    for (const v of ['au_reg', 'AU_REG', 'Australia', 'AU', 'au']) {
      expect(dc.normalizeOverseasCountry(v)).toBe('');
      expect(dc.resolveDocumentCountry(v, null).isAu).toBe(false);
      expect(dc.resolveDocumentCountry(v, OVERSEAS_NULL_ON).code).not.toBe('au_reg');
    }
  });

  it('a muddled pathway object does not turn a doctor Australian', () => {
    for (const p of [undefined, null, {}, { isAu: 'true' }, { isAu: 1 }, { pathway: 'au_vr' }, 'au_vr', { isAu: true, flagEnabled: false }]) {
      expect(dc.resolveDocumentCountry('Ireland', p).code).toBe('ie');
    }
  });

  it('upper-case forms', () => {
    expect(dc.legacyOverseasUpper('')).toBe('GB');
    expect(dc.legacyOverseasUpper('Ireland')).toBe('IE');
    expect(dc.upperCountryCode('nz')).toBe('NZ');
    expect(dc.upperCountryCode('au_reg')).toBe('AU');
    expect(dc.upperCountryCode('nope')).toBe('');
  });
});

describe('user_documents.country_code: no key collision (APP-24, DAT-21)', () => {
  it('au_reg is distinct from the careers code, the identity code and every overseas code, in any casing', () => {
    const others = [dc.CAREERS_DOCUMENT_COUNTRY, dc.IDENTITY_DOCUMENT_COUNTRY, ...dc.OVERSEAS_DOCUMENT_COUNTRIES, 'GB', 'IE', 'NZ', '', 'au'];
    expect(dc.AU_DOCUMENT_COUNTRY).toBe('au_reg');
    expect(dc.CAREERS_DOCUMENT_COUNTRY).toBe('AU');
    expect(dc.IDENTITY_DOCUMENT_COUNTRY).toBe('zz');
    for (const o of others) {
      expect(String(o).toLowerCase()).not.toBe(dc.AU_DOCUMENT_COUNTRY.toLowerCase());
    }
    expect(dc.isAuDocumentCountry('au_reg')).toBe(true);
    for (const o of others) expect(dc.isAuDocumentCountry(o)).toBe(false);
    expect(dc.isAuDocumentCountry('AU_REG')).toBe(false); // exact: the column is case-sensitive
  });

  it('the documented scheme lists every code exactly once', () => {
    const codes = dc.COUNTRY_CODE_SCHEME.map((r) => r.code);
    expect(codes).toEqual(['uk', 'ie', 'nz', 'AU', 'zz', 'au_reg']);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every key stored under au_reg starts au_ and is no existing document key', () => {
    const existingKeys = new Set();
    for (const c of Object.keys(docReq.DOCUMENT_REQUIREMENTS)) {
      for (const d of [...docReq.DOCUMENT_REQUIREMENTS[c].institution, ...docReq.DOCUMENT_REQUIREMENTS[c].prepared]) existingKeys.add(d.key);
    }
    ['career_cv', 'career_cover_letter', 'cv_signed_dated', 'identity', 'offer_contract', 'sppa_00', 'section_g',
      'position_description', 'supervisor_cv', 'professional_indemnity_insurance', 'ahpra_registration_certificate',
      'onboarding_primary_med_degree', 'onboarding_specialist_qualification', 'onboarding_cct_certificate',
      'specialist_qualification', 'cct_certificate'].forEach((k) => existingKeys.add(k));
    expect(docReq.AU_REG_DOCUMENT_KEYS.length).toBeGreaterThan(0);
    for (const key of docReq.AU_REG_DOCUMENT_KEYS) {
      expect(key.startsWith('au_')).toBe(true);
      expect(existingKeys.has(key)).toBe(false);
    }
    // The CV is the one item NOT stored under au_reg: it is the careers CV.
    expect(docReq.AU_REG_DOCUMENT_KEYS).not.toContain('career_cv');
    expect(docReq.auDocumentItem('career_cv').storage).toBe('careers');
  });
});

describe('the Australian document set (auDocumentRequirements)', () => {
  const keys = (set) => set.items.map((i) => i.key);

  it('segment A (au_vr): the full set, in display order', () => {
    const set = docReq.auDocumentRequirements(AU_ON('au_vr'));
    expect(set.set).toBe('au_reg');
    expect(set.pathway).toBe('au_vr');
    expect(keys(set)).toEqual([
      'career_cv', 'au_ahpra_certificate', 'au_fellowship_certificate', 'au_indemnity_certificate',
      'au_right_to_work', 'au_wwcc', 'au_provider_number_letter', 'au_immunisation_record',
      'offer_contract', 'au_references'
    ]);
    expect(set.youProvide.map((i) => i.key)).toEqual(keys(set).slice(0, 8));
    expect(set.weProvide.map((i) => i.key)).toEqual(['offer_contract', 'au_references']);
    expect(set.requiredKeys).toEqual([
      'career_cv', 'au_ahpra_certificate', 'au_fellowship_certificate', 'au_indemnity_certificate',
      'au_right_to_work', 'au_wwcc', 'au_references'
    ]);
  });

  it('segment B (au_restricted) adds the supervision plan, the grant notice and the 19AB letter', () => {
    const set = docReq.auDocumentRequirements(AU_ON('au_restricted'));
    const a = keys(docReq.auDocumentRequirements(AU_ON('au_vr')));
    const extra = keys(set).filter((k) => a.indexOf(k) === -1);
    expect(extra).toEqual(['au_supervision_plan', 'au_immigration_grant_notice', 'au_19ab_exemption_letter']);
    // fellowship is asked for but not required of a restricted doctor
    expect(set.items.find((i) => i.key === 'au_fellowship_certificate').required).toBe(false);
    expect(set.requiredKeys).toContain('au_supervision_plan');
    expect(set.requiredKeys).toContain('au_immigration_grant_notice');
    expect(set.requiredKeys).not.toContain('au_19ab_exemption_letter');
  });

  it('segment C (non-VR, registrar): no fellowship certificate and none of the segment B items', () => {
    for (const p of ['au_non_vr', 'au_registrar']) {
      const k = keys(docReq.auDocumentRequirements(AU_ON(p)));
      expect(k).not.toContain('au_fellowship_certificate');
      expect(k).not.toContain('au_supervision_plan');
      expect(k).not.toContain('au_immigration_grant_notice');
      expect(k).not.toContain('au_19ab_exemption_letter');
      expect(k).toContain('au_ahpra_certificate');
      expect(k).toContain('au_indemnity_certificate');
    }
  });

  it('phase "apply": ONLY the CV. Nothing new stands between a doctor and applying', () => {
    for (const p of ['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar']) {
      const set = docReq.auDocumentRequirements(AU_ON(p), { phase: 'apply' });
      expect(keys(set)).toEqual(['career_cv']);
      expect(set.requiredKeys).toEqual(['career_cv']);
    }
  });

  it('phase "prestart": indemnity, provider number letter, WWCC, immunisation and right to work are all there', () => {
    const set = docReq.auDocumentRequirements(AU_ON('au_vr'), { phase: 'prestart' });
    for (const k of ['au_indemnity_certificate', 'au_provider_number_letter', 'au_wwcc', 'au_immunisation_record', 'au_right_to_work', 'au_ahpra_certificate']) {
      expect(keys(set)).toContain(k);
    }
    expect(keys(set)).not.toContain('career_cv');
    expect(set.items.every((i) => i.phase === 'prestart' && i.stage === 'prestart')).toBe(true);
    // optional at pre-start
    expect(set.requiredKeys).not.toContain('au_provider_number_letter');
    expect(set.requiredKeys).not.toContain('au_immunisation_record');
  });

  it('an unknown phase gives an empty list rather than everything', () => {
    expect(docReq.auDocumentRequirements(AU_ON('au_vr'), { phase: 'nonsense' }).items).toEqual([]);
  });

  it('every item carries a label, a plain "what this is" line, help steps, who provides it, a phase and an expiry flag', () => {
    for (const p of ['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar']) {
      for (const item of docReq.auDocumentRequirements(AU_ON(p)).items) {
        expect(item.label.length).toBeGreaterThan(1);
        expect(item.short.length).toBeGreaterThan(10);
        expect(item.help.steps.length).toBeGreaterThan(0);
        expect(['you', 'we']).toContain(item.provider);
        expect(['apply', 'prestart']).toContain(item.phase);
        expect(typeof item.expiryTracked).toBe('boolean');
        expect(typeof item.required).toBe('boolean');
      }
    }
  });

  it('expiry is tracked for indemnity, Ahpra registration and the Working with Children Check', () => {
    for (const k of ['au_indemnity_certificate', 'au_ahpra_certificate', 'au_wwcc']) {
      expect(docReq.AU_EXPIRY_TRACKED_KEYS).toContain(k);
    }
    expect(docReq.AU_EXPIRY_TRACKED_KEYS).not.toContain('au_fellowship_certificate');
  });

  it('referees are details, not an upload: the doctor cannot upload "references", staff file the completed checks', () => {
    const refs = docReq.auDocumentItem('au_references');
    expect(refs.provider).toBe('we');
    expect(docReq.AU_UPLOADABLE_DOCUMENT_KEYS).not.toContain('au_references');
    expect(refs.staffSlot).toBe(true);
  });

  it('an overseas doctor, an unknown pathway and the switch off all get an EMPTY set: never the UK list', () => {
    const empties = [OVERSEAS_NULL_ON, AU_OFF('au_vr'), null, undefined, {}, 'overseas_esp', 'garbage', { isAu: false, pathway: 'au_vr' }];
    for (const p of empties) {
      const set = docReq.auDocumentRequirements(p);
      expect(set.items).toEqual([]);
      expect(set.set).toBeNull();
    }
  });

  it('labels and stages for a key', () => {
    expect(docReq.auDocumentLabel('au_immigration_grant_notice')).toBe('Immigration grant notice');
    expect(docReq.auDocumentLabel('au_immigration_grant_notice', { staff: true })).toBe('Visa grant notice');
    expect(docReq.auDocumentLabel('mrcgp_certified')).toBe('');
    expect(docReq.auDocumentStage('au_indemnity_certificate')).toBe('prestart');
    expect(docReq.auDocumentStage('career_cv')).toBe('placement');
  });

  it('the existing doc-requirements promise still holds: unknown never maps to UK, and Australia is not a fourth country', () => {
    expect(docReq.SUPPORTED_DOCUMENT_REQUIREMENT_COUNTRIES).toEqual(['uk', 'ie', 'nz']);
    expect(docReq.normalizeRequirementCountry('australia')).toBe('');
    expect(docReq.normalizeRequirementCountry('au_reg')).toBe('');
    expect(docReq.getDocumentRequirements('australia')).toBeNull();
    expect(docReq.getDocumentRequirements('au_reg')).toBeNull();
    expect(docReq.getDocumentRequirements('')).toBeNull();
    expect(Object.keys(docReq.DOCUMENT_REQUIREMENTS)).toEqual(['uk', 'ie', 'nz']);
  });
});

describe('Australian review rules: routing never crosses (COM-17)', () => {
  const isQual = (k) => ['primary_medical_degree', 'mrcgp_certified', 'cct_certified', 'onboarding_specialist_qualification'].indexOf(k) !== -1;

  it('an Australian document under au_reg goes to the Australian rules', () => {
    for (const key of auReview.AU_REVIEWABLE_KEYS) {
      expect(auReview.reviewRulesFor({ document_key: key, country_code: 'au_reg' }, isQual)).toBe('au');
    }
  });

  it('an overseas qualification goes to the overseas rules, under any overseas code', () => {
    for (const cc of ['uk', 'ie', 'nz', 'GB', '', null]) {
      expect(auReview.reviewRulesFor({ document_key: 'mrcgp_certified', country_code: cc }, isQual)).toBe('overseas');
    }
  });

  it('never crossed: an overseas key under au_reg, or an Australian key under another code, is decided by NEITHER', () => {
    expect(auReview.reviewRulesFor({ document_key: 'mrcgp_certified', country_code: 'au_reg' }, isQual)).toBe('none');
    expect(auReview.reviewRulesFor({ document_key: 'primary_medical_degree', country_code: 'au_reg' }, isQual)).toBe('none');
    for (const cc of ['uk', 'AU', 'zz', '']) {
      expect(auReview.reviewRulesFor({ document_key: 'au_indemnity_certificate', country_code: cc }, isQual)).toBe('none');
    }
  });

  it('documents with no rule (careers CV, supervision plan, references) are left to people', () => {
    expect(auReview.reviewRulesFor({ document_key: 'career_cv', country_code: 'AU' }, isQual)).toBe('none');
    expect(auReview.reviewRulesFor({ document_key: 'au_supervision_plan', country_code: 'au_reg' }, isQual)).toBe('none');
    expect(auReview.reviewRulesFor({ document_key: 'au_references', country_code: 'au_reg' }, isQual)).toBe('none');
  });

  it('every item marked aiReview in the set has a rule, and every rule belongs to an item', () => {
    const marked = docReq.AU_DOCUMENT_ITEMS.filter((i) => i.aiReview).map((i) => i.key).sort();
    expect(marked).toEqual(auReview.AU_REVIEWABLE_KEYS.slice().sort());
  });

  it('the prompt carries none of the overseas rules: no August 2007, no certified copy, no country of training', () => {
    for (const key of auReview.AU_REVIEWABLE_KEYS) {
      const p = auReview.buildAuReviewPrompt(key, { today: '2026-11-20' });
      const text = p.system + '\n' + p.user;
      expect(text).not.toMatch(/2007|2009|2012/);
      expect(text).not.toMatch(/MRCGP|MICGP|FRNZCGP|CCT\b|GMC|PMETB/);
      expect(text).not.toMatch(/country of qualification/i);
      expect(text).toMatch(/Do NOT require a certified copy/);
      expect(text).toContain('Today is 2026-11-20.');
    }
    expect(auReview.buildAuReviewPrompt('mrcgp_certified', {})).toBeNull();
  });

  it('the prompt for each type says what that document should show', () => {
    const ind = auReview.buildAuReviewPrompt('au_indemnity_certificate', {});
    expect(ind.user).toMatch(/insurer/);
    expect(ind.user).toMatch(/period of cover/);
    expect(ind.user).toMatch(/general practice/);
    expect(ind.system).toContain('"coverEnd"');
    const ahpra = auReview.buildAuReviewPrompt('au_ahpra_certificate', {});
    expect(ahpra.user).toMatch(/registration number/);
    expect(ahpra.user).toMatch(/expiry date/);
    expect(ahpra.system).toContain('"registrationNumber"');
    const fel = auReview.buildAuReviewPrompt('au_fellowship_certificate', {});
    expect(fel.user).toMatch(/FRACGP/);
    expect(fel.user).toMatch(/FACRRM/);
    const wwcc = auReview.buildAuReviewPrompt('au_wwcc', {});
    expect(wwcc.user).toMatch(/state or territory/);
    expect(wwcc.system).toContain('"checkNumber"');
  });
});

describe('interpretAuReview + the unchanged verdict policy', () => {
  const NOW = '2026-11-20T00:00:00.000Z';
  const decide = (key, verification, ctx) => {
    const read = auReview.interpretAuReview(key, verification, Object.assign({ now: NOW, expectedLabel: docReq.auDocumentLabel(key) }, ctx || {}));
    return Object.assign({ decision: docAiReview.docAiReviewDecision(read.scan) }, read);
  };
  const goodIndemnity = () => ({
    verified: true, legible: true, nameFound: 'Test Auvr', nameMatch: 'match',
    documentType: 'Certificate of currency', insurer: 'Test Insurer (FAKE)', insuredName: 'Test Auvr',
    coverStart: '2026-07-01', coverEnd: '2027-06-30', category: 'General practice'
  });

  it('a current indemnity certificate in the doctor\'s name is APPROVED, and its end date is captured', () => {
    const out = decide('au_indemnity_certificate', goodIndemnity());
    expect(out.decision).toEqual({ action: 'approve', reason: 'verified' });
    expect(out.expiresAt).toBe('2027-06-30T00:00:00.000Z');
    expect(out.scan.requiresCertification).toBe(false);
  });

  it('an indemnity certificate whose cover has ended goes to a person, with a plain reason (not auto-approved, not auto-rejected)', () => {
    const v = goodIndemnity(); v.coverEnd = '2026-06-30';
    const out = decide('au_indemnity_certificate', v);
    expect(out.decision.action).toBe('manual');
    expect(out.issues.join(' ')).toMatch(/out of date/);
  });

  it('no readable end date on a document that must be current: a person decides', () => {
    const v = goodIndemnity(); v.coverEnd = null;
    expect(decide('au_indemnity_certificate', v).decision.action).toBe('manual');
  });

  it('a name mismatch is never approved by the machine (the wrong-owner guard)', () => {
    const v = goodIndemnity(); v.nameMatch = 'mismatch'; v.verified = false;
    expect(decide('au_indemnity_certificate', v).decision).toEqual({ action: 'manual', reason: 'name_mismatch' });
  });

  it('an unreadable file is rejected with the re-upload message; a clearly different document likewise', () => {
    expect(decide('au_indemnity_certificate', { verified: false, legible: false, documentType: '' }).decision).toEqual({ action: 'reject', reason: 'illegible' });
    expect(decide('au_indemnity_certificate', { verified: false, legible: true, documentType: 'Electricity bill' }).decision).toEqual({ action: 'reject', reason: 'wrong_document' });
  });

  it('a differently worded but correct document is NOT bounced as the wrong document', () => {
    for (const found of ['Avant membership certificate', 'Professional indemnity insurance policy schedule', 'MDA National certificate of insurance']) {
      const out = decide('au_indemnity_certificate', { verified: false, legible: true, documentType: found });
      expect(out.decision.action).toBe('manual');
    }
    expect(decide('au_wwcc', { verified: false, legible: true, documentType: 'Blue Card' }).decision.action).toBe('manual');
    expect(decide('au_fellowship_certificate', { verified: false, legible: true, documentType: 'RACGP letter' }).decision.action).toBe('manual');
  });

  it('Ahpra certificate: the registration number must match the one on file', () => {
    const base = { verified: true, legible: true, nameFound: 'Test Auvr', nameMatch: 'match', documentType: 'Certificate of registration', registrationType: 'specialist', expiryDate: '2027-09-30' };
    expect(decide('au_ahpra_certificate', Object.assign({ registrationNumber: 'MED 0001234567' }, base), { ahpraNumberOnFile: 'MED0001234567' }).decision.action).toBe('approve');
    const wrong = decide('au_ahpra_certificate', Object.assign({ registrationNumber: 'MED0009999999' }, base), { ahpraNumberOnFile: 'MED0001234567' });
    expect(wrong.decision.action).toBe('manual');
    expect(wrong.issues.join(' ')).toMatch(/does not match/);
    expect(decide('au_ahpra_certificate', base, { ahpraNumberOnFile: 'MED0001234567' }).decision.action).toBe('manual');
    // nothing on file to compare against: the document stands on its own
    expect(decide('au_ahpra_certificate', Object.assign({ registrationNumber: 'MED0001234567' }, base), {}).decision.action).toBe('approve');
    // registration that has run out
    expect(decide('au_ahpra_certificate', Object.assign({}, base, { registrationNumber: 'MED0001234567', expiryDate: '2026-09-30' }), {}).decision.action).toBe('manual');
  });

  it('Working with Children Check: an application receipt is not the check', () => {
    const v = { verified: true, legible: true, nameFound: 'Test Auvr', nameMatch: 'match', documentType: 'WWCC', state: 'NSW', checkNumber: 'WWC0000000E', expiryDate: '2029-01-01' };
    expect(decide('au_wwcc', v).decision.action).toBe('approve');
    expect(decide('au_wwcc', Object.assign({}, v, { isApplicationReceiptOnly: true })).decision.action).toBe('manual');
  });

  it('fellowship, immunisation, right to work and the provider letter have no expiry rule', () => {
    for (const key of ['au_fellowship_certificate', 'au_immunisation_record', 'au_right_to_work', 'au_provider_number_letter']) {
      const out = decide(key, { verified: true, legible: true, nameFound: 'Test Auvr', nameMatch: 'match', documentType: 'x', expiryDate: '2001-01-01' });
      expect(out.decision.action).toBe('approve');
      expect(out.expiresAt).toBe('');
    }
  });

  it('a verified document with no name on it is not approved', () => {
    const v = goodIndemnity(); v.nameFound = '';
    expect(decide('au_indemnity_certificate', v).decision.action).toBe('manual');
  });

  it('no reading at all (the model was unreachable) is a technical error: a person decides, nothing is rejected', () => {
    const out = auReview.interpretAuReview('au_indemnity_certificate', null, {});
    expect(out.scan.technicalError).toBe(true);
    expect(docAiReview.docAiReviewDecision(out.scan)).toEqual({ action: 'manual', reason: 'technical_error' });
  });

  it('dates: ISO and day-first are read, nonsense is not', () => {
    expect(auReview.parseAuDate('30/06/2027')).toBe('2027-06-30T00:00:00.000Z');
    expect(auReview.parseAuDate('2027-06-30')).toBe('2027-06-30T00:00:00.000Z');
    expect(auReview.parseAuDate('null')).toBe('');
    expect(auReview.parseAuDate('June')).toBe('');
    expect(auReview.parseAuDate('1850-01-01')).toBe('');
  });

  it('the overseas verdict policy is unchanged when no synonyms are passed', () => {
    const scan = { verified: false, legible: true, documentType: 'MRCGP Certificate', expectedLabel: 'Specialist Qualification' };
    expect(docAiReview.docAiReviewDecision(scan)).toEqual({ action: 'manual', reason: 'not_verified' });
    expect(docAiReview.docAiReviewDecision({ verified: false, legible: true, documentType: 'Bank statement', expectedLabel: 'Specialist Qualification' }))
      .toEqual({ action: 'reject', reason: 'wrong_document' });
    expect(docAiReview.rejectionMessageFor('wrong_document', 'MRCGP Certificate', 'a bank statement'))
      .toBe('The file you uploaded looks like a bank statement, not your MRCGP Certificate. Please upload your MRCGP Certificate.');
  });

  it('the Australian rejection message never repeats the model\'s own description of the file', () => {
    const msg = docAiReview.rejectionMessageFor('wrong_document_plain', 'Indemnity certificate of currency', 'visa grant notice');
    expect(msg).not.toMatch(/visa/i);
    expect(msg).toContain('Indemnity certificate of currency');
  });
});

describe('Drive folders for the new document types (DAT-26)', () => {
  it('each stored Australian key has its own folder; none falls into Other Files', () => {
    for (const key of docReq.AU_REG_DOCUMENT_KEYS) {
      expect(drive.driveFolderForDocKey(key)).toBeTruthy();
      expect(drive.folderNameForDoc(key)).not.toBe(drive.OTHER_FILES_FOLDER);
    }
  });

  it('the folders the report asked for', () => {
    expect(drive.folderNameForDoc('au_provider_number_letter')).toBe('Provider number letter');
    expect(drive.folderNameForDoc('au_ahpra_certificate')).toBe('Ahpra registration certificate');
    expect(drive.folderNameForDoc('au_right_to_work')).toBe('Work rights');
    expect(drive.folderNameForDoc('au_19ab_exemption_letter')).toBe('19AB exemption letter');
    expect(drive.folderNameForDoc('au_indemnity_certificate')).toBe('Indemnity certificate of currency');
    expect(drive.folderNameForDoc('au_fellowship_certificate')).toBe('Fellowship certificate');
    expect(drive.folderNameForDoc('au_wwcc')).toBe('Working with Children Check');
    expect(drive.folderNameForDoc('au_immunisation_record')).toBe('Immunisation record');
    expect(drive.folderNameForDoc('au_references')).toBe('References');
    expect(drive.folderNameForDoc('au_supervision_plan')).toBe('Supervision plan and reports');
    expect(drive.folderNameForDoc('au_immigration_grant_notice')).toBe('Visa grant notice');
  });

  it('existing folders are untouched, and folder names are Drive-safe', () => {
    expect(drive.folderNameForDoc('mrcgp_certified')).toBe('MRCGP certificate');
    expect(drive.folderNameForDoc('ahpra_registration_certificate')).toBe('AHPRA registration');
    expect(drive.folderNameForDoc('professional_indemnity_insurance')).toBe('Professional indemnity insurance');
    expect(drive.folderNameForDoc('something_unknown')).toBe(drive.OTHER_FILES_FOLDER);
    for (const key of docReq.AU_REG_DOCUMENT_KEYS) expect(drive.folderNameForDoc(key)).not.toMatch(/^\/|\/$/);
  });
});

// Australian GP build, WP-09: the practice-facing introduction builder, the
// Australian WhatsApp template map, the consent record rules and the
// migration. Pure: no server.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ci = require('../lib/career-intro.js');
const cp = require('../lib/candidate-pathway.js');
const wa = require('../lib/practice-submission-whatsapp.js');
const auWa = require('../lib/au-whatsapp-templates.js');
const consent = require('../lib/profile-share-consent.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');

const NOW = '2026-11-20T00:00:00.000Z';
const VERIFIED = { credentials: { staff_verified_at: NOW, staff_verified_by: 'staff.test@gplink-test.local' }, profile: { register_status: 'verified', register_body: 'ahpra' } };
function merge(a, b) {
  return {
    credentials: Object.assign({}, (a || {}).credentials, (b || {}).credentials),
    profile: Object.assign({}, (a || {}).profile, (b || {}).profile),
    selfDeclared: (a || {}).selfDeclared || (b || {}).selfDeclared
  };
}
function introFor(kind, overrides) {
  const d = buildAuDoctor(kind, overrides);
  const pathwayResult = cp.resolvePathwayFromRecords({ profile: d.profile, credentials: d.credentials, flagEnabled: true });
  const facts = ci.auIntroFactsFromRecords({ pathwayResult, credentials: d.credentials, profile: d.profile, now: NOW });
  return { d, facts, intro: ci.buildAuCandidateIntro({ gpName: d.profile.first_name + ' ' + d.profile.last_name, facts }) };
}
const labels = (intro) => intro.facts.map((f) => f.label);
const everything = (intro) => JSON.stringify(intro);

// Every Australian case the acceptance list names.
const CASES = {
  'au_vr, verified': ['au_vr', merge(VERIFIED, { profile: { available_from: '2027-01-15' } })],
  'au_vr, staff-confirmed but not yet verified': ['au_vr', {}],
  'au_vr, self-declared': ['au_vr', { selfDeclared: true }],
  'au_vr, conditions reviewed': ['au_vr', merge(VERIFIED, { credentials: { has_conditions: true, conditions_text: 'CONDITION-TEXT-SENTINEL', flags_reviewed_at: NOW, flags_reviewed_by: 'staff.test@gplink-test.local' } })],
  'au_vr, conditions not reviewed': ['au_vr', merge(VERIFIED, { credentials: { has_undertakings: true, undertakings_text: 'CONDITION-TEXT-SENTINEL' } })],
  'au_restricted, 19AB applies': ['au_restricted', VERIFIED],
  'au_restricted, supervised registration': ['au_restricted', { credentials: { ahpra_registration_type: 'limited', supervision_level: 'level_1' } }],
  'au_non_vr': ['au_non_vr', {}],
  'au_registrar': ['au_registrar', {}]
};

describe('WP-09 builder: what each Australian pathway is told to a practice', () => {
  it('au_vr, verified: VR, fellowship, Ahpra verified, no registration wait, available from a date', () => {
    const { intro } = introFor(...CASES['au_vr, verified']);
    expect(intro.paragraph).toBe('Dr Test Auvr is a vocationally registered GP (FRACGP) based in Victoria. '
      + 'GP Link has verified Dr Auvr’s Ahpra registration on the public register, so there is no registration wait. '
      + 'Dr Auvr is available from 15 January 2027.');
    expect(labels(intro)).toEqual(['Vocationally registered GP (FRACGP)', 'Based in VIC', 'Ahpra registration verified', 'Available from 15 Jan 2027']);
    expect(intro.audience).toBe('au');
    expect(intro.pathwayLabel).toBe('Vocationally registered GP');
  });

  it('au_vr, not yet verified: says the number is on file and the check is in progress, never "verified"', () => {
    const { intro } = introFor(...CASES['au_vr, staff-confirmed but not yet verified']);
    expect(intro.paragraph).toBe('Dr Test Auvr is a vocationally registered GP (FRACGP) based in Victoria. '
      + 'Dr Auvr’s Ahpra registration number is on file and verification is in progress. '
      + 'Dr Auvr has about 4 weeks’ notice to give.');
    expect(everything(intro)).not.toMatch(/registration verified|has verified|no registration wait/);
    expect(labels(intro)).toContain('Ahpra verification in progress');
    expect(labels(intro)).toContain('About 4 weeks’ notice');
  });

  it('au_vr, self-declared: vocational registration is the doctor’s word, not a stated fact', () => {
    const { intro } = introFor(...CASES['au_vr, self-declared']);
    expect(intro.paragraph).toContain('Dr Test Auvr is a GP based in Victoria.');
    expect(intro.paragraph).toContain('Dr Auvr has told us they are vocationally registered (FRACGP); we are confirming this.');
    expect(intro.paragraph).not.toContain('is a vocationally registered GP');
    expect(labels(intro)[0]).toBe('GP: vocational registration being confirmed');
  });

  it('conditions reviewed: a neutral line and chip, never the text; and no "no registration wait"', () => {
    const { intro } = introFor(...CASES['au_vr, conditions reviewed']);
    expect(labels(intro)).toContain('Registration conditions: details on request');
    expect(intro.paragraph).toContain('registration has conditions recorded; details are available on request.');
    expect(everything(intro)).not.toContain('CONDITION-TEXT-SENTINEL');
    expect(everything(intro)).not.toContain('no registration wait');
  });

  it('a flag nobody has reviewed: not called verified, the detail is "being confirmed", still no text', () => {
    const { intro } = introFor(...CASES['au_vr, conditions not reviewed']);
    expect(everything(intro)).not.toMatch(/registration verified|has verified|no registration wait/);
    expect(labels(intro)).toContain('Registration details being confirmed');
    expect(labels(intro)).not.toContain('Registration conditions: details on request');
    expect(everything(intro)).not.toContain('CONDITION-TEXT-SENTINEL');
  });

  it('au_restricted: 19AB / DPA only, never "vocationally registered", never unrestricted', () => {
    const { intro } = introFor(...CASES['au_restricted, 19AB applies']);
    expect(intro.paragraph).toContain('Dr Test Aurestricted is a GP (FRACGP) based in Western Australia.');
    expect(intro.paragraph).toContain('Section 19AB applies to Dr Aurestricted (Distribution Priority Area locations only).');
    expect(labels(intro)).toContain('19AB applies: DPA locations only');
    expect(labels(intro)).toContain('Right to work tied to an employer: details on request');
    expect(everything(intro)).not.toMatch(/vocationally registered|no registration wait/i);
  });

  it('au_restricted on limited registration: supervision is stated', () => {
    const { intro } = introFor(...CASES['au_restricted, supervised registration']);
    expect(intro.paragraph).toContain('Dr Aurestricted holds limited registration and works under supervision.');
    expect(labels(intro)).toContain('Works under supervision');
    expect(labels(intro)).toContain('19AB applies: DPA locations only');
  });

  it('au_non_vr: says non-VR; unknown 19AB reads "being confirmed", never "does not apply"', () => {
    const { intro } = introFor(...CASES.au_non_vr);
    expect(intro.paragraph).toContain('Dr Test Aunonvr is a non-vocationally registered GP based in Queensland.');
    expect(labels(intro)).toEqual(['Non-VR GP', 'Based in QLD', 'Ahpra verification in progress', '19AB status being confirmed']);
  });

  it('au_registrar: says registrar and supervision; a self-declared "no" to 19AB is still "being confirmed"', () => {
    const { intro } = introFor(...CASES.au_registrar);
    expect(intro.paragraph).toContain('Dr Test Auregistrar is a GP registrar based in South Australia.');
    expect(intro.paragraph).toContain('As a registrar, Dr Auregistrar works under supervision.');
    expect(labels(intro)).toContain('19AB status being confirmed');
    expect(labels(intro)).toContain('Works under supervision');
  });

  it('fellowships: FRACGP, FACRRM, both; "other" / "none" add nothing', () => {
    const f = (type) => introFor('au_vr', merge(VERIFIED, { credentials: { fellowship_type: type } })).intro.paragraph;
    expect(f('fracgp')).toContain('vocationally registered GP (FRACGP) based');
    expect(f('facrrm')).toContain('vocationally registered GP (FACRRM) based');
    expect(f('both')).toContain('vocationally registered GP (FRACGP and FACRRM) based');
    expect(f('other')).toContain('vocationally registered GP based');
    expect(f('none')).toContain('vocationally registered GP based');
    expect(ci.auFellowshipSpecialtyLabel('fracgp')).toBe('FRACGP — General Practice');
    expect(ci.auFellowshipSpecialtyLabel('FACRRM')).toBe('FACRRM — General Practice');
    expect(ci.auFellowshipSpecialtyLabel('both')).toBe('FRACGP and FACRRM — General Practice');
    expect(ci.auFellowshipSpecialtyLabel('other')).toBe('');
    expect(ci.auFellowshipSpecialtyLabel('')).toBe('');
  });

  it('availability comes from the doctor’s own answers, and nothing is said when there are none', () => {
    const av = (profile) => introFor('au_vr', merge(VERIFIED, { profile })).intro;
    expect(av({ available_from: '2027-03-01', notice_period_weeks: null }).paragraph).toContain('is available from 1 March 2027.');
    expect(av({ available_from: null, notice_period_weeks: 6 }).paragraph).toContain('has about 6 weeks’ notice to give.');
    expect(av({ available_from: null, notice_period_weeks: 1 }).paragraph).toContain('has about 1 week’s notice to give.');
    expect(av({ available_from: null, notice_period_weeks: 0 }).paragraph).toContain('is available to start straight away.');
    expect(av({ available_from: '2026-01-01', notice_period_weeks: null }).paragraph).toContain('is available to start straight away.');
    // a notice period that runs past the stated date wins
    expect(av({ available_from: '2026-11-25', notice_period_weeks: 8 }).paragraph).toContain('about 8 weeks’ notice');
    const none = av({ available_from: null, notice_period_weeks: null });
    expect(none.paragraph).not.toMatch(/available|notice/);
    expect(none.startDateLabel).toBe('');
  });

  it('no Ahpra number on file, or a mismatch: Ahpra is not mentioned at all', () => {
    const noNumber = introFor('au_vr', { credentials: { ahpra_number: null } }).intro;
    expect(everything(noNumber)).not.toMatch(/Ahpra/);
    const mismatch = introFor('au_vr', { profile: { register_status: 'mismatch' } }).intro;
    expect(everything(mismatch)).not.toMatch(/Ahpra/);
    // staff_verified_at alone is not enough: the profile must read verified too
    const half = introFor('au_vr', { credentials: { staff_verified_at: NOW } }).intro;
    expect(everything(half)).not.toMatch(/registration verified|has verified/);
  });

  it('where the doctor is based: the state only. Unknown state reads "Australia"', () => {
    const noState = introFor('au_vr', { profile: { current_state: null } }).intro;
    expect(noState.paragraph).toContain('based in Australia.');
    expect(labels(noState).some((l) => /^Based in/.test(l))).toBe(false);
    const junk = introFor('au_vr', { profile: { current_state: 'Current Secret Practice' } }).intro;
    expect(junk.paragraph).toContain('based in Australia.');
  });

  it('no name on file: "This candidate", and still no overseas wording', () => {
    const { facts } = introFor('au_vr', VERIFIED);
    const intro = ci.buildAuCandidateIntro({ gpName: '', facts });
    expect(intro.paragraph).toMatch(/^This candidate is a vocationally registered GP/);
    expect(intro.paragraph).toContain('GP Link has verified this candidate’s Ahpra registration');
    expect(ci.auPracticeTextViolations(everything(intro))).toEqual([]);
  });

  it('returns null without facts or for a pathway that is not Australian', () => {
    expect(ci.buildAuCandidateIntro({ gpName: 'Test Doctor' })).toBeNull();
    expect(ci.buildAuCandidateIntro({ gpName: 'Test Doctor', facts: { pathway: 'overseas_esp' } })).toBeNull();
    const overseas = buildAuDoctor('overseas_null');
    const p = cp.resolvePathwayFromRecords({ profile: overseas.profile, credentials: null, flagEnabled: true });
    expect(ci.auIntroFactsFromRecords({ pathwayResult: p, credentials: null, profile: overseas.profile })).toBeNull();
    // switch off: the resolver answers overseas, so there are no Australian facts
    const au = buildAuDoctor('au_vr');
    const off = cp.resolvePathwayFromRecords({ profile: au.profile, credentials: au.credentials, flagEnabled: false });
    expect(ci.auIntroFactsFromRecords({ pathwayResult: off, credentials: au.credentials, profile: au.profile })).toBeNull();
  });
});

describe('WP-09 builder: what must never reach a practice about an Australian doctor', () => {
  Object.keys(CASES).forEach((name) => {
    it(name + ': no banned phrase, no number, no suburb, no employer, no condition text, no money', () => {
      const [kind, ov] = CASES[name];
      const withSecrets = merge(ov, {
        profile: { current_suburb: 'SECRET-SUBURB', current_postcode: '9999' },
        credentials: { visa_sponsor_name: 'CURRENT-PRACTICE-SENTINEL', indemnity_provider: 'INDEMNITY-SENTINEL', visa_subclass: '482' }
      });
      const { d, intro } = introFor(kind, withSecrets);
      const text = everything(intro);
      expect(ci.auPracticeTextViolations(text)).toEqual([]);
      expect(text).not.toContain(d.credentials.ahpra_number);
      expect(text).not.toMatch(/MED\d{10}/);
      expect(text).not.toContain('SECRET-SUBURB');
      expect(text).not.toContain('9999');
      expect(text).not.toContain('CURRENT-PRACTICE-SENTINEL');
      expect(text).not.toContain('INDEMNITY-SENTINEL');
      expect(text).not.toContain('CONDITION-TEXT-SENTINEL');
      expect(text).not.toContain('482');
      expect(text).not.toMatch(/AHPRA/); // the regulator is written "Ahpra" in Australian copy
      expect(intro.paragraph.length).toBeLessThanOrEqual(550); // fits the WhatsApp summary uncut
      expect(intro.nextSteps).toHaveLength(4);
      expect(intro.confidentialityNote).toContain('do not contact their current practice');
    });
  });

  it('the banned list catches the phrases WP-09 exists to remove, and AGENT-RULES section 4', () => {
    const bad = ['an internationally trained GP', 'internationally-trained', 'via the Expedited Specialist Pathway',
      'GP Link managing the registration process end-to-end', 'needs a visa', 'will relocate', 'relocation support',
      'overseas doctor', 'GMC number', 'MyIntealth', 'AMC exam', 'EPIC check', 'SPPA', 'Section G', 'supervisor CV',
      'Not yet eligible', 'earns $300k', '70% of billings', '65 per cent', 'PEP pathway'];
    bad.forEach((s) => expect(ci.auPracticeTextViolations(s).length, s).toBeGreaterThan(0));
    ['Epicentre Medical', 'campaign', 'section 19AB', 'Distribution Priority Area'].forEach((s) => expect(ci.auPracticeTextViolations(s), s).toEqual([]));
    // and the overseas builder really does say them (so the scan means something)
    const overseas = ci.buildCandidateIntro({ gpName: 'Test Ukgp', countryCode: 'uk', targetDate: '2027-03' });
    expect(ci.auPracticeTextViolations(overseas.paragraph).length).toBeGreaterThan(0);
  });

  it('the AI recommendation is dropped whole for an Australian doctor if it carries a banned phrase', () => {
    expect(ci.auSafeRecommendation('Dr Auvr is an experienced GP with a skin cancer interest.')).toBe('Dr Auvr is an experienced GP with a skin cancer interest.');
    expect(ci.auSafeRecommendation('Dr Auvr is relocating from overseas.')).toBe('');
    expect(ci.auSafeRecommendation('Grew billings by 30%.')).toBe('');
    expect(ci.auSafeRecommendation('')).toBe('');
    expect(ci.auSafeRecommendation(null)).toBe('');
  });
});

describe('WP-09: the overseas builder is untouched', () => {
  it('still produces today’s sentences (the full byte-for-byte proof is the parity test)', () => {
    const r = ci.buildCandidateIntro({ gpName: 'Test Ukgp', countryCode: 'uk', specialty: 'MRCGP — General Practice', targetDate: '2027-03', registerVerifiedLabel: 'GMC registration verified' });
    expect(r.paragraph).toBe('Dr Test Ukgp is an internationally trained GP from the United Kingdom holding the MRCGP, coming to Australia via the Expedited Specialist Pathway. Dr Ukgp is hoping to commence work by March 2027, with GP Link managing the registration process end-to-end.');
    expect(Object.keys(r)).toEqual(['paragraph', 'facts', 'pathwayLabel', 'startDateLabel']);
  });
});

describe('WP-09: Australian WhatsApp templates (one map, default not approved)', () => {
  it('nothing is approved by default, so the plan is "email only"', () => {
    expect(auWa.AU_WHATSAPP_TEMPLATES.practice_intro.approved).toBe(false);
    expect(auWa.AU_WHATSAPP_TEMPLATES.practice_intro_cv.approved).toBe(false);
    expect(auWa.auPracticeIntroWhatsAppPlan({})).toEqual({ send: false, reason: 'au_template_not_approved', templateNames: null });
    expect(auWa.auWhatsAppTemplate('practice_intro', {}).approved).toBe(false);
    expect(auWa.auWhatsAppTemplate('nope', {})).toBeNull();
  });

  it('the Australian template names are never the overseas ones', () => {
    const names = Object.keys(auWa.AU_WHATSAPP_TEMPLATES).map((k) => auWa.AU_WHATSAPP_TEMPLATES[k].templateName);
    expect(names).not.toContain(wa.TEMPLATE_NAME);
    expect(names).not.toContain(wa.TEMPLATE_NAME_CV);
    names.forEach((n) => expect(n).toMatch(/^gp_link_au_/));
  });

  it('config turns one on: by key or by template name', () => {
    expect(auWa.auPracticeIntroWhatsAppPlan({ AU_WHATSAPP_APPROVED_TEMPLATES: 'practice_intro' }))
      .toEqual({ send: true, reason: '', templateNames: { text: 'gp_link_au_practice_candidate_intro', cv: '' } });
    expect(auWa.auPracticeIntroWhatsAppPlan({ AU_WHATSAPP_APPROVED_TEMPLATES: ' GP_LINK_AU_PRACTICE_CANDIDATE_INTRO_CV , practice_intro ' }).templateNames)
      .toEqual({ text: 'gp_link_au_practice_candidate_intro', cv: 'gp_link_au_practice_candidate_intro_cv' });
    expect(auWa.auPracticeIntroWhatsAppPlan({ AU_WHATSAPP_APPROVED_TEMPLATES: 'something_else' }).send).toBe(false);
  });

  it('the message builder uses the Australian names when given them, and today’s names when not', () => {
    const base = { contactName: 'Test Manager', practiceName: 'Test Metro Practice (FAKE)', introParagraph: 'Dr Test Auvr is a vocationally registered GP.', actionToken: 'tok_abc' };
    const cv = { cvUrl: 'https://storage.invalid/cv.pdf', cvFilename: 'cv.pdf' };
    // overseas: unchanged
    expect(wa.buildPracticeSubmissionWaMessage(base).templateName).toBe('gp_link_practice_candidate_intro');
    expect(wa.buildPracticeSubmissionWaMessage(Object.assign({}, base, cv)).templateName).toBe('gp_link_practice_candidate_intro_cv');
    expect(wa.buildPracticeSubmissionWaMessage(Object.assign({}, base, { templateNames: undefined })).templateName).toBe('gp_link_practice_candidate_intro');
    // Australian, both approved
    const both = { text: 'gp_link_au_practice_candidate_intro', cv: 'gp_link_au_practice_candidate_intro_cv' };
    const m1 = wa.buildPracticeSubmissionWaMessage(Object.assign({}, base, cv, { templateNames: both }));
    expect(m1.templateName).toBe('gp_link_au_practice_candidate_intro_cv');
    expect(m1.header.type).toBe('DOCUMENT');
    expect(m1.placeholders[2]).toBe('Dr Test Auvr is a vocationally registered GP.');
    expect(wa.buildPracticeSubmissionWaMessage(Object.assign({}, base, { templateNames: both })).templateName).toBe('gp_link_au_practice_candidate_intro');
    // only the text one approved: the CV is not attached, the text template is used
    const m2 = wa.buildPracticeSubmissionWaMessage(Object.assign({}, base, cv, { templateNames: { text: 'gp_link_au_practice_candidate_intro', cv: '' } }));
    expect(m2.templateName).toBe('gp_link_au_practice_candidate_intro');
    expect(m2.header).toBeUndefined();
    // only the CV one approved and there is no CV: nothing to send
    expect(wa.buildPracticeSubmissionWaMessage(Object.assign({}, base, { templateNames: { text: '', cv: 'gp_link_au_practice_candidate_intro_cv' } }))).toBeNull();
    // never falls back to an overseas name
    expect(wa.buildPracticeSubmissionWaMessage(Object.assign({}, base, { templateNames: { text: '', cv: '' } }))).toBeNull();
  });

  it('the proposed templates are registered in docs/au-gp/whatsapp-templates.md as not submitted', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'au-gp', 'whatsapp-templates.md'), 'utf8');
    Object.keys(auWa.AU_WHATSAPP_TEMPLATES).forEach((k) => {
      expect(doc).toContain('`' + k + '`');
      expect(doc).toContain('`' + auWa.AU_WHATSAPP_TEMPLATES[k].templateName + '`');
    });
    expect(doc.match(/not submitted — owner action/g).length).toBeGreaterThanOrEqual(2);
    // the proposed fixed wording is itself clean
    const bodyRow = doc.split('\n').filter((l) => l.indexOf('| `practice_intro` |') === 0)[0];
    expect(ci.auPracticeTextViolations(bodyRow)).toEqual([]);
  });
});

describe('WP-09: the consent record (lib/profile-share-consent.js)', () => {
  const app = { id: 'app-1', user_id: 'u-1', career_role_id: 9001, provider_role_id: 'ats_r1' };

  it('the sheet names the practice and says exactly what is sent; no practice name, no sheet', () => {
    const s = consent.doctorConsentSheet({ practiceName: 'Test Metro Practice (FAKE)' });
    expect(s.title).toBe('Put me forward to Test Metro Practice (FAKE)?');
    expect(s.body).toBe('We’ll send Test Metro Practice (FAKE) your name, your CV and a short professional summary. Nothing else, and nobody else.');
    expect(s.tickLabel).toBe('I agree to GP Link sending my details to Test Metro Practice (FAKE) for this role.');
    expect(s.footnote).toContain('We never contact your current practice without asking you first.');
    expect(s.version).toBe(consent.CONSENT_VERSION);
    expect(s.draft).toBe(true);
    // the registration number is not sent, so the sheet must not say it is (owner decision 17B pending)
    expect(JSON.stringify(s)).not.toMatch(/registration number|Ahpra/i);
    expect(ci.auPracticeTextViolations(JSON.stringify(s))).toEqual([]);
    expect(consent.doctorConsentSheet({ practiceName: '  ' })).toBeNull();
    expect(consent.doctorConsentSheet({})).toBeNull();
  });

  it('only an explicit true against the current wording counts', () => {
    const v = consent.CONSENT_VERSION;
    expect(consent.parseDoctorConsent({ shareConsent: { agreed: true, version: v } })).toEqual({ ok: true, version: v });
    expect(consent.parseDoctorConsent({}).ok).toBe(false);
    expect(consent.parseDoctorConsent(null).ok).toBe(false);
    expect(consent.parseDoctorConsent({ shareConsent: true }).ok).toBe(false);
    expect(consent.parseDoctorConsent({ shareConsent: { agreed: 'true', version: v } }).ok).toBe(false);
    expect(consent.parseDoctorConsent({ shareConsent: { agreed: 1, version: v } }).ok).toBe(false);
    expect(consent.parseDoctorConsent({ shareConsent: { agreed: true } }).reason).toBe('stale_version');
    expect(consent.parseDoctorConsent({ shareConsent: { agreed: true, version: 'older' } }).reason).toBe('stale_version');
  });

  it('a consent covers one role: timestamp, version, source, who, and the role id', () => {
    const patch = consent.buildConsentPatch({ source: 'doctor', application: app, now: NOW });
    expect(patch).toEqual({
      profile_share_consent_at: NOW, profile_share_consent_version: consent.CONSENT_VERSION,
      profile_share_consent_source: 'doctor', profile_share_consent_by: 'self', profile_share_consent_role_id: '9001'
    });
    expect(Object.keys(patch).sort()).toEqual(consent.CONSENT_COLUMNS.slice().sort());
    const verbal = consent.buildConsentPatch({ source: 'staff_verbal', application: app, by: 'staff.test@gplink-test.local', now: NOW });
    expect(verbal.profile_share_consent_source).toBe('staff_verbal');
    expect(verbal.profile_share_consent_by).toBe('staff.test@gplink-test.local');
    // a verbal consent with nobody's name against it is not a consent
    expect(consent.buildConsentPatch({ source: 'staff_verbal', application: app, by: '' })).toBeNull();
    expect(consent.buildConsentPatch({ source: 'doctor', application: { id: 'x' } })).toBeNull();
  });

  it('on file only for the same role, with a version and a known source', () => {
    const patch = consent.buildConsentPatch({ source: 'doctor', application: app, now: NOW });
    expect(consent.consentOnFile(Object.assign({}, app, patch))).toMatchObject({ ok: true, source: 'doctor' });
    expect(consent.consentOnFile(app)).toEqual({ ok: false, reason: 'none' });
    expect(consent.consentOnFile(null).ok).toBe(false);
    // the row now points at a different role: the old consent does not carry over
    expect(consent.consentOnFile(Object.assign({}, app, patch, { career_role_id: 9002 })).reason).toBe('different_role');
    expect(consent.consentOnFile(Object.assign({}, app, patch, { profile_share_consent_version: '' })).reason).toBe('no_version');
    expect(consent.consentOnFile(Object.assign({}, app, patch, { profile_share_consent_source: 'guess' })).reason).toBe('no_source');
  });

  it('the staff note must say something', () => {
    expect(consent.cleanVerbalNote('By phone, 20 Nov')).toBe('By phone, 20 Nov');
    expect(consent.cleanVerbalNote('  ok ')).toBe('');
    expect(consent.cleanVerbalNote('')).toBe('');
    expect(consent.cleanVerbalNote('x'.repeat(500)).length).toBe(300);
  });
});

describe('migration lint: supabase/migrations/*au_gp_wp09*', () => {
  const dir = path.join(__dirname, '..', 'supabase', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => /au_gp_wp09/.test(f));
  const sql = files.length ? fs.readFileSync(path.join(dir, files[0]), 'utf8') : '';
  const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

  it('there is one, named with au_gp, sorted after the WP-08 migration', () => {
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{14}_au_gp_wp09_[a-z0-9_]+\.sql$/);
    const wp08 = fs.readdirSync(dir).filter((f) => /au_gp_wp08/.test(f))[0];
    expect(files[0] > wp08).toBe(true);
  });

  it('adds exactly the five consent columns, nullable, no default, idempotent', () => {
    consent.CONSENT_COLUMNS.forEach((c) => expect(code).toMatch(new RegExp('add column if not exists ' + c + ' (timestamptz|text)[,;]')));
    expect((code.match(/add column if not exists/g) || []).length).toBe(5);
    expect(code).not.toMatch(/\bdefault\b/i);
    expect(code).not.toMatch(/not null/i);
  });

  it('is additive only and safe for exec_sql (schema-qualified, no transaction control, no rewrite)', () => {
    expect(code).not.toMatch(/\bdrop\s+(table|column|constraint)\b/i);
    expect(code).not.toMatch(/\b(rename|truncate|delete\s+from)\b/i);
    expect(code).not.toMatch(/^\s*update\s/im);
    expect(code).not.toMatch(/^\s*(begin|commit)\s*;/im);
    expect(code).toMatch(/alter table public\.gp_applications/);
    expect(code).toMatch(/pg_catalog\.pg_constraint/);
    expect(code).toMatch(/not valid/);
    expect(code).toMatch(/validate constraint gp_applications_profile_share_consent_source_check/);
    expect(sql).toMatch(/-- Rollback/);
  });
});

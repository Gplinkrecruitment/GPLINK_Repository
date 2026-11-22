// Australian GP build, WP-23: which GPs a practice will consider
// (lib/practice-gp-types.js). The validation, the one-supervision-question
// rule, the three-state DPA answer, the mapping to the WP-08 role fields, the
// visibility matrix through roleEligibilityFor, and the draft agreement.
import { describe, it, expect } from 'vitest';

const gp = require('../lib/practice-gp-types.js');
const re = require('../lib/role-eligibility.js');
const variants = require('../lib/agreement-variants.js');

const VR_ONLY = { vr: true, non_vr: false, registrar: false, supervised: false, overseas: false };
const answers = (over) => Object.assign({ gp_types: Object.assign({}, VR_ONLY), dpa_answer: 'no', engagement_type: 'permanent', sessions_min: 6, sessions_max: 10, special_interests: ['Skin cancer medicine'] }, over || {});
const METRO = { dpa: false, supervisionAvailable: null };
const DPA = { dpa: true, supervisionAvailable: null };

describe('validateIntakeAuAnswers: fixed sets only', () => {
  it('accepts a VR-only metro practice and returns exactly the known keys', () => {
    const v = gp.validateIntakeAuAnswers(answers(), METRO);
    expect(v).toEqual({ ok: true, value: { gp_types: VR_ONLY, dpa_answer: 'no', engagement_type: 'permanent', sessions_min: 6, sessions_max: 10, special_interests: ['Skin cancer medicine'] } });
  });

  it('nothing sent (an older copy of the page) is not an error and stores nothing', () => {
    expect(gp.validateIntakeAuAnswers(undefined, METRO)).toEqual({ ok: true, value: null });
    expect(gp.validateIntakeAuAnswers(null, METRO)).toEqual({ ok: true, value: null });
  });

  it('defaults: VR yes, everything else no; overseas yes only in a DPA (owner decision 5)', () => {
    expect(gp.defaultGpTypes(false)).toEqual({ vr: true, non_vr: false, registrar: false, supervised: false, overseas: false });
    expect(gp.defaultGpTypes(true)).toEqual({ vr: true, non_vr: false, registrar: false, supervised: false, overseas: true });
    expect(gp.defaultGpTypes(null).overseas).toBe(false);
  });

  const bad = [
    ['not an object', 'yes'],
    ['an array', []],
    ['an unknown top-level key', answers({ fee: 1 })],
    ['no gp_types', { dpa_answer: 'no' }],
    ['an unknown GP type', answers({ gp_types: Object.assign({}, VR_ONLY, { locum: true }) })],
    ['a missing GP type', answers({ gp_types: { vr: true, non_vr: false, registrar: false, supervised: false } })],
    ['a GP type that is not a real boolean', answers({ gp_types: Object.assign({}, VR_ONLY, { non_vr: 'yes' }) })],
    ['no type accepted at all', answers({ gp_types: { vr: false, non_vr: false, registrar: false, supervised: false, overseas: false } })],
    ['a DPA answer outside the set', answers({ dpa_answer: 'maybe' })],
    ['no DPA answer', answers({ dpa_answer: '' })],
    ['locum (owner decision 10)', answers({ engagement_type: 'locum' })],
    ['sessions below the range', answers({ sessions_min: 0 })],
    ['sessions above the range', answers({ sessions_max: 15 })],
    ['sessions not in halves', answers({ sessions_min: 6.3 })],
    ['sessions that are not a number', answers({ sessions_min: 'lots' })],
    ['from more than to', answers({ sessions_min: 9, sessions_max: 4 })],
    ['special interests not a list', answers({ special_interests: 'Skin cancer medicine' })],
    ['a special interest that is not on the list', answers({ special_interests: ['Cosmetic injectables'] })],
    ['a special interest that is not text', answers({ special_interests: [7] })]
  ];
  for (const [name, raw] of bad) {
    it('refuses ' + name, () => {
      const v = gp.validateIntakeAuAnswers(raw, METRO);
      expect(v.ok).toBe(false);
      expect(typeof v.error).toBe('string');
    });
  }

  it('blank optional answers are stored as "not stated", never as a guess', () => {
    const v = gp.validateIntakeAuAnswers(answers({ engagement_type: '', sessions_min: '', sessions_max: null, special_interests: undefined }), METRO);
    expect(v.value).toMatchObject({ engagement_type: '', sessions_min: null, sessions_max: null, special_interests: [] });
  });
});

describe('one supervision question, not two that can contradict', () => {
  const sup = (on) => answers({ gp_types: Object.assign({}, VR_ONLY, { supervised: on }) });
  it('"supervision available: yes" with the tick off is refused', () => {
    const v = gp.validateIntakeAuAnswers(sup(false), { dpa: false, supervisionAvailable: true });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/supervision disagree/);
  });
  it('the tick on without "supervision available: yes" is refused (no, and not stated)', () => {
    expect(gp.validateIntakeAuAnswers(sup(true), { dpa: false, supervisionAvailable: false }).ok).toBe(false);
    expect(gp.validateIntakeAuAnswers(sup(true), { dpa: false, supervisionAvailable: null }).ok).toBe(false);
  });
  it('agreeing answers pass both ways', () => {
    expect(gp.validateIntakeAuAnswers(sup(true), { dpa: false, supervisionAvailable: true }).ok).toBe(true);
    expect(gp.validateIntakeAuAnswers(sup(false), { dpa: false, supervisionAvailable: false }).ok).toBe(true);
    expect(gp.validateIntakeAuAnswers(sup(false), { dpa: false, supervisionAvailable: null }).ok).toBe(true);
  });
});

describe('the DPA answer has three states and unknown is never "no" (DAT-13)', () => {
  it('dpaLookupState', () => {
    expect(gp.dpaLookupState(true)).toBe('yes');
    expect(gp.dpaLookupState(false)).toBe('no');
    for (const v of [null, undefined, '', 'unknown', 'maybe', 0, 1]) expect(gp.dpaLookupState(v)).toBe('unknown');
  });
  it('the three-state answer must agree with the yes / no the intake has always asked', () => {
    expect(gp.validateIntakeAuAnswers(answers({ dpa_answer: 'yes' }), METRO).ok).toBe(false);
    expect(gp.validateIntakeAuAnswers(answers({ dpa_answer: 'no' }), DPA).ok).toBe(false);
    expect(gp.validateIntakeAuAnswers(answers({ dpa_answer: 'unsure' }), DPA).ok).toBe(false);
    expect(gp.validateIntakeAuAnswers(answers({ dpa_answer: 'unsure' }), METRO).ok).toBe(true);
    expect(gp.validateIntakeAuAnswers(answers({ dpa_answer: 'yes' }), DPA).ok).toBe(true);
  });
  it('dpaStatusFrom: agreement, practice only, not sure, and a disagreement (flagged, never resolved)', () => {
    expect(gp.dpaStatusFrom({ answer: 'no', lookup: false })).toEqual({ status: 'no', disagreement: false, reason: 'practice_and_lookup_agree' });
    expect(gp.dpaStatusFrom({ answer: 'yes', lookup: true }).status).toBe('yes');
    expect(gp.dpaStatusFrom({ answer: 'no', lookup: null })).toEqual({ status: 'no', disagreement: false, reason: 'practice_answer_only' });
    expect(gp.dpaStatusFrom({ answer: 'unsure', lookup: true })).toEqual({ status: 'unknown', disagreement: false, reason: 'practice_unsure' });
    expect(gp.dpaStatusFrom({ answer: 'unsure', lookup: null }).status).toBe('unknown');
    expect(gp.dpaStatusFrom({ answer: 'yes', lookup: false })).toEqual({ status: 'unknown', disagreement: true, reason: 'practice_and_lookup_disagree' });
    expect(gp.dpaStatusFrom({ answer: 'no', lookup: true })).toEqual({ status: 'unknown', disagreement: true, reason: 'practice_and_lookup_disagree' });
    expect(gp.dpaStatusFrom({}).status).toBe('unknown');
  });
});

describe('roleFieldsFromIntake: the WP-08 role fields', () => {
  const intake = (au, over) => Object.assign({ dpa: false, supervision_available: null, au_gp: au }, over || {});
  it('VR-only metro practice', () => {
    const got = gp.roleFieldsFromIntake(intake(answers()), { dpa_suggested: false });
    expect(got.asked).toBe(true);
    expect(got.fields).toEqual({ vr_requirement: 'vr_required', accepts_registrars: false, accepts_supervised: false, engagement_type: 'permanent', sessions_min: 6, sessions_max: 10, special_interests: ['Skin cancer medicine'], dpa_status: 'no' });
    expect(got.flags).toEqual([]);
    expect(re.sanitiseRoleFieldsPatch(got.fields).ok).toBe(true);   // what the job editor would accept
  });
  it('non-VR only when the practice explicitly said yes; registrars and supervision likewise', () => {
    const all = gp.roleFieldsFromIntake(intake(answers({ gp_types: { vr: true, non_vr: true, registrar: true, supervised: true, overseas: false } }), { supervision_available: true }), {});
    expect(all.fields).toMatchObject({ vr_requirement: 'non_vr_accepted', accepts_registrars: true, accepts_supervised: true });
  });
  it('a disagreement between the practice and the look-up is "unknown" and flagged to staff', () => {
    const got = gp.roleFieldsFromIntake(intake(answers({ dpa_answer: 'yes', gp_types: Object.assign({}, VR_ONLY, { overseas: true }) }), { dpa: true }), { dpa_suggested: false });
    expect(got.fields.dpa_status).toBe('unknown');
    expect(got.flags.map((f) => f.code)).toEqual(['dpa_disagreement']);
    expect(got.flags[0].message).toMatch(/says it is in a Distribution Priority Area; the official look-up says it is not in one/);
  });
  it('"not sure" is "unknown" and staff are told to ask', () => {
    const got = gp.roleFieldsFromIntake(intake(answers({ dpa_answer: 'unsure' })), { dpa_suggested: true });
    expect(got.fields.dpa_status).toBe('unknown');
    expect(got.flags.map((f) => f.code)).toEqual(['dpa_unknown']);
  });
  it('answers the role fields cannot express are flagged, not dropped', () => {
    const noVr = gp.roleFieldsFromIntake(intake(answers({ gp_types: { vr: false, non_vr: true, registrar: false, supervised: false, overseas: false } })), {});
    expect(noVr.flags.map((f) => f.code)).toEqual(['vr_declined']);
    const dpaNoOverseas = gp.roleFieldsFromIntake(intake(answers({ dpa_answer: 'yes' }), { dpa: true }), { dpa_suggested: true });
    expect(dpaNoOverseas.flags.map((f) => f.code)).toEqual(['overseas_declined']);
    const metroOverseas = gp.roleFieldsFromIntake(intake(answers({ gp_types: Object.assign({}, VR_ONLY, { overseas: true }) })), {});
    expect(metroOverseas.flags.map((f) => f.code)).toEqual(['overseas_outside_dpa']);
  });
  it('an intake that was never asked gives exactly the two fields WP-08 wrote', () => {
    expect(gp.roleFieldsFromIntake({ dpa: true, supervision_available: true }, {})).toMatchObject({ asked: false, fields: { dpa_status: 'yes', accepts_supervised: true }, flags: [] });
    expect(gp.roleFieldsFromIntake({ dpa: false }, {}).fields).toEqual({ dpa_status: 'no' });
    expect(gp.roleFieldsFromIntake({}, {}).fields).toEqual({ dpa_status: 'unknown' });
  });
});

describe('the acceptance line, by the rule: a VR-only role outside a DPA', () => {
  const fields = gp.roleFieldsFromIntake({ dpa: false, au_gp: answers() }, { dpa_suggested: false }).fields;
  const role = Object.assign({ dpa: false }, fields);
  const verdict = (pathwayResult, r) => re.roleEligibilityFor(pathwayResult, r || role);
  const au = (pathway, extra) => Object.assign({ isAu: true, pathway, launched: pathway === 'au_vr', dpaRestricted: false }, extra || {});

  it('au_vr, staff-confirmed, 19AB cleared: sees it and can apply', () => {
    const v = verdict(au('au_vr'));
    expect(v).toMatchObject({ visible: true, identifiable: true, canApply: true, eligible: true });
  });
  it('au_vr whose 19AB is not yet staff-cleared: not offered (fail closed)', () => {
    for (const restricted of [true, null, undefined]) {
      const v = verdict(au('au_vr', { dpaRestricted: restricted }));
      expect(v.canApply).toBe(false);
      expect(v.reasons).toContain('dpa_restricted');
    }
  });
  it('an overseas doctor: today\'s DPA rule', () => {
    const v = verdict({ isAu: false, dpaRestricted: true });
    expect(v).toMatchObject({ visible: true, identifiable: false, canApply: false });
  });
  it('au_restricted limited to DPA, and au_non_vr on a VR-only role: not eligible', () => {
    const b = verdict(au('au_restricted', { dpaRestricted: true }));
    expect(b.canApply).toBe(false);
    expect(b.eligible).toBe(false);
    const c = verdict(au('au_non_vr'));
    expect(c.canApply).toBe(false);
    expect(c.eligible).toBe(false);
    expect(c.reasons).toContain('vr_required');
  });
  it('DPA status unknown: nobody limited to DPA roles is offered it; a cleared au_vr still is', () => {
    const unknown = Object.assign({}, role, { dpa_status: 'unknown' });
    const restricted = verdict(au('au_vr', { dpaRestricted: true }), unknown);
    expect(restricted.canApply).toBe(false);
    expect(restricted.reasons).toContain('role_dpa_unknown');
    expect(verdict({ isAu: false, dpaRestricted: true }, unknown).canApply).toBe(false);
    expect(verdict(au('au_vr'), unknown).canApply).toBe(true);
  });
});

describe('staffSummary: what the person approving sees', () => {
  it('a lead that has not filled the form: only the look-up, three states', () => {
    expect(gp.staffSummary({ metadata: { dpa_lookup: 'no' } }).dpa).toMatchObject({ status: 'no', label: 'Not in a DPA' });
    const ask = gp.staffSummary({ metadata: {} });
    expect(ask.asked).toBe(false);
    expect(ask.dpa).toMatchObject({ status: 'unknown', label: 'DPA: ask the practice' });
  });
  it('a completed intake: accepted and declined types, DPA, role facts, flags', () => {
    const s = gp.staffSummary({ dpa_suggested: false, metadata: { intake: { dpa: false, au_gp: answers() } } });
    expect(s.asked).toBe(true);
    expect(s.accepted).toEqual(['Vocationally registered Australian GPs']);
    expect(s.declined.length).toBe(4);
    expect(s.dpa).toEqual({ status: 'no', label: 'Not in a DPA', practiceAnswer: 'no', lookup: 'no', disagreement: false });
    expect(s.engagement).toBe('Permanent');
    expect(s.sessions).toBe('6 to 10 sessions a week');
    expect(s.specialInterests).toEqual(['Skin cancer medicine']);
    expect(s.flags).toEqual([]);
  });
  it('nothing for no practice', () => {
    expect(gp.staffSummary(null)).toBe(null);
  });
});

describe('the practice signs the existing agreement; the draft Australian variant cannot be reached (WP-28)', () => {
  it('a practice row carrying the draft key resolves to the standard 2026 agreement', () => {
    const draft = variants.listDraftAgreementVariants().map((d) => d.key);
    expect(draft).toContain('au-2026-draft');
    for (const key of draft) {
      expect(variants.isAgreementVariant(key)).toBe(false);
      expect(variants.resolveAgreementVariant({ metadata: { agreement_variant: key } }).key).toBe('standard');
      expect(variants.listAgreementVariants().map((v) => v.key)).not.toContain(key);
    }
    expect(variants.resolveAgreementVariant({ metadata: { intake: { dpa: false, au_gp: answers() } } }).key).toBe('standard');
  });
});

// WP-08 of the Australian GP build: the one role-eligibility rule and the pure
// helpers around it (role fields, caps, re-entry, start date, distance sort,
// tags, the reviewed stamp). No server, no database.
import { describe, it, expect } from 'vitest';

const re = require('../lib/role-eligibility.js');
const cp = require('../lib/candidate-pathway.js');
const gc = require('../lib/gp-credentials.js');
const caps = require('../lib/application-caps.js');
const match = require('../lib/ai-candidate-job-match.js');
const pipeline = require('../lib/practice-pipeline.js');

const STAFF = 'staff.test@gplink-test.local';
const NOW = '2026-11-20T00:00:00.000Z';

// 19AB states for an Australian doctor's credentials row.
const AB = {
  unknown: {},
  self_no: { moratorium_19ab_status: 'no' },
  self_yes: { moratorium_19ab_status: 'yes' },
  staff_no: { moratorium_19ab_status: 'no', moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW },
  staff_yes: { moratorium_19ab_status: 'no', moratorium_19ab_confirmed_status: 'yes', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW }
};
// WP-29 (deliberate): `self_no` was false. The doctor's own "19AB does not
// apply" now counts for what the DOCTOR sees when staff have not answered
// (a staff answer still wins both ways; unknown and "yes" still fail closed).
// A temporary resident stays restricted on their own "no": see dpaOpenFor.
const DPA_OPEN = { unknown: false, self_no: true, self_yes: false, staff_no: true, staff_yes: false };
// Written independently of the implementation: the DPA answer for a doctor
// with these credentials. `visa` = right to work is a temporary visa.
function dpaOpenFor(ab, cred) {
  if (ab === 'self_no' && cred && cred.work_rights === 'visa') return false;
  return DPA_OPEN[ab];
}

function pathwayFor(pathway, ab, extraCred, opts) {
  const o = opts || {};
  const stored = pathway == null ? null : {
    candidate_pathway: pathway, candidate_basis: /^au_/.test(pathway) ? 'australia' : 'overseas',
    pathway_set_by: STAFF, pathway_confirmed_at: NOW, pathway_confirmed_by: STAFF
  };
  return cp.resolvePathwayFromRecords({
    profile: stored,
    credentials: /^au_/.test(String(pathway)) ? Object.assign({ ahpra_registration_type: 'general', vr_status: 'vr' }, AB[ab] || {}, extraCred || {}) : null,
    flagEnabled: o.flagEnabled !== false,
    legacyDpaExempt: o.legacyDpaExempt
  });
}

const DPA_STATES = {
  yes_legacy: { dpa: true },
  yes_status: { dpa: true, dpa_status: 'yes' },
  no_legacy: { dpa: false },
  no_status: { dpa: false, dpa_status: 'no' },
  unknown: { dpa: false, dpa_status: 'unknown' },
  unknown_but_boolean_true: { dpa: true, dpa_status: 'unknown' }
};
const AU_KNOWN_DPA = { yes_legacy: true, yes_status: true, no_legacy: false, no_status: false, unknown: false, unknown_but_boolean_true: false };
const VR_VALUES = [undefined, null, 'vr_required', 'vr_preferred', 'non_vr_accepted'];
const BOOLS = [undefined, null, false, true];

describe('roleEligibilityFor: overseas doctors are answered exactly as before', () => {
  // The old rule, written out: gpQualifiesForRole(role, { australiaTrained }).
  const oldRule = (role, australiaTrained) => role.dpa === true || australiaTrained === true;

  for (const pathway of [null, 'overseas_esp', 'overseas_pep']) {
    for (const flagEnabled of [true, false]) {
      for (const legacy of [true, false, undefined]) {
        it('pathway ' + JSON.stringify(pathway) + ' | switch ' + (flagEnabled ? 'on' : 'off') + ' | country Australia: ' + JSON.stringify(legacy), () => {
          const p = pathwayFor(pathway, null, null, { flagEnabled, legacyDpaExempt: legacy });
          expect(p.isAu).toBe(false);
          for (const dpaKey of Object.keys(DPA_STATES)) {
            for (const vr of VR_VALUES) {
              for (const b of BOOLS) {
                // The role fields are thrown at it on purpose: they must change nothing.
                const role = Object.assign({ id: 'r1' }, DPA_STATES[dpaKey], { vr_requirement: vr, accepts_registrars: b, accepts_supervised: b });
                const v = re.roleEligibilityFor(p, role);
                const expected = oldRule(role, legacy === true);
                expect(v.canApply, dpaKey).toBe(expected);
                expect(v.identifiable, dpaKey).toBe(expected);
                expect(v.eligible, dpaKey).toBe(expected);
                expect(v.visible).toBe(true);           // a role they cannot have is shown blurred, as today
                expect(v.hold).toBe(false);
                expect(v.reasons).toEqual(expected ? [] : ['dpa_restricted']);
                expect(v.legacyReason).toBe(expected ? '' : 'dpa_restricted');
              }
            }
          }
        });
      }
    }
  }

  it('the old helper answers through the same rule and still returns today\'s shape', () => {
    expect(pipeline.gpQualifiesForRole({ dpa: true }, { australiaTrained: false })).toEqual({ qualifies: true });
    expect(pipeline.gpQualifiesForRole({ dpa: false }, { australiaTrained: true })).toEqual({ qualifies: true });
    expect(pipeline.gpQualifiesForRole({ dpa: false }, { australiaTrained: false })).toEqual({ qualifies: false, reason: 'dpa_restricted' });
    expect(pipeline.gpQualifiesForRole({ dpa: null }, {})).toEqual({ qualifies: false, reason: 'dpa_restricted' });
    expect(pipeline.gpQualifiesForRole(null, null)).toEqual({ qualifies: false, reason: 'dpa_restricted' });
  });
});

describe('roleEligibilityFor: the Australian matrix (pathway x 19AB x role DPA x VR requirement x accepts)', () => {
  // The expected answer, written independently of the implementation.
  //
  // WP-29 (deliberate), three rule changes, all restated here by hand:
  //   1. SUPERVISION NEVER FILTERS A ROLE. `accepts_supervised` is still thrown
  //      at the rule in every state and must change nothing; the reason
  //      'supervised_not_accepted' must never come back.
  //   2. WHO IS HELD is no longer "every pathway but au_vr". A segment B doctor
  //      who is a vocationally registered GP per their credentials is NOT held;
  //      B-not-VR (which now includes limited / provisional / no registration
  //      type / general registration) and both C pathways are.
  //   3. SPONSORSHIP. A segment B doctor on a temporary visa whose right to work
  //      is not recorded as "not tied to an employer" is offered only roles
  //      whose practice offers sponsorship (visa_pathway_aligned === true).
  function expectedFor(pathway, ab, dpaKey, vr, reg, spon, variant) {
    const reasons = [];
    const dpaOpen = dpaOpenFor(ab, variant.cred);
    if (!dpaOpen && !AU_KNOWN_DPA[dpaKey]) {
      reasons.push('dpa_restricted');
      if (/^unknown/.test(dpaKey)) reasons.push('role_dpa_unknown');
    }
    let fitFailed = false;
    if (pathway === 'au_registrar') { if (reg !== true) { reasons.push('registrars_not_accepted'); fitFailed = true; } }
    else if (pathway === 'au_non_vr') { if (vr !== 'non_vr_accepted') { reasons.push('vr_required'); fitFailed = true; } }
    else if (pathway === 'au_restricted') {
      if (!variant.vr && vr !== 'non_vr_accepted') { reasons.push('vr_required'); fitFailed = true; }
      if (variant.sponsorship && spon !== true) { reasons.push('sponsorship_not_offered'); fitFailed = true; }
    }
    const eligible = reasons.length === 0;
    const hold = pathway === 'au_vr' ? false : (pathway === 'au_restricted' ? !variant.vr : true);
    const holdKind = !hold ? null : (pathway === 'au_registrar' ? 'registrar' : 'review');
    return { eligible, hold, holdKind, fitFailed, reasons: hold ? reasons.concat(['pathway_on_hold']) : reasons };
  }

  // What "vocationally registered" takes on a segment B credentials row:
  // specialist (or general + specialist) registration, specialist_gp true, and
  // vr_status 'vr' or a GP fellowship. Everything else is "not VR".
  const VR_SPECIALIST = { ahpra_registration_type: 'specialist', specialist_gp: true, vr_status: 'vr' };
  const CRED_VARIANTS = {
    au_vr: [{ label: 'specialist', cred: { ahpra_registration_type: 'specialist', specialist_gp: true, fellowship_type: 'fracgp' }, vr: true, supervised: false }],
    au_non_vr: [{ label: 'general', cred: { ahpra_registration_type: 'general', vr_status: 'non_vr' }, vr: false, supervised: false }],
    au_registrar: [{ label: 'registrar', cred: { ahpra_registration_type: 'general', vr_status: 'non_vr' }, vr: false, supervised: false }],
    au_restricted: [
      // NOT held: a vocationally registered GP
      { label: 'specialist registration, VR', cred: VR_SPECIALIST, vr: true, supervised: false, sponsorship: false },
      { label: 'general + specialist registration, FACRRM, vr_status not set', cred: { ahpra_registration_type: 'general_and_specialist', specialist_gp: true, vr_status: null, fellowship_type: 'facrrm' }, vr: true, supervised: false, sponsorship: false },
      { label: 'specialist VR, supervision level 2 (supervision does not filter)', cred: Object.assign({}, VR_SPECIALIST, { supervision_level: 'level_2' }), vr: true, supervised: true, sponsorship: false },
      { label: 'specialist VR, temporary visa (needs a sponsoring practice)', cred: Object.assign({}, VR_SPECIALIST, { work_rights: 'visa' }), vr: true, supervised: false, sponsorship: true },
      { label: 'specialist VR, temporary visa tied to a sponsor', cred: Object.assign({}, VR_SPECIALIST, { work_rights: 'visa', visa_sponsor_tied: true }), vr: true, supervised: false, sponsorship: true },
      { label: 'specialist VR, temporary visa NOT tied to an employer', cred: Object.assign({}, VR_SPECIALIST, { work_rights: 'visa', visa_sponsor_tied: false }), vr: true, supervised: false, sponsorship: false },
      // HELD: not a vocationally registered GP
      // WP-29 (deliberate): this row used to be "VR". General registration with
      // a self-set vr_status is no longer read as vocationally registered.
      { label: 'general registration, vr_status vr', cred: { ahpra_registration_type: 'general', vr_status: 'vr' }, vr: false, supervised: false, sponsorship: false },
      { label: 'specialist registration, specialist_gp not true', cred: { ahpra_registration_type: 'specialist', specialist_gp: false, vr_status: 'vr' }, vr: false, supervised: false, sponsorship: false },
      { label: 'specialist GP, no vr_status and no GP fellowship', cred: { ahpra_registration_type: 'specialist', specialist_gp: true, vr_status: null, fellowship_type: 'other' }, vr: false, supervised: false, sponsorship: false },
      { label: 'general registration, not VR', cred: { ahpra_registration_type: 'general', vr_status: 'non_vr' }, vr: false, supervised: false, sponsorship: false },
      { label: 'limited registration', cred: { ahpra_registration_type: 'limited', vr_status: 'vr' }, vr: false, supervised: true, sponsorship: false },
      { label: 'provisional registration', cred: { ahpra_registration_type: 'provisional' }, vr: false, supervised: true, sponsorship: false },
      { label: 'registration type not recorded', cred: { ahpra_registration_type: null, vr_status: 'vr' }, vr: false, supervised: true, sponsorship: false },
      { label: 'general but supervision level 2', cred: { ahpra_registration_type: 'general', vr_status: 'vr', supervision_level: 'level_2' }, vr: false, supervised: true, sponsorship: false },
      { label: 'limited registration, temporary visa', cred: { ahpra_registration_type: 'limited', work_rights: 'visa' }, vr: false, supervised: true, sponsorship: true }
    ]
  };
  const SPONSOR_VALUES = [undefined, false, true];

  let cases = 0;
  const seenReasons = {};
  for (const pathway of cp.AU_PATHWAYS) {
    for (const variant of CRED_VARIANTS[pathway]) {
      for (const ab of Object.keys(AB)) {
        it(pathway + ' (' + variant.label + ') | 19AB ' + ab, () => {
          const p = pathwayFor(pathway, ab, variant.cred);
          expect(p.dpaRestricted).toBe(!dpaOpenFor(ab, variant.cred));
          // `launched` itself is unchanged by WP-29: still false for B and C.
          expect(p.launched).toBe(pathway === 'au_vr');
          const wantHold = pathway === 'au_vr' ? false : (pathway === 'au_restricted' ? !variant.vr : true);
          expect(p.selfServiceHeld).toBe(wantHold);
          expect(p.holdKind).toBe(!wantHold ? null : (pathway === 'au_registrar' ? 'registrar' : 'review'));
          expect(p.sorting.group).toBe(pathway === 'au_registrar' ? 'registrar' : (!(pathway === 'au_vr' || variant.vr) ? 'non_vr_held' : (p.dpaRestricted ? 'dpa_only' : 'anywhere')));
          const wantFit = { vr: pathway === 'au_vr' ? true : variant.vr, registrar: pathway === 'au_registrar', supervised: variant.supervised };
          if (pathway === 'au_restricted') wantFit.sponsorship = variant.sponsorship;
          expect(p.roleFit).toEqual(wantFit);
          for (const dpaKey of Object.keys(DPA_STATES)) {
            for (const vr of VR_VALUES) {
              for (const reg of BOOLS) {
                for (const sup of BOOLS) {
                  for (const spon of SPONSOR_VALUES) {
                    const role = Object.assign({ id: 'r' }, DPA_STATES[dpaKey], { vr_requirement: vr, accepts_registrars: reg, accepts_supervised: sup, visa_pathway_aligned: spon });
                    const want = expectedFor(pathway, ab, dpaKey, vr, reg, spon, variant);
                    const got = re.roleEligibilityFor(p, role);
                    const where = [dpaKey, 'vr=' + vr, 'reg=' + reg, 'sup=' + sup, 'spon=' + spon].join(' ');
                    expect(got.eligible, where).toBe(want.eligible);
                    expect(got.hold, where).toBe(want.hold);
                    expect(got.holdKind, where).toBe(want.holdKind);
                    expect(got.canApply, where).toBe(want.eligible && !want.hold);
                    expect(got.identifiable, where).toBe(want.eligible && !want.hold);
                    expect(got.visible, where).toBe(!want.hold && !want.fitFailed);
                    expect(got.reasons.slice().sort(), where).toEqual(want.reasons.slice().sort());
                    got.reasons.forEach((code) => { seenReasons[code] = true; });
                    cases++;
                  }
                }
              }
            }
          }
        });
      }
    }
  }
  it('the matrix really ran (thousands of combinations)', () => { expect(cases).toBeGreaterThan(15000); });
  it('WP-29: supervision is never a reason, and every other reason was exercised', () => {
    expect(seenReasons.supervised_not_accepted).toBeUndefined();
    expect(Object.keys(seenReasons).sort()).toEqual(['dpa_restricted', 'pathway_on_hold', 'registrars_not_accepted', 'role_dpa_unknown', 'sponsorship_not_offered', 'vr_required']);
  });
});

describe('the four things the brief names explicitly', () => {
  const DPA_ROLE = { id: 'dpa', dpa: true, dpa_status: 'yes', vr_requirement: 'vr_required', accepts_supervised: true };
  const METRO_VR_ONLY = { id: 'metro', dpa: false, dpa_status: 'no', vr_requirement: 'vr_required' };
  const METRO_NON_VR = { id: 'metro2', dpa: false, dpa_status: 'no', vr_requirement: 'non_vr_accepted' };
  const UNKNOWN_DPA = { id: 'ask', dpa: false, dpa_status: 'unknown', vr_requirement: 'non_vr_accepted', accepts_registrars: true, accepts_supervised: true };

  it('an au_restricted doctor under 19AB is eligible ONLY for DPA roles', () => {
    // WP-29 (deliberate): "vocationally registered" on segment B now takes
    // specialist registration in general practice, so the doctor is spelled so.
    const VR = { ahpra_registration_type: 'specialist', specialist_gp: true, vr_status: 'vr' };
    const p = pathwayFor('au_restricted', 'staff_yes', VR);
    expect(re.roleEligibilityFor(p, DPA_ROLE).eligible).toBe(true);
    expect(re.roleEligibilityFor(p, METRO_VR_ONLY).eligible).toBe(false);
    expect(re.roleEligibilityFor(p, METRO_NON_VR).eligible).toBe(false);
    expect(re.roleEligibilityFor(p, METRO_NON_VR).reasons).toContain('dpa_restricted');
    // WP-29 (deliberate): a segment B doctor who IS a vocationally registered
    // GP is no longer held. They see and may apply for the DPA role, and only
    // that: a role outside a DPA is a blurred stub they cannot apply for, and a
    // role whose DPA status is unknown is not offered either.
    expect(re.roleEligibilityFor(p, DPA_ROLE)).toMatchObject({ canApply: true, visible: true, identifiable: true, hold: false, holdKind: null, reasons: [] });
    for (const role of [METRO_VR_ONLY, METRO_NON_VR]) {
      expect(re.roleEligibilityFor(p, role)).toMatchObject({ canApply: false, identifiable: false, visible: true, hold: false, reasons: ['dpa_restricted'] });
    }
    expect(re.roleEligibilityFor(p, UNKNOWN_DPA)).toMatchObject({ canApply: false, identifiable: false, eligible: false, reasons: ['dpa_restricted', 'role_dpa_unknown'] });
    // The property the old lines proved still holds for a segment B doctor who
    // is NOT a vocationally registered GP: held, so even the DPA role is hidden
    // and cannot be applied for. Limited registration is "not VR" now (it used
    // to need a role that accepts supervised doctors: that gate is gone).
    for (const cred of [{ ahpra_registration_type: 'general', vr_status: 'non_vr' }, { ahpra_registration_type: 'limited' }, { ahpra_registration_type: null }]) {
      const held = pathwayFor('au_restricted', 'staff_yes', cred);
      expect(held).toMatchObject({ selfServiceHeld: true, holdKind: 'review', holdWhy: 'non_vr' });
      const v = re.roleEligibilityFor(held, DPA_ROLE);
      expect(v).toMatchObject({ canApply: false, visible: false, identifiable: false, hold: true, holdKind: 'review', eligible: false });
      expect(v.reasons).toEqual(['vr_required', 'pathway_on_hold']);
      // Staff may put them forward by hand only for a DPA role that takes non-VR doctors.
      expect(re.roleEligibilityFor(held, Object.assign({}, DPA_ROLE, { vr_requirement: 'non_vr_accepted', accepts_supervised: false }))).toMatchObject({ eligible: true, canApply: false, visible: false });
      expect(re.roleEligibilityFor(held, METRO_NON_VR)).toMatchObject({ eligible: false, canApply: false });
    }
  });

  it('an au_vr doctor with a staff-confirmed 19AB "no" sees and may apply for all', () => {
    const p = pathwayFor('au_vr', 'staff_no');
    for (const role of [DPA_ROLE, METRO_VR_ONLY, METRO_NON_VR]) {
      expect(re.roleEligibilityFor(p, role)).toMatchObject({ visible: true, identifiable: true, canApply: true, eligible: true, hold: false, reasons: [] });
    }
  });

  it('unknown fails closed: 19AB unknown, role DPA unknown, pathway unreadable, schema missing, no result at all', () => {
    // 19AB unknown / "not sure" / the doctor says it applies -> DPA roles only
    // WP-29 (deliberate): 'self_no' left this list (see below); "unsure" and
    // "yes" joined it so every closed answer is named.
    for (const p of [pathwayFor('au_vr', 'unknown'), pathwayFor('au_vr', 'unknown', { moratorium_19ab_status: 'unsure' }), pathwayFor('au_vr', 'self_yes')]) {
      expect(p.dpaRestricted).toBe(true);
      expect(re.roleEligibilityFor(p, METRO_VR_ONLY)).toMatchObject({ canApply: false, identifiable: false, visible: true, reasons: ['dpa_restricted'] });
      expect(re.roleEligibilityFor(p, DPA_ROLE).canApply).toBe(true);
    }
    // WP-29 (deliberate): the doctor's own "no" now opens roles outside a DPA
    // FOR THE DOCTOR (see and apply)...
    const ownWord = pathwayFor('au_vr', 'self_no');
    expect(ownWord).toMatchObject({ dpaRestricted: false, dpaSelfDeclaredOnly: true, staff19ab: 'unconfirmed' });
    expect(re.roleEligibilityFor(ownWord, METRO_VR_ONLY)).toMatchObject({ canApply: true, identifiable: true, visible: true, reasons: [] });
    // ...but it is never enough to put them in front of a practice: the
    // introduction is refused until staff confirm 19AB, even with the register
    // check saved, and refused outright without the check.
    expect(re.auIntroductionBlock(ownWord, METRO_VR_ONLY, { registerVerified: true })).toMatchObject({ code: '19ab_not_confirmed' });
    expect(re.auIntroductionBlock(ownWord, METRO_VR_ONLY, { registerVerified: false })).toMatchObject({ code: 'ahpra_check_not_verified' });
    expect(re.auIntroductionBlock(ownWord, DPA_ROLE, { registerVerified: false })).toMatchObject({ code: 'ahpra_check_not_verified' });
    expect(re.auIntroductionBlock(ownWord, DPA_ROLE, { registerVerified: true })).toBe(null);
    expect(re.auIntroductionBlock(ownWord, UNKNOWN_DPA, { registerVerified: true })).toMatchObject({ code: '19ab_not_confirmed' });
    expect(re.auApplicationLocationFlag(ownWord, METRO_VR_ONLY)).toMatchObject({ code: '19ab_not_confirmed', restricted: false });
    // Staff's own answers decide the introduction, both ways.
    expect(re.auIntroductionBlock(pathwayFor('au_vr', 'staff_no'), METRO_VR_ONLY, { registerVerified: true })).toBe(null);
    expect(re.auIntroductionBlock(pathwayFor('au_vr', 'staff_yes'), METRO_VR_ONLY, { registerVerified: true })).toMatchObject({ code: '19ab_applies_role_not_dpa' });
    expect(re.auIntroductionBlock(pathwayFor('au_vr', 'unknown'), METRO_VR_ONLY, { registerVerified: true })).toMatchObject({ code: '19ab_not_confirmed' });
    // ...and a temporary resident's own "no" still fails closed for the doctor too.
    const temporary = pathwayFor('au_vr', 'self_no', { work_rights: 'visa' });
    expect(temporary).toMatchObject({ dpaRestricted: true, dpaRestrictedReason: 'temporary_resident' });
    expect(re.roleEligibilityFor(temporary, METRO_VR_ONLY)).toMatchObject({ canApply: false, identifiable: false, visible: true, reasons: ['dpa_restricted'] });
    // role DPA status unknown -> not eligible for a restricted doctor, and staff are told to ask
    const restricted = pathwayFor('au_vr', 'unknown');
    const v = re.roleEligibilityFor(restricted, UNKNOWN_DPA);
    expect(v.eligible).toBe(false);
    expect(v.reasons).toEqual(['dpa_restricted', 'role_dpa_unknown']);
    expect(re.staffEligibilityNotes(v).map((n) => n.message).join(' ')).toMatch(/Ask the practice/);
    // ...but an unrestricted doctor does not need the role to be in a DPA at all
    expect(re.roleEligibilityFor(pathwayFor('au_vr', 'staff_no'), UNKNOWN_DPA).eligible).toBe(true);
    // unreadable / not migrated / nothing -> restricted, even when the country says Australia
    const exempt = cp.overseasDefault({ flagEnabled: true, legacyDpaExempt: true });
    expect(re.roleEligibilityFor(exempt, METRO_VR_ONLY).canApply).toBe(true);
    expect(re.roleEligibilityFor(Object.assign({}, exempt, { readFailed: true }), METRO_VR_ONLY).canApply).toBe(false);
    expect(re.roleEligibilityFor(Object.assign({}, exempt, { schemaMissing: true }), METRO_VR_ONLY).canApply).toBe(false);
    expect(re.roleEligibilityFor(Object.assign({}, exempt, { schemaMissing: true }), DPA_ROLE).canApply).toBe(true);
    expect(re.roleEligibilityFor(null, METRO_VR_ONLY).canApply).toBe(false);
    expect(re.roleEligibilityFor(undefined, DPA_ROLE).canApply).toBe(true);
    // an Australian result that could not be read is never treated as Australian
    const auUnread = Object.assign({}, pathwayFor('au_vr', 'staff_no'), { readFailed: true });
    expect(re.roleEligibilityFor(auUnread, METRO_VR_ONLY).canApply).toBe(false);
    expect(re.shouldHoldSelfService(auUnread)).toBe(false);
  });

  it('a non-VR doctor cannot apply to a VR-only role (the rule; the server enforcement is tested in au-wp08-server)', () => {
    const nonVr = pathwayFor('au_non_vr', 'staff_no', { vr_status: 'non_vr' });
    // Held today (segment C is not launched)...
    expect(re.roleEligibilityFor(nonVr, METRO_VR_ONLY)).toMatchObject({ eligible: false, canApply: false, visible: false });
    expect(re.roleEligibilityFor(nonVr, METRO_VR_ONLY).reasons).toContain('vr_required');
    // ...and STILL refused the day segment C is launched: launching changes one
    // thing (the hold), never the role rule.
    // WP-29 (deliberate): the hold is no longer read from `launched`. It is the
    // sorting rule's answer on the result (`selfServiceHeld`), so flipping
    // `launched` alone lifts nothing. "The day the hold goes" is modelled by
    // clearing that answer; the role rule below is exactly what it was.
    expect(re.shouldHoldSelfService(Object.assign({}, nonVr, { launched: true }))).toBe(true);
    expect(re.roleEligibilityFor(Object.assign({}, nonVr, { launched: true }), METRO_NON_VR)).toMatchObject({ canApply: false, visible: false, hold: true });
    // A result built by hand without the sorting answer keeps the older reading.
    expect(re.shouldHoldSelfService({ isAu: true, pathway: 'au_non_vr', launched: false })).toBe(true);
    expect(re.shouldHoldSelfService({ isAu: true, pathway: 'au_non_vr', launched: true })).toBe(false);
    const launched = Object.assign({}, nonVr, { launched: true, selfServiceHeld: false, holdKind: null });
    expect(re.shouldHoldSelfService(launched)).toBe(false);
    expect(re.roleEligibilityFor(launched, METRO_VR_ONLY)).toMatchObject({ eligible: false, canApply: false, visible: false, hold: false, reasons: ['vr_required'] });
    expect(re.roleEligibilityFor(launched, Object.assign({}, METRO_VR_ONLY, { vr_requirement: 'vr_preferred' })).canApply).toBe(false);
    expect(re.roleEligibilityFor(launched, Object.assign({}, METRO_VR_ONLY, { vr_requirement: null })).canApply).toBe(false);
    expect(re.roleEligibilityFor(launched, METRO_NON_VR)).toMatchObject({ eligible: true, canApply: true, visible: true, identifiable: true });
    expect(re.eligibilityMessage(re.roleEligibilityFor(launched, METRO_VR_ONLY))).toBe('This role is only open to vocationally registered GPs.');
  });

  it('the unlaunched hold is one function, and its message is one sentence', () => {
    expect(re.shouldHoldSelfService(pathwayFor('au_vr', 'unknown'))).toBe(false);
    for (const p of ['au_restricted', 'au_non_vr', 'au_registrar']) expect(re.shouldHoldSelfService(pathwayFor(p, 'staff_no')), p).toBe(true);
    for (const p of [null, 'overseas_esp', 'overseas_pep']) expect(re.shouldHoldSelfService(pathwayFor(p)), String(p)).toBe(false);
    expect(re.shouldHoldSelfService(pathwayFor('au_restricted', 'staff_no', null, { flagEnabled: false }))).toBe(false);
    expect(re.shouldHoldSelfService(null)).toBe(false);
    // WP-29 (deliberate): a segment B doctor who is a vocationally registered GP is not held.
    const vrB = pathwayFor('au_restricted', 'staff_no', { ahpra_registration_type: 'specialist', specialist_gp: true, vr_status: 'vr' });
    expect(re.shouldHoldSelfService(vrB)).toBe(false);
    expect(re.holdViewFor(vrB)).toBe(null);
    const held = re.roleEligibilityFor(pathwayFor('au_registrar', 'staff_no'), { dpa: true, accepts_registrars: true });
    expect(held).toMatchObject({ eligible: true, hold: true, holdKind: 'registrar', canApply: false, visible: false, identifiable: false });
    // WP-29 (deliberate): a held REGISTRAR is told plainly that GP Link does
    // not place registrars; every other held doctor still gets the one
    // "confirming your details" sentence. Both are pinned word for word.
    expect(re.eligibilityMessage(held)).toBe(re.REGISTRAR_HOLD_MESSAGE);
    expect(re.REGISTRAR_HOLD_MESSAGE).toBe('GP Link works with GPs who hold fellowship (FRACGP or FACRRM) or are otherwise fully qualified to practise independently. '
      + "We can't place GP registrars at the moment. Once you have your fellowship, sign in again and update your details and we will take it from there.");
    expect(re.holdViewFor(pathwayFor('au_registrar', 'staff_no'))).toEqual({ held: true, kind: 'registrar', title: 'We place fully qualified GPs', message: re.REGISTRAR_HOLD_MESSAGE });
    for (const p of [pathwayFor('au_non_vr', 'staff_no'), pathwayFor('au_restricted', 'staff_no')]) {
      const review = re.roleEligibilityFor(p, { dpa: true, vr_requirement: 'non_vr_accepted' });
      expect(review).toMatchObject({ eligible: true, hold: true, holdKind: 'review', canApply: false, visible: false, identifiable: false });
      expect(re.eligibilityMessage(review)).toBe(re.HOLD_MESSAGE);
      expect(re.holdViewFor(p)).toEqual({ held: true, kind: 'review', title: 'Thanks, we have your details', message: re.HOLD_MESSAGE });
    }
    expect(re.HOLD_MESSAGE).toBe('Our team is confirming your details and will be in touch by email.');
    for (const p of [pathwayFor('au_vr', 'unknown'), pathwayFor(null), pathwayFor('overseas_pep'), null]) expect(re.holdViewFor(p)).toBe(null);
  });

  it('no message a doctor can be shown uses a word from AGENT-RULES section 4', () => {
    Object.keys(re.DOCTOR_MESSAGE).forEach((k) => expect(re.AU_FORBIDDEN_WORDS.test(re.DOCTOR_MESSAGE[k]), k).toBe(false));
    expect(re.AU_FORBIDDEN_WORDS.test(re.HOLD_MESSAGE)).toBe(false);
    // WP-29 (deliberate): the registrar hold card is doctor-facing copy too.
    expect(re.AU_FORBIDDEN_WORDS.test(re.REGISTRAR_HOLD_MESSAGE + ' ' + re.REGISTRAR_HOLD_TITLE + ' ' + re.HOLD_TITLE)).toBe(false);
    for (const banned of ['MyIntealth', 'AMC', 'EPIC', 'visa', 'relocate', 'relocation', 'your move', 'overseas', 'internationally trained', 'GMC', 'SPPA', 'Section G', 'supervisor CV', 'Not yet eligible']) {
      expect(re.AU_FORBIDDEN_WORDS.test('a ' + banned + ' b'), banned).toBe(true);
    }
  });
});

describe('checkMatchEligibility asks the same rule', () => {
  const baseGp = { onboardingComplete: true, hasCv: true, placed: false, liveApplicationRoleIds: [], atInterviewStage: false, careerLocked: false, accountStatus: 'active' };

  it('overseas: the old boolean gives the old answer, for every combination', () => {
    for (const dpaEligible of [true, false, undefined]) {
      for (const dpa of [true, false, null, undefined]) {
        const v = match.checkMatchEligibility(Object.assign({}, baseGp, { dpaEligible }), { id: 1, dpa });
        const blocked = dpa !== true && dpaEligible !== true;
        expect(v.blocks, JSON.stringify([dpaEligible, dpa])).toEqual(blocked ? ['dpa_ineligible'] : []);
      }
    }
  });

  it('a resolver result on the gp wins, and brings the role fields with it', () => {
    const gp = (pathway, ab, cred) => Object.assign({}, baseGp, { dpaEligible: true, pathway: pathwayFor(pathway, ab, cred) });
    expect(match.checkMatchEligibility(gp('au_vr', 'unknown'), { id: 1, dpa: false }).blocks).toEqual(['dpa_ineligible']);
    expect(match.checkMatchEligibility(gp('au_vr', 'staff_no'), { id: 1, dpa: false }).blocks).toEqual([]);
    expect(match.checkMatchEligibility(gp('au_vr', 'unknown'), { id: 1, dpa: false, dpa_status: 'unknown' }).blocks).toEqual(['dpa_ineligible', 'role_dpa_unknown']);
    // Segment B / C doctors are not matchable through an invitation at all.
    expect(match.checkMatchEligibility(gp('au_non_vr', 'staff_no'), { id: 1, dpa: true }).blocks).toEqual(['vr_required', 'pathway_on_hold']);
    expect(match.checkMatchEligibility(gp('au_registrar', 'staff_no'), { id: 1, dpa: true, accepts_registrars: true }).blocks).toEqual(['pathway_on_hold']);
    // WP-29 (deliberate): limited registration is "not VR" now (supervision no
    // longer filters), so the block is 'vr_required', never 'supervised_not_accepted'.
    // The doctor is still held, so still not matchable through an invitation.
    expect(match.checkMatchEligibility(gp('au_restricted', 'staff_yes', { ahpra_registration_type: 'limited' }), { id: 1, dpa: true }).blocks).toEqual(['vr_required', 'pathway_on_hold']);
    expect(match.checkMatchEligibility(gp('au_restricted', 'staff_yes', { ahpra_registration_type: 'limited' }), { id: 1, dpa: true, accepts_supervised: true }).blocks).toEqual(['vr_required', 'pathway_on_hold']);
    // WP-29 (deliberate): a segment B doctor who is a vocationally registered
    // GP is matchable, for DPA roles only, and only with a sponsoring practice
    // when their right to work needs one.
    const VR = { ahpra_registration_type: 'specialist', specialist_gp: true, vr_status: 'vr' };
    expect(match.checkMatchEligibility(gp('au_restricted', 'staff_yes', VR), { id: 1, dpa: true }).blocks).toEqual([]);
    expect(match.checkMatchEligibility(gp('au_restricted', 'staff_yes', VR), { id: 1, dpa: false }).blocks).toEqual(['dpa_ineligible']);
    expect(match.checkMatchEligibility(gp('au_restricted', 'staff_yes', VR), { id: 1, dpa: false, dpa_status: 'unknown' }).blocks).toEqual(['dpa_ineligible', 'role_dpa_unknown']);
    const visa = Object.assign({}, VR, { work_rights: 'visa' });
    expect(match.checkMatchEligibility(gp('au_restricted', 'staff_yes', visa), { id: 1, dpa: true }).blocks).toEqual(['sponsorship_not_offered']);
    expect(match.checkMatchEligibility(gp('au_restricted', 'staff_yes', visa), { id: 1, dpa: true, visa_pathway_aligned: true }).blocks).toEqual([]);
    // The doctor's own "19AB does not apply" opens a match outside a DPA for an au_vr doctor; "unsure" does not.
    expect(match.checkMatchEligibility(gp('au_vr', 'self_no'), { id: 1, dpa: false }).blocks).toEqual([]);
    expect(match.checkMatchEligibility(gp('au_vr', 'unknown', { moratorium_19ab_status: 'unsure' }), { id: 1, dpa: false }).blocks).toEqual(['dpa_ineligible']);
  });

  it('the job-agnostic check (no role in question) only applies the hold', () => {
    const sentinel = { id: null, dpa: true, jobAgnostic: true };
    const gp = (pathway) => Object.assign({}, baseGp, { pathway: pathwayFor(pathway, 'unknown') });
    expect(match.checkMatchEligibility(gp('au_vr'), sentinel).blocks).toEqual([]);
    expect(match.checkMatchEligibility(gp('au_non_vr'), sentinel).blocks).toEqual(['pathway_on_hold']);
    expect(match.checkMatchEligibility(Object.assign({}, baseGp, { dpaEligible: false }), sentinel).blocks).toEqual([]);
  });
});

describe('role fields', () => {
  it('readRoleFields: NULL is the closed answer; billing and MMM come from the columns that already exist', () => {
    expect(re.readRoleFields({})).toMatchObject({ vrRequirement: 'vr_required', vrRequirementStored: null, acceptsRegistrars: false, acceptsSupervised: false, engagementType: null, sessionsMin: null, sessionsMax: null, specialInterests: [], billingModel: '', mmm: null, dpaStatus: 'no', dpaStatusStored: null });
    expect(re.readRoleFields({ vr_requirement: 'NON_VR_ACCEPTED ', accepts_registrars: 'true', engagement_type: 'locum' })).toMatchObject({ vrRequirement: 'non_vr_accepted', acceptsRegistrars: false, engagementType: null });
    for (const [raw, want] of [['mixed', 'mixed'], ['Mixed Billing', 'mixed'], ['Bulk Billing', 'bulk'], ['bulk', 'bulk'], ['Private Billing', 'private'], ['', ''], ['Billing to be confirmed', '']]) {
      expect(re.normaliseBillingModel({ billing_model: raw }), raw).toBe(want);
    }
    expect(re.normaliseBillingModel({ billing_model: '', mixed_billing: true })).toBe('mixed');
    expect(re.normaliseBillingModel({ billing_model: '', private_billing: true })).toBe('private');
    expect(re.readRoleFields({ mmm: 'MM1' }).mmm).toBe(1);
    expect(re.areaFromRole({ mmm: 'MM1' })).toBe('metro');
    expect(re.areaFromRole({ mmm: 'MM3' })).toBe('regional');
    expect(re.areaFromRole({ mmm: '', metro: true })).toBe('metro');
    expect(re.areaFromRole({ mmm: '', regional: true })).toBe('regional');
    expect(re.areaFromRole({})).toBe('');
  });

  it('the DPA status never changes what the existing boolean means', () => {
    expect(re.roleDpaStatus({ dpa: true })).toBe('yes');
    expect(re.roleDpaStatus({ dpa: false })).toBe('no');
    expect(re.roleDpaStatus({})).toBe('no');
    expect(re.roleDpaStatus({ dpa: true, dpa_status: 'unknown' })).toBe('unknown');
    expect(re.roleDpaStatus({ dpa: false, dpa_status: 'yes' })).toBe('yes');
    // overseas logic reads only the boolean, whatever the status says
    const overseas = cp.overseasDefault({ flagEnabled: true, legacyDpaExempt: false });
    expect(re.roleEligibilityFor(overseas, { dpa: true, dpa_status: 'no' }).canApply).toBe(true);
    expect(re.roleEligibilityFor(overseas, { dpa: false, dpa_status: 'yes' }).canApply).toBe(false);
  });

  it('sanitiseRoleFieldsPatch: only what was sent, validated, nothing half-applied', () => {
    expect(re.sanitiseRoleFieldsPatch({ title: 'x' })).toEqual({ ok: true, value: {}, touched: false });
    expect(re.sanitiseRoleFieldsPatch({ vr_requirement: 'non_vr_accepted', accepts_registrars: true, accepts_supervised: 'false', engagement_type: 'contract', sessions_min: '2', sessions_max: 6.5, special_interests: 'Skin, skin , Women\'s health', dpa_status: 'unknown' }))
      .toEqual({ ok: true, touched: true, value: { vr_requirement: 'non_vr_accepted', accepts_registrars: true, accepts_supervised: false, engagement_type: 'contract', sessions_min: 2, sessions_max: 6.5, special_interests: ['Skin', "Women's health"], dpa_status: 'unknown' } });
    expect(re.sanitiseRoleFieldsPatch({ vr_requirement: '', accepts_registrars: null, engagement_type: null, sessions_min: '', special_interests: [], dpa_status: '' }).value)
      .toEqual({ vr_requirement: null, accepts_registrars: null, engagement_type: null, sessions_min: null, special_interests: [], dpa_status: null });
    for (const bad of [{ vr_requirement: 'anyone' }, { engagement_type: 'locum' }, { dpa_status: 'maybe' }, { accepts_registrars: 'yes' }, { sessions_min: 15 }, { sessions_max: -1 }, { sessions_min: 2.3 }, { sessions_min: 6, sessions_max: 2 }, { special_interests: [1] }, { special_interests: {} }]) {
      const r = re.sanitiseRoleFieldsPatch(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(typeof r.error).toBe('string');
    }
    expect(re.ENGAGEMENT_TYPES).toEqual(['permanent', 'contract']);   // no locum: owner decision 10
  });

  it('publicRoleFacts (APP-19 data): facts only, no money, nothing about sponsorship or where a doctor trained', () => {
    const facts = re.publicRoleFacts({ billing_model: 'Mixed Billing', earnings_text: '$400k', mmm: 'MM1', vr_requirement: 'vr_required', sessions_min: 6, sessions_max: 10, special_interests: ['Skin'], engagement_type: 'permanent', dpa: false, dpa_status: 'no', visa_pathway_aligned: true });
    expect(facts).toEqual({ billingModel: 'mixed', vrRequirement: 'vr_required', vrRequirementStated: true, acceptsRegistrars: false, acceptsSupervised: false, engagementType: 'permanent', sessionsMin: 6, sessionsMax: 10, specialInterests: ['Skin'], mmm: 1, area: 'metro', dpa: 'no', afterHours: null, restraintRadiusKm: null });
    expect(JSON.stringify(facts)).not.toMatch(/\$|%|visa|overseas|sponsor/i);
  });
});

describe('tags are pathway-aware (COM-24, COM-25)', () => {
  const TAGS = ['DPA approved', 'Visa pathway aligned', 'Family friendly', 'Regional NSW', 'Independent'];
  it('overseas / nothing recorded / no result: untouched (the same array)', () => {
    expect(re.filterTagsForPathway(TAGS, pathwayFor(null))).toBe(TAGS);
    expect(re.filterTagsForPathway(TAGS, pathwayFor('overseas_pep'))).toBe(TAGS);
    expect(re.filterTagsForPathway(TAGS, null)).toBe(TAGS);
    expect(re.filterTagsForPathway(TAGS, pathwayFor('au_vr', 'staff_no', null, { flagEnabled: false }))).toBe(TAGS);
  });
  it('segment A: no visa tag, no DPA tag. Segment C: no visa tag. Segment B keeps both', () => {
    expect(re.filterTagsForPathway(TAGS, pathwayFor('au_vr', 'staff_no'))).toEqual(['Family friendly', 'Regional NSW', 'Independent']);
    expect(re.filterTagsForPathway(TAGS, pathwayFor('au_non_vr', 'unknown'))).toEqual(['DPA approved', 'Family friendly', 'Regional NSW', 'Independent']);
    expect(re.filterTagsForPathway(TAGS, pathwayFor('au_registrar', 'unknown'))).toEqual(['DPA approved', 'Family friendly', 'Regional NSW', 'Independent']);
    expect(re.filterTagsForPathway(TAGS, pathwayFor('au_restricted', 'staff_yes'))).toEqual(TAGS);
  });
  it('a tag carrying any other forbidden word never reaches an Australian doctor', () => {
    const p = pathwayFor('au_restricted', 'staff_yes');
    expect(re.filterTagsForPathway(['Relocation support', 'Overseas doctors welcome', 'GMC', 'Teaching practice'], p)).toEqual(['Teaching practice']);
  });
});

describe('distance sort (DAT-11)', () => {
  const rows = [
    { id: 'dubbo', suburb: 'Dubbo', location_state: 'NSW', practice_id: 'p-dubbo', published_at: '2026-11-01' },
    { id: 'parra', suburb: 'Parramatta', location_state: 'NSW', practice_id: 'p-parra', published_at: '2026-10-01' },
    { id: 'melb', suburb: 'Fitzroy', location_state: 'VIC', practice_id: 'p-melb', published_at: '2026-11-10' },
    { id: 'nocoords', suburb: 'Parramatta', location_state: 'NSW', practice_id: null, published_at: '2026-09-01' }
  ];
  const coords = { 'p-dubbo': { latitude: -32.2569, longitude: 148.6011 }, 'p-parra': { latitude: -33.815, longitude: 151.0011 }, 'p-melb': { latitude: -37.8, longitude: 144.978 } };
  const getCoords = (row) => coords[row.practice_id] || null;

  it('haversine is roughly right (Parramatta to Dubbo is about 300 km)', () => {
    const km = re.haversineKm(-33.815, 151.0011, -32.2569, 148.6011);
    expect(km).toBeGreaterThan(260);
    expect(km).toBeLessThan(320);
    expect(re.haversineKm('x', 1, 2, 3)).toBe(null);
  });

  it('with home coordinates: nearest first, inside the commute radius first, unmeasured roles by suburb / state', () => {
    const ranked = re.rankRolesByDistance(rows, { home: { latitude: -33.87, longitude: 151.2, suburb: 'Parramatta', state: 'NSW', commuteRadiusKm: 40 }, getCoords });
    expect(ranked.map((r) => r.item.id)).toEqual(['parra', 'nocoords', 'dubbo', 'melb']);
    expect(ranked[0].withinCommute).toBe(true);
    expect(ranked[0].distanceKm).toBeLessThan(25);
    expect(ranked[2].withinCommute).toBe(false);
    expect(ranked[1].distanceKm).toBe(null);
  });

  it('without home coordinates: same suburb, then same state, then the rest; newest first inside a tier', () => {
    const ranked = re.rankRolesByDistance(rows, { home: { suburb: 'parramatta', state: 'nsw' }, getCoords });
    expect(ranked.map((r) => r.item.id)).toEqual(['parra', 'nocoords', 'dubbo', 'melb']);
    expect(ranked.every((r) => r.distanceKm === null)).toBe(true);
    const none = re.rankRolesByDistance(rows, { home: {}, getCoords });
    expect(none.map((r) => r.item.id)).toEqual(['melb', 'dubbo', 'parra', 'nocoords']);   // newest first
    expect(re.rankRolesByDistance(null, {})).toEqual([]);
  });
});

describe('start date for an Australian doctor (COM-13)', () => {
  const now = '2026-11-20T03:00:00.000Z';
  it('comes from the availability date and the notice period, never an arrival date', () => {
    expect(re.auEarliestStart({ available_from: '2027-02-01', notice_period_weeks: 4, target_arrival_date: '2029-01' }, now)).toEqual({ iso: '2027-02-01', basis: 'both' });
    expect(re.auEarliestStart({ available_from: '2026-11-25', notice_period_weeks: 4 }, now)).toEqual({ iso: '2026-12-18', basis: 'both' });
    expect(re.auEarliestStart({ notice_period_weeks: 0 }, now)).toEqual({ iso: '2026-11-20', basis: 'notice_period' });
    expect(re.auEarliestStart({ notice_period_weeks: 12 }, now)).toEqual({ iso: '2027-02-12', basis: 'notice_period' });
    expect(re.auEarliestStart({ available_from: '2026-01-01' }, now)).toEqual({ iso: '2026-11-20', basis: 'available_from' });
    expect(re.auEarliestStart({ available_from: '2027-03-15T00:00:00Z' }, now)).toEqual({ iso: '2027-03-15', basis: 'available_from' });
    expect(re.auEarliestStart({ target_arrival_date: '2027-06' }, now)).toEqual({ iso: '', basis: 'none' });
    expect(re.auEarliestStart({ available_from: 'soon', notice_period_weeks: 'x' }, now)).toEqual({ iso: '', basis: 'none' });
    expect(re.auEarliestStart(null, now)).toEqual({ iso: '', basis: 'none' });
  });
});

describe('re-entry after a placement (APP-22)', () => {
  it('allowed once every placement has started or ended; not before', () => {
    expect(re.auReentryAllowed({ placements: [{ status: 'active' }], caseStage: 'prestart' })).toEqual({ allowed: false, basis: 'not_started' });
    expect(re.auReentryAllowed({ placements: [{ status: 'active' }], caseStage: 'commenced' })).toEqual({ allowed: true, basis: 'case_stage' });
    expect(re.auReentryAllowed({ placements: [{ status: 'active' }], caseStage: 'guarantee' }).allowed).toBe(true);
    expect(re.auReentryAllowed({ placements: [{ status: 'ended' }], caseStage: 'prestart' })).toEqual({ allowed: true, basis: 'status_ended' });
    expect(re.auReentryAllowed({ placements: [], caseStage: 'placement' })).toEqual({ allowed: false, basis: 'not_started' });
    expect(re.auReentryAllowed({ placements: [], caseStage: 'complete' })).toEqual({ allowed: true, basis: 'case_stage' });
    expect(re.auReentryAllowed({ readFailed: true, caseStage: 'commenced' })).toEqual({ allowed: false, basis: 'unreadable' });
    expect(re.auReentryAllowed(null)).toEqual({ allowed: false, basis: 'not_started' });
  });
  it('reads WP-13\'s columns when they exist, and tolerates their absence', () => {
    expect(re.auReentryAllowed({ placements: [{ status: 'active', commenced_at: '2026-10-01T00:00:00Z' }], caseStage: 'prestart' })).toEqual({ allowed: true, basis: 'commenced_at' });
    expect(re.auReentryAllowed({ placements: [{ status: 'active', ended_at: '2026-10-01T00:00:00Z' }], caseStage: 'prestart' })).toEqual({ allowed: true, basis: 'ended_at' });
    // two placements: one started, one not yet
    expect(re.auReentryAllowed({ placements: [{ status: 'active', commenced_at: '2026-10-01' }, { status: 'active' }], caseStage: 'prestart' }).allowed).toBe(false);
    expect(re.auReentryAllowed({ placements: [{ status: 'active', commenced_at: null, ended_at: null }], caseStage: 'prestart' }).allowed).toBe(false);
  });
});

describe('application caps per pathway (DAT-23, owner decision 8)', () => {
  it('overseas numbers are today\'s, pinned, and cannot be moved by the environment', () => {
    expect(caps.OVERSEAS_CAPS).toEqual({ active: 2, monthly: 3, interviewsMonthly: 3, strikeLock: 3 });
    const env = { AU_APPLICATION_CAPS_JSON: JSON.stringify({ active: 9, monthly: 9, interviewsMonthly: 9, strikeLock: 9, overseas: { active: 9 }, overseas_esp: { active: 9 } }) };
    for (const p of [null, undefined, pathwayFor(null), pathwayFor('overseas_esp'), pathwayFor('overseas_pep'), pathwayFor('au_vr', 'staff_no', null, { flagEnabled: false })]) {
      expect(caps.capsForPathway(p, env)).toMatchObject({ active: 2, monthly: 3, interviewsMonthly: 3, strikeLock: 3, basis: 'overseas' });
    }
    expect(caps.applicationCapsConfig(env).overseas).toEqual({ active: 2, monthly: 3, interviewsMonthly: 3, strikeLock: 3 });
  });
  it('Australian defaults are 4 active, 6 a month, 6 interviews a month, and the same three-strike lock', () => {
    expect(caps.AU_DEFAULT_CAPS).toEqual({ active: 4, monthly: 6, interviewsMonthly: 6, strikeLock: 3 });
    for (const p of cp.AU_PATHWAYS) expect(caps.capsForPathway(pathwayFor(p, 'unknown'), {})).toMatchObject({ active: 4, monthly: 6, interviewsMonthly: 6, strikeLock: 3, basis: 'au', pathway: p });
    expect(caps.strikeLockIsUniform({})).toBe(true);
    expect(caps.minStrikeLock({})).toBe(3);
  });
  it('an unreadable pathway gets the tighter (overseas) set', () => {
    const au = pathwayFor('au_vr', 'staff_no');
    expect(caps.capsForPathway(Object.assign({}, au, { readFailed: true }), {}).active).toBe(2);
    expect(caps.capsForPathway(Object.assign({}, au, { schemaMissing: true }), {}).active).toBe(2);
  });
  it('the environment can change Australian numbers, for all or one pathway; a bad value is ignored', () => {
    const env = { AU_APPLICATION_CAPS_JSON: '{"monthly":8,"au_restricted":{"active":2,"strikeLock":2},"au_vr":{"active":"lots","interviewsMonthly":0}}' };
    expect(caps.capsForPathway(pathwayFor('au_vr', 'staff_no'), env)).toMatchObject({ active: 4, monthly: 8, interviewsMonthly: 6, strikeLock: 3 });
    expect(caps.capsForPathway(pathwayFor('au_restricted', 'staff_yes'), env)).toMatchObject({ active: 2, monthly: 8, strikeLock: 2 });
    expect(caps.strikeLockIsUniform(env)).toBe(false);
    expect(caps.minStrikeLock(env)).toBe(2);
    for (const junk of ['not json', '[1,2]', '"x"', '']) expect(caps.capsForPathway(pathwayFor('au_vr', 'staff_no'), { AU_APPLICATION_CAPS_JSON: junk }).active).toBe(4);
  });
  it('the wording with the overseas number is, character for character, today\'s', () => {
    expect(caps.activeCapMessage(2, 'apply')).toBe('You already have 2 live applications. To apply for this position, withdraw one of your current applications first.');
    expect(caps.activeCapMessage(2, 'match')).toBe('You already have 2 live applications. To accept this match, withdraw one of your current applications first.');
    expect(caps.activeCapMessage(4, 'apply')).toBe('You already have 4 live applications. To apply for this position, withdraw one of your current applications first.');
    expect(caps.monthlyCapMessage(3, '1 December')).toBe('You have applied for 3 positions this month, which is the monthly limit. Your limit resets on 1 December.');
  });
});

describe('the reviewed stamp (WP-06 hook)', () => {
  const flagged = { ahpra_registration_type: 'specialist', specialist_gp: true, fellowship_type: 'fracgp', has_conditions: true, conditions_text: 'A condition (FAKE).' };
  const profile = { candidate_pathway: 'au_vr', candidate_basis: 'australia', pathway_set_by: STAFF, pathway_confirmed_at: NOW, pathway_confirmed_by: STAFF };

  it('a recorded condition needs a review until a person has stamped it; then it stops, for good', () => {
    const before = cp.resolvePathwayFromRecords({ profile, credentials: flagged, flagEnabled: true });
    expect(before).toMatchObject({ needsStaffReview: true, hasRegistrationFlags: true, flagsReviewed: false });
    const after = cp.resolvePathwayFromRecords({ profile, credentials: Object.assign({}, flagged, { flags_reviewed_at: NOW, flags_reviewed_by: STAFF }), flagEnabled: true });
    expect(after).toMatchObject({ needsStaffReview: false, hasRegistrationFlags: true, flagsReviewed: true });
    // a time with no name against it is not a review
    expect(cp.resolvePathwayFromRecords({ profile, credentials: Object.assign({}, flagged, { flags_reviewed_at: NOW }), flagEnabled: true }).needsStaffReview).toBe(true);
    expect(cp.resolvePathwayFromRecords({ profile, credentials: Object.assign({}, flagged, { flags_reviewed_by: STAFF }), flagEnabled: true }).needsStaffReview).toBe(true);
  });

  it('the stamp never clears an unlaunched or unconfirmed pathway', () => {
    const stamped = Object.assign({}, flagged, { flags_reviewed_at: NOW, flags_reviewed_by: STAFF });
    expect(cp.resolvePathwayFromRecords({ profile: Object.assign({}, profile, { candidate_pathway: 'au_restricted' }), credentials: stamped, flagEnabled: true }).needsStaffReview).toBe(true);
    expect(cp.resolvePathwayFromRecords({ profile: Object.assign({}, profile, { pathway_confirmed_at: null }), credentials: stamped, flagEnabled: true }).needsStaffReview).toBe(true);
    expect(cp.resolvePathwayFromRecords({ profile: null, credentials: stamped, flagEnabled: true }).needsStaffReview).toBe(false);   // overseas: never flagged
  });

  it('only staff can stamp it, the name and time are set by the server, and a changed flag withdraws it', () => {
    expect(gc.sanitiseCredentialsPatch({ flags_reviewed_at: NOW, flags_reviewed_by: 'me' }, { source: 'self' }).rejected.sort()).toEqual(['flags_reviewed_at', 'flags_reviewed_by']);
    const stamp = gc.sanitiseCredentialsPatch({ flags_reviewed_at: '2001-01-01T00:00:00.000Z', flags_reviewed_by: 'someone.else@gplink-test.local' }, { source: 'staff', actor: STAFF, now: NOW });
    expect(stamp.clean).toEqual({ flags_reviewed_at: NOW, flags_reviewed_by: STAFF });
    expect(gc.sanitiseCredentialsPatch({ flags_reviewed_at: NOW }, { source: 'staff', actor: '' }).clean).toEqual({});
    expect(gc.sanitiseCredentialsPatch({ flags_reviewed_at: null }, { source: 'staff', actor: STAFF }).clean).toEqual({ flags_reviewed_at: null, flags_reviewed_by: null });

    const existing = Object.assign({}, flagged, { flags_reviewed_at: NOW, flags_reviewed_by: STAFF });
    // the same flags saved again (a re-check that finds nothing new): the review stands
    expect(gc.sanitiseCredentialsPatch({ has_conditions: true, conditions_text: 'A condition (FAKE).' }, { source: 'staff', actor: STAFF, existing }).clean.flags_reviewed_at).toBeUndefined();
    // a new undertaking, or a changed condition, by staff or by the doctor: looked at again
    expect(gc.sanitiseCredentialsPatch({ has_undertakings: true }, { source: 'staff', actor: STAFF, existing }).clean).toMatchObject({ flags_reviewed_at: null, flags_reviewed_by: null });
    expect(gc.sanitiseCredentialsPatch({ conditions_text: 'A different condition (FAKE).' }, { source: 'self', existing }).clean).toMatchObject({ flags_reviewed_at: null, flags_reviewed_by: null });
    // nothing is written about the stamp when there was none (a database without the column never sees it named)
    const noStamp = gc.sanitiseCredentialsPatch({ has_undertakings: true }, { source: 'staff', actor: STAFF, existing: flagged });
    expect(Object.keys(noStamp.clean)).not.toContain('flags_reviewed_at');
    // the WP-02 column inventory is unchanged (the two columns belong to the WP-08 migration)
    expect(gc.CREDENTIAL_COLUMNS).not.toContain('flags_reviewed_at');
    expect(Object.keys(gc.WP08_STAFF_ONLY_CREDENTIAL_FIELDS)).toEqual(['flags_reviewed_at', 'flags_reviewed_by']);
  });
});

describe('the WP-08 migration', () => {
  const fs = require('fs');
  const path = require('path');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/20261120130000_au_gp_wp08_role_fields.sql'), 'utf8');
  // The statements, without SQL comments and without the human-readable
  // `comment on column ... is '...'` descriptions (prose, not schema changes).
  const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
    .replace(/comment on column [\s\S]*?';/g, '');

  it('is additive, idempotent and schema-qualified', () => {
    expect(code).not.toMatch(/\bdrop\b|\brename\b|\bupdate\s+public|\bdelete\b|\btruncate\b|\bnot null\b|\bdefault\b/i);
    // no transaction control (production runs migrations through exec_sql);
    // the `begin` of a `do $$ begin ... end $$` block is not one.
    expect(code).not.toMatch(/^\s*(begin|commit|rollback)\s*;/im);
    expect((code.match(/add column if not exists/g) || []).length).toBe(11);
    expect(code).not.toMatch(/alter table (?!public\.)/);
    expect((code.match(/pg_catalog\.pg_constraint/g) || []).length).toBe(4);
    expect((code.match(/\) not valid;/g) || []).length).toBe(4);
    expect((code.match(/validate constraint/g) || []).length).toBe(4);
  });
  it('adds exactly the documented columns and does not touch the existing DPA boolean', () => {
    for (const col of ['vr_requirement text', 'accepts_registrars boolean', 'accepts_supervised boolean', 'engagement_type text', 'sessions_min numeric(4,1)', 'sessions_max numeric(4,1)', 'special_interests text[]', 'dpa_status text', 'preferred_locations text[]', 'flags_reviewed_at timestamptz', 'flags_reviewed_by text']) {
      expect(code, col).toContain('add column if not exists ' + col);
    }
    expect(code).not.toMatch(/column if not exists dpa\b/);
    expect(code).not.toMatch(/billing_model|\bmmm\b/);          // reused, not duplicated
    expect(code).toContain("check (engagement_type is null or engagement_type in ('permanent', 'contract'))");
    expect(code).not.toMatch(/locum/i);
    expect(sql).toMatch(/Rollback/);
  });
});

describe('the Careers holding state (pages/career.html) and the job editor section', () => {
  const fs = require('fs');
  const path = require('path');
  const career = fs.readFileSync(path.join(__dirname, '..', 'pages/career.html'), 'utf8');
  const jobsJs = fs.readFileSync(path.join(__dirname, '..', 'js/ceo-ats-jobs.js'), 'utf8');

  it('a held doctor is shown the honest message and no empty-filter message; nobody else reaches that code', () => {
    const blocks = career.split('AU-HOLD:START').slice(1).map((b) => b.split('AU-HOLD:END')[0]);
    expect(blocks.length).toBe(2);
    const text = blocks.join('\n');
    expect(text).toContain('if (payload.auHold && payload.auHold.held === true) {');
    expect(text).toContain('writeCachedCareerRoles([]);');
    expect(text).toContain('"Our team is confirming your details and will be in touch by email."');
    expect(text).toContain('html[data-au-hold="true"] #rolesEmptyState, html[data-au-hold="true"] #recommendedRoles { display: none !important; }');
    expect(re.AU_FORBIDDEN_WORDS.test(text)).toBe(false);
    expect(text).not.toContain('/api/career/apply');
  });

  it('the job editor draws the role fields only when the server sends them (switch on) and offers no locum', () => {
    expect(jobsJs).toContain('auRoleFieldsSection(e.au_role_fields, e.au_intake)'); // WP-23 added the practice's own answers above the fields
    expect(jobsJs).toContain("if (!f) return '';");
    expect(jobsJs).toContain('auCollectRoleFields(body, o);');
    expect(jobsJs).toContain("if (!f || !el('atsJsVrReq')) return;");
    const section = jobsJs.slice(jobsJs.indexOf('var AU_VR_REQ_OPTS'), jobsJs.indexOf('function auCollectRoleFields'));
    expect(section).not.toMatch(/locum/i);
    for (const v of ['vr_required', 'vr_preferred', 'non_vr_accepted', 'permanent', 'contract', "'unknown'"]) expect(section, v).toContain(v);
  });
});

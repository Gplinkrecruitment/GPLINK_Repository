// WP-02 of the Australian GP build: the pure pathway rules
// (lib/candidate-pathway.js) and the credentials cleaners / Ahpra read rule
// (lib/gp-credentials.js). No server, no database.
//
// Acceptance covered here: all six pathways plus null and garbage values, the
// switch off, EVERY 19AB combination (the fail-closed cases spelled out),
// condition / undertaking / notation flags, and the standard fixtures.
import { describe, it, expect } from 'vitest';

const cp = require('../lib/candidate-pathway.js');
const gc = require('../lib/gp-credentials.js');
const { buildAuDoctor, AU_DOCTOR_KINDS, STAFF_EMAIL, FIXED_NOW } = require('./helpers/au-fixtures.js');

const SIX = ['overseas_esp', 'overseas_pep', 'au_vr', 'au_restricted', 'au_non_vr', 'au_registrar'];
const GARBAGE = [null, undefined, '', '   ', 'AU', 'australia', 'au', 'au_vr_extra', 'vr', 'overseas', 0, 1, true, false, {}, [], ['au_vr'], { pathway: 'au_vr' }, NaN, 'null', 'undefined'];

const profileFor = (pathway, extra) => Object.assign({
  candidate_pathway: pathway, candidate_basis: null,
  pathway_set_by: 'self', pathway_set_at: FIXED_NOW, pathway_confirmed_at: null, pathway_confirmed_by: null
}, extra || {});
const staffConfirmed = (value) => ({
  moratorium_19ab_confirmed_status: value, moratorium_19ab_confirmed_by: STAFF_EMAIL, moratorium_19ab_confirmed_at: FIXED_NOW
});

describe('pathway values and segments', () => {
  it('there are exactly six pathways: two overseas, four Australian', () => {
    expect(cp.ALL_PATHWAYS.slice().sort()).toEqual(SIX.slice().sort());
    expect(cp.OVERSEAS_PATHWAYS).toEqual(['overseas_esp', 'overseas_pep']);
    expect(cp.AU_PATHWAYS).toEqual(['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar']);
    expect(cp.ALL_BASES).toEqual(['overseas', 'australia']);
    expect(cp.DEFAULT_PATHWAY).toBe('overseas_esp');
  });

  it('segmentOf maps each pathway to overseas / A / B / C', () => {
    expect(cp.segmentOf('overseas_esp')).toBe('overseas');
    expect(cp.segmentOf('overseas_pep')).toBe('overseas');
    expect(cp.segmentOf('au_vr')).toBe('A');
    expect(cp.segmentOf('au_restricted')).toBe('B');
    expect(cp.segmentOf('au_non_vr')).toBe('C');
    expect(cp.segmentOf('au_registrar')).toBe('C');
  });

  it('only au_vr is a launched Australian pathway (owner decision 1)', () => {
    expect(SIX.filter((p) => cp.isLaunchedAuPathway(p))).toEqual(['au_vr']);
  });

  it('normalisePathway keeps the six values (trimmed, any case) and nothing else', () => {
    SIX.forEach((p) => {
      expect(cp.normalisePathway(p)).toBe(p);
      expect(cp.normalisePathway('  ' + p.toUpperCase() + ' ')).toBe(p);
    });
  });

  it('null, empty and garbage ALWAYS become overseas_esp, never an Australian value', () => {
    GARBAGE.forEach((g) => {
      expect(cp.normalisePathway(g)).toBe('overseas_esp');
      expect(cp.isAuPathway(g)).toBe(false);
      expect(cp.isOverseasPathway(g)).toBe(true);
      expect(cp.segmentOf(g)).toBe('overseas');
      expect(cp.isLaunchedAuPathway(g)).toBe(false);
      expect(cp.isValidPathway(g)).toBe(false);
    });
  });

  it('isAuPathway and isOverseasPathway are exact opposites for every value', () => {
    SIX.concat(GARBAGE).forEach((v) => expect(cp.isOverseasPathway(v)).toBe(!cp.isAuPathway(v)));
    expect(SIX.filter((p) => cp.isAuPathway(p))).toEqual(cp.AU_PATHWAYS.slice());
  });
});

describe('resolvePathwayFromRecords: the six pathways, switch on', () => {
  it('overseas_esp', () => {
    const r = cp.resolvePathwayFromRecords({ profile: profileFor('overseas_esp'), credentials: null, flagEnabled: true, legacyDpaExempt: false });
    expect(r).toMatchObject({ pathway: 'overseas_esp', basis: 'overseas', segment: 'overseas', isAu: false, launched: true, needsStaffReview: false, recorded: true, dpaRestricted: true });
  });
  it('overseas_pep', () => {
    const r = cp.resolvePathwayFromRecords({ profile: profileFor('overseas_pep'), credentials: null, flagEnabled: true, legacyDpaExempt: false });
    expect(r).toMatchObject({ pathway: 'overseas_pep', basis: 'overseas', segment: 'overseas', isAu: false, launched: true, needsStaffReview: false });
  });
  it('au_vr', () => {
    const r = cp.resolvePathwayFromRecords({ profile: profileFor('au_vr'), credentials: null, flagEnabled: true });
    expect(r).toMatchObject({ pathway: 'au_vr', basis: 'australia', segment: 'A', isAu: true, launched: true, dpaRestricted: true });
  });
  it('au_restricted', () => {
    const r = cp.resolvePathwayFromRecords({ profile: profileFor('au_restricted'), credentials: null, flagEnabled: true });
    expect(r).toMatchObject({ pathway: 'au_restricted', basis: 'australia', segment: 'B', isAu: true, launched: false, needsStaffReview: true, dpaRestricted: true });
  });
  it('au_non_vr', () => {
    const r = cp.resolvePathwayFromRecords({ profile: profileFor('au_non_vr'), credentials: null, flagEnabled: true });
    expect(r).toMatchObject({ pathway: 'au_non_vr', basis: 'australia', segment: 'C', isAu: true, launched: false, needsStaffReview: true, dpaRestricted: true });
  });
  it('au_registrar', () => {
    const r = cp.resolvePathwayFromRecords({ profile: profileFor('au_registrar'), credentials: null, flagEnabled: true });
    expect(r).toMatchObject({ pathway: 'au_registrar', basis: 'australia', segment: 'C', isAu: true, launched: false, needsStaffReview: true, dpaRestricted: true });
  });

  // Changed deliberately by WP-08: an AUSTRALIAN result gained three keys
  // (what roles the doctor fits, and whether a registration flag is on file
  // and has been reviewed by a person). An OVERSEAS result is pinned to the
  // eleven keys it has always had, so nothing an existing doctor's code reads
  // has moved.
  it('the result always has the full documented shape', () => {
    const base = [
      'basis', 'confirmed', 'dpaRestricted', 'dpaRestrictedReason', 'flagEnabled', 'isAu',
      'launched', 'needsStaffReview', 'pathway', 'recorded', 'segment'
    ];
    const r = cp.resolvePathwayFromRecords({ profile: profileFor('au_vr'), credentials: null, flagEnabled: true });
    // WP-29 (deliberate): an AUSTRALIAN result gained eight more keys (the
    // sorting rule's answer, the hold it decides, whether the credentials were
    // read, whether non-DPA roles are open on the doctor's own word only, the
    // 19AB answer as staff know it, and whether the register check is saved).
    // The OVERSEAS result below is still pinned to its eleven keys.
    const WP29_AU_KEYS = ['checkComplete', 'credentialsRead', 'dpaSelfDeclaredOnly', 'holdKind', 'holdWhy', 'selfServiceHeld', 'sorting', 'staff19ab'];
    expect(Object.keys(r).sort()).toEqual(base.concat(['flagsReviewed', 'hasRegistrationFlags', 'roleFit'], WP29_AU_KEYS).sort());
    expect(r.roleFit).toEqual({ vr: true, registrar: false, supervised: false });
    expect(r).toMatchObject({ selfServiceHeld: false, holdKind: null, holdWhy: '', credentialsRead: true, dpaSelfDeclaredOnly: false, staff19ab: 'unconfirmed', checkComplete: false });
    expect(r.sorting).toMatchObject({ group: 'dpa_only', held: false, basis: 'self' });
    // Every Australian pathway carries the same key set, apart from roleFit.sponsorship on B.
    cp.AU_PATHWAYS.forEach((p) => {
      const each = cp.resolvePathwayFromRecords({ profile: profileFor(p), credentials: null, flagEnabled: true });
      expect(Object.keys(each).sort()).toEqual(Object.keys(r).sort());
      expect(Object.keys(each.roleFit).sort()).toEqual(p === 'au_restricted' ? ['registrar', 'sponsorship', 'supervised', 'vr'] : ['registrar', 'supervised', 'vr']);
    });
    const overseas = cp.resolvePathwayFromRecords({ profile: profileFor('overseas_esp'), credentials: null, flagEnabled: true, legacyDpaExempt: false });
    expect(Object.keys(overseas).sort()).toEqual(base);
    expect(Object.keys(cp.overseasDefault({ flagEnabled: true })).sort()).toEqual(base);
    expect(Object.keys(cp.overseasDefault({ flagEnabled: false })).sort()).toEqual(base);
  });
});

describe('resolvePathwayFromRecords: null, garbage and the switch', () => {
  const OVERSEAS = { pathway: 'overseas_esp', basis: 'overseas', segment: 'overseas', isAu: false, launched: true, confirmed: false, needsStaffReview: false, recorded: false };

  it('no profile, an empty profile and a null pathway all read as overseas_esp', () => {
    [null, undefined, {}, profileFor(null), 'nonsense', 42].forEach((profile) => {
      expect(cp.resolvePathwayFromRecords({ profile, credentials: null, flagEnabled: true })).toMatchObject(OVERSEAS);
    });
  });

  it('a garbage stored pathway reads as overseas_esp, even with a stray basis of australia', () => {
    GARBAGE.forEach((g) => {
      const r = cp.resolvePathwayFromRecords({
        profile: profileFor(g, { candidate_basis: 'australia', pathway_confirmed_at: FIXED_NOW }),
        credentials: staffConfirmed('no'), flagEnabled: true, legacyDpaExempt: false
      });
      expect(r).toMatchObject(OVERSEAS);
      // ...and credentials can never unlock non-DPA roles for a doctor who is not on an Australian pathway.
      expect(r.dpaRestricted).toBe(true);
    });
  });

  it('SWITCH OFF: always overseas_esp, whatever is stored, for every one of the six', () => {
    SIX.forEach((p) => {
      const r = cp.resolvePathwayFromRecords({
        profile: profileFor(p, { candidate_basis: 'australia', pathway_confirmed_at: FIXED_NOW }),
        credentials: Object.assign({ has_conditions: true }, staffConfirmed('no')),
        flagEnabled: false, legacyDpaExempt: false
      });
      expect(r).toMatchObject(Object.assign({}, OVERSEAS, { flagEnabled: false, dpaRestricted: true, dpaRestrictedReason: 'legacy_country_restricted' }));
    });
  });

  it('SWITCH OFF: the DPA answer is exactly the country answer the caller passes in', () => {
    const stored = { profile: profileFor('au_restricted'), credentials: { moratorium_19ab_status: 'yes' }, flagEnabled: false };
    expect(cp.resolvePathwayFromRecords(Object.assign({ legacyDpaExempt: true }, stored)).dpaRestricted).toBe(false);
    expect(cp.resolvePathwayFromRecords(Object.assign({ legacyDpaExempt: false }, stored)).dpaRestricted).toBe(true);
    expect(cp.resolvePathwayFromRecords(stored).dpaRestricted).toBe(true);
  });

  it('when the switch is not passed it is read from the environment at call time', () => {
    const before = process.env.AU_PATHWAY_ENABLED;
    try {
      process.env.AU_PATHWAY_ENABLED = 'false';
      expect(cp.resolvePathwayFromRecords({ profile: profileFor('au_vr') }).pathway).toBe('overseas_esp');
      process.env.AU_PATHWAY_ENABLED = 'true';
      expect(cp.resolvePathwayFromRecords({ profile: profileFor('au_vr') }).pathway).toBe('au_vr');
    } finally {
      if (before === undefined) delete process.env.AU_PATHWAY_ENABLED; else process.env.AU_PATHWAY_ENABLED = before;
    }
  });

  it('overseasDefault is the switch-off / nothing-recorded answer', () => {
    expect(cp.overseasDefault()).toMatchObject(Object.assign({}, OVERSEAS, { flagEnabled: false, dpaRestricted: true }));
    expect(cp.overseasDefault({ legacyDpaExempt: true }).dpaRestricted).toBe(false);
  });

  it('basis: a valid stored basis is kept; otherwise it follows the pathway', () => {
    expect(cp.resolvePathwayFromRecords({ profile: profileFor('au_restricted', { candidate_basis: 'overseas' }), flagEnabled: true }).basis).toBe('overseas');
    expect(cp.resolvePathwayFromRecords({ profile: profileFor('au_vr', { candidate_basis: 'mars' }), flagEnabled: true }).basis).toBe('australia');
    expect(cp.resolvePathwayFromRecords({ profile: profileFor('overseas_pep', { candidate_basis: null }), flagEnabled: true }).basis).toBe('overseas');
  });
});

describe('computeDpaRestricted: overseas pathways reproduce today exactly', () => {
  ['overseas_esp', 'overseas_pep', null, 'garbage'].forEach((p) => {
    it(String(p) + ': the caller\'s country answer decides, credentials are ignored', () => {
      const creds = Object.assign({ moratorium_19ab_status: 'no' }, staffConfirmed('no'));
      expect(cp.computeDpaRestricted({ pathway: p, credentials: creds, legacyDpaExempt: true })).toEqual({ dpaRestricted: false, reason: 'legacy_country_exempt' });
      expect(cp.computeDpaRestricted({ pathway: p, credentials: creds, legacyDpaExempt: false })).toEqual({ dpaRestricted: true, reason: 'legacy_country_restricted' });
      // Not told: the same legally-safe default _resolveGpJobsProfile uses.
      expect(cp.computeDpaRestricted({ pathway: p, credentials: creds })).toEqual({ dpaRestricted: true, reason: 'legacy_unknown' });
      // A staff 19AB "applies" does not restrict an overseas doctor the country test exempts: nothing changes for them.
      expect(cp.computeDpaRestricted({ pathway: p, credentials: staffConfirmed('yes'), legacyDpaExempt: true }).dpaRestricted).toBe(false);
    });
  });
});

describe('computeDpaRestricted: every 19AB combination on the Australian pathways', () => {
  const SELF = [null, undefined, '', 'unsure', 'no', 'yes', 'garbage'];
  const STAFF = [null, 'no', 'yes'];

  cp.AU_PATHWAYS.forEach((pathway) => {
    SELF.forEach((self) => {
      STAFF.forEach((staff) => {
        // WP-29 (deliberate): a staff answer still wins both ways. With no staff
        // answer, the doctor's own "no" now opens non-DPA roles FOR THE DOCTOR'S
        // OWN VIEW. The one exception is au_restricted with nothing else on the
        // row: nothing on file explains the restriction, so a person is needed
        // and the doctor stays limited to DPA roles. "yes", "unsure", blank and
        // garbage still fail closed on every pathway.
        const expectedOpen = staff === 'no' || (!staff && self === 'no' && pathway !== 'au_restricted');
        it(pathway +' | doctor says ' + JSON.stringify(self) + ' | staff confirmed ' + JSON.stringify(staff) + ' -> ' + (expectedOpen ? 'NOT restricted' : 'restricted'), () => {
          const credentials = Object.assign({ moratorium_19ab_status: self }, staff ? staffConfirmed(staff) : {});
          // legacyDpaExempt: true is passed on purpose: "trained in Australia" must never unlock a moratorium doctor.
          const r = cp.computeDpaRestricted({ pathway, credentials, legacyDpaExempt: true });
          expect(r.dpaRestricted).toBe(!expectedOpen);
        });
      });
    });
  });

  it('FAIL CLOSED: no credentials row at all -> restricted, for every Australian pathway', () => {
    cp.AU_PATHWAYS.forEach((pathway) => {
      [null, undefined, {}, 'junk'].forEach((credentials) => {
        expect(cp.computeDpaRestricted({ pathway, credentials, legacyDpaExempt: true })).toEqual({ dpaRestricted: true, reason: '19ab_unknown' });
      });
    });
  });

  // WP-29 (deliberate): was "the doctor's own 'no' is not enough until staff
  // confirm it" (restricted on every pathway). The owner changed the rule: the
  // doctor's own "no" now counts for what the DOCTOR sees, and is marked as
  // their own word only (`selfDeclaredOnly`), so nothing that reaches a
  // practice may rest on it. What still fails closed is pinned here too.
  it('the doctor\'s own "no" opens non-DPA roles for their own view only, marked self-declared; it still fails closed for a temporary resident and an unexplained restriction', () => {
    ['au_vr', 'au_non_vr', 'au_registrar'].forEach((pathway) => {
      expect(cp.computeDpaRestricted({ pathway, credentials: { moratorium_19ab_status: 'no' } }))
        .toEqual({ dpaRestricted: false, reason: 'self_declared_no_awaiting_staff_confirmation', selfDeclaredOnly: true });
      const r = cp.resolvePathwayFromRecords({ profile: profileFor(pathway), credentials: { moratorium_19ab_status: 'no' }, flagEnabled: true });
      expect(r).toMatchObject({ dpaRestricted: false, dpaRestrictedReason: 'self_declared_no_awaiting_staff_confirmation', dpaSelfDeclaredOnly: true, staff19ab: 'unconfirmed' });
    });
    // au_restricted with nothing on file that explains the restriction: a person has to look. DPA roles only.
    expect(cp.computeDpaRestricted({ pathway: 'au_restricted', credentials: { moratorium_19ab_status: 'no' } }))
      .toEqual({ dpaRestricted: true, reason: 'needs_person' });
    // A temporary resident is restricted even when they say "no", on every Australian pathway...
    cp.AU_PATHWAYS.forEach((pathway) => {
      expect(cp.computeDpaRestricted({ pathway, credentials: { moratorium_19ab_status: 'no', work_rights: 'visa' } }))
        .toEqual({ dpaRestricted: true, reason: 'temporary_resident' });
      const r = cp.resolvePathwayFromRecords({ profile: profileFor(pathway), credentials: { moratorium_19ab_status: 'no', work_rights: 'visa' }, flagEnabled: true });
      expect(r).toMatchObject({ dpaRestricted: true, dpaRestrictedReason: 'temporary_resident', dpaSelfDeclaredOnly: false });
      // ...unless staff confirmed "no".
      expect(cp.computeDpaRestricted({ pathway, credentials: Object.assign({ moratorium_19ab_status: 'no', work_rights: 'visa' }, staffConfirmed('no')) }))
        .toEqual({ dpaRestricted: false, reason: 'staff_confirmed_19ab_not_applicable' });
    });
    // A staff-confirmed answer is never "self-declared only".
    expect(cp.resolvePathwayFromRecords({ profile: profileFor('au_vr'), credentials: Object.assign({ moratorium_19ab_status: 'no' }, staffConfirmed('no')), flagEnabled: true }))
      .toMatchObject({ dpaRestricted: false, dpaSelfDeclaredOnly: false, staff19ab: 'not_applicable' });
  });

  it('FAIL CLOSED: "unsure" and blank are restricted', () => {
    ['unsure', null, '', 'maybe'].forEach((v) => {
      expect(cp.computeDpaRestricted({ pathway: 'au_vr', credentials: { moratorium_19ab_status: v } }))
        .toEqual({ dpaRestricted: true, reason: '19ab_unknown' });
    });
  });

  it('the doctor saying it applies is restricted', () => {
    expect(cp.computeDpaRestricted({ pathway: 'au_vr', credentials: { moratorium_19ab_status: 'yes' } }))
      .toEqual({ dpaRestricted: true, reason: 'self_declared_19ab_applies' });
  });

  // WP-29 (deliberate): no longer "the ONE way" (the doctor's own "no" also
  // opens their own view, see above). It is still the only STAFF-backed way,
  // and the only one whose reason says so.
  it('au_vr with a staff-confirmed "no" is unrestricted on staff\'s word (the only answer that is not "self-declared only")', () => {
    expect(cp.computeDpaRestricted({ pathway: 'au_vr', credentials: Object.assign({ moratorium_19ab_status: 'no' }, staffConfirmed('no')) }))
      .toEqual({ dpaRestricted: false, reason: 'staff_confirmed_19ab_not_applicable' });
  });

  // WP-29 (deliberate): was "B and C are restricted unless staff have
  // explicitly confirmed". The DPA flag for C now follows the doctor's own
  // "no" too, but it opens NOTHING for them: B-not-VR and C are held (no roles,
  // no apply), which is the safety property the old assertion protected.
  it('B and C: a staff "no" lifts the DPA flag; the doctor\'s own "no" never gets a held doctor a role', () => {
    ['au_restricted', 'au_non_vr', 'au_registrar'].forEach((pathway) => {
      expect(cp.computeDpaRestricted({ pathway, credentials: staffConfirmed('no') }).dpaRestricted).toBe(false);
      const own = cp.resolvePathwayFromRecords({ profile: profileFor(pathway), credentials: { moratorium_19ab_status: 'no' }, flagEnabled: true });
      expect(own.dpaRestricted).toBe(pathway === 'au_restricted');
      expect(own.selfServiceHeld).toBe(true);
      expect(own.holdKind).toBe(pathway === 'au_registrar' ? 'registrar' : 'review');
      expect(own.launched).toBe(false);
    });
    // "unsure" / blank still restrict B and C.
    ['au_restricted', 'au_non_vr', 'au_registrar'].forEach((pathway) => {
      ['unsure', null].forEach((v) => expect(cp.computeDpaRestricted({ pathway, credentials: { moratorium_19ab_status: v } }).dpaRestricted).toBe(true));
    });
  });

  it('staff confirmation wins over the doctor\'s answer in both directions', () => {
    expect(cp.computeDpaRestricted({ pathway: 'au_vr', credentials: Object.assign({ moratorium_19ab_status: 'yes' }, staffConfirmed('no')) }).dpaRestricted).toBe(false);
    expect(cp.computeDpaRestricted({ pathway: 'au_vr', credentials: Object.assign({ moratorium_19ab_status: 'no' }, staffConfirmed('yes')) }))
      .toEqual({ dpaRestricted: true, reason: 'staff_confirmed_19ab_applies' });
  });

  it('FAIL CLOSED: a staff "no" with no name or no timestamp against it does not count', () => {
    const noName = { moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_at: FIXED_NOW, moratorium_19ab_confirmed_by: '' };
    const noTime = { moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: STAFF_EMAIL, moratorium_19ab_confirmed_at: null };
    const odd = { moratorium_19ab_confirmed_status: 'NOPE', moratorium_19ab_confirmed_by: STAFF_EMAIL, moratorium_19ab_confirmed_at: FIXED_NOW };
    [noName, noTime, odd].forEach((credentials) => {
      expect(cp.staffConfirmed19ab(credentials)).toBe(null);
      expect(cp.computeDpaRestricted({ pathway: 'au_vr', credentials }).dpaRestricted).toBe(true);
    });
  });

  it('FAIL CLOSED: a 19AB end date in the past does not lift the restriction by itself', () => {
    const credentials = { moratorium_19ab_status: 'yes', moratorium_19ab_end_date: '2020-01-01' };
    expect(cp.computeDpaRestricted({ pathway: 'au_restricted', credentials }).dpaRestricted).toBe(true);
  });

  it('FAIL CLOSED: records that could not be read force restricted, even for an exempt overseas doctor', () => {
    const r = cp.resolvePathwayFromRecords({ profile: null, credentials: null, flagEnabled: true, legacyDpaExempt: true, readFailed: true });
    expect(r).toMatchObject({ pathway: 'overseas_esp', dpaRestricted: true, dpaRestrictedReason: 'records_unreadable' });
  });
});

describe('confirmed and needsStaffReview', () => {
  const confirmedProfile = (p) => profileFor(p, { pathway_set_by: STAFF_EMAIL, pathway_confirmed_at: FIXED_NOW, pathway_confirmed_by: STAFF_EMAIL });
  const clean = { has_conditions: false, has_undertakings: false, has_notations: false };

  it('a staff-confirmed au_vr with clean registration does not need review', () => {
    const r = cp.resolvePathwayFromRecords({ profile: confirmedProfile('au_vr'), credentials: clean, flagEnabled: true });
    expect(r.confirmed).toBe(true);
    expect(r.needsStaffReview).toBe(false);
  });

  it('a self-declared (unconfirmed) Australian pathway needs review', () => {
    const r = cp.resolvePathwayFromRecords({ profile: profileFor('au_vr'), credentials: clean, flagEnabled: true });
    expect(r.confirmed).toBe(false);
    expect(r.needsStaffReview).toBe(true);
  });

  it('B and C always need review, confirmed or not', () => {
    ['au_restricted', 'au_non_vr', 'au_registrar'].forEach((p) => {
      expect(cp.resolvePathwayFromRecords({ profile: confirmedProfile(p), credentials: clean, flagEnabled: true }).needsStaffReview).toBe(true);
      expect(cp.resolvePathwayFromRecords({ profile: profileFor(p), credentials: clean, flagEnabled: true }).needsStaffReview).toBe(true);
    });
  });

  ['has_conditions', 'has_undertakings', 'has_notations'].forEach((flag) => {
    it('a flagged ' + flag.replace('has_', '') + ' needs review even on a confirmed au_vr', () => {
      const credentials = Object.assign({}, clean, { [flag]: true });
      expect(cp.hasRegistrationFlags(credentials)).toBe(true);
      expect(cp.resolvePathwayFromRecords({ profile: confirmedProfile('au_vr'), credentials, flagEnabled: true }).needsStaffReview).toBe(true);
    });
  });

  it('only a real true counts as a flag', () => {
    [null, undefined, {}, { has_conditions: 'true' }, { has_conditions: 1 }, { has_conditions: null }].forEach((c) => {
      expect(cp.hasRegistrationFlags(c)).toBe(false);
    });
  });

  it('overseas doctors are NEVER flagged for review, whatever sits in credentials', () => {
    ['overseas_esp', 'overseas_pep', null].forEach((p) => {
      const r = cp.resolvePathwayFromRecords({
        profile: profileFor(p), credentials: { has_conditions: true, has_undertakings: true, has_notations: true }, flagEnabled: true
      });
      expect(r.needsStaffReview).toBe(false);
    });
  });

  it('confirmed is false when nothing is recorded, even with a stray confirmation stamp', () => {
    const r = cp.resolvePathwayFromRecords({ profile: profileFor(null, { pathway_confirmed_at: FIXED_NOW }), flagEnabled: true });
    expect(r.confirmed).toBe(false);
  });
});

describe('feeBasisFor and publicPathwayView', () => {
  it('fee basis comes from the basis; anything missing is overseas', () => {
    expect(cp.feeBasisFor(cp.resolvePathwayFromRecords({ profile: profileFor('au_vr'), flagEnabled: true }))).toBe('australia');
    expect(cp.feeBasisFor(cp.resolvePathwayFromRecords({ profile: profileFor('au_restricted', { candidate_basis: 'overseas' }), flagEnabled: true }))).toBe('overseas');
    expect(cp.feeBasisFor(cp.resolvePathwayFromRecords({ profile: profileFor('overseas_esp'), flagEnabled: true }))).toBe('overseas');
    expect(cp.feeBasisFor(cp.resolvePathwayFromRecords({ profile: profileFor('au_vr'), flagEnabled: false }))).toBe('overseas');
    [null, undefined, {}, 'x', { basis: 'AUSTRALIA ', flagEnabled: false }].forEach((v) => expect(cp.feeBasisFor(v)).toBe('overseas'));
    expect(cp.feeBasisFor({ basis: 'australia' })).toBe('australia');
  });

  it('the doctor-facing view carries only pathway, segment, isAu and launched', () => {
    const full = cp.resolvePathwayFromRecords({ profile: profileFor('au_restricted'), credentials: { moratorium_19ab_status: 'yes' }, flagEnabled: true });
    expect(cp.publicPathwayView(full)).toEqual({ pathway: 'au_restricted', segment: 'B', isAu: true, launched: false });
    expect(cp.publicPathwayView(null)).toEqual({ pathway: 'overseas_esp', segment: 'overseas', isAu: false, launched: true });
  });
});

describe('the standard fixtures resolve to what they say they are', () => {
  AU_DOCTOR_KINDS.forEach((kind) => {
    it(kind, () => {
      const d = buildAuDoctor(kind);
      const r = cp.resolvePathwayFromRecords({ profile: d.profile, credentials: d.credentials, flagEnabled: true, legacyDpaExempt: false });
      expect(r).toMatchObject(d.expected);
      // WP-29 (deliberate): who is held is now the sorting rule's answer, not
      // "every pathway but au_vr". The standard segment B doctor is a
      // vocationally registered GP, so is NOT held (DPA roles only, and only
      // from a practice offering sponsorship); C is held; overseas has no such key.
      const HOLD = {
        au_vr: { selfServiceHeld: false, holdKind: null },
        au_restricted: { selfServiceHeld: false, holdKind: null, roleFit: { vr: true, registrar: false, supervised: false, sponsorship: true } },
        au_non_vr: { selfServiceHeld: true, holdKind: 'review', holdWhy: 'non_vr' },
        au_registrar: { selfServiceHeld: true, holdKind: 'registrar', holdWhy: 'registrar' }
      };
      if (HOLD[kind]) expect(r).toMatchObject(HOLD[kind]);
      else expect('selfServiceHeld' in r || 'sorting' in r || 'holdKind' in r).toBe(false);
      // The case mirror matches the profile.
      expect(d.caseRow.pathway).toBe(d.profile.candidate_pathway);
      // With the switch off every one of them is an overseas doctor.
      expect(cp.resolvePathwayFromRecords({ profile: d.profile, credentials: d.credentials, flagEnabled: false }).pathway).toBe('overseas_esp');
    });
  });

  it('fixture overrides work (self-declared au_vr; au_vr without the staff 19AB confirmation)', () => {
    const selfDeclared = buildAuDoctor('au_vr', { selfDeclared: true });
    expect(cp.resolvePathwayFromRecords({ profile: selfDeclared.profile, credentials: selfDeclared.credentials, flagEnabled: true }))
      .toMatchObject({ confirmed: false, needsStaffReview: true });
    const unconfirmed19ab = buildAuDoctor('au_vr', { credentials: { moratorium_19ab_confirmed_status: null, moratorium_19ab_confirmed_by: null, moratorium_19ab_confirmed_at: null } });
    // WP-29 (deliberate): this fixture's own answer is "no", so without the
    // staff confirmation the doctor's view is now open, but only on their own
    // word (which the introduction step refuses to rely on).
    expect(cp.resolvePathwayFromRecords({ profile: unconfirmed19ab.profile, credentials: unconfirmed19ab.credentials, flagEnabled: true }))
      .toMatchObject({ dpaRestricted: false, dpaRestrictedReason: 'self_declared_no_awaiting_staff_confirmation', dpaSelfDeclaredOnly: true, staff19ab: 'unconfirmed' });
    // The same doctor answering "unsure" (or nothing) is still limited to DPA roles.
    ['unsure', null].forEach((own) => {
      const d = buildAuDoctor('au_vr', { credentials: { moratorium_19ab_status: own, moratorium_19ab_confirmed_status: null, moratorium_19ab_confirmed_by: null, moratorium_19ab_confirmed_at: null } });
      expect(cp.resolvePathwayFromRecords({ profile: d.profile, credentials: d.credentials, flagEnabled: true }))
        .toMatchObject({ dpaRestricted: true, dpaRestrictedReason: '19ab_unknown', dpaSelfDeclaredOnly: false });
    });
  });
});

describe('sanitiseCredentialsPatch', () => {
  const NOW = '2026-11-20T03:00:00.000Z';

  it('keeps known columns, normalises values and stamps self_declared_at for a doctor', () => {
    const { clean, rejected } = gc.sanitiseCredentialsPatch({
      ahpra_number: ' med 0001234567 ', ahpra_registration_type: 'Specialist', specialist_gp: true,
      has_conditions: false, conditions_text: '  none  ', registration_expiry: '2027-09-30',
      fellowship_type: 'FRACGP', fellowship_year: '2015', vr_status: 'vr',
      moratorium_19ab_status: 'No', moratorium_19ab_end_date: null,
      work_rights: 'PR', visa_subclass: '482', visa_sponsor_tied: false, supervision_level: 'level_1',
      indemnity_provider: 'Test Indemnity (FAKE)', indemnity_expiry: '2027-06-30'
    }, { source: 'self', now: NOW });
    expect(rejected).toEqual([]);
    expect(clean).toMatchObject({
      ahpra_number: 'MED0001234567', ahpra_registration_type: 'specialist', specialist_gp: true,
      has_conditions: false, conditions_text: 'none', registration_expiry: '2027-09-30',
      fellowship_type: 'fracgp', fellowship_year: 2015, vr_status: 'vr',
      moratorium_19ab_status: 'no', moratorium_19ab_end_date: null,
      work_rights: 'pr', visa_subclass: '482', visa_sponsor_tied: false, supervision_level: 'level_1',
      self_declared_at: NOW
    });
  });

  it('a doctor can NEVER write a staff-only column or an unknown one', () => {
    const { clean, rejected } = gc.sanitiseCredentialsPatch({
      moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: 'me', moratorium_19ab_confirmed_at: NOW,
      staff_verified_at: NOW, staff_verified_by: 'me', ahpra_last_checked_at: NOW, ahpra_last_checked_by: 'me',
      user_id: 'someone-else', candidate_pathway: 'au_vr', created_at: NOW, __proto__x: 1
    }, { source: 'self', now: NOW, existing: { moratorium_19ab_status: 'no' } });
    expect(clean).toEqual({});
    expect(rejected).toEqual(expect.arrayContaining([
      'moratorium_19ab_confirmed_status', 'moratorium_19ab_confirmed_by', 'moratorium_19ab_confirmed_at',
      'staff_verified_at', 'staff_verified_by', 'ahpra_last_checked_at', 'ahpra_last_checked_by',
      'user_id', 'candidate_pathway', 'created_at'
    ]));
  });

  it('wrong-shaped values are rejected, not stored', () => {
    const { clean, rejected } = gc.sanitiseCredentialsPatch({
      ahpra_number: '12345', registration_expiry: '30/09/2027', visa_expiry: '2027-02-30', fellowship_year: 1066,
      specialist_gp: 'yes', has_conditions: 1, vr_status: 'maybe', work_rights: 'tourist',
      moratorium_19ab_status: 'perhaps', ahpra_registration_type: 'honorary', fellowship_type: 'frcs', supervision_level: 'level_9'
    }, { source: 'self', now: NOW });
    expect(clean).toEqual({});
    expect(rejected.length).toBe(12);
  });

  it('null clears a field', () => {
    const { clean } = gc.sanitiseCredentialsPatch({ visa_subclass: null, visa_expiry: null, specialist_gp: null }, { source: 'self', now: NOW });
    expect(clean).toMatchObject({ visa_subclass: null, visa_expiry: null, specialist_gp: null });
  });

  it('FAIL CLOSED: a doctor CHANGING their 19AB answer clears the staff confirmation', () => {
    const existing = Object.assign({ moratorium_19ab_status: 'no', moratorium_19ab_end_date: null }, {
      moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: STAFF_EMAIL, moratorium_19ab_confirmed_at: FIXED_NOW
    });
    const changed = gc.sanitiseCredentialsPatch({ moratorium_19ab_status: 'unsure' }, { source: 'self', now: NOW, existing }).clean;
    expect(changed).toMatchObject({ moratorium_19ab_status: 'unsure', moratorium_19ab_confirmed_status: null, moratorium_19ab_confirmed_by: null, moratorium_19ab_confirmed_at: null });
    const dateChanged = gc.sanitiseCredentialsPatch({ moratorium_19ab_end_date: '2030-01-01' }, { source: 'self', now: NOW, existing }).clean;
    expect(dateChanged.moratorium_19ab_confirmed_status).toBe(null);
    // Re-sending the same answer leaves the confirmation alone.
    const same = gc.sanitiseCredentialsPatch({ moratorium_19ab_status: 'no', moratorium_19ab_end_date: null }, { source: 'self', now: NOW, existing }).clean;
    expect(Object.prototype.hasOwnProperty.call(same, 'moratorium_19ab_confirmed_status')).toBe(false);
    // With no stored row to compare against, it is treated as a change.
    const unknown = gc.sanitiseCredentialsPatch({ moratorium_19ab_status: 'no' }, { source: 'self', now: NOW }).clean;
    expect(unknown.moratorium_19ab_confirmed_status).toBe(null);
    // WP-29 (deliberate): a staff finding that 19AB APPLIES is no longer
    // withdrawn by the doctor changing their own answer (their word now counts
    // for their own view, so clearing a staff "yes" would let them widen it).
    const staffYes = Object.assign({}, existing, { moratorium_19ab_status: 'yes', moratorium_19ab_confirmed_status: 'yes' });
    const widened = gc.sanitiseCredentialsPatch({ moratorium_19ab_status: 'no' }, { source: 'self', now: NOW, existing: staffYes }).clean;
    expect(widened.moratorium_19ab_status).toBe('no');
    ['moratorium_19ab_confirmed_status', 'moratorium_19ab_confirmed_by', 'moratorium_19ab_confirmed_at'].forEach((k) => {
      expect(Object.prototype.hasOwnProperty.call(widened, k)).toBe(false);
    });
    expect(cp.computeDpaRestricted({ pathway: 'au_vr', credentials: Object.assign({}, staffYes, widened) }))
      .toEqual({ dpaRestricted: true, reason: 'staff_confirmed_19ab_applies' });
  });

  it('staff: a 19AB confirmation always carries who and when; clearing it clears all three', () => {
    const set = gc.sanitiseCredentialsPatch({ moratorium_19ab_confirmed_status: 'NO' }, { source: 'staff', actor: STAFF_EMAIL, now: NOW });
    expect(set.rejected).toEqual([]);
    expect(set.clean).toEqual({ moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: STAFF_EMAIL, moratorium_19ab_confirmed_at: NOW });
    const cleared = gc.sanitiseCredentialsPatch({ moratorium_19ab_confirmed_status: null }, { source: 'staff', actor: STAFF_EMAIL, now: NOW });
    expect(cleared.clean).toEqual({ moratorium_19ab_confirmed_status: null, moratorium_19ab_confirmed_by: null, moratorium_19ab_confirmed_at: null });
    // No name to put against it -> not a confirmation.
    const anonymous = gc.sanitiseCredentialsPatch({ moratorium_19ab_confirmed_status: 'no' }, { source: 'staff', now: NOW });
    expect(anonymous.clean).toEqual({});
    expect(anonymous.rejected).toContain('moratorium_19ab_confirmed_status');
    // "who" and "when" cannot be written on their own.
    const orphan = gc.sanitiseCredentialsPatch({ moratorium_19ab_confirmed_by: 'x', moratorium_19ab_confirmed_at: NOW }, { source: 'staff', actor: STAFF_EMAIL, now: NOW });
    expect(orphan.clean).toEqual({});
    // Staff edits do not stamp self_declared_at; markVerified stamps the staff pair.
    const verified = gc.sanitiseCredentialsPatch({ has_conditions: true, conditions_text: 'Test condition' }, { source: 'staff', actor: STAFF_EMAIL, now: NOW, markVerified: true });
    expect(verified.clean).toEqual({ has_conditions: true, conditions_text: 'Test condition', staff_verified_at: NOW, staff_verified_by: STAFF_EMAIL });
  });

  it('never throws on junk input', () => {
    [null, undefined, 'x', 7, [], [{ ahpra_number: 'MED0001234567' }]].forEach((p) => {
      expect(gc.sanitiseCredentialsPatch(p, { source: 'self' })).toEqual({ clean: {}, rejected: [], locked: [] });   // FR-1 (R-04): `locked` added
    });
  });
});

describe('sanitisePreferencesPatch', () => {
  it('cleans the candidate preference columns', () => {
    const { clean, rejected } = gc.sanitisePreferencesPatch({
      current_suburb: ' Test Suburb ', current_state: 'vic', current_postcode: 3000,
      current_latitude: -37.81, current_longitude: 144.96, commute_radius_km: 30,
      notice_period_weeks: '4', available_from: '2027-02-01', sessions_wanted: 7.5,
      billing_preference: 'Mixed', special_interests: ['Skin', ' Skin ', '', 'Women\'s health', 9],
      open_to_locum: false, open_to_relocate: true, timezone: 'Australia/Perth'
    });
    expect(rejected).toEqual([]);
    expect(clean).toEqual({
      current_suburb: 'Test Suburb', current_state: 'VIC', current_postcode: '3000',
      current_latitude: -37.81, current_longitude: 144.96, commute_radius_km: 30,
      notice_period_weeks: 4, available_from: '2027-02-01', sessions_wanted: 7.5,
      billing_preference: 'mixed', special_interests: ['Skin', 'Women\'s health'],
      open_to_locum: false, open_to_relocate: true, timezone: 'Australia/Perth'
    });
  });

  it('rejects bad values, unknown columns and every pathway column', () => {
    const { clean, rejected } = gc.sanitisePreferencesPatch({
      current_state: 'XYZ', current_postcode: '30', current_latitude: 500, commute_radius_km: -1, notice_period_weeks: 2.5,
      available_from: 'soon', sessions_wanted: 99, billing_preference: 'cash', timezone: 'Mars/Olympus',
      candidate_pathway: 'au_vr', candidate_basis: 'australia', pathway_confirmed_at: FIXED_NOW, email: 'x@gplink-test.local'
    });
    expect(clean).toEqual({});
    expect(rejected.length).toBe(13);
  });

  it('the preference and pathway column lists never overlap', () => {
    gc.PATHWAY_PROFILE_COLUMNS.forEach((c) => expect(gc.PREFERENCE_COLUMNS).not.toContain(c));
  });
});

describe('readAhpraRegistration: one source of truth per pathway (DAT-09)', () => {
  const credentials = buildAuDoctor('au_vr').credentials;
  const grantedCase = {
    ahpra_registration_number: 'MED0009999999', ahpra_registration_type: 'specialist',
    ahpra_registration_effective_date: '2026-08-01', ahpra_registration_expiry_date: '2027-09-30',
    ahpra_registration_granted_at: '2026-08-01T00:00:00.000Z', ahpra_registration_has_conditions: true,
    ahpra_registration_conditions: [{ text: 'Test condition' }]
  };

  it('Australian pathways read gp_credentials and nothing else', () => {
    cp.AU_PATHWAYS.forEach((pathway) => {
      const r = gc.readAhpraRegistration({ pathway, credentials, caseRow: grantedCase });
      expect(r).toMatchObject({ source: 'gp_credentials', number: 'MED0001000001', type: 'general_and_specialist', expiry: '2027-09-30', hasConditions: false, lastCheckedBy: STAFF_EMAIL });
    });
  });

  it('an Australian pathway with no credentials row does NOT fall back to the case columns', () => {
    expect(gc.readAhpraRegistration({ pathway: 'au_vr', credentials: null, caseRow: grantedCase }).source).toBe('none');
    expect(gc.readAhpraRegistration({ pathway: 'au_vr', credentials: { ahpra_number: null }, caseRow: grantedCase }).number).toBe(null);
  });

  it('overseas pathways (and unknown ones) read the case columns the grant handler wrote, never gp_credentials', () => {
    ['overseas_esp', 'overseas_pep', null, 'garbage'].forEach((pathway) => {
      const r = gc.readAhpraRegistration({ pathway, credentials, caseRow: grantedCase });
      expect(r).toMatchObject({ source: 'registration_case', number: 'MED0009999999', type: 'specialist', expiry: '2027-09-30', effectiveDate: '2026-08-01', hasConditions: true });
      expect(gc.readAhpraRegistration({ pathway, credentials, caseRow: null }).source).toBe('none');
    });
  });

  it('supervised registration types are named in one place', () => {
    expect(gc.isSupervisedRegistrationType('provisional')).toBe(true);
    expect(gc.isSupervisedRegistrationType(' Limited ')).toBe(true);
    expect(gc.isSupervisedRegistrationType('specialist')).toBe(false);
    expect(gc.isSupervisedRegistrationType(null)).toBe(false);
  });
});

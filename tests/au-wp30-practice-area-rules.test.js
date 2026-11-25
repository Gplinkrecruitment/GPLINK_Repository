// Australian GP build, WP-30: what is pinned to a practice about its area and
// how a role follows (lib/au-practice-area.js). Pure: no server, no database.
// The rule that decides what a doctor sees (lib/role-eligibility.js) is NOT
// edited by WP-30; the last block here shows a doctor's visibility flipping
// only through the three existing role fields.
import { describe, it, expect } from 'vitest';

const area = require('../lib/au-practice-area.js');
const locator = require('../lib/au-workforce-locator.js');
const re = require('../lib/role-eligibility.js');
const cp = require('../lib/candidate-pathway.js');

const STAFF = 'staff.test@gplink-test.local';
const T1 = '2026-11-26T00:00:00.000Z';
const T2 = '2026-11-27T00:00:00.000Z';
const KEY_A = locator.addressKey({ address: '2 Test Road', suburb: 'Dubbo', state: 'NSW', postcode: '2830' });
const KEY_B = locator.addressKey({ address: '1 Test Street', suburb: 'Parramatta', state: 'NSW', postcode: '2150' });

const res = (over) => Object.assign({
  ok: true, provider: 'fixture', dpaGp: 'yes', mmm: 3, mmmApproximate: false, confidence: 'exact', method: 'geocoded_address',
  classificationYear: { dpa: '2026', mmm: 2023 }, checkedAt: T1, pointUsed: { lat: -32.2569, lng: 148.6011, source: 'geocoded_address' }, catchment: 'Dubbo', warnings: []
}, over || {});
const approx = (over) => res(Object.assign({ dpaGp: 'unknown', mmmApproximate: true, confidence: 'approximate', method: 'suburb_centroid', indicative: { dpaGp: 'yes', catchment: 'Dubbo' }, warnings: ['address_not_precise'] }, over || {}));
const failed = (error) => ({ ok: false, provider: 'fixture', dpaGp: 'unknown', mmm: null, confidence: 'none', error: error || 'locator_unavailable', warnings: [] });
const ctx = (key, now) => ({ addressKey: key || KEY_A, trigger: 'test', by: 'system', now: now || T1 });
const pin = (record, result, c) => area.applyLookup(record, result, c || ctx());

describe('the status of a practice', () => {
  it('never checked: unknown', () => {
    expect(area.effective(null)).toMatchObject({ status: 'unknown', mmm: null, setBy: 'none', reason: 'never_checked', disagreement: null });
  });
  const table = [
    ['exact yes', res(), { status: 'yes', mmm: 3, mmmApprox: false, setBy: 'lookup' }, 'changed'],
    ['exact no', res({ dpaGp: 'no', mmm: 1 }), { status: 'no', mmm: 1, setBy: 'lookup' }, 'changed'],
    ['exact, but the source gave no DPA answer', res({ dpaGp: 'unknown' }), { status: 'unknown', mmm: 3, setBy: 'lookup', reason: 'source_gave_no_dpa' }, 'not_confident'],
    ['approximate: unknown, MMM approximate', approx(), { status: 'unknown', mmm: 3, mmmApprox: true, setBy: 'lookup', reason: 'address_not_precise' }, 'not_confident'],
    ['approximate that (wrongly) claims yes is still unknown', approx({ dpaGp: 'yes' }), { status: 'unknown' }, 'not_confident'],
    ['failed: unknown', failed(), { status: 'unknown', mmm: null, setBy: 'none', reason: 'lookup_failed' }, 'failed']
  ];
  for (const [name, result, want, outcome] of table) {
    it('first look-up, ' + name, () => {
      const out = pin(null, result);
      expect(out.after).toMatchObject(want);
      expect(out.outcome).toBe(outcome);
      expect(area.effective(out.record)).toEqual(out.after);
    });
  }
  it('an approximate record never reads as yes or no, whatever is stored inside it', () => {
    const rec = pin(null, approx()).record;
    rec.lookup.dpa = 'yes';
    expect(area.effective(rec).status).toBe('unknown');
  });
});

describe('a new look-up answer against what is already pinned', () => {
  const yes = pin(null, res()).record;
  it('same answer again: unchanged, and nothing about the status moves', () => {
    const again = pin(yes, res({ checkedAt: T2 }), ctx(KEY_A, T2));
    expect(again.outcome).toBe('unchanged');
    expect(again.after).toMatchObject({ status: 'yes', mmm: 3 });
    expect(again.record.lookup.checked_at).toBe(T2);
  });
  it('a different exact answer: changed (the yearly update)', () => {
    const flipped = pin(yes, res({ dpaGp: 'no', checkedAt: T2 }), ctx(KEY_A, T2));
    expect(flipped.outcome).toBe('changed');
    expect(flipped.before.status).toBe('yes');
    expect(flipped.after.status).toBe('no');
  });
  it('a new classification year is recorded', () => {
    const next = pin(yes, res({ classificationYear: { dpa: '2027', mmm: 2027 }, mmm: 4, checkedAt: T2 }), ctx(KEY_A, T2));
    expect(next.record.lookup.year).toEqual({ dpa: '2027', mmm: 2027 });
    expect(next.outcome).toBe('changed');
    expect(next.after.mmm).toBe(4);
  });
  it('a FAILED look-up for the same address leaves the earlier answer untouched', () => {
    for (const error of ['timeout', 'locator_unavailable', 'rate_limited', 'address_not_located', 'provider_off']) {
      const out = pin(yes, failed(error), ctx(KEY_A, T2));
      expect(out.outcome).toBe('failed');
      expect(out.after).toEqual(out.before);
      expect(out.record.lookup).toEqual(yes.lookup);
      expect(out.record.last_attempt).toMatchObject({ ok: false, error: error, at: T2 });
    }
  });
  it('a WEAKER answer for the same address does not replace a stronger one', () => {
    const out = pin(yes, approx({ checkedAt: T2 }), ctx(KEY_A, T2));
    expect(out.after).toMatchObject({ status: 'yes', mmm: 3, mmmApprox: false });
    expect(out.record.lookup.confidence).toBe('exact');
    expect(out.record.last_attempt).toMatchObject({ ok: true, confidence: 'approximate' });
  });
  it('the address changed and the new one cannot be checked: the old answer is NOT carried to the new place', () => {
    const out = pin(yes, failed('address_not_located'), ctx(KEY_B, T2));
    expect(out.addressChanged).toBe(true);
    expect(out.after.status).toBe('unknown');
    expect(out.record.lookup).toBe(null);
  });
  it('the address changed and only the suburb is found: unknown', () => {
    const out = pin(yes, approx({ checkedAt: T2 }), ctx(KEY_B, T2));
    expect(out.after).toMatchObject({ status: 'unknown', mmmApprox: true });
    expect(out.record.lookup.address_key).toBe(KEY_B);
  });
  it('an approximate answer is replaced by an exact one', () => {
    const start = pin(null, approx()).record;
    const out = pin(start, res({ checkedAt: T2 }), ctx(KEY_A, T2));
    expect(out.outcome).toBe('changed');
    expect(out.after).toMatchObject({ status: 'yes', mmmApprox: false });
  });
});

describe('a value a person set by hand', () => {
  const manual = (record, over) => area.applyManual(record, Object.assign({ dpa: 'no', mmm: null, reason: 'Checked on the locator website', by: STAFF, now: T1, addressKey: KEY_A }, over || {}));
  it('needs a valid value, a reason and a name', () => {
    expect(manual(null, { dpa: 'maybe' }).ok).toBe(false);
    expect(manual(null, { dpa: '' }).ok).toBe(false);
    expect(manual(null, { reason: 'x' }).ok).toBe(false);
    expect(manual(null, { reason: '' }).ok).toBe(false);
    expect(manual(null, { by: '' }).ok).toBe(false);
    expect(manual(null, { mmm: 9 }).ok).toBe(false);
    expect(manual(null, { mmm: 'MM4' }).record.manual.mmm).toBe(4);
    expect(manual(null).ok).toBe(true);
  });
  it('wins, is attributed, and the look-up is kept beside it', () => {
    const yes = pin(null, res()).record;
    const out = manual(yes);
    expect(out.after).toMatchObject({ status: 'no', setBy: 'staff', mmm: 3 });
    expect(out.record.manual).toMatchObject({ dpa: 'no', by: STAFF, at: T1, reason: 'Checked on the locator website' });
    expect(out.record.lookup.dpa).toBe('yes');
  });
  it('is NEVER overwritten by a look-up: a differing answer is a disagreement with both values and dates', () => {
    const set = manual(null).record;
    const out = pin(set, res({ checkedAt: T2 }), ctx(KEY_A, T2));
    expect(out.outcome).toBe('disagreed');
    expect(out.after.status).toBe('no');
    expect(out.after.setBy).toBe('staff');
    expect(out.after.disagreement).toEqual({
      lookup: { dpa: 'yes', mmm: 3, at: T2 },
      manual: { dpa: 'no', mmm: null, at: T1, by: STAFF }
    });
    expect(out.record.manual.dpa).toBe('no');
  });
  it('an agreeing look-up is not a disagreement', () => {
    const set = manual(null, { dpa: 'yes' }).record;
    const out = pin(set, res());
    expect(out.after.disagreement).toBe(null);
    expect(out.outcome).not.toBe('disagreed');
    // Same again: nothing moves.
    expect(pin(out.record, res()).outcome).toBe('unchanged');
  });
  it('an approximate or failed look-up is never a disagreement', () => {
    const set = manual(null).record;
    expect(pin(set, approx()).after.disagreement).toBe(null);
    expect(pin(set, failed()).after.disagreement).toBe(null);
    expect(pin(set, failed()).after.status).toBe('no');
  });
  it('a hand-set Modified Monash level that differs is a disagreement too', () => {
    const set = manual(null, { dpa: 'yes', mmm: 5 }).record;
    const out = pin(set, res());
    expect(out.after.mmm).toBe(5);
    expect(out.after.disagreement.lookup.mmm).toBe(3);
  });
  it('"not confirmed" set by hand holds against a look-up that says yes (no disagreement: the person asked for the closed answer)', () => {
    const set = manual(null, { dpa: 'unknown' }).record;
    const out = pin(set, res());
    expect(out.after.status).toBe('unknown');
  });
  it('removing it hands the practice back to the look-up', () => {
    const set = pin(manual(null).record, res()).record;
    const out = area.clearManual(set);
    expect(out.before.status).toBe('no');
    expect(out.after).toMatchObject({ status: 'yes', setBy: 'lookup', disagreement: null });
  });
});

describe('"This looks wrong" from the practice', () => {
  it('is recorded, changes no value, and keeps the last five', () => {
    let rec = pin(null, res()).record;
    for (let i = 0; i < 7; i++) rec = area.addDispute(rec, 'note ' + i + ' ' + 'x'.repeat(600), T2);
    expect(rec.disputes.length).toBe(5);
    expect(rec.disputes[4].note.length).toBe(500);
    expect(area.effective(rec).status).toBe('yes');
    expect(area.addDispute(null, 'first', T1).disputes).toEqual([{ at: T1, note: 'first' }]);
  });
});

describe('a role follows its practice: roleDecision', () => {
  const eff = (over) => Object.assign({ status: 'yes', mmm: 3, mmmApprox: false, setBy: 'lookup', checkedAt: T1 }, over || {});
  const role = (over) => Object.assign({ id: 'r1', dpa: false, dpa_status: null, mmm: '', source_payload: {} }, over || {});
  const following = (over) => role(Object.assign({ dpa: true, dpa_status: 'yes', mmm: 'MM3', source_payload: { au_area: { follows: true, status: 'yes', mmm: 3 } } }, over || {}));
  const decide = (r, t) => area.roleDecision(r, t, { source: 'practice', now: T2 });

  const table = [
    ['nothing is known about the practice: nothing happens', role({ dpa: true, dpa_status: 'yes' }), eff({ status: 'unknown', setBy: 'none', mmm: null }), 'nothing_known', null],
    ['recorded before, look-up agrees: stamped as following, status recorded', role({ dpa: true }), eff(), 'applied', { dpa_status: 'yes', dpa: true, mmm: 'MM3' }],
    ['recorded before with everything equal: in step', role({ dpa: true, dpa_status: 'yes', mmm: 'MM3' }), eff(), 'in_step', null],
    ['recorded before as NO (boolean only), look-up says yes: NOT applied, flagged', role({ dpa: false }), eff(), 'disagreement', null],
    ['recorded before as YES, look-up says no: NOT applied, flagged (an overseas doctor does not lose the role silently)', role({ dpa: true, dpa_status: 'yes' }), eff({ status: 'no', mmm: 1 }), 'disagreement', null],
    ['recorded before with a different Modified Monash level: flagged', role({ dpa: true, dpa_status: 'yes', mmm: 'MM2' }), eff(), 'disagreement', null],
    ['recorded before as unknown, look-up says yes: filled in', role({ dpa: false, dpa_status: 'unknown' }), eff(), 'applied', { dpa_status: 'yes', dpa: true, mmm: 'MM3' }],
    ['recorded before, look-up NOT confident: the recorded value is kept', role({ dpa: true, dpa_status: 'yes' }), eff({ status: 'unknown', mmmApprox: true }), 'legacy_kept', null],
    ['already following, look-up flips to no: applied', following(), eff({ status: 'no', mmm: 1 }), 'applied', { dpa_status: 'no', dpa: false, mmm: 'MM1' }],
    ['already following, practice becomes unknown (address moved): applied, the boolean is not left saying yes', following(), eff({ status: 'unknown', mmm: null }), 'applied', { dpa_status: 'unknown', dpa: false }],
    ['already following, same answer: in step, nothing written', following(), eff(), 'in_step', null],
    ['an approximate Modified Monash level is never written to the role', following({ mmm: '' , source_payload: { au_area: { follows: true } } }), eff({ mmmApprox: true }), 'in_step', null],
    ['staff set the practice by hand: recorded roles follow without a prompt', role({ dpa: true, dpa_status: 'yes' }), eff({ status: 'no', setBy: 'staff', mmm: null }), 'applied', { dpa_status: 'no', dpa: false }],
    ['staff set the practice to not confirmed: roles follow', role({ dpa: true, dpa_status: 'yes' }), eff({ status: 'unknown', setBy: 'staff', mmm: null }), 'applied', { dpa_status: 'unknown', dpa: false }]
  ];
  for (const [name, r, target, action, patch] of table) {
    it(name, () => {
      const out = decide(r, target);
      expect(out.action).toBe(action);
      expect(out.patch).toEqual(patch);
      if (action === 'applied' || action === 'in_step') expect(out.area.follows).toBe(true);
      if (action === 'disagreement') {
        expect(out.area.follows).not.toBe(true);
        expect(out.area.disagreement.kind).toBe('recorded_before');
        expect(area.disagreementWords(out.area.disagreement)).toMatch(/automatic check says/i);
      }
    });
  }
  it('a role a person set by hand is never changed; a differing answer is noted on it', () => {
    const manualRole = role({ dpa: false, dpa_status: 'no', source_payload: { au_area: area.roleManual(role(), { dpa: 'no', mmm: null, reason: 'Head office confirmed', by: STAFF, now: T1 }) } });
    const out = decide(manualRole, eff());
    expect(out.action).toBe('manual_kept');
    expect(out.patch).toBe(null);
    expect(out.area.manual).toMatchObject({ dpa: 'no', by: STAFF, reason: 'Head office confirmed' });
    expect(out.area.disagreement).toMatchObject({ kind: 'manual', lookup: { dpa: 'yes' }, recorded: { dpa: 'no' } });
    expect(decide(manualRole, eff({ status: 'no', mmm: null })).area.disagreement).toBe(null);
  });
  it('choosing "Not recorded" in the editor hands the role back', () => {
    const cleared = area.roleManual(role({ source_payload: { au_area: { manual: { dpa: 'no' }, follows: false } } }), { dpa: null });
    expect(cleared.manual).toBe(null);
    expect(cleared.follows).toBe(false);
  });
  it('running it twice changes nothing the second time', () => {
    const first = decide(role({ dpa: true }), eff());
    const after = Object.assign(role({ dpa: true }), first.patch, { source_payload: { au_area: first.area } });
    const second = decide(after, eff());
    expect(second.action).toBe('in_step');
    expect(second.patch).toBe(null);
    const strip = (a) => { const c = Object.assign({}, a); delete c.last_checked_at; return c; };
    expect(strip(second.area)).toEqual(strip(first.area));
  });
});

describe('is a role at its practice\'s address, or somewhere else?', () => {
  const practice = (over) => Object.assign({ id: 'p1', address: '2 Test Road, Dubbo NSW 2830', suburb: 'Dubbo', location_state: 'NSW', postcode: '2830', org_type: 'practice', metadata: {} }, over || {});
  const table = [
    ['same address', { address: '2 Test Road, Dubbo NSW 2830', suburb: 'Dubbo' }, practice(), 'practice'],
    ['same address typed differently', { address: '2  test road', suburb: 'DUBBO' }, practice(), 'practice'],
    ['no address on the role, same suburb', { address: '', suburb: 'Dubbo' }, practice(), 'practice'],
    ['no address and no suburb on the role', { address: '', suburb: '' }, practice(), 'practice'],
    ['a different street in the same suburb', { address: '14 Example Street', suburb: 'Dubbo' }, practice(), 'own'],
    ['a different suburb', { address: '', suburb: 'Orange' }, practice(), 'own'],
    ['the practice has no street address but the role does', { address: '14 Example Street', suburb: 'Dubbo' }, practice({ address: '' }), 'own'],
    ['a corporation stands for head office, never a clinic', { address: '2 Test Road', suburb: 'Dubbo' }, practice({ org_type: 'corporation' }), 'own'],
    ['a role with no practice record', { address: '2 Test Road', suburb: 'Dubbo' }, null, 'own'],
    ['the practice address only in its intake answers', { address: '2 Test Road', suburb: 'Dubbo' }, practice({ address: '', suburb: '', metadata: { intake: { address: '2 Test Road, Dubbo NSW 2830', suburb: 'Dubbo', state: 'NSW' } } }), 'practice']
  ];
  for (const [name, r, p, want] of table) {
    it(name, () => { expect(area.roleSite(r, p)).toBe(want); });
  }
});

describe('what the server derives for the intake (never from the browser)', () => {
  it('yes / no / not confirmed', () => {
    expect(area.intakeFieldsFor({ status: 'yes', mmm: 3 })).toEqual({ dpa: true, dpa_answer: 'yes', dpa_suggested: true, mmm: 'MM3' });
    expect(area.intakeFieldsFor({ status: 'no', mmm: 1 })).toEqual({ dpa: false, dpa_answer: 'no', dpa_suggested: false, mmm: 'MM1' });
    expect(area.intakeFieldsFor({ status: 'unknown', mmm: 3, mmmApprox: true })).toEqual({ dpa: false, dpa_answer: 'unsure', dpa_suggested: null, mmm: '' });
    expect(area.intakeFieldsFor(null)).toEqual({ dpa: false, dpa_answer: 'unsure', dpa_suggested: null, mmm: '' });
    expect(area.intakeFieldsFor({ status: 'garbage' }).dpa).toBe(false);
  });
  it('the line a practice is shown', () => {
    expect(area.practiceFinding({ status: 'yes', mmm: 3 })).toEqual({ state: 'yes', line: 'Your practice is in a Distribution Priority Area for GPs · Modified Monash 3' });
    expect(area.practiceFinding({ status: 'no', mmm: 1 })).toEqual({ state: 'no', line: 'Your practice is not in a Distribution Priority Area for GPs · Modified Monash 1' });
    expect(area.practiceFinding({ status: 'unknown', mmm: 3, mmmApprox: true })).toEqual({ state: 'unknown', line: 'We\'ll confirm your area with you' });
    expect(area.practiceFinding(null).state).toBe('unknown');
  });
});

describe('what staff are shown', () => {
  const practice = (record, over) => Object.assign({ id: 'p1', name: 'Test Regional Practice (FAKE)', address: '2 Test Road, Dubbo NSW 2830', suburb: 'Dubbo', location_state: 'NSW', postcode: '2830', dpa: true, metadata: record ? { au_area: record } : {} }, over || {});
  it('never checked', () => {
    const v = area.staffView(practice(null));
    expect(v).toMatchObject({ checked: false, status: 'unknown', label: 'DPA not confirmed', setByLabel: 'Not checked yet', recordedBefore: 'yes' });
    expect(v.consequence).toBe('Not confirmed: hidden from doctors restricted to priority areas');
  });
  it('an exact answer: labels, confidence, source, years, date, address, method', () => {
    const v = area.staffView(practice(pin(null, res()).record));
    expect(v).toMatchObject({
      checked: true, status: 'yes', label: 'In a DPA', consequence: '', mmm: 3, mmmLabel: 'Large rural town (MM 3)', setBy: 'lookup', setByLabel: 'Automatic check',
      confidence: 'exact', confidenceLabel: 'Exact (street address)', source: 'Test data (not the real locator)', year: { dpa: '2026', mmm: 2023 },
      checkedAt: T1, catchment: 'Dubbo', address: '2 Test Road, Dubbo NSW 2830', method: 'the street address, found to the building', disagreement: null
    });
    expect(v.warnings).toEqual([]);
  });
  it('approximate: not confirmed, with the consequence, the reason, and what the suburb suggests', () => {
    const v = area.staffView(practice(pin(null, approx()).record));
    expect(v).toMatchObject({ status: 'unknown', mmmLabel: 'approximately Large rural town (MM 3)', confidenceLabel: 'Approximate (not the exact building)', indicativeDpa: 'yes' });
    expect(v.consequence).toMatch(/hidden from doctors restricted to priority areas/);
    expect(v.warnings.join(' ')).toMatch(/not the building/);
  });
  it('a failed re-check says so and that the earlier answer was kept', () => {
    const v = area.staffView(practice(pin(pin(null, res()).record, failed('timeout'), ctx(KEY_A, T2)).record));
    expect(v.status).toBe('yes');
    expect(v.warnings.join(' ')).toMatch(/Last check failed: .*took too long.*earlier answer was kept/);
  });
  it('a disagreement carries both values, both dates, who, and a sentence', () => {
    const set = area.applyManual(null, { dpa: 'no', reason: 'Practice manager confirmed', by: STAFF, now: T1, addressKey: KEY_A }).record;
    const v = area.staffView(practice(pin(set, res({ checkedAt: T2 }), ctx(KEY_A, T2)).record));
    expect(v.status).toBe('no');
    expect(v.setByLabel).toBe('Set by hand by ' + STAFF);
    expect(v.manual).toMatchObject({ dpa: 'no', reason: 'Practice manager confirmed', by: STAFF, at: T1 });
    expect(v.disagreement.message).toBe('The automatic check says in a DPA; the value set by hand says not in a DPA.');
    expect(v.disagreement.lookup).toEqual({ dpa: 'yes', mmm: 3, at: T2 });
  });
  it('an address changed since the check is called out', () => {
    const rec = pin(null, res()).record;
    expect(area.staffView(practice(rec, { address: '1 Test Street', suburb: 'Parramatta', postcode: '2150' })).warnings.join(' ')).toMatch(/address has changed since the last check/);
  });
  it('a role: recorded before, following, set by hand, at its own address', () => {
    const p = practice(pin(null, res()).record);
    expect(area.staffRoleView({ dpa: true, mmm: 'MM3' }, p)).toMatchObject({ status: 'yes', label: 'In a DPA', basis: 'Recorded before the automatic check', follows: false, mmmLabel: 'Large rural town (MM 3)' });
    expect(area.staffRoleView({ dpa: true, dpa_status: 'yes', source_payload: { au_area: { follows: true, site: 'practice', checked_at: T1 } } }, p)).toMatchObject({ basis: 'Follows the practice', follows: true, confidence: 'exact' });
    expect(area.staffRoleView({ dpa: false, dpa_status: 'unknown', source_payload: { au_area: { follows: true, site: 'own' } } }, p)).toMatchObject({ status: 'unknown', basis: 'Checked on this role\'s own address', consequence: 'Not confirmed: hidden from doctors restricted to priority areas' });
    expect(area.staffRoleView({ dpa: false, dpa_status: 'no', source_payload: { au_area: { manual: { dpa: 'no', by: STAFF, reason: 'r', at: T1 } } } }, p).basis).toBe('Set by hand on this role by ' + STAFF);
  });
  it('the audit value holds no personal data', () => {
    expect(area.auditValue(area.effective(pin(null, res()).record))).toEqual({ dpa: 'yes', mmm: 3, mmm_approx: false, set_by: 'lookup' });
  });
});

describe('what a doctor sees flips ONLY through the three existing role fields (the rule itself is not edited)', () => {
  const NOW = '2026-11-20T00:00:00.000Z';
  const restricted = cp.resolvePathwayFromRecords({
    profile: { candidate_pathway: 'au_vr', candidate_basis: 'australia', pathway_set_by: STAFF, pathway_confirmed_at: NOW, pathway_confirmed_by: STAFF },
    credentials: { ahpra_registration_type: 'general', vr_status: 'vr', moratorium_19ab_status: 'yes', moratorium_19ab_confirmed_status: 'yes', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW },
    flagEnabled: true
  });
  const unrestricted = cp.resolvePathwayFromRecords({
    profile: { candidate_pathway: 'au_vr', candidate_basis: 'australia', pathway_set_by: STAFF, pathway_confirmed_at: NOW, pathway_confirmed_by: STAFF },
    credentials: { ahpra_registration_type: 'general', vr_status: 'vr', moratorium_19ab_status: 'no', moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: STAFF, moratorium_19ab_confirmed_at: NOW },
    flagEnabled: true
  });
  const overseas = cp.resolvePathwayFromRecords({ profile: null, credentials: null, flagEnabled: true });
  const base = { id: 'r1', vr_requirement: 'vr_required', accepts_registrars: false, accepts_supervised: false };
  const apply = (roleRow, target) => {
    const d = area.roleDecision(roleRow, target, { source: 'practice', now: T2 });
    return Object.assign({}, roleRow, d.patch || {}, { source_payload: { au_area: d.area } });
  };

  it('the restricted doctor is really restricted, and the others are who they should be', () => {
    expect(restricted.isAu).toBe(true);
    expect(restricted.dpaRestricted).not.toBe(false);
    expect(unrestricted.dpaRestricted).toBe(false);
    expect(overseas.isAu).toBe(false);
  });
  it('unknown -> yes -> no -> unknown, as the pinned status changes', () => {
    let role = Object.assign({}, base, { dpa: false, dpa_status: 'unknown', mmm: '', source_payload: { au_area: { follows: true } } });
    expect(re.roleEligibilityFor(restricted, role).canApply).toBe(false);
    expect(re.roleEligibilityFor(restricted, role).reasons).toContain('role_dpa_unknown');
    expect(re.roleEligibilityFor(overseas, role).canApply).toBe(false);

    role = apply(role, { status: 'yes', mmm: 3, mmmApprox: false, setBy: 'lookup', checkedAt: T1 });
    expect(role).toMatchObject({ dpa: true, dpa_status: 'yes', mmm: 'MM3' });
    expect(re.roleEligibilityFor(restricted, role).canApply).toBe(true);
    expect(re.roleEligibilityFor(overseas, role).canApply).toBe(true);
    expect(re.publicRoleFacts(role)).toMatchObject({ mmm: 3, area: 'regional', dpa: 'yes' });

    role = apply(role, { status: 'no', mmm: 1, mmmApprox: false, setBy: 'lookup', checkedAt: T2 });
    expect(role).toMatchObject({ dpa: false, dpa_status: 'no', mmm: 'MM1' });
    expect(re.roleEligibilityFor(restricted, role).canApply).toBe(false);
    expect(re.roleEligibilityFor(restricted, role).reasons).toContain('dpa_restricted');
    expect(re.roleEligibilityFor(unrestricted, role).canApply).toBe(true);
    expect(re.roleEligibilityFor(overseas, role).canApply).toBe(false);
    expect(re.publicRoleFacts(role)).toMatchObject({ mmm: 1, area: 'metro' });

    role = apply(role, { status: 'unknown', mmm: null, mmmApprox: false, setBy: 'lookup', checkedAt: T2 });
    expect(role).toMatchObject({ dpa: false, dpa_status: 'unknown' });
    expect(re.roleEligibilityFor(restricted, role).canApply).toBe(false);
    expect(re.roleEligibilityFor(unrestricted, role).canApply).toBe(true);
  });
  it('a not-confident look-up never opens a role, and never closes one that was recorded before', () => {
    const notConfident = { status: 'unknown', mmm: 3, mmmApprox: true, setBy: 'lookup', checkedAt: T1 };
    const closed = Object.assign({}, base, { dpa: false, dpa_status: 'unknown', source_payload: {} });
    expect(re.roleEligibilityFor(restricted, apply(closed, notConfident)).canApply).toBe(false);
    const open = Object.assign({}, base, { dpa: true, dpa_status: 'yes', source_payload: {} });
    const after = apply(open, notConfident);
    expect(re.roleEligibilityFor(overseas, after).canApply).toBe(true);
    expect(re.roleEligibilityFor(restricted, after).canApply).toBe(true);
  });
  it('a look-up that disagrees with a role recorded before changes nothing a doctor sees until staff decide', () => {
    const open = Object.assign({}, base, { dpa: true, dpa_status: 'yes', source_payload: {} });
    const after = apply(open, { status: 'no', mmm: 1, mmmApprox: false, setBy: 'lookup', checkedAt: T1 });
    expect(after.dpa).toBe(true);
    expect(re.roleEligibilityFor(overseas, after).canApply).toBe(true);
    expect(after.source_payload.au_area.disagreement).toBeTruthy();
  });
});

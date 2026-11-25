// Australian GP build, FR-9 (review round 12): the practice area check's rules.
// Pure: lib/au-practice-area.js, lib/au-workforce-locator.js (fixture provider
// and stand-in geocoders only: nothing here reaches a network), and
// lib/au-provider-guard.js. Every identity and address is made up.
//
//   M9-01  a label is about an address: when the address changes and the new
//          one cannot be answered exactly, the role is "not confirmed"
//   M9-05  a browser's map point is believed only when the server finds the
//          same building itself
//   M9-06  the truth about what "not confirmed" hides
//   M9-07  "Not recorded" hands the role back; a hand-set value needs a reason
//   M9-08  the practice's "This looks wrong" is an open item until a person looks
//   M9-09  what staff read once the check is switched off
//   S9-14  the made-up test provider is refused in production
import { describe, it, expect, beforeEach, vi } from 'vitest';

const area = require('../lib/au-practice-area.js');
const locator = require('../lib/au-workforce-locator.js');
const guard = require('../lib/au-provider-guard.js');

const STAFF = 'staff.test@gplink-test.local';
const T0 = '2026-11-20T00:00:00.000Z';
const T1 = '2026-11-26T00:00:00.000Z';
const OLD = locator.addressKey({ address: '2 Test Road', suburb: 'Dubbo', state: 'NSW', postcode: '2830' });
const NEW = locator.addressKey({ address: '99 Nowhere Lane', suburb: 'Parramatta', state: 'NSW', postcode: '2150' });

const TARGET = {
  exact_yes: { status: 'yes', mmm: 3, mmmApprox: false, setBy: 'lookup', checkedAt: T1 },
  exact_no: { status: 'no', mmm: 1, mmmApprox: false, setBy: 'lookup', checkedAt: T1 },
  approximate: { status: 'unknown', mmm: 3, mmmApprox: true, setBy: 'lookup', checkedAt: T1 },
  failed: { status: 'unknown', mmm: null, mmmApprox: false, setBy: 'none', checkedAt: null }
};
const AFTER = { exact_yes: 'yes', exact_no: 'no', approximate: 'unknown', failed: 'unknown' };

function roleOf(prev, source) {
  const row = { id: 'r1', dpa: prev === 'yes', dpa_status: prev, mmm: prev === 'unknown' ? null : 'MM3', source_payload: {} };
  if (source === 'lookup') row.source_payload.au_area = { follows: true, site: 'practice', status: prev, mmm: prev === 'unknown' ? null : 3, set_by: 'lookup', disagreement: null, address_key: OLD };
  if (source === 'hand') row.source_payload.au_area = { follows: false, site: 'practice', manual: { dpa: prev, mmm: prev === 'unknown' ? null : 3, reason: 'Checked on the locator', by: STAFF, at: T0, address_key: OLD }, disagreement: null, address_key: OLD };
  // 'pre': recorded before the check existed: no record at all on the role
  return row;
}
const after = (role, decision) => Object.assign({}, role, decision.patch || {});

describe('M9-01: every transition when a role\'s address changes (previous value x where it came from x the new address)', () => {
  for (const prev of ['yes', 'no', 'unknown']) {
    for (const source of ['lookup', 'hand', 'pre']) {
      for (const kind of ['exact_yes', 'exact_no', 'approximate', 'failed']) {
        it(prev + ' / ' + source + ' / new address ' + kind.replace('_', ' ') + ' -> ' + AFTER[kind], () => {
          const role = roleOf(prev, source);
          const d = area.roleDecision(role, TARGET[kind], { source: 'practice', now: T1, addressKey: NEW, addressChanged: true });
          const row = after(role, d);
          // the label is the new address's exact answer, or "not confirmed": never the old one
          expect(row.dpa_status).toBe(AFTER[kind]);
          expect(row.dpa).toBe(AFTER[kind] === 'yes');
          // an old Modified Monash level does not survive an address it was not about
          if (kind === 'exact_yes') expect(row.mmm).toBe('MM3');
          if (kind === 'exact_no') expect(row.mmm).toBe('MM1');
          if (kind === 'approximate' || kind === 'failed') expect(row.mmm == null || row.mmm === '').toBe(true);   // '' in the patch: the real column is NOT NULL
          expect(d.moved).toBe(true);
          expect(d.area).toMatchObject({ follows: true, status: AFTER[kind], address_key: NEW });
          expect(d.area.manual == null).toBe(true);
          if (source === 'hand' && prev !== AFTER[kind]) {
            // a hand-set value is never dropped silently
            expect(d.area.disagreement).toMatchObject({ kind: 'address_changed', recorded: { dpa: prev, by: STAFF }, lookup: { dpa: AFTER[kind] } });
            expect(area.disagreementWords(d.area.disagreement)).toMatch(/The address changed after staff\.test@gplink-test\.local set this role by hand/);
          } else if (source !== 'hand') {
            expect(d.area.disagreement).toBe(null);
          }
        });
      }
      it(prev + ' / ' + source + ' / same address -> stays ' + prev, () => {
        const role = roleOf(prev, source);
        // the same address, checked again: the look-up's own unchanged answer (lookup), a differing exact
        // answer (hand: kept, the difference noted), or a weak answer (recorded before: never degraded)
        const target = source === 'lookup' ? { status: prev, mmm: prev === 'unknown' ? null : 3, mmmApprox: false, setBy: 'lookup', checkedAt: T1 }
          : (source === 'hand' ? (prev === 'yes' ? TARGET.exact_no : TARGET.exact_yes) : TARGET.approximate);
        const d = area.roleDecision(role, target, { source: 'practice', now: T1, addressKey: OLD, addressChanged: false });
        expect(d.patch).toBe(null);
        expect(d.moved).toBe(false);
        expect(d.action).toBe(source === 'lookup' ? 'in_step' : (source === 'hand' ? 'manual_kept' : 'legacy_kept'));
        if (source === 'hand') {
          expect(d.area.manual).toMatchObject({ dpa: prev, by: STAFF });
          if (prev !== 'unknown') expect(d.area.disagreement).toMatchObject({ kind: 'manual' });
        }
      });
    }
  }

  it('THE REVIEWER\'S CASE: a role that followed "In a DPA", the address is corrected, the new one cannot be found -> not confirmed (it used to stay "In a DPA")', () => {
    const role = roleOf('yes', 'lookup');
    const d = area.roleDecision(role, TARGET.failed, { source: 'practice', now: T1, addressKey: NEW, addressChanged: true });
    expect(d).toMatchObject({ action: 'applied', patch: { dpa: false, dpa_status: 'unknown', mmm: '' } });
    // never null: career_roles.mmm is `text not null default ''` in the real database (the first real-server run refused the write)
    expect(d.patch.mmm).toBe('');
  });
  it('the role notices by itself: no flag from the caller, only a different address from the one it was decided for', () => {
    const d = area.roleDecision(roleOf('yes', 'lookup'), TARGET.approximate, { source: 'practice', now: T1, addressKey: NEW });
    expect(d).toMatchObject({ moved: true, action: 'applied', patch: { dpa: false, dpa_status: 'unknown' } });
    const hand = area.roleDecision(roleOf('yes', 'hand'), TARGET.failed, { source: 'practice', now: T1, addressKey: NEW });
    expect(hand).toMatchObject({ moved: true, patch: { dpa: false, dpa_status: 'unknown' } });
    expect(hand.area.disagreement.kind).toBe('address_changed');
  });
  it('a role that followed an answer and whose record has lost it (no move flagged at all) is not left saying yes', () => {
    const role = roleOf('yes', 'lookup'); delete role.source_payload.au_area.address_key;
    expect(area.roleDecision(role, TARGET.failed, { source: 'practice', now: T1 })).toMatchObject({ action: 'applied', patch: { dpa: false, dpa_status: 'unknown' } });
    // ...but a role that never followed anything (a new job at a practice nobody has checked) is left alone, as before
    expect(area.roleDecision({ id: 'r2', dpa: false, dpa_status: null, source_payload: { au_area: { follows: true } } }, TARGET.failed, { source: 'practice', now: T1 }))
      .toMatchObject({ action: 'nothing_known', patch: null });
  });
  it('a value a named person sets by hand AFTER the address change is kept', () => {
    const role = roleOf('unknown', 'lookup');
    role.source_payload.au_area = area.roleManual(role, { dpa: 'yes', mmm: 3, reason: 'Confirmed with the Department', by: STAFF, now: T1, addressKey: NEW });
    expect(role.source_payload.au_area.manual.address_key).toBe(NEW);
    const d = area.roleDecision(Object.assign(role, { dpa: true, dpa_status: 'yes' }), TARGET.failed, { source: 'practice', now: T1, addressKey: NEW, addressChanged: true });
    expect(d).toMatchObject({ action: 'manual_kept', patch: null });
    expect(d.area.manual).toMatchObject({ dpa: 'yes', by: STAFF });
  });
  it('a postcode that was only added or dropped is not a move; a different street is', () => {
    const noPostcode = locator.addressKey({ address: '2 Test Road', suburb: 'Dubbo', state: 'NSW' });
    expect(area.sameAddressKey(OLD, noPostcode)).toBe(true);
    expect(area.sameAddressKey(OLD, NEW)).toBe(false);
    expect(area.sameAddressKey(OLD, locator.addressKey({ address: '4 Test Road', suburb: 'Dubbo', state: 'NSW', postcode: '2830' }))).toBe(false);
    expect(area.roleDecision(roleOf('yes', 'lookup'), TARGET.approximate, { source: 'practice', now: T1, addressKey: noPostcode }).moved).toBe(false);
  });
  it('running it again after a move writes nothing more', () => {
    const role = roleOf('yes', 'hand');
    const first = area.roleDecision(role, TARGET.failed, { source: 'practice', now: T1, addressKey: NEW, addressChanged: true });
    const row = Object.assign(after(role, first), { source_payload: { au_area: first.area } });
    const second = area.roleDecision(row, TARGET.failed, { source: 'practice', now: T1, addressKey: NEW });
    expect(second.patch).toBe(null);
    expect(second.area).toEqual(first.area);   // the disagreement is still there for staff
  });
});

describe('M9-01: the same rule for a value set by hand on the PRACTICE', () => {
  const exact = (dpa, mmm) => ({ ok: true, dpaGp: dpa, mmm: mmm, confidence: 'exact', provider: 'fixture', method: 'geocoded_address', checkedAt: T1, warnings: [] });
  const handSet = () => area.applyManual(area.applyLookup(null, exact('no', 1), { addressKey: OLD, now: T0 }).record,
    { dpa: 'yes', mmm: 3, reason: 'Confirmed with the Department', by: STAFF, now: T0, addressKey: OLD }).record;

  it('same address: a hand-set value is never replaced, only disagreed with (unchanged)', () => {
    const r = area.applyLookup(handSet(), exact('no', 1), { addressKey: OLD, now: T1 });
    expect(r.manualDropped).toBe(false);
    expect(r.after).toMatchObject({ status: 'yes', setBy: 'staff' });
    expect(r.outcome).toBe('disagreed');
  });
  it('the address changes and the new one cannot be found: the hand-set "yes" is put aside and the practice is not confirmed', () => {
    const r = area.applyLookup(handSet(), { ok: false, error: 'address_not_located', confidence: 'none' }, { addressKey: NEW, now: T1 });
    expect(r).toMatchObject({ manualDropped: true, addressChanged: true, outcome: 'failed' });
    expect(r.record.manual).toBe(null);
    expect(r.record.stale_manual).toMatchObject({ dpa: 'yes', by: STAFF, dropped_at: T1 });
    expect(r.after).toMatchObject({ status: 'unknown', setBy: 'none', staleManual: { dpa: 'yes', by: STAFF } });
    // staff are told, on the card and on the to-do list
    const practice = { address: '99 Nowhere Lane', suburb: 'Parramatta', location_state: 'NSW', postcode: '2150', metadata: { au_area: r.record } };
    expect(area.staffView(practice).warnings.join(' ')).toMatch(/The address changed after staff\.test@gplink-test\.local set this by hand \(In a DPA, MM 3\)\. That value was for the old address, so it is no longer used\./);
    expect(area.needsPerson(practice, 0).map((n) => n.code)).toEqual(['hand_value_put_aside']);
  });
  it('the address changes and the new one is answered exactly: that answer is used; setting it by hand again clears the note', () => {
    const r = area.applyLookup(handSet(), exact('no', 1), { addressKey: NEW, now: T1 });
    expect(r.after).toMatchObject({ status: 'no', mmm: 1, setBy: 'lookup' });
    const again = area.applyManual(r.record, { dpa: 'yes', reason: 'Still applies: checked the map', by: STAFF, now: T1, addressKey: NEW });
    expect(again.record.stale_manual).toBeUndefined();
    expect(again.after).toMatchObject({ status: 'yes', setBy: 'staff' });
    expect(again.after.staleManual).toBeUndefined();
  });
  it('an address change with no answer is "not confirmed" (with what it hides), not "never checked"; a first failed check on a practice nobody had answered for is still "not checked yet"', () => {
    const answered = area.applyLookup(null, exact('yes', 3), { addressKey: OLD, now: T0 }).record;
    const moved = area.applyLookup(answered, { ok: false, error: 'address_not_located' }, { addressKey: NEW, now: T1 }).record;
    expect(moved.moved_unanswered).toBe(true);
    const row = { address: '99 Nowhere Lane', suburb: 'Parramatta', location_state: 'NSW', postcode: '2150', metadata: { au_area: moved } };
    expect(area.staffView(row)).toMatchObject({ checked: false, movedUnanswered: true, label: 'DPA not confirmed', consequence: area.UNKNOWN_CONSEQUENCE });
    // an answer for the new address clears it
    expect(area.applyLookup(moved, exact('no', 1), { addressKey: NEW, now: T1 }).record.moved_unanswered).toBeUndefined();
    expect(area.applyManual(moved, { dpa: 'yes', reason: 'Checked by phone', by: STAFF, now: T1, addressKey: NEW }).record.moved_unanswered).toBeUndefined();
    // never checked + a failed first check: unchanged from before
    const first = area.applyLookup(null, { ok: false, error: 'address_not_located' }, { addressKey: OLD, now: T1 }).record;
    expect(first.moved_unanswered).toBeUndefined();
    expect(area.staffView({ metadata: { au_area: first } })).toMatchObject({ checked: false, movedUnanswered: false, label: 'Area not checked yet', consequence: '' });
  });
  it('a record with no hand-set value is the shape it always was', () => {
    expect(Object.keys(area.effective(area.applyLookup(null, exact('yes', 3), { addressKey: OLD, now: T0 }).record)).sort())
      .toEqual(['checkedAt', 'disagreement', 'mmm', 'mmmApprox', 'reason', 'setBy', 'status']);
  });
});

describe('M9-07: the job editor', () => {
  it('"Not recorded" hands the role back: it follows, and the check\'s answer is applied (it used to be refused as "recorded before")', () => {
    const role = roleOf('no', 'hand');
    const cleared = area.roleManual(role, { dpa: null });
    expect(cleared).toMatchObject({ manual: null, follows: true, disagreement: null });
    const d = area.roleDecision(Object.assign({}, role, { dpa_status: null, source_payload: { au_area: cleared } }), TARGET.exact_yes, { source: 'practice', now: T1, addressKey: OLD });
    expect(d).toMatchObject({ action: 'applied', patch: { dpa: true, dpa_status: 'yes' } });
  });
  it('a hand-set value needs a reason of a few words', () => {
    expect(area.manualReasonError('')).toBe(area.MANUAL_REASON_NEEDED);
    expect(area.manualReasonError(undefined)).toBe(area.MANUAL_REASON_NEEDED);
    expect(area.manualReasonError('ok')).toBe(area.MANUAL_REASON_NEEDED);
    expect(area.manualReasonError('Confirmed with the practice')).toBe('');
  });
});

describe('M9-05: a map point that came from a browser', () => {
  const FIX = { AU_WORKFORCE_LOCATOR_PROVIDER: 'fixture' };
  beforeEach(() => locator._resetForTests());
  const DUBBO_POINT = { latitude: -32.25, longitude: 148.6 };

  it('T5 / T6: a street the server cannot find + a point in Dubbo (+ a made-up place id): NOT "In a DPA"; the written address decides (approximate)', async () => {
    for (const placeId of ['made-up-by-the-browser', '']) {
      const r = await locator.classifyLocation(Object.assign({ address: '99 Nowhere Lane, Dubbo, NSW, 2830', suburb: 'Dubbo', state: 'NSW', postcode: '2830', placeId }, DUBBO_POINT), { env: FIX });
      expect(r.dpaGp, 'place id ' + JSON.stringify(placeId)).toBe('unknown');
      expect(r.confidence).not.toBe('exact');
      expect(r.method).not.toBe('selected_address');
      expect(r.warnings).toContain('point_not_corroborated');
    }
  });
  it('T10: an address the server cannot find at all + a point in Dubbo + a place id: not located (it used to be "In a DPA, exact")', async () => {
    const r = await locator.classifyLocation({ address: '1 Unknown Street, Surry Hills, NSW, 2010', suburb: 'Surry Hills', state: 'NSW', postcode: '2010', latitude: -32.2491, longitude: 148.6052, placeId: 'made-up' }, { env: FIX });
    expect(r).toMatchObject({ ok: false, dpaGp: 'unknown', confidence: 'none', error: 'address_not_located' });
    expect(r.pointUsed).toBe(null);
  });
  it('a point far from the written address is refused and said so; the server\'s own point is used', async () => {
    const r = await locator.classifyLocation({ address: '1 Test Street, Parramatta NSW 2150', suburb: 'Parramatta', state: 'NSW', latitude: -32.2569, longitude: 148.6011, placeId: 'p' }, { env: FIX });
    expect(r.warnings).toContain('point_address_mismatch');
    expect(r).toMatchObject({ dpaGp: 'no', confidence: 'exact', method: 'geocoded_address' });
  });
  it('a point the server itself confirms (it finds the same building within a kilometre) is used as before', async () => {
    const r = await locator.classifyLocation({ address: '2 Test Road', suburb: 'Dubbo', state: 'NSW', latitude: -32.2569, longitude: 148.6011, placeId: 'place-1' }, { env: FIX });
    expect(r).toMatchObject({ ok: true, dpaGp: 'yes', confidence: 'exact', method: 'selected_address' });
    expect(r.warnings).toEqual([]);
  });
  it('a geocoder that only finds the STREET near the point does not make the point exact', async () => {
    const streetOnly = { name: 'street-only', street: async () => ({ lat: -32.2569, lng: 148.6011, precision: 'approximate' }), suburb: async () => null };
    const r = await locator.classifyLocation({ address: '77 Other Street', suburb: 'Dubbo', state: 'NSW', latitude: -32.257, longitude: 148.601, placeId: 'p' }, { env: FIX, geocoder: streetOnly });
    expect(r).toMatchObject({ dpaGp: 'unknown', confidence: 'approximate', method: 'street_centroid' });
  });
  it('a point a named staff member placed (recorded by the server) is still used', async () => {
    const r = await locator.classifyLocation({ address: '77 Other Street', suburb: 'Dubbo', state: 'NSW', latitude: -32.2569, longitude: 148.6011, pointSource: 'staff' }, { env: FIX });
    expect(r).toMatchObject({ dpaGp: 'yes', confidence: 'exact', method: 'selected_address' });
  });
});

describe('M9-06: the truth about "not confirmed"', () => {
  it('staff: hidden from every doctor who may only work in a priority area, overseas doctors included', () => {
    expect(area.UNKNOWN_CONSEQUENCE).toBe('Not confirmed: hidden from every doctor who may only work in a priority area (that includes doctors moving to Australia from overseas) until it is confirmed');
  });
  it('the practice: no "does not hold anything up"; what it does hold up is said', () => {
    expect(area.PRACTICE_UNKNOWN_NOTE).not.toMatch(/hold anything up/);
    expect(area.PRACTICE_UNKNOWN_NOTE).toMatch(/Until they have, your role is not shown to doctors who may only work in a priority area \(that includes doctors moving to Australia from overseas\)\. Other doctors can still see it\./);
    // the page's own copy (used only when the look-up does not answer at all) is the same sentence
    const page = require('fs').readFileSync(require('path').join(__dirname, '..', 'pages', 'practice-intake.html'), 'utf8');
    expect(page).toContain('var AU_LOC_UNKNOWN_NOTE = ' + JSON.stringify(area.PRACTICE_UNKNOWN_NOTE) + ';');
    expect(page).not.toContain('Our team will check it and confirm with you. This does not hold anything up.');
  });
  it('a not-confirmed practice WITH roles is on the to-do list; with none it hides nothing and is not', () => {
    const approx = area.applyLookup(null, { ok: true, dpaGp: 'unknown', mmm: 3, mmmApproximate: true, confidence: 'approximate', provider: 'fixture', method: 'suburb_centroid', checkedAt: T1, warnings: ['address_not_precise'] }, { addressKey: OLD, now: T1 }).record;
    const p = { address: 'Dubbo NSW 2830', suburb: 'Dubbo', location_state: 'NSW', metadata: { au_area: approx } };
    expect(area.needsPerson(p, 0)).toEqual([]);
    expect(area.needsPerson(p, 2)).toEqual([{ code: 'not_confirmed', message: 'Priority-area status not confirmed: its 2 roles are hidden from every doctor who may only work in a priority area (that includes doctors moving to Australia from overseas). Check the address and press Re-check, or set it by hand.' }]);
    expect(area.staffView(p, { roleCount: 1 }).needsPerson[0].message).toMatch(/its role is hidden/);
    // a failed look-up after an address change counts too (there is no answer, and its roles are closed)
    const failed = area.applyLookup(approx, { ok: false, error: 'address_not_located' }, { addressKey: NEW, now: T1 }).record;
    expect(area.needsPerson({ metadata: { au_area: failed } }, 1).map((n) => n.code)).toEqual(['not_confirmed']);
    // a practice nobody has ever checked is not on the list
    expect(area.needsPerson({ metadata: {} }, 3)).toEqual([]);
    // a confirmed one is not either
    const yes = area.applyLookup(null, { ok: true, dpaGp: 'yes', mmm: 3, confidence: 'exact', checkedAt: T1 }, { addressKey: OLD, now: T1 }).record;
    expect(area.needsPerson({ metadata: { au_area: yes } }, 3)).toEqual([]);
  });
});

describe('M9-08: "This looks wrong" is an open item until a named person looks', () => {
  it('open, listed with the practice\'s own words, then marked as looked at (kept on the record, attributed)', () => {
    const noted = area.addDispute(null, 'We are in Dubbo, not Orange.', T0);
    const p = { metadata: { au_area: noted } };
    expect(area.openDisputes(noted).length).toBe(1);
    expect(area.needsPerson(p, 0)).toEqual([{ code: 'practice_query', message: 'The practice told us its area looks wrong: "We are in Dubbo, not Orange." Check it, then press "Mark as looked at".' }]);
    expect(area.staffView(p).disputes).toEqual([{ at: T0, note: 'We are in Dubbo, not Orange.' }]);
    const done = area.resolveDisputes(noted, STAFF, T1);
    expect(done.resolved).toBe(1);
    expect(done.record.disputes).toEqual([{ at: T0, note: 'We are in Dubbo, not Orange.', resolved_at: T1, resolved_by: STAFF }]);
    const after2 = { metadata: { au_area: done.record } };
    expect(area.needsPerson(after2, 0)).toEqual([]);
    expect(area.staffView(after2)).toMatchObject({ disputes: [], disputesLookedAt: 1 });
    expect(area.resolveDisputes(done.record, STAFF, T1).resolved).toBe(0);
    // a new note after that is open again
    expect(area.openDisputes(area.addDispute(done.record, 'Still wrong.', T1)).length).toBe(1);
  });
});

describe('M9-09: what staff read once the check is switched off', () => {
  it('a practice that was checked automatically: when, and that the check is now off (never "Practice answered")', () => {
    const rec = area.applyLookup(null, { ok: true, dpaGp: 'unknown', mmm: 3, mmmApproximate: true, confidence: 'approximate', checkedAt: '2026-11-25T04:05:06.000Z' }, { addressKey: OLD, now: T1 }).record;
    expect(area.autoCheckedNote({ metadata: { au_area: rec } })).toEqual({ at: '2026-11-25T04:05:06.000Z', status: 'unknown', label: 'DPA not confirmed', setBy: 'lookup', note: 'Checked automatically on 2026-11-25; the check is now off' });
    const hand = area.applyManual(rec, { dpa: 'yes', reason: 'Confirmed with the Department', by: STAFF, now: T1, addressKey: OLD }).record;
    expect(area.autoCheckedNote({ metadata: { au_area: hand } })).toMatchObject({ status: 'yes', label: 'In a DPA', note: 'Set by hand on 2026-11-26; the check is now off' });
  });
  it('a practice with no record really was asked: nothing is changed for it', () => {
    expect(area.autoCheckedNote({ metadata: { intake: { dpa: false } } })).toBe(null);
    expect(area.autoCheckedNote(null)).toBe(null);
  });
});

describe('S9-14: the made-up test provider is refused in production', () => {
  beforeEach(() => guard._resetForTests());
  it('fixture -> none when NODE_ENV or VERCEL_ENV is production, with ONE log line; every other provider is untouched', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(locator.providerName({ AU_WORKFORCE_LOCATOR_PROVIDER: 'fixture' })).toBe('fixture');
      expect(locator.providerName({ AU_WORKFORCE_LOCATOR_PROVIDER: 'fixture', NODE_ENV: 'development' })).toBe('fixture');
      expect(warn).not.toHaveBeenCalled();
      expect(locator.providerName({ AU_WORKFORCE_LOCATOR_PROVIDER: 'fixture', NODE_ENV: 'production' })).toBe('none');
      expect(locator.providerName({ AU_WORKFORCE_LOCATOR_PROVIDER: 'fixture', VERCEL_ENV: 'production' })).toBe('none');
      expect(locator.providerName({ AU_WORKFORCE_LOCATOR_PROVIDER: 'FIXTURE', NODE_ENV: 'Production' })).toBe('none');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/AU_WORKFORCE_LOCATOR_PROVIDER=fixture is refused in production: treated as none/);
      expect(locator.providerName({ AU_WORKFORCE_LOCATOR_PROVIDER: 'health_gov', NODE_ENV: 'production', VERCEL_ENV: 'production' })).toBe('health_gov');
      expect(locator.providerName({ AU_WORKFORCE_LOCATOR_PROVIDER: 'none', NODE_ENV: 'production' })).toBe('none');
      expect(locator.providerName({ NODE_ENV: 'production' })).toBe('none');
    } finally { warn.mockRestore(); }
  });
  it('in production a fixture setting answers nothing at all (no made-up label can reach a practice)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await locator.classifyLocation({ address: '2 Test Road', suburb: 'Dubbo', state: 'NSW' }, { env: { AU_WORKFORCE_LOCATOR_PROVIDER: 'fixture', VERCEL_ENV: 'production' } });
      expect(r).toMatchObject({ ok: false, provider: 'none', dpaGp: 'unknown', error: 'provider_off' });
    } finally { warn.mockRestore(); }
  });
  it('the shared helper (the Ahpra look-up uses the same one)', () => {
    expect(guard.fixtureAllowed({})).toBe(true);
    expect(guard.fixtureAllowed({ NODE_ENV: 'test' })).toBe(true);
    expect(guard.fixtureAllowed({ VERCEL_ENV: 'preview' })).toBe(true);
    expect(guard.fixtureAllowed({ VERCEL_ENV: 'preview', NODE_ENV: 'production' })).toBe(false);
    expect(guard.isProduction({ VERCEL_ENV: 'production' })).toBe(true);
    expect(guard.guardProvider('ahpra_public', 'AHPRA_LOOKUP_PROVIDER', { NODE_ENV: 'production' })).toBe('ahpra_public');
  });
});

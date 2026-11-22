// WP-13 (Australian GP build): THE CALENDAR-DATE RULE.
//
// The commencement day, the last working day, the invoice date, the guarantee
// end and the check-in days are calendar dates at the practice. "Today" is
// today's calendar date at the practice. Days between two dates are counted on
// the dates. So the answer to "how many days did the doctor work", "which
// credit band", "has the guarantee period ended", "is this invoice overdue"
// can never depend on the time of day the question is asked, on the server's
// own time zone, or on daylight saving.
//
// This file asks those questions at a table of instants (either side of
// midnight in UTC, Sydney and Perth; either side of both daylight-saving
// changes) for practices in every Australian zone, and requires the same
// calendar answers every time. The whole file also runs unchanged under any
// process time zone (TZ=UTC, Australia/Sydney, Australia/Perth,
// America/Los_Angeles ...).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootPlacementRig, PRACTICE_ID } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');
const { PRODUCTION_UNIQUE_RULES } = require('./helpers/au-supabase-emulator.js');
const fees = require('../lib/au-placement-fees.js');
const lc = require('../lib/au-lifecycle.js');
const auTimezone = require('../lib/au-timezone.js');

const clock = require('./helpers/au-wp13-clock.js').pinWp13Clock(vi);
const HOUR = 3600000;
const iso = (s) => Date.parse(s);

const ZONES = {
  NSW: 'Australia/Sydney', VIC: 'Australia/Melbourne', TAS: 'Australia/Hobart', SA: 'Australia/Adelaide',
  QLD: 'Australia/Brisbane', NT: 'Australia/Darwin', WA: 'Australia/Perth'
};

// Every instant the calculations are asked at. `days` is the calendar date it
// is in each zone at that instant, written out by hand.
const INSTANTS = [
  { at: '2026-11-21T12:30:00Z', why: 'late evening in the east, the same day everywhere', days: { NSW: '2026-11-21', TAS: '2026-11-21', SA: '2026-11-21', QLD: '2026-11-21', WA: '2026-11-21' } },
  { at: '2026-11-21T13:30:00Z', why: 'half past midnight in Sydney (daylight time); still Saturday in Brisbane and Perth', days: { NSW: '2026-11-22', TAS: '2026-11-22', SA: '2026-11-22', QLD: '2026-11-21', WA: '2026-11-21' } },
  { at: '2026-11-21T15:30:00Z', why: 'half an hour before midnight in Perth', days: { NSW: '2026-11-22', TAS: '2026-11-22', SA: '2026-11-22', QLD: '2026-11-22', WA: '2026-11-21' } },
  { at: '2026-11-21T16:30:00Z', why: 'half past midnight in Perth', days: { NSW: '2026-11-22', TAS: '2026-11-22', SA: '2026-11-22', QLD: '2026-11-22', WA: '2026-11-22' } },
  { at: '2026-11-21T20:30:00Z', why: 'the daily job (20:30 UTC): the next calendar day in every Australian zone', days: { NSW: '2026-11-22', TAS: '2026-11-22', SA: '2026-11-22', QLD: '2026-11-22', WA: '2026-11-22' } },
  { at: '2026-11-21T23:30:00Z', why: 'half an hour before midnight UTC', days: { NSW: '2026-11-22', TAS: '2026-11-22', SA: '2026-11-22', QLD: '2026-11-22', WA: '2026-11-22' } },
  { at: '2026-11-22T00:30:00Z', why: 'half past midnight UTC', days: { NSW: '2026-11-22', TAS: '2026-11-22', SA: '2026-11-22', QLD: '2026-11-22', WA: '2026-11-22' } },
  // Daylight saving starts in NSW / VIC / TAS / SA at 02:00 on Sunday 4 October 2026 (16:00 UTC on the 3rd; 16:30 UTC for Adelaide).
  { at: '2026-10-03T13:30:00Z', why: 'the night daylight saving starts: 23:30 standard time in Sydney', days: { NSW: '2026-10-03', TAS: '2026-10-03', SA: '2026-10-03', QLD: '2026-10-03', WA: '2026-10-03' } },
  { at: '2026-10-03T14:30:00Z', why: 'the night daylight saving starts: 00:30 in Sydney, before the change', days: { NSW: '2026-10-04', TAS: '2026-10-04', SA: '2026-10-04', QLD: '2026-10-04', WA: '2026-10-03' } },
  { at: '2026-10-03T17:30:00Z', why: 'just after the clocks went forward', days: { NSW: '2026-10-04', TAS: '2026-10-04', SA: '2026-10-04', QLD: '2026-10-04', WA: '2026-10-04' } },
  { at: '2026-10-04T13:30:00Z', why: 'the first midnight on daylight time: 00:30 Monday in Sydney, 23:30 Sunday in Brisbane', days: { NSW: '2026-10-05', TAS: '2026-10-05', SA: '2026-10-05', QLD: '2026-10-04', WA: '2026-10-04' } },
  // Daylight saving ends at 03:00 on Sunday 4 April 2027 (16:00 UTC on the 3rd).
  { at: '2027-04-03T13:30:00Z', why: 'the night daylight saving ends: 00:30 daylight time in Sydney', days: { NSW: '2027-04-04', TAS: '2027-04-04', SA: '2027-04-04', QLD: '2027-04-03', WA: '2027-04-03' } },
  { at: '2027-04-03T16:30:00Z', why: 'just after the clocks went back', days: { NSW: '2027-04-04', TAS: '2027-04-04', SA: '2027-04-04', QLD: '2027-04-04', WA: '2027-04-04' } },
  { at: '2027-04-04T13:30:00Z', why: 'the first evening back on standard time: 23:30 Sunday in Sydney', days: { NSW: '2027-04-04', TAS: '2027-04-04', SA: '2027-04-04', QLD: '2027-04-04', WA: '2027-04-04' } },
  { at: '2027-04-04T14:30:00Z', why: 'half past midnight Monday in Sydney, standard time', days: { NSW: '2027-04-05', TAS: '2027-04-05', SA: '2027-04-05', QLD: '2027-04-05', WA: '2027-04-04' } }
];

describe('an instant becomes a calendar date in one way: the date at the practice', () => {
  it('the table of instants, in every Australian zone', () => {
    INSTANTS.forEach((row) => {
      Object.keys(row.days).forEach((state) => {
        expect(lc.localDay(iso(row.at), ZONES[state]), row.at + ' ' + state + ' (' + row.why + ')').toBe(row.days[state]);
        expect(lc.localDay(iso(row.at), auTimezone.zoneForAuState(state)), 'zoneForAuState ' + state).toBe(row.days[state]);
      });
    });
  });

  it('when the daily job runs (20:30 UTC) it is the NEXT calendar day in every Australian zone, on every day of the year', () => {
    for (let n = 0; n < 400; n++) {
      const run = iso('2026-09-01T20:30:00Z') + n * 24 * HOUR;
      const utcDay = new Date(run).toISOString().slice(0, 10);
      Object.keys(ZONES).forEach((state) => {
        expect(lc.localDay(run, ZONES[state]), utcDay + ' ' + state).toBe(fees.addDays(utcDay, 1));
      });
    }
  });

  it('a practice with no known zone is on Sydney\'s date, always', () => {
    expect(lc.FALLBACK_ZONE).toBe('Australia/Sydney');
    for (const zone of [undefined, null, '', 'Not/AZone', 'nonsense']) {
      expect(lc.localDay(iso('2026-11-21T13:30:00Z'), zone), String(zone)).toBe('2026-11-22');
      expect(lc.localDay(iso('2026-11-21T12:30:00Z'), zone), String(zone)).toBe('2026-11-21');
    }
  });

  it('date arithmetic is on the dates: 24-hour steps are not days across a daylight-saving change', () => {
    // 50 calendar days back from 22 Nov 2026 is 3 Oct 2026. Fifty 24-hour steps back from 00:37 on the 22nd in Sydney
    // lands at 23:37 on 2 Oct (the clocks went forward in between): the bug this file exists for.
    const lateNight = iso('2026-11-21T13:37:00Z');
    expect(lc.localDay(lateNight, 'Australia/Sydney')).toBe('2026-11-22');
    expect(fees.addDays('2026-11-22', -50)).toBe('2026-10-03');
    expect(lc.localDay(lateNight - 50 * 24 * HOUR, 'Australia/Sydney')).toBe('2026-10-02');
    expect(fees.daysBetween('2026-10-03', '2026-11-22')).toBe(50);
    // across the end of daylight saving, and across a leap day
    expect(fees.daysBetween('2027-03-20', '2027-04-10')).toBe(21);
    expect(fees.addDays('2027-04-03', 1)).toBe('2027-04-04');
    expect(fees.addDays('2027-04-04', 1)).toBe('2027-04-05');
    expect(fees.addDays('2028-02-28', 2)).toBe('2028-03-01');
    expect(fees.guaranteeEndsOn('2026-09-01')).toBe('2026-11-24');
    expect(fees.daysBetween('2026-09-01', fees.guaranteeEndsOn('2026-09-01'))).toBe(84);
    // none of it depends on the process time zone: the same strings in, the same strings out
    expect(fees.cleanDay('2026-10-04')).toBe('2026-10-04');
    expect(lc.longDay('2026-10-04')).toBe('4 October 2026');
  });

  it('the credit function never reads a clock: no "as of" date, no verdict on an unpaid invoice', () => {
    const input = { commencedAt: '2026-09-01', lastWorkingDay: '2026-09-20', reason: 'doctor_resigned', conditionsConfirmed: 'yes', invoiceSentAt: '2026-09-01', invoicePaidAt: null };
    expect(fees.guaranteeCreditFor(input)).toMatchObject({ known: false, creditPct: null });
    expect(fees.guaranteeCreditFor(input).needsDecision).toContain('invoice_dates_unknown');
    expect(fees.guaranteeCreditFor(Object.assign({ asOf: '2026-09-08' }, input)).needsDecision).toContain('invoice_not_yet_paid');
    expect(fees.guaranteeCreditFor(Object.assign({ asOf: '2026-09-09' }, input))).toMatchObject({ known: true, creditPct: 0, forfeited: true });
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib/au-placement-fees.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
    expect(src).not.toMatch(/Date\.now\(\)|new Date\(\)/);
    expect(src).not.toMatch(/new Date\(\s*['"`]\d{4}-\d{2}-\d{2}['"`]\s*\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The same calculations through the real server, at each instant, for a
// practice in each zone.
// ─────────────────────────────────────────────────────────────────────────────
let rig; let t; let seq = 0;
const metaOf = (task) => (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}));
const practice = () => rig.table('practices').find((p) => p.id === PRACTICE_ID);
const placementOf = (d) => rig.table('placements').find((p) => p.user_id === d.userId) || null;
const call = (action, d, body, who) => rig.post('/api/admin/au/commencement/' + action, Object.assign({ case_id: d.caseId }, body || {}), who || rig.superAdmin());
const OVERRIDE = { override: true, override_reason: 'The practice confirmed by phone that the doctor has started.' };

// A doctor placed long ago (so any commencement date is after the placement).
async function placedDoctor() {
  seq += 1;
  // (fixed fixture dates are kept well ahead of every instant in the table)
  const d = buildAuDoctor('au_vr', { idSuffix: String(4000 + seq), profile: { phone: '+614004' + String(10000 + seq) }, credentials: { indemnity_expiry: '2030-06-30', registration_expiry: '2030-09-30' } });
  rig.addDoctor(d);
  const res = await rig.place(d, 'ats_placement', { settleMs: 15 });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const row = placementOf(d);
  row.placed_at = '2025-01-01T00:00:00.000Z';
  row.created_at = row.placed_at;
  row.start_date = '2030-01-01';
  return d;
}
function retire(d) {
  const row = placementOf(d);
  if (row && row.status === 'active') row.status = 'cancelled';
  const c = rig.caseOf(d);
  if (c) c.status = 'closed';
}

beforeAll(async () => {
  rig = await bootPlacementRig({
    name: 'wp13-calendar',
    emulator: { defaults: { registration_tasks: { status: 'open' }, placements: { status: 'active' } }, unique: PRODUCTION_UNIQUE_RULES }
  });
  t = rig.testUtils;
  Object.assign(practice(), { agreement_status: 'signed', agreement_signed_at: '2026-09-01T02:00:00.000Z', metadata: {} });
  clock.onSet((ms) => t.__setAuCommencementClockForTest(ms));
}, 60000);
afterAll(async () => {
  if (t) t.__setAuCommencementClockForTest(null);
  if (rig) await rig.close();
  clock.restore();
});
beforeEach(() => { rig.setSwitch(true); rig.resetRecorders(); });

// Last working day k calendar days after commencement -> what must be recorded.
const EXITS = [
  { k: 0, pct: 80 }, { k: 27, pct: 80 }, { k: 28, pct: null, edge: true }, { k: 29, pct: 50 }, { k: 55, pct: 50 },
  { k: 56, pct: null, edge: true }, { k: 57, pct: 35 }, { k: 83, pct: 35 }, { k: 84, pct: null, edge: true }, { k: 85, pct: 0, outside: true }
];

describe('commencement, early exit and close-case give the same calendar answers at every instant, in every zone', () => {
  const seen = {};   // state -> k -> the answer first seen, to compare every later instant against

  for (const state of ['NSW', 'WA']) {
    it('a ' + (state === 'NSW' ? 'Sydney' : 'Perth') + ' practice, at all ' + INSTANTS.length + ' instants: days worked, the credit band (edges included) and the guarantee end', async () => {
      practice().location_state = state;
      seen[state] = seen[state] || {};
      for (const row of INSTANTS) {
        clock.setNow(iso(row.at));
        const today = row.days[state];
        const label = row.at + ' ' + state;
        // commenced 90 calendar days ago at the practice, so every last working day below is in the past there
        const commencedOn = fees.addDays(today, -90);
        for (const exit of EXITS) {
          const d = await placedDoctor();
          const confirm = await call('confirm', d, Object.assign({ commenced_at: commencedOn, sessions_per_week: 8 }, OVERRIDE));
          expect(confirm.status, label + ' ' + JSON.stringify(confirm.json)).toBe(200);
          expect(confirm.json, label).toMatchObject({ commenced_at: commencedOn, invoice_due_at: commencedOn, guarantee_ends_at: fees.addDays(commencedOn, 84) });
          expect(placementOf(d), label).toMatchObject({ commenced_at: commencedOn, guarantee_ends_at: fees.addDays(commencedOn, 84), invoice_due_at: commencedOn });
          const checkins = rig.table('registration_tasks').filter((x) => x.case_id === d.caseId && metaOf(x).lifecycle_kind === 'guarantee_checkin').map((x) => x.due_date).sort();
          expect(checkins, label).toEqual([fees.addDays(commencedOn, 28), fees.addDays(commencedOn, 56), fees.addDays(commencedOn, 84)]);
          // invoice sent on the day, paid three days later: in good standing
          expect((await call('invoice-sent', d, { sent_at: commencedOn, reference: 'INV-' + seq })).status, label).toBe(200);
          expect((await call('invoice-paid', d, { paid_at: fees.addDays(commencedOn, 3) })).status, label).toBe(200);
          const lastDay = fees.addDays(commencedOn, exit.k);
          // CHANGED by FB-2b (W3-D15): a last working day after the guarantee
          // period is recorded by "Placement ended" (it used to go through
          // "Doctor left during the guarantee", which now refuses it). The
          // calendar answers asserted below are the same as before.
          if (exit.outside) {
            const refused = await call('early-exit', d, { last_working_day: lastDay, reason: 'doctor_resigned', conditions_confirmed: 'yes' });
            expect([refused.status, refused.json.code], label + ' k=' + exit.k).toEqual([409, 'after_guarantee_period']);
          }
          const res = await call(exit.outside ? 'placement-ended' : 'early-exit', d, { last_working_day: lastDay, reason: 'doctor_resigned', conditions_confirmed: 'yes' });
          expect(res.status, label + ' k=' + exit.k + ' ' + JSON.stringify(res.json)).toBe(200);
          const answer = { days_worked: res.json.credit.days_worked, credit_pct: res.json.credit.credit_pct, known: res.json.credit.known, reason: res.json.credit.reason, ended_at: res.json.ended_at };
          expect(answer.days_worked, label + ' k=' + exit.k).toBe(exit.k);
          expect(answer.credit_pct, label + ' k=' + exit.k).toBe(exit.pct);
          expect(answer.known, label + ' k=' + exit.k).toBe(!exit.edge);
          if (exit.edge) expect(res.json.credit.needs_decision, label + ' k=' + exit.k).toContain('band_edge_day');
          if (exit.outside) expect(answer.reason, label).toBe('outside_guarantee_period');
          expect(placementOf(d), label).toMatchObject({ ended_at: lastDay, credit_pct: exit.pct });
          // the same k gives the same answer at every instant
          const key = String(exit.k);
          const comparable = { days_worked: answer.days_worked, credit_pct: answer.credit_pct, known: answer.known, reason: answer.reason };
          if (seen[state][key]) expect(comparable, label + ' k=' + exit.k + ' vs the first instant').toEqual(seen[state][key]);
          else seen[state][key] = comparable;
          retire(d);
        }
      }
    }, 600000);
  }

  it('Sydney and Perth agree with each other for every last working day', () => {
    expect(Object.keys(seen.NSW).length).toBe(EXITS.length);
    expect(seen.WA).toEqual(seen.NSW);
  });

  it('Adelaide, Hobart, Brisbane and Darwin: the same, at the instants where their dates differ from Sydney\'s or Perth\'s', async () => {
    for (const state of ['SA', 'TAS', 'QLD', 'NT']) {
      practice().location_state = state;
      for (const at of ['2026-11-21T13:30:00Z', '2026-10-03T14:30:00Z', '2027-04-03T13:30:00Z', '2026-11-21T20:30:00Z']) {
        clock.setNow(iso(at));
        const today = lc.localDay(iso(at), ZONES[state]);
        const commencedOn = fees.addDays(today, -60);
        for (const exit of EXITS.filter((e) => e.k <= 57)) {
          const d = await placedDoctor();
          expect((await call('confirm', d, Object.assign({ commenced_at: commencedOn, sessions_per_week: 8 }, OVERRIDE))).status).toBe(200);
          await call('invoice-sent', d, { sent_at: commencedOn, reference: 'INV-' + seq });
          await call('invoice-paid', d, { paid_at: fees.addDays(commencedOn, 2) });
          const res = await call('early-exit', d, { last_working_day: fees.addDays(commencedOn, exit.k), reason: 'doctor_resigned', conditions_confirmed: 'yes' });
          expect(res.status, state + ' ' + at + ' k=' + exit.k).toBe(200);
          expect({ days_worked: res.json.credit.days_worked, credit_pct: res.json.credit.credit_pct, known: res.json.credit.known, reason: res.json.credit.reason }, state + ' ' + at + ' k=' + exit.k).toEqual(seen.NSW[String(exit.k)]);
          retire(d);
        }
      }
    }
    practice().location_state = 'NSW';
  }, 600000);
});

describe('the boundary day: what a Sydney practice and a Perth practice each get', () => {
  // 13:30 UTC on 21 Nov 2026: Sunday 22 Nov has begun in Sydney; it is still Saturday 21 Nov in Perth until 16:00 UTC.
  const SYDNEY_ONLY = iso('2026-11-21T13:30:00Z');
  const BOTH_22ND = iso('2026-11-21T16:30:00Z');
  const BOTH_21ST = iso('2026-11-21T12:30:00Z');

  it('"Confirm commenced": the date may not be after today AT THE PRACTICE', async () => {
    for (const [state, at, day, expected] of [
      ['NSW', BOTH_21ST, '2026-11-22', 400], ['NSW', SYDNEY_ONLY, '2026-11-22', 200],
      ['WA', SYDNEY_ONLY, '2026-11-22', 400], ['WA', BOTH_22ND, '2026-11-22', 200],
      ['WA', SYDNEY_ONLY, '2026-11-21', 200], ['NSW', SYDNEY_ONLY, '2026-11-23', 400]
    ]) {
      practice().location_state = state;
      clock.setNow(at);
      const d = await placedDoctor();
      const res = await call('confirm', d, Object.assign({ commenced_at: day, sessions_per_week: 8 }, OVERRIDE));
      expect(res.status, state + ' ' + new Date(at).toISOString() + ' ' + day).toBe(expected);
      if (expected === 400) {
        expect(res.json.code).toBe('date_in_future');
        expect(res.json.today).toBe(lc.localDay(at, ZONES[state]));
      }
      retire(d);
    }
  });

  it('"Close case": refused on the last day of the guarantee period at the practice, allowed the day after', async () => {
    // commenced 29 Aug 2026 -> the guarantee period ends on Saturday 21 Nov 2026
    const commencedOn = '2026-08-29';
    expect(fees.guaranteeEndsOn(commencedOn)).toBe('2026-11-21');
    for (const [state, refusedAt, allowedAt] of [['NSW', BOTH_21ST, SYDNEY_ONLY], ['WA', SYDNEY_ONLY, BOTH_22ND]]) {
      practice().location_state = state;
      clock.setNow(refusedAt);
      const d = await placedDoctor();
      expect((await call('confirm', d, Object.assign({ commenced_at: commencedOn, sessions_per_week: 8 }, OVERRIDE))).status).toBe(200);
      expect(placementOf(d).guarantee_ends_at).toBe('2026-11-21');
      const early = await call('close', d, {});
      expect(early.status, state + ' on the last day').toBe(409);
      expect(early.json.code).toBe('guarantee_not_ended');
      const view = await rig.get('/api/admin/au/commencement?case_id=' + d.caseId, rig.superAdmin());
      expect(view.json.today, state).toBe('2026-11-21');
      expect(view.json.state, state).toMatchObject({ inGuarantee: true, guaranteeDaysLeft: 0 });
      expect(view.json.can.close, state).toBe(false);
      clock.setNow(allowedAt);
      const after = await rig.get('/api/admin/au/commencement?case_id=' + d.caseId, rig.superAdmin());
      expect(after.json.today, state).toBe('2026-11-22');
      expect(after.json.state.inGuarantee, state).toBe(false);
      expect(after.json.can.close, state).toBe(true);
      const ok = await call('close', d, {});
      expect(ok.status, state + ' the day after ' + JSON.stringify(ok.json)).toBe(200);
      expect(rig.caseOf(d).stage, state).toBe('complete');
      retire(d);
    }
  });

  it('an early exit on the last day of a band is that band; the day is the practice\'s, not the server\'s', async () => {
    // commenced 25 Oct 2026; the last day of "up to 4 weeks" that is not an edge is day 27 = 21 Nov 2026
    for (const [state, at] of [['NSW', BOTH_21ST], ['NSW', SYDNEY_ONLY], ['WA', SYDNEY_ONLY], ['WA', BOTH_22ND]]) {
      practice().location_state = state;
      clock.setNow(at);
      const today = lc.localDay(at, ZONES[state]);
      const d = await placedDoctor();
      expect((await call('confirm', d, Object.assign({ commenced_at: '2026-10-25', sessions_per_week: 8 }, OVERRIDE))).status).toBe(200);
      await call('invoice-sent', d, { sent_at: '2026-10-25', reference: 'INV-B' + seq });
      await call('invoice-paid', d, { paid_at: '2026-10-27' });
      // a last working day that is "tomorrow" at the practice is refused, whatever the date is elsewhere
      const tomorrow = await call('early-exit', d, { last_working_day: fees.addDays(today, 1), reason: 'doctor_resigned', conditions_confirmed: 'yes' });
      expect(tomorrow.status, state).toBe(400);
      expect(tomorrow.json.code, state).toBe('date_in_future');
      const res = await call('early-exit', d, { last_working_day: '2026-11-21', reason: 'doctor_resigned', conditions_confirmed: 'yes' });
      expect(res.status, state + ' ' + JSON.stringify(res.json)).toBe(200);
      expect(res.json.credit, state).toMatchObject({ days_worked: 27, credit_pct: 80, known: true });
      retire(d);
    }
  });

  it('an invoice is overdue from the 8th day after its date at the practice: forfeiture does not arrive early or late', async () => {
    // invoice dated 14 Nov 2026 -> payable up to and including 21 Nov
    for (const [state, at, forfeited] of [['NSW', BOTH_21ST, false], ['NSW', SYDNEY_ONLY, true], ['WA', SYDNEY_ONLY, false], ['WA', BOTH_22ND, true]]) {
      practice().location_state = state;
      clock.setNow(at);
      const d = await placedDoctor();
      expect((await call('confirm', d, Object.assign({ commenced_at: '2026-11-14', sessions_per_week: 8 }, OVERRIDE))).status).toBe(200);
      await call('invoice-sent', d, { sent_at: '2026-11-14', reference: 'INV-F' + seq });
      const view = await rig.get('/api/admin/au/commencement?case_id=' + d.caseId, rig.superAdmin());
      expect(view.json.placement.invoice_payment_due_by).toBe('2026-11-21');
      expect(view.json.state.invoice, state + ' ' + new Date(at).toISOString()).toBe(forfeited ? 'overdue' : 'sent');
      const res = await call('early-exit', d, { last_working_day: '2026-11-20', reason: 'doctor_resigned', conditions_confirmed: 'yes' });
      expect(res.status).toBe(200);
      if (forfeited) expect(res.json.credit, state).toMatchObject({ known: true, credit_pct: 0, reason: 'forfeited_invoice_overdue' });
      else { expect(res.json.credit.known, state).toBe(false); expect(res.json.credit.needs_decision, state).toContain('invoice_not_yet_paid'); }
      retire(d);
    }
  });
});

describe('the daily job at 20:30 UTC: the same calendar day for every Australian practice', () => {
  it('"the day after the guarantee ends", "start date reached", "week N" and "7 days after the invoice date" fire on the right morning in Sydney and in Perth', async () => {
    for (const state of ['NSW', 'WA']) {
      practice().location_state = state;
      // set-up happens "earlier in the week": Friday 20 Nov 2026, midday UTC
      clock.setNow(iso('2026-11-20T02:00:00Z'));
      const mk = async (commencedOn, extra) => {
        const d = await placedDoctor();
        expect((await call('confirm', d, Object.assign({ commenced_at: commencedOn, sessions_per_week: 6 }, OVERRIDE))).status, state + ' ' + commencedOn).toBe(200);
        if (extra && extra.sent) expect((await call('invoice-sent', d, { sent_at: extra.sent, reference: 'INV-J' + seq })).status).toBe(200);
        return d;
      };
      const endsSat = await mk('2026-08-29');                         // guarantee ends Sat 21 Nov
      const endsSun = await mk('2026-08-30');                         // guarantee ends Sun 22 Nov
      const weekOneSun = await mk('2026-11-15');                      // week 1 falls on Sun 22 Nov
      const weekOneMon = await mk('2026-11-16');                      // week 1 falls on Mon 23 Nov
      const overdueSun = await mk('2026-11-14', { sent: '2026-11-14' });   // payable to Sat 21: overdue from Sun 22
      const overdueMon = await mk('2026-11-15', { sent: '2026-11-15' });   // payable to Sun 22: overdue from Mon 23
      const startsSun = await placedDoctor();
      placementOf(startsSun).start_date = '2026-11-22';
      const startsMon = await placedDoctor();
      placementOf(startsMon).start_date = '2026-11-23';
      const kinds = (run, d) => run.fired.filter((f) => f.user_id === d.userId).map((f) => f.kind);
      // CHANGED in WP-16 (quiet hours, COM-22). 20:30 UTC is 07:30 in Sydney
      // and 04:30 in Perth: the staff tasks and stage moves still happen at
      // that run, but the MESSAGES (the week-1 check-in, the twelve-week
      // thank-you) are held and go at the in-hours run three and a half hours
      // later (00:00 UTC: 11:00 in Sydney, 08:00 in Perth), which is the SAME
      // calendar day at every Australian practice. "The day's runs" below is
      // both of them; the calendar assertions are what they were.
      const dayRuns = async (hostIso) => {
        const host = await t.runAuLifecycleSweep(iso(hostIso));
        const inHours = await t.runAuLifecycleSweep(iso(hostIso) + 3.5 * 3600000);
        return { host, inHours, fired: host.fired.concat(inHours.fired) };
      };

      // The run of Friday 20:30 UTC is Saturday morning in Australia: nothing of the above is due yet
      // (the earlier check-ins of the older placements are long past their moment).
      const saturday = await t.runAuLifecycleSweep(iso('2026-11-20T20:30:00Z'));
      for (const d of [endsSat, endsSun]) expect(kinds(saturday, d).filter((k) => k === 'guarantee_ended'), state).toEqual([]);
      expect(rig.caseOf(endsSat).stage, state).not.toBe('complete');
      expect(kinds(saturday, weekOneSun), state).toEqual([]);
      expect(kinds(saturday, overdueSun).filter((k) => k === 'invoice_overdue'), state).toEqual([]);   // (its own week 1 falls on this Saturday)
      expect(kinds(saturday, startsSun).filter((k) => k === 'start_date_reached'), state).toEqual([]);

      // The run of Saturday 20:30 UTC is Sunday 22 Nov at every Australian practice.
      const sunday = await dayRuns('2026-11-21T20:30:00Z');
      // The check-in was held at the host's hour and went at the in-hours run, the same Sunday.
      expect(kinds(sunday.host, weekOneSun), state).toContain('deferred_quiet_hours');
      expect(kinds(sunday.host, weekOneSun), state).not.toContain('week1_checkin');
      expect(kinds(sunday.inHours, weekOneSun), state).toContain('week1_checkin');
      expect(kinds(sunday, endsSat), state).toContain('guarantee_ended');          // ended Saturday: closed on Sunday
      expect(rig.caseOf(endsSat).stage, state).toBe('complete');
      expect(kinds(sunday, endsSun), state).not.toContain('guarantee_ended');      // Sunday is its last day: still open
      expect(rig.caseOf(endsSun).stage, state).toBe('guarantee');
      expect(kinds(sunday, weekOneSun), state).toContain('week1_checkin');
      expect(kinds(sunday, weekOneMon), state).toEqual([]);
      expect(kinds(sunday, overdueSun), state).toContain('invoice_overdue');
      expect(kinds(sunday, overdueMon), state).not.toContain('invoice_overdue');
      expect(kinds(sunday, startsSun), state).toContain('start_date_reached');
      expect(kinds(sunday, startsMon), state).not.toContain('start_date_reached');

      // The run of Sunday 20:30 UTC is Monday 23 Nov: the second of each pair follows, the first does not repeat.
      const monday = await dayRuns('2026-11-22T20:30:00Z');
      expect(kinds(monday, endsSun), state).toContain('guarantee_ended');
      expect(kinds(monday, endsSat), state).not.toContain('guarantee_ended');
      expect(kinds(monday, weekOneMon), state).toContain('week1_checkin');
      expect(kinds(monday, weekOneSun), state).not.toContain('week1_checkin');
      expect(kinds(monday, overdueMon), state).toContain('invoice_overdue');
      expect(kinds(monday, overdueSun), state).not.toContain('invoice_overdue');
      expect(kinds(monday, startsMon), state).toContain('start_date_reached');
      expect(kinds(monday, startsSun), state).not.toContain('start_date_reached');
      [endsSat, endsSun, weekOneSun, weekOneMon, overdueSun, overdueMon, startsSun, startsMon].forEach(retire);
    }
    practice().location_state = 'NSW';
  }, 300000);

  it('a job run at an odd hour still judges each practice on its own date (a late run at 14:00 UTC: Sunday in Sydney, Saturday in Perth)', async () => {
    const results = {};
    for (const state of ['NSW', 'WA']) {
      practice().location_state = state;
      clock.setNow(iso('2026-11-20T02:00:00Z'));
      const d = await placedDoctor();
      expect((await call('confirm', d, Object.assign({ commenced_at: '2026-08-29', sessions_per_week: 8 }, OVERRIDE))).status).toBe(200);   // ends Sat 21 Nov
      const run = await t.runAuLifecycleSweep(iso('2026-11-21T14:00:00Z'));
      results[state] = { closed: run.fired.some((f) => f.user_id === d.userId && f.kind === 'guarantee_ended'), stage: rig.caseOf(d).stage };
      retire(d);
    }
    expect(results.NSW).toEqual({ closed: true, stage: 'complete' });     // it is already Sunday there
    expect(results.WA).toEqual({ closed: false, stage: 'guarantee' });    // still the last day of the period there
    practice().location_state = 'NSW';
  });

  it('"N days after the placement" is counted in calendar days at the practice, not in 24-hour periods', async () => {
    practice().location_state = 'NSW';
    clock.setNow(iso('2026-11-20T02:00:00Z'));
    const d = await placedDoctor();
    // recorded at 23:50 on Sunday 8 Nov in Sydney
    placementOf(d).placed_at = '2026-11-08T12:50:00.000Z';
    placementOf(d).start_date = null;
    // Sunday 22 Nov is 14 calendar days later (only 13 days and some hours have elapsed at 00:30)
    const before = await t.runAuLifecycleSweep(iso('2026-11-21T12:30:00Z'));      // 23:30 Sat 21: day 13
    expect(before.fired.filter((f) => f.user_id === d.userId)).toEqual([]);
    const after = await t.runAuLifecycleSweep(iso('2026-11-21T13:30:00Z'));       // 00:30 Sun 22: day 14
    expect(after.fired.filter((f) => f.user_id === d.userId).map((f) => f.kind)).toEqual(['provider_number_pending']);
    retire(d);
  });
});

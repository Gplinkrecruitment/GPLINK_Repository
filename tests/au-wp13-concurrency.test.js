// WP-13 (Australian GP build): everything a commencement derives happens ONCE,
// whoever else is doing the same thing at the same moment.
//
// Each case below runs the overlapping calls many times in a loop, with the
// database's answers arriving after random delays and some writes held "in
// flight" (including task inserts held for longer than the 250 ms the old
// design waited before taking a claim over), so a race cannot hide behind
// lucky timing.
//
//   double (and triple) "Confirm commenced"                 25 rounds
//   "Confirm commenced" overlapping the daily job (x2)      25 rounds
//   double "Doctor left during the guarantee"               25 rounds
//   three overlapping runs of the daily job                 25 rounds
//   every other commercial write, double-submitted          10 rounds
//   a commencement that died before its tasks were written  10 rounds
//
// The database stub enforces the two unique indexes the real database has
// (the once-ever ledger, and uniq_au_lifecycle_task from the WP-13 migration).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { bootPlacementRig, PRACTICE_ID, PRACTICE_EMAIL } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');
const { PRODUCTION_UNIQUE_RULES } = require('./helpers/au-supabase-emulator.js');
const fees = require('../lib/au-placement-fees.js');
const lc = require('../lib/au-lifecycle.js');

const ROUNDS = 25;
const DAY = 86400000;
let rig; let t; let seq = 0;
// The clock is PINNED (tests/helpers/au-wp13-clock.js); dates are calendar dates.
const clock = require('./helpers/au-wp13-clock.js').pinWp13Clock(vi);
const T0 = clock.T0;
const at = clock.at;
// CHANGED in WP-16 (quiet hours, COM-22): the job's messages (N18 to N20) only go
// between 08:00 and 20:00 on the practice's clock, so the overlapping runs below are
// runs INSIDE those hours on the pinned calendar date (the pinned time of day, 00:37
// in Sydney, is outside them and would only defer). What is raced is unchanged.
const inHours = clock.atHours;
const dayAt = clock.dayAt;
const metaOf = (task) => (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jittered = (fn) => sleep(Math.random() * 8).then(fn);
const toList = (v) => (Array.isArray(v) ? v : (v ? [v] : []));

function surname(n) { return 'Wq' + String.fromCharCode(97 + Math.floor(n / 26) % 26) + String.fromCharCode(97 + (n % 26)); }
function doctor() {
  seq += 1;
  const last = surname(seq);
  // Fixture dates that are fixed days (the indemnity expiry, 30 June 2027) are moved ahead of the pinned clock,
  // so the file means the same at whatever instant it is run.
  const d = buildAuDoctor('au_vr', { idSuffix: String(6000 + seq), profile: { phone: '+614006' + String(10000 + seq), last_name: last }, credentials: { indemnity_expiry: dayAt(700), registration_expiry: dayAt(700) } });
  d.lastName = last;
  rig.addDoctor(d);
  return d;
}
const placementOf = (d) => rig.table('placements').find((p) => p.user_id === d.userId) || null;
const caseOf = (d) => rig.caseOf(d);
const wp13Tasks = (d) => rig.table('registration_tasks').filter((x) => x.case_id === d.caseId && metaOf(x).lifecycle_kind && metaOf(x).undone !== true);
const keyOf = (task) => metaOf(task).lifecycle_kind + ':' + (metaOf(task).mark || '');
const keysOf = (d) => wp13Tasks(d).map(keyOf).sort();
const timelineOf = (d) => rig.table('task_timeline').filter((x) => x.case_id === d.caseId);
const titles = (d, re) => timelineOf(d).map((x) => String(x.title)).filter((x) => re.test(x));
const stageMoves = (d) => timelineOf(d).filter((x) => x.event_type === 'stage_change').map((x) => x.title);
const emailsTo = (address) => rig.emails.filter((e) => toList(e && e.to).some((x) => String(x).toLowerCase().indexOf(String(address).toLowerCase()) !== -1));
const practiceAbout = (d) => emailsTo(PRACTICE_EMAIL).filter((e) => (String(e.subject) + ' ' + String(e.text)).indexOf(d.lastName) !== -1);
const ledgerOf = (d) => rig.table('gp_nudge_log').filter((n) => n.user_id === d.userId).map((n) => n.nudge_key + '|' + n.channel);
const noRepeats = (list) => new Set(list).size === list.length;
const call = (action, d, body, who) => rig.post('/api/admin/au/commencement/' + action, Object.assign({ case_id: d.caseId }, body || {}), who || rig.superAdmin());
const FIVE = ['guarantee_checkin:w12', 'guarantee_checkin:w4', 'guarantee_checkin:w8', 'invoice_due:', 'week1_checkin:w1'];
const OVERRIDE = { override: true, override_reason: 'The practice confirmed by phone that the doctor has started.' };

// A fake Australian doctor with a staff-recorded placement, recorded `placedDaysAgo` days ago.
async function placed(placedDaysAgo) {
  const d = doctor();
  calm();
  const res = await rig.place(d, 'ats_placement', { settleMs: 40 });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const row = placementOf(d);
  row.placed_at = new Date(at(-(placedDaysAgo || 1))).toISOString();
  row.created_at = row.placed_at;
  // The rig's own start date is a fixed day (1 Feb 2027). Keep it ahead of the
  // pinned clock, whatever instant the file is run at, so no "start date
  // reached" prompt appears unless a case asks for one.
  row.start_date = dayAt(60);
  return d;
}
async function commenced(daysAgo, sessions) {
  const d = await placed(daysAgo + 30);
  const res = await call('confirm', d, Object.assign({ commenced_at: dayAt(-daysAgo), sessions_per_week: sessions || 8 }, OVERRIDE));
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return d;
}
// Take a finished doctor out of the daily job's sight, so each round stays small.
function retire(d) {
  const row = placementOf(d);
  if (row && row.status === 'active') row.status = 'cancelled';
  const c = caseOf(d);
  if (c) c.status = 'closed';
}
// Random delays on every answer, some requests held in flight, and on every
// fifth round task inserts held for 300 ms (longer than the old design's
// 250 ms wait before it took a claim over).
function storm(round) {
  rig.emu.jitterMs = 6;
  rig.emu.hold = (r) => {
    if (round % 5 === 0 && r.method === 'POST' && r.table === 'registration_tasks' && Math.random() < 0.34) return 300;
    return Math.random() < 0.25 ? Math.random() * 12 : 0;
  };
}
function calm() { rig.emu.jitterMs = 0; rig.emu.hold = null; }

beforeAll(async () => {
  rig = await bootPlacementRig({
    name: 'wp13-concurrency',
    env: { LAUNCH_DEFAULT_RSO_EMAIL: 'rso.test@gplink-test.local' },
    emulator: { defaults: { registration_tasks: { status: 'open' }, placements: { status: 'active' } }, unique: PRODUCTION_UNIQUE_RULES }
  });
  t = rig.testUtils;
  Object.assign(rig.table('practices').find((p) => p.id === PRACTICE_ID), { agreement_status: 'signed', agreement_signed_at: '2026-09-01T02:00:00.000Z', metadata: {} });
}, 60000);
afterAll(async () => {
  if (rig) { calm(); t.__setAuCommencementClockForTest(null); await rig.close(); }
  clock.restore();
});
beforeEach(() => {
  rig.setSwitch(true);
  calm();
  rig.resetRecorders();
  clock.onSet((ms) => t.__setAuCommencementClockForTest(ms));
  clock.setNow(T0);
});

describe('the database stub enforces what the real database enforces', () => {
  it('a second identical ledger row, and a second WP-13 task of the same kind and mark, are refused with 409 / 23505', async () => {
    const d = doctor();
    const base = rig.emu.url + '/rest/v1/';
    const post = (table, row) => fetch(base + table, { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify([row]) });
    expect((await post('gp_nudge_log', { user_id: d.userId, nudge_key: 'probe', channel: 'email' })).status).toBe(201);
    const again = await post('gp_nudge_log', { user_id: d.userId, nudge_key: 'probe', channel: 'email' });
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('23505');
    expect((await post('gp_nudge_log', { user_id: d.userId, nudge_key: 'probe', channel: 'bell' })).status).toBe(201);
    const task = (mark, extra) => ({ case_id: d.caseId, task_type: 'guarantee_checkin', title: 'x', metadata: Object.assign({ lifecycle_kind: 'guarantee_checkin', placement_key: 'pk', mark }, extra || {}) });
    expect((await post('registration_tasks', task('w4'))).status).toBe(201);
    expect((await post('registration_tasks', task('w4'))).status).toBe(409);
    expect((await post('registration_tasks', task('w8'))).status).toBe(201);
    // a task marked undone does not count, and an ordinary task is never affected
    expect((await post('registration_tasks', task('w4', { undone: true }))).status).toBe(201);
    expect((await post('registration_tasks', { case_id: d.caseId, task_type: 'manual', title: 'y' })).status).toBe(201);
    expect((await post('registration_tasks', { case_id: d.caseId, task_type: 'manual', title: 'y' })).status).toBe(201);
    rig.table('registration_tasks').splice(0, rig.table('registration_tasks').length, ...rig.table('registration_tasks').filter((x) => x.case_id !== d.caseId));
  });

  it('the stub\'s rule is the migration\'s index: same columns, same exclusions, safe on existing rows', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/20261121110000_au_gp_wp13_placement_commercials.sql'), 'utf8');
    const start = sql.indexOf('create unique index if not exists uniq_au_lifecycle_task');
    expect(start).toBeGreaterThan(-1);
    const index = sql.slice(start, sql.indexOf(';', start)).replace(/\s+/g, ' ');
    expect(index).toBe("create unique index if not exists uniq_au_lifecycle_task on public.registration_tasks ( case_id, (metadata ->> 'placement_key'), (metadata ->> 'lifecycle_kind'), (coalesce(metadata ->> 'mark', '')) ) where (metadata ->> 'lifecycle_kind') is not null and coalesce(metadata ->> 'undone', 'false') <> 'true'");
    // every kind this package writes carries the three keys the index reads
    for (const built of [
      lc.buildInvoiceTask({ placementKey: 'pk', commencedAt: '2027-02-01', fee: { known: false, reason: 'sessions_unknown' } }),
      lc.buildCheckinTask(4, { placementKey: 'pk', commencedAt: '2027-02-01' }),
      lc.buildWeek1Task({ placementKey: 'pk', commencedAt: '2027-02-01' }),
      lc.buildLifecycleTask(lc.KIND.UPLIFT, { placementKey: 'pk', month: 6, mark: 'm6', commencedAt: '2027-02-01' }),
      lc.buildExitTask({ placementKey: 'pk', commencedAt: '2027-02-01', lastWorkingDay: '2027-02-10', reason: 'other' })
    ]) {
      expect(built.metadata.lifecycle_kind).toBeTruthy();
      expect(built.metadata.placement_key).toBe('pk');
      expect(PRODUCTION_UNIQUE_RULES.registration_tasks[0](Object.assign({ case_id: 'c1' }, built))).toMatch(/^c1\|pk\|/);
    }
    // no task type outside this package is ever in the index
    expect(PRODUCTION_UNIQUE_RULES.registration_tasks[0]({ case_id: 'c1', task_type: 'doc_review', metadata: { placement_key: 'pk' } })).toBeNull();
  });
});

describe('two (or three) people press "Confirm commenced" at the same moment', () => {
  it(ROUNDS + ' rounds: one commencement, one invoice task, three check-ins, one first-week task, one stage move, one timeline line', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const d = await placed(20);
      const body = Object.assign({ commenced_at: dayAt(-1), sessions_per_week: 8 }, OVERRIDE);
      const callers = [rig.superAdmin(), rig.consultant()].concat(round % 3 === 0 ? [rig.superAdmin()] : []);
      storm(round);
      const answers = await Promise.all(callers.map((who) => jittered(() => call('confirm', d, body, who))));
      calm();
      const label = 'round ' + round;
      expect(answers.map((r) => r.status), label).toEqual(callers.map(() => 200));
      expect(answers.filter((r) => r.json.already === false).length, label).toBe(1);        // exactly one of them did it
      expect(keysOf(d), label).toEqual(FIVE);
      expect(wp13Tasks(d).filter((x) => x.task_type === 'guarantee_checkin').length, label).toBe(3);
      expect(wp13Tasks(d).filter((x) => x.task_type === 'invoice_due').length, label).toBe(1);
      expect(titles(d, /^Commencement confirmed: /).length, label).toBe(1);
      expect(stageMoves(d).filter((x) => x === 'Stage advanced to commenced').length, label).toBe(1);
      expect(placementOf(d), label).toMatchObject({ commenced_at: dayAt(-1), fee_amount_ex_gst: 21000, guarantee_ends_at: fees.addDays(dayAt(-1), 84) });
      expect(caseOf(d).stage, label).toBe('commenced');
      // every answer reports the same five tasks, and between them each was created exactly once
      const created = answers.reduce((all, r) => all.concat(r.json.tasks.created), []).sort();
      expect(created, label).toEqual(['guarantee_checkin:w12', 'guarantee_checkin:w4', 'guarantee_checkin:w8', 'invoice_due', 'week1_checkin']);
      answers.forEach((r) => expect(r.json.tasks.failed, label).toEqual([]));
      retire(d);
    }
  }, 240000);
});

describe('"Confirm commenced" while the daily job is running (twice over)', () => {
  it(ROUNDS + ' rounds: still one set of tasks, one stage move each way, and N18 goes to each party once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      // started 8 days ago, confirmed only now: the job owes week 1 (N18 and the move to guarantee) at once
      const d = await placed(40);
      const body = Object.assign({ commenced_at: dayAt(-8), sessions_per_week: 6 }, OVERRIDE);
      rig.resetRecorders();
      storm(round);
      const [confirm] = await Promise.all([
        jittered(() => call('confirm', d, body, rig.consultant())),
        jittered(() => t.runAuLifecycleSweep(inHours(0))),
        jittered(() => t.runAuLifecycleSweep(inHours(0)))
      ]);
      // ... and once more after everything has landed
      await Promise.all([t.runAuLifecycleSweep(inHours(0)), t.runAuLifecycleSweep(inHours(0))]);
      calm();
      await t.runAuLifecycleSweep(inHours(0));
      const label = 'round ' + round;
      expect(confirm.status, label + ' ' + JSON.stringify(confirm.json)).toBe(200);
      expect(keysOf(d), label).toEqual(FIVE);
      expect(titles(d, /^Commencement confirmed: /).length, label).toBe(1);
      expect(stageMoves(d).filter((x) => x === 'Stage advanced to commenced').length, label).toBe(1);
      expect(stageMoves(d).filter((x) => x === 'Stage advanced to guarantee').length, label).toBe(1);
      expect(caseOf(d).stage, label).toBe('guarantee');
      // (the pre-start pass may also send its own N13 document reminder to a doctor still in pre-start when it looked: once)
      const subjects = emailsTo(d.email).map((e) => String(e.subject));
      expect(subjects.filter((x) => x === 'How was your first week?'), label).toEqual(['How was your first week?']);
      expect(noRepeats(subjects), label + ' ' + subjects.join(' | ')).toBe(true);
      expect(practiceAbout(d).map((e) => e.subject), label).toEqual(['Dr ' + d.profile.first_name + ' ' + d.lastName + ': first week check-in']);
      expect(titles(d, /^First-week check-in sent \(N18\)$/).length, label).toBe(1);
      expect(noRepeats(ledgerOf(d)), label).toBe(true);
      retire(d);
    }
  }, 240000);
});

describe('two people record "Doctor left during the guarantee" at the same moment', () => {
  it(ROUNDS + ' rounds: one exit, one CEO task, the check-ins cancelled once, one stage move, one timeline line', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const d = await commenced(20, 8);
      const body = { last_working_day: dayAt(-3), reason: 'doctor_resigned', conditions_confirmed: 'yes', note: 'Round ' + round };
      storm(round);
      const answers = await Promise.all([rig.superAdmin(), rig.consultant()].map((who) => jittered(() => call('early-exit', d, body, who))));
      calm();
      const label = 'round ' + round;
      expect(answers.map((r) => r.status), label + ' ' + JSON.stringify(answers.map((r) => r.json && r.json.code))).toEqual([200, 200]);
      expect(answers.filter((r) => r.json.already === false).length, label).toBe(1);
      expect(answers.filter((r) => r.json.already === true).length, label).toBe(1);
      expect(placementOf(d), label).toMatchObject({ status: 'ended', ended_at: dayAt(-3) });
      expect(wp13Tasks(d).filter((x) => metaOf(x).lifecycle_kind === 'replacement_or_credit').length, label).toBe(1);
      expect(titles(d, /^Doctor left: last working day /).length, label).toBe(1);
      expect(titles(d, /^Task cancelled: /).length, label).toBe(4);                              // week 1 and the three check-ins, once each
      expect(wp13Tasks(d).filter((x) => x.status === 'cancelled').length, label).toBe(4);
      expect(stageMoves(d).filter((x) => x === 'Stage advanced to complete').length, label).toBe(1);
      expect(noRepeats(keysOf(d)), label).toBe(true);
    }
  }, 240000);
});

describe('three runs of the daily job overlap', () => {
  // How long ago the doctor started, and what the job owes them on that day.
  const CASES = [
    { daysAgo: 8, emails: ['How was your first week?'], tasks: ['invoice_overdue'] },
    { daysAgo: 29, emails: ['Checking in: 4 weeks'], tasks: ['invoice_overdue'] },
    { daysAgo: 57, emails: ['Checking in: 8 weeks'], tasks: ['invoice_overdue'] },
    // (week 8 is still the current check-in until week 12 falls due, so it goes to a commencement confirmed late)
    { daysAgo: 72, emails: ['Checking in: 8 weeks'], tasks: ['invoice_overdue', 'guarantee_ending'] },
    { daysAgo: 86, emails: ['Checking in: 12 weeks', 'Twelve weeks in: thank you'], tasks: ['invoice_overdue'] },
    { daysAgo: 190, emails: [], tasks: ['invoice_overdue', 'part_time_uplift'] }
  ];
  it(ROUNDS + ' rounds: each reminder task is raised once, each message goes once, each stage move happens once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const spec = CASES[round % CASES.length];
      // part-time, invoice sent on the day and never paid
      const d = await commenced(spec.daysAgo, 6);
      expect((await call('invoice-sent', d, { sent_at: dayAt(-spec.daysAgo), reference: 'INV-R' + round })).status).toBe(200);
      // and a second doctor not yet started, whose start date is two days away with nothing done
      const waiting = await placed(20);
      placementOf(waiting).start_date = dayAt(2);
      rig.resetRecorders();
      const before = stageMoves(d).length;
      storm(round);
      const runs = await Promise.all([0, 1, 2].map(() => jittered(() => t.runAuLifecycleSweep(inHours(0)))));
      await Promise.all([t.runAuLifecycleSweep(inHours(0)), t.runAuLifecycleSweep(inHours(0))]);
      calm();
      const label = 'round ' + round + ' (day ' + spec.daysAgo + ')';
      runs.forEach((r) => expect(r.ok, label).toBe(true));
      // the started doctor
      expect(noRepeats(keysOf(d)), label + ' ' + keysOf(d).join(',')).toBe(true);
      spec.tasks.forEach((kind) => expect(wp13Tasks(d).filter((x) => metaOf(x).lifecycle_kind === kind).length, label + ' ' + kind).toBe(1));
      const subjects = emailsTo(d.email).map((e) => String(e.subject));
      expect(noRepeats(subjects), label + ' ' + subjects.join(' | ')).toBe(true);
      spec.emails.forEach((s) => expect(subjects.filter((x) => x.indexOf(s) === 0).length, label + ' ' + s).toBe(1));
      expect(subjects.length, label).toBe(spec.emails.length);
      expect(noRepeats(practiceAbout(d).map((e) => String(e.subject))), label).toBe(true);
      expect(noRepeats(stageMoves(d).slice(before)), label).toBe(true);
      expect(noRepeats(timelineOf(d).map((x) => x.title).filter((x) => /\((N18|N19|N20)\)$/.test(x) || /^Guarantee period ended/.test(x))), label).toBe(true);
      expect(noRepeats(ledgerOf(d)), label).toBe(true);
      // each reminder was reported as fired by exactly one of the overlapping runs
      const fired = runs.reduce((all, r) => all.concat(r.fired.filter((f) => f.user_id === d.userId).map((f) => f.kind + (f.week || '') + (f.month || ''))), []);
      expect(noRepeats(fired), label + ' ' + fired.join(',')).toBe(true);
      // the doctor who has not started: two reminder tasks (start in 2 days with pre-start unfinished; notice not
      // recorded) and one escalation (provider number pending 20 days after the placement), once each
      expect(keysOf(waiting), label).toEqual(['notice_not_recorded:' + dayAt(2), 'prestart_at_risk:d3']);
      const firedWaiting = runs.reduce((all, r) => all.concat(r.fired.filter((f) => f.user_id === waiting.userId).map((f) => f.kind)), []).sort();
      expect(firedWaiting, label).toEqual(['notice_not_recorded', 'prestart_at_risk', 'provider_number_pending']);
      expect(rig.table('task_timeline').filter((x) => x.case_id === waiting.caseId && /^Provider number still pending/.test(x.title)).length, label).toBe(1);
      retire(d);
      retire(waiting);
    }
  }, 300000);
});

describe('every other commercial write, submitted twice at once', () => {
  it('10 rounds: invoice sent, invoice paid, correct, credit decision and recorded-in-error are each applied and logged once', async () => {
    for (let round = 0; round < 10; round++) {
      const label = 'round ' + round;
      const pair = async (action, d, body) => {
        storm(round);
        const out = await Promise.all([0, 1].map(() => jittered(() => call(action, d, body))));
        calm();
        return out;
      };
      // invoice sent, then paid
      const a = await commenced(10, 8);
      const sent = await pair('invoice-sent', a, { sent_at: dayAt(-9), reference: 'INV-D' + round });
      expect(sent.map((r) => r.status), label).toEqual([200, 200]);
      expect(sent.filter((r) => r.json.unchanged === false).length, label).toBe(1);
      expect(titles(a, /^Placement-fee invoice sent: /).length, label).toBe(1);
      expect(wp13Tasks(a).filter((x) => x.task_type === 'invoice_due').map((x) => x.status), label).toEqual(['completed']);
      const paid = await pair('invoice-paid', a, { paid_at: dayAt(-5) });
      expect(paid.map((r) => r.status), label).toEqual([200, 200]);
      expect(titles(a, /^Placement-fee invoice paid$/).length, label).toBe(1);
      // correct the date: one is applied, the other is told the details have just changed (or that nothing is left to change)
      const b = await commenced(10, 8);
      const fixed = await pair('correct', b, { commenced_at: dayAt(-12), reason: 'The practice gave us the wrong day.' });
      expect(fixed.map((r) => r.status).sort(), label + ' ' + JSON.stringify(fixed.map((r) => r.json.code))).toSatisfy((s) => s[0] === 200 && (s[1] === 409 || s[1] === 400));
      expect(titles(b, /^Commencement details corrected$/).length, label).toBe(1);
      expect(placementOf(b), label).toMatchObject({ commenced_at: dayAt(-12), guarantee_ends_at: fees.addDays(dayAt(-12), 84) });
      expect(keysOf(b), label).toEqual(FIVE);
      // recorded in error: one undoes it, the other is told it is already gone
      const undone = await pair('undo', b, { reason: 'Recorded against the wrong doctor.' });
      expect(undone.map((r) => r.status).sort(), label + ' ' + JSON.stringify(undone.map((r) => r.json.code))).toEqual([200, 409]);
      expect(titles(b, /^Commencement recorded in error: undone$/).length, label).toBe(1);
      expect(stageMoves(b).filter((x) => /^Stage returned to prestart/.test(x)).length, label).toBe(1);
      expect(keysOf(b), label).toEqual([]);
      expect(placementOf(b).commenced_at, label).toBeNull();
      // ... and a correct commencement afterwards, pressed twice, makes exactly one fresh set
      const redo = await pair('confirm', b, Object.assign({ commenced_at: dayAt(-2), sessions_per_week: 8 }, OVERRIDE));
      expect(redo.map((r) => r.status), label).toEqual([200, 200]);
      expect(keysOf(b), label).toEqual(FIVE);
      // credit decision after an exit the schedule could not settle
      const c = await commenced(20, 8);
      expect((await call('early-exit', c, { last_working_day: dayAt(-2), reason: 'practice_side' })).status).toBe(200);
      const decided = await pair('credit-decision', c, { credit_pct: 50, reason: 'Clause 7.3, agreed with the practice.' });
      expect(decided.map((r) => r.status), label).toEqual([200, 200]);
      expect(titles(c, /^Guarantee credit decided: /).length, label).toBe(1);
      expect(placementOf(c).credit_pct, label).toBe(50);
      [a, b, c].forEach(retire);
    }
  }, 300000);
});

describe('a commencement that died half-way is completed, once', () => {
  it('10 rounds: the stamp is on the placement and some tasks are missing; overlapping runs of the daily job and a second press raise exactly what is missing', async () => {
    for (let round = 0; round < 10; round++) {
      const d = await commenced(3, 8);
      // the process "died" after writing some of the tasks: remove a random part of the set
      const all = rig.table('registration_tasks');
      const mine = wp13Tasks(d);
      const lost = mine.filter(() => Math.random() < 0.6);
      if (!lost.length) lost.push(mine[0]);
      lost.forEach((x) => all.splice(all.indexOf(x), 1));
      caseOf(d).stage = 'prestart';                      // ... and before the stage moved
      const label = 'round ' + round + ' (lost ' + lost.map(keyOf).join(',') + ')';
      storm(round);
      const out = await Promise.all([
        jittered(() => t.runAuLifecycleSweep(inHours(0))),
        jittered(() => t.runAuLifecycleSweep(inHours(0))),
        jittered(() => call('confirm', d, { commenced_at: dayAt(-3) }, rig.consultant()))
      ]);
      calm();
      expect(out[2].status, label).toBe(200);
      expect(out[2].json.already, label).toBe(true);
      expect(keysOf(d), label).toEqual(FIVE);
      expect(caseOf(d).stage, label).toBe('commenced');
      expect(stageMoves(d).filter((x) => x === 'Stage advanced to commenced').length, label).toBe(2);   // the first time, and the repair: never three
      const created = out[0].fired.concat(out[1].fired).filter((f) => f.user_id === d.userId && f.kind === 'derived_tasks_repaired')
        .reduce((list, f) => list.concat(f.created), []).concat(out[2].json.tasks.created.map((k) => k));
      expect(created.length, label + ' ' + created.join(',')).toBe(lost.length);
      expect(noRepeats(created), label).toBe(true);
      retire(d);
    }
  }, 240000);
});

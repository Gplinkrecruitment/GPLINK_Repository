// WP-13 (Australian GP build): commencement, invoice and guarantee tracking,
// against the real server and the in-memory database.
//
//   ACCEPTANCE  confirming commencement on a fixture produces ONE invoice task
//               with the fee from the agreement variant the practice signed,
//               THREE dated check-ins and a guarantee end date 12 weeks out
//   idempotency, validation, the pre-start override, who may do what
//   stage moves; correct the date; commencement recorded in error
//   invoice sent / paid; early exit (each credit band, forfeiture, unknown)
//   the daily lifecycle job, walked with a pinned clock from the placement
//     through week 12 to months 6 and 12
//   what is sent to the doctor (no banned word, nothing commercial)
//   exports on / off; the doctor's "you have started" page
//   overseas parity: an overseas placement gets none of it, switch on or off;
//   switch off: the routes do not exist and nothing new is asked of the database
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootPlacementRig, PRACTICE_ID, PRACTICE_NAME, PRACTICE_EMAIL } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor, WP13_NEW_COLUMN_NAMES, wp13NewNameViolation } = require('./helpers/au-fixtures.js');
const { bannedIn, allStrings } = require('./helpers/au-banned-words.js');
const { PRODUCTION_UNIQUE_RULES } = require('./helpers/au-supabase-emulator.js');
const fees = require('../lib/au-placement-fees.js');
const lc = require('../lib/au-lifecycle.js');
const careerIntro = require('../lib/career-intro.js');

const DAY = 86400000;
let rig;
let t;
let seq = 0;
// The clock is PINNED (tests/helpers/au-wp13-clock.js): nothing below reads the
// real time, and every date is a calendar date counted from the pinned day.
const clock = require('./helpers/au-wp13-clock.js').pinWp13Clock(vi);
const T0 = clock.T0;
const at = clock.at;            // an instant on the calendar date n days from the pinned day (Sydney)
const dayAt = clock.dayAt;      // that calendar date
const setNow = clock.setNow;
const metaOf = (task) => (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}));

// Every doctor gets a surname of their own ("Wpab"), so an email to the shared
// practice address can be tied to the one doctor it is about.
function surname(n) { return 'Wp' + String.fromCharCode(97 + Math.floor(n / 26) % 26) + String.fromCharCode(97 + (n % 26)); }
function doctor(kind, overrides) {
  seq += 1;
  const o = overrides || {};
  const last = surname(seq);
  // Fixture dates that are fixed days (the indemnity expiry, 30 June 2027) are moved ahead of the pinned clock,
  // so the file means the same at whatever instant it is run.
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: String(7000 + seq) }, o, {
    profile: Object.assign({ phone: '+614007' + String(10000 + seq), last_name: last }, o.profile || {}),
    credentials: Object.assign(/^au_/.test(String(kind)) ? { indemnity_expiry: dayAt(700), registration_expiry: dayAt(700) } : {}, o.credentials || {})
  }));
  d.lastName = last;
  d.name = 'Dr ' + d.profile.first_name + ' ' + last;
  rig.addDoctor(d, o.extra);
  return d;
}
const placementOf = (d) => rig.table('placements').find((p) => p.user_id === d.userId) || null;
const caseOf = (d) => rig.caseOf(d);
const tasksOf = (d) => rig.table('registration_tasks').filter((x) => x.case_id === d.caseId);
const lifecycleTasks = (d, kind) => tasksOf(d).filter((x) => metaOf(x).lifecycle_kind && (!kind || metaOf(x).lifecycle_kind === kind));
const liveTasks = (d, kind) => lifecycleTasks(d, kind).filter((x) => metaOf(x).undone !== true);
const timelineOf = (d) => rig.table('task_timeline').filter((x) => x.case_id === d.caseId);
const nudgesOf = (d) => rig.table('gp_nudge_log').filter((x) => x.user_id === d.userId);
const toList = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
const emailsTo = (address) => rig.emails.filter((e) => toList(e && e.to).some((x) => String(x).toLowerCase().indexOf(String(address).toLowerCase()) !== -1));
const practiceAbout = (d) => emailsTo(PRACTICE_EMAIL).filter((e) => (String(e.subject) + ' ' + String(e.text)).indexOf(d.lastName) !== -1);
const ceo = () => rig.superAdmin();
const consultant = () => rig.consultant();
const call = (action, d, body, who) => rig.post('/api/admin/au/commencement/' + action, Object.assign({ case_id: d.caseId }, body || {}), who || ceo());
const view = (d, who) => rig.get('/api/admin/au/commencement?case_id=' + encodeURIComponent(d.caseId), who || ceo());

// A doctor with a placement on record (staff "Mark placement secured"). The
// placement is recorded "now"; `placedDaysAgo` moves that back so an earlier
// commencement date is valid.
async function placed(kind, opts) {
  const o = opts || {};
  const d = doctor(kind || 'au_vr', o.doctor);
  const res = await rig.place(d, 'ats_placement', o.io);
  if (o.expectPlaced !== false) expect(res.status, JSON.stringify(res.json)).toBe(200);
  const row = placementOf(d);
  if (row && o.placedDaysAgo) { row.placed_at = new Date(at(-o.placedDaysAgo)).toISOString(); row.created_at = row.placed_at; }
  // the rig's own start date is a fixed day (1 Feb 2027): keep it ahead of the pinned clock unless a case sets one
  if (row) row.start_date = Object.prototype.hasOwnProperty.call(o, 'startDate') ? o.startDate : dayAt(60);
  if (row && o.sessionsText !== undefined) row.sessions_per_week = o.sessionsText;
  return d;
}
// Finish the four pre-start tasks for the doctor's placement.
function completePrestart(d) {
  const key = placementOf(d).application_id;
  const mine = tasksOf(d).filter((x) => ['start_date_tracking', 'indemnity_certificate', 'provider_number_new_location', 'credentialing_pack'].indexOf(x.task_type) !== -1);
  mine.forEach((x) => { x.status = 'completed'; x.completed_at = new Date(T0).toISOString(); });
  if (!mine.some((x) => x.task_type === 'credentialing_pack')) {
    rig.table('registration_tasks').push({
      id: 'cred-' + d.userId.slice(-6), case_id: d.caseId, task_type: 'credentialing_pack', status: 'completed', title: 'Send the practice credentialing pack',
      related_stage: 'prestart', metadata: { au: true, placement_key: key }
    });
  }
}
// A doctor who commenced `daysAgo` days before the pinned clock.
async function commenced(opts) {
  const o = opts || {};
  const daysAgo = o.daysAgo || 0;
  const d = await placed(o.kind || 'au_vr', { placedDaysAgo: daysAgo + 30, doctor: o.doctor });
  completePrestart(d);
  const res = await call('confirm', d, { commenced_at: dayAt(-daysAgo), sessions_per_week: o.sessions === undefined ? 8 : o.sessions }, o.who);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return d;
}
const practiceRow = () => rig.table('practices').find((p) => p.id === PRACTICE_ID);
function withPractice(patch, fn) {
  const row = practiceRow();
  const before = JSON.parse(JSON.stringify(row));
  Object.keys(patch).forEach((k) => { if (patch[k] === undefined) delete row[k]; else row[k] = patch[k]; });
  return Promise.resolve().then(fn).finally(() => { Object.keys(row).forEach((k) => delete row[k]); Object.assign(row, before); });
}

beforeAll(async () => {
  rig = await bootPlacementRig({
    name: 'wp13',
    env: { LAUNCH_DEFAULT_RSO_EMAIL: 'rso.test@gplink-test.local' },
    // the unique indexes the live database has: the once-ever ledger, and WP-13's one-task-per-kind index
    emulator: { defaults: { registration_tasks: { status: 'open' }, placements: { status: 'active' } }, unique: PRODUCTION_UNIQUE_RULES }
  });
  t = rig.testUtils;
  // The fake practice e-signed the standard 2026 agreement.
  Object.assign(practiceRow(), { agreement_status: 'signed', agreement_signed_at: '2026-09-01T02:00:00.000Z', agreement_signed_by: 'Test Manager', metadata: {} });
}, 60000);
afterAll(async () => {
  if (t) t.__setAuCommencementClockForTest(null);
  clock.restore();
  if (rig) await rig.close();
});
beforeEach(() => {
  rig.setSwitch(true);
  rig.emu.forbid(null);
  rig.emu.failTables = {};
  rig.resetRecorders();
  clock.onSet((ms) => t.__setAuCommencementClockForTest(ms));
  setNow(T0);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ACCEPTANCE: confirming commencement', () => {
  it('one invoice task with the right fee from the agreement variant, three dated check-ins, and a guarantee end date 12 weeks out', async () => {
    const d = await placed('au_vr', { placedDaysAgo: 40 });
    completePrestart(d);
    rig.resetRecorders();          // the placement's own messages (N11 / N12) went when it was recorded
    const day = dayAt(-3);
    const res = await call('confirm', d, { commenced_at: day, sessions_per_week: 8 }, consultant());
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({
      ok: true, already: false, commenced_at: day, guarantee_ends_at: fees.addDays(day, 84), invoice_due_at: day, sessions_per_week: 8, prestart_override: false,
      fee: { known: true, tier: 'full_time', amount_ex_gst: 21000, variant: 'standard', basis: 'australia', reason: null }
    });
    expect(res.json.tasks.failed).toEqual([]);
    expect(res.json.tasks.created.sort()).toEqual(['guarantee_checkin:w12', 'guarantee_checkin:w4', 'guarantee_checkin:w8', 'invoice_due', 'week1_checkin']);

    // the placement row, read back
    const row = placementOf(d);
    expect(row).toMatchObject({
      commenced_at: day, commencement_confirmed_by: 'consultant.test@gplink-test.local', candidate_basis: 'australia', fee_tier: 'full_time',
      fee_amount_ex_gst: 21000, agreement_variant: 'standard', invoice_due_at: day, guarantee_ends_at: fees.addDays(day, 84),
      sessions_per_week_numeric: 8, status: 'active'
    });
    expect(fees.daysBetween(row.commenced_at, row.guarantee_ends_at)).toBe(12 * 7);
    expect(row.sessions_per_week).toBe('8');           // the free-text column is untouched
    expect(row.invoice_sent_at == null && row.invoice_paid_at == null && row.ended_at == null && row.credit_pct == null).toBe(true);

    // ONE invoice task, for the CEO, carrying the fee facts
    const invoice = lifecycleTasks(d, 'invoice_due');
    expect(invoice.length).toBe(1);
    expect(invoice[0]).toMatchObject({ task_type: 'invoice_due', status: 'open', priority: 'high', due_date: day });
    expect(invoice[0].title).toMatch(/^Raise placement-fee invoice: Dr /);
    expect(invoice[0].description).toContain('$21,000 exclusive of GST');
    expect(invoice[0].description).toContain('Standard 2026 rates');
    expect(invoice[0].description).toContain('full-time placement');
    expect(metaOf(invoice[0])).toMatchObject({ owner: 'ceo', fee_known: true, fee_tier: 'full_time', fee_amount_ex_gst: 21000, agreement_variant: 'standard', candidate_basis: 'australia', commenced_at: day });

    // THREE check-ins, dated weeks 4, 8 and 12, for the consultant
    const checkins = lifecycleTasks(d, 'guarantee_checkin').sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
    expect(checkins.length).toBe(3);
    expect(checkins.map((x) => x.task_type)).toEqual(['guarantee_checkin', 'guarantee_checkin', 'guarantee_checkin']);
    expect(checkins.map((x) => x.due_date)).toEqual([fees.addDays(day, 28), fees.addDays(day, 56), fees.addDays(day, 84)]);
    expect(checkins.map((x) => metaOf(x).week)).toEqual([4, 8, 12]);
    expect(checkins.every((x) => metaOf(x).owner === 'consultant' && x.status === 'open')).toBe(true);

    // the first-week check-in (N18's staff side)
    const week1 = lifecycleTasks(d, 'week1_checkin');
    expect(week1.length).toBe(1);
    expect(week1[0]).toMatchObject({ task_type: 'manual', due_date: fees.addDays(day, 7) });

    // the case moved prestart -> commenced, through the one stage writer
    expect(caseOf(d).stage).toBe('commenced');
    const moves = timelineOf(d).filter((x) => x.event_type === 'stage_change');
    expect(moves[moves.length - 1]).toMatchObject({ title: 'Stage advanced to commenced' });
    expect(timelineOf(d).some((x) => x.title === 'Commencement confirmed: ' + day)).toBe(true);

    // nothing is sent to anyone at this moment, and it is audited
    expect(rig.emails).toEqual([]);
    expect(rig.whatsapps).toEqual([]);
    const audit = rig.table('admin_audit_log').filter((a) => a.action === 'admin_au_confirm_commenced' && a.target_id === d.caseId);
    expect(audit.length).toBe(1);
  });

  it('the fee follows the variant the practice signed and the sessions a week (all four tiers)', async () => {
    const cases = [
      [{}, 8, 'full_time', 21000, 'standard'], [{}, 7.5, 'part_time', 18000, 'standard'],
      [{ agreement_variant: 'discounted-2026' }, 10, 'full_time', 19000, 'discounted-2026'], [{ agreement_variant: 'discounted-2026' }, 4, 'part_time', 17000, 'discounted-2026']
    ];
    for (const [metadata, sessions, tier, amount, variant] of cases) {
      await withPractice({ metadata }, async () => {
        const d = await commenced({ sessions });
        expect(placementOf(d)).toMatchObject({ fee_tier: tier, fee_amount_ex_gst: amount, agreement_variant: variant, sessions_per_week_numeric: sessions });
        const invoice = lifecycleTasks(d, 'invoice_due')[0];
        expect(invoice.description).toContain('$' + amount.toLocaleString('en-AU') + ' exclusive of GST');
        expect(metaOf(invoice)).toMatchObject({ fee_amount_ex_gst: amount, fee_tier: tier, agreement_variant: variant });
      });
    }
  });

  it('fee not knowable: the invoice task says "confirm sessions/agreement before invoicing" and asserts no dollar figure', async () => {
    // (a) the practice has no signed agreement on file
    await withPractice({ agreement_status: 'unsigned', agreement_signed_at: undefined }, async () => {
      const d = await commenced({ sessions: 8 });
      expect(placementOf(d)).toMatchObject({ fee_tier: 'full_time', fee_amount_ex_gst: null, agreement_variant: null, candidate_basis: 'australia' });
      const invoice = lifecycleTasks(d, 'invoice_due')[0];
      expect(invoice.title).toMatch(/^Confirm sessions\/agreement before invoicing: /);
      expect(allStrings(invoice)).not.toMatch(/\$\s?\d|\b(21|18|19|17),?000\b/);
      expect(metaOf(invoice)).toMatchObject({ fee_known: false, fee_amount_ex_gst: null, fee_unknown_reason: 'agreement_not_signed' });
    });
    // (b) the sessions are not known yet
    const d2 = await placed('au_vr', { placedDaysAgo: 30, sessionsText: '6-8' });
    completePrestart(d2);
    const res = await call('confirm', d2, { commenced_at: dayAt(-1), sessions_unknown: true });
    expect(res.status).toBe(200);
    expect(res.json.fee).toMatchObject({ known: false, tier: null, amount_ex_gst: null, reason: 'sessions_unknown' });
    expect(placementOf(d2)).toMatchObject({ fee_tier: null, fee_amount_ex_gst: null, sessions_per_week_numeric: null });
    const inv2 = lifecycleTasks(d2, 'invoice_due')[0];
    expect(inv2.description).toContain('Confirm sessions/agreement before invoicing');
    expect(allStrings(inv2)).not.toMatch(/\$\s?\d/);
    // (c) a paper agreement uploaded by hand, and (d) an agreement signed before the 2026 one
    await withPractice({ agreement_signed_at: undefined, agreement_manual_pdf_key: 'k' }, async () => {
      const d = await commenced({ sessions: 8 });
      expect(metaOf(lifecycleTasks(d, 'invoice_due')[0]).fee_unknown_reason).toBe('no_esignature_on_file');
      expect(placementOf(d).fee_amount_ex_gst).toBeNull();
    });
    await withPractice({ agreement_signed_at: '2026-03-01T00:00:00Z' }, async () => {
      const d = await commenced({ sessions: 8 });
      expect(metaOf(lifecycleTasks(d, 'invoice_due')[0]).fee_unknown_reason).toBe('signed_before_2026_agreement');
    });
  });

  it('running it twice changes nothing: same row, same five tasks, one stage move, one timeline line', async () => {
    const d = await commenced({ daysAgo: 2 });
    const rowBefore = JSON.stringify(placementOf(d));
    const tasksBefore = tasksOf(d).length;
    const timelineBefore = timelineOf(d).length;
    const nudgesBefore = nudgesOf(d).length;
    for (const body of [{ commenced_at: dayAt(-2), sessions_per_week: 8 }, { commenced_at: dayAt(-2) }, {}]) {
      const again = await call('confirm', d, body);
      expect(again.status, JSON.stringify(again.json)).toBe(200);
      expect(again.json).toMatchObject({ ok: true, already: true, commenced_at: dayAt(-2) });
      expect(again.json.tasks.created).toEqual([]);
      expect(again.json.tasks.existing.length).toBe(5);
    }
    expect(JSON.stringify(placementOf(d))).toBe(rowBefore);
    expect(tasksOf(d).length).toBe(tasksBefore);
    expect(timelineOf(d).length).toBe(timelineBefore);
    expect(nudgesOf(d).length).toBe(nudgesBefore);
    expect(lifecycleTasks(d, 'invoice_due').length).toBe(1);
    expect(lifecycleTasks(d, 'guarantee_checkin').length).toBe(3);
    expect(timelineOf(d).filter((x) => x.event_type === 'stage_change' && /commenced/.test(x.title)).length).toBe(1);
    // a different date is not "the same again": it is refused
    const other = await call('confirm', d, { commenced_at: dayAt(-1), sessions_per_week: 8 });
    expect(other.status).toBe(409);
    expect(other.json.code).toBe('already_commenced');
    expect(placementOf(d).commenced_at).toBe(dayAt(-2));
  });

  it('two people pressing it at once produce one commencement and one set of tasks', async () => {
    const d = await placed('au_vr', { placedDaysAgo: 20 });
    completePrestart(d);
    const both = await Promise.all([
      call('confirm', d, { commenced_at: dayAt(-1), sessions_per_week: 8 }, ceo()),
      call('confirm', d, { commenced_at: dayAt(-1), sessions_per_week: 8 }, consultant())
    ]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(lifecycleTasks(d, 'invoice_due').length).toBe(1);
    expect(lifecycleTasks(d, 'guarantee_checkin').length).toBe(3);
    expect(lifecycleTasks(d, 'week1_checkin').length).toBe(1);
    expect(timelineOf(d).filter((x) => /^Commencement confirmed: /.test(x.title)).length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('validation, the pre-start override, and who may do it', () => {
  it('the date: not in the future at the practice, not before the placement, a real date', async () => {
    const d = await placed('au_vr', { placedDaysAgo: 10 });
    completePrestart(d);
    const cases = [
      [{ commenced_at: dayAt(2), sessions_per_week: 8 }, 400, 'date_in_future'],
      [{ commenced_at: dayAt(-30), sessions_per_week: 8 }, 400, 'date_before_placement'],
      [{ commenced_at: 'yesterday', sessions_per_week: 8 }, 400, 'invalid_date'],
      [{ sessions_per_week: 8 }, 400, 'invalid_date'],
      [{ commenced_at: dayAt(-1) }, 400, 'sessions_required'],
      [{ commenced_at: dayAt(-1), sessions_per_week: 'lots' }, 400, 'invalid_sessions']
    ];
    for (const [body, status, code] of cases) {
      const res = await call('confirm', d, body);
      expect(res.status, code).toBe(status);
      expect(res.json.code, code).toBe(code);
      expect(res.json.message, code).toBeTruthy();
    }
    expect(placementOf(d).commenced_at == null).toBe(true);
    expect(lifecycleTasks(d).length).toBe(0);
    expect(caseOf(d).stage).toBe('prestart');
    // the offer's free text "8" is offered as a suggestion, never used silently
    const noSessions = await call('confirm', d, { commenced_at: dayAt(-1) });
    expect(noSessions.json.sessions_suggested).toBe(8);
  });

  it('"today" is the practice\'s own day: a Perth practice is still on yesterday in the small hours of a Sydney morning', async () => {
    const d = await placed('au_vr', { placedDaysAgo: 10 });
    completePrestart(d);
    // 16:30 UTC on some day = 03:30 next day in Sydney, 00:30 next day in Perth (AWST, +8).
    const base = Date.UTC(2027, 1, 9, 15, 30); // 02:30 on 10 Feb in Sydney (AEDT), 23:30 on 9 Feb in Perth
    placementOf(d).placed_at = new Date(base - 20 * DAY).toISOString();
    setNow(base);
    await withPractice({ location_state: 'WA' }, async () => {
      const tooSoon = await call('confirm', d, { commenced_at: '2027-02-10', sessions_per_week: 8 });
      expect(tooSoon.status).toBe(400);
      expect(tooSoon.json.code).toBe('date_in_future');
      expect(tooSoon.json.today).toBe('2027-02-09');
    });
    const sydney = await call('confirm', d, { commenced_at: '2027-02-10', sessions_per_week: 8 });
    expect(sydney.status, JSON.stringify(sydney.json)).toBe(200);
  });

  it('pre-start not complete: refused, then allowed with an explicit override and a reason, which is audited', async () => {
    const d = await placed('au_vr', { placedDaysAgo: 10 });
    const refused = await call('confirm', d, { commenced_at: dayAt(0), sessions_per_week: 8 });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('prestart_incomplete');
    expect(refused.json.prestart_open.length + refused.json.prestart_missing.length).toBeGreaterThan(0);
    expect((await call('confirm', d, { commenced_at: dayAt(0), sessions_per_week: 8, override: true, override_reason: 'short' })).status).toBe(409);
    expect(placementOf(d).commenced_at == null).toBe(true);
    const reason = 'The practice rang: she started today; indemnity upload still to come.';
    const ok = await call('confirm', d, { commenced_at: dayAt(0), sessions_per_week: 8, override: true, override_reason: reason });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.prestart_override).toBe(true);
    const line = timelineOf(d).find((x) => /^Commencement confirmed: /.test(x.title));
    expect(line.detail).toContain('NOT complete');
    expect(line.detail).toContain(reason);
    const audits = rig.table('admin_audit_log').filter((a) => a.action === 'admin_au_confirm_commenced' && a.target_id === d.caseId);
    expect(audits.length).toBe(3);
    const last = audits[audits.length - 1];
    const detail = typeof last.detail === 'string' ? JSON.parse(last.detail) : last.detail;
    expect(detail).toMatchObject({ prestart_override: true, override_reason: reason });
    expect(audits.slice(0, 2).every((a) => a.success === false)).toBe(true);
  });

  it('who: the CEO and a consultant confirm; an RSO cannot; the CEO-only actions refuse a consultant', async () => {
    const d = await placed('au_vr', { placedDaysAgo: 10 });
    completePrestart(d);
    const rsoTry = await call('confirm', d, { commenced_at: dayAt(0), sessions_per_week: 8 }, rig.rso());
    expect(rsoTry.status).toBe(403);
    expect(placementOf(d).commenced_at == null).toBe(true);
    expect((await call('confirm', d, { commenced_at: dayAt(0), sessions_per_week: 8 }, consultant())).status).toBe(200);
    for (const [action, body] of [
      ['correct', { commenced_at: dayAt(-1), reason: 'The practice gave us the wrong day.' }],
      ['undo', { reason: 'Recorded against the wrong doctor.' }],
      ['invoice-sent', { sent_at: dayAt(0), reference: 'INV-1' }],
      ['invoice-paid', { paid_at: dayAt(0) }],
      ['credit-decision', { credit_pct: 50, reason: 'Decided with the practice.' }],
      ['close', {}]
    ]) {
      const res = await call(action, d, body, consultant());
      expect(res.status, action).toBe(403);
      expect(res.json.code, action).toBe('forbidden_role');
      expect(res.json.message, action).toBe('Only the CEO can do this.');
    }
    expect(placementOf(d).commenced_at).toBe(dayAt(0));
    expect(placementOf(d).invoice_sent_at == null).toBe(true);
    // not signed in at all
    const anon = await rig.post('/api/admin/au/commencement/confirm', { case_id: d.caseId, commenced_at: dayAt(0) }, {});
    expect([401, 403]).toContain(anon.status);
  });

  it('no placement on record, an unknown case, and no case id', async () => {
    const d = doctor('au_vr');
    const res = await call('confirm', d, { commenced_at: dayAt(0), sessions_per_week: 8 });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('no_placement');
    expect((await rig.post('/api/admin/au/commencement/confirm', { case_id: '00000000-0000-4000-8000-00000000dead', commenced_at: dayAt(0) }, ceo())).status).toBe(404);
    expect((await rig.post('/api/admin/au/commencement/confirm', { commenced_at: dayAt(0) }, ceo())).status).toBe(400);
    expect((await rig.post('/api/admin/au/commencement/nope', { case_id: d.caseId }, ceo())).status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('stage moves', () => {
  it('commenced lasts the first week; a commencement confirmed more than a week late goes straight to guarantee', async () => {
    const fresh = await commenced({ daysAgo: 2 });
    expect(caseOf(fresh).stage).toBe('commenced');
    const late = await commenced({ daysAgo: 9 });
    expect(caseOf(late).stage).toBe('guarantee');
    const moves = timelineOf(late).filter((x) => x.event_type === 'stage_change').map((x) => x.title);
    expect(moves.slice(-2)).toEqual(['Stage advanced to commenced', 'Stage advanced to guarantee']);
  });

  it('the ladder still only goes forward for everyone else: a plain backward move is refused', async () => {
    const d = await commenced({ daysAgo: 9 });
    expect(await t.advanceAuCaseStage(d.caseId, 'prestart', 'staff@gplink-test.local', { reason: 'no' })).toMatchObject({ ok: false, moved: false, reason: 'backward_move' });
    expect(await t.advanceAuCaseStage(d.caseId, 'commenced', 'staff@gplink-test.local', { reason: 'no' })).toMatchObject({ ok: false, reason: 'backward_move' });
    // the undo flag opens exactly one door: to prestart, with a reason
    expect(await t.advanceAuCaseStage(d.caseId, 'placement', 'x', { undoCommencement: true, reason: 'x' })).toMatchObject({ ok: false, reason: 'backward_move' });
    expect(await t.advanceAuCaseStage(d.caseId, 'prestart', 'x', { undoCommencement: true })).toMatchObject({ ok: false, reason: 'backward_move' });
    expect(caseOf(d).stage).toBe('guarantee');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('correct commencement details (CEO)', () => {
  it('re-dates the invoice due date, the guarantee end and the open tasks; leaves a completed one alone', async () => {
    const d = await commenced({ daysAgo: 5 });
    const was = dayAt(-5);
    const now = dayAt(-3);
    const week1 = lifecycleTasks(d, 'week1_checkin')[0];
    week1.status = 'completed';
    const res = await call('correct', d, { commenced_at: now, reason: 'The practice confirmed she started two days later.' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ commenced_at: now, previous_commenced_at: was, guarantee_ends_at: fees.addDays(now, 84) });
    expect(placementOf(d)).toMatchObject({ commenced_at: now, invoice_due_at: now, guarantee_ends_at: fees.addDays(now, 84), fee_amount_ex_gst: 21000 });
    expect(lifecycleTasks(d, 'guarantee_checkin').map((x) => x.due_date).sort()).toEqual([fees.addDays(now, 28), fees.addDays(now, 56), fees.addDays(now, 84)]);
    expect(lifecycleTasks(d, 'invoice_due')[0].due_date).toBe(now);
    expect(lifecycleTasks(d, 'week1_checkin')[0].due_date).toBe(fees.addDays(was, 7));     // completed: not touched
    expect(lifecycleTasks(d).length).toBe(5);                                               // nothing new
    const line = timelineOf(d).find((x) => x.title === 'Commencement details corrected');
    expect(line.detail).toContain(was + ' -> ' + now);
    expect(rig.table('admin_audit_log').some((a) => a.action === 'admin_au_correct_commencement' && a.target_id === d.caseId && a.success === true)).toBe(true);
    expect(caseOf(d).stage).toBe('commenced');
  });

  it('correcting the sessions recomputes the fee from the agreement and rewrites the open invoice task', async () => {
    const d = await commenced({ daysAgo: 2, sessions: 8 });
    const res = await call('correct', d, { sessions_per_week: 6, reason: 'She is working six sessions, not eight.' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(placementOf(d)).toMatchObject({ sessions_per_week_numeric: 6, fee_tier: 'part_time', fee_amount_ex_gst: 18000, commenced_at: dayAt(-2) });
    const invoice = lifecycleTasks(d, 'invoice_due')[0];
    expect(invoice.description).toContain('$18,000 exclusive of GST');
    expect(invoice.description).not.toContain('$21,000');
  });

  it('refuses: no reason, a future date, nothing changed, sessions after the invoice went, not commenced', async () => {
    const d = await commenced({ daysAgo: 2 });
    expect((await call('correct', d, { commenced_at: dayAt(-1) })).json.code).toBe('reason_required');
    expect((await call('correct', d, { commenced_at: dayAt(3), reason: 'A reason that is long enough.' })).json.code).toBe('date_in_future');
    expect((await call('correct', d, { commenced_at: dayAt(-2), reason: 'A reason that is long enough.' })).json.code).toBe('nothing_to_change');
    await call('invoice-sent', d, { sent_at: dayAt(-1), reference: 'INV-7' });
    expect((await call('correct', d, { sessions_per_week: 5, reason: 'A reason that is long enough.' })).json.code).toBe('invoice_already_sent');
    const fresh = await placed('au_vr');
    expect((await call('correct', fresh, { commenced_at: dayAt(0), reason: 'A reason that is long enough.' })).json.code).toBe('not_commenced');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('commencement recorded in error (CEO)', () => {
  it('clears the commencement, cancels the derived tasks and returns the case to pre-start, audited', async () => {
    const d = await commenced({ daysAgo: 9 });
    expect(caseOf(d).stage).toBe('guarantee');
    const res = await call('undo', d, { reason: 'Recorded against the wrong Dr Auvr: she starts next month.' });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ undone: true, previous_commenced_at: dayAt(-9) });
    expect(res.json.cancelled.sort()).toEqual(['guarantee_checkin:w12', 'guarantee_checkin:w4', 'guarantee_checkin:w8', 'invoice_due', 'week1_checkin:w1']);
    const row = placementOf(d);
    for (const k of ['commenced_at', 'commencement_confirmed_by', 'fee_tier', 'fee_amount_ex_gst', 'agreement_variant', 'invoice_due_at', 'guarantee_ends_at', 'candidate_basis']) expect(row[k], k).toBeNull();
    expect(row.status).toBe('active');
    expect(row.sessions_per_week_numeric).toBe(8);            // a fact about the role, kept
    expect(lifecycleTasks(d).every((x) => x.status === 'cancelled' && metaOf(x).undone === true)).toBe(true);
    expect(caseOf(d).stage).toBe('prestart');
    const back = timelineOf(d).filter((x) => x.event_type === 'stage_change').pop();
    expect(back.title).toBe('Stage returned to prestart (commencement recorded in error)');
    const backMeta = typeof back.metadata === 'string' ? JSON.parse(back.metadata) : back.metadata;
    expect(backMeta).toMatchObject({ from_stage: 'guarantee', to_stage: 'prestart', correction: 'commencement_recorded_in_error' });
    expect(timelineOf(d).some((x) => x.title === 'Commencement recorded in error: undone')).toBe(true);
    expect(rig.table('admin_audit_log').some((a) => a.action === 'admin_au_undo_commencement' && a.target_id === d.caseId && a.success === true)).toBe(true);

    // the staff view is back to "confirm commenced", and confirming again makes a fresh set
    const v = await view(d);
    expect(v.json.can).toMatchObject({ confirm: true, undo: false, correct: false });
    expect(v.json.tasks).toEqual([]);
    const again = await call('confirm', d, { commenced_at: dayAt(0), sessions_per_week: 8 });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json.tasks.created.length).toBe(5);
    expect(liveTasks(d, 'invoice_due').length).toBe(1);
    expect(liveTasks(d, 'guarantee_checkin').map((x) => x.due_date).sort()).toEqual([fees.addDays(dayAt(0), 28), fees.addDays(dayAt(0), 56), fees.addDays(dayAt(0), 84)]);
    expect(caseOf(d).stage).toBe('commenced');
  });

  it('refuses without a reason, once an invoice is recorded as sent, and when nothing was commenced', async () => {
    const d = await commenced({ daysAgo: 2 });
    expect((await call('undo', d, {})).json.code).toBe('reason_required');
    await call('invoice-sent', d, { sent_at: dayAt(-1), reference: 'INV-9' });
    const res = await call('undo', d, { reason: 'Recorded against the wrong doctor.' });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('invoice_already_sent');
    expect(placementOf(d).commenced_at).toBe(dayAt(-2));
    // the "sent" record was itself a mistake: clear it, then the undo goes through
    expect((await call('invoice-sent', d, { clear: true, reason: 'Marked sent on the wrong case.' })).status).toBe(200);
    expect(placementOf(d).invoice_sent_at).toBeNull();
    expect(lifecycleTasks(d, 'invoice_due')[0].status).toBe('open');
    expect((await call('undo', d, { reason: 'Recorded against the wrong doctor.' })).status).toBe(200);
    const fresh = await placed('au_vr');
    expect((await call('undo', fresh, { reason: 'Recorded against the wrong doctor.' })).json.code).toBe('not_commenced');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('invoice tracking (CEO). Nothing is issued by code.', () => {
  it('sent (date + reference) closes the invoice task; paid records the date; both are idempotent', async () => {
    const d = await commenced({ daysAgo: 6 });
    rig.resetRecorders();
    // the invoice task cannot simply be ticked off: it is finished by recording the invoice as sent
    const tick = await rig.put('/api/admin/task?id=' + encodeURIComponent(lifecycleTasks(d, 'invoice_due')[0].id), { status: 'completed' }, ceo());
    expect(tick.status).toBe(409);
    expect(tick.json.code).toBe('au_task_needs_its_action');
    expect(tick.json.message).toContain('Mark invoice sent');
    expect(lifecycleTasks(d, 'invoice_due')[0].status).toBe('open');
    // a check-in, on the other hand, is finished by a person saying so
    const checkin = lifecycleTasks(d, 'guarantee_checkin')[0];
    expect((await rig.put('/api/admin/task?id=' + encodeURIComponent(checkin.id), { status: 'completed' }, ceo())).status).toBe(200);
    const sent = await call('invoice-sent', d, { sent_at: dayAt(-5), reference: '  INV-0042 ' });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    expect(sent.json).toMatchObject({ invoice_sent_at: dayAt(-5), invoice_reference: 'INV-0042', payment_due_by: fees.addDays(dayAt(-5), 7), task_closed: true });
    expect(placementOf(d)).toMatchObject({ invoice_sent_at: dayAt(-5), invoice_reference: 'INV-0042', fee_amount_ex_gst: 21000 });
    expect(lifecycleTasks(d, 'invoice_due')[0].status).toBe('completed');
    const lines = timelineOf(d).length;
    const again = await call('invoice-sent', d, { sent_at: dayAt(-5), reference: 'INV-0042' });
    expect(again.json).toMatchObject({ ok: true, unchanged: true });
    expect(timelineOf(d).length).toBe(lines);

    const paid = await call('invoice-paid', d, { paid_at: dayAt(-1) });
    expect(paid.status, JSON.stringify(paid.json)).toBe(200);
    expect(paid.json).toMatchObject({ invoice_paid_at: dayAt(-1), paid_late: false });
    expect(placementOf(d).invoice_paid_at).toBe(dayAt(-1));
    expect((await call('invoice-paid', d, { paid_at: dayAt(-1) })).json.unchanged).toBe(true);
    const v = await view(d);
    expect(v.json.state.invoice).toBe('paid');
    expect(v.json.can).toMatchObject({ invoice_sent: false, invoice_paid: false, undo: false });
    // no request left the server for an accounting system: only the database was touched
    expect(rig.emails).toEqual([]);
    expect(rig.whatsapps).toEqual([]);
  });

  it('refuses nonsense: no reference, a date before commencement or in the future, paid before sent, paid before the invoice date', async () => {
    const d = await commenced({ daysAgo: 4 });
    expect((await call('invoice-sent', d, { sent_at: dayAt(-1) })).json.code).toBe('reference_required');
    expect((await call('invoice-sent', d, { sent_at: dayAt(-8), reference: 'INV-1' })).json.code).toBe('date_before_commencement');
    expect((await call('invoice-sent', d, { sent_at: dayAt(1), reference: 'INV-1' })).json.code).toBe('date_in_future');
    expect((await call('invoice-paid', d, { paid_at: dayAt(0) })).json.code).toBe('invoice_not_sent');
    await call('invoice-sent', d, { sent_at: dayAt(-2), reference: 'INV-1' });
    expect((await call('invoice-paid', d, { paid_at: dayAt(-3) })).json.code).toBe('date_before_invoice');
    expect((await call('invoice-paid', d, { paid_at: 'soon' })).json.code).toBe('invalid_date');
    expect(placementOf(d).invoice_paid_at == null).toBe(true);
    const fresh = await placed('au_vr');
    expect((await call('invoice-sent', fresh, { sent_at: dayAt(0), reference: 'INV-2' })).json.code).toBe('not_commenced');
  });

  it('a fee the app could not work out: the amount the CEO invoiced may be recorded by hand, and only then', async () => {
    await withPractice({ agreement_status: 'unsigned', agreement_signed_at: undefined }, async () => {
      const d = await commenced({ daysAgo: 2 });
      expect(placementOf(d).fee_amount_ex_gst).toBeNull();
      const res = await call('invoice-sent', d, { sent_at: dayAt(-1), reference: 'INV-77', amount_ex_gst: '$20,500' });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(placementOf(d)).toMatchObject({ fee_amount_ex_gst: 20500, agreement_variant: null });
      expect(timelineOf(d).some((x) => /entered by hand/.test(String(x.detail || '')))).toBe(true);
    });
    const d2 = await commenced({ daysAgo: 2 });
    const res2 = await call('invoice-sent', d2, { sent_at: dayAt(-1), reference: 'INV-78', amount_ex_gst: 15000 });
    expect(res2.status).toBe(409);
    expect(res2.json.code).toBe('amount_differs_from_agreement');
    expect(placementOf(d2).fee_amount_ex_gst).toBe(21000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('early exit: the doctor left during the guarantee', () => {
  // Commenced `daysAgo` days ago, invoice sent on the day and paid on time.
  async function settled(daysAgo, opts) {
    const d = await commenced({ daysAgo, sessions: (opts && opts.sessions) || 8 });
    if (!opts || opts.invoice !== 'none') {
      expect((await call('invoice-sent', d, { sent_at: dayAt(-daysAgo), reference: 'INV-' + seq })).status).toBe(200);
      if (!opts || opts.invoice !== 'unpaid') {
        const paidOn = opts && opts.paidAfterDays !== undefined ? dayAt(-daysAgo + opts.paidAfterDays) : dayAt(-daysAgo + 3);
        expect((await call('invoice-paid', d, { paid_at: paidOn })).status).toBe(200);
      }
    }
    return d;
  }

  it.each([[20, 15, 80], [50, 40, 50], [80, 70, 35]])('commenced %s days ago, last working day at day %s: %s%% from the schedule', async (daysAgo, lastAt, pct) => {
    const d = await settled(daysAgo);
    const lastDay = dayAt(-daysAgo + lastAt);
    rig.resetRecorders();
    const res = await call('early-exit', d, { last_working_day: lastDay, reason: 'doctor_resigned', conditions_confirmed: 'yes', note: 'Family reasons.' }, consultant());
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.credit).toMatchObject({ known: true, credit_pct: pct, reason: 'schedule', schedule_band_pct: pct, days_worked: lastAt });
    expect(placementOf(d)).toMatchObject({ ended_at: lastDay, credit_pct: pct, status: 'ended', end_reason: 'doctor_resigned: Family reasons.' });
    // the check-ins still to come are cancelled; the completed invoice task is not touched
    expect(lifecycleTasks(d, 'guarantee_checkin').every((x) => x.status === 'cancelled')).toBe(true);
    expect(lifecycleTasks(d, 'invoice_due')[0].status).toBe('completed');
    // ONE "replacement or credit" task for the CEO
    const exit = lifecycleTasks(d, 'replacement_or_credit');
    expect(exit.length).toBe(1);
    expect(exit[0].title).toMatch(/^Replacement or credit: Dr /);
    expect(exit[0].description).toContain(pct + '% of the placement fee');
    expect(metaOf(exit[0])).toMatchObject({ owner: 'ceo', credit_known: true, credit_pct: pct });
    expect(caseOf(d).stage).toBe('complete');
    // the doctor may look for a role again (WP-08 reads ended_at)
    expect(await t.auPlacedReentryAllowed(d.userId)).toMatchObject({ allowed: true });
    // nothing is sent to the doctor or the practice about it
    expect(rig.emails).toEqual([]);
  });

  it('a condition that cannot be checked: credit_pct stays null and the CEO gets a decision task; never a guessed number', async () => {
    const cases = [
      [{ reason: 'doctor_resigned', conditions_confirmed: 'unknown' }, {}, 'conditions_not_confirmed'],
      [{ reason: 'doctor_resigned' }, {}, 'conditions_not_confirmed'],
      [{ reason: 'practice_side', conditions_confirmed: 'yes' }, {}, 'discretionary_or_excluded_reason'],
      [{ reason: 'other', conditions_confirmed: 'yes' }, {}, 'reason_unknown'],
      [{ reason: 'doctor_resigned', conditions_confirmed: 'yes' }, { invoice: 'none' }, 'invoice_not_sent']
    ];
    for (const [body, opts, code] of cases) {
      const d = await settled(20, opts);
      const res = await call('early-exit', d, Object.assign({ last_working_day: dayAt(-5) }, body));
      expect(res.status, code + ' ' + JSON.stringify(res.json)).toBe(200);
      expect(res.json.credit.known, code).toBe(false);
      expect(res.json.credit.credit_pct, code).toBeNull();
      expect(res.json.credit.needs_decision, code).toContain(code);
      expect(placementOf(d).credit_pct, code).toBeNull();
      expect(placementOf(d).ended_at, code).toBe(dayAt(-5));
      const exit = lifecycleTasks(d, 'replacement_or_credit');
      expect(exit.length, code).toBe(1);
      expect(exit[0].title, code).toMatch(/^Decide the guarantee credit/);
      expect(metaOf(exit[0]), code).toMatchObject({ owner: 'ceo', credit_known: false, credit_pct: null });
    }
  });

  it('forfeited when the invoice was paid late or is unpaid past seven days; nothing after the twelve weeks', async () => {
    const late = await settled(30, { paidAfterDays: 12 });
    const r1 = await call('early-exit', late, { last_working_day: dayAt(-10), reason: 'doctor_resigned', conditions_confirmed: 'yes' });
    expect(r1.json.credit).toMatchObject({ known: true, credit_pct: 0, reason: 'forfeited_invoice_overdue' });
    expect(placementOf(late).credit_pct).toBe(0);
    expect(lifecycleTasks(late, 'replacement_or_credit')[0].title).toContain('guarantee forfeited');

    const unpaid = await settled(30, { invoice: 'unpaid' });
    const r2 = await call('early-exit', unpaid, { last_working_day: dayAt(-10), reason: 'doctor_resigned', conditions_confirmed: 'yes' });
    expect(r2.json.credit).toMatchObject({ known: true, credit_pct: 0, reason: 'forfeited_invoice_overdue' });

    const after = await settled(100);
    const r3 = await call('early-exit', after, { last_working_day: dayAt(-10), reason: 'doctor_resigned', conditions_confirmed: 'yes' });
    expect(r3.json.credit).toMatchObject({ known: true, credit_pct: 0, reason: 'outside_guarantee_period' });
  });

  it('the CEO records the decision; it is idempotent; validation', async () => {
    const d = await settled(20);
    expect((await call('early-exit', d, { reason: 'doctor_resigned' })).json.code).toBe('invalid_date');
    expect((await call('early-exit', d, { last_working_day: dayAt(-5) })).json.code).toBe('reason_required');
    expect((await call('early-exit', d, { last_working_day: dayAt(2), reason: 'doctor_resigned' })).json.code).toBe('date_in_future');
    expect((await call('early-exit', d, { last_working_day: dayAt(-25), reason: 'doctor_resigned' })).json.code).toBe('date_before_commencement');
    expect((await call('credit-decision', d, { credit_pct: 50, reason: 'Decided with the practice.' })).json.code).toBe('not_ended');
    const first = await call('early-exit', d, { last_working_day: dayAt(-5), reason: 'practice_side' });
    expect(first.status).toBe(200);
    const tasks = tasksOf(d).length;
    const again = await call('early-exit', d, { last_working_day: dayAt(-5), reason: 'practice_side' });
    expect(again.json).toMatchObject({ ok: true, already: true, ended_at: dayAt(-5), credit_pct: null });
    expect(tasksOf(d).length).toBe(tasks);
    expect((await call('early-exit', d, { last_working_day: dayAt(-4), reason: 'practice_side' })).json.code).toBe('already_ended');

    expect((await call('credit-decision', d, { credit_pct: 120, reason: 'Decided with the practice.' })).json.code).toBe('invalid_credit');
    expect((await call('credit-decision', d, { credit_pct: 50 })).json.code).toBe('reason_required');
    const decided = await call('credit-decision', d, { credit_pct: 50, reason: 'Clause 7.3: at our discretion, agreed with the practice.' });
    expect(decided.status, JSON.stringify(decided.json)).toBe(200);
    expect(placementOf(d).credit_pct).toBe(50);
    expect(metaOf(lifecycleTasks(d, 'replacement_or_credit')[0])).toMatchObject({ credit_known: true, credit_pct: 50, credit_reason: 'decided_by_staff' });
    // an ended placement cannot be confirmed, corrected or undone
    expect((await call('confirm', d, { commenced_at: dayAt(0), sessions_per_week: 8 })).json.code).toBe('placement_not_active');
    expect((await call('correct', d, { commenced_at: dayAt(-19), reason: 'A reason that is long enough.' })).json.code).toBe('placement_ended');
    expect((await call('undo', d, { reason: 'A reason that is long enough.' })).json.code).toBe('placement_ended');
  });

  it('an ended placement is not brought back to life as the doctor\'s current placement', async () => {
    const d = await settled(20);
    await call('early-exit', d, { last_working_day: dayAt(-5), reason: 'doctor_resigned', conditions_confirmed: 'yes' });
    // the application still reads "placement secured", but there is no current placement
    const session = await rig.get('/api/gp/au-prestart', { cookie: rig.gpCookie(d.email, d.userId) });
    expect(session.status).toBe(200);
    expect(session.json).toMatchObject({ placementEnded: true, endedPracticeName: PRACTICE_NAME, started: false, items: [] });
    expect(JSON.stringify(session.json)).not.toMatch(/credit|invoice|fee_|guarantee|doctor_resigned/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('close case at the end of the guarantee period (CEO)', () => {
  it('refused before the period has ended; the day after, the case is complete', async () => {
    const d = await commenced({ daysAgo: 84 });
    const early = await call('close', d, {});
    expect(early.status).toBe(409);
    expect(early.json.code).toBe('guarantee_not_ended');
    expect(caseOf(d).stage).toBe('guarantee');
    setNow(at(1));
    const ok = await call('close', d, {});
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(caseOf(d).stage).toBe('complete');
    expect(placementOf(d).status).toBe('active');
    expect(placementOf(d).ended_at == null).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the daily lifecycle job, walked with a pinned clock', () => {
  const fired = (run) => run.fired.map((f) => f.kind + (f.week ? ':w' + f.week : '') + (f.month ? ':m' + f.month : '') + (f.mark && !f.week && !f.month ? '' : ''));
  const mine = (run, d) => ({ fired: run.fired.filter((f) => f.user_id === d.userId) });

  it('one placement from pre-start through week 12 and months 6 and 12: each reminder once, at the right time, to the right party', async () => {
    // Placed today (T0); the start date is 20 days out; part-time (6 sessions).
    const startDay = dayAt(20);
    const d = await placed('au_vr', { startDate: startDay });
    const key = placementOf(d).application_id;
    rig.resetRecorders();
    // CHANGED in WP-16 (quiet hours, COM-22): the walk ran the job at the
    // pinned time of day (00:37 in Sydney) and expected N18 / N19 / N20 to go
    // then. Lifecycle messages are now only sent between 08:00 and 20:00 on
    // the practice's clock, so the walk runs the job inside those hours on the
    // same calendar date (what the in-hours run does). The deferral itself is
    // pinned in "quiet hours" below.
    const sweep = async (days) => mine(await t.runAuLifecycleSweep(clock.atHours(days)), d);
    const twice = async (days) => { const a = await sweep(days); const b = await sweep(days); expect(fired(b), 'second run on day ' + days).toEqual([]); return a; };

    // day 1: within 28 days of the start with no notice recorded -> the consultant is asked
    expect(fired(await twice(1))).toEqual(['notice_not_recorded']);
    expect(liveTasks(d, 'notice_not_recorded').map((x) => metaOf(x).owner)).toEqual(['consultant']);
    // day 6: 14 days before the start with pre-start unfinished -> the RSO
    expect(fired(await twice(6))).toEqual(['prestart_at_risk']);
    expect(liveTasks(d, 'prestart_at_risk').map((x) => [metaOf(x).owner, x.priority, metaOf(x).mark])).toEqual([['rso', 'high', 'd14']]);
    // 14 calendar days after the day the placement was recorded: the provider number is still pending -> the open task is escalated
    expect(fired(await sweep(13))).toEqual([]);
    expect(fired(await twice(14))).toEqual(['provider_number_pending']);
    const provider = tasksOf(d).find((x) => x.task_type === 'provider_number_new_location');
    expect(provider.priority).toBe('high');
    expect(timelineOf(d).some((x) => /^Provider number still pending 14 days/.test(x.title))).toBe(true);
    // day 17: three days to go
    expect(fired(await twice(17))).toEqual(['prestart_at_risk']);
    expect(liveTasks(d, 'prestart_at_risk').length).toBe(2);
    // day 20: the start date is reached and commencement is not confirmed -> the consultant is prompted (row 12)
    expect(fired(await twice(20))).toEqual(['start_date_reached']);
    const prompt = liveTasks(d, 'start_date_reached');
    expect(prompt.length).toBe(1);
    expect(prompt[0].title).toMatch(/^Confirm commenced: Dr /);
    expect(metaOf(prompt[0])).toMatchObject({ owner: 'consultant', checklist_row: 12 });
    // days 21 and 22: nothing new (the prompt is not repeated)
    expect(fired(await sweep(21))).toEqual([]);
    expect(fired(await sweep(22))).toEqual([]);
    // nothing has been sent to the doctor or the practice by any of that
    // (WP-17 added the Australian stalled reminder, N17, to the allowed list:
    // "Before you start: ... waiting on you" goes 14 days after the placement
    // when something is still waiting on the doctor.)
    expect(emailsTo(d.email).filter((e) => !/Needed before you start|A few things|Before you start: /.test(String(e.subject)))).toEqual([]);
    expect(practiceAbout(d).filter((e) => !/^Placement confirmed/.test(String(e.subject)))).toEqual([]);

    // day 22: the consultant confirms she started on the start date (pre-start not finished: override)
    setNow(at(22));
    const confirmed = await call('confirm', d, { commenced_at: startDay, sessions_per_week: 6, override: true, override_reason: 'The practice confirmed by phone that she started on the day.' }, consultant());
    expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
    expect(placementOf(d)).toMatchObject({ commenced_at: startDay, fee_tier: 'part_time', fee_amount_ex_gst: 18000 });
    expect(liveTasks(d, 'start_date_reached')[0].status).toBe('completed');     // the prompt closed by itself
    // ... and so did the other reminders from before the start: they are answered by the fact that she started
    expect(liveTasks(d, 'notice_not_recorded').map((x) => x.status)).toEqual(['completed']);
    expect(liveTasks(d, 'prestart_at_risk').map((x) => x.status)).toEqual(['completed', 'completed']);
    expect(caseOf(d).stage).toBe('commenced');
    rig.resetRecorders();
    const C = 20;                                                                // commencement, in days from T0

    // day C+6: nothing yet
    expect(fired(await sweep(C + 6))).toEqual([]);
    // week 1: the case moves to guarantee; N18 to the doctor and the practice
    const w1 = await twice(C + 7);
    expect(fired(w1)).toEqual(['stage_guarantee', 'week1_checkin']);
    expect(caseOf(d).stage).toBe('guarantee');
    expect(emailsTo(d.email).map((e) => e.subject)).toEqual(['How was your first week?']);
    expect(practiceAbout(d).map((e) => e.subject)).toEqual([d.name + ': first week check-in']);
    expect(rig.whatsapps).toEqual([]);                                           // no approved Australian template: skipped
    expect(timelineOf(d).some((x) => x.title === 'First-week check-in sent (N18)' && /WhatsApp skipped \(au_template_not_approved\)/.test(x.detail))).toBe(true);
    // weeks 4, 8, 12: N19 to both, once each
    for (const week of [4, 8, 12]) {
      rig.resetRecorders();
      const run = await twice(C + week * 7);
      expect(fired(run).filter((k) => /guarantee_checkin/.test(k)), 'week ' + week).toEqual(['guarantee_checkin:w' + week]);
      expect(emailsTo(d.email).map((e) => e.subject), 'week ' + week).toEqual(['Checking in: ' + week + ' weeks at ' + PRACTICE_NAME]);
      expect(practiceAbout(d).length, 'week ' + week).toBe(1);
      expect(practiceAbout(d)[0].subject).toBe(d.name + ': week ' + week + ' check-in');
    }
    // 14 days before the end: the consultant is reminded (it fired with the day-70 run or at week 12; exactly one task)
    await sweep(C + 71);
    expect(liveTasks(d, 'guarantee_ending').length).toBe(1);
    expect(metaOf(liveTasks(d, 'guarantee_ending')[0])).toMatchObject({ owner: 'consultant', guarantee_ends_at: fees.addDays(startDay, 84) });
    // the three dated check-in tasks from commencement are still the only three
    expect(liveTasks(d, 'guarantee_checkin').length).toBe(3);
    // the last day of the period: not closed yet
    await sweep(C + 84);
    expect(caseOf(d).stage).toBe('guarantee');
    // the day after: case complete, N20 to the doctor only
    rig.resetRecorders();
    const end = await twice(C + 85);
    expect(fired(end)).toEqual(['guarantee_ended', 'referral_ask']);
    expect(caseOf(d).stage).toBe('complete');
    expect(emailsTo(d.email).map((e) => e.subject)).toEqual(['Twelve weeks in: thank you']);
    expect(practiceAbout(d)).toEqual([]);
    // months 6 and 12: the part-time check for the CEO, stating no amount
    rig.resetRecorders();
    const m6day = fees.daysBetween(dayAt(0), fees.addMonths(startDay, 6));
    expect(fired(await sweep(m6day - 1))).toEqual([]);
    expect(fired(await twice(m6day))).toEqual(['part_time_uplift:m6']);
    const m12day = fees.daysBetween(dayAt(0), fees.addMonths(startDay, 12));
    expect(fired(await twice(m12day))).toEqual(['part_time_uplift:m12']);
    const uplift = liveTasks(d, 'part_time_uplift');
    expect(uplift.map((x) => metaOf(x).month)).toEqual([6, 12]);
    expect(uplift.every((x) => metaOf(x).owner === 'ceo' && !/\$|\d\s?%/.test(allStrings(x)))).toBe(true);
    expect(emailsTo(d.email).concat(practiceAbout(d))).toEqual([]);              // a staff reminder only
    // a year and a bit on: the job has stopped looking
    expect(fired(await sweep(m12day + 60))).toEqual([]);

    // every doctor-facing message over the whole walk: no banned word, nothing commercial
    const nudges = nudgesOf(d).map((n) => n.nudge_key + '|' + n.channel);
    expect(new Set(nudges).size).toBe(nudges.length);                           // every ledger claim is unique
    expect(nudges.filter((n) => /au_n18_week1_gp:/.test(n)).sort()).toEqual(['au_n18_week1_gp:' + key + '|bell', 'au_n18_week1_gp:' + key + '|email']);
    const bell = rig.capture(d).bell.filter((b) => /first week|check-in|Twelve weeks/i.test(String(b.title)));
    expect(bell.map((b) => b.title).sort()).toEqual(['How was your first week?', 'Twelve weeks in: thank you', 'Week 12 check-in', 'Week 4 check-in', 'Week 8 check-in']);
    bell.forEach((b) => {
      expect(bannedIn(allStrings(b))).toEqual([]);
      expect(allStrings(b)).not.toMatch(/guarantee|invoice|\bfee\b|credit|\$\s?\d|\d\s?%/i);
    });
  });

  // WP-16 (COM-22, walk finding R10).
  it('quiet hours: at the daily host\'s hour (early morning in Australia) the first-week check-in is HELD, not sent and not claimed; the in-hours run sends it, once', async () => {
    const d = await commenced({ daysAgo: 0, sessions: 8 });
    rig.resetRecorders();
    const day = 7;
    // 20:30 UTC the evening before is 07:30 on that date in Sydney: the hour sla-sweep runs.
    const hostHour = clock.atHours(day) - 3.5 * 3600000;
    expect(new Date(hostHour).getUTCHours() + ':' + new Date(hostHour).getUTCMinutes()).toBe('20:30');
    for (let i = 0; i < 2; i++) {
      const early = await t.runAuLifecycleSweep(hostHour);
      const mineFired = early.fired.filter((f) => f.user_id === d.userId);
      // The stage still moves and the staff tasks are untouched: only the MESSAGE waits.
      expect(mineFired.map((f) => f.kind).filter((k) => k !== 'stage_guarantee')).toEqual(['deferred_quiet_hours']);
      expect(mineFired.find((f) => f.kind === 'deferred_quiet_hours')).toMatchObject({ held: 'week1_checkin', local_time: '07:30', zone: 'Australia/Sydney' });
      expect(early.deferred_quiet_hours).toBeGreaterThanOrEqual(1);
    }
    expect(caseOf(d).stage).toBe('guarantee');
    expect(emailsTo(d.email)).toEqual([]);
    expect(practiceAbout(d)).toEqual([]);
    expect(timelineOf(d).some((x) => x.title === 'First-week check-in sent (N18)')).toBe(false);
    // Three and a half hours later 08:00 has arrived everywhere in Australia: it goes, to both, once.
    const inHours = await t.runAuLifecycleSweep(clock.atHours(day));
    expect(inHours.fired.filter((f) => f.user_id === d.userId).map((f) => f.kind)).toEqual(['week1_checkin']);
    expect(inHours.deferred_quiet_hours || 0).toBe(0);
    expect(emailsTo(d.email).map((e) => e.subject)).toEqual(['How was your first week?']);
    expect(practiceAbout(d).length).toBe(1);
    await t.runAuLifecycleSweep(clock.atHours(day) + 3600000);
    await t.runAuLifecycleSweep(hostHour + 86400000);
    expect(emailsTo(d.email).length).toBe(1);
    expect(practiceAbout(d).length).toBe(1);
  });

  it('quiet hours: the in-hours run is hosted by an hourly job, on the first two ticks after 08:00 everywhere in Australia, and never with the switch off', async () => {
    const day = clock.atHours(30);
    // Outside those two ticks the pass does nothing (and reads nothing).
    expect(await t.runAuLifecycleInHoursPass(day - 3.5 * 3600000)).toBeNull();     // 20:30 UTC, the daily host's own hour
    expect(await t.runAuLifecycleInHoursPass(day + 2 * 3600000)).toBeNull();       // the third hour of the window
    const first = await t.runAuLifecycleInHoursPass(day);
    expect(first).toMatchObject({ ok: true });
    expect(Array.isArray(first.fired)).toBe(true);
    expect((await t.runAuLifecycleInHoursPass(day + 3600000)).ok).toBe(true);      // the second tick: a safety net
    rig.setSwitch(false);
    try { expect(await t.runAuLifecycleInHoursPass(day)).toBeNull(); }
    finally { rig.setSwitch(true); }
    const handler = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
    const block = handler.slice(handler.indexOf("pathname === '/api/cron/onboarding-nudge'"), handler.indexOf("pathname === '/api/cron/onboarding-nudge'") + 12000);
    expect(block).toContain('await runAuLifecycleInHoursPass(Date.now())');
  });

  it('everything the walk sends the doctor is clean, and the practice hears only what the agreement says', async () => {
    const d = await commenced({ daysAgo: 0, sessions: 8 });
    rig.resetRecorders();
    // CHANGED in WP-16: run inside the hours (see the walk above).
    for (const days of [7, 28, 56, 84, 85]) await t.runAuLifecycleSweep(clock.atHours(days));
    const toDoctor = emailsTo(d.email);
    expect(toDoctor.map((e) => e.subject)).toEqual([
      'How was your first week?', 'Checking in: 4 weeks at ' + PRACTICE_NAME, 'Checking in: 8 weeks at ' + PRACTICE_NAME,
      'Checking in: 12 weeks at ' + PRACTICE_NAME, 'Twelve weeks in: thank you'
    ]);
    toDoctor.forEach((e) => {
      const all = [e.subject, e.text, e.html].join('\n');
      expect(bannedIn(all), e.subject).toEqual([]);
      expect(all.replace(/<style[\s\S]*?<\/style>/g, ''), e.subject).not.toMatch(/guarantee|invoice|placement fee|\bfees?\b|credit|refund|\$\s?\d|\d{1,3}\s?%\s|agreement|clause \d/i);
    });
    const toPractice = practiceAbout(d);
    expect(toPractice.length).toBe(4);                                           // N18 and three N19; N20 is the doctor's only
    toPractice.forEach((e) => {
      const all = [e.subject, e.text].join('\n');
      expect(careerIntro.auPracticeTextViolations(all), e.subject).toEqual([]);
      expect(all, e.subject).not.toMatch(/\$\s?\d|\d\s?%|credit|refund|invoice|\bfee\b/i);
    });
    expect(rig.whatsapps).toEqual([]);
  });

  it('an invoice sent and unpaid past its seven days is flagged to the CEO once, and closes when paid', async () => {
    const d = await commenced({ daysAgo: 0 });
    await call('invoice-sent', d, { sent_at: dayAt(0), reference: 'INV-0099' });
    expect((await t.runAuLifecycleSweep(at(7))).fired.filter((f) => f.user_id === d.userId && f.kind === 'invoice_overdue')).toEqual([]);
    const run = await t.runAuLifecycleSweep(at(8));
    expect(run.fired.filter((f) => f.user_id === d.userId && f.kind === 'invoice_overdue').length).toBe(1);
    await t.runAuLifecycleSweep(at(9));
    const overdue = liveTasks(d, 'invoice_overdue');
    expect(overdue.length).toBe(1);
    expect(metaOf(overdue[0]).owner).toBe('ceo');
    expect(overdue[0].description).toContain('INV-0099');
    expect(allStrings(overdue[0])).not.toMatch(/\$\s?\d|\d\s?%/);
    setNow(at(10));
    await call('invoice-paid', d, { paid_at: dayAt(10) });
    expect(liveTasks(d, 'invoice_overdue')[0].status).toBe('completed');
  });

  it('a doctor who left early gets no more check-ins, no closing message and no part-time reminder', async () => {
    const d = await commenced({ daysAgo: 0, sessions: 6 });
    await t.runAuLifecycleSweep(at(7));
    setNow(at(20));
    expect((await call('early-exit', d, { last_working_day: dayAt(18), reason: 'doctor_resigned' })).status).toBe(200);
    rig.resetRecorders();
    for (const days of [28, 56, 84, 85, 200, 370]) {
      const run = await t.runAuLifecycleSweep(at(days));
      expect(run.fired.filter((f) => f.user_id === d.userId), 'day ' + days).toEqual([]);
    }
    expect(emailsTo(d.email)).toEqual([]);
    expect(liveTasks(d, 'part_time_uplift')).toEqual([]);
  });

  it('the job also runs the yearly Ahpra re-check and the pre-start pass, and `sla-sweep` is where it is called from', async () => {
    const run = await t.runAuLifecycleSweep(at(0));
    expect(run.ok).toBe(true);
    expect(run.au_ahpra_recheck).toBeTruthy();
    expect(run.au_prestart).toMatchObject({ ok: true });
    const res = await rig.get('/api/cron/sla-sweep', { headers: { Authorization: 'Bearer test-cron-secret' } });
    expect(res.status, res.raw).toBe(200);
    expect(res.json).toHaveProperty('au_ahpra_recheck');
    expect(res.json.au_prestart).toMatchObject({ ok: true });
    expect(res.json.au_lifecycle).toMatchObject({ ok: true });
    expect(Array.isArray(res.json.au_lifecycle.fired)).toBe(true);
    // switch off: the response is what it always was (no Australian keys)
    rig.setSwitch(false);
    const off = await rig.get('/api/cron/sla-sweep', { headers: { Authorization: 'Bearer test-cron-secret' } });
    expect(off.status).toBe(200);
    expect(Object.keys(off.json).sort()).toEqual(['buckets', 'checked', 'created', 'ok']);
    rig.setSwitch(true);
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
    const handler = src.slice(src.indexOf("pathname === '/api/cron/sla-sweep'"), src.indexOf("pathname === '/api/cron/sla-sweep'") + 4000);
    expect(handler).toContain('await runAuLifecycleSweep(Date.now())');
    expect(handler).not.toContain('runAuAhpraRecheckSweep(');
    expect(handler).not.toContain('runAuPrestartSweep(');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('what staff and the doctor are shown', () => {
  it('the staff view: a fee preview before commencement, the commercial state after it, and buttons by role', async () => {
    const d = await placed('au_vr', { placedDaysAgo: 10 });
    const before = await view(d, consultant());
    expect(before.status).toBe(200);
    expect(before.json).toMatchObject({ role: 'consultant', stage: 'prestart', fee_preview: { known: false, reason: 'sessions_unknown', variant: 'standard', variant_known: true } });
    expect(before.json.placement).toMatchObject({ sessions_text: '8', sessions_suggested: 8, sessions_per_week_numeric: null, commenced_at: null });
    expect(before.json.prestart.complete).toBe(false);
    expect(before.json.can).toMatchObject({ confirm: true, correct: false, undo: false, invoice_sent: false, early_exit: false });
    completePrestart(d);
    await call('confirm', d, { commenced_at: dayAt(-1), sessions_per_week: 8 });
    const asCeo = await view(d, ceo());
    expect(asCeo.json.placement).toMatchObject({ commenced_at: dayAt(-1), fee_tier: 'full_time', fee_amount_ex_gst: 21000, agreement_variant_label: 'Standard 2026 rates', guarantee_ends_at: fees.addDays(dayAt(-1), 84) });
    expect(asCeo.json.state).toMatchObject({ commenced: true, invoice: 'due', inGuarantee: true, guaranteeDaysLeft: 83 });
    expect(asCeo.json.can).toMatchObject({ confirm: false, correct: true, undo: true, invoice_sent: true, invoice_paid: false, early_exit: true, close: false });
    expect(asCeo.json.tasks.length).toBe(5);
    const asConsultant = await view(d, consultant());
    expect(asConsultant.json.can).toMatchObject({ confirm: false, correct: false, undo: false, invoice_sent: false, early_exit: true });
    const asRso = await view(d, rig.rso());
    if (asRso.status === 200) expect(Object.values(asRso.json.can).every((v) => v === false)).toBe(true);
    else expect(asRso.status).toBe(403);
  });

  it('the doctor\'s pre-start page says "you have started" after commencement, with nothing commercial in it', async () => {
    const d = await placed('au_vr', { placedDaysAgo: 10 });
    const cookie = { cookie: rig.gpCookie(d.email, d.userId) };
    const before = await rig.get('/api/gp/au-prestart', cookie);
    expect(before.json).toMatchObject({ started: false, startedOn: null });
    expect(before.json.items.find((x) => x.key === 'start_date').title).toBe('Start date confirmed');
    completePrestart(d);
    await call('confirm', d, { commenced_at: dayAt(-1), sessions_per_week: 8 });
    const after = await rig.get('/api/gp/au-prestart', cookie);
    expect(after.status).toBe(200);
    expect(after.json).toMatchObject({ started: true, startedOn: dayAt(-1), stage: 'commenced', stageLabel: 'Started', startDate: dayAt(-1), startDateConfirmed: true });
    const item = after.json.items.find((x) => x.key === 'start_date');
    expect(item).toMatchObject({ title: 'You have started', status: 'done', started: true });
    expect(item.whatToDo).toContain('You started at ' + PRACTICE_NAME + ' on ' + dayAt(-1));
    expect(after.json.steps.every((s) => s.state === 'done')).toBe(true);
    const all = JSON.stringify(after.json);
    expect(bannedIn(allStrings(after.json))).toEqual([]);
    expect(all).not.toMatch(/guarantee|invoice|fee_|21000|21,000|credit|agreement_variant|fee_tier/i);
    // the session's journey block follows
    const session = await rig.get('/api/auth/session', cookie);
    expect(session.json.auJourney.stage).toBe('commenced');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('exports (ADM-30), switch on', () => {
  it('placements and GPs gain pathway, fee, commencement, invoice and guarantee columns, with the values on file', async () => {
    const d = await commenced({ daysAgo: 3, sessions: 8 });
    await call('invoice-sent', d, { sent_at: dayAt(-2), reference: 'INV-EXP-1' });
    const pl = await rig.get('/api/admin/export?entity=placements&format=csv', ceo());
    expect(pl.status).toBe(200);
    const lines = pl.raw.split('\r\n');
    expect(lines[0]).toBe('GP,Practice,Role,Location,Secured,Commencement,Pathway,Candidate based in,Sessions per week,Fee tier,Fee (ex GST),Agreement variant,Commenced (actual),Invoice due,Invoice sent,Invoice reference,Invoice paid,Guarantee ends,Ended (last working day),End reason,Credit %');
    const mine = lines.find((l) => l.indexOf('INV-EXP-1') !== -1);
    expect(mine).toBeTruthy();
    expect(mine).toContain(['au_vr', 'australia', '8', 'full_time', '21000', 'standard', dayAt(-3), dayAt(-3), dayAt(-2), 'INV-EXP-1', '', fees.addDays(dayAt(-3), 84), '', '', ''].join(','));
    const gps = await rig.get('/api/admin/export?entity=gps&format=csv', ceo());
    expect(gps.status).toBe(200);
    const gLines = gps.raw.split('\r\n');
    expect(gLines[0]).toBe('Name,Email,Country,Registration stage,Assigned RSO,Created,Pathway,Commenced (actual),Fee tier,Fee (ex GST),Invoice,Guarantee ends');
    const gMine = gLines.find((l) => l.indexOf(d.email) !== -1);
    expect(gMine).toContain(['au_vr', dayAt(-3), 'full_time', '21000', 'sent', fees.addDays(dayAt(-3), 84)].join(','));
    // CEO only, as today
    expect([401, 403]).toContain((await rig.get('/api/admin/export?entity=placements&format=csv', consultant())).status);
  });

  it('switch off: the same two exports have exactly today\'s columns', async () => {
    await commenced({ daysAgo: 1 });
    rig.setSwitch(false);
    const pl = await rig.get('/api/admin/export?entity=placements&format=csv', ceo());
    expect(pl.raw.split('\r\n')[0]).toBe('GP,Practice,Role,Location,Secured,Commencement');
    const gps = await rig.get('/api/admin/export?entity=gps&format=csv', ceo());
    expect(gps.raw.split('\r\n')[0]).toBe('Name,Email,Country,Registration stage,Assigned RSO,Created');
    expect(pl.raw + gps.raw).not.toMatch(/au_vr|full_time|21000|INV-/);
  });

  it('the WP-27 read function: invoices due, in guarantee, ending within 14 days', async () => {
    const a = await commenced({ daysAgo: 75 });
    const summary = await t.auPlacementCommercialSummary(at(0));
    expect(summary.ok).toBe(true);
    const due = summary.invoicesDue.find((x) => x.user_id === a.userId);
    expect(due).toMatchObject({ invoice: 'due', fee_tier: 'full_time', fee_amount_ex_gst: 21000 });
    expect(summary.inGuarantee.some((x) => x.user_id === a.userId)).toBe(true);
    expect(summary.guaranteeEndingSoon.some((x) => x.user_id === a.userId)).toBe(true);
    expect(summary.counts.inGuarantee).toBe(summary.inGuarantee.length);
    rig.setSwitch(false);
    const off = await t.auPlacementCommercialSummary(at(0));
    expect(off).toMatchObject({ ok: false, invoicesDue: [], inGuarantee: [], guaranteeEndingSoon: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('overseas parity: an overseas placement gets none of this', () => {
  for (const kind of ['overseas_null', 'overseas_explicit']) {
    it(kind + ', switch ON: every action answers 409 and the placement, tasks and case are untouched; the daily job leaves them alone', async () => {
      const d = await placed(kind, { placedDaysAgo: 30, startDate: dayAt(-5) });
      const row = placementOf(d);
      expect(row).toBeTruthy();
      const rowBefore = JSON.stringify(row);
      const tasksBefore = JSON.stringify(tasksOf(d));
      const stageBefore = caseOf(d).stage;
      const timelineBefore = timelineOf(d).length;
      rig.resetRecorders();
      const v = await view(d);
      expect(v.status).toBe(409);
      expect(v.json.code).toBe('not_au_pathway');
      for (const [action, body] of [
        ['confirm', { commenced_at: dayAt(-1), sessions_per_week: 8, override: true, override_reason: 'A reason that is long enough.' }],
        ['correct', { commenced_at: dayAt(-2), reason: 'A reason that is long enough.' }],
        ['undo', { reason: 'A reason that is long enough.' }],
        ['invoice-sent', { sent_at: dayAt(0), reference: 'INV-X' }],
        ['invoice-paid', { paid_at: dayAt(0) }],
        ['early-exit', { last_working_day: dayAt(0), reason: 'doctor_resigned' }],
        ['credit-decision', { credit_pct: 80, reason: 'A reason that is long enough.' }],
        ['close', {}]
      ]) {
        const res = await call(action, d, body);
        expect(res.status, action).toBe(409);
        expect(res.json.code, action).toBe('not_au_pathway');
      }
      // the daily job, over a year: start date already passed, and still nothing
      for (const days of [0, 1, 7, 14, 28, 56, 84, 85, 200, 370]) {
        const run = await t.runAuLifecycleSweep(at(days));
        expect(run.fired.filter((f) => f.user_id === d.userId), 'day ' + days).toEqual([]);
      }
      // even a commencement date that somehow sat on an overseas row is not acted on
      row.commenced_at = dayAt(-10);
      row.guarantee_ends_at = fees.addDays(dayAt(-10), 84);
      row.fee_tier = 'part_time';
      for (const days of [0, 30, 80, 200, 370]) {
        const run = await t.runAuLifecycleSweep(at(days));
        expect(run.fired.filter((f) => f.user_id === d.userId), 'stray day ' + days).toEqual([]);
        expect(run.skipped_not_au).toBeGreaterThan(0);
      }
      delete row.commenced_at; delete row.guarantee_ends_at; delete row.fee_tier;
      expect(JSON.stringify(placementOf(d))).toBe(rowBefore);
      expect(JSON.stringify(tasksOf(d))).toBe(tasksBefore);
      expect(caseOf(d).stage).toBe(stageBefore);
      expect(timelineOf(d).length).toBe(timelineBefore);
      expect(lifecycleTasks(d)).toEqual([]);
      expect(emailsTo(d.email)).toEqual([]);
      expect(rig.whatsapps).toEqual([]);
      expect(nudgesOf(d).filter((n) => /au_lc:|au_n1[89]|au_n20|lc_/.test(n.nudge_key))).toEqual([]);
    });
  }

  it('switch OFF: the routes do not exist for anyone, the job does nothing, and no request names a WP-13 column', async () => {
    const au = await commenced({ daysAgo: 30, sessions: 6 });
    const uk = await placed('overseas_null', { placedDaysAgo: 30 });
    const rowAu = JSON.stringify(placementOf(au));
    const rowUk = JSON.stringify(placementOf(uk));
    const tasksAu = tasksOf(au).length;
    rig.setSwitch(false);
    rig.resetRecorders();
    rig.emu.forbid(wp13NewNameViolation);
    const start = rig.emu.requests.length;
    for (const d of [au, uk]) {
      expect((await view(d)).status).toBe(404);
      for (const action of ['confirm', 'correct', 'undo', 'invoice-sent', 'invoice-paid', 'early-exit', 'credit-decision', 'close']) {
        const res = await call(action, d, { commenced_at: dayAt(-1), sessions_per_week: 8, reason: 'A reason that is long enough.', sent_at: dayAt(0), reference: 'X', paid_at: dayAt(0), last_working_day: dayAt(0) });
        expect(res.status, action).toBe(404);
      }
    }
    const run = await t.runAuLifecycleSweep(at(40));
    expect(run).toMatchObject({ ok: false, reason: 'feature_off', fired: [] });
    expect(await t.auPlacementCommercialSummary(at(40))).toMatchObject({ ok: false });
    await rig.get('/api/admin/export?entity=placements&format=csv', ceo());
    await rig.get('/api/admin/export?entity=gps&format=csv', ceo());
    expect(rig.emu.violations).toEqual([]);
    // nothing about a placement was read by the commencement routes or the job at all
    const asked = rig.emu.requests.slice(start).filter((r) => r.table === 'gp_nudge_log' || r.table === 'registration_tasks');
    expect(asked).toEqual([]);
    expect(JSON.stringify(placementOf(au))).toBe(rowAu);
    expect(JSON.stringify(placementOf(uk))).toBe(rowUk);
    expect(tasksOf(au).length).toBe(tasksAu);
    expect(rig.emails).toEqual([]);
    rig.emu.forbid(null);
  });

  it('the guard list names every WP-13 column', () => {
    const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'supabase/migrations/20261121110000_au_gp_wp13_placement_commercials.sql'), 'utf8');
    const added = Array.from(sql.matchAll(/add column if not exists (\w+)/g)).map((m) => m[1]).sort();
    expect(added.length).toBe(15);
    expect(WP13_NEW_COLUMN_NAMES.placements.slice().sort()).toEqual(added);
  });
});

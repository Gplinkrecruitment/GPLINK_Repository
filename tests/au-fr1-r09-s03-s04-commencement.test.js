// Fix bundle FR-1 (final review), on the real server with a pinned clock:
//   R-09  staff can record that a placed doctor has given notice
//   S-03  the start date is validated, and a confirmed one can be corrected
//   S-04  fee, invoice and credit figures go to the CEO only
//   S-11  "Request item" reports success only when something was sent
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootPlacementRig, PRACTICE_ID, PRACTICE_NAME, PRACTICE_EMAIL } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');
const { PRODUCTION_UNIQUE_RULES } = require('./helpers/au-supabase-emulator.js');
const fees = require('../lib/au-placement-fees.js');
const lifecycle = require('../lib/au-lifecycle.js');
const commencementUi = (() => { require('../js/au-commencement.js'); return globalThis.GPAuCommencement; })();
const prestartUi = require('../js/au-prestart.js');

let rig;
let t;
let seq = 0;
const clock = require('./helpers/au-wp13-clock.js').pinWp13Clock(vi);
const T0 = clock.T0;
const at = clock.at;
const dayAt = clock.dayAt;
const metaOf = (task) => (typeof task.metadata === 'string' ? JSON.parse(task.metadata) : (task.metadata || {}));

function doctor(kind, overrides) {
  seq += 1;
  const o = overrides || {};
  const last = 'Fr' + String.fromCharCode(97 + Math.floor(seq / 26) % 26) + String.fromCharCode(97 + (seq % 26));
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: String(8000 + seq) }, o, {
    profile: Object.assign({ phone: '+614008' + String(10000 + seq), last_name: last }, o.profile || {}),
    credentials: Object.assign(/^au_/.test(String(kind)) ? { indemnity_expiry: dayAt(700), registration_expiry: dayAt(700) } : {}, o.credentials || {})
  }));
  d.lastName = last;
  rig.addDoctor(d, o.extra);
  return d;
}
const placementOf = (d) => rig.table('placements').find((p) => p.user_id === d.userId) || null;
const tasksOf = (d) => rig.table('registration_tasks').filter((x) => x.case_id === d.caseId);
const lifecycleTasks = (d, kind) => tasksOf(d).filter((x) => metaOf(x).lifecycle_kind && (!kind || metaOf(x).lifecycle_kind === kind));
const timelineOf = (d) => rig.table('task_timeline').filter((x) => x.case_id === d.caseId);
const toList = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
const emailsTo = (address) => rig.emails.filter((e) => toList(e && e.to).some((x) => String(x).toLowerCase().indexOf(String(address).toLowerCase()) !== -1));
const practiceAbout = (d) => emailsTo(PRACTICE_EMAIL).filter((e) => (String(e.subject) + ' ' + String(e.text)).indexOf(d.lastName) !== -1);
const ceo = () => rig.superAdmin();
const consultant = () => rig.consultant();
const call = (action, d, body, who) => rig.post('/api/admin/au/commencement/' + action, Object.assign({ case_id: d.caseId }, body || {}), who || ceo());
const view = (d, who) => rig.get('/api/admin/au/commencement?case_id=' + encodeURIComponent(d.caseId), who || ceo());
const startDate = (d, body, who) => rig.post('/api/admin/au/prestart/start-date', Object.assign({ case_id: d.caseId }, body), who || ceo());

async function placed(kind, opts) {
  const o = opts || {};
  const d = doctor(kind || 'au_vr', o.doctor);
  const res = await rig.place(d, 'ats_placement');
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const row = placementOf(d);
  if (row && o.placedDaysAgo) { row.placed_at = new Date(at(-o.placedDaysAgo)).toISOString(); row.created_at = row.placed_at; }
  if (row) row.start_date = Object.prototype.hasOwnProperty.call(o, 'startDate') ? o.startDate : dayAt(60);
  return d;
}
function completePrestart(d) {
  rig.approvePrestartDocuments(d);
  const key = placementOf(d).application_id;
  const mine = tasksOf(d).filter((x) => ['start_date_tracking', 'indemnity_certificate', 'provider_number_new_location', 'credentialing_pack'].indexOf(x.task_type) !== -1);
  mine.forEach((x) => { x.status = 'completed'; x.completed_at = new Date(T0).toISOString(); });
  if (!mine.some((x) => x.task_type === 'credentialing_pack')) {
    rig.table('registration_tasks').push({ id: 'cred-' + d.userId.slice(-6), case_id: d.caseId, task_type: 'credentialing_pack', status: 'completed', title: 'Send the practice credentialing pack', related_stage: 'prestart', metadata: { au: true, placement_key: key } });
  }
}
async function commenced(daysAgo, who) {
  const d = await placed('au_vr', { placedDaysAgo: daysAgo + 30 });
  completePrestart(d);
  const res = await call('confirm', d, { commenced_at: dayAt(-daysAgo), sessions_per_week: 8 }, who);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return d;
}
const practiceRow = () => rig.table('practices').find((p) => p.id === PRACTICE_ID);
async function settle() { let last = -1; for (let n = 0; n < 60; n++) { const seen = rig.emu.requests.length + rig.emails.length; if (seen === last) return; last = seen; await new Promise((r) => setTimeout(r, 40)); } }
async function sweepOn(day) {
  const ms = clock.atHours(day);
  t.__setAuCommencementClockForTest(ms);
  try { return await t.runAuLifecycleSweep(ms); } finally { t.__setAuCommencementClockForTest(null); }
}

beforeAll(async () => {
  rig = await bootPlacementRig({
    name: 'fr1-r09', env: { LAUNCH_DEFAULT_RSO_EMAIL: 'rso.test@gplink-test.local' },
    emulator: { defaults: { registration_tasks: { status: 'open' }, placements: { status: 'active' } }, unique: PRODUCTION_UNIQUE_RULES }
  });
  t = rig.testUtils;
  Object.assign(practiceRow(), { agreement_status: 'signed', agreement_signed_at: '2026-09-01T02:00:00.000Z', agreement_signed_by: 'Test Manager', metadata: {} });
}, 60000);
afterAll(async () => { if (t) t.__setAuCommencementClockForTest(null); clock.restore(); if (rig) await rig.close(); });
beforeEach(async () => {
  rig.setSwitch(true);
  rig.emu.forbid(null);
  rig.emu.failTables = {};
  let last = -1;
  for (let n = 0; n < 200; n++) { const seen = rig.emu.requests.length; if (seen === last) break; last = seen; await new Promise((r) => setTimeout(r, 40)); }
  rig.emu.reset();
}, 30000);

// ─────────────────────────────────────────────────────────────────────────────
describe('R-09: notice given (a last working day still to come)', () => {
  it('"Doctor left" with a future last working day is still refused, and now says to use "Notice given"', async () => {
    const d = await commenced(10);
    const res = await call('early-exit', d, { last_working_day: dayAt(14), reason: 'doctor_resigned' }, consultant());
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ ok: false, code: 'date_in_future', use: 'notice' });
    expect(res.json.message).toMatch(/Notice given/);
    expect(placementOf(d).ended_at == null).toBe(true);
  });

  it('recorded by a consultant: one task, shown on the staff card, nothing ended, nothing sent', async () => {
    const d = await commenced(10);
    rig.resetRecorders();
    const last = dayAt(18);
    const res = await call('notice', d, { last_working_day: last, reason: 'doctor_resigned', note: 'Moving interstate.' }, consultant());
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ ok: true, already: false, notice: { last_working_day: last, reason: 'doctor_resigned', note: 'Moving interstate.' } });
    const tasks = lifecycleTasks(d, 'exit_notice_given');
    expect(tasks.length).toBe(1);
    expect(tasks[0]).toMatchObject({ status: 'open', due_date: last, task_type: 'manual' });
    expect(tasks[0].title).toMatch(/^Notice given: Dr .* last working day /);
    expect(metaOf(tasks[0])).toMatchObject({ last_working_day: last, exit_reason: 'doctor_resigned', owner: 'consultant' });
    expect(placementOf(d)).toMatchObject({ status: 'active' });
    expect(placementOf(d).ended_at == null).toBe(true);
    expect(res.json.view.notice).toMatchObject({ last_working_day: last, reason: 'doctor_resigned' });
    expect(res.json.view.can).toMatchObject({ notice: true, notice_withdraw: true });
    expect(timelineOf(d).some((x) => x.title === 'Notice given: last working day ' + last)).toBe(true);
    expect(rig.emails.length).toBe(0);
    // again, the same: nothing new; a new date: the same task, re-dated
    expect((await call('notice', d, { last_working_day: last, reason: 'doctor_resigned', note: 'Moving interstate.' })).json.already).toBe(true);
    const moved = await call('notice', d, { last_working_day: dayAt(25), reason: 'doctor_resigned' });
    expect(moved.json).toMatchObject({ ok: true, updated: true });
    expect(lifecycleTasks(d, 'exit_notice_given').length).toBe(1);
    expect(lifecycleTasks(d, 'exit_notice_given')[0].due_date).toBe(dayAt(25));
  });

  it('validation: a day already reached is "Doctor left" (as today); before commencement, no reason, not commenced, and roles', async () => {
    const d = await commenced(10);
    expect((await call('notice', d, { last_working_day: dayAt(0), reason: 'doctor_resigned' })).json).toMatchObject({ ok: false, code: 'date_reached', use: 'early-exit' });
    expect((await call('notice', d, { last_working_day: dayAt(-3), reason: 'doctor_resigned' })).json.code).toBe('date_reached');
    expect((await call('notice', d, { last_working_day: dayAt(-30), reason: 'doctor_resigned' })).json.code).toBe('date_before_commencement');
    expect((await call('notice', d, { last_working_day: dayAt(9) })).json.code).toBe('reason_required');
    expect((await call('notice', d, { last_working_day: '2027-02-31', reason: 'doctor_resigned' })).json.code).toBe('invalid_date');
    expect((await call('notice', d, { last_working_day: dayAt(9), reason: 'doctor_resigned' }, rig.rso())).status).toBe(403);
    expect(lifecycleTasks(d, 'exit_notice_given')).toEqual([]);
    const notStarted = await placed('au_vr');
    expect((await call('notice', notStarted, { last_working_day: dayAt(9), reason: 'doctor_resigned' })).json.code).toBe('not_commenced');
    // a past date through "Doctor left" behaves exactly as it did
    const left = await call('early-exit', d, { last_working_day: dayAt(-1), reason: 'doctor_resigned', conditions_confirmed: 'unknown' });
    expect(left.status).toBe(200);
    expect(placementOf(d)).toMatchObject({ status: 'ended', ended_at: dayAt(-1) });
  });

  it('the reviewer\'s case: with notice on file the "How is it going?" and thank-you emails stop; without it they still go', async () => {
    const leaving = await commenced(20);       // week 4 falls on day 8 from now
    const staying = await commenced(20);
    await call('notice', leaving, { last_working_day: dayAt(40), reason: 'doctor_resigned' }, consultant());
    rig.resetRecorders();
    const out = await sweepOn(8);
    expect(out.ok).toBe(true);
    expect(out.paused_for_notice).toBeGreaterThanOrEqual(1);
    expect(emailsTo(leaving.email)).toEqual([]);
    expect(practiceAbout(leaving)).toEqual([]);
    expect(emailsTo(staying.email).length).toBeGreaterThan(0);
    // the staff check-in task for the leaving doctor is still there (staff may still call); only the messages pause
    expect(lifecycleTasks(leaving, 'guarantee_checkin').length).toBe(3);
    expect(rig.table('gp_nudge_log').filter((x) => x.user_id === leaving.userId && /w4/.test(String(x.nudge_key))).length).toBe(0);
  });

  it('withdrawn: the messages resume', async () => {
    const d = await commenced(20);
    await call('notice', d, { last_working_day: dayAt(40), reason: 'doctor_resigned' });
    expect((await call('notice', d, { clear: true })).json.code).toBe('reason_required');
    const w = await call('notice', d, { clear: true, reason: 'The doctor has decided to stay.' }, consultant());
    expect(w.json).toMatchObject({ ok: true, cleared: true });
    expect(w.json.view.notice).toBeNull();
    expect(lifecycleTasks(d, 'exit_notice_given')[0].status).toBe('cancelled');
    rig.resetRecorders();
    await sweepOn(8);
    expect(emailsTo(d.email).length).toBeGreaterThan(0);
    // and a new notice can be recorded afterwards
    expect((await call('notice', d, { last_working_day: dayAt(50), reason: 'doctor_resigned' })).status).toBe(200);
    expect(lifecycleTasks(d, 'exit_notice_given').filter((x) => x.status === 'open').length).toBe(1);
  });

  it('on the last working day the daily job records the exit, with the credit rules exactly as built', async () => {
    const d = await commenced(10);
    const last = dayAt(5);          // 15 days after commencement: the first band of the schedule
    await call('notice', d, { last_working_day: last, reason: 'doctor_resigned', note: 'Family reasons.' }, consultant());
    rig.resetRecorders();
    const before = await sweepOn(4);
    expect(before.notice_exits || 0).toBe(0);
    expect(placementOf(d).status).toBe('active');
    const out = await sweepOn(5);
    expect(out.notice_exits).toBe(1);
    const row = placementOf(d);
    expect(row).toMatchObject({ status: 'ended', ended_at: last, end_reason: 'doctor_resigned: Family reasons.' });
    // the same answer "Doctor left" gives for these facts (no invoice sent yet: a person decides, never a guess)
    const expected = fees.guaranteeCreditFor({ commencedAt: dayAt(-10), lastWorkingDay: last, reason: 'doctor_resigned', invoiceSentAt: null, invoicePaidAt: null, conditionsConfirmed: 'unknown', asOf: last });
    expect(row.credit_pct == null ? null : Number(row.credit_pct)).toBe(expected.known ? expected.creditPct : null);
    expect(lifecycleTasks(d, 'replacement_or_credit').length).toBe(1);
    expect(lifecycleTasks(d, 'guarantee_checkin').every((x) => x.status === 'cancelled')).toBe(true);
    expect(lifecycleTasks(d, 'exit_notice_given')[0].status).toBe('completed');
    expect(rig.caseOf(d).stage).toBe('complete');
    // nothing was sent to the doctor or the practice by the exit
    expect(emailsTo(d.email)).toEqual([]);
    // a second run does nothing more
    const again = await sweepOn(6);
    expect(again.notice_exits || 0).toBe(0);
    expect(lifecycleTasks(d, 'replacement_or_credit').length).toBe(1);
  });

  it('staff can confirm the exit themselves on the day; the notice then closes', async () => {
    const d = await commenced(10);
    await call('notice', d, { last_working_day: dayAt(3), reason: 'doctor_resigned' });
    t.__setAuCommencementClockForTest(clock.atHours(3));
    try {
      const res = await call('early-exit', d, { last_working_day: dayAt(3), reason: 'doctor_resigned', conditions_confirmed: 'unknown' }, consultant());
      expect(res.status, JSON.stringify(res.json)).toBe(200);
    } finally { t.__setAuCommencementClockForTest(null); }
    expect(placementOf(d)).toMatchObject({ status: 'ended', ended_at: dayAt(3) });
    expect(lifecycleTasks(d, 'exit_notice_given')[0].status).toBe('completed');
  });

  it('the doctor\'s own view says so truthfully: the date only, never the reason or the note', async () => {
    const d = await commenced(10);
    const cookie = { cookie: rig.gpCookie(d.email, d.userId) };
    expect((await rig.get('/api/gp/au-prestart', cookie)).json.leaving).toBeNull();
    await call('notice', d, { last_working_day: dayAt(18), reason: 'performance_terminated', note: 'STAFF ONLY NOTE' });
    const res = await rig.get('/api/gp/au-prestart', cookie);
    expect(res.json.leaving).toEqual({ lastWorkingDay: dayAt(18) });
    expect(res.raw).not.toMatch(/STAFF ONLY NOTE|performance_terminated|exit_reason/);
    const html = prestartUi._homeHtml(res.json);
    expect(html).toContain('Your last working day at');
    expect(html).not.toMatch(/will check in with you/);
    expect(prestartUi._leavingHtml({ leaving: null })).toBe('');
  });

  it('the staff card: the buttons and the forms', () => {
    const v = { ok: true, role: 'consultant', today: dayAt(0), exit_reasons: [{ value: 'doctor_resigned', label: 'The doctor resigned' }], commercial_hidden: true,
      placement: { practice_name: PRACTICE_NAME, commenced_at: dayAt(-10), guarantee_ends_at: dayAt(74), fee_amount_ex_gst: null, credit_pct: null },
      state: { commenced: true, inGuarantee: true, guaranteeDaysLeft: 74 }, tasks: [],
      notice: { last_working_day: dayAt(18), reason: 'doctor_resigned', note: '' },
      can: { notice: true, notice_withdraw: true, early_exit: true } };
    const html = commencementUi._viewHtml(v, '');
    expect(html).toContain('Notice given');
    expect(html).toContain('Check-in messages are paused');
    expect(html).toContain('data-auc-open="notice"');
    expect(html).toContain('data-auc-open="notice-withdraw"');
    const form = commencementUi._formHtml('notice', v);
    expect(form).toContain('name="last_working_day" min="' + dayAt(0) + '"');
    expect(form).toContain('name="reason"');
    expect(commencementUi._formHtml('notice-withdraw', v)).toContain('name="reason"');
    // S-04 on the same card: no figure, and it says why
    expect(html).toContain('Shown to the CEO only');
    expect(html).not.toMatch(/\$\s?\d/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('S-04: fee, invoice and credit figures are the CEO\'s', () => {
  const FIGURE_KEYS = ['fee', 'fee_preview', 'fee_tier', 'fee_amount_ex_gst', 'amount_ex_gst', 'agreement_variant', 'agreement_variant_label', 'candidate_basis',
    'invoice', 'invoice_due_at', 'invoice_sent_at', 'invoice_paid_at', 'invoice_reference', 'invoice_payment_due_by', 'invoiceDueAt', 'invoiceSentAt', 'invoicePaidAt',
    'credit', 'credit_pct', 'schedule_band_pct'];
  function figures(value, trail, out) {
    const acc = out || [];
    if (Array.isArray(value)) value.forEach((v, i) => figures(v, trail + '[' + i + ']', acc));
    else if (value && typeof value === 'object') Object.keys(value).forEach((k) => {
      if (FIGURE_KEYS.indexOf(k) !== -1 && value[k] !== null && value[k] !== undefined) acc.push(trail + '.' + k + '=' + JSON.stringify(value[k]));
      else figures(value[k], trail + '.' + k, acc);
    });
    return acc;
  }

  it('the reviewer\'s reproduction: GET the commencement view as a consultant: no fee amount, tier, invoice field or credit; the CEO sees them', async () => {
    const d = await commenced(10);
    await call('invoice-sent', d, { sent_at: dayAt(-3), reference: 'INV-FAKE-0001' });
    const asCeo = await view(d, ceo());
    expect(asCeo.json.placement).toMatchObject({ fee_amount_ex_gst: 21000, fee_tier: 'full_time', invoice_reference: 'INV-FAKE-0001', invoice_sent_at: dayAt(-3) });
    expect(asCeo.json.state.invoice).toBe('sent');
    expect(asCeo.json.commercial_hidden).toBeUndefined();
    expect(asCeo.json.tasks.some((x) => x.kind === 'invoice_due')).toBe(true);

    for (const who of [consultant()]) {
      const res = await view(d, who);
      expect(res.status).toBe(200);
      expect(figures(res.json, 'view')).toEqual([]);
      expect(res.json.commercial_hidden).toBe(true);
      expect(res.raw).not.toMatch(/21000|INV-FAKE-0001/);
      // dates, stage and tasks are still there
      expect(res.json.placement).toMatchObject({ commenced_at: dayAt(-10), guarantee_ends_at: fees.addDays(dayAt(-10), 84), practice_name: PRACTICE_NAME });
      expect(res.json.state).toMatchObject({ commenced: true, inGuarantee: true });
      expect(res.json.stage).toBeTruthy();
      expect(res.json.tasks.length).toBe(4);     // the three check-ins and the first-week task
      expect(res.json.tasks.some((x) => lifecycle.CEO_COMMERCIAL_KINDS.indexOf(x.kind) !== -1)).toBe(false);
    }
  });

  it('every action a consultant may run answers without a figure, in the result and in the view that comes with it', async () => {
    const d = await placed('au_vr', { placedDaysAgo: 40 });
    completePrestart(d);
    const confirm = await call('confirm', d, { commenced_at: dayAt(-20), sessions_per_week: 8 }, consultant());
    expect(confirm.status).toBe(200);
    expect(figures(confirm.json, 'confirm')).toEqual([]);
    expect(confirm.raw).not.toMatch(/21000/);
    expect(placementOf(d).fee_amount_ex_gst).toBe(21000);   // worked out and stored all the same
    const notice = await call('notice', d, { last_working_day: dayAt(9), reason: 'doctor_resigned' }, consultant());
    expect(figures(notice.json, 'notice')).toEqual([]);
    await call('notice', d, { clear: true, reason: 'Recorded on the wrong doctor.' }, consultant());
    const exit = await call('early-exit', d, { last_working_day: dayAt(-5), reason: 'doctor_resigned', conditions_confirmed: 'yes' }, consultant());
    expect(exit.status).toBe(200);
    expect(figures(exit.json, 'exit')).toEqual([]);
    expect(exit.json.credit).toBeNull();
    expect(exit.json.commercial_hidden).toBe(true);
    // the CEO reads the same exit with its figure
    expect((await view(d, ceo())).json.placement.credit_pct === null || typeof (await view(d, ceo())).json.placement.credit_pct === 'number').toBe(true);
  });

  it('the CEO-only actions stay CEO-only, and a refusal carries no figure either', async () => {
    const d = await commenced(10);
    for (const [action, body] of [['invoice-sent', { sent_at: dayAt(-9), reference: 'INV-FAKE-0002' }], ['invoice-paid', { paid_at: dayAt(-8) }], ['correct', { sessions_per_week: 6, reason: 'Sessions were wrong.' }],
      ['credit-decision', { credit_pct: 50, reason: 'Agreed with the practice.' }], ['undo', { reason: 'Wrong doctor.' }], ['close', {}]]) {
      for (const who of [consultant(), rig.rso()]) {
        const res = await call(action, d, body, who);
        expect(res.status, action).toBe(403);
        expect(figures(res.json, action)).toEqual([]);
      }
    }
  });

  it('the consultant\'s task list says only whose the CEO\'s commercial tasks are', async () => {
    const d = await commenced(10);
    const asConsultant = await rig.get('/api/ats/candidate/tasks?case_id=' + encodeURIComponent(d.caseId), consultant());
    if (asConsultant.status === 200) {
      const invoice = asConsultant.json.tasks.find((x) => x.task_type === 'invoice_due');
      expect(invoice).toBeTruthy();
      expect(invoice.what_to_do).toBe('This is the CEO’s task.');
      expect(invoice.done_when).toBe('');
      expect(JSON.stringify(asConsultant.json)).not.toMatch(/\$21,000|21000/);
      const asCeo = await rig.get('/api/ats/candidate/tasks?case_id=' + encodeURIComponent(d.caseId), ceo());
      expect(asCeo.json.tasks.find((x) => x.task_type === 'invoice_due').what_to_do).toMatch(/Raise the invoice for/);
    } else {
      // the route lives at another address in this build: the rule is asserted on the source instead
      const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
      expect(src).toContain("(!actIsCeo && auLifecycle.CEO_COMMERCIAL_KINDS.indexOf(m.lifecycle_kind) !== -1) ? 'This is the CEO\\u2019s task.'");
    }
  });

  it('pure: the redaction keeps every key, nulls the figures at any depth, and leaves the CEO\'s copy alone', () => {
    const sample = { ok: true, fee: { known: true, amount_ex_gst: 21000 }, view: { placement: { commenced_at: '2027-01-01', fee_amount_ex_gst: 21000, credit_pct: 80 }, state: { invoice: 'sent', invoiceSentAt: '2027-01-02', commenced: true }, tasks: [{ title: 'x' }] } };
    const copy = JSON.parse(JSON.stringify(sample));
    expect(t.auCommencement.redactCommercial(sample, 'super_admin')).toBe(sample);
    const red = t.auCommencement.redactCommercial(sample, 'consultant');
    expect(sample).toEqual(copy);
    expect(red).toEqual({ ok: true, fee: null, commercial_hidden: true, view: { placement: { commenced_at: '2027-01-01', fee_amount_ex_gst: null, credit_pct: null }, state: { invoice: null, invoiceSentAt: null, commenced: true }, tasks: [{ title: 'x' }] } });
    for (const role of ['staff', 'rso', 'admin', '', undefined, null]) expect(figures(t.auCommencement.redactCommercial(sample, role), 'x')).toEqual([]);
  });

  it('switch off: the route does not exist for anyone', async () => {
    const d = await commenced(10);
    rig.setSwitch(false);
    try {
      expect((await view(d, ceo())).status).toBe(404);
      expect((await view(d, consultant())).status).toBe(404);
      expect((await call('notice', d, { last_working_day: dayAt(9), reason: 'doctor_resigned' })).status).toBe(404);
    } finally { rig.setSwitch(true); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('S-03: the start date', () => {
  const noticeRow = (d, day) => rig.table('au_gp_doctor_details').push({ user_id: d.userId, notice_given: true, notice_given_date: day, notice_placement_key: placementOf(d).application_id });

  it('the reviewer\'s case: a date before the placement was recorded is refused; nothing is saved, nothing is emailed', async () => {
    const d = await placed('au_vr', { placedDaysAgo: 5 });
    rig.resetRecorders();
    const before = JSON.stringify([placementOf(d), tasksOf(d)]);
    const res = await startDate(d, { start_date: dayAt(-22) });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ ok: false, code: 'start_before_placement' });
    expect(res.json.message).toMatch(/Nothing was saved and nobody was told/);
    expect(JSON.stringify([placementOf(d), tasksOf(d)])).toBe(before);
    expect(rig.emails.length).toBe(0);
    for (const junk of ['2027-02-31', '31/01/2027', '', 'tomorrow']) expect((await startDate(d, { start_date: junk })).status, junk).toBe(400);
    expect(rig.emails.length).toBe(0);
  });

  it('before the doctor\'s notice date: refused until staff confirm with a reason', async () => {
    const d = await placed('au_vr', { placedDaysAgo: 10 });
    noticeRow(d, dayAt(0));
    rig.resetRecorders();
    const refused = await startDate(d, { start_date: dayAt(-3) });
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ ok: false, code: 'start_before_notice' });
    expect((await startDate(d, { start_date: dayAt(-3), confirm_before_notice: true, reason: 'short' })).status).toBe(409);
    expect(rig.emails.length).toBe(0);
    expect(tasksOf(d).find((x) => x.task_type === 'start_date_tracking').status).toBe('open');
    const ok = await startDate(d, { start_date: dayAt(-3), confirm_before_notice: true, reason: 'The current practice released the doctor early.' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const task = tasksOf(d).find((x) => x.task_type === 'start_date_tracking');
    expect(metaOf(task)).toMatchObject({ confirmed_start_date: dayAt(-3), before_notice_date_reason: 'The current practice released the doctor early.' });
  });

  it('a good date saves and tells both sides once; a confirmed date can then be CORRECTED, and that goes once as a correction', async () => {
    const d = await placed('au_vr', { placedDaysAgo: 5 });
    rig.resetRecorders();
    const first = await startDate(d, { start_date: dayAt(30) }, consultant());
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    await settle();
    const firstToDoctor = emailsTo(d.email).length;
    expect(firstToDoctor).toBe(1);
    expect(tasksOf(d).find((x) => x.task_type === 'start_date_tracking').status).toBe('completed');
    // the task is closed: the correction form on the pre-start card posts the same route
    rig.resetRecorders();
    const fix = await startDate(d, { start_date: dayAt(37), reason: 'The practice moved the start by a week.' }, consultant());
    expect(fix.status, JSON.stringify(fix.json)).toBe(200);
    await settle();
    const mails = emailsTo(d.email);
    expect(mails.length).toBe(1);
    expect(String(mails[0].subject) + String(mails[0].text)).toMatch(/changed/i);
    expect(metaOf(tasksOf(d).find((x) => x.task_type === 'start_date_tracking'))).toMatchObject({ confirmed_start_date: dayAt(37), previous_start_date: dayAt(30), correction_reason: 'The practice moved the start by a week.' });
    // the same correction again sends nothing more
    rig.resetRecorders();
    expect((await startDate(d, { start_date: dayAt(37) })).status).toBe(200);
    await settle();
    expect(emailsTo(d.email).length).toBe(0);
    // a wrong correction is refused and sends nothing
    expect((await startDate(d, { start_date: dayAt(-40) })).status).toBe(400);
    expect(emailsTo(d.email).length).toBe(0);
  });

  it('after commencement the start date is corrected on the commencement card, not here', async () => {
    const d = await commenced(5);
    const res = await startDate(d, { start_date: dayAt(3) });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('already_commenced');
  });

  it('the screen offers the correction: the pre-start card has the button and a form that posts the route', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'ceo-ats-candidates.js'), 'utf8');
    const grab = (name) => { const s = src.indexOf('function ' + name + '('); let depth = 0; let i = src.indexOf('{', s); for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) break; } } return src.slice(s, i + 1); };
    // eslint-disable-next-line no-new-func
    const ui = new Function('var ATS = { esc: String, escAttr: String };' + grab('auStartDateConfirmed') + grab('auStartDateCorrectionHtml') + grab('auStartDateCorrectionBody')
      + 'return { confirmed: auStartDateConfirmed, html: auStartDateCorrectionHtml, body: auStartDateCorrectionBody };')();
    const v = { tasks: [{ task_type: 'start_date_tracking', status: 'completed', confirmed_start_date: '2027-02-01' }] };
    expect(ui.confirmed(v)).toBe('2027-02-01');
    expect(ui.confirmed({ tasks: [{ task_type: 'start_date_tracking', status: 'open', confirmed_start_date: null }] })).toBe('');
    expect(ui.html(v)).toContain('id="ats-au-sd-date" value="2027-02-01"');
    expect(ui.html(v)).toContain('ONE "your start date has changed" email');
    expect(ui.body('case-1', '2027-02-01', '2027-02-08', 'Moved a week', false)).toEqual({ body: { case_id: 'case-1', start_date: '2027-02-08', reason: 'Moved a week' } });
    expect(ui.body('case-1', '2027-02-01', '2027-02-01', '', false).error).toMatch(/already on file/);
    expect(ui.body('case-1', '2027-02-01', '', '', false).error).toBeTruthy();
    expect(ui.body('case-1', '2027-02-01', '2027-01-20', 'short', true).error).toMatch(/at least 10 characters/);
    expect(ui.body('case-1', '2027-02-01', '2027-01-20', 'Released early by the practice', true).body).toMatchObject({ confirm_before_notice: true });
    expect(src).toContain("auStartDateConfirmed(v) ? ' <button type=\"button\" class=\"ats-btn ats-btn-ghost ats-btn-sm\" id=\"ats-au-startdate-correct\">Correct start date</button>'");
    expect(src).toContain("ATS.api('/api/admin/au/prestart/start-date', { method: 'POST', body: built.body })");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('S-11: "Request item" tells the truth', () => {
  const ask = (d, items, who) => rig.post('/api/admin/au/prestart/request-item', { case_id: d.caseId, items: items }, who || ceo());

  it('sent: 200, sent: true, and the timeline says so', async () => {
    const d = await placed('au_vr');
    rig.resetRecorders();
    const res = await ask(d, ['au_indemnity_certificate']);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ ok: true, sent: true, channels: { email: true } });
    await settle();
    expect(emailsTo(d.email).length).toBe(1);
    expect(timelineOf(d).some((x) => x.title === 'Pre-start items requested from the doctor (N13)')).toBe(true);
  });

  it('the same list again that day: ok, but it says nothing more was sent, and no second timeline line', async () => {
    const d = await placed('au_vr');
    await ask(d, ['au_indemnity_certificate']);
    rig.resetRecorders();
    const again = await ask(d, ['au_indemnity_certificate']);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ ok: true, sent: false, already_sent: true });
    expect(again.json.message).toMatch(/Nothing more was sent/);
    await settle();
    expect(emailsTo(d.email).length).toBe(0);
    expect(timelineOf(d).filter((x) => x.title === 'Pre-start items requested from the doctor (N13)').length).toBe(1);
  });

  it('the reviewer\'s case: the email cannot be sent: NOT ok, it says nothing was sent and why, and the timeline does not claim a request', async () => {
    const d = await placed('au_vr');
    rig.resetRecorders();
    const restore = rig.failEmails ? rig.failEmails() : null;
    let res;
    if (restore) { try { res = await ask(d, ['au_right_to_work']); } finally { restore(); } }
    else {
      // no email-failure switch on this rig: make the once-ever ledger unwritable, which stops the send the same way
      rig.emu.failTables = { gp_nudge_log: 500 };
      try { res = await ask(d, ['au_right_to_work']); } finally { rig.emu.failTables = {}; }
    }
    expect(res.json.ok).toBe(false);
    expect(res.json).toMatchObject({ sent: false, code: 'not_sent' });
    expect(res.json.message).toMatch(/^Nothing was sent/);
    expect(res.status).toBeGreaterThanOrEqual(400);
    await settle();
    expect(emailsTo(d.email).length).toBe(0);
    expect(timelineOf(d).some((x) => x.title === 'Pre-start items requested from the doctor (N13)')).toBe(false);
    expect(timelineOf(d).some((x) => x.title === 'Pre-start items request NOT sent to the doctor')).toBe(true);
  });

  it('nothing valid chosen: 400 as before', async () => {
    const d = await placed('au_vr');
    expect((await ask(d, ['not_a_real_item'])).status).toBe(400);
    expect((await ask(d, [])).status).toBe(400);
  });
});

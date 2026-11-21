// WP-13 (Australian GP build): the pure rules of commencement and the daily
// lifecycle job, and everything the three new messages say.
//
//   - "Confirm commenced": the date, the sessions, the pre-start override
//   - the staff tasks: the invoice task carries the fee from the agreement or
//     says "confirm sessions/agreement before invoicing" with no dollar figure
//   - what the daily job owes a placement on each day, walked with a pinned
//     calendar from the placement to month 12
//   - N18 / N19 / N20: no banned word and nothing commercial to the doctor;
//     nothing to the practice beyond what the agreement says
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fees = require('../lib/au-placement-fees.js');
const lc = require('../lib/au-lifecycle.js');
const messages = require('../lib/au-placement-messages.js');
const careerIntro = require('../lib/career-intro.js');
const { bannedIn, allStrings } = require('./helpers/au-banned-words.js');
const whatsapp = require('../lib/au-whatsapp-templates.js');

const K = lc.KIND;
const kinds = (list) => list.map((x) => x.kind + (x.mark ? ':' + x.mark : ''));

describe('validateCommencement', () => {
  const base = { commencedAt: '2027-02-01', today: '2027-02-03', placedDay: '2026-12-01', sessions: 8, prestartComplete: true };
  it('accepts a past or present date on or after the placement, with a number of sessions', () => {
    expect(lc.validateCommencement(base)).toEqual({ ok: true, commencedAt: '2027-02-01', sessions: 8, overridden: false, overrideReason: '' });
    expect(lc.validateCommencement(Object.assign({}, base, { commencedAt: '2027-02-03' })).ok).toBe(true);
    expect(lc.validateCommencement(Object.assign({}, base, { commencedAt: '2026-12-01' })).ok).toBe(true);
  });
  it('refuses a date in the future at the practice, a date before the placement, and a non-date', () => {
    expect(lc.validateCommencement(Object.assign({}, base, { commencedAt: '2027-02-04' }))).toMatchObject({ ok: false, code: 'date_in_future' });
    expect(lc.validateCommencement(Object.assign({}, base, { commencedAt: '2026-11-30' }))).toMatchObject({ ok: false, code: 'date_before_placement' });
    for (const bad of ['', null, '01/02/2027', '2027-02-30', 'tomorrow']) {
      expect(lc.validateCommencement(Object.assign({}, base, { commencedAt: bad })), String(bad)).toMatchObject({ ok: false, code: 'invalid_date' });
    }
  });
  it('sessions: asked for when not on file; the number on file is used; "not known yet" is allowed and stays null', () => {
    expect(lc.validateCommencement(Object.assign({}, base, { sessions: undefined }))).toMatchObject({ ok: false, code: 'sessions_required' });
    expect(lc.validateCommencement(Object.assign({}, base, { sessions: '', sessionsOnFile: 6.5 }))).toMatchObject({ ok: true, sessions: 6.5 });
    expect(lc.validateCommencement(Object.assign({}, base, { sessions: undefined, sessionsUnknown: true }))).toMatchObject({ ok: true, sessions: null });
    for (const bad of ['6-8', 'full time', 0, 15, -1]) {
      expect(lc.validateCommencement(Object.assign({}, base, { sessions: bad })), String(bad)).toMatchObject({ ok: false, code: 'invalid_sessions' });
    }
    // a number typed here wins over what is on file
    expect(lc.validateCommencement(Object.assign({}, base, { sessions: '7.5', sessionsOnFile: 9 }))).toMatchObject({ ok: true, sessions: 7.5 });
  });
  it('pre-start not complete: refused without an explicit override and a real reason', () => {
    const open = Object.assign({}, base, { prestartComplete: false });
    expect(lc.validateCommencement(open)).toMatchObject({ ok: false, code: 'prestart_incomplete' });
    expect(lc.validateCommencement(Object.assign({}, open, { override: true }))).toMatchObject({ ok: false, code: 'prestart_incomplete' });
    expect(lc.validateCommencement(Object.assign({}, open, { override: true, overrideReason: 'ok' }))).toMatchObject({ ok: false, code: 'prestart_incomplete' });
    expect(lc.validateCommencement(Object.assign({}, open, { override: false, overrideReason: 'The practice confirmed by phone that she started.' }))).toMatchObject({ ok: false, code: 'prestart_incomplete' });
    expect(lc.validateCommencement(Object.assign({}, open, { override: true, overrideReason: '  The practice confirmed by phone that she started.  ' })))
      .toMatchObject({ ok: true, overridden: true, overrideReason: 'The practice confirmed by phone that she started.' });
  });
});

describe('the invoice task (checklist row 13)', () => {
  const base = { name: 'Test Auvr', practiceName: 'Test Metro Practice (FAKE)', placementKey: 'app-1', commencedAt: '2027-02-01' };
  it.each([
    ['standard', 8, 'Standard 2026 rates', 'full-time', '$21,000'],
    ['standard', 6, 'Standard 2026 rates', 'part-time', '$18,000'],
    ['discounted-2026', 9, 'Discounted 2026 rates', 'full-time', '$19,000'],
    ['discounted-2026', 5, 'Discounted 2026 rates', 'part-time', '$17,000']
  ])('%s, %s sessions: the task carries the tier and the agreement\'s fee', (variant, sessions, label, tierWord, amount) => {
    const fee = fees.placementFeeFor({ basis: 'australia', sessionsPerWeek: sessions, variant });
    const task = lc.buildInvoiceTask(Object.assign({}, base, { fee, variantLabel: label }));
    expect(task.task_type).toBe('invoice_due');
    expect(task.title).toBe('Raise placement-fee invoice: Dr Test Auvr at Test Metro Practice (FAKE)');
    expect(task.description).toContain(amount + ' exclusive of GST');
    expect(task.description).toContain(tierWord + ' placement');
    expect(task.description).toContain(label);
    expect(task.description).toContain('invoiced in full on commencement');
    expect(task.description).toContain('by hand');
    expect(task.due_date).toBe('2027-02-01');
    expect(task.metadata).toMatchObject({
      au: true, lifecycle_kind: 'invoice_due', owner: 'ceo', checklist_row: 13, placement_key: 'app-1',
      fee_known: true, fee_tier: fee.tier, fee_amount_ex_gst: fee.amountExGst, agreement_variant: variant, candidate_basis: 'australia', sessions_per_week: sessions
    });
    // the only dollar figure in the task is the agreement's fee
    expect((task.title + ' ' + task.description + ' ' + task.metadata.what_to_do).match(/\$[\d,]+/g).every((m) => m === amount)).toBe(true);
  });

  it.each([
    ['sessions unknown', { basis: 'australia', sessionsPerWeek: null, variant: 'standard' }],
    ['variant unknown', { basis: 'australia', sessionsPerWeek: 8, variant: null, variantKnown: false, variantReason: 'agreement_not_signed' }],
    ['a paper agreement', { basis: 'australia', sessionsPerWeek: 8, variant: null, variantKnown: false, variantReason: 'no_esignature_on_file' }],
    ['an earlier agreement', { basis: 'australia', sessionsPerWeek: 5, variant: null, variantKnown: false, variantReason: 'signed_before_2026_agreement' }],
    ['both unknown', { basis: 'australia', sessionsPerWeek: null, variant: null }]
  ])('%s: "confirm sessions/agreement before invoicing", and NO dollar figure anywhere', (_label, input) => {
    const fee = fees.placementFeeFor(input);
    const task = lc.buildInvoiceTask(Object.assign({}, base, { fee }));
    const everything = allStrings(task);
    expect(task.title).toBe('Confirm sessions/agreement before invoicing: Dr Test Auvr at Test Metro Practice (FAKE)');
    expect(task.description).toContain('Confirm sessions/agreement before invoicing');
    expect(task.description).toContain('will not guess');
    expect(everything).not.toMatch(/\$\s?\d/);
    expect(everything).not.toMatch(/\b(21|18|19|17),?000\b/);
    expect(task.metadata).toMatchObject({ fee_known: false, fee_amount_ex_gst: null });
    expect(task.metadata.fee_unknown_reason).toBe(fee.reason);
    expect(lc.FEE_UNKNOWN_TEXT[fee.reason]).toBeTruthy();
  });
});

describe('the check-in tasks (checklist row 14) and the first-week task', () => {
  const base = { name: 'Dr Test Auvr', practiceName: 'Test Metro Practice (FAKE)', placementKey: 'app-1', commencedAt: '2027-02-01' };
  it('three check-ins, dated weeks 4, 8 and 12, owned by the consultant', () => {
    const tasks = fees.CHECKIN_WEEKS.map((w) => lc.buildCheckinTask(w, base));
    expect(tasks.map((t) => t.due_date)).toEqual(['2027-03-01', '2027-03-29', '2027-04-26']);
    expect(tasks.map((t) => t.title)).toEqual([
      'Week 4 check-in: Dr Test Auvr at Test Metro Practice (FAKE)',
      'Week 8 check-in: Dr Test Auvr at Test Metro Practice (FAKE)',
      'Week 12 check-in: Dr Test Auvr at Test Metro Practice (FAKE)'
    ]);
    tasks.forEach((t, i) => {
      expect(t.task_type).toBe('guarantee_checkin');
      expect(t.metadata).toMatchObject({ au: true, lifecycle_kind: 'guarantee_checkin', owner: 'consultant', week: fees.CHECKIN_WEEKS[i], mark: 'w' + fees.CHECKIN_WEEKS[i], checklist_row: 14 });
    });
    expect(lc.buildCheckinTask(6, base)).toBeNull();
  });
  it('the first-week task is due seven days in and is a manual task (never a follow-up the AI job would close)', () => {
    const t = lc.buildWeek1Task(base);
    expect(t).toMatchObject({ task_type: 'manual', due_date: '2027-02-08', source_trigger: 'au_commencement' });
    expect(t.metadata).toMatchObject({ lifecycle_kind: 'week1_checkin', owner: 'consultant', mark: 'w1' });
  });
});

describe('the reminder tasks state no amount, no percentage and no credit', () => {
  const base = { name: 'Test Auvr', practiceName: 'Test Metro Practice (FAKE)', placementKey: 'app-1', today: '2027-08-01' };
  it('the part-time check at months 6 and 12 (commercial issue 6) names clause 6.12 and no figure', () => {
    for (const month of [6, 12]) {
      const t = lc.buildLifecycleTask(K.UPLIFT, Object.assign({}, base, { month, commencedAt: '2027-02-01', mark: 'm' + month }));
      const all = allStrings(t);
      expect(t.metadata).toMatchObject({ lifecycle_kind: 'part_time_uplift', owner: 'ceo', month });
      expect(t.title).toContain('month ' + month);
      expect(all).toContain('Clause 6.12');
      expect(all).not.toMatch(/\$|\d\s?%|\b\d{1,2},\d{3}\b/);
    }
  });
  it('every other reminder is free of dollar figures and percentages too', () => {
    const made = [
      lc.buildLifecycleTask(K.START_REACHED, Object.assign({}, base, { startDate: '2027-02-01' })),
      lc.buildLifecycleTask(K.PRESTART_AT_RISK, Object.assign({}, base, { startDate: '2027-02-01', daysToStart: 3, outstanding: ['Collect indemnity certificate'] })),
      lc.buildLifecycleTask(K.NOTICE, Object.assign({}, base, { startDate: '2027-02-01', noticeWeeks: 4 })),
      lc.buildLifecycleTask(K.INDEMNITY, Object.assign({}, base, { expiry: '2027-01-15', beforeStart: true, startDate: '2027-02-01' })),
      lc.buildLifecycleTask(K.GUARANTEE_ENDING, Object.assign({}, base, { guaranteeEndsAt: '2027-04-26', invoiceState: 'sent, not yet paid' })),
      lc.buildLifecycleTask(K.INVOICE_OVERDUE, Object.assign({}, base, { invoiceSentAt: '2027-02-01', paymentDueBy: '2027-02-08', invoiceReference: 'INV-0042' }))
    ];
    made.forEach((t) => {
      expect(t.task_type).toBe('manual');
      expect(t.source_trigger).toBe('au_lifecycle');
      expect(allStrings(t)).not.toMatch(/\$|\d\s?%/);
    });
    expect(made.map((t) => t.metadata.owner)).toEqual(['consultant', 'rso', 'consultant', 'rso', 'consultant', 'ceo']);
    expect(made[0].metadata.checklist_row).toBe(12);
    expect(made[1].priority).toBe('urgent');
    expect(lc.buildLifecycleTask('nope', base)).toBeNull();
  });
});

describe('the "replacement or credit" task (checklist row 15)', () => {
  const base = { name: 'Test Auvr', practiceName: 'Test Metro Practice (FAKE)', placementKey: 'app-1', commencedAt: '2027-02-01', lastWorkingDay: '2027-02-20', reason: 'doctor_resigned', today: '2027-02-21' };
  const credit = (extra) => fees.guaranteeCreditFor(Object.assign({
    commencedAt: '2027-02-01', lastWorkingDay: '2027-02-20', reason: 'doctor_resigned', conditionsConfirmed: 'yes',
    invoiceSentAt: '2027-02-01', invoicePaidAt: '2027-02-05', asOf: '2027-02-21'
  }, extra || {}));
  it('a credit the schedule gives is stated as the agreement\'s percentage, with no dollar figure', () => {
    const t = lc.buildExitTask(Object.assign({}, base, { credit: credit() }));
    expect(t.title).toBe('Replacement or credit: Dr Test Auvr at Test Metro Practice (FAKE)');
    expect(t.description).toContain('80% of the placement fee');
    expect(t.description).not.toMatch(/\$/);
    expect(t.metadata).toMatchObject({ lifecycle_kind: 'replacement_or_credit', owner: 'ceo', checklist_row: 15, credit_known: true, credit_pct: 80, credit_needs_decision: [] });
  });
  it('a credit that cannot be worked out: a decision task, no credit recorded, the reasons in plain words', () => {
    const t = lc.buildExitTask(Object.assign({}, base, { reason: 'practice_side', credit: credit({ reason: 'practice_side', conditionsConfirmed: 'unknown' }) }));
    expect(t.title).toMatch(/^Decide the guarantee credit/);
    expect(t.description).toContain('could NOT be worked out');
    expect(t.description).toContain('clause 7.3');
    expect(t.metadata).toMatchObject({ credit_known: false, credit_pct: null });
    expect(t.metadata.credit_needs_decision).toEqual(expect.arrayContaining(['discretionary_or_excluded_reason', 'conditions_not_confirmed']));
    expect(t.metadata.schedule_band_pct).toBe(80);
  });
  it('forfeited, conditions not met and after the period each say so', () => {
    expect(lc.buildExitTask(Object.assign({}, base, { credit: credit({ invoicePaidAt: '2027-02-15' }) })).title).toContain('guarantee forfeited');
    expect(lc.buildExitTask(Object.assign({}, base, { credit: credit({ conditionsConfirmed: 'no' }) })).title).toContain('conditions not met');
    expect(lc.buildExitTask(Object.assign({}, base, { lastWorkingDay: '2027-06-01', credit: credit({ lastWorkingDay: '2027-06-01' }) })).title).toContain('after the guarantee period');
  });
});

describe('what the daily job owes a placement BEFORE the doctor has started', () => {
  // Placed 2026-12-01, start date 2027-02-01. Nothing done by anyone.
  const facts = (today, extra) => Object.assign({
    today, placementKey: 'app-1', ageDays: fees.daysBetween('2026-12-01', today), startDate: '2027-02-01',
    prestartComplete: false, providerTaskOpen: true, noticeGiven: false, noticeWeeks: null, indemnityExpiry: null
  }, extra || {});

  it('walks the calendar: each reminder appears on its day, with a stable once-key', () => {
    expect(kinds(lc.prestartRemindersDue(facts('2026-12-02')))).toEqual([]);
    expect(kinds(lc.prestartRemindersDue(facts('2026-12-14')))).toEqual([]);
    // 14 days after the placement: the provider number is still pending
    expect(kinds(lc.prestartRemindersDue(facts('2026-12-15')))).toEqual(['provider_number_pending:d14']);
    // 28 days before the start with no notice period on file: has the doctor given notice?
    expect(kinds(lc.prestartRemindersDue(facts('2027-01-03')))).toEqual(['provider_number_pending:d14']);
    expect(kinds(lc.prestartRemindersDue(facts('2027-01-04')))).toEqual(['provider_number_pending:d14', 'notice_not_recorded:2027-02-01']);
    // 14 days before the start with pre-start unfinished
    expect(kinds(lc.prestartRemindersDue(facts('2027-01-17')))).not.toContain('prestart_at_risk:d14');
    expect(kinds(lc.prestartRemindersDue(facts('2027-01-18')))).toContain('prestart_at_risk:d14');
    // 3 days before
    expect(kinds(lc.prestartRemindersDue(facts('2027-01-29')))).toContain('prestart_at_risk:d3');
    expect(kinds(lc.prestartRemindersDue(facts('2027-01-29')))).not.toContain('prestart_at_risk:d14');
    // the start date itself, and every day after until commencement is confirmed: the same key
    expect(kinds(lc.prestartRemindersDue(facts('2027-01-31')))).not.toContain('start_date_reached:2027-02-01');
    const onDay = lc.prestartRemindersDue(facts('2027-02-01')).find((x) => x.kind === K.START_REACHED);
    const later = lc.prestartRemindersDue(facts('2027-02-09')).find((x) => x.kind === K.START_REACHED);
    expect(onDay.key).toBe('au_lc:start_date_reached:app-1:2027-02-01');
    expect(later.key).toBe(onDay.key);
  });

  it('nothing is owed for what is already done', () => {
    const done = facts('2027-01-30', { prestartComplete: true, providerTaskOpen: false, noticeGiven: true });
    expect(kinds(lc.prestartRemindersDue(done))).toEqual([]);
  });

  it('notice: with a notice period on file the prompt comes a week before the last day to give it', () => {
    const f = (today) => facts(today, { noticeWeeks: 8, providerTaskOpen: false, prestartComplete: true });
    // 8 weeks + 7 days = 63 days before 2027-02-01 -> 2026-11-30
    expect(kinds(lc.prestartRemindersDue(f('2026-11-29')))).toEqual([]);
    expect(kinds(lc.prestartRemindersDue(f('2026-11-30')))).toEqual(['notice_not_recorded:2027-02-01']);
  });

  it('indemnity: expiring before the start date, or within 30 days', () => {
    const f = (today, expiry) => facts(today, { providerTaskOpen: false, prestartComplete: true, noticeGiven: true, indemnityExpiry: expiry });
    expect(lc.prestartRemindersDue(f('2026-12-05', '2027-01-20'))[0]).toMatchObject({ kind: K.INDEMNITY, beforeStart: true, mark: '2027-01-20' });
    expect(kinds(lc.prestartRemindersDue(f('2026-12-05', '2027-06-30')))).toEqual([]);
    expect(lc.prestartRemindersDue(f('2027-01-25', '2027-02-20'))[0]).toMatchObject({ kind: K.INDEMNITY, beforeStart: false });
  });

  it('no start date on the placement: only the provider-number reminder can fall due', () => {
    expect(kinds(lc.prestartRemindersDue(facts('2027-03-01', { startDate: null })))).toEqual(['provider_number_pending:d14']);
  });
});

describe('what the daily job owes a placement AFTER the doctor has started', () => {
  // Commenced 2027-02-01, part-time, invoice sent on the day and paid on time.
  const facts = (today, extra) => Object.assign({
    today, placementKey: 'app-1', commencedAt: '2027-02-01', guaranteeEndsAt: '2027-04-26', feeTier: 'part_time',
    invoiceSentAt: '2027-02-01', invoicePaidAt: '2027-02-05', indemnityExpiry: null
  }, extra || {});
  const due = (today, extra) => lc.commencedRemindersDue(facts(today, extra));
  const fresh = (today, extra) => kinds(due(today, extra).filter((x) => !x.stale));

  it('walks week 1 to month 12: each milestone falls due on its day', () => {
    expect(fresh('2027-02-01')).toEqual([]);
    expect(fresh('2027-02-07')).toEqual([]);
    expect(fresh('2027-02-08')).toEqual(['week1_checkin:w1']);                       // N18
    expect(fresh('2027-02-28')).toEqual([]);                                           // N18 is now too late to send
    expect(fresh('2027-03-01')).toEqual(['guarantee_checkin:w4']);                     // N19 week 4
    expect(fresh('2027-03-29')).toEqual(['guarantee_checkin:w8']);                     // N19 week 8 (week 4 no longer sent)
    expect(fresh('2027-04-11')).toEqual(['guarantee_checkin:w8']);
    expect(fresh('2027-04-12')).toEqual(['guarantee_checkin:w8', 'guarantee_ending:2027-04-26']); // 14 days to go
    expect(fresh('2027-04-26')).toEqual(['guarantee_checkin:w12', 'guarantee_ending:2027-04-26']); // N19 week 12, the last day
    expect(fresh('2027-04-27')).toEqual(['guarantee_checkin:w12', 'guarantee_ended:2027-04-26']);  // closes the day after; N20
    expect(fresh('2027-07-31')).toEqual([]);
    expect(fresh('2027-08-01')).toEqual(['part_time_uplift:m6']);                      // month 6
    expect(fresh('2028-02-01')).toEqual(['part_time_uplift:m6', 'part_time_uplift:m12']); // month 12
  });

  it('every milestone keeps one key for as long as it is listed (so the ledger fires it once)', () => {
    const seen = {};
    for (let n = 0; n <= 380; n += 1) {
      due(fees.addDays('2027-02-01', n)).forEach((item) => {
        const id = item.kind + ':' + item.mark;
        if (seen[id]) expect(item.key).toBe(seen[id]);
        seen[id] = item.key;
      });
    }
    expect(Object.keys(seen).sort()).toEqual([
      'guarantee_checkin:w12', 'guarantee_checkin:w4', 'guarantee_checkin:w8', 'guarantee_ended:2027-04-26',
      'guarantee_ending:2027-04-26', 'part_time_uplift:m12', 'part_time_uplift:m6', 'week1_checkin:w1'
    ]);
    expect(new Set(Object.values(seen)).size).toBe(8);
  });

  it('a full-time placement gets no part-time reminder; an unknown tier gets none either', () => {
    expect(kinds(due('2028-02-01', { feeTier: 'full_time' }))).not.toContain('part_time_uplift:m6');
    expect(kinds(due('2028-02-01', { feeTier: null }))).not.toContain('part_time_uplift:m12');
  });

  it('an invoice sent and unpaid is flagged the day after its seven days', () => {
    expect(kinds(due('2027-02-08', { invoicePaidAt: null }))).not.toContain('invoice_overdue:2027-02-01');
    expect(due('2027-02-09', { invoicePaidAt: null }).find((x) => x.kind === K.INVOICE_OVERDUE)).toMatchObject({ paymentDueBy: '2027-02-08', mark: '2027-02-01' });
    expect(kinds(due('2027-03-09', { invoiceSentAt: null, invoicePaidAt: null }))).not.toContain('invoice_overdue:2027-02-01');
  });

  it('messages are not sent long after their moment (the task still exists)', () => {
    const late = due('2027-06-15');
    expect(late.filter((x) => x.message).every((x) => x.stale)).toBe(true);
    expect(late.find((x) => x.kind === K.GUARANTEE_ENDED).stale).toBe(true);
  });

  it('nothing is owed without a commencement date, and the job stops looking after month 13', () => {
    expect(lc.commencedRemindersDue(facts('2027-03-01', { commencedAt: null }))).toEqual([]);
    expect(lc.commencedRemindersDue(facts('2028-06-01'))).toEqual([]);
  });
});

describe('commercialSummary: the WP-27 read function', () => {
  const rows = [
    { id: 'a', commenced_at: '2027-02-01', guarantee_ends_at: '2027-04-26', invoice_due_at: '2027-02-01', fee_tier: 'full_time', fee_amount_ex_gst: '21000.00', status: 'active' },
    { id: 'b', commenced_at: '2027-01-10', guarantee_ends_at: '2027-04-04', invoice_due_at: '2027-01-10', invoice_sent_at: '2027-01-11', invoice_paid_at: '2027-01-15', status: 'active' },
    { id: 'c', commenced_at: '2027-01-20', guarantee_ends_at: '2027-04-14', invoice_sent_at: '2027-01-20', status: 'active' },
    { id: 'd', commenced_at: '2027-01-05', guarantee_ends_at: '2027-03-30', ended_at: '2027-02-10', invoice_sent_at: '2027-01-05', invoice_paid_at: '2027-01-08', status: 'ended' },
    { id: 'e', status: 'active', start_date: '2027-05-01' }
  ];
  it('invoices due, in guarantee, and ending within 14 days', () => {
    const s = lc.commercialSummary(rows, '2027-03-25');
    expect(s.invoicesDue.map((x) => x.placement_id)).toEqual(['a', 'c']);
    expect(s.invoicesDue.map((x) => x.invoice)).toEqual(['due', 'overdue']);
    expect(s.inGuarantee.map((x) => x.placement_id)).toEqual(['a', 'b', 'c']);
    expect(s.guaranteeEndingSoon.map((x) => x.placement_id)).toEqual(['b']);
    expect(s.counts).toEqual({ invoicesDue: 2, invoicesOverdue: 1, inGuarantee: 3, guaranteeEndingSoon: 1 });
    expect(s.invoicesDue[0].fee_amount_ex_gst).toBe(21000);
  });
  it('empty in, empty out', () => {
    expect(lc.commercialSummary([], '2027-03-25').counts).toEqual({ invoicesDue: 0, invoicesOverdue: 0, inGuarantee: 0, guaranteeEndingSoon: 0 });
    expect(lc.commercialSummary(null, '').invoicesDue).toEqual([]);
  });
});

describe('N18, N19, N20: what is sent', () => {
  const gpInput = { appBaseUrl: 'https://app.gplink-test.local/', practiceName: 'Test Metro Practice (FAKE)', placementKey: 'app-1', teamLabel: 'your GP Link team' };
  const prInput = { gpName: 'Test Auvr', contactName: 'Test Manager', placementKey: 'app-1', guaranteeEndsAt: '2027-04-26' };
  const toDoctor = [
    messages.buildCommencementCheckinGpMessage(gpInput),
    messages.buildWeekCheckinGpMessage(Object.assign({ week: 4 }, gpInput)),
    messages.buildWeekCheckinGpMessage(Object.assign({ week: 8 }, gpInput)),
    messages.buildWeekCheckinGpMessage(Object.assign({ week: 12 }, gpInput)),
    messages.buildReferralAskMessage(gpInput),
    // with nothing known about the practice
    messages.buildCommencementCheckinGpMessage({ appBaseUrl: '', placementKey: 'app-1' }),
    messages.buildReferralAskMessage({ appBaseUrl: '', placementKey: 'app-1' })
  ];
  const toPractice = [
    messages.buildCommencementCheckinPracticeMessage(prInput),
    messages.buildWeekCheckinPracticeMessage(Object.assign({ week: 4 }, prInput)),
    messages.buildWeekCheckinPracticeMessage(Object.assign({ week: 8 }, prInput)),
    messages.buildWeekCheckinPracticeMessage(Object.assign({ week: 12 }, prInput)),
    messages.buildCommencementCheckinPracticeMessage({ placementKey: 'app-1' })
  ];

  it('ids and once-ever keys: one per message per placement, all different', () => {
    expect(toDoctor.slice(0, 5).map((m) => m.id)).toEqual(['N18', 'N19', 'N19', 'N19', 'N20']);
    expect(toPractice.slice(0, 4).map((m) => m.id)).toEqual(['N18', 'N19', 'N19', 'N19']);
    const keys = toDoctor.slice(0, 5).concat(toPractice.slice(0, 4)).map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    keys.forEach((k) => expect(k).toMatch(/^au_n(18|19|20)_[a-z0-9_]+:app-1$/));
  });

  it('no word from AGENT-RULES section 4 reaches the doctor', () => {
    toDoctor.forEach((m) => { expect(bannedIn(allStrings(m)), m.key).toEqual([]); });
  });

  it('nothing commercial reaches the doctor: no fee, invoice, credit, percentage, dollar figure or "guarantee"', () => {
    toDoctor.forEach((m) => {
      const all = allStrings(m);
      expect(all, m.key).not.toMatch(/guarantee|invoice|\bfee\b|\bfees\b|credit|refund|commission|\$\s?\d|\d\s?%|agreement|clause|reward|bonus|incentive/i);
    });
  });

  it('the doctor is never told we will contact their old practice, and N20 offers nothing in return', () => {
    const n20 = allStrings(messages.buildReferralAskMessage(gpInput));
    expect(n20).toContain('We only ever contact someone who has agreed to hear from us.');
    expect(n20).toMatch(/twelve weeks/);
  });

  it('the practice is told about the guarantee only what the agreement says: twelve weeks, clause 7, no figures', () => {
    toPractice.forEach((m) => {
      const all = m.subject + '\n' + m.text + '\n' + m.bodyHtml;
      expect(careerIntro.auPracticeTextViolations(all), m.key).toEqual([]);
      expect(all, m.key).not.toMatch(/\$\s?\d|\d\s?%|\b(80|50|35) per ?cent|credit|refund|invoice|\bfee\b/i);
      expect(all, m.key).not.toMatch(/internationally trained|Expedited Specialist Pathway|AHPRA steps/i);
    });
    const w4 = messages.buildWeekCheckinPracticeMessage(Object.assign({ week: 4 }, prInput));
    expect(w4.text).toContain('12-week guarantee period, which runs until 26 April 2027');
    expect(w4.text).toContain('clause 7 of your Recruitment Services Agreement');
    const w12 = messages.buildWeekCheckinPracticeMessage(Object.assign({ week: 12 }, prInput));
    expect(w12.text).toContain('last check-in of the 12-week guarantee period, which ends on 26 April 2027');
    // N18 to the practice does not mention the guarantee at all
    expect(toPractice[0].text).not.toMatch(/guarantee/i);
  });

  it('dates are calendar dates: no clock time, so no time-zone label is needed', () => {
    toDoctor.concat(toPractice).forEach((m) => {
      expect(allStrings(m), m.key).not.toMatch(/\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?(am|pm)\b/i);
    });
  });

  it('the practice name and doctor name are escaped in the HTML', () => {
    const m = messages.buildCommencementCheckinPracticeMessage({ gpName: 'Test <b>Auvr</b>', contactName: '<script>x</script>', placementKey: 'k' });
    expect(m.bodyHtml).not.toContain('<script>');
    expect(m.bodyHtml).not.toContain('<b>Auvr');
  });

  it('WhatsApp: N18 names its own Australian templates, and neither is approved', () => {
    expect(toDoctor[0].whatsapp.templateKey).toBe('commencement_checkin');
    expect(toPractice[0].whatsapp.templateKey).toBe('commencement_checkin_practice');
    expect(whatsapp.auDoctorWhatsAppPlan('commencement_checkin', {})).toMatchObject({ send: false, reason: 'au_template_not_approved' });
    expect(whatsapp.auDoctorWhatsAppPlan('commencement_checkin_practice', {})).toMatchObject({ send: false, reason: 'au_template_not_approved' });
    expect(whatsapp.AU_WHATSAPP_TEMPLATES.commencement_checkin.templateName).toMatch(/^gp_link_au_/);
    expect(whatsapp.AU_WHATSAPP_TEMPLATES.commencement_checkin_practice.templateName).toMatch(/^gp_link_au_/);
    // N19 and N20 have no WhatsApp at all (email only, per the message table)
    toDoctor.slice(1, 5).forEach((m) => expect(m.whatsapp).toBeUndefined());
  });
});

describe('exports (ADM-30): the extra cells', () => {
  it('one cell per extra placement column, dates as calendar days, blanks for what is not on file', () => {
    const cells = lc.placementExportCells({
      candidate_basis: 'australia', sessions_per_week_numeric: 8, fee_tier: 'full_time', fee_amount_ex_gst: '21000.00', agreement_variant: 'standard',
      commenced_at: '2027-02-01', invoice_due_at: '2027-02-01', invoice_sent_at: '2027-02-02', invoice_reference: 'INV-0042',
      invoice_paid_at: null, guarantee_ends_at: '2027-04-26', ended_at: null, end_reason: null, credit_pct: null
    }, 'au_vr');
    expect(Object.keys(cells)).toEqual(lc.PLACEMENT_EXPORT_COLUMNS.map((c) => c.key));
    expect(cells).toMatchObject({ pathway: 'au_vr', fee_tier: 'full_time', fee_amount_ex_gst: '21000.00', commenced_at: '2027-02-01', invoice_paid_at: '', credit_pct: '', guarantee_ends_at: '2027-04-26' });
    expect(Object.values(lc.placementExportCells(null, '')).every((v) => v === '')).toBe(true);
  });
});

// WP-27 (Australian GP build): the pure rules.
//   lib/au-pipeline.js           the Australian pipeline definitions, table-driven:
//                                every fixture lands in exactly one group
//   lib/stalled-applications.js  the per-application gone-quiet threshold
//   lib/ceo-review-queue.js      the Australian review kinds (no input: nothing)
//   lib/au-messages.js           N22, the digest's Australian block
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const auPipeline = require('../lib/au-pipeline.js');
const stalled = require('../lib/stalled-applications.js');
const reviewQueue = require('../lib/ceo-review-queue.js');
const auMessages = require('../lib/au-messages.js');
const fees = require('../lib/au-placement-fees.js');

const TODAY = '2026-11-18';
const NOW = Date.parse('2026-11-18T02:00:00Z');
const day = (n) => fees.addDays(TODAY, n);
const ago = (n) => new Date(NOW - n * 86400000).toISOString();
const profile = (o) => Object.assign({ user_id: 'u', first_name: 'Test', last_name: 'Auvr', email: 'au.vr.test@gplink-test.local', created_at: ago(30), onboarding_completed_at: ago(29), account_status: 'active' }, o || {});
const caseRow = (o) => Object.assign({ id: 'c', user_id: 'u', stage: 'placement', status: 'active' }, o || {});
const app = (o) => Object.assign({ id: 'a1', user_id: 'u', status: 'applied', ats_stage: 'applied', applied_at: ago(5) }, o || {});
const placed = (o) => Object.assign({ id: 'p1', user_id: 'u', application_id: 'a1', status: 'active', practice_name: 'Test Metro Practice (FAKE)', placed_at: ago(10), start_date: day(20) }, o || {});
const started = (daysAgo, o) => placed(Object.assign({ commenced_at: day(-daysAgo), guarantee_ends_at: fees.guaranteeEndsOn(day(-daysAgo)), start_date: day(-daysAgo), placed_at: ago(daysAgo + 14) }, o || {}));
const securedApp = app({ status: 'placement_secured', ats_stage: 'hired' });

// name, facts, the ONE group the doctor is in
const TABLE = [
  ['archived account', { profile: profile({ account_status: 'archived' }), applications: [app()] }, 'excluded'],
  ['owner test account', { profile: profile({ email: 'khaleedmahmoud1211@gmail.com' }) }, 'excluded'],
  ['withdrawn case', { cases: [caseRow({ status: 'withdrawn' })], applications: [app()] }, 'excluded'],
  ['part-way through the Australian onboarding branch (no pathway yet)', { pathway: '', profile: profile({ onboarding_completed_at: null }), cases: [] }, 'onboarding'],
  ['pathway set, profile not finished', { profile: profile({ onboarding_completed_at: null }) }, 'onboarding'],
  ['profile finished, no application', {}, 'looking'],
  ['only a withdrawn application', { applications: [app({ status: 'withdrawn' })] }, 'looking'],
  ['only an application the practice turned down', { applications: [app({ ats_stage: 'not_proceeding' })] }, 'looking'],
  ['an application just made', { applications: [app()] }, 'matched'],
  ['submitted to the practice', { applications: [app({ practice_submission_status: 'submitted', submitted_to_practice_at: ago(2) })] }, 'matched'],
  ['profile not finished but staff applied them', { profile: profile({ onboarding_completed_at: null }), applications: [app({ origin: 'admin_applied' })] }, 'matched'],
  ['an application at the interview stage', { applications: [app({ ats_stage: 'interview' })] }, 'interview'],
  ['an interview booked on the modern booking table', { applications: [app()], interviews: [{ application_id: 'a1', status: 'booked', booked_at: ago(1) }] }, 'interview'],
  ['a cancelled interview only', { applications: [app()], interviews: [{ application_id: 'a1', status: 'cancelled', booked_at: ago(1) }] }, 'matched'],
  ['an interview already held', { applications: [app({ interview_completed_at: ago(2) })] }, 'interview'],
  ['an application at the offer stage', { applications: [app({ ats_stage: 'offer' })] }, 'contract'],
  ['offer accepted, placement not yet recorded', { applications: [app({ status: 'offer_accepted', ats_stage: 'offer' })] }, 'contract'],
  ['a card dragged to Hired with no placement on record', { applications: [app({ ats_stage: 'hired' })] }, 'contract'],
  ['two applications, one at interview and one at offer: the furthest', { applications: [app({ id: 'a1', ats_stage: 'interview' }), app({ id: 'a2', ats_stage: 'offer' })] }, 'contract'],
  ['application recorded as placement secured, no placement row yet', { applications: [securedApp] }, 'prestart'],
  ['placement recorded, start date ahead', { cases: [caseRow({ stage: 'prestart' })], applications: [securedApp], placements: [placed()] }, 'prestart'],
  ['placement recorded, start date passed, not confirmed', { cases: [caseRow({ stage: 'prestart' })], applications: [securedApp], placements: [placed({ start_date: day(-3) })] }, 'prestart'],
  ['placement recorded while the case row still says placement', { applications: [securedApp], placements: [placed()] }, 'prestart'],
  ['started today', { cases: [caseRow({ stage: 'commenced' })], applications: [securedApp], placements: [started(0)] }, 'commenced'],
  ['started 6 days ago', { cases: [caseRow({ stage: 'commenced' })], applications: [securedApp], placements: [started(6)] }, 'commenced'],
  ['started 7 days ago', { cases: [caseRow({ stage: 'guarantee' })], applications: [securedApp], placements: [started(7)] }, 'guarantee'],
  ['the last day of the guarantee period', { cases: [caseRow({ stage: 'guarantee' })], applications: [securedApp], placements: [started(84)] }, 'guarantee'],
  ['the day after the guarantee period', { cases: [caseRow({ stage: 'complete' })], applications: [securedApp], placements: [started(85)] }, 'complete'],
  ['the doctor left during the guarantee period', { cases: [caseRow({ stage: 'complete' })], applications: [securedApp], placements: [started(30, { status: 'ended', ended_at: day(-2) })] }, 'ended'],
  ['a cancelled placement and nothing else', { placements: [placed({ status: 'cancelled' })] }, 'looking'],
  ['SECOND CYCLE: first placement settled, looking again, a new application', { cases: [caseRow({ stage: 'placement' })], applications: [securedApp, app({ id: 'a2' })], placements: [started(150)] }, 'matched'],
  ['SECOND CYCLE: first placement ended, looking again, nothing yet', { cases: [caseRow({ stage: 'placement' })], applications: [securedApp], placements: [started(60, { status: 'ended', ended_at: day(-20) })] }, 'looking'],
  ['SECOND CYCLE: a second placement recorded', { cases: [caseRow({ stage: 'prestart' })], applications: [securedApp, app({ id: 'a2', status: 'placement_secured', ats_stage: 'hired' })], placements: [started(150), placed({ id: 'p2', application_id: 'a2', placed_at: ago(2) })] }, 'prestart'],
  ['HELD segment B, no placement', { pathway: 'au_restricted' }, 'held'],
  ['HELD segment C with an application', { pathway: 'au_non_vr', applications: [app({ ats_stage: 'interview' })] }, 'held'],
  ['HELD registrar', { pathway: 'au_registrar' }, 'held'],
  ['segment B with a placement staff recorded: in the pipeline, not held', { pathway: 'au_restricted', cases: [caseRow({ stage: 'prestart' })], applications: [securedApp], placements: [placed()] }, 'prestart'],
  ['segment B whose placement finished', { pathway: 'au_restricted', cases: [caseRow({ stage: 'complete' })], applications: [securedApp], placements: [started(100)] }, 'complete']
];

describe('WP-27: the Australian pipeline definitions (one group per doctor per placement cycle)', () => {
  const ALL = auPipeline.PIPELINE_COLUMNS.concat(auPipeline.BEFORE_GROUPS, auPipeline.CLOSING_GROUPS).map((g) => g.key).concat(['held', 'excluded']);

  it('the six columns, in order', () => {
    expect(auPipeline.PIPELINE_COLUMNS.map((c) => c.label)).toEqual(['Matched', 'Interview', 'Contract', 'Pre-start', 'Commenced', 'Guarantee']);
    expect(auPipeline.CLOSING_GROUPS.map((c) => c.label)).toEqual(['Complete', 'Ended']);
  });

  TABLE.forEach(([name, facts, expected]) => {
    it(name + ' -> ' + expected, () => {
      const f = Object.assign({ pathway: 'au_vr', profile: profile(), cases: [caseRow()], applications: [], placements: [], interviews: [] }, facts);
      const ids = new Set();
      f.interviews.forEach((r) => { if (/^(booked|completed)$/.test(r.status)) ids.add(r.application_id); });
      const one = auPipeline.classifyDoctor({ profile: f.profile, pathway: f.pathway, cases: f.cases, applications: f.applications, placements: f.placements, interviewAppIds: ids, today: TODAY });
      expect(one.group).toBe(expected);
      // The same doctor through the whole builder: in exactly ONE group.
      const built = auPipeline.serialisable(auPipeline.buildAuPipeline({
        nowMs: NOW, today: TODAY, doctors: [Object.assign({}, f.profile, { pathway: f.pathway })], cases: f.cases, applications: f.applications,
        placements: f.placements, interviews: f.interviews
      }));
      const where = built.columns.concat(built.before, built.closing, [built.held]).filter((g) => g.count > 0).map((g) => g.key);
      expect(where).toEqual(expected === 'excluded' ? [] : [expected]);
      expect(built.total).toBe(expected === 'excluded' ? 0 : 1);
      expect(ALL).toContain(one.group);
    });
  });

  it('a placement is judged on its own practice\'s date', () => {
    // Started 7 days ago by Sydney's date, 6 by Perth's (the hours when they differ).
    const row = started(7);
    const facts = { profile: profile(), pathway: 'au_vr', cases: [caseRow({ stage: 'commenced' })], applications: [securedApp], placements: [row] };
    expect(auPipeline.classifyDoctor(Object.assign({ today: TODAY }, facts)).group).toBe('guarantee');
    expect(auPipeline.classifyDoctor(Object.assign({ today: TODAY, dayFor: () => day(-1) }, facts)).group).toBe('commenced');
  });

  it('counts, the list behind each count, and time in stage', () => {
    const doctors = ['a', 'b', 'c'].map((id) => Object.assign(profile({ user_id: id, last_name: 'Doc' + id }), { pathway: 'au_vr' }));
    const built = auPipeline.serialisable(auPipeline.buildAuPipeline({
      nowMs: NOW, today: TODAY, doctors,
      cases: doctors.map((d) => caseRow({ id: 'c-' + d.user_id, user_id: d.user_id })),
      applications: [app({ id: 'x1', user_id: 'a', applied_at: ago(4) }), app({ id: 'x2', user_id: 'b', applied_at: ago(10) }), app({ id: 'x3', user_id: 'c', ats_stage: 'interview', ats_stage_updated_at: ago(3) })]
    }));
    const matched = built.columns.find((c) => c.key === 'matched');
    expect(matched.count).toBe(2);
    expect(matched.doctors.map((d) => [d.name, d.days_in_stage])).toEqual([['Dr Test Docb', 10], ['Dr Test Doca', 4]]);
    expect(matched.time_in_stage).toEqual({ median_days: 7, avg_days: 7, sample_size: 2 });
    expect(built.columns.find((c) => c.key === 'interview').doctors[0]).toMatchObject({ case_id: 'c-c', days_in_stage: 3, group_label: 'Interview' });
    expect(built.totals).toEqual({ in_pipeline: 3, before: 0, closing: 0, held: 0, excluded: 0 });
  });

  it('placements, the Commenced metric and timings are per placement, in days', () => {
    const d = Object.assign(profile({ created_at: ago(200) }), { pathway: 'au_vr' });
    const first = started(150, { id: 'p1', application_id: 'a1', placed_at: ago(170) });
    const second = started(3, { id: 'p2', application_id: 'a2', placed_at: ago(20) });
    const built = auPipeline.serialisable(auPipeline.buildAuPipeline({
      nowMs: NOW, today: TODAY, doctors: [d], cases: [caseRow({ stage: 'commenced' })],
      applications: [app({ id: 'a1', status: 'placement_secured', applied_at: ago(190) }), app({ id: 'a2', status: 'placement_secured', applied_at: ago(30) })],
      placements: [first, second]
    }));
    expect(built.total).toBe(1);                       // one doctor, counted once
    expect(built.columns.find((c) => c.key === 'commenced').count).toBe(1);
    expect(built.placements.total).toBe(2);            // two placements
    expect(built.commenced).toMatchObject({ total: 2, window: 1 });
    expect(built.timing.application_to_placement).toEqual({ median_days: 15, avg_days: 15, sample_size: 2 });
    expect(built.timing.signup_to_placement).toEqual({ median_days: 30, avg_days: 30, sample_size: 1 });
    expect(built.timing.placement_to_commencement.sample_size).toBe(2);
    expect(auPipeline.daysInWords(9)).toBe('9 days');
    expect(auPipeline.daysInWords(21)).toBe('3 weeks');
    expect(auPipeline.daysInWords(null)).toBe('not enough placements yet');
  });

  it('W3-D24: what is said about a start date is true for every state of a placement', () => {
    const line = (row) => auPipeline.placementStartLine(row, TODAY).text;
    expect(line(placed({ start_date: null }))).toBe('start date to be confirmed');
    expect(line(placed({ start_date: day(20) }))).toBe('starts 8 December 2026');
    expect(line(placed({ start_date: TODAY }))).toBe('due to start today');
    expect(line(placed({ start_date: day(-3) }))).toBe('was due to start 15 November 2026 (start not yet confirmed)');
    expect(line(started(3))).toBe('started 15 November 2026');
    expect(line(started(100))).toBe('started 10 August 2026');
    expect(line(started(30, { status: 'ended', ended_at: day(-2) }))).toBe('ended 16 November 2026');
    expect(line(placed({ status: 'cancelled' }))).toBe('cancelled');
  });

  it('the brief sentence is deterministic and names no overseas stage', () => {
    const built = auPipeline.serialisable(auPipeline.buildAuPipeline({ nowMs: NOW, today: TODAY, doctors: [Object.assign(profile(), { pathway: 'au_vr' })], cases: [caseRow()], applications: [app()] }));
    expect(auPipeline.briefText(built, 2)).toBe('1 Australian doctor on the books, 1 in the pipeline (1 matched). Last 7 days: 1 application'.replace(': 1 application', ': nothing new') + '. 2 items need you.');
    expect(auPipeline.briefText(built, 0)).toMatch(/Nothing is waiting on you\.$/);
    expect(auPipeline.briefText(null, 0)).toBe('');
  });
});

describe('WP-27 (ADM-18): the gone-quiet detector takes a per-application threshold', () => {
  const now = '2026-11-18T02:00:00Z';
  const introduced = (id, daysQuiet, user) => ({ id, user_id: user, ats_stage: 'interview', status: 'interview', ats_stage_updated_at: ago(daysQuiet) });
  const apps = [introduced('os-20', 20, 'os'), introduced('os-70', 70, 'os'), introduced('au-10', 10, 'au'), introduced('au-20', 20, 'au')];

  it('without it, behaviour and output are exactly what they were', () => {
    const a = stalled.findStalledApplications(apps, { now, thresholdDays: 60 });
    expect(a.map((x) => x.id)).toEqual(['os-70']);
    expect(Object.keys(a[0])).toEqual(['id', 'user_id', 'career_role_id', 'practice_id', 'ats_stage', 'status', 'revealed', 'last_movement_at', 'days_quiet']);
    expect(stalled.findStalledApplications(apps, { now, thresholdDays: 60, thresholdDaysFor: () => null })).toEqual(a);
  });
  it('each application under its own threshold, aged from its own last movement', () => {
    const got = stalled.findStalledApplications(apps, { now, thresholdDays: 60, thresholdDaysFor: (a) => (a.user_id === 'au' ? 14 : null) });
    expect(got.map((x) => [x.id, x.days_quiet, x.threshold_days])).toEqual([['os-70', 70, undefined], ['au-20', 20, 14]]);
  });
  it('the Australian default is 14 days, env-overridable, never under 7', () => {
    expect(stalled.DEFAULT_AU_THRESHOLD_DAYS).toBe(14);
    expect(stalled.auThresholdDaysFrom(undefined)).toBe(14);
    expect(stalled.auThresholdDaysFrom('10')).toBe(10);
    expect(stalled.auThresholdDaysFrom('2')).toBe(7);
    expect(stalled.auThresholdDaysFrom('x')).toBe(14);
    expect(stalled.DEFAULT_THRESHOLD_DAYS).toBe(60);
  });
});

describe('WP-27 (ADM-24): the review-queue builder', () => {
  it('no Australian facts handed in: no Australian item and the counts object is exactly today\'s', () => {
    const q = reviewQueue.buildReviewQueue({});
    expect(q).toEqual({ items: [], counts: { total: 0, register: 0, register_pending: 0, register_mismatch: 0, docs: 0, documents: 0, account: 0 } });
  });
  it('facts with nothing wrong: the Australian counters exist and read zero', () => {
    const d = Object.assign(profile(), { pathway: 'au_vr' });
    const pipeline = auPipeline.buildAuPipeline({ nowMs: NOW, today: TODAY, doctors: [d], cases: [caseRow()] });
    const q = reviewQueue.buildReviewQueue({ nowMs: NOW, au: { nowMs: NOW, today: TODAY, doctors: [d], cases: [caseRow()], credentials: [{ user_id: 'u', ahpra_last_checked_at: ago(5), registration_expiry: day(300), moratorium_19ab_status: 'no', moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: 'x', moratorium_19ab_confirmed_at: ago(5) }], pipeline } });
    expect(q.items).toEqual([]);
    expect(q.counts.au).toBe(0);
    expect(Object.keys(q.counts.au_kinds)).toEqual(reviewQueue.AU_KINDS);
  });
  it('a due date is due ON its day and overdue from the day after', () => {
    const d = Object.assign(profile(), { pathway: 'au_vr' });
    const facts = { doctors: [d], cases: [caseRow({ stage: 'prestart' })], applications: [securedApp], placements: [placed()] };
    const pipeline = auPipeline.buildAuPipeline(Object.assign({ nowMs: NOW, today: TODAY }, facts));
    const task = (due) => ({ id: 't1', case_id: 'c', task_type: 'indemnity_certificate', status: 'open', title: 'Indemnity certificate', due_date: due, metadata: { au: true } });
    const run = (due) => reviewQueue.buildAuReviewItems(Object.assign({ nowMs: NOW, today: TODAY, pipeline, tasks: [task(due)] }, facts)).filter((x) => x.kind === 'au_prestart_overdue').length;
    expect(run(TODAY)).toBe(0);
    expect(run(day(-1))).toBe(1);
    expect(run(day(1))).toBe(0);
  });
});

describe('WP-27 (N22): the digest block builder', () => {
  it('nothing Australian: an empty block', () => {
    expect(auMessages.buildOwnerDigestBlock(null)).toEqual({ html: '', text: '', rows: [] });
    const empty = auPipeline.serialisable(auPipeline.buildAuPipeline({ nowMs: NOW, today: TODAY, doctors: [] }));
    expect(auMessages.buildOwnerDigestBlock({ pipeline: empty })).toEqual({ html: '', text: '', rows: [] });
  });
  it('a lead and no doctor yet: the block is there', () => {
    const p = auPipeline.serialisable(auPipeline.buildAuPipeline({ nowMs: NOW, today: TODAY, doctors: [], leads: [{ id: 'l1', created_at: ago(1) }] }));
    const block = auMessages.buildOwnerDigestBlock({ pipeline: p, week: { thisWeek: { leads: 1 }, lastWeek: {} } });
    expect(block.text).toContain('New Australian leads: 1 (+1 vs last week)');
    expect(block.text).toContain('Needs you: nothing is waiting on you.');
    expect(block.html).not.toContain('Invoices due');   // no commercial counts were handed in
  });
});

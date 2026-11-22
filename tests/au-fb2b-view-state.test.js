// FB-2b (walk-findings W3-D12, W3-D13, W3-D14 = R3, A1, A3, A4, A5): what a
// doctor on an Australian pathway is shown across the whole life of a
// placement, from ONE value the server works out (`viewState`).
//
//   looking -> prestart -> cleared -> first_week -> settling_in -> settled
//                                                              \-> ended
//
// Part 1 is pure (the rule, the checklist, the three renderers). Part 2 runs
// the real server against the in-memory database and takes one doctor through
// every state, then proves the A4 rule: a placement whose guarantee period has
// finished stays `active`, and is no longer read as "in pre-start".
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const gpApp = require('../lib/au-gp-app.js');
const lc = require('../lib/au-lifecycle.js');
const fees = require('../lib/au-placement-fees.js');
const page = require('../js/au-prestart.js');
const auDoctor = require('../js/au-doctor.js');
const { bannedIn, htmlText } = require('./helpers/au-banned-words.js');
const { bootPlacementRig, PRACTICE_NAME } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');
const { PRODUCTION_UNIQUE_RULES } = require('./helpers/au-supabase-emulator.js');

const text = (html) => htmlText(html).replace(/\s+/g, ' ');
const NO_MONEY = /\$\s?\d|\d\s?%|guarantee|invoice|\bfee\b|credit/i;

describe('placementPhase: one row, from its own dates (A4)', () => {
  const row = (extra) => Object.assign({ status: 'active', commenced_at: null, guarantee_ends_at: null, ended_at: null }, extra);
  it('pre-start, the first week, settling in, settled: the guarantee period includes its last day', () => {
    expect(lc.placementPhase(row(), '2026-11-22')).toBe('prestart');
    const started = row({ commenced_at: '2026-11-01', guarantee_ends_at: '2027-01-24' });
    expect(lc.placementPhase(started, '2026-11-01')).toBe('first_week');
    expect(lc.placementPhase(started, '2026-11-07')).toBe('first_week');
    expect(lc.placementPhase(started, '2026-11-08')).toBe('settling_in');
    expect(lc.placementPhase(started, '2027-01-24')).toBe('settling_in');
    expect(lc.placementPhase(started, '2027-01-25')).toBe('settled');
    // no stored end date: the agreement's own length is used
    expect(lc.placementPhase(row({ commenced_at: '2026-11-01' }), fees.addDays(fees.guaranteeEndsOn('2026-11-01'), 1))).toBe('settled');
  });
  it('a settled placement is still `active`: the status is not what changed', () => {
    const settled = row({ commenced_at: '2026-01-01', guarantee_ends_at: '2026-03-26' });
    expect(settled.status).toBe('active');
    expect(lc.placementPhase(settled, '2026-11-22')).toBe('settled');
  });
  it('ended and cancelled win; with no usable "today" nothing is called settled on a guess', () => {
    expect(lc.placementPhase(row({ status: 'ended', commenced_at: '2026-01-01' }), '2026-11-22')).toBe('ended');
    expect(lc.placementPhase(row({ commenced_at: '2026-01-01', ended_at: '2026-02-01' }), '2026-11-22')).toBe('ended');
    expect(lc.placementPhase(row({ status: 'cancelled' }), '2026-11-22')).toBe('cancelled');
    expect(lc.placementPhase(row({ commenced_at: '2026-01-01', guarantee_ends_at: '2026-03-26' }), '')).toBe('settling_in');
    expect(lc.placementPhase(null, '2026-11-22')).toBe('');
  });
});

describe('doctorViewState: the one value', () => {
  it('the table', () => {
    const s = gpApp.doctorViewState;
    expect(s({ placed: false })).toBe('looking');
    expect(s({})).toBe('looking');
    expect(s({ placed: true, phase: 'prestart', prestartComplete: false })).toBe('prestart');
    expect(s({ placed: true, phase: 'prestart', prestartComplete: true })).toBe('cleared');
    expect(s({ placed: true, phase: '', prestartComplete: false })).toBe('prestart');
    expect(s({ placed: true, phase: 'first_week', prestartComplete: false })).toBe('first_week');
    expect(s({ placed: true, phase: 'settling_in' })).toBe('settling_in');
    expect(s({ placed: true, phase: 'settled' })).toBe('settled');
    expect(s({ placed: true, placementEnded: true })).toBe('ended');
    expect(s({ placed: false, placementEnded: true })).toBe('ended');
    expect(s({ placed: true, phase: 'ended' })).toBe('ended');
    expect(Object.values(gpApp.VIEW_STATE).sort()).toEqual(['cleared', 'ended', 'first_week', 'looking', 'prestart', 'settled', 'settling_in']);
  });
});

// ── the checklist ──────────────────────────────────────────────────────────
const DOCS = [
  { key: 'au_indemnity_certificate', label: 'Indemnity certificate of currency', status: 'pending', required: true, phase: 'prestart', provider: 'you', short: 'Upload it.' },
  { key: 'au_ahpra_certificate', label: 'Ahpra registration certificate', status: 'approved', required: true, phase: 'prestart', provider: 'you' },
  { key: 'au_wwcc', label: 'Working with Children Check', status: 'pending', required: true, phase: 'prestart', provider: 'you', short: 'Your current check.' }
];
const base = (extra) => Object.assign({
  placement: { key: 'app-1', practiceName: 'Test Metro Practice (FAKE)', startDate: '2026-12-14' },
  tasks: [
    { task_type: 'start_date_tracking', status: 'completed', metadata: { confirmed_start_date: '2026-12-14', placement_key: 'app-1' } },
    { task_type: 'indemnity_certificate', status: 'open', metadata: { placement_key: 'app-1' } },
    { task_type: 'provider_number_new_location', status: 'open', metadata: { placement_key: 'app-1' } }
  ],
  documents: DOCS, allDocuments: DOCS, registerChecked: true, registerCheckOpen: false, details: {}, providerNumber: { recorded: false }
}, extra || {});

describe('the checklist: what is counted is labelled, and after the start it is a record (A3, W3-D14)', () => {
  it('before the start: every card that is NOT counted says so; counted ones carry no label', () => {
    const c = gpApp.buildPrestartChecklist(base());
    const by = Object.fromEntries(c.items.map((i) => [i.key, i]));
    expect(by.register_check).toMatchObject({ required: false, optional: true, countLabel: 'For your information' });
    expect(by.notice).toMatchObject({ required: false, optional: true, countLabel: 'Optional' });
    expect(by.referees).toMatchObject({ required: false, optional: true, countLabel: 'Optional' });
    for (const k of ['start_date', 'indemnity', 'provider_number', 'credentialing', 'doc_au_ahpra_certificate', 'doc_au_wwcc']) {
      expect(by[k], k).toMatchObject({ required: true, optional: false, countLabel: '' });
    }
    // the number on screen is the number of counted cards, the same number staff are shown
    expect(c.counts.total).toBe(c.items.filter((i) => i.required).length);
    expect(c.items.every((i) => !i.stillNeeded)).toBe(true);
    expect(c.startDateSource).toBe('confirmed');
    expect(c.stillNeeded).toEqual([]);
  });

  it('after the start: an open counted item is "Still needed" with why; nobody is asked for referees or a notice date', () => {
    const c = gpApp.buildPrestartChecklist(base({ commencedAt: '2026-12-14' }));
    const by = Object.fromEntries(c.items.map((i) => [i.key, i]));
    expect(by.indemnity).toMatchObject({ stillNeeded: true, statusLabel: 'Still needed', status: 'todo' });
    expect(by.indemnity.why).toBe('We still need this on file for your placement at Test Metro Practice (FAKE).');
    expect(by.provider_number).toMatchObject({ stillNeeded: true, statusLabel: 'Still needed' });
    expect(by.provider_number.why).toMatch(/needs its own provider number/);
    expect(by.doc_au_wwcc).toMatchObject({ stillNeeded: true, statusLabel: 'Still needed' });
    expect(by.credentialing).toMatchObject({ stillNeeded: true, statusLabel: 'In progress' });
    expect(by.credentialing.why).toMatch(/Nothing for you to do/);
    expect(by.doc_au_ahpra_certificate.stillNeeded).toBeUndefined();   // done: nothing to say
    expect(by.referees).toMatchObject({ status: 'done', statusLabel: 'Not needed now', action: null, closedByStart: true });
    expect(by.notice).toMatchObject({ status: 'done', action: null });
    expect(c.stillNeeded.sort()).toEqual(['credentialing', 'doc_au_wwcc', 'indemnity', 'provider_number']);
    expect(c.startDateSource).toBe('started');
    // nothing commercial, and none of the banned words, in anything a doctor reads
    const all = JSON.stringify(c.items.map((i) => [i.title, i.statusLabel, i.whatToDo, i.why, i.countLabel]));
    expect(bannedIn(all)).toEqual([]);
    expect(all).not.toMatch(NO_MONEY);
  });

  it('where the date shown came from: expected, confirmed, started, or none', () => {
    const expected = gpApp.buildPrestartChecklist(base({ tasks: [{ task_type: 'start_date_tracking', status: 'open', metadata: { placement_key: 'app-1' } }] }));
    expect(expected).toMatchObject({ startDate: '2026-12-14', startDateSource: 'expected' });
    const none = gpApp.buildPrestartChecklist(base({ placement: { key: 'app-1', practiceName: 'X', startDate: '' }, tasks: [] }));
    expect(none).toMatchObject({ startDate: null, startDateSource: '' });
  });
});

// ── the three screens ──────────────────────────────────────────────────────
function viewFor(viewState, extra) {
  const started = ['first_week', 'settling_in', 'settled'].indexOf(viewState) !== -1;
  const c = gpApp.buildPrestartChecklist(base(started ? { commencedAt: '2026-12-14' } : {}));
  return Object.assign({
    ok: true, placed: viewState !== 'looking', launched: true, viewState,
    stage: 'prestart', teamLabel: viewState === 'looking' ? 'your GP Link consultant' : 'your GP Link team',
    steps: gpApp.doctorSteps(started ? 'commenced' : (viewState === 'looking' ? 'placement' : 'prestart'), c.facts),
    items: viewState === 'looking' ? [] : c.items, complete: viewState === 'cleared', counts: viewState === 'looking' ? { done: 0, total: 0 } : c.counts,
    practiceName: 'Test Metro Practice (FAKE)', startDate: c.startDate, startDateConfirmed: c.startDateConfirmed, startDateSource: c.startDateSource,
    startsInDays: started ? null : 22, stillNeeded: c.stillNeeded, started, startedOn: started ? '2026-12-14' : null,
    providerNumber: { recorded: false }, details: {}
  }, extra || {});
}

describe('Home, per state (A1, W3-D13)', () => {
  it('looking: roles; held: the holding card and no role', () => {
    const t = text(page._homeHtml(viewFor('looking')));
    expect(t).toContain('Find your practice');
    expect(page._homeHtml(viewFor('looking'))).toContain('data-au-route="/pages/career"');
    const held = text(page._homeHtml(viewFor('looking', { launched: false })));
    expect(held).toContain('Thanks, we have your details');
    expect(held).not.toContain('See roles');
  });
  it('prestart: the next step, the CONFIRMED start date with the days to go, and the count', () => {
    const t = text(page._homeHtml(viewFor('prestart')));
    expect(t).toContain('Your next step');
    expect(t).toContain('Start date: 14 Dec 2026');
    expect(t).toContain('22 days to go.');
    expect(t).not.toContain('to be confirmed');
    expect(t).toMatch(/\d of \d pre-start items done/);
  });
  it('"to be confirmed" only when there truly is no date; an unconfirmed one says "expected"', () => {
    const none = text(page._homeHtml(viewFor('prestart', { startDate: null, startDateSource: '', startsInDays: null })));
    expect(none).toContain('Start date: to be confirmed');
    const expected = text(page._homeHtml(viewFor('prestart', { startDateSource: 'expected' })));
    expect(expected).toContain('Expected start date: 14 Dec 2026 (to be confirmed)');
  });
  it('cleared: says so, with the date', () => {
    const t = text(page._homeHtml(viewFor('cleared')));
    expect(t).toContain('You are cleared to start');
    expect(t).toContain('Start date: 14 Dec 2026');
  });
  it('first week: a welcome and the first-week check-in; NO pre-start counter', () => {
    const t = text(page._homeHtml(viewFor('first_week')));
    expect(t).toContain('You have started Welcome to Test Metro Practice (FAKE)');
    expect(t).toContain('You started on 14 Dec 2026');
    expect(t).toContain('at the end of your first week');
    expect(t).not.toContain('pre-start items done');
    expect(t).toContain('4 items are still needed from before you started.');
  });
  it('settling in: a short "you have started at X" card and how to reach the team; no counter, no "first weeks"', () => {
    const html = page._homeHtml(viewFor('settling_in'));
    const t = text(html);
    expect(t).toContain('Settling in You have started at Test Metro Practice (FAKE)');
    expect(t).toContain('Your first day was 14 Dec 2026');
    expect(t).not.toContain('pre-start items done');
    expect(t).not.toContain('first weeks');
    expect(html).toContain('data-au-route="/pages/messages"');
  });
  it('settled (A1): "You are with X" since the date; no "you have started", no counter, no steps; roles are a link', () => {
    const html = page._homeHtml(viewFor('settled'));
    const t = text(html);
    expect(t).toContain('You are with Test Metro Practice (FAKE)');
    expect(t).toContain('You have been there since 14 Dec 2026');
    expect(t).not.toContain('You have started');
    expect(t).not.toContain('first weeks');
    expect(t).not.toContain('pre-start items done');
    expect(t).not.toContain('Your steps');
    expect(html).toContain('data-au-route="/pages/career"');
  });
  it('ended: the one plain card', () => {
    const t = text(page._homeHtml({ ok: true, placed: true, viewState: 'ended', placementEnded: true, endedPracticeName: 'Test Metro Practice (FAKE)', steps: gpApp.doctorSteps('complete'), items: [], counts: { done: 0, total: 0 }, teamLabel: 'your GP Link team' }));
    expect(t).toContain('Your placement has ended');
    expect(t).not.toContain('Your steps');
  });
  it('no state says anything commercial, or a banned word', () => {
    for (const s of ['looking', 'prestart', 'cleared', 'first_week', 'settling_in', 'settled']) {
      const t = text(page._homeHtml(viewFor(s))) + ' ' + text(page._prestartHtml(viewFor(s), { open: '' }));
      expect(bannedIn(t), s).toEqual([]);
      expect(t, s).not.toMatch(NO_MONEY);
    }
  });
  it('a response with no viewState (an older server) draws the same states from the old fields', () => {
    const old = viewFor('prestart'); delete old.viewState;
    expect(text(page._homeHtml(old))).toContain('Your next step');
    const started = viewFor('first_week'); delete started.viewState;
    expect(text(page._homeHtml(started))).toContain('You have started at Test Metro Practice (FAKE)');
  });
});

describe('the pre-start page, per state (W3-D14, A3)', () => {
  it('before the start: the count, a note that labelled cards are not part of it, and the labels on those cards', () => {
    const html = page._prestartHtml(viewFor('prestart'), { open: '' });
    const v = viewFor('prestart');
    expect(html).toContain(v.counts.done + ' of ' + v.counts.total + ' done');
    expect(html).toContain('data-au-count-note');
    expect(text(html)).toContain('Items marked "Optional" or "For your information" are not part of this count.');
    expect(html).toMatch(/data-au-item="notice"[^>]*>\s*<div class="aua-item-head"><h3>Notice to your current practice<span class="aua-tag" data-au-not-counted>Optional<\/span>/);
    expect(html).toMatch(/<h3>Reference checks<span class="aua-tag" data-au-not-counted>Optional<\/span>/);
    expect(html).toMatch(/<h3>Ahpra register check<span class="aua-tag" data-au-not-counted>For your information<\/span>/);
    expect(html).not.toMatch(/<h3>Indemnity certificate of currency<span class="aua-tag"/);
    // exactly as many unlabelled cards as the total says
    const cards = html.match(/<section class="aua-card" data-au-item="[^"]+"/g).length;
    const labelled = html.match(/data-au-not-counted/g).length;
    expect(cards - labelled).toBe(v.counts.total);
  });
  it('after the start: no counter; "Still needed" first, each with why; then what was completed', () => {
    for (const s of ['first_week', 'settling_in']) {
      const html = page._prestartHtml(viewFor(s), { open: '' });
      const t = text(html);
      expect(html, s).not.toContain('aua-progress');
      expect(t, s).not.toMatch(/\d of \d+ done/);
      expect(t, s).toContain('You have started at Test Metro Practice (FAKE)');
      expect(t, s).toContain('4 items from before you started are still needed.');
      expect(html.indexOf('data-au-section="still-needed"'), s).toBeGreaterThan(-1);
      expect(html.indexOf('data-au-section="still-needed"'), s).toBeLessThan(html.indexOf('data-au-section="completed"'));
      expect(t, s).toContain('Still needed (4)');
      expect(t, s).toContain('Why it is still needed: We still need this on file for your placement at Test Metro Practice (FAKE).');
      expect(html, s).toContain('aua-pill tone-needed">Still needed</span>');
      expect(t, s).not.toContain('To do');
      expect(html, s).toContain('data-au-item="start_date" id="start-date"');
      // only the documents still needed are offered for upload
      expect(html, s).toContain('data-au-docs-keys="au_indemnity_certificate,au_wwcc"');
      expect(t, s).toContain('Not needed now');
    }
  });
  it('settled: the same record, headed "You are with X"; nothing still needed reads as done', () => {
    const done = viewFor('settled', { stillNeeded: [] });
    done.items = done.items.map((i) => Object.assign({}, i, { stillNeeded: false, status: 'done', statusLabel: 'Done', why: '' }));
    const t = text(page._prestartHtml(done, { open: '' }));
    expect(t).toContain('You are with Test Metro Practice (FAKE)');
    expect(t).toContain('Everything we needed before you started is done.');
    expect(t).toContain('Completed before you started');
    expect(t).not.toContain('Still needed');
  });
});

describe('Careers, placed: the view per state (W3-D12, W3-D13)', () => {
  const placement = { quickStats: [{ label: 'Billing', value: 'Mixed' }, { label: 'Split', value: 'Pending' }], compensation: { range: 'Pending', unit: 'Per Year' } };
  it('empty tiles are not drawn: no "Pending Split", no "Expected income Pending"', () => {
    const v = auDoctor.securedView(viewFor('prestart'), placement);
    expect(v.quickStats).toEqual([{ label: 'Billing', value: 'Mixed' }]);
    expect(v).toMatchObject({ showIncome: false, incomeText: '', incomeUnit: '' });
    const real = auDoctor.securedView(viewFor('prestart'), { quickStats: [{ label: 'Billing', value: 'Mixed' }], compensation: { range: 'On file', unit: 'Per Year' } });
    expect(real).toMatchObject({ showIncome: true, incomeText: 'On file' });
    for (const empty of ['', 'Pending', ' pending ', 'Billing pending', '—', 'TBC', null, undefined]) expect(auDoctor.isEmptyTile(empty), String(empty)).toBe(true);
    expect(auDoctor.isEmptyTile('Mixed')).toBe(false);
  });
  it('a confirmed start date: the countdown and the date. Never "— days / to be confirmed"', () => {
    expect(auDoctor.securedView(viewFor('prestart'), placement)).toMatchObject({
      state: 'prestart', known: true, chip: 'Placement confirmed', showCountdownValue: true, countdownValue: '22', countdownCopy: 'days until your start', startTag: 'Starts 14 Dec 2026'
    });
    expect(auDoctor.securedView(viewFor('prestart', { startsInDays: 1 }), placement).countdownCopy).toBe('day until your start');
    expect(auDoctor.securedView(viewFor('prestart', { startsInDays: 0 }), placement)).toMatchObject({ showCountdownValue: false, countdownCopy: 'You start today' });
  });
  it('an expected date says "expected"; no date at all is the only "to be confirmed"', () => {
    expect(auDoctor.securedView(viewFor('prestart', { startDateSource: 'expected' }), placement)).toMatchObject({ countdownCopy: 'days until your expected start', startTag: 'Expected start 14 Dec 2026 (to be confirmed)' });
    expect(auDoctor.securedView(viewFor('prestart', { startDate: null, startDateSource: '', startsInDays: null }), placement)).toMatchObject({ showCountdownValue: false, startTag: 'Start date to be confirmed' });
  });
  it('cleared, started, settled', () => {
    expect(auDoctor.securedView(viewFor('cleared'), placement).chip).toBe('Cleared to start');
    expect(auDoctor.securedView(viewFor('first_week'), placement)).toMatchObject({ chip: 'Started', title: 'You Have Started', showCountdownValue: false, countdownCopy: 'You started on 14 Dec 2026', startTag: 'Your first week' });
    expect(auDoctor.securedView(viewFor('settling_in'), placement)).toMatchObject({ chip: 'Started', startTag: 'Settling in', countdownCopy: 'You started on 14 Dec 2026' });
    expect(auDoctor.securedView(viewFor('settled'), placement)).toMatchObject({ chip: 'Your practice', title: 'You Are With' });
  });
  it('before the server has answered nothing is claimed about the start date either way', () => {
    const v = auDoctor.securedView(null, placement);
    expect(v).toMatchObject({ known: false, showCountdownValue: false, countdownValue: '', countdownCopy: '', startTag: '' });
    expect(v.quickStats).toEqual([{ label: 'Billing', value: 'Mixed' }]);
  });

  const career = read('pages/career.html');
  it('the page draws the placed view from the server\'s state, for an Australian doctor only, once per load', () => {
    expect(career).toContain('if (auDoctorInfo) auRenderSecuredState();');
    expect(career).toContain('fetch("/api/gp/au-prestart", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } })');
    expect(career).toContain('if (auPlacementViewAsked || !auDoctorInfo) return;');
    expect(career).toContain('const v = window.GPAuDoctor.securedView(auPlacementView, raw);');
    // the old line is still there for everyone else, untouched
    expect(career).toContain('securedStartDateEl.textContent = startDateLabel ? "Starts " + startDateLabel : "Start date to be confirmed";');
  });
  it('W3-D12: in dark mode the light placed view reads its text from light tokens (Australian doctors only)', () => {
    const at = career.indexOf('html.dark-mode.gp-au-doctor body.career-mode-secured {');
    expect(at).toBeGreaterThan(0);
    const block = career.slice(at, career.indexOf('}', at));
    expect(block).toContain('--gp-ink: #0f172a;');
    expect(block).toContain('--gp-muted: #64748b;');
    expect(block).toContain('--gp-blue: #2563eb;');
    // the dark-mode values that made the text pale are what the page still defines for everyone else
    expect(career).toMatch(/html\.dark-mode \{[^}]*--gp-ink: #e2e8f0;/);
    expect(career).toContain('html.gp-au-doctor body.career-mode-secured .placement-checklist-item.complete .placement-checklist-item-title {');
    // contrast of the colours chosen, on white (WCAG AA is 4.5:1)
    const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (hex) => 1.05 / (lum(hex) + 0.05);
    for (const hex of ['#0f172a', '#475569', '#1d4ed8', '#64748b']) expect(ratio(hex), hex).toBeGreaterThanOrEqual(4.5);
    // and what it was: the dark-mode ink on a white page
    expect(ratio('#e2e8f0')).toBeLessThan(1.3);
  });
});

// ── the real server, one doctor through every state ────────────────────────
describe('GET /api/gp/au-prestart: one doctor through every state', () => {
  let rig;
  let t;
  const d = buildAuDoctor('au_vr', { credentials: { staff_verified_at: '2026-11-20T02:00:00.000Z', staff_verified_by: 'consultant.test@gplink-test.local' } });
  const fresh = buildAuDoctor('au_vr', { idSuffix: '2', selfDeclared: true });
  const overseas = buildAuDoctor('overseas_null');
  const as = (who) => ({ cookie: rig.gpCookie(who.email, who.userId) });
  const view = async (who) => (await rig.get('/api/gp/au-prestart', as(who || d))).json;
  const row = () => rig.table('placements').find((p) => p.user_id === d.userId);
  const today = () => lc.localDay(Date.now(), 'Australia/Sydney');
  const setStage = (stage) => { rig.caseOf(d).stage = stage; };

  beforeAll(async () => {
    rig = await bootPlacementRig({ name: 'fb2b-view-state', doctors: [d, fresh, overseas], emulator: { defaults: { registration_tasks: { status: 'open' }, placements: { status: 'active' } }, unique: PRODUCTION_UNIQUE_RULES } });
    rig.setSwitch(true);
    t = rig.testUtils;
  }, 60000);
  afterAll(async () => { if (rig) await rig.close(); });

  it('looking, then placed: pre-start, with the days to the start date on the practice\'s own calendar', async () => {
    expect(await view(fresh)).toMatchObject({ viewState: 'looking', placed: false, startsInDays: null });
    expect((await rig.place(d, 'ats_placement')).status).toBe(200);
    await rig.settle(120);
    row().start_date = fees.addDays(today(), 22);
    const v = await view();
    expect(v).toMatchObject({ viewState: 'prestart', placed: true, started: false, practiceName: PRACTICE_NAME, startDate: fees.addDays(today(), 22), startsInDays: 22, startDateSource: 'expected' });
    expect(v.items.find((i) => i.key === 'notice')).toMatchObject({ optional: true, countLabel: 'Optional' });
    // the count the doctor sees is the count staff see
    const staff = (await rig.get('/api/admin/au/prestart?case_id=' + encodeURIComponent(d.caseId), rig.superAdmin())).json;
    expect(staff.prestart_counts).toEqual(v.counts);
  });

  it('cleared, first week, settling in, settled: from the placement row\'s own dates', async () => {
    rig.approvePrestartDocuments(d);
    const key = row().application_id;
    rig.table('registration_tasks').filter((x) => x.case_id === d.caseId && ['start_date_tracking', 'indemnity_certificate', 'provider_number_new_location', 'credentialing_pack'].indexOf(x.task_type) !== -1)
      .forEach((x) => { x.status = 'completed'; if (x.task_type === 'start_date_tracking') x.metadata = Object.assign({}, typeof x.metadata === 'string' ? JSON.parse(x.metadata) : x.metadata, { confirmed_start_date: row().start_date }); });
    if (!rig.table('registration_tasks').some((x) => x.case_id === d.caseId && x.task_type === 'credentialing_pack')) {
      rig.table('registration_tasks').push({ id: 'cred-fb2b', case_id: d.caseId, task_type: 'credentialing_pack', status: 'completed', title: 'Send the practice credentialing pack', related_stage: 'prestart', metadata: { au: true, placement_key: key } });
    }
    expect(await view()).toMatchObject({ viewState: 'cleared', complete: true, startDateSource: 'confirmed', startsInDays: 22 });

    Object.assign(row(), { commenced_at: fees.addDays(today(), -2), guarantee_ends_at: fees.addDays(today(), 82) });
    setStage('commenced');
    expect(await view()).toMatchObject({ viewState: 'first_week', started: true, startedOn: fees.addDays(today(), -2), startsInDays: null, startDateSource: 'started' });

    Object.assign(row(), { commenced_at: fees.addDays(today(), -30), guarantee_ends_at: fees.addDays(today(), 54) });
    setStage('guarantee');
    expect(await view()).toMatchObject({ viewState: 'settling_in', started: true });

    Object.assign(row(), { commenced_at: fees.addDays(today(), -100), guarantee_ends_at: fees.addDays(today(), -16) });
    setStage('complete');
    const settled = await view();
    expect(settled).toMatchObject({ viewState: 'settled', started: true, placed: true, practiceName: PRACTICE_NAME, startedOn: fees.addDays(today(), -100) });
    // A1: this is what used to say "You have started ... first weeks" with "0 of 8 pre-start items done"
    const home = text(page._homeHtml(settled));
    expect(home).toContain('You are with ' + PRACTICE_NAME);
    expect(home).not.toMatch(/first weeks|pre-start items done/);
    expect(row().status).toBe('active');   // A4: the truthful status
  });

  it('A4: a doctor with a finished guarantee who starts looking again is NOT read as placed, and is not pulled back to pre-start', async () => {
    // What the old readers did: any `active` row meant "placed".
    expect(await t._auPlacementSecuredFact(d.userId)).toBe(true);   // settled, case finished: still their practice
    // The doctor applies for a role again: a new placement cycle, the case is back at `placement`.
    setStage('placement');
    expect(row().status).toBe('active');
    expect(await t._auPlacementSecuredFact(d.userId)).toBe(false);
    expect(await t._auActivePlacementFor(d.userId)).toBeNull();
    const v = await view();
    expect(v).toMatchObject({ viewState: 'looking', placed: false, items: [] });
    // the stage mover leaves the case where it is (it used to move it to pre-start for the old practice)
    const moved = await t.auMoveCaseOnPlacement(d.userId, { source: 'fb2b-test' });
    expect(moved.moved).toBe(false);
    expect(rig.caseOf(d).stage).toBe('placement');
    // the pages follow: the pre-start page is not theirs while they are looking
    const pre = await rig.get('/pages/prestart?gp_shell=embedded', as(d));
    expect([pre.status, pre.headers.location]).toEqual([302, '/pages/career?gp_shell=embedded']);
    // a NEW placement on file is the current one straight away, beside the settled row
    rig.table('placements').push(Object.assign({}, row(), { id: 'pl-fb2b-new', application_id: 'app-fb2b-new', commenced_at: null, guarantee_ends_at: null, placed_at: new Date().toISOString(), created_at: new Date().toISOString(), practice_name: 'Test Regional Practice (FAKE)' }));
    expect(await t._auPlacementSecuredFact(d.userId)).toBe(true);
    const current = await t._auActivePlacementFor(d.userId);
    expect(current).toMatchObject({ key: 'app-fb2b-new', phase: 'prestart', settled: false, practiceName: 'Test Regional Practice (FAKE)' });
    rig.table('placements').splice(rig.table('placements').findIndex((p) => p.id === 'pl-fb2b-new'), 1);
    setStage('complete');
  });

  it('ended: the one state, whatever else is on the row', async () => {
    Object.assign(row(), { status: 'ended', ended_at: fees.addDays(today(), -1) });
    setStage('complete');
    const v = await view();
    expect(v).toMatchObject({ viewState: 'ended', placementEnded: true, items: [] });
    expect(text(page._homeHtml(v))).toContain('Your placement has ended');
  });

  it('OVERSEAS PARITY: the route does not exist for an overseas doctor, or for anyone with the switch off', async () => {
    expect((await rig.get('/api/gp/au-prestart', as(overseas))).status).toBe(404);
    rig.setSwitch(false);
    try {
      expect((await rig.get('/api/gp/au-prestart', as(d))).status).toBe(404);
      expect((await rig.get('/api/gp/au-prestart', as(overseas))).status).toBe(404);
    } finally { rig.setSwitch(true); }
  });
});

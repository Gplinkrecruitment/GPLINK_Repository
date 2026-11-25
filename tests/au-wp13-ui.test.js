// WP-13 (Australian GP build): what people see.
//
//   staff   the "Commencement and guarantee" card (js/au-commencement.js),
//           drawn from the server's view: the buttons follow `can`, the fee
//           shown is the server's, and "not known" shows no dollar figure
//   pages   the card is fetched and mounted ONLY for an Australian case, on
//           both staff screens; nothing is loaded or added for anyone else
//   doctor  the pre-start page and Home say "you have started" after
//           commencement and "your placement has ended" after an exit, with
//           no banned word and nothing commercial
//   cache-busters and inline scripts
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { bannedIn, htmlText, stripJsComments } = require('./helpers/au-banned-words.js');
const auPrestartPage = require('../js/au-prestart.js');
const gpApp = require('../lib/au-gp-app.js');

function loadCard() {
  const sandbox = { window: {}, globalThis: {} };
  sandbox.window.fetch = null;
  vm.runInNewContext(read('js/au-commencement.js'), sandbox);
  return sandbox.window.GPAuCommencement;
}
const card = loadCard();
const text = (html) => htmlText(html).replace(/\s+/g, ' ');

const CAN_NONE = { confirm: false, correct: false, undo: false, invoice_sent: false, invoice_paid: false, early_exit: false, credit_decision: false, close: false };
const placement = (extra) => Object.assign({
  id: 'p1', key: 'app-1', status: 'active', practice_name: 'Test Metro Practice (FAKE)', job_title: 'General Practitioner (FAKE role)', start_date: '2027-02-01',
  sessions_text: '8', sessions_per_week_numeric: null, sessions_suggested: 8, commenced_at: null, commencement_confirmed_by: null, fee_tier: null, fee_amount_ex_gst: null,
  agreement_variant: null, agreement_variant_label: '', invoice_due_at: null, invoice_sent_at: null, invoice_reference: null, invoice_paid_at: null, invoice_payment_due_by: null,
  guarantee_ends_at: null, ended_at: null, end_reason: null, credit_pct: null
}, extra || {});
const EXIT_REASONS = [{ value: 'doctor_resigned', label: 'The doctor ended the contract' }, { value: 'practice_side', label: 'A reason on the practice\'s side' }];

describe('the staff card: before commencement', () => {
  const base = {
    ok: true, today: '2027-02-02', role: 'consultant', placement: placement(), state: { commenced: false },
    prestart: { complete: false, missing: ['Practice credentialing pack'], open: ['Collect indemnity certificate'] },
    fee_preview: { known: true, tier: 'full_time', amount_ex_gst: 21000, variant: 'standard', variant_label: 'Standard 2026 rates', variant_known: true, reason: null },
    tasks: [], exit_reasons: EXIT_REASONS, can: Object.assign({}, CAN_NONE, { confirm: true })
  };
  it('shows the fee the server worked out and a Confirm commenced button', () => {
    const html = card._viewHtml(base, '');
    expect(text(html)).toContain('Commencement and guarantee');
    expect(text(html)).toContain('Planned start date 1 Feb 2027');
    expect(text(html)).toContain('Pre-start checklist Not finished');
    expect(text(html)).toContain('$21,000 ex GST');
    expect(text(html)).toContain('Standard 2026 rates');
    expect(html).toContain('data-auc-open="confirm"');
  });
  it('fee not knowable: says so and shows no dollar figure', () => {
    const v = Object.assign({}, base, { fee_preview: { known: false, tier: null, amount_ex_gst: null, variant: null, reason: 'agreement_not_signed', reason_text: 'the practice has no signed agreement on file' } });
    const html = card._viewHtml(v, '');
    expect(text(html)).toContain('The fee cannot be worked out yet: the practice has no signed agreement on file');
    expect(text(html)).toContain('confirm sessions/agreement before invoicing');
    expect(html).not.toMatch(/\$\s?\d/);
  });
  it('the confirm form: the date cannot be after today at the practice, sessions are asked as a number, and the override appears only when pre-start is unfinished', () => {
    const html = card._viewHtml(base, 'confirm');
    expect(html).toContain('name="commenced_at" max="2027-02-02" value="2027-02-01"');
    expect(html).toContain('name="sessions_per_week" min="0.5" max="14" step="0.5" inputmode="decimal" value="8"');
    expect(html).toContain('name="sessions_unknown"');
    expect(html).toContain('name="override"');
    expect(html).toContain('name="override_reason"');
    expect(text(html)).toContain('The pre-start checklist is not finished: Collect indemnity certificate, Practice credentialing pack');
    const done = card._viewHtml(Object.assign({}, base, { prestart: { complete: true, missing: [], open: [] } }), 'confirm');
    expect(done).not.toContain('name="override"');
    // a planned start date still in the future defaults the field to today
    const future = card._viewHtml(Object.assign({}, base, { placement: placement({ start_date: '2027-03-01' }) }), 'confirm');
    expect(future).toContain('name="commenced_at" max="2027-02-02" value="2027-02-02"');
  });
  it('someone who may not confirm (an RSO) gets no button and no form', () => {
    const html = card._viewHtml(Object.assign({}, base, { role: 'rso', can: CAN_NONE }), '');
    expect(html).not.toContain('data-auc-open');
    expect(text(html)).toContain('A consultant or the CEO confirms commencement');
  });
  it('no placement: one line, nothing to press', () => {
    const html = card._viewHtml({ ok: true, placement: null, can: CAN_NONE }, '');
    expect(text(html)).toContain('No placement is recorded for this doctor yet.');
    expect(html).not.toContain('<button');
  });
});

describe('the staff card: after commencement', () => {
  const commencedView = (extra, can) => ({
    ok: true, today: '2027-02-20', role: 'ceo',
    placement: placement(Object.assign({
      sessions_per_week_numeric: 8, commenced_at: '2027-02-01', commencement_confirmed_by: 'ceo@gplink-test.local', fee_tier: 'full_time', fee_amount_ex_gst: 21000,
      agreement_variant: 'standard', agreement_variant_label: 'Standard 2026 rates', invoice_due_at: '2027-02-01', guarantee_ends_at: '2027-04-26'
    }, extra || {})),
    state: Object.assign({ commenced: true, invoice: 'due', inGuarantee: true, guaranteeDaysLeft: 65, ended: false }, (extra && extra._state) || {}),
    tasks: [
      { id: 't1', kind: 'invoice_due', title: 'Raise placement-fee invoice: Dr Test Auvr at Test Metro Practice (FAKE)', status: 'open', due_date: '2027-02-01', owner: 'ceo' },
      { id: 't2', kind: 'guarantee_checkin', mark: 'w4', title: 'Week 4 check-in: Dr Test Auvr', status: 'open', due_date: '2027-03-01', owner: 'consultant' }
    ],
    exit_reasons: EXIT_REASONS,
    can: Object.assign({}, CAN_NONE, can || { correct: true, undo: true, invoice_sent: true, early_exit: true })
  });
  it('shows the commercial state and the buttons the server allows the CEO', () => {
    const html = card._viewHtml(commencedView(), '');
    const t = text(html);
    expect(t).toContain('Commenced 1 Feb 2027 (confirmed by ceo@gplink-test.local)');
    expect(t).toContain('Fee tier Full-time (8 or more sessions a week)');
    expect(t).toContain('Placement fee $21,000 ex GST (Standard 2026 rates)');
    expect(t).toContain('Invoice Due: not yet sent');
    expect(t).toContain('Guarantee period ends 26 Apr 2027 (65 days left)');
    expect(t).toContain('Week 4 check-in: Dr Test Auvr Due 1 Mar 2027');
    for (const a of ['invoice-sent', 'early-exit', 'correct', 'undo']) expect(html, a).toContain('data-auc-open="' + a + '"');
    expect(html).not.toContain('data-auc-open="invoice-paid"');
    expect(html).not.toContain('data-auc-open="confirm"');
  });
  it('a consultant sees the state and only "Doctor left during the guarantee"', () => {
    const html = card._viewHtml(commencedView({}, { early_exit: true }), '');
    expect(html).toContain('data-auc-open="early-exit"');
    for (const a of ['invoice-sent', 'invoice-paid', 'correct', 'undo', 'credit-decision']) expect(html, a).not.toContain('data-auc-open="' + a + '"');
  });
  it('fee not on file: "confirm sessions/agreement before invoicing", no dollar figure, and the sent form asks for the amount invoiced', () => {
    const v = commencedView({ fee_amount_ex_gst: null, fee_tier: null, agreement_variant: null, agreement_variant_label: '', sessions_per_week_numeric: null });
    const html = card._viewHtml(v, 'invoice-sent');
    expect(text(html)).toContain('Placement fee Not on file: confirm sessions/agreement before invoicing');
    expect(text(html)).toContain('Sessions a week Not known yet');
    expect(html).not.toMatch(/\$\s?\d/);
    expect(html).toContain('name="amount_ex_gst"');
    expect(html).toContain('name="reference"');
    expect(text(html)).toContain('The app sends nothing.');
    // with the fee on file the amount is not asked for
    expect(card._viewHtml(commencedView(), 'invoice-sent')).not.toContain('name="amount_ex_gst"');
  });
  it('the forms: correct, recorded in error, early exit and credit decision ask for what the server needs', () => {
    const v = commencedView();
    expect(card._viewHtml(v, 'correct')).toContain('name="reason"');
    expect(card._viewHtml(v, 'correct')).toContain('name="commenced_at" max="2027-02-20" value="2027-02-01"');
    const undo = card._viewHtml(v, 'undo');
    expect(text(undo)).toContain('returns the case to pre-start');
    expect(undo).toContain('name="reason"');
    const exit = card._viewHtml(v, 'early-exit');
    expect(exit).toContain('name="last_working_day" min="2027-02-01" max="2027-02-20"');
    expect(exit).toContain('<option value="doctor_resigned">The doctor ended the contract</option>');
    expect(exit).toContain('name="conditions_confirmed"');
    expect(text(exit)).toContain('The app never guesses a credit.');
    const ended = commencedView({ ended_at: '2027-02-18', end_reason: 'practice_side', status: 'ended', _state: { ended: true, inGuarantee: false } }, { credit_decision: true });
    const decision = card._viewHtml(ended, 'credit-decision');
    expect(text(decision)).toContain('Guarantee credit Not decided yet: the CEO decides (clause 7)');
    expect(decision).toContain('name="credit_pct" min="0" max="100"');
    const decided = card._viewHtml(commencedView({ ended_at: '2027-02-18', credit_pct: 80, _state: { ended: true } }, {}), '');
    expect(text(decided)).toContain('Guarantee credit 80% of the placement fee');
    // the stored reason code is shown in words, with staff's note
    const worded = card._viewHtml(commencedView({ ended_at: '2027-02-18', end_reason: 'doctor_resigned: moved interstate', credit_pct: 80, _state: { ended: true } }, {}), '');
    expect(text(worded)).toContain('Doctor left 18 Feb 2027 · The doctor ended the contract: moved interstate');
    expect(text(worded)).not.toContain('doctor_resigned');
  });
  it('everything from the server is escaped', () => {
    const html = card._viewHtml(commencedView({ practice_name: '<img src=x onerror=1>', invoice_reference: '"><script>x</script>', invoice_sent_at: '2027-02-02', invoice_payment_due_by: '2027-02-09', end_reason: '<b>' }), '');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>x');
  });
  it('dates are Australian day-month-year labels and money has a thousands separator', () => {
    expect(card._day('2027-02-01')).toBe('1 Feb 2027');
    expect(card._day('nope')).toBe('');
    expect(card._money(21000)).toBe('$21,000');
    expect(card._money(null)).toBe('');
  });
});

describe('where the card is loaded: Australian cases only, on both staff screens', () => {
  const candidates = read('js/ceo-ats-candidates.js');
  const admin = read('pages/admin.html');
  const ceo = read('pages/ceo-dashboard.html');
  const SRC = /\/js\/au-commencement\.js\?v=(\w+)/;

  it('neither page has a static script tag for it: it is fetched the first time an Australian case is opened', () => {
    expect(ceo).not.toContain('au-commencement.js');
    expect(admin).not.toMatch(/<script[^>]+au-commencement\.js/);
    expect(candidates).toMatch(/var AU_COMMENCEMENT_SRC = '\/js\/au-commencement\.js\?v=\w+';/);
    expect(admin).toMatch(/var AU_COMMENCEMENT_SRC="\/js\/au-commencement\.js\?v=\w+";/);
    expect(SRC.exec(candidates)[1]).toBe(SRC.exec(admin)[1]);
    expect(fs.existsSync(path.join(ROOT, 'js/au-commencement.js'))).toBe(true);
  });

  it('CEO dashboard: mounted only when the switch is on and the candidate is on an Australian pathway', () => {
    const at = candidates.indexOf('function auMountCommencement(c) {');
    const body = candidates.slice(at, candidates.indexOf('\n  }\n', at));
    expect(body).toContain("if (!auOn || !c || !c.au || !c.au.pathway || !c.au.pathway.isAu || !c.case_id) return;");
    expect(candidates).toContain('id="ats-au-commencement-card" hidden></div>');
    // the card's container is only ever in the Australian block of the profile
    const cards = candidates.slice(candidates.indexOf('function auCardsHtml(c) {'), candidates.indexOf('function auMountCommencement(c) {'));
    expect(cards.indexOf("if (!auOn || !c || !c.au || c.au.enabled !== true) return '';")).toBeGreaterThan(-1);
    expect(cards.indexOf('ats-au-commencement-card')).toBeGreaterThan(cards.indexOf('if (c.au.pathway && c.au.pathway.isAu) {'));
  });

  it('admin page: a case is Australian only by its own pathway or an Australian-only stage; nothing is fetched for any other case', () => {
    const at = admin.indexOf('function auCaseLooksAustralian(c){');
    const fn = admin.slice(at, admin.indexOf('\n  }\n', at) + 4);
    const looks = vm.runInNewContext('(' + fn.trim().replace(/^function auCaseLooksAustralian/, 'function') + ')');
    for (const c of [{ stage: 'myintealth' }, { stage: 'amc', pathway: null }, { stage: 'career', pathway: 'overseas_esp' }, { stage: 'ahpra', pathway: 'overseas_pep' },
      { stage: 'visa' }, { stage: 'pbs' }, { stage: 'commencement' }, { stage: 'complete' }, { stage: 'complete', pathway: '' }, null, {}]) {
      expect(looks(c), JSON.stringify(c)).toBe(false);
    }
    for (const c of [{ stage: 'prestart' }, { stage: 'commenced' }, { stage: 'guarantee' }, { stage: 'placement' }, { stage: 'complete', pathway: 'au_vr' }, { stage: 'myintealth', pathway: 'au_restricted' }]) {
      expect(looks(c), JSON.stringify(c)).toBe(true);
    }
    const mountAt = admin.indexOf('function auMountCommencementCard(c){');
    const mount = admin.slice(mountAt, admin.indexOf('\n  }\n', mountAt));
    expect(mount.indexOf('if(!auCaseLooksAustralian(c)||!c.id) return;')).toBeGreaterThan(-1);
    expect(mount.indexOf('if(!auCaseLooksAustralian(c)||!c.id) return;')).toBeLessThan(mount.indexOf('auLoadCommencementScript()'));
    expect(mount.indexOf('if(!auCaseLooksAustralian(c)||!c.id) return;')).toBeLessThan(mount.indexOf('document.createElement("div")'));
    expect(admin).toContain("auMountCommencementCard(c); // WP-13");
  });

  it('every inline script on the two staff pages and the doctor\'s pre-start page still parses', () => {
    for (const page of ['pages/admin.html', 'pages/ceo-dashboard.html', 'pages/prestart.html', 'pages/index-au.html', 'pages/pbs-au.html']) {
      const html = read(page);
      const scripts = Array.from(html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/(?:ld\+)?json")[^>]*>([\s\S]*?)<\/script>/gi)).map((m) => m[1]).filter((s) => s.trim());
      expect(scripts.length, page).toBeGreaterThan(0);
      scripts.forEach((src, i) => { expect(() => new vm.Script(src), page + ' inline script ' + i).not.toThrow(); });
    }
    for (const js of ['js/au-commencement.js', 'js/au-prestart.js', 'js/ceo-ats-candidates.js']) expect(() => new vm.Script(read(js)), js).not.toThrow();
  });

  it('cache-busters moved: the Candidates script, the stylesheet with it, the pre-start script and the service worker', () => {
    const cand = ceo.match(/ceo-ats-candidates\.js\?v=(\w+)/)[1];
    const css = ceo.match(/ceo-ats\.css\?v=(\w+)/)[1];
    expect(cand).toBe('20261125b'); // R8-01 moved it (was 20261125a: FR-7 (was 20261124c: FR-4 (was 20261124b: FR-3; (was 20261124a: FR-2; (was 20261123b: FR-1 (was 20261123a, WP-27)
    expect(css >= cand).toBe(true);
    for (const p of ['pages/prestart.html', 'pages/index-au.html', 'pages/pbs-au.html']) expect(read(p), p).toContain('<script src="/js/au-prestart.js?v=20261125c"></script>');
    expect(read('sw.js')).toContain('var VERSION = "20261125c"');
  });
});

describe('the doctor: "you have started" and "your placement has ended"', () => {
  const checklist = (extra) => gpApp.buildPrestartChecklist(Object.assign({
    placement: { key: 'app-1', practiceName: 'Test Metro Practice (FAKE)', startDate: '2027-02-01' },
    tasks: [{ task_type: 'start_date_tracking', status: 'completed', metadata: { confirmed_start_date: '2027-02-01' } }],
    documents: [], allDocuments: [], registerChecked: true, registerCheckOpen: false, details: {}, providerNumber: { recorded: true }
  }, extra || {}));

  it('the checklist: the start-date item becomes "You have started" with the actual day, and stays where the #start-date link points', () => {
    const before = checklist();
    expect(before).toMatchObject({ started: false, startedOn: null, startDate: '2027-02-01', startDateConfirmed: true });
    expect(before.items.find((x) => x.key === 'start_date').title).toBe('Start date confirmed');
    const after = checklist({ commencedAt: '2027-02-03' });
    expect(after).toMatchObject({ started: true, startedOn: '2027-02-03', startDate: '2027-02-03', startDateConfirmed: true });
    const item = after.items.find((x) => x.key === 'start_date');
    expect(item).toMatchObject({ title: 'You have started', status: 'done', statusLabel: 'Done', started: true });
    expect(item.whatToDo).toBe('You started at Test Metro Practice (FAKE) on 2027-02-03. We will check in with you over your first weeks.');
    expect(after.items.length).toBe(before.items.length);          // no item is added or removed
    expect(after.items.map((x) => x.key)).toEqual(before.items.map((x) => x.key));
    expect(checklist({ commencedAt: 'soon' }).started).toBe(false);
    // a doctor who started without ever recording their notice is not still asked for it
    const notice = after.items.find((x) => x.key === 'notice');
    expect(before.items.find((x) => x.key === 'notice')).toMatchObject({ status: 'todo' });
    expect(notice).toMatchObject({ status: 'done', action: null });
    expect(notice.whatToDo).toBe('You have started at Test Metro Practice (FAKE), so there is nothing more to do here.');
    // one who did record it keeps what they recorded
    const recorded = checklist({ commencedAt: '2027-02-03', details: { noticeGiven: true, noticeGivenDate: '2026-12-20' } }).items.find((x) => x.key === 'notice');
    expect(recorded.whatToDo).toBe('You told us you gave notice on 2026-12-20.');
  });

  const view = (extra) => Object.assign({
    ok: true, placed: true, stage: 'commenced', stageLabel: 'Started', launched: true, teamLabel: 'your GP Link team', entryRoute: '/pages/prestart',
    steps: gpApp.doctorSteps('commenced'), practiceName: 'Test Metro Practice (FAKE)', roleTitle: 'GP', providerNumber: { recorded: true }, details: {}
  }, (function () { const c = checklist({ commencedAt: '2027-02-03' }); return { items: c.items, complete: c.complete, counts: c.counts, startDate: c.startDate, startDateConfirmed: c.startDateConfirmed, started: c.started, startedOn: c.startedOn }; })(), extra || {});

  it('the pre-start page: a "You have started" card on top, the start-date anchor kept, no "ready for your first day" line', () => {
    const html = auPrestartPage._prestartHtml(view(), { open: '' });
    const t = text(html);
    expect(html.indexOf('data-au-started')).toBeGreaterThan(-1);
    // CHANGED by FB-2b (W3-D14): after the start the page is a record, with
    // no "N of M done" counter (it used to keep the pre-start counter under
    // the started card for the whole twelve weeks). Dates read "3 Feb 2027".
    expect(html).not.toContain('aua-progress');
    expect(html.indexOf('data-au-started')).toBeLessThan(html.indexOf('data-au-section="completed"'));
    expect(t).toContain('You have started at Test Metro Practice (FAKE)');
    expect(t).toContain('Your first day was 3 Feb 2027');
    expect(t).not.toContain('You are ready for your first day');
    expect(html).toContain('data-au-item="start_date" id="start-date"');
    expect(bannedIn(t)).toEqual([]);
    expect(t).not.toMatch(/guarantee|invoice|\bfee\b|credit|\$\s?\d/i);
  });

  it('Home: "You have started" replaces the checklist prompt, and the practice card says when', () => {
    // CHANGED by FB-2b (A1, W3-D13): Home is drawn from the server's
    // `viewState`. In the first week it welcomes the doctor; the practice card
    // with its "N of M pre-start items done" counter is not drawn once they
    // have started (it used to stay, with "Started: 3 February 2027").
    const html = auPrestartPage._homeHtml(view({ viewState: 'first_week' }));
    const t = text(html);
    expect(t).toContain('You have started Welcome to Test Metro Practice (FAKE)');
    expect(t).toContain('You started on 3 Feb 2027');
    expect(t).not.toContain('pre-start items done');
    expect(t).not.toContain('Your next step');
    expect(bannedIn(t)).toEqual([]);
    expect(t).not.toMatch(/guarantee|invoice|\bfee\b|credit|\$\s?\d/i);
  });

  it('a placement that has ended: one plain card on both pages, no checklist, no reason, a way back to roles', () => {
    const ended = { ok: true, placed: true, placementEnded: true, endedPracticeName: 'Test Metro Practice (FAKE)', stage: 'complete', teamLabel: 'your GP Link team', steps: gpApp.doctorSteps('complete'), items: [], complete: false, counts: { done: 0, total: 0 }, started: false };
    for (const html of [auPrestartPage._prestartHtml(ended, { open: '' }), auPrestartPage._homeHtml(ended)]) {
      const t = text(html);
      expect(t).toContain('Your placement has ended');
      expect(t).toContain('Your time at Test Metro Practice (FAKE) has finished');
      expect(t).toContain('you can look at roles again');
      expect(html).toContain('data-au-route="/pages/career"');
      expect(t).not.toContain('0 of 0');
      expect(bannedIn(t)).toEqual([]);
      expect(t).not.toMatch(/guarantee|invoice|\bfee\b|credit|resign|terminat|\$\s?\d/i);
    }
  });

  it('before commencement the two pages are exactly what WP-12 drew (no started card)', () => {
    const c = checklist();
    const v = view({ stage: 'prestart', stageLabel: 'Pre-start checks', steps: gpApp.doctorSteps('prestart', c.facts), items: c.items, complete: c.complete, counts: c.counts, startDate: c.startDate, startDateConfirmed: c.startDateConfirmed, started: false, startedOn: null });
    const html = auPrestartPage._prestartHtml(v, { open: '' });
    expect(html).not.toContain('data-au-started');
    expect(text(html)).not.toContain('You have started');
    expect(text(auPrestartPage._homeHtml(v))).toContain('Start date: 1 Feb 2027');   // CHANGED by FB-2b: the date style
  });

  it('the "position secured" slides are not shown to a doctor who has already started', () => {
    const shell = read('js/gp-walkthrough-shell.js');
    expect(shell).toContain('ctx.auStarted = !!(au.info.journey && au.info.journey.started === true);');
    const at = shell.indexOf('function runRegistrationSlides(replay) {');
    const body = shell.slice(at, shell.indexOf('I.run(I.buildRegistrationSlides(ctx)', at));
    expect(body).toContain('if (ctx.auStarted && !replay) {');
    expect(body.indexOf('markRegistrationIntroSeen();')).toBeGreaterThan(body.indexOf('if (ctx.auStarted && !replay) {'));
    // an overseas doctor's context never carries the flag (it is set only inside the Australian branch)
    const ctxAt = shell.indexOf('function slideContext() {');
    const ctxBody = shell.slice(ctxAt, shell.indexOf('return ctx;', shell.indexOf('ctx.auStarted', ctxAt)));
    expect(ctxBody.indexOf('ctx.auStarted')).toBeGreaterThan(ctxBody.indexOf('if (au && au.helper && au.info) {'));
    expect(read('pages/app-shell.html')).toContain('/js/gp-walkthrough-shell.js?v=20261125a');
    expect(read('sw.js')).toContain('"/js/gp-walkthrough-shell.js?v=20261125a"');
    expect(() => new vm.Script(shell)).not.toThrow();
  });

  it('the pre-start page\'s own line above the list follows the state', () => {
    const page = read('pages/prestart.html');
    expect(page).toContain('if (data.placementEnded) subEl.textContent = "Your placement has ended.";');
    expect(page).toContain('else if (data.started) subEl.textContent = data.practiceName ? "You have started at " + data.practiceName + "." : "You have started.";');
    expect(bannedIn(stripJsComments(read('js/au-prestart.js')))).toEqual([]);
  });
});

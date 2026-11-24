/**
 * Fix bundle FR-3, R3-01 (round 3 of the final review).
 *
 * Pressing "No" on the first onboarding question never reached the server in
 * a form it reads: the page deleted `auBranch` and saved step 0, the server
 * looked for `auBranch === 'no'`. The round-2 tests passed because they fed
 * the server a body the page never sends. So here the body is ALWAYS what the
 * real page function (`auAnswerNo` in js/onboarding.js, extracted and run)
 * hands to `saveState`, posted to the real server route.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { bootLeadCopyServer } = require('./helpers/au-wp16-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const { PRODUCTION_UNIQUE_RULES } = require('./helpers/au-supabase-emulator.js');
const auOnboarding = require('../lib/au-onboarding.js');

const ROOT = path.resolve(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'js', 'onboarding.js'), 'utf8');
const AUD = auOnboarding.AU_SIGNUP_AUDIENCE_KEY;
const H = 3600000;
const IN_HOURS = Date.parse('2027-01-12T02:00:00Z');
const NEUTRAL_WELCOME = 'Welcome to GP Link: one question to finish setting up';
const N04_SUBJECT = 'Welcome to GP Link: finish your profile in a few minutes';

/** The page's own function, as shipped. */
function pageFunction(name) {
  const start = PAGE.indexOf('  function ' + name + '(');
  expect(start, name).toBeGreaterThan(0);
  const end = PAGE.indexOf('\n  }\n', start);
  return PAGE.slice(start, end + 5);
}
/**
 * Run the page's auAnswerNo against a wizard state and return the body its
 * saveState would post (saveState itself is the page's too: it sets
 * currentStep and childrenCount, then posts JSON.stringify(state)).
 */
function pressNo(state, opts) {
  const o = opts || {};
  const posted = [];
  const src = pageFunction('auAnswerNo') + '\n' + pageFunction('saveState') + '\nauAnswerNo();';
  const localStorage = { setItem() {}, getItem() { return null; }, removeItem() {} };
  const fetchStub = (url, init) => { posted.push({ url, body: JSON.parse(init.body) }); return { catch() {} }; };
  new Function('state', 'currentStep', 'childrenCount', 'auServerRecorded', 'auWriteLocalAnswer', 'auLeave', 'auHideFirstQuestion', 'goToStep', 'localStorage', 'fetch', 'STORAGE_KEY', src)(
    state, 0, 1, !!o.serverRecorded, () => {}, () => {}, () => {}, () => {}, localStorage, fetchStub, 'k');
  return posted;
}
// The wizard's state as today's page first builds it (the keys main saves at step 0).
const freshWizard = () => ({ _version: 2, currentStep: 0, country: '', registerNumber: '', qualDocs: {}, accountReviewFlag: false,
  targetDate: '', preferredCity: '', whoMoving: '', childrenCount: 1, childrenAges: [], leadSource: '', leadSourceDetail: '', idVerification: null, completedAt: null });

let h, w, t;
let counter = 0;
function fresh(opts) {
  const o = opts || {};
  counter += 1;
  const d = buildAuDoctor('overseas_null', { idSuffix: 'q' + counter, noCase: true,
    profile: { first_name: 'Testq' + counter, registration_country: '', qualification_country: '', preferred_city: '', onboarding_completed_at: null } });
  d.state.state = Object.assign({}, o.state || {});
  if (o.updatedAt) { d.state.updated_at = o.updatedAt; d.profile.created_at = o.updatedAt; d.profile.updated_at = o.updatedAt; }
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}
const EMPTY = ['gp_nudge_log', 'gp_applications', 'user_roles', 'scheduled_calls', 'onboarding_reminders', 'registration_tasks', 'task_timeline',
  'notification_preferences', 'email_suppression', 'site_enquiries', 'placements', 'user_documents', 'admin_audit_log', 'candidate_leads', 'runtime_kv'];
function loadDb(doctors) {
  const db = buildAuFixtureDb(doctors);
  EMPTY.forEach((name) => { if (!db[name]) db[name] = []; });
  Object.keys(h.emu.db).forEach((name) => { if (name !== 'rso_team') delete h.emu.db[name]; });
  Object.keys(db).forEach((name) => { h.emu.db[name] = JSON.parse(JSON.stringify(db[name])); });
  h.emu.reset();
  h.reset();
}
const mailTo = (d) => h.emailsTo(d.email);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle() { let last = -1; for (let i = 0; i < 30; i++) { await sleep(30); if (h.emails.length === last) return; last = h.emails.length; } }
const stateOf = (d) => (h.emu.db.user_state || []).filter((r) => r.user_id === d.userId)[0].state;
const strip = (m, d) => String(m.html).split(d.profile.first_name).join('NAME').split(d.email).join('EMAIL').split(d.userId).join('UID');
async function postNo(d) {
  const posted = pressNo(freshWizard());
  expect(posted.length).toBe(1);
  expect(posted[0].url).toBe('/api/onboarding/save');
  const res = await h.post(posted[0].url, posted[0].body, { cookie: d.cookie });
  await settle();
  return { res, body: posted[0].body };
}
async function todaysWelcomeFor(ref) {
  h.emu.db.user_profiles.push(JSON.parse(JSON.stringify(ref.profile)));
  h.emu.db.user_state.push(JSON.parse(JSON.stringify(ref.state)));
  h.setSwitch(false);
  await w.sendWelcomeEmail(ref.userId);
  await settle();
  h.setSwitch(true);
  return mailTo(ref)[0];
}

beforeAll(async () => {
  h = await bootLeadCopyServer({ name: 'fr3-r301', mode: 'supabase', tables: {}, emulator: { unique: PRODUCTION_UNIQUE_RULES } });
  w = h.testUtils.__wp17;
  t = h.testUtils;
}, 60000);
afterAll(async () => { t.__setAuQuietHoursClockForTest(null); await h.closeAll(); });
beforeEach(() => { h.setSwitch(true); t.__setAuQuietHoursClockForTest(IN_HOURS); });

describe('R3-01: the page and the server agree on what a "No" looks like', () => {
  it('what the page really posts after "No" is read by the server as "not Australian"; nothing else in the saved wizard changes', () => {
    const before = freshWizard();
    const posted = pressNo(freshWizard());
    const body = posted[0].body;
    expect(body.auBranch).toBe('no');
    expect(auOnboarding.blobSaysNotAustralian(body)).toBe(true);
    expect(auOnboarding.isAuOnboardingPayload(body)).toBe(false);
    // THE ONE DIFFERENCE from the blob today's wizard saves: the recorded answer.
    const rest = Object.assign({}, body); delete rest.auBranch;
    expect(rest).toEqual(before);
    // a doctor who first said "yes" and then "no": the Australian answers are dropped
    const changed = pressNo(Object.assign(freshWizard(), { auBranch: 'yes', au: { step: 2, answers: {} } }))[0].body;
    expect(changed.auBranch).toBe('no');
    expect(changed.au).toBeUndefined();
    // a doctor whose pathway the server already recorded: the page does nothing
    expect(pressNo(freshWizard(), { serverRecorded: true })).toEqual([]);
    // the page also treats a saved "no" as answered on another device
    expect(PAGE).toContain('auReadLocalAnswer() === "no" || state.auBranch === "no"');
  });

  it('the reviewer\'s case: "No", then a pause: the server knows at once: today\'s welcome (byte for byte), audience overseas, never the neutral one', async () => {
    const d = fresh();
    const ref = fresh({ state: { gp_onboarding: { currentStep: 2, country: 'GB' } } });
    loadDb([d]);
    await w.auHoldWelcome(d.userId);
    const { res } = await postNo(d);
    expect(res.status).toBe(200);
    expect(await w.auAccountAudience(d.userId)).toBe('overseas');
    expect(await w.auWelcomeDecision(d.userId)).toMatchObject({ action: 'overseas', why: 'first_question_no' });
    const refMail = await todaysWelcomeFor(ref);
    expect(mailTo(d).length).toBe(1);
    expect(strip(mailTo(d)[0], d)).toBe(strip(refMail, ref));
    // the hour passes: nothing more, and never the neutral welcome
    h.emu.db.gp_nudge_log.forEach((r) => { r.sent_at = new Date(Date.now() - 2 * H).toISOString(); });
    await w.runAuHeldWelcomeBackstop(Date.now());
    await settle();
    expect(mailTo(d).map((m) => m.subject)).not.toContain(NEUTRAL_WELCOME);
    expect(mailTo(d).length).toBe(1);
  });

  it('arrived from an Australian page, then "No": the Australian marker is cleared and the welcome is today\'s, not the Australian one', async () => {
    const d = fresh({ state: { [AUD]: 'au' } });
    const ref = fresh({ state: { gp_onboarding: { currentStep: 2, country: 'GB' } } });
    loadDb([d]);
    await w.auHoldWelcome(d.userId);
    await postNo(d);
    expect(stateOf(d)[AUD]).toBeUndefined();
    expect(stateOf(d).gp_onboarding.auBranch).toBe('no');
    const idx = await t.auSweepPathwayIndex('test');
    expect(idx.isAuUser(d.userId)).toBe(false);
    const refMail = await todaysWelcomeFor(ref);
    expect(mailTo(d).map((m) => m.subject)).not.toContain(N04_SUBJECT);
    expect(strip(mailTo(d)[0], d)).toBe(strip(refMail, ref));
  });

  it('known as overseas only AFTER the neutral welcome went: today\'s welcome still follows, once; and today\'s reminder series from then on', async () => {
    const d = fresh({ updatedAt: '2026-11-01T00:00:00.000Z' });
    const ref = fresh({ state: { gp_onboarding: { currentStep: 2, country: 'GB' } } });
    loadDb([d]);
    await w.auHoldWelcome(d.userId);
    h.emu.db.gp_nudge_log.forEach((r) => { r.sent_at = new Date(Date.now() - 2 * H).toISOString(); });
    await w.runAuHeldWelcomeBackstop(Date.now());
    await settle();
    expect(mailTo(d).map((m) => m.subject)).toEqual([NEUTRAL_WELCOME]);
    await postNo(d);
    const refMail = await todaysWelcomeFor(ref);
    expect(mailTo(d).length).toBe(2);
    expect(strip(mailTo(d)[1], d)).toBe(strip(refMail, ref));
    // once: saving again (the page saves on every step) sends nothing more
    await postNo(d);
    expect(mailTo(d).length).toBe(2);
    // the reminder series is today's from this point
    h.emu.db.user_state.find((r) => r.user_id === d.userId).updated_at = new Date(Date.now() - 60 * H).toISOString();
    h.emu.db.onboarding_reminders = [{ id: 'rem-' + d.userId.slice(-6), user_id: d.userId, email: d.email, name: 'Test Doctor',
      anchor_at: new Date(Date.now() - 60 * H).toISOString(), last_step: 0, steps_sent: [], unsubscribed: false, stopped: false }];
    h.reset();
    const run = await h.cron('/api/cron/onboarding-nudge');
    await settle();
    expect(run.status).toBe(200);
    expect(run.json.au_neutral_reminders).toBeUndefined();
    expect(mailTo(d).map((m) => m.subject)).toEqual(['Finish setting up your GP Link account']);
  });

  it('arrived from an Australian page and VERIFIED before answering (the Australian welcome already went): "No" still brings today\'s welcome, once', async () => {
    const d = fresh({ state: { [AUD]: 'au' } });
    const ref = fresh({ state: { gp_onboarding: { currentStep: 2, country: 'GB' } } });
    loadDb([d]);
    await w.sendWelcomeEmail(d.userId);              // at verification: the page is the only evidence
    await settle();
    expect(mailTo(d).map((m) => m.subject)).toEqual([N04_SUBJECT]);
    await postNo(d);
    expect(stateOf(d)[AUD]).toBeUndefined();
    const refMail = await todaysWelcomeFor(ref);
    expect(mailTo(d).length).toBe(2);
    expect(strip(mailTo(d)[1], d)).toBe(strip(refMail, ref));
    await postNo(d);
    expect(mailTo(d).length).toBe(2);
  });

  it('known as Australian only after the neutral welcome went: the Australian welcome follows, once', async () => {
    const d = fresh();
    loadDb([d]);
    await w.auHoldWelcome(d.userId);
    h.emu.db.gp_nudge_log.forEach((r) => { r.sent_at = new Date(Date.now() - 2 * H).toISOString(); });
    await w.runAuHeldWelcomeBackstop(Date.now());
    await settle();
    await h.post('/api/onboarding/save', { auBranch: 'yes', au: { step: 0, answers: {} } }, { cookie: d.cookie });
    await settle();
    await h.post('/api/onboarding/save', { auBranch: 'yes', au: { step: 1, answers: {} } }, { cookie: d.cookie });
    await settle();
    expect(mailTo(d).map((m) => m.subject)).toEqual([NEUTRAL_WELCOME, N04_SUBJECT]);
  });

  it('switch off: the route stores what it is given and asks nothing (the page never shows the question, so no "no" is ever posted)', async () => {
    const d = fresh();
    loadDb([d]);
    h.setSwitch(false);
    h.emu.reset();
    const res = await h.post('/api/onboarding/save', freshWizard(), { cookie: d.cookie });
    expect(res.status).toBe(200);
    await settle();
    expect(mailTo(d)).toEqual([]);
    expect(h.emu.requests.some((r) => r.table === 'gp_nudge_log')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix bundle FR-3: the minor items M3-01, M3-02, M3-06.
describe('FR-3 minor items', () => {
  const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  it('M3-01: the pre-start page says the pack "is ready for" the practice, never "has gone to"', () => {
    const lib = fs.readFileSync(path.join(ROOT, 'lib', 'au-gp-app.js'), 'utf8');
    expect(lib).toContain("'Your credentialing pack is ready for ' + practice + '.'");
    expect(lib).not.toMatch(/pack has gone to/);
  });

  it('M3-02: a doctor who goes through onboarding again is shown the server\'s "nothing was changed" sentence, as text', () => {
    const at = PAGE.indexOf('outcome.auAlreadyComplete === true');
    expect(at).toBeGreaterThan(0);
    const block = PAGE.slice(at, at + 1200);
    expect(block).toContain('auNote.textContent = String(outcome.message)');
    expect(block).not.toContain('innerHTML');
    // and the server really sends that sentence on a repeat (tests/au-fr2-r202-repeat-completion.test.js pins the reply)
    expect(SERVER).toContain('Your profile is already set up, so nothing on it was changed.');
  });

  it('M3-06: the "Apply now" timeline line is claimed with one insert under the ledger\'s unique index, so two requests at the same moment write it once', async () => {
    const fn = SERVER.slice(SERVER.indexOf('async function auLogApplyIntentForStaff('), SERVER.indexOf('async function auLogApplyIntentForStaff(') + 3200);
    const claim = fn.indexOf("await _auClaimNudgeOnce(userId, claimKey, 'timeline')");
    const write = fn.indexOf("await _logCaseEvent(theCase.id, null, 'note', line.title");
    expect(claim).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(claim);                       // claimed BEFORE the line is written
    expect(fn).toContain("await _auReleaseNudgeClaim(userId, claimKey, 'timeline')");   // given back if the write fails
    // the claim itself is atomic: the second of two identical claims loses, whatever the timing
    const d = fresh();
    loadDb([d]);
    const [a, b] = await Promise.all([t.__wp17 && w.auClaimOnceForTest ? w.auClaimOnceForTest(d.userId, 'au_apply_intent_log:x:1', 'timeline') : claimTwice(d, 0), t.__wp17 && w.auClaimOnceForTest ? w.auClaimOnceForTest(d.userId, 'au_apply_intent_log:x:1', 'timeline') : claimTwice(d, 1)]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect(h.emu.db.gp_nudge_log.filter((r) => r.user_id === d.userId && r.nudge_key === 'au_apply_intent_log:x:1').length).toBe(1);
  });
});
// Two raw inserts of the same ledger row, as _auClaimNudgeOnce makes them: the unique index lets one through.
async function claimTwice(d) {
  const res = await fetch(h.emu.url + '/rest/v1/gp_nudge_log', { method: 'POST', headers: { 'content-type': 'application/json', apikey: 'x', Authorization: 'Bearer x', Prefer: 'return=minimal' },
    body: JSON.stringify([{ user_id: d.userId, nudge_key: 'au_apply_intent_log:x:1', channel: 'timeline' }]) });
  return res.ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fix bundle FR-4: minor items M4-01 and M4-02.
describe('FR-4 minor items', () => {
  const applyIntent = require('../lib/au-apply-intent.js');
  const guard = require('../lib/au-task-guard.js');
  const lifecycleLib = require('../lib/au-lifecycle.js');
  const kvOf = (d) => (h.emu.db.runtime_kv || []).filter((r) => r.key === applyIntent.kvKey(d.userId));

  it('M4-01: the newest "Apply now" press always stands: an older press, and a stamp read before the newer press, cannot land on top of it', async () => {
    const d = fresh();
    loadDb([d]);
    const at = Date.now();
    const first = applyIntent.newRecord({ job: 'prov:role-1', at: at }, 'public_job_page');
    const second = applyIntent.newRecord({ job: 'prov:role-2', at: at + 3 }, 'public_job_page');
    expect(await w.auStoreApplyIntentIfNewest(d.userId, first)).toBe(true);
    expect(kvOf(d).length).toBe(1);
    // the second press lands; then the FIRST press's late writes arrive (the reviewer's interleaving)
    expect(await w.auStoreApplyIntentIfNewest(d.userId, second)).toBe(true);
    await w.auStoreApplyIntentIfNewest(d.userId, first);                 // an older press arriving late
    await w.auStampApplyIntentLogged(d.userId, first);                   // the first press's "logged" stamp
    expect(kvOf(d).length).toBe(1);
    expect(kvOf(d)[0].value.job).toBe('prov:role-2');
    expect(kvOf(d)[0].value.loggedAt).toBeUndefined();
    // the stamp for the press that IS stored lands, and keeps the role
    await w.auStampApplyIntentLogged(d.userId, second);
    expect(kvOf(d)[0].value).toMatchObject({ job: 'prov:role-2' });
    expect(kvOf(d)[0].value.loggedAt).toBeGreaterThan(0);
    // many presses at once, in any order: the newest wins
    const e = fresh();
    h.emu.db.user_profiles.push(JSON.parse(JSON.stringify(e.profile)));
    const presses = [5, 1, 9, 3, 7].map((n) => applyIntent.newRecord({ job: 'prov:role-' + n, at: at + n }, 'public_job_page'));
    await Promise.all(presses.map((r) => w.auStoreApplyIntentIfNewest(e.userId, r)));
    await w.auStoreApplyIntentIfNewest(e.userId, presses[2]);
    expect(kvOf(e).map((r) => r.value.job)).toEqual(['prov:role-9']);
    // the old read-then-write-back is gone from the logger
    const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const fn = SERVER.slice(SERVER.indexOf('async function auLogApplyIntentForStaff('), SERVER.indexOf('async function auLogApplyIntentForStaff(') + 3600);
    expect(fn).not.toContain('auWriteApplyIntentRecord(');
  });

  it('M4-02: a withdrawn notice task cannot be reopened from the general screen', () => {
    const withdrawn = { task_type: 'manual', status: 'completed', metadata: { au: true, lifecycle_kind: lifecycleLib.KIND.EXIT_NOTICE, undone: true } };
    for (const status of ['open', 'in_progress', 'waiting']) expect(guard.requestDecision(withdrawn, { status, isCeo: true }), status).toMatchObject({ refuse: true, code: 'au_task_needs_its_action' });
    expect(guard.requestDecision(withdrawn, { status: 'open', isCeo: false }).message).toMatch(/was withdrawn/);
    // a live notice task, and every other task, is not affected by this rule
    expect(guard.requestDecision({ task_type: 'manual', metadata: { au: true, lifecycle_kind: lifecycleLib.KIND.EXIT_NOTICE } }, { status: 'in_progress' })).toEqual({ refuse: false });
    expect(guard.requestDecision({ task_type: 'manual', metadata: { undone: true } }, { status: 'open' })).toEqual({ refuse: false });
  });
});

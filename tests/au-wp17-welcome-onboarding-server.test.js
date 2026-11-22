// WP-17 on the real server: N04 (the welcome), N05 (the "finish your profile"
// reminders in the hourly job) and N08 (profile complete). The database stub
// enforces the production unique indexes, so "once" is really once.
//
//   N04  COM-08: the overseas welcome never reaches a doctor known to be
//        Australian; a brand-new sign-up's welcome is HELD until they answer
//        the first onboarding question, then the right one goes, once.
//   N05  Australian words, step labels, schedule and quiet hours; the same
//        unsubscribe and stop rules as the overseas reminders.
//   N08  replaces "Profile Complete: the next step is MyIntealth".
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootLeadCopyServer } = require('./helpers/au-wp16-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const { PRODUCTION_UNIQUE_RULES } = require('./helpers/au-supabase-emulator.js');
const { bannedIn, htmlText } = require('./helpers/au-banned-words.js');
const auMessages = require('../lib/au-messages.js');
const auOnboarding = require('../lib/au-onboarding.js');

const MARKER = auOnboarding.AU_BRANCH_MARKER_KEY;
const IN_HOURS = Date.parse('2027-01-12T02:00:00Z');   // 13:00 Sydney, 10:00 Perth: inside 08:00 to 20:00 everywhere
const QUIET = Date.parse('2027-01-12T17:00:00Z');      // 04:00 Sydney, 01:00 Perth
const H = 3600000;

let h, w, t;
let counter = 0;

function fresh(opts) {
  const o = opts || {};
  counter += 1;
  const d = buildAuDoctor(o.kind || 'overseas_null', {
    idSuffix: 'q' + counter,
    noCase: !o.withCase,
    profile: Object.assign({
      first_name: 'Testq' + counter, registration_country: '', qualification_country: '', preferred_city: '',
      onboarding_completed_at: null
    }, o.profile || {})
  });
  d.state.state = Object.assign({}, o.state || {});
  if (o.updatedAt) { d.state.updated_at = o.updatedAt; d.profile.created_at = o.updatedAt; d.profile.updated_at = o.updatedAt; }
  d.cookie = h.gpCookie(d.email, d.userId);
  return d;
}

const EMPTY = ['gp_nudge_log', 'gp_applications', 'user_roles', 'scheduled_calls', 'onboarding_reminders', 'registration_tasks', 'task_timeline',
  'notification_preferences', 'email_suppression', 'site_enquiries', 'placements', 'user_documents', 'admin_audit_log', 'candidate_leads', 'runtime_kv'];

function loadDb(doctors, extra) {
  const db = Object.assign(buildAuFixtureDb(doctors), extra || {});
  EMPTY.forEach((name) => { if (!db[name]) db[name] = []; });
  Object.keys(h.emu.db).forEach((name) => { if (name !== 'rso_team') delete h.emu.db[name]; });
  Object.keys(db).forEach((name) => { h.emu.db[name] = JSON.parse(JSON.stringify(db[name])); });
  h.emu.reset();
  h.reset();
}

const ledger = (d) => (h.emu.db.gp_nudge_log || []).filter((r) => r.user_id === d.userId).map((r) => r.nudge_key + '|' + r.channel).sort();
const mailTo = (d) => h.emailsTo(d.email);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle() { let last = -1; for (let i = 0; i < 30; i++) { await sleep(30); if (h.emails.length === last) return; last = h.emails.length; } }
const auLead = (d, segment) => ({ id: 'lead-' + d.userId.slice(-6), kind: 'gp', email: d.email, status: 'new', created_at: '2026-11-20T00:00:00.000Z',
  metadata: { consult: { segment: segment, ahpra_registered: segment !== 'overseas', country: segment === 'overseas' ? 'uk' : 'other', qualified: true, token: 'TOK' } } });
const cron = () => h.cron('/api/cron/onboarding-nudge');
const reminder = (d) => (h.emu.db.onboarding_reminders || []).filter((r) => r.user_id === d.userId)[0] || null;
const N04_SUBJECT = 'Welcome to GP Link: finish your profile in a few minutes';

beforeAll(async () => {
  h = await bootLeadCopyServer({ name: 'wp17-welcome', mode: 'supabase', tables: {}, emulator: { unique: PRODUCTION_UNIQUE_RULES } });
  w = h.testUtils.__wp17;
  t = h.testUtils;
}, 60000);
afterAll(async () => { t.__setAuQuietHoursClockForTest(null); await h.closeAll(); });
beforeEach(() => { h.setSwitch(true); t.__setAuQuietHoursClockForTest(IN_HOURS); });

describe('N04: the welcome (COM-08)', () => {
  it('a sign-up whose address belongs to an Australian-segment lead gets the Australian welcome, once, and never the overseas one', async () => {
    const d = fresh();
    loadDb([d], { site_enquiries: [auLead(d, 'au_vr')] });
    await w.sendWelcomeEmail(d.userId);
    await w.sendWelcomeEmail(d.userId);
    await settle();
    const mails = mailTo(d);
    expect(mails.length).toBe(1);
    expect(mails[0].subject).toBe(N04_SUBJECT);
    const text = htmlText(mails[0].html);
    expect(text).toContain('Your Ahpra registration number');
    expect(text).toContain('When you could be available');
    expect(text).toContain('Your notice period');
    expect(text).toContain(auMessages.CONFIDENTIALITY_LINE);
    expect(text).toContain('come back to you about the roles that fit');
    expect(bannedIn(mails[0].subject + '\n' + text)).toEqual([]);
    expect(/MyIntealth|map your move|book your free/i.test(text)).toBe(false);
    // Once ever, through the ledger; the WhatsApp leg is skipped by name.
    expect(ledger(d)).toEqual(['au_n04_welcome|email', 'au_n04_welcome|whatsapp_skipped']);
    expect(h.dt.filter((c) => c.path === '/whatsapp/message/template').length).toBe(0);
  });

  it('a lead in an unlaunched segment gets the careful wording: no roles promised', async () => {
    const d = fresh();
    loadDb([d], { site_enquiries: [auLead(d, 'au_registrar')] });
    await w.sendWelcomeEmail(d.userId);
    await settle();
    const text = htmlText(mailTo(d)[0].html);
    expect(text).toContain('come back to you about what fits your registration');
    expect(/roles that fit/.test(text)).toBe(false);
  });

  it('a doctor staff added on an Australian pathway is never sent the overseas welcome either', async () => {
    const d = fresh({ kind: 'au_vr', withCase: true });
    loadDb([d]);
    expect(await w.auWelcomeDecision(d.userId)).toMatchObject({ action: 'au', why: 'pathway', group: 'main' });
    await w.sendWelcomeEmail(d.userId);
    await settle();
    expect(mailTo(d).map((m) => m.subject)).toEqual([N04_SUBJECT]);
    // The case exists, so staff can read it on the timeline.
    const lines = (h.emu.db.task_timeline || []).filter((x) => x.case_id === d.caseId).map((x) => x.title + ' | ' + (x.detail || ''));
    expect(lines).toContain('Message N04 sent: Welcome (email) | WhatsApp skipped: no approved Australian template');
  });

  it('a brand-new sign-up nobody knows yet: nothing is sent at sign-up; "yes" to the first question sends the Australian welcome, exactly once under a double submit', async () => {
    const d = fresh();
    loadDb([d]);
    expect(await w.auWelcomeDecision(d.userId)).toMatchObject({ action: 'hold', why: 'not_answered_yet' });
    await w.sendWelcomeEmail(d.userId);
    await settle();
    expect(mailTo(d)).toEqual([]);
    expect(ledger(d)).toEqual(['au_welcome_hold|hold']);

    // The wizard's first screen saved with no answer: still held.
    const idle = await h.post('/api/onboarding/save', { currentStep: 0 }, { cookie: d.cookie });
    expect(idle.status).toBe(200);
    await settle();
    expect(mailTo(d)).toEqual([]);

    // "Yes": two saves racing (a double tap), then a third.
    h.emu.jitterMs = 15;
    const body = { currentStep: 0, auBranch: 'yes', au: { step: 0 } };
    await Promise.all([
      h.post('/api/onboarding/save', body, { cookie: d.cookie }),
      h.post('/api/onboarding/save', body, { cookie: d.cookie })
    ]);
    h.emu.jitterMs = 0;
    await h.post('/api/onboarding/save', { currentStep: 0, auBranch: 'yes', au: { step: 1 } }, { cookie: d.cookie });
    await settle();
    expect(mailTo(d).map((m) => m.subject)).toEqual([N04_SUBJECT]);
    expect(ledger(d)).toEqual(['au_n04_welcome|email', 'au_n04_welcome|whatsapp_skipped', 'au_welcome_released|email']);
  });

  it('the same sign-up answering "no": the overseas welcome goes then, byte for byte what it is with the switch off', async () => {
    const off = fresh();
    const on = fresh({ profile: { first_name: off.profile.first_name } });
    loadDb([off, on]);
    h.setSwitch(false);
    await w.sendWelcomeEmail(off.userId);
    await settle();
    const before = mailTo(off);
    expect(before.length).toBe(1);
    expect(ledger(off)).toEqual([]);

    h.setSwitch(true);
    await w.sendWelcomeEmail(on.userId);
    await settle();
    expect(mailTo(on)).toEqual([]);
    await h.post('/api/onboarding/save', { currentStep: 1, country: 'GB' }, { cookie: on.cookie });
    await h.post('/api/onboarding/save', { currentStep: 2, country: 'GB' }, { cookie: on.cookie });
    await settle();
    const after = mailTo(on);
    expect(after.length).toBe(1);
    const same = (m) => JSON.stringify({ from: m.from, subject: m.subject, html: m.html, text: m.text }).split(on.email).join('X').split(off.email).join('X');
    expect(same(after[0])).toBe(same(before[0]));
    expect(ledger(on)).toEqual(['au_welcome_released|email']);
  });

  it('an existing doctor who finished onboarding, and an overseas lead, are welcomed at once as before', async () => {
    const done = fresh({ profile: { onboarding_completed_at: '2026-10-02T00:00:00.000Z', registration_country: 'United Kingdom' } });
    const lead = fresh();
    loadDb([done, lead], { site_enquiries: [auLead(lead, 'overseas')] });
    expect((await w.auWelcomeDecision(done.userId)).action).toBe('overseas');
    expect(await w.auWelcomeDecision(lead.userId)).toMatchObject({ action: 'overseas', why: 'lead_segment' });
    await w.sendWelcomeEmail(done.userId);
    await settle();
    expect(mailTo(done).length).toBe(1);
    expect(mailTo(done)[0].subject).not.toBe(N04_SUBJECT);
    expect(ledger(done)).toEqual([]);
  });

  it('a welcome nobody answered within the hour goes as today\'s welcome from the hourly job; a fresh hold is left alone', async () => {
    const old = fresh();
    const recent = fresh();
    const branch = fresh({ state: { [MARKER]: '2026-11-20T00:00:00.000Z', gp_onboarding: { auBranch: 'yes', au: { step: 1 } } } });
    loadDb([old, recent, branch]);
    for (const d of [old, recent, branch]) await w.auHoldWelcome(d.userId);
    const now = Date.now();
    h.emu.db.gp_nudge_log.forEach((r) => { if (r.user_id !== recent.userId) r.sent_at = new Date(now - 2 * H).toISOString(); });
    const out = await w.runAuHeldWelcomeBackstop(now);
    await settle();
    expect(out).toEqual({ held: 3, released: 2 });
    expect(mailTo(old).length).toBe(1);
    expect(mailTo(old)[0].subject).not.toBe(N04_SUBJECT);
    expect(mailTo(recent)).toEqual([]);
    expect(mailTo(branch).map((m) => m.subject)).toEqual([N04_SUBJECT]);   // their saved answer says "yes"
    expect(await w.runAuHeldWelcomeBackstop(now)).toEqual({ held: 1, released: 0 });
  });

  it('a pathway that cannot be read holds the welcome; it is never guessed', async () => {
    // A doctor who would otherwise be welcomed at once (onboarding finished).
    const d = fresh({ profile: { onboarding_completed_at: '2026-10-02T00:00:00.000Z' } });
    loadDb([d]);
    expect((await w.auWelcomeDecision(d.userId)).action).toBe('overseas');
    h.emu.forbid(function (req) { return /candidate_pathway/.test(String(req.query || '')) ? 'pathway read fails' : ''; });
    let decision;
    try { decision = await w.auWelcomeDecision(d.userId); await w.sendWelcomeEmail(d.userId); await settle(); }
    finally { h.emu.forbid(null); }
    expect(h.emu.violations.length).toBeGreaterThan(0);
    expect(decision).toEqual({ action: 'hold', why: 'pathway_unreadable' });
    expect(mailTo(d)).toEqual([]);
    expect(ledger(d)).toEqual(['au_welcome_hold|hold']);
  });

  it('switch off: the welcome goes at sign-up as it always has, nothing is held, nothing Australian is read', async () => {
    const d = fresh();
    loadDb([d]);
    h.setSwitch(false);
    h.emu.reset();
    await w.sendWelcomeEmail(d.userId);
    await h.post('/api/onboarding/save', { currentStep: 1, country: 'GB' }, { cookie: d.cookie });
    await settle();
    expect(mailTo(d).length).toBe(1);
    expect(ledger(d)).toEqual([]);
    expect(h.emu.requests.length).toBeGreaterThan(0);
    expect(h.emu.requests.some((r) => r.table === 'gp_nudge_log' || /candidate_pathway/.test(String(r.query || '')))).toBe(false);
    expect(await w.runAuHeldWelcomeBackstop(Date.now())).toBe(null);
  });
});

describe('N05: the "finish your profile" reminders in the hourly job', () => {
  const twoHoursAgo = () => new Date(Date.now() - 2 * H).toISOString();
  const longAgo = '2026-11-01T00:00:00.000Z';
  function partWay(step) {
    return fresh({ updatedAt: longAgo, state: { [MARKER]: longAgo, gp_onboarding: { auBranch: 'yes', currentStep: 0, au: { step: step } } } });
  }
  const row = (d, over) => Object.assign({ id: 'rem-' + d.userId.slice(-6), user_id: d.userId, email: d.email, name: d.profile.first_name + ' ' + d.profile.last_name,
    anchor_at: twoHoursAgo(), last_step: 0, steps_sent: [], unsubscribed: false, stopped: false }, over || {});

  it('an Australian doctor part-way through gets the Australian reminder with their own step label; an overseas doctor still gets the overseas one', async () => {
    const au = partWay(2);
    const os = fresh({ updatedAt: longAgo, state: { gp_onboarding: { country: 'GB', currentStep: 2 } } });
    loadDb([au, os], { onboarding_reminders: [row(au), row(os, { last_step: 2 })] });
    const res = await cron();
    await settle();
    expect(res.status).toBe(200);
    expect(res.json.sent).toBe(2);
    expect(res.json.au_onboarding).toEqual({ sent: 1, deferred_quiet_hours: 0 });

    const mine = mailTo(au);
    expect(mine.length).toBe(1);
    expect(mine[0].subject).toBe('Finish your GP Link profile: a few minutes left');
    const text = htmlText(mine[0].html);
    expect(text).toContain('You have 4 short steps left, starting with "Your Ahpra registration".');
    expect(text).toContain(auMessages.CONFIDENTIALITY_LINE);
    expect(bannedIn(mine[0].subject + '\n' + text + '\n' + mine[0].text)).toEqual([]);
    expect(/GMC|register number|move to Australia|working in Australia\?/i.test(text)).toBe(false);
    // The link opens the wizard where they left it (a ?step= link would open the other wizard).
    expect(mine[0].html).toContain('/pages/onboarding"');
    expect(mine[0].html).not.toContain('onboarding.html?step=');
    // The same unsubscribe link and one-click headers as the overseas reminders.
    expect(mine[0].headers['List-Unsubscribe']).toMatch(/\/api\/onboarding-reminders\/unsubscribe\?u=/);
    expect(mine[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(reminder(au).steps_sent).toEqual([0]);

    const theirs = mailTo(os);
    expect(theirs.length).toBe(1);
    expect(theirs[0].subject).toBe('Finish setting up your GP Link account');
    expect(theirs[0].html).toContain('onboarding.html?step=2');

    // The next reminder is not due for a day: a second run sends nothing.
    h.reset();
    const again = await cron();
    await settle();
    expect(again.json.sent).toBe(0);
    expect(h.emails).toEqual([]);
  });

  it('the schedule is 1 hour, 24 hours, 3 days, 7 days, then it stops (four reminders, not seven)', async () => {
    const d = partWay(4);
    loadDb([d], { onboarding_reminders: [row(d, { anchor_at: new Date(Date.now() - 8 * 24 * H).toISOString() })] });
    const subjects = [];
    for (let n = 0; n < 6; n++) { h.reset(); await cron(); await settle(); mailTo(d).forEach((m) => subjects.push(m.subject)); }
    expect(subjects).toEqual([
      'Finish your GP Link profile: a few minutes left', 'Your GP Link profile is waiting',
      'A few minutes to finish your GP Link profile', 'Last reminder: your GP Link profile'
    ]);
    expect(reminder(d).steps_sent).toEqual([0, 1, 2, 3]);
    expect(reminder(d).stopped).toBe(true);
    expect(reminder(d).stopped_reason).toBe('exhausted');
  });

  it('quiet hours: outside 08:00 to 20:00 the reminder waits, unmarked, and goes on the next run inside the hours', async () => {
    const d = partWay(1);
    loadDb([d], { onboarding_reminders: [row(d)] });
    t.__setAuQuietHoursClockForTest(QUIET);
    const held = await cron();
    await settle();
    expect(held.json.au_onboarding).toEqual({ sent: 0, deferred_quiet_hours: 1 });
    expect(mailTo(d)).toEqual([]);
    expect(reminder(d).steps_sent).toEqual([]);
    t.__setAuQuietHoursClockForTest(IN_HOURS);
    const sent = await cron();
    await settle();
    expect(sent.json.au_onboarding).toEqual({ sent: 1, deferred_quiet_hours: 0 });
    expect(mailTo(d).length).toBe(1);
  });

  it('it stops exactly as the overseas reminders do: unsubscribed, reminder emails turned off, and once onboarding is finished', async () => {
    const unsub = partWay(1);
    const optedOut = partWay(1);
    const finished = fresh({ updatedAt: longAgo, state: { gp_onboarding_complete: true, gp_onboarding: { auBranch: 'yes', completedAt: longAgo, au: { step: 5 } } } });
    loadDb([unsub, optedOut, finished], {
      onboarding_reminders: [row(unsub, { unsubscribed: true }), row(optedOut), row(finished)],
      notification_preferences: [{ email: optedOut.email, email_nudges: false, whatsapp: true, push: true }]
    });
    const res = await cron();
    await settle();
    expect(res.status).toBe(200);
    expect(mailTo(unsub)).toEqual([]);
    expect(mailTo(finished)).toEqual([]);
    expect(reminder(unsub).steps_sent).toEqual([]);
    expect(reminder(finished).stopped).toBe(true);
    expect(reminder(finished).stopped_reason).toBe('completed');
    // The "email nudges" preference is asked exactly as the overseas sender asks it.
    expect(mailTo(optedOut)).toEqual([]);
    expect(reminder(optedOut).steps_sent).toEqual([]);   // left as it is, so the sequence resumes if they opt back in
    const direct = await w.sendAuOnboardingNudgeEmail({ user_id: optedOut.userId, email: optedOut.email, name: 'Test Optedout' }, 0, 1);
    expect(direct).toMatchObject({ ok: false, optedOut: true });
    expect(mailTo(optedOut)).toEqual([]);
  });

  it('a doctor who comes back and leaves again starts the sequence again from the top', async () => {
    const d = partWay(3);
    loadDb([d], { onboarding_reminders: [row(d, { steps_sent: [0, 1], anchor_at: new Date(Date.now() - 30 * 24 * H).toISOString() })] });
    h.emu.db.user_state.forEach((s) => { if (s.user_id === d.userId) s.updated_at = new Date(Date.now() - 3 * H).toISOString(); });
    const res = await cron();
    await settle();
    expect(res.json.reset).toBe(1);
    expect(reminder(d).steps_sent).toEqual([]);
    expect(mailTo(d)).toEqual([]);
  });

  it('switch off: an Australian-branch blob is just an overseas doctor mid-wizard, and gets today\'s reminder', async () => {
    const d = partWay(2);
    loadDb([d], { onboarding_reminders: [row(d)] });
    h.setSwitch(false);
    const res = await cron();
    await settle();
    expect(res.json.au_onboarding).toBeUndefined();
    expect(res.json.au_welcome_held).toBeUndefined();
    expect(mailTo(d).map((m) => m.subject)).toEqual(['Finish setting up your GP Link account']);
  });
});

describe('N08: profile complete', () => {
  function auBody(over) {
    return {
      _version: 2, currentStep: 4, country: '', registerNumber: '', qualDocs: {}, accountReviewFlag: false,
      targetDate: '', preferredCity: '', whoMoving: '', childrenCount: 1, childrenAges: [],
      leadSource: 'google', leadSourceDetail: '', idVerification: null, completedAt: null,
      auBranch: 'yes',
      au: Object.assign({
        step: 5, ahpraNumber: 'med 0001234567', registrationType: 'specialist', fellowship: 'fracgp', fellowshipDetail: '',
        hasConditions: false, conditionsDetail: '', moratorium19ab: 'no',
        workRights: 'citizen', permitSubclass: '', permitExpiry: '',
        currentPractice: 'Test Current Practice (FAKE)', noticeWeeks: 4, availableFrom: '2026-12-18',
        locations: ['Regional NSW', 'Sydney', 'Newcastle'], suburb: 'Parramatta', state: 'NSW', postcode: '2150',
        sessions: 8, detailsConfirmed: true
      }, over || {})
    };
  }

  it('finishing the Australian branch sends "we are lining up matches", once, and never "the next step is MyIntealth"', async () => {
    const d = fresh();
    loadDb([d]);
    const res = await h.post('/api/onboarding/complete', auBody(), { cookie: d.cookie });
    expect(res.status).toBe(200);
    expect(res.json.auPathway.pathway).toBe('au_vr');
    await h.post('/api/onboarding/complete', auBody(), { cookie: d.cookie });
    await settle();
    const mails = mailTo(d);
    expect(mails.map((m) => m.subject)).toEqual(['Your profile is complete: we are lining up matches']);
    const text = htmlText(mails[0].html);
    expect(text).toContain('We check your registration on the public Ahpra register');
    expect(text).toContain(auMessages.CONFIDENTIALITY_LINE);
    expect(bannedIn(text)).toEqual([]);
    expect(/MyIntealth|qualification verification/i.test(text)).toBe(false);
    expect(mails[0].html).toContain('/pages/career');
    expect(ledger(d)).toContain('au_n08_profile_complete|email');
    const caseRow = h.emu.db.registration_cases.filter((c) => c.user_id === d.userId)[0];
    const lines = (h.emu.db.task_timeline || []).filter((x) => x.case_id === caseRow.id).map((x) => x.title);
    expect(lines.filter((x) => x === 'Message N08 sent: Profile complete (email)').length).toBe(1);
  });

  it('a doctor whose answers put them in an unlaunched segment gets the careful wording: a person will be in touch, no roles promised', async () => {
    const d = fresh();
    loadDb([d]);
    const res = await h.post('/api/onboarding/complete', auBody({ registrationType: 'general', fellowship: 'none' }), { cookie: d.cookie });
    expect(res.status).toBe(200);
    expect(res.json.auPathway.launched).toBe(false);
    await settle();
    const mails = mailTo(d);
    expect(mails.map((m) => m.subject)).toEqual(['Your GP Link profile is complete']);
    const text = htmlText(mails[0].html);
    expect(text).toContain('talk through what fits your registration');
    expect(/lining up|roles that fit|a match to look at/i.test(text)).toBe(false);
    expect(bannedIn(text)).toEqual([]);
  });

  it('a welcome that was still held is retired, and what was sent before the case existed is written to its timeline', async () => {
    const d = fresh();
    loadDb([d]);
    await w.sendWelcomeEmail(d.userId);                  // held
    await h.post('/api/onboarding/save', { currentStep: 0, auBranch: 'yes', au: { step: 0 } }, { cookie: d.cookie });   // N04
    await settle();
    expect(mailTo(d).map((m) => m.subject)).toEqual([N04_SUBJECT]);
    const res = await h.post('/api/onboarding/complete', auBody(), { cookie: d.cookie });
    expect(res.status).toBe(200);
    await settle();
    expect(mailTo(d).map((m) => m.subject)).toEqual([N04_SUBJECT, 'Your profile is complete: we are lining up matches']);
    const caseRow = h.emu.db.registration_cases.filter((c) => c.user_id === d.userId)[0];
    const lines = (h.emu.db.task_timeline || []).filter((x) => x.case_id === caseRow.id).map((x) => x.title + ' | ' + (x.detail || ''));
    expect(lines.filter((x) => /^Messages sent before the profile was finished \| N04 welcome \(email\); N04 WhatsApp skipped/.test(x)).length).toBe(1);
  });

  it('an overseas doctor finishing today\'s wizard still gets "Profile Complete, GP Link", and a held welcome goes first', async () => {
    const d = fresh();
    loadDb([d]);
    await w.sendWelcomeEmail(d.userId);                  // held: nothing known yet
    const body = { _version: 2, currentStep: 4, country: 'GB', registerNumber: '', qualDocs: {}, accountReviewFlag: false,
      targetDate: '2027-08-01', preferredCity: 'Sydney', whoMoving: 'just_me', childrenCount: 1, childrenAges: [],
      leadSource: 'google', leadSourceDetail: '', idVerification: { status: 'verified', fileName: 'id.jpg' }, completedAt: '2026-11-20T03:00:00.000Z' };
    const res = await h.post('/api/onboarding/complete', body, { cookie: d.cookie });
    expect(res.status).toBe(200);
    await settle();
    const subjects = mailTo(d).map((m) => m.subject);
    expect(subjects.length).toBe(2);
    expect(subjects[1]).toBe('Profile Complete, GP Link');
    expect(subjects).not.toContain(N04_SUBJECT);
    expect(subjects).not.toContain('Your profile is complete: we are lining up matches');
  });
});

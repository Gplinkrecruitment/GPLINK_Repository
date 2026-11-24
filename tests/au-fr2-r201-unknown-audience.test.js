/**
 * Fix bundle FR-2, R2-01 (round 2 of the final review), with M2-01 and S2-09.
 *
 * THE RULE: with the switch on, an account whose audience is not positively
 * known is never sent overseas-only content. Round 1 closed the routes that
 * carry an Australian marker; the reviewer then found routes that carry none
 * ("Apply now" on a public job; "Yes" on /start and then the page's account
 * link; "Continue with Google" from an Australian page), and such an account
 * was sent today's overseas welcome after an hour and, at about 58 hours,
 * "Finish setting up" plus the overseas-only WhatsApp. The fix is by design,
 * not route by route: unknown gets neutral wording, and overseas-only content
 * needs positive overseas evidence.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { bootLeadCopyServer } = require('./helpers/au-wp16-harness.js');
const { buildAuDoctor, buildAuFixtureDb } = require('./helpers/au-fixtures.js');
const { PRODUCTION_UNIQUE_RULES } = require('./helpers/au-supabase-emulator.js');
const { bannedIn, htmlText } = require('./helpers/au-banned-words.js');
const auOnboarding = require('../lib/au-onboarding.js');
const auMessages = require('../lib/au-messages.js');

const AUD = auOnboarding.AU_SIGNUP_AUDIENCE_KEY;
const IN_HOURS = Date.parse('2027-01-12T02:00:00Z');
const H = 3600000;
const ROOT = path.resolve(__dirname, '..');
const NEUTRAL_WELCOME = 'Welcome to GP Link: one question to finish setting up';
const NEUTRAL_REMINDER = 'One question left on your GP Link profile';
const N04_SUBJECT = 'Welcome to GP Link: finish your profile in a few minutes';
const LONG_AGO = '2026-11-01T00:00:00.000Z';

let h, w, t;
let counter = 0;
function fresh(opts) {
  const o = opts || {};
  counter += 1;
  const d = buildAuDoctor(o.kind || 'overseas_null', {
    idSuffix: 'g' + counter, noCase: true,
    profile: Object.assign({ first_name: 'Testg' + counter, registration_country: '', qualification_country: '', preferred_city: '', onboarding_completed_at: null }, o.profile || {})
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
const mailTo = (d) => h.emailsTo(d.email);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle() { let last = -1; for (let i = 0; i < 30; i++) { await sleep(30); if (h.emails.length === last) return; last = h.emails.length; } }
const stateOf = (d) => (h.emu.db.user_state || []).filter((r) => r.user_id === d.userId)[0].state;
const ledger = (d) => (h.emu.db.gp_nudge_log || []).filter((r) => r.user_id === d.userId).map((r) => r.nudge_key + '|' + r.channel).sort();
const textOf = (m) => m.subject + '\n' + htmlText(m.html) + '\n' + (m.text || '');
const overseasWords = (m) => /map your move|AMC|visa|MyIntealth|moving to Australia|your move|GMC|relocat|overseas/i.test(textOf(m));
const australianWords = (m) => /Ahpra|Australian|registration number|notice period|roles that fit/i.test(textOf(m));
const overseasLead = (d) => ({ id: 'lead-ov-' + d.userId.slice(-5), kind: 'gp', email: d.email, status: 'new', created_at: '2026-11-20T00:00:00.000Z',
  metadata: { consult: { segment: 'overseas', ahpra_registered: false, country: 'uk', qualified: true, token: 'TOK' } } });
const auLeadRow = (d) => ({ id: 'lead-au-' + d.userId.slice(-5), kind: 'gp', email: d.email, status: 'new', created_at: '2026-11-20T00:00:00.000Z',
  metadata: { consult: { segment: 'au_vr', ahpra_registered: true, qualified: true, token: 'TOK' } } });
async function holdThenBackstop(d) {
  await w.auHoldWelcome(d.userId);
  const now = Date.now();
  h.emu.db.gp_nudge_log.forEach((r) => { if (r.user_id === d.userId) r.sent_at = new Date(now - 2 * H).toISOString(); });
  const out = await w.runAuHeldWelcomeBackstop(now);
  await settle();
  return out;
}
// FR-4 (S4-01, S4-02), deliberate: the "audience unknown" memo is in the nudge
// ledger now, never in the reminder row's stopped / stopped_reason (which
// main's job honours). The assertions below that used to read the row's
// stopped fields read the ledger memo, and assert the ROW is as main has it.
const memoOf = (d) => { const rows = (h.emu.db.gp_nudge_log || []).filter((r) => r.user_id === d.userId && r.channel === 'memo'); return rows.some((r) => r.nudge_key === 'au_onb_unknown_parked') ? 'parked' : (rows.some((r) => r.nudge_key === 'au_onb_unknown_pending') ? 'pending' : ''); };
const reminderRow = (d, over) => Object.assign({ id: 'rem-' + d.userId.slice(-6), user_id: d.userId, email: d.email, name: d.profile.first_name + ' ' + d.profile.last_name,
  anchor_at: new Date(Date.now() - 60 * H).toISOString(), last_step: 0, steps_sent: [], unsubscribed: false, stopped: false }, over || {});

beforeAll(async () => {
  h = await bootLeadCopyServer({ name: 'fr2-r201', mode: 'supabase', tables: {}, emulator: { unique: PRODUCTION_UNIQUE_RULES } });
  w = h.testUtils.__wp17;
  t = h.testUtils;
}, 60000);
afterAll(async () => { t.__setAuQuietHoursClockForTest(null); await h.closeAll(); });
beforeEach(() => { h.setSwitch(true); t.__setAuQuietHoursClockForTest(IN_HOURS); });

describe('R2-01: what the server positively knows about an account', () => {
  it('the matrix: every arrival route, answered and unanswered', async () => {
    const rows = {
      // route / answer                                   → audience
      nothing: fresh(),                                                                    // job "Apply now", or any unmarked route, unanswered
      marker: fresh({ state: { [AUD]: 'au' } }),                                           // Australian page link (password or Google)
      markerYes: fresh({ state: { [AUD]: 'au', gp_onboarding: { auBranch: 'yes', au: {} } } }),
      markerNo: fresh({ state: { [AUD]: 'au', gp_onboarding: { auBranch: 'no', currentStep: 0 } } }),   // M2-01
      plainYes: fresh({ state: { gp_onboarding: { auBranch: 'yes', au: {} } } }),
      plainNo: fresh({ state: { gp_onboarding: { auBranch: 'no', currentStep: 0 } } }),
      progress: fresh({ state: { gp_onboarding: { currentStep: 2, country: 'GB' } } }),
      ovLead: fresh(),
      auLead: fresh(),
      done: fresh({ profile: { onboarding_completed_at: '2026-10-01T00:00:00.000Z' } }),
      auPath: fresh({ kind: 'au_vr' }),
      ovPath: fresh({ profile: { candidate_pathway: 'overseas_esp' } })
    };
    loadDb(Object.values(rows), { site_enquiries: [overseasLead(rows.ovLead), auLeadRow(rows.auLead)] });
    const want = { nothing: 'unknown', marker: 'au', markerYes: 'au', markerNo: 'overseas', plainYes: 'au', plainNo: 'overseas',
      progress: 'overseas', ovLead: 'overseas', auLead: 'au', done: 'overseas', auPath: 'au', ovPath: 'overseas' };
    for (const k of Object.keys(want)) expect(await w.auAccountAudience(rows[k].userId), k).toBe(want[k]);
    // the overseas-only WhatsApp guard follows it: only POSITIVE overseas evidence lets one through
    for (const k of Object.keys(want)) expect(await w.auBlocksOverseasTemplates(rows[k].userId), k).toBe(want[k] !== 'overseas');
    // unreadable: fail closed
    h.emu.forbid((req) => (req.table === 'user_state' ? 'state read fails' : ''));
    try {
      expect(await w.auAccountAudience(rows.nothing.userId)).toBe('unreadable');
      expect(await w.auBlocksOverseasTemplates(rows.nothing.userId)).toBe(true);
    } finally { h.emu.forbid(null); }
  });

  it('switch off: everyone is "overseas", no template is blocked, and nothing is read', async () => {
    const d = fresh({ state: { [AUD]: 'au' } });
    loadDb([d]);
    h.setSwitch(false);
    h.emu.reset();
    expect(await w.auAccountAudience(d.userId)).toBe('overseas');
    expect(await w.auBlocksOverseasTemplates(d.userId)).toBe(false);
    expect(h.emu.requests.length).toBe(0);
  });
});

describe('R2-01 (a): the held welcome', () => {
  it('the reviewer\'s reproduction: an account nothing is known about, an hour later: the NEUTRAL welcome, once; never today\'s overseas one', async () => {
    const d = fresh();
    loadDb([d]);
    const out = await holdThenBackstop(d);
    expect(out).toMatchObject({ released: 1, neutral: 1 });
    const mails = mailTo(d);
    expect(mails.map((m) => m.subject)).toEqual([NEUTRAL_WELCOME]);
    expect(overseasWords(mails[0])).toBe(false);
    expect(australianWords(mails[0])).toBe(false);
    expect(bannedIn(textOf(mails[0]))).toEqual([]);
    expect(String(mails[0].html)).toContain('/pages/onboarding');
    expect(h.whatsapps || []).toEqual([]);
    // once only: a second pass, and a later direct call, send nothing more
    await w.runAuHeldWelcomeBackstop(Date.now());
    await settle();
    expect(mailTo(d).length).toBe(1);
    expect(ledger(d)).toContain('au_n04_neutral_welcome|email');
  });

  it('the copy itself: none of the words an Australian doctor must never see, nothing Australian-specific, and it is in the catalogue', () => {
    for (const m of [auMessages.buildNeutralWelcomeMessage({ appBaseUrl: 'https://app.test' }), auMessages.buildNeutralOnboardingReminder({ appBaseUrl: 'https://app.test' })]) {
      const all = [m.subject, m.title, m.body, m.ctaText, m.footer].join('\n');
      expect(bannedIn(all)).toEqual([]);
      expect(/Ahpra|Australia|visa|move|overseas|GMC|registration/i.test(all)).toBe(false);
      expect(m.whatsapp).toBeUndefined();
      expect(m.ctaUrl).toBe('https://app.test/pages/onboarding');
    }
    const n04 = auMessages.AU_MESSAGES.N04;
    const samples = n04.samples();
    expect(samples.some((s) => s.message && s.message.subject === NEUTRAL_WELCOME)).toBe(true);
  });

  it('positive evidence still decides: "No" → today\'s overseas welcome (even after arriving from an Australian page, M2-01); "Yes" → the Australian one', async () => {
    const no = fresh({ state: { [AUD]: 'au' } });
    const yes = fresh();
    const ref = fresh({ state: { gp_onboarding: { currentStep: 2, country: 'GB' } } });
    loadDb([no, yes, ref]);
    await w.auHoldWelcome(no.userId);
    await w.auHoldWelcome(yes.userId);
    // "No": the Australian marker is cleared and the welcome chosen is the overseas one
    const r1 = await h.post('/api/onboarding/save', { auBranch: 'no', currentStep: 0, country: '' }, { cookie: no.cookie });
    expect(r1.status).toBe(200);
    await settle();
    expect(stateOf(no)[AUD]).toBeUndefined();
    await w.sendWelcomeEmail(ref.userId);
    await settle();
    const strip = (m, d) => String(m.html).split(d.profile.first_name).join('NAME').split(d.email).join('EMAIL').split(d.userId).join('UID');
    expect(mailTo(no).length).toBe(1);
    expect(strip(mailTo(no)[0], no)).toBe(strip(mailTo(ref)[0], ref));       // byte for byte today's welcome
    // and with the marker still on the state (the order of the rule, not the clean-up, decides)
    const stuck = fresh({ state: { [AUD]: 'au', gp_onboarding: { auBranch: 'no', currentStep: 0 } } });
    h.emu.db.user_profiles.push(JSON.parse(JSON.stringify(stuck.profile)));
    h.emu.db.user_state.push(JSON.parse(JSON.stringify(stuck.state)));
    expect(await w.auWelcomeDecision(stuck.userId)).toMatchObject({ action: 'overseas', why: 'first_question_no' });
    // "Yes"
    await h.post('/api/onboarding/save', { auBranch: 'yes', au: { step: 0, answers: {} } }, { cookie: yes.cookie });
    await settle();
    expect(mailTo(yes).map((m) => m.subject)).toEqual([N04_SUBJECT]);
  });

  it('S2-09: a welcome that could not be sent because a read failed keeps its hold and goes on a later pass', async () => {
    const d = fresh({ state: { [AUD]: 'au' } });
    loadDb([d]);
    await w.auHoldWelcome(d.userId);
    h.emu.db.gp_nudge_log.forEach((r) => { r.sent_at = new Date(Date.now() - 2 * H).toISOString(); });
    // the order check inside the Australian welcome reads the ledger for N08: make that read fail
    let failing = true;
    h.emu.forbid((req) => (failing && req.table === 'gp_nudge_log' && req.method === 'GET' && /au_n08/.test(String(req.query || '')) ? 'ledger read fails' : ''));
    try {
      await w.runAuHeldWelcomeBackstop(Date.now());
      await settle();
      expect(mailTo(d)).toEqual([]);
      expect(ledger(d).some((k) => /^au_welcome_hold|hold/.test(k))).toBe(true);     // still held
      failing = false;
      await w.runAuHeldWelcomeBackstop(Date.now());
      await settle();
    } finally { h.emu.forbid(null); }
    expect(mailTo(d).map((m) => m.subject)).toEqual([N04_SUBJECT]);
  });
});

describe('R2-01 (b): the onboarding reminder series and its WhatsApp', () => {
  it('the reviewer\'s reproduction at 58 hours: an unknown account gets ONE neutral email and no WhatsApp; a known overseas doctor gets today\'s reminder exactly as before', async () => {
    // FR-3 (R3-02), deliberate: the one neutral email goes only to an account
    // FIRST SEEN with the switch on while it is less than a day idle (it used
    // to go to any unknown account with a reminder row, which on the first
    // run after switch-on would have been every parked account at once). So
    // this account is first seen young (no row yet), then ages.
    const unknown = fresh({ updatedAt: new Date(Date.now() - 2 * H).toISOString() });
    const noAnswer = fresh({ updatedAt: LONG_AGO, state: { gp_onboarding: { auBranch: 'no', currentStep: 0 } } });
    const lead = fresh({ updatedAt: LONG_AGO });
    const moved = fresh({ updatedAt: LONG_AGO, state: { gp_onboarding: { currentStep: 1, country: 'GB' } } });
    loadDb([unknown, noAnswer, lead, moved], { site_enquiries: [overseasLead(lead)] });
    h.emu.db.onboarding_reminders = [reminderRow(noAnswer), reminderRow(lead), reminderRow(moved, { last_step: 1 })];
    const firstSight = await h.cron('/api/cron/onboarding-nudge');
    await settle();
    expect(firstSight.status).toBe(200);
    expect(mailTo(unknown)).toEqual([]);
    // positively overseas (a "No", an overseas lead, progress in the wizard): today's series, on this first run
    for (const d of [noAnswer, lead, moved]) expect(mailTo(d).map((m) => m.subject), d.email).toEqual(['Finish setting up your GP Link account']);
    h.reset();
    const unknownRow = () => h.emu.db.onboarding_reminders.find((r) => r.user_id === unknown.userId);
    expect(memoOf(unknown)).toBe('pending');
    expect(unknownRow().steps_sent).toEqual([]);
    expect(unknownRow().stopped || false).toBe(false);
    expect(unknownRow().stopped_reason || null).toBeNull();
    // 58 hours pass with the first question unanswered
    const aged = new Date(Date.now() - 58 * H).toISOString();
    h.emu.db.user_state.find((r) => r.user_id === unknown.userId).updated_at = aged;
    Object.assign(h.emu.db.user_profiles.find((r) => r.user_id === unknown.userId), { created_at: aged, updated_at: aged });
    unknownRow().anchor_at = aged;
    const res = await h.cron('/api/cron/onboarding-nudge');
    await settle();
    expect(res.status).toBe(200);
    expect(res.json.au_neutral_reminders).toBe(1);
    expect(memoOf(unknown)).toBe('parked');
    expect(unknownRow().stopped || false).toBe(false);          // the row is never stopped by this build
    const um = mailTo(unknown);
    expect(um.map((m) => m.subject)).toEqual([NEUTRAL_REMINDER]);
    expect(overseasWords(um[0])).toBe(false);
    expect(australianWords(um[0])).toBe(false);
    expect(bannedIn(textOf(um[0]))).toEqual([]);
    // no WhatsApp of any kind to the unknown account
    const waTo = (h.whatsapps || []).map((x) => JSON.stringify(x));
    expect(waTo.some((x) => x.indexOf(unknown.userId) !== -1)).toBe(false);
    expect(ledger(unknown).filter((k) => /whatsapp/.test(k))).toEqual([]);
    // the series row of the unknown account was not advanced (so today's series starts properly if they answer "No" later)
    expect(h.emu.db.onboarding_reminders.find((r) => r.user_id === unknown.userId).steps_sent).toEqual([]);
    // once ever
    h.reset();
    const again = await h.cron('/api/cron/onboarding-nudge');
    await settle();
    expect(again.json.au_neutral_reminders).toBeUndefined();
    expect(mailTo(unknown)).toEqual([]);
    expect(again.json.au_audience_checks).toBeUndefined();     // FR-3 (S3-05): a parked account costs no read
  });

  it('the overseas-only WhatsApp sender refuses an unknown account by name, and lets a known overseas doctor through to the ordinary checks', async () => {
    const unknown = fresh();
    const moved = fresh({ state: { gp_onboarding: { currentStep: 1, country: 'GB' } } });
    loadDb([unknown, moved]);
    expect(await w.maybeSendDropoffWa(unknown.userId, 'Test Unknown', 'onb_step_start', { templateName: 'gp_link_onboarding_step_start', buttonParam: 0 }))
      .toEqual({ ok: false, skipped: 'au_no_overseas_template' });
    const ok = await w.maybeSendDropoffWa(moved.userId, 'Test Moved', 'onb_step_start', { templateName: 'gp_link_onboarding_step_start', buttonParam: 0 });
    expect(ok.skipped).not.toBe('au_no_overseas_template');
  });

  it('not before a day of inactivity, not outside sending hours, and not to someone who turned reminders off', async () => {
    const soon = fresh({ updatedAt: new Date(Date.now() - 3 * H).toISOString() });
    const night = fresh({ updatedAt: LONG_AGO });
    loadDb([soon, night]);
    expect(await w.auSendNeutralOnboardingReminder({ userId: soon.userId, email: soon.email, lastActiveMs: Date.now() - 3 * H }, Date.now())).toBe('skipped');
    t.__setAuQuietHoursClockForTest(Date.parse('2027-01-12T15:00:00Z'));       // 02:00 in Sydney
    // FR-3, deliberate: held by quiet hours is now told apart ('deferred': tried again in the morning).
    expect(await w.auSendNeutralOnboardingReminder({ userId: night.userId, email: night.email, lastActiveMs: Date.parse(LONG_AGO) }, Date.now())).toBe('deferred');
    t.__setAuQuietHoursClockForTest(IN_HOURS);
    expect(await w.auSendNeutralOnboardingReminder({ userId: night.userId, email: night.email, lastActiveMs: Date.parse(LONG_AGO) }, Date.now())).toBe('sent');
    expect(await w.auSendNeutralOnboardingReminder({ userId: night.userId, email: night.email, lastActiveMs: Date.parse(LONG_AGO) }, Date.now())).toBe('already_sent');
    await settle();
    expect(mailTo(soon)).toEqual([]);
    expect(mailTo(night).length).toBe(1);
  });

  it('switch off: the series is exactly today\'s for everyone (an unknown account gets "Finish setting up")', async () => {
    const d = fresh({ updatedAt: LONG_AGO });
    loadDb([d]);
    h.emu.db.onboarding_reminders = [reminderRow(d)];
    h.setSwitch(false);
    const res = await h.cron('/api/cron/onboarding-nudge');
    await settle();
    expect(res.json.au_neutral_reminders).toBeUndefined();
    expect(mailTo(d).map((m) => m.subject)).toEqual(['Finish setting up your GP Link account']);
  });
});

describe('R2-01 (c): the routes that carry the marker', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('/start: a visitor who answered "Yes" carries it on the page\'s account links (inside the switch-on markup only)', () => {
    const html = read('pages/site-start.html');
    const at = html.indexOf("a.setAttribute('href', href + '&aud=au')");
    expect(at).toBeGreaterThan(0);
    // inside an <!--au:on--> block, so the switch-off page is byte for byte unchanged
    expect(html.lastIndexOf('<!--au:on-->', at)).toBeGreaterThan(html.lastIndexOf('<!--/au:on-->', at));
    // run the handler as the page does
    const src = html.slice(html.lastIndexOf("document.addEventListener('click'", at), html.indexOf('}, true);', at) + '}, true);'.length);
    const run = (answer, href) => {
      let handler = null;
      const a = { href, getAttribute: () => a.href, setAttribute: (k, v) => { a.href = v; } };
      const document = { addEventListener: (ev, fn) => { handler = fn; } };
      const auForm = answer === null ? null : { isAu: () => answer === 'yes', answer: () => answer };
      new Function('document', 'auForm', src)(document, auForm);
      handler({ target: { closest: (sel) => (/^\/pages\/signin\?signup=1/.test(a.href) ? a : null) } });
      return a.href;
    };
    expect(run('yes', '/pages/signin?signup=1')).toBe('/pages/signin?signup=1&aud=au');
    expect(run('yes', '/pages/signin?signup=1&email=x%40gplink-test.local')).toBe('/pages/signin?signup=1&email=x%40gplink-test.local&aud=au');
    expect(run('yes', '/pages/signin?signup=1&aud=au')).toBe('/pages/signin?signup=1&aud=au');
    expect(run('no', '/pages/signin?signup=1')).toBe('/pages/signin?signup=1');
    expect(run('no', '/pages/signin?signup=1&aud=au')).toBe('/pages/signin?signup=1');
    expect(run('', '/pages/signin?signup=1')).toBe('/pages/signin?signup=1');
    expect(run(null, '/pages/signin?signup=1')).toBe('/pages/signin?signup=1');
  });

  it('"Continue with Google": the sign-in page carries the marker through the round trip and posts it', () => {
    const html = read('pages/signin.html');
    expect(html).toContain('oauthAud = "aud=au"');
    expect(html).toContain('oauthBody.audience = "au"');
  });

  it('a Google sign-up from an Australian page records the same evidence as a password sign-up; an existing account signing in is left alone', async () => {
    const src = read('server.js');
    const at = src.indexOf("{ source: 'signup_oauth' }");
    const block = src.slice(at, at + 900);
    expect(block).toContain('auOnboarding.isAuSignupAudienceMarker(body.audience)');
    expect(block).toContain('await auRecordSignupAudience(sessionProfile.supabaseUserId, email)');
    // inside the "account has just been created" branch
    expect(src.lastIndexOf('oauthCreatedMs < 15 * 60 * 1000', at)).toBeGreaterThan(at - 600);
    // and what the recorder does with it
    const d = fresh();
    loadDb([d]);
    expect(await w.auRecordSignupAudience(d.userId, d.email)).toBe(true);
    expect(await w.auAccountAudience(d.userId)).toBe('au');
  });

  it('the public job page\'s "Apply now" is for both audiences, so it carries no marker: that account is "unknown" and is covered by the neutral wording above', () => {
    const js = read('js/site-au-jobs.js');
    expect(js).not.toContain('aud=au');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix bundle FR-3, R3-02 and S3-05 (round 3 of the final review).
describe('FR-3 R3-02: the neutral reminder honours the reminder row and never reaches an account parked before the switch', () => {
  const rowOf = (d) => h.emu.db.onboarding_reminders.find((r) => r.user_id === d.userId);
  const age = (d, hours) => {
    const at = new Date(Date.now() - hours * H).toISOString();
    h.emu.db.user_state.find((r) => r.user_id === d.userId).updated_at = at;
    Object.assign(h.emu.db.user_profiles.find((r) => r.user_id === d.userId), { created_at: at, updated_at: at });
    if (rowOf(d)) rowOf(d).anchor_at = at;
  };
  const run = async () => { const r = await h.cron('/api/cron/onboarding-nudge'); await settle(); return r; };

  it('the first run after switch-on with many old parked accounts: ZERO neutral reminders, each is parked once, and the next run reads nothing for them', async () => {
    const parked = [];
    for (let i = 0; i < 12; i++) parked.push(fresh({ updatedAt: new Date(Date.now() - (2 + i * 5) * 24 * H).toISOString() }));
    loadDb(parked);
    // what the job had already written for them before the switch: a row each, some with reminders already sent, some finished
    h.emu.db.onboarding_reminders = parked.map((d, i) => reminderRow(d, {
      anchor_at: new Date(Date.now() - (2 + i * 5) * 24 * H).toISOString(),
      steps_sent: i % 3 === 0 ? [] : (i % 3 === 1 ? [0, 1] : [0, 1, 2, 3, 4, 5, 6]),
      stopped: i % 3 === 2, stopped_reason: i % 3 === 2 ? 'exhausted' : null
    }));
    // and two never seen by the job at all, long idle (no row)
    const unseen = [fresh({ updatedAt: LONG_AGO }), fresh({ updatedAt: LONG_AGO })];
    unseen.forEach((d) => { h.emu.db.user_profiles.push(JSON.parse(JSON.stringify(d.profile))); h.emu.db.user_state.push(JSON.parse(JSON.stringify(d.state))); });
    const first = await run();
    expect(first.status).toBe(200);
    expect(first.json.au_neutral_reminders).toBeUndefined();
    expect(h.emails.length).toBe(0);
    expect((h.whatsapps || []).length).toBe(0);
    for (const d of parked.concat(unseen)) expect(rowOf(d).stopped_reason === 'exhausted' || memoOf(d) === 'parked', d.email).toBe(true);
    // the rows themselves are exactly as main has them: only the four finished ones are stopped
    expect(parked.concat(unseen).filter((d) => rowOf(d).stopped === true).length).toBe(4);
    // an "exhausted" row keeps its own reason; the others are parked by name
    expect(parked.filter((d) => rowOf(d).stopped_reason === 'exhausted').length).toBe(4);
    expect(parked.concat(unseen).filter((d) => memoOf(d) === 'parked').length).toBe(10);
    // S3-05: one audience check per account that needed one, once; the exhausted ones cost none
    expect(first.json.au_audience_checks).toBe(10);
    h.emu.reset();
    const second = await run();
    expect(second.json.au_audience_checks).toBeUndefined();
    expect(second.json.au_neutral_reminders).toBeUndefined();
    expect(h.emails.length).toBe(0);
    // the second run made no per-account read at all: only the job's own list reads
    const perAccount = h.emu.requests.filter((r) => !/in\.\(/.test(String(r.query || '')) && parked.concat(unseen).some((d) => String(r.query || '').indexOf(d.userId) !== -1));
    expect(perAccount.map((r) => r.method + ' ' + r.table + ' ' + String(r.query).slice(0, 80))).toEqual([]);
  });

  it('"Unsubscribe" and "stopped" are honoured before anything is read or sent; the email carries the same unsubscribe link, footer and headers as today\'s reminder', async () => {
    const unsub = fresh({ updatedAt: new Date(Date.now() - 2 * H).toISOString() });
    const ok = fresh({ updatedAt: new Date(Date.now() - 2 * H).toISOString() });
    loadDb([unsub, ok]);
    await run();                                   // first sight: both pending
    expect(memoOf(unsub)).toBe('pending');
    rowOf(unsub).unsubscribed = true;              // they pressed Unsubscribe
    age(unsub, 30); age(ok, 30);
    h.emu.reset();
    const res = await run();
    expect(res.json.au_neutral_reminders).toBe(1);
    expect(mailTo(unsub)).toEqual([]);
    expect(h.emu.requests.filter((r) => !/in\.\(/.test(String(r.query || '')) && String(r.query || '').indexOf(unsub.userId) !== -1).map((r) => r.method + ' ' + r.table + ' ' + String(r.query).slice(0, 80))).toEqual([]);
    const m = mailTo(ok)[0];
    expect(m.subject).toBe(NEUTRAL_REMINDER);
    expect(String(m.html)).toContain('/api/onboarding-reminders/unsubscribe?u=' + encodeURIComponent(ok.userId) + '&t=');
    expect(String(m.html)).toContain('Unsubscribe from these reminders');
    expect(String(m.text)).toContain('Unsubscribe: ');
    expect(m.headers).toMatchObject({ 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
    expect(String(m.headers['List-Unsubscribe'])).toContain('/api/onboarding-reminders/unsubscribe?u=');
    expect(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').split('async function auSendNeutralOnboardingReminder')[1].slice(0, 3000)).toContain("category: 'marketing'");
    // direct: a stopped or unsubscribed row is refused by the sender itself too
    const gp = { userId: ok.userId, email: ok.email, name: 'Test Doctor', lastActiveMs: Date.now() - 40 * H };
    expect(await w.auSendNeutralOnboardingReminder(gp, Date.now(), { unsubscribed: true })).toBe('skipped');
    expect(await w.auSendNeutralOnboardingReminder(gp, Date.now(), { stopped: true })).toBe('skipped');
  });

  it('a parked account that comes back and answers "No" gets today\'s series from that point; one that moves past the first screen needs no read', async () => {
    const no = fresh({ updatedAt: LONG_AGO });
    const moved = fresh({ updatedAt: LONG_AGO });
    loadDb([no, moved]);
    h.emu.db.onboarding_reminders = [reminderRow(no), reminderRow(moved)];
    await run();
    expect(memoOf(no)).toBe('parked');
    expect(rowOf(no).stopped || false).toBe(false);
    // they come back
    const nowIso = new Date().toISOString();
    Object.assign(h.emu.db.user_state.find((r) => r.user_id === no.userId), { updated_at: nowIso, state: { gp_onboarding: { auBranch: 'no', currentStep: 0 } } });
    Object.assign(h.emu.db.user_state.find((r) => r.user_id === moved.userId), { updated_at: nowIso, state: { gp_onboarding: { currentStep: 1, country: 'GB' } } });
    const back = await run();
    expect(back.json.au_audience_checks).toBe(1);          // only the one still on the first screen
    for (const d of [no, moved]) { expect(memoOf(d), d.email).toBe(''); expect(rowOf(d).steps_sent, d.email).toEqual([]); expect(rowOf(d).stopped || false).toBe(false); }
    // two hours of silence later: today's first reminder, for both
    for (const d of [no, moved]) age(d, 2);
    h.reset();
    await run();
    for (const d of [no, moved]) expect(mailTo(d).map((x) => x.subject), d.email).toEqual(['Finish setting up your GP Link account']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix bundle FR-4: S4-01, S4-02, S4-03 (round 4 of the final review).
describe('FR-4 S4-01, S4-02, S4-03: parking that main never sees; un-parked when the audience is known; the welcome follows a changed answer', () => {
  const rowOf = (d) => h.emu.db.onboarding_reminders.find((r) => r.user_id === d.userId);
  const age = (d, hours) => {
    const at = new Date(Date.now() - hours * H).toISOString();
    h.emu.db.user_state.find((r) => r.user_id === d.userId).updated_at = at;
    Object.assign(h.emu.db.user_profiles.find((r) => r.user_id === d.userId), { created_at: at, updated_at: at });
    if (rowOf(d)) rowOf(d).anchor_at = at;
  };
  const run = async () => { const r = await h.cron('/api/cron/onboarding-nudge'); await settle(); return r; };
  const save = async (d, body) => { const r = await h.post('/api/onboarding/save', body, { cookie: d.cookie }); await settle(); return r; };

  it('S4-02: switch OFF over a parked account: main\'s job treats it exactly as on main (today\'s reminder goes); nothing of the parking is in the reminder row', async () => {
    const d = fresh({ updatedAt: LONG_AGO });
    const twin = fresh({ updatedAt: LONG_AGO });            // never seen with the switch on
    loadDb([d, twin]);
    h.emu.db.onboarding_reminders = [reminderRow(d), reminderRow(twin)];
    await run();                                             // switch on: parked, silently
    expect(memoOf(d)).toBe('parked');
    expect(mailTo(d)).toEqual([]);
    // the row is byte for byte what it was (main would not have changed it either without sending)
    expect(JSON.stringify(Object.assign({}, rowOf(d), { id: 0, user_id: 0, email: 0, name: 0, updated_at: 0 }))).toBe(JSON.stringify(Object.assign({}, rowOf(twin), { id: 0, user_id: 0, email: 0, name: 0, updated_at: 0 })));
    h.setSwitch(false);
    h.reset();
    h.emu.reset();
    const off = await run();
    expect(off.status).toBe(200);
    // main's selection: both accounts get today's reminder, the parked one exactly like its twin
    expect(mailTo(d).map((m) => m.subject)).toEqual(['Finish setting up your GP Link account']);
    expect(mailTo(twin).map((m) => m.subject)).toEqual(['Finish setting up your GP Link account']);
    expect(rowOf(d).steps_sent).toEqual(rowOf(twin).steps_sent);
    expect(h.emu.requests.some((r) => r.table === 'gp_nudge_log' && /memo/.test(String(r.query || '')))).toBe(false);   // the memo is not even read
  });

  it('S4-02: a row FR-2 / FR-3 code had stopped is put back as main would have it, and parked in the ledger instead', async () => {
    const d = fresh({ updatedAt: LONG_AGO });
    loadDb([d]);
    h.emu.db.onboarding_reminders = [reminderRow(d, { stopped: true, stopped_reason: 'au_audience_unknown' })];
    await run();
    expect(rowOf(d)).toMatchObject({ stopped: false, stopped_reason: null });
    expect(memoOf(d)).toBe('parked');
    expect(mailTo(d)).toEqual([]);
  });

  it('S4-01, the reviewer\'s case: waits a day (parked), then answers "Yes" and stops part-way: un-parked at once, and the Australian reminders follow', async () => {
    const d = fresh({ updatedAt: LONG_AGO });
    loadDb([d]);
    h.emu.db.onboarding_reminders = [reminderRow(d)];
    await run();
    expect(memoOf(d)).toBe('parked');
    await save(d, { auBranch: 'yes', au: { step: 1, answers: {} } });
    expect(memoOf(d)).toBe('');                                  // un-parked by the save itself, not by a later job
    await run();                                                 // (the job sees the return and resets the row)
    age(d, 2);
    h.reset();
    const res = await run();
    expect(res.json.au_onboarding).toMatchObject({ sent: 1 });
    expect(mailTo(d).map((m) => m.subject)).toEqual(['Finish your GP Link profile: a few minutes left']);
  });

  it('S4-01: parked, then "No": un-parked at once and today\'s series follows', async () => {
    const d = fresh({ updatedAt: LONG_AGO });
    loadDb([d]);
    h.emu.db.onboarding_reminders = [reminderRow(d)];
    await run();
    await save(d, { auBranch: 'no', currentStep: 0, country: '' });
    expect(memoOf(d)).toBe('');
    await run();
    age(d, 2);
    h.reset();
    await run();
    expect(mailTo(d).map((m) => m.subject)).toEqual(['Finish setting up your GP Link account']);
  });

  it('S4-03, the reviewer\'s case: "Yes" by mistake, then "No": today\'s welcome is sent once, the Australian marker is gone and the Australian reminders stop', async () => {
    const d = fresh();
    loadDb([d]);
    await w.auHoldWelcome(d.userId);
    await save(d, { auBranch: 'yes', au: { step: 0, answers: {} } });
    expect(mailTo(d).map((m) => m.subject)).toEqual([N04_SUBJECT]);
    await save(d, { auBranch: 'no', currentStep: 0, country: '' });
    const subjects = mailTo(d).map((m) => m.subject);
    expect(subjects.length).toBe(2);
    expect(subjects[1]).not.toBe(N04_SUBJECT);
    expect(overseasWords(mailTo(d)[1])).toBe(true);              // today's "map your move" welcome
    await save(d, { auBranch: 'no', currentStep: 0, country: '' });
    await save(d, { auBranch: 'no', currentStep: 1, country: 'GB' });
    expect(mailTo(d).length).toBe(2);                            // once
    expect((await t.auSweepPathwayIndex('test')).isAuUser(d.userId)).toBe(false);
    // and back again ("No" by mistake, then "Yes"): no second Australian welcome (it already went once)
    await save(d, { auBranch: 'yes', au: { step: 0, answers: {} } });
    expect(mailTo(d).length).toBe(2);
  });

  it('S4-03 the other way: "No" first (today\'s welcome), then "Yes": the Australian welcome is sent once', async () => {
    const d = fresh();
    loadDb([d]);
    await w.auHoldWelcome(d.userId);
    await save(d, { auBranch: 'no', currentStep: 0, country: '' });
    expect(mailTo(d).length).toBe(1);
    await save(d, { auBranch: 'yes', au: { step: 0, answers: {} } });
    await save(d, { auBranch: 'yes', au: { step: 1, answers: {} } });
    expect(mailTo(d).map((m) => m.subject).filter((x) => x === N04_SUBJECT).length).toBe(1);
    expect(mailTo(d).length).toBe(2);
  });

  it('a save that does not change the answer reads nothing from the ledger (cost: one read per change only)', async () => {
    const d = fresh();
    loadDb([d]);
    await save(d, { auBranch: 'no', currentStep: 0, country: '' });
    h.emu.reset();
    await save(d, { auBranch: 'no', currentStep: 0, country: 'GB' });
    await save(d, { auBranch: 'no', currentStep: 2, country: 'GB' });
    expect(h.emu.requests.filter((r) => r.table === 'gp_nudge_log')).toEqual([]);
  });
});

// Fix bundle FR-5, M5-01 and M5-03.
describe('FR-5 M5-01, M5-03', () => {
  const save = async (d, body) => { const r = await h.post('/api/onboarding/save', body, { cookie: d.cookie }); await settle(); return r; };
  it('M5-01: No, then Yes, then No again: today\'s welcome goes once, the Australian welcome once', async () => {
    const d = fresh();
    loadDb([d]);
    await w.auHoldWelcome(d.userId);
    for (const body of [{ auBranch: 'no', currentStep: 0, country: '' }, { auBranch: 'yes', au: { step: 0, answers: {} } }, { auBranch: 'no', currentStep: 0, country: '' },
      { auBranch: 'yes', au: { step: 0, answers: {} } }, { auBranch: 'no', currentStep: 0, country: '' }]) await save(d, body);
    const subjects = mailTo(d).map((m) => m.subject);
    expect(subjects.filter((x) => x === N04_SUBJECT).length).toBe(1);
    expect(subjects.length).toBe(2);
  });
  it('M5-03: the reminder memo is read in pages of 1,000, so more than 1,000 parked accounts are all seen', async () => {
    loadDb([]);
    h.emu.db.gp_nudge_log = [];
    for (let i = 0; i < 2300; i++) h.emu.db.gp_nudge_log.push({ id: 'm' + i, user_id: 'user-' + String(i).padStart(5, '0'), nudge_key: i % 2 ? 'au_onb_unknown_parked' : 'au_onb_unknown_pending', channel: 'memo', sent_at: new Date().toISOString() });
    h.emu.reset();
    const memos = await w.auReadOnboardingMemos();
    expect(Object.keys(memos).length).toBe(2300);
    expect(memos['user-00001']).toBe('parked');
    expect(memos['user-02298']).toBe('pending');
    const reads = h.emu.requests.filter((r) => r.table === 'gp_nudge_log');
    expect(reads.length).toBe(3);
    for (const r of reads) expect(String(r.query)).toContain('limit=1000');
  });
});

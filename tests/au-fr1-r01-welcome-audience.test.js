// Fix bundle FR-1 (final review):
//   R-01  an Australian sign-up never gets the overseas welcome or the
//         overseas onboarding reminders
//   S-02  N04 ("finish your profile") is never sent once the profile is
//         complete, or after N08 / N06 have gone
// On the real server, with the production unique indexes.
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

const AUD = auOnboarding.AU_SIGNUP_AUDIENCE_KEY;
const IN_HOURS = Date.parse('2027-01-12T02:00:00Z');
const H = 3600000;
const N04_SUBJECT = 'Welcome to GP Link: finish your profile in a few minutes';
const ROOT = path.resolve(__dirname, '..');

let h, w, t;
let counter = 0;
function fresh(opts) {
  const o = opts || {};
  counter += 1;
  const d = buildAuDoctor(o.kind || 'overseas_null', {
    idSuffix: 'f' + counter, noCase: !o.withCase,
    profile: Object.assign({ first_name: 'Testf' + counter, registration_country: '', qualification_country: '', preferred_city: '', onboarding_completed_at: null }, o.profile || {})
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
const stateOf = (d) => (h.emu.db.user_state || []).filter((r) => r.user_id === d.userId)[0].state;
const attribution = (d, landing, segment) => ({ key: 'signup_attribution:' + d.userId, value: { v: 1, first: { landing_page: landing, at: '2026-11-23T00:00:00.000Z' }, last: { landing_page: landing, at: '2026-11-23T00:00:00.000Z' }, source: 'signup', segment: segment }, updated_at: '2026-11-23T00:00:00.000Z' });
async function holdThenBackstop(d) {
  await w.auHoldWelcome(d.userId);
  const now = Date.now();
  h.emu.db.gp_nudge_log.forEach((r) => { if (r.user_id === d.userId) r.sent_at = new Date(now - 2 * H).toISOString(); });
  const out = await w.runAuHeldWelcomeBackstop(now);
  await settle();
  return out;
}
const overseasWords = (mail) => /map your move|AMC|visa|MyIntealth|moving to Australia|your move/i.test(mail.subject + '\n' + htmlText(mail.html));

beforeAll(async () => {
  h = await bootLeadCopyServer({ name: 'fr1-r01', mode: 'supabase', tables: {}, emulator: { unique: PRODUCTION_UNIQUE_RULES } });
  w = h.testUtils.__wp17;
  t = h.testUtils;
}, 60000);
afterAll(async () => { t.__setAuQuietHoursClockForTest(null); await h.closeAll(); });
beforeEach(() => { h.setSwitch(true); t.__setAuQuietHoursClockForTest(IN_HOURS); });

describe('R-01: the evidence that someone signed up as an Australian GP', () => {
  it('the reviewer\'s reproduction: signed up from /australian-gps, never answered the first question, an hour passes: the Australian welcome goes, never the overseas one', async () => {
    const d = fresh();
    loadDb([d], { runtime_kv: [attribution(d, '/australian-gps', 'australian')] });
    // at verification: already known, so not even held
    expect(await w.auWelcomeDecision(d.userId)).toMatchObject({ action: 'au', why: 'signup_attribution', group: 'main' });
    // and if a hold was already on file from before this fix, the hourly job releases it as N04
    const out = await holdThenBackstop(d);
    expect(out).toEqual({ held: 1, released: 1 });
    const mails = mailTo(d);
    expect(mails.map((m) => m.subject)).toEqual([N04_SUBJECT]);
    expect(overseasWords(mails[0])).toBe(false);
    expect(bannedIn(mails[0].subject + '\n' + htmlText(mails[0].html))).toEqual([]);
  });

  it('the server-owned key written at sign-up decides at once (no hold), with no extra read', async () => {
    const d = fresh();
    loadDb([d]);
    expect(await w.auRecordSignupAudience(d.userId, d.email)).toBe(true);
    expect(stateOf(d)[AUD]).toBe('au');
    h.emu.reset();
    expect(await w.auWelcomeDecision(d.userId)).toMatchObject({ action: 'au', why: 'signup_audience' });
    expect(h.emu.requests.some((r) => r.table === 'runtime_kv' || r.table === 'site_enquiries')).toBe(false);
    await w.sendWelcomeEmail(d.userId);
    await settle();
    expect(mailTo(d).map((m) => m.subject)).toEqual([N04_SUBJECT]);
    expect(ledger(d)).not.toContain('au_welcome_hold|hold');
  });

  it('the "started the Australian branch" marker alone is evidence too', async () => {
    const d = fresh({ state: { [auOnboarding.AU_BRANCH_MARKER_KEY]: '2026-11-23T00:00:00.000Z' } });
    loadDb([d]);
    expect((await w.auWelcomeDecision(d.userId)).action).toBe('au');
  });

  it('evidence that says OVERSEAS still wins where it should: today\'s welcome, byte for byte the one a doctor with nothing recorded gets', async () => {
    // progress in today's wizard outranks the page they signed up on
    const progressed = fresh({ state: { [AUD]: 'au', gp_onboarding: { currentStep: 2, country: 'GB' } } });
    // an overseas lead with the same email
    const lead = fresh();
    // nothing at all (no evidence either way). FR-2 (R2-01) changed this
    // deliberately: it used to get today's overseas welcome after the hour;
    // it now gets the NEUTRAL welcome (tests/au-fr2-r201-unknown-audience).
    const nobody = fresh();
    loadDb([progressed, lead, nobody], {
      site_enquiries: [{ id: 'lead-ov', kind: 'gp', email: lead.email, status: 'new', created_at: '2026-11-20T00:00:00.000Z',
        metadata: { consult: { segment: 'overseas', ahpra_registered: false, country: 'uk', qualified: true, token: 'TOK' } } }],
      runtime_kv: [attribution(nobody, '/start', 'overseas')]
    });
    expect(await w.auWelcomeDecision(progressed.userId)).toMatchObject({ action: 'overseas', why: 'onboarding_answer' });
    expect(await w.auWelcomeDecision(lead.userId)).toMatchObject({ action: 'overseas', why: 'lead_segment' });
    expect(await w.auWelcomeDecision(nobody.userId)).toMatchObject({ action: 'hold', why: 'not_answered_yet' });
    for (const d of [progressed, lead]) await w.sendWelcomeEmail(d.userId);
    expect((await holdThenBackstop(nobody)).released).toBe(1);
    await settle();
    // the reference: the same doctor with the switch off
    const ref = fresh();
    h.emu.db.user_profiles.push(JSON.parse(JSON.stringify(ref.profile)));
    h.emu.db.user_state.push(JSON.parse(JSON.stringify(ref.state)));
    h.setSwitch(false);
    await w.sendWelcomeEmail(ref.userId);
    await settle();
    h.setSwitch(true);
    const strip = (m, d) => String(m.html).split(d.profile.first_name).join('NAME').split(d.email).join('EMAIL').split(d.userId).join('UID');
    const refMail = mailTo(ref)[0];
    expect(mailTo(nobody).map((m) => m.subject)).toEqual(['Welcome to GP Link: one question to finish setting up']);
    for (const d of [progressed]) {
      const m = mailTo(d);
      expect(m.length).toBe(1);
      expect(m[0].subject).toBe(refMail.subject.split(ref.profile.first_name).join(d.profile.first_name));
      expect(strip(m[0], d)).toBe(strip(refMail, ref));
    }
    expect(mailTo(lead).length).toBe(1);
    expect(mailTo(lead)[0].subject).not.toBe(N04_SUBJECT);
  });

  it('answering "no" to the first question removes the evidence key; the overseas journey is then exactly today\'s', async () => {
    const d = fresh();
    loadDb([d]);
    await w.auRecordSignupAudience(d.userId, d.email);
    await h.post('/api/onboarding/save', { auBranch: 'no', currentStep: 0, country: '' }, { cookie: d.cookie });
    expect(stateOf(d)[AUD]).toBeUndefined();
    const idx = await t.auSweepPathwayIndex('test');
    expect(idx.isAuUser(d.userId)).toBe(false);
    // and it is never written over an answer already given
    const answered = fresh({ state: { gp_onboarding: { currentStep: 1, country: 'IE' } } });
    h.emu.db.user_profiles.push(JSON.parse(JSON.stringify(answered.profile)));
    h.emu.db.user_state.push(JSON.parse(JSON.stringify(answered.state)));
    expect(await w.auRecordSignupAudience(answered.userId, answered.email)).toBe(false);
    expect(stateOf(answered)[AUD]).toBeUndefined();
  });

  it('pure: only the fixed marker counts, and the blob rule', () => {
    for (const v of ['au', 'AU', ' au ']) expect(auOnboarding.isAuSignupAudienceMarker(v)).toBe(true);
    for (const v of ['overseas', 'australia', '', null, undefined, 1, true, {}, ['au']]) expect(auOnboarding.isAuSignupAudienceMarker(v)).toBe(false);
    expect(auOnboarding.blobSaysNotAustralian({ auBranch: 'no' })).toBe(true);
    expect(auOnboarding.blobSaysNotAustralian({ currentStep: 1 })).toBe(true);
    expect(auOnboarding.blobSaysNotAustralian({ currentStep: 0 })).toBe(false);
    expect(auOnboarding.blobSaysNotAustralian({ auBranch: 'yes', au: { step: 1 } })).toBe(false);
    expect(auOnboarding.blobSaysNotAustralian(null)).toBe(false);
  });

  it('the Australian pages\' sign-up links carry the marker and the sign-up form passes it on; no other page does', () => {
    for (const f of ['pages/site-australian-gps.html', 'pages/site-au-changing-practices.html']) {
      const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const links = html.match(/href="\/pages\/signin\?signup=1[^"]*"/g) || [];
      expect(links.length, f).toBeGreaterThan(1);
      links.forEach((l) => expect(l, f).toBe('href="/pages/signin?signup=1&amp;aud=au"'));
    }
    const signin = fs.readFileSync(path.join(ROOT, 'pages/signin.html'), 'utf8');
    expect(signin).toContain('if (new URLSearchParams(window.location.search).get("aud") === "au") payload.audience = "au";');
    for (const f of fs.readdirSync(path.join(ROOT, 'pages')).filter((n) => /\.html$/.test(n) && !/^site-au/.test(n))) {
      expect(fs.readFileSync(path.join(ROOT, 'pages', f), 'utf8'), f).not.toMatch(/signin\?[^"']*aud=au/);
    }
  });
});

describe('R-01: the overseas onboarding reminders never reach an Australian sign-up', () => {
  const longAgo = '2026-11-01T00:00:00.000Z';
  it('a doctor with the evidence key is in the sweep index (same single read) and gets the Australian reminder, not "Don\'t lose momentum on your move"', async () => {
    const au = fresh({ updatedAt: longAgo, state: { [AUD]: 'au' } });
    const uk = fresh({ updatedAt: longAgo, state: { gp_onboarding: { currentStep: 1, country: 'GB' } } });
    loadDb([au, uk]);
    h.emu.reset();
    const idx = await t.auSweepPathwayIndex('test');
    expect(idx.isAuUser(au.userId)).toBe(true);
    expect(idx.excludesUser(au.userId)).toBe(true);
    expect(idx.isAuUser(uk.userId)).toBe(false);
    expect(idx.excludesUser(uk.userId)).toBe(false);
    // still two reads in all: user_state (both keys), then user_profiles
    expect(h.emu.requests.map((r) => r.table)).toEqual(['user_state', 'user_profiles']);
    expect(String(h.emu.requests[0].query)).toContain('or=(state->>gp_au_branch_started_at.not.is.null,state->>gp_au_signup_audience.eq.au)');

    const twoHoursAgo = new Date(Date.now() - 2 * H).toISOString();
    const row = (d, over) => Object.assign({ id: 'rem-' + d.userId.slice(-6), user_id: d.userId, email: d.email, name: d.profile.first_name + ' ' + d.profile.last_name,
      anchor_at: twoHoursAgo, last_step: 0, steps_sent: [], unsubscribed: false, stopped: false }, over || {});
    h.emu.db.onboarding_reminders = [row(au), row(uk, { last_step: 1 })];
    const res = await h.cron('/api/cron/onboarding-nudge');
    await settle();
    expect(res.status).toBe(200);
    expect(res.json.sent).toBe(2);
    expect(res.json.au_onboarding).toEqual({ sent: 1, deferred_quiet_hours: 0 });
    const auMails = mailTo(au);
    const ukMails = mailTo(uk);
    // the overseas doctor still gets today's reminder
    expect(ukMails.map((m) => m.subject)).toEqual(['Finish setting up your GP Link account']);
    // the Australian sign-up gets the Australian one
    expect(auMails.map((m) => m.subject)).toEqual(['Finish your GP Link profile: a few minutes left']);
    auMails.forEach((m) => {
      expect(overseasWords(m), m.subject).toBe(false);
      expect(bannedIn(m.subject + '\n' + htmlText(m.html) + '\n' + m.text)).toEqual([]);
    });
  });

  it('switch off: the index is inert and nothing is read', async () => {
    const au = fresh({ state: { [AUD]: 'au' } });
    loadDb([au]);
    h.setSwitch(false);
    h.emu.reset();
    const idx = await t.auSweepPathwayIndex('test');
    expect(idx.excludesUser(au.userId)).toBe(false);
    expect(h.emu.requests.length).toBe(0);
    expect(await w.auRecordSignupAudience(au.userId, au.email)).toBe(false);
  });
});

describe('S-02: the welcome is never sent out of order', () => {
  it('the reviewer\'s case: profile already complete (and N08 sent) when the email is verified: no "finish your profile"', async () => {
    const d = fresh({ kind: 'au_vr', withCase: true, profile: { onboarding_completed_at: '2026-11-23T01:00:00.000Z' } });
    loadDb([d], { gp_nudge_log: [{ user_id: d.userId, nudge_key: 'au_n08_profile_complete', channel: 'email', sent_at: '2026-11-23T01:00:00.000Z' }] });
    expect((await w.auWelcomeDecision(d.userId)).action).toBe('au');
    await w.sendWelcomeEmail(d.userId);
    await settle();
    expect(mailTo(d)).toEqual([]);
    expect(ledger(d)).toEqual(['au_n08_profile_complete|email']);
  });
  it.each([['au_n08_profile_complete'], ['au_n06_ahpra_verified']])('not after %s has gone, even if the profile stamp is missing', async (key) => {
    const d = fresh({ kind: 'au_vr', withCase: true });
    loadDb([d], { gp_nudge_log: [{ user_id: d.userId, nudge_key: key, channel: 'email', sent_at: '2026-11-23T01:00:00.000Z' }] });
    const out = await w.auSendWelcomeMessage(d.userId, {});
    await settle();
    expect(out).toMatchObject({ skipped: true, reason: 'later_message_sent' });
    expect(mailTo(d)).toEqual([]);
  });
  it('if the order cannot be checked nothing is sent (and nothing is claimed, so a later pass can still send it)', async () => {
    const d = fresh({ kind: 'au_vr', withCase: true });
    loadDb([d]);
    h.emu.failTables = { gp_nudge_log: 500 };
    let out;
    try { out = await w.auSendWelcomeMessage(d.userId, {}); } finally { h.emu.failTables = {}; }
    await settle();
    expect(out.skipped).toBe(true);
    expect(mailTo(d)).toEqual([]);
    expect(ledger(d)).toEqual([]);
  });
  it('a doctor part-way through still gets it, once', async () => {
    const d = fresh({ kind: 'au_vr', withCase: true });
    loadDb([d]);
    await w.sendWelcomeEmail(d.userId);
    await w.sendWelcomeEmail(d.userId);
    await settle();
    expect(mailTo(d).map((m) => m.subject)).toEqual([N04_SUBJECT]);
  });
});

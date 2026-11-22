// WP-17 on the real server: N15 (notice given, start date confirmed), N16
// (cleared to start) and N17 (the Australian stalled reminder), each driven
// through its real trigger. The database stub enforces the production unique
// indexes (the once-ever ledger among them), so "once" is proved under double
// triggers and under a trigger overlapping the daily job.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { bootPlacementRig, PRACTICE_EMAIL, PRACTICE_NAME } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');
const { PRODUCTION_UNIQUE_RULES } = require('./helpers/au-supabase-emulator.js');
const { bannedIn, htmlText } = require('./helpers/au-banned-words.js');
const careerIntro = require('../lib/career-intro.js');

let rig, t, w;
let seq = 0;
const DAY = 86400000;
// An instant today that is inside 08:00 to 20:00 everywhere in Australia
// (02:00 UTC: 13:00 Sydney, 10:00 Perth), and one that is not (17:00 UTC).
const today = (hourUtc) => { const d = new Date(); d.setUTCHours(hourUtc, 0, 0, 0); return d.getTime(); };
const IN_HOURS = today(2);
const QUIET = today(17);
const N11 = 'Your placement is secured: your pre-start checklist';
const N15_START = 'Your start date is confirmed: 1 February 2027';
const N16 = 'You are cleared to start on 1 February 2027';
const COMMERCIAL = /\$|%|\bfees?\b|\binvoic\w*|\bcredit(?:s|ed)?\b|\bguarantee\w*/i;

function doctor(kind, overrides) {
  seq += 1;
  const o = overrides || {};
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: String(7000 + seq) }, o, {
    // A surname of their own, so a practice email can be told apart by the doctor it names.
    profile: Object.assign({ last_name: 'Wp' + String(7000 + seq), phone: '+614007' + String(10000 + seq), phone_number: '4007' + String(10000 + seq), country_dial: '+61', current_state: 'NSW' }, o.profile || {})
  }));
  rig.addDoctor(d, o.extra);
  return d;
}
const subjects = (list) => list.map((e) => e.subject);
const cap = (d) => rig.capture(d);
const toDoctor = (d) => subjects(cap(d).emailsToDoctor);
const toPractice = (d) => subjects(rig.emails.filter((e) => JSON.stringify(e.to).indexOf(PRACTICE_EMAIL) !== -1 && String(e.subject).indexOf('Dr ' + d.profile.first_name + ' ' + d.profile.last_name) !== -1));
const ledger = (d) => cap(d).nudges.map((n) => n.nudge_key + '|' + n.channel);
const timeline = (d) => cap(d).timeline.map((x) => x.title + (x.detail ? ' | ' + x.detail : ''));
const taskOf = (d, type) => cap(d).tasks.find((x) => x.task_type === type);
const fileIndemnity = (d) => rig.table('user_documents').push({
  id: 'doc-ind-' + d.userId.slice(-6), user_id: d.userId, document_key: 'au_indemnity_certificate', country_code: 'au_reg',
  status: 'approved', file_name: 'indemnity.pdf', storage_path: 'users/x/prepared-documents/au_reg/au_indemnity_certificate/current', updated_at: new Date().toISOString()
});
const startDate = (d, date) => rig.post('/api/admin/au/prestart/start-date', { case_id: d.caseId, start_date: date || '2027-02-01', notice_period_weeks: 8 }, rig.rso());

// Everything except the last tick: placed, indemnity approved, register check
// done, provider number recorded. The start date and the credentialing pack
// are left for each test.
async function nearlyReady(d) {
  await rig.place(d, 'ats_placement');
  rig.table('gp_credentials').find((c) => c.user_id === d.userId).staff_verified_at = new Date().toISOString();
  fileIndemnity(d);
  await t.auOnAuDocumentApproved(d.userId, 'au_indemnity_certificate');
  const pn = await rig.post('/api/admin/au/prestart/provider-number', { case_id: d.caseId, provider_number: '1234567X' }, rig.rso());
  expect(pn.status).toBe(200);
}
async function tickPack(d) {
  const pack = taskOf(d, 'credentialing_pack');
  expect(pack, 'the credentialing pack task exists').toBeTruthy();
  return rig.put('/api/admin/task?id=' + encodeURIComponent(pack.id), { status: 'completed' }, rig.rso());
}

beforeAll(async () => {
  rig = await bootPlacementRig({
    name: 'wp17-prestart',
    env: { LAUNCH_DEFAULT_RSO_EMAIL: 'rso.test@gplink-test.local' },
    emulator: { defaults: { registration_tasks: { status: 'open' } }, unique: PRODUCTION_UNIQUE_RULES },
    tables: { au_gp_doctor_details: [], pbs_applications: [] }
  });
  t = rig.testUtils;
  w = t.__wp17;
}, 60000);
afterAll(async () => { if (rig) { t.__setAuQuietHoursClockForTest(null); await rig.close(); } });
beforeEach(() => { rig.setSwitch(true); rig.emu.forbid(null); rig.emu.jitterMs = 0; t.__setAuQuietHoursClockForTest(IN_HOURS); });

describe('N15 and N16 through their real triggers', () => {
  it('staff confirm the start date: N15 goes to the doctor (email, bell) and to the practice, once; ticking the last pre-start task sends N16, once', async () => {
    const d = doctor('au_vr');
    await nearlyReady(d);
    expect(toDoctor(d)).toEqual([N11]);

    const saved = await startDate(d);
    expect(saved.status).toBe(200);
    expect(toDoctor(d)).toEqual([N11, N15_START]);
    expect(toPractice(d)).toContain('Dr ' + d.profile.first_name + ' ' + d.profile.last_name + ': start date confirmed, 1 February 2027');
    const app = rig.appIdFor(d);
    expect(ledger(d)).toEqual(expect.arrayContaining([
      'au_n15_start_gp:' + app + ':2027-02-01|email', 'au_n15_start_gp:' + app + ':2027-02-01|bell', 'au_n15_start_practice:' + app + ':2027-02-01|practice_email'
    ]));
    expect(cap(d).bell.map((b) => b.title)).toContain('Your start date is confirmed');
    expect(timeline(d)).toContain('Message N15 sent: Notice given, start date confirmed (email, bell, email to the practice) (start date confirmed)');
    // Not cleared yet: the credentialing pack is still open.
    expect(toDoctor(d)).not.toContain(N16);

    // The same date saved again: nothing more.
    await startDate(d);
    expect(toDoctor(d)).toEqual([N11, N15_START]);

    const ticked = await tickPack(d);
    expect(ticked.status).toBe(200);
    expect(await t.auPrestartComplete(d.caseId)).toMatchObject({ ok: true, complete: true });
    expect(toDoctor(d)).toEqual([N11, N15_START, N16]);
    expect(ledger(d)).toEqual(expect.arrayContaining([
      'au_n16_cleared_to_start:' + app + '|email', 'au_n16_cleared_to_start:' + app + '|bell', 'au_n16_cleared_to_start:' + app + '|whatsapp_skipped'
    ]));
    expect(cap(d).bell.map((b) => b.title)).toContain('You are cleared to start');
    // E: staff can read both, and the WhatsApp skip by name.
    expect(timeline(d)).toContain('Message N16 sent: Cleared to start (email, bell) | WhatsApp skipped: no approved Australian template');
    // No WhatsApp went through any template.
    expect(rig.whatsapps.filter((x) => JSON.stringify(x).indexOf(d.profile.phone.replace('+', '')) !== -1 && /cleared|gp_link_au_cleared/.test(JSON.stringify(x)))).toEqual([]);

    // What the doctor reads: the date, the practice, nothing banned, nothing commercial.
    const n16 = cap(d).emailsToDoctor.find((e) => e.subject === N16);
    const text = htmlText(n16.html);
    expect(text).toContain('You are cleared to start at ' + PRACTICE_NAME + ' on 1 February 2027.');
    expect(text).toContain('your GP Link team');
    const n15 = cap(d).emailsToDoctor.find((e) => e.subject === N15_START);
    expect(htmlText(n15.html)).toContain('Your notice period is recorded as 8 weeks.');
    for (const mail of [n15, n16]) {
      const body = mail.subject + '\n' + htmlText(mail.html);
      expect(bannedIn(body)).toEqual([]);
      expect(COMMERCIAL.test(body)).toBe(false);
      expect(/registration support officer/i.test(body)).toBe(false);
    }
    const practiceMail = rig.emails.find((e) => /start date confirmed, 1 February 2027/.test(String(e.subject)));
    expect(careerIntro.auPracticeTextViolations(String(practiceMail.text || '') + '\n' + htmlText(practiceMail.html))).toEqual([]);
  });

  it('once under repeats and concurrency: a double trigger, and the trigger overlapping the daily job', async () => {
    const d = doctor('au_vr');
    await nearlyReady(d);
    rig.emu.jitterMs = 12;
    // The start date saved twice at the same moment.
    await Promise.all([startDate(d), startDate(d)]);
    expect(toDoctor(d).filter((s) => s === N15_START).length).toBe(1);
    expect(toPractice(d).filter((s) => /start date confirmed/.test(s)).length).toBe(1);
    // The last task ticked while the daily job and two more checks run.
    const pack = taskOf(d, 'credentialing_pack');
    await Promise.all([
      rig.put('/api/admin/task?id=' + encodeURIComponent(pack.id), { status: 'completed' }, rig.rso()),
      w.runAuMessagePass(IN_HOURS),
      w.auMaybeSendClearedToStart(d.userId, { quietNowMs: IN_HOURS }),
      w.auAfterPrestartChange(d.userId, {})
    ]);
    rig.emu.jitterMs = 0;
    await w.runAuMessagePass(IN_HOURS);
    await t.runAuLifecycleSweep(IN_HOURS);
    expect(toDoctor(d).filter((s) => s === N16).length).toBe(1);
    expect(toDoctor(d).filter((s) => s === N15_START).length).toBe(1);
    expect(cap(d).bell.filter((b) => b.title === 'You are cleared to start').length).toBe(1);
    expect(timeline(d).filter((x) => /^Message N16 sent/.test(x)).length).toBe(1);
  });

  it('a changed start date sends a correction, once, to both sides; "cleared to start" is not sent again', async () => {
    const d = doctor('au_vr');
    await nearlyReady(d);
    await startDate(d);
    await tickPack(d);
    expect(toDoctor(d)).toEqual([N11, N15_START, N16]);
    await startDate(d, '2027-02-15');
    await startDate(d, '2027-02-15');
    expect(toDoctor(d)).toEqual([N11, N15_START, N16, 'Your start date has changed: 15 February 2027']);
    expect(toPractice(d).filter((s) => /start date changed to 15 February 2027/.test(s)).length).toBe(1);
    expect(timeline(d)).toContain('Message N15 sent: Notice given, start date confirmed (email, bell, email to the practice) (start date changed)');
    const mail = cap(d).emailsToDoctor.find((e) => /has changed/.test(e.subject));
    expect(htmlText(mail.html)).toContain('The new confirmed date is 15 February 2027.');
  });

  it('the doctor records that they gave notice: N15 confirms it to them and tells the practice, once per date, and is not held by quiet hours', async () => {
    const d = doctor('au_vr');
    await rig.place(d, 'ats_placement');
    t.__setAuQuietHoursClockForTest(QUIET);   // the doctor did this themselves, late at night
    const cookie = rig.gpCookie(d.email, d.userId);
    const first = await rig.post('/api/gp/au-prestart/notice', { given: true, date: '2026-11-20' }, { cookie });
    expect(first.status).toBe(200);
    await rig.post('/api/gp/au-prestart/notice', { given: true, date: '2026-11-20' }, { cookie });
    expect(toDoctor(d)).toEqual([N11, 'Your notice is recorded']);
    expect(toPractice(d)).toContain('Dr ' + d.profile.first_name + ' ' + d.profile.last_name + ' has given notice');
    expect(toPractice(d).filter((s) => /has given notice/.test(s)).length).toBe(1);
    const mail = cap(d).emailsToDoctor.find((e) => e.subject === 'Your notice is recorded');
    const text = htmlText(mail.html);
    expect(text).toContain('We have recorded that you gave notice on 20 November 2026.');
    // The start date is on the placement but staff have not confirmed it: "expected", never "confirmed".
    expect(text).toContain('Your expected start date at ' + PRACTICE_NAME + ' is 1 February 2027.');
    expect(bannedIn(text)).toEqual([]);
    const practiceMail = rig.emails.find((e) => /has given notice/.test(String(e.subject)) && JSON.stringify(e.to).indexOf(PRACTICE_EMAIL) !== -1 && String(e.subject).indexOf(d.profile.last_name) !== -1);
    const practiceText = htmlText(practiceMail.html);
    expect(practiceText).toContain('notice was given on 20 November 2026');
    expect(/current (practice|employer)/i.test(practiceText)).toBe(false);
    expect(careerIntro.auPracticeTextViolations(practiceText)).toEqual([]);
    expect(timeline(d)).toContain('Message N15 sent: Notice given, start date confirmed (email, bell, email to the practice) (notice given)');
  });

  it('quiet hours: a start date confirmed outside 08:00 to 20:00 for the doctor is held, unclaimed, and goes on the next run inside the hours; so does "cleared to start"', async () => {
    const d = doctor('au_vr');
    await nearlyReady(d);
    t.__setAuQuietHoursClockForTest(QUIET);
    const saved = await startDate(d);
    expect(saved.status).toBe(200);
    await tickPack(d);
    expect(toDoctor(d)).toEqual([N11]);
    expect(ledger(d).filter((k) => /au_n15_|au_n16_/.test(k))).toEqual([]);
    // The daily host's hour is early morning in Australia: still held.
    const held = await w.runAuMessagePass(QUIET);
    expect(held.deferred_quiet_hours).toBeGreaterThanOrEqual(2);
    expect(toDoctor(d)).toEqual([N11]);
    // The in-hours run sends both, once.
    const sent = await w.runAuMessagePass(IN_HOURS);
    expect(sent.n15).toBe(1);
    expect(sent.n16).toBe(1);
    await w.runAuMessagePass(IN_HOURS);
    expect(toDoctor(d)).toEqual([N11, N15_START, N16]);
  });

  it('unlaunched segments: a placed segment B doctor gets the facts (N15) but never an automatic "cleared to start"; staff see why', async () => {
    const b = doctor('au_restricted');
    await nearlyReady(b);
    await startDate(b);
    await tickPack(b);
    const done = await t.auPrestartComplete(b.caseId);
    const out = await w.auMaybeSendClearedToStart(b.userId, {});
    expect(done).toMatchObject({ ok: true, complete: true });
    expect(out).toMatchObject({ id: 'N16', skipped: 'au_segment_not_launched' });
    expect(timeline(b).filter((x) => x === 'Message N16 not sent: Cleared to start | Email skipped: the doctor\'s segment is not launched').length).toBe(1);
    expect(toDoctor(b)).not.toContain(N16);
    expect(toDoctor(b).filter((s) => /cleared to start/i.test(s))).toEqual([]);
    expect(toDoctor(b)).toContain(N15_START);
    // Asked again (the daily job): still nothing, and the note is not repeated.
    await w.runAuMessagePass(IN_HOURS);
    expect(toDoctor(b).filter((s) => /cleared to start/i.test(s))).toEqual([]);
    expect(timeline(b).filter((x) => /^Message N16 not sent/.test(x)).length).toBe(1);
  });

  it('an overseas doctor, and everyone with the switch off, gets none of it and costs no query', async () => {
    const o = doctor('overseas_null');
    await rig.place(o, 'ats_placement');
    const before = toDoctor(o).slice();
    expect(await w.auSendNoticeStartMessages(o.userId, 'start_date', { event: true })).toBe(null);
    expect(await w.auMaybeSendClearedToStart(o.userId, {})).toBe(null);
    expect(await w.auSendStalledReminder(o.userId, { force: true })).toEqual({ ok: false, skipped: 'not_au_pathway' });
    await w.runAuMessagePass(IN_HOURS);
    expect(toDoctor(o)).toEqual(before);
    expect(JSON.stringify(cap(o).emailsToDoctor)).not.toMatch(/cleared to start|start date is confirmed|waiting on you/i);

    rig.setSwitch(false);
    const a = doctor('au_vr');
    rig.emu.reset();
    expect(await w.auSendNoticeStartMessages(a.userId, 'start_date', { event: true })).toBe(null);
    expect(await w.auMaybeSendClearedToStart(a.userId, {})).toBe(null);
    expect(await w.auAfterPrestartChange(a.userId, { startDateConfirmed: true })).toBe(null);
    expect(await w.auSendStalledReminder(a.userId, {})).toEqual({ ok: false, skipped: 'feature_off' });
    expect(await w.runAuMessagePass(IN_HOURS)).toBe(null);
    expect(await w.auRoleCtxForUser(a.userId)).toBe(null);
    expect(rig.emu.requests).toEqual([]);
  });
});

describe('N17: the Australian stalled reminder', () => {
  const backdatePlacement = (d, days) => {
    const iso = new Date(Date.now() - days * DAY).toISOString();
    rig.table('placements').filter((p) => p.user_id === d.userId).forEach((p) => { p.placed_at = iso; p.created_at = iso; });
  };

  it('pre-start, 14 days after the placement, with things still waiting on the doctor: one email naming them; then again at day 28; never in between', async () => {
    const d = doctor('au_vr');
    await rig.place(d, 'ats_placement');
    // Day 3: too early.
    backdatePlacement(d, 3);
    expect((await w.auSendStalledReminder(d.userId, { nowMs: IN_HOURS, quietNowMs: IN_HOURS })).skipped).toBe('not_due');
    backdatePlacement(d, 15);
    const pass = await w.runAuMessagePass(IN_HOURS);
    expect(pass.n17).toBeGreaterThanOrEqual(1);
    await w.runAuMessagePass(IN_HOURS);
    const mine = cap(d).emailsToDoctor.filter((e) => /^Before you start: /.test(e.subject));
    expect(mine.length).toBe(1);
    const text = htmlText(mine[0].html);
    expect(text).toMatch(/that only you can do/);
    expect(text).toContain('Everything else is with us or the practice');
    expect(/haven.t made progress|no progress|inactive/i.test(text)).toBe(false);
    expect(bannedIn(mine[0].subject + '\n' + text)).toEqual([]);
    expect(COMMERCIAL.test(text)).toBe(false);
    expect(/registration support officer/i.test(text)).toBe(false);
    expect(ledger(d)).toContain('au_n17_stalled:prestart:' + rig.appIdFor(d) + ':d14|email');
    expect(timeline(d).filter((x) => /^Message N17 sent: A quick reminder \(stalled\) \(email\) \(day 14, \d+ waiting on the doctor\)/.test(x)).length).toBe(1);

    backdatePlacement(d, 20);
    await w.runAuMessagePass(IN_HOURS);
    expect(cap(d).emailsToDoctor.filter((e) => /^Before you start: /.test(e.subject)).length).toBe(1);
    backdatePlacement(d, 29);
    await w.runAuMessagePass(IN_HOURS);
    await w.runAuMessagePass(IN_HOURS);
    expect(cap(d).emailsToDoctor.filter((e) => /^Before you start: /.test(e.subject)).length).toBe(2);
    backdatePlacement(d, 60);
    await w.runAuMessagePass(IN_HOURS);
    expect(cap(d).emailsToDoctor.filter((e) => /^Before you start: /.test(e.subject)).length).toBe(2);
  });

  it('only what THEY can do: a doctor with nothing of their own outstanding is sent nothing, however old the placement', async () => {
    const d = doctor('au_vr');
    await nearlyReady(d);
    await startDate(d);
    await tickPack(d);
    // Whatever is still listed for the doctor themselves (the notice date,
    // referees, other documents) is theirs; mark the checklist as it would be
    // once they have done all of it by asking what the reminder would list.
    const view = await rig.get('/api/gp/au-prestart', { cookie: rig.gpCookie(d.email, d.userId) });
    const theirs = view.json.items.filter((it) => it.who === 'you' && (it.status === 'todo' || it.status === 'attention'));
    backdatePlacement(d, 15);
    const out = await w.auSendStalledReminder(d.userId, { nowMs: IN_HOURS, quietNowMs: IN_HOURS });
    if (theirs.length === 0) {
      expect(out).toEqual({ ok: false, skipped: 'nothing_for_doctor' });
      expect(cap(d).emailsToDoctor.filter((e) => /waiting on you/.test(e.subject))).toEqual([]);
    } else {
      // Then the email lists exactly those, and nothing that is with staff or the practice.
      const mail = cap(d).emailsToDoctor.find((e) => /waiting on you/.test(e.subject));
      const text = htmlText(mail.html);
      for (const it of theirs) expect(text).toContain(it.title);
      const notTheirs = view.json.items.filter((it) => it.who !== 'you');
      for (const it of notTheirs) expect(text.indexOf('• ' + it.title) === -1 && text.indexOf(it.title + ':') === -1, it.title).toBe(true);
    }
  });

  it('quiet hours: held, unclaimed, at the daily host\'s hour; sent on the in-hours run', async () => {
    const d = doctor('au_vr');
    await rig.place(d, 'ats_placement');
    backdatePlacement(d, 16);
    const held = await w.runAuMessagePass(QUIET);
    expect(held.deferred_quiet_hours).toBeGreaterThanOrEqual(1);
    expect(cap(d).emailsToDoctor.filter((e) => /waiting on you/.test(e.subject))).toEqual([]);
    expect(ledger(d).filter((k) => /au_n17_/.test(k))).toEqual([]);
    await w.runAuMessagePass(IN_HOURS);
    expect(cap(d).emailsToDoctor.filter((e) => /waiting on you/.test(e.subject)).length).toBe(1);
  });

  it('not yet placed: a match they have not answered is the one thing a doctor can do; no match, or an unlaunched segment, means no message', async () => {
    const old = new Date(Date.now() - 15 * DAY).toISOString();
    const withMatch = doctor('au_vr', { caseRow: { created_at: old } });
    const noMatch = doctor('au_vr', { caseRow: { created_at: old } });
    const segB = doctor('au_restricted', { caseRow: { created_at: old } });
    const apps = rig.table('gp_applications');
    const setApp = (d, patch) => Object.assign(apps.find((a) => a.user_id === d.userId), patch);
    setApp(withMatch, { status: 'shortlisted', ats_stage: 'shortlisted', match_outcome: null, match_expires_at: new Date(Date.now() + 2 * DAY).toISOString() });
    setApp(noMatch, { status: 'applied', ats_stage: 'applied', match_outcome: null });
    setApp(segB, { status: 'shortlisted', ats_stage: 'shortlisted', match_outcome: null, match_expires_at: new Date(Date.now() + 2 * DAY).toISOString() });
    rig.table('registration_cases').forEach((c) => { if ([withMatch.userId, noMatch.userId, segB.userId].indexOf(c.user_id) !== -1) { c.created_at = old; c.stage = 'placement'; } });

    await w.runAuMessagePass(IN_HOURS);
    await w.runAuMessagePass(IN_HOURS);
    const mine = cap(withMatch).emailsToDoctor.filter((e) => e.subject === 'One thing is waiting on you');
    expect(mine.length).toBe(1);
    const text = htmlText(mine[0].html);
    expect(text).toContain('A role we matched you to is waiting for your answer');
    expect(text).toContain('your GP Link consultant');   // before a placement
    expect(text).toContain('We never contact your current practice without asking you first.');
    expect(bannedIn(text)).toEqual([]);
    expect(ledger(withMatch)).toContain('au_n17_stalled:match:d14|email');

    expect(cap(noMatch).emailsToDoctor).toEqual([]);
    expect(await w.auSendStalledReminder(noMatch.userId, { nowMs: IN_HOURS, quietNowMs: IN_HOURS })).toEqual({ ok: false, skipped: 'nothing_for_doctor' });
    expect(cap(segB).emailsToDoctor).toEqual([]);
    expect(await w.auSendStalledReminder(segB.userId, { nowMs: IN_HOURS, quietNowMs: IN_HOURS })).toEqual({ ok: false, skipped: 'au_segment_not_launched' });
  });

  it('it replaces the overseas stage reminder: the stalled-position sender answers with N17 for an Australian doctor, and "reminder emails off" is respected', async () => {
    const d = doctor('au_vr');
    await rig.place(d, 'ats_placement');
    const pos = await t.resolveGpJourneyPositionForTest(d.userId, 'prestart', null);
    expect(pos).toMatchObject({ ladder: 'au', stage: 'prestart' });
    rig.table('notification_preferences').push({ email: d.email, email_nudges: false, whatsapp: true, push: true });
    expect(await t.sendStalledNudgeForPositionForTest(pos)).toEqual({ ok: false, skipped: 'opted_out' });
    rig.table('notification_preferences').length = 0;
    const sent = await t.sendStalledNudgeForPositionForTest(pos);
    expect(sent.ok).toBe(true);
    const mails = cap(d).emailsToDoctor.filter((e) => /^Before you start: /.test(e.subject));
    expect(mails.length).toBe(1);
    expect(JSON.stringify(cap(d).emailsToDoctor)).not.toMatch(/haven't made progress|Need a hand\? \| GP Link/);
  });
});

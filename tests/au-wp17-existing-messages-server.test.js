// WP-17 on the real server: the EXISTING messages an Australian doctor still
// receives, and the things staff send them.
//
//   COM-23  one role-label helper: no "Registration Support Officer" reaches an
//           Australian doctor from any site; an overseas doctor's words are the
//           same string they always were.
//   COM-18  the staff nudge defaults and the composer's template list are
//           pathway-aware.
//   N09     the match invitation, reminder and final call an Australian doctor
//           gets carry no banned word; the match WhatsApp goes only through an
//           approved Australian template.
//   N22     the Australian block in the weekly owner digest.
//   F47/F49 the RSO welcome and the assistance-call invite.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { bootPlacementRig, PRACTICE_NAME, ROLE_ID, PRACTICE_ID } = require('./helpers/au-wp11-placement-rig.js');
const { buildAuDoctor } = require('./helpers/au-fixtures.js');
const { PRODUCTION_UNIQUE_RULES } = require('./helpers/au-supabase-emulator.js');
const { bannedIn, htmlText } = require('./helpers/au-banned-words.js');
const auMessages = require('../lib/au-messages.js');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
let rig, t, w;
let seq = 0;

function doctor(kind, overrides) {
  seq += 1;
  const o = overrides || {};
  const d = buildAuDoctor(kind, Object.assign({ idSuffix: String(6000 + seq) }, o, {
    profile: Object.assign({ last_name: 'Ex' + String(6000 + seq), phone: '+614006' + String(10000 + seq), phone_number: '4006' + String(10000 + seq), country_dial: '+61' }, o.profile || {})
  }));
  rig.addDoctor(d, o.extra);
  return d;
}
const cap = (d) => rig.capture(d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle() { let last = -1; for (let i = 0; i < 30; i++) { await sleep(30); if (rig.emails.length === last) return; last = rig.emails.length; } }
const lastMail = (d) => { const list = cap(d).emailsToDoctor; return list[list.length - 1]; };
const ROLE = { id: ROLE_ID, location_city: 'Parramatta', location_state: 'NSW', practice_name: PRACTICE_NAME, title: 'General Practitioner' };
const RSO = /registration support officer/i;

beforeAll(async () => {
  rig = await bootPlacementRig({
    name: 'wp17-existing',
    env: { LAUNCH_DEFAULT_RSO_EMAIL: 'rso.test@gplink-test.local', OWNER_NOTIFY_EMAIL: 'owner@gplink-test.local' },
    emulator: { defaults: { registration_tasks: { status: 'open' } }, unique: PRODUCTION_UNIQUE_RULES },
    tables: { user_nudges: [], nudge_chat_messages: [], email_templates: [], au_gp_doctor_details: [], pbs_applications: [] }
  });
  t = rig.testUtils;
  w = t.__wp17;
}, 60000);
afterAll(async () => { if (rig) await rig.close(); delete process.env.AU_WHATSAPP_APPROVED_TEMPLATES; });
beforeEach(() => { rig.setSwitch(true); rig.emu.forbid(null); delete process.env.AU_WHATSAPP_APPROVED_TEMPLATES; });

describe('COM-23: one role label, at every site', () => {
  // Waits for fire-and-forget emails from the real server: under a second alone, longer when the whole suite is running (walk-findings R15).
  it('"application received" (cold and matched): an Australian doctor reads "your GP Link consultant", an overseas doctor reads what they always did', { timeout: 45000 }, async () => {
    const a = doctor('au_vr');
    const o = doctor('overseas_null');
    for (const matched of [false, true]) {
      rig.resetRecorders();
      w.notifyGpApplicationSubmitted(a.userId, a.email, ROLE, a.caseId, 'Dr Test Ex', { matched });
      w.notifyGpApplicationSubmitted(o.userId, o.email, ROLE, o.caseId, 'Dr Test Ex', { matched });
      // Fire-and-forget by design: wait for both doctors' emails, however busy the machine is.
      for (let n = 0; n < 400 && !(cap(a).emailsToDoctor.length && cap(o).emailsToDoctor.length); n++) await sleep(25);
      await settle();
      const au = cap(a).emailsToDoctor[0];
      const os = cap(o).emailsToDoctor[0];
      expect(au.subject).toBe(os.subject);
      const auText = htmlText(au.html);
      expect(RSO.test(auText)).toBe(false);
      expect(auText).toContain(matched ? 'your GP Link consultant is putting you forward' : 'it\'s with your GP Link consultant now');
      expect(auText).toContain('Your GP Link consultant preps you beforehand and is on the call with you.');
      expect(bannedIn(au.subject + '\n' + auText)).toEqual([]);
      expect(htmlText(os.html)).toContain('Registration Support Officer');
      // Only the label differs between the two.
      expect(au.html.split('GP Link consultant').join('Registration Support Officer')).toBe(os.html);
      // The bell item too.
      const bell = cap(a).bell[0];
      expect(RSO.test(JSON.stringify(bell))).toBe(false);
      if (!matched) expect(bell.body).toContain('is with your GP Link consultant.');
    }
  });

  it('every message through the three shared senders (email, bell, push) is rewritten for an Australian doctor and untouched for anyone else', async () => {
    const a = doctor('au_vr');
    const o = doctor('overseas_null');
    const body = 'We checked your requested change. You can sign it, or talk to your Registration Support Officer.';
    rig.resetRecorders();
    await w.sendGpNotificationEmail(a.userId, 'An update', 'An update', body, 'Open', 'https://app.gplink-test.local/x', 'Your Registration Support Officer will help.');
    await w.sendGpNotificationEmail(o.userId, 'An update', 'An update', body, 'Open', 'https://app.gplink-test.local/x', 'Your Registration Support Officer will help.');
    await w.pushCareerNotificationToUser(a.userId, { type: 'info', title: 'An update', body });
    await w.pushCareerNotificationToUser(o.userId, { type: 'info', title: 'An update', body });
    await settle();
    const auText = htmlText(lastMail(a).html);
    expect(auText).toContain('talk to your GP Link consultant.');
    expect(auText).toContain('Your GP Link consultant will help.');
    expect(RSO.test(auText)).toBe(false);
    expect(htmlText(lastMail(o).html)).toContain('talk to your Registration Support Officer.');
    expect(cap(a).bell[0].body).toBe('We checked your requested change. You can sign it, or talk to your GP Link consultant.');
    expect(cap(o).bell[0].body).toBe(body);
  });

  it('after a placement the same sentence says "your GP Link team"', async () => {
    const a = doctor('au_vr');
    await rig.place(a, 'ats_placement');
    expect(await w.auRoleCtxForUser(a.userId)).toMatchObject({ isAu: true, placed: true });
    expect(await w.auRoleLabelText(a.userId, 'Your Registration Support Officer will join you.')).toBe('Your GP Link team will join you.');
  });

  it('the helper costs nothing where it does not apply: text without the label, an overseas doctor, the switch off', async () => {
    const a = doctor('au_vr');
    const o = doctor('overseas_null');
    const text = 'Your Registration Support Officer will join you.';
    rig.emu.reset();
    expect(await w.auRoleLabelText(a.userId, 'Nothing about anyone here.')).toBe('Nothing about anyone here.');
    expect(rig.emu.requests).toEqual([]);
    const same = { title: text, n: 1 };
    expect(await w.auRoleLabelText(o.userId, same)).toBe(same);
    expect(await w.auRoleLabelText(o.userId, text)).toBe(text);
    rig.setSwitch(false);
    rig.emu.reset();
    expect(await w.auRoleLabelText(a.userId, text)).toBe(text);
    expect(await w.auRoleCtxForUser(a.userId)).toBe(null);
    expect(rig.emu.requests).toEqual([]);
  });

  it('the withdrawal confirmation takes the label from the caller', async () => {
    rig.resetRecorders();
    await w.sendGpWithdrawalConfirmationEmail({ auRole: { isAu: true, placed: false }, gpEmail: 'withdraw.au@gplink-test.local', gpFirstName: 'Test', roleTitle: 'GP', monthlyLimit: 6, monthlyUsed: 1, activeLimit: 4, activeUsed: 0 });
    await w.sendGpWithdrawalConfirmationEmail({ gpEmail: 'withdraw.os@gplink-test.local', gpFirstName: 'Test', roleTitle: 'GP', monthlyLimit: 6, monthlyUsed: 1, activeLimit: 4, activeUsed: 0 });
    await settle();
    const au = rig.emails.find((e) => JSON.stringify(e.to).indexOf('withdraw.au@') !== -1);
    const os = rig.emails.find((e) => JSON.stringify(e.to).indexOf('withdraw.os@') !== -1);
    expect(htmlText(au.html)).toContain('message your GP Link consultant and we will sort it out.');
    expect(RSO.test(au.html + au.text)).toBe(false);
    expect(htmlText(os.html)).toContain('message your Registration Support Officer and we will sort it out.');
  });

  it('SOURCE PIN: every place server.js writes the label is one this package has dealt with (a new one fails here until it is)', () => {
    const lines = SERVER.split('\n').map((text, i) => ({ n: i + 1, text })).filter((l) => /registration support officer/i.test(l.text));
    // Not to a doctor: comments, the AI summary prompt (WP-20), the ops and
    // practice-decision emails to staff, the RSO's own copy of a confirmation,
    // and the staff email-preview catalogue.
    const NOT_TO_A_DOCTOR = [
      /^\s*\/\//, /summarySystemPrompt/, /The doctor has been told gently and their Registration Support Officer/,
      /they have been told they can sign it or talk to their Registration Support Officer/,
      /You’re receiving this as .*Registration Support Officer\.'/, /\{ name: 'Application Submitted', subject:/,
      /^const OVERSEAS_ROLE_LABEL/
    ];
    // To a doctor, and how each reaches the helper.
    const HANDLED = [
      [/auRoleLabelText\(/, 'wrapped at the site'],
      [/auMessages\.applyRoleLabel\(/, 'wrapped at the site with the caller\'s role'],
      [/^\s*\+ '\. Your Registration Support Officer is now arranging your interview/, 'buildMatchAcceptedWhatsAppText: wrapped where it is sent'],
      [/^\s*: 'Your application for the ' \+ locationLabel/, 'pushBody: applyRoleLabel on the next line'],
      [/Thanks for confirming your interest — your Registration Support Officer is putting you forward/, 'inside the email html that applyRoleLabel wraps'],
      [/You meet the practice\. Your Registration Support Officer preps you beforehand/, 'inside the email html that applyRoleLabel wraps'],
      [/Thanks for applying for the ' \+ locationLabel/, 'inside the email html that applyRoleLabel wraps'],
      [/1\. Your Registration Support Officer checks every interview request/, 'inside the email html that applyRoleLabel wraps'],
      [/const tdBody = /, 'sent through sendGpNotificationEmail / pushCareerNotificationToUser / sendPushNotification'],
      [/const odBodyMsg = /, 'sent through the three shared senders'],
      [/const pcaBodyMsg = /, 'sent through the three shared senders'],
      [/const chdBodyMsg = /, 'sent through the three shared senders'],
      [/'The practice has shared when they can meet\./, 'an argument of sendGpNotificationEmail'],
      [/Everything else is unchanged: same day, same time/, 'gpBody: auRoleLabelText on the next line'],
      [/is locked in for <strong>/, 'inside buildCareerEmailHtml(...) that auRoleLabelText wraps']
    ];
    const unexplained = lines.filter((l) => !NOT_TO_A_DOCTOR.some((re) => re.test(l.text)) && !HANDLED.some((h) => h[0].test(l.text)));
    expect(unexplained.map((l) => l.n + ': ' + l.text.trim().slice(0, 140))).toEqual([]);
    // And the wrapping each "next line" note relies on is really there.
    expect(SERVER).toContain('pushBody = auMessages.applyRoleLabel(pushBody, auRole);');
    expect(SERVER).toContain('gpBody = await auRoleLabelText(ctx.userId, gpBody);');
    expect(SERVER).toContain('html: await auRoleLabelText(appCtx.userId, buildCareerEmailHtml({');
    expect(SERVER).toContain('html: auMessages.applyRoleLabel(buildCareerEmailHtml({');
    expect(SERVER).toContain('auRoleLabelText(row.user_id, buildMatchAcceptedWhatsAppText(firstName, practiceName))');
    // The three shared senders each ask the helper.
    for (const fn of ['sendGpNotificationEmail', 'pushCareerNotificationToUser', 'sendPushNotification']) {
      const at = SERVER.indexOf('async function ' + fn + '(');
      expect(SERVER.slice(at, at + 1400), fn).toContain('auRoleLabelText(userId,');
    }
  });
});

describe('COM-18: what staff send by default', () => {
  it('the nudge default follows the doctor: Australian words for an Australian case, whatever stage is typed; the existing defaults for an overseas one', async () => {
    const a = doctor('au_vr');
    const o = doctor('overseas_null');
    const staff = rig.rso();
    rig.resetRecorders();
    const plain = await rig.post('/api/admin/va/nudge', { user_id: a.userId }, staff);
    expect(plain.status).toBe(200);
    expect(plain.json.nudge).toMatchObject({ title: 'Anything we can help with?', stage: 'placement', substage: null });
    expect(plain.json.nudge.message).toBe(auMessages.AU_NUDGE_TEMPLATES.placement.body);

    // A staff member types the overseas stage: the default is STILL Australian.
    const typed = await rig.post('/api/admin/va/nudge', { user_id: a.userId, stage: 'myintealth', substage: 'create_account' }, staff);
    expect(typed.status).toBe(200);
    expect(typed.json.nudge.title).toBe('Anything we can help with?');
    expect(typed.json.nudge.stage).toBe('placement');
    expect(JSON.stringify(typed.json.nudge)).not.toMatch(/MyIntealth|myintealth|AMC|EPIC/);
    await settle();
    const mails = cap(a).emailsToDoctor;
    expect(mails.length).toBe(2);
    for (const m of mails) {
      const text = htmlText(m.html);
      expect(bannedIn(m.subject + '\n' + text)).toEqual([]);
      expect(text).toContain(auMessages.AU_NUDGE_EMAIL_FOOTER);
      expect(/help you with your registration/.test(text)).toBe(false);
    }
    // Their own words, when they type some, are sent as typed.
    const own = await rig.post('/api/admin/va/nudge', { user_id: a.userId, message: 'Could you ring me when you have a minute?' }, staff);
    expect(own.json.nudge.message).toBe('Could you ring me when you have a minute?');

    // The overseas doctor: exactly the existing default.
    const os = await rig.post('/api/admin/va/nudge', { user_id: o.userId }, staff);
    expect(os.json.nudge).toMatchObject({ title: 'Need help with MyIntealth?', stage: 'myintealth' });
    await settle();
    expect(htmlText(lastMail(o).html)).toContain('This nudge was sent by the GP Link team to help you with your registration.');
  });

  it('a placed Australian doctor\'s default is about the pre-start checklist', async () => {
    const a = doctor('au_vr');
    await rig.place(a, 'ats_placement');
    const res = await rig.post('/api/admin/va/nudge', { user_id: a.userId }, rig.rso());
    expect(res.json.nudge).toMatchObject({ title: 'Need a hand with your pre-start checklist?', stage: 'prestart' });
  });

  it('the composer\'s template list for an Australian doctor (by user, case or task) leaves out the overseas defaults; for anyone else, and with the switch off, the reply is unchanged', async () => {
    const a = doctor('au_vr');
    const o = doctor('overseas_null');
    const staff = rig.rso();
    const plain = await rig.get('/api/admin/email-templates', staff);
    expect(plain.status).toBe(200);
    expect(Object.keys(plain.json).sort()).toEqual(['ok', 'templates']);
    const plainKeys = plain.json.templates.map((x) => x.key);
    expect(plainKeys).toEqual(['request_document_gp', 'chase_practice_sppa', 'ahpra_followup', 'interview_confirmation', 'welcome_next_steps']);

    rig.table('registration_tasks').push({ id: 'task-tpl-' + a.userId.slice(-6), case_id: a.caseId, task_type: 'email_triage', status: 'open', title: 'Email' });
    for (const q of ['user_id=' + a.userId, 'case_id=' + a.caseId, 'task_id=task-tpl-' + a.userId.slice(-6)]) {
      const au = await rig.get('/api/admin/email-templates?' + q, staff);
      expect(au.json.audience, q).toBe('au');
      const keys = au.json.templates.map((x) => x.key);
      expect(keys, q).toEqual(['au_request_document_gp', 'au_welcome_next_steps', 'au_prestart_checkin', 'interview_confirmation']);
      expect(JSON.stringify(au.json.templates)).not.toMatch(/your move|MyIntealth|SPPA|AHPRA/);
    }
    const os = await rig.get('/api/admin/email-templates?user_id=' + o.userId, staff);
    expect(os.json).toEqual(plain.json);
    rig.setSwitch(false);
    const off = await rig.get('/api/admin/email-templates?user_id=' + a.userId, staff);
    expect(off.json).toEqual(plain.json);
  });
});

describe('N09: the match messages an Australian doctor receives', () => {
  const job = { id: ROLE_ID, title: 'General Practitioner', practice_id: PRACTICE_ID, practice_name: PRACTICE_NAME, location_city: 'Parramatta', location_state: 'NSW', billing_model: 'Mixed billing', dpa: true };
  const practice = { id: PRACTICE_ID, name: PRACTICE_NAME, website: 'https://metro-practice.gplink-test.local' };
  const auPathway = { pathway: 'au_vr', segment: 'A', isAu: true, launched: true, dpaRestricted: false };
  const row = (id) => ({ id, match_expires_at: new Date(Date.now() + 2 * 86400000).toISOString(), matched_at: new Date().toISOString(),
    match_reasons: { reasons: ['Mixed billing, which is what you asked for', 'In Sydney, one of the places you chose', 'Vocationally registered GPs preferred'] } });

  it('the invitation, the 24-hour reminder and the final call: no banned word, no "Registration Support Officer", no tag that does not apply', () => {
    for (const opts of [{}, { reminder: true }, { finalCall: true }]) {
      const html = t.buildMatchEmailHtml(row('app-n09'), job, practice, Object.assign({ gpLastName: 'Auvr', auPathway }, opts));
      const text = htmlText(html);
      expect(bannedIn(text), JSON.stringify(opts)).toEqual([]);
      expect(RSO.test(text)).toBe(false);
      expect(/\$|%\s*billing|DPA approved/.test(text)).toBe(false);
      expect(text).toContain(PRACTICE_NAME);
    }
    // The same email for an overseas doctor still carries its tag (unchanged).
    expect(htmlText(t.buildMatchEmailHtml(row('app-n09b'), job, practice, { gpLastName: 'Ukgp' }))).toContain('DPA approved');
  });

  // CHANGED DELIBERATELY BY WP-18 (walk-findings T4). This used to pin "skipped
  // by name until gp_link_au_match_invitation is approved". The existing match
  // invitation has since been read and is neutral ({{3}} is only ever the
  // "held until" line), so an Australian doctor is sent it, with the same
  // variables; staff can see which template carried it; and the owner's off
  // switch brings the named skip back.
  it('the match WhatsApp goes to an Australian doctor through the existing template, confirmed neutral; switched off, it is skipped by name and staff can see it', async () => {
    const a = doctor('au_vr');
    const o = doctor('overseas_null');
    const appRow = (d) => Object.assign({}, rig.table('gp_applications').find((x) => x.user_id === d.userId), row(rig.appIdFor(d)));
    rig.resetRecorders();
    const sentAu = await w.sendMatchWhatsAppToGp(appRow(a));
    expect(sentAu.ok).toBe(true);
    expect(rig.whatsapps.length).toBe(1);
    expect(rig.whatsapps[0].messages[0].content.templateName).toBe('gp_link_app_match_invitation');
    expect(bannedIn(JSON.stringify(rig.whatsapps[0].messages[0].content.templateData))).toEqual([]);
    expect(/registration support officer/i.test(JSON.stringify(rig.whatsapps[0]))).toBe(false);
    await w.sendMatchWhatsAppToGp(appRow(a));
    const via = cap(a).timeline.filter((x) => x.title === 'WhatsApp sent via existing neutral template gp_link_app_match_invitation');
    expect(via.length).toBe(1);                                          // noted once, however often it is sent

    // An overseas doctor: the existing template, as before, and no note.
    rig.resetRecorders();
    const sent = await w.sendMatchWhatsAppToGp(appRow(o));
    expect(sent.ok).toBe(true);
    expect(rig.whatsapps.length).toBe(1);
    expect(rig.whatsapps[0].messages[0].content.templateName).toBe('gp_link_app_match_invitation');
    expect(cap(o).timeline.filter((x) => /^WhatsApp /.test(String(x.title)))).toEqual([]);

    // Switched off by the owner: skipped by name, once on the timeline.
    process.env.AU_WHATSAPP_DISABLED_TEMPLATES = 'match_invitation';
    try {
      rig.resetRecorders();
      const skipped = await w.sendMatchWhatsAppToGp(appRow(a));
      await w.sendMatchWhatsAppToGp(appRow(a));
      expect(skipped).toEqual({ ok: false, skipped: 'au_template_not_approved' });
      expect(rig.whatsapps).toEqual([]);
      const notes = cap(a).timeline.filter((x) => x.title === 'WhatsApp skipped: no approved Australian template');
      expect(notes.length).toBe(1);
      expect(notes[0].detail).toContain('"match invitation" WhatsApp was not sent');
    } finally { delete process.env.AU_WHATSAPP_DISABLED_TEMPLATES; }
  });

  it('the final call is only sent between 08:00 and 20:00 on an Australian doctor\'s clock: held unstamped outside, sent inside; an overseas doctor\'s goes at any hour', async () => {
    const a = doctor('au_vr', { profile: { current_state: 'NSW' } });
    const o = doctor('overseas_null');
    const soon = new Date(Date.now() + 90 * 60000).toISOString();
    rig.table('gp_applications').forEach((x) => {
      const mine = x.user_id === a.userId || x.user_id === o.userId;
      Object.assign(x, mine
        ? { status: 'shortlisted', ats_stage: 'shortlisted', matched_at: new Date().toISOString(), match_outcome: null, match_expires_at: soon, match_reminder_sent_at: new Date().toISOString(), match_final_reminder_sent_at: null, match_reasons: { reasons: ['Mixed billing'] } }
        : { ats_stage: 'offer', matched_at: null });
    });
    const run = () => rig.get('/api/cron/match-lifecycle', { headers: { Authorization: 'Bearer test-cron-secret' } });
    const finals = (d) => cap(d).emailsToDoctor.filter((e) => /^Final call/.test(String(e.subject)));
    rig.resetRecorders();
    t.__setAuQuietHoursClockForTest(Date.parse('2027-01-12T17:00:00Z'));   // 04:00 in Sydney
    expect((await run()).status).toBe(200);
    await settle();
    expect(finals(a)).toEqual([]);
    expect(rig.table('gp_applications').find((x) => x.user_id === a.userId).match_final_reminder_sent_at).toBe(null);
    expect(finals(o).length).toBe(1);                                      // no quiet hours for an overseas doctor (unchanged)
    // (The database stub does not evaluate "expires before now", so the job's
    // expiry pass closes every open match it is shown. Put the Australian
    // doctor's match back as it was: still open, final call not sent.)
    Object.assign(rig.table('gp_applications').find((x) => x.user_id === a.userId),
      { status: 'shortlisted', ats_stage: 'shortlisted', match_outcome: null, match_expires_at: soon, match_final_reminder_sent_at: null });
    t.__setAuQuietHoursClockForTest(Date.parse('2027-01-12T02:00:00Z'));   // 13:00 in Sydney
    await run();
    await settle();
    t.__setAuQuietHoursClockForTest(null);
    expect(finals(a).length).toBe(1);
    expect(bannedIn(finals(a)[0].subject + '\n' + htmlText(finals(a)[0].html))).toEqual([]);
    expect(finals(o).length).toBe(1);
  });

  it('the same gate stands in front of every existing doctor template; it never stops an overseas doctor\'s, and asks nothing with the switch off', async () => {
    const a = doctor('au_vr');
    const o = doctor('overseas_null');
    // CHANGED DELIBERATELY BY WP-18: 'match_invitation' left this list (its
    // existing template was read and is neutral, so an Australian doctor is
    // sent it); the practice's interview confirmation joined it.
    for (const key of ['match_accepted', 'contract_ready', 'interview_confirmed', 'interview_confirmed_practice', 'interview_times_ready', 'rso_welcome']) {
      expect(await w.auExistingDoctorWhatsAppGate(a.userId, key), key).toEqual({ send: false, reason: 'au_template_not_approved', au: true });
      expect(await w.auExistingDoctorWhatsAppGate(o.userId, key), key).toEqual({ send: true });
    }
    expect(await w.auExistingDoctorWhatsAppGate(a.userId, 'match_invitation')).toEqual({ send: true, templateName: 'gp_link_app_match_invitation', language: 'en', au: true });
    expect(await w.auExistingDoctorWhatsAppGate(o.userId, 'match_invitation')).toEqual({ send: true });
    rig.setSwitch(false);
    rig.emu.reset();
    expect(await w.auExistingDoctorWhatsAppGate(a.userId, 'match_invitation')).toEqual({ send: true });
    expect(rig.emu.requests).toEqual([]);
    // Each existing sender asks it.
    for (const pin of [
      "auExistingDoctorWhatsAppGate(row.user_id, 'match_invitation')", "auExistingDoctorWhatsAppGate(row.user_id, 'match_accepted')",
      "auExistingDoctorWhatsAppGate(userId, 'contract_ready')", "auExistingDoctorWhatsAppGate(auDoctorUserId, auInterviewKey)",
      "auExistingDoctorWhatsAppGate(auTimesUserId, 'interview_times_ready')",
      // (WP-18: the welcome's sender now works out whose case it is when it is handed no user id, and "account released" asks the gate too.)
      "auExistingDoctorWhatsAppGate(auRsoWelcomeUserId, 'rso_welcome')", "auExistingDoctorWhatsAppGate(userId, 'account_released')"
    ]) expect(SERVER, pin).toContain(pin);
  });
});

describe('N10: the introduction a practice is sent (built by WP-09, confirmed here)', () => {
  it('an Australian doctor is introduced from what is on file, in words a practice may be told; an overseas doctor still gets the existing introduction', async () => {
    const careerIntro = require('../lib/career-intro.js');
    const a = doctor('au_vr');
    const o = doctor('overseas_null');
    const au = await t.auPracticeIntroFor(a.userId, a.profile, 'Dr Test Ex');
    expect(au && au.intro && au.intro.audience).toBe('au');
    expect(careerIntro.auPracticeTextViolations(au.intro.paragraph + '\n' + (au.intro.confidentialityNote || ''))).toEqual([]);
    expect(/internationally trained|Expedited Specialist/i.test(au.intro.paragraph)).toBe(false);
    expect(await t.auPracticeIntroFor(o.userId, o.profile, 'Dr Test Ex')).toBe(null);   // null = build the existing introduction
    rig.setSwitch(false);
    expect(await t.auPracticeIntroFor(a.userId, a.profile, 'Dr Test Ex')).toBe(null);
  });
});

describe('N22: the Australian block in the weekly owner digest', () => {
  it('counts the Australian doctors by stage from one read, and the digest carries the block after its existing sections', async () => {
    const a1 = doctor('au_vr');
    const a2 = doctor('au_vr');
    const b = doctor('au_restricted');
    doctor('overseas_null');
    await rig.place(a2, 'ats_placement');
    const counts = await w.auPipelineSnapshot();
    expect(counts.total).toBeGreaterThanOrEqual(3);
    expect(counts.stages.prestart).toBeGreaterThanOrEqual(1);
    expect(counts.stages.placement).toBeGreaterThanOrEqual(2);
    expect(counts.segments.B).toBeGreaterThanOrEqual(1);
    expect(counts.total).toBe(counts.segments.A + counts.segments.B + counts.segments.C);
    expect([a1.userId, b.userId].length).toBe(2);

    rig.resetRecorders();
    const sent = await w.sendOwnerDigestEmail({ force: true });
    expect(sent.ok).toBe(true);
    await settle();
    const digest = rig.emails.find((e) => /GP Link weekly digest/.test(String(e.subject)));
    expect(digest.html).toContain('Australian GPs (already registered here)');
    expect(digest.html).toContain('Pre-start: <strong>');
    // After the existing sections, which are still there.
    expect(digest.html.indexOf('Where things stand')).toBeLessThan(digest.html.indexOf('Australian GPs (already registered here)'));
    expect(digest.html).toContain('This week');
    // No doctor's details in the block.
    const block = digest.html.slice(digest.html.indexOf('Australian GPs (already registered here)'));
    expect(/@gplink-test\.local|MED\d{6}/.test(block.slice(0, 1200))).toBe(false);

    // Switch off: no block, and the block's read is not made.
    rig.setSwitch(false);
    rig.resetRecorders();
    rig.emu.reset();
    await w.sendOwnerDigestEmail({ force: true });
    await settle();
    const off = rig.emails.find((e) => /GP Link weekly digest/.test(String(e.subject)));
    expect(off.html).not.toContain('Australian GPs');
    expect(rig.emu.requests.some((r) => /candidate_pathway/.test(String(r.query || '')))).toBe(false);
    expect(await w.auPipelineSnapshot()).toBe(null);
  });
});

describe('COM-18: the composer on the staff page asks for the doctor\'s own list', () => {
  it('pages/admin.html passes the case or the task, and only when the Australian routes exist', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'pages', 'admin.html'), 'utf8');
    expect(page).toContain('function fetchEmailTemplatesFor(sel){');
    expect(page).toContain('data-tpl-case="\'+esc(header.caseId||\'\')+\'"');
    expect(page).toContain('if(!au)return fetchEmailTemplates();');
    expect(page).toContain('if(sel.getAttribute("data-tpl-case")||sel.getAttribute("data-tpl-task")){fetchEmailTemplatesFor(sel).then(fill);return;}');
    // The shared list request is still there, unchanged, for every other case.
    expect(page).toContain('_tplPromise=fetch("/api/admin/email-templates",{credentials:"same-origin"})');
  });
});

describe('F47, F49 and the document emails', () => {
  it('the assistance-call invite names an Australian stage by its doctor-facing name; the overseas names are unchanged', () => {
    expect(w.callStageDisplayLabel('prestart')).toBe('Pre-start checks');
    expect(w.callStageDisplayLabel('myintealth')).toBe('MyIntealth');
    expect(w.callStageDisplayLabel('amc')).toBe('AMC');
    expect(w.callStageDisplayLabel('ahpra')).toBe('AHPRA');
    expect(w.callStageDisplayLabel('career')).toBe('career');
    expect(w.callStageDisplayLabel('visa')).toBe('visa');
    expect(SERVER).toContain("text: await auRoleLabelText(userId, 'Hi ' + gpFirstName + ', your GP Link registration support officer has scheduled a Zoom assistance call");
    expect(SERVER).toContain("text: await auRoleLabelText(call.user_id, 'Hi ' + gpFirstName + ', a reminder that your GP Link registration support officer has scheduled");
  });

  it('document approved and revision emails for an Australian document carry no banned word', async () => {
    const a = doctor('au_vr');
    rig.resetRecorders();
    await w.sendDocumentApprovedEmail(a.userId, 'Medical indemnity certificate of currency');
    await w.sendDocumentRevisionEmail(a.userId, 'Medical indemnity certificate of currency', '');
    await settle();
    const mails = cap(a).emailsToDoctor;
    expect(mails.length).toBe(2);
    for (const m of mails) {
      expect(bannedIn(m.subject + '\n' + htmlText(m.html))).toEqual([]);
      expect(RSO.test(m.html)).toBe(false);
    }
  });

  it('the practice intake invite is wired to the switch', () => {
    expect(SERVER).toContain("auLine: auPathwayFlag.isAuPathwayEnabled() ? auMessages.INTAKE_AU_LINE : ''");
  });
});

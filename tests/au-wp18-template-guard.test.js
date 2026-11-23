// WP-18: THE GUARD. The acceptance line of the build plan, made permanent:
//
//   "None of the MyIntealth, AMC, AHPRA or visa templates can be sent to
//    segment A. An Australian message with no approved template falls back to
//    email or is skipped, never sent through an overseas template."
//
// 1. Every WhatsApp template name the code can send is classified (neutral /
//    rso_wording / overseas_only) in lib/au-whatsapp-templates.js. A name
//    added to the source later fails here until someone classifies it.
// 2. Through the real senders, routes and scheduled jobs, with the switch on:
//    a doctor on an Australian pathway (before a placement, after one, after
//    starting; segments A, B and C), an Australian-segment lead, and a practice
//    receiving an Australian candidate are never sent an overseas_only
//    template by any path, and never an rso_wording one unless the owner has
//    listed its key.
// 3. Where the WhatsApp is skipped, the email goes, in Australian words.
// 4. The templates that ARE reused carry Australian-safe values (snapshot).
//
// Nothing real is sent: DoubleTick and Resend are stand-ins (tests/helpers/au-wp18-rig.js).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const R = require('./helpers/au-wp18-rig.js');
const wa = require('../lib/au-whatsapp-templates.js');
const sheet = require('../lib/au-whatsapp-submission.js');
const careerIntro = require('../lib/career-intro.js');
const practiceWa = require('../lib/practice-submission-whatsapp.js');
const auMessages = require('../lib/au-messages.js');
const { bannedIn, htmlText } = require('./helpers/au-banned-words.js');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const SOURCES = ['server.js'].concat(fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => /\.js$/.test(f)).map((f) => 'lib/' + f))
  .concat(fs.existsSync(path.join(ROOT, 'api')) ? fs.readdirSync(path.join(ROOT, 'api')).filter((f) => /\.js$/.test(f)).map((f) => 'api/' + f) : []);
const REUSED_SNAPSHOT = path.join(__dirname, 'fixtures', 'au-wp18-au-reused-whatsapp.snapshot.json');
const PARITY_SNAPSHOT = path.join(__dirname, 'fixtures', 'au-wp18-overseas-whatsapp.snapshot.json');
const RSO = /registration support officer/i;
const CLASS = wa.EXISTING_TEMPLATE_CLASS;
const byClass = (c) => Object.keys(CLASS).filter((n) => CLASS[n] === c).sort();
const OVERSEAS_ONLY = byClass('overseas_only');

// ───────────────────────────── 1. the inventory ─────────────────────────────
describe('WP-18 guard: every template name in the source is classified', () => {
  // Quoted gp_link_* strings in the source that are NOT WhatsApp templates.
  const NOT_A_TEMPLATE = ['gp_link_and_practice', 'gp_link_updates', 'gp_link_updates_read'];

  it('a grep of server.js, lib/ and api/ finds only names that are classified, new Australian rows, drafts recorded as not needed, or known non-templates', () => {
    const found = new Set();
    SOURCES.forEach((f) => {
      (fs.readFileSync(path.join(ROOT, f), 'utf8').match(/['"`]gp_link_[a-z0-9_]+['"`]/g) || []).forEach((q) => found.add(q.slice(1, -1)));
    });
    const rowNames = Object.keys(wa.AU_WHATSAPP_TEMPLATES).map((k) => wa.AU_WHATSAPP_TEMPLATES[k].templateName);
    const drafts = sheet.SUPERSEDED.map((x) => x.draft);
    const unclassified = Array.from(found).filter((n) => !CLASS[n] && rowNames.indexOf(n) === -1 && drafts.indexOf(n) === -1 && NOT_A_TEMPLATE.indexOf(n) === -1).sort();
    // A NEW TEMPLATE NAME? Classify it in EXISTING_TEMPLATE_CLASS
    // (lib/au-whatsapp-templates.js) on the day it is added: 'overseas_only'
    // unless its approved wording has been read and is safe for an Australian
    // GP, and make sure its sender cannot reach one (CONVENTIONS section 30).
    expect(unclassified).toEqual([]);
    // Nothing classified is stale, and the inventory is the 42 the review listed.
    expect(Object.keys(CLASS).filter((n) => !found.has(n))).toEqual([]);
    expect(Object.keys(CLASS).length).toBe(42);
    expect(byClass('neutral').length).toBe(11);
    expect(byClass('rso_wording')).toEqual(['gp_link_app_match_accepted', 'gp_link_contract_ready', 'gp_link_interview_confirmed_gp', 'gp_link_interview_confirmed_practice', 'gp_link_interview_times_ready']);
    expect(OVERSEAS_ONLY.length).toBe(26);
    // The ones the build plan names are all overseas-only.
    ['gp_link_app_myintealth_introductiory_message_', 'gp_link_app_amc_introductiory_message_', 'gp_link_app_ahpra_introductiory_message', 'gp_link_ahpra_docs_complete',
      'gp_link_visa_passports', 'gp_link_visa_passports_reminder', 'gp_link_consult_hello_5m', 'gp_link_consult_check_in_1h', 'gp_link_consult_day_after_24h',
      'gp_link_consult_signup_welcome', 'gp_link_consult_call_booked', 'gp_link_consult_call_reminder', 'gp_link_app_rso_welcome', 'gp_link_reg_call_reminder', 'gp_link_reg_call_starting'
    ].forEach((n) => expect(CLASS[n], n).toBe('overseas_only'));
    expect(wa.templateClass('gp_link_something_new')).toBe('unknown');
    expect(wa.templateClass('gp_link_au_lead_hello')).toBe('au');
  });

  it('no raw sender has appeared: the places that hand DoubleTick a template are the ones this package went through', () => {
    const count = (needle) => SERVER.split(needle).length - 1;
    // A CHANGED NUMBER means a new place that can send a WhatsApp template.
    // Before changing it: make sure the new sender cannot hand an
    // overseas_only template to an Australian recipient (ask
    // auExistingDoctorWhatsAppGate / auLeadWhatsAppPlan / auBlocksOverseasTemplates),
    // and add the path to the journey in tests/helpers/au-wp18-rig.js.
    expect(count("'/whatsapp/message/template'")).toBe(7);
    expect(count('sendDoubleTickTemplateTo(')).toBe(13);       // 1 definition, 1 wrapper for lib/au-commencement.js, 11 calls
    expect(count('sendConsultWhatsAppTemplate(')).toBe(9);     // 1 definition, 8 calls
    expect(count('sendDoubleTickTemplate(')).toBe(9);          // 1 definition, 8 calls (stage messages)
    expect(count('sendInterviewWhatsappTemplate(')).toBe(7);   // 1 definition, 6 calls
    expect(count('ensureRsoWelcomeSent(')).toBe(5);            // 1 definition, 4 calls (the test hook lists it without a bracket)
    // The guard each overseas-only sender relies on is really there.
    for (const pin of [
      // the stage messages (MyIntealth, AMC, AHPRA) and the visa one
      "if (!prevHasEpic && nextHasEpic && _gpPhone && !auNoOverseasStageMsgs) {",
      "if (!auNoOverseasStageMsgs && !(await _hasDoubleTickBeenSent(caseId, 'AMC stage'))) {",
      "if (plHooks.ahpraStageWhatsApp === 'fire' && !auNoOverseasStageMsgs && !(await _hasDoubleTickBeenSent(caseId, 'AHPRA stage'))) {",
      'if (auNoOverseasStageMsgs) break;',
      // the staff welcome, the staff-hosted call reminders, the drop-off nudges
      "auExistingDoctorWhatsAppGate(auRsoWelcomeUserId, 'rso_welcome')",
      "if (auBooker && track.hostKind === 'rso') {",
      "if (await auBlocksOverseasTemplates(userId)) return { ok: false, skipped: 'au_no_overseas_template' };",
      // the lead funnel
      'const auWaPlan = auCtx ? auWhatsAppTemplates.auLeadWhatsAppPlan(kind, undefined, { segment: auCtx.segment }) : null;',   // FR-1 (R-06): segment-aware
      "if (auLead.auCopyApplies(r)) { counts.au_segment = (counts.au_segment || 0) + 1; continue; }",
      // the passports request and its reminder
      'if (await auRefuseOverseasPracticeAction(req, res, adminCtx, { taskId: gqTaskId }, placementHooksLib.OVERSEAS_ACTION.REGISTRATION_GRANTED)) return;',
      // the practice's interview confirmation, and "account released"
      "confirmed_practice: 'interview_confirmed_practice'",
      "auExistingDoctorWhatsAppGate(userId, 'account_released')"
    ]) expect(SERVER, pin).toContain(pin);
    // The old re-engagement sweeps only ever message UK mobile numbers.
    expect(SERVER).toContain('const phone = zohoReengage.ukMobileE164(r.phone);');
  });
});

// ─────────────────────────── 2 to 4. the real server ───────────────────────────
describe('WP-18 guard: what an Australian recipient can be sent, through the real senders', () => {
  let rig = null;
  let seq = 0;
  const J = {};
  const newAu = (kind, over) => { seq += 1; return rig.addDoctor(R.auDoctor(kind || 'au_vr', 100 + seq, over)); };
  const templates = (list) => (list || []).filter((m) => m.type === 'template' && !m.refused).map((m) => m.templateName);
  const allWa = (out) => Object.keys(out.wa).reduce((l, k) => l.concat(out.wa[k].map((m) => Object.assign({ step: k }, m))), []);
  const mailTo = (out, step, who) => (out.mail[step] || []).filter((e) => e.to.toLowerCase().indexOf(String(who).toLowerCase()) !== -1);
  const words = (e) => e.subject + '\n' + e.text + '\n' + htmlText(e.html);
  const BASE = ['gp_link_account_released', 'gp_link_app_match_invitation', 'gp_link_consult_call_starting_5m', 'gp_link_practice_candidate_intro'];

  // What one journey may contain. `allowedExisting` = the neutral templates
  // (always) plus whatever the owner has switched on for this run.
  function assertAustralianSafe(out, label, enabledNames) {
    const allowed = byClass('neutral').concat(enabledNames || []);
    for (const m of allWa(out)) {
      const where = label + ' / ' + m.step;
      if (m.type === 'template') {
        const cls = wa.templateClass(m.templateName);
        expect(cls, where + ': ' + m.templateName).not.toBe('overseas_only');
        expect(cls, where + ': ' + m.templateName).not.toBe('unknown');
        if (cls !== 'au') expect(allowed, where + ': ' + m.templateName).toContain(m.templateName);
        else expect(enabledNames || [], where + ': ' + m.templateName).toContain(m.templateName);
        expect(bannedIn(m.placeholders.join('\n')), where + ' values').toEqual([]);
        expect(RSO.test(m.placeholders.join('\n')), where + ' values').toBe(false);
        expect(/internationally trained|Expedited Specialist/i.test(m.placeholders.join('\n')), where).toBe(false);
      } else {
        // Free text (delivered only inside the 24-hour window): the same rule.
        expect(bannedIn(String(m.text)), where + ' text').toEqual([]);
        expect(RSO.test(String(m.text)), where + ' text').toBe(false);
      }
    }
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(R.NOW));
    process.env.AU_LEAD_COPY_LIVE_FROM = '2020-01-01T00:00:00Z';
    rig = await R.bootWhatsAppRig({ name: 'wp18-guard', doctors: [] });
    rig.setSwitch(true);
    rig.t.__setAuQuietHoursClockForTest(Date.parse('2026-11-23T03:00:00Z'));   // 11 am in Perth, 2 pm in Sydney
    delete process.env.AU_WHATSAPP_APPROVED_TEMPLATES;
    delete process.env.AU_WHATSAPP_DISABLED_TEMPLATES;
    const run = async (key, d) => {
      vi.setSystemTime(new Date(R.NOW));
      rig.table('scheduled_calls').forEach((r) => { r.status = 'cancelled'; });
      J[key] = { d, out: await R.doctorJourney(rig, d, { guardExtras: true }) };
    };
    // Segment A at each stage; segments B and C.
    await run('a_before_placement', newAu('au_vr'));
    await run('a_prestart', newAu('au_vr', { caseRow: { stage: 'prestart' } }));
    await run('a_commenced', newAu('au_vr', { caseRow: { stage: 'commenced' } }));
    await run('b_restricted', newAu('au_restricted'));
    await run('c_non_vr', newAu('au_non_vr'));
    vi.setSystemTime(new Date(R.NOW));
    J.lead = { out: await R.leadJourney(rig, R.leadRow('au')) };
    // FR-1 (R-06), the segment dimension: the same journey for a lead in each
    // segment that is not launched, and one whose segment is not known.
    for (const seg of ['au_restricted', 'au_non_vr', 'au_registrar', 'au_unknown']) {
      vi.setSystemTime(new Date(R.NOW));
      J['lead_' + seg] = { out: await R.leadJourney(rig, R.leadRow('au', { consult: { segment: seg } })) };
    }
  }, 300000);
  afterAll(async () => {
    ['AU_WHATSAPP_APPROVED_TEMPLATES', 'AU_WHATSAPP_DISABLED_TEMPLATES', 'AU_LEAD_COPY_LIVE_FROM'].forEach((k) => { delete process.env[k]; });
    if (rig) { rig.t.__setAuQuietHoursClockForTest(null); await rig.close(); }
    vi.useRealTimers();
  });
  beforeEach(() => {
    vi.setSystemTime(new Date(R.NOW));
    rig.setSwitch(true);
    rig.refused.clear();
    rig.emu.failTables = {};
    delete process.env.AU_WHATSAPP_APPROVED_TEMPLATES;
    delete process.env.AU_WHATSAPP_DISABLED_TEMPLATES;
  });

  it('an Australian doctor at every stage and in every segment: no overseas-only template, no "Registration Support Officer" one, by any path', () => {
    for (const key of ['a_before_placement', 'a_prestart', 'a_commenced', 'b_restricted', 'c_non_vr']) {
      const out = J[key].out;
      assertAustralianSafe(out, key, []);
      // Exactly these neutral ones went, and nothing else at all: account
      // released, the match invitation, "your call starts in 5 minutes" (the
      // doctor's own call with the CEO) and the introduction to the practice.
      expect(Array.from(new Set(templates(allWa(out)))).sort(), key).toEqual(BASE);
      // The journey really ran (a skipped step proves nothing).
      expect(out.results.intro.status, key).toBe(200);
      expect(out.results.timesReady.status, key).toBe(200);
      expect(out.results.booked.status, key).toBe(200);
      expect(out.results.resend.status, key).toBe(200);
      for (const step of ['assignAdminCase', 'assignOpsCase', 'assignBulk', 'assignResync']) expect(out.results[step].status, key + ' ' + step).toBe(200);
    }
  });

  it('T1: a staff member assigned to an Australian doctor\'s case, every way it can happen: no welcome WhatsApp, and the case is not marked as welcomed', () => {
    for (const key of ['a_before_placement', 'a_prestart', 'a_commenced', 'b_restricted', 'c_non_vr']) {
      const out = J[key].out;
      for (const step of ['assignAdminCase', 'assignOpsCase', 'assignBulk', 'assignResync', 'assignDirect', 'assignDirectNoUserId']) {
        expect(out.wa[step], key + ' ' + step).toEqual([]);
        expect(out.results[step].welcomed, key + ' ' + step).toBe(false);
      }
      expect(out.results.assignBulk.status).toBe(200);
      expect(out.results.assignResync.welcome).toEqual({ ok: false, skipped: true });
      // Staff can see why, once.
      const notes = rig.table('task_timeline').filter((x) => x.case_id === J[key].d.caseId && x.title === 'WhatsApp skipped: no approved Australian template' && /"rso welcome"/.test(String(x.detail)));
      expect(notes.length, key).toBe(1);
    }
  });

  it('T1: the assignment made at pre-start (assignRsoForPrestart) sends no welcome either', async () => {
    const d = newAu('au_vr', { caseRow: { stage: 'prestart', assigned_va: null, assigned_rso: null } });
    rig.reset();
    const r = await rig.w.assignRsoForPrestart(d.caseId, { rsoUserId: R.RSO_A.user_id });
    await rig.quiet();
    expect(r).toMatchObject({ ok: true, assigned: true });
    expect(rig.wa).toEqual([]);
    expect(rig.table('task_timeline').filter((x) => x.case_id === d.caseId && /RSO welcome/.test(String(x.title)))).toEqual([]);
    // It does not call the welcome sender at all.
    const at = SERVER.indexOf('async function assignRsoForPrestart(');
    expect(SERVER.slice(at, SERVER.indexOf('\nasync function ', at + 10))).not.toContain('ensureRsoWelcomeSent');
  });

  it('T2: a call booked with a staff member: neither "registration support call" template; the Australian email reminds them instead, on their own clock, once', () => {
    for (const key of ['a_before_placement', 'a_prestart', 'b_restricted']) {
      const { d, out } = J[key];
      expect(out.wa['callReminder:registration:dayBefore'], key).toEqual([]);
      expect(out.wa['callReminder:registration:starting'], key).toEqual([]);
      const day = mailTo(out, 'callReminder:registration:dayBefore', d.email);
      const soon = mailTo(out, 'callReminder:registration:starting', d.email);
      expect(day.map((e) => e.subject), key).toEqual(['Reminder: your GP Link call is coming up']);
      expect(soon.map((e) => e.subject), key).toEqual(['Your GP Link call is starting']);
      expect(day[0].text).toContain('a reminder that your call with the GP Link team is coming up on Tuesday 24 November, 4:00 am (Perth time).');
      expect(day[0].text).toContain('Join the call: https://zoom.us/j/0000000000');
      for (const e of day.concat(soon)) {
        expect(bannedIn(words(e)), key).toEqual([]);
        expect(RSO.test(words(e)), key).toBe(false);
        expect(/registration support/i.test(words(e)), key).toBe(false);
      }
      expect(out.results['callReminder:registration:dayBefore']).toMatchObject({ sent: 0, emailsSent: 1 });
    }
  });

  it('T2: the email is sent once per reminder (its marker is stamped), and the wording is in the catalogue', async () => {
    const d = newAu('au_vr');
    const calls = rig.table('scheduled_calls');
    const at = new Date(Date.now() + 20 * 3600000).toISOString();
    calls.push({ id: 'wp18-once-' + seq, user_id: d.userId, invitee_email: d.email, meeting_kind: 'consultation', host_kind: 'rso', status: 'booked', scheduled_at: at,
      booked_at: new Date(Date.now() - 3 * 86400000).toISOString(), zoom_join_url: 'https://zoom.us/j/0000000000', notification_channels: {}, invitee_notes: '', timezone: 'Australia/Perth' });
    rig.reset();
    await rig.w.runConsultCallReminders(Date.now(), 'registration');
    await rig.w.runConsultCallReminders(Date.now(), 'registration');
    await rig.quiet();
    expect(rig.emails.filter((e) => JSON.stringify(e.to).indexOf(d.email) !== -1).length).toBe(1);
    expect(rig.wa).toEqual([]);
    const row = calls.find((c) => c.id === 'wp18-once-' + seq);
    expect(row.notification_channels.reg_call_reminders.h24).toBeTruthy();
    calls.splice(calls.indexOf(row), 1);
    const built = auMessages.buildStaffCallReminderMessage({ window: 'h24', firstName: 'Sam', whenText: 'Thursday 14 January, 10:30 am (Perth time)', joinUrl: 'https://zoom.us/j/0000000000' });
    expect(bannedIn(built.subject + '\n' + built.text)).toEqual([]);
    expect(auMessages.buildStaffCallReminderMessage({ window: 'h24', whenText: 'x', joinUrl: '' })).toBeNull();   // never without the link
  });

  it('T2: a call with the CEO booked by an Australian doctor (no lead row, or an overseas one, behind them): never the "visas" reminder; the Australian email goes', async () => {
    // No lead row: from the journey.
    const { d, out } = J.a_before_placement;
    expect(templates(out.wa['callReminder:consult:dayBefore'])).toEqual([]);                       // the day-before template is overseas-only; its Australian one is not approved
    expect(templates(out.wa['callReminder:consult:starting'])).toEqual(['gp_link_consult_call_starting_5m']);   // neutral, reused
    const mail = mailTo(out, 'callReminder:consult:dayBefore', d.email);
    expect(mail.length).toBe(1);
    expect(bannedIn(words(mail[0]))).toEqual([]);
    expect(words(mail[0])).toContain('(Perth time)');
    // An OVERSEAS lead row with the same address (they filled in the form as a UK doctor, then signed up as an Australian one).
    const d2 = newAu('au_vr');
    rig.table('site_enquiries').length = 0;
    rig.table('site_enquiries').push({ id: 'wp18-mixed-lead', kind: 'gp', name: 'Dr Testau Mixed', email: d2.email, phone: d2.profile.phone, source: 'consult_form', created_at: R.SEED,
      metadata: { consult: { token: 'TOKMIXED', qualified: true, country: 'uk', segment: 'overseas', call_booked: true, call_at: new Date(Date.now() + 20 * 3600000).toISOString(), nudges: [] } } });
    const calls = rig.table('scheduled_calls');
    calls.push({ id: 'wp18-mixed-call', user_id: d2.userId, invitee_email: d2.email, meeting_kind: 'consultation', host_kind: 'ceo', status: 'booked', scheduled_at: new Date(Date.now() + 20 * 3600000).toISOString(),
      booked_at: new Date(Date.now() - 3 * 86400000).toISOString(), zoom_join_url: 'https://zoom.us/j/0000000000', notification_channels: {}, invitee_notes: '', timezone: 'Australia/Perth' });
    rig.reset();
    await rig.w.runConsultCallReminders(Date.now(), 'consult');
    await rig.quiet();
    expect(templates(rig.wa)).toEqual([]);
    const got = rig.emails.filter((e) => JSON.stringify(e.to).indexOf(d2.email) !== -1);
    expect(got.length).toBe(1);
    expect(bannedIn(String(got[0].subject) + '\n' + String(got[0].text))).toEqual([]);
    expect(String(got[0].text)).toContain('(Perth time)');
    // The overseas lead's own record is not written to as if it were Australian.
    expect(rig.table('site_enquiries')[0].metadata.consult.au_log).toBeUndefined();
    calls.splice(calls.findIndex((c) => c.id === 'wp18-mixed-call'), 1);
    rig.table('site_enquiries').length = 0;
  });

  it('T3: interview times ready, interview confirmed (doctor and practice) and contract ready: no WhatsApp, and the email goes with Australian words and the same link', () => {
    for (const key of ['a_before_placement', 'b_restricted', 'c_non_vr']) {
      const { d, out } = J[key];
      const appId = rig.appIdFor(d);
      // interview times ready (both send sites)
      expect(templates(out.wa.timesReady), key).toEqual([]);
      expect(templates(out.wa.bookingInvite), key).toEqual([]);
      const times = mailTo(out, 'timesReady', d.email).concat(mailTo(out, 'bookingInvite', d.email));
      expect(times.length, key).toBeGreaterThanOrEqual(1);
      expect(times.some((e) => e.html.indexOf('/pages/secure-interview?applicationId=' + encodeURIComponent(appId)) !== -1 || e.html.indexOf(encodeURIComponent('/pages/secure-interview?applicationId=' + appId)) !== -1 || e.html.indexOf(appId) !== -1), key).toBe(true);
      // interview confirmed
      expect(templates(out.wa.booked), key).toEqual([]);
      const conf = mailTo(out, 'booked', d.email);
      expect(conf.map((e) => e.subject), key).toEqual(['Your interview is confirmed 🎉']);
      const toPractice = mailTo(out, 'booked', 'manager@metro-practice.gplink-test.local');
      expect(toPractice.length, key).toBe(1);
      // the staff re-send: the note is neutral free text; the template is skipped for both
      expect(templates(out.wa.resend), key).toEqual([]);
      expect(out.wa.resend.filter((m) => m.type === 'text').length, key).toBe(2);
      // contract ready
      expect(templates(out.wa.contractReady), key).toEqual([]);
      expect(out.results.contractReady.whatsapp, key).toEqual({ ok: false, skipped: 'au_template_not_approved' });
      const contract = mailTo(out, 'contractReady', d.email);
      expect(contract.length, key).toBe(1);
      expect(contract[0].html).toContain('/pages/offer-review?applicationId=' + encodeURIComponent(appId));
      for (const e of times.concat(conf, contract)) {
        expect(bannedIn(words(e)), key + ' ' + e.subject).toEqual([]);
        expect(RSO.test(words(e)), key + ' ' + e.subject).toBe(false);
      }
      // the practice is never told where the doctor trained
      expect(/internationally trained|Expedited Specialist/i.test(words(toPractice[0])), key).toBe(false);
      // Staff can see each skip, once, on the case.
      const notes = rig.table('task_timeline').filter((x) => x.case_id === d.caseId && x.title === 'WhatsApp skipped: no approved Australian template').map((x) => x.metadata && x.metadata.au_whatsapp_skipped).sort();
      // ('call_reminder' is the day-before reminder for their own call with the CEO.)
      expect(notes, key).toEqual(['call_reminder', 'contract_ready', 'interview_confirmed', 'interview_confirmed_practice', 'interview_times_ready', 'match_accepted', 'rso_welcome', 'staff_call_reminder']);
      const practiceNote = rig.table('task_timeline').find((x) => x.case_id === d.caseId && x.metadata && x.metadata.au_whatsapp_skipped === 'interview_confirmed_practice');
      expect(practiceNote.detail).toBe('The "interview confirmed" WhatsApp was not sent to the practice about this doctor (the email still went). It starts going once the Australian template is approved.');
    }
  });

  it('T3: "thanks for accepting your match": the template is skipped; the free text an Australian doctor gets says who is really arranging it, never the overseas wording', () => {
    for (const key of ['a_before_placement', 'a_prestart']) {
      const out = J[key].out;
      for (const step of ['matchAccepted', 'matchAcceptedTemplateRefused']) {
        expect(templates(out.wa[step]), key).toEqual([]);
        const text = out.wa[step].filter((m) => m.type === 'text');
        expect(text.length, key + ' ' + step).toBe(1);
        expect(text[0].text).toMatch(/Your GP Link (consultant|team) is now arranging your interview/);
        expect(RSO.test(text[0].text)).toBe(false);
      }
    }
  });

  it('a pathway that cannot be read: nothing overseas is sent as a guess (no template, no free text), and nothing is stamped', async () => {
    const d = newAu('au_vr');
    const appRow = rig.table('gp_applications').find((r) => r.id === rig.appIdFor(d));
    rig.emu.failTables = { user_profiles: 500 };
    rig.reset();
    const welcome = await rig.w.ensureRsoWelcomeSent({ caseId: d.caseId, gpUserId: d.userId, gpPhone: d.profile.phone, rsoUserId: R.RSO_A.user_id });
    const accepted = await rig.w.sendMatchAcceptedWhatsAppToGp(appRow);
    const drop = await rig.w.maybeSendDropoffWa(d.userId, 'Testau Auvr', 'career_start');
    const tpl = await rig.w.sendInterviewWhatsappTemplate('+61400000901', 'confirmed_practice', ['Test Manager', 'Dr Testau Auvr', 'x', 'https://zoom.us/j/0'], undefined, d.userId);
    await rig.quiet();
    rig.emu.failTables = {};
    expect(welcome).toMatchObject({ ok: false, skipped: true, reason: 'pathway_unreadable' });
    expect(accepted.ok).toBe(false);
    expect(drop).toEqual({ ok: false, skipped: 'au_no_overseas_template' });
    expect(tpl).toEqual({ ok: false, skipped: 'pathway_unreadable' });
    expect(rig.wa).toEqual([]);
    expect(rig.table('task_timeline').filter((x) => x.case_id === d.caseId && /RSO welcome/.test(String(x.title)))).toEqual([]);
  });

  it('the stage messages and the drop-off nudges: none reaches an Australian doctor, through the automation or through the senders themselves', () => {
    for (const key of ['a_before_placement', 'a_prestart', 'a_commenced', 'b_restricted', 'c_non_vr']) {
      const out = J[key].out;
      expect(out.wa.stageMessages, key).toEqual([]);
      expect(out.wa.careerSecuredState, key).toEqual([]);
      Object.keys(out.wa).filter((k) => /^dropoff/.test(k)).forEach((k) => {
        expect(out.wa[k], key + ' ' + k).toEqual([]);
        expect(out.results[k], key + ' ' + k).toEqual({ ok: false, skipped: 'au_no_overseas_template' });
      });
      expect(Object.keys(out.wa).filter((k) => /^dropoff/.test(k)).length).toBe(10);
    }
  });

  it('the scheduled jobs, with Australian doctors (finished and part-way through sign-up) and an Australian lead on the books: nothing overseas goes out', async () => {
    const part = newAu('au_vr', { noCase: true, profile: { onboarding_completed_at: null }, state: { gp_onboarding_complete: false, gp_onboarding: { country: 'AU', currentStep: 2, auBranch: true } } });
    const anchor = new Date(Date.now() - 26 * 3600000).toISOString();
    rig.table('onboarding_reminders').push({ id: 'rem-wp18', user_id: part.userId, email: part.email, name: 'Testau Auvr', anchor_at: anchor, last_step: 2, steps_sent: [], unsubscribed: false, stopped: false, created_at: anchor, updated_at: anchor });
    rig.table('site_enquiries').length = 0;
    const lead = R.leadRow('au');
    lead.kind = 'gp';
    lead.created_at = new Date(Date.now() - 26 * 3600000).toISOString();
    lead.metadata.consult.qualified_at = lead.created_at;
    rig.table('site_enquiries').push(lead);
    const CRON = { headers: { Authorization: 'Bearer test-cron-secret' } };
    const jobs = ['onboarding-nudge', 'onboarding-step-followup', 'dropoff-nudge', 'consult-nudge', 'call-reminders', 'match-lifecycle', 'interview-reminders',
      'weekly-sweep', 'sla-sweep', 'chase-nonresponders', 'practice-decision-reminders', 'stalled-applications', 'detect-no-shows', 'zoho-whatsapp', 'zoho-reengage'];
    const australian = new Set(Object.keys(J).filter((k) => J[k].d).map((k) => R.digits(J[k].d.profile.phone)).concat([R.digits(part.profile.phone), R.digits(lead.phone), '61400000901']));
    rig.reset();
    const statuses = {};
    for (const job of jobs) {
      const res = await rig.get('/api/cron/' + job, CRON);
      statuses[job] = res.status;
      await rig.quiet();
    }
    // The jobs ran (a refused job would prove nothing).
    for (const job of ['onboarding-nudge', 'dropoff-nudge', 'consult-nudge', 'call-reminders', 'match-lifecycle']) expect(statuses[job], job).toBe(200);
    for (const m of rig.wa.filter((x) => australian.has(x.to))) {
      if (m.type === 'template') {
        expect(wa.templateClass(m.templateName), m.templateName).toBe('neutral');
        expect(bannedIn(m.placeholders.join('\n')), m.templateName).toEqual([]);
      } else {
        expect(bannedIn(String(m.text))).toEqual([]);
        expect(RSO.test(String(m.text))).toBe(false);
      }
    }
    // And no overseas-only template went to anybody in this all-Australian database.
    expect(rig.wa.filter((m) => m.type === 'template' && wa.templateClass(m.templateName) === 'overseas_only').map((m) => m.templateName)).toEqual([]);
    rig.table('site_enquiries').length = 0;
  }, 120000);

  it('an Australian-segment lead: only the five neutral templates, with Australian-safe values; the rest are skipped by name and the emails carry them', () => {
    const out = J.lead.out;
    assertAustralianSafe(out, 'lead', []);
    const sent = {};
    Object.keys(out.wa).forEach((k) => { const n = templates(out.wa[k]); if (n.length) sent[k] = n; });
    expect(sent).toEqual({
      'kind:onboarding_incomplete': ['gp_link_consult_onboarding_nudge'],
      'kind:post_call_onboard': ['gp_link_consult_post_call_onboard_v3'],
      missedCall: ['gp_link_consult_missed_call'],
      'callReminder:hourBefore': ['gp_link_consult_call_1h'],
      'callReminder:starting': ['gp_link_consult_call_starting_5m']
    });
    for (const k of ['kind:hello_5m', 'kind:check_in_1h', 'kind:day_after_24h', 'kind:call_booked', 'kind:signed_up']) {
      expect(out.wa[k], k).toEqual([]);
      expect(out.results[k], k).toEqual({ ok: false, reason: 'au_template_not_approved' });
    }
    // The day before: the WhatsApp is skipped, the Australian email goes.
    expect(out.wa['callReminder:dayBefore']).toEqual([]);
    expect(out.results['callReminder:dayBefore']).toMatchObject({ sent: 0, emailsSent: 1 });
    // An hour before: both go. The missed call: both go.
    expect(out.results['callReminder:hourBefore']).toMatchObject({ sent: 1, emailsSent: 1 });
    expect(out.mail.missedCall.map((e) => e.subject)).toEqual(['Sorry we missed each other']);
    Object.keys(out.mail).forEach((k) => out.mail[k].forEach((e) => expect(bannedIn(words(e)), k).toEqual([])));
  });

  // FR-1 (final review R-06). The two reused lead templates whose FIXED
  // wording promises matching ("I can start matching you to practices", "we
  // can start matching you with Australian practices") never reach a lead in
  // a segment that is not launched, or one whose segment is not known.
  describe('R-06: the segment dimension', () => {
    const PROMISING = ['lead_post_call_onboard', 'lead_onboarding_incomplete'];
    it('exactly the two role-promising rows are marked, and their live fixed text really does promise matching', () => {
      const marked = Object.keys(wa.AU_WHATSAPP_TEMPLATES).filter((k) => wa.AU_WHATSAPP_TEMPLATES[k].launchedSegmentOnly === true).sort();
      expect(marked).toEqual(PROMISING.slice().sort());
      const live = fs.readFileSync(path.join(ROOT, 'docs/au-gp/whatsapp-live-templates.md'), 'utf8');
      for (const key of PROMISING) {
        const name = wa.AU_WHATSAPP_TEMPLATES[key].templateName;
        const line = live.split('\n').filter((l) => l.indexOf('| `' + name + '` | "') === 0)[0] || '';
        expect(line, name).toMatch(/start matching you/);
      }
      // ...and no OTHER reused lead template's fixed text promises matching or roles.
      Object.keys(wa.AU_WHATSAPP_TEMPLATES).filter((k) => /^lead_/.test(k) && wa.AU_WHATSAPP_TEMPLATES[k].approved && PROMISING.indexOf(k) === -1).forEach((k) => {
        const name = wa.AU_WHATSAPP_TEMPLATES[k].templateName;
        const line = live.split('\n').filter((l) => l.indexOf('| `' + name + '` | "') === 0)[0] || '';
        expect(line, name + ' is quoted in the live-template review').not.toBe('');
        expect(line, name).not.toMatch(/match(ing|ed)? you|open roles|roles (that|for)|practices looking/i);
      });
    });

    it('the plan, every lead row x every segment: a promising row is sent to au_vr only; unknown, missing and overseas values fail closed', () => {
      const SEGMENTS = ['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar', 'au_unknown', 'overseas', '', undefined, null, 'AU_VR', 'garbage'];
      Object.keys(wa.AU_WHATSAPP_TEMPLATES).filter((k) => /^lead_/.test(k)).forEach((key) => {
        const kind = key.replace(/^lead_/, '');
        const row = wa.AU_WHATSAPP_TEMPLATES[key];
        SEGMENTS.forEach((segment) => {
          const plan = wa.auLeadWhatsAppPlan(kind, {}, { segment });
          const label = key + ' / ' + String(segment);
          if (!row.approved) expect(plan, label).toMatchObject({ send: false, reason: 'au_template_not_approved' });
          else if (PROMISING.indexOf(key) === -1) expect(plan.send, label).toBe(true);
          else if (String(segment || '').toLowerCase() === 'au_vr') expect(plan, label).toMatchObject({ send: true, templateName: row.templateName });
          else expect(plan, label).toEqual({ send: false, reason: 'au_template_promises_roles', key, templateName: row.templateName });
        });
        // a caller that passes no segment at all
        const bare = wa.auLeadWhatsAppPlan(kind, {});
        if (PROMISING.indexOf(key) !== -1) expect(bare.send, key).toBe(false);
      });
      // the environment can switch a row off, but cannot widen who it reaches
      expect(wa.auLeadWhatsAppPlan('post_call_onboard', { AU_WHATSAPP_APPROVED_TEMPLATES: 'lead_post_call_onboard' }, { segment: 'au_registrar' }).send).toBe(false);
      expect(wa.auLeadWhatsAppPlan('post_call_onboard', { AU_WHATSAPP_DISABLED_TEMPLATES: 'lead_post_call_onboard' }, { segment: 'au_vr' })).toMatchObject({ send: false, reason: 'au_template_not_approved' });
    });

    it.each([['au_restricted'], ['au_non_vr'], ['au_registrar'], ['au_unknown']])('a %s lead on the real server: the two promising templates are skipped by name; the time-and-link ones still go', (seg) => {
      const out = J['lead_' + seg].out;
      assertAustralianSafe(out, 'lead ' + seg, []);
      const sent = {};
      Object.keys(out.wa).forEach((k) => { const n = templates(out.wa[k]); if (n.length) sent[k] = n; });
      expect(sent).toEqual({
        missedCall: ['gp_link_consult_missed_call'],
        'callReminder:hourBefore': ['gp_link_consult_call_1h'],
        'callReminder:starting': ['gp_link_consult_call_starting_5m']
      });
      for (const k of ['kind:post_call_onboard', 'kind:onboarding_incomplete']) {
        expect(out.wa[k], k).toEqual([]);
        expect(out.results[k], k).toEqual({ ok: false, reason: 'au_template_promises_roles' });
      }
      for (const k of ['kind:hello_5m', 'kind:check_in_1h', 'kind:day_after_24h', 'kind:call_booked', 'kind:signed_up']) {
        expect(out.results[k], k).toEqual({ ok: false, reason: 'au_template_not_approved' });
      }
    });

    it('the skip is recorded on the lead in words staff can read', () => {
      const copy = require('../lib/au-lead-copy.js');
      expect(JSON.stringify(copy)).toBeDefined();
      const src = fs.readFileSync(path.join(ROOT, 'lib/au-lead-copy.js'), 'utf8');
      expect(src).toContain("au_template_promises_roles: 'the template promises matching, and this lead\\'s segment is not launched'");
    });
  });

  it('the reused templates carry Australian-safe values (the snapshot of what an Australian recipient is sent)', () => {
    const { d, out } = J.a_before_placement;
    const lead = J.lead.out;
    const pick = (list) => list.filter((m) => m.type === 'template').map((m) => ({ templateName: m.templateName, language: m.language, placeholders: m.placeholders, buttons: m.buttons, header: m.header }));
    // The CV version of the introduction (the rig has no file store to sign a
    // CV link from, so this one is built with the same builder the route uses).
    const intro = out.wa.intro.filter((m) => m.type === 'template')[0];
    const cv = practiceWa.buildPracticeSubmissionWaMessage({
      contactName: intro.placeholders[0], practiceName: intro.placeholders[1], introParagraph: intro.placeholders[2], actionToken: 'tok_sample',
      cvUrl: 'https://storage.gplink-test.local/cv.pdf', cvFilename: 'Dr-Testau-Auvr-CV.pdf', templateNames: wa.auPracticeIntroWhatsAppPlan({}).templateNames
    });
    const snap = {
      practice_intro: pick(out.wa.intro),
      practice_intro_cv: [{ templateName: cv.templateName, language: cv.language, placeholders: cv.placeholders, buttons: cv.buttons, header: { type: cv.header.type, filename: cv.header.filename } }],
      lead_call_hour_before: pick(lead.wa['callReminder:hourBefore']),
      lead_call_starting: pick(lead.wa['callReminder:starting']),
      lead_call_missed: pick(lead.wa.missedCall),
      lead_post_call_onboard: pick(lead.wa['kind:post_call_onboard']),
      lead_onboarding_incomplete: pick(lead.wa['kind:onboarding_incomplete']),
      match_invitation: pick(out.wa.matchInvitation),
      account_released: pick(out.wa.accountReleased)
    };
    const scrubbed = JSON.parse(JSON.stringify(snap).split(String(d.profile.last_name)).join('Auvr'));
    if (process.env.WP18_WRITE_REUSED === '1') fs.writeFileSync(REUSED_SNAPSHOT, JSON.stringify(scrubbed, null, 2) + '\n');
    expect(scrubbed).toEqual(JSON.parse(fs.readFileSync(REUSED_SNAPSHOT, 'utf8')));
    // Each key sends through exactly the template its row names.
    Object.keys(snap).forEach((key) => {
      expect(snap[key].length, key).toBe(1);
      expect(snap[key][0].templateName, key).toBe(wa.AU_WHATSAPP_TEMPLATES[key].templateName);
      expect(bannedIn(snap[key][0].placeholders.join('\n')), key).toEqual([]);
    });
    // The introduction paragraph is the Australian one, and a practice may be told it.
    expect(snap.practice_intro[0].placeholders[2]).toMatch(/is a vocationally registered GP/);
    expect(careerIntro.auPracticeTextViolations(snap.practice_intro[0].placeholders.join('\n'))).toEqual([]);
    expect(snap.practice_intro[0].buttons).toEqual([{ type: 'URL', parameter: '<token>' }]);
    // Times name the Australian city; links land where an Australian doctor should.
    expect(snap.lead_call_hour_before[0].placeholders[1]).toMatch(/^\d{1,2}:\d{2} (am|pm) \(Perth time\)$/);
    expect(snap.lead_call_missed[0].placeholders[1]).toBe('https://app.gplink-test.local/start?lead=TOKAUWP18#book');
    expect(snap.lead_post_call_onboard[0].placeholders[1]).toMatch(/^https:\/\/app\.gplink-test\.local\/pages\/signin\?signup=1&email=.*&ref=wa_postcall$/);
    expect(snap.match_invitation[0].placeholders[2]).toMatch(/^We are holding this one for you until /);
    expect(snap.match_invitation[0].placeholders[3]).toContain('/pages/signin?next=');
    // Staff can see which template carried each.
    const via = rig.table('task_timeline').filter((x) => x.case_id === d.caseId && /^WhatsApp sent via existing neutral template /.test(String(x.title))).map((x) => x.title.replace('WhatsApp sent via existing neutral template ', '')).sort();
    expect(via).toEqual(['gp_link_account_released', 'gp_link_app_match_invitation', 'gp_link_practice_candidate_intro']);
    expect(out.results.intro.au_introduction).toEqual({ whatsapp: { sent: true, template: 'gp_link_practice_candidate_intro' } });
  });

  it('a refused template (not approved by Meta, or on the local "unapproved" list) falls back to email: the introduction still reaches the practice', async () => {
    const d = newAu('au_vr');
    rig.refused.add('gp_link_practice_candidate_intro');
    rig.table('scheduled_calls').forEach((r) => { r.status = 'cancelled'; });
    const consent = require('../lib/profile-share-consent.js');
    const rigLib = require('./helpers/au-wp09-intro-rig.js');
    rig.resetApplication(d, consent.buildConsentPatch({ source: 'doctor', application: { career_role_id: rigLib.ROLE_ID }, by: 'staff.test@gplink-test.local', now: R.SEED }));
    rig.reset();
    const res = await rig.introduce(d, { decision: false });
    await rig.quiet();
    expect(res.status).toBe(200);
    expect(rig.wa.map((m) => [m.templateName, m.refused])).toEqual([['gp_link_practice_candidate_intro', true]]);
    expect(res.json.au_introduction).toEqual({ whatsapp: { sent: false, reason: 'send_failed' } });
    expect(res.emails.length).toBe(1);
    expect(JSON.stringify(res.emails[0].to)).toContain('manager@metro-practice.gplink-test.local');
  });

  it('the owner\'s switch: listing one key turns on that one WhatsApp for an Australian doctor and nothing else', async () => {
    const base = BASE;
    const CASES = [
      ['interview_times_ready_existing', 'gp_link_interview_times_ready', ['timesReady', 'bookingInvite']],
      ['interview_confirmed_existing', 'gp_link_interview_confirmed_gp', ['booked', 'resend']],
      ['interview_confirmed_practice_existing', 'gp_link_interview_confirmed_practice', ['booked', 'resend']],
      ['contract_ready_existing', 'gp_link_contract_ready', ['contractReady']],
      ['match_accepted_existing', 'gp_link_app_match_accepted', ['matchAccepted']],
      // ... and a new Australian template once Meta has approved it.
      ['interview_times_ready', 'gp_link_au_interview_times_ready', ['timesReady', 'bookingInvite']],
      ['rso_welcome', 'gp_link_au_team_welcome', ['assignAdminCase', 'assignOpsCase', 'assignBulk', 'assignResync', 'assignDirect', 'assignDirectNoUserId']]
    ];
    for (const [key, name, steps] of CASES) {
      process.env.AU_WHATSAPP_APPROVED_TEMPLATES = key;
      vi.setSystemTime(new Date(R.NOW));
      rig.table('scheduled_calls').forEach((r) => { r.status = 'cancelled'; });
      const d = newAu('au_vr');
      const out = await R.doctorJourney(rig, d, { guardExtras: true });
      assertAustralianSafe(out, key, [name]);
      expect(Array.from(new Set(templates(allWa(out)))).sort(), key).toEqual(base.concat([name]).sort());
      const where = Object.keys(out.wa).filter((k) => templates(out.wa[k]).indexOf(name) !== -1).sort();
      expect(where, key).toEqual(steps.slice().sort());
      // The same variables the existing template takes, Australian-safe.
      out.wa[steps[0]].filter((m) => m.templateName === name).forEach((m) => expect(bannedIn(m.placeholders.join('\n')), key).toEqual([]));
      if (key === 'rso_welcome') {
        expect(out.results.assignAdminCase.welcomed).toBe(true);          // a real send does stamp the marker
        expect(out.wa.assignDirect[0].placeholders).toEqual(['Testau', 'Test', 'Test']);
      }
      if (key === 'interview_times_ready_existing') {
        expect(out.wa.timesReady[0].buttons).toEqual([{ type: 'URL', parameter: '<application>' }]);
        const note = rig.table('task_timeline').filter((x) => x.case_id === d.caseId && x.title === 'WhatsApp sent via existing template gp_link_interview_times_ready (the owner switched it on)');
        expect(note.length).toBe(1);
      }
    }
  }, 300000);

  it('the owner\'s off switch: a reused template listed in AU_WHATSAPP_DISABLED_TEMPLATES stops going to Australian recipients; the email still goes', async () => {
    process.env.AU_WHATSAPP_DISABLED_TEMPLATES = 'practice_intro,practice_intro_cv,match_invitation,account_released,lead_call_starting';
    const d = newAu('au_vr');
    rig.table('scheduled_calls').forEach((r) => { r.status = 'cancelled'; });
    const out = await R.doctorJourney(rig, d, { guardExtras: true });
    expect(templates(allWa(out))).toEqual([]);
    expect(out.results.intro.au_introduction).toEqual({ whatsapp: { sent: false, reason: 'au_template_not_approved' } });
    expect(mailTo(out, 'intro', 'manager@metro-practice.gplink-test.local').length).toBe(1);
    expect(out.results.accountReleased).toEqual({ email: true, whatsapp: false });
  }, 120000);

  it('switch OFF: a doctor with an Australian pathway on file is sent exactly what an overseas doctor is (the same templates, step for step)', async () => {
    rig.setSwitch(false);
    // (The case is stored at an overseas stage. A case stored at an AUSTRALIAN
    // stage is deliberately never handed to the overseas stage code, even with
    // the switch off: CONVENTIONS section 2, the third listed exception.)
    const d = newAu('au_vr', { caseRow: { stage: 'myintealth' } });
    rig.table('scheduled_calls').forEach((r) => { r.status = 'cancelled'; });
    const out = await R.doctorJourney(rig, d, { rawStageSender: true });
    rig.setSwitch(true);
    const uk = JSON.parse(fs.readFileSync(PARITY_SNAPSHOT, 'utf8')).uk;
    const names = (cap) => Object.keys(cap).reduce((o, k) => { o[k] = cap[k].map((m) => m.type === 'template' ? m.templateName : 'TEXT').sort(); return o; }, {});
    expect(names(out.wa)).toEqual(names(uk));
    expect(templates(out.wa.assignAdminCase)).toEqual(['gp_link_app_rso_welcome']);
  }, 120000);
});

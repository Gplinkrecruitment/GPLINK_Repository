'use strict';

/**
 * WP-18 (WhatsApp templates) test rig: the real server, with every WhatsApp
 * it tries to send recorded (template sends AND free-text sends) and every
 * email recorded. Nothing real is sent: DoubleTick and Resend are stand-ins.
 *
 *   const rig = await bootWhatsAppRig({ name, doctors });
 *   const out = await doctorJourney(rig, doctor);    // { wa: {step: [...]}, mail: {step: [...]} }
 *   const lead = await leadJourney(rig, leadRow);    // the consult funnel for one lead
 *
 * doctorJourney drives one doctor (and the practice they are put to) through
 * every point where the app sends a doctor or a practice a WhatsApp: the
 * introduction, interview times, the booking, the re-send, the match notes,
 * the contract, account release, staff assignment (all four ways), the stage
 * messages, staff-hosted call reminders and the drop-off nudges.
 *
 * tests/fixtures/au-wp18-overseas-whatsapp.snapshot.json was written from this
 * file on the tree BEFORE WP-18 changed any behaviour (only the `__wp18` test
 * hooks existed). Never regenerate it to make a test pass.
 */

const { buildAuDoctor, fakeUuid } = require('./au-fixtures.js');
const rigLib = require('./au-wp09-intro-rig.js');
const consent = require('../../lib/profile-share-consent.js');
const dropoffNudges = require('../../lib/dropoff-nudges.js');
const consultWhatsapp = require('../../lib/consult-whatsapp.js');

const NOW = '2026-11-23T00:00:00.000Z';   // Monday 23 November 2026, 11:00 am in Sydney
const SEED = '2026-11-01T00:00:00.000Z';
const STAFF = 'staff.test@gplink-test.local';
const RSO_A = { user_id: '00000000-0000-4000-8000-00000000e001', name: 'Test Rso', email: 'rso.test@gplink-test.local', phone: '+61400000801', active: true, on_leave: false, calendly_event_url: null };
const RSO_B = { user_id: '00000000-0000-4000-8000-00000000e002', name: 'Test Otherrso', email: 'rso.other.test@gplink-test.local', phone: '+61400000802', active: true, on_leave: false, calendly_event_url: null };
const THU_9_TO_11 = { date: '2026-11-26', fromMin: 540, toMin: 660 };
const FRI_5_TO_730 = { date: '2026-11-27', fromMin: 1020, toMin: 1170 };
const STATE_FLAGS = {
  gp_epic_progress: { stage: 'verification_issued', completed: { account_establishment: true, upload_qualifications: true, verification_issued: true } },
  gp_amc_progress: { stage: 'qualifications_verified', completed: { upload_credentials: true, waiting_verification: true, qualifications_verified: true } },
  gp_ahpra_progress: { completed: { account_establishment: true, upload_qualifications: true, waiting_verification: true, verification_issued: true } }
};

const digits = function (v) { return String(v || '').replace(/\D/g, ''); };
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function overseasDoctor(key, n, over) {
  const names = { uk: ['Testuk', 'Ukgp', '+447700900', 'United Kingdom', 'GB'], ie: ['Testie', 'Iegp', '+353870000', 'Ireland', 'IE'] }[key];
  const phone = names[2] + String(200 + n);
  return buildAuDoctor('overseas_null', Object.assign({
    idSuffix: 'w' + n,
    profile: { first_name: names[0], last_name: names[1], phone: phone, registration_country: names[3], qualification_country: names[4] }
  }, over || {}));
}
function auDoctor(kind, n, over) {
  const o = over || {};
  return buildAuDoctor(kind, Object.assign({ idSuffix: 'x' + n, credentials: { staff_verified_at: SEED, staff_verified_by: STAFF } }, o, {
    profile: Object.assign({
      first_name: 'Testau', last_name: 'Auvr' + n, phone: '+6140000' + String(7000 + n), current_state: 'WA', timezone: null,
      register_status: 'verified', register_body: 'ahpra', register_number: 'MED000100' + String(1000 + n)
    }, o.profile || {})
  }));
}

async function bootWhatsAppRig(opts) {
  const o = opts || {};
  const doctors = o.doctors || [];
  const rig = await rigLib.bootIntroRig({
    name: o.name || 'wp18',
    doctors: doctors,
    env: Object.assign({ OWNER_NOTIFY_EMAIL: 'owner@gplink-test.local', SITE_PUBLIC_BASE_URL: 'https://app.gplink-test.local', CONSULT_NOSHOW_RESCUE_SINCE: '2020-01-01T00:00:00Z', LEAD_CALLS_ENABLED: 'false' }, o.env || {}),
    emulator: o.emulator,
    tables: Object.assign({
      rso_team: [RSO_A, RSO_B],
      va_gmail_accounts: [RSO_A, RSO_B].map(function (r) { return { user_id: r.user_id, email_address: r.email, display_name: r.name }; }),
      user_documents: doctors.map(function (d) {
        return { id: 'cv-' + d.userId, user_id: d.userId, document_key: 'career_cv', status: 'uploaded', file_name: 'cv.pdf', country_code: 'AU', created_at: SEED, updated_at: SEED };
      }),
      placements: [], candidate_leads: [], runtime_kv: [], rate_limits: [], gp_nudge_log: [], user_roles: [],
      career_suburb_geo_cache: [], match_cache: [], career_contracts: [], onboarding_reminders: [], pep_waitlist: [],
      cron_runs: [], notifications: [], user_notifications: [], doubletick_messages: [], email_suppression: [],
      site_enquiries: [], task_documents: [], task_messages: [], practice_doc_ops: [], visa_cases: [], pbs_cases: [],
      support_tickets: [], user_nudges: [], nudge_chat_messages: [], email_templates: [], au_gp_doctor_details: []
    }, o.tables || {})
  });

  // Record EVERY WhatsApp call (the intro rig keeps template sends only), and
  // let a test make DoubleTick refuse named templates (a template Meta has not
  // approved, or one on the local "unapproved" list).
  const wa = [];
  const refused = new Set();
  const inner = globalThis.fetch;
  globalThis.fetch = function (url, init) {
    const u = String(url && url.url ? url.url : url);
    if (u.indexOf('https://doubletick.invalid') === 0 && u.indexOf('/whatsapp/message/') !== -1) {
      let body = null;
      try { body = init && init.body ? JSON.parse(String(init.body)) : null; } catch (e) { body = null; }
      const isTemplate = u.indexOf('/whatsapp/message/template') !== -1;
      const msg = isTemplate ? ((body && body.messages && body.messages[0]) || {}) : (body || {});
      const content = msg.content || {};
      const td = content.templateData || {};
      const rec = isTemplate
        ? {
          type: 'template', to: digits(msg.to), templateName: content.templateName || null, language: content.language || null,
          placeholders: (td.body && td.body.placeholders) || [], buttons: td.buttons || null,
          header: td.header ? { type: td.header.type || null, filename: td.header.filename || null } : null
        }
        : { type: 'text', to: digits(msg.to), text: (content.text != null ? content.text : (body && body.body)) || null };
      rec.refused = isTemplate && refused.has(rec.templateName);
      wa.push(rec);
      if (rec.refused) {
        return Promise.resolve(new Response(JSON.stringify({ message: 'Template not approved' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
      }
    }
    return inner(url, init);
  };

  const t = rig.testUtils;
  const table = function (name) { return rig.emu.table(name); };
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  // Several senders are fire-and-forget: wait until the server has been quiet
  // (no new database request, email or WhatsApp) for a moment.
  async function quiet() {
    await sleep(60);
    let last = -1;
    for (let i = 0; i < 200; i++) {
      const seen = rig.emu.requests.length + rig.emails.length + wa.length;
      if (seen === last) return;
      last = seen;
      await sleep(50);
    }
  }
  let ipSeq = 0;
  function ip() {
    ipSeq += 1;
    const a = '10.48.' + Math.floor(ipSeq / 250) + '.' + (ipSeq % 250 + 1);
    return { headers: { 'x-real-ip': a, 'x-forwarded-for': a } };
  }

  return Object.assign({}, rig, {
    wa, refused, table, quiet, sleep, ip, t, w: t.__wp18,
    reset: function () { wa.length = 0; rig.emails.length = 0; rig.whatsapps.length = 0; },
    addDoctor: function (d) {
      const db = require('./au-fixtures.js').buildAuFixtureDb([d]);
      Object.keys(db).forEach(function (name) { db[name].forEach(function (row) { table(name).push(row); }); });
      table('gp_applications').push(rigLib.freshApplication(d));
      table('user_documents').push({ id: 'cv-' + d.userId, user_id: d.userId, document_key: 'career_cv', status: 'uploaded', file_name: 'cv.pdf', country_code: 'AU', created_at: SEED, updated_at: SEED });
      return d;
    },
    close: async function () { globalThis.fetch = inner; await rig.close(); }
  });
}

function normWa(rec, scrubList) {
  let s = JSON.stringify(rec).replace(UUID_RE, '<id>');
  (scrubList || []).forEach(function (pair) { s = s.split(pair[0]).join(pair[1]); });
  return JSON.parse(s);
}
function mailBrief(e) {
  return { to: [].concat((e && e.to) || []).join(','), subject: String((e && e.subject) || ''), text: String((e && e.text) || ''), html: String((e && e.html) || '') };
}

/**
 * One doctor, every WhatsApp touch.
 * @returns {Promise<{ wa: Object<string, object[]>, mail: Object<string, object[]>, results: object }>}
 */
async function doctorJourney(rig, d, opts) {
  const o = opts || {};
  const w = rig.w;
  const t = rig.t;
  const out = { wa: {}, mail: {}, results: {} };
  const appId = rig.appIdFor(d);
  const scrubList = [[rig.tokenFor(d), '<token>'], [String(d.userId), '<user>'], [String(appId), '<application>'], [digits(d.profile.phone), '<gp-phone>']];
  const isAu = !!(d.expected && d.expected.isAu);
  const cookie = { cookie: rig.gpCookie(d.email, d.userId) };
  const appRow = function () { return rig.table('gp_applications').filter(function (r) { return r.id === appId; })[0]; };
  const caseRow = function () { return rig.table('registration_cases').filter(function (r) { return r.user_id === d.userId; })[0] || null; };
  const first = d.profile.first_name;
  const full = first + ' ' + d.profile.last_name;

  async function step(label, fn) {
    rig.reset();
    let result = null;
    try { result = await fn(); } catch (e) { result = { threw: String(e && e.message) }; }
    await rig.quiet();
    out.wa[label] = rig.wa.map(function (r) { return normWa(r, scrubList); });
    out.mail[label] = rig.emails.map(mailBrief);
    out.results[label] = result;
    return result;
  }

  // No lead row is behind this doctor (the database stand-in matches an email
  // loosely, so a lead left by another journey would be picked up).
  rig.table('site_enquiries').length = 0;

  // 1. Staff put the doctor to the practice (the practice's WhatsApp).
  await step('intro', async function () {
    rig.resetApplication(d, isAu ? consent.buildConsentPatch({ source: 'doctor', application: { career_role_id: rigLib.ROLE_ID }, by: STAFF, now: SEED }) : {});
    rig.table('scheduled_calls').forEach(function (r) { if (r.application_id === appId) r.status = 'cancelled'; });
    const res = await rig.introduce(d, { decision: false });
    return { status: res.status, au_introduction: (res.json && res.json.au_introduction) || null };
  });

  // 2. The practice approves and offers times ("your interview times are ready").
  await step('timesReady', async function () {
    const res = await rig.post('/api/practice/application/decision',
      { token: rig.tokenFor(d), action: 'approve', windows: [THU_9_TO_11, FRI_5_TO_730], viewer_tz: 'Australia/Sydney' }, rig.ip());
    return { status: res.status };
  });

  // 3. The doctor books a time (confirmation to the doctor and to the practice).
  await step('booked', async function () {
    const tz = isAu ? 'Australia/Perth' : 'Europe/London';
    const slots = await rig.get('/api/career/interview/slots?applicationId=' + encodeURIComponent(appId) + '&viewer_tz=' + encodeURIComponent(tz), cookie);
    const list = (slots.json && slots.json.slots) || [];
    if (!list.length) return { status: slots.status, slots: 0 };
    const res = await rig.post('/api/career/interview/book', { applicationId: appId, slot_start_utc: list[list.length - 1].startUtc, viewer_tz: tz }, cookie);
    return { status: res.status, slots: list.length };
  });

  // 4. Staff re-send the confirmation (a free-text note plus the template).
  await step('resend', async function () {
    const res = await rig.post('/api/admin/ops/resend-interview-confirmation', { application_id: appId, force: true }, rig.superAdmin());
    return { status: res.status };
  });

  // 5. The practice adds more times later (the second "times are ready" site)
  //    and the one-shot booking invite.
  await step('bookingInvite', async function () {
    const a = appRow();
    Object.assign(a, { status: 'interview', booking_invite_sent_at: null, revealed: true });
    rig.table('scheduled_calls').forEach(function (r) { if (r.application_id === appId && r.status !== 'cancelled') Object.assign(r, { status: 'invited', scheduled_at: null }); });
    const r = await w.maybeSendInterviewBookingInvite(appId);
    return { ok: !!(r && r.ok), skipped: (r && r.skipped) || null };
  });

  // 6. Match invitation and "thanks for accepting".
  await step('matchInvitation', async function () {
    const row = Object.assign({}, appRow(), { origin: 'matched', matched_at: NOW, match_expires_at: '2026-11-26T00:00:00.000Z', match_outcome: null });
    const r = await w.sendMatchWhatsAppToGp(row);
    return { ok: !!(r && r.ok), skipped: (r && r.skipped) || null };
  });
  await step('matchAccepted', async function () {
    const r = await w.sendMatchAcceptedWhatsAppToGp(appRow());
    return { ok: !!(r && r.ok), via: (r && r.via) || null };
  });
  // The same with DoubleTick refusing the template: the free-text fallback.
  await step('matchAcceptedTemplateRefused', async function () {
    rig.refused.add('gp_link_app_match_accepted');
    rig.refused.add('gp_link_au_match_accepted');
    try {
      const r = await w.sendMatchAcceptedWhatsAppToGp(appRow());
      return { ok: !!(r && r.ok), via: (r && r.via) || null };
    } finally { rig.refused.clear(); }
  });

  // 7. The contract is ready to sign.
  await step('contractReady', async function () {
    const r = await w.notifyGpContractReady({ user_id: d.userId, application_id: appId, career_role_id: rigLib.ROLE_ID }, appRow(), { channels: ['email', 'whatsapp'] });
    return { ok: !!(r && r.ok), whatsapp: r && r.results && r.results.whatsapp ? { ok: !!r.results.whatsapp.ok, skipped: r.results.whatsapp.skipped || null } : null };
  });

  // 8. Staff release the account from review.
  await step('accountReleased', async function () {
    const r = await w.sendAccountReleasedNotifications(d.userId);
    return { email: !!(r && r.email && r.email.ok), whatsapp: !!(r && r.whatsapp && r.whatsapp.ok) };
  });

  // 9. A staff member is assigned to the case: every way that can happen.
  const c = caseRow();
  const clearWelcome = function () {
    const tl = rig.table('task_timeline');
    for (let i = tl.length - 1; i >= 0; i--) { if (c && tl[i].case_id === c.id && /RSO welcome/.test(String(tl[i].title || ''))) tl.splice(i, 1); }
  };
  const welcomed = function () { return rig.table('task_timeline').some(function (x) { return c && x.case_id === c.id && /RSO welcome/.test(String(x.title || '')); }); };
  if (c) {
    await step('assignAdminCase', async function () {
      clearWelcome(); Object.assign(c, { assigned_va: null, assigned_rso: null, status: 'active' });
      const res = await rig.put('/api/admin/case?id=' + encodeURIComponent(c.id), { assigned_va: RSO_A.user_id }, rig.superAdmin());
      return { status: res.status, welcomed: welcomed() };
    });
    await step('assignOpsCase', async function () {
      clearWelcome(); Object.assign(c, { assigned_va: null, assigned_rso: null });
      const res = await rig.put('/api/admin/ops/case?id=' + encodeURIComponent(c.id), { assigned_va: RSO_B.user_id }, rig.superAdmin());
      return { status: res.status, welcomed: welcomed() };
    });
    await step('assignBulk', async function () {
      clearWelcome();
      rig.table('registration_cases').forEach(function (x) { if (x.id !== c.id && x.assigned_va === RSO_A.user_id) { x.assigned_va = null; x.assigned_rso = null; } });
      Object.assign(c, { assigned_va: RSO_A.user_id, assigned_rso: RSO_A.user_id, status: 'active' });
      const res = await rig.post('/api/admin/rso/bulk-reassign', { fromRsoId: RSO_A.user_id, toRsoId: RSO_B.user_id }, rig.superAdmin());
      return { status: res.status, moved: (res.json && res.json.moved) || null, welcomed: welcomed() };
    });
    await step('assignResync', async function () {
      clearWelcome(); Object.assign(c, { assigned_va: RSO_A.user_id, assigned_rso: RSO_A.user_id });
      const res = await rig.post('/api/admin/ops/resync-dt-assignment', { case_id: c.id }, rig.superAdmin());
      return { status: res.status, welcome: (res.json && res.json.welcome) ? { ok: !!res.json.welcome.ok, skipped: !!res.json.welcome.skipped } : null, welcomed: welcomed() };
    });
    await step('assignDirect', async function () {
      clearWelcome();
      const r = await w.ensureRsoWelcomeSent({ caseId: c.id, gpUserId: d.userId, gpPhone: d.profile.phone, rsoUserId: RSO_A.user_id });
      return { ok: !!(r && r.ok), skipped: !!(r && r.skipped), welcomed: welcomed() };
    });
    // No user id handed to the sender (it must still know whose case it is).
    await step('assignDirectNoUserId', async function () {
      clearWelcome();
      const r = await w.ensureRsoWelcomeSent({ caseId: c.id, gpUserId: '', gpPhone: d.profile.phone, rsoUserId: RSO_A.user_id });
      return { ok: !!(r && r.ok), skipped: !!(r && r.skipped), welcomed: welcomed() };
    });
    clearWelcome();
  }

  // 10. The stage messages (MyIntealth, AMC, AHPRA, visa): what a state write
  //     sets off.
  await step('stageMessages', async function () {
    if (c) {
      const tl = rig.table('task_timeline');
      for (let i = tl.length - 1; i >= 0; i--) { if (tl[i].case_id === c.id && /WhatsApp template sent/.test(String(tl[i].title || ''))) tl.splice(i, 1); }
    }
    await t.processRegistrationTaskAutomationForTest(d.userId, d.email, {}, STATE_FLAGS);
    return null;
  });
  // (Guard only) the same write with the doctor's career marked secured: the
  // "AHPRA step unlocked" message and the practice-pack cascade hang off it.
  if (o.guardExtras) {
    await step('careerSecuredState', async function () {
      const secured = { career_secured: true, applications: [{ id: appId, status: 'placement_secured', isPlacementSecured: true, placement: { practiceName: rigLib.PRACTICE_NAME } }] };
      await t.processRegistrationTaskAutomationForTest(d.userId, d.email, STATE_FLAGS, Object.assign({}, STATE_FLAGS, { gp_career_state: secured }));
      return null;
    });
  }
  for (const stage of ['myintealth', 'amc', 'ahpra', 'visa', 'ahpra_docs_complete']) {
    // The stage sender itself takes a phone number, not a doctor: it is only
    // ever reached through the automation above. Recorded for the overseas
    // snapshot only.
    if (o.rawStageSender) {
      await step('stageSender:' + stage, async function () {
        const r = await w.sendDoubleTickTemplate(d.profile.phone, stage, first, stage === 'visa' ? ['https://app.gplink-test.local/pages/visa'] : (stage === 'ahpra_docs_complete' ? ['https://app.gplink-test.local/pages/ahpra.html'] : undefined));
        return { ok: !!(r && r.ok) };
      });
    }
  }

  // 11. A call booked with a staff member (not the CEO): the day-before and
  //     "starting" reminders. And a call with the CEO booked by this doctor
  //     with no lead row behind it.
  for (const track of [['registration', 'rso'], ['consult', 'ceo']]) {
    for (const when of [['dayBefore', 20 * 3600000], ['starting', 4 * 60000]]) {
      await step('callReminder:' + track[0] + ':' + when[0], async function () {
        const calls = rig.table('scheduled_calls');
        for (let i = calls.length - 1; i >= 0; i--) { if (String(calls[i].id).indexOf('wp18-call-') === 0) calls.splice(i, 1); }
        const at = new Date(Date.now() + when[1]).toISOString();
        calls.push({
          id: 'wp18-call-' + track[1] + '-' + String(d.userId).slice(-6), user_id: d.userId, invitee_email: d.email, meeting_kind: 'consultation', host_kind: track[1],
          status: 'booked', scheduled_at: at, booked_at: new Date(Date.now() - 3 * 86400000).toISOString(), zoom_join_url: 'https://zoom.us/j/0000000000',
          notification_channels: {}, invitee_notes: '', timezone: isAu ? 'Australia/Perth' : 'Europe/London', stage: track[1] === 'rso' ? 'career' : null
        });
        const r = await w.runConsultCallReminders(Date.now(), track[0]);
        for (let i = calls.length - 1; i >= 0; i--) { if (String(calls[i].id).indexOf('wp18-call-') === 0) calls.splice(i, 1); }
        return { sent: r && r.sent, emailsSent: (r && r.emailsSent) || 0 };
      });
    }
  }

  // 12. The drop-off nudges, straight through their sender (the scheduled
  //     jobs leave Australian doctors out before they get this far).
  const dropKeys = Object.keys(dropoffNudges.WA_TEMPLATES || {}).sort();
  for (const key of dropKeys) {
    await step('dropoff:' + key, async function () {
      const log = rig.table('gp_nudge_log');
      for (let i = log.length - 1; i >= 0; i--) { if (log[i].user_id === d.userId && log[i].nudge_key === key) log.splice(i, 1); }
      const r = await w.maybeSendDropoffWa(d.userId, full, key);
      return { ok: !!(r && r.ok), skipped: (r && r.skipped) || null };
    });
  }
  for (const tpl of ['gp_link_onboarding_step_start', 'gp_link_onboarding_step_move', 'gp_link_onboarding_step_register', 'gp_link_onboarding_step_id']) {
    await step('dropoffStep:' + tpl, async function () {
      const key = 'wp18_' + tpl;
      const log = rig.table('gp_nudge_log');
      for (let i = log.length - 1; i >= 0; i--) { if (log[i].user_id === d.userId && log[i].nudge_key === key) log.splice(i, 1); }
      const r = await w.maybeSendDropoffWa(d.userId, full, key, { templateName: tpl, buttonParam: 2 });
      return { ok: !!(r && r.ok), skipped: (r && r.skipped) || null };
    });
  }

  // (The "send us your passports" request and its reminder are staff actions on
  // a registration-granted task: tests/au-wp14-*.test.js and
  // tests/au-wp11-staff-actions-server.test.js hold both the overseas snapshot
  // and the refusal for an Australian case.)
  return out;
}

/** A consult-funnel lead row as the database holds it. */
function leadRow(key, over) {
  const who = {
    uk: { name: 'Dr Test Ukgp', email: 'uk.lead.wp18@gplink-test.local', phone: '+447700900411', country: 'uk' },
    au: { name: 'Dr Test Auvr', email: 'au.lead.wp18@gplink-test.local', phone: '+61400000411', country: 'au' }
  }[key];
  const consult = Object.assign({
    token: 'TOK' + key.toUpperCase() + 'WP18', qualified: true, is_gp: true, country: who.country, country_raw: who.country, country_source: 'question',
    call_booked: false, nudges: []
  }, key === 'au' ? { segment: 'au_vr', au_state: 'WA', ahpra_registered: true } : {}, (over && over.consult) || {});
  return {
    id: fakeUuid('e', key === 'au' ? '181' : '182'), name: who.name, email: who.email, phone: who.phone, source: 'consult_form',
    created_at: new Date(Date.parse(NOW) - 3 * 3600000).toISOString(), metadata: { consult: consult }
  };
}

/**
 * One lead, every consult-funnel WhatsApp the app has a template for.
 * @returns {Promise<{ wa: Object<string, object[]>, mail: Object<string, object[]> }>}
 */
async function leadJourney(rig, seed) {
  const w = rig.w;
  const out = { wa: {}, mail: {}, results: {} };
  const rows = rig.table('site_enquiries');
  const put = function (consultOver) {
    for (let i = rows.length - 1; i >= 0; i--) { if (rows[i].id === seed.id) rows.splice(i, 1); }
    const fresh = JSON.parse(JSON.stringify(seed));
    fresh.metadata.consult = Object.assign({}, fresh.metadata.consult, consultOver || {});
    rows.push(fresh);
    return JSON.parse(JSON.stringify(fresh));
  };
  const scrubList = [[digits(seed.phone), '<lead-phone>'], [encodeURIComponent(seed.email), '<lead-email>']];
  async function step(label, fn) {
    rig.reset();
    let result = null;
    try { result = await fn(); } catch (e) { result = { threw: String(e && e.message) }; }
    await rig.quiet();
    out.wa[label] = rig.wa.map(function (r) { return normWa(r, scrubList); });
    out.mail[label] = rig.emails.map(mailBrief);
    out.results[label] = result;
  }
  const callAt = new Date(Date.parse(NOW) + 3 * 86400000 + 1.5 * 3600000).toISOString();
  const KINDS = Object.keys(consultWhatsapp.CONSULT_WA_TEMPLATES).filter(function (k) { return k !== 'owner_lead_alert' && k.indexOf('reg_call') !== 0; });
  for (const kind of KINDS) {
    await step('kind:' + kind, async function () {
      const over = { wa: {}, wa_skipped: {} };
      if (/^call_|post_call/.test(kind)) Object.assign(over, { call_booked: true, call_booked_at: NOW, call_at: callAt });
      if (kind === 'post_call_onboard') Object.assign(over, { call_at: new Date(Date.parse(NOW) - 3600000).toISOString(), call_completed_at: NOW, call_attended: true, call_attendance_source: 'zoom_participants' });
      if (kind === 'signed_up' || kind === 'onboarding_incomplete') Object.assign(over, { stopped: 'signed_up' });
      const row = put(over);
      const r = await w.maybeSendConsultWa(row, kind, { callAtIso: callAt, joinUrl: 'https://zoom.us/j/0000000000' });
      return { ok: !!(r && r.ok), reason: (r && r.reason) || null };
    });
  }
  // A missed call, two hours ago: the rescue (email and WhatsApp).
  await step('missedCall', async function () {
    const missedAt = new Date(Date.now() - 2 * 3600000).toISOString();
    const row = put({ call_booked: true, call_booked_at: new Date(Date.now() - 3 * 86400000).toISOString(), call_at: missedAt, call_attended: false,
      no_show: { call_at: missedAt, detected_at: new Date(Date.now() - 3600000).toISOString(), via: 'sweep', ring: 'done' } });
    const wrote = await rig.t.maybeRunConsultNoShowRescue(row);
    return { wrote: !!wrote };
  });
  // The reminders the every-five-minutes job sends for a booked call.
  for (const when of [['dayBefore', 20 * 3600000], ['hourBefore', 55 * 60000], ['starting', 4 * 60000]]) {
    await step('callReminder:' + when[0], async function () {
      const at = new Date(Date.now() + when[1]).toISOString();
      put({ call_booked: true, call_booked_at: new Date(Date.now() - 3 * 86400000).toISOString(), call_at: at });
      const calls = rig.table('scheduled_calls');
      for (let i = calls.length - 1; i >= 0; i--) { if (String(calls[i].id).indexOf('wp18-lead-call') === 0) calls.splice(i, 1); }
      calls.push({
        id: 'wp18-lead-call-' + seed.id.slice(-4), user_id: null, invitee_email: seed.email, meeting_kind: 'consultation', host_kind: 'ceo', status: 'booked',
        scheduled_at: at, booked_at: new Date(Date.now() - 3 * 86400000).toISOString(), zoom_join_url: 'https://zoom.us/j/0000000000',
        notification_channels: {}, invitee_notes: '', timezone: seed.metadata.consult.country === 'au' ? 'Australia/Perth' : 'Europe/London'
      });
      const r = await w.runConsultCallReminders(Date.now(), 'consult');
      for (let i = calls.length - 1; i >= 0; i--) { if (String(calls[i].id).indexOf('wp18-lead-call') === 0) calls.splice(i, 1); }
      return { sent: r && r.sent, emailsSent: (r && r.emailsSent) || 0 };
    });
  }
  return out;
}

module.exports = {
  NOW, SEED, RSO_A, RSO_B, THU_9_TO_11, FRI_5_TO_730, STATE_FLAGS,
  overseasDoctor, auDoctor, bootWhatsAppRig, doctorJourney, leadRow, leadJourney, normWa, digits
};

'use strict';

/**
 * WP-17 overseas parity: every existing message this package's code touches,
 * as a UK, Irish or New Zealand doctor (nothing recorded: an overseas doctor)
 * and their practices receive it.
 *
 *   overseasTables()             the fixture database (three finished doctors,
 *                                three part-way through onboarding)
 *   computeServerParity(h)       drives the REAL server and records what it
 *                                hands Resend (from, to, subject, html, text,
 *                                headers) and what it answers
 *
 * tests/fixtures/au-wp17-overseas-parity.snapshot.json was written by this
 * file on the tree BEFORE WP-17 changed any behaviour (only the `__wp17` test
 * hooks existed). Never regenerate it to make a test pass.
 */

const { buildAuDoctor, buildAuFixtureDb } = require('./au-fixtures.js');
const practicePipeline = require('../../lib/practice-pipeline.js');
const onboardingNudge = require('../../lib/onboarding-nudge.js');
const dropoffNudges = require('../../lib/dropoff-nudges.js');

const PEOPLE = [
  { key: 'uk', n: 'c1', first: 'Testuk', last: 'Ukgp', email: 'uk.wp17.test@gplink-test.local', country: 'United Kingdom', code: 'GB' },
  { key: 'ie', n: 'c2', first: 'Testie', last: 'Iegp', email: 'ie.wp17.test@gplink-test.local', country: 'Ireland', code: 'IE' },
  { key: 'nz', n: 'c3', first: 'Testnz', last: 'Nzgp', email: 'nz.wp17.test@gplink-test.local', country: 'New Zealand', code: 'NZ' }
];

function doctorFor(p, incomplete) {
  const d = buildAuDoctor('overseas_null', {
    idSuffix: p.n + (incomplete ? 'i' : ''),
    profile: {
      first_name: p.first, last_name: p.last, registration_country: p.country, qualification_country: p.code,
      onboarding_completed_at: incomplete ? null : '2026-10-02T00:00:00.000Z'
    },
    state: incomplete
      ? { gp_onboarding_complete: false, gp_onboarding: { country: p.code, currentStep: 2 } }
      : {}
  });
  d.profile.email = (incomplete ? 'part.' : '') + p.email;
  d.email = d.profile.email;
  return d;
}

function overseasDoctors() {
  const done = {};
  const part = {};
  PEOPLE.forEach(function (p) { done[p.key] = doctorFor(p, false); part[p.key] = doctorFor(p, true); });
  return { done, part };
}

function overseasTables(nowMs) {
  const docs = overseasDoctors();
  const list = [];
  PEOPLE.forEach(function (p) { list.push(docs.done[p.key]); list.push(docs.part[p.key]); });
  const tables = buildAuFixtureDb(list);
  // The part-way doctors have a reminder row two hours old, so the hourly job
  // owes each of them the first reminder.
  const anchor = new Date((nowMs || Date.now()) - 2 * 60 * 60 * 1000).toISOString();
  tables.onboarding_reminders = PEOPLE.map(function (p, i) {
    const d = docs.part[p.key];
    return { id: 'rem-' + p.key, user_id: d.userId, email: d.email, name: p.first + ' ' + p.last, anchor_at: anchor, last_step: 2, steps_sent: [], unsubscribed: false, stopped: false, created_at: anchor, updated_at: anchor, _i: i };
  });
  // A part-way doctor's case does not exist yet.
  tables.registration_cases = tables.registration_cases.filter(function (c) {
    return !PEOPLE.some(function (p) { return docs.part[p.key].userId === c.user_id; });
  });
  ['gp_nudge_log', 'gp_applications', 'user_roles', 'scheduled_calls', 'user_nudges', 'nudge_chat_messages', 'email_templates',
    'registration_tasks', 'task_timeline', 'career_interviews', 'support_tickets', 'placements', 'notification_preferences',
    'email_suppression', 'site_enquiries'].forEach(function (t) { if (!tables[t]) tables[t] = []; });
  return tables;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Wait until the recording stub has been quiet for a moment (several senders
// are fire-and-forget by design).
async function settle(h) {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    await sleep(40);
    if (h.emails.length === last) return;
    last = h.emails.length;
  }
}

function mailShape(call) {
  const b = (call && call.body) || {};
  return { from: b.from || null, to: b.to || null, reply_to: b.reply_to || null, subject: b.subject || null, html: b.html || null, text: b.text || null, headers: b.headers || null };
}

// The weekly digest names the week it covers; nothing else in any captured
// message depends on the day the test runs.
function stripWeek(value) {
  return JSON.parse(JSON.stringify(value).replace(/20\d\d-\d\d-\d\d/g, 'YYYY-MM-DD'));
}

// A staff nudge links to its own chat thread, whose id is random.
function stripChatId(value) {
  return JSON.parse(JSON.stringify(value).replace(/#chat-[0-9a-f-]{36}/g, '#chat-ID'));
}

async function capture(h, fn) {
  h.reset();
  const result = await fn();
  await settle(h);
  return { result: result === undefined ? null : result, emails: h.emails.map(mailShape), whatsapp: h.dt.map(function (c) { return { path: c.path, body: c.body }; }) };
}

function pureParity() {
  const out = { onboardingCopy: [], onboardingLabels: onboardingNudge.ONBOARDING_STEP_LABELS.slice(), intake: {}, dropoffKeys: Object.keys(dropoffNudges).sort() };
  for (let i = 0; i < onboardingNudge.NUDGE_SCHEDULE_MS.length; i++) {
    out.onboardingCopy.push(onboardingNudge.copyForStep(i, { name: 'Testuk', stepsLeft: 3 }));
  }
  out.onboardingSchedule = onboardingNudge.NUDGE_SCHEDULE_MS.slice();
  out.intake = practicePipeline.buildIntakeEmailCopy({ practiceName: 'Test Metro Practice (FAKE)', contactName: 'Pat Manager', intakeUrl: 'https://app.gplink-test.local/intake/TESTTOKEN' });
  return out;
}

/**
 * @param {object} h  a booted harness (tests/helpers/au-wp16-harness.js, supabase mode, overseasTables())
 * @returns {Promise<object>} everything, JSON-serialisable
 */
async function computeServerParity(h) {
  const w = h.testUtils.__wp17;
  const docs = overseasDoctors();
  const out = { pure: pureParity(), people: {} };

  for (const p of PEOPLE) {
    const d = docs.done[p.key];
    const part = docs.part[p.key];
    const o = {};
    o.welcome = await capture(h, function () { return w.sendWelcomeEmail(d.userId); });
    o.profileComplete = await capture(h, function () { return w.sendOnboardingCompleteEmail(d.userId); });
    o.onboardingNudges = [];
    for (let i = 0; i < 7; i++) {
      o.onboardingNudges.push(await capture(h, function () {
        return h.testUtils.sendOnboardingNudgeEmail({ user_id: part.userId, email: part.email, name: p.first + ' ' + p.last, last_step: 2 }, i, 3);
      }));
    }
    o.stalled = {};
    for (const stage of ['myintealth', 'amc', 'career', 'ahpra', 'visa', 'pbs']) {
      o.stalled[stage] = await capture(h, function () { return w.sendStalledReminderEmail(d.userId, stage); });
    }
    o.stalledPosition = await capture(h, function () {
      return h.testUtils.sendStalledNudgeForPositionForTest({ userId: d.userId, phase: 'registration', stage: 'amc', substage: null });
    });
    o.stalledOnboardingPosition = await capture(h, function () {
      return h.testUtils.sendStalledNudgeForPositionForTest({ userId: part.userId, email: part.email, name: p.first + ' ' + p.last, phase: 'onboarding', step: 2, stepLabel: 'Country & register number' });
    });
    o.documentApproved = await capture(h, function () { return w.sendDocumentApprovedEmail(d.userId, 'Primary Medical Degree'); });
    o.documentRevision = await capture(h, function () { return w.sendDocumentRevisionEmail(d.userId, 'Offer / Contract', 'Test Metro Practice (FAKE)'); });
    const role = { id: 'role-' + p.key, location_city: 'Ballarat', location_state: 'VIC', practice_name: 'Test Metro Practice (FAKE)', title: 'General Practitioner' };
    o.applicationCold = await capture(h, function () { w.notifyGpApplicationSubmitted(d.userId, d.email, role, d.caseId, 'Dr ' + p.first + ' ' + p.last, {}); });
    o.applicationMatched = await capture(h, function () { w.notifyGpApplicationSubmitted(d.userId, d.email, role, d.caseId, 'Dr ' + p.first + ' ' + p.last, { matched: true }); });
    o.matchAcceptedWhatsAppText = w.buildMatchAcceptedWhatsAppText(p.first, 'Test Metro Practice (FAKE)');
    o.staffNudge = stripChatId(await capture(h, async function () {
      const staff = h.rso();
      const r = await h.post('/api/admin/va/nudge', { user_id: d.userId }, staff);
      const n = (r.json && r.json.nudge) || {};
      return { status: r.status, title: n.title || null, message: n.message || null, stage: n.stage || null, channels: n.delivered_channels || null, email_sent: r.json && r.json.email_sent };
    }));
    out.people[p.key] = o;
  }

  out.nudgeDefaults = {};
  [['myintealth', 'create_account'], ['myintealth', 'account_establishment'], ['myintealth', 'upload_qualifications'],
    ['myintealth', 'verification_issued'], ['myintealth', null], ['amc', 'create_portfolio'], ['amc', 'upload_credentials'],
    ['amc', 'waiting_verification'], ['amc', null], ['career', null], ['ahpra', null], ['visa', null], ['pbs', null],
    ['commencement', null], [null, null]].forEach(function (pair) {
    out.nudgeDefaults[String(pair[0]) + ':' + String(pair[1])] = w.resolveNudgeTemplate(pair[0], pair[1]);
  });

  out.onboardingCron = await capture(h, async function () {
    const r = await h.cron('/api/cron/onboarding-nudge');
    const j = r.json || {};
    return { status: r.status, scanned: j.scanned, created: j.created, sent: j.sent, wa_sent: j.wa_sent, reset: j.reset, stopped: j.stopped, skipped: j.skipped };
  });
  out.onboardingCron.emails.sort(function (a, b) { return JSON.stringify(a.to) < JSON.stringify(b.to) ? -1 : 1; });

  const tpl = await h.get('/api/admin/email-templates', h.rso());
  out.emailTemplates = { status: tpl.status, body: tpl.json };

  out.ownerDigest = stripWeek(await capture(h, async function () {
    const r = await w.sendOwnerDigestEmail({ force: true });
    return { ok: !!(r && r.ok), sent: r && r.sent };
  }));
  return out;
}

module.exports = { PEOPLE, overseasDoctors, overseasTables, computeServerParity, pureParity };

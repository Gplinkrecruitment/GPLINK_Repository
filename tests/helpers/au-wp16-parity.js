'use strict';

/**
 * WP-16 overseas parity: every message the lead and consult funnel sends a UK,
 * Irish or New Zealand doctor, and when it sends it.
 *
 * computeLibParity(sw)        the pure builders and the send schedule, with the
 *                             switch passed in where a function takes it
 * computeServerParity(h)      the real server: the email bodies Resend is
 *                             handed (from, subject, html, text, headers) and
 *                             the WhatsApp template + placeholders DoubleTick
 *                             is handed, for the same doctors
 *
 * tests/fixtures/au-wp16-overseas-parity.snapshot.json was written by this
 * file on the tree BEFORE WP-16 changed any code. Never regenerate it to make
 * a test pass.
 */

const consultLead = require('../../lib/consult-lead.js');
const bookerNudgeEmail = require('../../lib/booker-nudge-email.js');
const consultReminders = require('../../lib/consult-reminders.js');
const consultNoShow = require('../../lib/consult-noshow.js');
const consultWhatsapp = require('../../lib/consult-whatsapp.js');

const M = 60 * 1000;
const H = 60 * M;
const D = 24 * H;

const PEOPLE = [
  { key: 'uk', name: 'Dr Test Ukgp', email: 'uk.gp.test@gplink-test.local', phone: '+447700900111' },
  { key: 'ie', name: 'Dr Test Iegp', email: 'ie.gp.test@gplink-test.local', phone: '+353870000111' },
  { key: 'nz', name: 'Dr Test Nzgp', email: 'nz.gp.test@gplink-test.local', phone: '+64210000111' }
];

// A fixed instant for everything pure: Tuesday 12 January 2027, 09:00 UTC.
const T0 = Date.parse('2027-01-12T09:00:00Z');
const CALL_AT = '2027-01-14T10:30:00Z';

function consultFor(key, over) {
  return Object.assign({
    token: 'TOK' + key.toUpperCase(), qualified: true, is_gp: null, country: key,
    call_booked: false, nudges: [], country_raw: key, country_source: 'question'
  }, over || {});
}

// Walk one lead through time and record every step nextConsultNudge hands
// out, marking it sent the moment it is due (as the cron does).
function walkSchedule(consult, sw, opts) {
  const o = opts || {};
  const out = [];
  let c = JSON.parse(JSON.stringify(consult));
  const ticks = [];
  for (let t = 0; t <= 2 * D; t += 5 * M) ticks.push(t);
  for (let t = 2 * D + H; t <= 30 * D; t += H) ticks.push(t);
  ticks.forEach(function (t) {
    const nowMs = T0 + t;
    if (o.bookAt != null && t >= o.bookAt && !c.call_booked) {
      c = Object.assign({}, c, { call_booked: true, call_booked_at: new Date(T0 + o.bookAt).toISOString(), call_at: new Date(T0 + o.callAt).toISOString() });
    }
    if (o.completeAt != null && t >= o.completeAt && !c.call_completed_at) {
      c = Object.assign({}, c, { call_completed_at: new Date(T0 + o.completeAt).toISOString(), call_attended: o.attended !== false });
    }
    const due = consultLead.nextConsultNudge({
      consult: c, createdAtMs: T0, nowMs: nowMs,
      callAtMs: c.call_at ? Date.parse(c.call_at) : NaN,
      callCompletedMs: consultLead.consultCallCompletedForDripMs(c),
      auPathwayEnabled: sw
    });
    if (!due) return;
    out.push({ afterMinutes: Math.round(t / M), seq: due.seq, step: due.step, email: due.email, wa: due.wa });
    c = Object.assign({}, c, { nudges: (c.nudges || []).concat([{ seq: due.seq, step: due.step, sent_at: new Date(nowMs).toISOString(), email: 'sent' }]) });
  });
  return out;
}

function computeLibParity(sw) {
  const out = { copy: {}, schedule: {} };
  PEOPLE.forEach(function (p) {
    const displayName = consultLead.consultDisplayName(p.name);
    const first = p.name.split(/\s+/)[0];
    const bookUrl = 'https://app.gplink-test.local/start?lead=TOK' + p.key.toUpperCase() + '#book';
    const signupUrl = 'https://app.gplink-test.local/pages/signin?signup=1&email=' + encodeURIComponent(p.email);
    const tz = consultReminders.consultLeadTimeZone(consultFor(p.key), p.phone, { auPathwayEnabled: sw });
    const copy = { timeZone: tz };
    [['not_booked', 0], ['not_booked', 1], ['not_booked', 2], ['booked_no_signup', 0], ['booked_no_signup', 1]].forEach(function (pair) {
      copy['consultNudgeCopy:' + pair[0] + ':' + pair[1]] = consultLead.consultNudgeCopy(pair[0], pair[1], { displayName, bookUrl, signupUrl });
    });
    for (let step = 0; step < 5; step++) {
      copy['bookerNudge:' + step] = bookerNudgeEmail.buildBookerNudgeEmail(step, { firstName: first, displayName, signupUrl, unsubscribeUrl: 'https://app.gplink-test.local/unsub' });
    }
    ['email_h24', 'email_h1'].forEach(function (w) {
      copy['reminderEmail:' + w] = consultReminders.buildConsultReminderEmail(w, { name: p.name, callAtIso: CALL_AT, timeZone: tz, joinUrl: 'https://zoom.example/j/123' });
    });
    copy.callTime = consultReminders.formatLeadCallTime(CALL_AT, tz);
    copy.callClock = consultReminders.formatLeadCallClock(CALL_AT, tz);
    copy.noShowEmail = consultNoShow.noShowEmailCopy({ displayName, whenText: consultNoShow.slotInWords(CALL_AT, tz) });
    const wa = {};
    Object.keys(consultWhatsapp.CONSULT_WA_TEMPLATES).forEach(function (kind) {
      if (kind === 'owner_lead_alert') return;
      wa[kind] = consultWhatsapp.buildConsultWaMessage(kind, {
        name: p.name, callAtIso: CALL_AT, whenText: consultReminders.formatLeadCallTime(CALL_AT, tz),
        bookUrl, joinUrl: 'https://zoom.example/j/123', signupUrl
      });
    });
    copy.whatsapp = wa;
    out.copy[p.key] = copy;

    const sched = {};
    sched.neverBooks = walkSchedule(consultFor(p.key), sw, {});
    sched.booksThenAttends = walkSchedule(consultFor(p.key), sw, { bookAt: 30 * M, callAt: 2 * D, completeAt: 2 * D + 30 * M, attended: true });
    sched.booksThenMisses = walkSchedule(consultFor(p.key), sw, { bookAt: 30 * M, callAt: 2 * D, completeAt: 2 * D + 30 * M, attended: false });
    // The missed-consultation rescue, minute by minute around the slot.
    const missedRow = {
      email: p.email, phone: p.phone,
      metadata: { consult: consultFor(p.key, { call_booked: true, call_at: CALL_AT, no_show: { call_at: CALL_AT, detected_at: CALL_AT, via: 'sweep', ring: 'pending' } }) }
    };
    sched.noShowRescue = [0, 30, 59, 60, 61, 600, 36 * 60, 36 * 60 + 1].map(function (min) {
      const d = consultNoShow.noShowRescueDecision({ row: missedRow, nowMs: Date.parse(CALL_AT) + min * M, hasPhone: true, auPathwayEnabled: sw });
      return { minutesAfterSlot: min, email: d.email, wa: d.wa, reason: d.reason };
    });
    // Email reminders by time to the call (booked two days earlier).
    sched.emailReminders = [25 * 60, 24 * 60, 23 * 60, 71, 70, 60, 31, 30, 10].map(function (min) {
      const d = consultReminders.consultCallEmailReminderDecision({
        scheduledAt: CALL_AT, bookedAt: new Date(Date.parse(CALL_AT) - 2 * D).toISOString(), nowMs: Date.parse(CALL_AT) - min * M, markers: {}
      });
      return { minutesBeforeCall: min, action: d.action, window: d.window || null, reason: d.reason || null };
    });
    sched.waReminders = [25 * 60, 24 * 60, 23 * 60, 71, 70, 60, 31, 30, 10, 5, 4, -2, -4].map(function (min) {
      const d = consultWhatsapp.consultCallReminderDecision({
        scheduledAt: CALL_AT, bookedAt: new Date(Date.parse(CALL_AT) - 2 * D).toISOString(), nowMs: Date.parse(CALL_AT) - min * M, markers: {},
        kinds: consultWhatsapp.CONSULT_CALL_REMINDER_KIND, soonMs: consultWhatsapp.CONSULT_CALL_STARTING_SOON_MS,
        lateGraceMs: consultWhatsapp.CONSULT_CALL_STARTING_LATE_GRACE_MS
      });
      return { minutesBeforeCall: min, action: d.action, window: d.window || null, kind: d.kind || null, reason: d.reason || null };
    });
    const owed = consultFor(p.key, { nudges: [{ seq: 'not_booked', step: 1, sent_at: new Date(T0).toISOString(), email: 'sent' }] });
    sched.waOwed = consultLead.pendingConsultWaKinds(owed, T0 + H, { auPathwayEnabled: sw });
    out.schedule[p.key] = sched;
  });
  return out;
}

// ── The real server ────────────────────────────────────────────────────────
function rowFor(p, tag, consultOver, rowOver) {
  return Object.assign({
    id: 'wp16-parity-' + p.key + '-' + tag,
    created_at: new Date(Date.now() - 30 * M).toISOString(),
    kind: 'gp', name: p.name, email: p.email, phone: p.phone,
    practice_name: null, state: p.key, message: null, status: 'new',
    metadata: { source: 'meta_lead_ad', consult: consultFor(p.key, consultOver) }
  }, rowOver || {});
}

function emailShape(body) {
  if (!body) return null;
  return { from: body.from, to: body.to, subject: body.subject, html: body.html, text: body.text, headers: body.headers || null, reply_to: body.reply_to || null };
}

async function computeServerParity(h, tag) {
  const t = h.testUtils;
  const out = {};
  for (const p of PEOPLE) {
    const mine = {};
    const lastEmail = function () { const all = h.emailsTo(p.email); return emailShape(all[all.length - 1]); };
    const lastWa = function () { const all = h.waTo(p.phone); return all.length ? all[all.length - 1] : null; };

    // The booking-link emails.
    let row = rowFor(p, tag + '-link');
    h.seed([row]); h.reset();
    await t.sendConsultMagicLinkEmail(row);
    mine.magicLink = lastEmail();
    h.reset();
    await t.sendConsultGenericBookingLinkEmail(row);
    mine.genericLink = lastEmail();

    // The three notes before a booking, and the five after one.
    for (const pair of [['not_booked', 0], ['not_booked', 1], ['not_booked', 2], ['booked_no_signup', 0], ['booked_no_signup', 1], ['booked_no_signup', 2], ['booked_no_signup', 3], ['booked_no_signup', 4]]) {
      h.reset();
      await t.sendConsultNudgeEmail(row, { seq: pair[0], step: pair[1] });
      mine['nudge:' + pair[0] + ':' + pair[1]] = lastEmail();
    }

    // Every WhatsApp the funnel can send a lead.
    const waRows = {
      hello_5m: {}, check_in_1h: {}, day_after_24h: {},
      call_booked: { call_booked: true, call_at: CALL_AT },
      signed_up: { stopped: 'signed_up' },
      onboarding_incomplete: { stopped: 'signed_up' },
      post_call_onboard: { call_booked: true, call_at: CALL_AT, call_completed_at: CALL_AT, call_attended: true, call_attendance_source: 'zoom_participants' }
    };
    mine.whatsapp = {};
    for (const kind of Object.keys(waRows)) {
      row = rowFor(p, tag + '-wa-' + kind, waRows[kind]);
      h.seed([row]); h.reset();
      const res = await t.maybeSendConsultWa(row, kind);
      mine.whatsapp[kind] = { ok: !!(res && res.ok), content: lastWa() };
    }

    // The missed-consultation rescue: an hour and a half after the slot.
    const slot = new Date(Math.floor((Date.now() - 90 * M) / M) * M).toISOString();
    row = rowFor(p, tag + '-missed', {
      call_booked: true, call_booked_at: new Date(Date.parse(slot) - D).toISOString(), call_at: slot,
      no_show: { call_at: slot, detected_at: slot, via: 'sweep', ring: 'pending' }
    }, { created_at: new Date(Date.parse(slot) - 2 * D).toISOString() });
    h.seed([row]); h.reset();
    await t.maybeRunConsultNoShowRescue(row);
    const tz = consultReminders.consultLeadTimeZone(row.metadata.consult, p.phone, { auPathwayEnabled: false });
    const when = consultNoShow.slotInWords(slot, tz);
    const rescue = lastEmail();
    if (rescue) {
      ['subject', 'html', 'text'].forEach(function (k) { rescue[k] = String(rescue[k] || '').split(when).join('{{WHEN}}'); });
    }
    mine.noShowEmail = rescue;
    mine.noShowWhatsApp = lastWa();
    out[p.key] = mine;
  }
  return out;
}

module.exports = { PEOPLE, T0, CALL_AT, consultFor, rowFor, walkSchedule, computeLibParity, computeServerParity, emailShape };

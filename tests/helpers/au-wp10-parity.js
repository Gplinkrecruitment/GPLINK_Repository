'use strict';
// WP-10 (Australian GP build): the overseas parity snapshot.
//
// computeOverseasParitySnapshot() renders, for UK / Irish / New Zealand /
// unknown-country leads and doctors, every zone, calling window, interview
// slot and time label the PURE libraries compute. It was run on the tree
// BEFORE WP-10 changed any code and its output committed as
// tests/fixtures/au-wp10-overseas-parity.snapshot.json. The test
// (tests/au-wp10-overseas-parity.test.js) recomputes it with the switch on and
// with it off and demands equality with that file: an overseas doctor's zones,
// windows and labels are exactly what they were.
//
// Do NOT regenerate the snapshot to make a failing test pass. A difference
// means an overseas doctor would now be told a different time.

const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
function lib(name) { return require(path.join(ROOT, 'lib', name)); }

// Instants on both sides of every daylight-saving change that matters here
// (UK/IE: last Sunday of March and October; NZ: late September and early
// April; NSW: first Sunday of October and April).
const INSTANTS = [
  '2026-11-24T09:30:00.000Z',
  '2026-11-27T20:00:00.000Z',
  '2026-12-25T00:15:00.000Z',
  '2027-01-15T22:00:00.000Z',
  '2027-03-27T10:00:00.000Z',
  '2027-03-29T10:00:00.000Z',
  '2027-04-03T23:30:00.000Z',
  '2027-04-05T01:00:00.000Z',
  '2027-07-01T07:00:00.000Z',
  '2027-09-26T19:45:00.000Z',
  '2027-10-04T02:00:00.000Z',
  '2027-10-30T12:00:00.000Z',
  '2027-11-01T12:00:00.000Z'
];

// Overseas leads: every way the funnel can know (or not know) a country.
const LEADS = [
  { key: 'uk_country', consult: { country: 'uk', qualified: true }, phone: '+447911123456', state: 'uk' },
  { key: 'uk_spelled', consult: { country: 'United Kingdom', qualified: true }, phone: '', state: 'uk' },
  { key: 'ie_country', consult: { country: 'ie', qualified: true }, phone: '+353871234567', state: 'ie' },
  { key: 'nz_country', consult: { country: 'nz', qualified: true }, phone: '+64211234567', state: 'nz' },
  { key: 'uk_phone_only', consult: { qualified: true }, phone: '+447911123456', state: '' },
  { key: 'ie_phone_only', consult: { qualified: true }, phone: '00353871234567', state: '' },
  { key: 'nz_phone_only', consult: { qualified: true }, phone: '+64211234567', state: '' },
  { key: 'other_country', consult: { country: 'other', qualified: false }, phone: '+15551234567', state: 'other' },
  { key: 'nothing_known', consult: { qualified: true }, phone: '', state: '' },
  // A UK-trained GP who lives in Australia: overseas segment (country uk), an
  // Australian mobile. Recorded on purpose: WP-10 leaves this lead on UK time
  // (WP-15's segment question is what moves them).
  { key: 'uk_trained_au_mobile', consult: { country: 'uk', qualified: true }, phone: '+61412345678', state: 'uk' }
];

const DOCTOR_COUNTRIES = ['', 'uk', 'UK', 'gb', 'United Kingdom', 'ie', 'Ireland', 'nz', 'New Zealand', 'other', 'India', null, undefined];

function leadRow(l, createdIso) {
  return {
    id: 'lead-' + l.key,
    kind: 'gp',
    name: 'Dr Test ' + l.key,
    email: l.key + '@gplink-test.local',
    phone: l.phone,
    state: l.state,
    status: 'new',
    created_at: createdIso,
    metadata: { source: 'site_start_form', consult: Object.assign({ call_booked: false, nudges: [] }, l.consult) }
  };
}

function computeOverseasParitySnapshot() {
  const consultReminders = lib('consult-reminders.js');
  const consultWhatsapp = lib('consult-whatsapp.js');
  const consultNoShow = lib('consult-noshow.js');
  const leadCalls = lib('lead-calls.js');
  const interviewMeetings = lib('interview-meetings.js');
  const interviewScheduler = lib('interview-scheduler.js');

  const out = { leads: {}, doctors: {}, callWindows: {}, interview: {}, constants: {} };

  // ── Leads: zone, every label shape, every message that carries a time ──
  LEADS.forEach((l) => {
    const tz = consultReminders.consultLeadTimeZone(l.consult, l.phone);
    const entry = { zone: tz, times: {} };
    INSTANTS.forEach((iso) => {
      const email24 = consultReminders.buildConsultReminderEmail('email_h24', { name: 'Dr Test Lead', callAtIso: iso, timeZone: tz, joinUrl: 'https://zoom.us/j/1' });
      const email1 = consultReminders.buildConsultReminderEmail('email_h1', { name: 'Dr Test Lead', callAtIso: iso, timeZone: tz, joinUrl: 'https://zoom.us/j/1' });
      const whenLong = consultReminders.formatLeadCallTime(iso, tz);
      const waBooked = consultWhatsapp.buildConsultWaMessage('call_booked', { name: 'Dr Test Lead', callAtIso: iso, whenText: whenLong });
      const waReminder = consultWhatsapp.buildConsultWaMessage(consultWhatsapp.CONSULT_CALL_REMINDER_KIND.h24, { name: 'Dr Test Lead', callAtIso: iso, whenText: whenLong, joinUrl: 'https://zoom.us/j/1' });
      entry.times[iso] = {
        long: whenLong,
        short: consultReminders.formatLeadCallTimeShort(iso, tz),
        clock: consultReminders.formatLeadCallClock(iso, tz),
        email_h24: email24 ? { subject: email24.subject, text: email24.text } : null,
        email_h1: email1 ? { subject: email1.subject, text: email1.text } : null,
        wa_call_booked: waBooked ? JSON.stringify(waBooked) : null,
        wa_reminder_h24: waReminder ? JSON.stringify(waReminder) : null,
        booker_zone_format: consultWhatsapp.formatCallTimeInZone(iso, tz),
        default_wa_format: consultWhatsapp.formatConsultCallTime(iso),
        no_show_words: consultNoShow.slotInWords(iso, interviewMeetings.gpTzForCountry(String(l.consult.country || '').toLowerCase())),
        page_summary: consultReminders.consultReplyPageSummary({
          decision: { why: 'upcoming', callAtMs: Date.parse(iso) }, name: 'Dr Test Lead', phone: l.phone, text: 'Can we move it?', timeZone: tz
        }).status
      };
    });
    out.leads[l.key] = entry;
  });

  // ── Hazel: the calling decision and the hours, every hour of a week ──
  const cfg = leadCalls.parseLeadCallConfig({
    LEAD_CALLS_ENABLED: 'true', RETELL_API_KEY: 'k', RETELL_AGENT_ID: 'a',
    RETELL_FROM_NUMBER_UK: '+442000000000', RETELL_FROM_NUMBER_AU: '+61200000000'
  }, { ignoreRuntime: true });
  const weekStart = Date.parse('2026-11-23T00:00:00.000Z');
  LEADS.forEach((l) => {
    const perHour = [];
    for (let h = 0; h < 7 * 24; h++) {
      const nowMs = weekStart + h * 3600000 + 5 * 60000;
      const row = leadRow(l, new Date(nowMs - 3 * 3600000).toISOString());
      const d = leadCalls.leadCallDecision({ row, nowMs, cfg });
      perHour.push(d.action === 'call' ? 'call:' + d.tz + ':' + d.from + ':' + d.windows : 'skip:' + d.reason);
    }
    const sampleNow = Date.parse('2026-11-24T10:05:00.000Z');
    const sampleRow = leadRow(l, new Date(sampleNow - 3 * 3600000).toISOString());
    const vars = leadCalls.buildLeadCallVariables({ row: sampleRow, nowMs: sampleNow, attempt: 1, directorName: 'Khaleed', agentName: 'Hazel' });
    const planNow = Date.parse('2026-11-24T02:05:00.000Z');
    const plan = leadCalls.leadCallPlan({ row: leadRow(l, new Date(planNow - 3 * 3600000).toISOString()), nowMs: planNow, cfg });
    out.callWindows[l.key] = {
      perHour: perHour,
      vars: { lead_timezone: vars.lead_timezone, local_time_now: vars.local_time_now, country_spoken: vars.country_spoken, country_code: vars.country_code },
      plan: { state: plan.state, label: plan.label, detail: plan.detail, due_at: plan.due_at, reason: plan.reason }
    };
  });

  // ── Doctors: the country guess, and the interview slots built on it ──
  DOCTOR_COUNTRIES.forEach((c) => {
    out.doctors[String(c)] = interviewMeetings.gpTzForCountry(c);
  });
  const practices = [
    { key: 'nsw', tz: interviewMeetings.practiceTzForLocation('Test Metro Practice (FAKE)', 'NSW', 'Parramatta') },
    { key: 'wa', tz: interviewMeetings.practiceTzForLocation('Test Perth Practice (FAKE)', 'WA', 'Perth') },
    { key: 'qld_sniffed', tz: interviewMeetings.practiceTzForLocation('Test Brisbane Practice (FAKE)', '', '') },
    { key: 'unknown', tz: interviewMeetings.practiceTzForLocation('Test Practice (FAKE)', '', '') }
  ];
  ['uk', 'ie', 'nz', ''].forEach((country) => {
    practices.forEach((p) => {
      ['2026-11-23T00:00:00.000Z', '2027-03-26T00:00:00.000Z', '2027-10-01T00:00:00.000Z'].forEach((nowIso) => {
        const gpTz = interviewMeetings.gpTzForCountry(country);
        const res = interviewScheduler.computeInterviewSlots({
          now: new Date(nowIso),
          horizonDays: interviewMeetings.INTERVIEW_HORIZON_DAYS,
          durationMin: interviewMeetings.INTERVIEW_DEFAULT_DURATION_MINUTES,
          leadHours: interviewMeetings.INTERVIEW_LEAD_HOURS,
          gridMin: 30,
          maxSlots: 500,
          host: interviewMeetings.DEFAULT_HOST_CONFIG,
          practice: { tz: p.tz, weekday: interviewMeetings.DEFAULT_PRACTICE_CONFIG.weekday, weekend: interviewMeetings.DEFAULT_PRACTICE_CONFIG.weekend, overrides: [] },
          gp: { tz: gpTz, weekday: interviewMeetings.DEFAULT_GP_CONFIG.weekday, weekend: interviewMeetings.DEFAULT_GP_CONFIG.weekend },
          busy: []
        });
        const key = (country || 'none') + '|' + p.key + '|' + nowIso;
        out.interview[key] = {
          practiceTz: p.tz,
          gpTz: gpTz,
          count: res.slots.length,
          first: res.slots.slice(0, 4).map((s) => s.startUtc + ' | ' + s.local.practice.label + ' | ' + s.local.gp.label + ' | ' + s.local.host.label),
          last: res.slots.slice(-2).map((s) => s.startUtc + ' | ' + s.local.practice.label + ' | ' + s.local.gp.label),
          allSha256: crypto.createHash('sha256').update(res.slots.map((s) => s.startUtc + '|' + s.local.gp.label + '|' + s.local.practice.label).join(',')).digest('hex')
        };
      });
    });
  });

  out.constants = {
    host: interviewMeetings.DEFAULT_HOST_CONFIG,
    practice: interviewMeetings.DEFAULT_PRACTICE_CONFIG,
    gp: interviewMeetings.DEFAULT_GP_CONFIG,
    leadHours: interviewMeetings.INTERVIEW_LEAD_HOURS,
    horizonDays: interviewMeetings.INTERVIEW_HORIZON_DAYS
  };
  return JSON.parse(JSON.stringify(out));
}

module.exports = { computeOverseasParitySnapshot, INSTANTS, LEADS, DOCTOR_COUNTRIES };

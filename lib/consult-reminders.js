// Consultation reminders beyond the two original WhatsApp touches, and what
// happens when a doctor answers one (owner request 2026-11-10, after a week in
// which half the booked consultations were no-shows).
//
// What was wrong:
//   - A booking got a WhatsApp the day before and one 5 minutes before, and
//     nothing in between. Five minutes is too late for a GP mid-clinic.
//   - WhatsApp was the only channel the app controlled. No email reminder.
//   - Every time was rendered "(UK time)", including for a New Zealand lead.
//   - A doctor who answered a reminder ("can we move it to 12:30?") reached
//     nobody in time. One wrote 2.5 hours before her call and again 7 minutes
//     into it, and was counted as a no-show.
//
// This module holds the pure rules; server.js binds them to Supabase,
// DoubleTick and Resend:
//   consultLeadTimeZone / formatLeadCallTime   the slot on the lead's own clock
//   consultCallEmailReminderDecision           the two email reminders
//   buildConsultReminderEmail                  their copy
//   classifyReminderReply / consultReplyPageDecision / consultReplyPageSummary
//                                              "page the owner" on a reply
//
// The WhatsApp one-hour touch itself is decided in lib/consult-whatsapp.js
// (consultCallReminderDecision), next to the two it joins; the window constants
// live here so both channels use the same ones.
'use strict';

const { gpTzForCountry } = require('./interview-meetings');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// The one-hour touch goes out on the first cron tick at or inside 70 minutes
// before the call and never later than 30 minutes before it. The call-reminders
// cron runs every 5 minutes, so the window holds eight ticks: several can be
// lost (a deploy, a slow run) and the message still lands. It can never collide
// with the "starts in 5 minutes" touch, which only opens at 5 minutes.
const HOUR_BEFORE_OPEN_MS = 70 * MIN;
const HOUR_BEFORE_CLOSE_MS = 30 * MIN;
// A slot booked less than this long before it starts gets no one-hour touch:
// the confirmation has only just gone out and says the same thing.
const HOUR_BEFORE_MIN_BOOKING_LEAD_MS = 90 * MIN;
// …and it is skipped when the day-before touch went out this recently (a slot
// booked three hours ahead gets "coming up" two hours after booking, which is
// already about an hour before the call).
const HOUR_BEFORE_MIN_AFTER_DAY_TOUCH_MS = 2 * HOUR;
// The day-before email waits this long after the booking, same as WhatsApp.
const EMAIL_MIN_AFTER_BOOKING_MS = 2 * HOUR;

// ── time zone ──────────────────────────────────────────────────────────────
const DIAL_CODE_COUNTRY = [['+353', 'ie'], ['+44', 'uk'], ['+64', 'nz'], ['+61', 'au']];

function countryFromPhone(phone) {
  let s = String(phone || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) return '';
  for (const pair of DIAL_CODE_COUNTRY) if (s.startsWith(pair[0])) return pair[1];
  return '';
}

const KNOWN_COUNTRIES = {
  uk: 'uk', gb: 'uk', 'united kingdom': 'uk', united_kingdom: 'uk',
  ie: 'ie', ireland: 'ie',
  nz: 'nz', 'new zealand': 'nz', new_zealand: 'nz',
  au: 'au', aus: 'au', australia: 'au'
};

// The clock a consult lead lives on: the country they told us, then the dial
// code of their number, then the UK (where the ads run). Always a usable IANA
// zone.
function consultLeadTimeZone(consult, phone) {
  const told = KNOWN_COUNTRIES[String((consult && consult.country) || '').toLowerCase().trim()] || '';
  const country = told || countryFromPhone(phone) || 'uk';
  return gpTzForCountry(country);
}

// Plain words for the zones we serve. Intl's own short names are no good here:
// Dublin in winter reads "GMT" and in summer "IST", Auckland reads "GMT+13".
const ZONE_LABELS = {
  'Europe/London': 'UK time',
  'Europe/Dublin': 'Irish time',
  'Pacific/Auckland': 'New Zealand time',
  'Australia/Sydney': 'Sydney time'
};

function zoneLabel(timeZone, at) {
  if (ZONE_LABELS[timeZone]) return ZONE_LABELS[timeZone];
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timeZone, timeZoneName: 'short' }).formatToParts(at);
    const found = parts.find((p) => p.type === 'timeZoneName');
    return found ? String(found.value || '').trim() : '';
  } catch (_) { return ''; }
}

function clockParts(iso, timeZone, weekday, month) {
  const t = new Date(iso || '');
  if (!iso || isNaN(t.getTime())) return null;
  const zone = String(timeZone || '').trim() || 'Europe/London';
  try {
    const date = new Intl.DateTimeFormat('en-GB', { weekday: weekday, day: 'numeric', month: month, timeZone: zone }).format(t);
    const time = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: zone })
      .format(t).replace(/\s?(am|pm)/i, ' $1');
    return { date: date, time: time, label: zoneLabel(zone, t) };
  } catch (_) {
    return zone === 'Europe/London' ? null : clockParts(iso, 'Europe/London', weekday, month);
  }
}

// "Monday 24 August, 2:00 pm (UK time)" on the lead's own clock. The same
// shape the approved templates were written around, so a UK lead reads exactly
// what they always did. '' when the time is unreadable.
function formatLeadCallTime(iso, timeZone) {
  const p = clockParts(iso, timeZone, 'long', 'long');
  if (!p) return '';
  return p.date + ', ' + p.time + (p.label ? ' (' + p.label + ')' : '');
}

// "Fri 13 Nov, 8:00 am UK time" — the short form for the owner's page.
function formatLeadCallTimeShort(iso, timeZone) {
  const p = clockParts(iso, timeZone, 'short', 'short');
  if (!p) return '';
  return p.date + ', ' + p.time + (p.label ? ' ' + p.label : '');
}

// "2:00 pm (UK time)" — for "your call is at …" an hour before.
function formatLeadCallClock(iso, timeZone) {
  const p = clockParts(iso, timeZone, 'long', 'long');
  if (!p) return '';
  return p.time + (p.label ? ' (' + p.label + ')' : '');
}

// ── email reminders ────────────────────────────────────────────────────────
// Two emails per booking, with their own markers (email_h24, email_h1) on the
// same per-booking marker object the WhatsApp touches use, so one channel
// failing never holds back the other. `markers` must already be the object for
// THIS slot (the WhatsApp decision drops markers stamped for an old slot; the
// caller passes what it returned).
function consultCallEmailReminderDecision(input) {
  const startMs = Date.parse(String((input && input.scheduledAt) || ''));
  if (!isFinite(startMs)) return { action: 'skip', reason: 'no_call_time' };
  const nowMs = Number(input && input.nowMs) || Date.now();
  const untilMs = startMs - nowMs;
  if (untilMs <= HOUR_BEFORE_CLOSE_MS) return { action: 'skip', reason: 'too_close' };
  if (untilMs > DAY) return { action: 'skip', reason: 'too_far_out' };
  const markers = (input && input.markers && typeof input.markers === 'object' && !Array.isArray(input.markers)) ? input.markers : {};
  const bookedMs = Date.parse(String((input && input.bookedAt) || ''));
  const sinceBookingMs = isFinite(bookedMs) ? (nowMs - bookedMs) : Infinity;
  const bookingLeadMs = isFinite(bookedMs) ? (startMs - bookedMs) : Infinity;

  if (untilMs <= HOUR_BEFORE_OPEN_MS) {
    if (markers.email_h1) return { action: 'skip', reason: 'already_sent' };
    if (bookingLeadMs < HOUR_BEFORE_MIN_BOOKING_LEAD_MS) return { action: 'skip', reason: 'booked_late' };
    const dayMs = Date.parse(String(markers.email_h24 || ''));
    if (isFinite(dayMs) && nowMs - dayMs < HOUR_BEFORE_MIN_AFTER_DAY_TOUCH_MS) return { action: 'skip', reason: 'day_before_just_sent' };
    return { action: 'send', window: 'email_h1' };
  }
  if (markers.email_h24 || markers.email_h1) return { action: 'skip', reason: 'already_sent' };
  if (sinceBookingMs < EMAIL_MIN_AFTER_BOOKING_MS) return { action: 'skip', reason: 'just_booked' };
  return { action: 'send', window: 'email_h24' };
}

function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function escHtml(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The copy for one email reminder. Written in the owner's first person, like
// every other consult note. ctx: { name, callAtIso, timeZone, joinUrl }.
// Returns { subject, title, body, ctaText, ctaUrl, text } or null when there is
// no join link or no readable time (the whole point of the email is both).
function buildConsultReminderEmail(window, ctx) {
  const join = String((ctx && ctx.joinUrl) || '').trim();
  const tz = String((ctx && ctx.timeZone) || '').trim() || 'Europe/London';
  const when = formatLeadCallTime(ctx && ctx.callAtIso, tz);
  const clock = formatLeadCallClock(ctx && ctx.callAtIso, tz);
  if (!join || !when) return null;
  const first = firstNameOf(ctx && ctx.name);
  const hi = first ? 'Hi ' + first + ',' : 'Hi there,';
  let subject;
  let title;
  let lines;
  if (window === 'email_h1') {
    subject = 'Your GP Link call is in about an hour (' + clock + ')';
    title = 'We speak in about an hour';
    lines = [
      hi,
      'A quick reminder that your call with me is in about an hour, at ' + clock + '.',
      'The button below takes you straight into the call. It works on a phone or a laptop, and you can join a few minutes early if that suits.',
      'If clinic is running over or something has come up, that is completely fine. Just reply to this email or WhatsApp us if you need another time, and we will sort it out.',
      'Speak soon,\nKhaleed, CEO, GP Link'
    ];
  } else if (window === 'email_h24') {
    subject = 'Your GP Link call: ' + when;
    title = 'Looking forward to speaking with you';
    lines = [
      hi,
      'Just a quick reminder that your free 30-minute consultation with GP Link is coming up on ' + when + '.',
      'The button below is your link to join when it is time. Bring every question you have about registration, visas, earnings and life in Australia, and you will get straight answers.',
      'If the time no longer suits, just reply to this email or WhatsApp us if you need another time, and we will happily move it.',
      'Speak soon,\nKhaleed, CEO, GP Link'
    ];
  } else {
    return null;
  }
  const body = lines.join('\n\n');
  return {
    subject: subject,
    title: title,
    body: body,
    ctaText: 'Join the call',
    ctaUrl: join,
    text: body + '\n\nJoin the call: ' + join
  };
}

// ── replies ────────────────────────────────────────────────────────────────
// The two quick-reply buttons on the one-hour template. A tap arrives as an
// ordinary inbound message whose text is the button's title (server.js
// sanitizeDoubleTickPayload reads it through zohoReengage.buttonReplyText).
const REPLY_BUTTON_CONFIRM = "I'll be there";
const REPLY_BUTTON_MOVE = 'Need another time';

function normaliseReply(text) {
  return String(text || '').toLowerCase().replace(/[‘’`]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Words that always mean a person should look, whatever else the message says.
const REPLY_ALWAYS_PAGE_RE = /\b(reschedul\w*|move\w*|moving|late|can'?t|cannot|unable|sorry|another|chang\w*|clinic\w*|running|link|join\w*|zoom|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|no|not|don'?t|won'?t|cancel\w*|problem|issue|help|unwell|sick|emergency|busy|wrong|instead|earlier|later|today|tonight|postpone\w*|delay\w*)\b/;
// The only words a plain acknowledgement may be made of. Anything else in the
// message and it is not one.
const REPLY_ACK_WORDS = ['thanks', 'thank', 'thankyou', 'thx', 'ty', 'you', 'u', 'ok', 'okay', 'k', 'great', 'perfect', 'lovely',
  'brilliant', 'wonderful', 'fab', 'cool', 'good', 'fine', 'sure', 'cheers', 'noted', 'appreciated', 'see', 'then', 'soon',
  'tomorrow', 'yes', 'yep', 'yeah', 'yup', 'will', 'do', 'be', 'there', "i'll", 'ill', 'i', 'got', 'it', 'that', 'thats', "that's",
  'works', 'sounds', 'much', 'very', 'so', 'many', 'for', 'the', 'reminder', 'confirmed', 'confirm', 'looking', 'forward', 'to',
  'speaking', 'speak', 'hi', 'hello', 'khaleed', 'all', 'a', 'lot', 'and', 'look'];
const REPLY_CONFIRM_RE = /\b(yes|yep|yeah|yup|confirmed|confirm|see (you|u)|be there|looking forward|look forward|speak (then|soon|tomorrow))\b/;
const REPLY_ACK_MAX_WORDS = 10;
const REPLY_GREETING_WORDS = ['hi', 'hello', 'khaleed', 'i', 'you', 'u', 'a', 'and', 'the', 'to', 'for', 'it', 'that', 'so', 'very', 'all'];

// What kind of reply this is:
//   'move'     the "Need another time" button
//   'confirm'  the "I'll be there" button, or a short message that clearly says
//              they are coming ("yes", "see you then", "will be there")
//   'ack'      only a thank-you or an OK ("thanks", "great", a thumbs up)
//   'other'    everything else — a person reads it
// The rule leans one way: when unsure, 'other'. A question mark, a digit (a
// time), a day name or any word in REPLY_ALWAYS_PAGE_RE makes it 'other' no
// matter how politely it starts ("Thanks, can we do 12:30?").
function classifyReminderReply(text) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return 'other';
  const t = normaliseReply(raw);
  if (t === 'need another time') return 'move';
  if (/[?\uFF1F]/.test(raw) || /\d/.test(raw)) return 'other';
  // Emoji only (a thumbs up, a smile): nothing left once symbols are dropped.
  if (!t) return /[A-Za-z]/.test(raw) ? 'other' : 'ack';
  if (REPLY_ALWAYS_PAGE_RE.test(t)) return 'other';
  const words = t.split(' ').filter(Boolean);
  if (words.length > REPLY_ACK_MAX_WORDS) return 'other';
  if (!words.every((w) => REPLY_ACK_WORDS.indexOf(w) !== -1)) return 'other';
  // A bare greeting ("hi", "hello Khaleed") is someone opening a conversation.
  if (words.every((w) => REPLY_GREETING_WORDS.indexOf(w) !== -1)) return 'other';
  return REPLY_CONFIRM_RE.test(t) ? 'confirm' : 'ack';
}

const REPLY_UPCOMING_MS = 48 * HOUR;
const REPLY_AFTER_START_MS = 2 * HOUR;
const REPLY_AFTER_NO_SHOW_MS = 24 * HOUR;
// At most one page per person per this long. Doctors send four short messages
// in a row; the first page already says "open DoubleTick".
const REPLY_PAGE_THROTTLE_MS = 10 * MIN;

// When this booking was (or is) due to start. A booking the no-show sweep has
// re-invited has no scheduled_at any more; the slot survives on the reminder
// markers (call_at) and on the lead (consult.call_at).
function bookingCallAtMs(booking, consult) {
  const b = booking || {};
  const nc = (b.notification_channels && typeof b.notification_channels === 'object' && !Array.isArray(b.notification_channels)) ? b.notification_channels : {};
  const rem = (nc.consult_reminders && typeof nc.consult_reminders === 'object') ? nc.consult_reminders : {};
  const candidates = [b.scheduled_at, rem.call_at, consult && consult.call_at];
  for (const c of candidates) {
    const ms = Date.parse(String(c || ''));
    if (isFinite(ms)) return ms;
  }
  return NaN;
}

// Should this inbound WhatsApp page the owner?
// input: { nowMs, text, lead (site_enquiries row or null),
//          bookings: scheduled_calls rows already matched to this sender,
//          lastPagedAtMs: when the owner was last paged about this person }
// Returns { action: 'page', why, booking, callAtMs }
//       | { action: 'confirm', booking, callAtMs }   (they said they are coming: stamp, no page)
//       | { action: 'none', reason }
// `why` is 'upcoming' (call within 48 h), 'in_progress' (started within the
// past 2 h) or 'no_show' (missed a call in the past 24 h).
// Before a call that is still ahead, a plain thank-you does nothing and a clear
// "see you then" confirms. Once the call has started, or after a missed one,
// every message pages. A page inside REPLY_PAGE_THROTTLE_MS of the last one is
// held back (reason 'throttled').
function consultReplyPageDecision(input) {
  const nowMs = Number(input && input.nowMs) || Date.now();
  const lead = (input && input.lead) || null;
  const consult = (lead && lead.metadata && lead.metadata.consult) || {};
  const bookings = Array.isArray(input && input.bookings) ? input.bookings : [];
  const kind = classifyReminderReply(input && input.text);
  const lastPagedAtMs = Number(input && input.lastPagedAtMs);
  const throttled = isFinite(lastPagedAtMs) && lastPagedAtMs > 0 && nowMs - lastPagedAtMs >= 0 && nowMs - lastPagedAtMs < REPLY_PAGE_THROTTLE_MS;

  // A live booking first: soonest relevant slot wins.
  let live = null;
  bookings.forEach((b) => {
    if (!b || b.status !== 'booked') return;
    const at = Date.parse(String(b.scheduled_at || ''));
    if (!isFinite(at)) return;
    if (at - nowMs > REPLY_UPCOMING_MS || nowMs - at > REPLY_AFTER_START_MS) return;
    if (!live || at < live.callAtMs) live = { booking: b, callAtMs: at };
  });
  if (live) {
    if (live.callAtMs > nowMs) {
      if (kind === 'confirm') return { action: 'confirm', booking: live.booking, callAtMs: live.callAtMs };
      if (kind === 'ack') return { action: 'none', reason: 'acknowledgement' };
    }
    if (throttled) return { action: 'none', reason: 'throttled' };
    return { action: 'page', why: live.callAtMs > nowMs ? 'upcoming' : 'in_progress', moveRequested: kind === 'move', booking: live.booking, callAtMs: live.callAtMs };
  }

  // No live booking: did they miss one in the past day?
  let missed = null;
  bookings.forEach((b) => {
    if (!b) return;
    const at = bookingCallAtMs(b, consult);
    if (!isFinite(at) || at > nowMs || nowMs - at > REPLY_AFTER_NO_SHOW_MS) return;
    const swept = (b.status === 'invited' || b.status === 'no_show' || b.status === 'cancelled') && Number(b.failed_attempt_count || 0) >= 1;
    const notAttended = b.status === 'completed' && consult.call_attended === false;
    const unresolved = b.status === 'booked'; // started more than 2 h ago, the sweep has not ruled yet
    if (!swept && !notAttended && !unresolved) return;
    if (!missed || at > missed.callAtMs) missed = { booking: b, callAtMs: at };
  });
  if (!missed && consult.call_attended === false) {
    const doneMs = Date.parse(String(consult.call_completed_at || ''));
    const at = Date.parse(String(consult.call_at || ''));
    const ref = isFinite(at) ? at : doneMs;
    if (isFinite(ref) && ref <= nowMs && nowMs - ref <= REPLY_AFTER_NO_SHOW_MS) missed = { booking: null, callAtMs: ref };
  }
  if (missed && throttled) return { action: 'none', reason: 'throttled' };
  if (missed) return { action: 'page', why: 'no_show', moveRequested: kind === 'move', booking: missed.booking, callAtMs: missed.callAtMs };
  return { action: 'none', reason: bookings.length ? 'no_call_in_window' : 'no_booking' };
}

// The four slots of the approved gp_link_owner_lead_alert template, which reads
// "Lead needs a personal follow-up. Name: {{1}}. Phone: {{2}}. They said: {{3}}.
// Status: {{4}}. Reply from DoubleTick or call them now." So no slot ends in a
// full stop and none may be empty or carry a line break.
function consultReplyPageSummary(input) {
  const i = input || {};
  const one = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const clip = (v, n) => { const s = one(v); return s.length > n ? s.slice(0, n - 1).trim() + '…' : s; };
  const d = i.decision || {};
  const tz = String(i.timeZone || '').trim() || 'Europe/London';
  const when = formatLeadCallTimeShort(new Date(d.callAtMs).toISOString(), tz);
  const said = clip(i.text, 240).replace(/[.!?\s]+$/, '');
  let status;
  if (d.why === 'no_show') status = 'Missed their call on ' + when + ' and has now written in';
  else if (d.why === 'in_progress') status = 'Their call was due to start at ' + when + ', so they may be trying to join right now';
  else if (d.moveRequested) status = 'Call booked ' + when + '. They tapped Need another time on the reminder';
  else status = 'Call booked ' + when + '. Replied on WhatsApp before the call';
  return {
    name: one(i.name) || 'Unknown name',
    phone: one(i.phone) || 'no phone on file',
    answers: said || 'an empty message',
    status: status
  };
}

module.exports = {
  HOUR_BEFORE_OPEN_MS,
  HOUR_BEFORE_CLOSE_MS,
  HOUR_BEFORE_MIN_BOOKING_LEAD_MS,
  HOUR_BEFORE_MIN_AFTER_DAY_TOUCH_MS,
  EMAIL_MIN_AFTER_BOOKING_MS,
  REPLY_UPCOMING_MS,
  REPLY_AFTER_START_MS,
  REPLY_AFTER_NO_SHOW_MS,
  REPLY_PAGE_THROTTLE_MS,
  REPLY_BUTTON_CONFIRM,
  REPLY_BUTTON_MOVE,
  countryFromPhone,
  consultLeadTimeZone,
  formatLeadCallTime,
  formatLeadCallTimeShort,
  formatLeadCallClock,
  consultCallEmailReminderDecision,
  buildConsultReminderEmail,
  classifyReminderReply,
  bookingCallAtMs,
  consultReplyPageDecision,
  consultReplyPageSummary,
  escHtml
};

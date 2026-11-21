'use strict';

/**
 * WP-16 (Australian GP build): the SEND RULES for messages to an
 * Australian-segment lead. Pure, no I/O. The words are in
 * lib/au-lead-copy.js; the local-hours gate is lib/au-quiet-hours.js.
 *
 * 1. THE GO-LIVE RULE (one place: auSequenceAdmits)
 *
 *    WP-01 held every message to an Australian-segment lead and recorded
 *    nothing, so those leads have no step markers. The day Australian copy is
 *    switched on, the elapsed-time logic would read every one of them as
 *    "nothing sent yet, everything overdue" and fire stale notes at people who
 *    enquired weeks ago.
 *
 *    So an Australian-segment lead only ENTERS a sequence when the event that
 *    starts it happened AFTER a go-live instant:
 *
 *      the three notes before a booking   anchored on when they qualified
 *                                         (the lead's created_at)
 *      "your call is booked"              when they booked
 *      the after-call emails              when the attended call ended
 *      "sorry we missed each other"       the slot they missed
 *
 *    A lead who enquired before go-live and books a call after it gets the
 *    booking messages (a new event), but never the old notes. Everyone older
 *    is left for the owner to follow up personally; the Leads tab marks them.
 *
 *    The go-live instant is env AU_LEAD_COPY_LIVE_FROM (an ISO instant). When
 *    it is not set, the server records "now" the first time the consult-nudge
 *    job runs with the switch on (runtime_kv key au_lead_copy_live_from) and
 *    uses that for good. An instant we cannot read admits NOBODY (fail
 *    closed).
 *
 *    One step per run comes from the existing schedule (nextConsultNudge
 *    hands out one step and enforces a floor between steps), plus sentSince
 *    below for the two flows that share a run (the missed-call rescue and
 *    the sequence).
 *
 * 2. WHAT WAS SENT AND WHAT WAS SKIPPED (the lead's own record)
 *
 *    consult.au_log = [{ id, ch: 'email' | 'whatsapp', out: 'sent' | 'skipped',
 *                        why?, at, key? }]   (newest last, at most 60)
 *
 *    The Leads tab drawer lists it in plain words ("WhatsApp skipped: no
 *    approved Australian template"). A skip is recorded once per message and
 *    reason, so a job that looks every five minutes writes it once.
 */

const auLead = require('./au-lead.js');
const auLeadCopy = require('./au-lead-copy.js');

const LIVE_FROM_ENV = 'AU_LEAD_COPY_LIVE_FROM';
const LIVE_FROM_KV_KEY = 'au_lead_copy_live_from';
const AU_LOG_MAX = 60;
const MINUTE = 60 * 1000;
// A confirmation ("your call is booked", "thanks for the conversation") is
// exempt from quiet hours only this soon after the event it confirms.
const PROMPT_WINDOW_MS = 30 * MINUTE;
// The 5-minute note is not emailed on top of a booking-link email this recent.
const BOOKING_LINK_RECENT_MS = 60 * MINUTE;

const SKIP = Object.freeze({
  BEFORE_GO_LIVE: 'au_before_go_live',
  NOT_LAUNCHED: auLeadCopy.SKIP_NOT_LAUNCHED,
  NO_TEMPLATE: 'au_template_not_approved',
  BOOKING_LINK_JUST_SENT: 'au_booking_link_just_sent',
  EMAIL_BOUNCED: 'email_bounced'
});

function consultOf(lead) {
  if (!lead || typeof lead !== 'object') return {};
  if (Object.prototype.hasOwnProperty.call(lead, 'metadata') || Object.prototype.hasOwnProperty.call(lead, 'kind')) {
    const c = lead.metadata && lead.metadata.consult;
    return (c && typeof c === 'object') ? c : {};
  }
  return lead;
}

function parseMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const t = Date.parse(String(v == null ? '' : v));
  return Number.isFinite(t) ? t : NaN;
}

/** The go-live instant from the environment, or NaN when it is not set / unreadable. */
function liveFromEnvMs(env) {
  const raw = String(((env || process.env)[LIVE_FROM_ENV]) || '').trim();
  return raw ? parseMs(raw) : NaN;
}

/**
 * THE go-live rule. An Australian-segment lead enters a sequence only when
 * the event that starts it happened at or after go-live.
 *   { admit: true }
 *   { admit: false, reason: 'au_before_go_live' }
 * Anything unreadable (no anchor, no go-live instant) is not admitted.
 */
function auSequenceAdmits(input) {
  const anchorMs = parseMs(input && input.anchorMs);
  const liveFromMs = parseMs(input && input.liveFromMs);
  if (!Number.isFinite(anchorMs) || !Number.isFinite(liveFromMs)) return { admit: false, reason: SKIP.BEFORE_GO_LIVE };
  return anchorMs >= liveFromMs ? { admit: true, reason: '' } : { admit: false, reason: SKIP.BEFORE_GO_LIVE };
}

/**
 * When the event behind a message happened, for the go-live rule.
 * `anchor` is MESSAGES[id].anchor: 'qualified' | 'booked' | 'attended' |
 * 'no_show' | 'none'. NaN when the lead does not carry that event.
 */
function anchorMsFor(messageId, lead, createdAtMs) {
  const m = auLeadCopy.MESSAGES[messageId];
  const c = consultOf(lead);
  if (!m) return NaN;
  if (m.anchor === 'qualified') {
    const created = Number.isFinite(parseMs(createdAtMs)) ? parseMs(createdAtMs) : parseMs(lead && lead.created_at);
    return created;
  }
  if (m.anchor === 'booked') return parseMs(c.call_booked_at);
  if (m.anchor === 'attended') return parseMs(c.call_completed_at);
  if (m.anchor === 'no_show') return parseMs(c.no_show && c.no_show.call_at);
  return NaN;
}

/**
 * How quiet hours treat one message for one lead right now:
 *   'exempt'  do not gate (a reminder about a booked call, a reply to a
 *             request, or a confirmation within 30 minutes of its event)
 *   'gated'   08:00 to 20:00 local only
 */
function quietModeFor(messageId, anchorMs, nowMs) {
  const m = auLeadCopy.MESSAGES[messageId];
  if (!m) return 'gated';
  if (m.quiet === 'exempt') return 'exempt';
  if (m.quiet === 'prompt') {
    const a = parseMs(anchorMs);
    const now = parseMs(nowMs);
    return (Number.isFinite(a) && Number.isFinite(now) && now - a >= 0 && now - a <= PROMPT_WINDOW_MS) ? 'exempt' : 'gated';
  }
  return 'gated';
}

// ── The lead's own record ──────────────────────────────────────────────────
function auLogOf(lead) {
  const c = consultOf(lead);
  return Array.isArray(c.au_log) ? c.au_log : [];
}

function sameEntry(a, b) {
  return a && b && a.id === b.id && a.ch === b.ch && a.out === b.out
    && String(a.why || '') === String(b.why || '') && String(a.key || '') === String(b.key || '');
}

/**
 * The consult object with these entries added to au_log, or the SAME object
 * when there is nothing new to write (a skip already on record is not written
 * again). entry: { id, ch, out, why?, key?, at? }.
 */
function withAuLog(consult, entries, nowIso) {
  const base = (consult && typeof consult === 'object') ? consult : {};
  const log = Array.isArray(base.au_log) ? base.au_log.slice() : [];
  const at = String(nowIso || new Date().toISOString());
  let changed = false;
  (Array.isArray(entries) ? entries : [entries]).forEach(function (e) {
    if (!e || !e.id || !e.ch || !e.out) return;
    const entry = { id: String(e.id), ch: String(e.ch), out: String(e.out), at: String(e.at || at) };
    if (e.why) entry.why = String(e.why);
    if (e.key) entry.key = String(e.key);
    if (entry.out === 'skipped' && log.some(function (x) { return sameEntry(x, entry); })) return;
    log.push(entry);
    changed = true;
  });
  if (!changed) return base;
  return Object.assign({}, base, { au_log: log.slice(-AU_LOG_MAX) });
}

/** When the booking-link email last went to this lead (ms), or NaN. */
function lastBookingLinkSentMs(lead) {
  let last = NaN;
  auLogOf(lead).forEach(function (e) {
    if (!e || e.out !== 'sent' || e.ch !== 'email' || (e.id !== 'booking_link' && e.id !== 'booking_link_generic')) return;
    const t = parseMs(e.at);
    if (Number.isFinite(t) && (!Number.isFinite(last) || t > last)) last = t;
  });
  return last;
}

/**
 * Has an automated message already gone to this lead in this run? (The
 * missed-call rescue and the nudge sequence share one job; an Australian lead
 * gets at most one of them per run.)
 */
function sentSince(lead, sinceMs) {
  const since = parseMs(sinceMs);
  if (!Number.isFinite(since)) return false;
  return auLogOf(lead).some(function (e) { return e && e.out === 'sent' && parseMs(e.at) >= since; });
}

/**
 * The lead's standing against the go-live rule, for the Leads tab:
 *   'not_australian'   no Australian messages apply (switch off / overseas)
 *   'not_live'         no go-live instant yet: nothing is being sent
 *   'before_go_live'   enquired before go-live and has had nothing since:
 *                      the owner follows up personally
 *   'live'             in the sequences
 */
function leadCopyState(lead, liveFromMs, opts) {
  if (!auLead.auCopyApplies(lead, opts)) return 'not_australian';
  const live = parseMs(liveFromMs);
  if (!Number.isFinite(live)) return 'not_live';
  const c = consultOf(lead);
  const created = parseMs(lead && lead.created_at);
  const later = [c.call_booked_at, c.call_completed_at, c.no_show && c.no_show.call_at].map(parseMs)
    .filter(function (t) { return Number.isFinite(t); });
  const newest = later.concat(Number.isFinite(created) ? [created] : []).reduce(function (a, b) { return Math.max(a, b); }, -Infinity);
  return newest >= live ? 'live' : 'before_go_live';
}

/**
 * The record in the owner's words, newest first:
 *   [{ at, text, out }]   "Email sent: 1-hour note"
 *                         "WhatsApp skipped: no approved Australian template (5-minute note)"
 */
function describeAuLog(lead) {
  return auLogOf(lead).slice().reverse().map(function (e) {
    const channel = e.ch === 'whatsapp' ? 'WhatsApp' : 'Email';
    const label = auLeadCopy.messageLabel(e.id);
    const text = e.out === 'sent'
      ? channel + ' sent: ' + label
      : channel + ' skipped: ' + auLeadCopy.skipReasonWords(e.why) + ' (' + label + ')';
    return { at: e.at, out: e.out, id: e.id, channel: e.ch, text: text };
  });
}

module.exports = {
  LIVE_FROM_ENV,
  LIVE_FROM_KV_KEY,
  PROMPT_WINDOW_MS,
  BOOKING_LINK_RECENT_MS,
  SKIP,
  liveFromEnvMs,
  auSequenceAdmits,
  anchorMsFor,
  quietModeFor,
  auLogOf,
  withAuLog,
  lastBookingLinkSentMs,
  sentSince,
  leadCopyState,
  describeAuLog
};

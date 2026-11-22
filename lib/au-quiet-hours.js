'use strict';

/**
 * WP-16 (COM-22): local quiet hours for the Australian product. Pure, no I/O.
 *
 * THE gate every elapsed-time send to an Australian-segment lead or a doctor
 * on an Australian pathway passes through:
 *
 *     const q = auQuietHoursAllow(leadOrProfile, nowMs, opts);
 *     if (!q.allow) { leave the step unsent and unmarked; the next run inside
 *                     the window sends it }
 *
 * The rule: a message that goes out because TIME HAS PASSED (a note 5 minutes
 * after an enquiry, a drip email, "sorry we missed each other", a document
 * reminder, a first-week check-in) is only sent between 08:00 and 20:00 on the
 * person's own clock. Outside those hours it is DEFERRED, never dropped and
 * never marked sent.
 *
 * Whose clock: lib/au-timezone.js localHourFor (the zone they booked in, then
 * their browser's, then their state). When all we know is "Australia"
 * (`certain: false`: a +61 number or nothing at all) we cannot tell Perth from
 * Sydney, so the send is allowed only when it is inside 08:00 to 20:00 in
 * EVERY Australian zone at that instant. That window is computed from the
 * zones themselves (it is roughly 11:00 to 20:00 Sydney time, and it moves
 * with daylight saving), never from a fixed offset.
 *
 * Who it applies to: Australian-segment leads and doctors on an Australian
 * pathway, with the switch on. For everyone else it answers allow:true,
 * applies:false, and the caller's send time is exactly what it was. Overseas
 * nudges have never had quiet hours and this does not give them any (parity;
 * an owner decision is recorded in docs/au-gp/CONVENTIONS.md section 28).
 *
 * NOT for: a message anchored on a meeting (a reminder an hour before a booked
 * call), or one that answers something the person just did (the booking link
 * they asked for, a booking confirmation, account verification). Those callers
 * simply do not call the gate, or pass { exempt: 'reason' } so the decision is
 * still on record.
 */

const auTimezone = require('./au-timezone.js');
const auLead = require('./au-lead.js');

const QUIET_START_MINUTES = 8 * 60;   // 08:00, first minute a send is allowed
const QUIET_END_MINUTES = 20 * 60;    // 20:00, first minute it is not

const REASON = Object.freeze({
  NOT_AUSTRALIAN: 'not_australian',
  EXEMPT: 'exempt',
  INSIDE: 'inside_hours',
  QUIET: 'quiet_hours',
  QUIET_UNCERTAIN: 'quiet_hours_zone_uncertain'
});

function clockIn(zone, nowMs) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = {};
  fmt.formatToParts(new Date(nowMs)).forEach(function (p) { parts[p.type] = p.value; });
  const hour = parseInt(parts.hour, 10) % 24;
  const minute = parseInt(parts.minute, 10);
  return { hour: hour, minute: minute, minutes: hour * 60 + minute };
}

function insideWindow(minutes) {
  return minutes >= QUIET_START_MINUTES && minutes < QUIET_END_MINUTES;
}

// Every distinct Australian zone the product knows (the state table).
function australianZones() {
  const seen = {};
  Object.keys(auTimezone.AU_STATE_TZ).forEach(function (st) { seen[auTimezone.AU_STATE_TZ[st]] = true; });
  return Object.keys(seen);
}

/** Inside 08:00 to 20:00 in one named zone at this instant. */
function zoneInsideHours(zone, nowMs) {
  try { return insideWindow(clockIn(zone, nowMs).minutes); }
  catch (e) { return false; }
}

/** Inside 08:00 to 20:00 in EVERY Australian zone at this instant. */
function everyAustralianZoneInsideHours(nowMs) {
  return australianZones().every(function (z) { return zoneInsideHours(z, nowMs); });
}

function pad(n) { return (n < 10 ? '0' : '') + n; }

function decide(zone, certain, nowMs) {
  const usedZone = zone || auTimezone.AU_FALLBACK_ZONE || 'Australia/Sydney';
  let clock;
  try { clock = clockIn(usedZone, nowMs); } catch (e) { clock = null; }
  const allow = (certain && clock) ? insideWindow(clock.minutes) : everyAustralianZoneInsideHours(nowMs);
  return {
    allow: allow,
    applies: true,
    reason: allow ? REASON.INSIDE : (certain && clock ? REASON.QUIET : REASON.QUIET_UNCERTAIN),
    zone: usedZone,
    certain: !!(certain && clock),
    localTime: clock ? pad(clock.hour) + ':' + pad(clock.minute) : ''
  };
}

// The first instant at or after nowMs when the same subject would be allowed,
// in 5-minute steps (the consult-nudge cron's own cadence), looking two days
// ahead. For logs and the Leads tab; nothing schedules against it.
function nextAllowedMs(zone, certain, nowMs) {
  const STEP = 5 * 60 * 1000;
  const start = Math.ceil(nowMs / STEP) * STEP;
  for (let t = start; t <= nowMs + 48 * 60 * 60 * 1000; t += STEP) {
    if (decide(zone, certain, t).allow) return t;
  }
  return NaN;
}

/**
 * THE gate.
 *
 * @param {object} subject  a site_enquiries row or its consult object (a
 *                          lead), or a user_profiles row (a doctor)
 * @param {number} [nowMs]
 * @param {object} [opts]   { kind: 'lead'|'doctor', isAu (doctors: the caller
 *                          has resolved an Australian pathway), phone,
 *                          bookingZone, viewerZone, auPathwayEnabled,
 *                          exempt: 'why this send is not an elapsed-time one' }
 * @returns {{ allow, applies, reason, zone, certain, localTime, nextAllowedMs }}
 *   applies false = not an Australian subject (or switch off): allow is true
 *   and nothing about the caller's timing changes.
 */
function auQuietHoursAllow(subject, nowMs, opts) {
  const o = opts || {};
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const on = auLead.auPathwayOn(o);
  const asLead = o.kind ? o.kind === 'lead' : (o.isAu === undefined);
  const australian = on && (asLead ? auLead.isAuSegmentLead(subject) : o.isAu === true);
  if (!australian) return { allow: true, applies: false, reason: REASON.NOT_AUSTRALIAN, zone: '', certain: false, localTime: '', nextAllowedMs: now };
  const local = auTimezone.localHourFor(subject, now, Object.assign({}, o, { kind: asLead ? 'lead' : 'doctor' }));
  const d = decide(local.zone, local.certain === true, now);
  if (o.exempt) {
    return Object.assign({}, d, { allow: true, reason: REASON.EXEMPT, exempt: String(o.exempt), nextAllowedMs: now });
  }
  d.nextAllowedMs = d.allow ? now : nextAllowedMs(local.zone, local.certain === true, now);
  return d;
}

/**
 * The same rule for a caller that already holds the zone (the lifecycle job
 * knows the practice's zone; after commencement the doctor works there).
 * `zone` empty or unusable is treated as "Australia, zone not known".
 */
function auQuietHoursAllowInZone(zone, nowMs, opts) {
  const o = opts || {};
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const valid = auTimezone.validZone(zone);
  const d = decide(valid, !!valid && o.certain !== false, now);
  d.nextAllowedMs = d.allow ? now : nextAllowedMs(valid, !!valid && o.certain !== false, now);
  return d;
}

/**
 * For a job that runs on a timer and must also run INSIDE the hours
 * everywhere in Australia (the daily lifecycle job is hosted at 20:30 UTC,
 * early morning in Australia, so its messages are deferred there and sent by
 * a later run): true while the all-Australia window is open and was still
 * closed `withinMs` ago. An hourly host with withinMs = 2 hours runs on the
 * first two ticks of the window each day (the job is idempotent, so the
 * second is a cheap safety net for a missed tick).
 */
function allAustraliaWindowOpenedWithin(nowMs, withinMs) {
  const now = Number(nowMs);
  const within = Number(withinMs) > 0 ? Number(withinMs) : 60 * 60 * 1000;
  return everyAustralianZoneInsideHours(now) && !everyAustralianZoneInsideHours(now - within);
}

module.exports = {
  QUIET_START_MINUTES,
  QUIET_END_MINUTES,
  REASON,
  australianZones,
  zoneInsideHours,
  everyAustralianZoneInsideHours,
  auQuietHoursAllow,
  auQuietHoursAllowInZone,
  allAustraliaWindowOpenedWithin
};

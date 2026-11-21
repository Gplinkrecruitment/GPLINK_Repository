'use strict';

/**
 * Time zones for the Australian GP build (WP-10). Pure: no I/O, the clock and
 * the environment are always arguments (the switch is read at call time when
 * it is not passed in).
 *
 * Why it exists (docs/au-gp/review-report.md: WEB-03, APP-21, DAT-22, COM-14,
 * COM-19, COM-27, COM-38). The product was built for doctors overseas, so
 * "where is this person?" was answered from the country they trained in: all
 * of Australia was Sydney, and anything unknown was London. A Perth GP was
 * told Sydney times, and interviews were only offered in hours that suit a UK
 * evening.
 *
 * ONE resolver answers "which clock is this person on?", from the best
 * evidence to the worst:
 *
 *   1. booker   the zone the person booked in (Calendly's invitee zone)
 *   2. browser  the zone their own device reported
 *   3. state    the Australian state or territory they told us
 *   4. dial_code  the dial code of their phone number
 *   5. country  the country on file
 *
 * A +61 number, or "Australia" with no state, only says "somewhere in
 * Australia": the answer is Sydney as a last resort with `certain: false`, so a
 * caller can avoid asserting "your local time" (every label names the city:
 * "Sydney time", never "your time").
 *
 * WHO GETS IT. Only Australian-segment leads (lib/au-lead.js) and doctors on an
 * Australian pathway (lib/candidate-pathway.js), and only with the
 * AU_PATHWAY_ENABLED switch on. Every other lead and doctor, and everyone when
 * the switch is off, keeps exactly the zone the code computed before: the
 * helpers here answer `null` for them and the caller falls through to its
 * existing line. A UK-trained GP who lives in Australia is an OVERSEAS lead
 * until WP-15's segment question tags them; they stay on UK time here.
 */

const { isAuPathwayEnabled } = require('./au-pathway-flag.js');
const auLead = require('./au-lead.js');
const interviewMeetings = require('./interview-meetings.js');

// The single state → IANA table (lib/interview-meetings.js AU_STATE_TZ; the
// practice side has always used it). NSW, VIC, TAS, ACT and SA observe
// daylight saving; QLD, NT and WA do not. Intl applies the rule per zone.
const AU_STATE_TZ = interviewMeetings.AU_STATE_TZ;
const AU_STATES = Object.keys(AU_STATE_TZ);
const AU_FALLBACK_ZONE = 'Australia/Sydney';

const STATE_NAMES = {
  'new south wales': 'NSW',
  victoria: 'VIC',
  queensland: 'QLD',
  'south australia': 'SA',
  'western australia': 'WA',
  tasmania: 'TAS',
  'northern territory': 'NT',
  'australian capital territory': 'ACT'
};

// 'wa', 'WA', 'Western Australia' → 'WA'. Anything else → ''.
function normaliseAuState(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw || raw.length > 40) return '';
  const upper = raw.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(AU_STATE_TZ, upper)) return upper;
  const named = STATE_NAMES[raw.toLowerCase().replace(/\s+/g, ' ')];
  return named || '';
}

function zoneForAuState(value) {
  const code = normaliseAuState(value);
  return code ? AU_STATE_TZ[code] : '';
}

/**
 * A zone a browser or a booking tool reported, or '' when it cannot be
 * trusted. Never store or use the raw value: this is the only gate.
 *   - must look like Region/City (so 'UTC', 'GMT', 'EST' and free text fail:
 *     a privacy browser or a script reports UTC, which says nothing about
 *     where the person is);
 *   - the Etc/ family is refused for the same reason;
 *   - must be a zone this runtime's Intl knows ('Mars/Olympus_Mons' fails).
 * Returns the zone (in the runtime's letter case), or ''.
 */
function validZone(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  if (!s || s.length > 64) return '';
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(s)) return '';
  if (/^etc\//i.test(s)) return '';
  try {
    const resolved = String(new Intl.DateTimeFormat('en-AU', { timeZone: s }).resolvedOptions().timeZone || '');
    if (/^(utc|gmt)$/i.test(resolved) || /^etc\//i.test(resolved)) return '';
    // The runtime's spelling when only the letter case differed
    // ('australia/perth'); otherwise exactly what was sent (some runtimes
    // rename a zone to an older alias, which nobody needs stored).
    return resolved.toLowerCase() === s.toLowerCase() ? resolved : s;
  } catch (e) {
    return '';
  }
}

const DIAL_CODES = [['+353', 'ie'], ['+44', 'uk'], ['+64', 'nz'], ['+61', 'au']];

function dialCountry(phone) {
  let s = String(phone == null ? '' : phone).replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) return '';
  for (const pair of DIAL_CODES) if (s.startsWith(pair[0])) return pair[1];
  return '';
}

const COUNTRIES = {
  uk: 'uk', gb: 'uk', 'united kingdom': 'uk', united_kingdom: 'uk',
  ie: 'ie', ireland: 'ie',
  nz: 'nz', 'new zealand': 'nz', new_zealand: 'nz',
  au: 'au', aus: 'au', australia: 'au'
};

function knownCountry(value) {
  return COUNTRIES[String(value == null ? '' : value).trim().toLowerCase()] || '';
}

function answer(zone, source, certain) {
  return { zone: zone, source: source, certain: certain === true };
}

/**
 * THE resolver. signals: { bookerZone, browserZone, state, phone, country }.
 * Returns { zone, source, certain }:
 *   source  'booker' | 'browser' | 'state' | 'dial_code' | 'country' | 'default'
 *   certain false when all we know is "Australia" (zone is Sydney, a guess) or
 *           nothing at all (zone is London, the long-standing default).
 */
function resolveZone(signals) {
  const s = signals || {};
  const booker = validZone(s.bookerZone);
  if (booker) return answer(booker, 'booker', true);
  const browser = validZone(s.browserZone);
  if (browser) return answer(browser, 'browser', true);
  const byState = zoneForAuState(s.state);
  if (byState) return answer(byState, 'state', true);
  const dial = dialCountry(s.phone);
  if (dial === 'au') return answer(AU_FALLBACK_ZONE, 'dial_code', false);
  if (dial) return answer(interviewMeetings.gpTzForCountry(dial), 'dial_code', true);
  const country = knownCountry(s.country);
  if (country === 'au') return answer(AU_FALLBACK_ZONE, 'country', false);
  if (country) return answer(interviewMeetings.gpTzForCountry(country), 'country', true);
  return answer('Europe/London', 'default', false);
}

function switchOn(opts) {
  if (opts && typeof opts.auPathwayEnabled === 'boolean') return opts.auPathwayEnabled;
  return isAuPathwayEnabled();
}

function consultOf(lead) {
  if (!lead || typeof lead !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(lead, 'metadata') || Object.prototype.hasOwnProperty.call(lead, 'kind')) {
    const c = lead.metadata && lead.metadata.consult;
    return (c && typeof c === 'object') ? c : null;
  }
  return lead;
}

// ── Leads (site_enquiries.metadata.consult) ────────────────────────────────
// Stored on the consult object, no schema change:
//   timezone         a validated IANA zone
//   timezone_source  'calendly' (the zone they booked in) | 'browser'
//   state            an Australian state code (WP-15 asks the question)

/**
 * The zone for an AUSTRALIAN-SEGMENT lead with the switch on; null for every
 * other lead and whenever the switch is off (the caller keeps its own line).
 * `lead` is a site_enquiries row or the consult object. opts: { phone,
 * bookingZone (scheduled_calls.timezone for the booking in hand),
 * auPathwayEnabled }.
 */
function auLeadZone(lead, opts) {
  if (!switchOn(opts)) return null;
  if (!auLead.isAuSegmentLead(lead)) return null;
  const consult = consultOf(lead) || {};
  const stored = validZone(consult.timezone);
  const storedIsBooking = String(consult.timezone_source || '') === 'calendly';
  const phone = (opts && opts.phone) || (lead && lead.phone) || '';
  return resolveZone({
    bookerZone: (opts && opts.bookingZone) || (storedIsBooking ? stored : ''),
    browserZone: storedIsBooking ? '' : stored,
    state: consult.state,
    phone: phone,
    country: 'au'
  });
}

/**
 * The consult object with a newly learned zone on it, or the SAME object when
 * there is nothing to write (invalid zone, nothing changed, or a browser zone
 * arriving after a booking zone: the booking zone is better evidence and is
 * kept). source: 'calendly' | 'browser'. Does not look at the switch: callers
 * gate the write.
 */
function withLeadZone(consult, zone, source) {
  const base = (consult && typeof consult === 'object') ? consult : {};
  const z = validZone(zone);
  const src = source === 'calendly' ? 'calendly' : (source === 'browser' ? 'browser' : '');
  if (!z || !src) return consult;
  if (src === 'browser' && String(base.timezone_source || '') === 'calendly' && validZone(base.timezone)) return consult;
  if (base.timezone === z && base.timezone_source === src) return consult;
  return Object.assign({}, base, { timezone: z, timezone_source: src });
}

/**
 * WP-15 hook: the consult object with the lead's Australian state on it
 * ('WA', 'wa' or 'Western Australia' are all accepted and stored as 'WA'), or
 * the SAME object when the answer is not an Australian state or is unchanged.
 */
function withLeadState(consult, state) {
  const base = (consult && typeof consult === 'object') ? consult : {};
  const code = normaliseAuState(state);
  if (!code || base.state === code) return consult;
  return Object.assign({}, base, { state: code });
}

// ── Doctors (user_profiles.timezone, user_profiles.current_state) ──────────

/**
 * The zone for a doctor ON AN AUSTRALIAN PATHWAY. The caller has already
 * established that (resolveCandidatePathway, switch on); this function does
 * not check. input: { profile: { timezone, current_state }, viewerZone (their
 * device on this request), bookingZone (the zone stored on the booking in
 * hand), phone }.
 */
function auDoctorZone(input) {
  const i = input || {};
  const profile = (i.profile && typeof i.profile === 'object') ? i.profile : {};
  return resolveZone({
    bookerZone: i.bookingZone,
    browserZone: validZone(i.viewerZone) || profile.timezone,
    state: profile.current_state,
    phone: i.phone,
    country: 'au'
  });
}

/**
 * What to store in user_profiles.timezone when a doctor's state is written.
 * The stored zone follows the state unless a browser has said otherwise:
 * it is (re)written from the state when nothing is stored, or when what is
 * stored is simply the zone of the PREVIOUS state. Returns the zone to write,
 * or '' to leave the column alone.
 */
function timezoneToStoreForState(input) {
  const i = input || {};
  const next = zoneForAuState(i.newState);
  if (!next) return '';
  const stored = validZone(i.storedTimezone);
  if (!stored) return next;
  if (stored === next) return '';
  const previous = zoneForAuState(i.previousState);
  return (previous && stored === previous) ? next : '';
}

// ── Labels ─────────────────────────────────────────────────────────────────
// Plain words, the way lib/consult-reminders.js already says "UK time" and
// "Sydney time". Intl's short names are no good in a message: a Perth time
// would read "GMT+8" under en-GB.
const AU_ZONE_LABELS = {
  'Australia/Sydney': 'Sydney time',
  'Australia/Melbourne': 'Melbourne time',
  'Australia/Brisbane': 'Brisbane time',
  'Australia/Adelaide': 'Adelaide time',
  'Australia/Perth': 'Perth time',
  'Australia/Hobart': 'Hobart time',
  'Australia/Darwin': 'Darwin time'
};

function auZoneLabel(zone) {
  return AU_ZONE_LABELS[String(zone || '')] || '';
}

// "AWST", "AEDT", "ACST": the abbreviation Australians use, for the places
// that already print one (interview emails use en-AU's own short name).
function auZoneAbbreviation(zone, at) {
  try {
    const parts = new Intl.DateTimeFormat('en-AU', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(at));
    const found = parts.find((p) => p.type === 'timeZoneName');
    return found ? String(found.value || '').trim() : '';
  } catch (e) { return ''; }
}

// ── Local clock (WP-16: quiet hours) ───────────────────────────────────────

function clockIn(zone, nowMs) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const parts = {};
  fmt.formatToParts(new Date(nowMs)).forEach((p) => { parts[p.type] = p.value; });
  const hour = parseInt(parts.hour, 10) % 24;
  const minute = parseInt(parts.minute, 10);
  return { weekday: parts.weekday, hour: hour, minute: minute, minutes: hour * 60 + minute };
}

function looksLikeLead(subject) {
  if (!subject || typeof subject !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(subject, 'metadata') || Object.prototype.hasOwnProperty.call(subject, 'kind')) return true;
  return ['qualified', 'call_booked', 'nudges', 'timezone_source'].some((k) => Object.prototype.hasOwnProperty.call(subject, k));
}

/**
 * The local time, right now, for a lead or a doctor: the hook WP-16's quiet
 * hours gate calls. Returns { hour, minute, minutes, weekday, zone, source,
 * certain }.
 *
 *   subject  a site_enquiries row or its consult object (a LEAD), or a
 *            user_profiles row (a DOCTOR). Say which with opts.kind
 *            ('lead' | 'doctor') when the shape is ambiguous.
 *   opts     { kind, phone, bookingZone, viewerZone, isAu, country,
 *              auPathwayEnabled }
 *            isAu: the doctor is on an Australian pathway (the caller knows
 *            this from resolveCandidatePathway). Ignored for leads.
 *
 * An Australian-segment lead, or a doctor with isAu, is resolved by the
 * resolver above (switch on). Everyone else gets the zone the product has
 * always used for them (country, then dial code, then the UK for a lead;
 * the country guess for a doctor), with source 'legacy'.
 */
function localHourFor(subject, nowMs, opts) {
  const o = opts || {};
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const asLead = o.kind ? o.kind === 'lead' : looksLikeLead(subject);
  let resolved;
  if (asLead) {
    resolved = auLeadZone(subject, o);
    if (!resolved) {
      const consult = consultOf(subject) || {};
      const phone = o.phone || (subject && subject.phone) || '';
      const country = knownCountry(consult.country) || dialCountry(phone) || 'uk';
      resolved = { zone: interviewMeetings.gpTzForCountry(country), source: 'legacy', certain: true };
    }
  } else if (o.isAu === true && switchOn(o)) {
    resolved = auDoctorZone({ profile: subject, viewerZone: o.viewerZone, bookingZone: o.bookingZone, phone: o.phone });
  } else {
    const country = o.country != null ? o.country : (subject && subject.registration_country);
    resolved = { zone: interviewMeetings.gpTzForCountry(country), source: 'legacy', certain: true };
  }
  let clock;
  try { clock = clockIn(resolved.zone, now); }
  catch (e) { resolved = { zone: 'Europe/London', source: 'default', certain: false }; clock = clockIn('Europe/London', now); }
  return Object.assign({}, clock, resolved);
}

// ── Interview windows for a candidate on an Australian pathway ─────────────
//
// THE numbers, in one place (DAT-22, COM-19). Minutes from local midnight.
//
//   practice  Monday to Friday, 08:00 to 19:30 on the PRACTICE's clock.
//             08:00 to 18:00 is the practice's working day; the hour and a
//             half to 19:30 is there because a working GP often interviews
//             after clinic. An interview must END by the close, so with the
//             30-minute default the last start is 19:00. No weekends.
//   doctor    07:00 to 21:00 on the DOCTOR's clock, any day (the practice
//             side already rules out the weekend). It only bites across
//             zones: 08:00 in Sydney is 05:00 in Perth in summer, so a Perth
//             doctor is first offered 10:00 Sydney time.
//
// These replace, for Australian candidates only, the overseas set in
// lib/interview-meetings.js (host 11:00 to 02:00 Sydney, practice evenings
// and weekends, doctor 06:00 to 23:00), which was built so a UK evening
// overlaps. Overseas candidates keep that set untouched.
//
// Environment overrides, read at call time:
//   AU_INTERVIEW_PRACTICE_HOURS   "08:00-19:30"
//   AU_INTERVIEW_GP_HOURS         "07:00-21:00"
//   AU_INTERVIEW_WEEKENDS         "true" opens Saturday and Sunday with the
//                                 same practice hours (default: closed)
const AU_INTERVIEW_DEFAULTS = Object.freeze({
  practiceHours: Object.freeze([8 * 60, 19 * 60 + 30]),
  gpHours: Object.freeze([7 * 60, 21 * 60]),
  weekends: false
});

function parseHours(text, fallback) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text == null ? '' : text));
  if (!m) return fallback.slice();
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  if (!(Number(m[2]) < 60 && Number(m[4]) < 60 && from >= 0 && to <= 1440 && to > from)) return fallback.slice();
  return [from, to];
}

function auInterviewConfig(env) {
  const e = env || process.env || {};
  const practiceHours = parseHours(e.AU_INTERVIEW_PRACTICE_HOURS, AU_INTERVIEW_DEFAULTS.practiceHours);
  const gpHours = parseHours(e.AU_INTERVIEW_GP_HOURS, AU_INTERVIEW_DEFAULTS.gpHours);
  const weekends = String(e.AU_INTERVIEW_WEEKENDS || '').trim().toLowerCase() === 'true';
  return { practiceHours: practiceHours, gpHours: gpHours, weekends: weekends };
}

/**
 * The three scheduler parties for an Australian candidate, in the shape
 * lib/interview-scheduler.js computeInterviewSlots takes.
 *   host      the outer frame: business hours on the practice's clock. (The
 *             owner's diary is still subtracted from it as "busy", so clash
 *             prevention is unchanged.)
 *   practice  what applies until the practice has chosen its own times.
 *   gp        the doctor's reasonable hours, on the doctor's clock.
 */
function auInterviewParties(practiceTz, gpTz, env) {
  const cfg = auInterviewConfig(env);
  const weekend = cfg.weekends ? cfg.practiceHours.slice() : [0, 0];
  return {
    config: cfg,
    host: { tz: practiceTz, weekday: cfg.practiceHours.slice(), weekend: weekend.slice() },
    practiceDefault: { tz: practiceTz, weekday: cfg.practiceHours.slice(), weekend: weekend.slice(), overrides: [] },
    gp: { tz: gpTz, weekday: cfg.gpHours.slice(), weekend: cfg.gpHours.slice() }
  };
}

function clockLabel(min) {
  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return h12 + ':' + (m < 10 ? '0' + m : String(m)) + ' ' + (h24 < 12 ? 'am' : 'pm');
}

// "Monday to Friday, 8:00 am to 7:30 pm": the sentence shown to a practice.
function auInterviewHoursPhrase(env) {
  const cfg = auInterviewConfig(env);
  return (cfg.weekends ? 'Any day' : 'Monday to Friday') + ', ' + clockLabel(cfg.practiceHours[0]) + ' to ' + clockLabel(cfg.practiceHours[1]);
}

// What the practice's "choose interview times" page needs to offer only
// bookable times. Sent by the server for an Australian candidate only.
function auInterviewWindowView(practiceTz, env) {
  const cfg = auInterviewConfig(env);
  return {
    fromMin: cfg.practiceHours[0],
    toMin: cfg.practiceHours[1],
    weekdaysOnly: !cfg.weekends,
    practiceTz: practiceTz || '',
    practiceTzLabel: auZoneLabel(practiceTz) || '',
    note: 'Interviews are offered ' + auInterviewHoursPhrase(env)
      + (auZoneLabel(practiceTz) ? ' (' + auZoneLabel(practiceTz) + ')' : '') + '.'
  };
}

function wallToUtcMs(ymd, minutes, tz) {
  // The same arithmetic lib/interview-scheduler.js uses (required lazily: that
  // module has no dependency on this one).
  return require('./interview-scheduler.js').wallTimeToUtc(ymd, minutes, tz).getTime();
}

/**
 * Server-side check of ONE availability window a practice submitted for an
 * Australian candidate: { date: 'YYYY-MM-DD', fromMin, toMin }, typed on the
 * clock `windowTz` (the contact's device; the practice's zone when absent).
 * It must sit inside the practice's business hours ON THE PRACTICE'S CLOCK,
 * on a weekday there. Returns null when it is fine, else a sentence a
 * practice contact can act on.
 */
function auInterviewWindowError(w, opts) {
  const o = opts || {};
  const cfg = auInterviewConfig(o.env);
  const practiceTz = validZone(o.practiceTz) || AU_FALLBACK_ZONE;
  const windowTz = validZone(o.windowTz) || practiceTz;
  if (!w || typeof w !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String(w.date || ''))
    || !Number.isInteger(w.fromMin) || !Number.isInteger(w.toMin) || !(w.toMin > w.fromMin)) {
    return 'Each interview time needs a date, a start and a later finish.';
  }
  const phrase = auInterviewHoursPhrase(o.env);
  const place = auZoneLabel(practiceTz) ? ' (' + auZoneLabel(practiceTz) + ')' : '';
  const refusal = 'Interview times need to be ' + phrase + place + '. Please adjust the time on ' + w.date + '.';
  let startMs;
  let endMs;
  try {
    startMs = wallToUtcMs(w.date, w.fromMin, windowTz);
    endMs = wallToUtcMs(w.date, w.toMin, windowTz);
  } catch (e) { return refusal; }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return refusal;
  const start = clockIn(practiceTz, startMs);
  const end = clockIn(practiceTz, endMs - 60000); // the last minute of the window
  const weekend = (d) => d === 'Sat' || d === 'Sun';
  if (!cfg.weekends && (weekend(start.weekday) || weekend(end.weekday))) return refusal;
  if (start.weekday !== end.weekday) return refusal;
  if (start.minutes < cfg.practiceHours[0] || end.minutes + 1 > cfg.practiceHours[1]) return refusal;
  return null;
}

// First problem in a list of windows, or null.
function auInterviewWindowsError(windows, opts) {
  const list = Array.isArray(windows) ? windows : [];
  for (let i = 0; i < list.length; i++) {
    const reason = auInterviewWindowError(list[i], opts);
    if (reason) return reason;
  }
  return null;
}

// The wording of the interview-times request to a practice (P06) when the
// candidate is on an Australian pathway: no evenings-and-weekends ask, which
// only ever existed so a UK evening overlapped.
function auInterviewTimesAsk(gpName, env) {
  return 'Which times over the next 2 weeks suit to interview Dr ' + String(gpName || '').trim()
    + '? ' + auInterviewHoursPhrase(env) + ' works best.';
}

// ── Weekend skip for practice reminders (COM-27) ───────────────────────────

/**
 * Is it the weekend for this practice right now?
 *   switch OFF  the UTC day, exactly as before (so in Australian time it
 *               skips Monday morning and sends on Saturday morning);
 *   switch ON   the day on the practice's own clock (Sydney when unknown).
 * opts: { auPathwayEnabled, practiceTz }.
 */
function practiceWeekendNow(nowMs, opts) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (!switchOn(opts)) {
    const dow = new Date(now).getUTCDay();
    return dow === 0 || dow === 6;
  }
  const tz = validZone(opts && opts.practiceTz) || AU_FALLBACK_ZONE;
  let weekday;
  try { weekday = clockIn(tz, now).weekday; } catch (e) { weekday = clockIn(AU_FALLBACK_ZONE, now).weekday; }
  return weekday === 'Sat' || weekday === 'Sun';
}

module.exports = {
  AU_STATE_TZ,
  AU_STATES,
  AU_FALLBACK_ZONE,
  AU_ZONE_LABELS,
  AU_INTERVIEW_DEFAULTS,
  normaliseAuState,
  zoneForAuState,
  validZone,
  dialCountry,
  resolveZone,
  auLeadZone,
  withLeadZone,
  withLeadState,
  auDoctorZone,
  timezoneToStoreForState,
  auZoneLabel,
  auZoneAbbreviation,
  clockIn,
  localHourFor,
  auInterviewConfig,
  auInterviewParties,
  auInterviewHoursPhrase,
  auInterviewWindowView,
  auInterviewWindowError,
  auInterviewWindowsError,
  auInterviewTimesAsk,
  practiceWeekendNow
};

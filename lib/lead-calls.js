'use strict';
// Outbound AI phone calls to GP leads ("Hazel" on Retell) — the pure, testable
// half. server.js binds env, Supabase and the HTTP routes around these helpers:
//
//   /api/cron/lead-calls            every 5 min: pick leads, place calls via Retell
//   /api/webhooks/retell            call_started / call_ended / call_analyzed
//   /api/retell/tools/*             the tools Hazel calls mid-conversation
//
// Everything here is deterministic given its inputs (the clock is always an
// argument), so the decision rules can be pinned by tests without a server.
//
// Lead state lives on site_enquiries.metadata.consult:
//   consult.ai_call      — the latest call (status, outcome, attempt, timestamps, summary)
//   consult.ai_calls     — history, one entry per completed attempt
//   consult.stopped      — gains two values: 'do_not_call' and 'not_interested'
//   consult.calls_paused — owner switched Hazel off for this one lead (Leads tab)
//   consult.call_back_at — owner asked for a call at/after this time (Leads tab);
//                          cleared when the call is placed
// Full call records (transcript, recording, analysis) go to the lead_calls table.

const crypto = require('crypto');
const { gpTzForCountry } = require('./interview-meetings');

const SUPPORTED_COUNTRIES = ['uk', 'ie', 'nz', 'au'];

// Dial codes we are prepared to ring. A lead whose number carries any other
// code is skipped (the funnel only serves these four markets).
const DIAL_CODE_COUNTRY = { '+44': 'uk', '+353': 'ie', '+64': 'nz', '+61': 'au' };

// Local calling hours, in the LEAD's timezone. Minutes from midnight.
// Mon–Fri 09:00–19:30, Sat 10:00–16:00, never on Sunday. Night-time leads
// book a third as often as daytime ones (meta-performance notes, Oct 2026),
// and nobody wants a recruiter at 9pm — so the cron simply waits for morning.
const CALL_WINDOWS = {
  weekday: [9 * 60, 19 * 60 + 30],
  saturday: [10 * 60, 16 * 60],
  sunday: null
};

// Past leads ("backlog": older than cfg.backlogAfterMs with no call-back due)
// only ring when a UK GP can actually pick up: lunch and after surgery on
// weekdays, Saturday morning (owner 2026-10-31, "backlog windows"; the first
// live day's one booking came at 18:50, the morning calls all hit voicemail).
// Fresh leads keep the wide window because speed-to-lead beats timing. A day
// may hold several ranges.
const BACKLOG_WINDOWS = {
  weekday: [[12 * 60 + 30, 13 * 60 + 30], [17 * 60 + 30, 19 * 60 + 30]],
  saturday: [[10 * 60, 13 * 60]],
  sunday: null
};

// Outcomes a call can end with. `terminal` outcomes mean "never ring again".
const OUTCOMES = {
  booked:             { label: 'Booked on the call',      terminal: true },
  callback_requested: { label: 'Asked to be called back', terminal: false },
  link_sent:          { label: 'Booking link sent',       terminal: true },
  not_interested:     { label: 'Not interested',          terminal: true },
  not_a_gp:           { label: 'Not a GP',                terminal: true },
  wrong_number:       { label: 'Wrong number',            terminal: true },
  do_not_call:        { label: 'Asked not to be called',  terminal: true },
  already_booked:     { label: 'Already booked',          terminal: true },
  transferred:        { label: 'Transferred to the team', terminal: true },
  voicemail:          { label: 'Voicemail',               terminal: false },
  no_answer:          { label: 'No answer',               terminal: false },
  failed:             { label: 'Call failed',             terminal: false },
  unclear:            { label: 'Spoke, outcome unclear',  terminal: false }
};

const STOPPED_LABELS = {
  do_not_call: 'stopped — asked not to be called',
  not_interested: 'stopped — not interested'
};

// consult.stopped values that also stop the PHONE. The other values the
// nudge cron writes ('exhausted' = every chase email went, 'replied' = they
// answered an email) describe the email sequence, not the person's consent —
// a lead whose emails ran out unbooked is exactly who the past-leads calling
// campaign is for, so those stay ringable.
const CALL_STOP_REASONS = ['do_not_call', 'not_interested', 'unsubscribed', 'signed_up'];

// Plain words for every consult.stopped value (the Leads tab).
const STOP_REASON_LABELS = {
  do_not_call: 'asked not to be called',
  not_interested: 'not interested',
  unsubscribed: 'unsubscribed',
  signed_up: 'signed up',
  exhausted: 'every chase email sent',
  replied: 'replied to an email'
};

function parseLeadCallConfig(env) {
  const e = env || {};
  const num = (k, d) => { const n = parseInt(String(e[k] || ''), 10); return Number.isFinite(n) && n >= 0 ? n : d; };
  const list = (k) => String(e[k] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    enabled: String(e.LEAD_CALLS_ENABLED || '').trim().toLowerCase() === 'true',
    apiKey: String(e.RETELL_API_KEY || '').trim(),
    agentId: String(e.RETELL_AGENT_ID || '').trim(),
    fromNumbers: {
      uk: String(e.RETELL_FROM_NUMBER_UK || '').trim(),
      au: String(e.RETELL_FROM_NUMBER_AU || '').trim()
    },
    maxAttempts: num('LEAD_CALLS_MAX_ATTEMPTS', 2),
    retryAfterMs: num('LEAD_CALLS_RETRY_AFTER_MIN', 180) * 60000,
    minLeadAgeMs: num('LEAD_CALLS_MIN_LEAD_AGE_MIN', 3) * 60000,
    // Launch guard: never ring the back-catalogue. Only leads this fresh.
    maxLeadAgeMs: num('LEAD_CALLS_MAX_LEAD_AGE_DAYS', 3) * 86400000,
    // A lead this old is "backlog" and rings only in BACKLOG_WINDOWS
    // (LEAD_CALLS_BACKLOG_WINDOWS=false keeps the wide window for everyone).
    backlogAfterMs: num('LEAD_CALLS_BACKLOG_AFTER_HOURS', 24) * 3600000,
    backlogWindows: String(e.LEAD_CALLS_BACKLOG_WINDOWS || 'true').trim().toLowerCase() !== 'false',
    perRun: num('LEAD_CALLS_PER_RUN', 5),
    // Dry-run allow-list: when set, ONLY these numbers are ever dialled.
    testNumbers: list('LEAD_CALLS_TEST_NUMBERS').map(normalizeE164).filter(Boolean),
    directorName: String(e.LEAD_CALLS_DIRECTOR_NAME || '').trim() || 'our director',
    agentName: String(e.LEAD_CALLS_AGENT_NAME || '').trim() || 'Hayley'
  };
}

function normalizeE164(raw) {
  let s = String(raw || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) return '';
  const digits = s.slice(1);
  if (!/^\d{8,15}$/.test(digits)) return '';
  return '+' + digits;
}

function countryFromDialCode(e164) {
  const p = String(e164 || '');
  if (p.startsWith('+353')) return 'ie';
  if (p.startsWith('+44')) return 'uk';
  if (p.startsWith('+64')) return 'nz';
  if (p.startsWith('+61')) return 'au';
  return '';
}

// Which of our two numbers rings this lead. IE shares the UK number (closest
// presence), NZ shares the AU number.
function fromNumberForCountry(country, fromNumbers) {
  const f = fromNumbers || {};
  switch (String(country || '').toLowerCase()) {
    case 'uk': case 'ie': return f.uk || '';
    case 'au': case 'nz': return f.au || '';
    default: return '';
  }
}

// { weekday: 'Mon', minutes: 0..1439 } for an instant in a zone.
function localClock(nowMs, tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const parts = {};
  fmt.formatToParts(new Date(nowMs)).forEach((p) => { parts[p.type] = p.value; });
  const hour = parseInt(parts.hour, 10) % 24;
  return { weekday: parts.weekday, minutes: hour * 60 + parseInt(parts.minute, 10) };
}

function isWithinCallWindow(nowMs, tz, windows) {
  const w = windows || CALL_WINDOWS;
  let clock;
  try { clock = localClock(nowMs, tz); } catch (e) { return false; }
  let range;
  if (clock.weekday === 'Sun') range = w.sunday;
  else if (clock.weekday === 'Sat') range = w.saturday;
  else range = w.weekday;
  if (!range) return false;
  const ranges = Array.isArray(range[0]) ? range : [range];
  return ranges.some((r) => clock.minutes >= r[0] && clock.minutes < r[1]);
}

// Imported past leads (Zoho) are a backlog by definition: the age limit that
// stops the dialler ringing the back-catalogue on its own does not apply.
function isAgeExemptSource(row) {
  return String((row && row.metadata && row.metadata.source) || '') === 'zoho_import';
}

// Which calling hours apply to this lead right now.
function leadCallWindows(input) {
  const row = (input && input.row) || {};
  const nowMs = Number(input && input.nowMs) || Date.now();
  const cfg = (input && input.cfg) || parseLeadCallConfig({});
  if (input && input.due) return CALL_WINDOWS;
  if (!cfg.backlogWindows) return CALL_WINDOWS;
  const createdMs = Date.parse(row.created_at || '');
  return Number.isFinite(createdMs) && nowMs - createdMs > cfg.backlogAfterMs ? BACKLOG_WINDOWS : CALL_WINDOWS;
}

// A call registered or ongoing on this lead that has not reported back, and
// is young enough to still be live. Used for "one call at a time".
function callInFlight(row, nowMs) {
  const ai = row && row.metadata && row.metadata.consult && row.metadata.consult.ai_call;
  if (!ai || ai.completed_at) return false;
  const startedMs = Date.parse(ai.started_at || '');
  return Number.isFinite(startedMs) && (Number(nowMs) || Date.now()) - startedMs < 15 * 60000;
}

function leadPhoneE164(row) {
  return normalizeE164(row && row.phone);
}

function attemptsSoFar(consult) {
  const hist = Array.isArray(consult && consult.ai_calls) ? consult.ai_calls.length : 0;
  const live = consult && consult.ai_call && !consult.ai_call.completed_at ? 1 : 0;
  return hist + live;
}

// The one decision the cron makes per lead. Pure. Returns
//   { action: 'call', phone, country, tz, attempt }  or
//   { action: 'skip', reason }
function leadCallDecision(input) {
  const row = (input && input.row) || {};
  const nowMs = Number(input && input.nowMs) || Date.now();
  const cfg = (input && input.cfg) || parseLeadCallConfig({});
  const consult = row.metadata && row.metadata.consult;
  if (row.kind !== 'gp' || !consult) return { action: 'skip', reason: 'not_gp_lead' };
  if (row.status === 'converted') return { action: 'skip', reason: 'converted' };
  if (consult.call_booked) return { action: 'skip', reason: 'already_booked' };
  // Consent and outcome first: nothing below may override these.
  if (consult.stopped && CALL_STOP_REASONS.indexOf(consult.stopped) !== -1) return { action: 'skip', reason: 'stopped_' + consult.stopped };
  if (consult.calls_paused) return { action: 'skip', reason: 'paused' };
  // A call registered but never reported back: assume it's live for 15 min
  // (nothing else may ring over it), after that treat it as lost and let the
  // attempt count decide.
  const ai = consult.ai_call || null;
  if (ai && !ai.completed_at) {
    const startedMs = Date.parse(ai.started_at || '');
    if (Number.isFinite(startedMs) && nowMs - startedMs < 15 * 60000) return { action: 'skip', reason: 'call_in_progress' };
  }

  // A call-back that is DUE waives the filters that exist to stop the dialler
  // ringing the wrong people at the wrong time on its own initiative — the
  // screening flag, the lead-age guard, the attempt cap and the retry spacing
  // — because somebody (the doctor, via Hazel, or the owner, via the Leads
  // tab) explicitly asked for this call. Never waived: consent (above), the
  // phone/country checks, the dry-run allow-list and local calling hours.
  const ownerCbMs = Date.parse(consult.call_back_at || '');
  if (Number.isFinite(ownerCbMs) && nowMs < ownerCbMs) return { action: 'skip', reason: 'callback_later' };
  const ownerDue = Number.isFinite(ownerCbMs);
  let hazelDue = false;
  if (ai && ai.outcome === 'callback_requested' && ai.callback_at) {
    const cbMs = Date.parse(ai.callback_at);
    if (Number.isFinite(cbMs)) {
      if (nowMs < cbMs) return { action: 'skip', reason: 'callback_later' };
      hazelDue = true;
    }
  }
  const due = ownerDue || hazelDue;

  // qualified/screened_out are the screening verdict; is_gp alone is not (website
  // leads were stored with is_gp false when the question was never asked).
  if (!ownerDue && (consult.qualified !== true || consult.screened_out)) return { action: 'skip', reason: 'not_qualified' };

  const phone = leadPhoneE164(row);
  if (!phone) return { action: 'skip', reason: 'no_phone' };
  const country = String(consult.country || row.state || '').toLowerCase() || countryFromDialCode(phone);
  if (SUPPORTED_COUNTRIES.indexOf(country) === -1) return { action: 'skip', reason: 'country_not_served' };
  if (!countryFromDialCode(phone)) return { action: 'skip', reason: 'dial_code_not_served' };
  if (cfg.testNumbers.length && cfg.testNumbers.indexOf(phone) === -1) return { action: 'skip', reason: 'not_in_test_list' };

  const createdMs = Date.parse(row.created_at || '');
  if (!Number.isFinite(createdMs)) return { action: 'skip', reason: 'no_created_at' };
  const age = nowMs - createdMs;
  if (!due && age < cfg.minLeadAgeMs) return { action: 'skip', reason: 'too_new' };
  if (!due && !isAgeExemptSource(row) && age > cfg.maxLeadAgeMs) return { action: 'skip', reason: 'too_old' };

  if (ai) {
    const o = OUTCOMES[ai.outcome];
    // A terminal outcome ends the dialler's own attempts; only the OWNER's
    // explicit call-back re-opens it (Hazel's own callback is never terminal).
    if (o && o.terminal && !ownerDue) return { action: 'skip', reason: 'outcome_' + ai.outcome };
    const lastMs = Date.parse(ai.completed_at || ai.started_at || '');
    if (!due && Number.isFinite(lastMs) && nowMs - lastMs < cfg.retryAfterMs) return { action: 'skip', reason: 'retry_too_soon' };
  }
  const attempts = attemptsSoFar(consult);
  if (!due && attempts >= cfg.maxAttempts) return { action: 'skip', reason: 'max_attempts' };

  const tz = gpTzForCountry(country);
  // ignoreHours exists for the endpoint tests only; the cron passes it solely
  // under NODE_ENV=test so a test cannot pass or fail with the time of day.
  const windows = leadCallWindows({ row, nowMs, cfg, due });
  const windowKind = windows === BACKLOG_WINDOWS ? 'backlog' : 'fresh';
  if (!(input && input.ignoreHours) && !isWithinCallWindow(nowMs, tz, windows)) return { action: 'skip', reason: 'outside_hours', windows: windowKind };
  const from = fromNumberForCountry(country, cfg.fromNumbers);
  if (!from) return { action: 'skip', reason: 'no_from_number' };
  return { action: 'call', phone, country, tz, from, attempt: attempts + 1, windows: windowKind };
}

const COUNTRY_SPOKEN = { uk: 'the UK', ie: 'Ireland', nz: 'New Zealand', au: 'Australia' };

function firstNameOf(name) {
  const s = String(name || '').trim().replace(/^(dr|doctor)\.?\s+/i, '');
  const first = s.split(/\s+/)[0] || '';
  if (!first) return 'there';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function describeAge(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m <= 1 ? 'a minute ago' : m + ' minutes ago';
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? 'about an hour ago' : 'about ' + h + ' hours ago';
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : d + ' days ago';
}

function spokenLocalTime(nowMs, tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true });
  return fmt.format(new Date(nowMs)).replace(/\s+(am|pm)$/i, ' $1').replace(/,/g, '');
}

// Everything the prompt may reference as {{variable}}. Retell requires STRING
// values only — numbers and booleans are stringified here.
function buildLeadCallVariables(input) {
  const row = (input && input.row) || {};
  const consult = (row.metadata && row.metadata.consult) || {};
  const nowMs = Number(input && input.nowMs) || Date.now();
  const tz = (input && input.tz) || gpTzForCountry(consult.country || row.state);
  const country = String((input && input.country) || consult.country || row.state || '').toLowerCase();
  const source = String((row.metadata && row.metadata.source) || '');
  const createdMs = Date.parse(row.created_at || '');
  return {
    first_name: firstNameOf(row.name),
    full_name: String(row.name || '').trim() || 'there',
    country_spoken: COUNTRY_SPOKEN[country] || 'your country',
    country_code: country,
    lead_timezone: tz,
    local_time_now: spokenLocalTime(nowMs, tz),
    email_on_file: String(row.email || '').trim(),
    phone_on_file: leadPhoneE164(row),
    enquiry_when: source === 'zoho_import' ? 'a while back' : (Number.isFinite(createdMs) ? describeAge(nowMs - createdMs) : 'recently'),
    enquiry_source: source === 'zoho_import' ? 'your earlier registration with GP Link'
      : (/zoho_reengage/i.test(source) ? 'our WhatsApp message'
      : (/meta|facebook|instagram|fb/i.test(source) ? 'a Facebook ad' : 'our website')),
    enquiry_question: String(consult.call_question || row.message || '').trim().slice(0, 300),
    attempt: String((input && input.attempt) || 1),
    director_name: String((input && input.directorName) || '') || 'our director',
    agent_name: String((input && input.agentName) || '') || 'Hayley',
    system_timezone: tz
  };
}

// Retell signs every webhook and tool request: header X-Retell-Signature is
// "v=<unix ms>,d=<hex hmac-sha256(apiKey, rawBody + timestamp)>". Reject
// anything older than 5 minutes and compare in constant time.
function verifyRetellSignature(rawBody, signatureHeader, apiKey, nowMs) {
  if (!apiKey || !signatureHeader) return false;
  const m = /^v=(\d+),d=([0-9a-f]+)$/i.exec(String(signatureHeader).trim());
  if (!m) return false;
  const ts = parseInt(m[1], 10);
  const now = Number(nowMs) || Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 5 * 60000) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const expected = crypto.createHmac('sha256', apiKey).update(body + String(ts)).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(m[2].toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signRetellBody(rawBody, apiKey, nowMs) {
  const ts = String(Number(nowMs) || Date.now());
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  return 'v=' + ts + ',d=' + crypto.createHmac('sha256', apiKey).update(body + ts).digest('hex');
}

// Turn a finished Retell call object into our outcome vocabulary.
function outcomeFromCall(call) {
  const c = call || {};
  const reason = String(c.disconnection_reason || '');
  const analysis = c.call_analysis || {};
  const custom = analysis.custom_analysis_data || {};
  const extracted = String(custom.outcome || '').toLowerCase().trim();
  // A tool already stamped something authoritative (booked / not interested /
  // link sent) — never let the transcript model overrule it.
  if (reason === 'user_requested_dnc') return 'do_not_call';
  if (reason === 'voicemail_reached' || analysis.in_voicemail === true) return 'voicemail';
  if (reason === 'dial_no_answer' || reason === 'dial_busy' || reason === 'user_declined') return 'no_answer';
  if (reason === 'call_transfer' || reason === 'transfer_bridged') return 'transferred';
  if (/^(dial_failed|invalid_destination|telephony_provider|sip_routing|error_|registered_call_timeout|no_valid_payment|credit_exhausted|budget_reached|concurrency|no_concurrency)/.test(reason)) return 'failed';
  if (OUTCOMES[extracted]) return extracted;
  if (reason === 'ivr_reached') return 'no_answer';
  // The person spoke (we have a transcript) but the model could not classify it.
  if (String(c.transcript || '').trim()) return 'unclear';
  return 'no_answer';
}

function summarizeCallForLead(call, outcome, nowIso) {
  const c = call || {};
  const analysis = c.call_analysis || {};
  const custom = analysis.custom_analysis_data || {};
  const durationS = Number.isFinite(Number(c.duration_ms)) ? Math.round(Number(c.duration_ms) / 1000)
    : (Number.isFinite(Number(c.end_timestamp)) && Number.isFinite(Number(c.start_timestamp)) ? Math.round((Number(c.end_timestamp) - Number(c.start_timestamp)) / 1000) : 0);
  const entry = {
    call_id: String(c.call_id || ''),
    outcome,
    duration_s: durationS,
    disconnection_reason: String(c.disconnection_reason || ''),
    summary: String(analysis.call_summary || '').slice(0, 600),
    sentiment: String(analysis.user_sentiment || ''),
    completed_at: nowIso
  };
  if (custom.callback_time) entry.callback_note = String(custom.callback_time).slice(0, 120);
  if (custom.gp_status) entry.gp_status = String(custom.gp_status).slice(0, 40);
  if (custom.timeframe) entry.timeframe = String(custom.timeframe).slice(0, 120);
  if (custom.notes) entry.notes = String(custom.notes).slice(0, 400);
  if (c.recording_url) entry.recording_url = String(c.recording_url);
  return entry;
}

// Fold a Retell webhook event into the lead's consult object. Pure — returns
// a NEW consult (or null when nothing changes). Idempotent per (event, call_id).
function applyCallEventToConsult(consult, event, call, nowIso) {
  const c0 = consult || {};
  const callId = String((call && call.call_id) || '');
  if (!callId) return null;
  const ai = c0.ai_call && c0.ai_call.call_id === callId ? Object.assign({}, c0.ai_call) : null;
  const now = nowIso || new Date().toISOString();

  if (event === 'call_started') {
    if (!ai) return null;
    if (ai.status === 'ongoing' || ai.completed_at) return null;
    ai.status = 'ongoing';
    ai.answered_at = now;
    return Object.assign({}, c0, { ai_call: ai });
  }

  if (event === 'call_ended' || event === 'call_analyzed') {
    const base = ai || {
      call_id: callId,
      attempt: attemptsSoFar(c0) + 1,
      started_at: now,
      from_number: String((call && call.from_number) || '')
    };
    // call_analyzed carries the summary; call_ended arrives first without it.
    // Each may land twice (retries). Apply whichever is newer in information.
    if (event === 'call_ended' && base.analyzed_at) return null;
    if (event === 'call_analyzed' && base.analyzed_at) return null;
    const toolOutcome = base.tool_outcome || '';
    const outcome = OUTCOMES[toolOutcome] ? toolOutcome : outcomeFromCall(call);
    const entry = summarizeCallForLead(call, outcome, now);
    Object.assign(base, entry, { status: 'ended' });
    if (event === 'call_analyzed') base.analyzed_at = now;
    if (toolOutcome) base.tool_outcome = toolOutcome;
    const next = Object.assign({}, c0, { ai_call: base });
    // History: one entry per call id, replaced when the analysed version lands.
    const hist = (Array.isArray(c0.ai_calls) ? c0.ai_calls : []).filter((h) => h && h.call_id !== callId);
    hist.push(Object.assign({ attempt: base.attempt, started_at: base.started_at }, entry));
    next.ai_calls = hist.slice(-10);
    if (outcome === 'do_not_call' && !c0.stopped) next.stopped = 'do_not_call';
    if (outcome === 'not_interested' && !c0.stopped) next.stopped = 'not_interested';
    return next;
  }
  return null;
}

// ── Leads tab helpers (pure) ────────────────────────────────────────────────

// First instant at/after nowMs inside the lead's calling window (15-minute
// resolution, up to seven days out), or null. nowMs itself when already open.
function nextCallWindowStart(nowMs, tz, windows) {
  const step = 15 * 60000;
  const limit = nowMs + 7 * 86400000;
  let t = Number(nowMs) || Date.now();
  if (isWithinCallWindow(t, tz, windows)) return t;
  // Align to the next quarter hour so the answer reads as "9:00", not "9:07".
  t = Math.ceil(t / step) * step;
  while (t <= limit) {
    if (isWithinCallWindow(t, tz, windows)) return t;
    t += step;
  }
  return null;
}

// The lead's stage — ONE badge, most decisive fact first. Mirrors the owner's
// vocabulary: "burnt" = they told us to stop (unsubscribed, asked not to be
// called, not interested, or Hazel found they are not a GP); "not qualified"
// = they answered the screening questions and were turned down; "unscreened"
// = nobody ever asked (booked the Calendly link direct, or a plain website
// enquiry). A stranger on the calendar outranks "booked" on purpose: that is
// the thing to act on, and the booking time is still shown on the row.
function leadStage(row) {
  const r = row || {};
  const c = (r.metadata && r.metadata.consult) || {};
  const ai = c.ai_call || {};
  if (r.status === 'converted') return { key: 'signed_up', label: 'Signed up', mod: 'green', reason: '' };
  if (c.not_screened) return { key: 'unscreened', label: 'Never screened', mod: 'purple', reason: 'booked the calendar link direct' };
  if (c.call_booked) {
    if (c.call_completed_at) return { key: 'booked', label: 'Consult done', mod: 'green', reason: '' };
    return { key: 'booked', label: 'Booked', mod: 'blue', reason: '' };
  }
  let burnt = '';
  if (c.stopped === 'do_not_call' || ai.outcome === 'do_not_call') burnt = 'asked not to be called';
  else if (c.stopped === 'unsubscribed') burnt = 'unsubscribed';
  else if (ai.outcome === 'not_a_gp' || ai.tool_outcome === 'not_a_gp') burnt = 'not a GP (said on the call)';
  else if (c.stopped === 'not_interested' || ai.outcome === 'not_interested') burnt = 'not interested (said on the call)';
  if (burnt) return { key: 'burnt', label: 'Burnt', mod: 'red', reason: burnt };
  if (c.screened_out || (c.is_gp === false && c.qualified !== true)) return { key: 'not_qualified', label: 'Not qualified', mod: 'muted', reason: 'failed the screening questions' };
  if (c.qualified === true) return { key: 'open', label: 'Open', mod: 'amber', reason: '' };
  return { key: 'unscreened', label: 'Never screened', mod: 'purple', reason: 'website enquiry, no screening answers' };
}

// Hazel's plan for this lead, in words: will she ring, when, and if not, why.
// Pure — the cron's own decision function decides, this only explains it.
//   state: queued | scheduled | retry | in_progress | done | gave_up |
//          burnt | blocked | paused | none
function leadCallPlan(input) {
  const row = (input && input.row) || {};
  const nowMs = Number(input && input.nowMs) || Date.now();
  const cfg = (input && input.cfg) || parseLeadCallConfig({});
  const c = (row.metadata && row.metadata.consult) || {};
  const ai = c.ai_call || null;
  const lastLabel = ai && OUTCOMES[ai.outcome] ? OUTCOMES[ai.outcome].label : '';
  const plan = (state, label, detail, dueAt, reason) => ({
    state, label, detail: detail || '', due_at: dueAt || '', reason: reason || ''
  });
  const country = String(c.country || row.state || '').toLowerCase() || countryFromDialCode(leadPhoneE164(row));
  const tz = gpTzForCountry(country);
  const d = leadCallDecision({ row, nowMs, cfg, ignoreHours: true });
  if (d.action === 'call') {
    const openMs = nextCallWindowStart(nowMs, tz, d.windows === 'backlog' ? BACKLOG_WINDOWS : CALL_WINDOWS);
    if (openMs === nowMs) return plan('queued', 'Queued — rings within 5 minutes', '', new Date(nowMs).toISOString(), 'call');
    return plan('queued', 'Queued — next calling window', d.windows === 'backlog' ? 'past lead: lunch, evening or Saturday morning only' : '', openMs ? new Date(openMs).toISOString() : '', 'call');
  }
  const r = d.reason;
  const retryDue = ai ? Date.parse(ai.completed_at || ai.started_at || '') + cfg.retryAfterMs : NaN;
  switch (r) {
    case 'callback_later': {
      const ownerMs = Date.parse(c.call_back_at || '');
      if (Number.isFinite(ownerMs) && nowMs < ownerMs) return plan('scheduled', 'Call-back scheduled by you', '', new Date(ownerMs).toISOString(), r);
      return plan('scheduled', 'Call-back requested by the doctor', (ai && (ai.callback_note || ai.note)) || '', (ai && ai.callback_at) || '', r);
    }
    case 'retry_too_soon':
      return plan('retry', 'Retry scheduled', lastLabel ? 'after ' + lastLabel.toLowerCase() : '', Number.isFinite(retryDue) ? new Date(retryDue).toISOString() : '', r);
    case 'call_in_progress':
      return plan('in_progress', ai && ai.status === 'ongoing' ? 'On the phone now' : 'Ringing now', '', '', r);
    case 'too_new':
      return plan('queued', 'Queued — rings in a few minutes', 'new leads get ' + Math.round(cfg.minLeadAgeMs / 60000) + ' minutes for the confirmation email to land', '', r);
    case 'max_attempts': {
      const hist = Array.isArray(c.ai_calls) ? c.ai_calls : [];
      const seen = hist.map((h) => (OUTCOMES[h && h.outcome] || {}).label || '').filter(Boolean);
      return plan('gave_up', 'Gave up after ' + hist.length + ' attempt' + (hist.length === 1 ? '' : 's'), seen.join(', ').toLowerCase(), '', r);
    }
    case 'outcome_booked':      return plan('done', 'Booked on the call', '', '', r);
    case 'outcome_link_sent':   return plan('done', 'Booking link sent — no further calls', '', '', r);
    case 'outcome_already_booked': return plan('done', 'Already booked — no further calls', '', '', r);
    case 'outcome_transferred': return plan('done', 'Transferred to the team', '', '', r);
    case 'outcome_not_interested': return plan('burnt', 'Not interested — no more calls', '', '', r);
    case 'outcome_not_a_gp':    return plan('burnt', 'Not a GP — no more calls', '', '', r);
    case 'outcome_wrong_number': return plan('burnt', 'Wrong number — no more calls', 'emails and WhatsApp still go', '', r);
    case 'outcome_do_not_call': return plan('burnt', 'Asked not to be called', '', '', r);
    case 'paused':              return plan('paused', 'Paused by you', '', '', r);
    case 'no_phone':            return plan('blocked', 'No phone number', '', '', r);
    case 'country_not_served':
    case 'dial_code_not_served': return plan('blocked', 'Number outside the UK, Ireland, Australia or New Zealand', '', '', r);
    case 'not_in_test_list':    return plan('blocked', 'Test mode — number not on the allow-list', '', '', r);
    case 'no_from_number':      return plan('blocked', 'No outbound number set up for ' + (COUNTRY_SPOKEN[country] || 'this country'), '', '', r);
    case 'no_created_at':       return plan('blocked', 'No arrival date on the lead', '', '', r);
    case 'too_old': {
      const days = Math.round(cfg.maxLeadAgeMs / 86400000);
      return plan('blocked', 'Older than the dialler\'s ' + days + '-day limit', 'schedule a call-back to ring anyway, or raise LEAD_CALLS_MAX_LEAD_AGE_DAYS', '', r);
    }
    case 'not_qualified':
    case 'already_booked':
    case 'converted':
    case 'not_gp_lead':
      return plan('none', lastLabel, '', '', r);
    default:
      if (r && r.indexOf('stopped_') === 0) {
        // Hazel's own "not a GP" / "not interested" stamp also sets
        // consult.stopped = 'not_interested'; say what she actually heard.
        if (r === 'stopped_not_interested' && ai && (ai.outcome === 'not_a_gp' || ai.tool_outcome === 'not_a_gp')) return plan('burnt', 'Not a GP — no more calls', '', '', r);
        if (r === 'stopped_not_interested' && ai && ai.outcome === 'not_interested') return plan('burnt', 'Not interested — no more calls', '', '', r);
        const why = STOP_REASON_LABELS[r.slice(8)] || r.slice(8).replace(/_/g, ' ');
        return plan('burnt', 'No calls — ' + why, '', '', r);
      }
      return plan('blocked', 'Not ringing', r ? r.replace(/_/g, ' ') : '', '', r);
  }
}

// ── Calendly slot helpers ───────────────────────────────────────────────────

// 7-day windows (Calendly's per-request limit) starting two hours from now.
function calendlyAvailabilityWindows(nowMs, days) {
  const total = Math.max(1, Math.min(31, Number(days) || 14));
  const start = nowMs + 2 * 3600000;
  const out = [];
  let cursor = start;
  const end = start + total * 86400000;
  while (cursor < end) {
    const next = Math.min(cursor + 7 * 86400000, end);
    out.push({ start_time: new Date(cursor).toISOString(), end_time: new Date(next).toISOString() });
    cursor = next;
  }
  return out;
}

function slotLocalParts(iso, tz) {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true, hourCycle: 'h12'
  });
  const parts = {};
  fmt.formatToParts(d).forEach((p) => { parts[p.type] = (parts[p.type] || '') + p.value; });
  const clock24 = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(d);
  const hour24 = parseInt(clock24, 10);
  const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return {
    weekday: parts.weekday,
    minute: parseInt(parts.minute, 10),
    day: parts.day,
    month: parts.month,
    time: (parts.hour + ':' + parts.minute + ' ' + String(parts.dayPeriod || '').toLowerCase()).replace(/\s+/g, ' ').trim(),
    hour24,
    dayKey
  };
}

function formatSlotForSpeech(iso, tz) {
  const p = slotLocalParts(iso, tz);
  return p.weekday + ' the ' + ordinal(parseInt(p.day, 10)) + ' of ' + p.month + ' at ' + p.time;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

const TIME_OF_DAY = {
  morning: [6, 12],
  afternoon: [12, 17],
  evening: [17, 22],
  any: [7, 22]
};

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// From Calendly's available times (status 'available'), choose what to read
// out: at most `limit` slots in the lead's own hours, honouring a day or
// time-of-day preference, spread across days so the two offers differ.
function pickSlots(available, opts) {
  const o = opts || {};
  const tz = o.tz || 'Europe/London';
  const limit = Math.max(1, Math.min(5, Number(o.limit) || 3));
  const tod = TIME_OF_DAY[String(o.timeOfDay || 'any').toLowerCase()] || TIME_OF_DAY.any;
  const pref = String(o.preferredDay || '').toLowerCase().trim();
  const nowMs = Number(o.nowMs) || Date.now();
  const rows = (Array.isArray(available) ? available : [])
    .filter((s) => s && (s.status === 'available' || !s.status) && s.start_time)
    .map((s) => ({ start: s.start_time, ms: Date.parse(s.start_time) }))
    .filter((s) => Number.isFinite(s.ms) && s.ms > nowMs + 90 * 60000)
    .sort((a, b) => a.ms - b.ms);
  const todayKey = slotLocalParts(new Date(nowMs).toISOString(), tz).dayKey;
  const tomorrowKey = slotLocalParts(new Date(nowMs + 86400000).toISOString(), tz).dayKey;
  const scored = [];
  rows.forEach((s) => {
    const p = slotLocalParts(s.start, tz);
    if (p.hour24 < tod[0] || p.hour24 >= tod[1]) return;
    // Calendly can list 5-minute start increments (1:30, 1:35, 1:40); the
    // consultations run on the hour and half hour, and three adjacent times read
    // out on a call sound like a glitch, so only :00 and :30 are ever offered.
    if (p.minute % 30 !== 0) return;
    if (pref) {
      const wd = p.weekday.toLowerCase();
      if (pref === 'today' && p.dayKey !== todayKey) return;
      else if (pref === 'tomorrow' && p.dayKey !== tomorrowKey) return;
      else if (WEEKDAYS.indexOf(pref) !== -1 && wd !== pref) return;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(pref) && p.dayKey !== pref) return;
    }
    scored.push({ start: s.start, ms: s.ms, dayKey: p.dayKey, spoken: formatSlotForSpeech(s.start, tz) });
  });
  // Spread across days first, then fill from the remainder.
  const picked = [];
  const seenDays = new Set();
  scored.forEach((s) => {
    if (picked.length >= limit) return;
    if (seenDays.has(s.dayKey)) return;
    seenDays.add(s.dayKey);
    picked.push(s);
  });
  scored.forEach((s) => {
    if (picked.length >= limit) return;
    if (picked.find((p) => p.start === s.start)) return;
    picked.push(s);
  });
  return picked.sort((a, b) => a.ms - b.ms).map((s) => ({ start_time: s.start, spoken: s.spoken }));
}

function splitName(full) {
  const s = String(full || '').trim().replace(/^(dr|doctor)\.?\s+/i, '');
  const parts = s.split(/\s+/).filter(Boolean);
  if (!parts.length) return { first_name: 'GP', last_name: 'Link lead', name: 'GP Link lead' };
  if (parts.length === 1) return { first_name: parts[0], last_name: '-', name: parts[0] };
  return { first_name: parts[0], last_name: parts.slice(1).join(' '), name: s };
}

// POST /invitees body. Required custom questions on the event type must be
// answered or Calendly rejects the booking: the phone question gets the lead's
// number, anything else required gets a short note.
function buildCalendlyInviteeBody(input) {
  const i = input || {};
  const nm = splitName(i.name);
  const qa = [];
  // A caller's own note (the /start question box) goes into the first free-text
  // question whether or not Calendly marks it required; required questions
  // without a note get the default line so the booking is never rejected.
  let noteUsed = false;
  (Array.isArray(i.customQuestions) ? i.customQuestions : []).forEach((q, idx) => {
    if (!q || q.enabled === false) return;
    const type = String(q.type || '').toLowerCase();
    const label = String(q.name || '').toLowerCase();
    const position = Number.isFinite(Number(q.position)) ? Number(q.position) : idx;
    if (type === 'phone_number' || /phone|mobile|whatsapp/.test(label)) {
      if (i.phone) qa.push({ question: String(q.name || 'Phone'), answer: String(i.phone), position });
    } else if (q.required || (i.note && !noteUsed && (!type || type === 'text' || type === 'string'))) {
      const useNote = Boolean(i.note) && !noteUsed;
      qa.push({ question: String(q.name || 'Note'), answer: useNote ? String(i.note) : 'Booked over the phone with ' + (i.agentName || 'Hayley') + ' from GP Link.', position });
      if (useNote) noteUsed = true;
    }
  });
  const body = {
    event_type: String(i.eventTypeUri || ''),
    start_time: String(i.startTime || ''),
    invitee: {
      name: nm.name,
      first_name: nm.first_name,
      last_name: nm.last_name,
      email: String(i.email || '').trim().toLowerCase(),
      timezone: String(i.tz || 'Europe/London')
    },
    // Calendly rejects a partial tracking object (400 "is missing" for the
    // absent keys), so every tracking field is sent, null where unused. The
    // default names Hazel's phone booking; the /start slot picker passes its
    // own block so the webhook can tell the two apart.
    tracking: Object.assign(
      { utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null, salesforce_uuid: null },
      (i.tracking && typeof i.tracking === 'object') ? i.tracking : { utm_source: 'ai_call', utm_medium: 'phone', utm_campaign: 'hazel' }
    )
  };
  if (qa.length) body.questions_and_answers = qa;
  if (i.locationKind) body.location = { kind: String(i.locationKind) };
  return body;
}

module.exports = {
  SUPPORTED_COUNTRIES,
  CALL_WINDOWS,
  BACKLOG_WINDOWS,
  leadCallWindows,
  callInFlight,
  isAgeExemptSource,
  OUTCOMES,
  STOPPED_LABELS,
  CALL_STOP_REASONS,
  STOP_REASON_LABELS,
  parseLeadCallConfig,
  normalizeE164,
  countryFromDialCode,
  fromNumberForCountry,
  localClock,
  isWithinCallWindow,
  leadPhoneE164,
  attemptsSoFar,
  leadCallDecision,
  nextCallWindowStart,
  leadStage,
  leadCallPlan,
  firstNameOf,
  buildLeadCallVariables,
  verifyRetellSignature,
  signRetellBody,
  outcomeFromCall,
  summarizeCallForLead,
  applyCallEventToConsult,
  calendlyAvailabilityWindows,
  formatSlotForSpeech,
  pickSlots,
  splitName,
  buildCalendlyInviteeBody
};

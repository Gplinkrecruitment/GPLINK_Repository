'use strict';

// CEO Overview "Pipeline & money" board (owner picked mockup A "Board",
// 26 Nov 2026). Pure — no DB, no env, no clock of its own (nowMs comes in).
//
// Two kinds of people end up on the board:
//   * doctors the app already knows about (gp_applications, placements,
//     registration_cases, user_profiles, career_contracts, scheduled_calls) —
//     their stage is read live from those tables;
//   * pipeline_people rows the owner (or the WhatsApp export / the email
//     contract scan) added for doctors the app can't see. A row that carries a
//     user_id rides on the app person and supplies the owner's next step, wait
//     note, notes and heat override.
// People are deduped by user_id, then normalised phone (last 9 digits), then
// normalised name. Invoices come from the Xero mirror (xero_invoices) and are
// attached to the person whose name the Xero sync read off the invoice line.
//
// Invoices the owner marked paid outside Xero / not owed (xero_invoices.owner_status)
// are listed as 'xero_fix' and never counted as owed; payment-plan groups add a
// 'coming' row for the instalments Xero has not been invoiced for yet.
//
// Schema contract: supabase/migrations/20261126120000_ceo_pipeline_board.sql
// + 20261126130000_xero_invoice_owner_status.sql
// + 20261126140000_income_expectations.sql (the forecast's manual rows).
//
// The payload's `forecast` (when money should arrive, month by month) is built
// by lib/income-forecast.js from what this file has already worked out.

var reviewQueue = require('./ceo-review-queue.js');
var incomeForecast = require('./income-forecast.js');

var DAY_MS = 86400000;
var HOUR_MS = 3600000;

var STAGES = [
  { k: 'warm', l: 'Warm, not in app', hint: 'Only in your WhatsApp' },
  { k: 'consult', l: 'Consult / signing up', hint: 'Talked, not matched yet' },
  { k: 'matched', l: 'Matched / interview', hint: 'With a practice' },
  { k: 'signed', l: 'Signed', hint: 'Contract done, registration' },
  { k: 'visa', l: 'Visa', hint: 'AHPRA done' },
  { k: 'started', l: 'Started work', hint: '' }
];
var STAGE_RANK = { warm: 0, consult: 1, matched: 2, signed: 3, visa: 4, started: 5 };
// Every value the migration's check constraint accepts.
var ROW_STAGES = ['warm', 'consult', 'matched', 'signed', 'visa', 'started', 'later', 'closed'];

// Rules (kept as named constants so the tests and the page read the same).
var RED_AFTER_MS = 12 * HOUR_MS;           // a message from them unanswered this long = waiting on you
var DT_LOOKBACK_MS = 14 * DAY_MS;          // business-WhatsApp messages older than this never turn a card red
var INTERVIEW_STUCK_MS = 7 * DAY_MS;       // interview done, no decision
var MATCH_STUCK_MS = 3 * DAY_MS;           // matched, not sent to the practice
var STALE_MS = 21 * DAY_MS;                // matched/signed with nothing moving
var HOT_MS = 7 * DAY_MS;
var WARM_MS = 21 * DAY_MS;
var CONSULT_RECENT_MS = 60 * DAY_MS;       // an app account with no application shows for this long
var WA_EXPORT_STALE_MS = 3 * DAY_MS;

var SECURED_STATUSES = ['hired', 'secured', 'placed', 'placement_secured', 'contract_signed'];
var DEAD_APP_STATUSES = ['withdrawn', 'rejected', 'declined', 'not_proceeding', 'unsuccessful', 'closed', 'cancelled'];
var DEAD_MATCH_OUTCOMES = ['declined', 'expired', 'position_filled'];
var LIVE_ATS_STAGES = ['applied', 'submitted', 'reviewing', 'interview', 'offer'];
var CASE_STAGE_LABEL = { myintealth: 'MyIntealth', amc: 'AMC', career: 'Secure placement', ahpra: 'AHPRA', visa: 'Visa', pbs: 'PBS & Medicare', commencement: 'Commencement', complete: 'Complete' };
var VISA_CASE_STAGES = ['visa', 'pbs', 'commencement'];
var SIGNED_CASE_STAGES = ['ahpra', 'visa', 'pbs', 'commencement', 'complete'];

var XERO_VIEW = 'https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=';
var GMAIL_THREAD = 'https://mail.google.com/mail/u/?authuser=hello@mygplink.com.au#all/';

// ── small helpers ───────────────────────────────────────────────
function arr(v) { return Array.isArray(v) ? v.filter(Boolean) : []; }
function str(v) { return v == null ? '' : String(v); }
function lower(v) { return str(v).trim().toLowerCase(); }
function ms(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  var s = String(v);
  // A bare date ('2026-11-20') is a calendar day: read it as UTC midnight.
  var t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : s);
  return Number.isFinite(t) ? t : NaN;
}
function maxMs() {
  var best = NaN;
  for (var i = 0; i < arguments.length; i++) {
    var t = ms(arguments[i]);
    if (Number.isFinite(t) && (!Number.isFinite(best) || t > best)) best = t;
  }
  return best;
}
function num(v) { var n = Number(v); return Number.isFinite(n) ? n : null; }
function clip(s, n) { var t = str(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; }
function money(v) {
  var n = num(v);
  if (n === null) return '';
  return '$' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

// 'dr hatice akkas' -> 'hatice akkas'. Diacritics, titles, brackets and
// punctuation are dropped so "Dr. Hatice Akkas" and "hatice  akkas" meet.
function normName(name) {
  var s = str(name).normalize ? str(name).normalize('NFKD').replace(/[̀-ͯ]/g, '') : str(name);
  s = s.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z\s'-]/g, ' ').replace(/['-]/g, '');
  var words = s.split(/\s+/).filter(Boolean);
  while (words.length && /^(dr|doctor|prof|mr|mrs|ms|miss)$/.test(words[0])) words.shift();
  return words.join(' ');
}
function phoneKey(phone) {
  var d = str(phone).replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : '';
}
function namesMatch(a, b) {
  var x = normName(a), y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  var xs = x.split(' '), ys = y.split(' ');
  if (xs.length < 2 || ys.length < 2) return false;
  return xs[0] === ys[0] && xs[xs.length - 1] === ys[ys.length - 1];
}

// ── payment plans (Xero) ────────────────────────────────────────
// A plan is a root invoice ("PAYMENT PLAN: … Total fee: $25,000 excl GST …
// Duration: 6 months") plus monthly instalments whose reference is the root's
// number (INV-879 + INV-0014/15/16). Only what has been invoiced is in Xero,
// so the rest of the plan is worked out from the root's terms.
var PLAN_RE = /PAYMENT\s*PLAN/i;
var INV_NO_RE = /^INV-?\d+$/;
var GST_RATE = 0.10;
function invNo(v) { return str(v).trim().toUpperCase().replace(/\s+/g, ''); }
function isPlanInvoice(i) { return PLAN_RE.test(str(i && i.line_text)) || PLAN_RE.test(str(i && i.reference)); }
// The plan an invoice belongs to: its reference when that is an invoice
// number, else the invoice's own number (the root).
function planIdOf(i) { var ref = invNo(i.reference); return INV_NO_RE.test(ref) ? ref : invNo(i.invoice_number); }
function parsePlanTerms(text) {
  var t = str(text);
  var out = { total_inc: null, months: null, candidate: '' };
  var m = /Total\s+fee\s*:?\s*(?:AUD\s*)?\$?\s*([\d,]+(?:\.\d+)?)/i.exec(t);
  if (m) {
    var amt = Number(m[1].replace(/,/g, ''));
    var tail = t.slice(m.index + m[0].length, m.index + m[0].length + 40);
    // "incl GST" is already the gross; anything else ("excl GST", nothing) gets 10% added.
    if (amt > 0) out.total_inc = /^\s*(?:AUD\s*)?\(?\s*inc(?:l|\b|\.)/i.test(tail) ? amt : Math.round(amt * (1 + GST_RATE) * 100) / 100;
  }
  var d = /Duration\s*:?\s*(\d{1,2})\s*months?/i.exec(t);
  if (d && Number(d[1]) > 0) out.months = Number(d[1]);
  var c = /Candidate\s*:\s*([^\n\r]+)/i.exec(t);
  if (c) out.candidate = c[1].trim().replace(/[\s.;,]+$/, '').slice(0, 120);
  return out;
}
// Next instalment: a month after the latest invoice, on that invoice's due day.
function nextInstalment(latest) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(latest && latest.invoice_date));
  if (!m) return null;
  var dm = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(latest.due_date));
  var y = Number(m[1]), mo = Number(m[2]) + 1;
  if (mo > 12) { mo = 1; y++; }
  var dayOf = dm ? Number(dm[3]) : Number(m[3]);
  var last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  var dd = Math.min(dayOf, last);
  return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (dd < 10 ? '0' : '') + dd;
}

var _fmt = {};
function fmtParts(tz, t, opts) {
  var key = tz + JSON.stringify(opts);
  if (!_fmt[key]) _fmt[key] = new Intl.DateTimeFormat('en-AU', Object.assign({ timeZone: tz }, opts));
  var out = {};
  _fmt[key].formatToParts(new Date(t)).forEach(function (p) { if (p.type !== 'literal') out[p.type] = p.value; });
  return out;
}
function dayKey(t, tz) {
  var p = fmtParts(tz, t, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return p.year + '-' + p.month + '-' + p.day;
}
// '22 Nov' (adds the year when it is not this year).
function fmtDay(v, tz, nowMs) {
  var t = ms(v); if (!Number.isFinite(t)) return '';
  var p = fmtParts(tz, t, { day: 'numeric', month: 'short', year: 'numeric' });
  var sameYear = fmtParts(tz, nowMs, { year: 'numeric' }).year === p.year;
  return p.day + ' ' + p.month + (sameYear ? '' : ' ' + p.year);
}
// Calendar-date columns (due_date) are not instants: print them as written.
function fmtDate(v, nowMs) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(v));
  if (!m) return '';
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var y = Number(m[1]);
  return Number(m[3]) + ' ' + months[Number(m[2]) - 1] + (y === new Date(nowMs).getUTCFullYear() ? '' : ' ' + y);
}
function fmtWhen(v, tz, nowMs) {
  var t = ms(v); if (!Number.isFinite(t)) return '';
  if (dayKey(t, tz) === dayKey(nowMs, tz)) {
    var p = fmtParts(tz, t, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return 'today, ' + p.hour + ':' + p.minute;
  }
  return fmtDay(t, tz, nowMs);
}
function ago(t, nowMs) {
  var d = nowMs - t;
  if (d < HOUR_MS) return Math.max(1, Math.round(d / 60000)) + ' min ago';
  if (d < 48 * HOUR_MS) return Math.round(d / HOUR_MS) + ' h ago';
  return Math.round(d / DAY_MS) + ' days ago';
}
function ageDays(t, nowMs) { return Math.max(0, Math.round((nowMs - t) / DAY_MS)); }

function profileName(p) {
  if (!p) return '';
  var n = [str(p.first_name).trim(), str(p.last_name).trim()].filter(Boolean).join(' ');
  if (n) return /^dr\b/i.test(n) ? n : 'Dr ' + n;
  var e = lower(p.email);
  return e.indexOf('@') > 0 ? e.slice(0, e.indexOf('@')) : '';
}

// First non-empty metadata[key] across a person's pipeline_people rows.
function rowMeta(rows, key) {
  var rs = arr(rows);
  for (var k = 0; k < rs.length; k++) { var m = rs[k].metadata; if (m && typeof m === 'object' && m[key] != null && str(m[key]).trim() !== '') return m[key]; }
  return null;
}
// metadata.fee_first_half_paid — the first 50% paid outside Xero (e.g. an old
// Zoho invoice): { invoice, amount_inc_gst, paid_on, payer, evidence }.
function firstHalfPaid(rows) {
  var v = rowMeta(rows, 'fee_first_half_paid');
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

// The gmail message id of the email find a row is waiting on.
function rowFindId(r) {
  var m = r && r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
  if (m.gmail_message_id) return str(m.gmail_message_id);
  return r && str(r.source) === 'email_contract' ? str(r.source_ref) : '';
}

// ── app-side stage derivation ───────────────────────────────────
function appStatusKey(a) { return lower(a && a.status).replace(/[\s-]+/g, '_'); }
function appIsSecured(a) { return SECURED_STATUSES.indexOf(appStatusKey(a)) !== -1 || lower(a && a.ats_stage) === 'hired'; }
function appIsLive(a) {
  if (!a) return false;
  if (a.withdrawn_at) return false;
  if (DEAD_APP_STATUSES.indexOf(appStatusKey(a)) !== -1) return false;
  if (lower(a.ats_stage) === 'not_proceeding') return false;
  if (DEAD_MATCH_OUTCOMES.indexOf(lower(a.match_outcome)) !== -1) return false;
  var st = lower(a.ats_stage) || 'applied';
  return LIVE_ATS_STAGES.indexOf(st) !== -1 || /^interview/.test(appStatusKey(a));
}
function appInInterview(a) { return lower(a.ats_stage) === 'interview' || /^interview/.test(appStatusKey(a)); }
// AI/staff matches sit at ats_stage 'applied' until someone sends them to the practice.
function appNotSent(a) {
  var o = lower(a.origin);
  return (lower(a.ats_stage) || 'applied') === 'applied' && !!(a.matched_at || o === 'ai_matched' || o === 'admin_applied');
}

// ── freshness ───────────────────────────────────────────────────
function syncRow(rows, source) { return arr(rows).filter(function (r) { return r.source === source; })[0] || null; }
function freshness(inp, nowMs) {
  var rows = arr(inp.pipeline_sync_state);
  var out = {};
  var x = syncRow(rows, 'xero');
  var xOk = x ? ms(x.last_ok_at) : NaN;
  if (Number.isFinite(xOk)) out.xero = { state: (nowMs - xOk) > 6 * HOUR_MS ? 'stale' : 'ok', at: new Date(xOk).toISOString(), label: 'Xero checked ' + ago(xOk, nowMs) };
  else if (x && x.last_error) out.xero = { state: 'error', at: null, label: 'Xero sync failing: ' + clip(x.last_error, 80) };
  else out.xero = { state: 'never', at: null, label: 'Xero not connected' };

  var w = syncRow(rows, 'whatsapp_export');
  // Age of the EXPORT (what the owner's WhatsApp looked like), not of the upload.
  var wAt = w ? ms(w.detail && (w.detail.exportedAtIso || w.detail.exported_at_iso)) : NaN;
  if (w && !Number.isFinite(wAt)) wAt = ms(w.last_ok_at);
  if (Number.isFinite(wAt)) {
    var wd = ageDays(wAt, nowMs);
    var stale = (nowMs - wAt) > WA_EXPORT_STALE_MS;
    out.whatsapp_export = { state: stale ? 'stale' : 'ok', at: new Date(wAt).toISOString(), label: 'WhatsApp export ' + (wd === 0 ? 'from today' : plural(wd, 'day') + ' old') + (stale ? ' — upload a new one' : '') };
  } else out.whatsapp_export = { state: 'never', at: null, label: 'No WhatsApp export yet — upload one' };

  var e = syncRow(rows, 'email_scan');
  var eOk = e ? ms(e.last_ok_at) : NaN;
  if (Number.isFinite(eOk)) out.email_scan = { state: (nowMs - eOk) > 3 * HOUR_MS ? 'stale' : 'ok', at: new Date(eOk).toISOString(), label: 'Email scan ' + ago(eOk, nowMs) };
  else if (e && e.last_error) out.email_scan = { state: 'error', at: null, label: 'Email scan failing: ' + clip(e.last_error, 80) };
  else out.email_scan = { state: 'never', at: null, label: 'Email scan not run yet' };

  var d = syncRow(rows, 'doubletick');
  var dAt = maxMs(d && d.last_ok_at, arr(inp.doubletick_messages).reduce(function (m, r) { var t = ms(r.created_at); return Number.isFinite(t) && (!m || t > m) ? t : m; }, 0) || null);
  if (Number.isFinite(dAt)) out.doubletick = { state: 'ok', at: new Date(dAt).toISOString(), label: 'Business WhatsApp: last message ' + ago(dAt, nowMs) };
  else out.doubletick = { state: 'never', at: null, label: 'Business WhatsApp: no messages on file' };
  return out;
}

// ── main builder ────────────────────────────────────────────────
function buildPipelineBoardRaw(input) {
  var inp = input || {};
  var nowMs = Number(inp.nowMs) || Date.now();
  var tz = str(inp.tz) || 'Australia/Sydney';
  var todayUtc = new Date(nowMs).toISOString().slice(0, 10);
  var when = function (v) { return fmtWhen(v, tz, nowMs); };
  var day = function (v) { return fmtDay(v, tz, nowMs); };

  // Profiles: archived and the owner's test logins never appear.
  var excludedUsers = {};
  var profById = {}, profByEmail = {};
  arr(inp.user_profiles).forEach(function (p) {
    var uid = str(p.user_id);
    if (!uid) return;
    if (str(p.account_status) === 'archived' || p.archived_at || reviewQueue.isTestAccountEmail(p.email)) { excludedUsers[uid] = true; return; }
    profById[uid] = p;
    var e = lower(p.email); if (e && !profByEmail[e]) profByEmail[e] = p;
  });

  var group = function (rows, field) {
    var m = {};
    arr(rows).forEach(function (r) { var k = str(r[field]); if (!k) return; (m[k] = m[k] || []).push(r); });
    return m;
  };
  var appsByUser = group(inp.gp_applications, 'user_id');
  var placementsByUser = group(inp.placements, 'user_id');
  var contractsByUser = group(inp.career_contracts, 'user_id');
  var casesByUser = group(inp.registration_cases, 'user_id');
  var roleById = {};
  arr(inp.career_roles).forEach(function (r) { if (r.id != null) roleById[str(r.id)] = r; });
  var interviewsByApp = {};
  var consultByUser = {};
  arr(inp.scheduled_calls).forEach(function (s) {
    var kind = str(s.meeting_kind);
    if (kind === 'interview' && s.application_id) (interviewsByApp[str(s.application_id)] = interviewsByApp[str(s.application_id)] || []).push(s);
    if (kind === 'consultation' && s.completed_at && str(s.status) !== 'cancelled') {
      var p = profByEmail[lower(s.invitee_email)] || profById[str(s.user_id)];
      if (p) { var u = str(p.user_id); if (!consultByUser[u] || ms(s.completed_at) > ms(consultByUser[u].completed_at)) consultByUser[u] = s; }
    }
  });
  // Latest event per pipeline person (the route sends newest first, but sort anyway).
  var eventsByPerson = {};
  arr(inp.pipeline_events).forEach(function (e) { var k = str(e.person_id); if (k) (eventsByPerson[k] = eventsByPerson[k] || []).push(e); });
  Object.keys(eventsByPerson).forEach(function (k) { eventsByPerson[k].sort(function (a, b) { return (ms(b.created_at) || 0) - (ms(a.created_at) || 0); }); });

  // Business WhatsApp (DoubleTick): only inbound rows are stored, so the
  // newest inbound message per doctor is what "they are waiting" is read from.
  var dtByUser = {}, dtByPhone = {};
  arr(inp.doubletick_messages).forEach(function (m) {
    if (str(m.direction || 'inbound') !== 'inbound') return;
    var t = ms(m.created_at); if (!Number.isFinite(t)) return;
    var put = function (map, k) { if (k && (!map[k] || t > ms(map[k].created_at))) map[k] = m; };
    put(dtByUser, str(m.user_id));
    put(dtByPhone, phoneKey(m.from_phone));
  });

  var people = [];
  var byUser = {}, byPhone = {}, byName = {};
  var failedUsers = {}, failedNames = {};
  var dormantByPhone = {}, dormantByName = {};
  var index = function (p) {
    if (p.user_id) byUser[p.user_id] = p;
    var pk = phoneKey(p.phone); if (pk && !byPhone[pk]) byPhone[pk] = p;
    var nk = normName(p.name); if (nk && !byName[nk]) byName[nk] = p;
  };

  // 1. People from the app.
  Object.keys(profById).forEach(function (uid) {
    var prof = profById[uid];
    var apps = arr(appsByUser[uid]);
    var placements = arr(placementsByUser[uid]);
    var contracts = arr(contractsByUser[uid]);
    var cases = arr(casesByUser[uid]);
    var cs = cases.filter(function (c) { return str(c.status || 'active') === 'active'; })[0] || cases[0] || null;
    var caseStage = cs ? str(cs.stage) : '';
    var activePl = placements.filter(function (p) { return str(p.status || 'active') === 'active'; }).sort(function (a, b) { return (ms(b.placed_at || b.created_at) || 0) - (ms(a.placed_at || a.created_at) || 0); })[0] || null;
    if (!activePl && placements.some(function (p) { return str(p.status) === 'cancelled'; })) failedUsers[uid] = true;
    var securedApp = apps.filter(appIsSecured)[0] || null;
    var signedContract = contracts.filter(function (k) { return str(k.status) === 'signed'; })[0] || null;
    var liveApps = apps.filter(function (a) { return appIsLive(a) && !appIsSecured(a); });
    var secured = !!(activePl || securedApp || signedContract) || SIGNED_CASE_STAGES.indexOf(caseStage) !== -1;
    var stage = '';
    var startDate = activePl && activePl.start_date ? str(activePl.start_date) : '';
    if (secured) {
      if (caseStage === 'complete' || (caseStage === 'commencement' && startDate && startDate <= todayUtc)) stage = 'started';
      else if (VISA_CASE_STAGES.indexOf(caseStage) !== -1) stage = 'visa';
      else stage = 'signed';
    } else if (liveApps.length) stage = 'matched';
    else {
      var consult = consultByUser[uid];
      var recent = (nowMs - ms(prof.created_at)) <= CONSULT_RECENT_MS || (consult && (nowMs - ms(consult.completed_at)) <= CONSULT_RECENT_MS);
      if (recent && !failedUsers[uid]) stage = 'consult';
    }
    // Carry enough to judge the app-side rules later, even when only a row
    // (not the app) keeps this person on the board.
    var bestApp = liveApps.slice().sort(function (a, b) {
      var r = function (x) { return x.ats_stage === 'offer' ? 4 : appInInterview(x) ? 3 : x.ats_stage === 'reviewing' ? 2 : x.ats_stage === 'submitted' ? 1 : 0; };
      return r(b) - r(a) || (maxMs(b.ats_stage_updated_at, b.updated_at) || 0) - (maxMs(a.ats_stage_updated_at, a.updated_at) || 0);
    })[0] || securedApp || null;
    var role = bestApp ? roleById[str(bestApp.career_role_id)] : null;
    var person = {
      id: 'app-' + uid, row_id: null, user_id: uid, case_id: cs ? str(cs.id) : null,
      name: profileName(prof), phone: str(prof.phone || prof.phone_number), email: str(prof.email),
      app_stage: stage, stage: stage, rows: [],
      practice: (activePl && str(activePl.practice_name)) || (role && str(role.practice_name)) || '',
      _app: { prof: prof, cs: cs, caseStage: caseStage, activePl: activePl, bestApp: bestApp, liveApps: liveApps, signedContract: signedContract, consult: consultByUser[uid] || null, startDate: startDate },
      sources: ['app']
    };
    if (stage) { people.push(person); index(person); }
    else {
      // Reachable for a row link (an older account the owner still talks to), not on the board by itself.
      person._dormant = true;
      byUser[uid] = person;
      var dpk = phoneKey(person.phone); if (dpk && !dormantByPhone[dpk]) dormantByPhone[dpk] = person;
      var dnk = normName(person.name); if (dnk && !dormantByName[dnk]) dormantByName[dnk] = person;
    }
  });

  // 2. pipeline_people rows. Rows that name a user first, then owner-made rows,
  //    then imports and email finds, so the owner's own row is the primary one.
  var srcOrder = { app: 0, manual: 1, whatsapp_business: 2, whatsapp_personal: 3, email_contract: 4 };
  var rows = arr(inp.pipeline_people).slice().sort(function (a, b) {
    return (a.user_id ? 0 : 1) - (b.user_id ? 0 : 1) || (srcOrder[a.source] || 9) - (srcOrder[b.source] || 9) || (ms(a.created_at) || 0) - (ms(b.created_at) || 0);
  });
  var later = [];
  rows.forEach(function (r) {
    var uid = str(r.user_id);
    if (uid && excludedUsers[uid]) return;
    var stageRow = str(r.stage) || 'warm';
    if (r.archived_at) return;
    var pk = phoneKey(r.phone), nk = normName(r.name);
    var target = (uid && byUser[uid]) || (pk && byPhone[pk]) || (nk && byName[nk]) || (pk && dormantByPhone[pk]) || (nk && dormantByName[nk]) || null;
    if (target && target._removed && stageRow !== 'closed' && stageRow !== 'later') return;
    if (stageRow === 'closed') {
      failedNames[normName(r.name)] = true;
      if (uid) failedUsers[uid] = true;
      if (target) { target._removed = true; if (target.user_id) failedUsers[target.user_id] = true; }
      return;
    }
    if (stageRow === 'later') {
      if (target) target._removed = true;
      later.push({ id: str(r.id), name: str(r.name) || (target && target.name) || 'Unknown', later_until: r.later_until || null, later_reason: str(r.later_reason), when: r.later_until ? (str(r.later_until) <= todayUtc ? 'now' : fmtDate(r.later_until, nowMs)) : '' });
      return;
    }
    if (!target) {
      target = { id: str(r.id), row_id: str(r.id), user_id: uid || null, case_id: null, name: str(r.name), phone: str(r.phone), email: str(r.email), app_stage: '', stage: stageRow, rows: [], practice: '', _app: null, sources: [] };
      people.push(target); index(target);
    } else if (target._dormant) {
      // An app account with no live stage of its own, kept on the board by the owner's row.
      target._dormant = false; target.stage = stageRow;
      people.push(target); index(target);
    }
    if (!target.row_id) { target.row_id = str(r.id); target.id = str(r.id); }
    if (!target.user_id && uid) target.user_id = uid;
    // Prefer an international number (wa.me needs the country code).
    if (r.phone && (!target.phone || (!/^\+/.test(target.phone) && /^\+/.test(str(r.phone).trim())))) { target.phone = str(r.phone).trim(); index(target); }
    if (!target.email && r.email) target.email = str(r.email);
    target.rows.push(r);
    if (target.sources.indexOf(str(r.source)) === -1) target.sources.push(str(r.source));
    // A row stage only moves a person forward.
    if ((STAGE_RANK[stageRow] || 0) > (STAGE_RANK[target.stage] || 0)) target.stage = stageRow;
  });
  people = people.filter(function (p) { return !p._removed; });

  // 3. Email contract finds still waiting for the owner's click.
  var findByPerson = {};
  arr(inp.email_contract_finds).forEach(function (f) {
    if (str(f.status || 'proposed') !== 'proposed') return;
    var pid = str(f.pipeline_person_id);
    var target = null;
    var gm = str(f.gmail_message_id);
    // The scan links a find to its row three ways: find.pipeline_person_id, the
    // row's metadata.gmail_message_id (a row that already existed, e.g. from the
    // WhatsApp import) or source_ref (a row the scan created).
    target = people.filter(function (p) { return p.rows.some(function (r) { return (pid && str(r.id) === pid) || rowFindId(r) === gm; }); })[0] || null;
    if (!target && pid && rows.some(function (r) { return str(r.id) === pid && (r.archived_at || r.stage === 'closed'); })) return;
    if (!target) target = byName[normName(f.doctor_name)] || null;
    if (target && (target._removed || target._dormant)) target = null;
    if (!target) {
      target = { id: 'find-' + str(f.gmail_message_id), row_id: null, user_id: null, case_id: null, name: str(f.doctor_name) || 'Unknown doctor', phone: '', email: '', app_stage: '', stage: 'signed', rows: [], practice: str(f.practice_name), _app: null, sources: ['email_contract'] };
      people.push(target); index(target);
    }
    if ((STAGE_RANK.signed || 0) > (STAGE_RANK[target.stage] || 0)) target.stage = 'signed';
    if (!target.practice && f.practice_name) target.practice = str(f.practice_name);
    findByPerson[target.id] = f;
  });

  // 4. Invoices (Xero mirror). Never a fake zero: without a successful sync
  //    the money tiles ask for the connection instead.
  var xeroSync = syncRow(inp.pipeline_sync_state, 'xero');
  var xeroConnected = !!(xeroSync && Number.isFinite(ms(xeroSync.last_ok_at)));
  var invoicesAll = arr(inp.xero_invoices).filter(function (i) {
    return str(i.type || 'ACCREC').toUpperCase() === 'ACCREC' && ['VOIDED', 'DELETED'].indexOf(str(i.status).toUpperCase()) === -1;
  });
  var isOpen = function (i) { return ['AUTHORISED', 'SUBMITTED'].indexOf(str(i.status).toUpperCase()) !== -1 && num(i.amount_due) > 0; };

  // Payment plans: one root invoice ("PAYMENT PLAN: … Total fee … Duration …")
  // plus the monthly instalments that carry the root's number as reference.
  var plans = {}, planOf = {};
  invoicesAll.forEach(function (i) {
    if (!isPlanInvoice(i)) return;
    var id = planIdOf(i);
    if (!id) return;
    (plans[id] = plans[id] || { id: id, invoices: [] }).invoices.push(i);
    planOf[str(i.invoice_id)] = plans[id];
  });
  invoicesAll.forEach(function (i) {
    if (planOf[str(i.invoice_id)]) return;
    var no = invNo(i.invoice_number), ref = invNo(i.reference);
    var pl = plans[no] || (INV_NO_RE.test(ref) ? plans[ref] : null);
    if (pl) { pl.invoices.push(i); planOf[str(i.invoice_id)] = pl; }
  });
  Object.keys(plans).forEach(function (id) {
    var pl = plans[id];
    pl.invoices.sort(function (a, b) { return str(a.invoice_date).localeCompare(str(b.invoice_date)); });
    pl.root = pl.invoices.filter(function (i) { return invNo(i.invoice_number) === id; })[0] ||
      pl.invoices.filter(function (i) { return /Total\s+fee/i.test(str(i.line_text)); })[0] || pl.invoices[0];
    pl.terms = parsePlanTerms(pl.root.line_text);
    if (!pl.terms.total_inc) {
      var other = pl.invoices.filter(function (i) { return parsePlanTerms(i.line_text).total_inc; })[0];
      if (other) pl.terms = parsePlanTerms(other.line_text);
    }
    pl.doctor = pl.terms.candidate || pl.invoices.map(function (i) { return str(i.doctor_name); }).filter(Boolean)[0] || '';
    pl.paidN = pl.invoices.filter(function (i) { return str(i.status).toUpperCase() === 'PAID'; }).length;
    pl.months = pl.terms.months || null;
    // What the plan still has to bring in beyond what is invoiced (paid or open).
    var paidSum = pl.invoices.reduce(function (s, i) { return s + (num(i.amount_paid) || 0); }, 0);
    var openSum = pl.invoices.filter(isOpen).reduce(function (s, i) { return s + (num(i.amount_due) || 0); }, 0);
    pl.remaining = pl.terms.total_inc ? Math.round((pl.terms.total_inc - paidSum - openSum) * 100) / 100 : null;
    pl.latest = pl.invoices.slice().sort(function (a, b) { return str(b.invoice_date).localeCompare(str(a.invoice_date)); })[0];
    pl.nextDue = nextInstalment(pl.latest);
  });
  // The doctor an invoice is for: a plan's candidate wins for every invoice in it.
  var docOf = function (i) { var pl = planOf[str(i.invoice_id)]; return (pl && pl.doctor) || str(i.doctor_name); };

  // Board people a name on an invoice points at: exact, then first + last
  // (middle names ignored), then surname alone when only one person has it.
  var peopleNamed = function (dn) {
    var n = normName(dn);
    if (!n) return [];
    var exact = byName[n];
    if (exact && !exact._dormant && !exact._removed) return [exact];
    var loose = people.filter(function (p) { return !p._removed && namesMatch(p.name, dn); });
    if (loose.length) return loose;
    if (n.indexOf(' ') === -1) {
      var sur = people.filter(function (p) { var w = normName(p.name).split(' '); return !p._removed && w.length >= 2 && w[w.length - 1] === n; });
      if (sur.length === 1) return sur;
    }
    return [];
  };
  var personForInvoice = function (i) {
    var pid = str(i.pipeline_person_id);
    if (pid) { var hit = people.filter(function (p) { return p.id === pid || p.rows.some(function (r) { return str(r.id) === pid; }); })[0]; if (hit) return hit; }
    var uid = str(i.user_id);
    if (uid && byUser[uid] && !byUser[uid]._dormant && !byUser[uid]._removed) return byUser[uid];
    var hits = peopleNamed(docOf(i));
    return hits.length === 1 ? hits[0] : null;
  };
  var invoicesByPerson = {};
  var namedPerson = {};
  var planByPerson = {};
  var invoiceRows = [];
  var xeroFix = { n: 0, total: 0 };
  if (xeroConnected) {
    invoicesAll.forEach(function (i) {
      var p = personForInvoice(i);
      var plan = planOf[str(i.invoice_id)] || null;
      if (p) (invoicesByPerson[p.id] = invoicesByPerson[p.id] || []).push(i);
      if (p && plan && !planByPerson[p.id]) planByPerson[p.id] = plan;
      if (p) namedPerson[p.id] = true;
      peopleNamed(docOf(i)).forEach(function (q) { namedPerson[q.id] = true; });
      var status = str(i.status).toUpperCase();
      var due = num(i.amount_due);
      if (!isOpen(i)) return;
      var dn = docOf(i);
      var owner = lower(i.owner_status);
      var failed = (i.user_id && failedUsers[str(i.user_id)]) || (p && p.user_id && failedUsers[p.user_id]) || (dn && failedNames[normName(dn)]);
      var dueDate = str(i.due_date).slice(0, 10);
      var overdue = !!dueDate && dueDate < todayUtc;
      var daysOver = overdue ? Math.floor((Date.parse(todayUtc + 'T00:00:00Z') - Date.parse(dueDate + 'T00:00:00Z')) / DAY_MS) : null;
      var state, note = '';
      if (owner === 'paid_outside_xero' || owner === 'not_owed') {
        // The owner says the money is not owed (it reached the bank outside
        // Xero, or it should be voided): listed, never counted as owed.
        state = 'xero_fix';
        note = str(i.owner_note).trim() || (owner === 'not_owed' ? 'Marked not owed. Void or credit it in Xero.' : 'Marked paid outside Xero. Record the payment in Xero.');
        xeroFix.n++; xeroFix.total += due;
      }
      else if (failed) { state = 'decide'; note = 'Placement failed. Decide: chase, credit, or write off.'; }
      else if (status === 'SUBMITTED') { state = 'check'; note = 'Waiting for approval in Xero, so it has not gone to the practice yet.'; }
      else if (!dn && !p && owner !== 'chase') { state = 'check'; note = 'Xero shows it owing; no doctor named on the invoice.'; }
      else if (overdue) state = 'overdue';
      else state = 'coming';
      if (!note && plan) note = 'Payment plan ' + plan.id + ' instalment.';
      var paid = num(i.amount_paid) || 0;
      invoiceRows.push({
        id: str(i.invoice_id), number: str(i.invoice_number) || '(no number)', amount: due, total: num(i.total),
        practice: str(i.contact_name), who: plan ? '' : str(i.reference), doctor: dn || (p ? p.name : ''), person_id: p ? p.id : null,
        state: state, due: dueDate ? fmtDate(dueDate, nowMs) : '', due_date: dueDate || null, days: (state === 'overdue' || state === 'decide') ? daysOver : null,
        last: paid > 0 ? 'Part paid ' + money(paid) : (i.invoice_date ? 'Raised ' + fmtDate(i.invoice_date, nowMs) : ''),
        note: note, url: i.invoice_id ? XERO_VIEW + encodeURIComponent(str(i.invoice_id)) : '',
        owner_status: owner || null, plan: plan ? plan.id : null
      });
    });

    // What a plan still has to bring in, beyond the instalments already invoiced.
    Object.keys(plans).forEach(function (id) {
      var pl = plans[id];
      var totalInc = pl.terms.total_inc;
      if (!totalInc) return;
      var remaining = pl.remaining;
      if (!(remaining > 1)) return;
      var raised = pl.invoices.length;
      var M = pl.months;
      var label = M && raised < M ? 'Plan ' + (raised + 1 === M ? M : (raised + 1) + '–' + M) + ' of ' + M : 'Plan balance';
      var latest = pl.latest;
      var nextDue = pl.nextDue;
      var onTime = pl.paidN > 0 && pl.invoices.every(function (i) {
        if (str(i.status).toUpperCase() !== 'PAID') return true;
        var fp = str(i.fully_paid_on).slice(0, 10), dd = str(i.due_date).slice(0, 10);
        return !!fp && !!dd && fp <= dd;
      });
      var p = personForInvoice(pl.root);
      invoiceRows.push({
        id: 'plan-' + id, number: label, amount: remaining, total: totalInc,
        practice: str(latest.contact_name || pl.root.contact_name), who: '', doctor: pl.doctor || (p ? p.name : ''), person_id: p ? p.id : null,
        state: 'coming', due: nextDue ? 'monthly, next ~' + fmtDate(nextDue, nowMs) : 'monthly', due_date: nextDue || null, days: null,
        last: (M ? pl.paidN + ' of ' + M : pl.paidN) + ' paid',
        note: 'GoCardless payment plan, ' + (M ? pl.paidN + ' of ' + M : pl.paidN) + ' paid' + (onTime ? ' on time' : '') + '.',
        url: pl.root.invoice_id ? XERO_VIEW + encodeURIComponent(str(pl.root.invoice_id)) : '',
        owner_status: null, plan: id
      });
    });
  }

  // 5. Per-person flags, heat and the lines on the card.
  var out = people.map(function (p) {
    var a = p._app;
    var rowsOf = p.rows;
    var pick = function (field) { for (var i = 0; i < rowsOf.length; i++) { var v = rowsOf[i][field]; if (v != null && str(v).trim() !== '') return v; } return null; };
    var msgRow = rowsOf.filter(function (r) { return Number.isFinite(ms(r.last_message_at)); }).sort(function (x, y) { return ms(y.last_message_at) - ms(x.last_message_at); })[0] || null;
    var events = [];
    rowsOf.forEach(function (r) { events = events.concat(eventsByPerson[str(r.id)] || []); });
    events.sort(function (x, y) { return (ms(y.created_at) || 0) - (ms(x.created_at) || 0); });
    var lastEvent = events[0] || null;
    var lastDone = events.filter(function (e) { return e.kind === 'done'; })[0] || null;
    var lastDoneAt = lastDone ? ms(lastDone.created_at) : NaN;
    var answeredAfter = function (t) { return Number.isFinite(lastDoneAt) && lastDoneAt >= t; };
    var dt = (p.user_id && dtByUser[p.user_id]) || dtByPhone[phoneKey(p.phone)] || null;
    var dtAt = dt ? ms(dt.created_at) : NaN;
    var msgAt = msgRow ? ms(msgRow.last_message_at) : NaN;
    var msgFromThem = !!msgRow && str(msgRow.last_message_from) === 'them';

    var reasons = [];
    var red = null, amber = null;
    var waitingOnOwner = rowsOf.some(function (r) { return r.waiting_on_owner === true; });
    if (waitingOnOwner) red = red || { kind: 'waiting', text: str(pick('wait_note')) || 'Waiting on you' };
    if (msgFromThem && (nowMs - msgAt) > RED_AFTER_MS && !answeredAfter(msgAt)) {
      red = red || { kind: 'message', text: 'They messaged you ' + when(msgAt) + (msgRow.last_message_snippet ? ': “' + clip(msgRow.last_message_snippet, 90) + '”' : '') + ', no reply' };
      reasons.push('message');
    }
    if (dt && (nowMs - dtAt) > RED_AFTER_MS && (nowMs - dtAt) <= DT_LOOKBACK_MS && !answeredAfter(dtAt) && !(msgRow && str(msgRow.last_message_from) === 'me' && msgAt >= dtAt)) {
      red = red || { kind: 'business_whatsapp', text: 'Business WhatsApp ' + when(dtAt) + (dt.message_body ? ': “' + clip(dt.message_body, 90) + '”' : '') + ', no reply' };
      reasons.push('business_whatsapp');
    }
    if (waitingOnOwner) reasons.unshift('waiting');

    var find = findByPerson[p.id] || null;
    var confirmRow = rowsOf.filter(function (r) { return r.needs_confirm === true && !r.confirmed_at; })[0] || null;
    var needsConfirm = !!find || !!confirmRow;
    // A row waiting for confirmation whose find was not fetched still gets the buttons.
    if (!find && confirmRow && rowFindId(confirmRow)) find = { gmail_message_id: rowFindId(confirmRow), thread_id: str(confirmRow.metadata && confirmRow.metadata.thread_id) };
    // An email find is the one thing the owner can clear in a click: it leads.
    if (needsConfirm) { amber = { kind: 'email_find', text: 'Found in email — confirm' }; reasons.push('email_find'); }
    // "Moving" = a stage change in the app, an owner event, or the row being
    // created. Messages are not movement (a chatty doctor can still be stuck),
    // and updated_at is not either (every WhatsApp import touches it).
    var lastMoveAt = maxMs(lastEvent && lastEvent.created_at, rowsOf.length ? rowsOf.map(function (r) { return str(r.created_at); }).sort().pop() : null);
    if (a) {
      var app = a.bestApp;
      lastMoveAt = maxMs(lastMoveAt, app && app.ats_stage_updated_at, app && app.updated_at, app && app.matched_at, a.cs && a.cs.updated_at, a.activePl && (a.activePl.updated_at || a.activePl.created_at), a.signedContract && (a.signedContract.updated_at || a.signedContract.created_at));
      if (p.stage === 'matched' && app) {
        var iv = arr(interviewsByApp[str(app.id)]).filter(function (s) { return s.completed_at || str(s.status) === 'completed'; })
          .sort(function (x, y) { return (maxMs(y.completed_at, y.scheduled_at) || 0) - (maxMs(x.completed_at, x.scheduled_at) || 0); })[0];
        var ivAt = iv ? maxMs(iv.completed_at, iv.scheduled_at) : NaN;
        if (iv && appInInterview(app) && (nowMs - ivAt) > INTERVIEW_STUCK_MS && !answeredAfter(ivAt)) {
          amber = amber || { kind: 'interview', text: 'Interview done ' + day(ivAt) + ', no decision for ' + plural(ageDays(ivAt, nowMs), 'day') };
          reasons.push('interview');
        }
        var mAt = maxMs(app.matched_at, app.applied_at, app.created_at);
        if (appNotSent(app) && Number.isFinite(mAt) && (nowMs - mAt) > MATCH_STUCK_MS && !answeredAfter(mAt)) {
          amber = amber || { kind: 'not_sent', text: 'Matched ' + day(mAt) + ', not sent to the practice' };
          reasons.push('not_sent');
        }
      }
    }
    if ((p.stage === 'matched' || p.stage === 'signed') && Number.isFinite(lastMoveAt) && (nowMs - lastMoveAt) > STALE_MS) {
      amber = amber || { kind: 'stale', text: 'Nothing has moved for ' + plural(ageDays(lastMoveAt, nowMs), 'day') };
      reasons.push('stale');
    } else if ((p.stage === 'matched' || p.stage === 'signed') && !Number.isFinite(lastMoveAt)) {
      amber = amber || { kind: 'stale', text: 'No activity on record' };
      reasons.push('stale');
    }
    var flag = red ? 'red' : amber ? 'amber' : '';

    // Heat: warm/consult columns only.
    var heat = null;
    if (p.stage === 'warm' || p.stage === 'consult') {
      var ov = pick('heat_override');
      if (ov !== null && Number.isFinite(Number(ov))) heat = Number(ov);
      else {
        var themAt = maxMs(msgFromThem ? msgAt : NaN, dtAt);
        var contactAt = maxMs(msgAt, dtAt, lastEvent && lastEvent.created_at, a && a.consult && a.consult.completed_at, a && a.prof && a.prof.created_at);
        if (red || (Number.isFinite(themAt) && (nowMs - themAt) <= HOT_MS)) heat = 3;
        else if (Number.isFinite(contactAt) && (nowMs - contactAt) <= WARM_MS) heat = 2;
        else heat = 1;
      }
    }

    // Card lines.
    var status = str(pick('status_note'));
    if (!status) {
      if (p.stage === 'started') status = a && a.startDate ? 'Started ' + fmtDate(a.startDate, nowMs) : 'Started work';
      else if (p.stage === 'visa') status = a && a.caseStage ? 'Registration: ' + (CASE_STAGE_LABEL[a.caseStage] || a.caseStage) : 'AHPRA done, visa next';
      else if (p.stage === 'signed') status = find ? 'Signed contract found in email' + (find.signed_date ? ' (' + fmtDate(find.signed_date, nowMs) + ')' : '') : (a && a.caseStage ? 'Registration: ' + (CASE_STAGE_LABEL[a.caseStage] || a.caseStage) : 'Contract signed');
      else if (p.stage === 'matched' && a && a.bestApp) {
        var st = lower(a.bestApp.ats_stage) || 'applied';
        status = st === 'offer' ? 'Offer made' : appInInterview(a.bestApp) ? 'Interview stage' : st === 'reviewing' ? 'Practice is reviewing' : st === 'submitted' ? 'Sent to the practice' : appNotSent(a.bestApp) ? 'Matched, not sent yet' : 'Applied';
        if (a.liveApps.length > 1) status += ' · ' + a.liveApps.length + ' practices';
      } else if (p.stage === 'consult' && a) {
        status = a.consult ? 'Consult held ' + day(a.consult.completed_at) : (a.prof.onboarding_completed_at ? 'Onboarded, not matched yet' : 'Signed up ' + day(a.prof.created_at) + ', onboarding not finished');
      } else if (p.stage === 'warm') status = p.user_id ? 'In the app' : 'Only in your WhatsApp';
      else status = '';
    }
    var wait = red ? red.text : amber ? amber.text : '';
    var last = '';
    if (Number.isFinite(msgAt) && (!Number.isFinite(dtAt) || msgAt >= dtAt)) last = (msgFromThem ? 'They messaged ' : 'You messaged ') + when(msgAt);
    else if (Number.isFinite(dtAt)) last = 'Business WhatsApp ' + when(dtAt);
    else if (lastEvent) last = (lastEvent.kind === 'done' ? 'Done ' : 'Note ') + when(lastEvent.created_at) + (lastEvent.text ? ': ' + clip(lastEvent.text, 60) : '');
    else if (Number.isFinite(lastMoveAt)) last = (a ? 'App activity ' : 'Added ') + when(lastMoveAt);
    else last = 'Unknown';

    var next = str(pick('next_step'));
    if (!next) {
      if (red) next = 'Reply to them';
      else if (amber && amber.kind === 'email_find') next = 'Confirm the contract';
      else if (amber && amber.kind === 'not_sent') next = 'Send CV to the practice';
      else if (amber && amber.kind === 'interview') next = 'Ask the practice for a decision';
      else if (amber && amber.kind === 'stale') next = 'Check where they are';
      else next = { warm: 'Follow up', consult: 'Help them match', matched: 'Chase the practice', signed: 'Keep registration moving', visa: 'Start the visa', started: 'Check in' }[p.stage] || 'Follow up';
    }

    // Money line.
    var invs = invoicesByPerson[p.id] || [];
    var moneyLine = '';
    if (xeroConnected) {
      var open = invs.filter(isOpen);
      var pp = planByPerson[p.id] || null;
      var planTxt = pp ? 'Payment plan ' + pp.paidN + (pp.months ? ' of ' + pp.months : '') + ' paid' : '';
      if (open.length) {
        moneyLine = open.map(function (i) {
          var od = str(i.due_date).slice(0, 10);
          var own = lower(i.owner_status);
          var tail = own === 'paid_outside_xero' ? ' paid outside Xero' : own === 'not_owed' ? ' not owed' : (od && od < todayUtc ? ' overdue' : ' unpaid');
          return (str(i.invoice_number) || 'Invoice') + ' ' + money(i.amount_due) + tail;
        }).join(' · ') + (planTxt ? ' · ' + planTxt : '');
      } else if (planTxt) moneyLine = planTxt;
      else if (invs.some(function (i) { return str(i.status).toUpperCase() === 'PAID'; })) moneyLine = 'Paid in full';
      else if (invs.length) moneyLine = 'Invoice in Xero (' + str(invs[0].status).toLowerCase() + ')';
      else if (firstHalfPaid(rowsOf)) {
        var fh = firstHalfPaid(rowsOf);
        // NaN clock: fmtDate always prints the year ("5 Jan 2026").
        moneyLine = 'First 50% paid' + (fh.paid_on ? ' ' + fmtDate(fh.paid_on, NaN) : '') + ' (' + [(/INV-?\d+/i.exec(str(fh.invoice)) || [str(fh.invoice).trim()])[0], 'outside Xero'].filter(Boolean).join(', ') + ')';
      }
      else if (p.stage === 'signed' || p.stage === 'visa') moneyLine = 'No invoice found yet';
    }

    // Where the next-step button goes.
    var digits = str(p.phone).replace(/\D/g, '');
    var channel, open;
    if (p.user_id) { channel = 'app'; open = { kind: 'app', case_id: p.case_id || null, user_id: p.user_id }; }
    else if (find && find.thread_id) { channel = 'email'; open = { kind: 'gmail', url: GMAIL_THREAD + encodeURIComponent(str(find.thread_id)) }; }
    else if (digits.length >= 8) { channel = 'whatsapp'; open = { kind: 'whatsapp', url: 'https://wa.me/' + digits }; }
    else { channel = p.sources.indexOf('whatsapp_personal') !== -1 ? 'whatsapp' : 'manual'; open = { kind: 'none' }; }

    return {
      id: p.id, row_id: p.row_id, user_id: p.user_id || null, case_id: p.case_id || null,
      name: p.name || 'Unknown', stage: p.stage, app_stage: p.app_stage || null, heat: heat, flag: flag, reasons: reasons,
      practice: str(pick('practice_name')) || p.practice || '', status: status, wait: wait, last: last, money: moneyLine,
      next: next, channel: channel, open: open, phone: p.phone || '', email: p.email || '',
      start: str(pick('start_date_text')), sources: p.sources.slice(),
      find: find ? { gmail_message_id: str(find.gmail_message_id), thread_id: str(find.thread_id), subject: str(find.subject), summary: clip(find.ai_summary, 200), url: find.thread_id ? GMAIL_THREAD + encodeURIComponent(str(find.thread_id)) : '' } : null,
      has_invoice: invs.length > 0 || !!namedPerson[p.id] || !!firstHalfPaid(rowsOf),
      has_xero_invoice: invs.length > 0 || !!namedPerson[p.id]
    };
  });

  var flagRank = { red: 0, amber: 1, '': 2 };
  out.sort(function (x, y) { return (STAGE_RANK[x.stage] - STAGE_RANK[y.stage]) || (flagRank[x.flag] - flagRank[y.flag]) || ((y.heat || 0) - (x.heat || 0)) || x.name.localeCompare(y.name); });

  // Signed / visa with no invoice in Xero at all.
  var notInvoiced = xeroConnected ? out.filter(function (p) { return (p.stage === 'signed' || p.stage === 'visa') && !p.has_invoice; }) : [];
  notInvoiced.forEach(function (p) {
    invoiceRows.push({ id: null, number: 'Not raised', amount: null, total: null, practice: p.practice || '', who: '', doctor: p.name, person_id: p.id, state: 'not_invoiced', due: '', due_date: null, days: null, last: '', note: 'No invoice in Xero for this doctor.', url: '' });
  });
  var stateOrder = { overdue: 0, decide: 1, xero_fix: 2, check: 3, not_invoiced: 4, coming: 5 };
  invoiceRows.sort(function (x, y) { return (stateOrder[x.state] - stateOrder[y.state]) || ((y.days || 0) - (x.days || 0)) || str(x.due_date).localeCompare(str(y.due_date)); });

  var moneyOut;
  if (!xeroConnected) {
    moneyOut = { connected: false, overdue: null, overdueN: null, oldestDays: null, check: null, checkN: null, coming: null, comingN: null, notInvoiced: null, notInvoicedNames: [], xeroFix: null };
  } else {
    var sum = function (st) { return invoiceRows.filter(function (i) { return st.indexOf(i.state) !== -1; }).reduce(function (s, i) { return s + (i.amount || 0); }, 0); };
    var cnt = function (st) { return invoiceRows.filter(function (i) { return st.indexOf(i.state) !== -1; }).length; };
    var oldest = invoiceRows.filter(function (i) { return i.state === 'overdue' || i.state === 'decide'; }).reduce(function (m, i) { return Math.max(m, i.days || 0); }, 0);
    moneyOut = {
      connected: true,
      overdue: Math.round(sum(['overdue', 'decide']) * 100) / 100, overdueN: cnt(['overdue', 'decide']), oldestDays: cnt(['overdue', 'decide']) ? oldest : null,
      check: Math.round(sum(['check']) * 100) / 100, checkN: cnt(['check']),
      coming: Math.round(sum(['coming']) * 100) / 100, comingN: cnt(['coming']),
      notInvoiced: notInvoiced.length, notInvoicedNames: notInvoiced.map(function (p) { return p.name; }),
      // Unpaid in Xero but the owner says paid (or not owed): not in the totals above.
      xeroFix: { n: xeroFix.n, total: Math.round(xeroFix.total * 100) / 100 }
    };
  }

  // 6. Income forecast (lib/income-forecast.js). It reuses everything worked
  //    out above: who each invoice is for, the payment plans, owner overrides,
  //    and which placements failed.
  var innerById = {};
  people.forEach(function (p) { innerById[p.id] = p; });
  var metaPick = function (p, key) { return rowMeta(p && p.rows, key); };
  var invFailed = function (i, p) { var dn = docOf(i); return !!((i.user_id && failedUsers[str(i.user_id)]) || (p && p.user_id && failedUsers[p.user_id]) || (dn && failedNames[normName(dn)])); };
  var forecast = incomeForecast.buildIncomeForecast({
    nowMs: nowMs, tz: tz, connected: xeroConnected,
    invoices: invoicesAll.map(function (i) {
      var p = personForInvoice(i);
      var pl = planOf[str(i.invoice_id)] || null;
      return Object.assign({}, i, { doctor: docOf(i), person_id: p ? p.id : null, plan_id: pl ? pl.id : null, failed: invFailed(i, p) });
    }),
    plans: Object.keys(plans).map(function (id) {
      var pl = plans[id];
      if (!pl.terms.total_inc) return null;
      var p = personForInvoice(pl.root);
      return { id: id, doctor: pl.doctor, person_id: p ? p.id : null, contact: str(pl.latest.contact_name || pl.root.contact_name), total_inc: pl.terms.total_inc, months: pl.months, invoiced_n: pl.invoices.length, remaining_inc: pl.remaining, next_due: pl.nextDue, failed: invFailed(pl.root, p) };
    }).filter(Boolean),
    people: out.map(function (o) {
      var p = innerById[o.id] || {};
      var a = p._app || null;
      return {
        id: o.id, name: o.name, practice: o.practice, stage: o.stage, has_invoice: !!o.has_invoice, has_xero_invoice: !!o.has_xero_invoice,
        first_half_paid: firstHalfPaid(p.rows), fee_second_half_inc_gst: metaPick(p, 'fee_second_half_inc_gst'),
        expected_start: metaPick(p, 'expected_start'), expected_start_basis: metaPick(p, 'expected_start_basis'),
        placement_start: a && a.startDate ? a.startDate : null,
        target_arrival: a && a.prof ? (a.prof.target_arrival_date || null) : null,
        fee_total_ex_gst: metaPick(p, 'fee_total_ex_gst')
      };
    }),
    expectations: inp.income_expectations
  });

  out.forEach(function (p) { delete p.has_invoice; delete p.has_xero_invoice; });
  later.sort(function (x, y) { return str(x.later_until || '9999').localeCompare(str(y.later_until || '9999')); });
  var byStage = {};
  STAGES.forEach(function (s) { byStage[s.k] = 0; });
  out.forEach(function (p) { byStage[p.stage] = (byStage[p.stage] || 0) + 1; });

  return {
    ok: true, now: new Date(nowMs).toISOString(), tz: tz,
    stages: STAGES,
    people: out,
    later: later,
    invoices: xeroConnected ? invoiceRows : [],
    money: moneyOut,
    forecast: forecast,
    freshness: freshness(inp, nowMs),
    counts: { people: out.length, red: out.filter(function (p) { return p.flag === 'red'; }).length, amber: out.filter(function (p) { return p.flag === 'amber'; }).length, later: later.length, by_stage: byStage }
  };
}

// sendJson redacts any object it has already seen ("[redacted-circular]"),
// so hand back a copy that shares no references (STAGES is reused).
function buildPipelineBoard(input) { return JSON.parse(JSON.stringify(buildPipelineBoardRaw(input))); }

module.exports = {
  buildPipelineBoard: buildPipelineBoard,
  normName: normName,
  phoneKey: phoneKey,
  namesMatch: namesMatch,
  parsePlanTerms: parsePlanTerms,
  OWNER_STATUSES: ['paid_outside_xero', 'not_owed', 'chase'],
  STAGES: STAGES,
  ROW_STAGES: ROW_STAGES,
  STAGE_RANK: STAGE_RANK
};

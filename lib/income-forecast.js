'use strict';

// Income forecast for the CEO "Pipeline & money" board (owner, 26 Nov 2026:
// "an income forecaster that forecasts when the other doctors will begin
// working and I will be paid — as a graph"). Pure: no DB, no env, no clock of
// its own (nowMs comes in). lib/ceo-pipeline.js builds the input from the rows
// it already reads (invoice → doctor matching, payment plans, owner overrides
// all happen there) and puts the result on the board payload as `forecast`.
//
// Fee terms (assets/legal/src/agreement-2026.html §1.1–1.2, §6.5): an
// overseas GP's fee is paid in two halves — the first 50% is invoiced when the
// doctor accepts the practice's contract, the second 50% when the doctor
// commences work — and every invoice is payable within 7 days of issue.
// Full-time overseas GP: $25,000 ex GST ($12,500 + $12,500).
//
// Input:
//   nowMs, tz, connected (a successful Xero sync exists)
//   invoices[]  non-voided ACCREC rows, each with the board's own reading added:
//               doctor (plan candidate or doctor_name), person_id (board person or
//               null), plan_id (payment plan it belongs to or null), failed (the
//               doctor's placement is cancelled / closed on the board)
//   plans[]     { id, doctor, person_id, contact, total_inc, months, invoiced_n,
//                 remaining_inc, next_due, failed }
//   people[]    board people: { id, name, practice, stage, has_invoice (Xero or
//                 first half paid outside it), has_xero_invoice, expected_start,
//                 expected_start_basis, placement_start, target_arrival,
//                 fee_total_ex_gst, first_half_paid (metadata.fee_first_half_paid
//                 {invoice, amount_inc_gst, paid_on, payer, evidence}),
//                 fee_second_half_inc_gst }
//   expectations[]  income_expectations rows (money the app can't see)
//
// Output: { connected, tz, months[], buckets[], totals, doctors[], expectations[], kinds }

var DAY_MS = 86400000;
var PAY_TERMS_DAYS = 7;
var DEFAULT_FEE_EX_GST = 25000;
var GST_RATE = 0.10;
var SIGNED_LEAD_DAYS = 150;
var VISA_LEAD_DAYS = 60;
var MONTHS_AHEAD = 12;

var KINDS = [
  { k: 'overdue', l: 'Owed now (overdue)' },
  { k: 'invoiced', l: 'Invoiced, not due yet' },
  { k: 'plan', l: 'Payment plan' },
  { k: 'second_half', l: 'Second 50% at start' },
  { k: 'to_invoice', l: 'Not invoiced yet' },
  { k: 'manual', l: 'Added by you' }
];

var ADVANCE_RE = /50\s*%|advance|first\s+instal/i;
var BALANCE_RE = /balance|second|remaining/i;
var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function arr(v) { return Array.isArray(v) ? v.filter(Boolean) : []; }
function str(v) { return v == null ? '' : String(v); }
function lower(v) { return str(v).trim().toLowerCase(); }
function num(v) { var n = Number(v); return Number.isFinite(n) ? n : null; }
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function isoDate(v) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(v).trim()); return m && Number.isFinite(Date.parse(m[0] + 'T00:00:00Z')) ? m[0] : ''; }
function addDays(d, n) { return new Date(Date.parse(d + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10); }
function monthKey(d) { return str(d).slice(0, 7); }
function addMonths(key, n) {
  var y = Number(key.slice(0, 4)), m = Number(key.slice(5, 7)) - 1 + n;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  return y + '-' + (m < 9 ? '0' : '') + (m + 1);
}
function fmtDate(d) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d); return m ? Number(m[3]) + ' ' + MON[Number(m[2]) - 1] + ' ' + m[1] : ''; }
function money(n) { return '$' + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function todayIn(tz, nowMs) {
  try {
    var p = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs)).forEach(function (x) { p[x.type] = x.value; });
    if (p.year && p.month && p.day) return p.year + '-' + p.month + '-' + p.day;
  } catch (e) { /* fall through to UTC */ }
  return new Date(nowMs).toISOString().slice(0, 10);
}

// The same normalisation as lib/ceo-pipeline.js normName (titles, brackets,
// diacritics and punctuation dropped). Loaded lazily: ceo-pipeline requires
// this file, so a top-level require would see a half-built module.
function names() { return require('./ceo-pipeline.js'); }
// Same doctor: the board's own rule (exact, or first + last), plus a lone
// surname against a full name ("Dr Sivakumar" on a plan vs "Krishnaveni Sivakumar").
function sameDoctor(a, b) {
  var N = names();
  if (!N.normName(a) || !N.normName(b)) return false;
  if (N.namesMatch(a, b)) return true;
  var x = N.normName(a).split(' '), y = N.normName(b).split(' ');
  if (x.length === 1 && y.length >= 2) return x[0] === y[y.length - 1];
  if (y.length === 1 && x.length >= 2) return y[0] === x[x.length - 1];
  return false;
}

// When a doctor is expected to start, first found:
//   owner-set metadata.expected_start → placements.start_date →
//   user_profiles.target_arrival_date → a guess from the stage.
// A recorded date already in the past for someone who has not started is
// stale, so it is skipped (an owner-set date is always kept).
function expectedStart(p, today) {
  if (!p) return { date: null, basis: 'none', confidence: 'unknown', label: 'No doctor on the board' };
  var own = isoDate(p.expected_start);
  if (own) {
    var agreed = lower(p.expected_start_basis) === 'agreed';
    return { date: own, basis: 'owner', confidence: agreed ? 'agreed' : 'estimated', label: agreed ? 'You set it (agreed with the practice)' : 'You set it (your estimate)' };
  }
  var started = p.stage === 'started';
  var pl = isoDate(p.placement_start);
  if (pl && (pl >= today || started)) return { date: pl, basis: 'placement', confidence: 'estimated', label: 'Placement start date in the app' };
  var ta = isoDate(p.target_arrival);
  if (ta && (ta >= today || started)) return { date: ta, basis: 'profile', confidence: 'estimated', label: "Doctor's target arrival date (their profile)" };
  if (p.stage === 'signed') return { date: addDays(today, SIGNED_LEAD_DAYS), basis: 'stage', confidence: 'estimated', label: 'Guess: signed, about ' + SIGNED_LEAD_DAYS + ' days to start' };
  if (p.stage === 'visa') return { date: addDays(today, VISA_LEAD_DAYS), basis: 'stage', confidence: 'estimated', label: 'Guess: at visa, about ' + VISA_LEAD_DAYS + ' days to start' };
  return { date: null, basis: 'none', confidence: 'unknown', label: 'No start date' };
}

function buildIncomeForecast(input) {
  var inp = input || {};
  var nowMs = Number(inp.nowMs) || Date.now();
  var tz = str(inp.tz) || 'Australia/Sydney';
  var today = todayIn(tz, nowMs);
  var thisMonth = monthKey(today);
  var connected = inp.connected !== false;

  var months = [];
  for (var i = 0; i < MONTHS_AHEAD; i++) months.push(addMonths(thisMonth, i));
  var lastMonth = months[months.length - 1];
  var buckets = [{ key: 'owed', label: 'Owed now', items: [] }];
  months.forEach(function (k) { buckets.push({ key: k, label: MON[Number(k.slice(5, 7)) - 1], year: Number(k.slice(0, 4)), items: [] }); });
  buckets.push({ key: 'unknown', label: 'Date unknown', items: [] });
  buckets.push({ key: 'later', label: 'After ' + MON[Number(lastMonth.slice(5, 7)) - 1] + ' ' + lastMonth.slice(0, 4), items: [] });
  var bucketOf = {};
  buckets.forEach(function (b) { bucketOf[b.key] = b; });

  var people = arr(inp.people);
  var personById = {};
  people.forEach(function (p) { personById[str(p.id)] = p; });
  var startCache = {};
  var startOf = function (pid) {
    if (!pid) return expectedStart(null, today);
    if (!startCache[pid]) startCache[pid] = expectedStart(personById[pid] || null, today);
    return startCache[pid];
  };

  var itemsByPerson = {};
  // where: 'owed' | 'unknown' | a YYYY-MM-DD payment date (past dates land in this month)
  var put = function (where, item) {
    var key = where === 'owed' || where === 'unknown' ? where : (monthKey(where) < thisMonth ? thisMonth : monthKey(where));
    if (key !== 'owed' && key !== 'unknown' && key > lastMonth) key = 'later';
    item.amount_inc_gst = r2(item.amount_inc_gst);
    item.bucket = key;
    bucketOf[key].items.push(item);
    if (item.person_id) (itemsByPerson[item.person_id] = itemsByPerson[item.person_id] || []).push(item);
  };
  var who = function (inv) { var p = personById[str(inv.person_id)]; return (p && p.name) || str(inv.doctor) || ''; };

  var invoices = arr(inp.invoices).filter(function (x) {
    return str(x.type || 'ACCREC').toUpperCase() === 'ACCREC' && ['VOIDED', 'DELETED', 'DRAFT'].indexOf(str(x.status).toUpperCase()) === -1;
  });
  var plans = arr(inp.plans);

  if (connected) {
    // 1. Unpaid invoices: overdue → "Owed now"; not due yet → their due month.
    invoices.forEach(function (x) {
      var st = str(x.status).toUpperCase();
      var due = num(x.amount_due) || 0;
      if (['AUTHORISED', 'SUBMITTED'].indexOf(st) === -1 || !(due > 0)) return;
      var own = lower(x.owner_status);
      if (own === 'paid_outside_xero' || own === 'not_owed') return;
      var dd = isoDate(x.due_date);
      var overdue = !!dd && dd < today;
      var item = {
        doctor: who(x), person_id: x.person_id || null, from: str(x.contact_name), amount_inc_gst: due,
        kind: overdue ? 'overdue' : (x.plan_id ? 'plan' : 'invoiced'),
        confidence: x.failed ? 'unknown' : 'agreed', invoice_number: str(x.invoice_number) || null, date: dd || null,
        basis: (overdue ? 'Invoiced, was due ' + fmtDate(dd) : 'Invoiced, due ' + (dd ? fmtDate(dd) : 'date not set')) +
          (num(x.amount_paid) > 0 ? ' (part paid ' + money(x.amount_paid) + ')' : '') +
          (own === 'chase' ? ' · you marked it to chase' : '') +
          (x.failed ? ' · placement failed: decide whether to chase' : '') +
          (st === 'SUBMITTED' ? ' · still awaiting approval in Xero' : '')
      };
      put(overdue ? 'owed' : (dd || 'unknown'), item);
    });

    // 2. Payment plans: the instalments not invoiced yet, one a month from the next one.
    plans.forEach(function (pl) {
      var remaining = num(pl.remaining_inc) || 0;
      if (!(remaining > 1) || pl.failed) return;
      var M = num(pl.months), raised = num(pl.invoiced_n) || 0;
      var n = M && M > raised ? M - raised : 1;
      var each = remaining / n;
      var next = isoDate(pl.next_due);
      for (var k = 0; k < n; k++) {
        var when = next ? (function (d, add) { var key = addMonths(monthKey(d), add); var last = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate(); return key + '-' + ('0' + Math.min(Number(d.slice(8, 10)), last)).slice(-2); })(next, k) : null;
        put(when || 'unknown', {
          doctor: (personById[str(pl.person_id)] || {}).name || str(pl.doctor), person_id: pl.person_id || null, from: str(pl.contact),
          amount_inc_gst: k === n - 1 ? remaining - r2(each) * (n - 1) : each, kind: 'plan', confidence: 'agreed',
          invoice_number: null, plan: str(pl.id), date: when,
          basis: 'Payment plan ' + pl.id + ', instalment ' + (raised + k + 1) + (M ? ' of ' + M : '') + (when ? ', ~' + fmtDate(when) : '')
        });
      }
    });

    // 3. Second 50%: an advance invoice with no balance invoice after it.
    invoices.forEach(function (x) {
      if (x.plan_id || x.failed) return;
      var text = str(x.line_text) + ' ' + str(x.reference);
      if (!ADVANCE_RE.test(text) || /balance/i.test(text)) return;
      var total = num(x.total);
      if (!(total > 0)) return;
      var contact = lower(x.contact_name);
      var doc = str(x.doctor);
      // The plan is the whole fee for that doctor.
      var onPlan = plans.some(function (pl) { return (x.person_id && pl.person_id && str(pl.person_id) === str(x.person_id)) || (doc && pl.doctor && sameDoctor(pl.doctor, doc)); });
      if (onPlan) return;
      var balanced = invoices.some(function (y) {
        if (y === x || lower(y.contact_name) !== contact || !BALANCE_RE.test(str(y.line_text) + ' ' + str(y.reference))) return false;
        var xd = isoDate(x.invoice_date), yd = isoDate(y.invoice_date);
        if (xd && yd && yd < xd) return false;
        if (x.person_id && y.person_id) return str(x.person_id) === str(y.person_id);
        if (doc && y.doctor) return sameDoctor(doc, y.doctor);
        if (doc) { var w = names().normName(doc).split(' '); return names().normName(y.line_text).split(' ').indexOf(w[w.length - 1]) !== -1; }
        return !y.doctor; // neither names a doctor: the same practice's balance
      });
      if (balanced) return;
      var s = x.person_id ? startOf(str(x.person_id)) : expectedStart(null, today);
      var pay = s.date ? addDays(s.date, PAY_TERMS_DAYS) : null;
      put(pay || 'unknown', {
        doctor: who(x), person_id: x.person_id || null, from: str(x.contact_name), amount_inc_gst: total, kind: 'second_half',
        confidence: s.date ? s.confidence : 'unknown', invoice_number: str(x.invoice_number) || null, date: pay,
        basis: 'Second 50% after ' + (x.invoice_number || 'the advance') + (s.date
          ? (pay < today ? ': start date ' + fmtDate(s.date) + ' has passed, raise the balance invoice' : ': start ' + fmtDate(s.date) + ' + 7 days to pay (' + s.label.toLowerCase() + ')')
          : (doc || x.person_id ? ': no start date for this doctor' : ': no doctor named on the invoice'))
      });
    });

    // 4. Signed / at visa with no invoice at all: first 50% now, second 50% at start.
    people.forEach(function (p) {
      // First 50% paid outside Xero (metadata.fee_first_half_paid, e.g. an old
      // Zoho invoice): not "to invoice"; only the second half is still to come.
      var fh = p.first_half_paid && typeof p.first_half_paid === 'object' ? p.first_half_paid : null;
      if (fh && !p.has_xero_invoice && p.stage !== 'started' && p.stage !== 'later' && p.stage !== 'closed') {
        var second = num(p.fee_second_half_inc_gst) || num(fh.amount_inc_gst);
        if (second > 0) {
          var s0 = startOf(str(p.id));
          var pay0 = s0.date ? addDays(s0.date, PAY_TERMS_DAYS) : null;
          put(pay0 || 'unknown', {
            doctor: str(p.name), person_id: str(p.id), from: str(p.practice), amount_inc_gst: second, kind: 'second_half',
            confidence: s0.date ? s0.confidence : 'unknown', invoice_number: null, date: pay0,
            basis: 'Second 50% after ' + ((/INV-?\d+/i.exec(str(fh.invoice)) || [str(fh.invoice).trim()])[0] || 'the first half') + ' (paid ' + (isoDate(fh.paid_on) ? fmtDate(isoDate(fh.paid_on)) : '') + ', outside Xero)' +
              (s0.date ? (pay0 < today ? ': start date ' + fmtDate(s0.date) + ' has passed, raise the balance invoice' : ': start ' + fmtDate(s0.date) + ' + 7 days (' + s0.label.toLowerCase() + ')') : ': no start date')
          });
        }
        return;
      }
      if ((p.stage !== 'signed' && p.stage !== 'visa') || p.has_invoice) return;
      var fee = num(p.fee_total_ex_gst);
      var half = (fee && fee > 0 ? fee : DEFAULT_FEE_EX_GST) / 2 * (1 + GST_RATE);
      put(today, {
        doctor: str(p.name), person_id: str(p.id), from: str(p.practice), amount_inc_gst: half, kind: 'to_invoice', confidence: 'estimated',
        invoice_number: null, date: today,
        basis: 'No invoice in Xero yet: first 50% is due on contract acceptance, raise it now' + (fee && fee > 0 ? '' : ' (standard $25,000 ex GST fee assumed)')
      });
      var s = startOf(str(p.id));
      var pay = s.date ? addDays(s.date, PAY_TERMS_DAYS) : null;
      put(pay || 'unknown', {
        doctor: str(p.name), person_id: str(p.id), from: str(p.practice), amount_inc_gst: half, kind: 'second_half', confidence: s.date ? s.confidence : 'unknown',
        invoice_number: null, date: pay,
        basis: 'Second 50% when they start' + (s.date ? ': start ' + fmtDate(s.date) + ' + 7 days (' + s.label.toLowerCase() + ')' : ': no start date')
      });
    });
  }

  // 5. Money the owner added by hand.
  var expectations = arr(inp.expectations).filter(function (e) { return !e.archived_at && num(e.amount_inc_gst) > 0; });
  expectations.forEach(function (e) {
    var d = isoDate(e.expected_date);
    var hit = null;
    if (e.doctor_name) { var hits = people.filter(function (p) { return sameDoctor(p.name, e.doctor_name); }); if (hits.length === 1) hit = hits[0]; }
    var conf = ['agreed', 'estimated', 'unknown'].indexOf(lower(e.confidence)) !== -1 ? lower(e.confidence) : 'estimated';
    put(d || 'unknown', {
      doctor: str(e.doctor_name) || (hit ? hit.name : ''), person_id: hit ? str(hit.id) : null, from: str(e.from_name), amount_inc_gst: num(e.amount_inc_gst),
      kind: 'manual', confidence: d ? conf : 'unknown', invoice_number: null, date: d || null, expectation_id: str(e.id) || null,
      basis: str(e.label) + (e.note ? ' · ' + str(e.note) : '') + (d && d < today ? ' · expected ' + fmtDate(d) + ', not in yet' : '')
    });
  });

  var kindOrder = {};
  KINDS.forEach(function (k, i2) { kindOrder[k.k] = i2; });
  buckets.forEach(function (b) {
    b.items.sort(function (x, y) { return (kindOrder[x.kind] - kindOrder[y.kind]) || str(x.date).localeCompare(str(y.date)) || (y.amount_inc_gst - x.amount_inc_gst); });
    b.total = r2(b.items.reduce(function (s2, it) { return s2 + it.amount_inc_gst; }, 0));
    b.by_kind = {};
    KINDS.forEach(function (k) { var t = b.items.filter(function (it) { return it.kind === k.k; }).reduce(function (s2, it) { return s2 + it.amount_inc_gst; }, 0); if (t) b.by_kind[k.k] = r2(t); });
  });
  var sumMonths = function (n) { return r2(months.slice(0, n).reduce(function (s2, k) { return s2 + bucketOf[k].total; }, 0)); };

  // Doctors: everyone signed or at visa, plus anyone money is expected for.
  var doctors = people.filter(function (p) { return p.stage === 'signed' || p.stage === 'visa' || itemsByPerson[str(p.id)]; }).map(function (p) {
    var s = startOf(str(p.id));
    var its = itemsByPerson[str(p.id)] || [];
    return {
      id: str(p.id), name: str(p.name), practice: str(p.practice), stage: str(p.stage),
      expected_start: s.date, start_basis: s.basis, start_label: s.label, confidence: s.confidence,
      owner_basis: isoDate(p.expected_start) ? (lower(p.expected_start_basis) === 'agreed' ? 'agreed' : 'estimated') : null,
      amount_inc_gst: r2(its.reduce(function (s2, it) { return s2 + it.amount_inc_gst; }, 0)),
      items: its.map(function (it) { return { kind: it.kind, amount_inc_gst: it.amount_inc_gst, bucket: it.bucket, date: it.date, invoice_number: it.invoice_number || null, confidence: it.confidence }; })
    };
  });
  var stageRank = { visa: 0, signed: 1, started: 2 };
  doctors.sort(function (x, y) { return str(x.expected_start || '9999').localeCompare(str(y.expected_start || '9999')) || ((stageRank[x.stage] == null ? 9 : stageRank[x.stage]) - (stageRank[y.stage] == null ? 9 : stageRank[y.stage])) || x.name.localeCompare(y.name); });

  return {
    connected: connected, tz: tz, today: today, months: months,
    buckets: buckets,
    totals: { next_3_months: sumMonths(3), next_12_months: sumMonths(MONTHS_AHEAD), owed_now: bucketOf.owed.total, unknown: bucketOf.unknown.total, after_12_months: bucketOf.later.total },
    doctors: doctors,
    expectations: expectations.map(function (e) { return { id: str(e.id), label: str(e.label), from_name: str(e.from_name), doctor_name: str(e.doctor_name), amount_inc_gst: r2(e.amount_inc_gst), expected_date: isoDate(e.expected_date) || null, confidence: str(e.confidence) || 'estimated', note: str(e.note) }; }),
    kinds: KINDS,
    rules: { pay_terms_days: PAY_TERMS_DAYS, default_fee_ex_gst: DEFAULT_FEE_EX_GST, signed_lead_days: SIGNED_LEAD_DAYS, visa_lead_days: VISA_LEAD_DAYS }
  };
}

module.exports = {
  buildIncomeForecast: buildIncomeForecast,
  expectedStart: expectedStart,
  sameDoctor: sameDoctor,
  KINDS: KINDS,
  DEFAULT_FEE_EX_GST: DEFAULT_FEE_EX_GST
};

'use strict';

// CEO dashboard Overview ("E", 2026-11-05): the owner's morning read, built
// from rows the route already fetched. Pure — no DB, no env, no clock of its
// own (nowMs comes in). The route's `gte` filters are only caps: every window
// is re-applied here so a count never depends on how wide the fetch was.
// PRIVACY: site_enquiries.metadata also carries ip + user_agent, so every
// field that leaves this module is named — raw metadata is never spread.
// The caller is "Hayley" everywhere the owner reads; code keys stay `hazel`.

var ceoMetrics = require('./ceo-metrics.js');

var DAY_MS = 86400000;
var HOUR_MS = 3600000;
var WINDOW_DAYS = { '7d': 7, '30d': 30 };
var SOURCE_LABELS = { meta_lead_ad: 'Meta lead', site_start_form: 'Website /start', calendly_direct: 'Calendly direct' };
var DRAFT_OPEN_STATUSES = ['draft', 'ready', 'scheduled'];
var CONTRACT_FLAGGED = ['major_discrepancies', 'discrepancies'];
var CONTRACT_CLOSED = ['signed', 'withdrawn', 'archived'];
var NOT_GP_RE = /health ?care assistant|nurse|pharmac|not a (gp|doctor)/i;
var CREDIT_ERR_RE = /402|credit/i;

// ── Time helpers ────────────────────────────────────────────────
function ms(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  var t = Date.parse(String(v));
  return Number.isFinite(t) ? t : NaN;
}
function between(v, fromMs, toMs) {
  var t = ms(v);
  return Number.isFinite(t) && t >= fromMs && (toMs == null || t <= toMs);
}
function iso(t) { return new Date(t).toISOString(); }

var _fmtCache = {};
function fmt(tz, opts) {
  var key = tz + '|' + JSON.stringify(opts);
  if (!_fmtCache[key]) _fmtCache[key] = new Intl.DateTimeFormat('en-AU', Object.assign({ timeZone: tz }, opts));
  return _fmtCache[key];
}
function parts(tz, date, opts) {
  var out = {};
  fmt(tz, opts).formatToParts(date).forEach(function (p) { if (p.type !== 'literal') out[p.type] = p.value; });
  return out;
}
// 'YYYY-MM-DD' of the calendar day `date` falls on in `tz`.
function localDayKey(date, tz) {
  var d = date instanceof Date ? date : new Date(ms(date));
  if (!Number.isFinite(d.getTime())) return '';
  var key = tz + '|day';
  if (!_fmtCache[key]) _fmtCache[key] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return _fmtCache[key].format(d);
}
// Wall-clock offset of tz at `atMs` (local minus UTC), via Intl parts.
function tzOffsetMs(tz, atMs) {
  var p = parts(tz, new Date(atMs), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  var wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return wall - Math.floor(atMs / 1000) * 1000;
}
// UTC ms at which the local day `key` (YYYY-MM-DD) starts in tz. One
// correction pass covers a DST switch on that night.
function startOfLocalDay(key, tz) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return NaN;
  var utcMidnight = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  var guess = utcMidnight - tzOffsetMs(tz, utcMidnight);
  return utcMidnight - tzOffsetMs(tz, guess);
}
function shiftDayKey(key, days) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return '';
  var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}
// 'Thu 6 Nov 23:00'
function fmtWhen(v, tz) {
  var t = ms(v); if (!Number.isFinite(t)) return '';
  var p = parts(tz, new Date(t), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return p.weekday + ' ' + p.day + ' ' + p.month + ' ' + p.hour + ':' + p.minute;
}
// 'Thu 6 Nov'
function fmtDay(v, tz) {
  var t = ms(v); if (!Number.isFinite(t)) return '';
  var p = parts(tz, new Date(t), { weekday: 'short', day: 'numeric', month: 'short' });
  return p.weekday + ' ' + p.day + ' ' + p.month;
}
// '6 Nov'
function fmtDayShort(v, tz) {
  var t = ms(v); if (!Number.isFinite(t)) return '';
  var p = parts(tz, new Date(t), { day: 'numeric', month: 'short' });
  return p.day + ' ' + p.month;
}
// '23:00'
function fmtTime(v, tz) {
  var t = ms(v); if (!Number.isFinite(t)) return '';
  var p = parts(tz, new Date(t), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return p.hour + ':' + p.minute;
}
// 'Thursday 6 November'
function fmtDateLabel(v, tz) {
  var p = parts(tz, new Date(ms(v)), { weekday: 'long', day: 'numeric', month: 'long' });
  return p.weekday + ' ' + p.day + ' ' + p.month;
}

// ── Small formatters ────────────────────────────────────────────
function num(v) { var n = Number(v); return Number.isFinite(n) ? n : null; }
function round(v, dp) { var n = num(v); if (n === null) return null; var f = Math.pow(10, dp || 0); return Math.round(n * f) / f; }
function money(v) {
  var n = num(v) || 0;
  return '$' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
function clip(s, n) { var t = String(s == null ? '' : s).trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; }
function lower(s) { return String(s || '').trim().toLowerCase(); }
function emailLocal(email) { var e = lower(email); return e.indexOf('@') > 0 ? e.slice(0, e.indexOf('@')) : e; }
var GMAIL_URL = 'https://mail.google.com/mail/u/0/#inbox/';
function gmailUrl(id) { id = String(id || '').trim(); return id ? GMAIL_URL + encodeURIComponent(id) : ''; }
// Where the owner goes for the context behind a task: the WhatsApp thread in
// DoubleTick, the email in Gmail, else the task itself on the GP file.
function taskOrigin(t) {
  var dt = String((t && t.doubletick_conversation_url) || '').trim();
  if (/^https:\/\/([a-z0-9-]+\.)?doubletick\.io\//i.test(dt)) return { kind: 'doubletick', url: dt };
  var gm = gmailUrl(t && (t.gmail_thread_id || t.source_gmail_message_id || t.gmail_message_id));
  if (gm) return { kind: 'gmail', url: gm };
  return { kind: 'task', url: '' };
}
function emailDomain(email) { var e = lower(email); return e.indexOf('@') > 0 ? e.slice(e.indexOf('@') + 1) : e; }
function byNewest(field) {
  return function (a, b) { return (ms(b[field]) || 0) - (ms(a[field]) || 0); };
}
function arr(v) { return Array.isArray(v) ? v.filter(Boolean) : []; }

// ── Lead projections ────────────────────────────────────────────
function leadSource(row) { return String((row.metadata && row.metadata.source) || ''); }
function leadConsult(row) {
  var c = row.metadata && row.metadata.consult;
  return (c && typeof c === 'object') ? c : {};
}
function leadName(row) { return String(row.name || '').trim() || emailLocal(row.email) || 'Unknown'; }
function sourceLabel(source) { return SOURCE_LABELS[source] || source || 'Website'; }
function leadBooked(c) { return !!c.call_booked_at || c.call_booked === true; }
function leadRung(c) { return !!(c.ai_call && typeof c.ai_call === 'object'); }
function leadSpoke(c, noContact) {
  return arr(c.ai_calls).some(function (h) {
    return Number(h.duration_s) > 0 && noContact.indexOf(String(h.outcome || '')) === -1;
  });
}
function hayleyNote(c) {
  if (c.booked_via === 'hazel') return 'Hayley booked';
  var ai = c.ai_call;
  if (!ai || typeof ai !== 'object') return 'Hayley: not rung';
  var o = String(ai.outcome || '');
  if (o) return 'Hayley: ' + o.replace(/_/g, ' ');
  return 'Hayley: ' + (ai.status === 'registered' || ai.status === 'ongoing' ? 'in progress' : String(ai.status || 'rung'));
}
// Text inside the first "…" of the call-back note, else the note itself.
function quoteOf(note) {
  var s = String(note || '');
  var m = /["“]([^"”]{1,200})["”]/.exec(s);
  return clip(m ? m[1] : s, 80);
}

// ── Builders ────────────────────────────────────────────────────
function buildOverviewRaw(input) {
  var inp = input || {};
  var nowMs = Number(inp.nowMs) || Date.now();
  var tz = String(inp.tz || 'Australia/Sydney');
  var win = WINDOW_DAYS[inp.window] ? inp.window : '7d';
  var winMs = WINDOW_DAYS[win] * DAY_MS;
  var winFrom = nowMs - winMs;
  var from7 = nowMs - 7 * DAY_MS;
  var from30 = nowMs - 30 * DAY_MS;
  var noContact = arr(inp.noContactOutcomes).map(String);
  var todayKey = localDayKey(new Date(nowMs), tz);
  var sinceMs = startOfLocalDay(shiftDayKey(todayKey, -1), tz);
  var hazelStatus = (inp.hazelStatus && typeof inp.hazelStatus === 'object') ? inp.hazelStatus : { configured: false, enabled: false };

  var dayOf = function (v) { return localDayKey(new Date(ms(v)), tz); };
  var dayLabel = function (v) { return dayOf(v) === todayKey ? 'Today' : fmtDay(v, tz); };

  // Leads: kind=gp, imported Zoho records are never part of the cohort.
  var enquiries = arr(inp.site_enquiries).filter(function (r) { return String(r.kind || 'gp') === 'gp'; });
  var cohortAll = enquiries.filter(function (r) { return leadSource(r) !== 'zoho_import'; });
  var cohort = cohortAll.filter(function (r) { return between(r.created_at, winFrom, nowMs); });
  var cohort7 = cohortAll.filter(function (r) { return between(r.created_at, from7, nowMs); });
  var cohort30 = cohortAll.filter(function (r) { return between(r.created_at, from30, nowMs); });
  var leadsByEmail = {};
  enquiries.forEach(function (r) { var e = lower(r.email); if (e && !leadsByEmail[e]) leadsByEmail[e] = r; });

  // Profiles.
  var profilesAll = arr(inp.user_profiles);
  var accounts = profilesAll.filter(function (p) { return String(p.account_status || '') !== 'archived'; });
  var profById = {}, profByEmail = {};
  profilesAll.forEach(function (p) {
    if (p.user_id) profById[String(p.user_id)] = p;
    var e = lower(p.email); if (e && !profByEmail[e]) profByEmail[e] = p;
  });
  var profName = function (uid) {
    var p = profById[String(uid || '')];
    if (!p) return '';
    return [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || emailLocal(p.email);
  };

  // Registration cases → stage label per doctor.
  var stageLabel = {};
  ceoMetrics.FUNNEL_STAGES.forEach(function (s) { stageLabel[s.key] = s.label; });
  stageLabel.visa = stageLabel.pbs;
  var cases = arr(inp.registration_cases);
  var caseByUser = {};
  var caseById = {};
  cases.forEach(function (c) { if (c && c.id) caseById[String(c.id)] = c; });
  cases.forEach(function (c) { if (c.user_id && !caseByUser[String(c.user_id)]) caseByUser[String(c.user_id)] = c; });
  var stageOf = function (uid) {
    var c = caseByUser[String(uid || '')];
    return c ? (stageLabel[String(c.stage || '')] || String(c.stage || '') || 'Signed up only') : 'Signed up only';
  };

  // Consults: the owner's own consultation bookings.
  var consultsAll = arr(inp.scheduled_calls).filter(function (s) {
    return String(s.meeting_kind || '') === 'consultation' && String(s.host_kind || 'ceo') === 'ceo' && String(s.status || '') !== 'cancelled';
  });
  var consultByEmail = {};
  consultsAll.forEach(function (s) { var e = lower(s.invitee_email); if (e && !consultByEmail[e]) consultByEmail[e] = s; });
  var consultName = function (s) {
    var e = lower(s.invitee_email);
    var lead = leadsByEmail[e];
    if (lead) return leadName(lead);
    var p = profByEmail[e];
    if (p) return [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || emailLocal(e);
    return emailLocal(e) || 'Unknown';
  };
  var consultSource = function (s) {
    var lead = leadsByEmail[lower(s.invitee_email)];
    if (!lead) return 'Calendly direct';
    var c = leadConsult(lead);
    return c.booked_via === 'hazel' ? 'Hayley booked' : sourceLabel(leadSource(lead));
  };
  var upcoming = consultsAll
    .filter(function (s) { return String(s.status || '') === 'booked' && ms(s.scheduled_at) > nowMs; })
    .sort(function (a, b) { return ms(a.scheduled_at) - ms(b.scheduled_at); })
    .slice(0, 6)
    .map(function (s) {
      // lead_id lets the page open the lead drawer ("Prep") from a consult row.
      return { id: s.id, lead_id: String((leadsByEmail[lower(s.invitee_email)] || {}).id || ''), name: consultName(s), email: String(s.invitee_email || ''), at: s.scheduled_at, source: consultSource(s), zoom_join_url: String(s.zoom_join_url || '') };
    });
  var consultsToday = upcoming.filter(function (u) { return dayOf(u.at) === todayKey; });
  var bookedAtOf = function (s) { return s.booked_at || s.created_at; };
  var bookedWindow = consultsAll.filter(function (s) { return between(bookedAtOf(s), winFrom, nowMs); }).length;
  var bookedWindow7 = consultsAll.filter(function (s) { return between(bookedAtOf(s), from7, nowMs); }).length;
  var heldWindow = consultsAll.filter(function (s) { return between(s.completed_at, winFrom, nowMs); }).length;
  var noShowWindow = consultsAll.filter(function (s) { return between(s.no_show_at, winFrom, nowMs); }).length;
  var bookedSince = consultsAll.filter(function (s) { return between(bookedAtOf(s), sinceMs, nowMs); }).length;
  var heldSince = consultsAll.filter(function (s) { return between(s.completed_at, sinceMs, nowMs); }).length;
  var missedSince = consultsAll.filter(function (s) { return between(s.no_show_at, sinceMs, nowMs); }).length;
  var nextConsult = upcoming[0] || null;

  // Hayley — lead_calls, outbound only.
  var calls = arr(inp.lead_calls).filter(function (r) { return String(r.direction || 'outbound') === 'outbound'; });
  var callAt = function (r) { return r.started_at || r.created_at; };
  var callsWin = calls.filter(function (r) { return between(callAt(r), winFrom, nowMs); });
  var calls7 = calls.filter(function (r) { return between(callAt(r), from7, nowMs); });
  var spokeCall = function (r) { return Number(r.duration_s) > 0 && noContact.indexOf(String(r.outcome || '')) === -1; };
  var hayleyStats = function (rows) {
    var secs = 0, cents = 0;
    rows.forEach(function (r) { secs += Number(r.duration_s) || 0; cents += Number(r.cost_cents) || 0; });
    return {
      calls: rows.length,
      spoke: rows.filter(spokeCall).length,
      booked: rows.filter(function (r) { return r.outcome === 'booked'; }).length,
      callbacks: rows.filter(function (r) { return r.outcome === 'callback_requested'; }).length,
      voicemail: rows.filter(function (r) { return r.outcome === 'voicemail'; }).length,
      no_answer: rows.filter(function (r) { return r.outcome === 'no_answer'; }).length,
      mins: round(secs / 60, 1),
      cost: round(cents / 100, 2)
    };
  };
  var hStats = hayleyStats(callsWin);
  var lastCall = calls.filter(function (r) { return r.status === 'ended' || r.status === 'not_connected'; }).sort(byNewest('started_at'))[0];
  var lastCallAt = lastCall ? (callAt(lastCall) || null) : null;
  // Retell reports an empty balance as credit_exhausted on some calls and
  // no_valid_payment on others (lib/lead-calls.js folds both into 'failed').
  var creditRow = calls.filter(function (r) { return /^(credit_exhausted|no_valid_payment)$/.test(String(r.disconnection_reason || '')); }).sort(byNewest('started_at'))[0];
  var creditAt = creditRow ? (callAt(creditRow) || null) : null;
  var calls24h = calls.filter(function (r) { return between(callAt(r), nowMs - DAY_MS, nowMs); }).length;
  var callsSince = calls.filter(function (r) { return between(callAt(r), sinceMs, nowMs); }).length;
  var notRung = cohort7.filter(function (r) {
    var c = leadConsult(r);
    if (!String(r.phone || '').trim() || c.stopped || leadBooked(c)) return false;
    return !leadRung(c) || CREDIT_ERR_RE.test(String(c.ai_call.error || ''));
  }).slice(0, 10).map(function (r) {
    var c = leadConsult(r);
    return { id: r.id, name: leadName(r), created_at: r.created_at, source: leadSource(r), error: leadRung(c) ? String(c.ai_call.error || '') : '' };
  });
  // >= : the credit failure may itself be the newest not_connected row.
  var creditRed = !!creditAt && (!lastCallAt || ms(creditAt) >= ms(lastCallAt)) && between(creditAt, from7, nowMs);
  var hState, hHeadline;
  if (!hazelStatus.configured) { hState = 'grey'; hHeadline = 'Not configured'; }
  else if (!hazelStatus.enabled) { hState = 'amber'; hHeadline = 'Switched off (LEAD_CALLS_ENABLED)'; }
  else if (creditRed) { hState = 'red'; hHeadline = 'Out of Retell credit since ' + fmtWhen(creditAt, tz); }
  else if (calls24h === 0 && calls7.length > 0) { hState = 'amber'; hHeadline = 'No calls in 24 h'; }
  else { hState = 'green'; hHeadline = plural(calls24h, 'call') + ' today · ' + hStats.booked + ' booked this week'; }
  var hDetail = plural(calls24h, 'call') + ' in the last 24 h · ' + plural(notRung.length, 'lead') + ' not rung · ' + plural(hStats.callbacks, 'call-back') + ' promised';
  var hayley = Object.assign({ state: hState, headline: hHeadline, detail: hDetail, configured: !!hazelStatus.configured, enabled: !!hazelStatus.enabled }, hStats, {
    calls_24h: calls24h, last_call_at: lastCallAt, credit_exhausted_at: creditAt, not_rung: notRung, last_run: hazelStatus.last_run || null
  });

  // Meta — latest snapshot + latest ok review + open drafts.
  var snapRow = inp.snapshot && typeof inp.snapshot === 'object' ? inp.snapshot : null;
  var snapshot = snapRow && snapRow.snapshot && typeof snapRow.snapshot === 'object' ? snapRow.snapshot : null;
  var metaConfigured = !!inp.metaConfigured;
  var pickTotals = function (t) {
    if (!t || typeof t !== 'object') return null;
    return { spend: num(t.spend), leads: num(t.leads), cost_per_lead: num(t.cost_per_lead), reach: num(t.reach), frequency: num(t.frequency), link_clicks: num(t.link_clicks), click_to_lead_pct: num(t.click_to_lead_pct) };
  };
  var pickFunnel = function (f) {
    if (!f || typeof f !== 'object') return null;
    return { booked: num(f.booked), signed_up: num(f.signed_up), cost_per_booking: num(f.cost_per_booking) };
  };
  var totalsRaw = (snapshot && snapshot.totals) || {};
  var totals = { last_7d: pickTotals(totalsRaw.last_7d), last_30d: pickTotals(totalsRaw.last_30d), prior_7d: pickTotals(totalsRaw.prior_7d), yesterday: pickTotals(totalsRaw.yesterday) };
  var adsets = arr(snapshot && snapshot.adsets).map(function (a) {
    return { name: String(a.name || ''), status: String(a.effective_status || a.status || ''), daily_budget: num(a.daily_budget), last_edit_at: (a.learning && a.learning.last_edit_at) || null };
  });
  var pausedSince = adsets.filter(function (a) { return a.status === 'PAUSED' && a.last_edit_at; })
    .map(function (a) { return a.last_edit_at; }).sort().pop() || null;
  var liveAds = snapshot ? (num(snapshot.live_ads) || 0) : null;
  var reviewRow = inp.review && typeof inp.review === 'object' ? inp.review : null;
  var reviewBody = reviewRow && reviewRow.review && typeof reviewRow.review === 'object' ? reviewRow.review : null;
  var review = reviewBody ? {
    date: reviewRow.created_at || null,
    headline: String(reviewBody.headline || ''),
    summary: clip(reviewBody.summary, 600),
    actions_today: arr(reviewBody.actions_today).map(function (x) { return { where: String(x.where || ''), action: String(x.action || ''), why: String(x.why || '') }; })
  } : null;
  var draftsOpen = arr(inp.ad_drafts).filter(function (d) { return DRAFT_OPEN_STATUSES.indexOf(String(d.status || '')) !== -1; }).sort(byNewest('created_at'));
  var hasImage = function (d) { return !!(d.image_path || d.photo_path); };
  var drafts = draftsOpen.slice(0, 8).map(function (d) {
    return { id: d.id, headline: String(d.headline || ''), angle: String(d.angle || ''), status: String(d.status || ''), launch_at: d.launch_at || null, has_image: hasImage(d) };
  });
  var fetchedAt = snapshot ? (snapshot.fetched_at || snapRow.created_at || null) : null;
  var snapAgeH = fetchedAt ? Math.round((nowMs - ms(fetchedAt)) / HOUR_MS) : null;
  var yesterday = totals.yesterday || {};
  var spendWin = (win === '30d' ? totals.last_30d : totals.last_7d);
  var mState, mHeadline;
  if (!metaConfigured || !snapshot) { mState = 'grey'; mHeadline = 'Meta not connected'; }
  else if (liveAds === 0) { mState = 'red'; mHeadline = '0 ads live · ' + (pausedSince ? 'paused since ' + fmtDayShort(pausedSince, tz) : 'every ad set paused'); }
  else if (snapAgeH !== null && snapAgeH > 36) { mState = 'amber'; mHeadline = liveAds + ' ads live · numbers ' + snapAgeH + ' h old'; }
  else { mState = 'green'; mHeadline = liveAds + ' ads live · ' + money(totals.last_7d && totals.last_7d.spend) + ' this week'; }
  var mDetail = snapshot
    ? 'Yesterday ' + money(yesterday.spend) + ' for ' + plural(yesterday.leads || 0, 'lead') + '.' + (review && review.headline ? ' Review: ' + clip(review.headline, 110) : '')
    : 'Connect META_ADS_ACCESS_TOKEN to see the campaign here.';
  var meta = {
    state: mState, headline: mHeadline, detail: mDetail, configured: metaConfigured,
    live_ads: liveAds, adsets: adsets, paused_since: pausedSince, fetched_at: fetchedAt, snapshot_age_h: snapAgeH,
    totals: totals,
    funnel7: pickFunnel(snapshot && snapshot.funnel && snapshot.funnel.d7),
    funnel30: pickFunnel(snapshot && snapshot.funnel && snapshot.funnel.d30),
    review: review, drafts: drafts, drafts_ready: draftsOpen.filter(hasImage).length
  };

  // Registration.
  var escalatedRows = arr(inp.registration_tasks).filter(function (t) { return String(t.status || 'escalated') === 'escalated'; }).sort(byNewest('escalated_at'));
  var escalations = escalatedRows.slice(0, 3).map(function (t) {
    var ecs = caseById[String(t.case_id || '')] || null;
    var euid = ecs ? String(ecs.user_id || '') : '';
    return {
      task_id: t.id, case_id: t.case_id, user_id: euid || null, gp_name: profName(euid) || '',
      title: String(t.title || ''), reason: String(t.escalated_reason || ''), at: t.escalated_at || null,
      origin: taskOrigin(t)
    };
  });
  // Documents waiting on a HUMAN: the open doc_review / flagged_doc tasks — the
  // same set as the review queue and the Candidates-tab "!" (server
  // ATS_DOC_REVIEW_OPEN_FILTER). Not every uploaded file: the AI review or an
  // RSO clears most of those, and counting them said 19 when nothing needed
  // the owner (owner report 2026-11-05).
  var docs = arr(inp.doc_review_tasks);
  var docs7 = docs.filter(function (d) { return between(d.created_at, from7, nowMs); }).length;
  var docsList = docs.slice().sort(byNewest('created_at')).slice(0, 12).map(function (t) {
    var dcs = caseById[String(t.case_id || '')] || null;
    var duid = dcs ? String(dcs.user_id || '') : '';
    return {
      task_id: t.id, case_id: t.case_id || null, user_id: duid || null, name: profName(duid) || 'Unknown doctor',
      title: String(t.title || t.related_document_key || 'Document to review'), document_key: String(t.related_document_key || ''), created_at: t.created_at || null
    };
  });
  var urgent = arr(inp.incoming_email_todos)
    .filter(function (t) { return !t.resolved_at && String(t.ai_urgency || '') === 'urgent'; })
    .sort(byNewest('created_at')).slice(0, 3)
    .map(function (t) {
      var ucs = caseByUser[String(t.matched_user_id || '')] || null;
      return { id: t.id, who: profName(t.matched_user_id) || emailDomain(t.sender_email), subject: String(t.subject || ''), summary: clip(t.ai_summary, 160), created_at: t.created_at, user_id: t.matched_user_id || null, case_id: ucs ? (ucs.id || null) : null, gmail_url: gmailUrl(t.gmail_message_id) };
    });
  var activeCases = cases.filter(function (c) { return String(c.status || 'active') === 'active'; });
  var stageCounts = {};
  activeCases.forEach(function (c) { var k = String(c.stage || ''); if (k === 'visa') k = 'pbs'; stageCounts[k] = (stageCounts[k] || 0) + 1; });
  var byStage = ceoMetrics.FUNNEL_STAGES.map(function (s) { return [s.label, stageCounts[s.key] || 0]; });
  var rState, rHeadline;
  if (urgent.length) { rState = 'red'; rHeadline = plural(urgent.length, 'AHPRA/regulator email') + ' · ' + plural(escalatedRows.length, 'escalation'); }
  else if (escalatedRows.length || docs.length) { rState = 'amber'; rHeadline = plural(escalatedRows.length, 'escalation') + ' · ' + plural(docs.length, 'doc') + ' to review'; }
  else { rState = 'green'; rHeadline = 'All clear'; }
  var rDetail = plural(docs.length, 'document') + ' waiting for review' + (urgent.length ? ' · first: ' + urgent[0].who : '');
  var registration = {
    state: rState, headline: rHeadline, detail: rDetail,
    escalated: escalatedRows.length, escalations: escalations,
    docs_to_review: docs.length, docs_7d: docs7, docs_list: docsList, urgent: urgent,
    cases: { active: activeCases.length, by_stage: byStage }
  };

  // Needs you.
  var replies = enquiries.filter(function (r) { var c = leadConsult(r); return !!c.call_back_by && !c.call_back_done_at; })
    .map(function (r) {
      var c = leadConsult(r);
      var note = String(c.call_back_note || '');
      return {
        id: r.id, name: leadName(r), phone: String(r.phone || ''), quote: quoteOf(note),
        when: c.replied_at || c.zoho_wa_replied_at || r.created_at,
        booked_at: c.call_booked_at || '', call_at: c.call_at || '',
        has_account: c.stopped === 'signed_up', not_gp_hint: NOT_GP_RE.test(note),
        // Resolved lazily by GET /api/ceo/leads/:id/whatsapp-link and cached on the lead.
        doubletick_url: String(c.doubletick_url || '')
      };
    }).sort(byNewest('when')).slice(0, 8);
  var contracts = arr(inp.career_contracts).filter(function (k) {
    var overall = String((k.ai_review && k.ai_review.overall) || '');
    return CONTRACT_FLAGGED.indexOf(overall) !== -1 && CONTRACT_CLOSED.indexOf(String(k.status || '')) === -1;
  }).slice(0, 3).map(function (k) {
    return { id: k.id, who: profName(k.user_id) || String(k.contract_filename || ''), status: String(k.status || ''), sent_to_gp_at: k.sent_to_gp_at || null, summary: clip(k.ai_review && k.ai_review.summary, 200) };
  });
  var needs = { replies: replies, contracts: contracts, escalations: escalations };

  // Doctors & placements.
  var accountsWin = accounts.filter(function (p) { return between(p.created_at, winFrom, nowMs); });
  var accounts7 = accounts.filter(function (p) { return between(p.created_at, from7, nowMs); });
  var onboarded30 = accounts.filter(function (p) { return between(p.onboarding_completed_at, from30, nowMs); }).length;
  var incompleteRows = accounts.filter(function (p) { return !p.onboarding_completed_at; }).sort(byNewest('created_at'));
  var roles = arr(inp.career_roles);
  var openJobs = roles.filter(function (r) { return String(r.job_status || '') === 'open' && r.is_active !== false; }).length;
  var practices = arr(inp.practices).filter(function (p) { return p.is_active !== false; }).length;
  var placements = arr(inp.placements);
  var placedAt = function (p) { return p.placed_at || p.created_at; };
  var placementsActive = placements.filter(function (p) { return String(p.status || 'active') === 'active'; }).length;
  var placementsWin = placements.filter(function (p) { return between(placedAt(p), winFrom, nowMs); }).length;
  var latestPlacement = placements.slice().sort(byNewest('created_at'))[0] || null;
  var profileRow = function (p) {
    return {
      user_id: p.user_id, case_id: (caseByUser[String(p.user_id || '')] || {}).id || null,
      name: profName(p.user_id) || emailLocal(p.email), created_at: p.created_at,
      onboarded: !!p.onboarding_completed_at, stage: stageOf(p.user_id)
    };
  };
  var doctors = {
    accounts_window: accountsWin.length, accounts_total: accounts.length, onboarded_30d: onboarded30,
    incomplete: incompleteRows.length, incomplete_ids: incompleteRows.slice(0, 40).map(function (p) { return p.user_id; }),
    open_jobs: openJobs, practices: practices,
    placements_active: placementsActive, placements_window: placementsWin,
    latest_placement: latestPlacement ? { practice_name: String(latestPlacement.practice_name || ''), location: String(latestPlacement.location || ''), start_date: latestPlacement.start_date || null } : null,
    recent: accounts.slice().sort(byNewest('created_at')).slice(0, 6).map(profileRow),
    docs_to_review: docs.length, docs_7d: docs7
  };

  // Funnel.
  var cohortSpoke = cohort.filter(function (r) { return leadSpoke(leadConsult(r), noContact); });
  var cohortBooked = cohort.filter(function (r) { return leadBooked(leadConsult(r)); });
  var cohortAttended = cohort.filter(function (r) { return !!leadConsult(r).call_completed_at; });
  var leadRow = function (r) {
    var c = leadConsult(r);
    return { kind: 'lead', id: r.id, name: leadName(r), sub: dayLabel(r.created_at) + ' · ' + sourceLabel(leadSource(r)) + ' · ' + hayleyNote(c), phone: String(r.phone || '') };
  };
  var bookedRow = function (r) {
    var c = leadConsult(r);
    var sc = consultByEmail[lower(r.email)];
    var when = c.call_at || (sc && sc.scheduled_at) || c.call_booked_at;
    return { kind: 'lead', id: r.id, name: leadName(r), sub: fmtWhen(when, tz) + ' · ' + (c.booked_via === 'hazel' ? 'Hayley booked' : sourceLabel(leadSource(r))), phone: String(r.phone || ''), zoom_join_url: String((sc && sc.zoom_join_url) || '') };
  };
  var attendedRow = function (r) {
    return { kind: 'lead', id: r.id, name: leadName(r), sub: 'Attended ' + fmtDayShort(leadConsult(r).call_completed_at, tz), phone: String(r.phone || '') };
  };
  var accountRow = function (p) {
    return { kind: 'user', id: p.user_id, case_id: (caseByUser[String(p.user_id || '')] || {}).id || null, name: profName(p.user_id) || emailLocal(p.email), sub: fmtDay(p.created_at, tz) + ' · ' + (p.onboarding_completed_at ? 'onboarded' : 'onboarding not finished') + ' · ' + stageOf(p.user_id) };
  };
  var newest = function (rows, field) { return rows.slice().sort(byNewest(field)).slice(0, 12); };
  var spendTotals = spendWin || {};
  var spend = num(spendTotals.spend);
  var funnel = {
    spend: spend, cpl: num(spendTotals.cost_per_lead),
    leads: cohort.length,
    leads_meta: cohort.filter(function (r) { return leadSource(r) === 'meta_lead_ad'; }).length,
    leads_direct: cohort.filter(function (r) { return leadSource(r) === 'calendly_direct'; }).length,
    hayley_rung: cohort.filter(function (r) { return leadRung(leadConsult(r)); }).length,
    hayley_spoke: cohortSpoke.length,
    booked: cohortBooked.length,
    cost_per_booking: (spend && cohortBooked.length) ? round(spend / cohortBooked.length, 2) : null,
    attended: cohortAttended.length,
    consults_held: heldWindow,
    accounts: accountsWin.length,
    onboarded_30d: onboarded30,
    placed: placementsWin,
    placements_active: placementsActive,
    open_jobs: openJobs,
    people: {
      leads: newest(cohort, 'created_at').map(leadRow),
      spoke: newest(cohortSpoke, 'created_at').map(leadRow),
      booked: newest(cohortBooked, 'created_at').map(bookedRow),
      attended: newest(cohortAttended, 'created_at').map(attendedRow),
      accounts: newest(accountsWin, 'created_at').map(accountRow)
    }
  };
  funnel.leads_site = funnel.leads - funnel.leads_meta - funnel.leads_direct;

  // Series: 14 local days ending today.
  var dayKeys = [];
  for (var i = 13; i >= 0; i--) dayKeys.push(shiftDayKey(todayKey, -i));
  var countByDay = function (rows, field) {
    var m = {};
    rows.forEach(function (r) { var k = dayOf(r[field]); if (k) m[k] = (m[k] || 0) + 1; });
    return dayKeys.map(function (k) { return m[k] || 0; });
  };
  var consultsForSeries = consultsAll.map(function (s) { return { at: bookedAtOf(s) }; });
  var series = {
    days: dayKeys.map(function (k, idx) {
      var p = parts(tz, new Date(startOfLocalDay(k, tz) + 12 * HOUR_MS), { day: 'numeric', month: 'short' });
      return (idx === 0 || p.day === '1') ? p.day + ' ' + p.month : p.day;
    }),
    leads: countByDay(cohortAll, 'created_at'),
    booked: countByDay(consultsForSeries, 'at'),
    signups: countByDay(accounts, 'created_at')
  };

  // Tiles.
  var booked30 = cohort30.filter(function (r) { return leadBooked(leadConsult(r)); }).length;
  var spend30 = num(totals.last_30d && totals.last_30d.spend);
  var tiles = {
    cost_per_booking: funnel.cost_per_booking,
    cost_per_booking_30d: (spend30 && booked30) ? round(spend30 / booked30, 2) : null,
    hayley: { calls: hStats.calls, spoke: hStats.spoke, booked: hStats.booked, mins: hStats.mins, cost: hStats.cost }
  };

  // Brief.
  var leadsSince = cohortAll.filter(function (r) { return between(r.created_at, sinceMs, nowMs); }).sort(byNewest('created_at'));
  var cohort7Booked = cohort7.filter(function (r) { return leadBooked(leadConsult(r)); }).length;
  var cohort7Attended = cohort7.filter(function (r) { return !!leadConsult(r).call_completed_at; }).length;
  var brief = {
    date_label: fmtDateLabel(nowMs, tz),
    segments: briefSegments({
      tz: tz,
      leads_since: leadsSince.map(function (r) { return { name: leadName(r), source: leadSource(r) }; }),
      calls_since: callsSince,
      hayley_state: hState, hayley_enabled: !!hazelStatus.enabled, credit_at: creditRed ? creditAt : null,
      booked_since: bookedSince, held_since: heldSince, missed_since: missedSince,
      meta_state: mState, paused_since: pausedSince, yesterday_spend: num(yesterday.spend) || 0, yesterday_leads: num(yesterday.leads) || 0,
      week: { leads: cohort7.length, booked: cohort7Booked, attended: cohort7Attended, accounts: accounts7.length, spend: num(totals.last_7d && totals.last_7d.spend) || 0 }
    })
  };

  var consults = {
    state: upcoming.length ? 'green' : 'grey',
    headline: consultsToday.length
      ? plural(consultsToday.length, 'consult') + ' today · ' + bookedWindow + ' booked this week'
      : 'None today' + (nextConsult ? ' · next ' + fmtWhen(nextConsult.at, tz) : ''),
    detail: heldWindow + ' held, ' + noShowWindow + ' missed' + (nextConsult ? '. Next: ' + nextConsult.name + ', ' + fmtWhen(nextConsult.at, tz) : ''),
    today: consultsToday, next: nextConsult, upcoming: upcoming,
    booked_window: bookedWindow, booked_7d: bookedWindow7, held_window: heldWindow, no_show_window: noShowWindow
  };

  return {
    ok: true, now: iso(nowMs), window: win, tz: tz, generated_in_ms: 0,
    brief: brief,
    status: { meta: meta, hayley: hayley, consults: consults, registration: registration },
    funnel: funnel, needs: needs, doctors: doctors, series: series, tiles: tiles
  };
}

// The written brief: an array of { t, k? } segments the page renders as text
// and <b> runs (k: 'b' plain bold, 'bad' red, 'good' green).
function briefSegments(ctx) {
  var c = ctx || {};
  var tz = c.tz || 'Australia/Sydney';
  var out = [];
  var txt = function (t) { out.push({ t: t }); };
  var b = function (t, k) { out.push({ t: t, k: k || 'b' }); };

  // 1. Since yesterday: leads + Hayley calls.
  var leads = Array.isArray(c.leads_since) ? c.leads_since : [];
  txt('Since yesterday: ');
  b(plural(leads.length, 'new lead'));
  if (leads.length) {
    txt(' (' + leads.slice(0, 2).map(function (l) { return l.name; }).join(', ') + ', ' + sourceLabel(leads[0].source) + ')');
  }
  txt(' and ');
  var calls = Number(c.calls_since) || 0;
  b(plural(calls, 'Hayley call'), calls === 0 ? 'bad' : 'b');
  // "6 calls because credit ran out" reads wrong — the calls came first.
  if (c.hayley_state === 'red' && c.credit_at) txt((calls > 0 ? ', then Retell credit ran out at ' : ' because Retell credit ran out at ') + fmtTime(c.credit_at, tz) + ' on ' + fmtDay(c.credit_at, tz) + '.');
  else if (!c.hayley_enabled) txt(' because the dialler is switched off.');
  else txt('.');

  // 2. Consults since yesterday.
  var booked = Number(c.booked_since) || 0, held = Number(c.held_since) || 0, missed = Number(c.missed_since) || 0;
  if (!booked && !held && !missed) {
    txt(' No consults were booked or held since yesterday.');
  } else {
    txt(' ');
    b(plural(booked, 'consult') + ' booked');
    txt(' and ');
    b(held + ' attended');
    txt(' since yesterday' + (missed ? ', ' + missed + ' missed.' : ', none missed.'));
  }

  // 3. Meta.
  var ySpend = Number(c.yesterday_spend) || 0, yLeads = Number(c.yesterday_leads) || 0;
  if (c.meta_state === 'red') {
    txt(' ');
    b('No ads are running', 'bad');
    txt(c.paused_since ? ': every ad set has been paused since ' + fmtDay(c.paused_since, tz) : ': every ad set is paused');
    txt(ySpend > 0 && yLeads === 0 ? ", and yesterday's " + money(ySpend) + ' bought no leads before it stopped.' : '.');
  } else if (c.meta_state === 'grey') {
    txt(' Meta is not connected.');
  } else {
    txt(' Ads spent ' + money(ySpend) + ' yesterday for ' + plural(yLeads, 'lead') + '.');
  }

  // 4. This week.
  var w = c.week || {};
  txt(' This week: ');
  b((w.leads || 0) + ' leads, ' + (w.booked || 0) + ' booked, ' + (w.attended || 0) + ' attended, ' + plural(w.accounts || 0, 'new app account'), 'good');
  txt(' on ' + money(w.spend) + ' of spend');
  var hOff = c.hayley_state === 'red', mOff = c.meta_state === 'red';
  if (hOff && mOff) txt(' — but both engines that feed it are off right now.');
  else if (hOff) txt(' — but Hayley is off right now.');
  else if (mOff) txt(' — but the ads are off right now.');
  else txt('.');
  return out;
}

// sendJson's serializer redacts any object it has already seen as
// "[redacted-circular]", so the payload must share no references (the
// escalations list used to appear under both status.registration and needs).
function buildOverview(input) { return JSON.parse(JSON.stringify(buildOverviewRaw(input))); }

module.exports = {
  buildOverview: buildOverview,
  briefSegments: briefSegments,
  localDayKey: localDayKey,
  startOfLocalDay: startOfLocalDay,
  fmtWhen: fmtWhen,
  sourceLabel: sourceLabel,
  quoteOf: quoteOf,
  money: money,
  plural: plural
};

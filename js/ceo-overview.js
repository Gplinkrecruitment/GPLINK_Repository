/* ============================================================================
 * ceo-overview.js — the CEO dashboard's Overview master tab ("E", 2026-11-05).
 * Loaded by pages/ceo-dashboard.html AFTER /js/ceo-ats-shared.js (window.ATS).
 *
 * One written brief, four status lights with their fix buttons, one
 * lead → placement funnel whose stages open a drawer of people with actions,
 * then Needs you · Doctors & placements · Last 14 days. Everything the old
 * Overview showed lives on unchanged under Registration → Pipeline.
 *
 * Data: GET /api/ceo/overview?window=7d|30d (lib/ceo-overview.js builds it).
 * Actions reuse the existing per-lead / escalation / ads / nudge routes.
 * The caller is "Hayley" everywhere the owner reads (code keeps hazel keys).
 * Every class is ov-* — never ad-/ads- (the owner's ad blocker hides those).
 * Exposes window.loadOverviewTab(opts) — opts.quiet keeps the page on screen.
 * ========================================================================== */
(function () {
  'use strict';

  var ATS = window.ATS;
  if (!ATS) return;

  var ROOT_ID = 'overviewRoot';
  var ENDPOINT = '/api/ceo/overview';
  var FRESH_MS = 2 * 60 * 1000;      // quiet re-entry: data younger than this just repaints
  var POLL_MS = 60 * 1000;           // auto-refresh while the tab is on screen + page visible
  var WINDOW_KEY = 'gp_ov_window';
  var NUDGE_CAP = 25;

  function readWindow() {
    try { var w = localStorage.getItem(WINDOW_KEY); return w === '30d' ? '30d' : '7d'; } catch (e) { return '7d'; }
  }
  var state = {
    window: readWindow(),
    data: null,
    loadedAt: 0,
    inflight: null,
    timer: null,
    error: '',
    busy: false
  };

  function root() { return document.getElementById(ROOT_ID); }
  function esc(s) { return ATS.esc(s); }
  function escAttr(s) { return ATS.escAttr(s); }
  function isActive() { return !!window.ATS && window.ATS.activeTab === 'registration'; }

  /* =====================================================================
   *  FORMATTING
   * ===================================================================== */
  function num(n) {
    if (n == null || n === '' || isNaN(n)) return '—';
    n = Number(n);
    return Math.abs(n) >= 1000 ? n.toLocaleString('en-AU') : String(n);
  }
  function money(n, d) {
    if (n == null || n === '' || isNaN(n)) return '—';
    d = d == null ? 0 : d;
    return '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function pct(a, b) { if (!b) return '—'; return Math.round((Number(a) || 0) / b * 100) + '%'; }
  function plural(n, one, many) { n = Number(n) || 0; return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  // The owner's own zone: "today", "since yesterday" and every printed time
  // follow the browser, not the ad account (owner 2026-11-05).
  function browserTz() { try { return String(Intl.DateTimeFormat().resolvedOptions().timeZone || ''); } catch (e) { return ''; } }
  function tz() { return (state.data && state.data.tz) || browserTz() || 'Australia/Sydney'; }
  function fmtWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleString('en-AU', { timeZone: tz(), weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).replace(/,/g, '');
    } catch (e) { return d.toLocaleString(); }
  }
  function fmtDay(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleString('en-AU', { timeZone: tz(), weekday: 'short', day: 'numeric', month: 'short' }).replace(/,/g, ''); } catch (e) { return d.toDateString(); }
  }
  function fmtClock(ms) {
    try { return new Date(ms).toLocaleTimeString('en-AU', { timeZone: tz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch (e) { return ''; }
  }
  function hoursOld(iso) {
    if (!iso) return null;
    var t = Date.parse(iso);
    if (!isFinite(t)) return null;
    return Math.max(0, Math.round((Date.now() - t) / 36e5));
  }
  // Status codes come straight from the tables (sent_to_gp, awaiting_upload);
  // the owner reads words, not keys.
  var STATUS_WORDS = { sent_to_gp: 'Sent to GP', awaiting_upload: 'Awaiting upload', changes_requested: 'Changes requested' };
  function human(code) {
    var k = String(code || '').trim();
    if (!k) return '';
    if (STATUS_WORDS[k]) return STATUS_WORDS[k];
    var w = k.replace(/_/g, ' ');
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function windowLabel() { return state.window === '30d' ? 'last 30 days' : 'last 7 days'; }
  function windowShort() { return state.window === '30d' ? 'this month' : 'this week'; }

  /* =====================================================================
   *  HTML HELPERS (mirror the mockup's ui.js)
   * ===================================================================== */
  function btn(label, act, cls, attrs) {
    return '<button type="button" class="ov-btn ' + (cls || '') + '" data-ov-act="' + escAttr(act) + '"' + (attrs ? ' ' + attrs : '') + '>' + label + '</button>';
  }
  function link(label, href, cls) {
    return '<a class="ov-btn ' + (cls || '') + '" href="' + escAttr(href) + '" target="_blank" rel="noopener">' + label + ' <span class="ov-ext">↗</span></a>';
  }
  function light(st) { return '<span class="ov-light ov-' + (st || 'grey') + '"></span>'; }
  function row(o) {
    var av = '';
    if (o.avatar !== false) {
      av = '<div class="ov-avatar' + (o.avCls ? ' ' + o.avCls : '') + '">' + (o.icon || esc(ATS.initials(o.name || '?'))) + '</div>';
    }
    // o.open = { kind, attrs, ext, hint }: the main area opens where the item
    // came from (owner 2026-11-05: "click on each one so it takes me to the origin").
    var op = o.open || null;
    var mainAttrs = op ? ' data-ov-open="' + escAttr(op.kind) + '"' + (op.attrs ? ' ' + op.attrs : '') + ' title="' + escAttr(op.hint || 'Open') + '"' : '';
    return '<div class="ov-row' + (o.cls ? ' ' + o.cls : '') + '"' + (o.id ? ' data-ov-row="' + escAttr(o.id) + '"' : '') + '>' + av +
      '<div class="ov-main' + (op ? ' ov-clickable' : '') + '"' + mainAttrs + '><div class="ov-t">' + o.title + (op && op.ext ? ' <span class="ov-ext">↗</span>' : '') + '</div>' + (o.sub ? '<div class="ov-s">' + o.sub + '</div>' : '') + '</div>' +
      '<div class="ov-acts">' + (o.acts || '') + '</div></div>';
  }
  function numBox(l, v, s) {
    return '<div class="ov-num-box"><div class="ov-l">' + l + '</div><div class="ov-v">' + v + (s ? '<small>' + s + '</small>' : '') + '</div></div>';
  }
  function tile(o) {
    return '<div class="ov-tile" style="--ov-accent:' + (o.accent || 'var(--blue)') + '">' +
      '<div class="ov-label">' + o.label + '</div><div class="ov-value">' + o.value + '</div>' + (o.delta || '') + '</div>';
  }
  // Thin bars (<= 24px) for a 14-day series: last bar in the accent colour,
  // the rest grey, a <title> per bar so hovering reads the number.
  function bars(arr, days, opts) {
    opts = opts || {};
    arr = Array.isArray(arr) ? arr.map(function (v) { return Number(v) || 0; }) : [];
    if (!arr.length) return '<div class="ov-empty">No data yet.</div>';
    var w = 300, h = opts.h || 44, gap = 2, n = arr.length;
    var bw = (w - gap * (n - 1)) / n;
    var max = Math.max.apply(null, arr.concat([1]));
    var col = opts.color || 'var(--blue)';
    return '<svg class="ov-spark-wide" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="' + escAttr(opts.label || '') + '">' + arr.map(function (v, i) {
      var bh = v / max * (h - 2), x = i * (bw + gap), y = h - bh, isLast = i === n - 1;
      return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(bh, v ? 1 : 0).toFixed(1) + '" rx="1.5" fill="' + (isLast ? col : 'rgba(255,255,255,.28)') + '"><title>' + esc((days && days[i]) || (i + 1)) + ': ' + v + '</title></rect>';
    }).join('') + '</svg>';
  }

  /* =====================================================================
   *  PUBLIC ENTRY POINT
   * ===================================================================== */
  // opts.quiet: the tab was visited within the last few minutes — keep what is
  // on screen and revalidate in the background. Never blank the panel when we
  // already have a payload, whatever the opts.
  window.loadOverviewTab = function (opts) {
    opts = opts || {};
    var el = root();
    if (!el) return;
    try {
      ensureWired(el);
      startTimer();
      if (state.data) {
        render();
        if (!opts.quiet || (Date.now() - state.loadedAt) > FRESH_MS) load(true);
        return;
      }
      el.innerHTML = skeletonHtml();
      load(false);
    } catch (e) {
      console.error('[overview] render failed', e);
      el.innerHTML = '<div class="ov-error"><h3>The Overview hit an error while drawing.</h3><p>' + esc((e && e.message) || e) + '</p><div class="ov-btn-row">' + btn('Retry', 'retry', 'ov-primary ov-sm') + '</div></div>';
    }
  };

  /* =====================================================================
   *  DATA
   * ===================================================================== */
  // background=true keeps the current paint and only swaps it when the new
  // payload lands; a failure then shows a slim bar, not a blank page.
  function load(background) {
    if (state.inflight) return state.inflight;
    var w = state.window;
    setRefreshing(true);
    state.inflight = ATS.api(ENDPOINT + '?window=' + encodeURIComponent(w) + '&tz=' + encodeURIComponent(browserTz())).then(function (d) {
      state.inflight = null;
      setRefreshing(false);
      if (!d || !d.ok) {
        var msg = (d && (d.message || d.error)) || (d && d.status ? 'HTTP ' + d.status : 'Network error');
        state.error = msg;
        if (state.data && background) { showErrorBar(msg); return d; }
        renderError(msg);
        return d;
      }
      if (w !== state.window) return d; // the owner changed the window while this was in flight
      state.data = d;
      state.loadedAt = Date.now();
      state.error = '';
      render();
      return d;
    });
    return state.inflight;
  }
  function refetch() {
    load(true);
    if (window.CeoReviewQueue && typeof window.CeoReviewQueue.refresh === 'function') {
      try { window.CeoReviewQueue.refresh(); } catch (e) { /* never block the overview */ }
    }
  }
  function startTimer() {
    if (state.timer) return;
    state.timer = setInterval(function () {
      if (document.visibilityState !== 'visible' || !isActive()) return;
      if (!root()) return;
      load(true);
    }, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible' || !isActive() || !root()) return;
      if ((Date.now() - state.loadedAt) > POLL_MS) load(true);
    });
  }
  function setRefreshing(on) {
    var el = document.getElementById('ov-refreshing');
    if (el) el.textContent = on ? 'refreshing…' : '';
  }
  function showErrorBar(msg) {
    var el = root();
    if (!el) return;
    var old = el.querySelector('.ov-error-bar');
    if (old) old.parentNode.removeChild(old);
    var bar = document.createElement('div');
    bar.className = 'ov-error-bar';
    bar.innerHTML = '<span>Could not refresh the Overview: ' + esc(msg) + '. Showing the numbers from ' + esc(fmtClock(state.loadedAt)) + '.</span>' + btn('Retry', 'retry', 'ov-sm');
    el.insertBefore(bar, el.firstChild);
  }

  /* =====================================================================
   *  RENDER
   * ===================================================================== */
  function skeletonHtml() {
    return toolbarHtml() +
      '<div class="ov-skel ov-skel-brief"></div>' +
      '<div class="ov-status-strip"><div class="ov-skel"></div><div class="ov-skel"></div><div class="ov-skel"></div><div class="ov-skel"></div></div>' +
      '<div class="ov-loading">Loading…</div>';
  }
  function renderError(msg) {
    var el = root();
    if (!el) return;
    el.innerHTML = toolbarHtml() +
      '<div class="ov-error"><h3>The Overview could not load.</h3><p>' + esc(msg || 'Unknown error') + '</p>' +
      '<div class="ov-btn-row">' + btn('Retry', 'retry', 'ov-primary ov-sm') + btn('Open Pipeline (old Overview)', 'rso-tab', 'ov-sm ov-ghost') + '</div></div>';
  }
  function toolbarHtml() {
    var w = state.window;
    return '<div class="ov-toolbar"><h2>Overview</h2><div class="ov-toolbar-right">' +
      '<span class="ov-refreshing" id="ov-refreshing"></span>' +
      '<span class="ov-small ov-muted">Window</span>' +
      '<div class="ov-seg" role="group" aria-label="Window">' +
        '<button type="button" class="' + (w === '7d' ? 'ov-on' : '') + '" data-ov-act="window" data-w="7d">7 days</button>' +
        '<button type="button" class="' + (w === '30d' ? 'ov-on' : '') + '" data-ov-act="window" data-w="30d">30 days</button>' +
      '</div>' +
      btn('Email me this', 'digest', 'ov-sm', 'title="Sends the owner digest email"') +
      '</div></div>';
  }
  function render() {
    var el = root();
    if (!el || !state.data) return;
    var d = state.data;
    el.innerHTML = toolbarHtml() + briefHtml(d) + statusHtml(d) + funnelHtml(d) + '<div class="ov-gap"></div>' + lowerHtml(d);
  }

  /* ---------- brief ---------- */
  function briefHtml(d) {
    var b = d.brief || {};
    var segs = Array.isArray(b.segments) ? b.segments : [];
    var p = segs.map(function (s) {
      var t = esc(s && s.t);
      if (!s || !s.k) return t;
      if (s.k === 'bad') return '<b class="ov-bad">' + t + '</b>';
      if (s.k === 'good') return '<b class="ov-good">' + t + '</b>';
      return '<b>' + t + '</b>';
    }).join('');
    if (!p) p = '<span class="ov-muted">Nothing to report yet.</span>';
    return '<div class="ov-card ov-brief"><div class="ov-brief-txt"><h2>' + esc(b.date_label || fmtDay(d.now || Date.now())) + '</h2><p>' + p + '</p></div>' +
      '<div class="ov-since">from live data · refreshed ' + esc(fmtClock(state.loadedAt || Date.now())) + '</div></div>';
  }

  /* ---------- status strip ---------- */
  function boxCls(st) { return st === 'red' ? ' ov-alert' : st === 'amber' ? ' ov-warn' : st === 'green' ? ' ov-ok' : ''; }
  function statusBox(st, title, headline, detail, buttons) {
    return '<div class="ov-status' + boxCls(st) + '"><div class="ov-st-h">' + light(st) + esc(title) + '</div>' +
      '<div class="ov-st-v">' + headline + '</div><div class="ov-st-s">' + detail + '</div>' +
      '<div class="ov-btn-row">' + buttons + '</div></div>';
  }
  function statusHtml(d) {
    var S = d.status || {};
    return '<div class="ov-status-strip">' + metaBox(S.meta || {}, d) + hayleyBox(S.hayley || {}, d) + consultsBox(S.consults || {}, d) + registrationBox(S.registration || {}, d) + '</div>';
  }
  function metaBox(m, d) {
    var st = m.state || 'grey';
    var T = m.totals || {};
    var y = T.yesterday || {};
    var win = (state.window === '30d' ? T.last_30d : T.last_7d) || {};
    var live = m.live_ads;
    var headline;
    if (m.headline) headline = esc(m.headline);
    else if (st === 'grey') headline = 'Meta not connected';
    else if (st === 'red') headline = '0 ads live' + (m.paused_since ? ' · paused since ' + esc(fmtDay(m.paused_since)) : '');
    else if (st === 'amber') { var h = hoursOld(m.fetched_at); headline = num(live) + ' ads live · numbers ' + (h == null ? '' : h + ' h ') + 'old'; }
    else headline = num(live) + ' ads live · ' + money(win.spend) + ' ' + windowShort();
    var detail;
    if (m.detail) detail = esc(m.detail);
    else if (st === 'grey') detail = 'Add META_ADS_ACCESS_TOKEN on the server to see spend, leads and the daily review here.';
    else {
      detail = 'Yesterday ' + money(y.spend) + ' for ' + plural(y.leads, 'lead') + '.';
      if (m.review && m.review.headline) detail += ' Review: ' + esc(clip(m.review.headline, 110));
      if (m.drafts_ready) detail += ' ' + plural(m.drafts_ready, 'draft') + ' ready.';
    }
    var buttons = btn('Relaunch…', 'relaunch', 'ov-primary ov-sm') + link('Ads Manager', 'https://adsmanager.facebook.com/', 'ov-sm ov-ghost');
    return statusBox(st, 'Meta ads', headline, detail, buttons);
  }
  function hayleyBox(h, d) {
    var st = h.state || 'grey';
    var waiting = Array.isArray(h.not_rung) ? h.not_rung : [];
    var headline;
    if (h.headline) headline = esc(h.headline);
    else if (st === 'grey') headline = 'Not configured';
    else if (st === 'red') headline = 'Out of Retell credit since ' + esc(fmtWhen(h.credit_exhausted_at));
    else if (st === 'amber' && h.enabled === false) headline = 'Switched off (LEAD_CALLS_ENABLED)';
    else if (st === 'amber') headline = 'No calls in 24 h';
    else headline = plural(h.calls_24h, 'call') + ' today · ' + num(h.booked) + ' booked ' + windowShort();
    var detail;
    if (h.detail) detail = esc(h.detail);
    else detail = plural(h.calls_24h, 'call') + ' in 24 h · ' + plural(waiting.length, 'new lead') + ' not rung · ' + plural(h.callbacks, 'call-back') + ' promised.';
    var buttons = '';
    if (st === 'red') buttons += link('Top up Retell', 'https://dashboard.retellai.com/', 'ov-primary ov-sm');
    else if (st !== 'grey') buttons += link('Retell', 'https://dashboard.retellai.com/', 'ov-sm ov-ghost');
    if (waiting.length) buttons += btn('Ring the ' + waiting.length + ' waiting', 'ring-waiting', 'ov-sm');
    if (st === 'amber' && h.enabled === false) buttons += btn('Leads tab ›', 'leads-tab', 'ov-sm ov-ghost');
    if (!buttons) buttons = btn('Leads tab ›', 'leads-tab', 'ov-sm ov-ghost');
    return statusBox(st, 'Hayley (calls)', headline, detail, buttons);
  }
  function consultsBox(c, d) {
    var upcoming = Array.isArray(c.upcoming) ? c.upcoming : [];
    var todayN = Array.isArray(c.today) ? c.today.length : (Number(c.today) || 0);
    var next = c.next || upcoming[0] || null;
    var st = c.state || (todayN ? 'green' : upcoming.length ? 'green' : 'grey');
    var headline;
    if (c.headline) headline = esc(c.headline);
    else if (todayN) headline = todayN + ' today · ' + num(c.booked_window) + ' booked ' + windowShort();
    else if (next) headline = 'None today · next ' + esc(fmtWhen(next.at));
    else headline = 'None booked · ' + num(c.booked_window) + ' booked ' + windowShort();
    var detail;
    if (c.detail) detail = esc(c.detail);
    else {
      detail = num(c.held_window) + ' held, ' + num(c.no_show_window) + ' missed.';
      if (next) detail += ' Next: ' + esc(next.name || next.email || '') + ', ' + esc(fmtWhen(next.at)) + '.';
    }
    var buttons = btn(todayN ? 'Today’s prep' : 'Next consults', 'consults-drawer', 'ov-sm') + btn('Meetings ›', 'meetings-tab', 'ov-sm ov-ghost');
    return statusBox(st, 'Consults', headline, detail, buttons);
  }
  function registrationBox(r, d) {
    var st = r.state || 'grey';
    var urgent = Array.isArray(r.urgent) ? r.urgent : [];
    var escN = Number(r.escalated) || 0;
    var docs = Number(r.docs_to_review) || 0;
    var headline;
    if (r.headline) headline = esc(r.headline);
    else if (urgent.length) headline = plural(urgent.length, 'AHPRA/regulator email') + ' · ' + plural(escN, 'escalation');
    else if (escN || docs) headline = plural(escN, 'escalation') + ' · ' + docs + ' docs to review';
    else headline = 'All clear';
    var detail;
    if (r.detail) detail = esc(r.detail);
    else {
      detail = plural(docs, 'document') + ' waiting for review.';
      if (urgent[0]) detail += ' ' + esc(urgent[0].who || 'Someone') + ': ' + esc(clip(urgent[0].subject || urgent[0].summary || 'urgent email', 70)) + '.';
      else if (r.cases && r.cases.active != null) detail += ' ' + plural(r.cases.active, 'active case') + '.';
    }
    var buttons = '';
    if (urgent[0] && (urgent[0].case_id || urgent[0].user_id)) buttons += btn('Open doctor', 'open-doctor', 'ov-sm', 'data-case="' + escAttr(urgent[0].case_id || '') + '" data-user="' + escAttr(urgent[0].user_id || '') + '"');
    if (docs > 0) buttons += btn('Review docs (' + docs + ')', 'review-docs', 'ov-sm' + (urgent[0] && urgent[0].user_id ? ' ov-ghost' : ''));
    buttons += btn('Registration ›', 'rso-tab', 'ov-sm ov-ghost');
    return statusBox(st, 'Registration', headline, detail, buttons);
  }

  /* ---------- funnel ---------- */
  function funnelStages(d) {
    var F = d.funnel || {};
    return [
      { k: 'spend', l: 'Meta spend', n: money(F.spend), c: money(F.cpl) + ' per lead', bar: F.spend ? 1 : 0, money: true },
      { k: 'leads', l: 'Leads', n: num(F.leads), c: num(F.leads_meta) + ' Meta · ' + num(F.leads_site) + ' site · ' + num(F.leads_direct) + ' direct', bar: F.leads },
      { k: 'spoke', l: 'Hayley spoke to', n: num(F.hayley_spoke), c: pct(F.hayley_spoke, F.leads) + ' of leads · ' + num(F.hayley_rung) + ' rung', bar: F.hayley_spoke },
      { k: 'booked', l: 'Consult booked', n: num(F.booked), c: pct(F.booked, F.leads) + ' of leads · ' + money(F.cost_per_booking) + ' each', bar: F.booked },
      { k: 'attended', l: 'Attended', n: num(F.attended), c: pct(F.attended, F.booked) + ' of this cohort · ' + num(F.consults_held) + ' consults held', bar: F.attended },
      { k: 'accounts', l: 'App account', n: num(F.accounts), c: num(F.onboarded_30d) + ' onboarded (30d)', bar: F.accounts },
      { k: 'placed', l: 'Placed', n: num(F.placed), c: num(F.placements_active) + ' active · ' + num(F.open_jobs) + ' open jobs', bar: F.placed ? 1 : 0, money: true }
    ];
  }
  function funnelHtml(d) {
    var stages = funnelStages(d);
    var max = Math.max.apply(null, stages.map(function (s) { return s.money ? 0 : (Number(s.bar) || 0); }).concat([1]));
    var cells = stages.map(function (s) {
      var w = s.money ? (s.bar ? 100 : 0) : Math.round((Number(s.bar) || 0) / max * 100);
      return '<button type="button" class="ov-stage' + (s.money ? ' ov-money' : '') + '" data-ov-act="stage" data-stage="' + s.k + '">' +
        '<div class="ov-st-l">' + s.l + '</div><div class="ov-st-n">' + s.n + '</div>' +
        '<div class="ov-bar"><i style="width:' + w + '%"></i></div><div class="ov-st-c">' + s.c + '</div><div class="ov-st-a">open ›</div></button>';
    }).join('');
    return '<div class="ov-card"><div class="ov-card-h"><h3>Lead → placement, ' + windowLabel() + '</h3><div class="ov-right"><span class="ov-small ov-muted">click a stage to see the people in it</span></div></div>' +
      '<div class="ov-card-b"><div class="ov-funnel">' + cells + '</div></div></div>';
  }

  /* ---------- lower row ---------- */
  function lowerHtml(d) {
    return '<div class="ov-lower">' + needsHtml(d) + doctorsHtml(d) + trendHtml(d) + '</div>';
  }
  function needsHtml(d) {
    var N = d.needs || {};
    var R = (d.status && d.status.registration) || {};
    var replies = Array.isArray(N.replies) ? N.replies : [];
    var contracts = Array.isArray(N.contracts) ? N.contracts : [];
    var escs = Array.isArray(N.escalations) ? N.escalations : [];
    var urgent = Array.isArray(R.urgent) ? R.urgent : [];
    var rows = '';
    replies.forEach(function (x) {
      var note, primary;
      if (x.not_gp_hint) { note = 'Not a GP? mark not qualified'; primary = btn('Not a GP', 'dnc', 'ov-sm', 'data-id="' + escAttr(x.id) + '" data-name="' + escAttr(x.name || '') + '"'); }
      else if (x.booked_at) { note = 'Consult already booked ' + esc(fmtWhen(x.call_at || x.booked_at)); primary = ''; }
      else if (x.has_account) { note = 'Has an account, onboarding not finished'; primary = btn('Call now', 'ring', 'ov-sm', 'data-id="' + escAttr(x.id) + '" data-name="' + escAttr(x.name || '') + '" data-phone="' + escAttr(x.phone || '') + '"'); }
      else { note = 'Replied ' + esc(fmtDay(x.when)) + (x.phone ? ' · ' + esc(x.phone) : ''); primary = btn('Call now', 'ring', 'ov-sm', 'data-id="' + escAttr(x.id) + '" data-name="' + escAttr(x.name || '') + '" data-phone="' + escAttr(x.phone || '') + '"'); }
      var waAttrs = 'data-id="' + escAttr(x.id) + '" data-name="' + escAttr(x.name || '') + '" data-url="' + escAttr(x.doubletick_url || '') + '"';
      rows += row({
        id: 'reply-' + x.id, name: x.name,
        title: esc(x.name || 'Lead') + ' <span class="ov-muted ov-small">replied “' + esc(clip(x.quote || '', 80)) + '”</span>',
        sub: note,
        open: { kind: 'whatsapp', attrs: waAttrs, ext: true, hint: 'Open the WhatsApp chat in DoubleTick' },
        acts: btn('Chat', 'whatsapp-chat', 'ov-sm ov-ghost', waAttrs) + primary + btn('Done', 'callback-done', 'ov-sm ov-ghost', 'data-id="' + escAttr(x.id) + '"')
      });
    });
    contracts.forEach(function (k) {
      rows += row({
        name: k.who,
        title: esc(k.who || 'Doctor') + ' <span class="ov-muted ov-small">contract</span>',
        sub: esc(clip(k.summary || 'Review flagged discrepancies', 120)) + (k.status ? ' · ' + esc(human(k.status)) : ''),
        open: { kind: 'contracts', hint: 'Open the Contracts tab' },
        acts: btn('Review', 'contracts-tab', 'ov-sm')
      });
    });
    escs.forEach(function (e) {
      var eo = e.origin || {};
      var eOpen = eo.url ? { kind: 'url', attrs: 'data-url="' + escAttr(eo.url) + '"', ext: true, hint: eo.kind === 'doubletick' ? 'Open the WhatsApp thread in DoubleTick' : 'Open the email in Gmail' }
        : { kind: 'gp-tasks', attrs: 'data-case="' + escAttr(e.case_id || '') + '" data-user="' + escAttr(e.user_id || '') + '"', hint: 'Open the task on the GP file' };
      rows += row({
        id: 'esc-' + e.task_id, name: 'RSO', icon: '!', avCls: 'ov-amber',
        title: esc(e.title || 'Escalated task') + (e.gp_name ? ' <span class="ov-muted ov-small">' + esc(e.gp_name) + '</span>' : ''),
        sub: esc(e.reason || '') + (e.at ? ' · ' + esc(fmtWhen(e.at)) : ''),
        open: eOpen,
        acts: btn('Resolve', 'esc-resolve', 'ov-sm', 'data-id="' + escAttr(e.task_id) + '"') + btn('Reply', 'esc-respond', 'ov-sm ov-ghost', 'data-id="' + escAttr(e.task_id) + '"')
      });
    });
    urgent.forEach(function (u) {
      rows += row({
        id: 'mail-' + u.id, name: u.who || '@', icon: '@', avCls: 'ov-red',
        title: esc(u.who || 'Unknown sender') + ' <span class="ov-muted ov-small">urgent email</span>',
        sub: esc(clip(u.subject || '', 80)) + (u.summary ? ' — ' + esc(clip(u.summary, 160)) : ''),
        open: u.gmail_url ? { kind: 'url', attrs: 'data-url="' + escAttr(u.gmail_url) + '"', ext: true, hint: 'Open the email in Gmail' }
          : ((u.case_id || u.user_id) ? { kind: 'candidate', attrs: 'data-case="' + escAttr(u.case_id || '') + '" data-user="' + escAttr(u.user_id || '') + '"', hint: 'Open the doctor' } : null),
        acts: ((u.case_id || u.user_id) ? btn('Open doctor', 'open-doctor', 'ov-sm', 'data-case="' + escAttr(u.case_id || '') + '" data-user="' + escAttr(u.user_id || '') + '"') : '') + btn('Handled', 'email-handled', 'ov-sm ov-ghost', 'data-id="' + escAttr(u.id) + '"')
      });
    });
    var count = replies.length + contracts.length + escs.length + urgent.length;
    return '<div class="ov-card"><div class="ov-card-h"><h3>Needs you</h3><div class="ov-right"><span class="ov-pill ' + (count ? 'ov-red' : 'ov-green') + '">' + count + ' items</span></div></div>' +
      '<div class="ov-card-b"><div class="ov-rows">' + (rows || '<div class="ov-empty">Nothing waiting on you.</div>') + '</div></div></div>';
  }
  function doctorsHtml(d) {
    var D = d.doctors || {};
    var N = d.needs || {};
    var S = d.series || {};
    var contracts = Array.isArray(N.contracts) ? N.contracts : [];
    var recent = Array.isArray(D.recent) ? D.recent : [];
    var incomplete = Number(D.incomplete) || 0;
    var ids = Array.isArray(D.incomplete_ids) ? D.incomplete_ids : [];
    var st = (contracts.length || (Number(D.docs_to_review) || 0) > 0) ? 'amber' : 'green';
    var h = '<div class="ov-card ov-lane"><div class="ov-card-h"><h3>' + light(st) + 'Doctors &amp; placements</h3><div class="ov-right">' + btn('Candidates ›', 'candidates-tab', 'ov-sm ov-ghost') + '</div></div><div class="ov-card-b">';
    if (contracts.length) {
      var k = contracts[0];
      h += '<div class="ov-alertbox ov-amber"><div><b>Contract mismatch.</b> ' + esc(k.who || 'A doctor') + '’s contract: ' + esc(clip(k.summary || 'the AI review found discrepancies', 200)) +
        (k.status ? ' Status: ' + esc(human(k.status)) + '.' : '') + (k.sent_to_gp_at ? ' Sent ' + esc(fmtDay(k.sent_to_gp_at)) + '.' : '') +
        (contracts.length > 1 ? ' +' + (contracts.length - 1) + ' more.' : '') + '</div>' +
        '<div class="ov-btn-row">' + btn('Open review', 'contracts-tab', 'ov-primary ov-sm') + '</div></div>';
    }
    h += '<div class="ov-nums"' + (contracts.length ? ' style="margin-top:12px"' : '') + '>' +
      numBox('New app accounts', num(D.accounts_window), num(D.accounts_total) + ' total') +
      numBox('Onboarded', num(D.onboarded_30d), '30d · ' + incomplete + ' stuck') +
      numBox('Open jobs', num(D.open_jobs), num(D.practices) + ' practices') +
      numBox('Placements', num(D.placements_active), 'active') + '</div>';
    h += '<div class="ov-chart-label">Sign-ups per day</div>' + bars(S.signups, S.days, { h: 36, color: 'var(--green)', label: 'Sign-ups per day, last 14 days' });
    h += '<div class="ov-sec">Signed up ' + windowShort() + '</div><div class="ov-rows">';
    if (!recent.length) h += '<div class="ov-empty">No new accounts yet.</div>';
    recent.slice(0, 4).forEach(function (r) {
      h += row({
        name: r.name,
        title: esc(r.name || 'New account'),
        sub: esc(fmtDay(r.created_at)) + ' · ' + (r.onboarded ? '<span class="ov-onb-ok">onboarded</span>' : '<span class="ov-onb-no">onboarding not finished</span>') + (r.stage ? ' · ' + esc(r.stage) : ''),
        open: (r.case_id || r.user_id) ? { kind: 'candidate', attrs: 'data-case="' + escAttr(r.case_id || '') + '" data-user="' + escAttr(r.user_id || '') + '"', hint: 'Open the doctor' } : null,
        acts: r.onboarded ? btn('Open', 'open-doctor', 'ov-sm', 'data-case="' + escAttr(r.case_id || '') + '" data-user="' + escAttr(r.user_id) + '"') : btn('Nudge', 'nudge', 'ov-sm', 'data-user="' + escAttr(r.user_id) + '"')
      });
    });
    h += '</div>';
    var lp = D.latest_placement || null;
    h += '<div class="ov-sec">Waiting on you</div><div class="ov-rows">' +
      row({ avatar: false, title: plural(D.docs_to_review, 'document') + ' to review', sub: (Number(D.docs_7d) || 0) + ' arrived this week', acts: btn('Review', 'review-docs', 'ov-sm') }) +
      row({ avatar: false, title: plural(incomplete, 'account') + ' never finished onboarding', sub: ids.length ? 'Nudges the ' + Math.min(ids.length, NUDGE_CAP) + ' newest' : '', acts: ids.length ? btn('Nudge all', 'nudge-all', 'ov-sm') : '' }) +
      row({ avatar: false, title: 'Latest placement', sub: lp ? esc([lp.practice_name, lp.location].filter(Boolean).join(', ')) + (lp.start_date ? ' · starts ' + esc(fmtDay(lp.start_date)) : '') : 'None recorded yet', acts: btn('Board', 'matching-tab', 'ov-sm ov-ghost') }) +
      '</div>';
    h += '</div></div>';
    return h;
  }
  function trendHtml(d) {
    var S = d.series || {};
    var T = d.tiles || {};
    var H = T.hayley || {};
    var days = Array.isArray(S.days) ? S.days : [];
    var cpb = T.cost_per_booking, cpb30 = T.cost_per_booking_30d;
    var delta = '';
    if (state.window === '7d' && cpb != null && cpb30 != null) {
      var cls = cpb < cpb30 ? 'ov-good-down' : cpb > cpb30 ? 'ov-bad-up' : '';
      delta = '<span class="ov-delta ' + cls + '">' + (cpb < cpb30 ? '▼' : cpb > cpb30 ? '▲' : '—') + ' vs ' + money(cpb30) + ' over 30d</span>';
    } else if (cpb30 != null) {
      delta = '<span class="ov-delta">' + money(cpb30) + ' over 30d</span>';
    }
    return '<div>' +
      '<div class="ov-card"><div class="ov-card-h"><h3>Last 14 days</h3><div class="ov-right ov-legend"><span><i></i>Leads</span><span><i class="ov-purple"></i>Booked</span></div></div>' +
      '<div class="ov-card-b">' +
        '<div class="ov-chart-label">Leads per day</div>' + bars(S.leads, days, { h: 40, label: 'Leads per day, last 14 days' }) +
        '<div class="ov-chart-label">Consults booked per day</div>' + bars(S.booked, days, { h: 40, color: 'var(--purple)', label: 'Consults booked per day, last 14 days' }) +
        '<div class="ov-axis"><span>' + esc(days[0] || '') + '</span><span>today</span></div>' +
      '</div></div>' +
      '<div class="ov-side-tiles">' +
        tile({ label: 'Cost per booking', value: money(cpb), accent: 'var(--purple)', delta: delta }) +
        tile({ label: 'Hayley: calls → booked', value: num(H.calls) + '<small>→ ' + num(H.booked) + '</small>', accent: 'var(--blue)', delta: '<span class="ov-delta">' + num(Math.round(Number(H.mins) || 0)) + ' min · ' + money(H.cost, 2) + '</span>' }) +
      '</div></div>';
  }

  /* =====================================================================
   *  DRAWERS
   * ===================================================================== */
  function openDrawer(title, html) {
    ATS.setOverlay(
      '<div class="ats-scrim open" id="ov-scrim"></div>' +
      '<aside class="ats-drawer ov-drawer open" id="ov-drawer" aria-label="' + escAttr(title) + '">' +
        '<div class="ov-drawer-h"><h3>' + title + '</h3>' + btn('Close ✕', 'drawer-close', 'ov-sm ov-ghost') + '</div>' +
        '<div class="ov-drawer-b">' + html + '</div>' +
      '</aside>');
    wireDrawer();
  }
  function closeDrawer() {
    document.removeEventListener('keydown', escClose);
    if (document.getElementById('ov-drawer')) ATS.setOverlay('');
  }
  function escClose(e) { if (e.key === 'Escape') closeDrawer(); }
  function wireDrawer() {
    var scrim = document.getElementById('ov-scrim');
    if (scrim) scrim.addEventListener('click', closeDrawer);
    var drawer = document.getElementById('ov-drawer');
    if (drawer) drawer.addEventListener('click', onAction);
    document.addEventListener('keydown', escClose);
  }

  function peopleRows(list, stage) {
    if (!list || !list.length) return '<div class="ov-empty">Nobody in this stage for the ' + windowLabel() + '.</div>';
    return '<div class="ov-rows">' + list.map(function (p) {
      var acts = '';
      if (p.kind === 'user') acts = btn('Open profile', 'open-doctor', 'ov-sm', 'data-case="' + escAttr(p.case_id || '') + '" data-user="' + escAttr(p.id) + '"');
      else if (stage === 'booked') acts = (p.zoom_join_url ? link('Zoom', p.zoom_join_url, 'ov-sm') : '') + btn('Open', 'open-lead', 'ov-sm ov-ghost', 'data-id="' + escAttr(p.id) + '"');
      else acts = btn('Ring', 'ring', 'ov-sm', 'data-id="' + escAttr(p.id) + '" data-name="' + escAttr(p.name || '') + '" data-phone="' + escAttr(p.phone || '') + '"') + btn('Open', 'open-lead', 'ov-sm ov-ghost', 'data-id="' + escAttr(p.id) + '"');
      return row({ name: p.name, title: esc(p.name || (p.kind === 'user' ? 'Doctor' : 'Lead')), sub: esc(p.sub || ''), acts: acts });
    }).join('') + '</div>';
  }
  function openStage(k) {
    var d = state.data;
    if (!d) return;
    var F = d.funnel || {};
    var P = F.people || {};
    if (k === 'spend') return openRelaunch();
    if (k === 'placed') {
      var lp = (d.doctors && d.doctors.latest_placement) || null;
      return openDrawer('Placements', '<p class="ov-note" style="margin-top:8px">' + num(F.placed) + ' placed in the ' + windowLabel() + ' · ' + num(F.placements_active) + ' active · ' + num(F.open_jobs) + ' open jobs.' +
        (lp ? '<br>Latest: ' + esc([lp.practice_name, lp.location].filter(Boolean).join(', ')) + (lp.start_date ? ', starts ' + esc(fmtDay(lp.start_date)) : '') + '.' : '') + '</p>' +
        '<div class="ov-btn-row" style="margin-top:12px">' + btn('Matching board', 'matching-tab', '') + btn('Candidates', 'candidates-tab', '') + '</div>');
    }
    var titles = { leads: 'Leads', spoke: 'Hayley spoke to', booked: 'Consult booked', attended: 'Attended', accounts: 'New app accounts' };
    var list = P[k] || [];
    var footer = k === 'accounts'
      ? '<p class="ov-note" style="margin-top:12px">' + btn('See all in Candidates', 'candidates-tab', 'ov-sm ov-ghost') + '</p>'
      : '<p class="ov-note" style="margin-top:12px">' + btn('See all in Leads tab', 'leads-tab', 'ov-sm ov-ghost') + '</p>';
    openDrawer(esc(titles[k] || k) + ', ' + windowLabel(), peopleRows(list, k) + footer);
  }
  function openConsults() {
    var d = state.data;
    if (!d) return;
    var c = (d.status && d.status.consults) || {};
    var up = Array.isArray(c.upcoming) ? c.upcoming : [];
    var todayN = Array.isArray(c.today) ? c.today.length : (Number(c.today) || 0);
    var rows = up.length ? '<div class="ov-rows">' + up.map(function (x) {
      var leadId = x.lead_id || x.enquiry_id || '';
      return row({
        name: x.name, title: esc(x.name || x.email || 'Consult'),
        sub: esc(fmtWhen(x.at)) + (x.source ? ' · ' + esc(x.source) : '') + (x.email ? ' · ' + esc(x.email) : ''),
        acts: (x.zoom_join_url ? link('Zoom', x.zoom_join_url, 'ov-sm') : '') + (leadId ? btn('Prep', 'open-lead', 'ov-sm ov-ghost', 'data-id="' + escAttr(leadId) + '"') : btn('Prep', 'meetings-tab', 'ov-sm ov-ghost'))
      });
    }).join('') + '</div>' : '<div class="ov-empty">No upcoming consults.</div>';
    openDrawer(todayN ? 'Today’s consults' : 'Next consults', rows + '<p class="ov-note" style="margin-top:12px">' + btn('Meetings ›', 'meetings-tab', 'ov-sm ov-ghost') + '</p>');
  }
  function openRelaunch() {
    var d = state.data;
    if (!d) return;
    var m = (d.status && d.status.meta) || {};
    var rv = m.review || {};
    var acts = Array.isArray(rv.actions_today) ? rv.actions_today : [];
    var drafts = Array.isArray(m.drafts) ? m.drafts : [];
    var h = '';
    if (rv.headline) h += '<p class="ov-note" style="margin:8px 0 12px"><b style="color:var(--text)">Review' + (rv.date ? ', ' + esc(fmtDay(rv.date)) : '') + ':</b> ' + esc(rv.headline) + '</p>';
    else h += '<p class="ov-note" style="margin:8px 0 12px">No daily review yet.</p>';
    if (acts.length) h += '<div class="ov-drawer-sec">What the review says to do today</div><ul>' + acts.map(function (a) {
      return '<li>' + esc(a.action || '') + (a.why ? ' <span class="ov-dim">— ' + esc(a.why) + '</span>' : '') + '</li>';
    }).join('') + '</ul><hr class="ov-sep">';
    h += '<div class="ov-drawer-sec">Drafts</div>';
    if (!drafts.length) h += '<div class="ov-empty">No drafts waiting. Generate some in the Ads hub.</div>';
    else h += '<div class="ov-rows">' + drafts.map(function (x) {
      var pill = '<span class="ov-pill ' + (x.status === 'scheduled' ? 'ov-blue' : x.status === 'ready' ? 'ov-green' : 'ov-grey') + '">' + esc(x.status || 'draft') + '</span>';
      return row({ icon: '\u2726', // a draft has no initials
        name: x.angle || x.headline, title: esc(x.headline || 'Untitled draft'),
        sub: esc(x.angle || '') + ' · ' + pill + (x.launch_at ? ' · ' + esc(fmtWhen(x.launch_at)) : ''),
        acts: x.has_image ? btn('Launch now', 'launch-draft', 'ov-sm ov-primary', 'data-id="' + escAttr(x.id) + '" data-name="' + escAttr(x.headline || '') + '"') : '<span class="ov-pill ov-grey">No photo yet</span>'
      });
    }).join('') + '</div>';
    h += '<hr class="ov-sep"><div class="ov-btn-row">' + btn('Open Ads hub', 'social-tab', '') + btn('Run review now', 'run-review', '') + '</div>';
    h += '<p class="ov-note" style="margin-top:12px">Live ads can’t be paused from here — the ad-set switch stays in Ads Manager.</p>';
    openDrawer('Relaunch Meta ads', h);
  }

  /* =====================================================================
   *  ACTIONS (one delegated listener on the panel + on each drawer)
   * ===================================================================== */
  function ensureWired(el) {
    if (el._ovWired) return;
    el._ovWired = true;
    el.addEventListener('click', onAction);
  }
  function onAction(e) {
    var b = e.target.closest ? e.target.closest('[data-ov-act]') : null;
    if (!b) {
      // No button under the click: a row's main area opens its origin.
      var m = e.target.closest ? e.target.closest('[data-ov-open]') : null;
      if (m) openOrigin(m);
      return;
    }
    var act = b.getAttribute('data-ov-act');
    var id = b.getAttribute('data-id') || '';
    var user = b.getAttribute('data-user') || '';
    switch (act) {
      case 'retry': { var el = root(); if (el && !state.data) el.innerHTML = skeletonHtml(); load(!!state.data); return; }
      case 'window': return setWindow(b.getAttribute('data-w'));
      case 'digest': return mutate(b, '/api/ceo/owner-digest/send', {}, 'Digest email sent.', { noRefetch: true });
      case 'drawer-close': return closeDrawer();
      case 'stage': return openStage(b.getAttribute('data-stage'));
      case 'relaunch': return openRelaunch();
      case 'consults-drawer': return openConsults();
      case 'leads-tab': closeDrawer(); return ATS.showMaster('leads');
      case 'meetings-tab': closeDrawer(); return ATS.showMaster('meetings');
      case 'contracts-tab': closeDrawer(); return ATS.showMaster('contracts');
      case 'candidates-tab': closeDrawer(); return ATS.showMaster('candidates');
      case 'matching-tab': closeDrawer(); return ATS.showMaster('matching');
      case 'social-tab': closeDrawer(); return ATS.showMaster('social');
      case 'rso-tab': closeDrawer(); return ATS.showMaster('rso');
      case 'open-doctor': return openCandidate(b.getAttribute('data-case') || user, '');
      case 'open-docs-for': return openCandidate(b.getAttribute('data-case') || user, 'docs');
      case 'whatsapp-chat': return openWhatsApp(id, b.getAttribute('data-name') || '', b.getAttribute('data-url') || '');
      case 'open-lead': return openLead(id);
      case 'review-docs': return openDocs();
      case 'ring': return ring(b, id, b.getAttribute('data-name') || '', b.getAttribute('data-phone') || '');
      case 'ring-waiting': return ringWaiting(b);
      case 'dnc':
        if (!window.confirm('Mark ' + (b.getAttribute('data-name') || 'this lead') + ' as "do not call"? Hayley will never ring them again (chase emails stop too).')) return;
        return mutate(b, '/api/ceo/leads/' + encodeURIComponent(id) + '/hazel', { action: 'do_not_call' }, 'Marked do not call.');
      case 'callback-done': return mutate(b, '/api/ceo/leads/' + encodeURIComponent(id) + '/callback-done', {}, 'Marked done.', { fadeRow: true });
      case 'esc-resolve': return mutate(b, '/api/ceo/escalation/' + encodeURIComponent(id) + '/resolve', {}, 'Escalation resolved.', { fadeRow: true });
      case 'esc-respond': {
        var note = window.prompt('Reply to the RSO (goes back on the task):');
        if (note == null || !String(note).trim()) return;
        return mutate(b, '/api/ceo/escalation/' + encodeURIComponent(id) + '/respond', { note: String(note).trim() }, 'Response sent, returned to RSO.');
      }
      case 'email-handled': return mutate(b, '/api/admin/va/incoming-questions/' + encodeURIComponent(id) + '/resolve', {}, 'Marked handled.', { fadeRow: true });
      case 'nudge': return mutate(b, '/api/admin/va/nudge', { user_id: user }, 'Nudge sent.');
      case 'nudge-all': return nudgeAll(b);
      case 'launch-draft':
        if (!window.confirm('Launch "' + (b.getAttribute('data-name') || 'this draft') + '" as a live Meta ad now?')) return;
        return mutate(b, '/api/ceo/ads/draft/launch-now', { id: id }, 'Launched.');
      case 'run-review': return mutate(b, '/api/ceo/ads/review', {}, 'Review finished.');
      default: return;
    }
  }
  function setWindow(w) {
    w = w === '30d' ? '30d' : '7d';
    if (w === state.window) return;
    state.window = w;
    try { localStorage.setItem(WINDOW_KEY, w); } catch (e) { /* ignore */ }
    state.inflight = null; // a stale in-flight answer for the other window is ignored on arrival
    if (state.data) render(); else { var el = root(); if (el) el.innerHTML = skeletonHtml(); }
    load(!!state.data);
  }
  /* ---------- origins: where an item came from ---------- */
  function openOrigin(el) {
    var kind = el.getAttribute('data-ov-open') || '';
    var url = el.getAttribute('data-url') || '';
    var caseId = el.getAttribute('data-case') || '';
    var user = el.getAttribute('data-user') || '';
    var id = el.getAttribute('data-id') || '';
    if (kind === 'url') { if (/^https:\/\//.test(url)) window.open(url, '_blank', 'noopener'); return; }
    if (kind === 'whatsapp') return openWhatsApp(id, el.getAttribute('data-name') || '', url);
    if (kind === 'contracts') { closeDrawer(); return ATS.showMaster('contracts'); }
    if (kind === 'candidate') return openCandidate(caseId || user, el.getAttribute('data-focus') || '');
    if (kind === 'gp-tasks') return openGpTasks(caseId, user);
    if (kind === 'lead') return openLead(id);
  }
  // The candidate deep link takes the registration CASE id (atsOpenCandidate
  // falls back to other ids, so a user id still lands somewhere sensible).
  function openCandidate(id, focus) {
    closeDrawer();
    if (!id) return;
    location.hash = '#candidate=' + encodeURIComponent(id) + (focus ? '&focus=' + encodeURIComponent(focus) : '');
  }
  // An escalated task with no thread behind it: the GP file's Tasks tab under
  // Registration → RSOs. skipLoad, because loadRsoTab would repaint the roster
  // over the file a moment later.
  function openGpTasks(caseId, user) {
    closeDrawer();
    if (caseId && typeof window.openGpDetail === 'function' && window.ATS && typeof window.ATS.setActiveTab === 'function') {
      window.ATS.setActiveTab('rso', true);
      var rsoBtn = document.querySelector('#regSubnav .reg-subtab[data-regsub="rsos"]');
      if (rsoBtn && !rsoBtn.classList.contains('active')) rsoBtn.click();
      try { history.replaceState(null, '', '#rso'); } catch (e) { /* ignore */ }
      if (window.scrollTo) window.scrollTo({ top: 0 });
      window.openGpDetail(caseId, '');
      return;
    }
    openCandidate(caseId || user, '');
  }
  // The DoubleTick chat for a lead. The tab is opened synchronously (popup
  // blockers), then pointed at the chat once the server has resolved it.
  function openWhatsApp(id, name, known) {
    if (/^https:\/\//.test(known || '')) { window.open(known, '_blank', 'noopener'); return; }
    if (!id) return;
    var tab = null;
    try { tab = window.open('about:blank', '_blank'); } catch (e) { tab = null; }
    ATS.api('/api/ceo/leads/' + encodeURIComponent(id) + '/whatsapp-link').then(function (d) {
      if (d && d.ok && d.url) {
        if (tab) tab.location.href = d.url; else window.open(d.url, '_blank', 'noopener');
        return;
      }
      if (tab) { try { tab.close(); } catch (e) { /* ignore */ } }
      ATS.toast((d && d.message) || ('No DoubleTick chat found for ' + (name || 'this lead') + '.'), 'error');
      openLead(id);
    });
  }
  // Documents waiting for the owner's review — the review queue's list, in a drawer.
  function openDocs() {
    var R = (state.data && state.data.status && state.data.status.registration) || {};
    var list = Array.isArray(R.docs_list) ? R.docs_list : null;
    var n = Number(R.docs_to_review) || 0;
    if (list === null) { closeDrawer(); return ATS.showMaster('candidates'); }
    if (!n) { closeDrawer(); ATS.toast('No documents are waiting for your review.', 'success'); return; }
    var rows = list.map(function (t) {
      var attrs = 'data-case="' + escAttr(t.case_id || '') + '" data-user="' + escAttr(t.user_id || '') + '"';
      return row({
        name: t.name,
        title: esc(t.name || 'Doctor') + ' <span class="ov-muted ov-small">' + esc(human(t.title || t.document_key || 'document')) + '</span>',
        sub: t.created_at ? 'Uploaded ' + esc(fmtWhen(t.created_at)) : '',
        open: (t.case_id || t.user_id) ? { kind: 'candidate', attrs: attrs + ' data-focus="docs"', hint: 'Open the documents on this candidate' } : null,
        acts: (t.case_id || t.user_id) ? btn('Review', 'open-docs-for', 'ov-sm', attrs) : ''
      });
    }).join('');
    openDrawer('Documents waiting for your review (' + n + ')',
      '<div class="ov-rows">' + rows + '</div>' +
      (n > list.length ? '<p class="ov-note" style="margin-top:12px">Showing the newest ' + list.length + '. ' + btn('All candidates', 'candidates-tab', 'ov-sm ov-ghost') + '</p>' : ''));
  }
  function openLead(id) {
    if (!id) return;
    closeDrawer();
    ATS.showMaster('leads');
    if (window.CeoLeads && typeof window.CeoLeads.open === 'function') window.CeoLeads.open(id);
  }
  // Every mutation: disable the button, call, toast success/failure, refetch.
  function mutate(b, path, body, okMsg, opts) {
    opts = opts || {};
    if (b.disabled) return;
    b.disabled = true;
    var label = b.textContent;
    b.textContent = '…';
    return ATS.api(path, { method: 'POST', body: body || {} }).then(function (d) {
      if (!d || !d.ok) {
        b.disabled = false; b.textContent = label;
        ATS.toast('Failed: ' + ((d && (d.message || d.error)) || 'network error'), 'error');
        return d;
      }
      ATS.toast((d && d.message && typeof d.message === 'string' && opts.useServerMessage) ? d.message : okMsg);
      b.textContent = label;
      if (opts.fadeRow) { var r = b.closest('.ov-row'); if (r) r.classList.add('ov-done'); }
      if (!opts.noRefetch) refetch(); else b.disabled = false;
      return d;
    });
  }
  function ring(b, id, name, phone) {
    if (!id) return;
    if (!window.confirm('Ring ' + (name || 'this lead') + ' now' + (phone ? ' on ' + phone : '') + ' with Hayley?')) return;
    return mutate(b, '/api/ceo/leads/' + encodeURIComponent(id) + '/call', {}, 'Hayley is ringing ' + (name || 'them') + '.');
  }
  // Sequential (never parallel) so Retell gets one call at a time; a toast per result.
  function ringWaiting(b) {
    var h = (state.data && state.data.status && state.data.status.hayley) || {};
    var list = Array.isArray(h.not_rung) ? h.not_rung.slice() : [];
    if (!list.length) return;
    if (!window.confirm('Ask Hayley to ring the ' + plural(list.length, 'waiting lead') + ' now, one after the other?')) return;
    if (b.disabled) return;
    b.disabled = true;
    var ok = 0, i = 0;
    (function next() {
      if (i >= list.length) {
        ATS.toast(ok + ' of ' + list.length + ' calls queued.', ok === list.length ? undefined : 'error');
        refetch();
        return;
      }
      var lead = list[i++];
      ATS.api('/api/ceo/leads/' + encodeURIComponent(lead.id) + '/call', { method: 'POST', body: {} }).then(function (d) {
        if (d && d.ok) { ok++; ATS.toast('Ringing ' + (lead.name || 'lead') + '.'); }
        else ATS.toast((lead.name || 'Lead') + ': ' + ((d && (d.message || d.error)) || 'failed'), 'error');
        next();
      });
    })();
  }
  function nudgeAll(b) {
    var D = (state.data && state.data.doctors) || {};
    var ids = Array.isArray(D.incomplete_ids) ? D.incomplete_ids.slice(0, NUDGE_CAP) : [];
    if (!ids.length) return;
    if (!window.confirm('Send the onboarding nudge to ' + plural(ids.length, 'doctor') + ' who never finished onboarding?')) return;
    if (b.disabled) return;
    b.disabled = true;
    var ok = 0, i = 0;
    (function next() {
      if (i >= ids.length) {
        ATS.toast('Nudged ' + ok + ' of ' + ids.length + '.', ok === ids.length ? undefined : 'error');
        refetch();
        return;
      }
      var uid = ids[i++];
      ATS.api('/api/admin/va/nudge', { method: 'POST', body: { user_id: uid } }).then(function (d) {
        if (d && d.ok) ok++;
        if (i % 5 === 0 && i < ids.length) ATS.toast('Nudged ' + ok + ' of ' + ids.length + ' so far…');
        next();
      });
    })();
  }

})();

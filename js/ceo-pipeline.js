/* ============================================================================
 * ceo-pipeline.js — "Pipeline & money" on the CEO dashboard Overview tab
 * (owner picked mockup A "Board", 26 Nov 2026). Loaded by
 * pages/ceo-dashboard.html AFTER /js/ceo-overview.js.
 *
 * Draws into #pipelineRoot, the sibling just below #overviewRoot, so the
 * Overview above is never touched. It wraps window.loadOverviewTab: every time
 * the Overview tab loads, the board loads too (quiet re-entry keeps the paint).
 * Polls every 60 s only while the Overview tab is on screen and the page is
 * visible, like the Overview.
 *
 * Data: GET /api/ceo/pipeline (lib/ceo-pipeline.js builds it).
 * Writes: POST /api/ceo/pipeline/person, /person/:id/done, /whatsapp-import,
 *         /email-find/:id/dismiss, /email-find/:id/confirm (email-scan route),
 *         /api/ceo/xero/invoice/:id/owner-status ("Paid outside Xero" / Undo),
 *         /person/:id/expected-start and /api/ceo/income-expectation (forecast).
 * The income forecast (payload.forecast, lib/income-forecast.js) is drawn as an
 * inline SVG stacked bar chart under the money tiles.
 * No alert/confirm/prompt: every input is an inline form.
 * Every class is pl-* — never ad-/ads- (the owner's ad blocker hides those).
 * ========================================================================== */
(function () {
  'use strict';

  var ATS = window.ATS;
  if (!ATS) return;

  var ROOT_ID = 'pipelineRoot';
  var ENDPOINT = '/api/ceo/pipeline';
  var POLL_MS = 60 * 1000;
  var FRESH_MS = 2 * 60 * 1000;
  var XERO_CONNECT = '/api/ceo/xero/connect';
  var XERO_HOME = 'https://go.xero.com/';
  var OWNER_STATUS = '/api/ceo/xero/invoice/';
  var EXPECTED_START = '/expected-start';
  var INCOME_EXPECTATION = '/api/ceo/income-expectation';
  var FC_KIND_ORDER = ['overdue', 'invoiced', 'plan', 'second_half', 'to_invoice', 'manual'];
  var FC_STAGE = { warm: 'Warm', consult: 'Consult', matched: 'Matched', signed: 'Signed', visa: 'Visa', started: 'Started' };
  var STAGE_CHOICES = [['warm', 'Warm, not in app'], ['consult', 'Consult / signing up'], ['matched', 'Matched / interview'], ['signed', 'Signed'], ['visa', 'Visa'], ['started', 'Started work'], ['later', 'Come back to later'], ['closed', 'Closed (take off the board)']];

  var state = { data: null, loadedAt: 0, inflight: null, timer: null, error: '', form: null, importMsg: '', pendingRender: false, xeroBanner: readXeroReturn(), syncing: false, fcSel: null };

  // The Xero OAuth callback lands on ?xero=connected or ?xero=error&reason=…
  // Read it once, then strip it so a reload does not show it again.
  function readXeroReturn() {
    try {
      var q = new URLSearchParams(location.search);
      var x = q.get('xero');
      if (!x) return null;
      var reason = q.get('reason') || '';
      q.delete('xero'); q.delete('reason');
      var qs = q.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
      if (x === 'connected') return { ok: true, text: 'Xero is connected. Invoices appear here after the first sync (press Sync now if they have not).' };
      return { ok: false, text: 'Xero did not connect' + (reason ? ': ' + reason.replace(/[_-]+/g, ' ').slice(0, 160) : '') + '. Try Connect Xero again.' };
    } catch (e) { return null; }
  }

  function root() { return document.getElementById(ROOT_ID); }
  function esc(s) { return ATS.esc(s); }
  function escAttr(s) { return ATS.escAttr(s); }
  function isActive() { return !!window.ATS && window.ATS.activeTab === 'registration'; }
  function browserTz() { try { return String(Intl.DateTimeFormat().resolvedOptions().timeZone || ''); } catch (e) { return ''; } }
  function money(n) {
    if (n == null || n === '' || isNaN(n)) return '—';
    return '$' + Math.round(Number(n)).toLocaleString('en-AU');
  }
  function plural(n, one, many) { n = Number(n) || 0; return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function clock(ms) { try { return new Date(ms).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch (e) { return ''; } }

  function btn(label, act, cls, attrs) {
    return '<button type="button" class="pl-btn ' + (cls || '') + '" data-pl-act="' + escAttr(act) + '"' + (attrs ? ' ' + attrs : '') + '>' + label + '</button>';
  }
  function link(label, href, cls, sameTab) {
    return '<a class="pl-btn ' + (cls || '') + '" href="' + escAttr(href) + '"' + (sameTab ? '' : ' target="_blank" rel="noopener"') + '>' + label + (sameTab ? '' : ' <span class="pl-ext">↗</span>') + '</a>';
  }
  function pill(text, tone) { return '<span class="pl-pill pl-' + tone + '">' + esc(text) + '</span>'; }
  function heatPill(h) {
    if (h == null || h === 0) return '';
    return h >= 3 ? pill('hot', 'red') : h === 2 ? pill('warm', 'amber') : pill('cooling', 'grey');
  }
  function fresh(f) {
    if (!f) return '';
    var tone = f.state === 'ok' ? 'pl-fresh-ok' : f.state === 'stale' || f.state === 'error' ? 'pl-fresh-warn' : 'pl-fresh-never';
    return '<span class="pl-fresh ' + tone + '">' + esc(f.label || '') + '</span>';
  }

  /* =====================================================================
   *  ENTRY POINT — piggy-backs on the Overview's loader
   * ===================================================================== */
  window.loadPipelineBoard = function (opts) {
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
      el.innerHTML = '<div class="pl-wrap">' + toolbarHtml() + '<div class="pl-loading">Loading the pipeline…</div></div>';
      load(false);
    } catch (e) {
      console.error('[pipeline] render failed', e);
      el.innerHTML = '<div class="pl-wrap"><div class="pl-error"><b>The pipeline board hit an error while drawing.</b> ' + esc((e && e.message) || e) + ' ' + btn('Retry', 'retry', 'pl-sm') + '</div></div>';
    }
  };
  var origLoadOverview = window.loadOverviewTab;
  if (typeof origLoadOverview === 'function') {
    window.loadOverviewTab = function (opts) {
      var r = origLoadOverview.apply(this, arguments);
      try { window.loadPipelineBoard(opts); } catch (e) { console.error('[pipeline] load failed', e); }
      return r;
    };
  }
  // Safety net (found in a real browser 26 Nov 2026): on a first visit the
  // Overview can be drawn through a path that never calls the wrapped loader,
  // leaving this board blank. For the first 30 s, if the Overview tab is on
  // screen and the board has neither data nor a request in flight, start it.
  (function bootWatch(tries) {
    if (tries > 30) return;
    try {
      if (isActive() && root() && !state.data && !state.inflight && !root().innerHTML) window.loadPipelineBoard({});
    } catch (e) { /* the next tick tries again */ }
    if (!state.data) setTimeout(function () { bootWatch(tries + 1); }, 1000);
  })(0);

  /* =====================================================================
   *  DATA
   * ===================================================================== */
  function load(background) {
    if (state.inflight) return state.inflight;
    setRefreshing(true);
    state.inflight = ATS.api(ENDPOINT + '?tz=' + encodeURIComponent(browserTz())).then(function (d) {
      state.inflight = null;
      setRefreshing(false);
      if (!d || !d.ok) {
        state.error = (d && (d.message || d.error)) || (d && d.status ? 'HTTP ' + d.status : 'Network error');
        if (state.data && background) { render(); return d; }
        renderError(state.error);
        return d;
      }
      state.data = d;
      state.loadedAt = Date.now();
      state.error = '';
      render();
      return d;
    });
    return state.inflight;
  }
  function startTimer() {
    if (state.timer) return;
    state.timer = setInterval(function () {
      if (document.visibilityState !== 'visible' || !isActive() || !root()) return;
      load(true);
    }, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible' || !isActive() || !root()) return;
      if ((Date.now() - state.loadedAt) > POLL_MS) load(true);
    });
  }
  function setRefreshing(on) {
    var el = document.getElementById('pl-refreshing');
    if (el) el.textContent = on ? 'refreshing…' : '';
  }

  /* =====================================================================
   *  RENDER
   * ===================================================================== */
  function renderError(msg) {
    var el = root();
    if (!el) return;
    el.innerHTML = '<div class="pl-wrap">' + toolbarHtml() + '<div class="pl-error"><b>The pipeline could not load.</b> ' + esc(msg || 'Unknown error') + ' ' + btn('Retry', 'retry', 'pl-sm pl-primary') + '</div></div>';
  }
  function toolbarHtml() {
    return '<div class="pl-toolbar"><h2>Pipeline &amp; money</h2>' +
      '<div class="pl-legend"><span><i class="pl-key pl-key-red"></i>someone is waiting on you</span><span><i class="pl-key pl-key-amber"></i>stuck</span></div>' +
      '<div class="pl-toolbar-right"><span class="pl-refreshing" id="pl-refreshing"></span>' +
      btn('+ Add a candidate', 'add-open', 'pl-sm') +
      btn('Upload new WhatsApp export', 'import-pick', 'pl-sm') +
      '<input type="file" accept=".json,application/json" class="pl-file" id="pl-file" hidden>' +
      '</div></div>';
  }
  // A form the owner is typing into must survive the 60 s poll.
  // So must a date the owner is picking in the forecast's doctor table.
  function formOpen() {
    var el = root();
    if (!el) return false;
    if (el.querySelector('.pl-form')) return true;
    var a = document.activeElement;
    return !!(a && el.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
  }
  function render() {
    var el = root();
    if (!el || !state.data) return;
    if (formOpen()) { state.pendingRender = true; return; }
    state.pendingRender = false;
    var d = state.data;
    el.innerHTML = '<div class="pl-wrap">' + toolbarHtml() +
      (state.error ? '<div class="pl-error-bar">Could not refresh: ' + esc(state.error) + '. Showing the board from ' + esc(clock(state.loadedAt)) + '. ' + btn('Retry', 'retry', 'pl-sm') + '</div>' : '') +
      (state.xeroBanner ? '<div class="pl-banner ' + (state.xeroBanner.ok ? 'pl-banner-ok' : 'pl-banner-bad') + '">' + esc(state.xeroBanner.text) + ' ' + btn('Close', 'banner-close', 'pl-sm pl-ghost') + '</div>' : '') +
      '<div id="pl-form-slot">' + (state.form === 'add' ? addFormHtml() : '') + '</div>' +
      (state.importMsg ? '<div class="pl-note pl-import-msg">' + esc(state.importMsg) + '</div>' : '') +
      tilesHtml(d) + forecastHtml(d) + boardHtml(d) + '<div class="pl-gap"></div>' + invoicesHtml(d) + '</div>';
  }

  /* ---------- money tiles ---------- */
  function tile(label, value, accent, delta, foot) {
    return '<div class="pl-tile" style="--pl-accent:' + accent + '"><div class="pl-label">' + esc(label) + '</div><div class="pl-value">' + value + '</div>' +
      (delta ? '<div class="pl-delta">' + delta + '</div>' : '') + (foot ? '<div class="pl-foot">' + foot + '</div>' : '') + '</div>';
  }
  function tilesHtml(d) {
    var m = d.money || {};
    if (!m.connected) {
      var c = link('Connect Xero', XERO_CONNECT, 'pl-sm pl-primary', true);
      var why = esc((d.freshness && d.freshness.xero && d.freshness.xero.label) || 'Xero not connected');
      return '<div class="pl-tiles4">' +
        tile('Owed to you, overdue', '<span class="pl-value-off">Connect Xero</span>', 'var(--red)', why, c) +
        tile('Not sure if paid', '<span class="pl-value-off">Connect Xero</span>', 'var(--amber)', '', '') +
        tile('Coming on a plan', '<span class="pl-value-off">Connect Xero</span>', 'var(--green)', '', '') +
        tile('Signed, no invoice yet', '<span class="pl-value-off">Connect Xero</span>', 'var(--blue)', '', '') + '</div>';
    }
    var names = (m.notInvoicedNames || []).map(function (n) { return String(n).replace(/^Dr\s+/, ''); });
    var aw = m.awaiting || null;
    var awHtml = aw ? '<div class="pl-awaiting"><div class="pl-aw-l">Total awaiting payment</div><div class="pl-aw-v">' + esc(money(aw.total)) + '</div>' +
      '<div class="pl-aw-s">' + esc(money(aw.invoiced)) + ' invoiced and unpaid · ' + esc(money(aw.on_start)) + ' due as doctors start <span class="pl-dim">(inc GST)</span></div></div>' : '';
    return awHtml + '<div class="pl-tiles4">' +
      tile('Owed to you, overdue', esc(money(m.overdue)), 'var(--red)', plural(m.overdueN, 'invoice') + (m.oldestDays ? ' · oldest ' + m.oldestDays + ' days' : '')) +
      tile('Not sure if paid', esc(money(m.check)), 'var(--amber)', plural(m.checkN, 'invoice') + ' to check in Xero') +
      tile('Coming on a plan', esc(money(m.coming)), 'var(--green)', plural(m.comingN, 'invoice') + ' not due yet') +
      tile('Signed, no invoice yet', esc(String(m.notInvoiced || 0)), 'var(--blue)', esc(names.slice(0, 3).join(' · ') + (names.length > 3 ? ' +' + (names.length - 3) : ''))) +
      '</div>' + xeroFixHtml(m.xeroFix);
  }
  // Invoices Xero still shows unpaid that the owner marked paid: kept out of the tiles.
  function xeroFixHtml(x) {
    if (!x || !x.n) return '';
    return '<div class="pl-xerofix">' + esc(plural(x.n, 'invoice') + ' (total ' + money(x.total) + ') ' + (x.n === 1 ? 'shows' : 'show') + ' unpaid in Xero but ' + (x.n === 1 ? 'was' : 'were') + ' paid — fix in Xero') + '</div>';
  }

  /* ---------- income forecast (lib/income-forecast.js) ---------- */
  function fcKind(k) { return String(k || '').replace(/_/g, '-'); }
  function moneyShort(n) {
    n = Number(n) || 0;
    if (Math.abs(n) >= 1000) return '$' + (Math.round(n / 100) / 10).toString().replace(/\.0$/, '') + 'k';
    return '$' + Math.round(n);
  }
  function fcBuckets(f) {
    return (f.buckets || []).filter(function (b) { return b.key !== 'later' || b.total > 0; });
  }
  function fcBucketTitle(b) {
    if (b.key === 'owed' || b.key === 'unknown' || b.key === 'later') return b.label;
    return b.label + ' ' + b.year;
  }
  function niceStep(max) {
    var raw = max / 4;
    var p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    var m = [1, 2, 2.5, 5, 10].filter(function (x) { return x * p >= raw; })[0] || 10;
    return m * p;
  }
  function fcChart(f) {
    var bs = fcBuckets(f);
    var max = Math.max.apply(null, bs.map(function (b) { return b.total || 0; }).concat([1]));
    var step = niceStep(max);
    var top = Math.ceil(max / step) * step;
    var slot = 56, bw = 34, padL = 50, padT = 22, plotH = 170, padB = 34;
    var W = padL + bs.length * slot + 6, H = padT + plotH + padB;
    var y = function (v) { return padT + plotH - (v / top) * plotH; };
    var out = '<svg class="pl-fc-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="Income forecast by month">';
    for (var t = 0; t <= top + 0.5; t += step) {
      out += '<line class="pl-fc-grid" x1="' + padL + '" x2="' + (W - 4) + '" y1="' + y(t).toFixed(1) + '" y2="' + y(t).toFixed(1) + '"></line>' +
        '<text class="pl-fc-tick" x="' + (padL - 6) + '" y="' + (y(t) + 4).toFixed(1) + '" text-anchor="end">' + esc(moneyShort(t)) + '</text>';
    }
    bs.forEach(function (b, i) {
      var x0 = padL + i * slot;
      var bx = x0 + (slot - bw) / 2;
      var sel = state.fcSel === b.key;
      // Dashed separators: "Owed now" | 12 months | "Date unknown"
      if (i > 0 && (bs[i - 1].key === 'owed' || b.key === 'unknown' || b.key === 'later')) out += '<line class="pl-fc-sep" x1="' + x0 + '" x2="' + x0 + '" y1="' + padT + '" y2="' + (padT + plotH + 26) + '"></line>';
      out += '<g class="pl-fc-bar' + (sel ? ' pl-fc-sel' : '') + '" data-pl-act="fc-bar" data-key="' + escAttr(b.key) + '" tabindex="0" role="button" aria-label="' + escAttr(fcBucketTitle(b) + ': ' + money(b.total)) + '">' +
        '<rect class="pl-fc-hit" x="' + x0 + '" y="' + padT + '" width="' + slot + '" height="' + (plotH + padB - 4) + '" rx="6"></rect>';
      var acc = 0;
      FC_KIND_ORDER.forEach(function (k) {
        var v = (b.by_kind && b.by_kind[k]) || 0;
        if (!v) return;
        var y1 = y(acc + v), y2 = y(acc);
        out += '<rect class="pl-fc-k-' + fcKind(k) + '" x="' + bx + '" y="' + y1.toFixed(1) + '" width="' + bw + '" height="' + Math.max(1, y2 - y1).toFixed(1) + '"><title>' + esc(fcBucketTitle(b) + ' · ' + kindLabel(f, k) + ': ' + money(v)) + '</title></rect>';
        acc += v;
      });
      if (b.total > 0) out += '<text class="pl-fc-total" x="' + (bx + bw / 2) + '" y="' + (y(b.total) - 5).toFixed(1) + '" text-anchor="middle">' + esc(moneyShort(b.total)) + '</text>';
      var lab = b.key === 'owed' ? 'Owed' : b.key === 'unknown' ? 'Unknown' : b.key === 'later' ? 'Later' : b.label;
      out += '<text class="pl-fc-month' + (b.key === 'owed' ? ' pl-fc-owed' : '') + '" x="' + (x0 + slot / 2) + '" y="' + (padT + plotH + 15) + '" text-anchor="middle">' + esc(lab) + '</text>';
      var showYear = b.year && (i === 0 || !bs[i - 1].year || b.label === 'Jan');
      var sub = b.key === 'owed' ? 'now' : b.key === 'unknown' ? 'date' : showYear ? String(b.year) : '';
      if (sub) out += '<text class="pl-fc-year" x="' + (x0 + slot / 2) + '" y="' + (padT + plotH + 28) + '" text-anchor="middle">' + esc(sub) + '</text>';
      out += '</g>';
    });
    return out + '</svg>';
  }
  function kindLabel(f, k) {
    var ks = f.kinds || [];
    for (var i = 0; i < ks.length; i++) if (ks[i].k === k) return ks[i].l;
    return k;
  }
  function fcLegend(f) {
    var used = {};
    (f.buckets || []).forEach(function (b) { Object.keys(b.by_kind || {}).forEach(function (k) { used[k] = true; }); });
    var ks = FC_KIND_ORDER.filter(function (k) { return used[k]; });
    if (!ks.length) return '';
    return '<div class="pl-fc-legend">' + ks.map(function (k) { return '<span><i class="pl-fc-sw pl-fc-sw-' + fcKind(k) + '"></i>' + esc(kindLabel(f, k)) + '</span>'; }).join('') + '</div>';
  }
  var CONF_TONE = { agreed: 'green', estimated: 'amber', unknown: 'grey' };
  function fcDetail(f) {
    var bs = fcBuckets(f);
    var b = null;
    for (var i = 0; i < bs.length; i++) if (bs[i].key === state.fcSel) b = bs[i];
    if (!b) return '<div class="pl-small pl-dim">Point at or tap a bar to see what is in it.</div>';
    var items = b.items || [];
    var head = '<div class="pl-fc-dh"><b>' + esc(fcBucketTitle(b)) + '</b> <span class="pl-mono">' + esc(money(b.total)) + '</span> <span class="pl-muted">· ' + esc(plural(items.length, 'payment')) + '</span></div>';
    if (!items.length) return head + '<div class="pl-small pl-dim">Nothing expected here.</div>';
    return head + '<div class="pl-rows">' + items.map(function (it) {
      return '<div class="pl-row pl-fc-item"><i class="pl-fc-sw pl-fc-sw-' + fcKind(it.kind) + '"></i><div class="pl-main">' +
        '<div class="pl-t"><span class="pl-mono">' + esc(money(it.amount_inc_gst)) + '</span> &nbsp;' + esc(it.doctor || 'No doctor named') +
        (it.from ? ' <span class="pl-muted">· ' + esc(it.from) + '</span>' : '') + ' ' + pill(it.confidence || 'unknown', CONF_TONE[it.confidence] || 'grey') + '</div>' +
        '<div class="pl-s">' + (it.invoice_number ? '<span class="pl-mono pl-dim">' + esc(it.invoice_number) + '</span> · ' : '') + esc(kindLabel(f, it.kind)) + ' · ' + esc(it.basis || '') + '</div></div></div>';
    }).join('') + '</div>';
  }
  function fcDoctors(f) {
    var ds = f.doctors || [];
    if (!ds.length) return '<div class="pl-small pl-dim">No signed doctors yet.</div>';
    return '<div class="pl-fc-tablewrap"><table class="pl-fc-table"><thead><tr><th>Doctor</th><th>Practice</th><th>Stage</th><th>Expected start</th><th class="pl-fc-num">Expected</th></tr></thead><tbody>' +
      ds.map(function (d) {
        var id = escAttr(d.id);
        var basis = d.owner_basis || 'estimated';
        return '<tr data-fc-doc="' + id + '"><td><b>' + esc(d.name) + '</b></td><td class="pl-muted">' + esc(d.practice || '—') + '</td><td>' + esc(FC_STAGE[d.stage] || d.stage || '') + '</td>' +
          '<td><div class="pl-fc-start"><input type="date" class="pl-input pl-fc-date" name="fc_date" value="' + escAttr(d.expected_start || '') + '" aria-label="Expected start for ' + escAttr(d.name) + '">' +
          '<select class="pl-input pl-fc-basis" name="fc_basis" aria-label="How sure"><option value="agreed"' + (basis === 'agreed' ? ' selected' : '') + '>agreed</option><option value="estimated"' + (basis === 'estimated' ? ' selected' : '') + '>estimated</option></select>' +
          btn('Save', 'fc-start-save', 'pl-sm', 'data-id="' + id + '"') + (d.owner_basis ? btn('Clear', 'fc-start-clear', 'pl-sm pl-ghost', 'data-id="' + id + '"') : '') + '</div>' +
          '<div class="pl-fc-from">' + pill(d.confidence || 'unknown', CONF_TONE[d.confidence] || 'grey') + ' ' + esc(d.start_label || '') + '</div></td>' +
          '<td class="pl-fc-num pl-mono">' + esc(money(d.amount_inc_gst)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function fcIncomeForm() {
    return '<form class="pl-form pl-fc-form" data-pl-form="income"><div class="pl-form-h">Add expected income</div><div class="pl-form-grid">' +
      '<label>What is it<input class="pl-input" name="label" required maxlength="200" placeholder="e.g. Zoho-era balance"></label>' +
      '<label>From (practice)<input class="pl-input" name="from_name" maxlength="200"></label>' +
      '<label>Doctor<input class="pl-input" name="doctor_name" maxlength="200" placeholder="Dr …"></label>' +
      '<label>Amount inc GST<input class="pl-input" name="amount_inc_gst" inputmode="decimal" placeholder="13750"></label>' +
      '<label>Expected date<input class="pl-input" type="date" name="expected_date"></label>' +
      '<label>How sure<select class="pl-input" name="confidence"><option value="estimated">estimated</option><option value="agreed">agreed</option><option value="unknown">unknown</option></select></label>' +
      '<label>Note<input class="pl-input" name="note" maxlength="500"></label>' +
      '</div><div class="pl-btn-row">' + btn('Save', 'fc-income-save', 'pl-sm pl-primary') + btn('Cancel', 'form-cancel', 'pl-sm pl-ghost') + '<span class="pl-form-err"></span></div></form>';
  }
  function fcExpectations(f) {
    var es = f.expectations || [];
    if (!es.length) return '';
    return '<div class="pl-sec">Added by you</div><div class="pl-rows">' + es.map(function (e) {
      return '<div class="pl-row"><i class="pl-fc-sw pl-fc-sw-manual"></i><div class="pl-main"><div class="pl-t"><span class="pl-mono">' + esc(money(e.amount_inc_gst)) + '</span> &nbsp;' + esc(e.label) +
        (e.from_name ? ' <span class="pl-muted">· ' + esc(e.from_name) + '</span>' : '') + '</div><div class="pl-s">' + esc([e.doctor_name, e.expected_date ? 'expected ' + e.expected_date : 'date unknown', e.confidence, e.note].filter(Boolean).join(' · ')) + '</div></div>' +
        '<div class="pl-row-acts">' + btn('Remove', 'fc-exp-remove', 'pl-sm pl-ghost', 'data-id="' + escAttr(e.id) + '"') + '</div></div>';
    }).join('') + '</div>';
  }
  function forecastHtml(d) {
    var f = d.forecast;
    if (!f) return '';
    if (state.fcSel === null) {
      var first = fcBuckets(f).filter(function (b) { return b.total > 0; })[0];
      state.fcSel = first ? first.key : 'owed';
    }
    var T = f.totals || {};
    var head = 'Next 3 months <b>' + esc(money(T.next_3_months)) + '</b> · next 12 months <b>' + esc(money(T.next_12_months)) + '</b> · owed now <b class="pl-redtxt">' + esc(money(T.owed_now)) + '</b> · date unknown <b>' + esc(money(T.unknown)) + '</b>' +
      (T.after_12_months ? ' · later <b>' + esc(money(T.after_12_months)) + '</b>' : '');
    return '<div class="pl-card pl-fc"><div class="pl-card-h"><h3>Income forecast</h3><div class="pl-right"><span class="pl-small pl-muted">inc GST · second 50% is invoiced when the doctor starts, paid within 7 days</span>' +
      btn('+ Add expected income', 'fc-add-open', 'pl-sm') + '</div></div><div class="pl-card-b">' +
      (f.connected ? '' : '<div class="pl-note">Xero is not connected, so only money you added by hand is shown. ' + link('Connect Xero', XERO_CONNECT, 'pl-sm pl-primary', true) + '</div>') +
      '<div class="pl-fc-head">' + head + '</div>' + fcLegend(f) +
      '<div class="pl-fc-scroll">' + fcChart(f) + '</div>' +
      '<div class="pl-fc-detail" id="pl-fc-detail">' + fcDetail(f) + '</div>' +
      '<div id="pl-fc-form-slot">' + (state.form === 'income' ? fcIncomeForm() : '') + '</div>' + fcExpectations(f) +
      '<div class="pl-sec">When each doctor starts</div>' + fcDoctors(f) + '</div></div>';
  }
  function fcSelect(key) {
    if (!state.data || !state.data.forecast || state.fcSel === key) return;
    state.fcSel = key;
    var el = root();
    if (!el) return;
    Array.prototype.forEach.call(el.querySelectorAll('.pl-fc-bar'), function (g) {
      var on = g.getAttribute('data-key') === key;
      g.setAttribute('class', 'pl-fc-bar' + (on ? ' pl-fc-sel' : ''));
    });
    var det = document.getElementById('pl-fc-detail');
    if (det) det.innerHTML = fcDetail(state.data.forecast);
  }

  /* ---------- the board ---------- */
  function boardHtml(d) {
    var c = d.counts || {};
    var F = d.freshness || {};
    var people = Array.isArray(d.people) ? d.people : [];
    var cols = (d.stages || []).map(function (s) {
      var ps = people.filter(function (p) { return p.stage === s.k; });
      return '<div class="pl-col"><div class="pl-col-h"><b>' + esc(s.l) + '</b><span class="pl-n">' + ps.length + '</span></div>' +
        (s.hint ? '<div class="pl-hint">' + esc(s.hint) + '</div>' : '') +
        ps.map(cardHtml).join('') + '</div>';
    }).join('');
    var later = (d.later || []).map(function (l) {
      return '<span class="pl-chip"><b>' + esc(l.name) + '</b> <span>' + (l.when ? '· ' + esc(l.when) + ' ' : '') + (l.later_reason ? '· ' + esc(l.later_reason) : '') + '</span></span>';
    }).join('');
    return '<div class="pl-card"><div class="pl-card-h"><h3>Every live candidate and deal</h3><div class="pl-right"><span class="pl-small pl-muted">' +
      plural(c.people || 0, 'person', 'people') + ' · <span class="pl-redtxt">' + (c.red || 0) + ' waiting on you</span> · <span class="pl-ambertxt">' + (c.amber || 0) + ' stuck</span></span></div></div>' +
      '<div class="pl-freshrow">' + fresh(F.whatsapp_export) + fresh(F.doubletick) + fresh(F.email_scan) + '</div>' +
      '<div class="pl-card-b"><div class="pl-board">' + cols + '</div>' +
      '<div class="pl-sec">Come back to later</div><div class="pl-later">' + (later || '<span class="pl-small pl-dim">Nobody parked.</span>') + '</div></div></div>';
  }
  function openLabel(p) {
    if (p.open && p.open.kind === 'app') return 'Open candidate';
    if (p.open && p.open.kind === 'gmail') return 'Open Gmail thread';
    if (p.open && p.open.kind === 'whatsapp') return 'Open WhatsApp chat';
    return 'No link on file';
  }
  function cardHtml(p) {
    var id = escAttr(p.id);
    var heat = (p.stage === 'warm' || p.stage === 'consult') ? ' ' + heatPill(p.heat) : '';
    var acts = btn(esc(p.next || 'Open'), 'open', 'pl-sm' + (p.flag === 'red' ? ' pl-primary' : ''), 'data-id="' + id + '" title="' + escAttr(openLabel(p)) + '"');
    if (p.find && p.find.gmail_message_id) {
      var g = escAttr(p.find.gmail_message_id);
      acts += btn('Confirm', 'find-confirm', 'pl-sm pl-good', 'data-gm="' + g + '"') + btn('Dismiss', 'find-dismiss', 'pl-sm pl-ghost', 'data-gm="' + g + '"');
    } else {
      acts += btn('Done', 'done-open', 'pl-sm pl-ghost', 'data-id="' + id + '"');
    }
    return '<div class="pl-pc' + (p.flag ? ' pl-' + p.flag : '') + '" data-card="' + id + '">' +
      '<div class="pl-nm">' + esc(p.name) + heat + '</div>' +
      (p.practice ? '<div class="pl-pr">' + esc(p.practice) + '</div>' : '') +
      (p.status ? '<div class="pl-st">' + esc(p.status) + '</div>' : '') +
      (p.wait ? '<div class="pl-wt">' + esc(p.wait) + '</div>' : '<div class="pl-st pl-dim">Last: ' + esc(p.last || 'Unknown') + '</div>') +
      (p.money ? '<div class="pl-mn">' + esc(p.money) + '</div>' : '') +
      (p.start ? '<div class="pl-mn">' + esc(p.start) + '</div>' : '') +
      '<div class="pl-acts">' + acts + '</div></div>';
  }

  /* ---------- invoices ---------- */
  var STATE_LBL = { overdue: ['overdue', 'red'], check: ['check', 'amber'], decide: ['decide', 'purple'], coming: ['on track', 'green'], not_invoiced: ['not invoiced', 'blue'], xero_fix: ['paid — fix in Xero', 'grey'] };
  // A real Xero invoice still unpaid there (not a plan's future instalments, not "not raised").
  function isXeroUnpaid(i) { return !!i.id && i.state !== 'not_invoiced' && i.state !== 'xero_fix' && !/^plan-/.test(String(i.id)); }
  function invoiceRow(i) {
    var st = STATE_LBL[i.state] || [i.state, 'grey'];
    if (i.state === 'xero_fix' && i.owner_status === 'not_owed') st = ['not owed — fix in Xero', 'grey'];
    var sub = [];
    if (i.doctor) sub.push(esc(i.doctor));
    if (i.days != null) sub.push('<b class="' + (i.days > 60 ? 'pl-badtxt' : '') + '">' + i.days + ' days overdue</b>');
    else if (i.due) sub.push('due ' + esc(i.due));
    if (i.last) sub.push('<span class="pl-dim">' + esc(i.last) + '</span>');
    var url = i.url || XERO_HOME;
    var act = i.state === 'overdue' ? link('Chase', url, 'pl-sm pl-primary')
      : i.state === 'check' ? link('Check Xero', url, 'pl-sm')
      : i.state === 'decide' ? link('Decide', url, 'pl-sm')
      : i.state === 'not_invoiced' ? link('Raise invoice', XERO_HOME, 'pl-sm')
      : i.state === 'xero_fix' ? link('Fix in Xero', url, 'pl-sm')
      : link('Open', url, 'pl-sm pl-ghost');
    if (isXeroUnpaid(i)) act += btn('Paid outside Xero', 'owner-open', 'pl-sm pl-ghost', 'data-inv="' + escAttr(i.id) + '"');
    if (i.state === 'xero_fix') act += btn('Undo', 'owner-undo', 'pl-sm pl-ghost', 'data-inv="' + escAttr(i.id) + '"');
    return '<div class="pl-row' + (i.state === 'xero_fix' ? ' pl-row-fix' : '') + '" data-inv-row="' + escAttr(i.id || '') + '"><div class="pl-avatar pl-av-' + st[1] + '">$</div><div class="pl-main">' +
      '<div class="pl-t"><span class="pl-mono">' + (i.amount == null ? '<span class="pl-muted">amount ?</span>' : esc(money(i.amount))) + '</span> &nbsp;' + esc(i.practice || 'Unknown practice') +
      (i.who ? ' <span class="pl-muted">(' + esc(i.who) + ')</span>' : '') + ' ' + pill(st[0], st[1]) + '</div>' +
      '<div class="pl-s"><span class="pl-mono pl-dim">' + esc(i.number || '') + '</span>' + (sub.length ? ' · ' + sub.join(' · ') : '') +
      (i.note ? '<br><span class="pl-why">' + esc(i.note) + '</span>' : '') + '</div></div><div class="pl-row-acts">' + act + '</div></div>';
  }
  function invoicesHtml(d) {
    var m = d.money || {};
    var F = d.freshness || {};
    var list = Array.isArray(d.invoices) ? d.invoices : [];
    var body;
    if (!m.connected) body = '<div class="pl-empty">Invoices show here once Xero is connected. ' + link('Connect Xero', XERO_CONNECT, 'pl-sm pl-primary', true) + '</div>';
    else if (!list.length) body = '<div class="pl-empty">No unpaid invoices and nobody signed without one.</div>';
    else body = '<div class="pl-rows">' + list.map(invoiceRow).join('') + '</div>';
    return '<div class="pl-card"><div class="pl-card-h"><h3>Invoices</h3><div class="pl-right">' + fresh(F.xero) + (m.connected || (F.xero && F.xero.state === 'error') ? btn(state.syncing ? 'Syncing…' : 'Sync now', 'xero-sync', 'pl-sm', state.syncing ? 'disabled' : '') : '') + link('Xero', XERO_HOME, 'pl-sm pl-ghost') + '</div></div>' +
      '<div class="pl-card-b">' + body + '</div></div>';
  }

  /* ---------- inline forms ---------- */
  function stageSelect(name, withKeep) {
    return '<select name="' + name + '" class="pl-input">' + (withKeep ? '<option value="">Keep the stage</option>' : '') +
      STAGE_CHOICES.map(function (s) { return '<option value="' + s[0] + '">' + esc(s[1]) + '</option>'; }).join('') + '</select>';
  }
  function addFormHtml() {
    return '<form class="pl-form pl-card pl-add-form" data-pl-form="add"><div class="pl-form-h">Add a candidate</div><div class="pl-form-grid">' +
      '<label>Name<input class="pl-input" name="name" required maxlength="200" placeholder="Dr …"></label>' +
      '<label>Phone<input class="pl-input" name="phone" maxlength="40" placeholder="+44 …"></label>' +
      '<label>Email<input class="pl-input" name="email" type="email" maxlength="200"></label>' +
      '<label>Stage' + stageSelect('stage', false) + '</label>' +
      '<label>Practice<input class="pl-input" name="practice_name" maxlength="200"></label>' +
      '<label>Where they are<input class="pl-input" name="status_note" maxlength="500" placeholder="e.g. CV in, eligible"></label>' +
      '<label>Next step<input class="pl-input" name="next_step" maxlength="300" placeholder="e.g. Phone her"></label>' +
      '<label class="pl-check"><input type="checkbox" name="waiting_on_owner"> They are waiting on me</label>' +
      '</div><div class="pl-btn-row">' + btn('Save', 'add-save', 'pl-sm pl-primary') + btn('Cancel', 'form-cancel', 'pl-sm pl-ghost') + '<span class="pl-form-err"></span></div></form>';
  }
  function doneFormHtml(p) {
    return '<form class="pl-form pl-done-form" data-pl-form="done" data-id="' + escAttr(p.id) + '">' +
      '<label>What is the next step?<input class="pl-input" name="next_step" maxlength="300" placeholder="Leave blank if nothing yet"></label>' +
      '<label>Move to' + stageSelect('stage', true) + '</label>' +
      '<div class="pl-btn-row">' + btn('Save', 'done-save', 'pl-sm pl-primary', 'data-id="' + escAttr(p.id) + '"') + btn('Cancel', 'form-cancel', 'pl-sm pl-ghost') + '<span class="pl-form-err"></span></div></form>';
  }

  function ownerFormHtml(id) {
    return '<form class="pl-form pl-owner-form" data-pl-form="owner" data-inv="' + escAttr(id) + '">' +
      '<label>What happened?<select class="pl-input" name="status"><option value="paid_outside_xero">Paid outside Xero (money is in the bank)</option><option value="not_owed">Not owed (should be voided)</option></select></label>' +
      '<label>Note<input class="pl-input" name="note" maxlength="500" placeholder="e.g. Bank: $11,000 received 6 May 2026"></label>' +
      '<div class="pl-btn-row">' + btn('Save', 'owner-save', 'pl-sm pl-primary', 'data-inv="' + escAttr(id) + '"') + btn('Cancel', 'form-cancel', 'pl-sm pl-ghost') + '<span class="pl-form-err"></span></div></form>';
  }

  /* =====================================================================
   *  ACTIONS
   * ===================================================================== */
  function person(id) {
    var list = (state.data && state.data.people) || [];
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
  }
  function formErr(form, msg) { var e = form && form.querySelector('.pl-form-err'); if (e) e.textContent = msg || ''; }
  function closeForms() {
    state.form = null;
    var el = root();
    if (el) Array.prototype.forEach.call(el.querySelectorAll('.pl-form'), function (f) { f.parentNode.removeChild(f); });
    if (el) Array.prototype.forEach.call(el.querySelectorAll('.pl-acts[hidden],.pl-row-acts[hidden]'), function (a) { a.hidden = false; });
    if (state.pendingRender) render();
  }
  function post(b, path, body) {
    if (b) { b.disabled = true; }
    return ATS.api(path, { method: 'POST', body: body || {} }).then(function (d) {
      if (b) b.disabled = false;
      return d || { ok: false, message: 'Network error' };
    });
  }
  function openPerson(p) {
    if (!p || !p.open) return;
    var o = p.open;
    if (o.kind === 'app') {
      var target = o.case_id || o.user_id;
      if (target) location.hash = '#candidate=' + encodeURIComponent(target);
      return;
    }
    if ((o.kind === 'whatsapp' || o.kind === 'gmail') && /^https:\/\//.test(o.url || '')) { window.open(o.url, '_blank', 'noopener'); return; }
    ATS.toast('No phone, chat or email on file for ' + (p.name || 'this person') + '. Use Done to note the next step.', 'error');
  }
  function onClick(e) {
    var b = e.target.closest('[data-pl-act]');
    if (!b || !root() || !root().contains(b)) return;
    var act = b.getAttribute('data-pl-act');
    if (b.tagName === 'BUTTON') e.preventDefault();
    if (act === 'retry') { state.error = ''; load(!!state.data); return; }
    if (act === 'open') { openPerson(person(b.getAttribute('data-id'))); return; }
    if (act === 'form-cancel') { closeForms(); return; }
    if (act === 'add-open') {
      closeForms();
      state.form = 'add';
      var slot = document.getElementById('pl-form-slot');
      if (slot) { slot.innerHTML = addFormHtml(); var n = slot.querySelector('input[name="name"]'); if (n) n.focus(); }
      return;
    }
    if (act === 'add-save') {
      var f = b.closest('form');
      var v = function (k) { var x = f.elements[k]; return x ? String(x.value || '').trim() : ''; };
      if (!v('name')) { formErr(f, 'A name is needed.'); return; }
      var body = { name: v('name'), phone: v('phone') || null, email: v('email') || null, stage: v('stage') || 'warm', practice_name: v('practice_name') || null, status_note: v('status_note') || null, next_step: v('next_step') || null, waiting_on_owner: !!(f.elements.waiting_on_owner && f.elements.waiting_on_owner.checked) };
      post(b, '/api/ceo/pipeline/person', body).then(function (d) {
        if (!d.ok) { formErr(f, d.message || 'Could not save.'); return; }
        ATS.toast(d.message || 'Added.');
        closeForms();
        load(true);
      });
      return;
    }
    if (act === 'done-open') {
      closeForms();
      var p = person(b.getAttribute('data-id'));
      var card = b.closest('.pl-pc');
      if (!p || !card) return;
      var acts = card.querySelector('.pl-acts');
      if (acts) acts.hidden = true;
      card.insertAdjacentHTML('beforeend', doneFormHtml(p));
      var first = card.querySelector('.pl-done-form input');
      if (first) first.focus();
      return;
    }
    if (act === 'done-save') {
      var df = b.closest('form');
      var did = b.getAttribute('data-id');
      var next = df.elements.next_step ? String(df.elements.next_step.value || '').trim() : '';
      var stage = df.elements.stage ? String(df.elements.stage.value || '') : '';
      var dbody = { next_step: next || null };
      if (stage) dbody.stage = stage;
      post(b, '/api/ceo/pipeline/person/' + encodeURIComponent(did) + '/done', dbody).then(function (d) {
        if (!d.ok) { formErr(df, d.message || 'Could not save.'); return; }
        ATS.toast(d.message || 'Done.');
        closeForms();
        load(true);
      });
      return;
    }
    if (act === 'owner-open') {
      closeForms();
      var orow = b.closest('.pl-row');
      if (!orow) return;
      var oacts = orow.querySelector('.pl-row-acts');
      if (oacts) oacts.hidden = true;
      orow.insertAdjacentHTML('afterend', ownerFormHtml(b.getAttribute('data-inv')));
      var onote = orow.nextElementSibling && orow.nextElementSibling.querySelector('input[name="note"]');
      if (onote) onote.focus();
      return;
    }
    if (act === 'owner-save' || act === 'owner-undo') {
      var inv = b.getAttribute('data-inv');
      var of = act === 'owner-save' ? b.closest('form') : null;
      var obody = of
        ? { status: String((of.elements.status && of.elements.status.value) || 'paid_outside_xero'), note: String((of.elements.note && of.elements.note.value) || '').trim() || null }
        : { status: null, note: null };
      post(b, OWNER_STATUS + encodeURIComponent(inv) + '/owner-status', obody).then(function (d) {
        if (!d.ok) { if (of) formErr(of, d.message || 'Could not save.'); else ATS.toast('Failed: ' + (d.message || 'could not save'), 'error'); return; }
        ATS.toast(d.message || 'Saved.');
        closeForms();
        load(true);
      });
      return;
    }
    if (act === 'fc-bar') { fcSelect(b.getAttribute('data-key')); return; }
    if (act === 'fc-add-open') {
      closeForms();
      state.form = 'income';
      var fslot = document.getElementById('pl-fc-form-slot');
      if (fslot) { fslot.innerHTML = fcIncomeForm(); var fl = fslot.querySelector('input[name="label"]'); if (fl) fl.focus(); }
      return;
    }
    if (act === 'fc-income-save') {
      var inf = b.closest('form');
      var iv = function (k) { var x = inf.elements[k]; return x ? String(x.value || '').trim() : ''; };
      var amt = Number(iv('amount_inc_gst').replace(/[$,\s]/g, ''));
      if (!iv('label')) { formErr(inf, 'Say what the money is for.'); return; }
      if (!(amt > 0)) { formErr(inf, 'Enter the amount (inc GST).'); return; }
      post(b, INCOME_EXPECTATION, { label: iv('label'), from_name: iv('from_name') || null, doctor_name: iv('doctor_name') || null, amount_inc_gst: amt, expected_date: iv('expected_date') || null, confidence: iv('confidence') || 'estimated', note: iv('note') || null }).then(function (d) {
        if (!d.ok) { formErr(inf, d.message || 'Could not save.'); return; }
        ATS.toast(d.message || 'Added.');
        closeForms();
        load(true);
      });
      return;
    }
    if (act === 'fc-exp-remove') {
      post(b, INCOME_EXPECTATION, { id: b.getAttribute('data-id'), archived: true }).then(function (d) {
        if (!d.ok) { ATS.toast('Failed: ' + (d.message || 'could not save'), 'error'); return; }
        ATS.toast(d.message || 'Removed.');
        load(true);
      });
      return;
    }
    if (act === 'fc-start-save' || act === 'fc-start-clear') {
      var tr = b.closest('tr');
      var sid = b.getAttribute('data-id');
      var dateEl = tr && tr.querySelector('.pl-fc-date');
      var basisEl = tr && tr.querySelector('.pl-fc-basis');
      var sdate = act === 'fc-start-clear' ? null : (dateEl && dateEl.value) || null;
      if (act === 'fc-start-save' && !sdate) { ATS.toast('Pick a start date first (or press Clear).', 'error'); return; }
      post(b, '/api/ceo/pipeline/person/' + encodeURIComponent(sid) + EXPECTED_START, { date: sdate, basis: (basisEl && basisEl.value) || 'estimated' }).then(function (d) {
        if (!d.ok) { ATS.toast('Failed: ' + (d.message || 'could not save'), 'error'); return; }
        ATS.toast(d.message || 'Saved.');
        if (document.activeElement && root() && root().contains(document.activeElement)) document.activeElement.blur();
        load(true);
      });
      return;
    }
    if (act === 'banner-close') { state.xeroBanner = null; render(); return; }
    if (act === 'xero-sync') {
      if (state.syncing) return;
      state.syncing = true;
      render();
      ATS.api('/api/ceo/xero/sync', { method: 'POST', body: {} }).then(function (d) {
        state.syncing = false;
        if (!d || !d.ok) ATS.toast('Xero sync failed: ' + ((d && (d.message || d.error)) || 'network error'), 'error');
        else ATS.toast(d.message || 'Xero synced.');
        load(true);
      });
      return;
    }
    if (act === 'find-confirm') {
      // Confirming is not just a flag: it creates the placement and sends the
      // real "placement secured" emails, so the owner says yes twice.
      closeForms();
      var fc = b.closest('.pl-pc');
      if (!fc) return;
      var fa = fc.querySelector('.pl-acts');
      if (fa) fa.hidden = true;
      fc.insertAdjacentHTML('beforeend', '<form class="pl-form pl-confirm-form" data-pl-form="confirm"><div class="pl-why">This creates the placement in the app and emails the doctor and practice.</div>' +
        '<div class="pl-btn-row">' + btn('Yes, confirm', 'find-confirm-yes', 'pl-sm pl-good', 'data-gm="' + escAttr(b.getAttribute('data-gm')) + '"') + btn('Cancel', 'form-cancel', 'pl-sm pl-ghost') + '<span class="pl-form-err"></span></div></form>');
      return;
    }
    if (act === 'find-confirm-yes' || act === 'find-dismiss') {
      var gm = b.getAttribute('data-gm');
      var kind = act === 'find-confirm-yes' ? 'confirm' : 'dismiss';
      var cf = b.closest('form');
      post(b, '/api/ceo/pipeline/email-find/' + encodeURIComponent(gm) + '/' + kind, {}).then(function (d) {
        var msg = d.message || (d.ok ? (kind === 'confirm' ? 'Confirmed.' : 'Dismissed.') : (d.status ? 'HTTP ' + d.status : 'network error'));
        if (!d.ok) { if (cf) formErr(cf, msg); else ATS.toast('Failed: ' + msg, 'error'); return; }
        if (cf) cf.innerHTML = '<div class="pl-note">' + esc(msg) + '</div>';
        ATS.toast(msg);
        setTimeout(function () { closeForms(); load(true); }, cf ? 2500 : 0);
      });
      return;
    }
    if (act === 'import-pick') {
      var input = document.getElementById('pl-file');
      if (input) { input.value = ''; input.click(); }
      return;
    }
  }
  function onSubmit(e) {
    var f = e.target.closest && e.target.closest('.pl-form');
    if (!f || !root() || !root().contains(f)) return;
    e.preventDefault();
    var save = f.querySelector('[data-pl-act="add-save"],[data-pl-act="done-save"],[data-pl-act="find-confirm-yes"],[data-pl-act="owner-save"],[data-pl-act="fc-income-save"]');
    if (save) save.click();
  }
  function onKey(e) {
    var bar = e.target.closest && e.target.closest('[data-pl-act="fc-bar"]');
    if (bar && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fcSelect(bar.getAttribute('data-key')); return; }
    if (e.key !== 'Escape') return;
    var f = e.target.closest && e.target.closest('.pl-form');
    if (f && root() && root().contains(f)) closeForms();
  }
  function onChange(e) {
    var input = e.target;
    if (!input || input.id !== 'pl-file' || !input.files || !input.files[0]) return;
    var file = input.files[0];
    state.importMsg = 'Reading ' + file.name + '…';
    render();
    var reader = new FileReader();
    reader.onerror = function () { state.importMsg = 'Could not read that file.'; render(); };
    reader.onload = function () {
      var json;
      try { json = JSON.parse(String(reader.result || '')); } catch (err) { state.importMsg = 'That file is not JSON. Pick the WhatsApp export (.json).'; render(); return; }
      if (!json || !Array.isArray(json.chats)) { state.importMsg = 'That file is not a WhatsApp export (no chats in it).'; render(); return; }
      state.importMsg = 'Uploading ' + json.chats.length + ' chats…';
      render();
      ATS.api('/api/ceo/pipeline/whatsapp-import', { method: 'POST', body: json }).then(function (d) {
        if (!d || !d.ok) { state.importMsg = 'Upload failed: ' + ((d && (d.message || d.error)) || 'network error'); render(); return; }
        state.importMsg = 'WhatsApp export uploaded: ' + (d.created || 0) + ' new, ' + (d.updated || 0) + ' updated, ' + (d.skipped || 0) + ' skipped' + (d.unchanged ? ', ' + d.unchanged + ' unchanged' : '') + '.';
        load(true);
      });
    };
    reader.readAsText(file);
  }
  var wired = false;
  function ensureWired(el) {
    if (wired) return;
    wired = true;
    el.addEventListener('click', onClick);
    el.addEventListener('submit', onSubmit);
    el.addEventListener('keydown', onKey);
    el.addEventListener('change', onChange);
    // Hover or keyboard focus on a forecast bar lists what is in it (tap = click).
    el.addEventListener('mouseover', function (e) { var g = e.target.closest && e.target.closest('[data-pl-act="fc-bar"]'); if (g) fcSelect(g.getAttribute('data-key')); });
    el.addEventListener('focusin', function (e) { var g = e.target.closest && e.target.closest('[data-pl-act="fc-bar"]'); if (g) fcSelect(g.getAttribute('data-key')); });
    // A poll that arrived while a date was being picked draws once focus leaves.
    el.addEventListener('focusout', function () { setTimeout(function () { if (state.pendingRender && !formOpen()) render(); }, 0); });
  }
})();

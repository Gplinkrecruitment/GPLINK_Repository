/* ============================================================================
 * ceo-ads-range.js — the Performance card on the Social tab's Ads hub: any
 * date range, daily / weekly / monthly, compared with the period before, with
 * the picker Ads Manager uses (presets on the left, two months on the right,
 * compare toggle, dates on the account's calendar).
 *
 * Owns #soc-range-root, which the hub paints into its summary card. State
 * (range, step, compare, the last report) lives here, so a hub repaint after a
 * refresh does not reset the owner's selection.
 * ========================================================================== */
(function () {
  'use strict';

  var A = window.ATS || {};
  var esc = A.esc || function (s) { return String(s == null ? '' : s); };
  // Resolved at call time: this file loads BEFORE ceo-social.js, which is what
  // defines window.AdsHub (a load-time capture left every tile unformatted).
  function hub() { return window.AdsHub || {}; }

  var state = {
    preset: 'last_7d', since: null, until: null, compare: true, increment: '1',
    report: null, loading: false, error: null, open: false,
    pick: { preset: 'last_7d', since: null, until: null, compare: true, month: null, anchor: null },
    sort: { key: 'spend', dir: 'desc' }, data: null, inFlight: 0
  };
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function root() { return document.getElementById('soc-range-root'); }
  function money(v, dp) {
    if (hub().money) return hub().money(v, dp);
    if (v === null || v === undefined || v === '' || !isFinite(Number(v))) return '—';
    return 'A$' + Number(v).toLocaleString('en-AU', { minimumFractionDigits: dp == null ? 2 : dp, maximumFractionDigits: dp == null ? 2 : dp });
  }
  function int(v) { return (v === null || v === undefined || !isFinite(Number(v))) ? '—' : Number(v).toLocaleString('en-AU'); }
  function pct(v, dp) { return (v === null || v === undefined || !isFinite(Number(v))) ? '—' : Number(v).toFixed(dp == null ? 1 : dp) + '%'; }
  function num(v, dp) { return (v === null || v === undefined || !isFinite(Number(v))) ? '—' : Number(v).toFixed(dp == null ? 2 : dp); }
  function delta(p, goodWhen) {
    if (!state.compare || p === null || p === undefined || !isFinite(Number(p))) return '';
    var n = Number(p);
    if (n === 0) return '<span class="mk-delta flat">no change</span>';
    var good = goodWhen === 'down' ? n < 0 : goodWhen === 'up' ? n > 0 : null;
    return '<span class="mk-delta ' + (good === null ? 'flat' : good ? 'good' : 'bad') + '">' + (n > 0 ? '▲' : '▼') + ' ' + Math.abs(n) + '%</span>';
  }
  function ymdParts(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; }
  function ymd(y, m, d) { return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
  function fmtDay(s, withYear) {
    var p = ymdParts(s); if (!p) return s || '';
    return p.d + ' ' + MONTHS[p.m - 1].slice(0, 3) + (withYear ? ' ' + p.y : '');
  }
  function fmtRange(since, until) {
    if (!since || !until) return '';
    var a = ymdParts(since), b = ymdParts(until);
    if (since === until) return fmtDay(since, true);
    if (a.y === b.y && a.m === b.m) return a.d + ' – ' + fmtDay(until, true);
    return fmtDay(since, a.y !== b.y) + ' – ' + fmtDay(until, true);
  }
  function presetLabel(key) {
    var list = (state.data && state.data.range_presets) || [];
    var hit = list.filter(function (p) { return p.key === key; })[0];
    return hit ? hit.label : 'Custom';
  }

  // ── render ───────────────────────────────────────────────────────────────
  function render(data) {
    if (data) state.data = data;
    var r = root();
    if (!r) return;
    if (!r.getAttribute('data-wired')) {
      r.setAttribute('data-wired', '1');
      r.addEventListener('click', onClick);
      r.addEventListener('change', onChange);
    }
    r.innerHTML = cardHtml();
    wireChart();
    if (!state.report && !state.loading && !state.error && state.data && state.data.configured) load();
  }

  function cardHtml() {
    var d = state.data || {};
    var rep = state.report;
    var rangeText = rep ? fmtRange(rep.range.since, rep.range.until) : '';
    var title = state.preset ? presetLabel(state.preset) : 'Custom';
    var html = '<div class="mk-range">' +
      '<div class="mk-range-bar">' +
        '<button type="button" class="mk-range-btn" data-act="open" title="Choose the dates">' +
          '<span class="mk-range-btn-main">' + esc(title) + '</span>' + (rangeText ? '<span class="mk-range-btn-sub">' + esc(rangeText) + '</span>' : '') + '<span class="mk-caret">▾</span>' +
        '</button>' +
        '<div class="mk-seg" role="group" aria-label="Step">' +
          segBtn('1', 'Daily') + segBtn('7', 'Weekly') + segBtn('monthly', 'Monthly') +
        '</div>' +
        '<label class="mk-compare"><input type="checkbox" data-role="compare-quick"' + (state.compare ? ' checked' : '') + '> Compare with the period before' +
          (state.compare && rep && rep.compare ? ' <span class="soc-when">(' + esc(fmtRange(rep.compare.range.since, rep.compare.range.until)) + ')</span>' : '') + '</label>' +
        '<span class="soc-when mk-tz">Dates in ' + esc((d.account_time_zone || 'Australia/Sydney').replace('Australia/', '')) + ' time, as Meta counts them</span>' +
      '</div>';
    if (state.open) html += pickerHtml();
    if (!d.configured) {
      html += '<div class="ats-empty">Connect Meta to explore performance by date.</div>';
    } else if (state.loading && !rep) {
      html += '<div class="ats-empty">Loading ' + esc(title.toLowerCase()) + '…</div>';
    } else if (state.error && !rep) {
      html += '<div class="soc-warn">' + esc(state.error) + '</div>';
    } else if (rep) {
      html += (state.loading ? '<div class="mk-range-loading">Updating…</div>' : '');
      if (rep.errors && rep.errors.length) html += '<div class="soc-note">' + esc(rep.errors.join(' ')) + '</div>';
      html += kpis(rep) + chart(rep) + adsTable(rep);
    }
    return html + '</div>';
  }

  function segBtn(key, label) {
    return '<button type="button" class="mk-seg-btn' + (state.increment === key ? ' is-on' : '') + '" data-act="increment" data-inc="' + key + '">' + label + '</button>';
  }

  function tile(label, value, extra, title) {
    return '<div class="mk-kpi"' + (title ? ' title="' + esc(title) + '"' : '') + '><span class="mk-kpi-label">' + esc(label) + '</span><b class="mk-kpi-value">' + value + '</b>' + (extra ? '<span class="mk-kpi-extra">' + extra + '</span>' : '') + '</div>';
  }

  function kpis(rep) {
    var t = rep.totals || {}, f = rep.funnel || {}, dl = rep.deltas || {};
    return '<div class="mk-kpi-row"><div class="mk-kpi-group-label">Meta, ' + esc(fmtRange(rep.range.since, rep.range.until)) + '</div>' +
      tile('Spend', money(t.spend), delta(dl.spend, null)) +
      tile('Leads', int(t.leads), delta(dl.leads, 'up')) +
      tile('Cost per lead', money(t.cost_per_lead), delta(dl.cost_per_lead, 'down')) +
      tile('Link clicks', int(t.link_clicks), delta(dl.link_clicks, 'up')) +
      tile('Click → lead', pct(t.click_to_lead_pct), '', 'Leads as a share of link clicks (form opens)') +
      tile('Reach', int(t.reach), delta(dl.reach, 'up')) +
      tile('Frequency', num(t.frequency), delta(dl.frequency, 'down'), 'Times each person saw an ad') +
    '</div>' +
    '<div class="mk-kpi-row"><div class="mk-kpi-group-label">After the form (GP Link app), same days</div>' +
      tile('Leads in app', int(f.leads), '', 'Meta leads that reached the app in these days') +
      tile('Booked a call', int(f.booked), delta(dl.booked, 'up')) +
      tile('Attended', int(f.attended), delta(dl.attended, 'up'), 'Consultations that actually happened') +
      tile('Signed up', int(f.signed_up), delta(dl.signed_up, 'up')) +
      tile('Cost per booking', money(f.cost_per_booking), delta(dl.cost_per_booking, 'down'), 'Spend ÷ booked calls. The number that decides which ads stay.') +
      tile('Booking rate', pct(f.booking_rate_pct, 0), '', 'Booked ÷ leads in app') +
      tile('Median time to book', f.median_hours_to_book === null || f.median_hours_to_book === undefined ? '—' : (f.median_hours_to_book < 1 ? Math.round(f.median_hours_to_book * 60) + ' min' : num(f.median_hours_to_book, 1) + ' h'),
        f.booked_within_10min_pct !== null && f.booked_within_10min_pct !== undefined ? '<span class="mk-kpi-extra">' + f.booked_within_10min_pct + '% within 10 minutes</span>' : '') +
    '</div>';
  }

  function bucketLabel(b) {
    if (state.increment === '1') return fmtDay(b.since);
    if (state.increment === 'monthly') { var p = ymdParts(b.since); return p ? MONTHS[p.m - 1].slice(0, 3) + ' ' + p.y : b.since; }
    return fmtDay(b.since) + '–' + fmtDay(b.until);
  }

  // A proper chart, no library: spend as bars on a left money axis, leads and
  // booked calls as lines with markers on a right count axis, gridlines, tick
  // labels, a hover readout. Drawn at the container's real pixel width (no
  // preserveAspectRatio stretching, which skewed every label and marker) and
  // redrawn on resize.
  function niceStep(max, ticks) {
    var raw = max / Math.max(1, ticks);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return step * mag;
  }
  function axisMax(max, ticks) {
    if (!(max > 0)) return ticks;
    var step = niceStep(max, ticks);
    return Math.ceil(max / step) * step;
  }
  function chartWidth() {
    var r = root();
    var w = r ? r.clientWidth : 0;
    return Math.max(420, Math.min(1400, w || 900));
  }
  function chart(rep) {
    var s = rep.series || [];
    if (!s.length) return '';
    var W = chartWidth(), Hh = 240, padL = 62, padR = 46, top = 16, bottom = 42;
    var innerW = W - padL - padR, innerH = Hh - top - bottom;
    var n = s.length;
    var spendMax = axisMax(Math.max.apply(null, s.map(function (x) { return Number(x.spend) || 0; })), 4);
    var countMax = axisMax(Math.max.apply(null, s.map(function (x) { return Math.max(Number(x.leads) || 0, Number(x.booked) || 0); })), 4);
    var slot = innerW / n;
    var barW = Math.min(56, slot * 0.6);
    var ySpend = function (v) { return top + innerH - (Number(v) || 0) / spendMax * innerH; };
    var yCount = function (v) { return top + innerH - (Number(v) || 0) / countMax * innerH; };
    var xMid = function (i) { return padL + i * slot + slot / 2; };
    var grid = '', leftTicks = '', rightTicks = '';
    for (var t = 0; t <= 4; t++) {
      var y = top + innerH - (innerH * t / 4);
      grid += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" class="mk-chart-grid"/>';
      leftTicks += '<text x="' + (padL - 8) + '" y="' + (y + 4).toFixed(1) + '" class="mk-chart-tick" text-anchor="end">' + esc(money(spendMax * t / 4, 0)) + '</text>';
      rightTicks += '<text x="' + (W - padR + 8) + '" y="' + (y + 4).toFixed(1) + '" class="mk-chart-tick" text-anchor="start">' + esc(String(Math.round(countMax * t / 4))) + '</text>';
    }
    var bars = '', leadsPath = '', bookedPath = '', markers = '', labels = '', hover = '';
    var every = Math.max(1, Math.ceil(n / Math.floor(innerW / 64)));
    s.forEach(function (x, i) {
      var cx = xMid(i);
      var yb = ySpend(x.spend);
      bars += '<rect x="' + (cx - barW / 2).toFixed(1) + '" y="' + yb.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + (top + innerH - yb).toFixed(1) + '" rx="3" class="mk-chart-bar"/>';
      var yl = yCount(x.leads), yk = yCount(x.booked);
      leadsPath += (i ? ' L' : 'M') + cx.toFixed(1) + ' ' + yl.toFixed(1);
      bookedPath += (i ? ' L' : 'M') + cx.toFixed(1) + ' ' + yk.toFixed(1);
      markers += '<circle cx="' + cx.toFixed(1) + '" cy="' + yl.toFixed(1) + '" r="3.5" class="mk-chart-dot-leads"/>' +
        '<circle cx="' + cx.toFixed(1) + '" cy="' + yk.toFixed(1) + '" r="3.5" class="mk-chart-dot-booked"/>';
      if (i % every === 0 || i === n - 1) labels += '<text x="' + cx.toFixed(1) + '" y="' + (Hh - 16) + '" class="mk-chart-tick" text-anchor="middle">' + esc(bucketLabel(x)) + '</text>';
      hover += '<rect x="' + (padL + i * slot).toFixed(1) + '" y="' + top + '" width="' + slot.toFixed(1) + '" height="' + innerH + '" class="mk-chart-hit" data-i="' + i + '"/>';
    });
    return '<div class="mk-chart" data-role="chart">' +
      '<svg width="' + W + '" height="' + Hh + '" viewBox="0 0 ' + W + ' ' + Hh + '" role="img" aria-label="Spend, leads and booked calls per ' + (state.increment === '1' ? 'day' : state.increment === '7' ? 'week' : 'month') + '">' +
        grid + leftTicks + rightTicks +
        '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + (top + innerH) + '" y2="' + (top + innerH) + '" class="mk-chart-axis"/>' +
        bars + '<path d="' + leadsPath + '" class="mk-chart-line-leads"/><path d="' + bookedPath + '" class="mk-chart-line-booked"/>' + markers + labels +
        '<line class="mk-chart-cursor" data-role="cursor" x1="0" x2="0" y1="' + top + '" y2="' + (top + innerH) + '" style="display:none"/>' +
        hover +
      '</svg>' +
      '<div class="mk-chart-tip" data-role="tip" hidden></div>' +
      '<div class="mk-spark-legend"><span><i class="bar"></i> spend (left axis)</span><span><i class="dot"></i> leads, Meta (right axis)</span><span><i class="booked"></i> booked calls, app (right axis)</span></div>' +
    '</div>';
  }
  function wireChart() {
    var r = root();
    var box = r && r.querySelector('[data-role="chart"]');
    if (!box || box.getAttribute('data-wired')) return;
    box.setAttribute('data-wired', '1');
    var tip = box.querySelector('[data-role="tip"]');
    var cursor = box.querySelector('[data-role="cursor"]');
    box.addEventListener('mousemove', function (e) {
      var hit = e.target.closest ? e.target.closest('.mk-chart-hit') : null;
      if (!hit || !state.report) { tip.hidden = true; cursor.style.display = 'none'; return; }
      var i = Number(hit.getAttribute('data-i'));
      var b = (state.report.series || [])[i];
      if (!b) return;
      var cx = Number(hit.getAttribute('x')) + Number(hit.getAttribute('width')) / 2;
      cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.style.display = '';
      tip.innerHTML = '<strong>' + esc(bucketLabel(b)) + '</strong><br>Spend ' + esc(money(b.spend)) + '<br>Leads (Meta) ' + esc(int(b.leads)) +
        '<br>Leads in app ' + esc(int(b.app_leads)) + ' · booked ' + esc(int(b.booked)) + ' · attended ' + esc(int(b.attended)) + '<br>Link clicks ' + esc(int(b.link_clicks)) + ' · cost per lead ' + esc(money(b.cost_per_lead));
      tip.hidden = false;
      var bw = box.clientWidth;
      var left = Math.min(Math.max(8, cx - 90), bw - 200);
      tip.style.left = left + 'px';
    });
    box.addEventListener('mouseleave', function () { tip.hidden = true; cursor.style.display = 'none'; });
  }
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (!state.report) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { render(); }, 150);
  });

  var COLS = [
    { key: 'spend', label: 'Spend', get: function (a) { return a.metrics.spend; }, fmt: function (v) { return money(v, 0); } },
    { key: 'leads', label: 'Leads', get: function (a) { return a.metrics.leads; }, fmt: int },
    { key: 'cpl', label: 'Cost / lead', get: function (a) { return a.metrics.cost_per_lead; }, fmt: function (v) { return money(v, 0); } },
    { key: 'clicks', label: 'Link clicks', get: function (a) { return a.metrics.link_clicks; }, fmt: int },
    { key: 'c2l', label: 'Click → lead', get: function (a) { return a.metrics.click_to_lead_pct; }, fmt: function (v) { return pct(v); } },
    { key: 'booked', label: 'Booked', get: function (a) { return a.funnel.booked; }, fmt: int },
    { key: 'attended', label: 'Attended', get: function (a) { return a.funnel.attended; }, fmt: int },
    { key: 'signed', label: 'Signed up', get: function (a) { return a.funnel.signed_up; }, fmt: int },
    { key: 'cpb', label: 'Cost / booking', get: function (a) { return a.funnel.cost_per_booking; }, fmt: function (v) { return money(v, 0); } }
  ];

  function adsTable(rep) {
    var ads = (rep.ads || []).slice();
    if (!ads.length) return '<div class="ats-empty">No ad delivered in these days.</div>';
    var col = COLS.filter(function (c) { return c.key === state.sort.key; })[0] || COLS[0];
    ads.sort(function (a, b) {
      var x = col.get(a), y = col.get(b);
      x = x === null || x === undefined ? -Infinity : Number(x); y = y === null || y === undefined ? -Infinity : Number(y);
      return state.sort.dir === 'desc' ? y - x : x - y;
    });
    var cmp = state.compare && rep.compare ? rep.compare.ads_by_id : null;
    var html = '<div class="mk-table-wrap"><table class="mk-table"><thead><tr><th>Ad</th>' + COLS.map(function (c) {
      return '<th class="num' + (state.sort.key === c.key ? ' is-sorted' : '') + '"><button type="button" data-act="sort" data-key="' + c.key + '">' + esc(c.label) + (state.sort.key === c.key ? (state.sort.dir === 'desc' ? ' ▼' : ' ▲') : '') + '</button></th>';
    }).join('') + '</tr></thead><tbody>';
    ads.forEach(function (a) {
      var prev = cmp && cmp[a.id];
      html += '<tr><td class="mk-table-ad">' +
        (a.image_url ? '<img src="/api/ceo/ads/photo-proxy?url=' + encodeURIComponent(a.image_url) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '<span class="mk-table-noimg"></span>') +
        '<span><span class="mk-table-name">' + esc(a.headline || a.name) + '</span><span class="soc-when">' + esc(a.name) + (a.status && a.status !== 'ACTIVE' ? ' · ' + esc(a.status.toLowerCase().replace(/_/g, ' ')) : '') + '</span></span></td>';
      COLS.forEach(function (c) {
        var v = c.get(a);
        var sub = '';
        if (prev) {
          var pv = c.get({ metrics: prev.metrics, funnel: prev.funnel });
          if (pv !== null && pv !== undefined && Number(pv) !== 0) {
            var pc = Math.round(((Number(v) || 0) - Number(pv)) / Math.abs(Number(pv)) * 100);
            sub = '<span class="mk-table-prev">' + (c.key === 'cpl' || c.key === 'cpb' ? delta(pc, 'down') : delta(pc, 'up')) + '</span>';
          }
        }
        html += '<td class="num">' + c.fmt(v) + sub + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    if (rep.unattributed && rep.unattributed.leads) {
      html += '<div class="soc-when">' + rep.unattributed.leads + ' lead' + (rep.unattributed.leads === 1 ? '' : 's') + ' in these days arrived with no ad id (' + rep.unattributed.booked + ' booked). Meta leads from the form\'s own thank-you page can land without one.</div>';
    }
    return html;
  }

  // ── the picker ───────────────────────────────────────────────────────────
  function pickerHtml() {
    var p = state.pick;
    var presets = (state.data && state.data.range_presets) || [];
    var base = p.month || (p.until ? ymdParts(p.until) : null) || todayParts();
    var right = { y: base.y, m: base.m };
    var left = right.m === 1 ? { y: right.y - 1, m: 12 } : { y: right.y, m: right.m - 1 };
    var sinceTxt = p.since ? fmtDay(p.since, true) : 'Start';
    var untilTxt = p.until ? fmtDay(p.until, true) : 'End';
    return '<div class="mk-picker" role="dialog" aria-label="Choose dates">' +
      '<div class="mk-picker-presets">' + presets.map(function (x) {
        return '<label class="mk-preset' + (p.preset === x.key ? ' is-on' : '') + '"><input type="radio" name="mk-preset" value="' + esc(x.key) + '"' + (p.preset === x.key ? ' checked' : '') + '> ' + esc(x.label) + '</label>';
      }).join('') + '<label class="mk-preset' + (!p.preset ? ' is-on' : '') + '"><input type="radio" name="mk-preset" value=""' + (!p.preset ? ' checked' : '') + '> Custom</label></div>' +
      '<div class="mk-picker-cal">' +
        '<div class="mk-cal-nav"><button type="button" class="soc-btn" data-act="cal-prev">‹</button><span class="soc-when">Click a start day, then an end day</span><button type="button" class="soc-btn" data-act="cal-next">›</button></div>' +
        '<div class="mk-cal-months">' + monthHtml(left.y, left.m) + monthHtml(right.y, right.m) + '</div>' +
        '<div class="mk-picker-foot">' +
          '<label class="mk-compare"><input type="checkbox" data-role="compare-pick"' + (p.compare ? ' checked' : '') + '> Compare with the period before</label>' +
          '<span class="mk-picker-range">' + esc(sinceTxt) + ' – ' + esc(untilTxt) + '</span>' +
          '<span class="soc-when">Dates are shown in ' + esc(((state.data || {}).account_time_zone || 'Australia/Sydney').replace('Australia/', '')) + ' time</span>' +
          '<span class="mk-picker-actions"><button type="button" class="soc-btn" data-act="cancel">Cancel</button><button type="button" class="btn-primary" data-act="apply"' + (!p.preset && !(p.since && p.until) ? ' disabled' : '') + '>Update</button></span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function todayParts() {
    // The account's calendar day, from the server when we have it.
    var t = state.data && state.data.today;
    var p = t ? ymdParts(t) : null;
    if (p) return p;
    var d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
  }
  function todayYmd() { var t = todayParts(); return ymd(t.y, t.m, t.d); }

  function monthHtml(y, m) {
    var first = new Date(Date.UTC(y, m - 1, 1));
    var startDow = first.getUTCDay();
    var days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    var p = state.pick;
    var today = todayYmd();
    var html = '<div class="mk-cal-month"><div class="mk-cal-title">' + esc(MONTHS[m - 1]) + ' ' + y + '</div><div class="mk-cal-grid">' +
      DOW.map(function (d) { return '<span class="mk-cal-dow">' + d + '</span>'; }).join('');
    for (var i = 0; i < startDow; i++) html += '<span class="mk-cal-pad"></span>';
    for (var d = 1; d <= days; d++) {
      var key = ymd(y, m, d);
      var cls = 'mk-cal-day';
      if (key > today) cls += ' is-future';
      if (p.since && p.until && key >= p.since && key <= p.until) cls += ' in-range';
      if (key === p.since) cls += ' is-start';
      if (key === p.until) cls += ' is-end';
      if (key === today) cls += ' is-today';
      html += '<button type="button" class="' + cls + '" data-act="day" data-day="' + key + '"' + (key > today ? ' disabled' : '') + '>' + d + '</button>';
    }
    return html + '</div></div>';
  }

  // ── events ───────────────────────────────────────────────────────────────
  function onClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    if (act === 'open') { openPicker(); return; }
    if (act === 'cancel') { state.open = false; render(); return; }
    if (act === 'apply') { applyPick(); return; }
    if (act === 'increment') { state.increment = btn.getAttribute('data-inc'); render(); load(); return; }
    if (act === 'sort') {
      var key = btn.getAttribute('data-key');
      if (state.sort.key === key) state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
      else state.sort = { key: key, dir: 'desc' };
      render(); return;
    }
    if (act === 'day') { pickDay(btn.getAttribute('data-day')); return; }
    if (act === 'cal-prev' || act === 'cal-next') {
      var base = state.pick.month || (state.pick.until ? ymdParts(state.pick.until) : todayParts());
      var m = base.m + (act === 'cal-next' ? 1 : -1), y = base.y;
      if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
      state.pick.month = { y: y, m: m }; render(); return;
    }
  }
  function onChange(e) {
    var t = e.target;
    if (t.getAttribute('name') === 'mk-preset') {
      state.pick.preset = t.value || null;
      if (state.pick.preset) { state.pick.since = null; state.pick.until = null; }
      render(); return;
    }
    if (t.getAttribute('data-role') === 'compare-pick') { state.pick.compare = !!t.checked; return; }
    if (t.getAttribute('data-role') === 'compare-quick') { state.compare = !!t.checked; state.pick.compare = state.compare; render(); load(); return; }
  }
  function openPicker() {
    state.open = true;
    state.pick = { preset: state.preset, since: state.report ? state.report.range.since : null, until: state.report ? state.report.range.until : null, compare: state.compare, month: null, anchor: null };
    render();
  }
  function pickDay(day) {
    var p = state.pick;
    p.preset = null;
    if (!p.anchor) { p.anchor = day; p.since = day; p.until = day; }
    else {
      if (day < p.anchor) { p.since = day; p.until = p.anchor; } else { p.since = p.anchor; p.until = day; }
      p.anchor = null;
    }
    render();
  }
  function applyPick() {
    var p = state.pick;
    state.preset = p.preset || null;
    state.since = p.preset ? null : p.since;
    state.until = p.preset ? null : p.until;
    state.compare = !!p.compare;
    state.open = false;
    // Pick a sensible step for the new length; the owner can change it after.
    var days = (p.preset ? presetDays(p.preset) : daysBetween(p.since, p.until)) || 7;
    state.increment = days >= 60 ? 'monthly' : (days > 14 ? '7' : '1');
    render();
    load();
  }
  function presetDays(key) { return ({ today: 1, yesterday: 1, today_yesterday: 2, last_7d: 7, last_14d: 14, last_28d: 28, last_30d: 30, this_week: 7, last_week: 7, this_month: 30, last_month: 30 })[key] || 7; }
  function daysBetween(a, b) { var x = ymdParts(a), y = ymdParts(b); if (!x || !y) return 0; return Math.round((Date.UTC(y.y, y.m - 1, y.d) - Date.UTC(x.y, x.m - 1, x.d)) / 86400000) + 1; }

  // ── data ─────────────────────────────────────────────────────────────────
  function load() {
    if (!state.data || !state.data.configured) return;
    var q = (state.preset ? 'preset=' + encodeURIComponent(state.preset) : 'since=' + encodeURIComponent(state.since) + '&until=' + encodeURIComponent(state.until)) +
      '&increment=' + encodeURIComponent(state.increment) + '&compare=' + (state.compare ? '1' : '0');
    var seq = ++state.inFlight;
    state.loading = true; state.error = null; render();
    A.api('/api/ceo/ads/range?' + q).then(function (d) {
      if (seq !== state.inFlight) return; // a newer request superseded this one
      state.loading = false;
      if (!d || !d.range) { state.error = (d && d.message) || 'Could not load that range.'; render(); return; }
      state.report = d;
      if (!d.ok && d.errors && d.errors.length) state.error = d.errors.join(' ');
      render();
    });
  }

  window.AdsRange = { render: render, reload: load, state: state };
})();

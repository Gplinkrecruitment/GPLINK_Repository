/* ============================================================================
 * ceo-social.js — the Social tab of the CEO dashboard: the Ads hub.
 *
 * What the owner sees every morning, in order:
 *   1. Today's summary — yesterday and the last 7 days against the week before,
 *      the app's own booking funnel per ad, and the model's plain-English
 *      review (written by Claude Opus, stored by the morning cron).
 *   2. The creatives that are live, each with its numbers, its cost per
 *      BOOKING from the app, the owner's rotation-rule flags and the model's
 *      verdict.
 *   3. The model's suggested improvements, with "Generate N new ads" that
 *      writes new ads applying the ticked ones.
 *   4. New ads (js/ceo-ads-drafts.js): edit on the page, ask the model to
 *      change them, compose the creative, schedule, launch.
 * The old monthly organic review (js/ceo-social-organic.js) sits behind the
 * "Organic posts" switch, untouched.
 *
 * Registers window.loadSocialTab() for the master-tab switcher. #panel-social
 * is persistent; this module scaffolds it ONCE and only ever repaints
 * #soc-ads-root, so the drafts editor (its own root) keeps unsaved edits.
 * ========================================================================== */
(function () {
  'use strict';

  var A = window.ATS || {};
  var esc = A.esc || function (s) { return String(s == null ? '' : s); };

  var state = {
    view: 'ads', data: null, loading: false, loadedAt: 0, busy: {},
    scaffolded: false, showPaused: false, health: null
  };
  var panelWired = false;
  var ADS_MANAGER = 'https://adsmanager.facebook.com/adsmanager/manage/ads?act=';

  function panel() { return document.getElementById('panel-social'); }
  function adsRoot() { return document.getElementById('soc-ads-root'); }

  // ── formatting ───────────────────────────────────────────────────────────
  function money(v, dp) {
    if (v === null || v === undefined || v === '' || !isFinite(Number(v))) return '—';
    var n = Number(v);
    return 'A$' + n.toLocaleString('en-AU', { minimumFractionDigits: dp == null ? 2 : dp, maximumFractionDigits: dp == null ? 2 : dp });
  }
  function int(v) { return (v === null || v === undefined || !isFinite(Number(v))) ? '—' : Number(v).toLocaleString('en-AU'); }
  function pct(v, dp) { return (v === null || v === undefined || !isFinite(Number(v))) ? '—' : Number(v).toFixed(dp == null ? 1 : dp) + '%'; }
  function num(v, dp) { return (v === null || v === undefined || !isFinite(Number(v))) ? '—' : Number(v).toFixed(dp == null ? 2 : dp); }
  // Change badge. `goodWhen` says which direction is good news (cost: down).
  function delta(p, goodWhen, label) {
    if (p === null || p === undefined || !isFinite(Number(p))) return '';
    var n = Number(p);
    if (n === 0) return '<span class="ad-delta flat">no change' + (label ? ' ' + esc(label) : '') + '</span>';
    var good = goodWhen === 'down' ? n < 0 : goodWhen === 'up' ? n > 0 : null;
    var cls = good === null ? 'flat' : (good ? 'good' : 'bad');
    return '<span class="ad-delta ' + cls + '">' + (n > 0 ? '▲' : '▼') + ' ' + Math.abs(n) + '%' + (label ? ' ' + esc(label) : '') + '</span>';
  }
  function when(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
    catch (e) { return String(iso); }
  }
  function dayLabel(ymd) {
    try { var p = String(ymd).split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' }); }
    catch (e) { return String(ymd); }
  }
  function pill(text, mod) { return '<span class="ats-pill ' + esc(mod || 'muted') + '">' + esc(text) + '</span>'; }
  function verdictMod(v) { return v === 'keep' ? 'green' : v === 'scale' ? 'blue' : v === 'pause' ? 'red' : v === 'watch' ? 'amber' : 'muted'; }
  function statusMod(s) { return s === 'ACTIVE' ? 'green' : (s === 'PENDING_REVIEW' || s === 'IN_PROCESS') ? 'amber' : (s === 'WITH_ISSUES' || s === 'DISAPPROVED') ? 'red' : 'muted'; }
  function statusLabel(s) {
    return ({ ACTIVE: 'Live', PAUSED: 'Paused', ADSET_PAUSED: 'Ad set paused', CAMPAIGN_PAUSED: 'Campaign paused', PENDING_REVIEW: 'In review', WITH_ISSUES: 'Has issues', DISAPPROVED: 'Disapproved', ARCHIVED: 'Archived', DELETED: 'Deleted', IN_PROCESS: 'Processing' })[s] || String(s || '—');
  }

  // ── scaffold + view switch ───────────────────────────────────────────────
  function scaffold() {
    var p = panel();
    if (!p) return false;
    if (!state.scaffolded || !document.getElementById('soc-ads-root')) {
      p.innerHTML = '<div class="soc-shell">' +
        '<div class="soc-switch" role="tablist">' +
          '<button type="button" class="soc-switch-btn active" data-view="ads" role="tab">Ads</button>' +
          '<button type="button" class="soc-switch-btn" data-view="organic" role="tab">Organic posts</button>' +
        '</div>' +
        '<div id="soc-ads-root"></div>' +
        '<div id="soc-organic-root" style="display:none"></div>' +
      '</div>';
      state.scaffolded = true;
    }
    if (!panelWired) {
      panelWired = true;
      p.addEventListener('click', onClick);
    }
    return true;
  }

  function setView(v) {
    state.view = v === 'organic' ? 'organic' : 'ads';
    var p = panel();
    if (!p) return;
    var btns = p.querySelectorAll('.soc-switch-btn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].getAttribute('data-view') === state.view);
    var ar = document.getElementById('soc-ads-root');
    var orr = document.getElementById('soc-organic-root');
    if (ar) ar.style.display = state.view === 'ads' ? '' : 'none';
    if (orr) orr.style.display = state.view === 'organic' ? '' : 'none';
    if (state.view === 'organic') {
      if (typeof window.loadSocialOrganicView === 'function') window.loadSocialOrganicView({ quiet: true });
    } else if (!state.data && !state.loading) {
      load();
    }
  }

  // ── rendering ────────────────────────────────────────────────────────────
  function render() {
    try { renderInner(); } catch (err) {
      var root = adsRoot();
      if (root) {
        root.innerHTML = '<div class="content" style="padding:32px"><div class="soc-warn"><strong>The Ads view hit an error while drawing.</strong><br>' +
          esc(String((err && err.message) || err)) + '<br><br>The data loaded fine, so this is a display problem. Send this message over and it can be fixed directly.</div></div>';
      }
      try { console.error('[social/ads] render failed', err); } catch (e2) { /* ignore */ }
    }
  }

  function renderInner() {
    var root = adsRoot();
    if (!root) return;
    if (state.loading && !state.data) { root.innerHTML = A.loadingHtml ? A.loadingHtml('Loading the campaign…') : '<div class="content">Loading…</div>'; return; }
    var d = state.data;
    if (!d) { root.innerHTML = '<div class="content" style="padding:32px"><div class="soc-warn">Nothing loaded yet.</div></div>'; return; }
    var s = d.snapshot || {};
    var review = d.review && d.review.review ? d.review.review : null;

    // The drafts editor owns #soc-drafts-root. Keep the node across repaints so
    // an unsaved edit survives a numbers refresh.
    var keep = document.getElementById('soc-drafts-root');

    var html = '<div class="content" style="padding:20px 24px 60px">';
    html += header(d, s);
    html += banners(d, s);
    html += summarySection(d, s, review);
    html += liveSection(d, s, review);
    html += improvementsSection(d, review);
    html += '<div id="soc-drafts-slot"></div>';
    html += '</div>';
    root.innerHTML = html;

    var slot = document.getElementById('soc-drafts-slot');
    if (slot) {
      if (keep) slot.parentNode.replaceChild(keep, slot);
      else { keep = document.createElement('div'); keep.id = 'soc-drafts-root'; slot.parentNode.replaceChild(keep, slot); }
    }
    if (window.AdsDrafts && typeof window.AdsDrafts.render === 'function') window.AdsDrafts.render(d);
  }

  function header(d, s) {
    var src = d.snapshot_source;
    var srcLabel = src === 'live' ? 'live from Meta' : src === 'stored' ? 'from the last run' : src === 'funnel_only' ? 'app data only' : src === 'error' ? 'Meta read failed' : '';
    var conn = d.configured
      ? (src === 'error' ? pill('Meta: read failed', 'red') : pill('Meta connected', 'green'))
      : pill('Meta not connected', 'red');
    return '<div class="soc-head">' +
      '<div><h2 class="soc-title">Ads</h2>' +
        '<div class="soc-sub">Meta campaign · ' + (s.live_ads || 0) + ' live ad' + (s.live_ads === 1 ? '' : 's') +
          (d.snapshot_at ? ' · numbers as of ' + esc(when(d.snapshot_at)) + (srcLabel ? ' (' + esc(srcLabel) + ')' : '') : '') + '</div></div>' +
      '<div class="soc-head-actions">' + conn +
        '<button type="button" class="soc-btn" data-act="health" title="Check what the Meta token can read and create">Check connection</button>' +
        '<button type="button" class="soc-btn" data-act="refresh"' + (state.busy.refresh ? ' disabled' : '') + '>' + (state.busy.refresh ? 'Refreshing…' : 'Refresh numbers') + '</button>' +
        '<button type="button" class="btn-primary" data-act="review"' + (state.busy.review || !d.anthropic_configured ? ' disabled' : '') +
          ' title="Pull live numbers and have the model write today\'s review now (takes a minute or two)">' +
          (state.busy.review ? 'Reviewing… (1–2 min)' : 'Run review now') + '</button>' +
      '</div></div>';
  }

  function banners(d, s) {
    var out = '';
    if (!d.configured) {
      out += '<div class="soc-warn"><strong>Meta is not connected, so this page shows the app\'s own lead funnel only.</strong> ' +
        'To see spend, leads and creatives, add <code>META_ADS_ACCESS_TOKEN</code> in Vercel: Business Settings → System Users → the GP Link system user → ' +
        'assign the ad account (' + esc(d.defaults.account_id) + ') and the Page, then Generate token with <code>ads_read</code>, <code>ads_management</code>, <code>pages_manage_ads</code>. ' +
        'Reading needs ads_read; launching ads from this page needs the other two. Redeploy is not required — the next load picks it up.</div>';
    } else if (d.snapshot_source === 'error') {
      out += '<div class="soc-warn"><strong>Meta refused the read.</strong> ' + esc((d.problems || []).join(' ')) +
        (d.credential_error ? ' The token looks invalid or expired — re-mint it as a System User token.' : '') +
        (d.permission_error ? ' The token lacks ads_read on this ad account.' : '') + '</div>';
    } else if (d.problems && d.problems.length) {
      out += '<div class="soc-note"><strong>Some numbers are missing.</strong> ' + esc(d.problems.join(' ')) + '</div>';
    }
    if ((s.errors || []).length && d.snapshot_source === 'stored') {
      out += '<div class="soc-note"><strong>The last run had gaps:</strong> ' + esc(s.errors.join(' ')) + '</div>';
    }
    if (!d.anthropic_configured) out += '<div class="soc-warn"><strong>ANTHROPIC_API_KEY is not set</strong>, so no review or new ads can be written.</div>';
    if (d.launch_disabled) out += '<div class="soc-note"><strong>Launching is switched off</strong> (ADS_LAUNCH_DISABLED). Drafts can be scheduled but nothing is created on Meta.</div>';
    if (state.health) out += healthPanel(state.health);
    return out;
  }

  function healthPanel(h) {
    var rows = (h.checks || []).map(function (c) {
      var mark = c.ok === true ? '✓' : c.ok === false ? '✕' : '?';
      var cls = c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'unknown';
      return '<li class="' + cls + '"><b>' + mark + '</b> ' + esc(c.detail) + '</li>';
    }).join('');
    return '<div class="ad-health"><div class="ad-health-head"><strong>Connection check</strong>' +
      (h.token_source ? '<span class="soc-when">token from ' + esc(h.token_source) + '</span>' : '') +
      '<button type="button" class="soc-btn" data-act="health-close">Close</button></div><ul>' + rows + '</ul></div>';
  }

  // ── 1. today's summary ───────────────────────────────────────────────────
  function tile(label, value, extra, title) {
    return '<div class="ad-kpi"' + (title ? ' title="' + esc(title) + '"' : '') + '><span class="ad-kpi-label">' + esc(label) + '</span>' +
      '<b class="ad-kpi-value">' + value + '</b>' + (extra ? '<span class="ad-kpi-extra">' + extra + '</span>' : '') + '</div>';
  }

  function summarySection(d, s, review) {
    var t = s.totals || {};
    var y = t.yesterday || {};
    var w = t.last_7d || {};
    var wow = t.week_on_week || {};
    var yva = t.yesterday_vs_avg || {};
    var f = s.funnel || {};
    var f7 = f.d7 || {};
    var f30 = f.d30 || {};
    var r = d.review || null;

    var html = '<section class="ad-card ad-summary"><div class="ad-card-head"><h3>Today\'s summary</h3>' +
      '<span class="ad-meta">' + (r
        ? esc((r.kind === 'daily' ? 'Morning review' : 'Review') + ' · ' + when(r.created_at) + ' · ' + (r.model || ''))
        : (d.last_run && d.last_run.error ? 'Last attempt failed · ' + esc(when(d.last_run.created_at)) : 'No review yet')) + '</span></div>';

    if (d.configured && d.snapshot_source !== 'funnel_only') {
      html += '<div class="ad-kpi-row"><div class="ad-kpi-group-label">Yesterday</div>' +
        tile('Spend', money(y.spend), delta(yva.spend, null, 'vs 7-day avg'), 'Average of the last 7 days: ' + money(yva.avg_spend)) +
        tile('Leads', int(y.leads), delta(yva.leads, 'up', 'vs 7-day avg'), 'Average of the last 7 days: ' + num(yva.avg_leads, 1)) +
        tile('Cost per lead', money(y.cost_per_lead)) +
        tile('Link clicks', int(y.link_clicks)) +
      '</div>';
      html += '<div class="ad-kpi-row"><div class="ad-kpi-group-label">Last 7 days</div>' +
        tile('Spend', money(w.spend), delta(wow.spend, null, 'vs week before')) +
        tile('Leads (Meta)', int(w.leads), delta(wow.leads, 'up', 'vs week before')) +
        tile('Cost per lead', money(w.cost_per_lead), delta(wow.cost_per_lead, 'down', 'vs week before')) +
        tile('Booked calls (app)', int(f7.booked), f7.leads ? '<span class="ad-kpi-extra">' + int(f7.leads) + ' leads reached the app</span>' : '') +
        tile('Cost per booking', money(f7.cost_per_booking), '', 'Spend ÷ bookings, last 7 days. The number that decides which ads stay.') +
        tile('Frequency', num(w.frequency), (Number(w.frequency) > 3 ? '<span class="ad-delta bad">above the 3.0 rule</span>' : ''), 'Average times each person saw an ad in 7 days') +
      '</div>';
      html += '<div class="ad-kpi-row"><div class="ad-kpi-group-label">Last 30 days</div>' +
        tile('Spend', money((t.last_30d || {}).spend)) +
        tile('Leads (Meta)', int((t.last_30d || {}).leads)) +
        tile('Cost per lead', money((t.last_30d || {}).cost_per_lead)) +
        tile('Booked calls (app)', int(f30.booked)) +
        tile('Cost per booking', money(f30.cost_per_booking)) +
        tile('Signed up', int(f30.signed_up)) +
      '</div>';
      html += sparkline(s.daily || []);
    } else {
      html += '<div class="ad-kpi-row"><div class="ad-kpi-group-label">App funnel (Meta leads)</div>' +
        tile('Leads, 7 days', int(f7.leads)) + tile('Booked, 7 days', int(f7.booked)) +
        tile('Leads, 30 days', int(f30.leads)) + tile('Booked, 30 days', int(f30.booked)) + tile('Signed up, 30 days', int(f30.signed_up)) +
      '</div>';
    }

    if (review) {
      html += '<div class="ad-review">' +
        (review.headline ? '<p class="ad-review-headline">' + esc(review.headline) + '</p>' : '') +
        (review.summary ? '<p class="ad-review-summary">' + esc(review.summary).replace(/\n+/g, '<br>') + '</p>' : '') +
        ((review.actions_today || []).length ? '<div class="ad-actions"><h4>What to do today</h4><ol>' +
          review.actions_today.map(function (a) {
            return '<li><strong>' + esc(a.action) + '</strong>' + whereBadge(a.where) + (a.why ? '<div class="ad-why">' + esc(a.why) + '</div>' : '') + '</li>';
          }).join('') + '</ol></div>' : '') +
      '</div>';
    } else if (d.last_run && d.last_run.error) {
      html += '<div class="soc-note"><strong>The last review could not be written.</strong> ' + esc(d.last_run.error) + '</div>';
    } else {
      html += '<div class="soc-note">No review has run yet. The morning cron writes one every day at 08:30 Melbourne time; click <strong>Run review now</strong> to get the first one.</div>';
    }
    return html + '</section>';
  }

  function whereBadge(w) {
    var map = { ads_manager: ['In Ads Manager', 'amber'], this_page: ['On this page', 'blue'], follow_up: ['Follow-up', 'purple'] };
    var m = map[w];
    return m ? ' ' + pill(m[0], m[1]) : '';
  }

  // Spend bars + leads dots, 14 days, inline SVG so there is no library to load.
  function sparkline(daily) {
    if (!daily.length) return '';
    var Wd = 600, Hd = 120, padL = 36, padR = 12, top = 12, bottom = 26;
    var innerW = Wd - padL - padR, innerH = Hd - top - bottom;
    var maxSpend = Math.max.apply(null, daily.map(function (x) { return Number(x.spend) || 0; }).concat([1]));
    var maxLeads = Math.max.apply(null, daily.map(function (x) { return Number(x.leads) || 0; }).concat([1]));
    var n = daily.length;
    var slot = innerW / n;
    var bars = '', dots = '', path = '';
    daily.forEach(function (x, i) {
      var bh = (Number(x.spend) || 0) / maxSpend * innerH;
      var bx = padL + i * slot + slot * 0.15;
      bars += '<rect x="' + bx.toFixed(1) + '" y="' + (top + innerH - bh).toFixed(1) + '" width="' + (slot * 0.7).toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="2" class="ad-spark-bar"><title>' + esc(dayLabel(x.date)) + ': ' + esc(money(x.spend)) + ', ' + esc(int(x.leads)) + ' leads</title></rect>';
      var cx = padL + i * slot + slot / 2;
      var cy = top + innerH - (Number(x.leads) || 0) / maxLeads * innerH;
      path += (i ? ' L' : 'M') + cx.toFixed(1) + ' ' + cy.toFixed(1);
      dots += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="3" class="ad-spark-dot"><title>' + esc(dayLabel(x.date)) + ': ' + esc(int(x.leads)) + ' leads</title></circle>';
    });
    return '<div class="ad-spark"><svg viewBox="0 0 ' + Wd + ' ' + Hd + '" preserveAspectRatio="none" aria-label="Daily spend and leads, last 14 days">' +
      bars + '<path d="' + path + '" class="ad-spark-line"/>' + dots +
      '<text x="' + padL + '" y="' + (Hd - 8) + '" class="ad-spark-label">' + esc(dayLabel(daily[0].date)) + '</text>' +
      '<text x="' + (Wd - padR) + '" y="' + (Hd - 8) + '" class="ad-spark-label" text-anchor="end">' + esc(dayLabel(daily[n - 1].date)) + '</text>' +
      '<text x="4" y="' + (top + 10) + '" class="ad-spark-label">' + esc(money(maxSpend, 0)) + '</text>' +
      '</svg><div class="ad-spark-legend"><span><i class="bar"></i> spend per day</span><span><i class="dot"></i> leads per day</span></div></div>';
  }

  // ── 2. live creatives ────────────────────────────────────────────────────
  function liveSection(d, s, review) {
    var ads = s.ads || [];
    if (!d.configured || !ads.length) {
      return '<section class="ad-card"><div class="ad-card-head"><h3>Creatives running now</h3></div>' +
        '<div class="ats-empty">' + (d.configured ? 'No ads were returned for the campaign.' : 'Connect Meta to see the live creatives.') + '</div></section>';
    }
    var verdicts = {};
    ((review && review.ad_verdicts) || []).forEach(function (v) { verdicts[String(v.ad_id)] = v; });
    var live = ads.filter(function (a) { return a.effective_status === 'ACTIVE'; });
    var rest = ads.filter(function (a) { return a.effective_status !== 'ACTIVE'; });
    var html = '<section class="ad-card"><div class="ad-card-head"><h3>Creatives running now <span class="ats-count-chip">' + live.length + '</span></h3>' +
      '<span class="ad-meta">' + (s.adsets || []).filter(function (x) { return x.effective_status === 'ACTIVE'; }).map(function (x) {
        return esc(x.name) + ' · ' + money(x.daily_budget, 0) + '/day · ' + esc(goalLabel(x.optimization_goal));
      }).join(' · ') + '</span></div>';
    html += '<div class="ad-live-grid">' + live.map(function (a) { return liveCard(a, verdicts[a.id], d); }).join('') + '</div>';
    if (rest.length) {
      html += '<div class="ad-paused-toggle"><button type="button" class="soc-btn" data-act="toggle-paused">' +
        (state.showPaused ? 'Hide' : 'Show') + ' ' + rest.length + ' paused / other ad' + (rest.length === 1 ? '' : 's') + '</button></div>';
      if (state.showPaused) html += '<div class="ad-live-grid is-paused">' + rest.map(function (a) { return liveCard(a, verdicts[a.id], d); }).join('') + '</div>';
    }
    return html + '</section>';
  }

  function goalLabel(g) { return ({ QUALITY_LEAD: 'qualified-leads goal', LEAD_GENERATION: 'leads goal', LINK_CLICKS: 'link-clicks goal' })[g] || String(g || '').toLowerCase().replace(/_/g, ' '); }

  function metricRow(label, a, fmt) {
    var m = a.metrics || {};
    return '<tr><th>' + esc(label) + '</th><td>' + fmt(m.yesterday || {}) + '</td><td>' + fmt(m.last_7d || {}) + '</td><td>' + fmt(m.last_30d || {}) + '</td></tr>';
  }

  function liveCard(a, verdict, d) {
    var c = a.creative || {};
    var f30 = (a.funnel && a.funnel.d30) || {};
    var f7 = (a.funnel && a.funnel.d7) || {};
    var flags = a.flags || [];
    var img = c.image_url
      ? '<img loading="lazy" src="' + esc(c.image_url) + '" alt="" onerror="this.style.display=\'none\'; this.parentNode.classList.add(\'no-img\')">'
      : '';
    return '<article class="ad-live-card" data-ad="' + esc(a.id) + '">' +
      '<div class="ad-live-img' + (img ? '' : ' no-img') + '">' + img +
        '<div class="ad-live-img-fallback"><span>' + esc(c.headline || a.name) + '</span></div>' +
        (verdict ? '<span class="ad-verdict ats-pill ' + verdictMod(verdict.verdict) + '">' + esc(verdict.verdict) + '</span>' : '') +
      '</div>' +
      '<div class="ad-live-body">' +
        '<div class="ad-live-title">' + esc(c.headline || a.name) + '</div>' +
        '<div class="ad-live-sub">' + pill(statusLabel(a.effective_status), statusMod(a.effective_status)) + ' ' + esc(a.name) +
          (a.days_live !== null && a.days_live !== undefined ? ' · live ' + a.days_live + ' day' + (a.days_live === 1 ? '' : 's') : '') +
          (c.cta_label ? ' · ' + esc(c.cta_label) : '') + '</div>' +
        '<table class="ad-metrics"><thead><tr><th></th><th>Yest.</th><th>7 days</th><th>30 days</th></tr></thead><tbody>' +
          metricRow('Spend', a, function (m) { return money(m.spend, 0); }) +
          metricRow('Leads', a, function (m) { return int(m.leads); }) +
          metricRow('Cost per lead', a, function (m) { return money(m.cost_per_lead, 0); }) +
          metricRow('Link clicks', a, function (m) { return int(m.link_clicks); }) +
          metricRow('Click → lead', a, function (m) { return pct(m.click_to_lead_pct); }) +
          metricRow('Frequency', a, function (m) { return num(m.frequency, 1); }) +
        '</tbody></table>' +
        '<div class="ad-funnel"><strong>App, 30 days:</strong> ' + int(f30.leads) + ' lead' + (f30.leads === 1 ? '' : 's') + ' · ' + int(f30.booked) + ' booked · cost per booking ' + money(f30.cost_per_booking, 0) +
          (f7.leads ? '<span class="soc-when"> (7 days: ' + int(f7.leads) + ' lead' + (f7.leads === 1 ? '' : 's') + ', ' + int(f7.booked) + ' booked)</span>' : '') + '</div>' +
        (flags.length ? '<ul class="ad-flags">' + flags.map(function (fl) { return '<li class="' + esc(fl.level) + '">' + esc(fl.label) + '</li>'; }).join('') + '</ul>' : '') +
        (verdict ? '<div class="ad-verdict-reason"><strong>' + esc(verdict.verdict) + ':</strong> ' + esc(verdict.reason) + '</div>' : '') +
        '<details class="ad-copy"><summary>Copy</summary>' +
          '<div class="ad-copy-text">' + esc(c.primary_text || '').replace(/\n/g, '<br>') + '</div>' +
          (c.description ? '<div class="soc-when">Description: ' + esc(c.description) + '</div>' : '') +
          '<div class="soc-when"><a href="' + esc(ADS_MANAGER + d.defaults.account_id + '&selected_ad_ids=' + a.id) + '" target="_blank" rel="noopener">Open in Ads Manager ↗</a></div>' +
        '</details>' +
      '</div></article>';
  }

  // ── 3. improvements ──────────────────────────────────────────────────────
  function improvementsSection(d, review) {
    var imps = (review && review.improvements) || [];
    var html = '<section class="ad-card ad-improve"><div class="ad-card-head"><h3>Suggested improvements</h3>' +
      '<span class="ad-meta">' + (imps.length ? 'From this morning\'s review. Tick the ones to build into the next ads.' : '') + '</span></div>';
    if (!imps.length) {
      html += '<div class="ats-empty">' + (review ? 'The review listed no improvements.' : 'Run a review to get improvements.') + '</div>';
    } else {
      html += '<ul class="ad-imps">' + imps.map(function (x) {
        return '<li class="ad-imp"><label><input type="checkbox" class="ad-imp-check" value="' + esc(x.id) + '" checked>' +
          '<span class="ad-imp-body"><span class="ad-imp-title">' + esc(x.title) + ' ' + pill(x.applies_to.replace('_', ' '), 'blue') +
          (x.priority === 1 ? ' ' + pill('do first', 'red') : '') + '</span>' +
          '<span class="ad-imp-change">' + esc(x.change) + '</span>' +
          (x.evidence ? '<span class="ad-imp-evidence">Evidence: ' + esc(x.evidence) + '</span>' : '') +
          '</span></label></li>';
      }).join('') + '</ul>';
    }
    html += '<div class="ad-generate">' +
      '<label>Write <select id="adGenCount" class="soc-select"><option>2</option><option selected>3</option><option>4</option></select> new ads</label>' +
      '<input type="text" id="adGenInstr" class="ad-input" placeholder="Optional steer, e.g. “two after-led angles, one about eConsults”" maxlength="400">' +
      '<button type="button" class="btn-primary" data-act="generate"' + (state.busy.generate || !d.anthropic_configured ? ' disabled' : '') + '>' +
        (state.busy.generate ? 'Writing… (about a minute)' : 'Generate new ads') + '</button>' +
      '<span class="soc-when">The model writes complete ads (image line, headline, three paragraphs, photo brief) applying the ticked improvements. They land below as drafts for you to edit.</span>' +
    '</div>';
    return html + '</section>';
  }

  // ── actions ──────────────────────────────────────────────────────────────
  function onClick(e) {
    var sw = e.target.closest ? e.target.closest('.soc-switch-btn[data-view]') : null;
    if (sw) { setView(sw.getAttribute('data-view')); return; }
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    // The drafts board handles its own buttons (inside #soc-drafts-root).
    if (btn.closest('#soc-drafts-root')) return;
    var act = btn.getAttribute('data-act');
    if (act === 'refresh') return refresh();
    if (act === 'review') return runReview();
    if (act === 'generate') return generate();
    if (act === 'toggle-paused') { state.showPaused = !state.showPaused; render(); return; }
    if (act === 'health') return health();
    if (act === 'health-close') { state.health = null; render(); return; }
  }

  function refresh() {
    if (state.busy.refresh) return;
    state.busy.refresh = true; render();
    A.api('/api/ceo/ads/refresh', { method: 'POST', body: {} }).then(function (d) {
      state.busy.refresh = false;
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not refresh.', 'error'); return load(); }
      state.data = d; state.loadedAt = Date.now(); render();
      A.toast(d.snapshot_source === 'live' ? 'Numbers refreshed from Meta.' : 'Refreshed.');
    });
  }

  function runReview() {
    if (state.busy.review) return;
    state.busy.review = true; render();
    A.toast('Pulling live numbers and asking the model… this takes a minute or two.');
    A.api('/api/ceo/ads/review', { method: 'POST', body: {} }).then(function (d) {
      state.busy.review = false;
      if (!d) { A.toast('No answer from the server.', 'error'); return load(true); }
      if (!d.ok) A.toast(d.message || 'The review could not be written.', 'error');
      else A.toast('Review written.');
      return load(true);
    });
  }

  function generate() {
    if (state.busy.generate) return;
    var ids = [];
    var boxes = document.querySelectorAll('#soc-ads-root .ad-imp-check:checked');
    for (var i = 0; i < boxes.length; i++) ids.push(boxes[i].value);
    var count = Number((document.getElementById('adGenCount') || {}).value) || 3;
    var instr = String((document.getElementById('adGenInstr') || {}).value || '').trim();
    if (!ids.length && !instr && !window.confirm('No improvements are ticked and no steer is given. Write ' + count + ' ads from the account rules alone?')) return;
    state.busy.generate = true; render();
    A.toast('Writing ' + count + ' ads… about a minute.');
    A.api('/api/ceo/ads/drafts/generate', { method: 'POST', body: { count: count, improvement_ids: ids, instructions: instr } }).then(function (d) {
      state.busy.generate = false;
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not write the ads.', 'error'); render(); return; }
      A.toast(d.drafts.length + ' new ad' + (d.drafts.length === 1 ? '' : 's') + ' drafted. Scroll down to edit them.');
      return load(true).then(function () {
        var el = document.getElementById('soc-drafts-root');
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function health() {
    A.toast('Checking the Meta connection…');
    A.api('/api/ceo/ads/health').then(function (d) {
      if (!d || !d.ok) { A.toast('Could not run the check.', 'error'); return; }
      state.health = d; render();
    });
  }

  // ── data ─────────────────────────────────────────────────────────────────
  function load(quiet) {
    state.loading = !quiet;
    if (!quiet) render();
    return A.api('/api/ceo/ads').then(function (d) {
      state.loading = false;
      if (!d || !d.ok) {
        var root = adsRoot();
        if (root) root.innerHTML = '<div class="content" style="padding:32px"><div class="soc-warn">' + esc((d && d.message) || 'Could not load the ads page.') +
          (d && d.status ? ' (HTTP ' + esc(d.status) + ')' : '') + '</div></div>';
        return;
      }
      state.data = d; state.loadedAt = Date.now();
      render();
    }).catch(function (err) {
      state.loading = false;
      var root = adsRoot();
      if (root) root.innerHTML = '<div class="content" style="padding:32px"><div class="soc-warn"><strong>Could not reach the server.</strong><br>' + esc(String((err && err.message) || err)) + '</div></div>';
    });
  }

  // Exposed for the drafts board: it only ever needs the shared payload bits.
  window.AdsHub = {
    reload: function () { return load(true); },
    data: function () { return state.data; },
    money: money, when: when, pill: pill
  };

  window.loadSocialTab = function (opts) {
    var o = opts || {};
    if (!scaffold()) return;
    if (state.view === 'organic') { setView('organic'); return; }
    if (o.quiet && state.data && (Date.now() - state.loadedAt) < 5 * 60000) { render(); return; }
    load(!!(o.quiet && state.data));
  };
})();

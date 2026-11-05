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
 *   3. Changes to make on Meta: the review's account_changes (pause or
 *      resume an ad or ad set, change a daily budget, launch a ready draft,
 *      create a new ad from one of the review's briefs), each with a tick
 *      box; Submit applies the ticked ones through the API
 *      (POST /api/ceo/ads/changes/apply) and shows what happened to each. A
 *      new ad is "in progress" until its photo lands and the drafts board
 *      composes the creative; the save then launches it by itself.
 *   4. The model's suggested improvements, with "Generate N new ads" that
 *      writes new ads applying the ticked ones.
 *   5. New ads (js/ceo-ads-drafts.js): edit on the page, ask the model to
 *      change them, compose the creative, schedule, launch.
 * The old monthly organic review (js/ceo-social-organic.js) sits behind the
 * "Organic posts" switch, untouched.
 *
 * Registers window.loadSocialTab() for the master-tab switcher. #panel-social
 * is persistent; this module scaffolds it ONCE and only ever repaints
 * #soc-hub-root, so the drafts editor (its own root) keeps unsaved edits.
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
  function adsRoot() { return document.getElementById('soc-hub-root'); }

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
    if (n === 0) return '<span class="mk-delta flat">no change' + (label ? ' ' + esc(label) : '') + '</span>';
    var good = goodWhen === 'down' ? n < 0 : goodWhen === 'up' ? n > 0 : null;
    var cls = good === null ? 'flat' : (good ? 'good' : 'bad');
    return '<span class="mk-delta ' + cls + '">' + (n > 0 ? '▲' : '▼') + ' ' + Math.abs(n) + '%' + (label ? ' ' + esc(label) : '') + '</span>';
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

  // Rotation (from lib/meta-ads): live = delivering now; scheduled_off = the
  // owner's time rule has the ad set off right now and brings it back by
  // itself. Both count as "running". A rule only changes the ad set it
  // targets, so an ad paused by hand stays paused whatever the rule does.
  function rotationOf(a) { return (a && a.rotation) || (a && a.effective_status === 'ACTIVE' ? 'live' : 'other'); }
  function inRotation(a) { var r = rotationOf(a); return r === 'live' || r === 'scheduled_off'; }
  // A stored snapshot re-read against the clock keeps Meta's effective_status
  // from the night it was fetched, so the pill follows rotation first.
  function rotationLabel(a) {
    var r = rotationOf(a);
    if (r === 'live') return 'Live';
    if (r === 'scheduled_off') return 'Off by rule';
    if (r === 'paused') return 'Paused';
    return statusLabel(a.effective_status);
  }
  function rotationMod(a) {
    var r = rotationOf(a);
    return r === 'live' ? 'green' : r === 'scheduled_off' ? 'blue' : statusMod(a.effective_status);
  }

  function clockIn(iso, tz) {
    try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)); }
    catch (e) { return ''; }
  }
  function weekdayIn(iso, tz) {
    try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(new Date(iso)); }
    catch (e) { return ''; }
  }
  function tzCity(tz) { var p = String(tz || '').split('/').pop().replace(/_/g, ' '); return p === 'London' ? 'UK' : p; }
  // '07:30 UK (18:30 Sydney)', with the weekday when it is more than a day away.
  function clockPair(iso, d) {
    var t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    var acct = (d && d.account_time_zone) || 'Australia/Sydney';
    var out = clockIn(iso, 'Europe/London') + ' UK';
    if (acct !== 'Europe/London') out += ' (' + clockIn(iso, acct) + ' ' + tzCity(acct) + ')';
    if (t - Date.now() > 20 * 3600000) out = weekdayIn(iso, 'Europe/London') + ' ' + out;
    return out;
  }
  function rotationSummary(s, d) {
    var rot = s.rotation_ads !== undefined && s.rotation_ads !== null ? s.rotation_ads : (s.live_ads || 0);
    var sc = s.schedule && s.schedule.managed ? s.schedule : null;
    var text = rot + ' ad' + (rot === 1 ? '' : 's') + ' in rotation';
    if (sc && sc.state === 'off' && sc.on_rule && sc.on_rule.at) text += ' · ad set off by rule until ' + esc(clockPair(sc.on_rule.at, d));
    else if (sc && sc.state === 'on' && sc.off_rule && sc.off_rule.at) text += ' · live now, off by rule at ' + esc(clockPair(sc.off_rule.at, d));
    return text;
  }
  function scheduleLine(s, d) {
    var sc = s.schedule && s.schedule.managed ? s.schedule : null;
    if (!sc) return '';
    var name = '\u201c' + esc(sc.adset_name || 'The ad set') + '\u201d';
    var on = sc.on_rule, off = sc.off_rule;
    var note = ' An ad you pause yourself stays paused when the rule turns the ad set back on: the rule only changes the ad set.';
    var body = '';
    if (sc.state === 'off' && on && on.at) {
      body = pill('Off by rule', 'blue') + '<span>' + name + ' is switched off right now' + (off ? ' by the rule \u201c' + esc(off.name) + '\u201d' : '') +
        ' and comes back on at <strong>' + esc(clockPair(on.at, d)) + '</strong> (rule \u201c' + esc(on.name) + '\u201d). Its ads are in rotation and counted above.' + note + '</span>';
    } else if (sc.state === 'on') {
      body = pill('Live now', 'green') + '<span>' + name + ' is on' + (on ? ' by the rule \u201c' + esc(on.name) + '\u201d' : '') +
        (off && off.at ? '; \u201c' + esc(off.name) + '\u201d switches it off at <strong>' + esc(clockPair(off.at, d)) + '</strong>.' : '.') + note + '</span>';
    } else if (on && on.at) {
      body = pill('Paused by hand', 'amber') + '<span>' + name + ' is paused, but the rule \u201c' + esc(on.name) + '\u201d will switch it back on at <strong>' + esc(clockPair(on.at, d)) +
        '</strong>. To keep it off, pause the ads inside it or switch the rule off in Ads Manager.</span>';
    }
    return body ? '<div class="mk-schedule">' + body + '</div>' : '';
  }

  // ── scaffold + view switch ───────────────────────────────────────────────
  function scaffold() {
    var p = panel();
    if (!p) return false;
    if (!state.scaffolded || !document.getElementById('soc-hub-root')) {
      p.innerHTML = '<div class="soc-shell">' +
        '<div class="soc-switch" role="tablist">' +
          '<button type="button" class="soc-switch-btn active" data-view="ads" role="tab">Ads</button>' +
          '<button type="button" class="soc-switch-btn" data-view="organic" role="tab">Organic posts</button>' +
        '</div>' +
        '<div id="soc-hub-root"></div>' +
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
    var ar = document.getElementById('soc-hub-root');
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
    html += changesSection(d, s, review);
    html += improvementsSection(d, review);
    html += '<div id="soc-drafts-slot"></div>';
    html += '</div>';
    root.innerHTML = html;

    var slot = document.getElementById('soc-drafts-slot');
    if (slot) {
      if (keep) slot.parentNode.replaceChild(keep, slot);
      else { keep = document.createElement('div'); keep.id = 'soc-drafts-root'; slot.parentNode.replaceChild(keep, slot); }
    }
    if (window.AdsRange && typeof window.AdsRange.render === 'function') window.AdsRange.render(d);
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
        '<div class="soc-sub">Meta campaign · ' + rotationSummary(s, d) +
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
      out += '<div class="soc-warn"><strong>Meta refused the read.</strong> ' +
        (d.permission_error
          ? 'The token the app is using (<code>' + esc(d.token_source || 'META_CAPI_ACCESS_TOKEN') + '</code>) cannot read the ad account: it has no <code>ads_read</code> on ad account ' + esc(d.defaults.account_id) + '. ' +
            'Add <code>META_ADS_ACCESS_TOKEN</code> in Vercel (a System User token with ads_read, ads_management and pages_manage_ads, ad account and Page assigned), then redeploy. '
          : '') +
        (d.credential_error ? 'The token looks invalid or expired. Re-mint it as a System User token. ' : '') +
        '<details class="mk-errdetail"><summary>Meta\'s exact wording</summary>' + esc((d.problems || []).join(' ')) + '</details></div>';
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
    return '<div class="mk-health"><div class="mk-health-head"><strong>Connection check</strong>' +
      (h.token_source ? '<span class="soc-when">token from ' + esc(h.token_source) + '</span>' : '') +
      '<button type="button" class="soc-btn" data-act="health-close">Close</button></div><ul>' + rows + '</ul></div>';
  }

  // ── 1. today's summary ───────────────────────────────────────────────────
  function tile(label, value, extra, title) {
    return '<div class="mk-kpi"' + (title ? ' title="' + esc(title) + '"' : '') + '><span class="mk-kpi-label">' + esc(label) + '</span>' +
      '<b class="mk-kpi-value">' + value + '</b>' + (extra ? '<span class="mk-kpi-extra">' + extra + '</span>' : '') + '</div>';
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

    var html = '<section class="mk-card mk-summary"><div class="mk-card-head"><h3>Today\'s summary</h3>' +
      '<span class="mk-meta">' + (r
        ? esc((r.kind === 'daily' ? 'Morning review' : 'Review') + ' · ' + when(r.created_at) + ' · ' + (r.model || ''))
        : (d.last_run && d.last_run.error ? 'Last attempt failed · ' + esc(when(d.last_run.created_at)) : 'No review yet')) + '</span></div>';

    // The Performance card: any date range, daily / weekly / monthly, compared
    // with the period before (js/ceo-ads-range.js owns #soc-range-root).
    html += '<div id="soc-range-root"></div>';
    if (!d.configured || d.snapshot_source === 'funnel_only') {
      html += '<div class="mk-kpi-row"><div class="mk-kpi-group-label">App funnel (Meta leads)</div>' +
        tile('Leads, 7 days', int(f7.leads)) + tile('Booked, 7 days', int(f7.booked)) +
        tile('Leads, 30 days', int(f30.leads)) + tile('Booked, 30 days', int(f30.booked)) + tile('Signed up, 30 days', int(f30.signed_up)) +
      '</div>';
    }

    html += ecosystemStrip(s.ecosystem);
    if (review) {
      html += '<div class="mk-review">' +
        (review.headline ? '<p class="mk-review-headline">' + esc(review.headline) + '</p>' : '') +
        (review.summary ? '<p class="mk-review-summary">' + esc(review.summary).replace(/\n+/g, '<br>') + '</p>' : '') +
        ((review.actions_today || []).length ? '<div class="mk-actions"><h4>What to do today</h4><ol>' +
          review.actions_today.map(function (a) {
            return '<li><strong>' + esc(a.action) + '</strong>' + whereBadge(a.where) + (a.why ? '<div class="mk-why">' + esc(a.why) + '</div>' : '') + '</li>';
          }).join('') + '</ol></div>' : '') +
      '</div>';
    } else if (d.last_run && d.last_run.error) {
      html += '<div class="soc-note"><strong>The last review could not be written.</strong> ' + esc(d.last_run.error) + '</div>';
    } else {
      html += '<div class="soc-note">No review has run yet. The morning cron writes one every day at 08:30 Melbourne time; click <strong>Run review now</strong> to get the first one.</div>';
    }
    return html + '</section>';
  }

  // One line each for what the rest of GP Link did with these leads, so the
  // owner reads the review knowing Hazel and the chase already ran.
  function ecosystemStrip(e) {
    if (!e || !e.funnel_30d) return '';
    var f = e.funnel_30d, hz = e.hazel || {}, nd = e.nudges || {};
    var mins = f.median_hours_to_book === null || f.median_hours_to_book === undefined ? '—' : (f.median_hours_to_book < 1 ? Math.round(f.median_hours_to_book * 60) + ' min' : num(f.median_hours_to_book, 1) + ' h');
    return '<div class="mk-eco"><div class="mk-kpi-group-label">After the form, last 30 days (what the app did by itself)</div><ul>' +
      '<li><strong>Funnel:</strong> ' + int(f.leads) + ' leads → ' + int(f.qualified) + ' qualified → ' + int(f.booked) + ' booked (' + pct(f.booking_rate_pct, 0) + ') → ' + int(f.attended) + ' attended → ' + int(f.signed_up) + ' signed up. Median time to book ' + esc(mins) +
        (f.booked_within_10min_pct !== null && f.booked_within_10min_pct !== undefined ? ', ' + f.booked_within_10min_pct + '% within 10 minutes' : '') + '.</li>' +
      '<li><strong>Hazel (AI caller):</strong> ' + int(hz.calls_30d) + ' calls, spoke to someone on ' + int(hz.spoke_30d) + ', voicemail ' + int(hz.voicemail_30d) + ', no answer ' + int(hz.no_answer_30d) + ', booked on the call ' + int(hz.booked_on_call_30d) + ', callbacks ' + int(hz.callbacks_30d) + ', not interested ' + int(hz.not_interested_30d) + '.</li>' +
      '<li><strong>WhatsApp / email chase:</strong> ' + int(nd.with_whatsapp) + ' of ' + int(nd.leads_30d) + ' leads got WhatsApps, ' + int(nd.with_email) + ' emails, ' + int(nd.replied) + ' replied, owner paged ' + int(nd.owner_paged) + ' times.</li>' +
      ((e.voice_of_lead && e.voice_of_lead.objections && e.voice_of_lead.objections.length) ? '<li><strong>Objections heard:</strong> ' + esc(e.voice_of_lead.objections.map(function (o) { return o.value + ' (' + o.count + ')'; }).join(', ')) + '.</li>' : '') +
      (e.demand && e.demand.open_roles ? '<li><strong>Roles to fill:</strong> ' + int(e.demand.open_roles) + ' open' + (e.demand.by_state && e.demand.by_state.length ? ', mostly ' + esc(e.demand.by_state.slice(0, 3).map(function (x) { return x.value + ' (' + x.count + ')'; }).join(', ')) : '') + '.</li>' : '') +
    '</ul></div>';
  }

  function whereBadge(w) {
    var map = { ads_manager: ['In Ads Manager', 'amber'], this_page: ['On this page', 'blue'], automation: ['Change the automation', 'green'], follow_up: ['Follow-up', 'purple'] };
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
      bars += '<rect x="' + bx.toFixed(1) + '" y="' + (top + innerH - bh).toFixed(1) + '" width="' + (slot * 0.7).toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="2" class="mk-spark-bar"><title>' + esc(dayLabel(x.date)) + ': ' + esc(money(x.spend)) + ', ' + esc(int(x.leads)) + ' leads</title></rect>';
      var cx = padL + i * slot + slot / 2;
      var cy = top + innerH - (Number(x.leads) || 0) / maxLeads * innerH;
      path += (i ? ' L' : 'M') + cx.toFixed(1) + ' ' + cy.toFixed(1);
      dots += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="3" class="mk-spark-dot"><title>' + esc(dayLabel(x.date)) + ': ' + esc(int(x.leads)) + ' leads</title></circle>';
    });
    return '<div class="mk-spark"><svg viewBox="0 0 ' + Wd + ' ' + Hd + '" preserveAspectRatio="none" aria-label="Daily spend and leads, last 14 days">' +
      bars + '<path d="' + path + '" class="mk-spark-line"/>' + dots +
      '<text x="' + padL + '" y="' + (Hd - 8) + '" class="mk-spark-label">' + esc(dayLabel(daily[0].date)) + '</text>' +
      '<text x="' + (Wd - padR) + '" y="' + (Hd - 8) + '" class="mk-spark-label" text-anchor="end">' + esc(dayLabel(daily[n - 1].date)) + '</text>' +
      '<text x="4" y="' + (top + 10) + '" class="mk-spark-label">' + esc(money(maxSpend, 0)) + '</text>' +
      '</svg><div class="mk-spark-legend"><span><i class="bar"></i> spend per day</span><span><i class="dot"></i> leads per day</span></div></div>';
  }

  // ── 2. creatives running ─────────────────────────────────────────────────
  // "Running" = in rotation: delivering now, or switched off for the night by
  // the owner's time rule and back by itself (the count the owner asked for
  // on 2026-11-06, when the card read 0 at 00:52 his time because the nightly
  // snapshot was taken after "UK night off"). Hand-paused ads sit under
  // "paused / other" whatever the rule does.
  function liveSection(d, s, review) {
    var ads = s.ads || [];
    if (!d.configured || !ads.length) {
      return '<section class="mk-card"><div class="mk-card-head"><h3>Creatives running</h3></div>' +
        '<div class="ats-empty">' + (d.configured ? 'No ads were returned for the campaign.' : 'Connect Meta to see the live creatives.') + '</div></section>';
    }
    var verdicts = {};
    ((review && review.ad_verdicts) || []).forEach(function (v) { verdicts[String(v.ad_id)] = v; });
    var running = ads.filter(inRotation);
    var rest = ads.filter(function (a) { return !inRotation(a); });
    var liveNow = running.filter(function (a) { return rotationOf(a) === 'live'; }).length;
    var html = '<section class="mk-card"><div class="mk-card-head"><h3>Creatives running <span class="ats-count-chip">' + running.length + '</span>' +
        (running.length && liveNow < running.length ? '<span class="mk-meta">' + liveNow + ' delivering this minute</span>' : '') + '</h3>' +
      '<span class="mk-meta">' + (s.adsets || []).filter(inRotation).map(function (x) {
        return esc(x.name) + ' · ' + money(x.daily_budget, 0) + '/day · ' + esc(goalLabel(x.optimization_goal)) + (rotationOf(x) === 'scheduled_off' ? ' · off by rule' : '');
      }).join(' · ') + '</span></div>';
    html += scheduleLine(s, d);
    html += '<div class="mk-live-grid">' + running.map(function (a) { return liveCard(a, verdicts[a.id], d); }).join('') + '</div>';
    if (rest.length) {
      html += '<div class="mk-paused-toggle"><button type="button" class="soc-btn" data-act="toggle-paused">' +
        (state.showPaused ? 'Hide' : 'Show') + ' ' + rest.length + ' paused / other ad' + (rest.length === 1 ? '' : 's') + '</button></div>';
      if (state.showPaused) html += '<div class="mk-live-grid is-paused">' + rest.map(function (a) { return liveCard(a, verdicts[a.id], d); }).join('') + '</div>';
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
    // Meta's CDN (*.fbcdn.net) is not in the page's img-src CSP, so a direct
    // <img> is blocked by the browser (seen in headless Chrome, 2026-10-29).
    // The same-origin proxy serves the bytes instead.
    var img = c.image_url
      ? '<img loading="lazy" src="/api/ceo/ads/photo-proxy?url=' + encodeURIComponent(c.image_url) + '" alt="" onerror="this.style.display=\'none\'; this.parentNode.classList.add(\'no-img\')">'
      : '';
    return '<article class="mk-live-card" data-live-id="' + esc(a.id) + '">' +
      '<div class="mk-live-img' + (img ? '' : ' no-img') + '">' + img +
        '<div class="mk-live-img-fallback"><span>' + esc(c.headline || a.name) + '</span></div>' +
        (verdict ? '<span class="mk-verdict ats-pill ' + verdictMod(verdict.verdict) + '">' + esc(verdict.verdict) + '</span>' : '') +
      '</div>' +
      '<div class="mk-live-body">' +
        '<div class="mk-live-title">' + esc(c.headline || a.name) + '</div>' +
        '<div class="mk-live-sub">' + pill(rotationLabel(a), rotationMod(a)) + ' ' + esc(a.name) +
          (a.days_live !== null && a.days_live !== undefined ? ' · live ' + a.days_live + ' day' + (a.days_live === 1 ? '' : 's') : '') +
          (c.cta_label ? ' · ' + esc(c.cta_label) : '') + '</div>' +
        '<table class="mk-metrics"><thead><tr><th></th><th>Yest.</th><th>7 days</th><th>30 days</th></tr></thead><tbody>' +
          metricRow('Spend', a, function (m) { return money(m.spend, 0); }) +
          metricRow('Leads', a, function (m) { return int(m.leads); }) +
          metricRow('Cost per lead', a, function (m) { return money(m.cost_per_lead, 0); }) +
          metricRow('Link clicks', a, function (m) { return int(m.link_clicks); }) +
          metricRow('Click → lead', a, function (m) { return pct(m.click_to_lead_pct); }) +
          metricRow('Frequency', a, function (m) { return num(m.frequency, 1); }) +
        '</tbody></table>' +
        '<div class="mk-funnel"><strong>App, 30 days:</strong> ' + int(f30.leads) + ' lead' + (f30.leads === 1 ? '' : 's') + ' · ' + int(f30.booked) + ' booked · cost per booking ' + money(f30.cost_per_booking, 0) +
          (f7.leads ? '<span class="soc-when"> (7 days: ' + int(f7.leads) + ' lead' + (f7.leads === 1 ? '' : 's') + ', ' + int(f7.booked) + ' booked)</span>' : '') + '</div>' +
        (a.deep && a.deep.d30 && a.deep.d30.leads ? '<div class="mk-funnel mk-deep"><strong>After the form, 30 days:</strong> Hazel reached ' + int(a.deep.d30.hazel_spoke) + ' of ' + int(a.deep.d30.hazel_called) + ' called · ' + int(a.deep.d30.attended) + ' attended · ' + int(a.deep.d30.signed_up) + ' signed up' +
          (a.deep.d30.cost_per_attended ? ' · cost per attended ' + money(a.deep.d30.cost_per_attended, 0) : '') + '</div>' : '') +
        (flags.length ? '<ul class="mk-flags">' + flags.map(function (fl) { return '<li class="' + esc(fl.level) + '">' + esc(fl.label) + '</li>'; }).join('') + '</ul>' : '') +
        (verdict ? '<div class="mk-verdict-reason"><strong>' + esc(verdict.verdict) + ':</strong> ' + esc(verdict.reason) + '</div>' : '') +
        '<details class="mk-copy"><summary>Copy</summary>' +
          '<div class="mk-copy-text">' + esc(c.primary_text || '').replace(/\n/g, '<br>') + '</div>' +
          (c.description ? '<div class="soc-when">Description: ' + esc(c.description) + '</div>' : '') +
          '<div class="soc-when"><a href="' + esc(ADS_MANAGER + d.defaults.account_id + '&selected_ad_ids=' + a.id) + '" target="_blank" rel="noopener">Open in Ads Manager ↗</a></div>' +
        '</details>' +
      '</div></article>';
  }

  // ── 3. changes to make on Meta ───────────────────────────────────────────
  // The review's account_changes: each names an exact Meta id, the server
  // re-checks it against the live account before making it, and the outcome
  // is stored on the review, so applied ones stay here greyed with what
  // happened. A failed one is left unticked: tick it again to retry.
  function actionMod(a) { return a === 'pause_ad' || a === 'pause_adset' ? 'amber' : (a === 'launch_draft' || a === 'create_ad') ? 'green' : a === 'set_adset_daily_budget' ? 'purple' : 'blue'; }

  function changesSection(d, s, review) {
    if (!review) return '';
    var list = Array.isArray(review.account_changes) ? review.account_changes : null;
    var open = (list || []).filter(function (c) { return !(c.applied && c.applied.ok); });
    var inProgress = (list || []).filter(function (c) { return !!(c.applied && c.applied.ok && c.applied.pending); });
    var html = '<section class="mk-card mk-changes"><div class="mk-card-head"><h3>Changes to make on Meta' + (open.length ? ' <span class="ats-count-chip">' + open.length + '</span>' : '') + '</h3>' +
      '<span class="mk-meta">' + (list && list.length ? 'From this review. Tick the ones to make and press Submit: the app applies them to the ad account straight away, and writes, photographs and launches any new ads.' : '') + '</span></div>';
    if (!list || !list.length) {
      html += '<div class="ats-empty">' + (list ? 'The review proposed no changes to the ad account today.' : 'This review is from before account changes existed. Click Run review now to get them.') + '</div>';
      return html + '</section>';
    }
    html += '<ul class="mk-imps">' + list.map(function (c) {
      var ap = c.applied || null;
      var pending = !!(ap && ap.ok && ap.pending);
      var done = !!(ap && ap.ok && !ap.pending);
      var failed = !!(ap && !ap.ok);
      var stateHtml = '';
      if (done) {
        stateHtml = '<span class="mk-chg-state ok">✓ ' + esc(ap.skipped ? 'Already done when checked' : 'Applied') + (ap.at ? ' · ' + esc(when(ap.at)) : '') + (ap.message ? ' · ' + esc(ap.message) : '') + '</span>';
      } else if (pending) {
        stateHtml = '<span class="mk-chg-state wait">⏳ In progress' + (ap.at ? ' · ' + esc(when(ap.at)) : '') + (ap.message ? ' · ' + esc(ap.message) : '') + '</span>';
      } else if (failed) {
        stateHtml = '<span class="mk-chg-state bad">✕ ' + esc(ap.message || 'Could not apply.') + (ap.at ? ' · ' + esc(when(ap.at)) : '') + (/tick/i.test(ap.message || '') ? '' : ' · tick to try again') + '</span>';
      }
      return '<li class="mk-imp' + (done ? ' is-done' : pending ? ' is-pending' : failed ? ' is-failed' : '') + '"><label>' +
        '<input type="checkbox" class="mk-chg-check" value="' + esc(c.id) + '"' + (done || pending ? ' disabled' : (failed ? '' : ' checked')) + '>' +
        '<span class="mk-imp-body"><span class="mk-imp-title">' + esc(c.title) + ' ' + pill(c.label || c.action, actionMod(c.action)) +
          (c.priority === 1 && !done ? ' ' + pill('do first', 'red') : '') + '</span>' +
        (c.effect ? '<span class="mk-chg-effect">' + esc(c.effect) + '</span>' : '') +
        (c.why ? '<span class="mk-imp-evidence">Why: ' + esc(c.why) + '</span>' : '') +
        stateHtml +
        '</span></label></li>';
    }).join('') + '</ul>';
    html += '<div class="mk-apply">' +
      '<button type="button" class="btn-primary" data-act="apply-changes"' + (state.busy.apply || !open.length || !d.configured ? ' disabled' : '') + '>' +
        (state.busy.apply ? 'Applying on Meta…' : 'Submit ticked changes') + '</button>' +
      '<span class="mk-apply-count">' + (open.length ? open.length + ' waiting' : (inProgress.length ? inProgress.length + ' in progress' : 'All applied')) + '</span>' +
      '<span class="soc-when">' + (d.configured
        ? 'Each change is checked against the live account first: anything already done is skipped, a pause that would empty the ad set is refused, and a budget can rise by at most double in one step. A new ad is written at once, gets its photograph in about a minute and launches itself while this page is open. What happened to each one shows here, and the numbers refresh from Meta afterwards.'
        : 'Connect Meta (META_ADS_ACCESS_TOKEN with ads_management) to apply changes from here.') +
      (d.launch_disabled ? ' <strong>ADS_LAUNCH_DISABLED is on, so nothing is changed until it is switched off.</strong>' : '') + '</span>' +
    '</div>';
    return html + '</section>';
  }

  // ── 4. improvements ──────────────────────────────────────────────────────
  function improvementsSection(d, review) {
    var imps = (review && review.improvements) || [];
    var html = '<section class="mk-card mk-improve"><div class="mk-card-head"><h3>Suggested improvements</h3>' +
      '<span class="mk-meta">' + (imps.length ? 'From this morning\'s review. Tick the ones to build into the next ads.' : '') + '</span></div>';
    var works = (review && review.what_works) || [];
    var fails = (review && review.what_doesnt) || [];
    if (works.length || fails.length) {
      html += '<div class="mk-patterns">' +
        (works.length ? '<div class="mk-pattern-col"><h4>What works, and why</h4><ul>' + works.map(function (w) {
          return '<li><strong>' + esc(w.pattern) + '</strong><div class="mk-why">' + esc(w.evidence) + '</div></li>';
        }).join('') + '</ul></div>' : '') +
        (fails.length ? '<div class="mk-pattern-col is-bad"><h4>What does not work</h4><ul>' + fails.map(function (w) {
          return '<li><strong>' + esc(w.pattern) + '</strong><div class="mk-why">' + esc(w.evidence) + '</div></li>';
        }).join('') + '</ul></div>' : '') +
      '</div>';
    }
    if (!imps.length) {
      html += '<div class="ats-empty">' + (review ? 'The review listed no improvements.' : 'Run a review to get improvements.') + '</div>';
    } else {
      html += '<ul class="mk-imps">' + imps.map(function (x) {
        return '<li class="mk-imp"><label><input type="checkbox" class="mk-imp-check" value="' + esc(x.id) + '" checked>' +
          '<span class="mk-imp-body"><span class="mk-imp-title">' + esc(x.title) + ' ' + pill(x.applies_to.replace('_', ' '), 'blue') +
          (x.priority === 1 ? ' ' + pill('do first', 'red') : '') + '</span>' +
          '<span class="mk-imp-change">' + esc(x.change) + '</span>' +
          (x.evidence ? '<span class="mk-imp-evidence">Evidence: ' + esc(x.evidence) + '</span>' : '') +
          '</span></label></li>';
      }).join('') + '</ul>';
    }
    html += '<div class="mk-generate">' +
      '<label>Write <select id="mkGenCount" class="soc-select"><option>2</option><option selected>3</option><option>4</option></select> new ads</label>' +
      '<input type="text" id="mkGenInstr" class="mk-input" placeholder="Optional steer, e.g. “two after-led angles, one about eConsults”" maxlength="400">' +
      '<button type="button" class="btn-primary" data-act="generate"' + (state.busy.generate || !d.anthropic_configured ? ' disabled' : '') + '>' +
        (state.busy.generate ? 'Writing… (about a minute)' : 'Generate new ads') + '</button>' +
      '<span class="soc-when">The model writes complete ads (image line, headline, three paragraphs, photo brief) applying the ticked improvements, built on the patterns that book and written to the objections leads actually raise. They land below as drafts for you to edit. ' +
        (d.higgsfield_configured ? 'Each one gets its photograph from Higgsfield automatically and composes its own creative.' : '<strong>Photos are off:</strong> add HIGGSFIELD_API_KEY in Vercel and each new ad gets its photograph automatically.') + '</span>' +
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
    if (act === 'apply-changes') return applyChanges();
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
    var boxes = document.querySelectorAll('#soc-hub-root .mk-imp-check:checked');
    for (var i = 0; i < boxes.length; i++) ids.push(boxes[i].value);
    var count = Number((document.getElementById('mkGenCount') || {}).value) || 3;
    var instr = String((document.getElementById('mkGenInstr') || {}).value || '').trim();
    if (!ids.length && !instr && !window.confirm('No improvements are ticked and no steer is given. Write ' + count + ' ads from the account rules alone?')) return;
    state.busy.generate = true; render();
    A.toast('Writing ' + count + ' ads… about a minute.');
    A.api('/api/ceo/ads/drafts/generate', { method: 'POST', body: { count: count, improvement_ids: ids, instructions: instr } }).then(function (d) {
      state.busy.generate = false;
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not write the ads.', 'error'); render(); return; }
      A.toast(d.drafts.length + ' new ad' + (d.drafts.length === 1 ? '' : 's') + ' drafted' + (d.photos_queued ? ', photos generating (about a minute each)' : '') + '. Scroll down to edit them.');
      return load(true).then(function () {
        var el = document.getElementById('soc-drafts-root');
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function applyChanges() {
    if (state.busy.apply) return;
    var d = state.data || {};
    var review = d.review && d.review.review ? d.review.review : null;
    if (!review || !d.review.id) { A.toast('There is no review to apply changes from.', 'error'); return; }
    var ids = [], lines = [];
    var boxes = document.querySelectorAll('#soc-hub-root .mk-chg-check:checked:not(:disabled)');
    for (var i = 0; i < boxes.length; i++) ids.push(boxes[i].value);
    if (!ids.length) { A.toast('Tick at least one change first.', 'error'); return; }
    (review.account_changes || []).forEach(function (c) { if (ids.indexOf(c.id) !== -1) lines.push('• ' + (c.effect || c.title)); });
    if (!window.confirm('Make ' + ids.length + ' change' + (ids.length === 1 ? '' : 's') + ' on the Meta ad account now?\n\n' + lines.join('\n'))) return;
    state.busy.apply = true; render();
    A.toast('Applying ' + ids.length + ' change' + (ids.length === 1 ? '' : 's') + ' on Meta…');
    A.api('/api/ceo/ads/changes/apply', { method: 'POST', body: { review_id: d.review.id, ids: ids } }).then(function (r) {
      state.busy.apply = false;
      if (!r || !r.ok) { A.toast((r && r.message) || 'Could not apply the changes.', 'error'); render(); return; }
      A.toast(r.summary || 'Done.', r.counts && r.counts.failed ? 'error' : undefined);
      // Fresh numbers from Meta, so the live cards show the new statuses and
      // the list shows what happened to each change.
      return refresh();
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

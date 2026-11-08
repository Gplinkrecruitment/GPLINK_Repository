/* ============================================================================
 * ceo-social.js — the Social tab of the CEO dashboard: the Ads hub.
 *
 * Four sub-tabs (2026-11-08, owner's "one review, one list" cleanup):
 *   Today      — "This week" (the Performance card: any date range, daily /
 *                weekly / monthly, compared with the period before; plus one
 *                line on what the app did after the form) and "Today's review"
 *                (the model's headline and summary, then ONE "Do today" list
 *                grouped by where each thing happens: On Meta = the review's
 *                account_changes with a tick box each — Submit applies the
 *                ticked ones through POST /api/ceo/ads/changes/apply and shows
 *                what happened to each — plus anything to do in Ads Manager by
 *                hand; In the app = Hazel, the chase, tracking; Elsewhere).
 *                Every point from the review appears exactly once: an
 *                automation "improvement" that an action already carries out
 *                is folded into that action (by improvement_id, or by word
 *                overlap for reviews written before that field existed).
 *   Creatives  — the ads in rotation, each with its verdict and four numbers
 *                up front and the full table, Hazel line, copy and Ads Manager
 *                link under Details; the paused ones behind a toggle; then the
 *                evidence (what works / what does not) the verdicts rest on.
 *   New ads    — the writer's rules (the creative improvements, ticked by
 *                default; "Generate N new ads" writes ads applying the ticked
 *                ones) and the drafts board (js/ceo-ads-drafts.js): edit on the
 *                page, ask the model, compose the creative, schedule, launch.
 *   Research   — what GPs ask about in consultations, and the after-the-form
 *                funnel opened out.
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

  var SUBTABS = [
    { key: 'today', label: 'Today' },
    { key: 'creatives', label: 'Creatives' },
    { key: 'newads', label: 'New ads' },
    { key: 'research', label: 'Research' }
  ];
  var SUBTAB_KEY = 'soc.ads.subtab';

  var state = {
    view: 'ads', data: null, loading: false, loadedAt: 0, busy: {},
    scaffolded: false, showPaused: false, health: null, subtab: readSubtab()
  };
  var panelWired = false;
  var ADS_MANAGER = 'https://adsmanager.facebook.com/adsmanager/manage/ads?act=';

  function panel() { return document.getElementById('panel-social'); }
  function adsRoot() { return document.getElementById('soc-hub-root'); }

  function readSubtab() {
    try {
      var v = window.sessionStorage ? window.sessionStorage.getItem(SUBTAB_KEY) : null;
      return v && SUBTABS.some(function (t) { return t.key === v; }) ? v : 'today';
    } catch (e) { return 'today'; }
  }
  function saveSubtab(v) { try { if (window.sessionStorage) window.sessionStorage.setItem(SUBTAB_KEY, v); } catch (e) { /* private mode */ } }

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
    var name = '“' + esc(sc.adset_name || 'The ad set') + '”';
    var on = sc.on_rule, off = sc.off_rule;
    var note = ' An ad you pause yourself stays paused when the rule turns the ad set back on: the rule only changes the ad set.';
    var body = '';
    if (sc.state === 'off' && on && on.at) {
      body = pill('Off by rule', 'blue') + '<span>' + name + ' is switched off right now' + (off ? ' by the rule “' + esc(off.name) + '”' : '') +
        ' and comes back on at <strong>' + esc(clockPair(on.at, d)) + '</strong> (rule “' + esc(on.name) + '”). Its ads are in rotation and counted above.' + note + '</span>';
    } else if (sc.state === 'on') {
      body = pill('Live now', 'green') + '<span>' + name + ' is on' + (on ? ' by the rule “' + esc(on.name) + '”' : '') +
        (off && off.at ? '; “' + esc(off.name) + '” switches it off at <strong>' + esc(clockPair(off.at, d)) + '</strong>.' : '.') + note + '</span>';
    } else if (on && on.at) {
      body = pill('Paused by hand', 'amber') + '<span>' + name + ' is paused, but the rule “' + esc(on.name) + '” will switch it back on at <strong>' + esc(clockPair(on.at, d)) +
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
    html += subtabBar(d, s, review);
    html += subpanel('today', thisWeekSection(d, s) + reviewSection(d, s, review));
    html += subpanel('creatives', liveSection(d, s, review) + evidenceSection(review, s));
    html += subpanel('newads', rulesSection(d, review) + '<div id="soc-drafts-slot"></div>');
    html += subpanel('research', gpQuestionsSection(s) + leadsSection(s));
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

  // Each sub-tab is a panel in the same paint; the three that are not showing
  // are hidden, not skipped, so the drafts root and the Performance card keep
  // their place and a switch is just a repaint.
  function subpanel(key, inner) {
    return '<div class="mk-subpanel" data-subpanel="' + esc(key) + '"' + (key === state.subtab ? '' : ' style="display:none"') + '>' + inner + '</div>';
  }

  function subtabBar(d, s, review) {
    var counts = {
      today: openCount(review),
      creatives: (s.ads || []).filter(inRotation).length,
      newads: (d.drafts || []).filter(function (x) { return x && x.status !== 'archived'; }).length,
      research: 0
    };
    return '<div class="mk-subtabs" role="tablist">' + SUBTABS.map(function (t) {
      var on = t.key === state.subtab;
      var n = counts[t.key];
      return '<button type="button" class="mk-subtab' + (on ? ' is-on' : '') + '" data-act="subtab" data-subtab="' + t.key + '" role="tab" aria-selected="' + (on ? 'true' : 'false') + '">' +
        esc(t.label) + (n ? ' <span class="ats-count-chip">' + n + '</span>' : '') + '</button>';
    }).join('') + '</div>';
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

  // ── Today · 1. this week ─────────────────────────────────────────────────
  function tile(label, value, extra, title) {
    return '<div class="mk-kpi"' + (title ? ' title="' + esc(title) + '"' : '') + '><span class="mk-kpi-label">' + esc(label) + '</span>' +
      '<b class="mk-kpi-value">' + value + '</b>' + (extra ? '<span class="mk-kpi-extra">' + extra + '</span>' : '') + '</div>';
  }

  function thisWeekSection(d, s) {
    var f = s.funnel || {};
    var f7 = f.d7 || {};
    var f30 = f.d30 || {};
    var html = '<section class="mk-card mk-summary"><div class="mk-card-head"><h3>This week</h3>' +
      '<span class="mk-meta">' + (d.snapshot_at ? 'Numbers as of ' + esc(when(d.snapshot_at)) + ' · ' : '') + 'Meta\'s day is the Melbourne day</span></div>';

    // The Performance card: any date range, daily / weekly / monthly, compared
    // with the period before (js/ceo-ads-range.js owns #soc-range-root).
    html += '<div id="soc-range-root"></div>';
    if (!d.configured || d.snapshot_source === 'funnel_only') {
      html += '<div class="mk-kpi-row"><div class="mk-kpi-group-label">App funnel (Meta leads)</div>' +
        tile('Leads, 7 days', int(f7.leads)) + tile('Booked, 7 days', int(f7.booked)) +
        tile('Leads, 30 days', int(f30.leads)) + tile('Booked, 30 days', int(f30.booked)) + tile('Signed up, 30 days', int(f30.signed_up)) +
      '</div>';
    }
    html += ecosystemStrip(s.ecosystem, false);
    return html + '</section>';
  }

  // What the rest of GP Link did with these leads, so the owner reads the
  // review knowing Hazel and the chase already ran. One line; the five lines
  // open on click (and sit opened out on the Research tab).
  function ecosystemStrip(e, open) {
    if (!e || !e.funnel_30d) return '';
    var f = e.funnel_30d, hz = e.hazel || {}, nd = e.nudges || {}, og = e.organic || null;
    var mins = f.median_hours_to_book === null || f.median_hours_to_book === undefined ? '—' : (f.median_hours_to_book < 1 ? Math.round(f.median_hours_to_book * 60) + ' min' : num(f.median_hours_to_book, 1) + ' h');
    var line = int(f.leads) + ' leads → ' + int(f.qualified) + ' qualified → ' + int(f.booked) + ' booked (' + pct(f.booking_rate_pct, 0) +
      (f.booked_within_10min_pct !== null && f.booked_within_10min_pct !== undefined ? ', ' + f.booked_within_10min_pct + '% within 10 minutes' : '') + ') → ' +
      int(f.attended) + ' attended → ' + int(f.signed_up) + ' signed up · Hazel spoke to ' + int(hz.spoke_30d) + ' of ' + int(hz.calls_30d) + ' calls · ' +
      int(nd.replied) + ' of ' + int(nd.leads_30d) + ' replied to the chase' +
      (og ? ' · ' + int(og.posted_last_7d) + ' organic post' + (og.posted_last_7d === 1 ? '' : 's') + ' last week' : '');
    return '<details class="mk-eco"' + (open ? ' open' : '') + '><summary class="mk-eco-line"><strong>After the form, 30 days:</strong> ' + line + '</summary><ul>' +
      '<li><strong>Funnel:</strong> ' + int(f.leads) + ' leads → ' + int(f.qualified) + ' qualified → ' + int(f.booked) + ' booked (' + pct(f.booking_rate_pct, 0) + ') → ' + int(f.attended) + ' attended → ' + int(f.signed_up) + ' signed up. Median time to book ' + esc(mins) +
        (f.booked_within_10min_pct !== null && f.booked_within_10min_pct !== undefined ? ', ' + f.booked_within_10min_pct + '% within 10 minutes' : '') + '.</li>' +
      '<li><strong>Hazel (AI caller):</strong> ' + int(hz.calls_30d) + ' calls, spoke to someone on ' + int(hz.spoke_30d) + ', voicemail ' + int(hz.voicemail_30d) + ', no answer ' + int(hz.no_answer_30d) + ', booked on the call ' + int(hz.booked_on_call_30d) + ', callbacks ' + int(hz.callbacks_30d) + ', not interested ' + int(hz.not_interested_30d) + '.</li>' +
      '<li><strong>WhatsApp / email chase:</strong> ' + int(nd.with_whatsapp) + ' of ' + int(nd.leads_30d) + ' leads got WhatsApps, ' + int(nd.with_email) + ' emails, ' + int(nd.replied) + ' replied, owner paged ' + int(nd.owner_paged) + ' times.</li>' +
      ((e.voice_of_lead && e.voice_of_lead.objections && e.voice_of_lead.objections.length) ? '<li><strong>Objections heard:</strong> ' + esc(e.voice_of_lead.objections.map(function (o) { return o.value + ' (' + o.count + ')'; }).join(', ')) + '.</li>' : '') +
      (e.demand && e.demand.open_roles ? '<li><strong>Roles to fill:</strong> ' + int(e.demand.open_roles) + ' open' + (e.demand.by_state && e.demand.by_state.length ? ', mostly ' + esc(e.demand.by_state.slice(0, 3).map(function (x) { return x.value + ' (' + x.count + ')'; }).join(', ')) : '') + '.</li>' : '') +
      (og ? '<li><strong>Organic posts:</strong> ' + int(og.posted_last_7d) + ' went out last week, ' + int(og.scheduled_next_7d) + ' scheduled for the next 7 days.</li>' : '') +
    '</ul></details>';
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

  // ── Today · 2. the review and ONE "Do today" list ────────────────────────
  // Where a thing happens decides its group. 'this_page' points at the drafts
  // board, which the app also drives, so it sits with the Meta changes.
  var WHERE_GROUP = { ads_manager: 'meta', this_page: 'meta', automation: 'app', follow_up: 'app', none: 'elsewhere' };
  // Improvements about Hazel, the chase or the booking flow are things to DO,
  // not rules for writing ads.
  var TODO_APPLIES = ['automation', 'follow_up'];
  var STOP = {};
  ('the a an and or of to in on for with that this from into about their they them then than when what which while make more most each every both only also ' +
   'over after before out off up down any all some one two three it its is are was were be been being have has had do does did not no yes so if as at by we you your our his her who whom whose where why how')
    .split(' ').forEach(function (w) { STOP[w] = true; });
  function words(s) {
    var out = {};
    (String(s || '').toLowerCase().match(/[a-z][a-z']{3,}/g) || []).forEach(function (w) { if (!STOP[w]) out[w] = true; });
    return out;
  }
  function overlap(a, b) { var n = 0; for (var k in a) if (b[k]) n++; return n; }

  // One list of things to do, each once. actions_today is the source. An
  // automation improvement joins it only when no action already carries it:
  // by improvement_id when the model gave one, or, for reviews written before
  // that field existed, when it shares six or more significant words with an
  // action (measured on the 8 Nov review: the four real pairs scored 8–16,
  // every other pairing 5 or less).
  function todoItems(review) {
    var acts = (review && review.actions_today) || [];
    var imps = (review && review.improvements) || [];
    var done = (review && review.todos) || {};
    var items = acts.map(function (a, i) {
      var key = 'act-' + i;
      return { key: key, title: a.action, body: '', why: a.why, where: a.where, group: WHERE_GROUP[a.where] || 'elsewhere', imp: a.improvement_id || null, priority: 0,
        done: !!done[key], doneAt: done[key] && done[key].done_at };
    });
    var linked = {};
    items.forEach(function (x) { if (x.imp) linked[x.imp] = true; });
    var explicit = items.some(function (x) { return !!x.imp; });
    var actWords = acts.map(function (a) { return words(a.action); });
    imps.forEach(function (im) {
      if (TODO_APPLIES.indexOf(im.applies_to) === -1 || linked[im.id]) return;
      var hit = -1;
      if (!explicit) {
        var iw = words(im.title + ' ' + im.change);
        actWords.forEach(function (aw, i) { if (hit === -1 && !items[i].imp && overlap(iw, aw) >= 6) hit = i; });
      }
      if (hit !== -1) {
        // The action is the specific instruction; the improvement gives it a
        // short name and its priority.
        items[hit].imp = im.id; items[hit].body = items[hit].title; items[hit].title = im.title; items[hit].priority = im.priority;
        return;
      }
      items.push({ key: im.id, title: im.title, body: im.change, why: im.evidence, where: im.applies_to, group: 'app', imp: im.id, priority: im.priority,
        done: !!done[im.id], doneAt: done[im.id] && done[im.id].done_at });
    });
    return items;
  }

  function openCount(review) {
    if (!review) return 0;
    var open = (review.account_changes || []).filter(function (c) { return !(c.applied && c.applied.ok); }).length +
      (review.automation_changes || []).filter(function (c) { return !(c.applied && c.applied.ok); }).length;
    return open + todoItems(review).filter(function (t) { return !t.done; }).length;
  }

  function reviewSection(d, s, review) {
    var r = d.review || null;
    var html = '<section class="mk-card mk-review-card"><div class="mk-card-head"><h3>Today\'s review</h3>' +
      '<span class="mk-meta">' + (r
        ? esc((r.kind === 'daily' ? 'Morning review' : 'Review') + ' · ' + when(r.created_at) + ' · ' + (r.model || ''))
        : (d.last_run && d.last_run.error ? 'Last attempt failed · ' + esc(when(d.last_run.created_at)) : 'No review yet')) + '</span></div>';
    if (!review) {
      if (d.last_run && d.last_run.error) html += '<div class="soc-note"><strong>The last review could not be written.</strong> ' + esc(d.last_run.error) + '</div>';
      else html += '<div class="soc-note">No review has run yet. The morning cron writes one every day at 08:30 Melbourne time; click <strong>Run review now</strong> to get the first one.</div>';
      return html + '</section>';
    }
    html += (review.headline ? '<p class="mk-review-headline">' + esc(review.headline) + '</p>' : '') +
      (review.summary ? '<p class="mk-review-summary">' + esc(review.summary).replace(/\n+/g, '<br>') + '</p>' : '');
    html += doTodaySection(d, s, review);
    return html + '</section>';
  }

  function doTodaySection(d, s, review) {
    var todos = todoItems(review);
    var groups = { meta: [], app: [], elsewhere: [] };
    todos.forEach(function (t) { (groups[t.group] || groups.elsewhere).push(t); });
    var list = Array.isArray(review.account_changes) ? review.account_changes : null;
    var n = openCount(review);
    var html = '<div class="mk-do"><div class="mk-do-head"><h4>Do today' + (n ? ' <span class="ats-count-chip">' + n + '</span>' : '') + '</h4>' +
      '<span class="mk-meta">Everything the review asks for, once, grouped by where it happens.</span></div>';

    // On Meta: the review's account_changes (tick + Submit, applied by the app)
    // and anything to do in Ads Manager or on the drafts board by hand.
    html += '<div class="mk-do-group mk-changes"><div class="mk-do-group-head"><strong>On Meta</strong> <span class="mk-meta">' +
      (list && list.length
        ? 'Tick the changes to make and press Submit: the app applies them to the ad account straight away, and writes, photographs and launches any new ads.'
        : (list ? 'The review proposed no changes to the ad account today.' : 'This review is from before account changes existed. Click Run review now to get them.')) +
      '</span></div>';
    html += changesList(d, list) + todoList(groups.meta) + applyRow(d, list);
    if (!(list && list.length) && !groups.meta.length) html += '<div class="ats-empty">Nothing to do on Meta today.</div>';
    html += '</div>';

    // In the app: the review's automation_changes (tick + Submit: the app
    // changes its own settings, 2026-11-08 "i should be able to click and the
    // ai implements the automation") and the to-dos no lever reaches.
    var autoList = Array.isArray(review.automation_changes) ? review.automation_changes : [];
    var levers = (d.automation && d.automation.levers) || [];
    if (groups.app.length || autoList.length || levers.length) {
      html += '<div class="mk-do-group mk-automation"><div class="mk-do-group-head"><strong>In the app</strong> <span class="mk-meta">' +
        (autoList.length
          ? 'Hazel, the chase sequence and tracking. Tick the changes and press Submit: the app changes its own settings at once. Anything else here is a to-do: tick when done.'
          : 'Hazel, the chase sequence and tracking. Tick when done; the tick stays until the next review.') + '</span></div>' +
        automationList(autoList) + todoList(groups.app) +
        (!autoList.length && !groups.app.length ? '<div class="ats-empty">The review asks for no change to the automation today.</div>' : '') +
        automationApplyRow(d, autoList) + '</div>';
    }
    if (groups.elsewhere.length) {
      html += '<div class="mk-do-group"><div class="mk-do-group-head"><strong>Elsewhere</strong></div>' + todoList(groups.elsewhere) + '</div>';
    }
    return html + '</div>';
  }

  // The review's account_changes: each names an exact Meta id, the server
  // re-checks it against the live account before making it, and the outcome
  // is stored on the review, so applied ones stay here greyed with what
  // happened. A failed one is left unticked: tick it again to retry.
  function actionMod(a) { return a === 'pause_ad' || a === 'pause_adset' ? 'amber' : (a === 'launch_draft' || a === 'create_ad') ? 'green' : a === 'set_adset_daily_budget' ? 'purple' : 'blue'; }

  function changesList(d, list) {
    if (!list || !list.length) return '';
    return '<ul class="mk-imps">' + list.map(function (c) {
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
  }

  function applyRow(d, list) {
    if (!list || !list.length) return '';
    var open = list.filter(function (c) { return !(c.applied && c.applied.ok); });
    var inProgress = list.filter(function (c) { return !!(c.applied && c.applied.ok && c.applied.pending); });
    return '<div class="mk-apply">' +
      '<button type="button" class="btn-primary" data-act="apply-changes"' + (state.busy.apply || !open.length || !d.configured ? ' disabled' : '') + '>' +
        (state.busy.apply ? 'Applying on Meta…' : 'Submit ticked changes') + '</button>' +
      '<span class="mk-apply-count">' + (open.length ? open.length + ' waiting' : (inProgress.length ? inProgress.length + ' in progress' : 'All applied')) + '</span>' +
      '<details class="mk-whyd mk-inline"><summary>How it applies them</summary><div class="mk-why">' + (d.configured
        ? 'Each change is checked against the live account first: anything already done is skipped, a pause that would empty the ad set is refused, and a budget can rise by at most double in one step. A new ad is written at once, gets its photograph in about a minute and launches itself while this page is open. What happened to each one shows here, and the numbers refresh from Meta afterwards.'
        : 'Connect Meta (META_ADS_ACCESS_TOKEN with ads_management) to apply changes from here.') +
      (d.launch_disabled ? ' <strong>ADS_LAUNCH_DISABLED is on, so nothing is changed until it is switched off.</strong>' : '') + '</div></details>' +
    '</div>';
  }

  // The review's automation_changes: each names one setting of Hazel, the
  // chase or the no-show sweep and its new value. The server re-checks it
  // against the settings in force (lib/automation-actions) and stores the
  // outcome on the review, so applied ones stay here greyed with what
  // happened; a refused one is left unticked to try again.
  function automationList(list) {
    if (!list || !list.length) return '';
    return '<ul class="mk-imps">' + list.map(function (c) {
      var ap = c.applied || null;
      var done = !!(ap && ap.ok);
      var failed = !!(ap && !ap.ok);
      var stateHtml = '';
      if (done) stateHtml = '<span class="mk-chg-state ok">✓ ' + esc(ap.skipped ? 'Already so when checked' : 'Changed') + (ap.at ? ' · ' + esc(when(ap.at)) : '') + (ap.message ? ' · ' + esc(ap.message) : '') + '</span>';
      else if (failed) stateHtml = '<span class="mk-chg-state bad">✕ ' + esc(ap.message || 'Could not change it.') + (ap.at ? ' · ' + esc(when(ap.at)) : '') + ' · tick to try again</span>';
      return '<li class="mk-imp' + (done ? ' is-done' : failed ? ' is-failed' : '') + '"><label>' +
        '<input type="checkbox" class="mk-auto-check" value="' + esc(c.id) + '"' + (done ? ' disabled' : (failed ? '' : ' checked')) + '>' +
        '<span class="mk-imp-body"><span class="mk-imp-title">' + esc(c.title) + ' ' + pill(c.label || 'Automation', 'green') +
          (c.priority === 1 && !done ? ' ' + pill('do first', 'red') : '') + '</span>' +
        (c.effect ? '<span class="mk-chg-effect">' + esc(c.effect) + '</span>' : '') +
        (c.why ? '<span class="mk-imp-evidence">Why: ' + esc(c.why) + '</span>' : '') +
        stateHtml +
        '</span></label></li>';
    }).join('') + '</ul>';
  }

  function automationApplyRow(d, list) {
    var levers = (d.automation && d.automation.levers) || [];
    var settingsHtml = levers.length
      ? '<details class="mk-whyd mk-inline"><summary>What the automation is set to now</summary><div class="mk-why"><ul class="mk-settings">' + levers.map(function (l) {
          return '<li><span>' + esc(l.label) + '</span><strong>' + esc(l.display) + '</strong></li>';
        }).join('') + '</ul></div></details>'
      : '';
    if (!list || !list.length) return settingsHtml ? '<div class="mk-apply">' + settingsHtml + '</div>' : '';
    var open = list.filter(function (c) { return !(c.applied && c.applied.ok); });
    return '<div class="mk-apply">' +
      '<button type="button" class="btn-primary" data-act="apply-automation"' + (state.busy.automation || !open.length ? ' disabled' : '') + '>' +
        (state.busy.automation ? 'Changing the settings…' : 'Submit ticked changes') + '</button>' +
      '<span class="mk-apply-count">' + (open.length ? open.length + ' waiting' : 'All applied') + '</span>' +
      '<details class="mk-whyd mk-inline"><summary>How it applies them</summary><div class="mk-why">Each change is one setting of Hazel\'s calling rules, the chase sequence or the no-show sweep, inside a safe range. It is checked against the settings in force (one already so is skipped; calling hours or chase steps that would run out of order are refused), then stored and used by the very next cron pass, within five minutes. Hazel\'s words are never changed from here.</div></details>' +
      settingsHtml +
    '</div>';
  }

  // Things the app cannot do by itself. The tick is kept on the review
  // (POST /api/ceo/ads/review/todo) so a refresh does not lose it. The "Why"
  // sits outside the label so opening it never flips the tick.
  function todoList(items) {
    if (!items.length) return '';
    return '<ul class="mk-imps">' + items.map(function (t) {
      var id = 'mkTodo-' + String(t.key).replace(/[^a-z0-9-]/gi, '');
      return '<li class="mk-imp mk-todo' + (t.done ? ' is-done' : '') + '"><div class="mk-todo-row">' +
        '<input type="checkbox" id="' + id + '" class="mk-todo-check" data-act="todo" data-key="' + esc(t.key) + '"' + (t.done ? ' checked' : '') + '>' +
        '<span class="mk-imp-body"><label for="' + id + '" class="mk-imp-title">' + esc(t.title) + whereBadge(t.where) + (t.priority === 1 && !t.done ? ' ' + pill('do first', 'red') : '') + '</label>' +
        (t.body ? '<span class="mk-chg-effect">' + esc(t.body) + '</span>' : '') +
        (t.why ? '<details class="mk-whyd"><summary>Why</summary><div class="mk-why">' + esc(t.why) + '</div></details>' : '') +
        (t.done ? '<span class="mk-chg-state ok">✓ Done' + (t.doneAt ? ' · ' + esc(when(t.doneAt)) : '') + '</span>' : '') +
        '</span></div></li>';
    }).join('') + '</ul>';
  }

  // ── Research · what GPs ask about ────────────────────────────────────────
  // ecosystem.gp_questions (lib/ads-context consultQuestions): every past
  // consultation with Zoom notes, counted by theme. The review and the new
  // ads are written to it; this card shows the owner the same evidence.
  function gpQuestionsSection(s) {
    var q = s.ecosystem && s.ecosystem.gp_questions;
    if (!q || !q.consults || !Array.isArray(q.themes) || !q.themes.length) return '';
    var html = '<section class="mk-card mk-asks"><div class="mk-card-head"><h3>What GPs ask about in consultations <span class="ats-count-chip">' + esc(String(q.consults)) + '</span></h3>' +
      '<span class="mk-meta">Every consultation with Zoom notes' + (q.since ? ' since ' + esc(q.since) : '') + ', counted by theme. The morning review and every new ad are written to this.</span></div>';
    html += '<ul class="mk-asks-list">' + q.themes.map(function (t) {
      var ex = (t.examples || [])[0];
      return '<li><div class="mk-asks-row"><strong>' + esc(t.label) + '</strong><span class="mk-asks-count">' + esc(String(t.consults)) + ' of ' + esc(String(q.consults)) + ' · ' + esc(String(t.share_pct)) + '%</span></div>' +
        '<div class="mk-asks-bar"><i style="width:' + Math.max(2, Math.min(100, Number(t.share_pct) || 0)) + '%"></i></div>' +
        (ex ? '<div class="mk-asks-example">' + esc(ex) + '</div>' : '') + '</li>';
    }).join('') + '</ul>';
    if (Array.isArray(q.questions) && q.questions.length) {
      html += '<details class="mk-asks-questions"><summary>' + esc(String(q.questions.length)) + ' things doctors asked or were unsure about, newest first</summary><ul>' +
        q.questions.map(function (x) { return '<li><span class="soc-when">' + esc(x.when || '') + '</span> ' + esc(x.said || '') + '</li>'; }).join('') + '</ul></details>';
    }
    return html + '</section>';
  }

  function leadsSection(s) {
    var strip = ecosystemStrip(s.ecosystem, true);
    if (!strip) return '';
    return '<section class="mk-card mk-research-leads"><div class="mk-card-head"><h3>What the app did with the leads</h3>' +
      '<span class="mk-meta">The last 30 days after the form: the same line as on Today, opened out.</span></div>' + strip + '</section>';
  }

  // ── Creatives ────────────────────────────────────────────────────────────
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
    html += '<div class="mk-live-grid is-compact">' + running.map(function (a) { return liveCard(a, verdicts[a.id], d); }).join('') + '</div>';
    if (rest.length) {
      html += '<div class="mk-paused-toggle"><button type="button" class="soc-btn" data-act="toggle-paused">' +
        (state.showPaused ? 'Hide' : 'Show') + ' ' + rest.length + ' paused / other ad' + (rest.length === 1 ? '' : 's') + '</button></div>';
      if (state.showPaused) html += '<div class="mk-live-grid is-compact is-paused">' + rest.map(function (a) { return liveCard(a, verdicts[a.id], d); }).join('') + '</div>';
    }
    return html + '</section>';
  }

  function goalLabel(g) { return ({ QUALITY_LEAD: 'qualified-leads goal', LEAD_GENERATION: 'leads goal', LINK_CLICKS: 'link-clicks goal' })[g] || String(g || '').toLowerCase().replace(/_/g, ' '); }

  function metricRow(label, a, fmt) {
    var m = a.metrics || {};
    return '<tr><th>' + esc(label) + '</th><td>' + fmt(m.yesterday || {}) + '</td><td>' + fmt(m.last_7d || {}) + '</td><td>' + fmt(m.last_30d || {}) + '</td></tr>';
  }

  // Verdict and four numbers up front; the full table, the Hazel line, the
  // copy and the Ads Manager link under Details. Nothing left out.
  function liveCard(a, verdict, d) {
    var c = a.creative || {};
    var f30 = (a.funnel && a.funnel.d30) || {};
    var f7 = (a.funnel && a.funnel.d7) || {};
    var w = (a.metrics && a.metrics.last_7d) || {};
    var flags = a.flags || [];
    // Meta's CDN (*.fbcdn.net) is not in the page's img-src CSP, so a direct
    // <img> is blocked by the browser (seen in headless Chrome, 2026-10-29).
    // The same-origin proxy serves the bytes instead.
    var img = c.image_url
      ? '<img loading="lazy" src="/api/ceo/ads/photo-proxy?url=' + encodeURIComponent(c.image_url) + '" alt="" onerror="this.style.display=\'none\'; this.parentNode.classList.add(\'no-img\')">'
      : '';
    return '<article class="mk-live-card is-compact" data-live-id="' + esc(a.id) + '">' +
      '<div class="mk-live-img' + (img ? '' : ' no-img') + '">' + img +
        '<div class="mk-live-img-fallback"><span>' + esc(c.headline || a.name) + '</span></div>' +
        (verdict ? '<span class="mk-verdict ats-pill ' + verdictMod(verdict.verdict) + '">' + esc(verdict.verdict) + '</span>' : '') +
      '</div>' +
      '<div class="mk-live-body">' +
        '<div class="mk-live-title">' + esc(c.headline || a.name) + '</div>' +
        '<div class="mk-live-sub">' + pill(rotationLabel(a), rotationMod(a)) + ' ' + esc(a.name) +
          (a.days_live !== null && a.days_live !== undefined ? ' · live ' + a.days_live + ' day' + (a.days_live === 1 ? '' : 's') : '') +
          (c.cta_label ? ' · ' + esc(c.cta_label) : '') + '</div>' +
        '<div class="mk-big4">' +
          '<div><b>' + money(w.spend, 0) + '</b><span>spend, 7 days</span></div>' +
          '<div><b>' + int(w.leads) + '</b><span>leads, 7 days</span></div>' +
          '<div><b>' + money(w.cost_per_lead, 0) + '</b><span>per lead, 7 days</span></div>' +
          '<div><b>' + pct(w.click_to_lead_pct) + '</b><span>click → lead</span></div>' +
        '</div>' +
        '<div class="mk-funnel"><strong>App, 30 days:</strong> ' + int(f30.leads) + ' lead' + (f30.leads === 1 ? '' : 's') + ' · ' + int(f30.booked) + ' booked · cost per booking ' + money(f30.cost_per_booking, 0) +
          (f7.leads ? '<span class="soc-when"> (7 days: ' + int(f7.leads) + ' lead' + (f7.leads === 1 ? '' : 's') + ', ' + int(f7.booked) + ' booked)</span>' : '') + '</div>' +
        (flags.length ? '<ul class="mk-flags">' + flags.map(function (fl) { return '<li class="' + esc(fl.level) + '">' + esc(fl.label) + '</li>'; }).join('') + '</ul>' : '') +
        (verdict ? '<div class="mk-verdict-reason"><strong>' + esc(verdict.verdict) + ':</strong> ' + esc(verdict.reason) + '</div>' : '') +
        '<details class="mk-copy"><summary>Details</summary>' +
          '<table class="mk-metrics"><thead><tr><th></th><th>Yest.</th><th>7 days</th><th>30 days</th></tr></thead><tbody>' +
            metricRow('Spend', a, function (m) { return money(m.spend, 0); }) +
            metricRow('Leads', a, function (m) { return int(m.leads); }) +
            metricRow('Cost per lead', a, function (m) { return money(m.cost_per_lead, 0); }) +
            metricRow('Link clicks', a, function (m) { return int(m.link_clicks); }) +
            metricRow('Click → lead', a, function (m) { return pct(m.click_to_lead_pct); }) +
            metricRow('Frequency', a, function (m) { return num(m.frequency, 1); }) +
          '</tbody></table>' +
          (a.deep && a.deep.d30 && a.deep.d30.leads ? '<div class="mk-funnel mk-deep"><strong>After the form, 30 days:</strong> Hazel reached ' + int(a.deep.d30.hazel_spoke) + ' of ' + int(a.deep.d30.hazel_called) + ' called · ' + int(a.deep.d30.attended) + ' attended · ' + int(a.deep.d30.signed_up) + ' signed up' +
            (a.deep.d30.cost_per_attended ? ' · cost per attended ' + money(a.deep.d30.cost_per_attended, 0) : '') + '</div>' : '') +
          '<div class="mk-copy-text">' + esc(c.primary_text || '').replace(/\n/g, '<br>') + '</div>' +
          (c.description ? '<div class="soc-when">Description: ' + esc(c.description) + '</div>' : '') +
          '<div class="soc-when"><a href="' + esc(ADS_MANAGER + d.defaults.account_id + '&selected_ad_ids=' + a.id) + '" target="_blank" rel="noopener">Open in Ads Manager ↗</a></div>' +
        '</details>' +
      '</div></article>';
  }

  // What works and what does not, with the ads each pattern comes from. The
  // verdicts on the cards above and the writer's rules on New ads rest on it.
  function evidenceSection(review, s) {
    var works = (review && review.what_works) || [];
    var fails = (review && review.what_doesnt) || [];
    if (!works.length && !fails.length) return '';
    var names = {};
    ((s && s.ads) || []).forEach(function (a) { names[String(a.id)] = (a.creative && a.creative.headline) || a.name; });
    function col(items) {
      return '<ul>' + items.map(function (w) {
        var refs = (w.ad_ids || []).map(function (id) { return names[String(id)] || String(id); });
        return '<li><strong>' + esc(w.pattern) + '</strong><div class="mk-why">' + esc(w.evidence) + (refs.length ? '<span class="mk-adrefs">' + esc(refs.join(' · ')) + '</span>' : '') + '</div></li>';
      }).join('') + '</ul>';
    }
    return '<section class="mk-card mk-evidence-card"><div class="mk-card-head"><h3>Evidence behind today\'s call</h3>' +
      '<span class="mk-meta">The patterns that book and the ones that do not, with the ads they come from.</span></div>' +
      '<div class="mk-patterns">' +
        (works.length ? '<div class="mk-pattern-col"><h4>What works, and why</h4>' + col(works) + '</div>' : '') +
        (fails.length ? '<div class="mk-pattern-col is-bad"><h4>What does not work</h4>' + col(fails) + '</div>' : '') +
      '</div></section>';
  }

  // ── New ads · the writer's rules + Generate ──────────────────────────────
  // The creative improvements (headline, image, copy, angle…). Ticked by
  // default; "Generate N new ads" sends the ticked ids as improvement_ids,
  // exactly as the old "Suggested improvements" list did. The automation
  // improvements are to-dos on Today, not writing rules.
  function rulesSection(d, review) {
    var imps = ((review && review.improvements) || []).filter(function (x) { return TODO_APPLIES.indexOf(x.applies_to) === -1; });
    var html = '<section class="mk-card mk-improve"><div class="mk-card-head"><h3>Rules the ad writer follows' + (imps.length ? ' <span class="ats-count-chip">' + imps.length + '</span>' : '') + '</h3>' +
      '<span class="mk-meta">' + (imps.length ? 'From the review\'s evidence. Every ticked rule is written into the next ads; untick one to leave it out of the next batch.' : '') + '</span></div>';
    if (!imps.length) {
      html += '<div class="ats-empty">' + (review ? 'The review set no writing rules.' : 'Run a review to get the writer\'s rules.') + '</div>';
    } else {
      html += '<div class="mk-rules-list">' + imps.map(function (x) {
        return '<div class="mk-rule"><div class="mk-rule-row"><label><input type="checkbox" class="mk-imp-check" value="' + esc(x.id) + '" checked><span>' + esc(x.title) + '</span></label> ' +
          pill(x.applies_to.replace('_', ' '), 'blue') + (x.priority === 1 ? ' ' + pill('do first', 'red') : '') + '</div>' +
          '<details class="mk-whyd"><summary>Rule and evidence</summary><div class="mk-why"><strong>Rule:</strong> ' + esc(x.change) +
          (x.evidence ? '<br><strong>Evidence:</strong> ' + esc(x.evidence) : '') + '</div></details></div>';
      }).join('') + '</div>';
    }
    html += '<div class="mk-generate">' +
      '<label>Write <select id="mkGenCount" class="soc-select"><option>2</option><option selected>3</option><option>4</option></select> new ads</label>' +
      '<input type="text" id="mkGenInstr" class="mk-input" placeholder="Optional steer, e.g. “two after-led angles, one about eConsults”" maxlength="400">' +
      '<button type="button" class="btn-primary" data-act="generate"' + (state.busy.generate || !d.anthropic_configured ? ' disabled' : '') + '>' +
        (state.busy.generate ? 'Writing… (about a minute)' : 'Generate new ads') + '</button>' +
      '<span class="soc-when">The model writes complete ads (image line, headline, three paragraphs, photo brief) applying the ticked rules, built on the patterns that book and written to the objections leads actually raise. They land below as drafts for you to edit. ' +
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
    if (act === 'subtab') {
      var k = btn.getAttribute('data-subtab');
      if (SUBTABS.some(function (t) { return t.key === k; }) && k !== state.subtab) { state.subtab = k; saveSubtab(k); render(); }
      return;
    }
    if (act === 'todo') return toggleTodo(btn.getAttribute('data-key'), !!btn.checked);
    if (act === 'refresh') return refresh();
    if (act === 'review') return runReview();
    if (act === 'generate') return generate();
    if (act === 'apply-changes') return applyChanges();
    if (act === 'apply-automation') return applyAutomation();
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
    if (!ids.length && !instr && !window.confirm('No rules are ticked and no steer is given. Write ' + count + ' ads from the account rules alone?')) return;
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

  // The ticked changes to the app's own automation: one round trip, then the
  // page reloads so the list shows what happened to each and the settings
  // disclosure shows the new values.
  function applyAutomation() {
    if (state.busy.automation) return;
    var d = state.data || {};
    var review = d.review && d.review.review ? d.review.review : null;
    if (!review || !d.review.id) { A.toast('There is no review to apply changes from.', 'error'); return; }
    var ids = [], lines = [];
    var boxes = document.querySelectorAll('#soc-hub-root .mk-auto-check:checked:not(:disabled)');
    for (var i = 0; i < boxes.length; i++) ids.push(boxes[i].value);
    if (!ids.length) { A.toast('Tick at least one change first.', 'error'); return; }
    (review.automation_changes || []).forEach(function (c) { if (ids.indexOf(c.id) !== -1) lines.push('• ' + (c.effect || c.title)); });
    if (!window.confirm('Change ' + ids.length + ' automation setting' + (ids.length === 1 ? '' : 's') + ' now? The next cron pass uses the new values.\n\n' + lines.join('\n'))) return;
    state.busy.automation = true; render();
    A.toast('Changing ' + ids.length + ' setting' + (ids.length === 1 ? '' : 's') + '…');
    A.api('/api/ceo/ads/automation/apply', { method: 'POST', body: { review_id: d.review.id, ids: ids } }).then(function (r) {
      state.busy.automation = false;
      if (!r || !r.ok) { A.toast((r && r.message) || 'Could not change the settings.', 'error'); render(); return; }
      A.toast(r.summary || 'Done.', r.counts && r.counts.failed ? 'error' : undefined);
      return load(true);
    });
  }

  // A "Do today" tick the app cannot act on itself. Painted at once, saved on
  // the review; put back the way it was if the save fails.
  function toggleTodo(key, done) {
    var d = state.data || {};
    if (!key || !d.review || !d.review.id) { A.toast('There is no review to tick against.', 'error'); return; }
    var review = d.review.review || (d.review.review = {});
    var before = review.todos ? Object.assign({}, review.todos) : {};
    review.todos = Object.assign({}, before);
    if (done) review.todos[key] = { done_at: new Date().toISOString() }; else delete review.todos[key];
    render();
    A.api('/api/ceo/ads/review/todo', { method: 'POST', body: { review_id: d.review.id, key: key, done: !!done } }).then(function (r) {
      if (!r || !r.ok) { A.toast((r && r.message) || 'Could not save the tick.', 'error'); review.todos = before; render(); return; }
      if (r.todos) review.todos = r.todos;
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

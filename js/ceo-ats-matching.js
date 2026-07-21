/* ============================================================================
 * ceo-ats-matching.js, Matching board (funnel-board UI) for the in-app CEO
 * ATS. Classic <script> (NOT a module). Loaded by pages/ceo-dashboard.html
 * after ceo-ats-shared.js (which exposes window.ATS) and the other
 * ceo-ats-*.js tab modules. Renders into #panel-matching. Exposes
 * window.loadMatchingTab.
 *
 * Task 5 (spec docs/superpowers/specs/2026-07-11-matching-board-design.md,
 * Part A), rewrite of the old job/GP picker into a glanceable board: one
 * row per open position (or, flipped, per GP), a funnel line of avatars
 * running from the practice out through the live pipeline (solid) into AI
 * suggestions (dashed), click-to-expand for the ranked-matches detail panel.
 *
 * Data source: GET /api/ats/matching/board?direction=positions|gps&q= (Task
 * 4), ONE call renders the whole board; this module never triggers an AI
 * ranking on its own. Running an AI ranking (empty-state "Run AI ranking" /
 * an age chip's "refresh") still goes through the existing
 * GET /api/ats/matching/candidates?job_id= | /api/ats/matching/jobs?user_id=
 * (+&force=1), and shortlisting still goes through the existing
 * POST /api/ats/matching/shortlist {items:[{user_id, career_role_id}]},
 * this module is a new *view* over the same write endpoints, not a new
 * write path.
 *
 * Rendering is built from small pure functions (data in, HTML string out),
 * mbKpisHtml/mbRowHtml/mbGpRowHtml/mbNodeHtml/mbExpandHtml and friends,
 * exposed read-only on window.MatchingBoard purely so
 * tests/matching-board-ui.test.js can drive them directly with sample data
 * shaped like the Task 4 endpoint's response. Nothing in this module reads
 * window.MatchingBoard back, it is a test seam, not a runtime dependency.
 * ========================================================================== */
(function () {
  'use strict';

  var A = window.ATS;
  if (!A) { console.error('[ATS] ceo-ats-matching.js loaded before window.ATS'); return; }

  function panelEl() { return document.getElementById('panel-matching'); }

  /* ============================================================
   * Constants
   * ========================================================== */

  // Legend / node styling for the non-shortlisted pipeline stages. 'shortlisted'
  // is handled separately (mbMatchSubLabel) since its sub-label comes from the
  // match{} object (expiry/nudge/more-time), not a fixed label + time-in-stage.
  var PIPELINE_STAGE_META = {
    offer: { cls: 'offer', label: 'Offer sent · awaiting sign', useTime: false },
    interview: { cls: 'interview', label: 'Interview', useTime: true },
    reviewing: { cls: 'submitted', label: 'With practice', useTime: true },
    submitted: { cls: 'submitted', label: 'With practice', useTime: true },
    applied: { cls: 'applied', label: 'Applied', useTime: true }
  };
  // Short stage pill text used inside the expand panel's pipeline rows.
  var EXPAND_STAGE_LABELS = {
    shortlisted: 'Awaiting reply', applied: 'Applied', submitted: 'With practice',
    reviewing: 'With practice', interview: 'Interview', offer: 'Offer'
  };
  var AU_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];

  // Board display order for pipeline/live nodes: most-progressed first (offer
  // nearest the practice). The Task 4 endpoint already returns rows in this
  // order (its tests pin it), but the board must not silently depend on the
  // server's ordering, both the funnel line and the expand panel sort
  // defensively via mbSortPipeline (mirrors server.js
  // MATCHING_BOARD_STAGE_RANK).
  var MB_STAGE_RANK = { offer: 0, interview: 1, reviewing: 2, submitted: 3, applied: 4, shortlisted: 5 };
  function mbStageRank(stage) {
    var r = MB_STAGE_RANK[stage];
    return (r === undefined) ? 99 : r;
  }
  function mbSortPipeline(list) {
    return (list || []).slice().sort(function (a, b) { return mbStageRank(a.ats_stage) - mbStageRank(b.ats_stage); });
  }

  /* ============================================================
   * Pure helpers, dates, buckets, labels. No DOM, no escaping (the HTML
   * builders below apply A.esc/A.escAttr at the point of interpolation).
   * ========================================================== */

  // Left-block urgency bucket for a position row: red >=60 days unfilled,
  // amber >=30, green otherwise (spec Part A, row anatomy).
  function mbUrgencyBucket(daysOpen) {
    var d = daysOpen || 0;
    if (d >= 60) return 'red';
    if (d >= 30) return 'amber';
    return 'green';
  }

  // Whole-unit elapsed time since an ISO stage_updated_at, formatted like the
  // mockup ("3d" / "14h"). No interview_at field exists on the board payload
  // (Task 4 deviation), every non-shortlisted pipeline sub-label is built
  // from this, never a specific date.
  function mbTimeInStage(iso, nowMs) {
    if (!iso) return '';
    var ms = nowMs - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    var hours = Math.floor(ms / 3600000);
    if (hours < 24) return hours + 'h';
    return Math.floor(hours / 24) + 'd';
  }

  function mbStageLabel(stage) {
    return EXPAND_STAGE_LABELS[stage] || String(stage || '');
  }

  // A shortlisted pipeline/live node's sub-label + colour class, driven
  // entirely by its match{} object. Order matters (spec Part A + Part D):
  // an "asked for more time" flag always wins over the plain countdown, even
  // when the match still has days left, it REPLACES the countdown, it does
  // not require <24h. Then: resolved outcomes, then <24h expiring (amber
  // pulse + optional "· nudged ✓"), then a plain "Awaiting · Nd left".
  function mbMatchSubLabel(match, nowMs) {
    if (!match) return { text: 'Awaiting reply', cls: 'await' };
    if (match.more_time_requested_at) return { text: '🙋 asked for more time', cls: 'expiring' };
    if (match.outcome === 'accepted') return { text: 'Accepted ✓', cls: 'offer' };
    if (match.outcome === 'expired') return { text: 'Expired, no response', cls: 'expiring' };
    var expiresMs = match.expires_at ? new Date(match.expires_at).getTime() : null;
    if (expiresMs != null && Number.isFinite(expiresMs)) {
      var msLeft = expiresMs - nowMs;
      if (msLeft <= 0) return { text: 'Expired, no response', cls: 'expiring' };
      var hoursLeft = Math.floor(msLeft / 3600000);
      if (hoursLeft < 24) {
        var nudged = match.final_reminder_sent_at ? ' · nudged ✓' : '';
        return { text: '⏳ Expires in ' + hoursLeft + 'h' + nudged, cls: 'expiring' };
      }
      var daysLeft = Math.ceil(hoursLeft / 24);
      return { text: 'Awaiting · ' + daysLeft + 'd left', cls: 'await' };
    }
    return { text: 'Awaiting reply', cls: 'await' };
  }

  // "Extend 5 days" visibility (spec: expiring <24h, expired, or asked-for-
  // more-time, never for a resolved accepted/declined match).
  function mbShouldShowExtend(match, nowMs) {
    if (!match) return false;
    if (match.outcome === 'accepted' || match.outcome === 'declined') return false;
    if (match.more_time_requested_at) return true;
    if (match.outcome === 'expired') return true;
    if (match.expires_at) {
      var msLeft = new Date(match.expires_at).getTime() - nowMs;
      if (!Number.isFinite(msLeft)) return false;
      if (msLeft <= 0) return true;
      if (Math.floor(msLeft / 3600000) < 24) return true;
    }
    return false;
  }

  // Two-tier score band (fit quality, high is good, so this is intentionally
  // NOT the same "hot/warm/cold" intent-scoring convention used elsewhere in
  // the ATS, which scores urgency rather than fit).
  function mbScoreBand(score) { return (score != null && score >= 85) ? 'hi' : 'mid'; }

  function mbShortDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getDate() + ' ' + months[d.getMonth()];
  }

  // Whole days between two ISO timestamps, used for a filled row's "was
  // unfilled Nd" line (posted -> hired), computed client-side from fields the
  // board endpoint already returns rather than asking for a new one.
  function mbDaysBetween(fromIso, toIso) {
    if (!fromIso || !toIso) return null;
    var a = new Date(fromIso).getTime(), b = new Date(toIso).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    var d = Math.floor((b - a) / 86400000);
    return d >= 0 ? d : null;
  }

  function mbTextMatches(q, fields) {
    var needle = String(q || '').trim().toLowerCase();
    if (!needle) return true;
    return fields.some(function (f) { return String(f || '').toLowerCase().indexOf(needle) !== -1; });
  }

  /* ============================================================
   * Node adapters, normalise a pipeline/live/suggestion entry into the
   * plain {name, score, cls, sub, dimmed, dataId} shape mbNodeHtml renders.
   * ========================================================== */

  function mbPipelineNode(p, nowMs) {
    if (p.ats_stage === 'shortlisted') {
      var sub = mbMatchSubLabel(p.match, nowMs);
      return { name: p.name, score: p.match ? p.match.score : null, cls: sub.cls, sub: sub.text, dataId: p.user_id };
    }
    var meta = PIPELINE_STAGE_META[p.ats_stage] || { cls: 'applied', label: mbStageLabel(p.ats_stage), useTime: true };
    var subText = meta.useTime === false ? meta.label : (meta.label + ' · ' + mbTimeInStage(p.stage_updated_at, nowMs));
    return { name: p.name, score: null, cls: meta.cls, sub: subText, dataId: p.user_id };
  }
  function mbSuggestionNode(s) {
    return { name: s.name, score: s.score, cls: 'sugg', sub: 'Suggested', dimmed: true, dataId: s.user_id };
  }
  function mbGpLiveNode(l, nowMs) {
    var label = l.practice_name || l.title || 'Role';
    if (l.ats_stage === 'shortlisted') {
      var sub = mbMatchSubLabel(l.match, nowMs);
      return { name: label, score: l.match ? l.match.score : null, cls: sub.cls, sub: sub.text, dataId: l.career_role_id };
    }
    var meta = PIPELINE_STAGE_META[l.ats_stage] || { cls: 'applied', label: mbStageLabel(l.ats_stage), useTime: true };
    var subText = meta.useTime === false ? meta.label : (meta.label + ' · ' + mbTimeInStage(l.stage_updated_at, nowMs));
    return { name: label, score: null, cls: meta.cls, sub: subText, dataId: l.career_role_id };
  }
  function mbGpSuggestionNode(s) {
    return { name: s.practice_name || s.title || 'Role', score: s.score, cls: 'sugg', sub: 'Suggested', dimmed: true, dataId: s.career_role_id };
  }

  /* ============================================================
   * Builder functions, pure(-ish) data -> HTML string. Exposed on
   * window.MatchingBoard at the bottom of this file for direct testing.
   * ========================================================== */

  function mbNodeHtml(node) {
    node = node || {};
    var name = node.name || '-';
    var initials = A.initials(name);
    var color = A.avatarColor(name);
    var band = mbScoreBand(node.score);
    var scorePill = (node.score != null) ? ('<span class="ats-mb-scorepill ' + band + '">' + A.esc(node.score) + '</span>') : '';
    return (
      '<div class="ats-mb-gnode ' + (node.cls || '') + (node.dimmed ? ' sugg' : '') + '" data-mb-node="' + A.escAttr(node.dataId) + '">' +
        '<div class="ats-mb-gav" style="background:' + color + '">' + A.esc(initials) + '</div>' +
        '<div><div class="ats-mb-gname">' + A.esc(name) + '</div>' +
        '<div class="ats-mb-stg ' + (node.cls || '') + '">' + A.esc(node.sub || '') + '</div></div>' +
        scorePill +
      '</div>'
    );
  }

  // Shimmer placeholder + honest "still working" copy (Part D: "🤖 Ranking {N}
  // eligible GPs against this position… usually 10–20 seconds"). N is
  // genuinely unknown while the AI run is still in flight, the moment we DO
  // know it, the run is over and this state is gone, so the placeholder
  // never fabricates a count; it stays generic the whole time it's shown.
  function mbRunningTrackHtml(kind) {
    var msg = (kind === 'gps')
      ? '🤖 Ranking eligible jobs for this GP… usually 10–20 seconds'
      : '🤖 Ranking eligible GPs against this position… usually 10–20 seconds';
    return (
      '<div class="ats-mb-ghost"></div><div class="ats-mb-ghost"></div><div class="ats-mb-ghost"></div>' +
      '<div class="ats-mb-scanmsg">' + msg + '</div>'
    );
  }

  function mbAgeChipHtml(ranking, id) {
    if (!ranking) return '';
    var ageHours = ranking.age_hours || 0;
    var label = ageHours < 24 ? 'ranked today' : ('ranked ' + Math.floor(ageHours / 24) + 'd ago');
    return '<button type="button" class="ats-mb-agechip" data-mb-refresh="' + A.escAttr(id) + '">' + label + ' · ↻ refresh</button>';
  }

  // Positions-direction track: solid pipeline zone -> dashed suggestions zone,
  // capped at 6 total nodes (spec: "Max 6 nodes total on the line, then +n ▸").
  // Empty state (no pipeline AND no cached ranking) shows only the run button.
  function mbTrackHtml(row, nowMs) {
    var job = (row && row.job) || {};
    var pipeline = mbSortPipeline((row && row.pipeline) || []);
    var suggestions = (row && row.suggestions) || [];
    var ranking = (row && row.ranking) || null;
    if (!pipeline.length && !ranking) {
      return '<button type="button" class="ats-mb-runbtn" data-mb-run="' + A.escAttr(job.id) + '">⚡ Run AI ranking</button>';
    }
    var budget = 6;
    var pipeHtml = '';
    pipeline.forEach(function (p) { if (budget <= 0) return; pipeHtml += mbNodeHtml(mbPipelineNode(p, nowMs)); budget--; });
    var suggHtml = '';
    suggestions.forEach(function (s) { if (budget <= 0) return; suggHtml += mbNodeHtml(mbSuggestionNode(s)); budget--; });
    var hidden = (pipeline.length + suggestions.length) - (6 - budget);
    var moreHtml = hidden > 0 ? ('<div class="ats-mb-more">+' + hidden + ' ▸</div>') : '';
    var ageHtml = mbAgeChipHtml(ranking, job.id);
    return (
      (pipeHtml ? '<div class="ats-mb-pipezone">' + pipeHtml + '</div>' : '') +
      ((suggHtml || moreHtml || ageHtml) ? ('<div class="ats-mb-suggzone">' + suggHtml + moreHtml + ageHtml + '</div>') : '')
    );
  }

  // GPs-direction mirror of mbTrackHtml (live[] instead of pipeline[]).
  function mbGpTrackHtml(row, nowMs) {
    var gp = (row && row.gp) || {};
    var live = mbSortPipeline((row && row.live) || []);
    var suggestions = (row && row.suggestions) || [];
    var ranking = (row && row.ranking) || null;
    if (!live.length && !ranking) {
      return '<button type="button" class="ats-mb-runbtn" data-mb-run="' + A.escAttr(gp.user_id) + '">⚡ Run AI ranking</button>';
    }
    var budget = 6;
    var liveHtml = '';
    live.forEach(function (l) { if (budget <= 0) return; liveHtml += mbNodeHtml(mbGpLiveNode(l, nowMs)); budget--; });
    var suggHtml = '';
    suggestions.forEach(function (s) { if (budget <= 0) return; suggHtml += mbNodeHtml(mbGpSuggestionNode(s)); budget--; });
    var hidden = (live.length + suggestions.length) - (6 - budget);
    var moreHtml = hidden > 0 ? ('<div class="ats-mb-more">+' + hidden + ' ▸</div>') : '';
    var ageHtml = mbAgeChipHtml(ranking, gp.user_id);
    return (
      (liveHtml ? '<div class="ats-mb-pipezone">' + liveHtml + '</div>' : '') +
      ((suggHtml || moreHtml || ageHtml) ? ('<div class="ats-mb-suggzone">' + suggHtml + moreHtml + ageHtml + '</div>') : '')
    );
  }

  // Corporate groups (ForHealth, GP West Group, …) post many openings under
  // one practice_name; the opening's own name lives after the legacy "||"
  // separator in the title. The board leads with the opening and shows the
  // group as a small click-through tile instead (owner call 2026-07-12).
  function mbPracticeDisplay(job) {
    job = job || {};
    var raw = String(job.title || '');
    var idx = raw.indexOf('||');
    var role = (idx === -1 ? raw : raw.slice(0, idx)).trim();
    var opening = idx === -1 ? '' : raw.slice(idx + 2).trim();
    var norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); };
    var pname = job.practice_name || '';
    var isGroup = !!(opening && pname && norm(opening) !== norm(pname));
    return {
      heading: (isGroup ? opening : (pname || opening || role)) || 'Practice',
      sub: role,
      groupName: isGroup ? pname : ''
    };
  }

  function mbGroupTileHtml(disp, job) {
    if (!disp.groupName || !job.practice_id) return '';
    return '<button type="button" class="ats-mb-corp" data-mb-open-practice="' + A.escAttr(job.practice_id) + '">🏢 ' + A.esc(disp.groupName) + '</button>';
  }

  // ctx: { expandedId, runningIds, nowMs }, a subset of the module's state
  // object (or an equivalent plain object from a test).
  // Click model (owner call 2026-07-12): the practice card opens the job
  // opening's page; the group tile (corps only) opens the practice page; the
  // track side still toggles the expand panel via the row-level handler.
  function mbRowHtml(row, ctx) {
    ctx = ctx || {};
    var job = (row && row.job) || {};
    var nowMs = ctx.nowMs || Date.now();
    var bucket = mbUrgencyBucket(job.days_open);
    var expanded = ctx.expandedId != null && String(ctx.expandedId) === String(job.id);
    var running = !!(ctx.runningIds && ctx.runningIds[job.id]);
    var disp = mbPracticeDisplay(job);
    var pinitials = A.initials(disp.heading);
    var pcolor = A.avatarColor(disp.heading);
    var practiceClickable = (!disp.groupName && job.practice_id) ? (' data-mb-open-practice="' + A.escAttr(job.practice_id) + '"') : '';
    var loc = [job.suburb, job.city].filter(Boolean).join(', ') || job.city || '-';
    var trackHtml = running ? mbRunningTrackHtml('positions') : mbTrackHtml(row, nowMs);
    return (
      '<div class="ats-mb-row ' + bucket + (expanded ? ' expanded' : '') + '" data-mb-row="' + A.escAttr(job.id) + '">' +
        '<div class="ats-mb-left"' + (job.id != null ? (' data-mb-open-job="' + A.escAttr(job.id) + '"') : '') + '>' +
          '<div class="ats-mb-inner">' +
            '<div class="ats-mb-prow">' +
              '<div class="ats-mb-plogo" style="background:' + pcolor + '"' + practiceClickable + '>' + A.esc(pinitials) + '</div>' +
              '<div><div class="ats-mb-pname">' + A.esc(disp.heading) + '</div>' +
              '<div class="ats-mb-ploc">📍 ' + A.esc(loc) + (job.state ? ', ' + A.esc(job.state) : '') + '</div></div>' +
            '</div>' +
            mbGroupTileHtml(disp, job) +
            '<div><span class="ats-mb-urg ' + bucket + '">' + (job.days_open || 0) + ' days unfilled</span></div>' +
            '<div class="ats-mb-postitle">' + A.esc(disp.sub || 'Role') + (job.type ? ' · ' + A.esc(job.type) : '') + (job.dpa ? ' · DPA' : '') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="ats-mb-track">' + trackHtml + '</div>' +
      '</div>'
    );
  }

  // GPs-direction mirror of mbRowHtml. Left block: GP avatar/name (click ->
  // GP file) + urgency chip driven by days_on_books + whether anything was
  // ever sent (spec Part A "GPs -> Positions"). No country/preference line,
  // the board endpoint's gp{} carries only user_id/name/email/days_on_books,
  // so nothing here is fabricated beyond what the payload actually returns.
  function mbGpRowHtml(row, ctx) {
    ctx = ctx || {};
    var gp = (row && row.gp) || {};
    var nowMs = ctx.nowMs || Date.now();
    var live = (row && row.live) || [];
    var noSent = live.length === 0;
    var days = gp.days_on_books || 0;
    var bucket = noSent ? (days >= 21 ? 'red' : days >= 7 ? 'amber' : 'green') : 'green';
    var urgLabel = noSent ? (days + ' days on the books · no matches sent') : (days + ' days on the books');
    var expanded = ctx.expandedId != null && String(ctx.expandedId) === String(gp.user_id);
    var running = !!(ctx.runningIds && ctx.runningIds[gp.user_id]);
    var initials = A.initials(gp.name);
    var color = A.avatarColor(gp.name);
    var trackHtml = running ? mbRunningTrackHtml('gps') : mbGpTrackHtml(row, nowMs);
    return (
      '<div class="ats-mb-row ' + bucket + (expanded ? ' expanded' : '') + '" data-mb-row="' + A.escAttr(gp.user_id) + '">' +
        '<div class="ats-mb-left">' +
          '<div class="ats-mb-inner">' +
            '<div class="ats-mb-prow">' +
              '<div class="ats-mb-gav" style="background:' + color + '" data-mb-open-cand="' + A.escAttr(gp.user_id) + '">' + A.esc(initials) + '</div>' +
              '<div><div class="ats-mb-pname" data-mb-open-cand="' + A.escAttr(gp.user_id) + '">' + A.esc(gp.name || 'GP') + '</div>' +
              (gp.email ? ('<div class="ats-mb-ploc">' + A.esc(gp.email) + '</div>') : '') + '</div>' +
            '</div>' +
            '<div><span class="ats-mb-urg ' + bucket + '">' + A.esc(urgLabel) + '</span></div>' +
          '</div>' +
        '</div>' +
        '<div class="ats-mb-track">' + trackHtml + '</div>' +
      '</div>'
    );
  }

  function mbKpiTile(key, value, label, cls, active) {
    return (
      '<div class="ats-mb-kpi' + (cls ? ' ' + cls : '') + (active ? ' active' : '') + '" data-mb-kpi="' + key + '">' +
        '<div class="ats-mb-kv">' + A.esc(value) + '</div>' +
        '<div class="ats-mb-kl">' + A.esc(label) + '</div>' +
      '</div>'
    );
  }

  // filters is optional, mbKpisHtml(kpis) alone renders with nothing active.
  function mbKpisHtml(kpis, filters) {
    kpis = kpis || {};
    filters = filters || {};
    return (
      '<div class="ats-mb-kpis">' +
        mbKpiTile('open', kpis.open == null ? '-' : kpis.open, 'OPEN POSITIONS', '', false) +
        mbKpiTile('unfilled60', kpis.unfilled60 == null ? '-' : kpis.unfilled60, 'UNFILLED 60+ DAYS', 'hot', filters.urgency === '60') +
        mbKpiTile('awaiting', kpis.awaiting == null ? '-' : kpis.awaiting, 'AWAITING GP REPLY', 'wait', filters.status === 'awaiting') +
        mbKpiTile('acceptedWeek', kpis.accepted_week == null ? '-' : kpis.accepted_week, 'ACCEPTED THIS WEEK', 'win', filters.status === 'acceptedWeek') +
      '</div>'
    );
  }

  function mbFlipHtml(direction) {
    return (
      '<div class="ats-mb-flip">' +
        '<button type="button" class="' + (direction === 'gps' ? '' : 'on') + '" data-mb-flip="positions">Positions → GPs</button>' +
        '<button type="button" class="' + (direction === 'gps' ? 'on' : '') + '" data-mb-flip="gps">GPs → Positions</button>' +
      '</div>'
    );
  }

  function mbLegendHtml() {
    return (
      '<div class="ats-mb-legend">' +
        '<span class="ats-mb-lg"><i class="ats-mb-lgdot offer"></i>Offer</span>' +
        '<span class="ats-mb-lg"><i class="ats-mb-lgdot interview"></i>Interview</span>' +
        '<span class="ats-mb-lg"><i class="ats-mb-lgdot submitted"></i>With practice</span>' +
        '<span class="ats-mb-lg"><i class="ats-mb-lgdot await"></i>Awaiting reply</span>' +
        '<span class="ats-mb-lg"><i class="ats-mb-lgdot expiring"></i>Expiring &lt;24h</span>' +
        '<span class="ats-mb-lg"><i class="ats-mb-lgdot sugg"></i>Suggested (not contacted)</span>' +
      '</div>'
    );
  }

  function mbChip(label, count, filterKey, active, extraCls) {
    var countStr = (count == null) ? '' : (' (' + count + ')');
    return (
      '<button type="button" class="ats-mb-chip' + (active ? ' on' : '') + (extraCls ? ' ' + extraCls : '') + '" data-mb-filter="' + filterKey + '">' +
        A.esc(label) + countStr +
      '</button>'
    );
  }

  function mbStateSelectHtml(current) {
    var opts = ['<option value="">All states</option>'].concat(AU_STATES.map(function (s) {
      return '<option value="' + A.escAttr(s) + '"' + (s === current ? ' selected' : '') + '>' + s + '</option>';
    }));
    return '<select class="ats-mb-state-select" data-mb-state>' + opts.join('') + '</select>';
  }

  // Top-bar sort control (spec Part A item 2: "sort (default: longest
  // unfilled first)"; gps flip default "nothing-sent + oldest first" reads
  // as "Waiting longest").
  function mbSortSelectHtml(direction, sort) {
    var opts = (direction === 'gps')
      ? [['default', 'Waiting longest'], ['az', 'GP A–Z']]
      : [['default', 'Longest unfilled'], ['az', 'Practice A–Z']];
    var cur = sort || 'default';
    return '<select class="ats-mb-sort-select" data-mb-sort>' + opts.map(function (o) {
      return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('') + '</select>';
  }

  // Row-level sort, applied in renderBoard after filtering and before the
  // 25-row slice. Array.prototype.sort is stable in every supported engine,
  // so ties keep the server's order (which matters for the gps direction's
  // signal-first grouping among equal days_on_books).
  function mbSortRows(rows, direction, sort) {
    var out = (rows || []).slice();
    var isGp = direction === 'gps';
    if (sort === 'az') {
      out.sort(function (a, b) {
        var an = isGp ? ((a.gp && a.gp.name) || '') : ((a.job && a.job.practice_name) || '');
        var bn = isGp ? ((b.gp && b.gp.name) || '') : ((b.job && b.job.practice_name) || '');
        return String(an).localeCompare(String(bn));
      });
    } else {
      out.sort(function (a, b) {
        var ad = isGp ? ((a.gp && a.gp.days_on_books) || 0) : ((a.job && a.job.days_open) || 0);
        var bd = isGp ? ((b.gp && b.gp.days_on_books) || 0) : ((b.job && b.job.days_open) || 0);
        return bd - ad;
      });
    }
    return out;
  }

  // rows: the CURRENT direction's full (unfiltered) row list, chip counts
  // are faceted against the full set, independent of the other active
  // filters, so a chip always answers "how many if I click me right now".
  // The state dropdown + DPA chip only apply to positions (no location/DPA
  // field exists on a gps-direction row); the "Ready to place" segmentation
  // shown in the design mockup has no backing field on this endpoint either,
  // so it is intentionally not built here rather than faked.
  function mbFilterChipsHtml(direction, rows, filters) {
    rows = rows || [];
    filters = filters || {};
    var isGp = direction === 'gps';
    var chips = [];
    if (!isGp) {
      var c60 = rows.filter(function (r) { return (r.job.days_open || 0) >= 60; }).length;
      var c30 = rows.filter(function (r) { return (r.job.days_open || 0) >= 30; }).length;
      var cNo = rows.filter(function (r) { return (r.pipeline || []).length === 0; }).length;
      var cAwait = rows.filter(function (r) { return (r.pipeline || []).some(function (p) { return p.ats_stage === 'shortlisted'; }); }).length;
      chips.push(mbChip('60d+', c60, 'urgency:60', filters.urgency === '60', 'hot'));
      chips.push(mbChip('30d+', c30, 'urgency:30', filters.urgency === '30'));
      chips.push(mbChip('No matches sent', cNo, 'status:nomatches', filters.status === 'nomatches'));
      chips.push(mbChip('Awaiting reply', cAwait, 'status:awaiting', filters.status === 'awaiting'));
    } else {
      var gNo = rows.filter(function (r) { return (r.live || []).length === 0; }).length;
      var gAwait = rows.filter(function (r) { return (r.live || []).some(function (l) { return l.ats_stage === 'shortlisted'; }); }).length;
      chips.push(mbChip('No matches sent', gNo, 'status:nomatches', filters.status === 'nomatches'));
      chips.push(mbChip('Awaiting reply', gAwait, 'status:awaiting', filters.status === 'awaiting'));
    }
    var stateSelect = !isGp ? mbStateSelectHtml(filters.state) : '';
    var dpaChip = !isGp ? mbChip('DPA only', null, 'dpa:1', !!filters.dpa) : '';
    var sortSelect = mbSortSelectHtml(direction, filters.sort);
    var search = '<input type="text" class="ats-mb-search" data-mb-search placeholder="🔍 Search…" value="' + A.escAttr(filters.q || '') + '" />';
    return '<div class="ats-mb-toolbar-row">' + chips.join('') + stateSelect + dpaChip + sortSelect + search + '</div>';
  }

  function mbFilledToggleHtml(count, active) {
    return (
      '<button type="button" class="ats-mb-chip won' + (active ? ' on' : '') + '" data-mb-filter="filled:1">' +
        '✓ Filled last 30 days (' + (count || 0) + ')' + (active ? ', showing' : '') +
      '</button>'
    );
  }

  // Verbatim (Part D): "✓ FILLED, {Dr Name} · {D Mon}" /
  // "{N} other GPs redirected to similar roles · redirect emails sent ✓".
  function mbFilledRowHtml(f) {
    f = f || {};
    var job = f.job || {};
    var hired = f.hired || null;
    var disp = mbPracticeDisplay(job);
    var initials = A.initials(disp.heading);
    var color = A.avatarColor(disp.heading);
    var wasUnfilled = mbDaysBetween(job.posted, hired && hired.at);
    var hiredLine = hired
      ? ('✓ FILLED, ' + A.esc(hired.name || 'Unknown') + ' · ' + mbShortDate(hired.at))
      : '✓ FILLED';
    var redirectLine = f.redirected_count
      ? (f.redirected_count + ' other GP' + (f.redirected_count === 1 ? '' : 's') + ' redirected to similar roles · redirect emails sent ✓')
      : '';
    var practiceClickable = (!disp.groupName && job.practice_id) ? (' data-mb-open-practice="' + A.escAttr(job.practice_id) + '"') : '';
    return (
      '<div class="ats-mb-row filled">' +
        '<div class="ats-mb-left"><div class="ats-mb-inner">' +
          '<div class="ats-mb-prow">' +
            '<div class="ats-mb-plogo" style="background:' + color + '"' + practiceClickable + '>' + A.esc(initials) + '</div>' +
            '<div><div class="ats-mb-pname"' + practiceClickable + '>' + A.esc(disp.heading) + '</div>' +
            '<div class="ats-mb-ploc">📍 ' + A.esc(job.city || '-') + (job.state ? ', ' + A.esc(job.state) : '') + '</div></div>' +
          '</div>' +
          mbGroupTileHtml(disp, job) +
          '<div class="ats-mb-postitle">' + A.esc(disp.sub || 'Role') + (wasUnfilled != null ? (' · was unfilled ' + wasUnfilled + ' days') : '') + '</div>' +
        '</div></div>' +
        '<div class="ats-mb-filledtrack">' +
          '<span class="ats-mb-winbadge">' + hiredLine + '</span>' +
          (redirectLine ? ('<span class="ats-mb-winsub">' + A.esc(redirectLine) + '</span>') : '') +
        '</div>' +
      '</div>'
    );
  }

  /* ---------------- expand panel ---------------- */

  function mbExpandPipelineRowHtml(entry, isGp, nowMs) {
    var name = isGp ? (entry.practice_name || entry.title || 'Role') : (entry.name || '-');
    var openId = isGp ? entry.career_role_id : entry.user_id;
    var initials = A.initials(name);
    var color = A.avatarColor(name);
    var stageLabel = mbStageLabel(entry.ats_stage);
    var subInfo, showExtend = false;
    if (entry.ats_stage === 'shortlisted') {
      var sub = mbMatchSubLabel(entry.match, nowMs);
      subInfo = sub.text;
      showExtend = mbShouldShowExtend(entry.match, nowMs);
    } else {
      subInfo = mbTimeInStage(entry.stage_updated_at, nowMs) + ' in stage';
    }
    var scorePill = (entry.match && entry.match.score != null) ? (' <span class="ats-pill blue">' + A.esc(entry.match.score) + ' match</span>') : '';
    var openBtn = isGp
      ? ('<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-mb-open-job="' + A.escAttr(openId) + '">Open job board</button>')
      : ('<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-mb-open-cand="' + A.escAttr(openId) + '">Open GP file</button>');
    var extendBtn = showExtend
      ? ('<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-mb-extend="' + A.escAttr(entry.application_id) + '">Extend 5 days</button>')
      : '';
    return (
      '<div class="ats-mb-exrow">' +
        '<div class="ats-mb-exgav" style="background:' + color + '">' + A.esc(initials) + '</div>' +
        '<div class="ats-mb-exbody">' +
          '<div class="ats-mb-exname">' + A.esc(name) + scorePill + ' <span class="ats-pill muted">' + A.esc(stageLabel) + '</span></div>' +
          '<div class="ats-mb-exsub">' + A.esc(subInfo) + '</div>' +
        '</div>' +
        '<div class="ats-mb-exactions">' + extendBtn + openBtn + '</div>' +
      '</div>'
    );
  }

  function mbExpandSuggestionRowHtml(entry, isGp, checked) {
    var name = isGp ? (entry.practice_name || entry.title || 'Role') : (entry.name || '-');
    var id = isGp ? entry.career_role_id : entry.user_id;
    var initials = A.initials(name);
    var color = A.avatarColor(name);
    var reasons = (entry.reasons || []).map(function (r) { return '<div class="ats-mb-tick">' + A.esc(r) + '</div>'; }).join('');
    var chips = (entry.chips || []).map(function (c) { return '<span class="ats-pill blue">' + A.esc(c) + '</span>'; }).join('');
    return (
      '<div class="ats-mb-exrow">' +
        '<input type="checkbox" class="ats-mb-excb" data-mb-cb="' + A.escAttr(id) + '"' + (checked ? ' checked' : '') + ' />' +
        '<div class="ats-mb-exgav" style="background:' + color + '">' + A.esc(initials) + '</div>' +
        '<div class="ats-mb-exbody">' +
          '<div class="ats-mb-exname">' + A.esc(name) + ' <span class="ats-pill ' + (entry.score >= 85 ? 'green' : 'blue') + '">' + (entry.score == null ? '-' : A.esc(entry.score)) + ' match</span></div>' +
          (reasons ? ('<div class="ats-mb-ticks">' + reasons + '</div>') : '') +
          (chips ? ('<div class="ats-mb-chips">' + chips + '</div>') : '') +
        '</div>' +
        '<button type="button" class="ats-mb-exbtn" data-mb-shortlist-one="' + A.escAttr(id) + '">Shortlist &amp; notify</button>' +
      '</div>'
    );
  }

  // row: a positions row ({job,pipeline,suggestions,ranking}) or a gps row
  // ({gp,live,suggestions,ranking}), detected by shape. selection: plain
  // {id:true} map of the currently ticked suggestion ids for THIS row (the
  // module only ever keeps one row's selection live at a time, an accordion,
  // one open row). nowMs optional (defaults Date.now()) purely for
  // deterministic tests.
  function mbExpandHtml(row, selection, nowMs) {
    row = row || {};
    selection = selection || {};
    nowMs = nowMs || Date.now();
    var isGp = !!row.gp;
    var pipelineList = mbSortPipeline(isGp ? (row.live || []) : (row.pipeline || []));
    var suggestions = row.suggestions || [];
    var ranking = row.ranking || null;
    var rowId = isGp ? (row.gp && row.gp.user_id) : (row.job && row.job.id);

    if (!pipelineList.length && !suggestions.length) {
      return (
        '<div class="ats-mb-expand" data-mb-expand-for="' + A.escAttr(rowId) + '">' +
          A.emptyHtml('No matches yet.') +
        '</div>'
      );
    }

    var pipeHtml = pipelineList.map(function (e) { return mbExpandPipelineRowHtml(e, isGp, nowMs); }).join('');
    var suggHtml = suggestions.map(function (s) {
      var id = isGp ? s.career_role_id : s.user_id;
      return mbExpandSuggestionRowHtml(s, isGp, !!selection[id]);
    }).join('');

    var n = 0;
    suggestions.forEach(function (s) { var id = isGp ? s.career_role_id : s.user_id; if (selection[id]) n++; });
    var bulkHtml = suggestions.length ? (
      '<div class="ats-mb-bulkbar">' +
        '<span class="ats-mb-bulk-count">' + n + ' selected</span>' +
        '<span class="ats-mb-bulk-sub">each gets the match email + 5-day window · moves to Shortlist stage</span>' +
        '<button type="button" class="ats-mb-bulkbtn" data-mb-bulk-shortlist' + (n ? '' : ' disabled') + '>Shortlist ' + n + ' &amp; notify ➜</button>' +
      '</div>'
    ) : '';

    var excludedHtml = (ranking && ranking.excluded_count)
      ? (ranking.excluded_count + ' GP' + (ranking.excluded_count === 1 ? '' : 's') + ' excluded before ranking (placed, mid-interview or applications paused)')
      : '';
    var ageHtml = ranking
      ? ((ranking.age_hours < 24 ? 'ranked today' : ('ranked ' + Math.floor(ranking.age_hours / 24) + 'd ago')) +
         ' · <a href="#" class="ats-mb-rerun" data-mb-refresh="' + A.escAttr(rowId) + '">Re-run fresh</a>')
      : '';
    var footerHtml = (excludedHtml || ageHtml)
      ? ('<div class="ats-mb-exclnote">' + [excludedHtml, ageHtml].filter(Boolean).join(' · ') + '</div>')
      : '';

    return (
      '<div class="ats-mb-expand" data-mb-expand-for="' + A.escAttr(rowId) + '">' +
        '<div class="ats-mb-exhead">RANKED MATCHES, review, tick, then notify. Nothing is sent until you click.</div>' +
        pipeHtml + suggHtml + bulkHtml + footerHtml +
      '</div>'
    );
  }

  /* ============================================================
   * Client-side filtering (positions/gps rows against state.filters).
   * ========================================================== */

  function mbFilterPositionsRows(rows, filters) {
    filters = filters || {};
    return (rows || []).filter(function (row) {
      var job = row.job || {};
      if (filters.urgency === '60' && !((job.days_open || 0) >= 60)) return false;
      if (filters.urgency === '30' && !((job.days_open || 0) >= 30)) return false;
      if (filters.status === 'nomatches' && (row.pipeline || []).length !== 0) return false;
      if (filters.status === 'awaiting' && !(row.pipeline || []).some(function (p) { return p.ats_stage === 'shortlisted'; })) return false;
      if (filters.status === 'acceptedWeek' && !(row.pipeline || []).some(function (p) { return p.match && p.match.outcome === 'accepted'; })) return false;
      if (filters.state && job.state !== filters.state) return false;
      if (filters.dpa && job.dpa !== true) return false;
      if (!mbTextMatches(filters.q, [job.practice_name, job.title])) return false;
      return true;
    });
  }

  function mbFilterGpRows(rows, filters) {
    filters = filters || {};
    return (rows || []).filter(function (row) {
      var gp = row.gp || {};
      var live = row.live || [];
      if (filters.status === 'nomatches' && live.length !== 0) return false;
      if (filters.status === 'awaiting' && !live.some(function (l) { return l.ats_stage === 'shortlisted'; })) return false;
      if (!mbTextMatches(filters.q, [gp.name, gp.email])) return false;
      return true;
    });
  }

  /* ============================================================
   * State + wiring
   * ========================================================== */

  var state = {
    direction: 'positions',      // 'positions' | 'gps'
    boardData: null,             // last-fetched board response for the CURRENT direction
    positionsKpis: null,         // kept across a flip to 'gps' (which returns no kpis), spec: "keep rendering the last-known positions KPIs when flipped"
    positionsFilled: null,
    filters: { urgency: '', status: '', state: '', dpa: false, filled: false, q: '', sort: 'default' },
    expandedId: null,            // job.id (positions) or gp.user_id (gps) of the open accordion row, or null
    selection: {},               // {suggestionId: true} for the CURRENTLY EXPANDED row only
    runningIds: {},              // id -> true while a run/refresh fetch is in flight for that row
    visibleCount: 25,
    nowMs: Date.now()
  };
  var panelWired = false;
  var searchDebounce = null;

  function loadMatchingTab() {
    var panel = panelEl();
    if (!panel) return;
    state.expandedId = null;
    state.selection = {};
    state.visibleCount = 25;
    panel.innerHTML = A.loadingHtml('Loading the matching board…');
    if (!panelWired) {
      panel.addEventListener('click', onPanelClick);
      panel.addEventListener('input', onPanelInput);
      panel.addEventListener('change', onPanelChange);
      panelWired = true;
    }
    fetchBoard();
  }

  function fetchBoard() {
    var isGp = state.direction === 'gps';
    var path = '/api/ats/matching/board?direction=' + (isGp ? 'gps' : 'positions');
    if (isGp && state.filters.q) path += '&q=' + encodeURIComponent(state.filters.q);
    A.api(path).then(function (d) {
      if (!d || !d.ok) { state.boardData = null; renderBoard(); return; }
      state.boardData = d;
      if (!isGp) { state.positionsKpis = d.kpis || null; state.positionsFilled = d.filled || null; }
      renderBoard();
    });
  }

  function renderBoard() {
    var panel = panelEl();
    if (!panel) return;
    state.nowMs = Date.now();

    var active = document.activeElement;
    var searchFocused = !!(active && active.getAttribute && active.getAttribute('data-mb-search') != null);
    var selStart = searchFocused ? active.selectionStart : null;
    var selEnd = searchFocused ? active.selectionEnd : null;

    if (!state.boardData) {
      panel.innerHTML = '<div class="ats-section-head"><div><h2>Matching</h2></div></div>' + A.emptyHtml('Could not load the matching board.');
      return;
    }

    var isGp = state.direction === 'gps';
    var allRows = state.boardData.rows || [];
    var kpis = state.positionsKpis || {};
    var filteredRows = isGp ? mbFilterGpRows(allRows, state.filters) : mbFilterPositionsRows(allRows, state.filters);
    filteredRows = mbSortRows(filteredRows, state.direction, state.filters.sort);
    var visibleRows = filteredRows.slice(0, state.visibleCount);
    var showMore = filteredRows.length > visibleRows.length;
    var ctx = { expandedId: state.expandedId, runningIds: state.runningIds, nowMs: state.nowMs };

    var rowsHtml = isGp
      ? visibleRows.map(function (r) { return mbGpRowHtml(r, ctx) + (state.expandedId != null && String(state.expandedId) === String(r.gp.user_id) ? mbExpandHtml(r, state.selection, state.nowMs) : ''); }).join('')
      : visibleRows.map(function (r) { return mbRowHtml(r, ctx) + (state.expandedId != null && String(state.expandedId) === String(r.job.id) ? mbExpandHtml(r, state.selection, state.nowMs) : ''); }).join('');

    var filledSection = '';
    if (!isGp && state.filters.filled) {
      filledSection = (state.positionsFilled || []).map(mbFilledRowHtml).join('');
    }

    var emptyMsg = !visibleRows.length ? A.emptyHtml(isGp ? 'No GPs match these filters.' : 'No open positions match these filters.') : '';

    panel.innerHTML =
      '<div class="ats-section-head"><div><h2>Matching</h2><p>Every open position and every GP, ranked and ready to shortlist, review, then send.</p></div></div>' +
      mbKpisHtml(kpis, state.filters) +
      mbFlipHtml(state.direction) +
      mbFilterChipsHtml(state.direction, allRows, state.filters) +
      (!isGp ? mbFilledToggleHtml((state.positionsFilled || []).length, state.filters.filled) : '') +
      mbLegendHtml() +
      '<div class="ats-mb-rows">' + rowsHtml + '</div>' +
      emptyMsg + filledSection +
      (showMore ? '<button type="button" class="ats-btn ats-btn-ghost" data-mb-show-more="1">Show more</button>' : '');

    if (searchFocused) {
      var input = panel.querySelector('[data-mb-search]');
      if (input) {
        input.focus();
        if (selStart != null && input.setSelectionRange) { try { input.setSelectionRange(selStart, selEnd); } catch (e) { /* ignore */ } }
      }
    }
  }

  /* ---------------- actions ---------------- */

  function mbFindExpandedRow() {
    if (!state.boardData || state.expandedId == null) return null;
    var rows = state.boardData.rows || [];
    var isGp = state.direction === 'gps';
    for (var i = 0; i < rows.length; i++) {
      var key = isGp ? rows[i].gp.user_id : rows[i].job.id;
      if (String(key) === String(state.expandedId)) return rows[i];
    }
    return null;
  }

  function mbSuggestionTitle(row, id, isGp) {
    if (!isGp) return (row.job && row.job.title) || 'this role';
    var s = (row.suggestions || []).filter(function (x) { return String(x.career_role_id) === String(id); })[0];
    return (s && (s.title || s.practice_name)) || 'this role';
  }

  function mbShortlistToast(results) {
    var ok = 0, skipped = 0, failed = 0;
    (results || []).forEach(function (r) { if (r.ok) ok++; else if (r.skipped) skipped++; else failed++; });
    var msg = ok + ' shortlisted';
    if (skipped) msg += ', ' + skipped + ' skipped';
    if (failed) msg += ', ' + failed + ' failed';
    return msg;
  }

  function onRowToggle(id) {
    if (state.expandedId != null && String(state.expandedId) === String(id)) { state.expandedId = null; }
    else { state.expandedId = id; }
    state.selection = {};
    renderBoard();
  }

  function onKpiClick(key) {
    if (key === 'open') { state.filters.urgency = ''; state.filters.status = ''; state.filters.dpa = false; state.filters.state = ''; }
    else if (key === 'unfilled60') { state.filters.urgency = (state.filters.urgency === '60') ? '' : '60'; }
    else if (key === 'awaiting') { state.filters.status = (state.filters.status === 'awaiting') ? '' : 'awaiting'; }
    else if (key === 'acceptedWeek') { state.filters.status = (state.filters.status === 'acceptedWeek') ? '' : 'acceptedWeek'; }
    state.visibleCount = 25;
    renderBoard();
  }

  function onFlipClick(dir) {
    if (!dir || dir === state.direction) return;
    state.direction = dir;
    state.expandedId = null;
    state.selection = {};
    state.visibleCount = 25;
    var panel = panelEl();
    if (panel) panel.innerHTML = A.loadingHtml('Loading the matching board…');
    fetchBoard();
  }

  function onFilterChipClick(key) {
    var parts = String(key || '').split(':');
    var field = parts[0], val = parts[1];
    if (field === 'urgency') state.filters.urgency = (state.filters.urgency === val) ? '' : val;
    else if (field === 'status') state.filters.status = (state.filters.status === val) ? '' : val;
    else if (field === 'dpa') state.filters.dpa = !state.filters.dpa;
    else if (field === 'filled') state.filters.filled = !state.filters.filled;
    state.visibleCount = 25;
    renderBoard();
  }

  function onStateSelectChange(val) { state.filters.state = val || ''; state.visibleCount = 25; renderBoard(); }
  function onSortSelectChange(val) { state.filters.sort = val || 'default'; state.visibleCount = 25; renderBoard(); }

  function onSearchInput(val) {
    state.filters.q = val || '';
    state.visibleCount = 25;
    if (state.direction === 'gps') {
      // The gps endpoint searches server-side across its full candidate pool
      // (the board only ever loads the top 150 rows), debounce so we don't
      // hammer it on every keystroke.
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(fetchBoard, 350);
    } else {
      renderBoard();
    }
  }

  function onShowMore() { state.visibleCount += 25; renderBoard(); }

  function onToggleCheckbox(id, checked) {
    if (checked) state.selection[id] = true; else delete state.selection[id];
    renderBoard();
  }

  function onShortlistOne(id) {
    var row = mbFindExpandedRow();
    if (!row) return;
    var isGp = !!row.gp;
    var items = isGp ? [{ user_id: row.gp.user_id, career_role_id: id }] : [{ user_id: id, career_role_id: row.job.id }];
    var title = mbSuggestionTitle(row, id, isGp);
    if (!window.confirm('Send the match email and in-app notification to 1 GP for "' + title + '"?')) return;
    A.api('/api/ats/matching/shortlist', { method: 'POST', body: { items: items } }).then(function (d) {
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not shortlist.'); return; }
      A.toast(mbShortlistToast(d.results));
      fetchBoard();
    });
  }

  function onBulkShortlist() {
    var row = mbFindExpandedRow();
    if (!row) return;
    var isGp = !!row.gp;
    var ids = Object.keys(state.selection).filter(function (k) { return state.selection[k]; });
    if (!ids.length) return;
    var items = ids.map(function (id) {
      return isGp ? { user_id: row.gp.user_id, career_role_id: id } : { user_id: id, career_role_id: row.job.id };
    });
    var msg = isGp
      ? ('Send the match email and in-app notification to this GP for ' + ids.length + ' role(s)?')
      : ('Send the match email and in-app notification to ' + ids.length + ' GP(s) for "' + ((row.job && row.job.title) || 'this role') + '"?');
    if (!window.confirm(msg)) return;
    A.api('/api/ats/matching/shortlist', { method: 'POST', body: { items: items } }).then(function (d) {
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not shortlist.'); return; }
      A.toast(mbShortlistToast(d.results));
      fetchBoard();
    });
  }

  function onExtend(applicationId) {
    if (!applicationId) return;
    A.api('/api/ats/application?id=' + encodeURIComponent(applicationId), { method: 'PATCH', body: { match_extend: true } }).then(function (d) {
      if (!d || !d.ok) { A.toast((d && d.message) || 'Could not extend the match window'); return; }
      A.toast('Match window extended 5 days');
      fetchBoard();
    });
  }

  // force=true (age-chip / expand-panel "Re-run fresh") re-ranks even a fresh
  // cache and costs a real AI run, so it is gated behind a confirm(); the
  // plain "⚡ Run AI ranking" (empty state, never ranked yet) is not.
  function onRun(id, force) {
    if (!id) return;
    var isGp = state.direction === 'gps';
    if (force) {
      var ok = window.confirm('Re-run the AI ranking for this ' + (isGp ? 'GP' : 'position') + '? This uses a fresh AI run and takes 10–20 seconds.');
      if (!ok) return;
    }
    state.runningIds[id] = true;
    renderBoard();
    var path = isGp
      ? ('/api/ats/matching/jobs?user_id=' + encodeURIComponent(id))
      : ('/api/ats/matching/candidates?job_id=' + encodeURIComponent(id));
    if (force) path += '&force=1';
    A.api(path).then(function (d) {
      delete state.runningIds[id];
      // Surface a failed ranking instead of silently clearing the spinner and
      // re-rendering the board unchanged (matches shortlist/extend handlers).
      if (!d || !d.ok) {
        A.toast((d && d.message) || 'Could not run the AI ranking. Please try again.');
        renderBoard();
        return;
      }
      fetchBoard();
    });
  }

  // Final-review fix (Finding 3): drill-ins activate the target tab via the
  // skipLoad=true path (window.ATS.setActiveTab, same mechanism applyHash()
  // uses for #candidate=/#board=/#practice= deep links) instead of
  // ATS.showMaster(), which also kicks off that tab's LIST loader, a second
  // async render that could race the opener below and clobber the detail view
  // it just opened.
  function onOpenPractice(id) {
    if (!id) return;
    if (window.ATS && typeof window.ATS.setActiveTab === 'function') window.ATS.setActiveTab('practices', true);
    if (typeof window.atsOpenPractice === 'function') window.atsOpenPractice(id);
  }
  function onOpenCandidate(id) {
    if (!id) return;
    if (window.ATS && typeof window.ATS.setActiveTab === 'function') window.ATS.setActiveTab('candidates', true);
    if (typeof window.atsOpenCandidate === 'function') window.atsOpenCandidate(id);
  }
  function onOpenJob(id) {
    if (!id) return;
    if (window.ATS && typeof window.ATS.setActiveTab === 'function') window.ATS.setActiveTab('jobs', true);
    if (typeof window.atsOpenJobBoard === 'function') window.atsOpenJobBoard(id);
  }

  /* ---------------- one delegated listener per event type ---------------- */

  function onPanelClick(e) {
    var t = e.target;
    var closest = (t && t.closest) ? t.closest.bind(t) : function () { return null; };
    var m;
    if ((m = closest('[data-mb-extend]'))) { onExtend(m.getAttribute('data-mb-extend')); return; }
    if ((m = closest('[data-mb-cb]'))) { onToggleCheckbox(m.getAttribute('data-mb-cb'), m.checked); return; }
    if ((m = closest('[data-mb-shortlist-one]'))) { onShortlistOne(m.getAttribute('data-mb-shortlist-one')); return; }
    if ((m = closest('[data-mb-bulk-shortlist]'))) { onBulkShortlist(); return; }
    if ((m = closest('[data-mb-refresh]'))) { e.preventDefault(); onRun(m.getAttribute('data-mb-refresh'), true); return; }
    if ((m = closest('[data-mb-run]'))) { onRun(m.getAttribute('data-mb-run'), false); return; }
    if ((m = closest('[data-mb-open-practice]'))) { onOpenPractice(m.getAttribute('data-mb-open-practice')); return; }
    if ((m = closest('[data-mb-open-cand]'))) { onOpenCandidate(m.getAttribute('data-mb-open-cand')); return; }
    if ((m = closest('[data-mb-open-job]'))) { onOpenJob(m.getAttribute('data-mb-open-job')); return; }
    if ((m = closest('[data-mb-kpi]'))) { onKpiClick(m.getAttribute('data-mb-kpi')); return; }
    if ((m = closest('[data-mb-flip]'))) { onFlipClick(m.getAttribute('data-mb-flip')); return; }
    if ((m = closest('[data-mb-filter]'))) { onFilterChipClick(m.getAttribute('data-mb-filter')); return; }
    if ((m = closest('[data-mb-show-more]'))) { onShowMore(); return; }
    if ((m = closest('[data-mb-row]'))) { onRowToggle(m.getAttribute('data-mb-row')); return; }
  }

  function onPanelInput(e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute('data-mb-search') != null) onSearchInput(e.target.value);
  }
  function onPanelChange(e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.getAttribute('data-mb-state') != null) onStateSelectChange(t.value);
    else if (t.getAttribute('data-mb-sort') != null) onSortSelectChange(t.value);
  }

  window.loadMatchingTab = loadMatchingTab;

  // Test seam only (tests/matching-board-ui.test.js), pure builder functions
  // driven directly with sample data shaped like the Task 4 board response.
  // Nothing above reads this object back.
  window.MatchingBoard = {
    mbUrgencyBucket: mbUrgencyBucket,
    mbTimeInStage: mbTimeInStage,
    mbMatchSubLabel: mbMatchSubLabel,
    mbShouldShowExtend: mbShouldShowExtend,
    mbNodeHtml: mbNodeHtml,
    mbTrackHtml: mbTrackHtml,
    mbGpTrackHtml: mbGpTrackHtml,
    mbRowHtml: mbRowHtml,
    mbGpRowHtml: mbGpRowHtml,
    mbKpisHtml: mbKpisHtml,
    mbFlipHtml: mbFlipHtml,
    mbLegendHtml: mbLegendHtml,
    mbFilterChipsHtml: mbFilterChipsHtml,
    mbFilledToggleHtml: mbFilledToggleHtml,
    mbFilledRowHtml: mbFilledRowHtml,
    mbExpandHtml: mbExpandHtml,
    mbFilterPositionsRows: mbFilterPositionsRows,
    mbFilterGpRows: mbFilterGpRows,
    mbSortPipeline: mbSortPipeline,
    mbSortRows: mbSortRows,
    mbSortSelectHtml: mbSortSelectHtml
  };
})();

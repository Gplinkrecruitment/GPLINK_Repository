/* ============================================================================
 * ceo-ats-leads.js — Leads master tab for the CEO dashboard.
 * Loaded by pages/ceo-dashboard.html AFTER /js/ceo-ats-shared.js (window.ATS).
 *
 * Rebuilt 2026-10-30 around Hazel, the Retell voice agent that rings leads:
 * every GP lead (site_enquiries kind=gp) with ONE stage badge, a Hazel column
 * (how the last call went, what she will do next, and why not), chase history,
 * stage chips + a Hazel filter + search, headline tiles, and a detail drawer
 * with every call (summary, what Hazel learned, recording, transcript) and the
 * owner's controls: call now, schedule a call-back, pause/resume, do not call.
 * Data: GET /api/ceo/leads, GET/POST /api/ceo/leads/:id[/call|/hazel].
 * Exposes window.loadLeadsTab().
 * ========================================================================== */
(function () {
  'use strict';

  var ATS = window.ATS;
  if (!ATS) return;

  var PANEL_ID = 'panel-leads';
  function panel() { return document.getElementById(PANEL_ID); }

  // Module state (persisted across re-renders).
  var state = {
    filter: 'all', hazel: 'any', q: '',
    loaded: [], total: 0, counts: null, hazelCounts: null, tiles: null, status: null,
    openId: '', detail: null, busy: false
  };
  var PAGE_SIZE = 100;

  // Stage chips. `v` must match the server's ?filter= values.
  var STAGE_FILTERS = [
    { v: 'all',           label: 'All' },
    { v: 'open',          label: 'Open',          hint: 'Qualified, not booked, not burnt — the list Hazel works through' },
    { v: 'booked',        label: 'Booked',        hint: 'A consultation is in the diary (or already happened)' },
    { v: 'signed_up',     label: 'Signed up',     hint: 'Created an account' },
    { v: 'burnt',         label: 'Burnt',         hint: 'Unsubscribed, asked not to be called, not interested, or not a GP' },
    { v: 'not_qualified', label: 'Not qualified', hint: 'Answered the screening questions and were turned down' },
    { v: 'unscreened',    label: 'Never screened', hint: 'Booked the calendar link direct, or a plain website enquiry' }
  ];
  // The Hazel dimension. `v` must match the server's ?hazel= values.
  var HAZEL_FILTERS = [
    { v: 'any',         label: 'Hazel: anything' },
    { v: 'queued',      label: 'Queued to ring' },
    { v: 'scheduled',   label: 'Call-back or retry scheduled' },
    { v: 'in_progress', label: 'On a call right now' },
    { v: 'called',      label: 'Called (any outcome)' },
    { v: 'spoke',       label: 'Spoke to the doctor' },
    { v: 'booked',      label: 'Booked by Hazel' },
    { v: 'link_sent',   label: 'Booking link sent' },
    { v: 'no_answer',   label: 'No answer / voicemail' },
    { v: 'gave_up',     label: 'Gave up (attempts used)' },
    { v: 'burnt',       label: 'Burnt on the call' },
    { v: 'blocked',     label: 'Will not ring (blocked or paused)' },
    { v: 'not_called',  label: 'Never called' }
  ];

  // Where the lead came from, in words the owner uses.
  var SOURCE_LABELS = {
    site_start_form: 'Landing page',
    meta_lead_ad:    'Facebook lead form',
    calendly_direct: 'Booked direct (not screened)',
    'marketing-site': 'Website enquiry form',
    ceo_test:        'Test call'
  };
  function sourceLabel(s) { return SOURCE_LABELS[s] || (s ? String(s) : 'Unknown'); }

  var COUNTRY_SHORT = { uk: 'UK', ie: 'Ireland', au: 'Sydney', nz: 'NZ' };
  var SEQ_LABELS = { not_booked: 'pre-booking chase', booked_no_signup: 'after-booking chase' };
  var GP_STATUS_LABELS = { gp: 'Practising GP', trainee: 'Still in GP training', not_a_gp: 'Not a GP', unknown: '' };
  var OBJECTION_HANDLED = { handled: 'answered it', partly: 'only partly answered', ignored: 'did not answer it', none: '' };

  /* =====================================================================
   *  TIME HELPERS
   * ===================================================================== */
  // The viewer's own local time (follows the owner wherever they travel).
  var localFmt = null;
  function localTime(iso) {
    if (!iso) return '—';
    try {
      if (!localFmt) localFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
      return localFmt.format(new Date(iso));
    } catch (e) { return String(iso); }
  }
  // The doctor's own clock, with a short zone tag ("Mon 9:00 am UK").
  function theirTime(iso, tz, country) {
    if (!iso) return '';
    try {
      var f = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
      return f.format(new Date(iso)) + ' ' + (COUNTRY_SHORT[String(country || '').toLowerCase()] || 'their time');
    } catch (e) { return localTime(iso); }
  }
  function theirClockNow(tz, country) {
    try {
      var f = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/London', weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true });
      return f.format(new Date()) + ' in ' + ({ uk: 'the UK', ie: 'Ireland', au: 'Australia', nz: 'New Zealand' }[String(country || '').toLowerCase()] || 'their zone');
    } catch (e) { return ''; }
  }
  function ago(iso) {
    var ms = Date.parse(iso || '');
    if (!isFinite(ms)) return '';
    var m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    var d = Math.round(h / 24);
    if (d < 30) return d + ' d ago';
    var mo = Math.round(d / 30);
    return mo < 12 ? mo + ' mo ago' : Math.round(mo / 12) + ' y ago';
  }
  function untilWords(iso) {
    var ms = Date.parse(iso || '');
    if (!isFinite(ms)) return '';
    var m = Math.round((ms - Date.now()) / 60000);
    if (m <= 1) return 'now';
    if (m < 60) return 'in ' + m + ' min';
    var h = Math.round(m / 60);
    if (h < 36) return 'in ' + h + ' h';
    return 'in ' + Math.round(h / 24) + ' days';
  }
  function duration(s) {
    s = Number(s) || 0;
    if (!s) return '';
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  /* =====================================================================
   *  PUBLIC ENTRY POINT
   * ===================================================================== */
  // opts.quiet (owner 2026-10-29): the tab was visited within the last few
  // minutes — refetch the first page in the background, list stays on screen.
  window.loadLeadsTab = function (opts) {
    var el = panel();
    if (!el) return;
    try {
      if (opts && opts.quiet && document.getElementById('lead-list')) { fetchAndRender(false, true); return; }
      el.innerHTML = scaffold();
      wireEvents(el);
      fetchAndRender();
    } catch (e) {
      console.error('[leads] render failed', e);
      el.innerHTML = ATS.emptyHtml('The Leads tab hit an error while drawing. Reload the page; if it persists, tell the developer: ' + ((e && e.message) || e));
    }
  };

  /* =====================================================================
   *  SCAFFOLD
   * ===================================================================== */
  function scaffold() {
    return '' +
      '<div class="ats-section-head"><div>' +
        '<h2>Leads</h2>' +
        '<p>Everyone who asked about GP work — from the ads, the landing page and the website form — and what Hazel has done about each of them.</p>' +
      '</div></div>' +
      '<div class="lead-status" id="lead-status"></div>' +
      '<div class="lead-tiles" id="lead-tiles"></div>' +
      '<div class="lead-toolbar">' +
        '<div class="lead-filters" id="lead-filters">' + chipsHtml(null) + '</div>' +
        '<select class="lead-select" id="lead-hazel-filter" aria-label="Filter by what Hazel did">' + hazelOptionsHtml(null) + '</select>' +
        '<input type="search" class="lead-search" id="lead-search" placeholder="Search name, email or phone…" ' +
          'value="' + ATS.escAttr(state.q) + '" autocomplete="off" />' +
      '</div>' +
      '<div id="lead-list">' + ATS.loadingHtml('Loading leads…') + '</div>';
  }

  // Chips are re-rendered on every fetch so the counts stay in step with the
  // active search.
  function chipsHtml(counts) {
    return STAGE_FILTERS.map(function (f) {
      var n = counts && counts[f.v] != null ? counts[f.v] : null;
      return '<button type="button" class="lead-chip' + (state.filter === f.v ? ' active' : '') +
        '" data-filter="' + ATS.escAttr(f.v) + '"' + (f.hint ? ' title="' + ATS.escAttr(f.hint) + '"' : '') + '>' + ATS.esc(f.label) +
        (n == null ? '' : ' <span class="lead-chip-n">' + n + '</span>') + '</button>';
    }).join('');
  }
  function hazelOptionsHtml(counts) {
    return HAZEL_FILTERS.map(function (f) {
      var n = counts && counts[f.v] != null ? counts[f.v] : null;
      return '<option value="' + ATS.escAttr(f.v) + '"' + (state.hazel === f.v ? ' selected' : '') + '>' +
        ATS.esc(f.label) + (n == null || f.v === 'any' ? '' : ' (' + n + ')') + '</option>';
    }).join('');
  }

  // Headline tiles. Each one is a shortcut to a filter combination.
  var TILES = [
    { k: 'open',            label: 'Open leads',          filter: 'open',  hazel: 'any',       mod: 'amber' },
    { k: 'queued',          label: 'Queued for Hazel',    filter: 'all',   hazel: 'queued',    mod: 'blue' },
    { k: 'scheduled',       label: 'Call-backs scheduled', filter: 'all',  hazel: 'scheduled', mod: 'amber' },
    { k: 'called',          label: 'Called by Hazel',     filter: 'all',   hazel: 'called',    mod: '' },
    { k: 'booked_by_hazel', label: 'Booked by Hazel',     filter: 'all',   hazel: 'booked',    mod: 'green' },
    { k: 'burnt',           label: 'Burnt',               filter: 'burnt', hazel: 'any',       mod: 'red' }
  ];
  function tilesHtml(tiles) {
    if (!tiles) return '';
    return TILES.map(function (t) {
      var on = state.filter === t.filter && state.hazel === t.hazel && !(t.filter === 'all' && t.hazel === 'any');
      return '<button type="button" class="lead-tile' + (t.mod ? ' ' + t.mod : '') + (on ? ' active' : '') +
        '" data-tile="' + t.k + '"><span class="lead-tile-v">' + (tiles[t.k] != null ? tiles[t.k] : '—') + '</span>' +
        '<span class="lead-tile-l">' + ATS.esc(t.label) + '</span></button>';
    }).join('');
  }

  // One line on the dialler itself: on/off, who it rings, which numbers exist,
  // when it last ran. Config is reported as booleans only — never a value.
  function statusHtml(h) {
    if (!h) return '';
    var bits = [];
    var dot;
    if (!h.configured) {
      dot = 'off';
      bits.push('<b>Hazel is not connected</b> — RETELL_API_KEY / RETELL_AGENT_ID are missing, so nothing is rung.');
    } else if (!h.enabled) {
      dot = 'off';
      bits.push('<b>Hazel is switched off</b> (LEAD_CALLS_ENABLED) — the queue below shows what she would ring once it is on.');
    } else {
      dot = 'on';
      bits.push('<b>Hazel is on</b>');
    }
    if (h.configured) {
      bits.push('rings qualified, unbooked leads up to <b>' + h.max_lead_age_days + ' day' + (h.max_lead_age_days === 1 ? '' : 's') + '</b> old');
      bits.push('<b>' + h.max_attempts + '</b> attempt' + (h.max_attempts === 1 ? '' : 's') + ', ' + (h.retry_after_min >= 60 ? Math.round(h.retry_after_min / 60) + ' h' : h.retry_after_min + ' min') + ' apart');
      bits.push('UK number ' + (h.from_uk ? '✓' : '<span class="lead-status-bad">✗ missing</span>') + ' · AU number ' + (h.from_au ? '✓' : '<span class="lead-status-bad">✗ missing</span>'));
      if (h.test_mode) bits.push('<span class="lead-status-bad">TEST MODE — only ' + h.test_numbers + ' allow-listed number' + (h.test_numbers === 1 ? '' : 's') + ' can be rung</span>');
      if (h.last_run && h.last_run.at) bits.push('last run ' + ATS.esc(ago(h.last_run.at)) + (h.last_run.detail ? ' (' + ATS.esc(h.last_run.detail) + ')' : ''));
      else bits.push('no run recorded yet');
    }
    return '<span class="lead-status-dot ' + dot + '"></span>' + bits.join(' <span class="lead-sep">·</span> ');
  }

  /* =====================================================================
   *  EVENTS
   * ===================================================================== */
  function wireEvents(el) {
    el.addEventListener('click', function (e) {
      var t = e.target;
      var chip = t.closest ? t.closest('.lead-chip[data-filter]') : null;
      if (chip) {
        var f = chip.getAttribute('data-filter') || 'all';
        if (state.filter === f) return;
        state.filter = f;
        fetchAndRender();
        return;
      }
      var tile = t.closest ? t.closest('.lead-tile[data-tile]') : null;
      if (tile) {
        var def = TILES.filter(function (x) { return x.k === tile.getAttribute('data-tile'); })[0];
        if (!def) return;
        var same = state.filter === def.filter && state.hazel === def.hazel;
        state.filter = same ? 'all' : def.filter;
        state.hazel = same ? 'any' : def.hazel;
        var sel = document.getElementById('lead-hazel-filter');
        if (sel) sel.value = state.hazel;
        fetchAndRender();
        return;
      }
      var more = t.closest ? t.closest('#lead-show-more') : null;
      if (more) { fetchAndRender(true); return; }
      var row = t.closest ? t.closest('.lead-row[data-id]') : null;
      if (row) { openDrawer(row.getAttribute('data-id')); }
    });

    var sel = el.querySelector('#lead-hazel-filter');
    if (sel) sel.addEventListener('change', function () {
      var v = sel.value || 'any';
      if (state.hazel === v) return;
      state.hazel = v;
      fetchAndRender();
    });

    var search = el.querySelector('#lead-search');
    if (search) {
      var timer = null;
      search.addEventListener('input', function () {
        var v = search.value || '';
        clearTimeout(timer);
        timer = setTimeout(function () {
          if (state.q === v) return;
          state.q = v;
          fetchAndRender();
        }, 250);
      });
    }
  }

  /* =====================================================================
   *  DATA FETCH + RENDER
   * ===================================================================== */
  function listPath(offset) {
    return '/api/ceo/leads?filter=' + encodeURIComponent(state.filter) +
      '&hazel=' + encodeURIComponent(state.hazel) +
      (state.q ? '&q=' + encodeURIComponent(state.q) : '') +
      '&limit=' + PAGE_SIZE + '&offset=' + offset;
  }

  // `append` true = "Show more" (fetch the next page and keep what's loaded);
  // falsy = a fresh load (filter/search change) that resets the pager.
  // quiet = a background revalidation: no placeholder over the current rows.
  function fetchAndRender(append, quiet) {
    var listEl = document.getElementById('lead-list');
    if (!append && !quiet && listEl) listEl.innerHTML = ATS.loadingHtml('Loading leads…');
    var offset = append ? state.loaded.length : 0;
    var handle = function (d) {
      var el = document.getElementById('lead-list');
      if (!el) return;
      // Only overwrite the chip counts on a good response — an error must not
      // wipe the totals the chips already show.
      if (d && d.ok) {
        state.counts = d.counts || state.counts;
        state.hazelCounts = d.hazel_counts || state.hazelCounts;
        state.tiles = d.tiles || state.tiles;
        state.status = d.hazel || state.status;
        paintHeader();
      }
      if (!d || !d.ok) { if (!append) el.innerHTML = ATS.emptyHtml('Could not load leads.'); return; }
      var batch = d.leads || [];
      if (!append) state.loaded = [];
      state.loaded = state.loaded.concat(batch);
      state.total = (typeof d.total === 'number') ? d.total : state.loaded.length;
      renderLeads(el);
    };
    // SWR only for fresh loads: the handler resets state.loaded, so running it
    // twice (cache, then network) is safe. An append ("Show more") page must run
    // exactly once or the batch would be concatenated twice — keep it plain.
    if (append) ATS.api(listPath(offset)).then(handle);
    else ATS.swr(listPath(0), handle, quiet ? { skipCache: true } : undefined);
  }

  function paintHeader() {
    var chips = document.getElementById('lead-filters');
    if (chips) chips.innerHTML = chipsHtml(state.counts);
    var sel = document.getElementById('lead-hazel-filter');
    if (sel) sel.innerHTML = hazelOptionsHtml(state.hazelCounts);
    var tiles = document.getElementById('lead-tiles');
    if (tiles) tiles.innerHTML = tilesHtml(state.tiles);
    var st = document.getElementById('lead-status');
    if (st) st.innerHTML = statusHtml(state.status);
  }

  function emptyMessage() {
    if (state.q) return 'No leads match “' + state.q + '”.';
    if (state.hazel === 'queued') return 'Nothing is queued for Hazel right now.';
    if (state.hazel === 'scheduled') return 'No call-backs or retries are scheduled.';
    if (state.filter === 'open') return 'No open leads — everyone qualified is booked, signed up or burnt.';
    return 'No leads here yet.';
  }

  function renderLeads(el) {
    if (!state.loaded.length) { el.innerHTML = ATS.emptyHtml(emptyMessage()); return; }
    var remaining = Math.max(0, state.total - state.loaded.length);
    var footer = '<div class="lead-more-bar">' +
      'Showing ' + state.loaded.length + ' of ' + state.total +
      (remaining > 0 ? ' · <button type="button" id="lead-show-more" class="ats-btn ats-btn-sm">Show ' + Math.min(PAGE_SIZE, remaining) + ' more</button>' : '') +
      '</div>';
    el.innerHTML = '<div class="lead-head"><span>Lead</span><span>Hazel</span><span>Chase</span><span></span></div>' +
      '<div class="lead-group">' + state.loaded.map(rowHtml).join('') + '</div>' + footer;
  }

  // Replace one lead in the list (after an action) without a full refetch.
  function patchLead(lead) {
    if (!lead || !lead.id) return;
    var i;
    for (i = 0; i < state.loaded.length; i++) if (state.loaded[i].id === lead.id) { state.loaded[i] = lead; break; }
    var rowEl = document.querySelector('.lead-row[data-id="' + cssEsc(lead.id) + '"]');
    if (rowEl) {
      var tmp = document.createElement('div');
      tmp.innerHTML = rowHtml(lead);
      rowEl.parentNode.replaceChild(tmp.firstChild, rowEl);
    }
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  /* =====================================================================
   *  LEAD ROW
   * ===================================================================== */
  var HZ_DOT = { queued: 'blue', scheduled: 'amber', retry: 'amber', in_progress: 'live', done: 'green', gave_up: 'muted', burnt: 'red', blocked: 'muted', paused: 'amber', none: 'none' };

  function hazelLineHtml(l) {
    var h = l.hazel || {};
    var last = h.last;
    var dot = HZ_DOT[h.state] || 'none';
    var head = '';
    if (h.state === 'none' && !last) {
      head = '<span class="lead-hz-dot none"></span><span class="lead-hz-none">Not in Hazel\u2019s queue</span>';
    } else if (h.state === 'none' && last) {
      head = '<span class="lead-hz-dot ' + (last.outcome === 'booked' ? 'green' : 'muted') + '"></span><b>' + ATS.esc(last.outcome_label || 'Called') + '</b>';
    } else {
      head = '<span class="lead-hz-dot ' + dot + '"></span><b>' + ATS.esc(h.label) + '</b>';
      if (h.due_at && (h.state === 'queued' || h.state === 'scheduled' || h.state === 'retry')) {
        head += ' <span class="lead-hz-when">' + ATS.esc(h.state === 'queued' && untilWords(h.due_at) === 'now' ? '' : theirTime(h.due_at, l.tz, l.country)) + '</span>';
      }
    }
    var lines = ['<div class="lead-hz-line">' + head + '</div>'];
    if (h.detail && h.state !== 'blocked') lines.push('<div class="lead-hz-sub">' + ATS.esc(h.detail) + '</div>');
    if (h.state === 'blocked' && h.detail) lines.push('<div class="lead-hz-sub">' + ATS.esc(h.detail) + '</div>');
    if (last && last.outcome) {
      var bits = [last.outcome_label || last.outcome];
      bits.push('attempt ' + last.attempt + ' of ' + (h.max_attempts || '?'));
      if (last.duration_s) bits.push(duration(last.duration_s));
      if (last.completed_at || last.started_at) bits.push(localTime(last.completed_at || last.started_at));
      if (h.state !== 'none' && h.label !== last.outcome_label) lines.push('<div class="lead-hz-last">Last call: ' + ATS.esc(bits.join(' · ')) + '</div>');
      else lines.push('<div class="lead-hz-last">' + ATS.esc(bits.slice(1).join(' · ')) + '</div>');
      if (last.summary) lines.push('<div class="lead-hz-sum">' + ATS.esc(last.summary) + '</div>');
      else if (last.error) lines.push('<div class="lead-hz-sum">' + ATS.esc(last.error) + '</div>');
    } else if (last && (last.status === 'registered' || last.status === 'ongoing')) {
      lines.push('<div class="lead-hz-last">Started ' + ATS.esc(localTime(last.started_at)) + '</div>');
    }
    return lines.join('');
  }

  function chaseHtml(l) {
    var text;
    if (!l.nudges_sent && !l.wa_sent) {
      text = 'No chase messages yet';
    } else {
      var parts = [];
      if (l.nudges_sent) parts.push(l.nudges_sent + ' email' + (l.nudges_sent === 1 ? '' : 's'));
      if (l.wa_sent) parts.push(l.wa_sent + ' WhatsApp');
      text = parts.join(' + ');
      if (l.last_nudge_at) text += ' · last ' + ago(l.last_nudge_at);
    }
    var sub = '';
    if (l.email_bounced) sub = 'email bounced — WhatsApp only';
    if (l.stopped) sub = (sub ? sub + ' · ' : '') + 'stopped: ' + (l.stopped_label || l.stopped);
    var booking = '';
    if (l.call_booked) {
      booking = '<div class="lead-chase-booking">' +
        (l.call_completed_at ? 'Consult done ' + ATS.esc(localTime(l.call_completed_at))
          : 'Consult ' + ATS.esc(l.call_at ? localTime(l.call_at) : 'booked ' + localTime(l.call_booked_at))) +
        (l.booked_via === 'hazel' ? ' <span class="ats-pill green">via Hazel</span>' : '') + '</div>';
    }
    return booking + '<div>' + ATS.esc(text) + '</div>' + (sub ? '<div class="lead-chase-sub">' + ATS.esc(sub) + '</div>' : '');
  }

  function rowHtml(l) {
    var sb = l.stage || { label: '—', mod: 'muted' };
    var contact = ATS.esc(l.email || '—');
    if (l.phone) contact += ' <span class="lead-sep">·</span> ' + ATS.esc(l.phone);
    var meta = [];
    if (l.country) meta.push(ATS.flag(l.country) + ' ' + ATS.esc(String(l.country).toUpperCase()));
    meta.push(ATS.esc(sourceLabel(l.source)));
    meta.push('Arrived ' + ATS.esc(ago(l.created_at) || localTime(l.created_at)));
    var flags = '';
    if (l.calls_paused) flags += ' <span class="ats-pill amber">Hazel paused</span>';
    if (l.call_back_at) flags += ' <span class="ats-pill blue">Call-back ' + ATS.esc(theirTime(l.call_back_at, l.tz, l.country)) + '</span>';
    return '<div class="lead-row' + (state.openId === l.id ? ' open' : '') + '" data-id="' + ATS.escAttr(l.id) + '" role="button" tabindex="0">' +
      '<div class="lead-av" style="background:' + ATS.avatarColor(l.name) + '">' + ATS.esc(ATS.initials(l.name)) + '</div>' +
      '<div class="lead-main">' +
        '<div class="lead-name">' + ATS.esc(l.name || '—') + '</div>' +
        '<div class="lead-contact">' + contact + '</div>' +
        '<div class="lead-meta">' + meta.join(' <span class="lead-sep">·</span> ') + '</div>' +
        (l.call_question ? '<div class="lead-q">“' + ATS.esc(l.call_question) + '”</div>' : '') +
      '</div>' +
      '<div class="lead-hz">' + hazelLineHtml(l) + '</div>' +
      '<div class="lead-chase">' + chaseHtml(l) + '</div>' +
      '<div class="lead-right">' +
        '<span class="ats-pill ' + sb.mod + '"' + (sb.reason ? ' title="' + ATS.escAttr(sb.reason) + '"' : '') + '>' + ATS.esc(sb.label) + '</span>' + flags +
        '<span class="lead-chev" aria-hidden="true">›</span>' +
      '</div>' +
    '</div>';
  }

  /* =====================================================================
   *  DETAIL DRAWER
   * ===================================================================== */
  function openDrawer(id) {
    if (!id) return;
    state.openId = id;
    state.detail = null;
    var cached = state.loaded.filter(function (l) { return l.id === id; })[0] || null;
    ATS.setOverlay(
      '<div class="ats-scrim open" id="lead-scrim"></div>' +
      '<aside class="ats-drawer lead-drawer open" id="lead-drawer" aria-label="Lead details">' +
        drawerHtml(cached, null, null, true) +
      '</aside>');
    wireDrawer();
    ATS.api('/api/ceo/leads/' + encodeURIComponent(id)).then(function (d) {
      if (state.openId !== id) return;
      var drawer = document.getElementById('lead-drawer');
      if (!drawer) return;
      if (!d || !d.ok) {
        drawer.innerHTML = drawerHtml(cached, null, null, false, (d && d.message) || 'Could not load this lead.');
        wireDrawer();
        return;
      }
      state.detail = d;
      patchLead(d.lead);
      drawer.innerHTML = drawerHtml(d.lead, d.calls || [], d.chase || null, false);
      wireDrawer();
    });
  }
  function closeDrawer() {
    state.openId = '';
    state.detail = null;
    ATS.setOverlay('');
    var openRow = document.querySelector('.lead-row.open');
    if (openRow) openRow.classList.remove('open');
  }

  function kv(label, value, raw) {
    if (value == null || value === '') return '';
    return '<div class="lead-kv"><span class="lead-kv-l">' + ATS.esc(label) + '</span><span class="lead-kv-v">' + (raw ? value : ATS.esc(value)) + '</span></div>';
  }

  // Which controls make sense right now. Consent wins: a do-not-call lead
  // gets no call button at all.
  function actionsHtml(l) {
    if (!l) return '';
    var dnc = l.stopped === 'do_not_call';
    var h = l.hazel || {};
    var out = [];
    if (!dnc && l.phone) out.push('<button type="button" class="ats-btn ats-btn-primary ats-btn-sm" data-lead-act="call"' + (h.state === 'in_progress' ? ' disabled' : '') + '>📞 Call now with Hazel</button>');
    if (!dnc) out.push('<button type="button" class="ats-btn ats-btn-sm" data-lead-act="schedule-open">' + (l.call_back_at ? 'Change call-back' : 'Schedule a call-back') + '</button>');
    if (l.call_back_at) out.push('<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-lead-act="unschedule">Clear call-back</button>');
    if (!dnc) out.push(l.calls_paused
      ? '<button type="button" class="ats-btn ats-btn-sm" data-lead-act="resume">Resume Hazel</button>'
      : '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-lead-act="pause">Pause Hazel</button>');
    if (!dnc) out.push('<button type="button" class="ats-btn ats-btn-danger ats-btn-sm" data-lead-act="dnc">Do not call</button>');
    if (dnc) out.push('<span class="lead-drawer-note">This doctor asked not to be called — no phone controls.</span>');
    return out.join('');
  }

  function learnedHtml(c) {
    var L = c.learned || {};
    var rows = [];
    var gp = GP_STATUS_LABELS[L.gp_status || c.gp_status] || '';
    if (gp) rows.push(kv('Who they are', gp + (L.training_finish ? ' — finishes ' + L.training_finish : '')));
    if (L.timeframe || c.timeframe) rows.push(kv('When they want to move', L.timeframe || c.timeframe));
    if (L.objections) rows.push(kv('Concerns raised', String(L.objections).replace(/_/g, ' ') + (OBJECTION_HANDLED[L.objection_handled] ? ' — Hazel ' + OBJECTION_HANDLED[L.objection_handled] : '')));
    if (L.unanswered_questions) rows.push(kv('Questions left unanswered', L.unanswered_questions));
    if (L.lost_booking_reason) rows.push(kv('Why no booking', L.lost_booking_reason));
    if (L.callback_time || c.callback_note) rows.push(kv('Call back when', L.callback_time || c.callback_note));
    if (L.notes || c.notes) rows.push(kv('Notes for the consultant', L.notes || c.notes));
    if (c.note) rows.push(kv('Hazel noted on the call', c.note));
    if (L.agent_slips) rows.push(kv('Script slips', String(L.agent_slips).replace(/_/g, ' ')));
    return rows.join('');
  }

  function transcriptHtml(t) {
    return String(t || '').split(/\r?\n/).map(function (line) {
      var m = /^(Agent|User)\s*:\s*(.*)$/i.exec(line);
      if (!m) return line.trim() ? '<div>' + ATS.esc(line) + '</div>' : '';
      var who = m[1].toLowerCase() === 'agent' ? 'Hazel' : 'Doctor';
      return '<div class="lead-tr-line ' + (who === 'Hazel' ? 'hazel' : 'doctor') + '"><b>' + who + '</b> ' + ATS.esc(m[2]) + '</div>';
    }).join('');
  }

  function callHtml(c, i) {
    var outcome = c.outcome_label || (c.status ? 'In progress' : 'Unknown');
    var mod = c.outcome === 'booked' ? 'green' : (c.outcome === 'link_sent' || c.outcome === 'callback_requested') ? 'blue'
      : (/^(not_interested|not_a_gp|wrong_number|do_not_call)$/.test(c.outcome)) ? 'red'
      : (/^(voicemail|no_answer|failed)$/.test(c.outcome)) ? 'muted' : 'amber';
    var facts = [];
    if (c.attempt) facts.push('attempt ' + c.attempt);
    if (c.duration_s) facts.push(duration(c.duration_s));
    if (c.started_at) facts.push(localTime(c.started_at));
    if (c.sentiment) facts.push('mood ' + String(c.sentiment).toLowerCase());
    if (c.cost_cents != null && c.cost_cents > 0) facts.push('$' + (c.cost_cents / 100).toFixed(2));
    var h = '<div class="lead-call">' +
      '<div class="lead-call-head"><span class="ats-pill ' + mod + '">' + ATS.esc(outcome) + '</span><span class="lead-call-facts">' + ATS.esc(facts.join(' · ')) + '</span></div>';
    if (c.summary) h += '<div class="lead-call-sum">' + ATS.esc(c.summary) + '</div>';
    if (c.error) h += '<div class="lead-call-sum lead-call-err">' + ATS.esc(c.error) + '</div>';
    if (c.disconnection_reason && /^(dial_failed|invalid_destination|telephony|sip|error_|registered_call_timeout|no_valid_payment|credit_exhausted|budget|concurrency)/.test(c.disconnection_reason)) {
      h += '<div class="lead-call-sum lead-call-err">Retell: ' + ATS.esc(String(c.disconnection_reason).replace(/_/g, ' ')) + '</div>';
    }
    var learned = learnedHtml(c);
    if (learned) h += '<div class="lead-call-learned">' + learned + '</div>';
    var links = [];
    if (c.recording_url) links.push('<a class="lead-link" href="' + ATS.escAttr(c.recording_url) + '" target="_blank" rel="noopener">Open recording ↗</a>');
    if (c.transcript) links.push('<button type="button" class="lead-link" data-lead-act="transcript" data-i="' + i + '">Show transcript</button>');
    if (links.length) h += '<div class="lead-call-links">' + links.join(' <span class="lead-sep">·</span> ') + '</div>';
    if (c.transcript) h += '<div class="lead-transcript" id="lead-tr-' + i + '" hidden>' + transcriptHtml(c.transcript) + '</div>';
    return h + '</div>';
  }

  function chaseListHtml(chase, l) {
    if (!chase) return '';
    var items = [];
    (chase.nudges || []).forEach(function (n) {
      var what = n.email === 'sent' ? 'Email' : n.email === 'bounced' ? 'Email bounced' : n.email === 'superseded' ? 'Email skipped (booked first)' : n.email === 'skipped' ? 'Email skipped' : 'Email (' + n.email + ')';
      items.push({ at: n.sent_at, text: what + ' — ' + (SEQ_LABELS[n.seq] || n.seq) + ' step ' + (n.step + 1) });
    });
    (chase.whatsapp || []).forEach(function (w) {
      items.push({ at: w.sent_at, text: 'WhatsApp — ' + String(w.kind || '').replace(/_/g, ' ') });
    });
    items.sort(function (a, b) { return (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0); });
    if (!items.length) return '<div class="lead-drawer-note">No chase messages have gone yet.</div>';
    var h = items.map(function (it) { return '<div class="lead-kv"><span class="lead-kv-l">' + ATS.esc(localTime(it.at)) + '</span><span class="lead-kv-v">' + ATS.esc(it.text) + '</span></div>'; }).join('');
    if (l && l.stopped) h += '<div class="lead-drawer-note">Chase stopped — ' + ATS.esc(l.stopped_label || l.stopped) + '.</div>';
    return h;
  }

  function drawerHtml(l, calls, chase, loading, error) {
    var sb = (l && l.stage) || { label: '', mod: 'muted' };
    var h = '<div class="ats-drawer-head">' +
      (l ? '<div class="lead-av lead-av-lg" style="background:' + ATS.avatarColor(l.name) + '">' + ATS.esc(ATS.initials(l.name)) + '</div>' : '') +
      '<div><div class="dh-name">' + ATS.esc((l && l.name) || 'Lead') + ' <span class="ats-pill ' + sb.mod + '">' + ATS.esc(sb.label) + '</span></div>' +
      '<div class="dh-sub">' + (l ? ATS.esc((l.email || '') + (l.phone ? ' · ' + l.phone : '')) : '') + '</div>' +
      (l ? '<div class="dh-sub">' + ATS.flag(l.country) + ' ' + ATS.esc(sourceLabel(l.source)) + ' · arrived ' + ATS.esc(localTime(l.created_at)) + (l.stage && l.stage.reason ? ' · ' + ATS.esc(l.stage.reason) : '') + '</div>' : '') +
      '</div><button class="ats-drawer-close" id="lead-drawer-close" aria-label="Close">×</button></div>';
    h += '<div class="ats-drawer-body">';
    if (error) h += '<div class="lead-drawer-note lead-call-err">' + ATS.esc(error) + '</div>';
    if (l) {
      // What happens next + the owner's controls.
      var hz = l.hazel || {};
      h += '<div class="lead-sec"><label>Hazel — next step</label>' +
        '<div class="lead-hz lead-hz-drawer">' + hazelLineHtml(l) + '</div>' +
        '<div class="lead-actions">' + actionsHtml(l) + '</div>' +
        '<div class="lead-sched" id="lead-sched" hidden>' +
          '<div class="lead-sched-row"><input type="datetime-local" id="lead-sched-at" class="ats-modal-input" /> ' +
          '<button type="button" class="ats-btn ats-btn-primary ats-btn-sm" data-lead-act="schedule">Save</button> ' +
          '<button type="button" class="ats-btn ats-btn-ghost ats-btn-sm" data-lead-act="schedule-close">Cancel</button></div>' +
          '<div class="lead-drawer-note">Hazel rings at or after this time, inside her calling hours in the doctor\u2019s own zone (Mon–Fri 9am–7:30pm, Sat 10am–4pm). A scheduled call-back ignores the lead-age limit and the attempt cap.</div>' +
        '</div>' +
        '<div class="lead-drawer-note" id="lead-act-msg"></div>' +
      '</div>';
      // Booking.
      if (l.call_booked) {
        h += '<div class="lead-sec"><label>Consultation</label>' +
          kv('When', l.call_at ? localTime(l.call_at) + ' (your time) · ' + theirTime(l.call_at, l.tz, l.country) : 'booked ' + localTime(l.call_booked_at)) +
          kv('Booked', localTime(l.call_booked_at) + (l.booked_via === 'hazel' ? ' — by Hazel, on the call' : l.booked_via === 'phone_match' ? ' — matched by phone number' : ' — through the Calendly link')) +
          (l.call_completed_at ? kv('Completed', localTime(l.call_completed_at)) : '') +
          '</div>';
      }
      if (l.call_question) h += '<div class="lead-sec"><label>They asked</label><div class="lead-q lead-q-drawer">“' + ATS.esc(l.call_question) + '”</div></div>';
    }
    // Calls.
    h += '<div class="lead-sec"><label>Hazel\u2019s calls' + (calls ? ' (' + calls.length + ')' : '') + '</label>';
    if (loading) h += '<div class="lead-drawer-note">Loading call history…</div>';
    else if (!calls || !calls.length) h += '<div class="lead-drawer-note">Hazel has not called this lead yet.</div>';
    else h += calls.map(callHtml).join('');
    h += '</div>';
    // Chase.
    h += '<div class="lead-sec"><label>Chase messages</label>' + (loading ? '<div class="lead-drawer-note">Loading…</div>' : chaseListHtml(chase, l)) + '</div>';
    h += '</div>';
    return h;
  }

  function setActMsg(msg, isErr) {
    var el = document.getElementById('lead-act-msg');
    if (el) { el.textContent = msg || ''; el.className = 'lead-drawer-note' + (isErr ? ' lead-call-err' : ' lead-ok'); }
  }

  function wireDrawer() {
    var scrim = document.getElementById('lead-scrim');
    if (scrim) scrim.addEventListener('click', closeDrawer);
    var close = document.getElementById('lead-drawer-close');
    if (close) close.addEventListener('click', closeDrawer);
    var drawer = document.getElementById('lead-drawer');
    if (!drawer) return;
    drawer.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-lead-act]') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-lead-act');
      var lead = currentLead();
      if (act === 'transcript') {
        var tr = document.getElementById('lead-tr-' + btn.getAttribute('data-i'));
        if (tr) { tr.hidden = !tr.hidden; btn.textContent = tr.hidden ? 'Show transcript' : 'Hide transcript'; }
        return;
      }
      if (act === 'schedule-open') {
        var box = document.getElementById('lead-sched');
        var input = document.getElementById('lead-sched-at');
        if (box) box.hidden = false;
        if (input && !input.value) {
          var d = new Date(lead && lead.call_back_at ? lead.call_back_at : Date.now() + 86400000);
          input.value = toLocalInput(d);
          input.focus();
        }
        return;
      }
      if (act === 'schedule-close') { var b2 = document.getElementById('lead-sched'); if (b2) b2.hidden = true; return; }
      if (!lead || state.busy) return;
      if (act === 'call') return confirmCall(lead);
      if (act === 'schedule') {
        var at = document.getElementById('lead-sched-at');
        var ms = at ? Date.parse(at.value) : NaN;
        if (!isFinite(ms)) { setActMsg('Pick a date and time first.', true); return; }
        return hazelAction(lead, { action: 'schedule', at: new Date(ms).toISOString() }, 'Call-back scheduled.');
      }
      if (act === 'unschedule') return hazelAction(lead, { action: 'unschedule' }, 'Call-back cleared.');
      if (act === 'pause') return hazelAction(lead, { action: 'pause' }, 'Hazel will leave this lead alone until you resume.');
      if (act === 'resume') return hazelAction(lead, { action: 'resume' }, 'Hazel may ring this lead again.');
      if (act === 'dnc') {
        if (!window.confirm('Mark ' + (lead.name || 'this lead') + ' as "do not call"? Hazel will never ring them again (chase emails stop too).')) return;
        return hazelAction(lead, { action: 'do_not_call' }, 'Marked do not call.');
      }
    });
    document.addEventListener('keydown', escClose);
  }
  function escClose(e) { if (e.key === 'Escape') { document.removeEventListener('keydown', escClose); closeDrawer(); } }
  function currentLead() {
    if (state.detail && state.detail.lead && state.detail.lead.id === state.openId) return state.detail.lead;
    return state.loaded.filter(function (l) { return l.id === state.openId; })[0] || null;
  }
  function toLocalInput(d) {
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // Ring now: show the doctor's local clock before the owner confirms, then
  // place the call. Nothing is dialled until they say yes.
  function confirmCall(lead) {
    var clock = theirClockNow(lead.tz, lead.country);
    var warn = '';
    var h = lead.hazel || {};
    if (h.state === 'burnt' || lead.stage.key === 'burnt') warn = '\n\nThis lead is marked burnt (' + (lead.stage.reason || h.label) + ').';
    else if (lead.call_booked) warn = '\n\nThis doctor already has a consultation booked.';
    if (!window.confirm('Ring ' + (lead.name || 'this lead') + ' now on ' + lead.phone + '?\n\nIt is ' + clock + '. Hazel\u2019s usual hours are Mon–Fri 9am–7:30pm and Sat 10am–4pm, their time.' + warn)) return;
    state.busy = true;
    setActMsg('Placing the call…');
    ATS.api('/api/ceo/leads/' + encodeURIComponent(lead.id) + '/call', { method: 'POST', body: {} }).then(function (d) {
      state.busy = false;
      if (!d || !d.ok) { setActMsg((d && d.message) || 'The call could not be placed.', true); return; }
      afterAction(d.lead, 'Hazel is ringing them now.');
    });
  }
  function hazelAction(lead, body, okMsg) {
    state.busy = true;
    setActMsg('Saving…');
    ATS.api('/api/ceo/leads/' + encodeURIComponent(lead.id) + '/hazel', { method: 'POST', body: body }).then(function (d) {
      state.busy = false;
      if (!d || !d.ok) { setActMsg((d && d.message) || 'Could not save.', true); return; }
      afterAction(d.lead, okMsg);
    });
  }
  function afterAction(lead, msg) {
    if (lead) {
      if (state.detail && state.detail.lead && state.detail.lead.id === lead.id) state.detail.lead = lead;
      patchLead(lead);
      var drawer = document.getElementById('lead-drawer');
      if (drawer && state.openId === lead.id) {
        drawer.innerHTML = drawerHtml(lead, state.detail ? state.detail.calls : null, state.detail ? state.detail.chase : null, !state.detail);
        wireDrawer();
      }
    }
    ATS.toast(msg);
    setActMsg(msg);
    // Counts and tiles moved; refresh them quietly, rows stay where they are.
    fetchAndRender(false, true);
  }

})();

/* Australian GP build (WP-22): the public job board's extra filters and fact
 * chips, and the public job page's facts, audience block and "Apply now".
 *
 * Loaded ONLY from an <!--au:on--> block of pages/site-jobs.html and
 * pages/site-job.html, so it is requested only with the Australian switch on.
 * js/site.js is the live site's file and is not edited by this build.
 *
 *   window.GPSiteAuJobs   the job board (pages/site-jobs.html)
 *   window.GPSiteAuJob    the job page  (pages/site-job.html)
 *
 * The reader's audience is not known, so nothing here says a role is for one
 * kind of doctor. Facts come from `auFacts` on the public payload; a fact the
 * practice has not stated is shown as "not stated" or left out, never guessed.
 * No dollar figure and no percentage is drawn (the server sends none).
 *
 *   /js/site-au-jobs.js?v=20261122a
 */
(function (root) {
  'use strict';

  var BILLING = { bulk: 'Bulk billing', mixed: 'Mixed billing', private: 'Private billing' };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }
  function clean(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

  // ── filters (the board) ──────────────────────────────────────────────────
  // The four controls. "loc" is one select that carries either the plain
  // metro / regional choice or one exact MMM category.
  var VR = { vr: 1, non_vr: 1 };
  var DPA = { yes: 1, no: 1, unknown: 1 };
  var SESSIONS = { part: 1, full: 1 };

  function normalise(extra) {
    var e = extra || {};
    var out = {};
    var vr = clean(e.vr).replace(/-/g, '_');
    if (VR[vr]) out.vr = vr;
    if (DPA[clean(e.dpa)]) out.dpa = clean(e.dpa);
    var area = clean(e.area);
    if (area === 'metro' || area === 'regional') out.area = area;
    var mmm = clean(e.mmm).replace(/^mm+/, '');
    if (/^[1-7]$/.test(mmm)) { out.mmm = mmm; delete out.area; }
    if (SESSIONS[clean(e.sessions)]) out.sessions = clean(e.sessions);
    return out;
  }

  function readUrl(params) {
    var get = function (k) { return params && typeof params.get === 'function' ? params.get(k) : ''; };
    return normalise({ vr: get('vr'), dpa: get('dpa'), area: get('area'), mmm: get('mmm'), sessions: get('sessions') });
  }

  function control(form, name) { return form ? form.querySelector('[name="' + name + '"]') : null; }

  function locValue(extra) {
    if (extra.mmm) return extra.mmm === '1' ? 'metro' : 'mm' + extra.mmm;
    return extra.area || '';
  }

  function readControls(form) {
    var val = function (name) { var el = control(form, name); return el ? el.value : ''; };
    var loc = clean(val('loc'));
    var extra = { vr: val('vr'), dpa: val('dpa'), sessions: val('sessions') };
    if (/^mm[1-7]$/.test(loc)) extra.mmm = loc.slice(2); else extra.area = loc;
    return normalise(extra);
  }

  function bind(form, extra, onChange) {
    var e = normalise(extra);
    var set = function (name, value) { var el = control(form, name); if (el) el.value = value || ''; };
    set('vr', e.vr); set('dpa', e.dpa); set('loc', locValue(e)); set('sessions', e.sessions);
    ['vr', 'dpa', 'loc', 'sessions'].forEach(function (name) {
      var el = control(form, name);
      if (el && typeof onChange === 'function') el.addEventListener('change', onChange);
    });
  }

  function clear(form) {
    ['vr', 'dpa', 'loc', 'sessions'].forEach(function (name) { var el = control(form, name); if (el) el.value = ''; });
  }

  function any(extra) {
    var e = normalise(extra);
    return !!(e.vr || e.dpa || e.area || e.mmm || e.sessions);
  }

  function appendParams(params, extra) {
    var e = normalise(extra);
    ['vr', 'dpa', 'area', 'mmm', 'sessions'].forEach(function (k) { if (e[k]) params.set(k, e[k]); });
    return params;
  }

  // ── chips (a board card) ─────────────────────────────────────────────────
  function sessionsText(f) {
    var a = Number(f.sessionsMin), b = Number(f.sessionsMax);
    var lo = f.sessionsMin != null && isFinite(a) && a > 0 ? a : null;
    var hi = f.sessionsMax != null && isFinite(b) && b > 0 ? b : null;
    if (lo && hi && lo !== hi) return Math.min(lo, hi) + ' to ' + Math.max(lo, hi) + ' sessions';
    var one = lo || hi;
    return one ? one + (one === 1 ? ' session' : ' sessions') : '';
  }

  function areaText(f) {
    var name = f.area === 'metro' ? 'Metropolitan' : (f.area === 'regional' ? 'Regional' : '');
    if (name && f.mmm != null) return name + ' (MM' + f.mmm + ')';
    if (name) return name;
    return f.mmm != null ? 'MM' + f.mmm : '';
  }

  function vrText(f) {
    if (!f.vrRequirementStated) return '';
    if (f.vrRequirement === 'non_vr_accepted') return 'Open to GPs without VR';
    if (f.vrRequirement === 'vr_preferred') return 'VR preferred';
    return 'VR required';
  }

  /** The chips for one card. `chipHtml(label, extraClass)` is the page's own. */
  function chips(job, chipHtml) {
    var f = (job && job.auFacts) || {};
    var out = [];
    var add = function (label, cls) { if (label) out.push(chipHtml(label, cls)); };
    add(BILLING[f.billingModel]);
    add(vrText(f));
    add(areaText(f));
    add(sessionsText(f));
    // DPA is a fact about the place. It is shown only when it is known to be
    // one; "not stated" is never drawn as "not a DPA".
    if (f.dpa === 'yes') add('DPA', 'dpa');
    if (f.engagementType === 'contract') add('Contract');
    return out;
  }

  // ── the note under the count ─────────────────────────────────────────────
  function setUnstated(n) {
    var el = document.getElementById('resultsNote');
    if (!el) return;
    var count = Number(n);
    if (!isFinite(count) || count <= 0) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = count === 1
      ? '1 more role does not state this yet, so it is not shown. Clear the filter to see it.'
      : count + ' more roles do not state this yet, so they are not shown. Clear the filter to see them.';
    el.hidden = false;
  }

  // ── the headline count: the real number of open roles ────────────────────
  function heroCount(el) {
    if (!el) return;
    fetch('/api/public/jobs?limit=1').then(function (res) {
      if (!res.ok) throw new Error('bad status');
      return res.json();
    }).then(function (data) {
      var total = data && data.ok === true ? Number(data.total) : NaN;
      if (!isFinite(total) || total <= 0) throw new Error('no count');
      el.textContent = total.toLocaleString() + (total === 1 ? ' open role' : ' open roles') + ' on the board today';
    }).catch(function () {
      el.textContent = 'Open roles across Australia';
    });
  }

  root.GPSiteAuJobs = {
    normalise: normalise, readUrl: readUrl, readControls: readControls, bind: bind, clear: clear, any: any,
    appendParams: appendParams, chips: chips, setUnstated: setUnstated, heroCount: heroCount,
    sessionsText: sessionsText, areaText: areaText, vrText: vrText
  };

  // ── the job page ─────────────────────────────────────────────────────────
  var ROW_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>';

  function applyHref(job) {
    return '/jobs/apply?id=' + encodeURIComponent(String((job && job.id) || ''));
  }

  /** The "Practice profile" rows: the role's facts, then perks that carry no figure. */
  function profileRows(job) {
    var f = (job && job.auFacts) || null;
    var rows = [];
    if (root.GPAuJobFacts && f) {
      root.GPAuJobFacts.rows(f, { showDpa: true, showNotStated: true }).forEach(function (r) { rows.push([r.label, r.value]); });
    }
    (Array.isArray(job && job.aiPerks) ? job.aiPerks : []).forEach(function (p) {
      if (p && p.label && p.value) rows.push([String(p.label), String(p.value)]);
    });
    var pt = (job && job.packageTerms && typeof job.packageTerms === 'object') ? job.packageTerms : {};
    if (pt.supervision) rows.push(['Supervision', 'Available']);
    return rows;
  }

  function movingLines(job) {
    var m = (job && job.movingToAustralia) || {};
    return (Array.isArray(m.lines) ? m.lines : []).filter(function (x) { return typeof x === 'string' && x.trim(); });
  }

  /** Called by the page once a job is drawn. Touches only this page's own elements. */
  function render(job) {
    if (!job) return;
    try { document.title = String(job.title || 'GP role') + ' | GP Link'; } catch (e) {}

    var chipsEl = document.getElementById('jobChips');
    if (chipsEl) {
      var chip = function (label, cls) { return '<span class="chip' + (cls ? ' ' + cls : '') + '">' + esc(label) + '</span>'; };
      var list = [];
      if (job.location_state) list.push(chip(job.location_state, 'state'));
      chipsEl.innerHTML = list.concat(chips(job, chip)).join('');
    }

    var rowsEl = document.getElementById('jobProfileRows');
    var wrap = document.getElementById('jobProfile');
    if (rowsEl) {
      var rows = profileRows(job);
      rowsEl.innerHTML = rows.map(function (row) {
        return '<div class="job-profile-row"><span class="rico">' + ROW_ICON + '</span>' +
          '<span class="rtext"><span class="rk">' + esc(row[0]) + '</span>' +
          '<span class="rv">' + esc(row[1]) + '</span></span></div>';
      }).join('');
      rowsEl.hidden = !rows.length;
      if (wrap && rows.length) wrap.hidden = false;
    }

    // What is only for a doctor moving country sits under that heading.
    var movingEl = document.getElementById('jobMovingLines');
    if (movingEl) {
      var lines = movingLines(job);
      movingEl.innerHTML = lines.map(function (line) {
        return '<li><span class="jh-dot">✓</span><span>' + esc(line) + '</span></li>';
      }).join('');
      movingEl.hidden = !lines.length;
      var movingLabel = document.getElementById('jobMovingLabel');
      if (movingLabel) movingLabel.hidden = !lines.length;
    }

    // "Apply now" carries this job through sign-up (the server keeps it).
    var href = applyHref(job);
    var links = document.querySelectorAll('[data-au-apply]');
    for (var i = 0; i < links.length; i++) links[i].setAttribute('href', href);
  }

  root.GPSiteAuJob = { render: render, profileRows: profileRows, movingLines: movingLines, applyHref: applyHref };

  if (typeof module !== 'undefined' && module.exports) module.exports = { GPSiteAuJobs: root.GPSiteAuJobs, GPSiteAuJob: root.GPSiteAuJob };
})(typeof window !== 'undefined' ? window : this);

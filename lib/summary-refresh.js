'use strict';

// Selection logic for the /api/cron/refresh-summaries background job — decides which
// candidate registration cases need their ai_handover_summary regenerated so the
// matcher's "background" stays current without a human opening each card.
//
// A case is picked when its summary is:
//   - missing   — never generated, OR
//   - changed   — the case has activity (updated_at / last_gp_activity_at) NEWER than
//                 the summary was generated (new comms / interview / doc / task), OR
//   - aged      — older than a safety floor even with no detected change (belt-and-braces
//                 re-sync in case some event source didn't bump the case row).
//
// Priority (so the most useful refreshes happen first within the per-run cap):
//   missing first, then freshest-activity-first, then oldest-summary-first.
// This makes it change-detection driven (quiet GPs cost nothing) while guaranteeing
// new GPs and recently-active GPs are refreshed promptly.
//
// ⚠️ THE FLOOR IS THE COST DRIVER — it fires on GPs where NOTHING changed.
// `missing` and `changed` are self-limiting: each fires once and is then satisfied
// until the GP does something. `aged` is not — it re-fires forever on a fixed clock,
// so every active case is rewritten every floor-period whether or not it needed it.
// At the original 48h that meant the queue never drained: with the cron at 2 runs/hour
// × 5 per run the job ran at capacity around the clock (~240 regenerations/day on
// Sonnet 5, ~$6/day). The floor is a backstop for a missed event bump, not a refresh
// policy — it should be the LONGEST period you would tolerate a silently-stale
// summary, not the shortest. Default 14 days; tune via SUMMARY_REFRESH_FLOOR_HOURS.
var DEFAULT_FLOOR_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function selectStaleSummaryCases(cases, nowMs, opts) {
  opts = opts || {};
  var floorMs = (opts.floorMs != null) ? opts.floorMs : DEFAULT_FLOOR_MS;
  var cap = (opts.cap != null) ? opts.cap : 5;
  var now = (typeof nowMs === 'number' && isFinite(nowMs)) ? nowMs : Date.now();

  function ts(v) { var n = v ? Date.parse(v) : 0; return isFinite(n) ? n : 0; }

  var picked = [];
  (Array.isArray(cases) ? cases : []).forEach(function (c) {
    if (!c || c.id == null) return;
    var summary = c.ai_handover_summary;
    var gen = (summary && summary.generated_at) ? ts(summary.generated_at) : 0;
    var activity = Math.max(ts(c.updated_at), ts(c.last_gp_activity_at));
    var missing = !(gen > 0);
    var changed = gen > 0 && activity > gen;
    var aged = gen > 0 && (now - gen) > floorMs;
    if (missing || changed || aged) {
      picked.push({ row: c, missing: missing, activity: activity, gen: gen });
    }
  });

  picked.sort(function (a, b) {
    if (a.missing !== b.missing) return a.missing ? -1 : 1;      // missing first
    if (b.activity !== a.activity) return b.activity - a.activity; // freshest activity first
    return a.gen - b.gen;                                         // then oldest summary first
  });

  return picked.slice(0, Math.max(0, cap)).map(function (x) { return x.row; });
}

module.exports = { selectStaleSummaryCases, DEFAULT_FLOOR_MS };

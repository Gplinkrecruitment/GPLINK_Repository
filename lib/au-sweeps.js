'use strict';

/**
 * Australian GP build, WP-04: pathway rules for scheduled jobs and sweeps.
 * Pure, no I/O. The reads live in server.js (`auSweepPathwayIndex`).
 *
 * Why it exists (docs/au-gp/review-report.md, ADM-04 / COM-02 / DAT-20): no
 * scheduled job knew a doctor's pathway. A doctor already working in Australia
 * was chased about MyIntealth, raised "no GP activity" tasks while having
 * nothing to do in the app, and was swept into overseas-worded nudges.
 *
 * ONE index, ONE predicate. A job loads the index once per run and asks it
 * about each candidate row:
 *
 *   const au = await auSweepPathwayIndex('weekly-sweep');   // server.js
 *   if (au.excludesUser(row.user_id)) continue;             // doctor-keyed rows
 *   if (au.excludesCase(caseRow)) continue;                 // case-keyed rows
 *
 * `excludes…` answers "must this job leave this doctor alone?" and is true for
 *   - a doctor on any Australian pathway (au_vr, au_restricted, au_non_vr,
 *     au_registrar), and
 *   - EVERY doctor when the pathways could not be read this run (`unreadable`):
 *     unknown fails closed, the job holds its overseas-worded action and tries
 *     again on its next run. A missing column (migration not applied) is NOT
 *     unreadable: without the column nobody is Australian, so nothing is held.
 *
 * With the switch off the index is inert: it was built without a query and
 * every answer is false, so each job behaves exactly as it does on main.
 *
 * A later package that gives a job real Australian behaviour (WP-17 nudge
 * copy, WP-07 document rules, WP-13 lifecycle reminders, ...) replaces that
 * job's single `excludes…` call with its own branch. The hooks are listed in
 * docs/au-gp/scheduled-jobs.md.
 */

const candidatePathway = require('./candidate-pathway.js');
const journeyLadders = require('./journey-ladders.js');

const EXCLUDE_REASON = Object.freeze({
  AU: 'au_pathway',
  UNREADABLE: 'pathway_unreadable'
});

function idKey(value) {
  return String(value == null ? '' : value).trim();
}

// Does this case row say "Australian" on its own (a mirrored pathway, or a
// stage that only exists on the Australian ladder)? Works on rows that were
// selected without those columns: a missing key is simply not Australian.
function caseRowLooksAustralian(caseRow) {
  if (!caseRow || typeof caseRow !== 'object') return false;
  if (caseRow.pathway && candidatePathway.isAuPathway(caseRow.pathway)) return true;
  return journeyLadders.isAuOnlyStage(caseRow.stage);
}

/**
 * Build the index a job asks about each row.
 *
 * @param {object} [input]
 * @param {boolean} [input.enabled]       the switch, as read by the caller at run time
 * @param {Iterable<string>} [input.userIds]  user ids on an Australian pathway
 * @param {boolean} [input.unreadable]    the read failed (not: column missing)
 * @param {boolean} [input.schemaMissing] the pathway column is not there
 * @param {string}  [input.job]           job name, for logs and the summary
 * @returns {object} index
 */
function buildAuSweepIndex(input) {
  const i = input || {};
  const enabled = i.enabled === true;
  const unreadable = enabled && i.unreadable === true;
  const userIds = new Set();
  if (enabled && !unreadable && i.userIds) {
    for (const id of i.userIds) { const k = idKey(id); if (k) userIds.add(k); }
  }
  let caseIds = null; // filled by setCaseIds when a job needs case-id lookups
  const counts = { au_pathway: 0, pathway_unreadable: 0 };
  const seen = new Set();

  function note(reason, key) {
    if (!reason) return;
    const k = reason + '|' + key;
    if (key && seen.has(k)) return;
    if (key) seen.add(k);
    counts[reason] = (counts[reason] || 0) + 1;
  }

  const index = {
    job: String(i.job || ''),
    enabled,
    unreadable,
    schemaMissing: enabled && i.schemaMissing === true,
    /** How many doctors are on an Australian pathway (0 when off / unreadable). */
    get size() { return userIds.size; },
    userIds,

    /** The fact, no counting: is this doctor on an Australian pathway? */
    isAuUser(userId) {
      return enabled && userIds.has(idKey(userId));
    },

    /** Why this doctor is left alone, or null. Does not count. */
    reasonForUser(userId) {
      if (!enabled) return null;
      if (unreadable) return EXCLUDE_REASON.UNREADABLE;
      return userIds.has(idKey(userId)) ? EXCLUDE_REASON.AU : null;
    },

    /** THE predicate for doctor-keyed rows. Counts each doctor once per run. */
    excludesUser(userId) {
      const why = index.reasonForUser(userId);
      if (why) note(why, 'u:' + idKey(userId));
      return !!why;
    },

    /** Why this case is left alone, or null. Does not count. */
    reasonForCase(caseRow) {
      if (!enabled) return null;
      if (unreadable) return EXCLUDE_REASON.UNREADABLE;
      if (caseRow && userIds.has(idKey(caseRow.user_id))) return EXCLUDE_REASON.AU;
      return caseRowLooksAustralian(caseRow) ? EXCLUDE_REASON.AU : null;
    },

    /** THE predicate for case rows ({ id, user_id, stage?, pathway? }). */
    excludesCase(caseRow) {
      const why = index.reasonForCase(caseRow);
      if (why) note(why, 'c:' + idKey(caseRow && (caseRow.id || caseRow.user_id)));
      return !!why;
    },

    /** Case ids of Australian doctors, when a job only has a case id in hand. */
    hasCaseIds() { return caseIds !== null; },
    setCaseIds(ids) {
      caseIds = new Set();
      if (ids) for (const id of ids) { const k = idKey(id); if (k) caseIds.add(k); }
    },
    /**
     * WP-14: why a bare case id would be left alone, or null. Does NOT count
     * (the supervised-practice jobs ask this first, then decide per doctor
     * whether a segment B doctor is included after all). Not loaded = cannot
     * tell = 'pathway_unreadable'. Call only after setCaseIds.
     */
    caseIdReason(caseId) {
      if (!enabled) return null;
      if (unreadable || caseIds === null) return EXCLUDE_REASON.UNREADABLE;
      return caseIds.has(idKey(caseId)) ? EXCLUDE_REASON.AU : null;
    },
    /** Predicate for a bare case id. Call only after setCaseIds (server: auSweepExcludesCaseId). */
    excludesCaseId(caseId) {
      if (!enabled) return false;
      if (unreadable || caseIds === null) {
        // Not loaded = cannot tell = hold.
        note(EXCLUDE_REASON.UNREADABLE, 'k:' + idKey(caseId));
        return true;
      }
      if (caseIds.has(idKey(caseId))) { note(EXCLUDE_REASON.AU, 'k:' + idKey(caseId)); return true; }
      return false;
    },

    /** For the job's JSON response and log line. Null when there is nothing to say. */
    summary() {
      if (!enabled) return null;
      return {
        au_pathway_doctors: userIds.size,
        excluded_au_pathway: counts.au_pathway,
        held_pathway_unreadable: counts.pathway_unreadable,
        unreadable,
        schema_missing: index.schemaMissing
      };
    }
  };
  return index;
}

/** The index every job gets with the switch off. Built without a query. */
function inertAuSweepIndex(job) {
  return buildAuSweepIndex({ enabled: false, job });
}

function validIso(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * ADM-04: the date an Australian case is aged from. NEVER the doctor's last
 * activity in the app: between milestones an Australian doctor has nothing to
 * do there, so "quiet for N days" says nothing about the case.
 *
 *   placement  -> when the case was created (how long we have been looking)
 *   prestart   -> when the placement was recorded
 *   commenced  -> the start date, once WP-13 records it; until then the
 *                 placement's own start date, then the placement record
 *   guarantee  -> the same anchor as commenced (the guarantee period runs from
 *                 the start date); WP-13 adds its own column
 *   complete   -> when the case was completed
 *
 * `placementRow` is the doctor's `placements` row (placed_at, start_date,
 * created_at) or null. WP-13 adds commencement / guarantee columns; pass them
 * on either row as `commenced_at`, `guarantee_started_at`, `guarantee_ends_at`
 * and they are used first. Falls back down the list, ending at the case's
 * created_at, so there is always an anchor when the case has a creation date.
 *
 * WP-13's daily lifecycle job (COM-40: provider number pending, indemnity
 * expiry, notice countdown, guarantee check-ins) ages cases with this.
 *
 * @returns {{ at: string|null, basis: string, stage: string }}
 */
function auCaseAgeAnchor(caseRow, placementRow) {
  const c = caseRow && typeof caseRow === 'object' ? caseRow : {};
  const p = placementRow && typeof placementRow === 'object' ? placementRow : {};
  const stage = String(c.stage || '').trim().toLowerCase();
  const pick = function (pairs) {
    for (let n = 0; n < pairs.length; n++) {
      const at = validIso(pairs[n][1]);
      if (at) return { at, basis: pairs[n][0], stage };
    }
    return { at: null, basis: 'none', stage };
  };
  const created = ['case_created', c.created_at];
  const placed = [['placement_recorded', p.placed_at], ['placement_recorded', p.created_at]];
  const started = [
    ['commenced', c.commenced_at], ['commenced', p.commenced_at],
    ['placement_start_date', p.start_date]
  ];
  if (stage === 'prestart') return pick(placed.concat([created]));
  if (stage === 'commenced') return pick(started.concat(placed, [created]));
  if (stage === 'guarantee') {
    return pick([['guarantee_started', c.guarantee_started_at], ['guarantee_started', p.guarantee_started_at]]
      .concat(started, placed, [created]));
  }
  if (stage === 'complete') return pick([['completed', c.completed_at]].concat(started, placed, [created]));
  // 'placement', and a case not yet moved onto the Australian ladder.
  return pick([created]);
}

/** Whole days between the anchor and now, or null when there is no anchor. */
function auCaseAgeDays(caseRow, placementRow, nowMs) {
  const anchor = auCaseAgeAnchor(caseRow, placementRow);
  if (!anchor.at) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return Math.max(0, Math.floor((now - new Date(anchor.at).getTime()) / 86400000));
}

module.exports = {
  EXCLUDE_REASON,
  buildAuSweepIndex,
  inertAuSweepIndex,
  caseRowLooksAustralian,
  auCaseAgeAnchor,
  auCaseAgeDays
};

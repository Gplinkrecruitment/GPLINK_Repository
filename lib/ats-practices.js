// Pure, dependency-free helpers for the ATS practices backfill + pipeline.
// No DB calls. Callers pass rows; logic is deterministic and testable.

// Kanban stages in pipeline order (excludes the terminal reject lane).
// 'shortlisted' (AI Matching) precedes 'applied' — a candidate can be matched
// to a job by the team/AI before they ever submit an application.
var ATS_STAGES = ['shortlisted', 'applied', 'submitted', 'reviewing', 'interview', 'offer', 'hired'];
var ATS_REJECT_STAGE = 'not_proceeding';

var ATS_STAGE_LABELS = {
  shortlisted: 'Shortlist',
  applied: 'Applied',
  submitted: 'Submitted to Practice',
  reviewing: 'Practice Reviewing',
  interview: 'Interview',
  offer: 'Offer',
  hired: 'Hired',
  not_proceeding: 'Not Proceeding'
};

// Rank used to compare how far a candidate has progressed.
var ATS_STAGE_RANK = {
  shortlisted: 0,
  applied: 1,
  submitted: 2,
  reviewing: 3,
  interview: 4,
  offer: 5,
  hired: 6
};

// Lowercase + trim a free-text status; null-safe.
function statusKey(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

// Canonical practice key: collapse whitespace, lowercase, strip trailing dots/commas.
function normalizePracticeName(name) {
  if (!name) return '';
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,]+$/, '');
}

// Dedupe practice names by canonical key, keeping the FIRST display spelling seen.
// Drops empties. Returns [{ key, display }] sorted by display (case-insensitive).
function dedupePracticeNames(names) {
  var list = Array.isArray(names) ? names : [];
  var byKey = {};
  list.forEach(function (raw) {
    var key = normalizePracticeName(raw);
    if (!key) return;
    if (!Object.prototype.hasOwnProperty.call(byKey, key)) {
      byKey[key] = { key: key, display: String(raw).trim() };
    }
  });
  return Object.keys(byKey)
    .map(function (k) { return byKey[k]; })
    .sort(function (a, b) {
      var da = a.display.toLowerCase();
      var db = b.display.toLowerCase();
      return da < db ? -1 : da > db ? 1 : 0;
    });
}

// Derive the kanban stage from a gp_applications row + whether an interview exists.
function deriveAtsStage(app, hasInterview) {
  var row = app || {};
  var status = statusKey(row.status);
  var sub = statusKey(row.practice_submission_status);

  // F13 (audit 2026-07-20): keep in lock-step with SECURED_STATUS_KEYS in
  // lib/ceo-metrics.js — 'secured' and 'placed' are secured there too.
  if (status === 'hired' || status === 'secured' || status === 'placed' || status === 'placement_secured' || status === 'offer_accepted' || status === 'contract_signed') {
    return 'hired';
  }
  if (status === 'rejected' || status === 'withdrawn') {
    return 'not_proceeding';
  }
  if (status === 'offer' || status === 'offered' || sub === 'client_approved') {
    return 'offer';
  }
  // Task 15: 'interview_completed' (Task 9's post-interview status, written
  // once the interview concludes and the practice-decision email fires)
  // stays in the 'interview' kanban lane — the pipeline doesn't advance
  // until the practice extends an offer or passes, so it must not fall
  // back to 'applied'.
  if (status === 'interview_scheduled' || status === 'interviewing' || status === 'interview_completed' || hasInterview === true || sub === 'interview_ready') {
    return 'interview';
  }
  if (sub === 'client_reviewed') {
    return 'reviewing';
  }
  if (status === 'submitted_to_practice' || sub === 'submitted_to_practice') {
    return 'submitted';
  }
  return 'applied';
}

// Decide whether an automatically derived stage may overwrite the stored
// kanban stage. Forward-only: a manually advanced card is never pulled
// backwards, and terminal lanes ('hired', 'not_proceeding') never move
// automatically. 'not_proceeding' may be applied from any non-terminal stage.
// Returns the stage to write, or null when nothing should change.
function planAtsStageReconciliation(storedStage, derivedStage) {
  var stored = statusKey(storedStage);
  var derived = statusKey(derivedStage);
  if (!derived || derived === stored) return null;
  // Terminal stored lanes never move automatically.
  if (stored === 'hired' || stored === ATS_REJECT_STAGE) return null;
  if (derived === ATS_REJECT_STAGE) return ATS_REJECT_STAGE;
  var storedRank = Object.prototype.hasOwnProperty.call(ATS_STAGE_RANK, stored) ? ATS_STAGE_RANK[stored] : -1;
  var derivedRank = Object.prototype.hasOwnProperty.call(ATS_STAGE_RANK, derived) ? ATS_STAGE_RANK[derived] : -1;
  if (derivedRank > storedRank) return derived;
  return null;
}

// Given a candidate's applications (each with .ats_stage), return the furthest
// non-'not_proceeding' stage, or null if there are none.
function bestAtsStage(apps) {
  var list = Array.isArray(apps) ? apps : [];
  var best = null;
  var bestRank = -1;
  list.forEach(function (app) {
    var stage = app && app.ats_stage;
    if (!stage || stage === ATS_REJECT_STAGE) return;
    if (!Object.prototype.hasOwnProperty.call(ATS_STAGE_RANK, stage)) return;
    var rank = ATS_STAGE_RANK[stage];
    if (rank > bestRank) {
      bestRank = rank;
      best = stage;
    }
  });
  return best;
}

// Pipeline buckets that PARTITION the candidate universe (every GP lands in
// exactly one). 'unassociated' = no applications at all; the rest mirror the
// kanban stages. There is deliberately NO terminal reject bucket here — owner
// rule: no GP should ever be shown sitting in a "Not proceeding" segment.
// A GP whose applications are all terminal (not_proceeding) reads as
// 'unassociated' instead (see bucketForApps below). The kanban board itself
// (ATS_STAGES / ATS_REJECT_STAGE / countAtsStages) is unaffected — that
// application-level "Not proceeding" lane still exists.
var PIPELINE_BUCKETS = ['unassociated', 'shortlisted', 'applied', 'submitted', 'reviewing', 'interview', 'offer', 'hired'];

var PIPELINE_BUCKET_LABELS = {
  unassociated: 'Unassociated',
  shortlisted: 'Shortlist',
  applied: 'Applied',
  submitted: 'Submitted',
  reviewing: 'Reviewing',
  interview: 'Interview',
  offer: 'Offer',
  hired: 'Hired'
};

// Classify a candidate into a single pipeline bucket from their applications.
// No apps -> 'unassociated'. Otherwise the furthest active stage; if every
// remaining app is 'not_proceeding' (terminal, no live application anywhere)
// -> 'unassociated' — a GP is never shown parked in a "Not proceeding"
// segment; they go back to the pool instead.
// Applications closed because the opening was filled by SOMEONE ELSE
// (match_outcome === 'position_filled') don't count at all: that candidate goes
// back to the pool ('unassociated') — or on under their other applications —
// rather than reading as "rejected". A genuine rejection has no such outcome,
// but now resolves to the SAME place (unassociated) since 'not_proceeding' is
// no longer a selectable pipeline bucket.
function bucketForApps(apps) {
  var list = (Array.isArray(apps) ? apps : []).filter(function (a) {
    return !(a && a.match_outcome === 'position_filled');
  });
  if (!list.length) return 'unassociated';
  var best = bestAtsStage(list);
  if (best) return best;
  return 'unassociated';
}

// True if ANY of a candidate's applications is a "new application" by the SAME
// definition the /api/ats/attention "New applications" tile counts: the app's
// stage resolves to 'applied' (empty/unknown treated as 'applied', matching the
// insert default) AND it was applied on/after `sinceIso`. This lets the
// candidate list reconcile with the tile's count: a GP whose furthest stage
// (bucketForApps) has already moved past 'applied' on another role — so the
// 'applied' pipeline bucket hides them — is still surfaced by their fresh apply.
function hasFreshApply(apps, sinceIso) {
  var list = Array.isArray(apps) ? apps : [];
  var since = String(sinceIso || '');
  for (var i = 0; i < list.length; i++) {
    var a = list[i] || {};
    var stage = a.ats_stage || 'applied';
    if (stage !== 'applied') continue;
    var when = a.applied_at || a.created_at || '';
    if (when && String(when) >= since) return true;
  }
  return false;
}

// Count application rows per ats_stage. Rows with an empty/unknown stage count
// as 'applied' (the insert default). Every stage key — including the terminal
// 'not_proceeding' lane — is always present (zeros included) so callers can
// render a complete funnel without null checks.
function countAtsStages(rows) {
  var counts = {};
  ATS_STAGES.forEach(function (s) { counts[s] = 0; });
  counts[ATS_REJECT_STAGE] = 0;
  (Array.isArray(rows) ? rows : []).forEach(function (row) {
    var key = statusKey(row && row.ats_stage);
    if (!Object.prototype.hasOwnProperty.call(counts, key)) key = 'applied';
    counts[key] += 1;
  });
  return counts;
}

// ---- Secondary practice contacts -------------------------------------------
// A practice has ONE primary contact (practices.contact_email) who receives
// every practice-facing email, plus any number of SECONDARY contacts stored in
// practices.secondary_contacts. Secondary contacts are CC'd on exactly one
// email — the introduction sent when a candidate is first presented/matched to
// the practice (server.js submit-to-practice) — and never on anything after it.
// Owner rule, 2026-08-05.
var MAX_SECONDARY_CONTACTS = 10;

// Deliberately permissive: this mirrors what the browser's type=email check
// accepts rather than trying to be RFC-5322 complete. Its job is to stop
// obvious typos ("no @", trailing comma) reaching Resend as a CC, not to
// adjudicate exotic-but-legal addresses.
function looksLikeEmail(value) {
  var s = String(value == null ? '' : value).trim();
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s);
}

/**
 * Normalizes whatever the client/DB hands us into a clean, storable list of
 * secondary contacts: [{ name, email }].
 *
 * Accepts an array of objects ({name,email}), an array of bare email strings,
 * or a JSON string (the shape PostgREST hands back when a jsonb column is
 * stored as text). Anything unrecognisable normalizes to [] rather than
 * throwing — a malformed row must never break a practice save or, worse, an
 * introduction email.
 *
 * Guarantees, in order:
 *   - invalid / empty addresses are dropped
 *   - addresses are lowercased and de-duplicated (first spelling of the name wins)
 *   - `excludeEmail` (the primary contact) is removed, so the To can never
 *     also appear in the CC
 *   - the list is capped at MAX_SECONDARY_CONTACTS
 */
function normalizeSecondaryContacts(value, excludeEmail) {
  var raw = value;
  if (typeof raw === 'string') {
    var trimmed = raw.trim();
    if (!trimmed) return [];
    try { raw = JSON.parse(trimmed); } catch (e) { raw = trimmed.split(/[,;\n]+/); }
  }
  if (!Array.isArray(raw)) return [];
  var skip = String(excludeEmail == null ? '' : excludeEmail).trim().toLowerCase();
  var seen = {};
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var entry = raw[i];
    var email = '';
    var name = '';
    if (typeof entry === 'string') {
      email = entry;
    } else if (entry && typeof entry === 'object') {
      email = entry.email || entry.contact_email || entry.address || '';
      name = entry.name || entry.contact_name || '';
    }
    email = String(email == null ? '' : email).trim().toLowerCase();
    if (!looksLikeEmail(email)) continue;
    if (skip && email === skip) continue;
    if (Object.prototype.hasOwnProperty.call(seen, email)) continue;
    seen[email] = true;
    out.push({ name: String(name == null ? '' : name).trim(), email: email });
    if (out.length >= MAX_SECONDARY_CONTACTS) break;
  }
  return out;
}

// Just the addresses, ready to hand to sendEmail's `cc`. Returns [] (never
// null) so a caller can safely do `cc.length ? cc : undefined`.
function secondaryContactEmails(value, excludeEmail) {
  return normalizeSecondaryContacts(value, excludeEmail).map(function (c) { return c.email; });
}

// ── Practice soft-delete (12-month archive) ─────────────────────────────────
//
// Deleting a practice does NOT remove anything straight away. The practice and
// every job opening attached to it are archived together for 12 months, can be
// restored together, and only then are they purged for real (cron).
//
// The whole record lives in `practices.metadata.deleted` rather than in
// dedicated columns. Two reasons:
//   1. It needs no migration, so the feature is not silently dead on a database
//      where the migration has not been applied — and on this project selecting
//      a column that does not exist 400s the ENTIRE query, taking the Practices
//      tab down with it. (Same reasoning as the existing
//      `metadata.pipeline_agreement` degraded stash.)
//   2. `practices` is a ~60-row table, so filtering and finding due rows in JS
//      costs nothing.
// `metadata` is jsonb and already carries intake/agreement state — ALWAYS merge,
// never overwrite it wholesale.
var PRACTICE_DELETE_RETENTION_MONTHS = 12;

// Month arithmetic that never rolls into the following month: 31 Aug + 12mo is
// 31 Aug next year, but 31 Aug + 6mo clamps to 28/29 Feb rather than 2/3 Mar.
function addMonthsIso(iso, months) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  var day = d.getUTCDate();
  var target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + Number(months || 0), 1,
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  var lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString();
}

// Everything needed to put the practice AND its jobs back exactly as they were.
// `jobs` are the rows as they stand BEFORE they are retired.
function buildPracticeDeletionRecord(opts) {
  var o = opts || {};
  var nowIso = o.nowIso || new Date().toISOString();
  var months = o.retentionMonths == null ? PRACTICE_DELETE_RETENTION_MONTHS : Number(o.retentionMonths);
  var practice = o.practice || {};
  return {
    at: nowIso,
    purge_after: addMonthsIso(nowIso, months),
    by: String(o.actorEmail || ''),
    retention_months: months,
    restore: {
      // The lifecycle stage the practice sat at, so a restore does not silently
      // promote an archived/declined practice back to "active".
      stage: practice.stage || 'active',
      jobs: (o.jobs || []).map(function (j) {
        return {
          id: j.id,
          is_active: j.is_active !== false,
          job_status: j.job_status || 'open',
          approval_status: j.approval_status || 'approved'
        };
      })
    }
  };
}

// Normalized read of the record, or null when the practice is not deleted.
// Tolerates a half-written record (a restore must never throw on bad data).
function readPracticeDeletion(practice) {
  var meta = practice && practice.metadata;
  var rec = meta && typeof meta === 'object' ? meta.deleted : null;
  if (!rec || typeof rec !== 'object' || !rec.at) return null;
  var restore = (rec.restore && typeof rec.restore === 'object') ? rec.restore : {};
  return {
    at: String(rec.at),
    purgeAfter: rec.purge_after ? String(rec.purge_after) : addMonthsIso(String(rec.at), PRACTICE_DELETE_RETENTION_MONTHS),
    by: String(rec.by || ''),
    retentionMonths: rec.retention_months == null ? PRACTICE_DELETE_RETENTION_MONTHS : Number(rec.retention_months),
    restoreStage: restore.stage || 'active',
    jobs: Array.isArray(restore.jobs) ? restore.jobs : []
  };
}

function isPracticeDeleted(practice) {
  return !!readPracticeDeletion(practice);
}

// Purge only once the retention window has genuinely elapsed. A record with an
// unreadable purge_after is NEVER due — it is not worth destroying data over a
// malformed timestamp.
function practicePurgeDue(practice, nowIso) {
  var rec = readPracticeDeletion(practice);
  if (!rec || !rec.purgeAfter) return false;
  var due = new Date(rec.purgeAfter).getTime();
  var now = new Date(nowIso || new Date().toISOString()).getTime();
  if (isNaN(due) || isNaN(now)) return false;
  return now >= due;
}

// Whole days left before the purge — what the "Recently deleted" card counts
// down. Never negative; 0 means it is due on the next cron run.
function practiceRestoreDaysLeft(practice, nowIso) {
  var rec = readPracticeDeletion(practice);
  if (!rec || !rec.purgeAfter) return null;
  var due = new Date(rec.purgeAfter).getTime();
  var now = new Date(nowIso || new Date().toISOString()).getTime();
  if (isNaN(due) || isNaN(now)) return null;
  return Math.max(0, Math.ceil((due - now) / 86400000));
}

// Hides a job everywhere at once: off the public board (which filters
// is_active + job_status=open) and out of the practices directory, which also
// merges in `approval_status='pending'` rows.
function retiredJobPatch(job) {
  var patch = { is_active: false, job_status: 'closed' };
  if (job && job.approval_status === 'pending') patch.approval_status = 'rejected';
  return patch;
}

// The exact inverse, driven by the snapshot taken at delete time.
function restoredJobPatch(saved) {
  var s = saved || {};
  return {
    is_active: s.is_active !== false,
    job_status: s.job_status || 'open',
    approval_status: s.approval_status || 'approved'
  };
}

module.exports = {
  PRACTICE_DELETE_RETENTION_MONTHS,
  addMonthsIso,
  buildPracticeDeletionRecord,
  readPracticeDeletion,
  isPracticeDeleted,
  practicePurgeDue,
  practiceRestoreDaysLeft,
  retiredJobPatch,
  restoredJobPatch,
  normalizePracticeName,
  dedupePracticeNames,
  countAtsStages,
  normalizeSecondaryContacts,
  secondaryContactEmails,
  MAX_SECONDARY_CONTACTS,
  deriveAtsStage,
  planAtsStageReconciliation,
  ATS_STAGES,
  ATS_REJECT_STAGE,
  ATS_STAGE_LABELS,
  bestAtsStage,
  PIPELINE_BUCKETS,
  PIPELINE_BUCKET_LABELS,
  bucketForApps,
  hasFreshApply
};

'use strict';

/**
 * Australian GP build, WP-27: THE Australian pipeline.
 *
 *   Matched -> Interview -> Contract -> Pre-start -> Commenced -> Guarantee
 *   (closing states: Complete, Ended)
 *
 * Pure: no database, no clock of its own, no switch. `server.js` reads the
 * facts once per request (`auPipelineFacts`) and hands them in; the Overview,
 * the Registration -> Pipeline view, the weekly digest and the review queue
 * all draw from what this returns, so they cannot disagree.
 *
 * THE DEFINITIONS (docs/au-gp/metrics.md repeats them for the owner).
 * Every Australian doctor is in exactly ONE group, worked out from facts on
 * file for their CURRENT placement cycle, never from a stage word someone
 * typed:
 *
 *   excluded     archived account, an owner test account, or a withdrawn case.
 *                Counted nowhere.
 *   onboarding   the profile is not finished and there is no application and
 *                no placement (includes a doctor part-way through the
 *                Australian onboarding branch, who has no pathway yet).
 *   pre-start    the current placement is recorded and the doctor has not
 *                started (an active placement row with no commencement date,
 *                or an application recorded as placement secured with no row
 *                yet).
 *   commenced    staff confirmed the doctor started, fewer than 7 days ago.
 *   guarantee    started 7 or more days ago, the 12-week guarantee period
 *                still running (it includes its last day).
 *   complete     the guarantee period has finished, the doctor is still there
 *                and is not looking again.
 *   ended        the newest placement ended (the doctor left) and the doctor
 *                is not looking again.
 *   held         the pathway is one that is built but not launched (segment B
 *                `au_restricted`, segment C `au_non_vr` / `au_registrar`) and
 *                there is no current placement. Shown as "needs review",
 *                NEVER in a pipeline column.
 *   contract     no current placement; an open application is at the offer
 *                stage (an offer or contract is out, or accepted with the
 *                placement not yet recorded).
 *   interview    none of the above; an open application is at the interview
 *                stage, has an interview booked, or has had one.
 *   matched      none of the above; there is at least one open application
 *                (applied, shortlisted, matched or submitted to the practice).
 *   looking      profile finished, no open application, no current placement.
 *
 * "Current placement cycle": a doctor whose earlier placement finished and who
 * is looking again (the case is back at `placement`, CONVENTIONS section 31)
 * is counted once, in the column of the new cycle; the finished placement is
 * still counted in the placement, commencement and commercial figures, which
 * are per placement, not per doctor.
 *
 * The placement half is not re-derived here: it is
 * `lib/au-lifecycle.js caseStageFromPlacementFacts`, the same function the
 * daily job uses to move the case.
 *
 * Calendar-date rule (CONVENTIONS section 25): a placement is judged on its
 * own practice's date (`dayFor(row)`), days are counted on dates.
 */

const candidatePathway = require('./candidate-pathway.js');
const lifecycle = require('./au-lifecycle.js');
const fees = require('./au-placement-fees.js');
const ceoMetrics = require('./ceo-metrics.js');
const stalledApplications = require('./stalled-applications.js');

const DAY_MS = 24 * 60 * 60 * 1000;

const COLUMN = Object.freeze({
  MATCHED: 'matched', INTERVIEW: 'interview', CONTRACT: 'contract',
  PRESTART: 'prestart', COMMENCED: 'commenced', GUARANTEE: 'guarantee'
});
const GROUP = Object.freeze({
  EXCLUDED: 'excluded', ONBOARDING: 'onboarding', LOOKING: 'looking', HELD: 'held',
  COMPLETE: 'complete', ENDED: 'ended'
});
// The six pipeline columns, in order, with the words staff read.
const PIPELINE_COLUMNS = Object.freeze([
  Object.freeze({ key: COLUMN.MATCHED, label: 'Matched' }),
  Object.freeze({ key: COLUMN.INTERVIEW, label: 'Interview' }),
  Object.freeze({ key: COLUMN.CONTRACT, label: 'Contract' }),
  Object.freeze({ key: COLUMN.PRESTART, label: 'Pre-start' }),
  Object.freeze({ key: COLUMN.COMMENCED, label: 'Commenced' }),
  Object.freeze({ key: COLUMN.GUARANTEE, label: 'Guarantee' })
]);
const BEFORE_GROUPS = Object.freeze([
  Object.freeze({ key: GROUP.ONBOARDING, label: 'Finishing their profile' }),
  Object.freeze({ key: GROUP.LOOKING, label: 'Looking, not yet matched' })
]);
const CLOSING_GROUPS = Object.freeze([
  Object.freeze({ key: GROUP.COMPLETE, label: 'Complete' }),
  Object.freeze({ key: GROUP.ENDED, label: 'Ended' })
]);
const GROUP_LABEL = (function () {
  const m = { held: 'Needs review (not launched)', excluded: 'Not counted' };
  PIPELINE_COLUMNS.concat(BEFORE_GROUPS, CLOSING_GROUPS).forEach(function (g) { m[g.key] = g.label; });
  return Object.freeze(m);
})();
const PATHWAY_LABEL = Object.freeze({
  au_vr: 'Australian VR', au_restricted: 'Australian restricted', au_non_vr: 'Non-VR', au_registrar: 'Registrar'
});
// An application that says the offer was accepted but whose placement has not
// been recorded is still at "Contract" (a placement is a fact on file, never a
// card dragged to Hired: CONVENTIONS section 14).
const CONTRACT_STATUS_KEYS = Object.freeze(['offer_accepted', 'contract_signed', 'hired', 'secured', 'placed']);
// The one application status that IS the placement fact when no row exists yet.
const PLACEMENT_SECURED_STATUS_KEYS = Object.freeze(['placement_secured', 'practice_secured']);
const TEST_EMAIL_FRAGMENTS = Object.freeze(['khaleedmahmoud']);
const TEST_EMAILS_EXACT = Object.freeze(['hazel@mygplink.com.au', 'hello@mygplink.com.au']);

function str(v) { return v == null ? '' : String(v); }
function arr(v) { return Array.isArray(v) ? v.filter(Boolean) : []; }
function ms(v) { const t = Date.parse(str(v)); return Number.isFinite(t) ? t : NaN; }
function statusKey(v) { return ceoMetrics.normalizeStatusKey(v); }

function isTestEmail(email) {
  const e = str(email).trim().toLowerCase();
  if (!e) return false;
  if (TEST_EMAILS_EXACT.indexOf(e) !== -1) return true;
  return TEST_EMAIL_FRAGMENTS.some(function (f) { return e.indexOf(f) !== -1; });
}
function doctorName(p) {
  const name = [str(p && p.first_name).trim(), str(p && p.last_name).trim()].filter(Boolean).join(' ').replace(/^Dr\.?\s+/i, '');
  if (name) return 'Dr ' + name;
  return str(p && p.email) || 'Unknown doctor';
}
function durationStats(days) {
  const list = arr(days.map(function (d) { return Number.isFinite(d) ? { d } : null; })).map(function (x) { return x.d; });
  if (!list.length) return { median_days: null, avg_days: null, sample_size: 0 };
  const s = list.slice().sort(function (a, b) { return a - b; });
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  const avg = list.reduce(function (a, b) { return a + b; }, 0) / list.length;
  return { median_days: Math.round(median * 10) / 10, avg_days: Math.round(avg * 10) / 10, sample_size: list.length };
}
// The calendar date an instant fell on (the documented fallback zone).
function dayOfInstant(value, zone) {
  const t = ms(value);
  return Number.isFinite(t) ? lifecycle.localDay(t, zone || lifecycle.FALLBACK_ZONE) : '';
}
function daysFrom(fromDay, toDay) {
  const a = fees.cleanDay(fromDay), b = fees.cleanDay(toDay);
  if (!a || !b) return null;
  return Math.max(0, fees.daysBetween(a, b));
}

/** Is this application still in the running (not closed, not a placement)? */
function isOpenApplication(app) {
  return stalledApplications.isOpen(app);
}
function isContractApplication(app) {
  if (!app) return false;
  if (ceoMetrics.isOfferApp(app)) return true;
  if (CONTRACT_STATUS_KEYS.indexOf(statusKey(app.status)) !== -1) return true;
  return statusKey(app.ats_stage) === 'hired';
}
function isPlacementSecuredApplication(app) {
  return !!app && PLACEMENT_SECURED_STATUS_KEYS.indexOf(statusKey(app.status)) !== -1;
}

/**
 * Where ONE doctor is. Pure.
 * @returns {{ group, since, placement, application, basis }}
 *   `group` is one of the keys above; `since` is the calendar date the doctor
 *   entered it ('' when not known); `placement` / `application` is the row the
 *   answer came from.
 */
function classifyDoctor(input) {
  const i = input && typeof input === 'object' ? input : {};
  const profile = i.profile || {};
  const cases = arr(i.cases);
  const apps = arr(i.applications);
  const placements = arr(i.placements);
  const interviewAppIds = i.interviewAppIds instanceof Set ? i.interviewAppIds : new Set();
  const dayFor = typeof i.dayFor === 'function' ? i.dayFor : function () { return str(i.today); };
  const today = fees.cleanDay(str(i.today)) || '';
  const pathway = str(i.pathway || profile.candidate_pathway);
  const out = { group: '', since: '', placement: null, application: null, basis: '' };

  if (str(profile.account_status) === 'archived' || profile.archived_at || isTestEmail(profile.email)) {
    out.group = GROUP.EXCLUDED; out.basis = 'archived_or_test'; return out;
  }
  const liveCases = cases.filter(function (c) { return str(c.status) !== 'withdrawn'; });
  if (cases.length && !liveCases.length) { out.group = GROUP.EXCLUDED; out.basis = 'withdrawn'; return out; }
  const caseRow = liveCases[0] || null;

  // The placement half: the same function the daily job moves the case with.
  const livePlacements = placements.filter(function (p) { return statusKey(p.status) !== 'cancelled'; });
  const rowAppIds = {};
  placements.forEach(function (p) { if (p.application_id != null) rowAppIds[str(p.application_id)] = true; });
  const securedWithoutRow = apps.filter(function (a) { return isPlacementSecuredApplication(a) && !rowAppIds[str(a.id)]; })[0] || null;
  const lookingAgain = !!caseRow && str(caseRow.stage) === 'placement';
  const fact = lifecycle.caseStageFromPlacementFacts({
    placements: livePlacements, dayFor: dayFor, today: today, lookingAgain: lookingAgain,
    securedApplicationWithoutRow: !!securedWithoutRow
  });
  const factRow = fact.placementId ? (livePlacements.filter(function (p) { return str(p.id) === fact.placementId; })[0] || null) : null;
  const rowDay = factRow ? (fees.cleanDay(str(dayFor(factRow))) || today) : today;

  if (fact.stage === 'prestart') {
    out.group = COLUMN.PRESTART; out.placement = factRow; out.basis = fact.basis;
    out.application = factRow ? null : securedWithoutRow;
    out.since = factRow ? dayOfInstant(factRow.placed_at || factRow.created_at) : dayOfInstant(securedWithoutRow && (securedWithoutRow.ats_stage_updated_at || securedWithoutRow.updated_at));
    return out;
  }
  if (fact.stage === 'commenced' || fact.stage === 'guarantee') {
    const commenced = fees.cleanDay(str(factRow && factRow.commenced_at));
    out.group = fact.stage === 'commenced' ? COLUMN.COMMENCED : COLUMN.GUARANTEE;
    out.placement = factRow; out.basis = fact.basis;
    out.since = fact.stage === 'commenced' ? commenced : fees.addDays(commenced, lifecycle.WEEK1_DAYS);
    return out;
  }
  if (fact.stage === 'complete') {
    out.placement = factRow; out.basis = fact.basis;
    if (fact.basis === 'placement_ended') {
      out.group = GROUP.ENDED;
      out.since = fees.cleanDay(str(factRow && factRow.ended_at)) || '';
    } else {
      const commencedOn = fees.cleanDay(str(factRow && factRow.commenced_at));
      const ends = fees.cleanDay(str(factRow && factRow.guarantee_ends_at)) || (commencedOn ? fees.guaranteeEndsOn(commencedOn) : '');
      out.group = GROUP.COMPLETE;
      out.since = ends ? fees.addDays(ends, 1) : '';
    }
    return out;
  }

  // No current placement from here on.
  const open = apps.filter(function (a) { return !rowAppIds[str(a.id)] && !isPlacementSecuredApplication(a) && (isOpenApplication(a) || isContractApplication(a)); })
    .filter(function (a) { const s = statusKey(a.status); return s !== 'withdrawn' && s !== 'not_proceeding' && s !== 'rejected' && s !== 'declined' && s !== 'unsuccessful' && s !== 'offer_declined' && s !== 'position_filled' && statusKey(a.ats_stage) !== 'not_proceeding'; });

  if (candidatePathway.isAuPathway(pathway) && !candidatePathway.isLaunchedAuPathway(pathway)) {
    out.group = GROUP.HELD; out.basis = 'pathway_not_launched';
    out.since = dayOfInstant(profile.pathway_set_at || profile.created_at);
    out.application = open[0] || null;
    return out;
  }
  if (!open.length && !profile.onboarding_completed_at) {
    out.group = GROUP.ONBOARDING; out.basis = pathway ? 'profile_not_finished' : 'branch_started';
    out.since = dayOfInstant(profile.created_at);
    return out;
  }
  const newestFirst = function (field) {
    return function (a, b) { return (ms(b[field]) || 0) - (ms(a[field]) || 0); };
  };
  const contract = open.filter(isContractApplication).sort(newestFirst('ats_stage_updated_at'))[0];
  if (contract) {
    out.group = COLUMN.CONTRACT; out.application = contract; out.basis = 'offer_stage';
    out.since = dayOfInstant(contract.ats_stage_updated_at || contract.updated_at || contract.applied_at);
    return out;
  }
  const interview = open.filter(function (a) { return ceoMetrics.isInterviewingApp(a, interviewAppIds) || !!a.interview_completed_at; }).sort(newestFirst('ats_stage_updated_at'))[0];
  if (interview) {
    out.group = COLUMN.INTERVIEW; out.application = interview; out.basis = 'interview_stage';
    out.since = dayOfInstant(interview.ats_stage_updated_at || interview.practice_decision_at || interview.submitted_to_practice_at || interview.applied_at);
    return out;
  }
  if (open.length) {
    const first = open.slice().sort(function (a, b) { return (ms(a.applied_at || a.matched_at) || 0) - (ms(b.applied_at || b.matched_at) || 0); })[0];
    out.group = COLUMN.MATCHED; out.application = first; out.basis = 'open_application';
    out.since = dayOfInstant(first.applied_at || first.matched_at || first.updated_at);
    return out;
  }
  out.group = GROUP.LOOKING; out.basis = lookingAgain && placements.length ? 'looking_again' : 'no_application';
  out.since = dayOfInstant(profile.onboarding_completed_at || profile.created_at);
  return out;
}

/**
 * What to say about ONE placement's start, truthfully (walk finding W3-D24:
 * "starts Mon 11 Jan" was shown for a doctor who had already started).
 * @returns {{ phase, state, date, text }}
 */
function placementStartLine(row, today) {
  const phase = lifecycle.placementPhase(row, today);
  const start = fees.cleanDay(str(row && row.start_date));
  const commenced = fees.cleanDay(str(row && row.commenced_at));
  const ended = fees.cleanDay(str(row && row.ended_at));
  const day = fees.cleanDay(str(today));
  if (phase === 'cancelled') return { phase, state: 'cancelled', date: null, text: 'cancelled' };
  if (phase === 'ended') return { phase, state: 'ended', date: ended || null, text: ended ? 'ended ' + lifecycle.longDay(ended) : 'ended' };
  if (commenced) return { phase, state: 'started', date: commenced, text: 'started ' + lifecycle.longDay(commenced) };
  if (!start) return { phase, state: 'no_date', date: null, text: 'start date to be confirmed' };
  if (day && start < day) return { phase, state: 'start_passed', date: start, text: 'was due to start ' + lifecycle.longDay(start) + ' (start not yet confirmed)' };
  if (day && start === day) return { phase, state: 'starts_today', date: start, text: 'due to start today' };
  return { phase, state: 'starts', date: start, text: 'starts ' + lifecycle.longDay(start) };
}

/**
 * buildAuPipeline(input) -> the whole Australian picture.
 *
 *   input.nowMs         the clock
 *   input.today         YYYY-MM-DD in the fallback zone (default: from nowMs)
 *   input.dayFor(row)   a placement row's own practice date
 *   input.windowDays    7 or 30 (the Overview's window)
 *   input.doctors       [{ user_id, pathway, first_name, last_name, email, created_at,
 *                          onboarding_completed_at, account_status, archived_at, pathway_set_at }]
 *   input.cases, .applications, .placements, .interviews, .credentials, .leads
 */
function buildAuPipeline(input) {
  const i = input && typeof input === 'object' ? input : {};
  const nowMs = Number.isFinite(Number(i.nowMs)) ? Number(i.nowMs) : Date.now();
  const today = fees.cleanDay(str(i.today)) || lifecycle.localDay(nowMs, lifecycle.FALLBACK_ZONE);
  const dayFor = typeof i.dayFor === 'function' ? i.dayFor : function () { return today; };
  const windowDays = Number(i.windowDays) === 30 ? 30 : 7;
  const doctors = arr(i.doctors);
  const by = function (rows, key) {
    const m = {};
    arr(rows).forEach(function (r) { const k = str(r[key]); if (!k) return; (m[k] = m[k] || []).push(r); });
    return m;
  };
  const casesBy = by(i.cases, 'user_id');
  const appsBy = by(i.applications, 'user_id');
  const placementsBy = by(i.placements, 'user_id');
  const credBy = {};
  arr(i.credentials).forEach(function (c) { if (c.user_id) credBy[str(c.user_id)] = c; });
  const interviews = arr(i.interviews).filter(function (r) { return statusKey(r.status) !== 'cancelled'; });
  const interviewAppIds = new Set();
  interviews.forEach(function (r) {
    if (r.application_id != null && /^(booked|completed)$/.test(statusKey(r.status))) interviewAppIds.add(r.application_id);
  });
  const appById = {};
  arr(i.applications).forEach(function (a) { if (a.id != null) appById[str(a.id)] = a; });
  const roleName = typeof i.practiceNameFor === 'function' ? i.practiceNameFor : function () { return ''; };

  const groups = {};
  Object.keys(GROUP_LABEL).forEach(function (k) { groups[k] = []; });
  const classified = {};
  doctors.forEach(function (p) {
    const uid = str(p.user_id);
    if (!uid || classified[uid]) return;
    const pathway = str(p.pathway || p.candidate_pathway);
    const c = classifyDoctor({
      profile: p, pathway: pathway, cases: casesBy[uid], applications: appsBy[uid], placements: placementsBy[uid],
      interviewAppIds: interviewAppIds, dayFor: dayFor, today: today
    });
    classified[uid] = c;
    const caseRow = arr(casesBy[uid]).filter(function (x) { return str(x.status) !== 'withdrawn'; })[0] || arr(casesBy[uid])[0] || null;
    const rowToday = c.placement ? (fees.cleanDay(str(dayFor(c.placement))) || today) : today;
    const item = {
      user_id: uid, case_id: caseRow ? str(caseRow.id) : '', name: doctorName(p),
      pathway: pathway, pathway_label: PATHWAY_LABEL[pathway] || (pathway ? pathway : 'Not yet known'),
      segment: pathway ? candidatePathway.segmentOf(pathway) : '',
      group: c.group, group_label: GROUP_LABEL[c.group] || c.group, basis: c.basis,
      since: c.since || null, days_in_stage: c.since ? daysFrom(c.since, rowToday) : null,
      practice_name: c.placement ? str(c.placement.practice_name) : (c.application ? str(roleName(c.application)) : ''),
      placement_id: c.placement ? str(c.placement.id) : '', application_id: c.application ? str(c.application.id) : (c.placement ? str(c.placement.application_id || '') : ''),
      start: c.placement ? placementStartLine(c.placement, rowToday) : null,
      guarantee_ends_at: c.placement ? (fees.cleanDay(str(c.placement.guarantee_ends_at)) || null) : null,
      assigned_rso: caseRow ? (caseRow.assigned_rso || null) : null
    };
    groups[c.group].push(item);
  });
  Object.keys(groups).forEach(function (k) {
    groups[k].sort(function (a, b) { return (b.days_in_stage || 0) - (a.days_in_stage || 0) || (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)); });
  });
  const section = function (def) {
    const list = groups[def.key];
    return { key: def.key, label: def.label, count: list.length, doctors: list,
      time_in_stage: durationStats(list.map(function (x) { return x.days_in_stage; })) };
  };
  const columns = PIPELINE_COLUMNS.map(section);
  const before = BEFORE_GROUPS.map(section);
  const closing = CLOSING_GROUPS.map(section);
  const sum = function (list) { return list.reduce(function (n, s) { return n + s.count; }, 0); };
  const counted = doctors.filter(function (p) { const c = classified[str(p.user_id)]; return c && c.group !== GROUP.EXCLUDED; });
  const countedIds = {};
  counted.forEach(function (p) { countedIds[str(p.user_id)] = true; });

  // Per placement (a placement row is one placement cycle).
  const placementRows = arr(i.placements).filter(function (p) { return countedIds[str(p.user_id)] && statusKey(p.status) !== 'cancelled'; });
  const profileBy = {};
  doctors.forEach(function (p) { profileBy[str(p.user_id)] = p; });
  const fromMs = nowMs - windowDays * DAY_MS;
  const windowFromDay = fees.addDays(today, -windowDays);
  const inWindowInstant = function (v) { const t = ms(v); return Number.isFinite(t) && t >= fromMs && t <= nowMs; };
  const inWindowDay = function (d) { const x = fees.cleanDay(str(d)); return !!x && x > windowFromDay && x <= today; };
  const placedAt = function (p) { return p.placed_at || p.created_at; };
  const firstPlacedByUser = {};
  placementRows.forEach(function (p) {
    const t = ms(placedAt(p)); const u = str(p.user_id);
    if (Number.isFinite(t) && (firstPlacedByUser[u] === undefined || t < firstPlacedByUser[u])) firstPlacedByUser[u] = t;
  });
  const appToPlacement = [], signupToPlacement = [], placementToStart = [];
  placementRows.forEach(function (p) {
    const placed = ms(placedAt(p));
    const app = p.application_id != null ? appById[str(p.application_id)] : null;
    if (app && Number.isFinite(placed) && Number.isFinite(ms(app.applied_at)) && placed >= ms(app.applied_at)) appToPlacement.push((placed - ms(app.applied_at)) / DAY_MS);
    const commenced = fees.cleanDay(str(p.commenced_at));
    const placedDay = dayOfInstant(placedAt(p));
    if (commenced && placedDay && commenced >= placedDay) placementToStart.push(fees.daysBetween(placedDay, commenced));
  });
  Object.keys(firstPlacedByUser).forEach(function (u) {
    const signed = ms(profileBy[u] && profileBy[u].created_at);
    if (Number.isFinite(signed) && firstPlacedByUser[u] >= signed) signupToPlacement.push((firstPlacedByUser[u] - signed) / DAY_MS);
  });
  const commencedRows = placementRows.filter(function (p) { return !!fees.cleanDay(str(p.commenced_at)); });
  const latestRow = placementRows.slice().sort(function (a, b) { return (ms(placedAt(b)) || 0) - (ms(placedAt(a)) || 0); })[0] || null;
  const placementItem = function (p) {
    const d = fees.cleanDay(str(dayFor(p))) || today;
    return {
      placement_id: str(p.id), user_id: str(p.user_id), name: doctorName(profileBy[str(p.user_id)]),
      case_id: (arr(casesBy[str(p.user_id)])[0] || {}).id || '',
      practice_name: str(p.practice_name), location: str(p.location), placed_at: placedAt(p) || null,
      start_date: fees.cleanDay(str(p.start_date)) || null, commenced_at: fees.cleanDay(str(p.commenced_at)) || null,
      phase: lifecycle.placementPhase(p, d), start: placementStartLine(p, d)
    };
  };

  const apps = arr(i.applications).filter(function (a) { return countedIds[str(a.user_id)]; });
  const leads = arr(i.leads);
  const activityBetween = function (fromInstant, toInstant) {
    const inI = function (v) { const t = ms(v); return Number.isFinite(t) && t >= fromInstant && t < toInstant; };
    const fromDay = lifecycle.localDay(fromInstant, lifecycle.FALLBACK_ZONE);
    const toDay = lifecycle.localDay(toInstant - 1, lifecycle.FALLBACK_ZONE);
    const inD = function (d) { const x = fees.cleanDay(str(d)); return !!x && x >= fromDay && x <= toDay; };
    return {
      leads: leads.filter(function (l) { return inI(l.created_at); }).length,
      signups: counted.filter(function (p) { return inI(p.created_at); }).length,
      applications: apps.filter(function (a) { return inI(a.applied_at); }).length,
      interviews_booked: interviews.filter(function (r) { const a = appById[str(r.application_id)]; return (!a || countedIds[str(a.user_id)]) && inI(r.booked_at || r.created_at); }).length,
      placements: placementRows.filter(function (p) { return inI(placedAt(p)); }).length,
      commenced: commencedRows.filter(function (p) { return inD(p.commenced_at); }).length,
      ended: placementRows.filter(function (p) { return inD(p.ended_at); }).length
    };
  };

  const awaitingCheck = counted.filter(function (p) {
    const uid = str(p.user_id);
    if (!str(p.pathway || p.candidate_pathway)) return false;
    const c = credBy[uid];
    return !c || !c.ahpra_last_checked_at;
  }).map(function (p) {
    const cs = arr(casesBy[str(p.user_id)])[0] || null;
    return { user_id: str(p.user_id), case_id: cs ? str(cs.id) : '', name: doctorName(p) };
  });

  const segments = { A: 0, B: 0, C: 0, unknown: 0 };
  counted.forEach(function (p) {
    const pw = str(p.pathway || p.candidate_pathway);
    const s = pw ? candidatePathway.segmentOf(pw) : 'unknown';
    segments[segments[s] === undefined ? 'unknown' : s] += 1;
  });

  return {
    today: today, window_days: windowDays,
    total: counted.length,
    totals: { in_pipeline: sum(columns), before: sum(before), closing: sum(closing), held: groups.held.length, excluded: groups.excluded.length },
    columns: columns, before: before, closing: closing,
    held: { key: GROUP.HELD, label: GROUP_LABEL.held, count: groups.held.length, doctors: groups.held },
    segments: segments,
    placements: {
      total: placementRows.length,
      before_start: placementRows.filter(function (p) { return lifecycle.placementPhase(p, fees.cleanDay(str(dayFor(p))) || today) === 'prestart'; }).length,
      window: placementRows.filter(function (p) { return inWindowInstant(placedAt(p)); }).length,
      latest: latestRow ? placementItem(latestRow) : null
    },
    commenced: {
      total: commencedRows.length,
      window: commencedRows.filter(function (p) { return inWindowDay(p.commenced_at); }).length,
      list: commencedRows.slice().sort(function (a, b) { return str(b.commenced_at).localeCompare(str(a.commenced_at)); }).slice(0, 12).map(placementItem)
    },
    timing: {
      signup_to_placement: durationStats(signupToPlacement),
      application_to_placement: durationStats(appToPlacement),
      placement_to_commencement: durationStats(placementToStart)
    },
    activity: activityBetween(fromMs, nowMs + 1),
    activityBetween: activityBetween,
    leads: {
      window: leads.filter(function (l) { return inWindowInstant(l.created_at); }).length,
      total: leads.length
    },
    awaiting_ahpra_check: { count: awaitingCheck.length, doctors: awaitingCheck },
    groupOf: function (userId) { const c = classified[str(userId)]; return c ? c.group : ''; }
  };
}

/** The pipeline as plain data (the two functions on it are for server code). */
function serialisable(pipeline) {
  const out = Object.assign({}, pipeline);
  delete out.activityBetween;
  delete out.groupOf;
  return JSON.parse(JSON.stringify(out));
}

/** Days as the words the owner reads: "9 days", "3 weeks". Never months. */
function daysInWords(days) {
  const n = days === null || days === undefined || days === '' ? NaN : Number(days);
  if (!Number.isFinite(n)) return 'not enough placements yet';
  if (n < 14) { const d = Math.round(n); return d + (d === 1 ? ' day' : ' days'); }
  const w = Math.round((n / 7) * 10) / 10;
  return w + ' weeks';
}

/**
 * One plain sentence for the Overview's Australian section (deterministic, no
 * model call, like the brief above it).
 */
function briefText(pipeline, needsYou) {
  const p = pipeline && typeof pipeline === 'object' ? pipeline : null;
  if (!p) return '';
  const plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); };
  const cols = (p.columns || []).filter(function (c) { return c.count > 0; }).map(function (c) { return c.count + ' ' + c.label.toLowerCase(); });
  const inPipe = (p.totals && p.totals.in_pipeline) || 0;
  const a = p.activity || {};
  const week = [];
  if (a.leads) week.push(plural(a.leads, 'new lead'));
  if (a.signups) week.push(plural(a.signups, 'sign-up'));
  if (a.interviews_booked) week.push(plural(a.interviews_booked, 'interview') + ' booked');
  if (a.placements) week.push(plural(a.placements, 'placement'));
  if (a.commenced) week.push(a.commenced + ' commenced');
  let out = plural(p.total || 0, 'Australian doctor') + ' on the books, ' + inPipe + ' in the pipeline' + (cols.length ? ' (' + cols.join(', ') + ')' : '') + '.';
  out += ' Last ' + (p.window_days || 7) + ' days: ' + (week.length ? week.join(', ') : 'nothing new') + '.';
  const held = (p.held && p.held.count) || 0;
  if (held) out += ' ' + held + ' on hold (not launched).';
  const n = Number(needsYou) || 0;
  out += n ? ' ' + plural(n, 'item needs', 'items need') + ' you.' : ' Nothing is waiting on you.';
  return out;
}

module.exports = {
  briefText,
  COLUMN, GROUP, PIPELINE_COLUMNS, BEFORE_GROUPS, CLOSING_GROUPS, GROUP_LABEL, PATHWAY_LABEL,
  classifyDoctor, buildAuPipeline, serialisable, placementStartLine, daysInWords, durationStats,
  isOpenApplication, isContractApplication, isPlacementSecuredApplication, isTestEmail, doctorName
};

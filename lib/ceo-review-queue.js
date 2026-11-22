'use strict';
// CEO review queue (owner 2026-10-01): "I should always get a popup when
// something needs reviewing with a CTA that takes me to the action". Dr
// Shakeema Salmi's GMC number sat in pending_verification for five days
// because a pending register check was only visible as a chip INSIDE her
// profile. This module turns the raw rows into one list of things waiting on
// the CEO, which drives the popup, the Candidates-tab "!", the profile banner
// and the candidate-row chips — one builder, so all four always agree.
//
// Deliberately NOT included: user_profiles.name_change_detected. It is a
// permanent flag with no resolved state (it drives the doctor's AMC
// name-change evidence prompt and is never cleared) — in prod it is true for
// GPs who were handled long ago, so as a "needs review" item it would nag
// forever.
//
// Pure module — no I/O — so the eligibility rules are unit-testable.
// server.js (loadCeoReviewQueue) does the reads and hands the rows in.

var registerVerification = require('./register-verification.js');
// Australian GP build (WP-27, ADM-24): the Australian review kinds below read
// their rules from the modules that own them. None of these is reached unless
// the caller passes `input.au` (the server does so only with the switch on).
var candidatePathway = require('./candidate-pathway.js');
var auStaffTools = require('./au-staff-tools.js');
var auLifecycle = require('./au-lifecycle.js');
var auFees = require('./au-placement-fees.js');
var auPipeline = require('./au-pipeline.js');
var stalledApplications = require('./stalled-applications.js');

// A pending register number the hourly auto-check has NOT tried yet is given
// this long before it is put in front of the CEO: the cron normally settles
// it (verified, or stamps register_auto_checked_at) well inside that window.
var REGISTER_PENDING_GRACE_MS = 2 * 60 * 60 * 1000;

// The owner's own test logins (and the shared staff inboxes) are never real
// work — same idea as the HIDDEN_CASE_EMAILS lists in server.js, widened to
// every khaleedmahmoud* test account (…1211, …crypto1211, …coinspot1211).
var TEST_EMAIL_FRAGMENTS = ['khaleedmahmoud'];
var TEST_EMAILS_EXACT = ['hazel@mygplink.com.au', 'hello@mygplink.com.au'];
function isTestAccountEmail(email) {
  var e = String(email == null ? '' : email).trim().toLowerCase();
  if (!e) return false;
  if (TEST_EMAILS_EXACT.indexOf(e) !== -1) return true;
  for (var i = 0; i < TEST_EMAIL_FRAGMENTS.length; i++) {
    if (e.indexOf(TEST_EMAIL_FRAGMENTS[i]) !== -1) return true;
  }
  return false;
}

function str(v) { return v == null ? '' : String(v); }
function ms(iso) { var t = Date.parse(str(iso)); return Number.isFinite(t) ? t : NaN; }

function isArchivedProfile(p) {
  if (!p) return false;
  return str(p.account_status) === 'archived' || !!p.archived_at;
}
// Archived accounts and the owner's test accounts never need reviewing.
function isExcludedProfile(p) {
  return !!p && (isArchivedProfile(p) || isTestAccountEmail(p.email));
}

function gpName(p) {
  if (!p) return 'Unknown doctor';
  var name = [str(p.first_name).trim(), str(p.last_name).trim()].filter(Boolean).join(' ').replace(/^Dr\.?\s+/i, '');
  if (name) return 'Dr ' + name;
  return str(p.email) || 'Unknown doctor';
}

function bodyLabel(body) {
  var meta = registerVerification.registerBodyMeta ? registerVerification.registerBodyMeta(body) : null;
  if (meta && meta.label) return meta.label;
  return body ? String(body).toUpperCase() : 'Register';
}

// Earliest of the timestamps given (ISO strings), or ''.
function earliestIso(list) {
  var best = NaN, bestIso = '';
  (list || []).forEach(function (iso) {
    var t = ms(iso);
    if (Number.isFinite(t) && (!Number.isFinite(best) || t < best)) { best = t; bestIso = new Date(t).toISOString(); }
  });
  return bestIso;
}
function latestIso(list) {
  var best = NaN, bestIso = '';
  (list || []).forEach(function (iso) {
    var t = ms(iso);
    if (Number.isFinite(t) && (!Number.isFinite(best) || t > best)) { best = t; bestIso = new Date(t).toISOString(); }
  });
  return bestIso;
}

// Is this pending register number waiting on a PERSON? Yes when the automatic
// check already ran and could not confirm it, or when it has sat unchecked for
// longer than the grace window (the cron missed it).
function registerPendingNeedsReview(p, nowMs) {
  if (!p || str(p.register_status) !== 'pending_verification') return false;
  if (!str(p.register_number).trim()) return false;
  if (p.register_auto_checked_at) return true;
  var t = ms(p.updated_at || p.created_at);
  if (!Number.isFinite(t)) return true; // no timestamp at all — never hide it
  return (nowMs - t) >= REGISTER_PENDING_GRACE_MS;
}

// Pick the case for a user: prefer a non-withdrawn one.
function caseForUser(cases, userId) {
  var best = null;
  (cases || []).forEach(function (c) {
    if (!c || str(c.user_id) !== str(userId)) return;
    if (!best) { best = c; return; }
    if (str(best.status) === 'withdrawn' && str(c.status) !== 'withdrawn') best = c;
  });
  return best;
}

// ── Australian review kinds (WP-27, ADM-24) ─────────────────────────────────
// Each is worked out from facts on file, has ONE key (so it cannot appear
// twice), and leaves the queue by itself when the fact that raised it is
// resolved. None is a permanent flag.
//
//   au_ahpra_flags       a condition, undertaking or notation is on file and
//                        no person has reviewed it        -> the reviewed stamp
//   au_ahpra_recheck     registration expiring (60 days) or the yearly
//                        re-check is due                  -> the check is recorded
//   au_19ab_mismatch     the doctor's own 19AB answer and the staff-confirmed
//                        one disagree                     -> "Mark reviewed", or they agree
//   au_19ab_role         a doctor limited to DPA roles is submitted to, or
//                        placed in, a role not known to be in a DPA
//                                                         -> the application closes, the role
//                                                            is confirmed DPA, or staff confirm
//                                                            19AB does not apply
//   au_prestart_overdue  pre-start items past their due date, one item per
//                        case                             -> the items are done
//   au_held              a segment B or C doctor is on hold with no decision
//                        recorded                         -> the segment review is completed,
//                                                            or the pathway changes
//   au_start_unconfirmed the start date has been reached and nobody has
//                        confirmed the doctor started     -> "Confirm commenced", or a new date
//   au_invoice_overdue   an invoice not sent by its date, or sent and unpaid
//                        past its terms                   -> sent / paid
//   au_credit_decision   the doctor left inside the guarantee period and the
//                        credit could not be worked out   -> the CEO records it
var AU_KINDS = ['au_ahpra_flags', 'au_ahpra_recheck', 'au_19ab_mismatch', 'au_19ab_role', 'au_prestart_overdue',
  'au_held', 'au_start_unconfirmed', 'au_invoice_overdue', 'au_credit_decision'];
var AU_OPEN_TASK_STATUSES = ['open', 'in_progress', 'waiting', 'waiting_on_gp', 'waiting_on_practice', 'waiting_on_external', 'escalated'];
// Lifecycle tasks that are not pre-start items (they have their own kinds).
var AU_NOT_PRESTART_KINDS = ['invoice_due', 'invoice_overdue', 'replacement_or_credit', 'guarantee_checkin', 'week1_checkin',
  'guarantee_ending', 'guarantee_ended', 'part_time_uplift'];

function auMeta(task) {
  var m = task && task.metadata;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { m = null; } }
  return (m && typeof m === 'object') ? m : {};
}
function auRoleKnownDpa(role) {
  if (!role) return false;
  var status = str(role.dpa_status).trim().toLowerCase();
  if (status) return status === 'yes';
  return role.dpa === true;
}
function auAppSubmitted(app) {
  if (!app) return false;
  if (app.submitted_to_practice_at) return true;
  var sub = str(app.practice_submission_status).trim().toLowerCase();
  if (sub && sub !== 'pending_va_submission') return true;
  var stage = str(app.ats_stage).trim().toLowerCase();
  return stage === 'interview' || stage === 'offer' || stage === 'submitted' || stage === 'reviewing';
}

/**
 * buildAuReviewItems(au) -> items[]
 *   au.nowMs, au.today (YYYY-MM-DD), au.dayFor(placementRow)
 *   au.doctors      [{ user_id, pathway, first_name, last_name, email, account_status, archived_at, ... }]
 *   au.cases, au.applications, au.placements, au.credentials
 *   au.tasks        registration_tasks rows on those cases (open and closed)
 *   au.roles        career_roles rows ({ id, dpa, dpa_status, practice_name })
 *   au.mismatchAcks [{ case_id, confirmed_at }]  "19AB mismatch reviewed" marks
 *   au.pipeline     lib/au-pipeline.js buildAuPipeline(...) of the same facts
 */
function buildAuReviewItems(au) {
  au = au && typeof au === 'object' ? au : {};
  var nowMs = Number.isFinite(au.nowMs) ? au.nowMs : Date.now();
  var today = auFees.cleanDay(str(au.today)) || auLifecycle.localDay(nowMs, auLifecycle.FALLBACK_ZONE);
  var dayFor = typeof au.dayFor === 'function' ? au.dayFor : function () { return today; };
  var list = function (v) { return Array.isArray(v) ? v.filter(Boolean) : []; };
  var doctors = list(au.doctors);
  var credBy = {}; list(au.credentials).forEach(function (c) { if (c.user_id) credBy[str(c.user_id)] = c; });
  var casesBy = {}; list(au.cases).forEach(function (c) { var u = str(c.user_id); if (u) (casesBy[u] = casesBy[u] || []).push(c); });
  var appsBy = {}; list(au.applications).forEach(function (a) { var u = str(a.user_id); if (u) (appsBy[u] = appsBy[u] || []).push(a); });
  var placementsBy = {}; list(au.placements).forEach(function (p) { var u = str(p.user_id); if (u) (placementsBy[u] = placementsBy[u] || []).push(p); });
  var tasksByCase = {}; list(au.tasks).forEach(function (t) { var c = str(t.case_id); if (c) (tasksByCase[c] = tasksByCase[c] || []).push(t); });
  var roleBy = {}; list(au.roles).forEach(function (r) { if (r.id != null) roleBy[str(r.id)] = r; });
  var ackBy = {}; list(au.mismatchAcks).forEach(function (a) { if (a.case_id) (ackBy[str(a.case_id)] = ackBy[str(a.case_id)] || []).push(str(a.confirmed_at)); });
  var groupOf = au.pipeline && typeof au.pipeline.groupOf === 'function' ? au.pipeline.groupOf : function () { return ''; };
  var items = [];
  var longDay = function (d) { return auLifecycle.longDay(d); };

  doctors.forEach(function (p) {
    var uid = str(p.user_id);
    if (!uid) return;
    var group = groupOf(uid);
    if (group === 'excluded' || isExcludedProfile(p)) return;
    var pathway = str(p.pathway || p.candidate_pathway);
    var cs = caseForUser(casesBy[uid] || [], uid);
    if (cs && str(cs.status) === 'withdrawn') return;
    var caseId = cs ? str(cs.id) : '';
    var name = gpName(p);
    var cred = credBy[uid] || null;
    var base = function (kind, key, extra) {
      return Object.assign({ key: key, kind: kind, au: true, user_id: uid, case_id: caseId, gp_name: name }, extra);
    };

    // 1. Ahpra conditions / undertakings / notations not yet reviewed.
    if (cred && candidatePathway.hasRegistrationFlags(cred) && !(cred.flags_reviewed_at && str(cred.flags_reviewed_by).trim())) {
      var which = [cred.has_conditions === true ? 'conditions' : '', cred.has_undertakings === true ? 'undertakings' : '', cred.has_notations === true ? 'notations' : ''].filter(Boolean).join(', ');
      items.push(base('au_ahpra_flags', 'au:flags:' + uid, {
        title: 'Ahpra ' + which + ' to review',
        detail: name + ' · the register shows ' + which + ' · nobody has reviewed what it means for placing them',
        since: earliestIso([cred.updated_at]) || '', focus: 'au_pathway'
      }));
    }

    // 2. Registration expiring, or the yearly re-check due.
    if (cred) {
      var due = auStaffTools.ahpraRecheckDue(cred, nowMs, { today: today });
      if (due.due) {
        var expiry = auFees.cleanDay(typeof cred.registration_expiry === 'string' ? cred.registration_expiry.slice(0, 10) : '');
        var expiring = due.reason === 'expiry_soon';
        items.push(base('au_ahpra_recheck', 'au:ahpra_check:' + uid + ':' + due.reason + (expiring && expiry ? ':' + expiry : ''), {
          title: expiring ? (due.daysToExpiry !== null && due.daysToExpiry < 0 ? 'Ahpra registration has expired' : 'Ahpra registration expiring') : 'Yearly Ahpra re-check due',
          detail: name + ' · ' + (expiring
            ? (expiry ? (due.daysToExpiry !== null && due.daysToExpiry < 0 ? 'expired ' : 'expires ') + longDay(expiry) : 'expiry date close') + ' · check the public register and record it'
            : 'last checked ' + due.daysSinceCheck + ' days ago · check the public register and record it'),
          since: earliestIso([cred.ahpra_last_checked_at]) || '', focus: 'au_ahpra'
        }));
      }
    }

    // 3a. The doctor's 19AB answer and the staff-confirmed one disagree.
    var confirmed = cred ? candidatePathway.staffConfirmed19ab(cred) : null;
    var own = cred ? str(cred.moratorium_19ab_status).trim().toLowerCase() : '';
    if (confirmed && (own === 'yes' || own === 'no') && own !== confirmed) {
      var stamp = str(cred.moratorium_19ab_confirmed_at);
      var acked = (ackBy[caseId] || []).indexOf(stamp) !== -1;
      if (!acked) {
        items.push(base('au_19ab_mismatch', 'au:19ab_mismatch:' + uid + ':' + stamp, {
          title: '19AB: the doctor and the staff check disagree',
          detail: name + ' · the doctor says 19AB ' + (own === 'yes' ? 'applies' : 'does not apply') + ', staff confirmed it '
            + (confirmed === 'yes' ? 'applies' : 'does not apply') + ' · '
            + (confirmed === 'no' ? 'they can be shown roles outside a DPA: check the evidence' : 'they only see DPA roles: make sure they know why'),
          since: earliestIso([stamp]) || '', focus: 'au_pathway', can_ack: true, ack_token: stamp
        }));
      }
    }

    // 3b. Limited to DPA roles, but submitted to / placed in a role that is
    // not known to be in a DPA. The restriction is the ONE rule
    // (computeDpaRestricted): staff-confirmed "applies", and anything not
    // known (fail closed).
    if (candidatePathway.isAuPathway(pathway)) {
      var dpa = candidatePathway.computeDpaRestricted({ pathway: pathway, credentials: cred });
      if (dpa.dpaRestricted !== false) {
        var seenRoles = {};
        var why = confirmed === 'yes' ? 'staff confirmed 19AB applies' : '19AB is not confirmed, so it is treated as applying';
        var raise = function (roleId, refKey, where, since) {
          var role = roleBy[str(roleId)];
          if (roleId == null || str(roleId) === '' || !role) return; // role not readable: say nothing rather than guess
          if (auRoleKnownDpa(role) || seenRoles[refKey]) return;
          seenRoles[refKey] = true;
          var unknown = str(role.dpa_status).trim().toLowerCase() === 'unknown' || (!str(role.dpa_status).trim() && role.dpa !== false);
          items.push(base('au_19ab_role', 'au:19ab_role:' + refKey, {
            title: unknown ? '19AB doctor in a role whose DPA status is unknown' : '19AB doctor in a role that is not in a DPA',
            detail: name + ' · ' + why + ' · ' + where + ' ' + (str(role.practice_name) || 'a practice')
              + (unknown ? ' · ask the practice whether the location is a DPA' : ' · this role is recorded as not in a DPA'),
            since: earliestIso([since]) || '', focus: 'au_eligibility'
          }));
        };
        (placementsBy[uid] || []).forEach(function (pl) {
          var phase = auLifecycle.placementPhase(pl, auFees.cleanDay(str(dayFor(pl))) || today);
          if (phase === 'prestart' || phase === 'first_week' || phase === 'settling_in') {
            raise(pl.career_role_id, 'placement:' + str(pl.id), 'placed at', pl.placed_at || pl.created_at);
          }
        });
        var placedApps = {};
        (placementsBy[uid] || []).forEach(function (pl) { if (pl.application_id != null) placedApps[str(pl.application_id)] = true; });
        (appsBy[uid] || []).forEach(function (a) {
          if (placedApps[str(a.id)] || !stalledApplications.isOpen(a) || !auAppSubmitted(a)) return;
          raise(a.career_role_id, 'application:' + str(a.id), 'submitted to', a.submitted_to_practice_at || a.applied_at);
        });
      }
    }

    // 4. Pre-start items past their due date (one item per case).
    if (group === 'prestart' && caseId) {
      var overdue = (tasksByCase[caseId] || []).filter(function (t) {
        if (AU_OPEN_TASK_STATUSES.indexOf(str(t.status)) === -1) return false;
        var m = auMeta(t);
        if (m.au !== true) return false;
        if (AU_NOT_PRESTART_KINDS.indexOf(str(m.lifecycle_kind)) !== -1) return false;
        var dueDay = auFees.cleanDay(str(t.due_date).slice(0, 10));
        return !!dueDay && dueDay < today; // due ON its day, overdue from the day after
      });
      if (overdue.length) {
        var oldest = overdue.map(function (t) { return str(t.due_date).slice(0, 10); }).sort()[0];
        items.push(base('au_prestart_overdue', 'au:prestart_overdue:' + caseId, {
          title: overdue.length === 1 ? '1 pre-start item overdue' : overdue.length + ' pre-start items overdue',
          detail: name + ' · ' + overdue.slice(0, 3).map(function (t) { return str(t.title); }).filter(Boolean).join('; ') + ' · oldest was due ' + longDay(oldest),
          since: earliestIso([oldest + 'T00:00:00Z']) || '', latest: overdue.map(function (t) { return str(t.id); }).sort().join(','),
          count: overdue.length, focus: 'au_tasks'
        }));
      }
    }

    // 5. A held segment B / C doctor with no decision recorded.
    if (group === 'held') {
      var reviews = (tasksByCase[caseId] || []).filter(function (t) { return str(t.task_type) === 'segment_review'; });
      var openReview = reviews.filter(function (t) { return AU_OPEN_TASK_STATUSES.indexOf(str(t.status)) !== -1; })[0] || null;
      if (openReview || !reviews.length) {
        items.push(base('au_held', 'au:held:' + uid, {
          title: 'On hold: decide what to do with this doctor',
          detail: name + ' · ' + (auPipeline.PATHWAY_LABEL[pathway] || pathway) + ' (segment ' + candidatePathway.segmentOf(pathway) + ') is built but not launched · they cannot apply until someone decides',
          since: earliestIso([openReview ? openReview.created_at : (p.pathway_set_at || p.created_at)]) || '', focus: 'au_pathway'
        }));
      }
    }

    // 6 to 8. Per placement.
    (placementsBy[uid] || []).forEach(function (pl) {
      var day = auFees.cleanDay(str(dayFor(pl))) || today;
      var phase = auLifecycle.placementPhase(pl, day);
      var at = str(pl.practice_name) || 'the practice';
      var start = auFees.cleanDay(str(pl.start_date));
      if (phase === 'prestart' && group === 'prestart' && start && start <= day) {
        items.push(base('au_start_unconfirmed', 'au:start:' + str(pl.id) + ':' + start, {
          title: 'Start date reached: confirm the doctor started',
          detail: name + ' · due to start at ' + at + ' on ' + longDay(start) + ' · nobody has confirmed that the doctor started',
          since: earliestIso([start + 'T00:00:00Z']) || '', focus: 'au_commencement'
        }));
      }
      if (phase === 'cancelled') return;
      var s = auLifecycle.commercialState(pl, day);
      if (!s.commenced) return;
      if (s.invoice === 'overdue') {
        items.push(base('au_invoice_overdue', 'au:invoice:' + str(pl.id) + ':unpaid', {
          title: 'Invoice unpaid past its terms',
          detail: name + ' at ' + at + ' · invoice sent ' + longDay(s.invoiceSentAt) + ' and not recorded as paid',
          since: earliestIso([s.invoiceSentAt + 'T00:00:00Z']) || '', focus: 'au_commencement'
        }));
      } else if (s.invoice === 'due' && s.invoiceDueAt && s.invoiceDueAt < day) {
        items.push(base('au_invoice_overdue', 'au:invoice:' + str(pl.id) + ':unsent', {
          title: 'Invoice not sent',
          detail: name + ' at ' + at + ' · started ' + longDay(s.commencedAt) + ' · the invoice was due that day and is not recorded as sent',
          since: earliestIso([s.invoiceDueAt + 'T00:00:00Z']) || '', focus: 'au_commencement'
        }));
      }
      var ended = auFees.cleanDay(str(pl.ended_at));
      var ends = auFees.cleanDay(str(pl.guarantee_ends_at));
      if (ended && ends && ended <= ends && (pl.credit_pct === null || pl.credit_pct === undefined)) {
        items.push(base('au_credit_decision', 'au:credit:' + str(pl.id), {
          title: 'Guarantee credit to decide',
          detail: name + ' left ' + at + ' on ' + longDay(ended) + ', inside the guarantee period · the credit could not be worked out from what is on file',
          since: earliestIso([ended + 'T00:00:00Z']) || '', focus: 'au_commencement'
        }));
      }
    });
  });
  return items;
}

/**
 * buildReviewQueue(input) -> { items, counts }
 *   input.profiles  user_profiles rows (flagged ones + the owners of any case
 *                   with an open document review, for names/archived state)
 *   input.docTasks  open doc_review / flagged_doc registration_tasks rows
 *                   ({ id, case_id, created_at })
 *   input.cases     registration_cases rows ({ id, user_id, status })
 *   input.accountReviews  doctors whose app account is held "under review"
 *                   ({ user_id, since, reason }) — owner 2026-10-12: Dr Naila
 *                   Said's account sat under review (her ID scan flagged an
 *                   expired passport and she asked support) with NO alert
 *                   anywhere, and it silently blocked her from matching.
 *   input.nowMs     clock (tests)
 */
function buildReviewQueue(input) {
  input = input || {};
  var nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  var profiles = Array.isArray(input.profiles) ? input.profiles.filter(Boolean) : [];
  var docTasks = Array.isArray(input.docTasks) ? input.docTasks.filter(Boolean) : [];
  var cases = Array.isArray(input.cases) ? input.cases.filter(Boolean) : [];
  var accountReviews = Array.isArray(input.accountReviews) ? input.accountReviews.filter(Boolean) : [];

  var profByUser = {};
  profiles.forEach(function (p) { if (p.user_id) profByUser[str(p.user_id)] = p; });
  var caseById = {};
  cases.forEach(function (c) { if (c.id) caseById[str(c.id)] = c; });

  var items = [];
  var seenKeys = {};
  function push(item) {
    if (seenKeys[item.key]) return;
    seenKeys[item.key] = true;
    items.push(item);
  }

  profiles.forEach(function (p) {
    var uid = str(p.user_id);
    if (!uid || isExcludedProfile(p)) return;
    var cs = caseForUser(cases, uid);
    var caseId = cs ? str(cs.id) : '';
    var name = gpName(p);
    var status = str(p.register_status);
    var label = bodyLabel(p.register_body);
    var number = str(p.register_number).trim();

    if (status === 'pending_verification' && registerPendingNeedsReview(p, nowMs)) {
      var why = p.register_auto_checked_at
        ? 'the automatic check couldn’t confirm it'
        : 'the automatic check hasn’t been able to run';
      var since = earliestIso([p.register_auto_checked_at, p.updated_at]) || earliestIso([p.created_at]);
      push({
        key: 'register:' + uid + ':pending_verification',
        kind: 'register_pending',
        user_id: uid, case_id: caseId, gp_name: name,
        title: label + ' number needs checking',
        detail: name + ' · ' + label + ' ' + number + ' · ' + why,
        since: since, focus: 'register', register_label: label
      });
    } else if (status === 'mismatch' && number) {
      push({
        key: 'register:' + uid + ':mismatch',
        kind: 'register_mismatch',
        user_id: uid, case_id: caseId, gp_name: name,
        title: 'Register mismatch — follow up',
        detail: name + ' · ' + label + ' ' + number + ' didn’t match the public register',
        since: str(p.register_verified_at) ? earliestIso([p.register_verified_at]) : (earliestIso([p.updated_at]) || ''),
        focus: 'register', register_label: label
      });
    }
  });

  // Accounts held under review (the matching board and the doctor's own app
  // both treat this as a hard hold until a person releases it).
  accountReviews.forEach(function (r) {
    var uid = str(r.user_id);
    if (!uid) return;
    // Declined ("send us a new ID") = waiting on the DOCTOR, not the CEO: it
    // leaves the queue until a replacement is filed (which resets the status).
    if (r.waiting_on_doctor === true) return;
    var p = profByUser[uid] || null;
    if (isExcludedProfile(p)) return;
    var cs = caseForUser(cases, uid);
    var name = gpName(p);
    push({
      key: 'account:' + uid + ':under_review',
      kind: 'account_review',
      user_id: uid, case_id: cs ? str(cs.id) : '', gp_name: name,
      title: 'Account under review',
      detail: name + ' · ' + (str(r.reason).trim() || 'flagged during onboarding') + ' · blocked from matching until released',
      since: earliestIso([r.since]) || '',
      focus: 'account'
    });
  });

  // Documents waiting on a human, one item per case.
  var docsByCase = {};
  docTasks.forEach(function (t) {
    var cid = str(t.case_id);
    if (!cid) return;
    (docsByCase[cid] = docsByCase[cid] || []).push(t);
  });
  Object.keys(docsByCase).forEach(function (cid) {
    var cs = caseById[cid] || null;
    if (cs && str(cs.status) === 'withdrawn') return; // not a candidate any more
    var uid = cs ? str(cs.user_id) : '';
    var p = uid ? profByUser[uid] : null;
    if (isExcludedProfile(p)) return;
    var list = docsByCase[cid];
    var n = list.length;
    var name = gpName(p);
    push({
      key: 'docs:' + cid,
      kind: 'docs',
      user_id: uid, case_id: cid, gp_name: name,
      title: n === 1 ? '1 document to review' : n + ' documents to review',
      detail: name + ' · uploaded and waiting for your review',
      since: earliestIso(list.map(function (t) { return t.created_at; })),
      // A new document for the same doctor changes this, so the popup can
      // tell "new since you last looked" without a new key.
      latest: latestIso(list.map(function (t) { return t.created_at; })),
      count: n,
      focus: 'docs'
    });
  });

  // Australian kinds: only when the caller hands the facts in (switch on).
  var auGiven = !!(input.au && typeof input.au === 'object');
  if (auGiven) buildAuReviewItems(Object.assign({ nowMs: nowMs }, input.au)).forEach(push);

  items.forEach(function (it) {
    it.seen_token = it.key + '@' + ((it.kind === 'docs' || it.kind === 'au_prestart_overdue') ? (it.count + ':' + (it.latest || '')) : (it.since || ''));
  });

  // Newest first; undated items sink to the bottom; key breaks ties so the
  // order is stable between polls.
  items.sort(function (a, b) {
    var ta = ms(a.since), tb = ms(b.since);
    var fa = Number.isFinite(ta), fb = Number.isFinite(tb);
    if (fa && fb && ta !== tb) return tb - ta;
    if (fa !== fb) return fa ? -1 : 1;
    return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
  });

  var counts = { total: items.length, register: 0, register_pending: 0, register_mismatch: 0, docs: 0, documents: 0, account: 0 };
  items.forEach(function (it) {
    if (it.kind === 'register_pending') { counts.register++; counts.register_pending++; }
    else if (it.kind === 'register_mismatch') { counts.register++; counts.register_mismatch++; }
    else if (it.kind === 'docs') { counts.docs++; counts.documents += it.count || 0; }
    else if (it.kind === 'account_review') { counts.account++; }
  });
  // The existing counters above never include an Australian kind. `au` and
  // `au_kinds` exist only when the facts were handed in.
  if (auGiven) {
    counts.au = 0;
    counts.au_kinds = {};
    AU_KINDS.forEach(function (k) { counts.au_kinds[k] = 0; });
    items.forEach(function (it) { if (it.au === true && counts.au_kinds[it.kind] !== undefined) { counts.au++; counts.au_kinds[it.kind]++; } });
  }
  return { items: items, counts: counts };
}

// Per-user flags for the candidates list chips — derived from the SAME items
// so the row chip and the popup can never disagree.
function flagsByUser(items) {
  var out = {};
  (items || []).forEach(function (it) {
    if (!it || !it.user_id) return;
    var f = out[it.user_id] = out[it.user_id] || { register: '', register_label: '', account: '' };
    if (it.kind === 'register_pending') { f.register = 'pending_verification'; f.register_label = it.register_label || ''; }
    else if (it.kind === 'register_mismatch') { f.register = 'mismatch'; f.register_label = it.register_label || ''; }
    else if (it.kind === 'account_review') { f.account = 'under_review'; }
  });
  return out;
}

// Plain-words reason an account is under review, from the onboarding blob the
// flag was raised with (string or object). Only the ID check is read: qualDocs
// in that blob is a STALE onboarding-time copy (flagged documents already have
// their own doc_review tasks, counted separately).
function accountReviewReason(onboarding) {
  var ob = onboarding;
  if (typeof ob === 'string') { try { ob = JSON.parse(ob); } catch (e) { ob = null; } }
  var idv = ob && typeof ob === 'object' ? ob.idVerification : null;
  if (idv && typeof idv === 'object' && str(idv.status) && str(idv.status) !== 'verified' && str(idv.status) !== 'approved') {
    var st = str(idv.status);
    if (st === 'rejected') {
      var why = str(idv.rejectReason).trim();
      return 'New ID requested from the doctor' + (why ? ' (' + why + ')' : '') + ' — waiting on them';
    }
    if (st === 'manual_review' && idv.staffUploadedAt) return 'New ID filed by staff — check it';
    var issue = Array.isArray(idv.issues) && idv.issues.length ? str(idv.issues[0]).trim() : '';
    var asked = st === 'support_requested' ? ' (doctor asked for help)' : '';
    return 'ID check' + asked + (issue ? ': ' + issue : ' needs a look');
  }
  return '';
}

// Has staff already declined the ID and asked the doctor for a new one? Then
// the hold is waiting on the doctor, and must not sit in the CEO's queue.
function accountReviewWaitingOnDoctor(onboarding) {
  var ob = onboarding;
  if (typeof ob === 'string') { try { ob = JSON.parse(ob); } catch (e) { ob = null; } }
  var idv = ob && typeof ob === 'object' ? ob.idVerification : null;
  return !!(idv && typeof idv === 'object' && str(idv.status) === 'rejected');
}

module.exports = {
  accountReviewReason: accountReviewReason,
  accountReviewWaitingOnDoctor: accountReviewWaitingOnDoctor,
  REGISTER_PENDING_GRACE_MS: REGISTER_PENDING_GRACE_MS,
  registerPendingNeedsReview: registerPendingNeedsReview,
  isArchivedProfile: isArchivedProfile,
  isTestAccountEmail: isTestAccountEmail,
  isExcludedProfile: isExcludedProfile,
  gpName: gpName,
  buildReviewQueue: buildReviewQueue,
  buildAuReviewItems: buildAuReviewItems,
  AU_KINDS: AU_KINDS,
  flagsByUser: flagsByUser
};

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

/**
 * buildReviewQueue(input) -> { items, counts }
 *   input.profiles  user_profiles rows (flagged ones + the owners of any case
 *                   with an open document review, for names/archived state)
 *   input.docTasks  open doc_review / flagged_doc registration_tasks rows
 *                   ({ id, case_id, created_at })
 *   input.cases     registration_cases rows ({ id, user_id, status })
 *   input.nowMs     clock (tests)
 */
function buildReviewQueue(input) {
  input = input || {};
  var nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  var profiles = Array.isArray(input.profiles) ? input.profiles.filter(Boolean) : [];
  var docTasks = Array.isArray(input.docTasks) ? input.docTasks.filter(Boolean) : [];
  var cases = Array.isArray(input.cases) ? input.cases.filter(Boolean) : [];

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

  items.forEach(function (it) {
    it.seen_token = it.key + '@' + (it.kind === 'docs' ? (it.count + ':' + (it.latest || '')) : (it.since || ''));
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

  var counts = { total: items.length, register: 0, register_pending: 0, register_mismatch: 0, docs: 0, documents: 0 };
  items.forEach(function (it) {
    if (it.kind === 'register_pending') { counts.register++; counts.register_pending++; }
    else if (it.kind === 'register_mismatch') { counts.register++; counts.register_mismatch++; }
    else if (it.kind === 'docs') { counts.docs++; counts.documents += it.count || 0; }
  });
  return { items: items, counts: counts };
}

// Per-user flags for the candidates list chips — derived from the SAME items
// so the row chip and the popup can never disagree.
function flagsByUser(items) {
  var out = {};
  (items || []).forEach(function (it) {
    if (!it || !it.user_id) return;
    var f = out[it.user_id] = out[it.user_id] || { register: '', register_label: '' };
    if (it.kind === 'register_pending') { f.register = 'pending_verification'; f.register_label = it.register_label || ''; }
    else if (it.kind === 'register_mismatch') { f.register = 'mismatch'; f.register_label = it.register_label || ''; }
  });
  return out;
}

module.exports = {
  REGISTER_PENDING_GRACE_MS: REGISTER_PENDING_GRACE_MS,
  registerPendingNeedsReview: registerPendingNeedsReview,
  isArchivedProfile: isArchivedProfile,
  isTestAccountEmail: isTestAccountEmail,
  isExcludedProfile: isExcludedProfile,
  gpName: gpName,
  buildReviewQueue: buildReviewQueue,
  flagsByUser: flagsByUser
};

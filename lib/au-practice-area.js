'use strict';

/**
 * Australian GP build, WP-30: what is PINNED to a practice about its area
 * (Distribution Priority Area for GPs, Modified Monash level), and how each of
 * its roles follows it. Pure: no I/O, no switch, no clock of its own.
 * Read docs/au-gp/workforce-locator.md and CONVENTIONS "WP-30".
 *
 * WHERE IT IS STORED (existing JSON columns: no new column, no migration)
 *   practices.metadata.au_area          the pinned record (below)
 *   career_roles.source_payload.au_area how a role came by its values
 *   career_roles.dpa / dpa_status / mmm the values themselves: the ONLY thing
 *                                       the rule that decides what a doctor
 *                                       sees reads (lib/role-eligibility.js,
 *                                       not edited by this package)
 *
 * THE PINNED RECORD
 *   { v: 1,
 *     lookup: null | { dpa, indicative_dpa, mmm, mmm_approx, confidence, provider, method,
 *                      year: { dpa, mmm }, point: { lat, lng, source }, checked_at,
 *                      catchment, warnings[], address_key },   the last answer the look-up gave
 *     manual: null | { dpa, mmm, reason, by, at, address_key }, set by a named person
 *     stale_manual: null | { ...manual, dropped_at }             FR-9 (M9-01): a hand-set value that was
 *                      about a DIFFERENT address. It decides nothing; staff are told and set it again
 *                      if it still applies.
 *     last_attempt: null | { at, ok, error, confidence, trigger, by },
 *     moved_unanswered: true      FR-9: the address changed and the new one has no answer yet
 *     disputes: [ { at, note, resolved_at?, resolved_by? } ] }   "This looks wrong" from the practice
 *                      (FR-9, M9-08: open until a named person marks it looked at)
 *
 * THE RULES THAT LIVE HERE AND NOWHERE ELSE
 *   effective()   what the practice's status IS, from the record.
 *   applyLookup() how a new look-up answer changes the record. A failed
 *                 look-up never changes an answer for the same address; a
 *                 value a person set is never replaced, only disagreed with.
 *   roleDecision() whether, and how, one role follows.
 */

const locator = require('./au-workforce-locator');

const KEY = 'au_area';
const DPA_STATES = Object.freeze(['yes', 'no', 'unknown']);
const MAX_DISPUTES = 5;

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
function txt(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 500); }
function yesNo(v) { return v === 'yes' || v === 'no'; }
function dpaState(v) { return DPA_STATES.indexOf(v) === -1 ? 'unknown' : v; }

// ── reading ─────────────────────────────────────────────────────────────────

function readRecord(holder) {
  const r = isObj(holder) && isObj(holder[KEY]) ? holder[KEY] : null;
  return r && r.v === 1 ? r : null;
}
/** The pinned record on a practice row, or null (never checked). */
function practiceArea(practice) { return readRecord(isObj(practice) ? practice.metadata : null); }
/** How a role came by its values, or null (recorded before WP-30). */
function roleArea(role) {
  const sp = isObj(role) && isObj(role.source_payload) ? role.source_payload : null;
  return sp && isObj(sp[KEY]) ? sp[KEY] : null;
}

/** The location a practice is classified on: its own row first, then what its intake said. */
function practiceLocation(practice) {
  const p = isObj(practice) ? practice : {};
  const meta = isObj(p.metadata) ? p.metadata : {};
  const intake = isObj(meta.intake) ? meta.intake : {};
  const area = readRecord(meta);
  return {
    address: txt(p.address || intake.address, 300),
    suburb: txt(p.suburb || intake.suburb, 120),
    state: txt(p.location_state || intake.state, 10),
    postcode: txt(p.postcode || intake.postcode, 10),
    latitude: p.latitude,
    longitude: p.longitude,
    placeId: txt(p.google_place_id, 300),
    pointSource: area && area.point_source === 'staff' ? 'staff' : ''
  };
}

/** A role's own location (a role never stores coordinates). */
function roleLocation(role) {
  const r = isObj(role) ? role : {};
  return { address: txt(r.address, 300), suburb: txt(r.suburb, 120), state: txt(r.location_state, 10), postcode: '' };
}

/**
 * FR-9 (M9-01): are two address keys the same place? The key is
 * street|suburb|state|postcode; a postcode that was merely added or dropped
 * is not a move.
 */
function sameAddressKey(a, b) {
  const pa = txt(a, 400).split('|'); const pb = txt(b, 400).split('|');
  if (pa.slice(0, 3).join('|') !== pb.slice(0, 3).join('|')) return false;
  return !pa[3] || !pb[3] || pa[3] === pb[3];
}

function looseSuburb(v) { return txt(v, 120).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

/**
 * Is this role at its practice's own address ('practice': it follows the
 * practice's pinned record) or somewhere else ('own': it is classified on its
 * own address)? A corporation's row stands for head office, never for a
 * clinic, so its roles are always 'own'.
 */
function roleSite(role, practice) {
  if (!isObj(practice) || practice.org_type === 'corporation') return 'own';
  const rl = roleLocation(role); const pl = practiceLocation(practice);
  const rStreet = locator.streetOf(rl); const pStreet = locator.streetOf(pl);
  const rSub = looseSuburb(rl.suburb); const pSub = looseSuburb(pl.suburb);
  if (rSub && pSub && rSub !== pSub) return 'own';
  if (rStreet && pStreet && rStreet !== pStreet) return 'own';
  if (rStreet && !pStreet) return 'own';
  return 'practice';
}

// ── THE status of a practice ────────────────────────────────────────────────

/**
 * @returns {{ status: 'yes'|'no'|'unknown', mmm: (number|null), mmmApprox: boolean,
 *   setBy: 'staff'|'lookup'|'none', reason: string, checkedAt: (string|null),
 *   disagreement: (null|{ lookup: { dpa, mmm, at }, manual: { dpa, mmm, at, by } }) }}
 */
function effective(record) {
  const out = effectiveCore(record);
  const stale = isObj(record) && isObj(record.stale_manual) ? record.stale_manual : null;
  // FR-9 (M9-01): only present when there is one, so every other answer keeps its shape.
  if (stale) out.staleManual = { dpa: dpaState(stale.dpa), mmm: locator.mmmNumber(stale.mmm), by: stale.by || '', at: stale.at || null, droppedAt: stale.dropped_at || null };
  return out;
}
function effectiveCore(record) {
  const r = isObj(record) ? record : null;
  const lookup = r && isObj(r.lookup) ? r.lookup : null;
  const manual = r && isObj(r.manual) ? r.manual : null;
  const exact = !!lookup && lookup.confidence === 'exact';
  const lookupMmm = lookup ? locator.mmmNumber(lookup.mmm) : null;

  if (manual) {
    const mDpa = dpaState(manual.dpa);
    const mMmm = locator.mmmNumber(manual.mmm);
    let disagreement = null;
    if (exact) {
      const dpaDiffers = yesNo(lookup.dpa) && yesNo(mDpa) && lookup.dpa !== mDpa;
      const mmmDiffers = lookupMmm != null && mMmm != null && lookupMmm !== mMmm;
      if (dpaDiffers || mmmDiffers) {
        disagreement = {
          lookup: { dpa: dpaState(lookup.dpa), mmm: lookupMmm, at: lookup.checked_at || null },
          manual: { dpa: mDpa, mmm: mMmm, at: manual.at || null, by: manual.by || '' }
        };
      }
    }
    return {
      status: mDpa, mmm: mMmm != null ? mMmm : (exact ? lookupMmm : null), mmmApprox: false,
      setBy: 'staff', reason: 'set_by_staff', checkedAt: manual.at || null, disagreement: disagreement
    };
  }
  if (lookup && exact) {
    const d = dpaState(lookup.dpa);
    return { status: d, mmm: lookupMmm, mmmApprox: false, setBy: 'lookup', reason: d === 'unknown' ? 'source_gave_no_dpa' : 'lookup_exact', checkedAt: lookup.checked_at || null, disagreement: null };
  }
  if (lookup) {
    // Approximate: the suburb was found, the building was not. Never yes or no.
    return { status: 'unknown', mmm: lookupMmm, mmmApprox: lookupMmm != null, setBy: 'lookup', reason: 'address_not_precise', checkedAt: lookup.checked_at || null, disagreement: null };
  }
  return { status: 'unknown', mmm: null, mmmApprox: false, setBy: 'none', reason: r && r.last_attempt ? 'lookup_failed' : 'never_checked', checkedAt: null, disagreement: null };
}

function blankRecord() { return { v: 1, lookup: null, manual: null, last_attempt: null, disputes: [] }; }

function lookupFromResult(result, addressKey) {
  const r = result || {};
  return {
    dpa: dpaState(r.dpaGp),
    indicative_dpa: r.indicative && DPA_STATES.indexOf(r.indicative.dpaGp) !== -1 ? r.indicative.dpaGp : null,
    mmm: locator.mmmNumber(r.mmm),
    mmm_approx: r.mmmApproximate === true,
    confidence: r.confidence === 'exact' ? 'exact' : 'approximate',
    provider: txt(r.provider, 30),
    method: txt(r.method, 40),
    year: { dpa: r.classificationYear && r.classificationYear.dpa != null ? txt(r.classificationYear.dpa, 24) : null, mmm: r.classificationYear && Number.isFinite(Number(r.classificationYear.mmm)) && r.classificationYear.mmm != null ? Number(r.classificationYear.mmm) : null },
    point: isObj(r.pointUsed) ? { lat: r.pointUsed.lat, lng: r.pointUsed.lng, source: txt(r.pointUsed.source, 40) } : null,
    checked_at: txt(r.checkedAt, 40),
    catchment: txt((r.catchment || (r.indicative && r.indicative.catchment)) || '', 120),
    warnings: Array.isArray(r.warnings) ? r.warnings.slice(0, 8).map(function (w) { return txt(w, 60); }) : [],
    address_key: txt(addressKey, 400)
  };
}

/**
 * A new look-up answer arrives.
 *
 * @param {object|null} record   the pinned record (null: never checked)
 * @param {object} result        classifyLocation's answer
 * @param {{ addressKey: string, trigger: string, by: string, now: string }} ctx
 * @returns {{ record: object, outcome: 'changed'|'unchanged'|'not_confident'|'disagreed'|'failed',
 *   before: object, after: object, addressChanged: boolean }}
 */
function applyLookup(record, result, ctx) {
  const c = ctx || {};
  const prev = readRecord({ [KEY]: record }) ? clone(record) : blankRecord();
  if (!Array.isArray(prev.disputes)) prev.disputes = [];
  const before = effective(prev);
  const next = clone(prev);
  const res = result || { ok: false, error: 'no_result', confidence: 'none' };
  const key = txt(c.addressKey, 400);
  const hadLookup = isObj(prev.lookup);
  const addressChanged = hadLookup && prev.lookup.address_key !== key;

  // FR-9 (M9-01): a value a person set by hand is about the address it was set
  // for. When the address being checked is a different one, that value does
  // not carry over: it is put aside (kept, attributed, shown to staff) and
  // the answer for the NEW address is whatever the look-up supports, which is
  // "not confirmed" unless the look-up is exact. A person sets it again if it
  // still applies. (Same address: a hand-set value is never replaced.)
  let manualDropped = false;
  if (isObj(prev.manual) && txt(prev.manual.address_key, 400) && key && !sameAddressKey(prev.manual.address_key, key)) {
    next.stale_manual = Object.assign({}, prev.manual, { dropped_at: txt(c.now, 40) });
    next.manual = null;
    manualDropped = true;
  }

  next.last_attempt = {
    at: txt(c.now, 40), ok: res.ok === true, error: res.ok === true ? null : txt(res.error || 'failed', 60),
    confidence: res.ok === true ? (res.confidence === 'exact' ? 'exact' : 'approximate') : 'none',
    trigger: txt(c.trigger, 40), by: txt(c.by, 200)
  };

  if (res.ok !== true) {
    // A failed look-up leaves the answer for THIS address untouched. An answer
    // about a DIFFERENT address is not an answer about this one: it is dropped
    // (unknown, the closed answer) rather than carried over to the new place.
    if (addressChanged) next.lookup = null;
  } else if (res.confidence !== 'exact') {
    // A weaker answer for the same address never replaces a stronger one.
    if (!(hadLookup && !addressChanged && prev.lookup.confidence === 'exact')) next.lookup = lookupFromResult(res, key);
  } else {
    next.lookup = lookupFromResult(res, key);
  }

  // FR-9 (M9-01): the address changed and there is NO answer for the new one.
  // That is not "never checked": the roles at this address have just lost the
  // label they had. Remembered so staff are told "not confirmed" (with what it
  // hides), and cleared as soon as there is an answer.
  if (!isObj(next.lookup) && !isObj(next.manual)) {
    if (addressChanged || manualDropped) next.moved_unanswered = true;
  } else {
    delete next.moved_unanswered;
  }

  const after = effective(next);
  let outcome;
  if (res.ok !== true) outcome = 'failed';
  else if (after.disagreement) outcome = 'disagreed';
  else if (res.confidence !== 'exact' || (after.setBy === 'lookup' && after.status === 'unknown')) outcome = 'not_confident';
  else outcome = (before.status !== after.status || before.mmm !== after.mmm || before.mmmApprox !== after.mmmApprox || before.setBy !== after.setBy) ? 'changed' : 'unchanged';
  return { record: next, outcome: outcome, before: before, after: after, addressChanged: addressChanged || manualDropped, manualDropped: manualDropped };
}

/**
 * A named person sets the value by hand, with a reason.
 * @returns {{ ok: true, record: object, before: object, after: object } | { ok: false, error: string }}
 */
function applyManual(record, input) {
  const i = input || {};
  const dpa = String(i.dpa == null ? '' : i.dpa).trim().toLowerCase();
  if (DPA_STATES.indexOf(dpa) === -1) return { ok: false, error: 'Choose yes, no or not confirmed for the Distribution Priority Area.' };
  let mmm = null;
  if (!(i.mmm === null || i.mmm === undefined || i.mmm === '')) {
    mmm = locator.mmmNumber(i.mmm);
    if (mmm == null) return { ok: false, error: 'The Modified Monash level must be a number from 1 to 7, or left blank.' };
  }
  const reason = txt(i.reason, 500);
  if (reason.length < 5) return { ok: false, error: 'Please say why you are setting this by hand (a few words is enough).' };
  const by = txt(i.by, 200);
  if (!by) return { ok: false, error: 'A named staff member is needed to set this by hand.' };
  const prev = readRecord({ [KEY]: record }) ? clone(record) : blankRecord();
  const before = effective(prev);
  const next = clone(prev);
  next.manual = { dpa: dpa, mmm: mmm, reason: reason, by: by, at: txt(i.now, 40), address_key: txt(i.addressKey, 400) };
  delete next.stale_manual;   // a person has decided for this address
  delete next.moved_unanswered;
  return { ok: true, record: next, before: before, after: effective(next) };
}

/** Removes the hand-set value: the look-up's answer (if any) applies again. */
function clearManual(record) {
  const prev = readRecord({ [KEY]: record }) ? clone(record) : blankRecord();
  const before = effective(prev);
  const next = clone(prev);
  next.manual = null;
  delete next.stale_manual;
  return { record: next, before: before, after: effective(next) };
}

/** FR-9 (M9-08): the practice's "This looks wrong" notes nobody has marked as looked at. */
function openDisputes(record) {
  const list = isObj(record) && Array.isArray(record.disputes) ? record.disputes : [];
  return list.filter(function (d) { return isObj(d) && !d.resolved_at; });
}
/** FR-9 (M9-08): a named person has looked at the practice's notes. Changes no value. */
function resolveDisputes(record, by, nowIso) {
  const prev = readRecord({ [KEY]: record }) ? clone(record) : blankRecord();
  const list = Array.isArray(prev.disputes) ? prev.disputes : [];
  let n = 0;
  prev.disputes = list.map(function (d) {
    if (!isObj(d) || d.resolved_at) return d;
    n++;
    return Object.assign({}, d, { resolved_at: txt(nowIso, 40), resolved_by: txt(by, 200) });
  });
  return { record: prev, resolved: n };
}

/** The practice said "This looks wrong". Recorded for staff; changes no value. */
function addDispute(record, note, nowIso) {
  const prev = readRecord({ [KEY]: record }) ? clone(record) : blankRecord();
  const list = Array.isArray(prev.disputes) ? prev.disputes : [];
  list.push({ at: txt(nowIso, 40), note: txt(note, 500) });
  prev.disputes = list.slice(-MAX_DISPUTES);
  return prev;
}

// ── roles ───────────────────────────────────────────────────────────────────

function roleCurrent(role) {
  const r = isObj(role) ? role : {};
  const recorded = DPA_STATES.indexOf(r.dpa_status) !== -1;
  return {
    status: recorded ? r.dpa_status : (r.dpa === true ? 'yes' : 'no'),
    statusRecorded: recorded,
    dpa: r.dpa === true,
    mmm: locator.mmmNumber(r.mmm)
  };
}

/**
 * What to do to ONE role, given the status it should follow.
 *
 * @param {object} role    the career_roles row (dpa, dpa_status, mmm, source_payload)
 * @param {{ status, mmm, mmmApprox, setBy, checkedAt }} target  effective() of the practice record (or of the role's own look-up)
 * @param {{ source: 'practice'|'own', now: string, addressKey?: string, addressChanged?: boolean }} ctx
 *   addressKey      the address this decision is ABOUT (the practice's, or the role's own)
 *   addressChanged  the caller knows that address has just changed (a staff correction, a
 *                   practice re-submitting its form, the job editor). The role also notices
 *                   by itself when the address it was last decided for (area.address_key)
 *                   differs from addressKey.
 * @returns {{ action: 'applied'|'in_step'|'manual_kept'|'legacy_kept'|'disagreement'|'nothing_known',
 *   patch: (null|{ dpa?, dpa_status?, mmm? }), area: object, moved: boolean }}
 *   `area` is the role's new source_payload.au_area (always returned; write it when it differs).
 *
 *   manual_kept   a person set this role by hand FOR THIS ADDRESS: nothing changes; a differing answer is noted.
 *   legacy_kept   the role's values were recorded before this check existed and the
 *                 check is not confident: a recorded value is never degraded by a guess.
 *   disagreement  recorded before this check existed and the check DIFFERS: not applied;
 *                 staff choose. (A role that already follows is simply updated.)
 *
 * FR-9 (M9-01). A LABEL IS ABOUT AN ADDRESS. When the address changes, whatever
 * the role said before (from the look-up, typed before this check existed, or
 * set by hand for the old address) is not an answer about the new place:
 *   new address answered exactly      the role takes that answer
 *   anything else (approximate, the   the role becomes "not confirmed" (the closed
 *   look-up failed, nothing known)    answer) and its old Modified Monash level is removed
 * A value set by hand before the move is not kept silently: it is put aside
 * and, when the role no longer says what the person set, staff are shown a
 * disagreement ("the address changed after ... set this by hand"). A value a
 * person sets by hand AFTER the move (its address_key is the new address) is
 * kept as always.
 */
function roleDecision(role, target, ctx) {
  const c = ctx || {};
  const t = target || { status: 'unknown', mmm: null, mmmApprox: false, setBy: 'none' };
  const prevArea = roleArea(role) || {};
  const area = clone(prevArea) || {};
  const cur = roleCurrent(role);
  const targetStatus = dpaState(t.status);
  const targetMmm = t.mmmApprox ? null : locator.mmmNumber(t.mmm);
  const key = txt(c.addressKey, 400);
  const stamped = txt(prevArea.address_key, 400);
  const moved = c.addressChanged === true || (!!key && !!stamped && !sameAddressKey(stamped, key));
  area.site = c.source === 'own' ? 'own' : 'practice';
  // The address this decision is about: the next check can tell by itself
  // whether the address has changed since.
  if (key) area.address_key = key;
  // No "last checked" time is kept on the role: an unchanged answer must write
  // nothing to a role (running the check again is safe), and the date staff
  // are shown comes from the record the role follows.
  delete area.last_checked_at;
  delete area.checked_at;

  let staleManual = null;
  if (isObj(area.manual)) {
    const m = area.manual;
    const manualKey = txt(m.address_key, 400);
    const forThisAddress = !moved || (!!manualKey && !!key && sameAddressKey(manualKey, key));
    if (forThisAddress) {
      const differs = (yesNo(targetStatus) && yesNo(m.dpa) && targetStatus !== m.dpa)
        || (targetMmm != null && locator.mmmNumber(m.mmm) != null && targetMmm !== locator.mmmNumber(m.mmm));
      area.disagreement = differs && t.setBy !== 'none'
        ? { lookup: { dpa: targetStatus, mmm: targetMmm, at: t.checkedAt || null, set_by: t.setBy }, recorded: { dpa: dpaState(m.dpa), mmm: locator.mmmNumber(m.mmm) }, kind: 'manual', at: txt(c.now, 40) }
        : null;
      return { action: 'manual_kept', patch: null, area: area, moved: moved };
    }
    staleManual = m;
    area.manual = null;
  }

  if (!moved) {
    // A role that FOLLOWED an answer (it carries the status it took) and whose
    // record now has no answer at all has lost the thing it was following.
    const lostItsAnswer = t.setBy === 'none' && area.follows === true && yesNo(area.status);
    if (t.setBy === 'none' && !lostItsAnswer) return { action: 'nothing_known', patch: null, area: area, moved: false };
    if (!lostItsAnswer && area.follows !== true) {
      if (targetStatus === 'unknown' && t.setBy !== 'staff') {
        area.disagreement = null;
        return { action: 'legacy_kept', patch: null, area: area, moved: false };
      }
      const dpaDiffers = yesNo(targetStatus) && yesNo(cur.status) && targetStatus !== cur.status;
      const mmmDiffers = targetMmm != null && cur.mmm != null && targetMmm !== cur.mmm;
      if ((dpaDiffers || mmmDiffers) && t.setBy !== 'staff') {
        area.disagreement = {
          lookup: { dpa: targetStatus, mmm: targetMmm, at: t.checkedAt || null, set_by: t.setBy },
          recorded: { dpa: cur.status, mmm: cur.mmm }, kind: 'recorded_before', at: txt(c.now, 40)
        };
        return { action: 'disagreement', patch: null, area: area, moved: false };
      }
    }
  }

  // From here the role takes the target. After a move (or a lost answer) a
  // target that knows nothing is "not confirmed", never the old label.
  const applyStatus = t.setBy === 'none' ? 'unknown' : targetStatus;
  const applyMmm = t.setBy === 'none' ? null : targetMmm;
  const dropOldMmm = (moved || t.setBy === 'none') && applyMmm == null && cur.mmm != null;
  const patch = {};
  if (cur.status !== applyStatus || !cur.statusRecorded || cur.dpa !== (applyStatus === 'yes')) {
    patch.dpa_status = applyStatus;
    // The boolean is all the overseas rule reads: only "yes" is a DPA role.
    patch.dpa = applyStatus === 'yes';
  }
  if (applyMmm != null && applyMmm !== cur.mmm) patch.mmm = locator.mmmCode(applyMmm);
  // The old level described the old address. Cleared to '' (not null): the
  // real career_roles.mmm column is `text not null default ''`.
  else if (dropOldMmm) patch.mmm = '';
  area.follows = true;
  area.disagreement = null;
  area.status = applyStatus;
  area.mmm = applyMmm;
  area.set_by = t.setBy;
  if (staleManual) {
    const sDpa = dpaState(staleManual.dpa); const sMmm = locator.mmmNumber(staleManual.mmm);
    // Never silent: when the role no longer says what the person set, staff see it.
    if (sDpa !== applyStatus || (sMmm != null && sMmm !== applyMmm)) {
      area.disagreement = {
        lookup: { dpa: applyStatus, mmm: applyMmm, at: t.checkedAt || null, set_by: t.setBy },
        recorded: { dpa: sDpa, mmm: sMmm, by: txt(staleManual.by, 200), at: staleManual.at || null },
        kind: 'address_changed', at: txt(c.now, 40)
      };
    }
  }
  return { action: Object.keys(patch).length ? 'applied' : 'in_step', patch: Object.keys(patch).length ? patch : null, area: area, moved: moved };
}

const MANUAL_REASON_NEEDED = 'Please say why you are setting this by hand (a few words is enough).';
/** FR-9 (M9-07): a hand-set value on a role needs a reason, as it does on a practice. */
function manualReasonError(reason) { return txt(reason, 500).length < 5 ? MANUAL_REASON_NEEDED : ''; }

/** Staff set a role's own value in the job editor. null dpa: back to following. */
function roleManual(role, input) {
  const i = input || {};
  const area = clone(roleArea(role)) || {};
  if (i.dpa === null || i.dpa === undefined || i.dpa === '') {
    // FR-9 (M9-07): "Not recorded" hands the role BACK to the check: it follows
    // from now on (it used to be left as "recorded before", so the check would
    // not apply its answer).
    area.manual = null; area.follows = true; area.disagreement = null;
    delete area.status; delete area.mmm; delete area.set_by;
    return area;
  }
  area.manual = { dpa: dpaState(i.dpa), mmm: locator.mmmNumber(i.mmm), reason: txt(i.reason, 500), by: txt(i.by, 200), at: txt(i.now, 40) };
  // FR-9 (M9-01): the address this value was set for (a later address change retires it).
  if (txt(i.addressKey, 400)) { area.manual.address_key = txt(i.addressKey, 400); area.address_key = txt(i.addressKey, 400); }
  area.follows = false;
  area.disagreement = null;
  return area;
}

/** The role's own look-up record (a role at a different address from its practice). */
function roleOwnRecord(role) {
  const a = roleArea(role);
  return a && isObj(a.own) && a.own.v === 1 ? a.own : null;
}

// ── what the practice's intake answers become ───────────────────────────────

/** The intake fields the server derives from the status (never from the browser). */
function intakeFieldsFor(eff) {
  const e = eff || { status: 'unknown', mmm: null, mmmApprox: false };
  const status = dpaState(e.status);
  return {
    dpa: status === 'yes',
    dpa_answer: status === 'yes' ? 'yes' : (status === 'no' ? 'no' : 'unsure'),
    dpa_suggested: status === 'yes' ? true : (status === 'no' ? false : null),
    mmm: e.mmmApprox ? '' : locator.mmmCode(e.mmm)
  };
}

// ── words ───────────────────────────────────────────────────────────────────

const STATUS_LABELS = Object.freeze({ yes: 'In a DPA', no: 'Not in a DPA', unknown: 'DPA not confirmed' });
// FR-9 (M9-06): the whole truth. A role whose priority-area status is not
// confirmed is closed to EVERY doctor who may only work in a priority area.
// That is every doctor moving to Australia from overseas as well as the
// Australian doctors with a location limit. (Who is hidden is unchanged; only
// the words are.)
const UNKNOWN_CONSEQUENCE = 'Not confirmed: hidden from every doctor who may only work in a priority area (that includes doctors moving to Australia from overseas) until it is confirmed';
// What the PRACTICE is told on its form when its address could not be matched.
const PRACTICE_UNKNOWN_NOTE = 'We could not match your exact address automatically, so our team will check it and confirm with you. Until they have, your role is not shown to doctors who may only work in a priority area (that includes doctors moving to Australia from overseas). Other doctors can still see it.';
const NOT_CHECKED_LABEL = 'Area not checked yet';

const WARNING_WORDS = Object.freeze({
  address_not_precise: 'Only the suburb or street could be found, not the building, so the priority-area answer is not confirmed. Check the street address, or set it by hand.',
  point_address_mismatch: 'The map point on file did not match the written address, so it was not used.',
  point_not_corroborated: 'The map point that came with the address could not be confirmed against the written address, so it was not used. The written address was looked up instead.',
  geocoder_unavailable: 'The address look-up did not answer.',
  address_not_located: 'The address could not be found.',
  no_classification_at_point: 'The Health Workforce Locator has no answer for that point.',
  dpa_not_returned: 'The Health Workforce Locator gave no priority-area answer for that point.',
  rate_limited: 'Too many checks were run in a short time. Try again in a minute.',
  timeout: 'The Health Workforce Locator took too long to answer.',
  locator_unavailable: 'The Health Workforce Locator did not answer.',
  locator_bad_response: 'The Health Workforce Locator gave an answer that could not be read.',
  provider_off: 'The automatic check is switched off.',
  no_address: 'There is no address on file to check.'
});
function warningWords(code) { return WARNING_WORDS[code] || ''; }

const METHOD_WORDS = Object.freeze({
  selected_address: 'the point of the address selected from the list',
  geocoded_address: 'the street address, found to the building',
  street_centroid: 'the street (the building was not found)',
  suburb_centroid: 'the centre of the suburb'
});
const PROVIDER_WORDS = Object.freeze({ health_gov: 'Health Workforce Locator (Department of Health)', fixture: 'Test data (not the real locator)', none: 'Switched off' });

function mmmLabel(mmm, approx) {
  const words = locator.mmmWords(mmm);
  if (!words) return '';
  return approx ? 'approximately ' + words : words;
}

/** The read-only line a practice sees on the intake page. */
function practiceFinding(eff) {
  const e = eff || { status: 'unknown', mmm: null };
  const n = locator.mmmNumber(e.mmm);
  if (e.status === 'yes') return { state: 'yes', line: 'Your practice is in a Distribution Priority Area for GPs' + (n && !e.mmmApprox ? ' · Modified Monash ' + n : '') };
  if (e.status === 'no') return { state: 'no', line: 'Your practice is not in a Distribution Priority Area for GPs' + (n && !e.mmmApprox ? ' · Modified Monash ' + n : '') };
  return { state: 'unknown', line: 'We\'ll confirm your area with you' };
}

function disagreementWords(d) {
  if (!d) return '';
  const say = function (v) { return v === 'yes' ? 'in a DPA' : (v === 'no' ? 'not in a DPA' : 'not confirmed'); };
  const parts = [];
  if (d.manual) {
    if (d.lookup.dpa !== d.manual.dpa && yesNo(d.lookup.dpa) && yesNo(d.manual.dpa)) parts.push('The automatic check says ' + say(d.lookup.dpa) + '; the value set by hand says ' + say(d.manual.dpa) + '.');
    if (d.lookup.mmm != null && d.manual.mmm != null && d.lookup.mmm !== d.manual.mmm) parts.push('The automatic check says MM ' + d.lookup.mmm + '; the value set by hand says MM ' + d.manual.mmm + '.');
  } else if (d.recorded && d.kind === 'address_changed') {
    // FR-9 (M9-01)
    const now = d.lookup.set_by === 'none' || !yesNo(d.lookup.dpa) ? 'not confirmed for the new address' : say(d.lookup.dpa) + ' at the new address';
    parts.push('The address changed after ' + (d.recorded.by || 'a staff member') + ' set this role by hand to ' + say(d.recorded.dpa) + (d.recorded.mmm != null ? ', MM ' + d.recorded.mmm : '') + '. That value was for the old address, so it was not kept: the role is now ' + now + '. Set it by hand again if it still applies.');
  } else if (d.recorded) {
    const who = d.kind === 'manual' ? 'the value set by hand on this role' : 'the value already recorded on this role';
    if (d.lookup.dpa !== d.recorded.dpa && yesNo(d.lookup.dpa) && yesNo(d.recorded.dpa)) parts.push((d.lookup.set_by === 'staff' ? 'The practice record says ' : 'The automatic check says ') + say(d.lookup.dpa) + '; ' + who + ' says ' + say(d.recorded.dpa) + '.');
    if (d.lookup.mmm != null && d.recorded.mmm != null && d.lookup.mmm !== d.recorded.mmm) parts.push((d.lookup.set_by === 'staff' ? 'The practice record says MM ' : 'The automatic check says MM ') + d.lookup.mmm + '; ' + who + ' says MM ' + d.recorded.mmm + '.');
  }
  return parts.join(' ');
}

/**
 * FR-9 (M9-06, M9-08): what about this practice's area is waiting for a
 * person. This is the practice's "to do": it is worked out from the record
 * every time (so it cannot go stale) and it clears itself when the thing is
 * settled. `roleCount`: how many roles the practice has (a "not confirmed"
 * practice with no role hides nothing, so it is not on the list).
 * @returns {Array<{ code: 'practice_query'|'not_confirmed'|'two_answers'|'hand_value_put_aside', message: string }>}
 */
function needsPerson(practice, roleCount) {
  const record = practiceArea(practice);
  if (!record) return [];
  const eff = effective(record);
  const out = [];
  const open = openDisputes(record);
  if (open.length) {
    const last = open[open.length - 1];
    out.push({ code: 'practice_query', message: 'The practice told us its area looks wrong' + (open.length > 1 ? ' (' + open.length + ' notes)' : '') + ': "' + txt(last.note, 500) + '" Check it, then press "Mark as looked at".' });
  }
  if (eff.disagreement) out.push({ code: 'two_answers', message: 'The automatic check and the value set by hand disagree. Choose which one stands.' });
  if (eff.staleManual) out.push({ code: 'hand_value_put_aside', message: 'The address changed after a value was set by hand, so that value is no longer used. Set it again if it still applies.' });
  const n = Number(roleCount) || 0;
  const attempted = isObj(record.lookup) || isObj(record.manual) || isObj(record.last_attempt);
  if (eff.status === 'unknown' && attempted && n > 0) {
    out.push({ code: 'not_confirmed', message: 'Priority-area status not confirmed: ' + (n === 1 ? 'its role is' : 'its ' + n + ' roles are') + ' hidden from every doctor who may only work in a priority area (that includes doctors moving to Australia from overseas). Check the address and press Re-check, or set it by hand.' });
  }
  return out;
}

/** Everything the staff practice screen shows. `legacyDpa` is practices.dpa (what was recorded before). */
function staffView(practice, opts) {
  const record = practiceArea(practice);
  const eff = effective(record);
  const lookup = record && isObj(record.lookup) ? record.lookup : null;
  const manual = record && isObj(record.manual) ? record.manual : null;
  const last = record && isObj(record.last_attempt) ? record.last_attempt : null;
  const loc = practiceLocation(practice);
  const p = isObj(practice) ? practice : {};
  const addressNow = locator.addressKey(loc);
  const addressText = [loc.address, loc.address && loc.address.toLowerCase().indexOf(loc.suburb.toLowerCase()) !== -1 ? '' : loc.suburb, loc.state && loc.address.indexOf(loc.state) === -1 ? loc.state : '', loc.postcode && loc.address.indexOf(loc.postcode) === -1 ? loc.postcode : ''].filter(Boolean).join(', ');
  const warnings = [];
  ((lookup && lookup.warnings) || []).forEach(function (w) { const s = warningWords(w); if (s && warnings.indexOf(s) === -1) warnings.push(s); });
  if (last && last.ok === false) { const s = warningWords(last.error) || 'The last check failed.'; warnings.push('Last check failed: ' + s + (lookup ? ' The earlier answer was kept.' : '')); }
  if (manual && manual.address_key && manual.address_key !== addressNow) warnings.push('The address has changed since this was set by hand. Check it still applies.');
  // FR-9 (M9-01)
  if (eff.staleManual) warnings.push('The address changed after ' + (eff.staleManual.by || 'a staff member') + ' set this by hand (' + STATUS_LABELS[eff.staleManual.dpa] + (eff.staleManual.mmm != null ? ', MM ' + eff.staleManual.mmm : '') + '). That value was for the old address, so it is no longer used. Set it by hand again if it still applies.');
  if (lookup && lookup.address_key !== addressNow && !manual) warnings.push('The address has changed since the last check. Run Re-check.');
  return {
    // "Checked" means there is an answer on file: one from the look-up or one
    // set by hand. A practice that has never been checked, or whose only
    // check so far failed, is not "not confirmed": nothing is known yet, and
    // its roles still carry whatever was recorded on them before. The
    // consequence line is only true once there is an answer to follow.
    checked: !!(lookup || manual),
    // FR-9 (M9-01): the address changed and the new one has no answer. Not
    // "never checked": its roles have been closed to "not confirmed".
    movedUnanswered: !(lookup || manual) && !!(record && record.moved_unanswered === true),
    status: eff.status,
    label: (lookup || manual || (record && record.moved_unanswered === true)) ? STATUS_LABELS[eff.status] : NOT_CHECKED_LABEL,
    consequence: (lookup || manual || (record && record.moved_unanswered === true)) && eff.status === 'unknown' ? UNKNOWN_CONSEQUENCE : '',
    mmm: eff.mmm, mmmApprox: eff.mmmApprox, mmmLabel: mmmLabel(eff.mmm, eff.mmmApprox),
    setBy: eff.setBy,
    setByLabel: eff.setBy === 'staff' ? 'Set by hand by ' + (manual.by || 'staff') : (eff.setBy === 'lookup' ? 'Automatic check' : 'Not checked yet'),
    reason: eff.reason,
    confidence: lookup ? lookup.confidence : 'none',
    confidenceLabel: lookup ? (lookup.confidence === 'exact' ? 'Exact (street address)' : 'Approximate (not the exact building)') : 'No answer yet',
    source: lookup ? (PROVIDER_WORDS[lookup.provider] || lookup.provider) : '',
    method: lookup ? (METHOD_WORDS[lookup.method] || lookup.method) : '',
    year: lookup ? lookup.year : { dpa: null, mmm: null },
    checkedAt: lookup ? lookup.checked_at : null,
    catchment: lookup ? lookup.catchment : '',
    indicativeDpa: lookup && lookup.confidence !== 'exact' ? lookup.indicative_dpa : null,
    point: lookup ? lookup.point : null,
    address: addressText,
    hasAddress: !!(loc.address || loc.suburb),
    lookup: lookup ? { dpa: lookup.dpa, mmm: lookup.mmm, confidence: lookup.confidence, at: lookup.checked_at } : null,
    manual: manual ? { dpa: manual.dpa, mmm: manual.mmm, reason: manual.reason, by: manual.by, at: manual.at } : null,
    staleManual: eff.staleManual || null,
    disagreement: eff.disagreement ? Object.assign({ message: disagreementWords(eff.disagreement) }, eff.disagreement) : null,
    lastAttempt: last ? { at: last.at, ok: last.ok, by: last.by, trigger: last.trigger } : null,
    warnings: warnings,
    // FR-9 (M9-08): the notes still waiting for a person (a note somebody has
    // marked as looked at is kept on the record, not shown as open).
    disputes: openDisputes(record).map(function (d) { return { at: d.at, note: d.note }; }),
    disputesLookedAt: record && Array.isArray(record.disputes) ? record.disputes.length - openDisputes(record).length : 0,
    needsPerson: needsPerson(practice, opts && opts.roleCount),
    recordedBefore: typeof p.dpa === 'boolean' ? (p.dpa ? 'yes' : 'no') : null
  };
}

/** What the staff job screen shows for one role. */
function staffRoleView(role, practice) {
  const area = roleArea(role) || {};
  const cur = roleCurrent(role);
  const manual = isObj(area.manual) ? area.manual : null;
  const site = area.site || roleSite(role, practice);
  const own = roleOwnRecord(role);
  const ownLookup = own && isObj(own.lookup) ? own.lookup : null;
  const practiceRecord = practiceArea(practice);
  const from = site === 'own' ? ownLookup : (practiceRecord && practiceRecord.lookup);
  const status = cur.statusRecorded ? cur.status : (cur.dpa ? 'yes' : 'no');
  let basis;
  if (manual) basis = 'Set by hand on this role by ' + (manual.by || 'staff');
  else if (area.follows === true) basis = site === 'own' ? 'Checked on this role\'s own address' : 'Follows the practice';
  else basis = 'Recorded before the automatic check';
  return {
    status: status,
    label: STATUS_LABELS[status],
    consequence: status === 'unknown' ? UNKNOWN_CONSEQUENCE : '',
    mmm: cur.mmm, mmmLabel: mmmLabel(cur.mmm, false),
    site: site,
    follows: area.follows === true,
    basis: basis,
    manual: manual ? { dpa: manual.dpa, mmm: manual.mmm, reason: manual.reason, by: manual.by, at: manual.at } : null,
    disagreement: isObj(area.disagreement) ? Object.assign({ message: disagreementWords(area.disagreement) }, area.disagreement) : null,
    checkedAt: (from && from.checked_at) || null,
    confidence: from ? from.confidence : 'none',
    source: from ? (PROVIDER_WORDS[from.provider] || from.provider) : '',
    year: from ? from.year : { dpa: null, mmm: null },
    approxMmmLabel: from && from.confidence !== 'exact' ? mmmLabel(from.mmm, true) : ''
  };
}

/**
 * FR-9 (M9-09). With the automatic check switched OFF, a practice that WAS
 * checked automatically was never asked whether it is in a priority area, so
 * staff must not read "Practice answered: Not sure" about it. This is what
 * they read instead. null: the practice has no record (it really was asked).
 * @returns {null | { at: (string|null), status: 'yes'|'no'|'unknown', label: string, setBy: string, note: string }}
 */
function autoCheckedNote(practiceOrRecord) {
  const record = isObj(practiceOrRecord) && practiceOrRecord.v === 1 ? practiceOrRecord : practiceArea(practiceOrRecord);
  if (!record) return null;
  const eff = effective(record);
  const at = (isObj(record.manual) && record.manual.at) || (isObj(record.lookup) && record.lookup.checked_at) || (isObj(record.last_attempt) && record.last_attempt.at) || null;
  const day = at ? String(at).slice(0, 10) : '';
  const how = eff.setBy === 'staff' ? 'Set by hand' : 'Checked automatically';
  return {
    at: at, status: eff.status, label: STATUS_LABELS[eff.status], setBy: eff.setBy,
    note: how + (day ? ' on ' + day : '') + '; the check is now off'
  };
}

/** A small, personal-data-free description of a status for the audit log. */
function auditValue(eff) {
  const e = eff || {};
  return { dpa: e.status || 'unknown', mmm: e.mmm == null ? null : e.mmm, mmm_approx: e.mmmApprox === true, set_by: e.setBy || 'none' };
}

module.exports = {
  KEY, DPA_STATES, STATUS_LABELS, UNKNOWN_CONSEQUENCE, NOT_CHECKED_LABEL,
  practiceArea, roleArea, practiceLocation, roleLocation, roleSite, roleCurrent, roleOwnRecord,
  effective, applyLookup, applyManual, clearManual, addDispute, blankRecord,
  sameAddressKey, roleDecision, roleManual, manualReasonError, MANUAL_REASON_NEEDED, intakeFieldsFor,
  openDisputes, resolveDisputes, needsPerson, PRACTICE_UNKNOWN_NOTE, autoCheckedNote,
  practiceFinding, staffView, staffRoleView, mmmLabel, warningWords, disagreementWords, auditValue
};

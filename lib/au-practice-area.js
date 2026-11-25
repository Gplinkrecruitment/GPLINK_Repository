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
 *     last_attempt: null | { at, ok, error, confidence, trigger, by },
 *     disputes: [ { at, note } ] }                              "This looks wrong" from the practice
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

  const after = effective(next);
  let outcome;
  if (res.ok !== true) outcome = 'failed';
  else if (after.disagreement) outcome = 'disagreed';
  else if (res.confidence !== 'exact' || (after.setBy === 'lookup' && after.status === 'unknown')) outcome = 'not_confident';
  else outcome = (before.status !== after.status || before.mmm !== after.mmm || before.mmmApprox !== after.mmmApprox || before.setBy !== after.setBy) ? 'changed' : 'unchanged';
  return { record: next, outcome: outcome, before: before, after: after, addressChanged: addressChanged };
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
  return { ok: true, record: next, before: before, after: effective(next) };
}

/** Removes the hand-set value: the look-up's answer (if any) applies again. */
function clearManual(record) {
  const prev = readRecord({ [KEY]: record }) ? clone(record) : blankRecord();
  const before = effective(prev);
  const next = clone(prev);
  next.manual = null;
  return { record: next, before: before, after: effective(next) };
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
 * @param {{ source: 'practice'|'own', now: string }} ctx
 * @returns {{ action: 'applied'|'in_step'|'manual_kept'|'legacy_kept'|'disagreement'|'nothing_known',
 *   patch: (null|{ dpa?, dpa_status?, mmm? }), area: object }}
 *   `area` is the role's new source_payload.au_area (always returned; write it when it differs).
 *
 *   manual_kept   a person set this role by hand: nothing changes; a differing answer is noted.
 *   legacy_kept   the role's values were recorded before this check existed and the
 *                 check is not confident: a recorded value is never degraded by a guess.
 *   disagreement  recorded before this check existed and the check DIFFERS: not applied;
 *                 staff choose. (A role that already follows is simply updated.)
 */
function roleDecision(role, target, ctx) {
  const c = ctx || {};
  const t = target || { status: 'unknown', mmm: null, mmmApprox: false, setBy: 'none' };
  const prevArea = roleArea(role) || {};
  const area = clone(prevArea) || {};
  const cur = roleCurrent(role);
  const targetStatus = dpaState(t.status);
  const targetMmm = t.mmmApprox ? null : locator.mmmNumber(t.mmm);
  area.site = c.source === 'own' ? 'own' : 'practice';
  // No "last checked" time is kept on the role: an unchanged answer must write
  // nothing to a role (running the check again is safe), and the date staff
  // are shown comes from the record the role follows.
  delete area.last_checked_at;
  delete area.checked_at;

  if (isObj(area.manual)) {
    const m = area.manual;
    const differs = (yesNo(targetStatus) && yesNo(m.dpa) && targetStatus !== m.dpa)
      || (targetMmm != null && locator.mmmNumber(m.mmm) != null && targetMmm !== locator.mmmNumber(m.mmm));
    area.disagreement = differs && t.setBy !== 'none'
      ? { lookup: { dpa: targetStatus, mmm: targetMmm, at: t.checkedAt || null, set_by: t.setBy }, recorded: { dpa: dpaState(m.dpa), mmm: locator.mmmNumber(m.mmm) }, kind: 'manual', at: txt(c.now, 40) }
      : null;
    return { action: 'manual_kept', patch: null, area: area };
  }
  if (t.setBy === 'none') return { action: 'nothing_known', patch: null, area: area };

  if (area.follows !== true) {
    if (targetStatus === 'unknown' && t.setBy !== 'staff') {
      area.disagreement = null;
      return { action: 'legacy_kept', patch: null, area: area };
    }
    const dpaDiffers = yesNo(targetStatus) && yesNo(cur.status) && targetStatus !== cur.status;
    const mmmDiffers = targetMmm != null && cur.mmm != null && targetMmm !== cur.mmm;
    if ((dpaDiffers || mmmDiffers) && t.setBy !== 'staff') {
      area.disagreement = {
        lookup: { dpa: targetStatus, mmm: targetMmm, at: t.checkedAt || null, set_by: t.setBy },
        recorded: { dpa: cur.status, mmm: cur.mmm }, kind: 'recorded_before', at: txt(c.now, 40)
      };
      return { action: 'disagreement', patch: null, area: area };
    }
  }

  const patch = {};
  if (cur.status !== targetStatus || !cur.statusRecorded || cur.dpa !== (targetStatus === 'yes')) {
    patch.dpa_status = targetStatus;
    // The boolean is all the overseas rule reads: only "yes" is a DPA role.
    patch.dpa = targetStatus === 'yes';
  }
  if (targetMmm != null && targetMmm !== cur.mmm) patch.mmm = locator.mmmCode(targetMmm);
  area.follows = true;
  area.disagreement = null;
  area.status = targetStatus;
  area.mmm = targetMmm;
  area.set_by = t.setBy;
  return { action: Object.keys(patch).length ? 'applied' : 'in_step', patch: Object.keys(patch).length ? patch : null, area: area };
}

/** Staff set a role's own value in the job editor. null dpa: back to following. */
function roleManual(role, input) {
  const i = input || {};
  const area = clone(roleArea(role)) || {};
  if (i.dpa === null || i.dpa === undefined || i.dpa === '') {
    area.manual = null; area.follows = false; area.disagreement = null;
    return area;
  }
  area.manual = { dpa: dpaState(i.dpa), mmm: locator.mmmNumber(i.mmm), reason: txt(i.reason, 500), by: txt(i.by, 200), at: txt(i.now, 40) };
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
const UNKNOWN_CONSEQUENCE = 'Not confirmed: hidden from doctors restricted to priority areas';
const NOT_CHECKED_LABEL = 'Area not checked yet';

const WARNING_WORDS = Object.freeze({
  address_not_precise: 'Only the suburb or street could be found, not the building, so the priority-area answer is not confirmed. Check the street address, or set it by hand.',
  point_address_mismatch: 'The map point on file did not match the written address, so it was not used.',
  point_not_corroborated: 'The map point came with the address the practice selected and could not be cross-checked against the written address.',
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
  } else if (d.recorded) {
    const who = d.kind === 'manual' ? 'the value set by hand on this role' : 'the value already recorded on this role';
    if (d.lookup.dpa !== d.recorded.dpa && yesNo(d.lookup.dpa) && yesNo(d.recorded.dpa)) parts.push((d.lookup.set_by === 'staff' ? 'The practice record says ' : 'The automatic check says ') + say(d.lookup.dpa) + '; ' + who + ' says ' + say(d.recorded.dpa) + '.');
    if (d.lookup.mmm != null && d.recorded.mmm != null && d.lookup.mmm !== d.recorded.mmm) parts.push((d.lookup.set_by === 'staff' ? 'The practice record says MM ' : 'The automatic check says MM ') + d.lookup.mmm + '; ' + who + ' says MM ' + d.recorded.mmm + '.');
  }
  return parts.join(' ');
}

/** Everything the staff practice screen shows. `legacyDpa` is practices.dpa (what was recorded before). */
function staffView(practice) {
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
  if (lookup && lookup.address_key !== addressNow && !manual) warnings.push('The address has changed since the last check. Run Re-check.');
  return {
    // "Checked" means there is an answer on file: one from the look-up or one
    // set by hand. A practice that has never been checked, or whose only
    // check so far failed, is not "not confirmed": nothing is known yet, and
    // its roles still carry whatever was recorded on them before. The
    // consequence line is only true once there is an answer to follow.
    checked: !!(lookup || manual),
    status: eff.status,
    label: (lookup || manual) ? STATUS_LABELS[eff.status] : NOT_CHECKED_LABEL,
    consequence: (lookup || manual) && eff.status === 'unknown' ? UNKNOWN_CONSEQUENCE : '',
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
    disagreement: eff.disagreement ? Object.assign({ message: disagreementWords(eff.disagreement) }, eff.disagreement) : null,
    lastAttempt: last ? { at: last.at, ok: last.ok, by: last.by, trigger: last.trigger } : null,
    warnings: warnings,
    disputes: record && Array.isArray(record.disputes) ? record.disputes.slice() : [],
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

/** A small, personal-data-free description of a status for the audit log. */
function auditValue(eff) {
  const e = eff || {};
  return { dpa: e.status || 'unknown', mmm: e.mmm == null ? null : e.mmm, mmm_approx: e.mmmApprox === true, set_by: e.setBy || 'none' };
}

module.exports = {
  KEY, DPA_STATES, STATUS_LABELS, UNKNOWN_CONSEQUENCE, NOT_CHECKED_LABEL,
  practiceArea, roleArea, practiceLocation, roleLocation, roleSite, roleCurrent, roleOwnRecord,
  effective, applyLookup, applyManual, clearManual, addDispute, blankRecord,
  roleDecision, roleManual, intakeFieldsFor,
  practiceFinding, staffView, staffRoleView, mmmLabel, warningWords, disagreementWords, auditValue
};

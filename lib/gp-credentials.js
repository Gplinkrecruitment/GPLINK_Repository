'use strict';

/**
 * gp_credentials and candidate preferences: field lists, input cleaning, and
 * the Ahpra source-of-truth read rule. Pure, no I/O.
 *
 * WP-02 of the Australian GP build. The table is created by
 * supabase/migrations/20261120100000_au_gp_wp02_pathway_credentials.sql; the
 * server-side writers are upsertGpCredentials and setCandidatePreferences in
 * server.js, and they accept ONLY what the cleaners here let through.
 *
 * ── Where Ahpra registration data lives (finding DAT-09) ─────────────────────
 * There are three places a registration number can sit. They are NOT merged,
 * and nothing existing is moved:
 *
 *   gp_credentials.*                       THE source of truth for a doctor who
 *                                          already holds Ahpra registration:
 *                                          every Australian pathway reads here
 *                                          and only here.
 *   registration_cases.ahpra_registration_*  Written by the overseas "registration
 *                                          granted" handler when Ahpra grants
 *                                          registration at the end of the
 *                                          overseas journey. Overseas pathways
 *                                          keep reading and writing these.
 *                                          WP-14 may copy them forward into
 *                                          gp_credentials; until it does, they
 *                                          are never consulted for an Australian
 *                                          pathway.
 *   user_profiles.register_*               The onboarding identity check against
 *                                          a public register (GMC, MCNZ, IMC,
 *                                          Ahpra): a number and a "verified"
 *                                          stamp. Not a registration record; it
 *                                          says nothing about type, conditions
 *                                          or expiry. Unchanged.
 *
 * readAhpraRegistration() below is the one helper that encodes that rule.
 */

const { isAuPathway, normalisePathway, normalise19ab } = require('./candidate-pathway.js');

// ── allowed values (validated here, deliberately not by database CHECKs except
//    where noted, so a regulator nuance does not need a migration) ────────────
const AHPRA_REGISTRATION_TYPES = Object.freeze([
  'general', 'specialist', 'general_and_specialist', 'provisional', 'limited', 'non_practising'
]);
// Registration types that mean the doctor works under supervision or limits
// (the placement-hook matrix: supervisor paperwork fires for these in segment B).
const SUPERVISED_REGISTRATION_TYPES = Object.freeze(['provisional', 'limited']);
const FELLOWSHIP_TYPES = Object.freeze(['fracgp', 'facrrm', 'both', 'other', 'none']);   // DB CHECK
const VR_STATUSES = Object.freeze(['vr', 'non_vr', 'unsure']);                           // DB CHECK
const WORK_RIGHTS = Object.freeze(['citizen', 'pr', 'visa']);                            // DB CHECK
const SUPERVISION_LEVELS = Object.freeze(['none', 'level_1', 'level_2', 'level_3', 'level_4']);
const BILLING_PREFERENCES = Object.freeze(['bulk', 'mixed', 'private', 'any']);
const AU_STATES = Object.freeze(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT']);

// What each gp_credentials column holds. 'kind' drives the cleaner.
const CREDENTIAL_FIELDS = Object.freeze({
  ahpra_number: { kind: 'ahpra_number' },
  ahpra_registration_type: { kind: 'enum', values: AHPRA_REGISTRATION_TYPES },
  specialist_gp: { kind: 'bool' },
  has_conditions: { kind: 'bool' },
  conditions_text: { kind: 'text', max: 4000 },
  has_undertakings: { kind: 'bool' },
  undertakings_text: { kind: 'text', max: 4000 },
  has_notations: { kind: 'bool' },
  notations_text: { kind: 'text', max: 4000 },
  registration_expiry: { kind: 'date' },
  fellowship_type: { kind: 'enum', values: FELLOWSHIP_TYPES },
  fellowship_detail: { kind: 'text', max: 200 },
  fellowship_year: { kind: 'year' },
  vr_status: { kind: 'enum', values: VR_STATUSES },
  moratorium_19ab_status: { kind: '19ab' },
  moratorium_19ab_end_date: { kind: 'date' },
  work_rights: { kind: 'enum', values: WORK_RIGHTS },
  visa_subclass: { kind: 'text', max: 20 },
  visa_expiry: { kind: 'date' },
  visa_sponsor_tied: { kind: 'bool' },
  visa_sponsor_name: { kind: 'text', max: 200 },
  supervision_level: { kind: 'enum', values: SUPERVISION_LEVELS },
  indemnity_provider: { kind: 'text', max: 200 },
  indemnity_expiry: { kind: 'date' }
});

// Columns only staff may write. A doctor's own submission can never set them.
const STAFF_ONLY_CREDENTIAL_FIELDS = Object.freeze({
  ahpra_last_checked_at: { kind: 'timestamp' },
  ahpra_last_checked_by: { kind: 'text', max: 320 },
  moratorium_19ab_confirmed_status: { kind: 'enum', values: ['yes', 'no'] },
  moratorium_19ab_confirmed_by: { kind: 'text', max: 320 },
  moratorium_19ab_confirmed_at: { kind: 'timestamp' },
  staff_verified_at: { kind: 'timestamp' },
  staff_verified_by: { kind: 'text', max: 320 }
});

// WP-08 staff-only columns, kept in their own map so CREDENTIAL_COLUMNS stays
// the WP-02 table inventory (the WP-02 migration test reads it). Added by
// 20261120130000_au_gp_wp08_role_fields.sql.
// "A person has looked at this doctor's condition / undertaking / notation".
// Cleared automatically whenever those flags change (below).
const WP08_STAFF_ONLY_CREDENTIAL_FIELDS = Object.freeze({
  flags_reviewed_at: { kind: 'timestamp' },
  flags_reviewed_by: { kind: 'text', max: 320 }
});

// WP-08: the columns whose change means the review above no longer covers what
// is on file. (The two stamp columns are added by the WP-08 migration.)
const REGISTRATION_FLAG_FIELDS = Object.freeze([
  'has_conditions', 'conditions_text', 'has_undertakings', 'undertakings_text', 'has_notations', 'notations_text'
]);
const FLAG_REVIEW_FIELDS = Object.freeze(['flags_reviewed_at', 'flags_reviewed_by']);

// FR-1 (R-04): the registration facts a staff Ahpra check establishes. Once
// gp_credentials.staff_verified_at is set a doctor's own write can no longer
// change any of them (sanitiseCredentialsPatch, source 'self'). Staff still
// can. The doctor's 19AB answer is NOT here: it is only ever the doctor's own
// answer (the staff answer lives in moratorium_19ab_confirmed_*, and changing
// the doctor's answer withdraws that confirmation, which restricts).
// Indemnity and the visa subclass / expiry / sponsor name are not here either:
// they are not part of the register check and nothing is stated as confirmed
// from them.
const STAFF_VERIFIED_LOCKED_FIELDS = Object.freeze([
  'ahpra_number', 'ahpra_registration_type', 'specialist_gp',
  'has_conditions', 'conditions_text', 'has_undertakings', 'undertakings_text', 'has_notations', 'notations_text',
  'registration_expiry',
  'fellowship_type', 'fellowship_detail', 'fellowship_year', 'vr_status',
  'work_rights', 'visa_sponsor_tied', 'supervision_level'
]);

// Every column of gp_credentials, in table order (for select= lists and docs).
const CREDENTIAL_COLUMNS = Object.freeze(
  ['user_id']
    .concat(Object.keys(CREDENTIAL_FIELDS))
    .concat(Object.keys(STAFF_ONLY_CREDENTIAL_FIELDS))
    .concat(['self_declared_at', 'created_at', 'updated_at'])
);

// The server-owned pathway columns on user_profiles. NEVER client-writable.
const PATHWAY_PROFILE_COLUMNS = Object.freeze([
  'candidate_pathway', 'candidate_basis', 'pathway_set_by', 'pathway_set_at',
  'pathway_confirmed_at', 'pathway_confirmed_by'
]);

// Candidate preference columns on user_profiles.
const PREFERENCE_FIELDS = Object.freeze({
  current_suburb: { kind: 'text', max: 120 },
  current_state: { kind: 'enum_upper', values: AU_STATES },
  current_postcode: { kind: 'postcode' },
  current_latitude: { kind: 'number', min: -90, max: 90 },
  current_longitude: { kind: 'number', min: -180, max: 180 },
  commute_radius_km: { kind: 'int', min: 0, max: 5000 },
  notice_period_weeks: { kind: 'int', min: 0, max: 104 },
  available_from: { kind: 'date' },
  sessions_wanted: { kind: 'number', min: 0, max: 14 },
  billing_preference: { kind: 'enum', values: BILLING_PREFERENCES },
  special_interests: { kind: 'text_array', maxItems: 30, max: 80 },
  open_to_locum: { kind: 'bool' },
  open_to_relocate: { kind: 'bool' },
  timezone: { kind: 'timezone' }
});
const PREFERENCE_COLUMNS = Object.freeze(Object.keys(PREFERENCE_FIELDS));

// ── value cleaners ───────────────────────────────────────────────────────────
// Each returns { ok: true, value } or { ok: false }. null always clears a field.
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function cleanDate(v) {
  if (typeof v !== 'string') return { ok: false };
  const m = ISO_DATE_RE.exec(v.trim());
  if (!m) return { ok: false };
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { ok: false };
  if (y < 1900 || y > 2200) return { ok: false };
  return { ok: true, value: m[0] };
}

function cleanTimestamp(v) {
  if (v instanceof Date) v = v.toISOString();
  if (typeof v !== 'string' || !v.trim()) return { ok: false };
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return { ok: false };
  return { ok: true, value: new Date(ms).toISOString() };
}

function cleanText(v, max) {
  if (typeof v !== 'string') return { ok: false };
  // Printable text only: control characters are stripped, not stored.
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const code = v.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) { out += ' '; continue; }
    if (code < 32 || code === 127) continue;
    out += v[i];
  }
  out = out.trim().slice(0, max || 500);
  return { ok: true, value: out || null };
}

function cleanEnum(v, values, upper) {
  if (typeof v !== 'string') return { ok: false };
  const t = upper ? v.trim().toUpperCase() : v.trim().toLowerCase();
  return values.indexOf(t) !== -1 ? { ok: true, value: t } : { ok: false };
}

// Ahpra numbers are three letters and ten digits (medical practitioners: MED).
function cleanAhpraNumber(v) {
  if (typeof v !== 'string') return { ok: false };
  const t = v.replace(/[\s-]+/g, '').toUpperCase();
  return /^[A-Z]{3}\d{10}$/.test(t) ? { ok: true, value: t } : { ok: false };
}

function cleanNumber(v, min, max, integer) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n)) return { ok: false };
  if (integer && !Number.isInteger(n)) return { ok: false };
  if (n < min || n > max) return { ok: false };
  return { ok: true, value: n };
}

function cleanTimezone(v) {
  if (typeof v !== 'string') return { ok: false };
  const t = v.trim();
  if (!t || t.length > 64) return { ok: false };
  try {
    // Throws RangeError for anything that is not an IANA zone the runtime knows.
    new Intl.DateTimeFormat('en-AU', { timeZone: t });
    return { ok: true, value: t };
  } catch (e) {
    return { ok: false };
  }
}

function cleanValue(spec, v, nowYear) {
  if (v === null) return { ok: true, value: null };
  if (v === undefined) return { ok: false };
  switch (spec.kind) {
    case 'bool': return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false };
    case 'text': return cleanText(v, spec.max);
    case 'date': return cleanDate(v);
    case 'timestamp': return cleanTimestamp(v);
    case 'enum': return cleanEnum(v, spec.values, false);
    case 'enum_upper': return cleanEnum(v, spec.values, true);
    case '19ab': {
      const n = normalise19ab(v);
      return n ? { ok: true, value: n } : { ok: false };
    }
    case 'ahpra_number': return cleanAhpraNumber(v);
    case 'year': return cleanNumber(v, 1950, nowYear + 1, true);
    case 'int': return cleanNumber(v, spec.min, spec.max, true);
    case 'number': return cleanNumber(v, spec.min, spec.max, false);
    case 'postcode': {
      if (typeof v !== 'string' && typeof v !== 'number') return { ok: false };
      const t = String(v).trim();
      return /^\d{4}$/.test(t) ? { ok: true, value: t } : { ok: false };
    }
    case 'timezone': return cleanTimezone(v);
    case 'text_array': {
      if (!Array.isArray(v)) return { ok: false };
      const out = [];
      for (let i = 0; i < v.length && out.length < spec.maxItems; i++) {
        const c = cleanText(v[i], spec.max);
        if (c.ok && c.value && out.indexOf(c.value) === -1) out.push(c.value);
      }
      return { ok: true, value: out };
    }
    default: return { ok: false };
  }
}

/**
 * Clean a patch for gp_credentials. Only known columns survive; anything else
 * (and any value of the wrong shape) is listed in `rejected` and not written.
 *
 * @param {object} patch  { column: value } using the table's column names
 * @param {object} [opts]
 * @param {'self'|'staff'} [opts.source='self']  who is writing. 'self' (the
 *        doctor's own answers) can never set a staff-only column.
 * @param {string} [opts.actor]     staff email, for 'staff' stamps
 * @param {string} [opts.now]       ISO timestamp (injectable for tests)
 * @param {object|null} [opts.existing]  the row as stored now. Used for one
 *        rule: when a doctor CHANGES their own 19AB answer or end date after
 *        staff confirmed it, the staff confirmation is cleared, so the doctor
 *        is DPA-restricted again until staff re-confirm (fail closed).
 * @param {boolean} [opts.markVerified]  staff only: stamp staff_verified_at/by
 * @returns {{ clean: object, rejected: string[] }}
 */
function sanitiseCredentialsPatch(patch, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const source = o.source === 'staff' ? 'staff' : 'self';
  const nowIso = (cleanTimestamp(o.now).ok ? cleanTimestamp(o.now).value : new Date().toISOString());
  const nowYear = new Date(nowIso).getUTCFullYear();
  const actor = String(o.actor == null ? '' : o.actor).trim().slice(0, 320);
  const incoming = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const clean = {};
  const rejected = [];

  Object.keys(incoming).forEach(function (key) {
    let spec = CREDENTIAL_FIELDS[key];
    if (!spec && source === 'staff') spec = STAFF_ONLY_CREDENTIAL_FIELDS[key] || WP08_STAFF_ONLY_CREDENTIAL_FIELDS[key];
    if (!spec) { rejected.push(key); return; }
    const c = cleanValue(spec, incoming[key], nowYear);
    if (!c.ok) { rejected.push(key); return; }
    clean[key] = c.value;
  });

  const locked = [];
  if (source === 'self') {
    const existing = o.existing && typeof o.existing === 'object' ? o.existing : null;
    // FR-1 (R-04): once staff have verified the registration on the register,
    // the doctor cannot change the facts that check established, by ANY
    // self-service route (onboarding again, Account). The keys are dropped
    // here, the one cleaner every self write goes through, and listed in
    // `locked` so the caller can turn them into a "my details have changed"
    // request for staff. The verified values and the stamp are never touched.
    if (existing && existing.staff_verified_at) {
      STAFF_VERIFIED_LOCKED_FIELDS.forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(clean, k)) { delete clean[k]; locked.push(k); rejected.push(k); }
      });
    }
    if (Object.keys(clean).length) clean.self_declared_at = nowIso;
    const statusChanged = Object.prototype.hasOwnProperty.call(clean, 'moratorium_19ab_status')
      && (!existing || normalise19ab(existing.moratorium_19ab_status) !== clean.moratorium_19ab_status);
    const endChanged = Object.prototype.hasOwnProperty.call(clean, 'moratorium_19ab_end_date')
      && (!existing || String(existing.moratorium_19ab_end_date || '').slice(0, 10) !== String(clean.moratorium_19ab_end_date || ''));
    if (statusChanged || endChanged) {
      clean.moratorium_19ab_confirmed_status = null;
      clean.moratorium_19ab_confirmed_by = null;
      clean.moratorium_19ab_confirmed_at = null;
    }
  } else {
    // A staff 19AB confirmation always carries who and when; clearing the value
    // clears both.
    if (!Object.prototype.hasOwnProperty.call(clean, 'moratorium_19ab_confirmed_status')) {
      // "Who" and "when" cannot be written on their own: they only ever travel
      // with the value they belong to.
      ['moratorium_19ab_confirmed_by', 'moratorium_19ab_confirmed_at'].forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(clean, k)) { delete clean[k]; rejected.push(k); }
      });
    } else {
      if (clean.moratorium_19ab_confirmed_status === null) {
        clean.moratorium_19ab_confirmed_by = null;
        clean.moratorium_19ab_confirmed_at = null;
      } else {
        clean.moratorium_19ab_confirmed_by = actor || clean.moratorium_19ab_confirmed_by || null;
        clean.moratorium_19ab_confirmed_at = nowIso;
        if (!clean.moratorium_19ab_confirmed_by) {
          // No name to put against it: not a confirmation. Refuse the three keys.
          delete clean.moratorium_19ab_confirmed_status;
          delete clean.moratorium_19ab_confirmed_by;
          delete clean.moratorium_19ab_confirmed_at;
          rejected.push('moratorium_19ab_confirmed_status');
        }
      }
    }
    if (o.markVerified === true && actor) {
      clean.staff_verified_at = nowIso;
      clean.staff_verified_by = actor;
    }
    // WP-08: the reviewed stamp. Like the 19AB confirmation it only ever
    // travels as "who and when" together, stamped here, never trusted from
    // the caller. `flags_reviewed_at: null` clears both.
    if (Object.prototype.hasOwnProperty.call(clean, 'flags_reviewed_at') || Object.prototype.hasOwnProperty.call(clean, 'flags_reviewed_by')) {
      const clearing = Object.prototype.hasOwnProperty.call(clean, 'flags_reviewed_at') && clean.flags_reviewed_at === null;
      if (clearing) {
        clean.flags_reviewed_at = null;
        clean.flags_reviewed_by = null;
      } else if (actor) {
        clean.flags_reviewed_at = nowIso;
        clean.flags_reviewed_by = actor;
      } else {
        delete clean.flags_reviewed_at;
        delete clean.flags_reviewed_by;
        rejected.push('flags_reviewed_at');
      }
    }
  }

  // WP-08: a change to what is flagged (by anyone) withdraws an earlier
  // review, unless this same write is the review. Only when the caller handed
  // in the existing row and it carries a stamp: nothing is written otherwise,
  // so a database without the WP-08 columns never sees them named.
  const prior = o.existing && typeof o.existing === 'object' ? o.existing : null;
  const stampingNow = Object.prototype.hasOwnProperty.call(clean, 'flags_reviewed_at') && clean.flags_reviewed_at !== null;
  if (prior && prior.flags_reviewed_at && !stampingNow) {
    const flagsChanged = REGISTRATION_FLAG_FIELDS.some(function (k) {
      if (!Object.prototype.hasOwnProperty.call(clean, k)) return false;
      const before = prior[k] == null ? null : prior[k];
      const after = clean[k] == null ? null : clean[k];
      return before !== after;
    });
    if (flagsChanged) {
      clean.flags_reviewed_at = null;
      clean.flags_reviewed_by = null;
    }
  }

  return { clean, rejected, locked };
}

/**
 * Clean a patch of candidate preference columns for user_profiles.
 * @param {object} patch { column: value }
 * @returns {{ clean: object, rejected: string[] }}
 */
function sanitisePreferencesPatch(patch) {
  const incoming = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const nowYear = new Date().getUTCFullYear();
  const clean = {};
  const rejected = [];
  Object.keys(incoming).forEach(function (key) {
    const spec = PREFERENCE_FIELDS[key];
    if (!spec) { rejected.push(key); return; }
    const c = cleanValue(spec, incoming[key], nowYear);
    if (!c.ok) { rejected.push(key); return; }
    clean[key] = c.value;
  });
  return { clean, rejected };
}

/**
 * THE read rule for Ahpra registration data (finding DAT-09).
 *
 *   Australian pathway -> gp_credentials, and nothing else. No credentials row,
 *                         or no number on it: source 'none'. The case columns
 *                         are never used as a fallback.
 *   Overseas pathway   -> registration_cases.ahpra_registration_* (what the
 *                         registration-granted handler recorded). gp_credentials
 *                         is never consulted.
 *
 * @param {object} input
 * @param {string} input.pathway             any value; unknown reads as overseas
 * @param {object|null} [input.credentials]  gp_credentials row
 * @param {object|null} [input.caseRow]      registration_cases row
 * @returns {{
 *   source: 'gp_credentials'|'registration_case'|'none',
 *   number: string|null, type: string|null, expiry: string|null,
 *   hasConditions: boolean|null, hasUndertakings: boolean|null, hasNotations: boolean|null,
 *   conditions: any, lastCheckedAt: string|null, lastCheckedBy: string|null,
 *   effectiveDate: string|null, grantedAt: string|null
 * }}
 */
function readAhpraRegistration(input) {
  const i = input && typeof input === 'object' ? input : {};
  const empty = {
    source: 'none', number: null, type: null, expiry: null,
    hasConditions: null, hasUndertakings: null, hasNotations: null,
    conditions: null, lastCheckedAt: null, lastCheckedBy: null,
    effectiveDate: null, grantedAt: null
  };
  const bool = function (v) { return typeof v === 'boolean' ? v : null; };

  if (isAuPathway(normalisePathway(i.pathway))) {
    const c = i.credentials && typeof i.credentials === 'object' ? i.credentials : null;
    if (!c || !c.ahpra_number) return empty;
    return Object.assign({}, empty, {
      source: 'gp_credentials',
      number: String(c.ahpra_number),
      type: c.ahpra_registration_type || null,
      expiry: c.registration_expiry || null,
      hasConditions: bool(c.has_conditions),
      hasUndertakings: bool(c.has_undertakings),
      hasNotations: bool(c.has_notations),
      conditions: c.conditions_text || null,
      lastCheckedAt: c.ahpra_last_checked_at || null,
      lastCheckedBy: c.ahpra_last_checked_by || null
    });
  }

  const k = i.caseRow && typeof i.caseRow === 'object' ? i.caseRow : null;
  if (!k || !k.ahpra_registration_number) return empty;
  return Object.assign({}, empty, {
    source: 'registration_case',
    number: String(k.ahpra_registration_number),
    type: k.ahpra_registration_type || null,
    expiry: k.ahpra_registration_expiry_date || null,
    hasConditions: bool(k.ahpra_registration_has_conditions),
    conditions: k.ahpra_registration_conditions == null ? null : k.ahpra_registration_conditions,
    effectiveDate: k.ahpra_registration_effective_date || null,
    grantedAt: k.ahpra_registration_granted_at || null
  });
}

/** True when a registration type means supervised or limited practice. */
function isSupervisedRegistrationType(type) {
  return SUPERVISED_REGISTRATION_TYPES.indexOf(String(type == null ? '' : type).trim().toLowerCase()) !== -1;
}

module.exports = {
  REGISTRATION_FLAG_FIELDS,
  FLAG_REVIEW_FIELDS,
  WP08_STAFF_ONLY_CREDENTIAL_FIELDS,
  AHPRA_REGISTRATION_TYPES,
  SUPERVISED_REGISTRATION_TYPES,
  FELLOWSHIP_TYPES,
  VR_STATUSES,
  WORK_RIGHTS,
  SUPERVISION_LEVELS,
  BILLING_PREFERENCES,
  AU_STATES,
  CREDENTIAL_FIELDS,
  STAFF_ONLY_CREDENTIAL_FIELDS,
  STAFF_VERIFIED_LOCKED_FIELDS,
  CREDENTIAL_COLUMNS,
  PATHWAY_PROFILE_COLUMNS,
  PREFERENCE_FIELDS,
  PREFERENCE_COLUMNS,
  sanitiseCredentialsPatch,
  sanitisePreferencesPatch,
  readAhpraRegistration,
  isSupervisedRegistrationType
};

'use strict';

/**
 * Standard test doctors for the Australian GP build (WP-02 onwards).
 *
 * One fixture per kind of doctor, with every row in the shape the server
 * really stores it. Reuse these instead of hand-rolling rows, so every package
 * tests against the same six doctors (docs/au-gp/CONVENTIONS.md, "Tests").
 *
 *   const { buildAuDoctor, buildAuFixtureDb, AU_DOCTOR_KINDS } = require('./helpers/au-fixtures.js');
 *   const vr = buildAuDoctor('au_vr');
 *   vr.profile      user_profiles row (live NOT NULL text columns are '')
 *   vr.credentials  gp_credentials row, or null for the overseas doctors
 *   vr.caseRow      registration_cases row
 *   vr.state        user_state row ({ user_id, state, updated_at })
 *   vr.expected     what resolveCandidatePathway should say for this doctor
 *
 * Kinds:
 *   au_vr              segment A. Staff-confirmed pathway, FRACGP, 19AB staff-confirmed
 *                      "does not apply": the launched, unrestricted happy path.
 *   au_restricted      segment B. 19AB applies (doctor's answer AND staff), visa tied to a sponsor.
 *   au_non_vr          segment C. Not vocationally registered, 19AB unsure, self-declared.
 *   au_registrar       segment C. Registrar; says 19AB does not apply, staff have NOT confirmed.
 *   overseas_null      an existing overseas doctor: nothing recorded anywhere. Must behave
 *                      exactly as before the build, switch on or off.
 *   overseas_explicit  an overseas doctor whose pathway staff have recorded as overseas_esp.
 *
 * Every identity is obviously fake. Override anything:
 *   buildAuDoctor('au_vr', { credentials: { moratorium_19ab_confirmed_status: null } })
 *   buildAuDoctor('au_vr', { selfDeclared: true })   // pathway not yet staff-confirmed
 */

const AU_DOCTOR_KINDS = Object.freeze([
  'au_vr', 'au_restricted', 'au_non_vr', 'au_registrar', 'overseas_null', 'overseas_explicit'
]);

const AU_FIXTURE_PATHWAYS = Object.freeze(['au_vr', 'au_restricted', 'au_non_vr', 'au_registrar']);
const FIXED_NOW = '2026-11-20T02:00:00.000Z';
const STAFF_EMAIL = 'staff.test@gplink-test.local';

const IDS = Object.freeze({
  au_vr: { n: 'a1', first: 'Test', last: 'Auvr', email: 'au.vr.test@gplink-test.local', phone: '+61400000111' },
  au_restricted: { n: 'a2', first: 'Test', last: 'Aurestricted', email: 'au.restricted.test@gplink-test.local', phone: '+61400000222' },
  au_non_vr: { n: 'a3', first: 'Test', last: 'Aunonvr', email: 'au.nonvr.test@gplink-test.local', phone: '+61400000333' },
  au_registrar: { n: 'a4', first: 'Test', last: 'Auregistrar', email: 'au.registrar.test@gplink-test.local', phone: '+61400000444' },
  overseas_null: { n: 'b1', first: 'Test', last: 'Ukgp', email: 'uk.gp.test@gplink-test.local', phone: '+447700900111' },
  overseas_explicit: { n: 'b2', first: 'Test', last: 'Iegp', email: 'ie.gp.test@gplink-test.local', phone: '+353870000111' }
});

function fakeUuid(prefix, n) {
  return '00000000-0000-4000-8000-' + (prefix + n).padStart(12, '0');
}

// A user_profiles row with every live NOT NULL text column present (they
// default to '' in the database) and every WP-02 column present as null.
function baseProfile(id, who) {
  return {
    user_id: id,
    email: who.email,
    first_name: who.first,
    last_name: who.last,
    country_dial: who.phone.slice(0, 3),
    phone_number: who.phone.slice(3),
    registration_country: '',
    phone: who.phone,
    registration_number: '',
    gmc_number: '',
    profile_photo_name: '',
    profile_photo_data_url: '',
    id_copy_name: '',
    id_copy_data_url: '',
    cv_file_name: '',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    qualification_country: '',
    preferred_city: '',
    target_arrival_date: '',
    who_moving: '',
    children_count: '',
    onboarding_completed_at: '2026-10-02T00:00:00.000Z',
    account_status: 'active',
    name_change_detected: false,
    register_body: null,
    register_number: null,
    register_status: null,
    // WP-02 pathway columns
    candidate_pathway: null,
    candidate_basis: null,
    pathway_set_by: null,
    pathway_set_at: null,
    pathway_confirmed_at: null,
    pathway_confirmed_by: null,
    // WP-02 preference columns
    current_suburb: null,
    current_state: null,
    current_postcode: null,
    current_latitude: null,
    current_longitude: null,
    commute_radius_km: null,
    notice_period_weeks: null,
    available_from: null,
    sessions_wanted: null,
    billing_preference: null,
    special_interests: null,
    open_to_locum: null,
    open_to_relocate: null,
    timezone: null
  };
}

function baseCredentials(id) {
  return {
    user_id: id,
    ahpra_number: null,
    ahpra_registration_type: null,
    specialist_gp: null,
    has_conditions: false,
    conditions_text: null,
    has_undertakings: false,
    undertakings_text: null,
    has_notations: false,
    notations_text: null,
    registration_expiry: null,
    ahpra_last_checked_at: null,
    ahpra_last_checked_by: null,
    fellowship_type: null,
    fellowship_detail: null,
    fellowship_year: null,
    vr_status: null,
    moratorium_19ab_status: null,
    moratorium_19ab_end_date: null,
    moratorium_19ab_confirmed_status: null,
    moratorium_19ab_confirmed_by: null,
    moratorium_19ab_confirmed_at: null,
    work_rights: null,
    visa_subclass: null,
    visa_expiry: null,
    visa_sponsor_tied: null,
    visa_sponsor_name: null,
    supervision_level: null,
    indemnity_provider: null,
    indemnity_expiry: null,
    self_declared_at: '2026-11-01T00:00:00.000Z',
    staff_verified_at: null,
    staff_verified_by: null,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z'
  };
}

// A registration_cases row as the server creates one. `stage` here is the
// overseas default ('myintealth'). WP-03: buildAuDoctor puts a doctor on an
// Australian pathway on the Australian ladder instead ('placement'), exactly
// as _ensureRegCase does. Override with { caseRow: { stage: ... } }.
function baseCase(caseId, userId) {
  return {
    id: caseId,
    user_id: userId,
    assigned_va: null,
    assigned_rso: null,
    stage: 'myintealth',
    substage: null,
    status: 'active',
    blocker_status: null,
    practice_name: null,
    ahpra_registration_number: null,
    ahpra_registration_type: null,
    ahpra_registration_effective_date: null,
    ahpra_registration_expiry_date: null,
    ahpra_registration_granted_at: null,
    ahpra_registration_has_conditions: null,
    ahpra_registration_conditions: null,
    created_at: '2026-10-02T00:00:00.000Z',
    updated_at: '2026-10-02T00:00:00.000Z',
    // WP-02 mirror column
    pathway: null
  };
}

const KIND_SHAPES = {
  au_vr: function () {
    return {
      profile: {
        registration_country: 'Australia', qualification_country: 'AU', preferred_city: 'Melbourne',
        candidate_pathway: 'au_vr', candidate_basis: 'australia',
        pathway_set_by: STAFF_EMAIL, pathway_set_at: FIXED_NOW,
        pathway_confirmed_at: FIXED_NOW, pathway_confirmed_by: STAFF_EMAIL,
        current_suburb: 'Test Suburb', current_state: 'VIC', current_postcode: '3000',
        commute_radius_km: 30, notice_period_weeks: 4, sessions_wanted: 8,
        billing_preference: 'mixed', timezone: 'Australia/Melbourne'
      },
      credentials: {
        ahpra_number: 'MED0001000001', ahpra_registration_type: 'general_and_specialist', specialist_gp: true,
        registration_expiry: '2027-09-30', ahpra_last_checked_at: FIXED_NOW, ahpra_last_checked_by: STAFF_EMAIL,
        fellowship_type: 'fracgp', fellowship_year: 2015, vr_status: 'vr',
        moratorium_19ab_status: 'no',
        moratorium_19ab_confirmed_status: 'no', moratorium_19ab_confirmed_by: STAFF_EMAIL, moratorium_19ab_confirmed_at: FIXED_NOW,
        work_rights: 'citizen', supervision_level: 'none',
        indemnity_provider: 'Test Indemnity (FAKE)', indemnity_expiry: '2027-06-30'
      },
      expected: {
        pathway: 'au_vr', basis: 'australia', segment: 'A', isAu: true, launched: true,
        confirmed: true, needsStaffReview: false,
        dpaRestricted: false, dpaRestrictedReason: 'staff_confirmed_19ab_not_applicable'
      }
    };
  },
  au_restricted: function () {
    return {
      profile: {
        registration_country: 'United Kingdom', qualification_country: 'GB', preferred_city: 'Perth',
        candidate_pathway: 'au_restricted', candidate_basis: 'australia',
        pathway_set_by: STAFF_EMAIL, pathway_set_at: FIXED_NOW,
        pathway_confirmed_at: FIXED_NOW, pathway_confirmed_by: STAFF_EMAIL,
        current_suburb: 'Test Town', current_state: 'WA', current_postcode: '6000', timezone: 'Australia/Perth'
      },
      credentials: {
        ahpra_number: 'MED0001000002', ahpra_registration_type: 'general_and_specialist', specialist_gp: true,
        registration_expiry: '2027-09-30', fellowship_type: 'fracgp', fellowship_year: 2022, vr_status: 'vr',
        moratorium_19ab_status: 'yes', moratorium_19ab_end_date: '2031-03-01',
        moratorium_19ab_confirmed_status: 'yes', moratorium_19ab_confirmed_by: STAFF_EMAIL, moratorium_19ab_confirmed_at: FIXED_NOW,
        work_rights: 'visa', visa_subclass: '482', visa_expiry: '2028-01-31',
        visa_sponsor_tied: true, visa_sponsor_name: 'Test Regional Practice (FAKE)', supervision_level: 'none'
      },
      expected: {
        pathway: 'au_restricted', basis: 'australia', segment: 'B', isAu: true, launched: false,
        confirmed: true, needsStaffReview: true,
        dpaRestricted: true, dpaRestrictedReason: 'staff_confirmed_19ab_applies'
      }
    };
  },
  au_non_vr: function () {
    return {
      profile: {
        registration_country: 'Australia', qualification_country: 'AU', preferred_city: 'Brisbane',
        candidate_pathway: 'au_non_vr', candidate_basis: 'australia',
        pathway_set_by: 'self', pathway_set_at: FIXED_NOW,
        current_suburb: 'Test Heights', current_state: 'QLD', current_postcode: '4000', timezone: 'Australia/Brisbane'
      },
      credentials: {
        ahpra_number: 'MED0001000003', ahpra_registration_type: 'general', specialist_gp: false,
        registration_expiry: '2027-09-30', fellowship_type: 'none', vr_status: 'non_vr',
        moratorium_19ab_status: 'unsure', work_rights: 'pr', supervision_level: 'none'
      },
      expected: {
        pathway: 'au_non_vr', basis: 'australia', segment: 'C', isAu: true, launched: false,
        confirmed: false, needsStaffReview: true,
        dpaRestricted: true, dpaRestrictedReason: '19ab_unknown'
      }
    };
  },
  au_registrar: function () {
    return {
      profile: {
        registration_country: 'Australia', qualification_country: 'AU', preferred_city: 'Adelaide',
        candidate_pathway: 'au_registrar', candidate_basis: 'australia',
        pathway_set_by: 'self', pathway_set_at: FIXED_NOW,
        current_suburb: 'Test Park', current_state: 'SA', current_postcode: '5000', timezone: 'Australia/Adelaide'
      },
      credentials: {
        ahpra_number: 'MED0001000004', ahpra_registration_type: 'general', specialist_gp: false,
        registration_expiry: '2027-09-30', fellowship_type: 'none', vr_status: 'non_vr',
        moratorium_19ab_status: 'no', work_rights: 'citizen', supervision_level: 'level_2'
      },
      expected: {
        pathway: 'au_registrar', basis: 'australia', segment: 'C', isAu: true, launched: false,
        confirmed: false, needsStaffReview: true,
        dpaRestricted: true, dpaRestrictedReason: 'self_declared_no_awaiting_staff_confirmation'
      }
    };
  },
  overseas_null: function () {
    return {
      profile: {
        registration_country: 'United Kingdom', qualification_country: 'GB', preferred_city: 'Melbourne',
        target_arrival_date: '2027-03', who_moving: 'Just me', children_count: '0',
        gmc_number: '7000001', register_body: 'gmc', register_number: '7000001', register_status: 'verified'
      },
      credentials: null,
      expected: {
        pathway: 'overseas_esp', basis: 'overseas', segment: 'overseas', isAu: false, launched: true,
        confirmed: false, needsStaffReview: false, recorded: false
      }
    };
  },
  overseas_explicit: function () {
    return {
      profile: {
        registration_country: 'Ireland', qualification_country: 'IE', preferred_city: 'Sydney',
        target_arrival_date: '2027-05', who_moving: 'Partner', children_count: '0',
        candidate_pathway: 'overseas_esp', candidate_basis: 'overseas',
        pathway_set_by: STAFF_EMAIL, pathway_set_at: FIXED_NOW,
        pathway_confirmed_at: FIXED_NOW, pathway_confirmed_by: STAFF_EMAIL
      },
      credentials: null,
      expected: {
        pathway: 'overseas_esp', basis: 'overseas', segment: 'overseas', isAu: false, launched: true,
        confirmed: true, needsStaffReview: false, recorded: true
      }
    };
  }
};

/**
 * Build one standard doctor.
 * @param {string} kind  one of AU_DOCTOR_KINDS
 * @param {object} [overrides]
 * @param {object} [overrides.profile]      merged over the user_profiles row
 * @param {object|null} [overrides.credentials]  merged over the gp_credentials row
 *        (null removes the row; an object on an overseas doctor creates one)
 * @param {object} [overrides.caseRow]      merged over the registration_cases row
 * @param {object} [overrides.state]        merged over the user_state.state blob
 * @param {boolean} [overrides.selfDeclared] clear the staff confirmation of the pathway
 * @param {boolean} [overrides.noCase]      the doctor has no registration case
 * @param {string} [overrides.idSuffix]     make a second, distinct copy of a kind
 */
function buildAuDoctor(kind, overrides) {
  if (AU_DOCTOR_KINDS.indexOf(kind) === -1) throw new Error('Unknown AU fixture kind: ' + kind);
  const o = overrides || {};
  const who = Object.assign({}, IDS[kind]);
  if (o.idSuffix) {
    who.n = who.n + String(o.idSuffix);
    who.email = who.email.replace('@', '.' + String(o.idSuffix) + '@');
  }
  const userId = fakeUuid('', who.n);
  const caseId = fakeUuid('c', who.n);
  const shape = KIND_SHAPES[kind]();

  const profile = Object.assign(baseProfile(userId, who), shape.profile, o.profile || {});
  if (o.selfDeclared) {
    profile.pathway_set_by = 'self';
    profile.pathway_confirmed_at = null;
    profile.pathway_confirmed_by = null;
  }

  let credentials = shape.credentials ? Object.assign(baseCredentials(userId), shape.credentials) : null;
  if (o.credentials === null) credentials = null;
  else if (o.credentials && typeof o.credentials === 'object') {
    credentials = Object.assign(credentials || baseCredentials(userId), o.credentials);
  }

  const caseRow = o.noCase ? null : Object.assign(baseCase(caseId, userId), { pathway: profile.candidate_pathway },
    AU_FIXTURE_PATHWAYS.indexOf(profile.candidate_pathway) !== -1 ? { stage: 'placement' } : {}, o.caseRow || {});

  const isAuCountry = /^(au|australia)$/i.test(String(profile.qualification_country || ''));
  const state = {
    user_id: userId,
    state: Object.assign({
      gp_onboarding_complete: true,
      gp_selected_country: profile.registration_country,
      gp_onboarding: isAuCountry
        ? { country: profile.qualification_country, completedAt: '2026-10-02T00:00:00.000Z', step: 5, preferredCity: profile.preferred_city }
        : { country: profile.qualification_country, completedAt: '2026-10-02T00:00:00.000Z', step: 5, preferredCity: profile.preferred_city,
          targetDate: profile.target_arrival_date, whoMoving: profile.who_moving, childrenCount: profile.children_count }
    }, o.state || {}),
    updated_at: '2026-10-02T00:00:00.000Z'
  };

  return {
    kind,
    userId,
    caseId: caseRow ? caseRow.id : null,
    email: who.email,
    name: 'Dr ' + who.first + ' ' + who.last,
    profile,
    credentials,
    caseRow,
    state,
    expected: shape.expected
  };
}

/** All six standard doctors, keyed by kind. */
function buildAllAuDoctors() {
  const out = {};
  AU_DOCTOR_KINDS.forEach(function (k) { out[k] = buildAuDoctor(k); });
  return out;
}

/**
 * Tables for a PostgREST emulator (tests/helpers/au-supabase-emulator.js),
 * from a list of doctors: { user_profiles, gp_credentials, registration_cases, user_state }.
 */
function buildAuFixtureDb(doctors) {
  const list = Array.isArray(doctors) ? doctors : Object.keys(doctors || {}).map(function (k) { return doctors[k]; });
  return {
    user_profiles: list.map(function (d) { return Object.assign({}, d.profile); }),
    gp_credentials: list.filter(function (d) { return d.credentials; }).map(function (d) { return Object.assign({}, d.credentials); }),
    registration_cases: list.filter(function (d) { return d.caseRow; }).map(function (d) { return Object.assign({}, d.caseRow); }),
    user_state: list.map(function (d) { return JSON.parse(JSON.stringify(d.state)); })
  };
}

/**
 * The same doctors for LOCAL JSON mode (DB_FILE_PATH), where rows are keyed by
 * lowercased email: { users, userProfiles, userState, gpCredentials }. Local
 * mode has no registration_cases store.
 */
function buildAuLocalDb(doctors) {
  const list = Array.isArray(doctors) ? doctors : Object.keys(doctors || {}).map(function (k) { return doctors[k]; });
  const out = { users: {}, userProfiles: {}, userState: {}, gpCredentials: {} };
  list.forEach(function (d) {
    const key = d.email.toLowerCase();
    out.users[key] = {
      email: key, firstName: d.profile.first_name, lastName: d.profile.last_name,
      registrationCountry: d.profile.registration_country,
      createdAt: d.profile.created_at, updatedAt: d.profile.updated_at
    };
    out.userProfiles[key] = {
      firstName: d.profile.first_name, lastName: d.profile.last_name, email: key, phone: d.profile.phone,
      qualification_country: d.profile.qualification_country, preferred_city: d.profile.preferred_city,
      candidate_pathway: d.profile.candidate_pathway, candidate_basis: d.profile.candidate_basis,
      pathway_set_by: d.profile.pathway_set_by, pathway_set_at: d.profile.pathway_set_at,
      pathway_confirmed_at: d.profile.pathway_confirmed_at, pathway_confirmed_by: d.profile.pathway_confirmed_by
    };
    out.userState[key] = { state: JSON.parse(JSON.stringify(d.state.state)), updatedAt: d.state.updated_at };
    if (d.credentials) out.gpCredentials[key] = Object.assign({}, d.credentials, { user_id: key });
  });
  return out;
}

// Every column, table and constraint name WP-02 adds. A switch-off request
// must never mention any of these (tests/au-wp02-switch-off-no-new-queries.test.js).
const WP02_NEW_COLUMN_NAMES = Object.freeze([
  'candidate_pathway', 'candidate_basis', 'pathway_set_by', 'pathway_set_at',
  'pathway_confirmed_at', 'pathway_confirmed_by',
  'current_suburb', 'current_state', 'current_postcode', 'current_latitude', 'current_longitude',
  'commute_radius_km', 'notice_period_weeks', 'available_from', 'sessions_wanted',
  'billing_preference', 'special_interests', 'open_to_locum', 'open_to_relocate', 'timezone'
]);
const WP02_NEW_TABLES = Object.freeze(['gp_credentials']);

// WP-03 adds no column or table: it widens two CHECK constraints so these
// stage VALUES are allowed. Until that migration is applied the live database
// rejects them, so with the switch off the server must never write one.
// ('placement' has always been a legal value of user_state override keys and
// of registration_tasks.related_stage, so the rule below only looks at the
// two constrained columns.)
const WP03_NEW_STAGE_VALUES = Object.freeze(['placement', 'prestart', 'commenced', 'guarantee']);

/**
 * The switch-off rule for WP-03: a reason when a request WRITES an Australian
 * stage value into registration_cases.stage or scheduled_calls.stage, or
 * filters on one; otherwise ''. Combine with wp02NewNameViolation.
 */
function wp03NewStageViolation(request) {
  if (!request || (request.table !== 'registration_cases' && request.table !== 'scheduled_calls')) return '';
  const rows = Array.isArray(request.body) ? request.body : (request.body && typeof request.body === 'object' ? [request.body] : []);
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i] && rows[i].stage;
    if (typeof v === 'string' && WP03_NEW_STAGE_VALUES.indexOf(v) !== -1) return request.table + '.stage = ' + v;
  }
  const m = String(request.query || '').match(/[?&]stage=(?:eq|in)\.\(?([^&]*)/);
  if (m) {
    const hit = WP03_NEW_STAGE_VALUES.filter(function (v) { return new RegExp('(^|[(,"])' + v + '([),"]|$)').test(m[1]); })[0];
    if (hit) return request.table + ' filtered on stage ' + hit;
  }
  return '';
}

module.exports = {
  AU_DOCTOR_KINDS,
  FIXED_NOW,
  STAFF_EMAIL,
  WP02_NEW_COLUMN_NAMES,
  WP02_NEW_TABLES,
  WP03_NEW_STAGE_VALUES,
  wp03NewStageViolation,
  fakeUuid,
  buildAuDoctor,
  buildAllAuDoctors,
  buildAuFixtureDb,
  buildAuLocalDb
};

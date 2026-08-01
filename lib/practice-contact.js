'use strict';

/**
 * Pure helpers for resolving a placed GP's practice contact — the address every
 * "email the practice" composer puts in the To field, and the name its greeting uses.
 *
 * Two traps this exists to close, both seen live on Dr Mercy Obanimoh's case:
 *
 *  1. "Placed" is not one status. The normal offer flow lands a gp_applications row on
 *     status='hired', but a placement written straight to the database carries
 *     status='placement_secured' with ats_stage='hired'. Every lookup filtered on
 *     status='hired' alone, so those rows were invisible and the To came back blank.
 *
 *  2. practice_contact_email / practice_contact_name are only populated by the offer
 *     flow. A hand-created placement leaves them NULL even though the linked practices
 *     row holds a perfectly good contact — which no composer ever read.
 *
 * No external dependencies, safe to require from anywhere.
 */

// PostgREST filter fragment for "this application represents a placement". ats_stage is
// the reliable signal; status varies by how the placement was created. Callers AND this
// together with their own user_id filter.
const PLACED_APPLICATION_FILTER = 'or=(status.eq.hired,ats_stage.eq.hired)';

// Columns every placed-application lookup needs to resolve a contact, including the two
// routes to a practices row (the application's own practice_id, else the career role's).
const PLACED_APPLICATION_COLUMNS = 'user_id,career_role_id,practice_id,practice_contact_name,practice_contact_email,status,ats_stage';

function trimmed(value) {
  return String(value == null ? '' : value).trim();
}

/** True when the row already carries a usable practice address. */
function hasContactEmail(row) {
  return !!(row && trimmed(row.practice_contact_email));
}

/**
 * Which practice should supply the fallback contact for this application.
 * The application's own practice_id wins; career roles are the backstop for older rows
 * that predate the column.
 *
 * @param {object} row - a gp_applications row
 * @param {object} rolePracticeById - { [career_role_id]: practice_id }
 * @returns {string} practice id, or '' when there is nothing to look up
 */
function practiceIdForRow(row, rolePracticeById) {
  if (!row) return '';
  const own = trimmed(row.practice_id);
  if (own) return own;
  const roleId = row.career_role_id;
  if (roleId == null) return '';
  return trimmed((rolePracticeById || {})[roleId]);
}

/**
 * Fill blank contact columns from the linked practices row. Mutates and returns `rows`
 * so callers can keep passing the same array around; rows that already have an email are
 * left alone (the application's own contact always wins over the practice default).
 *
 * @param {Array<object>} rows - gp_applications rows
 * @param {object} practiceById - { [practice_id]: { contact_name, contact_email } }
 * @param {object} rolePracticeById - { [career_role_id]: practice_id }
 * @returns {Array<object>} the same rows, hydrated
 */
function applyPracticeContactFallback(rows, practiceById, rolePracticeById) {
  const list = Array.isArray(rows) ? rows : [];
  list.forEach(function (row) {
    if (hasContactEmail(row)) return;
    const practice = (practiceById || {})[practiceIdForRow(row, rolePracticeById)];
    const email = trimmed(practice && practice.contact_email);
    if (!email) return;
    row.practice_contact_email = email;
    if (!trimmed(row.practice_contact_name)) {
      row.practice_contact_name = trimmed(practice.contact_name);
    }
  });
  return list;
}

/**
 * Pick the row to trust when a GP somehow has more than one placed application.
 * A row with a real address beats one without — otherwise an empty duplicate could
 * shadow the placement that actually has a contact.
 */
function pickPlacedApplication(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.find(hasContactEmail) || list[0] || null;
}

/**
 * Collapse a placed application row into the { email, name } shape the composers want.
 * Returns null when there is no usable address, so callers can fall through to their own
 * next source instead of rendering an empty To.
 */
function toPracticeContact(row) {
  const email = trimmed(row && row.practice_contact_email);
  if (!email) return null;
  return { email: email, name: trimmed(row && row.practice_contact_name) };
}

/** Which practice ids a batch of rows still needs looked up (blank-contact rows only). */
function pendingPracticeIds(rows, rolePracticeById) {
  const seen = [];
  (Array.isArray(rows) ? rows : []).forEach(function (row) {
    if (hasContactEmail(row)) return;
    const id = practiceIdForRow(row, rolePracticeById);
    if (id && seen.indexOf(id) === -1) seen.push(id);
  });
  return seen;
}

/** Which career roles must be resolved to a practice before the fallback can run. */
function pendingRoleIds(rows) {
  const seen = [];
  (Array.isArray(rows) ? rows : []).forEach(function (row) {
    if (hasContactEmail(row) || trimmed(row && row.practice_id)) return;
    const roleId = row && row.career_role_id;
    if (roleId == null || roleId === '') return;
    if (seen.indexOf(roleId) === -1) seen.push(roleId);
  });
  return seen;
}

/**
 * Collapse a placed application (+ its career role and practice rows) into the display
 * shape the dashboards and the AI summary use for "where is this GP placed".
 *
 * WHY: the placement is ALSO mirrored into user_state.gp_career_state.applications[].placement,
 * and that mirror can be stale or simply wrong — a hand-created account can carry another
 * GP's placement block entirely (seen live: Dr Mercy Obanimoh's career state held Sana
 * Ahsan's Halekulani Medical Centre placement, complete with the other practice's contact
 * email, while her real application pointed at The Doctors Werribee). Anything that reads
 * the mirror first will report the wrong practice. This builds the same shape from the
 * OWNED rows instead, so callers can prefer it and treat the mirror as a last resort.
 *
 * @param {object} app       gp_applications row (already contact-hydrated)
 * @param {object} [role]    career_roles row { practice_name, title, location_city, location_state }
 * @param {object} [practice] practices row { name, contact_name, contact_email }
 * @returns {object|null} display profile, or null when there is nothing worth showing
 */
function buildPlacementProfile(app, role, practice) {
  if (!app) return null;
  const practiceName = trimmed(practice && practice.name)
    || trimmed(role && role.practice_name);
  const contactEmail = trimmed(app.practice_contact_email) || trimmed(practice && practice.contact_email);
  const contactName = trimmed(app.practice_contact_name) || trimmed(practice && practice.contact_name);
  const location = [trimmed(role && role.location_city), trimmed(role && role.location_state)]
    .filter(Boolean).join(', ');
  // Nothing identifying at all — let the caller fall through rather than render blanks.
  if (!practiceName && !contactEmail) return null;
  return {
    practiceName: practiceName,
    contactName: contactName,
    contactEmail: contactEmail,
    contactPhone: trimmed(practice && practice.contact_phone),
    roleTitle: trimmed(role && role.title),
    location: location,
  };
}

/**
 * The same display shape, read out of the user_state.gp_career_state mirror.
 * Only for use as a LAST resort — see mergePlacementSources.
 */
function placementFromCareerStateMirror(careerState) {
  const state = (careerState && typeof careerState === 'object') ? careerState : {};
  const apps = Array.isArray(state.applications) ? state.applications : [];
  const secured = apps.find(function (a) { return a && a.isPlacementSecured === true; });
  const placement = secured && secured.placement;
  if (!placement) return null;
  const pc = placement.practiceContact || {};
  const profile = {
    practiceName: trimmed(placement.practiceName),
    contactName: trimmed(pc.name),
    contactEmail: trimmed(pc.email),
    contactPhone: trimmed(pc.phone),
    roleTitle: trimmed(placement.roleTitle),
    location: trimmed(placement.location),
  };
  if (!profile.practiceName && !profile.contactEmail) return null;
  return profile;
}

/**
 * Choose between the authoritative placement and the career-state mirror.
 *
 * ALL-OR-NOTHING on purpose. The mirror can describe an entirely DIFFERENT practice (a
 * hand-created account carrying another GP's placement block), so merging field by field
 * would splice one practice's phone or contact name onto another practice's name — which is
 * worse than either source alone. If the owned rows can answer, they answer by themselves.
 */
function mergePlacementSources(authoritative, mirror) {
  if (authoritative) return authoritative;
  return mirror || null;
}

module.exports = {
  PLACED_APPLICATION_FILTER,
  PLACED_APPLICATION_COLUMNS,
  hasContactEmail,
  practiceIdForRow,
  applyPracticeContactFallback,
  pickPlacedApplication,
  toPracticeContact,
  buildPlacementProfile,
  placementFromCareerStateMirror,
  mergePlacementSources,
  pendingPracticeIds,
  pendingRoleIds
};

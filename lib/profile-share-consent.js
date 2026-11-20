'use strict';
/**
 * WP-09 (WEB-19): a doctor's consent to have their profile sent to ONE
 * practice for ONE role. Pure module, no I/O.
 *
 * Australian pathways only, and only with the AU switch on. An overseas
 * doctor's flow does not read or write any of this.
 *
 * The wording is a DRAFT for legal review (the WP-25 consent proposal,
 * section C; docs/au-gp/CONVENTIONS.md section 20 says where it is kept, and
 * it is only ever shown with the AU switch on to a doctor on an Australian
 * pathway). It deliberately does NOT say the Ahpra
 * registration number is sent, because it is not (owner decision pending:
 * OWNER-ACTIONS item 17B). If the wording changes, change CONSENT_VERSION:
 * the version is stored with every consent so we can always say which words a
 * doctor agreed to.
 *
 * Where it is stored: five nullable columns on gp_applications
 * (20261120140000_au_gp_wp09_profile_share_consent.sql). One application row
 * is one doctor and one role, so the consent sits on the row it covers, with
 * the role id repeated so a row that is later re-pointed can never carry an
 * old consent to a different practice.
 */

const CONSENT_VERSION = 'au-share-consent-draft-2026-11-20';

const CONSENT_SOURCE = Object.freeze({
  DOCTOR: 'doctor',            // the doctor ticked the box on the apply sheet
  STAFF_VERBAL: 'staff_verbal' // staff recorded a consent the doctor gave by phone or message
});

const CONSENT_COLUMNS = Object.freeze([
  'profile_share_consent_at',
  'profile_share_consent_version',
  'profile_share_consent_source',
  'profile_share_consent_by',
  'profile_share_consent_role_id'
]);

const CODE = Object.freeze({
  DOCTOR_REQUIRED: 'consent_required',
  STAFF_REQUIRED: 'profile_share_consent_required'
});

function clean(v) { return String(v == null ? '' : v).trim(); }

/** What exactly is sent to the practice. One list, used on every screen. */
const WHAT_IS_SENT = 'your name, your CV and a short professional summary';

/**
 * The confirmation sheet shown to the doctor before they are put forward.
 * `practiceName` is required: a doctor cannot agree to be sent to a practice
 * they cannot see the name of. Returns null without one.
 */
function doctorConsentSheet(opts) {
  const o = opts || {};
  const practice = clean(o.practiceName);
  if (!practice) return null;
  return {
    version: CONSENT_VERSION,
    draft: true,
    practiceName: practice,
    title: 'Put me forward to ' + practice + '?',
    body: 'We’ll send ' + practice + ' ' + WHAT_IS_SENT + '. Nothing else, and nobody else.',
    tickLabel: 'I agree to GP Link sending my details to ' + practice + ' for this role.',
    footnote: 'We never contact your current practice. Tell us if there is anyone at ' + practice + ' who should not know yet.'
  };
}

/**
 * Read the doctor's consent out of an apply / accept request body:
 *   { shareConsent: { agreed: true, version: '<CONSENT_VERSION>' } }
 * `ok` only for an explicit true against the CURRENT wording.
 */
function parseDoctorConsent(body) {
  const c = body && typeof body === 'object' && body.shareConsent && typeof body.shareConsent === 'object' ? body.shareConsent : null;
  if (!c) return { ok: false, reason: 'missing' };
  if (c.agreed !== true) return { ok: false, reason: 'not_agreed' };
  if (clean(c.version) !== CONSENT_VERSION) return { ok: false, reason: 'stale_version' };
  return { ok: true, version: CONSENT_VERSION };
}

/** The role a consent covers: the application's own role, as text. */
function roleKeyOf(applicationRow) {
  const a = applicationRow && typeof applicationRow === 'object' ? applicationRow : {};
  return clean(a.career_role_id) || clean(a.provider_role_id);
}

/**
 * The columns to write for a consent.
 * @param {object} opts
 * @param {'doctor'|'staff_verbal'} opts.source
 * @param {object} opts.application  the gp_applications row the consent covers
 * @param {string} [opts.by]         staff email (staff_verbal) or 'self'
 * @param {string} [opts.now]        ISO timestamp
 */
function buildConsentPatch(opts) {
  const o = opts || {};
  const source = o.source === CONSENT_SOURCE.STAFF_VERBAL ? CONSENT_SOURCE.STAFF_VERBAL : CONSENT_SOURCE.DOCTOR;
  const roleKey = roleKeyOf(o.application);
  if (!roleKey) return null;
  const by = source === CONSENT_SOURCE.STAFF_VERBAL ? clean(o.by) : 'self';
  if (!by) return null;
  return {
    profile_share_consent_at: clean(o.now) || new Date().toISOString(),
    profile_share_consent_version: CONSENT_VERSION,
    profile_share_consent_source: source,
    profile_share_consent_by: by.slice(0, 200),
    profile_share_consent_role_id: roleKey
  };
}

/**
 * Is there a consent on file for THIS application's role?
 * @returns {{ ok: boolean, reason: string, at?: string, source?: string, version?: string }}
 */
function consentOnFile(applicationRow) {
  const a = applicationRow && typeof applicationRow === 'object' ? applicationRow : {};
  const at = clean(a.profile_share_consent_at);
  if (!at) return { ok: false, reason: 'none' };
  if (!clean(a.profile_share_consent_version)) return { ok: false, reason: 'no_version' };
  const source = clean(a.profile_share_consent_source);
  if (source !== CONSENT_SOURCE.DOCTOR && source !== CONSENT_SOURCE.STAFF_VERBAL) return { ok: false, reason: 'no_source' };
  const roleKey = roleKeyOf(a);
  if (!roleKey || clean(a.profile_share_consent_role_id) !== roleKey) return { ok: false, reason: 'different_role' };
  return { ok: true, reason: 'on_file', at, source, version: clean(a.profile_share_consent_version) };
}

const DOCTOR_REQUIRED_MESSAGE = 'Please tick the box to agree to your details being sent to this practice.';
const STAFF_REQUIRED_MESSAGE = 'This doctor has not agreed to be put forward to this practice yet, so nothing was sent. '
  + 'Ask them to apply from the role page, or record their verbal consent.';
const STAFF_VERBAL_PROMPT = 'Has the doctor told you they agree to GP Link sending this practice ' + WHAT_IS_SENT
  + ' for this role? If so, note how and when they agreed (for example "By phone, 20 Nov"). This is recorded against your name.';

/** The note staff must give with a verbal consent: 5 to 300 characters. */
function cleanVerbalNote(note) {
  const s = clean(note).replace(/\s+/g, ' ');
  if (s.length < 5) return '';
  return s.slice(0, 300);
}

module.exports = {
  CONSENT_VERSION, CONSENT_SOURCE, CONSENT_COLUMNS, CODE, WHAT_IS_SENT,
  DOCTOR_REQUIRED_MESSAGE, STAFF_REQUIRED_MESSAGE, STAFF_VERBAL_PROMPT,
  doctorConsentSheet, parseDoctorConsent, buildConsentPatch, consentOnFile, roleKeyOf, cleanVerbalNote
};

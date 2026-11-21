'use strict';

/**
 * "Is this an Australian-segment lead?" — the ONE place that question is
 * answered for the lead funnel (site_enquiries rows of kind 'gp').
 *
 * Why it exists (WP-01 of the Australian GP build, docs/au-gp/review-report.md):
 * the funnel admits a lead whose training country is Australia, and then treats
 * them like a UK doctor moving country: Hazel rings with the UK script, and the
 * chase emails and WhatsApps talk about visas and "your move". Until Australian
 * copy exists those messages are held back and only the owner is told.
 *
 * Three questions, kept separate on purpose so later packages can change one
 * without touching the others:
 *
 *   isAuSegmentLead(lead)     the fact. WP-15: the segment recorded on the
 *                             lead (consult.segment, set from the doctor's own
 *                             answer to "Are you currently registered with
 *                             Ahpra?") when there is one; a lead with no
 *                             segment recorded (every row stored before WP-15,
 *                             and a lead form that does not ask) is judged as
 *                             before: consult.country === 'au'.
 *   auHazelBlocked(lead)      PERMANENT (owner decision 7): Hazel never rings
 *                             an Australian-segment lead. WP-19 writes an AU
 *                             script as a file only; this stays.
 *   auMessagesHeld(lead)      INTERIM: automated emails and WhatsApps to the
 *                             lead are held until WP-16 ships Australian copy.
 *                             WP-16 replaces the call sites of this one.
 *
 * The message hold (auMessagesHeld) sits behind the single AU_PATHWAY_ENABLED
 * switch (lib/au-pathway-flag.js): with the switch off it always answers
 * false, so an Australian lead is emailed exactly as before. Callers that are
 * pure functions pass the switch in as `opts.auPathwayEnabled` so tests can
 * exercise both states; when it is not passed, the switch is read at call time.
 *
 * The Hazel block (auHazelBlocked) does NOT look at the switch (WP-04, on the
 * lead's instruction): Hazel never rings an Australian-segment lead, switch on
 * or off. This is the one deliberate exception to "switch off = identical to
 * main" (docs/au-gp/CONVENTIONS.md section 2). In production today no
 * Australian from-number is configured, so nothing a lead experiences
 * changes; the block protects against the UK script ringing Australian leads
 * if a number is ever added.
 *
 * `lead` may be a site_enquiries row ({ metadata: { consult } }) or the consult
 * object itself.
 */

const { isAuPathwayEnabled } = require('./au-pathway-flag.js');

// The skip reason leadCallDecision returns, and the Leads tab explains.
const AU_NO_CALL_REASON = 'au_segment';
// The reason recorded when a message to the lead is held back.
const AU_MESSAGES_HELD_REASON = 'au_segment';

function consultOf(lead) {
  if (!lead || typeof lead !== 'object') return null;
  // A row carries metadata (and kind); anything else is taken as the consult.
  if (Object.prototype.hasOwnProperty.call(lead, 'metadata') || Object.prototype.hasOwnProperty.call(lead, 'kind')) {
    const c = lead.metadata && lead.metadata.consult;
    return (c && typeof c === 'object') ? c : null;
  }
  return lead;
}

// ── WP-15: the segment recorded on a lead ─────────────────────────────────
//
// Everything below lives in site_enquiries.metadata.consult (no column, no
// migration). Every value is one of a fixed set: a raw string from a browser
// or from a Meta form is never stored.
//
//   segment           'overseas' | 'au_vr' | 'au_restricted' | 'au_non_vr'
//                     | 'au_registrar' | 'au_unknown'
//                     ('au_unknown': an Australian-segment lead whose detail is
//                     not known yet.) What the DOCTOR said about themselves. It
//                     is a tag for copy, reporting and the Hazel block. It is
//                     never a pathway: user_profiles.candidate_pathway is only
//                     set by onboarding or by staff.
//   ahpra_registered  true | false | null (not asked)
//   location_country  'au' | 'uk' | 'ie' | 'nz' | 'other' | null: where they
//                     are NOW. Distinct from consult.country, which is where
//                     they TRAINED (and site_enquiries.state, which has always
//                     held that training country too).
//   state             'NSW' ... 'NT' (WP-10 owns the validation and the time zone)
//   vr_status         'yes' | 'no' | 'registrar' | 'unsure' | null
//   restriction_19ab  'yes' | 'no' | 'unsure' | null
//   visa_status       'citizen_pr' | 'temporary' | 'unsure' | null (right to work)
//   consent           { wording_version, shown_at, ai_call: 'not_asked' }
const LEAD_SEGMENTS = ['overseas', 'au_vr', 'au_restricted', 'au_non_vr', 'au_registrar', 'au_unknown'];
const LEAD_VR_STATUSES = ['yes', 'no', 'registrar', 'unsure'];
const LEAD_19AB_ANSWERS = ['yes', 'no', 'unsure'];
const LEAD_VISA_STATUSES = ['citizen_pr', 'temporary', 'unsure'];
const LEAD_LOCATION_COUNTRIES = ['au', 'uk', 'ie', 'nz', 'other'];
// "I am outside Australia at the moment": a first-class answer to the state
// question. No state is stored and location_country is not 'au'.
const LEAD_STATE_OUTSIDE = 'outside';
// The wording shown under the form's button. 'overseas_v0' is the line the page
// has always carried ("We'll only contact you about your enquiry."); the
// Australian one is the DRAFT in docs/au-gp/legal-draft/consent-wording.md A1
// (not legally reviewed). A new wording gets a new key: never edit one in place.
const LEAD_CONSENT_VERSIONS = {
  overseas_v0: { audience: 'overseas' },
  au_a1_draft_2026_11: { audience: 'au' }
};
// Keys that only an Ahpra-registered lead answers. Cleared when the same
// person re-submits and says "No".
const AU_ONLY_LEAD_KEYS = ['vr_status', 'restriction_19ab', 'visa_status', 'location_country'];

const SEGMENT_LABELS = {
  overseas: 'Overseas pathway',
  au_vr: 'Australian GP: vocationally registered',
  au_restricted: 'Australian GP: restricted (19AB or temporary right to work)',
  au_non_vr: 'Australian GP: not vocationally registered',
  au_registrar: 'Australian GP: registrar',
  au_unknown: 'Australian GP: details to confirm'
};
const SEGMENT_SHORT_LABELS = {
  overseas: 'Overseas', au_vr: 'AU · VR', au_restricted: 'AU · restricted', au_non_vr: 'AU · non-VR',
  au_registrar: 'AU · registrar', au_unknown: 'AU · to confirm'
};
const VR_LABELS = { yes: 'Yes (FRACGP / FACRRM)', no: 'No', registrar: 'GP registrar', unsure: 'Not sure' };
const AB19_LABELS = { yes: 'Applies', no: 'Does not apply', unsure: 'Not sure' };
const VISA_LABELS = { citizen_pr: 'Citizen or permanent resident', temporary: 'Temporary right to work', unsure: 'Not sure' };

function pick(list, value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return list.indexOf(v) === -1 ? null : v;
}

// The segment recorded on the lead, or '' when none (or junk) is recorded.
function recordedLeadSegment(lead) {
  const consult = consultOf(lead);
  if (!consult) return '';
  const s = String(consult.segment == null ? '' : consult.segment).trim().toLowerCase();
  if (s === 'overseas' || s.indexOf('au_') === 0) return s;
  return '';
}

function isAuSegmentLead(lead) {
  const consult = consultOf(lead);
  if (!consult) return false;
  // WP-15: what the doctor told us wins. `segment` is only ever written from an
  // explicit answer (deriveLeadSegment), never from a phone number.
  const recorded = recordedLeadSegment(consult);
  if (recorded) return recorded.indexOf('au_') === 0;
  // Nothing recorded: every row stored before WP-15, and a lead form that does
  // not ask. Judged exactly as before.
  return String(consult.country == null ? '' : consult.country).trim().toLowerCase() === 'au';
}

/**
 * THE rule for a lead's segment. Pure. Explicit answers only.
 *
 * The phone number is not an input, on purpose (COM-15). A +61 number says
 * where a SIM was bought, not who regulates the doctor: a UK-trained GP on an
 * Australian number who is not registered here is an overseas lead, and an
 * Ahpra-registered GP on a +44 number is an Australian one. The phone may still
 * corroborate the training COUNTRY for the overseas screening, exactly as it
 * always has (buildConsultLeadRow); it never sets `segment` or
 * `ahpra_registered`.
 *
 * answers: {
 *   ahpraRegistered  true | false | null    "Are you currently registered with Ahpra?"
 *   vrStatus         'yes' | 'no' | 'registrar' | 'unsure' | null
 *   restriction19ab  'yes' | 'no' | 'unsure' | null
 *   visaStatus       'citizen_pr' | 'temporary' | 'unsure' | null
 *   country          the TRAINING country they named ('uk'|'ie'|'nz'|'au'|'other'|'')
 *   auForm           true when the lead came from a Meta form configured as
 *                    Australian (FB_AU_GP_LEAD_FORM_IDS)
 * }
 * Returns a segment, or null: "nothing was asked, record nothing" (the lead is
 * then judged the way every lead was before WP-15).
 *
 * Checked in this order (the same order as the onboarding pathway rule, so the
 * two cannot disagree about who is "restricted"):
 *   said No to Ahpra, trained in Australia        au_unknown  (as before WP-15: an
 *                                                 Australian-trained lead is Australian-segment)
 *   said No to Ahpra                              overseas
 *   said Yes: 19AB applies, or a temporary right to work   au_restricted
 *   said Yes: GP registrar                        au_registrar
 *   said Yes: not vocationally registered         au_non_vr
 *   said Yes: VR + 19AB does not apply + citizen or permanent resident   au_vr
 *   said Yes: anything else (a "not sure", or an answer missing)         au_unknown
 *   not asked, Australian Meta form               au_unknown
 *   not asked                                     null
 * A "not sure" never claims the unrestricted segment and never claims the
 * restricted one: it is au_unknown until a person finds out.
 */
function deriveLeadSegment(answers) {
  const a = (answers && typeof answers === 'object') ? answers : {};
  const country = String(a.country == null ? '' : a.country).trim().toLowerCase();
  if (a.ahpraRegistered === false) return country === 'au' ? 'au_unknown' : 'overseas';
  if (a.ahpraRegistered === true) {
    const vr = pick(LEAD_VR_STATUSES, a.vrStatus);
    const ab = pick(LEAD_19AB_ANSWERS, a.restriction19ab);
    const visa = pick(LEAD_VISA_STATUSES, a.visaStatus);
    if (ab === 'yes' || visa === 'temporary') return 'au_restricted';
    if (vr === 'registrar') return 'au_registrar';
    if (vr === 'no') return 'au_non_vr';
    if (vr === 'yes' && ab === 'no' && visa === 'citizen_pr') return 'au_vr';
    return 'au_unknown';
  }
  if (a.auForm === true) return 'au_unknown';
  return null;
}

/**
 * Reads and checks the new answers on a POST /api/public/consult-lead body
 * (sent by js/site-au-lead.js). Never trusts a string from the browser: each
 * value must be one of the fixed sets above.
 *
 * Returns { ok: true, asked: false } when the body carries no answer to the
 * first question (an old cached page): the caller records nothing.
 * Returns { ok: true, asked: true, answers } or { ok: false, error }.
 */
function readLeadFormAnswers(body) {
  const raw = (body && typeof body === 'object') ? body : {};
  if (raw.ahpraRegistered == null) return { ok: true, asked: false, answers: null };
  if (typeof raw.ahpraRegistered !== 'boolean') return { ok: false, error: 'ahpraRegistered must be true or false.' };
  const consentKey = String(raw.consentVersion == null ? '' : raw.consentVersion).trim();
  const consentKnown = Object.prototype.hasOwnProperty.call(LEAD_CONSENT_VERSIONS, consentKey);
  if (consentKey && !consentKnown) return { ok: false, error: 'consentVersion is not recognised.' };
  const answers = {
    ahpraRegistered: raw.ahpraRegistered,
    state: '', stateOutside: false,
    vrStatus: null, restriction19ab: null, visaStatus: null,
    consentVersion: consentKnown ? consentKey : ''
  };
  if (raw.ahpraRegistered !== true) return { ok: true, asked: true, answers };

  // Only an Ahpra-registered doctor is asked these. A value that is present
  // must be one we offered; an absent one stays "not answered".
  const given = (v) => v != null && String(v).trim() !== '';
  if (given(raw.state)) {
    const st = String(raw.state).trim();
    if (st.toLowerCase() === LEAD_STATE_OUTSIDE) answers.stateOutside = true;
    else {
      // Required here, not at the top: lib/au-timezone.js requires this module.
      const code = require('./au-timezone.js').normaliseAuState(st);
      if (!code) return { ok: false, error: 'state is not an Australian state or territory.' };
      answers.state = code;
    }
  }
  if (given(raw.vrStatus)) {
    answers.vrStatus = pick(LEAD_VR_STATUSES, raw.vrStatus);
    if (!answers.vrStatus) return { ok: false, error: 'vrStatus must be one of: ' + LEAD_VR_STATUSES.join(', ') + '.' };
  }
  if (given(raw.restriction19ab)) {
    answers.restriction19ab = pick(LEAD_19AB_ANSWERS, raw.restriction19ab);
    if (!answers.restriction19ab) return { ok: false, error: 'restriction19ab must be one of: ' + LEAD_19AB_ANSWERS.join(', ') + '.' };
  }
  if (given(raw.rightToWork)) {
    answers.visaStatus = pick(LEAD_VISA_STATUSES, raw.rightToWork);
    if (!answers.visaStatus) return { ok: false, error: 'rightToWork must be one of: ' + LEAD_VISA_STATUSES.join(', ') + '.' };
  }
  return { ok: true, asked: true, answers };
}

/**
 * The keys to put on consult for a set of checked answers.
 * opts: { country (training, as stored), auForm, locationCountry, nowIso }.
 * Returns null when there is nothing to record.
 */
function leadFieldsFromAnswers(answers, opts) {
  const a = (answers && typeof answers === 'object') ? answers : {};
  const o = opts || {};
  const segment = deriveLeadSegment({
    ahpraRegistered: a.ahpraRegistered, vrStatus: a.vrStatus, restriction19ab: a.restriction19ab,
    visaStatus: a.visaStatus, country: o.country, auForm: o.auForm === true
  });
  if (!segment) return null;
  const fields = { segment };
  if (a.ahpraRegistered === true || a.ahpraRegistered === false) fields.ahpra_registered = a.ahpraRegistered;
  const stated = pick(LEAD_LOCATION_COUNTRIES, o.locationCountry);
  if (a.ahpraRegistered === true) {
    fields.location_country = a.state ? 'au' : (stated || (a.stateOutside ? 'other' : null));
    if (a.state) fields.state = a.state;
    fields.vr_status = pick(LEAD_VR_STATUSES, a.vrStatus);
    fields.restriction_19ab = pick(LEAD_19AB_ANSWERS, a.restriction19ab);
    fields.visa_status = pick(LEAD_VISA_STATUSES, a.visaStatus);
    fields.state_outside = a.stateOutside === true;
  } else {
    if (a.state) { fields.state = a.state; fields.location_country = 'au'; }
    else if (stated) fields.location_country = stated;
  }
  if (a.consentVersion && Object.prototype.hasOwnProperty.call(LEAD_CONSENT_VERSIONS, a.consentVersion)) {
    // What was shown, and when. No tick box is shown on this form: contact by
    // email, WhatsApp and phone is covered by the line itself, and the
    // AI-assisted-call tick is deliberately not offered (Hazel never rings an
    // Australian-segment lead), so it is recorded as not asked, never as "no".
    fields.consent = {
      wording_version: a.consentVersion,
      shown_at: o.nowIso || new Date().toISOString(),
      ai_call: 'not_asked'
    };
  }
  return fields;
}

/**
 * Writes the fields onto a consult object (mutates and returns it). A key an
 * Ahpra-registered doctor answers is REMOVED when this submission does not
 * carry it, so a person who first said "Yes" and then "No" does not keep
 * Australian answers under an overseas segment.
 */
function applyLeadFields(consult, fields) {
  if (!consult || typeof consult !== 'object' || !fields) return consult;
  const f = Object.assign({}, fields);
  const outside = f.state_outside === true;
  delete f.state_outside;
  Object.keys(f).forEach((k) => {
    if (f[k] == null) delete consult[k];
    else consult[k] = f[k];
  });
  AU_ONLY_LEAD_KEYS.forEach((k) => { if (!Object.prototype.hasOwnProperty.call(f, k)) delete consult[k]; });
  if (outside) delete consult.state;
  return consult;
}

/**
 * The segment to report for a lead: for the Leads tab, the booking row and
 * WP-24 (ads attribution / CAPI). Always one of LEAD_SEGMENTS.
 *   a segment recorded on the lead      that segment
 *   none recorded, trained in Australia au_unknown   (a row from before WP-15)
 *   anything else                       overseas     (nothing recorded reads as
 *                                       overseas, the same default the pathway uses)
 */
function leadSegmentFor(lead) {
  const recorded = recordedLeadSegment(lead);
  if (recorded) return LEAD_SEGMENTS.indexOf(recorded) === -1 ? 'au_unknown' : recorded;
  return isAuSegmentLead(lead) ? 'au_unknown' : 'overseas';
}

function leadSegmentLabel(segment, short) {
  const table = short ? SEGMENT_SHORT_LABELS : SEGMENT_LABELS;
  return table[String(segment || '')] || '';
}

// Staff-facing words for the stored answers (owner alert, Leads tab).
function leadAnswerLabels(lead) {
  const c = consultOf(lead) || {};
  return {
    vr: VR_LABELS[c.vr_status] || '',
    restriction19ab: AB19_LABELS[c.restriction_19ab] || '',
    rightToWork: VISA_LABELS[c.visa_status] || ''
  };
}

// ── WP-15: Meta lead forms ────────────────────────────────────────────────
//
// FB_GP_LEAD_FORM_IDS      forms whose leads are doctors (unchanged).
// FB_AU_GP_LEAD_FORM_IDS   forms whose leads are AUSTRALIAN-segment doctors.
//                          A lead from one is au_unknown unless its answers
//                          say more. Such a form is a doctor's form too, so it
//                          does not also need listing in FB_GP_LEAD_FORM_IDS.
// A form id in BOTH lists is a configuration error: it is treated as an
// overseas form (today's screening, no segment from the form id) and the
// caller logs it loudly.
function splitIds(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function metaFormSegmentConfig(env) {
  const e = env || process.env;
  const gp = splitIds(e.FB_GP_LEAD_FORM_IDS);
  const auListed = splitIds(e.FB_AU_GP_LEAD_FORM_IDS);
  const conflicts = auListed.filter((id) => gp.indexOf(id) !== -1);
  const au = auListed.filter((id) => gp.indexOf(id) === -1);
  return { gp, au, conflicts, allowed: gp.concat(au) };
}

// Meta sends a multiple-choice ANSWER (and the question's key) as a
// snake_cased slug: "Western Australia" arrives as western_australia. Flatten
// every non-alphanumeric run to a space before reading anything.
function flat(v) {
  return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function readYesNo(v) {
  const f = flat(v);
  if (!f) return null;
  if (/^y(es)?\b/.test(f) || f === 'true') return true;
  if (/^no?\b/.test(f) || f === 'false') return false;
  return null;
}
function readUnsure(f) {
  return /^(not sure|unsure|don t know|i don t know)\b/.test(f);
}
const META_CONTACT_KEYS = ['full_name', 'first_name', 'last_name', 'email', 'phone'];
function metaAnswer(map, hints) {
  for (const key of Object.keys(map)) {
    if (META_CONTACT_KEYS.some((k) => key.indexOf(k) !== -1)) continue;
    const fk = flat(key);
    if (hints.some((h) => fk.indexOf(h) !== -1)) return String(map[key] == null ? '' : map[key]);
  }
  return '';
}

/**
 * Reads the Australian answers from a Meta lead's field map
 * ({ lower-cased question key: answer }). Everything is read from the ANSWER,
 * slug-flattened; an answer that cannot be read is "not answered", never a
 * guess. Contact fields are never read.
 *
 * Returns { ahpraRegistered, state, stateOutside, vrStatus, restriction19ab,
 * visaStatus, locationCountry } (null / '' where the form did not say).
 */
function readMetaAuAnswers(map) {
  const m = (map && typeof map === 'object') ? map : {};
  const out = { ahpraRegistered: null, state: '', stateOutside: false, vrStatus: null, restriction19ab: null, visaStatus: null, locationCountry: null };
  const auTimezone = require('./au-timezone.js');

  out.ahpraRegistered = readYesNo(metaAnswer(m, ['ahpra']));

  const stateRaw = flat(metaAnswer(m, ['which state', 'state or territory', 'what state', 'state are you', 'your state']));
  if (stateRaw) {
    out.state = auTimezone.normaliseAuState(stateRaw) || '';
    if (!out.state && /\b(outside|not in) australia\b/.test(stateRaw)) out.stateOutside = true;
  }

  const vrRaw = flat(metaAnswer(m, ['vocationally registered', 'fracgp', 'facrrm']));
  if (vrRaw) {
    if (/\bregistrar\b/.test(vrRaw) || /\bin training\b/.test(vrRaw)) out.vrStatus = 'registrar';
    else if (readUnsure(vrRaw)) out.vrStatus = 'unsure';
    else if (readYesNo(vrRaw) === true) out.vrStatus = 'yes';
    else if (readYesNo(vrRaw) === false) out.vrStatus = 'no';
  }

  const abRaw = flat(metaAnswer(m, ['19ab', 'moratorium']));
  if (abRaw) {
    if (readUnsure(abRaw)) out.restriction19ab = 'unsure';
    else if (readYesNo(abRaw) === true) out.restriction19ab = 'yes';
    else if (readYesNo(abRaw) === false) out.restriction19ab = 'no';
  }

  const rtwRaw = flat(metaAnswer(m, ['right to work', 'work rights']));
  if (rtwRaw) {
    if (/\bcitizen\b|\bpermanent resident\b/.test(rtwRaw)) out.visaStatus = 'citizen_pr';
    else if (/\btemporary\b/.test(rtwRaw)) out.visaStatus = 'temporary';
    else if (readUnsure(rtwRaw)) out.visaStatus = 'unsure';
  }

  const whereRaw = flat(metaAnswer(m, ['where are you based', 'where are you currently', 'currently based', 'currently living', 'where do you live']));
  if (whereRaw) {
    const st = auTimezone.normaliseAuState(whereRaw);
    if (st) { if (!out.state) out.state = st; out.locationCountry = 'au'; }
    else if (/\b(outside|not in) australia\b/.test(whereRaw) || /^(somewhere else|elsewhere|other)$/.test(whereRaw)) out.locationCountry = 'other';
    else if (/\bnew zealand\b/.test(whereRaw)) out.locationCountry = 'nz';
    else if (/\baustralia\b/.test(whereRaw)) out.locationCountry = 'au';
    else if (/\bunited kingdom\b|\buk\b|\bengland\b|\bscotland\b|\bwales\b/.test(whereRaw)) out.locationCountry = 'uk';
    else if (/\bireland\b/.test(whereRaw)) out.locationCountry = 'ie';
  }
  return out;
}

// The switch, with an explicit override for pure callers and tests.
function auPathwayOn(opts) {
  if (opts && typeof opts.auPathwayEnabled === 'boolean') return opts.auPathwayEnabled;
  return isAuPathwayEnabled();
}

// PERMANENT and UNCONDITIONAL (owner decision 7; WP-04 removed the switch from
// this one). True for any Australian-segment lead, whatever AU_PATHWAY_ENABLED
// says. `opts` is accepted so existing callers keep working and is ignored.
function auHazelBlocked(lead, opts) { // eslint-disable-line no-unused-vars
  return isAuSegmentLead(lead);
}

function auMessagesHeld(lead, opts) {
  return auPathwayOn(opts) && isAuSegmentLead(lead);
}

module.exports = {
  AU_NO_CALL_REASON,
  AU_MESSAGES_HELD_REASON,
  LEAD_SEGMENTS,
  LEAD_VR_STATUSES,
  LEAD_19AB_ANSWERS,
  LEAD_VISA_STATUSES,
  LEAD_LOCATION_COUNTRIES,
  LEAD_STATE_OUTSIDE,
  LEAD_CONSENT_VERSIONS,
  recordedLeadSegment,
  deriveLeadSegment,
  readLeadFormAnswers,
  leadFieldsFromAnswers,
  applyLeadFields,
  leadSegmentFor,
  leadSegmentLabel,
  leadAnswerLabels,
  metaFormSegmentConfig,
  readMetaAuAnswers,
  isAuSegmentLead,
  auPathwayOn,
  auHazelBlocked,
  auMessagesHeld
};

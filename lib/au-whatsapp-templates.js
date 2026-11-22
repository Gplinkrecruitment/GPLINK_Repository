'use strict';
/**
 * THE one place that says which WhatsApp template each Australian message may
 * use, and whether it may be sent. Pure, no I/O. (Started by WP-09; WP-18
 * applied the review of the live templates, docs/au-gp/whatsapp-live-templates.md.)
 *
 * The build rule (AGENT-RULES section 2): an Australian message with no
 * approved template falls back to email or is skipped. It is never sent
 * through an overseas template.
 *
 * "Approved" means one of two things, and nothing else:
 *   1. the row points at an EXISTING template whose live fixed wording was
 *      read in DoubleTick and judged neutral (`source:
 *      'existing-template-confirmed-neutral'`, with the date of the read and
 *      where the wording is quoted); or
 *   2. the row points at a NEW Australian template (`gp_link_au_*`) that the
 *      owner has had approved by Meta and switched on.
 *
 * To switch a row on once its template is approved by Meta (no code change):
 *   list its key in the environment variable AU_WHATSAPP_APPROVED_TEMPLATES
 *   (comma separated), for example
 *     AU_WHATSAPP_APPROVED_TEMPLATES=lead_hello_5m,placement_secured
 * To switch a row off (for example a reused template the owner decides
 * against): list its key in AU_WHATSAPP_DISABLED_TEMPLATES. Off wins.
 *
 * The five `*_existing` rows are the owner's choice (walk-findings T3): each
 * points at an existing template that has no banned word but says "your
 * Registration Support Officer". They are OFF; listing the key turns that one
 * on for Australian doctors. The neutral Australian version of the same
 * message (the row without `_existing`) wins whenever it is approved.
 *
 * A template classed `overseas_only` below can never be used for an
 * Australian recipient, whatever a row or the environment says.
 *
 * The owner's submission sheet, docs/au-gp/whatsapp-templates.md, is generated
 * from this file and lib/au-whatsapp-submission.js.
 */

const READ = '2026-11-22';
const REF = 'docs/au-gp/whatsapp-live-templates.md section 3';
const NEUTRAL = 'existing-template-confirmed-neutral';
const RSO_WORDING = 'existing-template-rso-wording';
const NEW = 'new-australian-template';

function reused(templateName, supersedes) {
  return Object.freeze({ templateName, language: 'en', approved: true, source: NEUTRAL, confirmed: READ, ref: REF, supersedes: supersedes || '' });
}
function fresh(templateName) {
  return Object.freeze({ templateName, language: 'en', approved: false, source: NEW });
}
function ownerChoice(templateName) {
  return Object.freeze({ templateName, language: 'en', approved: false, source: RSO_WORDING, confirmed: READ, ref: REF });
}

const AU_WHATSAPP_TEMPLATES = Object.freeze({
  // Submit to practice (N10 / P02): the candidate introduction. The existing
  // templates' fixed words say nothing about the candidate; only {{3}} does,
  // and for an Australian doctor that is the Australian paragraph
  // (lib/career-intro.js buildAuCandidateIntro).
  practice_intro: reused('gp_link_practice_candidate_intro', 'gp_link_au_practice_candidate_intro'),
  // The same with the CV as a DOCUMENT header.
  practice_intro_cv: reused('gp_link_practice_candidate_intro_cv', 'gp_link_au_practice_candidate_intro_cv'),
  // WP-11, N11: "your placement is secured". {{1}} first name, {{2}} practice
  // name; a fixed button to the pre-start page (no button variable).
  placement_secured: fresh('gp_link_au_placement_secured'),
  // WP-13, N18: the first-week check-in. To the doctor: {{1}} first name,
  // {{2}} practice name. To the practice: {{1}} contact name, {{2}} the doctor.
  commencement_checkin: fresh('gp_link_au_first_week_checkin'),
  commencement_checkin_practice: fresh('gp_link_au_practice_first_week_checkin'),

  // ── WP-16: the lead and consult funnel, for an Australian-segment lead ──
  // One row per overseas consult template (lib/consult-whatsapp.js
  // CONSULT_WA_TEMPLATES): the key is 'lead_' + that kind, and the template
  // takes the SAME placeholders in the same order, so the existing message
  // builder fills it. Until a row is approved its WhatsApp is skipped (reason
  // logged and shown on the Leads tab) and the email carries the message.
  // N01, the three notes before a booking. {{1}} first name, {{2}} booking link.
  lead_hello_5m: fresh('gp_link_au_lead_hello'),
  lead_check_in_1h: fresh('gp_link_au_lead_check_in'),
  lead_day_after_24h: fresh('gp_link_au_lead_last_note'),
  // N02. Booking confirmation: {{1}} first name, {{2}} the time on their clock.
  // (The existing one invites questions about visas: not reusable.)
  lead_call_booked: fresh('gp_link_au_lead_call_booked'),
  // The day before: {{1}} first name, {{2}} the time, {{3}} join link. (The
  // existing one has the same visas sentence: not reusable.)
  lead_call_reminder: fresh('gp_link_au_lead_call_reminder'),
  // About an hour before ({{1}} first name, {{2}} clock time, {{3}} join link;
  // two quick replies the app reads) and five minutes before ({{1}}, {{2}} join
  // link): the existing templates are a time and a link, nothing else.
  lead_call_hour_before: reused('gp_link_consult_call_1h', 'gp_link_au_lead_call_1h'),
  lead_call_starting: reused('gp_link_consult_call_starting_5m', 'gp_link_au_lead_call_starting_5m'),
  // Missed call: {{1}} first name, {{2}} the link to pick a new time.
  lead_call_missed: reused('gp_link_consult_missed_call', 'gp_link_au_lead_missed_call'),
  // N03, after an attended call: {{1}} first name, {{2}} sign-up link. The
  // existing note says "about 5 minutes" and "upload your CV": the owner is
  // asked to confirm that suits the Australian sign-up (OWNER-ACTIONS); to
  // hold it back, AU_WHATSAPP_DISABLED_TEMPLATES=lead_post_call_onboard.
  lead_post_call_onboard: reused('gp_link_consult_post_call_onboard_v3', 'gp_link_au_lead_post_call'),
  // Account created: {{1}} first name. (The existing welcome says "from UK
  // practice to your first day in an Australian clinic": not reusable.)
  lead_signed_up: fresh('gp_link_au_lead_signup_welcome'),
  // Set-up not finished, a day after sign-up: {{1}} first name.
  lead_onboarding_incomplete: reused('gp_link_consult_onboarding_nudge', 'gp_link_au_lead_onboarding_nudge'),

  // ── WP-17: the lifecycle messages (lib/au-messages.js) ──
  // N04 welcome and N05 "finish your profile": {{1}} first name; URL button.
  welcome: fresh('gp_link_au_welcome'),
  onboarding_nudge: fresh('gp_link_au_onboarding_nudge'),
  // N16 "cleared to start": {{1}} first name, {{2}} practice, {{3}} the date.
  cleared_to_start: fresh('gp_link_au_cleared_to_start'),

  // ── The existing doctor-facing templates (WP-17 gated them; WP-18 read them) ──
  // N09 match invitation: neutral. {{3}} is only ever the "held until" line
  // (lib/match-whatsapp.js buildUrgencyLine).
  match_invitation: reused('gp_link_app_match_invitation', 'gp_link_au_match_invitation'),
  // Account released from review: neutral ("Browse jobs" button).
  account_released: reused('gp_link_account_released'),
  // The five whose existing wording says "your Registration Support Officer"
  // (and, for the interview ones, promises that person on the call). The row
  // without a suffix is the NEUTRAL Australian version, to be submitted; the
  // `_existing` row is the existing template, off unless the owner lists it.
  // Both take the same variables in the same order as the existing template.
  match_accepted: fresh('gp_link_au_match_accepted'),
  match_accepted_existing: ownerChoice('gp_link_app_match_accepted'),
  contract_ready: fresh('gp_link_au_contract_ready'),
  contract_ready_existing: ownerChoice('gp_link_contract_ready'),
  interview_times_ready: fresh('gp_link_au_interview_times_ready'),
  interview_times_ready_existing: ownerChoice('gp_link_interview_times_ready'),
  interview_confirmed: fresh('gp_link_au_interview_confirmed_gp'),
  interview_confirmed_existing: ownerChoice('gp_link_interview_confirmed_gp'),
  // To the PRACTICE, about an Australian candidate.
  interview_confirmed_practice: fresh('gp_link_au_interview_confirmed_practice'),
  interview_confirmed_practice_existing: ownerChoice('gp_link_interview_confirmed_practice'),
  // The welcome from the staff member assigned to the case. The existing one
  // (gp_link_app_rso_welcome) is overseas-only and has no `_existing` row: it
  // can never be switched on for an Australian doctor.
  rso_welcome: fresh('gp_link_au_team_welcome')
});

/**
 * Every template name the code can send that already exists in DoubleTick
 * (the 42 in docs/au-gp/whatsapp-live-templates.md section 1), classified for
 * an Australian recipient:
 *   neutral        the live fixed wording is safe as it stands
 *   rso_wording    no banned word, but says "Registration Support Officer":
 *                  sent to an Australian recipient only when the owner lists
 *                  that `_existing` key
 *   overseas_only  must never reach a doctor on an Australian pathway, an
 *                  Australian-segment lead, or a practice about an Australian
 *                  candidate
 * tests/au-wp18-template-guard.test.js fails if the source names a template
 * that is not classified here (or as a new `gp_link_au_*` row above).
 * THE RULE for any future template: classify it here on the day it is added;
 * unknown counts as overseas_only.
 */
const EXISTING_TEMPLATE_CLASS = Object.freeze({
  // neutral (11)
  gp_link_practice_candidate_intro: 'neutral',
  gp_link_practice_candidate_intro_cv: 'neutral',
  gp_link_consult_call_1h: 'neutral',
  gp_link_consult_call_starting_5m: 'neutral',
  gp_link_consult_missed_call: 'neutral',
  gp_link_consult_post_call_onboard_v3: 'neutral',
  gp_link_consult_onboarding_nudge: 'neutral',
  gp_link_app_match_invitation: 'neutral',
  gp_link_account_released: 'neutral',
  gp_link_khaleed_personal_checkin: 'neutral',   // the two sentences are the owner's own
  gp_link_owner_lead_alert: 'neutral',           // goes to the owner, never to a doctor
  // rso_wording (5)
  gp_link_interview_times_ready: 'rso_wording',
  gp_link_interview_confirmed_gp: 'rso_wording',
  gp_link_interview_confirmed_practice: 'rso_wording',
  gp_link_contract_ready: 'rso_wording',
  gp_link_app_match_accepted: 'rso_wording',
  // overseas_only (26): the 22 the review ruled out, the rejected one, and
  // the three "with care" nudges no Australian doctor is sent today.
  gp_link_consult_call_booked: 'overseas_only',
  gp_link_consult_call_reminder: 'overseas_only',
  gp_link_consult_hello_5m: 'overseas_only',
  gp_link_consult_check_in_1h: 'overseas_only',
  gp_link_consult_day_after_24h: 'overseas_only',
  gp_link_consult_signup_welcome: 'overseas_only',
  gp_link_app_rso_welcome: 'overseas_only',
  gp_link_reg_call_reminder: 'overseas_only',
  gp_link_reg_call_starting: 'overseas_only',
  gp_link_app_myintealth_introductiory_message_: 'overseas_only',
  gp_link_app_amc_introductiory_message_: 'overseas_only',
  gp_link_app_ahpra_introductiory_message: 'overseas_only',
  gp_link_ahpra_docs_complete: 'overseas_only',
  gp_link_visa_passports: 'overseas_only',
  gp_link_visa_passports_reminder: 'overseas_only',
  gp_link_onboarding_step_start: 'overseas_only',
  gp_link_onboarding_step_move: 'overseas_only',
  gp_link_onboarding_step_register: 'overseas_only',
  gp_link_onboarding_step_id: 'overseas_only',
  gp_link_resume_onboarding_start: 'overseas_only',
  gp_link_resume_onboarding_move: 'overseas_only',
  gp_link_resume_onboarding_id: 'overseas_only',
  gp_link_start_practice_search: 'overseas_only',
  gp_link_upload_cv_nudge: 'overseas_only',
  gp_link_offer_signature_nudge: 'overseas_only',
  gp_link_reengage_hayley: 'overseas_only'
});

/** 'neutral' | 'rso_wording' | 'overseas_only' | 'au' (a gp_link_au_* name) | 'unknown'. */
function templateClass(name) {
  const n = String(name || '');
  if (Object.prototype.hasOwnProperty.call(EXISTING_TEMPLATE_CLASS, n)) return EXISTING_TEMPLATE_CLASS[n];
  if (/^gp_link_au_[a-z0-9_]+$/.test(n)) return 'au';
  return 'unknown';
}

const REASON_NOT_APPROVED = 'au_template_not_approved';

function listFromEnv(env, name) {
  const raw = String((env && env[name]) || '');
  return raw.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}

/**
 * One template's row with its approval worked out.
 * @param {string} key  a key of AU_WHATSAPP_TEMPLATES
 * @param {object} [env]  defaults to process.env, read at call time
 * @returns {{ key, templateName, language, approved, source }|null} null for an unknown key
 */
function auWhatsAppTemplate(key, env) {
  const row = AU_WHATSAPP_TEMPLATES[key];
  if (!row) return null;
  const e = env || process.env;
  const has = function (list) { return list.indexOf(String(key).toLowerCase()) !== -1 || list.indexOf(row.templateName.toLowerCase()) !== -1; };
  const cls = templateClass(row.templateName);
  let approved = row.approved === true || has(listFromEnv(e, 'AU_WHATSAPP_APPROVED_TEMPLATES'));
  // Off wins; and a template that is overseas-only (or one nobody has
  // classified) is never usable for an Australian recipient.
  if (has(listFromEnv(e, 'AU_WHATSAPP_DISABLED_TEMPLATES'))) approved = false;
  if (cls === 'overseas_only' || cls === 'unknown') approved = false;
  return { key, templateName: row.templateName, language: row.language, approved, source: row.source };
}

/**
 * The row to send one Australian message through: the message's own row when
 * approved, else its `_existing` row (the owner's choice) when that is listed.
 * @returns {{ key, templateName, language, approved, source }|null}
 */
function usableRow(key, env) {
  const own = auWhatsAppTemplate(key, env);
  if (!own) return null;
  if (own.approved) return own;
  const alt = auWhatsAppTemplate(key + '_existing', env);
  return (alt && alt.approved) ? alt : own;
}

/**
 * What to do about the practice-introduction WhatsApp for a doctor on an
 * Australian pathway.
 *   { send: false, reason: 'au_template_not_approved' }   email only
 *   { send: true, templateNames: { text, cv } }           cv is '' when only
 *       the text template is approved (the CV still goes by email)
 */
function auPracticeIntroWhatsAppPlan(env) {
  const text = auWhatsAppTemplate('practice_intro', env);
  const cv = auWhatsAppTemplate('practice_intro_cv', env);
  if (!text.approved && !cv.approved) return { send: false, reason: REASON_NOT_APPROVED, templateNames: null };
  return {
    send: true,
    reason: '',
    templateNames: { text: text.approved ? text.templateName : '', cv: cv.approved ? cv.templateName : '' }
  };
}

/**
 * WP-11: what to do about one Australian WhatsApp to a doctor (or, for
 * `interview_confirmed_practice`, to the practice about an Australian doctor).
 *   { send: false, reason: 'au_template_not_approved' }   skip it (the email
 *                                                          and bell still go)
 *   { send: true, templateName, language, key, source }
 * An unknown key is never sent.
 */
function auDoctorWhatsAppPlan(key, env) {
  const row = usableRow(key, env);
  if (!row || !row.approved) return { send: false, reason: REASON_NOT_APPROVED, templateName: row ? row.templateName : '' };
  return { send: true, reason: '', templateName: row.templateName, language: row.language, key: row.key, source: row.source };
}

/**
 * WP-16: what to do about one consult-funnel WhatsApp to an Australian-segment
 * lead. `kind` is the overseas consult kind (lib/consult-whatsapp.js:
 * 'hello_5m', 'call_booked', 'call_reminder', 'call_missed', ...).
 *   { send: false, reason: 'au_template_not_approved', key, templateName }
 *   { send: true, key, templateName, language }
 * A kind with no Australian row is never sent.
 */
function auLeadWhatsAppPlan(kind, env) {
  const key = 'lead_' + String(kind || '');
  const row = auWhatsAppTemplate(key, env);
  if (!row || !row.approved) return { send: false, reason: REASON_NOT_APPROVED, key, templateName: row ? row.templateName : '' };
  return { send: true, reason: '', key, templateName: row.templateName, language: row.language };
}

/** Plain words for a log line or a timeline note about a sent Australian WhatsApp. */
function describeSentVia(templateName) {
  const cls = templateClass(templateName);
  if (cls === 'neutral') return 'sent via existing neutral template ' + templateName;
  if (cls === 'rso_wording') return 'sent via existing template ' + templateName + ' (the owner switched it on)';
  return 'sent via Australian template ' + templateName;
}

module.exports = {
  AU_WHATSAPP_TEMPLATES, EXISTING_TEMPLATE_CLASS, REASON_NOT_APPROVED,
  SOURCE: Object.freeze({ NEUTRAL, RSO_WORDING, NEW }),
  templateClass, auWhatsAppTemplate, auPracticeIntroWhatsAppPlan, auDoctorWhatsAppPlan, auLeadWhatsAppPlan, describeSentVia
};

'use strict';
/**
 * WP-09: THE one place that says which Australian WhatsApp templates exist and
 * whether each is approved. Pure, no I/O.
 *
 * The build rule (AGENT-RULES section 2): an Australian message with no
 * approved template falls back to email or is skipped. It is never sent
 * through an overseas template. The wording of an approved template is held by
 * DoubleTick / Meta, not by this repository, so code cannot check what an
 * existing template's fixed text says about a candidate. Every Australian
 * WhatsApp therefore gets its own template name here, starting NOT approved.
 *
 * To turn one on once the owner has it approved (either works, no other code
 * changes):
 *   - set `approved: true` on its row below, or
 *   - list its key or template name in the environment variable
 *     AU_WHATSAPP_APPROVED_TEMPLATES (comma separated), for example
 *     AU_WHATSAPP_APPROVED_TEMPLATES=practice_intro,practice_intro_cv
 *
 * The proposed wording for each is in docs/au-gp/whatsapp-templates.md.
 * Later packages add their templates as new rows.
 */

const AU_WHATSAPP_TEMPLATES = Object.freeze({
  // Submit to practice (N10 / P02): the candidate introduction, text only.
  practice_intro: Object.freeze({ templateName: 'gp_link_au_practice_candidate_intro', language: 'en', approved: false }),
  // The same with the CV as a DOCUMENT header.
  practice_intro_cv: Object.freeze({ templateName: 'gp_link_au_practice_candidate_intro_cv', language: 'en', approved: false }),
  // WP-11, N11: "your placement is secured" to a doctor on an Australian
  // pathway. {{1}} first name, {{2}} practice name; URL button to the app.
  placement_secured: Object.freeze({ templateName: 'gp_link_au_placement_secured', language: 'en', approved: false }),
  // WP-13, N18: the first-week check-in. To the doctor: {{1}} first name,
  // {{2}} practice name. To the practice: {{1}} contact name, {{2}} the doctor.
  commencement_checkin: Object.freeze({ templateName: 'gp_link_au_first_week_checkin', language: 'en', approved: false }),
  commencement_checkin_practice: Object.freeze({ templateName: 'gp_link_au_practice_first_week_checkin', language: 'en', approved: false }),

  // ── WP-16: the lead and consult funnel, for an Australian-segment lead ──
  // One row per overseas consult template (lib/consult-whatsapp.js
  // CONSULT_WA_TEMPLATES): the key is 'lead_' + that kind, and the Australian
  // template takes the SAME placeholders in the same order, so the existing
  // message builder fills it. Until a row is approved its WhatsApp is skipped
  // (reason logged and shown on the Leads tab) and the email carries the
  // message; an Australian lead is never sent the overseas template.
  // N01, the three notes before a booking. {{1}} first name, {{2}} booking link.
  lead_hello_5m: Object.freeze({ templateName: 'gp_link_au_lead_hello', language: 'en', approved: false }),
  lead_check_in_1h: Object.freeze({ templateName: 'gp_link_au_lead_check_in', language: 'en', approved: false }),
  lead_day_after_24h: Object.freeze({ templateName: 'gp_link_au_lead_last_note', language: 'en', approved: false }),
  // N02. Booking confirmation: {{1}} first name, {{2}} the time on their clock.
  lead_call_booked: Object.freeze({ templateName: 'gp_link_au_lead_call_booked', language: 'en', approved: false }),
  // The day-before and one-hour reminders: {{1}} first name, {{2}} the time,
  // {{3}} join link. "Starting in 5 minutes": {{1}} first name, {{2}} join link.
  lead_call_reminder: Object.freeze({ templateName: 'gp_link_au_lead_call_reminder', language: 'en', approved: false }),
  lead_call_hour_before: Object.freeze({ templateName: 'gp_link_au_lead_call_1h', language: 'en', approved: false }),
  lead_call_starting: Object.freeze({ templateName: 'gp_link_au_lead_call_starting_5m', language: 'en', approved: false }),
  // Missed call: {{1}} first name, {{2}} the link to pick a new time.
  lead_call_missed: Object.freeze({ templateName: 'gp_link_au_lead_missed_call', language: 'en', approved: false }),
  // N03, after an attended call: {{1}} first name, {{2}} sign-up link.
  lead_post_call_onboard: Object.freeze({ templateName: 'gp_link_au_lead_post_call', language: 'en', approved: false }),
  // Account created / onboarding not finished: {{1}} first name. (WP-17 owns
  // the onboarding wording; the rows are here so the skip is a named one.)
  lead_signed_up: Object.freeze({ templateName: 'gp_link_au_lead_signup_welcome', language: 'en', approved: false }),
  lead_onboarding_incomplete: Object.freeze({ templateName: 'gp_link_au_lead_onboarding_nudge', language: 'en', approved: false }),

  // ── WP-17: the lifecycle messages (lib/au-messages.js) ──
  // N04 welcome and N05 "finish your profile": {{1}} first name; URL button.
  welcome: Object.freeze({ templateName: 'gp_link_au_welcome', language: 'en', approved: false }),
  onboarding_nudge: Object.freeze({ templateName: 'gp_link_au_onboarding_nudge', language: 'en', approved: false }),
  // N16 "cleared to start": {{1}} first name, {{2}} practice, {{3}} the date.
  cleared_to_start: Object.freeze({ templateName: 'gp_link_au_cleared_to_start', language: 'en', approved: false }),
  // The EXISTING doctor-facing templates an Australian doctor would otherwise
  // be sent (match invitation and accepted, contract ready, the two interview
  // ones, the RSO welcome). Their fixed wording is held by DoubleTick and has
  // not been confirmed neutral, so each has an Australian row here taking the
  // SAME variables in the same order, and an Australian doctor's WhatsApp is
  // skipped (email, bell and push still go) until that row is approved. WP-18:
  // if the live body of an existing template reads neutral, change the row's
  // templateName to the existing name and approve it.
  match_invitation: Object.freeze({ templateName: 'gp_link_au_match_invitation', language: 'en', approved: false, existing: 'gp_link_app_match_invitation' }),
  match_accepted: Object.freeze({ templateName: 'gp_link_au_match_accepted', language: 'en', approved: false, existing: 'gp_link_app_match_accepted' }),
  contract_ready: Object.freeze({ templateName: 'gp_link_au_contract_ready', language: 'en', approved: false, existing: 'gp_link_contract_ready' }),
  interview_confirmed: Object.freeze({ templateName: 'gp_link_au_interview_confirmed', language: 'en', approved: false, existing: 'gp_link_interview_confirmed_gp' }),
  interview_times_ready: Object.freeze({ templateName: 'gp_link_au_interview_times_ready', language: 'en', approved: false, existing: 'gp_link_interview_times_ready' }),
  rso_welcome: Object.freeze({ templateName: 'gp_link_au_team_welcome', language: 'en', approved: false, existing: 'gp_link_app_rso_welcome' })
});

const REASON_NOT_APPROVED = 'au_template_not_approved';

function approvedFromEnv(env) {
  const raw = String((env && env.AU_WHATSAPP_APPROVED_TEMPLATES) || '');
  return raw.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}

/**
 * One template's row with its approval worked out.
 * @param {string} key  a key of AU_WHATSAPP_TEMPLATES
 * @param {object} [env]  defaults to process.env, read at call time
 * @returns {{ key, templateName, language, approved }|null} null for an unknown key
 */
function auWhatsAppTemplate(key, env) {
  const row = AU_WHATSAPP_TEMPLATES[key];
  if (!row) return null;
  const listed = approvedFromEnv(env || process.env);
  const approved = row.approved === true
    || listed.indexOf(String(key).toLowerCase()) !== -1
    || listed.indexOf(row.templateName.toLowerCase()) !== -1;
  return { key, templateName: row.templateName, language: row.language, approved };
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
 * WP-11: what to do about one Australian WhatsApp to a doctor.
 *   { send: false, reason: 'au_template_not_approved' }   skip it (the email
 *                                                          and bell still go)
 *   { send: true, templateName, language }
 * An unknown key is never sent.
 */
function auDoctorWhatsAppPlan(key, env) {
  const row = auWhatsAppTemplate(key, env);
  if (!row || !row.approved) return { send: false, reason: REASON_NOT_APPROVED, templateName: row ? row.templateName : '' };
  return { send: true, reason: '', templateName: row.templateName, language: row.language };
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

module.exports = { AU_WHATSAPP_TEMPLATES, REASON_NOT_APPROVED, auWhatsAppTemplate, auPracticeIntroWhatsAppPlan, auDoctorWhatsAppPlan, auLeadWhatsAppPlan };

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
  commencement_checkin_practice: Object.freeze({ templateName: 'gp_link_au_practice_first_week_checkin', language: 'en', approved: false })
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

module.exports = { AU_WHATSAPP_TEMPLATES, REASON_NOT_APPROVED, auWhatsAppTemplate, auPracticeIntroWhatsAppPlan, auDoctorWhatsAppPlan };

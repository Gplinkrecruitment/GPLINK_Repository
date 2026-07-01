'use strict';

/**
 * Pure helpers for managing AHPRA conflict-of-interest letters when a supervised
 * practice plan names a supervisor who is also the owner/principal of the practice.
 * AHPRA requires a statement from the practice confirming the conflict is managed.
 *
 * No external dependencies — safe to require from anywhere.
 */

// Escape the five characters that matter inside HTML text/attribute content.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Build the conflict-of-interest letter email to send to the medical practice.
 *
 * @param {object} params
 * @param {string} [params.gpName]         - GP's full name (no "Dr" prefix)
 * @param {string} [params.supervisorName] - Supervisor's name (e.g. "Dr John Miller")
 * @param {string} [params.practiceName]   - Practice name
 * @param {string} [params.contactName]    - Practice contact name (e.g. "Reception")
 * @param {string} [params.officerName]    - AHPRA officer's name
 * @param {string} [params.officerEmail]   - AHPRA officer's email address
 * @param {string} [params.ccEmail]        - CC address (GP Link RSO inbox)
 * @param {string} [params.rsoSignoffName] - RSO's first name for the email sign-off
 * @returns {{ subject: string, bodyHtml: string }}
 */
function buildConflictLetterEmail(params) {
  params = params || {};
  var gpName = String(params.gpName == null ? '' : params.gpName).trim();
  var supervisorName = String(params.supervisorName == null ? '' : params.supervisorName).trim() || 'the supervisor';
  var practiceName = String(params.practiceName == null ? '' : params.practiceName).trim() || 'the practice';
  var contactName = String(params.contactName == null ? '' : params.contactName).trim() || 'Practice Contact';
  var officerName = String(params.officerName == null ? '' : params.officerName).trim() || 'the AHPRA officer';
  var officerEmail = String(params.officerEmail == null ? '' : params.officerEmail).trim();
  var ccEmail = String(params.ccEmail == null ? '' : params.ccEmail).trim();
  var rsoSignoffName = String(params.rsoSignoffName == null ? '' : params.rsoSignoffName).trim();

  // Subject is a plain email header — do NOT HTML-escape.
  var subject = 'Conflict-of-interest confirmation for Dr ' + gpName + ' — please email AHPRA';

  var officerLine = escapeHtml(officerName) + (officerEmail ? ' (' + escapeHtml(officerEmail) + ')' : '');
  var ccClause = ccEmail ? ' and <b>CC us (' + escapeHtml(ccEmail) + ')</b> so we have it on file' : '';
  var signoff = rsoSignoffName ? (escapeHtml(rsoSignoffName) + ' — GP Link Registration Team') : 'GP Link Registration Team';

  var bodyHtml = [
    'Dear ' + escapeHtml(contactName) + ',',
    '',
    'As part of Dr ' + escapeHtml(gpName) + '’s AHPRA supervised-practice application, the SPPA-00 supervised practice plan noted that the supervisor, ' + escapeHtml(supervisorName) + ', is also the owner/principal of ' + escapeHtml(practiceName) + '.',
    '',
    'AHPRA requires a short statement from the practice confirming how this potential conflict of interest will be managed and that it will <b>not impair ' + escapeHtml(supervisorName) + '’s ability to supervise</b> Dr ' + escapeHtml(gpName) + '.',
    '',
    'Could you please email this confirmation directly to the AHPRA officer handling the application — ' + officerLine + ccClause + '?',
    '',
    'Suggested wording you can adapt: “Although ' + escapeHtml(supervisorName) + ' is both the supervisor and owner/principal of ' + escapeHtml(practiceName) + ', this will not impair their ability to provide appropriate supervision to Dr ' + escapeHtml(gpName) + '. Any potential conflicts of interest will be managed by …”',
    '',
    'Kind regards,',
    signoff
  ].join('<br>');

  return { subject: subject, bodyHtml: bodyHtml };
}

function normalizeEmail(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

function extractEmail(v) {
  var s = String(v == null ? '' : v);
  var m = s.match(/<([^>]+)>/);
  return normalizeEmail(m ? m[1] : s);
}

/**
 * Detect whether an inbound email is the practice's confirmation to AHPRA.
 * True when the email is FROM the practice and the AHPRA officer address appears
 * in To or Cc. Tolerates to/cc as arrays or comma-strings and "Name <addr>" forms.
 *
 * @param {object} emailMeta - { sender|from, to, cc, recipient }
 * @param {object} ctx       - { practiceEmail, officerEmail }
 * @returns {boolean}
 */
function isConflictLetterConfirmation(emailMeta, ctx) {
  emailMeta = emailMeta || {};
  ctx = ctx || {};
  var practiceEmail = normalizeEmail(ctx.practiceEmail);
  var officerEmail = normalizeEmail(ctx.officerEmail);
  if (!practiceEmail || !officerEmail) return false;
  var from = extractEmail(emailMeta.sender != null ? emailMeta.sender : emailMeta.from);
  if (from !== practiceEmail) return false;
  var recipientsBlob = [emailMeta.to, emailMeta.cc, emailMeta.recipient]
    .map(function (x) { return Array.isArray(x) ? x.join(' ') : String(x == null ? '' : x); })
    .join(' ').toLowerCase();
  return recipientsBlob.indexOf(officerEmail) !== -1;
}

/**
 * Common gate predicate — returns true only when a supervisor/owner conflict
 * exists AND the AHPRA officer's email address is known. Used by all three
 * triggers (SPPA return scan, manual admin action, practice-reply ingest) as
 * the shared guard before creating or advancing conflict-letter tasks.
 *
 * @param {object} ctx - { hasConflict: boolean, officerEmail: string }
 * @returns {boolean}
 */
function shouldEnsureConflictLetter(ctx) {
  ctx = ctx || {};
  return !!(ctx.hasConflict && String(ctx.officerEmail == null ? '' : ctx.officerEmail).trim());
}

/**
 * Returns true iff an s80 action-item is about a conflict of interest.
 * Identified purely by text (title / detail / gp_instructions) since the s80
 * reader folds conflict items into kind:"supervised_practice_plan".
 *
 * @param {object} item - s80 item with title, detail, gp_instructions fields
 * @returns {boolean}
 */
// Text-match assumption: because the s80 reader folds conflict-of-interest AND legitimate SPPA-00/Section-G items into the same kind:"supervised_practice_plan", we detect conflict by text; a non-conflict item whose detail merely mentions "conflict of interest" could be dropped (accepted — no stronger signal exists).
function isConflictOfInterestItem(item) {
  if (!item) return false;
  var hay = [item.title, item.detail, item.gp_instructions]
    .map(function (x) { return String(x == null ? '' : x); }).join(' ').toLowerCase();
  return /conflict[\s-]*of[\s-]*interest/.test(hay);
}

module.exports = { buildConflictLetterEmail, isConflictLetterConfirmation, shouldEnsureConflictLetter, isConflictOfInterestItem };

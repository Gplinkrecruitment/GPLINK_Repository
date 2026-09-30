'use strict';

/**
 * Pure helpers for managing AHPRA conflict-of-interest letters when a supervised
 * practice plan names a supervisor who is also the owner/principal of the practice.
 * AHPRA requires a statement from the practice confirming the conflict is managed.
 *
 * No external dependencies, safe to require from anywhere.
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
  // Follow-up mode: the practice ALREADY sent AHPRA its confirmation (priorConfirmedAt) and the
  // officer has written again. The letter then says so and quotes the officer's own words instead
  // of re-issuing the original template, which on 2026-09-29 asked Dr Obanimoh's practice a
  // second time for a statement it had sent three weeks earlier.
  var priorConfirmedAt = formatLetterDate(params.priorConfirmedAt);
  var officerRequestText = String(params.officerRequestText == null ? '' : params.officerRequestText).replace(/\s+/g, ' ').trim();
  var isFollowUp = !!priorConfirmedAt;

  // Subject is a plain email header, do NOT HTML-escape.
  var subject = isFollowUp
    ? 'Conflict-of-interest follow-up for Dr ' + gpName + ', AHPRA has asked again'
    : 'Conflict-of-interest confirmation for Dr ' + gpName + ', please email AHPRA';

  var officerLine = escapeHtml(officerName) + (officerEmail ? ' (' + escapeHtml(officerEmail) + ')' : '');
  var ccClause = ccEmail ? ' and <b>CC us (' + escapeHtml(ccEmail) + ')</b> so we have it on file' : '';
  var signoff = rsoSignoffName ? (escapeHtml(rsoSignoffName) + ', GP Link Registration Team') : 'GP Link Registration Team';

  var lines = ['Dear ' + escapeHtml(contactName) + ','];
  lines.push('');
  if (isFollowUp) {
    lines.push('We note that the conflict-of-interest confirmation for Dr ' + escapeHtml(gpName) + ' was already sent to AHPRA on ' + escapeHtml(priorConfirmedAt) + ', and we have it on file. Thank you for that.');
    lines.push('');
    if (officerRequestText) {
      lines.push('AHPRA has now come back to us on the same point. In the officer’s own words: “' + escapeHtml(clipText(officerRequestText, 700)) + '”');
      lines.push('');
    }
    lines.push('Could you please email a short response covering this directly to the AHPRA officer handling the application, ' + officerLine + ccClause + '?');
  } else {
    lines.push('As part of Dr ' + escapeHtml(gpName) + '’s AHPRA supervised-practice application, the SPPA-00 supervised practice plan noted that the supervisor, ' + escapeHtml(supervisorName) + ', is also the owner/principal of ' + escapeHtml(practiceName) + '.');
    lines.push('');
    lines.push('AHPRA requires a short statement from the practice confirming how this potential conflict of interest will be managed and that it will <b>not impair ' + escapeHtml(supervisorName) + '’s ability to supervise</b> Dr ' + escapeHtml(gpName) + '.');
    lines.push('');
    lines.push('Could you please email this confirmation directly to the AHPRA officer handling the application, ' + officerLine + ccClause + '?');
    lines.push('');
    lines.push('Suggested wording you can adapt: “Although ' + escapeHtml(supervisorName) + ' is both the supervisor and owner/principal of ' + escapeHtml(practiceName) + ', this will not impair their ability to provide appropriate supervision to Dr ' + escapeHtml(gpName) + '. Any potential conflicts of interest will be managed by …”');
  }
  lines.push('');
  lines.push('Kind regards,');
  lines.push(signoff);

  return { subject: subject, bodyHtml: lines.join('<br>') };
}

// "9 September 2026" for an ISO timestamp / Date; '' for anything unparseable. Sydney calendar day.
function formatLetterDate(value) {
  if (!value) return '';
  var d = value instanceof Date ? value : new Date(String(value));
  if (isNaN(d.getTime())) return '';
  try { return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Sydney' }); } catch (e) { return ''; }
}

function clipText(text, max) {
  var s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  var cut = s.slice(0, max);
  var sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + '…';
}

var CONFLICT_OF_INTEREST_RE = /conflict[\s-]*of[\s-]*interest/;

/**
 * Should an inbound AHPRA officer email be routed to the conflict-letter task?
 *
 * The words decide, never the AI category alone. `response_type: "request_from_practice"`
 * covers EVERY document or statement the practice must supply (an amended supervisor CV, a
 * position description, the supervisor's hours), and routing all of those here is exactly how
 * AHPRA's 2026-09-29 request for Dr Ranatunga's availability statement became a second copy of
 * the conflict-of-interest letter. Now:
 *   - the officer's ask (the AI's one-line summary, or the subject) must mention a conflict of
 *     interest; or the AI said conflict_followup AND the body itself mentions one;
 *   - status updates and escalations never route here (AHPRA saying "we received the conflict
 *     statement" must not ask the practice for it again).
 *
 * @param {object} triage    - { category, response_type, summary }
 * @param {object} emailMeta - { subject, bodyText|body }
 * @returns {boolean}
 */
function isConflictFollowupEmail(triage, emailMeta) {
  triage = triage || {};
  emailMeta = emailMeta || {};
  var responseType = String(triage.response_type || '');
  if (responseType === 'status_update' || responseType === 'escalation') return false;
  var ask = [triage.summary, emailMeta.subject]
    .map(function (x) { return String(x == null ? '' : x); }).join(' ').toLowerCase();
  if (CONFLICT_OF_INTEREST_RE.test(ask)) return true;
  if (triage.category !== 'conflict_followup') return false;
  var body = String(emailMeta.bodyText != null ? emailMeta.bodyText : (emailMeta.body || '')).toLowerCase();
  return CONFLICT_OF_INTEREST_RE.test(body);
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
 * Common gate predicate, returns true only when a supervisor/owner conflict
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
// Text-match assumption: because the s80 reader folds conflict-of-interest AND legitimate SPPA-00/Section-G items into the same kind:"supervised_practice_plan", we detect conflict by text; a non-conflict item whose detail merely mentions "conflict of interest" could be dropped (accepted, no stronger signal exists).
function isConflictOfInterestItem(item) {
  if (!item) return false;
  var hay = [item.title, item.detail, item.gp_instructions]
    .map(function (x) { return String(x == null ? '' : x); }).join(' ').toLowerCase();
  return /conflict[\s-]*of[\s-]*interest/.test(hay);
}

module.exports = { buildConflictLetterEmail, isConflictLetterConfirmation, shouldEnsureConflictLetter, isConflictOfInterestItem, isConflictFollowupEmail, formatLetterDate };

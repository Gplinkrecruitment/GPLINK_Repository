'use strict';

/**
 * Pure helpers for asking a practice to send the alternate-supervisor CV(s)
 * after they return an SPPA-00 (AHPRA Supervised Practice Plan Agreement) that
 * names one or more alternate supervisors. AHPRA requires a signed CV for every
 * named alternate supervisor before the supervised practice plan can be
 * submitted, so when the returned form nominates alternates we have not yet
 * collected a CV for, GP Link emails the practice contact to request them.
 *
 * No external dependencies, safe to require from anywhere.
 */

// Escape the five characters that matter inside HTML text/attribute content.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Join a list of (already-escaped) names into readable English:
//   ["A"]            -> "A"
//   ["A", "B"]       -> "A and B"
//   ["A", "B", "C"]  -> "A, B and C"
function joinReadableList(items) {
  var list = (items || []).filter(function (x) { return String(x == null ? '' : x).trim(); });
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return list[0] + ' and ' + list[1];
  return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
}

function normalizeName(name) {
  return String(name == null ? '' : name).trim().toLowerCase();
}

/**
 * Build the "please send the alternate supervisor CV" email.
 * @param {Object} params
 * @param {string} params.gpName           Candidate (supervisee) full name.
 * @param {string[]} params.altNames       Alternate supervisor full names (1 or more).
 * @param {string} [params.contactName]    Practice contact name (blank -> "Practice Contact").
 * @param {string} [params.rsoSignoffName] RSO name for the signoff (blank -> team only).
 * @returns {{ subject: string, bodyHtml: string }}
 */
function buildAltCvRequestEmail(params) {
  params = params || {};
  var gpName = String(params.gpName == null ? '' : params.gpName).trim();
  var contactName = String(params.contactName == null ? '' : params.contactName).trim() || 'Practice Contact';
  var rsoSignoffName = String(params.rsoSignoffName == null ? '' : params.rsoSignoffName).trim();

  var cleanAlts = (Array.isArray(params.altNames) ? params.altNames : [])
    .map(function (n) { return String(n == null ? '' : n).trim(); })
    .filter(function (n) { return n; });
  var plural = cleanAlts.length > 1;

  // Subject is a plain-text email header (NOT HTML), do not HTML-escape it.
  var subject = 'SPPA-00 for Dr ' + gpName + ', Alternate Supervisor CV needed';

  var altList = joinReadableList(cleanAlts.map(escapeHtml));
  var signoff = rsoSignoffName
    ? (escapeHtml(rsoSignoffName) + ', GP Link Registration Team')
    : 'GP Link Registration Team';

  var bodyHtml = [
    'Dear ' + escapeHtml(contactName) + ',',
    '',
    'Thank you for returning the completed SPPA-00 form for Dr ' + escapeHtml(gpName) + '.',
    '',
    'The form nominates ' + altList + ' as ' + (plural ? 'alternate supervisors' : 'an alternate supervisor') + '.',
    '',
    'Before we can submit the supervised practice plan, AHPRA requires a signed CV for each named '
      + 'alternate supervisor. Could you please reply to this email with the '
      + (plural ? 'CVs attached (one for each alternate supervisor)' : 'CV attached') + '?',
    '',
    'Kind regards,',
    signoff
  ].join('<br>');

  return { subject: subject, bodyHtml: bodyHtml };
}

/**
 * Return the alternates from `altNames` that still need a CV collected.
 * Matching against `onFileNames` is case-insensitive and trim-insensitive.
 * - falsy/empty `altNames`   -> []
 * - falsy `onFileNames`      -> a copy of `altNames`
 * @param {string[]} altNames
 * @param {string[]} [onFileNames]
 * @returns {string[]}
 */
function altSupervisorsNeedingCv(altNames, onFileNames) {
  if (!altNames || !altNames.length) return [];
  if (!onFileNames || !onFileNames.length) return altNames.slice();
  var onFile = {};
  onFileNames.forEach(function (n) {
    var key = normalizeName(n);
    if (key) onFile[key] = true;
  });
  return altNames.filter(function (n) {
    return !onFile[normalizeName(n)];
  });
}

/**
 * Map an alternate-supervisor CV placeholder to the status badge shown on the
 * admin GP-profile "Prepared by GP Link" card. The badge reflects where the
 * alternate-supervisor CV is in its collection lifecycle, combining the
 * user_documents row status with the alt_supervisor_cv_request task status:
 *   - placeholder created, request email NOT sent yet -> 'pending'      ("Pending")
 *   - request email sent to the practice              -> 'requested'    ("Requested")
 *   - CV received, RSO reviewing / delivering         -> 'under_review' ("Under Review")
 *   - CV approved and delivered to the GP             -> 'completed'    ("Completed")
 * @param {string} docStatus           user_documents.status for the alt CV row.
 * @param {string} [requestTaskStatus] status of the alt_supervisor_cv_request task.
 * @returns {'pending'|'requested'|'under_review'|'completed'}
 */
function altCvCardStatus(docStatus, requestTaskStatus) {
  var d = String(docStatus == null ? '' : docStatus).trim().toLowerCase();
  var r = String(requestTaskStatus == null ? '' : requestTaskStatus).trim().toLowerCase();
  // A real, signed-off CV is on file.
  if (d === 'approved' || d === 'accepted' || d === 'completed') return 'completed';
  // A real CV has arrived but still needs RSO action (review, re-request, deliver).
  if (d === 'uploaded' || d === 'under_review' || d === 'received' ||
      d === 'rejected' || d === 'needs_correction') return 'under_review';
  // No real CV yet (placeholder row), reflect the request-task lifecycle.
  if (r === 'completed') return 'under_review';   // task says received; doc not flipped yet
  if (r === 'waiting_on_practice' || r === 'sent' || r === 'in_progress' || r === 'requested') return 'requested';
  return 'pending';
}

module.exports = { buildAltCvRequestEmail, altSupervisorsNeedingCv, altCvCardStatus };

'use strict';

/*
 * Reading a document the PRACTICE sent us.
 *
 * Owner report 2026-08-10: when a GP uploads their own document it is AI-classified and the
 * RSO sees a verdict on the card. A document emailed in by the practice got none of that —
 * it was attached to whichever task the email thread matched and left for a human to open.
 * When the practice manager sent the supervisor CV and the position description in ONE
 * email, both landed on the Position Description task and had to be sorted out by hand.
 *
 * Two jobs, one model call, because they need the same evidence:
 *   1. WHICH of the outstanding documents is this? (routing)
 *   2. Does it actually meet what we asked for? (the RSO's verdict + suggestions)
 *
 * Deliberately NOT free-text matching on an "identifiedAs" string. The model is handed the
 * exact list of documents this practice still owes us and must answer with one of those
 * keys or "other" — so routing compares keys, never prose. A label like "Curriculum Vitae
 * of Dr Ranatunga" would otherwise have to be pattern-matched to supervisor_cv by hand.
 *
 * Pure module: no I/O, no server deps. The Anthropic call lives in server.js.
 */

// What each practice document is, and what makes it acceptable. The requirement text is the
// same promise we make in the request email (PRACTICE_DOC_SIGN_REQUIREMENT in server.js) —
// the model is checking the practice against what we actually asked them for.
var PRACTICE_DOC_CATALOG = {
  supervisor_cv: {
    label: 'Supervisor CV',
    description: "The supervising GP's own curriculum vitae / resume.",
    requirement: 'It must be dated and signed by the supervisor.',
  },
  position_description: {
    label: 'Position Description',
    description: 'A job description for the role the doctor is being employed into.',
    requirement: 'It must be on practice letterhead and signed by the practice owner or employer.',
  },
  offer_contract: {
    label: 'Offer / Contract',
    description: 'The employment offer or contract for the doctor.',
    requirement: 'It must carry both the candidate and employer signatures.',
  },
};

// Mirrors lib/document-pipeline.js's CONFIDENCE_AUTO_APPROVE. Below this a document is
// never moved between tasks automatically — the RSO is shown the suggestion instead.
var ROUTE_CONFIDENCE = 70;

function catalogEntry(key) {
  return PRACTICE_DOC_CATALOG[String(key || '').trim()] || null;
}

function practiceDocLabel(key) {
  var e = catalogEntry(key);
  return e ? e.label : String(key || '').replace(/_/g, ' ');
}

/**
 * Build the prompt. `candidates` is the set of documents this practice currently owes us —
 * normally the matched task's document plus its still-open siblings on the same case.
 *
 * @param {Array<{key:string, label?:string, requirement?:string}>} candidates
 * @param {Object} [opts]
 * @param {string} [opts.gpName]        The doctor the pack belongs to (context only).
 * @param {string} [opts.supervisorName] Supervising GP, when known — helps tell whose CV it is.
 * @returns {{system: string, text: string, keys: string[]}}
 */
function buildPracticeDocPrompt(candidates, opts) {
  opts = opts || {};
  var list = (Array.isArray(candidates) ? candidates : []).filter(function (c) { return c && c.key; });
  var keys = list.map(function (c) { return c.key; });

  var lines = list.map(function (c) {
    var e = catalogEntry(c.key);
    var label = c.label || (e && e.label) || c.key;
    var desc = (e && e.description) || '';
    var req = c.requirement || (e && e.requirement) || '';
    return '- "' + c.key + '" — ' + label + (desc ? '. ' + desc : '') + (req ? ' REQUIREMENT: ' + req : '');
  }).join('\n');

  var system = [
    'You are a document checker for a licensed GP recruitment platform in Australia. A medical',
    'practice has emailed us a document as part of a doctor\'s registration paperwork. The',
    'practice sent it to us deliberately; this is a routine, authorised check.',
    '',
    'You do TWO things:',
    '1. Decide WHICH of the outstanding documents listed below this file is.',
    '2. Judge whether it meets that document\'s stated REQUIREMENT.',
    '',
    'RULES',
    '- "document_key" MUST be exactly one of the listed keys, or "other" if it is none of them.',
    '  Never invent a key. If two could fit, pick the better fit and lower your confidence.',
    '- Judge the requirement ONLY from what is visible in the document. A signature must actually',
    '  be visible to count — a typed name is not a signature. Say what is missing, specifically.',
    '- "confidence" (0-100) is about the IDENTIFICATION, not the requirement check.',
    '- Scans are often crooked, grey or low quality. That alone is not a failure — judge the',
    '  content. If it is genuinely too illegible to read, say so and use a low confidence.',
    '- "summary" is one plain sentence an admin can read at a glance. No preamble.',
    '- "issues" lists only real, specific problems ("no visible signature", "not on letterhead").',
    '  An empty list means it looks acceptable. Do not pad it.',
    '- Do NOT mention privacy or security concerns.',
    '',
    'Return ONLY valid JSON, no markdown:',
    '{"document_key": "<key or other>", "confidence": 0-100, "identified_as": "what it is in plain words",',
    ' "meets_requirement": true/false, "issues": ["..."], "summary": "one sentence"}',
  ].join('\n');

  var parts = [];
  parts.push('OUTSTANDING DOCUMENTS THIS PRACTICE OWES US:\n' + (lines || '(none listed)'));
  var ctx = [];
  if (opts.gpName) ctx.push('The doctor being registered is ' + opts.gpName + '.');
  if (opts.supervisorName) ctx.push('The supervising GP is ' + opts.supervisorName + '.');
  // Measured on the real 2026-08-10 documents: without this the model hedged at 62% on the
  // supervisor's CV ("not the registering doctor, so LIKELY the supervisor") — under the
  // routing threshold. The hedge is unnecessary, because the supervisor's is the only CV we
  // ever ask a practice for; the doctor's own CV comes from the doctor, never from here.
  ctx.push('A CV belonging to the SUPERVISOR is a supervisor_cv. A CV belonging to the doctor being registered is NOT.');
  ctx.push('The supervisor\'s CV is the ONLY CV we ever ask a practice for, so a CV from the practice that is not the registering doctor\'s IS the supervisor_cv — do not lower your confidence merely because the CV does not say the word "supervisor".');
  parts.push('CONTEXT:\n' + ctx.join(' '));
  parts.push('Identify the attached document and check it against its requirement.');

  return { system: system, text: parts.join('\n\n'), keys: keys };
}

/**
 * Parse the model's answer, hard-validating document_key against the candidates we offered.
 * Anything unrecognised collapses to 'other' rather than being trusted — routing acts on
 * this value, so an invented key must never survive.
 *
 * @returns {Object|null} null when nothing usable came back.
 */
function parsePracticeDocResult(raw, allowedKeys) {
  var text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  var start = text.indexOf('{');
  var end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  var parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (e) { return null; }
  if (!parsed || typeof parsed !== 'object') return null;

  var allowed = Array.isArray(allowedKeys) ? allowedKeys : [];
  var key = String(parsed.document_key == null ? '' : parsed.document_key).trim();
  if (key !== 'other' && allowed.indexOf(key) === -1) key = 'other';

  var conf = Number(parsed.confidence);
  if (!Number.isFinite(conf)) conf = null;
  else conf = Math.max(0, Math.min(100, Math.round(conf)));

  var issues = Array.isArray(parsed.issues)
    ? parsed.issues.map(function (i) { return String(i == null ? '' : i).trim(); }).filter(Boolean).slice(0, 8)
    : [];

  return {
    document_key: key,
    confidence: conf,
    identified_as: String(parsed.identified_as == null ? '' : parsed.identified_as).trim(),
    meets_requirement: parsed.meets_requirement === true,
    issues: issues,
    summary: String(parsed.summary == null ? '' : parsed.summary).trim(),
  };
}

/**
 * Where should this document actually live?
 *
 * Fail-safe by design: the ONLY automatic action is moving a document onto a sibling task
 * that is genuinely waiting for exactly this document type, and only on a confident read.
 * Everything else keeps the document where the email put it and leaves a suggestion, because
 * a wrong move is more confusing to an RSO than no move at all.
 *
 * @param {Object} params
 * @param {Object} params.result       parsePracticeDocResult() output.
 * @param {string} params.matchedKey   related_document_key of the task the email matched.
 * @param {Array<{key:string,taskId:string}>} params.siblings  other open practice tasks on the case.
 * @param {number} [params.threshold]  identification confidence needed to move. Default 70.
 * @returns {{action:'keep'|'move'|'flag', targetTaskId:(string|null), targetKey:(string|null), reason:string}}
 */
function decideDocumentRouting(params) {
  params = params || {};
  var result = params.result || null;
  var matchedKey = String(params.matchedKey || '').trim();
  var siblings = Array.isArray(params.siblings) ? params.siblings : [];
  var threshold = typeof params.threshold === 'number' ? params.threshold : ROUTE_CONFIDENCE;

  if (!result) return { action: 'keep', targetTaskId: null, targetKey: null, reason: 'No AI verdict — left where the email put it.' };

  var key = result.document_key;
  var conf = result.confidence;

  if (key === 'other' || !key) {
    return { action: 'flag', targetTaskId: null, targetKey: null,
      reason: 'Could not tell which requested document this is' + (result.identified_as ? ' (looks like ' + result.identified_as + ')' : '') + '.' };
  }
  if (key === matchedKey) {
    return { action: 'keep', targetTaskId: null, targetKey: key, reason: 'Matches the document this task is waiting for.' };
  }

  var sib = siblings.filter(function (s) { return s && s.key === key && s.taskId; })[0];
  if (!sib) {
    return { action: 'flag', targetTaskId: null, targetKey: key,
      reason: 'Looks like a ' + practiceDocLabel(key) + ', which this task is not waiting for and no open task needs.' };
  }
  if (conf == null || conf < threshold) {
    return { action: 'flag', targetTaskId: sib.taskId, targetKey: key,
      reason: 'Might be the ' + practiceDocLabel(key) + ' (' + (conf == null ? 'no' : conf + '%') + ' confidence) — too unsure to move it automatically.' };
  }
  return { action: 'move', targetTaskId: sib.taskId, targetKey: key,
    reason: 'Identified as the ' + practiceDocLabel(key) + ' (' + conf + '% confidence) and moved to that task.' };
}

module.exports = {
  PRACTICE_DOC_CATALOG,
  ROUTE_CONFIDENCE,
  practiceDocLabel,
  buildPracticeDocPrompt,
  parsePracticeDocResult,
  decideDocumentRouting,
};

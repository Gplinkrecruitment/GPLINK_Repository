'use strict';

/**
 * AI pre-submit completeness check for a returned SPPA-00 (AHPRA Supervised
 * Practice Plan Agreement). Runs once the practice returns the completed form:
 * it verifies the form has been filled out correctly AND that all required
 * supporting documents are on hand (primary supervisor CV, and an alternate
 * supervisor CV for every alternate named on the form).
 *
 * The checklist below is derived from three real, approved SPPA-00 forms.
 *
 * IMPORTANT: checkbox ticks and signatures DO NOT appear in a PDF's text layer
 * — they must be read from the rendered page. So we send the completed form as
 * a `document` block (Claude reads it visually) rather than extracting text.
 */

var COMPLETENESS_SYSTEM_PROMPT = [
  'You are a meticulous AHPRA forms checker for GP Link, an Australian GP recruitment platform.',
  'You are given a returned "Supervised practice plan" form (form code SPPA-00, 13 pages), plus an',
  'inventory of the supporting documents GP Link currently holds. Your job: decide whether the',
  'returned form is READY TO SUBMIT to AHPRA, or whether something is missing or wrong. Describe what',
  'the returned form shows; do not assume or assert who completed it.',
  '',
  'READ THE FORM VISUALLY. Checkbox ticks and signatures are NOT in the text layer. A real selection',
  'is a clear check mark; AHPRA forms also show a faint grey "x" placeholder inside an UNticked box —',
  'that placeholder is NOT a selection. A typed/printed name in a signature field is NOT a valid',
  'signature (AHPRA requires a real e-signature or a scanned wet signature).',
  '',
  'ALWAYS-REQUIRED items (form is incomplete if any are missing/blank):',
  '- Section A / Q1: supervisee family name, first name, date of birth, and health profession ticked.',
  '  The SUPERVISEE\'s own registration number is NOT required: GP Link candidates are applying FOR',
  '  registration and do not have an AHPRA registration number yet, so "N/A", "pending" or blank in the',
  '  supervisee registration-number field is CORRECT. NEVER flag or raise an issue about a missing,',
  '  blank or "N/A" SUPERVISEE registration number. (This does not change Q2 — the SUPERVISOR is already',
  '  registered and their registration number IS required.)',
  '- Q2: primary supervisor family name, first name, health profession, and registration number.',
  '- Q3: a primary supervisor CV must be attached/provided (see the supporting-documents inventory).',
  '- Conflict questions Q6, Q7, Q8 and Q9: each must have exactly one of YES/NO selected. If any is',
  '  answered YES, its "provide details" box must be filled in.',
  '- Q10: proposed role/title, a role description, and full employer details; plus proof of employment',
  '  (a signed letter of offer and/or position description) — check the inventory for this.',
  '- Q11: at least one workplace/location with a full address (street, suburb, state, postcode).',
  '  CONTACT-DETAILS RULE for the employer (Q10) and each workplace/location (Q11): only ONE contact',
  '  method is needed per section — a phone number OR an email. Do NOT flag a blank email when a phone',
  '  is present, and do NOT flag a blank phone when an email is present. Only raise an issue if a',
  '  section has NEITHER a phone number nor an email.',
  '- Q12: a start date, a starting supervision level ticked (Direct / Indirect 1 / Indirect 2 / Remote),',
  '  and reporting/consultation frequency and hours.',
  '- Q13: at least one "how supervised practice is provided" option ticked.',
  '- Section I (supervisee declaration): printed name + date + a real SIGNATURE.',
  '- Section J (primary supervisor declaration): printed name + date + a real SIGNATURE.',
  '',
  'CONDITIONAL items:',
  '- If an alternate supervisor is named at Q4: that alternate needs Q8 answered, a signed & dated',
  '  Section K declaration (name + date + real signature), AND their own signed CV (Q5) — check the',
  '  inventory for an alternate-supervisor CV for each alternate named.',
  '- If Q9 = YES (more than one alternate): a separate sheet / Section K signature is needed for each.',
  '- If Q14 = YES: the Q15 progression table must be filled in. If Q14 = NO, an empty Q15 table is CORRECT.',
  '- The "supervised practice goals and activities" template (Q18 / Section G) is ALWAYS supplied to every',
  '  candidate using GP Link\'s own standard template — it is never the candidate\'s or practice\'s job to',
  '  attach it. NEVER flag the Q18 / Section G goals-and-activities template as a missing field or missing',
  '  document, regardless of how Q17 is answered. Do not mention it as missing at all.',
  '- If Q19 = YES: the listed additional requirements should be present.',
  'A form with NO alternate supervisor and a blank Section K is CORRECT — do not flag a blank Section K',
  'unless an alternate is actually named at Q4.',
  '',
  'Cross-check the form against the supporting-documents inventory you are given. If the form names an',
  'alternate supervisor but the inventory has no CV for them, that is a MISSING DOCUMENT. If the primary',
  'supervisor CV or proof-of-employment is not in the inventory, flag it.',
  '',
  'Return ONLY valid JSON with this exact shape:',
  '{',
  '  "alternate_supervisors_on_form": ["full name", ...],',
  '  "is_complete": true | false,',
  '  "confidence": "high" | "medium" | "low",',
  '  "missing_fields": ["short description of each blank/unanswered required field"],',
  '  "missing_signatures": ["which declaration is unsigned, undated, or only typed"],',
  '  "missing_documents": ["which required supporting document is absent"],',
  '  "issues": ["any other problem, e.g. a YES conflict with no details, internal inconsistency"],',
  '  "summary": "one short plain-English sentence a non-technical reviewer can act on"',
  '}',
  'Set is_complete=true ONLY if there are no missing fields, no missing signatures, and no missing',
  'documents. When uncertain because the scan is unclear, set confidence "low" and explain in issues.',
  'Word the summary and all flagged items neutrally about the returned form — say what is missing or',
  'unsigned (e.g. "the returned form is missing X", "Section J is unsigned"), never assert that the',
  'practice did or failed to do something.'
].join('\n');

function parseCompletenessResponse(text) {
  var defaults = {
    alternate_supervisors_on_form: [],
    is_complete: false,
    confidence: 'low',
    missing_fields: [],
    missing_signatures: [],
    missing_documents: [],
    issues: ['Could not parse AI response'],
    summary: 'Automatic completeness check could not be read — please review manually.',
    // Fail OPEN on unparseable AI output: this sentinel surfaces upstream as
    // error='parse_error', so the submit gate treats unreadable output as
    // "passed, needs manual eyes" rather than a hard "incomplete" block.
    // The specific error paths in checkSppaCompleteness override this via
    // Object.assign(..., { _error: '...' }), preserving their own error code.
    _error: 'parse_error'
  };
  try {
    var start = String(text || '').indexOf('{');
    var end = String(text || '').lastIndexOf('}');
    if (start < 0 || end < 0) return defaults;
    var p = JSON.parse(String(text).slice(start, end + 1));
    function arr(v) { return Array.isArray(v) ? v.filter(function (x) { return x && String(x).trim(); }).map(String) : []; }
    var validConf = ['high', 'medium', 'low'];
    return {
      alternate_supervisors_on_form: arr(p.alternate_supervisors_on_form),
      is_complete: !!p.is_complete,
      confidence: validConf.indexOf(p.confidence) >= 0 ? p.confidence : 'low',
      missing_fields: arr(p.missing_fields),
      missing_signatures: arr(p.missing_signatures),
      missing_documents: arr(p.missing_documents),
      issues: arr(p.issues),
      summary: String(p.summary || '').trim() || (p.is_complete ? 'Form looks complete and ready to submit.' : 'Form appears incomplete — see flagged items.')
    };
  } catch (e) {
    return defaults;
  }
}

/**
 * @param {Object} params
 * @param {Buffer} params.sppaPdfBuffer       The completed SPPA-00 PDF.
 * @param {string} [params.sppaPdfMime]       Defaults to application/pdf.
 * @param {string} params.inventoryText       Plain-text inventory of supporting docs GP Link holds.
 * @param {string[]} [params.altSupervisorNames]  Alternate names already extracted from the form (hint).
 * @param {Object} [opts]                      { apiKey, timeoutMs }
 * @returns {Promise<Object>} verdict (parseCompletenessResponse shape) with optional _error/_model/_usage.
 */
async function checkSppaCompleteness(params, opts) {
  opts = opts || {};
  params = params || {};
  var apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Object.assign(parseCompletenessResponse(''), { _error: 'no_api_key' });
  if (!params.sppaPdfBuffer || !params.sppaPdfBuffer.length) {
    return Object.assign(parseCompletenessResponse(''), { _error: 'no_pdf', summary: 'No completed SPPA-00 PDF found to check.' });
  }

  var mime = params.sppaPdfMime || 'application/pdf';
  var b64 = params.sppaPdfBuffer.toString('base64');
  // Anthropic request limit is 32MB; keep margin. Refuse oversized scans rather than erroring out.
  if (b64.length > 28 * 1024 * 1024) {
    return Object.assign(parseCompletenessResponse(''), { _error: 'pdf_too_large', summary: 'SPPA-00 file is too large for an automatic check — please review manually.' });
  }

  var altHint = (Array.isArray(params.altSupervisorNames) && params.altSupervisorNames.length)
    ? ('Alternate supervisor name(s) already detected on this form: ' + params.altSupervisorNames.join('; ') + '.')
    : 'No alternate supervisor names have been detected yet — read the form yourself to confirm.';

  var docBlock;
  if (/^image\//i.test(mime)) {
    docBlock = { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } };
  } else {
    docBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  }

  var userText = [
    '## Completed SPPA-00 form is attached above. Check it against the rules.',
    '',
    '## Supporting documents GP Link currently holds for this candidate:',
    String(params.inventoryText || 'No inventory provided.'),
    '',
    altHint,
    '',
    'Now return the JSON verdict described in your instructions. Remember: read ticks and signatures',
    'from the rendered pages, not the text layer.'
  ].join('\n');

  var model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';
  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, opts.timeoutMs || 90000);
  try {
    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        max_tokens: 1200,
        system: [{ type: 'text', text: COMPLETENESS_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [docBlock, { type: 'text', text: userText }] }]
      })
    });
    if (!resp.ok) {
      var errBody = '';
      try { errBody = await resp.text(); } catch (e) {}
      return Object.assign(parseCompletenessResponse(''), {
        _error: 'api_error_' + resp.status, _detail: errBody,
        summary: 'Automatic completeness check could not run — please review the form manually.'
      });
    }
    var data = await resp.json();
    var text = (data.content && data.content[0] && data.content[0].text) || '';
    var verdict = parseCompletenessResponse(text);
    verdict._model = model;
    verdict._usage = data.usage || null;
    return verdict;
  } catch (err) {
    return Object.assign(parseCompletenessResponse(''), {
      _error: 'fetch_error: ' + err.message,
      summary: 'Automatic completeness check could not run — please review the form manually.'
    });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { checkSppaCompleteness, parseCompletenessResponse, COMPLETENESS_SYSTEM_PROMPT };

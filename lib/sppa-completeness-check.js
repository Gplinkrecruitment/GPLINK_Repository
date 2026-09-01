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
  'FIRST, confirm the attached document actually IS the AHPRA SPPA-00 form: an official Ahpra /',
  'National Boards form titled "Supervised practice plan" carrying the form code SPPA-00, with',
  'lettered sections and numbered questions (Section A / Q1 supervisee details through the signed',
  'declarations at Sections I/J/K). Practices sometimes return a DIFFERENT document instead — most',
  'commonly a supervision plan they drafted themselves (their own headings, no Ahpra branding, no',
  'SPPA-00 form code, no Q1-Q19 numbering), or a contract or position description. If the document',
  'is NOT the AHPRA SPPA-00 form: set is_sppa_form=false, describe what it actually is in',
  'document_identity, set is_complete=false, make the summary say plainly that this is not the',
  'SPPA-00 form GP Link sent, and leave the field-level arrays empty (checking a different',
  "document's fields against the SPPA-00 rules would only produce noise). If it IS the SPPA-00,",
  'set is_sppa_form=true and check it against the rules below.',
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
  '- Conflict questions Q6 and Q7: each must have exactly one of YES/NO selected. If answered YES,',
  '  the "provide details" box must be filled in. Q8 and Q9 relate to ALTERNATE supervisors and are',
  '  covered by the alternate-supervisor rules below — they are NOT always required.',
  '- Q10: proposed role/title, a role description, and full employer details; plus proof of employment',
  '  (a signed letter of offer and/or position description) — check the inventory for this.',
  '- Q11: at least one workplace/location with a full address (street, suburb, state, postcode).',
  '  CONTACT-DETAILS RULE for the employer (Q10) and each workplace/location (Q11): only ONE contact',
  '  method is needed per section — a phone number OR an email. Do NOT flag a blank email when a phone',
  '  is present, and do NOT flag a blank phone when an email is present. Only raise an issue if a',
  '  section has NEITHER a phone number nor an email.',
  '- Q12: a starting supervision level ticked (Direct / Indirect 1 / Indirect 2 / Remote).',
  '  START-DATE RULE: GP Link fills the Q12 proposed start date itself when the practice leaves it',
  '  blank (set automatically to 5 months after the practice returns the form). NEVER flag a blank,',
  '  missing or empty start date — it is handled by GP Link, not the practice.',
  '  HOURS RULE: GP Link pre-fills the hours of supervised practice (e.g. "40hrs Per Week") before',
  '  the form is sent. If an hours value is legible ANYWHERE at Q12 — inside the box, next to it,',
  '  or just below it — the hours are answered; NEVER flag the value\'s placement or alignment.',
  '  Only flag hours if no hours value is visible at Q12 at all.',
  '- Q13: at least one "how supervised practice is provided" option ticked.',
  '- Section I (supervisee declaration): printed name + date + a real SIGNATURE.',
  '- Section J (primary supervisor declaration): printed name + date + a real SIGNATURE.',
  '',
  'CONDITIONAL items:',
  '- An alternate supervisor exists ONLY when a NAME is actually written in the Q4 name fields.',
  '  GP Link\'s own template arrives with the Q4 health-profession checkbox pre-ticked and the',
  '  division/specialty pre-filled ("General Practice") as defaults — a Q4 section with ticks or a',
  '  specialty but NO NAME simply means no alternate supervisor is intended. NEVER flag that as an',
  '  incomplete entry, an ambiguity, or a "Q4/Q8 inconsistency" — it is normal and correct.',
  '- If NO alternate supervisor is named at Q4: IGNORE Q8 and Q9 entirely. Ticked YES, ticked NO,',
  '  or left blank — whatever state Q8/Q9 are in does not matter and must never be flagged when',
  '  there is no named alternate.',
  '- If an alternate supervisor IS named at Q4: that alternate needs Q8 answered, a signed & dated',
  '  Section K declaration (name + date + real signature), AND their own signed CV (Q5) — check the',
  '  inventory for an alternate-supervisor CV for each alternate named.',
  '- If Q9 = YES (more than one alternate): a separate sheet / Section K signature is needed for each.',
  '- Q14 RULE: GP Link pre-selects NO on Q14 before the form is sent — progression through',
  '  supervision levels never applies to GP Link candidates. Treat Q14 as NO unless a clear,',
  '  deliberate YES tick is visible; a faint placeholder mark, an ambiguous smudge, or an unticked',
  '  Q14 all mean NO. With Q14 = NO, an empty Q15 progression table is CORRECT — never flag Q14',
  '  or Q15 unless Q14 is unmistakably ticked YES.',
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
  '  "is_sppa_form": true | false,',
  '  "document_identity": "short description of what the document actually is (always fill this in)",',
  '  "alternate_supervisors_on_form": ["full name", ...],',
  '  "q12_start_date_observed": "blank" | "filled" | "unclear",',
  '  "q7_observed": "yes" | "no" | "blank" | "unclear",',
  '  "is_complete": true | false,',
  '  "confidence": "high" | "medium" | "low",',
  '  "missing_fields": ["short description of each blank/unanswered required field"],',
  '  "missing_signatures": ["which declaration is unsigned, undated, or only typed"],',
  '  "missing_documents": ["which required supporting document is absent"],',
  '  "issues": ["any other problem, e.g. a YES conflict with no details, internal inconsistency"],',
  '  "summary": "one short plain-English sentence a non-technical reviewer can act on"',
  '}',
  'q12_start_date_observed is a neutral OBSERVATION, never a flag: report whether the Q12 proposed',
  'start-date box on the returned form visibly shows a date ("filled"), is visibly empty ("blank" —',
  'the DD/MM/YYYY placeholder cells alone mean blank), or cannot be judged ("unclear"). GP Link uses',
  'this to write its own default date onto the form; it must never appear in missing_fields or',
  'issues either way.',
  'q7_observed is likewise a neutral OBSERVATION: report what the returned form visibly shows at',
  'Q7 — a clear YES selection ("yes"), a clear NO selection ("no"), neither selected ("blank" —',
  'the faint grey placeholder in an unticked box means blank), or unreadable ("unclear"). Always',
  'report it, on top of the normal Q7 completeness rule: GP Link compares it against its own',
  'conflict-of-interest scan of the supervisor and practice owner.',
  'Set is_complete=true ONLY if there are no missing fields, no missing signatures, and no missing',
  'documents. When uncertain because the scan is unclear, set confidence "low" and explain in issues.',
  'Word the summary and all flagged items neutrally about the returned form — say what is missing or',
  'unsigned (e.g. "the returned form is missing X", "Section J is unsigned"), never assert that the',
  'practice did or failed to do something.'
].join('\n');

function parseCompletenessResponse(text) {
  var defaults = {
    is_sppa_form: null,
    document_identity: '',
    alternate_supervisors_on_form: [],
    q12_start_date_observed: 'unclear',
    q7_observed: 'unclear',
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
      // Back-compat: verdicts stored before the identity check existed lack is_sppa_form —
      // null means "not judged", and only an explicit false is treated as the wrong form.
      is_sppa_form: (p.is_sppa_form === true || p.is_sppa_form === false) ? p.is_sppa_form : null,
      document_identity: String(p.document_identity || '').trim(),
      alternate_supervisors_on_form: arr(p.alternate_supervisors_on_form),
      q12_start_date_observed: ['blank', 'filled', 'unclear'].indexOf(p.q12_start_date_observed) >= 0 ? p.q12_start_date_observed : 'unclear',
      q7_observed: ['yes', 'no', 'blank', 'unclear'].indexOf(p.q7_observed) >= 0 ? p.q7_observed : 'unclear',
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

/**
 * True when a returned SPPA-00 is otherwise complete + signed and the ONLY outstanding item is an
 * alternate supervisor's CV. That CV is collected via its own dedicated task
 * (alt_supervisor_cv_request) and delivered to the GP's profile separately, so it should NOT
 * hard-block the SPPA-00 submit — the UI reframes it as a reminder to complete that task.
 * @param {Object} verdict parseCompletenessResponse-shaped object
 * @returns {boolean}
 */
function isOnlyAltCvOutstanding(verdict) {
  if (!verdict || typeof verdict !== 'object') return false;
  function arr(v) { return Array.isArray(v) ? v.filter(function (x) { return x && String(x).trim(); }) : []; }
  if (arr(verdict.missing_fields).length) return false;
  if (arr(verdict.missing_signatures).length) return false;
  if (arr(verdict.issues).length) return false;
  var docs = arr(verdict.missing_documents);
  if (!docs.length) return false;
  // Every outstanding document must be an alternate-supervisor CV item.
  return docs.every(function (d) { return /alternate\s+supervisor/i.test(String(d)); });
}

/**
 * Deterministic Q7 cross-check. GP Link's own conflict scan already decided whether the primary
 * supervisor is the practice owner/director (task metadata.is_conflict — kept current by
 * Override Q7). When that verdict is YES, a returned form showing Q7 = NO or unanswered
 * contradicts what GP Link knows and must never reach AHPRA. Seen live on Dr Mercy Obanimoh
 * (2026-08): the practice answered off a printed copy that had lost the pre-filled YES + details,
 * crossed NO, and the completeness check reported "ready to submit".
 * @param {*} isConflict  task metadata.is_conflict (only strict true arms the check)
 * @param {string} q7Observed  the verdict's q7_observed observation
 * @returns {string|null}  the issue to flag, or null when there is no contradiction
 */
function q7ConflictMismatchIssue(isConflict, q7Observed) {
  if (isConflict !== true) return null;
  if (q7Observed !== 'no' && q7Observed !== 'blank') return null;
  return 'Q7 on the returned form is ' + (q7Observed === 'no' ? 'marked NO' : 'unanswered') +
    ", but GP Link's conflict-of-interest scan found the primary supervisor is the practice " +
    'owner/director — Q7 must be YES with the conflict details filled in before this form can go to AHPRA.';
}

// ── Which attachment is the SPPA-00? ────────────────────────────────────────────────────────
// A practice's return email often carries several PDFs, and their scanner names them CCF_000527
// / CCF_000528 — the filename says nothing. Dr Mercy Obanimoh (2026-08-25): the practice sent
// the real signed SPPA-00 AND their own home-drafted "supervision plan" in one email; filename
// heuristics attached the wrong one as the task's document. This asks the model to identify
// each document so the caller can attach the real SPPA-00 and file the rest as "other".

var IDENTIFY_SYSTEM_PROMPT = [
  'You are a document classifier for GP Link, an Australian GP recruitment platform.',
  'You are given one or more PDF documents that arrived in a single email from a medical practice.',
  'For EACH document, decide what it is. The document GP Link is waiting for is the AHPRA SPPA-00:',
  'an official Ahpra / National Boards form titled "Supervised practice plan" carrying the form code',
  'SPPA-00, with lettered sections and numbered questions (Section A / Q1 supervisee details through',
  'the signed declarations at Sections I/J/K). A supervision plan the practice drafted themselves',
  '(their own headings and numbering, no Ahpra branding, no SPPA-00 form code) is NOT the SPPA-00.',
  '',
  'The documents are attached in order; refer to them by their 1-based position. To keep the',
  'request small you may be shown only the FIRST FEW PAGES of each document — identify each from',
  'what you can see (the SPPA-00 is unmistakable from its first pages).',
  'Return ONLY valid JSON with this exact shape:',
  '{',
  '  "documents": [',
  '    {',
  '      "position": 1,',
  '      "is_sppa_form": true | false,',
  '      "is_cv": true | false,',
  '      "looks_like": "short plain-English description of what this document is",',
  '      "confidence": "high" | "medium" | "low"',
  '    }, ...',
  '  ]',
  '}',
  'is_cv is true only for a curriculum vitae / resume of a person. Judge each document on its',
  'rendered pages, not filenames. If a document is unreadable, use confidence "low" and describe',
  'what you can see.'
].join('\n');

function parseIdentifyResponse(text, count) {
  var out = [];
  for (var i = 0; i < count; i++) out.push({ position: i + 1, is_sppa_form: null, is_cv: false, looks_like: '', confidence: 'low' });
  try {
    var start = String(text || '').indexOf('{');
    var end = String(text || '').lastIndexOf('}');
    if (start < 0 || end < 0) return out;
    var p = JSON.parse(String(text).slice(start, end + 1));
    var docs = Array.isArray(p.documents) ? p.documents : [];
    docs.forEach(function (d) {
      var idx = (parseInt(d && d.position, 10) || 0) - 1;
      if (idx < 0 || idx >= count) return;
      out[idx] = {
        position: idx + 1,
        is_sppa_form: (d.is_sppa_form === true || d.is_sppa_form === false) ? d.is_sppa_form : null,
        is_cv: d.is_cv === true,
        looks_like: String(d.looks_like || '').trim(),
        confidence: ['high', 'medium', 'low'].indexOf(d.confidence) >= 0 ? d.confidence : 'low'
      };
    });
  } catch (e) { /* fall through to the defaults */ }
  return out;
}

// Slice a PDF to its first `maxPages` pages so the identity call stays small and fast — a
// scanned 13-page form is megabytes per page, and identity only needs the opening pages.
// Fails OPEN to the full buffer (encrypted/corrupt PDFs, or pdf-lib unavailable).
async function _firstPagesPdf(buffer, maxPages) {
  try {
    var PDFDocument = require('pdf-lib').PDFDocument;
    var src = await PDFDocument.load(buffer, { ignoreEncryption: true });
    if (src.getPageCount() <= maxPages) return buffer;
    var out = await PDFDocument.create();
    var idx = [];
    for (var i = 0; i < maxPages; i++) idx.push(i);
    var pages = await out.copyPages(src, idx);
    pages.forEach(function (p) { out.addPage(p); });
    return Buffer.from(await out.save());
  } catch (e) { return buffer; }
}

/**
 * Identify each document from a practice return email.
 * @param {Array<{filename:string, buffer:Buffer, mime?:string}>} docs
 * @param {Object} [opts] { apiKey, timeoutMs }
 * @returns {Promise<{docs:Array<{position,is_sppa_form,is_cv,looks_like,confidence}>, _error?:string}>}
 */
async function identifySppaDocuments(docs, opts) {
  opts = opts || {};
  docs = Array.isArray(docs) ? docs : [];
  var apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  var fallback = { docs: parseIdentifyResponse('', docs.length) };
  if (!apiKey) return Object.assign(fallback, { _error: 'no_api_key' });
  if (!docs.length) return Object.assign(fallback, { _error: 'no_docs' });

  var blocks = [];
  var totalB64 = 0;
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    if (!d || !d.buffer || !d.buffer.length) return Object.assign(fallback, { _error: 'empty_doc_' + (i + 1) });
    var buf = d.buffer;
    if (!/^image\//i.test(d.mime || '')) buf = await _firstPagesPdf(buf, 4);
    var b64 = buf.toString('base64');
    totalB64 += b64.length;
    var mime = d.mime || 'application/pdf';
    if (/^image\//i.test(mime)) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } });
    } else {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
    }
  }
  if (totalB64 > 28 * 1024 * 1024) return Object.assign(fallback, { _error: 'too_large' });

  blocks.push({ type: 'text', text: 'The ' + docs.length + ' document(s) above arrived in one email from the practice. Identify each and return the JSON verdict described in your instructions.' });

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
        max_tokens: 800,
        system: [{ type: 'text', text: IDENTIFY_SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: blocks }]
      })
    });
    if (!resp.ok) {
      var errBody = '';
      try { errBody = await resp.text(); } catch (e) {}
      return Object.assign(fallback, { _error: 'api_error_' + resp.status, _detail: errBody });
    }
    var data = await resp.json();
    var text = (data.content && data.content[0] && data.content[0].text) || '';
    return { docs: parseIdentifyResponse(text, docs.length), _model: model, _usage: data.usage || null };
  } catch (err) {
    return Object.assign(fallback, { _error: 'fetch_error: ' + err.message });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { checkSppaCompleteness, parseCompletenessResponse, COMPLETENESS_SYSTEM_PROMPT, isOnlyAltCvOutstanding, q7ConflictMismatchIssue, identifySppaDocuments, parseIdentifyResponse, IDENTIFY_SYSTEM_PROMPT };

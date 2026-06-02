'use strict';

var VALID_CATEGORIES = new Set(['signing_question', 'document_request', 'schedule_query', 'status_update', 'other']);
var VALID_URGENCY = new Set(['low', 'normal', 'high', 'urgent']);

var AHPRA_CATEGORIES = new Set(['conflict_followup', 'document_request', 'information_request', 'application_update', 'amend_document', 'other']);

var AHPRA_RESPONSE_TYPES = new Set(['direct_reply', 'request_from_gp', 'request_from_practice', 'amend_document', 'status_update', 'escalation']);

var AHPRA_TRIAGE_SYSTEM_PROMPT = [
  'You classify inbound emails from AHPRA (Australian Health Practitioner Regulation Agency) officers.',
  'You receive a list of GP candidates and one inbound email from an @ahpra.gov.au address.',
  '',
  'Your task:',
  '1. Match the email to a specific GP candidate based on the email content (name, registration number, application reference).',
  '2. Classify what the officer is requesting (category).',
  '3. Determine the correct response_type — who should handle this request.',
  '',
  'Return JSON:',
  '{',
  '  "matched_gp_user_id": string or null,',
  '  "officer_name": string,',
  '  "officer_email": string,',
  '  "confidence": number in [0,1],',
  '  "category": "conflict_followup" | "document_request" | "information_request" | "application_update" | "amend_document" | "other",',
  '  "response_type": "direct_reply" | "request_from_gp" | "request_from_practice" | "amend_document" | "status_update" | "escalation",',
  '  "summary": string (one sentence describing what the officer wants),',
  '  "requested_documents": [string] (if category is document_request),',
  '  "amend_target": { "document": string, "section": string, "field": string, "owner": "rso"|"gp"|"practice" } or null (if category is amend_document),',
  '  "on_file_documents": [string] (document keys the RSO already has that can answer this request),',
  '  "draft_response": string or null (suggested reply text for direct_reply type),',
  '  "response_deadline": "YYYY-MM-DD" or null (extract any deadline mentioned, e.g. "within 14 days", "by 15 June 2026", "no later than 29 August 2026"),',
  '  "needs_triage": boolean',
  '}',
  '',
  'RESPONSE_TYPE RULES:',
  '',
  'direct_reply — The RSO (registration support officer) can answer this directly using documents/information already on file. Use this when:',
  '  - AHPRA asks for clarification about supervised practice hours, supervision frequency, practice arrangements → RSO checks SPPA-00',
  '  - AHPRA asks for clarification about the role or practice → RSO checks Position Description',
  '  - AHPRA asks for clarification about supervisor qualifications → RSO checks Supervisor CV',
  '  - AHPRA asks for clarification about employment terms → RSO checks Offer/Contract',
  '  - AHPRA asks for clarification about conflict of interest → RSO checks SPPA-00 Q6-Q8 and conflict scan metadata',
  '  - AHPRA requests documents that are already on file (SPPA-00, Position Description, Supervisor CV, Offer/Contract, primary medical degree, MRCGP, CCT)',
  '',
  'request_from_gp — The RSO needs something from the GP that is NOT on file:',
  '  - Professional indemnity insurance certificate',
  '  - Fresh certified copies of qualifications',
  '  - Police clearance / criminal history check',
  '  - English language test results (IELTS/OET)',
  '  - Any personal document the GP must provide themselves',
  '',
  'request_from_practice — The RSO needs something from the medical practice:',
  '  - Practice conflict management letter / statement',
  '  - Practice accreditation evidence',
  '  - Alternate supervisor details or CVs',
  '  - Updated employment details from the practice',
  '',
  'amend_document — AHPRA says a specific document field/section is incorrect and needs to be fixed:',
  '  - If the field is in SPPA-00 Sections A or I → owner is "gp"',
  '  - If the field is in SPPA-00 Sections B-E, F, J, K → owner is "practice"',
  '  - If the field is in SPPA-00 Q6-Q8, Q17, Q18, Q19 → owner is "rso" (RSO pre-filled these)',
  '  - If it is another document (Position Description, Section G) → owner is "rso"',
  '  - Set amend_target with the document name, section/question reference, and owner',
  '',
  'status_update — AHPRA is providing a status notification, no action needed:',
  '  - Application received/acknowledged',
  '  - Application referred to committee',
  '  - Registration approved / conditional / refused',
  '',
  'escalation — Serious issue requiring CEO review:',
  '  - Registration refused or revoked',
  '  - Legal concerns raised',
  '  - Compliance issues flagged',
  '  - Anything outside normal registration flow',
  '',
  'DOCUMENTS ON FILE (use these keys in on_file_documents):',
  '  sppa_00, position_description, offer_contract, supervisor_cv, section_g,',
  '  primary_medical_degree, mrcgp_certificate, cct_certificate, alt_supervisor_cv_1, alt_supervisor_cv_2',
  '',
  'Set needs_triage=true when confidence < 0.7 or when the email cannot be matched to a GP.'
].join('\n');

var TRIAGE_SYSTEM_PROMPT = [
  'You classify inbound emails related to placed GPs at GP Link.',
  'You receive a compact list of placed GPs and one inbound email.',
  'Return JSON:',
  '{',
  '  "matched_gp_user_id": string or null,',
  '  "confidence": number in [0,1],',
  '  "category": "signing_question" | "document_request" | "schedule_query" | "status_update" | "other",',
  '  "urgency": "low" | "normal" | "high",',
  '  "summary": string (one sentence),',
  '  "needs_triage": boolean',
  '}',
  'Set needs_triage=true when confidence < 0.7 or when the email is about a GP not in the provided list.',
  'Only match a GP if sender or subject or body clearly references that GP, their practice, their contact, or their signing envelope.'
].join('\n');

function buildTriagePrompt(email, placedGPs) {
  var emailSummary = {
    from: email.sender,
    subject: email.subject,
    date: email.date,
    body_snippet: String(email.bodyText || email.body || '').slice(0, 4000)
  };
  return 'PLACED_GPS:\n' + JSON.stringify(placedGPs || [], null, 2) + '\n\nEMAIL:\n' + JSON.stringify(emailSummary, null, 2) + '\n\nReturn JSON only.';
}

function parseTriageResponse(text) {
  var defaults = { matched_gp_user_id: null, confidence: 0, category: 'other', urgency: 'low', summary: '', needs_triage: true };
  try {
    var start = String(text || '').indexOf('{');
    var end = String(text || '').lastIndexOf('}');
    if (start < 0 || end < 0) return defaults;
    var parsed = JSON.parse(String(text).slice(start, end + 1));
    var confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    var category = VALID_CATEGORIES.has(parsed.category) ? parsed.category : 'other';
    var urgency = VALID_URGENCY.has(parsed.urgency) ? parsed.urgency : 'low';
    var matchedUserId = parsed.matched_gp_user_id ? String(parsed.matched_gp_user_id) : null;
    var needsTriage = (confidence < 0.7) || !!parsed.needs_triage || !matchedUserId;
    return {
      matched_gp_user_id: matchedUserId,
      confidence: confidence,
      category: category,
      urgency: urgency,
      summary: String(parsed.summary || ''),
      needs_triage: needsTriage
    };
  } catch (e) {
    return defaults;
  }
}

async function triageEmailWithSonnet(email, placedGPs, opts) {
  opts = opts || {};
  var apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Object.assign(parseTriageResponse(''), { _error: 'no_api_key' });
  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, 30000);
  try {
    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-20250514',
        max_tokens: 400,
        system: [{ type: 'text', text: TRIAGE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: buildTriagePrompt(email, placedGPs) }]
      })
    });
    if (!resp.ok) return Object.assign(parseTriageResponse(''), { _error: 'api_error_' + resp.status });
    var data = await resp.json();
    var text = (data.content && data.content[0] && data.content[0].text) || '';
    var parsed = parseTriageResponse(text);
    parsed._usage = data.usage || null;
    return parsed;
  } catch (err) {
    return Object.assign(parseTriageResponse(''), { _error: 'fetch_error: ' + err.message });
  } finally {
    clearTimeout(timeout);
  }
}

function buildAhpraTriagePrompt(email, gpCandidates) {
  var emailSummary = {
    from: email.sender,
    subject: email.subject,
    date: email.date,
    body_snippet: String(email.bodyText || email.body || '').slice(0, 6000)
  };
  return 'GP_CANDIDATES:\n' + JSON.stringify(gpCandidates || [], null, 2) + '\n\nAHPRA_EMAIL:\n' + JSON.stringify(emailSummary, null, 2) + '\n\nReturn JSON only.';
}

function parseAhpraTriageResponse(text) {
  var defaults = {
    matched_gp_user_id: null,
    officer_name: '',
    officer_email: '',
    confidence: 0,
    category: 'other',
    response_type: 'request_from_gp',
    summary: '',
    requested_documents: [],
    amend_target: null,
    on_file_documents: [],
    draft_response: null,
    response_deadline: null,
    needs_triage: true
  };
  try {
    var start = String(text || '').indexOf('{');
    var end = String(text || '').lastIndexOf('}');
    if (start < 0 || end < 0) return defaults;
    var parsed = JSON.parse(String(text).slice(start, end + 1));
    var confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    var category = AHPRA_CATEGORIES.has(parsed.category) ? parsed.category : 'other';
    var responseType = AHPRA_RESPONSE_TYPES.has(parsed.response_type) ? parsed.response_type : 'request_from_gp';
    var matchedUserId = parsed.matched_gp_user_id ? String(parsed.matched_gp_user_id) : null;
    var needsTriage = (confidence < 0.7) || !!parsed.needs_triage || !matchedUserId;
    var responseDeadline = parsed.response_deadline && /^\d{4}-\d{2}-\d{2}$/.test(parsed.response_deadline) ? parsed.response_deadline : null;
    return {
      matched_gp_user_id: matchedUserId,
      officer_name: String(parsed.officer_name || '').trim(),
      officer_email: String(parsed.officer_email || '').trim(),
      confidence: confidence,
      category: category,
      response_type: responseType,
      summary: String(parsed.summary || '').trim(),
      requested_documents: Array.isArray(parsed.requested_documents) ? parsed.requested_documents.map(String) : [],
      amend_target: (parsed.amend_target && typeof parsed.amend_target === 'object') ? parsed.amend_target : null,
      on_file_documents: Array.isArray(parsed.on_file_documents) ? parsed.on_file_documents.map(String) : [],
      draft_response: parsed.draft_response ? String(parsed.draft_response).trim() : null,
      response_deadline: responseDeadline,
      needs_triage: needsTriage
    };
  } catch (e) {
    return defaults;
  }
}

async function triageAhpraEmail(email, gpCandidates, opts) {
  opts = opts || {};
  var apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Object.assign(parseAhpraTriageResponse(''), { _error: 'no_api_key' });
  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, 60000);
  try {
    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 800,
        system: [{ type: 'text', text: AHPRA_TRIAGE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: buildAhpraTriagePrompt(email, gpCandidates) }]
      })
    });
    if (!resp.ok) return Object.assign(parseAhpraTriageResponse(''), { _error: 'api_error_' + resp.status });
    var data = await resp.json();
    var text = (data.content && data.content[0] && data.content[0].text) || '';
    var parsed = parseAhpraTriageResponse(text);
    parsed._usage = data.usage || null;
    return parsed;
  } catch (err) {
    return Object.assign(parseAhpraTriageResponse(''), { _error: 'fetch_error: ' + err.message });
  } finally {
    clearTimeout(timeout);
  }
}

function isAhpraEmail(senderEmail) {
  return /@ahpra\.gov\.au$/i.test(String(senderEmail || '').trim());
}

module.exports = {
  triageEmailWithSonnet, parseTriageResponse, buildTriagePrompt, TRIAGE_SYSTEM_PROMPT,
  triageAhpraEmail, parseAhpraTriageResponse, buildAhpraTriagePrompt, isAhpraEmail, AHPRA_TRIAGE_SYSTEM_PROMPT
};

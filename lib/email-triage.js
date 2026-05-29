'use strict';

var VALID_CATEGORIES = new Set(['signing_question', 'document_request', 'schedule_query', 'status_update', 'other']);
var VALID_URGENCY = new Set(['low', 'normal', 'high', 'urgent']);

var AHPRA_CATEGORIES = new Set(['conflict_followup', 'document_request', 'information_request', 'application_update', 'other']);

var AHPRA_TRIAGE_SYSTEM_PROMPT = [
  'You classify inbound emails from AHPRA (Australian Health Practitioner Regulation Agency) officers.',
  'You receive a list of GP candidates and one inbound email from an @ahpra.gov.au address.',
  'Your task:',
  '1. Match the email to a specific GP candidate based on the email content (name, registration number, application reference). Do NOT match based on the officer — one officer can handle many GPs.',
  '2. Classify what the officer is requesting.',
  '',
  'Return JSON:',
  '{',
  '  "matched_gp_user_id": string or null,',
  '  "officer_name": string,',
  '  "officer_email": string,',
  '  "confidence": number in [0,1],',
  '  "category": "conflict_followup" | "document_request" | "information_request" | "application_update" | "other",',
  '  "summary": string (one sentence describing what the officer wants),',
  '  "requested_documents": [string] (list of document names if category is document_request, else empty array),',
  '  "needs_triage": boolean',
  '}',
  '',
  'Category guide:',
  '- conflict_followup: officer is asking about conflicts of interest, supervisor-owner relationships',
  '- document_request: officer is requesting specific documents be provided',
  '- information_request: officer is asking questions about the application or candidate',
  '- application_update: officer is providing a status update, approval, or feedback',
  '- other: none of the above',
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
        model: 'claude-sonnet-4-6',
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
    summary: '',
    requested_documents: [],
    needs_triage: true
  };
  try {
    var start = String(text || '').indexOf('{');
    var end = String(text || '').lastIndexOf('}');
    if (start < 0 || end < 0) return defaults;
    var parsed = JSON.parse(String(text).slice(start, end + 1));
    var confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    var category = AHPRA_CATEGORIES.has(parsed.category) ? parsed.category : 'other';
    var matchedUserId = parsed.matched_gp_user_id ? String(parsed.matched_gp_user_id) : null;
    var needsTriage = (confidence < 0.7) || !!parsed.needs_triage || !matchedUserId;
    return {
      matched_gp_user_id: matchedUserId,
      officer_name: String(parsed.officer_name || '').trim(),
      officer_email: String(parsed.officer_email || '').trim(),
      confidence: confidence,
      category: category,
      summary: String(parsed.summary || '').trim(),
      requested_documents: Array.isArray(parsed.requested_documents) ? parsed.requested_documents.map(String) : [],
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

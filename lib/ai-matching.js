// lib/ai-matching.js
'use strict';

const AI_MATCH_SYSTEM_PROMPT = [
  'You are a document-matching assistant for GP Link, a medical recruitment company that helps overseas GPs register in Australia.',
  'An email has arrived with attachments. Match each attachment to the correct open task.',
  'You receive a list of open tasks (each with task_id, document_type, gp_name, practice details) and one inbound email with attachment filenames.',
  'Return ONLY a JSON object (no markdown, no explanation):',
  '{ "matches": [{"attachment_index": 0, "task_id": "xxx" or null, "document_type": "offer_contract" or "supervisor_cv", "confidence": 0.0-1.0, "reasoning": "brief explanation"}], "is_relevant": true/false, "summary": "one-line description" }',
  'Rules:',
  '- Match based on sender domain vs practice email domain, GP names in subject/body/filename, document type clues',
  '- If sender domain matches a practice contact\'s domain, that\'s a strong signal',
  '- "offer", "contract", "agreement", "employment" in filename → likely offer_contract',
  '- "cv", "curriculum", "resume", "supervisor" in filename → likely supervisor_cv',
  '- If you cannot confidently match, set task_id to null',
  '- Confidence: 0.9+ exact match, 0.7-0.9 strong signals, 0.5-0.7 partial, <0.5 uncertain',
  '- If the email is completely unrelated to GP recruitment documents, set is_relevant to false'
].join('\n');

// ── WP-20 (Australian GP build, DAT-27) ──────────────────────────────────────
// A doctor who is already registered and working in Australia has pre-start
// tasks that wait on a document too: their indemnity certificate of currency
// and the letter with the provider number for the new practice. Those tasks
// are in the open-task list only with the switch on, and each carries
// `pathway: 'australian_gp'` (server.js auOpenPrestartDocTasksForMatching).
//
// When the list holds at least one of them the model gets the prompt below;
// otherwise it gets AI_MATCH_SYSTEM_PROMPT, byte for byte. The keys are WP-07's
// (lib/document-requirements.js): never a new name for the same document.
var AU_TASK_PATHWAY = 'australian_gp';
var AU_MATCH_DOCUMENT_TYPES = ['au_indemnity_certificate', 'au_provider_number_letter'];
var OVERSEAS_MATCH_DOCUMENT_TYPES = ['offer_contract', 'supervisor_cv'];

var AI_MATCH_SYSTEM_PROMPT_AU = [
  'You are a document-matching assistant for GP Link, a medical recruitment company.',
  'Each open task belongs to one doctor. A task marked "pathway": "australian_gp" is for a GP who is already registered with Ahpra and working in Australia and is changing practice. Every other task is for a GP registering to work in Australia.',
  'An email has arrived with attachments. Match each attachment to the correct open task.',
  'You receive a list of open tasks (each with task_id, document_type, gp_name, practice details) and one inbound email with attachment filenames.',
  'Return ONLY a JSON object (no markdown, no explanation):',
  '{ "matches": [{"attachment_index": 0, "task_id": "xxx" or null, "document_type": "offer_contract" or "supervisor_cv" or "au_indemnity_certificate" or "au_provider_number_letter", "confidence": 0.0-1.0, "reasoning": "brief explanation"}], "is_relevant": true/false, "summary": "one-line description" }',
  'Rules:',
  '- Match based on sender domain vs practice email domain, GP names in subject/body/filename, document type clues',
  '- If sender domain matches a practice contact\'s domain, that\'s a strong signal',
  '- "offer", "contract", "agreement", "employment" in filename → likely offer_contract',
  '- "cv", "curriculum", "resume", "supervisor" in filename → likely supervisor_cv',
  '- "indemnity", "certificate of currency", "professional indemnity", or a medical indemnity insurer\'s name in the filename, subject or sender → likely au_indemnity_certificate',
  '- "provider number", "Medicare provider", "Services Australia" in the filename, subject or sender → likely au_provider_number_letter',
  '- An attachment may ONLY be matched to a task whose own document_type is the type you chose. Never match an indemnity certificate or a provider number letter to an offer_contract or supervisor_cv task, or the other way round.',
  '- A task marked "pathway": "australian_gp" only ever takes au_indemnity_certificate or au_provider_number_letter. A task without that mark never takes them.',
  '- The doctor themselves may be the sender for an "australian_gp" task (they email their own certificate or letter). Match on their name.',
  '- If you cannot confidently match, set task_id to null',
  '- Confidence: 0.9+ exact match, 0.7-0.9 strong signals, 0.5-0.7 partial, <0.5 uncertain',
  '- If the email is completely unrelated to GP recruitment documents, set is_relevant to false'
].join('\n');

function hasAuTask(openTasks) {
  return Array.isArray(openTasks) && openTasks.some(function (t) { return t && t.pathway === AU_TASK_PATHWAY; });
}

/** The system prompt for this list of open tasks: the Australian one only when the list holds an Australian task. */
function matchSystemPromptFor(openTasks) {
  return hasAuTask(openTasks) ? AI_MATCH_SYSTEM_PROMPT_AU : AI_MATCH_SYSTEM_PROMPT;
}

/**
 * The server-side net under the Australian prompt (a model can ignore a rule):
 * a match is kept only when the document type it names is the matched task's
 * own type. An indemnity certificate can never land on a contract task, and a
 * contract can never land on an Australian doctor's pre-start task. A match
 * that fails keeps its row with task_id null (so the email is still shown to a
 * person as unmatched) and says why.
 *
 * Only ever called for a list that holds an Australian task; a list of
 * overseas tasks is parsed exactly as before.
 */
function enforceMatchDocumentTypes(parsed, openTasks) {
  var byId = {};
  (Array.isArray(openTasks) ? openTasks : []).forEach(function (t) { if (t && t.task_id != null) byId[String(t.task_id)] = t; });
  var out = Object.assign({}, parsed);
  out.matches = (Array.isArray(parsed && parsed.matches) ? parsed.matches : []).map(function (m) {
    if (!m || m.task_id == null || m.task_id === '') return m;
    var task = byId[String(m.task_id)];
    var named = String(m.document_type || '');
    var namedIsAu = AU_MATCH_DOCUMENT_TYPES.indexOf(named) !== -1;
    var isAuTask = !!task && task.pathway === AU_TASK_PATHWAY;
    var ok;
    if (isAuTask) {
      // An Australian task takes exactly its own document type, nothing else.
      ok = namedIsAu && named === String(task.document_type || '');
    } else {
      // Any other task (and an id the model made up) is treated exactly as it
      // always was, unless the model named an Australian document type for it.
      ok = !namedIsAu;
    }
    if (ok) return m;
    return Object.assign({}, m, { task_id: null, rejected_reason: 'document_type_mismatch' });
  });
  return out;
}

function buildAIMatchUserPrompt(emailMeta, openTasks) {
  var tasksSection = (openTasks && openTasks.length > 0)
    ? JSON.stringify(openTasks, null, 2)
    : 'No open tasks currently waiting for documents.';

  return 'EMAIL:\n'
    + '- From: ' + (emailMeta.sender || '') + (emailMeta.senderName ? ' (' + emailMeta.senderName + ')' : '') + '\n'
    + '- To: ' + (emailMeta.to || '') + '\n'
    + '- Subject: ' + (emailMeta.subject || '') + '\n'
    + '- Date: ' + (emailMeta.date || '') + '\n'
    + '- Body (first 2000 chars): ' + String(emailMeta.body || emailMeta.bodyText || '').slice(0, 2000) + '\n'
    + '- Attachments: ' + JSON.stringify((emailMeta.attachments || []).map(function (a) { return { index: a.index, filename: a.filename, mime_type: a.mimeType, size_bytes: a.size }; })) + '\n\n'
    + 'OPEN TASKS WAITING FOR DOCUMENTS:\n' + tasksSection + '\n\n'
    + 'Return the JSON described in the system prompt only.';
}

function parseAIMatchResponse(raw) {
  try {
    var cleaned = String(raw || '').trim();
    var codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();
    var jsonStart = cleaned.indexOf('{');
    var jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < 0) return { matches: [], is_relevant: false, summary: 'parse_fail' };
    var parsed = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
    return {
      matches: Array.isArray(parsed.matches) ? parsed.matches : [],
      is_relevant: parsed.is_relevant === true,
      summary: String(parsed.summary || '')
    };
  } catch (e) {
    return { matches: [], is_relevant: false, summary: 'parse_error: ' + e.message };
  }
}

async function aiMatchEmail(emailMeta, openTasks, opts) {
  opts = opts || {};
  var apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { matches: [], is_relevant: false, summary: 'no api key' };
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
        model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-6',
        max_tokens: 1000,
        system: [{ type: 'text', text: matchSystemPromptFor(openTasks), cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: buildAIMatchUserPrompt(emailMeta, openTasks) }]
      })
    });
    if (!resp.ok) {
      console.error('[Gmail AI] Anthropic API error:', resp.status);
      return { matches: [], is_relevant: false, summary: 'API error ' + resp.status };
    }
    var data = await resp.json();
    var text = (data.content && data.content[0] && data.content[0].text) || '';
    var parsed = parseAIMatchResponse(text);
    // WP-20: only when an Australian doctor's task was in the list.
    if (hasAuTask(openTasks)) parsed = enforceMatchDocumentTypes(parsed, openTasks);
    parsed._usage = data.usage || null;
    return parsed;
  } catch (err) {
    console.error('[Gmail AI] match error:', err.message);
    return { matches: [], is_relevant: false, summary: 'fetch error: ' + err.message };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  aiMatchEmail, AI_MATCH_SYSTEM_PROMPT, buildAIMatchUserPrompt, parseAIMatchResponse,
  // WP-20
  AI_MATCH_SYSTEM_PROMPT_AU, AU_TASK_PATHWAY, AU_MATCH_DOCUMENT_TYPES, OVERSEAS_MATCH_DOCUMENT_TYPES,
  matchSystemPromptFor, enforceMatchDocumentTypes, hasAuTask
};

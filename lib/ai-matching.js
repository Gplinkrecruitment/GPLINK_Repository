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
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: [{ type: 'text', text: AI_MATCH_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
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
    parsed._usage = data.usage || null;
    return parsed;
  } catch (err) {
    console.error('[Gmail AI] match error:', err.message);
    return { matches: [], is_relevant: false, summary: 'fetch error: ' + err.message };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { aiMatchEmail, AI_MATCH_SYSTEM_PROMPT, buildAIMatchUserPrompt, parseAIMatchResponse };

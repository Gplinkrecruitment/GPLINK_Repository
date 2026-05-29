'use strict';

var CONFLICT_SCAN_SYSTEM_PROMPT = [
  'You are a document analyst for GP Link, an Australian GP recruitment platform.',
  'You will receive up to four inputs:',
  '1. A Supervisor CV (PDF or image)',
  '2. An Offer/Contract between a GP candidate and a medical practice (PDF or image)',
  '3. An MRCGP certificate belonging to the GP candidate (PDF or image) — this is the most authoritative source for the candidate\'s name',
  '4. The GP candidate\'s name from their registration profile (text)',
  '',
  'Your task:',
  '1. Extract the supervisor\'s full name from the CV.',
  '2. Extract the employer, director, signatory, owner, or principal name(s) from the contract. Look for labels like "director", "owner", "principal", "employer", "signatory", or the signing block at the end.',
  '3. Extract the GP candidate\'s name from the MRCGP certificate and cross-check with the contract — the candidate appears in the contract as the "consultant", "employee", or "contractor". Use fuzzy matching across all name sources to reliably identify which person is the candidate.',
  '4. After excluding the candidate, compare the supervisor name from the CV against the practice owner/director/signatory from the contract.',
  '5. If the supervisor and the practice owner/director are the same person (or very likely the same person with minor name variations), this is a conflict of interest.',
  '',
  'Return ONLY valid JSON:',
  '{',
  '  "supervisor_name": "Full name from CV",',
  '  "practice_owner_name": "Full name of director/owner/signatory from contract",',
  '  "candidate_name": "Full name of GP candidate (best match across all sources)",',
  '  "is_conflict": true/false,',
  '  "confidence": "high" | "medium" | "low",',
  '  "reasoning": "One or two sentences explaining your determination"',
  '}'
].join('\n');

function parseConflictScanResponse(text) {
  var defaults = {
    supervisor_name: '',
    practice_owner_name: '',
    candidate_name: '',
    is_conflict: false,
    confidence: 'low',
    reasoning: 'Could not parse AI response'
  };
  try {
    var start = String(text || '').indexOf('{');
    var end = String(text || '').lastIndexOf('}');
    if (start < 0 || end < 0) return defaults;
    var parsed = JSON.parse(String(text).slice(start, end + 1));
    var validConfidence = ['high', 'medium', 'low'];
    return {
      supervisor_name: String(parsed.supervisor_name || '').trim(),
      practice_owner_name: String(parsed.practice_owner_name || '').trim(),
      candidate_name: String(parsed.candidate_name || '').trim(),
      is_conflict: !!parsed.is_conflict,
      confidence: validConfidence.includes(parsed.confidence) ? parsed.confidence : 'low',
      reasoning: String(parsed.reasoning || '').trim()
    };
  } catch (e) {
    return defaults;
  }
}

async function scanForConflict(params, opts) {
  opts = opts || {};
  var apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Object.assign(parseConflictScanResponse(''), { _error: 'no_api_key' });
  }

  var contentBlocks = [];

  contentBlocks.push({ type: 'text', text: '## Supervisor CV (Document 1)' });
  var cvMediaType = params.supervisorCvMime || 'application/pdf';
  if (/pdf/i.test(cvMediaType)) {
    contentBlocks.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: params.supervisorCvBuffer.toString('base64') }
    });
  } else {
    contentBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: cvMediaType, data: params.supervisorCvBuffer.toString('base64') }
    });
  }

  contentBlocks.push({ type: 'text', text: '## Offer/Contract (Document 2)' });
  var contractMediaType = params.contractMime || 'application/pdf';
  if (/pdf/i.test(contractMediaType)) {
    contentBlocks.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: params.contractBuffer.toString('base64') }
    });
  } else {
    contentBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: contractMediaType, data: params.contractBuffer.toString('base64') }
    });
  }

  if (params.mrcgpBuffer) {
    contentBlocks.push({ type: 'text', text: '## MRCGP Certificate (Document 3) — authoritative candidate name source' });
    var mrcgpMediaType = params.mrcgpMime || 'application/pdf';
    if (/pdf/i.test(mrcgpMediaType)) {
      contentBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: params.mrcgpBuffer.toString('base64') }
      });
    } else {
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mrcgpMediaType, data: params.mrcgpBuffer.toString('base64') }
      });
    }
  }

  contentBlocks.push({
    type: 'text',
    text: '## Candidate profile name (fallback)\n' + (params.candidateName || 'Not provided')
  });

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
        system: [{ type: 'text', text: CONFLICT_SCAN_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: contentBlocks }]
      })
    });
    if (!resp.ok) {
      var errBody = '';
      try { errBody = await resp.text(); } catch (e) {}
      return Object.assign(parseConflictScanResponse(''), { _error: 'api_error_' + resp.status, _detail: errBody });
    }
    var data = await resp.json();
    var text = (data.content && data.content[0] && data.content[0].text) || '';
    var parsed = parseConflictScanResponse(text);
    parsed._usage = data.usage || null;
    return parsed;
  } catch (err) {
    return Object.assign(parseConflictScanResponse(''), { _error: 'fetch_error: ' + err.message });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { scanForConflict, parseConflictScanResponse, CONFLICT_SCAN_SYSTEM_PROMPT };

'use strict';

var zlib = require('zlib');

var VALID_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Extract text from a .docx buffer by unzipping and parsing the XML.
 * docx files are ZIP archives containing word/document.xml with the body text.
 */
function extractTextFromDocx(buffer) {
  try {
    // Find ZIP local file headers and locate word/document.xml
    var entries = [];
    var pos = 0;
    while (pos < buffer.length - 4) {
      if (buffer.readUInt32LE(pos) === 0x04034b50) { // local file header
        var compMethod = buffer.readUInt16LE(pos + 8);
        var compSize = buffer.readUInt32LE(pos + 18);
        var uncompSize = buffer.readUInt32LE(pos + 22);
        var nameLen = buffer.readUInt16LE(pos + 26);
        var extraLen = buffer.readUInt16LE(pos + 28);
        var name = buffer.slice(pos + 30, pos + 30 + nameLen).toString('utf8');
        var dataStart = pos + 30 + nameLen + extraLen;
        var dataEnd = dataStart + compSize;
        entries.push({ name: name, compMethod: compMethod, data: buffer.slice(dataStart, dataEnd), uncompSize: uncompSize });
        pos = dataEnd;
      } else {
        pos++;
      }
    }
    var docEntry = entries.find(function (e) { return e.name === 'word/document.xml'; });
    if (!docEntry) return null;
    var xml;
    if (docEntry.compMethod === 8) { // deflate
      xml = zlib.inflateRawSync(docEntry.data).toString('utf8');
    } else {
      xml = docEntry.data.toString('utf8');
    }
    // Strip XML tags and extract text
    var text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text.slice(0, 8000); // cap at 8000 chars
  } catch (e) {
    return null;
  }
}

/**
 * Build a content block for a document buffer.
 * Handles PDF (as document), images (as image), docx (extract text), and unknown (skip).
 */
function buildDocContentBlock(buffer, mimeType) {
  if (/pdf/i.test(mimeType)) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
  }
  if (VALID_IMAGE_TYPES.has(mimeType)) {
    return { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } };
  }
  // Try docx text extraction for Word documents
  if (/wordprocessingml|msword|\.docx?/i.test(mimeType)) {
    var text = extractTextFromDocx(buffer);
    if (text) return { type: 'text', text: '[Extracted text from Word document]\n' + text };
  }
  return null;
}

var CONFLICT_SCAN_SYSTEM_PROMPT = [
  'You are a document analyst for GP Link, an Australian GP recruitment platform.',
  'You will receive up to four inputs:',
  '1. A Supervisor CV (PDF, image, or extracted text from a Word document)',
  '2. An Offer/Contract between a GP candidate and a medical practice (PDF, image, or extracted text)',
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

  // 1. Supervisor CV
  contentBlocks.push({ type: 'text', text: '## Supervisor CV (Document 1)' });
  var cvBlock = buildDocContentBlock(params.supervisorCvBuffer, params.supervisorCvMime || 'application/pdf');
  if (cvBlock) contentBlocks.push(cvBlock);

  // 2. Offer/Contract
  contentBlocks.push({ type: 'text', text: '## Offer/Contract (Document 2)' });
  var contractBlock = buildDocContentBlock(params.contractBuffer, params.contractMime || 'application/pdf');
  if (contractBlock) contentBlocks.push(contractBlock);

  // 3. MRCGP certificate (optional)
  if (params.mrcgpBuffer) {
    contentBlocks.push({ type: 'text', text: '## MRCGP Certificate (Document 3) — authoritative candidate name source' });
    var mrcgpBlock = buildDocContentBlock(params.mrcgpBuffer, params.mrcgpMime || 'application/pdf');
    if (mrcgpBlock) contentBlocks.push(mrcgpBlock);
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

'use strict';

// AI vision check run when the GP/candidate returns the SPPA-00. It reads the
// returned form and confirms the candidate completed the two parts they are
// responsible for: Section A Question 1 (their personal details) and Section I
// (the Supervisee's declaration — signed and dated). The result is surfaced to
// the admin so they can see at a glance whether the candidate actually filled
// their sections before the form is sent on to the practice.

var VALID_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function buildDocContentBlock(buffer, mimeType) {
  if (/pdf/i.test(mimeType)) {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
  }
  if (VALID_IMAGE_TYPES.has(mimeType)) {
    return { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } };
  }
  return null;
}

var GP_SECTION_SCAN_SYSTEM_PROMPT = [
  'You are a document analyst for GP Link, an Australian GP recruitment platform.',
  'You will receive a returned SPPA-00 (Supervised Practice Plan Agreement) form that a GP candidate (the "supervisee") has filled in and returned.',
  '',
  'The candidate is ONLY responsible for two parts of this form:',
  '1. Section A, Question 1 — the candidate\'s personal details (their full name, and any other fields in that question such as AHPRA/registration number, date of birth, contact details). The practice/supervisor completes the rest of the form (Sections B onward) later — do NOT penalise those being blank.',
  '2. Section I — the "Supervisee\'s declaration". The candidate must SIGN and DATE this section. A signature can be handwritten, typed, or an inserted image; treat a clearly present name + date in the declaration signature area as signed.',
  '',
  'Carefully read the actual form. For each of the two candidate parts decide whether it has been completed.',
  'Be practical, not pedantic: if Section A Q1 has the candidate\'s name and the obviously-required identifying details filled, it is filled. If Section I has a signature (any form) and a date, it is signed. If a part is clearly empty, mark it not done. If the form is unreadable or you genuinely cannot tell, say so and lower your confidence.',
  '',
  'Return ONLY valid JSON in exactly this shape:',
  '{',
  '  "section_a_filled": true/false,',
  '  "section_a_notes": "Brief plain-English note on what you saw in Section A Q1 (e.g. which details are present or missing)",',
  '  "section_i_signed": true/false,',
  '  "section_i_notes": "Brief plain-English note on the Section I signature/date (present? whose name? dated?)",',
  '  "candidate_name_detected": "The candidate name as written on the form, or empty string",',
  '  "overall": "complete" | "incomplete" | "unclear",',
  '  "confidence": "high" | "medium" | "low",',
  '  "summary": "One or two plain sentences an admin can read to know if the candidate filled their sections correctly"',
  '}',
  '"overall" is "complete" only when BOTH section_a_filled and section_i_signed are true. Use "unclear" when you cannot reliably read the relevant sections.'
].join('\n');

function parseGpSectionScanResponse(text) {
  var defaults = {
    section_a_filled: false,
    section_a_notes: '',
    section_i_signed: false,
    section_i_notes: '',
    candidate_name_detected: '',
    overall: 'unclear',
    confidence: 'low',
    summary: 'Could not parse AI response'
  };
  try {
    var s = String(text || '');
    var start = s.indexOf('{');
    var end = s.lastIndexOf('}');
    if (start < 0 || end < 0) return defaults;
    var parsed = JSON.parse(s.slice(start, end + 1));
    var validConfidence = ['high', 'medium', 'low'];
    var validOverall = ['complete', 'incomplete', 'unclear'];
    return {
      section_a_filled: !!parsed.section_a_filled,
      section_a_notes: String(parsed.section_a_notes || '').trim(),
      section_i_signed: !!parsed.section_i_signed,
      section_i_notes: String(parsed.section_i_notes || '').trim(),
      candidate_name_detected: String(parsed.candidate_name_detected || '').trim(),
      overall: validOverall.includes(parsed.overall) ? parsed.overall : 'unclear',
      confidence: validConfidence.includes(parsed.confidence) ? parsed.confidence : 'low',
      summary: String(parsed.summary || '').trim()
    };
  } catch (e) {
    return defaults;
  }
}

/**
 * Run the GP-section completeness scan on a returned SPPA-00.
 * @param {{ pdfBuffer: Buffer, pdfMime?: string, candidateName?: string }} params
 * @param {{ apiKey?: string }} [opts]
 */
async function scanGpSections(params, opts) {
  opts = opts || {};
  var apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Object.assign(parseGpSectionScanResponse(''), { _error: 'no_api_key' });
  }
  var docBlock = buildDocContentBlock(params.pdfBuffer, params.pdfMime || 'application/pdf');
  if (!docBlock) {
    return Object.assign(parseGpSectionScanResponse(''), { _error: 'unsupported_document' });
  }

  var contentBlocks = [
    { type: 'text', text: '## Returned SPPA-00 form (completed by the GP candidate)' },
    docBlock,
    { type: 'text', text: '## Candidate name on file (for cross-checking)\n' + (params.candidateName || 'Not provided') }
  ];

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
        model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-6',
        max_tokens: 800,
        system: [{ type: 'text', text: GP_SECTION_SCAN_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: contentBlocks }]
      })
    });
    if (!resp.ok) {
      var errBody = '';
      try { errBody = await resp.text(); } catch (e) {}
      return Object.assign(parseGpSectionScanResponse(''), { _error: 'api_error_' + resp.status, _detail: errBody });
    }
    var data = await resp.json();
    var text = (data.content && data.content[0] && data.content[0].text) || '';
    var parsed = parseGpSectionScanResponse(text);
    parsed._usage = data.usage || null;
    return parsed;
  } catch (err) {
    return Object.assign(parseGpSectionScanResponse(''), { _error: 'fetch_error: ' + err.message });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { scanGpSections, parseGpSectionScanResponse, GP_SECTION_SCAN_SYSTEM_PROMPT };

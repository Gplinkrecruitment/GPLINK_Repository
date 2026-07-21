'use strict';

const { interpretAltCvMatch } = require('./alt-supervisor-cv-recover.js');

/**
 * Use Claude API to extract the person's name from a CV document and check
 * if it matches any known alternate supervisor names from the SPPA-00.
 *
 * @param {Buffer} cvBuffer - The CV file content
 * @param {string} mimeType - MIME type (application/pdf, image/*, application/vnd.openxmlformats-officedocument.wordprocessingml.document)
 * @param {string[]} altSupervisorNames - Known alt supervisor names from SPPA-00
 * @returns {Promise<{matched: boolean, cvName: string, matchedSupervisor: string, confidence: number}|null>}
 */
async function matchCvToAltSupervisor(cvBuffer, mimeType, altSupervisorNames) {
  if (!process.env.ANTHROPIC_API_KEY || !altSupervisorNames || altSupervisorNames.length === 0) return null;

  var b64 = cvBuffer.toString('base64');
  // Skip if file too large for API
  if (b64.length > 5 * 1024 * 1024) return null;

  var contentParts = [];

  // Build the document content block based on mime type
  if (mimeType === 'application/pdf') {
    contentParts.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
  } else if (mimeType && mimeType.startsWith('image/')) {
    contentParts.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: b64 } });
  } else {
    // For docx or other formats, try to extract text first
    try {
      var text = extractTextFromDocx(cvBuffer);
      if (text) contentParts.push({ type: 'text', text: 'CV Document Content:\n\n' + text.substring(0, 10000) });
    } catch (e) {
      return null; // Can't process this format
    }
  }

  var namesStr = altSupervisorNames.map(function (n, i) { return (i + 1) + '. ' + n; }).join('\n');

  contentParts.push({
    type: 'text',
    text: 'You are verifying a document a medical practice sent us. I need three things:\n'
      + '1. is_cv: Is this document an INDIVIDUAL PERSON\'S CV / resume / curriculum vitae?\n'
      + '   Answer false if it is any OTHER kind of document, e.g. an SPPA-00 supervised practice\n'
      + '   plan form, an employment offer/contract, a position description, a reference letter, a\n'
      + '   certificate, or a cover email. Those documents often NAME a supervisor but are NOT that\n'
      + '   person\'s CV, so they must return is_cv=false.\n'
      + '2. cv_name: If it IS a CV, the FULL NAME of the person it belongs to (else "").\n'
      + '3. matched_supervisor: Whether that person matches one of these alternate supervisors from\n'
      + '   an SPPA-00 form:\n'
      + namesStr + '\n\n'
      + 'Return JSON only: {"is_cv": true/false, "cv_name": "Full Name", "matched_supervisor": "matching name or null", "confidence": 0.0-1.0}\n'
      + 'Use fuzzy matching for the name (allow middle name differences, titles like Dr/Prof). confidence reflects how sure you are of the name match. If is_cv is false, set matched_supervisor to null.'
  });

  try {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 25000);
    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: controller.signal,
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-6', max_tokens: 200, temperature: 0,
        messages: [{ role: 'user', content: contentParts }]
      })
    });
    clearTimeout(timeout);
    var data = await res.json();

    // Track spend
    if (typeof global.recordAnthropicSpend === 'function' && data.usage) {
      global.recordAnthropicSpend(
        data.usage.input_tokens || 0, data.usage.output_tokens || 0,
        data.usage.cache_read_input_tokens || 0, data.usage.cache_creation_input_tokens || 0
      );
    }

    var text = data.content && data.content[0] ? data.content[0].text : '';
    var jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    var result = JSON.parse(jsonMatch[0]);
    // is_cv gate: a document that merely NAMES the supervisor (SPPA-00 form, contract,
    // position description, all present in the same practice thread) must NOT be
    // delivered as that supervisor's CV. interpretAltCvMatch enforces is_cv && match.
    return interpretAltCvMatch(result);
  } catch (err) {
    console.error('[AltCV Match] AI error:', err.message);
    return null;
  }
}

// Simple docx text extraction (ZIP → XML → strip tags)
function extractTextFromDocx(buffer) {
  try {
    var JSZip = require('jszip');
    // Synchronous approach won't work with JSZip, fall back to xmldom
    var AdmZip = require('adm-zip') || null;
  } catch (e) {}

  // Use the same approach as sppa-conflict-scan.js
  try {
    var zlib = require('zlib');
    var entries = [];
    var offset = 0;
    var buf = buffer;

    // Simple ZIP parser for document.xml
    while (offset < buf.length - 4) {
      if (buf.readUInt32LE(offset) === 0x04034b50) {
        var fnLen = buf.readUInt16LE(offset + 26);
        var extraLen = buf.readUInt16LE(offset + 28);
        var compSize = buf.readUInt32LE(offset + 18);
        var compMethod = buf.readUInt16LE(offset + 8);
        var fn = buf.toString('utf8', offset + 30, offset + 30 + fnLen);
        var dataStart = offset + 30 + fnLen + extraLen;
        if (fn === 'word/document.xml') {
          var rawData = buf.slice(dataStart, dataStart + compSize);
          var xmlContent = compMethod === 8 ? zlib.inflateRawSync(rawData).toString('utf8') : rawData.toString('utf8');
          return xmlContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
        offset = dataStart + compSize;
      } else {
        offset++;
      }
    }
  } catch (e) {
    console.error('[AltCV Match] docx extraction error:', e.message);
  }
  return null;
}

module.exports = { matchCvToAltSupervisor };

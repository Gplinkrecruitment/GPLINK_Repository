'use strict';
// Advisory check: does the doctor's uploaded document satisfy what AHPRA asked for on ONE s80 item?
// Pure helpers only (no I/O) so they can be unit-tested; server.js does the vision call.

var UPLOAD_CHECK_SYSTEM = [
  'You do a LIGHT sanity check on a document a doctor uploaded for an AHPRA request. You are advisory only —',
  'a human makes the final call. Be LENIENT: AHPRA officers work from copy-pasted checklists and rarely enforce',
  'every sub-point, so only raise a concern for a clear, obvious problem (the wrong document, or a signature/date/',
  'certification the officer EXPLICITLY required plainly missing, or a blank/illegible file). Do NOT nitpick optional',
  'checklist details and do NOT hunt for inconsistencies. When in doubt, treat it as fine.',
  'Return strict JSON only — no prose, no markdown fences.'
].join(' ');

function clean(v, max) {
  var s = (v === null || v === undefined) ? '' : String(v);
  // Strip NUL bytes (they can corrupt the generated HTML this summary is embedded into) but keep
  // ordinary whitespace so the prompt stays readable. String.fromCharCode(0) avoids a literal NUL.
  s = s.split(String.fromCharCode(0)).join('').trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

function buildUploadCheckPrompt(requirement) {
  requirement = requirement || {};
  var subs = Array.isArray(requirement.sub_items) ? requirement.sub_items : [];
  var subLines = subs.map(function (s) { return '  - ' + clean((s && s.label) || s, 300); }).filter(function (l) { return l.trim() !== '-'; });
  return [
    'AHPRA asked for this item:',
    'Title: ' + clean(requirement.title, 300),
    'Requirement (officer\'s words): ' + clean(requirement.detail, 4000),
    (requirement.team_instructions ? 'In plain terms: ' + clean(requirement.team_instructions, 1000) : ''),
    (subLines.length ? 'Required attachments:\n' + subLines.join('\n') : ''),
    '',
    'The attached file is the document the doctor uploaded for this item. Give it a LENIENT sanity check —',
    'an AHPRA officer will not scrutinise every line, so neither should you. Only two things matter:',
    '- Is this broadly the RIGHT type of document for the request (e.g. a CV when a CV was asked for)?',
    '- Is any HARD condition the officer EXPLICITLY stated clearly met — signed, dated, certified copy, correct',
    '  issuing body? If the officer did not explicitly demand it, do not require it.',
    'The bullet points above are the officer\'s own checklist wording — treat them as a guide, NOT a pass/fail list.',
    'Do NOT flag missing optional details (e.g. facility address/contact details, full-time/part-time hours, an',
    'explanation of gaps in practice, exact formatting, one role listed vs many), and do NOT infer problems or chase',
    'internal inconsistencies (e.g. dates vs claimed years of experience). Those are fine.',
    '',
    'Return strict JSON ONLY: {"verdict":"match|possible_issue|unclear","summary":"one short sentence for the reviewer"}',
    '- "match" = it is the right kind of document and any explicitly-required signature/date/certification is present.',
    '  This is the DEFAULT — use it unless there is a clear, obvious problem.',
    '- "possible_issue" = a clear problem ONLY: it is the WRONG document, or a signature/date/certification the officer',
    '  EXPLICITLY required is plainly missing. Say which in the summary. Do NOT use this for missing optional details.',
    '- "unclear" = the file is blank, unreadable, or you genuinely cannot tell what it is.'
  ].filter(Boolean).join('\n');
}

function parseUploadCheck(text) {
  var out = { verdict: 'unclear', summary: '' };
  var m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return out;
  var parsed;
  try { parsed = JSON.parse(m[0]); } catch (e) { return out; }
  var v = clean(parsed && parsed.verdict, 40).toLowerCase().replace(/[\s-]+/g, '_');
  if (v === 'match' || v === 'possible_issue' || v === 'unclear') out.verdict = v;
  out.summary = clean(parsed && parsed.summary, 400);
  return out;
}

module.exports = { UPLOAD_CHECK_SYSTEM: UPLOAD_CHECK_SYSTEM, buildUploadCheckPrompt: buildUploadCheckPrompt, parseUploadCheck: parseUploadCheck };

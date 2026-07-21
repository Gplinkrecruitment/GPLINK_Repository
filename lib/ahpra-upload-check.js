'use strict';
// Advisory check: does the doctor's uploaded document satisfy what AHPRA asked for on ONE s80 item?
// Pure helpers only (no I/O) so they can be unit-tested; server.js does the vision call.

var UPLOAD_CHECK_SYSTEM = [
  'You verify whether a document a doctor uploaded satisfies a specific requirement an AHPRA officer asked for.',
  'You are advisory only, a human makes the final call. Be concise and practical.',
  'Return strict JSON only, no prose, no markdown fences.'
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
    'The attached file is the document the doctor uploaded for this item. Judge:',
    '- Is this the RIGHT type of document for the requirement?',
    '- Does it satisfy the requirement, including any explicit condition the officer stated',
    '  (e.g. signed, dated, certified copy, correct issuing body, within a date window)?',
    '',
    'Return strict JSON ONLY: {"verdict":"match|possible_issue|unclear","summary":"one short sentence for the reviewer"}',
    '- "match" = clearly the right document and satisfies the requirement.',
    '- "possible_issue" = wrong document, or a stated condition looks unmet (say which in summary).',
    '- "unclear" = you cannot tell from the file.'
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
